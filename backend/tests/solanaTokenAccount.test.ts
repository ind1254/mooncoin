import { describe, expect, it } from "vitest";
import { base58Encode, readPubkey } from "../src/market/solana/base58.js";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "../src/market/solana/mint.js";
import { parseTokenAccount } from "../src/market/solana/tokenAccount.js";
import { SYSTEM_PROGRAM_ID } from "../src/market/solana/holders.js";

/**
 * The token-account layout is verified against bytes this file builds at
 * explicit offsets rather than against a recorded mainnet account.
 *
 * That is deliberate. Reaching a real token account requires
 * getTokenLargestAccounts, which public RPC endpoints refuse outright (they
 * answer HTTP 200 with a 429 JSON-RPC error). More importantly, a recorded
 * blob only proves the decoder agrees with itself about one account; writing
 * each field at a known offset proves it reads the *right* offset, and a
 * single-byte layout slip fails loudly instead of shifting every field at once.
 */

const TOKEN_ACCOUNT_BYTES = 165;

function pubkeyBytes(tag: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[31] = tag; // big-endian: the low byte is last
  return bytes;
}

interface TokenAccountFields {
  mint?: Uint8Array;
  owner?: Uint8Array;
  amount?: bigint;
  state?: number;
}

/** Writes only the four fields we decode; the rest stay zero on purpose. */
function buildTokenAccount(fields: TokenAccountFields = {}): Uint8Array {
  const data = new Uint8Array(TOKEN_ACCOUNT_BYTES);
  data.set(fields.mint ?? pubkeyBytes(1), 0);
  data.set(fields.owner ?? pubkeyBytes(2), 32);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setBigUint64(64, fields.amount ?? 0n, true);
  data[108] = fields.state ?? 1; // initialized
  return data;
}

describe("base58, against the standard test vectors", () => {
  it("encodes the published vectors", () => {
    expect(base58Encode(new Uint8Array([]))).toBe("");
    expect(base58Encode(new Uint8Array([0x00]))).toBe("1");
    expect(base58Encode(new Uint8Array([0x61]))).toBe("2g");
    expect(base58Encode(new Uint8Array([0x62, 0x62, 0x62]))).toBe("a3gV");
    expect(base58Encode(new Uint8Array([0x63, 0x63, 0x63]))).toBe("aPEr");
  });

  it("encodes the all-zero pubkey as the System Program address", () => {
    // The special case that makes leading zero bytes matter: they carry no
    // numeric weight, so without explicit handling this would encode to "".
    const encoded = base58Encode(new Uint8Array(32));
    expect(encoded).toBe(SYSTEM_PROGRAM_ID);
    expect(encoded).toHaveLength(32);
  });

  it("keeps one leading '1' per leading zero byte", () => {
    expect(base58Encode(pubkeyBytes(1))).toBe(`${"1".repeat(31)}2`);
    expect(base58Encode(pubkeyBytes(2))).toBe(`${"1".repeat(31)}3`);
  });

  it("reads a pubkey from an offset without copying neighbouring fields", () => {
    const data = buildTokenAccount({ mint: pubkeyBytes(7), owner: pubkeyBytes(9) });
    expect(readPubkey(data, 0)).toBe(base58Encode(pubkeyBytes(7)));
    expect(readPubkey(data, 32)).toBe(base58Encode(pubkeyBytes(9)));
  });
});

describe("SPL token account layout", () => {
  it("decodes mint, owner, amount and state from their exact offsets", () => {
    const data = buildTokenAccount({
      mint: pubkeyBytes(1),
      owner: pubkeyBytes(2),
      amount: 123_456_789n,
    });
    const result = parseTokenAccount(data, SPL_TOKEN_PROGRAM_ID);

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.account.mint).toBe(base58Encode(pubkeyBytes(1)));
    expect(result.account.owner).toBe(base58Encode(pubkeyBytes(2)));
    expect(result.account.amountBaseUnits).toBe(123_456_789n);
    expect(result.account.state).toBe("initialized");
  });

  it("reads a u64 balance past Number.MAX_SAFE_INTEGER without losing precision", () => {
    // A meme coin with 9 decimals and a 10^12 supply exceeds 2^53 in base
    // units, so a JSON-number path would round this to something else.
    const huge = 18_446_744_073_709_551_615n; // u64 max
    const result = parseTokenAccount(buildTokenAccount({ amount: huge }), SPL_TOKEN_PROGRAM_ID);

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.account.amountBaseUnits).toBe(huge);
    expect(Number(result.account.amountBaseUnits)).not.toBe(huge);
  });

  it("reports a frozen account rather than treating it as ordinary", () => {
    const result = parseTokenAccount(buildTokenAccount({ state: 2 }), SPL_TOKEN_PROGRAM_ID);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.account.state).toBe("frozen");
  });

  it("refuses an uninitialized account, whose fields carry no meaning", () => {
    const result = parseTokenAccount(buildTokenAccount({ state: 0 }), SPL_TOKEN_PROGRAM_ID);
    expect(result.status).toBe("malformed");
  });

  it("refuses an unknown state byte instead of guessing", () => {
    const result = parseTokenAccount(buildTokenAccount({ state: 9 }), SPL_TOKEN_PROGRAM_ID);
    expect(result.status).toBe("malformed");
  });

  it("refuses Token-2022 rather than misreading its extensions", () => {
    const result = parseTokenAccount(buildTokenAccount(), TOKEN_2022_PROGRAM_ID);
    expect(result.status).toBe("unsupported_program");
  });

  it("refuses an account owned by any other program", () => {
    const result = parseTokenAccount(buildTokenAccount(), SYSTEM_PROGRAM_ID);
    expect(result.status).toBe("unsupported_program");
  });

  it("refuses a mint account, which is 82 bytes rather than 165", () => {
    const result = parseTokenAccount(new Uint8Array(82), SPL_TOKEN_PROGRAM_ID);
    expect(result.status).toBe("malformed");
    if (result.status !== "malformed") return;
    expect(result.reason).toContain("165");
  });

  it("decodes correctly when the bytes sit at a non-zero offset in a pooled buffer", () => {
    // Buffer.from() allocates out of a shared pool, so `.buffer` is the whole
    // pool and `byteOffset` is non-zero. A DataView built without the offset
    // would read a neighbouring allocation instead of this account.
    const pooled = Buffer.concat([Buffer.alloc(8, 0xff), Buffer.from(buildTokenAccount({ amount: 42n }))]);
    const view = pooled.subarray(8);
    expect(view.byteOffset).toBeGreaterThan(0);

    const result = parseTokenAccount(view, SPL_TOKEN_PROGRAM_ID);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.account.amountBaseUnits).toBe(42n);
  });
});
