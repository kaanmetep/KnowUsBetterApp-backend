import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";

/**
 * appUserIds are made up by the app, so knowing one used to be enough to spend
 * its coins. The first app to claim an id gets a secret token for it; from then
 * on that id only works together with the token.
 */

export const APP_USER_TOKEN_HEADER = "x-app-user-token";

const TABLE = "app_user_credentials";
const MAX_ID_LENGTH = 200;
// A claim whose token was never used can be issued again for a while, so a
// lost claim response doesn't lock the player out of their own wallet.
const RECLAIM_WINDOW_MS = 10 * 60 * 1000;
const CLAIMED_CACHE_MS = 60_000;
// Short, so other instances notice a fresh claim quickly.
const UNCLAIMED_CACHE_MS = 5_000;

/** Old builds never claim their id; turned off once those builds are gone. */
export const allowLegacyClients = (): boolean =>
  process.env.ALLOW_LEGACY_COIN_CLIENTS !== "false";

export const isValidAppUserId = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_ID_LENGTH;

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";

type Credential = { tokenHash: string; confirmed: boolean };
type Lookup = Credential | "unclaimed" | "error";

const cache = new Map<string, { value: Credential | "unclaimed"; expires: number }>();

function remember(appUserId: string, value: Credential | "unclaimed"): void {
  const ttl = value === "unclaimed" ? UNCLAIMED_CACHE_MS : CLAIMED_CACHE_MS;
  cache.set(appUserId, { value, expires: Date.now() + ttl });
  if (cache.size > 10_000) {
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  }
}

async function lookup(supabaseAdmin: SupabaseClient, appUserId: string): Promise<Lookup> {
  const cached = cache.get(appUserId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("token_hash, confirmed_at")
    .eq("app_user_id", appUserId)
    .maybeSingle();
  if (error) {
    // Before the migration nobody can have claimed an id.
    if (isMissingTable(error.code)) return "unclaimed";
    console.error("❌ Error reading app user credential:", error);
    return "error";
  }
  const value: Credential | "unclaimed" = data
    ? { tokenHash: data.token_hash, confirmed: !!data.confirmed_at }
    : "unclaimed";
  remember(appUserId, value);
  return value;
}

export type AppUserCheck = "verified" | "unclaimed" | "invalid" | "error";

export async function checkAppUser(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
  token: unknown,
): Promise<AppUserCheck> {
  const credential = await lookup(supabaseAdmin, appUserId);
  if (credential === "error" || credential === "unclaimed") return credential;
  if (typeof token !== "string" || !token) return "invalid";

  const given = Buffer.from(hashToken(token));
  const stored = Buffer.from(credential.tokenHash);
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    return "invalid";
  }

  if (!credential.confirmed) {
    const { error } = await supabaseAdmin
      .from(TABLE)
      .update({ confirmed_at: new Date().toISOString() })
      .eq("app_user_id", appUserId)
      .eq("token_hash", credential.tokenHash)
      .is("confirmed_at", null);
    if (error) console.warn("⚠️ Failed to confirm app user credential:", error);
    else remember(appUserId, { ...credential, confirmed: true });
  }
  return "verified";
}

const isAllowed = (check: AppUserCheck) =>
  check === "verified" || (check === "unclaimed" && allowLegacyClients());

/** Whether a request for `appUserId` carrying `token` may use its wallet. */
export async function authorizeAppUser(
  supabaseAdmin: SupabaseClient | null,
  appUserId: string,
  token: unknown,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  return isAllowed(await checkAppUser(supabaseAdmin, appUserId, token));
}

export type ClaimResult =
  | { ok: true; token: string }
  | { ok: false; reason: "claimed" | "unavailable" | "error" };

export async function claimAppUser(
  supabaseAdmin: SupabaseClient,
  appUserId: string,
): Promise<ClaimResult> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);

  const { error } = await supabaseAdmin
    .from(TABLE)
    .insert({ app_user_id: appUserId, token_hash: tokenHash });
  if (!error) {
    remember(appUserId, { tokenHash, confirmed: false });
    return { ok: true, token };
  }
  if (isMissingTable(error.code)) return { ok: false, reason: "unavailable" };
  if (error.code !== "23505") {
    console.error("❌ Error claiming app user id:", error);
    return { ok: false, reason: "error" };
  }

  const { data: existing, error: readError } = await supabaseAdmin
    .from(TABLE)
    .select("token_hash, created_at, confirmed_at")
    .eq("app_user_id", appUserId)
    .maybeSingle();
  if (readError || !existing) return { ok: false, reason: "error" };

  const reissuable =
    !existing.confirmed_at &&
    Date.now() - new Date(existing.created_at).getTime() < RECLAIM_WINDOW_MS;
  if (!reissuable) return { ok: false, reason: "claimed" };

  const { data: replaced, error: updateError } = await supabaseAdmin
    .from(TABLE)
    .update({ token_hash: tokenHash })
    .eq("app_user_id", appUserId)
    .eq("token_hash", existing.token_hash)
    .is("confirmed_at", null)
    .select("app_user_id");
  if (updateError) {
    console.error("❌ Error re-issuing app user token:", updateError);
    return { ok: false, reason: "error" };
  }
  if (!replaced?.length) return { ok: false, reason: "claimed" };
  remember(appUserId, { tokenHash, confirmed: false });
  return { ok: true, token };
}

/** Rejects HTTP requests for an appUserId that come without its token. */
export function requireAppUser(
  supabaseAdmin: SupabaseClient | null,
  getAppUserId: (req: Request) => unknown,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const appUserId = getAppUserId(req);
    // Malformed ids are left to the route's own validation.
    if (!isValidAppUserId(appUserId) || !supabaseAdmin) return next();
    try {
      const check = await checkAppUser(
        supabaseAdmin,
        appUserId,
        req.get(APP_USER_TOKEN_HEADER),
      );
      if (isAllowed(check)) return next();
      if (check === "error") {
        res.status(503).json({ error: "Please try again in a moment." });
        return;
      }
      res.status(401).json({
        error: "This device isn't signed in to that wallet.",
        code: "APP_USER_UNAUTHORIZED",
      });
    } catch (error) {
      next(error);
    }
  };
}
