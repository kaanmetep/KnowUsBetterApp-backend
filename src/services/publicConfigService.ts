import { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger.js";
import { PublicRuntimeConfig } from "../types/publicConfig.js";

const PUBLIC_CONFIG_DB_KEY = "public_mobile_config";

const DEFAULT_PUBLIC_RUNTIME_CONFIG: PublicRuntimeConfig = {
  economy: {
    aiAnalysis: {
      enabled: true,
      coinCost: 3,
    },
    dailyReward: {
      amount: 1,
      intervalMs: 21600000,
      claimTimeoutMs: 10000,
    },
    balanceSync: {
      maxRetries: 5,
      retryDelaysMs: [500, 1000, 2000, 3000, 5000],
    },
  },
  gameplay: {
    room: {
      minPlayersToStart: 2,
    },
    defaults: {
      questionDurationSec: 15,
    },
  },
  network: {
    socket: {
      connectTimeoutMs: 10000,
      reconnectAttempts: 5,
      reconnectDelayMs: 1000,
    },
    rpcTimeoutMs: {
      default: 5000,
      startGame: 10000,
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

type ConfigSource = "db" | "env" | "default";

type ResolveResult = {
  config: PublicRuntimeConfig;
  source: ConfigSource;
  validationFallbackUsed: boolean;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && isFiniteNumber(value) && value > 0;
}

function parseUnknownToObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parsePublicRuntimeConfig(input: unknown): PublicRuntimeConfig | null {
  const root = parseUnknownToObject(input);
  if (!root) {
    return null;
  }

  const economy = parseUnknownToObject(root.economy);
  const aiAnalysis = parseUnknownToObject(economy?.aiAnalysis);
  const dailyReward = parseUnknownToObject(economy?.dailyReward);
  const balanceSync = parseUnknownToObject(economy?.balanceSync);

  const gameplay = parseUnknownToObject(root.gameplay);
  const room = parseUnknownToObject(gameplay?.room);
  const gameplayDefaults = parseUnknownToObject(gameplay?.defaults);

  const network = parseUnknownToObject(root.network);
  const socket = parseUnknownToObject(network?.socket);
  const rpcTimeoutMs = parseUnknownToObject(network?.rpcTimeoutMs);

  const content = parseUnknownToObject(root.content);
  const categories = parseUnknownToObject(content?.categories);
  const announcements = parseUnknownToObject(content?.announcements);

  const growth = parseUnknownToObject(root.growth);
  const storeReview = parseUnknownToObject(growth?.storeReview);

  if (
    !economy ||
    !aiAnalysis ||
    !dailyReward ||
    !balanceSync ||
    !gameplay ||
    !room ||
    !gameplayDefaults ||
    !network ||
    !socket ||
    !rpcTimeoutMs ||
    !content ||
    !categories ||
    !announcements ||
    !growth ||
    !storeReview
  ) {
    return null;
  }

  const triggerGames = storeReview.triggerGames;
  const retryDelaysMs = balanceSync.retryDelaysMs;

  if (
    typeof aiAnalysis.enabled !== "boolean" ||
    !isFiniteNumber(aiAnalysis.coinCost) ||
    !isFiniteNumber(dailyReward.amount) ||
    !isFiniteNumber(dailyReward.intervalMs) ||
    !isFiniteNumber(dailyReward.claimTimeoutMs) ||
    !isFiniteNumber(balanceSync.maxRetries) ||
    !Array.isArray(retryDelaysMs) ||
    !isFiniteNumber(room.minPlayersToStart) ||
    !isFiniteNumber(gameplayDefaults.questionDurationSec) ||
    !isFiniteNumber(socket.connectTimeoutMs) ||
    !isFiniteNumber(socket.reconnectAttempts) ||
    !isFiniteNumber(socket.reconnectDelayMs) ||
    !isFiniteNumber(rpcTimeoutMs.default) ||
    !isFiniteNumber(rpcTimeoutMs.startGame) ||
    !isFiniteNumber(categories.cacheTtlMs) ||
    !isFiniteNumber(announcements.cacheTtlMs) ||
    !isFiniteNumber(announcements.staleWhileRevalidateMs) ||
    !Array.isArray(triggerGames) ||
    !isFiniteNumber(storeReview.minMatchPercent) ||
    !isFiniteNumber(storeReview.promptDelayMs)
  ) {
    return null;
  }

  return {
    economy: {
      aiAnalysis: {
        enabled: aiAnalysis.enabled,
        coinCost: aiAnalysis.coinCost,
      },
      dailyReward: {
        amount: dailyReward.amount,
        intervalMs: dailyReward.intervalMs,
        claimTimeoutMs: dailyReward.claimTimeoutMs,
      },
      balanceSync: {
        maxRetries: balanceSync.maxRetries,
        retryDelaysMs: retryDelaysMs as number[],
      },
    },
    gameplay: {
      room: {
        minPlayersToStart: room.minPlayersToStart,
      },
      defaults: {
        questionDurationSec: gameplayDefaults.questionDurationSec,
      },
    },
    network: {
      socket: {
        connectTimeoutMs: socket.connectTimeoutMs,
        reconnectAttempts: socket.reconnectAttempts,
        reconnectDelayMs: socket.reconnectDelayMs,
      },
      rpcTimeoutMs: {
        default: rpcTimeoutMs.default,
        startGame: rpcTimeoutMs.startGame,
      },
    },
    content: {
      categories: {
        cacheTtlMs: categories.cacheTtlMs,
      },
      announcements: {
        cacheTtlMs: announcements.cacheTtlMs,
        staleWhileRevalidateMs: announcements.staleWhileRevalidateMs,
      },
    },
    growth: {
      storeReview: {
        triggerGames: triggerGames as number[],
        minMatchPercent: storeReview.minMatchPercent,
        promptDelayMs: storeReview.promptDelayMs,
      },
    },
  };
}

export function validatePublicRuntimeConfig(config: PublicRuntimeConfig): boolean {
  if (config.economy.aiAnalysis.coinCost < 0) return false;
  if (config.economy.dailyReward.amount < 0) return false;
  if (config.economy.dailyReward.intervalMs <= 0) return false;
  if (config.economy.dailyReward.claimTimeoutMs <= 0) return false;
  if (config.gameplay.room.minPlayersToStart < 2) return false;
  if (config.gameplay.defaults.questionDurationSec <= 0) return false;
  if (config.network.socket.connectTimeoutMs <= 0) return false;
  if (config.network.socket.reconnectAttempts <= 0) return false;
  if (config.network.socket.reconnectDelayMs <= 0) return false;
  if (config.network.rpcTimeoutMs.default <= 0) return false;
  if (config.network.rpcTimeoutMs.startGame <= 0) return false;
  if (config.content.categories.cacheTtlMs <= 0) return false;
  if (config.content.announcements.cacheTtlMs <= 0) return false;
  if (config.content.announcements.staleWhileRevalidateMs <= 0) return false;
  if (config.growth.storeReview.promptDelayMs <= 0) return false;
  if (
    config.growth.storeReview.minMatchPercent < 0 ||
    config.growth.storeReview.minMatchPercent > 100
  ) {
    return false;
  }
  if (
    config.growth.storeReview.triggerGames.length === 0 ||
    !config.growth.storeReview.triggerGames.every(isPositiveInteger)
  ) {
    return false;
  }
  if (
    config.economy.balanceSync.retryDelaysMs.length === 0 ||
    !config.economy.balanceSync.retryDelaysMs.every((value) => value > 0)
  ) {
    return false;
  }
  return true;
}

async function loadConfigFromDb(
  supabaseAdmin: SupabaseClient | null,
): Promise<unknown | undefined> {
  if (!supabaseAdmin) {
    return undefined;
  }

  const { data, error } = await supabaseAdmin
    .from("runtime_config")
    .select("value")
    .eq("key", PUBLIC_CONFIG_DB_KEY)
    .maybeSingle();

  if (error) {
    logger.warn("Public config DB lookup failed", {
      key: PUBLIC_CONFIG_DB_KEY,
      error: error.message,
    });
    return undefined;
  }

  return data?.value;
}

function loadConfigFromEnv(): unknown | undefined {
  return process.env.PUBLIC_RUNTIME_CONFIG_JSON;
}

function logFallback(reason: string, source: ConfigSource): void {
  logger.warn("Public config validation fallback applied", {
    source,
    reason,
  });
}

export async function resolvePublicRuntimeConfig(
  supabaseAdmin: SupabaseClient | null,
): Promise<ResolveResult> {
  const dbRaw = await loadConfigFromDb(supabaseAdmin);
  if (dbRaw !== undefined) {
    const parsed = parsePublicRuntimeConfig(dbRaw);
    if (parsed && validatePublicRuntimeConfig(parsed)) {
      return { config: parsed, source: "db", validationFallbackUsed: false };
    }
    logFallback("db_config_invalid", "db");
  }

  const envRaw = loadConfigFromEnv();
  if (envRaw !== undefined) {
    const parsed = parsePublicRuntimeConfig(envRaw);
    if (parsed && validatePublicRuntimeConfig(parsed)) {
      return { config: parsed, source: "env", validationFallbackUsed: false };
    }
    logFallback("env_config_invalid", "env");
  }

  return {
    config: DEFAULT_PUBLIC_RUNTIME_CONFIG,
    source: "default",
    validationFallbackUsed: true,
  };
}

export function getDefaultPublicRuntimeConfig(): PublicRuntimeConfig {
  return DEFAULT_PUBLIC_RUNTIME_CONFIG;
}
