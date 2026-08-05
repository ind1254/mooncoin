/**
 * Shared types for the arbitrage calculation pipeline (ARB-002).
 * All money fields are bigint microUsd; all token amounts are bigint base units.
 */

export type QuoteSide = "buy" | "sell";

export interface VerifiedToken {
  /** Immutable Solana mint address — the ONLY token identity used anywhere. */
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  enabled: boolean;
}

export interface Venue {
  id: string;
  displayName: string;
  enabled: boolean;
}

/** Normalized executable quote returned by every adapter. */
export interface NormalizedQuote {
  venueId: string;
  side: QuoteSide;
  tokenMint: string;
  /** Amount paid in, microUsd for buys / token base units for sells. */
  inAmount: bigint;
  /** Amount received, token base units for buys / microUsd for sells. */
  outAmount: bigint;
  /** Venue/route fee already expressed in microUsd, rounded up by the adapter. */
  feeMicroUsd: bigint;
  /** Measured price impact for this amount, in basis points. */
  priceImpactBps: bigint;
  /** Unix ms when the provider produced the quote. */
  retrievedAtMs: number;
  /** Unix ms after which this quote must be treated as stale. */
  expiresAtMs: number;
}

export interface CostBreakdown {
  venueFeesMicroUsd: bigint;
  networkFeesMicroUsd: bigint;
  priceImpactMicroUsd: bigint;
  safetyBufferMicroUsd: bigint;
  totalMicroUsd: bigint;
}

export type WarningCode =
  | "STALE_QUOTE"
  | "HIGH_PRICE_IMPACT"
  | "LOW_LIQUIDITY"
  | "PROVIDER_FAILURE"
  | "INCOMPLETE_DATA"
  | "SAME_VENUE"
  | "TOKEN_MISMATCH"
  | "NOT_PROFITABLE";

export interface CalculationInput {
  buyQuote: NormalizedQuote;
  sellQuote: NormalizedQuote;
  startingAmountMicroUsd: bigint;
  /** Flat network + priority fee estimate for the round trip, microUsd. */
  networkFeeMicroUsd: bigint;
  /** Safety buffer in basis points of the starting amount. */
  safetyBufferBps: bigint;
  /** Evaluation clock, unix ms (injectable for tests). */
  nowMs: number;
}

export interface CalculationOutcome {
  grossSpreadMicroUsd: bigint;
  estimatedFinalMicroUsd: bigint;
  costs: CostBreakdown;
  netProfitMicroUsd: bigint;
  returnBps: bigint;
  /** True only when net > 0 AND no rejection-grade warnings fired. */
  isProfitable: boolean;
  warnings: WarningCode[];
  quoteExpiresAtMs: number;
}
