import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { PasswordAuthProvider } from "../src/auth/authService.js";
import { ArbError } from "../src/core/errors.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import type { NormalizedSwapQuote, QuoteProvider, QuoteRequest } from "../src/market/jupiter/quotes.js";
import type { ResearchProfile, ResearchService } from "../src/market/research.js";
import { USDC_MINT } from "../src/market/tradability.js";
import type { TokenSearchResult } from "../src/market/types.js";

const NOW = Date.parse("2026-08-17T21:00:00Z");
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

let db: SqlClient;
let server: Server;
let base: string;
let liquidityMicro: bigint;
let sellUnavailable: boolean;

const market = () => ({
  priceUsdPico: 12_000_000n,
  liquidityUsdMicro: liquidityMicro,
  marketCapUsdMicro: 1_000_000n * 1_000_000n,
  fdvUsdMicro: 1_200_000n * 1_000_000n,
  holderCount: 10_000,
  change1hBps: 100n,
  change24hBps: 250n,
  buyVolume24hUsdMicro: 500_000n * 1_000_000n,
  sellVolume24hUsdMicro: 400_000n * 1_000_000n,
  numBuys24h: 1_000,
  numSells24h: 900,
  topHolderPctBps: 1_500n,
  organicScore: 75,
  organicScoreLabel: "high" as const,
});

const token = (mint = MINT): TokenSearchResult => ({
  mint,
  symbol: mint === USDC_MINT ? "USDC" : "BONK",
  name: mint === USDC_MINT ? "USD Coin" : "Bonk",
  decimals: mint === USDC_MINT ? 6 : 5,
  firstPoolAtMs: NOW - 86_400_000,
  marketUpdatedAtMs: NOW - 5_000,
  tokenProgram: TOKEN_PROGRAM,
  iconUrl: null,
  verifiedByProvider: true,
  tags: ["verified"],
  source: "jupiter:tokens-v2",
  market: market(),
  providerClaims: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
});

const profile = (): ResearchProfile => ({
  mint: MINT,
  symbol: "BONK",
  name: "Bonk",
  decimals: 5,
  tokenProgram: TOKEN_PROGRAM,
  iconUrl: null,
  tags: ["verified"],
  verifiedByProvider: true,
  identitySource: "jupiter:tokens-v2",
  marketSource: "jupiter:tokens-v2",
  marketUpdatedAtMs: NOW - 5_000,
  market: market(),
  verification: { status: "verified", source: "solana-rpc:mainnet", checkedAtMs: NOW - 1_000 },
  authorities: {
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    source: "solana-rpc:mainnet",
    providerAgreement: "agrees",
  },
  risk: { score: 5, level: "low", factors: [], method: "test" },
  simulation: { available: false, reason: "live paper path" },
  fetchedAtMs: NOW,
});

function quoteFor(req: QuoteRequest): NormalizedSwapQuote {
  const entering = req.inputMint === USDC_MINT;
  if (!entering && sellUnavailable) {
    throw new ArbError("QUOTE_UNAVAILABLE", "No sell route is available right now", 409);
  }
  const outAmount = entering ? 8_000_000_000n : 110_000_000n;
  const minOutAmount = entering ? 7_960_000_000n : 109_000_000n;
  return {
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    inAmount: req.amount,
    outAmount,
    minOutAmount,
    slippageBps: req.slippageBps,
    priceImpactBps: entering ? 25n : 40n,
    routePlan: [
      {
        ammLabel: entering ? "Meteora" : "Orca",
        ammKey: entering ? "entry-amm" : "exit-amm",
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        percent: 100,
        inAmount: null,
        outAmount: null,
        updateContextSlot: null,
      },
    ],
    swapUsdValueMicro: entering ? req.amount : minOutAmount,
    contextSlot: 123,
    swapMode: "ExactIn",
    platformFee: null,
    retrievedAtMs: NOW,
    expiresAtMs: NOW + 20_000,
    source: "jupiter:quote-v1",
    apiVersion: "v1",
    providerLatencyMs: null,
    providerRequestId: null,
    instructionVersion: null,
  };
}

