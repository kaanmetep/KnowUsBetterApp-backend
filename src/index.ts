import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { RoomManager } from "./roomManager.js";
import {
  CreateRoomData,
  JoinRoomData,
  GetRoomData,
  SubmitAnswerData,
} from "./types.js";
import { fetchRandomQuestions } from "./services/questionService.js";
import {
  getCoinsFromProductId,
  findSocketByUserId,
  sanitizeMessage,
  isValidMessage,
  type SocketData,
  type ServerToClientEvents,
  type ClientToServerEvents,
} from "./utils/helpers.js";
import { ipWhitelistMiddleware } from "./middleware/ipWhitelist.js";
import { verifyRevenueCatSignature } from "./middleware/revenueCat.js";
import {
  healthRateLimiter,
  webhookRateLimiter,
} from "./middleware/rateLimiter.js";
import {
  getClientIP,
  canCreateSocket,
  registerSocket,
  unregisterSocket,
} from "./utils/ipSocketLimiter.js";

const app = express();
const httpServer = createServer(app);

app.use(cors());
app.use(express.json());

// ============================================
// SUPABASE CONFIGURATION
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabase Admin Client
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      })
    : null;

// ============================================
// USER SOCKET MAPPING (appUserId -> socket.id)
// ============================================
const userSockets = new Map<string, string>(); // appUserId -> socket.id

// ============================================
// CHAT RATE LIMITING (socket.id -> last message timestamp)
// ============================================
const chatRateLimits = new Map<string, number>(); // socket.id -> last message timestamp
const CHAT_RATE_LIMIT_MS = 1000; // 1 second between messages
const CHAT_MAX_LENGTH = 100; // Maximum message length

// Socket.io Ping/Pong Configuration
// pingInterval: How often to send ping (ms) - default: 60000 (60s)
// pingTimeout: How long to wait for pong before disconnecting (ms) - default: 5000 (5s)
// Lower timeout = faster detection of dead connections but may disconnect slow networks
const PING_INTERVAL = parseInt(process.env.SOCKET_PING_INTERVAL || "60000", 10); // 60 seconds (less frequent ping)
const PING_TIMEOUT = parseInt(process.env.SOCKET_PING_TIMEOUT || "15000", 10); // 15 seconds (tolerant for slow networks)

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  {},
  SocketData
>(httpServer, {
  cors: {
    origin: "*", // CHANGE !!! For development purposes - in production, specify the domain.
    methods: ["GET", "POST"],
  },
  pingInterval: PING_INTERVAL,
  pingTimeout: PING_TIMEOUT,
  connectTimeout: parseInt(process.env.SOCKET_CONNECT_TIMEOUT || "10000", 10), // 10 seconds
});

// This is temporary room manager. In production, we will use redis.
const roomManager = new RoomManager();

