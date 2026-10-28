import { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors/AppError.js";
import { logger } from "../utils/logger.js";
import {
  AdminPushRequest,
  LocalizedPushInput,
  PUSH_CONTENT_TYPES,
  PUSH_LANGUAGES,
  PushContentType,
  PushLanguage,
  PushText,
  TokenSendResult,
} from "../types/notifications.js";
import { ApnsService, isInvalidTokenReason } from "./apnsService.js";
import {
  deactivateTokens,
  getActiveIosTokensPage,
} from "./pushTokenService.js";

// APNs rejects payloads over 4 KB; these keep a full alert well under it.
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 600;
const CATEGORY_ID_RE = /^[a-z0-9_-]{1,64}$/i;

interface SendOptions {
  pageSize?: number;
  concurrency?: number;
}

export interface LanguageDispatchSummary {
  totalTokens: number;
  totalSuccess: number;
  totalFailure: number;
}

export interface PushDispatchSummary {
  totalTokens: number;
  totalSuccess: number;
  totalFailure: number;
  invalidatedTokenCount: number;
  byLanguage: Partial<Record<PushLanguage, LanguageDispatchSummary>>;
}

function readText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new AppError(`${field} must be a string`, 400, "VALIDATION_ERROR");
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new AppError(`${field} is longer than ${max} characters`, 400, "VALIDATION_ERROR");
  }
  return trimmed;
}

function readPushText(raw: Partial<PushText> | undefined, label: string): PushText | null {
  const title = readText(raw?.title, `${label} title`, MAX_TITLE_LENGTH);
  const body = readText(raw?.body, `${label} body`, MAX_BODY_LENGTH);
  if (!title && !body) return null;
  if (!title || !body) {
    throw new AppError(`${label} needs both a title and a body`, 400, "VALIDATION_ERROR");
  }
  return { title, body };
}

export function parseAdminPushRequest(raw: AdminPushRequest): LocalizedPushInput {
  const request = raw ?? {};
  const texts: Partial<Record<PushLanguage, PushText>> = {};

  if (request.texts !== undefined) {
    if (typeof request.texts !== "object" || request.texts === null) {
      throw new AppError("texts must be an object", 400, "VALIDATION_ERROR");
    }
    for (const language of PUSH_LANGUAGES) {
      const text = readPushText(request.texts[language], language.toUpperCase());
      if (text) texts[language] = text;
    }
  } else {
    const shared = readPushText({ title: request.title, body: request.body }, "Notification");
    if (shared) {
      for (const language of PUSH_LANGUAGES) texts[language] = shared;
    }
  }

  if (!Object.keys(texts).length) {
    throw new AppError("At least one language needs a title and body", 400, "VALIDATION_ERROR");
  }

  const type: PushContentType = request.type ?? "general";
  if (!PUSH_CONTENT_TYPES.includes(type)) {
    throw new AppError(
      `type must be one of ${PUSH_CONTENT_TYPES.join(", ")}`,
      400,
      "VALIDATION_ERROR",
    );
  }

  const categoryId = readText(request.categoryId, "categoryId", 64);
  if (categoryId && !CATEGORY_ID_RE.test(categoryId)) {
    throw new AppError("categoryId is invalid", 400, "VALIDATION_ERROR");
  }
  if (type === "new_category" && !categoryId) {
    throw new AppError("categoryId is required for new_category", 400, "VALIDATION_ERROR");
  }

  const appUserId = readText(request.appUserId, "appUserId", 200);

  return {
    texts,
    data: {
      type,
      ...(categoryId && type !== "general" ? { categoryId } : {}),
    },
    ...(appUserId ? { appUserId } : {}),
  };
}

export async function sendLocalizedPush(
  supabaseAdmin: SupabaseClient,
  payload: LocalizedPushInput,
  options?: SendOptions,
): Promise<PushDispatchSummary> {
  const pageSize = options?.pageSize ?? 200;
  const concurrency = options?.concurrency ?? 25;
  const apnsService = new ApnsService();

  const summary: PushDispatchSummary = {
    totalTokens: 0,
    totalSuccess: 0,
    totalFailure: 0,
    invalidatedTokenCount: 0,
    byLanguage: {},
  };
  const invalidTokens = new Set<string>();

  try {
    for (const language of PUSH_LANGUAGES) {
      const text = payload.texts[language];
      if (!text) continue;

      const languageSummary: LanguageDispatchSummary = {
        totalTokens: 0,
        totalSuccess: 0,
        totalFailure: 0,
      };
      summary.byLanguage[language] = languageSummary;

      for (let page = 0; ; page += 1) {
        const tokens = await getActiveIosTokensPage(
          supabaseAdmin,
          { language, appUserId: payload.appUserId },
          page,
          pageSize,
        );
        if (tokens.length === 0) break;

        const results = await apnsService.sendBatch(
          tokens,
          { ...text, data: payload.data },
          { concurrency },
        );
        const { success, failure } = summarizeResults(results, invalidTokens);
        languageSummary.totalTokens += tokens.length;
        languageSummary.totalSuccess += success;
        languageSummary.totalFailure += failure;

        logger.info("Push batch completed", {
          language,
          page,
          batchSize: tokens.length,
          success,
          failure,
        });

        if (tokens.length < pageSize) break;
      }

      summary.totalTokens += languageSummary.totalTokens;
      summary.totalSuccess += languageSummary.totalSuccess;
      summary.totalFailure += languageSummary.totalFailure;
    }

    summary.invalidatedTokenCount = await deactivateTokens(
      supabaseAdmin,
      Array.from(invalidTokens),
    );

    logger.info("Push dispatch finished", {
      totalTokens: summary.totalTokens,
      totalSuccess: summary.totalSuccess,
      totalFailure: summary.totalFailure,
      invalidatedTokenCount: summary.invalidatedTokenCount,
      languages: Object.keys(summary.byLanguage),
      targeted: Boolean(payload.appUserId),
    });

    return summary;
  } finally {
    apnsService.shutdown();
  }
}

function summarizeResults(
  results: TokenSendResult[],
  invalidTokens: Set<string>,
): { success: number; failure: number } {
  let success = 0;
  let failure = 0;

  for (const result of results) {
    if (result.success) {
      success += 1;
      continue;
    }

    failure += 1;
    if (isInvalidTokenReason(result.reason)) {
      invalidTokens.add(result.token);
    }
  }

  return { success, failure };
}
