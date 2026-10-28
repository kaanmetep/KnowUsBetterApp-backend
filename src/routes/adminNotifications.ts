import { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { adminAuth } from "../middleware/adminAuth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { toErrorResponse } from "../errors/AppError.js";
import { logger } from "../utils/logger.js";
import {
  parseAdminPushRequest,
  sendLocalizedPush,
} from "../services/notificationService.js";
import { supabaseTokenStore } from "../services/pushTokenService.js";
import { AdminPushRequest } from "../types/notifications.js";

const adminPushRateLimiter = createRateLimiter(
  parseInt(process.env.ADMIN_NOTIFICATION_RATE_MAX || "20", 10),
  parseInt(process.env.ADMIN_NOTIFICATION_RATE_WINDOW_MS || "60000", 10),
  "Too many admin notification requests",
);

export function createAdminNotificationsRouter(
  supabaseAdmin: SupabaseClient,
): Router {
  const router = Router();

  router.post(
    "/new-content",
    adminAuth,
    adminPushRateLimiter,
    async (req: Request, res: Response) => {
      try {
        const payload = parseAdminPushRequest(req.body as AdminPushRequest);
        const summary = await sendLocalizedPush(supabaseTokenStore(supabaseAdmin), payload);

        res.status(200).json({
          success: true,
          summary,
        });
      } catch (error) {
        const mapped = toErrorResponse(error);
        logger.error("Admin push trigger failed", {
          statusCode: mapped.statusCode,
          error: mapped.body,
        });
        res.status(mapped.statusCode).json(mapped.body);
      }
    },
  );

  return router;
}
