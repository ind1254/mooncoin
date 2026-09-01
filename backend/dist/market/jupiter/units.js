import { ArbError } from "../../core/errors.js";
/**
 * Provider unit semantics for Jupiter's quote response.
 *
 * This file exists because a unit mistake here is silent and dangerous: every
 * price-impact safety gate in Moonpaper (tradability, live paper entry, bot
 * entry/exit, scoring, alerts) compares a bps integer that originates from a
 * single provider field. If that conversion is wrong by a factor of 100, every
 * gate quietly stops gating and the simulation reports fills it could never
 * get. Keeping the conversion in one audited place means there is exactly one
 * thing to prove correct.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT: `priceImpactPct` is a DECIMAL FRACTION, where 1 = 100%.
 * ---------------------------------------------------------------------------
 *
 * The name is misleading — despite the `Pct` suffix the value is NOT a
 * percentage number. Jupiter's OpenAPI schema types it only as `string` with
 * no description, so the contract was established empirically against the live
 * read-only quote endpoint on 2026-08-31 by measuring how much output actually
 * degrades as trade size grows on USDC -> BONK:
 *
 *   inAmount (USDC base units)  outAmount            priceImpactPct
 *   10_000_000_000    ($10k)    332_298_299_827_157  0.00328256729964...
 *   1_000_000_000_000 ($1M)     6_589_559_871_268_266  0.80234839597638...
 *   100_000_000_000_000 ($100M) 4_871_059_072_417_034  0.99853894242139...
 *
 * Scaling the near-mid $10k leg up 100x predicts 33_229_829_982_715_700 output
 * for the $1M trade; the router actually returns 6_589_559_871_268_266, i.e.
 * 80.17% less. The field reads 0.8023. Read as a fraction that is 80.23% —
 * a match. Read as a percentage number it would claim 0.80% impact on a trade
 * that measurably lost 80% of its value. The $100M leg is even starker: a
 * measured 99.85% loss against a field reading of 0.99854.
 *
 * The field also saturates asymptotically toward 1.0 and never exceeds it,
 * which is only possible for a fraction.
 *
 * Therefore:  bps = fraction * 10_000
 *
 *   0.0001 ->     1 bps  (0.01%)
 *   0.001  ->    10 bps  (0.1%)
 *   0.01   ->   100 bps  (1%)
 *   0.03   ->   300 bps  (3%)
 *   1      -> 10_000 bps (100%)
 *
 * See tests/jupiterUnits.test.ts, which pins both the arithmetic and the
 * recorded provider fixtures. If Jupiter ever changes this contract, that test
 * is the thing that should fail first.
 */
/** Fractional digits retained before converting. Far finer than 1 bps. */
const SCALE_DIGITS = 12;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const BPS_PER_UNIT = 10000n;
/**
 * Convert Jupiter's `priceImpactPct` decimal-fraction string to basis points,
 * rounding UP because price impact is a cost borne by the user.
 *
 * Parsed as text, never through `Number`: Jupiter returns values such as
 * "0.001366339669935170085524648", whose tail a float silently discards.
 *
 * Negative impact means the route returned better than the reference price.
 * That is upside, not a cost, so it is reported as zero rather than as a
 * discount that could offset a real cost elsewhere.
 */
export function priceImpactFractionToBpsCeil(raw) {
    const text = raw.trim();
    const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) {
        throw new ArbError("MALFORMED_PROVIDER_RESPONSE", `Unparseable price impact: ${raw}`, 502);
    }
    const negative = match[1] === "-";
    const whole = match[2] ?? "0";
    const fracRaw = match[3] ?? "";
    const exponent = match[4] ? Number(match[4]) : 0;
    // Re-anchor the decimal point for exponent notation so the digits below are
    // always a plain <whole>.<frac> pair.
    const digits = whole + fracRaw;
    let pointIndex = whole.length + exponent;
    let normalizedWhole;
    let normalizedFrac;
    if (pointIndex <= 0) {
        normalizedWhole = "0";
        normalizedFrac = "0".repeat(-pointIndex) + digits;
    }
    else if (pointIndex >= digits.length) {
        normalizedWhole = digits + "0".repeat(pointIndex - digits.length);
        normalizedFrac = "";
    }
    else {
        normalizedWhole = digits.slice(0, pointIndex);
        normalizedFrac = digits.slice(pointIndex);
    }
    const kept = normalizedFrac.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, "0");
    const dropped = normalizedFrac.slice(SCALE_DIGITS);
    // value * 1e12
    let scaled = BigInt(normalizedWhole) * SCALE + BigInt(kept);
    // Truncating the tail must never make an impact look cheaper than it is.
    if (/[1-9]/.test(dropped))
        scaled += 1n;
    if (negative)
        return 0n;
    const bpsScaled = scaled * BPS_PER_UNIT; // bps * 1e12
    return (bpsScaled + SCALE - 1n) / SCALE; // ceil
}
