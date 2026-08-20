/**
 * Beyond this gap, a previous snapshot is not diffed against.
 *
 * Protects against the worker restarting after downtime. Without it, the first
 * pass back would compare "now" against a snapshot from hours ago, and every
 * watched token that had moved since would look like it moved *just now* —
 * producing a burst of alerts that are all technically true and all useless.
 * The snapshot is still refreshed; only the comparison is skipped.
 */
export const MAX_DIFF_AGE_MS = 15 * 60_000;
/**
 * Relative change in basis points, magnitude rounded away from zero.
 *
 * Rounding up matches the holder-concentration decision: these numbers drive
 * warnings, and a warning that understates itself is the worse failure. The
 * effect is at most one basis point either way.
 */
export function changeBps(from, to) {
    // A zero or missing baseline has no meaningful percentage change — every
    // move from zero is infinite, and reporting one would be an invention.
    if (from === null || to === null || from <= 0n)
        return null;
    const delta = to - from;
    const negative = delta < 0n;
    const magnitude = negative ? -delta : delta;
    const bps = (magnitude * 10000n + from - 1n) / from;
    return negative ? -bps : bps;
}
/** Reads the facts the worker persists out of a full research profile. */
export function snapshotFromProfile(profile, nowMs) {
    const holders = profile.verification.holders;
    return {
        mint: profile.mint,
        pricePicoUsd: profile.market.priceUsdPico,
        liquidityUsdMicro: profile.market.liquidityUsdMicro,
        volume24hUsdMicro: profile.market.buyVolume24hUsdMicro === null || profile.market.sellVolume24hUsdMicro === null
            ? null
            : profile.market.buyVolume24hUsdMicro + profile.market.sellVolume24hUsdMicro,
        // Only the on-chain measurement is stored. The provider's reported figure
        // counts pool vaults as holders, so mixing the two would produce a delta
        // between two different definitions rather than a real change.
        walletConcentrationBps: holders && holders.status !== "unavailable" && holders.concentrationBps !== undefined
            ? holders.concentrationBps
            : null,
        mintAuthorityRevoked: profile.authorities.mintAuthorityRevoked,
        freezeAuthorityRevoked: profile.authorities.freezeAuthorityRevoked,
        observedAtMs: nowMs,
    };
}
/**
 * Build the observation the engine evaluates.
 *
 * Absolute facts (concentration, authorities) come straight from the current
 * snapshot. Change fields require a usable previous snapshot; without one they
 * are null, which the engine treats as "do not evaluate" rather than "no".
 */
export function buildObservation(current, previous, symbol) {
    const intervalMs = previous === null ? null : current.observedAtMs - previous.observedAtMs;
    const comparable = previous !== null && intervalMs !== null && intervalMs > 0 && intervalMs <= MAX_DIFF_AGE_MS;
    return {
        mint: current.mint,
        symbol,
        intervalMs: comparable ? intervalMs : null,
        priceChangeBps: comparable ? changeBps(previous.pricePicoUsd, current.pricePicoUsd) : null,
        liquidityChangeBps: comparable
            ? changeBps(previous.liquidityUsdMicro, current.liquidityUsdMicro)
            : null,
        volumeChangeBps: comparable
            ? changeBps(previous.volume24hUsdMicro, current.volume24hUsdMicro)
            : null,
        holderConcentrationBps: current.walletConcentrationBps,
        mintAuthorityRevoked: current.mintAuthorityRevoked,
        freezeAuthorityRevoked: current.freezeAuthorityRevoked,
        // Not measured yet: proving a route exists costs a quote per token, which
        // is a per-pass expense the worker does not currently spend. Null keeps
        // the rule inert rather than letting it fire on an assumption.
        routeAvailable: null,
    };
}
