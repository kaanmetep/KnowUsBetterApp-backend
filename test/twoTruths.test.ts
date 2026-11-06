import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question, QuestionRound } from "../src/types.ts";
import {
  buildTwoTruthsRounds,
  decodeStatements,
  encodeStatements,
  parseGuess,
  parseSubmission,
  shuffleStatements,
  tallyTwoTruths,
} from "../src/utils/twoTruths.ts";

const topic = (id: string): Question => ({
  id,
  texts: { text_en: id, text_tr: id, text_es: id, text_pt: id },
  category: "two_truths",
  haveAnswers: false,
  answers: null,
});

test("each topic becomes a write round and its guess round", () => {
  const rounds = buildTwoTruthsRounds([topic("a"), topic("b")]);
  assert.deepEqual(
    rounds.map((q) => [q.id, q.twoTruths]),
    [
      ["a", { phase: "write", turn: 0 }],
      ["a:guess", { phase: "guess", turn: 0, writeId: "a" }],
      ["b", { phase: "write", turn: 1 }],
      ["b:guess", { phase: "guess", turn: 1, writeId: "b" }],
    ],
  );
});

test("parseSubmission takes only three statements and a lie index", () => {
  assert.deepEqual(parseSubmission('{"statements":["a","b","c"],"lie":2}'), {
    statements: ["a", "b", "c"],
    lie: 2,
  });
  assert.equal(parseSubmission('{"statements":["a","b"],"lie":0}'), null);
  assert.equal(parseSubmission('{"statements":["a","b","c"],"lie":3}'), null);
  assert.equal(parseSubmission('{"statements":["a","b",1],"lie":0}'), null);
  assert.equal(parseSubmission("not json"), null);
  assert.equal(parseSubmission(""), null);
});

test("shuffling keeps track of the lie", () => {
  for (let seed = 0; seed < 20; seed++) {
    let n = seed;
    const random = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
    const shuffled = shuffleStatements(["t1", "t2", "lie"], 2, random);
    assert.equal(shuffled.statements[shuffled.lie], "lie");
    assert.deepEqual([...shuffled.statements].sort(), ["lie", "t1", "t2"]);
  }
});

test("stored statements round-trip; anything else is no statements", () => {
  assert.deepEqual(decodeStatements(encodeStatements(["a", "b", "c"])), ["a", "b", "c"]);
  assert.equal(decodeStatements(""), null);
  assert.equal(decodeStatements('["a","b"]'), null);
  assert.equal(decodeStatements("[oops"), null);
});

test("parseGuess accepts an index into the statements", () => {
  assert.equal(parseGuess("0", 3), "0");
  assert.equal(parseGuess("2", 3), "2");
  assert.equal(parseGuess("3", 3), null);
  assert.equal(parseGuess("-1", 3), null);
  assert.equal(parseGuess("", 3), null);
});

const guessRound = (
  statements: Record<string, string[] | null>,
  correct: Record<string, boolean>,
): QuestionRound => ({
  question: {
    ...topic("t"),
    twoTruths: { phase: "guess", turn: 0, writeId: "t", statements },
  },
  answers: {},
  isMatched: null,
  correct,
  status: "completed",
});

test("a caught lie is a point for the guesser, a missed one for the author", () => {
  const s = ["x", "y", "z"];
  const tallies = tallyTwoTruths(
    ["a", "b"],
    [
      guessRound({ a: s, b: s }, { a: true, b: false }),
      guessRound({ a: s, b: null }, { a: false, b: true }),
    ],
  );
  assert.deepEqual(tallies, [
    { playerId: "a", caught: 1, fooled: 1, chances: 3 },
    { playerId: "b", caught: 1, fooled: 0, chances: 3 },
  ]);
});
