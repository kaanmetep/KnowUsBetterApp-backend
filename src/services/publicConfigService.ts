import { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger.js";
import { TEXT_ANSWER_MAX_LENGTH } from "../utils/helpers.js";
import { PublicRuntimeConfig } from "../types/publicConfig.js";

const PUBLIC_CONFIG_DB_KEY = "public_mobile_config";
const CONFIG_CACHE_TTL_MS = 30_000;

const DEFAULT_PUBLIC_RUNTIME_CONFIG: PublicRuntimeConfig = {
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

type ConfigSource = "db" | "env" | "default";

type ResolveResult = {
  config: PublicRuntimeConfig;
  source: ConfigSource;
  validationFallbackUsed: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPositiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && isFiniteNumber(value) && value > 0;

function parseUnknownToObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Objects merge key by key; arrays and primitives in `source` replace. */
function mergeOntoDefaults(target: unknown, source: unknown): unknown {
  if (!isRecord(target) || !isRecord(source)) {
    return source === undefined ? target : source;
  }
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    result[key] = mergeOntoDefaults(target[key], value);
  }
  return result;
}

/**
 * Stored config only has to name what it overrides; everything else comes
 * from the defaults, so adding a field never invalidates an existing row.
 */
function parsePublicRuntimeConfig(input: unknown): PublicRuntimeConfig | null {
  const root = parseUnknownToObject(input);
  if (!root) return null;
  const merged = mergeOntoDefaults(
    DEFAULT_PUBLIC_RUNTIME_CONFIG,
    root,
  ) as PublicRuntimeConfig;
  return hasValidShape(merged) ? withServerOwnedValues(merged) : null;
}

/** Values the server enforces itself, which a stored config must not change. */
function withServerOwnedValues(config: PublicRuntimeConfig): PublicRuntimeConfig {
  return {
    ...config,
    gameplay: {
      ...config.gameplay,
      textAnswers: { maxLength: TEXT_ANSWER_MAX_LENGTH },
    },
  };
}

function hasValidShape(config: PublicRuntimeConfig): boolean {
  const { economy, gameplay, network, content, growth } = config;
  return (
    typeof economy?.aiAnalysis?.enabled === "boolean" &&
    isFiniteNumber(economy.aiAnalysis.coinCost) &&
    isFiniteNumber(economy.dailyReward?.amount) &&
    isFiniteNumber(economy.dailyReward.intervalMs) &&
    isFiniteNumber(economy.dailyReward.claimTimeoutMs) &&
    isFiniteNumber(economy.balanceSync?.maxRetries) &&
    Array.isArray(economy.balanceSync.retryDelaysMs) &&
    Array.isArray(economy.coinPackages) &&
    economy.coinPackages.every(
      (pkg) =>
        isRecord(pkg) &&
        typeof pkg.productId === "string" &&
        isFiniteNumber(pkg.coins) &&
        (pkg.badge === null || pkg.badge === "bestValue"),
    ) &&
    isFiniteNumber(gameplay?.room?.minPlayersToStart) &&
    typeof gameplay.room.defaultCategoryId === "string" &&
    isFiniteNumber(gameplay.defaults?.questionDurationSec) &&
    Array.isArray(gameplay.results?.matchTiers) &&
    gameplay.results.matchTiers.every(
      (tier) =>
        isRecord(tier) &&
        isFiniteNumber(tier.min) &&
        typeof tier.key === "string" &&
        typeof tier.celebrate === "boolean",
    ) &&
    isFiniteNumber(network?.socket?.connectTimeoutMs) &&
    isFiniteNumber(network.socket.reconnectAttempts) &&
    isFiniteNumber(network.socket.reconnectDelayMs) &&
    isFiniteNumber(network.rpcTimeoutMs?.default) &&
    isFiniteNumber(network.rpcTimeoutMs.startGame) &&
    isFiniteNumber(network.rpcTimeoutMs.reportAnswer) &&
    isFiniteNumber(content?.categories?.cacheTtlMs) &&
    isFiniteNumber(content.announcements?.cacheTtlMs) &&
    isFiniteNumber(content.announcements.staleWhileRevalidateMs) &&
    Array.isArray(growth?.storeReview?.triggerGames) &&
    isFiniteNumber(growth.storeReview.minMatchPercent) &&
    isFiniteNumber(growth.storeReview.promptDelayMs)
  );
}

export function validatePublicRuntimeConfig(config: PublicRuntimeConfig): boolean {
  if (config.economy.aiAnalysis.coinCost < 0) return false;
  if (!Number.isInteger(config.economy.aiAnalysis.coinCost)) return false;
  if (!isPositiveInteger(config.economy.dailyReward.amount)) return false;
  if (config.economy.dailyReward.intervalMs <= 0) return false;
  if (config.economy.dailyReward.claimTimeoutMs <= 0) return false;
  if (
    !config.economy.coinPackages.every(
      (pkg) => pkg.productId.trim() !== "" && isPositiveInteger(pkg.coins),
    )
  ) {
    return false;
  }
  if (config.gameplay.room.minPlayersToStart < 2) return false;
  if (config.gameplay.room.defaultCategoryId.trim() === "") return false;
  if (config.gameplay.defaults.questionDurationSec <= 0) return false;
  const tiers = config.gameplay.results.matchTiers;
  if (tiers.length === 0 || !tiers.some((tier) => tier.min <= 0)) return false;
  if (config.network.socket.connectTimeoutMs <= 0) return false;
  if (config.network.socket.reconnectAttempts <= 0) return false;
  if (config.network.socket.reconnectDelayMs <= 0) return false;
  if (config.network.rpcTimeoutMs.default <= 0) return false;
  if (config.network.rpcTimeoutMs.startGame <= 0) return false;
  if (config.network.rpcTimeoutMs.reportAnswer <= 0) return false;
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

async function resolveUncached(
  supabaseAdmin: SupabaseClient | null,
): Promise<ResolveResult> {
  const dbRaw = await loadConfigFromDb(supabaseAdmin);
  if (dbRaw !== undefined && dbRaw !== null) {
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

// Game start, AI analysis and wallet reads all need the config; one lookup
// per window keeps them off the database.
let cached: { result: ResolveResult; expiresAt: number } | null = null;

export async function resolvePublicRuntimeConfig(
  supabaseAdmin: SupabaseClient | null,
): Promise<ResolveResult> {
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = await resolveUncached(supabaseAdmin);
  cached = { result, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
  return result;
}

export async function getPublicConfig(
  supabaseAdmin: SupabaseClient | null,
): Promise<PublicRuntimeConfig> {
  return (await resolvePublicRuntimeConfig(supabaseAdmin)).config;
}

export function getDefaultPublicRuntimeConfig(): PublicRuntimeConfig {
  return DEFAULT_PUBLIC_RUNTIME_CONFIG;
}
