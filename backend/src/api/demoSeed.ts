import { randomUUID } from "node:crypto";
import { LAMPORTS_PER_SOL } from "../core/money.js";
import { DEMO_TOKENS } from "../market/demoData.js";
import { demoPricePicoUsd } from "../market/demoProviders.js";
import type { NotificationEngine } from "../notify/engine.js";
import type { PaperTradingEngine } from "../paper/engine.js";
import type { PaperPosition } from "../paper/types.js";

/**
 * Seeds the demo-mode portfolio the first time the app starts so reviewers
 * immediately see every product state:
 *   - one OPEN paper position (WIF, opened ~2h ago)
 *   - one PROFITABLE closed paper trade (BONK)
 *   - one LOSING closed paper trade (FLOOF — the high-risk demo token)
 *   - one notification explaining why it fired
 * All values are derived from the same deterministic price simulation the
 * live endpoints use, so the numbers stay internally consistent.
 */

const HOUR = 3_600_000;

function scenario(symbol: string) {
  const s = DEMO_TOKENS.find((t) => t.symbol === symbol);
  if (!s) throw new Error(`demo scenario missing: ${symbol}`);
  return s;
}

/** Simulated tokens bought with `sol` at time `atMs`, net of ~0.6% costs. */
function tokensFor(symbol: string, solLamports: bigint, atMs: number, solPriceMicro: bigint): bigint {
  const s = scenario(symbol);
  const price = demoPricePicoUsd(s, atMs);
  const usdMicro = (solLamports * solPriceMicro) / LAMPORTS_PER_SOL;
  const gross = (usdMicro * 1_000_000n * 10n ** BigInt(s.decimals)) / price;
  return (gross * 9_940n) / 10_000n;
}

