import { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "banned_users";
const CACHE_MS = 60_000;

const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";

const cache = new Map<string, { banned: boolean; expires: number }>();

/**
 * Whether an appUserId was banned for objectionable content. Fails open: if
 * the lookup errors the player is let through rather than locked out.
 */
export async function isBanned(
  supabaseAdmin: SupabaseClient | null,
  appUserId: string | undefined,
): Promise<boolean> {
  if (!supabaseAdmin || !appUserId) return false;

  const cached = cache.get(appUserId);
  if (cached && cached.expires > Date.now()) return cached.banned;

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("app_user_id")
    .eq("app_user_id", appUserId)
    .maybeSingle();
  if (error) {
    if (!isMissingTable(error.code)) {
      console.error("❌ Error reading ban list:", error);
    }
    return false;
  }

  const banned = !!data;
  cache.set(appUserId, { banned, expires: Date.now() + CACHE_MS });
  if (cache.size > 10_000) {
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  }
  return banned;
}
