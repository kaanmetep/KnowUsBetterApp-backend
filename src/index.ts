import dotenv from "dotenv";
dotenv.config();
if (process.env.NODE_ENV) {
  dotenv.config({ path: `.env.${process.env.NODE_ENV}`, override: true });
}
import { randomUUID } from "crypto";
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
  MultiLanguageAnswer,
  Question,
  QuestionRound,
  Player,
  Room,
  RoomErrorCode,
  CLIENT_FEATURE_TEXT_QUESTIONS,
  CLIENT_FEATURE_SERVER_COINS,
  CLIENT_FEATURE_WHO_IS_MORE_LIKELY,
  CLIENT_FEATURE_REACTIONS,
  CLIENT_FEATURE_RANK_IT,
  CLIENT_FEATURE_DAILY_ANALYSIS,
  DailyTopic,
} from "./types.js";
import {
  fetchRandomQuestions,
  getAnswerKey,
  markQuestionsSeen,
} from "./services/questionService.js";
import {
  gradeAnswer,
  rememberGrade,
  revealAnswer,
  takeGrade,
} from "./utils/trivia.js";
import {
  findSocketByUserId,
  findAnswerObject,
  isTextQuestion,
  normalizeTextAnswer,
  getQuestionDuration,
  getResultDisplayDuration,
  withRevealedAnswer,
  cleanPlayerName,
  cleanAvatar,
  HIDDEN_TEXT_ANSWER,
  type SendReactionResult,
  type SocketData,
  type ServerToClientEvents,
  type ClientToServerEvents,
} from "./utils/helpers.js";
import { ipWhitelistMiddleware } from "./middleware/ipWhitelist.js";
import { healthRateLimiter } from "./middleware/rateLimiter.js";
import { createRevenueCatWebhookRouter } from "./routes/revenueCatWebhook.js";
import { createIdentityRouter } from "./routes/identity.js";
import {
  allowLegacyClients,
  checkAppUser,
  isAllowed,
  isValidAppUserId,
} from "./services/appUserAuth.js";
import {
  getClientIP,
  canCreateSocket,
  registerSocket,
  unregisterSocket,
} from "./utils/ipSocketLimiter.js";
import { attachSocketRateLimiter } from "./middleware/socketRateLimiter.js";
import {
  acquireLock,
  LockTimeoutError,
  redis,
  releaseLock,
} from "./utils/redis.js";
import { createAiAnalysisRouter } from "./routes/aiAnalysis.js";
import {
  createDailyAnalysisRouter,
  DAILY_ANALYSIS_LOCK_SECONDS,
  dailyAnalysisLockKey,
} from "./routes/dailyAnalysis.js";
import {
  claimDailyAnalysis,
  DAILY_ANALYSIS_QUESTION_COUNT,
  DailyAnalysisReport,
  getCooldownEnd,
  getDailyAnalysisStatus,
  pushDailyAnalysisReady,
  releaseDailyAnalysis,
  saveDailyAnalysisGame,
  writeDailyAnalysis,
} from "./services/dailyAnalysis.js";
import { isLang } from "./languages.js";
import { createContentRouter } from "./routes/content.js";
import { logger } from "./utils/logger.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createAdminNotificationsRouter } from "./routes/adminNotifications.js";
import { createPublicConfigRouter } from "./routes/publicConfig.js";
import { PUBLIC_RUNTIME_CONFIG } from "./services/publicConfigService.js";
import {
  claimDailyReward,
  creditCoins,
  spendCoins,
} from "./services/coinLedger.js";
import {
  getCategory,
  getCategoryMode,
} from "./services/categoryService.js";
import { getReaction } from "./services/reactionService.js";
import {
  getFinishedGame,
  getGamePercentage,
  getLastFinishedGameOf,
  recordFinishedGame,
} from "./services/finishedGames.js";
import { getAnalysisStateFor } from "./services/sharedAnalysis.js";
import { createAdminPanelRouter } from "./routes/adminPanel.js";
import { warmUpProfanityFilter } from "./utils/profanity.js";
import { isHarmfulText } from "./utils/moderation.js";
import { isBanned } from "./services/banService.js";
import { textAnswersMatch, warmUpTextMatcher } from "./utils/textMatch.js";
import { isMoreLikelyPick, picksAgree } from "./utils/whoIsMoreLikely.js";
import {
  parseRanking,
  RANK_IT_QUESTION_COUNT,
  rankingSimilarity,
  rankItemCount,
} from "./utils/rankIt.js";

warmUpProfanityFilter();
warmUpTextMatcher();

const app = express();
const httpServer = createServer(app);

// Express CORS configuration (will be configured after ALLOWED_ORIGINS is defined)
// Temporary CORS setup, will be updated below
app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN === "*"
        ? "*"
        : (origin, callback) => {
            if (!origin) {
              callback(null, true);
              return;
            }
            const allowedOrigins = process.env.CORS_ORIGIN
              ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
              : ["*"];
            if (
              allowedOrigins.includes("*") ||
              allowedOrigins.includes(origin)
            ) {
              callback(null, true);
            } else {
              callback(null, false);
            }
          },
    credentials: false,
  }),
);

// ============================================
// SUPABASE CONFIGURATION
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_REPORTS_PER_SOCKET = 10;

// Local testing only: lets the daily reward be claimed on every app launch.
// Requires an explicit opt-in and is ignored in production.
const DEV_UNLIMITED_DAILY_REWARD =
  process.env.DEV_UNLIMITED_DAILY_REWARD === "true" &&
  process.env.NODE_ENV !== "production";

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

// Before the global JSON parser: the webhook parses (and keeps) its raw body.
app.use(
  "/webhook/revenuecat",
  createRevenueCatWebhookRouter({
    supabaseAdmin,
    onCoinsAdded: (appUserId, newBalance) =>
      findSocketByUserId(appUserId, io, userSockets)?.emit("coins-added", {
        appUserId,
        newBalance,
        success: true,
      }),
  }),
);

app.use(express.json());

app.use("/api/config", createPublicConfigRouter());

app.use(
  "/api/ai-analysis",
  createAiAnalysisRouter({
    supabaseAdmin,
    onBalanceChanged: (appUserId, newBalance) =>
      notifyCoinsSpent(appUserId, newBalance),
    onAnalysisUpdate: (playerId, update) =>
      io.to(playerId).emit("ai-analysis-update", update),
  }),
);

if (supabaseAdmin) {
  app.use("/api/identity", createIdentityRouter(supabaseAdmin));
  app.use(
    "/api/daily-analysis",
    createDailyAnalysisRouter(supabaseAdmin, {
      onReady: (id, appUserIds, report) =>
        emitDailyAnalysisUpdate([], appUserIds, { id, status: "ready", report }),
    }),
  );
  app.use(
    "/api",
    createContentRouter(supabaseAdmin, {
      devUnlimitedDailyReward: DEV_UNLIMITED_DAILY_REWARD,
    }),
  );
  app.use("/notifications", createNotificationsRouter(supabaseAdmin));
  app.use("/admin/notifications", createAdminNotificationsRouter(supabaseAdmin));
} else {
  logger.warn("Notifications routes disabled because Supabase is not configured");
}

// Question admin panel (passkey protected). Unguessable path keeps scanners away.
const ADMIN_PATH = process.env.ADMIN_PATH?.replace(/\/+$/, "");
if (ADMIN_PATH && /^\/[A-Za-z0-9_-]{8,}$/.test(ADMIN_PATH) && process.env.DATABASE_URL) {
  app.use(ADMIN_PATH, createAdminPanelRouter());
  logger.info("Admin panel enabled");
} else if (ADMIN_PATH || process.env.DATABASE_URL) {
  logger.warn(
    "Admin panel disabled: set ADMIN_PATH (e.g. /x7k2-panel, min 8 chars) and DATABASE_URL",
  );
}

// ============================================
// USER SOCKET MAPPING (appUserId -> socket.id)
// ============================================
const userSockets = new Map<string, string>(); // appUserId -> socket.id

// Socket.io Ping/Pong Configuration
// A dead connection is noticed after at most pingInterval + pingTimeout; until
// then its partner waits on the round, so these stay at socket.io's defaults.
const PING_INTERVAL = parseInt(process.env.SOCKET_PING_INTERVAL || "25000", 10);
const PING_TIMEOUT = parseInt(process.env.SOCKET_PING_TIMEOUT || "20000", 10);

// A player whose connection drops (app in the background while sharing the
// room code, a tunnel, a network switch) keeps their seat for a while. Mid-game
// the hold is short: the partner plays on with blank answers meanwhile.
const SEAT_HOLD_WAITING_MS = 2 * 60_000;
const SEAT_HOLD_PLAYING_MS = 30_000;
// socket.io gives a reconnecting app back its socket id (and so its seat) for
// this long. The app resumes from the last broadcast it received, which is
// only kept this long too, hence the regular connection-sync broadcast.
const RECOVERY_WINDOW_MS = 3 * 60_000;
const CONNECTION_SYNC_INTERVAL_MS = 30_000;
// Render sends SIGKILL 30 seconds after SIGTERM.
const SHUTDOWN_TIMEOUT_MS = 25_000;

// CORS Configuration
// For React Native only: leave empty or set to "REACT_NATIVE_ONLY"
// For Web + React Native: set to "*" or specific domains
// For Web only: set to specific domains (React Native will still work via user-agent check)

const CORS_ORIGIN_ENV = process.env.CORS_ORIGIN;
const CORS_ORIGIN = CORS_ORIGIN_ENV || "*";
// React Native only mode: explicitly set to empty string or "REACT_NATIVE_ONLY"
const IS_REACT_NATIVE_ONLY =
  CORS_ORIGIN_ENV === "" || CORS_ORIGIN_ENV === "REACT_NATIVE_ONLY";
const ALLOWED_ORIGINS = IS_REACT_NATIVE_ONLY
  ? [] // Empty means only React Native (no web origins allowed)
  : CORS_ORIGIN === "*"
    ? ["*"]
    : CORS_ORIGIN.split(",").map((origin) => origin.trim());

// Production mode CORS security check
if (process.env.NODE_ENV === "production") {
  if (IS_REACT_NATIVE_ONLY) {
    console.log(
      "✅ CORS configured for React Native only - web origins blocked",
    );
  } else if (CORS_ORIGIN === "*" || !process.env.CORS_ORIGIN) {
    console.warn(
      "⚠️  WARNING: CORS_ORIGIN is set to '*' or not specified in production mode.",
    );
    console.warn(
      "⚠️  This allows connections from any web origin. For React Native only, set CORS_ORIGIN to empty string or 'REACT_NATIVE_ONLY'.",
    );
  } else {
    console.log(`✅ CORS_ORIGIN configured for production: ${CORS_ORIGIN}`);
  }
}

