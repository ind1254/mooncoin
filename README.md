# Moonpaper

*Practice the moonshot — risk nothing.*

A live-research and paper-trading MVP for Solana meme-coin traders. It answers one question:
**"Based on current market conditions, what deserves my attention, what are the
risks, and what would happen if I paper-traded it?"**

> **Prototype — paper trading only.** Every trade is simulated with virtual SOL.
> No blockchain transactions are sent, no exchange orders are placed, no funds
> are held, and no private keys or seed phrases are ever requested or stored.
> Scores describe current conditions and are **not** predictions of future
> returns. The New and Trending feeds use live Jupiter catalog data; trading
> remains simulation-only and the legacy simulator stays clearly labeled.

## The five pillars

| Pillar | What it does | Where |
|---|---|---|
| **Discover** | Live recently-created and five-minute trending Solana token feeds with price, volume, liquidity, freshness, risk gates, and a transparent research score | Research tab |
| **Evaluate** | Separate momentum / liquidity / execution / risk scores, each with the exact evidence that produced it | Token detail |
| **Compare execution** | Executable quotes per venue for your exact size: impact, pool fees, network + priority fees, min-received under slippage, best route vs alternatives | Token detail |
| **Paper trade** | Simulated positions filled at the min-received of the best executable quote, with fees and impact applied; closes priced from live sell quotes — never chart prices | Confirm modal / Portfolio |
| **Learn** | Virtual balance, open/closed positions, win rate, avg gain/loss, best/worst, fees paid, execution costs, performance by risk level | Portfolio tab |

Plus: watchlist, user settings with sensible defaults, and in-app alerts that
always explain *why* they fired (with cooldowns and material-change gates).

## Quick start

Prerequisites: Node.js ≥ 20. No credentials, no API keys, no wallet.

```bash
cd backend
npm install
npm run dev
```

Open **http://localhost:8787** — the web app. The Research home retrieves live
New and Trending token feeds from Jupiter; the Simulator and seeded portfolio
remain deterministic demonstrations.

Everything runs locally. State (paper positions, settings) persists to
`backend/data/*.json`, which is gitignored — delete the folder to reset the demo.

### Environment variables

All optional — see [backend/.env.example](backend/.env.example):
`PORT` (8787), `MARKET_MODE` (demo), `QUOTE_MODE` (mock), `PAPER_STARTING_SOL`
(100), `DATA_DIR` (data), `ADMIN_TOKEN` (unset).

### Tests & checks

```bash
cd backend
npm test           # 211 tests: live feeds/quotes, risk, money math, auth, paper engine, API flow
npm run typecheck  # strict TypeScript, no emit
```

## Architecture

```
web/                    Vanilla-JS SPA (no build step) — Discover, token detail,
                        trade confirmation, portfolio, settings, alerts drawer
backend/src/
  market/               Provider interfaces plus live Jupiter token/search/feed
                        and quote adapters, Solana mint verification, and the
                        deterministic seeded simulator.
                        All values normalized with mint identity, source,
                        timestamp, age, and reliability.
  scoring/              Transparent rule-based scores (0-100) with stored factors
  paper/                Deterministic BigInt simulation engine + JSON persistence
  notify/               Notification rules: cooldowns, transitions, explanations
  settings/             Single-user preferences with validated defaults
  api/                  createApp() factory, demo seeding, server entry, legacy
                        arbitrage-calculator routes (original add-on, still works)
  core/ adapters/ ...   Original arbitrage engine (BigInt money math) — reused
ios/ArbitrageAddOn/     SwiftUI module for the original arbitrage calculator
demo/                   Original phone-frame arbitrage demo (served at /demo)
                        (Mentions of "Fomo" in ios/, demo/, and docs/ refer to
                        the unrelated third-party app the original add-on would
                        integrate with — they are not this product's name.)
db/schema.sql           Postgres schema for the legacy calculator (future use)
```

**Financial precision rule:** SOL amounts are bigint lamports, USD values are
bigint micro-USD, token prices are bigint pico-USD, token amounts are bigint
base units. Floats appear only when *generating* simulated market data and in
display formatting — never in balances or P&L.

**Provider boundary:** live discovery uses Jupiter Tokens V2 (`recent` and
`toptraded/5m`) with a 10-second cache. Arbitrary-token research resolves by
mint and verifies authority settings through read-only Solana RPC. Quotes use
Jupiter's read-only quote route with no fabricated fallback. The simulator is
still isolated and honestly labeled demonstration data.

## API sketch

```
GET  /health                        GET  /v1/meta
GET  /v1/feed                       ?kind=recent|trending&minLiquidityUsd&search
GET  /v1/opportunities              ?tradeSizeSol&risk&minLiquidityUsd&search
GET  /v1/tokens/:mint               ?tradeSizeSol      (detail + scores + evidence)
GET  /v1/tokens/:mint/routes        ?tradeSizeSol&slippageBps
POST /v1/paper/positions            {tokenMint, solAmount, slippageBps?}
POST /v1/paper/positions/:id/close
GET  /v1/paper/portfolio
GET  /v1/notifications              POST /v1/notifications/mark-read
GET  /v1/settings                   PUT  /v1/settings
POST /v1/watchlist                  {mint, watched}
POST /v1/arbitrage/calculate        (legacy calculator, USD-denominated)
```

Errors are structured: `{error: CODE, message, details}` with codes like
`INSUFFICIENT_PAPER_BALANCE`, `PRICE_IMPACT_TOO_HIGH`, `NO_QUOTE_AVAILABLE`,
`STALE_QUOTE`, `TOKEN_NOT_ALLOWED`, `VALIDATION_ERROR`.

## Demo scenarios (seeded, deterministic)

| Token | Scenario |
|---|---|
| BONK | Strong opportunity — volume accelerating, deep stable liquidity, low impact |
| POPCAT | Marginal — decent momentum, thinner liquidity, one venue missing |
| FLOOF *(synthetic)* | High risk — 2 days old, 62% holder concentration, live mint authority, draining liquidity, parabolic pump. Ranks **AVOID** |
| WIF / MEW / PNUT | Healthy-quiet, negative momentum, and volatile-with-stale-feed respectively |

The demo portfolio seeds one open position (WIF), one profitable close (BONK
+8.4%), and one losing close (FLOOF −23.5%) so every product state is visible
immediately.

## Known limitations

- The live home feed is request-driven and cached for 10 seconds; it is not a
  durable chain-indexing pipeline and does not backfill missed program events.
- Jupiter catalog presence and reported liquidity do not prove that a route is
  executable for a particular size. The UI requires the user to request a
  fresh read-only quote before treating execution as available.
- Solana's public RPC can rate-limit on-chain authority verification. When it
  does, Moonpaper shows verification as unavailable rather than trusting a
  provider claim as chain truth.
- Single user, local JSON persistence; no auth. A real deployment needs
  accounts, a database, and rate limiting.
- In-app notifications only (generated by a 30s server tick); no push.
- The iOS SwiftUI module covers the original arbitrage calculator, not the new
  paper-trading UI; the web app is the reference front end.
- Simulated fills assume the min-received of the best quote — conservative, but
  still a model. Real execution differs (MEV, partial fills, congestion).

## Safety boundaries (non-negotiable)

- No transaction building, signing, or submission anywhere in the codebase
- No custody, no fund transfers, no exchange orders, no auto-trading
- No private keys or seed phrases, ever
- No profit guarantees; simulated results are labeled simulated everywhere
