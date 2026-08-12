import { ArbError } from "../core/errors.js";
function isRateLimited(err) {
    return err instanceof ArbError && err.code === "PROVIDER_RATE_LIMITED";
}
export class CachedLoader {
    entries = new Map();
    inflight = new Map();
    ttlMs;
    failureTtlMs;
    rateLimitTtlMs;
    maxEntries;
    clock;
    hits = 0;
    misses = 0;
    dedupedJoins = 0;
    constructor(options) {
        this.ttlMs = options.ttlMs;
        this.failureTtlMs = options.failureTtlMs ?? 5_000;
        this.rateLimitTtlMs = options.rateLimitTtlMs ?? 30_000;
        this.maxEntries = options.maxEntries ?? 500;
        this.clock = options.clock ?? Date.now;
    }
    /**
     * Return a cached value or run `fetcher`. Rejects with the fetcher's error,
     * including replays of a cached failure inside its backoff window.
     */
    async load(key, fetcher) {
        const hit = this.entries.get(key);
        if (hit && this.clock() < hit.expiresAtMs) {
            this.hits++;
            if (!hit.ok)
                throw hit.error;
            return {
                value: hit.value,
                fetchedAtMs: hit.fetchedAtMs,
                ageMs: this.clock() - hit.fetchedAtMs, // computed on read, not stored
                fromCache: true,
            };
        }
        let pending = this.inflight.get(key);
        if (pending) {
            this.dedupedJoins++;
        }
        else {
            this.misses++;
            pending = this.fetchAndStore(key, fetcher);
            this.inflight.set(key, pending);
        }
        const value = await pending;
        const stored = this.entries.get(key);
        const fetchedAtMs = stored?.fetchedAtMs ?? this.clock();
        return { value, fetchedAtMs, ageMs: this.clock() - fetchedAtMs, fromCache: false };
    }
    async fetchAndStore(key, fetcher) {
        try {
            const value = await fetcher();
            const at = this.clock();
            this.store(key, { ok: true, value, fetchedAtMs: at, expiresAtMs: at + this.ttlMs });
            return value;
        }
        catch (err) {
            const at = this.clock();
            const ttl = isRateLimited(err) ? this.rateLimitTtlMs : this.failureTtlMs;
            this.store(key, { ok: false, error: err, fetchedAtMs: at, expiresAtMs: at + ttl });
            throw err;
        }
        finally {
            // Joiners already hold the promise, so clearing here is safe.
            this.inflight.delete(key);
        }
    }
    store(key, entry) {
        // Re-inserting refreshes insertion order, which drives eviction below.
        this.entries.delete(key);
        this.entries.set(key, entry);
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next();
            if (oldest.done)
                break;
            this.entries.delete(oldest.value);
        }
    }
    invalidate(key) {
        this.entries.delete(key);
    }
    clear() {
        this.entries.clear();
    }
    get stats() {
        return { hits: this.hits, misses: this.misses, dedupedJoins: this.dedupedJoins, size: this.entries.size };
    }
}
