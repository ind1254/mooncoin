import { z } from "zod";

/**
 * Environment validation — fail fast with a readable message instead of
 * surprising behavior later. No secrets are required to run demo mode.
 */

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** demo (default, deterministic seeded data) — live providers are a future phase. */
  MARKET_MODE: z.enum(["demo"]).default("demo"),
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
