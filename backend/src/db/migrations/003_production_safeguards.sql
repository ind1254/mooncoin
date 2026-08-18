-- Part 4: durable abuse controls and retry-safe paper entries.
--
-- Rate-limit subjects are one-way SHA-256 identifiers (normalized email or
-- authenticated user id), never raw credentials, cookies, or IP addresses.

create table if not exists rate_limit_buckets (
  scope             text not null,
  subject_hash      text not null check (length(subject_hash) = 64),
  window_started_at timestamptz not null,
  request_count     integer not null check (request_count > 0),
  expires_at        timestamptz not null,
  primary key (scope, subject_hash, window_started_at)
);

create index if not exists rate_limit_buckets_expires_at_idx
  on rate_limit_buckets (expires_at);

-- A browser-generated UUID identifies one intended paper entry. Replaying the
-- same request returns the original position and can never debit cash twice.
alter table paper_positions
  add column if not exists client_request_id uuid;

create unique index if not exists paper_positions_portfolio_request_key
  on paper_positions (portfolio_id, client_request_id)
  where client_request_id is not null;
