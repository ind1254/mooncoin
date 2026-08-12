import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { createLiveBundle } from "../src/market/liveProviders.js";
import { MarketDataService } from "../src/market/service.js";
import { SolanaRpcClient } from "../src/market/solana/rpc.js";

/**
 * Integration across the provider boundary: live bundle -> market service ->
 * API serialization. Offline — the RPC client's transport is canned with the
 * mainnet fixtures recorded in step 1A.
 */

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const FLOOF = "FLooFDemo1111111111111111111111111111111111";
const START = 1_760_000_000_000;

function fixtureBody(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/solana/${name}.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { response: unknown }).response;
}

/** Serves the right recorded account per requested address. */
function routingClient(): SolanaRpcClient {
  return new SolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { params: [string] };
      const address = body.params[0];
      const name = address === BONK ? "bonk-mint" : "missing-account";
      return new Response(JSON.stringify(fixtureBody(name)), { status: 200 });
    },
  });
}

let server: Server;
let base: string;

beforeAll(async () => {
  const clock = () => START;
  const deps = createTestDeps(clock);
  deps.market = new MarketDataService(createLiveBundle(clock, { client: routingClient() }));

  const app = createApp(deps);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server?.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = async (path: string): Promise<any> => (await fetch(base + path)).json();

describe("live mode surfaced through the API", () => {
  it("labels the data source without claiming everything is live", async () => {
    const meta = await get("/v1/meta");
    expect(meta.dataSource).toMatch(/Live on-chain/);
    expect(meta.dataSource).toMatch(/simulated/);
    // Most values are still simulated, so the paper-trading framing stands.
    expect(meta.isDemoData).toBe(true);
    expect(meta.executionEnabled).toBe(false);
  });

  it("returns verification status and chain-sourced authority fields", async () => {
    const d = await get(`/v1/tokens/${BONK}`);
    const rf = d.riskFacts;

    expect(rf.onChainVerification.status).toBe("verified");
    expect(rf.onChainVerification.decimalsOnChain).toBe(5);
    expect(rf.onChainVerification.checkedAtMs).toBe(START);
    expect(rf.mintAuthorityRevoked).toBe(true);
    expect(rf.freezeAuthorityRevoked).toBe(true);
  });

  it("keys per-field provenance to the names the client actually reads", async () => {
    const d = await get(`/v1/tokens/${BONK}`);
    const sources = d.riskFacts.fieldSources;

    // Regression: internal names are bps-suffixed, serialized names are pct.
    expect(sources).toHaveProperty("holderConcentrationPct");
    expect(sources).not.toHaveProperty("holderConcentrationBps");
    // Every serialized risk field carries an attribution.
    for (const key of [
      "tokenAgeDays",
      "holderConcentrationPct",
      "mintAuthorityRevoked",
      "freezeAuthorityRevoked",
      "recentInsiderActivity",
      "dataComplete",
    ]) {
      expect(typeof sources[key]).toBe("string");
    }
    expect(sources.mintAuthorityRevoked).toBe("solana-rpc:mainnet");
    expect(sources.holderConcentrationPct).toBe("demo-simulator");
  });

  it("distinguishes unverifiable from simulated when a mint does not exist", async () => {
    const d = await get(`/v1/tokens/${FLOOF}`);
    const rf = d.riskFacts;

    expect(rf.onChainVerification.status).toBe("not_found");
    expect(rf.onChainVerification.detail).toMatch(/No account exists/);
    // Values remain, still attributed to the simulator — not silently "live".
    expect(rf.fieldSources.mintAuthorityRevoked).toBe("demo-simulator");
    expect(rf.dataComplete).toBe(false);
  });

  it("puts a compact verification badge on every discover card", async () => {
    const list = await get("/v1/opportunities");
    const bonk = list.opportunities.find((o: { token: { mint: string } }) => o.token.mint === BONK);
    const floof = list.opportunities.find((o: { token: { mint: string } }) => o.token.mint === FLOOF);

    expect(bonk.verification).toEqual({ status: "verified", live: true });
    expect(floof.verification).toEqual({ status: "not_found", live: false });
  });

  it("a failing RPC degrades the page instead of breaking it", async () => {
    const clock = () => START;
    const deps = createTestDeps(clock);
    deps.market = new MarketDataService(
      createLiveBundle(clock, {
        client: new SolanaRpcClient({ fetchImpl: async () => new Response("{}", { status: 429 }) }),
      }),
    );
    const app = createApp(deps);
    const s = app.listen(0);
    const addr = s.address();
    const url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

    const res = await fetch(`${url}/v1/opportunities`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.opportunities.length).toBeGreaterThan(0);
    expect(body.opportunities[0].verification.status).toBe("unavailable");
    s.close();
  });
});

describe("demo mode is unchanged", () => {
  it("omits verification entirely rather than faking it", async () => {
    const deps = createTestDeps(() => START);
    const app = createApp(deps);
    const s = app.listen(0);
    const addr = s.address();
    const url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

    const d = (await (await fetch(`${url}/v1/tokens/${BONK}`)).json()) as {
      riskFacts: { onChainVerification: unknown; fieldSources: unknown };
    };
    expect(d.riskFacts.onChainVerification).toBeNull();
    expect(d.riskFacts.fieldSources).toBeNull();
    s.close();
  });
});
