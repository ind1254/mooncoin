import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import { AutoWatchRepository } from "../src/db/repositories.js";

/**
 * The auto-watch shelf endpoint.
 *
 * Public and read-only: graduation is derived from global market data and says
 * nothing about any individual, so it sits outside auth alongside the rest of
 * the public research surface.
 */

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

let db: SqlClient;
let server: Server;
let base: string;

async function start(withDb: boolean) {
  const deps = createTestDeps(Date.now);
  if (withDb) {
    db = createPgliteClient();
    await migrate(db);
    deps.db = db;
  }
  server = createApp(deps).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  server?.close();
  if (db) {
    await db.close();
    db = undefined as unknown as SqlClient;
  }
});

describe("GET /v1/auto-watch", () => {
  it("returns an empty shelf with the criteria that fill it", async () => {
    await start(true);
    const res = await fetch(`${base}/v1/auto-watch`);
    const body = await res.json() as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.count).toBe(0);
    expect(body.items).toEqual([]);
    // The thresholds are published so the UI never has to hardcode them.
    expect(body.criteria).toEqual({ qualityScore: 70, maturityDays: 30 });
  });

  it("serializes a promoted token with a human-readable reason", async () => {
    await start(true);
    await new AutoWatchRepository(db).promote({
      tokenMint: BONK,
      reason: "market_maturity",
      symbol: "BONK",
      name: "Bonk",
      qualityScore: 88,
      riskScore: 12,
      scoreVersion: "live-v2",
    });

    const res = await fetch(`${base}/v1/auto-watch`);
    const body = await res.json() as Record<string, any>;

    expect(body.count).toBe(1);
    expect(body.items[0]).toMatchObject({
      mint: BONK,
      symbol: "BONK",
      reason: "market_maturity",
      reasonLabel: "Trading for 30+ days",
      qualityScore: 88,
      riskScore: 12,
      scoreVersion: "live-v2",
    });
    expect(Date.parse(body.items[0].promotedAt)).not.toBeNaN();
    // Research context, never advice.
    expect(body.notice).toMatch(/not a recommendation/i);
  });

  it("labels a quality graduation differently from a maturity one", async () => {
    await start(true);
    await new AutoWatchRepository(db).promote({
      tokenMint: BONK,
      reason: "quality_threshold",
      symbol: "GOOD",
      name: "Good token",
      qualityScore: 74,
      riskScore: 20,
      scoreVersion: "live-v2",
    });

    const body = await (await fetch(`${base}/v1/auto-watch`)).json() as Record<string, any>;
    expect(body.items[0].reasonLabel).toBe("Quality score reached 70");
  });

  it("degrades to an explained empty shelf without persistence", async () => {
    // The feed still hides graduated tokens in this state, because that check
    // is pure. Only the durable record is unavailable, and it says so.
    await start(false);
    const res = await fetch(`${base}/v1/auto-watch`);
    const body = await res.json() as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.items).toEqual([]);
    expect(body.reason).toMatch(/persistence/i);
    expect(body.criteria).toEqual({ qualityScore: 70, maturityDays: 30 });
  });
});
