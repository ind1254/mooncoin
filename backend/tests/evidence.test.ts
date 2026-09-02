import { describe, expect, it } from "vitest";
import {
  collectSources,
  collectUnavailable,
  derived,
  hasValue,
  reported,
  stale,
  unavailable,
  verified,
  withFreshness,
} from "../src/evidence/types.js";
import { snapshotFromFeedToken, snapshotFromResearch } from "../src/evidence/build.js";
import type { LiveFeedToken, LiveFeedWindow } from "../src/market/jupiter/liveFeed.js";
import type { ResearchProfile } from "../src/market/research.js";

/**
 * The evidence model's job is to carry provenance without losing precision.
 * These tests pin the two things that would quietly break the risk model if
 * they regressed: a chain read must never be downgraded to a provider claim,
 * and a missing value must never appear as a usable one.
 */

const NOW = 1_800_000_000_000;
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("evidence constructors", () => {
  it("refuses to publish a value alongside a claim that there is none", () => {
    const missing = unavailable<bigint>({ value: 42n as unknown as bigint, source: "s", observedAt: NOW });
    expect(missing.value).toBeNull();
    expect(missing.status).toBe("unavailable");
    expect(hasValue(missing)).toBe(false);
  });

  it("downgrades a null value to unavailable rather than asserting it", () => {
    // A caller passing null must not end up with a "verified null".
    expect(verified<bigint>({ value: null, source: "chain", observedAt: NOW }).status).toBe("unavailable");
    expect(reported<bigint>({ value: null, source: "provider", observedAt: NOW }).status).toBe("unavailable");
    expect(derived<bigint>({ value: null, source: "calc", observedAt: NOW }).status).toBe("unavailable");
  });

  it("keeps the authority distinction the risk model depends on", () => {
    expect(verified({ value: true, source: "chain", observedAt: NOW }).status).toBe("verified");
    expect(reported({ value: true, source: "provider", observedAt: NOW }).status).toBe("reported");
    expect(derived({ value: true, source: "calc", observedAt: NOW }).status).toBe("derived");
  });

  it("marks evidence stale past the reader's tolerance, keeping the value", () => {
    const fresh = reported({ value: 5n, source: "p", observedAt: NOW - 1_000 });
    expect(withFreshness(fresh, NOW, 60_000).status).toBe("reported");

    const old = withFreshness(reported({ value: 5n, source: "p", observedAt: NOW - 120_000 }), NOW, 60_000);
    expect(old.status).toBe("stale");
    expect(old.value).toBe(5n); // stale is still observed, not invented
    expect(old.detail).toMatch(/past the/);
  });

  it("never resurrects an unavailable value through freshness", () => {
    const missing = unavailable<bigint>({ value: null, source: "s", observedAt: NOW - 999_999 });
    expect(withFreshness(missing, NOW, 60_000).status).toBe("unavailable");
  });

  it("treats stale as usable but distinguishable", () => {
    const s = stale({ value: 7n, source: "p", observedAt: NOW - 1 });
    expect(hasValue(s)).toBe(true);
    expect(s.status).toBe("stale");
  });

  it("collects missing paths and contributing sources", () => {
    const groups = {
      market: {
        price: reported({ value: 1n, source: "provider-a", observedAt: NOW }),
        cap: unavailable<bigint>({ value: null, source: "x", observedAt: NOW }),
      },
      holders: {
        top: verified({ value: 2n, source: "solana:mainnet", observedAt: NOW }),
      },
    };
    expect(collectUnavailable(groups)).toEqual(["market.cap"]);
    // An absent fact contributes no source: it did not come from anywhere.
    expect(collectSources(groups)).toEqual(["provider-a", "solana:mainnet"]);
  });
});

const feedWindow = (over: Partial<LiveFeedWindow> = {}): LiveFeedWindow => ({
  priceChangeBps: 500n,
  liquidityChangeBps: 100n,
  volumeChangeBps: 1_000n,
  buyVolumeUsdMicro: 300_000n * 1_000_000n,
  sellVolumeUsdMicro: 200_000n * 1_000_000n,
  buys: 100,
  sells: 50,
  traders: 120,
  ...over,
});

