import { z } from "zod";
import { ArbError } from "../../core/errors.js";
import { CachedLoader } from "../cache.js";
import type { Reliability, TokenSearchResult } from "../types.js";
import {
  DEFAULT_JUPITER_TOKENS_URL,
  JUPITER_SOURCE,
  jupiterTokenSchema,
  normalizeJupiterToken,
  type JupiterRawToken,
} from "./tokenSearch.js";

/** The two feeds deliberately answer different user questions. */
export type LiveFeedKind = "recent" | "trending";

export interface LiveFeedWindow {
  priceChangeBps: bigint | null;
  liquidityChangeBps: bigint | null;
  volumeChangeBps: bigint | null;
  buyVolumeUsdMicro: bigint | null;
  sellVolumeUsdMicro: bigint | null;
  buys: number | null;
  sells: number | null;
  traders: number | null;
}

export interface LiveFeedToken {
  token: TokenSearchResult;
  firstPoolAtMs: number | null;
  updatedAtMs: number | null;
  launchpad: string | null;
  fiveMinutes: LiveFeedWindow;
  oneHour: LiveFeedWindow;
  twentyFourHours: LiveFeedWindow;
}

export interface LiveFeedResult {
  kind: LiveFeedKind;
  source: string;
  fetchedAtMs: number;
  reliability: Reliability;
  tokens: LiveFeedToken[];
}

export interface LiveTokenFeedProvider {
  readonly source: string;
  getFeed(kind: LiveFeedKind, signal?: AbortSignal): Promise<LiveFeedResult>;
}

const feedEnvelopeSchema = z.array(z.unknown());

const scaledUsd = (value: number | undefined): bigint | null => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  const whole = Math.floor(value);
  const fraction = Math.round((value - whole) * 1_000_000);
  return BigInt(whole) * 1_000_000n + BigInt(Math.min(fraction, 999_999));
};

const bps = (value: number | undefined): bigint | null =>
  value === undefined || !Number.isFinite(value) ? null : BigInt(Math.round(value * 100));

function window(raw: JupiterRawToken["stats5m"]): LiveFeedWindow {
  return {
    priceChangeBps: bps(raw?.priceChange),
    liquidityChangeBps: bps(raw?.liquidityChange),
    volumeChangeBps: bps(raw?.volumeChange),
    buyVolumeUsdMicro: scaledUsd(raw?.buyVolume),
    sellVolumeUsdMicro: scaledUsd(raw?.sellVolume),
    buys: raw?.numBuys ?? null,
    sells: raw?.numSells ?? null,
    traders: raw?.numTraders ?? null,
  };
}

function normalize(raw: JupiterRawToken): LiveFeedToken {
  const token = normalizeJupiterToken(raw);
  return {
    token,
    // Jupiter describes this as the token/pool creation timestamp. Moonpaper
    // labels it "first pool detected" because it is not an on-chain mint-age
    // proof and must not be presented as one.
    firstPoolAtMs: token.firstPoolAtMs ?? null,
    updatedAtMs: token.marketUpdatedAtMs ?? null,
    launchpad: (raw as JupiterRawToken & { launchpad?: string }).launchpad ?? null,
    fiveMinutes: window(raw.stats5m),
    oneHour: window(raw.stats1h),
    twentyFourHours: window(raw.stats24h),
  };
}

export interface JupiterLiveFeedOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  clock?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * Read-only live discovery through Jupiter Tokens V2.
 *
 * This provider never builds a swap and never treats catalog presence as an
 * executable route. Route availability is established separately by the
 * existing /v1/quote endpoint when the user requests a quote.
 */
export class JupiterLiveFeedProvider implements LiveTokenFeedProvider {
  readonly source = JUPITER_SOURCE;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly clock: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly loader: CachedLoader<LiveFeedToken[]>;

  constructor(options: JupiterLiveFeedOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_JUPITER_TOKENS_URL;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.apiKey = options.apiKey;
    this.clock = options.clock ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.loader = new CachedLoader<LiveFeedToken[]>({
      // The discovery UI recomputes its evidence score once per second. Keep
      // the provider cache on the same cadence while retaining single-flight
      // request deduplication and longer rate-limit backoff.
      ttlMs: options.cacheTtlMs ?? 1_000,
      failureTtlMs: 3_000,
      rateLimitTtlMs: 20_000,
      maxEntries: 4,
      clock: this.clock,
    });
  }

  async getFeed(kind: LiveFeedKind, signal?: AbortSignal): Promise<LiveFeedResult> {
    const cached = await this.loader.load(kind, () => this.fetchFeed(kind, signal));
    return {
      kind,
      source: this.source,
      fetchedAtMs: cached.fetchedAtMs,
      reliability: cached.ageMs <= 30_000 ? "fresh" : cached.ageMs <= 120_000 ? "stale" : "unavailable",
      tokens: cached.value,
    };
  }

  private async fetchFeed(kind: LiveFeedKind, signal?: AbortSignal): Promise<LiveFeedToken[]> {
    const path = kind === "recent" ? "/recent" : "/toptraded/5m?limit=100";
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: combined,
        headers: { accept: "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) },
      });
    } catch (err) {
      if (timeout.aborted) throw new ArbError("PROVIDER_TIMEOUT", "Live token feed timed out", 504);
      if (signal?.aborted) throw err;
      throw new ArbError("PROVIDER_ERROR", "Live token feed is unreachable", 502);
    }

    if (response.status === 429) {
      throw new ArbError("PROVIDER_RATE_LIMITED", "Live token feed rate limit reached", 503, {
        retryAfter: response.headers.get("retry-after"),
      });
    }
    if (!response.ok) {
      throw new ArbError("PROVIDER_ERROR", `Live token feed returned HTTP ${response.status}`, 502);
    }

    const envelope = feedEnvelopeSchema.safeParse(await response.json().catch(() => null));
    if (!envelope.success) {
      throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Unrecognized live token feed response", 502);
    }
    // One malformed catalog record must not blank the whole live feed. Identity
    // remains strict per item; unusable rows are dropped and observable.
    const tokens: LiveFeedToken[] = [];
    let dropped = 0;
    for (const value of envelope.data) {
      const parsed = jupiterTokenSchema.safeParse(value);
      if (parsed.success) tokens.push(normalize(parsed.data));
      else dropped++;
    }
    if (dropped > 0) {
      console.warn(JSON.stringify({ msg: "live feed dropped malformed token records", dropped, kind }));
    }
    if (tokens.length === 0 && envelope.data.length > 0) {
      throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Live token feed contained no usable records", 502);
    }
    return tokens;
  }
}
