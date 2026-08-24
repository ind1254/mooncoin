/**
 * Alert worker — a long-running process, deployed separately from the API.
 *
 * It exists because everything else in this codebase runs inside an HTTP
 * request, and alerts are the opposite of that: they fire when nobody is
 * looking. Serverless cannot hold this loop, and a once-a-day cron is not an
 * alerting product for tokens that can rug in ninety seconds.
 *
 * Read-only with respect to the market, and it never trades. Its only writes
 * are alert events, rule state, and token snapshots.
 *
 * Deploy: Railway/Fly/any container host.
 *   Start command:  npm run worker --prefix backend
 *   Required env:   DATABASE_URL, SOLANA_RPC_URL
 *   Optional env:   ALERT_INTERVAL_MS (default 60000)
 */
import { loadEnv } from "../config/env.js";
import { createPgClient } from "../db/pgClient.js";
import { migrate } from "../db/migrate.js";
import { AlertEventRepository, AlertRuleRepository, AlertRuleStateRepository, LivePaperPositionRepository, PaperBotConfigRepository, PaperBotDecisionRepository, PaperBotPositionStateRepository, TokenObservationRepository, } from "../db/repositories.js";
import { JupiterTokenSearchProvider } from "../market/jupiter/tokenSearch.js";
import { JupiterLiveFeedProvider } from "../market/jupiter/liveFeed.js";
import { JupiterQuoteProvider } from "../market/jupiter/quotes.js";
import { ResearchService } from "../market/research.js";
import { SolanaRpcClient } from "../market/solana/rpc.js";
import { TradabilityService } from "../market/tradability.js";
import { runAlertPass } from "../alerts/worker.js";
import { runPaperBotPass } from "../bot/worker.js";
import { LivePaperTradingService } from "../paper/livePaper.js";
import { usdToMicro } from "../core/money.js";
// Local development convenience; production injects real environment vars.
try {
    process.loadEnvFile();
}
catch {
    // No .env present. Expected in CI and in production.
}
const env = loadEnv();
const log = (line) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...line }));
if (!env.DATABASE_URL) {
    // Without a database there are no users, no rules, and nothing to persist.
    // Exiting non-zero lets the host restart us once the variable is set,
    // rather than idling forever in a state that can never do work.
    log({ level: "error", msg: "worker requires DATABASE_URL" });
    process.exit(1);
}
const intervalMs = env.ALERT_INTERVAL_MS;
// A single connection is plenty: the worker runs one pass at a time.
const db = createPgClient({ connectionString: env.DATABASE_URL, maxConnections: 2 });
// The worker owns no schema of its own, and running migrations here would race
// the API's deploy-time migration. It only verifies that the schema it needs
// is present.
await migrate(db);
const research = new ResearchService(new JupiterTokenSearchProvider({
    baseUrl: env.JUPITER_TOKENS_URL,
    ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
    clock: Date.now,
}), new SolanaRpcClient({ endpoint: env.SOLANA_RPC_URL, commitment: "confirmed" }), { clock: Date.now, mintCacheTtlMs: env.MINT_CACHE_TTL_MS });
const quotes = new JupiterQuoteProvider({
    baseUrl: env.JUPITER_QUOTE_URL,
    ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
    clock: Date.now,
});
const liveFeed = new JupiterLiveFeedProvider({
    baseUrl: env.JUPITER_TOKENS_URL,
    ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
    clock: Date.now,
});
const tradability = new TradabilityService(research, quotes, {
    minLiquidityUsdMicro: usdToMicro(env.TRADABILITY_MIN_LIQUIDITY_USD),
    maxPriceImpactBps: BigInt(env.TRADABILITY_MAX_PRICE_IMPACT_BPS),
    maxMarketAgeMs: env.TRADABILITY_MAX_MARKET_AGE_MS,
}, Date.now);
const deps = {
    research,
    rules: new AlertRuleRepository(db),
    states: new AlertRuleStateRepository(db),
    events: new AlertEventRepository(db),
    observations: new TokenObservationRepository(db),
    clock: Date.now,
    log,
};
const paperConfig = {
    startingMicroUsd: usdToMicro(env.PAPER_STARTING_USD),
    minTradeMicroUsd: usdToMicro(env.PAPER_MIN_TRADE_USD),
    maxTradeMicroUsd: usdToMicro(env.PAPER_MAX_TRADE_USD),
    maxOpenPositions: env.PAPER_MAX_OPEN_POSITIONS,
    maxEntryPriceImpactBps: BigInt(env.TRADABILITY_MAX_PRICE_IMPACT_BPS),
};
const botDeps = {
    configs: new PaperBotConfigRepository(db),
    positions: new LivePaperPositionRepository(db),
    states: new PaperBotPositionStateRepository(db),
    decisions: new PaperBotDecisionRepository(db),
    feed: liveFeed,
    quotes,
    createPaperTrading: () => new LivePaperTradingService(db, tradability, quotes, paperConfig, Date.now),
    maxMarketAgeMs: env.TRADABILITY_MAX_MARKET_AGE_MS,
    clock: Date.now,
    log,
};
let running = false;
let stopping = false;
async function tick() {
    // Overlap guard. A pass that outlives its interval must not have a second
    // one started on top of it: two passes would diff against each other's
    // snapshots and could double-fire the same crossing.
    if (running || stopping)
        return;
    running = true;
    try {
        const alertSummary = await runAlertPass(deps);
        if (alertSummary.rulesEvaluated > 0 || alertSummary.mintsFailed > 0) {
            log({ msg: "alert pass complete", ...alertSummary });
        }
        const botSummary = await runPaperBotPass(botDeps);
        if (botSummary.configsProcessed > 0 || botSummary.providerFailures > 0) {
            log({ msg: "paper bot pass complete", ...botSummary });
        }
        const durationMs = alertSummary.durationMs + botSummary.durationMs;
        if (durationMs > intervalMs) {
            log({
                level: "warn",
                msg: "pass took longer than its interval; raise ALERT_INTERVAL_MS or reduce watched tokens",
                durationMs,
                intervalMs,
            });
        }
    }
    catch (err) {
        // A failed pass must never end the process; the next one may succeed.
        log({ level: "error", msg: "alert pass failed", error: err instanceof Error ? err.message : String(err) });
    }
    finally {
        running = false;
    }
}
const timer = setInterval(() => void tick(), intervalMs);
log({ msg: "alert worker started", intervalMs });
void tick(); // do not wait a full interval before the first pass
/** Finish the pass in flight before exiting, so no half-written state is left. */
async function shutdown(signal) {
    if (stopping)
        return;
    stopping = true;
    log({ msg: "alert worker stopping", signal });
    clearInterval(timer);
    const deadline = Date.now() + 15_000;
    while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await db.close().catch(() => undefined);
    process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
