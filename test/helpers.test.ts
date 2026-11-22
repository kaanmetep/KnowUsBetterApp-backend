import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getQuestionDuration,
  readingSeconds,
  uniquePlayerName,
} from "../src/utils/helpers.ts";

test("uniquePlayerName keeps free names and numbers taken ones", () => {
  assert.equal(uniquePlayerName("Kaan", ["Deniz"]), "Kaan");
  assert.equal(uniquePlayerName("Kaan", ["Kaan"]), "Kaan 2");
  assert.equal(uniquePlayerName("kaan ", ["KAAN"]), "kaan 2");
  assert.equal(uniquePlayerName("İlkay", ["İlkay"]), "İlkay 2");
  assert.equal(uniquePlayerName("Kaan", ["Kaan", "Kaan 2"]), "Kaan 3");
  assert.equal(uniquePlayerName("", ["Kaan"]), "");
  assert.equal(uniquePlayerName("さくら", ["さくら"]), "さくら 2");
});

test("uniquePlayerName stays within the name length limit", () => {
  const long = "A".repeat(20);
  const result = uniquePlayerName(long, [long]);
  assert.ok(Array.from(result).length <= 20, result);
  assert.ok(result.endsWith(" 2"));
  assert.notEqual(result, long);
});

const question = (text: string) =>
  ({ id: "q", texts: { text_en: text, text_tr: "kısa" }, haveAnswers: true, answers: null }) as any;

test("readingSeconds adds time only for long questions, capped", () => {
  assert.equal(readingSeconds(question("Short question?")), 0);
  assert.equal(readingSeconds(question("x".repeat(140))), 0);
  assert.equal(readingSeconds(question("x".repeat(141))), 1);
  assert.equal(readingSeconds(question("x".repeat(465))), 15);
  assert.equal(readingSeconds(null), 0);
});

test("getQuestionDuration adds reading time to choice questions only", () => {
  const settings = { questionDuration: 15, mode: "know_each_other" } as any;
  assert.equal(getQuestionDuration(settings, question("Short?")), 15);
  assert.equal(getQuestionDuration(settings, question("x".repeat(290))), 25);
  assert.equal(getQuestionDuration({ ...settings, mode: "rank_it" }, question("x".repeat(290))) > 0, true);
});

test("refundsUnfinishedGame refunds only games less than half played", async () => {
  const { refundsUnfinishedGame } = await import("../src/utils/helpers.ts");
  assert.equal(refundsUnfinishedGame(0, 10), true);
  assert.equal(refundsUnfinishedGame(4, 10), true);
  assert.equal(refundsUnfinishedGame(5, 10), false);
  assert.equal(refundsUnfinishedGame(9, 10), false);
  assert.equal(refundsUnfinishedGame(2, 5), true);
  assert.equal(refundsUnfinishedGame(3, 5), false);
  assert.equal(refundsUnfinishedGame(3, 0), true);
});
