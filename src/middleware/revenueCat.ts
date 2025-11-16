import express from "express";
import crypto from "crypto";

// RevenueCat Signature Validation Middleware.
export function verifyRevenueCatSignature(
  req: express.Request,
  res: express.Response,
  buf: Buffer
): void {
  const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET;
  const signature = req.headers["authorization"];

  if (!signature || !REVENUECAT_WEBHOOK_SECRET) {
    console.warn("⚠️ RevenueCat webhook secret not configured");
    return;
  }

  const expectedSignature = crypto
    .createHmac("sha256", REVENUECAT_WEBHOOK_SECRET)
    .update(buf)
    .digest("hex");

  // Support "Bearer sha256=..." or "sha256=..." formats.
  const expectedSignatureWithPrefix = `sha256=${expectedSignature}`;
  const expectedSignatureWithBearer = `Bearer ${expectedSignatureWithPrefix}`;

  if (
    signature !== expectedSignatureWithPrefix &&
    signature !== expectedSignatureWithBearer
  ) {
    throw new Error("Invalid RevenueCat signature");
  }
}
