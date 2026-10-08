import type { IncomingMessage } from "http";

// Render sits behind Cloudflare, which always overwrites this header with the
// address it saw. X-Forwarded-For starts with whatever the client sent, so it
// is only a fallback for setups without Cloudflare (e.g. local development).
const TRUSTED_IP_HEADER = "cf-connecting-ip";

let loggedSource = false;

export function getRequestIP(req: IncomingMessage): string {
  const trusted = req.headers[TRUSTED_IP_HEADER];
  const forwardedFor = req.headers["x-forwarded-for"];
  let ip: string | undefined;
  let source: string;

  if (typeof trusted === "string" && trusted.trim()) {
    ip = trusted.trim();
    source = TRUSTED_IP_HEADER;
  } else if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    ip = forwardedFor.split(",")[0].trim();
    source = "x-forwarded-for";
  } else {
    ip = req.socket.remoteAddress || undefined;
    source = "socket";
  }

  if (!loggedSource) {
    loggedSource = true;
    console.log(`🌐 Client IPs are read from: ${source}`);
  }

  if (!ip) return "unknown";
  if (ip.startsWith("::ffff:")) return ip.substring(7);
  if (ip === "::1") return "127.0.0.1";
  return ip;
}
