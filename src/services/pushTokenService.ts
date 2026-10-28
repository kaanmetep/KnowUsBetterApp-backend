import { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { AppError } from "../errors/AppError.js";
import {
  PUSH_LANGUAGES,
  PushLanguage,
  PushPlatform,
  PushProvider,
  RegisterTokenInput,
} from "../types/notifications.js";

interface PushTokenRow {
  token: string;
}

export function isPushLanguage(value: unknown): value is PushLanguage {
  return typeof value === "string" && (PUSH_LANGUAGES as readonly string[]).includes(value);
}

export function validateRegisterTokenInput(input: RegisterTokenInput): void {
  if (!input.appUserId || typeof input.appUserId !== "string") {
    throw new AppError("appUserId is required", 400, "VALIDATION_ERROR");
  }

  if (!input.token || typeof input.token !== "string") {
    throw new AppError("token is required", 400, "VALIDATION_ERROR");
  }

  if (input.platform !== "ios") {
    throw new AppError("platform must be ios", 400, "VALIDATION_ERROR");
  }

  if (input.provider && input.provider !== "apns") {
    throw new AppError("provider must be apns", 400, "VALIDATION_ERROR");
  }

  if (input.language !== undefined && !isPushLanguage(input.language)) {
    throw new AppError("language must be en, tr or es", 400, "VALIDATION_ERROR");
  }
}

function normalizeToken(rawToken: string): string {
  return rawToken.replace(/[<>\s]/g, "");
}

export async function upsertPushToken(
  supabaseAdmin: SupabaseClient,
  input: RegisterTokenInput,
): Promise<void> {
  const token = normalizeToken(input.token);
  const provider: PushProvider = input.provider ?? "apns";
  const platform: PushPlatform = input.platform;

  const { error } = await supabaseAdmin.from("push_tokens").upsert(
    {
      app_user_id: input.appUserId.trim(),
      token,
      platform,
      provider,
      // Older app versions don't send it; leaving it out keeps the stored value.
      ...(input.language ? { language: input.language } : {}),
      is_active: true,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "token" },
  );

  if (error) {
    throw new AppError("Failed to save push token", 500, "DB_ERROR", {
      cause: error.message,
    });
  }
}

export interface TokenFilter {
  language: PushLanguage;
  appUserId?: string;
}

export async function getActiveIosTokensPage(
  supabaseAdmin: SupabaseClient,
  filter: TokenFilter,
  page: number,
  pageSize: number,
): Promise<string[]> {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from("push_tokens")
    .select("token")
    .eq("platform", "ios")
    .eq("is_active", true)
    .eq("language", filter.language);
  if (filter.appUserId) {
    query = query.eq("app_user_id", filter.appUserId);
  }

  const { data, error } = await query
    .order("created_at", { ascending: true })
    .range(from, to);

  if (error) {
    throw new AppError("Failed to fetch active tokens", 500, "DB_ERROR", {
      cause: error.message,
    });
  }

  return ((data as PushTokenRow[] | null) ?? []).map((row) => row.token);
}

/**
 * Where a push send reads and cleans up tokens. The app-facing routes use the
 * Supabase client; the admin panel uses DATABASE_URL like its other tools.
 */
export interface PushTokenStore {
  getActiveIosTokensPage(filter: TokenFilter, page: number, pageSize: number): Promise<string[]>;
  deactivateTokens(tokens: string[]): Promise<number>;
  countActiveIosTokensByLanguage(): Promise<Record<PushLanguage, number>>;
}

export function supabaseTokenStore(supabaseAdmin: SupabaseClient): PushTokenStore {
  return {
    getActiveIosTokensPage: (filter, page, pageSize) =>
      getActiveIosTokensPage(supabaseAdmin, filter, page, pageSize),
    deactivateTokens: (tokens) => deactivateTokens(supabaseAdmin, tokens),
    countActiveIosTokensByLanguage: () => countActiveIosTokensByLanguage(supabaseAdmin),
  };
}

// Only the admin panel uses the pg store, so the cause is safe to show.
function dbError(message: string, error: unknown): AppError {
  const cause = error instanceof Error ? error.message : String(error);
  return new AppError(`${message}: ${cause}`, 500, "DB_ERROR", { cause });
}

export function pgTokenStore(pool: pg.Pool): PushTokenStore {
  return {
    async getActiveIosTokensPage(filter, page, pageSize) {
      const params: unknown[] = [filter.language, pageSize, page * pageSize];
      let userClause = "";
      if (filter.appUserId) {
        params.push(filter.appUserId);
        userClause = `AND app_user_id = $${params.length}`;
      }
      try {
        const { rows } = await pool.query<PushTokenRow>(
          `SELECT token FROM push_tokens
            WHERE platform = 'ios' AND is_active AND language = $1 ${userClause}
            ORDER BY created_at, id
            LIMIT $2 OFFSET $3`,
          params,
        );
        return rows.map((row) => row.token);
      } catch (error) {
        throw dbError("Failed to fetch active tokens", error);
      }
    },

    async deactivateTokens(tokens) {
      if (!tokens.length) return 0;
      try {
        const { rowCount } = await pool.query(
          `UPDATE push_tokens SET is_active = false, updated_at = now()
            WHERE token = ANY($1) AND is_active`,
          [tokens],
        );
        return rowCount ?? 0;
      } catch (error) {
        throw dbError("Failed to deactivate invalid tokens", error);
      }
    },

    async countActiveIosTokensByLanguage() {
      try {
        const { rows } = await pool.query<{ language: string; count: number }>(
          `SELECT language, COUNT(*)::int AS count FROM push_tokens
            WHERE platform = 'ios' AND is_active
            GROUP BY language`,
        );
        const counts = Object.fromEntries(PUSH_LANGUAGES.map((l) => [l, 0])) as Record<
          PushLanguage,
          number
        >;
        for (const row of rows) {
          if (isPushLanguage(row.language)) counts[row.language] = row.count;
        }
        return counts;
      } catch (error) {
        throw dbError("Failed to count active tokens", error);
      }
    },
  };
}

export async function countActiveIosTokensByLanguage(
  supabaseAdmin: SupabaseClient,
): Promise<Record<PushLanguage, number>> {
  const entries = await Promise.all(
    PUSH_LANGUAGES.map(async (language) => {
      const { count, error } = await supabaseAdmin
        .from("push_tokens")
        .select("token", { count: "exact", head: true })
        .eq("platform", "ios")
        .eq("is_active", true)
        .eq("language", language);

      if (error) {
        throw new AppError("Failed to count active tokens", 500, "DB_ERROR", {
          cause: error.message,
        });
      }
      return [language, count ?? 0] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<PushLanguage, number>;
}

// The `in` filter is sent in the request URL (~65 characters per token), and
// URLs over ~8 KB are rejected, so tokens are deactivated in chunks.
const DEACTIVATE_CHUNK_SIZE = 100;

export async function deactivateTokens(
  supabaseAdmin: SupabaseClient,
  tokens: string[],
): Promise<number> {
  let deactivated = 0;
  let lastError: string | null = null;

  // A failed chunk doesn't stop the rest, so as many tokens as possible are
  // cleaned up before the error is reported.
  for (let i = 0; i < tokens.length; i += DEACTIVATE_CHUNK_SIZE) {
    const chunk = tokens.slice(i, i + DEACTIVATE_CHUNK_SIZE);
    const { data, error } = await supabaseAdmin
      .from("push_tokens")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .in("token", chunk)
      .eq("is_active", true)
      .select("token");

    if (error) {
      lastError = error.message;
      continue;
    }
    deactivated += data?.length ?? 0;
  }

  if (lastError) {
    throw new AppError("Failed to deactivate invalid tokens", 500, "DB_ERROR", {
      cause: lastError,
      deactivated,
    });
  }

  return deactivated;
}
