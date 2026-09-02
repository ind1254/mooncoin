import { createHash } from "node:crypto";
import { ArbError } from "../core/errors.js";
import { PAPER_BOT_STRATEGY_VERSION, } from "../bot/types.js";
import { readBigInt, readDateMs, readString } from "./client.js";
function readInteger(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed))
        throw new Error("Expected an integer database value");
    return parsed;
}
function readNullableDateMs(value) {
    return value === null || value === undefined ? null : readDateMs(value);
}
function readNullableString(value) {
    return value === null || value === undefined ? null : readString(value);
}
function readBoolean(value) {
    if (typeof value === "boolean")
        return value;
    if (value === "true" || value === 1 || value === "1")
        return true;
    if (value === "false" || value === 0 || value === "0")
        return false;
    throw new Error("Expected a boolean database value");
}
function readJsonObject(value) {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected a JSON object");
    }
    return parsed;
}
function readRoute(value) {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error("Expected a JSON route-label array");
    }
    return parsed;
}
function toLivePaperPosition(row) {
    const status = readString(row.status);
    if (status !== "open" && status !== "closed")
        throw new Error("Unexpected paper-position status");
    const openedBy = readString(row.opened_by);
    if (openedBy !== "manual" && openedBy !== "paper_bot")
        throw new Error("Unexpected paper-position origin");
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
        closeProceedsMicroUsd: row.close_proceeds_micro_usd === null || row.close_proceeds_micro_usd === undefined
            ? null
            : readBigInt(row.close_proceeds_micro_usd),
        realizedPnlMicroUsd: row.realized_pnl_micro_usd === null || row.realized_pnl_micro_usd === undefined
            ? null
            : readBigInt(row.realized_pnl_micro_usd),
        exitSlippageBps: row.exit_slippage_bps === null || row.exit_slippage_bps === undefined
            ? null
            : readBigInt(row.exit_slippage_bps),
        exitPriceImpactBps: row.exit_price_impact_bps === null || row.exit_price_impact_bps === undefined
            ? null
            : readBigInt(row.exit_price_impact_bps),
        exitRoute: row.exit_route === null || row.exit_route === undefined ? null : readRoute(row.exit_route),
        exitQuoteSource: readNullableString(row.exit_quote_source),
        exitQuoteRetrievedAtMs: readNullableDateMs(row.exit_quote_retrieved_at),
        exitQuoteExpiresAtMs: readNullableDateMs(row.exit_quote_expires_at),
        closedAtMs: readNullableDateMs(row.closed_at),
        clientRequestId: readNullableString(row.client_request_id),
        openedBy,
        botConfigId: readNullableString(row.bot_config_id),
    };
}
/** Opaque database identity: raw emails and user ids never enter limit rows. */
export function hashRateLimitSubject(subject) {
    return createHash("sha256").update(subject.trim().toLowerCase()).digest("hex");
}
/**
 * Postgres-backed fixed-window limiter shared by every serverless instance.
 * The upsert is atomic, so concurrent requests cannot each observe a stale
 * count and slip through together.
 */
export class RateLimitRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async consume(scope, subject, limit, windowMs, nowMs) {
        const subjectHash = hashRateLimitSubject(subject);
        const windowStartedAtMs = Math.floor(nowMs / windowMs) * windowMs;
        const resetAtMs = windowStartedAtMs + windowMs;
        return this.db.transaction(async (tx) => {
            // The expiry index makes this cheap and also bounds rows created by an
            // identifier-spraying attacker, not only repeat callers.
            await tx.query(`delete from rate_limit_buckets
          where expires_at <= to_timestamp($1::double precision / 1000)`, [nowMs]);
            const rows = await tx.query(`insert into rate_limit_buckets (
           scope, subject_hash, window_started_at, request_count, expires_at
         ) values (
           $1, $2, to_timestamp($3::double precision / 1000), 1,
           to_timestamp($4::double precision / 1000)
         )
         on conflict (scope, subject_hash, window_started_at)
         do update set request_count = rate_limit_buckets.request_count + 1,
                       expires_at = excluded.expires_at
         returning request_count`, [scope, subjectHash, windowStartedAtMs, resetAtMs]);
            const count = readInteger(rows[0].request_count);
            if (count > limit) {
                const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000));
                throw new ArbError("RATE_LIMITED", `Too many requests. Try again in ${retryAfterSeconds} seconds.`, 429, { retryAfterSeconds, limit, resetAtMs });
            }
            return { limit, remaining: limit - count, resetAtMs };
        });
    }
}
function toUser(row) {
    return {
        id: readString(row.id),
        email: readString(row.email),
        emailVerifiedAtMs: readNullableDateMs(row.email_verified_at),
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
        const rows = await this.db.query("select id, email, password_hash, email_verified_at, created_at from users where lower(email) = lower($1)", [email]);
        const row = rows[0];
        return row ? { ...toUser(row), passwordHash: readString(row.password_hash) } : null;
    }
    async findById(id) {
        const rows = await this.db.query("select id, email, email_verified_at, created_at from users where id = $1", [id]);
        return rows[0] ? toUser(rows[0]) : null;
    }
    async create(email, passwordHash, emailVerifiedAtMs = Date.now()) {
        const rows = await this.db.query(`insert into users (email, password_hash, email_verified_at)
       values ($1, $2, case when $3::double precision is null then null else to_timestamp($3 / 1000) end)
       returning id, email, email_verified_at, created_at`, [email.trim().toLowerCase(), passwordHash, emailVerifiedAtMs]);
        return toUser(rows[0]);
    }
}
/** Stable, database-pinned identity for a private single-owner deployment. */
export class OwnerRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async get() {
        const rows = await this.db.query(`select u.id, u.email, u.email_verified_at, u.created_at
         from app_owner o
         join users u on u.id = o.user_id
        where o.singleton = true`);
        return rows[0] ? toUser(rows[0]) : null;
    }
    /** Assigns the enabled-bot account when present, otherwise the original account. */
    async getOrAssign() {
        await this.db.query(`insert into app_owner (singleton, user_id)
       select true, u.id
         from users u
         left join paper_bot_configs c on c.user_id = u.id
        order by coalesce(c.enabled, false) desc, u.created_at asc, u.id asc
        limit 1
       on conflict (singleton) do nothing`);
        return this.get();
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
        const rows = await this.db.query(`select u.id, u.email, u.email_verified_at, u.created_at
         from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1
          and s.expires_at > to_timestamp($2::double precision / 1000)`, [hashSessionToken(token), nowMs]);
        return rows[0] ? toUser(rows[0]) : null;
    }
    async delete(token) {
        await this.db.query("delete from sessions where token_hash = $1", [hashSessionToken(token)]);
    }
    async deleteForUser(userId) {
        const rows = await this.db.query("delete from sessions where user_id = $1 returning token_hash", [userId]);
        return rows.length;
    }
    async deleteExpired(nowMs) {
        const rows = await this.db.query("delete from sessions where expires_at <= to_timestamp($1::double precision / 1000) returning token_hash", [nowMs]);
        return rows.length;
    }
}
export function hashAccountActionToken(token) {
    return createHash("sha256").update(token).digest("hex");
}
/**
 * Short-lived account actions use one-time bearer tokens. Issuance revokes
 * older tokens for the same purpose; consumption and the protected mutation
 * happen in one transaction so concurrent replays cannot both succeed.
 */
