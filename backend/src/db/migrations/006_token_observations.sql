-- Latest observed snapshot per mint, written by the alert worker.
--
-- Exists because the change data alerts need does not otherwise exist for the
-- tokens people actually watch. The discovery provider publishes 5m and 1h
-- windows only for tokens in its trending feed; a watchlist token nobody else
-- is trading has no window data at all. Diffing our own consecutive snapshots
-- gives a delta for every watched mint rather than only the popular ones.
--
-- The interval is whatever elapsed between worker passes, so it is stored
-- alongside the values and reported in the alert text. A short honest window
-- beats a long assumed one: a rug drains liquidity in seconds, and "fell 40%
-- in the last 45 seconds" and "fell 40% today" call for different reactions.
--
-- Deliberately NOT a time series. One row per mint, overwritten each pass.
-- History belongs in an indexer with a retention policy, and inventing one
-- here would grow without bound for no current feature.

create table if not exists token_observations (
  mint                     text primary key,

  -- Nullable throughout: a provider outage must record "we did not see this"
  -- rather than a zero that would read as a total collapse on the next diff.
  price_pico_usd           bigint,
  liquidity_usd_micro      bigint,
  volume_24h_usd_micro     bigint,
  wallet_concentration_bps bigint,
  mint_authority_revoked   boolean,
  freeze_authority_revoked boolean,

  observed_at              timestamptz not null,
  updated_at               timestamptz not null default now()
);

-- Lets a sweep find snapshots too old to diff against without scanning.
create index if not exists token_observations_observed_at_idx
  on token_observations (observed_at);
