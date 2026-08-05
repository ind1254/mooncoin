/**
 * Seeded demonstration scenarios.
 *
 * All of this is DEMONSTRATION DATA — deterministic, generated locally,
 * clearly labeled in the UI, and never presented as live market truth.
 * The scenario set intentionally covers the demo-mode requirements:
 *   - BONK    → strong opportunity (rising volume, deep stable liquidity)
 *   - POPCAT  → marginal opportunity (decent momentum, thinner liquidity)
 *   - FLOOF   → high-risk token (2 days old, concentrated holders,
 *               mint authority NOT revoked, thin falling liquidity)
 *   - WIF     → healthy but quiet
 *   - MEW     → negative momentum
 *   - PNUT    → volatile with a deliberately stale price feed
 */

export interface DemoTokenScenario {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  emoji: string;
  /** Reference mid price, pico-USD per whole token (1 USD = 1e12). */
  basePricePicoUsd: bigint;
  /** Amplitude of the slow/medium/fast price waves, in bps of base. */
  waveSlowBps: number;
  waveMediumBps: number;
  waveFastBps: number;
  /** Fixed recent-trend component applied to short windows, bps (signed). */
  trendBps: number;
  liquidityUsdMicro: bigint;
  liquidityChange1hBps: bigint;
  topPoolShareBps: bigint;
  volume1hUsdMicro: bigint;
  volumeChange1hBps: bigint;
  buySellRatioPct: bigint;
  txCount1h: number;
  tokenAgeDays: number;
  holderConcentrationBps: bigint;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  recentInsiderActivity: boolean;
  riskDataComplete: boolean;
  /** Simulate a lagging price feed (drives stale-data handling). */
  staleFeedMs: number;
  /** Venues with no pool for this token (route failures). */
  missingVenues: string[];
}

const now = Date.now();
const days = (n: number) => n * 24 * 60 * 60 * 1000;

