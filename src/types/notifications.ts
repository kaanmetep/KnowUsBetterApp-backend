export type PushPlatform = "ios";
export type PushProvider = "apns";

export const PUSH_LANGUAGES = ["en", "tr", "es"] as const;
export type PushLanguage = (typeof PUSH_LANGUAGES)[number];

export const PUSH_CONTENT_TYPES = ["general", "new_category", "new_questions"] as const;
export type PushContentType = (typeof PUSH_CONTENT_TYPES)[number];

export interface RegisterTokenInput {
  appUserId: string;
  token: string;
  platform: PushPlatform;
  provider?: PushProvider;
  language?: PushLanguage;
}

export interface PushText {
  title: string;
  body: string;
}

/**
 * Each language with a text is sent to the users of that language only;
 * languages left out are skipped.
 */
export interface LocalizedPushInput {
  texts: Partial<Record<PushLanguage, PushText>>;
  data: Record<string, string>;
  appUserId?: string;
}

/**
 * Accepted by both admin endpoints. `title`/`body` is the older single-text
 * form and goes to every language.
 */
export interface AdminPushRequest {
  texts?: Partial<Record<PushLanguage, Partial<PushText>>>;
  title?: string;
  body?: string;
  type?: PushContentType;
  categoryId?: string;
  appUserId?: string;
}

export interface TokenSendResult {
  token: string;
  success: boolean;
  reason?: string;
}
