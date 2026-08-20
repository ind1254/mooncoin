import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { JupiterTokenSearchProvider } from "../src/market/jupiter/tokenSearch.js";
import { ResearchService } from "../src/market/research.js";
import { SolanaRpcClient } from "../src/market/solana/rpc.js";

/**
 * End-to-end research flow: discovery provider + on-chain verification + risk,
 * served through the API. Fully offline — both external transports are canned
 * with recorded fixtures.
 */

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const START = 1_760_000_000_000;

const jupFixture = (name: string): unknown =>
  (JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/jupiter/${name}.json`, import.meta.url)), "utf8")) as {
    response: unknown;
  }).response;

const solFixture = (name: string): unknown =>
  (JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/solana/${name}.json`, import.meta.url)), "utf8")) as {
    response: unknown;
  }).response;

interface Harness {
  research: ResearchService;
}

function buildResearch(opts: {
  jupiter?: () => Response;
  solana?: () => Response;
  simulationAvailable?: boolean;
} = {}): Harness {
  const discovery = new JupiterTokenSearchProvider({
    clock: () => START,
    fetchImpl: async () => (opts.jupiter ?? (() => new Response(JSON.stringify(jupFixture("search-bonk")), { status: 200 })))(),
  });
  const rpc = new SolanaRpcClient({
    fetchImpl: async () => (opts.solana ?? (() => new Response(JSON.stringify(solFixture("bonk-mint")), { status: 200 })))(),
  });
  return {
    research: new ResearchService(discovery, rpc, {
      clock: () => START,
      simulationAvailable: async () => opts.simulationAvailable ?? false,
    }),
  };
}

describe("research service", () => {
  it("joins discovery identity with chain-verified authorities", async () => {
    const { research } = buildResearch();
    const p = await research.getProfile(BONK);

    expect(p.mint).toBe(BONK);
    expect(p.symbol).toBe("Bonk");
    expect(p.verification.status).toBe("verified");
    // BONK's mint account has both COption tags at zero.
    expect(p.authorities.mintAuthorityRevoked).toBe(true);
    expect(p.authorities.freezeAuthorityRevoked).toBe(true);
    expect(p.authorities.source).toBe("solana-rpc:mainnet");
    // Jupiter claimed the same thing, so the two agree.
    expect(p.authorities.providerAgreement).toBe("agrees");
  });

  it("prefers on-chain decimals over the token list", async () => {
    const { research } = buildResearch();
    const p = await research.getProfile(BONK);
    expect(p.decimals).toBe(5);
    expect(p.verification.decimalsOnChain).toBe(5);
    expect(p.verification.decimalsMismatch).toBe(false);
  });

  it("keeps market facts and never invents a missing one", async () => {
    const { research } = buildResearch();
    const p = await research.getProfile(BONK);
    expect(p.market.priceUsdPico).not.toBeNull();
    expect(p.market.liquidityUsdMicro).not.toBeNull();
    expect(p.marketSource).toBe("jupiter:tokens-v2");
  });

  it("degrades to unverified authorities when the chain cannot be read", async () => {
    const { research } = buildResearch({ solana: () => new Response("{}", { status: 429 }) });
    const p = await research.getProfile(BONK);

    expect(p.verification.status).toBe("unavailable");
    expect(p.verification.detail).toMatch(/rate limit/i);
    // Nothing is asserted about authorities we could not read.
    expect(p.authorities.mintAuthorityRevoked).toBeNull();
    expect(p.authorities.freezeAuthorityRevoked).toBeNull();
    // Unknown counts as risk rather than being assumed safe.
    expect(p.risk.factors.some((f) => f.id === "authorities-unverified")).toBe(true);
  });

  it("404s a mint the discovery provider does not know", async () => {
    const { research } = buildResearch({ jupiter: () => new Response("[]", { status: 200 }) });
    await expect(research.getProfile("FLooFDemo1111111111111111111111111111111111")).rejects.toMatchObject({
      code: "TOKEN_NOT_ALLOWED",
    });
  });

  it("gates paper trading on quote availability and explains why", async () => {
    const off = await buildResearch().research.getProfile(BONK);
    expect(off.simulation.available).toBe(false);
    expect(off.simulation.reason).toMatch(/quote/i);

    const on = await buildResearch({ simulationAvailable: true }).research.getProfile(BONK);
    expect(on.simulation.available).toBe(true);
  });
});

