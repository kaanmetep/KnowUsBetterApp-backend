import { SupabaseClient } from "@supabase/supabase-js";

export type ReactionAnimation = "float" | "burst" | "shake" | "rain";

const ANIMATIONS: readonly ReactionAnimation[] = ["float", "burst", "shake", "rain"];

export interface ReactionRecord {
  id: string;
  emoji: string;
  labels: Record<string, string>;
  /** 0 = free. */
  coinCost: number;
  animation: ReactionAnimation;
  color: string;
  orderIndex: number;
}

const CATALOG_CACHE_TTL_MS = 60_000;

let cached: { reactions: ReactionRecord[]; expiresAt: number } | null = null;
let inflight: Promise<ReactionRecord[]> | null = null;

const parseAnimation = (value: unknown): ReactionAnimation =>
  (ANIMATIONS as readonly unknown[]).includes(value)
    ? (value as ReactionAnimation)
    : "float";

async function loadReactions(supabaseAdmin: SupabaseClient): Promise<ReactionRecord[]> {
  const { data, error } = await supabaseAdmin
    .from("game_reactions")
    .select("*")
    .eq("is_active", true)
    .order("order_index", { ascending: true });
  if (error) throw error;

  return (data ?? [])
    .filter((row: any) => typeof row.emoji === "string" && row.emoji)
    .map((row: any) => ({
      id: row.id,
      emoji: row.emoji,
      labels: row.labels ?? {},
      coinCost: Math.max(0, row.coin_cost ?? 0),
      animation: parseAnimation(row.animation),
      color: row.color || "#C94B6A",
      orderIndex: row.order_index ?? 0,
    }));
}

/** Active reactions in display order, cached for a minute. */
export async function getReactions(
  supabaseAdmin: SupabaseClient,
): Promise<ReactionRecord[]> {
  if (cached && cached.expiresAt > Date.now()) return cached.reactions;
  if (!inflight) {
    inflight = loadReactions(supabaseAdmin)
      .then((reactions) => {
        cached = { reactions, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS };
        return reactions;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function getReaction(
  reactionId: string,
  supabaseAdmin: SupabaseClient,
): Promise<ReactionRecord | null> {
  if (!reactionId) return null;
  const reactions = await getReactions(supabaseAdmin);
  return reactions.find((reaction) => reaction.id === reactionId) ?? null;
}