const feedToken = (): LiveFeedToken =>
  ({
    token: {
      mint: MINT,
      symbol: "BONK",
      name: "Bonk",
      decimals: 5,
      firstPoolAtMs: NOW - 40 * 86_400_000,
      marketUpdatedAtMs: NOW - 2_000,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      iconUrl: null,
      verifiedByProvider: true,
      tags: [],
      source: "jupiter:tokens-v2",
      market: {
        priceUsdPico: 1_000_000n,
        liquidityUsdMicro: 500_000n * 1_000_000n,
        marketCapUsdMicro: 10_000_000n * 1_000_000n,
        fdvUsdMicro: 11_000_000n * 1_000_000n,
        holderCount: 90_000,
        change1hBps: 300n,
        change24hBps: 900n,
        buyVolume24hUsdMicro: 4_000_000n * 1_000_000n,
        sellVolume24hUsdMicro: 3_000_000n * 1_000_000n,
        numBuys24h: 900,
        numSells24h: 700,
        topHolderPctBps: 2_400n,
        organicScore: 90,
        organicScoreLabel: "high",
      },
      providerClaims: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
    },
    firstPoolAtMs: NOW - 40 * 86_400_000,
    updatedAtMs: NOW - 2_000,
    launchpad: null,
    fiveMinutes: feedWindow(),
    oneHour: feedWindow(),
    twentyFourHours: feedWindow(),
  }) as unknown as LiveFeedToken;

describe("snapshot from the discovery feed", () => {
  const snap = snapshotFromFeedToken(feedToken(), NOW, { duplicateSymbolCount: 3 });

  it("records provider market facts as reported, never verified", () => {
    expect(snap.market.priceUsdPico.status).toBe("reported");
    expect(snap.market.priceUsdPico.value).toBe(1_000_000n);
    expect(snap.identity.symbol.status).toBe("reported");
  });

  it("never promotes a provider authority claim to verified", () => {
    // This is the distinction the whole risk model rests on.
    expect(snap.authorities.mintAuthorityRevoked.status).toBe("reported");
    expect(snap.authorities.mintAuthorityRevoked.value).toBe(true);
    expect(snap.authorities.mintAuthorityRevoked.detail).toMatch(/not confirmed/i);
    // Agreement cannot be judged without a chain read.
    expect(snap.authorities.providerAgreement.status).toBe("unavailable");
  });

  it("does not pass the provider's holder figure off as pool-excluded", () => {
    expect(snap.holders.topWalletConcentrationBps.status).toBe("reported");
    expect(snap.holders.topWalletConcentrationBps.detail).toMatch(/not excluded/i);
    expect(snap.holders.programHeldBps.status).toBe("unavailable");
    expect(snap.holders.walletHolderCount.status).toBe("unavailable");
  });

  it("keeps the three lifecycle timestamps distinct", () => {
    // A first-pool sighting is not a mint creation time.
    expect(snap.lifecycle.mintCreatedAt.status).toBe("unavailable");
    expect(snap.lifecycle.firstPoolCreatedAt.value).toBe(NOW - 40 * 86_400_000);
    expect(snap.lifecycle.firstProviderObservedAt.value).toBe(NOW - 2_000);
  });

  it("reports wallet cohorts as absent rather than zero", () => {
    // Zero developer holdings and unknown developer holdings are not the same
    // claim, and only one of them is true here.
    for (const key of ["developerWalletPct", "insiderPct", "bundlerPct", "sniperPct", "smartTraderPct"] as const) {
      expect(snap.walletBehaviour[key].status).toBe("unavailable");
      expect(snap.walletBehaviour[key].value).toBeNull();
    }
    expect(snap.unavailableEvidence).toContain("walletBehaviour.insiderPct");
  });

  it("derives depth rather than reporting it as a provider fact", () => {
    // 500k liquidity against 10m cap = 500 bps.
    expect(snap.liquidity.depthBps.status).toBe("derived");
    expect(snap.liquidity.depthBps.value).toBe(500n);
  });

  it("publishes what it did not know, and who it heard from", () => {
    expect(snap.unavailableEvidence.length).toBeGreaterThan(0);
    expect(snap.sources).toContain("jupiter:tokens-v2");
    expect(snap.execution).toBeNull();
  });
});

