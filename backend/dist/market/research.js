import { ArbError } from "../core/errors.js";
import { CachedLoader } from "./cache.js";
import { readMintAccount } from "./solana/mint.js";
import { SOLANA_MAINNET_SOURCE } from "./solana/riskProvider.js";
const RISK_BANDS = { lowBelow: 30, mediumBelow: 60 };
const bpsToPct = (bps) => Number(bps) / 100;
const microToUsd = (v) => Number(v / 1000000n);
/**
 * Transparent additive risk model over whatever facts are actually available.
 *
 * Deliberately NOT a copy of the demo scorer: that one requires a full
 * simulated market view. Unifying the two is the contextual-scoring work and
 * is intentionally out of scope here. Points are stated per factor so the UI
 * can show exactly what produced the number.
 */
function assessRisk(token, mint) {
    const factors = [];
    const add = (f) => factors.push(f);
    // --- Authorities: verified on-chain where possible ---
    if (mint && mint.status === "found") {
        if (mint.mint.mintAuthorityPresent) {
            add({
                id: "mint-authority-active",
                label: "Mint authority",
                fact: "An address still holds permission to mint additional supply.",
                interpretation: "Supply can be increased by that address, diluting holders. This is normal for stablecoins and managed tokens, and a larger concern for an anonymous token.",
                direction: "negative",
                status: "verified",
                source: SOLANA_MAINNET_SOURCE,
                points: 25,
            });
        }
        else {
            add({
                id: "mint-authority-revoked",
                label: "Mint authority",
                fact: "No address can mint additional supply through the original mint authority.",
                interpretation: "Supply cannot be inflated this way.",
                direction: "positive",
                status: "verified",
                source: SOLANA_MAINNET_SOURCE,
                points: 0,
            });
        }
        if (mint.mint.freezeAuthorityPresent) {
            add({
                id: "freeze-authority-active",
                label: "Freeze authority",
                fact: "An authority can still freeze token accounts.",
                interpretation: "Holders could be blocked from transferring this token.",
                direction: "negative",
                status: "verified",
                source: SOLANA_MAINNET_SOURCE,
                points: 12,
            });
        }
        else {
            add({
                id: "freeze-authority-revoked",
                label: "Freeze authority",
                fact: "Token accounts can no longer be frozen by the original freeze authority.",
                interpretation: "Transfers cannot be blocked this way.",
                direction: "positive",
                status: "verified",
                source: SOLANA_MAINNET_SOURCE,
                points: 0,
            });
        }
    }
    else {
        add({
            id: "authorities-unverified",
            label: "Mint and freeze authority",
            fact: "On-chain authority settings could not be read.",
            interpretation: "Unknown settings are treated as risk rather than assumed safe.",
            direction: "negative",
            status: "unavailable",
            source: SOLANA_MAINNET_SOURCE,
            points: 12,
        });
    }
    // --- Holder concentration: reported by the discovery provider ---
    const top = token.market.topHolderPctBps;
    if (top !== null) {
        const pct = bpsToPct(top);
        const points = pct >= 50 ? 25 : pct >= 30 ? 12 : 0;
        add({
            id: "holder-concentration",
            label: "Holder concentration",
            fact: `The largest holders control about ${pct.toFixed(1)}% of supply.`,
            interpretation: points >= 25
                ? "A small group could move the price substantially by selling."
                : points > 0
                    ? "Concentration is elevated; large holders could move the price."
                    : "Supply is reasonably distributed.",
            direction: points > 0 ? "negative" : "positive",
            status: "reported",
            source: token.source,
            points,
        });
    }
    else {
        add({
            id: "holder-concentration-unavailable",
            label: "Holder concentration",
            fact: "Holder distribution was not reported for this token.",
            interpretation: "Cannot assess whether a few wallets dominate supply.",
            direction: "neutral",
            status: "unavailable",
            source: token.source,
            points: 5,
        });
    }
    // --- Liquidity depth ---
    const liq = token.market.liquidityUsdMicro;
    if (liq !== null) {
        const usd = microToUsd(liq);
        const points = usd < 50_000 ? 25 : usd < 250_000 ? 15 : usd < 1_000_000 ? 8 : 0;
        add({
            id: "liquidity-depth",
            label: "Liquidity",
            fact: `About $${usd.toLocaleString()} of liquidity is available to trade against.`,
            interpretation: points >= 25
                ? "Very thin. Even a small trade would move the price sharply, and exiting may be difficult."
                : points > 0
                    ? "Moderate. Larger trades would move the price noticeably."
                    : "Deep enough to absorb ordinary trade sizes.",
            direction: points > 0 ? "negative" : "positive",
            status: "reported",
            source: token.source,
            points,
        });
    }
    else {
        add({
            id: "liquidity-unavailable",
            label: "Liquidity",
            fact: "Liquidity was not reported for this token.",
            interpretation: "Execution cost cannot be estimated.",
            direction: "neutral",
            status: "unavailable",
            source: token.source,
            points: 8,
        });
    }
    // --- Provider allowlist status ---
    if (!token.verifiedByProvider) {
        add({
            id: "not-provider-verified",
            label: "Token list status",
            fact: "This token is not on the discovery provider's verified list.",
            interpretation: "Unlisted tokens receive less scrutiny and are more often short-lived.",
            direction: "negative",
            status: "reported",
            source: token.source,
            points: 8,
        });
    }
    else {
        add({
            id: "provider-verified",
            label: "Token list status",
            fact: "This token appears on the discovery provider's verified list.",
            interpretation: "It has passed that provider's listing checks. Not a guarantee of quality.",
            direction: "positive",
            status: "reported",
            source: token.source,
            points: 0,
        });
    }
    // --- Trading pressure ---
    const buys = token.market.buyVolume24hUsdMicro;
    const sells = token.market.sellVolume24hUsdMicro;
    if (buys !== null && sells !== null && buys > 0n) {
        const heavySelling = sells > buys * 2n;
        add({
            id: "trade-pressure",
            label: "24h trading pressure",
            fact: `$${microToUsd(buys).toLocaleString()} bought versus $${microToUsd(sells).toLocaleString()} sold in the last 24 hours.`,
            interpretation: heavySelling
                ? "Selling substantially outweighs buying over this window."
                : "Buying and selling are broadly balanced over this window.",
            direction: heavySelling ? "negative" : "neutral",
            status: "reported",
            source: token.source,
            points: heavySelling ? 5 : 0,
        });
    }
    // --- Token age: honestly unavailable ---
    add({
        id: "token-age-unavailable",
        label: "Token age",
        fact: "The true mint creation date is not available from current providers.",
        interpretation: "Age is a useful risk signal, but the discovery provider reports when it first indexed the token, not when the mint was created, so it is not used here.",
        direction: "neutral",
        status: "unavailable",
        source: "none",
        points: 0,
    });
    const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
    const level = score < RISK_BANDS.lowBelow ? "low" : score < RISK_BANDS.mediumBelow ? "medium" : "high";
    return {
        score,
        level,
        factors,
        method: "Additive model over independently sourced facts. On-chain authority settings are verified directly; market facts are reported by the discovery provider; unavailable inputs add a small penalty rather than being assumed safe.",
    };
}
export class ResearchService {
    discovery;
    rpc;
    clock;
    loader;
    simulationAvailable;
    constructor(discovery, rpc, options = {}) {
        this.discovery = discovery;
        this.rpc = rpc;
        this.clock = options.clock ?? Date.now;
        this.simulationAvailable = options.simulationAvailable ?? (async () => false);
        this.loader = new CachedLoader({
            ttlMs: options.mintCacheTtlMs ?? 600_000,
            clock: this.clock,
        });
    }
    get searchSource() {
        return this.discovery.source;
    }
    /** Canonical token identity, used to resolve decimals before quoting. */
    async resolveToken(mint, signal) {
        return this.discovery.getByMint(mint, signal);
    }
    async search(query, signal) {
        return this.discovery.search(query, signal);
    }
    async getProfile(mint, signal) {
        const token = await this.discovery.getByMint(mint, signal);
        if (!token) {
            throw new ArbError("TOKEN_NOT_ALLOWED", "No token found for that mint address", 404);
        }
        const requestedAtMs = this.clock();
        let mintRead = null;
        let verification;
        try {
            const cached = await this.loader.load(mint, () => readMintAccount(this.rpc, mint, signal));
            mintRead = cached.value;
            // Report when the RPC read actually happened, not when a cached value was
            // requested again. Production gates must never make cached evidence look
            // newer than it is.
            verification = describeVerification(mintRead, cached.fetchedAtMs, token.decimals);
        }
        catch (err) {
            verification = {
                status: "unavailable",
                source: SOLANA_MAINNET_SOURCE,
                checkedAtMs: requestedAtMs,
                detail: err instanceof ArbError && err.code === "PROVIDER_RATE_LIMITED"
                    ? "Solana RPC rate limit reached; on-chain settings could not be read."
                    : "Solana RPC could not be reached; on-chain settings could not be read.",
            };
        }
        const verified = mintRead?.status === "found" ? mintRead.mint : null;
        const claim = token.providerClaims.mintAuthorityDisabled;
        const agreement = claim === null || verified === null
            ? "not_reported"
            : claim === !verified.mintAuthorityPresent
                ? "agrees"
                : "disagrees";
        const simAvailable = await this.simulationAvailable(mint);
        return {
            mint: token.mint,
            symbol: token.symbol,
            name: token.name,
            // Prefer the chain's decimals when we have them.
            decimals: verified?.decimals ?? token.decimals,
            tokenProgram: token.tokenProgram,
            iconUrl: token.iconUrl,
            tags: token.tags,
            verifiedByProvider: token.verifiedByProvider,
            identitySource: token.source,
            marketSource: token.source,
            marketUpdatedAtMs: token.marketUpdatedAtMs ?? null,
            market: token.market,
            verification,
            authorities: {
                mintAuthorityRevoked: verified ? !verified.mintAuthorityPresent : null,
                freezeAuthorityRevoked: verified ? !verified.freezeAuthorityPresent : null,
                source: verified ? SOLANA_MAINNET_SOURCE : token.source,
                providerAgreement: agreement,
            },
            risk: assessRisk(token, mintRead),
            simulation: {
                available: simAvailable,
                reason: simAvailable
                    ? "Executable quotes are available for this token."
                    : "Paper trading needs an executable quote, and no live quote provider is wired up for arbitrary tokens yet.",
            },
            fetchedAtMs: requestedAtMs,
        };
    }
}
function describeVerification(result, checkedAtMs, declaredDecimals) {
    const base = { source: SOLANA_MAINNET_SOURCE, checkedAtMs };
    switch (result.status) {
        case "found":
            return {
                ...base,
                status: "verified",
                decimalsOnChain: result.mint.decimals,
                decimalsMismatch: result.mint.decimals !== declaredDecimals,
            };
        case "not_found":
            return { ...base, status: "not_found", detail: "No account exists at this mint address on Solana mainnet." };
        case "unsupported_program":
            return { ...base, status: "unsupported_program", detail: result.reason };
        case "malformed":
            return { ...base, status: "malformed", detail: result.reason };
    }
}
