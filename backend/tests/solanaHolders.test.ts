import { describe, expect, it } from "vitest";
import { ArbError } from "../src/core/errors.js";
import { base58Encode } from "../src/market/solana/base58.js";
import { SYSTEM_PROGRAM_ID, readHolderConcentration } from "../src/market/solana/holders.js";
import { SPL_TOKEN_PROGRAM_ID } from "../src/market/solana/mint.js";
import { SolanaRpcClient } from "../src/market/solana/rpc.js";

/**
 * Holder classification, driven through a real SolanaRpcClient whose transport
 * is canned. Going through the client rather than a hand-rolled stub means
 * these tests also cover envelope validation, u64-as-string parsing, and the
 * positional contract of getMultipleAccounts.
 */

function pubkeyBytes(tag: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[31] = tag;
  return bytes;
}
const addressOf = (tag: number): string => base58Encode(pubkeyBytes(tag));

const MINT = addressOf(1);
const OTHER_MINT = addressOf(2);
/** Stand-in for an AMM program: any owner that is not the System Program. */
const POOL_PROGRAM = addressOf(3);

const WALLET_A = addressOf(10);
const WALLET_B = addressOf(11);
const POOL_VAULT_AUTHORITY = addressOf(12);
const GHOST = addressOf(13); // owns tokens but has no account of its own

function tokenAccountData(owner: string, amount: bigint, mint = MINT): string {
  const data = new Uint8Array(165);
  // Reuse the encoder to place pubkeys, mirroring how the chain stores them.
  const decodeTag = (address: string): Uint8Array => {
    for (let tag = 0; tag < 256; tag += 1) {
      if (base58Encode(pubkeyBytes(tag)) === address) return pubkeyBytes(tag);
    }
    throw new Error(`no single-byte pubkey encodes to ${address}`);
  };
  data.set(decodeTag(mint), 0);
  data.set(decodeTag(owner), 32);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setBigUint64(64, amount, true);
  data[108] = 1; // initialized
  return Buffer.from(data).toString("base64");
}

interface AccountValue {
  data: [string, "base64"];
  owner: string;
  lamports: number;
  executable: boolean;
}

const account = (dataB64: string, owner: string): AccountValue => ({
  data: [dataB64, "base64"],
  owner,
  lamports: 2_039_280,
  executable: false,
});

/** An owner account holds no data we read; only its program owner matters. */
const ownerAccount = (programOwner: string): AccountValue =>
  account(Buffer.from(new Uint8Array(0)).toString("base64"), programOwner);

interface Scenario {
  /** Token accounts returned by getTokenLargestAccounts, largest first. */
  largest: { address: string; amount: string }[];
  /** Address -> account, for both getMultipleAccounts calls. Missing = null. */
  accounts: Record<string, AccountValue>;
}

