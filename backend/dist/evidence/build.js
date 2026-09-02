import { collectSources, collectUnavailable, derived, reported, unavailable, verified, withFreshness, } from "./types.js";
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
function emptyWalletBehaviour(observedAt) {
    const absent = () => unavailable({ value: null, source: NO_WALLET_PROVIDER, observedAt, detail: WALLET_DETAIL });
    return {
        developerWalletPct: absent(),
        insiderPct: absent(),
        bundlerPct: absent(),
        sniperPct: absent(),
        smartTraderPct: absent(),
    };
}
/** Liquidity as a share of market cap, bps. Depth relative to size. */
function depthBps(liquidityUsdMicro, marketCapUsdMicro) {
    if (liquidityUsdMicro === null || marketCapUsdMicro === null || marketCapUsdMicro <= 0n) {
        return null;
    }
    return (liquidityUsdMicro * 10000n) / marketCapUsdMicro;
}
function finish(mint, observedAt, groups, execution) {
    const withExecution = execution
        ? { ...groups, execution: execution }
        : groups;
    return {
        mint,
        observedAt,
        unavailableEvidence: collectUnavailable(withExecution),
        sources: collectSources(withExecution),
    };
}
/**
 * Build a snapshot from one discovery-feed row.
 *
 * Everything here is `reported`: the feed is a provider's view of the market.
 * The provider's authority claims are deliberately NOT promoted to `verified`
 * — only a chain read earns that, and conflating the two is exactly the
 * mistake the research module exists to prevent.
 */
