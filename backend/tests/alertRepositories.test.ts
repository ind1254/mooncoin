import { beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import {
  AlertEventRepository,
  AlertRuleRepository,
  AlertRuleStateRepository,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferencesRepository,
} from "../src/db/repositories.js";

const NOW = 1_760_000_000_000;
const MINT_A = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const MINT_B = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

let db: SqlClient;
let rules: AlertRuleRepository;
let states: AlertRuleStateRepository;
let events: AlertEventRepository;
let prefs: NotificationPreferencesRepository;
let userId: string;
let otherUserId: string;

async function makeUser(email: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into users (email, password_hash) values ($1, 'scrypt$x') returning id`,
    [email],
  );
  return String(rows[0]!.id);
}

async function watch(uid: string, mint: string): Promise<void> {
  await db.query(`insert into watchlist_items (user_id, token_mint) values ($1, $2)`, [uid, mint]);
}

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  rules = new AlertRuleRepository(db);
  states = new AlertRuleStateRepository(db);
  events = new AlertEventRepository(db);
  prefs = new NotificationPreferencesRepository(db);
  userId = await makeUser("a@example.com");
  otherUserId = await makeUser("b@example.com");
});

describe("notification preferences", () => {
  it("returns defaults without writing a row for an untouched user", async () => {
    // The table should hold deliberate choices, not one row per signup.
    const result = await prefs.get(userId);
    expect(result).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);

    const rows = await db.query(`select 1 from notification_preferences where user_id = $1`, [userId]);
    expect(rows).toHaveLength(0);
  });

  it("round-trips a saved preference set, including wrapping quiet hours", async () => {
    await prefs.put(
      userId,
      {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        emailEnabled: true,
        deliveryMode: "hourly_digest",
        quietStartMin: 1320,
        quietEndMin: 360,
        maxEmailsPerDay: 5,
      },
      NOW,
    );
    const result = await prefs.get(userId);
    expect(result.emailEnabled).toBe(true);
    expect(result.deliveryMode).toBe("hourly_digest");
    expect(result.quietStartMin).toBe(1320);
    expect(result.quietEndMin).toBe(360);
    expect(result.maxEmailsPerDay).toBe(5);
  });

  it("counts only emails actually sent, for the daily cap", async () => {
    const rule = await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "price_change", thresholdBps: 500n, direction: "above", cooldownSeconds: 3600 },
      NOW,
    );
    const sent = await events.insert(
      { ruleId: rule.id, userId, mint: MINT_A, symbol: "BONK", kind: "price_change", title: "t", reason: "r", severity: "info", valueBps: 600n },
      NOW,
    );
    await events.insert(
      { ruleId: rule.id, userId, mint: MINT_B, symbol: "WIF", kind: "price_change", title: "t", reason: "r", severity: "info", valueBps: 600n },
      NOW,
    );

    // Two events exist, but only one was emailed.
    expect(await prefs.emailsSentSince(userId, NOW - 86_400_000)).toBe(0);
    await events.markEmailSent(sent, NOW);
    expect(await prefs.emailsSentSince(userId, NOW - 86_400_000)).toBe(1);
  });
});

describe("alert rules", () => {
  it("creates and lists a rule for its owner only", async () => {
    await rules.create(
      userId,
      { scope: "mint", mint: MINT_A, kind: "liquidity_drop", thresholdBps: 2000n, direction: null, cooldownSeconds: 1800 },
      NOW,
    );
    expect(await rules.listForUser(userId)).toHaveLength(1);
    expect(await rules.listForUser(otherUserId)).toHaveLength(0);
  });

  it("preserves a bigint threshold exactly", async () => {
    const rule = await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "price_change", thresholdBps: 123_456n, direction: "above", cooldownSeconds: 60 },
      NOW,
    );
    const [stored] = await rules.listForUser(userId);
    expect(rule.thresholdBps).toBe(123_456n);
    expect(stored!.thresholdBps).toBe(123_456n);
  });

  it("refuses to disable or delete another user's rule", async () => {
    // Ownership is part of the predicate, so a wrong user simply matches
    // nothing rather than relying on a separate check that could be skipped.
    const rule = await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "volume_spike", thresholdBps: 5000n, direction: null, cooldownSeconds: 600 },
      NOW,
    );

    expect(await rules.setEnabled(otherUserId, rule.id, false, NOW)).toBe(false);
    expect(await rules.remove(otherUserId, rule.id)).toBe(false);
    expect(await rules.listForUser(userId)).toHaveLength(1);

    expect(await rules.setEnabled(userId, rule.id, false, NOW)).toBe(true);
    expect(await rules.remove(userId, rule.id)).toBe(true);
  });
});

describe("resolving rules to mints — the worker's query", () => {
  it("fans a watchlist rule across every watched token", async () => {
    await watch(userId, MINT_A);
    await watch(userId, MINT_B);
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "liquidity_drop", thresholdBps: 2000n, direction: null, cooldownSeconds: 3600 },
      NOW,
    );

    const resolved = await rules.resolveEnabled();
    expect(resolved.map((r) => r.mint).sort()).toEqual([MINT_A, MINT_B].sort());
  });

  it("picks up a newly watched token without recreating the rule", async () => {
    // The reason watchlist scope exists: adding a token inherits the rules
    // you already have, rather than needing one rule per token.
    await watch(userId, MINT_A);
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "liquidity_drop", thresholdBps: 2000n, direction: null, cooldownSeconds: 3600 },
      NOW,
    );
    expect(await rules.resolveEnabled()).toHaveLength(1);

    await watch(userId, MINT_B);
    expect(await rules.resolveEnabled()).toHaveLength(2);
  });

  it("resolves a mint-scoped rule regardless of the watchlist", async () => {
    await rules.create(
      userId,
      { scope: "mint", mint: MINT_B, kind: "route_unavailable", thresholdBps: null, direction: null, cooldownSeconds: 3600 },
      NOW,
    );
    const resolved = await rules.resolveEnabled();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.mint).toBe(MINT_B);
  });

  it("excludes disabled rules", async () => {
    await watch(userId, MINT_A);
    const rule = await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "price_change", thresholdBps: 500n, direction: "above", cooldownSeconds: 3600 },
      NOW,
    );
    await rules.setEnabled(userId, rule.id, false, NOW);
    expect(await rules.resolveEnabled()).toHaveLength(0);
  });

  it("yields nothing for a watchlist rule when the watchlist is empty", async () => {
    await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "price_change", thresholdBps: 500n, direction: "above", cooldownSeconds: 3600 },
      NOW,
    );
    expect(await rules.resolveEnabled()).toHaveLength(0);
  });
});

describe("rule state", () => {
  it("round-trips transition state, including a null last-fired", async () => {
    const rule = await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "liquidity_drop", thresholdBps: 2000n, direction: null, cooldownSeconds: 3600 },
      NOW,
    );
    expect(await states.get(rule.id, MINT_A)).toBeNull();

    await states.put(rule.id, MINT_A, { matched: true, lastValueBps: 3000n, lastFiredAtMs: null }, NOW);
    const stored = await states.get(rule.id, MINT_A);
    expect(stored).toEqual({ matched: true, lastValueBps: 3000n, lastFiredAtMs: null });

    await states.put(rule.id, MINT_A, { matched: false, lastValueBps: 100n, lastFiredAtMs: NOW }, NOW);
    expect((await states.get(rule.id, MINT_A))!.matched).toBe(false);
    expect((await states.get(rule.id, MINT_A))!.lastFiredAtMs).toBe(NOW);
  });

  it("keeps state separate per mint for the same rule", async () => {
    const rule = await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "liquidity_drop", thresholdBps: 2000n, direction: null, cooldownSeconds: 3600 },
      NOW,
    );
    await states.put(rule.id, MINT_A, { matched: true, lastValueBps: 1n, lastFiredAtMs: NOW }, NOW);
    await states.put(rule.id, MINT_B, { matched: false, lastValueBps: 2n, lastFiredAtMs: null }, NOW);

    expect((await states.get(rule.id, MINT_A))!.matched).toBe(true);
    expect((await states.get(rule.id, MINT_B))!.matched).toBe(false);
  });
});

describe("alert events", () => {
  it("lists newest first and tracks unread count", async () => {
    const rule = await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "price_change", thresholdBps: 500n, direction: "above", cooldownSeconds: 3600 },
      NOW,
    );
    const base = { ruleId: rule.id, userId, symbol: "BONK", kind: "price_change" as const, severity: "info" as const, valueBps: 600n };
    await events.insert({ ...base, mint: MINT_A, title: "older", reason: "r" }, NOW);
    await events.insert({ ...base, mint: MINT_B, title: "newer", reason: "r" }, NOW + 1000);

    const list = await events.listForUser(userId);
    expect(list.map((e) => e.title)).toEqual(["newer", "older"]);
    expect(await events.unreadCount(userId)).toBe(2);

    expect(await events.markAllRead(userId, NOW + 2000)).toBe(2);
    expect(await events.unreadCount(userId)).toBe(0);
    // Marking read twice must not double-count.
    expect(await events.markAllRead(userId, NOW + 3000)).toBe(0);
  });

  it("never shows one user another user's alerts", async () => {
    const rule = await rules.create(
      userId,
      { scope: "watchlist", mint: null, kind: "price_change", thresholdBps: 500n, direction: "above", cooldownSeconds: 3600 },
      NOW,
    );
    await events.insert(
      { ruleId: rule.id, userId, mint: MINT_A, symbol: "BONK", kind: "price_change", title: "t", reason: "r", severity: "info", valueBps: 1n },
      NOW,
    );
    expect(await events.listForUser(otherUserId)).toHaveLength(0);
    expect(await events.unreadCount(otherUserId)).toBe(0);
  });
});
