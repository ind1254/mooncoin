-- Durable, per-account preferences.
--
-- The original settings endpoint wrote one process-local JSON file. That is
-- neither user-scoped nor durable on a serverless deployment. Keep the compact
-- settings document here while watchlist items, positions, bot decisions and
-- alerts remain in their purpose-built relational tables.
create table if not exists user_settings (
  user_id     uuid primary key references users(id) on delete cascade,
  settings    jsonb not null default '{}'::jsonb
              check (jsonb_typeof(settings) = 'object'),
  updated_at  timestamptz not null default now()
);
