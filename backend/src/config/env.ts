import { z } from "zod";

/**
 * Environment validation — fail fast with a readable message instead of
 * surprising behavior later. No secrets are required to run demo mode.
 */

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /**
   * demo — fully deterministic seeded data (default).
   * live — hybrid: on-chain mint facts from Solana RPC, everything else still
   *        simulated and labelled per field.
   */
  MARKET_MODE: z.enum(["demo", "live"]).default("demo"),
  /** Solana JSON-RPC endpoint used in live mode. Read-only; no key required. */
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  /** How long a mint account stays cached. Mint data changes almost never. */
  MINT_CACHE_TTL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(600_000),
  /** Token discovery/search API. Public and keyless; override to self-host. */
  JUPITER_TOKENS_URL: z.string().url().default("https://lite-api.jup.ag/tokens/v2"),
  /** Legacy arbitrage endpoints: mock (offline) or jupiter (live quotes). */
  QUOTE_MODE: z.enum(["mock", "jupiter"]).default("mock"),
  /** Virtual starting balance for the paper portfolio, in SOL. */
  PAPER_STARTING_SOL: z.coerce.number().positive().max(100_000).default(100),
  /** Optional: enables the legacy admin allowlist endpoints when set. */
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Directory for local JSON state (paper positions, settings). */
  DATA_DIR: z.string().default("data"),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return result.data;
}
