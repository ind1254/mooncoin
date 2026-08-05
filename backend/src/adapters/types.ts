import type { NormalizedQuote, VerifiedToken } from "../core/types.js";

/** Normalized quote-adapter interface (ARB-002). One adapter per venue. */

export interface BuyQuoteRequest {
  token: VerifiedToken;
  /** USD spent, in microUsd (== USDC base units, both 1e-6). */
  amountMicroUsd: bigint;
}

export interface SellQuoteRequest {
  token: VerifiedToken;
  /** Token base units to sell (must equal the buy quote's outAmount). */
  amountTokenUnits: bigint;
}

export interface QuoteAdapter {
  readonly venueId: string;
  /** USDC -> token executable quote on this venue only. */
  getBuyQuote(req: BuyQuoteRequest, signal: AbortSignal): Promise<NormalizedQuote>;
  /** token -> USDC executable quote on this venue only. */
  getSellQuote(req: SellQuoteRequest, signal: AbortSignal): Promise<NormalizedQuote>;
}

/** How long a fetched quote stays displayable before it is stale (FR-04). */
export const QUOTE_TTL_MS = 20_000;

/** Per-provider request timeout. */
export const PROVIDER_TIMEOUT_MS = 6_000;
