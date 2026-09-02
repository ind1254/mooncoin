import type { LiveFeedToken } from "../market/jupiter/liveFeed.js";
import type { NormalizedSwapQuote } from "../market/jupiter/quotes.js";
import type { ResearchProfile } from "../market/research.js";
import {
  collectSources,
  collectUnavailable,
  derived,
  reported,
  unavailable,
  verified,
  withFreshness,
  type Evidence,
  type TokenEvidenceSnapshot,
} from "./types.js";

/**
 * Builders that turn the existing provider models into a canonical snapshot.
 *
 * These are adapters, not a new source of truth. Every value here already
 * existed somewhere in the codebase; what the snapshot adds is a consistent
 * account of where each one came from and whether it can be trusted.
 *
 * Two rules hold throughout:
 *
 *   1. Nothing is invented. A field with no backing observation is
 *      `unavailable` with a reason, never a zero and never a default.
 *   2. Authority is preserved. A chain read is `verified`; a provider claim is
 *      `reported`; anything we compute is `derived` and no stronger than its
 *      inputs. Downgrading a chain read to a provider claim would quietly
 *      weaken every gate that depends on the distinction.
 */

/** Wallet cohorts have no provider yet. Stated as absent, never as zero. */
const NO_WALLET_PROVIDER = "unavailable:no-wallet-intelligence-provider";
const WALLET_DETAIL = "No wallet-labelling provider is configured";

function emptyWalletBehaviour(observedAt: number) {
  const absent = <T>(): Evidence<T> =>
    unavailable<T>({ value: null, source: NO_WALLET_PROVIDER, observedAt, detail: WALLET_DETAIL });
  return {
    developerWalletPct: absent<bigint>(),
    insiderPct: absent<bigint>(),
    bundlerPct: absent<bigint>(),
    sniperPct: absent<bigint>(),
    smartTraderPct: absent<bigint>(),
  };
}

/** Liquidity as a share of market cap, bps. Depth relative to size. */
function depthBps(
  liquidityUsdMicro: bigint | null,
  marketCapUsdMicro: bigint | null,
): bigint | null {
  if (liquidityUsdMicro === null || marketCapUsdMicro === null || marketCapUsdMicro <= 0n) {
    return null;
  }
  return (liquidityUsdMicro * 10_000n) / marketCapUsdMicro;
}

function finish(
  mint: string,
  observedAt: number,
  groups: Record<string, Record<string, Evidence<unknown>>>,
  execution: TokenEvidenceSnapshot["execution"],
): Pick<TokenEvidenceSnapshot, "mint" | "observedAt" | "unavailableEvidence" | "sources"> {
  const withExecution = execution
    ? { ...groups, execution: execution as unknown as Record<string, Evidence<unknown>> }
    : groups;
  return {
    mint,
    observedAt,
    unavailableEvidence: collectUnavailable(withExecution),
    sources: collectSources(withExecution),
  };
}

export interface FeedSnapshotOptions {
  /** Distinct mints sharing this ticker. Symbols are not identity. */
  duplicateSymbolCount?: number;
  /** Past this age the provider's market view is labelled stale, not fresh. */
  maxMarketAgeMs?: number;
}

/**
 * Build a snapshot from one discovery-feed row.
 *
 * Everything here is `reported`: the feed is a provider's view of the market.
 * The provider's authority claims are deliberately NOT promoted to `verified`
 * — only a chain read earns that, and conflating the two is exactly the
 * mistake the research module exists to prevent.
 */
