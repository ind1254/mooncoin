import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { MetricsRegistry, outcomeForErrorCode } from "../src/observability/metrics.js";

/**
 * Metrics exist to answer "which provider is failing, how, and how often"
 * during a production incident. The tests that matter most are the ones about
 * what must NOT end up in them.
 */

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("metrics registry", () => {
  it("counts calls by provider and outcome", () => {
    const registry = new MetricsRegistry(() => 0);
    registry.providerCall("jupiter:quote-v1", "ok", 50);
    registry.providerCall("jupiter:quote-v1", "rate_limited", 10);
    registry.providerCall("solana:rpc", "timeout", 8_000);

    const snap = registry.snapshot();
    const jupiter = snap.providers.find((p) => p.provider === "jupiter:quote-v1")!;
    expect(jupiter.calls).toBe(2);
    expect(jupiter.byOutcome.ok).toBe(1);
    expect(jupiter.byOutcome.rate_limited).toBe(1);
    // Sorted busiest-first so an incident view leads with the hot provider.
    expect(snap.providers[0]!.provider).toBe("jupiter:quote-v1");
  });

  it("reports latency percentiles rather than an average", () => {
    // An average hides the tail, and the tail is what times out.
    const registry = new MetricsRegistry(() => 0);
    for (const ms of [10, 12, 14, 16, 5_000]) registry.providerCall("p", "ok", ms);
    const latency = registry.snapshot().providers[0]!.latency!;
    expect(latency.count).toBe(5);
    expect(latency.max).toBe(5_000);
    expect(latency.p50).toBeLessThan(100);
  });

  it("bounds its latency sample so a long-lived instance cannot grow it", () => {
    const registry = new MetricsRegistry(() => 0);
    for (let i = 0; i < 2_000; i += 1) registry.providerCall("p", "ok", i);
    expect(registry.snapshot().providers[0]!.latency!.count).toBeLessThanOrEqual(500);
  });

  it("returns null latency until something is recorded", () => {
    const registry = new MetricsRegistry(() => 0);
    registry.cache("p", "miss");
    expect(registry.snapshot().providers[0]!.latency).toBeNull();
  });

  it("tracks cache, gate rejections, worker passes and bot decisions", () => {
    const registry = new MetricsRegistry(() => 0);
    registry.cache("jupiter:quote-v1", "hit");
    registry.cache("jupiter:quote-v1", "miss");
    registry.gateRejection("price_impact");
    registry.gateRejection("price_impact");
    registry.gateRejection("minimum_liquidity");
    registry.workerPass(1_200, ["paper_bot"]);
    registry.botDecision("rejected_quality");

    const snap = registry.snapshot();
    expect(snap.providers[0]!.cacheHits).toBe(1);
    expect(snap.gateRejections.price_impact).toBe(2);
    expect(Object.keys(snap.gateRejections)[0]).toBe("price_impact"); // busiest first
    expect(snap.worker).toMatchObject({ runs: 1, failures: 1, lastDurationMs: 1_200 });
    expect(snap.worker.componentFailures.paper_bot).toBe(1);
    expect(snap.botDecisions.rejected_quality).toBe(1);
  });

  it("states that counters are per-instance rather than implying a global total", () => {
    // Serverless instances recycle; pretending otherwise would mislead during
    // an incident.
    expect(new MetricsRegistry(() => 0).snapshot().scope).toBe("single-instance");
  });

  it("maps provider error codes onto stable outcomes", () => {
    expect(outcomeForErrorCode("PROVIDER_TIMEOUT")).toBe("timeout");
    expect(outcomeForErrorCode("PROVIDER_RATE_LIMITED")).toBe("rate_limited");
    expect(outcomeForErrorCode("MALFORMED_PROVIDER_RESPONSE")).toBe("malformed");
    expect(outcomeForErrorCode("QUOTE_UNAVAILABLE")).toBe("not_found");
    expect(outcomeForErrorCode("SOMETHING_NEW")).toBe("unavailable");
  });
});

async function startApp(adminToken?: string) {
  const deps = createTestDeps(Date.now);
  if (adminToken) deps.env = { ...deps.env, ADMIN_TOKEN: adminToken };
  server = createApp(deps).listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server!.address();
  return typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
}

describe("GET /admin/metrics", () => {
  it("hides its own existence when no admin token is configured", async () => {
    // 404 rather than 401: a 401 would advertise that the endpoint is there.
    const base = await startApp();
    const res = await fetch(`${base}/admin/metrics`);
    expect(res.status).toBe(404);
  });

  it("refuses a wrong token the same way it refuses none", async () => {
    const base = await startApp("secret-token-value-1234567890");
    const res = await fetch(`${base}/admin/metrics`, { headers: { "x-admin-token": "wrong" } });
    expect(res.status).toBe(404);
  });

  it("serves a snapshot to an authorised caller, and leaks no secrets", async () => {
    const token = "secret-token-value-1234567890";
    const base = await startApp(token);
    const res = await fetch(`${base}/admin/metrics`, { headers: { "x-admin-token": token } });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.scope).toBe("single-instance");
    expect(Array.isArray(body.providers)).toBe(true);
    expect(String(body.notice)).toMatch(/instance/i);

    // The response must never echo the credential that unlocked it, and the
    // registry is keyed by provider id so no URL or query string can appear.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toMatch(/api[-_]?key/i);
    expect(serialized).not.toMatch(/https?:\/\//);
  });
});
