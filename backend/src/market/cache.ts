import { ArbError } from "../core/errors.js";

/**
 * TTL cache with in-flight request deduplication and negative caching.
 *
 * Three jobs, inseparable in practice:
 *
 *  1. TTL caching — external market data is expensive and mostly static.
 *  2. Single-flight — the Discover page looks up every token at once, so on a
 *     cold cache N parallel callers would all miss and all hit the network.
 *     Callers for a key already being fetched join the existing promise.
 *  3. Negative caching — an uncached failure means the next render retries
 *     immediately, which turns a rate limit into a permanent outage. Failures
 *     are cached briefly, and PROVIDER_RATE_LIMITED backs off for longer
 *     because that is the endpoint explicitly asking us to slow down.
 *
 * Age is computed when a value is READ, never stored. A value cached for nine
 * minutes must not report itself as fresh.
 */

export interface CachedValue<T> {
  value: T;
  /** When the underlying fetch completed. */
  fetchedAtMs: number;
  /** Age at the moment of this read. */
  ageMs: number;
  fromCache: boolean;
}

type Entry<T> =
  | { ok: true; value: T; fetchedAtMs: number; expiresAtMs: number }
  | { ok: false; error: unknown; fetchedAtMs: number; expiresAtMs: number };

export interface CachedLoaderOptions {
  /** How long a successful value stays valid. */
  ttlMs: number;
  /** How long a generic failure is remembered. Default 5s. */
  failureTtlMs?: number;
  /** How long a rate-limit failure is remembered. Default 30s. */
  rateLimitTtlMs?: number;
  /** Bound on cache size; oldest entries are evicted first. Default 500. */
  maxEntries?: number;
  clock?: () => number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Callers that joined an already-running fetch instead of starting one. */
  dedupedJoins: number;
  size: number;
}

function isRateLimited(err: unknown): boolean {
  return err instanceof ArbError && err.code === "PROVIDER_RATE_LIMITED";
}

export class CachedLoader<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly rateLimitTtlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private hits = 0;
  private misses = 0;
  private dedupedJoins = 0;

  constructor(options: CachedLoaderOptions) {
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
  async load(key: string, fetcher: () => Promise<T>): Promise<CachedValue<T>> {
    const hit = this.entries.get(key);
    if (hit && this.clock() < hit.expiresAtMs) {
      this.hits++;
      if (!hit.ok) throw hit.error;
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
    } else {
      this.misses++;
      pending = this.fetchAndStore(key, fetcher);
      this.inflight.set(key, pending);
    }

    const value = await pending;
    const stored = this.entries.get(key);
    const fetchedAtMs = stored?.fetchedAtMs ?? this.clock();
    return { value, fetchedAtMs, ageMs: this.clock() - fetchedAtMs, fromCache: false };
  }

  private async fetchAndStore(key: string, fetcher: () => Promise<T>): Promise<T> {
    try {
      const value = await fetcher();
      const at = this.clock();
      this.store(key, { ok: true, value, fetchedAtMs: at, expiresAtMs: at + this.ttlMs });
      return value;
    } catch (err) {
      const at = this.clock();
      const ttl = isRateLimited(err) ? this.rateLimitTtlMs : this.failureTtlMs;
      this.store(key, { ok: false, error: err, fetchedAtMs: at, expiresAtMs: at + ttl });
      throw err;
    } finally {
      // Joiners already hold the promise, so clearing here is safe.
      this.inflight.delete(key);
    }
  }

  private store(key: string, entry: Entry<T>): void {
    // Re-inserting refreshes insertion order, which drives eviction below.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, dedupedJoins: this.dedupedJoins, size: this.entries.size };
  }
}
