import { z } from "zod";
import { ArbError } from "../../core/errors.js";

/**
 * Minimal read-only Solana JSON-RPC client.
 *
 * Scope is deliberately one method: `getAccountInfo`. We POST a JSON-RPC 2.0
 * envelope to an RPC node and validate what comes back. No keypair, no
 * signing, no transaction submission — reading public chain state needs none
 * of those, and this project never does any of them.
 *
 * Why no @solana/web3.js: we need exactly one method, Node 22 ships `fetch`,
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

const accountValueSchema = z.object({
  // With encoding: "base64" the node returns a [payload, encoding] pair.
  data: z.tuple([z.string(), z.literal("base64")]),
  owner: z.string(),
  lamports: z.number(),
  executable: z.boolean(),
});

const envelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.object({ value: accountValueSchema.nullable() }).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

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

  /** Read one account. Throws only on transport/protocol failure. */
  async getAccountInfo(address: string, signal?: AbortSignal): Promise<AccountInfoResult> {
    if (!isPlausibleAddress(address)) {
      throw new ArbError("VALIDATION_ERROR", `Not a valid base58 Solana address: ${address}`, 400);
    }

    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64", commitment: this.commitment }],
    };

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Unrecognized Solana RPC response", 502);
    }
    if (parsed.data.error) {
      throw new ArbError("PROVIDER_ERROR", `Solana RPC error: ${parsed.data.error.message}`, 502, {
        rpcCode: parsed.data.error.code,
      });
    }
    if (!parsed.data.result) {
      throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Solana RPC response had no result", 502);
    }

    const value = parsed.data.result.value;
    if (value === null) return { status: "not_found" };

    return {
      status: "found",
      account: {
        data: Buffer.from(value.data[0], "base64"),
        owner: value.owner,
        lamports: BigInt(value.lamports),
        executable: value.executable,
      },
    };
  }
}
