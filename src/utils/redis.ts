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

// Graceful shutdown - close Redis connection
process.on("SIGTERM", () => {
  redis.quit();
});

process.on("SIGINT", () => {
  redis.quit();
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
