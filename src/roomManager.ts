import { Room, Player, JoinRoomResult, Category, GameMode } from "./types.js";
import { redis, withLock } from "./utils/redis.js";

// Redis key patterns
const ROOM_KEY_PREFIX = "room:";
const PLAYER_ROOM_KEY_PREFIX = "playerRoom:";

// Room TTL (Time To Live) - 3 hours (10800 seconds)
const ROOM_TTL = 10800;

export class RoomManager {
  constructor() {
    // Redis client is already initialized in utils/redis.ts
  }

  private getRoomKey(roomCode: string): string {
    return `${ROOM_KEY_PREFIX}${roomCode}`;
  }

  /**
   * Every read-modify-write of a room runs inside this, so concurrent events
   * (join, leave, answers, timers) can't overwrite each other's changes.
   * Not reentrant: don't call it again from inside `fn`.
   */
  withRoomLock<T>(roomCode: string, fn: () => Promise<T>): Promise<T> {
    return withLock(`lock:room:${roomCode}`, fn);
  }

  private getPlayerRoomKey(socketId: string): string {
    return `${PLAYER_ROOM_KEY_PREFIX}${socketId}`;
  }

  /**
   * Safely parse room data from Redis with validation
   * Returns null if parsing fails or data is invalid
   */
  private parseRoom(roomData: string): Room | null {
    try {
      const parsed = JSON.parse(roomData);

      // Validate required fields
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.roomCode !== "string" ||
        !Array.isArray(parsed.players) ||
        !parsed.settings ||
        typeof parsed.settings !== "object" ||
        typeof parsed.status !== "string" ||
        typeof parsed.createdAt !== "number"
      ) {
        console.error("❌ Invalid room structure:", {
          hasRoomCode: typeof parsed?.roomCode === "string",
          hasPlayers: Array.isArray(parsed?.players),
          hasSettings: typeof parsed?.settings === "object",
          hasStatus: typeof parsed?.status === "string",
          hasCreatedAt: typeof parsed?.createdAt === "number",
        });
        return null;
      }

      return parsed as Room;
    } catch (error) {
      console.error("❌ Failed to parse room data:", error);
      if (error instanceof SyntaxError) {
        console.error("   Invalid JSON format in Redis");
      }
      return null;
    }
  }

  generateRoomCode(): string {
    // English alphabet letters (A-Z) and 1-9 numbers
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
    let code = "";

    // Create a 4-digit random code
    for (let i = 0; i < 4; i++) {
      const randomIndex = Math.floor(Math.random() * chars.length);
      code += chars[randomIndex];
    }

    return code;
  }

  /**
   * Writes the room and extends its players' room mappings along with it, so
   * a long session in one room can't outlive the mappings.
   */
  private async saveRoom(room: Room): Promise<void> {
    const pipeline = redis
      .multi()
      .setex(this.getRoomKey(room.roomCode), ROOM_TTL, JSON.stringify(room));
    for (const player of room.players) {
      pipeline.expire(this.getPlayerRoomKey(player.id), ROOM_TTL);
    }
    const results = await pipeline.exec();
    const failed = results?.find(([error]) => error)?.[0];
    if (failed) throw failed;
  }

  // Create a new room
  async createRoom(
    socketId: string,
    playerName: string,
    avatar: string,
    category: Category,
    supportsTextQuestions = false,
    supportsServerCoins = false,
    mode: GameMode = "see_your_match"
  ): Promise<Room> {
    const player: Player = {
      id: socketId,
      name: playerName,
      avatar: avatar,
      isHost: true,
      hasAnswered: false,
      supportsTextQuestions,
      supportsServerCoins,
    };

    const room: Room = {
      roomCode: "",
      createdAt: Date.now(),
      status: "waiting",
      players: [player],
      questions: [], // Will be populated when game starts
      currentQuestionIndex: 0,
      currentRound: null,
      completedRounds: [],
      matchScore: 0,
      totalQuestionsAnswered: 0,
      settings: {
        maxPlayers: 2,
        totalQuestions: 10,
        category: category,
        questionDuration: 15, // 15 seconds to answer
        resultDisplayDuration: 4, // 4 seconds to show results
        textQuestionDuration: 30, // typing takes longer than tapping
        textResultDisplayDuration: 6, // time to read two typed answers
        mode,
      },
    };

    // NX claims the code in the same step as the existence check, so two
    // rooms created at the same moment can't end up with the same code.
    const maxAttempts = 100;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      room.roomCode = this.generateRoomCode();
      const created = await redis.set(
        this.getRoomKey(room.roomCode),
        JSON.stringify(room),
        "EX",
        ROOM_TTL,
        "NX"
      );
      if (created === "OK") {
        await redis.setex(this.getPlayerRoomKey(socketId), ROOM_TTL, room.roomCode);
        return room;
      }
    }
    throw new Error("Failed to generate unique room code after multiple attempts");
  }

  // Join room
  async joinRoom(
    roomCode: string,
    socketId: string,
    playerName: string,
    avatar: string,
    supportsTextQuestions = false,
    supportsServerCoins = false
  ): Promise<JoinRoomResult> {
    const roomKey = this.getRoomKey(roomCode);
    const roomData = await redis.get(roomKey);

    if (!roomData) {
      return { success: false, error: "Room not found", code: "ROOM_NOT_FOUND" };
    }

    const room = this.parseRoom(roomData);
    if (!room) {
      console.error(`❌ Corrupted room data for room: ${roomCode}`);
      return { success: false, error: "Room data is corrupted", code: "REQUEST_FAILED" };
    }

    const existing = room.players.find((p) => p.id === socketId);
    if (existing) {
      return { success: true, player: existing, room };
    }

    if (room.status !== "waiting") {
      return { success: false, error: "Game already started", code: "GAME_IN_PROGRESS" };
    }

    if (room.players.length >= room.settings.maxPlayers) {
      return { success: false, error: "Room is full", code: "ROOM_FULL" };
    }

    const player: Player = {
      id: socketId,
      name: playerName,
      avatar: avatar,
      isHost: false,
      hasAnswered: false,
      supportsTextQuestions,
      supportsServerCoins,
    };

    room.players.push(player);

    await redis.setex(this.getPlayerRoomKey(socketId), ROOM_TTL, roomCode);
    await this.saveRoom(room);

    return { success: true, player, room };
  }

  // Get room info
  async getRoom(roomCode: string): Promise<Room | undefined> {
    const roomKey = this.getRoomKey(roomCode);
    const roomData = await redis.get(roomKey);

    if (!roomData) {
      return undefined;
    }

    const room = this.parseRoom(roomData);
    if (!room) {
      console.error(`❌ Corrupted room data for room: ${roomCode}`);
      return undefined;
    }

    return room;
  }

  // Get room code for a player (public method for accessing playerRooms)
  async getPlayerRoom(socketId: string): Promise<string | null> {
    const playerRoomKey = this.getPlayerRoomKey(socketId);
    const roomCode = await redis.get(playerRoomKey);
    return roomCode;
  }

  // Remove player
  async removePlayer(socketId: string): Promise<string | null> {
    const playerRoomKey = this.getPlayerRoomKey(socketId);
    const roomCode = await redis.get(playerRoomKey);

    if (!roomCode) return null;

    const roomKey = this.getRoomKey(roomCode);
    const roomData = await redis.get(roomKey);

    if (roomData) {
      const room = this.parseRoom(roomData);
      if (!room) {
        console.error(
          `❌ Corrupted room data when removing player: ${socketId}`
        );
        // Continue with cleanup even if room data is corrupted
      } else {
        room.players = room.players.filter((p) => p.id !== socketId);

        // If host left, assign new host
        if (room.players.length > 0 && !room.players.some((p) => p.isHost)) {
          room.players[0].isHost = true;
        }

        await this.saveRoom(room);
      }
    }

    // Player mapping'ini sil
    await redis.del(playerRoomKey);

    return roomCode;
  }

  // Delete room
  async deleteRoom(roomCode: string): Promise<void> {
    const roomKey = this.getRoomKey(roomCode);
    const roomData = await redis.get(roomKey);

    if (roomData) {
      const room = this.parseRoom(roomData);
      if (!room) {
        console.error(`❌ Corrupted room data when deleting room: ${roomCode}`);
        // Delete the corrupted room key anyway
        await redis.del(roomKey);
        return;
      }

      // Tüm player mapping'lerini sil
      const deletePromises = room.players.map((player) => {
        const playerRoomKey = this.getPlayerRoomKey(player.id);
        return redis.del(playerRoomKey);
      });

      await Promise.all(deletePromises);

      // Room'u sil
      await redis.del(roomKey);
    }
  }

  // Reset room for replay (after game finished)
  async resetRoom(roomCode: string): Promise<Room | null> {
    const roomKey = this.getRoomKey(roomCode);
    const roomData = await redis.get(roomKey);

    if (!roomData) return null;

    const room = this.parseRoom(roomData);
    if (!room) {
      console.error(`❌ Corrupted room data when resetting room: ${roomCode}`);
      return null;
    }

    // Reset game state
    room.status = "waiting";
    room.currentQuestionIndex = 0;
    room.currentRound = null;
    room.completedRounds = [];
    room.matchScore = 0;
    room.totalQuestionsAnswered = 0;
    room.questions = []; // Will be refilled on next game start

    // Reset all players' hasAnswered flag
    room.players.forEach((player) => {
      player.hasAnswered = false;
    });

    await this.saveRoom(room);

    console.log(`🔄 Room ${roomCode} has been reset for replay`);
    return room;
  }

  // Update room in Redis (helper method for index.ts)
  async updateRoom(room: Room): Promise<void> {
    await this.saveRoom(room);
  }

  // For debugging - list all rooms
  async getAllRooms(): Promise<Room[]> {
    // SCAN walks the keyspace in small steps; KEYS would block Redis (and
    // every game) while it lists everything.
    const keys = new Set<string>();
    for await (const batch of redis.scanStream({
      match: `${ROOM_KEY_PREFIX}*`,
      count: 500,
    })) {
      for (const key of batch as string[]) keys.add(key);
    }

    const roomsData: (string | null)[] = [];
    const keyList = [...keys];
    for (let i = 0; i < keyList.length; i += 500) {
      roomsData.push(...(await redis.mget(...keyList.slice(i, i + 500))));
    }

    const rooms: Room[] = [];
    for (const data of roomsData) {
      if (data === null) continue;

      const room = this.parseRoom(data);
      if (room) {
        rooms.push(room);
      } else {
        console.warn("⚠️ Skipping corrupted room data in getAllRooms");
      }
    }

    return rooms;
  }
}
