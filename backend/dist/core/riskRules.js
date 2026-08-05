/** Risk thresholds (ARB-009). Tune per token later via admin settings. */
export const RISK_LIMITS = {
    /** Combined buy+sell impact above this is rejected outright. */
    maxTotalImpactBps: 300n,
    /** Combined impact above this triggers a warning but not rejection. */
    warnImpactBps: 100n,
};
/** Warnings that make a result ineligible to be shown as a live opportunity. */
export const REJECTION_CODES = new Set([
    "STALE_QUOTE",
    "TOKEN_MISMATCH",
    "SAME_VENUE",
    "INCOMPLETE_DATA",
    "HIGH_PRICE_IMPACT",
    "LOW_LIQUIDITY",
]);
export function evaluateRisk(input, netProfitMicroUsd) {
    const { buyQuote, sellQuote, nowMs } = input;
    const warnings = [];
    if (nowMs >= buyQuote.expiresAtMs || nowMs >= sellQuote.expiresAtMs) {
        warnings.push("STALE_QUOTE");
    }
    // Identity is the immutable mint address, never the symbol (FR-01, required test case)
    if (buyQuote.tokenMint !== sellQuote.tokenMint) {
        warnings.push("TOKEN_MISMATCH");
    }
    if (buyQuote.venueId === sellQuote.venueId) {
        warnings.push("SAME_VENUE");
    }
    if (buyQuote.outAmount <= 0n ||
        sellQuote.outAmount <= 0n ||
        buyQuote.inAmount <= 0n ||
        sellQuote.inAmount <= 0n) {
        warnings.push("INCOMPLETE_DATA");
    }
    // The sell must consume exactly what the buy produced, or the round trip is fictional
    if (sellQuote.inAmount !== buyQuote.outAmount) {
        warnings.push("INCOMPLETE_DATA");
    }
    const totalImpact = buyQuote.priceImpactBps + sellQuote.priceImpactBps;
    if (totalImpact > RISK_LIMITS.maxTotalImpactBps) {
        warnings.push("HIGH_PRICE_IMPACT", "LOW_LIQUIDITY");
    }
    else if (totalImpact > RISK_LIMITS.warnImpactBps) {
        warnings.push("HIGH_PRICE_IMPACT");
    }
    if (netProfitMicroUsd <= 0n) {
        warnings.push("NOT_PROFITABLE");
    }
    return [...new Set(warnings)];
}
