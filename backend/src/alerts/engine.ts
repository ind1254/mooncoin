/**
 * Alert evaluation.
 *
 * Pure: no network, no database, no clock of its own. Everything it needs
 * arrives as arguments, which is what makes the firing rules — the part that
 * decides whether someone's phone buzzes at 3am — testable without a worker,
 * a database, or a live market.
 *
 * Three rules govern every alert here, and they are the difference between a
 * product people keep and one they mute:
 *
 *  1. TRANSITION, NOT STATE. A rule fires when a condition becomes true, never
 *     because it is still true. "Liquidity below $10k" on a dead token would
 *     otherwise fire every evaluation, forever.
 *
 *  2. UNAVAILABLE IS NOT "NO". When an input is missing we do not evaluate at
 *     all and we leave prior state untouched. Treating missing data as "does
 *     not match" would reset the transition flag, so the next successful read
 *     would look like a fresh crossing and fire a duplicate.
 *
 *  3. COOLDOWN EVEN ON A GENUINE CROSSING. A value oscillating around a
 *     threshold produces real transitions every few seconds. The cooldown is
 *     what stops honest volatility from becoming spam.
 *
 * Nothing here predicts anything. Titles state what happened; reasons state
 * what it may mean, kept separate, in the same voice as the research page.
 */

export type AlertKind =
  | "price_change"
  | "liquidity_drop"
  | "volume_spike"
  | "holder_concentration"
  | "authority_change"
  | "route_unavailable";

export type AlertDirection = "above" | "below";
export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertRule {
  id: string;
  userId: string;
  scope: "watchlist" | "mint";
  mint: string | null;
  kind: AlertKind;
  /** Basis points. Null for the boolean kinds, which have nothing to compare. */
  thresholdBps: bigint | null;
  direction: AlertDirection | null;
  cooldownSeconds: number;
  enabled: boolean;
}

/** What we last knew about this rule for this mint. */
export interface AlertRuleState {
  matched: boolean;
  lastValueBps: bigint | null;
  lastFiredAtMs: number | null;
}

/**
 * One token's current facts, normalized. Every field is nullable because every
 * field genuinely can be unavailable, and the engine must behave differently
 * when it is.
 */
export interface AlertObservation {
  mint: string;
  symbol: string | null;
  /** Signed. 5-minute price change, bps. */
  priceChange5mBps: bigint | null;
  /** Signed. 1-hour liquidity change, bps. Negative means draining. */
  liquidityChange1hBps: bigint | null;
  /** Signed. 5-minute volume change, bps. */
  volumeChange5mBps: bigint | null;
  /** Wallet-held share of supply, bps. On-chain where we could measure it. */
  holderConcentrationBps: bigint | null;
  /** Null when the mint account could not be read. */
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  /** Whether an executable route existed at the last check. */
  routeAvailable: boolean | null;
}

export interface FiredAlert {
  ruleId: string;
  userId: string;
  mint: string;
  symbol: string | null;
  kind: AlertKind;
  title: string;
  reason: string;
  severity: AlertSeverity;
  valueBps: bigint | null;
}

export interface EvaluationResult {
  /** Null when nothing should be delivered. */
  fired: FiredAlert | null;
  /**
   * Null means "leave stored state exactly as it is" — used when the input
   * was unavailable. Distinct from a state whose `matched` is false, which is
   * a real observation that the condition does not hold.
   */
  nextState: AlertRuleState | null;
}

const pct = (bps: bigint): string => {
  const value = Number(bps) / 100;
  return `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(1)}%`;
};

/** What the rule compares, and whether it currently holds. */
interface Comparison {
  valueBps: bigint | null;
  matched: boolean;
  title: string;
  reason: string;
  severity: AlertSeverity;
}

