import { describe, expect, it } from "vitest";
import { assessPaperBotCandidate, evaluatePaperBotExit } from "../src/bot/strategy.js";
import type { PaperBotStrategyConfig } from "../src/bot/types.js";
import type { LiveFeedToken } from "../src/market/jupiter/liveFeed.js";

const NOW = 1_760_000_000_000;
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

function feedToken(overrides: Partial<LiveFeedToken> = {}): LiveFeedToken {
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
    token: {
      mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      symbol: "BOT",
      name: "Bot Candidate",
      decimals: 6,
      firstPoolAtMs: NOW - 86_400_000,
      marketUpdatedAtMs: NOW - 5_000,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      iconUrl: null,
      verifiedByProvider: true,
      tags: [],
      source: "jupiter:tokens-v2",
      market: {
        priceUsdPico: 1_000_000n,
        liquidityUsdMicro: 2_000_000_000_000n,
        marketCapUsdMicro: null,
        fdvUsdMicro: null,
        holderCount: 2_000,
        change1hBps: 500n,
        change24hBps: 1_000n,
        buyVolume24hUsdMicro: 1_000_000_000_000n,
        sellVolume24hUsdMicro: 800_000_000_000n,
        numBuys24h: 1_000,
        numSells24h: 800,
        topHolderPctBps: 1_000n,
        organicScore: 100,
        organicScoreLabel: "high",
      },
      providerClaims: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
    },
    firstPoolAtMs: NOW - 86_400_000,
    updatedAtMs: NOW - 5_000,
    launchpad: null,
    fiveMinutes: window,
    oneHour: window,
    twentyFourHours: window,
    ...overrides,
  };
}

describe("paper-bot strategy", () => {
  it("accepts a liquid, fresh, active candidate and explains configured rejections", () => {
    const accepted = assessPaperBotCandidate(feedToken(), 1, strategy, 300_000, NOW);
    expect(accepted.accepted).toBe(true);
    expect(accepted.assessment.qualityScore).toBeGreaterThanOrEqual(70);

    const thin = feedToken({
      token: {
        ...feedToken().token,
        market: { ...feedToken().token.market, liquidityUsdMicro: 20_000_000_000n },
      },
    });
    const rejected = assessPaperBotCandidate(thin, 1, strategy, 300_000, NOW);
    expect(rejected.accepted).toBe(false);
    expect(rejected.reasons.join(" ")).toMatch(/liquidity/i);
  });

  it("closes on stop, target, trailing drawdown, and time using integer values", () => {
    const evaluate = (current: bigint, high = 500_000_000n, heldMinutes = 1) =>
      evaluatePaperBotExit({
        entryCostMicroUsd: 500_000_000n,
        currentValueMicroUsd: current,
        previousHighWaterMicroUsd: high,
        openedAtMs: NOW - heldMinutes * 60_000,
        nowMs: NOW,
        currentPriceImpactBps: 25n,
        strategy,
      });

    expect(evaluate(459_000_000n).reason).toBe("stop_loss");
    expect(evaluate(575_000_000n).reason).toBe("take_profit");
    expect(evaluate(540_000_000n, 610_000_000n).reason).toBe("trailing_stop");
    expect(evaluate(510_000_000n, 510_000_000n, 361).reason).toBe("max_hold");
    expect(evaluate(520_000_000n).shouldClose).toBe(false);
    expect(
      evaluatePaperBotExit({
        entryCostMicroUsd: 500_000_000n,
        currentValueMicroUsd: 510_000_000n,
        previousHighWaterMicroUsd: 510_000_000n,
        openedAtMs: NOW - 60_000,
        nowMs: NOW,
        currentPriceImpactBps: 201n,
        strategy,
      }).reason,
    ).toBe("liquidity_risk");
  });
});
