import { createHash } from "node:crypto";
import { ArbError } from "../core/errors.js";
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
}

export interface OpenLivePaperPositionInput {
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
  };
}

function toUser(row: SqlRow): UserRecord {
  return {
    id: readString(row.id),
    email: readString(row.email),
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
      "select id, email, password_hash, created_at from users where lower(email) = lower($1)",
      [email],
    );
    const row = rows[0];
    return row ? { ...toUser(row), passwordHash: readString(row.password_hash) } : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.query("select id, email, created_at from users where id = $1", [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async create(email: string, passwordHash: string): Promise<UserRecord> {
    const rows = await this.db.query(
      "insert into users (email, password_hash) values ($1, $2) returning id, email, created_at",
      [email, passwordHash],
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
      `select u.id, u.email, u.created_at
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

  async deleteExpired(nowMs: number): Promise<number> {
    const rows = await this.db.query(
      "delete from sessions where expires_at <= to_timestamp($1::double precision / 1000) returning token_hash",
      [nowMs],
    );
    return rows.length;
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
           entry_quote_retrieved_at, entry_quote_expires_at, opened_at
         ) values (
           $1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $10::jsonb, $11,
           to_timestamp($12::double precision / 1000),
           to_timestamp($13::double precision / 1000),
           to_timestamp($14::double precision / 1000)
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
