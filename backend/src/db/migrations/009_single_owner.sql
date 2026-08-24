-- Pin single-owner deployments to one existing Moonpaper user. An explicitly
-- enabled Bot Lab is the strongest signal; otherwise the oldest account is the
-- least-surprising default. Later accounts can never replace this assignment.

create table if not exists app_owner (
  singleton  boolean primary key default true check (singleton),
  user_id    uuid not null unique references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

insert into app_owner (singleton, user_id)
select true, u.id
  from users u
  left join paper_bot_configs c on c.user_id = u.id
 order by coalesce(c.enabled, false) desc, u.created_at asc, u.id asc
 limit 1
on conflict (singleton) do nothing;
