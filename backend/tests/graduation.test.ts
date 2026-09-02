import { beforeEach, describe, expect, it } from "vitest";
import {
  GRADUATION_MATURITY_MS,
  GRADUATION_QUALITY_SCORE,
  assessLiveFeedToken,
} from "../src/market/feedAssessment.js";
import { runGraduationPass } from "../src/market/graduation.js";
import { AutoWatchRepository } from "../src/db/repositories.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import { migrate } from "../src/db/migrate.js";
import type { SqlClient } from "../src/db/client.js";
import type { LiveFeedToken, LiveFeedWindow } from "../src/market/jupiter/liveFeed.js";
import type { TradabilityPolicy } from "../src/market/tradability.js";

/**
 * Graduation moves a token out of discovery and onto the auto-watch shelf.
 *
 * The feature exists because the maturity pillar credits age and holder count,
 * so established meme coins carried a structural head start into a
 * score-sorted feed and permanently occupied the top slots. These tests pin
 * both halves of the fix and, importantly, that they use the same predicate.
 */

const NOW = 1_800_000_000_000;
const POLICY: TradabilityPolicy = {
  minLiquidityUsdMicro: 10_000_000_000n,
  maxPriceImpactBps: 300n,
  maxMarketAgeMs: 300_000,
};

const activeWindow = (over: Partial<LiveFeedWindow> = {}): LiveFeedWindow => ({
  priceChangeBps: 500n,
  liquidityChangeBps: 100n,
  volumeChangeBps: 1_000n,
  buyVolumeUsdMicro: 390_000n * 1_000_000n,
  sellVolumeUsdMicro: 210_000n * 1_000_000n,
  buys: 1_300,
  sells: 700,
  traders: 1_200,
  ...over,
});

function token(over: {
  mint?: string;
  symbol?: string;
  ageMs?: number | null;
  holderCount?: number | null;
  liquidityUsdMicro?: bigint | null;
  weak?: boolean;
} = {}): LiveFeedToken {
  const ageMs = over.ageMs === undefined ? 60 * 60_000 : over.ageMs;
  const firstPoolAtMs = ageMs === null ? null : NOW - ageMs;
  const w = over.weak
    ? activeWindow({ priceChangeBps: -400n, buyVolumeUsdMicro: 10n, sellVolumeUsdMicro: 900n, buys: 1, sells: 9, traders: 2 })
    : activeWindow();
  return {
    token: {
      mint: over.mint ?? "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      symbol: over.symbol ?? "TOKEN",
      name: "Test token",
      decimals: 6,
      firstPoolAtMs,
      marketUpdatedAtMs: NOW - 1_000,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      iconUrl: null,
      verifiedByProvider: true,
      tags: [],
      source: "test",
      market: {
        priceUsdPico: 1_000_000n,
        liquidityUsdMicro: over.liquidityUsdMicro === undefined ? 5_000_000n * 1_000_000n : over.liquidityUsdMicro,
        marketCapUsdMicro: 50_000_000n * 1_000_000n,
        fdvUsdMicro: 55_000_000n * 1_000_000n,
        holderCount: over.holderCount === undefined ? 100_000 : over.holderCount,
        change1hBps: over.weak ? -900n : 800n,
        change24hBps: over.weak ? -1_500n : 1_500n,
        buyVolume24hUsdMicro: 8_000_000n * 1_000_000n,
        sellVolume24hUsdMicro: 6_000_000n * 1_000_000n,
        numBuys24h: 8_000,
        numSells24h: 6_000,
        topHolderPctBps: over.weak ? 7_000n : 500n,
        organicScore: over.weak ? 5 : 95,
        organicScoreLabel: over.weak ? "low" : "high",
      },
      providerClaims: {
        mintAuthorityDisabled: !over.weak,
        freezeAuthorityDisabled: !over.weak,
      },
    },
    firstPoolAtMs,
    updatedAtMs: NOW - 1_000,
    launchpad: null,
    fiveMinutes: w,
    oneHour: w,
    twentyFourHours: w,
  } as LiveFeedToken;
}

const assess = (t: LiveFeedToken) => assessLiveFeedToken(t, NOW, POLICY, 1);

