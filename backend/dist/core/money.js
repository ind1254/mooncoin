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
export const MICRO_USD = 1000000n;
export const BPS_DENOMINATOR = 10000n;
/** Parse a user-facing USD number (e.g. 500 or 499.99) into microUsd. Rejects NaN/negatives/precision loss. */
export function usdToMicro(usd) {
    if (!Number.isFinite(usd))
        throw new RangeError("amount must be a finite number");
    if (usd <= 0)
        throw new RangeError("amount must be positive");
    // Two-decimal cents is the finest user input we accept; anything finer is rejected
    const cents = Math.round(usd * 100);
    if (Math.abs(usd * 100 - cents) > 1e-9) {
        throw new RangeError("amount supports at most 2 decimal places");
    }
    return BigInt(cents) * 10000n;
}
export function microToUsdString(micro) {
    const negative = micro < 0n;
    const abs = negative ? -micro : micro;
    const whole = abs / MICRO_USD;
    const frac = (abs % MICRO_USD).toString().padStart(6, "0").slice(0, 2);
    return `${negative ? "-" : ""}${whole}.${frac}`;
}
/** Ceiling division for non-negative operands: cost-side rounding. */
export function divCeil(numerator, denominator) {
    if (denominator <= 0n)
        throw new RangeError("denominator must be positive");
    if (numerator < 0n)
        throw new RangeError("numerator must be non-negative");
    return (numerator + denominator - 1n) / denominator;
}
/** Floor division for non-negative operands: proceeds-side rounding. */
export function divFloor(numerator, denominator) {
    if (denominator <= 0n)
        throw new RangeError("denominator must be positive");
    if (numerator < 0n)
        throw new RangeError("numerator must be non-negative");
    return numerator / denominator;
}
/** Apply basis points against a value, rounding up (used for buffers/fees charged to the user). */
export function bpsOfCeil(value, bps) {
    if (bps < 0n)
        throw new RangeError("bps must be non-negative");
    return divCeil(value * bps, BPS_DENOMINATOR);
}
/** Return in basis points of `net` relative to `base`, floor-rounded toward zero. */
export function returnBps(net, base) {
    if (base <= 0n)
        throw new RangeError("base must be positive");
    const scaled = net * BPS_DENOMINATOR;
    // BigInt division truncates toward zero, which is what we want for signed nets
    return scaled / base;
}
// ---------------------------------------------------------------------------
// SOL / lamports and pico-USD token-price helpers (paper-trading MVP)
// ---------------------------------------------------------------------------
export const LAMPORTS_PER_SOL = 1000000000n;
/** Token prices use pico-USD per whole token (1 USD = 1e12). */
export const PICO_USD = 1000000000000n;
/** Parse user-facing SOL (up to 4 decimal places) into lamports. */
export function solToLamports(sol) {
    if (!Number.isFinite(sol))
        throw new RangeError("SOL amount must be finite");
    if (sol <= 0)
        throw new RangeError("SOL amount must be positive");
    const tenThousandths = Math.round(sol * 10_000);
    if (Math.abs(sol * 10_000 - tenThousandths) > 1e-6) {
        throw new RangeError("SOL amount supports at most 4 decimal places");
    }
    return BigInt(tenThousandths) * 100000n;
}
export function lamportsToSolString(lamports, dp = 4) {
    const negative = lamports < 0n;
    const abs = negative ? -lamports : lamports;
    const whole = abs / LAMPORTS_PER_SOL;
    const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, "0").slice(0, dp);
    return `${negative ? "-" : ""}${whole}${dp > 0 ? "." + frac : ""}`;
}
/** Format a pico-USD token price for display with adaptive precision. */
export function picoUsdToPriceString(pico) {
    if (pico <= 0n)
        return "0";
    const usd = Number(pico) / 1e12; // display only — never used for arithmetic
    if (usd >= 1)
        return usd.toFixed(4);
    if (usd >= 0.001)
        return usd.toFixed(6);
    return usd.toFixed(9);
}
/** Format token base units for display (grouped, truncated decimals). */
export function tokenUnitsToDisplay(units, decimals, dp = 2) {
    const scale = 10n ** BigInt(decimals);
    const whole = units / scale;
    const fracUnits = units % scale;
    const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (dp <= 0 || decimals === 0)
        return grouped;
    const frac = fracUnits.toString().padStart(decimals, "0").slice(0, dp);
    return `${grouped}.${frac}`;
}
/**
 * Parse a user-entered decimal amount into base units, using text rather than
 * floats so "0.1" never becomes 0.09999999999999999.
 */
export function decimalToBaseUnits(value, decimals) {
    const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
    if (!match)
        throw new RangeError("Amount must be a positive decimal number");
    const whole = match[1] ?? "0";
    const fracRaw = match[2] ?? "";
    if (fracRaw.length > decimals) {
        throw new RangeError(`This token supports at most ${decimals} decimal places`);
    }
    const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
    const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac === "" ? "0" : frac);
    if (units <= 0n)
        throw new RangeError("Amount must be greater than zero");
    return units;
}
/** Render base units as a plain decimal string, exact (no float). */
export function baseUnitsToDecimalString(units, decimals) {
    if (decimals === 0)
        return units.toString();
    const scale = 10n ** BigInt(decimals);
    const whole = units / scale;
    const frac = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole.toString();
}
/** value * (10000 - bps) / 10000, floored — a haircut against the user. */
export function applyHaircutFloor(value, bps) {
    if (bps < 0n || bps > BPS_DENOMINATOR)
        throw new RangeError("bps out of range");
    return (value * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR;
}
