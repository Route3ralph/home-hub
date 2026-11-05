-- The school's assigned dates (migration 0015, docs/v1.3-homework.md §23): an Assignments link whose dates are the
-- day each item was given ('assigned'). The first-import check and Change dates take it; New from school (hers and
-- the parents') holds what was given from 30 days ago (10 before 0018) to 30 days on, each with assigned: true; Add, Quick and Plan
-- with Pat need the due date (p_due), from the day it was given to 4 months on, and it is the assignment's; the school
-- never moves it (no "moved"), though title, class and description still follow; a link set back to 'end' keeps the
-- due dates already given. A 'start' or 'end' link takes p_due too (within its own bounds) and answers as before
-- without it (school.test.sql). The new signatures' grants, and the old ones gone.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (the kid with homework), Morgan (the helper).
-- Everything is made up: the school's host is academy.school.example (the allowed suffix is replaced below).
-- hub.now is Tue Nov 3, 2026 (America/New_York) unless a case moves it.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-03 09:00 America/New_York';   -- a Tuesday
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
create function pg_temp.iid(p_title text) returns uuid language sql stable security definer as $$
  select id from public.school_items where title = p_title
$$;
create function pg_temp.item(p_title text) returns public.school_items language sql stable security definer as $$
  select * from public.school_items where title = p_title
$$;
create function pg_temp.fid(p_kid text, p_kind text) returns uuid language sql stable security definer as $$
  select id from public.school_feeds where kid_id = test.person(p_kid) and kind = p_kind
$$;
create function pg_temp.asg(p_title text) returns public.assignments language sql stable security definer as $$
  select * from public.assignments where title = p_title
$$;
create function pg_temp.titles(j jsonb) returns text language sql immutable as $$
  select string_agg(x ->> 'title', ' | ' order by n) from jsonb_array_elements(j) with ordinality t (x, n)
$$;
create function pg_temp.el(j jsonb, p_title text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(j) x where x ->> 'title' = p_title limit 1
$$;
create function pg_temp.keys(j jsonb) returns text language sql immutable as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(j) k
$$;
create function pg_temp.read(p_kid text, p_kind text, p_items jsonb) returns jsonb language plpgsql as $$
declare
  b jsonb;
  r jsonb;
begin
  b := public.school_begin(true);
  if not coalesce((b ->> 'go')::boolean, false) then
    return jsonb_build_object('begin', b);
  end if;
  r := public.school_store((b ->> 'run_id')::uuid, pg_temp.fid(p_kid, p_kind), p_items, null, 0);
  perform public.school_finish((b ->> 'run_id')::uuid);
  return r;
end;
$$;
create or replace function private.school_host_suffix() returns text language sql immutable set search_path = '' as $$ select '.school.example' $$;

-- ---------------------------------------------------------------------
-- The schema, the signatures and their grants (§23.2)
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 20, 'hub_schema_version is 20 (0015 made it 15, 0016 16, 0017 17, 0018 18, 0019 19, 0020 makes it 20)');
select test.is((select string_agg(p.oid::regprocedure::text, ' | ' order by p.oid::regprocedure::text)
                from pg_proc p where p.proname in ('school_item_action', 'school_item_by_token', 'school_assignment')),
               'private.school_assignment(uuid,text,date) | school_item_action(uuid,text,date) | school_item_by_token(text,uuid,text,integer,date)',
               'one signature each, with p_due (the old ones are gone)');
select test.ok(has_function_privilege('anon', 'public.school_item_by_token(text, uuid, text, int, date)', 'execute')
               and has_function_privilege('authenticated', 'public.school_item_by_token(text, uuid, text, int, date)', 'execute')
               and not has_function_privilege('service_role', 'public.school_item_by_token(text, uuid, text, int, date)', 'execute'),
               'school_item_by_token: anon and authenticated, not service_role (as 0006)');
select test.ok(has_function_privilege('authenticated', 'public.school_item_action(uuid, text, date)', 'execute')
               and not has_function_privilege('anon', 'public.school_item_action(uuid, text, date)', 'execute')
               and not has_function_privilege('service_role', 'public.school_item_action(uuid, text, date)', 'execute'),
               'school_item_action: authenticated only (as 0006)');
select test.ok(not has_function_privilege('anon', 'private.school_assignment(uuid, text, date)', 'execute')
               and not has_function_privilege('authenticated', 'private.school_assignment(uuid, text, date)', 'execute'),
               'private.school_assignment: nobody but the definer functions');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%')
                from pg_proc p where p.oid in ('private.school_assignment(uuid, text, date)'::regprocedure, 'public.school_item_action(uuid, text, date)'::regprocedure,
                                               'public.school_item_by_token(text, uuid, text, int, date)'::regprocedure)),
               '... each with set search_path');

