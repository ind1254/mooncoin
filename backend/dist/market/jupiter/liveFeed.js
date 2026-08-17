import { z } from "zod";
import { ArbError } from "../../core/errors.js";
import { CachedLoader } from "../cache.js";
import { DEFAULT_JUPITER_TOKENS_URL, JUPITER_SOURCE, jupiterTokenSchema, normalizeJupiterToken, } from "./tokenSearch.js";
const feedEnvelopeSchema = z.array(z.unknown());
const scaledUsd = (value) => {
    if (value === undefined || !Number.isFinite(value) || value < 0)
        return null;
    const whole = Math.floor(value);
    const fraction = Math.round((value - whole) * 1_000_000);
    return BigInt(whole) * 1000000n + BigInt(Math.min(fraction, 999_999));
};
const bps = (value) => value === undefined || !Number.isFinite(value) ? null : BigInt(Math.round(value * 100));
function window(raw) {
    return {
        priceChangeBps: bps(raw?.priceChange),
        liquidityChangeBps: bps(raw?.liquidityChange),
        volumeChangeBps: bps(raw?.volumeChange),
        buyVolumeUsdMicro: scaledUsd(raw?.buyVolume),
        sellVolumeUsdMicro: scaledUsd(raw?.sellVolume),
        buys: raw?.numBuys ?? null,
        sells: raw?.numSells ?? null,
        traders: raw?.numTraders ?? null,
    };
}
function normalize(raw) {
    const token = normalizeJupiterToken(raw);
    return {
        token,
        // Jupiter describes this as the token/pool creation timestamp. Moonpaper
        // labels it "first pool detected" because it is not an on-chain mint-age
        // proof and must not be presented as one.
        firstPoolAtMs: token.firstPoolAtMs ?? null,
        updatedAtMs: token.marketUpdatedAtMs ?? null,
        launchpad: raw.launchpad ?? null,
        fiveMinutes: window(raw.stats5m),
        oneHour: window(raw.stats1h),
        twentyFourHours: window(raw.stats24h),
    };
}
/**
 * Read-only live discovery through Jupiter Tokens V2.
 *
 * This provider never builds a swap and never treats catalog presence as an
 * executable route. Route availability is established separately by the
 * existing /v1/quote endpoint when the user requests a quote.
 */
export class JupiterLiveFeedProvider {
    source = JUPITER_SOURCE;
    baseUrl;
    timeoutMs;
    apiKey;
    clock;
    fetchImpl;
    loader;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? DEFAULT_JUPITER_TOKENS_URL;
        this.timeoutMs = options.timeoutMs ?? 8_000;
        this.apiKey = options.apiKey;
        this.clock = options.clock ?? Date.now;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.loader = new CachedLoader({
            ttlMs: options.cacheTtlMs ?? 10_000,
            failureTtlMs: 3_000,
            rateLimitTtlMs: 20_000,
            maxEntries: 4,
            clock: this.clock,
        });
    }
    async getFeed(kind, signal) {
        const cached = await this.loader.load(kind, () => this.fetchFeed(kind, signal));
        return {
            kind,
            source: this.source,
            fetchedAtMs: cached.fetchedAtMs,
            reliability: cached.ageMs <= 30_000 ? "fresh" : cached.ageMs <= 120_000 ? "stale" : "unavailable",
            tokens: cached.value,
        };
    }
    async fetchFeed(kind, signal) {
        const path = kind === "recent" ? "/recent" : "/toptraded/5m?limit=100";
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let response;
        try {
            response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                signal: combined,
                headers: { accept: "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) },
            });
        }
        catch (err) {
            if (timeout.aborted)
                throw new ArbError("PROVIDER_TIMEOUT", "Live token feed timed out", 504);
            if (signal?.aborted)
                throw err;
            throw new ArbError("PROVIDER_ERROR", "Live token feed is unreachable", 502);
        }
        if (response.status === 429) {
            throw new ArbError("PROVIDER_RATE_LIMITED", "Live token feed rate limit reached", 503, {
                retryAfter: response.headers.get("retry-after"),
            });
        }
        if (!response.ok) {
            throw new ArbError("PROVIDER_ERROR", `Live token feed returned HTTP ${response.status}`, 502);
        }
        const envelope = feedEnvelopeSchema.safeParse(await response.json().catch(() => null));
        if (!envelope.success) {
            throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Unrecognized live token feed response", 502);
        }
        // One malformed catalog record must not blank the whole live feed. Identity
        // remains strict per item; unusable rows are dropped and observable.
        const tokens = [];
        let dropped = 0;
        for (const value of envelope.data) {
            const parsed = jupiterTokenSchema.safeParse(value);
            if (parsed.success)
                tokens.push(normalize(parsed.data));
            else
                dropped++;
        }
        if (dropped > 0) {
            console.warn(JSON.stringify({ msg: "live feed dropped malformed token records", dropped, kind }));
        }
        if (tokens.length === 0 && envelope.data.length > 0) {
            throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Live token feed contained no usable records", 502);
        }
        return tokens;
    }
}
