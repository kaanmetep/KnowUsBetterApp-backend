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

/**
 * Extra grammar note for languages that mark gender in verbs and adjectives.
 * The app never knows the players' genders, and couples can be any mix.
 */
const GENDER_NOTE: Partial<Record<Lang, string>> = {
  it: "Grammar: the players' genders are unknown and they can be two women, two men or mixed. Never use a gendered adjective, past participle, pronoun or article for a player or for both together: no -o/-a agreement, no lui/lei, no entrambi/entrambe, tutti e due, l'uno/l'altro, uno/l'altra, il/la partner. Address them as 'voi' with verbs ('avete', 'vi piace'), or use their names, 'voi due', 'ognuno di voi', 'la coppia'.",
  pl: "Grammar: the players' genders are unknown and they can be two women, two men or mixed. Never use gendered forms for a player or for both together: no past tense or conditional (-ł/-ła, -łeś/-łaś, -liście/-łyście, -łby), no gendered adjectives or nouns (tacy/takie, sami/same, zadowolony/a, domator/domatorka), no oboje/obaj/obie, no on/ona/jego/jej. Use 'wy' with present-tense or perfective-future verbs ('lubicie', 'macie', 'zobaczycie'), nouns, 'każda ze stron', or the players' names in the nominative case only.",
  fr: "Grammar: the players' genders are unknown and they can be two women, two men or mixed. Never use a gendered adjective, past participle, pronoun or noun for a player or for both together: no -é/-ée, -eux/-euse, -if/-ive agreement, no il/elle/ils/elles for the players, no tous les deux/toutes les deux, l'un/l'une… l'autre, chacun/chacune, partenaire, copain/copine. Address them as 'vous' with verbs ('vous avez', 'vous aimez'), epicene adjectives (drôle, calme, sensible), nouns, 'vous deux', 'votre couple', or use their names ('Robin a besoin d'espace, Ala veut parler tout de suite').",
  ja: "Style: write natural casual Japanese addressed to the two players (ふたり), like a friend writing on LINE, not keigo, not a textbook. Never use 彼/彼女/彼氏 for a player; use their names or ふたり.",
  de: "Grammar: the players' genders are unknown and they can be two women, two men or mixed. Never refer to a player with er/sie, ihn/sie, sein/ihr, der/die (also not as a relative pronoun: not 'Robin, der …'), einer/eine … der/die andere, or gendered nouns (Partner/Partnerin, Freund/Freundin). Use the players' names, 'ihr beide', or rephrase ('Robin braucht Abstand, Ala will sofort reden').",
};

/** The first line of every AI prompt: the language, plus its grammar note. */
export function languageLine(language: string): string {
  const lang: Lang = isLang(language) ? language : "en";
  const note = GENDER_NOTE[lang];
  return `Language: ${LANGUAGE_NAMES[lang]}\n${note ? `${note}\n` : ""}`;
}

const YES_NO_MAP: Record<Lang, Record<string, string>> = {
  tr: { yes: "Evet", no: "Hayır" },
  en: { yes: "Yes", no: "No" },
  es: { yes: "Sí", no: "No" },
  pt: { yes: "Sim", no: "Não" },
  de: { yes: "Ja", no: "Nein" },
  it: { yes: "Sì", no: "No" },
  pl: { yes: "Tak", no: "Nie" },
  fr: { yes: "Oui", no: "Non" },
  ja: { yes: "はい", no: "いいえ" },
  nl: { yes: "Ja", no: "Nee" },
};

const NO_ANSWER_MAP: Record<string, string> = {
  tr: "(boş bıraktı)",
  en: "(left blank)",
  es: "(lo dejó en blanco)",
  pt: "(deixou em branco)",
  de: "(keine Antwort)",
  it: "(nessuna risposta)",
  pl: "(bez odpowiedzi)",
  fr: "(pas de réponse)",
  ja: "(未回答)",
  nl: "(geen antwoord)",
};

const HIDDEN_ANSWER_MAP: Record<string, string> = {
  tr: "(cevap gizlendi)",
  en: "(answer hidden)",
  es: "(respuesta oculta)",
  pt: "(resposta oculta)",
  de: "(Antwort verborgen)",
  it: "(risposta nascosta)",
  pl: "(odpowiedź ukryta)",
  fr: "(réponse masquée)",
  ja: "(回答は非表示)",
  nl: "(antwoord verborgen)",
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