export class AccountActionTokenRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async issue(userId, purpose, rawToken, nowMs, expiresAtMs) {
        return this.db.transaction(async (tx) => {
            await tx.query(`update account_action_tokens
            set consumed_at = to_timestamp($3::double precision / 1000)
          where user_id = $1 and purpose = $2 and consumed_at is null`, [userId, purpose, nowMs]);
            const rows = await tx.query(`insert into account_action_tokens (user_id, purpose, token_hash, created_at, expires_at)
         values (
           $1, $2, $3,
           to_timestamp($4::double precision / 1000),
           to_timestamp($5::double precision / 1000)
         ) returning id`, [userId, purpose, hashAccountActionToken(rawToken), nowMs, expiresAtMs]);
            return readString(rows[0].id);
        });
    }
    async verifyEmail(rawToken, nowMs) {
        return this.db.transaction(async (tx) => {
            const rows = await tx.query(`select a.id as action_id, u.id, u.email, u.email_verified_at, u.created_at
           from account_action_tokens a
           join users u on u.id = a.user_id
          where a.token_hash = $1 and a.purpose = 'verify_email'
            and a.consumed_at is null
            and a.expires_at > to_timestamp($2::double precision / 1000)
          for update`, [hashAccountActionToken(rawToken), nowMs]);
            if (!rows[0])
                return null;
            await tx.query(`update users
            set email_verified_at = to_timestamp($2::double precision / 1000),
                updated_at = to_timestamp($2::double precision / 1000)
          where id = $1`, [readString(rows[0].id), nowMs]);
            await tx.query(`update account_action_tokens
            set consumed_at = to_timestamp($2::double precision / 1000)
          where id = $1 and consumed_at is null`, [readString(rows[0].action_id), nowMs]);
            return { ...toUser(rows[0]), emailVerifiedAtMs: nowMs };
        });
    }
    async resetPassword(rawToken, passwordHash, nowMs) {
        return this.db.transaction(async (tx) => {
            const rows = await tx.query(`select a.id as action_id, u.id, u.email, u.email_verified_at, u.created_at
           from account_action_tokens a
           join users u on u.id = a.user_id
          where a.token_hash = $1 and a.purpose = 'reset_password'
            and a.consumed_at is null
            and a.expires_at > to_timestamp($2::double precision / 1000)
          for update`, [hashAccountActionToken(rawToken), nowMs]);
            if (!rows[0])
                return null;
            const userId = readString(rows[0].id);
            await tx.query(`update users
            set password_hash = $2,
                updated_at = to_timestamp($3::double precision / 1000)
          where id = $1`, [userId, passwordHash, nowMs]);
            await tx.query(`update account_action_tokens
            set consumed_at = to_timestamp($2::double precision / 1000)
          where id = $1 and consumed_at is null`, [readString(rows[0].action_id), nowMs]);
            // A password change is an account-recovery boundary. Every browser must
            // authenticate again, including a session an attacker may have stolen.
            await tx.query("delete from sessions where user_id = $1", [userId]);
            return toUser(rows[0]);
        });
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
/**
 * Atomic persistence for live-quote paper positions.
 *
 * The portfolio row is locked before cash or position state changes. That
 * makes concurrent opens respect the cash/position limits and guarantees two
 * close requests can never credit the same simulated proceeds twice.
 */
export class LivePaperPositionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async findByClientRequestId(userId, clientRequestId) {
        const rows = await this.db.query(`select pp.*
         from paper_positions pp
         join portfolios p on p.id = pp.portfolio_id
        where pp.client_request_id = $1 and p.user_id = $2`, [clientRequestId, userId]);
        return rows[0] ? toLivePaperPosition(rows[0]) : null;
    }
    async findOwned(userId, positionId) {
        const rows = await this.db.query(`select pp.*
         from paper_positions pp
         join portfolios p on p.id = pp.portfolio_id
        where pp.id = $1 and p.user_id = $2`, [positionId, userId]);
        return rows[0] ? toLivePaperPosition(rows[0]) : null;
    }
    async listForUser(userId) {
        const rows = await this.db.query(`select pp.*
         from paper_positions pp
         join portfolios p on p.id = pp.portfolio_id
        where p.user_id = $1
        order by pp.opened_at desc`, [userId]);
        return rows.map(toLivePaperPosition);
    }
    async listOpenForBot(configId) {
        const rows = await this.db.query(`select pp.*
         from paper_positions pp
        where pp.bot_config_id = $1
          and pp.opened_by = 'paper_bot'
          and pp.status = 'open'
        order by pp.opened_at asc`, [configId]);
        return rows.map(toLivePaperPosition);
    }
    async hasBotPositionSince(configId, tokenMint, sinceMs) {
        const rows = await this.db.query(`select 1
         from paper_positions
        where bot_config_id = $1
          and opened_by = 'paper_bot'
          and token_mint = $2
          and opened_at >= to_timestamp($3::double precision / 1000)
        limit 1`, [configId, tokenMint, sinceMs]);
        return rows.length > 0;
    }
    async open(userId, startingMicroUsd, maxOpenPositions, input) {
        return this.db.transaction(async (tx) => {
            const portfolio = await new PortfolioRepository(tx).ensureDefault(userId, startingMicroUsd);
            await tx.query("select id from portfolios where id = $1 and user_id = $2 for update", [portfolio.id, userId]);
            if (input.openedBy === "paper_bot") {
                if (!input.botConfigId || input.maxBotOpenPositions === null) {
                    throw new ArbError("INTERNAL_ERROR", "Paper-bot metadata is incomplete.", 500);
                }
                // Locking the config serializes concurrent worker instances and makes
                // disabling the bot win before any later automatic debit can commit.
                const botConfig = await tx.query(`select id from paper_bot_configs
            where id = $1 and user_id = $2 and enabled = true
            for update`, [input.botConfigId, userId]);
                if (!botConfig[0]) {
                    throw new ArbError("PAPER_BOT_DISABLED", "The paper bot was disabled before this entry could open.", 409);
                }
                const botCounts = await tx.query(`select count(*)::text as count
             from paper_positions
            where bot_config_id = $1 and opened_by = 'paper_bot' and status = 'open'`, [input.botConfigId]);
                if (Number(botCounts[0]?.count ?? "0") >= input.maxBotOpenPositions) {
                    throw new ArbError("POSITION_LIMIT_REACHED", "The paper bot reached its open-position limit.", 409);
                }
            }
            else if (input.botConfigId !== null || input.maxBotOpenPositions !== null) {
                throw new ArbError("INTERNAL_ERROR", "Manual paper entries cannot carry paper-bot metadata.", 500);
            }
            const replay = await tx.query("select * from paper_positions where portfolio_id = $1 and client_request_id = $2", [portfolio.id, input.clientRequestId]);
            if (replay[0]) {
                const existing = toLivePaperPosition(replay[0]);
                if (existing.tokenMint !== input.tokenMint ||
                    existing.entryCostMicroUsd !== input.entryCostMicroUsd ||
                    existing.entrySlippageBps !== input.entrySlippageBps ||
                    existing.openedBy !== input.openedBy ||
                    existing.botConfigId !== input.botConfigId) {
                    throw new ArbError("VALIDATION_ERROR", "That paper request id was already used for a different entry.", 409);
                }
                return existing;
            }
            const counts = await tx.query("select count(*)::text as count from paper_positions where portfolio_id = $1 and status = 'open'", [portfolio.id]);
            if (Number(counts[0]?.count ?? "0") >= maxOpenPositions) {
                throw new ArbError("POSITION_LIMIT_REACHED", `Close an existing paper position before opening more than ${maxOpenPositions}.`, 409);
            }
            const debited = await tx.query(`update portfolios
            set cash_micro_usd = cash_micro_usd - $2,
                updated_at = to_timestamp($3::double precision / 1000)
          where id = $1 and user_id = $4 and cash_micro_usd >= $2
          returning id`, [portfolio.id, input.entryCostMicroUsd.toString(), input.openedAtMs, userId]);
            if (debited.length === 0) {
                throw new ArbError("INSUFFICIENT_PAPER_BALANCE", "This paper account does not have enough simulated cash for that entry.", 409);
            }
            const rows = await tx.query(`insert into paper_positions (
           portfolio_id, token_mint, token_symbol, token_name, token_decimals, status,
           token_quantity_base_units, entry_cost_micro_usd, entry_slippage_bps,
           entry_price_impact_bps, entry_route, entry_quote_source,
           entry_quote_retrieved_at, entry_quote_expires_at, opened_at,
            client_request_id, opened_by, bot_config_id
          ) values (
           $1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $10::jsonb, $11,
           to_timestamp($12::double precision / 1000),
           to_timestamp($13::double precision / 1000),
            to_timestamp($14::double precision / 1000), $15, $16, $17
         ) returning *`, [
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
                input.openedBy,
                input.botConfigId,
            ]);
            return toLivePaperPosition(rows[0]);
        });
    }
    async close(userId, positionId, input, botConfigId = null) {
        return this.db.transaction(async (tx) => {
            const rows = await tx.query(`select pp.*
           from paper_positions pp
           join portfolios p on p.id = pp.portfolio_id
          where pp.id = $1 and p.user_id = $2
          for update`, [positionId, userId]);
            if (!rows[0])
                throw new ArbError("POSITION_NOT_FOUND", "Paper position not found", 404);
            const existing = toLivePaperPosition(rows[0]);
            if (existing.status === "closed") {
                throw new ArbError("POSITION_ALREADY_CLOSED", "This paper position is already closed", 409);
            }
            if (botConfigId !== null) {
                if (existing.openedBy !== "paper_bot" || existing.botConfigId !== botConfigId) {
                    throw new ArbError("FORBIDDEN", "This position is not managed by that paper bot.", 403);
                }
                const enabled = await tx.query("select id from paper_bot_configs where id = $1 and user_id = $2 and enabled = true for update", [botConfigId, userId]);
                if (!enabled[0]) {
                    throw new ArbError("PAPER_BOT_DISABLED", "The paper bot was disabled before this close could commit.", 409);
                }
            }
            const realized = input.closeProceedsMicroUsd - existing.entryCostMicroUsd;
            const updated = await tx.query(`update paper_positions
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
          returning *`, [
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
            ]);
            if (!updated[0]) {
                throw new ArbError("POSITION_ALREADY_CLOSED", "This paper position is already closed", 409);
            }
            await tx.query(`update portfolios
            set cash_micro_usd = cash_micro_usd + $2,
                updated_at = to_timestamp($3::double precision / 1000)
          where id = $1`, [existing.portfolioId, input.closeProceedsMicroUsd.toString(), input.closedAtMs]);
            return toLivePaperPosition(updated[0]);
        });
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
// ---------------------------------------------------------------------------
// Per-account preferences (migration 015)
// ---------------------------------------------------------------------------
export class UserSettingsRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async get(userId) {
        const rows = await this.db.query("select settings from user_settings where user_id = $1", [userId]);
        return rows[0] ? readJsonObject(rows[0].settings) : null;
    }
    async put(userId, settings, nowMs) {
        await this.db.query(`insert into user_settings (user_id, settings, updated_at)
       values ($1, $2::jsonb, to_timestamp($3::double precision / 1000))
       on conflict (user_id) do update set
         settings = excluded.settings,
         updated_at = excluded.updated_at`, [userId, JSON.stringify(settings), nowMs]);
    }
}
/** Defaults mirror the column defaults so an absent row behaves identically. */
export const DEFAULT_NOTIFICATION_PREFERENCES = {
    inAppEnabled: true,
    emailEnabled: false,
    pushEnabled: false,
    deliveryMode: "immediate",
    quietStartMin: null,
    quietEndMin: null,
    maxEmailsPerDay: 20,
};
function readPreferences(row) {
    return {
        inAppEnabled: Boolean(row.in_app_enabled),
        emailEnabled: Boolean(row.email_enabled),
        pushEnabled: Boolean(row.push_enabled),
        deliveryMode: readString(row.delivery_mode),
        quietStartMin: row.quiet_start_min === null ? null : readInteger(row.quiet_start_min),
        quietEndMin: row.quiet_end_min === null ? null : readInteger(row.quiet_end_min),
        maxEmailsPerDay: readInteger(row.max_emails_per_day),
    };
}
export class NotificationPreferencesRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Reading never writes. A user who has not touched their settings gets the
     * defaults without a row being created for them, so the table holds only
     * deliberate choices rather than one row per signup.
     */
    async get(userId) {
        const rows = await this.db.query(`select in_app_enabled, email_enabled, push_enabled, delivery_mode,
              quiet_start_min, quiet_end_min, max_emails_per_day
         from notification_preferences where user_id = $1`, [userId]);
        return rows[0] ? readPreferences(rows[0]) : { ...DEFAULT_NOTIFICATION_PREFERENCES };
    }
    /** Upsert of a complete preference set. Partial updates merge in the caller. */
    async put(userId, prefs, nowMs) {
        await this.db.query(`insert into notification_preferences
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
         updated_at     = excluded.updated_at`, [
            userId,
            prefs.inAppEnabled,
            prefs.emailEnabled,
            prefs.pushEnabled,
            prefs.deliveryMode,
            prefs.quietStartMin,
            prefs.quietEndMin,
            prefs.maxEmailsPerDay,
            nowMs,
        ]);
    }
    /** Emails already sent today, for the per-user daily cap. */
    async emailsSentSince(userId, sinceMs) {
        const rows = await this.db.query(`select count(*)::int as n from alert_events
        where user_id = $1 and email_sent_at >= to_timestamp($2::double precision / 1000)`, [userId, sinceMs]);
        return rows[0] ? readInteger(rows[0].n) : 0;
    }
}
function readAlertRule(row) {
    return {
        id: readString(row.id),
        userId: readString(row.user_id),
        scope: readString(row.scope),
        mint: readNullableString(row.mint),
        kind: readString(row.kind),
        thresholdBps: row.threshold_bps === null ? null : readBigInt(row.threshold_bps),
        direction: readNullableString(row.direction),
        cooldownSeconds: readInteger(row.cooldown_seconds),
        enabled: Boolean(row.enabled),
    };
}
const RULE_COLUMNS = `id, user_id, scope, mint, kind, threshold_bps, direction, cooldown_seconds, enabled`;
export class AlertRuleRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async listForUser(userId) {
        const rows = await this.db.query(`select ${RULE_COLUMNS} from alert_rules where user_id = $1 order by created_at`, [userId]);
        return rows.map(readAlertRule);
    }
    async create(userId, input, nowMs) {
        const rows = await this.db.query(`insert into alert_rules
         (user_id, scope, mint, kind, threshold_bps, direction, cooldown_seconds, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7,
               to_timestamp($8::double precision / 1000),
               to_timestamp($8::double precision / 1000))
       returning ${RULE_COLUMNS}`, [
            userId,
            input.scope,
            input.mint,
            input.kind,
            input.thresholdBps?.toString() ?? null,
            input.direction,
            input.cooldownSeconds,
            nowMs,
        ]);
        return readAlertRule(rows[0]);
    }
    /** Ownership is part of the predicate, never checked separately afterwards. */
    async setEnabled(userId, ruleId, enabled, nowMs) {
        const rows = await this.db.query(`update alert_rules set enabled = $3, updated_at = to_timestamp($4::double precision / 1000)
        where id = $2 and user_id = $1 returning id`, [userId, ruleId, enabled, nowMs]);
        return rows.length > 0;
    }
    async remove(userId, ruleId) {
        const rows = await this.db.query(`delete from alert_rules where id = $2 and user_id = $1 returning id`, [userId, ruleId]);
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
    async resolveEnabled(limit = 5_000) {
        const rows = await this.db.query(`select ${RULE_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ")}, w.token_mint as target_mint
         from alert_rules r
         join watchlist_items w on w.user_id = r.user_id
        where r.enabled and r.scope = 'watchlist'
        union all
       select ${RULE_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ")}, r.mint as target_mint
         from alert_rules r
        where r.enabled and r.scope = 'mint'
        limit $1`, [limit]);
        return rows.map((row) => ({ rule: readAlertRule(row), mint: readString(row.target_mint) }));
    }
}
export class AlertRuleStateRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async get(ruleId, mint) {
        const rows = await this.db.query(`select matched, last_value_bps, last_fired_at
         from alert_rule_state where rule_id = $1 and mint = $2`, [ruleId, mint]);
        if (!rows[0])
            return null;
        return {
            matched: Boolean(rows[0].matched),
            lastValueBps: rows[0].last_value_bps === null ? null : readBigInt(rows[0].last_value_bps),
            lastFiredAtMs: readNullableDateMs(rows[0].last_fired_at),
        };
    }
    async put(ruleId, mint, state, nowMs) {
        await this.db.query(`insert into alert_rule_state (rule_id, mint, matched, last_value_bps, last_fired_at, updated_at)
       values ($1, $2, $3, $4,
               case when $5::double precision is null then null
                    else to_timestamp($5::double precision / 1000) end,
               to_timestamp($6::double precision / 1000))
       on conflict (rule_id, mint) do update set
         matched = excluded.matched,
         last_value_bps = excluded.last_value_bps,
         last_fired_at = excluded.last_fired_at,
         updated_at = excluded.updated_at`, [ruleId, mint, state.matched, state.lastValueBps?.toString() ?? null, state.lastFiredAtMs, nowMs]);
    }
}
export class AlertEventRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insert(alert, nowMs) {
        const rows = await this.db.query(`insert into alert_events (user_id, rule_id, mint, symbol, kind, title, reason, severity, fired_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::double precision / 1000))
       returning id`, [
            alert.userId,
            alert.ruleId,
            alert.mint,
            alert.symbol,
            alert.kind,
            alert.title,
            alert.reason,
            alert.severity,
            nowMs,
        ]);
        return readString(rows[0].id);
    }
    async listForUser(userId, limit = 50) {
        const rows = await this.db.query(`select id, mint, symbol, kind, title, reason, severity, fired_at, read_at
         from alert_events where user_id = $1 order by fired_at desc limit $2`, [userId, limit]);
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
    async unreadCount(userId) {
        const rows = await this.db.query(`select count(*)::int as n from alert_events where user_id = $1 and read_at is null`, [userId]);
        return rows[0] ? readInteger(rows[0].n) : 0;
    }
    async markAllRead(userId, nowMs) {
        const rows = await this.db.query(`update alert_events set read_at = to_timestamp($2::double precision / 1000)
        where user_id = $1 and read_at is null returning id`, [userId, nowMs]);
        return rows.length;
    }
    async markEmailSent(eventId, nowMs) {
        await this.db.query(`update alert_events set email_sent_at = to_timestamp($2::double precision / 1000) where id = $1`, [eventId, nowMs]);
    }
}
/** Latest observed snapshot per mint, diffed by the alert worker (migration 006). */
export class TokenObservationRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /** One query for every mint in the pass; N round trips would dominate it. */
    async getMany(mints) {
        if (mints.length === 0)
            return new Map();
        const rows = await this.db.query(`select mint, price_pico_usd, liquidity_usd_micro, volume_24h_usd_micro,
              wallet_concentration_bps, mint_authority_revoked, freeze_authority_revoked,
              observed_at
         from token_observations where mint = any($1)`, [mints]);
        const out = new Map();
        for (const row of rows) {
            const nullableBig = (v) => (v === null ? null : readBigInt(v));
            const nullableBool = (v) => (v === null ? null : Boolean(v));
            out.set(readString(row.mint), {
                mint: readString(row.mint),
                pricePicoUsd: nullableBig(row.price_pico_usd),
                liquidityUsdMicro: nullableBig(row.liquidity_usd_micro),
                volume24hUsdMicro: nullableBig(row.volume_24h_usd_micro),
                walletConcentrationBps: nullableBig(row.wallet_concentration_bps),
                mintAuthorityRevoked: nullableBool(row.mint_authority_revoked),
                freezeAuthorityRevoked: nullableBool(row.freeze_authority_revoked),
                observedAtMs: readDateMs(row.observed_at),
            });
        }
        return out;
    }
    async put(snapshot, nowMs) {
        await this.db.query(`insert into token_observations
         (mint, price_pico_usd, liquidity_usd_micro, volume_24h_usd_micro,
          wallet_concentration_bps, mint_authority_revoked, freeze_authority_revoked,
          observed_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7,
               to_timestamp($8::double precision / 1000),
               to_timestamp($9::double precision / 1000))
       on conflict (mint) do update set
         price_pico_usd = excluded.price_pico_usd,
         liquidity_usd_micro = excluded.liquidity_usd_micro,
         volume_24h_usd_micro = excluded.volume_24h_usd_micro,
         wallet_concentration_bps = excluded.wallet_concentration_bps,
         mint_authority_revoked = excluded.mint_authority_revoked,
         freeze_authority_revoked = excluded.freeze_authority_revoked,
         observed_at = excluded.observed_at,
         updated_at = excluded.updated_at`, [
            snapshot.mint,
            snapshot.pricePicoUsd?.toString() ?? null,
            snapshot.liquidityUsdMicro?.toString() ?? null,
            snapshot.volume24hUsdMicro?.toString() ?? null,
            snapshot.walletConcentrationBps?.toString() ?? null,
            snapshot.mintAuthorityRevoked,
            snapshot.freezeAuthorityRevoked,
            snapshot.observedAtMs,
            nowMs,
        ]);
    }
}
function toPaperBotConfig(row) {
    const strategyVersion = readString(row.strategy_version);
    if (strategyVersion !== PAPER_BOT_STRATEGY_VERSION)
        throw new Error("Unexpected paper-bot strategy version");
    const lastRunStatus = readNullableString(row.last_run_status);
    if (lastRunStatus !== null && !["ok", "degraded", "error"].includes(lastRunStatus)) {
        throw new Error("Unexpected paper-bot run status");
    }
    return {
        id: readString(row.id),
        userId: readString(row.user_id),
        enabled: readBoolean(row.enabled),
        strategyVersion,
        tradeSizeMicroUsd: readBigInt(row.trade_size_micro_usd),
        minQualityScore: readInteger(row.min_quality_score),
        maxRiskScore: readInteger(row.max_risk_score),
        minLiquidityMicroUsd: readBigInt(row.min_liquidity_micro_usd),
        maxPriceImpactBps: readBigInt(row.max_price_impact_bps),
        slippageBps: readBigInt(row.slippage_bps),
        maxOpenPositions: readInteger(row.max_open_positions),
        takeProfitBps: readBigInt(row.take_profit_bps),
        stopLossBps: readBigInt(row.stop_loss_bps),
        trailingStopBps: readBigInt(row.trailing_stop_bps),
        maxHoldMinutes: readInteger(row.max_hold_minutes),
        cooldownMinutes: readInteger(row.cooldown_minutes),
        lastRunAtMs: readNullableDateMs(row.last_run_at),
        lastRunStatus: lastRunStatus,
        lastRunSummary: readNullableString(row.last_run_summary),
        createdAtMs: readDateMs(row.created_at),
        updatedAtMs: readDateMs(row.updated_at),
    };
}
export class PaperBotConfigRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async ensureDefault(userId, nowMs) {
        const rows = await this.db.query(`insert into paper_bot_configs (user_id, created_at, updated_at)
       values ($1, to_timestamp($2::double precision / 1000), to_timestamp($2::double precision / 1000))
       on conflict (user_id) do update set user_id = excluded.user_id
       returning *`, [userId, nowMs]);
        return toPaperBotConfig(rows[0]);
    }
    async findById(configId) {
        const rows = await this.db.query("select * from paper_bot_configs where id = $1", [configId]);
        return rows[0] ? toPaperBotConfig(rows[0]) : null;
    }
    async listEnabled(limit = 100) {
        const rows = await this.db.query(`select * from paper_bot_configs
        where enabled = true
        order by updated_at asc
        limit $1`, [limit]);
        return rows.map(toPaperBotConfig);
    }
    async save(userId, enabled, strategy, nowMs) {
        const rows = await this.db.query(`update paper_bot_configs set
         enabled = $2,
         trade_size_micro_usd = $3,
         min_quality_score = $4,
         max_risk_score = $5,
         min_liquidity_micro_usd = $6,
         max_price_impact_bps = $7,
         slippage_bps = $8,
         max_open_positions = $9,
         take_profit_bps = $10,
         stop_loss_bps = $11,
         trailing_stop_bps = $12,
         max_hold_minutes = $13,
         cooldown_minutes = $14,
         updated_at = to_timestamp($15::double precision / 1000)
       where user_id = $1
       returning *`, [
            userId,
            enabled,
            strategy.tradeSizeMicroUsd.toString(),
            strategy.minQualityScore,
            strategy.maxRiskScore,
            strategy.minLiquidityMicroUsd.toString(),
            strategy.maxPriceImpactBps.toString(),
            strategy.slippageBps.toString(),
            strategy.maxOpenPositions,
            strategy.takeProfitBps.toString(),
            strategy.stopLossBps.toString(),
            strategy.trailingStopBps.toString(),
            strategy.maxHoldMinutes,
            strategy.cooldownMinutes,
            nowMs,
        ]);
        if (!rows[0])
            throw new ArbError("PAPER_BOT_NOT_FOUND", "Paper-bot settings were not initialized.", 404);
        return toPaperBotConfig(rows[0]);
    }
    async markRun(configId, status, summary, nowMs) {
        await this.db.query(`update paper_bot_configs set
         last_run_at = to_timestamp($2::double precision / 1000),
         last_run_status = $3,
         last_run_summary = left($4, 500)
       where id = $1`, [configId, nowMs, status, summary]);
    }
}
function toPaperBotDecision(row) {
    const action = readString(row.action);
    const actions = [
        "opened",
        "entry_rejected",
        "closed",
        "exit_unavailable",
        "scan_empty",
        "error",
    ];
    if (!actions.includes(action))
        throw new Error("Unexpected paper-bot decision action");
    return {
        id: readString(row.id),
        configId: readString(row.config_id),
        positionId: readNullableString(row.position_id),
        tokenMint: readNullableString(row.token_mint),
        tokenSymbol: readNullableString(row.token_symbol),
        action: action,
        qualityScore: row.quality_score === null ? null : readInteger(row.quality_score),
        riskScore: row.risk_score === null ? null : readInteger(row.risk_score),
        reason: readString(row.reason),
        snapshot: readJsonObject(row.snapshot),
        createdAtMs: readDateMs(row.created_at),
    };
}
export class PaperBotDecisionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async create(input) {
        const rows = await this.db.query(`insert into paper_bot_decisions (
         config_id, position_id, token_mint, token_symbol, action,
         quality_score, risk_score, reason, snapshot, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7, left($8, 500), $9::jsonb,
                 to_timestamp($10::double precision / 1000))
       returning *`, [
            input.configId,
            input.positionId ?? null,
            input.tokenMint ?? null,
            input.tokenSymbol ?? null,
            input.action,
            input.qualityScore ?? null,
            input.riskScore ?? null,
            input.reason,
            JSON.stringify(input.snapshot ?? {}),
            input.createdAtMs,
        ]);
        return toPaperBotDecision(rows[0]);
    }
    async listForUser(userId, limit = 30) {
        const rows = await this.db.query(`select d.*
         from paper_bot_decisions d
         join paper_bot_configs c on c.id = d.config_id
        where c.user_id = $1
        order by d.created_at desc, d.id desc
        limit $2`, [userId, limit]);
        return rows.map(toPaperBotDecision);
    }
    /**
     * Stable chronological polling window. UUID breaks ties when a worker writes
     * more than one decision at the same millisecond.
     */
    async listForUserAfter(userId, afterCreatedAtMs, afterId, limit = 50) {
        const rows = await this.db.query(`select d.*
         from paper_bot_decisions d
         join paper_bot_configs c on c.id = d.config_id
        where c.user_id = $1
          and (
            d.created_at > to_timestamp($2::double precision / 1000)
            or (d.created_at = to_timestamp($2::double precision / 1000) and d.id > $3::uuid)
          )
        order by d.created_at asc, d.id asc
        limit $4`, [userId, afterCreatedAtMs, afterId, limit]);
        return rows.map(toPaperBotDecision);
    }
    async hasRecentAction(configId, tokenMint, action, sinceMs) {
        const rows = await this.db.query(`select 1 from paper_bot_decisions
        where config_id = $1
          and token_mint is not distinct from $2
          and action = $3
          and created_at >= to_timestamp($4::double precision / 1000)
        limit 1`, [configId, tokenMint, action, sinceMs]);
        return rows.length > 0;
    }
}
function toPaperBotPositionState(row) {
    return {
        positionId: readString(row.position_id),
        configId: readString(row.config_id),
        highWaterValueMicroUsd: readBigInt(row.high_water_value_micro_usd),
        lastValueMicroUsd: row.last_value_micro_usd === null ? null : readBigInt(row.last_value_micro_usd),
        lastEvaluatedAtMs: readNullableDateMs(row.last_evaluated_at),
        exitReason: readNullableString(row.exit_reason),
        createdAtMs: readDateMs(row.created_at),
        updatedAtMs: readDateMs(row.updated_at),
    };
}
export class PaperBotPositionStateRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async get(positionId) {
        const rows = await this.db.query("select * from paper_bot_position_state where position_id = $1", [positionId]);
        return rows[0] ? toPaperBotPositionState(rows[0]) : null;
    }
    async recordValue(positionId, configId, highWaterMicroUsd, valueMicroUsd, nowMs) {
        const rows = await this.db.query(`insert into paper_bot_position_state (
         position_id, config_id, high_water_value_micro_usd, last_value_micro_usd,
         last_evaluated_at, created_at, updated_at
       ) values ($1, $2, $3, $4,
                 to_timestamp($5::double precision / 1000),
                 to_timestamp($5::double precision / 1000),
                 to_timestamp($5::double precision / 1000))
       on conflict (position_id) do update set
         high_water_value_micro_usd = greatest(
           paper_bot_position_state.high_water_value_micro_usd,
           excluded.high_water_value_micro_usd
         ),
         last_value_micro_usd = excluded.last_value_micro_usd,
         last_evaluated_at = excluded.last_evaluated_at,
         updated_at = excluded.updated_at
       returning *`, [positionId, configId, highWaterMicroUsd.toString(), valueMicroUsd.toString(), nowMs]);
        return toPaperBotPositionState(rows[0]);
    }
    async markExited(positionId, reason, nowMs) {
        await this.db.query(`update paper_bot_position_state
          set exit_reason = left($2, 120), updated_at = to_timestamp($3::double precision / 1000)
        where position_id = $1`, [positionId, reason, nowMs]);
    }
}
/**
 * Cross-instance coordination for the scheduled worker.
 *
 * `tryAcquire` performs the lock and idempotency check in one atomic upsert.
 * Keeping only the latest run key avoids an ever-growing one-row-per-minute
 * event table while still rejecting duplicate deliveries for that run.
 */
