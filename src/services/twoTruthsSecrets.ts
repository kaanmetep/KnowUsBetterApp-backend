import { redis } from "../utils/redis.js";

// The room is sent to both players, so where each lie sits stays here until
// its guess round is over. Lives as long as a room.
const SECRETS_TTL_SECONDS = 10800;

const secretsKey = (roomCode: string) => `twoTruthsLies:${roomCode}`;
const field = (writeId: string, playerId: string) => `${writeId}:${playerId}`;

export async function saveLie(
  roomCode: string,
  writeId: string,
  playerId: string,
  lie: number,
): Promise<void> {
  const key = secretsKey(roomCode);
  const results = await redis
    .multi()
    .hset(key, field(writeId, playerId), String(lie))
    .expire(key, SECRETS_TTL_SECONDS)
    .exec();
  const failed = results?.find(([error]) => error)?.[0];
  if (failed) throw failed;
}

/** Each author's lie for this write round; authors with none stored are left out. */
export async function loadLies(
  roomCode: string,
  writeId: string,
  playerIds: string[],
): Promise<Record<string, number>> {
  if (!playerIds.length) return {};
  const values = await redis.hmget(
    secretsKey(roomCode),
    ...playerIds.map((playerId) => field(writeId, playerId)),
  );
  const lies: Record<string, number> = {};
  playerIds.forEach((playerId, i) => {
    const lie = Number(values[i]);
    if (values[i] !== null && Number.isInteger(lie)) lies[playerId] = lie;
  });
  return lies;
}
