import { ArbError } from "../core/errors.js";
import type {
  Candle,
  MarketDataBundle,
  RouteComparison,
  TokenInfo,
  TokenMarketView,
} from "./types.js";

/**
 * Aggregates the individual providers into per-token market views.
 * All consumers (scoring, paper engine, API) depend on this service and the
 * normalized types only — never on a concrete provider.
 */
export class MarketDataService {
  constructor(public readonly bundle: MarketDataBundle) {}

  async listTokens(): Promise<TokenInfo[]> {
    return this.bundle.discovery.listTokens();
  }

  async getView(mint: string): Promise<TokenMarketView> {
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
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async listViews(): Promise<TokenMarketView[]> {
    const tokens = await this.listTokens();
    const views = await Promise.allSettled(tokens.map((t) => this.getView(t.mint)));
    // Partial provider outages degrade gracefully: failed tokens are dropped,
    // callers can compare lengths to detect the gap.
    return views
      .filter((v): v is PromiseFulfilledResult<TokenMarketView> => v.status === "fulfilled")
      .map((v) => v.value);
  }

  async getCandles(mint: string, points: number, stepMs: number): Promise<Candle[]> {
    await this.getView(mint); // validates mint
    try {
      return await this.bundle.history.getCandles(mint, points, stepMs);
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async getBuyRoutes(mint: string, lamportsIn: bigint, slippageBps: bigint): Promise<RouteComparison> {
    try {
      return await this.bundle.routing.getBuyRoutes(mint, lamportsIn, slippageBps);
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async getSellRoutes(mint: string, tokenUnitsIn: bigint, slippageBps: bigint): Promise<RouteComparison> {
    try {
      return await this.bundle.routing.getSellRoutes(mint, tokenUnitsIn, slippageBps);
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async getSolPriceMicroUsd(): Promise<bigint> {
    return this.bundle.routing.getSolPriceMicroUsd();
  }
}

function toProviderError(err: unknown): ArbError {
  if (err instanceof ArbError) return err;
  const code = (err as { code?: string })?.code;
  if (code === "UNSUPPORTED_TOKEN") {
    return new ArbError("TOKEN_NOT_ALLOWED", (err as Error).message, 404);
  }
  return new ArbError("PROVIDER_ERROR", "Market data provider failed", 502);
}
