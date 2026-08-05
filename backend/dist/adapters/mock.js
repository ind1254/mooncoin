import { divFloor } from "../core/money.js";
import { QUOTE_TTL_MS, } from "./types.js";
/**
 * Deterministic offline adapter for development and tests.
 * Prices are fixed per venue so a configurable spread exists between venues.
 * `priceMicroUsdPerToken` is the USD price of one whole token in microUsd.
 */
export class MockVenueAdapter {
    venueId;
    priceMicroUsdPerToken;
    impactBps;
    failWith;
    constructor(venueId, priceMicroUsdPerToken, impactBps = 10n, failWith) {
        this.venueId = venueId;
        this.priceMicroUsdPerToken = priceMicroUsdPerToken;
        this.impactBps = impactBps;
        this.failWith = failWith;
    }
    ensureHealthy() {
        if (this.failWith)
            throw this.failWith;
    }
    async getBuyQuote(req, _signal) {
        this.ensureHealthy();
        const now = Date.now();
        const tokenScale = 10n ** BigInt(req.token.decimals);
        // tokens received = usd / price, floored (proceeds round down)
        const outAmount = divFloor(req.amountMicroUsd * tokenScale, this.priceMicroUsdPerToken);
        return {
            venueId: this.venueId,
            side: "buy",
            tokenMint: req.token.mint,
            inAmount: req.amountMicroUsd,
            outAmount,
            feeMicroUsd: 0n,
            priceImpactBps: this.impactBps,
            retrievedAtMs: now,
            expiresAtMs: now + QUOTE_TTL_MS,
        };
    }
    async getSellQuote(req, _signal) {
        this.ensureHealthy();
        const now = Date.now();
        const tokenScale = 10n ** BigInt(req.token.decimals);
        const outAmount = divFloor(req.amountTokenUnits * this.priceMicroUsdPerToken, tokenScale);
        return {
            venueId: this.venueId,
            side: "sell",
            tokenMint: req.token.mint,
            inAmount: req.amountTokenUnits,
            outAmount,
            feeMicroUsd: 0n,
            priceImpactBps: this.impactBps,
            retrievedAtMs: now,
            expiresAtMs: now + QUOTE_TTL_MS,
        };
    }
}