describe("graduation predicate", () => {
  it("graduates a token that has been trading for 30 days", () => {
    const result = assess(token({ ageMs: GRADUATION_MATURITY_MS }));
    expect(result.graduated).toBe(true);
    expect(result.graduationReason).toBe("market_maturity");
  });

  it("does not graduate a token just short of the maturity bar on age alone", () => {
    const young = token({ ageMs: GRADUATION_MATURITY_MS - 60_000, holderCount: 5, weak: true });
    const result = assess(young);
    // It may still graduate on quality; what must not happen is a maturity
    // claim about a token that is not yet a month old.
    expect(result.graduationReason).not.toBe("market_maturity");
  });

  it("graduates on quality once the token has proved itself", () => {
    const strong = token({ ageMs: 2 * 60 * 60_000, holderCount: 50_000 });
    const result = assess(strong);
    if (result.qualityScore >= GRADUATION_QUALITY_SCORE) {
      expect(result.graduated).toBe(true);
      expect(result.graduationReason).toBe("quality_threshold");
    } else {
      expect(result.graduated).toBe(false);
    }
  });

  it("reports maturity rather than quality when both apply", () => {
    // Maturity is a durable statement about history; quality moves daily.
    const established = token({ ageMs: 90 * 86_400_000, holderCount: 200_000 });
    const result = assess(established);
    expect(result.graduated).toBe(true);
    expect(result.graduationReason).toBe("market_maturity");
  });

  it("leaves a genuinely new, weak token in discovery", () => {
    const fresh = token({ ageMs: 20 * 60_000, holderCount: 3, liquidityUsdMicro: 1_000_000n, weak: true });
    const result = assess(fresh);
    expect(result.qualityScore).toBeLessThan(GRADUATION_QUALITY_SCORE);
    expect(result.graduated).toBe(false);
    expect(result.graduationReason).toBeNull();
  });
});

describe("graduation pass", () => {
  let db: SqlClient;
  let repo: AutoWatchRepository;

  beforeEach(async () => {
    db = createPgliteClient();
    await migrate(db);
    repo = new AutoWatchRepository(db);
  });

  const passDeps = (tokens: LiveFeedToken[]) => ({
    getFeed: async () => ({ tokens }),
    autoWatch: repo,
    policy: POLICY,
    clock: () => NOW,
    kinds: ["trending" as const],
  });

  it("promotes graduated tokens and leaves new ones alone", async () => {
    const established = token({
      mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      symbol: "BONK",
      ageMs: 200 * 86_400_000,
      holderCount: 800_000,
    });
    const fresh = token({
      mint: "So11111111111111111111111111111111111111112",
      symbol: "FRESH",
      ageMs: 20 * 60_000,
      holderCount: 3,
      liquidityUsdMicro: 1_000_000n,
      weak: true,
    });

    const summary = await runGraduationPass(passDeps([established, fresh]));
    expect(summary.promoted).toBe(1);
    expect(summary.byReason.market_maturity).toBe(1);

    const shelf = await repo.list();
    expect(shelf).toHaveLength(1);
    expect(shelf[0]?.tokenMint).toBe(established.token.mint);
    expect(shelf[0]?.symbol).toBe("BONK");
    expect(shelf[0]?.reason).toBe("market_maturity");
    expect(shelf[0]?.scoreVersion).toBe("live-v2");
  });

  it("is idempotent and keeps the original graduation date", async () => {
    // The worker runs every minute; re-promoting must not rewrite history.
    const established = token({ ageMs: 200 * 86_400_000, holderCount: 800_000 });
    await runGraduationPass(passDeps([established]));
    const first = await repo.list();

    await runGraduationPass(passDeps([established]));
    const second = await repo.list();

    expect(second).toHaveLength(1);
    expect(second[0]?.firstPromotedAtMs).toBe(first[0]?.firstPromotedAtMs);
  });

  it("demotes a token that no longer graduates", async () => {
    // The shelf mirrors the predicate: a token that graduated on quality and
    // has since decayed belongs back in discovery.
    const strong = token({ ageMs: 2 * 60 * 60_000, holderCount: 50_000 });
    const promoted = await runGraduationPass(passDeps([strong]));
    expect(promoted.promoted).toBe(1);
    expect(await repo.list()).toHaveLength(1);

    const decayed = token({
      ageMs: 2 * 60 * 60_000,
      holderCount: 3,
      liquidityUsdMicro: 1_000_000n,
      weak: true,
    });
    const after = await runGraduationPass(passDeps([decayed]));
    expect(after.demoted).toBe(1);
    expect(await repo.list()).toHaveLength(0);
  });

  it("leaves a shelf entry alone when the provider stops listing it", async () => {
    // Absence from a trending feed is not evidence a token stopped qualifying.
    await runGraduationPass(passDeps([token({ ageMs: 200 * 86_400_000 })]));
    expect(await repo.list()).toHaveLength(1);

    const after = await runGraduationPass(passDeps([]));
    expect(after.demoted).toBe(0);
    expect(await repo.list()).toHaveLength(1);
  });

  it("never writes to a user's own watchlist", async () => {
    // The shelf is system-owned; a person's picks stay theirs.
    await runGraduationPass(passDeps([token({ ageMs: 200 * 86_400_000 })]));
    const rows = await db.query("select count(*)::int as n from watchlist_items", []);
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
