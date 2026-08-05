import { describe, expect, it } from "vitest";
import { computeScores, scoreExecution, scoreLiquidity, scoreMomentum, scoreRisk } from "../src/scoring/scores.js";
import type { RouteComparison, RouteQuote, TokenMarketView } from "../src/market/types.js";

const NOW = 1_700_000_000_000;

function view(overrides: {
  momentum?: Partial<TokenMarketView["momentum"]["value"]>;
  liquidity?: Partial<TokenMarketView["liquidity"]["value"]>;
  risk?: Partial<TokenMarketView["risk"]["value"]>;
  momentumAgeMs?: number;
} = {}): TokenMarketView {
  const momentumValue = {
    pricePicoUsd: 14_000_000n,
    change5mBps: 30n,
    change1hBps: 350n,
    change24hBps: 900n,
    volume1hUsdMicro: 1_500_000_000_000n,
    volumeChange1hBps: 5_000n,
    buySellRatioPct: 130n,
    txCount1h: 2_000,
    ...overrides.momentum,
  };
  const liquidityValue = {
    totalUsdMicro: 10_000_000_000_000n, // $10M
    change1hBps: 50n,
    topPoolShareBps: 4_000n,
    ...overrides.liquidity,
  };
  const riskValue = {
    tokenAgeDays: 400,
    holderConcentrationBps: 1_500n,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    recentInsiderActivity: false,
    dataComplete: true,
    ...overrides.risk,
  };
  const ageMs = overrides.momentumAgeMs ?? 5_000;
  return {
    token: { mint: "M".repeat(43), symbol: "TEST", name: "Test", decimals: 6, createdAtMs: NOW, emoji: "🧪" },
    momentum: { value: momentumValue, source: "test", observedAtMs: NOW - ageMs, ageMs, reliability: ageMs <= 60_000 ? "fresh" : "stale" },
    liquidity: { value: liquidityValue, source: "test", observedAtMs: NOW, ageMs: 5_000, reliability: "fresh" },
    risk: { value: riskValue, source: "test", observedAtMs: NOW, ageMs: 60_000, reliability: "fresh" },
    solPriceMicroUsd: 150_000_000n,
  };
}

function route(overrides: Partial<RouteQuote> = {}): RouteQuote {
  return {
    venueId: "raydium",
    venueName: "Raydium",
    side: "buy",
    tokenMint: "M".repeat(43),
    inAmount: 10_000_000_000n,
    outAmount: 1_000_000_000n,
    minReceived: 990_000_000n,
    effectivePricePicoUsd: 14_000_000n,
    priceImpactBps: 10n,
    routeFeeBps: 25n,
    networkFeeLamports: 5_000n,
    priorityFeeLamports: 100_000n,
    slippageBps: 100n,
    retrievedAtMs: NOW - 2_000,
    expiresAtMs: NOW + 18_000,
    source: "test",
    ...overrides,
  };
}

const LIMITS = { maxPriceImpactBps: 100n, minLiquidityUsdMicro: 250_000_000_000n };

describe("momentum scoring", () => {
  it("rewards rising price, accelerating volume, and buy pressure with evidence", () => {
    const s = scoreMomentum(view());
    expect(s.score).toBeGreaterThan(70);
    const ids = s.factors.map((f) => f.id);
    expect(ids).toContain("price-up-1h");
    expect(ids).toContain("volume-accel");
    expect(ids).toContain("buy-pressure");
    for (const f of s.factors) expect(f.detail.length).toBeGreaterThan(10);
  });

  it("penalizes falling price and sell pressure", () => {
    const s = scoreMomentum(view({ momentum: { change1hBps: -600n, volumeChange1hBps: -3_000n, buySellRatioPct: 80n } }));
    expect(s.score).toBeLessThan(40);
    expect(s.factors.map((f) => f.id)).toContain("price-down-1h");
  });

  it("caps the score and explains when the feed is stale", () => {
    const s = scoreMomentum(view({ momentumAgeMs: 90_000 }));
    expect(s.score).toBeLessThanOrEqual(45);
    expect(s.factors.map((f) => f.id)).toContain("stale-feed");
  });
});