export function snapshotFromFeedToken(
  item: LiveFeedToken,
  nowMs: number,
  options: FeedSnapshotOptions = {},
): TokenEvidenceSnapshot {
  const t = item.token;
  const m = t.market;
  const source = t.source ?? "jupiter:tokens-v2";
  const observedAt = item.updatedAtMs ?? nowMs;
  const at = { source, observedAt };
  const maxAgeMs = options.maxMarketAgeMs ?? 60_000;

  const fresh = <T>(value: T | null, detail?: string): Evidence<T> =>
    withFreshness(reported<T>({ value, ...at, ...(detail ? { detail } : {}) }), nowMs, maxAgeMs);

  const identity = {
    symbol: reported<string>({ value: t.symbol, ...at }),
    name: reported<string>({ value: t.name, ...at }),
    decimals: reported<number>({ value: t.decimals, ...at }),
    tokenProgram: reported<string>({ value: t.tokenProgram, ...at }),
    verifiedByProvider: reported<boolean>({ value: t.verifiedByProvider, ...at }),
    duplicateSymbolCount: derived<number>({
      value: options.duplicateSymbolCount ?? null,
      source: "moonpaper:feed-symbol-count",
      observedAt: nowMs,
      ...(options.duplicateSymbolCount === undefined
        ? { detail: "Ticker ambiguity was not measured for this row" }
        : {}),
    }),
  };

  const market = {
    priceUsdPico: fresh<bigint>(m.priceUsdPico),
    marketCapUsdMicro: fresh<bigint>(m.marketCapUsdMicro),
    fdvUsdMicro: fresh<bigint>(m.fdvUsdMicro),
    holderCount: fresh<number>(m.holderCount),
  };

  const momentum = {
    priceChange5mBps: fresh<bigint>(item.fiveMinutes.priceChangeBps),
    priceChange1hBps: fresh<bigint>(m.change1hBps),
    priceChange24hBps: fresh<bigint>(m.change24hBps),
    volume5mUsdMicro: fresh<bigint>(
      item.fiveMinutes.buyVolumeUsdMicro === null && item.fiveMinutes.sellVolumeUsdMicro === null
        ? null
        : (item.fiveMinutes.buyVolumeUsdMicro ?? 0n) + (item.fiveMinutes.sellVolumeUsdMicro ?? 0n),
    ),
    volume24hUsdMicro: fresh<bigint>(
      m.buyVolume24hUsdMicro === null && m.sellVolume24hUsdMicro === null
        ? null
        : (m.buyVolume24hUsdMicro ?? 0n) + (m.sellVolume24hUsdMicro ?? 0n),
    ),
    traders5m: fresh<number>(item.fiveMinutes.traders),
  };

  const liquidity = {
    liquidityUsdMicro: fresh<bigint>(m.liquidityUsdMicro),
    depthBps: derived<bigint>({
      value: depthBps(m.liquidityUsdMicro, m.marketCapUsdMicro),
      source: "moonpaper:depth-ratio",
      observedAt,
      detail: "Liquidity as a share of market cap",
    }),
    liquidityChange1hBps: fresh<bigint>(item.oneHour.liquidityChangeBps),
  };

  // The feed reports a top-holder share but cannot say whether those holders
  // are people or pools. Recorded as reported, and NOT presented as the
  // pool-excluding figure the chain read produces.
  const holders = {
    topWalletConcentrationBps: reported<bigint>({
      value: m.topHolderPctBps,
      ...at,
      detail: "Provider figure; pools and bonding curves are not excluded",
    }),
    programHeldBps: unavailable<bigint>({
      value: null,
      source: "unavailable:requires-chain-read",
      observedAt: nowMs,
      detail: "Separating pool-held supply needs an on-chain holder read",
    }),
    walletHolderCount: unavailable<number>({
      value: null,
      source: "unavailable:requires-chain-read",
      observedAt: nowMs,
      detail: "Wallet-versus-program classification needs an on-chain read",
    }),
    unclassifiedBps: unavailable<bigint>({
      value: null,
      source: "unavailable:requires-chain-read",
      observedAt: nowMs,
      detail: "Not measurable without on-chain holder classification",
    }),
  };

  const claims = t.providerClaims ?? {};
  const authorities = {
    mintAuthorityRevoked: reported<boolean>({
      value: claims.mintAuthorityDisabled ?? null,
      ...at,
      detail: "Provider claim; not confirmed against the chain",
    }),
    freezeAuthorityRevoked: reported<boolean>({
      value: claims.freezeAuthorityDisabled ?? null,
      ...at,
      detail: "Provider claim; not confirmed against the chain",
    }),
    providerAgreement: unavailable<"agrees" | "disagrees" | "not_reported">({
      value: null,
      source: "unavailable:requires-chain-read",
      observedAt: nowMs,
      detail: "Agreement can only be judged against an on-chain read",
    }),
  };

  // The feed's pool timestamp is a first-pool sighting. It is NOT the mint's
  // creation time, and is never reported as one.
  const lifecycle = {
    mintCreatedAt: unavailable<number>({
      value: null,
      source: "unavailable:no-history-provider",
      observedAt: nowMs,
      detail: "True mint creation time needs indexed transaction history",
    }),
    firstPoolCreatedAt: reported<number>({ value: item.firstPoolAtMs, ...at }),
    firstProviderObservedAt: reported<number>({ value: item.updatedAtMs, ...at }),
  };

  const freshness = {
    marketUpdatedAt: reported<number>({ value: item.updatedAtMs, ...at }),
    marketAgeMs: derived<number>({
      value: item.updatedAtMs === null ? null : Math.max(0, nowMs - item.updatedAtMs),
      source: "moonpaper:clock",
      observedAt: nowMs,
    }),
  };

  const walletBehaviour = emptyWalletBehaviour(nowMs);
  const groups = {
    identity,
    market,
    momentum,
    liquidity,
    holders,
    authorities,
    walletBehaviour,
    lifecycle,
    freshness,
  } as unknown as Record<string, Record<string, Evidence<unknown>>>;

  return {
    ...finish(t.mint, nowMs, groups, null),
    identity,
    market,
    momentum,
    liquidity,
    holders,
    authorities,
    walletBehaviour,
    execution: null,
    lifecycle,
    freshness,
  };
}

