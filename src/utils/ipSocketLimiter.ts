import { Socket } from "socket.io";
import { getRequestIP } from "./clientIp.js";

// IP bazlı socket sayısı limiti
// Mobile carriers put many subscribers behind one public IP (CGNAT), so this
// only stops floods, not ordinary players sharing an address.
const MAX_SOCKETS_PER_IP =
  parseInt(process.env.MAX_SOCKETS_PER_IP || "100", 10) || 100;

// IP -> socket ID'ler mapping
const ipSocketMap = new Map<string, Set<string>>(); // IP -> Set<socket.id>

// Socket ID -> IP mapping (cleanup için)
const socketIpMap = new Map<string, string>(); // socket.id -> IP

/**
 * Get client IP from socket
 */
export function getClientIP(socket: Socket): string {
  return getRequestIP(socket.request);
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