-- ---------------------------------------------------------------------
-- A link read, then checked as "the day it was assigned"
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
select add_homework_time(test.person('Taylor'), '{1,2,3,4,5}', '16:30', '17:30') as hw_event \gset
select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true) as pat_link \gset
select set_school_feed(test.person('Taylor'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6') as added \gset
:as_service
-- Each item is on the day it was given (one-day events), as some schools' feeds have it.
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Letter to the teacher", "subject": "History", "details": "Answer the six questions.", "first_day": "2026-11-03", "last_day": "2026-11-03"},
  {"title": "Equations worksheet", "subject": "Math", "first_day": "2026-10-29", "last_day": "2026-10-29"},
  {"title": "Character slides", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Map of the rivers", "subject": "Geography", "first_day": "2026-10-23", "last_day": "2026-10-23"},
  {"title": "Vocabulary practice", "subject": "Spanish", "first_day": "2026-11-02", "last_day": "2026-11-02"}
]') ->> 'kept' as kept \gset
select test.is(:'kept', '5', 'a read keeps the five (given from 11 days ago to today: inside the window that keeps two weeks back)');
:as_admin
select test.throws(format('select check_school_feed(%L, ''assigned'', 2)', :'added'::jsonb ->> 'id'),
                   'Choose the start or the end date, and a shift of -1, 0 or 1 day.', 'assigned takes a shift of -1, 0 or 1 too');
:as_adult
select test.throws(format('select check_school_feed(%L, ''assigned'', 0)', :'added'::jsonb ->> 'id'), 'Only a parent can change homework.', 'Sam can''t answer the check');
:as_admin
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'assigned', 0) as st \gset
select test.is((select date_rule || ' ' || date_shift || ' ' || checked from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid), 'assigned 0 true',
               '"The day it was assigned": the link is checked, its rule assigned');
select test.is((pg_temp.item('Equations worksheet')).due_date, '2026-10-29'::date, '... an item''s day is its first day (the day it was given)');
select test.is(:'st'::jsonb -> 'feeds' -> 0 ->> 'date_rule', 'assigned', 'the status card says the rule');
select test.is(pg_temp.titles(:'st'::jsonb -> 'new'), 'Map of the rivers | Equations worksheet | Character slides | Vocabulary practice | Letter to the teacher',
               'New from school: what was given from 30 days ago on (the map, given 11 days ago, too: 0018), by the day it was given');
select test.is((select string_agg((x ->> 'assigned') || ' ' || pg_temp.keys(x), ' | ') from jsonb_array_elements(:'st'::jsonb -> 'new') x),
               'true assigned,due_date,id,subject,title | true assigned,due_date,id,subject,title | true assigned,due_date,id,subject,title | true assigned,due_date,id,subject,title | true assigned,due_date,id,subject,title',
               '... each with assigned: true (its due_date is the day it was given)');
:as_anon
select homework_by_token(test.token('Taylor')) as kv \gset
select test.is(pg_temp.titles(:'kv'::jsonb -> 'from_school'), 'Map of the rivers | Equations worksheet | Character slides | Vocabulary practice | Letter to the teacher',
               'her New from school: the same five');
select test.is((select string_agg((x ->> 'assigned') || ' ' || (x ->> 'quick'), ',') from jsonb_array_elements(:'kv'::jsonb -> 'from_school') x),
               'true false,true false,true false,true false,true false', '... each assigned: true, quick: false (its due date isn''t known yet)');
select test.is(get_person_day(test.token('Taylor')) -> 'homework' -> 'from_school', '5'::jsonb, '... and her card counts them');

-- ---------------------------------------------------------------------
-- A parent's Add needs the due date
-- ---------------------------------------------------------------------
:as_admin
select test.throws(format('select school_item_action(%L, ''add'')', pg_temp.iid('Equations worksheet')), 'Choose the due date.',
                   'Add without a due date: "Choose the due date." (22023)');
select test.is(pg_temp.run(format('select school_item_action(%L, ''add'', ''2026-10-28'')', pg_temp.iid('Equations worksheet'))),
               '22023 Choose a due date from the day it was given to 4 months from today.', '... nor one before the day it was given');
select test.is(pg_temp.run(format('select school_item_action(%L, ''add'', ''2027-03-04'')', pg_temp.iid('Equations worksheet'))),
               '22023 Choose a due date from the day it was given to 4 months from today.', '... nor one past today + 120 days');
:as_owner
select test.is((select count(*) from assignments where title = 'Equations worksheet') || ' ' || ((pg_temp.item('Equations worksheet')).made_at is null),
               '0 true', '... and nothing was made');
:as_admin
select school_item_action(pg_temp.iid('Equations worksheet'), 'add', '2026-11-04') as ad \gset
select test.is((select a.added_by || ' ' || a.due_date || ' ' || a.subject from assignments a where a.id = (:'ad'::jsonb ->> 'assignment_id')::uuid),
               'school 2026-11-04 Math', 'Add with its due date: an assignment from school, due that day');
select test.is((pg_temp.item('Equations worksheet')).applied ->> 'due_date', null, '... and the feed keeps no due date it wrote (it never writes one)');
select test.is(pg_temp.titles(:'ad'::jsonb -> 'new'), 'Map of the rivers | Character slides | Vocabulary practice | Letter to the teacher', '... it leaves New from school');
select test.is(school_item_action(pg_temp.iid('Equations worksheet'), 'add') ->> 'assignment_id', :'ad'::jsonb ->> 'assignment_id',
               'a resent Add (even without the date) finds the same assignment');
select test.is(school_item_action(pg_temp.iid('Equations worksheet'), 'add', '2026-11-20') ->> 'assignment_id', :'ad'::jsonb ->> 'assignment_id',
               '... and with another date, too: its due date is as it was');
select test.is((pg_temp.asg('Equations worksheet')).due_date, '2026-11-04'::date, '... 2026-11-04');
-- Hide and Show work as before, with assigned: true on the hidden list.
select test.is(pg_temp.el(school_item_action(pg_temp.iid('Vocabulary practice'), 'hide') -> 'hidden', 'Vocabulary practice') ->> 'assigned', 'true',
               'Hide: on the hidden list with assigned: true');
select test.is(pg_temp.titles(school_item_action(pg_temp.iid('Vocabulary practice'), 'show') -> 'new'), 'Map of the rivers | Character slides | Vocabulary practice | Letter to the teacher',
               '... and Show brings it back');

-- ---------------------------------------------------------------------
-- Her Quick and Plan with Pat need the due date
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''with_tutor'')', test.token('Taylor'), pg_temp.iid('Letter to the teacher'))),
               '22023 Choose the due date.', 'Plan with Pat without a due date: "Choose the due date."');
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''quick'', 20)', test.token('Taylor'), pg_temp.iid('Character slides'))),
               '22023 Choose the due date.', '... Quick too');
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''quick'', 20, ''2026-11-01'')', test.token('Taylor'), pg_temp.iid('Character slides'))),
               '22023 Choose a due date from the day it was given to 4 months from today.', '... and not before the day it was given');
