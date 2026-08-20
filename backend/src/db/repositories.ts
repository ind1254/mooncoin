import { createHash } from "node:crypto";
import { ArbError } from "../core/errors.js";
import type { AlertKind, AlertRule, AlertRuleState, FiredAlert } from "../alerts/engine.js";
import { readBigInt, readDateMs, readString, type SqlClient, type SqlRow } from "./client.js";

/**
 * Persistence boundary.
 *
 * Repositories keep SQL out of route handlers and convert database values into
 * domain types in exactly one place — which is where the BIGINT-to-bigint
 * conversion lives, so no caller can accidentally read money as a float.
 *
 * These are concrete classes, not interfaces. The swappable seam is SqlClient:
 * we need several DATABASES (hosted Postgres, PGlite in tests), not several
 * implementations of "portfolio storage". Adding interfaces here would be
 * vocabulary, not architecture.
 */

export interface UserRecord {
  id: string;
  email: string;
  emailVerifiedAtMs: number | null;
  createdAtMs: number;
}

export interface PortfolioRecord {
  id: string;
  userId: string;
  name: string;
  baseCurrency: string;
  cashMicroUsd: bigint;
  startingMicroUsd: bigint;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WatchlistRecord {
  id: string;
  tokenMint: string;
  createdAtMs: number;
}

export type LivePaperPositionStatus = "open" | "closed";

export interface LivePaperPositionRecord {
  id: string;
  portfolioId: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  status: LivePaperPositionStatus;
  tokenQuantityBaseUnits: bigint;
  entryCostMicroUsd: bigint;
  entrySlippageBps: bigint;
  entryPriceImpactBps: bigint;
  entryRoute: string[];
  entryQuoteSource: string;
  entryQuoteRetrievedAtMs: number;
  entryQuoteExpiresAtMs: number;
  openedAtMs: number;
  closeProceedsMicroUsd: bigint | null;
  realizedPnlMicroUsd: bigint | null;
  exitSlippageBps: bigint | null;
  exitPriceImpactBps: bigint | null;
  exitRoute: string[] | null;
  exitQuoteSource: string | null;
  exitQuoteRetrievedAtMs: number | null;
  exitQuoteExpiresAtMs: number | null;
  closedAtMs: number | null;
  clientRequestId: string | null;
}

export interface OpenLivePaperPositionInput {
  clientRequestId: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  tokenQuantityBaseUnits: bigint;
  entryCostMicroUsd: bigint;
  entrySlippageBps: bigint;
  entryPriceImpactBps: bigint;
  entryRoute: string[];
  entryQuoteSource: string;
  entryQuoteRetrievedAtMs: number;
  entryQuoteExpiresAtMs: number;
  openedAtMs: number;
}

export interface CloseLivePaperPositionInput {
  closeProceedsMicroUsd: bigint;
  exitSlippageBps: bigint;
  exitPriceImpactBps: bigint;
  exitRoute: string[];
  exitQuoteSource: string;
  exitQuoteRetrievedAtMs: number;
  exitQuoteExpiresAtMs: number;
  closedAtMs: number;
}

function readInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error("Expected an integer database value");
  return parsed;
}

function readNullableDateMs(value: unknown): number | null {
  return value === null || value === undefined ? null : readDateMs(value);
}

function readNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : readString(value);
}

function readRoute(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Expected a JSON route-label array");
  }
  return parsed;
}

