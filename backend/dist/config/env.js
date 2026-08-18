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
    /** Read-only swap quotes. Only /quote is ever called, never /swap. */
    JUPITER_QUOTE_URL: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
    /** Optional production Developer Platform credential. Never exposed to the client. */
    JUPITER_API_KEY: z.string().min(1).optional(),
    /** Server-side production gate: minimum reported market liquidity. */
    TRADABILITY_MIN_LIQUIDITY_USD: z.coerce.number().int().min(0).max(1_000_000_000).default(10_000),
    /** Maximum permitted impact for the requested one-way quote. */
    TRADABILITY_MAX_PRICE_IMPACT_BPS: z.coerce.number().int().min(1).max(5_000).default(300),
    /** Reject token market records older than this provider timestamp. */
    TRADABILITY_MAX_MARKET_AGE_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(300_000),
    /** Legacy arbitrage endpoints: mock (offline) or jupiter (live quotes). */
    QUOTE_MODE: z.enum(["mock", "jupiter"]).default("mock"),
    /** Virtual starting balance for the paper portfolio, in SOL. */
    PAPER_STARTING_SOL: z.coerce.number().positive().max(100_000).default(100),
    /** Optional: enables the legacy admin allowlist endpoints when set. */
    ADMIN_TOKEN: z.string().min(16).optional(),
    /** Directory for local JSON state (legacy simulator + settings). */
    DATA_DIR: z.string().default("data"),
    /**
     * Postgres connection string. SECRET. When absent the app still runs, but
     * accounts, portfolios and watchlists are disabled — public research and
     * quotes keep working.
     */
    DATABASE_URL: z.string().min(1).optional(),
    /** Starting paper capital for a new account, in whole USD. */
    PAPER_STARTING_USD: z.coerce.number().positive().max(100_000_000).default(100_000),
    /** Smallest live-quote paper entry accepted by the server. */
    PAPER_MIN_TRADE_USD: z.coerce.number().int().min(1).max(1_000_000).default(10),
    /** Largest single live-quote paper entry accepted by the server. */
    PAPER_MAX_TRADE_USD: z.coerce.number().int().min(1).max(100_000_000).default(10_000),
    /** Bound quote fan-out and accidental position spam per account. */
    PAPER_MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).max(100).default(25),
    /** Durable per-email authentication attempt budget. */
    AUTH_RATE_LIMIT_ATTEMPTS: z.coerce.number().int().min(1).max(1_000).default(10),
    /** Fixed authentication rate-limit window. */
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(900_000),
    /** Broader per-network authentication budget to bound identifier spraying. */
    AUTH_RATE_LIMIT_NETWORK_ATTEMPTS: z.coerce.number().int().min(1).max(100_000).default(60),
    /** Durable per-account paper-write budget. */
    PAPER_RATE_LIMIT_ATTEMPTS: z.coerce.number().int().min(1).max(10_000).default(30),
    /** Fixed paper-write rate-limit window. */
    PAPER_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    /** How long a signed-in session lasts. */
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /**
     * Send Secure cookies. Must be true in production (HTTPS); false for plain
     * HTTP local development, where the browser would otherwise drop the cookie.
     */
    COOKIE_SECURE: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v === "true"),
});
export function loadEnv(source = process.env) {
    const result = envSchema.safeParse(source);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new Error(`Invalid environment configuration — ${issues}`);
    }
    return result.data;
}