// Check if origin is allowed (for Socket.IO connection)
function isOriginAllowed(
  origin: string | undefined,
  userAgent: string | undefined,
): boolean {
  // React Native apps and Socket.IO clients don't send origin header
  if (!origin) {
    // Check user-agent for React Native indicators
    const isReactNative =
      userAgent?.includes("ReactNative") ||
      userAgent?.includes("okhttp") || // Android
      userAgent?.includes("CFNetwork"); // iOS

    // React Native apps: always allow
    if (isReactNative) {
      return true;
    }

    // Socket.IO clients also don't send origin (normal behavior)
    // If React Native only mode, block non-React Native clients without origin
    if (IS_REACT_NATIVE_ONLY) {
      return false;
    }

    // If CORS_ORIGIN is "*", allow all (including Socket.IO clients)
    if (CORS_ORIGIN === "*") {
      return true;
    }

    // In development, allow requests without origin (for testing)
    if (process.env.NODE_ENV !== "production") {
      return true;
    }

    // In production with specific origins, allow Socket.IO clients (they don't send origin)
    // This is safe because Socket.IO has its own authentication mechanisms
    return true;
  }

  // If React Native only mode, block all web origins
  if (IS_REACT_NATIVE_ONLY) {
    return false; // Block web origins, React Native already handled above
  }

  // If "*" is allowed, allow all
  if (ALLOWED_ORIGINS.includes("*")) {
    return true;
  }

  // Check if origin is in allowed list
  return ALLOWED_ORIGINS.some((allowed) => {
    if (allowed === "*") return true;
    // Support wildcard domains like *.example.com
    if (allowed.startsWith("*.")) {
      const domain = allowed.substring(2);
      return origin.endsWith(domain);
    }
    return origin === allowed;
  });
}

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  {},
  SocketData
>(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // CORS callback doesn't have access to user-agent, so we check in allowRequest
      // For now, allow if origin is in allowed list or if "*" is set
      if (ALLOWED_ORIGINS.includes("*") || !origin) {
        callback(null, true);
      } else if (
        ALLOWED_ORIGINS.some((allowed) => {
          if (allowed === "*") return true;
          if (allowed.startsWith("*.")) {
            const domain = allowed.substring(2);
            return origin.endsWith(domain);
          }
          return origin === allowed;
        })
      ) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ["GET", "POST"],
    credentials: false,
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    const userAgent = req.headers["user-agent"];

    if (isOriginAllowed(origin, userAgent)) {
      callback(null, true);
    } else {
      console.warn(
        `🚫 Blocked connection attempt from origin: ${origin}, user-agent: ${userAgent}`,
      );
      callback(null, false);
    }
  },
  pingInterval: PING_INTERVAL,
  pingTimeout: PING_TIMEOUT,
  connectTimeout: parseInt(process.env.SOCKET_CONNECT_TIMEOUT || "10000", 10), // 10 seconds
  connectionStateRecovery: {
    maxDisconnectionDuration: RECOVERY_WINDOW_MS,
    skipMiddlewares: true,
  },
});

setInterval(
  () => io.emit("connection-sync"),
  CONNECTION_SYNC_INTERVAL_MS,
).unref();

// Redis-based room manager
const roomManager = new RoomManager();

const supportsTextQuestions = (clientFeatures: unknown): boolean =>
  Array.isArray(clientFeatures) &&
  clientFeatures.includes(CLIENT_FEATURE_TEXT_QUESTIONS);

const supportsServerCoins = (clientFeatures: unknown): boolean =>
  Array.isArray(clientFeatures) &&
  clientFeatures.includes(CLIENT_FEATURE_SERVER_COINS);

const supportsWhoIsMoreLikely = (clientFeatures: unknown): boolean =>
  Array.isArray(clientFeatures) &&
  clientFeatures.includes(CLIENT_FEATURE_WHO_IS_MORE_LIKELY);

const supportsReactions = (clientFeatures: unknown): boolean =>
  Array.isArray(clientFeatures) &&
  clientFeatures.includes(CLIENT_FEATURE_REACTIONS);

const supportsRankIt = (clientFeatures: unknown): boolean =>
  Array.isArray(clientFeatures) &&
  clientFeatures.includes(CLIENT_FEATURE_RANK_IT);

const supportsDailyAnalysis = (clientFeatures: unknown): boolean =>
  Array.isArray(clientFeatures) &&
  clientFeatures.includes(CLIENT_FEATURE_DAILY_ANALYSIS);

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

// register-user checks the token asynchronously; coin events wait for it.
const pendingRegistrations = new Map<string, Promise<unknown>>();

function bindSocketToUser(socket: AppSocket, appUserId: string): void {
  const previous = socket.data.appUserId;
  if (previous && previous !== appUserId && userSockets.get(previous) === socket.id) {
    userSockets.delete(previous);
  }
  socket.data.appUserId = appUserId;
  userSockets.set(appUserId, socket.id);
}

/**
 * The wallet this socket acts for, fixed by register-user (with the id's
 * token). A socket that never registered (older builds) can still use an id
 * nobody has claimed, and is bound to it from then on.
 *
 * Older builds can create two ids on a fresh install and register the socket
 * with one while spending with the other. An unclaimed id is open to any
 * connection anyway, so a socket bound to one follows the id it asks for; a
 * socket bound with a token never moves.
 */
/** Tells a banned player so and returns true; they can't create or join rooms. */
async function rejectIfBanned(socket: AppSocket): Promise<boolean> {
  await pendingRegistrations.get(socket.id);
  if (!(await isBanned(supabaseAdmin, socket.data.appUserId))) return false;
  console.warn(`🚫 Banned user ${socket.data.appUserId} blocked from rooms`);
  socket.emit("room-error", {
    message: "You've been removed from KnowUsBetter for violating our Terms of Use.",
    code: "USER_BANNED",
  });
  return true;
}

type AppUserResolution =
  | { appUserId: string }
  | { error: "unauthorized" | "unavailable" };

/** Like resolveAppUserId, but tells a database failure apart from a refusal. */
async function resolveAppUser(
  socket: AppSocket,
  claimed: unknown,
): Promise<AppUserResolution> {
  await pendingRegistrations.get(socket.id);
  if (!supabaseAdmin) return { error: "unavailable" };

  const unverified = socket.data.unverifiedRegistration;
  if (unverified && !socket.data.appUserId) {
    const check = await checkAppUser(supabaseAdmin, unverified.appUserId, unverified.token);
    if (check !== "error") socket.data.unverifiedRegistration = undefined;
    if (isAllowed(check) && !socket.disconnected) {
      bindSocketToUser(socket, unverified.appUserId);
    }
  }

  const bound = socket.data.appUserId;
  if (bound && (bound === claimed || !isValidAppUserId(claimed))) {
    return { appUserId: bound };
  }
  if (!isValidAppUserId(claimed)) return { error: "unauthorized" };
  // Its registration still can't be checked, so it can't be refused either.
  if (socket.data.unverifiedRegistration) return { error: "unavailable" };

  if (bound) {
    const boundCheck = await checkAppUser(supabaseAdmin, bound, undefined);
    if (boundCheck === "error" || !isAllowed(boundCheck)) return { appUserId: bound };
  }
  const check = await checkAppUser(supabaseAdmin, claimed, undefined);
  if (check === "error") return bound ? { appUserId: bound } : { error: "unavailable" };
  if (!isAllowed(check)) return bound ? { appUserId: bound } : { error: "unauthorized" };
  if (socket.disconnected) return { error: "unavailable" };
  bindSocketToUser(socket, claimed);
  return { appUserId: claimed };
}

async function resolveAppUserId(
  socket: AppSocket,
  claimed: unknown,
): Promise<string | null> {
  const resolution = await resolveAppUser(socket, claimed);
  return "appUserId" in resolution ? resolution.appUserId : null;
}

/** Wallet ids of the room's connected players; players that never registered are left out. */
function roomAppUserIds(room: Room): string[] {
  const ids = room.players
    .map((player) => io.sockets.sockets.get(player.id)?.data.appUserId)
    .filter((id): id is string => !!id);
  return [...new Set(ids)];
}

/** Pushes a balance the server changed to the user's app, if it's connected. */
function notifyCoinsSpent(appUserId: string, newBalance: number): void {
  findSocketByUserId(appUserId, io, userSockets)?.emit("coins-spent", {
    appUserId,
    newBalance,
    success: true,
  });
}

// ============================================
// GAME FLOW
// Rounds advance from answers and from the server's own round timer; both
// paths go through completeRound, and every room write holds the room lock.
// ============================================

// Apps send their own (possibly blank) answer when their timer runs out, so
// the server timer only closes rounds where an app stopped responding.
const ROUND_GRACE_SECONDS = 8;
// The first question appears after the app's start countdown.
const FIRST_ROUND_EXTRA_SECONDS = 5;
/** Stored for a player who never answered: never matches, grades as wrong, shows as "—". */
const NO_ANSWER = "";

const GAME_CANCELLED_MESSAGE =
  "A player left during the game. Game has been cancelled.";

const roundTimers = new Map<string, ReturnType<typeof setTimeout>>();

// room code -> what the host paid to start the game in progress. Kept off the
// room, which is sent to both players.
const gameStartCharges = new Map<string, { appUserId: string; amount: number }>();

/** Gives the host back the start cost of a game the server couldn't finish. */
async function refundGameStart(roomCode: string): Promise<void> {
  const charge = gameStartCharges.get(roomCode);
  gameStartCharges.delete(roomCode);
  if (!charge || !supabaseAdmin) return;
  try {
    const refund = await creditCoins(
      supabaseAdmin,
      charge.appUserId,
      charge.amount,
      "refund",
    );
    if (refund.ok) {
      notifyCoinsSpent(charge.appUserId, refund.newBalance);
      return;
    }
  } catch (error) {
    console.error(`❌ Game refund threw for ${charge.appUserId}:`, error);
  }
  console.error(
    `❌ Game refund failed for ${charge.appUserId} (${charge.amount} coins, room ${roomCode})`,
  );
}

type DailyAnalysisStart = {
  id: string;
  roomCode: string;
  topic: DailyTopic;
  players: { socketId: string; appUserId: string | null }[];
};

// room code -> the daily analysis the game in progress was started for.
const dailyAnalysisStarts = new Map<string, DailyAnalysisStart>();

/**
 * For a game that won't finish. A daily analysis gives its players their day
 * back and the host their coins; other games are only refunded when asked.
 */
async function endUnfinishedGame(roomCode: string, refund: boolean): Promise<void> {
  const daily = dailyAnalysisStarts.get(roomCode);
  dailyAnalysisStarts.delete(roomCode);
  if (daily && supabaseAdmin) await releaseDailyAnalysis(supabaseAdmin, daily.id);
  if (refund || daily) await refundGameStart(roomCode);
  else gameStartCharges.delete(roomCode);
}

type DailyAnalysisUpdate =
  | { id: string; status: "ready"; report: DailyAnalysisReport }
  | { id: string; status: "failed" };

/** To the game's sockets and to wherever its players are connected now. */
function emitDailyAnalysisUpdate(
  socketIds: string[],
  appUserIds: string[],
  update: DailyAnalysisUpdate,
): void {
  const targets = new Set(socketIds);
  for (const appUserId of appUserIds) {
    const socketId = userSockets.get(appUserId);
    if (socketId) targets.add(socketId);
  }
  for (const target of targets) io.to(target).emit("daily-analysis-update", update);
}

