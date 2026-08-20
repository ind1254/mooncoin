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

export type Reliability = "fresh" | "stale" | "unavailable";

/** A single sourced market value with provenance. */
export interface MarketPoint<T> {
  value: T;
  source: string;
  observedAtMs: number;
  ageMs: number;
  reliability: Reliability;
  /**
   * Per-field provenance for values assembled from more than one provider.
   * Keys are field names of `value`. When absent, every field came from
   * `source`. Lets the UI say "verified on-chain" next to "simulated".
   */
  fieldSources?: Record<string, string>;
}

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Unix ms the token (mint) was created — drives token-age risk factors. */
  createdAtMs: number;
  /** Display emoji used by the demo UI (no external image dependencies). */
  emoji: string;
}

export interface Candle {
  tsMs: number;
  openPicoUsd: bigint;
  highPicoUsd: bigint;
  lowPicoUsd: bigint;
  closePicoUsd: bigint;
  volumeUsdMicro: bigint;
}

export interface LiquiditySnapshot {
  totalUsdMicro: bigint;
  /** Change vs ~1h ago, bps (signed). */
  change1hBps: bigint;
  /** Share of liquidity held by the single largest pool, bps. */
  topPoolShareBps: bigint;
}

export interface MomentumSnapshot {
  pricePicoUsd: bigint;
  change5mBps: bigint;
  change1hBps: bigint;
  change24hBps: bigint;
  volume1hUsdMicro: bigint;
  /** 1h volume vs previous hour, bps (signed). */
  volumeChange1hBps: bigint;
  /** Buys per 100 sells over the last hour (e.g. 130n = 1.3:1). */
  buySellRatioPct: bigint;
  txCount1h: number;
}

/**
 * Outcome of checking a token's mint account directly on-chain.
 * Present only in live mode; `status` other than "verified" means the
 * authority fields below are still simulated and must be labelled as such.
 */
export interface OnChainMintVerification {
  status: "verified" | "not_found" | "unsupported_program" | "malformed" | "unavailable";
  source: string;
  checkedAtMs: number;
  /** Human-readable reason when status is not "verified". */
  detail?: string;
  /** Authoritative decimals from the mint account, when we could read it. */
  decimalsOnChain?: number;
  /** True when on-chain decimals disagree with the token catalog. */
  decimalsMismatch?: boolean;
  /** Present only when holder classification was attempted. */
  holders?: OnChainHolderVerification;
}

/**
 * Outcome of measuring holder concentration from token accounts.
 *
 * Separate from the mint status above because the two can disagree: the mint
 * account is one read that almost always succeeds, while holder classification
 * is three reads and may be throttled. Authorities staying verified while
 * holders go unavailable is a normal, expected combination.
 */
export interface OnChainHolderVerification {
  status: "verified" | "incomplete" | "unavailable";
  /** Top wallet holders' share of supply, bps. Excludes pools and curves. */
  concentrationBps?: bigint;
  /** Share held by program-controlled accounts (pools, curves), bps. */
  programHeldBps?: bigint;
  /** Distinct wallet owners behind `concentrationBps`. */
  walletHolderCount?: number;
  /** Share that could not be attributed to either bucket, bps. */
  unclassifiedBps?: bigint;
  /** Human-readable summary, always set. */
  detail: string;
}

export interface TokenRiskFacts {
  tokenAgeDays: number;
  /** Combined share of supply held by top 10 holders, bps. */
  holderConcentrationBps: bigint;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** Large developer/insider movements observed recently. */
  recentInsiderActivity: boolean;
  /** Some risk inputs could not be retrieved. */
  dataComplete: boolean;
  /** Set in live mode only; absent in pure demo mode. */
  onChainVerification?: OnChainMintVerification;
}

export type QuoteSide = "buy" | "sell";

/** An executable route quote for a specific size — never a chart price. */
export interface RouteQuote {
  venueId: string;
  venueName: string;
  side: QuoteSide;
  tokenMint: string;
  /** Buy: lamports in. Sell: token base units in. */
  inAmount: bigint;
  /** Buy: token base units out. Sell: lamports out. */
  outAmount: bigint;
  /** outAmount after the slippage tolerance is applied (worst acceptable). */
  minReceived: bigint;
  /** Effective USD price per whole token implied by this route, pico-USD. */
  effectivePricePicoUsd: bigint;
  priceImpactBps: bigint;
  routeFeeBps: bigint;
  networkFeeLamports: bigint;
  priorityFeeLamports: bigint;
  slippageBps: bigint;
  retrievedAtMs: number;
  expiresAtMs: number;
  source: string;
}

