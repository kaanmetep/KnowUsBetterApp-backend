import { getAdminPool } from "../utils/adminDb.js";
import { AppError } from "../errors/AppError.js";

const MAX_SQL_LENGTH = 50_000;
const MAX_ROWS_RETURNED = 200;
const STATEMENT_TIMEOUT = "15s";

// Would end our wrapping transaction and make "preview" (ROLLBACK) meaningless.
const FORBIDDEN_LEADING_KEYWORDS = new Set([
  "begin",
  "commit",
  "rollback",
  "end",
  "abort",
  "savepoint",
  "release",
  "start",
  "prepare",
  "set",
  "reset",
  "vacuum",
]);

function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/"(?:[^"]|"")*"/g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function assertSqlAllowed(sql: string): void {
  const statements = stripLiteralsAndComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  if (statements.length === 0) {
    throw new AppError("SQL is empty", 400, "VALIDATION_ERROR");
  }

  for (const statement of statements) {
    const keyword = statement.split(/\s+/)[0].toLowerCase();
    if (FORBIDDEN_LEADING_KEYWORDS.has(keyword)) {
      throw new AppError(
        `"${keyword.toUpperCase()}" is not allowed here; the panel manages the transaction itself`,
        400,
        "FORBIDDEN_STATEMENT",
      );
    }
  }
}

export interface SqlStatementResult {
  command: string | null;
  rowCount: number | null;
  fields: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export async function runSql(
  sql: unknown,
  mode: "preview" | "apply",
): Promise<{ committed: boolean; results: SqlStatementResult[]; durationMs: number }> {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new AppError("SQL is required", 400, "VALIDATION_ERROR");
  }
  if (sql.length > MAX_SQL_LENGTH) {
    throw new AppError("SQL is too long", 400, "VALIDATION_ERROR");
  }
  assertSqlAllowed(sql);

  const client = await getAdminPool().connect();
  const startedAt = Date.now();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    let raw;
    try {
      raw = await client.query(sql);
    } catch (err: any) {
      await client.query("ROLLBACK");
      throw new AppError(err?.message || "SQL failed", 400, "SQL_ERROR", {
        ...(err?.position ? { position: err.position } : {}),
        ...(err?.detail ? { detail: err.detail } : {}),
        ...(err?.hint ? { hint: err.hint } : {}),
      });
    }

    await client.query(mode === "apply" ? "COMMIT" : "ROLLBACK");

    const list = Array.isArray(raw) ? raw : [raw];
    return {
      committed: mode === "apply",
      durationMs: Date.now() - startedAt,
      results: list.map((r) => ({
        command: r.command ?? null,
        rowCount: r.rowCount ?? null,
        fields: (r.fields ?? []).map((f: { name: string }) => f.name),
        rows: (r.rows ?? []).slice(0, MAX_ROWS_RETURNED),
        truncated: (r.rows?.length ?? 0) > MAX_ROWS_RETURNED,
      })),
    };
  } finally {
    client.release();
  }
}
