import { ArbError } from "../core/errors.js";
import { CachedLoader } from "./cache.js";
import { readHolderConcentration, type HolderConcentration } from "./solana/holders.js";
import { readMintAccount, type MintReadResult } from "./solana/mint.js";
import { SOLANA_MAINNET_SOURCE } from "./solana/riskProvider.js";
import type { SolanaRpcClient } from "./solana/rpc.js";
import type {
  DiscoveredMarketFacts,
  OnChainHolderVerification,
  OnChainMintVerification,
  TokenSearchProvider,
  TokenSearchResult,
} from "./types.js";

/**
 * Token research: joins a discovery provider (identity + market facts) with a
 * direct read of the mint account (authoritative on-chain settings).
 *
 * The division of authority is the point of this module. The discovery
 * provider answers "which token, and what is the market doing?". The chain
 * answers "what can the token's owner actually do?". Where both speak, the
 * chain wins and the disagreement is surfaced rather than hidden.
 *
 * Nothing here fabricates a value. A metric with no provider is reported as
 * unavailable.
 */

export type FactStatus = "verified" | "reported" | "unavailable";

export interface ResearchFactor {
  id: string;
  label: string;
  /** The observation itself, stated neutrally. */
  fact: string;
  /** What it may imply. Kept separate from the fact on purpose. */
  interpretation: string;
  direction: "positive" | "negative" | "neutral";
  status: FactStatus;
  source: string;
  /** Contribution to the risk score. Zero for informational factors. */
  points: number;
}

export interface ResearchRisk {
  score: number;
  level: "low" | "medium" | "high";
  factors: ResearchFactor[];
  method: string;
}

export interface ResearchProfile {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  tokenProgram: string | null;
  iconUrl: string | null;
  tags: string[];
  verifiedByProvider: boolean;
  identitySource: string;
  marketSource: string;
  /** Provider observation time used by the stale-market-data gate. */
  marketUpdatedAtMs: number | null;
  market: DiscoveredMarketFacts;
  /** Always present: an unreadable chain yields an "unavailable" record. */
  verification: OnChainMintVerification;
  authorities: {
    mintAuthorityRevoked: boolean | null;
    freezeAuthorityRevoked: boolean | null;
    source: string;
    /** Whether the discovery provider's claim matched the chain. */
    providerAgreement: "agrees" | "disagrees" | "not_reported";
  };
  risk: ResearchRisk;
  simulation: { available: boolean; reason: string };
  fetchedAtMs: number;
}

const RISK_BANDS = { lowBelow: 30, mediumBelow: 60 };

/**
 * Above this reported holder count, skip the on-chain concentration scan.
 *
 * getTokenLargestAccounts walks the mint's token accounts, so it gets slower
 * as a token gets more successful. Measured against a keyed endpoint: a token
 * with tens of holders answers immediately, while BONK (hundreds of thousands)
 * exceeds the client's 8s timeout and the serverless function's budget.
 *
 * This is a product-shaped limit, not just a technical one. Concentration
 * matters most for young, thin tokens — exactly the ones that are cheap to
 * scan. For an established token the question is largely moot, and the
 * discovery provider's reported figure is a reasonable stand-in.
 */
const MAX_HOLDERS_FOR_ON_CHAIN_SCAN = 25_000;

const bpsToPct = (bps: bigint): number => Number(bps) / 100;
const microToUsd = (v: bigint): number => Number(v / 1_000_000n);

/**
 * Transparent additive risk model over whatever facts are actually available.
 *
 * Deliberately NOT a copy of the demo scorer: that one requires a full
 * simulated market view. Unifying the two is the contextual-scoring work and
 * is intentionally out of scope here. Points are stated per factor so the UI
 * can show exactly what produced the number.
 */