function clientFor(scenario: Scenario): SolanaRpcClient {
  return new SolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      let result: unknown;

      if (body.method === "getTokenLargestAccounts") {
        result = { context: { slot: 1 }, value: scenario.largest };
      } else if (body.method === "getMultipleAccounts") {
        const addresses = body.params[0] as string[];
        result = {
          context: { slot: 1 },
          value: addresses.map((address) => scenario.accounts[address] ?? null),
        };
      } else {
        throw new Error(`unexpected RPC method ${body.method}`);
      }

      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

describe("on-chain holder concentration", () => {
  it("excludes pool-held supply, which is tradable rather than concentrated", async () => {
    // The failure this whole module exists to prevent: 60% of supply sits in a
    // pool vault. Counting it as a holder would report severe concentration
    // for a token whose supply is, in fact, liquid.
    const vault = addressOf(20);
    const walletA = addressOf(21);
    const walletB = addressOf(22);

    const result = await readHolderConcentration(
      clientFor({
        largest: [
          { address: vault, amount: "600" },
          { address: walletA, amount: "100" },
          { address: walletB, amount: "50" },
        ],
        accounts: {
          [vault]: account(tokenAccountData(POOL_VAULT_AUTHORITY, 600n), SPL_TOKEN_PROGRAM_ID),
          [walletA]: account(tokenAccountData(WALLET_A, 100n), SPL_TOKEN_PROGRAM_ID),
          [walletB]: account(tokenAccountData(WALLET_B, 50n), SPL_TOKEN_PROGRAM_ID),
          [POOL_VAULT_AUTHORITY]: ownerAccount(POOL_PROGRAM),
          [WALLET_A]: ownerAccount(SYSTEM_PROGRAM_ID),
          [WALLET_B]: ownerAccount(SYSTEM_PROGRAM_ID),
        },
      }),
      MINT,
      1000n,
    );

    expect(result.concentrationBps).toBe(1500n); // 150/1000, wallets only
    expect(result.programHeldBps).toBe(6000n); // reported, not counted as risk
    expect(result.walletHolderCount).toBe(2);
    expect(result.complete).toBe(true);
  });

  it("aggregates several token accounts belonging to one owner", async () => {
    // Splitting a balance across token accounts must not look like two
    // holders; that would understate concentration exactly where it matters.
    const first = addressOf(23);
    const second = addressOf(24);

    const result = await readHolderConcentration(
      clientFor({
        largest: [
          { address: first, amount: "100" },
          { address: second, amount: "200" },
        ],
        accounts: {
          [first]: account(tokenAccountData(WALLET_A, 100n), SPL_TOKEN_PROGRAM_ID),
          [second]: account(tokenAccountData(WALLET_A, 200n), SPL_TOKEN_PROGRAM_ID),
          [WALLET_A]: ownerAccount(SYSTEM_PROGRAM_ID),
        },
      }),
      MINT,
      1000n,
    );

    expect(result.walletHolderCount).toBe(1);
    expect(result.concentrationBps).toBe(3000n);
  });

  it("marks an owner with no on-chain account as unclassified, not as a wallet", async () => {
    const ta = addressOf(25);

    const result = await readHolderConcentration(
      clientFor({
        largest: [{ address: ta, amount: "400" }],
        accounts: {
          [ta]: account(tokenAccountData(GHOST, 400n), SPL_TOKEN_PROGRAM_ID),
          // GHOST itself is absent: no lamports, never written to.
        },
      }),
      MINT,
      1000n,
    );

    expect(result.concentrationBps).toBe(0n);
    expect(result.unclassifiedBps).toBe(4000n);
    expect(result.complete).toBe(false);
    expect(result.topHolders[0]?.kind).toBe("unknown");
  });

  it("refuses a token account that belongs to a different mint", async () => {
    // Guards against a node pairing responses wrongly: attributing another
    // token's balance here would invent concentration out of nothing.
    const ta = addressOf(26);

    const result = await readHolderConcentration(
      clientFor({
        largest: [{ address: ta, amount: "900" }],
        accounts: {
          [ta]: account(tokenAccountData(WALLET_A, 900n, OTHER_MINT), SPL_TOKEN_PROGRAM_ID),
          [WALLET_A]: ownerAccount(SYSTEM_PROGRAM_ID),
        },
      }),
      MINT,
      1000n,
    );

    expect(result.concentrationBps).toBe(0n);
    expect(result.unclassifiedBps).toBe(9000n);
    expect(result.complete).toBe(false);
  });

  it("rounds concentration up, so the warning is never understated", async () => {
    const ta = addressOf(27);

    const result = await readHolderConcentration(
      clientFor({
        largest: [{ address: ta, amount: "1" }],
        accounts: {
          [ta]: account(tokenAccountData(WALLET_A, 1n), SPL_TOKEN_PROGRAM_ID),
          [WALLET_A]: ownerAccount(SYSTEM_PROGRAM_ID),
        },
      }),
      MINT,
      3n,
    );

    // 1/3 = 3333.33… bps. Truncating would report less risk than exists.
    expect(result.concentrationBps).toBe(3334n);
  });

  it("returns an empty, complete result for a mint with no funded accounts", async () => {
    const result = await readHolderConcentration(
      clientFor({ largest: [], accounts: {} }),
      MINT,
      1000n,
    );

    expect(result.concentrationBps).toBe(0n);
    expect(result.complete).toBe(true);
    expect(result.topHolders).toEqual([]);
  });

  it("propagates a rate limit instead of reporting zero concentration", async () => {
    // Silently returning 0% here would turn a throttled endpoint into a
    // "no concentration risk" all-clear.
    const client = new SolanaRpcClient({
      fetchImpl: async () => new Response("{}", { status: 429 }),
    });

    await expect(readHolderConcentration(client, MINT, 1000n)).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
    });
  });

  it("rejects a node that returns a different number of accounts than requested", async () => {
    const ta = addressOf(28);
    const client = new SolanaRpcClient({
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        const result =
          body.method === "getTokenLargestAccounts"
            ? { context: { slot: 1 }, value: [{ address: ta, amount: "10" }] }
            : { context: { slot: 1 }, value: [] }; // wrong length
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      },
    });

    await expect(readHolderConcentration(client, MINT, 1000n)).rejects.toBeInstanceOf(ArbError);
  });
});