describe("research risk model", () => {
  it("states a fact and an interpretation separately for every factor", async () => {
    const p = await buildResearch().research.getProfile(BONK);
    expect(p.risk.factors.length).toBeGreaterThan(4);
    for (const f of p.risk.factors) {
      expect(f.fact.length).toBeGreaterThan(10);
      expect(f.interpretation.length).toBeGreaterThan(10);
      expect(["verified", "reported", "unavailable"]).toContain(f.status);
      expect(f.source.length).toBeGreaterThan(0);
    }
  });

  it("marks authority factors verified and market factors reported", async () => {
    const p = await buildResearch().research.getProfile(BONK);
    const authority = p.risk.factors.find((f) => f.id.startsWith("mint-authority"))!;
    const liquidity = p.risk.factors.find((f) => f.id.startsWith("liquidity"))!;
    expect(authority.status).toBe("verified");
    expect(authority.source).toBe("solana-rpc:mainnet");
    expect(liquidity.status).toBe("reported");
    expect(liquidity.source).toBe("jupiter:tokens-v2");
  });

  it("reports token age as unavailable rather than using the index date", async () => {
    const p = await buildResearch().research.getProfile(BONK);
    const age = p.risk.factors.find((f) => f.id === "token-age-unavailable")!;
    expect(age.status).toBe("unavailable");
    expect(age.points).toBe(0);
  });

  it("scores a thin, unlisted token higher than a deep, listed one", async () => {
    const healthy = await buildResearch().research.getProfile(BONK);

    const thin = [
      {
        id: BONK,
        name: "Thin Token",
        symbol: "THIN",
        decimals: 5,
        isVerified: false,
        liquidity: 4_000,
        audit: { topHoldersPercentage: 61 },
      },
    ];
    const risky = await buildResearch({
      jupiter: () => new Response(JSON.stringify(thin), { status: 200 }),
    }).research.getProfile(BONK);

    expect(risky.risk.score).toBeGreaterThan(healthy.risk.score);
    expect(risky.risk.level).not.toBe("low");
    // The score is the sum of the visible per-factor points.
    const total = risky.risk.factors.reduce((s, f) => s + f.points, 0);
    expect(risky.risk.score).toBe(Math.min(100, total));
  });

  it("penalizes an unreadable chain more than a clean verified read", async () => {
    const clean = await buildResearch().research.getProfile(BONK);
    const blind = await buildResearch({ solana: () => new Response("{}", { status: 500 }) }).research.getProfile(BONK);
    expect(blind.risk.score).toBeGreaterThan(clean.risk.score);
  });
});

describe("research API", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const deps = createTestDeps(() => START);
    deps.research = buildResearch().research;
    const app = createApp(deps);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => server?.close());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const get = async (p: string): Promise<{ status: number; body: any }> => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  };

  it("serves search results with duplicate-symbol detection", async () => {
    const { status, body } = await get("/v1/search?q=bonk");
    expect(status).toBe(200);
    expect(body.count).toBeGreaterThan(1);
    expect(body.duplicateSymbols).toBe(true);
    expect(body.source).toBe("jupiter:tokens-v2");

    const first = body.results[0];
    // Enough identity to pick the right asset, with the mint as the key.
    expect(first.mint).toBeTruthy();
    expect(first).toHaveProperty("symbol");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("liquidityUsd");
    expect(first).toHaveProperty("verifiedByProvider");
  });

  it("rejects an empty query", async () => {
    const { status, body } = await get("/v1/search?q=");
    expect(status).toBe(400);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("serves a research profile with provenance on every section", async () => {
    const { status, body } = await get(`/v1/research/${BONK}`);
    expect(status).toBe(200);
    expect(body.mint).toBe(BONK);
    expect(body.identitySource).toBe("jupiter:tokens-v2");
    expect(body.market.source).toBe("jupiter:tokens-v2");
    expect(body.authorities.source).toBe("solana-rpc:mainnet");
    expect(body.verification.status).toBe("verified");
    expect(body.risk.factors.length).toBeGreaterThan(0);
    expect(body.executionEnabled).toBe(false);
    // Prices serialize as strings so no float sneaks into the wire format.
    expect(typeof body.market.priceUsd).toBe("string");
  });

  it("404s an unknown mint", async () => {
    const deps = createTestDeps(() => START);
    deps.research = buildResearch({ jupiter: () => new Response("[]", { status: 200 }) }).research;
    const app = createApp(deps);
    const s = app.listen(0);
    const addr = s.address();
    const url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

    const res = await fetch(`${url}/v1/research/${USDC}`);
    expect(res.status).toBe(404);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// On-chain holder concentration, through the HTTP boundary
// ---------------------------------------------------------------------------

/**
 * These go over real HTTP rather than calling the service directly, and that
 * is the entire point of them.
 *
 * The holder figures are bigint basis points, and JSON.stringify throws on a
 * BigInt. A service-level test would pass happily while every research request
 * in production returned 500 — which is exactly the failure mode this repo has
 * already shipped once (see the note in api/index.js). Only a test that
 * actually serializes a response can catch it.
 */

/** RPC transport that answers each method with its own canned body. */
function holderRpc(overrides: { largestStatus?: number } = {}): SolanaRpcClient {
  // Two token accounts: one owned by a program (a pool), one by a wallet.
  const POOL_TA = "So11111111111111111111111111111111111111112";
  const WALLET_TA = "SysvarC1ock11111111111111111111111111111111";
  const POOL_OWNER = "SysvarRent111111111111111111111111111111111";
  const WALLET_OWNER = "SysvarRecentB1ockHashes11111111111111111111";
  const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const SYSTEM = "11111111111111111111111111111111";

  const b58 = (address: string): Uint8Array => {
    // Only the round trip matters here: the decoder re-encodes whatever bytes
    // we write, so any injective mapping gives a stable, distinct pubkey.
    const bytes = new Uint8Array(32);
    for (let i = 0; i < address.length && i < 32; i += 1) bytes[i] = address.charCodeAt(i) & 0xff;
    return bytes;
  };

  const tokenAccount = (ownerAddress: string, amount: bigint): string => {
    const data = new Uint8Array(165);
    data.set(b58(BONK), 0);
    data.set(b58(ownerAddress), 32);
    new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(64, amount, true);
    data[108] = 1;
    return Buffer.from(data).toString("base64");
  };

  const account = (dataB64: string, programOwner: string) => ({
    data: [dataB64, "base64"],
    owner: programOwner,
    lamports: 2_039_280,
    executable: false,
  });

  // The mint fixture BONK reports; its supply is what concentration divides by.
  const bonkSupply = 0n;

  return new SolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };

      if (body.method === "getAccountInfo") {
        return new Response(JSON.stringify(solFixture("bonk-mint")), { status: 200 });
      }

      if (body.method === "getTokenLargestAccounts") {
        if (overrides.largestStatus) return new Response("{}", { status: overrides.largestStatus });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 1 },
              value: [
                { address: POOL_TA, amount: "600" },
                { address: WALLET_TA, amount: "300" },
              ],
            },
          }),
          { status: 200 },
        );
      }

      const addresses = body.params[0] as string[];
      const table: Record<string, unknown> = {
        [POOL_TA]: account(tokenAccount(POOL_OWNER, 600n), SPL_TOKEN),
        [WALLET_TA]: account(tokenAccount(WALLET_OWNER, 300n), SPL_TOKEN),
        [POOL_OWNER]: account("", SPL_TOKEN), // program-owned => a pool
        [WALLET_OWNER]: account("", SYSTEM), // System Program => a wallet
      };
      void bonkSupply;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { context: { slot: 1 }, value: addresses.map((a) => table[a] ?? null) },
        }),
        { status: 200 },
      );
    },
  });
}