export function snapshotFromFeedToken(item, nowMs, options = {}) {
    const t = item.token;
    const m = t.market;
    const source = t.source ?? "jupiter:tokens-v2";
    const observedAt = item.updatedAtMs ?? nowMs;
    const at = { source, observedAt };
    const maxAgeMs = options.maxMarketAgeMs ?? 60_000;
    const fresh = (value, detail) => withFreshness(reported({ value, ...at, ...(detail ? { detail } : {}) }), nowMs, maxAgeMs);
    const identity = {
        symbol: reported({ value: t.symbol, ...at }),
        name: reported({ value: t.name, ...at }),
        decimals: reported({ value: t.decimals, ...at }),
        tokenProgram: reported({ value: t.tokenProgram, ...at }),
        verifiedByProvider: reported({ value: t.verifiedByProvider, ...at }),
        duplicateSymbolCount: derived({
            value: options.duplicateSymbolCount ?? null,
            source: "moonpaper:feed-symbol-count",
            observedAt: nowMs,
            ...(options.duplicateSymbolCount === undefined
                ? { detail: "Ticker ambiguity was not measured for this row" }
                : {}),
        }),
    };
    const market = {
        priceUsdPico: fresh(m.priceUsdPico),
        marketCapUsdMicro: fresh(m.marketCapUsdMicro),
        fdvUsdMicro: fresh(m.fdvUsdMicro),
        holderCount: fresh(m.holderCount),
    };
    const momentum = {
        priceChange5mBps: fresh(item.fiveMinutes.priceChangeBps),
        priceChange1hBps: fresh(m.change1hBps),
        priceChange24hBps: fresh(m.change24hBps),
        volume5mUsdMicro: fresh(item.fiveMinutes.buyVolumeUsdMicro === null && item.fiveMinutes.sellVolumeUsdMicro === null
            ? null
            : (item.fiveMinutes.buyVolumeUsdMicro ?? 0n) + (item.fiveMinutes.sellVolumeUsdMicro ?? 0n)),
        volume24hUsdMicro: fresh(m.buyVolume24hUsdMicro === null && m.sellVolume24hUsdMicro === null
            ? null
            : (m.buyVolume24hUsdMicro ?? 0n) + (m.sellVolume24hUsdMicro ?? 0n)),
        traders5m: fresh(item.fiveMinutes.traders),
    };
    const liquidity = {
        liquidityUsdMicro: fresh(m.liquidityUsdMicro),
        depthBps: derived({
            value: depthBps(m.liquidityUsdMicro, m.marketCapUsdMicro),
            source: "moonpaper:depth-ratio",
            observedAt,
            detail: "Liquidity as a share of market cap",
        }),
        liquidityChange1hBps: fresh(item.oneHour.liquidityChangeBps),
    };
    // The feed reports a top-holder share but cannot say whether those holders
    // are people or pools. Recorded as reported, and NOT presented as the
    // pool-excluding figure the chain read produces.
    const holders = {
        topWalletConcentrationBps: reported({
            value: m.topHolderPctBps,
            ...at,
            detail: "Provider figure; pools and bonding curves are not excluded",
        }),
        programHeldBps: unavailable({
            value: null,
            source: "unavailable:requires-chain-read",
            observedAt: nowMs,
            detail: "Separating pool-held supply needs an on-chain holder read",
        }),
        walletHolderCount: unavailable({
            value: null,
            source: "unavailable:requires-chain-read",
            observedAt: nowMs,
            detail: "Wallet-versus-program classification needs an on-chain read",
        }),
        unclassifiedBps: unavailable({
            value: null,
            source: "unavailable:requires-chain-read",
            observedAt: nowMs,
            detail: "Not measurable without on-chain holder classification",
        }),
    };
    const claims = t.providerClaims ?? {};
    const authorities = {
        mintAuthorityRevoked: reported({
            value: claims.mintAuthorityDisabled ?? null,
            ...at,
            detail: "Provider claim; not confirmed against the chain",
        }),
        freezeAuthorityRevoked: reported({
            value: claims.freezeAuthorityDisabled ?? null,
            ...at,
            detail: "Provider claim; not confirmed against the chain",
        }),
        providerAgreement: unavailable({
            value: null,
            source: "unavailable:requires-chain-read",
            observedAt: nowMs,
            detail: "Agreement can only be judged against an on-chain read",
        }),
    };
    // The feed's pool timestamp is a first-pool sighting. It is NOT the mint's
    // creation time, and is never reported as one.
    const lifecycle = {
        mintCreatedAt: unavailable({
            value: null,
            source: "unavailable:no-history-provider",
            observedAt: nowMs,
            detail: "True mint creation time needs indexed transaction history",
        }),
        firstPoolCreatedAt: reported({ value: item.firstPoolAtMs, ...at }),
        firstProviderObservedAt: reported({ value: item.updatedAtMs, ...at }),
    };
    const freshness = {
        marketUpdatedAt: reported({ value: item.updatedAtMs, ...at }),
        marketAgeMs: derived({
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
    };
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
export function snapshotFromResearch(profile, nowMs, options = {}) {
    const m = profile.market;
    const at = { source: profile.marketSource, observedAt: profile.marketUpdatedAtMs ?? profile.fetchedAtMs };
    const idAt = { source: profile.identitySource, observedAt: profile.fetchedAtMs };
    const maxAgeMs = options.maxMarketAgeMs ?? 60_000;
    const chain = profile.verification;
    const chainAt = { source: chain.source, observedAt: chain.checkedAtMs };
    const fresh = (value) => withFreshness(reported({ value, ...at }), nowMs, maxAgeMs);
    const identity = {
        symbol: reported({ value: profile.symbol, ...idAt }),
        name: reported({ value: profile.name, ...idAt }),
        // On-chain decimals outrank the catalog's when both exist.
        decimals: chain.decimalsOnChain !== undefined
            ? verified({
                value: chain.decimalsOnChain,
                ...chainAt,
                ...(chain.decimalsMismatch ? { detail: "On-chain decimals disagree with the catalog" } : {}),
            })
            : reported({ value: profile.decimals, ...idAt }),
        tokenProgram: reported({ value: profile.tokenProgram, ...idAt }),
        verifiedByProvider: reported({ value: profile.verifiedByProvider, ...idAt }),
        duplicateSymbolCount: derived({
            value: options.duplicateSymbolCount ?? null,
            source: "moonpaper:symbol-count",
            observedAt: nowMs,
            ...(options.duplicateSymbolCount === undefined
                ? { detail: "Ticker ambiguity was not measured" }
                : {}),
        }),
    };
    const market = {
        priceUsdPico: fresh(m.priceUsdPico),
        marketCapUsdMicro: fresh(m.marketCapUsdMicro),
        fdvUsdMicro: fresh(m.fdvUsdMicro),
        holderCount: fresh(m.holderCount),
    };
    const momentum = {
        priceChange5mBps: unavailable({
            value: null,
            source: "unavailable:not-published-per-token",
            observedAt: nowMs,
            detail: "The provider publishes 5m windows only for trending tokens",
        }),
        priceChange1hBps: fresh(m.change1hBps),
        priceChange24hBps: fresh(m.change24hBps),
        volume5mUsdMicro: unavailable({
            value: null,
            source: "unavailable:not-published-per-token",
            observedAt: nowMs,
            detail: "The provider publishes 5m windows only for trending tokens",
        }),
        volume24hUsdMicro: fresh(m.buyVolume24hUsdMicro === null && m.sellVolume24hUsdMicro === null
            ? null
            : (m.buyVolume24hUsdMicro ?? 0n) + (m.sellVolume24hUsdMicro ?? 0n)),
        traders5m: unavailable({
            value: null,
            source: "unavailable:not-published-per-token",
            observedAt: nowMs,
            detail: "The provider publishes 5m windows only for trending tokens",
        }),
    };
    const liquidity = {
        liquidityUsdMicro: fresh(m.liquidityUsdMicro),
        depthBps: derived({
            value: depthBps(m.liquidityUsdMicro, m.marketCapUsdMicro),
            source: "moonpaper:depth-ratio",
            observedAt: at.observedAt,
        }),
        liquidityChange1hBps: unavailable({
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
    const holderEvidence = (value) => holderVerified && value !== undefined && value !== null
        ? verified({ value, ...chainAt, ...(h?.status === "incomplete" ? { detail: h.detail } : {}) })
        : unavailable({
            value: null,
            source: chain.source,
            observedAt: chain.checkedAtMs,
            detail: h?.detail ?? "On-chain holder classification was not available",
        });
    const holders = {
        topWalletConcentrationBps: holderEvidence(h?.concentrationBps),
        programHeldBps: holderEvidence(h?.programHeldBps),
        walletHolderCount: holderEvidence(h?.walletHolderCount),
        unclassifiedBps: holderEvidence(h?.unclassifiedBps),
    };
    const chainReadAuthorities = chain.status === "verified";
    const authorities = {
        mintAuthorityRevoked: chainReadAuthorities
            ? verified({ value: profile.authorities.mintAuthorityRevoked, ...chainAt })
            : unavailable({
                value: null,
                source: chain.source,
                observedAt: chain.checkedAtMs,
                detail: chain.detail ?? "The mint account could not be read",
            }),
        freezeAuthorityRevoked: chainReadAuthorities
            ? verified({ value: profile.authorities.freezeAuthorityRevoked, ...chainAt })
            : unavailable({
                value: null,
                source: chain.source,
                observedAt: chain.checkedAtMs,
                detail: chain.detail ?? "The mint account could not be read",
            }),
        providerAgreement: derived({
            value: profile.authorities.providerAgreement,
            source: profile.authorities.source,
            observedAt: chain.checkedAtMs,
        }),
    };
    const execution = options.quote
        ? {
            priceImpactBps: reported({
                value: options.quote.priceImpactBps,
                source: options.quote.source,
                observedAt: options.quote.retrievedAtMs,
            }),
            routeVenues: reported({
                value: options.quote.routePlan.map((hop) => hop.ammLabel),
                source: options.quote.source,
                observedAt: options.quote.retrievedAtMs,
            }),
            quotedOutAmount: reported({
                value: options.quote.outAmount,
                source: options.quote.source,
                observedAt: options.quote.retrievedAtMs,
            }),
            minOutAmount: reported({
                value: options.quote.minOutAmount,
                source: options.quote.source,
                observedAt: options.quote.retrievedAtMs,
            }),
            slippageBps: reported({
                value: options.quote.slippageBps,
                source: options.quote.source,
                observedAt: options.quote.retrievedAtMs,
            }),
        }
        : null;
    const lifecycle = {
        mintCreatedAt: unavailable({
            value: null,
            source: "unavailable:no-history-provider",
            observedAt: nowMs,
            detail: "True mint creation time needs indexed transaction history",
        }),
        firstPoolCreatedAt: unavailable({
            value: null,
            source: "unavailable:not-published-per-token",
            observedAt: nowMs,
            detail: "First-pool time is published only in the discovery feed",
        }),
        firstProviderObservedAt: reported({ value: profile.marketUpdatedAtMs, ...at }),
    };
    const freshness = {
        marketUpdatedAt: reported({ value: profile.marketUpdatedAtMs, ...at }),
        marketAgeMs: derived({
            value: profile.marketUpdatedAtMs === null ? null : Math.max(0, nowMs - profile.marketUpdatedAtMs),
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
    };
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
