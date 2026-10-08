import { SupabaseClient } from "@supabase/supabase-js";

export type CoinTransactionType =
  | "game_start"
  | "ai_analysis"
  | "refund"
  | "purchase"
  | "daily_reward"
  | "admin";

export type SpendResult =
  | { ok: true; newBalance: number }
  | { ok: false; reason: "insufficient"; balance: number }
  | { ok: false; reason: "error" };

export type CreditResult =
  | { ok: true; newBalance: number }
  | { ok: false; reason: "error" };

// A compare-and-set write loses to a concurrent writer; a few retries are
// enough for one user's balance.
const MAX_ATTEMPTS = 5;

async function readBalance(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
): Promise<{ exists: boolean; balance: number } | null> {
  const { data, error } = await supabaseAdmin
    .from("coins")
    .select("balance")
    .eq("app_user_id", appUserId)
    .maybeSingle();
  if (error) {
    console.error("❌ Error reading coin balance:", error);
    return null;
  }
  return { exists: !!data, balance: data?.balance ?? 0 };
}

async function logTransaction(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
  amount: number,
  type: CoinTransactionType,
): Promise<void> {
  const { error } = await supabaseAdmin.from("coin_transactions").insert({
    app_user_id: appUserId,
    amount,
    transaction_type: type,
  });
  if (error) console.warn("⚠️ Failed to log coin transaction:", error);
}

/** Writes `next` only if the stored balance is still `expected`. */
async function compareAndSet(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
  expected: number,
  next: number,
): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin
    .from("coins")
    .update({ balance: next })
    .eq("app_user_id", appUserId)
    .eq("balance", expected)
    .select("balance");
  if (error) {
    console.error("❌ Error updating coin balance:", error);
    return null;
  }
  return (data?.length ?? 0) > 0;
}

export async function getBalance(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
): Promise<number | null> {
  const row = await readBalance(supabaseAdmin, appUserId);
  return row ? row.balance : null;
}

export async function spendCoins(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
  amount: number,
  type: CoinTransactionType,
): Promise<SpendResult> {
  if (!appUserId || !Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: "error" };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await readBalance(supabaseAdmin, appUserId);
    if (!row) return { ok: false, reason: "error" };
    if (row.balance < amount) {
      return { ok: false, reason: "insufficient", balance: row.balance };
    }

    const written = await compareAndSet(
      supabaseAdmin,
      appUserId,
      row.balance,
      row.balance - amount,
    );
    if (written === null) return { ok: false, reason: "error" };
    if (written) {
      await logTransaction(supabaseAdmin, appUserId, amount, type);
      return { ok: true, newBalance: row.balance - amount };
    }
  }

  console.error(`❌ Coin spend for ${appUserId} kept conflicting, giving up`);
  return { ok: false, reason: "error" };
}

export async function creditCoins(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
  amount: number,
  type: CoinTransactionType,
): Promise<CreditResult> {
  if (!appUserId || !Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: "error" };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await readBalance(supabaseAdmin, appUserId);
    if (!row) return { ok: false, reason: "error" };

    if (!row.exists) {
      const { error } = await supabaseAdmin
        .from("coins")
        .insert({ app_user_id: appUserId, balance: amount });
      if (!error) {
        await logTransaction(supabaseAdmin, appUserId, amount, type);
        return { ok: true, newBalance: amount };
      }
      // 23505: another request created the row first; retry as an update.
      if (error.code !== "23505") {
        console.error("❌ Error creating coin row:", error);
        return { ok: false, reason: "error" };
      }
      continue;
    }

    const written = await compareAndSet(
      supabaseAdmin,
      appUserId,
      row.balance,
      row.balance + amount,
    );
    if (written === null) return { ok: false, reason: "error" };
    if (written) {
      await logTransaction(supabaseAdmin, appUserId, amount, type);
      return { ok: true, newBalance: row.balance + amount };
    }
  }

  console.error(`❌ Coin credit for ${appUserId} kept conflicting, giving up`);
  return { ok: false, reason: "error" };
}

export type DailyRewardResult =
  | { ok: true; newBalance: number; nextClaimAt: string }
  | { ok: false; reason: "not_eligible_yet"; nextClaimAt: string }
  | { ok: false; reason: "error" };

/** Moves last_daily_reward_at from `expected` to `next`; false if someone else moved it first. */
async function swapClaimTime(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
  expected: string | null,
  next: string | null,
): Promise<boolean | null> {
  let query = supabaseAdmin
    .from("coins")
    .update({ last_daily_reward_at: next })
    .eq("app_user_id", appUserId);
  query =
    expected === null
      ? query.is("last_daily_reward_at", null)
      : query.eq("last_daily_reward_at", expected);
  const { data, error } = await query.select("app_user_id");
  if (error) {
    console.error("❌ Error updating daily reward time:", error);
    return null;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * The claim time is taken first with a compare-and-set, so concurrent claims
 * can't both pass; the coins then go through creditCoins, so the balance is
 * never overwritten with a stale value.
 */
export async function claimDailyReward(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
  { amount, intervalMs, unlimited = false }: {
    amount: number;
    intervalMs: number;
    unlimited?: boolean;
  },
): Promise<DailyRewardResult> {
  if (!appUserId || !Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: "error" };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data, error } = await supabaseAdmin
      .from("coins")
      .select("last_daily_reward_at")
      .eq("app_user_id", appUserId)
      .maybeSingle();
    if (error) {
      console.error("❌ Error reading daily reward state:", error);
      return { ok: false, reason: "error" };
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const nextClaimAt = new Date(now + intervalMs).toISOString();

    if (!data) {
      // First coins ever: the row is created with the reward in it.
      const { error: insertError } = await supabaseAdmin.from("coins").insert({
        app_user_id: appUserId,
        balance: amount,
        last_daily_reward_at: nowIso,
      });
      if (!insertError) {
        await logTransaction(supabaseAdmin, appUserId, amount, "daily_reward");
        return { ok: true, newBalance: amount, nextClaimAt };
      }
      if (insertError.code !== "23505") {
        console.error("❌ Error creating coin row:", insertError);
        return { ok: false, reason: "error" };
      }
      continue;
    }

    const previous: string | null = data.last_daily_reward_at ?? null;
    if (previous && !unlimited) {
      const lastClaim = new Date(previous).getTime();
      if (now - lastClaim < intervalMs) {
        return {
          ok: false,
          reason: "not_eligible_yet",
          nextClaimAt: new Date(lastClaim + intervalMs).toISOString(),
        };
      }
    }

    const claimed = await swapClaimTime(supabaseAdmin, appUserId, previous, nowIso);
    if (claimed === null) return { ok: false, reason: "error" };
    if (!claimed) continue;

    const credit = await creditCoins(supabaseAdmin, appUserId, amount, "daily_reward");
    if (credit.ok) {
      return { ok: true, newBalance: credit.newBalance, nextClaimAt };
    }
    // Give the claim back so the player can try again.
    await swapClaimTime(supabaseAdmin, appUserId, nowIso, previous);
    return { ok: false, reason: "error" };
  }

  console.error(`❌ Daily reward for ${appUserId} kept conflicting, giving up`);
  return { ok: false, reason: "error" };
}
