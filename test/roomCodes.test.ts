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
  assert.equal(moveSeat(room, "old", "new"), true);
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
  assert.equal(moveSeat(room, "a", "b"), false);
  assert.equal(moveSeat(room, "missing", "c"), false);
  assert.equal(moveSeat(room, "a", "a"), false);
  assert.deepEqual(room.players.map((p) => p.id), ["a", "b"]);
});
