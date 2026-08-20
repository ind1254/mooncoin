import { readPubkey } from "./base58.js";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_ACCOUNT_LEN } from "./mint.js";

/**
 * Decoder for the SPL Token `Account` — a BALANCE, not a token.
 *
 * The distinction matters more than any other in this file. A *mint* is the
 * token itself: supply, decimals, authorities, one account per token. A *token
 * account* holds some quantity of one mint on behalf of one owner, and there
 * are as many of them as there are (holder, token) pairs.
 *
 * So `owner` here is not the program that owns the bytes — that is the SPL
 * Token program, same as for a mint. `owner` is the address permitted to move
 * this balance, and it is the field that tells us whether a large holder is a
 * person's wallet or a liquidity pool.
 *
 * SPL Token Account layout, exactly 165 bytes:
 *
 *   offset  size  field
 *   ------  ----  ---------------------------------------------------------
 *        0    32  mint                        (which token this holds)
 *       32    32  owner                       (who may move it)
 *       64     8  amount, base units          (u64 LE)
 *       72     4  delegate COption tag        (u32 LE)
 *       76    32  delegate pubkey
 *      108     1  state                       (0 uninit, 1 init, 2 frozen)
 *      109     4  isNative COption tag        (u32 LE)
 *      113     8  rent-exempt reserve if native
 *      121     8  delegatedAmount             (u64 LE)
 *      129     4  closeAuthority COption tag  (u32 LE)
 *      133    32  closeAuthority pubkey
 *
 * We read four of those fields. The rest are decoded by nobody here on
 * purpose: unused fields are unverified fields, and pretending otherwise
 * invites someone to trust a number we never checked.
 */

const OFFSET = {
  mint: 0,
  owner: 32,
  amount: 64,
  state: 108,
} as const;

/** AccountState discriminant at offset 108. */
export type TokenAccountState = "uninitialized" | "initialized" | "frozen";

export interface TokenAccount {
  /** The mint this balance belongs to. Checked against the mint we asked for. */
  mint: string;
  /** Address allowed to move this balance — a wallet or a program-derived address. */
  owner: string;
  amountBaseUnits: bigint;
  state: TokenAccountState;
}

export type TokenAccountParseResult =
  | { status: "found"; account: TokenAccount }
  | { status: "unsupported_program"; owner: string; reason: string }
  | { status: "malformed"; reason: string };

const STATES: Record<number, TokenAccountState> = {
  0: "uninitialized",
  1: "initialized",
  2: "frozen",
};

/**
 * Decode token-account bytes. Pure: no network, no clock, no throwing for
 * expected cases.
 *
 * `programOwner` is the account's on-chain owner field — the program that
 * defines these bytes. Checking it is what stops us from reading an arbitrary
 * account as a balance.
 */
export function parseTokenAccount(data: Uint8Array, programOwner: string): TokenAccountParseResult {
  if (programOwner === TOKEN_2022_PROGRAM_ID) {
    return {
      status: "unsupported_program",
      owner: programOwner,
      reason:
        "Token-2022 account. Its first 165 bytes match the classic layout but extensions follow; " +
        "decoding those is not implemented, and a wrong parse is worse than an honest refusal.",
    };
  }
  if (programOwner !== SPL_TOKEN_PROGRAM_ID) {
    return {
      status: "unsupported_program",
      owner: programOwner,
      reason: `Account is owned by ${programOwner}, not the SPL Token program, so it is not a token account.`,
    };
  }

  if (data.byteLength !== TOKEN_ACCOUNT_LEN) {
    return {
      status: "malformed",
      reason: `Expected ${TOKEN_ACCOUNT_LEN} bytes for a token account, got ${data.byteLength}.`,
    };
  }

  // Buffer.from() carves small allocations out of a shared pool, so `.buffer`
  // is the whole pool. The offset and length are mandatory, not optional.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const state = STATES[view.getUint8(OFFSET.state)];
  if (state === undefined) {
    return {
      status: "malformed",
      reason: `Token account state byte held ${view.getUint8(OFFSET.state)}, which is not a valid AccountState.`,
    };
  }
  if (state === "uninitialized") {
    return {
      status: "malformed",
      reason: "Token account is allocated but not initialized; its fields carry no meaning.",
    };
  }

  return {
    status: "found",
    account: {
      mint: readPubkey(data, OFFSET.mint),
      owner: readPubkey(data, OFFSET.owner),
      // u64 read as BigInt: meme-coin balances routinely exceed 2^53.
      amountBaseUnits: view.getBigUint64(OFFSET.amount, true),
      state,
    },
  };
}
