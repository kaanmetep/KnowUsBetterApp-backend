/**
 * Languages the app ships in. Questions, answers, category labels, reactions,
 * announcements and pushes are stored per language under these codes
 * (`text_pt`, `answers_pt`, `{ pt: ... }`), so adding one here is the
 * backend half of adding a language.
 */
export const LANGS = ["en", "tr", "es", "pt"] as const;
export type Lang = (typeof LANGS)[number];

export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: "English",
  tr: "Turkish",
  es: "Spanish",
  pt: "Brazilian Portuguese",
};

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

export type QuestionTexts = Record<`text_${Lang}`, string>;
export type QuestionAnswers = Record<`answers_${Lang}`, string[]>;
