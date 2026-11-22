import { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { APP_USER_TOKEN_HEADER, checkAppUser } from "../services/appUserAuth.js";
import {
  parseSupportRequest,
  saveSupportRequest,
  SupportValidationError,
} from "../services/supportRequests.js";

// Per IP: a player rarely writes more than a couple of messages.
const supportRateLimiter = createRateLimiter(
  parseInt(process.env.SUPPORT_RATE_LIMIT_MAX || "8", 10),
  10 * 60_000,
  "Too many messages. Please try again a bit later.",
);

export function createSupportRouter(supabaseAdmin: SupabaseClient): Router {
  const router = Router();

  // POST /api/support — feedback, contact or data deletion request.
  router.post("/", supportRateLimiter, async (req: Request, res: Response) => {
    let input;
    try {
      input = parseSupportRequest(req.body);
    } catch (error) {
      if (error instanceof SupportValidationError) {
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }

    try {
      // Only the device that owns an id may ask for its data to be deleted;
      // otherwise anyone who saw an id could get someone else's coins wiped.
      if (input.kind === "data_deletion") {
        const check = await checkAppUser(
          supabaseAdmin,
          input.appUserId!,
          req.get(APP_USER_TOKEN_HEADER),
        );
        if (check === "error") {
          res.status(503).json({ error: "Please try again in a moment.", code: "SUPPORT_UNAVAILABLE" });
          return;
        }
        if (check !== "verified") {
          res.status(401).json({
            error: "This device isn't signed in to that user id.",
            code: "APP_USER_UNAUTHORIZED",
          });
          return;
        }
      }

      const result = await saveSupportRequest(supabaseAdmin, input);
      if (!result.ok) {
        res.status(503).json({ error: "Please try again later.", code: "SUPPORT_UNAVAILABLE" });
        return;
      }
      console.log(`📮 Support request (${input.kind}) from ${input.appUserId ?? "unknown"}`);
      res.status(201).json({ id: result.id });
    } catch (error) {
      console.error("❌ Error handling support request:", error);
      res.status(500).json({ error: "Please try again later.", code: "SUPPORT_FAILED" });
    }
  });

  return router;
}
