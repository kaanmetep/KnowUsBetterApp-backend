import "dotenv/config";
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
  SubmitAnswerData,
} from "./types.js";
import {
  fetchRandomQuestions,
  getMockQuestions,
} from "./services/questionService.js";

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
  "game-started": (data: {
    room: any;
    question: any;
    totalQuestions: number;
  }) => void;
  "player-answered": (data: {
    playerId: string;
    playerName: string | undefined;
  }) => void;
  "round-completed": (data: {
    round: any;
    matchScore: number;
    totalQuestions: number;
    percentage: number;
  }) => void;
  "game-finished": (data: {
    matchScore: number;
    totalQuestions: number;
    percentage: number;
    completedRounds: any[];
  }) => void;
  "next-question": (data: {
    question: any;
    currentQuestionIndex: number;
    totalQuestions: number;
  }) => void;
}

interface ClientToServerEvents {
  "create-room": (data: CreateRoomData) => void;
  "join-room": (data: JoinRoomData) => void;
  "get-room": (data: GetRoomData) => void;
  "leave-room": (data: { roomCode: string }) => void;
  "start-game": (data: { roomCode: string }) => void;
  "submit-answer": (data: SubmitAnswerData) => void;
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

    // 4. Start Game
    socket.on("start-game", async ({ roomCode }: { roomCode: string }) => {
      const room = roomManager.getRoom(roomCode);

      if (!room) {
        socket.emit("room-error", { message: "Room not found" });
        return;
      }

      // Check if user is host
      const player = room.players.find((p) => p.id === socket.id);
      if (!player?.isHost) {
        socket.emit("room-error", { message: "Only host can start the game" });
        return;
      }

      // Check if we have at least 2 players
      if (room.players.length < 2) {
        socket.emit("room-error", {
          message: "Need at least 2 players to start",
        });
        return;
      }

      // Check if game already started
      if (room.status === "playing") {
        socket.emit("room-error", { message: "Game already started" });
        return;
      }

      try {
        // Fetch questions from Supabase (or use mock questions)
        let questions;
        if (false) {
          //process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
          questions = await fetchRandomQuestions(
            room!.settings.category,
            room!.settings.totalQuestions
          );
        } else {
          // Use mock questions if Supabase not configured
          console.log("⚠️ Using mock questions (Supabase not configured)");
          questions = getMockQuestions(
            room.settings.category,
            room.settings.totalQuestions
          );
        }

        // Store questions in room
        room.questions = questions;
        room.status = "playing";

        // Initialize first round
        const firstQuestion = questions[0];
        room.currentRound = {
          question: firstQuestion,
          answers: {
            [room.players[0].id]: null,
            [room.players[1].id]: null,
          },
          isMatched: null,
          status: "waiting_answers",
        };

        console.log(`🎮 Game started in room: ${roomCode}`);

        // Notify all players
        io.to(roomCode).emit("game-started", {
          room: room,
          question: firstQuestion,
          totalQuestions: room.settings.totalQuestions,
        });
      } catch (error) {
        console.error("Error starting game:", error);
        socket.emit("room-error", {
          message: "Failed to start game. Please try again.",
        });
      }
    });

    // 5. Submit Answer
    socket.on("submit-answer", ({ questionId, answer }: SubmitAnswerData) => {
      const roomCode = roomManager.playerRooms.get(socket.id);
      if (!roomCode) {
        socket.emit("room-error", { message: "You are not in a room" });
        return;
      }

      const room = roomManager.getRoom(roomCode);
      if (!room || !room.currentRound) {
        socket.emit("room-error", { message: "No active question" });
        return;
      }

      // Check if question ID matches
      if (room.currentRound.question.id !== questionId) {
        socket.emit("room-error", { message: "Invalid question ID" });
        return;
      }

      // Save answer
      room.currentRound.answers[socket.id] = answer;

      // Update player status
      const player = room.players.find((p) => p.id === socket.id);
      if (player) {
        player.hasAnswered = true;
      }

      console.log(`✅ Player ${socket.id} answered question ${questionId}`);

      // Notify other players (without revealing the answer)
      socket.to(roomCode).emit("player-answered", {
        playerId: socket.id,
        playerName: player?.name,
      });

      // Check if all players have answered
      const allAnswered = Object.values(room.currentRound.answers).every(
        (ans) => ans !== null
      );

      if (allAnswered) {
        // Calculate match
        const answers = Object.values(room.currentRound.answers);
        const isMatched = answers[0] === answers[1];

        room.currentRound.isMatched = isMatched;
        room.currentRound.status = "completed";
        room.totalQuestionsAnswered++;

        if (isMatched) {
          room.matchScore++;
        }

        // Reset hasAnswered flags
        room.players.forEach((p) => (p.hasAnswered = false));

        console.log(
          `🎯 Round completed: ${isMatched ? "MATCH" : "NO MATCH"} (${
            room.matchScore
          }/${room.totalQuestionsAnswered})`
        );

        // Send results to all players
        io.to(roomCode).emit("round-completed", {
          round: room.currentRound,
          matchScore: room.matchScore,
          totalQuestions: room.totalQuestionsAnswered,
          percentage: Math.round(
            (room.matchScore / room.totalQuestionsAnswered) * 100
          ),
        });

        // Move to completed rounds
        room.completedRounds.push(room.currentRound);

        // Check if game is finished
        if (room.currentQuestionIndex >= room.questions.length - 1) {
          // Game finished!
          room.status = "finished";
          room.currentRound = null;

          console.log(
            `🏁 Game finished in room ${roomCode}: ${room.matchScore}/${room.totalQuestionsAnswered}`
          );

          setTimeout(() => {
            io.to(roomCode).emit("game-finished", {
              matchScore: room.matchScore,
              totalQuestions: room.totalQuestionsAnswered,
              percentage: Math.round(
                (room.matchScore / room.totalQuestionsAnswered) * 100
              ),
              completedRounds: room.completedRounds,
            });
          }, 3000); // 3 seconds delay to show last result
        } else {
          // Move to next question
          setTimeout(() => {
            room.currentQuestionIndex++;
            const nextQuestion = room.questions[room.currentQuestionIndex];

            room.currentRound = {
              question: nextQuestion,
              answers: {
                [room.players[0].id]: null,
                [room.players[1].id]: null,
              },
              isMatched: null,
              status: "waiting_answers",
            };

            console.log(`➡️ Next question in room ${roomCode}`);

            io.to(roomCode).emit("next-question", {
              question: nextQuestion,
              currentQuestionIndex: room.currentQuestionIndex,
              totalQuestions: room.questions.length,
            });
          }, 3000); // 3 seconds delay between questions
        }
      }
    });

    // 6. On Disconnect
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
