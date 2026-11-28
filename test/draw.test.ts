import assert from "node:assert/strict";
import { test } from "node:test";
import { getQuestionDuration, getResultDisplayDuration } from "../src/utils/helpers.ts";
import { getGamePercentage, summarizeGame } from "../src/services/finishedGames.ts";
import { pickNextQuestion } from "../src/nextQuestion.ts";
import {
  buildDrawRounds,
  DRAW_GUESS_SECONDS,
  DRAW_GRID,
  DRAW_MAX_LENGTH,
  DRAW_MAX_POINTS,
  drawingIdOf,
  drawingRef,
  drawScores,
  DRAW_POINTS_PER_GUESS,
  isDrawWord,
  parseDrawGuess,
  parseDrawing,
  scoreGuessRound,
} from "../src/utils/draw.ts";
import type { Question, QuestionRound, Room, RoomSettings } from "../src/types.ts";

const ref = drawingRef("AbCdEf123456");
const ref2 = drawingRef("ZZZZzzzz0000");

test("parseDrawing keeps well-formed drawings", () => {
  assert.equal(parseDrawing("00:500,500"), "00:500,500");
  assert.equal(parseDrawing(" 31:10,10;5,-3;0,0 "), "31:10,10;5,-3;0,0");
  assert.equal(parseDrawing("00:0,0|e2:999,999;-10,-10"), "00:0,0|e2:999,999;-10,-10");
});

test("parseDrawing rejects anything else", () => {
  for (const bad of [
    undefined,
    null,
    42,
    "",
    "00:",
    "0:1,1",
    "a0:1,1",
    "03:1,1",
    "00:1,1;",
    "00:1.5,1",
    "00:-1,5",
    `00:${DRAW_GRID},5`,
    "00:999,999;1,0",
    "00:1,1||00:2,2",
    "<script>",
  ]) {
    assert.equal(parseDrawing(bad), null, String(bad));
  }
});

test("parseDrawing caps the size", () => {
  const points = Array.from({ length: DRAW_MAX_POINTS }, (_, i) => (i === 0 ? "1,1" : "0,0"));
  assert.ok(parseDrawing(`00:${points.join(";")}`));
  assert.equal(parseDrawing(`00:${points.join(";")};0,0`), null);
  assert.equal(parseDrawing(`00:${"1,1;0,0;".repeat(DRAW_MAX_LENGTH / 8)}1,1`), null);
});

test("drawing references", () => {
  assert.equal(drawingIdOf(ref), "AbCdEf123456");
  assert.equal(drawingIdOf("d:short"), null);
  assert.equal(drawingIdOf("AbCdEf123456"), null);
  assert.equal(drawingIdOf(null), null);
});

test("guesses are an option and a time", () => {
  assert.equal(parseDrawGuess("2:5400"), "2:5400");
  assert.equal(parseDrawGuess(" 0:0 "), "0:0");
  // One phone has no clock: a slow guess is still a guess.
  assert.equal(parseDrawGuess("3:999999"), "3:999999");
  assert.equal(parseDrawGuess("1:0042"), "1:42");
  for (const bad of ["4:100", "-1:100", "1", "1:", ":100", "1:2:3", "a:1", "1:1.5", 2, null, ""]) {
    assert.equal(parseDrawGuess(bad), null, String(bad));
  }
});

test("a right guess scores the same however long it took", () => {
  const quick = scoreGuessRound(["2:500", "1:0"], [1, 2], [true, true]);
  const slow = scoreGuessRound(["2:29000", "1:600000"], [1, 2], [true, true]);
  assert.deepEqual(quick.points, [DRAW_POINTS_PER_GUESS, DRAW_POINTS_PER_GUESS]);
  assert.deepEqual(slow.points, quick.points);
});

const word = (id: string, en: string[]): Question =>
  ({
    id,
    texts: { text_en: "Food" },
    category: "draw",
    haveAnswers: true,
    answers: { answers_en: en, answers_tr: en.map((w) => `${w}-tr`) },
    questionType: "choice",
  }) as unknown as Question;

const words = [
  word("w1", ["pizza", "cookie", "pie", "pancake"]),
  word("w2", ["cat", "fox", "dog", "raccoon"]),
  word("w3", ["kite", "plane", "bird", "rocket"]),
  word("w4", ["ring", "donut", "tire", "bracelet"]),
];

test("only four-option multiple-choice questions are words", () => {
  assert.ok(isDrawWord(words[0]));
  assert.ok(!isDrawWord(word("x", ["a", "b", "c"])));
  assert.ok(!isDrawWord({ ...words[0], questionType: "text" } as Question));
});

test("words pair into a draw and a guess round per turn, the answer kept apart", () => {
  let seed = 0.37;
  const random = () => (seed = (seed * 9301 + 0.49297) % 1);
  const { rounds, secrets } = buildDrawRounds(words, random);
  assert.equal(rounds.length, 4);
  assert.deepEqual(
    rounds.map((r) => r.drawIt?.phase),
    ["draw", "guess", "draw", "guess"],
  );
  const draw = rounds[0].drawIt!;
  const guess = rounds[1].drawIt!;
  assert.equal(draw.phase, "draw");
  assert.equal(guess.phase, "guess");
  if (draw.phase !== "draw" || guess.phase !== "guess") return;
  assert.deepEqual(draw.wordIds, ["w1", "w2"]);
  assert.equal(guess.drawId, rounds[0].id);
  // Nothing on the rounds says which option is the word.
  assert.equal(rounds[0].answers, null);
  assert.ok(!JSON.stringify(rounds).includes('"correct"'));
  // Each seat's options are its word plus the look-alikes, in some order.
  for (const seat of [0, 1] as const) {
    const options = guess.options[seat].map((o) => o.en);
    assert.deepEqual([...options].sort(), [...words[seat].answers!.answers_en].sort());
    const secret = secrets.find((s) => s.drawId === rounds[0].id && s.seat === seat)!;
    assert.equal(options[secret.correct], words[seat].answers!.answers_en[0]);
    assert.equal(secret.word.en, words[seat].answers!.answers_en[0]);
    assert.equal(secret.word.tr, `${words[seat].answers!.answers_en[0]}-tr`);
    // A language without a translation shows English.
    assert.equal(secret.word.ja, secret.word.en);
  }
  assert.equal(secrets.length, 4);
});

