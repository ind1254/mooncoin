import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import type { SqlClient } from "../src/db/client.js";
import { TokenHistoryRepository } from "../src/db/tokenHistory.js";
import { RISK_MODEL_VERSION } from "../src/risk/engineV3.js";

/**
 * The routes that expose the evidence pipeline. These are the surfaces that
 * turn four tested libraries into features a client can actually use.
 */

let db: SqlClient;
let server: Server;
let base: string;

const NOW = Date.now();

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  const deps = createTestDeps(() => NOW);
  deps.db = db;
  // The demo deps cannot resolve an arbitrary mint offline, and these tests are
  // about the evidence routes rather than about research itself, so the profile
  // is stubbed with a fixed, fully-evidenced token.
  deps.research = {
    ...deps.research,
    getProfile: async () => stubProfile(),
  } as unknown as typeof deps.research;
  server = createApp(deps).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.close();
  await db.close();
});

/** A mint the demo research provider can resolve (see market/demoData.ts). */
const DEMO_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const anyMint = async (): Promise<string> => DEMO_MINT;

function stubProfile() {
  return {
    mint: DEMO_MINT,
    symbol: "BONK",
    name: "Bonk",
    decimals: 5,
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    iconUrl: null,
    tags: [],
    verifiedByProvider: true,
    identitySource: "jupiter:tokens-v2",
    marketSource: "jupiter:tokens-v2",
    marketUpdatedAtMs: NOW - 2_000,
    market: {
      priceUsdPico: 1_000_000n,
      liquidityUsdMicro: 500_000n * 1_000_000n,
      marketCapUsdMicro: 10_000_000n * 1_000_000n,
      fdvUsdMicro: null,
      holderCount: 90_000,
      change1hBps: 100n,
      change24hBps: 200n,
      buyVolume24hUsdMicro: 1_000n,
      sellVolume24hUsdMicro: 1_000n,
      numBuys24h: 10,
      numSells24h: 10,
      topHolderPctBps: 1_200n,
      organicScore: 90,
      organicScoreLabel: "high",
    },
    verification: {
      status: "verified",
      source: "solana:mainnet",
      checkedAtMs: NOW - 1_000,
      decimalsOnChain: 5,
      holders: {
        status: "verified",
        concentrationBps: 1_200n,
        programHeldBps: 4_000n,
        walletHolderCount: 10,
        unclassifiedBps: 0n,
        detail: "Classified all top accounts",
      },
    },
    authorities: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      source: "solana:mainnet",
      providerAgreement: "agrees",
    },
    risk: { score: 10, level: "low", factors: [] },
    simulation: { available: true, reason: "" },
    fetchedAtMs: NOW,
  } as never;
}

const record = (repo: TokenHistoryRepository, mint: string, atMs: number, riskScore: number) =>
  repo.record({
    tokenMint: mint,
    observedAtMs: atMs,
    resolution: "high",
    riskScore,
    riskConfidence: 80,
    riskModelVersion: RISK_MODEL_VERSION,
    pricePicoUsd: 1_000_000n,
    liquidityUsdMicro: 500_000n * 1_000_000n,
    marketCapUsdMicro: 10_000_000n * 1_000_000n,
    volume24hUsdMicro: 1_000_000n,
    walletConcentrationBps: 1_200n,
    programHeldBps: null,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
  });

