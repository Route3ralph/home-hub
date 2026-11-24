-- Points from the school's marks (migration 0036, docs/v1.3-homework.md §36): when a parent or the coach marks an
-- assignment Missing or Graded, private.mark_points makes its mark lines add up to what the mark is worth: Missing
-- -pts_missing (10), a grade under grade_floor (75) -pts_low_grade (5), a grade at grade_top (90) or more
-- +pts_high_grade (10), else 0; clearing or improving a mark gives the points back. Never more taken than his free
-- points or the week's pts_mark_week (50). Only with his points on.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (a kid). Everything is made up.
-- hub.now is Wed Nov 4, 2026 (America/New_York): this household week is Mon Nov 2 to Sun Nov 8.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-04 18:00 America/New_York';
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated;
create function pg_temp.balance() returns int language sql stable security definer as $$
  select coalesce(sum(delta), 0)::int from public.points_ledger where kid_id = test.person('Taylor')
$$;
grant execute on function pg_temp.balance() to anon, authenticated;
-- The mark lines, oldest first: "kind delta note".
create function pg_temp.lines() returns text language sql stable security definer as $$
  select coalesce(string_agg(kind || ' ' || delta || ' ' || note, ' | ' order by at, kind), '-')
  from public.points_ledger where kind in ('mark_off', 'mark_on')
$$;
grant execute on function pg_temp.lines() to anon, authenticated;
create function pg_temp.mark(p_id text, p_mark text, p_grade text) returns void language sql as $$
  update public.assignments set school_mark = p_mark, grade = p_grade where id = p_id::uuid
$$;
grant execute on function pg_temp.mark(text, text, text) to authenticated;

select test.is(hub_schema_version(), 38, 'hub_schema_version is 38');

:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
insert into assignments (id, kid_id, kind, title, subject, due_date, status) values
  ('a0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'assignment', 'Lab report', 'Science', '2026-11-03', 'open'),
  ('a0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'assignment', 'Essay', 'English', '2026-11-02', 'open'),
  ('a0000000-0000-4000-8000-000000000003', test.person('Taylor'), 'assignment', 'Quiz 4', 'Math', '2026-11-04', 'open');
insert into points_ledger (kid_id, at, day, kind, delta, note, who) values
  (test.person('Taylor'), '2026-11-02 21:00+00', '2026-11-02', 'given', 100, 'Starting points', 'alex@example.com');

-- ---------------------------------------------------------------------
-- The columns, kinds and grants
-- ---------------------------------------------------------------------
select test.is((select pts_missing || ' ' || pts_low_grade || ' ' || grade_floor || ' ' || pts_high_grade || ' ' || grade_top || ' ' || pts_mark_week
                from homework_kids where kid_id = test.person('Taylor')), '10 5 75 10 90 50', 'the values by default: 10, 5, below 75, 10, from 90, 50 a week');
select test.ok(has_column_privilege('authenticated', 'public.homework_kids', 'pts_missing', 'update')
               and has_column_privilege('authenticated', 'public.homework_kids', 'grade_floor', 'update')
               and has_column_privilege('authenticated', 'public.homework_kids', 'pts_mark_week', 'update')
               and not has_column_privilege('anon', 'public.homework_kids', 'pts_missing', 'update'),
               '... a parent changes them (column grants), anon never');
select test.ok(not has_function_privilege('authenticated', 'private.mark_points(uuid)', 'execute')
               and not has_function_privilege('anon', 'private.grade_number(text)', 'execute')
               and not has_function_privilege('authenticated', 'private.assignments_mark_points()', 'execute'),
               'private.mark_points, grade_number and the trigger function: nobody calls them directly');
select test.is((select string_agg(distinct array_to_string(p.proconfig, ','), ' ') from pg_proc p
                where p.oid in ('private.mark_points(uuid)'::regprocedure, 'private.grade_number(text)'::regprocedure, 'private.assignments_mark_points()'::regprocedure)),
               'search_path=""', 'every new function: an empty search_path');
select test.is(pg_temp.run($$update homework_kids set grade_floor = 90 where kid_id = test.person('Taylor')$$),
               '23514 new row for relation "homework_kids" violates check constraint "homework_kids_grade_order"', 'grade_floor must be below grade_top');

-- ---------------------------------------------------------------------
-- Grades as numbers
-- ---------------------------------------------------------------------
select test.is((select string_agg(coalesce(private.grade_number(g)::text, 'null'), ' ' order by n)
                from unnest(array['92', '72%', ' 88.5 ', '18/20', 'B+', 'c-', 'F', 'A', 'Pass', '', '7/0', '300']) with ordinality u (g, n)),
               '92 72 88.5 90.0 88 71 50 95 null null null null', 'grade_number: numbers, percents, fractions and letters; anything else null');

-- ---------------------------------------------------------------------
-- Missing, then made up
-- ---------------------------------------------------------------------
:as_admin
select pg_temp.mark('a0000000-0000-4000-8000-000000000001', 'missing', null);
select test.is(pg_temp.lines(), 'mark_off -10 Missing: Lab report', 'Missing: 10 points off, "Missing: Lab report"');
select test.is(pg_temp.balance(), 90, '... his balance 90');
select test.is((select who || ' ' || day from points_ledger where kind = 'mark_off'), 'alex@example.com 2026-11-04', '... written as Alex''s, today');
select pg_temp.mark('a0000000-0000-4000-8000-000000000001', 'missing', null);
select test.is((select count(*) from points_ledger where kind in ('mark_off', 'mark_on'))::int, 1, 'marking it Missing again changes nothing');
select pg_temp.mark('a0000000-0000-4000-8000-000000000001', null, null);
select test.is(pg_temp.lines(), 'mark_off -10 Missing: Lab report | mark_on 10 Made up: Lab report', 'cleared (made up): the 10 come back, "Made up: Lab report"');
select test.is(pg_temp.balance(), 100, '... back to 100');

-- ---------------------------------------------------------------------
-- Grades: low, corrected, high
-- ---------------------------------------------------------------------
:as_owner
delete from points_ledger where kind in ('mark_off', 'mark_on');
:as_admin
select pg_temp.mark('a0000000-0000-4000-8000-000000000002', 'graded', '72');
select test.is(pg_temp.lines(), 'mark_off -5 Grade 72: Essay', 'graded 72 (below 75): 5 off, "Grade 72: Essay"');
select pg_temp.mark('a0000000-0000-4000-8000-000000000002', 'graded', '75');
select test.is(pg_temp.lines(), 'mark_off -5 Grade 72: Essay | mark_on 5 Made up: Essay', 'corrected to 75: the 5 come back');
select pg_temp.mark('a0000000-0000-4000-8000-000000000002', 'graded', 'A-');
select test.is((select note || ' ' || delta from points_ledger where kind = 'mark_on' order by at desc, delta desc limit 1), 'Grade A-: Essay 10',
               'regraded A- (91): a 10-point bonus, "Grade A-: Essay"');
select pg_temp.mark('a0000000-0000-4000-8000-000000000002', 'graded', 'Pass');
select test.is((select note || ' ' || delta from points_ledger where kind = 'mark_off' order by at desc, delta limit 1), 'Mark changed: Essay -10',
               'a grade that isn''t a number: the bonus goes back, "Mark changed: Essay"');
select test.is((select coalesce(sum(delta), 0)::int from points_ledger where kind in ('mark_off', 'mark_on')), 0, '... the Essay''s mark lines add up to 0');
select pg_temp.mark('a0000000-0000-4000-8000-000000000002', 'graded', '18/20');
select test.is((select coalesce(sum(delta), 0)::int from points_ledger where assignment_id = 'a0000000-0000-4000-8000-000000000002'), 10, '18/20 (90): the bonus again');
select pg_temp.mark('a0000000-0000-4000-8000-000000000002', 'missing', null);
select test.is((select coalesce(sum(delta), 0)::int from points_ledger where assignment_id = 'a0000000-0000-4000-8000-000000000002'), -10,
               'from a bonus straight to Missing: 20 off in one line, the Essay at -10');

-- ---------------------------------------------------------------------
-- Limits: the week's 50, his free points, points off
-- ---------------------------------------------------------------------
:as_owner
delete from points_ledger where kind in ('mark_off', 'mark_on');
update homework_kids set pts_mark_week = 15 where kid_id = test.person('Taylor');
:as_admin
select pg_temp.mark('a0000000-0000-4000-8000-000000000001', 'missing', null);
select pg_temp.mark('a0000000-0000-4000-8000-000000000003', 'missing', null);
select test.is(pg_temp.lines(), 'mark_off -10 Missing: Lab report | mark_off -5 Missing: Quiz 4', 'a week''s limit of 15: the second Missing takes only 5');
select pg_temp.mark('a0000000-0000-4000-8000-000000000003', null, null);
select test.is((select coalesce(sum(delta), 0)::int from points_ledger where assignment_id = 'a0000000-0000-4000-8000-000000000003'), 0, '... cleared: only the 5 taken come back');
:as_owner
delete from points_ledger where kind in ('mark_off', 'mark_on');
update assignments set school_mark = null where kid_id = test.person('Taylor');
delete from points_ledger where kind in ('mark_off', 'mark_on');
update homework_kids set pts_mark_week = 50 where kid_id = test.person('Taylor');
insert into points_ledger (kid_id, at, day, kind, delta, note, who) values
  (test.person('Taylor'), '2026-11-03 21:00+00', '2026-11-03', 'taken', -96, 'Phone at the table', 'alex@example.com');
:as_admin
select pg_temp.mark('a0000000-0000-4000-8000-000000000001', 'missing', null);
select test.is(pg_temp.lines(), 'mark_off -4 Missing: Lab report', 'only 4 free points: Missing takes 4, never below zero');
select test.is(pg_temp.balance(), 0, '... his balance 0');
:as_owner
delete from points_ledger where kind in ('mark_off', 'mark_on', 'taken');
update assignments set school_mark = null where kid_id = test.person('Taylor');
delete from points_ledger where kind in ('mark_off', 'mark_on');
update homework_kids set points_on = false where kid_id = test.person('Taylor');
:as_admin
select pg_temp.mark('a0000000-0000-4000-8000-000000000001', 'missing', null);
select test.is(pg_temp.lines(), '-', 'points off: a mark moves nothing');
:as_owner
update homework_kids set points_on = true, pts_missing = 0 where kid_id = test.person('Taylor');
update assignments set school_mark = null where kid_id = test.person('Taylor');
:as_admin
select pg_temp.mark('a0000000-0000-4000-8000-000000000003', 'missing', null);
select test.is(pg_temp.lines(), '-', 'pts_missing 0: Missing moves nothing');

-- ---------------------------------------------------------------------
-- Who can mark
-- ---------------------------------------------------------------------
:as_adult
select pg_temp.mark('a0000000-0000-4000-8000-000000000002', 'missing', null);
select test.is((select school_mark from assignments where id = 'a0000000-0000-4000-8000-000000000002'), null, 'Sam (not a parent or the coach) can''t mark, so nothing moves');
select test.is(pg_temp.lines(), '-', '... and no line');
:as_owner
delete from assignments where id = 'a0000000-0000-4000-8000-000000000003';
select test.is((select count(*) from points_ledger where assignment_id is not null and kind in ('mark_off', 'mark_on'))::int, 0,
               'an assignment deleted: its lines stay, without the assignment');
