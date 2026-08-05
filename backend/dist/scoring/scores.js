export const SCORING_CONFIG = {
    weights: { momentum: 0.3, liquidity: 0.25, execution: 0.25, safety: 0.2 },
    riskBands: { lowBelow: 30, mediumBelow: 60 },
    labels: { strongAtLeast: 70, moderateAtLeast: 55, weakAtLeast: 40 },
    caps: { highRiskCap: 35, poorExecutionCap: 45, belowMinLiquidityCap: 40 },
};
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
const pct = (bps) => Number(bps) / 100;
export function scoreMomentum(view) {
    const m = view.momentum.value;
    const factors = [];
    let score = 50;
    const chg1h = pct(m.change1hBps);
    if (chg1h >= 2) {
        const add = Math.min(20, chg1h * 2);
        score += add;
        factors.push({ id: "price-up-1h", label: "Price rising", detail: `Price is up ${chg1h.toFixed(1)}% over the last hour`, direction: "positive" });
    }
    else if (chg1h <= -2) {
        score += Math.max(-20, chg1h * 2);
        factors.push({ id: "price-down-1h", label: "Price falling", detail: `Price is down ${Math.abs(chg1h).toFixed(1)}% over the last hour`, direction: "negative" });
    }
    const volChg = pct(m.volumeChange1hBps);
    if (volChg >= 30) {
        score += 15;
        factors.push({ id: "volume-accel", label: "Volume accelerating", detail: `Trading volume is up ${volChg.toFixed(0)}% versus the previous hour`, direction: "positive" });
    }
    else if (volChg <= -20) {
        score -= 10;
        factors.push({ id: "volume-fading", label: "Volume fading", detail: `Trading volume is down ${Math.abs(volChg).toFixed(0)}% versus the previous hour`, direction: "negative" });
    }
    const ratio = Number(m.buySellRatioPct);
    if (ratio >= 115) {
        score += 10;
        factors.push({ id: "buy-pressure", label: "Buy pressure", detail: `${(ratio / 100).toFixed(2)} buys per sell over the last hour`, direction: "positive" });
    }
    else if (ratio <= 90) {
        score -= 10;
        factors.push({ id: "sell-pressure", label: "Sell pressure", detail: `Only ${(ratio / 100).toFixed(2)} buys per sell over the last hour`, direction: "negative" });
    }
    if (m.txCount1h >= 1000) {
        score += 5;
        factors.push({ id: "active-market", label: "Active market", detail: `${m.txCount1h.toLocaleString()} transactions in the last hour`, direction: "positive" });
    }
    const chg24h = pct(m.change24hBps);
    if (chg24h >= 150) {
        score -= 10;
        factors.push({ id: "parabolic", label: "Parabolic move", detail: `Already up ${chg24h.toFixed(0)}% in 24h — extended moves often retrace`, direction: "negative" });
    }
    if (view.momentum.reliability !== "fresh") {
        score = Math.min(score, 45);
        factors.push({ id: "stale-feed", label: "Stale price feed", detail: `Momentum data is ${Math.round(view.momentum.ageMs / 1000)}s old — treat with caution`, direction: "negative" });
    }
    return { score: clamp(score), factors };
}
export function scoreLiquidity(view, tradeSizeUsdMicro, limits) {
    const l = view.liquidity.value;
    const factors = [];
    const liqUsd = Number(l.totalUsdMicro / 1000000n);
    let score;
    if (liqUsd >= 5_000_000) {
        score = 85;
        factors.push({ id: "deep-liquidity", label: "Deep liquidity", detail: `$${(liqUsd / 1e6).toFixed(1)}M total liquidity`, direction: "positive" });
    }
    else if (liqUsd >= 1_000_000) {
        score = 65;
        factors.push({ id: "adequate-liquidity", label: "Adequate liquidity", detail: `$${(liqUsd / 1e6).toFixed(1)}M total liquidity`, direction: "neutral" });
    }
    else if (liqUsd >= 250_000) {
        score = 45;
        factors.push({ id: "thin-liquidity", label: "Thin liquidity", detail: `$${(liqUsd / 1e3).toFixed(0)}k total liquidity`, direction: "negative" });
    }
    else {
        score = 25;
        factors.push({ id: "very-thin-liquidity", label: "Very thin liquidity", detail: `Only $${(liqUsd / 1e3).toFixed(0)}k total liquidity`, direction: "negative" });
    }
    if (l.totalUsdMicro < limits.minLiquidityUsdMicro) {
        score -= 15;
        factors.push({ id: "below-user-min", label: "Below your minimum", detail: `Liquidity is under your configured minimum of $${(Number(limits.minLiquidityUsdMicro / 1000000n)).toLocaleString()}`, direction: "negative" });
    }
    const chg = pct(l.change1hBps);
    if (chg <= -10) {
        score -= 15;
        factors.push({ id: "liquidity-draining", label: "Liquidity draining", detail: `Liquidity fell ${Math.abs(chg).toFixed(1)}% in the last hour`, direction: "negative" });
    }
    else if (chg >= 5) {
        score += 5;
        factors.push({ id: "liquidity-growing", label: "Liquidity growing", detail: `Liquidity grew ${chg.toFixed(1)}% in the last hour`, direction: "positive" });
    }
    if (Number(l.topPoolShareBps) >= 9_000) {
        score -= 10;
        factors.push({ id: "single-pool", label: "Single-pool concentration", detail: "Nearly all liquidity sits in one pool", direction: "negative" });
    }
    // Trade size vs liquidity
    if (l.totalUsdMicro > 0n) {
        const ratioBps = Number((tradeSizeUsdMicro * 10000n) / l.totalUsdMicro);
        if (ratioBps >= 100) {
            score -= 10;
            factors.push({ id: "size-vs-liquidity", label: "Large for this pool", detail: `Your trade is ${(ratioBps / 100).toFixed(1)}% of total liquidity`, direction: "negative" });
        }
    }
    return { score: clamp(score), factors };
}
export function scoreExecution(routes, limits, nowMs) {
    const factors = [];
    if (!routes || !routes.best) {
        factors.push({ id: "no-route", label: "No executable route", detail: "No venue returned an executable quote for this size", direction: "negative" });
        return { score: 0, factors };
    }
    const best = routes.best;
    let score = 60;
    const impact = pct(best.priceImpactBps);
    const maxImpact = pct(limits.maxPriceImpactBps);
    if (best.priceImpactBps > limits.maxPriceImpactBps) {
        score -= 40;
        factors.push({ id: "impact-over-limit", label: "Impact over your limit", detail: `Estimated price impact ${impact.toFixed(2)}% exceeds your ${maxImpact.toFixed(2)}% limit`, direction: "negative" });
    }
    else if (impact <= 0.5) {
        score += 20;
        factors.push({ id: "low-impact", label: "Low price impact", detail: `Estimated price impact ${impact.toFixed(2)}% for this size`, direction: "positive" });
    }
    else {
        score += 5;
        factors.push({ id: "moderate-impact", label: "Moderate price impact", detail: `Estimated price impact ${impact.toFixed(2)}% for this size`, direction: "neutral" });
    }
    const quoteAge = Math.max(0, nowMs - best.retrievedAtMs);
    if (nowMs >= best.expiresAtMs) {
        score -= 30;
        factors.push({ id: "quote-expired", label: "Quote expired", detail: "The executable quote has expired and must be refreshed", direction: "negative" });
    }
    else {
        factors.push({ id: "quote-fresh", label: "Fresh quote", detail: `Executable quote is ${Math.round(quoteAge / 1000)}s old`, direction: "positive" });
    }
    const routeCount = 1 + routes.alternatives.length;
    if (routeCount >= 2) {
        score += 10;
        factors.push({ id: "route-choice", label: "Route choice", detail: `${routeCount} venues can fill this trade`, direction: "positive" });
    }
    else {
        score -= 10;
        factors.push({ id: "single-route", label: "Single route", detail: "Only one venue can fill this trade", direction: "negative" });
    }
    if (routes.failures.length > 0) {
        factors.push({ id: "route-failures", label: "Some venues unavailable", detail: routes.failures.map((f) => f.message).join("; "), direction: "neutral" });
    }
    const feeBps = Number(best.routeFeeBps);
    if (feeBps <= 25) {
        score += 5;
        factors.push({ id: "low-fees", label: "Low pool fee", detail: `Best route charges ${(feeBps / 100).toFixed(2)}%`, direction: "positive" });
    }
    return { score: clamp(score), factors };
}
export function scoreRisk(view) {
    const r = view.risk.value;
    const factors = [];
    let score = 10; // baseline residual risk
    if (r.tokenAgeDays < 7) {
        score += 30;
        factors.push({ id: "very-new", label: "Very new token", detail: `Token is only ${r.tokenAgeDays} day${r.tokenAgeDays === 1 ? "" : "s"} old`, direction: "negative" });
    }
    else if (r.tokenAgeDays < 30) {
        score += 15;
        factors.push({ id: "new-token", label: "New token", detail: `Token is ${r.tokenAgeDays} days old`, direction: "negative" });
    }
    else {
        factors.push({ id: "established", label: "Established token", detail: `Token has traded for ${r.tokenAgeDays} days`, direction: "positive" });
    }
    const conc = pct(r.holderConcentrationBps);
    if (conc >= 50) {
        score += 25;
        factors.push({ id: "high-concentration", label: "Concentrated holders", detail: `Top 10 wallets hold ${conc.toFixed(0)}% of supply`, direction: "negative" });
    }
    else if (conc >= 30) {
        score += 12;
        factors.push({ id: "elevated-concentration", label: "Elevated concentration", detail: `Top 10 wallets hold ${conc.toFixed(0)}% of supply`, direction: "negative" });
    }
    else {
        factors.push({ id: "distributed", label: "Distributed supply", detail: `Top 10 wallets hold ${conc.toFixed(0)}% of supply`, direction: "positive" });
    }
    if (!r.mintAuthorityRevoked) {
        score += 20;
        factors.push({ id: "mint-authority", label: "Mint authority live", detail: "The creator can still mint new supply at any time", direction: "negative" });
    }
    if (!r.freezeAuthorityRevoked) {
        score += 10;
        factors.push({ id: "freeze-authority", label: "Freeze authority live", detail: "The creator can freeze token accounts", direction: "negative" });
    }
    if (r.recentInsiderActivity) {
        score += 15;
        factors.push({ id: "insider-activity", label: "Insider movement", detail: "Large developer or early-holder transfers observed recently", direction: "negative" });
    }
    if (!r.dataComplete) {
        score += 10;
        factors.push({ id: "incomplete-risk-data", label: "Incomplete risk data", detail: "Some risk inputs could not be retrieved — treated as additional risk", direction: "negative" });
    }
    if (view.risk.reliability !== "fresh") {
        score += 5;
        factors.push({ id: "stale-risk-data", label: "Stale risk data", detail: `Risk data is ${Math.round(view.risk.ageMs / 60000)} min old`, direction: "negative" });
    }
    return { score: clamp(score), factors };
}
export function computeScores(view, routes, tradeSizeUsdMicro, limits, nowMs) {
    const momentum = scoreMomentum(view);
    const liquidity = scoreLiquidity(view, tradeSizeUsdMicro, limits);
    const execution = scoreExecution(routes, limits, nowMs);
    const risk = scoreRisk(view);
    const { weights, riskBands, labels, caps } = SCORING_CONFIG;
    const factors = [];
    let score = momentum.score * weights.momentum +
        liquidity.score * weights.liquidity +
        execution.score * weights.execution +
        (100 - risk.score) * weights.safety;
    const riskLevel = risk.score < riskBands.lowBelow ? "low" : risk.score < riskBands.mediumBelow ? "medium" : "high";
    if (riskLevel === "high" && score > caps.highRiskCap) {
        score = caps.highRiskCap;
        factors.push({ id: "capped-by-risk", label: "Capped by risk", detail: "Overall quality is capped because token risk is high", direction: "negative" });
    }
    if (execution.score < 30 && score > caps.poorExecutionCap) {
        score = caps.poorExecutionCap;
        factors.push({ id: "capped-by-execution", label: "Capped by execution", detail: "Overall quality is capped because execution quality is poor", direction: "negative" });
    }
    if (liquidity.factors.some((f) => f.id === "below-user-min") && score > caps.belowMinLiquidityCap) {
        score = caps.belowMinLiquidityCap;
        factors.push({ id: "capped-by-liquidity", label: "Capped by liquidity", detail: "Overall quality is capped because liquidity is below your minimum", direction: "negative" });
    }
    const rounded = clamp(score);
    const opportunityLabel = rounded >= labels.strongAtLeast ? "strong" : rounded >= labels.moderateAtLeast ? "moderate" : rounded >= labels.weakAtLeast ? "weak" : "avoid";
    // Surface the strongest evidence from each pillar so cards can show "why"
    const headline = [...momentum.factors, ...liquidity.factors, ...execution.factors]
        .filter((f) => f.direction === "positive")
        .slice(0, 3);
    const cautions = [...risk.factors, ...execution.factors, ...liquidity.factors]
        .filter((f) => f.direction === "negative")
        .slice(0, 3);
    return {
        momentum,
        liquidity,
        execution,
        risk,
        opportunity: { score: rounded, factors: [...factors, ...headline, ...cautions] },
        riskLevel,
        opportunityLabel,
    };
}
