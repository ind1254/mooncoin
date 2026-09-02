# Moonpaper — Project Summary (for resume writing)

> Purpose of this document: a complete, honest reference for writing resume
> bullets and answering interview questions about this project. Includes the
> caveats so nothing on the resume overstates what was built.

## One-liner

Moonpaper is a paper-trading decision-support web app for Solana meme-coin
traders: it ranks token opportunities with transparent, evidence-backed scores,
compares executable swap quotes across venues, and lets users open and close
simulated positions with realistic fees, price impact, and slippage — with a
strict safety boundary of **no real trades, no custody, no private keys**.

- **GitHub:** https://github.com/ind1254/mooncoin (branch `main`)
- **Deployed:** Vercel (serverless config included in repo)
- **Status:** working prototype / MVP, live Solana discovery, authenticated database-backed paper positions, and deterministic demo simulation

## What it does (five product pillars)

1. **Discover** — live recently-created and five-minute trending Solana token
   feeds from Jupiter, defaulting to confidence-ranked five-minute trending with
   one-second refresh, market-cap/age/volume/liquidity/risk filters, automatic
   Smart Watch and paper-candidate queues, an evidence-weighted 0–100 live score,
   and canonical mint IDs. An on-demand
   seven-gate production check verifies market age, liquidity, on-chain mint and
   freeze authorities, ticker ambiguity, a live route, and price impact for an
   exact USDC size.
