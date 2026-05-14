import test from "node:test";
import assert from "node:assert/strict";
import { validateRegisterTokenInput } from "../src/services/pushTokenService.js";
import { isInvalidTokenReason } from "../src/services/apnsService.js";

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

test("isInvalidTokenReason identifies APNS invalid reasons", () => {
  assert.equal(isInvalidTokenReason("Unregistered"), true);
  assert.equal(isInvalidTokenReason("BadDeviceToken"), true);
  assert.equal(isInvalidTokenReason("TooManyRequests"), false);
});
