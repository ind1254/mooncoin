import { beforeEach, describe, expect, it } from "vitest";
import { runAlertPass, type AlertWorkerDeps } from "../src/alerts/worker.js";
import { MAX_DIFF_AGE_MS, changeBps } from "../src/alerts/observations.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import {
  AlertEventRepository,
  AlertRuleRepository,
  AlertRuleStateRepository,
  TokenObservationRepository,
} from "../src/db/repositories.js";
import type { ResearchProfile } from "../src/market/research.js";

/**
 * The worker end to end: real Postgres, a fake market.
 *
 * These assert what a user receives over a sequence of passes, because that is
 * the only thing that distinguishes a useful alerting product from one people
 * turn off.
 */

const NOW = 1_760_000_000_000;
const MINT_A = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const MINT_B = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

let db: SqlClient;
let rules: AlertRuleRepository;
let events: AlertEventRepository;
let userId: string;
let clock: { now: number };
let profiles: Map<string, ResearchProfile>;
let fetches: string[];
let failing: Set<string>;

/** Minimal profile carrying only the fields the worker reads. */
function profile(mint: string, over: { liquidity?: number; price?: number; concentrationBps?: number } = {}): ResearchProfile {
  return {
    mint,
    symbol: mint === MINT_A ? "FLOOF" : "WIF",
    name: "Test Token",
    decimals: 5,
    tokenProgram: null,
    iconUrl: null,
    tags: [],
    verifiedByProvider: false,
    identitySource: "test",
    marketSource: "test",
    marketUpdatedAtMs: NOW,
    market: {
      priceUsdPico: BigInt(over.price ?? 1_000_000),
      liquidityUsdMicro: BigInt(over.liquidity ?? 100_000_000_000),
      marketCapUsdMicro: null,
      fdvUsdMicro: null,
      holderCount: 100,
      change1hBps: null,
      change24hBps: null,
      buyVolume24hUsdMicro: 1_000_000n,
      sellVolume24hUsdMicro: 1_000_000n,
      numBuys24h: null,
      numSells24h: null,
      topHolderPctBps: null,
      organicScore: null,
      organicScoreLabel: null,
    },
    verification: {
      status: "verified",
      source: "solana-rpc:mainnet",
      checkedAtMs: NOW,
      // Spread rather than assign undefined: exactOptionalPropertyTypes
      // distinguishes an absent key from one explicitly set to undefined.
      ...(over.concentrationBps === undefined
        ? {}
        : {
            holders: {
              status: "verified" as const,
              concentrationBps: BigInt(over.concentrationBps),
              programHeldBps: 0n,
              walletHolderCount: 3,
              unclassifiedBps: 0n,
              detail: "test",
            },
          }),
    },
    authorities: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      source: "solana-rpc:mainnet",
      providerAgreement: "not_reported",
    },
    risk: { score: 10, level: "low", factors: [], method: "test" },
    simulation: { available: false, reason: "test" },
    fetchedAtMs: NOW,
  };
}

function deps(): AlertWorkerDeps {
  return {
    research: {
      getProfile: async (mint: string) => {
        fetches.push(mint);
        if (failing.has(mint)) throw new Error("provider down");
        const p = profiles.get(mint);
        if (!p) throw new Error(`no profile for ${mint}`);
        return p;
      },
    },
    rules,
    states: new AlertRuleStateRepository(db),
    events,
    observations: new TokenObservationRepository(db),
    clock: () => clock.now,
    log: () => undefined,
  };
}

async function watch(mint: string): Promise<void> {
  await db.query(`insert into watchlist_items (user_id, token_mint) values ($1, $2)`, [userId, mint]);
}

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  rules = new AlertRuleRepository(db);
  events = new AlertEventRepository(db);
  clock = { now: NOW };
  fetches = [];
  failing = new Set();
  profiles = new Map([
    [MINT_A, profile(MINT_A)],
    [MINT_B, profile(MINT_B)],
  ]);
  const rows = await db.query<{ id: string }>(
    `insert into users (email, password_hash) values ('w@example.com', 'scrypt$x') returning id`,
  );
  userId = String(rows[0]!.id);
});

