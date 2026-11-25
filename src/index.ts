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
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { RoomManager } from "./roomManager.js";
import { normalizeRoomCode } from "./roomCodes.js";
import {
  actingPlayerId,
  deviceOf,
  isLocalRoom,
  advancesManually,
  MANUAL_ADVANCE_FALLBACK_SECONDS,
  localRoundSeconds,
  makeLocalPartner,
} from "./localPlay.js";
import {
  CreateRoomData,
  JoinRoomData,
  GetRoomData,
  SubmitAnswerData,
  SetLocalPartnerData,
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
  CLIENT_FEATURE_TWO_TRUTHS,
  CLIENT_FEATURE_SCALE,
  DailyTopic,
} from "./types.js";
import {
  fetchRandomQuestions,
  getAnswerKey,
  markQuestionsSeen,
} from "./services/questionService.js";
import {
  captureConsoleErrors,
  captureServerError,
  captureServerEvent,
  flushAnalytics,
} from "./services/analytics.js";
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
  uniquePlayerName,
  refundsUnfinishedGame,
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
import { createSupportRouter } from "./routes/support.js";
import {
  allowLegacyClients,
  checkAppUser,
  isAllowed,
  isNotableIdentity,
  isValidAppUserId,
  parseIdentityReport,
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
  CLAUDE_CONSENT_VERSION,
  everyoneAllowsClaude,
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
import { isClaudePaused } from "./services/claude.js";
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
import {
  buildTwoTruthsRounds,
  encodeStatements,
  isGuessRound,
  isWriteRound,
  parseGuess,
  parseSubmission,
  shuffleStatements,
  STATEMENT_MAX_LENGTH,
  TWO_TRUTHS_TURNS,
} from "./utils/twoTruths.js";
import { loadLies, renameLieAuthors, saveLie } from "./services/twoTruthsSecrets.js";
import {
  parseScaleValue,
  SCALE_QUESTION_COUNT,
  scaleSubjectSeat,
  scoreScaleRound,
} from "./utils/scale.js";
import { pickNextQuestion } from "./nextQuestion.js";
import { anyActivePass, getPassStatus } from "./services/unlimitedPass.js";

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
    onBalanceChanged: (appUserId, newBalance) =>
      notifyCoinsSpent(appUserId, newBalance),
    onPassChanged: (appUserId) => onPassChanged(appUserId),
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
  app.use("/api/support", createSupportRouter(supabaseAdmin));
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
// 90 s covers answering a message or a network switch (the server only
// notices a silent drop after pingInterval + pingTimeout on top of that).
const SEAT_HOLD_PLAYING_MS = 90_000;
// A host still alone in a new room has usually left the app to send the code,
// and the partner may first have to install the app. The room is kept open
// that long; the host takes their seat back on a new socket (reclaimSeat).
const SEAT_HOLD_ALONE_MS = 15 * 60_000;
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

// During a deploy Render runs the old and new instance side by side. Rooms
// live in Redis, but without a shared adapter a broadcast only reaches sockets
// on the instance that sent it (a partner joining on one instance went unseen
// by a host on the other). The streams adapter also keeps connection state
// recovery working across instances. XREAD blocks, so it gets its own client.
const adapterRedis = redis.duplicate({
  enableOfflineQueue: true,
  maxRetriesPerRequest: null,
});
adapterRedis.on("error", (err: Error) => console.error("❌ Adapter Redis error:", err));

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  {},
  SocketData
>(httpServer, {
  adapter: createAdapter(adapterRedis),
  // The largest thing an app sends is a short answer; socket.io's 1 MB default
  // would let one message fill Redis and every player's screen.
  maxHttpBufferSize: 64 * 1024,
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

const supportsTwoTruths = (clientFeatures: unknown): boolean =>
  Array.isArray(clientFeatures) &&
  clientFeatures.includes(CLIENT_FEATURE_TWO_TRUTHS);

const supportsScale = (clientFeatures: unknown): boolean =>
  Array.isArray(clientFeatures) &&
  clientFeatures.includes(CLIENT_FEATURE_SCALE);

captureConsoleErrors();

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
/** How long a room request waits for a register-user that may still be on its way. */
const REGISTRATION_WAIT_MS = 3000;

/** Waits for this socket's register-user, giving up after `timeoutMs`. */
async function awaitRegistration(socket: AppSocket, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!socket.data.appUserId && !socket.disconnected) {
    const pending = pendingRegistrations.get(socket.id);
    if (pending) {
      await pending;
      continue;
    }
    if (socket.data.unverifiedRegistration || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Tells a banned player so and returns true; they can't create or join rooms.
 * Bans are keyed on the wallet id, so once old builds are turned away a socket
 * has to prove its id first; skipping register-user would otherwise skip the ban.
 */
async function rejectIfBanned(socket: AppSocket): Promise<boolean> {
  await awaitRegistration(socket, allowLegacyClients() ? 0 : REGISTRATION_WAIT_MS);
  if (!socket.data.appUserId && socket.data.unverifiedRegistration) {
    // The database couldn't check its token; try once more before letting it in.
    await resolveAppUser(socket, socket.data.unverifiedRegistration.appUserId);
  }
  if (
    !socket.data.appUserId &&
    !socket.data.unverifiedRegistration &&
    !allowLegacyClients()
  ) {
    console.warn(`🚫 Room request from unregistered socket ${socket.id} refused`);
    socket.emit("room-error", {
      message: "Please update the app from the store to keep playing.",
      code: "UPDATE_REQUIRED",
    });
    return true;
  }
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

/**
 * The wallet a socket registered with, whichever instance it is connected to
 * (during a deploy the partner can sit on the other one).
 */
async function appUserIdOf(socketId: string): Promise<string | null> {
  const local = io.sockets.sockets.get(socketId);
  if (local) return local.data.appUserId ?? null;
  try {
    const [remote] = await io.in(socketId).fetchSockets();
    return remote?.data.appUserId ?? null;
  } catch {
    return null;
  }
}

/** Wallet ids of the room's connected players; players that never registered are left out. */
async function roomAppUserIds(room: Room): Promise<string[]> {
  const ids = await Promise.all(room.players.map((player) => appUserIdOf(player.id)));
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/** "boy" or "girl" from the avatar a player picked (boy_avatar_3, girl_avatar_7). */
const avatarStyle = (avatar: string | undefined): string | null => {
  const match = avatar?.match(/^(boy|girl)_avatar_/i);
  return match ? match[1].toLowerCase() : null;
};

/**
 * One event per game that really started, from the host: both players'
 * app user ids (so couples can be followed across games), how they play,
 * and who paid. Avatar styles are what they picked, not who they are.
 */
async function trackGameStarted(
  socket: AppSocket,
  claimedAppUserId: unknown,
  room: Room,
  charge: {
    listedCost: number;
    charged: number;
    passHolder: string | null;
    questionCount: number;
  },
): Promise<void> {
  const host = room.players.find((p) => p.isHost);
  const partner = room.players.find((p) => !p.isHost);
  const singlePhone = !!partner?.localOf;
  const hostId = await resolveAppUserId(socket, claimedAppUserId);
  const partnerId = partner && !singlePhone ? await appUserIdOf(partner.id) : null;
  const coupleId = singlePhone
    ? hostId && `${hostId}#local`
    : hostId && partnerId && [hostId, partnerId].sort().join("+");
  captureServerEvent(
    "server_game_started",
    { appUserId: hostId ?? undefined, socketId: socket.id },
    {
      room_code: room.roomCode,
      category: room.settings.category,
      mode: room.settings.mode,
      daily_topic: room.settings.dailyTopic?.id,
      play_mode: singlePhone ? "single_phone" : "two_phones",
      player_count: room.players.length,
      question_count: charge.questionCount,
      host_app_user_id: hostId,
      partner_app_user_id: partnerId,
      couple_id: coupleId || null,
      host_avatar: host?.avatar,
      host_avatar_style: avatarStyle(host?.avatar),
      partner_avatar: partner?.avatar,
      partner_avatar_style: avatarStyle(partner?.avatar),
      listed_cost: charge.listedCost,
      coins_charged: charge.charged,
      paid_by:
        charge.listedCost === 0
          ? "free"
          : charge.passHolder
            ? charge.passHolder === hostId
              ? "host_unlimited"
              : "partner_unlimited"
            : "host_coins",
    },
  );
}

/**
 * Puts a player's Unlimited pass on their seat, so both phones see that the
 * room plays paid categories for free.
 */
async function showPassInRoom(socketId: string, active: boolean): Promise<void> {
  const roomCode = await roomManager.getPlayerRoom(socketId);
  if (!roomCode) return;
  const room = await roomManager.withRoomLock(roomCode, async () => {
    const current = await roomManager.getRoom(roomCode);
    const player = current?.players.find((p) => p.id === socketId);
    if (!current || !player || !!player.hasUnlimited === active) return null;
    player.hasUnlimited = active;
    await roomManager.updateRoom(current);
    return current;
  });
  if (room) io.to(roomCode).emit("room-updated", { room });
}

/** A webhook changed someone's pass: tell their app and their room. */
function onPassChanged(appUserId: string): void {
  const socket = findSocketByUserId(appUserId, io, userSockets);
  if (!socket || !supabaseAdmin) return;
  socket.emit("unlimited-changed", { appUserId });
  getPassStatus(supabaseAdmin, appUserId)
    .then((status) => showPassInRoom(socket.id, status.active))
    .catch((error) => console.error("❌ Failed to show Unlimited in room:", error));
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
/**
 * What runs once a round's result has been shown: the next question or the
 * end of the game. On a timer, or on single phone when the host taps next.
 * Whoever takes the entry out of the map runs it, so it runs once.
 */
type PendingAdvance = {
  questionId: string;
  /** False if it already ran (or another round's result replaced it). */
  run: () => boolean;
  timer: ReturnType<typeof setTimeout>;
};
const pendingAdvances = new Map<string, PendingAdvance>();

function scheduleAdvance(
  roomCode: string,
  questionId: string,
  seconds: number,
  proceed: () => Promise<void>,
): void {
  const previous = pendingAdvances.get(roomCode);
  if (previous) clearTimeout(previous.timer);
  const entry: PendingAdvance = {
    questionId,
    run: () => {
      if (pendingAdvances.get(roomCode) !== entry) return false;
      clearTimeout(entry.timer);
      pendingAdvances.delete(roomCode);
      proceed().catch((error) =>
        console.error(`❌ Failed to continue game in room ${roomCode}:`, error),
      );
      return true;
    },
    timer: setTimeout(() => void entry.run(), seconds * 1000),
  };
  pendingAdvances.set(roomCode, entry);
}
/** `room:question:player` answers being checked on this instance; repeats are dropped. */
const answersInFlight = new Set<string>();

// room code -> what the host paid to start the game in progress. Kept off the
// room, which is sent to both players.
// Also written to Redis: after a crash this process's memory is gone, and the
// stale-game sweep still has to refund the host.
type GameStartCharge = { appUserId: string; amount: number };
const CHARGE_KEY_PREFIX = "game-start-charge:";
const CHARGE_TTL_SECONDS = 6 * 60 * 60;
const chargesInMemory = new Map<string, GameStartCharge>();
const gameStartCharges = {
  get: (roomCode: string) => chargesInMemory.get(roomCode),
  set(roomCode: string, charge: GameStartCharge) {
    chargesInMemory.set(roomCode, charge);
    redis
      .set(CHARGE_KEY_PREFIX + roomCode, JSON.stringify(charge), "EX", CHARGE_TTL_SECONDS)
      .catch((error) => console.error(`❌ Could not save the start charge of ${roomCode}:`, error));
  },
  delete(roomCode: string) {
    chargesInMemory.delete(roomCode);
    redis.del(CHARGE_KEY_PREFIX + roomCode).catch(() => undefined);
  },
  /** The charge, from memory or (after a restart) from Redis; removed either way. */
  async take(roomCode: string): Promise<GameStartCharge | undefined> {
    const local = chargesInMemory.get(roomCode);
    chargesInMemory.delete(roomCode);
    const key = CHARGE_KEY_PREFIX + roomCode;
    const stored = await redis.get(key).catch(() => null);
    await redis.del(key).catch(() => undefined);
    if (local) return local;
    try {
      const parsed = stored ? JSON.parse(stored) : null;
      return parsed && typeof parsed.appUserId === "string" && typeof parsed.amount === "number"
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  },
};

/** Gives the host back the start cost of a game the server couldn't finish. */
async function refundGameStart(roomCode: string): Promise<void> {
  const charge = await gameStartCharges.take(roomCode);
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
  players: { socketId: string; appUserId: string | null; aiConsentVersion?: number }[];
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
  const questionSeconds = getQuestionDuration(room.settings, round.question);
  const seconds =
    (isLocalRoom(room) ? localRoundSeconds(questionSeconds) : questionSeconds) +
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
  const answerKey = question.twoTruths
    ? null
    : await getAnswerKey(question, supabaseAdmin);
  let isMatched = false;
  let isScored = true;
  let correct: QuestionRound["correct"];
  let similarity: number | undefined;
  let lies: QuestionRound["lies"];

  if (isWriteRound(question)) {
    // Writing only sets up the guess round that follows.
    isScored = false;
  } else if (question.twoTruths?.phase === "guess") {
    const playerIds = Object.keys(round.answers);
    const statements = question.twoTruths.statements ?? {};
    const authors = playerIds.filter((id) => !!statements[id]);
    lies = await loadLies(roomCode, question.twoTruths.writeId, authors);
    correct = Object.fromEntries(
      playerIds.map((guesserId) => {
        const authorId = playerIds.find((id) => id !== guesserId);
        const lie = authorId === undefined ? undefined : lies![authorId];
        return [guesserId, lie !== undefined && round.answers[guesserId] === String(lie)];
      }),
    );
    // "Matched" for two_truths = you both caught each other's lie.
    isMatched = authors.length === 2 && Object.values(correct).every(Boolean);
  } else if (answerKey) {
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
  } else if (snapshot.settings.mode === "scale") {
    // Like know_each_other, rounds alternate who they're about.
    const subject = snapshot.players[scaleSubjectSeat(snapshot.currentQuestionIndex)];
    const guesser = snapshot.players.find((p) => p.id !== subject?.id);
    const outcome = scoreScaleRound(
      subject ? round.answers[subject.id] : null,
      guesser ? round.answers[guesser.id] : null,
    );
    similarity = outcome.closeness;
    isScored = outcome.isScored;
    // "Matched" for scale = the guess was spot on.
    isMatched = outcome.isMatched;
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
    current.isScored = isScored;
    current.status = "completed";
    if (answerKey && correct) {
      current.correct = correct;
      current.correctAnswer = revealAnswer(answerKey);
    }
    if (lies && correct) {
      current.correct = correct;
      current.lies = lies;
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
  // A guess round reuses its write round's question.
  if (!isGuessRound(question)) {
    void roomAppUserIds(room).then((ids) =>
      markQuestionsSeen(ids, [question.id], supabaseAdmin),
    );
  }
  const displayDuration = getResultDisplayDuration(room.settings, question);
  // Single phone: the players are side by side, so they move on when they're
  // done talking about it. A result that isn't shown (0 s) still moves on.
  const manualAdvance = displayDuration > 0 && advancesManually(room);
  const percentage = getGamePercentage(room);
  // With the button, the app shows the next question the moment it's tapped
  // instead of waiting for "next-question" (which then only confirms it).
  // Same question advanceRound will start: both come from pickNextQuestion.
  const upcoming = manualAdvance && !isLast ? pickNextQuestion(room, completed) : null;

  io.to(roomCode).emit("round-completed", {
    allPlayersAnswered: true,
    isMatched,
    isScored,
    questionType: isText ? "text" : "choice",
    ...(similarity !== undefined && { similarity }),
    ...(completed.lies && { lies: completed.lies }),
    displayDuration,
    ...(manualAdvance && { manualAdvance: true }),
    ...(upcoming && {
      nextQuestion: {
        question: upcoming.question,
        currentQuestionIndex: upcoming.index,
        totalQuestions: room.questions.length,
        duration: getQuestionDuration(room.settings, upcoming.question),
      },
    }),
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

  scheduleAdvance(
    roomCode,
    questionId,
    manualAdvance ? MANUAL_ADVANCE_FALLBACK_SECONDS : displayDuration,
    () => (isLast ? finishGame(roomCode) : advanceRound(roomCode, questionId, startedAt)),
  );
}

/** After a round's result was shown: the next question, or the end. */
async function advanceRound(
  roomCode: string,
  completedQuestionId: string,
  startedAt: number | undefined,
): Promise<void> {
  type Outcome =
    | { kind: "next"; room: Room; round: QuestionRound; skipped: string[] }
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
      const next = pickNextQuestion(room, round);
      if (!next) {
        room.status = "finished";
        room.currentRound = null;
        await roomManager.updateRoom(room);
        return { kind: "finish" };
      }
      const { statements } = next;
      room.currentQuestionIndex = next.index;
      room.currentRound = newRound(room, next.question);
      // A player whose partner wrote nothing has nothing to guess.
      const skipped: string[] = [];
      if (statements) {
        for (const guesserId of Object.keys(room.currentRound.answers)) {
          const authorId = Object.keys(statements).find((id) => id !== guesserId);
          if (authorId && statements[authorId]) continue;
          room.currentRound.answers[guesserId] = NO_ANSWER;
          const guesser = room.players.find((p) => p.id === guesserId);
          if (guesser) guesser.hasAnswered = true;
          skipped.push(guesserId);
        }
      }
      await roomManager.updateRoom(room);
      return { kind: "next", room, round: room.currentRound, skipped };
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

  const { room, round, skipped } = outcome;
  io.to(roomCode).emit("next-question", {
    question: round.question,
    currentQuestionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    serverTime: round.startedAt ?? Date.now(),
    duration: getQuestionDuration(room.settings, round.question),
  });
  for (const playerId of skipped) {
    const partner = room.players.find((p) => p.id !== playerId);
    if (partner) {
      io.to(partner.id).emit("player-answered", {
        playerId,
        playerName: room.players.find((p) => p.id === playerId)?.name,
      });
    }
  }
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
      aiConsentVersion: daily.players.find((p) => p.socketId === player.id)?.aiConsentVersion,
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

/**
 * A game whose round hasn't moved for this long has lost its round timer: the
 * process that owned it died without its shutdown cleanup (OOM, kill -9, an
 * instance crash). Longer than any round (single-phone two truths included).
 */
const STALE_GAME_MS = parseInt(process.env.STALE_GAME_MS || "600000", 10);
const STALE_SWEEP_INTERVAL_MS = parseInt(process.env.STALE_SWEEP_INTERVAL_MS || "60000", 10);

/** Cancels games left `playing` with no live round timer anywhere. */
async function sweepStaleGames(): Promise<void> {
  if (shuttingDown) return;
  const now = Date.now();
  for (const room of await roomManager.getAllRooms()) {
    if (room.status !== "playing") continue;
    const startedAt = room.currentRound?.startedAt;
    if (typeof startedAt !== "number" || now - startedAt < STALE_GAME_MS) continue;
    const reset = await roomManager.withRoomLock(room.roomCode, async () => {
      const fresh = await roomManager.getRoom(room.roomCode);
      if (fresh?.status !== "playing" || fresh.currentRound?.startedAt !== startedAt) return null;
      return roomManager.resetRoom(room.roomCode);
    });
    if (!reset) continue;
    clearRoundTimer(room.roomCode);
    await endUnfinishedGame(room.roomCode, true);
    console.warn(`🧹 Room ${room.roomCode}: game stuck since ${new Date(startedAt).toISOString()}, cancelled`);
    io.to(room.roomCode).emit("game-cancelled", {
      message: "This game was interrupted by a server problem. Please start a new one.",
      code: "SERVER_ERROR",
      room: reset,
    });
  }
}

setInterval(() => {
  sweepStaleGames().catch((error) => console.error("❌ Stale game sweep failed:", error));
}, STALE_SWEEP_INTERVAL_MS).unref();

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
/**
 * `timedOutUser`: the seat is freed because this user never came back (not a
 * choice), so the game start is refunded unless that user is the one who paid.
 */
async function removeFromRoom(
  roomCode: string,
  socketId: string,
  timedOutUser?: string | null,
): Promise<{ room: Room | null; cancelled: boolean }> {
  const result = await roomManager.withRoomLock(roomCode, async () => {
    const before = await roomManager.getRoom(roomCode);
    const cancelled =
      before?.status === "playing" &&
      before.players.some((player) => player.id === socketId);
    // Read before the reset below clears them. Rounds the leaving player
    // really answered: while they're gone the game goes on with blank rounds,
    // which say nothing about how much of it they had.
    const roundsPlayed = (before?.completedRounds ?? []).filter((round) => {
      const answer = round.answers?.[socketId];
      return answer !== undefined && answer !== null && answer !== "";
    }).length;
    const totalRounds = before?.questions?.length || before?.settings?.totalQuestions || 0;

    await roomManager.removePlayer(socketId);
    let room = (await roomManager.getRoom(roomCode)) ?? null;
    if (room && cancelled) room = (await roomManager.resetRoom(roomCode)) ?? room;
    if (room && room.players.length === 0) await roomManager.deleteRoom(roomCode);
    return { room, cancelled, roundsPlayed, totalRounds };
  });
  if (result.cancelled) clearRoundTimer(roomCode);
  if (result.cancelled || !result.room?.players.length) {
    // A restart isn't anyone's fault, and neither is the partner's lost
    // connection, so the host gets the start cost back. Only while most of
    // the game is still unplayed: otherwise a second phone switched off near
    // the end would make every paid game free.
    const payer = gameStartCharges.get(roomCode)?.appUserId;
    const partnerTimedOut =
      result.cancelled &&
      timedOutUser !== undefined &&
      (!payer || payer !== timedOutUser) &&
      refundsUnfinishedGame(result.roundsPlayed, result.totalRounds);
    await endUnfinishedGame(roomCode, shuttingDown || partnerTimedOut);
  }
  return { room: result.room, cancelled: result.cancelled };
}

/** removeFromRoom, then tells whoever is still in the room. */
async function takePlayerOut(
  roomCode: string,
  socketId: string,
  timedOutUser?: string | null,
): Promise<boolean> {
  const { room, cancelled } = await removeFromRoom(roomCode, socketId, timedOutUser);
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
  timedOutUser?: string | null,
): Promise<{ roomCode: string; cancelled: boolean } | null> {
  // Reconnected in the meantime with the same socket id.
  if (io.sockets.sockets.has(socketId)) return null;
  const roomCode = await roomManager.getPlayerRoom(socketId);
  if (!roomCode) return null;
  return { roomCode, cancelled: await takePlayerOut(roomCode, socketId, timedOutUser) };
}

async function handleDroppedPlayer(
  socketId: string,
  reason: string,
  appUserId: string | null = null,
): Promise<void> {
  const roomCode = await roomManager.getPlayerRoom(socketId);
  if (!roomCode) return;
  if (shuttingDown || FINAL_DISCONNECT_REASONS.has(reason)) {
    await freeSeat(socketId);
    return;
  }
  const room = await roomManager.getRoom(roomCode);
  const status = room?.status ?? "unknown";
  const alone =
    room?.status === "waiting" &&
    room.players.every((player) => deviceOf(player) === socketId);
  const holdMs =
    room?.status === "playing"
      ? SEAT_HOLD_PLAYING_MS
      : alone
        ? SEAT_HOLD_ALONE_MS
        : SEAT_HOLD_WAITING_MS;
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
        freeSeat(socketId, appUserId).then((freed) => {
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

/** Whether a socket is connected to this or another instance (during a deploy both run). */
async function isConnectedAnywhere(socketId: string): Promise<boolean> {
  if (io.sockets.sockets.has(socketId)) return true;
  try {
    return (await io.in(socketId).fetchSockets()).length > 0;
  } catch {
    return false;
  }
}

/** Remembers whose seat this socket holds, so the user can take it back from a new socket. */
async function recordSeatOwner(socket: AppSocket, roomCode: string): Promise<void> {
  await pendingRegistrations.get(socket.id);
  const appUserId = socket.data.appUserId;
  if (!appUserId) return;
  await roomManager
    .setSeatOwner(roomCode, appUserId, socket.id)
    .catch((error) => console.error(`❌ Failed to record seat owner in ${roomCode}:`, error));
}

/**
 * Whether the socket holding this user's seat is one the new socket replaces:
 * gone, or still looking connected because the server hasn't noticed the drop
 * the app reports (that takes up to pingInterval + pingTimeout).
 */
async function isReplacedSocket(socket: AppSocket, oldSocketId: string): Promise<boolean> {
  if (!(await isConnectedAnywhere(oldSocketId))) return true;
  const drop = socket.data.reportedDrop;
  if (!drop) return false;
  // Newer builds name the socket that dropped; older ones only report a drop.
  return drop.previousSocketId === undefined || drop.previousSocketId === oldSocketId;
}

/**
 * A player whose socket was replaced (a network drop, or back after the
 * recovery window) takes their seat back, in the waiting room or mid-game.
 * Returns the room when they did.
 */
async function reclaimSeat(socket: AppSocket, roomCode: string): Promise<Room | null> {
  await pendingRegistrations.get(socket.id);
  const appUserId = socket.data.appUserId;
  if (!appUserId) return null;
  const oldSocketId = await roomManager.getSeatOwner(roomCode, appUserId);
  // A seat still in use by a connected socket isn't free to take.
  if (!oldSocketId || oldSocketId === socket.id || !(await isReplacedSocket(socket, oldSocketId))) {
    return null;
  }
  // Leaving another room first, like a join, but outside this room's lock.
  const previous = await roomManager.getPlayerRoom(socket.id);
  if (previous && previous !== roomCode) await leavePreviousRoom(socket, roomCode);
  const moved = await roomManager.withRoomLock(roomCode, () =>
    roomManager.reclaimSeat(roomCode, appUserId, oldSocketId, socket.id),
  );
  if (!moved) return null;
  const { room, renames } = moved;
  clearTimeout(seatHolds.get(oldSocketId));
  seatHolds.delete(oldSocketId);
  socket.join(roomCode);
  if (room.status !== "waiting") {
    await renameLieAuthors(roomCode, renames).catch((error) =>
      console.error(`❌ Failed to move two_truths lies in ${roomCode}:`, error),
    );
    const daily = dailyAnalysisStarts.get(roomCode);
    for (const player of daily?.players ?? []) {
      player.socketId = renames[player.socketId] ?? player.socketId;
    }
  }
  // The old socket is dead but the server hasn't noticed; its seat has moved,
  // so closing it now frees nothing.
  io.in(oldSocketId).disconnectSockets(true);
  console.log(
    `🪑 ${appUserId} took their seat in ${roomCode} (${room.status}) back: ${oldSocketId} -> ${socket.id}`,
  );
  captureServerEvent(
    "server_seat_reclaimed",
    { appUserId, socketId: socket.id },
    { room_code: roomCode, player_count: room.players.length, room_status: room.status },
  );
  socket.to(roomCode).emit("room-updated", { room: withoutOpenAnswers(room) });
  socket.to(roomCode).emit("player-connection", { playerId: socket.id, connected: true });
  return room;
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
      captureServerEvent(
        "server_socket_recovered",
        { appUserId: socket.data.appUserId, socketId: socket.id },
        { transport: socket.conn.transport.name },
      );
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
        const info = (payload as { lastDisconnect?: Record<string, unknown> }).lastDisconnect;
        captureServerEvent(
          "server_client_reconnected",
          { appUserId, socketId: socket.id },
          {
            client_reason: typeof info?.reason === "string" ? info.reason.slice(0, 40) : undefined,
            client_backgrounded: info?.backgrounded === true,
            client_background_sec:
              typeof info?.backgroundSec === "number" ? Math.round(info.backgroundSec) : undefined,
            offline_sec: typeof info?.secAgo === "number" ? Math.round(info.secAgo) : undefined,
          },
        );
      }
      const reportedPrevious =
        typeof payload === "string" ? undefined : payload?.previousSocketId;
      socket.data.reportedDrop = lastDisconnect
        ? {
            previousSocketId:
              typeof reportedPrevious === "string" && reportedPrevious.length <= 64
                ? reportedPrevious
                : undefined,
          }
        : undefined;
      const identity = parseIdentityReport(
        typeof payload === "string" ? undefined : payload?.identity,
      );
      if (identity && isNotableIdentity(identity)) {
        console.log(
          `🪪 ${appUserId} on socket ${socket.id}: source=${identity.source} keychain=${identity.keychain}`,
        );
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
            supportsTwoTruths(clientFeatures),
            supportsScale(clientFeatures),
          );
          socket.join(room.roomCode);
          await recordSeatOwner(socket, room.roomCode);

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
      async ({ roomCode: typedCode, playerName, avatar, clientFeatures }: JoinRoomData) => {
        try {
          const roomCode = typeof typedCode === "string" ? normalizeRoomCode(typedCode) : "";
          if (!roomCode) {
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
          // Set when no room has this code but one had it until recently.
          let closedAt: number | null = null;
          // Only once the target room exists, so a mistyped code doesn't
          // also cost the player the room they're in.
          if (await roomManager.getRoom(roomCode)) {
            // Back on a new socket: their old seat, not a second one.
            const reclaimed = await reclaimSeat(socket, roomCode);
            if (reclaimed) {
              const player = reclaimed.players.find((p) => p.id === socket.id);
              socket.emit("room-joined", {
                roomCode,
                player,
                room: withoutOpenAnswers(reclaimed),
              });
              return;
            }
            await leavePreviousRoom(socket, roomCode);
          } else {
            closedAt = await roomManager.getRoomClosedAt(roomCode);
            captureServerEvent(
              "server_room_not_found",
              { appUserId: socket.data.appUserId, socketId: socket.id },
              {
                room_code: roomCode,
                typed_code: typedCode,
                room_closed: closedAt !== null,
                closed_sec_ago:
                  closedAt !== null ? Math.round((Date.now() - closedAt) / 1000) : undefined,
              },
            );
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
              supportsTwoTruths(clientFeatures),
              supportsScale(clientFeatures),
            ),
          );

          if (result.success) {
            socket.join(roomCode);
            await recordSeatOwner(socket, roomCode);
            // Send info to joined player
            socket.emit("room-joined", {
              roomCode,
              player: result.player,
              room: result.room,
            });
            // A host who stepped away (sharing the code) shows as away from the start.
            for (const player of result.room?.players ?? []) {
              if (player.localOf || player.id === socket.id) continue;
              if (!(await isConnectedAnywhere(player.id))) {
                socket.emit("player-connection", { playerId: player.id, connected: false });
              }
            }

            // Notify other players in the room
            socket.to(roomCode).emit("player-joined", {
              player: result.player,
              room: result.room,
            });
          } else {
            socket.emit("room-error", {
              message: result.error,
              code: result.code,
              // Only for a code that really was a room: its players have all
              // left (or it closed in a restart). A code that never existed
              // stays a plain ROOM_NOT_FOUND.
              ...(result.code === "ROOM_NOT_FOUND" && closedAt !== null && { closed: true }),
            });
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
    // The app checks a connection that may have died unnoticed (after the
    // network or the app came back) by asking for an answer within seconds.
    socket.on("app-ping", (ack) => {
      if (typeof ack === "function") ack();
    });

    socket.on("get-room", async ({ roomCode }: GetRoomData) => {
      try {
        let room =
          typeof roomCode === "string" && roomCode
            ? await roomManager.getRoom(roomCode)
            : undefined;
        if (room && !room.players.some((player) => player.id === socket.id)) {
          room = (await reclaimSeat(socket, room.roomCode)) ?? room;
        }
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
        // The partner may be connected to the other instance during a deploy.
        const connected = await Promise.all(
          room.players.map((p) => isConnectedAnywhere(deviceOf(p))),
        );
        if (!connected.every(Boolean)) {
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
          const twoTruths = categoryMode === "two_truths";
          const scale = categoryMode === "scale";

          // Older builds would show these questions as yes/no or multiple choice.
          const supportsMode = (p: Player) =>
            moreLikely
              ? p.supportsWhoIsMoreLikely === true
              : rankIt
                ? p.supportsRankIt === true
                : daily
                  ? p.supportsDailyAnalysis === true
                  : twoTruths
                    ? p.supportsTwoTruths === true
                    : scale
                      ? p.supportsScale === true
                      : true;
          if (!room.players.every(supportsMode)) {
            socket.emit("room-error", {
              message:
                "Everyone in the room needs the latest app version to play this category.",
              code: supportsMode(player)
                ? "PARTNER_UPDATE_REQUIRED"
                : "UPDATE_REQUIRED",
              // Tells the app to explain that this category needs an update.
              reason: "category",
            });
            return;
          }

          // Every player agreed on their device to their answers going to the AI provider.
          if (daily && !room.players.every((p) => p.aiConsent === true)) {
            socket.emit("room-error", {
              message: "Your partner needs to accept the daily analysis terms first.",
              code: "AI_CONSENT_REQUIRED",
            });
            return;
          }

          // Claude writes this room's report, and it's out of credits: don't
          // take anyone's coins or day for a report that would fall back.
          if (daily && everyoneAllowsClaude(room.players) && (await isClaudePaused())) {
            socket.emit("room-error", {
              message: "Daily analysis is taking a short break. Please try again later.",
              code: "AI_UNAVAILABLE",
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
            dailyPlayers = await Promise.all(
              room.players.map(async (p) => ({
                socketId: p.id,
                appUserId: p.id === socket.id ? host : await appUserIdOf(p.id),
                aiConsentVersion: p.aiConsentVersion,
              })),
            );
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

          const fetched = await fetchRandomQuestions(
            dailyTopic ? dailyTopic.id : room.settings.category,
            rankIt
              ? RANK_IT_QUESTION_COUNT
              : dailyTopic
                ? DAILY_ANALYSIS_QUESTION_COUNT
                : twoTruths
                  ? TWO_TRUTHS_TURNS
                  : scale
                    ? SCALE_QUESTION_COUNT
                    : room.settings.totalQuestions,
            supabaseAdmin,
            {
              // Votes and rankings are picked, never typed; two_truths topics
              // are prompts, the statements are typed in their own form.
              includeText:
                !moreLikely &&
                !rankIt &&
                !twoTruths &&
                !scale &&
                room.players.every((p) => p.supportsTextQuestions === true),
              appUserIds: await roomAppUserIds(room),
              rankable: rankIt,
              scalable: scale,
            },
          );
          const questions = twoTruths ? buildTwoTruthsRounds(fetched) : fetched;

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
          const listedCost = category?.coinsRequired ?? 0;
          // "One of you buys, you both play": any player's Unlimited pass
          // makes a paid category free for the whole room.
          const passHolder =
            listedCost > 0 && supabaseAdmin
              ? await anyActivePass(supabaseAdmin, await roomAppUserIds(room))
              : null;
          const cost = passHolder ? 0 : listedCost;
          if (passHolder) {
            captureServerEvent(
              "server_unlimited_game",
              { appUserId: passHolder },
              {
                room_code: roomCode,
                category: room.settings.category,
                coins_waived: listedCost,
                holder_is_host: passHolder === (await resolveAppUserId(socket, appUserId)),
              },
            );
          }

          // Older builds spend the coins themselves after the countdown, which
          // a modified app can skip; turned off once those builds are gone.
          if (cost > 0 && !player.supportsServerCoins && !allowLegacyClients()) {
            socket.emit("room-error", {
              message:
                "Please update the app from the store to play this category.",
              code: "UPDATE_REQUIRED",
              reason: "category",
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
          trackGameStarted(socket, appUserId, started.room, {
            listedCost,
            charged: cost,
            passHolder,
            questionCount: questions.length,
          }).catch(() => {});
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
      async ({ questionId, answer, playerId }: SubmitAnswerData) => {
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

          // Single-phone mode: the host's socket also answers for the partner.
          const actorId = actingPlayerId(room, socket.id, playerId);
          if (!actorId) return;

          // Check if question ID matches
          if (room.currentRound.question.id !== questionId) {
            socket.emit("critical-error", {
              message:
                "Looks like things got out of sync. We'll help you restart the round.",
              code: "INVALID_QUESTION_ID",
            });
            return;
          }

          // A repeat submit (already answered, or the first one still being
          // checked) stops here, before the model calls it would pay for again.
          if (
            room.currentRound.status !== "waiting_answers" ||
            room.currentRound.answers[actorId] !== null
          ) {
            return;
          }
          const submitKey = `${roomCode}:${questionId}:${actorId}`;
          if (answersInFlight.has(submitKey)) return;
          answersInFlight.add(submitKey);
          try {
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
                  playerId !== actorId && typeof value === "string",
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
                  rememberGrade(roomCode, questionId, actorId, typed, graded);
                }
              }
            }

            const question = room.currentRound.question;

            // Moderated before the lock for the same reason as typed answers.
            let written: { statements: string[]; lie: number } | null = null;
            if (isWriteRound(question)) {
              const submitted = parseSubmission(answer);
              const statements = submitted?.statements.map((s) =>
                normalizeTextAnswer(s, STATEMENT_MAX_LENGTH),
              );
              if (submitted && statements && statements.every(Boolean)) {
                const harmful = await Promise.all(statements.map(isHarmfulText));
                written = shuffleStatements(
                  statements.map((s, i) => (harmful[i] ? HIDDEN_TEXT_ANSWER : s)),
                  submitted.lie,
                );
              }
            }

            let playerAnswer: string | MultiLanguageAnswer;
            if (isTextQuestion(question)) {
              playerAnswer = textAnswer ?? normalizeTextAnswer(answer);
            } else if (question.twoTruths?.phase === "write") {
              playerAnswer = written ? encodeStatements(written.statements) : NO_ANSWER;
            } else if (question.twoTruths?.phase === "guess") {
              const partnerId = Object.keys(room.currentRound.answers).find(
                (id) => id !== actorId,
              );
              const authored = partnerId ? question.twoTruths.statements?.[partnerId] : null;
              playerAnswer = (authored && parseGuess(answer, authored.length)) || NO_ANSWER;
            } else if (typeof answer !== "string") {
              playerAnswer = NO_ANSWER;
            } else if (room.settings.mode === "who_is_more_likely") {
              playerAnswer = isMoreLikelyPick(answer) ? answer : NO_ANSWER;
            } else if (room.settings.mode === "rank_it") {
              playerAnswer = parseRanking(answer, rankItemCount(question)) ?? NO_ANSWER;
            } else if (room.settings.mode === "scale") {
              playerAnswer = parseScaleValue(answer) ?? NO_ANSWER;
            } else if (question.haveAnswers && question.answers) {
              // Only one of the question's own options is kept: anything else
              // would reach the partner as unmoderated free text.
              const answerObject = findAnswerObject(answer, question);
              if (!answerObject && answer !== NO_ANSWER) {
                console.warn(
                  `⚠️ Answer "${answer.slice(0, 80)}" not found in question ${questionId} answers array. Saved as no answer.`,
                );
              }
              playerAnswer = answerObject ?? NO_ANSWER;
            } else {
              // Yes/no questions: the app only ever sends "yes" or "no".
              playerAnswer = answer === "yes" || answer === "no" ? answer : NO_ANSWER;
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
                  !(actorId in round.answers) ||
                  round.answers[actorId] !== null
                ) {
                  return null;
                }
                // Saved with the answer, so a repeated submit can't reshuffle it.
                if (written) await saveLie(roomCode, questionId, actorId, written.lie);
                round.answers[actorId] = playerAnswer;
                const player = lockedRoom.players.find((p) => p.id === actorId);
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
              playerId: actorId,
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
          } finally {
            answersInFlight.delete(submitKey);
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

            if (targetPlayer.localOf) {
              // Not a socket of its own: nothing to block or unmap.
              room.players = room.players.filter((p) => p.id !== targetPlayerId);
              await roomManager.updateRoom(room);
              return { requester, targetPlayer, updatedRoom: room };
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
        if (!partner || !(await isConnectedAnywhere(partner.id))) {
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

    // socket.rooms is already empty in "disconnect"; keep the game room for the event.
    let roomsAtDisconnect: string[] = [];
    socket.on("disconnecting", () => {
      roomsAtDisconnect = [...socket.rooms].filter((room) => room !== socket.id);
    });

    // 8. On Disconnect
    socket.on("disconnect", (reason) => {
      const connectedSec = Math.round((Date.now() - socket.handshake.issued) / 1000);
      captureServerEvent(
        "server_socket_disconnected",
        { appUserId: socket.data.appUserId, socketId: socket.id },
        {
          reason,
          transport: socket.conn.transport.name,
          connected_sec: connectedSec,
          room_code: roomsAtDisconnect[0],
          in_room: roomsAtDisconnect.length > 0,
          shutting_down: shuttingDown,
        },
      );
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

      trackCleanup(handleDroppedPlayer(socket.id, reason, socket.data.appUserId ?? null));
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

    // Single-phone mode (host only, waiting room only): the partner plays on
    // the host's phone instead of joining with the code; null undoes it.
    socket.on(
      "set-local-partner",
      async ({ roomCode, partner, manualAdvance }: SetLocalPartnerData, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
          const valid =
            typeof roomCode === "string" &&
            !!roomCode &&
            (partner === null ||
              (!!partner &&
                typeof partner === "object" &&
                typeof partner.name === "string" &&
                typeof partner.avatar === "string"));
          if (!valid) {
            reply({ ok: false, code: "REQUEST_FAILED" });
            return;
          }
          const result = await roomManager.withRoomLock(
            roomCode,
            async (): Promise<{ room: Room } | { code: RoomErrorCode }> => {
              const room = await roomManager.getRoom(roomCode);
              if (!room) return { code: "ROOM_NOT_FOUND" };
              const host = room.players.find((p) => p.id === socket.id);
              if (!host?.isHost) return { code: "NOT_HOST" };
              if (room.status !== "waiting") return { code: "GAME_IN_PROGRESS" };
              const others = room.players.filter(
                (p) => p.id !== socket.id && p.localOf !== socket.id,
              );
              if (partner && others.length > 0) return { code: "ROOM_FULL" };
              room.players = room.players.filter((p) => p.localOf !== socket.id);
              if (partner) {
                room.players.push(
                  makeLocalPartner(
                    host,
                    uniquePlayerName(cleanPlayerName(partner.name), [host.name]),
                    cleanAvatar(partner.avatar),
                    manualAdvance === true,
                  ),
                );
              }
              await roomManager.updateRoom(room);
              return { room };
            },
          );
          if ("code" in result) {
            reply({ ok: false, code: result.code });
            return;
          }
          io.to(roomCode).emit("room-updated", { room: result.room });
          reply({ ok: true, room: result.room });
        } catch (error) {
          console.error("Error setting local partner:", error);
          reply({ ok: false, code: "REQUEST_FAILED" });
        }
      },
    );

    // The app asks after a purchase, a restore and when it enters a room;
    // the answer also goes on the player's seat for the partner to see.
    socket.on("unlimited-status", async (_data, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        await pendingRegistrations.get(socket.id);
        const appUserId = socket.data.appUserId;
        if (!supabaseAdmin || !appUserId) {
          return reply({ ok: false, code: "UNAVAILABLE" });
        }
        const status = await getPassStatus(supabaseAdmin, appUserId, { verify: true });
        await showPassInRoom(socket.id, status.active);
        reply({ ok: true, ...status });
      } catch (error) {
        console.error("Error checking Unlimited:", error);
        reply({ ok: false, code: "UNAVAILABLE" });
      }
    });

    // A player agreed on their device to the daily analysis sending their
    // answers to OpenAI; the host can't start one until everyone has.
    // Single phone: the host taps "next question" on a round's result.
    socket.on("advance-round", async ({ roomCode, questionId }, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        if (typeof roomCode !== "string" || typeof questionId !== "string") {
          return reply({ ok: false });
        }
        const pending = pendingAdvances.get(roomCode);
        if (!pending || pending.questionId !== questionId) return reply({ ok: false });
        const room = await roomManager.getRoom(roomCode);
        const host = room?.players.find((p) => p.id === socket.id);
        if (!room || !host?.isHost || !advancesManually(room)) {
          return reply({ ok: false });
        }
        // False if the fallback timer or another tap got there first.
        reply({ ok: pending.run() });
      } catch (error) {
        console.error("Error advancing round:", error);
        reply({ ok: false });
      }
    });

    socket.on("ai-consent", async ({ roomCode, playerId, version }) => {
      try {
        if (typeof roomCode !== "string" || !roomCode) return;
        // Older apps send no version: their text named only OpenAI.
        const consentVersion =
          typeof version === "number" &&
          Number.isInteger(version) &&
          version >= 1 &&
          version <= CLAUDE_CONSENT_VERSION
            ? version
            : 1;
        const room = await roomManager.withRoomLock(roomCode, async () => {
          const current = await roomManager.getRoom(roomCode);
          const actorId = current && actingPlayerId(current, socket.id, playerId);
          const player = current?.players.find((p) => p.id === actorId);
          if (!current || !player) return null;
          if (player.aiConsent && (player.aiConsentVersion ?? 1) >= consentVersion) return null;
          player.aiConsent = true;
          player.aiConsentVersion = consentVersion;
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
  // Before the logs below, which would otherwise report it without context.
  captureServerError(error, {}, { kind: "uncaught_exception", fatal: true });
  console.error(
    "💥 UNCAUGHT EXCEPTION - Server will crash without this handler!",
  );
  console.error("Error:", error);
  console.error("Stack:", error.stack);

  // Graceful shutdown
  httpServer.close(() => {
    console.log("🛑 HTTP server closed due to uncaught exception");
    void flushAnalytics().finally(() => process.exit(1)); // Exit with error code
  });

  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error("⚠️ Forcing exit due to uncaught exception");
    process.exit(1);
  }, 10000);
});

// Handle unhandled promise rejections (async errors)
process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
  captureServerError(reason, {}, { kind: "unhandled_rejection" });
  console.error("💥 UNHANDLED REJECTION - This would crash the server!");
  console.error("Reason:", reason);
  console.error("Promise:", promise);

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
  await adapterRedis.quit().catch(() => undefined);
  console.log("✅ HTTP server and Redis closed");
  await flushAnalytics();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
