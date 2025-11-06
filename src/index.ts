import express from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import cors from "cors";
import { RoomManager } from "./roomManager.js";
import {
  CreateRoomData,
  JoinRoomData,
  GetRoomData,
  Category,
} from "./types.js";

const app = express();
const httpServer = createServer(app);

app.use(cors());

// Socket.io Event Types
interface ServerToClientEvents {
  "room-created": (data: {
    roomCode: string;
    player: any;
    category: Category;
  }) => void;
  "room-joined": (data: { roomCode: string; player: any; room: any }) => void;
  "player-joined": (data: { player: any; room: any }) => void;
  "player-left": (data: { playerId: string; room: any }) => void;
  "room-data": (room: any) => void;
  "room-error": (data: { message: string }) => void;
  "room-left": () => void;
}

interface ClientToServerEvents {
  "create-room": (data: CreateRoomData) => void;
  "join-room": (data: JoinRoomData) => void;
  "get-room": (data: GetRoomData) => void;
  "leave-room": (data: { roomCode: string }) => void;
}

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: "*", // For development purposes - in production, specify the domain.
    methods: ["GET", "POST"],
  },
});

// This is temporary room manager. In production, we will use redis.
const roomManager = new RoomManager();

io.on(
  "connection",
  (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
    console.log("✅ New user connected:", socket.id);

    // 1. Create Room
    socket.on(
      "create-room",
      ({ playerName, avatar, category }: CreateRoomData) => {
        const room = roomManager.createRoom(
          socket.id,
          playerName,
          avatar,
          category
        );
        socket.join(room.roomCode);

        console.log(
          `🏠 Room created: ${room.roomCode} - Player: ${playerName}`
        );

        socket.emit("room-created", {
          roomCode: room.roomCode,
          player: room.players[0],
          category: room.settings.category,
          // TODO: questionsCount: room.settings.questionsCount,
          // TODO: maxPlayers: room.settings.maxPlayers,
        });
      }
    );

    // 2. Join Room
    socket.on("join-room", ({ roomCode, playerName, avatar }: JoinRoomData) => {
      const result = roomManager.joinRoom(
        roomCode,
        socket.id,
        playerName,
        avatar
      );

      if (result.success) {
        socket.join(roomCode);

        console.log(`👥 ${playerName} joined room: ${roomCode}`);

        // Send info to joined player
        socket.emit("room-joined", {
          roomCode,
          player: result.player,
          room: result.room,
        });

        // Notify other players in the room
        socket.to(roomCode).emit("player-joined", {
          player: result.player,
          room: result.room,
        });
      } else {
        socket.emit("room-error", { message: result.error });
        console.log(`❌ Room join error: ${result.error}`);
      }
    });

    // 3. Get Room Info
    socket.on("get-room", ({ roomCode }: GetRoomData) => {
      const room = roomManager.getRoom(roomCode);
      if (room) {
        socket.emit("room-data", room);
      } else {
        socket.emit("room-error", { message: "Room not found" });
      }
    });

    // 4. On Disconnect
    socket.on("disconnect", () => {
      const roomCode = roomManager.removePlayer(socket.id);
      if (roomCode) {
        const room = roomManager.getRoom(roomCode);

        console.log(`🚪 Player left: ${socket.id} - Room: ${roomCode}`);

        // Notify other players in the room
        io.to(roomCode).emit("player-left", {
          playerId: socket.id,
          room: room,
        });

        // Delete room if empty
        if (room && room.players.length === 0) {
          roomManager.deleteRoom(roomCode);
          console.log(`🗑️ Empty room deleted: ${roomCode}`);
        }
      }
    });
    socket.on("leave-room", ({ roomCode }: { roomCode: string }) => {
      console.log("🚪 Player leaving:", socket.id, "Room:", roomCode);

      const room = roomManager.getRoom(roomCode);

      if (!room) {
        socket.emit("room-error", { message: "Room not found" });
        return;
      }

      // Leave the socket.io room
      socket.leave(roomCode);

      // Remove player using RoomManager
      roomManager.removePlayer(socket.id);

      // Get updated room info
      const updatedRoom = roomManager.getRoom(roomCode);

      // Notify other players in the room
      io.to(roomCode).emit("player-left", {
        playerId: socket.id,
        room: updatedRoom,
      });

      // Send success response to the leaving player
      socket.emit("room-left");

      // Delete room if empty
      if (updatedRoom && updatedRoom.players.length === 0) {
        roomManager.deleteRoom(roomCode);
        console.log(`🗑️ Empty room deleted: ${roomCode}`);
      }

      console.log("✅ Player left the room:", socket.id);
    });
  }
);

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`\n🚀 Socket.io server running: http://localhost:${PORT}`);
  console.log(`📱 Connect from frontend: ws://localhost:${PORT}\n`);
});