beforeEach(async () => {
  liquidityMicro = 250_000n * 1_000_000n;
  sellUnavailable = false;
  db = createPgliteClient();
  await migrate(db);

  const deps = createTestDeps(() => NOW);
  deps.db = db;
  deps.auth = new PasswordAuthProvider(db, { clock: () => NOW, sessionTtlMs: 30 * 86_400_000 });
  deps.env = {
    ...deps.env,
    COOKIE_SECURE: false,
    PAPER_STARTING_USD: 100_000,
    PAPER_MIN_TRADE_USD: 10,
    PAPER_MAX_TRADE_USD: 10_000,
    PAPER_MAX_OPEN_POSITIONS: 25,
  };
  deps.research = {
    getProfile: async () => profile(),
    resolveToken: async (mint: string) => (mint === USDC_MINT ? token(USDC_MINT) : token()),
    search: async () => [token()],
  } as unknown as ResearchService;
  deps.quotes = {
    source: "jupiter:quote-v1",
    getQuote: async (req: QuoteRequest) => quoteFor(req),
  } satisfies QuoteProvider;

  const app = createApp(deps);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server?.close();
  await db.close();
});

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  cookie: string | null;
}

async function call(method: string, path: string, body?: unknown, cookie?: string | null): Promise<Result> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    cookie: setCookie ? setCookie.split(";")[0]! : null,
  };
}

const signUp = (email: string) =>
  call("POST", "/v1/auth/signup", { email, password: "correct horse battery" });

let requestSequence = 0;
const entryBody = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: `00000000-0000-4000-8000-${String(++requestSequence).padStart(12, "0")}`,
  tokenMint: MINT,
  amountUsd: "100",
  slippageBps: 50,
  ...overrides,
});

