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
  "room-error": (data: { message: string }) => void; // Non-critical warnings
  "critical-error": (data: { message: string; code?: string }) => void; // Critical errors - redirect user
  "room-left": () => void;
  "game-started": (data: {
    room: any;
    question: any;
    totalQuestions: number;
    serverTime: number; // Server timestamp when first question starts
    duration: number; // How long players have to answer (seconds)
  }) => void;
  "player-answered": (data: {
    playerId: string;
    playerName: string | undefined;
  }) => void;
  "round-completed": (data: {
    allPlayersAnswered: boolean;
    isMatched: boolean;
    playerAnswers: Array<{
      playerId: string;
      playerName: string;
      avatar: string;
      answer: string | null;
    }>;
    question: any;
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
    serverTime: number; // Server timestamp when question starts
    duration: number; // How long players have to answer (seconds)
  }) => void;
  "kicked-from-room": (data: { message: string; roomCode: string }) => void;
  "player-kicked": (data: {
    playerId: string;
    playerName: string;
    room: any;
  }) => void;
  "game-cancelled": (data: { message: string; room: any }) => void;
  "chat-message": (data: {
    playerId: string;
    playerName: string;
    avatar: string;
    message: string;
    timestamp: number;
  }) => void;
}

interface ClientToServerEvents {
  "create-room": (data: CreateRoomData) => void;
  "join-room": (data: JoinRoomData) => void;
  "get-room": (data: GetRoomData) => void;
  "leave-room": (data: { roomCode: string }) => void;
  "start-game": (data: { roomCode: string }) => void;
  "submit-answer": (data: SubmitAnswerData) => void;
  "kick-player": (data: { roomCode: string; targetPlayerId: string }) => void;
  "send-message": (data: { roomCode: string; message: string }) => void;
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
        socket.emit("room-error", {
          message:
            "We couldn't find that room anymore. Please double-check the code.",
        });
      }
    });

    // 4. Start Game
    socket.on("start-game", async ({ roomCode }: { roomCode: string }) => {
      const room = roomManager.getRoom(roomCode);

      if (!room) {
        socket.emit("room-error", {
          message:
            "We couldn't find that room anymore. Please refresh and try again.",
        });
        return;
      }

      // Check if user is host
      const player = room.players.find((p) => p.id === socket.id);
      if (!player?.isHost) {
        socket.emit("room-error", {
          message:
            "Only the host can start the game. Ping them when you're ready!",
        });
        return;
      }

      // Check if we have at least 2 players
      if (room.players.length < 2) {
        socket.emit("room-error", {
          message: "Invite one more player and you'll be ready to go!",
        });
        return;
      }

      // Check if game already started
      if (room.status === "playing") {
        socket.emit("room-error", {
          message:
            "The game is already underway. Hang tight for the next round!",
        });
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
        const startTime = Date.now();
        io.to(roomCode).emit("game-started", {
          room: room,
          question: firstQuestion,
          totalQuestions: room.settings.totalQuestions,
          serverTime: startTime,
          duration: room.settings.questionDuration,
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
        socket.emit("critical-error", {
          message:
            "This game wrapped up already. We'll take you back so you can start a fresh one.",
          code: "GAME_INACTIVE",
        });
        return;
      }

      const room = roomManager.getRoom(roomCode);
      if (!room || !room.currentRound) {
        socket.emit("critical-error", {
          message:
            "We lost track of the current question. We'll reset things for you in a moment.",
          code: "NO_ACTIVE_QUESTION",
        });
        return;
      }

      // Check if question ID matches
      if (room.currentRound.question.id !== questionId) {
        socket.emit("critical-error", {
          message:
            "Looks like things got out of sync. We'll help you restart the round.",
          code: "INVALID_QUESTION_ID",
        });
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

        // Prepare player answers for frontend (with names and avatars)
        const playerAnswers = room.players.map((p) => ({
          playerId: p.id,
          playerName: p.name,
          avatar: p.avatar,
          answer: room.currentRound!.answers[p.id],
        }));

        // Reset hasAnswered flags
        room.players.forEach((p) => (p.hasAnswered = false));

        console.log(
          `🎯 Round completed: ${isMatched ? "MATCH" : "NO MATCH"} (${
            room.matchScore
          }/${room.totalQuestionsAnswered})`
        );

        // Send results to all players
        io.to(roomCode).emit("round-completed", {
          allPlayersAnswered: true, // ✅ Flag for frontend
          isMatched: isMatched,
          playerAnswers: playerAnswers, // ✅ Who answered what
          question: room.currentRound.question,
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

          // Wait for resultDisplayDuration before showing final results
          // This gives users time to see the last question's result
          setTimeout(() => {
            io.to(roomCode).emit("game-finished", {
              matchScore: room.matchScore,
              totalQuestions: room.totalQuestionsAnswered,
              percentage: Math.round(
                (room.matchScore / room.totalQuestionsAnswered) * 100
              ),
              completedRounds: room.completedRounds,
            });

            // Wait 5 more seconds after game-finished, then reset room
            setTimeout(() => {
              roomManager.resetRoom(roomCode);
              console.log(`🔄 Room ${roomCode} auto-reset after game finished`);
            }, (room.settings.resultDisplayDuration + 5) * 1000); // resultDisplayDuration + 5 seconds to view final results
          }, room.settings.resultDisplayDuration * 1000);
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

            const nextStartTime = Date.now();
            io.to(roomCode).emit("next-question", {
              question: nextQuestion,
              currentQuestionIndex: room.currentQuestionIndex,
              totalQuestions: room.questions.length,
              serverTime: nextStartTime,
              duration: room.settings.questionDuration,
            });
          }, room.settings.resultDisplayDuration * 1000); // Dynamic delay from settings
        }
      }
    });

    // 6. Kick Player (Host only)
    socket.on(
      "kick-player",
      ({
        roomCode,
        targetPlayerId,
      }: {
        roomCode: string;
        targetPlayerId: string;
      }) => {
        const room = roomManager.getRoom(roomCode);

        if (!room) {
          socket.emit("room-error", {
            message: "We couldn't locate that room. It may have just closed.",
          });
          return;
        }

        // Check if requester is host
        const requester = room.players.find((p) => p.id === socket.id);
        if (!requester?.isHost) {
          socket.emit("room-error", {
            message: "Only the host can remove players. Give them a nudge!",
          });
          return;
        }

        // Check if target player exists
        const targetPlayer = room.players.find((p) => p.id === targetPlayerId);
        if (!targetPlayer) {
          socket.emit("room-error", {
            message:
              "We couldn't find that player. They may have already left.",
          });
          return;
        }

        // Cannot kick yourself
        if (targetPlayerId === socket.id) {
          socket.emit("room-error", {
            message: "You can’t kick yourself—nice try though!",
          });
          return;
        }

        // Cannot kick during active game
        if (room.status === "playing") {
          socket.emit("room-error", {
            message:
              "You can only remove players while the game is waiting to start.",
          });
          return;
        }

        console.log(
          `🚫 Player kicked: ${targetPlayer.name} from room ${roomCode} by ${requester.name}`
        );

        // Get target player's socket
        const targetSockets = Array.from(io.sockets.sockets.values()).filter(
          (s) => s.id === targetPlayerId
        );

        if (targetSockets.length > 0) {
          const targetSocket = targetSockets[0];

          // Make target leave socket.io room
          targetSocket.leave(roomCode);

          // Notify kicked player
          targetSocket.emit("kicked-from-room", {
            message: `You were kicked from the room by ${requester.name}`,
            roomCode: roomCode,
          });
        }

        // Remove player from room
        roomManager.removePlayer(targetPlayerId);

        // Get updated room
        const updatedRoom = roomManager.getRoom(roomCode);

        // Notify remaining players
        io.to(roomCode).emit("player-kicked", {
          playerId: targetPlayerId,
          playerName: targetPlayer.name,
          room: updatedRoom,
        });

        // Delete room if empty
        if (updatedRoom && updatedRoom.players.length === 0) {
          roomManager.deleteRoom(roomCode);
          console.log(`🗑️ Empty room deleted: ${roomCode}`);
        }
      }
    );

    // 7. Send Chat Message
    socket.on(
      "send-message",
      ({ roomCode, message }: { roomCode: string; message: string }) => {
        const room = roomManager.getRoom(roomCode);

        if (!room) {
          socket.emit("room-error", {
            message:
              "We couldn’t find that room. Please refresh and try again.",
          });
          return;
        }

        // Check if player is in the room
        const player = room.players.find((p) => p.id === socket.id);
        if (!player) {
          socket.emit("room-error", {
            message: "Looks like you’re not part of this room anymore.",
          });
          return;
        }

        // Validate message
        if (!message || message.trim().length === 0) {
          return; // Ignore empty messages
        }

        if (message.length > 500) {
          socket.emit("room-error", {
            message:
              "That message is a little long—try keeping it under 500 characters.",
          });
          return;
        }

        console.log(
          `💬 Chat message in room ${roomCode} from ${player.name}: ${message}`
        );

        // Broadcast message to all players in the room (including sender)
        io.to(roomCode).emit("chat-message", {
          playerId: socket.id,
          playerName: player.name,
          avatar: player.avatar,
          message: message.trim(),
          timestamp: Date.now(),
        });
      }
    );

    // 8. On Disconnect
    socket.on("disconnect", () => {
      const roomCode = roomManager.removePlayer(socket.id);
      if (roomCode) {
        const room = roomManager.getRoom(roomCode);

        console.log(`🚪 Player left: ${socket.id} - Room: ${roomCode}`);

        // If game was in progress, reset the room
        if (room && room.status === "playing") {
          console.log(`⚠️ Game interrupted! Resetting room ${roomCode}...`);
          roomManager.resetRoom(roomCode);

          // Notify remaining players that game was cancelled
          io.to(roomCode).emit("game-cancelled", {
            message: "A player left during the game. Game has been cancelled.",
            room: room,
          });
        }

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
        socket.emit("room-error", {
          message:
            "We couldn’t find that room. It may have already been closed.",
        });
        return;
      }

      // If game was in progress, reset the room
      if (room.status === "playing") {
        console.log(`⚠️ Game interrupted! Resetting room ${roomCode}...`);
        roomManager.resetRoom(roomCode);

        // Notify remaining players that game was cancelled
        io.to(roomCode).emit("game-cancelled", {
          message: "A player left during the game. Game has been cancelled.",
          room: room,
        });
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