const researchProfile = (over: Partial<ResearchProfile> = {}): ResearchProfile =>
  ({
    mint: MINT,
    symbol: "BONK",
    name: "Bonk",
    decimals: 5,
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    iconUrl: null,
    tags: [],
    verifiedByProvider: true,
    identitySource: "jupiter:tokens-v2",
    marketSource: "jupiter:tokens-v2",
    marketUpdatedAtMs: NOW - 3_000,
    market: {
      priceUsdPico: 1_000_000n,
      liquidityUsdMicro: 500_000n * 1_000_000n,
      marketCapUsdMicro: 10_000_000n * 1_000_000n,
      fdvUsdMicro: null,
      holderCount: 90_000,
      change1hBps: 300n,
      change24hBps: 900n,
      buyVolume24hUsdMicro: 4_000_000n * 1_000_000n,
      sellVolume24hUsdMicro: 3_000_000n * 1_000_000n,
      numBuys24h: 900,
      numSells24h: 700,
      topHolderPctBps: 2_400n,
      organicScore: 90,
      organicScoreLabel: "high",
    },
    verification: {
      status: "verified",
      source: "solana:mainnet",
      checkedAtMs: NOW - 1_000,
      decimalsOnChain: 5,
      holders: {
        status: "verified",
        concentrationBps: 1_800n,
        programHeldBps: 4_000n,
        walletHolderCount: 10,
        unclassifiedBps: 0n,
        detail: "Classified 20 of 20 top accounts",
      },
    },
    authorities: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      source: "solana:mainnet",
      providerAgreement: "agrees",
    },
    risk: { score: 10, level: "low", factors: [] },
    simulation: { available: true, reason: "" },
    fetchedAtMs: NOW,
    ...over,
  }) as unknown as ResearchProfile;

describe("snapshot from detailed research", () => {
  const snap = snapshotFromResearch(researchProfile(), NOW);

  it("marks chain reads as verified, outranking provider claims", () => {
    expect(snap.authorities.mintAuthorityRevoked.status).toBe("verified");
    expect(snap.authorities.mintAuthorityRevoked.source).toBe("solana:mainnet");
    expect(snap.holders.topWalletConcentrationBps.status).toBe("verified");
    expect(snap.holders.topWalletConcentrationBps.value).toBe(1_800n);
    // Pool-held supply is reported separately, never folded into the headline.
    expect(snap.holders.programHeldBps.value).toBe(4_000n);
  });

  it("prefers on-chain decimals over the catalog's", () => {
    expect(snap.identity.decimals.status).toBe("verified");
  });

  it("reports authorities as unavailable when the chain could not be read", () => {
    // Missing evidence must never read as "authority revoked".
    const blind = snapshotFromResearch(
      researchProfile({
        verification: {
          status: "unavailable",
          source: "solana:mainnet",
          checkedAtMs: NOW,
          detail: "RPC unreachable",
        },
        authorities: {
          mintAuthorityRevoked: null,
          freezeAuthorityRevoked: null,
          source: "solana:mainnet",
          providerAgreement: "not_reported",
        },
      } as unknown as Partial<ResearchProfile>),
      NOW,
    );
    expect(blind.authorities.mintAuthorityRevoked.status).toBe("unavailable");
    expect(blind.authorities.mintAuthorityRevoked.value).toBeNull();
    expect(blind.authorities.mintAuthorityRevoked.detail).toBe("RPC unreachable");
    expect(blind.unavailableEvidence).toContain("authorities.mintAuthorityRevoked");
  });

  it("adds an execution group only when a real quote is supplied", () => {
    expect(snap.execution).toBeNull();

    const withQuote = snapshotFromResearch(researchProfile(), NOW, {
      quote: {
        priceImpactBps: 134n,
        outAmount: 1_000n,
        minOutAmount: 990n,
        slippageBps: 50n,
        routePlan: [{ ammLabel: "Meteora" }],
        source: "jupiter:quote-v1",
        retrievedAtMs: NOW - 500,
      } as never,
    });
    expect(withQuote.execution?.priceImpactBps.value).toBe(134n);
    expect(withQuote.execution?.routeVenues.value).toEqual(["Meteora"]);
    expect(withQuote.sources).toContain("jupiter:quote-v1");
  });

  it("does not claim a mint creation time it cannot establish", () => {
    expect(snap.lifecycle.mintCreatedAt.status).toBe("unavailable");
    expect(snap.lifecycle.mintCreatedAt.detail).toMatch(/transaction history/i);
  });
});
