import test from "node:test";
import assert from "node:assert/strict";
import { validateRegisterTokenInput } from "../src/services/pushTokenService.js";
import { isInvalidTokenReason } from "../src/services/apnsService.js";
import { parseAdminPushRequest } from "../src/services/notificationService.js";

test("validateRegisterTokenInput accepts every app language and rejects others", () => {
  const input = { appUserId: "user-1", token: "abcdef123", platform: "ios" as const };
  assert.doesNotThrow(() => validateRegisterTokenInput({ ...input, language: "pt" }));
  assert.throws(() => validateRegisterTokenInput({ ...input, language: "de" as any }));
});

test("validateRegisterTokenInput accepts valid payload", () => {
  assert.doesNotThrow(() =>
    validateRegisterTokenInput({
      appUserId: "user-1",
      token: "abcdef123",
      platform: "ios",
      provider: "apns",
    }),
  );
});

test("validateRegisterTokenInput rejects invalid platform", () => {
  assert.throws(() =>
    validateRegisterTokenInput({
      appUserId: "user-1",
      token: "abcdef123",
      platform: "iosx" as "ios",
    }),
  );
});

test("validateRegisterTokenInput checks the language", () => {
  const base = { appUserId: "user-1", token: "abcdef123", platform: "ios" as const };
  assert.doesNotThrow(() => validateRegisterTokenInput({ ...base, language: "tr" }));
  assert.doesNotThrow(() => validateRegisterTokenInput(base));
  assert.throws(() =>
    validateRegisterTokenInput({ ...base, language: "de" as "en" }),
  );
});

test("parseAdminPushRequest keeps only the languages that have a text", () => {
  const parsed = parseAdminPushRequest({
    texts: {
      tr: { title: " Yeni sorular ", body: "Göz at" },
      en: { title: "", body: "" },
    },
    type: "new_questions",
    categoryId: "deep_talk",
  });
  assert.deepEqual(parsed.texts, { tr: { title: "Yeni sorular", body: "Göz at" } });
  assert.deepEqual(parsed.data, { type: "new_questions", categoryId: "deep_talk" });
  assert.equal(parsed.appUserId, undefined);
});

test("parseAdminPushRequest sends the legacy title/body to every language", () => {
  const parsed = parseAdminPushRequest({ title: "Hi", body: "There", type: "new_questions" });
  assert.deepEqual(Object.keys(parsed.texts).sort(), ["en", "es", "pt", "tr"]);
});

test("parseAdminPushRequest rejects incomplete or empty requests", () => {
  assert.throws(() => parseAdminPushRequest({ texts: {} }));
  assert.throws(() => parseAdminPushRequest({ texts: { en: { title: "Only title" } } }));
  assert.throws(() =>
    parseAdminPushRequest({ texts: { en: { title: "A", body: "B" } }, type: "new_category" }),
  );
  assert.throws(() =>
    parseAdminPushRequest({
      texts: { en: { title: "A", body: "B" } },
      type: "bogus" as "general",
    }),
  );
});

test("parseAdminPushRequest drops the category for general notifications", () => {
  const parsed = parseAdminPushRequest({
    texts: { es: { title: "A", body: "B" } },
    categoryId: "spicy",
    appUserId: " user-9 ",
  });
  assert.deepEqual(parsed.data, { type: "general" });
  assert.equal(parsed.appUserId, "user-9");
});

test("isInvalidTokenReason identifies APNS invalid reasons", () => {
  assert.equal(isInvalidTokenReason("Unregistered"), true);
  assert.equal(isInvalidTokenReason("BadDeviceToken"), true);
  assert.equal(isInvalidTokenReason("TooManyRequests"), false);
});
