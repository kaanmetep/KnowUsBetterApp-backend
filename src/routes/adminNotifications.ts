import { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { adminAuth } from "../middleware/adminAuth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { AppError, toErrorResponse } from "../errors/AppError.js";
import { logger } from "../utils/logger.js";
import { sendNewContentPush } from "../services/notificationService.js";
import { AdminNewContentInput } from "../types/notifications.js";

const adminPushRateLimiter = createRateLimiter(
  parseInt(process.env.ADMIN_NOTIFICATION_RATE_MAX || "20", 10),
  parseInt(process.env.ADMIN_NOTIFICATION_RATE_WINDOW_MS || "60000", 10),
  "Too many admin notification requests",
);

function validateAdminPayload(payload: AdminNewContentInput): void {
  if (!payload.title || typeof payload.title !== "string") {
    throw new AppError("title is required", 400, "VALIDATION_ERROR");
  }

  if (!payload.body || typeof payload.body !== "string") {
    throw new AppError("body is required", 400, "VALIDATION_ERROR");
  }

  if (payload.type !== "new_category" && payload.type !== "new_questions") {
    throw new AppError(
      "type must be new_category or new_questions",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (payload.categoryId && typeof payload.categoryId !== "string") {
    throw new AppError("categoryId must be string", 400, "VALIDATION_ERROR");
  }
}

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
        const body = req.body as AdminNewContentInput;
        validateAdminPayload(body);

        const summary = await sendNewContentPush(supabaseAdmin, {
          title: body.title,
          body: body.body,
          data: {
            type: body.type,
            ...(body.categoryId ? { categoryId: body.categoryId } : {}),
          },
        });

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
