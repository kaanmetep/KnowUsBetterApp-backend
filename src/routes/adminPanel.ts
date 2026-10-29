import path from "path";
import express, { NextFunction, Request, Response, Router } from "express";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { AppError, toErrorResponse } from "../errors/AppError.js";
import { logger } from "../utils/logger.js";
import {
  SESSION_TTL_SECONDS,
  assertNotLockedOut,
  consumeStepUp,
  createAuthenticationOptions,
  createRegistrationOptions,
  createSession,
  destroySession,
  getSession,
  getWebAuthnConfig,
  grantStepUp,
  hasRegisteredPasskey,
  isValidSetupToken,
  recordFailure,
  verifyAuthentication,
  verifyRegistration,
} from "../services/adminAuthService.js";
import {
  createQuestion,
  deleteQuestion,
  listCategories,
  listQuestions,
  updateQuestion,
  validateQuestionInput,
} from "../services/adminQuestionService.js";
import {
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  setAnnouncementActive,
  updateAnnouncement,
  validateAnnouncementInput,
} from "../services/adminAnnouncementService.js";
import { runSql } from "../services/adminSqlService.js";
import {
  parseAdminPushRequest,
  PushDispatchSummary,
  sendLocalizedPush,
} from "../services/notificationService.js";
import { pgTokenStore } from "../services/pushTokenService.js";
import {
  countPushUsersByLanguage,
  grantPushReward,
  parsePushCoinReward,
  PushRewardSummary,
} from "../services/pushRewardService.js";
import { getAdminPool } from "../utils/adminDb.js";

