import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSupportRequest,
  SupportValidationError,
} from "../src/services/supportRequests.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SupportValidationError) return error.code;
    throw error;
  }
  return null;
};

test("feedback needs a message", () => {
  assert.equal(code(() => parseSupportRequest({ kind: "feedback", message: "  " })), "MESSAGE_REQUIRED");
  assert.equal(parseSupportRequest({ kind: "feedback", message: " more categories " }).message, "more categories");
});

test("unknown kinds and long messages are refused", () => {
  assert.equal(code(() => parseSupportRequest({ kind: "spam", message: "hello" })), "INVALID_KIND");
  assert.equal(code(() => parseSupportRequest({ kind: "contact", message: "x".repeat(4001) })), "MESSAGE_TOO_LONG");
});

test("email is optional but must look like one", () => {
  assert.equal(parseSupportRequest({ kind: "contact", message: "help me", email: "" }).email, null);
  assert.equal(parseSupportRequest({ kind: "contact", message: "help me", email: " A@B.co " }).email, "a@b.co");
  assert.equal(code(() => parseSupportRequest({ kind: "contact", message: "help me", email: "nope" })), "INVALID_EMAIL");
});

test("a deletion request needs an id but no message", () => {
  assert.equal(code(() => parseSupportRequest({ kind: "data_deletion" })), "APP_USER_REQUIRED");
  const input = parseSupportRequest({ kind: "data_deletion", appUserId: "u1", language: "tr", platform: "ios" });
  assert.equal(input.message, null);
  assert.equal(input.language, "tr");
  assert.equal(parseSupportRequest({ kind: "data_deletion", appUserId: "u1", language: "xx" }).language, null);
});
