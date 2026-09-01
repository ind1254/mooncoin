import { z } from "zod";
import { ArbError } from "../../core/errors.js";
import { CachedLoader } from "../cache.js";
import { isPlausibleAddress } from "../solana/rpc.js";
import { priceImpactFractionToBpsCeil } from "./units.js";

/**
 * Read-only swap quotes from Jupiter.
 *
 * This module asks "what would this swap return right now?" and nothing else.
 * It calls the quote endpoint only. It never calls /swap, never builds a
 * transaction, never requests a signature, and never broadcasts anything.
 *
 * Deliberate difference from the rest of Moonpaper: there is NO fallback here.
 * Elsewhere a provider failure degrades to a labelled simulated value, which
 * is fine for descriptive data. A quote drives a hypothetical fill price, so a
 * fabricated one presented as current would make the whole simulation a lie.
 * If Jupiter cannot answer, the quote is unavailable and the user is told.
 */

export { priceImpactFractionToBpsCeil } from "./units.js";

export const JUPITER_QUOTE_SOURCE = "jupiter:quote-v1";
export const DEFAULT_JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1";

/** One leg of an aggregated route. Jupiter may split across several venues. */
export interface SwapRouteHop {
  ammLabel: string;
  ammKey: string;
  inputMint: string;
  outputMint: string;
  percent: number;
}

export interface NormalizedSwapQuote {
  inputMint: string;
  outputMint: string;
  /** Base units of the input mint. */
  inAmount: bigint;
  /** Base units of the output mint, as quoted. */
  outAmount: bigint;
  /** Worst acceptable output once slippage tolerance is applied. */
  minOutAmount: bigint;
  slippageBps: bigint;
  priceImpactBps: bigint;
  routePlan: SwapRouteHop[];
  /** USD notional of the swap as reported by the provider, micro-USD. */
  swapUsdValueMicro: bigint | null;
  contextSlot: number | null;
  swapMode: string;
  retrievedAtMs: number;
  /**
   * Moonpaper's freshness policy, NOT something Jupiter returns. Recorded so a
   * later execution step can reject a quote that has gone stale.
   */
  expiresAtMs: number;
  source: string;
}

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  /** Base units of the input mint. */
  amount: bigint;
  slippageBps: bigint;
}

/** The application depends on this, never on Jupiter's response shape. */
export interface QuoteProvider {
  readonly source: string;
  getQuote(req: QuoteRequest, signal?: AbortSignal): Promise<NormalizedSwapQuote>;
}

/** "7.5756902772" USD -> micro-USD, parsed as text to avoid float drift. */
function usdStringToMicro(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const frac = ((match[2] ?? "") + "000000").slice(0, 6);
  return BigInt(match[1] ?? "0") * 1_000_000n + BigInt(frac);
}

const routePlanSchema = z.array(
  z.object({
    swapInfo: z.object({
      ammKey: z.string(),
      label: z.string().optional(),
      inputMint: z.string(),
      outputMint: z.string(),
    }),
    percent: z.number().optional(),
  }),
);

const quoteSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string().regex(/^\d+$/),
    outAmount: z.string().regex(/^\d+$/),
    otherAmountThreshold: z.string().regex(/^\d+$/),
    swapMode: z.string(),
    slippageBps: z.number(),
    priceImpactPct: z.string(),
    routePlan: routePlanSchema,
    contextSlot: z.number().optional(),
    swapUsdValue: z.string().optional(),
  })
  .passthrough();

export interface JupiterQuoteOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** How long a quote may be reused. Kept very short: quotes move constantly. */
  cacheTtlMs?: number;
  /** How long a quote stays valid for a hypothetical fill. */
  quoteTtlMs?: number;
  clock?: () => number;
  fetchImpl?: typeof fetch;
}

export class JupiterQuoteProvider implements QuoteProvider {
  readonly source = JUPITER_QUOTE_SOURCE;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly quoteTtlMs: number;
  private readonly apiKey: string | undefined;
  private readonly clock: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly loader: CachedLoader<NormalizedSwapQuote>;

