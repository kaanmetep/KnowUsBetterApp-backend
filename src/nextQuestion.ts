import type { Question, QuestionRound, Room } from "./types.js";
import { decodeStatements } from "./utils/twoTruths.js";
import { drawingIdOf } from "./utils/draw.js";

export type NextQuestion = {
  index: number;
  question: Question;
  /** Guess round: each writer's statements (null for one who wrote nothing). */
  statements: Record<string, string[] | null> | null;
};

/**
 * The question that follows `completed`, or null when the game ends there.
 * One rule for both the round that really starts (advanceRound) and the
 * preview a single-phone result carries, so the two can't disagree.
 */
export function pickNextQuestion(
  room: Pick<Room, "questions" | "currentQuestionIndex"> & Partial<Pick<Room, "players">>,
  completed: Pick<QuestionRound, "answers">,
): NextQuestion | null {
  let index = room.currentQuestionIndex + 1;
  let question = room.questions[index];
  let statements: Record<string, string[] | null> | null = null;
  if (question?.drawIt?.phase === "guess") {
    // Each drawer's drawing, by seat; a turn nobody drew in is skipped.
    const seats = (room.players ?? []).slice(0, 2);
    const drawings = [0, 1].map((seat) => {
      const value = seats[seat] ? completed.answers[seats[seat].id] : null;
      return drawingIdOf(value) ? (value as string) : null;
    }) as [string | null, string | null];
    if (!drawings[0] && !drawings[1]) {
      index++;
      question = room.questions[index];
    } else {
      question = { ...question, drawIt: { ...question.drawIt, drawings } };
    }
    if (!question) return null;
    return { index, question, statements: null };
  }
  if (question?.twoTruths?.phase === "guess") {
    statements = Object.fromEntries(
      Object.entries(completed.answers).map(([id, value]) => [id, decodeStatements(value)]),
    );
    // Nobody wrote anything, so there's nothing to guess this turn.
    if (!Object.values(statements).some(Boolean)) {
      statements = null;
      index++;
      question = room.questions[index];
    }
  }
  if (!question) return null;
  if (statements && question.twoTruths?.phase === "guess") {
    question = { ...question, twoTruths: { ...question.twoTruths, statements } };
  }
  return { index, question, statements };
}
