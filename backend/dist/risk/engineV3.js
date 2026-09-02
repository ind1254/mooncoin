import { hasValue, } from "../evidence/types.js";
/**
 * Risk engine v3 — versioned, explainable risk over structured evidence.
 *
 * Three properties are non-negotiable and are what this module exists to
 * guarantee:
 *
 * 1. **Every point is attributable.** There is no opaque score. Each factor
 *    states the observation, what it may imply, and exactly how many points it
 *    contributed. A reader can always reconstruct the total by hand.
 *
 * 2. **Missing evidence is never safe.** An unreadable mint authority scores
 *    WORSE than a confirmed-revoked one and only slightly better than a
 *    confirmed-live one, because "we could not check" is a genuine hazard and
 *    not a clean bill of health. It also costs confidence, so the caller can
 *    tell a low score backed by facts from a low score backed by silence.
 *
 * 3. **Direct chain evidence outranks provider claims.** A factor resolved
 *    from a `verified` reading carries its full weight; the same factor
 *    resolved from a `reported` provider claim is discounted, because a claim
 *    the chain has not confirmed is exactly the sort of thing that is wrong
 *    when it matters most.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * Risk is not opportunity, and this never returns an opportunity score. A
 * risky token can have real momentum; a perfectly safe token can be a terrible
 * trade. Momentum, market quality and execution quality are scored elsewhere
 * and are kept separate on purpose — collapsing them into one number is how a
 * tool starts implying that "low risk" means "good trade", which is advice,
 * and is not what this product does.
 *
 * Risk here means one thing: **how likely is this token to harm a holder
 * through its own structure or conditions** — authorities that can rug it,
 * ownership that can dump it, liquidity that cannot absorb an exit, or an
 * identity that is not what it appears to be.
 */
/**
 * Bump on ANY change to factor weights, thresholds or the factor set.
 *
 * Stored alongside every score so a historical row is never silently compared
 * against a number a different model produced. Semver: major for a changed
 * meaning of the score, minor for a new factor, patch for wording.
 */
export const RISK_MODEL_VERSION = "risk-v3.0.0";
/**
 * How far a factor's points count, by the authority of its evidence.
 *
 * A provider claim is not worthless — it is usually right — but it is not the
 * chain, and the gap is where rugs live.
 */
