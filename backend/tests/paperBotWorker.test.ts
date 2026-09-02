import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPaperBotPass } from "../src/bot/worker.js";
import type { PaperBotStrategyConfig } from "../src/bot/types.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import {
  LivePaperPositionRepository,
  PaperBotConfigRepository,
  PaperBotDecisionRepository,
  PaperBotPositionStateRepository,
} from "../src/db/repositories.js";
import type { LiveFeedResult, LiveFeedToken } from "../src/market/jupiter/liveFeed.js";
import type { NormalizedSwapQuote, QuoteProvider, QuoteRequest } from "../src/market/jupiter/quotes.js";
import type { ResearchProfile, ResearchService } from "../src/market/research.js";
import { TradabilityService, USDC_MINT } from "../src/market/tradability.js";
import type { TokenSearchResult } from "../src/market/types.js";
import { LivePaperTradingService } from "../src/paper/livePaper.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
let db: SqlClient;
let now: number;
let userId: string;
let exitValue: bigint;

const market = () => ({
  priceUsdPico: 1_000_000n,
  liquidityUsdMicro: 2_000_000_000_000n,
  marketCapUsdMicro: 1_000_000_000_000n,
  fdvUsdMicro: 1_200_000_000_000n,
  holderCount: 10_000,
  change1hBps: 500n,
  change24hBps: 1_000n,
  buyVolume24hUsdMicro: 1_000_000_000_000n,
  sellVolume24hUsdMicro: 800_000_000_000n,
  numBuys24h: 1_000,
  numSells24h: 800,
  topHolderPctBps: 1_000n,
  organicScore: 100,
  organicScoreLabel: "high" as const,
});

function token(mint = MINT): TokenSearchResult {
  return {
    mint,
    symbol: mint === USDC_MINT ? "USDC" : "BOT",
    name: mint === USDC_MINT ? "USD Coin" : "Bot Candidate",
    decimals: 6,
    firstPoolAtMs: now - 86_400_000,
    marketUpdatedAtMs: now - 5_000,
    tokenProgram: TOKEN_PROGRAM,
    iconUrl: null,
    verifiedByProvider: true,
    tags: [],
    source: "jupiter:tokens-v2",
    market: market(),
    providerClaims: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
  };
}

function profile(): ResearchProfile {
  return {
    mint: MINT,
    symbol: "BOT",
    name: "Bot Candidate",
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM,
    iconUrl: null,
    tags: [],
    verifiedByProvider: true,
    identitySource: "jupiter:tokens-v2",
    marketSource: "jupiter:tokens-v2",
    marketUpdatedAtMs: now - 5_000,
    market: market(),
    verification: { status: "verified", source: "solana-rpc:mainnet", checkedAtMs: now },
    authorities: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      source: "solana-rpc:mainnet",
      providerAgreement: "agrees",
    },
    risk: { score: 5, level: "low", factors: [], method: "test" },
    simulation: { available: false, reason: "paper bot test" },
    fetchedAtMs: now,
  };
}

function feedToken(): LiveFeedToken {
  const window = {
    priceChangeBps: 500n,
    liquidityChangeBps: 0n,
    volumeChangeBps: 1_000n,
    buyVolumeUsdMicro: 120_000_000_000n,
    sellVolumeUsdMicro: 80_000_000_000n,
    buys: 300,
    sells: 200,
    traders: 200,
  };
  return {
    token: token(),
    firstPoolAtMs: now - 86_400_000,
    updatedAtMs: now - 5_000,
    launchpad: null,
    fiveMinutes: window,
    oneHour: window,
    twentyFourHours: window,
  };
}

function quote(req: QuoteRequest): NormalizedSwapQuote {
  const entry = req.inputMint === USDC_MINT;
  return {
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    inAmount: req.amount,
    outAmount: entry ? 1_010_000_000n : exitValue + 1_000_000n,
    minOutAmount: entry ? 1_000_000_000n : exitValue,
    slippageBps: req.slippageBps,
    priceImpactBps: 25n,
    routePlan: [{
      ammLabel: "Test AMM",
      ammKey: "amm",
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      percent: 100,
      inAmount: null,
      outAmount: null,
      updateContextSlot: null,
    }],
    swapUsdValueMicro: entry ? req.amount : exitValue,
    contextSlot: 1,
    swapMode: "ExactIn",
    retrievedAtMs: now,
    expiresAtMs: now + 20_000,
    platformFee: null,
    source: "jupiter:quote-v1",
    apiVersion: "v1" as const,
    providerLatencyMs: null,
    providerRequestId: null,
    instructionVersion: null,
  };
}

