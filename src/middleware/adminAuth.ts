import { NextFunction, Request, Response } from "express";

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_NOTIFICATIONS_SECRET;
  const provided = req.header("x-admin-secret");

  if (!expected) {
    res.status(500).json({ message: "Admin secret is not configured" });
    return;
  }

  if (!provided || provided !== expected) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  next();
}
