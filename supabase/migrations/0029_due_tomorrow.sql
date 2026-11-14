-- =====================================================================
-- HOME HUB v2 — migration 0029: Due tomorrow (an evening email of the kids' homework due the next day)
-- Apply once, after 0028, and only once the site and hub-jobs that understand it are live (docs/v1.3-homework.md §29.4).
-- cron.sql doesn't change: the morning email's run (every 15 minutes) sends it.
-- The contract is docs/v1.3-homework.md §29; the database side is docs/v2-design.md §35.
--
-- Why
--   Nothing told the family, the evening before, what was due at school the next day: the morning email has no
--   homework, and the kid's My day shows it only to the kid. Every evening at a time a parent sets (17:30, say) the
--   hub emails the people a parent ticks (a parent, the other parent, the kid himself) one list per kid with homework
--   on: what is due tomorrow (ticked off when done), what is still open from today or before (and what a parent or
--   the coach marked Missing), and what is due in the three days after (so Friday's shows Monday). On an evening with
--   nothing, it still goes, saying so, so nobody wonders whether it ran.
--
-- What it adds
--   • household.due_at (time; null: off) and household.due_to (uuid[]: who gets it), checked by
--     private.household_due_check() (a trigger): at most 6 people, nobody twice, only people on the family list.
--     Admins change them as they change the rest of the household ("Admins change the household").
--   • notification_log.kind may be 'due': one row per person and evening (local_date: the day it is sent).
--   • public.due_list(p_day date, p_lang text): the email's lists for the evening of p_day, as jsonb.
--     public.due_due(p_limit int): who should get it now. Both for service_role only (hub-jobs: the run, and an
--     admin's Preview through it).
--   • hub_schema_version() (29). Settings shows Due tomorrow only on 29; hub-jobs sends it only on 29.
--
-- Rules
--   • One transaction. It refuses to run without 0028, twice, on a database set back to 28 (the columns already
--     there), or on one that isn't as 0028 left it.
--   • Additive: two columns with defaults that leave it off, a wider check on notification_log, new functions.
--     Nothing that exists changes what it answers.
--   • It names an assignment by its title and class, as the school wrote them, and says whether it's done, Missing,
--     or how far its count has got. Never its text, its plan, a grade, points, a coach's note or anything from the
--     tutor link.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: with due_at null nothing is sent, and every page is as on 28). If wanted, in one go:
--   drop function public.due_due(int);
--   drop function public.due_list(date, text);
--   drop trigger household_due_check on public.household;
--   drop function private.household_due_check();
--   delete from public.notification_log where kind = 'due';
--   alter table public.notification_log drop constraint notification_log_kind_check;
--   alter table public.notification_log add constraint notification_log_kind_check check (kind in ('digest', 'confirm', 'weekly'));
--   alter table public.household drop column due_at, drop column due_to;
--   then 0028's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0028 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 28 then
    raise exception 'Take points (migration 0028) isn''t installed (hub_schema_version() is %). Run 0028_take_points.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 29 then
    raise exception 'Due tomorrow (migration 0029) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.household'::regclass and a.attname = 'due_at' and not a.attisdropped) then
    raise exception 'Due tomorrow (migration 0029) is already installed, but hub_schema_version() was set back to 28. To switch it on again, make hub_schema_version() return 29 (docs/v1.3-homework.md §29). Nothing was changed.';
  end if;
  -- What this migration reads and calls is as 0028 left it.
  if to_regprocedure('public.take_points(uuid, integer, text, uuid)') is null
     or to_regprocedure('public.today_local()') is null
     or to_regprocedure('private.day_label(date, text)') is null
     or to_regprocedure('private.short_name(public.people)') is null
     or to_regprocedure('private.now()') is null
     or to_regprocedure('private.tz()') is null
     or to_regclass('public.homework_kids') is null
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.assignments'::regclass and a.attname = 'count_goal' and not a.attisdropped)
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.assignments'::regclass and a.attname = 'school_mark' and not a.attisdropped)
     or to_regprocedure('public.due_list(date, text)') is not null
     or to_regprocedure('public.due_due(int)') is not null
     or not exists (select 1 from pg_constraint c where c.conrelid = 'public.notification_log'::regclass
                    and c.conname = 'notification_log_kind_check'
                    and pg_get_constraintdef(c.oid) like '%digest%confirm%weekly%'
                    and pg_get_constraintdef(c.oid) not like '%''due''%') then
    raise exception 'This database isn''t as migration 0028 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The settings (§29.1)
-- ---------------------------------------------------------------------
alter table public.household
  add column due_at time,                                  -- every evening at this time (the household's); null: off
  add column due_to uuid[] not null default '{}';          -- who gets it (people with a confirmed address)

-- Who it goes to, checked when it changes (a person removed later is skipped when it's sent, so an unrelated change
-- to the household never fails over one).
create function private.household_due_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.due_to is null or cardinality(new.due_to) > 6 or array_ndims(new.due_to) > 1 then
    raise exception 'Due tomorrow: send it to at most 6 people.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(new.due_to) u (id)
             where u.id is null or not exists (select 1 from public.people p where p.id = u.id)) then
    raise exception 'Due tomorrow: it can go only to people on the family list.' using errcode = '22023';
  end if;
  if (select count(distinct u.id) from unnest(new.due_to) u (id)) <> cardinality(new.due_to) then
    raise exception 'Due tomorrow: someone is on the list twice.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger household_due_check before insert or update of due_at, due_to on public.household
  for each row execute function private.household_due_check();

-- One email an evening per person: local_date is the day it is sent.
alter table public.notification_log drop constraint notification_log_kind_check;
alter table public.notification_log add constraint notification_log_kind_check check (kind in ('digest', 'confirm', 'weekly', 'due'));

-- ---------------------------------------------------------------------
-- The lists (§29.2)
-- ---------------------------------------------------------------------
-- The evening of p_day, in p_lang ('en' or 'es'), for every kid with homework on (homework_kids.active), in the
-- family's order:
--   {day, tomorrow, tomorrow_label, coming_to, coming_to_label,
--    kids: [{id, name (the short name, as the texts use: "Jordan"), tomorrow: [item], late: [item], coming: [item]}]}
--   item: {title, subject, due, due_label, done, missing, count: {goal, done}}   (nulls left out)
-- • tomorrow: due on p_day + 1, open or done (a done one is ticked), never dropped.
-- • late: still open and due on p_day or up to 30 days before (handed in but not ticked shows here too, so it can be
--   ticked), or open and marked Missing whatever its due date, as long as that isn't after p_day.
-- • coming: open and due in the 3 days after tomorrow.
-- An assignment and a lesson (its "do by" day) alike; each list in due order, then title.
create function public.due_list(p_day date, p_lang text default 'en')
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with l as (select case when p_lang = 'es' then 'es' else 'en' end as lang),
  item as (
    select a.id, a.kid_id, a.due_date, a.title, a.status, a.school_mark,
           jsonb_strip_nulls(jsonb_build_object(
             'title', a.title, 'subject', nullif(btrim(coalesce(a.subject, '')), ''),
             'due', a.due_date, 'due_label', private.day_label(a.due_date, (select lang from l)),
             'done', case when a.status = 'done' then true end,
             'missing', case when a.school_mark = 'missing' then true end,
             'count', case when a.count_goal is not null then jsonb_build_object('goal', a.count_goal, 'done', a.count_done) end)) as j
    from public.assignments a
    where a.status <> 'dropped' and a.due_date is not null
  ),
  kid as (
    select p.id, private.short_name(p) as name, p.name as full_name, p.sort_order
    from public.people p
    join public.homework_kids k on k.kid_id = p.id
    where k.active and p.active
  )
  select jsonb_build_object(
    'day', p_day,
    'tomorrow', p_day + 1, 'tomorrow_label', private.day_label(p_day + 1, (select lang from l)),
    'coming_to', p_day + 4, 'coming_to_label', private.day_label(p_day + 4, (select lang from l)),
    'kids', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', kid.id, 'name', kid.name,
        'tomorrow', coalesce((select jsonb_agg(i.j order by i.due_date, i.title, i.id) from item i
                              where i.kid_id = kid.id and i.due_date = p_day + 1), '[]'::jsonb),
        'late', coalesce((select jsonb_agg(i.j order by i.due_date, i.title, i.id) from item i
                          where i.kid_id = kid.id and i.status = 'open' and i.due_date <= p_day
                            and (i.due_date >= p_day - 30 or i.school_mark = 'missing')), '[]'::jsonb),
        'coming', coalesce((select jsonb_agg(i.j order by i.due_date, i.title, i.id) from item i
                            where i.kid_id = kid.id and i.status = 'open'
                              and i.due_date between p_day + 2 and p_day + 4), '[]'::jsonb))
        order by kid.sort_order, kid.full_name, kid.id)
      from kid), '[]'::jsonb));
