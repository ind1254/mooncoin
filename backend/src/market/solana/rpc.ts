import { z } from "zod";
import { ArbError } from "../../core/errors.js";

/**
 * Minimal read-only Solana JSON-RPC client.
 *
 * Scope is three methods, all reads: `getAccountInfo`, `getMultipleAccounts`,
 * and `getTokenLargestAccounts`. We POST a JSON-RPC 2.0 envelope to an RPC
 * node and validate what comes back. No keypair, no signing, no transaction
 * submission — reading public chain state needs none of those, and this
 * project never does any of them.
 *
 * Why no @solana/web3.js: we need a handful of methods, Node 22 ships `fetch`,
 * and we already validate external responses with zod elsewhere in the
 * codebase. A library would add weight and hide the wire format we want to
 * understand.
 */

/**
 * How much confirmation we require before trusting a read.
 *  - processed: a validator has seen it; can still be rolled back
 *  - confirmed: a supermajority voted on it; reversal very unlikely
 *  - finalized: buried deep enough to be irreversible
 * For near-static config (mint authorities) `confirmed` is the right trade:
 * faster, and rollback risk on such a field is meaningless. Reads that settle
 * money would justify `finalized`.
 */
export type Commitment = "processed" | "confirmed" | "finalized";

export const SOLANA_PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

/**
 * getMultipleAccounts is capped server-side. Exceeding it is a hard RPC error,
 * so callers batch against this constant rather than discovering it in prod.
 */
export const MAX_MULTIPLE_ACCOUNTS = 100;

/** Base58 alphabet excludes 0, O, I and l; a 32-byte key encodes to 32-44 chars. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isPlausibleAddress(address: string): boolean {
  return BASE58_ADDRESS.test(address);
}

/** A raw account as the chain stores it: bytes plus the program that owns them. */
export interface AccountInfo {
  /** Raw account data. Interpretation is defined entirely by `owner`. */
  data: Uint8Array;
  /** Program that owns this account — this is what gives the bytes meaning. */
  owner: string;
  lamports: bigint;
  executable: boolean;
}

/** "No such account" is a fact about the chain, not an error. */
export type AccountInfoResult = { status: "found"; account: AccountInfo } | { status: "not_found" };

/** One entry from getTokenLargestAccounts: a token account and its balance. */
export interface LargestTokenAccount {
  /** Address of the TOKEN ACCOUNT (a balance), not of whoever owns it. */
  address: string;
  /** Balance in base units. u64 arrives as a string precisely so it survives. */
  amountBaseUnits: bigint;
}

const accountValueSchema = z.object({
  // With encoding: "base64" the node returns a [payload, encoding] pair.
  data: z.tuple([z.string(), z.literal("base64")]),
  owner: z.string(),
  lamports: z.number(),
  executable: z.boolean(),
});

const largestAccountSchema = z.object({
  address: z.string(),
  // u64 balances are serialized as decimal strings; parsing them as JSON
  // numbers would silently lose precision above 2^53.
  amount: z.string().regex(/^\d+$/),
});

/** Envelope shared by every method; `result` is validated per call site. */
const envelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

function toAccountInfo(value: z.infer<typeof accountValueSchema>): AccountInfo {
  return {
    data: Buffer.from(value.data[0], "base64"),
    owner: value.owner,
    lamports: BigInt(value.lamports),
    executable: value.executable,
  };
}

