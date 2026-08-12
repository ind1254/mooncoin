import { CachedLoader } from "./cache.js";
import { createDemoBundle } from "./demoProviders.js";
import { OnChainMintRiskProvider } from "./solana/riskProvider.js";
import { SolanaRpcClient, SOLANA_PUBLIC_MAINNET_RPC } from "./solana/rpc.js";
export function createLiveBundle(clock = Date.now, options = {}) {
    const demo = createDemoBundle(clock);
    const client = options.client ??
        new SolanaRpcClient({
            endpoint: options.rpcUrl ?? SOLANA_PUBLIC_MAINNET_RPC,
            commitment: "confirmed",
        });
    const loader = new CachedLoader({
        ttlMs: options.mintCacheTtlMs ?? 600_000,
        clock,
    });
    const riskFacts = new OnChainMintRiskProvider(demo.riskFacts, client, loader, async (mint) => (await demo.discovery.listTokens()).find((t) => t.mint === mint)?.decimals, clock);
    return {
        ...demo,
        riskFacts,
        dataSourceLabel: "Live on-chain mint data (Solana mainnet) + simulated market data",
        isDemo: true,
    };
}