const AUTHORITY_WEIGHT = {
    verified: 1,
    reported: 0.8,
    derived: 0.8,
    stale: 0.5,
    unavailable: 0,
};
/** How much each factor contributes to confidence when it resolves cleanly. */
const CONFIDENCE_WEIGHT = {
    verified: 1,
    reported: 0.8,
    derived: 0.75,
    stale: 0.35,
    unavailable: 0,
};
/** Scores one factor and records its confidence contribution. */
function evaluate(id, label, evidence, present, absent) {
    const usable = hasValue(evidence);
    const outcome = usable ? present(evidence.value) : absent;
    // An absent factor still contributes its (penalising) points at full weight:
    // the hazard is the not-knowing, so discounting it by authority would make
    // ignorance cheaper the less we know, which is exactly backwards.
    const weight = usable ? AUTHORITY_WEIGHT[evidence.status] : 1;
    const points = Math.round(outcome.points * weight);
    return {
        factor: {
            id,
            label,
            fact: outcome.fact,
            interpretation: outcome.interpretation,
            points,
            direction: outcome.direction ?? (points > 0 ? "increases" : points < 0 ? "decreases" : "neutral"),
            status: evidence.status,
            source: evidence.source,
        },
        confidence: CONFIDENCE_WEIGHT[evidence.status],
        maxConfidence: 1,
    };
}
const pct = (bps) => `${(Number(bps) / 100).toFixed(1)}%`;
const usd = (micro) => `$${(Number(micro) / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
export const DEFAULT_RISK_POLICY = {
    minLiquidityUsdMicro: 10000n * 1000000n,
    maxPriceImpactBps: 300n,
};
/**
 * Score a snapshot.
 *
 * Deterministic and pure: the same snapshot always yields the same assessment,
 * which is what makes a stored score comparable and a risk *change* explainable
 * later.
 */
export function assessRisk(snapshot, policy = DEFAULT_RISK_POLICY) {
    const results = [];
    // --- Authorities: what the owner can still do to holders -----------------
    results.push(evaluate("mint_authority", "Mint authority", snapshot.authorities.mintAuthorityRevoked, (revoked) => revoked
        ? { points: 0, fact: "Mint authority is revoked.", interpretation: "New supply cannot be minted.", direction: "decreases" }
        : { points: 26, fact: "Mint authority is still active.", interpretation: "The owner can mint new supply and dilute holders at any time." }, {
        points: 18,
        fact: "Mint authority could not be established.",
        interpretation: "An unverified authority is treated as a hazard, not as safe.",
    }));
    results.push(evaluate("freeze_authority", "Freeze authority", snapshot.authorities.freezeAuthorityRevoked, (revoked) => revoked
        ? { points: 0, fact: "Freeze authority is revoked.", interpretation: "Balances cannot be frozen.", direction: "decreases" }
        : { points: 22, fact: "Freeze authority is still active.", interpretation: "The owner can freeze accounts, which can prevent selling." }, {
        points: 15,
        fact: "Freeze authority could not be established.",
        interpretation: "An unverified authority is treated as a hazard, not as safe.",
    }));
    // A provider that disagrees with the chain is a signal in its own right.
    results.push(evaluate("provider_agreement", "Provider agreement", snapshot.authorities.providerAgreement, (agreement) => agreement === "disagrees"
        ? { points: 14, fact: "The provider's authority claim disagrees with the chain.", interpretation: "Listings for this token are carrying inaccurate safety information." }
        : agreement === "agrees"
            ? { points: 0, fact: "The provider's authority claim matches the chain.", interpretation: "Listing data is consistent with what the chain says.", direction: "decreases" }
            : { points: 2, fact: "The provider did not report authority status.", interpretation: "Nothing to cross-check against the chain.", direction: "neutral" }, { points: 3, fact: "Provider agreement was not assessed.", interpretation: "No chain read was available to compare against.", direction: "neutral" }));
    // --- Ownership concentration --------------------------------------------
    results.push(evaluate("holder_concentration", "Wallet concentration", snapshot.holders.topWalletConcentrationBps, (bps) => {
        const points = bps >= 6000n ? 24 : bps >= 4000n ? 18 : bps >= 2500n ? 11 : bps >= 1500n ? 5 : 0;
        return {
            points,
            fact: `Top wallet holders control ${pct(bps)} of supply.`,
            interpretation: points === 0
                ? "Ownership is spread widely enough that no single seller dominates."
                : "Concentrated ownership means a small number of sellers can move the price sharply.",
            direction: points === 0 ? "decreases" : "increases",
        };
    }, {
        points: 12,
        fact: "Wallet concentration could not be measured.",
        interpretation: "Ownership distribution is unknown, which is not the same as being well distributed.",
    }));
    // Incomplete classification is its own hazard: the headline concentration
    // figure is understated by exactly the amount we failed to attribute.
    results.push(evaluate("holder_classification", "Holder classification", snapshot.holders.unclassifiedBps, (bps) => bps > 0n
        ? { points: 6, fact: `${pct(bps)} of supply could not be classified as wallet or program.`, interpretation: "The concentration figure understates ownership by at least this much." }
        : { points: 0, fact: "All top holders were classified.", interpretation: "The concentration figure is complete.", direction: "decreases" }, { points: 4, fact: "Holder classification was not attempted.", interpretation: "Pool-held supply cannot be separated from wallet-held supply." }));
    // --- Liquidity: can a holder actually get out? ---------------------------
    results.push(evaluate("liquidity_depth", "Liquidity", snapshot.liquidity.liquidityUsdMicro, (micro) => {
        const floor = policy.minLiquidityUsdMicro;
        const points = micro < floor / 2n ? 22 : micro < floor ? 14 : micro < floor * 5n ? 6 : 0;
        return {
            points,
            fact: `Reported liquidity is ${usd(micro)}.`,
            interpretation: points === 0
                ? "There is enough depth to absorb a normal exit."
                : "Thin liquidity means an exit may move the price against the seller.",
            direction: points === 0 ? "decreases" : "increases",
        };
    }, { points: 16, fact: "Liquidity could not be established.", interpretation: "Whether an exit is possible at all is unknown." }));
    // --- Execution: what an exit would actually cost now ---------------------
    const execution = snapshot.execution;
    if (execution) {
        results.push(evaluate("execution_impact", "Price impact", execution.priceImpactBps, (bps) => {
            const limit = policy.maxPriceImpactBps;
            const points = bps > limit * 3n ? 20 : bps > limit ? 12 : bps > limit / 2n ? 5 : 0;
            return {
                points,
                fact: `A trade of this size moves the price ${pct(bps)}.`,
                interpretation: points === 0
                    ? "The market absorbs this size without a material move."
                    : "The cost of entering and exiting at this size is material.",
                direction: points === 0 ? "decreases" : "increases",
            };
        }, { points: 10, fact: "No executable quote was available.", interpretation: "The real cost of a trade at this size is unknown." }));
    }
    // --- Identity: is this the token it appears to be? -----------------------
    results.push(evaluate("ticker_ambiguity", "Ticker ambiguity", snapshot.identity.duplicateSymbolCount, (count) => count > 1
        ? { points: 9, fact: `${count} distinct mints share this ticker.`, interpretation: "A ticker is not an identity; the wrong mint is easy to buy by mistake." }
        : { points: 0, fact: "This ticker resolves to a single mint.", interpretation: "No identity ambiguity for this symbol.", direction: "decreases" }, { points: 3, fact: "Ticker ambiguity was not measured.", interpretation: "Whether other mints share this symbol is unknown.", direction: "neutral" }));
    // --- Freshness: is any of this still true? -------------------------------
    results.push(evaluate("market_freshness", "Data freshness", snapshot.freshness.marketAgeMs, (ageMs) => {
        const points = ageMs > 300_000 ? 12 : ageMs > 60_000 ? 6 : 0;
        return {
            points,
            fact: `Market data was observed ${Math.round(ageMs / 1000)}s ago.`,
            interpretation: points === 0
                ? "The market view is current."
                : "Conditions may have changed since this was observed.",
            direction: points === 0 ? "decreases" : "increases",
        };
    }, { points: 8, fact: "Market observation time is unknown.", interpretation: "The age of this data cannot be established." }));
    const factors = results.map((r) => r.factor);
    const rawScore = factors.reduce((total, f) => total + f.points, 0);
    const riskScore = Math.max(0, Math.min(100, rawScore));
    const confidenceEarned = results.reduce((total, r) => total + r.confidence, 0);
    const confidenceMax = results.reduce((total, r) => total + r.maxConfidence, 0);
    const riskConfidence = confidenceMax === 0 ? 0 : Math.round((confidenceEarned / confidenceMax) * 100);
    return {
        riskScore,
        riskConfidence,
        riskLevel: riskScore >= 45 ? "high" : riskScore >= 20 ? "medium" : "low",
        riskModelVersion: RISK_MODEL_VERSION,
        // Loudest first: the reader should see what drove the score.
        factors: [...factors].sort((a, b) => b.points - a.points),
        missingEvidence: snapshot.unavailableEvidence,
        observedAt: snapshot.observedAt,
    };
}
