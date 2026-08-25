import { describe, expect, it } from "vitest";
import { assessLiveFeedToken } from "../src/market/feedAssessment.js";
import type { LiveFeedToken, LiveFeedWindow } from "../src/market/jupiter/liveFeed.js";

const NOW = Date.parse("2026-08-25T18:00:00Z");
const POLICY = {
  minLiquidityUsdMicro: 10_000n * 1_000_000n,
  maxPriceImpactBps: 100n,
  maxMarketAgeMs: 60_000,
};

const activeWindow = (overrides: Partial<LiveFeedWindow> = {}): LiveFeedWindow => ({
  priceChangeBps: 500n,
  liquidityChangeBps: 100n,
  volumeChangeBps: 1_000n,
  buyVolumeUsdMicro: 390_000n * 1_000_000n,
  sellVolumeUsdMicro: 210_000n * 1_000_000n,
  buys: 1_300,
  sells: 700,
  traders: 1_200,
  ...overrides,
});

function token(overrides: Partial<LiveFeedToken> = {}): LiveFeedToken {
  const window = activeWindow();
  return {
    token: {
      mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      symbol: "STRONG",
      name: "Strong signal",
      decimals: 6,
      firstPoolAtMs: NOW - 31 * 86_400_000,
      marketUpdatedAtMs: NOW - 1_000,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      iconUrl: null,
      verifiedByProvider: true,
      tags: [],
      source: "test",
      market: {
        priceUsdPico: 1_000_000n,
        liquidityUsdMicro: 5_000_000n * 1_000_000n,
        marketCapUsdMicro: 50_000_000n * 1_000_000n,
        fdvUsdMicro: 55_000_000n * 1_000_000n,
        holderCount: 100_000,
        change1hBps: 800n,
        change24hBps: 1_500n,
        buyVolume24hUsdMicro: 8_000_000n * 1_000_000n,
        sellVolume24hUsdMicro: 6_000_000n * 1_000_000n,
        numBuys24h: 8_000,
        numSells24h: 6_000,
        topHolderPctBps: 500n,
        organicScore: 95,
        organicScoreLabel: "high",
      },
      providerClaims: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
    },
    firstPoolAtMs: NOW - 31 * 86_400_000,
    updatedAtMs: NOW - 1_000,
    launchpad: null,
    fiveMinutes: window,
    oneHour: window,
    twentyFourHours: window,
    ...overrides,
  };
}

describe("concentrated live feed assessment", () => {
  it("reserves a 90+ paper signal for broad, mature, fresh evidence", () => {
    const assessment = assessLiveFeedToken(token(), NOW, POLICY, 1);

    expect(assessment.qualityScore).toBeGreaterThanOrEqual(90);
    expect(assessment.confidenceScore).toBeGreaterThanOrEqual(90);
    expect(assessment.autoWatchEligible).toBe(true);
    expect(assessment.autoPaperEligible).toBe(true);
    expect(assessment.signal).toBe("paper_candidate");
    expect(assessment.scoreBreakdown.map((part) => part.id)).toEqual([
      "market",
      "momentum",
      "safety",
      "maturity",
      "confidence",
    ]);
  });

  it("keeps a thin, two-minute, sell-heavy token out of automatic surfaces", () => {
    const weakWindow = activeWindow({
      priceChangeBps: 6_000n,
      liquidityChangeBps: -2_000n,
      volumeChangeBps: -5_000n,
      buyVolumeUsdMicro: 100n * 1_000_000n,
      sellVolumeUsdMicro: 10_000n * 1_000_000n,
      traders: 8,
    });
    const base = token();
    const weak = token({
      token: {
        ...base.token,
        verifiedByProvider: false,
        firstPoolAtMs: NOW - 2 * 60_000,
        marketUpdatedAtMs: NOW - 10 * 60_000,
        market: {
          ...base.token.market,
          liquidityUsdMicro: 5_000n * 1_000_000n,
          marketCapUsdMicro: null,
          holderCount: null,
          topHolderPctBps: null,
          organicScore: null,
        },
        providerClaims: { mintAuthorityDisabled: null, freezeAuthorityDisabled: null },
      },
      firstPoolAtMs: NOW - 2 * 60_000,
      updatedAtMs: NOW - 10 * 60_000,
      fiveMinutes: weakWindow,
      oneHour: weakWindow,
      twentyFourHours: weakWindow,
    });
    const assessment = assessLiveFeedToken(weak, NOW, POLICY, 2);

    expect(assessment.qualityScore).toBeLessThan(35);
    expect(assessment.riskLevel).toBe("high");
    expect(assessment.autoWatchEligible).toBe(false);
    expect(assessment.autoPaperEligible).toBe(false);
    expect(assessment.signal).toBe("avoid");
  });

  it("credits sustained multi-window demand when the current candle is quiet", () => {
    const base = token();
    const fiveMinutes = activeWindow({
      priceChangeBps: -15n,
      liquidityChangeBps: 34n,
      volumeChangeBps: -3_441n,
      buyVolumeUsdMicro: 19_204n * 1_000_000n,
      sellVolumeUsdMicro: 16_526n * 1_000_000n,
      traders: 117,
    });
    const oneHour = activeWindow({ priceChangeBps: -224n, volumeChangeBps: 1_653n, traders: 1_589 });
    const day = activeWindow({
      priceChangeBps: 2_544n,
      volumeChangeBps: 6_211n,
      buyVolumeUsdMicro: 20_000_000n * 1_000_000n,
      sellVolumeUsdMicro: 20_000_000n * 1_000_000n,
      traders: 26_667,
    });
    const sustained = token({
      token: {
        ...base.token,
        market: {
          ...base.token.market,
          liquidityUsdMicro: 2_930_000n * 1_000_000n,
          marketCapUsdMicro: 67_800_000n * 1_000_000n,
          topHolderPctBps: 1_259n,
          organicScore: 94,
        },
      },
      fiveMinutes,
      oneHour,
      twentyFourHours: day,
    });
    const assessment = assessLiveFeedToken(sustained, NOW, POLICY, 1);

    expect(assessment.momentumScore).toBeGreaterThanOrEqual(85);
    expect(assessment.qualityScore).toBeGreaterThanOrEqual(90);
    expect(assessment.autoPaperEligible).toBe(true);
  });

  it("does not auto-queue an established coin with extreme reported concentration", () => {
    const base = token();
    const concentrated = token({
      token: {
        ...base.token,
        market: { ...base.token.market, topHolderPctBps: 8_218n },
      },
    });
    const assessment = assessLiveFeedToken(concentrated, NOW, POLICY, 1);

    expect(assessment.warnings).toContain("Top holders control at least 40%");
    expect(assessment.riskScore).toBeGreaterThan(25);
    expect(assessment.autoWatchEligible).toBe(false);
    expect(assessment.autoPaperEligible).toBe(false);
  });
});