export function seedDemoState(engine: PaperTradingEngine, notify: NotificationEngine, nowMs: number): void {
  const state = engine.getState();
  if (state.positions.length > 0) return; // only seed a fresh install

  const solPriceMicro = 150_000_000n;
  const sol = (n: number) => BigInt(n) * LAMPORTS_PER_SOL;

  const base = {
    executionMode: "paper" as const,
    slippageBps: 100n,
    valuationStale: false,
  };

  // --- Open WIF position, entered 2h ago with 10 SOL ---
  const wif = scenario("WIF");
  const wifOpenedAt = nowMs - 2 * HOUR;
  const wifTokens = tokensFor("WIF", sol(10), wifOpenedAt, solPriceMicro);
  const wifFees = 620_000n;
  const wifCost = sol(10) + wifFees;
  const openPosition: PaperPosition = {
    ...base,
    id: randomUUID(),
    tokenMint: wif.mint,
    tokenSymbol: wif.symbol,
    tokenDecimals: wif.decimals,
    status: "open",
    openedAtMs: wifOpenedAt,
    entryVenueId: "raydium",
    entryVenueName: "Raydium",
    entryPricePicoUsd: demoPricePicoUsd(wif, wifOpenedAt),
    solSpentLamports: sol(10),
    entryNetworkFeeLamports: wifFees,
    totalCostLamports: wifCost,
    tokensReceived: wifTokens,
    entryImpactBps: 4n,
    entryRouteFeeBps: 25n,
    entryConditions: {
      opportunityScore: 58,
      riskScore: 24,
      riskLevel: "low",
      liquidityUsdMicro: wif.liquidityUsdMicro,
      change1hBps: 40n,
      solPriceMicroUsd: solPriceMicro,
    },
    currentValueLamports: sol(10),
    unrealizedPnlLamports: -wifFees,
    returnBps: -6n,
    highWaterLamports: sol(10),
    lowWaterLamports: sol(10),
    lastValuedAtMs: wifOpenedAt,
  };

  // --- Closed profitable BONK trade: 12 SOL in, +8.4% out ---
  const bonk = scenario("BONK");
  const bonkOpenedAt = nowMs - 26 * HOUR;
  const bonkClosedAt = nowMs - 20 * HOUR;
  const bonkFees = 590_000n;
  const bonkCost = sol(12) + bonkFees;
  const bonkExit = (bonkCost * 10_840n) / 10_000n;
  const closedWin: PaperPosition = {
    ...base,
    id: randomUUID(),
    tokenMint: bonk.mint,
    tokenSymbol: bonk.symbol,
    tokenDecimals: bonk.decimals,
    status: "closed",
    openedAtMs: bonkOpenedAt,
    entryVenueId: "raydium",
    entryVenueName: "Raydium",
    entryPricePicoUsd: demoPricePicoUsd(bonk, bonkOpenedAt),
    solSpentLamports: sol(12),
    entryNetworkFeeLamports: bonkFees,
    totalCostLamports: bonkCost,
    tokensReceived: tokensFor("BONK", sol(12), bonkOpenedAt, solPriceMicro),
    entryImpactBps: 3n,
    entryRouteFeeBps: 25n,
    entryConditions: {
      opportunityScore: 74,
      riskScore: 18,
      riskLevel: "low",
      liquidityUsdMicro: bonk.liquidityUsdMicro,
      change1hBps: 210n,
      solPriceMicroUsd: solPriceMicro,
    },
    currentValueLamports: bonkExit,
    unrealizedPnlLamports: 0n,
    returnBps: 840n,
    highWaterLamports: (bonkCost * 10_910n) / 10_000n,
    lowWaterLamports: (bonkCost * 9_960n) / 10_000n,
    lastValuedAtMs: bonkClosedAt,
    closedAtMs: bonkClosedAt,
    exitVenueId: "orca",
    exitVenueName: "Orca",
    exitValueLamports: bonkExit,
    exitNetworkFeeLamports: 480_000n,
    exitImpactBps: 4n,
    realizedPnlLamports: bonkExit - bonkCost,
  };

  // --- Closed losing FLOOF trade: chased the pump, -23.5% ---
  const floof = scenario("FLOOF");
  const floofOpenedAt = nowMs - 9 * HOUR;
  const floofClosedAt = nowMs - 5 * HOUR;
  const floofFees = 710_000n;
  const floofCost = sol(3) + floofFees;
  const floofExit = (floofCost * 7_650n) / 10_000n;
  const closedLoss: PaperPosition = {
    ...base,
    id: randomUUID(),
    tokenMint: floof.mint,
    tokenSymbol: floof.symbol,
    tokenDecimals: floof.decimals,
    status: "closed",
    openedAtMs: floofOpenedAt,
    entryVenueId: "raydium",
    entryVenueName: "Raydium",
    entryPricePicoUsd: demoPricePicoUsd(floof, floofOpenedAt),
    solSpentLamports: sol(3),
    entryNetworkFeeLamports: floofFees,
    totalCostLamports: floofCost,
    tokensReceived: tokensFor("FLOOF", sol(3), floofOpenedAt, solPriceMicro),
    entryImpactBps: 780n,
    entryRouteFeeBps: 25n,
    entryConditions: {
      opportunityScore: 33,
      riskScore: 82,
      riskLevel: "high",
      liquidityUsdMicro: floof.liquidityUsdMicro,
      change1hBps: 2_600n,
      solPriceMicroUsd: solPriceMicro,
    },
    currentValueLamports: floofExit,
    unrealizedPnlLamports: 0n,
    returnBps: -2_350n,
    highWaterLamports: (floofCost * 10_600n) / 10_000n,
    lowWaterLamports: (floofCost * 7_400n) / 10_000n,
    lastValuedAtMs: floofClosedAt,
    closedAtMs: floofClosedAt,
    exitVenueId: "raydium",
    exitVenueName: "Raydium",
    exitValueLamports: floofExit,
    exitNetworkFeeLamports: 830_000n,
    exitImpactBps: 940n,
    realizedPnlLamports: floofExit - floofCost,
  };

  // Cash bookkeeping stays exact: starting − all costs + closed proceeds
  const starting = state.startingBalanceLamports;
  const cash = starting - wifCost - bonkCost - floofCost + bonkExit + floofExit;

  engine.replaceState({
    startingBalanceLamports: starting,
    cashLamports: cash,
    positions: [openPosition, closedWin, closedLoss],
  });

  notify.push({
    category: "opportunity_match",
    tokenMint: bonk.mint,
    tokenSymbol: "BONK",
    title: "BONK now matches your balanced strategy",
    reason:
      "Opportunity quality is high with low risk: trading volume is up sharply versus the previous hour, liquidity is deep and stable, and estimated price impact for a 10 SOL paper trade is below your 1% limit. This describes current conditions, not a prediction.",
    createdAtMs: nowMs - 35 * 60_000,
  });
}