/** Writes the report of a finished daily analysis game and delivers it. */
async function deliverDailyAnalysis(daily: DailyAnalysisStart): Promise<void> {
  if (!supabaseAdmin) return;
  const socketIds = daily.players.map((p) => p.socketId);
  const appUserIds = daily.players
    .map((p) => p.appUserId)
    .filter((id): id is string => !!id);
  const lockKey = dailyAnalysisLockKey(daily.id);
  if (!(await acquireLock(lockKey, DAILY_ANALYSIS_LOCK_SECONDS))) return;
  try {
    const { report } = await writeDailyAnalysis(supabaseAdmin, daily.id);
    emitDailyAnalysisUpdate(socketIds, appUserIds, { id: daily.id, status: "ready", report });
    // Players still on the results screen see it there; the others get a push.
    const away = appUserIds.filter(
      (id) => !findSocketByUserId(id, io, userSockets)?.rooms.has(daily.roomCode),
    );
    if (away.length) await pushDailyAnalysisReady(supabaseAdmin, away, daily.id);
  } catch (error) {
    console.error(`❌ Daily analysis ${daily.id} failed:`, error);
    emitDailyAnalysisUpdate(socketIds, appUserIds, { id: daily.id, status: "failed" });
  } finally {
    await releaseLock(lockKey);
  }
}

type EarlyTextMatch = { answers: [string, string]; matched: boolean };

const isSameRound = (
  round: QuestionRound | null | undefined,
  questionId: string,
  startedAt: number | undefined,
): round is QuestionRound =>
  !!round && round.question.id === questionId && round.startedAt === startedAt;

/** An open round's answers stay hidden, or a player could read the partner's before answering. */
function withoutOpenAnswers(room: Room): Room {
  const round = room.currentRound;
  if (round?.status !== "waiting_answers") return room;
  return {
    ...room,
    currentRound: {
      ...round,
      answers: Object.fromEntries(Object.keys(round.answers).map((id) => [id, null])),
    },
  };
}

function newRound(room: Room, question: Question): QuestionRound {
  return {
    question,
    answers: Object.fromEntries(
      room.players.slice(0, 2).map((player) => [player.id, null]),
    ),
    isMatched: null,
    status: "waiting_answers",
    startedAt: Date.now(),
  };
}

function clearRoundTimer(roomCode: string): void {
  const timer = roundTimers.get(roomCode);
  if (timer) clearTimeout(timer);
  roundTimers.delete(roomCode);
}

function scheduleRoundTimeout(
  room: Room,
  round: QuestionRound,
  isFirstRound: boolean,
): void {
  const seconds =
    getQuestionDuration(room.settings, round.question) +
    ROUND_GRACE_SECONDS +
    (isFirstRound ? FIRST_ROUND_EXTRA_SECONDS : 0);
  clearRoundTimer(room.roomCode);
  roundTimers.set(
    room.roomCode,
    setTimeout(() => {
      roundTimers.delete(room.roomCode);
      closeUnansweredRound(
        room.roomCode,
        round.question.id,
        round.startedAt,
      ).catch(async (error) => {
        // Nothing else will close this round, so end the game instead of hanging.
        console.error(`❌ Round timeout failed in room ${room.roomCode}:`, error);
        await cancelStuckRound(room.roomCode, round.question.id, round.startedAt);
      });
    }, seconds * 1000),
  );
}

async function cancelStuckRound(
  roomCode: string,
  questionId: string,
  startedAt: number | undefined,
): Promise<void> {
  try {
    const reset = await roomManager.withRoomLock(roomCode, async () => {
      const room = await roomManager.getRoom(roomCode);
      const round = room?.currentRound;
      if (!isSameRound(round, questionId, startedAt) || round.status !== "waiting_answers") {
        return undefined;
      }
      return roomManager.resetRoom(roomCode);
    });
    if (reset === undefined) return;
    await endUnfinishedGame(roomCode, true);
    io.to(roomCode).emit("game-cancelled", {
      message: "An error occurred while processing answers. The game will be reset.",
      code: "SERVER_ERROR",
      room: reset,
    });
  } catch (error) {
    console.error(`❌ Couldn't cancel stuck round in room ${roomCode}:`, error);
  }
}

/** Leaves missing answers blank and completes the round. */
async function closeUnansweredRound(
  roomCode: string,
  questionId: string,
  startedAt: number | undefined,
): Promise<void> {
  const open = await roomManager.withRoomLock(roomCode, async () => {
    const room = await roomManager.getRoom(roomCode);
    const round = room?.currentRound;
    if (
      !room ||
      !isSameRound(round, questionId, startedAt) ||
      round.status !== "waiting_answers"
    ) {
      return false;
    }
    const missing = Object.keys(round.answers).filter(
      (playerId) => round.answers[playerId] === null,
    );
    if (missing.length > 0) {
      for (const playerId of missing) round.answers[playerId] = NO_ANSWER;
      await roomManager.updateRoom(room);
      console.log(
        `⏰ Round ${questionId} in room ${roomCode} timed out; ${missing.length} answer(s) left blank`,
      );
    }
    return true;
  });
  if (open) await completeRound(roomCode, questionId, startedAt);
}

/** Scores a round once every answer is in, sends the result and schedules what's next. */
async function completeRound(
  roomCode: string,
  questionId: string,
  startedAt: number | undefined,
  earlyTextMatch: EarlyTextMatch | null = null,
): Promise<void> {
  const snapshot = await roomManager.getRoom(roomCode);
  const round = snapshot?.currentRound;
  if (
    !snapshot ||
    !isSameRound(round, questionId, startedAt) ||
    round.status !== "waiting_answers"
  ) {
    return;
  }
  const answers = Object.values(round.answers);
  if (answers.some((answer) => answer === null)) return;

  if (answers.length !== 2) {
    console.error(
      `⚠️ Unexpected number of answers: ${answers.length} in room ${roomCode}`,
    );
    const reset = await roomManager.withRoomLock(roomCode, () =>
      roomManager.resetRoom(roomCode),
    );
    clearRoundTimer(roomCode);
    await endUnfinishedGame(roomCode, true);
    io.to(roomCode).emit("game-cancelled", {
      message: "An error occurred while processing answers. The game will be reset.",
      code: "SERVER_ERROR",
      room: reset,
    });
    return;
  }

  // Grading can call the model, so it runs outside the lock. Answers can't
  // change once all are in, so the result still holds when it's applied.
  const question = round.question;
  const [answer1, answer2] = answers;
  const isText = isTextQuestion(question);
  const answerKey = await getAnswerKey(question, supabaseAdmin);
  let isMatched = false;
  let correct: QuestionRound["correct"];
  let similarity: number | undefined;

  if (answerKey) {
    const grades = await Promise.all(
      Object.entries(round.answers).map(
        async ([playerId, value]) =>
          [
            playerId,
            takeGrade(roomCode, question.id, playerId, value) ??
              (await gradeAnswer(answerKey, question, value, HIDDEN_TEXT_ANSWER)),
          ] as const,
      ),
    );
    correct = Object.fromEntries(grades);
    // "Matched" for trivia = you both got it right.
    isMatched = grades.every(([, isCorrect]) => isCorrect);
  } else if (snapshot.settings.mode === "who_is_more_likely") {
    isMatched = picksAgree(answer1, answer2);
  } else if (snapshot.settings.mode === "rank_it") {
    similarity = rankingSimilarity(answer1, answer2, rankItemCount(question));
    // "Matched" for rank_it = the exact same order.
    isMatched = similarity === 100;
  } else if (answer1 === NO_ANSWER || answer2 === NO_ANSWER) {
    isMatched = false;
  } else if (isText) {
    const reuseEarly =
      earlyTextMatch !== null &&
      [answer1, answer2].sort().join("\u0000") ===
        [...earlyTextMatch.answers].sort().join("\u0000");
    isMatched = reuseEarly
      ? earlyTextMatch!.matched
      : await textAnswersMatch(question, answer1, answer2, HIDDEN_TEXT_ANSWER);
  } else if (typeof answer1 === "string" && typeof answer2 === "string") {
    isMatched = answer1 === answer2;
  } else if (
    typeof answer1 === "object" &&
    typeof answer2 === "object" &&
    answer1 !== null &&
    answer2 !== null
  ) {
    // Same option = same English text.
    isMatched = answer1.en === answer2.en;
  }

  const applied = await roomManager.withRoomLock(roomCode, async () => {
    const room = await roomManager.getRoom(roomCode);
    const current = room?.currentRound;
    if (
      !room ||
      !isSameRound(current, questionId, startedAt) ||
      current.status !== "waiting_answers"
    ) {
      return null;
    }
    current.isMatched = isMatched;
    current.isScored = true;
    current.status = "completed";
    if (answerKey && correct) {
      current.correct = correct;
      current.correctAnswer = revealAnswer(answerKey);
    }
    if (similarity !== undefined) current.similarity = similarity;
    room.totalQuestionsAnswered++;
    if (isMatched) room.matchScore++;
    room.players.forEach((player) => (player.hasAnswered = false));
    room.completedRounds.push(current);

    const isLast = room.currentQuestionIndex >= room.questions.length - 1;
    if (isLast) {
      room.status = "finished";
      room.currentRound = null;
    }
    await roomManager.updateRoom(room);
    return { room, round: current, isLast };
  });
  if (!applied) return;
  clearRoundTimer(roomCode);

  const { room, round: completed, isLast } = applied;
  void markQuestionsSeen(roomAppUserIds(room), [question.id], supabaseAdmin);
  const displayDuration = getResultDisplayDuration(room.settings, question);
  const percentage = getGamePercentage(room);

  io.to(roomCode).emit("round-completed", {
    allPlayersAnswered: true,
    isMatched,
    isScored: true,
    questionType: isText ? "text" : "choice",
    ...(similarity !== undefined && { similarity }),
    displayDuration,
    playerAnswers: room.players.map((player) => ({
      playerId: player.id,
      playerName: player.name,
      avatar: player.avatar,
      answer: completed.answers[player.id],
      ...(completed.correct && {
        isCorrect: completed.correct[player.id] === true,
      }),
    })),
    question: withRevealedAnswer(completed),
    matchScore: room.matchScore,
    totalQuestions: room.totalQuestionsAnswered,
    percentage,
    // Older app builds detect graded rounds by this exact value.
    ...(answerKey && { mode: "trivia" as const }),
  });

  setTimeout(() => {
    (isLast
      ? finishGame(roomCode)
      : advanceRound(roomCode, questionId, startedAt)
    ).catch((error) =>
      console.error(`❌ Failed to continue game in room ${roomCode}:`, error),
    );
  }, displayDuration * 1000);
}

