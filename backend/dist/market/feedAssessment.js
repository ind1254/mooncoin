export function sumLiveFeedVolume(token, window) {
    const value = token[window];
    if (value.buyVolumeUsdMicro === null && value.sellVolumeUsdMicro === null)
        return null;
    return (value.buyVolumeUsdMicro ?? 0n) + (value.sellVolumeUsdMicro ?? 0n);
}
/**
 * Fast catalog-only assessment used by both the feed UI and the paper bot's
 * prefilter. It is not a production-eligibility verdict; any entry still has
 * to pass fresh Solana authority reads and an exact-size Jupiter quote.
 */
export function assessLiveFeedToken(token, nowMs, policy, duplicateSymbolCount) {
    const market = token.token.market;
    const liquidity = market.liquidityUsdMicro;
    const topHolders = market.topHolderPctBps;
    const ageMs = token.firstPoolAtMs === null ? null : Math.max(0, nowMs - token.firstPoolAtMs);
    const marketAgeMs = token.updatedAtMs === null ? null : Math.max(0, nowMs - token.updatedAtMs);
    const authority = token.token.providerClaims;
    let risk = 0;
    const warnings = [];
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
    }
    else if (liquidity < policy.minLiquidityUsdMicro * 5n) {
        risk += 14;
        warnings.push("Thin liquidity");
    }
    if (topHolders === null) {
        risk += 8;
        warnings.push("Holder concentration unavailable");
    }
    else if (topHolders >= 4000n) {
        risk += 28;
        warnings.push("Top holders control at least 40%");
    }
    else if (topHolders >= 2000n) {
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
    if (ageMs !== null && ageMs < 10 * 60_000) {
        risk += 10;
        warnings.push("Pool detected less than 10 minutes ago");
    }
    const fiveMinuteVolume = sumLiveFeedVolume(token, "fiveMinutes") ?? 0n;
    let quality = 0;
    if (liquidity !== null) {
        quality += liquidity >= 1000000n * 1000000n
            ? 30
            : liquidity >= 250000n * 1000000n
                ? 24
                : liquidity >= 50000n * 1000000n
                    ? 17
                    : liquidity >= 10000n * 1000000n
                        ? 9
                        : 2;
    }
    quality += fiveMinuteVolume >= 100000n * 1000000n
        ? 25
        : fiveMinuteVolume >= 25000n * 1000000n
            ? 19
            : fiveMinuteVolume >= 5000n * 1000000n
                ? 12
                : fiveMinuteVolume > 0n
                    ? 5
                    : 0;
    quality += token.fiveMinutes.traders !== null ? Math.min(15, Math.round(token.fiveMinutes.traders / 10)) : 0;
    quality += Math.min(15, Math.max(0, Math.round((market.organicScore ?? 0) * 0.15)));
    quality += authority.mintAuthorityDisabled === true ? 8 : 0;
    quality += authority.freezeAuthorityDisabled === true ? 7 : 0;
    quality = Math.max(0, Math.min(100, quality - Math.floor(risk / 4)));
    const status = marketAgeMs === null || marketAgeMs > policy.maxMarketAgeMs
        ? "stale"
        : market.priceUsdPico === null || liquidity === null
            ? "detected"
            : liquidity < policy.minLiquidityUsdMicro
                ? "thin"
                : "active";
    const riskLevel = risk >= 45 ? "high" : risk >= 20 ? "medium" : "low";
    return {
        status,
        qualityScore: quality,
        riskScore: Math.min(100, risk),
        riskLevel,
        warnings: warnings.slice(0, 4),
        duplicateSymbolCount,
        eligibility: status === "active"
            ? "Catalog gates passed. Run the production check to verify the route and on-chain authorities."
            : status === "stale"
                ? "Market data is stale or undated, so production eligibility is blocked."
                : status === "thin"
                    ? `Liquidity is below Moonpaper's $${(policy.minLiquidityUsdMicro / 1000000n).toString()} production threshold.`
                    : "Detected by Jupiter, but complete pricing and liquidity are not available yet.",
    };
}
