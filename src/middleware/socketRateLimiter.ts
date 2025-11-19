import { Socket } from "socket.io";

type RateLimitEntry = {
  count: number;
  resetTime: number;
};

const DEFAULT_EVENT_LIMIT =
  parseInt(process.env.SOCKET_EVENT_LIMIT || "120", 10) || 120;
const DEFAULT_EVENT_WINDOW_MS =
  parseInt(process.env.SOCKET_EVENT_WINDOW_MS || "60000", 10) || 60000;

// Socket.id -> rate limit counters
const socketRateLimitStore = new Map<string, RateLimitEntry>();

function getEntry(socketId: string, windowMs: number, now: number) {
  const entry = socketRateLimitStore.get(socketId);

  if (!entry || now > entry.resetTime) {
    const newEntry = {
      count: 0,
      resetTime: now + windowMs,
    };
    socketRateLimitStore.set(socketId, newEntry);
    return newEntry;
  }

  return entry;
}

export function attachSocketRateLimiter(
  socket: Socket,
  options?: { maxEvents?: number; windowMs?: number }
): void {
  const limit = options?.maxEvents ?? DEFAULT_EVENT_LIMIT;
  const windowMs = options?.windowMs ?? DEFAULT_EVENT_WINDOW_MS;

  socket.use((packet, next) => {
    const now = Date.now();
    const entry = getEntry(socket.id, windowMs, now);

    if (entry.count >= limit) {
      const retryAfter = Math.max(0, Math.ceil((entry.resetTime - now) / 1000));

      socket.emit("rate-limit", {
        code: "SOCKET_RATE_LIMIT_EXCEEDED",
        message:
          "You're sending actions too quickly. Please slow down and try again.",
        retryAfter,
      });

      console.warn(
        `⚠️ Socket event rate limit exceeded for ${socket.id}: ${entry.count}/${limit} in ${windowMs}ms.`
      );
      return;
    }

    entry.count += 1;
    next();
  });

  socket.on("disconnect", () => {
    socketRateLimitStore.delete(socket.id);
  });
}
