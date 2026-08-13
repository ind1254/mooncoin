import { createHash } from "node:crypto";
import { readBigInt, readDateMs, readString } from "./client.js";
function toUser(row) {
    return {
        id: readString(row.id),
        email: readString(row.email),
        createdAtMs: readDateMs(row.created_at),
    };
}
function toPortfolio(row) {
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
    db;
    constructor(db) {
        this.db = db;
    }
    /** Email comparison is case-insensitive, matching the unique index. */
    async findByEmail(email) {
        const rows = await this.db.query("select id, email, password_hash, created_at from users where lower(email) = lower($1)", [email]);
        const row = rows[0];
        return row ? { ...toUser(row), passwordHash: readString(row.password_hash) } : null;
    }
    async findById(id) {
        const rows = await this.db.query("select id, email, created_at from users where id = $1", [id]);
        return rows[0] ? toUser(rows[0]) : null;
    }
    async create(email, passwordHash) {
        const rows = await this.db.query("insert into users (email, password_hash) values ($1, $2) returning id, email, created_at", [email, passwordHash]);
        return toUser(rows[0]);
    }
}
/**
 * Sessions are stored as a SHA-256 of the token. The raw token lives only in
 * the user's cookie, so a database dump does not hand an attacker live logins.
 */
export function hashSessionToken(token) {
    return createHash("sha256").update(token).digest("hex");
}
export class SessionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async create(token, userId, expiresAtMs) {
        await this.db.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, to_timestamp($3::double precision / 1000))", [hashSessionToken(token), userId, expiresAtMs]);
    }
    /** Returns the owning user only if the session exists and has not expired. */
    async findValidUser(token, nowMs) {
        const rows = await this.db.query(`select u.id, u.email, u.created_at
         from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1
          and s.expires_at > to_timestamp($2::double precision / 1000)`, [hashSessionToken(token), nowMs]);
        return rows[0] ? toUser(rows[0]) : null;
    }
    async delete(token) {
        await this.db.query("delete from sessions where token_hash = $1", [hashSessionToken(token)]);
    }
    async deleteExpired(nowMs) {
        const rows = await this.db.query("delete from sessions where expires_at <= to_timestamp($1::double precision / 1000) returning token_hash", [nowMs]);
        return rows.length;
    }
}
export class PortfolioRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Create the user's default portfolio if it does not exist, and return it.
     *
     * Idempotent by construction: ON CONFLICT DO NOTHING against the partial
     * unique index means two concurrent first requests cannot both fund an
     * account. The database enforces "exactly once", not application logic —
     * which is the only thing that actually holds under a race.
     */
    async ensureDefault(userId, startingMicroUsd) {
        await this.db.query(`insert into portfolios (user_id, name, base_currency, cash_micro_usd, starting_micro_usd)
       values ($1, 'Default', 'USD', $2, $2)
       on conflict (user_id) where name = 'Default' do nothing`, [userId, startingMicroUsd.toString()]);
        const portfolio = await this.findDefault(userId);
        if (!portfolio)
            throw new Error("Portfolio initialization failed");
        return portfolio;
    }
    async findDefault(userId) {
        const rows = await this.db.query(`select id, user_id, name, base_currency, cash_micro_usd, starting_micro_usd, created_at, updated_at
         from portfolios where user_id = $1 and name = 'Default'`, [userId]);
        return rows[0] ? toPortfolio(rows[0]) : null;
    }
    /**
     * Ownership is part of the WHERE clause, not a separate check. A portfolio
     * id belonging to someone else simply returns nothing.
     */
    async findOwned(portfolioId, userId) {
        const rows = await this.db.query(`select id, user_id, name, base_currency, cash_micro_usd, starting_micro_usd, created_at, updated_at
         from portfolios where id = $1 and user_id = $2`, [portfolioId, userId]);
        return rows[0] ? toPortfolio(rows[0]) : null;
    }
}
export class WatchlistRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async list(userId) {
        const rows = await this.db.query("select id, token_mint, created_at from watchlist_items where user_id = $1 order by created_at desc", [userId]);
        return rows.map((row) => ({
            id: readString(row.id),
            tokenMint: readString(row.token_mint),
            createdAtMs: readDateMs(row.created_at),
        }));
    }
    /** Adding twice is a no-op rather than an error — the unique index decides. */
    async add(userId, tokenMint) {
        await this.db.query("insert into watchlist_items (user_id, token_mint) values ($1, $2) on conflict (user_id, token_mint) do nothing", [userId, tokenMint]);
    }
    async remove(userId, tokenMint) {
        const rows = await this.db.query("delete from watchlist_items where user_id = $1 and token_mint = $2 returning id", [userId, tokenMint]);
        return rows.length > 0;
    }
}
