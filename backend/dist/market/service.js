import { ArbError } from "../core/errors.js";
/**
 * Aggregates the individual providers into per-token market views.
 * All consumers (scoring, paper engine, API) depend on this service and the
 * normalized types only — never on a concrete provider.
 */
export class MarketDataService {
    bundle;
    constructor(bundle) {
        this.bundle = bundle;
    }
    async listTokens() {
        return this.bundle.discovery.listTokens();
    }
    async getView(mint) {
        const tokens = await this.listTokens();
        const token = tokens.find((t) => t.mint === mint);
        if (!token) {
            throw new ArbError("TOKEN_NOT_ALLOWED", `Unsupported token mint: ${mint}`, 404);
        }
        try {
            const [momentum, liquidity, risk, solPriceMicroUsd] = await Promise.all([
                this.bundle.history.getMomentum(mint),
                this.bundle.liquidity.getLiquidity(mint),
                this.bundle.riskFacts.getRiskFacts(mint),
                this.bundle.routing.getSolPriceMicroUsd(),
            ]);
            return { token, momentum, liquidity, risk, solPriceMicroUsd };
        }
        catch (err) {
            throw toProviderError(err);
        }
    }
    async listViews() {
        const tokens = await this.listTokens();
        const views = await Promise.allSettled(tokens.map((t) => this.getView(t.mint)));
        // Partial provider outages degrade gracefully: failed tokens are dropped,
        // callers can compare lengths to detect the gap.
        return views
            .filter((v) => v.status === "fulfilled")
            .map((v) => v.value);
    }
    async getCandles(mint, points, stepMs) {
        await this.getView(mint); // validates mint
        try {
            return await this.bundle.history.getCandles(mint, points, stepMs);
        }
        catch (err) {
            throw toProviderError(err);
        }
    }
    async getBuyRoutes(mint, lamportsIn, slippageBps) {
        try {
            return await this.bundle.routing.getBuyRoutes(mint, lamportsIn, slippageBps);
        }
        catch (err) {
            throw toProviderError(err);
        }
    }
    async getSellRoutes(mint, tokenUnitsIn, slippageBps) {
        try {
            return await this.bundle.routing.getSellRoutes(mint, tokenUnitsIn, slippageBps);
        }
        catch (err) {
            throw toProviderError(err);
        }
    }
    async getSolPriceMicroUsd() {
        return this.bundle.routing.getSolPriceMicroUsd();
    }
}
function toProviderError(err) {
    if (err instanceof ArbError)
        return err;
    const code = err?.code;
    if (code === "UNSUPPORTED_TOKEN") {
        return new ArbError("TOKEN_NOT_ALLOWED", err.message, 404);
    }
    return new ArbError("PROVIDER_ERROR", "Market data provider failed", 502);
}
