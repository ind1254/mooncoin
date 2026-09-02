-- The auto-watch shelf: tokens automatically selected for ongoing research.
--
-- A quality score of 70 adds a token to the shelf without removing it from
-- discovery. A token trading for a month is both shelved and hidden from the
-- new-token feed. The distinction matters because the discovery screen itself
-- defaults to 70+: hiding that same band would guarantee an empty result.
--
-- This table is the durable half of the feature. Both the shelf predicate and
-- the narrower maturity-only hiding predicate live in feedAssessment.ts.
--
-- Deliberately NOT tied to a user. Graduation is computed from global market
-- data and says nothing about any individual's preferences, so it is a system
-- shelf. The per-user `watchlist_items` table stays exactly as the user
-- curated it: nothing here writes to a list a person believes they control.
--
-- One row per mint, upserted each worker pass. `first_promoted_at` is never
-- overwritten, so "when did this graduate?" survives later passes, while
-- `last_seen_at` and the scores track the most recent observation.
create table if not exists auto_watch_items (
  token_mint        text primary key,
  -- 'market_maturity' = trading 30+ days; 'quality_threshold' = quality >= 70.
  reason            text not null check (reason in ('market_maturity', 'quality_threshold')),
  symbol            text,
  name              text,
  quality_score     integer check (quality_score between 0 and 100),
  risk_score        integer check (risk_score between 0 and 100),
  -- Which scoring model produced the numbers above, so a later model change
  -- does not silently make old rows look comparable to new ones.
  score_version     text not null,
  first_promoted_at timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

-- The shelf is read newest-graduation-first.
create index if not exists auto_watch_promoted_idx
  on auto_watch_items (first_promoted_at desc);
