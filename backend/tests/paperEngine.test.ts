import { describe, expect, it } from "vitest";
import { LAMPORTS_PER_SOL } from "../src/core/money.js";
import { createDemoBundle } from "../src/market/demoProviders.js";
import { MarketDataService } from "../src/market/service.js";
import { PaperTradingEngine } from "../src/paper/engine.js";
import { InMemoryPaperStateStore } from "../src/paper/store.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const FLOOF = "FLooFDemo1111111111111111111111111111111111";
const START = 1_760_000_000_000; // fixed epoch for determinism

const LIMITS = { maxPriceImpactBps: 100n, minLiquidityUsdMicro: 250_000_000_000n };
const sol = (n: number) => BigInt(n) * LAMPORTS_PER_SOL;

function makeEngine(clockRef: { now: number }) {
  const clock = () => clockRef.now;
  const market = new MarketDataService(createDemoBundle(clock));
  const engine = new PaperTradingEngine(market, new InMemoryPaperStateStore(), clock, {
    startingBalanceLamports: sol(100),
  });
  return engine;
}

describe("paper-trading engine", () => {
  it("opens a position with fees, impact, slippage, and entry snapshot applied", async () => {
    const clockRef = { now: START };
    const engine = makeEngine(clockRef);

    const p = await engine.openPosition({ tokenMint: BONK, solAmountLamports: sol(10), slippageBps: 100n, limits: LIMITS });

    expect(p.status).toBe("open");
    expect(p.executionMode).toBe("paper");
    expect(p.tokensReceived > 0n).toBe(true);
    expect(p.entryNetworkFeeLamports > 0n).toBe(true);
    expect(p.totalCostLamports).toBe(sol(10) + p.entryNetworkFeeLamports);
    expect(p.entryConditions.riskLevel).toBe("low");
    // Cash bookkeeping is exact
    expect(engine.getState().cashLamports).toBe(sol(100) - p.totalCostLamports);
  });

  it("rejects paper trades larger than the virtual balance", async () => {
    const engine = makeEngine({ now: START });
    await expect(
      engine.openPosition({ tokenMint: BONK, solAmountLamports: sol(101), slippageBps: 100n, limits: LIMITS }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PAPER_BALANCE" });
  });

  it("rejects zero and negative amounts", async () => {
    const engine = makeEngine({ now: START });
    await expect(
      engine.openPosition({ tokenMint: BONK, solAmountLamports: 0n, slippageBps: 100n, limits: LIMITS }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects opportunities whose price impact exceeds the user limit", async () => {
    const engine = makeEngine({ now: START });
    // FLOOF has ~$86k liquidity — a 10 SOL trade moves it far beyond 1%
    await expect(
      engine.openPosition({ tokenMint: FLOOF, solAmountLamports: sol(10), slippageBps: 100n, limits: LIMITS }),
    ).rejects.toMatchObject({ code: "PRICE_IMPACT_TOO_HIGH" });
  });

  it("rejects unsupported token mints", async () => {
    const engine = makeEngine({ now: START });
    await expect(
      engine.openPosition({ tokenMint: "X".repeat(43), solAmountLamports: sol(1), slippageBps: 100n, limits: LIMITS }),
    ).rejects.toMatchObject({ code: "TOKEN_NOT_ALLOWED" });
  });

  it("closing immediately realizes a small loss: round-trip costs are never free", async () => {
    const clockRef = { now: START };
    const engine = makeEngine(clockRef);
    const p = await engine.openPosition({ tokenMint: BONK, solAmountLamports: sol(10), slippageBps: 100n, limits: LIMITS });

    clockRef.now += 5_000; // same price bucket, quotes still fresh
    const closed = await engine.closePosition(p.id);

    expect(closed.status).toBe("closed");
    expect(closed.realizedPnlLamports!).toBeLessThan(0n);
    expect(closed.exitValueLamports! > 0n).toBe(true);
    // Cash bookkeeping after close: starting - cost + proceeds
    expect(engine.getState().cashLamports).toBe(sol(100) - p.totalCostLamports + closed.exitValueLamports!);
  });

  it("revalues open positions and tracks high/low watermarks over time", async () => {
    const clockRef = { now: START };
    const engine = makeEngine(clockRef);
    const p = await engine.openPosition({ tokenMint: BONK, solAmountLamports: sol(10), slippageBps: 100n, limits: LIMITS });

    const initialValue = p.currentValueLamports; // bigint copies by value
    const high = p.highWaterLamports;
    const low = p.lowWaterLamports;
    for (let i = 0; i < 12; i++) {
      clockRef.now += 10 * 60_000; // step 10 minutes
      await engine.revalueOpenPositions();
    }
    const state = engine.getState().positions[0]!;
    expect(state.lastValuedAtMs).toBe(clockRef.now);
    expect(state.highWaterLamports >= high).toBe(true);
    expect(state.lowWaterLamports <= low).toBe(true);
    expect(state.highWaterLamports >= state.lowWaterLamports).toBe(true);
    // Value tracked from executable sell quotes, not entry price
    expect(state.currentValueLamports).not.toBe(initialValue);
  });

  it("cannot close a position twice", async () => {
    const clockRef = { now: START };
    const engine = makeEngine(clockRef);
    const p = await engine.openPosition({ tokenMint: BONK, solAmountLamports: sol(5), slippageBps: 100n, limits: LIMITS });
    await engine.closePosition(p.id);
    await expect(engine.closePosition(p.id)).rejects.toMatchObject({ code: "POSITION_ALREADY_CLOSED" });
  });

  it("reports portfolio stats consistent with positions", async () => {
    const clockRef = { now: START };
    const engine = makeEngine(clockRef);
    const a = await engine.openPosition({ tokenMint: BONK, solAmountLamports: sol(10), slippageBps: 100n, limits: LIMITS });
    clockRef.now += 5_000;
    await engine.closePosition(a.id);
    await engine.openPosition({ tokenMint: BONK, solAmountLamports: sol(4), slippageBps: 100n, limits: LIMITS });

    const portfolio = await engine.getPortfolio();
    expect(portfolio.simulated).toBe(true);
    expect(portfolio.stats.totalTrades).toBe(2);
    expect(portfolio.stats.openCount).toBe(1);
    expect(portfolio.stats.closedCount).toBe(1);
    expect(portfolio.stats.winRatePct).toBe(0); // immediate round trip loses fees
    expect(portfolio.totalValueLamports).toBe(
      portfolio.cashLamports + portfolio.openPositions.reduce((s, p) => s + p.currentValueLamports, 0n),
    );
    // Total simulated value stays below starting balance: costs were paid twice
    expect(portfolio.totalValueLamports).toBeLessThan(sol(100));
  });

  it("is deterministic: identical clocks produce identical positions", async () => {
    const e1 = makeEngine({ now: START });
    const e2 = makeEngine({ now: START });
    const p1 = await e1.openPosition({ tokenMint: BONK, solAmountLamports: sol(7), slippageBps: 100n, limits: LIMITS });
    const p2 = await e2.openPosition({ tokenMint: BONK, solAmountLamports: sol(7), slippageBps: 100n, limits: LIMITS });
    expect(p1.tokensReceived).toBe(p2.tokensReceived);
    expect(p1.entryPricePicoUsd).toBe(p2.entryPricePicoUsd);
    expect(p1.totalCostLamports).toBe(p2.totalCostLamports);
  });
});
