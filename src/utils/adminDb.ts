import pg from "pg";

let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

function buildConnectionString(raw: string): string {
  // pg treats sslmode=require as verify-full; we pass our own ssl config instead.
  const url = new URL(raw);
  url.searchParams.delete("sslmode");
  return url.toString();
}

export function getAdminPool(): pg.Pool {
  if (pool) return pool;

  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error("DATABASE_URL is not configured");
  }

  const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(raw);
  pool = new pg.Pool({
    connectionString: buildConnectionString(raw),
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", (err) => {
    console.error("❌ Admin DB pool error:", err.message);
  });
  return pool;
}

// Lives in its own schema so it is not exposed through the Supabase REST API.
export function ensureAdminSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getAdminPool()
      .query(
        `CREATE SCHEMA IF NOT EXISTS admin_panel;
         CREATE TABLE IF NOT EXISTS admin_panel.passkeys (
           id TEXT PRIMARY KEY,
           public_key BYTEA NOT NULL,
           counter BIGINT NOT NULL DEFAULT 0,
           transports TEXT[] NOT NULL DEFAULT '{}',
           label TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           last_used_at TIMESTAMPTZ
         );`,
      )
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}
