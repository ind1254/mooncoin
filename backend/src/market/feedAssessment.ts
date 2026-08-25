import type { LiveFeedToken } from "./jupiter/liveFeed.js";
import type { TradabilityPolicy } from "./tradability.js";

export interface LiveFeedAssessment {
  status: "stale" | "detected" | "thin" | "active";
  qualityScore: number;
  confidenceScore: number;
  momentumScore: number;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  signal: "paper_candidate" | "strong_watch" | "watch" | "research" | "avoid";
  actionLabel: string;
  autoWatchEligible: boolean;
  autoPaperEligible: boolean;
  trendAlignment: {
    positiveWindows: number;
    measuredWindows: number;
    label: string;
  };
  scoreVersion: "live-v2";
  scoreBreakdown: Array<{
    id: "market" | "momentum" | "safety" | "maturity" | "confidence";
    label: string;
    score: number;
    maxScore: number;
    detail: string;
  }>;
  warnings: string[];
  duplicateSymbolCount: number;
  eligibility: string;
}

export function sumLiveFeedVolume(
  token: LiveFeedToken,
  window: "fiveMinutes" | "oneHour" | "twentyFourHours",
): bigint | null {
  const value = token[window];
  if (value.buyVolumeUsdMicro === null && value.sellVolumeUsdMicro === null) return null;
  return (value.buyVolumeUsdMicro ?? 0n) + (value.sellVolumeUsdMicro ?? 0n);
}

/**
 * Fast catalog-only assessment used by both the feed UI and the paper bot's
 * prefilter. It is not a production-eligibility verdict; any entry still has
 * to pass fresh Solana authority reads and an exact-size Jupiter quote.
 */
