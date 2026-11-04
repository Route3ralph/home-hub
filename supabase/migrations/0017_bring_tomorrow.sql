-- =====================================================================
-- HOME HUB v2 — migration 0017: Bring, and the Tomorrow message
-- Apply once, after 0016. The site that knows it goes live first; no Edge Function or cron.sql change goes with it.
-- The contract is docs/v2-design.md §22.
--
-- Why
--   An event can say what to bring ("Cleats", "Signed form"): for every day it happens, or for one day only. A
--   parent sends a kid or the helper tomorrow's plan in the evening with one tap (Today → Send tomorrow), in their
--   language, with the time, who else is on it, the place and what to bring.
--
-- What it adds
--   • Columns: events.bring (every day the event happens) and event_changes.bring (that one day; null = as usual),
--     one line, at most 120 characters, tidied by private.bring_tidy() (a trigger on each table).
--   • private.bring_of(p_event uuid, p_day date): an event's Bring on one day (the day's own, else the event's).
--   • private.bring_text(p_bring text, p_lang text): "Bring: Cleats" / "Llevar: Cleats", or null.
--   • Replaced, with the same signatures and grants: private.my_day_item (My day: a 'bring' key, only when there is
--     one), private.text_line (Send their day and the parents' email boxes: "· Bring: …" at the end) and
--     private.digest_item (the email: "Bring: …" at the end of the detail). None of them on a private item (My day,
--     the texts) or a hidden one (the email). With no Bring anywhere, every answer is exactly as on 16.
--   • public.tomorrow_text(p_person uuid): the Tomorrow message (Today → Send tomorrow), built by
--     private.tomorrow_line(a, p_person, p_lang): day_text's lines for tomorrow, with the end time, the place and
--     Bring, the chores on set dates that fall tomorrow even while today's is still open, and no Late section.
--   • hub_schema_version() (17). The pages offer Bring and Send tomorrow only on 17.
--
-- Rules
--   • One transaction. It refuses to run without 0016, twice, on a database set back to 16, or on one that isn't as
--     0016 left it.
--   • Additive: two nullable columns (no row changes), two triggers, new functions, and three readers replaced with
--     the same signatures. RLS on both tables is as before ("Family manages events", "Family manages event
--     changes"): members read and write Bring; anon, guests and strangers get nothing. No new function for anon.
--   • Bring never goes to Google (the wall) or to the tutor link and its coach view.
--
-- Undo (not needed: with no Bring every answer is as on 16, and the 16 site never sends one). If wanted, in one go:
--   drop function public.tomorrow_text(uuid);
--   drop function private.tomorrow_line(public.agenda_item, uuid, text);
--   drop function private.bring_text(text, text);
--   drop function private.bring_of(uuid, date);
--   drop trigger events_bring_tidy on public.events;
--   drop trigger event_changes_bring_tidy on public.event_changes;
--   drop function private.bring_tidy();
--   then 0002's private.my_day_item (its "create function" block, run as "create or replace") and 0003's
--   private.text_line and private.digest_item ("create or replace function" blocks), each to its "$$;";
--   then, so that a day changed only for its Bring isn't left marked changed with nothing different:
--   delete from public.event_changes where bring is not null and not cancelled and not nobody_in_charge and start_time is null and end_time is null and responsible_id is null and participant_ids is null and note is null;
--   alter table public.events drop column bring;
--   alter table public.event_changes drop column bring;
--   and 0016's hub_schema_version() block (returning 16). 0017 can then run again.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0016 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 16 then
    raise exception 'Change dates keeping due dates (migration 0016) isn''t installed (hub_schema_version() is %). Run 0016_school_redate_keeps.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 17 then
    raise exception 'Bring and the Tomorrow message (migration 0017) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.events'::regclass and a.attname = 'bring' and not a.attisdropped) then
    raise exception 'Bring and the Tomorrow message (migration 0017) is already installed, but hub_schema_version() was set back to 16. To switch it on again, make hub_schema_version() return 17 (docs/v2-design.md §22). Nothing was changed.';
  end if;
  -- What this migration adds to, replaces and reads is as 0016 left it.
  if to_regprocedure('public.check_school_feed(uuid, text, int)') is null
     or not (select p.prosrc like '%v_f.checked and%' from pg_proc p where p.oid = to_regprocedure('public.check_school_feed(uuid, text, int)'))
     or to_regprocedure('private.my_day_item(public.agenda_item, uuid, text)') is null
     or to_regprocedure('private.text_line(public.agenda_item, uuid, text)') is null
     or to_regprocedure('private.digest_item(public.agenda_item, uuid, text, boolean, text, text)') is null
     or to_regprocedure('private.who_text(public.agenda_item, uuid, text)') is null
     or to_regprocedure('private.person_items(uuid, date)') is null
     or to_regprocedure('private.item_order(public.agenda_item)') is null
     or to_regprocedure('private.clean_text(text, int)') is null
     or to_regprocedure('private.food_word(text, text)') is null
     or to_regprocedure('private.meal_title(public.meals, text)') is null
     or to_regprocedure('public.day_text(uuid, date)') is null
     or to_regprocedure('public.today_local()') is null
     or to_regprocedure('public.tomorrow_text(uuid)') is not null
     or to_regprocedure('private.bring_tidy()') is not null
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.event_changes'::regclass and a.attname = 'bring' and not a.attisdropped)
     or (select count(*) from pg_attribute a
         where a.attrelid = 'public.event_changes'::regclass and not a.attisdropped and a.attnum > 0
           and a.attname in ('event_id', 'on_date', 'note')) <> 3 then
    raise exception 'This database isn''t as migration 0016 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Bring (§22): every day the event happens, or one day
-- ---------------------------------------------------------------------
alter table public.events add column bring text check (bring is null or char_length(bring) between 1 and 120);
alter table public.event_changes add column bring text check (bring is null or char_length(bring) between 1 and 120);

-- One line, no control, bidi or zero-width characters, at most 120 characters; '' becomes null (on a day's change,
-- null means "as usual"). It goes into texts, WhatsApp and the email as typed.
create function private.bring_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.bring := nullif(private.clean_text(new.bring, 120), '');
  return new;
end;
$$;

create trigger events_bring_tidy before insert or update of bring on public.events
  for each row execute function private.bring_tidy();
create trigger event_changes_bring_tidy before insert or update of bring on public.event_changes
  for each row execute function private.bring_tidy();

-- An event's Bring on one day: that day's own (event_changes.bring), else the event's (events.bring), else null.
-- Runs with the caller's rights: under day_text a member reads it, a stranger reads nothing.
create function private.bring_of(p_event uuid, p_day date)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select c.bring from public.event_changes c where c.event_id = p_event and c.on_date = p_day),
                  (select e.bring from public.events e where e.id = p_event));