test("an odd word out is dropped", () => {
  assert.equal(buildDrawRounds(words.slice(0, 3)).rounds.length, 2);
});

test("guess rounds score each guesser, blank pages aren't scored", () => {
  // Seat 0 guesses seat 1's word (option 2), seat 1 guesses seat 0's (option 1).
  const both = scoreGuessRound(["2:3000", "1:0"], [1, 2], [true, true]);
  assert.deepEqual(both.right, [true, true]);
  assert.deepEqual(both.points, [100, 100]);
  assert.equal(both.scored, true);

  const wrong = scoreGuessRound(["0:3000", "3:0"], [1, 2], [true, true]);
  assert.deepEqual(wrong.points, [0, 0]);
  assert.deepEqual(wrong.right, [false, false]);

  // Seat 1 drew nothing: seat 0 had nothing to guess.
  const blank = scoreGuessRound(["2:0", "1:0"], [1, 2], [true, false]);
  assert.deepEqual(blank.points, [0, 100]);
  assert.equal(blank.scored, true);
  assert.equal(scoreGuessRound(["", ""], [1, 2], [false, false]).scored, false);

  // No guess, or the answer unknown: 0.
  assert.deepEqual(scoreGuessRound(["", "junk"], [1, 2], [true, true]).points, [0, 0]);
  assert.deepEqual(scoreGuessRound(["2:0", "1:0"], [null, null], [true, true]).points, [0, 0]);
});

test("the guess round picks up both drawings; a turn nobody drew in is skipped", () => {
  const { rounds } = buildDrawRounds(words);
  const players = [{ id: "p1" }, { id: "p2" }] as Room["players"];
  const room = { questions: rounds, currentQuestionIndex: 0, players };
  const next = pickNextQuestion(room, { answers: { p1: ref, p2: "" } });
  assert.equal(next?.index, 1);
  const info = next?.question.drawIt;
  assert.equal(info?.phase, "guess");
  if (info?.phase === "guess") assert.deepEqual(info.drawings, [ref, null]);
  // The stored room question isn't changed.
  const stored = rounds[1].drawIt;
  assert.equal(stored?.phase === "guess" ? stored.drawings : "x", undefined);

  const skip = pickNextQuestion(room, { answers: { p1: "", p2: "" } });
  assert.equal(skip?.index, 2);
  assert.equal(skip?.question.drawIt?.phase, "draw");

  // Last turn blank: the game ends.
  const last = pickNextQuestion({ ...room, currentQuestionIndex: 2 }, { answers: { p1: "", p2: "" } });
  assert.equal(last, null);
});

const settings = { mode: "draw", questionDuration: 15, resultDisplayDuration: 4 } as RoomSettings;

test("draw and guess rounds get their own timings", () => {
  const { rounds } = buildDrawRounds(words);
  assert.equal(getQuestionDuration(settings, rounds[0]), 50);
  assert.equal(getResultDisplayDuration(settings, rounds[0]), 0);
  assert.equal(getQuestionDuration(settings, rounds[1]), DRAW_GUESS_SECONDS);
  assert.equal(getResultDisplayDuration(settings, rounds[1]), 10);
});

const guessRound = (
  drawings: [string | null, string | null],
  points: [number, number],
): QuestionRound =>
  ({
    status: "completed",
    question: { drawIt: { phase: "guess", turn: 0, drawId: "d", options: [[], []], drawings } },
    drawReveal: { correct: [0, 0], points },
  }) as unknown as QuestionRound;

const drawRound = { status: "completed", question: { drawIt: { phase: "draw" } } } as unknown as QuestionRound;

test("the finished game counts each player's guesses as a team, no winner", () => {
  const rounds = [
    drawRound,
    guessRound([ref, ref2], [90, 0]),
    drawRound,
    guessRound([ref, ref2], [70, 100]),
    drawRound,
    // p2 drew nothing: p1 had nothing to guess.
    guessRound([ref, null], [0, 0]),
  ];
  const scores = drawScores(["p1", "p2"], rounds);
  assert.deepEqual(
    scores.map((s) => [s.playerId, s.correct, s.total, s.points, s.bestStreak]),
    [
      ["p1", 2, 2, 160, 2],
      ["p2", 1, 3, 100, 1],
    ],
  );
  const room = {
    players: [{ id: "p1" }, { id: "p2" }],
    settings,
    completedRounds: rounds,
  } as unknown as Room;
  assert.equal(getGamePercentage(room), 60);
  const summary = summarizeGame(room, "draw", 60, []);
  assert.equal(summary.winnerId, null);
  assert.equal(summary.players?.reduce((sum, p) => sum + (p.points ?? 0), 0), 260);
});
