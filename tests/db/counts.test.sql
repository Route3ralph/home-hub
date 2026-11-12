-- Homework counts (migration 0026, docs/v1.3-homework.md §27): an assignment can carry a count ("7 topics"). A parent
-- or the coach sets it and moves it on the Homework page (public.assignments.count_goal and count_done; the table's own
-- policies decide who); the kid moves it from his My day, +1 or −1 (count_by_token, with the count his screen showed,
-- so a resend or a stale tap changes nothing). Reaching the count makes an open assignment done; going back below it
-- makes a done one open again; an update that also sets the status is left as it says. His view gives each assignment
-- with a count its count. Grants, the checks, and that nothing else changes.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (a kid), Morgan (a helper), Jordan (removed).
-- Everything is made up.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-12 17:00 America/New_York';
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated;
create function pg_temp.st(p_id uuid) returns text language sql stable security definer as $$
  select coalesce(count_goal::text, '-') || ' ' || count_done || ' ' || status || ' ' || (done_at is not null)::text from public.assignments where id = p_id
$$;
grant execute on function pg_temp.st(uuid) to anon, authenticated;
-- What his view says about one assignment's count ('-' when it has none, 'absent' when it isn't in the view).
create function pg_temp.vc(p_view jsonb, p_id uuid) returns text language sql immutable as $$
  select coalesce((select coalesce(x -> 'count', '"-"')::text from jsonb_array_elements(p_view -> 'assignments') x where x ->> 'id' = p_id::text), 'absent')
$$;
grant execute on function pg_temp.vc(jsonb, uuid) to anon, authenticated;
create function pg_temp.tap(p_id uuid, p_from int, p_delta int) returns text language plpgsql as $$
declare
  v jsonb;
begin
  v := public.count_by_token(test.token('Taylor'), p_id, p_from, p_delta);
  return coalesce(pg_temp.vc(v, p_id), 'null');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.tap(uuid, int, int) to anon, authenticated;

:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
insert into assignments (id, kid_id, kind, title, subject, due_date, status) values
  ('c0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'assignment', 'ALEKS topics', 'Math', '2026-11-16', 'open'),
  ('c0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'assignment', 'Volcano poster', 'Science', '2026-11-18', 'open'),
  ('c0000000-0000-4000-8000-000000000003', test.person('Taylor'), 'assignment', 'IXL questions', 'Math', '2026-11-19', 'dropped');

-- ---------------------------------------------------------------------
-- The schema and its grants
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 26, 'hub_schema_version is 26');
select test.is((select string_agg(column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '-'), ', ' order by column_name)
                from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name in ('count_goal', 'count_done')),
               'count_done integer NO 0, count_goal integer YES -', 'assignments.count_goal (null: no count) and count_done (0 by default)');
select test.is((select string_agg(pg_temp.st(id), ', ' order by id) from assignments), '- 0 open false, - 0 open false, - 0 dropped false', 'no assignment has a count at first');
select test.ok(has_column_privilege('authenticated', 'public.assignments', 'count_goal', 'update') and has_column_privilege('authenticated', 'public.assignments', 'count_done', 'update')
               and not has_column_privilege('anon', 'public.assignments', 'count_goal', 'select') and not has_column_privilege('anon', 'public.assignments', 'count_done', 'update'),
               'grants: authenticated may update the two (the policies decide who); anon nothing');
select test.ok(has_function_privilege('anon', 'public.count_by_token(text, uuid, int, int)', 'execute')
               and has_function_privilege('authenticated', 'public.count_by_token(text, uuid, int, int)', 'execute')
               and not has_function_privilege('service_role', 'public.count_by_token(text, uuid, int, int)', 'execute'),
               'count_by_token: anon and authenticated, not service_role (as the other My day functions)');
select test.ok(not has_function_privilege('anon', 'private.homework_view_kid(uuid, text)', 'execute')
               and not has_function_privilege('authenticated', 'private.homework_view_kid(uuid, text)', 'execute')
               and not has_function_privilege('authenticated', 'private.homework_view_kid_v25(uuid, text)', 'execute')
               and not has_function_privilege('authenticated', 'private.assignment_count_status()', 'execute'),
               'private.homework_view_kid, its 0025 form and the trigger''s function: nobody but the functions and the trigger');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%') from pg_proc p
                where p.proname in ('count_by_token', 'homework_view_kid', 'homework_view_kid_v25', 'assignment_count_status')),
               '... each with set search_path');

