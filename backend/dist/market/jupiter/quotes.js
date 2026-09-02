import { z } from "zod";
import { ArbError } from "../../core/errors.js";
import { CachedLoader } from "../cache.js";
import { isPlausibleAddress } from "../solana/rpc.js";
import { priceImpactFractionToBpsCeil } from "./units.js";
import { metrics, outcomeForErrorCode } from "../../observability/metrics.js";
/**
 * Read-only swap quotes from Jupiter.
 *
 * This module asks "what would this swap return right now?" and nothing else.
 * It calls the quote endpoint only. It never calls /swap, never builds a
 * transaction, never requests a signature, and never broadcasts anything.
 *
 * Deliberate difference from the rest of Moonpaper: there is NO fallback here.
 * Elsewhere a provider failure degrades to a labelled simulated value, which
 * is fine for descriptive data. A quote drives a hypothetical fill price, so a
 * fabricated one presented as current would make the whole simulation a lie.
 * If Jupiter cannot answer, the quote is unavailable and the user is told.
 */
export { priceImpactFractionToBpsCeil } from "./units.js";
export const JUPITER_QUOTE_SOURCE_V1 = "jupiter:quote-v1";
export const JUPITER_QUOTE_SOURCE_V2 = "jupiter:quote-v2";
/** @deprecated Provenance is now derived from the version actually called. */
export const JUPITER_QUOTE_SOURCE = JUPITER_QUOTE_SOURCE_V1;
/** Keyless host. Serves V1 only. */
export const DEFAULT_JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1";
/** Keyed host. Serves V2, and rate-limits hard without a key. */
export const JUPITER_QUOTE_URL_V2 = "https://api.jup.ag/swap/v2";
export const quoteSourceForVersion = (v) => v === "v2" ? JUPITER_QUOTE_SOURCE_V2 : JUPITER_QUOTE_SOURCE_V1;
/**
 * Read the API generation off the configured URL.
 *
 * Provenance has to describe the endpoint that actually answered, not a
 * constant someone forgot to update — that is precisely how the stamp came to
 * read `quote-v1` regardless of configuration. Returns null when the URL
 * carries no recognisable version, leaving the caller to decide.
 */
export function inferApiVersionFromUrl(baseUrl) {
    try {
        const path = new URL(baseUrl).pathname.toLowerCase().replace(/\/+$/, "");
        if (path.endsWith("/v2"))
            return "v2";
        if (path.endsWith("/v1") || path.endsWith("/v6"))
            return "v1";
        return null;
    }
    catch {
        return null;
    }
}
/** Slot numbers arrive as string or number depending on endpoint and field. */
function toFiniteNumber(value) {
    if (value == null)
        return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}
/** "7.5756902772" USD -> micro-USD, parsed as text to avoid float drift. */
function usdStringToMicro(value) {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!match)
        return null;
    const frac = ((match[2] ?? "") + "000000").slice(0, 6);
    return BigInt(match[1] ?? "0") * 1000000n + BigInt(frac);
}
const baseUnitString = z.string().regex(/^\d+$/);
const routePlanSchema = z.array(z.object({
    swapInfo: z.object({
        ammKey: z.string(),
        label: z.string().optional(),
        inputMint: z.string(),
        outputMint: z.string(),
        inAmount: baseUnitString.optional(),
        outAmount: baseUnitString.optional(),
        // Jupiter sends this as a string; tolerate a number too.
        updateContextSlot: z.union([z.string(), z.number()]).nullish(),
    }),
    percent: z.number().optional(),
}));
const platformFeeSchema = z
    .object({ amount: baseUnitString, feeBps: z.number() })
    .nullish();
const quoteSchema = z
    .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string().regex(/^\d+$/),
    outAmount: z.string().regex(/^\d+$/),
    otherAmountThreshold: z.string().regex(/^\d+$/),
    swapMode: z.string(),
    slippageBps: z.number(),
    priceImpactPct: z.string(),
    routePlan: routePlanSchema,
    contextSlot: z.number().optional(),
    swapUsdValue: z.string().optional(),
    platformFee: platformFeeSchema,
    timeTaken: z.number().optional(),
    instructionVersion: z.string().nullish(),
})
    .passthrough();
