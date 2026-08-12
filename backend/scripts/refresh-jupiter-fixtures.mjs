/**
 * Refresh recorded Jupiter token-search fixtures used by the discovery tests.
 *
 * Run MANUALLY (never in CI):  node scripts/refresh-jupiter-fixtures.mjs
 *
 * Read-only public market data. No API key, no account, no signing.
 *
 * Drift note: these fixtures contain live market values (price, liquidity,
 * volume) that change constantly. Tests must therefore assert on SHAPE and
 * on stable identity fields (mint, decimals, tokenProgram, symbol), never on
 * price or liquidity numbers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.JUPITER_TOKENS_URL ?? "https://lite-api.jup.ag/tokens/v2";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "jupiter");

const QUERIES = [
  ["search-bonk", "BONK", "ticker query; several distinct mints share this symbol"],
  ["search-usdc-mint", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "mint query resolves to exactly one token"],
  ["search-empty", "zzzqqqxxnotarealtoken", "no matches"],
];

const QUOTE_BASE = process.env.JUPITER_QUOTE_URL ?? "https://lite-api.jup.ag/swap/v1";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/** Read-only quotes. This script never touches /swap, which builds transactions. */
const QUOTES = [
  ["quote-usdc-bonk", `${QUOTE_BASE}/quote?inputMint=${USDC}&outputMint=${BONK}&amount=100000000&slippageBps=50`, "buy 100 USDC of BONK"],
  ["quote-bonk-usdc", `${QUOTE_BASE}/quote?inputMint=${BONK}&outputMint=${USDC}&amount=1000000000&slippageBps=50`, "sell 10,000 BONK"],
];

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, query, note] of QUERIES) {
  const url = `${BASE}/search?query=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    writeFileSync(
      join(OUT_DIR, `${name}.json`),
      JSON.stringify({ _query: query, _note: note, _recordedAt: new Date().toISOString(), response: body }, null, 2),
    );
    console.log(`${name}: ${body.length} result(s)`);
  } catch (err) {
    console.error(`${name}: FAILED — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}

for (const [name, url, note] of QUOTES) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    writeFileSync(
      join(OUT_DIR, `${name}.json`),
      JSON.stringify({ _note: note, _recordedAt: new Date().toISOString(), response: body }, null, 2),
    );
    console.log(`${name}: in=${body.inAmount} out=${body.outAmount} impact=${body.priceImpactPct} hops=${body.routePlan?.length}`);
  } catch (err) {
    console.error(`${name}: FAILED — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}
