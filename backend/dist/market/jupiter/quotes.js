import { z } from "zod";
import { ArbError } from "../../core/errors.js";
import { CachedLoader } from "../cache.js";
import { isPlausibleAddress } from "../solana/rpc.js";
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
export const JUPITER_QUOTE_SOURCE = "jupiter:quote-v1";
export const DEFAULT_JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1";
/**
 * Jupiter reports price impact as a decimal-percent string that can carry far
 * more precision than a float holds (e.g. "0.001366339669935170085524648").
 * Parsed as text and rounded UP, because impact is a cost to the user.
 */
export function impactPercentToBpsCeil(pct) {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(pct.trim());
    if (!match) {
        throw new ArbError("MALFORMED_PROVIDER_RESPONSE", `Unparseable price impact: ${pct}`, 502);
    }
    const whole = match[2] ?? "0";
    const frac = ((match[3] ?? "") + "000000").slice(0, 6);
    const scaledPercent = BigInt(whole) * 1000000n + BigInt(frac); // percent × 1e6
    const bpsTimes1e6 = scaledPercent * 100n;
    const rounded = (bpsTimes1e6 + 999999n) / 1000000n;
    return match[1] === "-" ? 0n : rounded; // negative impact is upside; treat as none
}
/** "7.5756902772" USD -> micro-USD, parsed as text to avoid float drift. */
function usdStringToMicro(value) {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!match)
        return null;
    const frac = ((match[2] ?? "") + "000000").slice(0, 6);
    return BigInt(match[1] ?? "0") * 1000000n + BigInt(frac);
}
const routePlanSchema = z.array(z.object({
    swapInfo: z.object({
        ammKey: z.string(),
        label: z.string().optional(),
        inputMint: z.string(),
        outputMint: z.string(),
    }),
    percent: z.number().optional(),
}));
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
})
    .passthrough();
export class JupiterQuoteProvider {
    source = JUPITER_QUOTE_SOURCE;
    baseUrl;
    timeoutMs;
    quoteTtlMs;
    clock;
    fetchImpl;
    loader;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? DEFAULT_JUPITER_QUOTE_URL;
        this.timeoutMs = options.timeoutMs ?? 8_000;
        this.quoteTtlMs = options.quoteTtlMs ?? 20_000;
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
    async fetchQuote(req, signal) {
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
                headers: { accept: "application/json" },
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
        const parsed = quoteSchema.safeParse(await res.json().catch(() => null));
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
            priceImpactBps: impactPercentToBpsCeil(q.priceImpactPct),
            routePlan: q.routePlan.map((hop) => ({
                ammLabel: hop.swapInfo.label ?? "Unknown venue",
                ammKey: hop.swapInfo.ammKey,
                inputMint: hop.swapInfo.inputMint,
                outputMint: hop.swapInfo.outputMint,
                percent: hop.percent ?? 100,
            })),
            swapUsdValueMicro: q.swapUsdValue ? usdStringToMicro(q.swapUsdValue) : null,
            contextSlot: q.contextSlot ?? null,
            swapMode: q.swapMode,
            retrievedAtMs: now,
            expiresAtMs: now + this.quoteTtlMs,
            source: JUPITER_QUOTE_SOURCE,
        };
    }
}