-- Quick for one due in 7 days: "Plan this one with Pat.", and nothing is made.
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''quick'', 20, ''2026-11-10'')', test.token('Taylor'), pg_temp.iid('Letter to the teacher'))),
               '42501 Plan this one with Pat.', 'Quick with a due date 7 days out: "Plan this one with Pat."');
:as_owner
select test.is((select count(*) from assignments where title = 'Letter to the teacher') || ' ' || ((pg_temp.item('Letter to the teacher')).made_at is null),
               '0 true', '... and nothing was made');
:as_anon
select school_item_by_token(test.token('Taylor'), pg_temp.iid('Character slides'), 'quick', 20, '2026-11-05') as q \gset
select test.is(:'q'::jsonb -> 'now' ->> 'title', 'Character slides', 'Quick with a due date 2 days out: her Now');
select school_item_by_token(test.token('Taylor'), pg_temp.iid('Letter to the teacher'), 'with_tutor', null, '2026-11-10') as wt \gset
:as_owner
select test.is((pg_temp.asg('Character slides')).due_date || ' ' || (pg_temp.asg('Character slides')).added_by, '2026-11-05 school',
               '... an assignment from school, due that day');
select test.is((select count(*) from homework_steps s where s.assignment_id = (pg_temp.asg('Character slides')).id), 1::bigint, '... with one step');
select test.is((pg_temp.asg('Letter to the teacher')).due_date || ' ' || (select count(*) from homework_steps s where s.assignment_id = (pg_temp.asg('Letter to the teacher')).id),
               '2026-11-10 0', 'Plan with Pat with its due date: due a week on, no plan yet');
