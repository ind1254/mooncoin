/**
 * Local/standalone scheduler for development and contingency hosting.
 *
 * Production uses Vercel Cron, which calls the same one-pass runtime through
 * api/cron-worker.js. Keeping this small loop is useful for local testing, but
 * it is no longer a separate production deployment requirement.
 */
import { loadEnv } from "../config/env.js";
import { createPgClient } from "../db/pgClient.js";
import { migrate } from "../db/migrate.js";
import { createScheduledWorkerRuntime } from "./runtime.js";
try {
    process.loadEnvFile();
}
catch {
    // No .env present. Expected in CI and in production.
}
const env = loadEnv();
const log = (line) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...line }));
if (!env.DATABASE_URL) {
    log({ level: "error", msg: "worker requires DATABASE_URL" });
    process.exit(1);
}
const intervalMs = env.ALERT_INTERVAL_MS;
const db = createPgClient({ connectionString: env.DATABASE_URL, maxConnections: 2 });
await migrate(db);
const runtime = createScheduledWorkerRuntime(env, { db, log });
let running = false;
let stopping = false;
async function tick() {
    if (running || stopping)
        return;
    running = true;
    const nowMs = Date.now();
    const bucketMs = Math.floor(nowMs / intervalMs) * intervalMs;
    const runKey = `scheduled:${new Date(bucketMs).toISOString()}`;
    try {
        const result = await runtime.run(runKey);
        if (result.durationMs > intervalMs) {
            log({
                level: "warn",
                msg: "pass took longer than its interval; raise ALERT_INTERVAL_MS or reduce watched tokens",
                durationMs: result.durationMs,
                intervalMs,
            });
        }
    }
    catch (err) {
        log({
            level: "error",
            msg: "scheduled worker pass failed",
            error: err instanceof Error ? err.message : String(err),
        });
    }
    finally {
        running = false;
    }
}
const timer = setInterval(() => void tick(), intervalMs);
log({ msg: "standalone worker started", intervalMs });
void tick();
async function shutdown(signal) {
    if (stopping)
        return;
    stopping = true;
    log({ msg: "standalone worker stopping", signal });
    clearInterval(timer);
    const deadline = Date.now() + 15_000;
    while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await runtime.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
