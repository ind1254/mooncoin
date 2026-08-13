import pg from "pg";
/**
 * Production Postgres client (Neon, Supabase, Vercel Postgres — any of them).
 *
 * Serverless note: each warm function instance keeps a small pool. Serverless
 * platforms can spawn many instances, so `max` is deliberately tiny and idle
 * connections are reaped quickly; a hosted pooler (Neon's pooled endpoint or
 * Supabase's Supavisor on 6543) should sit in front in production.
 */
// Global driver config: BIGINT (OID 20) must NOT become a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);
// NUMERIC (OID 1700) likewise — token quantities can exceed any float.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value);
class PoolBackedClient {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async query(sql, params = []) {
        const result = await this.pool.query(sql, params);
        return result.rows;
    }
    async exec(sql) {
        // No params -> simple query protocol, which allows multiple statements.
        await this.pool.query(sql);
    }
    async transaction(fn) {
        const connection = await this.pool.connect();
        try {
            await connection.query("BEGIN");
            const scoped = {
                query: async (sql, params = []) => (await connection.query(sql, params)).rows,
                exec: async (sql) => {
                    await connection.query(sql);
                },
                // Nested calls join the existing transaction rather than opening a
                // second one, so a caller cannot accidentally commit half the work.
                transaction: async (inner) => inner(scoped),
                close: async () => undefined,
            };
            const out = await fn(scoped);
            await connection.query("COMMIT");
            return out;
        }
        catch (err) {
            await connection.query("ROLLBACK").catch(() => undefined);
            throw err;
        }
        finally {
            connection.release();
        }
    }
    async close() {
        await this.pool.end();
    }
}
export function createPgClient(options) {
    const pool = new pg.Pool({
        connectionString: options.connectionString,
        max: options.maxConnections ?? 3,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 8_000,
        ...(options.ssl === false ? {} : { ssl: { rejectUnauthorized: false } }),
    });
    // A pool error must not take the process down on a serverless instance.
    pool.on("error", (err) => {
        console.error(JSON.stringify({ msg: "postgres pool error", error: err.message }));
    });
    return new PoolBackedClient(pool);
}
