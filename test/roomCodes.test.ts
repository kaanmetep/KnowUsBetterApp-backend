import assert from "node:assert/strict";
import test from "node:test";
import { localPartnerId, makeLocalPartner } from "../src/localPlay.js";
import {
  generateRoomCode,
  moveSeat,
  normalizeRoomCode,
  ROOM_CODE_CHARS,
} from "../src/roomCodes.js";
import type { Player, Room } from "../src/types.js";

test("new codes never use characters that read as one another", () => {
  for (const char of "IO10") assert.equal(ROOM_CODE_CHARS.includes(char), false);
  for (let i = 0; i < 500; i++) {
    const code = generateRoomCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/);
  }
});

test("a typed code is normalized only in ways that can't point at another room", () => {
  assert.equal(normalizeRoomCode(" ab2c "), "AB2C");
  // 0 was never in a code, so it can only be an O.
  assert.equal(normalizeRoomCode("N0Z4"), "NOZ4");
  // A Turkish keyboard capitalises i as İ; ı is a mistyped I too.
  assert.equal(normalizeRoomCode("İK5ı"), "IK5I");
  // Both are real characters in older codes.
  assert.equal(normalizeRoomCode("1I1I"), "1I1I");
  assert.equal(normalizeRoomCode("a-b c"), "ABC");
});

const player = (id: string, isHost: boolean): Player => ({
  id,
  name: id,
  avatar: "boy-1",
  isHost,
  hasAnswered: false,
});

const roomWith = (players: Player[]): Room =>
  ({ roomCode: "ABCD", status: "waiting", players }) as unknown as Room;

test("a seat moves to the player's new socket, with a partner on their phone", () => {
  const host = player("old", true);
  const room = roomWith([host, makeLocalPartner(host, "Ece", "girl-1")]);
  assert.deepEqual(moveSeat(room, "old", "new"), {
    old: "new",
    [localPartnerId("old")]: localPartnerId("new"),
  });
  assert.deepEqual(
    room.players.map((p) => [p.id, p.isHost, p.localOf]),
    [
      ["new", true, undefined],
      [localPartnerId("new"), false, "new"],
    ],
  );
});

test("a seat isn't moved onto a socket that already has one, or from one that has none", () => {
  const room = roomWith([player("a", true), player("b", false)]);
  assert.equal(moveSeat(room, "a", "b"), null);
  assert.equal(moveSeat(room, "missing", "c"), null);
  assert.equal(moveSeat(room, "a", "a"), null);
  assert.deepEqual(room.players.map((p) => p.id), ["a", "b"]);
});

test("mid-game, answers, grades and two_truths statements move with the seat", () => {
  const room = {
    roomCode: "ABCD",
    status: "playing",
    players: [player("old", true), player("b", false)],
    questions: [
      { id: "w", twoTruths: { phase: "write", turn: 0 } },
      { id: "g", twoTruths: { phase: "guess", turn: 0, writeId: "w", statements: { old: ["x"], b: null } } },
    ],
    currentRound: {
      question: { id: "g", twoTruths: { phase: "guess", turn: 0, writeId: "w", statements: { old: ["x"], b: null } } },
      answers: { old: "1", b: null },
      isMatched: null,
      status: "waiting_answers",
    },
    completedRounds: [
      { question: { id: "q1" }, answers: { old: "yes", b: "no" }, correct: { old: true, b: false }, lies: { old: 2 }, isMatched: false, status: "completed" },
    ],
  } as unknown as Room;
  assert.deepEqual(moveSeat(room, "old", "new"), { old: "new" });
  assert.deepEqual(room.currentRound!.answers, { new: "1", b: null });
  assert.deepEqual(room.currentRound!.question.twoTruths, {
    phase: "guess", turn: 0, writeId: "w", statements: { new: ["x"], b: null },
  });
  assert.deepEqual(room.completedRounds[0].answers, { new: "yes", b: "no" });
  assert.deepEqual(room.completedRounds[0].correct, { new: true, b: false });
  assert.deepEqual(room.completedRounds[0].lies, { new: 2 });
  const guess = room.questions[1].twoTruths;
  assert.deepEqual(guess?.phase === "guess" && guess.statements, { new: ["x"], b: null });
});
