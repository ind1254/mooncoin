-- Pin single-owner deployments to one existing Moonpaper user. The oldest
-- account is the least-surprising default for a personal app that previously
-- allowed password sign-up. Once assigned, later accounts can never replace it.

create table if not exists app_owner (
  singleton  boolean primary key default true check (singleton),
  user_id    uuid not null unique references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

insert into app_owner (singleton, user_id)
select true, id
  from users
 order by created_at asc, id asc
 limit 1
on conflict (singleton) do nothing;