describe("alert worker", () => {
  it("does nothing when no rules exist", async () => {
    const summary = await runAlertPass(deps());
    expect(summary.rulesEvaluated).toBe(0);
    expect(fetches).toHaveLength(0);
  });

  it("fetches each mint once no matter how many rules target it", async () => {
    // The efficiency property the whole design turns on: many watchers of one
    // token must not become many provider calls.
    await watch(MINT_A);
    for (const kind of ["price_change", "liquidity_drop", "holder_concentration"] as const) {
      await rules.create(
        userId,
        { scope: "watchlist", mint: null, kind, thresholdBps: 1000n, direction: "above", cooldownSeconds: 3600 },
        NOW,
      );
    }

    const summary = await runAlertPass(deps());
    expect(summary.rulesEvaluated).toBe(3);
    expect(fetches).toEqual([MINT_A]);
  });

  it("stores a snapshot on the first pass and fires nothing", async () => {
    // Nothing to diff against yet, so change-based rules must stay silent
    // rather than treat the first sighting as a 100% move.
    await watch(MINT_A);
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "liquidity_drop", thresholdBps: 2000n, direction: null, cooldownSeconds: 3600 },
      NOW,
    );

    expect((await runAlertPass(deps())).alertsFired).toBe(0);
    const stored = await new TokenObservationRepository(db).getMany([MINT_A]);
    expect(stored.get(MINT_A)?.liquidityUsdMicro).toBe(100_000_000_000n);
  });

  it("fires once when liquidity drains between passes, then stays quiet", async () => {
    await watch(MINT_A);
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "liquidity_drop", thresholdBps: 3000n, direction: null, cooldownSeconds: 3600 },
      NOW,
    );

    await runAlertPass(deps()); // baseline

    clock.now += 60_000;
    profiles.set(MINT_A, profile(MINT_A, { liquidity: 40_000_000_000 })); // -60%
    expect((await runAlertPass(deps())).alertsFired).toBe(1);

    // Still drained, but no new crossing.
    clock.now += 60_000;
    expect((await runAlertPass(deps())).alertsFired).toBe(0);

    const list = await events.listForUser(userId);
    expect(list).toHaveLength(1);
    expect(list[0]!.severity).toBe("critical");
    expect(list[0]!.reason).toMatch(/in the last 60 seconds/);
  });

  it("does not fire a burst after the worker has been down", async () => {
    // The operational trap. Restarting after an outage must not diff against
    // a stale snapshot and report every accumulated move as if it just
    // happened. The snapshot refreshes; only the comparison is skipped.
    await watch(MINT_A);
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "liquidity_drop", thresholdBps: 3000n, direction: null, cooldownSeconds: 60 },
      NOW,
    );

    await runAlertPass(deps());

    clock.now += MAX_DIFF_AGE_MS + 60_000; // worker was down
    profiles.set(MINT_A, profile(MINT_A, { liquidity: 10_000_000_000 })); // -90%
    expect((await runAlertPass(deps())).alertsFired).toBe(0);

    // The refreshed snapshot means the NEXT real move is still detected.
    clock.now += 60_000;
    profiles.set(MINT_A, profile(MINT_A, { liquidity: 4_000_000_000 })); // -60% again
    expect((await runAlertPass(deps())).alertsFired).toBe(1);
  });

  it("keeps going when one token cannot be read", async () => {
    await watch(MINT_A);
    await watch(MINT_B);
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "holder_concentration", thresholdBps: 5000n, direction: "above", cooldownSeconds: 3600 },
      NOW,
    );
    profiles.set(MINT_B, profile(MINT_B, { concentrationBps: 9000 }));
    failing.add(MINT_A);

    const summary = await runAlertPass(deps());
    expect(summary.mintsFailed).toBe(1);
    expect(summary.alertsFired).toBe(1); // MINT_B still evaluated
  });

  it("leaves a failed token's snapshot untouched rather than zeroing it", async () => {
    await watch(MINT_A);
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "liquidity_drop", thresholdBps: 3000n, direction: null, cooldownSeconds: 3600 },
      NOW,
    );
    await runAlertPass(deps());

    clock.now += 60_000;
    failing.add(MINT_A);
    await runAlertPass(deps());

    const stored = await new TokenObservationRepository(db).getMany([MINT_A]);
    expect(stored.get(MINT_A)?.liquidityUsdMicro).toBe(100_000_000_000n);
    expect(stored.get(MINT_A)?.observedAtMs).toBe(NOW);
  });

  it("delivers an alert only to the user whose rule fired", async () => {
    const other = await db.query<{ id: string }>(
      `insert into users (email, password_hash) values ('other@example.com', 'scrypt$x') returning id`,
    );
    const otherId = String(other[0]!.id);

    await watch(MINT_A);
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "holder_concentration", thresholdBps: 5000n, direction: "above", cooldownSeconds: 3600 },
      NOW,
    );
    profiles.set(MINT_A, profile(MINT_A, { concentrationBps: 9000 }));

    await runAlertPass(deps());
    expect(await events.unreadCount(userId)).toBe(1);
    expect(await events.unreadCount(otherId)).toBe(0);
  });

  it("keeps concentration alerts working when change data is unavailable", async () => {
    // Absolute facts do not need a previous snapshot, so they must fire on the
    // very first pass rather than waiting a cycle like the delta rules.
    await watch(MINT_A);
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "holder_concentration", thresholdBps: 5000n, direction: "above", cooldownSeconds: 3600 },
      NOW,
    );
    profiles.set(MINT_A, profile(MINT_A, { concentrationBps: 8000 }));

    expect((await runAlertPass(deps())).alertsFired).toBe(1);
  });
});

describe("changeBps", () => {
  it("returns null for a zero or missing baseline instead of inventing infinity", () => {
    expect(changeBps(0n, 100n)).toBeNull();
    expect(changeBps(null, 100n)).toBeNull();
    expect(changeBps(100n, null)).toBeNull();
  });

  it("computes a halving as -50% and a doubling as +100%", () => {
    expect(changeBps(1000n, 500n)).toBe(-5000n);
    expect(changeBps(1000n, 2000n)).toBe(10_000n);
  });

  it("rounds magnitude away from zero so a warning never understates itself", () => {
    // 1 -> 0.99...: the exact value is -0.0333…%, which truncation would
    // report as 0 and hide entirely.
    expect(changeBps(30_000n, 29_999n)).toBe(-1n);
  });
});
