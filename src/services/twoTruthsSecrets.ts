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

/** A player's lies follow their seat to a new socket id (see moveSeat). */
export async function renameLieAuthors(
  roomCode: string,
  renames: Record<string, string>,
): Promise<void> {
  const key = secretsKey(roomCode);
  const stored = await redis.hgetall(key);
  const multi = redis.multi();
  let changed = false;
  for (const [name, lie] of Object.entries(stored)) {
    const split = name.lastIndexOf(":");
    const to = renames[name.slice(split + 1)];
    if (split < 0 || !to) continue;
    multi.hset(key, field(name.slice(0, split), to), lie).hdel(key, name);
    changed = true;
  }
  if (changed) await multi.expire(key, SECRETS_TTL_SECONDS).exec();
}
