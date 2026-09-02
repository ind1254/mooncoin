import { describe, expect, it } from "vitest";
import { RISK_MODEL_VERSION, assessRisk } from "../src/risk/engineV3.js";
import {
  derived,
  reported,
  unavailable,
  verified,
  type Evidence,
  type TokenEvidenceSnapshot,
} from "../src/evidence/types.js";

/**
 * The risk engine's guarantees, pinned.
 *
 * These tests exist less to check arithmetic than to stop the three properties
 * that make the score trustworthy from eroding: every point is attributable,
 * missing evidence is never safe, and a chain read outranks a provider claim.
 */

const NOW = 1_800_000_000_000;
const CHAIN = { source: "solana:mainnet", observedAt: NOW };
const PROVIDER = { source: "jupiter:tokens-v2", observedAt: NOW };

const V = <T>(value: T): Evidence<T> => verified({ value, ...CHAIN });
const R = <T>(value: T): Evidence<T> => reported({ value, ...PROVIDER });
const U = <T>(): Evidence<T> => unavailable<T>({ value: null, source: "unavailable:test", observedAt: NOW });

/** A clean, well-evidenced, low-risk token. */
function safeSnapshot(over: Partial<TokenEvidenceSnapshot> = {}): TokenEvidenceSnapshot {
  return {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    observedAt: NOW,
    identity: {
      symbol: R("BONK"),
      name: R("Bonk"),
      decimals: V(5),
      tokenProgram: R("Tokenkeg"),
      verifiedByProvider: R(true),
      duplicateSymbolCount: derived({ value: 1, source: "moonpaper:symbol-count", observedAt: NOW }),
    },
    market: {
      priceUsdPico: R(1_000_000n),
      marketCapUsdMicro: R(10_000_000n * 1_000_000n),
      fdvUsdMicro: R(11_000_000n * 1_000_000n),
      holderCount: R(90_000),
    },
    momentum: {
      priceChange5mBps: R(100n),
      priceChange1hBps: R(200n),
      priceChange24hBps: R(300n),
      volume5mUsdMicro: R(50_000n * 1_000_000n),
      volume24hUsdMicro: R(5_000_000n * 1_000_000n),
      traders5m: R(400),
    },
    liquidity: {
      liquidityUsdMicro: R(500_000n * 1_000_000n),
      depthBps: derived({ value: 500n, source: "moonpaper:depth-ratio", observedAt: NOW }),
      liquidityChange1hBps: R(50n),
    },
    holders: {
      topWalletConcentrationBps: V(1_000n),
      programHeldBps: V(4_000n),
      walletHolderCount: V(10),
      unclassifiedBps: V(0n),
    },
    authorities: {
      mintAuthorityRevoked: V(true),
      freezeAuthorityRevoked: V(true),
      providerAgreement: derived({ value: "agrees", source: "solana:mainnet", observedAt: NOW }),
    },
    walletBehaviour: {
      developerWalletPct: U<bigint>(),
      insiderPct: U<bigint>(),
      bundlerPct: U<bigint>(),
      sniperPct: U<bigint>(),
      smartTraderPct: U<bigint>(),
    },
    execution: null,
    lifecycle: { mintCreatedAt: U<number>(), firstPoolCreatedAt: R(NOW - 86_400_000), firstProviderObservedAt: R(NOW) },
    freshness: { marketUpdatedAt: R(NOW), marketAgeMs: derived({ value: 5_000, source: "moonpaper:clock", observedAt: NOW }) },
    unavailableEvidence: [],
    sources: ["solana:mainnet", "jupiter:tokens-v2"],
    ...over,
  };
}

