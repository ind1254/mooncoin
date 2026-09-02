import { assessRisk } from "../risk/engineV3.js";
import { snapshotFromFeedToken } from "../evidence/build.js";
import { hasValue } from "../evidence/types.js";
import { metrics } from "../observability/metrics.js";
export async function runHistoryPass(deps) {
    const clock = deps.clock ?? Date.now;
    const kinds = deps.kinds ?? ["trending", "recent"];
    const maxTokens = deps.maxTokens ?? 120;
    const riskPolicy = {
        minLiquidityUsdMicro: deps.policy.minLiquidityUsdMicro,
        maxPriceImpactBps: deps.policy.maxPriceImpactBps,
    };
    const summary = { scanned: 0, recorded: 0, downsampled: 0, deleted: 0 };
    // A mint can appear in both feeds; record it once per pass so the write
    // stays idempotent on (mint, observed_at).
    const seen = new Set();
    for (const kind of kinds) {
        const feed = await deps.getFeed(kind);
        const nowMs = clock();
        const symbolMints = new Map();
        for (const item of feed.tokens) {
            const key = item.token.symbol.toLowerCase();
            const mints = symbolMints.get(key) ?? new Set();
            mints.add(item.token.mint);
            symbolMints.set(key, mints);
        }
        for (const item of feed.tokens) {
            if (seen.size >= maxTokens)
                break;
            summary.scanned += 1;
            if (seen.has(item.token.mint))
                continue;
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
