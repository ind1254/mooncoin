import {
  DEMO_CREATED_AT,
  DEMO_SOL_PRICE_MICRO_USD,
  DEMO_TOKENS,
  DEMO_VENUES,
  type DemoTokenScenario,
} from "./demoData.js";
import { bucketOf, sampleRange } from "./prng.js";
import { applyHaircutFloor, divCeil, LAMPORTS_PER_SOL, PICO_USD } from "../core/money.js";
import type {
  Candle,
  LiquidityProvider,
  LiquiditySnapshot,
  MarketDataBundle,
  MarketPoint,
  MomentumSnapshot,
  PriceHistoryProvider,
  QuoteRoutingProvider,
  Reliability,
  RouteComparison,
  RouteQuote,
  TokenDiscoveryProvider,
  TokenInfo,
  TokenRiskFacts,
  TokenRiskProvider,
} from "./types.js";

/**
 * Deterministic demo market: every value is a pure function of
 * (scenario seed, timestamp bucket), so the same moment always replays
 * identically — the paper engine and tests rely on that. Prices tick on a
 * 30-second bucket so the demo feels alive without being random.
 *
 * Floats appear only while GENERATING simulated market data; everything
 * consumed downstream is bigint.
 */

const TICK_MS = 30_000;
const QUOTE_TTL_MS = 20_000;
const HOUR_MS = 3_600_000;

export const DEMO_SOURCE = "demo-simulator";

function scenarioOf(mint: string): DemoTokenScenario | undefined {
  return DEMO_TOKENS.find((t) => t.mint === mint);
}

/** Simulated mid price at a moment, pico-USD. Continuous & deterministic. */
export function demoPricePicoUsd(s: DemoTokenScenario, atMs: number): bigint {
  const phase = (k: string) => sampleRange(`${s.mint}:phase:${k}`, 0, Math.PI * 2);
  const wave = (periodMs: number, ampBps: number, k: string) =>
    Math.sin((atMs / periodMs) * Math.PI * 2 + phase(k)) * ampBps;

  // Trend: linear ramp across a 48h cycle so short-window changes carry its sign
  const cycle = 48 * HOUR_MS;
  const ramp = ((atMs % cycle) / cycle - 0.5) * 2; // -1..1
  const trend = s.trendBps * ramp;

  const totalBps =
    wave(6 * HOUR_MS, s.waveSlowBps, "slow") +
    wave(45 * 60_000, s.waveMediumBps, "med") +
    wave(4 * 60_000, s.waveFastBps, "fast") +
    trend;

  const factor = 1 + totalBps / 10_000;
  const pico = (s.basePricePicoUsd * BigInt(Math.round(factor * 1_000_000))) / 1_000_000n;
  return pico > 0n ? pico : 1n;
}

function changeBps(nowPico: bigint, thenPico: bigint): bigint {
  if (thenPico <= 0n) return 0n;
  return ((nowPico - thenPico) * 10_000n) / thenPico;
}

function reliabilityFor(ageMs: number, freshLimitMs: number): Reliability {
  return ageMs <= freshLimitMs ? "fresh" : "stale";
}

function point<T>(value: T, observedAtMs: number, nowMs: number, freshLimitMs: number): MarketPoint<T> {
  const ageMs = Math.max(0, nowMs - observedAtMs);
  return { value, source: DEMO_SOURCE, observedAtMs, ageMs, reliability: reliabilityFor(ageMs, freshLimitMs) };
}

/** Deterministic ±jitter of a bigint by up to `maxBps`, keyed per bucket. */
function jitter(value: bigint, maxBps: number, key: string): bigint {
  const bps = BigInt(Math.round(sampleRange(key, -maxBps, maxBps)));
  return value + (value * bps) / 10_000n;
}

