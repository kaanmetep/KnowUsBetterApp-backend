import { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { byAppUserId, createRateLimiter } from "../middleware/rateLimiter.js";
import { getCategoryCatalog } from "../services/categoryService.js";
import { PUBLIC_RUNTIME_CONFIG } from "../services/publicConfigService.js";
import { requireAppUser } from "../services/appUserAuth.js";

// Per IP, and many players can share one carrier IP; the responses are cached.
const contentRateLimiter = createRateLimiter(
  parseInt(process.env.CONTENT_RATE_LIMIT_MAX || "600", 10),
  60_000,
);

const walletRateLimiter = createRateLimiter(
  parseInt(process.env.WALLET_RATE_LIMIT_MAX || "60", 10),
  60_000,
  undefined,
  byAppUserId((req) => req.params.appUserId),
);

const isActiveNow = (row: any, now: number): boolean =>
  (!row.start_date || new Date(row.start_date).getTime() <= now) &&
  (!row.end_date || new Date(row.end_date).getTime() >= now);

/**
 * Everything the app used to read from Supabase directly: categories,
 * announcements and the player's wallet.
 */
export function createContentRouter(
  supabaseAdmin: SupabaseClient,
  options: { devUnlimitedDailyReward: boolean },
): Router {
  const router = Router();

  router.get("/categories", contentRateLimiter, async (_req, res: Response) => {
    try {
      const { categories, groups } = await getCategoryCatalog(supabaseAdmin);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({
        categories: categories
          .filter((category) => category.isListed)
          .map(({ isListed, ...category }) => category),
        groups,
      });
    } catch (error) {
      console.error("❌ Error loading categories:", error);
      res.status(500).json({ error: "Failed to load categories" });
    }
  });

  router.get(
    "/announcements",
    contentRateLimiter,
    async (_req, res: Response) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("announcements")
          .select("*")
          .eq("is_active", true)
          .order("priority", { ascending: false })
          .order("created_at", { ascending: false });
        if (error) throw error;

        const now = Date.now();
        res.setHeader("Cache-Control", "public, max-age=60");
        res.json({
          announcements: (data ?? [])
            .filter((row) => isActiveNow(row, now))
            .map((row) => ({
              id: row.id,
              title: row.title ?? {},
              message: row.message ?? {},
              isActive: row.is_active,
              priority: row.priority ?? 0,
              startDate: row.start_date,
              endDate: row.end_date,
              actionUrl: row.action_url,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            })),
        });
      } catch (error) {
        console.error("❌ Error loading announcements:", error);
        res.status(500).json({ error: "Failed to load announcements" });
      }
    },
  );

  router.get(
    "/wallet/:appUserId",
    walletRateLimiter,
    requireAppUser(supabaseAdmin, (req) => String(req.params.appUserId ?? "").trim()),
    async (req: Request, res: Response) => {
      const appUserId = String(req.params.appUserId ?? "").trim();
      if (!appUserId || appUserId.length > 200) {
        res.status(400).json({ error: "Invalid appUserId" });
        return;
      }

      try {
        const { data, error } = await supabaseAdmin
          .from("coins")
          .select("balance, last_daily_reward_at")
          .eq("app_user_id", appUserId)
          .maybeSingle();
        if (error) throw error;

        const lastClaim = data?.last_daily_reward_at
          ? new Date(data.last_daily_reward_at).getTime()
          : null;
        const nextClaimAt =
          lastClaim !== null && !options.devUnlimitedDailyReward
            ? lastClaim + PUBLIC_RUNTIME_CONFIG.economy.dailyReward.intervalMs
            : null;
        const eligible = nextClaimAt === null || nextClaimAt <= Date.now();

        res.setHeader("Cache-Control", "no-store");
        res.json({
          appUserId,
          // null: no row yet (nothing bought or claimed so far).
          balance: data ? data.balance ?? 0 : null,
          dailyReward: {
            eligible,
            nextClaimAt:
              !eligible && nextClaimAt !== null
                ? new Date(nextClaimAt).toISOString()
                : null,
          },
        });
      } catch (error) {
        console.error("❌ Error loading wallet:", error);
        res.status(500).json({ error: "Failed to load wallet" });
      }
    },
  );

  return router;
}
