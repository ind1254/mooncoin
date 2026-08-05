import { describe, expect, it } from "vitest";
import { MockVenueAdapter } from "../src/adapters/mock.js";
import { percentStringToBpsCeil } from "../src/adapters/jupiter.js";
import { ArbError } from "../src/core/errors.js";
import { findBestRoundTrip, DEFAULT_CONFIG } from "../src/service/arbitrageService.js";
import type { VerifiedToken } from "../src/core/types.js";
import { usdToMicro } from "../src/core/money.js";

const BONK: VerifiedToken = {
  mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  symbol: "BONK",
  name: "Bonk",
  decimals: 5,
  enabled: true,
};

const signal = new AbortController().signal;

describe("round-trip orchestration", () => {
  it("buys on the cheaper venue and sells on the richer one", async () => {
    const adapters = [
      new MockVenueAdapter("raydium", 1_400n),
      new MockVenueAdapter("orca", 1_420n),
    ];
    const r = await findBestRoundTrip(BONK, usdToMicro(500), adapters, DEFAULT_CONFIG, signal);
    expect(r.buyQuote.venueId).toBe("raydium");
    expect(r.sellQuote.venueId).toBe("orca");
    expect(r.sellQuote.inAmount).toBe(r.buyQuote.outAmount);
    expect(r.outcome.netProfitMicroUsd > 0n).toBe(true);
    expect(r.outcome.isProfitable).toBe(true);
  });

  it("no spread means no opportunity", async () => {
    const adapters = [
      new MockVenueAdapter("raydium", 1_400n),
      new MockVenueAdapter("orca", 1_400n),
    ];
    const r = await findBestRoundTrip(BONK, usdToMicro(500), adapters, DEFAULT_CONFIG, signal);
    expect(r.outcome.isProfitable).toBe(false);
    expect(r.outcome.warnings).toContain("NOT_PROFITABLE");
  });

  it("a failing provider degrades gracefully with visibility", async () => {
    const adapters = [
      new MockVenueAdapter("raydium", 1_400n),
      new MockVenueAdapter("orca", 1_420n),
      new MockVenueAdapter(
        "broken",
        1_000n,
        10n,
        new ArbError("PROVIDER_TIMEOUT", "timeout", 504),
      ),
    ];
    const r = await findBestRoundTrip(BONK, usdToMicro(500), adapters, DEFAULT_CONFIG, signal);
    expect(r.providerFailures).toEqual([{ venueId: "broken", code: "PROVIDER_TIMEOUT" }]);
    expect(r.outcome.warnings).toContain("PROVIDER_FAILURE");
    // Calculation still succeeds on the two healthy venues
    expect(r.buyQuote.venueId).toBe("raydium");
    expect(r.sellQuote.venueId).toBe("orca");
  });

  it("fails safely when every provider is down", async () => {
    const boom = new ArbError("PROVIDER_ERROR", "down", 502);
    const adapters = [
      new MockVenueAdapter("raydium", 1_400n, 10n, boom),
      new MockVenueAdapter("orca", 1_420n, 10n, boom),
    ];
    await expect(
      findBestRoundTrip(BONK, usdToMicro(500), adapters, DEFAULT_CONFIG, signal),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("requires at least two venues", async () => {
    await expect(
      findBestRoundTrip(BONK, usdToMicro(500), [new MockVenueAdapter("raydium", 1_400n)], DEFAULT_CONFIG, signal),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_VENUES" });
  });
});

describe("provider response parsing", () => {
  it("converts percent strings to bps rounding up", () => {
    expect(percentStringToBpsCeil("0.05")).toBe(5n); // 0.05% = 5 bps
    expect(percentStringToBpsCeil("1")).toBe(100n);
    expect(percentStringToBpsCeil("0.0001")).toBe(1n); // rounds up, never 0 for nonzero impact
    expect(percentStringToBpsCeil("0")).toBe(0n);
  });

  it("rejects malformed impact strings", () => {
    expect(() => percentStringToBpsCeil("abc")).toThrow();
    expect(() => percentStringToBpsCeil("")).toThrow();
  });
});
