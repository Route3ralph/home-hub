-- =====================================================================
-- HOME HUB v1.3 — migration 0015: the school's date is the day an assignment was given
-- Apply once, after 0014, and only once the site that understands it is live (docs/v1.3-homework.md §23).
-- The contract is docs/v1.3-homework.md §23.
--
-- Why
--   Some schools' Assignments feed puts each assignment on the day it was ASSIGNED, not the day it is due (a letter
--   given on a Tuesday and due a week later is on the Tuesday). Read as a due date, every such item was past the day
--   after it was given, so it left New from school before anyone saw it, and an assignment made from one was due on
--   the wrong day. The feed has no due date at all for these, so a person gives it when the item becomes homework.
--
-- What it changes
--   • public.school_feeds.date_rule also takes 'assigned': an item's day (its first day, moved date_shift days) is
--     the day it was given. Its due_date column still holds that day (the windows that keep, trim and pair items
--     read it as before); nothing treats it as a due date.
--   • Replaced, with the same signature: public.check_school_feed(uuid, text, int) (the first-import check, and
--     Change dates on a checked link) takes 'assigned' too; private.school_rows (the day by the rule);
--     private.school_apply (an 'assigned' link never moves an assignment's due date: title, class and description
--     still follow the school); private.school_marks (no "moved" from an 'assigned' link); private.school_new (his
--     New from school: from an 'assigned' link, items given from 10 days ago to 30 days on, with assigned: true);
--     public.school_feed_status(uuid) (new and hidden the same way, with assigned: true; no "moved" from one).
--   • Changed signatures (the old ones dropped; every caller passes the new argument by name, or leaves it out):
--       public.school_item_action(p_item uuid, p_action text, p_due date default null)
--       public.school_item_by_token(p_token text, p_item uuid, p_action text, p_minutes int default null, p_due date default null)
--       private.school_assignment(p_item uuid, p_who text, p_due date default null)
--     p_due is the assignment's due date. From an 'assigned' link it is needed (22023 "Choose the due date."), from
--     the day it was given to 120 days from today; from a 'start' or 'end' link it may be left out (the item's date,
--     as before) or given, from 14 days ago to 120 days on.
--   • hub_schema_version() (15).
--
-- Rules
--   • One transaction. It refuses to run without 0014, twice, on a database set back to 14, or on one that isn't as
--     0014 left it.
--   • Additive for a 'start' or 'end' link: every answer is as 0014 gives it (no new key), and a call without p_due
--     does what it did. No table but the check on school_feeds.date_rule; row-level security as 0014 left it.
--   • set search_path = '' on every function; the definer functions as before; revoke then grant, as 0006 does.
--
-- Undo (not needed: no link is 'assigned' until a parent picks it). If wanted: set every 'assigned' link back to
-- 'start' (check_school_feed), then 0014's database again: 0006's school_item_action, school_item_by_token,
-- school_assignment, school_apply, school_marks, school_new and check_school_feed, 0008's school_feed_status and
-- 0009's school_rows (each its "create function" block, with create or replace), the date_rule check as 0006 had it,
-- the three new signatures dropped, 0006's grants for school_item_action and school_item_by_token, and
-- hub_schema_version() returning 14.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0014 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 14 then
    raise exception 'My day''s language switch (migration 0014) isn''t installed (hub_schema_version() is %). Run 0014_day_language.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 15 then
    raise exception 'The school''s assigned dates (migration 0015) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regprocedure('public.school_item_action(uuid, text, date)') is not null then
    raise exception 'The school''s assigned dates (migration 0015) are already installed, but hub_schema_version() was set back to 14. To switch them on again, make hub_schema_version() return 15 (docs/v1.3-homework.md §23). Nothing was changed.';
  end if;
  -- What this migration replaces and reads is as 0014 left it.
  if to_regprocedure('public.set_language_by_token(text, text)') is null
     or to_regprocedure('public.school_item_action(uuid, text)') is null
     or to_regprocedure('public.school_item_by_token(text, uuid, text, int)') is null
     or to_regprocedure('private.school_assignment(uuid, text)') is null
     or to_regprocedure('private.school_apply(uuid)') is null
     or to_regprocedure('private.school_marks(uuid)') is null
     or to_regprocedure('private.school_new(uuid)') is null
     or to_regprocedure('private.school_rows(text, jsonb, text, int, date)') is null
     or to_regprocedure('public.school_feed_status(uuid)') is null
     or to_regprocedure('public.check_school_feed(uuid, text, int)') is null
     or to_regprocedure('public.assignment_by_token(text, text, uuid, text, text, date, int)') is null
     or to_regprocedure('private.homework_kid_by_token(text)') is null
     or to_regprocedure('private.homework_view_kid(uuid, text)') is null
     or to_regprocedure('private.count_homework(uuid, text, int)') is null
     or to_regprocedure('private.homework_trim(uuid)') is null
     or not exists (select 1 from pg_constraint c where c.conrelid = 'public.school_feeds'::regclass and c.conname = 'school_feeds_date_rule_check'
                    and pg_get_constraintdef(c.oid) like '%''start''%''end''%' and pg_get_constraintdef(c.oid) not like '%assigned%') then
    raise exception 'This database isn''t as migration 0014 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The date rule (§23.1)
