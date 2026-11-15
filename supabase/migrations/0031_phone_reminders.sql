-- =====================================================================
-- HOME HUB v2 — migration 0031: Phone reminders (a notification on a kid's phone with his homework due tomorrow)
-- Apply once, after 0030, and only once the site and hub-jobs that understand it are live (docs/v1.3-homework.md §31.5).
-- cron.sql doesn't change: the morning email's run (every 15 minutes) sends them.
-- The contract is docs/v1.3-homework.md §31; the database side is docs/v2-design.md §37.
--
-- Why
--   A parent asked for reminders on the kid's iPhone, not only an email. A web page can't write to the phone's
--   Reminders app, but a Home Screen web app can get notifications (iOS 16.4 and later): the kid adds his My day to
--   the Home Screen, opens it from there and taps Turn on reminders. Every day at the time a parent sets, the hub
--   sends one notification: what is due tomorrow and not done yet, and how many are not marked done.
--
-- What it adds
--   • public.push_subscriptions: one row per phone (or browser) a kid turned reminders on in, with the push
--     service's address and the two keys the notification is sealed with. Nobody signed in or out reads it.
--   • household.push_at (time; null: off): when they go out, the household's time. Admins set it on Settings, as
--     they change the rest of the household.
--   • public.push_by_token(p_token, p_action, p_endpoint, p_p256dh, p_auth): his My day turns reminders on ('on')
--     or off ('off') for this phone, or asks whether they're on ('status'). Anon, for a kid with homework on only.
--     The address must be one of the push services' (Apple's, Google's, Mozilla's, Microsoft's): hub-jobs posts to
--     it, so nothing else may be written there. At most 3 phones a kid.
--   • private.homework_view_kid(p_kid, p_lang): 0026's (moved to private.homework_view_kid_v30, unchanged), with
--     reminders: {at} (push_at as 'HH:MM') once a parent has set the time, so his My day shows the card only then
--     and asks nothing before (with push_at null his view is exactly 0026's).
--   • public.push_people(): Settings' list of who turned them on (name, phones, last sent), for admins.
--   • public.push_due(p_limit), push_claim(p_person, p_day), push_targets(p_person), push_result(p_endpoint, p_status):
--     hub-jobs' side, for service_role only. Each day's reminder is a notification_log row (kind 'due', channel
--     'push'), so it goes once a day and the Due tomorrow email (channel 'email') is untouched.
--   • hub_schema_version() (31). My day and Settings show reminders only on 31; hub-jobs sends them only on 31.
--
-- Rules
--   • One transaction. It refuses to run without 0030, twice, on a database set back to 30 (the table already
--     there), or on one that isn't as 0030 left it.
--   • Additive: a new table nobody reads through the API, one column that leaves it off, new functions.
--   • A reminder names an assignment by its title as the school wrote it. Never its text, plan, grade or points.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: with push_at null nothing is sent). If wanted, in one go:
--   drop function public.push_result(text, text);
--   drop function public.push_targets(uuid);
--   drop function public.push_claim(uuid, date);
--   drop function public.push_due(int);
--   drop function public.push_people();
--   drop function public.push_by_token(text, text, text, text, text);
--   drop function private.homework_view_kid(uuid, text);
--   alter function private.homework_view_kid_v30(uuid, text) rename to homework_view_kid;
--   delete from public.notification_log where channel = 'push';
--   drop table public.push_subscriptions;
--   alter table public.household drop column push_at;
--   then 0030's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0030 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 30 then
    raise exception 'Adding school items automatically (migration 0030) isn''t installed (hub_schema_version() is %). Run 0030_school_auto_add.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 31 then
    raise exception 'Phone reminders (migration 0031) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.push_subscriptions') is not null then
    raise exception 'Phone reminders (migration 0031) are already installed, but hub_schema_version() was set back to 30. To switch them on again, make hub_schema_version() return 31 (docs/v1.3-homework.md §31). Nothing was changed.';
  end if;
  -- What this migration reads and calls is as 0030 left it.
  if to_regprocedure('public.set_school_auto_add(uuid, boolean)') is null
     or to_regprocedure('private.homework_kid_by_token(text)') is null
     or to_regprocedure('private.count_homework(uuid, text, integer)') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('private.now()') is null
     or to_regprocedure('private.tz()') is null
     or to_regprocedure('public.today_local()') is null
     or to_regprocedure('public.due_list(date, text)') is null
     or to_regprocedure('public.push_by_token(text, text, text, text, text)') is not null
     or to_regprocedure('public.push_due(integer)') is not null
     or to_regprocedure('private.homework_view_kid(uuid, text)') is null
     or to_regprocedure('private.homework_view_kid_v30(uuid, text)') is not null
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.household'::regclass and a.attname = 'push_at' and not a.attisdropped)
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.notification_log'::regclass and a.attname = 'channel' and not a.attisdropped) then
    raise exception 'This database isn''t as migration 0030 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The phones (§31.2)
