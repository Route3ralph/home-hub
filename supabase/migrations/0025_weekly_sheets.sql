-- =====================================================================
-- HOME HUB v2 — migration 0025: the Sunday sheets (the coming week, printed: the family's, the helper's, a kid's)
-- Apply once, after 0024, and only once the site and hub-jobs that understand it are live (docs/v2-design.md §31.6).
-- cron.sql doesn't change: the morning email's run (every 15 minutes) sends it.
-- The contract is docs/v2-design.md §31.
--
-- Why
--   The week was written out by hand for the fridge. On Sunday afternoon the hub emails the coming week, Monday to
--   Sunday, ready to print, one sheet to a page: the family's week in seven columns, and a sheet for each person a
--   parent picks (the helper's rides, chores and shopping list; a kid's events, homework due, each day's study steps
--   and his routine to tick), each in the language the parent picks for it.
--
-- What it adds
--   • household.weekly_at (time; null: off), household.weekly_to (uuid[]: who gets the email) and
--     household.weekly_sheets (jsonb: [{"who": "family" | <a person's id>, "lang": "en" | "es"}], in order), checked
--     by private.household_weekly_check() (a trigger): at most 8 sheets, nobody twice, only people on the family list;
--     at most 6 people to send to. Admins change them as they change the rest of the household ("Admins change the
--     household").
--   • notification_log.kind may be 'weekly': one row per person and week (local_date: the Monday it starts).
--   • private.weekly_item(a, p_person, p_lang): one item of a sheet's day.
--   • public.weekly_sheet(p_who uuid, p_monday date, p_lang text): one sheet's week as jsonb (p_who null: the
--     family's). public.weekly_due(p_limit int): who should get the Sunday email now. Both for service_role only
--     (hub-jobs: the run, and an admin's Preview through it).
--   • hub_schema_version() (25). Settings shows Sunday sheets only on 25; hub-jobs sends them only on 25.
--
-- Rules
--   • One transaction. It refuses to run without 0024, twice, on a database set back to 24 (the columns already
--     there), or on one that isn't as 0024 left it.
--   • Additive: three columns with defaults that leave it off, a wider check on notification_log, new functions.
--     Nothing that exists changes what it answers.
--   • A person's sheet shows what their My day shows; the family's sheet, for the fridge, what the wall shows (a
--     private item or a health task reads "Private item", and no note or phone number). Neither shows homework's
--     Missing or Graded, points, a coach's note, or a private shopping item.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: with weekly_at null nothing is sent, and every page is as on 24). If wanted, in one go:
--   revoke execute on function private.routine_school_day(date) from service_role;
--   drop function public.weekly_due(int);
--   drop function public.weekly_sheet(uuid, date, text);
--   drop function private.weekly_item(public.agenda_item, uuid, text);
--   drop trigger household_weekly_check on public.household;
--   drop function private.household_weekly_check();
--   delete from public.notification_log where kind = 'weekly';
--   alter table public.notification_log drop constraint notification_log_kind_check;
--   alter table public.notification_log add constraint notification_log_kind_check check (kind in ('digest', 'confirm'));
--   alter table public.household drop column weekly_at, drop column weekly_to, drop column weekly_sheets;
--   then 0024's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0024 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 24 then
    raise exception 'Selections (migration 0024) aren''t installed (hub_schema_version() is %). Run 0024_project_selections.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 25 then
    raise exception 'The Sunday sheets (migration 0025) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.household'::regclass and a.attname = 'weekly_sheets' and not a.attisdropped) then
    raise exception 'The Sunday sheets (migration 0025) are already installed, but hub_schema_version() was set back to 24. To switch them on again, make hub_schema_version() return 25 (docs/v2-design.md §31). Nothing was changed.';
  end if;
  -- What this migration reads and calls is as 0024 left it.
  if to_regclass('public.project_selections') is null
     or to_regprocedure('public.agenda(date, date)') is null
     or to_regprocedure('public.google_items(date, date)') is null
     or to_regprocedure('public.today_local()') is null
     or to_regprocedure('private.person_items(uuid, date)') is null
     or to_regprocedure('private.task_item(public.tasks, date, text)') is null
     or to_regprocedure('private.current_due(public.tasks)') is null
     or to_regprocedure('private.series_on_or_before(public.tasks, date)') is null
     or to_regprocedure('private.item_order(public.agenda_item)') is null
     or to_regprocedure('private.who_text(public.agenda_item, uuid, text)') is null
     or to_regprocedure('private.bring_of(uuid, date)') is null
     or to_regprocedure('private.time_label(time, text)') is null
     or to_regprocedure('private.day_label(date, text)') is null
     or to_regprocedure('private.short_date(date, text)') is null
     or to_regprocedure('private.short_name(public.people)') is null
     or to_regprocedure('private.names(uuid[])') is null
     or to_regprocedure('private.word(text, text)') is null
     or to_regprocedure('private.food_word(text, text)') is null
     or to_regprocedure('private.meal_title(public.meals, text)') is null
     or to_regprocedure('private.routine_school_day(date)') is null
     or to_regprocedure('private.now()') is null
     or to_regprocedure('private.tz()') is null
     or to_regprocedure('private.weekly_item(public.agenda_item, uuid, text)') is not null
     or to_regprocedure('public.weekly_sheet(uuid, date, text)') is not null
     or to_regprocedure('public.weekly_due(int)') is not null
     or not exists (select 1 from pg_constraint c where c.conrelid = 'public.notification_log'::regclass
                    and c.conname = 'notification_log_kind_check'
                    and pg_get_constraintdef(c.oid) like '%digest%confirm%'
                    and pg_get_constraintdef(c.oid) not like '%weekly%') then
    raise exception 'This database isn''t as migration 0024 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The settings (§31.1)
-- ---------------------------------------------------------------------
alter table public.household
  add column weekly_at     time,                                    -- Sunday at this time (the household's); null: off
  add column weekly_to     uuid[] not null default '{}',            -- who gets the email (people with a confirmed address)
  add column weekly_sheets jsonb  not null default '[]';            -- [{"who": "family" | <person id>, "lang": "en" | "es"}]

-- The sheets and who they go to, checked when they change (a person removed later is skipped when it's sent, so an
-- unrelated change to the household never fails over one).
create function private.household_weekly_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  x     jsonb;
  v_who text;
  v_seen text[] := '{}';
begin
  if new.weekly_sheets is null or jsonb_typeof(new.weekly_sheets) <> 'array' then
    raise exception 'Sunday sheets: the sheets must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(new.weekly_sheets) > 8 then
    raise exception 'Sunday sheets: at most 8 sheets.' using errcode = '22023';
  end if;
  for x in select e.value from jsonb_array_elements(new.weekly_sheets) e loop
    if jsonb_typeof(x) is distinct from 'object' or (x - 'who' - 'lang') <> '{}'::jsonb
       or jsonb_typeof(x -> 'who') is distinct from 'string' or jsonb_typeof(x -> 'lang') is distinct from 'string'
       or (x ->> 'lang') not in ('en', 'es') then
      raise exception 'Sunday sheets: each sheet is {"who": "family" or a person''s id, "lang": "en" or "es"}.' using errcode = '22023';
    end if;
    v_who := x ->> 'who';
    if v_who <> 'family'
       and (v_who !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            or not exists (select 1 from public.people p where p.id = v_who::uuid)) then
      raise exception 'Sunday sheets: a sheet is for someone who isn''t on the family list.' using errcode = '22023';
    end if;
    if v_who = any (v_seen) then
      raise exception 'Sunday sheets: a sheet is listed twice.' using errcode = '22023';
    end if;
    v_seen := v_seen || v_who;
  end loop;
  if new.weekly_to is null or cardinality(new.weekly_to) > 6 or array_ndims(new.weekly_to) > 1 then
    raise exception 'Sunday sheets: send them to at most 6 people.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(new.weekly_to) u (id)
             where u.id is null or not exists (select 1 from public.people p where p.id = u.id)) then
    raise exception 'Sunday sheets: they can go only to people on the family list.' using errcode = '22023';
  end if;
  if (select count(distinct u.id) from unnest(new.weekly_to) u (id)) <> cardinality(new.weekly_to) then
    raise exception 'Sunday sheets: someone is on the list twice.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger household_weekly_check before insert or update of weekly_at, weekly_to, weekly_sheets on public.household
  for each row execute function private.household_weekly_check();

-- One email a week per person: local_date is the Monday the week starts.
alter table public.notification_log drop constraint notification_log_kind_check;
alter table public.notification_log add constraint notification_log_kind_check check (kind in ('digest', 'confirm', 'weekly'));

-- ---------------------------------------------------------------------
-- A sheet (§31.2)
-- ---------------------------------------------------------------------
-- One item of a sheet's day. A person's sheet (p_person) shows what their My day does: who else is on it (who_text),
-- the place, the contractor and phone, the day's note and Bring; a private item is "Private item" with its time only.
-- The family's sheet (p_person null) goes on the fridge, so it shows what the wall does: who's in charge "with" the
-- others, the place and Bring, never a note or a phone number; a private item, a health task and Google's private
-- events are "Private item" with the time only. color: the person in charge's.
create function private.weekly_item(a public.agenda_item, p_person uuid, p_lang text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'kind', a.kind,
    'time', private.time_label(a.local_start, p_lang),
    'end', case when not h.hide and a.local_start is not null and a.local_end is not null and a.local_end <> a.local_start
                then private.time_label(a.local_end, p_lang) end,
    'all_day', a.local_start is null and a.kind in ('event', 'google'),
    'title', case when h.hide then private.word('private_item', p_lang)
                  when a.kind = 'project' then concat_ws(': ', a.project_name, a.title)
                  else a.title end,
    'who', case when not h.hide then private.who_text(a, p_person, p_lang) end,
    'color', (select p.color from public.people p where p.id = a.responsible_id and p.active),
    'place', case when not h.hide then nullif(a.location, '') end,
    'contractor', case when h.hide then null
                       when p_person is null then nullif(a.contractor_name, '')
                       else nullif(concat_ws(' ', a.contractor_name, a.contractor_phone), '') end,
    'note', case when not h.hide and p_person is not null then a.day_note end,
    'bring', case when a.kind = 'event' and not h.hide then private.bring_of(a.item_id, a.occurrence) end,
    'task', a.kind = 'task',
    'done', a.status in ('done', 'skipped')))
  from (select coalesce(a.private, false)
               or (p_person is null and a.kind = 'task' and a.category is not distinct from 'health') as hide) h;
$$;

-- One sheet's week, Monday p_monday to Sunday, in p_lang ('es', else English), for hub-jobs to lay out:
--   {who: 'family' | <id>, name, role, lang, monday, sunday, range: "Nov 16 – Nov 22",
--    people: [{name, color}]              the family's sheet only: the key to the colors
--    days: [{day, label, day_off, items: [weekly_item], meals: [{slot, title, who}]}] × 7
--    homework: [{title, subject, kind, due, due_label, steps: [{day, label, title, kind, minutes, done}]}]   a kid's
--    routine: [{title, note, items: [{title, tag, part, days: [bool × 7]}]}]                                  a kid's
--    shopping: [{name, note}]}                                                     the helper's, unless the list is off
-- A person's day is their items as My day has them (private.person_items: theirs, not cancelled, with the Google
-- events that reach them), plus their chores on set dates that fall that day (as tomorrow_text: agenda() puts an
-- open chore on its current date only). The family's day is everything on the calendar that day, not cancelled,
-- and every Google event read that day. Homework: his open assignments with a plan given to him that are due that
-- week or have a step still to do that week, with that week's steps; never Missing, Graded or points. Null for
-- someone who isn't active on the family list. Runs with the caller's rights; service_role only (hub-jobs).
create function public.weekly_sheet(p_who uuid, p_monday date, p_lang text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  lang     text := case when p_lang = 'es' then 'es' else 'en' end;
  me       public.people;
  v_sunday date;
  v_kid    boolean := false;
  v_helper boolean := false;
  v_off    date[] := coalesce((select h.days_off from public.household h), '{}');
  v_days   jsonb := '[]';
  d        date;
  v_items  jsonb;
  v_meals  jsonb;
begin
  if p_monday is null or extract(isodow from p_monday) <> 1 then
    raise exception 'A week''s sheet starts on a Monday.' using errcode = '22023';
  end if;
  v_sunday := p_monday + 6;
  if p_who is not null then
    select * into me from public.people p where p.id = p_who and p.active;
    if not found then
      return null;
    end if;
    v_kid := me.role = 'kid' and exists (select 1 from public.homework_kids k where k.kid_id = me.id and k.active);
    v_helper := me.role = 'helper' and coalesce((select h.helper_list <> 'off' from public.household h), false);
  end if;

  for d in select g::date from generate_series(p_monday, v_sunday, interval '1 day') g loop
    if p_who is null then
      select coalesce(jsonb_agg(private.weekly_item(x.a, null, lang)
                                order by private.item_order(x.a), (x.a).local_start, (x.a).title, (x.a).item_id), '[]')
      into v_items
      from (select a from public.agenda(d, d) a where a.status <> 'cancelled' and (a.kind <> 'project' or a.day = d)
            union all
            select private.task_item(t, d, 'open')
            from public.tasks t
            where t.active and t.repeat_mode = 'schedule'
              and private.current_due(t) < d and private.series_on_or_before(t, d) = d
            union all
            select g from public.google_items(d, d) g) x (a);
      select coalesce(jsonb_agg(jsonb_build_object(
               'slot', private.food_word(m.slot, lang),
               'title', case when m.private then private.word('private_item', lang) else private.meal_title(m, lang) end,
               'who', case when not m.private then private.names(array[m.cook_id]) end)
             order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id), '[]')
      into v_meals
      from public.meals m where m.day = d;
    else
      select coalesce(jsonb_agg(private.weekly_item(x.a, p_who, lang)
                                order by private.item_order(x.a), (x.a).local_start, (x.a).title, (x.a).item_id), '[]')
      into v_items
      from (select i from private.person_items(p_who, d) i
            union all
            select private.task_item(t, d, 'open')
            from public.tasks t
            where t.responsible_id = p_who and t.active and t.repeat_mode = 'schedule'
              and private.current_due(t) < d and private.series_on_or_before(t, d) = d) x (a);
      select coalesce(jsonb_agg(jsonb_build_object(
               'slot', private.food_word(m.slot, lang),
               'title', private.meal_title(m, lang),
               'who', private.food_word(case when m.kind = 'cook' then 'you_cook' else 'you_on_dinner' end, lang))
             order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id), '[]')
      into v_meals
      from public.meals m where m.day = d and m.cook_id = p_who;
    end if;
    v_days := v_days || jsonb_build_array(jsonb_build_object(
      'day', d, 'label', private.day_label(d, lang), 'day_off', d = any (v_off), 'items', v_items, 'meals', v_meals));
  end loop;

  return jsonb_strip_nulls(jsonb_build_object(
    'who', coalesce(p_who::text, 'family'),
    'name', case when p_who is not null then private.short_name(me) end,
    'role', case when p_who is not null then me.role end,
    'lang', lang,
    'monday', p_monday,
    'sunday', v_sunday,
    'range', private.short_date(p_monday, lang) || ' – ' || private.short_date(v_sunday, lang),
    'people', case when p_who is null then
      (select coalesce(jsonb_agg(jsonb_build_object('name', private.short_name(p), 'color', p.color) order by p.sort_order, p.name), '[]')
       from public.people p where p.active) end,
    'days', v_days,
    'homework', case when v_kid then
      (select coalesce(jsonb_agg(jsonb_build_object(
                'title', a.title, 'subject', a.subject, 'kind', a.kind,
                'due', a.due_date, 'due_label', private.day_label(a.due_date, lang),
                'steps', coalesce((select jsonb_agg(jsonb_build_object(
                                     'day', s.day, 'label', private.day_label(s.day, lang), 'title', s.title,
                                     'kind', s.kind, 'minutes', s.minutes, 'done', s.done_at is not null) order by s.day, s.pos)
                                   from public.homework_steps s
                                   where s.assignment_id = a.id and s.day between p_monday and v_sunday), '[]'))
              order by a.due_date nulls last, a.title, a.id), '[]')
       from public.assignments a
       where a.kid_id = p_who and a.status = 'open' and a.given_at is not null
         and (a.due_date between p_monday and v_sunday
              or exists (select 1 from public.homework_steps s
                         where s.assignment_id = a.id and s.day between p_monday and v_sunday and s.done_at is null))) end,
    'routine', case when v_kid then
      (select coalesce(jsonb_agg(jsonb_build_object(
                'title', s.title, 'note', s.note,
                'items', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                   'title', it.title, 'tag', it.tag, 'part', it.part,
                                   'days', (select jsonb_agg(private.routine_school_day(g::date) or not it.school_days order by g)
                                            from generate_series(p_monday, v_sunday, interval '1 day') g)))
                                 order by it.pos)
                          from public.routine_items it where it.section_id = s.id))
              order by s.pos), '[]')
       from public.routine_sections s
       where s.kid_id = p_who and exists (select 1 from public.routine_items it where it.section_id = s.id)) end,
    'shopping', case when v_helper then
      (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', i.name, 'note', i.note)) order by i.name_key, i.id), '[]')
       from (select * from public.shopping_items i where i.bought_at is null and not i.private order by i.name_key, i.id limit 60) i) end));