function assessRisk(
  token: TokenSearchResult,
  mint: MintReadResult | null,
  holders: HolderConcentration | null,
): ResearchRisk {
  const factors: ResearchFactor[] = [];
  const add = (f: ResearchFactor) => factors.push(f);

  // --- Authorities: verified on-chain where possible ---
  if (mint && mint.status === "found") {
    if (mint.mint.mintAuthorityPresent) {
      add({
        id: "mint-authority-active",
        label: "Mint authority",
        fact: "An address still holds permission to mint additional supply.",
        interpretation:
          "Supply can be increased by that address, diluting holders. This is normal for stablecoins and managed tokens, and a larger concern for an anonymous token.",
        direction: "negative",
        status: "verified",
        source: SOLANA_MAINNET_SOURCE,
        points: 25,
      });
    } else {
      add({
        id: "mint-authority-revoked",
        label: "Mint authority",
        fact: "No address can mint additional supply through the original mint authority.",
        interpretation: "Supply cannot be inflated this way.",
        direction: "positive",
        status: "verified",
        source: SOLANA_MAINNET_SOURCE,
        points: 0,
      });
    }

    if (mint.mint.freezeAuthorityPresent) {
      add({
        id: "freeze-authority-active",
        label: "Freeze authority",
        fact: "An authority can still freeze token accounts.",
        interpretation: "Holders could be blocked from transferring this token.",
        direction: "negative",
        status: "verified",
        source: SOLANA_MAINNET_SOURCE,
        points: 12,
      });
    } else {
      add({
        id: "freeze-authority-revoked",
        label: "Freeze authority",
        fact: "Token accounts can no longer be frozen by the original freeze authority.",
        interpretation: "Transfers cannot be blocked this way.",
        direction: "positive",
        status: "verified",
        source: SOLANA_MAINNET_SOURCE,
        points: 0,
      });
    }
  } else {
    add({
      id: "authorities-unverified",
      label: "Mint and freeze authority",
      fact: "On-chain authority settings could not be read.",
      interpretation: "Unknown settings are treated as risk rather than assumed safe.",
      direction: "negative",
      status: "unavailable",
      source: SOLANA_MAINNET_SOURCE,
      points: 12,
    });
  }

  // --- Holder concentration: measured on-chain where we could, else reported ---
  //
  // The two differ by more than provenance. The discovery provider counts the
  // largest token accounts; we count the largest accounts owned by KEYPAIR
  // wallets, because pool vaults and bonding curves are tradable supply rather
  // than a holder who can dump. On a pump.fun token still on its curve those
  // answers are not close.
  if (holders) {
    const pct = bpsToPct(holders.concentrationBps);
    const points = pct >= 50 ? 25 : pct >= 30 ? 12 : 0;
    const poolPct = bpsToPct(holders.programHeldBps);
    const poolNote =
      holders.programHeldBps > 0n
        ? ` A further ${poolPct.toFixed(1)}% is held by pools or bonding curves, which is supply you can trade against rather than a holder.`
        : "";

    add({
      id: "holder-concentration",
      label: "Holder concentration",
      fact: holders.complete
        ? `The top ${holders.walletHolderCount} wallet holders control ${pct.toFixed(1)}% of supply.${poolNote}`
        : `The top ${holders.walletHolderCount} wallet holders control at least ${pct.toFixed(1)}% of supply; ${bpsToPct(holders.unclassifiedBps).toFixed(1)}% could not be attributed.${poolNote}`,
      interpretation:
        points >= 25
          ? "A small group of wallets could move the price substantially by selling."
          : points > 0
            ? "Concentration among wallets is elevated; large holders could move the price."
            : "Supply is reasonably distributed across wallets.",
      direction: points > 0 ? "negative" : "positive",
      // Incomplete attribution is a floor, not a verified total, so it must
      // not carry the same badge as a fully classified measurement.
      status: holders.complete ? "verified" : "reported",
      source: SOLANA_MAINNET_SOURCE,
      // An unattributed remainder could be either bucket; charge a little for
      // the uncertainty rather than assuming the friendly reading.
      points: holders.complete ? points : points + 5,
    });
  } else if (token.market.topHolderPctBps !== null) {
    const top = token.market.topHolderPctBps;
    const pct = bpsToPct(top);
    const points = pct >= 50 ? 25 : pct >= 30 ? 12 : 0;
    add({
      id: "holder-concentration",
      label: "Holder concentration",
      fact: `The largest holders control about ${pct.toFixed(1)}% of supply.`,
      interpretation:
        points >= 25
          ? "A small group could move the price substantially by selling."
          : points > 0
            ? "Concentration is elevated; large holders could move the price."
            : "Supply is reasonably distributed.",
      direction: points > 0 ? "negative" : "positive",
      status: "reported",
      source: token.source,
      points,
    });
  } else {
    add({
      id: "holder-concentration-unavailable",
      label: "Holder concentration",
      fact: "Holder distribution was not reported for this token.",
      interpretation: "Cannot assess whether a few wallets dominate supply.",
      direction: "neutral",
      status: "unavailable",
      source: token.source,
      points: 5,
    });
  }

  // --- Liquidity depth ---
  const liq = token.market.liquidityUsdMicro;
  if (liq !== null) {
    const usd = microToUsd(liq);
    const points = usd < 50_000 ? 25 : usd < 250_000 ? 15 : usd < 1_000_000 ? 8 : 0;
    add({
      id: "liquidity-depth",
      label: "Liquidity",
      fact: `About $${usd.toLocaleString()} of liquidity is available to trade against.`,
      interpretation:
        points >= 25
          ? "Very thin. Even a small trade would move the price sharply, and exiting may be difficult."
          : points > 0
            ? "Moderate. Larger trades would move the price noticeably."
            : "Deep enough to absorb ordinary trade sizes.",
      direction: points > 0 ? "negative" : "positive",
      status: "reported",
      source: token.source,
      points,
    });
  } else {
    add({
      id: "liquidity-unavailable",
      label: "Liquidity",
      fact: "Liquidity was not reported for this token.",
      interpretation: "Execution cost cannot be estimated.",
      direction: "neutral",
      status: "unavailable",
      source: token.source,
      points: 8,
    });
  }

  // --- Provider allowlist status ---
  if (!token.verifiedByProvider) {
    add({
      id: "not-provider-verified",
      label: "Token list status",
      fact: "This token is not on the discovery provider's verified list.",
      interpretation: "Unlisted tokens receive less scrutiny and are more often short-lived.",
      direction: "negative",
      status: "reported",
      source: token.source,
      points: 8,
    });
  } else {
    add({
      id: "provider-verified",
      label: "Token list status",
      fact: "This token appears on the discovery provider's verified list.",
      interpretation: "It has passed that provider's listing checks. Not a guarantee of quality.",
      direction: "positive",
      status: "reported",
      source: token.source,
      points: 0,
    });
  }

  // --- Trading pressure ---
  const buys = token.market.buyVolume24hUsdMicro;
  const sells = token.market.sellVolume24hUsdMicro;
  if (buys !== null && sells !== null && buys > 0n) {
    const heavySelling = sells > buys * 2n;
    add({
      id: "trade-pressure",
      label: "24h trading pressure",
      fact: `$${microToUsd(buys).toLocaleString()} bought versus $${microToUsd(sells).toLocaleString()} sold in the last 24 hours.`,
      interpretation: heavySelling
        ? "Selling substantially outweighs buying over this window."
        : "Buying and selling are broadly balanced over this window.",
      direction: heavySelling ? "negative" : "neutral",
      status: "reported",
      source: token.source,
      points: heavySelling ? 5 : 0,
    });
  }

  // --- Token age: honestly unavailable ---
  add({
    id: "token-age-unavailable",
    label: "Token age",
    fact: "The true mint creation date is not available from current providers.",
    interpretation:
      "Age is a useful risk signal, but the discovery provider reports when it first indexed the token, not when the mint was created, so it is not used here.",
    direction: "neutral",
    status: "unavailable",
    source: "none",
    points: 0,
  });

  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
  const level = score < RISK_BANDS.lowBelow ? "low" : score < RISK_BANDS.mediumBelow ? "medium" : "high";

  return {
    score,
    level,
    factors,
    method:
      "Additive model over independently sourced facts. On-chain authority settings are verified directly; market facts are reported by the discovery provider; unavailable inputs add a small penalty rather than being assumed safe.",
  };
}

