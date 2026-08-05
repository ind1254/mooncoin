import { randomUUID } from "node:crypto";
import { ArbError } from "../core/errors.js";
import { LAMPORTS_PER_SOL, returnBps as calcReturnBps } from "../core/money.js";
import type { MarketDataService } from "../market/service.js";
import type { RouteQuote } from "../market/types.js";
import { computeScores, type ScoringLimits } from "../scoring/scores.js";
import type { PaperStateStore, PaperState } from "./store.js";
import type { PaperPosition, Portfolio, PortfolioStats } from "./types.js";
import type { RiskLevel } from "../scoring/scores.js";

/**
 * Deterministic paper-trading engine.
 *
 * SIMULATION ONLY: opens and closes virtual positions priced from current
 * executable route quotes (never chart prices), applying route fees, price
 * impact, network + priority fees, and the user's slippage assumption.
 * There is no code path that builds, signs, or submits a transaction.
 */

export interface OpenPositionRequest {
  tokenMint: string;
  solAmountLamports: bigint;
  slippageBps: bigint;
  limits: ScoringLimits;
}

export interface PaperEngineConfig {
  startingBalanceLamports: bigint;
}

export const DEFAULT_ENGINE_CONFIG: PaperEngineConfig = {
  startingBalanceLamports: 100n * LAMPORTS_PER_SOL, // 100 virtual SOL
};

export class PaperTradingEngine {
  private state: PaperState;

  constructor(
    private readonly market: MarketDataService,
    private readonly store: PaperStateStore,
    private readonly clock: () => number = Date.now,
    config: PaperEngineConfig = DEFAULT_ENGINE_CONFIG,
  ) {
    this.state = this.store.load() ?? {
      startingBalanceLamports: config.startingBalanceLamports,
      cashLamports: config.startingBalanceLamports,
      positions: [],
    };
  }

  /** Direct state access for seeding demo scenarios and tests. */
  getState(): PaperState {
    return this.state;
  }

  replaceState(state: PaperState): void {
    this.state = state;
    this.store.save(this.state);
  }

  async openPosition(req: OpenPositionRequest): Promise<PaperPosition> {
    const nowMs = this.clock();
    if (req.solAmountLamports <= 0n) {
      throw new ArbError("VALIDATION_ERROR", "Paper-trade amount must be positive", 400);
    }
    // Cheap pre-check before any provider call; the exact check including
    // fees runs again once the quote is known.
    if (req.solAmountLamports > this.state.cashLamports) {
      throw new ArbError(
        "INSUFFICIENT_PAPER_BALANCE",
        "Not enough virtual SOL for this paper trade",
        409,
        { availableLamports: this.state.cashLamports.toString() },
      );
    }

    const view = await this.market.getView(req.tokenMint); // 404s unsupported mints
    const routes = await this.market.getBuyRoutes(req.tokenMint, req.solAmountLamports, req.slippageBps);
    const best = routes.best;
    if (!best) {
      throw new ArbError("NO_QUOTE_AVAILABLE", "No venue returned an executable buy quote for this size", 502, {
        failures: routes.failures,
      });
    }
    if (nowMs >= best.expiresAtMs) {
      throw new ArbError("STALE_QUOTE", "The buy quote expired before the paper trade could be recorded", 409);
    }
    if (best.priceImpactBps > req.limits.maxPriceImpactBps) {
      throw new ArbError(
        "PRICE_IMPACT_TOO_HIGH",
        `Estimated price impact ${(Number(best.priceImpactBps) / 100).toFixed(2)}% exceeds your ${(Number(req.limits.maxPriceImpactBps) / 100).toFixed(2)}% limit`,
        409,
      );
    }

    const entryFees = best.networkFeeLamports + best.priorityFeeLamports;
    const totalCost = req.solAmountLamports + entryFees;
    if (totalCost > this.state.cashLamports) {
      throw new ArbError(
        "INSUFFICIENT_PAPER_BALANCE",
        "Not enough virtual SOL for this paper trade including fees",
        409,
        { requiredLamports: totalCost.toString(), availableLamports: this.state.cashLamports.toString() },
      );
    }

    // Fill at minReceived: the simulation assumes the worst fill the user's
    // slippage setting would accept, so results are conservative.
    const tokensReceived = best.minReceived;
    if (tokensReceived <= 0n) {
      throw new ArbError("NO_QUOTE_AVAILABLE", "Quote output rounds to zero tokens at this size", 409);
    }

    const scores = computeScores(
      view,
      routes,
      (req.solAmountLamports * view.solPriceMicroUsd) / LAMPORTS_PER_SOL,
      req.limits,
      nowMs,
    );

    const position: PaperPosition = {
      id: randomUUID(),
      tokenMint: view.token.mint,
      tokenSymbol: view.token.symbol,
      tokenDecimals: view.token.decimals,
      status: "open",
      executionMode: "paper",
      openedAtMs: nowMs,
      entryVenueId: best.venueId,
      entryVenueName: best.venueName,
      entryPricePicoUsd: best.effectivePricePicoUsd,
      solSpentLamports: req.solAmountLamports,
      entryNetworkFeeLamports: entryFees,
      totalCostLamports: totalCost,
      tokensReceived,
      entryImpactBps: best.priceImpactBps,
      entryRouteFeeBps: best.routeFeeBps,
      slippageBps: req.slippageBps,
      entryConditions: {
        opportunityScore: scores.opportunity.score,
        riskScore: scores.risk.score,
        riskLevel: scores.riskLevel,
        liquidityUsdMicro: view.liquidity.value.totalUsdMicro,
        change1hBps: view.momentum.value.change1hBps,
        solPriceMicroUsd: view.solPriceMicroUsd,
      },
      currentValueLamports: req.solAmountLamports,
      unrealizedPnlLamports: -entryFees,
      returnBps: calcReturnBps(-entryFees, totalCost),
      highWaterLamports: req.solAmountLamports,
      lowWaterLamports: req.solAmountLamports,
      valuationStale: false,
      lastValuedAtMs: nowMs,
    };

    this.state.cashLamports -= totalCost;
    this.state.positions.unshift(position);
    this.store.save(this.state);
    return position;
  }

