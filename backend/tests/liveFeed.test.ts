import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { JupiterLiveFeedProvider } from "../src/market/jupiter/liveFeed.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const NOW = Date.parse("2026-08-17T20:18:00Z");

const token = {
  id: MINT,
  name: "Bonk",
  symbol: "BONK",
  decimals: 5,
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  usdPrice: 0.00001234,
  liquidity: 325_000,
  holderCount: 900_000,
  organicScore: 72,
  createdAt: "2026-08-17T20:10:00Z",
  updatedAt: "2026-08-17T20:17:58Z",
  launchpad: "pump.fun",
  audit: {
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    topHoldersPercentage: 18.5,
  },
  stats5m: {
    priceChange: 3.25,
    buyVolume: 42_000,
    sellVolume: 28_000,
    numBuys: 420,
    numSells: 280,
    numTraders: 350,
  },
  stats1h: { priceChange: 8.5, buyVolume: 210_000, sellVolume: 180_000 },
  stats24h: { priceChange: -2.1, buyVolume: 1_200_000, sellVolume: 1_100_000 },
};

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

describe("Jupiter live token feed", () => {
  it("normalizes recent tokens, activity windows, and timestamps", async () => {
    let requested = "";
    const provider = new JupiterLiveFeedProvider({
      clock: () => NOW,
      fetchImpl: async (input) => {
        requested = String(input);
        return Response.json([token]);
      },
    });

    const result = await provider.getFeed("recent");
    expect(requested).toContain("/recent");
    expect(result.source).toBe("jupiter:tokens-v2");
    expect(result.tokens[0]?.token.mint).toBe(MINT);
    expect(result.tokens[0]?.firstPoolAtMs).toBe(Date.parse(token.createdAt));
    expect(result.tokens[0]?.updatedAtMs).toBe(Date.parse(token.updatedAt));
    expect(result.tokens[0]?.fiveMinutes.priceChangeBps).toBe(325n);
    expect(result.tokens[0]?.fiveMinutes.buyVolumeUsdMicro).toBe(42_000_000_000n);
  });

  it("uses the top-traded endpoint and drops a malformed row", async () => {
    const provider = new JupiterLiveFeedProvider({
      clock: () => NOW,
      fetchImpl: async (input) => {
        expect(String(input)).toContain("/toptraded/5m");
        return Response.json([{ symbol: "BROKEN" }, token]);
      },
    });

    const result = await provider.getFeed("trending");
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]?.token.symbol).toBe("BONK");
  });

  it("serves a truthful live API payload with risk gates and no execution claim", async () => {
    const clock = () => NOW;
    const deps = createTestDeps(clock);
    deps.liveFeed = new JupiterLiveFeedProvider({
      clock,
      fetchImpl: async () => Response.json([token]),
    });
    const server = createApp(deps).listen(0);
    servers.push(server);
    const address = server.address();
    const base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";

    const response = await fetch(`${base}/v1/feed?kind=recent&minLiquidityUsd=10000`);
    const body = (await response.json()) as {
      live: boolean;
      executionEnabled: boolean;
      tokens: Array<{
        mint: string;
        liquidityUsd: string;
        fiveMinuteVolumeUsd: string;
        assessment: { status: string; riskLevel: string; eligibility: string };
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.live).toBe(true);
    expect(body.executionEnabled).toBe(false);
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.mint).toBe(MINT);
    expect(body.tokens[0]?.liquidityUsd).toBe("325000.00");
    expect(body.tokens[0]?.fiveMinuteVolumeUsd).toBe("70000.00");
    expect(body.tokens[0]?.assessment.status).toBe("active");
    expect(body.tokens[0]?.assessment.eligibility).toMatch(/Request a live quote/);
  });
});
