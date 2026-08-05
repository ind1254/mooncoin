import { describe, expect, it } from "vitest";
import { calculate } from "../src/core/calculator.js";
import { usdToMicro, microToUsdString, bpsOfCeil } from "../src/core/money.js";
import type { CalculationInput, NormalizedQuote } from "../src/core/types.js";

const NOW = 1_700_000_000_000;
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function quote(overrides: Partial<NormalizedQuote>): NormalizedQuote {
  return {
    venueId: "raydium",
    side: "buy",
    tokenMint: MINT,
    inAmount: 500_000_000n,
    outAmount: 1_000_000n,
    feeMicroUsd: 0n,
    priceImpactBps: 10n,
    retrievedAtMs: NOW,
    expiresAtMs: NOW + 20_000,
    ...overrides,
  };
}

function baseInput(overrides: Partial<CalculationInput> = {}): CalculationInput {
  const buy = quote({ venueId: "raydium", side: "buy", outAmount: 350_000_000n });
  const sell = quote({
    venueId: "orca",
    side: "sell",
    inAmount: 350_000_000n,
    outAmount: 511_200_000n, // $511.20 back on $500
  });
  return {
    buyQuote: buy,
    sellQuote: sell,
    startingAmountMicroUsd: usdToMicro(500),
    networkFeeMicroUsd: 50_000n,
    safetyBufferBps: 30n,
    nowMs: NOW,
    ...overrides,
  };
}

describe("calculation engine", () => {
  it("computes a conservative net profit with exact gross/net/cost identity", () => {
    const r = calculate(baseInput());
    expect(r.netProfitMicroUsd).toBe(
      r.grossSpreadMicroUsd - r.costs.totalMicroUsd,
    );
    expect(r.estimatedFinalMicroUsd).toBe(511_200_000n);
    // $511.20 - $500 - $0.05 network - $1.50 buffer = $9.65
    expect(microToUsdString(r.netProfitMicroUsd)).toBe("9.65");
    expect(r.isProfitable).toBe(true);
  });

  it("increasing any cost never increases net profit", () => {
    const base = calculate(baseInput());
    const higherNetwork = calculate(baseInput({ networkFeeMicroUsd: 100_000n }));
    const higherBuffer = calculate(baseInput({ safetyBufferBps: 100n }));
    const higherFee = calculate(
      baseInput({ sellQuote: { ...baseInput().sellQuote, feeMicroUsd: 500_000n } }),
    );
    const higherImpact = calculate(
      baseInput({ sellQuote: { ...baseInput().sellQuote, priceImpactBps: 50n } }),
    );
    for (const variant of [higherNetwork, higherBuffer, higherFee, higherImpact]) {
      expect(variant.netProfitMicroUsd <= base.netProfitMicroUsd).toBe(true);
    }
  });

  it("a stale quote is never labeled live or profitable", () => {
    const r = calculate(baseInput({ nowMs: NOW + 60_000 }));
    expect(r.warnings).toContain("STALE_QUOTE");
    expect(r.isProfitable).toBe(false);
  });

  it("different mint addresses are never treated as the same token", () => {
    const input = baseInput();
    input.sellQuote = {
      ...input.sellQuote,
      tokenMint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // same symbol scenario
    };
    const r = calculate(input);
    expect(r.warnings).toContain("TOKEN_MISMATCH");
    expect(r.isProfitable).toBe(false);
  });

  it("zero or negative net never creates an opportunity", () => {
    const input = baseInput();
    input.sellQuote = { ...input.sellQuote, outAmount: 500_000_000n }; // exactly break-even pre-costs
    const r = calculate(input);
    expect(r.netProfitMicroUsd <= 0n).toBe(true);
    expect(r.warnings).toContain("NOT_PROFITABLE");
    expect(r.isProfitable).toBe(false);
  });

  it("same-venue round trips are rejected", () => {
    const input = baseInput();
    input.sellQuote = { ...input.sellQuote, venueId: "raydium" };
    const r = calculate(input);
    expect(r.warnings).toContain("SAME_VENUE");
    expect(r.isProfitable).toBe(false);
  });

  it("a sell that does not consume the exact buy output is incomplete", () => {
    const input = baseInput();
    input.sellQuote = { ...input.sellQuote, inAmount: 349_999_999n };
    const r = calculate(input);
    expect(r.warnings).toContain("INCOMPLETE_DATA");
    expect(r.isProfitable).toBe(false);
  });

  it("excessive price impact is rejected as low liquidity", () => {
    const input = baseInput();
    input.buyQuote = { ...input.buyQuote, priceImpactBps: 400n };
    const r = calculate(input);
    expect(r.warnings).toContain("HIGH_PRICE_IMPACT");
    expect(r.warnings).toContain("LOW_LIQUIDITY");
    expect(r.isProfitable).toBe(false);
  });

  it("result expiry is the earliest quote expiry", () => {
    const input = baseInput();
    input.buyQuote = { ...input.buyQuote, expiresAtMs: NOW + 5_000 };
    const r = calculate(input);
    expect(r.quoteExpiresAtMs).toBe(NOW + 5_000);
  });
});

describe("money math boundaries", () => {
  it("parses user amounts exactly and rejects bad input", () => {
    expect(usdToMicro(500)).toBe(500_000_000n);
    expect(usdToMicro(0.01)).toBe(10_000n);
    expect(usdToMicro(499.99)).toBe(499_990_000n);
    expect(() => usdToMicro(0)).toThrow();
    expect(() => usdToMicro(-5)).toThrow();
    expect(() => usdToMicro(NaN)).toThrow();
    expect(() => usdToMicro(1.999)).toThrow(); // sub-cent precision rejected
  });

  it("cost-side bps rounding always rounds up", () => {
    // 1 microUsd at 1 bps -> ceil(1/10000) = 1, never 0
    expect(bpsOfCeil(1n, 1n)).toBe(1n);
    expect(bpsOfCeil(10_000n, 1n)).toBe(1n);
    expect(bpsOfCeil(10_001n, 1n)).toBe(2n);
  });

  it("formats negative values correctly", () => {
    expect(microToUsdString(-7_300_000n)).toBe("-7.30");
    expect(microToUsdString(3_900_000n)).toBe("3.90");
  });
});