  /** Revalue all open positions from current executable sell quotes. */
  async revalueOpenPositions(): Promise<void> {
    const nowMs = this.clock();
    for (const p of this.state.positions) {
      if (p.status !== "open") continue;
      try {
        const routes = await this.market.getSellRoutes(p.tokenMint, p.tokensReceived, p.slippageBps);
        if (!routes.best || nowMs >= routes.best.expiresAtMs) {
          p.valuationStale = true;
          continue;
        }
        this.applyValuation(p, routes.best, nowMs);
      } catch {
        p.valuationStale = true; // provider failure: keep last value, flag it
      }
    }
    this.store.save(this.state);
  }

  private applyValuation(p: PaperPosition, sell: RouteQuote, nowMs: number): void {
    p.currentValueLamports = sell.outAmount;
    p.unrealizedPnlLamports = sell.outAmount - p.totalCostLamports;
    p.returnBps = calcReturnBps(p.unrealizedPnlLamports, p.totalCostLamports);
    if (sell.outAmount > p.highWaterLamports) p.highWaterLamports = sell.outAmount;
    if (sell.outAmount < p.lowWaterLamports) p.lowWaterLamports = sell.outAmount;
    p.valuationStale = false;
    p.lastValuedAtMs = nowMs;
  }

  async closePosition(id: string): Promise<PaperPosition> {
    const nowMs = this.clock();
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) throw new ArbError("POSITION_NOT_FOUND", "Paper position not found", 404);
    if (p.status === "closed") {
      throw new ArbError("POSITION_ALREADY_CLOSED", "This paper position is already closed", 409);
    }

    const routes = await this.market.getSellRoutes(p.tokenMint, p.tokensReceived, p.slippageBps);
    const best = routes.best;
    if (!best) {
      throw new ArbError("NO_QUOTE_AVAILABLE", "No venue returned an executable sell quote — try again shortly", 502, {
        failures: routes.failures,
      });
    }
    if (nowMs >= best.expiresAtMs) {
      throw new ArbError("STALE_QUOTE", "The sell quote expired — refresh and try again", 409);
    }

