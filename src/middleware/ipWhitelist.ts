import express from "express";

// Get allowed IPs from environment variable (comma-separated)
// Example: ALLOWED_IPS=127.0.0.1,192.168.1.1,10.0.0.1
const ALLOWED_IPS = process.env.ALLOWED_IPS
  ? process.env.ALLOWED_IPS.split(",").map((ip) => ip.trim())
  : [];

// Middleware to check IP whitelist
export function ipWhitelistMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  // If no whitelist configured, allow all (for development)
  if (ALLOWED_IPS.length === 0) {
    return next();
  }

  // Get client IP (consider X-Forwarded-For header if behind proxy)
  let clientIp =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    (req.headers["x-real-ip"] as string) ||
    req.socket.remoteAddress ||
    req.ip;

  // Normalize IPv6 localhost to IPv4
  if (clientIp === "::1" || clientIp === "::ffff:127.0.0.1") {
    clientIp = "127.0.0.1";
  }

  // Check if IP is in whitelist
  if (clientIp && ALLOWED_IPS.includes(clientIp)) {
    return next();
  }

  // IP not in whitelist
  console.warn(`⚠️ Unauthorized health check access attempt from: ${clientIp}`);
  res.status(403).json({
    status: "forbidden",
    message: "Access denied",
  });
}
