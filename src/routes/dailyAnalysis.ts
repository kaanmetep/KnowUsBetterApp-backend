import { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { byAppUserId, createRateLimiter } from "../middleware/rateLimiter.js";
import { requireAppUser } from "../services/appUserAuth.js";
import {
  DailyAnalysisReport,
  getDailyAnalysisFor,
  getDailyAnalysisStatus,
  getRetryableDailyAnalysis,
  listDailyAnalysesFor,
  writeDailyAnalysis,
} from "../services/dailyAnalysis.js";
import { acquireLock, releaseLock } from "../utils/redis.js";

const readRateLimiter = createRateLimiter(
  60,
  60_000,
  undefined,
  byAppUserId((req) => req.params.appUserId),
);

const retryRateLimiter = createRateLimiter(
  5,
  60_000,
  "Too many retries. Please wait a minute before trying again.",
  byAppUserId((req) => req.params.appUserId),
);

const HISTORY_LIMIT = 60;

/** Express 4 ignores a rejected handler, which would leave the request hanging. */
const catchErrors =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response): void => {
    handler(req, res).catch((error) => {
      console.error("❌ Daily analysis request failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong." });
    });
  };

const appUserIdOf = (req: Request) => String(req.params.appUserId ?? "").trim();

export const dailyAnalysisLockKey = (id: string) => `lock:daily-analysis:${id}`;
export const DAILY_ANALYSIS_LOCK_SECONDS = 180;

export function createDailyAnalysisRouter(
  supabaseAdmin: SupabaseClient,
  {
    onReady,
  }: {
    /** A retried report was written; tells the players' apps. */
    onReady: (analysisId: string, appUserIds: string[], report: DailyAnalysisReport) => void;
  },
): Router {
  const router = Router();
  const auth = requireAppUser(supabaseAdmin, appUserIdOf);

  router.get(
    "/:appUserId/status",
    readRateLimiter,
    auth,
    catchErrors(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await getDailyAnalysisStatus(supabaseAdmin, appUserIdOf(req)));
    }),
  );

  router.get(
    "/:appUserId/history",
    readRateLimiter,
    auth,
    catchErrors(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({
        analyses: await listDailyAnalysesFor(supabaseAdmin, appUserIdOf(req), HISTORY_LIMIT),
      });
    }),
  );

  router.get(
    "/:appUserId/:id",
    readRateLimiter,
    auth,
    catchErrors(async (req, res) => {
      const analysis = await getDailyAnalysisFor(
        supabaseAdmin,
        appUserIdOf(req),
        String(req.params.id),
      );
      if (!analysis) {
        res.status(404).json({ error: "Analysis not found.", code: "NOT_FOUND" });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(analysis);
    }),
  );

  // The game was paid for when it started, so writing a failed report again is free.
  router.post(
    "/:appUserId/:id/retry",
    retryRateLimiter,
    auth,
    catchErrors(async (req, res) => {
      const appUserId = appUserIdOf(req);
      const id = String(req.params.id);
      const lockKey = dailyAnalysisLockKey(id);
      if (!(await acquireLock(lockKey, DAILY_ANALYSIS_LOCK_SECONDS))) {
        res.status(409).json({ error: "Already being written.", code: "IN_PROGRESS" });
        return;
      }
      try {
        const row = await getRetryableDailyAnalysis(supabaseAdmin, appUserId, id);
        if (!row) {
          res.status(409).json({ error: "Nothing to retry.", code: "NOT_RETRYABLE" });
          return;
        }
        try {
          const { report } = await writeDailyAnalysis(supabaseAdmin, id);
          onReady(id, row.participant_ids, report);
        } catch (error) {
          console.error(`❌ Daily analysis retry ${id} failed:`, error);
          res.status(502).json({ error: "The analysis couldn't be written.", code: "ANALYSIS_FAILED" });
          return;
        }
        res.json(await getDailyAnalysisFor(supabaseAdmin, appUserId, id));
      } finally {
        await releaseLock(lockKey);
      }
    }),
  );

  return router;
}
