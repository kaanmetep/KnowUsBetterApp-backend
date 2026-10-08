export type CoinPackageConfig = {
  /** Store product id, as configured in RevenueCat. */
  productId: string;
  coins: number;
  badge: "bestValue" | null;
};

export type MatchTierConfig = {
  /** Lowest match percentage that lands in this tier. */
  min: number;
  /** Translation key under gameFinished.tiers / gameFinished.tierLines. */
  key: string;
  celebrate: boolean;
};

export type PublicRuntimeConfig = {
  economy: {
    aiAnalysis: {
      enabled: boolean;
      coinCost: number;
    };
    dailyReward: {
      amount: number;
      intervalMs: number;
      claimTimeoutMs: number;
    };
    balanceSync: {
      maxRetries: number;
      retryDelaysMs: number[];
    };
    coinPackages: CoinPackageConfig[];
  };
  gameplay: {
    room: {
      minPlayersToStart: number;
      defaultCategoryId: string;
    };
    defaults: {
      questionDurationSec: number;
    };
    textAnswers: {
      maxLength: number;
    };
    results: {
      /** Highest `min` first. */
      matchTiers: MatchTierConfig[];
    };
  };
  network: {
    socket: {
      connectTimeoutMs: number;
      reconnectAttempts: number;
      reconnectDelayMs: number;
    };
    rpcTimeoutMs: {
      default: number;
      startGame: number;
      reportAnswer: number;
    };
  };
  content: {
    categories: {
      cacheTtlMs: number;
    };
    announcements: {
      cacheTtlMs: number;
      staleWhileRevalidateMs: number;
    };
  };
  growth: {
    storeReview: {
      triggerGames: number[];
      minMatchPercent: number;
      promptDelayMs: number;
    };
  };
};
