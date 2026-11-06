import type { Question, QuestionRound } from "../types.js";

/**
 * two_truths: a game is TWO_TRUTHS_TURNS turns, each played as two rounds.
 *
 * Write round: both players write three statements about themselves at the
 * same time, two true and one a lie. The app sends
 * `{"statements":["...","...","..."],"lie":2}` as the answer; the server
 * shuffles the statements, stores them (JSON array) as the answer and keeps
 * the lie's new index off the room (services/twoTruthsSecrets) so the partner
 * can't read it.
 *
 * Guess round: both players see the partner's statements and pick the lie;
 * the answer is its index ("0"-"2"). When the round is over the lies are
 * revealed in `round.lies` and `round.correct` says who caught theirs.
 *
 * Points: catching the partner's lie and fooling the partner are one each.
 */
export const TWO_TRUTHS_TURNS = 3;
export const STATEMENT_COUNT = 3;
export const STATEMENT_MAX_LENGTH = 80;

const GUESS_ID_SUFFIX = ":guess";

export const isWriteRound = (question: Question | null | undefined): boolean =>
  question?.twoTruths?.phase === "write";

export const isGuessRound = (question: Question | null | undefined): boolean =>
  question?.twoTruths?.phase === "guess";

/** Each topic becomes a write round followed by its guess round. */
export function buildTwoTruthsRounds(topics: Question[]): Question[] {
  return topics.flatMap((topic, turn) => [
    { ...topic, twoTruths: { phase: "write" as const, turn } },
    {
      ...topic,
      id: `${topic.id}${GUESS_ID_SUFFIX}`,
      twoTruths: { phase: "guess" as const, turn, writeId: topic.id },
    },
  ]);
}

/** The raw statements and the lie's index, or null unless it's a full set. */
export function parseSubmission(
  value: unknown,
): { statements: string[]; lie: number } | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const { statements, lie } = (parsed ?? {}) as { statements?: unknown; lie?: unknown };
  if (
    !Array.isArray(statements) ||
    statements.length !== STATEMENT_COUNT ||
    !statements.every((s) => typeof s === "string") ||
    typeof lie !== "number" ||
    !Number.isInteger(lie) ||
    lie < 0 ||
    lie >= STATEMENT_COUNT
  ) {
    return null;
  }
  return { statements: statements as string[], lie };
}

/** Same statements in a random order, with the lie's index in that order. */
export function shuffleStatements(
  statements: string[],
  lie: number,
  random: () => number = Math.random,
): { statements: string[]; lie: number } {
  const order = statements.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { statements: order.map((i) => statements[i]), lie: order.indexOf(lie) };
}

export const encodeStatements = (statements: string[]): string => JSON.stringify(statements);

/** A stored write answer's statements; null for a player who didn't write. */
export function decodeStatements(value: unknown): string[] | null {
  if (typeof value !== "string" || !value.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.length === STATEMENT_COUNT &&
      parsed.every((s) => typeof s === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** The picked index as stored ("1"), or null when it's not one of the statements. */
export function parseGuess(value: unknown, count: number): string | null {
  if (typeof value !== "string" || !/^\d$/.test(value)) return null;
  return Number(value) < count ? value : null;
}

export type TwoTruthsTally = {
  playerId: string;
  /** Partner's lies caught. */
  caught: number;
  /** Times the partner missed this player's lie. */
  fooled: number;
  /** Lies there were to catch plus lies the partner had to find. */
  chances: number;
};

/** Points per player over the guess rounds played. */
export function tallyTwoTruths(
  playerIds: string[],
  rounds: QuestionRound[],
): TwoTruthsTally[] {
  const tallies = playerIds.map((playerId) => ({ playerId, caught: 0, fooled: 0, chances: 0 }));
  for (const round of rounds) {
    const info = round.question.twoTruths;
    if (info?.phase !== "guess" || round.status !== "completed") continue;
    for (const tally of tallies) {
      const partnerId = playerIds.find((id) => id !== tally.playerId);
      if (!partnerId) continue;
      if (info.statements?.[partnerId]) {
        tally.chances++;
        if (round.correct?.[tally.playerId]) tally.caught++;
      }
      if (info.statements?.[tally.playerId]) {
        tally.chances++;
        if (!round.correct?.[partnerId]) tally.fooled++;
      }
    }
  }
  return tallies;
}
