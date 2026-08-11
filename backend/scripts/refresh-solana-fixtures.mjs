/**
 * Refresh recorded mainnet fixtures used by the Solana mint-reader tests.
 *
 * Run MANUALLY (never in CI):   node scripts/refresh-solana-fixtures.mjs
 *
 * Tests must stay offline and deterministic, so they read the committed JSON
 * in tests/fixtures/solana/ instead of calling the network. This script is how
 * that recorded data gets created and re-verified when it drifts.
 *
 * Everything fetched here is public, read-only chain state. No keys involved.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "solana");

/** Addresses chosen to cover every branch the parser has to handle. */
const ACCOUNTS = [
  ["bonk-mint", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "classic mint, meme coin"],
  ["wif-mint", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "classic mint, meme coin"],
  ["usdc-mint", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "classic mint, authority PRESENT"],
  ["missing-account", "FLooFDemo1111111111111111111111111111111111", "valid base58, no such account"],
  ["program-account", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "owned by a loader, not a mint"],
  ["token2022-mint", "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "expected Token-2022 (PYUSD)"],
];

async function rpc(method, params) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  return res.json();
}

const getAccountInfo = (address) =>
  rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);

function summarize(name, body) {
  const value = body?.result?.value;
  if (!value) return `${name}: account not found`;
  const raw = Buffer.from(value.data[0], "base64");
  return `${name}: owner=${value.owner.slice(0, 12)}… bytes=${raw.length} lamports=${value.lamports}`;
}

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, address, note] of ACCOUNTS) {
  try {
    const body = await getAccountInfo(address);
    writeFileSync(
      join(OUT_DIR, `${name}.json`),
      JSON.stringify({ _address: address, _note: note, _recordedAt: new Date().toISOString(), response: body }, null, 2),
    );
    console.log(summarize(name, body));
  } catch (err) {
    console.error(`${name}: FAILED — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 350)); // stay under public-endpoint rate limits
}

// NOT recorded: a real 165-byte token account.
//
// Getting one means calling getTokenLargestAccounts, which the public endpoint
// throttles hard — it returned HTTP 429 through four exponential backoffs. So
// the parser's wrong-length guard is covered by an explicitly synthetic buffer
// in the tests instead, and this is left documented rather than faked.
//
// This also settles a question for a later step: holder concentration needs
// exactly this method, so that field is not viable on the public endpoint and
// will require a keyed provider.
console.log("token-account: skipped (getTokenLargestAccounts is rate-limited on the public endpoint)");
