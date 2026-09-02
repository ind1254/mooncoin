/** Tier boundaries. Exported so the policy is testable and visible. */
export const HISTORY_HIGH_RESOLUTION_MS = 6 * 3_600_000;
export const HISTORY_MEDIUM_RESOLUTION_MS = 7 * 86_400_000;
export const HISTORY_RETENTION_MS = 90 * 86_400_000;
const str = (value) => String(value ?? "");
const nullableStr = (value) => value === null || value === undefined ? null : String(value);
const bigintOrNull = (value) => value === null || value === undefined ? null : BigInt(String(value));
const numberOrNull = (value) => value === null || value === undefined ? null : Number(value);
const boolOrNull = (value) => value === null || value === undefined ? null : Boolean(value);
const dateMs = (value) => value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
const SELECT_COLUMNS = `
  select token_mint, observed_at, resolution, risk_score, risk_confidence,
         risk_model_version, price_pico_usd, liquidity_usd_micro,
         market_cap_usd_micro, volume_24h_usd_micro, wallet_concentration_bps,
         program_held_bps, mint_authority_revoked, freeze_authority_revoked
    from token_history`;
function mapRow(row) {
    return {
        tokenMint: str(row.token_mint),
        observedAtMs: dateMs(row.observed_at),
        resolution: str(row.resolution),
        riskScore: numberOrNull(row.risk_score),
        riskConfidence: numberOrNull(row.risk_confidence),
        riskModelVersion: nullableStr(row.risk_model_version),
        pricePicoUsd: bigintOrNull(row.price_pico_usd),
        liquidityUsdMicro: bigintOrNull(row.liquidity_usd_micro),
        marketCapUsdMicro: bigintOrNull(row.market_cap_usd_micro),
        volume24hUsdMicro: bigintOrNull(row.volume_24h_usd_micro),
        walletConcentrationBps: bigintOrNull(row.wallet_concentration_bps),
        programHeldBps: bigintOrNull(row.program_held_bps),
        mintAuthorityRevoked: boolOrNull(row.mint_authority_revoked),
        freezeAuthorityRevoked: boolOrNull(row.freeze_authority_revoked),
    };
}
export class TokenHistoryRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Idempotent: the worker runs every minute and may retry a pass, so a repeat
     * write for the same instant updates rather than duplicating.
     */
    async record(point) {
        await this.db.query(`insert into token_history (
         token_mint, observed_at, resolution, risk_score, risk_confidence,
         risk_model_version, price_pico_usd, liquidity_usd_micro,
         market_cap_usd_micro, volume_24h_usd_micro, wallet_concentration_bps,
         program_held_bps, mint_authority_revoked, freeze_authority_revoked
       ) values ($1, to_timestamp($2::double precision / 1000), $3, $4, $5, $6,
                 $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (token_mint, observed_at) do update set
         resolution               = excluded.resolution,
         risk_score               = excluded.risk_score,
         risk_confidence          = excluded.risk_confidence,
         risk_model_version       = excluded.risk_model_version,
         price_pico_usd           = excluded.price_pico_usd,
         liquidity_usd_micro      = excluded.liquidity_usd_micro,
         market_cap_usd_micro     = excluded.market_cap_usd_micro,
         volume_24h_usd_micro     = excluded.volume_24h_usd_micro,
         wallet_concentration_bps = excluded.wallet_concentration_bps,
         program_held_bps         = excluded.program_held_bps,
         mint_authority_revoked   = excluded.mint_authority_revoked,
         freeze_authority_revoked = excluded.freeze_authority_revoked`, [
            point.tokenMint,
            point.observedAtMs,
            point.resolution,
            point.riskScore,
            point.riskConfidence,
            point.riskModelVersion,
            point.pricePicoUsd?.toString() ?? null,
            point.liquidityUsdMicro?.toString() ?? null,
            point.marketCapUsdMicro?.toString() ?? null,
            point.volume24hUsdMicro?.toString() ?? null,
            point.walletConcentrationBps?.toString() ?? null,
            point.programHeldBps?.toString() ?? null,
            point.mintAuthorityRevoked,
            point.freezeAuthorityRevoked,
        ]);
    }
    /** A token's series, newest first. */
    async list(tokenMint, limit = 200) {
        const rows = await this.db.query(`${SELECT_COLUMNS} where token_mint = $1 order by observed_at desc limit $2`, [tokenMint, limit]);
        return rows.map(mapRow);
    }
    /**
     * The observation in force at a past instant — the nearest row at or BEFORE
     * it, which is what "what was risk an hour ago?" actually means.
     *
     * Never returns a later row. Reporting a state the token had not yet reached
     * would be a fabrication dressed as history.
     */
    async asOf(tokenMint, atMs) {
        const rows = await this.db.query(`${SELECT_COLUMNS}
        where token_mint = $1
          and observed_at <= to_timestamp($2::double precision / 1000)
        order by observed_at desc
        limit 1`, [tokenMint, atMs]);
        const row = rows[0];
        return row ? mapRow(row) : null;
    }
    /** Every point in a window, oldest first, for reviewing a held position. */
    async between(tokenMint, fromMs, toMs) {
        const rows = await this.db.query(`${SELECT_COLUMNS}
        where token_mint = $1
          and observed_at >= to_timestamp($2::double precision / 1000)
          and observed_at <= to_timestamp($3::double precision / 1000)
        order by observed_at asc`, [tokenMint, fromMs, toMs]);
        return rows.map(mapRow);
    }
    /**
     * Downsample ageing rows and drop what is past retention.
     *
     * Keeps the FIRST row in each bucket rather than averaging, so a retained
     * point is always a real observation at a real time — never a synthetic
     * value describing a moment that did not happen.
     */
    async prune(nowMs) {
        const mediumCutoff = nowMs - HISTORY_HIGH_RESOLUTION_MS;
        const lowCutoff = nowMs - HISTORY_MEDIUM_RESOLUTION_MS;
        const deleteCutoff = nowMs - HISTORY_RETENTION_MS;
        const downsampledToMedium = await this.collapse("high", mediumCutoff, "hour");
        await this.db.query(`update token_history set resolution = 'medium'
        where resolution = 'high'
          and observed_at < to_timestamp($1::double precision / 1000)`, [mediumCutoff]);
        const downsampledToLow = await this.collapse("medium", lowCutoff, "day");
        await this.db.query(`update token_history set resolution = 'low'
        where resolution = 'medium'
          and observed_at < to_timestamp($1::double precision / 1000)`, [lowCutoff]);
        const deleted = await this.db.query(`delete from token_history
        where observed_at < to_timestamp($1::double precision / 1000)
        returning id`, [deleteCutoff]);
        return { downsampledToMedium, downsampledToLow, deleted: deleted.length };
    }
    /** Keep one row per mint per bucket; delete the rest. */
    async collapse(tier, cutoffMs, bucket) {
        // `bucket` and `tier` are not user input — they come from the two call
        // sites above — so interpolating them is safe. Values stay parameterised.
        const rows = await this.db.query(`delete from token_history
        where resolution = '${tier}'
          and observed_at < to_timestamp($1::double precision / 1000)
          and id not in (
            select min(id) from token_history
             where resolution = '${tier}'
               and observed_at < to_timestamp($1::double precision / 1000)
             group by token_mint, date_trunc('${bucket}', observed_at)
          )
        returning id`, [cutoffMs]);
        return rows.length;
    }
    async count() {
        const rows = await this.db.query("select count(*)::int as n from token_history", []);
        return Number(rows[0]?.n ?? 0);
    }
}
