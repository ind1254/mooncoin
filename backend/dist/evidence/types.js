/**
 * The canonical evidence representation.
 *
 * Moonpaper has four assessment paths — the live-feed assessment, detailed
 * research, the scoring pillars, and the tradability gates. They are NOT
 * duplicates: each answers a different question from a different input, and
 * collapsing them would lose information. What they lacked was a shared way to
 * state the *facts* they reason from, so every consumer re-derived provenance
 * in its own shape and a fact could not be carried between them, stored, or
 * diffed against an earlier observation.
 *
 * This module is that shared representation, and nothing more. It changes no
 * behaviour on its own: it is the substrate the versioned risk engine,
 * lifecycle timestamps, wallet cohorts, historical snapshots and risk-change
 * explanations are all built on.
 *
 * The rule it exists to enforce: a value never travels without the story of
 * where it came from and how much it can be trusted.
 */
/** Statuses that carry a usable value. `unavailable` never does. */
export const USABLE_STATUSES = [
    "verified",
    "reported",
    "derived",
    "stale",
];
/** A value read directly from the chain. */
export const verified = (input) => input.value === null ? unavailable(input) : { ...input, value: input.value, status: "verified" };
/** An external provider's claim. Believed, not confirmed. */
export const reported = (input) => input.value === null ? unavailable(input) : { ...input, value: input.value, status: "reported" };
/** Computed by us. Never more trustworthy than the inputs it came from. */
export const derived = (input) => input.value === null ? unavailable(input) : { ...input, value: input.value, status: "derived" };
/** Genuinely observed, but past the point where it should drive a decision. */
export const stale = (input) => ({
    ...input,
    status: "stale",
});
/**
 * No value. The `value` is forced to null so a caller cannot ship a number
 * alongside a claim that there is no number.
 */
export const unavailable = (input) => ({
    ...input,
    value: null,
    status: "unavailable",
});
/** True when the evidence carries a value that may be used. */
export const hasValue = (e) => e !== undefined && e.value !== null && e.status !== "unavailable";
/**
 * Re-label evidence as stale once it is older than `maxAgeMs`.
 *
 * Freshness is a property of the reader's tolerance, not of the fact, so it is
 * applied at the point of use rather than baked in at observation.
 */
export function withFreshness(e, nowMs, maxAgeMs) {
    if (e.status === "unavailable" || e.value === null)
        return e;
    const ageMs = nowMs - e.observedAt;
    if (ageMs <= maxAgeMs)
        return e;
    return {
        ...e,
        status: "stale",
        detail: e.detail ?? `Observed ${Math.round(ageMs / 1000)}s ago, past the ${Math.round(maxAgeMs / 1000)}s limit`,
    };
}
/** Walks a snapshot and collects the paths of everything unavailable. */
export function collectUnavailable(groups) {
    const missing = [];
    for (const [groupName, group] of Object.entries(groups)) {
        for (const [field, evidence] of Object.entries(group)) {
            if (!hasValue(evidence))
                missing.push(`${groupName}.${field}`);
        }
    }
    return missing.sort();
}
/** Every distinct source across a snapshot's groups, ignoring absent facts. */
export function collectSources(groups) {
    const sources = new Set();
    for (const group of Object.values(groups)) {
        for (const evidence of Object.values(group)) {
            if (hasValue(evidence))
                sources.add(evidence.source);
        }
    }
    return [...sources].sort();
}
