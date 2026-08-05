import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { asArbError, ArbError } from "../core/errors.js";
import {
  LAMPORTS_PER_SOL,
  lamportsToSolString,
  microToUsdString,
  picoUsdToPriceString,
  solToLamports,
  tokenUnitsToDisplay,
} from "../core/money.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { createDemoBundle } from "../market/demoProviders.js";
import { MarketDataService } from "../market/service.js";
import type { RouteComparison, RouteQuote, TokenMarketView } from "../market/types.js";
import { computeScores, type ScoringLimits, type TokenScores } from "../scoring/scores.js";
import { PaperTradingEngine } from "../paper/engine.js";
import { FilePaperStateStore, InMemoryPaperStateStore } from "../paper/store.js";
import type { PaperPosition, Portfolio } from "../paper/types.js";
import { NotificationEngine } from "../notify/engine.js";
import { FileSettingsStore, settingsSchema, type SettingsStore, type UserSettings } from "../settings/settings.js";
import { createLegacyArbitrageRouter } from "./legacyArbitrage.js";
import { seedDemoState } from "./demoSeed.js";

/**
 * FOMO Paper Trader — application factory.
 *
 * PAPER TRADING ONLY. No endpoint builds, signs, or submits a transaction;
 * no private keys are requested or stored; every trading-related response is
 * labeled simulated and carries executionEnabled: false.
 */

export interface AppDeps {
  env: AppEnv;
  clock: () => number;
  market: MarketDataService;
  engine: PaperTradingEngine;
  notify: NotificationEngine;
  settings: SettingsStore;
}

export function createDefaultDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const env = overrides.env ?? loadEnv();
  const clock = overrides.clock ?? Date.now;
  const market = overrides.market ?? new MarketDataService(createDemoBundle(clock));
  const engine =
    overrides.engine ??
    new PaperTradingEngine(market, new FilePaperStateStore(join(env.DATA_DIR, "paper-state.json")), clock, {
      startingBalanceLamports: BigInt(Math.round(env.PAPER_STARTING_SOL)) * LAMPORTS_PER_SOL,
    });
  const notify = overrides.notify ?? new NotificationEngine();
  const settings = overrides.settings ?? new FileSettingsStore(join(env.DATA_DIR, "settings.json"));
  return { env, clock, market, engine, notify, settings };
}

/** In-memory settings store used by tests. */
export class InMemorySettingsStore implements SettingsStore {
  private s: UserSettings = settingsSchema.parse({});
  get(): UserSettings {
    return this.s;
  }
  update(patch: unknown): UserSettings {
    this.s = settingsSchema.parse({ ...this.s, ...(patch as Record<string, unknown>) });
    return this.s;
  }
}

/** In-memory variant for tests — no files touched. */
export function createTestDeps(clock: () => number, env?: Partial<AppEnv>): AppDeps {
  const fullEnv = loadEnv({
    ...process.env,
    ...Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, String(v)])),
  });
  const market = new MarketDataService(createDemoBundle(clock));
  const engine = new PaperTradingEngine(market, new InMemoryPaperStateStore(), clock, {
    startingBalanceLamports: BigInt(Math.round(fullEnv.PAPER_STARTING_SOL)) * LAMPORTS_PER_SOL,
  });
  return { env: fullEnv, clock, market, engine, notify: new NotificationEngine(), settings: new InMemorySettingsStore() };
}

const pctStr = (bps: bigint | number): string => (Number(bps) / 100).toFixed(2);

function limitsFrom(settings: UserSettings): ScoringLimits {
  return {
    maxPriceImpactBps: BigInt(settings.maxPriceImpactBps),
    minLiquidityUsdMicro: BigInt(settings.minLiquidityUsd) * 1_000_000n,
  };
}

