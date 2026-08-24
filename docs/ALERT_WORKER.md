# Background worker: alerts and shadow paper bot

A long-running process that evaluates every user's alert rules and runs enabled
simulation-only shadow strategies. Deployed **separately from the Vercel API**,
from this same repository.

## Why it is separate

Everything else in Moonpaper runs inside an HTTP request. Alerts are the
opposite: they fire when nobody is looking. Vercel's serverless functions
cannot hold a loop, and cron on the Hobby plan runs **once per day** — not an
alerting product for tokens that can rug in ninety seconds.

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

## Deploying to Railway

1. New project → **Deploy from GitHub repo** → this repository.
2. Railway reads `railway.json`; no Dockerfile needed.
3. Set environment variables:

   | Variable | Required | Notes |
   |---|---|---|
   | `DATABASE_URL` | yes | Same database as the Vercel app |
   | `SOLANA_RPC_URL` | yes | Keyed provider; the public endpoint refuses the holder scan |
   | `ALERT_INTERVAL_MS` | no | Default `60000`. Lower means faster alerts and more RPC spend |
   | `JUPITER_API_KEY` | no | Only if you move off the keyless endpoint |

4. Deploy. Healthy startup logs:

   ```json
   {"ts":"...","msg":"alert worker started","intervalMs":60000}
   ```

Missing `DATABASE_URL` exits with code 1 and a clear message, so the host
restarts it once the variable is set rather than idling in a state that can
never do work.

## Tuning the interval

`ALERT_INTERVAL_MS` is the main cost/latency dial. Each pass costs roughly one
research call per *distinct* watched mint — not per rule, and not per user.

If a pass takes longer than its interval the worker logs a warning and skips
the overlapping tick rather than running two passes at once. Two concurrent
passes would diff against each other's snapshots and could double-fire the same
crossing.

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
