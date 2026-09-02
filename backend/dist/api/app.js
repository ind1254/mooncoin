import express from "express";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { asArbError, ArbError } from "../core/errors.js";
import { LAMPORTS_PER_SOL, baseUnitsToDecimalString, decimalToBaseUnits, lamportsToSolString, microToUsdString, picoUsdToPriceString, solToLamports, tokenUnitsToDisplay, } from "../core/money.js";
import { loadEnv } from "../config/env.js";
import { createDemoBundle } from "../market/demoProviders.js";
import { createLiveBundle } from "../market/liveProviders.js";
import { MarketDataService } from "../market/service.js";
import { JupiterTokenSearchProvider } from "../market/jupiter/tokenSearch.js";
import { JupiterLiveFeedProvider, } from "../market/jupiter/liveFeed.js";
import { JupiterQuoteProvider } from "../market/jupiter/quotes.js";
import { ResearchService } from "../market/research.js";
import { TradabilityService } from "../market/tradability.js";
import { GRADUATION_MATURITY_MS, GRADUATION_QUALITY_SCORE, assessLiveFeedToken, sumLiveFeedVolume, } from "../market/feedAssessment.js";
import { AutoWatchRepository } from "../db/repositories.js";
import { metrics } from "../observability/metrics.js";
import { snapshotFromResearch } from "../evidence/build.js";
import { assessRisk } from "../risk/engineV3.js";
import { explainRiskChange, formatRiskChange } from "../risk/diff.js";
import { TokenHistoryRepository } from "../db/tokenHistory.js";
import { SolanaRpcClient } from "../market/solana/rpc.js";
import { computeScores } from "../scoring/scores.js";
import { PaperTradingEngine } from "../paper/engine.js";
import { LivePaperTradingService } from "../paper/livePaper.js";
import { FilePaperStateStore, InMemoryPaperStateStore } from "../paper/store.js";
import { NotificationEngine } from "../notify/engine.js";
import { FileSettingsStore, settingsSchema } from "../settings/settings.js";
import { createLegacyArbitrageRouter } from "./legacyArbitrage.js";
import { seedDemoState } from "./demoSeed.js";
import { createAuthRouter } from "./authRoutes.js";
import { PasswordAuthProvider } from "../auth/authService.js";
import { AccountLifecycleService, ResendEmailSender } from "../auth/accountLifecycle.js";
// NOTE: the Postgres driver is NOT imported here. A static top-level import
// makes the whole application unloadable if the driver is missing from the
// deployed bundle — which is exactly the outage this comment exists to
// prevent a repeat of. It is loaded dynamically in initPersistence().
/** Whole USD to micro-USD, the storage unit for all paper cash. */
export function usdToMicroUsd(usd) {
    return BigInt(Math.round(usd * 1_000_000));
}
/**
 * Research is available in every mode. Discovery and on-chain verification do
 * not depend on the demo simulator, so a user can research any real token even
 * while the simulated market powers the Discover tab.
 */
function buildResearchService(env, clock, market) {
    return new ResearchService(new JupiterTokenSearchProvider({
        baseUrl: env.JUPITER_TOKENS_URL,
        ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
        clock,
    }), new SolanaRpcClient({ endpoint: env.SOLANA_RPC_URL, commitment: "confirmed" }), {
        clock,
        mintCacheTtlMs: env.MINT_CACHE_TTL_MS,
        // Quotes only exist for tokens the simulator knows about, so paper
        // trading is offered only where a fill can honestly be modelled.
        simulationAvailable: async (mint) => (await market.listTokens()).some((t) => t.mint === mint),
    });
}
export function createDefaultDeps(overrides = {}) {
    const env = overrides.env ?? loadEnv();
    const clock = overrides.clock ?? Date.now;
    const market = overrides.market ??
        new MarketDataService(env.MARKET_MODE === "live"
            ? createLiveBundle(clock, { rpcUrl: env.SOLANA_RPC_URL, mintCacheTtlMs: env.MINT_CACHE_TTL_MS })
            : createDemoBundle(clock));
    const engine = overrides.engine ??
        new PaperTradingEngine(market, new FilePaperStateStore(join(env.DATA_DIR, "paper-state.json")), clock, {
            startingBalanceLamports: BigInt(Math.round(env.PAPER_STARTING_SOL)) * LAMPORTS_PER_SOL,
        });
    const notify = overrides.notify ?? new NotificationEngine();
    const settings = overrides.settings ?? new FileSettingsStore(join(env.DATA_DIR, "settings.json"));
    const research = overrides.research ?? buildResearchService(env, clock, market);
    const quotes = overrides.quotes ??
        new JupiterQuoteProvider({
            baseUrl: env.JUPITER_QUOTE_URL,
            ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
            clock,
        });
    const liveFeed = overrides.liveFeed ??
        new JupiterLiveFeedProvider({
            baseUrl: env.JUPITER_TOKENS_URL,
            ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
            clock,
        });
    // Persistence is attached later by initPersistence(). Constructing it here
    // would require importing the Postgres driver at module scope, and a driver
    // that fails to resolve would take the entire application down with it.
    return {
        env,
        clock,
        market,
        engine,
        notify,
        settings,
        research,
        quotes,
        liveFeed,
        db: overrides.db,
        auth: overrides.auth,
    };
}
// Probing the database on every /health call would turn a health check into a
// load generator, so results are cached briefly.
const healthCache = new WeakMap();
const HEALTH_TTL_MS = 10_000;
/**
 * Attach persistence, loading the driver dynamically.
 *
 * Any failure here — driver missing from the bundle, unreachable database,
 * bad connection string — degrades the personal subsystem only. Public
 * research keeps serving, which is the whole point of the separation.
 */
export async function initPersistence(deps) {
    if (deps.db || !deps.env.DATABASE_URL)
        return;
    try {
        const { createPgClient } = await import("../db/pgClient.js");
        const db = createPgClient({ connectionString: deps.env.DATABASE_URL });
        deps.db = db;
        deps.auth = new PasswordAuthProvider(db, {
            clock: deps.clock,
            sessionTtlMs: deps.env.SESSION_TTL_DAYS * 86_400_000,
            emailVerificationRequired: deps.env.EMAIL_VERIFICATION_REQUIRED,
        });
        const sender = deps.env.RESEND_API_KEY && deps.env.ACCOUNT_EMAIL_FROM
            ? new ResendEmailSender({ apiKey: deps.env.RESEND_API_KEY, from: deps.env.ACCOUNT_EMAIL_FROM })
            : undefined;
        deps.accountLifecycle = new AccountLifecycleService(db, {
            ...(sender ? { sender } : {}),
            appBaseUrl: deps.env.PUBLIC_APP_URL,
            clock: deps.clock,
        });
    }
    catch (err) {
        // Never include the connection string: it carries credentials.
        deps.persistenceError = err instanceof Error ? err.message : "unknown error";
        console.error(JSON.stringify({
            msg: "persistence unavailable; personal features disabled, public research unaffected",
            error: deps.persistenceError,
        }));
    }
}
/** Cheap liveness probe that also distinguishes "connected" from "migrated". */
export async function checkPersistence(deps) {
    if (!deps.db) {
        return deps.env.DATABASE_URL
            ? { status: "unavailable", ...(deps.persistenceError ? { detail: deps.persistenceError } : {}) }
            : { status: "unconfigured" };
    }
    const cached = healthCache.get(deps);
    if (cached && Date.now() - cached.checkedAtMs < HEALTH_TTL_MS) {
        const { checkedAtMs: _ignored, ...health } = cached;
        return health;
    }
    let health;
    try {
        // Touching schema_migrations proves both connectivity AND that migrations
        // have run. A reachable database with no tables is not a healthy one.
        await deps.db.query("select 1 from schema_migrations limit 1");
        health = { status: "ok" };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        health = /relation .* does not exist|undefined_table/i.test(message)
            ? { status: "schema_missing", detail: "Run database migrations (npm run migrate)." }
            : { status: "unavailable", detail: "Database connection failed." };
    }
    healthCache.set(deps, { ...health, checkedAtMs: Date.now() });
    return health;
}
/** In-memory settings store used by tests. */
export class InMemorySettingsStore {
    s = settingsSchema.parse({});
    get() {
        return this.s;
    }
    update(patch) {
        this.s = settingsSchema.parse({ ...this.s, ...patch });
        return this.s;
    }
}
/** In-memory variant for tests — no files touched. */
export function createTestDeps(clock, env) {
    const fullEnv = loadEnv({
        ...process.env,
        ...Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, String(v)])),
    });
    const market = new MarketDataService(createDemoBundle(clock));
    const engine = new PaperTradingEngine(market, new InMemoryPaperStateStore(), clock, {
        startingBalanceLamports: BigInt(Math.round(fullEnv.PAPER_STARTING_SOL)) * LAMPORTS_PER_SOL,
    });
    // Offline by default: an empty discovery transport, so a test that does not
    // explicitly provide fixtures can never reach the network.
    const research = new ResearchService(new JupiterTokenSearchProvider({ clock, fetchImpl: async () => new Response("[]", { status: 200 }) }), new SolanaRpcClient({ fetchImpl: async () => new Response("{}", { status: 503 }) }), { clock });
    return {
        env: fullEnv,
        clock,
        market,
        engine,
        notify: new NotificationEngine(),
        settings: new InMemorySettingsStore(),
        research,
        quotes: new JupiterQuoteProvider({
            clock,
            fetchImpl: async () => new Response("{}", { status: 503 }),
        }),
        liveFeed: new JupiterLiveFeedProvider({
            clock,
            fetchImpl: async () => new Response("[]", { status: 200 }),
        }),
    };
}
const pctStr = (bps) => (Number(bps) / 100).toFixed(2);
function limitsFrom(settings) {
    return {
        maxPriceImpactBps: BigInt(settings.maxPriceImpactBps),
        minLiquidityUsdMicro: BigInt(settings.minLiquidityUsd) * 1000000n,
    };
}
function serializeRoute(q, decimals) {
    const isBuy = q.side === "buy";
    return {
        venueId: q.venueId,
        venueName: q.venueName,
        side: q.side,
        inAmount: q.inAmount.toString(),
        outAmount: q.outAmount.toString(),
        inDisplay: isBuy ? `${lamportsToSolString(q.inAmount)} SOL` : `${tokenUnitsToDisplay(q.inAmount, decimals)} tokens`,
        outDisplay: isBuy ? `${tokenUnitsToDisplay(q.outAmount, decimals)} tokens` : `${lamportsToSolString(q.outAmount)} SOL`,
        minReceived: q.minReceived.toString(),
        minReceivedDisplay: isBuy
            ? `${tokenUnitsToDisplay(q.minReceived, decimals)} tokens`
            : `${lamportsToSolString(q.minReceived)} SOL`,
        effectivePriceUsd: picoUsdToPriceString(q.effectivePricePicoUsd),
        priceImpactPct: pctStr(q.priceImpactBps),
        routeFeePct: pctStr(q.routeFeeBps),
        networkFeeSol: lamportsToSolString(q.networkFeeLamports, 6),
        priorityFeeSol: lamportsToSolString(q.priorityFeeLamports, 6),
        slippagePct: pctStr(q.slippageBps),
        retrievedAtMs: q.retrievedAtMs,
        expiresAtMs: q.expiresAtMs,
        source: q.source,
    };
}
function serializeComparison(routes, decimals) {
    return {
        best: routes.best ? serializeRoute(routes.best, decimals) : null,
        alternatives: routes.alternatives.map((r) => serializeRoute(r, decimals)),
        failures: routes.failures,
    };
}
/**
 * Provider field names differ from the names we serialize (bps vs pct), so
 * per-field provenance is re-keyed to match what the client actually reads.
 * Without this a lookup silently misses and everything looks unattributed.
 */