export interface RouteComparison {
  /** null when no venue could produce an executable quote. */
  best: RouteQuote | null;
  alternatives: RouteQuote[];
  /** Venues that failed to quote, with structured reasons. */
  failures: { venueId: string; code: string; message: string }[];
}

/** Aggregated, provenance-tracked view of one token used by scoring and UI. */
export interface TokenMarketView {
  token: TokenInfo;
  momentum: MarketPoint<MomentumSnapshot>;
  liquidity: MarketPoint<LiquiditySnapshot>;
  risk: MarketPoint<TokenRiskFacts>;
  solPriceMicroUsd: bigint;
}

// ---------------------------------------------------------------------------
// Provider interfaces — swap implementations without touching consumers
// ---------------------------------------------------------------------------

export interface TokenDiscoveryProvider {
  readonly source: string;
  listTokens(): Promise<TokenInfo[]>;
}

/**
 * Market facts reported by a discovery provider. Every field is nullable:
 * a provider that stops reporting one metric must degrade that value alone,
 * never the whole record.
 */
export interface DiscoveredMarketFacts {
  priceUsdPico: bigint | null;
  liquidityUsdMicro: bigint | null;
  marketCapUsdMicro: bigint | null;
  fdvUsdMicro: bigint | null;
  holderCount: number | null;
  change1hBps: bigint | null;
  change24hBps: bigint | null;
  buyVolume24hUsdMicro: bigint | null;
  sellVolume24hUsdMicro: bigint | null;
  numBuys24h: number | null;
  numSells24h: number | null;
  /** Share of supply held by the largest holders, bps, as reported. */
  topHolderPctBps: bigint | null;
  organicScore: number | null;
  organicScoreLabel: string | null;
}

/**
 * A token as returned by discovery search. The mint is the canonical
 * identity; symbol and name are display-only and are NOT unique.
 */
export interface TokenSearchResult {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** First pool creation time reported by the catalog; not mint creation. */
  firstPoolAtMs?: number | null;
  /** When the provider last refreshed this token's market record. */
  marketUpdatedAtMs?: number | null;
  tokenProgram: string | null;
  iconUrl: string | null;
  /** The provider's own verified/allowlist flag — a hint, not proof. */
  verifiedByProvider: boolean;
  tags: string[];
  source: string;
  market: DiscoveredMarketFacts;
  /**
   * Authority claims made by the discovery provider. Retained only to
   * cross-check against the chain, which is authoritative. A null means the
   * provider did not report it — which is not the same as false.
   */
  providerClaims: {
    mintAuthorityDisabled: boolean | null;
    freezeAuthorityDisabled: boolean | null;
  };
}

export interface TokenSearchProvider {
  readonly source: string;
  /** Free-text search over symbol, name, or mint address. */
  search(query: string, signal?: AbortSignal): Promise<TokenSearchResult[]>;
  /** Exact resolution by canonical mint address. */
  getByMint(mint: string, signal?: AbortSignal): Promise<TokenSearchResult | null>;
}

export interface PriceHistoryProvider {
  readonly source: string;
  getMomentum(mint: string): Promise<MarketPoint<MomentumSnapshot>>;
  getCandles(mint: string, points: number, stepMs: number): Promise<Candle[]>;
}

export interface LiquidityProvider {
  readonly source: string;
  getLiquidity(mint: string): Promise<MarketPoint<LiquiditySnapshot>>;
}

export interface TokenRiskProvider {
  readonly source: string;
  getRiskFacts(mint: string): Promise<MarketPoint<TokenRiskFacts>>;
}

export interface QuoteRoutingProvider {
  readonly source: string;
  getBuyRoutes(mint: string, lamportsIn: bigint, slippageBps: bigint): Promise<RouteComparison>;
  getSellRoutes(mint: string, tokenUnitsIn: bigint, slippageBps: bigint): Promise<RouteComparison>;
  getSolPriceMicroUsd(): Promise<bigint>;
}

export interface MarketDataBundle {
  discovery: TokenDiscoveryProvider;
  history: PriceHistoryProvider;
  liquidity: LiquidityProvider;
  riskFacts: TokenRiskProvider;
  routing: QuoteRoutingProvider;
  /** Human label shown in the UI, e.g. "Demonstration data (seeded)". */
  dataSourceLabel: string;
  isDemo: boolean;
}
