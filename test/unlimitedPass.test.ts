import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anyActivePass,
  applyPassEvent,
  getPassStatus,
  isUnlimitedProduct,
  transferPass,
} from "../src/services/unlimitedPass.js";

/** Just enough of the Supabase query builder for unlimited_passes. */
function fakeSupabase() {
  const rows = new Map<string, any>();
  const builder = () => {
    let ids: string[] | null = null;
    let mode: "select" | "delete" = "select";
    const api: any = {
      select: () => api,
      eq: (_col: string, value: string) => ((ids = [value]), api),
      in: (_col: string, values: string[]) => {
        ids = values;
        if (mode === "delete") {
          for (const id of values) rows.delete(id);
          return Promise.resolve({ error: null });
        }
        return Promise.resolve({
          data: values.filter((id) => rows.has(id)).map((id) => ({ ...rows.get(id) })),
          error: null,
        });
      },
      maybeSingle: () =>
        Promise.resolve({ data: ids && rows.has(ids[0]) ? { ...rows.get(ids[0]) } : null, error: null }),
      upsert: (row: any) => {
        rows.set(row.app_user_id, { ...row });
        return Promise.resolve({ error: null });
      },
      delete: () => ((mode = "delete"), api),
    };
    return api;
  };
  return { client: { from: () => builder() } as any, rows };
}

const HOUR = 60 * 60 * 1000;
const event = (overrides: Record<string, unknown>) => ({
  type: "INITIAL_PURCHASE",
  app_user_id: "user-a",
  product_id: "unlimited_weekly",
  expiration_at_ms: Date.now() + 7 * 24 * HOUR,
  event_timestamp_ms: Date.now(),
  ...overrides,
});

test("only unlimited_* products are passes", () => {
  assert.equal(isUnlimitedProduct("unlimited_weekly"), true);
  assert.equal(isUnlimitedProduct("coins_50"), false);
  assert.equal(isUnlimitedProduct(undefined), false);
});

test("a purchase makes the pass active until it expires", async () => {
  const { client } = fakeSupabase();
  const result = await applyPassEvent(client, event({}));
  assert.deepEqual(result, { status: "updated", appUserId: "user-a", active: true });
  const status = await getPassStatus(client, "user-a");
  assert.equal(status.active, true);
  assert.equal(status.willRenew, true);
});

test("a cancellation keeps the pass running but stops renewal", async () => {
  const { client } = fakeSupabase();
  await applyPassEvent(client, event({ event_timestamp_ms: Date.now() - 1000 }));
  await applyPassEvent(client, event({ type: "CANCELLATION" }));
  const status = await getPassStatus(client, "user-a");
  assert.equal(status.active, true);
  assert.equal(status.willRenew, false);
});

test("an expired pass is inactive once the renewal grace is over", async () => {
  const { client } = fakeSupabase();
  await applyPassEvent(client, event({ type: "EXPIRATION", expiration_at_ms: Date.now() - 2 * HOUR }));
  assert.equal((await getPassStatus(client, "user-a")).active, false);
  // Within the grace window it still counts.
  await applyPassEvent(client, event({ type: "RENEWAL", expiration_at_ms: Date.now() - 10 * 60 * 1000 }));
  assert.equal((await getPassStatus(client, "user-a")).active, true);
});

test("an older event delivered late doesn't overwrite a newer one", async () => {
  const { client } = fakeSupabase();
  await applyPassEvent(client, event({ type: "EXPIRATION", expiration_at_ms: Date.now() - 2 * HOUR }));
  const stale = await applyPassEvent(
    client,
    event({ type: "RENEWAL", event_timestamp_ms: Date.now() - 24 * HOUR }),
  );
  assert.deepEqual(stale, { status: "stale" });
  assert.equal((await getPassStatus(client, "user-a")).active, false);
});

test("anonymous RevenueCat ids and unrelated events are ignored", async () => {
  const { client } = fakeSupabase();
  assert.deepEqual(
    await applyPassEvent(client, event({ app_user_id: "$RCAnonymousID:abc" })),
    { status: "ignored" },
  );
  assert.deepEqual(await applyPassEvent(client, event({ type: "TEST" })), { status: "ignored" });
});

test("a room plays free when any player has a pass", async () => {
  const { client } = fakeSupabase();
  await applyPassEvent(client, event({ app_user_id: "guest" }));
  assert.equal(await anyActivePass(client, ["host", "guest"]), "guest");
  assert.equal(await anyActivePass(client, ["host"]), null);
});

test("a transfer moves the pass to the new id", async () => {
  const { client, rows } = fakeSupabase();
  await applyPassEvent(client, event({ app_user_id: "old-id" }));
  assert.equal(await transferPass(client, ["old-id"], "new-id"), true);
  assert.equal(rows.has("old-id"), false);
  assert.equal((await getPassStatus(client, "new-id")).active, true);
});
