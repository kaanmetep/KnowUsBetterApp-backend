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
  };
  gameplay: {
    room: {
      minPlayersToStart: number;
    };
    defaults: {
      questionDurationSec: number;
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