const RISK_FIELD_NAMES = {
    tokenAgeDays: "tokenAgeDays",
    holderConcentrationBps: "holderConcentrationPct",
    mintAuthorityRevoked: "mintAuthorityRevoked",
    freezeAuthorityRevoked: "freezeAuthorityRevoked",
    recentInsiderActivity: "recentInsiderActivity",
    dataComplete: "dataComplete",
};
function serializeFieldSources(sources) {
    if (!sources)
        return null;
    const out = {};
    for (const [key, source] of Object.entries(sources)) {
        out[RISK_FIELD_NAMES[key] ?? key] = source;
    }
    return out;
}
/** Same ticker on more than one mint — the case the UI must never collapse. */
function hasDuplicateSymbols(results) {
    const seen = new Set();
    for (const r of results) {
        const key = r.symbol.toLowerCase();
        if (seen.has(key))
            return true;
        seen.add(key);
    }
    return false;
}
const usdOrNull = (v) => (v === null ? null : microToUsdString(v));
const pctOrNull = (v) => (v === null ? null : pctStr(v));
/**
 * Flattens the on-chain verification record for JSON.
 *
 * The holder figures are bigint basis points internally, and JSON.stringify
 * throws outright on a BigInt — so passing this record through untouched would
 * turn every research request into a 500. Basis points are bounded by 10_000,
 * far inside Number's exact range, so widening them here loses nothing.
 */
function serializeVerification(v) {
    const { holders, ...rest } = v;
    if (!holders)
        return { ...rest, holders: null };
    const bps = (value) => value === undefined ? null : Number(value);
    return {
        ...rest,
        holders: {
            status: holders.status,
            detail: holders.detail,
            concentrationBps: bps(holders.concentrationBps),
            programHeldBps: bps(holders.programHeldBps),
            unclassifiedBps: bps(holders.unclassifiedBps),
            walletHolderCount: holders.walletHolderCount ?? null,
        },
    };
}
function serializeLiveFeedToken(token, nowMs, inWatchlist, policy, duplicateSymbolCount, assessment = assessLiveFeedToken(token, nowMs, policy, duplicateSymbolCount), rank) {
    const market = token.token.market;
    const updatedAgeSeconds = token.updatedAtMs === null ? null : Math.max(0, Math.round((nowMs - token.updatedAtMs) / 1000));
    const marketAgeSeconds = token.firstPoolAtMs === null ? null : Math.max(0, Math.round((nowMs - token.firstPoolAtMs) / 1_000));
    const volume = (window) => usdOrNull(sumLiveFeedVolume(token, window));
    const serializeWindow = (window) => ({
        priceChangePct: pctOrNull(window.priceChangeBps),
        liquidityChangePct: pctOrNull(window.liquidityChangeBps),
        volumeChangePct: pctOrNull(window.volumeChangeBps),
        buyVolumeUsd: usdOrNull(window.buyVolumeUsdMicro),
        sellVolumeUsd: usdOrNull(window.sellVolumeUsdMicro),
        buys: window.buys,
        sells: window.sells,
        traders: window.traders,
    });
    return {
        mint: token.token.mint,
        symbol: token.token.symbol,
        name: token.token.name,
        decimals: token.token.decimals,
        iconUrl: token.token.iconUrl,
        tokenProgram: token.token.tokenProgram,
        tags: token.token.tags,
        launchpad: token.launchpad,
        verifiedByProvider: token.token.verifiedByProvider,
        source: token.token.source,
        firstPoolAtMs: token.firstPoolAtMs,
        marketAgeSeconds,
        updatedAtMs: token.updatedAtMs,
        updatedAgeSeconds,
        reliability: updatedAgeSeconds === null ? "unavailable" : updatedAgeSeconds <= 60 ? "fresh" : updatedAgeSeconds <= 300 ? "stale" : "unavailable",
        priceUsd: market.priceUsdPico === null ? null : picoUsdToPriceString(market.priceUsdPico),
        liquidityUsd: usdOrNull(market.liquidityUsdMicro),
        marketCapUsd: usdOrNull(market.marketCapUsdMicro),
        holderCount: market.holderCount,
        topHolderPct: pctOrNull(market.topHolderPctBps),
        organicScore: market.organicScore,
        fiveMinuteVolumeUsd: volume("fiveMinutes"),
        oneHourVolumeUsd: volume("oneHour"),
        twentyFourHourVolumeUsd: volume("twentyFourHours"),
        stats5m: serializeWindow(token.fiveMinutes),
        stats1h: serializeWindow(token.oneHour),
        stats24h: serializeWindow(token.twentyFourHours),
        providerClaims: token.token.providerClaims,
        assessment,
        rank: rank ?? null,
        inWatchlist,
    };
}
function serializeSearchResult(r) {
    return {
        mint: r.mint,
        symbol: r.symbol,
        name: r.name,
        decimals: r.decimals,
        iconUrl: r.iconUrl,
        tokenProgram: r.tokenProgram,
        verifiedByProvider: r.verifiedByProvider,
        tags: r.tags,
        source: r.source,
        // Enough market context to tell same-ticker tokens apart.
        priceUsd: r.market.priceUsdPico === null ? null : picoUsdToPriceString(r.market.priceUsdPico),
        liquidityUsd: usdOrNull(r.market.liquidityUsdMicro),
        holderCount: r.market.holderCount,
    };
}
/** Risk v3, wire shape. Factors carry their own provenance, not just a number. */
function serializeRiskAssessment(risk) {
    return {
        riskScore: risk.riskScore,
        riskConfidence: risk.riskConfidence,
        riskLevel: risk.riskLevel,
        riskModelVersion: risk.riskModelVersion,
        observedAt: new Date(risk.observedAt).toISOString(),
        factors: risk.factors.map((f) => ({
            id: f.id,
            label: f.label,
            fact: f.fact,
            interpretation: f.interpretation,
            points: f.points,
            direction: f.direction,
            status: f.status,
            source: f.source,
        })),
        missingEvidence: risk.missingEvidence,
    };
}
/**
 * What the assessment knew and did not know.
 *
 * Published so a client can say "scored without holder data" rather than
 * presenting a confident number over a partial picture.
 */
