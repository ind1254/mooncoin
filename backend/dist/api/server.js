import { join } from "node:path";
import { createApp, createDefaultDeps, runNotificationTick, seedIfDemo } from "./app.js";
/**
 * Moonpaper — server entry point.
 * Paper trading only: no execution path exists anywhere in this process.
 */
// `--live` works in any shell, unlike inline env vars on Windows.
if (process.argv.includes("--live"))
    process.env.MARKET_MODE = "live";
const deps = createDefaultDeps();
// Local development convenience: with no DATABASE_URL, fall back to a
// file-backed PGlite so accounts work offline with real Postgres semantics.
// Production always sets DATABASE_URL and never takes this path.
if (!deps.db && process.env.LOCAL_DB === "true") {
    const { createLocalDevClient } = await import("../db/localDev.js");
    const { migrate } = await import("../db/migrate.js");
    const { PasswordAuthProvider } = await import("../auth/authService.js");
    const localDb = await createLocalDevClient(join(deps.env.DATA_DIR, "pgdata"));
    if (localDb) {
        await migrate(localDb);
        deps.db = localDb;
        deps.auth = new PasswordAuthProvider(localDb, {
            clock: deps.clock,
            sessionTtlMs: deps.env.SESSION_TTL_DAYS * 86_400_000,
        });
        console.log(JSON.stringify({ msg: "local dev database ready", dir: join(deps.env.DATA_DIR, "pgdata") }));
    }
}
seedIfDemo(deps);
const app = createApp(deps);
const port = deps.env.PORT;
app.listen(port, () => {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        msg: `moonpaper listening on :${port}`,
        marketMode: deps.env.MARKET_MODE,
        legacyQuoteMode: deps.env.QUOTE_MODE,
        dataSource: deps.market.bundle.dataSourceLabel,
        executionEnabled: false,
    }));
});
// Periodic pass: revalue open paper positions and evaluate notification rules
const TICK_MS = 30_000;
setInterval(() => {
    runNotificationTick(deps).catch((err) => console.error(JSON.stringify({ msg: "notification tick failed", error: String(err) })));
}, TICK_MS).unref();
// Prime rule-engine baselines shortly after boot so change-based alerts work
setTimeout(() => {
    runNotificationTick(deps).catch(() => undefined);
}, 2_000).unref();