export interface ResearchServiceOptions {
  /** True when Moonpaper can produce executable quotes for this mint. */
  simulationAvailable?: (mint: string) => Promise<boolean>;
  mintCacheTtlMs?: number;
  /** Short by design: holder balances change on every trade. */
  holderCacheTtlMs?: number;
  /** Overrides MAX_HOLDERS_FOR_ON_CHAIN_SCAN; raise it in tests. */
  maxHoldersForOnChainScan?: number;
  clock?: () => number;
}

/**
 * Names why holder concentration is missing, in terms an operator can act on.
 *
 * Each of these has a different fix — raise the cache TTL, check the endpoint,
 * or look at what the provider actually returned — so collapsing them into one
 * sentence turns a five-minute diagnosis into guesswork.
 */
function describeHolderFailure(err: unknown): string {
  const tail = "holder concentration was not measured on-chain.";
  if (!(err instanceof ArbError)) return `Unexpected error; ${tail}`;

  switch (err.code) {
    case "PROVIDER_RATE_LIMITED":
      return `Solana RPC rate limit reached; ${tail}`;
    case "PROVIDER_TIMEOUT":
      return `Solana RPC timed out; ${tail}`;
    case "MALFORMED_PROVIDER_RESPONSE":
      // Usually a provider that answers the method but with a different shape,
      // or one that refuses it inside a 200 response.
      return `Solana RPC returned an unrecognized response; ${tail}`;
    case "PROVIDER_ERROR": {
      const status = err.details?.httpStatus;
      const rpcCode = err.details?.rpcCode;
      if (typeof rpcCode === "number") {
        return `Solana RPC rejected the request (code ${rpcCode}); ${tail}`;
      }
      if (typeof status === "number") {
        return `Solana RPC returned HTTP ${status}; ${tail}`;
      }
      return `Solana RPC could not be reached; ${tail}`;
    }
    default:
      return `Solana RPC unavailable (${err.code}); ${tail}`;
  }
}

