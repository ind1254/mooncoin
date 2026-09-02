# Moonpaper 60–90 second demo script

Use the included [silent walkthrough](media/moonpaper-demo.webm) as the visual track, or record this sequence with narration.

## 0:00–0:12 — Live research

**Show:** Research, the live-source badge, proof strip, filters, and token cards.

**Say:** “Moonpaper is a live Solana research and paper-trading app. It ranks up to 100 current Jupiter feed candidates, shows where the evidence came from, and never connects to a wallet.”

## 0:12–0:27 — Explainable decisions

**Show:** Open a token, then point to the score factors, freshness, and production checks.

**Say:** “The score is deterministic and explainable. Missing chain evidence stays unavailable instead of becoming zero, while a separate server-side check verifies liquidity, mint controls, route freshness, and price impact for the exact trade size.”

## 0:27–0:40 — Persistent account state

**Show:** Watchlist, Settings, Portfolio, or Bot Lab.

**Say:** “Accounts persist settings, saved coins, alerts, virtual balances, positions, and the bot audit in Postgres. A browser test proves the data survives refresh, sign-out, and a later sign-in.”

## 0:40–0:55 — Engineering page

**Show:** Engineering architecture and decision cards.

**Say:** “The implementation uses strict TypeScript and Express, BigInt fixed-point accounting, 15 forward-only migrations, idempotent writes, and 467 passing test executions.”

## 0:55–1:10 — Safety and close

**Show:** Demo Sandbox banner, then return to Research.

**Say:** “The sandbox is explicitly separated from live research. Moonpaper has no transaction builder, signer, wallet custody, or real execution path—the strongest product decision here is making that boundary structural.”

End on the deployed URL and GitHub repository.
