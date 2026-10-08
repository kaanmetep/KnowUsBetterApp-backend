import express from "express";
import crypto from "crypto";

/** Request with the unparsed body, kept by the webhook's JSON parser. */
export type RawBodyRequest = express.Request & { rawBody?: Buffer };

// Retries get a fresh signature, so an old timestamp means a replay.
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function keepRawBody(
  req: express.Request,
  _res: express.Response,
  buf: Buffer,
): void {
  (req as RawBodyRequest).rawBody = buf;
}

/** `X-RevenueCat-Webhook-Signature: t=<unix seconds>,v1=<hex hmac of "t.body">`. */
function hasValidSignature(
  header: string | undefined,
  rawBody: Buffer | undefined,
  secret: string,
): boolean {
  if (!header || !rawBody) return false;
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, rest.join("=")];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.`)
    .update(rawBody)
    .digest("hex");
  return safeEqual(parts.v1, expected);
}

/**
 * RevenueCat sends the Authorization header value set in its dashboard as is;
 * it must equal REVENUECAT_WEBHOOK_SECRET (with or without "Bearer ").
 * With REVENUECAT_WEBHOOK_HMAC_SECRET set, the HMAC signature is required too.
 */
export function verifyRevenueCatRequest(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret) {
    console.error("❌ REVENUECAT_WEBHOOK_SECRET is not set; rejecting webhook");
    res.status(500).json({ error: "Webhook not configured" });
    return;
  }

  const authorization = req.headers.authorization ?? "";
  if (
    !safeEqual(authorization, secret) &&
    !safeEqual(authorization, `Bearer ${secret}`)
  ) {
    console.warn("🚫 RevenueCat webhook rejected: bad Authorization header");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const hmacSecret = process.env.REVENUECAT_WEBHOOK_HMAC_SECRET;
  if (
    hmacSecret &&
    !hasValidSignature(
      req.header("x-revenuecat-webhook-signature"),
      (req as RawBodyRequest).rawBody,
      hmacSecret,
    )
  ) {
    console.warn("🚫 RevenueCat webhook rejected: bad signature");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