export class WorkerLeaseRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async tryAcquire(name, ownerId, runKey, nowMs, leaseMs) {
        const rows = await this.db.query(`insert into worker_leases (
         name, owner_id, last_run_key, lease_expires_at, started_at,
         completed_at, last_status, last_summary, updated_at
       ) values (
         $1, $2, $3,
         to_timestamp($4::double precision / 1000),
         to_timestamp($5::double precision / 1000),
         null, null, '{}'::jsonb,
         to_timestamp($5::double precision / 1000)
       )
       on conflict (name) do update set
         owner_id = excluded.owner_id,
         last_run_key = excluded.last_run_key,
         lease_expires_at = excluded.lease_expires_at,
         started_at = excluded.started_at,
         completed_at = null,
         last_status = null,
         last_summary = '{}'::jsonb,
         updated_at = excluded.updated_at
       where worker_leases.lease_expires_at <= excluded.started_at
         and worker_leases.last_run_key < excluded.last_run_key
       returning name`, [name, ownerId, runKey, nowMs + leaseMs, nowMs]);
        return rows.length === 1;
    }
    async complete(name, ownerId, status, summary, nowMs) {
        const rows = await this.db.query(`update worker_leases set
         lease_expires_at = to_timestamp($4::double precision / 1000),
         completed_at = to_timestamp($4::double precision / 1000),
         last_status = $3,
         last_summary = $5::jsonb,
         updated_at = to_timestamp($4::double precision / 1000)
       where name = $1 and owner_id = $2
       returning name`, [name, ownerId, status, nowMs, JSON.stringify(summary)]);
        return rows.length === 1;
    }
}
/**
 * The auto-watch shelf: tokens that have graduated out of discovery.
 *
 * System-owned and not tied to any user, because graduation is derived from
 * global market data. The per-user `watchlist_items` table is untouched by
 * this repository on purpose — a person's own picks are theirs.
 */
