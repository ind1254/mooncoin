# Technical Audit

Findings from a correctness-first audit of the repository at commit `945057c`.
Baseline before any change: typecheck clean, `npm run build` clean, 33 test
files / 351 tests passing.

Severity is about *consequence*, not effort.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `priceImpactPct` misread as a percentage; every impact gate 100x too loose | **Critical** | **Fixed** |
| 2 | The same conversion existed twice, in two modules, both wrong | **High** | **Fixed** |
| 3 | Jupiter Swap V1 / Metis is deprecated upstream | Medium | **Addressed** — see below |
| 4 | No backend CI; only iOS is validated | Medium | Open — Checkpoint 2 |
| 5 | `backend/dist` is committed to Git | Medium | Open — Checkpoint 2 |
| 6 | Brand and metadata are inconsistent; `PROJECT_SUMMARY.md` is stale | Low | Open — Checkpoint 2 |
| 7 | Risk scoring is unversioned outside the live feed | Medium | Open — Checkpoint 4 |
| 8 | Token observations keep only the latest row | Medium | Open — Checkpoint 7 |

---

## Finding 1 — `priceImpactPct` was read as a percentage. It is a fraction.

**Severity: Critical. Every price-impact safety gate in the product was
inoperative by a factor of 100.**

### The claim

`impactPercentToBpsCeil()` in `backend/src/market/jupiter/quotes.ts` converted
Jupiter's `priceImpactPct` to basis points by multiplying by 100 — the correct
arithmetic *if* the field were a percentage number (where `1` means 1%).

### How the contract was verified

Jupiter's OpenAPI schema types the field only as `string` with no description,
and the published docs do not state the unit. Documentation alone could not
settle it, so the contract was established **empirically** against the live
read-only quote endpoint on 2026-08-31.

A single quote cannot distinguish "0.8 means 0.8%" from "0.8 means 80%". A size
ladder can. Quoting USDC → BONK across four orders of magnitude, the smallest
leg sits close enough to mid price to serve as a reference; scaling it predicts
the zero-impact output at larger sizes, and the shortfall against that
prediction is the **real, independently measured** price impact:

| Input | Output | Predicted zero-impact output | Measured impact | Field value |
|---|---|---|---|---|
| $10k | 332,298,299,827,157 | (reference leg) | — | 0.003282… |
| $1M | 6,589,559,871,268,266 | 33,229,829,982,715,700 | **80.17%** | 0.802348… |
| $100M | 4,871,059,072,417,034 | 3,322,982,998,271,570,000 | **99.85%** | 0.998538… |

Read as a **fraction**, the field says 80.23% and 99.85% — matching the
measurement to within 0.07 and 0.001 percentage points respectively. Read as a
**percentage number** it would claim 0.80% and 0.998% impact on trades that
measurably lost 80% and 99.85% of their value.

Two further confirmations:

- The field **saturates asymptotically toward 1.0 and never exceeds it**, which
  is only possible for a fraction.
- Jupiter's own docs confirm Metis/Swap V1 is superseded by Swap V2, but say
  nothing that contradicts the fraction reading.

**Conclusion: `priceImpactPct` is a decimal fraction where 1 = 100%. The
existing conversion was 100x too small.** This matches the hypothesis in the
task brief, but was confirmed independently rather than taken on faith.

### Why this was dangerous

`priceImpactBps` is the input to every price-impact decision in the system. At
100x too small, a token costing **3% to trade** reported **3 bps**, sailing
through a 100 bps (1%) user limit and the 300 bps production limit
(`TRADABILITY_MAX_PRICE_IMPACT_BPS`, default 300).

Traced consumers — all of which were silently degraded:

| Consumer | Role |
|---|---|
| `market/tradability.ts:268` | `price_impact` gate — **blocking** |
| `paper/livePaper.ts:268` | rejects a manual paper entry — **blocking** |
| `paper/livePaper.ts:350` | rejects a bot paper entry — **blocking** |
| `paper/engine.ts:88` | legacy engine entry limit — **blocking** |
| `bot/strategy.ts:71` | `liquidity_risk` exit trigger |
| `bot/worker.ts:127,154` | current impact fed to the strategy, and recorded |
| `scoring/scores.ts:171-173` | execution-pillar penalty |
| `core/calculator.ts:24` | impact cost in round-trip P&L |
| `core/riskRules.ts:48` | combined buy+sell impact rule |
| `notify/engine.ts:112,211` | alert gating and alert copy |
| `api/app.ts` (6 sites) | `pctStr()` formatting for the API |
| `paper/livePaper.ts:119-146` | entry/exit/valuation impact shown to the user |
| `web/app.js:1896` | client-side "over your limit" badge |
| `ios`, `demo` | `priceImpactUsd` dollar cost, via `core/calculator.ts` |

