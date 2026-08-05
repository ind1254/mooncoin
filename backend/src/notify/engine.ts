import { randomUUID } from "node:crypto";
import { lamportsToSolString } from "../core/money.js";
import type { TokenMarketView, RouteComparison } from "../market/types.js";
import type { TokenScores } from "../scoring/scores.js";
import { allowedRiskLevels, type UserSettings } from "../settings/settings.js";
import type { PaperPosition } from "../paper/types.js";

/**
 * In-app notification rules.
 *
 * Every notification explains WHY it fired, in plain language. Duplicates are
 * suppressed with per-key cooldowns and material-change tracking: a rule fires
 * on a state TRANSITION (didn't match → matches), never merely because a
 * condition remains true. Nothing here predicts returns or promises profit.
 */

export type NotificationCategory =
  | "opportunity_match"
  | "score_change"
  | "liquidity_drop"
  | "risk_increase"
  | "better_route"
  | "position_threshold"
  | "position_conditions";

export interface AppNotification {
  id: string;
  category: NotificationCategory;
  tokenMint?: string;
  tokenSymbol?: string;
  positionId?: string;
  title: string;
  /** Plain-language explanation of exactly why this fired. */
  reason: string;
  createdAtMs: number;
  read: boolean;
}

interface TokenTickInput {
  view: TokenMarketView;
  scores: TokenScores;
  routes: RouteComparison | null;
}

export interface NotificationTickInput {
  tokens: TokenTickInput[];
  openPositions: PaperPosition[];
  settings: UserSettings;
  nowMs: number;
}

const COOLDOWN_MS: Record<NotificationCategory, number> = {
  opportunity_match: 30 * 60_000,
  score_change: 15 * 60_000,
  liquidity_drop: 30 * 60_000,
  risk_increase: 30 * 60_000,
  better_route: 30 * 60_000,
  position_threshold: 60 * 60_000,
  position_conditions: 60 * 60_000,
};

const MATERIAL_SCORE_CHANGE = 15;
const LIQUIDITY_DROP_BPS = -1_000n; // -10% in an hour

export class NotificationEngine {
  private notifications: AppNotification[] = [];
  private cooldowns = new Map<string, number>();
  private lastScores = new Map<string, number>();
  private lastRiskLevel = new Map<string, string>();
  private lastBestVenue = new Map<string, string>();
  private wasMatching = new Set<string>();
  private thresholdFired = new Set<string>();

  list(): AppNotification[] {
    return this.notifications;
  }

  unreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }

  markAllRead(): void {
    for (const n of this.notifications) n.read = true;
  }

  /** Seed a pre-built notification (used by demo mode). */
  push(n: Omit<AppNotification, "id" | "read">): AppNotification {
    const full: AppNotification = { ...n, id: randomUUID(), read: false };
    this.notifications.unshift(full);
    this.notifications = this.notifications.slice(0, 100);
    return full;
  }

  private canFire(key: string, category: NotificationCategory, nowMs: number): boolean {
    const last = this.cooldowns.get(key);
    if (last !== undefined && nowMs - last < COOLDOWN_MS[category]) return false;
    this.cooldowns.set(key, nowMs);
    return true;
  }

  evaluate(input: NotificationTickInput): AppNotification[] {
    const created: AppNotification[] = [];
    const { settings, nowMs } = input;
    const allowed = allowedRiskLevels(settings.riskPreference);

    for (const { view, scores, routes } of input.tokens) {
      const mint = view.token.mint;
      const symbol = view.token.symbol;

      // 1. Opportunity now matches the user's settings (transition-based)
      const impactOk =
        routes?.best != null && Number(routes.best.priceImpactBps) <= settings.maxPriceImpactBps;
      const matches =
        scores.opportunity.score >= settings.minOpportunityScore &&
        allowed.has(scores.riskLevel) &&
        Number(view.liquidity.value.totalUsdMicro / 1_000_000n) >= settings.minLiquidityUsd &&
        view.risk.value.tokenAgeDays >= settings.minTokenAgeDays &&
        impactOk;

      if (matches && !this.wasMatching.has(mint)) {
        if (settings.notifications.opportunityMatch && this.canFire(`match:${mint}`, "opportunity_match", nowMs)) {
          const why = scores.opportunity.factors
            .filter((f) => f.direction === "positive")
            .slice(0, 2)
            .map((f) => f.detail.toLowerCase());
          created.push(
            this.push({
              category: "opportunity_match",
              tokenMint: mint,
              tokenSymbol: symbol,
              title: `${symbol} now matches your ${settings.riskPreference} strategy`,
              reason: `Opportunity quality is ${scores.opportunity.score}/100 with ${scores.riskLevel} risk${why.length ? ": " + why.join("; ") : ""}. Estimated price impact for ${settings.defaultTradeSizeSol} SOL is within your ${(settings.maxPriceImpactBps / 100).toFixed(1)}% limit. This describes current conditions, not a prediction.`,
              createdAtMs: nowMs,
            }),
          );
        }
      }
      if (matches) this.wasMatching.add(mint);
      else this.wasMatching.delete(mint);

      // 2. Material score change
      const last = this.lastScores.get(mint);
      if (last !== undefined && Math.abs(scores.opportunity.score - last) >= MATERIAL_SCORE_CHANGE) {
        if (settings.notifications.scoreChange && this.canFire(`score:${mint}`, "score_change", nowMs)) {
          const dir = scores.opportunity.score > last ? "improved" : "deteriorated";
          created.push(
            this.push({
              category: "score_change",
              tokenMint: mint,
              tokenSymbol: symbol,
              title: `${symbol} opportunity score ${dir}`,
              reason: `Score moved from ${last} to ${scores.opportunity.score} out of 100 since the last check — a material change under your alert threshold of ${MATERIAL_SCORE_CHANGE} points.`,
              createdAtMs: nowMs,
            }),
          );
        }
      }
      this.lastScores.set(mint, scores.opportunity.score);

      // 3. Sharp liquidity drop
      if (view.liquidity.value.change1hBps <= LIQUIDITY_DROP_BPS) {
        if (settings.notifications.liquidityDrop && this.canFire(`liq:${mint}`, "liquidity_drop", nowMs)) {
          created.push(
            this.push({
              category: "liquidity_drop",
              tokenMint: mint,
              tokenSymbol: symbol,
              title: `${symbol} liquidity is draining`,
              reason: `Liquidity fell ${(Math.abs(Number(view.liquidity.value.change1hBps)) / 100).toFixed(1)}% in the last hour. Exits may cost more than usual.`,
              createdAtMs: nowMs,
            }),
          );
        }
      }

      // 4. Risk level increased
      const lastRisk = this.lastRiskLevel.get(mint);
      const riskRank = { low: 0, medium: 1, high: 2 } as const;
      if (lastRisk !== undefined && riskRank[scores.riskLevel] > riskRank[lastRisk as keyof typeof riskRank]) {
        if (settings.notifications.riskIncrease && this.canFire(`risk:${mint}`, "risk_increase", nowMs)) {
          const drivers = scores.risk.factors
            .filter((f) => f.direction === "negative")
            .slice(0, 2)
            .map((f) => f.detail.toLowerCase())
            .join("; ");
          created.push(
            this.push({
              category: "risk_increase",
              tokenMint: mint,
              tokenSymbol: symbol,
              title: `${symbol} risk level rose to ${scores.riskLevel}`,
              reason: `Risk moved from ${lastRisk} to ${scores.riskLevel}${drivers ? ": " + drivers : ""}.`,
              createdAtMs: nowMs,
            }),
          );
        }
      }
      this.lastRiskLevel.set(mint, scores.riskLevel);

      // 5. Better execution route appeared
      if (routes?.best) {
        const lastVenue = this.lastBestVenue.get(mint);
        if (lastVenue !== undefined && lastVenue !== routes.best.venueId) {
          if (settings.notifications.betterRoute && this.canFire(`route:${mint}`, "better_route", nowMs)) {
            created.push(
              this.push({
                category: "better_route",
                tokenMint: mint,
                tokenSymbol: symbol,
                title: `Best route for ${symbol} changed`,
                reason: `${routes.best.venueName} now offers the best executable output for a ${settings.defaultTradeSizeSol} SOL simulated trade (previously ${lastVenue}). Estimated impact ${(Number(routes.best.priceImpactBps) / 100).toFixed(2)}%.`,
                createdAtMs: nowMs,
              }),
            );
          }
        }
        this.lastBestVenue.set(mint, routes.best.venueId);
      }
    }

    // 6. Paper position gain/loss thresholds + material condition changes
    for (const p of input.openPositions) {
      const gainLimitBps = BigInt(Math.round(settings.positionAlertGainPct * 100));
      const lossLimitBps = -BigInt(Math.round(settings.positionAlertLossPct * 100));

      const gainKey = `${p.id}:gain`;
      if (p.returnBps >= gainLimitBps && !this.thresholdFired.has(gainKey)) {
        this.thresholdFired.add(gainKey);
        if (settings.notifications.positionThreshold) {
          created.push(
            this.push({
              category: "position_threshold",
              positionId: p.id,
              tokenMint: p.tokenMint,
              tokenSymbol: p.tokenSymbol,
              title: `Paper ${p.tokenSymbol} position up ${(Number(p.returnBps) / 100).toFixed(1)}%`,
              reason: `Your simulated position (${lamportsToSolString(p.solSpentLamports)} SOL) crossed your +${settings.positionAlertGainPct}% alert threshold, valued with current executable sell quotes. Simulated result — not real funds.`,
              createdAtMs: nowMs,
            }),
          );
        }
      }
      const lossKey = `${p.id}:loss`;
      if (p.returnBps <= lossLimitBps && !this.thresholdFired.has(lossKey)) {
        this.thresholdFired.add(lossKey);
        if (settings.notifications.positionThreshold) {
          created.push(
            this.push({
              category: "position_threshold",
              positionId: p.id,
              tokenMint: p.tokenMint,
              tokenSymbol: p.tokenSymbol,
              title: `Paper ${p.tokenSymbol} position down ${(Math.abs(Number(p.returnBps)) / 100).toFixed(1)}%`,
              reason: `Your simulated position crossed your -${settings.positionAlertLossPct}% alert threshold, valued with current executable sell quotes. Simulated result — not real funds.`,
              createdAtMs: nowMs,
            }),
          );
        }
      }

      if (p.valuationStale && this.canFire(`stale:${p.id}`, "position_conditions", nowMs)) {
        created.push(
          this.push({
            category: "position_conditions",
            positionId: p.id,
            tokenMint: p.tokenMint,
            tokenSymbol: p.tokenSymbol,
            title: `Cannot value your ${p.tokenSymbol} paper position`,
            reason: "No fresh executable sell quote is available right now; the shown value is the last known one.",
            createdAtMs: nowMs,
          }),
        );
      }
    }

    return created;
  }
}