end;
$$;

-- ---------------------------------------------------------------------
-- Sending it (§31.3)
-- ---------------------------------------------------------------------
-- Who should get the Sunday email now: on a Sunday (the household's), from weekly_at until midnight, everyone on
-- weekly_to who is active and has a confirmed address, while there is a sheet to send; local_date is the Monday the
-- week starts. Rows already sent, skipped, in flight or out of attempts are left out (as digest_due). Never on
-- Monday: a run that missed Sunday sends nothing for a week that has started.
create function public.weekly_due(p_limit int default 20)
returns table (person_id uuid, local_date date, kind text)
language sql
stable
security invoker
set search_path = ''
as $$
  with c as (
    select private.now() as now, public.today_local() as today, private.tz() as tz,
           h.weekly_at, h.weekly_to, h.weekly_sheets
    from public.household h
  )
  select p.id, c.today + 1, 'weekly'::text
  from c
  join public.people p on p.id = any (c.weekly_to)
  where c.weekly_at is not null
    and jsonb_array_length(c.weekly_sheets) > 0
    and extract(isodow from c.today) = 7
    and (c.today + c.weekly_at) at time zone c.tz <= c.now
    and p.active and p.email is not null and p.email_verified_at is not null
    and not exists (select 1 from public.notification_log n
                    where n.person_id = p.id and n.local_date = c.today + 1
                      and n.kind = 'weekly' and n.channel = 'email'
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
revoke execute on function private.household_weekly_check()                          from public, anon, authenticated;
revoke execute on function private.weekly_item(public.agenda_item, uuid, text)       from public, anon, authenticated;
revoke execute on function public.weekly_sheet(uuid, date, text)                     from public, anon, authenticated;
revoke execute on function public.weekly_due(int)                                    from public, anon, authenticated;
grant  execute on function private.weekly_item(public.agenda_item, uuid, text)       to service_role;
grant  execute on function public.weekly_sheet(uuid, date, text)                     to service_role;
grant  execute on function public.weekly_due(int)                                    to service_role;
-- weekly_sheet reads which of a kid's routine items apply on each day (0019 gave it to nobody: its callers are definer).
grant  execute on function private.routine_school_day(date)                          to service_role;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- Settings shows Sunday sheets, and hub-jobs sends them, only on 25. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 25;
$$;

commit;