/**
 * Build a snapshot from a detailed research profile, optionally with a live
 * quote for the execution group.
 *
 * The difference from the feed builder is authority: research has read the
 * chain, so authorities and holder concentration are `verified` where the read
 * succeeded, and the provider's disagreement is surfaced rather than hidden.
 */
export function snapshotFromResearch(
  profile: ResearchProfile,
  nowMs: number,
  options: { quote?: NormalizedSwapQuote; duplicateSymbolCount?: number; maxMarketAgeMs?: number } = {},
): TokenEvidenceSnapshot {
  const m = profile.market;
  const at = { source: profile.marketSource, observedAt: profile.marketUpdatedAtMs ?? profile.fetchedAtMs };
  const idAt = { source: profile.identitySource, observedAt: profile.fetchedAtMs };
  const maxAgeMs = options.maxMarketAgeMs ?? 60_000;
  const chain = profile.verification;
  const chainAt = { source: chain.source, observedAt: chain.checkedAtMs };

  const fresh = <T>(value: T | null): Evidence<T> =>
    withFreshness(reported<T>({ value, ...at }), nowMs, maxAgeMs);

  const identity = {
    symbol: reported<string>({ value: profile.symbol, ...idAt }),
    name: reported<string>({ value: profile.name, ...idAt }),
    // On-chain decimals outrank the catalog's when both exist.
    decimals:
      chain.decimalsOnChain !== undefined
        ? verified<number>({
            value: chain.decimalsOnChain,
            ...chainAt,
            ...(chain.decimalsMismatch ? { detail: "On-chain decimals disagree with the catalog" } : {}),
          })
        : reported<number>({ value: profile.decimals, ...idAt }),
    tokenProgram: reported<string>({ value: profile.tokenProgram, ...idAt }),
    verifiedByProvider: reported<boolean>({ value: profile.verifiedByProvider, ...idAt }),
    duplicateSymbolCount: derived<number>({
      value: options.duplicateSymbolCount ?? null,
      source: "moonpaper:symbol-count",
      observedAt: nowMs,
      ...(options.duplicateSymbolCount === undefined
        ? { detail: "Ticker ambiguity was not measured" }
        : {}),
    }),
  };

  const market = {
    priceUsdPico: fresh<bigint>(m.priceUsdPico),
    marketCapUsdMicro: fresh<bigint>(m.marketCapUsdMicro),
    fdvUsdMicro: fresh<bigint>(m.fdvUsdMicro),
    holderCount: fresh<number>(m.holderCount),
  };

  const momentum = {
    priceChange5mBps: unavailable<bigint>({
      value: null,
      source: "unavailable:not-published-per-token",
      observedAt: nowMs,
      detail: "The provider publishes 5m windows only for trending tokens",
    }),
    priceChange1hBps: fresh<bigint>(m.change1hBps),
    priceChange24hBps: fresh<bigint>(m.change24hBps),
    volume5mUsdMicro: unavailable<bigint>({
      value: null,
      source: "unavailable:not-published-per-token",
      observedAt: nowMs,
      detail: "The provider publishes 5m windows only for trending tokens",
    }),
    volume24hUsdMicro: fresh<bigint>(
      m.buyVolume24hUsdMicro === null && m.sellVolume24hUsdMicro === null
        ? null
        : (m.buyVolume24hUsdMicro ?? 0n) + (m.sellVolume24hUsdMicro ?? 0n),
    ),
    traders5m: unavailable<number>({
      value: null,
      source: "unavailable:not-published-per-token",
      observedAt: nowMs,
      detail: "The provider publishes 5m windows only for trending tokens",
    }),
  };

  const liquidity = {
    liquidityUsdMicro: fresh<bigint>(m.liquidityUsdMicro),
    depthBps: derived<bigint>({
      value: depthBps(m.liquidityUsdMicro, m.marketCapUsdMicro),
      source: "moonpaper:depth-ratio",
      observedAt: at.observedAt,
    }),
    liquidityChange1hBps: unavailable<bigint>({
      value: null,
      source: "unavailable:not-published-per-token",
      observedAt: nowMs,
      detail: "Liquidity change is published only for trending tokens",
    }),
  };

  // The chain read excludes pools and curves, which is what makes this figure
  // mean what a reader assumes it means.
  const h = chain.holders;
  const holderVerified = h?.status === "verified" || h?.status === "incomplete";
  const holderEvidence = <T>(value: T | null | undefined): Evidence<T> =>
    holderVerified && value !== undefined && value !== null
      ? verified<T>({ value, ...chainAt, ...(h?.status === "incomplete" ? { detail: h.detail } : {}) })
      : unavailable<T>({
          value: null,
          source: chain.source,
          observedAt: chain.checkedAtMs,
          detail: h?.detail ?? "On-chain holder classification was not available",
        });

  const holders = {
    topWalletConcentrationBps: holderEvidence<bigint>(h?.concentrationBps),
    programHeldBps: holderEvidence<bigint>(h?.programHeldBps),
    walletHolderCount: holderEvidence<number>(h?.walletHolderCount),
    unclassifiedBps: holderEvidence<bigint>(h?.unclassifiedBps),
  };

  const chainReadAuthorities = chain.status === "verified";
  const authorities = {
    mintAuthorityRevoked: chainReadAuthorities
      ? verified<boolean>({ value: profile.authorities.mintAuthorityRevoked, ...chainAt })
      : unavailable<boolean>({
          value: null,
          source: chain.source,
          observedAt: chain.checkedAtMs,
          detail: chain.detail ?? "The mint account could not be read",
        }),
    freezeAuthorityRevoked: chainReadAuthorities
      ? verified<boolean>({ value: profile.authorities.freezeAuthorityRevoked, ...chainAt })
      : unavailable<boolean>({
          value: null,
          source: chain.source,
          observedAt: chain.checkedAtMs,
          detail: chain.detail ?? "The mint account could not be read",
        }),
    providerAgreement: derived<"agrees" | "disagrees" | "not_reported">({
      value: profile.authorities.providerAgreement,
      source: profile.authorities.source,
      observedAt: chain.checkedAtMs,
    }),
  };

  const execution: TokenEvidenceSnapshot["execution"] = options.quote
    ? {
        priceImpactBps: reported<bigint>({
          value: options.quote.priceImpactBps,
          source: options.quote.source,
          observedAt: options.quote.retrievedAtMs,
        }),
        routeVenues: reported<string[]>({
          value: options.quote.routePlan.map((hop) => hop.ammLabel),
          source: options.quote.source,
          observedAt: options.quote.retrievedAtMs,
        }),
        quotedOutAmount: reported<bigint>({
          value: options.quote.outAmount,
          source: options.quote.source,
          observedAt: options.quote.retrievedAtMs,
        }),
        minOutAmount: reported<bigint>({
          value: options.quote.minOutAmount,
          source: options.quote.source,
          observedAt: options.quote.retrievedAtMs,
        }),
        slippageBps: reported<bigint>({
          value: options.quote.slippageBps,
          source: options.quote.source,
          observedAt: options.quote.retrievedAtMs,
        }),
      }
    : null;

  const lifecycle = {
    mintCreatedAt: unavailable<number>({
      value: null,
      source: "unavailable:no-history-provider",
      observedAt: nowMs,
      detail: "True mint creation time needs indexed transaction history",
    }),
    firstPoolCreatedAt: unavailable<number>({
      value: null,
      source: "unavailable:not-published-per-token",
      observedAt: nowMs,
      detail: "First-pool time is published only in the discovery feed",
    }),
    firstProviderObservedAt: reported<number>({ value: profile.marketUpdatedAtMs, ...at }),
  };

  const freshness = {
    marketUpdatedAt: reported<number>({ value: profile.marketUpdatedAtMs, ...at }),
    marketAgeMs: derived<number>({
      value:
        profile.marketUpdatedAtMs === null ? null : Math.max(0, nowMs - profile.marketUpdatedAtMs),
      source: "moonpaper:clock",
      observedAt: nowMs,
    }),
  };

  const walletBehaviour = emptyWalletBehaviour(nowMs);
  const groups = {
    identity,
    market,
    momentum,
    liquidity,
    holders,
    authorities,
    walletBehaviour,
    lifecycle,
    freshness,
  } as unknown as Record<string, Record<string, Evidence<unknown>>>;

  return {
    ...finish(profile.mint, nowMs, groups, execution),
    identity,
    market,
    momentum,
    liquidity,
    holders,
    authorities,
    walletBehaviour,
    execution,
    lifecycle,
    freshness,
  };
}
