import { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { claimAppUser, isValidAppUserId } from "../services/appUserAuth.js";

// Per IP: every new install claims once, and installs can share a carrier IP.
const claimRateLimiter = createRateLimiter(
  30,
  60_000,
  "Too many requests. Please try again in a minute.",
);

export function createIdentityRouter(supabaseAdmin: SupabaseClient): Router {
  const router = Router();

  // POST /api/identity/claim — the app's first call for its appUserId; the
  // returned token is shown only once.
  router.post("/claim", claimRateLimiter, async (req: Request, res: Response) => {
    const appUserId = req.body?.appUserId;
    if (!isValidAppUserId(appUserId)) {
      res.status(400).json({ error: "Invalid appUserId", code: "INVALID_REQUEST" });
      return;
    }

    try {
      const result = await claimAppUser(supabaseAdmin, appUserId);
      if (result.ok) {
        res.setHeader("Cache-Control", "no-store");
        res.json({ appUserId, token: result.token });
        return;
      }
      if (result.reason === "claimed") {
        console.warn(`🚫 Claim for already claimed appUserId ${appUserId}`);
        res.status(409).json({
          error: "This id is already in use on another device.",
          code: "ALREADY_CLAIMED",
        });
        return;
      }
      res.status(503).json({
        error: "Please try again later.",
        code: result.reason === "unavailable" ? "CLAIM_UNAVAILABLE" : "CLAIM_FAILED",
      });
    } catch (error) {
      console.error("❌ Error claiming appUserId:", error);
      res.status(503).json({ error: "Please try again later.", code: "CLAIM_FAILED" });
    }
  });

  return router;
}
