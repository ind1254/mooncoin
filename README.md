# Moonpaper

*Practice the moonshot — risk nothing.*

A live-research and paper-trading MVP for Solana meme-coin traders. It answers one question:
**"Based on current market conditions, what deserves my attention, what are the
risks, and what would happen if I paper-traded it?"**

> **Prototype — paper trading only.** Every trade is simulated with virtual funds.
> No blockchain transactions are sent, no exchange orders are placed, no funds
> are held, and no private keys or seed phrases are ever requested or stored.
> Scores describe current conditions and are **not** predictions of future
> returns. The New and Trending feeds use live Jupiter catalog data; trading
> remains simulation-only and the legacy simulator stays clearly labeled.

## The five pillars

| Pillar | What it does | Where |
|---|---|---|
| **Discover** | Live recently-created and five-minute trending Solana token feeds with price, volume, liquidity, freshness, duplicate-ticker warnings, and on-demand production eligibility gates | Research tab |
| **Evaluate** | Separate momentum / liquidity / execution / risk scores, each with the exact evidence that produced it | Token detail |
| **Compare execution** | Executable quotes per venue for your exact size: impact, pool fees, network + priority fees, min-received under slippage, best route vs alternatives | Token detail |
| **Paper trade** | Authenticated, persistent positions for real Solana mints. Entries rerun every production gate and store Jupiter's minimum received; closes use a fresh exact-size sell quote — never chart prices | Confirm modal / Portfolio |
| **Learn** | Database-backed virtual cash, live minimum-received marks, open/closed positions, and realized/unrealized P&L | Portfolio tab |

Plus: watchlist, user settings with sensible defaults, and in-app alerts that
always explain *why* they fired (with cooldowns and material-change gates).

## Production safeguards (Part 4)

- Authentication and paper-write budgets are enforced by atomic Postgres
  counters, so limits apply across every Vercel instance. Subjects are stored
  as one-way hashes rather than raw email addresses or session identifiers.
- Each live paper entry requires a browser-generated `clientRequestId`. Replays
  return the original position under the portfolio lock and never debit cash
  twice; reusing the id for different trade parameters is rejected.
- Same-origin checks protect browser writes. CSP, HSTS, no-sniff, referrer,
  permissions, opener and resource policies are emitted on every response.
- Personal responses are `no-store`, and hostile correlation IDs are replaced
  before structured logging.

## Quick start

Prerequisites: Node.js ≥ 20. No provider credentials, API keys, or wallet are
required for local development.

```powershell
cd backend
npm install
$env:LOCAL_DB="true"
$env:COOKIE_SECURE="false"
npm run dev:local
```

On macOS/Linux, use `LOCAL_DB=true COOKIE_SECURE=false npm run dev:local`.

Open **http://localhost:8787** — the web app. New and Trending token feeds come
from Jupiter. Create an account to persist watchlist state and live-quote paper
positions in the local PGlite database. The separate Simulator remains a
deterministic demonstration.

### Environment variables

See [backend/.env.example](backend/.env.example). The live providers work on the
keyless compatibility host by default; production can set `JUPITER_API_KEY` and
the official `api.jup.ag` URLs. Server-owned eligibility policy is configured by
`TRADABILITY_MIN_LIQUIDITY_USD` (10,000),
`TRADABILITY_MAX_PRICE_IMPACT_BPS` (300), and
`TRADABILITY_MAX_MARKET_AGE_MS` (300,000). Live paper limits use
`PAPER_MIN_TRADE_USD` (10), `PAPER_MAX_TRADE_USD` (10,000), and
`PAPER_MAX_OPEN_POSITIONS` (25). Client controls cannot weaken these policies.
Durable abuse budgets use `AUTH_RATE_LIMIT_ATTEMPTS`,
`AUTH_RATE_LIMIT_NETWORK_ATTEMPTS`, `AUTH_RATE_LIMIT_WINDOW_MS`, and
`PAPER_RATE_LIMIT_ATTEMPTS` / `_WINDOW_MS`.
Production accounts require `DATABASE_URL`; local development can use
`LOCAL_DB=true` for the same migrations and constraints in PGlite.

### Tests & checks

```bash
cd backend
npm test           # 231 tests: feeds/quotes/gates, risk, money math, auth, safeguards, API flow
npm run typecheck  # strict TypeScript, no emit
```

## Architecture

```
web/                    Vanilla-JS SPA (no build step) — Discover, token detail,
                        trade confirmation, portfolio, settings, alerts drawer
backend/src/
  market/               Provider interfaces plus live Jupiter token/search/feed,
                        quote and tradability adapters, Solana mint verification, and the
                        deterministic seeded simulator.
                        All values normalized with mint identity, source,
                        timestamp, age, and reliability.
  scoring/              Transparent rule-based scores (0-100) with stored factors
  paper/                Deterministic demo engine plus live-quote paper service
  auth/ db/             Password sessions, Postgres migrations and repositories
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
Jupiter's read-only quote route with no fabricated fallback. The production
eligibility service combines those independent sources for one exact USDC size:
fresh catalog timestamp, minimum liquidity, direct mint/freeze authority reads,
duplicate-symbol warning, fresh route, and maximum impact. The simulator stays
isolated and honestly labeled demonstration data. Live paper entries rerun the
same gates server-side, store exact token units and the quoted minimum received,
and revalue or close with fresh token-to-USDC quotes.

## API sketch

```
GET  /health                        GET  /v1/meta
GET  /v1/feed                       ?kind=recent|trending&minLiquidityUsd&search
GET  /v1/tradability/:mint          ?amountUsd&slippageBps (seven production gates)
GET  /v1/quote                      ?inputMint&outputMint&amount&slippageBps
POST /v1/auth/signup                {email, password}
POST /v1/auth/signin                {email, password}
POST /v1/auth/signout
GET  /v1/me
GET  /v1/me/portfolio
POST /v1/me/paper/positions         {clientRequestId, tokenMint, amountUsd, slippageBps?}
POST /v1/me/paper/positions/:id/close {slippageBps?}
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
`STALE_QUOTE`, `RATE_LIMITED`, `ORIGIN_NOT_ALLOWED`, `TOKEN_NOT_ALLOWED`,
`VALIDATION_ERROR`. Rate-limit responses include `Retry-After` and
`RateLimit-*` headers.

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
  executable for a particular size. The UI exposes a server-side production
  check that blocks stale/thin/authority-controlled/high-impact tokens and
  independently verifies a fresh Jupiter route for the requested amount.
- The keyless `lite-api.jup.ag` compatibility endpoints remain the zero-setup
  default. A production operator should set a Jupiter Developer Platform key
  and official endpoint URLs for monitored rate limits and long-term support.
- Solana's public RPC can rate-limit on-chain authority verification. When it
  does, Moonpaper shows verification as unavailable rather than trusting a
  provider claim as chain truth.
- Accounts, sessions, watchlists, virtual cash, and live paper positions persist
  in Postgres (or PGlite locally). Durable limits protect credential and paper
  writes, but the prototype still needs account recovery and email verification.
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
