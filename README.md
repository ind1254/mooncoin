# FOMO Arbitrage Add-On

Statistical-arbitrage calculator for the FOMO iOS app, built to the
*iOS Arbitrage Calculator Add-On* plan (Solana-first, **calculation-only MVP**).

It compares executable token-swap quotes across approved Solana venues and shows
an estimated net profit after fees, price impact, and a safety buffer.
**No trades are executed, no private keys touched** — every API response carries
`executionEnabled: false` and there is no signing code anywhere (FR-08).

## Layout

```
backend/           TypeScript cloud API + calculation engine
  src/core/        BigInt fixed-point money math, calculator, risk rules, error taxonomy   (ARB-001)
  src/adapters/    Normalized quote-adapter interface, Jupiter venue adapter, mock adapter (ARB-002/003/004)
  src/service/     Round-trip orchestration: best buy venue -> best sell venue             (ARB-005)
  src/config/      Verified token + venue allowlist (admin-toggleable, FR-10)
  src/store/       Paper-calculation history (in-memory; mirrors db/schema.sql)            (FR-07)
  src/api/         Express server: /v1/arbitrage/calculate, history, tokens, admin, health
  tests/           Invariant suite covering the plan's required test cases
db/schema.sql      Postgres/Supabase schema for production persistence                     (ARB-006)
ios/ArbitrageAddOn Drop-in SwiftUI feature files                                           (ARB-007/008)
```

## Browser demo (see it work without a Mac)

```bash
cd backend && npm run dev:mock
```

then open **http://localhost:8787/demo/** in any browser. The page
(`demo/index.html`) is a phone-frame mock-up of the iOS feature: a simulated
FOMO home screen with the floating bottom-right launcher, the calculator sheet,
live result card with countdown/expiry, warnings, and paper history — all hitting
the real API. Built for showing non-technical stakeholders the idea end to end.

## Backend

```bash
cd backend
npm install
npm test          # 19 invariant tests
QUOTE_MODE=mock npm run dev   # offline dev with a deterministic inter-venue spread
npm run dev                   # live venue-specific quotes via Jupiter (Raydium vs Orca)
```

`POST /v1/arbitrage/calculate` with `{"tokenMint": "...", "startingAmountUsd": 500}`
returns the result-card payload: venues, cost breakdown, net profit, return %,
quote expiry, warning codes, correlation ID.

Key design rules (from the plan):

- **Financial precision** — all money is integer micro-USD `bigint`; token amounts are
  integer base units. Costs round **up**, proceeds round **down**. No floats anywhere.
- **Venue identity** — venue-specific quotes come from Jupiter's `dexes` filter
  (Raydium vs Orca Whirlpools), so the two sides are independently identified venues.
- **Token identity** — immutable mint addresses only; symbols are display-only.
- **Risk rules** — stale, mismatched-mint, same-venue, incomplete, high-impact, and
  low-liquidity results are rejected and can never be flagged profitable.
- **Freshness** — quotes carry `retrievedAtMs`/`expiresAtMs` (20 s TTL); the earliest
  expiry caps the whole result.

## iOS integration (FOMO app) — BLOCKED external dependency

Direct FOMO integration is **blocked** until FOMO Labs provides official access;
the full checklist is in [docs/FOMO_INTEGRATION_REQUIREMENTS.md](docs/FOMO_INTEGRATION_REQUIREMENTS.md).
Do **not** use repositories from the `usefomo` GitHub organization — that is an
unrelated marketing platform.

All host-app touchpoints go through the `FomoIntegrationAdapter` protocol
(`ios/ArbitrageAddOn/FomoIntegrationAdapter.swift`):

- `MockFomoIntegrationAdapter` — the default; fully functional against the local
  mock backend, simulates user context and the "currently viewed token".
- `FomoLabsIntegrationAdapter` — **unimplemented placeholder** that fails loudly;
  it stays that way until official access exists.

The screen is fully runnable today with the default adapter:

```swift
ContentView()
    .arbitrageAddOn()   // floating bottom-right button -> arbitrage sheet (mock adapter)
```

Run `QUOTE_MODE=mock npm run dev` in `backend/` and launch in the simulator —
no live providers or FOMO access needed. When access arrives, implement
`FomoLabsIntegrationAdapter` and pass it: `.arbitrageAddOn(integration: ...)`.
Calculation, quote validation, staleness, fees, and history never touch the
adapter, so no engine changes will be needed.

The screen handles loading/error/empty states, live expiry countdown, expired-result
refresh, backgrounding, cancellation, and VoiceOver labels, and always shows the
"Paper calculation — no funds moved" status line.

## Deliberately out of scope (per plan)

Trade execution, custody/keys, cross-chain, unverified memecoins, and any
guaranteed-profit language. The execution boundary is architectural: adding it
later is a separate security/compliance project.

## Next steps (plan phases 4–5)

1. Deploy the backend (Fly/Railway/Supabase Edge) and swap the in-memory store for `db/schema.sql`.
2. Run the two-week paper-trading pilot: scheduled scanner + outcome tracking (ARB-010).
3. Observability dashboards and alerts on provider health (ARB-011).
4. Security/privacy review and TestFlight rollout (ARB-012).
