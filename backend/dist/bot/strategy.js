import { assessLiveFeedToken, sumLiveFeedVolume } from "../market/feedAssessment.js";
export function assessPaperBotCandidate(token, duplicateSymbolCount, strategy, maxMarketAgeMs, nowMs) {
    const policy = {
        minLiquidityUsdMicro: strategy.minLiquidityMicroUsd,
        maxPriceImpactBps: strategy.maxPriceImpactBps,
        maxMarketAgeMs,
    };
    const assessment = assessLiveFeedToken(token, nowMs, policy, duplicateSymbolCount);
    const reasons = [];
    if (assessment.status !== "active")
        reasons.push(`catalog status is ${assessment.status}`);
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
export function evaluatePaperBotExit(input) {
    const highWater = input.currentValueMicroUsd > input.previousHighWaterMicroUsd
        ? input.currentValueMicroUsd
        : input.previousHighWaterMicroUsd;
    const returnBps = ((input.currentValueMicroUsd - input.entryCostMicroUsd) * 10000n) / input.entryCostMicroUsd;
    const drawdownFromHighBps = ((input.currentValueMicroUsd - highWater) * 10000n) / highWater;
    const heldMs = Math.max(0, input.nowMs - input.openedAtMs);
    let reason = null;
    if (input.currentPriceImpactBps > input.strategy.maxPriceImpactBps * 2n)
        reason = "liquidity_risk";
    else if (returnBps <= -input.strategy.stopLossBps)
        reason = "stop_loss";
    else if (returnBps >= input.strategy.takeProfitBps)
        reason = "take_profit";
    else if (input.strategy.trailingStopBps > 0n &&
        highWater > input.entryCostMicroUsd &&
        drawdownFromHighBps <= -input.strategy.trailingStopBps)
        reason = "trailing_stop";
    else if (heldMs >= input.strategy.maxHoldMinutes * 60_000)
        reason = "max_hold";
    return {
        shouldClose: reason !== null,
        reason,
        returnBps,
        drawdownFromHighBps,
        highWaterValueMicroUsd: highWater,
    };
}
export function duplicateSymbolCounts(tokens) {
    const counts = new Map();
    for (const token of tokens) {
        const key = token.token.symbol.trim().toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}
