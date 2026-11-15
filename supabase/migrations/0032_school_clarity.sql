-- =====================================================================
-- HOME HUB v2 — migration 0032: What to do, Test and Check the portal (what an assignment really asks, where it shows)
-- Apply once, after 0031, and only once the site and hub-jobs that understand it are live (docs/v1.3-homework.md §32.4).
-- cron.sql doesn't change.
-- The contract is docs/v1.3-homework.md §32; the database side is docs/v2-design.md §38.
--
-- Why
--   A school item's title can hide what it asks: "Study for <novel>" read like reading time, but the teacher's text,
--   which the feed carries, said "What to turn in: Print out the PDF … complete the underline markings". The hub kept
--   that text on the assignment's own page only. And one class's assignments are often unlike the others', so a
--   parent wants every one of them to say: check the portal.
--
-- What it adds
--   • assignments.what (text, generated): the line that says what to do, from its text (details): the words after
--     "What to turn in:" (or "What to hand in:", "What to submit:", "What to do:") when there are any, else its first
--     sentence; a short first sentence takes the next one too; at most 200 characters. Null with no text.
--     private.assignment_what(details) works it out.
--   • assignments.is_test (boolean, generated): its title says exam, test, quiz, examen or prueba, or its text opens
--     with "summative grade" or "formative grade" (an exam's section) and isn't practice for one ("prepare for",
--     "practice assignment", "study for"). private.assignment_is_test(title, details) works it out.
--   • homework_kids.portal_classes (text[], {}): the classes a parent ticked "Check the portal" for, as the school
--     writes them (at most 20, 1 to 40 characters each). private.portal_class(kid, subject) matches one, ignoring
--     case and spaces at the ends. Parents change it as they change his other homework settings.
--   • His homework view (private.homework_view_kid, 0031's moved to homework_view_kid_v31, unchanged): each
--     assignment with `what`, `test: true` and `portal: true` where they apply (no key where they don't).
--   • public.due_list: 0029's (moved to private.due_list_v31, unchanged), with the same three on each item.
--   • hub_schema_version() (32). The pages show them only on 32; hub-jobs prints what due_list gives.
--
-- Rules
--   • One transaction. It refuses to run without 0031, twice, on a database set back to 31 (the column already
--     there), or on one that isn't as 0031 left it.
--   • Additive: two generated columns, one column that is empty for every kid, functions. His view and due_list
--     answer as before for an assignment with no text, no test word and no ticked class.
--   • `what` is the teacher's own words, cut short; never the rest of the text, a grade or points.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: with no class ticked, the only change is the line and the tag). If wanted, in one go:
--   drop function public.due_list(date, text);
--   alter function private.due_list_v31(date, text) set schema public;
--   alter function public.due_list_v31(date, text) rename to due_list;
--   drop function private.homework_view_kid(uuid, text);
--   alter function private.homework_view_kid_v31(uuid, text) rename to homework_view_kid;
--   drop function private.portal_class(uuid, text);
--   alter table public.homework_kids drop column portal_classes;
--   drop function private.portal_classes_ok(text[]);
--   alter table public.assignments drop column what, drop column is_test;
--   drop function private.assignment_is_test(text, text);
--   drop function private.assignment_what(text);
--   then 0031's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0031 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 31 then
    raise exception 'Phone reminders (migration 0031) aren''t installed (hub_schema_version() is %). Run 0031_phone_reminders.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 32 then
    raise exception 'What to do and Check the portal (migration 0032) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.homework_kids'::regclass and a.attname = 'portal_classes' and not a.attisdropped) then
    raise exception 'What to do and Check the portal (migration 0032) are already installed, but hub_schema_version() was set back to 31. To switch them on again, make hub_schema_version() return 32 (docs/v1.3-homework.md §32). Nothing was changed.';
  end if;
  -- What this migration reads, calls and replaces is as 0031 left it.
  if to_regprocedure('public.push_by_token(text, text, text, text, text)') is null
     or to_regprocedure('private.homework_view_kid(uuid, text)') is null
     or to_regprocedure('private.homework_view_kid_v30(uuid, text)') is null
     or to_regprocedure('public.due_list(date, text)') is null
     or to_regprocedure('private.day_label(date, text)') is null
     or to_regprocedure('private.short_name(public.people)') is null
     or to_regprocedure('private.homework_view_kid_v31(uuid, text)') is not null
     or to_regprocedure('private.due_list_v31(date, text)') is not null
     or to_regprocedure('private.assignment_what(text)') is not null
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.assignments'::regclass and a.attname in ('what', 'is_test') and not a.attisdropped)
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.assignments'::regclass and a.attname = 'count_goal' and not a.attisdropped) then
    raise exception 'This database isn''t as migration 0031 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- What to do and Test (§32.1)
-- ---------------------------------------------------------------------
-- The line that says what an assignment asks, from its text: after "What to turn in:" (or hand in, submit, do) when
-- the text has it, else from the start; the first sentence, and the next one too when the first is under 60
-- characters; at most 200 characters, cut at a word. Spaces and line breaks become one space. Null with no text.
create function private.assignment_what(p_details text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := btrim(regexp_replace(coalesce(p_details, ''), '\s+', ' ', 'g'));
  w text;
  s text;
  m text[];
begin
  if d = '' then
    return null;
  end if;
  w := substring(d from '(?i)what to (?:turn in|hand in|submit|do)\s*:\s*(.*)$');
  if w is null or btrim(w) = '' then
    w := d;
  end if;
  m := regexp_match(w, '^(.*?[.!?])(\s|$)');
  s := coalesce(m[1], w);
  if char_length(s) < 60 and char_length(w) > char_length(s) then
    m := regexp_match(btrim(substr(w, char_length(s) + 1)), '^(.*?[.!?])(\s|$)');
    s := s || ' ' || coalesce(m[1], btrim(substr(w, char_length(s) + 1)));
  end if;
  s := btrim(s);
  if char_length(s) > 200 then
    s := regexp_replace(left(s, 200), '\s+\S*$', '') || '…';
  end if;
  return nullif(s, '');
end;
$$;

-- A test: the title says exam, test, quiz, examen or prueba, or the text opens (its first 140 characters) with
-- "summative grade" or "formative grade", an exam's section, and isn't practice for one.
create function private.assignment_is_test(p_title text, p_details text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_title, '') ~* '\m(exam|test|quiz|examen|prueba)\M'
      or (left(btrim(regexp_replace(coalesce(p_details, ''), '\s+', ' ', 'g')), 140) ~* '\m(summative|formative)\s+grade\M'
          and coalesce(p_details, '') !~* '\m(prepare you for|prepare for|practice assignment|study for)\M');
$$;

alter table public.assignments
  add column what text generated always as (private.assignment_what(details)) stored,           -- what to do, from its text
  add column is_test boolean generated always as (private.assignment_is_test(title, details)) stored;   -- an exam or quiz

-- ---------------------------------------------------------------------
-- Check the portal (§32.2)
-- ---------------------------------------------------------------------
create function private.portal_classes_ok(p_classes text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(p_classes) <= 20
     and not exists (select 1 from unnest(p_classes) c where c is null or char_length(btrim(c)) not between 1 and 40);
$$;

alter table public.homework_kids
  add column portal_classes text[] not null default '{}' check (private.portal_classes_ok(portal_classes));   -- "Check the portal"
grant update (portal_classes) on public.homework_kids to authenticated;

-- A class the parents ticked for this kid: the same words, ignoring case and the spaces at the ends.
create function private.portal_class(p_kid uuid, p_subject text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_subject is not null and exists (
    select 1 from public.homework_kids k, unnest(k.portal_classes) c
    where k.kid_id = p_kid and lower(btrim(c)) = lower(btrim(p_subject)));
$$;

-- ---------------------------------------------------------------------
-- His view (§32.3): 0031's, with what, test and portal on each assignment
-- ---------------------------------------------------------------------
alter function private.homework_view_kid(uuid, text) rename to homework_view_kid_v31;

create function private.homework_view_kid(p_kid uuid, p_lang text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := private.homework_view_kid_v31(p_kid, p_lang);
  c jsonb;
begin
  if v is null or jsonb_typeof(v -> 'assignments') is distinct from 'array' then
    return v;
  end if;
  select jsonb_object_agg(x.id::text, x.j) into c
  from (select a.id, jsonb_strip_nulls(jsonb_build_object(
                'what', a.what,
                'test', case when a.is_test then true end,
                'portal', case when private.portal_class(a.kid_id, a.subject) then true end)) as j
        from public.assignments a
        where a.kid_id = p_kid) x
  where x.j <> '{}'::jsonb;
  if c is null then
    return v;
  end if;
  return jsonb_set(v, '{assignments}',
                   (select coalesce(jsonb_agg(case when c ? (x ->> 'id') then x || (c -> (x ->> 'id')) else x end order by t.n), '[]')
                    from jsonb_array_elements(v -> 'assignments') with ordinality t (x, n)));
end;
$$;

-- ---------------------------------------------------------------------
-- The Due tomorrow email (§32.3): 0029's lists, with what, test and portal on each item
-- ---------------------------------------------------------------------
alter function public.due_list(date, text) rename to due_list_v31;
alter function public.due_list_v31(date, text) set schema private;

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
             'count', case when a.count_goal is not null then jsonb_build_object('goal', a.count_goal, 'done', a.count_done) end,
             'what', a.what,
             'test', case when a.is_test then true end,
             'portal', case when private.portal_class(a.kid_id, a.subject) then true end)) as j
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

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
-- The moved due_list keeps its grants (service_role only), so the undo puts it back exactly as it was.
-- The generated columns and the check run as whoever writes the row (a parent's page, a definer function), so a
-- signed-in member may run these three pure text checks; they read nothing.
revoke execute on function private.assignment_what(text)          from public, anon;
revoke execute on function private.assignment_is_test(text, text) from public, anon;
revoke execute on function private.portal_classes_ok(text[])      from public, anon;
grant  execute on function private.assignment_what(text)          to authenticated, service_role;
grant  execute on function private.assignment_is_test(text, text) to authenticated, service_role;
grant  execute on function private.portal_classes_ok(text[])      to authenticated, service_role;
revoke execute on function private.portal_class(uuid, text)       from public, anon, authenticated;
grant  execute on function private.portal_class(uuid, text)       to service_role;   -- due_list runs as the job
revoke execute on function private.homework_view_kid(uuid, text)  from public, anon, authenticated;
revoke execute on function public.due_list(date, text)            from public, anon, authenticated;
grant  execute on function public.due_list(date, text)            to service_role;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages show What to do, Test and Check the portal only on 32. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 32;
$$;

commit;