$$;

-- "Bring: Cleats" / "Llevar: Cleats", or null when there's nothing to bring. The text stays as typed.
create function private.bring_text(p_bring text, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_lang = 'es' then 'Llevar: ' else 'Bring: ' end || nullif(p_bring, '');
$$;

-- ---------------------------------------------------------------------
-- My day, the texts and the email carry it (§22), replaced
-- ---------------------------------------------------------------------
-- 0002's My day item, plus 'bring' (0017) only when an event has one that day and it isn't private: with none,
-- the item is exactly as on 16.
create or replace function private.my_day_item(a public.agenda_item, p_person uuid, p_lang text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', a.kind,
    'item_id', a.item_id,
    'occurrence', a.occurrence,
    'day', a.day,
    'end_day', a.end_day,
    'title', case when a.private then private.word('private_item', p_lang) else a.title end,
    'all_day', a.all_day,
    'start_time', to_char(date '2000-01-01' + a.local_start, 'HH24:MI'),
    'end_time', to_char(date '2000-01-01' + a.local_end, 'HH24:MI'),
    'time_label', private.time_label(a.local_start, p_lang),
    'location', case when not a.private then a.location end,
    'contractor_name', case when not a.private then a.contractor_name end,
    'contractor_phone', case when not a.private then a.contractor_phone end,
    'note', case when not a.private then a.day_note end,
    'status', a.status,
    'mine', a.kind = 'task' and a.responsible_id = p_person)
    || case when b.bring is not null then jsonb_build_object('bring', b.bring) else '{}'::jsonb end
  from (select case when a.kind = 'event' and not coalesce(a.private, false) then private.bring_of(a.item_id, a.occurrence) end as bring) b;
$$;

-- 0003's line of a day's message, plus "· Bring: …" (0017) at the end when an event has one that day and it isn't
-- private: with none, the line is exactly as on 16.
create or replace function private.text_line(a public.agenda_item, p_person uuid, p_lang text)
returns text
language sql
stable
set search_path = ''
as $$
  select concat_ws(' · ',
    coalesce(private.time_label(a.local_start, p_lang) || ' ', '')
      || case when a.local_start is null and a.kind in ('event', 'google') then private.word('all_day', p_lang) || ': ' else '' end
      || case when a.kind = 'task' then '☐ ' else '' end
      || case when a.kind = 'project' then a.project_name || ': ' else '' end
      || case when a.private then private.word('private_item', p_lang) else a.title end,
    case when not a.private then private.who_text(a, p_person, p_lang) end,
    case when not a.private then nullif(concat_ws(' ', a.contractor_name, a.contractor_phone), '') end,
    case when not a.private then a.day_note end,
    case when a.kind = 'event' and not a.private then private.bring_text(private.bring_of(a.item_id, a.occurrence), p_lang) end);
$$;

-- 0003's email item, plus "Bring: …" (0017) at the end of the detail when an event has one that day and the item
-- isn't hidden: with none, the item is exactly as on 16.
create or replace function private.digest_item(a public.agenda_item, p_person uuid, p_lang text, p_hide boolean,
                                               p_time text, p_detail text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', a.kind,
    'item_id', a.item_id,
    'occurrence', a.occurrence,
    'time', coalesce(p_time, private.time_label(a.local_start, p_lang),
                     case when a.kind in ('event', 'google') then private.word('all_day', p_lang) end),
    'title', case when h.hide then private.word('private_item', p_lang) else a.title end,
    'detail', case when h.hide then p_detail
                   else nullif(concat_ws(' · ', p_detail, private.who_text(a, p_person, p_lang),
                                         case when a.kind <> 'contract' then a.contractor_name end, a.day_note,
                                         case when a.kind = 'event' then private.bring_text(private.bring_of(a.item_id, a.occurrence), p_lang) end), '') end,
    'contractor_phone', case when not h.hide then a.contractor_phone end,
    'status', a.status)
  from (select coalesce(p_hide, false) or (a.kind = 'google' and coalesce(a.private, false)) as hide) h;
$$;

-- ---------------------------------------------------------------------
-- The Tomorrow message (§22)
-- ---------------------------------------------------------------------
-- One line of the Tomorrow message: text_line's, with the end time (when it has one: the driver's pickup) and the
-- place after who's on it:
-- "3:00pm–4:00pm Piano · with Taylor · 12 Elm St · Rivera Music 555-0150 · Side door · Bring: Music book".
-- Private items show as "Private item" and nothing else.
create function private.tomorrow_line(a public.agenda_item, p_person uuid, p_lang text)
returns text
language sql
stable
set search_path = ''
as $$
  select concat_ws(' · ',
    coalesce(private.time_label(a.local_start, p_lang) || coalesce('–' || private.time_label(a.local_end, p_lang), '') || ' ', '')
      || case when a.local_start is null and a.kind in ('event', 'google') then private.word('all_day', p_lang) || ': ' else '' end
      || case when a.kind = 'task' then '☐ ' else '' end
      || case when a.kind = 'project' then a.project_name || ': ' else '' end
      || case when a.private then private.word('private_item', p_lang) else a.title end,
    case when not a.private then private.who_text(a, p_person, p_lang) end,
    case when not a.private then nullif(a.location, '') end,
    case when not a.private then nullif(concat_ws(' ', a.contractor_name, a.contractor_phone), '') end,
    case when not a.private then a.day_note end,
    case when a.kind = 'event' and not a.private then private.bring_text(private.bring_of(a.item_id, a.occurrence), p_lang) end);