export interface SolanaRpcConfig {
  endpoint?: string;
  timeoutMs?: number;
  commitment?: Commitment;
  /** Injectable for offline tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class SolanaRpcClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly commitment: Commitment;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SolanaRpcConfig = {}) {
    this.endpoint = config.endpoint ?? SOLANA_PUBLIC_MAINNET_RPC;
    this.timeoutMs = config.timeoutMs ?? 8_000;
    this.commitment = config.commitment ?? "confirmed";
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  /**
   * One JSON-RPC round trip, validated against `resultSchema`.
   *
   * Throws only on transport/protocol failure. Method-level absence — a null
   * account, an empty list — is data, and is left for callers to interpret.
   */
  private async call<T>(
    method: string,
    params: unknown[],
    resultSchema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted) {
        throw new ArbError("PROVIDER_TIMEOUT", "Solana RPC timed out", 504);
      }
      if (signal?.aborted) throw err; // caller cancelled; not our failure
      throw new ArbError("PROVIDER_ERROR", "Solana RPC unreachable", 502);
    }

    // Public endpoints throttle aggressively; this is the failure we hit most.
    if (res.status === 429) {
      throw new ArbError("PROVIDER_RATE_LIMITED", "Solana RPC rate limit reached", 503, {
        retryAfter: res.headers.get("retry-after"),
      });
    }
    if (!res.ok) {
      throw new ArbError("PROVIDER_ERROR", `Solana RPC returned HTTP ${res.status}`, 502, {
        httpStatus: res.status,
      });
    }

    const json: unknown = await res.json().catch(() => null);
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Unrecognized Solana RPC response", 502);
    }
    if (envelope.data.error) {
      throw new ArbError("PROVIDER_ERROR", `Solana RPC error: ${envelope.data.error.message}`, 502, {
        rpcCode: envelope.data.error.code,
        rpcMethod: method,
      });
    }
    if (envelope.data.result === undefined) {
      throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Solana RPC response had no result", 502);
    }

    const parsed = resultSchema.safeParse(envelope.data.result);
    if (!parsed.success) {
      throw new ArbError(
        "MALFORMED_PROVIDER_RESPONSE",
        `Unexpected Solana RPC result shape for ${method}`,
        502,
      );
    }
    return parsed.data;
  }

  private assertAddress(address: string): void {
    if (!isPlausibleAddress(address)) {
      throw new ArbError("VALIDATION_ERROR", `Not a valid base58 Solana address: ${address}`, 400);
    }
  }

  /** Read one account. Throws only on transport/protocol failure. */
  async getAccountInfo(address: string, signal?: AbortSignal): Promise<AccountInfoResult> {
    this.assertAddress(address);

    const result = await this.call(
      "getAccountInfo",
      [address, { encoding: "base64", commitment: this.commitment }],
      z.object({ value: accountValueSchema.nullable() }),
      signal,
    );

    if (result.value === null) return { status: "not_found" };
    return { status: "found", account: toAccountInfo(result.value) };
  }

  /**
   * Read many accounts in one round trip, preserving request order.
   *
   * Batching is the point: classifying twenty holders one call at a time is
   * twenty chances to hit a rate limit, because public endpoints throttle per
   * request, not per byte. Entries are null where no account exists.
   */
  async getMultipleAccounts(
    addresses: string[],
    signal?: AbortSignal,
  ): Promise<(AccountInfo | null)[]> {
    if (addresses.length === 0) return [];
    if (addresses.length > MAX_MULTIPLE_ACCOUNTS) {
      throw new ArbError(
        "VALIDATION_ERROR",
        `getMultipleAccounts accepts at most ${MAX_MULTIPLE_ACCOUNTS} addresses`,
        400,
      );
    }
    for (const address of addresses) this.assertAddress(address);

    const result = await this.call(
      "getMultipleAccounts",
      [addresses, { encoding: "base64", commitment: this.commitment }],
      z.object({ value: z.array(accountValueSchema.nullable()) }),
      signal,
    );

    // Positional correspondence is the entire contract of this method. A node
    // returning a different length has broken it, and pairing the results up
    // anyway would attribute one wallet's balance to another wallet.
    if (result.value.length !== addresses.length) {
      throw new ArbError(
        "MALFORMED_PROVIDER_RESPONSE",
        "Solana RPC returned a different number of accounts than requested",
        502,
      );
    }

    return result.value.map((value) => (value === null ? null : toAccountInfo(value)));
  }

  /**
   * The 20 largest token accounts for a mint, largest first.
   *
   * Note what this does NOT return: holders. It returns token ACCOUNTS. Two
   * entries can belong to the same owner, and for a meme coin most of the top
   * entries belong to pools rather than to people — see holders.ts.
   */
  async getTokenLargestAccounts(
    mint: string,
    signal?: AbortSignal,
  ): Promise<LargestTokenAccount[]> {
    this.assertAddress(mint);

    const result = await this.call(
      "getTokenLargestAccounts",
      [mint, { commitment: this.commitment }],
      z.object({ value: z.array(largestAccountSchema) }),
      signal,
    );

    return result.value.map((entry) => ({
      address: entry.address,
      amountBaseUnits: BigInt(entry.amount),
    }));
  }
}
