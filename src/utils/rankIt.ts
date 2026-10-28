import type { Question } from "../types.js";

/**
 * rank_it: each player drags the question's options into an order. An answer
 * is the option indices (into `answers.answers_en`) from first place to last,
 * comma separated: "2,0,1" puts the third option first.
 */
export const RANK_IT_MIN_ITEMS = 3;
export const RANK_IT_MAX_ITEMS = 5;
/** Each ranking takes up to 30 seconds, so a game is shorter than the usual 10. */
export const RANK_IT_QUESTION_COUNT = 5;

export const rankItemCount = (question: Question): number =>
  question.haveAnswers && question.answers ? question.answers.answers_en.length : 0;

export const isRankable = (question: Question): boolean => {
  const count = rankItemCount(question);
  return count >= RANK_IT_MIN_ITEMS && count <= RANK_IT_MAX_ITEMS;
};

/** The answer as stored ("2,0,1"), or null unless it orders every option exactly once. */
export function parseRanking(value: unknown, count: number): string | null {
  if (typeof value !== "string" || count <= 0) return null;
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== count || !parts.every((part) => /^\d+$/.test(part))) return null;
  const order = parts.map(Number);
  if (new Set(order).size !== count || order.some((i) => i >= count)) return null;
  return order.join(",");
}

/**
 * 0-100: the share of option pairs both players put in the same relative
 * order (Kendall tau distance). 100 = identical, 0 = one is the other reversed.
 * A missing or invalid order scores 0.
 */
export function rankingSimilarity(a: unknown, b: unknown, count: number): number {
  const first = parseRanking(a, count);
  const second = parseRanking(b, count);
  if (!first || !second) return 0;
  const placeA = new Map(first.split(",").map((item, place) => [Number(item), place]));
  const placeB = new Map(second.split(",").map((item, place) => [Number(item), place]));
  let agreeing = 0;
  let pairs = 0;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      pairs++;
      const orderA = placeA.get(i)! < placeA.get(j)!;
      const orderB = placeB.get(i)! < placeB.get(j)!;
      if (orderA === orderB) agreeing++;
    }
  }
  return pairs ? Math.round((agreeing / pairs) * 100) : 0;
}
