-- Moonpaper initial schema.
--
-- NUMERIC STRATEGY (see also src/db/client.ts):
--   * money in USD      -> BIGINT micro-USD (1 USD = 1,000,000). Exact cents.
--   * token quantities  -> NUMERIC(78,0) base units. A meme-coin balance can
--                          exceed u64, so BIGINT is not wide enough.
--   * prices            -> BIGINT pico-USD (1 USD = 1e12). Meme prices are far
--                          below one micro-USD.
--   * ratios            -> INTEGER basis points.
-- No monetary value is ever stored as a float.

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  -- scrypt output, encoded as scrypt$N$r$p$salt$hash. Never a plaintext password.
  password_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Case-insensitive uniqueness: Alice@x.com and alice@x.com are one account.
create unique index if not exists users_email_lower_key on users (lower(email));

create table if not exists sessions (
  -- SHA-256 of the opaque token. The raw token exists only in the user's
  -- cookie, so a database leak does not hand an attacker live sessions.
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  last_seen_at timestamptz not null default now()
);

create index if not exists sessions_user_id_idx on sessions (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

create table if not exists portfolios (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  name              text not null default 'Default',
  base_currency     text not null default 'USD',
  -- Paper cash, micro-USD. CHECK enforces the invariant in the database, not
  -- just in application code: a paper account can never go negative.
  cash_micro_usd    bigint not null check (cash_micro_usd >= 0),
  -- Recorded so performance is measurable even if the default changes later.
  starting_micro_usd bigint not null check (starting_micro_usd > 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One default portfolio per user TODAY, without blocking multiple portfolios
-- LATER: dropping this partial index is the entire migration required.
create unique index if not exists portfolios_one_default_per_user
  on portfolios (user_id) where name = 'Default';

create index if not exists portfolios_user_id_idx on portfolios (user_id);

create table if not exists watchlist_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  -- Canonical identity. Symbols are display-only and are NOT unique on Solana.
  token_mint   text not null,
  created_at   timestamptz not null default now(),
  -- Deliberately no price/liquidity columns: the database stores the user's
  -- intent ("I care about this mint"), never a stale copy of market data.
  unique (user_id, token_mint)
);

create index if not exists watchlist_user_idx on watchlist_items (user_id, created_at desc);
