import { SupabaseClient } from "@supabase/supabase-js";
import { LANGS } from "../languages.js";

/**
 * Feedback, contact messages and data deletion requests sent from inside the
 * app. Deletion is only recorded here; an admin deletes the data by hand.
 */

export const SUPPORT_KINDS = ["feedback", "contact", "data_deletion"] as const;
export type SupportKind = (typeof SUPPORT_KINDS)[number];

const TABLE = "support_requests";
const MAX_MESSAGE_LENGTH = 4000;
const MAX_EMAIL_LENGTH = 254;
const MAX_META_LENGTH = 64;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SupportRequestInput {
  kind: SupportKind;
  appUserId: string | null;
  message: string | null;
  email: string | null;
  appVersion: string | null;
  platform: string | null;
  osVersion: string | null;
  language: string | null;
}

export class SupportValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const shortText = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim().slice(0, MAX_META_LENGTH);
  return text || null;
};

export function parseSupportRequest(body: unknown): SupportRequestInput {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const kind = raw.kind;
  if (typeof kind !== "string" || !(SUPPORT_KINDS as readonly string[]).includes(kind)) {
    throw new SupportValidationError("INVALID_KIND", "Unknown request kind");
  }

  let message: string | null = null;
  if (raw.message != null) {
    if (typeof raw.message !== "string") {
      throw new SupportValidationError("INVALID_MESSAGE", "message must be a string");
    }
    message = raw.message.trim() || null;
  }
  if (message && message.length > MAX_MESSAGE_LENGTH) {
    throw new SupportValidationError("MESSAGE_TOO_LONG", "Message is too long");
  }
  // A deletion request needs no words; the rest are pointless without them.
  if (kind !== "data_deletion" && (!message || message.length < 3)) {
    throw new SupportValidationError("MESSAGE_REQUIRED", "Please write a message");
  }

  let email: string | null = null;
  if (raw.email != null && raw.email !== "") {
    if (typeof raw.email !== "string") {
      throw new SupportValidationError("INVALID_EMAIL", "email must be a string");
    }
    email = raw.email.trim().toLowerCase() || null;
    if (email && (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email))) {
      throw new SupportValidationError("INVALID_EMAIL", "That email address doesn't look right");
    }
  }

  const appUserId =
    typeof raw.appUserId === "string" && raw.appUserId.trim()
      ? raw.appUserId.trim().slice(0, 200)
      : null;
  if (kind === "data_deletion" && !appUserId) {
    throw new SupportValidationError("APP_USER_REQUIRED", "appUserId is required");
  }

  const language = shortText(raw.language);
  return {
    kind: kind as SupportKind,
    appUserId,
    message,
    email,
    appVersion: shortText(raw.appVersion),
    platform: shortText(raw.platform),
    osVersion: shortText(raw.osVersion),
    language: language && (LANGS as readonly string[]).includes(language) ? language : null,
  };
}

export type SaveResult = { ok: true; id: string } | { ok: false; reason: "unavailable" | "error" };

const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";

export async function saveSupportRequest(
  supabaseAdmin: SupabaseClient,
  input: SupportRequestInput,
): Promise<SaveResult> {
  // Tapping "delete my data" twice shouldn't file two requests.
  if (input.kind === "data_deletion") {
    const { data: open, error } = await supabaseAdmin
      .from(TABLE)
      .select("id")
      .eq("kind", "data_deletion")
      .eq("app_user_id", input.appUserId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (error && isMissingTable(error.code)) return { ok: false, reason: "unavailable" };
    if (!error && open?.id) {
      if (input.email) {
        await supabaseAdmin.from(TABLE).update({ email: input.email }).eq("id", open.id);
      }
      return { ok: true, id: open.id };
    }
  }

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .insert({
      app_user_id: input.appUserId,
      kind: input.kind,
      message: input.message,
      email: input.email,
      app_version: input.appVersion,
      platform: input.platform,
      os_version: input.osVersion,
      language: input.language,
    })
    .select("id")
    .single();
  if (error) {
    if (isMissingTable(error.code)) return { ok: false, reason: "unavailable" };
    console.error("❌ Error saving support request:", error);
    return { ok: false, reason: "error" };
  }
  return { ok: true, id: data.id };
}