$$;

-- Tomorrow's plan for one person, in their language, for Today → Send tomorrow: a header with "Tomorrow" and the
-- date, their open items in order (tomorrow_line), then the meals they're on, as day_text does; "Nothing planned"
-- when there's none. No Late section: tonight, today's open tasks aren't late yet. Tomorrow is the household's
-- (today_local() + 1). Runs with the caller's rights, so a non-member gets null, as with day_text.
-- A chore on set dates is listed when tomorrow is one of its dates, even while today's date (or a missed one) is
-- still open: agenda() puts an open task on its current date, so person_items alone would leave it out tonight and
-- list it tomorrow morning (private.current_due then moves it there).
create function public.tomorrow_text(p_person uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  me    public.people;
  lang  text;
  d     date := public.today_local() + 1;
  lines text[];
begin
  select * into me from public.people p where p.id = p_person;
  if not found then
    return null;
  end if;
  lang := me.language;

  lines := array[private.short_name(me) || ' · ' || private.word('tomorrow', lang) || ', ' || private.day_label(d, lang)]
        || array(select private.tomorrow_line(x.a, p_person, lang)
                 from (select i as a from private.person_items(p_person, d) i where i.status = 'open'
                       union all
                       select private.task_item(t, d, 'open')
                       from public.tasks t
                       where t.responsible_id = p_person and t.active and t.repeat_mode = 'schedule'
                         and private.current_due(t) < d and private.series_on_or_before(t, d) = d) x
                 order by private.item_order(x.a), (x.a).local_start, (x.a).title)
        || array(select private.food_word(m.slot, lang) || ': ' || private.meal_title(m, lang) || ' · '
                        || private.food_word(case when m.kind = 'cook' then 'you_cook' else 'you_on_dinner' end, lang)
                 from public.meals m
                 where m.day = d and m.cook_id = p_person and me.active
                 order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id);
  if cardinality(lines) = 1 then
    lines := lines || private.word('nothing_planned', lang);
  end if;
  return array_to_string(lines, E'\n');
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
-- New functions start out executable by PUBLIC. (The three replaced keep theirs: create or replace.)
revoke execute on function private.bring_tidy()                                 from public, anon, authenticated;
revoke execute on function private.bring_of(uuid, date)                          from public, anon;
revoke execute on function private.bring_text(text, text)                        from public, anon;
revoke execute on function private.tomorrow_line(public.agenda_item, uuid, text) from public, anon;
revoke execute on function public.tomorrow_text(uuid)                            from public, anon, service_role;
grant  execute on function private.bring_of(uuid, date)                          to authenticated, service_role;
grant  execute on function private.bring_text(text, text)                        to authenticated, service_role;
grant  execute on function private.tomorrow_line(public.agenda_item, uuid, text) to authenticated;
grant  execute on function public.tomorrow_text(uuid)                            to authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages offer Bring and Send tomorrow on 17. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 17;
$$;

commit;