function toLivePaperPosition(row: SqlRow): LivePaperPositionRecord {
  const status = readString(row.status);
  if (status !== "open" && status !== "closed") throw new Error("Unexpected paper-position status");
  return {
    id: readString(row.id),
    portfolioId: readString(row.portfolio_id),
    tokenMint: readString(row.token_mint),
    tokenSymbol: readString(row.token_symbol),
    tokenName: readString(row.token_name),
    tokenDecimals: readInteger(row.token_decimals),
    status,
    tokenQuantityBaseUnits: readBigInt(row.token_quantity_base_units),
    entryCostMicroUsd: readBigInt(row.entry_cost_micro_usd),
    entrySlippageBps: readBigInt(row.entry_slippage_bps),
    entryPriceImpactBps: readBigInt(row.entry_price_impact_bps),
    entryRoute: readRoute(row.entry_route),
    entryQuoteSource: readString(row.entry_quote_source),
    entryQuoteRetrievedAtMs: readDateMs(row.entry_quote_retrieved_at),
    entryQuoteExpiresAtMs: readDateMs(row.entry_quote_expires_at),
    openedAtMs: readDateMs(row.opened_at),
    closeProceedsMicroUsd:
      row.close_proceeds_micro_usd === null || row.close_proceeds_micro_usd === undefined
        ? null
        : readBigInt(row.close_proceeds_micro_usd),
    realizedPnlMicroUsd:
      row.realized_pnl_micro_usd === null || row.realized_pnl_micro_usd === undefined
        ? null
        : readBigInt(row.realized_pnl_micro_usd),
    exitSlippageBps:
      row.exit_slippage_bps === null || row.exit_slippage_bps === undefined
        ? null
        : readBigInt(row.exit_slippage_bps),
    exitPriceImpactBps:
      row.exit_price_impact_bps === null || row.exit_price_impact_bps === undefined
        ? null
        : readBigInt(row.exit_price_impact_bps),
    exitRoute: row.exit_route === null || row.exit_route === undefined ? null : readRoute(row.exit_route),
    exitQuoteSource: readNullableString(row.exit_quote_source),
    exitQuoteRetrievedAtMs: readNullableDateMs(row.exit_quote_retrieved_at),
    exitQuoteExpiresAtMs: readNullableDateMs(row.exit_quote_expires_at),
    closedAtMs: readNullableDateMs(row.closed_at),
    clientRequestId: readNullableString(row.client_request_id),
  };
}

export interface RateLimitResult {
  limit: number;
  remaining: number;
  resetAtMs: number;
}

/** Opaque database identity: raw emails and user ids never enter limit rows. */
export function hashRateLimitSubject(subject: string): string {
  return createHash("sha256").update(subject.trim().toLowerCase()).digest("hex");
}

/**
 * Postgres-backed fixed-window limiter shared by every serverless instance.
 * The upsert is atomic, so concurrent requests cannot each observe a stale
 * count and slip through together.
 */
export class RateLimitRepository {
  constructor(private readonly db: SqlClient) {}

