/**
 * Fixed-point money math on BigInt.
 *
 * Financial precision rule (plan p.5): no floating-point token math.
 * USD values are integer micro-dollars (1 USD = 1_000_000 microUsd).
 * Token amounts are integer base units per the mint's decimals.
 *
 * Rounding policy (documented, tested):
 *  - Anything that counts AGAINST the user (costs, fees, impact) rounds UP.
 *  - Anything that counts FOR the user (proceeds, final value) rounds DOWN.
 * Net estimates are therefore always conservative.
 */

export const MICRO_USD = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;

/** Parse a user-facing USD number (e.g. 500 or 499.99) into microUsd. Rejects NaN/negatives/precision loss. */
export function usdToMicro(usd: number): bigint {
  if (!Number.isFinite(usd)) throw new RangeError("amount must be a finite number");
  if (usd <= 0) throw new RangeError("amount must be positive");
  // Two-decimal cents is the finest user input we accept; anything finer is rejected
  const cents = Math.round(usd * 100);
  if (Math.abs(usd * 100 - cents) > 1e-9) {
    throw new RangeError("amount supports at most 2 decimal places");
  }
  return BigInt(cents) * 10_000n;
}

export function microToUsdString(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO_USD;
  const frac = (abs % MICRO_USD).toString().padStart(6, "0").slice(0, 2);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Ceiling division for non-negative operands: cost-side rounding. */
export function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  if (numerator < 0n) throw new RangeError("numerator must be non-negative");
  return (numerator + denominator - 1n) / denominator;
}

/** Floor division for non-negative operands: proceeds-side rounding. */
export function divFloor(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  if (numerator < 0n) throw new RangeError("numerator must be non-negative");
  return numerator / denominator;
}

/** Apply basis points against a value, rounding up (used for buffers/fees charged to the user). */
export function bpsOfCeil(value: bigint, bps: bigint): bigint {
  if (bps < 0n) throw new RangeError("bps must be non-negative");
  return divCeil(value * bps, BPS_DENOMINATOR);
}

/** Return in basis points of `net` relative to `base`, floor-rounded toward zero. */
export function returnBps(net: bigint, base: bigint): bigint {
  if (base <= 0n) throw new RangeError("base must be positive");
  const scaled = net * BPS_DENOMINATOR;
  // BigInt division truncates toward zero, which is what we want for signed nets
  return scaled / base;
}
