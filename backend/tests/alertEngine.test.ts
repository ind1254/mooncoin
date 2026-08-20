import { describe, expect, it } from "vitest";
import {
  evaluateRule,
  inQuietHours,
  type AlertObservation,
  type AlertRule,
  type AlertRuleState,
} from "../src/alerts/engine.js";

/**
 * The firing rules decide whether someone's phone buzzes at 3am, so they are
 * tested as behaviour rather than as branches: the same rule evaluated over a
 * sequence of observations, asserting how many alerts a user actually receives.
 */

const NOW = 1_760_000_000_000;
const MINUTE = 60_000;

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "rule-1",
  userId: "user-1",
  scope: "watchlist",
  mint: null,
  kind: "liquidity_drop",
  thresholdBps: 2000n,
  direction: null,
  cooldownSeconds: 3600,
  enabled: true,
  ...over,
});

const obs = (over: Partial<AlertObservation> = {}): AlertObservation => ({
  mint: "MintA",
  symbol: "FLOOF",
  intervalMs: 60_000,
  priceChangeBps: null,
  liquidityChangeBps: null,
  volumeChangeBps: null,
  holderConcentrationBps: null,
  mintAuthorityRevoked: null,
  freezeAuthorityRevoked: null,
  routeAvailable: null,
  ...over,
});

/** Feed a sequence of observations through one rule, carrying state forward. */
function run(
  r: AlertRule,
  steps: { obs: AlertObservation; atMs: number }[],
): { fires: number; titles: string[]; finalState: AlertRuleState | null } {
  let state: AlertRuleState | null = null;
  let fires = 0;
  const titles: string[] = [];

  for (const step of steps) {
    const result = evaluateRule(r, step.obs, state, step.atMs);
    if (result.fired) {
      fires += 1;
      titles.push(result.fired.title);
    }
    if (result.nextState !== null) state = result.nextState;
  }
  return { fires, titles, finalState: state };
}

describe("alert firing — transition, not state", () => {
  it("fires once when a condition begins, not on every evaluation after", () => {
    // The defining behaviour. A dead token sitting below the threshold must
    // not generate an alert every 30 seconds for the rest of its life.
    const drained = obs({ liquidityChangeBps: -3000n });
    const steps = Array.from({ length: 20 }, (_, i) => ({ obs: drained, atMs: NOW + i * 30_000 }));

    expect(run(rule(), steps).fires).toBe(1);
  });

  it("fires again after the condition clears and returns", () => {
    const steps = [
      { obs: obs({ liquidityChangeBps: -3000n }), atMs: NOW },
      { obs: obs({ liquidityChangeBps: 500n }), atMs: NOW + 2 * 3600_000 }, // recovered
      { obs: obs({ liquidityChangeBps: -3000n }), atMs: NOW + 4 * 3600_000 }, // drained again
    ];
    expect(run(rule(), steps).fires).toBe(2);
  });

  it("fires on a first sighting that already matches", () => {
    // Starting to watch a token late is not a reason to stay silent about a
    // condition the user explicitly asked to hear about.
    const result = evaluateRule(rule(), obs({ liquidityChangeBps: -9000n }), null, NOW);
    expect(result.fired).not.toBeNull();
  });

  it("does not fire when the condition never holds", () => {
    const steps = [
      { obs: obs({ liquidityChangeBps: -100n }), atMs: NOW },
      { obs: obs({ liquidityChangeBps: 400n }), atMs: NOW + MINUTE },
    ];
    expect(run(rule(), steps).fires).toBe(0);
  });
});

describe("alert firing — cooldown", () => {
  it("suppresses a real crossing that arrives inside the cooldown", () => {
    // A value oscillating around a threshold produces genuine transitions
    // every few seconds. Honest volatility must not become spam.
    const steps = [
      { obs: obs({ liquidityChangeBps: -2500n }), atMs: NOW },
      { obs: obs({ liquidityChangeBps: 100n }), atMs: NOW + MINUTE },
      { obs: obs({ liquidityChangeBps: -2500n }), atMs: NOW + 2 * MINUTE },
      { obs: obs({ liquidityChangeBps: 100n }), atMs: NOW + 3 * MINUTE },
      { obs: obs({ liquidityChangeBps: -2500n }), atMs: NOW + 4 * MINUTE },
    ];
    expect(run(rule({ cooldownSeconds: 3600 }), steps).fires).toBe(1);
  });

  it("allows the next crossing once the cooldown has elapsed", () => {
    const steps = [
      { obs: obs({ liquidityChangeBps: -2500n }), atMs: NOW },
      { obs: obs({ liquidityChangeBps: 100n }), atMs: NOW + MINUTE },
      { obs: obs({ liquidityChangeBps: -2500n }), atMs: NOW + 61 * MINUTE },
    ];
    expect(run(rule({ cooldownSeconds: 3600 }), steps).fires).toBe(2);
  });

  it("does not advance the cooldown clock when nothing was sent", () => {
    const suppressed = evaluateRule(
      rule(),
      obs({ liquidityChangeBps: 0n }),
      { matched: false, lastValueBps: null, lastFiredAtMs: NOW - 1000 },
      NOW,
    );
    expect(suppressed.nextState?.lastFiredAtMs).toBe(NOW - 1000);
  });
});

