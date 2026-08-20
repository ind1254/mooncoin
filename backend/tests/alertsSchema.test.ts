import { beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";

/**
 * Migration 005, exercised against real Postgres semantics.
 *
 * The constraints in this schema are load-bearing, not decoration: they are
 * what stop a malformed rule from reaching the worker, where a bad threshold
 * would mean either silence or a mail flood. A CHECK that is never tested is
 * a comment.
 */

let db: SqlClient;
let userId: string;

async function makeUser(email: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into users (email, password_hash) values ($1, 'scrypt$x') returning id`,
    [email],
  );
  return String(rows[0]!.id);
}

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  userId = await makeUser("alerts@example.com");
});

describe("migration 005 — alert schema", () => {
  it("applies on top of the existing migrations", async () => {
    const rows = await db.query<{ name: string }>("select name from schema_migrations order by name");
    expect(rows.map((r) => r.name)).toContain("005_alerts.sql");
  });

  it("defaults email off and in-app on for a new preference row", async () => {
    // Mailing a fresh account nobody asked for is how a sending domain earns
    // a spam reputation. In-app costs nothing and cannot be misdelivered.
    await db.query(`insert into notification_preferences (user_id) values ($1)`, [userId]);
    const [prefs] = await db.query<Record<string, unknown>>(
      `select in_app_enabled, email_enabled, push_enabled, delivery_mode from notification_preferences where user_id = $1`,
      [userId],
    );
    expect(prefs!.in_app_enabled).toBe(true);
    expect(prefs!.email_enabled).toBe(false);
    expect(prefs!.push_enabled).toBe(false);
    expect(prefs!.delivery_mode).toBe("immediate");
  });

  it("rejects a mint-scoped rule with no mint, and a watchlist rule with one", async () => {
    // The pairing is the whole point of the scope column; letting them drift
    // apart produces a rule that silently matches nothing.
    await expect(
      db.query(
        `insert into alert_rules (user_id, scope, mint, kind) values ($1, 'mint', null, 'price_change')`,
        [userId],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `insert into alert_rules (user_id, scope, mint, kind) values ($1, 'watchlist', 'SomeMint111', 'price_change')`,
        [userId],
      ),
    ).rejects.toThrow();
  });

  it("accepts a well-formed watchlist rule and a well-formed mint rule", async () => {
    await db.query(
      `insert into alert_rules (user_id, scope, kind, threshold_bps, direction)
       values ($1, 'watchlist', 'liquidity_drop', 2000, 'below')`,
      [userId],
    );
    await db.query(
      `insert into alert_rules (user_id, scope, mint, kind, threshold_bps, direction)
       values ($1, 'mint', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'holder_concentration', 5000, 'above')`,
      [userId],
    );
    const rows = await db.query(`select id from alert_rules where user_id = $1`, [userId]);
    expect(rows).toHaveLength(2);
  });

  it("refuses an unknown alert kind rather than storing a rule nothing evaluates", async () => {
    await expect(
      db.query(`insert into alert_rules (user_id, scope, kind) values ($1, 'watchlist', 'moon_probability')`, [
        userId,
      ]),
    ).rejects.toThrow();
  });

  it("bounds the cooldown so a rule cannot fire every second or once a year", async () => {
    await expect(
      db.query(
        `insert into alert_rules (user_id, scope, kind, cooldown_seconds) values ($1, 'watchlist', 'price_change', 5)`,
        [userId],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `insert into alert_rules (user_id, scope, kind, cooldown_seconds) values ($1, 'watchlist', 'price_change', 99999999)`,
        [userId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a negative threshold", async () => {
    await expect(
      db.query(
        `insert into alert_rules (user_id, scope, kind, threshold_bps) values ($1, 'watchlist', 'price_change', -1)`,
        [userId],
      ),
    ).rejects.toThrow();
  });

  it("allows a wrapping quiet-hours range, which is the common case", async () => {
    // 22:00 -> 06:00 wraps midnight. A CHECK asserting start < end would
    // reject exactly the range most people want.
    await db.query(
      `insert into notification_preferences (user_id, quiet_start_min, quiet_end_min) values ($1, 1320, 360)`,
      [userId],
    );
    const [row] = await db.query<Record<string, unknown>>(
      `select quiet_start_min, quiet_end_min from notification_preferences where user_id = $1`,
      [userId],
    );
    expect(Number(row!.quiet_start_min)).toBe(1320);
    expect(Number(row!.quiet_end_min)).toBe(360);
  });

  it("rejects a quiet-hours minute outside a day", async () => {
    await expect(
      db.query(`insert into notification_preferences (user_id, quiet_start_min) values ($1, 1440)`, [userId]),
    ).rejects.toThrow();
  });

  it("keeps one state row per rule and mint, so transitions cannot double-count", async () => {
    const [rule] = await db.query<{ id: string }>(
      `insert into alert_rules (user_id, scope, kind, threshold_bps, direction)
       values ($1, 'watchlist', 'liquidity_drop', 2000, 'below') returning id`,
      [userId],
    );
    const ruleId = String(rule!.id);

    await db.query(`insert into alert_rule_state (rule_id, mint, matched) values ($1, 'MintA', true)`, [ruleId]);
    await expect(
      db.query(`insert into alert_rule_state (rule_id, mint, matched) values ($1, 'MintA', false)`, [ruleId]),
    ).rejects.toThrow();
  });

  it("preserves alert history when the rule behind it is deleted", async () => {
    // A user must still be able to see what they were told, even after
    // turning the rule off. The rule reference goes null; the event stays.
    const [rule] = await db.query<{ id: string }>(
      `insert into alert_rules (user_id, scope, kind) values ($1, 'watchlist', 'authority_change') returning id`,
      [userId],
    );
    const ruleId = String(rule!.id);

    await db.query(
      `insert into alert_events (user_id, rule_id, mint, kind, title, reason)
       values ($1, $2, 'MintA', 'authority_change', 'Mint authority re-enabled', 'Someone can mint new supply again.')`,
      [userId, ruleId],
    );

    await db.query(`delete from alert_rules where id = $1`, [ruleId]);

    const events = await db.query<Record<string, unknown>>(
      `select rule_id, title from alert_events where user_id = $1`,
      [userId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.rule_id).toBeNull();
  });

  it("removes a user's alerting data when the account is deleted", async () => {
    // Account deletion is an App Store requirement, so nothing may be left
    // dangling behind a removed user.
    const [rule] = await db.query<{ id: string }>(
      `insert into alert_rules (user_id, scope, kind) values ($1, 'watchlist', 'price_change') returning id`,
      [userId],
    );
    await db.query(`insert into notification_preferences (user_id) values ($1)`, [userId]);
    await db.query(
      `insert into alert_events (user_id, rule_id, mint, kind, title, reason)
       values ($1, $2, 'MintA', 'price_change', 't', 'r')`,
      [userId, String(rule!.id)],
    );

    await db.query(`delete from users where id = $1`, [userId]);

    for (const table of ["alert_rules", "alert_events", "notification_preferences"]) {
      const rows = await db.query(`select 1 from ${table} where user_id = $1`, [userId]);
      expect(rows, `${table} should be empty after user deletion`).toHaveLength(0);
    }
  });

  it("rejects an unknown severity", async () => {
    await expect(
      db.query(
        `insert into alert_events (user_id, mint, kind, title, reason, severity)
         values ($1, 'MintA', 'price_change', 't', 'r', 'apocalyptic')`,
        [userId],
      ),
    ).rejects.toThrow();
  });
});
