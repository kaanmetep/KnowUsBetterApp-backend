import pg from "pg";
import { AppError } from "../errors/AppError.js";
import { CoinTransactionType } from "./coinLedger.js";
import { logger } from "../utils/logger.js";

export const MAX_PUSH_COIN_REWARD = 1000;
const TRANSACTION_TYPE: CoinTransactionType = "push_reward";
const CHUNK_SIZE = 500;

export interface PushRewardSummary {
  amount: number;
  creditedUsers: number;
  failedUsers: number;
  error?: string;
}

/** 0 / missing = no reward. */
export function parsePushCoinReward(raw: unknown): number {
  if (raw == null || raw === "" || raw === 0) return 0;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_PUSH_COIN_REWARD
  ) {
    throw new AppError(
      `coins must be a whole number between 0 and ${MAX_PUSH_COIN_REWARD}`,
      400,
      "VALIDATION_ERROR",
    );
  }
  return value;
}

/**
 * Adds `amount` to every user's balance once, with an atomic increment so it
 * can't overwrite a concurrent spend (coinLedger's compare-and-set just
 * retries). A failed chunk doesn't stop the rest; the summary reports it.
 */
export async function grantPushReward(
  pool: pg.Pool,
  appUserIds: Iterable<string>,
  amount: number,
): Promise<PushRewardSummary> {
  const users = Array.from(new Set(appUserIds)).filter(Boolean);
  const summary: PushRewardSummary = { amount, creditedUsers: 0, failedUsers: 0 };

  for (let i = 0; i < users.length; i += CHUNK_SIZE) {
    const chunk = users.slice(i, i + CHUNK_SIZE);
    let client: pg.PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO coins (app_user_id, balance)
         SELECT id, $2::int FROM unnest($1::text[]) AS id
         ON CONFLICT (app_user_id)
         DO UPDATE SET balance = coins.balance + EXCLUDED.balance, updated_at = now()`,
        [chunk, amount],
      );
      await client.query(
        `INSERT INTO coin_transactions (app_user_id, amount, transaction_type)
         SELECT id, $2::int, $3 FROM unnest($1::text[]) AS id`,
        [chunk, amount, TRANSACTION_TYPE],
      );
      await client.query("COMMIT");
      summary.creditedUsers += chunk.length;
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      summary.failedUsers += chunk.length;
      summary.error = error instanceof Error ? error.message : String(error);
      logger.error("Push coin reward chunk failed", {
        chunkSize: chunk.length,
        error: summary.error,
      });
    } finally {
      client?.release();
    }
  }

  logger.info("Push coin reward finished", {
    amount,
    creditedUsers: summary.creditedUsers,
    failedUsers: summary.failedUsers,
  });
  return summary;
}

/** Distinct users with at least one active iOS device, per language. */
export async function countPushUsersByLanguage(pool: pg.Pool): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ language: string; count: number }>(
    `SELECT language, COUNT(DISTINCT app_user_id)::int AS count FROM push_tokens
      WHERE platform = 'ios' AND is_active
      GROUP BY language`,
  );
  return Object.fromEntries(rows.map((row) => [row.language, row.count]));
}