describe("alert firing — unavailable inputs", () => {
  it("leaves state untouched rather than recording a non-match", () => {
    const result = evaluateRule(rule(), obs({ liquidityChangeBps: null }), null, NOW);
    expect(result.fired).toBeNull();
    expect(result.nextState).toBeNull();
  });

  it("does not duplicate an alert when data drops out and comes back", () => {
    // The subtle one. If a gap were recorded as "does not match", the next
    // good read would look like a fresh crossing and fire a second time for
    // a condition that never actually stopped holding.
    const steps = [
      { obs: obs({ liquidityChangeBps: -4000n }), atMs: NOW },
      { obs: obs({ liquidityChangeBps: null }), atMs: NOW + MINUTE }, // provider down
      { obs: obs({ liquidityChangeBps: null }), atMs: NOW + 2 * MINUTE },
      { obs: obs({ liquidityChangeBps: -4000n }), atMs: NOW + 10 * 3600_000 }, // well past cooldown
    ];
    expect(run(rule(), steps).fires).toBe(1);
  });

  it("never fires for a disabled rule", () => {
    const result = evaluateRule(
      rule({ enabled: false }),
      obs({ liquidityChangeBps: -9000n }),
      null,
      NOW,
    );
    expect(result.fired).toBeNull();
    expect(result.nextState).toBeNull();
  });
});

describe("alert kinds", () => {
  it("treats a price rise and a price fall as opposite directions, not magnitudes", () => {
    const fall = evaluateRule(
      rule({ kind: "price_change", thresholdBps: 2000n, direction: "below" }),
      obs({ priceChangeBps: -2500n }),
      null,
      NOW,
    );
    const rise = evaluateRule(
      rule({ kind: "price_change", thresholdBps: 2000n, direction: "below" }),
      obs({ priceChangeBps: 2500n }),
      null,
      NOW,
    );
    expect(fall.fired).not.toBeNull();
    expect(rise.fired).toBeNull(); // a 25% rise must not satisfy "below 20%"
  });

  it("ignores a liquidity increase for a drop rule", () => {
    const result = evaluateRule(
      rule({ kind: "liquidity_drop", thresholdBps: 2000n }),
      obs({ liquidityChangeBps: 9000n }),
      null,
      NOW,
    );
    expect(result.fired).toBeNull();
  });

  it("escalates severity for a severe liquidity drain", () => {
    const mild = evaluateRule(
      rule({ thresholdBps: 1000n }),
      obs({ liquidityChangeBps: -2000n }),
      null,
      NOW,
    );
    const severe = evaluateRule(
      rule({ thresholdBps: 1000n }),
      obs({ liquidityChangeBps: -7000n }),
      null,
      NOW,
    );
    expect(mild.fired?.severity).toBe("warning");
    expect(severe.fired?.severity).toBe("critical");
  });

  it("fires authority_change only once both authorities are revoked", () => {
    const partial = evaluateRule(
      rule({ kind: "authority_change", thresholdBps: null }),
      obs({ mintAuthorityRevoked: true, freezeAuthorityRevoked: false }),
      null,
      NOW,
    );
    const both = evaluateRule(
      rule({ kind: "authority_change", thresholdBps: null }),
      obs({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true }),
      null,
      NOW,
    );
    expect(partial.fired).toBeNull();
    expect(both.fired?.title).toMatch(/renounced/i);
  });

  it("treats a missing route as critical", () => {
    const result = evaluateRule(
      rule({ kind: "route_unavailable", thresholdBps: null }),
      obs({ routeAvailable: false }),
      null,
      NOW,
    );
    expect(result.fired?.severity).toBe("critical");
  });

  it("states the fact in the title and the meaning in the reason, without predicting", () => {
    const result = evaluateRule(rule(), obs({ liquidityChangeBps: -3000n }), null, NOW);
    expect(result.fired!.title).toMatch(/FLOOF/);
    expect(result.fired!.reason.length).toBeGreaterThan(30);
    // The house rule from the research page: no forecasting language.
    expect(result.fired!.reason).not.toMatch(/will |going to|expect to|guaranteed/i);
  });
});

describe("quiet hours", () => {
  const at = (h: number, m = 0): number => Date.UTC(2026, 0, 1, h, m);

  it("handles a range that wraps midnight", () => {
    // 22:00 -> 06:00 is the range people actually set, and it is two
    // intervals rather than one.
    expect(inQuietHours(at(23), 1320, 360)).toBe(true);
    expect(inQuietHours(at(3), 1320, 360)).toBe(true);
    expect(inQuietHours(at(12), 1320, 360)).toBe(false);
  });

  it("handles a same-day range", () => {
    expect(inQuietHours(at(10), 540, 1020)).toBe(true); // 09:00-17:00
    expect(inQuietHours(at(20), 540, 1020)).toBe(false);
  });

  it("is never quiet when unset", () => {
    expect(inQuietHours(at(3), null, null)).toBe(false);
    expect(inQuietHours(at(3), 1320, null)).toBe(false);
  });

  it("excludes the end minute so back-to-back ranges cannot overlap", () => {
    expect(inQuietHours(at(6), 1320, 360)).toBe(false);
  });
});