export const DEMO_TOKENS: DemoTokenScenario[] = [
  {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    symbol: "BONK",
    name: "Bonk",
    decimals: 5,
    emoji: "🐕",
    basePricePicoUsd: 14_000_000n, // $0.000014
    waveSlowBps: 260, waveMediumBps: 120, waveFastBps: 35,
    trendBps: 180,
    liquidityUsdMicro: 12_400_000_000_000n, // $12.4M
    liquidityChange1hBps: 40n,
    topPoolShareBps: 4_100n,
    volume1hUsdMicro: 1_850_000_000_000n, // $1.85M/h
    volumeChange1hBps: 8_200n, // +82%
    buySellRatioPct: 138n,
    txCount1h: 4210,
    tokenAgeDays: 590,
    holderConcentrationBps: 1_450n,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    recentInsiderActivity: false,
    riskDataComplete: true,
    staleFeedMs: 0,
    missingVenues: [],
  },
  {
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    symbol: "WIF",
    name: "dogwifhat",
    decimals: 6,
    emoji: "🧢",
    basePricePicoUsd: 862_000_000_000n, // $0.862
    waveSlowBps: 180, waveMediumBps: 80, waveFastBps: 25,
    trendBps: -30,
    liquidityUsdMicro: 8_900_000_000_000n,
    liquidityChange1hBps: -15n,
    topPoolShareBps: 3_600n,
    volume1hUsdMicro: 620_000_000_000n,
    volumeChange1hBps: -900n,
    buySellRatioPct: 97n,
    txCount1h: 1730,
    tokenAgeDays: 610,
    holderConcentrationBps: 1_900n,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    recentInsiderActivity: false,
    riskDataComplete: true,
    staleFeedMs: 0,
    missingVenues: [],
  },
  {
    mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
    symbol: "POPCAT",
    name: "Popcat",
    decimals: 9,
    emoji: "🐸",
    basePricePicoUsd: 312_000_000_000n,
    waveSlowBps: 420, waveMediumBps: 190, waveFastBps: 60,
    trendBps: 240,
    liquidityUsdMicro: 940_000_000_000n, // $940k — thinner
    liquidityChange1hBps: 120n,
    topPoolShareBps: 6_300n,
    volume1hUsdMicro: 410_000_000_000n,
    volumeChange1hBps: 4_600n,
    buySellRatioPct: 121n,
    txCount1h: 980,
    tokenAgeDays: 240,
    holderConcentrationBps: 2_600n,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    recentInsiderActivity: false,
    riskDataComplete: true,
    staleFeedMs: 0,
    missingVenues: ["meteora"],
  },
  {
    mint: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",
    symbol: "MEW",
    name: "cat in a dogs world",
    decimals: 5,
    emoji: "😾",
    basePricePicoUsd: 4_150_000_000n,
    waveSlowBps: 150, waveMediumBps: 70, waveFastBps: 20,
    trendBps: -160,
    liquidityUsdMicro: 3_100_000_000_000n,
    liquidityChange1hBps: -60n,
    topPoolShareBps: 5_100n,
    volume1hUsdMicro: 96_000_000_000n,
    volumeChange1hBps: -2_400n,
    buySellRatioPct: 84n,
    txCount1h: 310,
    tokenAgeDays: 500,
    holderConcentrationBps: 2_200n,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    recentInsiderActivity: false,
    riskDataComplete: true,
    staleFeedMs: 0,
    missingVenues: [],
  },
  {
    mint: "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump",
    symbol: "PNUT",
    name: "Peanut the Squirrel",
    decimals: 6,
    emoji: "🐿️",
    basePricePicoUsd: 41_800_000_000n,
    waveSlowBps: 700, waveMediumBps: 380, waveFastBps: 140,
    trendBps: 90,
    liquidityUsdMicro: 1_650_000_000_000n,
    liquidityChange1hBps: -340n,
    topPoolShareBps: 7_200n,
    volume1hUsdMicro: 780_000_000_000n,
    volumeChange1hBps: 2_100n,
    buySellRatioPct: 108n,
    txCount1h: 2140,
    tokenAgeDays: 270,
    holderConcentrationBps: 3_100n,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    recentInsiderActivity: false,
    riskDataComplete: true,
    staleFeedMs: 75_000, // deliberately stale feed
    missingVenues: [],
  },
  {
    // Synthetic token invented for the demo — NOT a real mint.
    mint: "FLooFDemo1111111111111111111111111111111111",
    symbol: "FLOOF",
    name: "Floof (demo token)",
    decimals: 6,
    emoji: "🎈",
    basePricePicoUsd: 950_000_000n,
    waveSlowBps: 2_400, waveMediumBps: 1_100, waveFastBps: 420,
    trendBps: 3_800, // parabolic pump
    liquidityUsdMicro: 86_000_000_000n, // $86k — very thin
    liquidityChange1hBps: -1_900n, // draining
    topPoolShareBps: 9_600n,
    volume1hUsdMicro: 240_000_000_000n,
    volumeChange1hBps: 14_000n,
    buySellRatioPct: 205n,
    txCount1h: 3320,
    tokenAgeDays: 2,
    holderConcentrationBps: 6_200n, // top 10 hold 62%
    mintAuthorityRevoked: false, // mint authority still live
    freezeAuthorityRevoked: false,
    recentInsiderActivity: true,
    riskDataComplete: false, // some risk inputs unavailable
    staleFeedMs: 0,
    missingVenues: ["meteora", "orca"],
  },
];

export interface DemoVenue {
  id: string;
  name: string;
  routeFeeBps: bigint;
  /** Share of a token's total liquidity sitting on this venue, bps. */
  liquidityShareBps: bigint;
}

export const DEMO_VENUES: DemoVenue[] = [
  { id: "raydium", name: "Raydium", routeFeeBps: 25n, liquidityShareBps: 4_500n },
  { id: "orca", name: "Orca", routeFeeBps: 30n, liquidityShareBps: 3_500n },
  { id: "meteora", name: "Meteora", routeFeeBps: 20n, liquidityShareBps: 2_000n },
];

/** Base SOL reference price for the demo, micro-USD. */
export const DEMO_SOL_PRICE_MICRO_USD = 150_000_000n; // $150

/** Token creation timestamps derived from ages (fixed at module load). */
export const DEMO_CREATED_AT: Record<string, number> = Object.fromEntries(
  DEMO_TOKENS.map((t) => [t.mint, now - days(t.tokenAgeDays)]),
);
