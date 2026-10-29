import test from "node:test";
import assert from "node:assert/strict";
import { validateAnnouncementInput } from "../src/services/adminAnnouncementService.js";
import { parsePushCoinReward } from "../src/services/pushRewardService.js";

test("validateAnnouncementInput keeps filled languages and defaults the rest", () => {
  const parsed = validateAnnouncementInput({
    title: { en: " New mode ", tr: "Yeni mod", es: "" },
    message: { tr: "Hemen dene" },
  });
  assert.deepEqual(parsed.title, { en: "New mode", tr: "Yeni mod" });
  assert.deepEqual(parsed.message, { tr: "Hemen dene" });
  assert.equal(parsed.is_active, true);
  assert.equal(parsed.priority, 0);
  assert.equal(parsed.start_date, null);
  assert.equal(parsed.action_url, null);
});

test("validateAnnouncementInput rejects missing titles and orphan messages", () => {
  assert.throws(() => validateAnnouncementInput({ title: {}, message: {} }));
  assert.throws(() =>
    validateAnnouncementInput({ title: { en: "Hi" }, message: { tr: "Başlıksız mesaj" } }),
  );
});

test("validateAnnouncementInput checks dates, priority and the link", () => {
  const base = { title: { en: "Hi" } };
  assert.throws(() =>
    validateAnnouncementInput({
      ...base,
      start_date: "2026-11-02T10:00:00Z",
      end_date: "2026-11-01T10:00:00Z",
    }),
  );
  assert.throws(() => validateAnnouncementInput({ ...base, start_date: "not a date" }));
  assert.throws(() => validateAnnouncementInput({ ...base, priority: 1.5 }));
  assert.throws(() => validateAnnouncementInput({ ...base, action_url: "javascript:alert(1)" }));
  assert.throws(() => validateAnnouncementInput({ ...base, action_url: "example.com" }));

  const parsed = validateAnnouncementInput({
    ...base,
    priority: "5",
    is_active: false,
    end_date: "2026-11-01T10:00:00+03:00",
    action_url: " https://example.com ",
  });
  assert.equal(parsed.priority, 5);
  assert.equal(parsed.is_active, false);
  assert.equal(parsed.end_date, "2026-11-01T07:00:00.000Z");
  assert.equal(parsed.action_url, "https://example.com");
});

test("parsePushCoinReward accepts empty or whole amounts in range", () => {
  assert.equal(parsePushCoinReward(undefined), 0);
  assert.equal(parsePushCoinReward(""), 0);
  assert.equal(parsePushCoinReward(5), 5);
  assert.equal(parsePushCoinReward("10"), 10);
  assert.throws(() => parsePushCoinReward(-1));
  assert.throws(() => parsePushCoinReward(2.5));
  assert.throws(() => parsePushCoinReward(100000));
  assert.throws(() => parsePushCoinReward("abc"));
});
