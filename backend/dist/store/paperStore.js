import { randomUUID } from "node:crypto";
export class InMemoryPaperStore {
    records = [];
    async save(record) {
        this.records.unshift(record);
        if (this.records.length > 1000)
            this.records.pop();
    }
    async list(limit) {
        return this.records.slice(0, Math.max(0, limit));
    }
}
export function toPaperRecord(comparison, tokenSymbol, startingAmountMicroUsd, correlationId) {
    const { buyQuote, sellQuote, outcome } = comparison;
    return {
        id: randomUUID(),
        createdAtMs: Date.now(),
        tokenMint: buyQuote.tokenMint,
        tokenSymbol,
        startingAmountMicroUsd: startingAmountMicroUsd.toString(),
        buyVenueId: buyQuote.venueId,
        sellVenueId: sellQuote.venueId,
        estimatedFinalMicroUsd: outcome.estimatedFinalMicroUsd.toString(),
        totalCostsMicroUsd: outcome.costs.totalMicroUsd.toString(),
        netProfitMicroUsd: outcome.netProfitMicroUsd.toString(),
        returnBps: outcome.returnBps.toString(),
        isProfitable: outcome.isProfitable,
        warnings: outcome.warnings,
        quoteExpiresAtMs: outcome.quoteExpiresAtMs,
        correlationId,
    };
}