function compare(rule: AlertRule, obs: AlertObservation): Comparison | null {
  const symbol = obs.symbol ?? "This token";

  switch (rule.kind) {
    case "price_change": {
      if (obs.priceChange5mBps === null || rule.thresholdBps === null) return null;
      const value = obs.priceChange5mBps;
      // "above" watches for a rise, "below" for a fall. A fall is a negative
      // number, so the threshold is negated rather than compared by magnitude.
      const matched =
        rule.direction === "below" ? value <= -rule.thresholdBps : value >= rule.thresholdBps;
      return {
        valueBps: value,
        matched,
        title: `${symbol} moved ${pct(value)} in 5 minutes`,
        reason: `The price changed by ${pct(value)} over the last five minutes, crossing your ${pct(rule.thresholdBps)} threshold. This describes what happened, not what happens next.`,
        severity: "info",
      };
    }

    case "liquidity_drop": {
      if (obs.liquidityChange1hBps === null || rule.thresholdBps === null) return null;
      // Only drains matter here, so a rise is recorded as a zero-size drop
      // rather than as a negative one that could satisfy a comparison.
      const drop = obs.liquidityChange1hBps < 0n ? -obs.liquidityChange1hBps : 0n;
      return {
        valueBps: drop,
        matched: drop >= rule.thresholdBps,
        title: `${symbol} liquidity fell ${pct(drop)}`,
        reason: `Liquidity dropped ${pct(drop)} in the last hour. Less liquidity means exits cost more, and a large trade moves the price further.`,
        severity: drop >= 5000n ? "critical" : "warning",
      };
    }

    case "volume_spike": {
      if (obs.volumeChange5mBps === null || rule.thresholdBps === null) return null;
      const value = obs.volumeChange5mBps;
      return {
        valueBps: value,
        matched: value >= rule.thresholdBps,
        title: `${symbol} volume up ${pct(value)}`,
        reason: `Trading volume rose ${pct(value)} over five minutes. Activity is increasing; it does not indicate direction.`,
        severity: "info",
      };
    }

    case "holder_concentration": {
      if (obs.holderConcentrationBps === null || rule.thresholdBps === null) return null;
      const value = obs.holderConcentrationBps;
      const matched =
        rule.direction === "below" ? value <= rule.thresholdBps : value >= rule.thresholdBps;
      return {
        valueBps: value,
        matched,
        title: `${symbol} wallet concentration at ${pct(value)}`,
        reason: `Wallet holders control ${pct(value)} of supply, excluding pools and bonding curves. A smaller group holding more supply can move the price further by selling.`,
        severity: value >= 5000n ? "warning" : "info",
      };
    }

    case "authority_change": {
      if (obs.mintAuthorityRevoked === null || obs.freezeAuthorityRevoked === null) return null;
      // On Solana an authority can be set to None but never restored, so the
      // only transition this can observe is renouncement. That makes this a
      // positive signal rather than a warning — and it is why the rule is
      // phrased as "renounced" instead of the more obvious "changed".
      const bothRevoked = obs.mintAuthorityRevoked && obs.freezeAuthorityRevoked;
      return {
        valueBps: null,
        matched: bothRevoked,
        title: `${symbol} authorities renounced`,
        reason: `Both the mint and freeze authorities are now revoked on-chain. New supply cannot be minted through the original authority, and balances cannot be frozen by it.`,
        severity: "info",
      };
    }

    case "route_unavailable": {
      if (obs.routeAvailable === null) return null;
      return {
        valueBps: null,
        matched: !obs.routeAvailable,
        title: `${symbol} has no executable route`,
        reason: `No route was available for a standard trade size at the last check. That usually means liquidity has been removed or the pool is unreachable.`,
        severity: "critical",
      };
    }
  }
}

/**
 * Evaluate one rule against one token.
 *
 * `prior` is whatever was stored for this (rule, mint) pair, or null the first
 * time we ever see it. A first sighting that already matches DOES fire: the
 * user asked to be told about this condition, and staying silent because we
 * happened to start watching late would be the wrong failure.
 */
export function evaluateRule(
  rule: AlertRule,
  obs: AlertObservation,
  prior: AlertRuleState | null,
  nowMs: number,
): EvaluationResult {
  if (!rule.enabled) return { fired: null, nextState: null };

  const result = compare(rule, obs);
  // Input unavailable. Do not evaluate, and above all do not record a
  // non-match: that would clear the transition flag and make the next good
  // read look like a fresh crossing.
  if (result === null) return { fired: null, nextState: null };

  const wasMatched = prior?.matched ?? false;
  const lastFiredAtMs = prior?.lastFiredAtMs ?? null;
  const cooledDown =
    lastFiredAtMs === null || nowMs - lastFiredAtMs >= rule.cooldownSeconds * 1_000;

  const isTransition = result.matched && !wasMatched;
  const shouldFire = isTransition && cooledDown;

  return {
    fired: shouldFire
      ? {
          ruleId: rule.id,
          userId: rule.userId,
          mint: obs.mint,
          symbol: obs.symbol,
          kind: rule.kind,
          title: result.title,
          reason: result.reason,
          severity: result.severity,
          valueBps: result.valueBps,
        }
      : null,
    nextState: {
      matched: result.matched,
      lastValueBps: result.valueBps,
      // Only advance the cooldown clock when something was actually sent.
      lastFiredAtMs: shouldFire ? nowMs : lastFiredAtMs,
    },
  };
}

/** Whether `nowMs` falls inside a user's quiet hours, which may wrap midnight. */
export function inQuietHours(
  nowMs: number,
  startMin: number | null,
  endMin: number | null,
): boolean {
  if (startMin === null || endMin === null) return false;
  const d = new Date(nowMs);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  // A range that wraps midnight (22:00 -> 06:00) is two intervals, not one.
  return startMin <= endMin
    ? minute >= startMin && minute < endMin
    : minute >= startMin || minute < endMin;
}
