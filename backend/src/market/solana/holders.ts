import { parseTokenAccount } from "./tokenAccount.js";
import type { SolanaRpcClient } from "./rpc.js";

/**
 * Holder concentration, measured on-chain instead of taken on trust.
 *
 * The naive version of this metric — sum the top ten balances, divide by
 * supply — is wrong for almost every token this app shows, and wrong in the
 * dangerous direction. The largest holders of a meme coin are usually not
 * people:
 *
 *   - the bonding curve that minted it (pump.fun and friends)
 *   - AMM pool vaults holding one side of the pair
 *   - exchange omnibus wallets
 *
 * Supply parked in a liquidity pool is supply that anyone can trade against.
 * Counting it as "one holder owns 62%" reports the *opposite* of the truth: a
 * deep pool becomes a rug warning, and users learn to ignore the warning.
 *
 * The fix is another chain read rather than a heuristic. Every token account
 * names an `owner`, and every owner address is itself an account with its own
 * program owner. An address owned by the System Program is a plain keypair
 * wallet. An address owned by anything else is program-derived — a pool, a
 * curve, a protocol vault — and cannot be a person.
 *
 * Cost is three RPC calls regardless of holder count:
 *   1. getTokenLargestAccounts  → up to 20 token accounts + balances
 *   2. getMultipleAccounts      → decode each to learn its owner
 *   3. getMultipleAccounts      → classify each owner as wallet or program
 */

/** Owner of every ordinary keypair account. All-zero pubkey, hence the ones. */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** How many wallet holders the headline concentration figure covers. */
export const CONCENTRATION_HOLDER_COUNT = 10;

const BPS_SCALE = 10_000n;

export type HolderKind = "wallet" | "program" | "unknown";

export interface ClassifiedHolder {
  /** Address that controls the balance, not the token account address. */
  owner: string;
  /** Aggregated across every token account this owner holds for the mint. */
  amountBaseUnits: bigint;
  kind: HolderKind;
  /** Program owning the holder's own account, when that account exists. */
  ownerProgram?: string;
}

export interface HolderConcentration {
  /** Top wallet holders' combined share of supply, bps. Excludes pools. */
  concentrationBps: bigint;
  /** Share held by program-controlled accounts (pools, curves), bps. */
  programHeldBps: bigint;
  /** Distinct wallet owners counted in `concentrationBps`. */
  walletHolderCount: number;
  /** Share we could not attribute either way, bps. Non-zero means incomplete. */
  unclassifiedBps: bigint;
  /** False when any top holder resisted classification. */
  complete: boolean;
  /** Every top holder we resolved, largest first. */
  topHolders: ClassifiedHolder[];
}

/**
 * Share of supply, in basis points, rounded UP.
 *
 * Truncating would understate concentration, and this number exists to warn
 * people. Everywhere else in this codebase costs round against the user; here
 * the equivalent choice is to round against the token.
 */
function shareBps(amountBaseUnits: bigint, supplyBaseUnits: bigint): bigint {
  if (supplyBaseUnits <= 0n || amountBaseUnits <= 0n) return 0n;
  const ceiling = (amountBaseUnits * BPS_SCALE + supplyBaseUnits - 1n) / supplyBaseUnits;
  // Balances and supply can be read at different slots, so a sum can briefly
  // exceed supply. Clamp rather than emit an impossible percentage.
  return ceiling > BPS_SCALE ? BPS_SCALE : ceiling;
}

/**
 * Read and classify the largest holders of `mint`.
 *
 * Throws only on transport failure, propagated from the RPC client, so callers
 * can degrade to "we could not verify this" exactly as the mint path does.
 */
export async function readHolderConcentration(
  client: SolanaRpcClient,
  mint: string,
  supplyBaseUnits: bigint,
  signal?: AbortSignal,
): Promise<HolderConcentration> {
  const empty: HolderConcentration = {
    concentrationBps: 0n,
    programHeldBps: 0n,
    walletHolderCount: 0,
    unclassifiedBps: 0n,
    complete: true,
    topHolders: [],
  };

  const largest = await client.getTokenLargestAccounts(mint, signal);
  const funded = largest.filter((entry) => entry.amountBaseUnits > 0n);
  if (funded.length === 0 || supplyBaseUnits <= 0n) return empty;

  // Step 2: token account -> owner. We deliberately keep the balances from
  // step 1 rather than the ones decoded here: step 1 is a single consistent
  // snapshot at one slot, whereas mixing in balances from a later slot would
  // let the parts disagree with the whole. Ownership is effectively static, so
  // reading it a slot later is safe in a way that reading balances is not.
  const accounts = await client.getMultipleAccounts(
    funded.map((entry) => entry.address),
    signal,
  );

  let unclassifiedAmount = 0n;
  const byOwner = new Map<string, bigint>();

  accounts.forEach((account, index) => {
    const entry = funded[index]!;
    if (account === null) {
      unclassifiedAmount += entry.amountBaseUnits;
      return;
    }
    const parsed = parseTokenAccount(account.data, account.owner);
    // A token account for a different mint means the node paired responses
    // wrongly. Refuse the entry rather than attribute someone else's balance.
    if (parsed.status !== "found" || parsed.account.mint !== mint) {
      unclassifiedAmount += entry.amountBaseUnits;
      return;
    }
    // One entity can hold many token accounts for the same mint; treating each
    // as a separate holder would understate concentration.
    const owner = parsed.account.owner;
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + entry.amountBaseUnits);
  });

  if (byOwner.size === 0) {
    return {
      ...empty,
      unclassifiedBps: shareBps(unclassifiedAmount, supplyBaseUnits),
      complete: unclassifiedAmount === 0n,
    };
  }

  // Step 3: owner -> wallet or program.
  const owners = [...byOwner.keys()];
  const ownerAccounts = await client.getMultipleAccounts(owners, signal);

  const holders: ClassifiedHolder[] = owners.map((owner, index) => {
    const amountBaseUnits = byOwner.get(owner)!;
    const ownerAccount = ownerAccounts[index] ?? null;

    // An address with no account holds no SOL and has never been written to.
    // It is probably a dormant wallet, but "probably" is not evidence.
    if (ownerAccount === null) {
      return { owner, amountBaseUnits, kind: "unknown" as const };
    }
    const kind: HolderKind = ownerAccount.owner === SYSTEM_PROGRAM_ID ? "wallet" : "program";
    return { owner, amountBaseUnits, kind, ownerProgram: ownerAccount.owner };
  });

  holders.sort((a, b) => (b.amountBaseUnits > a.amountBaseUnits ? 1 : -1));

  const walletHolders = holders
    .filter((holder) => holder.kind === "wallet")
    .slice(0, CONCENTRATION_HOLDER_COUNT);

  const sum = (list: ClassifiedHolder[]): bigint =>
    list.reduce((total, holder) => total + holder.amountBaseUnits, 0n);

  const unknownAmount =
    unclassifiedAmount + sum(holders.filter((holder) => holder.kind === "unknown"));

  return {
    concentrationBps: shareBps(sum(walletHolders), supplyBaseUnits),
    programHeldBps: shareBps(sum(holders.filter((h) => h.kind === "program")), supplyBaseUnits),
    walletHolderCount: walletHolders.length,
    unclassifiedBps: shareBps(unknownAmount, supplyBaseUnits),
    complete: unknownAmount === 0n,
    topHolders: holders,
  };
}
