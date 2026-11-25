-- Paste grades (migration 0039, docs/v1.3-homework.md §40): paste_grades(p_kid, p_rows, p_apply) marks his homework
-- Graded from the school's grade report: matched by title, class (without its section) and the nearest due date within
-- 7 days; only work due in the last 14 days or later; preview changes nothing. And the grade bonuses' weekly limit,
-- homework_kids.pts_bonus_week (50), in private.mark_points, with each line's bonus part in points_ledger.bonus.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (a kid). Everything is made up.
-- hub.now is Wed Nov 25, 2026, 14:00 in the household's time zone: 14 days back is Nov 11; the week is Nov 23 to 29.
\ir roles.sql
\ir fixtures.sql

:as_owner
select set_config('hub.now', ((date '2026-11-25' + time '14:00') at time zone private.tz())::text, false);
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated, service_role;
-- Each row of an answer: "status title points".
create function pg_temp.rows(r jsonb) returns text language sql immutable as $$
  select string_agg((e ->> 'status') || ' ' || coalesce(e ->> 'title', '-') || ' ' || coalesce(e ->> 'points', '-'), ' | ' order by (e ->> 'i')::int)
  from jsonb_array_elements(r -> 'rows') e
$$;
grant execute on function pg_temp.rows(jsonb) to authenticated;
create function pg_temp.marks() returns text language sql stable security definer as $$
  select string_agg(a.title || ' ' || coalesce(a.school_mark, '-') || ' ' || coalesce(a.grade, '-'), ' | ' order by a.title)
  from public.assignments a where a.school_mark is not null
$$;
grant execute on function pg_temp.marks() to authenticated;
create function pg_temp.balance() returns int language sql stable security definer as $$
  select coalesce(sum(delta), 0)::int from public.points_ledger where kid_id = test.person('Taylor')
$$;
grant execute on function pg_temp.balance() to authenticated;

select test.is(hub_schema_version(), 39, 'hub_schema_version is 39');

-- ---------------------------------------------------------------------
-- The schema and its grants
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
select test.is((select pts_bonus_week from homework_kids where kid_id = test.person('Taylor')), 50, 'pts_bonus_week is 50 by default');
select test.ok(has_column_privilege('authenticated', 'public.homework_kids', 'pts_bonus_week', 'update')
               and not has_column_privilege('anon', 'public.homework_kids', 'pts_bonus_week', 'update')
               and not has_column_privilege('authenticated', 'public.points_ledger', 'bonus', 'insert'),
               'a parent changes the limit (a column grant); nobody writes points_ledger.bonus from the browser');
select test.is((select string_agg(r || ':' || has_function_privilege(r, 'public.paste_grades(uuid, jsonb, boolean)', 'execute'), ',' order by r)
                from unnest(array['anon', 'authenticated', 'service_role']) r),
               'anon:false,authenticated:true,service_role:false', 'paste_grades: signed in only');
select test.is((select array_to_string(p.proconfig, ',') || ' ' || p.prosecdef from pg_proc p where p.oid = 'public.paste_grades(uuid, jsonb, boolean)'::regprocedure),
               'search_path="" true', '... a definer with an empty search_path');

insert into points_ledger (kid_id, at, day, kind, delta, note, who) values
  (test.person('Taylor'), '2026-11-20 21:00+00', '2026-11-20', 'given', 100, 'Starting points', 'alex@example.com');
