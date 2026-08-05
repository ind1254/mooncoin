import { z } from "zod";
import { ArbError } from "../core/errors.js";
import { USDC_MINT } from "../config/allowlist.js";
import { PROVIDER_TIMEOUT_MS, QUOTE_TTL_MS, } from "./types.js";
/**
 * Venue-specific quotes via Jupiter's quote API with the `dexes` filter
 * (ARB-003/004). Restricting the router to a single DEX family yields an
 * executable quote for that venue alone, so two adapter instances give two
 * independently identified venues without ticker-based matching.
 *
 * Jupiter quote amounts already embed route fees and price impact; the
 * adapter therefore reports feeMicroUsd = 0 and surfaces measured impact
 * separately (see calculator.ts model note).
 */
const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
/** Jupiter DEX labels per FOMO venue id. */
export const VENUE_DEX_LABELS = {
    raydium: "Raydium,Raydium CLMM",
    orca: "Whirlpool",
};
const quoteResponseSchema = z.object({
    inAmount: z.string().regex(/^\d+$/),
    outAmount: z.string().regex(/^\d+$/),
    priceImpactPct: z.string(),
});
/** Convert Jupiter's decimal percent string (e.g. "0.0834") to bps, rounding UP (impact is a cost). */
export function percentStringToBpsCeil(pct) {
    const match = /^-?(\d+)(?:\.(\d+))?$/.exec(pct.trim());
    if (!match) {
        throw new ArbError("MALFORMED_PROVIDER_RESPONSE", `Unparseable price impact: ${pct}`, 502);
    }
    const whole = match[1] ?? "0";
    const frac = ((match[2] ?? "") + "000000").slice(0, 6); // percent with 6 frac digits
    // percent * 100 = bps; value = whole.frac percent = (whole*1e6 + frac) / 1e6 percent
    const scaled = BigInt(whole) * 1000000n + BigInt(frac); // percent * 1e6
    const numerator = scaled * 100n; // bps * 1e6
    return (numerator + 999999n) / 1000000n;
}
async function fetchQuote(params, signal) {
    const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    let res;
    try {
        res = await fetch(`${JUPITER_QUOTE_URL}?${params}`, { signal: combined });
    }
    catch (err) {
        if (timeout.aborted) {
            throw new ArbError("PROVIDER_TIMEOUT", "Quote provider timed out", 504);
        }
        throw new ArbError("PROVIDER_ERROR", "Quote provider unreachable", 502);
    }
    if (!res.ok) {
        throw new ArbError("PROVIDER_ERROR", `Quote provider returned ${res.status}`, 502, {
            providerStatus: res.status,
        });
    }
    const parsed = quoteResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
        throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Provider response failed validation", 502);
    }
    return parsed.data;
}
export class JupiterVenueAdapter {
    venueId;
    dexLabels;
    constructor(venueId, dexLabels) {
        this.venueId = venueId;
        this.dexLabels = dexLabels;
    }
    baseParams(inputMint, outputMint, amount) {
        return new URLSearchParams({
            inputMint,
            outputMint,
            amount: amount.toString(),
            dexes: this.dexLabels,
            swapMode: "ExactIn",
            slippageBps: "50",
            onlyDirectRoutes: "true",
        });
    }
    normalize(raw, side, tokenMint) {
        const now = Date.now();
        return {
            venueId: this.venueId,
            side,
            tokenMint,
            inAmount: BigInt(raw.inAmount),
            outAmount: BigInt(raw.outAmount),
            feeMicroUsd: 0n, // embedded in outAmount by the router
            priceImpactBps: percentStringToBpsCeil(raw.priceImpactPct),
            retrievedAtMs: now,
            expiresAtMs: now + QUOTE_TTL_MS,
        };
    }
    async getBuyQuote(req, signal) {
        const raw = await fetchQuote(this.baseParams(USDC_MINT, req.token.mint, req.amountMicroUsd), signal);
        return this.normalize(raw, "buy", req.token.mint);
    }
    async getSellQuote(req, signal) {
        const raw = await fetchQuote(this.baseParams(req.token.mint, USDC_MINT, req.amountTokenUnits), signal);
        return this.normalize(raw, "sell", req.token.mint);
    }
}
