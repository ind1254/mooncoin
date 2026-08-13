import { PGlite } from "@electric-sql/pglite";
import type { SqlClient, SqlRow } from "./client.js";

/**
 * Real PostgreSQL, compiled to WebAssembly, running in-process.
 *
 * This is what keeps CI both honest and deterministic: tests execute the same
 * migrations and the same SQL as production, with genuine foreign keys, CHECK
 * constraints, unique indexes and transaction rollback — but with no Docker,
 * no server, no network, and no shared state between test files.
 *
 * It is a test/dev dependency only; production uses pgClient.ts.
 */

const BIGINT_OID = 20;
const NUMERIC_OID = 1700;

class PgliteBackedClient implements SqlClient {
  constructor(
    private readonly db: PGlite,
    private readonly inTransaction = false,
  ) {}

  async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query(sql, params as never[]);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    // Nested calls join the outer transaction instead of opening another.
    if (this.inTransaction) return fn(this);
    await this.db.exec("BEGIN");
    try {
      const out = await fn(new PgliteBackedClient(this.db, true));
      await this.db.exec("COMMIT");
      return out;
    } catch (err) {
      await this.db.exec("ROLLBACK").catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** Wrap an already-constructed PGlite instance (used by local dev). */
export function createPgliteBackedClient(db: PGlite): SqlClient {
  return new PgliteBackedClient(db);
}

/** Fresh in-memory Postgres. Each call is an isolated database. */
export function createPgliteClient(): SqlClient {
  const db = new PGlite({
    // Same precision guarantee as the production driver: exact integers only.
    parsers: {
      [BIGINT_OID]: (value: string) => value,
      [NUMERIC_OID]: (value: string) => value,
    },
  });
  return new PgliteBackedClient(db);
}
