import { describe, expect, it } from "vitest";
import { CachedLoader } from "../src/market/cache.js";
import { ArbError } from "../src/core/errors.js";

const START = 1_760_000_000_000;

function makeLoader<T>(ttlMs = 10_000, extra: Partial<{ failureTtlMs: number; rateLimitTtlMs: number; maxEntries: number }> = {}) {
  const clockRef = { now: START };
  const loader = new CachedLoader<T>({ ttlMs, clock: () => clockRef.now, ...extra });
  return { loader, clockRef };
}

/** A fetcher that counts invocations and resolves after a microtask. */
function countingFetcher<T>(value: T) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: async () => {
      calls++;
      await Promise.resolve();
      return value;
    },
  };
}

describe("CachedLoader — TTL", () => {
  it("serves from cache inside the TTL and fetches once", async () => {
    const { loader } = makeLoader<string>();
    const f = countingFetcher("bonk");

    const first = await loader.load("k", f.fn);
    const second = await loader.load("k", f.fn);

    expect(f.calls).toBe(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.value).toBe("bonk");
  });

  it("refetches once the TTL has elapsed", async () => {
    const { loader, clockRef } = makeLoader<string>(10_000);
    const f = countingFetcher("bonk");

    await loader.load("k", f.fn);
    clockRef.now += 9_999;
    await loader.load("k", f.fn);
    expect(f.calls).toBe(1);

    clockRef.now += 2;
    await loader.load("k", f.fn);
    expect(f.calls).toBe(2);
  });

  it("computes age at read time rather than storing it", async () => {
    const { loader, clockRef } = makeLoader<string>(60_000);
    const f = countingFetcher("bonk");

    const fresh = await loader.load("k", f.fn);
    expect(fresh.ageMs).toBe(0);

    clockRef.now += 45_000;
    const aged = await loader.load("k", f.fn);

    // Same cached value, but it must not claim to be fresh.
    expect(aged.fromCache).toBe(true);
    expect(aged.ageMs).toBe(45_000);
    expect(aged.fetchedAtMs).toBe(fresh.fetchedAtMs);
  });

  it("keys entries independently", async () => {
    const { loader } = makeLoader<string>();
    const a = countingFetcher("a");
    const b = countingFetcher("b");
    expect((await loader.load("a", a.fn)).value).toBe("a");
    expect((await loader.load("b", b.fn)).value).toBe("b");
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });
});

describe("CachedLoader — in-flight deduplication", () => {
  it("collapses concurrent cold-cache callers into one fetch", async () => {
    const { loader } = makeLoader<string>();
    const f = countingFetcher("shared");

    // Mirrors the Discover page: every token looked up simultaneously.
    const results = await Promise.all(Array.from({ length: 6 }, () => loader.load("k", f.fn)));

    expect(f.calls).toBe(1);
    expect(results.every((r) => r.value === "shared")).toBe(true);
    expect(loader.stats.dedupedJoins).toBe(5);
  });

  it("propagates a rejection to every joiner", async () => {
    const { loader } = makeLoader<string>();
    let calls = 0;
    const failing = async () => {
      calls++;
      await Promise.resolve();
      throw new ArbError("PROVIDER_ERROR", "down", 502);
    };

    const settled = await Promise.allSettled(Array.from({ length: 4 }, () => loader.load("k", failing)));

    expect(calls).toBe(1);
    expect(settled.every((s) => s.status === "rejected")).toBe(true);
  });

  it("allows a new fetch after the in-flight one settles", async () => {
    const { loader, clockRef } = makeLoader<string>(1_000);
    const f = countingFetcher("v");
    await loader.load("k", f.fn);
    clockRef.now += 2_000;
    await loader.load("k", f.fn);
    expect(f.calls).toBe(2);
  });
});

describe("CachedLoader — negative caching", () => {
  it("remembers a failure briefly instead of retrying immediately", async () => {
    const { loader } = makeLoader<string>(10_000, { failureTtlMs: 5_000 });
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new ArbError("PROVIDER_ERROR", "down", 502);
    };

    await expect(loader.load("k", failing)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    // Replayed from cache — no second network call.
    await expect(loader.load("k", failing)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(calls).toBe(1);
  });

  it("backs off longer for a rate limit than for a generic failure", async () => {
    const { loader, clockRef } = makeLoader<string>(60_000, {
      failureTtlMs: 5_000,
      rateLimitTtlMs: 30_000,
    });
    let calls = 0;
    const throttled = async () => {
      calls++;
      throw new ArbError("PROVIDER_RATE_LIMITED", "429", 503);
    };

    await expect(loader.load("k", throttled)).rejects.toBeTruthy();
    expect(calls).toBe(1);

    // Past the generic failure window, still inside the rate-limit window.
    clockRef.now += 10_000;
    await expect(loader.load("k", throttled)).rejects.toBeTruthy();
    expect(calls).toBe(1);

    clockRef.now += 21_000;
    await expect(loader.load("k", throttled)).rejects.toBeTruthy();
    expect(calls).toBe(2);
  });

  it("recovers once the endpoint comes back", async () => {
    const { loader, clockRef } = makeLoader<string>(10_000, { failureTtlMs: 1_000 });
    let shouldFail = true;
    const flaky = async () => {
      if (shouldFail) throw new ArbError("PROVIDER_ERROR", "down", 502);
      return "recovered";
    };

    await expect(loader.load("k", flaky)).rejects.toBeTruthy();
    shouldFail = false;
    clockRef.now += 1_500;
    expect((await loader.load("k", flaky)).value).toBe("recovered");
  });
});

describe("CachedLoader — housekeeping", () => {
  it("evicts the oldest entries past maxEntries", async () => {
    const { loader } = makeLoader<string>(60_000, { maxEntries: 3 });
    for (const k of ["a", "b", "c", "d"]) {
      await loader.load(k, async () => k);
    }
    expect(loader.stats.size).toBe(3);

    const f = countingFetcher("a-again");
    await loader.load("a", f.fn); // evicted, so this refetches
    expect(f.calls).toBe(1);
  });

  it("invalidate forces the next read to refetch", async () => {
    const { loader } = makeLoader<string>(60_000);
    const f = countingFetcher("v");
    await loader.load("k", f.fn);
    loader.invalidate("k");
    await loader.load("k", f.fn);
    expect(f.calls).toBe(2);
  });

  it("tracks hit and miss counts", async () => {
    const { loader } = makeLoader<string>();
    const f = countingFetcher("v");
    await loader.load("k", f.fn);
    await loader.load("k", f.fn);
    await loader.load("k", f.fn);
    expect(loader.stats.misses).toBe(1);
    expect(loader.stats.hits).toBe(2);
  });
});