describe("risk engine v3", () => {
  it("scores a clean, well-evidenced token as low risk with high confidence", () => {
    const result = assessRisk(safeSnapshot());
    expect(result.riskLevel).toBe("low");
    expect(result.riskScore).toBeLessThan(20);
    expect(result.riskConfidence).toBeGreaterThan(80);
    expect(result.riskModelVersion).toBe(RISK_MODEL_VERSION);
  });

  it("stamps the model version so stored scores stay comparable", () => {
    // A historical row must never be compared against a number a different
    // model produced.
    expect(assessRisk(safeSnapshot()).riskModelVersion).toMatch(/^risk-v3\./);
  });

  it("makes every point attributable — the factors sum to the score", () => {
    const result = assessRisk(
      safeSnapshot({
        authorities: {
          mintAuthorityRevoked: V(false),
          freezeAuthorityRevoked: V(false),
          providerAgreement: derived({ value: "agrees", source: "solana:mainnet", observedAt: NOW }),
        },
      }),
    );
    const summed = result.factors.reduce((t, f) => t + f.points, 0);
    expect(summed).toBe(result.riskScore);
    // And the reader can see what drove it: loudest factor first.
    expect(result.factors[0]!.points).toBeGreaterThanOrEqual(result.factors[1]!.points);
  });

  it("treats live authorities as a serious hazard", () => {
    const risky = assessRisk(
      safeSnapshot({
        authorities: {
          mintAuthorityRevoked: V(false),
          freezeAuthorityRevoked: V(false),
          providerAgreement: derived({ value: "agrees", source: "solana:mainnet", observedAt: NOW }),
        },
      }),
    );
    expect(risky.riskLevel).toBe("high");
    const mint = risky.factors.find((f) => f.id === "mint_authority")!;
    expect(mint.points).toBe(26);
    expect(mint.fact).toMatch(/still active/i);
    // Fact and interpretation stay separate.
    expect(mint.interpretation).not.toBe(mint.fact);
  });

  it("never treats missing evidence as safe", () => {
    // The core guarantee. An unknown authority must score worse than a
    // confirmed-revoked one.
    const blind = assessRisk(
      safeSnapshot({
        authorities: {
          mintAuthorityRevoked: U<boolean>(),
          freezeAuthorityRevoked: U<boolean>(),
          providerAgreement: U<"agrees" | "disagrees" | "not_reported">(),
        },
        holders: {
          topWalletConcentrationBps: U<bigint>(),
          programHeldBps: U<bigint>(),
          walletHolderCount: U<number>(),
          unclassifiedBps: U<bigint>(),
        },
      }),
    );
    const known = assessRisk(safeSnapshot());
    expect(blind.riskScore).toBeGreaterThan(known.riskScore);
    // And it says so, rather than quietly scoring around the gap.
    expect(blind.riskConfidence).toBeLessThan(known.riskConfidence);
    expect(blind.factors.find((f) => f.id === "mint_authority")!.status).toBe("unavailable");
  });

  it("does not make ignorance cheaper than knowledge", () => {
    // An absent factor's penalty must not be discounted by authority weight,
    // or the less we know the less it would cost us.
    const blind = assessRisk(
      safeSnapshot({
        authorities: {
          mintAuthorityRevoked: U<boolean>(),
          freezeAuthorityRevoked: V(true),
          providerAgreement: derived({ value: "agrees", source: "solana:mainnet", observedAt: NOW }),
        },
      }),
    );
    expect(blind.factors.find((f) => f.id === "mint_authority")!.points).toBe(18);
  });

  it("discounts a provider claim against the same fact read from the chain", () => {
    const fromChain = assessRisk(
      safeSnapshot({
        authorities: {
          mintAuthorityRevoked: V(false),
          freezeAuthorityRevoked: V(true),
          providerAgreement: derived({ value: "agrees", source: "solana:mainnet", observedAt: NOW }),
        },
      }),
    );
    const fromProvider = assessRisk(
      safeSnapshot({
        authorities: {
          mintAuthorityRevoked: R(false),
          freezeAuthorityRevoked: V(true),
          providerAgreement: derived({ value: "agrees", source: "solana:mainnet", observedAt: NOW }),
        },
      }),
    );
    const chainPoints = fromChain.factors.find((f) => f.id === "mint_authority")!.points;
    const providerPoints = fromProvider.factors.find((f) => f.id === "mint_authority")!.points;
    expect(chainPoints).toBe(26);
    expect(providerPoints).toBeLessThan(chainPoints);
    expect(fromProvider.riskConfidence).toBeLessThan(fromChain.riskConfidence);
  });

  it("flags a provider that contradicts the chain", () => {
    const result = assessRisk(
      safeSnapshot({
        authorities: {
          mintAuthorityRevoked: V(true),
          freezeAuthorityRevoked: V(true),
          providerAgreement: derived({ value: "disagrees", source: "solana:mainnet", observedAt: NOW }),
        },
      }),
    );
    const factor = result.factors.find((f) => f.id === "provider_agreement")!;
    expect(factor.points).toBeGreaterThan(0);
    expect(factor.interpretation).toMatch(/inaccurate/i);
  });

  it("escalates concentration in bands rather than a cliff", () => {
    const at = (bps: bigint) =>
      assessRisk(
        safeSnapshot({
          holders: {
            topWalletConcentrationBps: V(bps),
            programHeldBps: V(0n),
            walletHolderCount: V(10),
            unclassifiedBps: V(0n),
          },
        }),
      ).factors.find((f) => f.id === "holder_concentration")!.points;

    expect(at(1_000n)).toBe(0);
    expect(at(2_000n)).toBeGreaterThan(0);
    expect(at(3_000n)).toBeGreaterThan(at(2_000n));
    expect(at(5_000n)).toBeGreaterThan(at(3_000n));
    expect(at(7_000n)).toBeGreaterThan(at(5_000n));
  });

  it("penalises incomplete holder classification", () => {
    // The headline concentration figure is understated by exactly this much.
    const result = assessRisk(
      safeSnapshot({
        holders: {
          topWalletConcentrationBps: V(1_000n),
          programHeldBps: V(4_000n),
          walletHolderCount: V(10),
          unclassifiedBps: V(1_500n),
        },
      }),
    );
    const factor = result.factors.find((f) => f.id === "holder_classification")!;
    expect(factor.points).toBeGreaterThan(0);
    expect(factor.fact).toMatch(/could not be classified/i);
  });

  it("scores execution only when a real quote backs it", () => {
    const noQuote = assessRisk(safeSnapshot());
    expect(noQuote.factors.find((f) => f.id === "execution_impact")).toBeUndefined();

    const expensive = assessRisk(
      safeSnapshot({
        execution: {
          priceImpactBps: R(1_200n),
          routeVenues: R(["Meteora"]),
          quotedOutAmount: R(1_000n),
          minOutAmount: R(990n),
          slippageBps: R(50n),
        },
      }),
    );
    const factor = expensive.factors.find((f) => f.id === "execution_impact")!;
    expect(factor.points).toBeGreaterThan(0);
    expect(factor.fact).toMatch(/12\.0%/);
  });

  it("treats a shared ticker as an identity hazard", () => {
    const result = assessRisk(
      safeSnapshot({
        identity: {
          ...safeSnapshot().identity,
          duplicateSymbolCount: derived({ value: 4, source: "moonpaper:symbol-count", observedAt: NOW }),
        },
      }),
    );
    const factor = result.factors.find((f) => f.id === "ticker_ambiguity")!;
    expect(factor.points).toBeGreaterThan(0);
    expect(factor.interpretation).toMatch(/not an identity/i);
  });

  it("penalises stale market data", () => {
    const result = assessRisk(
      safeSnapshot({
        freshness: {
          marketUpdatedAt: R(NOW - 600_000),
          marketAgeMs: derived({ value: 600_000, source: "moonpaper:clock", observedAt: NOW }),
        },
      }),
    );
    // 12 raw, discounted to 10 because age is derived from a provider
    // timestamp rather than read from the chain.
    const factor = result.factors.find((f) => f.id === "market_freshness")!;
    expect(factor.points).toBe(10);
    expect(factor.status).toBe("derived");

    const current = assessRisk(safeSnapshot());
    expect(current.factors.find((f) => f.id === "market_freshness")!.points).toBe(0);
  });

  it("is deterministic, so a stored score stays comparable", () => {
    const snap = safeSnapshot();
    expect(assessRisk(snap)).toEqual(assessRisk(snap));
  });

  it("clamps to 0-100 even when every factor fires", () => {
    const worst = assessRisk(
      safeSnapshot({
        authorities: {
          mintAuthorityRevoked: V(false),
          freezeAuthorityRevoked: V(false),
          providerAgreement: derived({ value: "disagrees", source: "solana:mainnet", observedAt: NOW }),
        },
        holders: {
          topWalletConcentrationBps: V(9_000n),
          programHeldBps: V(0n),
          walletHolderCount: V(2),
          unclassifiedBps: V(2_000n),
        },
        liquidity: {
          liquidityUsdMicro: R(100n * 1_000_000n),
          depthBps: derived({ value: 1n, source: "moonpaper:depth-ratio", observedAt: NOW }),
          liquidityChange1hBps: R(-5_000n),
        },
        freshness: {
          marketUpdatedAt: R(NOW - 900_000),
          marketAgeMs: derived({ value: 900_000, source: "moonpaper:clock", observedAt: NOW }),
        },
      }),
    );
    expect(worst.riskScore).toBeLessThanOrEqual(100);
    expect(worst.riskScore).toBeGreaterThan(80);
    expect(worst.riskLevel).toBe("high");
  });

  it("returns risk only — never an opportunity or quality score", () => {
    // Guards the separation deliberately: a risky token can have momentum, and
    // conflating the two is how a research tool starts implying advice.
    const result = assessRisk(safeSnapshot());
    expect(Object.keys(result).sort()).toEqual([
      "factors",
      "missingEvidence",
      "observedAt",
      "riskConfidence",
      "riskLevel",
      "riskModelVersion",
      "riskScore",
    ]);
  });
});