describe("GET /v1/research/:mint", () => {
  it("returns versioned risk alongside the existing shape, not instead of it", async () => {
    // Replacing the old field silently would change what every existing
    // consumer sees without anyone deciding to.
    const mint = await anyMint();
    const body = await (await fetch(`${base}/v1/research/${mint}`)).json() as Record<string, any>;

    expect(body.risk).toBeDefined(); // the original model, untouched
    expect(body.riskV3.riskModelVersion).toBe(RISK_MODEL_VERSION);
    expect(typeof body.riskV3.riskScore).toBe("number");
    expect(typeof body.riskV3.riskConfidence).toBe("number");
    expect(Array.isArray(body.riskV3.factors)).toBe(true);
  });

  it("publishes each factor with its own provenance", async () => {
    const mint = await anyMint();
    const body = await (await fetch(`${base}/v1/research/${mint}`)).json() as Record<string, any>;
    const factor = body.riskV3.factors[0];

    expect(factor).toMatchObject({
      id: expect.any(String),
      fact: expect.any(String),
      interpretation: expect.any(String),
      points: expect.any(Number),
      status: expect.any(String),
      source: expect.any(String),
    });
    // Fact and interpretation stay separate.
    expect(factor.fact).not.toBe(factor.interpretation);
  });

  it("says what it did not know rather than scoring silently around the gap", async () => {
    const mint = await anyMint();
    const body = await (await fetch(`${base}/v1/research/${mint}`)).json() as Record<string, any>;
    expect(Array.isArray(body.evidence.unavailable)).toBe(true);
    expect(body.evidence.unavailableCount).toBe(body.evidence.unavailable.length);
    expect(Array.isArray(body.evidence.sources)).toBe(true);
  });
});

describe("GET /v1/tokens/:mint/history", () => {
  it("returns a recorded series newest-first", async () => {
    const repo = new TokenHistoryRepository(db);
    await record(repo, "MINT_A", NOW - 7_200_000, 20);
    await record(repo, "MINT_A", NOW - 3_600_000, 45);

    const body = await (await fetch(`${base}/v1/tokens/MINT_A/history`)).json() as Record<string, any>;
    expect(body.available).toBe(true);
    expect(body.count).toBe(2);
    expect(body.points[0].riskScore).toBe(45);
    expect(body.points[0].riskModelVersion).toBe(RISK_MODEL_VERSION);
    // The downsampling is disclosed, so a sparse old series is not mistaken
    // for missing data.
    expect(String(body.notice)).toMatch(/downsampled/i);
  });

  it("formats money through the fixed-point helpers, never a float", async () => {
    const repo = new TokenHistoryRepository(db);
    await record(repo, "MINT_B", NOW, 30);
    const body = await (await fetch(`${base}/v1/tokens/MINT_B/history`)).json() as Record<string, any>;
    expect(typeof body.points[0].liquidityUsd).toBe("string");
    expect(body.points[0].walletConcentrationPct).toBe("12.00");
  });

  it("returns an empty series for a token with no observations", async () => {
    const body = await (await fetch(`${base}/v1/tokens/UNSEEN/history`)).json() as Record<string, any>;
    expect(body.available).toBe(true);
    expect(body.points).toEqual([]);
  });
});

describe("GET /v1/tokens/:mint/risk-change", () => {
  it("explains the move against a recorded past observation", async () => {
    const mint = await anyMint();
    const repo = new TokenHistoryRepository(db);
    await record(repo, mint, NOW - 3_600_000, 5);

    const body = await (await fetch(`${base}/v1/tokens/${mint}/risk-change`)).json() as Record<string, any>;
    expect(body.available).toBe(true);
    expect(body.change.comparable).toBe(true);
    expect(body.change.previousScore).toBe(5);
    expect(typeof body.change.delta).toBe("number");
    expect(body.summary).toMatch(/^Risk \d+ -> \d+/);
  });

  it("says so plainly when there is nothing to compare against", async () => {
    const mint = await anyMint();
    const body = await (await fetch(`${base}/v1/tokens/${mint}/risk-change`)).json() as Record<string, any>;
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/no recorded observation/i);
  });

  it("refuses to compare across risk model versions", async () => {
    const mint = await anyMint();
    await new TokenHistoryRepository(db).record({
      tokenMint: mint,
      observedAtMs: NOW - 3_600_000,
      resolution: "high",
      riskScore: 12,
      riskConfidence: 70,
      riskModelVersion: "risk-v1.0.0",
      pricePicoUsd: null,
      liquidityUsdMicro: null,
      marketCapUsdMicro: null,
      volume24hUsdMicro: null,
      walletConcentrationBps: null,
      programHeldBps: null,
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
    });

    const body = await (await fetch(`${base}/v1/tokens/${mint}/risk-change`)).json() as Record<string, any>;
    expect(body.change.comparable).toBe(false);
    expect(body.change.incomparableReason).toMatch(/not on the same scale/i);
  });
});
