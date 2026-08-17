-- Persistent, simulation-only positions priced from read-only Jupiter quotes.
-- No transaction payload, wallet address, signature, or private-key material is
-- stored because Moonpaper never builds or submits a blockchain transaction.

create table if not exists paper_positions (
  id                         uuid primary key default gen_random_uuid(),
  portfolio_id               uuid not null references portfolios(id) on delete cascade,
  token_mint                 text not null,
  token_symbol               text not null,
  token_name                 text not null,
  token_decimals             smallint not null check (token_decimals between 0 and 18),
  status                     text not null check (status in ('open', 'closed')),
  token_quantity_base_units  numeric(78,0) not null check (token_quantity_base_units > 0),

  entry_cost_micro_usd       bigint not null check (entry_cost_micro_usd > 0),
  entry_slippage_bps         integer not null check (entry_slippage_bps between 1 and 5000),
  entry_price_impact_bps     integer not null check (entry_price_impact_bps >= 0),
  entry_route                jsonb not null check (jsonb_typeof(entry_route) = 'array'),
  entry_quote_source         text not null,
  entry_quote_retrieved_at   timestamptz not null,
  entry_quote_expires_at     timestamptz not null,
  opened_at                  timestamptz not null,

  close_proceeds_micro_usd   bigint,
  realized_pnl_micro_usd     bigint,
  exit_slippage_bps          integer,
  exit_price_impact_bps      integer,
  exit_route                 jsonb,
  exit_quote_source          text,
  exit_quote_retrieved_at    timestamptz,
  exit_quote_expires_at      timestamptz,
  closed_at                  timestamptz,

  check (
    (status = 'open'
      and close_proceeds_micro_usd is null
      and realized_pnl_micro_usd is null
      and closed_at is null)
    or
    (status = 'closed'
      and close_proceeds_micro_usd is not null
      and realized_pnl_micro_usd is not null
      and exit_slippage_bps is not null
      and exit_price_impact_bps is not null
      and exit_route is not null
      and exit_quote_source is not null
      and exit_quote_retrieved_at is not null
      and exit_quote_expires_at is not null
      and closed_at is not null)
  )
);

create index if not exists paper_positions_portfolio_status_idx
  on paper_positions (portfolio_id, status, opened_at desc);

create index if not exists paper_positions_token_mint_idx
  on paper_positions (token_mint, status);
