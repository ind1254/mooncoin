import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { priceImpactFractionToBpsCeil } from "../src/market/jupiter/units.js";

/**
 * Jupiter's `priceImpactPct` is a decimal fraction (1 = 100%), NOT a
 * percentage number, despite the field name. Getting this wrong by 100x makes
 * every price-impact safety gate in the app inoperative, so the contract is
 * pinned here in two independent ways: an explicit conversion table, and a
 * recorded provider fixture that re-derives the units from measured output.
 */

describe("priceImpactPct unit contract", () => {
  it("converts the provider's decimal fraction to basis points", () => {
    // fraction -> bps is x10_000, because 1.0 is 100%.
    expect(priceImpactFractionToBpsCeil("0.0001")).toBe(1n); // 0.01%
    expect(priceImpactFractionToBpsCeil("0.001")).toBe(10n); // 0.1%
    expect(priceImpactFractionToBpsCeil("0.01")).toBe(100n); // 1%
    expect(priceImpactFractionToBpsCeil("0.03")).toBe(300n); // 3%
    expect(priceImpactFractionToBpsCeil("0.5")).toBe(5_000n); // 50%
    expect(priceImpactFractionToBpsCeil("1")).toBe(10_000n); // 100%
    expect(priceImpactFractionToBpsCeil("0")).toBe(0n);
  });

  it("does not read the field as a percentage number", () => {
    // The historical bug: treating 0.03 as "0.03%" yielded 3 bps, so a token
    // costing 3% to trade sailed through a 100 bps (1%) limit.
    expect(priceImpactFractionToBpsCeil("0.03")).not.toBe(3n);
    expect(priceImpactFractionToBpsCeil("0.01")).not.toBe(1n);
  });

  it("parses high-precision strings without float drift", () => {
    // parseFloat would discard the tail; 0.001366... is 13.66 bps.
    expect(priceImpactFractionToBpsCeil("0.001366339669935170085524648")).toBe(14n);
    expect(priceImpactFractionToBpsCeil("0.8023483959763844518847727822")).toBe(8_024n);
    expect(priceImpactFractionToBpsCeil("0.9985389424213976969423589901")).toBe(9_986n);
  });

  it("rounds up, because impact is a cost to the user", () => {
    expect(priceImpactFractionToBpsCeil("0.00001")).toBe(1n); // 0.1 bps -> 1
    expect(priceImpactFractionToBpsCeil("0.000100001")).toBe(2n); // just over 1 bps
    // A tail beyond retained precision must still round up, never down.
    expect(priceImpactFractionToBpsCeil("0.0001000000000000001")).toBe(2n);
  });

  it("treats negative impact as zero rather than a tradeable discount", () => {
    expect(priceImpactFractionToBpsCeil("-0.5")).toBe(0n);
    expect(priceImpactFractionToBpsCeil("-0.0001")).toBe(0n);
  });

  it("understands exponent notation rather than failing the quote", () => {
    expect(priceImpactFractionToBpsCeil("1e-4")).toBe(1n);
    expect(priceImpactFractionToBpsCeil("1.5e-3")).toBe(15n);
    expect(priceImpactFractionToBpsCeil("1e0")).toBe(10_000n);
  });

  it("rejects an unparseable value instead of guessing", () => {
    expect(() => priceImpactFractionToBpsCeil("abc")).toThrow();
    expect(() => priceImpactFractionToBpsCeil("")).toThrow();
    expect(() => priceImpactFractionToBpsCeil("0.1.2")).toThrow();
  });
});

describe("recorded provider evidence", () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, "fixtures", "jupiter", "price-impact-contract.json"), "utf8"),
  ) as { legs: { label: string; inAmount: string; outAmount: string; priceImpactPct: string }[] };

  /**
   * Re-derives the units from the recorded ladder without trusting the field's
   * name. The smallest leg is close enough to mid price to serve as a
   * reference; scaling it predicts the zero-impact output at larger sizes, and
   * the shortfall is the real impact. If the field were a percentage number,
   * the $100M leg would claim ~1% impact on a trade that measurably lost
   * ~99.9% of its value.
   */
  const [reference, ...rest] = fixture.legs;
  if (!reference) throw new Error("price-impact-contract fixture must contain a reference leg");
  const rate = Number(reference.outAmount) / Number(reference.inAmount);

  for (const leg of rest) {
    it(`matches independently measured impact at the ${leg.label} leg`, () => {
      const zeroImpactOut = Number(leg.inAmount) * rate;
      const measuredPct = (1 - Number(leg.outAmount) / zeroImpactOut) * 100;

      const asFractionPct = Number(priceImpactFractionToBpsCeil(leg.priceImpactPct)) / 100;
      const asPercentReading = Number(leg.priceImpactPct);

      // Reading the field as a fraction reproduces the measurement.
      expect(Math.abs(asFractionPct - measuredPct)).toBeLessThan(1);
      // Reading it as a percentage number does not, by about two orders of magnitude.
      expect(Math.abs(asPercentReading - measuredPct)).toBeGreaterThan(10);
      // Sanity: these really are large, unmistakable impacts.
      expect(measuredPct).toBeGreaterThan(50);
    });
  }

  it("never reports impact at or above 100% of the field's saturation point", () => {
    // The field saturates toward 1.0; that ceiling is only possible for a fraction.
    for (const leg of fixture.legs) {
      expect(Number(leg.priceImpactPct)).toBeLessThanOrEqual(1);
      expect(priceImpactFractionToBpsCeil(leg.priceImpactPct)).toBeLessThanOrEqual(10_000n);
    }
  });
});