const strategy: PaperBotStrategyConfig = {
  tradeSizeMicroUsd: 500_000_000n,
  minQualityScore: 70,
  maxRiskScore: 30,
  minLiquidityMicroUsd: 250_000_000_000n,
  maxPriceImpactBps: 100n,
  slippageBps: 50n,
  maxOpenPositions: 3,
  takeProfitBps: 1_500n,
  stopLossBps: 800n,
  trailingStopBps: 1_000n,
  maxHoldMinutes: 360,
  cooldownMinutes: 60,
};

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  now = 1_760_000_000_000;
  exitValue = 520_000_000n;
  const users = await db.query<{ id: string }>(
    "insert into users (email, password_hash) values ('bot@example.com', 'scrypt$x') returning id",
  );
  userId = String(users[0]!.id);
});

afterEach(async () => db.close());

describe("paper-bot worker", () => {
  it("opens and later closes a simulated position with a durable decision trail", async () => {
    const configs = new PaperBotConfigRepository(db);
    await configs.ensureDefault(userId, now);
    const config = await configs.save(userId, true, strategy, now);
    const quoteProvider: QuoteProvider = { source: "test", getQuote: async (req) => quote(req) };
    const research = {
      getProfile: async () => profile(),
      resolveToken: async (mint: string) => token(mint),
      search: async () => [token()],
    } as unknown as ResearchService;
    const tradability = new TradabilityService(
      research,
      quoteProvider,
      { minLiquidityUsdMicro: 10_000_000_000n, maxPriceImpactBps: 300n, maxMarketAgeMs: 300_000 },
      () => now,
    );
    const paper = () =>
      new LivePaperTradingService(
        db,
        tradability,
        quoteProvider,
        {
          startingMicroUsd: 100_000_000_000n,
          minTradeMicroUsd: 10_000_000n,
          maxTradeMicroUsd: 10_000_000_000n,
          maxOpenPositions: 25,
          maxEntryPriceImpactBps: 300n,
        },
        () => now,
      );
    const feed = {
      getFeed: async (): Promise<LiveFeedResult> => ({
        kind: "trending",
        source: "jupiter:tokens-v2",
        fetchedAtMs: now,
        reliability: "fresh",
        tokens: [feedToken()],
      }),
    };
    const deps = {
      configs,
      positions: new LivePaperPositionRepository(db),
      states: new PaperBotPositionStateRepository(db),
      decisions: new PaperBotDecisionRepository(db),
      feed,
      quotes: quoteProvider,
      createPaperTrading: paper,
      maxMarketAgeMs: 300_000,
      clock: () => now,
    };

    const opened = await runPaperBotPass(deps);
    expect(opened.positionsOpened).toBe(1);
    const storedOpen = await db.query<{ opened_by: string; bot_config_id: string }>(
      "select opened_by, bot_config_id from paper_positions",
    );
    expect(storedOpen[0]).toMatchObject({ opened_by: "paper_bot", bot_config_id: config.id });

    now += 60_000;
    exitValue = 600_000_000n;
    const closed = await runPaperBotPass(deps);
    expect(closed.positionsClosed).toBe(1);
    const rows = await db.query<{ status: string; realized_pnl_micro_usd: string }>(
      "select status, realized_pnl_micro_usd from paper_positions",
    );
    expect(rows[0]).toMatchObject({ status: "closed", realized_pnl_micro_usd: "100000000" });
    const decisions = await new PaperBotDecisionRepository(db).listForUser(userId);
    expect(decisions.map((decision) => decision.action)).toEqual(["closed", "opened"]);
    expect(decisions[0]!.reason).toMatch(/take profit/i);

    // Account deletion removes the portfolio, bot config, state, and audit
    // rows in one statement without leaving a broken cross-table reference.
    await db.query("delete from users where id = $1", [userId]);
    expect(await db.query("select id from paper_bot_configs")).toHaveLength(0);
    expect(await db.query("select id from paper_positions")).toHaveLength(0);
    expect(await db.query("select id from paper_bot_decisions")).toHaveLength(0);
  });

  it("does nothing until the user explicitly enables the bot", async () => {
    await new PaperBotConfigRepository(db).ensureDefault(userId, now);
    const summary = await runPaperBotPass({
      configs: new PaperBotConfigRepository(db),
      positions: new LivePaperPositionRepository(db),
      states: new PaperBotPositionStateRepository(db),
      decisions: new PaperBotDecisionRepository(db),
      feed: { getFeed: async () => { throw new Error("must not fetch"); } },
      quotes: { getQuote: async () => { throw new Error("must not quote"); } },
      createPaperTrading: () => { throw new Error("must not construct"); },
      maxMarketAgeMs: 300_000,
      clock: () => now,
    });
    expect(summary.configsProcessed).toBe(0);
    expect(summary.providerFailures).toBe(0);
  });
});
