import { z } from "zod";
import { ArbError } from "../../core/errors.js";
export const SOLANA_PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
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
const envelopeSchema = z.object({
    jsonrpc: z.literal("2.0"),
    result: z.object({ value: accountValueSchema.nullable() }).optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
});
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
    /** Read one account. Throws only on transport/protocol failure. */
    async getAccountInfo(address, signal) {
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
        let res;
        try {
            res = await this.fetchImpl(this.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
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
        if (value === null)
            return { status: "not_found" };
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
