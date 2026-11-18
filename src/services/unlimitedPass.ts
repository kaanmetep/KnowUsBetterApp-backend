import { SupabaseClient } from "@supabase/supabase-js";

/**
 * The weekly "Unlimited" subscription. Its store products are named
 * `unlimited_*` (unlimited_weekly today) and grant the RevenueCat entitlement
 * `unlimited`. A room where any player has an active pass starts paid
 * categories without spending coins ("one of you buys, you both play").
 */
export const UNLIMITED_ENTITLEMENT = "unlimited";

export const isUnlimitedProduct = (productId: unknown): boolean =>
  typeof productId === "string" && productId.startsWith("unlimited_");

/**
 * A renewal's webhook can land a little after the old period ends; a pass
 * stays usable for this long past its expiry so nobody is charged in between.
 */
const RENEWAL_GRACE_MS = 60 * 60 * 1000;

/** Event types that change a pass; the rest (TEST, SUBSCRIBER_ALIAS, ...) are ignored. */
const PASS_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "CANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
  "SUBSCRIPTION_EXTENDED",
  "TEMPORARY_ENTITLEMENT_GRANT",
]);

export interface PassRow {
  app_user_id: string;
  product_id: string;
  expires_at: string;
  will_renew: boolean;
  last_event_at: string | null;
}

export interface PassStatus {
  active: boolean;
  expiresAt: string | null;
  willRenew: boolean;
}

const isActive = (expiresAt: string | null | undefined, now = Date.now()) =>
  !!expiresAt && Date.parse(expiresAt) + RENEWAL_GRACE_MS > now;

// RevenueCat ids for anonymous users aren't ours to look up.
const isOwnId = (id: unknown): id is string =>
  typeof id === "string" && id !== "" && !id.startsWith("$RCAnonymousID:");

async function readPass(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
): Promise<PassRow | null> {
  const { data, error } = await supabaseAdmin
    .from("unlimited_passes")
    .select("app_user_id, product_id, expires_at, will_renew, last_event_at")
    .eq("app_user_id", appUserId)
    .maybeSingle<PassRow>();
  if (error) {
    // 42P01 / PGRST205: migrations/20261117_unlimited_passes.sql isn't applied yet.
    if (error.code !== "42P01" && error.code !== "PGRST205") {
      console.error("❌ Error reading unlimited pass:", error);
    }
    return null;
  }
  return data ?? null;
}

async function writePass(
  supabaseAdmin: SupabaseClient,
  row: PassRow,
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("unlimited_passes")
    .upsert({ ...row, updated_at: new Date().toISOString() });
  if (error) {
    console.error("❌ Error writing unlimited pass:", error);
    return false;
  }
  return true;
}

/**
 * Asks RevenueCat directly, for the minutes between a purchase and its
 * webhook. Needs REVENUECAT_SECRET_API_KEY (a v1 secret key); without it only
 * webhooks count.
 */
async function fetchFromRevenueCat(appUserId: string): Promise<PassRow | null> {
  const key = process.env.REVENUECAT_SECRET_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) {
      console.warn(`⚠️ RevenueCat lookup for ${appUserId} failed: ${response.status}`);
      return null;
    }
    const body: any = await response.json();
    const entitlement = body?.subscriber?.entitlements?.[UNLIMITED_ENTITLEMENT];
    if (!entitlement?.expires_date) return null;
    const productId: string = entitlement.product_identifier ?? "unlimited_weekly";
    const subscription = body?.subscriber?.subscriptions?.[productId];
    return {
      app_user_id: appUserId,
      product_id: productId,
      expires_at: new Date(entitlement.expires_date).toISOString(),
      will_renew: !subscription?.unsubscribe_detected_at,
      last_event_at: null,
    };
  } catch (error) {
    console.warn(`⚠️ RevenueCat lookup for ${appUserId} failed:`, error);
    return null;
  }
}

// Users RevenueCat just said have no pass, so a room full of free players
// doesn't ask it again on every check.
const recentMisses = new Map<string, number>();
const MISS_TTL_MS = 60 * 1000;

/**
 * Whether the user has a running pass. `verify` also asks RevenueCat when the
 * table has nothing current (right after a purchase, before its webhook).
 */