io.on(
  "connection",
  (
    socket: Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>
  ) => {
    // IP bazlı socket limiti kontrolü
    const clientIP = getClientIP(socket);
    const socketLimitCheck = canCreateSocket(clientIP);

    if (!socketLimitCheck.allowed) {
      console.warn(
        `⚠️ Socket connection blocked for IP ${clientIP}: ${socketLimitCheck.reason}`
      );
      socket.emit("critical-error", {
        message: "Connection limit exceeded. Please try again later.",
        code: "CONNECTION_LIMIT_EXCEEDED",
      });
      socket.disconnect(true);
      return;
    }

    // Socket'i IP'ye kaydet
    registerSocket(socket.id, clientIP);

    console.log(`✅ New user connected: ${socket.id} from IP: ${clientIP}`);

    // Register user with appUserId
    socket.on("register-user", (appUserId: string) => {
      if (appUserId) {
        userSockets.set(appUserId, socket.id);
        socket.data.appUserId = appUserId;
        console.log(`📝 User ${appUserId} registered with socket ${socket.id}`);
      }
    });

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
        // Fetch questions from Supabase
        if (!supabaseAdmin) {
          socket.emit("room-error", {
            message: "Database not configured. Please contact support.",
          });
          return;
        }

        const questions = await fetchRandomQuestions(
          room.settings.category,
          room.settings.totalQuestions,
          supabaseAdmin
        );

        // Store questions in room
        room.questions = questions;
        room.status = "playing";

        // Double-check we still have 2 players (in case someone left during async operation)
        if (room.players.length < 2) {
          socket.emit("room-error", {
            message:
              "Not enough players to start the game. Please wait for another player.",
          });
          room.status = "waiting";
          return;
        }

        // Check if we have questions
        if (!questions || questions.length === 0) {
          socket.emit("room-error", {
            message: "Failed to load questions. Please try again.",
          });
          room.status = "waiting";
          return;
        }

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
        // Safety check: ensure we have exactly 2 answers
        if (answers.length !== 2) {
          console.error(
            `⚠️ Unexpected number of answers: ${answers.length} in room ${roomCode}`
          );
          socket.emit("critical-error", {
            message:
              "An error occurred while processing answers. The game will be reset.",
            code: "INVALID_ANSWER_COUNT",
          });
          roomManager.resetRoom(roomCode);
          return;
        }
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
        // Calculate percentage safely (avoid division by zero)
        const percentage =
          room.totalQuestionsAnswered > 0
            ? Math.round((room.matchScore / room.totalQuestionsAnswered) * 100)
            : 0;

        io.to(roomCode).emit("round-completed", {
          allPlayersAnswered: true, // ✅ Flag for frontend
          isMatched: isMatched,
          playerAnswers: playerAnswers, // ✅ Who answered what
          question: room.currentRound.question,
          matchScore: room.matchScore,
          totalQuestions: room.totalQuestionsAnswered,
          percentage: percentage,
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
            // Re-fetch room in case it was deleted
            const currentRoom = roomManager.getRoom(roomCode);
            if (!currentRoom) {
              console.log(
                `⚠️ Room ${roomCode} no longer exists, skipping game-finished event`
              );
              return;
            }

            // Calculate percentage safely (avoid division by zero)
            const percentage =
              currentRoom.totalQuestionsAnswered > 0
                ? Math.round(
                    (currentRoom.matchScore /
                      currentRoom.totalQuestionsAnswered) *
                      100
                  )
                : 0;

            io.to(roomCode).emit("game-finished", {
              matchScore: currentRoom.matchScore,
              totalQuestions: currentRoom.totalQuestionsAnswered,
              percentage: percentage,
              completedRounds: currentRoom.completedRounds,
            });

            const finalRoom = roomManager.getRoom(roomCode);
            if (finalRoom) {
              roomManager.resetRoom(roomCode);
              console.log(`🔄 Room ${roomCode} auto-reset after game finished`);
            }
          }, room.settings.resultDisplayDuration * 1000);
        } else {
          // Move to next question
          setTimeout(() => {
            // Re-fetch room in case it was deleted or modified
            const currentRoom = roomManager.getRoom(roomCode);
            if (!currentRoom) {
              console.log(
                `⚠️ Room ${roomCode} no longer exists, cancelling next question`
              );
              return;
            }

            // Check if we still have 2 players
            if (currentRoom.players.length < 2) {
              console.log(
                `⚠️ Not enough players in room ${roomCode}, cancelling game`
              );
              currentRoom.status = "waiting";
              io.to(roomCode).emit("game-cancelled", {
                message:
                  "A player left during the game. Game has been cancelled.",
                room: currentRoom,
              });
              roomManager.resetRoom(roomCode);
              return;
            }

            currentRoom.currentQuestionIndex++;

            // Check if next question index is valid
            if (
              currentRoom.currentQuestionIndex >= currentRoom.questions.length
            ) {
              console.log(
                `⚠️ Question index out of bounds in room ${roomCode}, finishing game`
              );
              currentRoom.status = "finished";
              currentRoom.currentRound = null;

              const percentage =
                currentRoom.totalQuestionsAnswered > 0
                  ? Math.round(
                      (currentRoom.matchScore /
                        currentRoom.totalQuestionsAnswered) *
                        100
                    )
                  : 0;

              io.to(roomCode).emit("game-finished", {
                matchScore: currentRoom.matchScore,
                totalQuestions: currentRoom.totalQuestionsAnswered,
                percentage: percentage,
                completedRounds: currentRoom.completedRounds,
              });
              return;
            }

            const nextQuestion =
              currentRoom.questions[currentRoom.currentQuestionIndex];

            if (!nextQuestion) {
              console.error(
                `⚠️ Next question is undefined in room ${roomCode} at index ${currentRoom.currentQuestionIndex}`
              );
              currentRoom.status = "finished";
              currentRoom.currentRound = null;
              io.to(roomCode).emit("game-cancelled", {
                message: "An error occurred loading the next question.",
                room: currentRoom,
              });
              return;
            }

            currentRoom.currentRound = {
              question: nextQuestion,
              answers: {
                [currentRoom.players[0].id]: null,
                [currentRoom.players[1].id]: null,
              },
              isMatched: null,
              status: "waiting_answers",
            };

            console.log(`➡️ Next question in room ${roomCode}`);

            const nextStartTime = Date.now();
            io.to(roomCode).emit("next-question", {
              question: nextQuestion,
              currentQuestionIndex: currentRoom.currentQuestionIndex,
              totalQuestions: currentRoom.questions.length,
              serverTime: nextStartTime,
              duration: currentRoom.settings.questionDuration,
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
            message: "We couldn't find that room. Please try again.",
          });
          return;
        }

        // Check if player is in the room
        const player = room.players.find((p) => p.id === socket.id);
        if (!player) {
          socket.emit("room-error", {
            message: "Looks like you're not part of this room anymore.",
          });
          return;
        }

        // Validate message exists and is not empty
        if (!message || typeof message !== "string") {
          return; // Ignore invalid messages
        }

        const trimmedMessage = message.trim();
        if (trimmedMessage.length === 0) {
          return; // Ignore empty messages
        }

        // Check message length
        if (trimmedMessage.length > CHAT_MAX_LENGTH) {
          socket.emit("room-error", {
            message: `That message is a little long—try keeping it under ${CHAT_MAX_LENGTH} characters.`,
          });
          return;
        }

        // Rate limiting: prevent spam
        const now = Date.now();
        const lastMessageTime = chatRateLimits.get(socket.id) || 0;
        const timeSinceLastMessage = now - lastMessageTime;

        if (timeSinceLastMessage < CHAT_RATE_LIMIT_MS) {
          const remainingTime = Math.ceil(
            (CHAT_RATE_LIMIT_MS - timeSinceLastMessage) / 1000
          );
          socket.emit("room-error", {
            message: `Please wait ${remainingTime} second${
              remainingTime > 1 ? "s" : ""
            } before sending another message.`,
          });
          return;
        }

        // Security: Check for suspicious content (XSS prevention)
        if (!isValidMessage(trimmedMessage)) {
          socket.emit("room-error", {
            message: "Your message contains invalid content. Please try again.",
          });
          console.warn(
            `⚠️ Suspicious message blocked from ${player.name} (${
              socket.id
            }): ${trimmedMessage.substring(0, 50)}`
          );
          return;
        }

        // Sanitize message to prevent XSS
        const sanitizedMessage = sanitizeMessage(trimmedMessage);

        // Update rate limit
        chatRateLimits.set(socket.id, now);

        console.log(
          `💬 Chat message in room ${roomCode} from ${player.name}: ${sanitizedMessage}`
        );

        // Broadcast message to all players in the room (including sender)
        io.to(roomCode).emit("chat-message", {
          playerId: socket.id,
          playerName: player.name,
          avatar: player.avatar,
          message: sanitizedMessage,
          timestamp: now,
        });
      }
    );

    // 9. Spend Coins
    socket.on("spend-coins", async (data) => {
      const { appUserId, amount, transactionType = "game_start" } = data;

      // Supabase yapılandırılmamışsa hata döndür
      if (!supabaseAdmin) {
        socket.emit("coins-spent", {
          appUserId,
          newBalance: 0,
          success: false,
          error: "Supabase not configured",
        });
        return;
      }

      if (!appUserId || !amount || amount <= 0) {
        socket.emit("coins-spent", {
          appUserId,
          newBalance: 0,
          success: false,
          error: "Invalid request data",
        });
        return;
      }

      try {
        console.log(
          `💰 Processing coin spend: ${amount} coins for user ${appUserId}`
        );

        // Mevcut balance'ı al
        const { data: existing, error: fetchError } = await supabaseAdmin
          .from("coins")
          .select("balance")
          .eq("app_user_id", appUserId)
          .maybeSingle();

        if (fetchError) {
          console.error("❌ Error fetching existing balance:", fetchError);
          socket.emit("coins-spent", {
            appUserId,
            newBalance: 0,
            success: false,
            error: "Database error",
          });
          return;
        }

        const currentBalance = existing?.balance || 0;

        // Yeterli coin var mı kontrol et
        if (currentBalance < amount) {
          console.warn(
            `⚠️ Not enough coins. Required: ${amount}, Available: ${currentBalance}`
          );
          socket.emit("coins-spent", {
            appUserId,
            newBalance: currentBalance,
            success: false,
            error: `Not enough coins. Required: ${amount}, Available: ${currentBalance}`,
          });
          return;
        }

        // Yeni balance hesapla
        const newBalance = currentBalance - amount;

        // Secret key ile Supabase'e yaz (RLS bypass)
        const { error: upsertError } = await supabaseAdmin.from("coins").upsert(
          {
            app_user_id: appUserId,
            balance: newBalance,
          },
          { onConflict: "app_user_id" }
        );

        if (upsertError) {
          console.error("❌ Error updating coins:", upsertError);
          socket.emit("coins-spent", {
            appUserId,
            newBalance: currentBalance,
            success: false,
            error: "Failed to update coins",
          });
          return;
        }

        // Transaction log'a ekle
        const { error: transactionError } = await supabaseAdmin
          .from("coin_transactions")
          .insert({
            app_user_id: appUserId,
            amount: amount,
            transaction_type: transactionType || "game_start",
          });

        if (transactionError) {
          console.warn("⚠️ Failed to log transaction:", transactionError);
          // Transaction log hatası kritik değil, devam et
        }

        console.log(`✅ Coins spent successfully. New balance: ${newBalance}`);

        // Socket.io ile connected client'a bildirim gönder
        socket.emit("coins-spent", {
          appUserId,
          newBalance,
          success: true,
        });

        console.log(`📢 Coin spend notification sent to user ${appUserId}`);
      } catch (error) {
        console.error("❌ Error processing coin spend:", error);
        socket.emit("coins-spent", {
          appUserId,
          newBalance: 0,
          success: false,
          error: "Internal server error",
        });
      }
    });

    // 8. On Disconnect
    socket.on("disconnect", () => {
      // Clean up IP-based socket limiter
      unregisterSocket(socket.id);

      // Clean up appUserId mapping
      const appUserId = socket.data.appUserId;
      if (appUserId) {
        userSockets.delete(appUserId);
        console.log(
          `📝 User ${appUserId} unregistered from socket ${socket.id}`
        );
      }

      // Clean up rate limiting
      chatRateLimits.delete(socket.id);

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

// ============================================
// HEALTH CHECK & METRICS ENDPOINT
// ============================================
app.get("/health", ipWhitelistMiddleware, healthRateLimiter, (req, res) => {
  try {
    const socketCount = io.sockets.sockets.size;
    const connectionCount = io.engine.clientsCount || 0;
    const roomsCount = roomManager.getAllRooms().length;
    const totalPlayers = roomManager
      .getAllRooms()
      .reduce((sum, room) => sum + room.players.length, 0);

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      connections: {
        sockets: socketCount,
        engine: connectionCount,
      },
      rooms: {
        total: roomsCount,
        players: totalPlayers,
      },
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ============================================
// REVENUECAT WEBHOOK ENDPOINT
// ============================================

app.post(
  "/webhook/revenuecat",
  webhookRateLimiter,
  express.json({ verify: verifyRevenueCatSignature }),
  async (req, res) => {
    try {
      const { event } = req.body;

      console.log("📦 RevenueCat webhook received:", event?.type);

      if (!supabaseAdmin) {
        console.error("❌ Supabase not configured");
        return res.status(500).json({ error: "Supabase not configured" });
      }

      if (
        event.type === "INITIAL_PURCHASE" ||
        event.type === "RENEWAL" ||
        event.type === "NON_RENEWING_PURCHASE"
      ) {
        const appUserId = event.app_user_id; // User ID coming from RevenueCat
        const productId = event.product_id;
        const coins = getCoinsFromProductId(productId);

        if (!appUserId || !coins || coins === 0) {
          console.warn("⚠️ Invalid webhook data:", {
            appUserId,
            productId,
            coins,
          });
          return res.status(400).json({ error: "Invalid webhook data" });
        }

        console.log(
          `💰 Processing purchase: ${coins} coins for user ${appUserId}`
        );

        // Get current balance
        const { data: existing, error: fetchError } = await supabaseAdmin
          .from("coins")
          .select("balance")
          .eq("app_user_id", appUserId)
          .maybeSingle();

        if (fetchError) {
          console.error("❌ Error fetching existing balance:", fetchError);
          return res.status(500).json({ error: "Database error" });
        }

        // Calculate new balance
        const currentBalance = existing?.balance || 0;
        const newBalance = currentBalance + coins;

        // Write to Supabase with secret key (RLS bypass)
        const { error: upsertError } = await supabaseAdmin.from("coins").upsert(
          {
            app_user_id: appUserId,
            balance: newBalance,
          },
          { onConflict: "app_user_id" }
        );

        if (upsertError) {
          console.error("❌ Error updating coins:", upsertError);
          return res.status(500).json({ error: "Failed to update coins" });
        }

        // Transaction log'a ekle (opsiyonel)
        const { error: transactionError } = await supabaseAdmin
          .from("coin_transactions")
          .insert({
            app_user_id: appUserId,
            amount: coins,
            transaction_type: "purchase",
          });

        if (transactionError) {
          console.warn("⚠️ Failed to log transaction:", transactionError);
        }

        console.log(`✅ Coins added successfully. New balance: ${newBalance}`);

        // Socket.io ile connected client'a bildirim gönder
        const userSocket = findSocketByUserId(appUserId, io, userSockets);

        if (userSocket) {
          userSocket.emit("coins-added", {
            appUserId,
            newBalance,
            success: true,
          });
          console.log(
            `📢 Notification sent to user ${appUserId} via socket ${userSocket.id}`
          );
        } else {
          console.log(
            `ℹ️ User ${appUserId} not connected via socket (will sync on next app open)`
          );
        }

        // Webhook'a başarılı response döndür
        return res.status(200).json({ success: true });
      } else {
        // Diğer event'ler için sadece log
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
        return res.status(200).json({ success: true });
      }
    } catch (error) {
      console.error("❌ Webhook error:", error);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

// ============================================
// GLOBAL ERROR HANDLERS - CRITICAL FOR PRODUCTION
// ============================================

// Handle uncaught exceptions (synchronous errors)
process.on("uncaughtException", (error: Error) => {
  console.error(
    "💥 UNCAUGHT EXCEPTION - Server will crash without this handler!"
  );
  console.error("Error:", error);
  console.error("Stack:", error.stack);

  // Log to error tracking service (Sentry, etc.) in production
  // Example: Sentry.captureException(error);

  // Graceful shutdown
  httpServer.close(() => {
    console.log("🛑 HTTP server closed due to uncaught exception");
    process.exit(1); // Exit with error code
  });

  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error("⚠️ Forcing exit due to uncaught exception");
    process.exit(1);
  }, 10000);
});

// Handle unhandled promise rejections (async errors)
process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
  console.error("💥 UNHANDLED REJECTION - This would crash the server!");
  console.error("Reason:", reason);
  console.error("Promise:", promise);

  // Log to error tracking service in production
  // Example: Sentry.captureException(reason);

  // In production, you might want to exit here too
  // But for now, we'll just log it to prevent crashes
  // process.exit(1);
});

// Handle warnings
process.on("warning", (warning: Error) => {
  console.warn("⚠️ Warning:", warning.message);
  console.warn("Stack:", warning.stack);
});

// ============================================
// SERVER STARTUP
// ============================================

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`\n🚀 Socket.io server running: http://localhost:${PORT}`);
  console.log(`📱 Connect from frontend: ws://localhost:${PORT}\n`);
});

// Graceful shutdown on SIGTERM/SIGINT (Docker, PM2, etc.)
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully...");
  httpServer.close(() => {
    console.log("✅ HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down gracefully...");
  httpServer.close(() => {
    console.log("✅ HTTP server closed");
    process.exit(0);
  });
});
