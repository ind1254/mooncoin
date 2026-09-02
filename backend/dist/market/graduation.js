import { assessLiveFeedToken } from "./feedAssessment.js";
export async function runGraduationPass(deps) {
    const clock = deps.clock ?? Date.now;
    const kinds = deps.kinds ?? ["trending", "recent"];
    const summary = {
        scanned: 0,
        promoted: 0,
        byReason: { market_maturity: 0, quality_threshold: 0 },
    };
    // One mint can appear in more than one feed; promote it once per pass.
    const seen = new Set();
    for (const kind of kinds) {
        const feed = await deps.getFeed(kind);
        const nowMs = clock();
        // Duplicate-symbol counting mirrors the feed route: a ticker shared by
        // several mints is a risk signal, and the assessment needs the count.
        const symbolMints = new Map();
        for (const item of feed.tokens) {
            const key = item.token.symbol.toLowerCase();
            const mints = symbolMints.get(key) ?? new Set();
            mints.add(item.token.mint);
            symbolMints.set(key, mints);
        }
        for (const item of feed.tokens) {
            summary.scanned += 1;
            if (seen.has(item.token.mint))
                continue;
            const assessment = assessLiveFeedToken(item, nowMs, deps.policy, symbolMints.get(item.token.symbol.toLowerCase())?.size ?? 1);
            if (!assessment.graduated || assessment.graduationReason === null)
                continue;
            seen.add(item.token.mint);
            await deps.autoWatch.promote({
                tokenMint: item.token.mint,
                reason: assessment.graduationReason,
                symbol: item.token.symbol,
                name: item.token.name,
                qualityScore: assessment.qualityScore,
                riskScore: assessment.riskScore,
                scoreVersion: assessment.scoreVersion,
            });
            summary.promoted += 1;
            summary.byReason[assessment.graduationReason] += 1;
        }
    }
    return summary;
}
