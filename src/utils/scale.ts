import type { Question, QuestionRound } from "../types.js";

/**
 * scale ("On a Scale"): every question is about one player, taking turns like
 * know_each_other (even rounds player 1, odd rounds player 2). The subject
 * drags a slider to where they see themselves, the partner drags it to where
 * THEY see the subject (their own view, not a guess of the subject's answer).
 * The closer the two views, the higher the round scores.
 *
 * A question is multiple choice with exactly two options: the slider's left
 * and right ends (`answers_en[0]` at 0, `answers_en[1]` at 100). The text
 * names the subject with {{playerName}}.
 *
 * An answer is a whole number 0-100 sent as a string ("37").
 */
export const SCALE_MIN = 0;
export const SCALE_MAX = 100;
export const SCALE_POLES = 2;
/** Slider rounds are quick, so a game has the usual 10: five about each player. */
export const SCALE_QUESTION_COUNT = 10;
/** Closeness at or above this counts as "spot on" (isMatched, streaks). */
export const SCALE_SPOT_ON = 90;

export const isScaleQuestion = (question: Question): boolean =>
  question.questionType !== "text" &&
  question.haveAnswers &&
  !!question.answers &&
  question.answers.answers_en.length === SCALE_POLES;

/** The answer as stored ("37"), or null for anything but a whole number 0-100. */
export function parseScaleValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return number >= SCALE_MIN && number <= SCALE_MAX ? String(number) : null;
}

/** Seat (0 = player 1) of the player this round is about. */
export const scaleSubjectSeat = (roundIndex: number): 0 | 1 =>
  roundIndex % 2 === 0 ? 0 : 1;

export type ScaleOutcome = {
  /** 0-100, 100 = the guess landed on the subject's own spot. */
  closeness?: number;
  /** false when the subject didn't place themselves: nothing to guess against. */
  isScored: boolean;
  isMatched: boolean;
};

/**
 * Scores a round from the subject's and the guesser's answers. No guess (time
 * ran out) scores 0; no self-placement leaves the round out of the scores,
 * since the guesser had nothing to aim at.
 */
export function scoreScaleRound(self: unknown, guess: unknown): ScaleOutcome {
  const own = parseScaleValue(self);
  if (own === null) return { isScored: false, isMatched: false };
  const guessed = parseScaleValue(guess);
  if (guessed === null) return { closeness: 0, isScored: true, isMatched: false };
  const closeness = SCALE_MAX - Math.abs(Number(own) - Number(guessed));
  return { closeness, isScored: true, isMatched: closeness >= SCALE_SPOT_ON };
}

export type ScaleGuesserScore = {
  playerId: string;
  /** Spot-on guesses. */
  correct: number;
  /** Scored rounds this player guessed in. */
  total: number;
  /** Average closeness of those guesses. */
  percent: number;
  bestStreak: number;
};

/**
 * How well each player guessed the other, as the guesser: player 1 guesses
 * the odd rounds, player 2 the even ones.
 */
export function scaleGuesserScores(
  playerIds: string[],
  rounds: Pick<QuestionRound, "similarity" | "isScored" | "isMatched">[],
): ScaleGuesserScore[] {
  return playerIds.slice(0, 2).map((playerId, seat) => {
    let sum = 0;
    let total = 0;
    let correct = 0;
    let run = 0;
    let bestStreak = 0;
    rounds.forEach((round, index) => {
      // The guesser is the seat that isn't the subject.
      if (scaleSubjectSeat(index) === seat) return;
      if (round.isScored === false) return;
      total++;
      sum += round.similarity ?? 0;
      if (round.isMatched === true) {
        correct++;
        run++;
        bestStreak = Math.max(bestStreak, run);
      } else {
        run = 0;
      }
    });
    return {
      playerId,
      correct,
      total,
      percent: total ? Math.round(sum / total) : 0,
      bestStreak,
    };
  });
}

/** Average closeness over the scored rounds, 0 when none was scored. */
export function scaleGamePercentage(
  rounds: Pick<QuestionRound, "similarity" | "isScored">[],
): number {
  const scored = rounds.filter((round) => round.isScored !== false);
  if (!scored.length) return 0;
  const sum = scored.reduce((total, round) => total + (round.similarity ?? 0), 0);
  return Math.round(sum / scored.length);
}