/** After a round's result was shown: the next question, or the end. */
async function advanceRound(
  roomCode: string,
  completedQuestionId: string,
  startedAt: number | undefined,
): Promise<void> {
  type Outcome =
    | { kind: "next"; room: Room; round: QuestionRound }
    | { kind: "cancelled"; room: Room | null }
    | { kind: "finish" };

  const outcome = await roomManager.withRoomLock(
    roomCode,
    async (): Promise<Outcome | null> => {
      const room = await roomManager.getRoom(roomCode);
      const round = room?.currentRound;
      if (
        !room ||
        room.status !== "playing" ||
        !isSameRound(round, completedQuestionId, startedAt) ||
        round.status !== "completed"
      ) {
        return null;
      }
      if (room.players.length < 2) {
        return { kind: "cancelled", room: await roomManager.resetRoom(roomCode) };
      }
      const nextIndex = room.currentQuestionIndex + 1;
      const nextQuestion = room.questions[nextIndex];
      if (!nextQuestion) {
        room.status = "finished";
        room.currentRound = null;
        await roomManager.updateRoom(room);
        return { kind: "finish" };
      }
      room.currentQuestionIndex = nextIndex;
      room.currentRound = newRound(room, nextQuestion);
      await roomManager.updateRoom(room);
      return { kind: "next", room, round: room.currentRound };
    },
  );
  if (!outcome) return;

  if (outcome.kind === "cancelled") {
    await endUnfinishedGame(roomCode, false);
    io.to(roomCode).emit("game-cancelled", {
      message: GAME_CANCELLED_MESSAGE,
      code: "PLAYER_LEFT",
      room: outcome.room,
    });
    return;
  }
  if (outcome.kind === "finish") {
    await finishGame(roomCode);
    return;
  }

  const { room, round } = outcome;
  io.to(roomCode).emit("next-question", {
    question: round.question,
    currentQuestionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    serverTime: round.startedAt ?? Date.now(),
    duration: getQuestionDuration(room.settings, round.question),
  });
  scheduleRoundTimeout(room, round, false);
}

/**
 * Records the finished game (for the AI analysis), resets the room for a
 * replay and then sends the results, so "play again" always finds it ready.
 */
async function finishGame(roomCode: string): Promise<void> {
  const room = await roomManager.getRoom(roomCode);
  if (!room || room.status !== "finished") return;

  const mode =
    room.settings.mode ??
    (await getCategoryMode(room.settings.category, supabaseAdmin));
  let game: Awaited<ReturnType<typeof recordFinishedGame>> | null = null;
  try {
    game = await recordFinishedGame(
      room,
      mode,
      PUBLIC_RUNTIME_CONFIG.gameplay.results.matchTiers,
    );
  } catch (error) {
    console.error(`❌ Failed to build results for room ${roomCode}:`, error);
  }

  // Reset even without results, so the room can't stay stuck as "finished".
  const reset = await roomManager.withRoomLock(roomCode, async () => {
    const latest = await roomManager.getRoom(roomCode);
    return latest?.status === "finished"
      ? await roomManager.resetRoom(roomCode)
      : null;
  });

  const daily = game ? dailyAnalysisStarts.get(roomCode) : undefined;
  let dailyAnalysis: { id: string; status: "analyzing"; topic: DailyTopic } | undefined;
  if (game && daily) {
    dailyAnalysisStarts.delete(roomCode);
    const players = game.players.map((player, index) => ({
      appUserId: daily.players.find((p) => p.socketId === player.id)?.appUserId ?? null,
      name: player.name,
      avatar: player.avatar,
      isHost: index === 0,
    }));
    const saved =
      !!supabaseAdmin &&
      (await saveDailyAnalysisGame(supabaseAdmin, daily.id, game, players).then(
        () => true,
        (error) => {
          console.error(`❌ Couldn't save daily analysis game ${daily.id}:`, error);
          return false;
        },
      ));
    if (saved) {
      dailyAnalysis = { id: daily.id, status: "analyzing", topic: daily.topic };
    } else {
      if (supabaseAdmin) await releaseDailyAnalysis(supabaseAdmin, daily.id);
      await refundGameStart(roomCode);
    }
  }
  if (game && reset) gameStartCharges.delete(roomCode);

  if (!game) {
    if (reset) await endUnfinishedGame(roomCode, true);
    io.to(roomCode).emit("game-cancelled", {
      message: "We couldn't load the results of this game. Please play again.",
      code: "SERVER_ERROR",
      room: reset,
    });
    return;
  }

  io.to(roomCode).emit("game-finished", {
    gameId: game.gameId,
    mode,
    matchScore: game.matchScore,
    totalQuestions: game.totalQuestions,
    percentage: game.percentage,
    completedRounds: game.completedRounds,
    summary: game.summary,
    room: reset,
    ...(dailyAnalysis && { dailyAnalysis }),
  });
  if (dailyAnalysis && daily) {
    deliverDailyAnalysis(daily).catch((error) =>
      console.error(`❌ Daily analysis ${daily.id} delivery failed:`, error),
    );
  }
}

type ReportTarget = {
  roomCode: string;
  answer: unknown;
  reporterName: string;
  reportedName: string;
};

/** The reported answer from the player's room, or from their last finished game. */
async function findReportTarget(
  socketId: string,
  questionId: string,
  reportedPlayerId: string,
): Promise<ReportTarget | null> {
  const roomCode = await roomManager.getPlayerRoom(socketId);
  const room = roomCode ? await roomManager.getRoom(roomCode) : undefined;
  if (room) {
    const reporter = room.players.find((p) => p.id === socketId);
    const reported = room.players.find((p) => p.id === reportedPlayerId);
    const round = [
      ...room.completedRounds,
      ...(room.currentRound ? [room.currentRound] : []),
    ].find((r) => r.question.id === questionId);
    if (reporter && reported && round && reportedPlayerId in round.answers) {
      return {
        roomCode: room.roomCode,
        answer: round.answers[reportedPlayerId],
        reporterName: reporter.name,
        reportedName: reported.name,
      };
    }
  }

  // The last round's result is still on screen when the room resets for a replay.
  const game = await getLastFinishedGameOf(socketId);
  const reporter = game?.players.find((p) => p.id === socketId);
  const reported = game?.players.find((p) => p.id === reportedPlayerId);
  const answer = game?.completedRounds
    .find((r) => r.question.id === questionId)
    ?.playerAnswers.find((a) => a.playerId === reportedPlayerId);
  if (!game || !reporter || !reported || !answer) return null;
  return {
    roomCode: game.roomCode,
    answer: answer.answer,
    reporterName: reporter.name,
    reportedName: reported.name,
  };
}

/** Takes a player out of a room; a game in progress is cancelled and the room reset. */
async function removeFromRoom(
  roomCode: string,
  socketId: string,
): Promise<{ room: Room | null; cancelled: boolean }> {
  const result = await roomManager.withRoomLock(roomCode, async () => {
    const before = await roomManager.getRoom(roomCode);
    const cancelled =
      before?.status === "playing" &&
      before.players.some((player) => player.id === socketId);

    await roomManager.removePlayer(socketId);
    let room = (await roomManager.getRoom(roomCode)) ?? null;
    if (room && cancelled) room = (await roomManager.resetRoom(roomCode)) ?? room;
    if (room && room.players.length === 0) await roomManager.deleteRoom(roomCode);
    return { room, cancelled };
  });
  if (result.cancelled) clearRoundTimer(roomCode);
  if (result.cancelled || !result.room?.players.length) {
    // A restart isn't anyone's fault, so the host gets the start cost back.
    await endUnfinishedGame(roomCode, shuttingDown);
  }
  return result;
}

/** removeFromRoom, then tells whoever is still in the room. */
async function takePlayerOut(roomCode: string, socketId: string): Promise<boolean> {
  const { room, cancelled } = await removeFromRoom(roomCode, socketId);
  if (cancelled) {
    io.to(roomCode).emit("game-cancelled", {
      message: GAME_CANCELLED_MESSAGE,
      code: "PLAYER_LEFT",
      room,
    });
  }
  io.to(roomCode).emit("player-left", { playerId: socketId, room });
  return cancelled;
}

/**
 * Before creating or joining another room: a seat left behind would keep the
 * old room waiting on a player who's gone (and its host can't be replaced).
 */
async function leavePreviousRoom(socket: AppSocket, nextRoomCode?: string): Promise<void> {
  const previous = await roomManager.getPlayerRoom(socket.id);
  if (!previous || previous === nextRoomCode) return;
  socket.leave(previous);
  await takePlayerOut(previous, socket.id);
}

// socket id -> timer that frees the seat of a dropped player
const seatHolds = new Map<string, ReturnType<typeof setTimeout>>();
// Room cleanups still running; shutdown waits for them before closing Redis.
const pendingCleanups = new Set<Promise<void>>();
let shuttingDown = false;

function trackCleanup(task: Promise<unknown>): void {
  const settled = task.then(() => undefined).catch((error) =>
    console.error("❌ Error removing disconnected player:", error),
  );
  pendingCleanups.add(settled);
  settled.finally(() => pendingCleanups.delete(settled));
}

// The app left on purpose (or the server is going away): nothing to wait for.
const FINAL_DISCONNECT_REASONS = new Set([
  "client namespace disconnect",
  "server namespace disconnect",
  "server shutting down",
]);

async function freeSeat(
  socketId: string,
): Promise<{ roomCode: string; cancelled: boolean } | null> {
  // Reconnected in the meantime with the same socket id.
  if (io.sockets.sockets.has(socketId)) return null;
  const roomCode = await roomManager.getPlayerRoom(socketId);
  if (!roomCode) return null;
  return { roomCode, cancelled: await takePlayerOut(roomCode, socketId) };
}

async function handleDroppedPlayer(socketId: string, reason: string): Promise<void> {
  const roomCode = await roomManager.getPlayerRoom(socketId);
  if (!roomCode) return;
  if (shuttingDown || FINAL_DISCONNECT_REASONS.has(reason)) {
    await freeSeat(socketId);
    return;
  }
  const room = await roomManager.getRoom(roomCode);
  const status = room?.status ?? "unknown";
  const holdMs =
    room?.status === "playing" ? SEAT_HOLD_PLAYING_MS : SEAT_HOLD_WAITING_MS;
  console.log(
    `🪑 Holding seat of ${socketId} in room ${roomCode} (${status}) for ${holdMs / 1000}s`,
  );
  io.to(roomCode).emit("player-connection", { playerId: socketId, connected: false });
  clearTimeout(seatHolds.get(socketId));
  seatHolds.set(
    socketId,
    setTimeout(() => {
      seatHolds.delete(socketId);
      trackCleanup(
        freeSeat(socketId).then((freed) => {
          if (!freed) return;
          console.warn(
            `🪑 Seat of ${socketId} in room ${freed.roomCode} (${status}) freed: didn't come back within ${holdMs / 1000}s` +
              (freed.cancelled ? "; game cancelled" : ""),
          );
        }),
      );
    }, holdMs),
  );
}