The display path was self-consistent (`bps → pctStr → parseFloat × 100 → bps`),
so the error was invisible in the UI. Users saw "0.03% impact" on a trade that
actually cost 3%.

### That the whole suite still passed is itself a finding

Correcting the conversion broke **no existing test**. Every gate test
constructs `priceImpactBps` by hand (`25n`, `300n`, `301n`) and so never
exercises the converter; only two tests touched it, and both asserted the wrong
contract. The gates were well tested; the *boundary feeding them* was not. That
is the general lesson — see the fix.

### The fix

1. **New module `backend/src/market/jupiter/units.ts`** — the single audited
   home for this conversion, carrying the full derivation above as a comment so
   the next reader does not have to re-derive it.
2. Conversion corrected to `bps = fraction × 10_000`.
3. Precision raised from 6 to 12 retained fractional digits, with an explicit
   rule that a truncated non-zero tail **rounds up**, so truncation can never
   make an impact look cheaper than it is.
4. Exponent notation (`1e-4`) is now parsed rather than rejected — previously
   it would have thrown `MALFORMED_PROVIDER_RESPONSE` and blocked the quote.
5. Renamed to `priceImpactFractionToBpsCeil`. **The old name was part of the
   bug**: `impactPercentToBps` describes the wrong contract, and a maintainer
   reading it would reasonably preserve the wrong arithmetic.
6. Negative impact still reports `0n` — upside, not a discount that could
   offset a real cost elsewhere.

### Tests added

`backend/tests/jupiterUnits.test.ts` (10 tests) pins the contract two ways:

- An explicit conversion table: `0.0001 → 1`, `0.001 → 10`, `0.01 → 100`,
  `0.03 → 300`, `1 → 10_000` bps.
- Negative assertions that the field is *not* read as a percentage.
- A **contract regression test** driven by a recorded fixture
  (`tests/fixtures/jupiter/price-impact-contract.json`, refreshed by
  `scripts/refresh-price-impact-contract.mjs`) that re-derives the units from
  measured output degradation and asserts the fraction reading matches while
  the percentage reading does not.

Plus integration coverage in `quotes.test.ts` proving the provider applies the
contract end-to-end, including a regression that a 3% token stays above a 1%
gate.

### Operational consequence — read this before deploying

This fix makes the gates **strictly stricter**. Tokens that previously passed
will now be correctly rejected, and rejection counts will rise sharply. That is
the gates starting to work, not a regression. `TRADABILITY_MAX_PRICE_IMPACT_BPS`
(default 300 = 3%) and the per-user `maxPriceImpactBps` (default 100 = 1%) now
mean what they say, and may want retuning against real meme-coin liquidity.

---

## Finding 2 — The conversion existed twice, and both copies were wrong

`percentStringToBpsCeil()` in `backend/src/adapters/jupiter.ts` (the legacy
arbitrage venue adapter) was a second, independently written copy of the same
conversion with the same 100x error. It fed `core/calculator.ts` and
`core/riskRules.ts`.

Two copies of a provider-unit rule is the structural defect that let one bug
become two. Both now delegate to `market/jupiter/units.ts`, so there is exactly
one thing to prove correct. This is the specific measure that prevents a
provider-unit bug from silently weakening a safety gate again.

Note the legacy adapter also still points at `quote-api.jup.ag/v6`, a different
and older endpoint than the main path's `lite-api.jup.ag/swap/v1` — folded into
Finding 3.

---

## Finding 3 — Jupiter Swap V1 / Metis is deprecated (addressed)

Jupiter's current documentation states Metis Swap API "is no longer actively
maintained and has been superseded by Swap V2". The repository defaults to
`https://lite-api.jup.ag/swap/v1`, and the legacy adapter uses the older
`quote-api.jup.ag/v6`.

Provenance is stamped as `jupiter:quote-v1` (`JUPITER_QUOTE_SOURCE`) and must
be updated to the real version when migrated, not left describing an endpoint
no longer called. Deferred to Checkpoint 1; the `QuoteProvider` interface
already insulates domain code from the response shape, so this is contained.

### Resolution (Checkpoint 1)

Investigated before migrating, and the investigation changed the plan.

**The two responses are structurally identical.** Fetching the same quote from
`lite-api.jup.ag/swap/v1` and `api.jup.ag/swap/v2` and diffing the field sets
returned *no* difference at the top level, in `routePlan`, or in `swapInfo`.
The only delta is `instructionVersion` (null vs "V2"), which describes
transaction building and is irrelevant to a quote-only integration. So this was
never a schema migration — it is a transport choice.

