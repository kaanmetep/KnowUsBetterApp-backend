import express from "express";

// Rate limiting storage: IP -> { count, resetTime }
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

/**
 * Get client IP from request
 */
function getClientIP(req: express.Request): string {
  const forwardedFor = req.headers["x-forwarded-for"] as string;
  const realIp = req.headers["x-real-ip"] as string;
  const remoteAddress = req.socket.remoteAddress || "";

  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  if (realIp) {
    return realIp.trim();
  }

  // IPv6 mapped IPv4 adresini temizle
  if (remoteAddress.startsWith("::ffff:")) {
    return remoteAddress.substring(7);
  }

  return remoteAddress || "unknown";
}

/**
 * Create a rate limiter middleware
 * @param maxRequests - Maximum number of requests
 * @param windowMs - Time window in milliseconds
 * @param message - Custom error message
 */
export function createRateLimiter(
  maxRequests: number,
  windowMs: number,
  message?: string
) {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    const ip = getClientIP(req);
    const now = Date.now();

    // Get or create rate limit entry for this IP
    const entry = rateLimitStore.get(ip);

    // Check if window has expired
    if (!entry || now > entry.resetTime) {
      // Create new entry
      rateLimitStore.set(ip, {
        count: 1,
        resetTime: now + windowMs,
      });

      // Cleanup old entries periodically (every 100 requests check)
      if (rateLimitStore.size % 100 === 0) {
        cleanupExpiredEntries(now);
      }

      return next();
    }

    // Check if limit exceeded
    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

      console.warn(
        `⚠️ Rate limit exceeded for IP ${ip}: ${entry.count}/${maxRequests} requests in ${windowMs}ms`
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
function cleanupExpiredEntries(now: number): void {
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
