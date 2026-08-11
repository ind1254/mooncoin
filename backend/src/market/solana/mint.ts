import type { SolanaRpcClient } from "./rpc.js";

/**
 * Decoder for the classic SPL Token `Mint` account.
 *
 * Solana accounts are untyped byte arrays; the *owning program* defines how to
 * interpret them. So the owner check below is a correctness requirement, not a
 * nicety — parsing an arbitrary account as a mint yields plausible garbage.
 *
 * SPL Token Mint layout, exactly 82 bytes:
 *
 *   offset  size  field
 *   ------  ----  ---------------------------------------------------------
 *        0     4  mintAuthority COption tag   (u32 LE: 0 = None, 1 = Some)
 *        4    32  mintAuthority pubkey        (meaningless when tag = 0)
 *       36     8  supply, in base units       (u64 LE)
 *       44     1  decimals                    (u8)
 *       45     1  isInitialized               (bool)
 *       46     4  freezeAuthority COption tag (u32 LE)
 *       50    32  freezeAuthority pubkey      (meaningless when tag = 0)
 *
 * COption is Rust's Option<Pubkey> serialized at fixed width: the account was
 * allocated at a fixed size, so the 32 pubkey bytes are always physically
 * present and must simply be ignored when the tag is 0.
 *
 * The tags are the risk signal. Tag 0 on mintAuthority means no new supply can
 * ever be minted; tag 0 on freezeAuthority means nobody can freeze balances.
 * Both transitions are one-way — an authority can be set to None, never back.
 */

export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** A classic SPL Token mint is exactly this long. A token account is 165. */
export const MINT_ACCOUNT_LEN = 82;
export const TOKEN_ACCOUNT_LEN = 165;

const OFFSET = {
  mintAuthorityTag: 0,
  supply: 36,
  decimals: 44,
  isInitialized: 45,
  freezeAuthorityTag: 46,
} as const;

export interface MintAccount {
  /** Scaling factor for every raw amount of this token: 1 whole = 10^decimals base units. */
  decimals: number;
  /** Total supply in BASE UNITS, not whole tokens. Exceeds Number.MAX_SAFE_INTEGER in practice. */
  supplyBaseUnits: bigint;
  /** True when someone can still mint new supply (COption tag = 1). */
  mintAuthorityPresent: boolean;
  /** True when someone can still freeze token accounts (COption tag = 1). */
  freezeAuthorityPresent: boolean;
  program: "spl-token";
}

export type MintParseResult =
  | { status: "found"; mint: MintAccount }
  | { status: "unsupported_program"; owner: string; reason: string }
  | { status: "malformed"; reason: string };

export type MintReadResult = MintParseResult | { status: "not_found" };

/** Read a COption discriminant. Must be exactly 0 (None) or 1 (Some). */
function readCOptionTag(view: DataView, offset: number): 0 | 1 | null {
  const tag = view.getUint32(offset, true); // little-endian
  return tag === 0 || tag === 1 ? tag : null;
}

/**
 * Decode mint bytes. Pure: no network, no clock, no throwing for expected cases.
 */
export function parseMintAccount(data: Uint8Array, owner: string): MintParseResult {
  if (owner === TOKEN_2022_PROGRAM_ID) {
    return {
      status: "unsupported_program",
      owner,
      reason:
        "Token-2022 mint. Its first 82 bytes match the classic layout but extensions follow; " +
        "decoding those is not implemented, and a wrong parse is worse than an honest refusal.",
    };
  }
  if (owner !== SPL_TOKEN_PROGRAM_ID) {
    return {
      status: "unsupported_program",
      owner,
      reason: `Account is owned by ${owner}, not the SPL Token program, so it is not a mint.`,
    };
  }

  if (data.byteLength !== MINT_ACCOUNT_LEN) {
    const hint =
      data.byteLength === TOKEN_ACCOUNT_LEN
        ? " That is the size of an SPL token account (a balance), not a mint."
        : "";
    return {
      status: "malformed",
      reason: `Expected ${MINT_ACCOUNT_LEN} bytes for a mint, got ${data.byteLength}.${hint}`,
    };
  }

  // Buffer.from() carves small allocations out of a shared pool, so `.buffer`
  // is the whole pool. The offset and length are mandatory, not optional.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const mintTag = readCOptionTag(view, OFFSET.mintAuthorityTag);
  if (mintTag === null) {
    return { status: "malformed", reason: "mintAuthority COption tag was neither 0 nor 1." };
  }
  const freezeTag = readCOptionTag(view, OFFSET.freezeAuthorityTag);
  if (freezeTag === null) {
    return { status: "malformed", reason: "freezeAuthority COption tag was neither 0 nor 1." };
  }

  const isInitialized = view.getUint8(OFFSET.isInitialized);
  if (isInitialized !== 1) {
    return {
      status: "malformed",
      reason:
        isInitialized === 0
          ? "Mint account is allocated but not initialized; its fields carry no meaning."
          : `isInitialized held ${isInitialized}, which is not a valid bool.`,
    };
  }

  return {
    status: "found",
    mint: {
      decimals: view.getUint8(OFFSET.decimals),
      // u64 must be read as BigInt: real supplies (BONK ~8.8e18) are far past
      // Number.MAX_SAFE_INTEGER (~9.0e15) and would lose precision silently.
      supplyBaseUnits: view.getBigUint64(OFFSET.supply, true),
      mintAuthorityPresent: mintTag === 1,
      freezeAuthorityPresent: freezeTag === 1,
      program: "spl-token",
    },
  };
}

/** Fetch and decode one mint. Throws only on transport failure. */
export async function readMintAccount(
  client: SolanaRpcClient,
  mintAddress: string,
  signal?: AbortSignal,
): Promise<MintReadResult> {
  const result = await client.getAccountInfo(mintAddress, signal);
  if (result.status === "not_found") return { status: "not_found" };
  return parseMintAccount(result.account.data, result.account.owner);
}
