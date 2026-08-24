# Background worker: alerts and shadow paper bot

A bounded Vercel Cron function that evaluates every user's alert rules and runs
enabled simulation-only shadow strategies once per invocation. It ships with
the same Vercel project as the API and SPA.

## Why it is separate

Alerts must run when nobody is looking, but a serverless function cannot hold a
permanent `setInterval` loop. Vercel Cron instead sends an authenticated GET to
`/api/cron/worker` every minute. The handler claims a database lease, runs one
bounded pass, persists its results, releases the lease, and exits.

The one-minute schedule requires Vercel Pro or Enterprise. Hobby permits only a
daily schedule and will reject this repository's cron expression at deploy.

## What it does each pass

1. Resolves every enabled rule to concrete `(rule, mint)` pairs. Watchlist-scoped
   rules fan out across the user's watchlist in SQL.
2. Groups by mint and fetches **each token exactly once**, however many users
   watch it. This is the property the whole design turns on.
3. Diffs against the previous snapshot in `token_observations` to get price,
   liquidity, and volume deltas.
4. Evaluates each rule, writes any fired alert to `alert_events`, and updates
   `alert_rule_state`.
5. Overwrites the snapshot, ready for the next pass.

The alert pass writes only alert events, rule state, and token snapshots. The
paper-bot pass may open or close virtual `paper_positions` and records every
decision. The process never builds a transaction, never signs, never submits,
and holds no wallet or keys.

## Shadow paper-bot pass

After alerts, each pass loads at most 100 enabled bot configurations. It values
existing bot positions first with exact-size sell quotes, applies deterministic
stop/target/trailing/time exits, then fetches the five-minute trending feed once
for all users. At most three candidates per account reach the expensive
production-gate check, and at most one position is opened per account per pass.

The strategy is disabled by default. Turning it off is synchronized with the
position transaction, so no later automatic open or close can commit after the
disable request completes. Manual closes remain available for every bot-opened
position.

## Deploying on Vercel

The cron entry is `api/cron-worker.js`; `vercel.json` registers the production
schedule and routes `/api/cron/worker` to it. Cron never runs for preview
deployments.

Set these Vercel environment variables for **Production**:

| Variable | Required | Notes |
|---|---|---|
| `CRON_SECRET` | yes | Random secret of at least 16 characters; Vercel sends it as `Authorization: Bearer …` |
| `DATABASE_URL` | yes | Same hosted Postgres database as the Vercel API |
| `SOLANA_RPC_URL` | yes | Keyed provider recommended; the public endpoint can rate-limit holder scans |
| `JUPITER_API_KEY` | no | Recommended when moving from the keyless compatibility endpoint |

Deploy the production branch. A successful invocation logs:

```json
{"ts":"...","msg":"scheduled worker pass complete","runKey":"scheduled:...","status":"completed"}
```

Calls without the exact bearer secret return `401` before a database connection
or provider client is created. Missing persistence or an unexpected pass-level
failure returns `503` and is visible in Vercel Function logs.

## Scheduling, overlap, and duplicate delivery

The production cadence is the five-field cron expression in `vercel.json`.
Each pass costs roughly one research call per *distinct* watched mint — not per
rule, and not per user.

Vercel may overlap invocations or deliver a scheduled event more than once. The
`worker_leases` row prevents both failure modes:

- `lease_expires_at` admits only one active function across every instance.
- `last_run_key` makes each UTC minute idempotent even after the lease releases.
- An abandoned lease expires after six minutes, one minute beyond Fluid
  Compute's default five-minute ceiling, so a terminated invocation can recover
  without overlapping its replacement.

`ALERT_INTERVAL_MS` remains available only for the standalone local development
loop (`npm run worker:dev --prefix backend`); it does not change Vercel Cron.

## Behaviour worth knowing

**First pass never fires change-based alerts.** There is no previous snapshot
to diff against, and treating a first sighting as a 100% move would be wrong.
Absolute rules (holder concentration, authorities) do fire immediately.

**Restarting after downtime does not cause a burst.** If the previous snapshot
is older than `MAX_DIFF_AGE_MS` (15 minutes) the comparison is skipped and only
the snapshot is refreshed. Without this, every watched token that moved during
the outage would alert at once, all technically true and all useless.

**A token that cannot be read is skipped, not zeroed.** Its snapshot is left
untouched so the next successful read diffs against real history rather than
against a gap.

## Not yet implemented

- **Email and push delivery.** Alerts are written to `alert_events` and appear
  in-app. Email needs a verified sending domain in Resend.
- **`route_unavailable` rules.** Proving a route exists costs a quote per token
  per pass. The rule is accepted and stored but stays inert; the observation
  reports `null`, which the engine treats as "do not evaluate" rather than
  firing on an assumption.
- **`volume_spike`** uses a 24h volume delta between passes, which is a coarse
  signal. Usable, but not a true short-window measure.
