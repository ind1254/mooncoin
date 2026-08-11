import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MINT_ACCOUNT_LEN,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  parseMintAccount,
  readMintAccount,
  type MintAccount,
  type MintParseResult,
  type MintReadResult,
} from "../src/market/solana/mint.js";
import { SolanaRpcClient } from "../src/market/solana/rpc.js";

/**
 * Offline tests against fixtures recorded from Solana mainnet.
 * Re-record with: node scripts/refresh-solana-fixtures.mjs
 */

interface Fixture {
  _address: string;
  response: { result?: { value: { data: [string, "base64"]; owner: string } | null } };
}

function fixture(name: string): Fixture {
  const path = fileURLToPath(new URL(`./fixtures/solana/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

/** Decode a recorded fixture straight into the pure parser. */
function parseFixture(name: string): MintParseResult {
  const value = fixture(name).response.result?.value;
  if (!value) throw new Error(`fixture ${name} has no account value`);
  return parseMintAccount(Buffer.from(value.data[0], "base64"), value.owner);
}

function expectFound(result: MintParseResult | MintReadResult): MintAccount {
  if (result.status !== "found") {
    throw new Error(`expected a decoded mint, got "${result.status}"`);
  }
  return result.mint;
}

/** A client whose transport is a canned response — never touches the network. */
function clientReturning(body: unknown, status = 200): SolanaRpcClient {
  return new SolanaRpcClient({
    fetchImpl: async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  });
}

describe("SPL mint layout, decoded from recorded mainnet accounts", () => {
  it("reads BONK: authorities renounced, 5 decimals", () => {
    const mint = expectFound(parseFixture("bonk-mint"));
    expect(mint.decimals).toBe(5);
    expect(mint.mintAuthorityPresent).toBe(false);
    expect(mint.freezeAuthorityPresent).toBe(false);
    expect(mint.supplyBaseUnits).toBe(8_799_458_985_811_850_190n);
    expect(mint.program).toBe("spl-token");
  });

  it("reads WIF: authorities renounced, 6 decimals", () => {
    const mint = expectFound(parseFixture("wif-mint"));
    expect(mint.decimals).toBe(6);
    expect(mint.mintAuthorityPresent).toBe(false);
    expect(mint.freezeAuthorityPresent).toBe(false);
    expect(mint.supplyBaseUnits).toBe(998_838_864_058_972n);
  });

  it("reads USDC: both authorities still held — present is not the same as malicious", () => {
    const mint = expectFound(parseFixture("usdc-mint"));
    expect(mint.decimals).toBe(6);
    // Circle mints on demand and can freeze for legal compliance. A live
    // authority is a risk *input*, not a verdict.
    expect(mint.mintAuthorityPresent).toBe(true);
    expect(mint.freezeAuthorityPresent).toBe(true);
  });

  it("supply is exact beyond the float-safe range", () => {
    const bonk = expectFound(parseFixture("bonk-mint"));
    expect(bonk.supplyBaseUnits > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    // Proof that a float parse would have silently corrupted this value.
    expect(BigInt(Number(bonk.supplyBaseUnits))).not.toBe(bonk.supplyBaseUnits);
    // 8.799e18 base units / 10^5 decimals ≈ 88 trillion whole BONK.
    expect(bonk.supplyBaseUnits / 10n ** BigInt(bonk.decimals)).toBe(87_994_589_858_118n);
  });

  it("refuses a Token-2022 mint instead of guessing its extensions", () => {
    const result = parseFixture("token2022-mint");
    expect(result.status).toBe("unsupported_program");
    if (result.status !== "unsupported_program") return;
    expect(result.owner).toBe(TOKEN_2022_PROGRAM_ID);
    expect(result.reason).toMatch(/Token-2022/);
  });

  it("refuses an account owned by another program", () => {
    const result = parseFixture("program-account");
    expect(result.status).toBe("unsupported_program");
    if (result.status !== "unsupported_program") return;
    expect(result.owner).toMatch(/^BPFLoader/);
  });
});

describe("guard clauses (synthetic byte arrays, not recorded chain data)", () => {
  /** Build a structurally valid 82-byte mint so each guard can be isolated. */
  function syntheticMint(): Buffer {
    const buf = Buffer.alloc(MINT_ACCOUNT_LEN);
    buf.writeUInt32LE(0, 0); // mintAuthority: None
    buf.writeBigUInt64LE(1_000_000n, 36);
    buf.writeUInt8(6, 44); // decimals
    buf.writeUInt8(1, 45); // isInitialized
    buf.writeUInt32LE(0, 46); // freezeAuthority: None
    return buf;
  }

  it("the synthetic baseline parses, so later failures isolate one mutation", () => {
    const mint = expectFound(parseMintAccount(syntheticMint(), SPL_TOKEN_PROGRAM_ID));
    expect(mint.decimals).toBe(6);
    expect(mint.supplyBaseUnits).toBe(1_000_000n);
  });

  it("rejects a 165-byte token account owned by the same program", () => {
    const result = parseMintAccount(Buffer.alloc(165), SPL_TOKEN_PROGRAM_ID);
    expect(result.status).toBe("malformed");
    if (result.status !== "malformed") return;
    expect(result.reason).toMatch(/token account/i);
  });

  it("rejects a truncated account", () => {
    expect(parseMintAccount(Buffer.alloc(81), SPL_TOKEN_PROGRAM_ID).status).toBe("malformed");
  });

  it("rejects a COption tag that is neither None nor Some", () => {
    const buf = syntheticMint();
    buf.writeUInt32LE(2, 0);
    const result = parseMintAccount(buf, SPL_TOKEN_PROGRAM_ID);
    expect(result.status).toBe("malformed");
    if (result.status !== "malformed") return;
    expect(result.reason).toMatch(/mintAuthority COption tag/);
  });

  it("rejects an uninitialized mint", () => {
    const buf = syntheticMint();
    buf.writeUInt8(0, 45);
    const result = parseMintAccount(buf, SPL_TOKEN_PROGRAM_ID);
    expect(result.status).toBe("malformed");
    if (result.status !== "malformed") return;
    expect(result.reason).toMatch(/not initialized/);
  });

  it("reads little-endian, not big-endian", () => {
    const buf = syntheticMint();
    buf.writeUInt8(0, 44);
    buf.writeUInt32LE(1, 0); // Some, LE. Read big-endian this would be 16777216.
    const mint = expectFound(parseMintAccount(buf, SPL_TOKEN_PROGRAM_ID));
    expect(mint.mintAuthorityPresent).toBe(true);
  });

  it("honours byteOffset when the bytes are a view into a larger buffer", () => {
    // Regression guard: Buffer.from() pools small allocations, so a DataView
    // built without byteOffset/byteLength would read the wrong memory.
    const padded = Buffer.concat([Buffer.alloc(64, 0xff), syntheticMint(), Buffer.alloc(64, 0xff)]);
    const view = padded.subarray(64, 64 + MINT_ACCOUNT_LEN);
    expect(view.byteOffset).toBeGreaterThan(0);
    const mint = expectFound(parseMintAccount(view, SPL_TOKEN_PROGRAM_ID));
    expect(mint.decimals).toBe(6);
    expect(mint.supplyBaseUnits).toBe(1_000_000n);
  });
});

describe("RPC client (offline, canned transport)", () => {
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

  it("decodes a recorded response end to end", async () => {
    const client = clientReturning(fixture("bonk-mint").response);
    const mint = expectFound(await readMintAccount(client, BONK));
    expect(mint.decimals).toBe(5);
  });

  it("reports a missing account as not_found rather than throwing", async () => {
    const client = clientReturning(fixture("missing-account").response);
    const result = await readMintAccount(client, "FLooFDemo1111111111111111111111111111111111");
    expect(result.status).toBe("not_found");
  });

  it("sends a well-formed getAccountInfo request", async () => {
    let captured: Record<string, unknown> = {};
    const client = new SolanaRpcClient({
      commitment: "finalized",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(fixture("bonk-mint").response), { status: 200 });
      },
    });
    await readMintAccount(client, BONK);
    expect(captured.method).toBe("getAccountInfo");
    expect(captured.jsonrpc).toBe("2.0");
    expect(captured.params).toEqual([BONK, { encoding: "base64", commitment: "finalized" }]);
  });

  it("rejects a malformed address before making a request", async () => {
    let called = false;
    const client = new SolanaRpcClient({
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    // '0', 'O', 'I' and 'l' are not in the base58 alphabet.
    await expect(readMintAccount(client, "0OIl-not-an-address")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(called).toBe(false);
  });

  it("maps a 429 to a dedicated rate-limit error", async () => {
    const client = clientReturning({}, 429);
    await expect(readMintAccount(client, BONK)).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
    });
  });

  it("maps other HTTP failures to a provider error", async () => {
    const client = clientReturning({}, 500);
    await expect(readMintAccount(client, BONK)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("surfaces a JSON-RPC error object", async () => {
    const client = clientReturning({
      jsonrpc: "2.0",
      error: { code: -32602, message: "Invalid param" },
    });
    await expect(readMintAccount(client, BONK)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("rejects an unrecognized response envelope", async () => {
    const client = clientReturning({ unexpected: true });
    await expect(readMintAccount(client, BONK)).rejects.toMatchObject({
      code: "MALFORMED_PROVIDER_RESPONSE",
    });
  });

  it("rejects a response body that is not JSON", async () => {
    const client = clientReturning("<html>rate limited</html>");
    await expect(readMintAccount(client, BONK)).rejects.toMatchObject({
      code: "MALFORMED_PROVIDER_RESPONSE",
    });
  });
});
