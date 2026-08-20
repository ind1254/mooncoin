-- Per-user alerting.
--
-- Replaces a demo prop with a real feature. The existing notification engine
-- is in-memory, global (one shared settings object for the whole process), and
-- only runs in demo mode. None of that survives a serverless cold start, and
-- none of it belongs to a user.
--
-- Three tables, each with one job:
--   notification_preferences  how a user wants to be reached
--   alert_rules               what they want to be told about
--   alert_events              what was actually sent, and whether they read it
--
-- Plus alert_rule_state, which is what makes alerts bearable rather than
-- spam: a rule fires on a TRANSITION into a matching condition, never
-- repeatedly while the condition merely stays true.

-- ---------------------------------------------------------------------------
-- Delivery preferences: one row per user, created lazily on first read.
-- ---------------------------------------------------------------------------
create table if not exists notification_preferences (
  user_id       uuid primary key references users(id) on delete cascade,

  -- Channels are independent. In-app defaults on because it costs nothing and
  -- cannot be misdelivered; email defaults OFF because sending unrequested
  -- mail to a fresh account is how a domain earns a spam reputation.
  in_app_enabled boolean not null default true,
  email_enabled  boolean not null default false,
  push_enabled   boolean not null default false,

  -- immediate: send as it fires. digest: batch and send on a schedule.
  -- A meme-coin liquidity drain is worthless an hour late, so immediate is the
  -- default and digests exist for people who want signal without interruption.
  delivery_mode  text not null default 'immediate'
                 check (delivery_mode in ('immediate', 'hourly_digest', 'daily_digest')),

  -- Quiet hours in UTC minutes-from-midnight, nullable = always on. Stored as
  -- minutes rather than hours so a later timezone offset does not need a
  -- schema change. Wrapping ranges (22:00 -> 06:00) are legal and handled in
  -- application code, so no CHECK asserting start < end.
  quiet_start_min smallint check (quiet_start_min between 0 and 1439),
  quiet_end_min   smallint check (quiet_end_min between 0 and 1439),

  -- Hard ceiling so a runaway rule cannot mail someone a hundred times.
  max_emails_per_day smallint not null default 20 check (max_emails_per_day between 0 and 200),

  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Rules: what a user wants to hear about.
-- ---------------------------------------------------------------------------
create table if not exists alert_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,

  -- 'watchlist' applies to every mint the user watches, so adding a token
  -- inherits their rules instead of needing the rule recreated per token.
  -- 'mint' pins the rule to one token.
  scope       text not null check (scope in ('watchlist', 'mint')),
  mint        text check (
                (scope = 'mint' and mint is not null) or
                (scope = 'watchlist' and mint is null)
              ),

  kind        text not null check (kind in (
                'price_change',
                'liquidity_drop',
                'volume_spike',
                'holder_concentration',
                'authority_change',
                'route_unavailable'
              )),

  -- Basis points, so a 5% move is 500 and no float ever touches a threshold.
  -- Nullable because authority_change and route_unavailable are boolean events
  -- with nothing to compare against.
  threshold_bps bigint check (threshold_bps is null or threshold_bps >= 0),
  direction     text check (direction in ('above', 'below')),

  -- Seconds. Even a genuine transition should not re-fire immediately when a
  -- value oscillates across the threshold.
  cooldown_seconds integer not null default 3600
                   check (cooldown_seconds between 60 and 604800),

  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The worker's hot path: every enabled rule, grouped by user.
create index if not exists alert_rules_enabled_idx
  on alert_rules (user_id, enabled) where enabled;

-- Rules pinned to one mint, for evaluating a single token cheaply.
create index if not exists alert_rules_mint_idx
  on alert_rules (mint) where mint is not null;

-- ---------------------------------------------------------------------------
-- Rule state: the transition machinery.
-- ---------------------------------------------------------------------------
-- Without this, a rule matching "liquidity below $10k" would fire on every
-- evaluation for as long as liquidity stayed low — every 30 seconds, forever.
-- Storing whether the rule matched LAST time turns that into one alert when it
-- crosses, and nothing while it stays there.
create table if not exists alert_rule_state (
  rule_id       uuid not null references alert_rules(id) on delete cascade,
  mint          text not null,
  matched       boolean not null default false,
  last_value_bps bigint,
  last_fired_at timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (rule_id, mint)
);

-- ---------------------------------------------------------------------------
-- Events: what actually fired.
-- ---------------------------------------------------------------------------
create table if not exists alert_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  -- Rules can be deleted; the history of what a user was told must survive it.
  rule_id     uuid references alert_rules(id) on delete set null,

  mint        text not null,
  symbol      text,
  kind        text not null,

  -- Stated separately on purpose, matching the research page: what happened,
  -- and what it might mean. Never merged into a single persuasive sentence.
  title       text not null,
  reason      text not null,

  severity    text not null default 'info' check (severity in ('info', 'warning', 'critical')),

  fired_at    timestamptz not null default now(),
  read_at     timestamptz,

  -- Per-channel delivery, nullable until actually sent. A row existing does
  -- not mean an email went out; only email_sent_at does.
  email_sent_at timestamptz,
  push_sent_at  timestamptz
);

-- The in-app feed: newest first, per user.
create index if not exists alert_events_user_fired_idx
  on alert_events (user_id, fired_at desc);

-- Unread badge count without scanning history.
create index if not exists alert_events_unread_idx
  on alert_events (user_id) where read_at is null;

-- Daily email cap enforcement.
create index if not exists alert_events_email_sent_idx
  on alert_events (user_id, email_sent_at) where email_sent_at is not null;
