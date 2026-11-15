import { Player, Room } from "./types.js";

/**
 * Single-phone mode: the partner sits next to the host and plays on the
 * host's phone. They are a regular player in the room (so scoring, results
 * and every mode work unchanged) whose answers the host's socket sends.
 */

/** Never a socket.io id, so it can't collide with a real player's. */
export const localPartnerId = (hostSocketId: string) => `${hostSocketId}#local`;

/** The socket that plays for this player. */
export const deviceOf = (player: Player): string => player.localOf ?? player.id;

export const isLocalRoom = (room: Pick<Room, "players">): boolean =>
  room.players.some((player) => !!player.localOf);

/** The partner for the host's phone; they share the host's app, so its features. */
export function makeLocalPartner(host: Player, name: string, avatar: string): Player {
  return {
    id: localPartnerId(host.id),
    name,
    avatar,
    isHost: false,
    hasAnswered: false,
    supportsTextQuestions: host.supportsTextQuestions,
    supportsServerCoins: host.supportsServerCoins,
    supportsWhoIsMoreLikely: host.supportsWhoIsMoreLikely,
    supportsReactions: false,
    supportsRankIt: host.supportsRankIt,
    supportsDailyAnalysis: host.supportsDailyAnalysis,
    supportsTwoTruths: host.supportsTwoTruths,
    localOf: host.id,
  };
}

/**
 * Who a socket's answer (or consent) is for: itself, or a partner on its
 * phone when it names one. Null when it names a player it doesn't play for.
 */
export function actingPlayerId(
  room: Pick<Room, "players">,
  socketId: string,
  requested: unknown,
): string | null {
  if (requested === undefined || requested === null || requested === socketId) {
    return socketId;
  }
  if (typeof requested !== "string") return null;
  const player = room.players.find((p) => p.id === requested);
  return player?.localOf === socketId ? player.id : null;
}

// Time for the phone to change hands and the partner to get ready.
const HANDOFF_SECONDS = 90;

/** On one phone the two players answer one after the other. */
export const localRoundSeconds = (questionSeconds: number) =>
  questionSeconds * 2 + HANDOFF_SECONDS;
