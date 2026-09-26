import { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger.js";
import { NewContentPushInput, TokenSendResult } from "../types/notifications.js";
import { ApnsService, isInvalidTokenReason } from "./apnsService.js";
import {
  deactivateTokens,
  getActiveIosTokensPage,
} from "./pushTokenService.js";

interface SendOptions {
  pageSize?: number;
  concurrency?: number;
}

export interface PushDispatchSummary {
  totalTokens: number;
  totalSuccess: number;
  totalFailure: number;
  invalidatedTokenCount: number;
}

export async function sendNewContentPush(
  supabaseAdmin: SupabaseClient,
  payload: NewContentPushInput,
  options?: SendOptions,
): Promise<PushDispatchSummary> {
  const pageSize = options?.pageSize ?? 200;
  const concurrency = options?.concurrency ?? 25;
  const apnsService = new ApnsService();

  let page = 0;
  let totalTokens = 0;
  let totalSuccess = 0;
  let totalFailure = 0;
  const invalidTokens = new Set<string>();

  try {
    while (true) {
      const tokens = await getActiveIosTokensPage(supabaseAdmin, page, pageSize);
      if (tokens.length === 0) {
        break;
      }

      totalTokens += tokens.length;
      const results = await apnsService.sendBatch(tokens, payload, { concurrency });
      summarizeResults(results, invalidTokens, (success, failure) => {
        totalSuccess += success;
        totalFailure += failure;
      });

      logger.info("Push batch completed", {
        page,
        batchSize: tokens.length,
        success: results.filter((item) => item.success).length,
        failure: results.filter((item) => !item.success).length,
      });

      page += 1;
    }

    const invalidatedTokenCount = await deactivateTokens(
      supabaseAdmin,
      Array.from(invalidTokens),
    );

    logger.info("Push dispatch finished", {
      totalTokens,
      totalSuccess,
      totalFailure,
      invalidatedTokenCount,
    });

    return {
      totalTokens,
      totalSuccess,
      totalFailure,
      invalidatedTokenCount,
    };
  } finally {
    apnsService.shutdown();
  }
}

function summarizeResults(
  results: TokenSendResult[],
  invalidTokens: Set<string>,
  onCount: (success: number, failure: number) => void,
): void {
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

  onCount(success, failure);
}
