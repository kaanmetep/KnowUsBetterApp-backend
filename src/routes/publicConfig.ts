import { Router, Request, Response } from "express";
import { PUBLIC_RUNTIME_CONFIG } from "../services/publicConfigService.js";

export function createPublicConfigRouter(): Router {
  const router = Router();

  router.get("/public", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).json(PUBLIC_RUNTIME_CONFIG);
  });

  return router;
}
