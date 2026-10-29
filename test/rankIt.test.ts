import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRanking, rankingSimilarity } from "../src/utils/rankIt.ts";

test("parseRanking keeps full orders and rejects everything else", () => {
  assert.equal(parseRanking("2,0,1", 3), "2,0,1");
  assert.equal(parseRanking(" 1, 0 ,2", 3), "1,0,2");
  assert.equal(parseRanking("2,0,0", 3), null);
  assert.equal(parseRanking("2,0", 3), null);
  assert.equal(parseRanking("0,1,3", 3), null);
  assert.equal(parseRanking("", 3), null);
  assert.equal(parseRanking(["0", "1", "2"], 3), null);
});

test("rankingSimilarity scores agreeing pairs", () => {
  assert.equal(rankingSimilarity("0,1,2,3", "0,1,2,3", 4), 100);
  assert.equal(rankingSimilarity("0,1,2,3", "3,2,1,0", 4), 0);
  assert.equal(rankingSimilarity("0,1,2,3", "1,0,2,3", 4), 83);
  assert.equal(rankingSimilarity("0,1,2", "1,0,2", 3), 67);
  assert.equal(rankingSimilarity("0,1,2,3,4", "1,0,2,3,4", 5), 90);
});

test("a missing order scores 0", () => {
  assert.equal(rankingSimilarity("", "0,1,2", 3), 0);
  assert.equal(rankingSimilarity("0,1,2", "0,1", 3), 0);
});