-- ---------------------------------------------------------------------
-- The push service's address for one phone, and the keys its notifications are sealed with (RFC 8291). Only the push
-- services' own hosts: hub-jobs posts to the address.
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.people (id) on delete cascade,
  endpoint    text not null unique
              check (length(endpoint) <= 1000
                     and endpoint ~ '^https://(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)/[A-Za-z0-9_./:=%+~-]+$'),
  p256dh      text not null check (p256dh ~ '^[A-Za-z0-9_-]{86,88}={0,2}$'),
  auth        text not null check (auth ~ '^[A-Za-z0-9_-]{21,24}={0,2}$'),
  created_at  timestamptz not null default private.now(),
  last_ok_at  timestamptz,
  fails       int not null default 0
);
create index push_subscriptions_person on public.push_subscriptions (person_id);
alter table public.push_subscriptions enable row level security;
-- No policies: only the functions below read or write it.
revoke all on public.push_subscriptions from public, anon, authenticated;

alter table public.household add column push_at time;   -- every day at this time (the household's); null: off

-- ---------------------------------------------------------------------
-- His My day (§31.3)
-- ---------------------------------------------------------------------
-- 'status': are reminders on for this phone (p_endpoint, or null when it has none yet), and when they go.
-- 'on': keep this phone's address and keys (a phone already kept moves to him); at most 3 a kid, the oldest let go.
-- 'off': let this phone go (or every phone of his, with no address).
create function public.push_by_token(p_token text, p_action text, p_endpoint text default null,
                                     p_p256dh text default null, p_auth text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me   public.people;
  v_at time;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if p_action is null or p_action not in ('status', 'on', 'off') then
    raise exception 'Choose on, off or status.' using errcode = '22023';
  end if;
  if p_action = 'on' then
    if p_endpoint is null or p_p256dh is null or p_auth is null then
      raise exception 'This phone didn''t give what reminders need. Try again.' using errcode = '22023';
    end if;
    perform private.count_homework(me.id, 'writes', 150);
    insert into public.push_subscriptions as s (person_id, endpoint, p256dh, auth)
    values (me.id, p_endpoint, p_p256dh, p_auth)
    on conflict (endpoint) do update set person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth, fails = 0;
    delete from public.push_subscriptions s
    where s.person_id = me.id
      and s.id not in (select x.id from public.push_subscriptions x where x.person_id = me.id order by x.created_at desc, x.id limit 3);
  elsif p_action = 'off' then
    perform private.count_homework(me.id, 'writes', 150);
    delete from public.push_subscriptions s where s.person_id = me.id and (p_endpoint is null or s.endpoint = p_endpoint);
  end if;
  select h.push_at into v_at from public.household h limit 1;
  return jsonb_build_object(
    'on', p_endpoint is not null and exists (select 1 from public.push_subscriptions s where s.person_id = me.id and s.endpoint = p_endpoint),
    'at', to_char(v_at, 'HH24:MI'));
exception
  -- A constraint's DETAIL is the whole row: never to a link.
  when integrity_constraint_violation then
    raise exception 'This phone''s reminder address isn''t one Home Hub can use.' using errcode = '22023';
end;
$$;

-- His homework view (every token writer answers it): 0026's, with reminders: {at} while push_at is set. His My day shows
-- the card only where the key is, so a database before 31, or with reminders off, is asked nothing.
alter function private.homework_view_kid(uuid, text) rename to homework_view_kid_v30;
create function private.homework_view_kid(p_kid uuid, p_lang text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v    jsonb := private.homework_view_kid_v30(p_kid, p_lang);
  v_at text;
begin
  if v is null or jsonb_typeof(v) <> 'object' then
    return v;
  end if;
  select to_char(h.push_at, 'HH24:MI') into v_at from public.household h limit 1;
  if v_at is null then
    return v;   -- reminders off: his view exactly as 0026 left it
  end if;
  return v || jsonb_build_object('reminders', jsonb_build_object('at', v_at));
end;
$$;

-- ---------------------------------------------------------------------
-- Settings (§31.4)
-- ---------------------------------------------------------------------
-- Who turned reminders on: each person with a phone kept, how many, and when one was last sent. Admins only.
create function public.push_people()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only a parent can see this.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('person_id', p.id, 'name', p.name, 'phones', x.n, 'last_ok_at', x.last_ok_at)
                     order by p.sort_order, p.name, p.id)
    from public.people p
    join (select s.person_id, count(*) as n, max(s.last_ok_at) as last_ok_at from public.push_subscriptions s group by s.person_id) x
      on x.person_id = p.id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- hub-jobs (§31.5)
-- ---------------------------------------------------------------------
-- Who should get today's reminder now: a kid with homework on and a phone kept, once today + push_at (the household's
-- zone) has passed and within 3 hours of it, not yet sent today (a failed one, or one stuck sending 10 minutes,
-- retried up to 3 times).
create function public.push_due(p_limit int default 20)
returns table (person_id uuid, local_date date, kind text)
language sql
stable
security invoker
set search_path = ''
as $$
  with c as (
    select private.now() as now, public.today_local() as today, private.tz() as tz, h.push_at
    from public.household h
  )
  select p.id, c.today, 'due'::text
  from c
  join public.people p on p.active and p.role = 'kid'
  where c.push_at is not null
    and (c.today + c.push_at) at time zone c.tz <= c.now
    and (c.today + c.push_at) at time zone c.tz > c.now - interval '3 hours'
    and exists (select 1 from public.homework_kids k where k.kid_id = p.id and k.active)
    and exists (select 1 from public.push_subscriptions s where s.person_id = p.id)
    and not exists (select 1 from public.notification_log n
                    where n.person_id = p.id and n.local_date = c.today
                      and n.kind = 'due' and n.channel = 'push'
                      and not (n.attempts < 3
                               and (n.status = 'failed'
                                    or (n.status = 'sending' and n.claimed_at < c.now - interval '10 minutes'))))
  order by p.sort_order, p.name, p.id
  limit greatest(coalesce(p_limit, 20), 0);
$$;

-- Claim today's reminder before sending it (as claim_notification does for an email). Null: already sent, being sent,
-- or out of attempts. finish_notification closes it.
create function public.push_claim(p_person uuid, p_day date)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  insert into public.notification_log as n (person_id, local_date, kind, channel, status, attempts, claimed_at)
  values (p_person, p_day, 'due', 'push', 'sending', 1, private.now())
  on conflict (person_id, local_date, kind, channel) do update
    set status = 'sending', attempts = n.attempts + 1, claimed_at = private.now(), detail = null
    where n.attempts < 3
      and (n.status = 'failed' or (n.status = 'sending' and n.claimed_at < private.now() - interval '10 minutes'))
  returning n.id;
$$;

-- His phones, to send to, with his My day code for the notification's link.
create function public.push_targets(p_person uuid)
returns table (endpoint text, p256dh text, auth text, day_token text)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.endpoint, s.p256dh, s.auth, p.day_token
  from public.push_subscriptions s
  join public.people p on p.id = s.person_id
  where s.person_id = p_person
  order by s.created_at, s.id;
$$;

-- What the push service said: 'ok' (kept, fails back to 0), 'gone' (the phone let it go: 404 or 410, so it's deleted),
-- 'failed' (kept, counted; after 10 in a row it's deleted).
create function public.push_result(p_endpoint text, p_status text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('ok', 'gone', 'failed') then
    raise exception 'push_result: status must be ok, gone or failed.' using errcode = '22023';
  end if;
  if p_status = 'ok' then
    update public.push_subscriptions s set last_ok_at = private.now(), fails = 0 where s.endpoint = p_endpoint;
  elsif p_status = 'gone' then
    delete from public.push_subscriptions s where s.endpoint = p_endpoint;
  else
    update public.push_subscriptions s set fails = s.fails + 1 where s.endpoint = p_endpoint;
    delete from public.push_subscriptions s where s.endpoint = p_endpoint and s.fails >= 10;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.homework_view_kid(uuid, text)               from public, anon, authenticated;
revoke execute on function public.push_by_token(text, text, text, text, text) from public, service_role;
grant  execute on function public.push_by_token(text, text, text, text, text) to anon, authenticated;
revoke execute on function public.push_people()                               from public, anon, service_role;
grant  execute on function public.push_people()                               to authenticated;
revoke execute on function public.push_due(int)                               from public, anon, authenticated;
revoke execute on function public.push_claim(uuid, date)                      from public, anon, authenticated;
revoke execute on function public.push_targets(uuid)                          from public, anon, authenticated;
revoke execute on function public.push_result(text, text)                     from public, anon, authenticated;
grant  execute on function public.push_due(int)                               to service_role;
grant  execute on function public.push_claim(uuid, date)                      to service_role;
grant  execute on function public.push_targets(uuid)                          to service_role;
grant  execute on function public.push_result(text, text)                     to service_role;
grant  select, insert, update, delete on public.push_subscriptions           to service_role;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- My day and Settings show reminders only on 31; hub-jobs sends them only on 31. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 31;
$$;

commit;