function serializeRoute(q: RouteQuote, decimals: number): Record<string, unknown> {
  const isBuy = q.side === "buy";
  return {
    venueId: q.venueId,
    venueName: q.venueName,
    side: q.side,
    inAmount: q.inAmount.toString(),
    outAmount: q.outAmount.toString(),
    inDisplay: isBuy ? `${lamportsToSolString(q.inAmount)} SOL` : `${tokenUnitsToDisplay(q.inAmount, decimals)} tokens`,
    outDisplay: isBuy ? `${tokenUnitsToDisplay(q.outAmount, decimals)} tokens` : `${lamportsToSolString(q.outAmount)} SOL`,
    minReceived: q.minReceived.toString(),
    minReceivedDisplay: isBuy
      ? `${tokenUnitsToDisplay(q.minReceived, decimals)} tokens`
      : `${lamportsToSolString(q.minReceived)} SOL`,
    effectivePriceUsd: picoUsdToPriceString(q.effectivePricePicoUsd),
    priceImpactPct: pctStr(q.priceImpactBps),
    routeFeePct: pctStr(q.routeFeeBps),
    networkFeeSol: lamportsToSolString(q.networkFeeLamports, 6),
    priorityFeeSol: lamportsToSolString(q.priorityFeeLamports, 6),
    slippagePct: pctStr(q.slippageBps),
    retrievedAtMs: q.retrievedAtMs,
    expiresAtMs: q.expiresAtMs,
    source: q.source,
  };
}

function serializeComparison(routes: RouteComparison, decimals: number): Record<string, unknown> {
  return {
    best: routes.best ? serializeRoute(routes.best, decimals) : null,
    alternatives: routes.alternatives.map((r) => serializeRoute(r, decimals)),
    failures: routes.failures,
  };
}

function serializeScores(scores: TokenScores): Record<string, unknown> {
  return {
    momentum: scores.momentum,
    liquidity: scores.liquidity,
    execution: scores.execution,
    risk: scores.risk,
    opportunity: scores.opportunity,
    riskLevel: scores.riskLevel,
    opportunityLabel: scores.opportunityLabel,
    disclaimer: "Scores describe current market conditions. They are not a prediction of future returns.",
  };
}

function serializePosition(p: PaperPosition): Record<string, unknown> {
  return {
    id: p.id,
    simulated: true,
    executionMode: p.executionMode,
    status: p.status,
    tokenMint: p.tokenMint,
    tokenSymbol: p.tokenSymbol,
    openedAtMs: p.openedAtMs,
    entryVenue: p.entryVenueName,
    entryPriceUsd: picoUsdToPriceString(p.entryPricePicoUsd),
    solSpent: lamportsToSolString(p.solSpentLamports),
    entryFeesSol: lamportsToSolString(p.entryNetworkFeeLamports, 6),
    totalCostSol: lamportsToSolString(p.totalCostLamports),
    tokensReceived: tokenUnitsToDisplay(p.tokensReceived, p.tokenDecimals),
    tokensReceivedRaw: p.tokensReceived.toString(),
    entryImpactPct: pctStr(p.entryImpactBps),
    entryRouteFeePct: pctStr(p.entryRouteFeeBps),
    slippagePct: pctStr(p.slippageBps),
    entryConditions: {
      opportunityScore: p.entryConditions.opportunityScore,
      riskScore: p.entryConditions.riskScore,
      riskLevel: p.entryConditions.riskLevel,
      liquidityUsd: microToUsdString(p.entryConditions.liquidityUsdMicro),
      change1hPct: pctStr(p.entryConditions.change1hBps),
    },
    currentValueSol: lamportsToSolString(p.currentValueLamports),
    unrealizedPnlSol: lamportsToSolString(p.unrealizedPnlLamports),
    returnPct: pctStr(p.returnBps),
    highWaterSol: lamportsToSolString(p.highWaterLamports),
    lowWaterSol: lamportsToSolString(p.lowWaterLamports),
    valuationStale: p.valuationStale,
    lastValuedAtMs: p.lastValuedAtMs,
    closedAtMs: p.closedAtMs ?? null,
    exitVenue: p.exitVenueName ?? null,
    exitValueSol: p.exitValueLamports !== undefined ? lamportsToSolString(p.exitValueLamports) : null,
    exitFeesSol: p.exitNetworkFeeLamports !== undefined ? lamportsToSolString(p.exitNetworkFeeLamports, 6) : null,
    exitImpactPct: p.exitImpactBps !== undefined ? pctStr(p.exitImpactBps) : null,
    realizedPnlSol: p.realizedPnlLamports !== undefined ? lamportsToSolString(p.realizedPnlLamports) : null,
  };
}

