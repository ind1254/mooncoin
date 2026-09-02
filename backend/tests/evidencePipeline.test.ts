import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import type { SqlClient } from "../src/db/client.js";
import { TokenHistoryRepository } from "../src/db/tokenHistory.js";
import { runHistoryPass } from "../src/market/historyPass.js";
import { RISK_MODEL_VERSION } from "../src/risk/engineV3.js";
import { metrics } from "../src/observability/metrics.js";
import type { LiveFeedToken, LiveFeedWindow } from "../src/market/jupiter/liveFeed.js";
import type { TradabilityPolicy } from "../src/market/tradability.js";

/**
 * The evidence pipeline, end to end.
 *
 * The modules for snapshots, risk, history and diffing were each well tested
 * in isolation and none of them were connected to a running path, so the risk
 * engine stamped a version nothing stored and the history table stayed empty
 * in production. This suite exists to make that failure mode visible: it
 * asserts the pass actually writes rows, not merely that it could.
 */

const NOW = 1_800_000_000_000;
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OTHER = "So11111111111111111111111111111111111111112";

const POLICY: TradabilityPolicy = {
  minLiquidityUsdMicro: 10_000n * 1_000_000n,
  maxPriceImpactBps: 300n,
  maxMarketAgeMs: 300_000,
};

const window = (): LiveFeedWindow => ({
  priceChangeBps: 500n,
  liquidityChangeBps: 100n,
  volumeChangeBps: 1_000n,
  buyVolumeUsdMicro: 300_000n * 1_000_000n,
  sellVolumeUsdMicro: 200_000n * 1_000_000n,
  buys: 100,
  sells: 50,
  traders: 120,
});

function feedToken(over: { mint?: string; symbol?: string; risky?: boolean } = {}): LiveFeedToken {
  const risky = over.risky ?? false;
  return {
    token: {
      mint: over.mint ?? MINT,
      symbol: over.symbol ?? "BONK",
      name: "Test token",
      decimals: 5,
      firstPoolAtMs: NOW - 40 * 86_400_000,
      marketUpdatedAtMs: NOW - 2_000,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      iconUrl: null,
      verifiedByProvider: true,
      tags: [],
      source: "jupiter:tokens-v2",
      market: {
        priceUsdPico: 1_000_000n,
        liquidityUsdMicro: risky ? 100n * 1_000_000n : 500_000n * 1_000_000n,
        marketCapUsdMicro: 10_000_000n * 1_000_000n,
        fdvUsdMicro: 11_000_000n * 1_000_000n,
        holderCount: 90_000,
        change1hBps: 300n,
        change24hBps: 900n,
        buyVolume24hUsdMicro: 4_000_000n * 1_000_000n,
        sellVolume24hUsdMicro: 3_000_000n * 1_000_000n,
        numBuys24h: 900,
        numSells24h: 700,
        topHolderPctBps: risky ? 7_000n : 1_200n,
        organicScore: 90,
        organicScoreLabel: "high",
      },
      providerClaims: {
        mintAuthorityDisabled: !risky,
        freezeAuthorityDisabled: !risky,
      },
    },
    firstPoolAtMs: NOW - 40 * 86_400_000,
    updatedAtMs: NOW - 2_000,
    launchpad: null,
    fiveMinutes: window(),
    oneHour: window(),
    twentyFourHours: window(),
  } as unknown as LiveFeedToken;
}

let db: SqlClient;
let history: TokenHistoryRepository;

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  history = new TokenHistoryRepository(db);
});

const deps = (tokens: LiveFeedToken[], clock = () => NOW) => ({
  getFeed: async () => ({ tokens }),
  history,
  policy: POLICY,
  clock,
  kinds: ["trending" as const],
});

describe("history pass", () => {
  it("actually writes rows — the table is not left empty", async () => {
    const summary = await runHistoryPass(deps([feedToken()]));
    expect(summary.recorded).toBe(1);
    expect(await history.count()).toBe(1);
  });

  it("stores the risk score together with the model that produced it", async () => {
    // Without the version a stored score could later be compared against a
    // number a different model produced.
    await runHistoryPass(deps([feedToken()]));
    const [row] = await history.list(MINT);
    expect(row?.riskScore).toBeGreaterThanOrEqual(0);
    expect(row?.riskConfidence).toBeGreaterThan(0);
    expect(row?.riskModelVersion).toBe(RISK_MODEL_VERSION);
  });

  it("scores a risky token higher than a clean one through the whole pipeline", async () => {
    await runHistoryPass(deps([feedToken({ mint: MINT }), feedToken({ mint: OTHER, symbol: "RUG", risky: true })]));
    const clean = (await history.list(MINT))[0]!;
    const risky = (await history.list(OTHER))[0]!;
    expect(risky.riskScore!).toBeGreaterThan(clean.riskScore!);
  });

  it("records an unmeasurable field as null rather than zero", async () => {
    // The feed cannot separate pool-held supply, so that column must stay null
    // — a zero would read as "no pools" on the next diff.
    await runHistoryPass(deps([feedToken()]));
    const [row] = await history.list(MINT);
    expect(row?.programHeldBps).toBeNull();
    expect(row?.liquidityUsdMicro).not.toBeNull();
  });

  it("is idempotent within a pass and across a retried pass", async () => {
    const token = feedToken();
    await runHistoryPass(deps([token, token]));
    expect(await history.count()).toBe(1);

    await runHistoryPass(deps([token]));
    expect(await history.count()).toBe(1);
  });

  it("enforces retention in the same pass that creates the rows", async () => {
    // Retention belongs to the thing writing the data, not a separate job
    // someone has to remember to schedule.
    await history.record({
      tokenMint: MINT,
      observedAtMs: NOW - 120 * 86_400_000,
      resolution: "low",
      riskScore: 10,
      riskConfidence: 50,
      riskModelVersion: RISK_MODEL_VERSION,
      pricePicoUsd: null,
      liquidityUsdMicro: null,
      marketCapUsdMicro: null,
      volume24hUsdMicro: null,
      walletConcentrationBps: null,
      programHeldBps: null,
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
    });
    expect(await history.count()).toBe(1);

    const summary = await runHistoryPass(deps([feedToken()]));
    expect(summary.deleted).toBe(1);
    expect(await history.count()).toBe(1);
  });

  it("caps how many tokens one pass will record", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      feedToken({ mint: `${MINT.slice(0, 40)}${String(i).padStart(4, "0")}` }),
    );
    const summary = await runHistoryPass({ ...deps(many), maxTokens: 5 });
    expect(summary.recorded).toBeLessThanOrEqual(5);
  });

  it("builds a series that answers what risk was earlier", async () => {
    await runHistoryPass(deps([feedToken()], () => NOW - 3_600_000));
    await runHistoryPass(deps([feedToken({ risky: true })], () => NOW));

    const anHourAgo = await history.asOf(MINT, NOW - 3_600_000);
    const nowRow = await history.asOf(MINT, NOW);
    expect(anHourAgo).not.toBeNull();
    expect(nowRow!.riskScore!).toBeGreaterThan(anHourAgo!.riskScore!);
  });

  it("records a metric for the pass", async () => {
    metrics.reset();
    await runHistoryPass(deps([feedToken()]));
    const entry = metrics.snapshot().providers.find((p) => p.provider === "moonpaper:history-pass");
    expect(entry?.calls).toBe(1);
  });
});
