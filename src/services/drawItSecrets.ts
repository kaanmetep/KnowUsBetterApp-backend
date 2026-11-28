import { redis } from "../utils/redis.js";
import type { DrawSecret, Seat } from "../utils/draw.js";
import type { MultiLanguageAnswer } from "../types.js";

// draw: each drawer's secret word and where it sits among the shuffled
// options. The room is sent to both players, so it stays here. Kept by seat,
// which survives a reconnect. Lives as long as a room.
const SECRETS_TTL_SECONDS = 10800;

const key = (roomCode: string) => `drawItWords:${roomCode}`;
const field = (drawId: string, seat: Seat) => `${drawId}:${seat}`;

export async function saveDrawSecrets(roomCode: string, secrets: DrawSecret[]): Promise<void> {
  const multi = redis.multi().del(key(roomCode));
  for (const secret of secrets) {
    multi.hset(
      key(roomCode),
      field(secret.drawId, secret.seat),
      JSON.stringify({ correct: secret.correct, word: secret.word }),
    );
  }
  const results = await multi.expire(key(roomCode), SECRETS_TTL_SECONDS).exec();
  const failed = results?.find(([error]) => error)?.[0];
  if (failed) throw failed;
}

type Stored = { correct: number; word: MultiLanguageAnswer };

function parse(value: string | null): Stored | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Number.isInteger(parsed?.correct) && parsed?.word ? parsed : null;
  } catch {
    return null;
  }
}

/** The word a seat draws this turn, or null when it isn't known. */
export async function loadDrawWord(
  roomCode: string,
  drawId: string,
  seat: Seat,
): Promise<MultiLanguageAnswer | null> {
  return parse(await redis.hget(key(roomCode), field(drawId, seat)))?.word ?? null;
}

/** Where each drawer's word sits among their options: [seat 0's, seat 1's]. */
export async function loadDrawAnswers(
  roomCode: string,
  drawId: string,
): Promise<[number | null, number | null]> {
  const [a, b] = await redis.hmget(key(roomCode), field(drawId, 0), field(drawId, 1));
  return [parse(a)?.correct ?? null, parse(b)?.correct ?? null];
}
