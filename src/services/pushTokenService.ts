import { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors/AppError.js";
import {
  PushPlatform,
  PushProvider,
  RegisterTokenInput,
} from "../types/notifications.js";

interface PushTokenRow {
  token: string;
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

export async function getActiveIosTokensPage(
  supabaseAdmin: SupabaseClient,
  page: number,
  pageSize: number,
): Promise<string[]> {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, error } = await supabaseAdmin
    .from("push_tokens")
    .select("token")
    .eq("platform", "ios")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .range(from, to);

  if (error) {
    throw new AppError("Failed to fetch active tokens", 500, "DB_ERROR", {
      cause: error.message,
    });
  }

  return ((data as PushTokenRow[] | null) ?? []).map((row) => row.token);
}

export async function deactivateTokens(
  supabaseAdmin: SupabaseClient,
  tokens: string[],
): Promise<number> {
  if (tokens.length === 0) {
    return 0;
  }

  const { data, error } = await supabaseAdmin
    .from("push_tokens")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .in("token", tokens)
    .eq("is_active", true)
    .select("token");

  if (error) {
    throw new AppError("Failed to deactivate invalid tokens", 500, "DB_ERROR", {
      cause: error.message,
    });
  }

  return data?.length ?? 0;
}
