-- One bounded worker pass is invoked by Vercel Cron each minute.
--
-- Vercel may overlap or duplicate cron deliveries. This single-row lease is
-- both a distributed lock and an idempotency record: last_run_key prevents the
-- same scheduled minute from being claimed twice, while lease_expires_at lets
-- a later invocation recover if a function is terminated mid-pass.

create table if not exists worker_leases (
  name              text primary key check (length(name) between 1 and 120),
  owner_id          uuid not null,
  last_run_key      text not null check (length(last_run_key) between 1 and 160),
  lease_expires_at  timestamptz not null,
  started_at        timestamptz not null,
  completed_at      timestamptz,
  last_status       text check (last_status in ('completed', 'degraded', 'failed')),
  last_summary      jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(last_summary) = 'object'),
  updated_at        timestamptz not null default now()
);

create index if not exists worker_leases_expiry_idx
  on worker_leases (lease_expires_at);
