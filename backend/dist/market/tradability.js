import { asArbError, ArbError } from "../core/errors.js";
import { decimalToBaseUnits } from "../core/money.js";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const gate = (id, label, status, blocking, detail, source) => ({ id, label, status, blocking, detail, source });
function marketFreshnessGate(profile, policy, nowMs) {
    const observedAt = profile.marketUpdatedAtMs;
    if (observedAt === null) {
        return gate("market_freshness", "Market data freshness", "unavailable", true, "The catalog did not provide an update timestamp, so freshness cannot be proven.", profile.marketSource);
    }
    const ageMs = Math.max(0, nowMs - observedAt);
    if (ageMs > policy.maxMarketAgeMs) {
        return gate("market_freshness", "Market data freshness", "fail", true, `Catalog market data is ${Math.round(ageMs / 1_000)}s old; policy allows ${Math.round(policy.maxMarketAgeMs / 1_000)}s.`, profile.marketSource);
    }
    return gate("market_freshness", "Market data freshness", "pass", true, `Catalog market data is ${Math.round(ageMs / 1_000)}s old.`, profile.marketSource);
}
function liquidityGate(profile, policy) {
    const liquidity = profile.market.liquidityUsdMicro;
    const minimum = policy.minLiquidityUsdMicro / 1000000n;
    if (liquidity === null) {
        return gate("minimum_liquidity", "Minimum liquidity", "unavailable", true, `Liquidity is not reported; policy requires at least $${minimum.toString()}.`, profile.marketSource);
    }
    const actual = liquidity / 1000000n;
    const passed = liquidity >= policy.minLiquidityUsdMicro;
    return gate("minimum_liquidity", "Minimum liquidity", passed ? "pass" : "fail", true, passed
        ? `$${actual.toString()} reported liquidity meets the $${minimum.toString()} minimum.`
        : `$${actual.toString()} reported liquidity is below the $${minimum.toString()} minimum.`, profile.marketSource);
}
function authorityGate(profile, kind) {
    const id = kind === "mint" ? "mint_authority" : "freeze_authority";
    const label = kind === "mint" ? "Mint authority" : "Freeze authority";
    if (profile.verification.status !== "verified") {
        return gate(id, label, "unavailable", true, `Direct Solana verification is ${profile.verification.status}; Moonpaper will not treat a provider claim as proof.`, profile.verification.source);
    }
    const revoked = kind === "mint" ? profile.authorities.mintAuthorityRevoked : profile.authorities.freezeAuthorityRevoked;
    return gate(id, label, revoked ? "pass" : "fail", true, revoked
        ? `${label} is revoked according to the mint account.`
        : `${label} is still active according to the mint account.`, profile.verification.source);
}
function quoteFailureGate(err) {
    const failure = asArbError(err);
    const expectedNoRoute = failure.code === "QUOTE_UNAVAILABLE";
    return gate("jupiter_route", "Jupiter route", expectedNoRoute ? "fail" : "unavailable", true, failure.message, "jupiter:quote-v1");
}
export class TradabilityService {
    research;
    quotes;
    policy;
    clock;
    constructor(research, quotes, policy, clock = Date.now) {
        this.research = research;
        this.quotes = quotes;
        this.policy = policy;
        this.clock = clock;
    }
    async check(mint, amountUsd, slippageBps, signal) {
        const [profile, inputToken] = await Promise.all([
            this.research.getProfile(mint, signal),
            this.research.resolveToken(USDC_MINT, signal),
        ]);
        if (!inputToken) {
            throw new ArbError("PROVIDER_ERROR", "The token catalog could not resolve canonical USDC", 503);
        }
        let amountBase;
        try {
            amountBase = decimalToBaseUnits(amountUsd, inputToken.decimals);
        }
        catch (err) {
            throw new ArbError("VALIDATION_ERROR", err.message, 400);
        }
        const [duplicateResult, quoteResult] = await Promise.allSettled([
            this.research.search(profile.symbol, signal),
            this.quotes.getQuote({
                inputMint: inputToken.mint,
                outputMint: profile.mint,
                amount: amountBase,
                slippageBps,
            }, signal),
        ]);
        const nowMs = this.clock();
        const gates = [
            marketFreshnessGate(profile, this.policy, nowMs),
            liquidityGate(profile, this.policy),
            authorityGate(profile, "mint"),
            authorityGate(profile, "freeze"),
        ];
        let duplicateMints = [];
        if (duplicateResult.status === "fulfilled") {
            duplicateMints = duplicateResult.value
                .filter((token) => token.symbol.toLowerCase() === profile.symbol.toLowerCase() && token.mint !== profile.mint)
                .map((token) => token.mint);
            gates.push(gate("duplicate_symbol", "Duplicate ticker", duplicateMints.length > 0 ? "warning" : "pass", false, duplicateMints.length > 0
                ? `${profile.symbol} is shared by ${duplicateMints.length + 1} catalog mints. The mint address remains the identity.`
                : `No other ${profile.symbol} mint appeared in the current search results.`, profile.identitySource));
        }
        else {
            gates.push(gate("duplicate_symbol", "Duplicate ticker", "unavailable", false, "Ticker duplication could not be checked; identify this token by mint address.", profile.identitySource));
        }
        let quote = null;
        if (quoteResult.status === "fulfilled") {
            quote = quoteResult.value;
            const routeFresh = nowMs < quote.expiresAtMs;
            const routePresent = quote.routePlan.length > 0;
            gates.push(gate("jupiter_route", "Jupiter route", routeFresh && routePresent ? "pass" : "fail", true, !routePresent
                ? "Jupiter returned no route legs for this size."
                : routeFresh
                    ? `A ${quote.routePlan.length}-leg route is available for this exact size.`
                    : "The quote expired before the check completed.", quote.source));
            const impactPassed = quote.priceImpactBps <= this.policy.maxPriceImpactBps;
            gates.push(gate("price_impact", "Price impact", impactPassed ? "pass" : "fail", true, impactPassed
                ? `${(Number(quote.priceImpactBps) / 100).toFixed(2)}% is within the ${(Number(this.policy.maxPriceImpactBps) / 100).toFixed(2)}% limit.`
                : `${(Number(quote.priceImpactBps) / 100).toFixed(2)}% exceeds the ${(Number(this.policy.maxPriceImpactBps) / 100).toFixed(2)}% limit.`, quote.source));
        }
        else {
            gates.push(quoteFailureGate(quoteResult.reason));
            gates.push(gate("price_impact", "Price impact", "unavailable", true, "Price impact cannot be evaluated without a live route.", "jupiter:quote-v1"));
        }
        const blocking = gates.filter((item) => item.blocking && item.status !== "pass");
        const eligible = blocking.length === 0;
        const tradable = gates.find((item) => item.id === "jupiter_route")?.status === "pass";
        const verdict = eligible
            ? "eligible"
            : blocking.some((item) => item.status === "fail")
                ? "blocked"
                : "needs_verification";
        return {
            mint: profile.mint,
            symbol: profile.symbol,
            name: profile.name,
            checkedAtMs: nowMs,
            amountUsd,
            slippageBps,
            eligible,
            tradable,
            verdict,
            summary: eligible
                ? "All blocking production gates passed for this exact quote size."
                : verdict === "blocked"
                    ? `${blocking.length} blocking production gate${blocking.length === 1 ? "" : "s"} did not pass.`
                    : "No hard failure was found, but required evidence is unavailable.",
            policy: this.policy,
            gates,
            blockingGateIds: blocking.map((item) => item.id),
            duplicateMints,
            profile,
            inputToken,
            quote,
        };
    }
}
