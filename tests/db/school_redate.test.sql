-- Change dates keeps the due dates of homework already added (migration 0016, docs/v1.3-homework.md §23.4): on a
-- checked Assignments link, answering the dates again (end to start, a shift of a day) moves every item's day, never
-- an assignment made from one, and nothing reads as "moved"; the same answer again, and an item whose day doesn't
-- change, leave the feed's link to the assignment, so the school's own later moves still reach it; the first-import
-- check is as 0006 made it; an assignment with a due date a person gave is never moved, as before.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (the kid with homework), Morgan (the helper).
-- Everything is made up: the school's host is academy.school.example (the allowed suffix is replaced below).
-- hub.now is Tue Nov 3, 2026 (America/New_York) unless a case moves it.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-03 09:00 America/New_York';   -- a Tuesday
create function pg_temp.item(p_title text) returns public.school_items language sql stable security definer as $$
  select * from public.school_items where title = p_title
$$;
create function pg_temp.asg(p_title text) returns public.assignments language sql stable security definer as $$
  select * from public.assignments where title = p_title
$$;
create function pg_temp.fid(p_kid text, p_kind text) returns uuid language sql stable security definer as $$
  select id from public.school_feeds where kid_id = test.person(p_kid) and kind = p_kind
$$;
create function pg_temp.dues() returns text language sql stable security definer as $$
  select string_agg(a.title || ' ' || a.due_date, ' | ' order by a.title) from public.assignments a where a.added_by = 'school'
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

select test.is(hub_schema_version(), 17, 'hub_schema_version is 17 (0015 made it 15, 0016 16, 0017 makes it 17)');
select test.ok((select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%'
                from pg_proc p where p.oid = 'public.check_school_feed(uuid, text, int)'::regprocedure),
               'check_school_feed: still a definer, with set search_path');
select test.ok(has_function_privilege('authenticated', 'public.check_school_feed(uuid, text, int)', 'execute')
               and not has_function_privilege('anon', 'public.check_school_feed(uuid, text, int)', 'execute'),
               '... authenticated only, as 0006 grants it');

-- ---------------------------------------------------------------------
-- A link read and checked "Looks right" (each item's last day), and homework added from it
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
select add_homework_time(test.person('Taylor'), '{1,2,3,4,5}', '16:30', '17:30') as hw_event \gset
select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true) as pat_link \gset
select set_school_feed(test.person('Taylor'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Z9y8X7w6V5u4') as added \gset
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Volcano model", "subject": "Science", "first_day": "2026-11-05", "last_day": "2026-11-09"},
  {"title": "Book report", "subject": "English", "first_day": "2026-11-04", "last_day": "2026-11-12"},
  {"title": "Spelling list", "subject": "English", "first_day": "2026-11-06", "last_day": "2026-11-06"},
  {"title": "Fractions quiz", "subject": "Math", "first_day": "2026-11-10", "last_day": "2026-11-13"},
  {"title": "Poster", "subject": "Art", "first_day": "2026-11-11", "last_day": "2026-11-16"}
]') ->> 'kept' as kept \gset
select test.is(:'kept', '5', 'a read keeps the five');
:as_admin
-- The first-import check, answered twice before anything is added: every item's date follows (as 0006).
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'start', 0) is not null;
select test.is((pg_temp.item('Volcano model')).due_date, '2026-11-05'::date, 'the first-import check, Use the first date: the first day');
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'end', 0) as st0 \gset
select test.is((pg_temp.item('Volcano model')).due_date, '2026-11-09'::date, '... then Looks right: the last day');
select test.is((select checked from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid), true, '... and the link is checked');
-- Added: three with the item's date (the feed's), one with a due date a parent gave, one Taylor plans with Pat.
select school_item_action((pg_temp.item('Volcano model')).id, 'add') is not null;
select school_item_action((pg_temp.item('Book report')).id, 'add') is not null;
select school_item_action((pg_temp.item('Spelling list')).id, 'add') is not null;
select school_item_action((pg_temp.item('Fractions quiz')).id, 'add', '2026-11-11') is not null;
:as_anon
select school_item_by_token(test.token('Taylor'), (pg_temp.item('Poster')).id, 'with_tutor') is not null;
:as_owner
select test.is(pg_temp.dues(), 'Book report 2026-11-12 | Fractions quiz 2026-11-11 | Poster 2026-11-16 | Spelling list 2026-11-06 | Volcano model 2026-11-09',
               'five assignments from school: four due the item''s last day, the quiz the day a parent gave');
