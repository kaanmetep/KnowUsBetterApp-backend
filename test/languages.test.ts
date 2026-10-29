import test from "node:test";
import assert from "node:assert/strict";
import { findAnswerObject } from "../src/utils/helpers.js";
import { parseAnswerKey } from "../src/utils/trivia.js";
import { validateQuestionInput } from "../src/services/adminQuestionService.js";
import { fetchRandomQuestions } from "../src/services/questionService.js";
import { maskProfanity } from "../src/utils/profanity.js";
import type { Question } from "../src/types.js";

const question = (answers: Record<string, string[]>): Question =>
  ({
    id: "q1",
    texts: { text_en: "Q", text_tr: "S", text_es: "P", text_pt: "P" },
    category: "long_term",
    haveAnswers: true,
    answers,
    questionType: "choice",
  }) as Question;

const full = question({
  answers_en: ["Beach", "Mountains"],
  answers_tr: ["Plaj", "Dağlar"],
  answers_es: ["Playa", "Montañas"],
  answers_pt: ["Praia", "Montanhas"],
});

test("findAnswerObject matches an answer picked in any language", () => {
  const expected = { en: "Mountains", tr: "Dağlar", es: "Montañas", pt: "Montanhas" };
  for (const pick of ["Mountains", "Dağlar", "Montañas", "Montanhas"]) {
    assert.deepEqual(findAnswerObject(pick, full), expected);
  }
  assert.equal(findAnswerObject("Desert", full), null);
});

test("findAnswerObject on a room stored before Portuguese falls back to the picked text", () => {
  const old = question({
    answers_en: ["Beach", "Mountains"],
    answers_tr: ["Plaj", "Dağlar"],
    answers_es: ["Playa", "Montañas"],
  });
  assert.deepEqual(findAnswerObject("Plaj", old), {
    en: "Beach",
    tr: "Plaj",
    es: "Playa",
    pt: "Plaj",
  });
});

test("typed trivia key reveals each language, English when one is missing", () => {
  const typed = { ...full, haveAnswers: false, answers: null, questionType: "text" } as Question;
  const key = parseAnswerKey({ en: ["Mars"], tr: ["Mars"], es: ["Marte"] }, typed);
  assert.deepEqual(key, {
    kind: "text",
    accepted: ["Mars", "Marte"],
    reveal: { en: "Mars", tr: "Mars", es: "Marte", pt: "Mars" },
  });
});

test("multiple choice trivia key carries the Portuguese answer", () => {
  assert.deepEqual(parseAnswerKey("Beach", full), {
    kind: "choice",
    value: { en: "Beach", tr: "Plaj", es: "Playa", pt: "Praia" },
  });
});

test("admin questions need a Portuguese text and answers", () => {
  const body = {
    category_id: "long_term",
    texts: { text_en: "Q", text_tr: "S", text_es: "P" },
    have_answers: true,
    answers: {
      answers_en: ["A", "B"],
      answers_tr: ["A", "B"],
      answers_es: ["A", "B"],
    },
  };
  assert.throws(() => validateQuestionInput(body), /texts\.text_pt is required/);
  assert.throws(
    () => validateQuestionInput({ ...body, texts: { ...body.texts, text_pt: "P" } }),
    /answers\.answers_pt must be an array/,
  );
  const ok = validateQuestionInput({
    ...body,
    texts: { ...body.texts, text_pt: "P" },
    answers: { ...body.answers, answers_pt: ["A", "B"] },
  });
  assert.equal(ok.texts.text_pt, "P");
  assert.deepEqual(ok.answers?.answers_pt, ["A", "B"]);
});

test("a typed key given as one list applies to every language", () => {
  const ok = validateQuestionInput({
    category_id: "mastermind",
    texts: { text_en: "Q", text_tr: "S", text_es: "P", text_pt: "P" },
    question_type: "text",
    correct_answer: ["Ankara"],
  });
  assert.deepEqual(ok.correct_answer, {
    en: ["Ankara"],
    tr: ["Ankara"],
    es: ["Ankara"],
    pt: ["Ankara"],
  });
});

test("questions keep Portuguese and borrow English answers where it's missing", async () => {
  const rows = [
    {
      id: "q1",
      category_id: "long_term",
      texts: { text_en: "Q", text_tr: "S", text_es: "P", text_pt: "Pergunta" },
      have_answers: true,
      answers: {
        answers_en: ["A", "B"],
        answers_tr: ["A", "B"],
        answers_es: ["A", "B"],
        answers_pt: ["Sim", "Não"],
      },
      question_type: "choice",
    },
    {
      id: "q2",
      category_id: "long_term",
      texts: { text_en: "Q2", text_tr: "S2", text_es: "P2" },
      have_answers: true,
      answers: { answers_en: ["C", "D"], answers_tr: ["C", "D"], answers_es: ["C", "D"] },
      question_type: "choice",
    },
  ];
  const query = { select: () => query, in: async () => ({ data: [], error: null }) };
  const db = {
    rpc: async () => ({ data: rows, error: null }),
    from: () => query,
  };
  const [q1, q2] = await fetchRandomQuestions("long_term", 2, db);
  assert.equal(q1.texts.text_pt, "Pergunta");
  assert.deepEqual(q1.answers?.answers_pt, ["Sim", "Não"]);
  assert.equal(q2.texts.text_pt, "");
  assert.deepEqual(q2.answers?.answers_pt, ["C", "D"]);
});

test("Portuguese profanity is masked, ordinary words are not", () => {
  assert.equal(maskProfanity("que porra é essa"), "que p**** é essa");
  for (const clean of ["cuidado com isso", "computador", "disputa", "Eu amo pizza"]) {
    assert.equal(maskProfanity(clean), clean);
  }
});
