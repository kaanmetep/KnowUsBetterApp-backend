import assert from "node:assert/strict";
import { test } from "node:test";
import { getQuestionDuration, getResultDisplayDuration } from "../src/utils/helpers.ts";
import { getGamePercentage, summarizeGame } from "../src/services/finishedGames.ts";
import {
  isScaleQuestion,
  parseScaleValue,
  scaleGamePercentage,
  scaleGuesserScores,
  scaleSubjectSeat,
  scoreScaleRound,
} from "../src/utils/scale.ts";
import type { Question, QuestionRound, Room, RoomSettings } from "../src/types.ts";

const question = (answersEn: string[] | null, extra: Partial<Question> = {}): Question =>
  ({
    id: "q",
    texts: { text_en: "How adventurous is {{playerName}}?" },
    category: "scale",
    haveAnswers: !!answersEn,
    answers: answersEn ? { answers_en: answersEn } : null,
    questionType: "choice",
    ...extra,
  }) as unknown as Question;

test("parseScaleValue keeps whole numbers 0-100 only", () => {
  assert.equal(parseScaleValue("0"), "0");
  assert.equal(parseScaleValue("100"), "100");
  assert.equal(parseScaleValue("37"), "37");
  assert.equal(parseScaleValue(" 42 "), "42");
  assert.equal(parseScaleValue("007"), "7");
  assert.equal(parseScaleValue("101"), null);
  assert.equal(parseScaleValue("-1"), null);
  assert.equal(parseScaleValue("50.5"), null);
  assert.equal(parseScaleValue("1e2"), null);
  assert.equal(parseScaleValue("0x10"), null);
  assert.equal(parseScaleValue("1000"), null);
  assert.equal(parseScaleValue(""), null);
  assert.equal(parseScaleValue("  "), null);
  assert.equal(parseScaleValue("fifty"), null);
  assert.equal(parseScaleValue(50), null);
  assert.equal(parseScaleValue(null), null);
  assert.equal(parseScaleValue(undefined), null);
  assert.equal(parseScaleValue({ en: "50" }), null);
  assert.equal(parseScaleValue(["50"]), null);
});

test("only two-option choice questions are playable", () => {
  assert.equal(isScaleQuestion(question(["Calm", "Wild"])), true);
  assert.equal(isScaleQuestion(question(["A", "B", "C"])), false);
  assert.equal(isScaleQuestion(question(["A"])), false);
  assert.equal(isScaleQuestion(question(null)), false);
  assert.equal(isScaleQuestion(question(["Calm", "Wild"], { questionType: "text" })), false);
});

test("subjects alternate: player 1 on even rounds", () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(scaleSubjectSeat), [0, 1, 0, 1, 1]);
});

test("closeness is 100 minus the distance", () => {
  assert.deepEqual(scoreScaleRound("30", "30"), { closeness: 100, isScored: true, isMatched: true });
  assert.deepEqual(scoreScaleRound("30", "85"), { closeness: 45, isScored: true, isMatched: false });
  assert.deepEqual(scoreScaleRound("0", "100"), { closeness: 0, isScored: true, isMatched: false });
  assert.deepEqual(scoreScaleRound("100", "0"), { closeness: 0, isScored: true, isMatched: false });
  // Spot on from 90 up, both directions.
  assert.equal(scoreScaleRound("50", "60").isMatched, true);
  assert.equal(scoreScaleRound("60", "50").isMatched, true);
  assert.equal(scoreScaleRound("50", "61").isMatched, false);
});

test("no guess scores 0, no self-placement isn't scored", () => {
  assert.deepEqual(scoreScaleRound("40", ""), { closeness: 0, isScored: true, isMatched: false });
  assert.deepEqual(scoreScaleRound("40", null), { closeness: 0, isScored: true, isMatched: false });
  assert.deepEqual(scoreScaleRound("", "40"), { isScored: false, isMatched: false });
  assert.deepEqual(scoreScaleRound("", ""), { isScored: false, isMatched: false });
  assert.deepEqual(scoreScaleRound(null, null), { isScored: false, isMatched: false });
  assert.deepEqual(scoreScaleRound("abc", "40"), { isScored: false, isMatched: false });
});

