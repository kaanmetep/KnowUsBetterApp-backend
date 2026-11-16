import { localPartnerId } from "./localPlay.js";
import type { Room } from "./types.js";

export const ROOM_CODE_LENGTH = 4;

// Letters and digits that can't be read as one another: no I/1 and no O/0.
// Older rooms (I, O and 1 were allowed until 2026-11) still join as typed.
export const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS[Math.floor(random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

/**
 * The code a player typed, as rooms are stored. Only changes that can't point
 * at a different room: case, spaces, a Turkish İ, and 0, which no code has
 * ever contained (so it can only be a mistyped O). 1 and I are both real
 * characters in older codes, so they're left as typed.
 */
export function normalizeRoomCode(raw: string): string {
  return raw
    .trim()
    .replace(/İ/g, "I")
    .toLocaleUpperCase("en-US")
    .replace(/0/g, "O")
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Gives a player's seat to their new socket id, along with a partner who
 * plays on their phone. Returns false (and leaves the room as it was) when
 * the old id has no seat or the new one already has one.
 */
export function moveSeat(room: Room, fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  if (!room.players.some((p) => p.id === fromId)) return false;
  if (room.players.some((p) => p.id === toId)) return false;
  for (const player of room.players) {
    if (player.id === fromId) player.id = toId;
    if (player.localOf === fromId) {
      player.localOf = toId;
      player.id = localPartnerId(toId);
    }
  }
  return true;
}
