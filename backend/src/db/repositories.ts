import { createHash } from "node:crypto";
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