/** Turns a holder measurement into the record the API and UI display. */
function describeHolders(holders: HolderConcentration): OnChainHolderVerification {
  const pct = (bps: bigint): string => bpsToPct(bps).toFixed(1);
  const poolNote =
    holders.programHeldBps > 0n
      ? ` ${pct(holders.programHeldBps)}% is held by pools or bonding curves and is excluded.`
      : "";

  return {
    status: holders.complete ? "verified" : "incomplete",
    concentrationBps: holders.concentrationBps,
    programHeldBps: holders.programHeldBps,
    walletHolderCount: holders.walletHolderCount,
    unclassifiedBps: holders.unclassifiedBps,
    detail: holders.complete
      ? `Top ${holders.walletHolderCount} wallet holders control ${pct(holders.concentrationBps)}% of supply.${poolNote}`
      : `Top ${holders.walletHolderCount} wallet holders control at least ${pct(holders.concentrationBps)}% of supply; ${pct(holders.unclassifiedBps)}% could not be attributed.${poolNote}`,
  };
}

export class ResearchService {
  private readonly clock: () => number;
  private readonly loader: CachedLoader<MintReadResult>;
  private readonly holderLoader: CachedLoader<HolderConcentration>;
  private readonly simulationAvailable: (mint: string) => Promise<boolean>;
  private readonly maxHoldersForScan: number;

  constructor(
    private readonly discovery: TokenSearchProvider,
    private readonly rpc: SolanaRpcClient,
    options: ResearchServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.simulationAvailable = options.simulationAvailable ?? (async () => false);
    this.maxHoldersForScan = options.maxHoldersForOnChainScan ?? MAX_HOLDERS_FOR_ON_CHAIN_SCAN;
    this.loader = new CachedLoader<MintReadResult>({
      ttlMs: options.mintCacheTtlMs ?? 600_000,
      clock: this.clock,
    });
    // Balances move on every trade, and each miss costs three RPC calls
    // against the mint cache's one, so this TTL is deliberately much shorter
    // and the loader's single-flight behaviour matters more here.
    this.holderLoader = new CachedLoader<HolderConcentration>({
      ttlMs: options.holderCacheTtlMs ?? 60_000,
      clock: this.clock,
    });
  }

  get searchSource(): string {
    return this.discovery.source;
  }

  /** Canonical token identity, used to resolve decimals before quoting. */
  async resolveToken(mint: string, signal?: AbortSignal): Promise<TokenSearchResult | null> {
    return this.discovery.getByMint(mint, signal);
  }

  async search(query: string, signal?: AbortSignal): Promise<TokenSearchResult[]> {
    return this.discovery.search(query, signal);
  }

