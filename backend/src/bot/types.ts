export const PAPER_BOT_STRATEGY_VERSION = "shadow-v1" as const;

export interface PaperBotStrategyConfig {
  tradeSizeMicroUsd: bigint;
  minQualityScore: number;
  maxRiskScore: number;
  minLiquidityMicroUsd: bigint;
  maxPriceImpactBps: bigint;
  slippageBps: bigint;
  maxOpenPositions: number;
  takeProfitBps: bigint;
  stopLossBps: bigint;
  trailingStopBps: bigint;
  maxHoldMinutes: number;
  cooldownMinutes: number;
}

export interface PaperBotConfigRecord extends PaperBotStrategyConfig {
  id: string;
  userId: string;
  enabled: boolean;
  strategyVersion: typeof PAPER_BOT_STRATEGY_VERSION;
  lastRunAtMs: number | null;
  lastRunStatus: "ok" | "degraded" | "error" | null;
  lastRunSummary: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export type PaperBotDecisionAction =
  | "opened"
  | "entry_rejected"
  | "closed"
  | "exit_unavailable"
  | "scan_empty"
  | "error";

export interface PaperBotDecisionRecord {
  id: string;
  configId: string;
  positionId: string | null;
  tokenMint: string | null;
  tokenSymbol: string | null;
  action: PaperBotDecisionAction;
  qualityScore: number | null;
  riskScore: number | null;
  reason: string;
  snapshot: Record<string, unknown>;
  createdAtMs: number;
}

export interface CreatePaperBotDecisionInput {
  configId: string;
  positionId?: string | null;
  tokenMint?: string | null;
  tokenSymbol?: string | null;
  action: PaperBotDecisionAction;
  qualityScore?: number | null;
  riskScore?: number | null;
  reason: string;
  snapshot?: Record<string, unknown>;
  createdAtMs: number;
}

export interface PaperBotPositionStateRecord {
  positionId: string;
  configId: string;
  highWaterValueMicroUsd: bigint;
  lastValueMicroUsd: bigint | null;
  lastEvaluatedAtMs: number | null;
  exitReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}
