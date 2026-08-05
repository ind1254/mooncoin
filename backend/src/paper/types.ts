import type { RiskLevel } from "../scoring/scores.js";

/**
 * Paper-trading domain types. Everything here is SIMULATED — no transaction
 * is ever built, signed, or submitted, and executionMode is fixed to "paper".
 * bigint money fields are serialized as strings in the JSON store.
 */

export type PositionStatus = "open" | "closed";

export interface EntryConditionsSnapshot {
  opportunityScore: number;
  riskScore: number;
  riskLevel: RiskLevel;
  liquidityUsdMicro: bigint;
  change1hBps: bigint;
  solPriceMicroUsd: bigint;
}

export interface PaperPosition {
  id: string;
  tokenMint: string;
  /** Display only — identity is always the mint. */
  tokenSymbol: string;
  tokenDecimals: number;
  status: PositionStatus;
  executionMode: "paper"; // fixed — no live mode exists

  openedAtMs: number;
  entryVenueId: string;
  entryVenueName: string;
  entryPricePicoUsd: bigint;
  solSpentLamports: bigint; // swap input
  entryNetworkFeeLamports: bigint; // network + priority, paid on top
  totalCostLamports: bigint; // solSpent + entry fees
  tokensReceived: bigint;
  entryImpactBps: bigint;
  entryRouteFeeBps: bigint;
  slippageBps: bigint;
  entryConditions: EntryConditionsSnapshot;

  /** Revalued from the current best executable sell quote. */
  currentValueLamports: bigint;
  unrealizedPnlLamports: bigint;
  returnBps: bigint;
  highWaterLamports: bigint;
  lowWaterLamports: bigint;
  /** Set when the latest revaluation could not get a fresh quote. */
  valuationStale: boolean;
  lastValuedAtMs: number;

  closedAtMs?: number;
  exitVenueId?: string;
  exitVenueName?: string;
  exitValueLamports?: bigint;
  exitNetworkFeeLamports?: bigint;
  exitImpactBps?: bigint;
  realizedPnlLamports?: bigint;
}

export interface PortfolioStats {
  totalTrades: number;
  openCount: number;
  closedCount: number;
  winCount: number;
  lossCount: number;
  /** Percent of closed trades with positive realized PnL, 0-100. */
  winRatePct: number;
  totalRealizedPnlLamports: bigint;
  totalUnrealizedPnlLamports: bigint;
  avgGainBps: bigint;
  avgLossBps: bigint;
  bestTradeBps: bigint;
  worstTradeBps: bigint;
  totalNetworkFeesLamports: bigint;
  /** Average combined route fee + price impact across entries/exits, bps. */
  avgExecutionCostBps: bigint;
  byRiskLevel: Record<RiskLevel, { trades: number; realizedPnlLamports: bigint; winRatePct: number }>;
}

export interface Portfolio {
  simulated: true;
  startingBalanceLamports: bigint;
  cashLamports: bigint;
  openPositions: PaperPosition[];
  closedPositions: PaperPosition[];
  /** cash + sum of open position current values. */
  totalValueLamports: bigint;
  stats: PortfolioStats;
}
