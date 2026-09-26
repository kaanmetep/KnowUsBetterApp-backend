import apn from "apn";
import { AppError } from "../errors/AppError.js";
import { TokenSendResult } from "../types/notifications.js";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface BatchOptions {
  concurrency?: number;
}

export function isInvalidTokenReason(reason?: string): boolean {
  if (!reason) {
    return false;
  }

  return (
    reason === "BadDeviceToken" ||
    reason === "DeviceTokenNotForTopic" ||
    reason === "Unregistered"
  );
}

export class ApnsService {
  private provider: apn.Provider;
  private bundleId: string;

  constructor() {
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    const bundleId = process.env.APNS_BUNDLE_ID;
    const privateKey = process.env.APNS_PRIVATE_KEY;

    if (!keyId || !teamId || !bundleId || !privateKey) {
      throw new AppError(
        "APNS env vars are not fully configured",
        500,
        "APNS_CONFIG_ERROR",
      );
    }

    this.bundleId = bundleId;
    this.provider = new apn.Provider({
      token: {
        key: privateKey.replace(/\\n/g, "\n"),
        keyId,
        teamId,
      },
      production: process.env.APNS_USE_PRODUCTION === "true",
    });
  }

  public async sendToToken(
    token: string,
    payload: PushPayload,
  ): Promise<TokenSendResult> {
    const notification = new apn.Notification();
    notification.topic = this.bundleId;
    notification.alert = {
      title: payload.title,
      body: payload.body,
    };
    notification.sound = "default";
    notification.payload = payload.data ?? {};

    const response = await this.provider.send(notification, token);
    const failed = response.failed[0];

    if (!failed) {
      return { token, success: true };
    }

    const reason =
      (failed.response?.reason as string | undefined) ??
      (failed.error?.message || "Unknown APNS error");
    return {
      token,
      success: false,
      reason,
    };
  }

  public async sendBatch(
    tokens: string[],
    payload: PushPayload,
    options?: BatchOptions,
  ): Promise<TokenSendResult[]> {
    const concurrency = Math.max(1, options?.concurrency ?? 25);
    const results: TokenSendResult[] = [];

    for (let i = 0; i < tokens.length; i += concurrency) {
      const chunk = tokens.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        chunk.map((token) => this.sendToToken(token, payload)),
      );

      for (let index = 0; index < settled.length; index++) {
        const currentToken = chunk[index];
        const item = settled[index];
        if (item.status === "fulfilled") {
          results.push(item.value);
          continue;
        }

        results.push({
          token: currentToken,
          success: false,
          reason:
            item.reason instanceof Error
              ? item.reason.message
              : "Unhandled APNS send error",
        });
      }
    }

    return results;
  }

  public shutdown(): void {
    this.provider.shutdown();
  }
}