select test.is((pg_temp.item('Volcano model')).applied ->> 'due_date', '2026-11-09', '... the feed keeps the due date it wrote');
-- The Poster gets a plan with Pat (a step), so the school never moves it either way (as 0006).
insert into homework_steps (assignment_id, pos, title, minutes, day)
select (pg_temp.asg('Poster')).id, 1, 'Sketch it', 20, '2026-11-05';

-- ---------------------------------------------------------------------
-- Change dates: Looks right to Use the first date
-- ---------------------------------------------------------------------
:as_admin
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'start', 0) as st1 \gset
select test.is((pg_temp.item('Volcano model')).due_date || ' ' || (pg_temp.item('Book report')).due_date, '2026-11-05 2026-11-04',
               'Change dates, Use the first date: every item''s day is its first day');
select test.is(pg_temp.dues(), 'Book report 2026-11-12 | Fractions quiz 2026-11-11 | Poster 2026-11-16 | Spelling list 2026-11-06 | Volcano model 2026-11-09',
               '... and every assignment already added keeps its due date (0015 moved the volcano and the book report)');
select test.is(:'st1'::jsonb -> 'moved', '[]'::jsonb, '... nothing reads as "moved" on the status card');
:as_anon
select test.is((select string_agg(x -> 'school' ->> 'moved_to', ',') from jsonb_array_elements(homework_by_token(test.token('Taylor')) -> 'assignments') x
                where x ->> 'title' in ('Volcano model', 'Book report', 'Poster')), null, '... nor on her view');
:as_owner
select test.is(coalesce((pg_temp.item('Volcano model')).applied ->> 'due_date', '-') || ' ' || ((pg_temp.item('Spelling list')).applied ->> 'due_date'), '- 2026-11-06',
               '... the volcano''s day moved, so the feed forgets the due date it wrote; the spelling list''s (one day) didn''t, so it keeps it');
select test.is((select count(*) from assignments a where a.added_by = 'school' and a.updated_by = 'school link'), 0::bigint, '... and the school link changed no assignment');

-- ---------------------------------------------------------------------
-- The same answer again, and a shift of a day
-- ---------------------------------------------------------------------
:as_admin
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'start', 0) is not null;
select test.is((pg_temp.item('Spelling list')).applied ->> 'due_date', '2026-11-06', 'the same answer again: the spelling list keeps the feed''s due date');
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'start', 1) is not null;
select test.is((pg_temp.item('Spelling list')).due_date || ' ' || (pg_temp.asg('Spelling list')).due_date || ' ' || coalesce((pg_temp.item('Spelling list')).applied ->> 'due_date', '-'),
               '2026-11-07 2026-11-06 -', 'a day later: the item is the 7th, its assignment stays the 6th, and the feed forgets the date it wrote');
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'end', 0) is not null;
select test.is(pg_temp.dues(), 'Book report 2026-11-12 | Fractions quiz 2026-11-11 | Poster 2026-11-16 | Spelling list 2026-11-06 | Volcano model 2026-11-09',
               'back to Looks right: every due date as it was');

-- ---------------------------------------------------------------------
-- The school's own later moves still reach an assignment whose day Change dates didn't move
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-03 10:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Lab notes", "subject": "Science", "first_day": "2026-11-12", "last_day": "2026-11-12"}
]');
:as_admin
select school_item_action((pg_temp.item('Lab notes')).id, 'add') is not null;
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'start', 0) is not null;
select test.is((pg_temp.item('Lab notes')).applied ->> 'due_date', '2026-11-12', 'a one-day item: Change dates doesn''t move its day, and the feed keeps the date it wrote');
:as_owner
set hub.now = '2026-11-03 11:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Lab notes", "subject": "Science", "first_day": "2026-11-13", "last_day": "2026-11-13"}
]');
:as_owner
select test.is((pg_temp.asg('Lab notes')).due_date, '2026-11-13'::date, '... so when the school moves it a day, its assignment follows (as 0006)');