  async getProfile(mint: string, signal?: AbortSignal): Promise<ResearchProfile> {
    const token = await this.discovery.getByMint(mint, signal);
    if (!token) {
      throw new ArbError("TOKEN_NOT_ALLOWED", "No token found for that mint address", 404);
    }

    const requestedAtMs = this.clock();
    let mintRead: MintReadResult | null = null;
    let verification: OnChainMintVerification;

    try {
      const cached = await this.loader.load(mint, () => readMintAccount(this.rpc, mint, signal));
      mintRead = cached.value;
      // Report when the RPC read actually happened, not when a cached value was
      // requested again. Production gates must never make cached evidence look
      // newer than it is.
      verification = describeVerification(mintRead, cached.fetchedAtMs, token.decimals);
    } catch (err) {
      verification = {
        status: "unavailable",
        source: SOLANA_MAINNET_SOURCE,
        checkedAtMs: requestedAtMs,
        detail:
          err instanceof ArbError && err.code === "PROVIDER_RATE_LIMITED"
            ? "Solana RPC rate limit reached; on-chain settings could not be read."
            : "Solana RPC could not be reached; on-chain settings could not be read.",
      };
    }

    // Holder concentration needs total supply, and supply comes from the mint
    // account we just read. Without it the ratio would divide a chain number
    // by a vendor number, so we simply do not attempt it.
    let holders: HolderConcentration | null = null;
    const tooManyHolders =
      token.market.holderCount !== null && token.market.holderCount > this.maxHoldersForScan;

    if (tooManyHolders) {
      // getTokenLargestAccounts scans the mint's token accounts, so its cost
      // grows with holder count. On an established token it reliably exceeds
      // both our RPC timeout and the serverless function budget.
      //
      // Failing fast matters: attempting it anyway spent eight seconds and an
      // RPC credit on every request for a large token, and still fell back.
      // Skipping costs nothing and returns the same answer immediately.
      verification = {
        ...verification,
        holders: {
          status: "unavailable",
          detail: `This token has roughly ${token.market.holderCount!.toLocaleString()} holders, too many to scan within the request budget, so concentration is not measured on-chain here.`,
        },
      };
    } else if (mintRead?.status === "found" && verification.status === "verified") {
      const supply = mintRead.mint.supplyBaseUnits;
      try {
        const cached = await this.holderLoader.load(mint, () =>
          readHolderConcentration(this.rpc, mint, supply, signal),
        );
        holders = cached.value;
        verification = { ...verification, holders: describeHolders(holders) };
      } catch (err) {
        // Authorities stay verified; only this metric is missing. Public
        // endpoints refuse getTokenLargestAccounts far more often than
        // getAccountInfo, so this is the common path, not the rare one.
        //
        // The distinct causes are named rather than collapsed into "could not
        // be reached": a throttled endpoint, an unreachable one, and one that
        // answered in a shape we do not recognise need completely different
        // fixes, and a single vague message makes them indistinguishable from
        // outside the process.
        verification = {
          ...verification,
          holders: { status: "unavailable", detail: describeHolderFailure(err) },
        };

        // Structured line so the cause is visible in production logs. The
        // endpoint URL is never included — it carries the API key.
        console.warn(
          JSON.stringify({
            ts: new Date(this.clock()).toISOString(),
            msg: "on-chain holder concentration unavailable",
            mint,
            code: err instanceof ArbError ? err.code : "UNKNOWN",
            httpStatus: err instanceof ArbError ? err.details?.httpStatus : undefined,
            rpcCode: err instanceof ArbError ? err.details?.rpcCode : undefined,
          }),
        );
      }
    }

    const verified = mintRead?.status === "found" ? mintRead.mint : null;
    const claim = token.providerClaims.mintAuthorityDisabled;
    const agreement: "agrees" | "disagrees" | "not_reported" =
      claim === null || verified === null
        ? "not_reported"
        : claim === !verified.mintAuthorityPresent
          ? "agrees"
          : "disagrees";

    const simAvailable = await this.simulationAvailable(mint);

    return {
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      // Prefer the chain's decimals when we have them.
      decimals: verified?.decimals ?? token.decimals,
      tokenProgram: token.tokenProgram,
      iconUrl: token.iconUrl,
      tags: token.tags,
      verifiedByProvider: token.verifiedByProvider,
      identitySource: token.source,
      marketSource: token.source,
      marketUpdatedAtMs: token.marketUpdatedAtMs ?? null,
      market: token.market,
      verification,
      authorities: {
        mintAuthorityRevoked: verified ? !verified.mintAuthorityPresent : null,
        freezeAuthorityRevoked: verified ? !verified.freezeAuthorityPresent : null,
        source: verified ? SOLANA_MAINNET_SOURCE : token.source,
        providerAgreement: agreement,
      },
      risk: assessRisk(token, mintRead, holders),
      simulation: {
        available: simAvailable,
        reason: simAvailable
          ? "This mint is available in the deterministic simulator."
          : "This mint is not in the legacy simulator. Run the production eligibility check to use authenticated live-quote paper trading.",
      },
      fetchedAtMs: requestedAtMs,
    };
  }
}

function describeVerification(
  result: MintReadResult,
  checkedAtMs: number,
  declaredDecimals: number,
): OnChainMintVerification {
  const base = { source: SOLANA_MAINNET_SOURCE, checkedAtMs };
  switch (result.status) {
    case "found":
      return {
        ...base,
        status: "verified",
        decimalsOnChain: result.mint.decimals,
        decimalsMismatch: result.mint.decimals !== declaredDecimals,
      };
    case "not_found":
      return { ...base, status: "not_found", detail: "No account exists at this mint address on Solana mainnet." };
    case "unsupported_program":
      return { ...base, status: "unsupported_program", detail: result.reason };
    case "malformed":
      return { ...base, status: "malformed", detail: result.reason };
  }
}
