/**
 * The canonical evidence representation.
 *
 * Moonpaper has four assessment paths — the live-feed assessment, detailed
 * research, the scoring pillars, and the tradability gates. They are NOT
 * duplicates: each answers a different question from a different input, and
 * collapsing them would lose information. What they lacked was a shared way to
 * state the *facts* they reason from, so every consumer re-derived provenance
 * in its own shape and a fact could not be carried between them, stored, or
 * diffed against an earlier observation.
 *
 * This module is that shared representation, and nothing more. It changes no
 * behaviour on its own: it is the substrate the versioned risk engine,
 * lifecycle timestamps, wallet cohorts, historical snapshots and risk-change
 * explanations are all built on.
 *
 * The rule it exists to enforce: a value never travels without the story of
 * where it came from and how much it can be trusted.
 */

/**
 * How much authority a value carries.
 *
 * A strict superset of the `FactStatus` used by `market/research.ts`
 * (`verified` | `reported` | `unavailable`), which must not lose precision —
 * the distinction between a fact read from the chain and a provider's claim
 * about it is what the entire risk model rests on.
 *
 * - `verified`    read directly from the chain; the highest authority there is
 * - `reported`    an external provider's claim, believed but not confirmed
 * - `derived`     computed by us from other evidence, no better than its inputs
 * - `stale`       genuinely observed, but too old to act on
 * - `unavailable` no value. NOT a zero, NOT a safe default, NOT "fine"
 */
export type EvidenceStatus = "verified" | "reported" | "derived" | "stale" | "unavailable";

/** Statuses that carry a usable value. `unavailable` never does. */
export const USABLE_STATUSES: readonly EvidenceStatus[] = [
  "verified",
  "reported",
  "derived",
  "stale",
];

/**
 * One fact, with its provenance.
 *
 * `value` is `null` whenever `status` is `unavailable`, and the two are kept
 * consistent by the constructors below rather than by convention — a caller
 * cannot accidentally publish a value that claims to be missing, or a missing
 * value that claims to be verified.
 */
export interface Evidence<T> {
  value: T | null;
  status: EvidenceStatus;
  /** Who said so: a provider id, an RPC source, or the deriving rule. */
  source: string;
  /** When this was observed at source, not when it was serialized. */
  observedAt: number;
  /**
   * 0-100, where the source can express one. Absent means "no opinion", which
   * is different from low confidence and must not be read as either.
   */
  confidence?: number;
  /** Why the value is missing or stale. Shown to the user, so keep it plain. */
  detail?: string;
}

export interface EvidenceInput<T> {
  value: T | null;
  source: string;
  observedAt: number;
  confidence?: number;
  detail?: string;
}

/** A value read directly from the chain. */
export const verified = <T>(input: EvidenceInput<T>): Evidence<T> =>
  input.value === null ? unavailable<T>(input) : { ...input, value: input.value, status: "verified" };

/** An external provider's claim. Believed, not confirmed. */
export const reported = <T>(input: EvidenceInput<T>): Evidence<T> =>
  input.value === null ? unavailable<T>(input) : { ...input, value: input.value, status: "reported" };

/** Computed by us. Never more trustworthy than the inputs it came from. */
export const derived = <T>(input: EvidenceInput<T>): Evidence<T> =>
  input.value === null ? unavailable<T>(input) : { ...input, value: input.value, status: "derived" };

/** Genuinely observed, but past the point where it should drive a decision. */
export const stale = <T>(input: EvidenceInput<T>): Evidence<T> => ({
  ...input,
  status: "stale",
});

/**
 * No value. The `value` is forced to null so a caller cannot ship a number
 * alongside a claim that there is no number.
 */
export const unavailable = <T>(input: EvidenceInput<T>): Evidence<T> => ({
  ...input,
  value: null,
  status: "unavailable",
});

/** True when the evidence carries a value that may be used. */
export const hasValue = <T>(e: Evidence<T> | undefined): e is Evidence<T> & { value: T } =>
  e !== undefined && e.value !== null && e.status !== "unavailable";

/**
 * Re-label evidence as stale once it is older than `maxAgeMs`.
 *
 * Freshness is a property of the reader's tolerance, not of the fact, so it is
 * applied at the point of use rather than baked in at observation.
 */
