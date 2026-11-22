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
    texts: {
      text_en: "Q",
      text_tr: "S",
      text_es: "P",
      text_pt: "P",
      text_de: "F",
      text_it: "D",
      text_pl: "P",
      text_fr: "Q",
      text_ja: "質問",
      text_nl: "V",
    },
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
  answers_de: ["Strand", "Berge"],
  answers_it: ["Spiaggia", "Montagna"],
  answers_pl: ["Plaża", "Góry"],
  answers_fr: ["Plage", "Montagnes"],
  answers_ja: ["海", "山"],
  answers_nl: ["Strand", "Bergen"],
});

test("findAnswerObject matches an answer picked in any language", () => {
  const expected = {
    en: "Mountains",
    tr: "Dağlar",
    es: "Montañas",
    pt: "Montanhas",
    de: "Berge",
    it: "Montagna",
    pl: "Góry",
    fr: "Montagnes",
    ja: "山",
    nl: "Bergen",
  };
  for (const pick of ["Mountains", "Dağlar", "Montañas", "Montanhas", "Berge", "Montagna", "Góry", "Montagnes", "山", "Bergen"]) {
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
    de: "Plaj",
    it: "Plaj",
    pl: "Plaj",
    fr: "Plaj",
    ja: "Plaj",
    nl: "Plaj",
  });
});

test("typed trivia key reveals each language, English when one is missing", () => {
  const typed = { ...full, haveAnswers: false, answers: null, questionType: "text" } as Question;
  const key = parseAnswerKey({ en: ["Mars"], tr: ["Mars"], es: ["Marte"] }, typed);
  assert.deepEqual(key, {
    kind: "text",
    accepted: ["Mars", "Marte"],
    reveal: { en: "Mars", tr: "Mars", es: "Marte", pt: "Mars", de: "Mars", it: "Mars", pl: "Mars", fr: "Mars", ja: "Mars", nl: "Mars" },
  });
});

test("multiple choice trivia key carries the Portuguese answer", () => {
  assert.deepEqual(parseAnswerKey("Beach", full), {
    kind: "choice",
    value: {
      en: "Beach",
      tr: "Plaj",
      es: "Playa",
      pt: "Praia",
      de: "Strand",
      it: "Spiaggia",
      pl: "Plaża",
      fr: "Plage",
      ja: "海",
      nl: "Strand",
    },
  });
});

test("admin questions need every language's text and answers", () => {
  const texts = { text_en: "Q", text_tr: "S", text_es: "P", text_pt: "P", text_de: "F", text_it: "D", text_pl: "P", text_fr: "Q", text_ja: "質問", text_nl: "V" };
  const answers = {
    answers_en: ["A", "B"],
    answers_tr: ["A", "B"],
    answers_es: ["A", "B"],
    answers_pt: ["A", "B"],
    answers_de: ["A", "B"],
    answers_it: ["A", "B"],
    answers_pl: ["A", "B"],
    answers_fr: ["A", "B"],
    answers_ja: ["A", "B"],
    answers_nl: ["A", "B"],
  };
  const body = { category_id: "long_term", texts, have_answers: true, answers };
  const { text_pt: _pt, ...noPt } = texts;
  assert.throws(() => validateQuestionInput({ ...body, texts: noPt }), /texts\.text_pt is required/);
  const { text_pl: _pl, ...noPl } = texts;
  assert.throws(() => validateQuestionInput({ ...body, texts: noPl }), /texts\.text_pl is required/);
  const { answers_de: _de, ...noDe } = answers;
  assert.throws(() => validateQuestionInput({ ...body, answers: noDe }), /answers\.answers_de must be an array/);
  const ok = validateQuestionInput(body);
  assert.equal(ok.texts.text_it, "D");
  assert.deepEqual(ok.answers?.answers_pl, ["A", "B"]);
});

