import { z } from "zod";
import { ArbError } from "../../core/errors.js";
import { CachedLoader } from "../cache.js";
import { isPlausibleAddress } from "../solana/rpc.js";
/**
 * Token discovery and market facts via Jupiter's public token search.
 *
 * Read-only, keyless, no account. This provider answers "which token does the
 * user mean?" and "what is the market doing?" — it is NOT the authority on
 * on-chain settings. Jupiter's `audit` block omits a key entirely when an
 * authority is still active, so absence there is ambiguous; the mint account
 * read over RPC stays authoritative and Jupiter's claim is kept only as a
 * cross-check.
 *
 * The upstream response is validated with a deliberately tolerant schema:
 * identity fields are required, everything else is optional, so a provider
 * adding or dropping a market field degrades one value instead of failing the
 * whole search.
 */
export const JUPITER_SOURCE = "jupiter:tokens-v2";
export const DEFAULT_JUPITER_TOKENS_URL = "https://lite-api.jup.ag/tokens/v2";
/** Jupiter reports percentages as plain numbers (-1.5178 means -1.5178%). */
const pctToBps = (pct) => BigInt(Math.round(pct * 100));
/**
 * Float USD to bigint, done in two parts so large values never pass through
 * an unsafe integer. Math.floor keeps the whole part exact; the fraction is
 * bounded by the scale.
 */
function usdToScaled(value, scale, scaleDigits) {
    if (!Number.isFinite(value) || value < 0)
        return 0n;
    const whole = Math.floor(value);
    const frac = Math.round((value - whole) * Number(scale));
    return BigInt(whole) * scale + BigInt(Math.min(frac, 10 ** scaleDigits - 1));
}
const toMicroUsd = (v) => usdToScaled(v, 1000000n, 6);
const toPicoUsd = (v) => usdToScaled(v, 1000000000000n, 12);
export const jupiterStatsSchema = z
    .object({
    priceChange: z.number().optional(),
    liquidityChange: z.number().optional(),
    volumeChange: z.number().optional(),
    buyVolume: z.number().optional(),
    sellVolume: z.number().optional(),
    numBuys: z.number().optional(),
    numSells: z.number().optional(),
    numTraders: z.number().optional(),
})
    .passthrough();
export const jupiterTokenSchema = z
    .object({
    // Identity — required. Without these the record is unusable.
    id: z.string().min(32).max(64),
    name: z.string(),
    symbol: z.string(),
    decimals: z.number().int().min(0).max(18),
    // Everything below is optional so upstream changes degrade gracefully.
    icon: z.string().url().optional(),
    tokenProgram: z.string().optional(),
    usdPrice: z.number().optional(),
    liquidity: z.number().optional(),
    mcap: z.number().optional(),
    fdv: z.number().optional(),
    holderCount: z.number().optional(),
    circSupply: z.number().optional(),
    totalSupply: z.number().optional(),
    organicScore: z.number().optional(),
    organicScoreLabel: z.string().optional(),
    isVerified: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    createdAt: z.string().optional(),
    audit: z
        .object({
        mintAuthorityDisabled: z.boolean().optional(),
        freezeAuthorityDisabled: z.boolean().optional(),
        topHoldersPercentage: z.number().optional(),
        devBalancePercentage: z.number().optional(),
        devMints: z.number().optional(),
    })
        .passthrough()
        .optional(),
    stats5m: jupiterStatsSchema.optional(),
    stats1h: jupiterStatsSchema.optional(),
    stats24h: jupiterStatsSchema.optional(),
})
    .passthrough();
