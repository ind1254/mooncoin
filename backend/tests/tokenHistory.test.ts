import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import type { SqlClient } from "../src/db/client.js";
import {
  HISTORY_HIGH_RESOLUTION_MS,
  HISTORY_MEDIUM_RESOLUTION_MS,
  HISTORY_RETENTION_MS,
  TokenHistoryRepository,
  type TokenHistoryPoint,
} from "../src/db/tokenHistory.js";

/**
 * The retention policy is the feature: history that grows without bound would
 * quietly become the largest table in the database. These tests pin that it
 * downsamples rather than appends, and that reading the past never invents it.
 */

const NOW = 1_800_000_000_000;
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OTHER = "So11111111111111111111111111111111111111112";

let db: SqlClient;
let repo: TokenHistoryRepository;

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  repo = new TokenHistoryRepository(db);
});

const point = (over: Partial<TokenHistoryPoint> = {}): TokenHistoryPoint => ({
  tokenMint: MINT,
  observedAtMs: NOW,
  resolution: "high",
  riskScore: 30,
  riskConfidence: 90,
  riskModelVersion: "risk-v3.0.0",
  pricePicoUsd: 1_000_000n,
  liquidityUsdMicro: 500_000n * 1_000_000n,
  marketCapUsdMicro: 10_000_000n * 1_000_000n,
  volume24hUsdMicro: 1_000_000n,
  walletConcentrationBps: 1_200n,
  programHeldBps: 4_000n,
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  ...over,
});

describe("token history", () => {
  it("round-trips bigints without going through a float", () => {
    // The whole point of storing these as bigint columns.
    return (async () => {
      const huge = 9_007_199_254_740_993n; // beyond Number.MAX_SAFE_INTEGER
      await repo.record(point({ liquidityUsdMicro: huge }));
      const [row] = await repo.list(MINT);
      expect(row?.liquidityUsdMicro).toBe(huge);
    })();
  });

  it("keeps the risk model version alongside the score", async () => {
    await repo.record(point());
    const [row] = await repo.list(MINT);
    expect(row?.riskScore).toBe(30);
    expect(row?.riskModelVersion).toBe("risk-v3.0.0");
  });

  it("records a provider outage as unknown, never as zero", async () => {
    // A zero would read as a total collapse on the next diff.
    await repo.record(point({ liquidityUsdMicro: null, riskScore: null }));
    const [row] = await repo.list(MINT);
    expect(row?.liquidityUsdMicro).toBeNull();
    expect(row?.riskScore).toBeNull();
  });

  it("is idempotent for the same instant, so a retried pass cannot duplicate", async () => {
    await repo.record(point({ riskScore: 30 }));
    await repo.record(point({ riskScore: 55 }));
    const rows = await repo.list(MINT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.riskScore).toBe(55);
  });

  it("answers what the state was at a past instant", async () => {
    await repo.record(point({ observedAtMs: NOW - 7_200_000, riskScore: 20 }));
    await repo.record(point({ observedAtMs: NOW - 3_600_000, riskScore: 45 }));
    await repo.record(point({ observedAtMs: NOW, riskScore: 70 }));

    const anHourAgo = await repo.asOf(MINT, NOW - 3_600_000);
    expect(anHourAgo?.riskScore).toBe(45);

    // Between observations, the state in force is the earlier one.
    const between = await repo.asOf(MINT, NOW - 1_800_000);
    expect(between?.riskScore).toBe(45);
  });

  it("never reports a state the token had not yet reached", async () => {
    // Returning the nearest LATER row would be a fabrication dressed as history.
    await repo.record(point({ observedAtMs: NOW, riskScore: 70 }));
    expect(await repo.asOf(MINT, NOW - 86_400_000)).toBeNull();
  });

  it("returns a window oldest-first for reviewing a held position", async () => {
    for (let i = 0; i < 5; i += 1) {
      await repo.record(point({ observedAtMs: NOW - i * 60_000, riskScore: 10 + i }));
    }
    const window = await repo.between(MINT, NOW - 180_000, NOW);
    expect(window).toHaveLength(4);
    expect(window[0]!.observedAtMs).toBeLessThan(window[3]!.observedAtMs);
  });

  it("keeps series for different mints separate", async () => {
    await repo.record(point({ tokenMint: MINT, riskScore: 10 }));
    await repo.record(point({ tokenMint: OTHER, riskScore: 90 }));
    expect(await repo.list(MINT)).toHaveLength(1);
    expect((await repo.asOf(OTHER, NOW))?.riskScore).toBe(90);
  });
});

describe("retention", () => {
  it("collapses ageing high-resolution rows to one per hour", async () => {
    const oldAt = NOW - HISTORY_HIGH_RESOLUTION_MS - 3_600_000;
    // Six observations inside one hour, plus a recent one that must survive.
    for (let i = 0; i < 6; i += 1) {
      await repo.record(point({ observedAtMs: oldAt + i * 60_000 }));
    }
    await repo.record(point({ observedAtMs: NOW }));
    expect(await repo.count()).toBe(7);

    const result = await repo.prune(NOW);
    expect(result.downsampledToMedium).toBe(5);
    expect(await repo.count()).toBe(2);

    const rows = await repo.list(MINT);
    expect(rows.find((r) => r.observedAtMs === NOW)?.resolution).toBe("high");
    // The survivor is a real observation, not an average of the six.
    expect(rows.find((r) => r.observedAtMs === oldAt)?.resolution).toBe("medium");
  });

  it("collapses ageing medium rows to one per day", async () => {
    const oldAt = NOW - HISTORY_MEDIUM_RESOLUTION_MS - 86_400_000;
    for (let i = 0; i < 5; i += 1) {
      await repo.record(point({ observedAtMs: oldAt + i * 3_600_000, resolution: "medium" }));
    }
    const result = await repo.prune(NOW);
    expect(result.downsampledToLow).toBeGreaterThan(0);
    const remaining = await repo.list(MINT);
    expect(remaining.length).toBeLessThan(5);
    expect(remaining.every((r) => r.resolution === "low")).toBe(true);
  });

  it("deletes everything past the retention horizon", async () => {
    await repo.record(point({ observedAtMs: NOW - HISTORY_RETENTION_MS - 86_400_000 }));
    await repo.record(point({ observedAtMs: NOW }));
    const result = await repo.prune(NOW);
    expect(result.deleted).toBe(1);
    expect(await repo.count()).toBe(1);
  });

  it("bounds a token observed every minute rather than growing forever", async () => {
    // The claim migration 013 makes: a minute-by-minute token collapses to a
    // few rows per hour once it ages out of the high-resolution window.
    const start = NOW - HISTORY_HIGH_RESOLUTION_MS - 3 * 3_600_000;
    for (let i = 0; i < 180; i += 1) {
      await repo.record(point({ observedAtMs: start + i * 60_000 }));
    }
    expect(await repo.count()).toBe(180);

    await repo.prune(NOW);
    // Three hours of data becomes at most one row per hour.
    expect(await repo.count()).toBeLessThanOrEqual(4);
  });

  it("is safe to run repeatedly", async () => {
    await repo.record(point({ observedAtMs: NOW }));
    await repo.prune(NOW);
    const first = await repo.count();
    await repo.prune(NOW);
    expect(await repo.count()).toBe(first);
  });
});
