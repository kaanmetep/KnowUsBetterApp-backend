import { Socket } from "socket.io";

// IP bazlı socket sayısı limiti
// MAX_SOCKETS_PER_IP: IP başına maximum socket sayısı (default: 10)
const MAX_SOCKETS_PER_IP =
  parseInt(process.env.MAX_SOCKETS_PER_IP || "10", 10) || 10;

// IP -> socket ID'ler mapping
const ipSocketMap = new Map<string, Set<string>>(); // IP -> Set<socket.id>

// Socket ID -> IP mapping (cleanup için)
const socketIpMap = new Map<string, string>(); // socket.id -> IP

/**
 * Get client IP from socket
 */
export function getClientIP(socket: Socket): string {
  const req = socket.request;
  const forwardedFor = req.headers["x-forwarded-for"] as string;
  const realIp = req.headers["x-real-ip"] as string;
  const remoteAddress = req.socket.remoteAddress || "";

  // X-Forwarded-For'dan ilk IP'yi al (proxy arkasındaysa)
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  // X-Real-IP varsa onu kullan
  if (realIp) {
    return realIp.trim();
  }

  // IPv6 mapped IPv4 adresini temizle (::ffff:127.0.0.1 -> 127.0.0.1)
  if (remoteAddress.startsWith("::ffff:")) {
    return remoteAddress.substring(7);
  }

  return remoteAddress || "unknown";
}

/**
 * Check if IP can create a new socket connection
 */
export function canCreateSocket(ip: string): {
  allowed: boolean;
  reason?: string;
} {
  const socketsForIp = ipSocketMap.get(ip) || new Set<string>();

  if (socketsForIp.size >= MAX_SOCKETS_PER_IP) {
    return {
      allowed: false,
      reason: `Maximum ${MAX_SOCKETS_PER_IP} socket connections per IP exceeded`,
    };
  }

  return { allowed: true };
}

/**
 * Register a new socket connection for an IP
 */
export function registerSocket(socketId: string, ip: string): void {
  if (!ipSocketMap.has(ip)) {
    ipSocketMap.set(ip, new Set<string>());
  }

  ipSocketMap.get(ip)!.add(socketId);
  socketIpMap.set(socketId, ip);

  const count = ipSocketMap.get(ip)!.size;
  if (count > MAX_SOCKETS_PER_IP * 0.8) {
    // Warn when approaching limit (80% of max)
    console.warn(
      `⚠️ IP ${ip} has ${count}/${MAX_SOCKETS_PER_IP} socket connections (80% limit)`
    );
  }
}

/**
 * Unregister a socket connection when it disconnects
 */
export function unregisterSocket(socketId: string): void {
  const ip = socketIpMap.get(socketId);
  if (!ip) {
    return;
  }

  const socketsForIp = ipSocketMap.get(ip);
  if (socketsForIp) {
    socketsForIp.delete(socketId);

    // Cleanup empty IP entries
    if (socketsForIp.size === 0) {
      ipSocketMap.delete(ip);
    }
  }

  socketIpMap.delete(socketId);
}

/**
 * Get socket count for an IP
 */
export function getSocketCountForIP(ip: string): number {
  return ipSocketMap.get(ip)?.size || 0;
}

/**
 * Get all IPs with their socket counts (for monitoring)
 */
export function getAllIPStats(): Map<string, number> {
  const stats = new Map<string, number>();
  ipSocketMap.forEach((sockets, ip) => {
    stats.set(ip, sockets.size);
  });
  return stats;
}
