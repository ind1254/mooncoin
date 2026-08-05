/**
 * Normalized market-data models and provider interfaces.
 *
 * Every external data source is wrapped in a provider implementing one of the
 * interfaces below, and every market value carries provenance (source,
 * timestamp, reliability) so the UI never has to guess how fresh data is.
 * Tokens are identified by immutable mint address everywhere; symbols are
 * display-only.
 *
 * Money conventions (no floats for financial values):
 *  - USD values:   bigint micro-USD (1 USD = 1_000_000)
 *  - Token prices: bigint pico-USD per whole token (1 USD = 1e12) — meme-coin
 *                  prices like $0.000014 need sub-micro precision
 *  - SOL:          bigint lamports (1 SOL = 1_000_000_000)
 *  - tokens:       bigint base units per the mint's decimals
 *  - ratios:       bigint basis points (1% = 100 bps)
 */
export {};
