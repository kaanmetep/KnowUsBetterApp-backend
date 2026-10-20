/**
 * who_is_more_likely: each player points at someone. Picks are relative to the
 * player who made them, so one player's "me" is the other one's "partner".
 */
export const MORE_LIKELY_PICKS = ["me", "partner", "both", "neither"] as const;

export type MoreLikelyPick = (typeof MORE_LIKELY_PICKS)[number];

export const isMoreLikelyPick = (value: unknown): value is MoreLikelyPick =>
  typeof value === "string" &&
  (MORE_LIKELY_PICKS as readonly string[]).includes(value);

/** True when both players pointed at the same person (or both / neither). */
export function picksAgree(a: unknown, b: unknown): boolean {
  if (!isMoreLikelyPick(a) || !isMoreLikelyPick(b)) return false;
  if (a === "me") return b === "partner";
  if (a === "partner") return b === "me";
  return a === b;
}
