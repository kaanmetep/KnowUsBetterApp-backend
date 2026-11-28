import type { MultiLanguageAnswer, Question, QuestionRound } from "../types.js";
import { LANGS } from "../languages.js";

/**
 * draw ("Draw It"): a Pictionary for two. A game is DRAW_TURNS turns, each
 * played as two rounds, like two_truths:
 *
 * Draw round: both players draw at the same time, each their own secret word.
 * The app asks for its word with "get-draw-word"; the room never carries it.
 * The answer is the drawing (see the format below), which the server stores
 * apart (services/drawings) and replaces with a reference ("d:<id>").
 *
 * Guess round: each player watches the partner's drawing replay and picks the
 * word from four options. The answer is "<option>:<ms>", ms being how long the
 * guesser looked (measured on the phone; stats only). A right guess is worth
 * the same however long it took, a wrong one 0: it's about reading the drawing,
 * not speed. Played together as a team, not against each other. On two phones
 * guessing has a clock; on one phone it doesn't.
 *
 * Words are multiple-choice questions with exactly DRAW_OPTIONS answers: the
 * first is the word, the rest are look-alikes ("pizza", "cookie", "pie",
 * "pancake"). The server shuffles them for every game and keeps where the word
 * went (services/drawItSecrets), so a guesser's options never give it away.
 *
 * Everything per player is kept by seat (0 = player 1), which doesn't change
 * when a player reconnects with a new socket id.
 *
 * Drawing format (the app writes it, see app/(components)/game/modes/draw/drawingCodec.ts):
 *
 *   drawing := stroke ("|" stroke)*
 *   stroke  := tool ":" x "," y (";" dx "," dy)*
 *   tool    := colour width     colour: "0"-"9" palette index or "e" eraser
 *                               width:  "0"-"2"
 *
 * Coordinates are on a 1000 x 1000 square (0-999); after the first point each
 * one is the step from the previous point.
 */
export const DRAW_GRID = 1000;
/** Four turns: eight drawings, about five minutes. */
export const DRAW_TURNS = 4;
export const DRAW_OPTIONS = 4;
/** Well under the socket's 64 KB message limit. */
export const DRAW_MAX_LENGTH = 40_000;
export const DRAW_MAX_STROKES = 600;
export const DRAW_MAX_POINTS = 6_000;

/** How long a guess round lasts on two phones (one phone has no clock). */
export const DRAW_GUESS_SECONDS = 30;
/** A right guess is a right guess: no bonus for speed. */
export const DRAW_POINTS_PER_GUESS = 100;

export type Seat = 0 | 1;

export type DrawItRound =
  | {
      phase: "draw";
      turn: number;
      /** The two word questions (seat 0's, seat 1's); for marking them seen. */
      wordIds: [string, string];
    }
  | {
      phase: "guess";
      turn: number;
      /** Id of this turn's draw round. */
      drawId: string;
      /** Each drawer's word with its look-alikes, shuffled: options[drawerSeat]. */
      options: [MultiLanguageAnswer[], MultiLanguageAnswer[]];
      /** Filled in when the round starts: each drawer's drawing ("d:<id>"), null for a blank page. */
      drawings?: [string | null, string | null];
    };

/** What clients get with a completed guess round. */
export type DrawItReveal = {
  /** Where each drawer's word was in their options: correct[drawerSeat]. */
  correct: [number | null, number | null];
  /** Points each guesser scored: points[guesserSeat]. */
  points: [number, number];
};

export const isDrawRound = (question: Question | null | undefined): boolean =>
  question?.drawIt?.phase === "draw";

export const isDrawGuessRound = (question: Question | null | undefined): boolean =>
  question?.drawIt?.phase === "guess";

/** Words are multiple-choice questions with the word and three look-alikes. */
export const isDrawWord = (question: Question): boolean =>
  question.questionType !== "text" &&
  question.haveAnswers &&
  !!question.answers &&
  question.answers.answers_en.length === DRAW_OPTIONS;