$$;

-- Who should get it now: everyone on due_to who is active with a confirmed address, once due_at has passed today
-- (the household's day and zone), while some kid has homework on. Rows already sent, skipped, in flight or out of
-- attempts are left out (as digest_due and weekly_due).
create function public.due_due(p_limit int default 20)
returns table (person_id uuid, local_date date, kind text)
language sql
stable
security invoker
set search_path = ''
as $$
  with c as (
    select private.now() as now, public.today_local() as today, private.tz() as tz, h.due_at, h.due_to
    from public.household h
  )
  select p.id, c.today, 'due'::text
  from c
  join public.people p on p.id = any (c.due_to)
  where c.due_at is not null
    and (c.today + c.due_at) at time zone c.tz <= c.now
    and exists (select 1 from public.homework_kids k join public.people kp on kp.id = k.kid_id where k.active and kp.active)
    and p.active and p.email is not null and p.email_verified_at is not null
    and not exists (select 1 from public.notification_log n
                    where n.person_id = p.id and n.local_date = c.today
                      and n.kind = 'due' and n.channel = 'email'
                      and not (n.attempts < 3
                               and (n.status = 'failed'
                                    or (n.status = 'sending' and n.claimed_at < c.now - interval '10 minutes'))))
  order by p.sort_order, p.name, p.id
  limit greatest(coalesce(p_limit, 20), 0);
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
-- New functions start out executable by PUBLIC.
revoke execute on function private.household_due_check() from public, anon, authenticated;
revoke execute on function public.due_list(date, text)   from public, anon, authenticated;
revoke execute on function public.due_due(int)           from public, anon, authenticated;
grant  execute on function public.due_list(date, text)   to service_role;
grant  execute on function public.due_due(int)           to service_role;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- Settings shows Due tomorrow, and hub-jobs sends it, only on 29. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 29;
$$;

commit;