export async function getPassStatus(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
  { verify = false }: { verify?: boolean } = {},
): Promise<PassStatus> {
  const stored = await readPass(supabaseAdmin, appUserId);
  if (stored && isActive(stored.expires_at)) {
    return { active: true, expiresAt: stored.expires_at, willRenew: stored.will_renew };
  }
  const missedAt = recentMisses.get(appUserId);
  if (verify && !(missedAt && Date.now() - missedAt < MISS_TTL_MS)) {
    const fetched = await fetchFromRevenueCat(appUserId);
    if (fetched && isActive(fetched.expires_at)) {
      recentMisses.delete(appUserId);
      // Kept for the next check; a webhook with a timestamp still wins over it.
      await writePass(supabaseAdmin, {
        ...fetched,
        last_event_at: stored?.last_event_at ?? null,
      });
      return { active: true, expiresAt: fetched.expires_at, willRenew: fetched.will_renew };
    }
    recentMisses.set(appUserId, Date.now());
  }
  return {
    active: false,
    expiresAt: stored?.expires_at ?? null,
    willRenew: stored?.will_renew ?? false,
  };
}

/** Whether any of these users has a running pass (the room plays for free). */
export async function anyActivePass(
  supabaseAdmin: SupabaseClient,
  appUserIds: string[],
): Promise<string | null> {
  for (const id of appUserIds) {
    if ((await getPassStatus(supabaseAdmin, id, { verify: true })).active) return id;
  }
  return null;
}

export type PassEventResult =
  | { status: "updated"; appUserId: string; active: boolean }
  | { status: "ignored" | "stale" }
  | { status: "error" };

/** Applies one RevenueCat webhook event for an `unlimited_*` product. */
export async function applyPassEvent(
  supabaseAdmin: SupabaseClient,
  event: any,
): Promise<PassEventResult> {
  const appUserId = event?.app_user_id;
  if (!PASS_EVENTS.has(event?.type) || !isOwnId(appUserId)) {
    return { status: "ignored" };
  }
  const expirationMs = Number(event.expiration_at_ms);
  if (!Number.isFinite(expirationMs) || expirationMs <= 0) {
    return { status: "ignored" };
  }
  const eventAt = Number(event.event_timestamp_ms);
  const eventIso = Number.isFinite(eventAt) && eventAt > 0
    ? new Date(eventAt).toISOString()
    : null;

  const stored = await readPass(supabaseAdmin, appUserId);
  if (
    stored?.last_event_at &&
    eventIso &&
    Date.parse(stored.last_event_at) > Date.parse(eventIso)
  ) {
    return { status: "stale" };
  }

  const willRenew =
    event.type === "CANCELLATION" || event.type === "EXPIRATION"
      ? false
      : event.type === "BILLING_ISSUE"
        ? (stored?.will_renew ?? true)
        : true;
  const row: PassRow = {
    app_user_id: appUserId,
    product_id: typeof event.product_id === "string" ? event.product_id : "unlimited_weekly",
    expires_at: new Date(expirationMs).toISOString(),
    will_renew: willRenew,
    last_event_at: eventIso,
  };
  if (!(await writePass(supabaseAdmin, row))) return { status: "error" };
  recentMisses.delete(appUserId);
  return { status: "updated", appUserId, active: isActive(row.expires_at) };
}

/**
 * TRANSFER: the Apple account's purchases moved to another appUserId (a
 * reinstall or a second device); its pass moves with them.
 */
export async function transferPass(
  supabaseAdmin: SupabaseClient,
  from: string[],
  to: string,
): Promise<boolean> {
  const sources = from.filter((id) => isOwnId(id) && id !== to);
  if (sources.length === 0 || !isOwnId(to)) return false;
  const { data, error } = await supabaseAdmin
    .from("unlimited_passes")
    .select("app_user_id, product_id, expires_at, will_renew, last_event_at")
    .in("app_user_id", [...sources, to]);
  if (error) {
    if (error.code !== "42P01" && error.code !== "PGRST205") {
      console.error("❌ Error reading passes to transfer:", error);
    }
    return false;
  }
  const rows = (data ?? []) as PassRow[];
  const best = rows.reduce<PassRow | null>(
    (latest, row) =>
      !latest || Date.parse(row.expires_at) > Date.parse(latest.expires_at) ? row : latest,
    null,
  );
  if (!best || !rows.some((row) => row.app_user_id !== to)) return false;
  if (!(await writePass(supabaseAdmin, { ...best, app_user_id: to }))) return false;
  const { error: deleteError } = await supabaseAdmin
    .from("unlimited_passes")
    .delete()
    .in("app_user_id", sources);
  if (deleteError) console.warn("⚠️ Failed to clear transferred passes:", deleteError);
  recentMisses.delete(to);
  return true;
}