-- With no count anywhere, his view is exactly 25's.
select test.is(homework_by_token(test.token('Taylor')), private.homework_view_kid_v25(test.person('Taylor'), 'en'), 'with no count set, his view is exactly 25''s (no count key)');

-- ---------------------------------------------------------------------
-- A parent sets a count; the checks
-- ---------------------------------------------------------------------
:as_admin
select test.is(pg_temp.run($$update assignments set count_goal = 7 where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'Alex sets ALEKS topics to 7');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 0 open false', '... 0 of 7, open');
select test.is(pg_temp.run($$update assignments set count_goal = 0 where id = 'c0000000-0000-4000-8000-000000000002'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_count_goal_check"', 'a count of 0: refused (null means none)');
select test.is(pg_temp.run($$update assignments set count_goal = 201 where id = 'c0000000-0000-4000-8000-000000000002'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_count_goal_check"', 'a count over 200: refused');
select test.is(pg_temp.run($$update assignments set count_goal = 200 where id = 'c0000000-0000-4000-8000-000000000002'$$), 'ok', '... 200 is fine');
select test.is(pg_temp.run($$update assignments set count_goal = null where id = 'c0000000-0000-4000-8000-000000000002'$$), 'ok', '... and cleared');
select test.is(pg_temp.run($$update assignments set count_done = 1 where id = 'c0000000-0000-4000-8000-000000000002'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_count_in_range"', 'a count done with no count: refused');
select test.is(pg_temp.run($$update assignments set count_done = 8 where id = 'c0000000-0000-4000-8000-000000000001'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_count_in_range"', 'past the count: refused');
select test.is(pg_temp.run($$update assignments set count_done = -1 where id = 'c0000000-0000-4000-8000-000000000001'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_count_done_check"', 'below 0: refused');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 0 open false', '... each left it as it was');

-- Who: Sam (an adult, no coach box), a stranger and anon change nothing (the table's policies).
:as_adult
select test.is(pg_temp.run($$update assignments set count_done = 3 where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'Sam''s update runs ...');
:as_stranger
select test.is(pg_temp.run($$update assignments set count_done = 3 where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'a stranger''s too ...');
:as_anon
select test.ok(pg_temp.run($$update assignments set count_done = 3 where id = 'c0000000-0000-4000-8000-000000000001'$$) like '42501 %', 'anon: refused');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 0 open false', '... and none of them changed it');

-- ---------------------------------------------------------------------
-- His view and his taps
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.vc(homework_by_token(test.token('Taylor')), 'c0000000-0000-4000-8000-000000000001'), '{"done": 0, "goal": 7}', 'his view: ALEKS topics with its count, 0 of 7');
select test.is(pg_temp.vc(homework_by_token(test.token('Taylor')), 'c0000000-0000-4000-8000-000000000002'), '"-"', '... the poster with none');
:as_owner
select test.is((select jsonb_set(homework_by_token(test.token('Taylor')), '{assignments}',
                                 (select jsonb_agg(x - 'count' order by n) from jsonb_array_elements(homework_by_token(test.token('Taylor')) -> 'assignments') with ordinality t (x, n)))),
               private.homework_view_kid_v25(test.person('Taylor'), 'en'), '... and otherwise exactly 25''s view');
:as_anon
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 0, 1), '{"done": 1, "goal": 7}', '+1 from 0: 1 of 7, and the answer is his view');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 0, 1), '{"done": 1, "goal": 7}', 'the same tap sent again (from 0): still 1');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 1, -1), '{"done": 0, "goal": 7}', '−1 from 1: 0');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 0, -1), '{"done": 0, "goal": 7}', '−1 from 0: still 0 (never below)');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 3, 1), '{"done": 0, "goal": 7}', 'a tap from a count that isn''t the count (3): nothing');
:as_owner
select test.is((select updated_by from assignments where id = 'c0000000-0000-4000-8000-000000000001'), 'Taylor (My day)', 'his taps are written as "Taylor (My day)"');
:as_anon
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 0, 1) || pg_temp.tap('c0000000-0000-4000-8000-000000000001', 1, 1)
               || pg_temp.tap('c0000000-0000-4000-8000-000000000001', 2, 1) || pg_temp.tap('c0000000-0000-4000-8000-000000000001', 3, 1)
               || pg_temp.tap('c0000000-0000-4000-8000-000000000001', 4, 1) || pg_temp.tap('c0000000-0000-4000-8000-000000000001', 5, 1),
               '{"done": 1, "goal": 7}{"done": 2, "goal": 7}{"done": 3, "goal": 7}{"done": 4, "goal": 7}{"done": 5, "goal": 7}{"done": 6, "goal": 7}', 'six taps: 6 of 7');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 6 open false', '... still open');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 6, 1), '{"done": 7, "goal": 7}', 'the seventh: 7 of 7');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 7 done true', '... and the assignment is done (done_at stamped)');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 7, 1), '{"done": 7, "goal": 7}', '+1 past the count: nothing');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 7, -1), '{"done": 6, "goal": 7}', '−1 from 7 (a slip): 6');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 6 open false', '... and it is open again');

