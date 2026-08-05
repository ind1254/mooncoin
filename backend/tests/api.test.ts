import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApp, createTestDeps, runNotificationTick, type AppDeps } from "../src/api/app.js";

/**
 * Integration tests for the main product flow, run against the real app with
 * in-memory state and a controllable clock.
 */

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const FLOOF = "FLooFDemo1111111111111111111111111111111111";

const clockRef = { now: 1_760_000_000_000 };
let deps: AppDeps;
let server: Server;
let base: string;

beforeAll(async () => {
  deps = createTestDeps(() => clockRef.now);
  const app = createApp(deps);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const get = async (path: string): Promise<{ status: number; body: Json }> => {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as Json };
};
const post = async (path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(base + path, init);
  return { status: res.status, body: (await res.json()) as Json };
};

describe("main flow", () => {
  it("health and meta clearly label the prototype as simulated demo data", async () => {
    const health = await get("/health");
    expect(health.status).toBe(200);
    expect(health.body.executionEnabled).toBe(false);
    expect(health.body.isDemoData).toBe(true);

    const meta = await get("/v1/meta");
    expect(meta.body.simulated).toBe(true);
    expect(String(meta.body.dataSource)).toMatch(/demonstration/i);
  });

  it("ranks opportunities with scores, risk levels, and explanations", async () => {
    const { status, body } = await get("/v1/opportunities");
    expect(status).toBe(200);
    expect(body.count).toBeGreaterThanOrEqual(5);

    const list = body.opportunities as Array<Record<string, any>>;
    // Sorted by opportunity score descending
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.scores.opportunity).toBeGreaterThanOrEqual(list[i]!.scores.opportunity);
    }
    // Every card explains itself and identifies tokens by mint
    for (const item of list) {
      expect(item.token.mint.length).toBeGreaterThanOrEqual(32);
      expect(Array.isArray(item.whyRanks)).toBe(true);
      expect(item.whyRanks.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(item.riskLevel);
    }
    // The synthetic pump token is high risk and never labeled strong
    const floof = list.find((i) => i.token.mint === FLOOF)!;
    expect(floof.riskLevel).toBe("high");
    expect(floof.opportunityLabel).not.toBe("strong");
  });

  it("filters by risk, liquidity, and search", async () => {
    const lowRisk = await get("/v1/opportunities?risk=low");
    expect((lowRisk.body.opportunities as any[]).every((i) => i.riskLevel === "low")).toBe(true);

    const bigLiq = await get("/v1/opportunities?minLiquidityUsd=5000000");
    expect((bigLiq.body.opportunities as any[]).every((i) => parseFloat(i.liquidityUsd) >= 5_000_000)).toBe(true);

    const search = await get("/v1/opportunities?search=bonk");
    expect(search.body.count).toBe(1);
    expect(search.body.opportunities[0].token.symbol).toBe("BONK");
  });

  it("serves token detail with score evidence, freshness, routes, and candles", async () => {
    const { status, body } = await get(`/v1/tokens/${BONK}?tradeSizeSol=10`);
    expect(status).toBe(200);
    expect(body.scores.opportunity.factors.length).toBeGreaterThan(0);
    expect(body.scores.disclaimer).toMatch(/not a prediction/i);
    expect(body.freshness).toHaveLength(3);
    expect(body.routes.best).toBeTruthy();
    expect(body.candles.length).toBe(48);
    expect(body.roundTrip).toBeTruthy();
  });

  it("returns structured errors for unknown mints and bad amounts", async () => {
    const unknown = await get(`/v1/tokens/${"Z".repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("TOKEN_NOT_ALLOWED");

    const badAmount = await post("/v1/paper/positions", { tokenMint: BONK, solAmount: -5 });
    expect(badAmount.status).toBe(400);
    expect(badAmount.body.error).toBe("VALIDATION_ERROR");
  });

  it("compares routes and reports venue failures for thin tokens", async () => {
    const { body } = await get(`/v1/tokens/${FLOOF}/routes?tradeSizeSol=1`);
    expect(body.routes.failures.length).toBeGreaterThan(0);
    expect(body.routes.best.priceImpactPct).toBeTruthy();
  });

  it("opens, revalues, and closes a paper position end to end", async () => {
    const open = await post("/v1/paper/positions", { tokenMint: BONK, solAmount: 10 });
    expect(open.status).toBe(201);
    expect(open.body.simulated).toBe(true);
    expect(open.body.notice).toMatch(/no funds moved/i);
    const id = open.body.position.id as string;
    expect(open.body.position.entryConditions.riskLevel).toBe("low");

    // Portfolio shows the open position, labeled simulated
    const before = await get("/v1/paper/portfolio");
    expect(before.body.simulated).toBe(true);
    expect(before.body.openPositions).toHaveLength(1);
    expect(parseFloat(before.body.cashSol)).toBeLessThan(100);

    // Let simulated time pass so the valuation moves
    clockRef.now += 30 * 60_000;

    const close = await post(`/v1/paper/positions/${id}/close`);
    expect(close.status).toBe(200);
    expect(close.body.position.status).toBe("closed");
    expect(close.body.position.realizedPnlSol).not.toBeNull();
    expect(close.body.position.exitVenue).toBeTruthy();

    const after = await get("/v1/paper/portfolio");
    expect(after.body.openPositions).toHaveLength(0);
    expect(after.body.closedPositions).toHaveLength(1);
    expect(after.body.stats.closedCount).toBe(1);
    expect(after.body.stats.totalNetworkFeesSol).not.toBe("0.000000");
  });

  it("blocks paper trades above the virtual balance with a clear error", async () => {
    const res = await post("/v1/paper/positions", { tokenMint: BONK, solAmount: 999 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("INSUFFICIENT_PAPER_BALANCE");
  });

  it("blocks high-impact paper trades with a clear error", async () => {
    const res = await post("/v1/paper/positions", { tokenMint: FLOOF, solAmount: 10 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("PRICE_IMPACT_TOO_HIGH");
    expect(res.body.message).toMatch(/exceeds your/i);
  });

  it("updates settings with validation and rejects nonsense", async () => {
    const ok = await fetch(base + "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ riskPreference: "aggressive", maxPriceImpactBps: 300 }),
    });
    const okBody = (await ok.json()) as Json;
    expect(okBody.settings.riskPreference).toBe("aggressive");

    const bad = await fetch(base + "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxPriceImpactBps: -5 }),
    });
    expect(bad.status).toBe(400);
  });

  it("manages the watchlist and rejects unsupported mints", async () => {
    const add = await post("/v1/watchlist", { mint: BONK, watched: true });
    expect(add.body.settings.watchlist).toContain(BONK);
    const remove = await post("/v1/watchlist", { mint: BONK, watched: false });
    expect(remove.body.settings.watchlist).not.toContain(BONK);
    const bad = await post("/v1/watchlist", { mint: "Y".repeat(43), watched: true });
    expect(bad.status).toBe(404);
  });

  it("produces explained notifications from the rule engine", async () => {
    // Prime baselines, then jump time so cooldowns and transitions can fire
    await runNotificationTick(deps);
    clockRef.now += 60 * 60_000;
    await runNotificationTick(deps);

    const { body } = await get("/v1/notifications");
    const all = body.notifications as Array<Record<string, any>>;
    // FLOOF's draining liquidity must produce an explained alert
    const liq = all.find((n) => n.category === "liquidity_drop" && n.tokenSymbol === "FLOOF");
    expect(liq).toBeTruthy();
    expect(liq!.reason).toMatch(/fell .*% in the last hour/i);
    for (const n of all) {
      expect(n.reason.length).toBeGreaterThan(20);
      expect(n.reason).not.toMatch(/guaranteed/i);
    }

    const mark = await post("/v1/notifications/mark-read");
    expect(mark.body.ok).toBe(true);
    const after = await get("/v1/notifications");
    expect(after.body.unread).toBe(0);
  });

  it("keeps the legacy arbitrage calculator working", async () => {
    const res = await post("/v1/arbitrage/calculate", { tokenMint: BONK, startingAmountUsd: 500 });
    expect(res.status).toBe(200);
    expect(res.body.executionEnabled).toBe(false);
    expect(res.body.estimatedNetProfitUsd).toBeTruthy();
  });
});
