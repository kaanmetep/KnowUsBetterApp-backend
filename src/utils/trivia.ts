/**
 * General knowledge (trivia) rounds: each answer is graded against the
 * question's `correct_answer` (see migrations/20261007_trivia_correct_answer.sql).
 * The key never leaves the server before the round is over; clients get it
 * as `question.correctAnswer` together with each player's `isCorrect`.
 */
import type { MultiLanguageAnswer, Question, RevealedAnswer } from "../types.js";
import { findAnswerObject, isTextQuestion } from "./helpers.js";
import { textAnswerIsCorrect } from "./textMatch.js";

export type AnswerKey =
  | { kind: "yes_no"; value: "yes" | "no" }
  | { kind: "choice"; value: MultiLanguageAnswer }
  | { kind: "text"; accepted: string[]; reveal: RevealedAnswer };

const LANGS = ["en", "tr", "es"] as const;

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );

/** Typed-answer key: a list, a single string, or `{ en, tr, es }` lists. */
const parseTextKey = (raw: unknown): AnswerKey | null => {
  if (Array.isArray(raw) || typeof raw === "string") {
    const accepted = strings(raw);
    return accepted.length
      ? { kind: "text", accepted, reveal: accepted[0] }
      : null;
  }
  if (typeof raw !== "object") return null;
  const byLang = raw as Record<string, unknown>;
  const lists = LANGS.map((lang) => strings(byLang[lang]));
  const accepted = [...new Set(lists.flat())];
  if (!accepted.length) return null;
  const fallback = accepted[0];
  return {
    kind: "text",
    accepted,
    reveal: {
      en: lists[0][0] ?? fallback,
      tr: lists[1][0] ?? lists[0][0] ?? fallback,
      es: lists[2][0] ?? lists[0][0] ?? fallback,
    },
  };
};

/** Reads a stored `correct_answer` for this question; null if absent or unusable. */
export function parseAnswerKey(
  raw: unknown,
  question: Question,
): AnswerKey | null {
  if (raw == null) return null;

  // Shape first: a `{ en, tr, es }` object is always a typed key, even if
  // `questionType` never made it onto the room.
  if (isTextQuestion(question) || (typeof raw === "object" && !Array.isArray(raw))) {
    return parseTextKey(raw);
  }

  if (question.haveAnswers && question.answers) {
    if (typeof raw === "number") {
      const { answers_en, answers_tr, answers_es } = question.answers;
      const en = answers_en[raw];
      return en
        ? {
            kind: "choice",
            value: { en, tr: answers_tr[raw] || en, es: answers_es[raw] || en },
          }
        : null;
    }
    const value = typeof raw === "string" ? findAnswerObject(raw, question) : null;
    return value ? { kind: "choice", value } : null;
  }

  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "yes" || value === "no" ? { kind: "yes_no", value } : null;
}

export function revealAnswer(key: AnswerKey): RevealedAnswer {
  return key.kind === "text" ? key.reveal : key.value;
}

/** A stored player answer (string, MultiLanguageAnswer or null) against the key. */
export async function gradeAnswer(
  key: AnswerKey,
  question: Question,
  answer: string | MultiLanguageAnswer | null | undefined,
  hidden: string,
): Promise<boolean> {
  if (answer == null) return false;
  switch (key.kind) {
    case "yes_no":
      return typeof answer === "string" && answer.trim().toLowerCase() === key.value;
    case "choice": {
      const given =
        typeof answer === "string" ? findAnswerObject(answer, question) : answer;
      return !!given && given.en === key.value.en;
    }
    case "text":
      return textAnswerIsCorrect(question, answer, key.accepted, hidden);
  }
}

// Typed answers are graded as soon as they arrive (the model call is the slow
// part) and picked up here when the round completes. Kept in memory rather
// than on the room, which is sent to clients; a miss just grades again.
const GRADE_TTL_MS = 5 * 60 * 1000;
const earlyGrades = new Map<string, { answer: unknown; correct: boolean; at: number }>();

const gradeKey = (roomCode: string, questionId: string, playerId: string) =>
  `${roomCode}:${questionId}:${playerId}`;

export function rememberGrade(
  roomCode: string,
  questionId: string,
  playerId: string,
  answer: unknown,
  correct: boolean,
): void {
  const now = Date.now();
  for (const [k, v] of earlyGrades) {
    if (now - v.at > GRADE_TTL_MS) earlyGrades.delete(k);
  }
  earlyGrades.set(gradeKey(roomCode, questionId, playerId), { answer, correct, at: now });
}

/** The early grade, if it was made for this exact answer. */
export function takeGrade(
  roomCode: string,
  questionId: string,
  playerId: string,
  answer: unknown,
): boolean | undefined {
  const k = gradeKey(roomCode, questionId, playerId);
  const hit = earlyGrades.get(k);
  earlyGrades.delete(k);
  return hit && JSON.stringify(hit.answer) === JSON.stringify(answer)
    ? hit.correct
    : undefined;
}
