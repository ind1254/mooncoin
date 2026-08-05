-- FOMO Arbitrage Add-On — Postgres/Supabase schema (ARB-006)
-- Money columns are BIGINT microUsd (1 USD = 1,000,000). Never float.

create table if not exists verified_tokens (
  mint          text primary key,          -- immutable Solana mint address
  symbol        text not null,
  name          text not null,
  decimals      smallint not null check (decimals between 0 and 18),
  enabled       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists venues (
  id            text primary key,          -- e.g. 'raydium', 'orca'
  display_name  text not null,
  enabled       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists calculation_requests (
  id                        uuid primary key default gen_random_uuid(),
  correlation_id            text not null,
  token_mint                text not null references verified_tokens(mint),
  starting_amount_micro_usd bigint not null check (starting_amount_micro_usd > 0),
  requested_at              timestamptz not null default now()
);

create table if not exists calculation_results (
  id                        uuid primary key default gen_random_uuid(),
  request_id                uuid not null references calculation_requests(id),
  buy_venue_id              text not null references venues(id),
  sell_venue_id             text not null references venues(id),
  estimated_final_micro_usd bigint not null,
  venue_fees_micro_usd      bigint not null,
  network_fees_micro_usd    bigint not null,
  price_impact_micro_usd    bigint not null,
  safety_buffer_micro_usd   bigint not null,
  net_profit_micro_usd      bigint not null,
  return_bps                bigint not null,
  is_profitable             boolean not null,
  quote_expires_at          timestamptz not null,
  created_at                timestamptz not null default now(),
  check (buy_venue_id <> sell_venue_id)
);

create table if not exists calculation_warnings (
  result_id   uuid not null references calculation_results(id),
  code        text not null,               -- WarningCode taxonomy
  primary key (result_id, code)
);

-- Paper-performance tracking (ARB-010): re-evaluate stored opportunities later
create table if not exists paper_outcomes (
  id                        uuid primary key default gen_random_uuid(),
  result_id                 uuid not null references calculation_results(id),
  evaluated_at              timestamptz not null default now(),
  realized_final_micro_usd  bigint,        -- null when re-quote failed
  realized_net_micro_usd    bigint,
  evaluation_status         text not null  -- 'evaluated' | 'quote_unavailable' | 'expired'
);

create table if not exists provider_health (
  id           bigserial primary key,
  venue_id     text not null,
  observed_at  timestamptz not null default now(),
  ok           boolean not null,
  error_code   text,
  latency_ms   integer
);

create index if not exists idx_results_created on calculation_results (created_at desc);
create index if not exists idx_requests_correlation on calculation_requests (correlation_id);
create index if not exists idx_provider_health_venue on provider_health (venue_id, observed_at desc);
