-- The auto-watch shelf: tokens that have graduated out of discovery.
--
-- Discovery exists to surface tokens the user has not seen. Two kinds of token
-- stop being discoveries: one that has proved itself (quality >= 70), and one
-- that has simply been trading for a month. Both were previously ranked ABOVE
-- new tokens, because the maturity pillar credits age and holder count, so a
-- handful of established meme coins permanently occupied the top of a
-- score-sorted feed and new launches never got a slot.
--
-- This table is the durable half of the fix. The feed filters graduated tokens
-- out using the same predicate that writes here (see feedAssessment.ts), so
-- ranking and persistence can never disagree about what has graduated.
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
