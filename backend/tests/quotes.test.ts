import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { JupiterQuoteProvider, impactPercentToBpsCeil } from "../src/market/jupiter/quotes.js";
import { JupiterTokenSearchProvider } from "../src/market/jupiter/tokenSearch.js";
import { ResearchService } from "../src/market/research.js";
import { SolanaRpcClient } from "../src/market/solana/rpc.js";

/**
 * Offline tests for read-only quote handling, against a response recorded
 * from Jupiter. Re-record with: node scripts/refresh-jupiter-fixtures.mjs
 *
 * Drift note: the recorded amounts move with the market, so assertions cover
 * relationships (min <= out, exact BigInt parsing) rather than magnitudes.
 */

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const START = 1_760_000_000_000;

const fixture = (name: string): Record<string, unknown> =>
  (JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/jupiter/${name}.json`, import.meta.url)), "utf8")) as {
    response: Record<string, unknown>;
  }).response;

function quoteProvider(respond: () => Response, onCall?: () => void, clock = () => START) {
  return new JupiterQuoteProvider({
    clock,
    fetchImpl: async () => {
      onCall?.();
      return respond();
    },
  });
}

const serveQuote = () => new Response(JSON.stringify(fixture("quote-usdc-bonk")), { status: 200 });

const req = (over: Partial<{ inputMint: string; outputMint: string; amount: bigint; slippageBps: bigint }> = {}) => ({
  inputMint: USDC,
  outputMint: BONK,
  amount: 100_000_000n,
  slippageBps: 50n,
  ...over,
});

describe("price impact parsing", () => {
  it("parses high-precision decimal strings without float drift", () => {
    // Jupiter returns values like this; parseFloat would lose the tail.
    expect(impactPercentToBpsCeil("0.001366339669935170085524648")).toBe(1n);
    expect(impactPercentToBpsCeil("0")).toBe(0n);
    expect(impactPercentToBpsCeil("1")).toBe(100n);
    expect(impactPercentToBpsCeil("0.5")).toBe(50n);
  });

  it("rounds up, because impact is a cost to the user", () => {
    expect(impactPercentToBpsCeil("0.0001")).toBe(1n);
  });

  it("treats negative impact as zero rather than a discount", () => {
    expect(impactPercentToBpsCeil("-0.5")).toBe(0n);
  });

  it("rejects an unparseable value instead of guessing", () => {
    expect(() => impactPercentToBpsCeil("abc")).toThrow();
  });
});

describe("quote provider", () => {
  it("normalizes a recorded quote into exact BigInt amounts", async () => {
    const q = await quoteProvider(serveQuote).getQuote(req());
    const raw = fixture("quote-usdc-bonk");

    // Amounts arrive as strings and must survive exactly.
    expect(q.inAmount).toBe(BigInt(raw.inAmount as string));
    expect(q.outAmount).toBe(BigInt(raw.outAmount as string));
    expect(q.minOutAmount).toBe(BigInt(raw.otherAmountThreshold as string));
    expect(q.minOutAmount <= q.outAmount).toBe(true);
    expect(q.inputMint).toBe(USDC);
    expect(q.outputMint).toBe(BONK);
    expect(q.source).toBe("jupiter:quote-v1");
  });

  it("records an expiry that Moonpaper owns, not the provider", async () => {
    const q = await quoteProvider(serveQuote).getQuote(req());
    expect(q.retrievedAtMs).toBe(START);
    expect(q.expiresAtMs).toBeGreaterThan(q.retrievedAtMs);
    // Jupiter's payload carries no expiry field at all.
    expect(fixture("quote-usdc-bonk")).not.toHaveProperty("expiresAt");
  });

  it("preserves the aggregated route rather than flattening it to one venue", async () => {
    const q = await quoteProvider(serveQuote).getQuote(req());
    expect(q.routePlan.length).toBeGreaterThan(0);
    for (const hop of q.routePlan) {
      expect(hop.ammLabel.length).toBeGreaterThan(0);
      expect(hop.percent).toBeGreaterThan(0);
    }
  });

  it("validates inputs before making a request", async () => {
    let calls = 0;
    const p = quoteProvider(serveQuote, () => calls++);
    await expect(p.getQuote(req({ amount: 0n }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(p.getQuote(req({ outputMint: USDC }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(p.getQuote(req({ inputMint: "nope" }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(p.getQuote(req({ slippageBps: 9_999n }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toBe(0);
  });

  it("sends the optional production API key only from the server", async () => {
    let header = "";
    const provider = new JupiterQuoteProvider({
      apiKey: "test-jupiter-key",
      clock: () => START,
      fetchImpl: async (_input, init) => {
        header = new Headers(init?.headers).get("x-api-key") ?? "";
        return serveQuote();
      },
    });
    await provider.getQuote(req());
    expect(header).toBe("test-jupiter-key");
  });

  it("reports no route as QUOTE_UNAVAILABLE rather than falling back", async () => {
    const p = quoteProvider(() => new Response("{}", { status: 400 }));
    await expect(p.getQuote(req())).rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
  });

  it("surfaces rate limiting distinctly", async () => {
    const p = quoteProvider(() => new Response("{}", { status: 429 }));
    await expect(p.getQuote(req())).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
  });

  it("rejects a malformed payload", async () => {
    const p = quoteProvider(() => new Response(JSON.stringify({ inAmount: "1" }), { status: 200 }));
    await expect(p.getQuote(req())).rejects.toMatchObject({ code: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("rejects a quote whose output rounds to zero", async () => {
    const zero = { ...fixture("quote-usdc-bonk"), outAmount: "0" };
    const p = quoteProvider(() => new Response(JSON.stringify(zero), { status: 200 }));
    await expect(p.getQuote(req())).rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
  });

  it("caches briefly and dedupes concurrent identical requests", async () => {
    let calls = 0;
    const p = quoteProvider(serveQuote, () => calls++);
    await Promise.all([p.getQuote(req()), p.getQuote(req()), p.getQuote(req())]);
    await p.getQuote(req());
    expect(calls).toBe(1);
  });

  it("does not reuse a quote across different amounts", async () => {
    let calls = 0;
    const p = quoteProvider(serveQuote, () => calls++);
    await p.getQuote(req({ amount: 100_000_000n }));
    await p.getQuote(req({ amount: 200_000_000n }));
    expect(calls).toBe(2);
  });

  it("expires the cache so a stale quote is never served", async () => {
    let now = START;
    let calls = 0;
    const p = quoteProvider(serveQuote, () => calls++, () => now);
    await p.getQuote(req());
    now += 10_000; // beyond the short quote cache
    await p.getQuote(req());
    expect(calls).toBe(2);
  });
});

describe("quote API", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const deps = createTestDeps(() => START);
    deps.research = new ResearchService(
      new JupiterTokenSearchProvider({
        clock: () => START,
        fetchImpl: async (url) =>
          new Response(
            JSON.stringify(String(url).includes(BONK) ? fixture("search-bonk") : fixture("search-usdc-mint")),
            { status: 200 },
          ),
      }),
      new SolanaRpcClient({ fetchImpl: async () => new Response("{}", { status: 503 }) }),
      { clock: () => START },
    );
    deps.quotes = quoteProvider(serveQuote);

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

  it("returns a normalized quote with provenance and simulation framing", async () => {
    const { status, body } = await get(`/v1/quote?inputMint=${USDC}&outputMint=${BONK}&amount=100`);
    expect(status).toBe(200);
    expect(body.simulationOnly).toBe(true);
    expect(body.executionEnabled).toBe(false);
    expect(body.quote.source).toBe("jupiter:quote-v1");
    expect(body.quote.freshnessPolicy).toMatch(/Moonpaper/);
    // Amounts serialize as exact decimal strings, never floats.
    expect(typeof body.quote.outAmount).toBe("string");
    expect(body.input.symbol).toBe("USDC");
    expect(body.quote.expired).toBe(false);
  });

  it("converts the user's decimal amount using the token's real decimals", async () => {
    const { body } = await get(`/v1/quote?inputMint=${USDC}&outputMint=${BONK}&amount=100`);
    // 100 USDC at 6 decimals is 100,000,000 base units.
    expect(body.quote.inAmountRaw).toBe("100000000");
  });

  it("rejects an amount with more precision than the token supports", async () => {
    const { status, body } = await get(`/v1/quote?inputMint=${USDC}&outputMint=${BONK}&amount=1.1234567`);
    expect(status).toBe(400);
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toMatch(/decimal places/);
  });

  it("rejects a missing amount", async () => {
    const { status } = await get(`/v1/quote?inputMint=${USDC}&outputMint=${BONK}`);
    expect(status).toBe(400);
  });

  it("tells the user when no quote exists instead of inventing one", async () => {
    const deps = createTestDeps(() => START);
    // Both mints must resolve, so the failure under test is the quote itself.
    deps.research = new ResearchService(
      new JupiterTokenSearchProvider({
        clock: () => START,
        fetchImpl: async (url) =>
          new Response(
            JSON.stringify(String(url).includes(BONK) ? fixture("search-bonk") : fixture("search-usdc-mint")),
            { status: 200 },
          ),
      }),
      new SolanaRpcClient({ fetchImpl: async () => new Response("{}", { status: 503 }) }),
      { clock: () => START },
    );
    deps.quotes = quoteProvider(() => new Response("{}", { status: 400 }));
    const app = createApp(deps);
    const s = app.listen(0);
    const addr = s.address();
    const url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

    const res = await fetch(`${url}/v1/quote?inputMint=${BONK}&outputMint=${USDC}&amount=1`);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(409);
    expect(body.error).toBe("QUOTE_UNAVAILABLE");
    s.close();
  });
});
