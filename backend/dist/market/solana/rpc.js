import { z } from "zod";
import { ArbError } from "../../core/errors.js";
import { metrics, outcomeForErrorCode } from "../../observability/metrics.js";
export const SOLANA_PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
/**
 * getMultipleAccounts is capped server-side. Exceeding it is a hard RPC error,
 * so callers batch against this constant rather than discovering it in prod.
 */
export const MAX_MULTIPLE_ACCOUNTS = 100;
/** Base58 alphabet excludes 0, O, I and l; a 32-byte key encodes to 32-44 chars. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isPlausibleAddress(address) {
    return BASE58_ADDRESS.test(address);
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
function toAccountInfo(value) {
    return {
        data: Buffer.from(value.data[0], "base64"),
        owner: value.owner,
        lamports: BigInt(value.lamports),
        executable: value.executable,
    };
}
export class SolanaRpcClient {
    endpoint;
    timeoutMs;
    commitment;
    fetchImpl;
    constructor(config = {}) {
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
    async call(method, params, resultSchema, signal) {
        // Keyed by RPC method, never by endpoint: an endpoint URL can carry an API
        // key in its path or query string, and metrics must never hold a secret.
        const metricKey = `solana:rpc:${method}`;
        const startedAt = Date.now();
        try {
            const result = await this.callInner(method, params, resultSchema, signal);
            metrics.providerCall(metricKey, "ok", Date.now() - startedAt);
            return result;
        }
        catch (err) {
            const code = err.code ?? "";
            metrics.providerCall(metricKey, outcomeForErrorCode(code), Date.now() - startedAt);
            throw err;
        }
    }
    async callInner(method, params, resultSchema, signal) {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let res;
        try {
            res = await this.fetchImpl(this.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                signal: combined,
            });
        }
        catch (err) {
            if (timeout.aborted) {
                throw new ArbError("PROVIDER_TIMEOUT", "Solana RPC timed out", 504);
            }
            if (signal?.aborted)
                throw err; // caller cancelled; not our failure
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
        const json = await res.json().catch(() => null);
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
            throw new ArbError("MALFORMED_PROVIDER_RESPONSE", `Unexpected Solana RPC result shape for ${method}`, 502);
        }
        return parsed.data;
    }
    assertAddress(address) {
        if (!isPlausibleAddress(address)) {
            throw new ArbError("VALIDATION_ERROR", `Not a valid base58 Solana address: ${address}`, 400);
        }
    }
    /** Read one account. Throws only on transport/protocol failure. */
    async getAccountInfo(address, signal) {
        this.assertAddress(address);
        const result = await this.call("getAccountInfo", [address, { encoding: "base64", commitment: this.commitment }], z.object({ value: accountValueSchema.nullable() }), signal);
        if (result.value === null)
            return { status: "not_found" };
        return { status: "found", account: toAccountInfo(result.value) };
    }
    /**
     * Read many accounts in one round trip, preserving request order.
     *
     * Batching is the point: classifying twenty holders one call at a time is
     * twenty chances to hit a rate limit, because public endpoints throttle per
     * request, not per byte. Entries are null where no account exists.
     */
    async getMultipleAccounts(addresses, signal) {
        if (addresses.length === 0)
            return [];
        if (addresses.length > MAX_MULTIPLE_ACCOUNTS) {
            throw new ArbError("VALIDATION_ERROR", `getMultipleAccounts accepts at most ${MAX_MULTIPLE_ACCOUNTS} addresses`, 400);
        }
        for (const address of addresses)
            this.assertAddress(address);
        const result = await this.call("getMultipleAccounts", [addresses, { encoding: "base64", commitment: this.commitment }], z.object({ value: z.array(accountValueSchema.nullable()) }), signal);
        // Positional correspondence is the entire contract of this method. A node
        // returning a different length has broken it, and pairing the results up
        // anyway would attribute one wallet's balance to another wallet.
        if (result.value.length !== addresses.length) {
            throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "Solana RPC returned a different number of accounts than requested", 502);
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
    async getTokenLargestAccounts(mint, signal) {
        this.assertAddress(mint);
        const result = await this.call("getTokenLargestAccounts", [mint, { commitment: this.commitment }], z.object({ value: z.array(largestAccountSchema) }), signal);
        return result.value.map((entry) => ({
            address: entry.address,
            amountBaseUnits: BigInt(entry.amount),
        }));
    }
}
