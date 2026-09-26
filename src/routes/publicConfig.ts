import { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { resolvePublicRuntimeConfig } from "../services/publicConfigService.js";
import { logger } from "../utils/logger.js";

export function createPublicConfigRouter(
  supabaseAdmin: SupabaseClient | null,
): Router {
  const router = Router();

  router.get("/public", async (_req: Request, res: Response) => {
    logger.info("Public runtime config endpoint hit");

    const result = await resolvePublicRuntimeConfig(supabaseAdmin);

    logger.info("Public runtime config source resolved", {
      source: result.source,
      validationFallbackUsed: result.validationFallbackUsed,
    });

    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).json(result.config);
  });

  return router;
}