/**
 * Fields that only ever appear on a transaction-building response. Moonpaper
 * calls the quote endpoint exclusively, so seeing one of these means the URL
 * has been pointed somewhere it must never point. Refuse the response rather
 * than let an unsigned transaction reach the domain layer, a database, or a
 * browser.
 */
const EXECUTION_FIELDS = ["swapTransaction", "transaction", "setupTransaction", "cleanupTransaction"];
/**
 * A configured base URL must be a quote host, never an execute one. Checked at
 * construction so a misconfigured environment fails immediately and loudly
 * instead of at the first trade.
 */
export function assertQuoteOnlyBaseUrl(baseUrl) {
    const path = (() => {
        try {
            return new URL(baseUrl).pathname.toLowerCase();
        }
        catch {
            throw new ArbError("VALIDATION_ERROR", `Invalid Jupiter base URL: ${baseUrl}`, 500);
        }
    })();
    for (const banned of ["/swap", "/execute", "/order", "/send"]) {
        // `/swap/v1` and `/swap/v2` are the API family names, not the execute
        // endpoint; only a trailing segment would be the action itself.
        if (path.endsWith(banned)) {
            throw new ArbError("VALIDATION_ERROR", `Refusing a Jupiter base URL that points at an execution endpoint: ${baseUrl}`, 500);
        }
    }
}
export class JupiterQuoteProvider {
    source;
    apiVersion;
    baseUrl;
    timeoutMs;
    quoteTtlMs;
    apiKey;
    clock;
    fetchImpl;
    loader;
    constructor(options = {}) {
        // Precedence: an explicit version, then whatever the configured URL says,
        // then the key (V2's host is unusable without one). Reading the URL keeps
        // the provenance stamp honest when a deployment overrides the endpoint.
        this.apiVersion =
            options.apiVersion ??
                (options.baseUrl ? inferApiVersionFromUrl(options.baseUrl) : null) ??
                (options.apiKey ? "v2" : "v1");
        this.baseUrl =
            options.baseUrl ??
                (this.apiVersion === "v2" ? JUPITER_QUOTE_URL_V2 : DEFAULT_JUPITER_QUOTE_URL);
        assertQuoteOnlyBaseUrl(this.baseUrl);
        this.source = quoteSourceForVersion(this.apiVersion);
        this.timeoutMs = options.timeoutMs ?? 8_000;
        this.quoteTtlMs = options.quoteTtlMs ?? 20_000;
        this.apiKey = options.apiKey;
        this.clock = options.clock ?? Date.now;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.loader = new CachedLoader({
            // Short on purpose: long enough to absorb a double-click, short enough
            // that a displayed quote is never meaningfully out of date.
            ttlMs: options.cacheTtlMs ?? 5_000,
            failureTtlMs: 3_000,
            rateLimitTtlMs: 20_000,
            maxEntries: 200,
            clock: this.clock,
        });
    }
    get cacheStats() {
        return this.loader.stats;
    }
    async getQuote(req, signal) {
        if (!isPlausibleAddress(req.inputMint) || !isPlausibleAddress(req.outputMint)) {
            throw new ArbError("VALIDATION_ERROR", "Both mints must be valid Solana addresses", 400);
        }
        if (req.inputMint === req.outputMint) {
            throw new ArbError("VALIDATION_ERROR", "Input and output tokens must differ", 400);
        }
        if (req.amount <= 0n) {
            throw new ArbError("VALIDATION_ERROR", "Quote amount must be greater than zero", 400);
        }
        if (req.slippageBps < 1n || req.slippageBps > 5000n) {
            throw new ArbError("VALIDATION_ERROR", "Slippage must be between 0.01% and 50%", 400);
        }
        const key = `${req.inputMint}:${req.outputMint}:${req.amount}:${req.slippageBps}`;
        const cached = await this.loader.load(key, () => this.fetchQuote(req, signal));
        return cached.value;
    }
    /** Stable metric key. Never a URL: a query string can carry an API key. */
    get metricKey() {
        return `jupiter:quote-${this.apiVersion}`;
    }
    async fetchQuote(req, signal) {
        const startedAt = this.clock();
        try {
            const quote = await this.fetchQuoteInner(req, signal);
            metrics.providerCall(this.metricKey, "ok", this.clock() - startedAt);
            return quote;
        }
        catch (err) {
            const code = err.code ?? "";
            metrics.providerCall(this.metricKey, outcomeForErrorCode(code), this.clock() - startedAt);
            throw err;
        }
    }
    async fetchQuoteInner(req, signal) {
        const params = new URLSearchParams({
            inputMint: req.inputMint,
            outputMint: req.outputMint,
            amount: req.amount.toString(),
            slippageBps: req.slippageBps.toString(),
            swapMode: "ExactIn",
        });
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let res;
        try {
            res = await this.fetchImpl(`${this.baseUrl}/quote?${params}`, {
                signal: combined,
                headers: { accept: "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) },
            });
        }
        catch (err) {
            if (timeout.aborted)
                throw new ArbError("PROVIDER_TIMEOUT", "Quote provider timed out", 504);
            if (signal?.aborted)
                throw err;
            throw new ArbError("PROVIDER_ERROR", "Quote provider unreachable", 502);
        }
        if (res.status === 429) {
            throw new ArbError("PROVIDER_RATE_LIMITED", "Quote provider rate limit reached", 503, {
                retryAfter: res.headers.get("retry-after"),
            });
        }
        // Jupiter answers 400 when no route exists for the pair or size.
        if (res.status === 400 || res.status === 404) {
            throw new ArbError("QUOTE_UNAVAILABLE", "No route is available for this trade right now", 409);
        }
        if (!res.ok) {
            throw new ArbError("PROVIDER_ERROR", `Quote provider returned HTTP ${res.status}`, 502);
        }
        const body = await res.json().catch(() => null);
        // Defence in depth behind assertQuoteOnlyBaseUrl: if a response ever
        // carries a transaction, discard it here rather than normalize around it.
        if (body !== null && typeof body === "object") {
            for (const field of EXECUTION_FIELDS) {
                if (field in body) {
                    throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Quote response carried transaction data; refusing it", 502);
                }
            }
        }
        const parsed = quoteSchema.safeParse(body);
        if (!parsed.success) {
            throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Unrecognized quote response", 502);
        }
        const q = parsed.data;
        const outAmount = BigInt(q.outAmount);
        if (outAmount <= 0n) {
            throw new ArbError("QUOTE_UNAVAILABLE", "The quoted output for this size rounds to zero", 409);
        }
        const now = this.clock();
        return {
            inputMint: q.inputMint,
            outputMint: q.outputMint,
            // Amounts arrive as strings and go straight to BigInt: no float ever
            // touches a token amount.
            inAmount: BigInt(q.inAmount),
            outAmount,
            minOutAmount: BigInt(q.otherAmountThreshold),
            slippageBps: BigInt(q.slippageBps),
            priceImpactBps: priceImpactFractionToBpsCeil(q.priceImpactPct),
            routePlan: q.routePlan.map((hop) => ({
                ammLabel: hop.swapInfo.label ?? "Unknown venue",
                ammKey: hop.swapInfo.ammKey,
                inputMint: hop.swapInfo.inputMint,
                outputMint: hop.swapInfo.outputMint,
                percent: hop.percent ?? 100,
                inAmount: hop.swapInfo.inAmount != null ? BigInt(hop.swapInfo.inAmount) : null,
                outAmount: hop.swapInfo.outAmount != null ? BigInt(hop.swapInfo.outAmount) : null,
                updateContextSlot: toFiniteNumber(hop.swapInfo.updateContextSlot),
            })),
            swapUsdValueMicro: q.swapUsdValue ? usdStringToMicro(q.swapUsdValue) : null,
            contextSlot: q.contextSlot ?? null,
            swapMode: q.swapMode,
            platformFee: q.platformFee
                ? { amountBaseUnits: BigInt(q.platformFee.amount), feeBps: q.platformFee.feeBps }
                : null,
            retrievedAtMs: now,
            expiresAtMs: now + this.quoteTtlMs,
            source: this.source,
            apiVersion: this.apiVersion,
            // Jupiter reports `timeTaken` in seconds.
            providerLatencyMs: q.timeTaken != null ? Math.round(q.timeTaken * 1000) : null,
            providerRequestId: res.headers.get("x-api-gateway-request-id"),
            instructionVersion: q.instructionVersion ?? null,
        };
    }
}