export class AutoWatchRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async list(limit = 100) {
        const rows = await this.db.query(`select token_mint, reason, symbol, name, quality_score, risk_score,
              score_version, first_promoted_at, last_seen_at
         from auto_watch_items
        order by first_promoted_at desc
        limit $1`, [limit]);
        return rows.map((row) => ({
            tokenMint: readString(row.token_mint),
            reason: readString(row.reason),
            symbol: readNullableString(row.symbol),
            name: readNullableString(row.name),
            qualityScore: row.quality_score === null ? null : readInteger(row.quality_score),
            riskScore: row.risk_score === null ? null : readInteger(row.risk_score),
            scoreVersion: readString(row.score_version),
            firstPromotedAtMs: readDateMs(row.first_promoted_at),
            lastSeenAtMs: readDateMs(row.last_seen_at),
        }));
    }
    async listMints() {
        const rows = await this.db.query("select token_mint from auto_watch_items", []);
        return rows.map((row) => readString(row.token_mint));
    }
    /**
     * Idempotent: the worker runs every minute and re-promotes the same tokens.
     * `first_promoted_at` is deliberately never overwritten, so the graduation
     * date survives; everything else tracks the latest observation.
     */
    async promote(entry) {
        await this.db.query(`insert into auto_watch_items
         (token_mint, reason, symbol, name, quality_score, risk_score, score_version)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (token_mint) do update set
         reason        = excluded.reason,
         symbol        = coalesce(excluded.symbol, auto_watch_items.symbol),
         name          = coalesce(excluded.name, auto_watch_items.name),
         quality_score = excluded.quality_score,
         risk_score    = excluded.risk_score,
         score_version = excluded.score_version,
         last_seen_at  = now()`, [
            entry.tokenMint,
            entry.reason,
            entry.symbol,
            entry.name,
            entry.qualityScore,
            entry.riskScore,
            entry.scoreVersion,
        ]);
    }
    async remove(tokenMint) {
        const rows = await this.db.query("delete from auto_watch_items where token_mint = $1 returning token_mint", [tokenMint]);
        return rows.length > 0;
    }
}
