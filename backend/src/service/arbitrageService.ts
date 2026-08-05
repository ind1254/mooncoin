import { calculate } from "../core/calculator.js";
import { ArbError } from "../core/errors.js";
import type { CalculationOutcome, NormalizedQuote, VerifiedToken } from "../core/types.js";
import type { QuoteAdapter } from "../adapters/types.js";

export interface ArbitrageComparison {
  buyQuote: NormalizedQuote;
  sellQuote: NormalizedQuote;
  outcome: CalculationOutcome;
  /** Venues that failed to quote, with their error codes (FR-06 visibility). */
  providerFailures: { venueId: string; code: string }[];
}

export interface ServiceConfig {
  /** Flat round-trip network + priority fee estimate, microUsd. */
  networkFeeMicroUsd: bigint;
  safetyBufferBps: bigint;
}

export const DEFAULT_CONFIG: ServiceConfig = {
  networkFeeMicroUsd: 50_000n, // $0.05 round trip incl. priority fees
  safetyBufferBps: 30n, // 0.30% of starting amount
};

/**
 * Fetch buy quotes on every venue, buy on the best one, then sell the exact
 * token amount received on each OTHER venue and keep the best sell (ARB-005).
 * The final pair is always two distinct venues; the calculator + risk rules
 * decide whether it counts as an opportunity.
 */
export async function findBestRoundTrip(
  token: VerifiedToken,
  amountMicroUsd: bigint,
  adapters: QuoteAdapter[],
  config: ServiceConfig,
  signal: AbortSignal,
  nowMs: () => number = Date.now,
): Promise<ArbitrageComparison> {
  if (adapters.length < 2) {
    throw new ArbError("INSUFFICIENT_VENUES", "At least two enabled venues are required", 409);
  }

  const providerFailures: { venueId: string; code: string }[] = [];

  const buyResults = await Promise.allSettled(
    adapters.map((a) => a.getBuyQuote({ token, amountMicroUsd }, signal)),
  );
  const buys: NormalizedQuote[] = [];
  buyResults.forEach((r, i) => {
    if (r.status === "fulfilled") {
      buys.push(r.value);
    } else {
      const code = r.reason instanceof ArbError ? r.reason.code : "PROVIDER_ERROR";
      providerFailures.push({ venueId: adapters[i]!.venueId, code });
    }
  });
  if (buys.length === 0) {
    throw new ArbError("PROVIDER_ERROR", "No venue returned a buy quote", 502, {
      providerFailures,
    });
  }

  const bestBuy = buys.reduce((a, b) => (b.outAmount > a.outAmount ? b : a));

  // Skip the buy venue and anything that already failed — no point re-querying it
  const failedVenues = new Set(providerFailures.map((f) => f.venueId));
  const sellAdapters = adapters.filter(
    (a) => a.venueId !== bestBuy.venueId && !failedVenues.has(a.venueId),
  );
  const sellResults = await Promise.allSettled(
    sellAdapters.map((a) =>
      a.getSellQuote({ token, amountTokenUnits: bestBuy.outAmount }, signal),
    ),
  );
  const sells: NormalizedQuote[] = [];
  sellResults.forEach((r, i) => {
    if (r.status === "fulfilled") {
      sells.push(r.value);
    } else {
      const code = r.reason instanceof ArbError ? r.reason.code : "PROVIDER_ERROR";
      providerFailures.push({ venueId: sellAdapters[i]!.venueId, code });
    }
  });
  if (sells.length === 0) {
    throw new ArbError("PROVIDER_ERROR", "No counterpart venue returned a sell quote", 502, {
      providerFailures,
    });
  }

  const bestSell = sells.reduce((a, b) => (b.outAmount > a.outAmount ? b : a));

  const outcome = calculate({
    buyQuote: bestBuy,
    sellQuote: bestSell,
    startingAmountMicroUsd: amountMicroUsd,
    networkFeeMicroUsd: config.networkFeeMicroUsd,
    safetyBufferBps: config.safetyBufferBps,
    nowMs: nowMs(),
  });

  if (providerFailures.length > 0 && !outcome.warnings.includes("PROVIDER_FAILURE")) {
    outcome.warnings.push("PROVIDER_FAILURE");
  }

  return { buyQuote: bestBuy, sellQuote: bestSell, outcome, providerFailures };
}
