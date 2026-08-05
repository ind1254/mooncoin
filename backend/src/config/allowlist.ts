import type { VerifiedToken, Venue } from "../core/types.js";

/**
 * Verified token + venue allowlist (FR-01, FR-10, ARB-006).
 * Identity is always the immutable mint address. Admin endpoints flip
 * `enabled` at runtime without a mobile release; in production this table
 * lives in Postgres (see db/schema.sql) and this module becomes a repository.
 */

/** USDC is the quote currency for every round trip. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

const tokens = new Map<string, VerifiedToken>([
  [
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    {
      mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      symbol: "BONK",
      name: "Bonk",
      decimals: 5,
      enabled: true,
    },
  ],
  [
    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    {
      mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
      symbol: "WIF",
      name: "dogwifhat",
      decimals: 6,
      enabled: true,
    },
  ],
]);

const venues = new Map<string, Venue>([
  ["raydium", { id: "raydium", displayName: "Raydium", enabled: true }],
  ["orca", { id: "orca", displayName: "Orca", enabled: true }],
]);

/** Amount guardrails (FR-02). */
export const AMOUNT_LIMITS = {
  minUsd: 1,
  maxUsd: 10_000,
};

export function getEnabledToken(mint: string): VerifiedToken | undefined {
  const t = tokens.get(mint);
  return t?.enabled ? t : undefined;
}

export function listTokens(): VerifiedToken[] {
  return [...tokens.values()];
}

export function getEnabledVenue(id: string): Venue | undefined {
  const v = venues.get(id);
  return v?.enabled ? v : undefined;
}

export function listVenues(): Venue[] {
  return [...venues.values()];
}

export function setTokenEnabled(mint: string, enabled: boolean): boolean {
  const t = tokens.get(mint);
  if (!t) return false;
  t.enabled = enabled;
  return true;
}

export function setVenueEnabled(id: string, enabled: boolean): boolean {
  const v = venues.get(id);
  if (!v) return false;
  v.enabled = enabled;
  return true;
}
