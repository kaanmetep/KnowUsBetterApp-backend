export type PushPlatform = "ios";
export type PushProvider = "apns";

export interface RegisterTokenInput {
  appUserId: string;
  token: string;
  platform: PushPlatform;
  provider?: PushProvider;
}

export interface NewContentPushInput {
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface AdminNewContentInput {
  title: string;
  body: string;
  type: "new_category" | "new_questions";
  categoryId?: string;
}

export interface TokenSendResult {
  token: string;
  success: boolean;
  reason?: string;
}
