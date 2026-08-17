import pg from "pg";
import type { SqlClient, SqlRow } from "./client.js";

/**
 * Production Postgres client (Neon, Supabase, Vercel Postgres — any of them).
 *
 * Serverless note: each warm function instance keeps a small pool. Serverless
 * platforms can spawn many instances, so `max` is deliberately tiny and idle
 * connections are reaped quickly; a hosted pooler (Neon's pooled endpoint or
 * Supabase's Supavisor on 6543) should sit in front in production.
 */

// Global driver config: BIGINT (OID 20) must NOT become a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => value);
// NUMERIC (OID 1700) likewise — token quantities can exceed any float.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => value);

export interface PgClientOptions {
  connectionString: string;
  maxConnections?: number;
  /** Hosted Postgres requires TLS; a local dev server usually does not. */
  ssl?: boolean;
}

const LEGACY_STRICT_SSL_MODES = new Set(["prefer", "require", "verify-ca"]);
const SSL_QUERY_PARAMETERS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert"];

/**
 * Keep node-postgres TLS behavior explicit as pg-connection-string changes its
 * legacy sslmode aliases. Hosted databases use certificate verification;
 * callers that explicitly disable TLS get a URL with TLS parameters removed.
 */
export function normalizePgConnectionString(connectionString: string, sslEnabled: boolean): string {
  const url = new URL(connectionString);

  if (!sslEnabled) {
    for (const parameter of SSL_QUERY_PARAMETERS) url.searchParams.delete(parameter);
    return url.toString();
  }

  const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
  if (!sslMode || LEGACY_STRICT_SSL_MODES.has(sslMode)) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

class PoolBackedClient implements SqlClient {
  constructor(private readonly pool: pg.Pool) {}

  async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params as never[]);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    // No params -> simple query protocol, which allows multiple statements.
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      const scoped: SqlClient = {
        query: async <R extends SqlRow = SqlRow>(sql: string, params: unknown[] = []) =>
          (await connection.query(sql, params as never[])).rows as R[],
        exec: async (sql: string) => {
          await connection.query(sql);
        },
        // Nested calls join the existing transaction rather than opening a
        // second one, so a caller cannot accidentally commit half the work.
        transaction: async <R>(inner: (tx: SqlClient) => Promise<R>) => inner(scoped),
        close: async () => undefined,
      };
      const out = await fn(scoped);
      await connection.query("COMMIT");
      return out;
    } catch (err) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPgClient(options: PgClientOptions): SqlClient {
  const sslEnabled = options.ssl !== false;
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(options.connectionString, sslEnabled),
    max: options.maxConnections ?? 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ...(sslEnabled ? {} : { ssl: false }),
  });
  // A pool error must not take the process down on a serverless instance.
  pool.on("error", (err) => {
    console.error(JSON.stringify({ msg: "postgres pool error", error: err.message }));
  });
  return new PoolBackedClient(pool);
}
