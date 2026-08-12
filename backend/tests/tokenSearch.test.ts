import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JupiterTokenSearchProvider } from "../src/market/jupiter/tokenSearch.js";

/**
 * Offline tests against responses recorded from Jupiter's public token API.
 * Re-record with: node scripts/refresh-jupiter-fixtures.mjs
 *
 * Drift warning: these fixtures carry live market values. Assertions here stay
 * on shape and on stable identity fields (mint, decimals, tokenProgram) and
 * never on a price or liquidity number.
 */

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const START = 1_760_000_000_000;

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/jupiter/${name}.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { response: unknown }).response;
}

function provider(
  respond: (url: string) => Response,
  onCall?: () => void,
): JupiterTokenSearchProvider {
  return new JupiterTokenSearchProvider({
    clock: () => START,
    fetchImpl: async (url) => {
      onCall?.();
      return respond(String(url));
    },
  });
}

const serve = (name: string) => () => new Response(JSON.stringify(fixture(name)), { status: 200 });

describe("token search — normalization", () => {
  it("normalizes identity and market facts from a ticker query", async () => {
    const results = await provider(serve("search-bonk")).search("BONK");
    expect(results.length).toBeGreaterThan(5);

    const bonk = results.find((r) => r.mint === BONK);
    expect(bonk).toBeDefined();
    expect(bonk!.symbol).toBe("Bonk");
    expect(bonk!.decimals).toBe(5);
    expect(bonk!.tokenProgram).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(bonk!.verifiedByProvider).toBe(true);
    expect(bonk!.source).toBe("jupiter:tokens-v2");
    // Money arrives as bigint at the documented scales, never float.
    expect(typeof bonk!.market.priceUsdPico).toBe("bigint");
    expect(bonk!.market.priceUsdPico! > 0n).toBe(true);
    expect(typeof bonk!.market.liquidityUsdMicro).toBe("bigint");
    expect(bonk!.market.holderCount).toBeGreaterThan(0);
  });

  it("surfaces distinct mints that share a ticker", async () => {
    const results = await provider(serve("search-bonk")).search("BONK");
    const named = results.filter((r) => r.symbol.toLowerCase() === "bonk");

    // Real data: several different tokens are all called "Bonk".
    expect(named.length).toBeGreaterThan(1);
    expect(new Set(named.map((r) => r.mint)).size).toBe(named.length);
  });

  it("resolves a mint-address query to exactly that token", async () => {
    const p = provider(serve("search-usdc-mint"));
    const token = await p.getByMint(USDC);
    expect(token).not.toBeNull();
    expect(token!.mint).toBe(USDC);
    expect(token!.symbol).toBe("USDC");
    expect(token!.decimals).toBe(6);
  });

  it("keeps provider authority claims separate from truth, and preserves 'not reported'", async () => {
    const bonk = (await provider(serve("search-bonk")).search("BONK")).find((r) => r.mint === BONK)!;
    const usdc = (await provider(serve("search-usdc-mint")).search(USDC))[0]!;

    // Jupiter reports BONK's authorities as disabled...
    expect(bonk.providerClaims.mintAuthorityDisabled).toBe(true);
    // ...and omits the key entirely for USDC, whose authorities are active.
    // Absence must stay null, never be coerced to false.
    expect(usdc.providerClaims.mintAuthorityDisabled).toBeNull();
  });

  it("returns nothing for a query that matches no token", async () => {
    expect(await provider(serve("search-empty")).search("zzzqqqxxnotarealtoken")).toEqual([]);
  });

  it("returns null when a mint is well-formed but unknown", async () => {
    const p = provider(serve("search-empty"));
    expect(await p.getByMint("FLooFDemo1111111111111111111111111111111111")).toBeNull();
  });

  it("never matches a mint query against a different token", async () => {
    // The provider replies with BONK regardless; asking for USDC must not
    // accept it just because the upstream returned something.
    const p = provider(serve("search-bonk"));
    expect(await p.getByMint(USDC)).toBeNull();
  });
});

describe("token search — validation and failures", () => {
  it("skips the network for queries shorter than two characters", async () => {
    let calls = 0;
    const p = provider(serve("search-bonk"), () => calls++);
    expect(await p.search("b")).toEqual([]);
    expect(await p.search(" ")).toEqual([]);
    expect(calls).toBe(0);
  });

  it("rejects a malformed mint before making a request", async () => {
    let calls = 0;
    const p = provider(serve("search-bonk"), () => calls++);
    await expect(p.getByMint("0OIl-not-an-address")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toBe(0);
  });

  it("maps a 429 to a dedicated rate-limit error", async () => {
    const p = provider(() => new Response("{}", { status: 429 }));
    await expect(p.search("bonk")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
  });

  it("maps other HTTP failures to a provider error", async () => {
    const p = provider(() => new Response("{}", { status: 500 }));
    await expect(p.search("bonk")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("rejects an unrecognized response shape", async () => {
    const p = provider(() => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(p.search("bonk")).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("rejects a record missing required identity rather than guessing", async () => {
    const p = provider(() => new Response(JSON.stringify([{ name: "No Id", symbol: "XX", decimals: 6 }]), { status: 200 }));
    await expect(p.search("xx")).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("tolerates a record that omits optional market fields", async () => {
    const minimal = [{ id: BONK, name: "Bonk", symbol: "Bonk", decimals: 5 }];
    const p = provider(() => new Response(JSON.stringify(minimal), { status: 200 }));
    const [only] = await p.search("bonk");
    expect(only!.mint).toBe(BONK);
    expect(only!.market.priceUsdPico).toBeNull();
    expect(only!.market.liquidityUsdMicro).toBeNull();
    expect(only!.providerClaims.mintAuthorityDisabled).toBeNull();
  });
});

describe("token search — caching", () => {
  it("serves repeat queries from cache", async () => {
    let calls = 0;
    const p = provider(serve("search-bonk"), () => calls++);
    await p.search("BONK");
    await p.search("bonk"); // same query, different case
    await p.search("  BONK  ");
    expect(calls).toBe(1);
  });

  it("collapses concurrent identical queries into one request", async () => {
    let calls = 0;
    const p = provider(serve("search-bonk"), () => calls++);
    await Promise.all([p.search("BONK"), p.search("BONK"), p.search("BONK")]);
    expect(calls).toBe(1);
  });
});
