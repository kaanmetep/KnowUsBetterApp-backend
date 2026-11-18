import express, { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { webhookRateLimiter } from "../middleware/rateLimiter.js";
import {
  keepRawBody,
  verifyRevenueCatRequest,
} from "../middleware/revenueCat.js";
import { creditCoins } from "../services/coinLedger.js";
import { PUBLIC_RUNTIME_CONFIG } from "../services/publicConfigService.js";
import { getCoinsFromProductId } from "../utils/helpers.js";
import {
  applyPassEvent,
  isUnlimitedProduct,
  transferPass,
} from "../services/unlimitedPass.js";

const PURCHASE_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "NON_RENEWING_PURCHASE",
]);

type EventClaim = "claimed" | "duplicate" | "untracked" | "error";

/**
 * RevenueCat may deliver an event more than once (same `event.id`); the row
 * in revenuecat_events makes sure its coins are credited only once.
 */
async function claimEvent(
  supabaseAdmin: SupabaseClient,
  event: any,
  coins: number,
): Promise<EventClaim> {
  if (typeof event.id !== "string" || !event.id) {
    console.warn("⚠️ RevenueCat event without id; can't guard against duplicates");
    return "untracked";
  }
  const { error } = await supabaseAdmin.from("revenuecat_events").insert({
    event_id: event.id,
    event_type: event.type,
    app_user_id: event.app_user_id,
    product_id: event.product_id ?? null,
    coins,
  });
  if (!error) return "claimed";
  if (error.code === "23505") return "duplicate";
  // 42P01: migrations/20261008_revenuecat_events.sql hasn't been applied yet.
  if (error.code === "42P01" || error.code === "PGRST205") {
    console.warn("⚠️ revenuecat_events table missing; duplicates aren't detected");
    return "untracked";
  }
  console.error("❌ Failed to record RevenueCat event:", error);
  return "error";
}

async function releaseEvent(
  supabaseAdmin: SupabaseClient,
  eventId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("revenuecat_events")
    .delete()
    .eq("event_id", eventId);
  if (error) {
    console.error(`❌ Failed to release RevenueCat event ${eventId}:`, error);
  }
}

const appUserIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (id): id is string =>
          typeof id === "string" && id !== "" && !id.startsWith("$RCAnonymousID:"),
      )
    : [];

type TransferResult =
  | { status: "moved"; target: string; newBalance: number; drained: string[] }
  | { status: "duplicate" | "nothing_to_move" | "skipped" }
  | { status: "error" };

/**
 * TRANSFER: the Apple account's purchases now belong to another appUserId
 * (a reinstall that lost its id, or a second device), so the coins still on
 * the old ids follow them.
 */
async function mergeTransferredWallets(
  supabaseAdmin: SupabaseClient,
  event: any,
): Promise<TransferResult> {
  const from = appUserIds(event.transferred_from);
  const to = appUserIds(event.transferred_to);
  const target =
    typeof event.app_user_id === "string" && to.includes(event.app_user_id)
      ? event.app_user_id
      : to.length === 1
        ? to[0]
        : null;
  if (typeof event.id !== "string" || !event.id || !target || from.length === 0) {
    console.warn("⚠️ TRANSFER without a usable id, source or target:", {
      id: event.id,
      transferredFrom: event.transferred_from,
      transferredTo: event.transferred_to,
    });
    return { status: "skipped" };
  }

  const { data, error } = await supabaseAdmin
    .rpc("merge_transferred_wallets", {
      p_event_id: event.id,
      p_from: from,
      p_to: target,
    })
    .single<{
      status: string;
      moved: number;
      new_balance: number | null;
      drained: string[] | null;
    }>();
  if (error || !data) {
    // PGRST202: migrations/20261112_wallet_transfer.sql hasn't been applied yet.
    console.error("❌ Failed to merge transferred wallets:", error);
    return { status: "error" };
  }

  console.log(
    `🔀 TRANSFER ${event.id}: ${from.join(", ")} → ${target}: ${data.status}` +
      (data.status === "moved" ? `, ${data.moved} coins, new balance ${data.new_balance}` : ""),
  );
  if (data.status === "moved" && data.new_balance !== null) {
    return {
      status: "moved",
      target,
      newBalance: data.new_balance,
      drained: data.drained ?? [],
    };
  }
  return { status: data.status === "duplicate" ? "duplicate" : "nothing_to_move" };
}

