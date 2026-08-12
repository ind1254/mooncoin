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
