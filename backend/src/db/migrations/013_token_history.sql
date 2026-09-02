-- Bounded token history: the durable series behind "what was risk an hour ago?"
--
-- Migration 006 deliberately kept one row per mint and overwrote it, noting
-- that "history belongs in an indexer with a retention policy, and inventing
-- one here would grow without bound for no current feature". That was right at
-- the time. The features now exist — risk-change explanations, and answering
-- what changed while a position was held — so the retention policy is the
-- thing to build, not an excuse to skip the history.
--
-- 006 is left exactly as it is. It serves the alert worker's consecutive-pass
-- diff, which wants the latest row and nothing else, and making it carry
-- history too would slow the hot path for no benefit.
--
-- WHY THIS DOES NOT GROW WITHOUT BOUND
--
-- Every row is stamped with a resolution tier, and a prune pass downsamples as
-- rows age rather than appending forever:
--
--   high    every observation, for the last 6 hours
--   medium  one row per hour, from 6 hours to 7 days
--   low     one row per day, from 7 days to 90 days
--           deleted beyond 90 days
--
-- A token observed every minute produces ~360 high rows, then collapses to 24
-- per day and then 1 per day: a few hundred rows per mint at steady state
-- rather than half a million a year. That fits Postgres on Vercel.
--
-- Bigints are stored as `bigint` columns to match token_observations. Every
-- measure is nullable on purpose: a provider outage must record "we did not
-- see this" rather than a zero, which would read as a total collapse on the
-- next diff.
create table if not exists token_history (
  id                       bigserial primary key,
  token_mint               text not null,
  observed_at              timestamptz not null,

  -- Retention tier. Rows are promoted downward by the prune pass, never up.
  resolution               text not null default 'high'
                             check (resolution in ('high', 'medium', 'low')),

  -- Risk, with the model that produced it. Without the version a stored score
  -- could be silently compared against a number a different model produced.
  risk_score               integer check (risk_score between 0 and 100),
  risk_confidence          integer check (risk_confidence between 0 and 100),
  risk_model_version       text,

  price_pico_usd           bigint,
  liquidity_usd_micro      bigint,
  market_cap_usd_micro     bigint,
  volume_24h_usd_micro     bigint,

  wallet_concentration_bps bigint,
  program_held_bps         bigint,

  mint_authority_revoked   boolean,
  freeze_authority_revoked boolean,

  -- Wallet cohorts. Nullable and currently always null: no provider can
  -- support these claims yet, and a fabricated label is worse than none.
  developer_wallet_pct_bps bigint,
  insider_pct_bps          bigint,

  created_at               timestamptz not null default now()
);

-- One observation per mint per instant. Makes the worker's writes idempotent:
-- a retried pass updates rather than duplicating.
create unique index if not exists token_history_mint_observed_idx
  on token_history (token_mint, observed_at);

-- The read path: a token's series, newest first.
create index if not exists token_history_mint_time_idx
  on token_history (token_mint, observed_at desc);

-- The prune path: find ageing rows by tier without scanning the table.
create index if not exists token_history_resolution_idx
  on token_history (resolution, observed_at);
