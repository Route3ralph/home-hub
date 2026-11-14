-- The Sunday sheets (migration 0025, docs/v2-design.md §31): the coming week, printed. household.weekly_at (null: off),
-- weekly_to (who gets the email) and weekly_sheets ([{who: 'family' | <person id>, lang}]) are checked by a trigger;
-- admins change them, nobody else. public.weekly_sheet(p_who, p_monday, p_lang) is one sheet's week: a person's as
-- their My day has it (with their chores on set dates projected onto the week, a kid's homework and routine, the
-- helper's shopping list), the family's as the wall does (a private item or a health task reads "Private item"; no
-- note or phone number). public.weekly_due(p_limit) is who gets the email now: on a Sunday from weekly_at, everyone on
-- weekly_to who is active with a confirmed address, once a week. Both for service_role only.
-- The household is calendar_fixtures.sql's (all made up): Alex, Morgan (parents), Sam (adult), Jordan (kid), Taylor
-- (helper, Spanish). Piano is Taylor's with Jordan on Tuesdays at 4pm (a day note on Nov 3), the Surprise party Alex's
-- (private, Sat Nov 7), Trash Jordan's on Mondays (a chore on set dates, last done before Oct 26), Allergy pills a
-- health task of Jordan's on Thu Oct 29, Pay water bill Alex's on Wed Oct 28 with City Water (555-0160).
\ir roles.sql
\ir calendar_fixtures.sql

:as_owner
select test.is(hub_schema_version(), 29, 'hub_schema_version is 29');
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
-- A day's items on a sheet, as "time title [who] {place} <contractor> (note) +bring", joined by " | ".
create function pg_temp.day(j jsonb, i int) returns text language sql immutable as $$
  select coalesce(string_agg(concat_ws(' ', x ->> 'time', x ->> 'title', '[' || (x ->> 'who') || ']', '{' || (x ->> 'place') || '}',
                                       '<' || (x ->> 'contractor') || '>', '(' || (x ->> 'note') || ')', '+' || (x ->> 'bring')), ' | ' order by n), '')
  from jsonb_array_elements(j -> 'days' -> i -> 'items') with ordinality t (x, n)
$$;
create function pg_temp.sheet(p_who text, p_monday date, p_lang text) returns jsonb language sql volatile as $$
  select public.weekly_sheet(case when p_who = 'family' then null else test.person(p_who) end, p_monday, p_lang)
$$;

-- ---------------------------------------------------------------------
-- The columns, the check, the functions and their grants
-- ---------------------------------------------------------------------
select test.is((select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || (not a.attnotnull)::text
                                  || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' order by a.attname)
                from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                where a.attrelid = 'public.household'::regclass and a.attname like 'weekly%' and not a.attisdropped),
               'weekly_at:time without time zone:true:-,weekly_sheets:jsonb:false:''[]''::jsonb,weekly_to:uuid[]:false:''{}''::uuid[]',
               'household: weekly_at (nullable, off), weekly_sheets [] and weekly_to {} by default');
select test.is((select weekly_at is null and weekly_sheets = '[]' and weekly_to = '{}' from household), true, 'off on a database that had it before');
select test.ok((select bool_and(p.proconfig @> '{"search_path=\"\""}') from pg_proc p
                where p.oid in ('private.household_weekly_check()'::regprocedure, 'private.weekly_item(public.agenda_item, uuid, text)'::regprocedure,
                                'public.weekly_sheet(uuid, date, text)'::regprocedure, 'public.weekly_due(int)'::regprocedure)),
               'search_path is set on every new function');
select test.is((select string_agg(r || ':' || has_function_privilege(r, f, 'execute'), ',' order by f, r)
                from unnest(array['public.weekly_sheet(uuid, date, text)', 'public.weekly_due(int)', 'private.weekly_item(public.agenda_item, uuid, text)']) f,
                     unnest(array['anon', 'authenticated', 'service_role']) r),
               'anon:false,authenticated:false,service_role:true,anon:false,authenticated:false,service_role:true,anon:false,authenticated:false,service_role:true',
               'weekly_item, weekly_due and weekly_sheet: service_role only');
select test.ok(has_function_privilege('service_role', 'private.routine_school_day(date)', 'execute')
               and not has_function_privilege('authenticated', 'private.routine_school_day(date)', 'execute'),
               'routine_school_day: service_role may call it now (weekly_sheet does); authenticated still can''t');

-- Admins change the settings; a member's update changes nothing (RLS), anon can't.
:as_admin
select test.is(pg_temp.run($$update public.household set weekly_at = '16:00',
                             weekly_sheets = jsonb_build_array(jsonb_build_object('who', 'family', 'lang', 'en'),
                                                               jsonb_build_object('who', test.person('Taylor'), 'lang', 'es'),
                                                               jsonb_build_object('who', test.person('Jordan'), 'lang', 'en')),
                             weekly_to = array[test.person('Alex'), test.person('Morgan')]$$), 'ok', 'an admin saves the Sunday sheets');
:as_adult
update public.household set weekly_at = '09:00', weekly_to = '{}';
:as_owner
select test.is((select weekly_at::text || ' ' || cardinality(weekly_to) || ' ' || jsonb_array_length(weekly_sheets) from household), '16:00:00 2 3',
               'a member who isn''t an admin changes nothing');
:as_anon
select test.is(test.try('update public.household set weekly_at = null'), 'rows:0', 'anon changes nothing');

-- What the check refuses (as an admin), each in words, and nothing changes.
:as_admin
select test.throws($$update public.household set weekly_sheets = '{"who": "family"}'$$, 'Sunday sheets: the sheets must be a list.', 'refused: not a list');
select test.throws($$update public.household set weekly_sheets = '[{"who": "family", "lang": "fr"}]'$$, 'each sheet is {"who": "family" or a person''s id, "lang": "en" or "es"}', 'refused: a language other than en or es');
select test.throws($$update public.household set weekly_sheets = '[{"who": "family", "lang": "en", "x": 1}]'$$, 'each sheet is', 'refused: another key');
select test.throws($$update public.household set weekly_sheets = '[{"who": "family"}]'$$, 'each sheet is', 'refused: no language');
select test.throws($$update public.household set weekly_sheets = '[{"who": 7, "lang": "en"}]'$$, 'each sheet is', 'refused: who isn''t text');
select test.throws($$update public.household set weekly_sheets = '[{"who": "00000000-0000-4000-8000-000000000000", "lang": "en"}]'$$,
                   'a sheet is for someone who isn''t on the family list', 'refused: someone not on the family list');
select test.throws($$update public.household set weekly_sheets = '[{"who": "Max", "lang": "en"}]'$$,
                   'a sheet is for someone who isn''t on the family list', 'refused: a name, not an id');
select test.throws($$update public.household set weekly_sheets = '[{"who": "family", "lang": "en"}, {"who": "family", "lang": "es"}]'$$,
                   'a sheet is listed twice', 'refused: the same sheet twice');
select test.throws($$update public.household set weekly_sheets = (select jsonb_agg(jsonb_build_object('who', 'family', 'lang', 'en')) from generate_series(1, 9))$$,
                   'at most 8 sheets', 'refused: more than 8 sheets');
select test.throws($$update public.household set weekly_to = array[gen_random_uuid()]$$, 'they can go only to people on the family list', 'refused: sent to someone not on the list');
select test.throws($$update public.household set weekly_to = array[test.person('Alex'), test.person('Alex')]$$, 'someone is on the list twice', 'refused: the same person twice');
select test.throws($$update public.household set weekly_to = array[test.person('Alex'), test.person('Morgan'), test.person('Sam'), test.person('Jordan'), test.person('Taylor'), gen_random_uuid(), gen_random_uuid()]$$,
                   'send them to at most 6 people', 'refused: more than 6 people');
select test.throws($$update public.household set weekly_to = array[null::uuid]$$, 'they can go only to people on the family list', 'refused: a null in the list');
:as_owner
select test.is((select weekly_at::text || ' ' || cardinality(weekly_to) || ' ' || jsonb_array_length(weekly_sheets) from household), '16:00:00 2 3',
               '... and every refusal left the settings as they were');
-- A person removed later doesn't stop an unrelated change to the household (the check runs only when the sheets change).
update people set active = false where name = 'Sam';
:as_admin
select test.is(pg_temp.run($$update public.household set meals_on_wall = not meals_on_wall$$), 'ok', 'another household change still saves');
:as_owner
update people set active = true where name = 'Sam';
update household set meals_on_wall = not meals_on_wall;

-- notification_log takes 'weekly'.
select test.is(pg_temp.run($$insert into public.notification_log (person_id, local_date, kind, status) values (test.person('Alex'), '2026-11-02', 'weekly', 'skipped')$$), 'ok',
               'notification_log takes kind weekly');
delete from notification_log where kind = 'weekly';

-- ---------------------------------------------------------------------
-- weekly_sheet
-- ---------------------------------------------------------------------
:as_service
select test.throws($$select public.weekly_sheet(null, '2026-11-03', 'en')$$, 'A week''s sheet starts on a Monday.', 'refused: a Tuesday');
select test.throws($$select public.weekly_sheet(null, null, 'en')$$, 'A week''s sheet starts on a Monday.', 'refused: no date');
select test.is(public.weekly_sheet(gen_random_uuid(), '2026-11-02', 'en'), null, 'null for someone not on the family list');

-- The family's week, Nov 2-8.
select test.is((select string_agg(x ->> 'label', ', ' order by n) from jsonb_array_elements(pg_temp.sheet('family', '2026-11-02', 'en') -> 'days') with ordinality t (x, n)),
               'Mon Nov 2, Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Sat Nov 7, Sun Nov 8', 'seven days, Monday to Sunday, labelled in English');
select test.is((select s ->> 'who' || ' ' || (s ->> 'range') || ' ' || (s ? 'name')::text || ' ' || (s ? 'homework')::text || ' ' || (s ? 'routine')::text || ' ' || (s ? 'shopping')::text
                from pg_temp.sheet('family', '2026-11-02', 'en') s),
               'family Nov 2 – Nov 8 false false false false', 'the family''s: who family, the range, no name, no homework, routine or shopping list');
select test.is((select string_agg(x ->> 'name', ', ' order by n) from jsonb_array_elements(pg_temp.sheet('family', '2026-11-02', 'en') -> 'people') with ordinality t (x, n)),
               'Alex, Morgan, Sam, Jordan, Taylor', 'the family''s: everyone active, in the family list''s order, for the key to the colors');
select test.is(pg_temp.day(pg_temp.sheet('family', '2026-11-02', 'en'), 0), 'Recital {School hall} | Kitchen: Paint [Alex] | Trash [Jordan]',
               'Monday: the all-day Recital with its place, the project task that starts that day, and Jordan''s Trash (a chore on set dates, projected onto the week)');
select test.is(pg_temp.day(pg_temp.sheet('family', '2026-11-02', 'en'), 1), '4:00pm Piano [Taylor with Jordan] {Rivera Music, 12 Elm St} <Rivera Music>',
               'Tuesday: Piano with who''s on it, the place and the contractor, but no phone number and no day note (the fridge shows what the wall does)');
select test.is(pg_temp.day(pg_temp.sheet('family', '2026-11-02', 'en'), 5), '9:00am Swim [Alex with Jordan] {Pool} | 7:00pm Private item',
               'Saturday: the private Surprise party is "Private item" with its time only: no who, place or note');
select test.is((select x ->> 'end' from jsonb_array_elements(pg_temp.sheet('family', '2026-11-02', 'en') -> 'days' -> 1 -> 'items') x), '5:00pm',
               'an event''s end time');
select test.is((select x ->> 'color' from jsonb_array_elements(pg_temp.sheet('family', '2026-11-02', 'en') -> 'days' -> 5 -> 'items') x where x ->> 'title' = 'Swim'),
               (select color from people where name = 'Alex'), 'an item''s color is the person in charge''s');
select test.is(pg_temp.day(pg_temp.sheet('family', '2026-10-26', 'en'), 2), '7:00am Gym [Sam] | 9:30am Pay water bill [Alex] <City Water> | Kitchen: Demo [Alex] <Pat Lee> | Call plumber | Walk dogs [Alex]',
               'Wednesday Oct 28: everything that day; the contractor''s name without the phone on the family''s sheet');
select test.is(pg_temp.day(pg_temp.sheet('family', '2026-10-26', 'en'), 3), '8:00am Carpool [Jordan, Taylor] | Private item | Return books [Alex]',
               'Thursday Oct 29: Jordan''s health task (Allergy pills) is "Private item" on the family''s sheet; nobody in charge of Carpool names who''s along');
select test.is((select (x ? 'who')::text || (x ? 'color')::text from jsonb_array_elements(pg_temp.sheet('family', '2026-10-26', 'en') -> 'days' -> 3 -> 'items') x where x ->> 'title' = 'Private item'), 'falsetrue',
               '... with no who (its color stays)');

-- A person's week: as their My day has it.
select test.is(pg_temp.day(pg_temp.sheet('Taylor', '2026-11-02', 'es'), 1), '16:00 Piano [con Jordan] {Rivera Music, 12 Elm St} <Rivera Music 555-0150> (Side door, code 1234)',
               'the helper''s Tuesday in Spanish: 24-hour time, "con Jordan", the contractor''s phone and the day''s note, as My day shows them');
select test.is((select string_agg(x ->> 'label', ', ' order by n) from jsonb_array_elements(pg_temp.sheet('Taylor', '2026-11-02', 'es') -> 'days') with ordinality t (x, n)),
               'lun 2 nov, mar 3 nov, mié 4 nov, jue 5 nov, vie 6 nov, sáb 7 nov, dom 8 nov', '... the days labelled in Spanish');
select test.is((select s ->> 'name' || ' ' || (s ->> 'role') || ' ' || (s ->> 'lang') || ' ' || (s ->> 'range') from pg_temp.sheet('Taylor', '2026-11-02', 'es') s),
               'Taylor helper es 2 nov – 8 nov', '... her name, role, the language and the range in Spanish');
select test.is(pg_temp.day(pg_temp.sheet('Jordan', '2026-10-26', 'en'), 3), '8:00am Carpool | Allergy pills',
               'Jordan''s own sheet shows his health task by name (as his My day does)');
select test.is(pg_temp.day(pg_temp.sheet('Jordan', '2026-11-09', 'en'), 0), 'Trash',
               'a chore on set dates is on each of its dates in the week (Mon Nov 9), however long ago it was last done');
select test.is(pg_temp.day(pg_temp.sheet('Alex', '2026-11-02', 'en'), 5), '9:00am Swim [with Jordan] {Pool} | 7:00pm Private item',
               'Alex''s Saturday: his own private event is still "Private item" on a printed sheet');
select test.is(pg_temp.day(pg_temp.sheet('Jordan', '2026-11-02', 'en'), 1), '4:00pm Piano [Taylor] {Rivera Music, 12 Elm St} <Rivera Music 555-0150> (Side door, code 1234)',
               'Jordan along on Piano: who''s in charge');

-- Bring, on both kinds of sheet.
:as_owner
update events set bring = 'Music book' where title = 'Piano';
update event_changes set bring = 'Recital shoes' where event_id = test.event('Piano') and on_date = '2026-11-03';
:as_service
select test.is((select string_agg(coalesce(x ->> 'bring', '-'), ',') from jsonb_array_elements(pg_temp.sheet('family', '2026-11-02', 'en') -> 'days' -> 1 -> 'items') x)
               || ' ' || coalesce((select string_agg(coalesce(x ->> 'bring', '-'), ',') from jsonb_array_elements(pg_temp.sheet('Taylor', '2026-11-09', 'es') -> 'days' -> 1 -> 'items') x), 'nothing'),
               'Recital shoes nothing', 'Bring: the day''s own on Nov 3; Nov 10 is cancelled, so Taylor''s Tuesday is empty');
select test.is((select string_agg(coalesce(x ->> 'bring', '-'), ',') from jsonb_array_elements(pg_temp.sheet('Jordan', '2026-11-16', 'en') -> 'days' -> 1 -> 'items') x),
               'Music book', '... and the event''s own on another Tuesday');

-- A kid's homework and routine; the helper's shopping list.
:as_owner
insert into homework_kids (kid_id) values (test.person('Jordan'));
update household set days_off = '{2026-11-06}';
insert into assignments (kid_id, title, subject, due_date, given_at, given_by, school_mark, grade) values
  (test.person('Jordan'), 'Chapter 3 test', 'Math', '2026-11-06', now(), 'alex@example.com', null, null),
  (test.person('Jordan'), 'Volcano poster', 'Science', '2026-11-20', now(), 'alex@example.com', 'missing', null),
  (test.person('Jordan'), 'Book report', 'English', '2026-11-05', null, null, null, null),
  (test.person('Jordan'), 'Spelling list', 'English', '2026-11-13', now(), 'alex@example.com', null, null);
insert into homework_steps (assignment_id, pos, kind, title, minutes, day)
select a.id, s.pos, s.kind, s.title, s.minutes, s.day::date from assignments a
join (values ('Chapter 3 test', 1, 'start', 'Gather your notes', 5, '2026-11-02'),
             ('Chapter 3 test', 2, 'step', 'Solve 5 equations', 20, '2026-11-03'),
             ('Chapter 3 test', 3, 'turn_in', 'Take the Chapter 3 test', 5, '2026-11-06'),
             ('Volcano poster', 1, 'step', 'Sketch the layout', 15, '2026-11-04'),
             ('Book report', 1, 'step', 'Read chapter 1', 20, '2026-11-02'),
             ('Spelling list', 1, 'step', 'Learn the list', 15, '2026-11-12')) s (t, pos, kind, title, minutes, day) on s.t = a.title;
update homework_steps set done_at = now(), done_by = 'jordan' where title = 'Gather your notes';
insert into routine_sections (kid_id, pos, title, note) values (test.person('Jordan'), 1, 'Morning', 'Before the bus'), (test.person('Jordan'), 2, 'Empty', null);
insert into routine_items (section_id, pos, title, tag, part, school_days)
select s.id, i.pos, i.title, i.tag, i.part, i.sd from routine_sections s
join (values ('Morning', 1, 'Make your bed', null, null, false), ('Morning', 2, 'Pack your bag', '5 min', 'Bag', true)) i (t, pos, title, tag, part, sd) on i.t = s.title;
insert into shopping_items (name, note, private, added_by) values
  ('Milk', '2 gallons', false, test.person('Alex')), ('Gift wrap', null, true, test.person('Alex')), ('Bread', null, false, test.person('Alex'));
update shopping_items set bought_at = now(), bought_by = test.person('Alex') where name = 'Bread';
:as_service
select test.is((select string_agg(x ->> 'title' || ' (' || (x ->> 'subject') || ', ' || (x ->> 'due_label') || ': '
                                  || coalesce((select string_agg(s ->> 'label' || ' ' || (s ->> 'kind') || ' ' || (s ->> 'title') || ' ' || (s ->> 'minutes') || case when (s ->> 'done')::boolean then ' done' else '' end, '; ' order by m)
                                               from jsonb_array_elements(x -> 'steps') with ordinality u (s, m)), '-') || ')', ' | ' order by n)
                from jsonb_array_elements(pg_temp.sheet('Jordan', '2026-11-02', 'en') -> 'homework') with ordinality t (x, n)),
               'Chapter 3 test (Math, Fri Nov 6: Mon Nov 2 start Gather your notes 5 done; Tue Nov 3 step Solve 5 equations 20; Fri Nov 6 turn_in Take the Chapter 3 test 5) | Volcano poster (Science, Fri Nov 20: Wed Nov 4 step Sketch the layout 15)',
               'homework: plans given to him that are due that week or have a step still to do in it, with that week''s steps; never one not given (Book report), nor one due later with no step that week (Spelling list)');
select test.is((select string_agg(k, ',' order by k) from jsonb_array_elements(pg_temp.sheet('Jordan', '2026-11-02', 'en') -> 'homework') x, jsonb_object_keys(x) k
                where x ->> 'title' = 'Volcano poster'),
               'due,due_label,kind,steps,subject,title', '... with no Missing, Graded or grade');
select test.is((select string_agg(s ->> 'title' || '/' || coalesce(s ->> 'note', '-') || ': '
                                  || (select string_agg(i ->> 'title' || coalesce(' (' || (i ->> 'tag') || ')', '') || coalesce(' [' || (i ->> 'part') || ']', '') || ' '
                                                        || (select string_agg(case when d::boolean then 'x' else '.' end, '' order by e) from jsonb_array_elements_text(i -> 'days') with ordinality v (d, e)), '; ' order by m)
                                      from jsonb_array_elements(s -> 'items') with ordinality u (i, m)), ' | ' order by n)
                from jsonb_array_elements(pg_temp.sheet('Jordan', '2026-11-02', 'en') -> 'routine') with ordinality t (s, n)),
               'Morning/Before the bus: Make your bed xxxxxxx; Pack your bag (5 min) [Bag] xxxx...',
               'routine: each item and the days it applies (school days only: not Fri Nov 6, a day off, nor the weekend); a section with no item left out');
select test.is((select (s -> 'days' -> 4 ->> 'day_off') || ' ' || (s -> 'days' -> 3 ->> 'day_off') from pg_temp.sheet('Jordan', '2026-11-02', 'en') s), 'true false',
               'a household day off is marked on its day');
select test.is((select string_agg(x ->> 'name' || coalesce(' · ' || (x ->> 'note'), ''), ', ' order by n) from jsonb_array_elements(pg_temp.sheet('Taylor', '2026-11-02', 'es') -> 'shopping') with ordinality t (x, n)),
               'Milk · 2 gallons', 'the helper''s shopping list: what''s still to buy, never a private item or one bought');
:as_owner
update household set helper_list = 'off';
:as_service
select test.is((pg_temp.sheet('Taylor', '2026-11-02', 'es') ? 'shopping'), false, '... and none while the helper''s list is off');
select test.is((select (s ? 'homework')::text || (s ? 'routine')::text || (s ? 'shopping')::text from pg_temp.sheet('Alex', '2026-11-02', 'en') s), 'falsefalsefalse',
               'a parent''s sheet has no homework, routine or shopping list');
:as_owner
update household set helper_list = 'add';
update homework_kids set active = false where kid_id = test.person('Jordan');
:as_service
select test.is((select (s ? 'homework')::text || (s ? 'routine')::text from pg_temp.sheet('Jordan', '2026-11-02', 'en') s), 'falsefalse',
               'a kid with homework off: no homework or routine on his sheet');
:as_owner
update homework_kids set active = true where kid_id = test.person('Jordan');
update people set active = false where name = 'Taylor';
:as_service
select test.is(pg_temp.sheet('Taylor', '2026-11-02', 'es'), null, 'null for someone off the family list for now');
:as_owner
update people set active = true where name = 'Taylor';

-- ---------------------------------------------------------------------
-- weekly_due
-- ---------------------------------------------------------------------
update people set email_verified_at = now() where name in ('Alex', 'Sam');
update people set email = 'morgan@example.com', email_verified_at = null where name = 'Morgan';
update household set weekly_to = array[test.person('Alex'), test.person('Morgan'), test.person('Sam')];
create function pg_temp.due() returns text language sql volatile as $$
  select coalesce(string_agg(p.name || ' ' || d.local_date || ' ' || d.kind, ', ' order by p.sort_order), '')
  from public.weekly_due(20) d join public.people p on p.id = d.person_id
$$;
grant execute on function pg_temp.due() to service_role;
set hub.now = '2026-11-08 15:59 America/New_York';   -- Sunday, a minute before 4pm
:as_service
select test.is(pg_temp.due(), '', 'Sunday before weekly_at: nobody yet');
:as_owner
set hub.now = '2026-11-08 16:00 America/New_York';
:as_service
select test.is(pg_temp.due(), 'Alex 2026-11-09 weekly, Sam 2026-11-09 weekly',
               'Sunday from 4pm: everyone on the list with a confirmed address (not Morgan, unconfirmed), for the week starting Monday Nov 9');
select test.is((select count(*) from public.weekly_due(1)), 1::bigint, '... at most p_limit of them');
:as_owner
set hub.now = '2026-11-08 23:59 America/New_York';
:as_service
select test.is(pg_temp.due(), 'Alex 2026-11-09 weekly, Sam 2026-11-09 weekly', '... until midnight');
:as_owner
set hub.now = '2026-11-09 00:05 America/New_York';
:as_service
select test.is(pg_temp.due(), '', 'never on Monday: a run that missed Sunday sends nothing for a week that has started');
:as_owner
set hub.now = '2026-11-07 17:00 America/New_York';
:as_service
select test.is(pg_temp.due(), '', 'never on another day (Saturday)');
:as_owner
set hub.now = '2026-11-08 16:30 America/New_York';
insert into notification_log (person_id, local_date, kind, status) values (test.person('Alex'), '2026-11-09', 'weekly', 'sent');
insert into notification_log (person_id, local_date, kind, status, attempts) values (test.person('Sam'), '2026-11-09', 'weekly', 'failed', 1);
:as_service
select test.is(pg_temp.due(), 'Sam 2026-11-09 weekly', 'sent once a week: Alex''s went; Sam''s failed once, so it is due again');
:as_owner
update notification_log set attempts = 3 where person_id = test.person('Sam') and kind = 'weekly';
insert into notification_log (person_id, local_date, kind, status) values (test.person('Sam'), '2026-11-09', 'digest', 'sent');
:as_service
select test.is(pg_temp.due(), '', '... and not after 3 tries (a morning email the same day is a different row)');
:as_owner
delete from notification_log where kind = 'weekly';
update people set active = false where name = 'Sam';
:as_service
select test.is(pg_temp.due(), 'Alex 2026-11-09 weekly', 'someone off the family list for now gets none');
:as_owner
update people set active = true where name = 'Sam';
update household set weekly_sheets = '[]';
:as_service
select test.is(pg_temp.due(), '', 'no sheet chosen: nothing to send');
:as_owner
update household set weekly_sheets = '[{"who": "family", "lang": "en"}]', weekly_at = null;
:as_service
select test.is(pg_temp.due(), '', 'weekly_at null: off');
:as_owner
update household set weekly_at = '18:00';
:as_service
select test.is(pg_temp.due(), '', 'a later time on Sunday: not yet at 4:30pm');
:as_owner
set hub.now = '2026-11-08 18:00 America/New_York';
:as_service
select test.is(pg_temp.due(), 'Alex 2026-11-09 weekly, Sam 2026-11-09 weekly', '... and due from 6pm');
:as_anon
select test.is(test.try('select * from public.weekly_due(20)'), 'denied', 'anon can''t read who is due');
:as_admin
select test.is(test.try('select * from public.weekly_due(20)'), 'denied', 'an admin can''t either (the job only)');
select test.is(test.try($$select public.weekly_sheet(null, '2026-11-02', 'en')$$), 'denied', 'nor read a sheet (Settings asks hub-jobs)');