type R = Pick<QuestionRound, "similarity" | "isScored" | "isMatched">;
const round = (similarity: number | undefined, isScored = true): R => ({
  similarity,
  isScored,
  isMatched: similarity !== undefined && similarity >= 90,
});

test("each player is scored on the rounds they guessed", () => {
  // Even rounds are about player 1, so player 2 guesses them.
  const rounds = [round(100), round(40), round(80), round(60), round(90), round(20)];
  const [p1, p2] = scaleGuesserScores(["p1", "p2"], rounds);
  assert.deepEqual(p1, { playerId: "p1", correct: 0, total: 3, percent: 40, bestStreak: 0 });
  assert.deepEqual(p2, { playerId: "p2", correct: 2, total: 3, percent: 90, bestStreak: 1 });
});

test("unscored rounds don't count against the guesser", () => {
  const rounds = [round(undefined, false), round(70), round(100), round(undefined, false)];
  const [p1, p2] = scaleGuesserScores(["p1", "p2"], rounds);
  assert.equal(p1.total, 1);
  assert.equal(p1.percent, 70);
  assert.equal(p2.total, 1);
  assert.equal(p2.percent, 100);
  assert.equal(p2.correct, 1);
});

test("a game with nothing scored is 0, not NaN", () => {
  const rounds = [round(undefined, false), round(undefined, false)];
  assert.equal(scaleGamePercentage(rounds), 0);
  const [p1, p2] = scaleGuesserScores(["p1", "p2"], rounds);
  assert.equal(p1.percent, 0);
  assert.equal(p2.percent, 0);
  assert.equal(scaleGamePercentage([]), 0);
});

test("streaks follow one guesser's own rounds", () => {
  // Player 2 guesses rounds 0, 2, 4, 6: hit, hit, miss, hit.
  const rounds = [round(95), round(10), round(92), round(10), round(50), round(10), round(100)];
  const [, p2] = scaleGuesserScores(["p1", "p2"], rounds);
  assert.equal(p2.bestStreak, 2);
  assert.equal(p2.correct, 3);
});

const settings = (mode: RoomSettings["mode"]): RoomSettings =>
  ({
    maxPlayers: 2,
    totalQuestions: 10,
    category: "scale",
    questionDuration: 15,
    resultDisplayDuration: 4,
    mode,
  }) as RoomSettings;

test("scale rounds get their own timings", () => {
  const q = question(["Calm", "Wild"]);
  assert.equal(getQuestionDuration(settings("scale"), q), 20);
  assert.equal(getResultDisplayDuration(settings("scale"), q), 7);
  const long = question(["Calm", "Wild"], {
    texts: { text_en: "x".repeat(300) } as Question["texts"],
  });
  assert.ok(getQuestionDuration(settings("scale"), long) > 20);
});

test("the finished game picks the better guesser and averages closeness", () => {
  const room = {
    players: [{ id: "p1" }, { id: "p2" }],
    settings: settings("scale"),
    completedRounds: [round(100), round(40), round(80), round(60)],
  } as unknown as Room;
  assert.equal(getGamePercentage(room), 70);
  const summary = summarizeGame(room, "scale", 70, []);
  assert.equal(summary.mode, "scale");
  assert.equal(summary.winnerId, "p2");
  assert.deepEqual(
    summary.players?.map((p) => [p.playerId, p.percent]),
    [
      ["p1", 50],
      ["p2", 90],
    ],
  );
});

test("equal guessers tie", () => {
  const room = {
    players: [{ id: "p1" }, { id: "p2" }],
    settings: settings("scale"),
    completedRounds: [round(80), round(80)],
  } as unknown as Room;
  assert.equal(summarizeGame(room, "scale", 80, []).winnerId, null);
});

test("a game cut short with one player left still summarizes", () => {
  const room = {
    players: [{ id: "p1" }],
    settings: settings("scale"),
    completedRounds: [round(80)],
  } as unknown as Room;
  const summary = summarizeGame(room, "scale", 80, []);
  assert.equal(summary.players?.length, 1);
  assert.equal(summary.winnerId, null);
});