/** Mounted before the global JSON parser so the raw body is still available. */
export function createRevenueCatWebhookRouter({
  supabaseAdmin,
  onCoinsAdded,
  onBalanceChanged,
  onPassChanged,
}: {
  supabaseAdmin: SupabaseClient | null;
  onCoinsAdded: (appUserId: string, newBalance: number) => void;
  /** A balance the webhook lowered. */
  onBalanceChanged: (appUserId: string, newBalance: number) => void;
  /** An Unlimited pass started, renewed, moved or ended for this user. */
  onPassChanged: (appUserId: string) => void;
}): Router {
  const router = Router();

  router.post(
    "/",
    webhookRateLimiter,
    express.json({ verify: keepRawBody }),
    verifyRevenueCatRequest,
    async (req: Request, res: Response) => {
      // Set while this request holds the event but hasn't credited it yet.
      let heldEventId: string | null = null;
      // Released before answering, so RevenueCat's retry can claim the event again.
      const fail = async (status: number, error: string) => {
        if (heldEventId && supabaseAdmin) await releaseEvent(supabaseAdmin, heldEventId);
        return res.status(status).json({ error });
      };
      try {
        const event = req.body?.event;
        console.log("📦 RevenueCat webhook received:", event?.type);

        if (!event || typeof event !== "object") {
          return res.status(400).json({ error: "Missing event" });
        }
        if (!supabaseAdmin) {
          console.error("❌ Supabase not configured");
          return res.status(500).json({ error: "Supabase not configured" });
        }

        if (event.type === "TRANSFER") {
          const passTarget =
            typeof event.app_user_id === "string" &&
            appUserIds(event.transferred_to).includes(event.app_user_id)
              ? event.app_user_id
              : appUserIds(event.transferred_to)[0];
          if (
            passTarget &&
            (await transferPass(
              supabaseAdmin,
              appUserIds(event.transferred_from),
              passTarget,
            ))
          ) {
            onPassChanged(passTarget);
          }
          const result = await mergeTransferredWallets(supabaseAdmin, event);
          if (result.status === "error") {
            // A 5xx makes RevenueCat retry the webhook later.
            return res.status(500).json({ error: "Failed to merge wallets" });
          }
          if (result.status === "moved") {
            onCoinsAdded(result.target, result.newBalance);
            // An old id's app may still be open (a second device): show it the 0.
            for (const id of result.drained) onBalanceChanged(id, 0);
          }
          return res.status(200).json({ success: true });
        }

        // The weekly Unlimited subscription: no coins, just how long it runs.
        if (isUnlimitedProduct(event.product_id)) {
          const result = await applyPassEvent(supabaseAdmin, event);
          if (result.status === "error") {
            return res.status(500).json({ error: "Failed to record pass" });
          }
          if (result.status === "updated") {
            console.log(
              `♾️ Unlimited ${event.type} for ${result.appUserId}: ${result.active ? "active" : "inactive"}`,
            );
            onPassChanged(result.appUserId);
          }
          return res.status(200).json({ success: true, pass: result.status });
        }

        if (!PURCHASE_EVENTS.has(event.type)) {
          console.log(`ℹ️ Unhandled event type: ${event.type}`);
          return res.status(200).json({ success: true });
        }

        const appUserId = event.app_user_id;
        const productId = event.product_id;
        const coins =
          typeof productId === "string"
            ? getCoinsFromProductId(
                productId,
                PUBLIC_RUNTIME_CONFIG.economy.coinPackages,
              )
            : 0;

        if (!appUserId || !coins) {
          console.warn("⚠️ Invalid webhook data:", { appUserId, productId, coins });
          return res.status(400).json({ error: "Invalid webhook data" });
        }

        const claim = await claimEvent(supabaseAdmin, event, coins);
        if (claim === "duplicate") {
          console.log(`ℹ️ RevenueCat event ${event.id} already processed`);
          return res.status(200).json({ success: true, duplicate: true });
        }
        if (claim === "error") {
          // A 5xx makes RevenueCat retry the webhook later.
          return res.status(500).json({ error: "Failed to record event" });
        }

        if (claim === "claimed") heldEventId = event.id;

        console.log(`💰 Processing purchase: ${coins} coins for user ${appUserId}`);
        const credit = await creditCoins(supabaseAdmin, appUserId, coins, "purchase");
        if (!credit.ok) return fail(500, "Failed to update coins");
        heldEventId = null;

        console.log(`✅ Coins added successfully. New balance: ${credit.newBalance}`);
        onCoinsAdded(appUserId, credit.newBalance);
        return res.status(200).json({ success: true });
      } catch (error) {
        console.error("❌ Webhook error:", error);
        return fail(500, "Webhook processing failed");
      }
    },
  );

  return router;
}