  constructor(options: JupiterQuoteOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_JUPITER_QUOTE_URL;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.quoteTtlMs = options.quoteTtlMs ?? 20_000;
    this.apiKey = options.apiKey;
    this.clock = options.clock ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.loader = new CachedLoader<NormalizedSwapQuote>({
      // Short on purpose: long enough to absorb a double-click, short enough
      // that a displayed quote is never meaningfully out of date.
      ttlMs: options.cacheTtlMs ?? 5_000,
      failureTtlMs: 3_000,
      rateLimitTtlMs: 20_000,
      maxEntries: 200,
      clock: this.clock,
    });
  }

  get cacheStats() {
    return this.loader.stats;
  }

  async getQuote(req: QuoteRequest, signal?: AbortSignal): Promise<NormalizedSwapQuote> {
    if (!isPlausibleAddress(req.inputMint) || !isPlausibleAddress(req.outputMint)) {
      throw new ArbError("VALIDATION_ERROR", "Both mints must be valid Solana addresses", 400);
    }
    if (req.inputMint === req.outputMint) {
      throw new ArbError("VALIDATION_ERROR", "Input and output tokens must differ", 400);
    }
    if (req.amount <= 0n) {
      throw new ArbError("VALIDATION_ERROR", "Quote amount must be greater than zero", 400);
    }
    if (req.slippageBps < 1n || req.slippageBps > 5_000n) {
      throw new ArbError("VALIDATION_ERROR", "Slippage must be between 0.01% and 50%", 400);
    }

    const key = `${req.inputMint}:${req.outputMint}:${req.amount}:${req.slippageBps}`;
    const cached = await this.loader.load(key, () => this.fetchQuote(req, signal));
    return cached.value;
  }

  private async fetchQuote(req: QuoteRequest, signal?: AbortSignal): Promise<NormalizedSwapQuote> {
    const params = new URLSearchParams({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amount.toString(),
      slippageBps: req.slippageBps.toString(),
      swapMode: "ExactIn",
    });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/quote?${params}`, {
        signal: combined,
        headers: { accept: "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) },
      });
    } catch (err) {
      if (timeout.aborted) throw new ArbError("PROVIDER_TIMEOUT", "Quote provider timed out", 504);
      if (signal?.aborted) throw err;
      throw new ArbError("PROVIDER_ERROR", "Quote provider unreachable", 502);
    }

    if (res.status === 429) {
      throw new ArbError("PROVIDER_RATE_LIMITED", "Quote provider rate limit reached", 503, {
        retryAfter: res.headers.get("retry-after"),
      });
    }
    // Jupiter answers 400 when no route exists for the pair or size.
    if (res.status === 400 || res.status === 404) {
      throw new ArbError("QUOTE_UNAVAILABLE", "No route is available for this trade right now", 409);
    }
    if (!res.ok) {
      throw new ArbError("PROVIDER_ERROR", `Quote provider returned HTTP ${res.status}`, 502);
    }

    const parsed = quoteSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Unrecognized quote response", 502);
    }
    const q = parsed.data;

    const outAmount = BigInt(q.outAmount);
    if (outAmount <= 0n) {
      throw new ArbError("QUOTE_UNAVAILABLE", "The quoted output for this size rounds to zero", 409);
    }

    const now = this.clock();
    return {
      inputMint: q.inputMint,
      outputMint: q.outputMint,
      // Amounts arrive as strings and go straight to BigInt: no float ever
      // touches a token amount.
      inAmount: BigInt(q.inAmount),
      outAmount,
      minOutAmount: BigInt(q.otherAmountThreshold),
      slippageBps: BigInt(q.slippageBps),
      priceImpactBps: priceImpactFractionToBpsCeil(q.priceImpactPct),
      routePlan: q.routePlan.map((hop) => ({
        ammLabel: hop.swapInfo.label ?? "Unknown venue",
        ammKey: hop.swapInfo.ammKey,
        inputMint: hop.swapInfo.inputMint,
        outputMint: hop.swapInfo.outputMint,
        percent: hop.percent ?? 100,
      })),
      swapUsdValueMicro: q.swapUsdValue ? usdStringToMicro(q.swapUsdValue) : null,
      contextSlot: q.contextSlot ?? null,
      swapMode: q.swapMode,
      retrievedAtMs: now,
      expiresAtMs: now + this.quoteTtlMs,
      source: JUPITER_QUOTE_SOURCE,
    };
  }
}
