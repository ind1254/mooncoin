-- Part 5: email verification and password recovery.
--
-- Existing accounts are trusted during rollout so a deployment cannot lock
-- out current users. New accounts explicitly write NULL until their email is
-- verified (when verification is enabled by configuration).

alter table users
  add column if not exists email_verified_at timestamptz;

update users
   set email_verified_at = now()
 where email_verified_at is null;

create table if not exists account_action_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  purpose     text not null check (purpose in ('verify_email', 'reset_password')),
  -- SHA-256 only. The raw bearer token exists in one email link and is never
  -- stored, returned by an account API, or written to logs.
  token_hash  text not null unique check (length(token_hash) = 64),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);

create index if not exists account_action_tokens_user_purpose_idx
  on account_action_tokens (user_id, purpose, created_at desc);

create index if not exists account_action_tokens_expires_at_idx
  on account_action_tokens (expires_at);
