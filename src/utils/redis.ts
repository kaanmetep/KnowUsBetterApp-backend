import { randomUUID } from "crypto";
import Redis from "ioredis";

// Create Redis client
// Get Redis URL from environment variables, if not set, use default localhost
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const redis = new Redis(redisUrl, {
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: false,
});

// Redis connection events
redis.on("connect", () => {
  console.log("✅ Redis connected");
});

redis.on("ready", () => {
  console.log("✅ Redis ready");
});

redis.on("error", (err: Error) => {
  console.error("❌ Redis error:", err);
});

redis.on("close", () => {
  console.warn("⚠️ Redis connection closed");
});

redis.on("reconnecting", () => {
  console.log("🔄 Redis reconnecting...");
});

/**
 * Acquire a distributed lock using Redis
 * Returns true if lock acquired, false otherwise
 */
export async function acquireLock(
  lockKey: string,
  ttlSeconds: number = 10
): Promise<boolean> {
  try {
    const result = await redis.set(lockKey, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  } catch (error) {
    console.error("Error acquiring lock:", error);
    return false;
  }
}

/**
 * Release a distributed lock
 */
export async function releaseLock(lockKey: string): Promise<void> {
  try {
    await redis.del(lockKey);
  } catch (error) {
    console.error("Error releasing lock:", error);
  }
}

export class LockTimeoutError extends Error {
  constructor(readonly lockKey: string) {
    super(`Timed out waiting for lock ${lockKey}`);
  }
}

// Deletes the lock only while it still holds our token, so a holder that
// outlived its TTL can't release someone else's lock.
const RELEASE_OWNED_LOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding `lockKey`, waiting up to `waitMs` for it.
 * Throws LockTimeoutError if the lock stays taken.
 */
export async function withLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
  { ttlSeconds = 10, waitMs = 5000, retryMs = 50 } = {},
): Promise<T> {
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  while ((await redis.set(lockKey, token, "EX", ttlSeconds, "NX")) !== "OK") {
    if (Date.now() >= deadline) throw new LockTimeoutError(lockKey);
    await sleep(retryMs);
  }
  try {
    return await fn();
  } finally {
    await redis
      .eval(RELEASE_OWNED_LOCK, 1, lockKey, token)
      .catch((error) => console.error("Error releasing lock:", error));
  }
}
