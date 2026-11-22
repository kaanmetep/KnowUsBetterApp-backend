import { test } from "node:test";
import assert from "node:assert/strict";
import { claimEvent } from "../src/routes/revenueCatWebhook.js";

/**
 * revenuecat_events as Postgres would enforce it: unique event_id, and (when
 * the migration is applied) unique non-null transaction_id.
 */
function fakeSupabase({ hasTransactionColumn }: { hasTransactionColumn: boolean }) {
  const rows: any[] = [];
  const inserts: any[] = [];
  const client = {
    from: () => ({
      insert: (row: any) => {
        inserts.push(row);
        if ("transaction_id" in row && !hasTransactionColumn) {
          return Promise.resolve({
            error: { code: "PGRST204", message: "Could not find the 'transaction_id' column" },
          });
        }
        if (rows.some((r) => r.event_id === row.event_id)) {
          return Promise.resolve({
            error: { code: "23505", message: 'violates unique constraint "revenuecat_events_pkey"' },
          });
        }
        if (row.transaction_id && rows.some((r) => r.transaction_id === row.transaction_id)) {
          return Promise.resolve({
            error: {
              code: "23505",
              message: 'violates unique constraint "revenuecat_events_transaction_id_key"',
            },
          });
        }
        rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
    }),
  } as any;
  return { client, rows, inserts };
}

const purchase = (overrides: Record<string, unknown> = {}) => ({
  id: "evt-1",
  type: "NON_RENEWING_PURCHASE",
  app_user_id: "user-a",
  product_id: "coins_10",
  transaction_id: "2000000123",
  ...overrides,
});

test("a new purchase is claimed and stores its transaction id", async () => {
  const db = fakeSupabase({ hasTransactionColumn: true });
  assert.equal(await claimEvent(db.client, purchase(), 10), "claimed");
  assert.equal(db.rows[0].transaction_id, "2000000123");
});

test("the same event delivered twice is a duplicate", async () => {
  const db = fakeSupabase({ hasTransactionColumn: true });
  assert.equal(await claimEvent(db.client, purchase(), 10), "claimed");
  assert.equal(await claimEvent(db.client, purchase(), 10), "duplicate");
});

test("a second event id for the same store transaction is a duplicate", async () => {
  const db = fakeSupabase({ hasTransactionColumn: true });
  assert.equal(await claimEvent(db.client, purchase(), 10), "claimed");
  assert.equal(await claimEvent(db.client, purchase({ id: "evt-2" }), 10), "duplicate");
  assert.equal(db.rows.length, 1);
});

test("two real purchases (different transactions) are both claimed", async () => {
  const db = fakeSupabase({ hasTransactionColumn: true });
  assert.equal(await claimEvent(db.client, purchase(), 10), "claimed");
  assert.equal(
    await claimEvent(db.client, purchase({ id: "evt-2", transaction_id: "2000000124" }), 10),
    "claimed",
  );
});

test("events without a transaction id still dedupe on event id only", async () => {
  const db = fakeSupabase({ hasTransactionColumn: true });
  for (const transaction_id of [undefined, null, ""]) {
    assert.equal(
      await claimEvent(db.client, purchase({ id: `evt-${transaction_id}`, transaction_id }), 10),
      "claimed",
    );
  }
  assert.equal(db.rows.length, 3);
  assert.ok(db.inserts.every((row) => !("transaction_id" in row)));
});

test("before the migration it falls back to the old event-id-only insert", async () => {
  const db = fakeSupabase({ hasTransactionColumn: false });
  assert.equal(await claimEvent(db.client, purchase(), 10), "claimed");
  assert.equal(db.rows[0].transaction_id, undefined);
  assert.equal(await claimEvent(db.client, purchase(), 10), "duplicate");
});

test("other insert errors are still errors, with no fallback insert", async () => {
  const inserts: any[] = [];
  const client = {
    from: () => ({
      insert: (row: any) => {
        inserts.push(row);
        return Promise.resolve({ error: { code: "08006", message: "connection failure" } });
      },
    }),
  } as any;
  assert.equal(await claimEvent(client, purchase(), 10), "error");
  assert.equal(inserts.length, 1);
});
