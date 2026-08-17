import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { ArbError } from "../src/core/errors.js";
import type { NormalizedSwapQuote, QuoteProvider } from "../src/market/jupiter/quotes.js";
import type { ResearchProfile, ResearchService } from "../src/market/research.js";
import {
  TradabilityService,
  USDC_MINT,
  type TradabilityPolicy,
  type TradabilityResearch,
} from "../src/market/tradability.js";
import type { TokenSearchResult } from "../src/market/types.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OTHER_BONK = "HhJpBhRRn4gLeQy6yQxDfBUWZq6ZGc1H1pVj7BcMpump";
const NOW = Date.parse("2026-08-17T21:00:00Z");
const policy: TradabilityPolicy = {
  minLiquidityUsdMicro: 10_000n * 1_000_000n,
  maxPriceImpactBps: 300n,
  maxMarketAgeMs: 300_000,
};

const market = (liquidityUsdMicro: bigint | null = 250_000n * 1_000_000n) => ({
  priceUsdPico: 12_000_000n,
  liquidityUsdMicro,
  marketCapUsdMicro: 1_000_000n * 1_000_000n,
  fdvUsdMicro: 1_200_000n * 1_000_000n,
  holderCount: 10_000,
  change1hBps: 100n,
  change24hBps: 250n,
  buyVolume24hUsdMicro: 500_000n * 1_000_000n,
  sellVolume24hUsdMicro: 400_000n * 1_000_000n,
  numBuys24h: 1_000,
  numSells24h: 900,
  topHolderPctBps: 1_500n,
  organicScore: 75,
  organicScoreLabel: "high",
});

const token = (mint = MINT): TokenSearchResult => ({
  mint,
  symbol: "BONK",
  name: "Bonk",
  decimals: 5,
  firstPoolAtMs: NOW - 86_400_000,
  marketUpdatedAtMs: NOW - 5_000,
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  iconUrl: null,
  verifiedByProvider: true,
  tags: ["verified"],
  source: "jupiter:tokens-v2",
  market: market(),
  providerClaims: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
});

const usdc: TokenSearchResult = {
  ...token(USDC_MINT),
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
};

function profile(overrides: Partial<ResearchProfile> = {}): ResearchProfile {
  return {
    mint: MINT,
    symbol: "BONK",
    name: "Bonk",
    decimals: 5,
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    iconUrl: null,
    tags: ["verified"],
    verifiedByProvider: true,
    identitySource: "jupiter:tokens-v2",
    marketSource: "jupiter:tokens-v2",
    marketUpdatedAtMs: NOW - 5_000,
    market: market(),
    verification: { status: "verified", source: "solana-rpc:mainnet", checkedAtMs: NOW - 1_000 },
    authorities: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      source: "solana-rpc:mainnet",
      providerAgreement: "agrees",
    },
    risk: { score: 5, level: "low", factors: [], method: "test" },
    simulation: { available: false, reason: "read-only" },
    fetchedAtMs: NOW,
    ...overrides,
  };
}

const quote = (overrides: Partial<NormalizedSwapQuote> = {}): NormalizedSwapQuote => ({
  inputMint: USDC_MINT,
  outputMint: MINT,
  inAmount: 100_000_000n,
  outAmount: 8_000_000_000n,
  minOutAmount: 7_960_000_000n,
  slippageBps: 50n,
  priceImpactBps: 25n,
  routePlan: [
    { ammLabel: "Meteora", ammKey: "amm", inputMint: USDC_MINT, outputMint: MINT, percent: 100 },
  ],
  swapUsdValueMicro: 100_000_000n,
  contextSlot: 123,
  swapMode: "ExactIn",
  retrievedAtMs: NOW,
  expiresAtMs: NOW + 20_000,
  source: "jupiter:quote-v1",
  ...overrides,
});

function research(p = profile(), searchResults: TokenSearchResult[] = [token()]): TradabilityResearch {
  return {
    getProfile: async () => p,
    resolveToken: async (mint) => (mint === USDC_MINT ? usdc : token()),
    search: async () => searchResults,
  };
}

const quotes = (result: NormalizedSwapQuote | Error = quote()): QuoteProvider => ({
  source: "jupiter:quote-v1",
  getQuote: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

describe("production tradability gates", () => {
  it("marks a mint eligible only after every blocking gate passes", async () => {
    const service = new TradabilityService(research(), quotes(), policy, () => NOW);
    const result = await service.check(MINT, "100", 50n);

    expect(result.eligible).toBe(true);
    expect(result.tradable).toBe(true);
    expect(result.verdict).toBe("eligible");
    expect(result.gates.filter((item) => item.blocking).every((item) => item.status === "pass")).toBe(true);
  });

  it("warns on a duplicate ticker without confusing symbol with identity", async () => {
    const service = new TradabilityService(research(profile(), [token(), token(OTHER_BONK)]), quotes(), policy, () => NOW);
    const result = await service.check(MINT, "100", 50n);

    expect(result.eligible).toBe(true);
    expect(result.duplicateMints).toEqual([OTHER_BONK]);
    expect(result.gates.find((item) => item.id === "duplicate_symbol")?.status).toBe("warning");
  });

  it("blocks stale, thin, authority-controlled, high-impact tokens", async () => {
    const p = profile({
      marketUpdatedAtMs: NOW - 301_000,
      market: market(9_999n * 1_000_000n),
      authorities: {
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        source: "solana-rpc:mainnet",
        providerAgreement: "disagrees",
      },
    });
    const service = new TradabilityService(research(p), quotes(quote({ priceImpactBps: 301n })), policy, () => NOW);
    const result = await service.check(MINT, "100", 50n);

    expect(result.eligible).toBe(false);
    expect(result.verdict).toBe("blocked");
    expect(result.blockingGateIds).toEqual(
      expect.arrayContaining([
        "market_freshness",
        "minimum_liquidity",
        "mint_authority",
        "freeze_authority",
        "price_impact",
      ]),
    );
  });

  it("reports missing provider evidence instead of assuming it passed", async () => {
    const timeout = new ArbError("PROVIDER_TIMEOUT", "Quote provider timed out", 504);
    const service = new TradabilityService(research(), quotes(timeout), policy, () => NOW);
    const result = await service.check(MINT, "100", 50n);

    expect(result.eligible).toBe(false);
    expect(result.verdict).toBe("needs_verification");
    expect(result.gates.find((item) => item.id === "jupiter_route")?.status).toBe("unavailable");
  });
});

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

describe("tradability API", () => {
  it("returns an API-safe eligibility report and never claims execution", async () => {
    const deps = createTestDeps(() => NOW);
    deps.research = research() as unknown as ResearchService;
    deps.quotes = quotes();
    const server = createApp(deps).listen(0);
    servers.push(server);
    const address = server.address();
    const base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";

    const response = await fetch(`${base}/v1/tradability/${MINT}?amountUsd=100`);
    const body = (await response.json()) as {
      eligible: boolean;
      executionEnabled: boolean;
      gates: Array<{ id: string; status: string }>;
      quote: { input: string; output: string };
    };

    expect(response.status).toBe(200);
    expect(body.eligible).toBe(true);
    expect(body.executionEnabled).toBe(false);
    expect(body.gates).toHaveLength(7);
    expect(body.quote.input).toBe("100 USDC");
    expect(body.quote.output).toMatch(/BONK$/);
  });
});
