import express from "express";
import { getRequestIP } from "../utils/clientIp.js";

type RateLimitStore = Map<string, { count: number; resetTime: number }>;

/**
 * Counts per player instead of per IP when the request names one, so players
 * sharing a carrier IP don't use up each other's quota. Only for routes where
 * a made-up id gains nothing (they still need the id's coins or token).
 */
export const byAppUserId =
  (getAppUserId: (req: express.Request) => unknown) =>
  (req: express.Request): string => {
    const appUserId = getAppUserId(req);
    return typeof appUserId === "string" && appUserId.trim()
      ? `user:${appUserId.trim()}`
      : `ip:${getRequestIP(req)}`;
  };

/**
 * Create a rate limiter middleware
 * @param maxRequests - Maximum number of requests
 * @param windowMs - Time window in milliseconds
 * @param message - Custom error message
 * @param keyOf - What to count by (default: client IP)
 */
export function createRateLimiter(
  maxRequests: number,
  windowMs: number,
  message?: string,
  keyOf: (req: express.Request) => string = getRequestIP
) {
  // Rate limiting storage per limiter: key -> { count, resetTime }
  const rateLimitStore: RateLimitStore = new Map();

  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    const key = keyOf(req);
    const now = Date.now();

    const entry = rateLimitStore.get(key);

    // Check if window has expired
    if (!entry || now > entry.resetTime) {
      // Create new entry
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });

      // Cleanup old entries periodically (every 100 requests check)
      if (rateLimitStore.size % 100 === 0) {
        cleanupExpiredEntries(rateLimitStore, now);
      }

      return next();
    }

    // Check if limit exceeded
    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

      console.warn(
        `⚠️ Rate limit exceeded for ${key}: ${entry.count}/${maxRequests} requests in ${windowMs}ms`
      );

      res.status(429).json({
        status: "error",
        message: message || "Too many requests, please try again later",
        retryAfter: retryAfter, // seconds until retry
      });

      return;
    }

    // Increment count
    entry.count++;

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", maxRequests.toString());
    res.setHeader(
      "X-RateLimit-Remaining",
      Math.max(0, maxRequests - entry.count).toString()
    );
    res.setHeader("X-RateLimit-Reset", new Date(entry.resetTime).toISOString());

    next();
  };
}

/**
 * Cleanup expired entries from rate limit store
 */
function cleanupExpiredEntries(rateLimitStore: RateLimitStore, now: number): void {
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(ip);
    }
  }
}

/**
 * Health endpoint için rate limiter
 * DEFAULT: 100 requests per 15 minutes
 */
export const healthRateLimiter = createRateLimiter(
  parseInt(process.env.HEALTH_RATE_LIMIT_MAX || "100", 10),
  parseInt(process.env.HEALTH_RATE_LIMIT_WINDOW_MS || "900000", 10), // 15 minutes
  "Too many health check requests, please try again later"
);

/**
 * RevenueCat webhook endpoint için rate limiter
 * DEFAULT: 500 requests per 5 minutes (allows bursts but prevents abuse)
 * This is more practical than hourly limits for webhook traffic
 */
export const webhookRateLimiter = createRateLimiter(
  parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX || "500", 10),
  parseInt(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS || "300000", 10), // 5 minutes
  "Too many webhook requests, please try again later"
);
