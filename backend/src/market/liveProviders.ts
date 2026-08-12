import { CachedLoader } from "./cache.js";
import { createDemoBundle } from "./demoProviders.js";
import type { MintReadResult } from "./solana/mint.js";
import { OnChainMintRiskProvider } from "./solana/riskProvider.js";
import { SolanaRpcClient, SOLANA_PUBLIC_MAINNET_RPC } from "./solana/rpc.js";
import type { MarketDataBundle } from "./types.js";

/**
 * Live market bundle.
 *
 * Hybrid by design: real on-chain data for the fields the chain can actually
 * prove, simulated data for everything else, with per-field labels so the UI
 * never blurs the two. Today that means mint and freeze authority are live;
 * momentum, liquidity, and routing remain simulated because they need an
 * indexer we have not integrated.
 *
 * `isDemo` stays true because most values are still simulated — the banner and
 * the paper-trading disclaimers must not soften.
 */

export interface LiveBundleOptions {
  rpcUrl?: string;
  /** Mint accounts change almost never; 10 minutes is comfortable. */
  mintCacheTtlMs?: number;
  /** Injected for offline integration tests; defaults to a real client. */
  client?: SolanaRpcClient;
}

export function createLiveBundle(
  clock: () => number = Date.now,
  options: LiveBundleOptions = {},
): MarketDataBundle {
  const demo = createDemoBundle(clock);

  const client =
    options.client ??
    new SolanaRpcClient({
      endpoint: options.rpcUrl ?? SOLANA_PUBLIC_MAINNET_RPC,
      commitment: "confirmed",
    });

  const loader = new CachedLoader<MintReadResult>({
    ttlMs: options.mintCacheTtlMs ?? 600_000,
    clock,
  });

  const riskFacts = new OnChainMintRiskProvider(
    demo.riskFacts,
    client,
    loader,
    async (mint) => (await demo.discovery.listTokens()).find((t) => t.mint === mint)?.decimals,
    clock,
  );

  return {
    ...demo,
    riskFacts,
    dataSourceLabel: "Live on-chain mint data (Solana mainnet) + simulated market data",
    isDemo: true,
  };
}