insert into assignments (id, kid_id, title, subject, due_date, status) values
  ('c0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'Lab Report', 'Science 6', '2026-11-20', 'done'),
  ('c0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'Essay', 'English', '2026-11-02', 'done'),
  ('c0000000-0000-4000-8000-000000000003', test.person('Taylor'), 'Quiz 4', 'Math 7', '2026-11-23', 'done'),
  ('c0000000-0000-4000-8000-000000000004', test.person('Taylor'), 'Map Project', 'History', '2026-11-24', 'open'),
  ('c0000000-0000-4000-8000-000000000005', test.person('Taylor'), 'Volume Problems', 'Science 6', '2026-11-18', 'open'),
  ('c0000000-0000-4000-8000-000000000006', test.person('Taylor'), 'Weekly Practice', 'Math 7', '2026-11-13', 'done'),
  ('c0000000-0000-4000-8000-000000000007', test.person('Taylor'), 'Weekly Practice', 'Math 7', '2026-11-20', 'done');
:as_admin
update assignments set school_mark = 'missing' where id = 'c0000000-0000-4000-8000-000000000005';
:as_owner
select test.is(pg_temp.balance(), 90, 'Volume Problems marked Missing: 10 off (0036), balance 90');

-- ---------------------------------------------------------------------
-- Preview: what would happen, nothing changed
-- ---------------------------------------------------------------------
:as_admin
select test.is(pg_temp.rows(paste_grades(test.person('Taylor'), $$[
    {"title": "lab  report", "class": "Science 6 (A) Pat Teacher", "due": "2026-11-21", "grade": "93%"},
    {"title": "Essay", "class": "English", "due": "2026-11-02", "grade": "88%"},
    {"title": "Quiz 4", "class": "Math 7", "due": "2026-11-23", "grade": "72%"},
    {"title": "Poster", "class": "Art", "due": "2026-11-20", "grade": "100%"},
    {"title": "Map Project", "class": "History", "due": "2026-11-24", "grade": "Pass"},
    {"title": "Weekly Practice", "class": "Math 7", "due": "2026-11-19", "grade": "100%"}
  ]$$::jsonb, false)),
  'graded Lab Report - | older Essay - | graded Quiz 4 - | not_found Poster - | bad Map Project - | graded Weekly Practice -',
  'preview: the lab report (title in any case and spacing, the class with its section and teacher, due a day off), the quiz and the nearest Weekly Practice would be graded; the essay is older than 14 days; the poster isn''t on the hub; "Pass" isn''t a grade');
select test.is(pg_temp.marks(), 'Volume Problems missing -', '... and nothing changed');

-- ---------------------------------------------------------------------
-- Apply: marked Graded, 0036's points follow
-- ---------------------------------------------------------------------
select test.is(pg_temp.rows(paste_grades(test.person('Taylor'), $$[
    {"title": "lab  report", "class": "Science 6 (A) Pat Teacher", "due": "2026-11-21", "grade": "93%"},
    {"title": "Essay", "class": "English", "due": "2026-11-02", "grade": "88%"},
    {"title": "Quiz 4", "class": "Math 7", "due": "2026-11-23", "grade": "72%"},
    {"title": "Weekly Practice", "class": "Math 7", "due": "2026-11-19", "grade": "100%"}
  ]$$::jsonb, true)),
  'graded Lab Report 10 | older Essay - | graded Quiz 4 -5 | graded Weekly Practice 10',
  'apply: the lab report +10, the quiz -5, the nearer Weekly Practice (Nov 20) +10; the essay left alone');
:as_owner
select test.is(pg_temp.marks(), 'Lab Report graded 93% | Quiz 4 graded 72% | Volume Problems missing - | Weekly Practice graded 100%',
               '... marked Graded with the report''s grade, as Alex');
select test.is((select count(*) from assignments where title = 'Weekly Practice' and school_mark = 'graded')::int, 1, '... only the Weekly Practice nearest the date');
select test.is((select string_agg(note || ' ' || delta || ' ' || coalesce(bonus::text, '-') || ' ' || who, ' | ' order by note) from points_ledger where kind in ('mark_on', 'mark_off') and assignment_id <> 'c0000000-0000-4000-8000-000000000005'),
               'Grade 100%: Weekly Practice 10 10 alex@example.com | Grade 72%: Quiz 4 -5 - alex@example.com | Grade 93%: Lab Report 10 10 alex@example.com',
               '... each line in his points, a bonus line with its bonus part');
:as_admin
select test.is(pg_temp.rows(paste_grades(test.person('Taylor'), $$[{"title": "Lab Report", "class": "Science 6", "due": "2026-11-20", "grade": "93%"}]$$::jsonb, true)),
               'same Lab Report -', 'the same report again: same, nothing more');

-- ---------------------------------------------------------------------
-- The bonus limit: 50 a week by default; here 25
-- ---------------------------------------------------------------------
:as_owner
update homework_kids set pts_bonus_week = 25 where kid_id = test.person('Taylor');
:as_admin
select test.is(pg_temp.rows(paste_grades(test.person('Taylor'), $$[{"title": "Map Project", "class": "History", "due": "2026-11-24", "grade": "A"}]$$::jsonb, true)),
               'graded Map Project 5', 'a third bonus this week: only the 5 left of 25');
select test.is(pg_temp.rows(paste_grades(test.person('Taylor'), $$[{"title": "Volume Problems", "class": "Science 6", "due": "2026-11-18", "grade": "96"}]$$::jsonb, true)),
               'graded Volume Problems 10', 'Missing, then a 96 with no bonus left: the 10 taken come back, no bonus');
:as_owner
select test.is((select coalesce(sum(bonus), 0)::int from points_ledger where kid_id = test.person('Taylor')), 25, '... the week''s bonuses add up to 25');
:as_admin
select test.is(pg_temp.rows(paste_grades(test.person('Taylor'), $$[{"title": "Map Project", "class": "History", "due": "2026-11-24", "grade": "A"}]$$::jsonb, true)),
               'same Map Project -', 'the same grade again changes nothing');
update assignments set grade = '99' where id = 'c0000000-0000-4000-8000-000000000004';
:as_owner
select test.is((select coalesce(sum(delta), 0)::int from points_ledger where assignment_id = 'c0000000-0000-4000-8000-000000000004'), 5,
               'the limit is for any bonus, typed or pasted: the map regraded by hand (still a bonus) adds nothing while the week is full');
:as_admin
select test.is(pg_temp.rows(paste_grades(test.person('Taylor'), $$[{"title": "Lab Report", "class": "Science 6", "due": "2026-11-20", "grade": "85%"}]$$::jsonb, true)),
               'graded Lab Report -10', 'a grade corrected to 85: its bonus taken back');
:as_owner
select test.is((select coalesce(sum(bonus), 0)::int from points_ledger where kid_id = test.person('Taylor')), 15, '... the week''s bonuses now 15');
:as_admin
update assignments set grade = '98' where id = 'c0000000-0000-4000-8000-000000000004';
:as_owner
select test.is((select coalesce(sum(delta), 0)::int from points_ledger where assignment_id = 'c0000000-0000-4000-8000-000000000004'), 10,
               '... with room again, a changed grade tops the map up to the full 10');
select test.is(pg_temp.balance(), 115, 'his balance: 100, Missing -10, the lab +10 then -10, the quiz -5, the practice +10, the map +5 then +5, the volume +10');

-- ---------------------------------------------------------------------
-- Refusals
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.run($$select paste_grades(test.person('Taylor'), '[{"title": "Lab Report", "due": "2026-11-20", "grade": "99"}]', true)$$),
               '42501 Only a parent or the coach can paste grades.', 'Sam (not a parent or the coach): refused');
:as_admin
select test.is(pg_temp.run($$select paste_grades(test.person('Taylor'), '[]', false)$$), '22023 Paste the grade report first.', 'nothing pasted: refused');
select test.is(pg_temp.run($$select paste_grades(test.person('Sam'), '[{"title": "x", "due": "2026-11-20", "grade": "99"}]', false)$$),
               '22023 Homework isn''t on for that person.', 'someone without homework: refused');
select test.is(pg_temp.run($$select paste_grades(test.person('Taylor'), (select jsonb_agg(jsonb_build_object('title', 'x', 'due', '2026-11-20', 'grade', '99')) from generate_series(1, 401)), false)$$),
               '22023 That''s more than 400 grades. Paste one report at a time.', 'over 400 rows: refused');