function serializePortfolio(portfolio: Portfolio): Record<string, unknown> {
  const s = portfolio.stats;
  return {
    simulated: true,
    notice: "All values are simulated paper-trading results. No real funds are involved.",
    startingBalanceSol: lamportsToSolString(portfolio.startingBalanceLamports),
    cashSol: lamportsToSolString(portfolio.cashLamports),
    totalValueSol: lamportsToSolString(portfolio.totalValueLamports),
    openPositions: portfolio.openPositions.map(serializePosition),
    closedPositions: portfolio.closedPositions.map(serializePosition),
    stats: {
      totalTrades: s.totalTrades,
      openCount: s.openCount,
      closedCount: s.closedCount,
      winCount: s.winCount,
      lossCount: s.lossCount,
      winRatePct: s.winRatePct,
      totalRealizedPnlSol: lamportsToSolString(s.totalRealizedPnlLamports),
      totalUnrealizedPnlSol: lamportsToSolString(s.totalUnrealizedPnlLamports),
      avgGainPct: pctStr(s.avgGainBps),
      avgLossPct: pctStr(s.avgLossBps),
      bestTradePct: pctStr(s.bestTradeBps),
      worstTradePct: pctStr(s.worstTradeBps),
      totalNetworkFeesSol: lamportsToSolString(s.totalNetworkFeesLamports, 6),
      avgExecutionCostPct: pctStr(s.avgExecutionCostBps),
      byRiskLevel: Object.fromEntries(
        Object.entries(s.byRiskLevel).map(([level, v]) => [
          level,
          { trades: v.trades, realizedPnlSol: lamportsToSolString(v.realizedPnlLamports), winRatePct: v.winRatePct },
        ]),
      ),
    },
  };
}

interface ScoredToken {
  view: TokenMarketView;
  routes: RouteComparison;
  scores: TokenScores;
  tradeSizeLamports: bigint;
}

async function scoreToken(
  deps: AppDeps,
  mint: string,
  tradeSizeSol: number,
  settings: UserSettings,
): Promise<ScoredToken> {
  const view = await deps.market.getView(mint);
  const tradeSizeLamports = solToLamports(tradeSizeSol);
  const routes = await deps.market.getBuyRoutes(mint, tradeSizeLamports, BigInt(settings.maxSlippageBps));
  const tradeSizeUsdMicro = (tradeSizeLamports * view.solPriceMicroUsd) / LAMPORTS_PER_SOL;
  const scores = computeScores(view, routes, tradeSizeUsdMicro, limitsFrom(settings), deps.clock());
  return { view, routes, scores, tradeSizeLamports };
}

export async function collectScoredTokens(deps: AppDeps, tradeSizeSol: number): Promise<ScoredToken[]> {
  const settings = deps.settings.get();
  const tokens = await deps.market.listTokens();
  const results = await Promise.allSettled(tokens.map((t) => scoreToken(deps, t.mint, tradeSizeSol, settings)));
  return results
    .filter((r): r is PromiseFulfilledResult<ScoredToken> => r.status === "fulfilled")
    .map((r) => r.value);
}

