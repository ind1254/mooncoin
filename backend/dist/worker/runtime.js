import { usdToMicro } from "../core/money.js";
import { createPgClient } from "../db/pgClient.js";
import { AlertEventRepository, AlertRuleRepository, AlertRuleStateRepository, LivePaperPositionRepository, PaperBotConfigRepository, PaperBotDecisionRepository, PaperBotPositionStateRepository, TokenObservationRepository, WorkerLeaseRepository, AutoWatchRepository, } from "../db/repositories.js";
import { JupiterLiveFeedProvider } from "../market/jupiter/liveFeed.js";
import { TokenHistoryRepository } from "../db/tokenHistory.js";
import { JupiterQuoteProvider } from "../market/jupiter/quotes.js";
import { JupiterTokenSearchProvider } from "../market/jupiter/tokenSearch.js";
import { ResearchService } from "../market/research.js";
import { SolanaRpcClient } from "../market/solana/rpc.js";
import { TradabilityService } from "../market/tradability.js";
import { LivePaperTradingService } from "../paper/livePaper.js";
import { runScheduledWorkerPass } from "./pass.js";
/** Build the provider and repository graph shared by Vercel Cron and local development. */
export function createScheduledWorkerRuntime(env, options = {}) {
    if (!env.DATABASE_URL && !options.db) {
        throw new Error("Scheduled worker requires DATABASE_URL.");
    }
    const clock = options.clock ?? Date.now;
    const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
    const ownsDb = !options.db;
    const db = options.db ?? createPgClient({ connectionString: env.DATABASE_URL, maxConnections: 2 });
    const research = new ResearchService(new JupiterTokenSearchProvider({
        baseUrl: env.JUPITER_TOKENS_URL,
        ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
        clock,
    }), new SolanaRpcClient({ endpoint: env.SOLANA_RPC_URL, commitment: "confirmed" }), { clock, mintCacheTtlMs: env.MINT_CACHE_TTL_MS });
    const quotes = new JupiterQuoteProvider({
        baseUrl: env.JUPITER_QUOTE_URL,
        ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
        clock,
    });
    const liveFeed = new JupiterLiveFeedProvider({
        baseUrl: env.JUPITER_TOKENS_URL,
        ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
        clock,
    });
    const tradability = new TradabilityService(research, quotes, {
        minLiquidityUsdMicro: usdToMicro(env.TRADABILITY_MIN_LIQUIDITY_USD),
        maxPriceImpactBps: BigInt(env.TRADABILITY_MAX_PRICE_IMPACT_BPS),
        maxMarketAgeMs: env.TRADABILITY_MAX_MARKET_AGE_MS,
    }, clock);
    const paperConfig = {
        startingMicroUsd: usdToMicro(env.PAPER_STARTING_USD),
        minTradeMicroUsd: usdToMicro(env.PAPER_MIN_TRADE_USD),
        maxTradeMicroUsd: usdToMicro(env.PAPER_MAX_TRADE_USD),
        maxOpenPositions: env.PAPER_MAX_OPEN_POSITIONS,
        maxEntryPriceImpactBps: BigInt(env.TRADABILITY_MAX_PRICE_IMPACT_BPS),
    };
    const scheduledDeps = {
        alerts: {
            research,
            rules: new AlertRuleRepository(db),
            states: new AlertRuleStateRepository(db),
            events: new AlertEventRepository(db),
            observations: new TokenObservationRepository(db),
            clock,
            log,
        },
        bot: {
            configs: new PaperBotConfigRepository(db),
            positions: new LivePaperPositionRepository(db),
            states: new PaperBotPositionStateRepository(db),
            decisions: new PaperBotDecisionRepository(db),
            feed: liveFeed,
            quotes,
            createPaperTrading: () => new LivePaperTradingService(db, tradability, quotes, paperConfig, clock),
            maxMarketAgeMs: env.TRADABILITY_MAX_MARKET_AGE_MS,
            clock,
            log,
        },
        graduation: {
            getFeed: (kind) => liveFeed.getFeed(kind),
            autoWatch: new AutoWatchRepository(db),
            policy: {
                minLiquidityUsdMicro: usdToMicro(env.TRADABILITY_MIN_LIQUIDITY_USD),
                maxPriceImpactBps: BigInt(env.TRADABILITY_MAX_PRICE_IMPACT_BPS),
                maxMarketAgeMs: env.TRADABILITY_MAX_MARKET_AGE_MS,
            },
            clock,
        },
        history: {
            getFeed: (kind) => liveFeed.getFeed(kind),
            history: new TokenHistoryRepository(db),
            policy: {
                minLiquidityUsdMicro: usdToMicro(env.TRADABILITY_MIN_LIQUIDITY_USD),
                maxPriceImpactBps: BigInt(env.TRADABILITY_MAX_PRICE_IMPACT_BPS),
                maxMarketAgeMs: env.TRADABILITY_MAX_MARKET_AGE_MS,
            },
            clock,
        },
        leases: new WorkerLeaseRepository(db),
        clock,
        log,
    };
    return {
        run: (runKey) => runScheduledWorkerPass(scheduledDeps, runKey),
        close: async () => {
            if (ownsDb)
                await db.close();
        },
    };
}