  async consume(
    scope: string,
    subject: string,
    limit: number,
    windowMs: number,
    nowMs: number,
  ): Promise<RateLimitResult> {
    const subjectHash = hashRateLimitSubject(subject);
    const windowStartedAtMs = Math.floor(nowMs / windowMs) * windowMs;
    const resetAtMs = windowStartedAtMs + windowMs;

    return this.db.transaction(async (tx) => {
      // The expiry index makes this cheap and also bounds rows created by an
      // identifier-spraying attacker, not only repeat callers.
      await tx.query(
        `delete from rate_limit_buckets
          where expires_at <= to_timestamp($1::double precision / 1000)`,
        [nowMs],
      );
      const rows = await tx.query<{ request_count: number | string }>(
        `insert into rate_limit_buckets (
           scope, subject_hash, window_started_at, request_count, expires_at
         ) values (
           $1, $2, to_timestamp($3::double precision / 1000), 1,
           to_timestamp($4::double precision / 1000)
         )
         on conflict (scope, subject_hash, window_started_at)
         do update set request_count = rate_limit_buckets.request_count + 1,
                       expires_at = excluded.expires_at
         returning request_count`,
        [scope, subjectHash, windowStartedAtMs, resetAtMs],
      );
      const count = readInteger(rows[0]!.request_count);
      if (count > limit) {
        const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000));
        throw new ArbError(
          "RATE_LIMITED",
          `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
          429,
          { retryAfterSeconds, limit, resetAtMs },
        );
      }
      return { limit, remaining: limit - count, resetAtMs };
    });
  }
}

function toUser(row: SqlRow): UserRecord {
  return {
    id: readString(row.id),
    email: readString(row.email),
    emailVerifiedAtMs: readNullableDateMs(row.email_verified_at),
    createdAtMs: readDateMs(row.created_at),
  };
}

function toPortfolio(row: SqlRow): PortfolioRecord {
  return {
    id: readString(row.id),
    userId: readString(row.user_id),
    name: readString(row.name),
    baseCurrency: readString(row.base_currency),
    // BIGINT arrives as a string from both drivers; this is the only place
    // that conversion happens.
    cashMicroUsd: readBigInt(row.cash_micro_usd),
    startingMicroUsd: readBigInt(row.starting_micro_usd),
    createdAtMs: readDateMs(row.created_at),
    updatedAtMs: readDateMs(row.updated_at),
  };
}

export class UserRepository {
  constructor(private readonly db: SqlClient) {}

  /** Email comparison is case-insensitive, matching the unique index. */
  async findByEmail(email: string): Promise<(UserRecord & { passwordHash: string }) | null> {
    const rows = await this.db.query(
      "select id, email, password_hash, email_verified_at, created_at from users where lower(email) = lower($1)",
      [email],
    );
    const row = rows[0];
    return row ? { ...toUser(row), passwordHash: readString(row.password_hash) } : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.query("select id, email, email_verified_at, created_at from users where id = $1", [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async create(email: string, passwordHash: string, emailVerifiedAtMs: number | null = Date.now()): Promise<UserRecord> {
    const rows = await this.db.query(
      `insert into users (email, password_hash, email_verified_at)
       values ($1, $2, case when $3::double precision is null then null else to_timestamp($3 / 1000) end)
       returning id, email, email_verified_at, created_at`,
      [email.trim().toLowerCase(), passwordHash, emailVerifiedAtMs],
    );
    return toUser(rows[0]!);
  }
}

/**
 * Sessions are stored as a SHA-256 of the token. The raw token lives only in
 * the user's cookie, so a database dump does not hand an attacker live logins.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class SessionRepository {
  constructor(private readonly db: SqlClient) {}

  async create(token: string, userId: string, expiresAtMs: number): Promise<void> {
    await this.db.query(
      "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, to_timestamp($3::double precision / 1000))",
      [hashSessionToken(token), userId, expiresAtMs],
    );
  }

  /** Returns the owning user only if the session exists and has not expired. */
  async findValidUser(token: string, nowMs: number): Promise<UserRecord | null> {
    const rows = await this.db.query(
      `select u.id, u.email, u.email_verified_at, u.created_at
         from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1
          and s.expires_at > to_timestamp($2::double precision / 1000)`,
      [hashSessionToken(token), nowMs],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async delete(token: string): Promise<void> {
    await this.db.query("delete from sessions where token_hash = $1", [hashSessionToken(token)]);
  }

  async deleteForUser(userId: string): Promise<number> {
    const rows = await this.db.query("delete from sessions where user_id = $1 returning token_hash", [userId]);
    return rows.length;
  }

  async deleteExpired(nowMs: number): Promise<number> {
    const rows = await this.db.query(
      "delete from sessions where expires_at <= to_timestamp($1::double precision / 1000) returning token_hash",
      [nowMs],
    );
    return rows.length;
  }
}

export type AccountActionPurpose = "verify_email" | "reset_password";

export function hashAccountActionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Short-lived account actions use one-time bearer tokens. Issuance revokes
 * older tokens for the same purpose; consumption and the protected mutation
 * happen in one transaction so concurrent replays cannot both succeed.
 */
export class AccountActionTokenRepository {
  constructor(private readonly db: SqlClient) {}

  async issue(
    userId: string,
    purpose: AccountActionPurpose,
    rawToken: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      await tx.query(
        `update account_action_tokens
            set consumed_at = to_timestamp($3::double precision / 1000)
          where user_id = $1 and purpose = $2 and consumed_at is null`,
        [userId, purpose, nowMs],
      );
      const rows = await tx.query<{ id: string }>(
        `insert into account_action_tokens (user_id, purpose, token_hash, created_at, expires_at)
         values (
           $1, $2, $3,
           to_timestamp($4::double precision / 1000),
           to_timestamp($5::double precision / 1000)
         ) returning id`,
        [userId, purpose, hashAccountActionToken(rawToken), nowMs, expiresAtMs],
      );
      return readString(rows[0]!.id);
    });
  }

  async verifyEmail(rawToken: string, nowMs: number): Promise<UserRecord | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `select a.id as action_id, u.id, u.email, u.email_verified_at, u.created_at
           from account_action_tokens a
           join users u on u.id = a.user_id
          where a.token_hash = $1 and a.purpose = 'verify_email'
            and a.consumed_at is null
            and a.expires_at > to_timestamp($2::double precision / 1000)
          for update`,
        [hashAccountActionToken(rawToken), nowMs],
      );
      if (!rows[0]) return null;
      await tx.query(
        `update users
            set email_verified_at = to_timestamp($2::double precision / 1000),
                updated_at = to_timestamp($2::double precision / 1000)
          where id = $1`,
        [readString(rows[0].id), nowMs],
      );
      await tx.query(
        `update account_action_tokens
            set consumed_at = to_timestamp($2::double precision / 1000)
          where id = $1 and consumed_at is null`,
        [readString(rows[0].action_id), nowMs],
      );
      return { ...toUser(rows[0]), emailVerifiedAtMs: nowMs };
    });
  }

  async resetPassword(rawToken: string, passwordHash: string, nowMs: number): Promise<UserRecord | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `select a.id as action_id, u.id, u.email, u.email_verified_at, u.created_at
           from account_action_tokens a
           join users u on u.id = a.user_id
          where a.token_hash = $1 and a.purpose = 'reset_password'
            and a.consumed_at is null
            and a.expires_at > to_timestamp($2::double precision / 1000)
          for update`,
        [hashAccountActionToken(rawToken), nowMs],
      );
      if (!rows[0]) return null;
      const userId = readString(rows[0].id);
      await tx.query(
        `update users
            set password_hash = $2,
                updated_at = to_timestamp($3::double precision / 1000)
          where id = $1`,
        [userId, passwordHash, nowMs],
      );
      await tx.query(
        `update account_action_tokens
            set consumed_at = to_timestamp($2::double precision / 1000)
          where id = $1 and consumed_at is null`,
        [readString(rows[0].action_id), nowMs],
      );
      // A password change is an account-recovery boundary. Every browser must
      // authenticate again, including a session an attacker may have stolen.
      await tx.query("delete from sessions where user_id = $1", [userId]);
      return toUser(rows[0]);
    });
  }
}

export class PortfolioRepository {
  constructor(private readonly db: SqlClient) {}

  /**
   * Create the user's default portfolio if it does not exist, and return it.
   *
   * Idempotent by construction: ON CONFLICT DO NOTHING against the partial
   * unique index means two concurrent first requests cannot both fund an
   * account. The database enforces "exactly once", not application logic —
   * which is the only thing that actually holds under a race.
   */
  async ensureDefault(userId: string, startingMicroUsd: bigint): Promise<PortfolioRecord> {
    await this.db.query(
      `insert into portfolios (user_id, name, base_currency, cash_micro_usd, starting_micro_usd)
       values ($1, 'Default', 'USD', $2, $2)
       on conflict (user_id) where name = 'Default' do nothing`,
      [userId, startingMicroUsd.toString()],
    );
    const portfolio = await this.findDefault(userId);
    if (!portfolio) throw new Error("Portfolio initialization failed");
    return portfolio;
  }

  async findDefault(userId: string): Promise<PortfolioRecord | null> {
    const rows = await this.db.query(
      `select id, user_id, name, base_currency, cash_micro_usd, starting_micro_usd, created_at, updated_at
         from portfolios where user_id = $1 and name = 'Default'`,
      [userId],
    );
    return rows[0] ? toPortfolio(rows[0]) : null;
  }

  /**
   * Ownership is part of the WHERE clause, not a separate check. A portfolio
   * id belonging to someone else simply returns nothing.
   */
  async findOwned(portfolioId: string, userId: string): Promise<PortfolioRecord | null> {
    const rows = await this.db.query(
      `select id, user_id, name, base_currency, cash_micro_usd, starting_micro_usd, created_at, updated_at
         from portfolios where id = $1 and user_id = $2`,
      [portfolioId, userId],
    );
    return rows[0] ? toPortfolio(rows[0]) : null;
  }
}

/**
 * Atomic persistence for live-quote paper positions.
 *
 * The portfolio row is locked before cash or position state changes. That
 * makes concurrent opens respect the cash/position limits and guarantees two
 * close requests can never credit the same simulated proceeds twice.
 */
export class LivePaperPositionRepository {
  constructor(private readonly db: SqlClient) {}

  async findByClientRequestId(userId: string, clientRequestId: string): Promise<LivePaperPositionRecord | null> {
    const rows = await this.db.query(
      `select pp.*
         from paper_positions pp
         join portfolios p on p.id = pp.portfolio_id
        where pp.client_request_id = $1 and p.user_id = $2`,
      [clientRequestId, userId],
    );
    return rows[0] ? toLivePaperPosition(rows[0]) : null;
  }

  async findOwned(userId: string, positionId: string): Promise<LivePaperPositionRecord | null> {
    const rows = await this.db.query(
      `select pp.*
         from paper_positions pp
         join portfolios p on p.id = pp.portfolio_id
        where pp.id = $1 and p.user_id = $2`,
      [positionId, userId],
    );
    return rows[0] ? toLivePaperPosition(rows[0]) : null;
  }

  async listForUser(userId: string): Promise<LivePaperPositionRecord[]> {
    const rows = await this.db.query(
      `select pp.*
         from paper_positions pp
         join portfolios p on p.id = pp.portfolio_id
        where p.user_id = $1
        order by pp.opened_at desc`,
      [userId],
    );
    return rows.map(toLivePaperPosition);
  }

  async open(
    userId: string,
    startingMicroUsd: bigint,
    maxOpenPositions: number,
    input: OpenLivePaperPositionInput,
  ): Promise<LivePaperPositionRecord> {
    return this.db.transaction(async (tx) => {
      const portfolio = await new PortfolioRepository(tx).ensureDefault(userId, startingMicroUsd);
      await tx.query("select id from portfolios where id = $1 and user_id = $2 for update", [portfolio.id, userId]);

      const replay = await tx.query(
        "select * from paper_positions where portfolio_id = $1 and client_request_id = $2",
        [portfolio.id, input.clientRequestId],
      );
      if (replay[0]) {
        const existing = toLivePaperPosition(replay[0]);
        if (
          existing.tokenMint !== input.tokenMint ||
          existing.entryCostMicroUsd !== input.entryCostMicroUsd ||
          existing.entrySlippageBps !== input.entrySlippageBps
        ) {
          throw new ArbError(
            "VALIDATION_ERROR",
            "That paper request id was already used for a different entry.",
            409,
          );
        }
        return existing;
      }

      const counts = await tx.query<{ count: string }>(
        "select count(*)::text as count from paper_positions where portfolio_id = $1 and status = 'open'",
        [portfolio.id],
      );
      if (Number(counts[0]?.count ?? "0") >= maxOpenPositions) {
        throw new ArbError(
          "POSITION_LIMIT_REACHED",
          `Close an existing paper position before opening more than ${maxOpenPositions}.`,
          409,
        );
      }

      const debited = await tx.query(
        `update portfolios
            set cash_micro_usd = cash_micro_usd - $2,
                updated_at = to_timestamp($3::double precision / 1000)
          where id = $1 and user_id = $4 and cash_micro_usd >= $2
          returning id`,
        [portfolio.id, input.entryCostMicroUsd.toString(), input.openedAtMs, userId],
      );
      if (debited.length === 0) {
        throw new ArbError(
          "INSUFFICIENT_PAPER_BALANCE",
          "This paper account does not have enough simulated cash for that entry.",
          409,
        );
      }

      const rows = await tx.query(
        `insert into paper_positions (
           portfolio_id, token_mint, token_symbol, token_name, token_decimals, status,
           token_quantity_base_units, entry_cost_micro_usd, entry_slippage_bps,
           entry_price_impact_bps, entry_route, entry_quote_source,
           entry_quote_retrieved_at, entry_quote_expires_at, opened_at,
           client_request_id
         ) values (
           $1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $10::jsonb, $11,
           to_timestamp($12::double precision / 1000),
           to_timestamp($13::double precision / 1000),
           to_timestamp($14::double precision / 1000), $15
         ) returning *`,
        [
          portfolio.id,
          input.tokenMint,
          input.tokenSymbol,
          input.tokenName,
          input.tokenDecimals,
          input.tokenQuantityBaseUnits.toString(),
          input.entryCostMicroUsd.toString(),
          input.entrySlippageBps.toString(),
          input.entryPriceImpactBps.toString(),
          JSON.stringify(input.entryRoute),
          input.entryQuoteSource,
          input.entryQuoteRetrievedAtMs,
          input.entryQuoteExpiresAtMs,
          input.openedAtMs,
          input.clientRequestId,
        ],
      );
      return toLivePaperPosition(rows[0]!);
    });
  }

  async close(
    userId: string,
    positionId: string,
    input: CloseLivePaperPositionInput,
  ): Promise<LivePaperPositionRecord> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `select pp.*
           from paper_positions pp
           join portfolios p on p.id = pp.portfolio_id
          where pp.id = $1 and p.user_id = $2
          for update`,
        [positionId, userId],
      );
      if (!rows[0]) throw new ArbError("POSITION_NOT_FOUND", "Paper position not found", 404);
      const existing = toLivePaperPosition(rows[0]);
      if (existing.status === "closed") {
        throw new ArbError("POSITION_ALREADY_CLOSED", "This paper position is already closed", 409);
      }

      const realized = input.closeProceedsMicroUsd - existing.entryCostMicroUsd;
      const updated = await tx.query(
        `update paper_positions
            set status = 'closed',
                close_proceeds_micro_usd = $2,
                realized_pnl_micro_usd = $3,
                exit_slippage_bps = $4,
                exit_price_impact_bps = $5,
                exit_route = $6::jsonb,
                exit_quote_source = $7,
                exit_quote_retrieved_at = to_timestamp($8::double precision / 1000),
                exit_quote_expires_at = to_timestamp($9::double precision / 1000),
                closed_at = to_timestamp($10::double precision / 1000)
          where id = $1 and status = 'open'
          returning *`,
        [
          existing.id,
          input.closeProceedsMicroUsd.toString(),
          realized.toString(),
          input.exitSlippageBps.toString(),
          input.exitPriceImpactBps.toString(),
          JSON.stringify(input.exitRoute),
          input.exitQuoteSource,
          input.exitQuoteRetrievedAtMs,
          input.exitQuoteExpiresAtMs,
          input.closedAtMs,
        ],
      );
      if (!updated[0]) {
        throw new ArbError("POSITION_ALREADY_CLOSED", "This paper position is already closed", 409);
      }

      await tx.query(
        `update portfolios
            set cash_micro_usd = cash_micro_usd + $2,
                updated_at = to_timestamp($3::double precision / 1000)
          where id = $1`,
        [existing.portfolioId, input.closeProceedsMicroUsd.toString(), input.closedAtMs],
      );
      return toLivePaperPosition(updated[0]);
    });
  }
}

export class WatchlistRepository {
  constructor(private readonly db: SqlClient) {}

  async list(userId: string): Promise<WatchlistRecord[]> {
    const rows = await this.db.query(
      "select id, token_mint, created_at from watchlist_items where user_id = $1 order by created_at desc",
      [userId],
    );
    return rows.map((row) => ({
      id: readString(row.id),
      tokenMint: readString(row.token_mint),
      createdAtMs: readDateMs(row.created_at),
    }));
  }

  /** Adding twice is a no-op rather than an error — the unique index decides. */
  async add(userId: string, tokenMint: string): Promise<void> {
    await this.db.query(
      "insert into watchlist_items (user_id, token_mint) values ($1, $2) on conflict (user_id, token_mint) do nothing",
      [userId, tokenMint],
    );
  }

  async remove(userId: string, tokenMint: string): Promise<boolean> {
    const rows = await this.db.query(
      "delete from watchlist_items where user_id = $1 and token_mint = $2 returning id",
      [userId, tokenMint],
    );
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Alerting (migration 005)
// ---------------------------------------------------------------------------

export interface NotificationPreferences {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  deliveryMode: "immediate" | "hourly_digest" | "daily_digest";
  quietStartMin: number | null;
  quietEndMin: number | null;
  maxEmailsPerDay: number;
}

/** Defaults mirror the column defaults so an absent row behaves identically. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  inAppEnabled: true,
  emailEnabled: false,
  pushEnabled: false,
  deliveryMode: "immediate",
  quietStartMin: null,
  quietEndMin: null,
  maxEmailsPerDay: 20,
};

function readPreferences(row: SqlRow): NotificationPreferences {
  return {
    inAppEnabled: Boolean(row.in_app_enabled),
    emailEnabled: Boolean(row.email_enabled),
    pushEnabled: Boolean(row.push_enabled),
    deliveryMode: readString(row.delivery_mode) as NotificationPreferences["deliveryMode"],
    quietStartMin: row.quiet_start_min === null ? null : readInteger(row.quiet_start_min),
    quietEndMin: row.quiet_end_min === null ? null : readInteger(row.quiet_end_min),
    maxEmailsPerDay: readInteger(row.max_emails_per_day),
  };
}

export class NotificationPreferencesRepository {
  constructor(private readonly db: SqlClient) {}

  /**
   * Reading never writes. A user who has not touched their settings gets the
   * defaults without a row being created for them, so the table holds only
   * deliberate choices rather than one row per signup.
   */
  async get(userId: string): Promise<NotificationPreferences> {
    const rows = await this.db.query(
      `select in_app_enabled, email_enabled, push_enabled, delivery_mode,
              quiet_start_min, quiet_end_min, max_emails_per_day
         from notification_preferences where user_id = $1`,
      [userId],
    );
    return rows[0] ? readPreferences(rows[0]) : { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }

  /** Upsert of a complete preference set. Partial updates merge in the caller. */
  async put(userId: string, prefs: NotificationPreferences, nowMs: number): Promise<void> {
    await this.db.query(
      `insert into notification_preferences
         (user_id, in_app_enabled, email_enabled, push_enabled, delivery_mode,
          quiet_start_min, quiet_end_min, max_emails_per_day, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::double precision / 1000))
       on conflict (user_id) do update set
         in_app_enabled = excluded.in_app_enabled,
         email_enabled  = excluded.email_enabled,
         push_enabled   = excluded.push_enabled,
         delivery_mode  = excluded.delivery_mode,
         quiet_start_min = excluded.quiet_start_min,
         quiet_end_min   = excluded.quiet_end_min,
         max_emails_per_day = excluded.max_emails_per_day,
         updated_at     = excluded.updated_at`,
      [
        userId,
        prefs.inAppEnabled,
        prefs.emailEnabled,
        prefs.pushEnabled,
        prefs.deliveryMode,
        prefs.quietStartMin,
        prefs.quietEndMin,
        prefs.maxEmailsPerDay,
        nowMs,
      ],
    );
  }

  /** Emails already sent today, for the per-user daily cap. */
  async emailsSentSince(userId: string, sinceMs: number): Promise<number> {
    const rows = await this.db.query(
      `select count(*)::int as n from alert_events
        where user_id = $1 and email_sent_at >= to_timestamp($2::double precision / 1000)`,
      [userId, sinceMs],
    );
    return rows[0] ? readInteger(rows[0].n) : 0;
  }
}

export interface CreateAlertRuleInput {
  scope: "watchlist" | "mint";
  mint: string | null;
  kind: AlertKind;
  thresholdBps: bigint | null;
  direction: "above" | "below" | null;
  cooldownSeconds: number;
}

/** A rule paired with one concrete mint the worker should evaluate it against. */
export interface ResolvedAlertRule {
  rule: AlertRule;
  mint: string;
}

function readAlertRule(row: SqlRow): AlertRule {
  return {
    id: readString(row.id),
    userId: readString(row.user_id),
    scope: readString(row.scope) as AlertRule["scope"],
    mint: readNullableString(row.mint),
    kind: readString(row.kind) as AlertKind,
    thresholdBps: row.threshold_bps === null ? null : readBigInt(row.threshold_bps),
    direction: readNullableString(row.direction) as AlertRule["direction"],
    cooldownSeconds: readInteger(row.cooldown_seconds),
    enabled: Boolean(row.enabled),
  };
}

const RULE_COLUMNS = `id, user_id, scope, mint, kind, threshold_bps, direction, cooldown_seconds, enabled`;

export class AlertRuleRepository {
  constructor(private readonly db: SqlClient) {}

  async listForUser(userId: string): Promise<AlertRule[]> {
    const rows = await this.db.query(
      `select ${RULE_COLUMNS} from alert_rules where user_id = $1 order by created_at`,
      [userId],
    );
    return rows.map(readAlertRule);
  }

  async create(userId: string, input: CreateAlertRuleInput, nowMs: number): Promise<AlertRule> {
    const rows = await this.db.query(
      `insert into alert_rules
         (user_id, scope, mint, kind, threshold_bps, direction, cooldown_seconds, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7,
               to_timestamp($8::double precision / 1000),
               to_timestamp($8::double precision / 1000))
       returning ${RULE_COLUMNS}`,
      [
        userId,
        input.scope,
        input.mint,
        input.kind,
        input.thresholdBps?.toString() ?? null,
        input.direction,
        input.cooldownSeconds,
        nowMs,
      ],
    );
    return readAlertRule(rows[0]!);
  }

  /** Ownership is part of the predicate, never checked separately afterwards. */
  async setEnabled(userId: string, ruleId: string, enabled: boolean, nowMs: number): Promise<boolean> {
    const rows = await this.db.query(
      `update alert_rules set enabled = $3, updated_at = to_timestamp($4::double precision / 1000)
        where id = $2 and user_id = $1 returning id`,
      [userId, ruleId, enabled, nowMs],
    );
    return rows.length > 0;
  }

  async remove(userId: string, ruleId: string): Promise<boolean> {
    const rows = await this.db.query(
      `delete from alert_rules where id = $2 and user_id = $1 returning id`,
      [userId, ruleId],
    );
    return rows.length > 0;
  }

  /**
   * Every (rule, mint) pair the worker should evaluate this pass.
   *
   * Watchlist-scoped rules fan out across the user's watchlist, so adding a
   * token automatically inherits their existing rules instead of requiring the
   * rule to be recreated per token. Resolved in SQL rather than in the worker
   * because the join is what keeps this one query instead of N.
   */
  async resolveEnabled(limit = 5_000): Promise<ResolvedAlertRule[]> {
    const rows = await this.db.query(
      `select ${RULE_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ")}, w.token_mint as target_mint
         from alert_rules r
         join watchlist_items w on w.user_id = r.user_id
        where r.enabled and r.scope = 'watchlist'
        union all
       select ${RULE_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ")}, r.mint as target_mint
         from alert_rules r
        where r.enabled and r.scope = 'mint'
        limit $1`,
      [limit],
    );
    return rows.map((row) => ({ rule: readAlertRule(row), mint: readString(row.target_mint) }));
  }
}

export class AlertRuleStateRepository {
  constructor(private readonly db: SqlClient) {}

  async get(ruleId: string, mint: string): Promise<AlertRuleState | null> {
    const rows = await this.db.query(
      `select matched, last_value_bps, last_fired_at
         from alert_rule_state where rule_id = $1 and mint = $2`,
      [ruleId, mint],
    );
    if (!rows[0]) return null;
    return {
      matched: Boolean(rows[0].matched),
      lastValueBps: rows[0].last_value_bps === null ? null : readBigInt(rows[0].last_value_bps),
      lastFiredAtMs: readNullableDateMs(rows[0].last_fired_at),
    };
  }

  async put(ruleId: string, mint: string, state: AlertRuleState, nowMs: number): Promise<void> {
    await this.db.query(
      `insert into alert_rule_state (rule_id, mint, matched, last_value_bps, last_fired_at, updated_at)
       values ($1, $2, $3, $4,
               case when $5::double precision is null then null
                    else to_timestamp($5::double precision / 1000) end,
               to_timestamp($6::double precision / 1000))
       on conflict (rule_id, mint) do update set
         matched = excluded.matched,
         last_value_bps = excluded.last_value_bps,
         last_fired_at = excluded.last_fired_at,
         updated_at = excluded.updated_at`,
      [ruleId, mint, state.matched, state.lastValueBps?.toString() ?? null, state.lastFiredAtMs, nowMs],
    );
  }
}

export interface AlertEventRecord {
  id: string;
  mint: string;
  symbol: string | null;
  kind: string;
  title: string;
  reason: string;
  severity: string;
  firedAtMs: number;
  readAtMs: number | null;
}

export class AlertEventRepository {
  constructor(private readonly db: SqlClient) {}

  async insert(alert: FiredAlert, nowMs: number): Promise<string> {
    const rows = await this.db.query(
      `insert into alert_events (user_id, rule_id, mint, symbol, kind, title, reason, severity, fired_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::double precision / 1000))
       returning id`,
      [
        alert.userId,
        alert.ruleId,
        alert.mint,
        alert.symbol,
        alert.kind,
        alert.title,
        alert.reason,
        alert.severity,
        nowMs,
      ],
    );
    return readString(rows[0]!.id);
  }

  async listForUser(userId: string, limit = 50): Promise<AlertEventRecord[]> {
    const rows = await this.db.query(
      `select id, mint, symbol, kind, title, reason, severity, fired_at, read_at
         from alert_events where user_id = $1 order by fired_at desc limit $2`,
      [userId, limit],
    );
    return rows.map((row) => ({
      id: readString(row.id),
      mint: readString(row.mint),
      symbol: readNullableString(row.symbol),
      kind: readString(row.kind),
      title: readString(row.title),
      reason: readString(row.reason),
      severity: readString(row.severity),
      firedAtMs: readDateMs(row.fired_at),
      readAtMs: readNullableDateMs(row.read_at),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    const rows = await this.db.query(
      `select count(*)::int as n from alert_events where user_id = $1 and read_at is null`,
      [userId],
    );
    return rows[0] ? readInteger(rows[0].n) : 0;
  }

  async markAllRead(userId: string, nowMs: number): Promise<number> {
    const rows = await this.db.query(
      `update alert_events set read_at = to_timestamp($2::double precision / 1000)
        where user_id = $1 and read_at is null returning id`,
      [userId, nowMs],
    );
    return rows.length;
  }

  async markEmailSent(eventId: string, nowMs: number): Promise<void> {
    await this.db.query(
      `update alert_events set email_sent_at = to_timestamp($2::double precision / 1000) where id = $1`,
      [eventId, nowMs],
    );
  }
}
