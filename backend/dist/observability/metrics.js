/**
 * Provider-level operational metrics.
 *
 * The application already logs structured lines per request. What it could not
 * answer was the question that actually matters when production degrades:
 * *which provider is failing, how, and how often.* "Quotes are slow" and
 * "Jupiter is returning 429s to a third of our calls" call for entirely
 * different responses, and the logs made you grep for the difference.
 *
 * Deliberately in-process and unbounded-free: counters and a small latency
 * reservoir, no external metrics backend, no per-token cardinality. On
 * serverless this resets when an instance recycles, which is stated rather
 * than hidden — these numbers describe one instance's recent life, not a
 * global truth, and the snapshot says so.
 *
 * SECURITY: nothing here may ever record a secret. Metrics are keyed by
 * provider and outcome only — never a URL with a query string, an API key, a
 * session token, a recovery or verification token, an email, or a mint the
 * user searched for. The recorder takes a fixed enum of outcomes precisely so
 * a caller cannot pass arbitrary text that later turns out to contain one.
 */
const EMPTY_OUTCOMES = () => ({
    ok: 0,
    timeout: 0,
    rate_limited: 0,
    malformed: 0,
    unavailable: 0,
    not_found: 0,
    error: 0,
});
/** Bounded so a long-lived instance cannot grow this without limit. */
const LATENCY_SAMPLE_LIMIT = 500;
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index] ?? 0;
}
export class MetricsRegistry {
    clock;
    providers = new Map();
    gateRejections = new Map();
    botDecisions = new Map();
    componentFailures = new Map();
    workerRuns = 0;
    workerFailures = 0;
    lastWorkerDurationMs = null;
    startedAt;
    constructor(clock = Date.now) {
        this.clock = clock;
        this.startedAt = clock();
    }
    record(provider) {
        let entry = this.providers.get(provider);
        if (!entry) {
            entry = { calls: 0, byOutcome: EMPTY_OUTCOMES(), cacheHits: 0, cacheMisses: 0, latencies: [] };
            this.providers.set(provider, entry);
        }
        return entry;
    }
    /**
     * Record one provider call.
     *
     * `provider` is a stable identifier such as "jupiter:quote" or
     * "solana:rpc" — never a URL, which could carry a key in its query string.
     */
    providerCall(provider, outcome, latencyMs) {
        const entry = this.record(provider);
        entry.calls += 1;
        entry.byOutcome[outcome] += 1;
        if (latencyMs !== undefined && Number.isFinite(latencyMs)) {
            if (entry.latencies.length >= LATENCY_SAMPLE_LIMIT)
                entry.latencies.shift();
            entry.latencies.push(Math.max(0, Math.round(latencyMs)));
        }
    }
    cache(provider, outcome) {
        const entry = this.record(provider);
        if (outcome === "hit")
            entry.cacheHits += 1;
        else
            entry.cacheMisses += 1;
    }
    /** `reason` is a gate id from the tradability service, not free text. */
    gateRejection(reason) {
        this.gateRejections.set(reason, (this.gateRejections.get(reason) ?? 0) + 1);
    }
    botDecision(decision) {
        this.botDecisions.set(decision, (this.botDecisions.get(decision) ?? 0) + 1);
    }
    workerPass(durationMs, failedComponents = []) {
        this.workerRuns += 1;
        this.lastWorkerDurationMs = durationMs;
        if (failedComponents.length > 0)
            this.workerFailures += 1;
        for (const component of failedComponents) {
            this.componentFailures.set(component, (this.componentFailures.get(component) ?? 0) + 1);
        }
    }
    snapshot() {
        const now = this.clock();
        return {
            since: this.startedAt,
            uptimeMs: Math.max(0, now - this.startedAt),
            scope: "single-instance",
            providers: [...this.providers.entries()]
                .map(([provider, entry]) => {
                const sorted = [...entry.latencies].sort((a, b) => a - b);
                return {
                    provider,
                    calls: entry.calls,
                    byOutcome: { ...entry.byOutcome },
                    cacheHits: entry.cacheHits,
                    cacheMisses: entry.cacheMisses,
                    latency: sorted.length === 0
                        ? null
                        : {
                            p50: percentile(sorted, 50),
                            p95: percentile(sorted, 95),
                            max: sorted[sorted.length - 1] ?? 0,
                            count: sorted.length,
                        },
                };
            })
                .sort((a, b) => b.calls - a.calls),
            gateRejections: Object.fromEntries([...this.gateRejections.entries()].sort((a, b) => b[1] - a[1])),
            worker: {
                runs: this.workerRuns,
                failures: this.workerFailures,
                lastDurationMs: this.lastWorkerDurationMs,
                componentFailures: Object.fromEntries(this.componentFailures),
            },
            botDecisions: Object.fromEntries([...this.botDecisions.entries()].sort((a, b) => b[1] - a[1])),
        };
    }
    reset() {
        this.providers.clear();
        this.gateRejections.clear();
        this.botDecisions.clear();
        this.componentFailures.clear();
        this.workerRuns = 0;
        this.workerFailures = 0;
        this.lastWorkerDurationMs = null;
    }
}
/** Process-wide registry. Metrics are a cross-cutting concern. */
export const metrics = new MetricsRegistry();
/** Map an ArbError code onto a provider outcome, so callers stay consistent. */
export function outcomeForErrorCode(code) {
    switch (code) {
        case "PROVIDER_TIMEOUT":
            return "timeout";
        case "PROVIDER_RATE_LIMITED":
            return "rate_limited";
        case "MALFORMED_PROVIDER_RESPONSE":
            return "malformed";
        case "QUOTE_UNAVAILABLE":
            return "not_found";
        case "PROVIDER_ERROR":
            return "error";
        default:
            return "unavailable";
    }
}
