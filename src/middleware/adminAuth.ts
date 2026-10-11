import { timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_NOTIFICATIONS_SECRET;
  const provided = req.header("x-admin-secret");

  if (!expected) {
    res.status(500).json({ message: "Admin secret is not configured" });
    return;
  }

  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  next();
}
