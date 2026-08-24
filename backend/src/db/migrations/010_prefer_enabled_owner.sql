-- Migration 009 initially chose the oldest account. Existing personal
-- deployments may contain an early throwaway account from manual QA. If one
-- account has explicitly enabled Bot Lab, that is the strongest durable signal
-- of the real personal account and should own the new integration key.

with enabled_owner as (
  select u.id
    from users u
    join paper_bot_configs c on c.user_id = u.id and c.enabled = true
   order by u.created_at asc, u.id asc
   limit 1
)
update app_owner o
   set user_id = enabled_owner.id
  from enabled_owner
 where o.singleton = true
   and o.user_id <> enabled_owner.id;
