/**
 * Record the evidence that pins Jupiter's `priceImpactPct` unit contract.
 *
 * Run MANUALLY (never in CI):  node scripts/refresh-price-impact-contract.mjs
 *
 * Read-only public quote data. No API key, no account, no signing, and this
 * script never touches /swap or any endpoint that builds a transaction.
 *
 * Why a size ladder rather than a single quote: a lone quote cannot tell you
 * whether 0.8 means 0.8% or 80%. Quoting the same pair across four orders of
 * magnitude can. The smallest leg is close enough to mid price to act as a
 * reference; scaling it up predicts the zero-impact output for the larger
 * legs, and the shortfall against that prediction is the real, independently
 * measured price impact. Comparing that measurement to the reported field
 * settles the units without relying on documentation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.JUPITER_QUOTE_URL ?? "https://lite-api.jup.ag/swap/v1";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "jupiter");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const LADDER = [
  ["10k", 10_000_000_000n],
  ["1m", 1_000_000_000_000n],
  ["100m", 100_000_000_000_000n],
];

const legs = [];
for (const [label, amount] of LADDER) {
  const url = `${BASE}/quote?inputMint=${USDC}&outputMint=${BONK}&amount=${amount}&slippageBps=50`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const body = await res.json();
  legs.push({
    label,
    inAmount: body.inAmount,
    outAmount: body.outAmount,
    priceImpactPct: body.priceImpactPct,
  });
  console.log(`${label}: in=${body.inAmount} out=${body.outAmount} impact=${body.priceImpactPct}`);
  await new Promise((r) => setTimeout(r, 500));
}

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "price-impact-contract.json"),
  JSON.stringify(
    {
      _note:
        "USDC->BONK size ladder. Pins that priceImpactPct is a decimal fraction (1 = 100%), not a percentage number.",
      _method:
        "Scale the smallest (near-mid) leg to each larger leg's size to predict zero-impact output; the shortfall is the measured impact. Compare to the reported field read as a fraction.",
      _recordedAt: new Date().toISOString(),
      pair: { inputMint: USDC, outputMint: BONK },
      legs,
    },
    null,
    2,
  ),
);
console.log("wrote price-impact-contract.json");