2. **Evaluate** — separate momentum / liquidity / execution / token-risk scores,
   each expandable to the exact evidence that produced it (e.g. "volume up 82%
   vs previous hour", "top 10 wallets hold 62% of supply", "mint authority
   still active"). No unexplained confidence numbers anywhere.
3. **Compare execution** — per-venue executable quotes for the user's exact
   trade size: estimated tokens received, effective price, price impact, pool
   fees, network + priority fees, minimum received under slippage, best route
   vs alternatives, quote expiry.
4. **Paper trade** — authenticated simulated positions for real Solana mints:
   every entry reruns the seven production gates server-side and stores exact
   token units at Jupiter's minimum received. Revaluation and closes use fresh,
   exact-size token-to-USDC quotes (never chart prices).
5. **Learn** — database-backed portfolio dashboard with virtual cash,
   open/closed positions, live minimum-received marks, and realized/unrealized
   P&L. Unavailable quotes are shown as unavailable instead of fabricated.

Also: user settings with sensible defaults, and an in-app notification engine
with cooldowns and material-change gates where every alert explains why it
fired ("BONK now matches your balanced strategy: liquidity increased, ...").

## Tech stack

- **Backend:** Node.js 22, TypeScript (strict mode), Express, Zod validation,
  Vitest. No framework magic — plain modules with dependency injection.
- **Frontend:** vanilla JavaScript SPA (no build step), hand-rolled canvas
  price charts with crosshair tooltips, responsive dark UI.
- **iOS:** SwiftUI module (covers the earlier arbitrage-calculator feature).
- **Infra:** GitHub, Vercel serverless deploy (`@vercel/node` + static routing),
  Postgres in production, PGlite for local development/tests, forward-only SQL
  migrations, structured JSON logging with correlation IDs.

## Engineering decisions worth mentioning in interviews

- **Financial precision:** all money math uses BigInt fixed-point — lamports
  for SOL, micro-USD for values, pico-USD for token prices (meme-coins trade
  at ~$0.00001, far below micro-USD resolution), integer base units for tokens.
  Costs round against the user; floats appear only in display formatting and
  simulated-data generation. Verified by invariant tests (e.g. "increasing any
  cost can never increase net profit").
- **Provider-based architecture:** UI, scoring, and the simulation engine
  depend only on normalized interfaces (discovery, price history, liquidity,
  routing, token risk). Every market value carries provenance: source,
  timestamp, age, and reliability (fresh/stale). Swapping the demo simulator
  for live providers requires no engine or UI changes.
- **Deterministic simulation:** demo market data is a pure function of
  (seed, time bucket), so the paper engine is fully reproducible and testable —
  identical clocks produce identical positions. Seeded scenarios purposely
  cover a strong opportunity, a marginal one, a high-risk token (2 days old,
  62% holder concentration, live mint authority), a stale data feed, and venue
  outages.
- **Transparent scoring:** rule-based, not ML — every score stores its
  contributing factors so the UI can always answer "why". High risk hard-caps
  the overall score (a pumping rug-pull candidate can never rank "strong").
- **Token identity by mint address only** — symbols are display-only, which
  kills the classic duplicate-ticker attack on token lists.
- **Testing:** 351 automated tests: live-feed normalization, concentrated live-v2
  scoring and filtering, production
  tradability gates, provider degradation,
  money-math boundaries, scoring evidence,
  paper-engine invariants (balance bookkeeping is exact to the lamport), and
  API integration tests running the full user flow against an in-memory app
  with a controllable clock.
- **Safety boundary as architecture:** there is no code path that builds,
  signs, or submits a transaction; every API response carries
  `executionEnabled: false`; simulated labels on every surface.
- **Atomic paper accounting:** entry and exit repositories lock portfolio rows,
  debit/credit cash and mutate positions in one database transaction, enforce
  ownership, and prevent double closes. Exact NUMERIC/BigInt values cross the
  provider, service, and persistence boundaries without float arithmetic.
- **Production abuse/retry safety:** Postgres-backed fixed-window limits apply
  across serverless instances without storing raw identifiers. UUID request
  keys make paper-entry retries idempotent under the same portfolio lock.
  Same-origin checks and restrictive browser headers protect cookie sessions.

## Honest caveats (do NOT overstate these on the resume)

- **Live but not a chain indexer.** The home feed retrieves Jupiter's current
  `recent` and `toptraded/5m` catalogs with a one-second single-flight cache. It does not run a
  durable program-log consumer or backfill missed chain events. Catalog data is
  not claimed to prove an executable route; the separate quote request does.
- **Paper trading only.** No real trades were ever executed; simulated fills
  are a model (min-received of best quote) and real execution would differ
  (MEV, partial fills, congestion). Don't claim "trading system" without the
  word "simulated" or "paper."
- **Account system is intentionally minimal.** Password sessions and Postgres
  persistence are implemented, but account recovery, email verification,
  and background jobs are not.
- **The iOS module belongs to the earlier arbitrage-calculator phase** of the
  project, not the current paper-trading UI, and has not been compiled/tested
  (built on Windows, no Xcode available).
- **Origin:** started as an arbitrage-calculator add-on concept for a
  third-party trading app ("Fomo"), then pivoted to a standalone product;
  legacy arbitrage endpoints still work and are kept in the repo.
- **AI-assisted development:** built with Claude Code as the implementation
  tool, with the owner directing product scope, requirements, and decisions.
  Frame authorship accordingly ("designed and shipped using AI-assisted
  development" is honest; "hand-wrote 6k lines of TypeScript" is not).

## Numbers you can cite

<!-- METRICS:START (generated by backend/scripts/repo-metrics.mjs — do not edit by hand) -->
- **443 declared test cases** across 41 suites, all passing; strict-mode TypeScript
- **44 HTTP routes** (market, auth, live/demo paper trading, settings, bot, legacy/admin)
- **13 forward-only Postgres migrations**, shared by production and local tests
- **71 backend TypeScript source files**
<!-- METRICS:END -->
- 6 seeded market scenarios; 3 simulated venues with distinct fee/liquidity profiles

## Suggested resume bullets (pick 2–3, adjust to taste)

- Built **Moonpaper**, a full-stack paper-trading platform for Solana meme-coins
  (TypeScript/Node/Express + vanilla-JS SPA): transparent multi-factor
  opportunity scoring, per-venue executable-quote comparison, and a
  deterministic simulation engine — deployed on Vercel from GitHub.
- Implemented precision-safe financial arithmetic with BigInt fixed-point math
  (lamports/micro-USD/pico-USD scales) and verified core invariants with a  comprehensive automated unit and integration suite.
- Designed a provider-based market-data architecture with normalized,
  provenance-tracked models (source, freshness, reliability) so live data
  sources can replace the seeded demo simulator without engine or UI changes.
- Enforced a strict safety boundary — simulation only, no transaction signing,
  no key custody — expressed in both architecture and API contracts.

## Interview talking points

- Why pico-USD? (meme-coin prices like $0.000014 underflow micro-USD integers)
- Why fills at min-received? (conservative-by-construction estimates; honest
  demo shows instant round-trips losing money to fees/impact)
- Why rule-based scoring instead of ML? (explainability requirement — every
  score must justify itself to a non-technical user; ML is a later phase)
- Why deterministic seeded data? (reproducible demos, testable engine, no
  flaky external dependencies during evaluation)
- What would production need next? (account recovery/email verification, push
  notifications, a durable chain indexer, a real risk-data
  vendor, security review)