/** What the app reports about its previous connection, as a log fragment. */
function describeClientDisconnect(info: unknown): string | null {
  if (!info || typeof info !== "object") return null;
  const { reason, backgrounded, backgroundSec, secAgo } = info as Record<string, unknown>;
  if (typeof reason !== "string") return null;
  const seconds = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}s` : "?";
  return (
    `client saw reason="${reason.slice(0, 40)}" ${seconds(secAgo)} ago, ` +
    `backgrounded=${backgrounded === true}` +
    (backgrounded === true ? ` (for ${seconds(backgroundSec)})` : "")
  );
}

/** A recovered socket is put back in its socket.io rooms even if its seat was freed. */
async function syncRecoveredRooms(socket: AppSocket): Promise<void> {
  const seat = await roomManager.getPlayerRoom(socket.id);
  for (const room of socket.rooms) {
    if (room !== socket.id && room !== seat) socket.leave(room);
  }
  if (seat) {
    socket.to(seat).emit("player-connection", { playerId: socket.id, connected: true });
  }
}

io.on(
  "connection",
  (
    socket: Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>,
  ) => {
    // IP bazlı socket limiti kontrolü
    const clientIP = getClientIP(socket);
    const socketLimitCheck = canCreateSocket(clientIP);

    if (!socketLimitCheck.allowed) {
      console.warn(
        `⚠️ Socket connection blocked for IP ${clientIP}: ${socketLimitCheck.reason}`,
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

    // Socket-level rate limiting
    attachSocketRateLimiter(socket);

    if (socket.recovered) {
      clearTimeout(seatHolds.get(socket.id));
      seatHolds.delete(socket.id);
      if (socket.data.appUserId) bindSocketToUser(socket, socket.data.appUserId);
      syncRecoveredRooms(socket).catch((error) =>
        console.error("❌ Error syncing recovered socket rooms:", error),
      );
      console.log(`🔁 User reconnected: ${socket.id} from IP: ${clientIP}`);
    } else {
      console.log(`✅ New user connected: ${socket.id} from IP: ${clientIP}`);
    }
    io.to(socket.id).emit("connection-sync");

    // Register user with appUserId
    // Older builds send just the id; current ones send { appUserId, token }.
    socket.on("register-user", (payload) => {
      const appUserId = typeof payload === "string" ? payload : payload?.appUserId;
      const token = typeof payload === "string" ? undefined : payload?.token;
      if (!isValidAppUserId(appUserId)) return;
      const lastDisconnect = describeClientDisconnect(
        typeof payload === "string" ? undefined : payload?.lastDisconnect,
      );
      if (lastDisconnect) {
        console.log(`📴 ${appUserId} on socket ${socket.id} is back: ${lastDisconnect}`);
      }

      if (!supabaseAdmin) return;
      socket.data.unverifiedRegistration = undefined;
      const registration = checkAppUser(supabaseAdmin, appUserId, token)
        .then((check) => {
          if (check === "error") {
            // Retried by the next wallet event instead of rejecting the player.
            socket.data.unverifiedRegistration = { appUserId, token };
            return;
          }
          if (!isAllowed(check)) {
            console.warn(
              `🚫 register-user for ${appUserId} rejected on socket ${socket.id}: missing or wrong token`,
            );
            return;
          }
          if (socket.disconnected) return;
          bindSocketToUser(socket, appUserId);
          console.log(`📝 User ${appUserId} registered with socket ${socket.id}`);
        })
        .catch((error) => console.error("❌ register-user failed:", error));
      pendingRegistrations.set(socket.id, registration);
      registration.finally(() => {
        if (pendingRegistrations.get(socket.id) === registration) {
          pendingRegistrations.delete(socket.id);
        }
      });
    });

    // 1. Create Room
    socket.on(
      "create-room",
      async ({ playerName, avatar, category, clientFeatures }: CreateRoomData) => {
        try {
          if (await rejectIfBanned(socket)) return;
          await leavePreviousRoom(socket);
          if (typeof category !== "string" || !category) {
            socket.emit("room-error", {
              message: "Failed to create room. Please try again.",
              code: "REQUEST_FAILED",
            });
            return;
          }
          const room = await roomManager.createRoom(
            socket.id,
            cleanPlayerName(playerName),
            cleanAvatar(avatar),
            category,
            supportsTextQuestions(clientFeatures),
            supportsServerCoins(clientFeatures),
            supportsWhoIsMoreLikely(clientFeatures),
            await getCategoryMode(category, supabaseAdmin),
            supportsReactions(clientFeatures),
            supportsRankIt(clientFeatures),
            supportsDailyAnalysis(clientFeatures),
          );
          socket.join(room.roomCode);

          socket.emit("room-created", {
            roomCode: room.roomCode,
            player: room.players[0],
            category: room.settings.category,
            // TODO: questionsCount: room.settings.questionsCount,
            // TODO: maxPlayers: room.settings.maxPlayers,
          });
        } catch (error) {
          console.error("Error creating room:", error);
          socket.emit("room-error", {
            message: "Failed to create room. Please try again.",
            code: "REQUEST_FAILED",
          });
        }
      },
    );

    // 2. Join Room
    socket.on(
      "join-room",
      async ({ roomCode, playerName, avatar, clientFeatures }: JoinRoomData) => {
        try {
          if (typeof roomCode !== "string" || !roomCode) {
            socket.emit("room-error", { message: "Room not found", code: "ROOM_NOT_FOUND" });
            return;
          }
          if (await rejectIfBanned(socket)) return;
          // Someone the host removed can't come back with the same code.
          if (
            await roomManager.isBlockedFromRoom(roomCode, [
              socket.id,
              socket.data.appUserId,
            ])
          ) {
            socket.emit("room-error", { message: "Room not found", code: "ROOM_NOT_FOUND" });
            return;
          }
          // Only once the target room exists, so a mistyped code doesn't
          // also cost the player the room they're in.
          if (await roomManager.getRoom(roomCode)) {
            await leavePreviousRoom(socket, roomCode);
          }
          const result = await roomManager.withRoomLock(roomCode, () =>
            roomManager.joinRoom(
              roomCode,
              socket.id,
              cleanPlayerName(playerName),
              cleanAvatar(avatar),
              supportsTextQuestions(clientFeatures),
              supportsServerCoins(clientFeatures),
              supportsWhoIsMoreLikely(clientFeatures),
              supportsReactions(clientFeatures),
              supportsRankIt(clientFeatures),
              supportsDailyAnalysis(clientFeatures),
            ),
          );

          if (result.success) {
            socket.join(roomCode);
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
            socket.emit("room-error", { message: result.error, code: result.code });
          }
        } catch (error) {
          console.error("Error joining room:", error);
          socket.emit("room-error", {
            message: "Failed to join room. Please try again.",
            code: "REQUEST_FAILED",
          });
        }
      },
    );

    // 3. Get Room Info
    socket.on("get-room", async ({ roomCode }: GetRoomData) => {
      try {
        const room =
          typeof roomCode === "string" && roomCode
            ? await roomManager.getRoom(roomCode)
            : undefined;
        if (room?.players.some((player) => player.id === socket.id)) {
          socket.emit("room-data", withoutOpenAnswers(room));
        } else if (room) {
          // Outsiders (e.g. a player whose seat was freed) only learn that
          // they're not in it; the app leaves the room when it sees that.
          socket.emit("room-data", {
            roomCode: room.roomCode,
            status: room.status,
            players: [],
          });
        } else {
          socket.emit("room-error", {
            message:
              "We couldn't find that room anymore. Please double-check the code.",
            code: "ROOM_NOT_FOUND",
          });
        }
      } catch (error) {
        console.error("Error getting room:", error);
        socket.emit("room-error", {
          message: "Failed to get room info. Please try again.",
          code: "REQUEST_FAILED",
        });
      }
    });

    // 4. Start Game
    socket.on("start-game", async ({ roomCode, appUserId, language }) => {
      // One start at a time, so a double tap can't charge the host twice.
      const startLockKey = `lock:start:${roomCode}`;
      if (!(await acquireLock(startLockKey, 20))) return;

      // Coins taken for this start; given back unless the game actually starts.
      let pendingCharge: { appUserId: string; amount: number } | null = null;
      // Likewise the players' day taken by a daily analysis.
      let pendingDailyClaim: string | null = null;
      let dailyLockKey: string | null = null;
      try {
        const room = await roomManager.getRoom(roomCode);

        if (!room) {
          socket.emit("critical-error", {
            message:
              "We couldn't find that room anymore. Please refresh and try again.",
            code: "ROOM_NOT_FOUND",
          });
          return;
        }

        // Check if user is host
        const player = room.players.find((p) => p.id === socket.id);
        if (!player?.isHost) {
          socket.emit("room-error", {
            message:
              "Only the host can start the game. Ping them when you're ready!",
            code: "NOT_HOST",
          });
          return;
        }

        // Check if we have at least 2 players
        if (room.players.length < 2) {
          socket.emit("room-error", {
            message: "Invite one more player and you'll be ready to go!",
            code: "NEED_PARTNER",
          });
          return;
        }

        // A dropped player keeps their seat for a while; don't start without them.
        if (!room.players.every((p) => io.sockets.sockets.has(p.id))) {
          socket.emit("room-error", {
            message:
              "Your partner's connection dropped. Give them a moment to come back.",
            code: "PARTNER_DISCONNECTED",
          });
          return;
        }

        // "finished" = the last result is still on screen; the room resets right after.
        if (room.status !== "waiting") {
          socket.emit("room-error", {
            message:
              "The game is already underway. Hang tight for the next round!",
            code: "GAME_IN_PROGRESS",
          });
          return;
        }

        try {
          // Fetch questions from Supabase
          if (!supabaseAdmin) {
            socket.emit("room-error", {
              message: "Database not configured. Please contact support.",
              code: "REQUEST_FAILED",
            });
            return;
          }

          const categoryMode = await getCategoryMode(
            room.settings.category,
            supabaseAdmin,
          );
          const moreLikely = categoryMode === "who_is_more_likely";
          const rankIt = categoryMode === "rank_it";
          const daily = categoryMode === "daily_analysis";

          // Older builds would show these questions as yes/no or multiple choice.
          const supportsMode = (p: Player) =>
            moreLikely
              ? p.supportsWhoIsMoreLikely === true
              : rankIt
                ? p.supportsRankIt === true
                : daily
                  ? p.supportsDailyAnalysis === true
                  : true;
          if (!room.players.every(supportsMode)) {
            socket.emit("room-error", {
              message:
                "Everyone in the room needs the latest app version to play this category.",
              code: supportsMode(player)
                ? "PARTNER_UPDATE_REQUIRED"
                : "UPDATE_REQUIRED",
            });
            return;
          }

          // Every player agreed on their device to their answers going to OpenAI.
          if (daily && !room.players.every((p) => p.aiConsent === true)) {
            socket.emit("room-error", {
              message: "Your partner needs to accept the daily analysis terms first.",
              code: "AI_CONSENT_REQUIRED",
            });
            return;
          }

          // A daily analysis is played on the host's next topic and takes the
          // day of every player in it, so nobody in the room may have used theirs.
          let dailyTopic: DailyTopic | null = null;
          let dailyPlayers: DailyAnalysisStart["players"] = [];
          let dailyHost: string | null = null;
          if (daily) {
            dailyHost = await resolveAppUserId(socket, appUserId);
            if (!dailyHost) {
              socket.emit("room-error", {
                message: "We couldn't check your coins. Please restart the app and try again.",
                code: "COINS_UNAVAILABLE",
              });
              return;
            }
            const lockKey = `lock:daily-start:${dailyHost}`;
            if (!(await acquireLock(lockKey, 20))) {
              socket.emit("room-error", {
                message: "Your daily analysis is already starting in another room.",
                code: "REQUEST_FAILED",
              });
              return;
            }
            dailyLockKey = lockKey;
            const host = dailyHost;
            dailyPlayers = room.players.map((p) => ({
              socketId: p.id,
              appUserId:
                p.id === socket.id
                  ? host
                  : io.sockets.sockets.get(p.id)?.data.appUserId ?? null,
            }));
            const status = await getDailyAnalysisStatus(supabaseAdmin, host);
            if (status.availableAt) {
              socket.emit("room-error", {
                message: "Your next daily analysis isn't ready yet.",
                code: "DAILY_ANALYSIS_COOLDOWN",
                availableAt: status.availableAt,
              });
              return;
            }
            for (const p of dailyPlayers) {
              if (!p.appUserId || p.appUserId === host) continue;
              const end = await getCooldownEnd(supabaseAdmin, p.appUserId);
              if (end) {
                socket.emit("room-error", {
                  message: "Your partner already had today's analysis.",
                  code: "DAILY_ANALYSIS_PARTNER_COOLDOWN",
                  availableAt: new Date(end).toISOString(),
                });
                return;
              }
            }
            dailyTopic = status.next;
            if (!dailyTopic) {
              socket.emit("room-error", {
                message: "Failed to load questions. Please try again.",
                code: "QUESTIONS_UNAVAILABLE",
              });
              return;
            }
          }

          const questions = await fetchRandomQuestions(
            dailyTopic ? dailyTopic.id : room.settings.category,
            rankIt
              ? RANK_IT_QUESTION_COUNT
              : dailyTopic
                ? DAILY_ANALYSIS_QUESTION_COUNT
                : room.settings.totalQuestions,
            supabaseAdmin,
            {
              // Votes and rankings are picked, never typed.
              includeText:
                !moreLikely &&
                !rankIt &&
                room.players.every((p) => p.supportsTextQuestions === true),
              appUserIds: roomAppUserIds(room),
              rankable: rankIt,
            },
          );

          // Check if we have questions
          if (!questions || questions.length === 0) {
            socket.emit("room-error", {
              message: "Failed to load questions. Please try again.",
              code: "QUESTIONS_UNAVAILABLE",
            });
            return;
          }

          const category = await getCategory(
            room.settings.category,
            supabaseAdmin,
          );
          const cost = category?.coinsRequired ?? 0;

          // Older builds spend the coins themselves after the countdown, which
          // a modified app can skip; turned off once those builds are gone.
          if (cost > 0 && !player.supportsServerCoins && !allowLegacyClients()) {
            socket.emit("room-error", {
              message:
                "Please update the app from the store to play this category.",
              code: "UPDATE_REQUIRED",
            });
            return;
          }

          // Hosts on current app builds pay here.
          if (player.supportsServerCoins) {
            if (cost > 0) {
              const payer = await resolveAppUserId(socket, appUserId);
              if (!payer) {
                socket.emit("room-error", {
                  message:
                    "We couldn't check your coins. Please restart the app and try again.",
                  code: "COINS_UNAVAILABLE",
                });
                return;
              }
              const spend = await spendCoins(
                supabaseAdmin,
                payer,
                cost,
                "game_start",
              );
              if (!spend.ok) {
                socket.emit(
                  "room-error",
                  spend.reason === "insufficient"
                    ? {
                        message: `Not enough coins. Required: ${cost}, Available: ${spend.balance}`,
                        code: "INSUFFICIENT_COINS",
                        required: cost,
                        balance: spend.balance,
                      }
                    : {
                        message: "Failed to start game. Please try again.",
                        code: "COINS_UNAVAILABLE",
                      },
                );
                return;
              }
              pendingCharge = { appUserId: payer, amount: cost };
              socket.emit("coins-spent", {
                appUserId: payer,
                newBalance: spend.newBalance,
                success: true,
              });
            }
          }

          if (dailyTopic && dailyHost) {
            pendingDailyClaim = await claimDailyAnalysis(supabaseAdmin, {
              hostAppUserId: dailyHost,
              participantIds: dailyPlayers
                .map((p) => p.appUserId)
                .filter((id): id is string => !!id),
              topic: dailyTopic,
              language: isLang(language) ? language : "en",
            });
          }

          // A category whose questions carry answer keys plays as who_knows_better.
          const mode = questions.some((q) => q.isTrivia)
            ? "who_knows_better"
            : categoryMode;

          // Re-read under the lock: someone may have left while questions loaded.
          const started = await roomManager.withRoomLock(roomCode, async () => {
            const latest = await roomManager.getRoom(roomCode);
            if (!latest || latest.players.length < 2) return "not_enough_players";
            if (
              latest.status !== "waiting" ||
              latest.settings.category !== room.settings.category
            ) {
              return "room_changed";
            }
            latest.questions = questions;
            latest.status = "playing";
            latest.settings.mode = mode;
            if (dailyTopic) latest.settings.dailyTopic = dailyTopic;
            else delete latest.settings.dailyTopic;
            latest.currentQuestionIndex = 0;
            latest.completedRounds = [];
            latest.matchScore = 0;
            latest.totalQuestionsAnswered = 0;
            latest.players.forEach((p) => (p.hasAnswered = false));
            latest.currentRound = newRound(latest, questions[0]);
            await roomManager.updateRoom(latest);
            return { room: latest, round: latest.currentRound };
          });
          if (typeof started === "string") {
            socket.emit("room-error", {
              message:
                started === "not_enough_players"
                  ? "Not enough players to start the game. Please wait for another player."
                  : "The room changed while the game was starting. Please try again.",
              code: started === "not_enough_players" ? "NEED_PARTNER" : "REQUEST_FAILED",
            });
            return;
          }
          if (pendingCharge) gameStartCharges.set(roomCode, pendingCharge);
          else gameStartCharges.delete(roomCode);
          pendingCharge = null;
          if (pendingDailyClaim && dailyTopic) {
            dailyAnalysisStarts.set(roomCode, {
              id: pendingDailyClaim,
              roomCode,
              topic: dailyTopic,
              players: dailyPlayers,
            });
          } else {
            dailyAnalysisStarts.delete(roomCode);
          }
          pendingDailyClaim = null;

          io.to(roomCode).emit("game-started", {
            room: started.room,
            question: started.round.question,
            // Can be below settings.totalQuestions when the category is short
            // (or text questions were filtered out for an older client).
            totalQuestions: questions.length,
            serverTime: started.round.startedAt ?? Date.now(),
            duration: getQuestionDuration(started.room.settings, started.round.question),
          });
          scheduleRoundTimeout(started.room, started.round, true);
        } catch (error) {
          console.error("Error starting game:", error);
          socket.emit("room-error", {
            message: "Failed to start game. Please try again.",
            code: "REQUEST_FAILED",
          });
        }
      } catch (error) {
        console.error("Error in start-game handler:", error);
        socket.emit("room-error", {
          message: "Failed to start game. Please try again.",
          code: "REQUEST_FAILED",
        });
      } finally {
        if (pendingCharge && supabaseAdmin) {
          const refund = await creditCoins(
            supabaseAdmin,
            pendingCharge.appUserId,
            pendingCharge.amount,
            "refund",
          );
          if (refund.ok) {
            socket.emit("coins-spent", {
              appUserId: pendingCharge.appUserId,
              newBalance: refund.newBalance,
              success: true,
            });
          } else {
            console.error(
              `❌ Game start refund failed for ${pendingCharge.appUserId}`,
            );
          }
        }
        if (pendingDailyClaim && supabaseAdmin) {
          await releaseDailyAnalysis(supabaseAdmin, pendingDailyClaim);
        }
        if (dailyLockKey) await releaseLock(dailyLockKey);
        await releaseLock(startLockKey);
      }
    });

    // 5. Submit Answer
    socket.on(
      "submit-answer",
      async ({ questionId, answer }: SubmitAnswerData) => {
        try {
          const roomCode = await roomManager.getPlayerRoom(socket.id);
          if (!roomCode) {
            socket.emit("critical-error", {
              message:
                "This game wrapped up already. We'll take you back so you can start a fresh one.",
              code: "GAME_INACTIVE",
            });
            return;
          }

          const room = await roomManager.getRoom(roomCode);
          // A late answer to a round the server already closed (e.g. after
          // its timer ran out) is dropped rather than treated as a desync.
          const isLateAnswer =
            !!room &&
            (room.status === "finished" ||
              room.completedRounds.some((r) => r.question.id === questionId));
          if (isLateAnswer && room?.currentRound?.question.id !== questionId) {
            return;
          }
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

          // Moderated before taking the lock so the API call never blocks the
          // partner's submit. If the partner already answered, the match check
          // runs alongside so the reveal doesn't wait for two calls in a row.
          let textAnswer: string | null = null;
          let earlyTextMatch: {
            answers: [string, string];
            matched: boolean;
          } | null = null;
          if (isTextQuestion(room.currentRound.question)) {
            const question = room.currentRound.question;
            textAnswer = normalizeTextAnswer(answer);
            const typed = textAnswer;
            const partnerAnswer = Object.entries(room.currentRound.answers).find(
              ([playerId, value]) =>
                playerId !== socket.id && typeof value === "string",
            )?.[1] as string | undefined;
            // Trivia grades each answer on its own, so there's no pair to match.
            const [harmful, matched, graded] = await Promise.all([
              typed ? isHarmfulText(typed) : false,
              !question.isTrivia && partnerAnswer !== undefined
                ? textAnswersMatch(
                    question,
                    typed,
                    partnerAnswer,
                    HIDDEN_TEXT_ANSWER,
                  )
                : null,
              question.isTrivia
                ? getAnswerKey(question, supabaseAdmin).then((key) =>
                    key
                      ? gradeAnswer(key, question, typed, HIDDEN_TEXT_ANSWER)
                      : null,
                  )
                : null,
            ]);
            if (harmful) {
              textAnswer = HIDDEN_TEXT_ANSWER;
            } else {
              if (matched !== null && partnerAnswer !== undefined) {
                earlyTextMatch = { answers: [typed, partnerAnswer], matched };
              }
              if (graded !== null) {
                rememberGrade(roomCode, questionId, socket.id, typed, graded);
              }
            }
          }

          const question = room.currentRound.question;
          let playerAnswer: string | MultiLanguageAnswer;
          if (isTextQuestion(question)) {
            playerAnswer = textAnswer ?? normalizeTextAnswer(answer);
          } else if (typeof answer !== "string") {
            playerAnswer = NO_ANSWER;
          } else if (room.settings.mode === "who_is_more_likely") {
            playerAnswer = isMoreLikelyPick(answer) ? answer : NO_ANSWER;
          } else if (room.settings.mode === "rank_it") {
            playerAnswer = parseRanking(answer, rankItemCount(question)) ?? NO_ANSWER;
          } else if (question.haveAnswers && question.answers) {
            const answerObject = findAnswerObject(answer, question);
            if (!answerObject && answer !== NO_ANSWER) {
              console.warn(
                `⚠️ Answer "${answer}" not found in question ${questionId} answers array. Saving as string.`,
              );
            }
            playerAnswer = answerObject ?? answer;
          } else {
            playerAnswer = answer;
          }

          // Only this round's players count, and only their first answer, so
          // neither the partner nor the round timer can overwrite it.
          let saved: {
            allAnswered: boolean;
            playerName?: string;
            startedAt?: number;
          } | null;
          try {
            saved = await roomManager.withRoomLock(roomCode, async () => {
              const lockedRoom = await roomManager.getRoom(roomCode);
              const round = lockedRoom?.currentRound;
              if (
                !lockedRoom ||
                !round ||
                round.status !== "waiting_answers" ||
                round.question.id !== questionId ||
                !(socket.id in round.answers) ||
                round.answers[socket.id] !== null
              ) {
                return null;
              }
              round.answers[socket.id] = playerAnswer;
              const player = lockedRoom.players.find((p) => p.id === socket.id);
              if (player) player.hasAnswered = true;
              await roomManager.updateRoom(lockedRoom);
              return {
                allAnswered: Object.values(round.answers).every((a) => a !== null),
                playerName: player?.name,
                startedAt: round.startedAt,
              };
            });
          } catch (error) {
            if (!(error instanceof LockTimeoutError)) throw error;
            // The round timer still closes the round, with this answer blank.
            console.error(
              `❌ Couldn't save answer in room ${roomCode}: room stayed locked`,
            );
            return;
          }
          if (!saved) return;

          socket.to(roomCode).emit("player-answered", {
            playerId: socket.id,
            playerName: saved.playerName,
          });

          if (saved.allAnswered) {
            // On failure the round timer retries the completion.
            await completeRound(
              roomCode,
              questionId,
              saved.startedAt,
              earlyTextMatch,
            ).catch((error) =>
              console.error("Error processing round completion:", error),
            );
          }
        } catch (error) {
          console.error("Error submitting answer:", error);
          socket.emit("critical-error", {
            message: "An error occurred while processing your answer.",
            code: "SUBMIT_ANSWER_ERROR",
          });
        }
      },
    );

    // 6. Kick Player (Host only)
    socket.on(
      "kick-player",
      async ({
        roomCode,
        targetPlayerId,
      }: {
        roomCode: string;
        targetPlayerId: string;
      }) => {
        try {
          if (typeof roomCode !== "string" || !roomCode) return;
          type KickResult =
            | { error: string; code: RoomErrorCode }
            | { requester: Player; targetPlayer: Player; updatedRoom: Room | undefined };
          const result = await roomManager.withRoomLock(roomCode, async (): Promise<KickResult> => {
            const room = await roomManager.getRoom(roomCode);
            if (!room) {
              return {
                error: "We couldn't locate that room. It may have just closed.",
                code: "ROOM_NOT_FOUND",
              };
            }
            const requester = room.players.find((p) => p.id === socket.id);
            if (!requester?.isHost) {
              return {
                error: "Only the host can remove players. Give them a nudge!",
                code: "NOT_HOST",
              };
            }
            const targetPlayer = room.players.find((p) => p.id === targetPlayerId);
            if (!targetPlayer) {
              return {
                error: "We couldn't find that player. They may have already left.",
                code: "PLAYER_NOT_FOUND",
              };
            }
            if (targetPlayerId === socket.id) {
              return { error: "You can't kick yourself—nice try though!", code: "CANNOT_KICK_SELF" };
            }
            if (room.status === "playing") {
              return {
                error: "You can only remove players while the game is waiting to start.",
                code: "GAME_IN_PROGRESS",
              };
            }

            await roomManager.blockFromRoom(roomCode, [
              targetPlayerId,
              io.sockets.sockets.get(targetPlayerId)?.data.appUserId,
            ]);
            await roomManager.removePlayer(targetPlayerId);
            const updatedRoom = await roomManager.getRoom(roomCode);
            if (updatedRoom && updatedRoom.players.length === 0) {
              await roomManager.deleteRoom(roomCode);
            }
            return { requester, targetPlayer, updatedRoom };
          });

          if ("error" in result) {
            socket.emit("room-error", { message: result.error, code: result.code });
            return;
          }

          const targetSocket = io.sockets.sockets.get(targetPlayerId);
          if (targetSocket) {
            targetSocket.leave(roomCode);
            targetSocket.emit("kicked-from-room", {
              message: `You were kicked from the room by ${result.requester.name}`,
              hostName: result.requester.name,
              roomCode: roomCode,
            });
          }

          io.to(roomCode).emit("player-kicked", {
            playerId: targetPlayerId,
            playerName: result.targetPlayer.name,
            room: result.updatedRoom,
          });
        } catch (error) {
          console.error("Error kicking player:", error);
          socket.emit("room-error", {
            message: "Failed to kick player. Please try again.",
            code: "REQUEST_FAILED",
          });
        }
      },
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

      if (!appUserId || !Number.isInteger(amount) || amount <= 0) {
        socket.emit("coins-spent", {
          appUserId,
          newBalance: 0,
          success: false,
          error: "Invalid request data",
        });
        return;
      }

      // A connection only spends from the wallet it registered with.
      if ((await resolveAppUserId(socket, appUserId)) !== appUserId) {
        console.warn(
          `🚫 spend-coins for ${appUserId} rejected: socket ${socket.id} is registered as another user`,
        );
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
          `💰 Processing coin spend: ${amount} coins for user ${appUserId}`,
        );

        const result = await spendCoins(
          supabaseAdmin,
          appUserId,
          amount,
          transactionType === "ai_analysis" ? "ai_analysis" : "game_start",
        );

        if (!result.ok) {
          if (result.reason === "insufficient") {
            console.warn(
              `⚠️ Not enough coins. Required: ${amount}, Available: ${result.balance}`,
            );
            socket.emit("coins-spent", {
              appUserId,
              newBalance: result.balance,
              success: false,
              error: `Not enough coins. Required: ${amount}, Available: ${result.balance}`,
            });
          } else {
            socket.emit("coins-spent", {
              appUserId,
              newBalance: 0,
              success: false,
              error: "Failed to update coins",
            });
          }
          return;
        }

        console.log(
          `✅ Coins spent successfully. New balance: ${result.newBalance}`,
        );
        socket.emit("coins-spent", {
          appUserId,
          newBalance: result.newBalance,
          success: true,
        });
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

    // 10. Claim Daily Reward
    socket.on("claim-daily-reward", async ({ appUserId }) => {
      if (
        !appUserId ||
        typeof appUserId !== "string" ||
        appUserId.trim() === ""
      ) {
        socket.emit("daily-reward-claimed", {
          appUserId,
          success: false,
          error: "invalid_user_id",
        });
        return;
      }

      if (!supabaseAdmin) {
        socket.emit("daily-reward-claimed", {
          appUserId,
          success: false,
          error: "server_error",
        });
        return;
      }

      try {
        const resolution = await resolveAppUser(socket, appUserId);
        if ("error" in resolution && resolution.error === "unavailable") {
          console.warn(
            `⚠️ claim-daily-reward for ${appUserId}: wallet check unavailable`,
          );
          socket.emit("daily-reward-claimed", {
            appUserId,
            success: false,
            error: "server_error",
          });
          return;
        }
        if (!("appUserId" in resolution) || resolution.appUserId !== appUserId) {
          console.warn(
            `🚫 claim-daily-reward for ${appUserId} rejected on socket ${socket.id}`,
          );
          socket.emit("daily-reward-claimed", {
            appUserId,
            success: false,
            error: "invalid_user_id",
          });
          return;
        }

        const { intervalMs, amount } = PUBLIC_RUNTIME_CONFIG.economy.dailyReward;
        const result = await claimDailyReward(supabaseAdmin, appUserId, {
          amount,
          intervalMs,
          unlimited: DEV_UNLIMITED_DAILY_REWARD,
        });

        if (!result.ok) {
          socket.emit("daily-reward-claimed", {
            appUserId,
            success: false,
            error: result.reason === "error" ? "server_error" : result.reason,
            ...(result.reason === "not_eligible_yet" && {
              nextClaimAt: result.nextClaimAt,
            }),
          });
          return;
        }

        console.log(
          `🎁 Daily reward claimed by ${appUserId}. New balance: ${result.newBalance}`,
        );

        socket.emit("daily-reward-claimed", {
          appUserId,
          success: true,
          newBalance: result.newBalance,
          nextClaimAt: result.nextClaimAt,
        });
      } catch (error) {
        console.error("❌ Error processing daily reward:", error);
        socket.emit("daily-reward-claimed", {
          appUserId,
          success: false,
          error: "server_error",
        });
      }
    });

    // Report a typed answer (App Store guideline 1.2: users must be able to
    // flag objectionable content). Stored for manual review.
    let reportsSent = 0;
    socket.on("report-answer", async (data, ack) => {
      const reply = (success: boolean) => {
        if (typeof ack === "function") ack({ success });
      };
      try {
        if (reportsSent >= MAX_REPORTS_PER_SOCKET) return reply(false);
        const questionId =
          typeof data?.questionId === "string" ? data.questionId : "";
        const reportedPlayerId =
          typeof data?.reportedPlayerId === "string"
            ? data.reportedPlayerId
            : "";
        if (!questionId || !reportedPlayerId || reportedPlayerId === socket.id) {
          return reply(false);
        }

        const target = await findReportTarget(socket.id, questionId, reportedPlayerId);
        if (!target) return reply(false);

        const rawAnswer = target.answer;
        const reportedAnswer =
          typeof rawAnswer === "string" ? rawAnswer : JSON.stringify(rawAnswer);

        reportsSent++;
        console.warn(
          `🚩 Answer reported in room ${target.roomCode}: "${reportedAnswer}" by ${target.reportedName}`,
        );

        if (supabaseAdmin) {
          const { error } = await supabaseAdmin.from("answer_reports").insert({
            room_code: target.roomCode,
            question_id: questionId,
            reported_answer: reportedAnswer,
            reported_name: target.reportedName,
            reporter_name: target.reporterName,
            reporter_app_user_id: socket.data.appUserId ?? null,
            reported_app_user_id:
              io.sockets.sockets.get(reportedPlayerId)?.data.appUserId ?? null,
            reason:
              typeof data?.reason === "string"
                ? data.reason.slice(0, 200)
                : null,
          });
          if (error) {
            console.error("Error saving answer report:", error);
            return reply(false);
          }
        }
        reply(true);
      } catch (error) {
        console.error("Error handling answer report:", error);
        reply(false);
      }
    });

    // Catches the app up on the shared AI analysis after it missed updates
    // (background, reconnect). Only players of that game get an answer.
    socket.on("get-ai-analysis", async (data, ack) => {
      if (typeof ack !== "function") return;
      try {
        const gameId = typeof data?.gameId === "string" ? data.gameId : "";
        const game = gameId ? await getFinishedGame(gameId) : null;
        if (!game?.players.some((player) => player.id === socket.id)) {
          return ack(null);
        }
        ack(await getAnalysisStateFor(game, socket.id));
      } catch (error) {
        console.error("Error reading AI analysis state:", error);
        ack(null);
      }
    });

    // A reaction to the partner during a game. The cooldown is taken first,
    // so a burst of taps can't charge more than once; it's given back when
    // the reaction couldn't be paid for.
    socket.on("send-reaction", async (data, ack) => {
      const reply = (result: SendReactionResult) => {
        if (typeof ack === "function") ack(result);
      };
      const cooldownKey = `reactionCooldown:${socket.id}`;
      let cooldownTaken = false;
      try {
        const { enabled, cooldownMs } = PUBLIC_RUNTIME_CONFIG.gameplay.reactions;
        const reactionId =
          typeof data?.reactionId === "string" ? data.reactionId : "";
        if (!enabled || !supabaseAdmin || !reactionId) {
          return reply({ ok: false, code: "UNAVAILABLE" });
        }

        const roomCode = await roomManager.getPlayerRoom(socket.id);
        const room = roomCode ? await roomManager.getRoom(roomCode) : undefined;
        if (
          !room ||
          room.status !== "playing" ||
          !room.players.some((player) => player.id === socket.id)
        ) {
          return reply({ ok: false, code: "NOT_IN_GAME" });
        }
        const partner = room.players.find((player) => player.id !== socket.id);
        if (!partner || !io.sockets.sockets.has(partner.id)) {
          return reply({ ok: false, code: "PARTNER_OFFLINE" });
        }
        if (!partner.supportsReactions) {
          return reply({ ok: false, code: "PARTNER_UPDATE_REQUIRED" });
        }

        const reaction = await getReaction(reactionId, supabaseAdmin);
        if (!reaction) return reply({ ok: false, code: "UNKNOWN_REACTION" });
        if (
          typeof data?.coinCost === "number" &&
          data.coinCost !== reaction.coinCost
        ) {
          return reply({ ok: false, code: "PRICE_CHANGED" });
        }

        cooldownTaken =
          (await redis.set(cooldownKey, "1", "PX", cooldownMs, "NX")) === "OK";
        if (!cooldownTaken) {
          const ttl = await redis.pttl(cooldownKey);
          return reply({
            ok: false,
            code: "COOLDOWN",
            retryAfterMs: ttl > 0 ? ttl : cooldownMs,
          });
        }

        let newBalance: number | undefined;
        if (reaction.coinCost > 0) {
          const payer = await resolveAppUserId(socket, data?.appUserId);
          const spend = payer
            ? await spendCoins(supabaseAdmin, payer, reaction.coinCost, "reaction")
            : null;
          if (!payer || !spend || !spend.ok) {
            await redis.del(cooldownKey);
            cooldownTaken = false;
            return reply(
              spend && !spend.ok && spend.reason === "insufficient"
                ? {
                    ok: false,
                    code: "INSUFFICIENT_COINS",
                    required: reaction.coinCost,
                    balance: spend.balance,
                  }
                : { ok: false, code: "COINS_UNAVAILABLE" },
            );
          }
          newBalance = spend.newBalance;
          notifyCoinsSpent(payer, spend.newBalance);
        }

        const id = randomUUID();
        socket.to(room.roomCode).emit("reaction-received", {
          id,
          reactionId: reaction.id,
          emoji: reaction.emoji,
          animation: reaction.animation,
          color: reaction.color,
          labels: reaction.labels,
          fromPlayerId: socket.id,
          sentAt: Date.now(),
        });
        reply({ ok: true, id, cooldownMs, newBalance });
      } catch (error) {
        console.error("Error sending reaction:", error);
        if (cooldownTaken) await redis.del(cooldownKey).catch(() => undefined);
        reply({ ok: false, code: "UNAVAILABLE" });
      }
    });

    // 8. On Disconnect
    socket.on("disconnect", (reason) => {
      const connectedSec = Math.round((Date.now() - socket.handshake.issued) / 1000);
      console.log(
        `🔌 Disconnected: ${socket.id} user=${socket.data.appUserId ?? "-"} reason="${reason}" ` +
          `transport=${socket.conn.transport.name} connectedFor=${connectedSec}s`,
      );

      // Clean up IP-based socket limiter
      unregisterSocket(socket.id);

      // Clean up appUserId mapping
      pendingRegistrations.delete(socket.id);
      const appUserId = socket.data.appUserId;
      // A reconnect may already have mapped the user to its new socket.
      if (appUserId && userSockets.get(appUserId) === socket.id) {
        userSockets.delete(appUserId);
        console.log(
          `📝 User ${appUserId} unregistered from socket ${socket.id}`,
        );
      }

      trackCleanup(handleDroppedPlayer(socket.id, reason));
    });
    // 11. Change Category (Host only, waiting room only)
    socket.on(
      "change-category",
      async ({
        roomCode,
        category,
      }: {
        roomCode: string;
        category: string;
      }) => {
        try {
          if (typeof roomCode !== "string" || !roomCode || typeof category !== "string") {
            socket.emit("room-error", { message: "Room not found", code: "ROOM_NOT_FOUND" });
            return;
          }
          const mode = await getCategoryMode(category, supabaseAdmin);
          const result = await roomManager.withRoomLock(
            roomCode,
            async (): Promise<{ error: string; code: RoomErrorCode } | { room: Room }> => {
            const room = await roomManager.getRoom(roomCode);
            if (!room) return { error: "Room not found", code: "ROOM_NOT_FOUND" };
            if (room.status !== "waiting") {
              return {
                error: "Cannot change category after game has started",
                code: "GAME_IN_PROGRESS",
              };
            }
            const player = room.players.find((p) => p.id === socket.id);
            if (!player?.isHost) {
              return { error: "Only the host can change the category", code: "NOT_HOST" };
            }
            room.settings.category = category;
            room.settings.mode = mode;
            await roomManager.updateRoom(room);
            return { room };
            },
          );

          if ("error" in result) {
            socket.emit("room-error", { message: result.error, code: result.code });
            return;
          }
          io.to(roomCode).emit("category-changed", { room: result.room });
        } catch (error) {
          console.error("Error changing category:", error);
          socket.emit("room-error", {
            message: "Failed to change category. Please try again.",
            code: "REQUEST_FAILED",
          });
        }
      },
    );

    // A player agreed on their device to the daily analysis sending their
    // answers to OpenAI; the host can't start one until everyone has.
    socket.on("ai-consent", async ({ roomCode }: { roomCode: string }) => {
      try {
        if (typeof roomCode !== "string" || !roomCode) return;
        const room = await roomManager.withRoomLock(roomCode, async () => {
          const current = await roomManager.getRoom(roomCode);
          const player = current?.players.find((p) => p.id === socket.id);
          if (!current || !player || player.aiConsent) return null;
          player.aiConsent = true;
          await roomManager.updateRoom(current);
          return current;
        });
        if (room) io.to(roomCode).emit("room-updated", { room });
      } catch (error) {
        console.error("Error saving AI consent:", error);
      }
    });

    socket.on("leave-room", async ({ roomCode }: { roomCode: string }) => {
      try {
        // The room the server has this player in wins over the one sent.
        const playerRoom = await roomManager.getPlayerRoom(socket.id);
        const targetRoom =
          playerRoom ?? (typeof roomCode === "string" ? roomCode : null);
        if (!targetRoom || !(await roomManager.getRoom(targetRoom))) {
          socket.emit("room-error", {
            message:
              "We couldn't find that room. It may have already been closed.",
            code: "ROOM_NOT_FOUND",
          });
          return;
        }

        socket.leave(targetRoom);
        await takePlayerOut(targetRoom, socket.id);
        socket.emit("room-left");
      } catch (error) {
        console.error("Error leaving room:", error);
        socket.emit("room-error", {
          message: "Failed to leave room. Please try again.",
          code: "REQUEST_FAILED",
        });
      }
    });
  },
);

