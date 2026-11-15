import { PostHog } from "posthog-node";

/**
 * Server-side events and errors in the same PostHog project as the app. Events
 * are tied to the RevenueCat appUserId, the id the app identifies with, so a
 * server-side disconnect shows up on the same person's timeline as the app's
 * own socket events. Off when POSTHOG_API_KEY is not set.
 */
const apiKey = process.env.POSTHOG_API_KEY;
const client = apiKey
  ? new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
      flushAt: 20,
      flushInterval: 10_000,
    })
  : null;

const baseProperties = {
  source: "backend",
  server_env: process.env.NODE_ENV || "development",
};

type Properties = Record<string, string | number | boolean | null | undefined>;

/** A socket without a registered user gets an anonymous id and no person profile. */
const identity = (appUserId: string | undefined, socketId?: string) =>
  appUserId
    ? { distinctId: appUserId, anonymous: false }
    : { distinctId: `socket:${socketId ?? "unknown"}`, anonymous: true };

export function captureServerEvent(
  event: string,
  { appUserId, socketId }: { appUserId?: string; socketId?: string },
  properties: Properties = {},
): void {
  if (!client) return;
  const { distinctId, anonymous } = identity(appUserId, socketId);
  try {
    client.capture({
      distinctId,
      event,
      properties: {
        ...baseProperties,
        socket_id: socketId,
        ...properties,
        ...(anonymous && { $process_person_profile: false }),
      },
    });
  } catch (error) {
    console.warn("⚠️ PostHog capture failed:", error);
  }
}

// The same error is often logged more than once on its way up; report it once.
const reported = new WeakSet<object>();

export function captureServerError(
  error: unknown,
  { appUserId, socketId }: { appUserId?: string; socketId?: string } = {},
  properties: Properties = {},
): void {
  if (!client) return;
  if (typeof error === "object" && error !== null) {
    if (reported.has(error)) return;
    reported.add(error);
  }
  const { distinctId, anonymous } = identity(appUserId, socketId ?? "server");
  try {
    client.captureException(error, distinctId, {
      ...baseProperties,
      socket_id: socketId,
      ...properties,
      ...(anonymous && { $process_person_profile: false }),
    });
  } catch (captureError) {
    console.warn("⚠️ PostHog exception capture failed:", captureError);
  }
}

/**
 * Every caught error the server logs with console.error(message, error) is
 * also sent to PostHog error tracking, with the message as context. Calls
 * without an Error object (plain status messages) are left alone.
 */
export function captureConsoleErrors(): void {
  if (!client) return;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    const error = args.find((arg) => arg instanceof Error);
    if (!error) return;
    const message = args.find((arg) => typeof arg === "string");
    // PostHog's own failures (e.g. PostHog unreachable) must not be re-sent.
    if (typeof message === "string" && message.startsWith("[PostHog]")) return;
    captureServerError(error, {}, {
      log_message: typeof message === "string" ? message.slice(0, 200) : undefined,
    });
  };
}

/** Sends what is still queued; call before the process exits. */
export async function flushAnalytics(timeoutMs = 3000): Promise<void> {
  if (!client) return;
  await client.shutdown(timeoutMs).catch(() => undefined);
}