const searchResponseSchema = z.array(jupiterTokenSchema);
export function normalizeJupiterToken(raw) {
    const a = raw.audit;
    const s24 = raw.stats24h;
    const num = (v) => (typeof v === "number" ? v : null);
    return {
        mint: raw.id,
        symbol: raw.symbol,
        name: raw.name,
        decimals: raw.decimals,
        tokenProgram: raw.tokenProgram ?? null,
        iconUrl: raw.icon ?? null,
        verifiedByProvider: raw.isVerified === true,
        tags: raw.tags ?? [],
        source: JUPITER_SOURCE,
        market: {
            priceUsdPico: raw.usdPrice !== undefined ? toPicoUsd(raw.usdPrice) : null,
            liquidityUsdMicro: raw.liquidity !== undefined ? toMicroUsd(raw.liquidity) : null,
            marketCapUsdMicro: raw.mcap !== undefined ? toMicroUsd(raw.mcap) : null,
            fdvUsdMicro: raw.fdv !== undefined ? toMicroUsd(raw.fdv) : null,
            holderCount: num(raw.holderCount),
            change1hBps: raw.stats1h?.priceChange !== undefined ? pctToBps(raw.stats1h.priceChange) : null,
            change24hBps: s24?.priceChange !== undefined ? pctToBps(s24.priceChange) : null,
            buyVolume24hUsdMicro: s24?.buyVolume !== undefined ? toMicroUsd(s24.buyVolume) : null,
            sellVolume24hUsdMicro: s24?.sellVolume !== undefined ? toMicroUsd(s24.sellVolume) : null,
            numBuys24h: num(s24?.numBuys),
            numSells24h: num(s24?.numSells),
            topHolderPctBps: a?.topHoldersPercentage !== undefined ? pctToBps(a.topHoldersPercentage) : null,
            organicScore: num(raw.organicScore),
            organicScoreLabel: raw.organicScoreLabel ?? null,
        },
        // Kept as claims, never as truth. The chain decides.
        providerClaims: {
            mintAuthorityDisabled: a?.mintAuthorityDisabled ?? null,
            freezeAuthorityDisabled: a?.freezeAuthorityDisabled ?? null,
        },
    };
}
export class JupiterTokenSearchProvider {
    source = JUPITER_SOURCE;
    baseUrl;
    timeoutMs;
    fetchImpl;
    loader;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? DEFAULT_JUPITER_TOKENS_URL;
        this.timeoutMs = options.timeoutMs ?? 8_000;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.loader = new CachedLoader({
            ttlMs: options.cacheTtlMs ?? 15_000,
            failureTtlMs: 5_000,
            rateLimitTtlMs: 30_000,
            maxEntries: 300,
            ...(options.clock ? { clock: options.clock } : {}),
        });
    }
    get cacheStats() {
        return this.loader.stats;
    }
    async search(query, signal) {
        const trimmed = query.trim();
        if (trimmed.length < 2)
            return [];
        // Cache key is the normalized query, so repeated keystrokes that settle on
        // the same text and concurrent identical searches collapse to one request.
        return this.loader
            .load(trimmed.toLowerCase(), () => this.fetchSearch(trimmed, signal))
            .then((c) => c.value);
    }
    async getByMint(mint, signal) {
        if (!isPlausibleAddress(mint)) {
            throw new ArbError("VALIDATION_ERROR", `Not a valid Solana mint address: ${mint}`, 400);
        }
        const results = await this.search(mint, signal);
        // A mint query is exact: only accept a record whose id actually matches.
        return results.find((r) => r.mint === mint) ?? null;
    }
    async fetchSearch(query, signal) {
        const url = `${this.baseUrl}/search?query=${encodeURIComponent(query)}`;
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let res;
        try {
            res = await this.fetchImpl(url, { signal: combined, headers: { accept: "application/json" } });
        }
        catch (err) {
            if (timeout.aborted)
                throw new ArbError("PROVIDER_TIMEOUT", "Token search timed out", 504);
            if (signal?.aborted)
                throw err;
            throw new ArbError("PROVIDER_ERROR", "Token search provider unreachable", 502);
        }
        if (res.status === 429) {
            throw new ArbError("PROVIDER_RATE_LIMITED", "Token search rate limit reached", 503, {
                retryAfter: res.headers.get("retry-after"),
            });
        }
        if (!res.ok) {
            throw new ArbError("PROVIDER_ERROR", `Token search returned HTTP ${res.status}`, 502);
        }
        const parsed = searchResponseSchema.safeParse(await res.json().catch(() => null));
        if (!parsed.success) {
            throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Unrecognized token search response", 502);
        }
        return parsed.data.map(normalizeJupiterToken);
    }
}
