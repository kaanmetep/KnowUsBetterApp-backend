import { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { logger } from "../utils/logger.js";
import { toErrorResponse } from "../errors/AppError.js";
import {
  upsertPushToken,
  validateRegisterTokenInput,
} from "../services/pushTokenService.js";
import { RegisterTokenInput } from "../types/notifications.js";

const registerTokenRateLimiter = createRateLimiter(
  parseInt(process.env.NOTIFICATION_REGISTER_RATE_MAX || "120", 10),
  parseInt(process.env.NOTIFICATION_REGISTER_RATE_WINDOW_MS || "60000", 10),
  "Too many token registration attempts",
);

export function createNotificationsRouter(supabaseAdmin: SupabaseClient): Router {
  const router = Router();

  router.post(
    "/register-token",
    registerTokenRateLimiter,
    async (req: Request, res: Response) => {
      try {
        const body = req.body as RegisterTokenInput;
        validateRegisterTokenInput(body);
        await upsertPushToken(supabaseAdmin, body);

        logger.info("Push token registered", {
          appUserId: body.appUserId,
          platform: body.platform,
        });

        res.status(200).json({
          success: true,
          message: "Token registered successfully",
        });
      } catch (error) {
        const mapped = toErrorResponse(error);
        logger.error("Failed to register push token", {
          statusCode: mapped.statusCode,
          error: mapped.body,
        });
        res.status(mapped.statusCode).json(mapped.body);
      }
    },
  );

  return router;
}