/** One language-keyed option, falling back to English where a language is missing. */
function optionAt(question: Question, index: number): MultiLanguageAnswer {
  const answers = question.answers!;
  const en = answers.answers_en[index];
  return Object.fromEntries(
    LANGS.map((lang) => [lang, answers[`answers_${lang}`]?.[index] || en]),
  ) as MultiLanguageAnswer;
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export type DrawSecret = { drawId: string; seat: Seat; correct: number; word: MultiLanguageAnswer };

/**
 * Pairs the words two by two into turns: a draw round and its guess round
 * each. Returns the rounds and, kept off the room, where each word ended up
 * among its shuffled options.
 */
export function buildDrawRounds(
  words: Question[],
  random: () => number = Math.random,
): { rounds: Question[]; secrets: DrawSecret[] } {
  const rounds: Question[] = [];
  const secrets: DrawSecret[] = [];
  for (let turn = 0; turn * 2 + 1 < words.length; turn++) {
    const pair: [Question, Question] = [words[turn * 2], words[turn * 2 + 1]];
    const drawId = `draw:${turn}:${pair[0].id}`;
    const options = pair.map((word, seat) => {
      const order = shuffled([0, 1, 2, 3], random);
      secrets.push({
        drawId,
        seat: seat as Seat,
        correct: order.indexOf(0),
        word: optionAt(word, 0),
      });
      return order.map((i) => optionAt(word, i));
    }) as [MultiLanguageAnswer[], MultiLanguageAnswer[]];
    const base = { ...pair[0], answers: null, haveAnswers: false };
    rounds.push(
      {
        ...base,
        id: drawId,
        drawIt: { phase: "draw", turn, wordIds: [pair[0].id, pair[1].id] },
      },
      {
        ...base,
        id: `guess:${turn}:${pair[0].id}`,
        drawIt: { phase: "guess", turn, drawId, options },
      },
    );
  }
  return { rounds, secrets };
}

/** What a reference answer holds instead of the drawing itself. */
const REF_PREFIX = "d:";
export const drawingRef = (id: string) => `${REF_PREFIX}${id}`;
export const DRAWING_ID = /^[A-Za-z0-9]{12}$/;
export function drawingIdOf(answer: unknown): string | null {
  if (typeof answer !== "string" || !answer.startsWith(REF_PREFIX)) return null;
  const id = answer.slice(REF_PREFIX.length);
  return DRAWING_ID.test(id) ? id : null;
}

const TOOL = /^[0-9e][0-2]$/;
const INT = /^-?\d{1,4}$/;

/**
 * The drawing as sent, or null when it's malformed, too big or empty (no
 * strokes). Every point has to stay on the grid.
 */
export function parseDrawing(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const drawing = value.trim();
  if (!drawing || drawing.length > DRAW_MAX_LENGTH) return null;
  const strokes = drawing.split("|");
  if (strokes.length > DRAW_MAX_STROKES) return null;
  let points = 0;
  for (const stroke of strokes) {
    const colon = stroke.indexOf(":");
    if (colon !== 2 || !TOOL.test(stroke.slice(0, 2))) return null;
    const steps = stroke.slice(3).split(";");
    points += steps.length;
    if (points > DRAW_MAX_POINTS) return null;
    let x = 0;
    let y = 0;
    for (let i = 0; i < steps.length; i++) {
      const parts = steps[i].split(",");
      if (parts.length !== 2 || !INT.test(parts[0]) || !INT.test(parts[1])) return null;
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      x = i === 0 ? a : x + a;
      y = i === 0 ? b : y + b;
      if (x < 0 || y < 0 || x >= DRAW_GRID || y >= DRAW_GRID) return null;
    }
  }
  return drawing;
}

/**
 * A guess as stored ("2:5400"), or null unless it's an option and a time.
 * The time (ms the guess took) is kept for stats only; it scores nothing.
 */
export function parseDrawGuess(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^([0-3]):(\d{1,9})$/.exec(value.trim());
  if (!match) return null;
  return `${match[1]}:${Number(match[2])}`;
}

export const guessOption = (stored: unknown): number | null => {
  const parsed = parseDrawGuess(stored);
  return parsed === null ? null : Number(parsed.split(":")[0]);
};

/**
 * Scores a guess round. `guesses[seat]` is what that seat picked, `correct`
 * where each drawer's word sits (null when it's unknown), `drew[seat]` whether
 * that seat drew anything: a blank page can't be guessed and isn't scored.
 */
export function scoreGuessRound(
  guesses: [unknown, unknown],
  correct: [number | null, number | null],
  drew: [boolean, boolean],
): { points: [number, number]; right: [boolean, boolean]; scored: boolean } {
  const points: [number, number] = [0, 0];
  const right: [boolean, boolean] = [false, false];
  for (const guesser of [0, 1] as const) {
    const drawer = (1 - guesser) as Seat;
    const stored = parseDrawGuess(guesses[guesser]);
    if (!drew[drawer] || stored === null || correct[drawer] === null) continue;
    if (Number(stored.split(":")[0]) !== correct[drawer]) continue;
    right[guesser] = true;
    points[guesser] = DRAW_POINTS_PER_GUESS;
  }
  return { points, right, scored: drew[0] || drew[1] };
}

export type DrawPlayerScore = {
  playerId: string;
  /** Partner's drawings this player guessed. */
  correct: number;
  /** Partner's drawings there were to guess. */
  total: number;
  percent: number;
  bestStreak: number;
  /** Points this player's guesses brought the team. */
  points: number;
};

/** Each player's guessing over the game, from the completed guess rounds. */
export function drawScores(
  playerIds: string[],
  rounds: Pick<QuestionRound, "question" | "drawReveal" | "status">[],
): DrawPlayerScore[] {
  return playerIds.slice(0, 2).map((playerId, seat) => {
    let correct = 0;
    let total = 0;
    let points = 0;
    let run = 0;
    let bestStreak = 0;
    for (const round of rounds) {
      const info = round.question.drawIt;
      if (info?.phase !== "guess" || !round.drawReveal) continue;
      const drawer = 1 - seat;
      // The partner left the page blank: nothing to guess.
      if (!info.drawings?.[drawer]) continue;
      total++;
      const scored = round.drawReveal.points[seat] ?? 0;
      points += scored;
      if (scored > 0) {
        correct++;
        run++;
        bestStreak = Math.max(bestStreak, run);
      } else {
        run = 0;
      }
    }
    return {
      playerId,
      correct,
      total,
      percent: total ? Math.round((correct / total) * 100) : 0,
      bestStreak,
      points,
    };
  });
}

/** Share of the drawings that were guessed, over the whole game (0-100). */
export function drawGamePercentage(
  rounds: Pick<QuestionRound, "question" | "drawReveal" | "status">[],
): number {
  const scores = drawScores(["a", "b"], rounds);
  const total = scores[0].total + scores[1].total;
  return total ? Math.round(((scores[0].correct + scores[1].correct) / total) * 100) : 0;
}
