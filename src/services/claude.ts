/**
 * Claude (Anthropic API) for the daily analysis reports, and whether it can
 * be used right now.
 *
 * The API is paid from prepaid credits (the Max plan's monthly $100 lands in
 * the linked Console organization). When they run out every request fails
 * with a billing error until the next month's credits arrive, so:
 * - a billing/auth failure marks Claude unavailable in Redis for
 *   UNAVAILABLE_SECONDS (shared by every server instance);
 * - after that a 1-token probe decides whether it's back, so nobody's game
 *   is the one that finds out;
 * - while it's unavailable, daily analysis games that would use Claude can't
 *   start (see index.ts) and the app shows the mode as paused.
 */
import Anthropic from "@anthropic-ai/sdk";
import { redis } from "../utils/redis.js";

export const DAILY_ANALYSIS_CLAUDE_MODEL =
  process.env.DAILY_ANALYSIS_CLAUDE_MODEL || "claude-sonnet-5-5";
const PROBE_MODEL = "claude-haiku-5-5";

const TIMEOUT_MS = 90_000;
const MAX_RETRIES = 2;

const UNAVAILABLE_KEY = "ai:claude:unavailable";
/** Set with the above but without the short expiry: a probe must clear it. */
const NEEDS_PROBE_KEY = "ai:claude:needs-probe";
const PROBE_LOCK_KEY = "ai:claude:probe";
/** How long a billing failure keeps Claude off before it is probed again. */
const UNAVAILABLE_SECONDS = 10 * 60;
/** Each instance re-reads the shared state at most this often. */
const LOCAL_CACHE_MS = 15_000;

let client: Anthropic | null | undefined;

export function getClaudeClient(): Anthropic | null {
  if (client === undefined) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    client = apiKey
      ? new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES })
      : null;
  }
  return client;
}

/** Only for tests: forget the client and the cached availability. */
export function resetClaudeForTests(): void {
  client = undefined;
  cached = null;
}

/**
 * Errors that won't go away by retrying: no credits left, the monthly spend
 * cap, or a revoked/invalid key. Rate limits and outages are not in here.
 */
export function isBillingFailure(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError)) return false;
  const message = (error.message || "").toLowerCase();
  if (error.status === 401 || error.status === 402 || error.status === 403) return true;
  if (error.status === 400 && /credit balance|billing|purchase credits/.test(message)) {
    return true;
  }
  if (error.status === 429 && /spend|usage limit|credit/.test(message)) return true;
  return false;
}

let cached: { available: boolean; at: number } | null = null;

const remember = (available: boolean) => {
  cached = { available, at: Date.now() };
  return available;
};

/** Called when a request failed: turns Claude off for everyone if it was billing. */
export async function reportClaudeFailure(error: unknown): Promise<void> {
  if (!isBillingFailure(error)) return;
  remember(false);
  console.error(
    "💳 Claude is out of credits or its key was refused; daily analysis is paused.",
    error instanceof Error ? error.message : error,
  );
  try {
    await redis
      .multi()
      .set(UNAVAILABLE_KEY, String(Date.now()), "EX", UNAVAILABLE_SECONDS)
      .set(NEEDS_PROBE_KEY, "1", "EX", 40 * 24 * 60 * 60)
      .exec();
  } catch (redisError) {
    console.error("Couldn't store Claude's unavailability:", redisError);
  }
}

/** The cheapest request there is; billing failures fail it like any other. */
async function probe(claude: Anthropic): Promise<boolean> {
  try {
    await claude.messages.create(
      {
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      },
      { timeout: 10_000, maxRetries: 0 },
    );
    return true;
  } catch (error) {
    if (isBillingFailure(error)) {
      await reportClaudeFailure(error);
      return false;
    }
    // An outage or a rate limit says nothing about the credits.
    return true;
  }
}

/**
 * Whether new daily analysis games may use Claude. False without a key, while
 * a billing failure is fresh, or when the probe after it still fails.
 */
export async function isClaudeAvailable(): Promise<boolean> {
  const claude = getClaudeClient();
  if (!claude) return false;
  if (cached && Date.now() - cached.at < LOCAL_CACHE_MS) return cached.available;

  let markedAt: string | null;
  let needsProbe: string | null;
  try {
    [markedAt, needsProbe] = await redis.mget(UNAVAILABLE_KEY, NEEDS_PROBE_KEY);
  } catch {
    // Without Redis we can't share state; trust the last answer, else allow.
    return cached?.available ?? true;
  }
  if (markedAt) return remember(false);
  if (!needsProbe) return remember(true);

  // The pause is over: one instance probes, the others wait for its answer.
  let probing = false;
  try {
    probing = (await redis.set(PROBE_LOCK_KEY, "1", "EX", 30, "NX")) === "OK";
  } catch {
    probing = true;
  }
  if (!probing) return remember(false);
  const back = await probe(claude);
  if (back) {
    console.log("💳 Claude is reachable again; daily analysis is back on.");
    await redis.del(NEEDS_PROBE_KEY).catch(() => {});
  }
  return remember(back);
}

/**
 * Whether daily analysis games that would use Claude are paused: Claude is
 * set up but out of credits. Without a key the reports go to OpenAI, so
 * nothing is paused.
 */
export async function isClaudePaused(): Promise<boolean> {
  return getClaudeClient() !== null && !(await isClaudeAvailable());
}
