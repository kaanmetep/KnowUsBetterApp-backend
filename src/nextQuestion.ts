import type { Question, QuestionRound, Room } from "./types.js";
import { decodeStatements } from "./utils/twoTruths.js";

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
  room: Pick<Room, "questions" | "currentQuestionIndex">,
  completed: Pick<QuestionRound, "answers">,
): NextQuestion | null {
  let index = room.currentQuestionIndex + 1;
  let question = room.questions[index];
  let statements: Record<string, string[] | null> | null = null;
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