/** One notification-engine pass over current market + portfolio state. */
export async function runNotificationTick(deps: AppDeps): Promise<number> {
  const settings = deps.settings.get();
  const scored = await collectScoredTokens(deps, settings.defaultTradeSizeSol);
  await deps.engine.revalueOpenPositions();
  const open = deps.engine.getState().positions.filter((p) => p.status === "open");
  const created = deps.notify.evaluate({
    tokens: scored.map(({ view, scores, routes }) => ({ view, scores, routes })),
    openPositions: open,
    settings,
    nowMs: deps.clock(),
  });
  return created.length;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  // Correlation IDs + structured request logging; never logs request bodies
  app.use((req, res, next) => {
    const correlationId = (req.headers["x-correlation-id"] as string) || randomUUID();
    res.locals.correlationId = correlationId;
    res.setHeader("x-correlation-id", correlationId);
    const startedAt = Date.now();
    res.on("finish", () => {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          correlationId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      );
    });
    next();
  });

  // Request safety timeout — a hung provider must not hang the client
  app.use((req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({ error: "TIMEOUT", message: "The request took too long — please try again." });
      }
    }, 15_000);
    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));
    next();
  });

  const fail = (res: Response, err: unknown): void => {
    const e = asArbError(err);
    res.status(e.httpStatus).json({
      correlationId: res.locals.correlationId,
      error: e.code,
      message: e.message,
      details: e.details ?? null,
      executionEnabled: false,
    });
  };

  const meta = (deps_: AppDeps) => ({
    product: "FOMO Paper Trader (prototype)",
    simulated: true,
    executionEnabled: false,
    dataSource: deps_.market.bundle.dataSourceLabel,
    isDemoData: deps_.market.bundle.isDemo,
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, ...meta(deps) });
  });

  app.get("/v1/meta", async (_req, res) => {
    try {
      const solPrice = await deps.market.getSolPriceMicroUsd();
      res.json({ ...meta(deps), solPriceUsd: microToUsdString(solPrice) });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Discover ----
  const opportunitiesQuery = z.object({
    tradeSizeSol: z.coerce.number().positive().max(1_000).optional(),
    risk: z.enum(["low", "medium", "high"]).optional(),
    minLiquidityUsd: z.coerce.number().min(0).optional(),
    search: z.string().max(80).optional(),
  });

  app.get("/v1/opportunities", async (req, res) => {
    try {
      const q = opportunitiesQuery.safeParse(req.query);
      if (!q.success) {
        throw new ArbError("VALIDATION_ERROR", "Invalid query parameters", 400, {
          issues: q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }
      const settings = deps.settings.get();
      const tradeSizeSol = q.data.tradeSizeSol ?? settings.defaultTradeSizeSol;
      const scored = await collectScoredTokens(deps, tradeSizeSol);
      const riskRank = { low: 0, medium: 1, high: 2 } as const;

      let items = scored;
      if (q.data.risk) {
        items = items.filter((s) => riskRank[s.scores.riskLevel] <= riskRank[q.data.risk!]);
      }
      if (q.data.minLiquidityUsd !== undefined) {
        const min = BigInt(Math.round(q.data.minLiquidityUsd)) * 1_000_000n;
        items = items.filter((s) => s.view.liquidity.value.totalUsdMicro >= min);
      }
      if (q.data.search) {
        const needle = q.data.search.toLowerCase();
        items = items.filter(
          (s) =>
            s.view.token.symbol.toLowerCase().includes(needle) ||
            s.view.token.name.toLowerCase().includes(needle) ||
            s.view.token.mint.toLowerCase().includes(needle),
        );
      }
      items.sort((a, b) => b.scores.opportunity.score - a.scores.opportunity.score);

      res.json({
        ...meta(deps),
        tradeSizeSol,
        count: items.length,
        opportunities: items.map(({ view, routes, scores }) => {
          const m = view.momentum.value;
          return {
            token: {
              mint: view.token.mint,
              symbol: view.token.symbol,
              name: view.token.name,
              emoji: view.token.emoji,
              ageDays: view.risk.value.tokenAgeDays,
            },
            priceUsd: picoUsdToPriceString(m.pricePicoUsd),
            change1hPct: pctStr(m.change1hBps),
            change24hPct: pctStr(m.change24hBps),
            volume1hUsd: microToUsdString(m.volume1hUsdMicro),
            volumeChange1hPct: pctStr(m.volumeChange1hBps),
            liquidityUsd: microToUsdString(view.liquidity.value.totalUsdMicro),
            dataAgeSeconds: Math.round(view.momentum.ageMs / 1000),
            dataReliability: view.momentum.reliability,
            scores: {
              momentum: scores.momentum.score,
              liquidity: scores.liquidity.score,
              execution: scores.execution.score,
              risk: scores.risk.score,
              opportunity: scores.opportunity.score,
            },
            riskLevel: scores.riskLevel,
            opportunityLabel: scores.opportunityLabel,
            whyRanks: scores.opportunity.factors.slice(0, 4),
            bestRoute: routes.best
              ? { venueName: routes.best.venueName, priceImpactPct: pctStr(routes.best.priceImpactBps) }
              : null,
            routeFailureCount: routes.failures.length,
            inWatchlist: settings.watchlist.includes(view.token.mint),
          };
        }),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Evaluate ----
  app.get("/v1/tokens/:mint", async (req, res) => {
    try {
      const settings = deps.settings.get();
      const tradeSizeSol = z.coerce.number().positive().max(1_000).default(settings.defaultTradeSizeSol).parse(req.query.tradeSizeSol ?? settings.defaultTradeSizeSol);
      const { view, routes, scores } = await scoreToken(deps, req.params.mint!, tradeSizeSol, settings);
      const m = view.momentum.value;
      const candles = await deps.market.getCandles(view.token.mint, 48, 30 * 60_000);

      // Round-trip estimate: what the tokens from the best buy would sell for now
      let roundTrip: Record<string, unknown> | null = null;
      if (routes.best) {
        const sell = await deps.market.getSellRoutes(view.token.mint, routes.best.outAmount, BigInt(settings.maxSlippageBps));
        if (sell.best) {
          roundTrip = {
            tokensOut: tokenUnitsToDisplay(routes.best.outAmount, view.token.decimals),
            estimatedSellBackSol: lamportsToSolString(sell.best.outAmount),
            sellVenue: sell.best.venueName,
            sellImpactPct: pctStr(sell.best.priceImpactBps),
          };
        }
      }

      res.json({
        ...meta(deps),
        tradeSizeSol,
        token: { ...view.token },
        market: {
          priceUsd: picoUsdToPriceString(m.pricePicoUsd),
          change5mPct: pctStr(m.change5mBps),
          change1hPct: pctStr(m.change1hBps),
          change24hPct: pctStr(m.change24hBps),
          volume1hUsd: microToUsdString(m.volume1hUsdMicro),
          volumeChange1hPct: pctStr(m.volumeChange1hBps),
          buySellRatio: (Number(m.buySellRatioPct) / 100).toFixed(2),
          txCount1h: m.txCount1h,
          liquidityUsd: microToUsdString(view.liquidity.value.totalUsdMicro),
          liquidityChange1hPct: pctStr(view.liquidity.value.change1hBps),
          topPoolSharePct: pctStr(view.liquidity.value.topPoolShareBps),
          solPriceUsd: microToUsdString(view.solPriceMicroUsd),
        },
        riskFacts: {
          tokenAgeDays: view.risk.value.tokenAgeDays,
          holderConcentrationPct: pctStr(view.risk.value.holderConcentrationBps),
          mintAuthorityRevoked: view.risk.value.mintAuthorityRevoked,
          freezeAuthorityRevoked: view.risk.value.freezeAuthorityRevoked,
          recentInsiderActivity: view.risk.value.recentInsiderActivity,
          dataComplete: view.risk.value.dataComplete,
        },
        freshness: [
          { field: "momentum", source: view.momentum.source, ageSeconds: Math.round(view.momentum.ageMs / 1000), reliability: view.momentum.reliability },
          { field: "liquidity", source: view.liquidity.source, ageSeconds: Math.round(view.liquidity.ageMs / 1000), reliability: view.liquidity.reliability },
          { field: "risk", source: view.risk.source, ageSeconds: Math.round(view.risk.ageMs / 1000), reliability: view.risk.reliability },
        ],
        scores: serializeScores(scores),
        routes: serializeComparison(routes, view.token.decimals),
        roundTrip,
        candles: candles.map((c) => ({
          t: c.tsMs,
          // Display-only float for charting; never used in calculations
          price: Number(c.closePicoUsd) / 1e12,
          volumeUsd: Number(c.volumeUsdMicro / 1_000_000n),
        })),
        inWatchlist: settings.watchlist.includes(view.token.mint),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Compare execution ----
  app.get("/v1/tokens/:mint/routes", async (req, res) => {
    try {
      const settings = deps.settings.get();
      const q = z
        .object({
          tradeSizeSol: z.coerce.number().positive().max(1_000).default(settings.defaultTradeSizeSol),
          slippageBps: z.coerce.number().int().min(1).max(2_000).default(settings.maxSlippageBps),
        })
        .parse(req.query);
      const view = await deps.market.getView(req.params.mint!);
      const lamports = solToLamports(q.tradeSizeSol);
      const routes = await deps.market.getBuyRoutes(view.token.mint, lamports, BigInt(q.slippageBps));
      if (!routes.best) {
        throw new ArbError("NO_QUOTE_AVAILABLE", "No venue returned an executable quote for this size", 502, {
          failures: routes.failures,
        });
      }
      res.json({
        ...meta(deps),
        tradeSizeSol: q.tradeSizeSol,
        slippagePct: pctStr(q.slippageBps),
        routes: serializeComparison(routes, view.token.decimals),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Paper trade ----
  const openSchema = z.object({
    tokenMint: z.string().min(32).max(64),
    solAmount: z.number().positive().max(1_000),
    slippageBps: z.number().int().min(1).max(2_000).optional(),
  });

  app.post("/v1/paper/positions", async (req, res) => {
    try {
      const parsed = openSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ArbError("VALIDATION_ERROR", "Invalid paper-trade request", 400, {
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }
      const settings = deps.settings.get();
      const position = await deps.engine.openPosition({
        tokenMint: parsed.data.tokenMint,
        solAmountLamports: solToLamports(parsed.data.solAmount),
        slippageBps: BigInt(parsed.data.slippageBps ?? settings.maxSlippageBps),
        limits: limitsFrom(settings),
      });
      res.status(201).json({
        simulated: true,
        notice: "Simulated trade only — no funds moved, no transaction sent.",
        position: serializePosition(position),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/v1/paper/positions/:id/close", async (req, res) => {
    try {
      const position = await deps.engine.closePosition(req.params.id!);
      res.json({
        simulated: true,
        notice: "Simulated close — valued at the current executable sell quote including impact, fees, and slippage.",
        position: serializePosition(position),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/v1/paper/portfolio", async (_req, res) => {
    try {
      const portfolio = await deps.engine.getPortfolio();
      res.json(serializePortfolio(portfolio));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Notifications ----
  app.get("/v1/notifications", (_req, res) => {
    res.json({
      unread: deps.notify.unreadCount(),
      notifications: deps.notify.list(),
    });
  });

  app.post("/v1/notifications/mark-read", (_req, res) => {
    deps.notify.markAllRead();
    res.json({ ok: true });
  });

  // ---- Settings & watchlist ----
  app.get("/v1/settings", (_req, res) => {
    res.json({ settings: deps.settings.get() });
  });

  app.put("/v1/settings", (req, res) => {
    try {
      const patch = settingsSchema.partial().safeParse(req.body);
      if (!patch.success) {
        throw new ArbError("VALIDATION_ERROR", "Invalid settings", 400, {
          issues: patch.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }
      res.json({ settings: deps.settings.update(patch.data) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/v1/watchlist", async (req, res) => {
    try {
      const parsed = z.object({ mint: z.string().min(32).max(64), watched: z.boolean() }).safeParse(req.body);
      if (!parsed.success) {
        throw new ArbError("VALIDATION_ERROR", "Invalid watchlist request", 400);
      }
      await deps.market.getView(parsed.data.mint); // 404 for unsupported mints
      const current = deps.settings.get().watchlist;
      const next = parsed.data.watched
        ? [...new Set([...current, parsed.data.mint])]
        : current.filter((m) => m !== parsed.data.mint);
      res.json({ settings: deps.settings.update({ watchlist: next }) });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Legacy arbitrage calculator (original add-on, kept working) ----
  app.use(createLegacyArbitrageRouter(deps.env.QUOTE_MODE === "mock", deps.env.ADMIN_TOKEN));

  // ---- Static frontends ----
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  app.use("/demo", express.static(join(rootDir, "demo")));
  app.use("/", express.static(join(rootDir, "web")));

  return app;
}

export function seedIfDemo(deps: AppDeps): void {
  if (deps.market.bundle.isDemo) {
    seedDemoState(deps.engine, deps.notify, deps.clock());
  }
}

// Keep Request import used (typing for handlers above)
export type { Request };