-- What he can't tap.
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000002', 0, 1), '22023 That one has no count.', 'an assignment with no count: "That one has no count."');
:as_owner
update assignments set count_goal = 5 where id = 'c0000000-0000-4000-8000-000000000003';
:as_anon
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000003', 0, 1), '22023 That one has no count.', '... nor a dropped one');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', 6, 2), '22023 Choose +1 or −1.', '+2: refused');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000001', null, 1), '22023 Choose +1 or −1.', 'no count from his screen: refused');
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000099', 0, 1), '42501 That assignment isn''t on your list.', 'an assignment that isn''t there: "isn''t on your list"');
:as_owner
insert into homework_kids (kid_id) values (test.person('Jordan'));
insert into assignments (id, kid_id, kind, title, due_date, count_goal) values
  ('c0000000-0000-4000-8000-000000000004', test.person('Jordan'), 'assignment', 'Someone else''s', '2026-11-16', 3);
:as_anon
select test.is(pg_temp.tap('c0000000-0000-4000-8000-000000000004', 0, 1), '42501 That assignment isn''t on your list.', '... nor one of another kid''s, the same words');
select test.is(count_by_token('not-a-token', 'c0000000-0000-4000-8000-000000000001', 6, 1), null, 'an unknown link: null (as every My day function)');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 6 open false', '... none of these changed it');

-- ---------------------------------------------------------------------
-- A parent and the status
-- ---------------------------------------------------------------------
:as_admin
select test.is(pg_temp.run($$update assignments set count_done = 7 where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'Alex moves it to 7 ...');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 7 done true', '... done');
select test.is(pg_temp.run($$update assignments set status = 'open' where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'Open again, at 7 of 7 ...');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 7 open false', '... open (an update that sets the status is left as it says)');
select test.is(pg_temp.run($$update assignments set count_done = 5, status = 'done' where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'Mark done at 5 of 7 ...');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 5 done true', '... done, at 5');
select test.is(pg_temp.run($$update assignments set count_done = 4 where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'then 4 ...');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '7 4 done true', '... still done (it wasn''t done by the count)');
select test.is(pg_temp.run($$update assignments set count_goal = 4 where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'the count lowered to 4, with 4 done ...');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '4 4 done true', '... done stays done');
select test.is(pg_temp.run($$update assignments set count_goal = null, count_done = 0 where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'the count taken off ...');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '- 0 done true', '... it stays done (taking a count off never opens it)');
select test.is(pg_temp.run($$update assignments set status = 'open', count_goal = 3 where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'open again with a count of 3 ...');
select test.is(pg_temp.run($$update assignments set count_goal = 2, count_done = 2 where id = 'c0000000-0000-4000-8000-000000000001'$$), 'ok', 'then 2 of 2 in one go ...');
select test.is(pg_temp.st('c0000000-0000-4000-8000-000000000001'), '2 2 done true', '... done');

-- ---------------------------------------------------------------------
-- Nothing else changes
-- ---------------------------------------------------------------------
:as_owner
select test.is((select count(*)::int from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                and p.prosrc ~ '\mcount_(goal|done)\M'), 3, 'only count_by_token, his view and the trigger read the count (not the tutor link, the board, Google or an email)');
select test.is((select count(*)::int from points_ledger), 0, 'a count pays no points');