export class DemoMarket
  implements TokenDiscoveryProvider, PriceHistoryProvider, LiquidityProvider, TokenRiskProvider, QuoteRoutingProvider
{
  readonly source = DEMO_SOURCE;

  constructor(private readonly clock: () => number = Date.now) {}

  private now(): number {
    return this.clock();
  }

  // ---- TokenDiscoveryProvider ----
  async listTokens(): Promise<TokenInfo[]> {
    return DEMO_TOKENS.map((s) => ({
      mint: s.mint,
      symbol: s.symbol,
      name: s.name,
      decimals: s.decimals,
      createdAtMs: DEMO_CREATED_AT[s.mint] ?? this.now(),
      emoji: s.emoji,
    }));
  }

  // ---- PriceHistoryProvider ----
  async getMomentum(mint: string): Promise<MarketPoint<MomentumSnapshot>> {
    const s = this.requireScenario(mint);
    const nowMs = this.now();
    const observedAt = nowMs - s.staleFeedMs;
    const bucket = bucketOf(observedAt, TICK_MS);

    const p = (offsetMs: number) => demoPricePicoUsd(s, observedAt - offsetMs);
    const current = p(0);

    const snapshot: MomentumSnapshot = {
      pricePicoUsd: current,
      change5mBps: changeBps(current, p(5 * 60_000)),
      change1hBps: changeBps(current, p(HOUR_MS)),
      change24hBps: changeBps(current, p(24 * HOUR_MS)),
      volume1hUsdMicro: jitter(s.volume1hUsdMicro, 800, `${mint}:vol:${bucket}`),
      volumeChange1hBps: jitter(s.volumeChange1hBps, 500, `${mint}:volchg:${bucket}`),
      buySellRatioPct: s.buySellRatioPct,
      txCount1h: Math.max(1, Math.round(s.txCount1h * sampleRange(`${mint}:tx:${bucket}`, 0.9, 1.1))),
    };
    return point(snapshot, observedAt, nowMs, 60_000);
  }

  async getCandles(mint: string, points: number, stepMs: number): Promise<Candle[]> {
    const s = this.requireScenario(mint);
    const nowMs = this.now();
    const candles: Candle[] = [];
    for (let i = points - 1; i >= 0; i--) {
      const end = nowMs - i * stepMs;
      const start = end - stepMs;
      const open = demoPricePicoUsd(s, start);
      const close = demoPricePicoUsd(s, end);
      const midA = demoPricePicoUsd(s, start + Math.floor(stepMs / 3));
      const midB = demoPricePicoUsd(s, start + Math.floor((2 * stepMs) / 3));
      const high = [open, close, midA, midB].reduce((a, b) => (b > a ? b : a));
      const low = [open, close, midA, midB].reduce((a, b) => (b < a ? b : a));
      const volume = jitter(s.volume1hUsdMicro / BigInt(Math.max(1, Math.round(HOUR_MS / stepMs))), 2_000, `${mint}:cvol:${bucketOf(end, stepMs)}`);
      candles.push({ tsMs: end, openPicoUsd: open, highPicoUsd: high, lowPicoUsd: low, closePicoUsd: close, volumeUsdMicro: volume });
    }
    return candles;
  }

  // ---- LiquidityProvider ----
  async getLiquidity(mint: string): Promise<MarketPoint<LiquiditySnapshot>> {
    const s = this.requireScenario(mint);
    const nowMs = this.now();
    const bucket = bucketOf(nowMs, TICK_MS);
    const snapshot: LiquiditySnapshot = {
      totalUsdMicro: jitter(s.liquidityUsdMicro, 150, `${mint}:liq:${bucket}`),
      change1hBps: s.liquidityChange1hBps,
      topPoolShareBps: s.topPoolShareBps,
    };
    return point(snapshot, nowMs - 8_000, nowMs, 60_000);
  }

  // ---- TokenRiskProvider ----
  async getRiskFacts(mint: string): Promise<MarketPoint<TokenRiskFacts>> {
    const s = this.requireScenario(mint);
    const nowMs = this.now();
    const facts: TokenRiskFacts = {
      tokenAgeDays: s.tokenAgeDays,
      holderConcentrationBps: s.holderConcentrationBps,
      mintAuthorityRevoked: s.mintAuthorityRevoked,
      freezeAuthorityRevoked: s.freezeAuthorityRevoked,
      recentInsiderActivity: s.recentInsiderActivity,
      dataComplete: s.riskDataComplete,
    };
    return point(facts, nowMs - 120_000, nowMs, 30 * 60_000);
  }

  // ---- QuoteRoutingProvider ----
  async getSolPriceMicroUsd(): Promise<bigint> {
    const t = this.now();
    const wave = Math.sin((t / (2 * HOUR_MS)) * Math.PI * 2) * 300; // ±3%
    return (DEMO_SOL_PRICE_MICRO_USD * BigInt(Math.round((1 + wave / 10_000) * 1_000_000))) / 1_000_000n;
  }

  async getBuyRoutes(mint: string, lamportsIn: bigint, slippageBps: bigint): Promise<RouteComparison> {
    return this.routes(mint, "buy", lamportsIn, slippageBps);
  }

  async getSellRoutes(mint: string, tokenUnitsIn: bigint, slippageBps: bigint): Promise<RouteComparison> {
    return this.routes(mint, "sell", tokenUnitsIn, slippageBps);
  }

  private async routes(
    mint: string,
    side: "buy" | "sell",
    amountIn: bigint,
    slippageBps: bigint,
  ): Promise<RouteComparison> {
    const s = this.requireScenario(mint);
    if (amountIn <= 0n) {
      throw new RangeError("amountIn must be positive");
    }
    const nowMs = this.now();
    const bucket = bucketOf(nowMs, TICK_MS);
    const solPriceMicro = await this.getSolPriceMicroUsd();
    const liquidity = (await this.getLiquidity(mint)).value.totalUsdMicro;
    const tokenScale = 10n ** BigInt(s.decimals);

    const quotes: RouteQuote[] = [];
    const failures: RouteComparison["failures"] = [];

    for (const venue of DEMO_VENUES) {
      if (s.missingVenues.includes(venue.id)) {
        failures.push({ venueId: venue.id, code: "NO_ROUTE", message: `${venue.name} has no pool for ${s.symbol}` });
        continue;
      }
      const offsetBps = BigInt(Math.round(sampleRange(`${mint}:${venue.id}:offset:${bucket}`, -18, 18)));
      const midPico = demoPricePicoUsd(s, nowMs);
      const venuePricePico = midPico + (midPico * offsetBps) / 10_000n;
      const venueLiqMicro = (liquidity * venue.liquidityShareBps) / 10_000n;

      // Congestion-driven priority fee, deterministic per bucket
      const priorityFee = BigInt(Math.round(sampleRange(`prio:${bucket}`, 80_000, 900_000)));
      const networkFee = 5_000n;

      if (side === "buy") {
        const usdMicroIn = (amountIn * solPriceMicro) / LAMPORTS_PER_SOL;
        const impactBps = clampBps(divCeil(usdMicroIn * 2n * 10_000n, venueLiqMicro));
        const grossTokens = (usdMicroIn * 1_000_000n * tokenScale) / venuePricePico;
        const afterFee = applyHaircutFloor(grossTokens, venue.routeFeeBps);
        const out = applyHaircutFloor(afterFee, impactBps);
        if (out <= 0n) {
          failures.push({ venueId: venue.id, code: "NO_QUOTE", message: `${venue.name} could not fill this size` });
          continue;
        }
        quotes.push({
          venueId: venue.id,
          venueName: venue.name,
          side,
          tokenMint: mint,
          inAmount: amountIn,
          outAmount: out,
          minReceived: applyHaircutFloor(out, slippageBps),
          effectivePricePicoUsd: (usdMicroIn * 1_000_000n * tokenScale) / out,
          priceImpactBps: impactBps,
          routeFeeBps: venue.routeFeeBps,
          networkFeeLamports: networkFee,
          priorityFeeLamports: priorityFee,
          slippageBps,
          retrievedAtMs: nowMs,
          expiresAtMs: nowMs + QUOTE_TTL_MS,
          source: DEMO_SOURCE,
        });
      } else {
        const usdMicroGross = (amountIn * venuePricePico) / tokenScale / 1_000_000n;
        const impactBps = clampBps(divCeil(usdMicroGross * 2n * 10_000n, venueLiqMicro));
        const afterFee = applyHaircutFloor(usdMicroGross, venue.routeFeeBps);
        const usdMicroOut = applyHaircutFloor(afterFee, impactBps);
        const lamportsGross = (usdMicroOut * LAMPORTS_PER_SOL) / solPriceMicro;
        const out = lamportsGross - networkFee - priorityFee;
        if (out <= 0n) {
          failures.push({ venueId: venue.id, code: "NO_QUOTE", message: `${venue.name} proceeds would not cover fees` });
          continue;
        }
        quotes.push({
          venueId: venue.id,
          venueName: venue.name,
          side,
          tokenMint: mint,
          inAmount: amountIn,
          outAmount: out,
          minReceived: applyHaircutFloor(out, slippageBps),
          effectivePricePicoUsd: (usdMicroGross * 1_000_000n * tokenScale) / amountIn,
          priceImpactBps: impactBps,
          routeFeeBps: venue.routeFeeBps,
          networkFeeLamports: networkFee,
          priorityFeeLamports: priorityFee,
          slippageBps,
          retrievedAtMs: nowMs,
          expiresAtMs: nowMs + QUOTE_TTL_MS,
          source: DEMO_SOURCE,
        });
      }
    }

    if (quotes.length === 0) {
      return { best: null, alternatives: [], failures };
    }
    quotes.sort((a, b) => (b.outAmount > a.outAmount ? 1 : b.outAmount < a.outAmount ? -1 : 0));
    return { best: quotes[0]!, alternatives: quotes.slice(1), failures };
  }

  private requireScenario(mint: string): DemoTokenScenario {
    const s = scenarioOf(mint);
    if (!s) {
      const err = new Error(`Unsupported token mint: ${mint}`);
      (err as Error & { code?: string }).code = "UNSUPPORTED_TOKEN";
      throw err;
    }
    return s;
  }
}

function clampBps(bps: bigint): bigint {
  if (bps < 1n) return 1n;
  if (bps > 9_999n) return 9_999n;
  return bps;
}

export function createDemoBundle(clock: () => number = Date.now): MarketDataBundle {
  const demo = new DemoMarket(clock);
  return {
    discovery: demo,
    history: demo,
    liquidity: demo,
    riskFacts: demo,
    routing: demo,
    dataSourceLabel: "Demonstration data (deterministic simulation)",
    isDemo: true,
  };
}