describe("liquidity scoring", () => {
  it("scores deep liquidity high", () => {
    const s = scoreLiquidity(view(), 1_500_000_000n, LIMITS);
    expect(s.score).toBeGreaterThanOrEqual(80);
  });

  it("flags liquidity below the user's minimum", () => {
    const s = scoreLiquidity(view({ liquidity: { totalUsdMicro: 90_000_000_000n } }), 1_500_000_000n, LIMITS);
    expect(s.factors.map((f) => f.id)).toContain("below-user-min");
    expect(s.score).toBeLessThan(30);
  });

  it("flags trades that are large relative to the pool", () => {
    const s = scoreLiquidity(view({ liquidity: { totalUsdMicro: 300_000_000_000n } }), 30_000_000_000n, LIMITS);
    expect(s.factors.map((f) => f.id)).toContain("size-vs-liquidity");
  });
});

describe("execution scoring", () => {
  it("returns zero with an explanation when no route exists", () => {
    const s = scoreExecution({ best: null, alternatives: [], failures: [] }, LIMITS, NOW);
    expect(s.score).toBe(0);
    expect(s.factors[0]!.id).toBe("no-route");
  });

  it("rewards low impact, fresh quotes, and route choice", () => {
    const routes: RouteComparison = { best: route(), alternatives: [route({ venueId: "orca" })], failures: [] };
    const s = scoreExecution(routes, LIMITS, NOW);
    expect(s.score).toBeGreaterThan(80);
    expect(s.factors.map((f) => f.id)).toEqual(expect.arrayContaining(["low-impact", "quote-fresh", "route-choice"]));
  });

  it("penalizes impact above the user's limit and expired quotes", () => {
    const routes: RouteComparison = { best: route({ priceImpactBps: 800n, expiresAtMs: NOW - 1 }), alternatives: [], failures: [] };
    const s = scoreExecution(routes, LIMITS, NOW);
    expect(s.score).toBeLessThan(30);
    expect(s.factors.map((f) => f.id)).toEqual(expect.arrayContaining(["impact-over-limit", "quote-expired"]));
  });
});

describe("risk scoring", () => {
  it("scores an established, distributed, renounced token as low risk", () => {
    const s = scoreRisk(view());
    expect(s.score).toBeLessThan(30);
  });

  it("stacks risk for new, concentrated tokens with live authorities", () => {
    const s = scoreRisk(
      view({
        risk: {
          tokenAgeDays: 2,
          holderConcentrationBps: 6_200n,
          mintAuthorityRevoked: false,
          freezeAuthorityRevoked: false,
          recentInsiderActivity: true,
          dataComplete: false,
        },
      }),
    );
    expect(s.score).toBeGreaterThanOrEqual(90);
    const ids = s.factors.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(["very-new", "high-concentration", "mint-authority", "freeze-authority", "insider-activity", "incomplete-risk-data"]),
    );
  });
});

describe("opportunity aggregation", () => {
  it("caps overall quality for high-risk tokens and explains the cap", () => {
    const risky = view({
      risk: { tokenAgeDays: 2, holderConcentrationBps: 6_200n, mintAuthorityRevoked: false },
    });
    const routes: RouteComparison = { best: route(), alternatives: [route({ venueId: "orca" })], failures: [] };
    const s = computeScores(risky, routes, 1_500_000_000n, LIMITS, NOW);
    expect(s.riskLevel).toBe("high");
    expect(s.opportunity.score).toBeLessThanOrEqual(35);
    expect(s.opportunity.factors.map((f) => f.id)).toContain("capped-by-risk");
  });

  it("labels a healthy setup strong with supporting evidence", () => {
    const routes: RouteComparison = { best: route(), alternatives: [route({ venueId: "orca" })], failures: [] };
    const s = computeScores(view(), routes, 1_500_000_000n, LIMITS, NOW);
    expect(s.opportunityLabel).toBe("strong");
    expect(s.opportunity.factors.some((f) => f.direction === "positive")).toBe(true);
  });
});
