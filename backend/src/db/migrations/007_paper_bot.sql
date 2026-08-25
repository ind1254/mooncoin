-- Opt-in, simulation-only paper bot.
--
-- The bot stores strategy intent and an audit trail. It deliberately stores no
-- wallet, transaction, signature, or key material: automated actions are rows
-- in the existing virtual portfolio and nothing is submitted to Solana.

create table if not exists paper_bot_configs (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null unique references users(id) on delete cascade,
  enabled                    boolean not null default false,
  strategy_version           text not null default 'shadow-v1'
                             check (strategy_version = 'shadow-v1'),
  trade_size_micro_usd       bigint not null default 500000000
                             check (trade_size_micro_usd between 10000000 and 10000000000),
  min_quality_score          smallint not null default 90
                             check (min_quality_score between 0 and 100),
  max_risk_score             smallint not null default 30
                             check (max_risk_score between 0 and 100),
  min_liquidity_micro_usd    bigint not null default 250000000000
                             check (min_liquidity_micro_usd between 10000000000 and 1000000000000000),
  max_price_impact_bps       integer not null default 100
                             check (max_price_impact_bps between 1 and 300),
  slippage_bps               integer not null default 50
                             check (slippage_bps between 1 and 500),
  max_open_positions         smallint not null default 3
                             check (max_open_positions between 1 and 10),
  take_profit_bps            integer not null default 1500
                             check (take_profit_bps between 100 and 10000),
  stop_loss_bps              integer not null default 800
                             check (stop_loss_bps between 100 and 5000),
  trailing_stop_bps          integer not null default 1000
                             check (trailing_stop_bps between 0 and 5000),
  max_hold_minutes           integer not null default 360
                             check (max_hold_minutes between 5 and 10080),
  cooldown_minutes           integer not null default 60
                             check (cooldown_minutes between 1 and 1440),
  last_run_at                timestamptz,
  last_run_status            text check (last_run_status in ('ok', 'degraded', 'error')),
  last_run_summary           text check (last_run_summary is null or length(last_run_summary) <= 500),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

alter table paper_positions
  add column if not exists opened_by text not null default 'manual';

alter table paper_positions
  add column if not exists bot_config_id uuid references paper_bot_configs(id);

-- The application also validates this relationship before writing. The check
-- keeps manual positions from being mistaken for automatic positions later.
alter table paper_positions
  drop constraint if exists paper_positions_opened_by_check;

alter table paper_positions
  add constraint paper_positions_opened_by_check check (
    (opened_by = 'manual' and bot_config_id is null)
    or (opened_by = 'paper_bot' and bot_config_id is not null)
  );

-- Concurrent worker instances cannot open the same mint twice for one bot.
create unique index if not exists paper_positions_one_open_bot_mint
  on paper_positions (bot_config_id, token_mint)
  where opened_by = 'paper_bot' and status = 'open';

create index if not exists paper_positions_bot_status_idx
  on paper_positions (bot_config_id, status, opened_at desc)
  where bot_config_id is not null;

create table if not exists paper_bot_position_state (
  position_id                 uuid primary key references paper_positions(id) on delete cascade,
  config_id                   uuid not null references paper_bot_configs(id) on delete cascade,
  high_water_value_micro_usd  bigint not null check (high_water_value_micro_usd > 0),
  last_value_micro_usd        bigint check (last_value_micro_usd is null or last_value_micro_usd > 0),
  last_evaluated_at           timestamptz,
  exit_reason                 text check (exit_reason is null or length(exit_reason) <= 120),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create table if not exists paper_bot_decisions (
  id             uuid primary key default gen_random_uuid(),
  config_id      uuid not null references paper_bot_configs(id) on delete cascade,
  position_id    uuid references paper_positions(id) on delete set null,
  token_mint     text,
  token_symbol   text,
  action         text not null check (action in (
                   'opened', 'entry_rejected', 'closed', 'exit_unavailable',
                   'scan_empty', 'error'
                 )),
  quality_score  smallint check (quality_score is null or quality_score between 0 and 100),
  risk_score     smallint check (risk_score is null or risk_score between 0 and 100),
  reason         text not null check (length(reason) between 1 and 500),
  snapshot       jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
  created_at     timestamptz not null default now()
);

create index if not exists paper_bot_decisions_config_created_idx
  on paper_bot_decisions (config_id, created_at desc);

create index if not exists paper_bot_decisions_config_mint_created_idx
  on paper_bot_decisions (config_id, token_mint, created_at desc)
  where token_mint is not null;

create index if not exists paper_bot_configs_enabled_idx
  on paper_bot_configs (enabled, updated_at)
  where enabled = true;