-- ---------------------------------------------------------------------
alter table public.school_feeds drop constraint school_feeds_date_rule_check;
alter table public.school_feeds add constraint school_feeds_date_rule_check check (date_rule in ('start', 'end', 'assigned'));
-- One read's items as the hub keeps them: 0009's, word for word, but for the day: 'start' and (0015) 'assigned'
-- take an item's first day, 'end' its last; moved p_shift days. For 'assigned' that day is the day it was given,
-- kept in due_date, so the window (from p_today - 14 to p_today + 120) holds what was given in the last two weeks.
create or replace function private.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)
returns table (n bigint, key text, has_uid boolean, title text, subject text, details text,
               first_day date, last_day date, due_date date, starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with raw as (
    select x.n,
           nullif(private.clean_text(x.j ->> 'title', 120), '') as title,
           nullif(private.clean_text(x.j ->> 'subject', 40), '') as subject,
           nullif(private.clean_block(x.j ->> 'details', 4000), '') as details,
           private.safe_date(x.j ->> 'first_day') as f,
           private.safe_date(x.j ->> 'last_day') as l,
           private.safe_instant(x.j ->> 'starts_at') as s,
           private.safe_instant(x.j ->> 'ends_at') as e
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]' end) with ordinality x (j, n)
    where jsonb_typeof(x.j) = 'object'
  ),
  shaped as (
    select r.n, r.title, r.subject, r.details,
           r.f, greatest(coalesce(r.l, r.f), r.f) as l,
           (case when p_rule in ('start', 'assigned') then r.f else greatest(coalesce(r.l, r.f), r.f) end) + coalesce(p_shift, 0) as due,
           r.s, case when r.e >= r.s then r.e end as e
    from raw r
    where r.title is not null
      and case when p_kind = 'assignments' then r.f is not null else r.s is not null end
  ),
  kept as (
    select s.*,
           md5(case when p_kind = 'assignments'
                    then 'title:' || lower(coalesce(s.subject, '')) || E'\n' || lower(s.title) || '|' || to_char(s.f, 'YYYY-MM-DD')
                    else 'title:' || lower(s.title) || '|' || to_char(s.s at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') end) as k
    from shaped s
    where case when p_kind = 'assignments' then s.due between p_today - 14 and p_today + 120
               else (s.s at time zone private.tz())::date between p_today and p_today + 55 end
  )
  select distinct on (k.k) k.n, k.k, false, k.title,
         case when p_kind = 'assignments' then k.subject end,
         case when p_kind = 'assignments' then k.details end,
         case when p_kind = 'assignments' then k.f end,
         case when p_kind = 'assignments' then k.l end,
         case when p_kind = 'assignments' then k.due end,
         case when p_kind <> 'assignments' then k.s end,
         case when p_kind <> 'assignments' then k.e end
  from kept k
  order by k.k, k.n desc;
$$;

-- ---------------------------------------------------------------------
-- An assignment from a school item, with its due date (§23.2)
-- ---------------------------------------------------------------------
-- 0006's, with p_due: the assignment's due date. From an 'assigned' link it is needed ("Choose the due date."), from
-- the day the item was given to today + 120, and the feed never moves it (applied has no due date). From a 'start' or
-- 'end' link it may be left out (the item's date, as 0006 had it) or given, from today - 14 to today + 120. An item
-- made one before answers its assignment, whatever p_due (null if that was deleted since).
drop function private.school_assignment(uuid, text);
create function private.school_assignment(p_item uuid, p_who text, p_due date default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_i     public.school_items;
  v_kid   uuid;
  v_rule  text;
  v_today date := public.today_local();
  v_due   date;
  v_a     public.assignments;
begin
  select i.* into v_i from public.school_items i where i.id = p_item for update;
  if v_i.id is null or v_i.due_date is null then
    raise exception 'That item from school isn''t there any more.' using errcode = '22023';
  end if;
  if v_i.made_at is not null then
    return v_i.assignment_id;
  end if;
  select f.kid_id, f.date_rule into v_kid, v_rule from public.school_feeds f where f.id = v_i.feed_id;
  if v_rule = 'assigned' then
    if p_due is null then
      raise exception 'Choose the due date.' using errcode = '22023';
    end if;
    if p_due < v_i.due_date or p_due > v_today + 120 then
      raise exception 'Choose a due date from the day it was given to 4 months from today.' using errcode = '22023';
    end if;
    v_due := p_due;
  elsif p_due is not null then
    if p_due < v_today - 14 or p_due > v_today + 120 then
      raise exception 'Choose a due date from 2 weeks ago to 4 months from today.' using errcode = '22023';
    end if;
    v_due := p_due;
  else
    v_due := v_i.due_date;
  end if;
  insert into public.assignments (kid_id, kind, added_by, title, subject, due_date, details, created_by, updated_by)
  values (v_kid, 'assignment', 'school', v_i.title, v_i.subject, v_due, v_i.details, p_who, p_who)
  returning * into v_a;
  update public.school_items i
  set assignment_id = v_a.id, made_at = private.now(), hidden = false,
      applied = jsonb_build_object('title', v_a.title, 'subject', v_a.subject,
                                   'due_date', case when v_rule = 'assigned' or v_due is distinct from v_i.due_date then null else v_a.due_date end,
                                   'details', v_a.details)
  where i.id = p_item;
  return v_a.id;
end;
$$;

-- The school's changes reach the open assignments made from a link's items: 0006's, but from an 'assigned' link
-- (0015) the due date is never written (the feed has none): title, class and description follow as before.
create or replace function private.school_apply(p_feed uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  r        record;
  v_ap     jsonb;
  v_title  text;
  v_subj   text;
  v_due    date;
  v_det    text;
  v_plan   boolean;
  v_n      int := 0;
  v_given  boolean := exists (select 1 from public.school_feeds f where f.id = p_feed and f.date_rule = 'assigned');
begin
  for r in
    select i.id as item_id, i.title, i.subject, i.due_date, i.details, coalesce(i.applied, '{}') as applied,
           a.id as aid, a.title as a_title, a.subject as a_subject, a.due_date as a_due, a.details as a_details
    from public.school_items i
    join public.assignments a on a.id = i.assignment_id
    where i.feed_id = p_feed and i.gone_at is null and i.due_date is not null and a.status = 'open'
    order by a.id
    for update of a
  loop
    v_ap := r.applied;
    v_plan := exists (select 1 from public.homework_steps s where s.assignment_id = r.aid);
    v_title := case when r.a_title is not distinct from v_ap ->> 'title' then r.title else r.a_title end;
    v_subj := case when r.a_subject is not distinct from v_ap ->> 'subject' then r.subject else r.a_subject end;
    v_due := case when not v_given and r.a_due is not distinct from (v_ap ->> 'due_date')::date and not v_plan then r.due_date else r.a_due end;
    v_det := case when r.a_details is not distinct from v_ap ->> 'details' then r.details else r.a_details end;
    if v_title is distinct from r.a_title or v_subj is distinct from r.a_subject or v_due is distinct from r.a_due
       or v_det is distinct from r.a_details then
      update public.assignments a
      set title = v_title, subject = v_subj, due_date = v_due, details = v_det, updated_by = 'school link'
      where a.id = r.aid;
      v_n := v_n + 1;
    end if;
    update public.school_items i
    set applied = jsonb_build_object(
          'title', case when v_title is not distinct from r.title then r.title else v_ap ->> 'title' end,
          'subject', case when v_subj is not distinct from r.subject then r.subject else v_ap ->> 'subject' end,
          'due_date', case when v_given then null
                           when v_due is not distinct from r.due_date then r.due_date else (v_ap ->> 'due_date')::date end,
          'details', case when v_det is not distinct from r.details then r.details else v_ap ->> 'details' end)
    where i.id = r.item_id;
  end loop;
  return v_n;
end;
$$;

-- The school's marks on a kid's assignments made from school: 0006's, but (0015) never moved_to from an
-- 'assigned' link, whose date isn't a due date.
create or replace function private.school_marks(p_kid uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(a.id::text, jsonb_build_object(
           'gone', i.gone_at is not null,
           'moved_to', case when f.date_rule <> 'assigned' and i.due_date is distinct from a.due_date
                                 and a.due_date = (i.applied ->> 'due_date')::date
                            then i.due_date end)), '{}')
  from public.school_items i
  join public.school_feeds f on f.id = i.feed_id
  join public.assignments a on a.id = i.assignment_id
  where f.kid_id = p_kid;
$$;

-- His New from school: 0006's, but (0015) from an 'assigned' link the items given from today - 10 to today + 30,
-- each with assigned: true (its due_date is the day it was given; Quick and Plan with Pat ask him for the due date)
-- and quick: false. From a 'start' or 'end' link, exactly 0006's (no assigned key).
create or replace function private.school_new(p_kid uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when exists (select 1 from public.school_feeds f where f.kid_id = p_kid and f.kind = 'assignments' and f.checked) then
    (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subject', x.subject, 'due_date', x.due_date,
                                                  'quick', not x.given and x.due_date - public.today_local() <= 3)
                               || case when x.given then '{"assigned": true}'::jsonb else '{}'::jsonb end
                               order by x.due_date, x.title, x.id), '[]')
     from (select i.id, i.title, i.subject, i.due_date, f.date_rule = 'assigned' as given
           from public.school_items i
           join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.checked
           where i.made_at is null and not i.hidden and i.gone_at is null
             and i.due_date between public.today_local() - case when f.date_rule = 'assigned' then 10 else 0 end
                                and public.today_local() + 30
           order by i.due_date, i.title, i.id
           limit 20) x)
  end;
$$;

-- ---------------------------------------------------------------------
-- The status card (§12.8), replaced: 0008's, word for word, but (0015) from an 'assigned' link new and hidden reach
-- 10 days back and carry assigned: true, and nothing from it is "moved".
-- ---------------------------------------------------------------------
create or replace function public.school_feed_status(p_kid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now   timestamptz := private.now();
  v_today date := public.today_local();
begin
  if not private.is_member() or not exists (select 1 from public.homework_kids k where k.kid_id = p_kid) then
    return null;
  end if;
  return jsonb_build_object(
    'kid_id', p_kid,
    'last_run_at', (select y.last_run_at from private.school_sync y where y.id),
    'feeds', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', f.id, 'kind', f.kind, 'host', f.host, 'url_end', f.url_end, 'checked', f.checked,
                       'date_rule', f.date_rule, 'date_shift', f.date_shift, 'paused', f.paused,
                       'last_try_at', f.last_try_at, 'last_ok_at', f.last_ok_at, 'last_count', f.last_count,
                       'last_repeats', f.last_repeats, 'last_stop', f.last_stop, 'fails', f.fails, 'next_at', f.next_at,
                       'stale', not f.paused and k.active and p.active and coalesce(f.next_at < v_now - interval '2 hours', false))
                     order by case f.kind when 'assignments' then 1 when 'schedule' then 2 else 3 end), '[]')
              from public.school_feeds f
              join public.homework_kids k on k.kid_id = f.kid_id
              join public.people p on p.id = f.kid_id
              where f.kid_id = p_kid and f.removed_at is null),
    'check', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subject', x.subject,
                                                           'first_day', x.first_day, 'last_day', x.last_day, 'due_date', x.due_date,
                                                           'past', x.due_date < v_today)
                                        order by x.due_date, x.title, x.id), '[]')
              from (select i.* from public.school_items i
                    join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and not f.checked
                                                and f.removed_at is null
                    where i.due_date is not null and i.gone_at is null
                    order by i.due_date < v_today, abs(i.due_date - v_today), i.title, i.id limit 5) x),
    'new', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subject', x.subject, 'due_date', x.due_date)
                                      || case when x.given then '{"assigned": true}'::jsonb else '{}'::jsonb end
                                      order by x.due_date, x.title, x.id), '[]')
            from (select i.*, f.date_rule = 'assigned' as given from public.school_items i
                  join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.checked
                                              and f.removed_at is null
                  where i.made_at is null and not i.hidden and i.gone_at is null
                    and i.due_date between v_today - case when f.date_rule = 'assigned' then 10 else 0 end and v_today + 30
                  order by i.due_date, i.title, i.id limit 50) x),
    'hidden', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'subject', i.subject, 'due_date', i.due_date)
                                         || case when f.date_rule = 'assigned' then '{"assigned": true}'::jsonb else '{}'::jsonb end
                                         order by i.due_date, i.title, i.id), '[]')
               from public.school_items i
               join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.removed_at is null
               where i.made_at is null and i.hidden and i.gone_at is null
                 and i.due_date >= v_today - case when f.date_rule = 'assigned' then 10 else 0 end),
    'moved', (select coalesce(jsonb_agg(jsonb_build_object('assignment_id', a.id, 'title', a.title, 'from', a.due_date, 'to', i.due_date)
                                        order by a.due_date, a.title, a.id), '[]')
              from public.school_items i
              join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.date_rule <> 'assigned'
              join public.assignments a on a.id = i.assignment_id and a.status = 'open'
              where i.gone_at is null and i.due_date is distinct from a.due_date and a.due_date = (i.applied ->> 'due_date')::date),
    'gone', (select coalesce(jsonb_agg(jsonb_build_object('assignment_id', a.id, 'title', a.title, 'due_date', a.due_date)
                                       order by a.due_date, a.title, a.id), '[]')
             from public.school_items i
             join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid
             join public.assignments a on a.id = i.assignment_id and a.status = 'open'
             where i.gone_at is not null));
