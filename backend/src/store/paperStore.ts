import { randomUUID } from "node:crypto";
import type { ArbitrageComparison } from "../service/arbitrageService.js";

/**
 * Paper-calculation history (FR-07, ARB-010).
 * In-memory for development; the interface mirrors db/schema.sql so a
 * Postgres/Supabase implementation can swap in without touching callers.
 */

export interface PaperRecord {
  id: string;
  createdAtMs: number;
  tokenMint: string;
  tokenSymbol: string;
  startingAmountMicroUsd: string;
  buyVenueId: string;
  sellVenueId: string;
  estimatedFinalMicroUsd: string;
  totalCostsMicroUsd: string;
  netProfitMicroUsd: string;
  returnBps: string;
  isProfitable: boolean;
  warnings: string[];
  quoteExpiresAtMs: number;
  correlationId: string;
}

export interface PaperStore {
  save(record: PaperRecord): Promise<void>;
  list(limit: number): Promise<PaperRecord[]>;
}

export class InMemoryPaperStore implements PaperStore {
  private records: PaperRecord[] = [];

  async save(record: PaperRecord): Promise<void> {
    this.records.unshift(record);
    if (this.records.length > 1000) this.records.pop();
  }

  async list(limit: number): Promise<PaperRecord[]> {
    return this.records.slice(0, Math.max(0, limit));
  }
}

export function toPaperRecord(
  comparison: ArbitrageComparison,
  tokenSymbol: string,
  startingAmountMicroUsd: bigint,
  correlationId: string,
): PaperRecord {
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
