import {
  LANGUAGE_NAMES,
  isLang,
  type Lang,
  type QuestionTexts,
} from "../languages.js";
import type { MultiLanguageAnswer } from "../types.js";
import { HIDDEN_TEXT_ANSWER, TEXT_ANSWER_MAX_LENGTH } from "./helpers.js";

/** A finished round as the AI prompts read it (see buildFinishedRounds). */
export interface PromptRound {
  question: Partial<QuestionTexts> & {
    text_en: string;
    questionType?: "choice" | "text";
    matchWeight?: number;
  };
  isMatched: boolean;
  isScored?: boolean;
  playerAnswers: { playerName: string; answer: string | MultiLanguageAnswer }[];
}

export const LANGUAGE_MAP: Record<string, string> = LANGUAGE_NAMES;

const YES_NO_MAP: Record<Lang, Record<string, string>> = {
  tr: { yes: "Evet", no: "Hayır" },
  en: { yes: "Yes", no: "No" },
  es: { yes: "Sí", no: "No" },
  pt: { yes: "Sim", no: "Não" },
};

const NO_ANSWER_MAP: Record<string, string> = {
  tr: "(boş bıraktı)",
  en: "(left blank)",
  es: "(lo dejó en blanco)",
  pt: "(deixou em branco)",
};

const HIDDEN_ANSWER_MAP: Record<string, string> = {
  tr: "(cevap gizlendi)",
  en: "(answer hidden)",
  es: "(respuesta oculta)",
  pt: "(resposta oculta)",
};

export function resolveQuestionText(
  question: PromptRound["question"],
  language: string,
): string {
  const key = `text_${language}` as keyof QuestionTexts;
  return question[key] || question.text_en || "";
}

/**
 * A yes/no answer is translated; a multiple choice answer ({ en, tr, ... })
 * is read in the language.
 */
export function resolveAnswer(
  answer: string | MultiLanguageAnswer,
  language: string,
): string {
  if (answer === null || answer === undefined) return "";
  if (typeof answer === "object") {
    const langKey = language as keyof typeof answer;
    return answer[langKey] || answer.en || "";
  }

  const lowerAnswer = answer.toLowerCase();
  const translations = isLang(language) ? YES_NO_MAP[language] : YES_NO_MAP.en;

  if (lowerAnswer === "yes" || lowerAnswer === "no") {
    return translations[lowerAnswer] || answer;
  }

  return answer;
}

export function isOpenRound(round: PromptRound): boolean {
  return round.isScored === false;
}

export function isTypedRound(round: PromptRound): boolean {
  return round.question?.questionType === "text";
}

/** Typed answers are user input: kept on one line, capped and quoted. */
export function resolveOpenAnswer(answer: unknown, language: string): string {
  if (answer === HIDDEN_TEXT_ANSWER) {
    return HIDDEN_ANSWER_MAP[language] || HIDDEN_ANSWER_MAP.en;
  }
  const text =
    typeof answer === "string"
      ? Array.from(answer.replace(/\s+/g, " ").trim())
          .slice(0, TEXT_ANSWER_MAX_LENGTH)
          .join("")
          .replace(/"/g, "'")
      : "";
  return text ? `"${text}"` : NO_ANSWER_MAP[language] || NO_ANSWER_MAP.en;
}