function serializeEvidenceSummary(snapshot) {
    return {
        observedAt: new Date(snapshot.observedAt).toISOString(),
        sources: snapshot.sources,
        unavailable: snapshot.unavailableEvidence,
        unavailableCount: snapshot.unavailableEvidence.length,
    };
}
function serializeProfile(p) {
    return {
        mint: p.mint,
        symbol: p.symbol,
        name: p.name,
        decimals: p.decimals,
        tokenProgram: p.tokenProgram,
        iconUrl: p.iconUrl,
        tags: p.tags,
        verifiedByProvider: p.verifiedByProvider,
        identitySource: p.identitySource,
        marketSource: p.marketSource,
        marketUpdatedAtMs: p.marketUpdatedAtMs,
        fetchedAtMs: p.fetchedAtMs,
        market: {
            priceUsd: p.market.priceUsdPico === null ? null : picoUsdToPriceString(p.market.priceUsdPico),
            liquidityUsd: usdOrNull(p.market.liquidityUsdMicro),
            marketCapUsd: usdOrNull(p.market.marketCapUsdMicro),
            fdvUsd: usdOrNull(p.market.fdvUsdMicro),
            holderCount: p.market.holderCount,
            change1hPct: pctOrNull(p.market.change1hBps),
            change24hPct: pctOrNull(p.market.change24hBps),
            buyVolume24hUsd: usdOrNull(p.market.buyVolume24hUsdMicro),
            sellVolume24hUsd: usdOrNull(p.market.sellVolume24hUsdMicro),
            numBuys24h: p.market.numBuys24h,
            numSells24h: p.market.numSells24h,
            topHolderPct: pctOrNull(p.market.topHolderPctBps),
            organicScore: p.market.organicScore,
            organicScoreLabel: p.market.organicScoreLabel,
            source: p.marketSource,
        },
        verification: serializeVerification(p.verification),
        authorities: p.authorities,
        risk: p.risk,
        simulation: p.simulation,
    };
}
function serializeTradability(check, nowMs) {
    const q = check.quote;
    return {
        live: true,
        simulationOnly: true,
        executionEnabled: false,
        checkedAtMs: check.checkedAtMs,
        token: { mint: check.mint, symbol: check.symbol, name: check.name, decimals: check.profile.decimals },
        request: { amountUsd: check.amountUsd, slippagePct: pctStr(check.slippageBps) },
        eligible: check.eligible,
        tradable: check.tradable,
        verdict: check.verdict,
        summary: check.summary,
        blockingGateIds: check.blockingGateIds,
        duplicateMints: check.duplicateMints,
        policy: {
            minLiquidityUsd: microToUsdString(check.policy.minLiquidityUsdMicro),
            maxPriceImpactPct: pctStr(check.policy.maxPriceImpactBps),
            maxMarketAgeSeconds: Math.round(check.policy.maxMarketAgeMs / 1_000),
        },
        gates: check.gates,
        quote: q === null
            ? null
            : {
                input: `${baseUnitsToDecimalString(q.inAmount, check.inputToken.decimals)} ${check.inputToken.symbol}`,
                output: `${baseUnitsToDecimalString(q.outAmount, check.profile.decimals)} ${check.symbol}`,
                minimumOutput: `${baseUnitsToDecimalString(q.minOutAmount, check.profile.decimals)} ${check.symbol}`,
                priceImpactPct: pctStr(q.priceImpactBps),
                route: q.routePlan.map((hop) => ({ venue: hop.ammLabel, percent: hop.percent })),
                retrievedAtMs: q.retrievedAtMs,
                expiresAtMs: q.expiresAtMs,
                ageSeconds: Math.max(0, Math.round((nowMs - q.retrievedAtMs) / 1_000)),
                expired: nowMs >= q.expiresAtMs,
                source: q.source,
            },
        notice: "Eligibility is a point-in-time research result for this exact quote size. It does not execute a trade or predict performance.",
    };
}
function serializeScores(scores) {
    return {
        momentum: scores.momentum,
        liquidity: scores.liquidity,
        execution: scores.execution,
        risk: scores.risk,
        opportunity: scores.opportunity,
        riskLevel: scores.riskLevel,
        opportunityLabel: scores.opportunityLabel,
        disclaimer: "Scores describe current market conditions. They are not a prediction of future returns.",
    };
}
function serializePosition(p) {
    return {
        id: p.id,
        simulated: true,
        executionMode: p.executionMode,
        status: p.status,
        tokenMint: p.tokenMint,
        tokenSymbol: p.tokenSymbol,
        openedAtMs: p.openedAtMs,
        entryVenue: p.entryVenueName,
        entryPriceUsd: picoUsdToPriceString(p.entryPricePicoUsd),
        solSpent: lamportsToSolString(p.solSpentLamports),
        entryFeesSol: lamportsToSolString(p.entryNetworkFeeLamports, 6),
        totalCostSol: lamportsToSolString(p.totalCostLamports),
        tokensReceived: tokenUnitsToDisplay(p.tokensReceived, p.tokenDecimals),
        tokensReceivedRaw: p.tokensReceived.toString(),
        entryImpactPct: pctStr(p.entryImpactBps),
        entryRouteFeePct: pctStr(p.entryRouteFeeBps),
        slippagePct: pctStr(p.slippageBps),
        entryConditions: {
            opportunityScore: p.entryConditions.opportunityScore,
            riskScore: p.entryConditions.riskScore,
            riskLevel: p.entryConditions.riskLevel,
            liquidityUsd: microToUsdString(p.entryConditions.liquidityUsdMicro),
            change1hPct: pctStr(p.entryConditions.change1hBps),
        },
        currentValueSol: lamportsToSolString(p.currentValueLamports),
        unrealizedPnlSol: lamportsToSolString(p.unrealizedPnlLamports),
        returnPct: pctStr(p.returnBps),
        highWaterSol: lamportsToSolString(p.highWaterLamports),
        lowWaterSol: lamportsToSolString(p.lowWaterLamports),
        valuationStale: p.valuationStale,
        lastValuedAtMs: p.lastValuedAtMs,
        closedAtMs: p.closedAtMs ?? null,
        exitVenue: p.exitVenueName ?? null,
        exitValueSol: p.exitValueLamports !== undefined ? lamportsToSolString(p.exitValueLamports) : null,
        exitFeesSol: p.exitNetworkFeeLamports !== undefined ? lamportsToSolString(p.exitNetworkFeeLamports, 6) : null,
        exitImpactPct: p.exitImpactBps !== undefined ? pctStr(p.exitImpactBps) : null,
        realizedPnlSol: p.realizedPnlLamports !== undefined ? lamportsToSolString(p.realizedPnlLamports) : null,
    };
}
function serializePortfolio(portfolio) {
    const s = portfolio.stats;
    return {
        simulated: true,
        notice: "All values are simulated paper-trading results. No real funds are involved.",
        startingBalanceSol: lamportsToSolString(portfolio.startingBalanceLamports),
        cashSol: lamportsToSolString(portfolio.cashLamports),
        totalValueSol: lamportsToSolString(portfolio.totalValueLamports),
        openPositions: portfolio.openPositions.map(serializePosition),
        closedPositions: portfolio.closedPositions.map(serializePosition),
        stats: {
            totalTrades: s.totalTrades,
            openCount: s.openCount,
            closedCount: s.closedCount,
            winCount: s.winCount,
            lossCount: s.lossCount,
            winRatePct: s.winRatePct,
            totalRealizedPnlSol: lamportsToSolString(s.totalRealizedPnlLamports),
            totalUnrealizedPnlSol: lamportsToSolString(s.totalUnrealizedPnlLamports),
            avgGainPct: pctStr(s.avgGainBps),
            avgLossPct: pctStr(s.avgLossBps),
            bestTradePct: pctStr(s.bestTradeBps),
            worstTradePct: pctStr(s.worstTradeBps),
            totalNetworkFeesSol: lamportsToSolString(s.totalNetworkFeesLamports, 6),
            avgExecutionCostPct: pctStr(s.avgExecutionCostBps),
            byRiskLevel: Object.fromEntries(Object.entries(s.byRiskLevel).map(([level, v]) => [
                level,
                { trades: v.trades, realizedPnlSol: lamportsToSolString(v.realizedPnlLamports), winRatePct: v.winRatePct },
            ])),
        },
    };
}
async function scoreToken(deps, mint, tradeSizeSol, settings) {
    const view = await deps.market.getView(mint);
    const tradeSizeLamports = solToLamports(tradeSizeSol);
    const routes = await deps.market.getBuyRoutes(mint, tradeSizeLamports, BigInt(settings.maxSlippageBps));
    const tradeSizeUsdMicro = (tradeSizeLamports * view.solPriceMicroUsd) / LAMPORTS_PER_SOL;
    const scores = computeScores(view, routes, tradeSizeUsdMicro, limitsFrom(settings), deps.clock());
    return { view, routes, scores, tradeSizeLamports };
}
export async function collectScoredTokens(deps, tradeSizeSol) {
    const settings = deps.settings.get();
    const tokens = await deps.market.listTokens();
    const results = await Promise.allSettled(tokens.map((t) => scoreToken(deps, t.mint, tradeSizeSol, settings)));
    return results
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);
}
/** One notification-engine pass over current market + portfolio state. */
export async function runNotificationTick(deps) {
    const settings = deps.settings.get();
    const scored = await collectScoredTokens(deps, settings.defaultTradeSizeSol);
    await deps.engine.revalueOpenPositions();
    const open = deps.engine.getState().positions.filter((p) => p.status === "open");
    const created = deps.notify.evaluate({
        tokens: scored.map(({ view, scores, routes }) => ({ view, scores, routes })),
        openPositions: open,
        settings,
        nowMs: deps.clock(),
    });
    return created.length;
}
export function createApp(deps) {
    const app = express();
    const tradabilityPolicy = {
        minLiquidityUsdMicro: BigInt(deps.env.TRADABILITY_MIN_LIQUIDITY_USD) * 1000000n,
        maxPriceImpactBps: BigInt(deps.env.TRADABILITY_MAX_PRICE_IMPACT_BPS),
        maxMarketAgeMs: deps.env.TRADABILITY_MAX_MARKET_AGE_MS,
    };
    const tradability = new TradabilityService(deps.research, deps.quotes, tradabilityPolicy, deps.clock);
    app.disable("x-powered-by");
    // Vercel is the single front proxy. This makes req.ip the caller address for
    // the durable network-level authentication budget.
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "32kb" }));
    // Browser and embedding policy. The SPA intentionally uses small inline
    // style attributes, but scripts and API connections remain same-origin.
    app.use((req, res, next) => {
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        if (deps.env.COOKIE_SECURE) {
            res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        }
        if (req.path.startsWith("/v1/auth") ||
            req.path.startsWith("/v1/me") ||
            req.path.startsWith("/v1/owner") ||
            req.path.startsWith("/v1/integrations")) {
            res.setHeader("Cache-Control", "no-store");
        }
        next();
    });
    // Correlation IDs + structured request logging; never logs request bodies
    app.use((req, res, next) => {
        const suppliedCorrelationId = req.headers["x-correlation-id"];
        const candidate = Array.isArray(suppliedCorrelationId) ? suppliedCorrelationId[0] : suppliedCorrelationId;
        const correlationId = typeof candidate === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(candidate) ? candidate : randomUUID();
        res.locals.correlationId = correlationId;
        res.setHeader("x-correlation-id", correlationId);
        const startedAt = Date.now();
        res.on("finish", () => {
            console.log(JSON.stringify({
                ts: new Date().toISOString(),
                correlationId,
                method: req.method,
                path: req.path,
                status: res.statusCode,
                durationMs: Date.now() - startedAt,
            }));
        });
        next();
    });
    // Cookie-authenticated writes must originate from this host. Native clients
    // and server-to-server callers normally omit Origin and remain supported.
    app.use((req, res, next) => {
        if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(req.method) || !req.headers.origin) {
            next();
            return;
        }
        // Host is the browser-selected authority. Do not trust X-Forwarded-Host:
        // deployments without a sanitizing proxy could let a caller spoof it.
        const expectedHost = req.headers.host?.trim().toLowerCase();
        let originHost = null;
        try {
            originHost = new URL(req.headers.origin).host.toLowerCase();
        }
        catch {
            // Malformed origins are never trusted.
        }
        if (!expectedHost || originHost !== expectedHost) {
            res.status(403).json({
                correlationId: res.locals.correlationId,
                error: "ORIGIN_NOT_ALLOWED",
                message: "This write request did not come from Moonpaper.",
                executionEnabled: false,
            });
            return;
        }
        next();
    });
    // Request safety timeout — a hung provider must not hang the client
    app.use((req, res, next) => {
        const timer = setTimeout(() => {
            if (!res.headersSent) {
                res.status(504).json({ error: "TIMEOUT", message: "The request took too long — please try again." });
            }
        }, 15_000);
        res.on("finish", () => clearTimeout(timer));
        res.on("close", () => clearTimeout(timer));
        next();
    });
    const fail = (res, err) => {
        const e = asArbError(err);
        res.status(e.httpStatus).json({
            correlationId: res.locals.correlationId,
            error: e.code,
            message: e.message,
            details: e.details ?? null,
            executionEnabled: false,
        });
    };
    const meta = (deps_) => ({
        product: "Moonpaper (prototype)",
        simulated: true,
        executionEnabled: false,
        dataSource: deps_.market.bundle.dataSourceLabel,
        isDemoData: deps_.market.bundle.isDemo,
        liveFeedSource: deps_.liveFeed.source,
    });
    /**
     * Diagnostic health check.
     *
     * Always 200 when the process is alive and serving: a degraded database must
     * not make uptime monitors report the whole app down, because public
     * research still works. The body carries the detail, and `degraded` is the
     * flag to alert on. Deliberately does NOT call market providers — a health
     * check must never fan out to third parties on every request.
     */
    app.get("/health", async (_req, res) => {
        const persistence = await checkPersistence(deps);
        const degraded = persistence.status !== "ok" && persistence.status !== "unconfigured";
        const accountsEnabled = Boolean(deps.db && deps.auth) && persistence.status === "ok";
        res.status(200).json({
            app: "ok",
            database: persistence.status,
            // "ok" only when we proved migrations ran; unknown when we cannot reach it.
            migrations: persistence.status === "ok" ? "ok" : persistence.status === "schema_missing" ? "missing" : "unknown",
            accountsEnabled,
            accountLifecycle: {
                available: accountsEnabled && Boolean(deps.accountLifecycle),
                emailDeliveryConfigured: deps.accountLifecycle?.deliveryConfigured ?? false,
                verificationRequired: deps.env.EMAIL_VERIFICATION_REQUIRED,
                provider: deps.accountLifecycle?.deliveryKind ?? null,
            },
            safeguards: {
                securityHeaders: true,
                sameOriginWrites: true,
                durableRateLimits: accountsEnabled,
                retrySafePaperEntries: accountsEnabled,
            },
            degraded,
            ...(persistence.detail ? { detail: persistence.detail } : {}),
            ...meta(deps),
        });
    });
    app.get("/v1/meta", async (_req, res) => {
        try {
            const solPrice = await deps.market.getSolPriceMicroUsd();
            res.json({ ...meta(deps), solPriceUsd: microToUsdString(solPrice) });
        }
        catch (err) {
            fail(res, err);
        }
    });
    // ---- Research: search any Solana token ----
    app.get("/v1/search", async (req, res) => {
        try {
            const q = z
                .object({ q: z.string().min(1).max(64) })
                .safeParse(req.query);
            if (!q.success) {
                throw new ArbError("VALIDATION_ERROR", "A search query is required", 400);
            }
            const query = q.data.q.trim();
            const abort = new AbortController();
            req.on("close", () => abort.abort());
            const results = await deps.research.search(query, abort.signal);
            res.json({
                query,
                count: results.length,
                // Distinct mints sharing one ticker is normal; the UI must disambiguate.
                duplicateSymbols: hasDuplicateSymbols(results),
                source: deps.research.searchSource,
                results: results.map(serializeSearchResult),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    // ---- Live discovery: current Solana tokens, separate from the simulator ----
    const liveFeedQuery = z.object({
        kind: z.enum(["recent", "trending"]).default("trending"),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        minLiquidityUsd: z.coerce.number().min(0).optional(),
        minMarketCapUsd: z.coerce.number().min(0).optional(),
        maxMarketCapUsd: z.coerce.number().min(0).optional(),
        minAgeMinutes: z.coerce.number().min(0).optional(),
        maxAgeMinutes: z.coerce.number().min(0).optional(),
        minVolume5mUsd: z.coerce.number().min(0).optional(),
        minQualityScore: z.coerce.number().int().min(0).max(100).optional(),
        maxRiskScore: z.coerce.number().int().min(0).max(100).optional(),
        verifiedOnly: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
        /**
         * Graduated tokens are hidden by default: discovery is for tokens the user
         * has not seen, and an established coin sitting at the top of a
         * score-sorted feed is occupying a slot a new launch could use. Opt in to
         * inspect the shelf's contents against the live feed.
         */
        includeGraduated: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
        sort: z.enum(["score", "volume", "marketCap", "newest"]).default("score"),
        search: z.string().max(80).optional(),
    }).refine((value) => value.minMarketCapUsd === undefined || value.maxMarketCapUsd === undefined || value.minMarketCapUsd <= value.maxMarketCapUsd, { message: "Minimum market cap cannot exceed maximum market cap" }).refine((value) => value.minAgeMinutes === undefined || value.maxAgeMinutes === undefined || value.minAgeMinutes <= value.maxAgeMinutes, { message: "Minimum market age cannot exceed maximum market age" });
    app.get("/v1/feed", async (req, res) => {
        try {
            const q = liveFeedQuery.safeParse(req.query);
            if (!q.success) {
                throw new ArbError("VALIDATION_ERROR", "Invalid live-feed query parameters", 400, {
                    issues: q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
                });
            }
            const abort = new AbortController();
            req.on("close", () => abort.abort());
            const feed = await deps.liveFeed.getFeed(q.data.kind, abort.signal);
            const settings = deps.settings.get();
            const nowMs = deps.clock();
            const symbolMints = new Map();
            for (const item of feed.tokens) {
                const key = item.token.symbol.toLowerCase();
                const mints = symbolMints.get(key) ?? new Set();
                mints.add(item.token.mint);
                symbolMints.set(key, mints);
            }
            const assessed = feed.tokens.map((item) => ({
                item,
                assessment: assessLiveFeedToken(item, nowMs, tradabilityPolicy, symbolMints.get(item.token.symbol.toLowerCase())?.size ?? 1),
            }));
            let tokens = assessed;
            const usdThreshold = (value) => BigInt(Math.round(value)) * 1000000n;
            if (q.data.minLiquidityUsd !== undefined) {
                const threshold = usdThreshold(q.data.minLiquidityUsd);
                tokens = tokens.filter(({ item }) => (item.token.market.liquidityUsdMicro ?? 0n) >= threshold);
            }
            if (q.data.minMarketCapUsd !== undefined) {
                const threshold = usdThreshold(q.data.minMarketCapUsd);
                tokens = tokens.filter(({ item }) => (item.token.market.marketCapUsdMicro ?? 0n) >= threshold);
            }
            if (q.data.maxMarketCapUsd !== undefined) {
                const threshold = usdThreshold(q.data.maxMarketCapUsd);
                tokens = tokens.filter(({ item }) => {
                    const marketCap = item.token.market.marketCapUsdMicro;
                    return marketCap !== null && marketCap <= threshold;
                });
            }
            if (q.data.minAgeMinutes !== undefined) {
                const thresholdMs = q.data.minAgeMinutes * 60_000;
                tokens = tokens.filter(({ item }) => item.firstPoolAtMs !== null && nowMs - item.firstPoolAtMs >= thresholdMs);
            }
            if (q.data.maxAgeMinutes !== undefined) {
                const thresholdMs = q.data.maxAgeMinutes * 60_000;
                tokens = tokens.filter(({ item }) => item.firstPoolAtMs !== null && nowMs - item.firstPoolAtMs <= thresholdMs);
            }
            if (q.data.minVolume5mUsd !== undefined) {
                const threshold = usdThreshold(q.data.minVolume5mUsd);
                tokens = tokens.filter(({ item }) => (sumLiveFeedVolume(item, "fiveMinutes") ?? 0n) >= threshold);
            }
            if (q.data.minQualityScore !== undefined) {
                tokens = tokens.filter(({ assessment }) => assessment.qualityScore >= q.data.minQualityScore);
            }
            if (q.data.maxRiskScore !== undefined) {
                tokens = tokens.filter(({ assessment }) => assessment.riskScore <= q.data.maxRiskScore);
            }
            if (q.data.verifiedOnly) {
                tokens = tokens.filter(({ item }) => item.token.verifiedByProvider);
            }
            const graduatedCount = tokens.filter(({ assessment }) => assessment.graduated).length;
            if (!q.data.includeGraduated) {
                // Same predicate the worker persists on, so the feed and the shelf can
                // never disagree about what has graduated.
                tokens = tokens.filter(({ assessment }) => !assessment.graduated);
            }
            if (q.data.search) {
                const needle = q.data.search.toLowerCase();
                tokens = tokens.filter(({ item }) => item.token.symbol.toLowerCase().includes(needle) ||
                    item.token.name.toLowerCase().includes(needle) ||
                    item.token.mint.toLowerCase().includes(needle));
            }
            const bigintDesc = (left, right) => {
                const a = left ?? -1n;
                const b = right ?? -1n;
                return a === b ? 0 : a > b ? -1 : 1;
            };
            tokens.sort((left, right) => {
                if (q.data.sort === "newest")
                    return (right.item.firstPoolAtMs ?? 0) - (left.item.firstPoolAtMs ?? 0);
                if (q.data.sort === "volume") {
                    return bigintDesc(sumLiveFeedVolume(left.item, "fiveMinutes"), sumLiveFeedVolume(right.item, "fiveMinutes"));
                }
                if (q.data.sort === "marketCap") {
                    return bigintDesc(left.item.token.market.marketCapUsdMicro, right.item.token.market.marketCapUsdMicro);
                }
                return right.assessment.qualityScore - left.assessment.qualityScore
                    || right.assessment.confidenceScore - left.assessment.confidenceScore
                    || left.assessment.riskScore - right.assessment.riskScore
                    || bigintDesc(sumLiveFeedVolume(left.item, "fiveMinutes"), sumLiveFeedVolume(right.item, "fiveMinutes"));
            });
            tokens = tokens.slice(0, q.data.limit);
            res.json({
                ...meta(deps),
                live: true,
                simulatedMarketData: false,
                kind: feed.kind,
                source: feed.source,
                fetchedAtMs: feed.fetchedAtMs,
                computedAtMs: nowMs,
                ageMilliseconds: Math.max(0, nowMs - feed.fetchedAtMs),
                ageSeconds: Math.max(0, Math.round((nowMs - feed.fetchedAtMs) / 1000)),
                reliability: feed.reliability,
                refreshAfterMs: 1_000,
                count: tokens.length,
                graduated: {
                    // Reported rather than silently dropped, so the feed can say "3
                    // established coins are on the shelf" instead of leaving the user
                    // wondering where BONK went.
                    hidden: q.data.includeGraduated ? 0 : graduatedCount,
                    included: q.data.includeGraduated === true,
                    qualityScore: GRADUATION_QUALITY_SCORE,
                    maturityDays: Math.round(GRADUATION_MATURITY_MS / 86_400_000),
                },
                ranking: {
                    sort: q.data.sort,
                    scoreVersion: "live-v2",
                    description: "Ranked from live demand, market depth, safety, maturity, and evidence confidence; the score is not a profit probability.",
                },
                policy: {
                    minLiquidityUsd: deps.env.TRADABILITY_MIN_LIQUIDITY_USD.toString(),
                    maxPriceImpactPct: pctStr(tradabilityPolicy.maxPriceImpactBps),
                    maxMarketAgeSeconds: Math.round(tradabilityPolicy.maxMarketAgeMs / 1_000),
                },
                notice: "Live catalog data is not an execution guarantee. Run the production check to verify a route, market freshness, liquidity, ticker ambiguity, and the mint account.",
                tokens: tokens.map(({ item, assessment }, index) => serializeLiveFeedToken(item, nowMs, settings.watchlist.includes(item.token.mint), tradabilityPolicy, symbolMints.get(item.token.symbol.toLowerCase())?.size ?? 1, assessment, index + 1)),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    /**
     * Read-only quote preview. Answers "what would this swap return right now?"
     * and records nothing. There is no fallback: if no live quote exists the
     * caller is told so, because a fabricated fill price would be misleading.
     */
    app.get("/v1/quote", async (req, res) => {
        try {
            const q = z
                .object({
                inputMint: z.string().min(32).max(64),
                outputMint: z.string().min(32).max(64),
                amount: z.string().min(1).max(32),
                slippageBps: z.coerce.number().int().min(1).max(5_000).default(50),
            })
                .safeParse(req.query);
            if (!q.success) {
                throw new ArbError("VALIDATION_ERROR", "inputMint, outputMint and amount are required", 400, {
                    issues: q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
                });
            }
            const abort = new AbortController();
            req.on("close", () => abort.abort());
            // Decimals come from the canonical token record, never from the client.
            const [inputToken, outputToken] = await Promise.all([
                deps.research.resolveToken(q.data.inputMint, abort.signal),
                deps.research.resolveToken(q.data.outputMint, abort.signal),
            ]);
            if (!inputToken)
                throw new ArbError("TOKEN_NOT_ALLOWED", "Unknown input token", 404);
            if (!outputToken)
                throw new ArbError("TOKEN_NOT_ALLOWED", "Unknown output token", 404);
            let amountBase;
            try {
                amountBase = decimalToBaseUnits(q.data.amount, inputToken.decimals);
            }
            catch (err) {
                throw new ArbError("VALIDATION_ERROR", err.message, 400);
            }
            const quote = await deps.quotes.getQuote({
                inputMint: inputToken.mint,
                outputMint: outputToken.mint,
                amount: amountBase,
                slippageBps: BigInt(q.data.slippageBps),
            }, abort.signal);
            const now = deps.clock();
            res.json({
                simulationOnly: true,
                executionEnabled: false,
                notice: "Live quote for a hypothetical trade. Moonpaper does not submit transactions.",
                input: { mint: inputToken.mint, symbol: inputToken.symbol, decimals: inputToken.decimals },
                output: { mint: outputToken.mint, symbol: outputToken.symbol, decimals: outputToken.decimals },
                quote: {
                    inAmount: baseUnitsToDecimalString(quote.inAmount, inputToken.decimals),
                    outAmount: baseUnitsToDecimalString(quote.outAmount, outputToken.decimals),
                    minOutAmount: baseUnitsToDecimalString(quote.minOutAmount, outputToken.decimals),
                    inAmountRaw: quote.inAmount.toString(),
                    outAmountRaw: quote.outAmount.toString(),
                    priceImpactPct: pctStr(quote.priceImpactBps),
                    slippagePct: pctStr(quote.slippageBps),
                    swapUsdValue: quote.swapUsdValueMicro === null ? null : microToUsdString(quote.swapUsdValueMicro),
                    route: quote.routePlan.map((h) => ({ venue: h.ammLabel, percent: h.percent })),
                    contextSlot: quote.contextSlot,
                    retrievedAtMs: quote.retrievedAtMs,
                    expiresAtMs: quote.expiresAtMs,
                    ageSeconds: Math.max(0, Math.round((now - quote.retrievedAtMs) / 1000)),
                    expired: now >= quote.expiresAtMs,
                    source: quote.source,
                    // Stated plainly: the expiry is our policy, not the provider's.
                    freshnessPolicy: "Quote expiry is set by Moonpaper; Jupiter does not return one.",
                },
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    /**
     * Point-in-time production eligibility check for one mint and one USDC size.
     * Every required gate is evaluated server-side so a client cannot weaken the
     * liquidity, freshness, authority, or price-impact policy.
     */
    app.get("/v1/tradability/:mint", async (req, res) => {
        try {
            const q = z
                .object({
                amountUsd: z.string().min(1).max(32).default("100"),
                slippageBps: z.coerce.number().int().min(1).max(5_000).default(50),
            })
                .safeParse(req.query);
            if (!q.success) {
                throw new ArbError("VALIDATION_ERROR", "Invalid tradability-check parameters", 400, {
                    issues: q.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
                });
            }
            const abort = new AbortController();
            req.on("close", () => abort.abort());
            const check = await tradability.check(req.params.mint, q.data.amountUsd, BigInt(q.data.slippageBps), abort.signal);
            res.json(serializeTradability(check, deps.clock()));
        }
        catch (err) {
            fail(res, err);
        }
    });
    app.get("/v1/research/:mint", async (req, res) => {
        try {
            const abort = new AbortController();
            req.on("close", () => abort.abort());
            const profile = await deps.research.getProfile(req.params.mint, abort.signal);
            const snapshot = snapshotFromResearch(profile, deps.clock(), {
                maxMarketAgeMs: tradabilityPolicy.maxMarketAgeMs,
            });
            const risk = assessRisk(snapshot, {
                minLiquidityUsdMicro: tradabilityPolicy.minLiquidityUsdMicro,
                maxPriceImpactBps: tradabilityPolicy.maxPriceImpactBps,
            });
            res.json({
                ...meta(deps),
                ...serializeProfile(profile),
                // Added ALONGSIDE the existing `risk` field rather than replacing it.
                // The two models disagree by construction — v3 refuses to treat missing
                // evidence as safe — so swapping them silently would change what every
                // existing consumer sees without anyone deciding to. Consumers migrate
                // deliberately; the old field is removed once nothing reads it.
                riskV3: serializeRiskAssessment(risk),
                evidence: serializeEvidenceSummary(snapshot),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    // ---- Discover ----
    const opportunitiesQuery = z.object({
        tradeSizeSol: z.coerce.number().positive().max(1_000).optional(),
        risk: z.enum(["low", "medium", "high"]).optional(),
        minLiquidityUsd: z.coerce.number().min(0).optional(),
        search: z.string().max(80).optional(),
    });
    app.get("/v1/opportunities", async (req, res) => {
        try {
            const q = opportunitiesQuery.safeParse(req.query);
            if (!q.success) {
                throw new ArbError("VALIDATION_ERROR", "Invalid query parameters", 400, {
                    issues: q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
                });
            }
            const settings = deps.settings.get();
            const tradeSizeSol = q.data.tradeSizeSol ?? settings.defaultTradeSizeSol;
            const scored = await collectScoredTokens(deps, tradeSizeSol);
            const riskRank = { low: 0, medium: 1, high: 2 };
            let items = scored;
            if (q.data.risk) {
                items = items.filter((s) => riskRank[s.scores.riskLevel] <= riskRank[q.data.risk]);
            }
            if (q.data.minLiquidityUsd !== undefined) {
                const min = BigInt(Math.round(q.data.minLiquidityUsd)) * 1000000n;
                items = items.filter((s) => s.view.liquidity.value.totalUsdMicro >= min);
            }
            if (q.data.search) {
                const needle = q.data.search.toLowerCase();
                items = items.filter((s) => s.view.token.symbol.toLowerCase().includes(needle) ||
                    s.view.token.name.toLowerCase().includes(needle) ||
                    s.view.token.mint.toLowerCase().includes(needle));
            }
            items.sort((a, b) => b.scores.opportunity.score - a.scores.opportunity.score);
            res.json({
                ...meta(deps),
                tradeSizeSol,
                count: items.length,
                opportunities: items.map(({ view, routes, scores }) => {
                    const m = view.momentum.value;
                    return {
                        token: {
                            mint: view.token.mint,
                            symbol: view.token.symbol,
                            name: view.token.name,
                            emoji: view.token.emoji,
                            ageDays: view.risk.value.tokenAgeDays,
                        },
                        priceUsd: picoUsdToPriceString(m.pricePicoUsd),
                        change1hPct: pctStr(m.change1hBps),
                        change24hPct: pctStr(m.change24hBps),
                        volume1hUsd: microToUsdString(m.volume1hUsdMicro),
                        volumeChange1hPct: pctStr(m.volumeChange1hBps),
                        liquidityUsd: microToUsdString(view.liquidity.value.totalUsdMicro),
                        dataAgeSeconds: Math.round(view.momentum.ageMs / 1000),
                        dataReliability: view.momentum.reliability,
                        scores: {
                            momentum: scores.momentum.score,
                            liquidity: scores.liquidity.score,
                            execution: scores.execution.score,
                            risk: scores.risk.score,
                            opportunity: scores.opportunity.score,
                        },
                        riskLevel: scores.riskLevel,
                        opportunityLabel: scores.opportunityLabel,
                        whyRanks: scores.opportunity.factors.slice(0, 4),
                        bestRoute: routes.best
                            ? { venueName: routes.best.venueName, priceImpactPct: pctStr(routes.best.priceImpactBps) }
                            : null,
                        routeFailureCount: routes.failures.length,
                        // Already fetched for scoring, so surfacing it costs no extra call.
                        verification: view.risk.value.onChainVerification
                            ? {
                                status: view.risk.value.onChainVerification.status,
                                live: view.risk.value.onChainVerification.status === "verified",
                            }
                            : null,
                        inWatchlist: settings.watchlist.includes(view.token.mint),
                    };
                }),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    // ---- Evaluate ----
    app.get("/v1/tokens/:mint", async (req, res) => {
        try {
            const settings = deps.settings.get();
            const tradeSizeSol = z.coerce.number().positive().max(1_000).default(settings.defaultTradeSizeSol).parse(req.query.tradeSizeSol ?? settings.defaultTradeSizeSol);
            const { view, routes, scores } = await scoreToken(deps, req.params.mint, tradeSizeSol, settings);
            const m = view.momentum.value;
            const candles = await deps.market.getCandles(view.token.mint, 48, 30 * 60_000);
            // Round-trip estimate: what the tokens from the best buy would sell for now
            let roundTrip = null;
            if (routes.best) {
                const sell = await deps.market.getSellRoutes(view.token.mint, routes.best.outAmount, BigInt(settings.maxSlippageBps));
                if (sell.best) {
                    roundTrip = {
                        tokensOut: tokenUnitsToDisplay(routes.best.outAmount, view.token.decimals),
                        estimatedSellBackSol: lamportsToSolString(sell.best.outAmount),
                        sellVenue: sell.best.venueName,
                        sellImpactPct: pctStr(sell.best.priceImpactBps),
                    };
                }
            }
            res.json({
                ...meta(deps),
                tradeSizeSol,
                token: { ...view.token },
                market: {
                    priceUsd: picoUsdToPriceString(m.pricePicoUsd),
                    change5mPct: pctStr(m.change5mBps),
                    change1hPct: pctStr(m.change1hBps),
                    change24hPct: pctStr(m.change24hBps),
                    volume1hUsd: microToUsdString(m.volume1hUsdMicro),
                    volumeChange1hPct: pctStr(m.volumeChange1hBps),
                    buySellRatio: (Number(m.buySellRatioPct) / 100).toFixed(2),
                    txCount1h: m.txCount1h,
                    liquidityUsd: microToUsdString(view.liquidity.value.totalUsdMicro),
                    liquidityChange1hPct: pctStr(view.liquidity.value.change1hBps),
                    topPoolSharePct: pctStr(view.liquidity.value.topPoolShareBps),
                    solPriceUsd: microToUsdString(view.solPriceMicroUsd),
                },
                riskFacts: {
                    tokenAgeDays: view.risk.value.tokenAgeDays,
                    holderConcentrationPct: pctStr(view.risk.value.holderConcentrationBps),
                    mintAuthorityRevoked: view.risk.value.mintAuthorityRevoked,
                    freezeAuthorityRevoked: view.risk.value.freezeAuthorityRevoked,
                    recentInsiderActivity: view.risk.value.recentInsiderActivity,
                    dataComplete: view.risk.value.dataComplete,
                    // Live mode only: which fields are chain-verified vs simulated.
                    onChainVerification: view.risk.value.onChainVerification ?? null,
                    fieldSources: serializeFieldSources(view.risk.fieldSources),
                },
                freshness: [
                    { field: "momentum", source: view.momentum.source, ageSeconds: Math.round(view.momentum.ageMs / 1000), reliability: view.momentum.reliability },
                    { field: "liquidity", source: view.liquidity.source, ageSeconds: Math.round(view.liquidity.ageMs / 1000), reliability: view.liquidity.reliability },
                    { field: "risk", source: view.risk.source, ageSeconds: Math.round(view.risk.ageMs / 1000), reliability: view.risk.reliability },
                ],
                scores: serializeScores(scores),
                routes: serializeComparison(routes, view.token.decimals),
                roundTrip,
                candles: candles.map((c) => ({
                    t: c.tsMs,
                    // Display-only float for charting; never used in calculations
                    price: Number(c.closePicoUsd) / 1e12,
                    volumeUsd: Number(c.volumeUsdMicro / 1000000n),
                })),
                inWatchlist: settings.watchlist.includes(view.token.mint),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    // ---- Compare execution ----
    app.get("/v1/tokens/:mint/routes", async (req, res) => {
        try {
            const settings = deps.settings.get();
            const q = z
                .object({
                tradeSizeSol: z.coerce.number().positive().max(1_000).default(settings.defaultTradeSizeSol),
                slippageBps: z.coerce.number().int().min(1).max(2_000).default(settings.maxSlippageBps),
            })
                .parse(req.query);
            const view = await deps.market.getView(req.params.mint);
            const lamports = solToLamports(q.tradeSizeSol);
            const routes = await deps.market.getBuyRoutes(view.token.mint, lamports, BigInt(q.slippageBps));
            if (!routes.best) {
                throw new ArbError("NO_QUOTE_AVAILABLE", "No venue returned an executable quote for this size", 502, {
                    failures: routes.failures,
                });
            }
            res.json({
                ...meta(deps),
                tradeSizeSol: q.tradeSizeSol,
                slippagePct: pctStr(q.slippageBps),
                routes: serializeComparison(routes, view.token.decimals),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    // ---- Paper trade ----
    const openSchema = z.object({
        tokenMint: z.string().min(32).max(64),
        solAmount: z.number().positive().max(1_000),
        slippageBps: z.number().int().min(1).max(2_000).optional(),
    });
    app.post("/v1/paper/positions", async (req, res) => {
        try {
            const parsed = openSchema.safeParse(req.body);
            if (!parsed.success) {
                throw new ArbError("VALIDATION_ERROR", "Invalid paper-trade request", 400, {
                    issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
                });
            }
            const settings = deps.settings.get();
            const position = await deps.engine.openPosition({
                tokenMint: parsed.data.tokenMint,
                solAmountLamports: solToLamports(parsed.data.solAmount),
                slippageBps: BigInt(parsed.data.slippageBps ?? settings.maxSlippageBps),
                limits: limitsFrom(settings),
            });
            res.status(201).json({
                simulated: true,
                notice: "Simulated trade only — no funds moved, no transaction sent.",
                position: serializePosition(position),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    app.post("/v1/paper/positions/:id/close", async (req, res) => {
        try {
            const position = await deps.engine.closePosition(req.params.id);
            res.json({
                simulated: true,
                notice: "Simulated close — valued at the current executable sell quote including impact, fees, and slippage.",
                position: serializePosition(position),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    app.get("/v1/paper/portfolio", async (_req, res) => {
        try {
            const portfolio = await deps.engine.getPortfolio();
            res.json(serializePortfolio(portfolio));
        }
        catch (err) {
            fail(res, err);
        }
    });
    // ---- Notifications ----
    app.get("/v1/notifications", (_req, res) => {
        res.json({
            unread: deps.notify.unreadCount(),
            notifications: deps.notify.list(),
        });
    });
    app.post("/v1/notifications/mark-read", (_req, res) => {
        deps.notify.markAllRead();
        res.json({ ok: true });
    });
    // ---- Settings & watchlist ----
    app.get("/v1/settings", (_req, res) => {
        res.json({ settings: deps.settings.get() });
    });
    app.put("/v1/settings", (req, res) => {
        try {
            const patch = settingsSchema.partial().safeParse(req.body);
            if (!patch.success) {
                throw new ArbError("VALIDATION_ERROR", "Invalid settings", 400, {
                    issues: patch.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
                });
            }
            res.json({ settings: deps.settings.update(patch.data) });
        }
        catch (err) {
            fail(res, err);
        }
    });
    /**
     * A token's recorded history.
     *
     * Answers "what was this like an hour ago?". Public and read-only, like the
     * rest of the research surface. Degrades to an explained empty series when
     * persistence is absent rather than pretending the token has no past.
     */
    app.get("/v1/tokens/:mint/history", async (req, res) => {
        try {
            const mint = req.params.mint;
            if (!deps.db) {
                res.json({ mint, available: false, reason: "Persistence is not configured.", points: [] });
                return;
            }
            const parsed = z
                .object({
                limit: z.coerce.number().int().min(1).max(500).default(200),
                sinceMs: z.coerce.number().int().min(0).optional(),
            })
                .safeParse(req.query);
            if (!parsed.success) {
                throw new ArbError("VALIDATION_ERROR", "Invalid history query", 400);
            }
            const history = new TokenHistoryRepository(deps.db);
            const now = deps.clock();
            const points = parsed.data.sinceMs
                ? await history.between(mint, parsed.data.sinceMs, now)
                : await history.list(mint, parsed.data.limit);
            res.json({
                mint,
                available: true,
                count: points.length,
                notice: "Older points are downsampled: every observation for the last 6 hours, then hourly, then daily. Each point is a real observation, never an average.",
                points: points.map((p) => ({
                    observedAt: new Date(p.observedAtMs).toISOString(),
                    resolution: p.resolution,
                    riskScore: p.riskScore,
                    riskConfidence: p.riskConfidence,
                    riskModelVersion: p.riskModelVersion,
                    priceUsd: p.pricePicoUsd === null ? null : picoUsdToPriceString(p.pricePicoUsd),
                    liquidityUsd: p.liquidityUsdMicro === null ? null : microToUsdString(p.liquidityUsdMicro),
                    marketCapUsd: p.marketCapUsdMicro === null ? null : microToUsdString(p.marketCapUsdMicro),
                    walletConcentrationPct: p.walletConcentrationBps === null ? null : pctStr(p.walletConcentrationBps),
                    mintAuthorityRevoked: p.mintAuthorityRevoked,
                    freezeAuthorityRevoked: p.freezeAuthorityRevoked,
                })),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    /**
     * Why a token's risk moved.
     *
     * Compares the current assessment against the recorded observation in force
     * at `sinceMs`. Deterministic: the explanation is derived from stored facts,
     * never narrated.
     */
    app.get("/v1/tokens/:mint/risk-change", async (req, res) => {
        try {
            const mint = req.params.mint;
            const parsed = z
                .object({ sinceMs: z.coerce.number().int().min(0).optional() })
                .safeParse(req.query);
            if (!parsed.success)
                throw new ArbError("VALIDATION_ERROR", "Invalid risk-change query", 400);
            const now = deps.clock();
            const sinceMs = parsed.data.sinceMs ?? now - 3_600_000;
            if (!deps.db) {
                res.json({ mint, available: false, reason: "Persistence is not configured." });
                return;
            }
            const past = await new TokenHistoryRepository(deps.db).asOf(mint, sinceMs);
            if (!past || past.riskScore === null || past.riskModelVersion === null) {
                res.json({
                    mint,
                    available: false,
                    reason: "No recorded observation at or before that time to compare against.",
                });
                return;
            }
            const abort = new AbortController();
            req.on("close", () => abort.abort());
            const profile = await deps.research.getProfile(mint, abort.signal);
            const current = assessRisk(snapshotFromResearch(profile, now, { maxMarketAgeMs: tradabilityPolicy.maxMarketAgeMs }), {
                minLiquidityUsdMicro: tradabilityPolicy.minLiquidityUsdMicro,
                maxPriceImpactBps: tradabilityPolicy.maxPriceImpactBps,
            });
            // A stored row keeps the score and version but not the factor breakdown,
            // so the comparison is at score level. Reconstructing factors from a
            // summary row would be inventing detail that was never recorded.
            const change = explainRiskChange({
                riskScore: past.riskScore,
                riskConfidence: past.riskConfidence ?? 0,
                riskLevel: past.riskScore >= 45 ? "high" : past.riskScore >= 20 ? "medium" : "low",
                riskModelVersion: past.riskModelVersion,
                factors: [],
                missingEvidence: [],
                observedAt: past.observedAtMs,
            }, current);
            res.json({
                mint,
                available: true,
                comparedAgainst: new Date(past.observedAtMs).toISOString(),
                change: {
                    ...change,
                    previousObservedAt: new Date(change.previousObservedAt).toISOString(),
                    currentObservedAt: new Date(change.currentObservedAt).toISOString(),
                },
                summary: formatRiskChange(change),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    /**
     * Provider diagnostics.
     *
     * Protected by ADMIN_TOKEN, because operational detail about which provider
     * is failing is not something to publish. Returns 404 rather than 401 when
     * no token is configured, so the endpoint's existence is not advertised on a
     * deployment that never enabled it.
     *
     * Contains no secrets by construction: the registry is keyed by provider id
     * and outcome, never by URL, credential, token, or user input.
     */
    app.get("/admin/metrics", (req, res) => {
        const adminToken = deps.env.ADMIN_TOKEN;
        if (!adminToken || req.headers["x-admin-token"] !== adminToken) {
            res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
            return;
        }
        res.json({
            notice: "Counters describe this serverless instance since it started, not a global total. Instances recycle.",
            ...metrics.snapshot(),
        });
    });
    /**
     * The auto-watch shelf: tokens that graduated out of discovery.
     *
     * Public and read-only. The shelf is system-owned, derived from global
     * market data, and says nothing about any individual — so it is not behind
     * auth, and it is deliberately separate from a user's own watchlist.
     */
    app.get("/v1/auto-watch", async (_req, res) => {
        try {
            if (!deps.db) {
                // Degrades like every other persistence-backed feature: the feed still
                // hides graduated tokens, because that check is pure.
                res.json({
                    available: false,
                    reason: "Persistence is not configured, so the shelf is not recorded.",
                    items: [],
                    criteria: {
                        qualityScore: GRADUATION_QUALITY_SCORE,
                        maturityDays: Math.round(GRADUATION_MATURITY_MS / 86_400_000),
                    },
                });
                return;
            }
            const items = await new AutoWatchRepository(deps.db).list();
            res.json({
                available: true,
                count: items.length,
                criteria: {
                    qualityScore: GRADUATION_QUALITY_SCORE,
                    maturityDays: Math.round(GRADUATION_MATURITY_MS / 86_400_000),
                },
                notice: "Tokens here left the discovery feed because they are established or already scored well. This is research context, not a recommendation.",
                items: items.map((item) => ({
                    mint: item.tokenMint,
                    symbol: item.symbol,
                    name: item.name,
                    reason: item.reason,
                    reasonLabel: item.reason === "market_maturity"
                        ? `Trading for ${Math.round(GRADUATION_MATURITY_MS / 86_400_000)}+ days`
                        : `Quality score reached ${GRADUATION_QUALITY_SCORE}`,
                    qualityScore: item.qualityScore,
                    riskScore: item.riskScore,
                    scoreVersion: item.scoreVersion,
                    promotedAt: new Date(item.firstPromotedAtMs).toISOString(),
                    lastSeenAt: new Date(item.lastSeenAtMs).toISOString(),
                })),
            });
        }
        catch (err) {
            fail(res, err);
        }
    });
    app.post("/v1/watchlist", async (req, res) => {
        try {
            const parsed = z.object({ mint: z.string().min(32).max(64), watched: z.boolean() }).safeParse(req.body);
            if (!parsed.success) {
                throw new ArbError("VALIDATION_ERROR", "Invalid watchlist request", 400);
            }
            await deps.market.getView(parsed.data.mint); // 404 for unsupported mints
            const current = deps.settings.get().watchlist;
            const next = parsed.data.watched
                ? [...new Set([...current, parsed.data.mint])]
                : current.filter((m) => m !== parsed.data.mint);
            res.json({ settings: deps.settings.update({ watchlist: next }) });
        }
        catch (err) {
            fail(res, err);
        }
    });
    // ---- Accounts and per-user state ----
    // Mounted unconditionally and resolved per request, so persistence can come
    // back without a redeploy and a missing database yields an explicit 503
    // rather than a 404 or an opaque 500.
    app.use(createAuthRouter({
        getAuth: () => deps.auth,
        getDb: () => deps.db,
        getAccountLifecycle: () => deps.accountLifecycle,
        createPaperTrading: (db) => new LivePaperTradingService(db, tradability, deps.quotes, {
            startingMicroUsd: usdToMicroUsd(deps.env.PAPER_STARTING_USD),
            minTradeMicroUsd: usdToMicroUsd(deps.env.PAPER_MIN_TRADE_USD),
            maxTradeMicroUsd: usdToMicroUsd(deps.env.PAPER_MAX_TRADE_USD),
            maxOpenPositions: deps.env.PAPER_MAX_OPEN_POSITIONS,
            maxEntryPriceImpactBps: BigInt(deps.env.TRADABILITY_MAX_PRICE_IMPACT_BPS),
        }, deps.clock),
        startingMicroUsd: usdToMicroUsd(deps.env.PAPER_STARTING_USD),
        clock: deps.clock,
        rateLimits: {
            authAttempts: deps.env.AUTH_RATE_LIMIT_ATTEMPTS,
            authWindowMs: deps.env.AUTH_RATE_LIMIT_WINDOW_MS,
            authNetworkAttempts: deps.env.AUTH_RATE_LIMIT_NETWORK_ATTEMPTS,
            paperAttempts: deps.env.PAPER_RATE_LIMIT_ATTEMPTS,
            paperWindowMs: deps.env.PAPER_RATE_LIMIT_WINDOW_MS,
            integrationAttempts: deps.env.INTEGRATION_RATE_LIMIT_ATTEMPTS,
            integrationWindowMs: deps.env.INTEGRATION_RATE_LIMIT_WINDOW_MS,
        },
        ...(deps.env.OWNER_API_KEY
            ? { ownerAccess: { apiKey: deps.env.OWNER_API_KEY } }
            : {}),
        secureCookies: deps.env.COOKIE_SECURE,
        emailVerificationRequired: deps.env.EMAIL_VERIFICATION_REQUIRED,
    }));
    // ---- Legacy arbitrage calculator (original add-on, kept working) ----
    app.use(createLegacyArbitrageRouter(deps.env.QUOTE_MODE === "mock", deps.env.ADMIN_TOKEN));
    // ---- Static frontends ----
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    // maxAge 0 + etag: the browser may cache, but must revalidate every time.
    // Without this it heuristically caches app.js and serves a stale build
    // after a deploy, which is indistinguishable from a broken release.
    const staticOptions = { maxAge: 0, etag: true, lastModified: true, extensions: ["html"] };
    app.use("/demo", express.static(join(rootDir, "demo"), staticOptions));
    app.use("/", express.static(join(rootDir, "web"), staticOptions));
    return app;
}
export function seedIfDemo(deps) {
    if (deps.market.bundle.isDemo) {
        seedDemoState(deps.engine, deps.notify, deps.clock());
    }
}