**V2 cannot be the unconditional default.** V2 is served only from
`api.jup.ag`; `lite-api.jup.ag/swap/v2` returns 404. And `api.jup.ag`
without an API key allows roughly five requests before 429 — a burst of six
keyless requests returned `200 200 200 200 429 429`, with
`x-ratelimit-remaining: 4` on the first. Defaulting to V2 would have traded a
working quote path for one that rate-limits almost immediately.

Implemented instead:

- `JupiterQuoteApiVersion` with precedence: explicit option, then the version
  read off the configured URL, then the key (V2 when a key exists, V1 without).
- **Provenance is now derived, not hardcoded.** The old `JUPITER_QUOTE_SOURCE`
  constant stamped `quote-v1` regardless of the endpoint actually called.
  `inferApiVersionFromUrl()` fixes that at the source.
- Additional execution intelligence captured that was previously discarded:
  `platformFee`, per-hop `inAmount`/`outAmount`/`updateContextSlot`,
  `providerLatencyMs` (from `timeTaken`), `providerRequestId` (the
  `x-api-gateway-request-id` trace header) and `instructionVersion`.
- **Safety boundary hardened into an assertion.** `assertQuoteOnlyBaseUrl()`
  rejects a base URL ending in `/swap`, `/order`, `/execute` or `/send` at
  construction, and the response handler refuses any body carrying
  `swapTransaction` or similar. Quote-only is now enforced by code, not just
  by convention.

Moving to V2 is a two-line environment change (`JUPITER_QUOTE_URL` +
`JUPITER_API_KEY`); provenance follows automatically.

---

## Finding 4 — No backend CI (open)

`.github/workflows/` contains only `ios.yml`. Nothing runs `typecheck`, `test`
or `build` on a backend change. Given that a 100x financial-unit error survived
in `main`, automated validation is the highest-leverage repository fix.

---

## Finding 5 — `backend/dist` is committed (open)

63 generated `.js` files are tracked. The cause appears to be a bootstrap
ordering problem rather than an oversight: the root `postinstall` runs
`node backend/dist/db/runMigrations.js --if-configured`, which needs `dist` to
exist *before* the build script runs.

`vercel.json` also lists `backend/dist/**` in `includeFiles` for both
functions, so **removing it naively will break production**. The build/deploy
ordering has to be redesigned first. Deferred to Checkpoint 2 as instructed.

---

## Finding 6 — Brand and metadata inconsistency (open)

Repository is `mooncoin`; the product, root package, and backend package are
all `moonpaper`; the GitHub description still refers to crypto arbitrage; and
legacy arbitrage code (`api/legacyArbitrage.ts`, 6 routes,
`service/arbitrageService.ts`, `core/calculator.ts`) still ships alongside the
paper-trading product. `PROJECT_SUMMARY.md` is stale relative to the README and
current migrations.

A rename has deployment and API implications and should not be done blindly.
Deferred to Checkpoint 2.

---

## Finding 7 — Risk scoring is unversioned outside the live feed (open)

`market/feedAssessment.ts` carries `scoreVersion: "live-v2"`. Neither
`market/research.ts` nor `scoring/scores.ts` carries a model version, so a
stored risk number cannot be attributed to the model that produced it, and
scoring changes are not comparable across time. Blocks meaningful historical
analysis. Checkpoint 4.

---

## Finding 8 — Observations keep only the latest row (open)

`006_token_observations.sql` overwrites in place by design. Reasonable for the
MVP, but it makes "what was this token's risk an hour ago?" and "what changed
while I held this?" unanswerable, and those are the questions the product most
needs to answer. Checkpoint 7.

---

## What the audit did **not** find

Stated explicitly, because these were checked and are sound:

- **The safety boundary is intact.** No key handling, no signing, no
  transaction submission, no `/swap` call, no wallet execution path.
- **BigInt financial discipline holds.** No float touches a persisted money
  value anywhere in `paper/`, `core/money.ts` or the repositories.
- **Holder concentration is genuinely well modelled.** The pool/curve exclusion
  in `solana/holders.ts` is correct and unusually careful.
- **Provenance is honest.** `FactStatus` distinguishes verified from reported,
  missing data is never defaulted to safe, and `research.ts` correctly refuses
  to call Jupiter's first-pool time the true mint creation time.
- **Concurrency is handled.** The worker lease prevents overlapping cron runs,
  and duplicate run keys are rejected.
- **Quotes fail closed.** No fabricated fill price on provider failure.