    // Conservative fill at minReceived, mirroring entry
    const proceeds = best.minReceived > 0n ? best.minReceived : 0n;

    this.applyValuation(p, best, nowMs);
    p.status = "closed";
    p.closedAtMs = nowMs;
    p.exitVenueId = best.venueId;
    p.exitVenueName = best.venueName;
    p.exitValueLamports = proceeds;
    p.exitNetworkFeeLamports = best.networkFeeLamports + best.priorityFeeLamports;
    p.exitImpactBps = best.priceImpactBps;
    p.realizedPnlLamports = proceeds - p.totalCostLamports;
    p.currentValueLamports = proceeds;
    p.unrealizedPnlLamports = 0n;
    p.returnBps = calcReturnBps(p.realizedPnlLamports, p.totalCostLamports);

    this.state.cashLamports += proceeds;
    this.store.save(this.state);
    return p;
  }

  async getPortfolio(): Promise<Portfolio> {
    await this.revalueOpenPositions();
    const open = this.state.positions.filter((p) => p.status === "open");
    const closed = this.state.positions.filter((p) => p.status === "closed");
    const openValue = open.reduce((sum, p) => sum + p.currentValueLamports, 0n);
    return {
      simulated: true,
      startingBalanceLamports: this.state.startingBalanceLamports,
      cashLamports: this.state.cashLamports,
      openPositions: open,
      closedPositions: closed,
      totalValueLamports: this.state.cashLamports + openValue,
      stats: computeStats(open, closed),
    };
  }
}

export function computeStats(open: PaperPosition[], closed: PaperPosition[]): PortfolioStats {
  const wins = closed.filter((p) => (p.realizedPnlLamports ?? 0n) > 0n);
  const losses = closed.filter((p) => (p.realizedPnlLamports ?? 0n) <= 0n);

  const avg = (list: PaperPosition[]): bigint =>
    list.length === 0
      ? 0n
      : list.reduce((s, p) => s + p.returnBps, 0n) / BigInt(list.length);

  const allReturns = closed.map((p) => p.returnBps);
  const best = allReturns.length ? allReturns.reduce((a, b) => (b > a ? b : a)) : 0n;
  const worst = allReturns.length ? allReturns.reduce((a, b) => (b < a ? b : a)) : 0n;

  const networkFees = [...open, ...closed].reduce(
    (s, p) => s + p.entryNetworkFeeLamports + (p.exitNetworkFeeLamports ?? 0n),
    0n,
  );

  const execCosts = [...open, ...closed].flatMap((p) => [
    p.entryImpactBps + p.entryRouteFeeBps,
    ...(p.exitImpactBps !== undefined ? [p.exitImpactBps] : []),
  ]);
  const avgExecCost = execCosts.length
    ? execCosts.reduce((a, b) => a + b, 0n) / BigInt(execCosts.length)
    : 0n;

  const byRiskLevel = {} as PortfolioStats["byRiskLevel"];
  for (const level of ["low", "medium", "high"] as RiskLevel[]) {
    const trades = closed.filter((p) => p.entryConditions.riskLevel === level);
    const levelWins = trades.filter((p) => (p.realizedPnlLamports ?? 0n) > 0n);
    byRiskLevel[level] = {
      trades: trades.length,
      realizedPnlLamports: trades.reduce((s, p) => s + (p.realizedPnlLamports ?? 0n), 0n),
      winRatePct: trades.length ? Math.round((levelWins.length / trades.length) * 100) : 0,
    };
  }

  return {
    totalTrades: open.length + closed.length,
    openCount: open.length,
    closedCount: closed.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePct: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
    totalRealizedPnlLamports: closed.reduce((s, p) => s + (p.realizedPnlLamports ?? 0n), 0n),
    totalUnrealizedPnlLamports: open.reduce((s, p) => s + p.unrealizedPnlLamports, 0n),
    avgGainBps: avg(wins),
    avgLossBps: avg(losses),
    bestTradeBps: best,
    worstTradeBps: worst,
    totalNetworkFeesLamports: networkFees,
    avgExecutionCostBps: avgExecCost,
    byRiskLevel,
  };
}
