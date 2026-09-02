import { assessRisk, type RiskPolicy } from "../risk/engineV3.js";
import { snapshotFromFeedToken } from "../evidence/build.js";
import { hasValue } from "../evidence/types.js";
import type { LiveFeedKind, LiveFeedToken } from "./jupiter/liveFeed.js";
import type { TradabilityPolicy } from "./tradability.js";
import type { TokenHistoryRepository } from "../db/tokenHistory.js";
import { metrics } from "../observability/metrics.js";

/**
 * Records the observations that make history exist.
 *
 * Without this pass every other time-series feature is inert: the retention
 * policy has nothing to retain, the risk-change endpoint has nothing to
 * compare against, and the table is empty in production.
 *
 * Each pass builds an evidence snapshot per feed token, scores it with the
 * versioned risk engine, and writes one row. The risk model version is stored
 * with the score so a later comparison can refuse to compare across models
 * rather than subtracting two numbers on different scales.
 *
 * Runs the prune afterwards, in the same pass, so retention is enforced by the
 * thing that creates the rows rather than by a separate job someone has to
 * remember to schedule.
 */
export interface HistoryWorkerDeps {
  getFeed(kind: LiveFeedKind, signal?: AbortSignal): Promise<{ tokens: LiveFeedToken[] }>;
  history: TokenHistoryRepository;
  policy: TradabilityPolicy;
  clock?: () => number;
  kinds?: LiveFeedKind[];
  /** Cap per pass so one run cannot balloon on an unusually large feed. */
  maxTokens?: number;
}

export interface HistoryPassSummary {
  scanned: number;
  recorded: number;
  downsampled: number;
  deleted: number;
}

export async function runHistoryPass(deps: HistoryWorkerDeps): Promise<HistoryPassSummary> {
  const clock = deps.clock ?? Date.now;
  const kinds = deps.kinds ?? (["trending", "recent"] as LiveFeedKind[]);
  const maxTokens = deps.maxTokens ?? 120;
  const riskPolicy: RiskPolicy = {
    minLiquidityUsdMicro: deps.policy.minLiquidityUsdMicro,
    maxPriceImpactBps: deps.policy.maxPriceImpactBps,
  };

  const summary: HistoryPassSummary = { scanned: 0, recorded: 0, downsampled: 0, deleted: 0 };
  // A mint can appear in both feeds; record it once per pass so the write
  // stays idempotent on (mint, observed_at).
  const seen = new Set<string>();

  for (const kind of kinds) {
    const feed = await deps.getFeed(kind);
    const nowMs = clock();

    const symbolMints = new Map<string, Set<string>>();
    for (const item of feed.tokens) {
      const key = item.token.symbol.toLowerCase();
      const mints = symbolMints.get(key) ?? new Set<string>();
      mints.add(item.token.mint);
      symbolMints.set(key, mints);
    }

    for (const item of feed.tokens) {
      if (seen.size >= maxTokens) break;
      summary.scanned += 1;
      if (seen.has(item.token.mint)) continue;
      seen.add(item.token.mint);

      const snapshot = snapshotFromFeedToken(item, nowMs, {
        duplicateSymbolCount: symbolMints.get(item.token.symbol.toLowerCase())?.size ?? 1,
        maxMarketAgeMs: deps.policy.maxMarketAgeMs,
      });
      const risk = assessRisk(snapshot, riskPolicy);

      const market = snapshot.market;
      const liquidity = snapshot.liquidity;
      const holders = snapshot.holders;
      const authorities = snapshot.authorities;

      await deps.history.record({
        tokenMint: snapshot.mint,
        observedAtMs: nowMs,
        resolution: "high",
        riskScore: risk.riskScore,
        riskConfidence: risk.riskConfidence,
        riskModelVersion: risk.riskModelVersion,
        // hasValue keeps an unavailable metric out as null rather than letting
        // a zero in, which would read as a total collapse on the next diff.
        pricePicoUsd: hasValue(market.priceUsdPico) ? market.priceUsdPico.value : null,
        liquidityUsdMicro: hasValue(liquidity.liquidityUsdMicro)
          ? liquidity.liquidityUsdMicro.value
          : null,
        marketCapUsdMicro: hasValue(market.marketCapUsdMicro) ? market.marketCapUsdMicro.value : null,
        volume24hUsdMicro: hasValue(snapshot.momentum.volume24hUsdMicro)
          ? snapshot.momentum.volume24hUsdMicro.value
          : null,
        walletConcentrationBps: hasValue(holders.topWalletConcentrationBps)
          ? holders.topWalletConcentrationBps.value
          : null,
        programHeldBps: hasValue(holders.programHeldBps) ? holders.programHeldBps.value : null,
        mintAuthorityRevoked: hasValue(authorities.mintAuthorityRevoked)
          ? authorities.mintAuthorityRevoked.value
          : null,
        freezeAuthorityRevoked: hasValue(authorities.freezeAuthorityRevoked)
          ? authorities.freezeAuthorityRevoked.value
          : null,
      });
      summary.recorded += 1;
    }
  }

  const pruned = await deps.history.prune(clock());
  summary.downsampled = pruned.downsampledToMedium + pruned.downsampledToLow;
  summary.deleted = pruned.deleted;

  metrics.providerCall("moonpaper:history-pass", "ok");
  return summary;
}
