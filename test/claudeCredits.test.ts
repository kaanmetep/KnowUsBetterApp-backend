/**
 * Claude for daily analysis: who gets Claude, the OpenAI fallback, and the
 * pause when the API credits run out. Talks to a fake Anthropic/OpenAI
 * server, never the real APIs.
 *
 * Needs a Redis: REDIS_URL (default redis://localhost:6379).
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

type Mode = "ok" | "no_credit" | "rate_limit" | "server_error";
let claudeMode: Mode = "ok";
let claudeCalls = 0;
let openaiCalls = 0;

const REPORT = {
  headline: "Aynı şeyi farklı dillerde istiyorsunuz",
  summary: "Özet.",
  insights: [
    { title: "Bir", text: "Metin bir." },
    { title: "İki", text: "Metin iki." },
    { title: "Üç", text: "Metin üç." },
  ],
  blindSpot: "Kör nokta.",
  verdict: "Hüküm.",
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url?.endsWith("/v1/messages")) {
      claudeCalls++;
      const error = (status: number, type: string, message: string) =>
        send(status, { type: "error", error: { type, message } });
      if (claudeMode === "no_credit") {
        return error(
          400,
          "invalid_request_error",
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        );
      }
      if (claudeMode === "rate_limit") return error(429, "rate_limit_error", "Number of requests has exceeded your rate limit");
      if (claudeMode === "server_error") return error(500, "api_error", "Internal server error");
      const request = JSON.parse(body);
      return send(200, {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: request.model,
        content: [{ type: "text", text: request.max_tokens === 1 ? "o" : JSON.stringify(REPORT) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }
    if (req.url?.endsWith("/chat/completions")) {
      openaiCalls++;
      return send(200, {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 0,
        model: "gpt-4.1",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify({ ...REPORT, headline: "openai" }) },
          },
        ],
      });
    }
    send(404, {});
  });
});

let claude: typeof import("../src/services/claude.js");
let daily: typeof import("../src/services/dailyAnalysis.js");
let redis: typeof import("../src/utils/redis.js")["redis"];

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  claude = await import("../src/services/claude.js");
  daily = await import("../src/services/dailyAnalysis.js");
  ({ redis } = await import("../src/utils/redis.js"));
  if (redis.status !== "ready") await new Promise((resolve) => redis.once("ready", resolve));
});

after(async () => {
  await redis.del("ai:claude:unavailable", "ai:claude:needs-probe", "ai:claude:probe");
  redis.disconnect();
  server.close();
});

beforeEach(async () => {
  claudeMode = "ok";
  claudeCalls = 0;
  openaiCalls = 0;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  claude.resetClaudeForTests();
  await redis.del("ai:claude:unavailable", "ai:claude:needs-probe", "ai:claude:probe");
});

const row = (consents: (number | undefined)[]) =>
  ({
    id: "test-row",
    host_app_user_id: "a",
    participant_ids: ["a", "b"],
    topic_id: "topic",
    chapter: 1,
    language: "tr",
    status: "analyzing",
    players: consents.map((v, i) => ({
      appUserId: i ? "b" : "a",
      name: i ? "Zeynep" : "Kaan",
      avatar: "",
      isHost: i === 0,
      aiConsentVersion: v,
    })),
    rounds: [],
    percentage: 50,
    report: null,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  }) as any;

test("billing failures are told apart from passing trouble", async () => {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const err = (status: number, message: string) =>
    Anthropic.APIError.generate(status, { type: "error", error: { message } }, message, new Headers());
  assert.equal(claude.isBillingFailure(err(400, "Your credit balance is too low to access the Anthropic API.")), true);
  assert.equal(claude.isBillingFailure(err(402, "billing")), true);
  assert.equal(claude.isBillingFailure(err(401, "invalid x-api-key")), true);
  assert.equal(claude.isBillingFailure(err(429, "You have reached your specified API usage limits / spend limit")), true);
  assert.equal(claude.isBillingFailure(err(429, "Number of requests has exceeded your rate limit")), false);
  assert.equal(claude.isBillingFailure(err(400, "messages: roles must alternate")), false);
  assert.equal(claude.isBillingFailure(err(529, "Overloaded")), false);
  assert.equal(claude.isBillingFailure(new Error("socket hang up")), false);
});

test("Claude only when every player agreed to the new text", () => {
  assert.equal(daily.everyoneAllowsClaude([{ aiConsentVersion: 2 }, { aiConsentVersion: 2 }]), true);
  assert.equal(daily.everyoneAllowsClaude([{ aiConsentVersion: 2 }, {}]), false);
  assert.equal(daily.everyoneAllowsClaude([{ aiConsentVersion: 2 }, { aiConsentVersion: 1 }]), false);
  assert.equal(daily.everyoneAllowsClaude([]), false);
});

test("new consent: Claude writes the report", async () => {
  const report = await daily.generateReport(row([2, 2]), [], []);
  assert.equal(report.headline, REPORT.headline);
  assert.equal(claudeCalls, 1);
  assert.equal(openaiCalls, 0);
});

test("old consent: OpenAI writes it and Claude is never called", async () => {
  const report = await daily.generateReport(row([2, undefined]), [], []);
  assert.equal(report.headline, "openai");
  assert.equal(claudeCalls, 0);
  assert.equal(openaiCalls, 1);
});

test("out of credits: the paid report falls back to OpenAI and new games are paused", async () => {
  claudeMode = "no_credit";
  assert.equal(await claude.isClaudePaused(), false);
  const report = await daily.generateReport(row([2, 2]), [], []);
  assert.equal(report.headline, "openai");
  assert.equal(openaiCalls, 1);
  assert.equal(await claude.isClaudePaused(), true);
  // Shared with the other server instances through Redis.
  claude.resetClaudeForTests();
  assert.equal(await claude.isClaudePaused(), true);
  assert.ok(await redis.get("ai:claude:unavailable"));
});

test("an outage or rate limit falls back but doesn't pause the mode", async () => {
  for (const mode of ["rate_limit", "server_error"] as const) {
    claudeMode = mode;
    claude.resetClaudeForTests();
    const report = await daily.generateReport(row([2, 2]), [], []);
    assert.equal(report.headline, "openai");
    assert.equal(await claude.isClaudePaused(), false, mode);
  }
});

test("after the pause a probe reopens it once the credits are back", async () => {
  claudeMode = "no_credit";
  await daily.generateReport(row([2, 2]), [], []);
  assert.equal(await claude.isClaudePaused(), true);

  // Ten minutes later, still no credits: the probe fails and the pause renews.
  await redis.del("ai:claude:unavailable");
  claude.resetClaudeForTests();
  claudeCalls = 0;
  assert.equal(await claude.isClaudePaused(), true);
  assert.equal(claudeCalls, 1, "one probe");
  assert.ok(await redis.get("ai:claude:unavailable"));

  // Credits arrive: the next probe reopens it and clears the flag.
  claudeMode = "ok";
  await redis.del("ai:claude:unavailable", "ai:claude:probe");
  claude.resetClaudeForTests();
  claudeCalls = 0;
  assert.equal(await claude.isClaudePaused(), false);
  assert.equal(claudeCalls, 1, "one probe");
  assert.equal(await redis.get("ai:claude:needs-probe"), null);

  // Back to normal: no more probes.
  claude.resetClaudeForTests();
  claudeCalls = 0;
  assert.equal(await claude.isClaudePaused(), false);
  assert.equal(claudeCalls, 0);
});

test("without an Anthropic key nothing is paused and OpenAI writes everything", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  claude.resetClaudeForTests();
  assert.equal(await claude.isClaudePaused(), false);
  const report = await daily.generateReport(row([2, 2]), [], []);
  assert.equal(report.headline, "openai");
  assert.equal(claudeCalls, 0);
});
