// Memory-based Room Manager.
// We will change this to redis later.

import { Room, Player, JoinRoomResult, Category } from "./types.js";

export class RoomManager {
  // Rooms in memory
  private rooms: Map<string, Room>;
  // Socket ID -> Room Code mapping
  public playerRooms: Map<string, string>;

  constructor() {
    this.rooms = new Map();
    this.playerRooms = new Map();
  }

  generateRoomCode(): string {
    return Math.random().toString(36).substring(1, 2).toUpperCase();
  }

  // Create a new room
  createRoom(
    socketId: string,
    playerName: string,
    avatar: string,
    category: Category
  ): Room {
    const roomCode = this.generateRoomCode();

    const player: Player = {
      id: socketId,
      name: playerName,
      avatar: avatar,
      isHost: true,
      hasAnswered: false,
    };

    const room: Room = {
      roomCode,
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
        totalQuestions: 5,
        category: category,
      },
    };

    this.rooms.set(roomCode, room);
    this.playerRooms.set(socketId, roomCode);

    return room;
  }

  // Join room
  joinRoom(
    roomCode: string,
    socketId: string,
    playerName: string,
    avatar: string
  ): JoinRoomResult {
    const room = this.rooms.get(roomCode);

    if (!room) {
      return { success: false, error: "Room not found" };
    }

    if (room.status !== "waiting") {
      return { success: false, error: "Game already started" };
    }

    if (room.players.length >= room.settings.maxPlayers) {
      return { success: false, error: "Room is full" };
    }

    const player: Player = {
      id: socketId,
      name: playerName,
      avatar: avatar,
      isHost: false,
      hasAnswered: false,
    };

    room.players.push(player);
    this.playerRooms.set(socketId, roomCode);

    return { success: true, player, room };
  }

  // Get room info
  getRoom(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode);
  }

  // Remove player
  removePlayer(socketId: string): string | null {
    const roomCode = this.playerRooms.get(socketId);

    if (!roomCode) return null;

    const room = this.rooms.get(roomCode);
    if (room) {
      room.players = room.players.filter((p) => p.id !== socketId);

      // If host left, assign new host
      if (room.players.length > 0 && !room.players.some((p) => p.isHost)) {
        room.players[0].isHost = true;
      }
    }

    this.playerRooms.delete(socketId);
    return roomCode;
  }

  // Delete room
  deleteRoom(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (room) {
      // Clear all players' mappings
      room.players.forEach((player) => {
        this.playerRooms.delete(player.id);
      });
      this.rooms.delete(roomCode);
    }
  }

  // For debugging - list all rooms
  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }
}