export function assessLiveFeedToken(
  token: LiveFeedToken,
  nowMs: number,
  policy: TradabilityPolicy,
  duplicateSymbolCount: number,
): LiveFeedAssessment {
  const market = token.token.market;
  const liquidity = market.liquidityUsdMicro;
  const topHolders = market.topHolderPctBps;
  const ageMs = token.firstPoolAtMs === null ? null : Math.max(0, nowMs - token.firstPoolAtMs);
  const marketAgeMs = token.updatedAtMs === null ? null : Math.max(0, nowMs - token.updatedAtMs);
  const authority = token.token.providerClaims;
  let risk = 0;
  const warnings: string[] = [];

  if (marketAgeMs === null || marketAgeMs > policy.maxMarketAgeMs) {
    risk += 30;
    warnings.push(marketAgeMs === null ? "Market update time unavailable" : "Market data is too old for eligibility");
  }
  if (duplicateSymbolCount > 1) {
    risk += 5;
    warnings.push(`Ticker shared by ${duplicateSymbolCount} mints — verify address`);
  }
  if (liquidity === null || liquidity < policy.minLiquidityUsdMicro) {
    risk += 30;
    warnings.push(liquidity === null ? "Liquidity not reported" : "Very thin liquidity");
  } else if (liquidity < policy.minLiquidityUsdMicro * 5n) {
    risk += 14;
    warnings.push("Thin liquidity");
  }
  if (topHolders === null) {
    risk += 8;
    warnings.push("Holder concentration unavailable");
  } else if (topHolders >= 4_000n) {
    risk += 28;
    warnings.push("Top holders control at least 40%");
  } else if (topHolders >= 2_000n) {
    risk += 12;
    warnings.push("Concentrated ownership");
  }
  if (authority.mintAuthorityDisabled !== true) {
    risk += 18;
    warnings.push("Mint authority not confirmed disabled");
  }
  if (authority.freezeAuthorityDisabled !== true) {
    risk += 14;
    warnings.push("Freeze authority not confirmed disabled");
  }
  if (ageMs === null) {
    risk += 5;
    warnings.push("First-pool time unavailable");
  } else if (ageMs < 5 * 60_000) {
    risk += 20;
    warnings.push("Pool detected less than 5 minutes ago");
  } else if (ageMs < 15 * 60_000) {
    risk += 12;
    warnings.push("Pool detected less than 15 minutes ago");
  }

  const fiveMinuteVolume = sumLiveFeedVolume(token, "fiveMinutes") ?? 0n;
  const marketCap = market.marketCapUsdMicro;
  const buyVolume = token.fiveMinutes.buyVolumeUsdMicro;
  const sellVolume = token.fiveMinutes.sellVolumeUsdMicro;

  // Market depth (20): liquidity matters, but it cannot dominate the result.
  // Market cap and liquidity-to-cap depth keep an active micro-cap distinct
  // from a large token with only a shallow exit pool.
  let marketScore = liquidity === null
    ? 0
    : liquidity >= 5_000_000n * 1_000_000n
      ? 12
      : liquidity >= 1_000_000n * 1_000_000n
        ? 11
        : liquidity >= 250_000n * 1_000_000n
          ? 9
          : liquidity >= 50_000n * 1_000_000n
            ? 6
            : liquidity >= 10_000n * 1_000_000n
              ? 3
              : 0;
  marketScore += marketCap === null
    ? 0
    : marketCap >= 50_000_000n * 1_000_000n
      ? 5
      : marketCap >= 10_000_000n * 1_000_000n
        ? 4
        : marketCap >= 1_000_000n * 1_000_000n
          ? 3
          : marketCap >= 250_000n * 1_000_000n
            ? 2
            : 1;
  let depthBps: bigint | null = null;
  if (liquidity !== null && marketCap !== null && marketCap > 0n) {
    depthBps = (liquidity * 10_000n) / marketCap;
    marketScore += depthBps >= 1_000n ? 3 : depthBps >= 400n ? 2 : depthBps >= 200n ? 1 : 0;
  }

  // Current demand (30): five-minute flow, breadth, buy pressure, price action,
  // and whether volume/liquidity are expanding. This is deliberately the
  // largest pillar for the five-minute trending screen.
  let momentumScore = fiveMinuteVolume >= 500_000n * 1_000_000n
    ? 10
    : fiveMinuteVolume >= 100_000n * 1_000_000n
      ? 9
      : fiveMinuteVolume >= 25_000n * 1_000_000n
        ? 7
        : fiveMinuteVolume >= 5_000n * 1_000_000n
          ? 4
          : fiveMinuteVolume > 0n
            ? 1
            : 0;
  const traders = token.fiveMinutes.traders;
  momentumScore += traders === null
    ? 0
    : traders >= 1_000
      ? 7
      : traders >= 500
        ? 6
        : traders >= 200
          ? 5
          : traders >= 75
            ? 3
            : traders >= 20
              ? 1
              : 0;
  let buyShareBps: bigint | null = null;
  if (buyVolume !== null || sellVolume !== null) {
    const total = (buyVolume ?? 0n) + (sellVolume ?? 0n);
    if (total > 0n) {
      buyShareBps = ((buyVolume ?? 0n) * 10_000n) / total;
      momentumScore += buyShareBps >= 6_000n ? 5 : buyShareBps >= 5_200n ? 4 : buyShareBps >= 4_500n ? 2 : 0;
      if (buyShareBps < 3_500n) {
        risk += 10;
        warnings.push("Five-minute flow is strongly sell-heavy");
      }
    }
  }
  const change5m = token.fiveMinutes.priceChangeBps;
  if (change5m !== null) {
    momentumScore += change5m >= 100n && change5m <= 1_500n
      ? 5
      : change5m > 10n && change5m < 100n
        ? 4
        : change5m >= -200n && change5m <= 10n
          ? 2
          : change5m > 1_500n && change5m <= 4_000n
            ? 3
            : change5m > 4_000n
              ? 1
              : 0;
    if (change5m > 5_000n) {
      risk += 14;
      warnings.push("Five-minute move is parabolic");
    } else if (change5m < -2_000n) {
      risk += 12;
      warnings.push("Price fell more than 20% in five minutes");
    }
  }
  const liquidityChange = token.fiveMinutes.liquidityChangeBps;
  const volumeChange = token.fiveMinutes.volumeChangeBps;
  momentumScore += liquidityChange !== null && liquidityChange >= 0n && volumeChange !== null && volumeChange >= 0n
    ? 3
    : (liquidityChange !== null && liquidityChange >= 0n) || (volumeChange !== null && volumeChange >= 0n)
      ? 2
      : liquidityChange === null && volumeChange === null
        ? 0
        : 1;
  // Sustained activity matters for coins that remain relevant beyond one
  // candle. It can lift a healthy quiet five-minute window, but the pillar is
  // capped at 30 so it cannot overwhelm market/safety evidence.
  const twentyFourHourVolume = sumLiveFeedVolume(token, "twentyFourHours") ?? 0n;
  momentumScore += token.oneHour.volumeChangeBps !== null && token.oneHour.volumeChangeBps > 0n ? 2 : 0;
  momentumScore += token.twentyFourHours.volumeChangeBps !== null && token.twentyFourHours.volumeChangeBps > 0n ? 2 : 0;
  momentumScore += twentyFourHourVolume >= 10_000_000n * 1_000_000n
    ? 2
    : twentyFourHourVolume >= 1_000_000n * 1_000_000n
      ? 1
      : 0;
  momentumScore += token.twentyFourHours.traders !== null && token.twentyFourHours.traders >= 10_000
    ? 2
    : token.twentyFourHours.traders !== null && token.twentyFourHours.traders >= 2_000
      ? 1
      : 0;
  momentumScore = Math.min(30, momentumScore);

  if (liquidityChange !== null && liquidityChange <= -1_000n) {
    risk += 20;
    warnings.push("Liquidity fell at least 10% in five minutes");
  }

  // Safety (20): catalog claims are hints used only for this fast prefilter;
  // production entry still reruns authoritative on-chain checks.
  let safetyScore = authority.mintAuthorityDisabled === true ? 6 : 0;
  safetyScore += authority.freezeAuthorityDisabled === true ? 6 : 0;
  safetyScore += topHolders === null
    ? 0
    : topHolders < 1_000n
      ? 5
      : topHolders < 2_000n
        ? 4
        : topHolders < 3_000n
          ? 2
          : topHolders < 4_000n
            ? 1
            : 0;
  safetyScore += liquidityChange === null
    ? 0
    : liquidityChange >= 0n
      ? 3
      : liquidityChange > -500n
        ? 2
        : liquidityChange > -1_000n
          ? 1
          : 0;

  // Maturity and trend continuity (15): established tokens receive credit,
  // while genuinely new tokens can still rank through exceptional live demand.
  let maturityScore = ageMs === null
    ? 0
    : ageMs >= 30 * 86_400_000
      ? 8
      : ageMs >= 7 * 86_400_000
        ? 7
        : ageMs >= 86_400_000
          ? 6
          : ageMs >= 6 * 3_600_000
            ? 4
            : ageMs >= 3_600_000
              ? 3
              : ageMs >= 15 * 60_000
                ? 1
                : 0;
  maturityScore += market.holderCount === null
    ? 0
    : market.holderCount >= 100_000
      ? 4
      : market.holderCount >= 10_000
        ? 3
        : market.holderCount >= 1_000
          ? 2
          : market.holderCount >= 100
            ? 1
            : 0;
  const trendWindows = [
    token.fiveMinutes.priceChangeBps,
    token.oneHour.priceChangeBps,
    token.twentyFourHours.priceChangeBps,
  ];
  const measuredWindows = trendWindows.filter((value) => value !== null).length;
  const positiveWindows = trendWindows.filter((value) => value !== null && value > 0n).length;
  maturityScore += Math.min(3, positiveWindows);

  // Evidence coverage (15): a high research score requires broad, fresh data,
  // not merely one exciting price candle.
  const freshnessScore = marketAgeMs === null ? 0 : marketAgeMs <= 10_000 ? 5 : marketAgeMs <= 30_000 ? 4 : marketAgeMs <= 60_000 ? 3 : 0;
  const evidence = [
    liquidity,
    marketCap,
    market.holderCount,
    topHolders,
    market.organicScore,
    fiveMinuteVolume > 0n ? fiveMinuteVolume : null,
    traders,
    change5m,
    buyShareBps,
    liquidityChange,
  ];
  const evidenceCount = evidence.filter((value) => value !== null).length;
  const confidencePillar = freshnessScore
    + Math.round((evidenceCount / evidence.length) * 6)
    + (token.token.verifiedByProvider ? 2 : 0)
    + (ageMs !== null ? 1 : 0)
    + (marketCap !== null ? 1 : 0);

  const riskPenalty = Math.floor(Math.min(100, risk) / 5);
  const quality = Math.max(
    0,
    Math.min(100, marketScore + momentumScore + safetyScore + maturityScore + confidencePillar - riskPenalty),
  );
  const confidenceScore = Math.round((confidencePillar / 15) * 100);

  const status =
    marketAgeMs === null || marketAgeMs > policy.maxMarketAgeMs
      ? "stale"
      : market.priceUsdPico === null || liquidity === null
        ? "detected"
        : liquidity < policy.minLiquidityUsdMicro
          ? "thin"
          : "active";
  const riskLevel = risk >= 45 ? "high" : risk >= 20 ? "medium" : "low";
  const autoWatchEligible =
    status === "active" &&
    quality >= 85 &&
    risk <= 25 &&
    confidenceScore >= 75 &&
    ageMs !== null &&
    ageMs >= 15 * 60_000 &&
    marketCap !== null;
  const autoPaperEligible =
    autoWatchEligible &&
    quality >= 90 &&
    risk <= 15 &&
    ageMs >= 86_400_000 &&
    marketCap >= 250_000n * 1_000_000n;
  const signal = autoPaperEligible
    ? "paper_candidate"
    : autoWatchEligible
      ? "strong_watch"
      : quality >= 70 && risk <= 40
        ? "watch"
        : quality < 35 || risk >= 55
          ? "avoid"
          : "research";
  const actionLabel = signal === "paper_candidate"
    ? "Paper entry candidate"
    : signal === "strong_watch"
      ? "Auto-watch candidate"
      : signal === "watch"
        ? "Watch live"
        : signal === "avoid"
          ? "Skip for now"
          : "Research first";

  return {
    status,
    qualityScore: quality,
    confidenceScore,
    momentumScore: Math.round((momentumScore / 30) * 100),
    riskScore: Math.min(100, risk),
    riskLevel,
    signal,
    actionLabel,
    autoWatchEligible,
    autoPaperEligible,
    trendAlignment: {
      positiveWindows,
      measuredWindows,
      label: measuredWindows === 0 ? "Trend unavailable" : `${positiveWindows}/${measuredWindows} windows positive`,
    },
    scoreVersion: "live-v2",
    scoreBreakdown: [
      { id: "market", label: "Market depth", score: marketScore, maxScore: 20, detail: depthBps === null ? "Liquidity and market-cap coverage" : `Liquidity is ${(Number(depthBps) / 100).toFixed(1)}% of market cap` },
      { id: "momentum", label: "Live demand", score: momentumScore, maxScore: 30, detail: `${token.fiveMinutes.traders ?? 0} traders and ${positiveWindows}/${measuredWindows || 3} positive windows` },
      { id: "safety", label: "Fast safety screen", score: safetyScore, maxScore: 20, detail: "Authority claims, concentration, and liquidity direction" },
      { id: "maturity", label: "Maturity", score: maturityScore, maxScore: 15, detail: ageMs === null ? "Pool age unavailable" : `First pool detected ${Math.floor(ageMs / 60_000)} minutes ago` },
      { id: "confidence", label: "Evidence confidence", score: confidencePillar, maxScore: 15, detail: `${evidenceCount}/${evidence.length} market inputs available` },
    ],
    warnings: [...new Set(warnings)].slice(0, 5),
    duplicateSymbolCount,
    eligibility:
      autoPaperEligible
        ? "Strong live paper candidate. A fresh exact-size quote and on-chain production check are still required before any simulated entry."
        : autoWatchEligible
          ? "Strong enough for the automatic smart watchlist; keep monitoring live demand and risk."
          : status === "active"
            ? "Catalog gates passed. Run the production check to verify the route and on-chain authorities."
        : status === "stale"
          ? "Market data is stale or undated, so production eligibility is blocked."
          : status === "thin"
            ? `Liquidity is below Moonpaper's $${(policy.minLiquidityUsdMicro / 1_000_000n).toString()} production threshold.`
            : "Detected by Jupiter, but complete pricing and liquidity are not available yet.",
  };
}