const COOKIE_NAME = "kub_admin";
const STATIC_DIR = path.resolve(process.cwd(), "public/admin");
const WEBAUTHN_BROWSER_BUNDLE = path.resolve(
  process.cwd(),
  "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js",
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const panelRateLimiter = createRateLimiter(120, 60_000, "Too many requests");
const authRateLimiter = createRateLimiter(20, 15 * 60_000, "Too many login attempts");
const pushRateLimiter = createRateLimiter(10, 60_000, "Too many notification sends");

type Handler = (req: Request, res: Response) => Promise<void>;

function handle(fn: Handler) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      const mapped = toErrorResponse(error);
      if (mapped.statusCode === 500 && res.locals.isAdmin && error instanceof Error) {
        mapped.body.message = error.message;
      }
      logger.error("Admin panel request failed", {
        path: req.path,
        statusCode: mapped.statusCode,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(mapped.statusCode).json(mapped.body);
    }
  };
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// Passkey-free access for local development. Only the raw socket address is trusted
// (never X-Forwarded-For), so this can't trigger behind Render's proxy even if the flag leaks.
function isLocalBypass(req: Request): boolean {
  if (process.env.ADMIN_LOCAL_BYPASS !== "true" || process.env.NODE_ENV === "production") {
    return false;
  }
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  return (
    isLoopback(req.socket.remoteAddress) &&
    !req.headers["x-forwarded-for"] &&
    (host === "localhost" || host === "127.0.0.1")
  );
}

function isHttps(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${req.baseUrl || "/"}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (isHttps(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(req: Request, res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=${req.baseUrl || "/"}; Max-Age=0; HttpOnly; SameSite=Strict`,
  );
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  next();
}

function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  const origin = req.headers.origin;
  const allowed =
    origin === getWebAuthnConfig().origin ||
    (isLocalBypass(req) && origin === `http://${req.headers.host}`);
  if (!allowed) {
    res.status(403).json({ message: "Forbidden", code: "BAD_ORIGIN" });
    return;
  }
  next();
}

async function sessionToken(req: Request): Promise<string | null> {
  const token = readCookie(req, COOKIE_NAME);
  return token && (await getSession(token)) ? token : null;
}

function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (isLocalBypass(req)) {
    res.locals.isAdmin = true;
    res.locals.localBypass = true;
    next();
    return;
  }
  sessionToken(req)
    .then((token) => {
      if (!token) {
        res.status(401).json({ message: "Unauthorized", code: "UNAUTHORIZED" });
        return;
      }
      res.locals.sessionToken = token;
      res.locals.isAdmin = true;
      next();
    })
    .catch(() => {
      res.status(503).json({ message: "Session store unavailable", code: "SESSION_STORE" });
    });
}

async function withFailureTracking<T>(fn: () => Promise<T>): Promise<T> {
  await assertNotLockedOut();
  try {
    return await fn();
  } catch (error) {
    await recordFailure().catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(
      error instanceof Error ? error.message : "Verification failed",
      401,
      "AUTH_FAILED",
    );
  }
}

async function assertCanRegister(req: Request): Promise<void> {
  if (!isValidSetupToken(req.body?.setupToken)) {
    throw new AppError("Invalid setup token", 401, "INVALID_SETUP_TOKEN");
  }
  if ((await hasRegisteredPasskey()) && !(await sessionToken(req))) {
    throw new AppError(
      "A passkey is already registered; log in first to add another device",
      403,
      "REGISTRATION_CLOSED",
    );
  }
}

export function createAdminPanelRouter(): Router {
  const router = Router();

  if (process.env.ADMIN_LOCAL_BYPASS === "true" && process.env.NODE_ENV !== "production") {
    logger.warn("Admin panel local bypass is ON: localhost requests skip passkey auth");
  }

  router.use(securityHeaders, panelRateLimiter);

  router.get("/", (req, res, next) => {
    if (!req.originalUrl.split("?")[0].endsWith("/")) {
      res.redirect(301, `${req.baseUrl}/`);
      return;
    }
    next();
  });
  router.get("/webauthn.js", (_req, res) => res.sendFile(WEBAUTHN_BROWSER_BUNDLE));
  router.use(express.static(STATIC_DIR, { index: "index.html", maxAge: 0 }));

  const api = Router();
  api.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  api.use(requireSameOrigin);

  api.get(
    "/auth/status",
    handle(async (req, res) => {
      if (isLocalBypass(req)) {
        res.json({ registered: true, loggedIn: true, localBypass: true });
        return;
      }
      res.json({
        registered: await hasRegisteredPasskey(),
        loggedIn: Boolean(await sessionToken(req)),
        localBypass: false,
      });
    }),
  );

  api.post(
    "/auth/register/options",
    authRateLimiter,
    handle(async (req, res) => {
      await withFailureTracking(() => assertCanRegister(req));
      res.json(await createRegistrationOptions());
    }),
  );

  api.post(
    "/auth/register/verify",
    authRateLimiter,
    handle(async (req, res) => {
      await withFailureTracking(async () => {
        await assertCanRegister(req);
        const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 60) : null;
        await verifyRegistration(req.body?.challengeId, req.body?.response, label);
      });
      logger.info("Admin passkey registered");
      res.json({ success: true });
    }),
  );

  api.post(
    "/auth/login/options",
    authRateLimiter,
    handle(async (_req, res) => {
      await assertNotLockedOut();
      res.json(await createAuthenticationOptions());
    }),
  );

  api.post(
    "/auth/login/verify",
    authRateLimiter,
    handle(async (req, res) => {
      await withFailureTracking(() =>
        verifyAuthentication(req.body?.challengeId, req.body?.response),
      );
      setSessionCookie(req, res, await createSession());
      logger.info("Admin logged in");
      res.json({ success: true });
    }),
  );

  api.post(
    "/auth/logout",
    handle(async (req, res) => {
      await destroySession(readCookie(req, COOKIE_NAME));
      clearSessionCookie(req, res);
      res.json({ success: true });
    }),
  );

  api.use(requireSession);

  api.post(
    "/auth/step-up/options",
    authRateLimiter,
    handle(async (_req, res) => {
      await assertNotLockedOut();
      res.json(await createAuthenticationOptions());
    }),
  );

  api.post(
    "/auth/step-up/verify",
    authRateLimiter,
    handle(async (req, res) => {
      await withFailureTracking(() =>
        verifyAuthentication(req.body?.challengeId, req.body?.response),
      );
      await grantStepUp(res.locals.sessionToken);
      res.json({ success: true });
    }),
  );

  api.get(
    "/categories",
    handle(async (_req, res) => {
      res.json({ categories: await listCategories() });
    }),
  );

  api.get(
    "/questions",
    handle(async (req, res) => {
      const category = req.query.category;
      if (typeof category !== "string" || !category) {
        throw new AppError("category is required", 400, "VALIDATION_ERROR");
      }
      res.json({ questions: await listQuestions(category) });
    }),
  );

  api.post(
    "/questions",
    handle(async (req, res) => {
      const question = await createQuestion(validateQuestionInput(req.body));
      logger.info("Admin created question", { id: question.id, category: question.category_id });
      res.status(201).json({ question });
    }),
  );

  api.put(
    "/questions/:id",
    handle(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) {
        throw new AppError("Invalid id", 400, "VALIDATION_ERROR");
      }
      const question = await updateQuestion(req.params.id, validateQuestionInput(req.body));
      logger.info("Admin updated question", { id: question.id });
      res.json({ question });
    }),
  );

  api.delete(
    "/questions/:id",
    handle(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) {
        throw new AppError("Invalid id", 400, "VALIDATION_ERROR");
      }
      await deleteQuestion(req.params.id);
      logger.info("Admin deleted question", { id: req.params.id });
      res.json({ success: true });
    }),
  );

  api.post(
    "/sql",
    handle(async (req, res) => {
      const mode = req.body?.mode === "apply" ? "apply" : "preview";
      if (
        mode === "apply" &&
        !res.locals.localBypass &&
        !(await consumeStepUp(res.locals.sessionToken))
      ) {
        throw new AppError("Face ID confirmation required", 403, "STEP_UP_REQUIRED");
      }
      const result = await runSql(req.body?.sql, mode);
      logger.info("Admin ran SQL", {
        mode,
        statements: result.results.map((r) => `${r.command}:${r.rowCount}`),
      });
      res.json(result);
    }),
  );

  const assertUuid = (id: string) => {
    if (!UUID_RE.test(id)) throw new AppError("Invalid id", 400, "VALIDATION_ERROR");
  };

  api.get(
    "/announcements",
    handle(async (_req, res) => {
      res.json({ announcements: await listAnnouncements() });
    }),
  );

  api.post(
    "/announcements",
    handle(async (req, res) => {
      const announcement = await createAnnouncement(validateAnnouncementInput(req.body));
      logger.info("Admin created announcement", { id: announcement.id });
      res.status(201).json({ announcement });
    }),
  );

  api.put(
    "/announcements/:id",
    handle(async (req, res) => {
      assertUuid(req.params.id);
      const announcement = await updateAnnouncement(
        req.params.id,
        validateAnnouncementInput(req.body),
      );
      logger.info("Admin updated announcement", { id: announcement.id });
      res.json({ announcement });
    }),
  );

  api.patch(
    "/announcements/:id/active",
    handle(async (req, res) => {
      assertUuid(req.params.id);
      if (typeof req.body?.is_active !== "boolean") {
        throw new AppError("is_active must be a boolean", 400, "VALIDATION_ERROR");
      }
      const announcement = await setAnnouncementActive(req.params.id, req.body.is_active);
      logger.info("Admin toggled announcement", { id: announcement.id, isActive: announcement.is_active });
      res.json({ announcement });
    }),
  );

  api.delete(
    "/announcements/:id",
    handle(async (req, res) => {
      assertUuid(req.params.id);
      await deleteAnnouncement(req.params.id);
      logger.info("Admin deleted announcement", { id: req.params.id });
      res.json({ success: true });
    }),
  );

  // Same database as the question tools (DATABASE_URL), so a local panel
  // pointed at prod reaches prod devices.
  const tokenStore = () => pgTokenStore(getAdminPool());

  api.get(
    "/notifications/audience",
    handle(async (_req, res) => {
      const [byLanguage, usersByLanguage] = await Promise.all([
        tokenStore().countActiveIosTokensByLanguage(),
        countPushUsersByLanguage(getAdminPool()),
      ]);
      res.json({ byLanguage, usersByLanguage });
    }),
  );

  // Sending to a single appUserId is a test send and skips Face ID; a
  // broadcast needs a fresh step-up like an SQL apply. A broadcast must also
  // be asked for explicitly, so a test send that lost its appUserId can't
  // reach everyone (the local bypass skips Face ID).
  api.post(
    "/notifications/send",
    pushRateLimiter,
    handle(async (req, res) => {
      const payload = parseAdminPushRequest(req.body);
      const coins = parsePushCoinReward(req.body?.coins);
      if (!payload.appUserId && req.body?.broadcast !== true) {
        throw new AppError("appUserId is required for a test send", 400, "VALIDATION_ERROR");
      }
      if (
        !payload.appUserId &&
        !res.locals.localBypass &&
        !(await consumeStepUp(res.locals.sessionToken))
      ) {
        throw new AppError("Face ID confirmation required", 403, "STEP_UP_REQUIRED");
      }
      // Coins go once per user whose device accepted the push, so users
      // without notification permission (no active token) get nothing.
      const deliveredUsers = new Set<string>();
      let summary: PushDispatchSummary;
      let coinReward: PushRewardSummary | null = null;
      try {
        summary = await sendLocalizedPush(tokenStore(), payload, { deliveredUsers });
      } finally {
        // A send that fails halfway has still reached these users.
        if (coins > 0) {
          coinReward = await grantPushReward(getAdminPool(), deliveredUsers, coins);
        }
      }
      logger.info("Admin sent push notification", {
        type: payload.data.type,
        categoryId: payload.data.categoryId,
        languages: Object.keys(payload.texts),
        targeted: Boolean(payload.appUserId),
        totalTokens: summary.totalTokens,
        coins,
        coinsCreditedUsers: coinReward?.creditedUsers ?? 0,
      });
      res.json({ summary, coinReward });
    }),
  );

  router.use("/api", api);
  return router;
}
