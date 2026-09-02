import { describe, expect, it } from "vitest";
import { assessRisk } from "../src/risk/engineV3.js";
import { diffEvidence, explainRiskChange, formatRiskChange } from "../src/risk/diff.js";
import { snapshotFromResearch } from "../src/evidence/build.js";
import type { ResearchProfile } from "../src/market/research.js";

/**
 * Risk-change explanations must be reconstructable from stored facts, not
 * narrated. These tests pin that the output is derived arithmetic and that a
 * comparison across model versions is refused rather than fudged.
 */

const NOW = 1_800_000_000_000;
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const baseMarket = {
  priceUsdPico: 1_000_000n,
  liquidityUsdMicro: 500_000n * 1_000_000n,
  marketCapUsdMicro: 10_000_000n * 1_000_000n,
  fdvUsdMicro: null,
  holderCount: 90_000,
  change1hBps: 100n,
  change24hBps: 200n,
  buyVolume24hUsdMicro: 1_000n,
  sellVolume24hUsdMicro: 1_000n,
  numBuys24h: 10,
  numSells24h: 10,
  topHolderPctBps: 1_000n,
  organicScore: 90,
  organicScoreLabel: "high",
};

const profile = (over: Record<string, unknown> = {}): ResearchProfile =>
  ({
    mint: MINT,
    symbol: "BONK",
    name: "Bonk",
    decimals: 5,
    tokenProgram: "Tokenkeg",
    iconUrl: null,
    tags: [],
    verifiedByProvider: true,
    identitySource: "jupiter:tokens-v2",
    marketSource: "jupiter:tokens-v2",
    marketUpdatedAtMs: NOW - 2_000,
    market: baseMarket,
    verification: {
      status: "verified",
      source: "solana:mainnet",
      checkedAtMs: NOW - 1_000,
      decimalsOnChain: 5,
      holders: {
        status: "verified",
        concentrationBps: 1_000n,
        programHeldBps: 4_000n,
        walletHolderCount: 10,
        unclassifiedBps: 0n,
        detail: "Classified all top accounts",
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

const snap = (over: Record<string, unknown> = {}) => snapshotFromResearch(profile(over), NOW);

const blindChain = {
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
};

describe("risk change explanations", () => {
  it("explains a rise with attributable, signed lines", () => {
    const before = assessRisk(snap());
    const after = assessRisk(
      snap({
        verification: {
          status: "verified",
          source: "solana:mainnet",
          checkedAtMs: NOW - 1_000,
          decimalsOnChain: 5,
          holders: {
            status: "verified",
            concentrationBps: 5_000n,
            programHeldBps: 3_000n,
            walletHolderCount: 4,
            unclassifiedBps: 0n,
            detail: "Classified all top accounts",
          },
        },
      }),
    );

    const change = explainRiskChange(before, after);
    expect(change.comparable).toBe(true);
    expect(change.delta).toBeGreaterThan(0);

    const line = change.lines.find((l) => l.id === "holder_concentration")!;
    expect(line.delta).toBeGreaterThan(0);
    expect(line.explanation).toMatch(/50\.0% of supply/);

    // The lines account for the score move exactly.
    const summed = change.lines.reduce((t, l) => t + l.delta, 0);
    expect(summed).toBe(change.delta);
  });

  it("distinguishes a value changing from a measurement being lost", () => {
    const before = assessRisk(snap());
    const after = assessRisk(snap(blindChain));

    const change = explainRiskChange(before, after);
    const line = change.lines.find((l) => l.id === "mint_authority")!;
    expect(line.explanation).toMatch(/could no longer be measured/i);
    expect(change.evidenceLost).toContain("authorities.mintAuthorityRevoked");
    expect(change.currentConfidence).toBeLessThan(change.previousConfidence);
  });

  it("reports confidence as its own line, not folded into a factor", () => {
    const before = assessRisk(snap());
    const after = assessRisk(snap(blindChain));
    const line = explainRiskChange(before, after).lines.find((l) => l.id === "evidence_confidence")!;
    expect(line.delta).toBe(0);
    expect(line.explanation).toMatch(/rests on less/);
  });

  it("refuses to compare scores from different model versions", () => {
    // Two models, two scales: subtracting them would look authoritative and
    // mean nothing.
    const a = assessRisk(snap());
    const b = { ...assessRisk(snap()), riskModelVersion: "risk-v4.0.0" };
    const change = explainRiskChange(a, b);
    expect(change.comparable).toBe(false);
    expect(change.incomparableReason).toMatch(/not on the same scale/i);
    expect(change.lines).toEqual([]);
  });

  it("renders the terse block shown in the UI", () => {
    const before = assessRisk(snap());
    const after = assessRisk(
      snap({
        authorities: {
          mintAuthorityRevoked: false,
          freezeAuthorityRevoked: true,
          source: "solana:mainnet",
          providerAgreement: "agrees",
        },
      }),
    );
    const text = formatRiskChange(explainRiskChange(before, after));
    expect(text).toMatch(/^Risk \d+ -> \d+ \(\+\d+\)/);
    expect(text).toMatch(/\+26\s+Mint authority is still active\./);
  });

  it("is deterministic", () => {
    const a = assessRisk(snap());
    const b = assessRisk(snap({ market: { ...baseMarket, liquidityUsdMicro: 1_000n } }));
    expect(explainRiskChange(a, b)).toEqual(explainRiskChange(a, b));
  });
});

describe("evidence diffing", () => {
  it("surfaces a move that the risk score does not react to", () => {
    // Liquidity halving inside a band leaves risk unchanged but still matters.
    const before = snap();
    const after = snap({ market: { ...baseMarket, liquidityUsdMicro: 250_000n * 1_000_000n } });

    const changes = diffEvidence(before, after);
    const liquidity = changes.find((c) => c.path === "liquidity.liquidityUsdMicro")!;
    expect(liquidity.changePct).toBeCloseTo(-50, 1);
    expect(liquidity.note).toMatch(/Fell 50\.0%/);
  });

  it("reports evidence becoming and ceasing to be measurable", () => {
    const measured = snap();
    const blind = snap(blindChain);

    const lost = diffEvidence(measured, blind).find(
      (c) => c.path === "holders.topWalletConcentrationBps",
    )!;
    expect(lost.note).toBe("Stopped being measurable");
    expect(lost.current).toBeNull();

    const gained = diffEvidence(blind, measured).find(
      (c) => c.path === "holders.topWalletConcentrationBps",
    )!;
    expect(gained.note).toBe("Became measurable");
    expect(gained.previous).toBeNull();
  });

  it("ignores fields that did not move", () => {
    expect(diffEvidence(snap(), snap())).toEqual([]);
  });
});
