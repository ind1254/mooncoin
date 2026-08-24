import type { PaperBotStrategyConfig } from "./types.js";
import type { LiveFeedToken } from "../market/jupiter/liveFeed.js";
import { assessLiveFeedToken, sumLiveFeedVolume, type LiveFeedAssessment } from "../market/feedAssessment.js";
import type { TradabilityPolicy } from "../market/tradability.js";

export interface PaperBotCandidate {
  token: LiveFeedToken;
  assessment: LiveFeedAssessment;
  accepted: boolean;
  reasons: string[];
}

export function assessPaperBotCandidate(
  token: LiveFeedToken,
  duplicateSymbolCount: number,
  strategy: PaperBotStrategyConfig,
  maxMarketAgeMs: number,
  nowMs: number,
): PaperBotCandidate {
  const policy: TradabilityPolicy = {
    minLiquidityUsdMicro: strategy.minLiquidityMicroUsd,
    maxPriceImpactBps: strategy.maxPriceImpactBps,
    maxMarketAgeMs,
  };
  const assessment = assessLiveFeedToken(token, nowMs, policy, duplicateSymbolCount);
  const reasons: string[] = [];
  if (assessment.status !== "active") reasons.push(`catalog status is ${assessment.status}`);
  if (assessment.qualityScore < strategy.minQualityScore) {
    reasons.push(`quality ${assessment.qualityScore} is below ${strategy.minQualityScore}`);
  }
  if (assessment.riskScore > strategy.maxRiskScore) {
    reasons.push(`risk ${assessment.riskScore} is above ${strategy.maxRiskScore}`);
  }
  const liquidity = token.token.market.liquidityUsdMicro;
  if (liquidity === null || liquidity < strategy.minLiquidityMicroUsd) {
    reasons.push("liquidity is below the strategy floor");
  }
  if (sumLiveFeedVolume(token, "fiveMinutes") === null) {
    reasons.push("five-minute volume is unavailable");
  }
  return { token, assessment, accepted: reasons.length === 0, reasons };
}

export type PaperBotExitReason = "liquidity_risk" | "stop_loss" | "take_profit" | "trailing_stop" | "max_hold";

export interface PaperBotExitEvaluation {
  shouldClose: boolean;
  reason: PaperBotExitReason | null;
  returnBps: bigint;
  drawdownFromHighBps: bigint;
  highWaterValueMicroUsd: bigint;
}

export function evaluatePaperBotExit(input: {
  entryCostMicroUsd: bigint;
  currentValueMicroUsd: bigint;
  previousHighWaterMicroUsd: bigint;
  openedAtMs: number;
  nowMs: number;
  currentPriceImpactBps: bigint;
  strategy: PaperBotStrategyConfig;
}): PaperBotExitEvaluation {
  const highWater = input.currentValueMicroUsd > input.previousHighWaterMicroUsd
    ? input.currentValueMicroUsd
    : input.previousHighWaterMicroUsd;
  const returnBps = ((input.currentValueMicroUsd - input.entryCostMicroUsd) * 10_000n) / input.entryCostMicroUsd;
  const drawdownFromHighBps = ((input.currentValueMicroUsd - highWater) * 10_000n) / highWater;
  const heldMs = Math.max(0, input.nowMs - input.openedAtMs);

  let reason: PaperBotExitReason | null = null;
  if (input.currentPriceImpactBps > input.strategy.maxPriceImpactBps * 2n) reason = "liquidity_risk";
  else if (returnBps <= -input.strategy.stopLossBps) reason = "stop_loss";
  else if (returnBps >= input.strategy.takeProfitBps) reason = "take_profit";
  else if (
    input.strategy.trailingStopBps > 0n &&
    highWater > input.entryCostMicroUsd &&
    drawdownFromHighBps <= -input.strategy.trailingStopBps
  ) reason = "trailing_stop";
  else if (heldMs >= input.strategy.maxHoldMinutes * 60_000) reason = "max_hold";

  return {
    shouldClose: reason !== null,
    reason,
    returnBps,
    drawdownFromHighBps,
    highWaterValueMicroUsd: highWater,
  };
}

export function duplicateSymbolCounts(tokens: LiveFeedToken[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const key = token.token.symbol.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