describe("live-quote paper trading", () => {
  it("opens at Jupiter's conservative minimum output and persists exact units", async () => {
    const account = await signUp("entry@example.com");
    const opened = await call(
      "POST",
      "/v1/me/paper/positions",
      entryBody(),
      account.cookie,
    );

    expect(opened.status).toBe(201);
    expect(opened.body.executionEnabled).toBe(false);
    expect(opened.body.position.quantityBaseUnits).toBe("7960000000");
    expect(opened.body.position.quantity).toBe("79600");
    expect(opened.body.position.costBasisUsd).toBe("100.00");
    expect(opened.body.position.entry.route).toEqual(["Meteora"]);

    const stored = await db.query<{ token_quantity_base_units: string }>(
      "select token_quantity_base_units from paper_positions",
    );
    expect(stored[0]!.token_quantity_base_units).toBe("7960000000");

    const portfolio = await call("GET", "/v1/me/portfolio", undefined, account.cookie);
    expect(portfolio.body.portfolio.cashUsd).toBe("99900.00");
    expect(portfolio.body.portfolio.investedUsd).toBe("100.00");
    expect(portfolio.body.portfolio.totalValueUsd).toBe("100009.00");
    expect(portfolio.body.portfolio.unrealizedPnlUsd).toBe("9.00");
    expect(portfolio.body.portfolio.positions[0].valuation.route).toEqual(["Orca"]);
  });

  it("reruns production gates server-side and leaves cash untouched when blocked", async () => {
    liquidityMicro = 9_999n * 1_000_000n;
    const account = await signUp("blocked@example.com");
    const opened = await call(
      "POST",
      "/v1/me/paper/positions",
      entryBody(),
      account.cookie,
    );

    expect(opened.status).toBe(409);
    expect(opened.body.error).toBe("PAPER_TRADE_INELIGIBLE");
    expect(opened.body.details.blockingGateIds).toContain("minimum_liquidity");
    expect((await db.query("select id from paper_positions"))).toHaveLength(0);
    expect((await call("GET", "/v1/me/portfolio", undefined, account.cookie)).body.portfolio.cashUsd).toBe(
      "100000.00",
    );
  });

  it("closes from a fresh token-to-USDC quote and never credits proceeds twice", async () => {
    const account = await signUp("close@example.com");
    const opened = await call(
      "POST",
      "/v1/me/paper/positions",
      entryBody(),
      account.cookie,
    );
    const id = opened.body.position.id as string;

    const closed = await call("POST", `/v1/me/paper/positions/${id}/close`, { slippageBps: 50 }, account.cookie);
    expect(closed.status).toBe(200);
    expect(closed.body.position.status).toBe("closed");
    expect(closed.body.position.exit.proceedsUsd).toBe("109.00");
    expect(closed.body.position.pnlUsd).toBe("9.00");
    expect(closed.body.position.exit.route).toEqual(["Orca"]);

    const again = await call("POST", `/v1/me/paper/positions/${id}/close`, {}, account.cookie);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("POSITION_ALREADY_CLOSED");

    const portfolio = await call("GET", "/v1/me/portfolio", undefined, account.cookie);
    expect(portfolio.body.portfolio.cashUsd).toBe("100009.00");
    expect(portfolio.body.portfolio.realizedPnlUsd).toBe("9.00");
    expect(portfolio.body.portfolio.openPositions).toBe(0);
    expect(portfolio.body.portfolio.closedPositions).toBe(1);
  });

  it("derives ownership from the session and hides another user's position", async () => {
    expect(
      (
        await call("POST", "/v1/me/paper/positions", entryBody())
      ).status,
    ).toBe(401);

    const alice = await signUp("paper-a@example.com");
    const bob = await signUp("paper-b@example.com");
    const opened = await call(
      "POST",
      "/v1/me/paper/positions",
      entryBody(),
      alice.cookie,
    );
    const result = await call(
      "POST",
      `/v1/me/paper/positions/${opened.body.position.id}/close`,
      {},
      bob.cookie,
    );
    expect(result.status).toBe(404);
    expect((await call("GET", "/v1/me/portfolio", undefined, alice.cookie)).body.portfolio.openPositions).toBe(1);
    expect((await call("GET", "/v1/me/portfolio", undefined, bob.cookie)).body.portfolio.openPositions).toBe(0);
  });

  it("reports an unavailable valuation instead of inventing a current price", async () => {
    const account = await signUp("unavailable@example.com");
    await call(
      "POST",
      "/v1/me/paper/positions",
      entryBody(),
      account.cookie,
    );
    sellUnavailable = true;

    const portfolio = (await call("GET", "/v1/me/portfolio", undefined, account.cookie)).body.portfolio;
    expect(portfolio.valuationStatus).toBe("unavailable");
    expect(portfolio.totalValueUsd).toBeNull();
    expect(portfolio.unrealizedPnlUsd).toBeNull();
    expect(portfolio.positions[0].valuation.status).toBe("unavailable");
    expect(portfolio.positions[0].marketValueUsd).toBeNull();
  });

  it("enforces server-owned entry limits and the database cash invariant", async () => {
    const account = await signUp("limits@example.com");
    const tooLarge = await call(
      "POST",
      "/v1/me/paper/positions",
      entryBody({ amountUsd: "10000.01" }),
      account.cookie,
    );
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error).toBe("AMOUNT_OUT_OF_RANGE");

    await db.query("update portfolios set cash_micro_usd = 50000000");
    const insufficient = await call(
      "POST",
      "/v1/me/paper/positions",
      entryBody(),
      account.cookie,
    );
    expect(insufficient.status).toBe(409);
    expect(insufficient.body.error).toBe("INSUFFICIENT_PAPER_BALANCE");
    expect((await db.query("select id from paper_positions"))).toHaveLength(0);
  });

  it("replays one client request id without debiting paper cash twice", async () => {
    const account = await signUp("retry-safe@example.com");
    const body = entryBody();

    const first = await call("POST", "/v1/me/paper/positions", body, account.cookie);
    // A genuine retry must return the committed result even if the market is
    // no longer eligible by the time the client notices its response was lost.
    liquidityMicro = 1n;
    const replay = await call("POST", "/v1/me/paper/positions", body, account.cookie);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.position.id).toBe(first.body.position.id);
    expect((await db.query("select id from paper_positions"))).toHaveLength(1);
    expect((await call("GET", "/v1/me/portfolio", undefined, account.cookie)).body.portfolio.cashUsd).toBe(
      "99900.00",
    );
  });

  it("rejects reusing a client request id for a different entry", async () => {
    const account = await signUp("retry-conflict@example.com");
    const clientRequestId = entryBody().clientRequestId;
    await call("POST", "/v1/me/paper/positions", entryBody({ clientRequestId }), account.cookie);

    const conflict = await call(
      "POST",
      "/v1/me/paper/positions",
      entryBody({ clientRequestId, amountUsd: "200" }),
      account.cookie,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("VALIDATION_ERROR");
    expect((await db.query("select id from paper_positions"))).toHaveLength(1);
  });
});
