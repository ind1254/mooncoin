import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CachedLoader } from "../src/market/cache.js";
import { createDemoBundle } from "../src/market/demoProviders.js";
import { createLiveBundle } from "../src/market/liveProviders.js";
import type { MintReadResult } from "../src/market/solana/mint.js";
import { OnChainMintRiskProvider, SOLANA_MAINNET_SOURCE } from "../src/market/solana/riskProvider.js";
import { SolanaRpcClient } from "../src/market/solana/rpc.js";
import type { MarketPoint, TokenRiskFacts, TokenRiskProvider } from "../src/market/types.js";

/**
 * Live-mode overlay, exercised offline against the mainnet fixtures recorded
 * in step 1A. The RPC client is real; only its transport is canned.
 */

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const START = 1_760_000_000_000;
const BASE_SOURCE = "demo-simulator";

function fixtureBody(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/solana/${name}.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { response: unknown }).response;
}

/** Stand-in base provider with known, obviously-simulated values. */
class StubRiskProvider implements TokenRiskProvider {
  readonly source = BASE_SOURCE;
  constructor(private readonly overrides: Partial<TokenRiskFacts> = {}) {}
  async getRiskFacts(): Promise<MarketPoint<TokenRiskFacts>> {
    return {
      value: {
        tokenAgeDays: 400,
        holderConcentrationBps: 1_500n,
        // Deliberately the opposite of what the fixtures say, so an overlay
        // is unmistakable and a missing overlay cannot pass silently.
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        recentInsiderActivity: false,
        dataComplete: true,
        ...this.overrides,
      },
      source: BASE_SOURCE,
      observedAtMs: START - 1_000,
      ageMs: 1_000,
      reliability: "fresh",
    };
  }
}

interface Harness {
  provider: OnChainMintRiskProvider;
  get calls(): number;
}

function harness(
  respond: () => Response,
  opts: { declaredDecimals?: number; clock?: () => number } = {},
): Harness {
  let calls = 0;
  const client = new SolanaRpcClient({
    fetchImpl: async () => {
      calls++;
      return respond();
    },
  });
  const clock = opts.clock ?? (() => START);
  const loader = new CachedLoader<MintReadResult>({ ttlMs: 600_000, clock });
  const provider = new OnChainMintRiskProvider(
    new StubRiskProvider(),
    client,
    loader,
    async () => opts.declaredDecimals,
    clock,
  );
  return {
    provider,
    get calls() {
      return calls;
    },
  };
}

const ok = (name: string) => () =>
  new Response(JSON.stringify(fixtureBody(name)), { status: 200 });