async function researchOver(rpc: SolanaRpcClient): Promise<{ status: number; body: any }> {
  const deps = createTestDeps(() => START);
  const discovery = new JupiterTokenSearchProvider({
    clock: () => START,
    fetchImpl: async () => new Response(JSON.stringify(jupFixture("search-bonk")), { status: 200 }),
  });
  deps.research = new ResearchService(discovery, rpc, { clock: () => START });

  const app = createApp(deps);
  const s = app.listen(0);
  try {
    const addr = s.address();
    const url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
    const res = await fetch(`${url}/v1/research/${BONK}`);
    return { status: res.status, body: await res.json() };
  } finally {
    s.close();
  }
}

describe("research API — holder concentration serialization", () => {
  it("returns 200 with numeric basis points rather than failing on a BigInt", async () => {
    const { status, body } = await researchOver(holderRpc());

    expect(status).toBe(200);
    const holders = body.verification.holders;
    expect(holders).not.toBeNull();
    expect(holders.status).not.toBe("unavailable");
    // Numbers, not bigints and not strings — the UI does arithmetic on these.
    expect(typeof holders.concentrationBps).toBe("number");
    expect(typeof holders.programHeldBps).toBe("number");
    expect(typeof holders.unclassifiedBps).toBe("number");
  });

  it("survives a whole-response JSON round trip", async () => {
    const { status, body } = await researchOver(holderRpc());
    // The status assertion is load-bearing: a 500 body contains no bigints, so
    // without it this test would pass on exactly the failure it exists to catch.
    expect(status).toBe(200);
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  it("keeps authorities verified when holder classification is rate limited", async () => {
    const { status, body } = await researchOver(holderRpc({ largestStatus: 429 }));

    expect(status).toBe(200);
    expect(body.verification.status).toBe("verified");
    expect(body.authorities.mintAuthorityRevoked).toBe(true);
    expect(body.verification.holders.status).toBe("unavailable");
    expect(body.verification.holders.concentrationBps).toBeNull();
  });

  it("reports null holders when the feature never ran", async () => {
    // The default harness answers every method with the mint fixture, so the
    // largest-accounts call fails its schema and holders stay absent.
    const { status, body } = await researchOver(
      new SolanaRpcClient({
        fetchImpl: async () => new Response(JSON.stringify(solFixture("bonk-mint")), { status: 200 }),
      }),
    );

    expect(status).toBe(200);
    expect(body.verification.holders.status).toBe("unavailable");
  });
});
