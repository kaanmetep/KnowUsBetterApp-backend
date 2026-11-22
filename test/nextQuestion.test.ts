import assert from "node:assert/strict";
import { test } from "node:test";
import { pickNextQuestion } from "../src/nextQuestion.ts";
import type { Question } from "../src/types.ts";
import { buildTwoTruthsRounds, encodeStatements } from "../src/utils/twoTruths.ts";

const question = (id: string): Question => ({
  id,
  texts: { text_en: id, text_tr: id, text_es: id, text_pt: id },
  category: "c",
  haveAnswers: false,
  answers: null,
});

const room = (questions: Question[], currentQuestionIndex: number) => ({
  questions,
  currentQuestionIndex,
});

test("the next question follows the current one", () => {
  const qs = [question("a"), question("b"), question("c")];
  const next = pickNextQuestion(room(qs, 0), { answers: { h: "yes", p: "no" } });
  assert.equal(next?.index, 1);
  assert.equal(next?.question, qs[1]);
  assert.equal(next?.statements, null);
});

test("after the last question there is none", () => {
  const qs = [question("a"), question("b")];
  assert.equal(pickNextQuestion(room(qs, 1), { answers: { h: "yes", p: "no" } }), null);
});

test("a guess round carries both writers' statements", () => {
  const qs = buildTwoTruthsRounds([question("a"), question("b")]);
  const answers = { h: encodeStatements(["1", "2", "3"]), p: "" };
  const next = pickNextQuestion(room(qs, 0), { answers });
  assert.equal(next?.index, 1);
  assert.equal(next?.question.id, "a:guess");
  assert.deepEqual(next?.question.twoTruths?.statements, { h: ["1", "2", "3"], p: null });
  assert.deepEqual(next?.statements, { h: ["1", "2", "3"], p: null });
  // The room's own question isn't changed.
  assert.equal(qs[1].twoTruths?.statements, undefined);
});

test("nobody wrote: the guess round is skipped", () => {
  const qs = buildTwoTruthsRounds([question("a"), question("b")]);
  const next = pickNextQuestion(room(qs, 0), { answers: { h: "", p: null } });
  assert.equal(next?.index, 2);
  assert.equal(next?.question.id, "b");
  assert.equal(next?.statements, null);
});

test("nobody wrote on the last turn: the game ends", () => {
  const qs = buildTwoTruthsRounds([question("a")]);
  assert.equal(pickNextQuestion(room(qs, 0), { answers: { h: "", p: "" } }), null);
});

test("after a guess round comes the next write round", () => {
  const qs = buildTwoTruthsRounds([question("a"), question("b")]);
  const next = pickNextQuestion(room(qs, 1), { answers: { h: "0", p: "2" } });
  assert.equal(next?.index, 2);
  assert.deepEqual(next?.question.twoTruths, { phase: "write", turn: 1 });
});
