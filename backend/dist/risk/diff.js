import { hasValue } from "../evidence/types.js";
const byId = (factors) => new Map(factors.map((f) => [f.id, f]));
/**
 * Explain the move between two assessments of the same token.
 *
 * Both must come from the same risk model version. A stored assessment carries
 * the version that produced it precisely so this check can be made.
 */
export function explainRiskChange(previous, current) {
    const base = {
        previousScore: previous.riskScore,
        currentScore: current.riskScore,
        delta: current.riskScore - previous.riskScore,
        previousConfidence: previous.riskConfidence,
        currentConfidence: current.riskConfidence,
        confidenceDelta: current.riskConfidence - previous.riskConfidence,
        riskModelVersion: current.riskModelVersion,
        previousObservedAt: previous.observedAt,
        currentObservedAt: current.observedAt,
    };
    if (previous.riskModelVersion !== current.riskModelVersion) {
        // Two models, two scales. Subtracting them would look authoritative and
        // mean nothing.
        return {
            ...base,
            comparable: false,
            incomparableReason: `Scored by different risk models (${previous.riskModelVersion} then ${current.riskModelVersion}); the two scores are not on the same scale.`,
            lines: [],
            evidenceLost: [],
            evidenceGained: [],
        };
    }
    const before = byId(previous.factors);
    const after = byId(current.factors);
    const lines = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
        const prev = before.get(id);
        const curr = after.get(id);
        const delta = (curr?.points ?? 0) - (prev?.points ?? 0);
        if (delta === 0)
            continue;
        const label = curr?.label ?? prev?.label ?? id;
        // A factor that stopped resolving is a distinct event from one whose value
        // changed, and saying so is the difference between "concentration rose"
        // and "we stopped being able to measure concentration".
        let explanation;
        if (prev && curr && prev.status !== "unavailable" && curr.status === "unavailable") {
            explanation = `${label} could no longer be measured — ${curr.fact}`;
        }
        else if (prev && curr && prev.status === "unavailable" && curr.status !== "unavailable") {
            explanation = `${label} became measurable — ${curr.fact}`;
        }
        else if (!prev && curr) {
            explanation = `${label} entered the assessment — ${curr.fact}`;
        }
        else if (prev && !curr) {
            explanation = `${label} left the assessment — it was: ${prev.fact}`;
        }
        else {
            explanation = curr.fact;
        }
        lines.push({ id, label, delta, explanation });
    }
    // Confidence moves without changing the score, so it is reported as its own
    // line rather than folded into a factor.
    if (base.confidenceDelta !== 0) {
        lines.push({
            id: "evidence_confidence",
            label: "Evidence confidence",
            delta: 0,
            explanation: base.confidenceDelta > 0
                ? `Evidence confidence rose ${base.confidenceDelta} points to ${current.riskConfidence}.`
                : `Evidence confidence fell ${Math.abs(base.confidenceDelta)} points to ${current.riskConfidence}, so this score rests on less.`,
        });
    }
    const previousMissing = new Set(previous.missingEvidence);
    const currentMissing = new Set(current.missingEvidence);
    return {
        ...base,
        comparable: true,
        // Largest mover first; the confidence line has delta 0 and sorts last.
        lines: lines.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
        evidenceLost: [...currentMissing].filter((path) => !previousMissing.has(path)).sort(),
        evidenceGained: [...previousMissing].filter((path) => !currentMissing.has(path)).sort(),
    };
}
/**
 * Render a change as the terse block the token page and alerts show.
 *
 * Deliberately plain text built by concatenation: what the user reads is the
 * same thing the tests assert, so the explanation cannot drift from the data.
 */
export function formatRiskChange(change) {
    if (!change.comparable)
        return change.incomparableReason ?? "Not comparable.";
    const sign = change.delta > 0 ? "+" : "";
    const header = `Risk ${change.previousScore} -> ${change.currentScore} (${sign}${change.delta})`;
    const body = change.lines
        .filter((line) => line.delta !== 0)
        .map((line) => `  ${line.delta > 0 ? "+" : ""}${line.delta}  ${line.explanation}`);
    const confidence = change.lines.find((line) => line.id === "evidence_confidence");
    if (confidence)
        body.push(`   0  ${confidence.explanation}`);
    return [header, ...body].join("\n");
}
const format = (value) => typeof value === "bigint" ? value.toString() : String(value);
function numeric(value) {
    if (typeof value === "bigint")
        return Number(value);
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    return null;
}
/**
 * Compare the evidence behind two snapshots, field by field.
 *
 * Complements the risk diff: a change can matter to a holder without moving
 * the risk score at all (liquidity halving inside a band, say), and this is
 * where that shows up.
 */
export function diffEvidence(previous, current, groups = [
    "market",
    "liquidity",
    "holders",
    "authorities",
    "walletBehaviour",
]) {
    const changes = [];
    for (const group of groups) {
        const prevGroup = previous[group];
        const currGroup = current[group];
        if (!prevGroup || !currGroup)
            continue;
        for (const field of Object.keys(currGroup)) {
            const prev = prevGroup[field];
            const curr = currGroup[field];
            if (!prev || !curr)
                continue;
            const prevUsable = hasValue(prev);
            const currUsable = hasValue(curr);
            if (!prevUsable && !currUsable)
                continue;
            if (prevUsable && !currUsable) {
                changes.push({
                    path: `${group}.${field}`,
                    previous: format(prev.value),
                    current: null,
                    changePct: null,
                    note: "Stopped being measurable",
                });
                continue;
            }
            if (!prevUsable && currUsable) {
                changes.push({
                    path: `${group}.${field}`,
                    previous: null,
                    current: format(curr.value),
                    changePct: null,
                    note: "Became measurable",
                });
                continue;
            }
            if (format(prev.value) === format(curr.value))
                continue;
            const a = numeric(prev.value);
            const b = numeric(curr.value);
            const changePct = a !== null && b !== null && a !== 0 ? ((b - a) / Math.abs(a)) * 100 : null;
            changes.push({
                path: `${group}.${field}`,
                previous: format(prev.value),
                current: format(curr.value),
                changePct,
                note: changePct === null
                    ? "Changed"
                    : `${changePct > 0 ? "Rose" : "Fell"} ${Math.abs(changePct).toFixed(1)}%`,
            });
        }
    }
    return changes.sort((x, y) => Math.abs(y.changePct ?? 0) - Math.abs(x.changePct ?? 0));
}