test("a typed key given as one list applies to every language", () => {
  const ok = validateQuestionInput({
    category_id: "mastermind",
    texts: { text_en: "Q", text_tr: "S", text_es: "P", text_pt: "P", text_de: "F", text_it: "D", text_pl: "P", text_fr: "Q", text_ja: "質問", text_nl: "V" },
    question_type: "text",
    correct_answer: ["Ankara"],
  });
  assert.deepEqual(ok.correct_answer, {
    en: ["Ankara"],
    tr: ["Ankara"],
    es: ["Ankara"],
    pt: ["Ankara"],
    de: ["Ankara"],
    it: ["Ankara"],
    pl: ["Ankara"],
    fr: ["Ankara"],
    ja: ["Ankara"],
    nl: ["Ankara"],
  });
});

test("questions keep their language and borrow English where it's missing", async () => {
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
  assert.equal(q2.texts.text_pt, "Q2");
  assert.equal(q2.texts.text_de, "Q2");
  assert.deepEqual(q2.answers?.answers_pt, ["C", "D"]);
});

test("Portuguese profanity is masked, ordinary words are not", () => {
  assert.equal(maskProfanity("que porra é essa"), "que p**** é essa");
  for (const clean of ["cuidado com isso", "computador", "disputa", "Eu amo pizza"]) {
    assert.equal(maskProfanity(clean), clean);
  }
});

test("French and Dutch profanity is masked, everyday words are not", () => {
  for (const [dirty, masked] of [
    ["putain de merde", "p***** de m****"],
    ["sale connard", "sale c******"],
    ["wat een klootzak", "wat een k*******"],
    ["kut", "k**"],
  ]) {
    assert.equal(maskProfanity(dirty), masked);
  }
  for (const clean of [
    "café con leche", "con amore", "la bite", "computer", "dispute", "Hoe gaat het",
    "Je t'aime", "lulu", "hoera!", "Ja ik ben er", "ビールが好き",
    "Un peu en retard", "Sous la douche", "Pique-nique au parc", "makkelijk slagen",
    "Als je partner 100 kilo woog, zou je", "een schoonmaker huren", "Wat weegt meer, de lever",
    "maakt je lichaam aan als je huid", "une soirée de folie",
  ]) {
    assert.equal(maskProfanity(clean), clean);
  }
});

test("German, Italian and Polish profanity is masked, everyday words are not", () => {
  for (const [dirty, masked] of [
    ["Du Arschloch", "Du A********"],
    ["che stronzo", "che s******"],
    ["kurwa mać", "k**** mać"],
    ["amk", "a**"],
    ["bok gibi", "b** gibi"],
  ]) {
    assert.equal(maskProfanity(dirty), masked);
  }
  for (const clean of [
    "Noch mal spielen", "Mit Freunden, amici e amiche", "Na boku", "Lubisz pić drinki?",
    "W domu z ogrodem", "Non c'è problema", "Cu", "Mar Negro", "Im Schwanz", "Schmuck",
    "Wie hell ist es", "Pablo Picasso", "Spicy food", "56", "per sempre",
  ]) {
    assert.equal(maskProfanity(clean), clean);
  }
});

test("typed answers compare without Polish ł or German ß", async () => {
  const { comparable } = await import("../src/utils/textMatch.js");
  assert.equal(comparable("Łódź"), comparable("lodz"));
  assert.equal(comparable("Straße"), comparable("strasse"));
  assert.equal(comparable("Çiğ  Köfte!"), "cig kofte");
  // Japanese: voiced marks are part of the letter, not accents.
  assert.notEqual(comparable("ビール"), comparable("ピール"));
  assert.notEqual(comparable("ビール"), comparable("ヒール"));
  assert.equal(comparable("ビール"), comparable("びーる"));
  assert.equal(comparable("ｶﾞｽ"), comparable("ガス"));
  assert.equal(comparable("東京タワー！"), "東京たわー");
  assert.equal(comparable("Ｔｏｋｙｏ"), "tokyo");
  assert.equal(comparable("Crème brûlée"), "creme brulee");
});
