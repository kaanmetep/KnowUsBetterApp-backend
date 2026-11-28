import { randomBytes } from "crypto";
import { redis } from "../utils/redis.js";
import { DRAWING_ID } from "../utils/draw.js";

/**
 * Drawings (draw mode) are kept out of the room: the room is written to Redis
 * and broadcast through the socket.io stream on every change, and a drawing
 * is a few KB. Here each drawing has its own key, and the apps fetch them
 * with an acknowledged request, which never goes through the stream.
 *
 * Long enough to look through the finish screen's gallery after the game; the
 * apps keep their own copy afterwards.
 */
const DRAWING_TTL_SECONDS = 2 * 60 * 60;
const MAX_IDS_PER_REQUEST = 40;

const key = (id: string) => `drawing:${id}`;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function newId(): string {
  const bytes = randomBytes(12);
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

/** Stores a (validated) drawing and returns its id. */
export async function saveDrawing(drawing: string): Promise<string> {
  const id = newId();
  await redis.set(key(id), drawing, "EX", DRAWING_TTL_SECONDS);
  return id;
}

/** The drawings still stored, by id; unknown or expired ids are left out. */
export async function loadDrawings(ids: unknown): Promise<Record<string, string>> {
  if (!Array.isArray(ids)) return {};
  const wanted = [
    ...new Set(ids.filter((id): id is string => typeof id === "string" && DRAWING_ID.test(id))),
  ].slice(0, MAX_IDS_PER_REQUEST);
  if (!wanted.length) return {};
  const values = await redis.mget(...wanted.map(key));
  const drawings: Record<string, string> = {};
  wanted.forEach((id, i) => {
    const value = values[i];
    if (typeof value === "string") drawings[id] = value;
  });
  return drawings;
}