export function withFreshness<T>(e: Evidence<T>, nowMs: number, maxAgeMs: number): Evidence<T> {
  if (e.status === "unavailable" || e.value === null) return e;
  const ageMs = nowMs - e.observedAt;
  if (ageMs <= maxAgeMs) return e;
  return {
    ...e,
    status: "stale",
    detail: e.detail ?? `Observed ${Math.round(ageMs / 1000)}s ago, past the ${Math.round(maxAgeMs / 1000)}s limit`,
  };
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** What a token is, independent of what the market is doing. */
export interface IdentityEvidence {
  symbol: Evidence<string>;
  name: Evidence<string>;
  decimals: Evidence<number>;
  tokenProgram: Evidence<string>;
  verifiedByProvider: Evidence<boolean>;
  /** How many distinct mints share this ticker. Symbols are not identity. */
  duplicateSymbolCount: Evidence<number>;
}

/** Money quantities, all in the app's fixed-point integer scales. */
export interface MarketEvidence {
  priceUsdPico: Evidence<bigint>;
  marketCapUsdMicro: Evidence<bigint>;
  fdvUsdMicro: Evidence<bigint>;
  holderCount: Evidence<number>;
}

export interface MomentumEvidence {
  priceChange5mBps: Evidence<bigint>;
  priceChange1hBps: Evidence<bigint>;
  priceChange24hBps: Evidence<bigint>;
  volume5mUsdMicro: Evidence<bigint>;
  volume24hUsdMicro: Evidence<bigint>;
  traders5m: Evidence<number>;
}

export interface LiquidityEvidence {
  liquidityUsdMicro: Evidence<bigint>;
  /** Liquidity as a share of market cap, bps. Depth relative to size. */
  depthBps: Evidence<bigint>;
  liquidityChange1hBps: Evidence<bigint>;
}

/**
 * Ownership concentration.
 *
 * `topWalletConcentrationBps` deliberately excludes pools and bonding curves —
 * see `solana/holders.ts` for why counting them inverts the meaning of the
 * metric. `programHeldBps` is reported separately rather than folded in.
 */
export interface HolderEvidence {
  topWalletConcentrationBps: Evidence<bigint>;
  programHeldBps: Evidence<bigint>;
  walletHolderCount: Evidence<number>;
  /** Non-zero means the classification was incomplete; do not read as safe. */
  unclassifiedBps: Evidence<bigint>;
}

/** What the token's owner can still do. The chain is the authority here. */
export interface AuthorityEvidence {
  mintAuthorityRevoked: Evidence<boolean>;
  freezeAuthorityRevoked: Evidence<boolean>;
  /** Whether the provider's claim matched the chain read. */
  providerAgreement: Evidence<"agrees" | "disagrees" | "not_reported">;
}

/**
 * Wallet cohorts. Every field is `unavailable` until a provider that can
 * support the claim exists — a fabricated label is worse than no label, and a
 * funding relationship is never proof that two wallets are one person.
 */
export interface WalletBehaviourEvidence {
  developerWalletPct: Evidence<bigint>;
  insiderPct: Evidence<bigint>;
  bundlerPct: Evidence<bigint>;
  sniperPct: Evidence<bigint>;
  smartTraderPct: Evidence<bigint>;
}

/** What a trade of a real size would actually cost right now. */
export interface ExecutionEvidence {
  priceImpactBps: Evidence<bigint>;
  routeVenues: Evidence<string[]>;
  quotedOutAmount: Evidence<bigint>;
  minOutAmount: Evidence<bigint>;
  slippageBps: Evidence<bigint>;
}

/**
 * Token lifecycle. These three are NOT interchangeable and one must never be
 * substituted for another: a provider's first sighting is not the first pool,
 * and neither is the mint's creation. Where a timestamp cannot be established
 * it stays unavailable.
 */
export interface LifecycleEvidence {
  mintCreatedAt: Evidence<number>;
  firstPoolCreatedAt: Evidence<number>;
  firstProviderObservedAt: Evidence<number>;
}

export interface FreshnessEvidence {
  /** When the provider last updated its market view. */
  marketUpdatedAt: Evidence<number>;
  /** Age of that observation at snapshot time, ms. */
  marketAgeMs: Evidence<number>;
}

export interface TokenEvidenceSnapshot {
  mint: string;
  observedAt: number;
  identity: IdentityEvidence;
  market: MarketEvidence;
  momentum: MomentumEvidence;
  liquidity: LiquidityEvidence;
  holders: HolderEvidence;
  authorities: AuthorityEvidence;
  walletBehaviour: WalletBehaviourEvidence;
  execution: ExecutionEvidence | null;
  lifecycle: LifecycleEvidence;
  freshness: FreshnessEvidence;
  /**
   * Dotted paths of every field with no value, e.g. `holders.programHeldBps`.
   * Published so a consumer can state what it did not know rather than
   * quietly scoring around the gap — missing evidence is never safe.
   */
  unavailableEvidence: string[];
  /** Every distinct source that contributed, for auditing a snapshot. */
  sources: string[];
}

/** Walks a snapshot and collects the paths of everything unavailable. */
export function collectUnavailable(groups: Record<string, Record<string, Evidence<unknown>>>): string[] {
  const missing: string[] = [];
  for (const [groupName, group] of Object.entries(groups)) {
    for (const [field, evidence] of Object.entries(group)) {
      if (!hasValue(evidence)) missing.push(`${groupName}.${field}`);
    }
  }
  return missing.sort();
}

/** Every distinct source across a snapshot's groups, ignoring absent facts. */
export function collectSources(groups: Record<string, Record<string, Evidence<unknown>>>): string[] {
  const sources = new Set<string>();
  for (const group of Object.values(groups)) {
    for (const evidence of Object.values(group)) {
      if (hasValue(evidence)) sources.add(evidence.source);
    }
  }
  return [...sources].sort();
}