describe("live overlay — successful verification", () => {
  it("replaces the simulated authority flags with on-chain truth", async () => {
    const h = harness(ok("bonk-mint"));
    const point = await h.provider.getRiskFacts(BONK);

    // BONK has both COption tags at 0, so both authorities are renounced.
    expect(point.value.mintAuthorityRevoked).toBe(true);
    expect(point.value.freezeAuthorityRevoked).toBe(true);
    expect(point.value.onChainVerification?.status).toBe("verified");
    expect(point.value.onChainVerification?.decimalsOnChain).toBe(5);
  });

  it("labels verified fields as on-chain and leaves the rest simulated", async () => {
    const h = harness(ok("bonk-mint"));
    const point = await h.provider.getRiskFacts(BONK);

    expect(point.fieldSources).toEqual({
      tokenAgeDays: BASE_SOURCE,
      holderConcentrationBps: BASE_SOURCE,
      mintAuthorityRevoked: SOLANA_MAINNET_SOURCE,
      freezeAuthorityRevoked: SOLANA_MAINNET_SOURCE,
      recentInsiderActivity: BASE_SOURCE,
      dataComplete: BASE_SOURCE,
    });
    expect(point.source).toContain(SOLANA_MAINNET_SOURCE);
  });

  it("reports a live mint authority without treating it as a failure", async () => {
    // USDC holds both authorities. That is a risk input, not a verdict.
    const h = harness(ok("usdc-mint"));
    const point = await h.provider.getRiskFacts("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

    expect(point.value.mintAuthorityRevoked).toBe(false);
    expect(point.value.freezeAuthorityRevoked).toBe(false);
    expect(point.value.onChainVerification?.status).toBe("verified");
    expect(point.value.dataComplete).toBe(true);
  });

  it("flags a decimals mismatch without changing any math", async () => {
    const h = harness(ok("bonk-mint"), { declaredDecimals: 9 }); // chain says 5
    const point = await h.provider.getRiskFacts(BONK);

    expect(point.value.onChainVerification?.decimalsMismatch).toBe(true);
    expect(point.value.onChainVerification?.decimalsOnChain).toBe(5);
  });

  it("reports no mismatch when the catalog agrees", async () => {
    const h = harness(ok("bonk-mint"), { declaredDecimals: 5 });
    const point = await h.provider.getRiskFacts(BONK);
    expect(point.value.onChainVerification?.decimalsMismatch).toBe(false);
  });
});

describe("live overlay — degradation, never exceptions", () => {
  it("keeps simulated values when the mint does not exist", async () => {
    const h = harness(ok("missing-account"));
    const point = await h.provider.getRiskFacts("FLooFDemo1111111111111111111111111111111111");

    expect(point.value.onChainVerification?.status).toBe("not_found");
    // Base values survive, still labelled as simulated.
    expect(point.value.mintAuthorityRevoked).toBe(false);
    expect(point.fieldSources?.mintAuthorityRevoked).toBe(BASE_SOURCE);
    // Unverifiable counts as incomplete, which the scorer treats as risk.
    expect(point.value.dataComplete).toBe(false);
  });

  it("keeps simulated values for a Token-2022 mint", async () => {
    const h = harness(ok("token2022-mint"));
    const point = await h.provider.getRiskFacts(BONK);

    expect(point.value.onChainVerification?.status).toBe("unsupported_program");
    expect(point.value.onChainVerification?.detail).toMatch(/Token-2022/);
    expect(point.fieldSources?.mintAuthorityRevoked).toBe(BASE_SOURCE);
    expect(point.value.dataComplete).toBe(false);
  });

  it("survives a rate limit and explains it", async () => {
    const h = harness(() => new Response("{}", { status: 429 }));
    const point = await h.provider.getRiskFacts(BONK);

    expect(point.value.onChainVerification?.status).toBe("unavailable");
    expect(point.value.onChainVerification?.detail).toMatch(/rate limit/i);
    expect(point.value.dataComplete).toBe(false);
  });

  it("survives a server error", async () => {
    const h = harness(() => new Response("{}", { status: 500 }));
    const point = await h.provider.getRiskFacts(BONK);
    expect(point.value.onChainVerification?.status).toBe("unavailable");
  });

  it("survives a malformed account payload", async () => {
    // Right owner, wrong length: a token account, not a mint.
    const body = {
      jsonrpc: "2.0",
      result: {
        value: {
          data: [Buffer.alloc(165).toString("base64"), "base64"],
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          lamports: 2_039_280,
          executable: false,
        },
      },
    };
    const h = harness(() => new Response(JSON.stringify(body), { status: 200 }));
    const point = await h.provider.getRiskFacts(BONK);

    expect(point.value.onChainVerification?.status).toBe("malformed");
    expect(point.value.onChainVerification?.detail).toMatch(/token account/i);
  });
});

describe("live overlay — caching behaviour", () => {
  it("hits the RPC once across repeated reads", async () => {
    const h = harness(ok("bonk-mint"));
    await h.provider.getRiskFacts(BONK);
    await h.provider.getRiskFacts(BONK);
    await h.provider.getRiskFacts(BONK);
    expect(h.calls).toBe(1);
  });

  it("collapses concurrent reads of the same mint into one request", async () => {
    const h = harness(ok("bonk-mint"));
    await Promise.all(Array.from({ length: 5 }, () => h.provider.getRiskFacts(BONK)));
    expect(h.calls).toBe(1);
  });

  it("refetches after the cache TTL expires", async () => {
    const clockRef = { now: START };
    let calls = 0;
    const client = new SolanaRpcClient({
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify(fixtureBody("bonk-mint")), { status: 200 });
      },
    });
    const loader = new CachedLoader<MintReadResult>({ ttlMs: 60_000, clock: () => clockRef.now });
    const provider = new OnChainMintRiskProvider(
      new StubRiskProvider(),
      client,
      loader,
      async () => 5,
      () => clockRef.now,
    );

    await provider.getRiskFacts(BONK);
    clockRef.now += 61_000;
    await provider.getRiskFacts(BONK);
    expect(calls).toBe(2);
  });
});

describe("mode selection", () => {
  it("demo mode is untouched: no overlay, no per-field labels", async () => {
    const demo = createDemoBundle(() => START);
    const point = await demo.riskFacts.getRiskFacts(BONK);

    expect(point.fieldSources).toBeUndefined();
    expect(point.value.onChainVerification).toBeUndefined();
    expect(demo.isDemo).toBe(true);
  });

  it("live bundle swaps only the risk provider and stays labelled as simulated", () => {
    const demo = createDemoBundle(() => START);
    const live = createLiveBundle(() => START);

    expect(live.riskFacts).not.toBe(demo.riskFacts);
    // Everything else still comes from the simulator.
    expect(live.routing).toBe(live.routing);
    expect(live.dataSourceLabel).toMatch(/Live on-chain/);
    expect(live.dataSourceLabel).toMatch(/simulated/);
    // Most values are still simulated, so the disclaimers must not soften.
    expect(live.isDemo).toBe(true);
  });
});
