import { getAdminPool } from "../utils/adminDb.js";
import { AppError } from "../errors/AppError.js";

/**
 * Admin side of support_requests: read the inbox, mark messages done, and
 * delete a player's data when they asked for it. Deletion only ever runs
 * from here, by hand.
 */

export type SupportStatus = "open" | "done";

export interface SupportRow {
  id: string;
  app_user_id: string | null;
  kind: string;
  message: string | null;
  email: string | null;
  app_version: string | null;
  platform: string | null;
  os_version: string | null;
  language: string | null;
  status: SupportStatus;
  created_at: string;
  resolved_at: string | null;
}

export async function listSupportRequests(status: SupportStatus | "all"): Promise<{
  requests: SupportRow[];
  openCounts: Record<string, number>;
}> {
  const pool = getAdminPool();
  const [rows, counts] = await Promise.all([
    pool.query<SupportRow>(
      `SELECT id, app_user_id, kind, message, email, app_version, platform,
              os_version, language, status, created_at, resolved_at
         FROM public.support_requests
        WHERE ($1::text = 'all' OR status = $1)
        ORDER BY created_at DESC
        LIMIT 300`,
      [status],
    ),
    pool.query<{ kind: string; count: string }>(
      `SELECT kind, count(*) FROM public.support_requests WHERE status = 'open' GROUP BY kind`,
    ),
  ]);
  const openCounts: Record<string, number> = {};
  for (const row of counts.rows) openCounts[row.kind] = Number(row.count);
  return { requests: rows.rows, openCounts };
}

export async function setSupportStatus(id: string, status: SupportStatus): Promise<void> {
  const { rowCount } = await getAdminPool().query(
    `UPDATE public.support_requests
        SET status = $2,
            resolved_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, status],
  );
  if (!rowCount) throw new AppError("Request not found", 404, "NOT_FOUND");
}

export interface DeletionSummary {
  appUserId: string;
  deleted: Record<string, number>;
}

/**
 * Deletes everything stored for the player who filed deletion request `id`,
 * in one transaction, and marks the request done. Kept on purpose: bans
 * (abuse prevention) and RevenueCat purchase events (store/tax records);
 * reports they filed stay for moderation, without their id or name.
 */
export async function deleteUserDataForRequest(id: string): Promise<DeletionSummary> {
  const client = await getAdminPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ app_user_id: string | null; kind: string }>(
      `SELECT app_user_id, kind FROM public.support_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const request = rows[0];
    if (!request) throw new AppError("Request not found", 404, "NOT_FOUND");
    if (request.kind !== "data_deletion" || !request.app_user_id) {
      throw new AppError("Not a data deletion request", 400, "VALIDATION_ERROR");
    }
    const appUserId = request.app_user_id;

    const deleted: Record<string, number> = {};
    const run = async (label: string, sql: string) => {
      const result = await client.query(sql, [appUserId]);
      deleted[label] = result.rowCount ?? 0;
    };

    await run("coin_transactions", `DELETE FROM public.coin_transactions WHERE app_user_id = $1`);
    await run("coins", `DELETE FROM public.coins WHERE app_user_id = $1`);
    await run("unlimited_passes", `DELETE FROM public.unlimited_passes WHERE app_user_id = $1`);
    await run("seen_questions", `DELETE FROM public.seen_questions WHERE app_user_id = $1`);
    await run("push_tokens", `DELETE FROM public.push_tokens WHERE app_user_id = $1`);
    await run(
      "daily_analyses",
      `DELETE FROM public.daily_analyses
        WHERE host_app_user_id = $1 OR $1 = ANY(participant_ids)`,
    );
    await run(
      "answer_reports (anonymized)",
      `UPDATE public.answer_reports
          SET reporter_app_user_id = NULL, reporter_name = NULL
        WHERE reporter_app_user_id = $1`,
    );
    const others = await client.query(
      `DELETE FROM public.support_requests WHERE app_user_id = $1 AND id <> $2`,
      [appUserId, id],
    );
    deleted["support_requests (other messages)"] = others.rowCount ?? 0;
    await run("app_user_credentials", `DELETE FROM public.app_user_credentials WHERE app_user_id = $1`);

    await client.query(
      `UPDATE public.support_requests
          SET status = 'done', resolved_at = now(), email = NULL, message = NULL
        WHERE id = $1`,
      [id],
    );
    await client.query("COMMIT");
    return { appUserId, deleted };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