:as_anon
select test.is(pg_temp.titles(:'wt'::jsonb -> 'from_school'), 'Map of the rivers | Vocabulary practice', '... and what is left on her New from school');
select test.is(pg_temp.el(:'wt'::jsonb -> 'assignments', 'Letter to the teacher') -> 'school', '{"gone": false, "moved_to": null}'::jsonb,
               '... its school marks: on the site, not moved');
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''hide'', null, ''2026-11-10'')', test.token('Taylor'), pg_temp.iid('Vocabulary practice'))), 'ok',
               'Hide doesn''t need (or use) a due date');

-- ---------------------------------------------------------------------
-- The school's changes: title and description follow; the due date never moves
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-03 10:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Letter to the teacher", "subject": "History", "details": "Answer the seven questions.", "first_day": "2026-11-03", "last_day": "2026-11-03"},
  {"title": "Equations worksheet", "subject": "Math", "first_day": "2026-10-30", "last_day": "2026-10-30"},
  {"title": "Character slides", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Map of the rivers", "subject": "Geography", "first_day": "2026-10-23", "last_day": "2026-10-23"},
  {"title": "Vocabulary practice", "subject": "Spanish", "first_day": "2026-11-02", "last_day": "2026-11-02"}
]');
:as_owner
select test.is((pg_temp.asg('Letter to the teacher')).details || ' ' || (pg_temp.asg('Letter to the teacher')).due_date,
               'Answer the seven questions. 2026-11-10', 'a new description follows the school; the due date she gave stays');
select test.is((pg_temp.item('Equations worksheet')).due_date || ' ' || (pg_temp.asg('Equations worksheet')).due_date, '2026-10-30 2026-11-04',
               'the school moved the day it was given (the same item, by its class and title): the assignment''s due date doesn''t move');
:as_admin
select school_feed_status(test.person('Taylor')) as st2 \gset
select test.is(:'st2'::jsonb -> 'moved', '[]'::jsonb, '... and nothing from an assigned link is "moved"');
:as_anon
select test.is(pg_temp.el(homework_by_token(test.token('Taylor')) -> 'assignments', 'Equations worksheet') -> 'school', '{"gone": false, "moved_to": null}'::jsonb,
               '... nor marked moved on her view');

-- ---------------------------------------------------------------------
-- Change dates: back to 'end' keeps the due dates given; a start or end link takes p_due too
-- ---------------------------------------------------------------------
:as_admin
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'end', 0) as st3 \gset
select test.is((select date_rule from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid), 'end', 'Change dates: the link is end again');
select test.is((pg_temp.asg('Letter to the teacher')).due_date || ' ' || (pg_temp.asg('Equations worksheet')).due_date, '2026-11-10 2026-11-04',
               '... the assignments made while it was assigned keep the due dates people gave');
select test.is(:'st3'::jsonb -> 'moved', '[]'::jsonb, '... and none reads as moved');
select test.is(pg_temp.el(:'st3'::jsonb -> 'new', 'Vocabulary practice'), null, '... New from school is as 0006 has it: the hidden practice is past (Nov 2)');
:as_owner
set hub.now = '2026-11-03 11:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Lab report", "subject": "Biology", "first_day": "2026-11-09", "last_day": "2026-11-09"}
]');
:as_admin
select test.is((select pg_temp.keys(x) from jsonb_array_elements(school_feed_status(test.person('Taylor')) -> 'new') x where x ->> 'title' = 'Lab report'),
               'due_date,id,subject,title', 'from an end link: no assigned key (as 0008)');
select test.is(pg_temp.run(format('select school_item_action(%L, ''add'', ''2027-04-01'')', pg_temp.iid('Lab report'))),
               '22023 Choose a due date from 2 weeks ago to 4 months from today.', 'from an end link, a given due date within its bounds');
select school_item_action(pg_temp.iid('Lab report'), 'add', '2026-11-12') ->> 'assignment_id' as lab \gset
select test.is((pg_temp.asg('Lab report')).due_date || ' ' || coalesce((pg_temp.item('Lab report')).applied ->> 'due_date', '-'), '2026-11-12 -',
               '... is the assignment''s, and the feed doesn''t move it later (it wrote none)');
:as_owner
set hub.now = '2026-11-03 12:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Lab report", "subject": "Biology", "first_day": "2026-11-09", "last_day": "2026-11-09"}
]');
:as_owner
select test.is((pg_temp.asg('Lab report')).due_date, '2026-11-12'::date, '... after the next read, still the 12th');