end;
$$;

-- ---------------------------------------------------------------------
-- The first-import check and Change dates (§23.3), replaced
-- ---------------------------------------------------------------------
-- 0006's, but (0015) p_date_rule may be 'assigned': an item's first day, moved p_date_shift days, is the day it was
-- given. Every item's day follows. An assignment already made from the link keeps its due date: from an 'assigned'
-- link the feed never writes one, and (when a link becomes 'assigned') what the feed last wrote there is forgotten,
-- so a later rule doesn't move it either. Answers the status card.
create or replace function public.check_school_feed(p_feed uuid, p_date_rule text, p_date_shift int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.school_feeds;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  select * into v_f from public.school_feeds f where f.id = p_feed for update;
  if v_f.id is null or v_f.removed_at is not null then
    raise exception 'That school link isn''t there any more.' using errcode = '22023';
  end if;
  if v_f.kind <> 'assignments' then
    raise exception 'Only the Assignments link has dates to check.' using errcode = '22023';
  end if;
  if p_date_rule is null or p_date_rule not in ('start', 'end', 'assigned') or p_date_shift is null or p_date_shift not between -1 and 1 then
    raise exception 'Choose the start or the end date, and a shift of -1, 0 or 1 day.' using errcode = '22023';
  end if;
  update public.school_feeds f set date_rule = p_date_rule, date_shift = p_date_shift, checked = true where f.id = p_feed;
  update public.school_items i
  set due_date = (case when p_date_rule in ('start', 'assigned') then i.first_day else i.last_day end) + p_date_shift,
      applied = case when p_date_rule = 'assigned' and i.applied is not null then jsonb_set(i.applied, '{due_date}', 'null') else i.applied end
  where i.feed_id = p_feed and i.first_day is not null;
  perform private.school_apply(p_feed);
  return public.school_feed_status(v_f.kid_id);
end;
$$;

-- ---------------------------------------------------------------------
-- A parent's Add, Hide and Show (§23.2): 0006's, with p_due for Add
-- ---------------------------------------------------------------------
drop function public.school_item_action(uuid, text);
create function public.school_item_action(p_item uuid, p_action text, p_due date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kid uuid;
  v_aid uuid;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('add', 'hide', 'show') then
    raise exception 'Choose add, hide or show.' using errcode = '22023';
  end if;
  select f.kid_id into v_kid
  from public.school_items i join public.school_feeds f on f.id = i.feed_id and f.kind = 'assignments'
  where i.id = p_item;
  if v_kid is null then
    raise exception 'That item from school isn''t there any more.' using errcode = '22023';
  end if;
  if p_action = 'add' then
    v_aid := private.school_assignment(p_item, public.current_email(), p_due);
  else
    update public.school_items i set hidden = (p_action = 'hide') where i.id = p_item and i.made_at is null;
  end if;
  return jsonb_build_object('assignment_id', v_aid) || public.school_feed_status(v_kid);
exception
  when integrity_constraint_violation then
    raise exception 'That can''t be saved.' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------
-- His New from school on My day (§23.2): 0006's, with p_due for Quick and Plan with Pat
-- ---------------------------------------------------------------------
drop function public.school_item_by_token(text, uuid, text, int);
create function public.school_item_by_token(p_token text, p_item uuid, p_action text, p_minutes int default null, p_due date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me    public.people;
  v_i   public.school_items;
  v_aid uuid;
  v_ch  boolean := false;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if p_action is null or p_action not in ('quick', 'with_tutor', 'hide') then
    raise exception 'Choose quick, with_tutor or hide.' using errcode = '22023';
  end if;
  if p_action = 'quick' and (p_minutes is null or p_minutes not between 5 and 60) then
    raise exception 'A step is 5 to 60 minutes.' using errcode = '22023';
  end if;
  select i.* into v_i
  from public.school_items i
  where i.id = p_item
    and exists (select 1 from public.school_feeds f where f.id = i.feed_id and f.kid_id = me.id and f.kind = 'assignments' and f.checked)
  for update;
  if v_i.id is null or v_i.gone_at is not null or (v_i.made_at is not null and v_i.assignment_id is null) then
    raise exception 'That isn''t on your list from school.' using errcode = '42501';
  end if;

  if p_action = 'hide' then
    if v_i.made_at is not null then
      raise exception 'That one is on your homework already.' using errcode = 'P0001';
    end if;
    if not v_i.hidden then
      update public.school_items i set hidden = true where i.id = v_i.id;
      v_ch := true;
    end if;
  else
    if v_i.made_at is null then
      v_aid := private.school_assignment(v_i.id, private.short_name(me) || ' (My day)', p_due);
      v_ch := true;
    else
      v_aid := v_i.assignment_id;
    end if;
    if p_action = 'quick' then
      return public.assignment_by_token(p_token, 'quick', v_aid, null, null, null, p_minutes);
    end if;
  end if;

  if v_ch then
    perform private.count_homework(me.id, 'writes', 150);
  end if;
  perform private.homework_trim(me.id);
  return jsonb_build_object('assignment_id', v_aid) || private.homework_view_kid(me.id, me.language);
exception
  when integrity_constraint_violation then
    raise exception 'That can''t be saved.' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages ask for a due date and offer "the day it was given" only on 15. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 15;
$$;

-- ---------------------------------------------------------------------
-- Function permissions: the new signatures as 0006 grants the old; the replaced functions keep theirs.
-- ---------------------------------------------------------------------
revoke execute on function public.school_item_action(uuid, text, date)                from public, anon, service_role;
grant  execute on function public.school_item_action(uuid, text, date)                to authenticated;
revoke execute on function public.school_item_by_token(text, uuid, text, int, date)   from public, service_role;
grant  execute on function public.school_item_by_token(text, uuid, text, int, date)   to anon, authenticated;
revoke execute on function private.school_assignment(uuid, text, date)               from public, anon, authenticated;

commit;
