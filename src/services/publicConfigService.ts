import { TEXT_ANSWER_MAX_LENGTH } from "../utils/helpers.js";
import { PublicRuntimeConfig } from "../types/publicConfig.js";

/** Served to the app at /api/config/public and read by the server itself. */
export const PUBLIC_RUNTIME_CONFIG: PublicRuntimeConfig = {
  economy: {
    aiAnalysis: {
      enabled: true,
      coinCost: 3,
    },
    dailyReward: {
      amount: 1,
      intervalMs: 7200000,
      claimTimeoutMs: 10000,
    },
    balanceSync: {
      maxRetries: 5,
      retryDelaysMs: [500, 1000, 2000, 3000, 5000],
    },
    coinPackages: [
      { productId: "coins_10", coins: 10, badge: null },
      { productId: "coins_30", coins: 30, badge: "bestValue" },
    ],
  },
  gameplay: {
    room: {
      minPlayersToStart: 2,
      defaultCategoryId: "just_friends",
    },
    defaults: {
      questionDurationSec: 15,
    },
    textAnswers: {
      maxLength: TEXT_ANSWER_MAX_LENGTH,
    },
    results: {
      matchTiers: [
        { min: 90, key: "soulmates", celebrate: true },
        { min: 75, key: "sameWave", celebrate: true },
        { min: 60, key: "inSync", celebrate: true },
        { min: 40, key: "exploring", celebrate: false },
        { min: 0, key: "opposites", celebrate: false },
      ],
    },
  },
  network: {
    socket: {
      connectTimeoutMs: 10000,
      // The app never reconnects on its own once these run out, so a short
      // outage (elevator, tunnel) would leave it offline until relaunched.
      reconnectAttempts: 1000,
      reconnectDelayMs: 1000,
    },
    rpcTimeoutMs: {
      default: 5000,
      startGame: 10000,
      reportAnswer: 8000,
    },
  },
  content: {
    categories: {
      cacheTtlMs: 3600000,
    },
    announcements: {
      cacheTtlMs: 43200000,
      staleWhileRevalidateMs: 86400000,
    },
  },
  growth: {
    storeReview: {
      triggerGames: [2, 5, 8],
      minMatchPercent: 60,
      promptDelayMs: 1500,
    },
  },
};