// ============================================
// HEALTH CHECK & METRICS ENDPOINT
// ============================================
app.get(
  "/health",
  ipWhitelistMiddleware,
  healthRateLimiter,
  async (req, res) => {
    try {
      const socketCount = io.sockets.sockets.size;
      const connectionCount = io.engine.clientsCount || 0;
      const allRooms = await roomManager.getAllRooms();
      const roomsCount = allRooms.length;
      const totalPlayers = allRooms.reduce(
        (sum, room) => sum + room.players.length,
        0,
      );

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
  },
);

// ============================================
// GLOBAL ERROR HANDLERS - CRITICAL FOR PRODUCTION
// ============================================

// Handle uncaught exceptions (synchronous errors)
process.on("uncaughtException", (error: Error) => {
  console.error(
    "💥 UNCAUGHT EXCEPTION - Server will crash without this handler!",
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
const HOST = process.env.HOST || "0.0.0.0";

httpServer.listen(Number(PORT), HOST, () => {
  const serverUrl = process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL
    : process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${PORT}`;

  console.log(`\n🚀 Socket.io server running on ${HOST}:${PORT}`);
  console.log(`📱 Server URL: ${serverUrl}`);
  console.log(
    `📱 Connect from frontend: ${serverUrl
      .replace("http://", "ws://")
      .replace("https://", "wss://")}\n`,
  );
});

/**
 * Games can't survive a restart (round timers and reconnect sessions live in
 * this process), so players are told and taken out of their rooms; Redis is
 * closed only after that, or the cleanup would fail and leave rooms behind.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} received, shutting down gracefully...`);
  setTimeout(() => {
    console.error("⚠️ Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  for (const socket of io.sockets.sockets.values()) {
    if (socket.rooms.size > 1) {
      socket.emit("critical-error", {
        message: "The server is restarting. Please start a new game in a moment.",
        code: "SERVER_RESTARTING",
      });
    }
  }
  // Closing a connection drops what's still queued on it.
  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const timer of roundTimers.values()) clearTimeout(timer);
  roundTimers.clear();
  for (const [socketId, timer] of seatHolds) {
    clearTimeout(timer);
    trackCleanup(freeSeat(socketId));
  }
  seatHolds.clear();

  // Runs every socket's disconnect handler, which frees its seat.
  const httpClosed = new Promise<void>((resolve) => io.close(() => resolve()));
  while (pendingCleanups.size > 0) await Promise.all([...pendingCleanups]);
  console.log("✅ Rooms cleaned up");

  await httpClosed;
  await redis.quit().catch(() => undefined);
  console.log("✅ HTTP server and Redis closed");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
