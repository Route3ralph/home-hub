-- Nudge, Start and the week's numbers (migration 0034, docs/v1.3-homework.md §34): a parent or the coach taps Nudge on
-- a kid's task (nudge_task, unnudge_task within 15 minutes); a kid with homework on taps Start on his own open task on
-- his My day (start_by_token, once per task and date), which pays homework_kids.pts_start when nobody nudged that task
-- for that date first (at most 3 a day, points on); his My day marks each open task of his can_start or started;
-- task_week and the coach view's week give the household week's numbers. A nudge never reaches his My day.
-- The household is fixtures.sql's: Alex (admin), Sam (adult, not the coach), Taylor (the kid), Morgan (the helper).
-- Everything is made up. hub.now moves through Tue Nov 3, 2026 (America/New_York); the week is Mon Nov 2 to Sun Nov 8.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-03 06:30 America/New_York';
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated;
create function pg_temp.task(p_title text) returns uuid language sql stable security definer as $$
  select t.id from public.tasks t where t.title = p_title
$$;
grant execute on function pg_temp.task(text) to anon, authenticated;
-- His My day's mark on one task (today's or late): started, can_start, or '-'.
create function pg_temp.mark(d jsonb, p_title text) returns text language sql immutable as $$
  select coalesce((select coalesce(x ->> 'started', case when (x ->> 'can_start')::boolean then 'can_start' end, '-')
                   from (select jsonb_array_elements(dy -> 'items') x from jsonb_array_elements(d -> 'days') dy
                         union all select jsonb_array_elements(d -> 'late')) i
                   where x ->> 'title' = p_title limit 1), 'missing')
$$;
grant execute on function pg_temp.mark(jsonb, text) to anon, authenticated;
create function pg_temp.balance() returns int language sql stable security definer as $$
  select coalesce(sum(l.delta), 0)::int from public.points_ledger l where l.kid_id = test.person('Taylor')
$$;

select test.is(hub_schema_version(), 41, 'hub_schema_version is 41');

:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
-- His bed every day at 7:00am, the trash today by 6:00pm, last week's library books (late), Sam's lawn, the helper's cat.
insert into tasks (title, category, responsible_id, due_date, due_time, repeat_mode, every_count, every_unit, anchor_date, active) values
  ('Make bed', 'home', test.person('Taylor'), '2026-11-03', '07:00', 'schedule', 1, 'day', '2026-11-03', true),
  ('Take out trash', 'home', test.person('Taylor'), '2026-11-03', '18:00', 'none', null, null, null, true),
  ('Return library books', 'other', test.person('Taylor'), '2026-10-30', null, 'none', null, null, null, true),
  ('Mow the lawn', 'home', test.person('Sam'), '2026-11-03', null, 'none', null, null, null, true),
  ('Feed the cat', 'pets', test.person('Morgan'), '2026-11-03', null, 'schedule', 1, 'day', '2026-11-03', true);

-- ---------------------------------------------------------------------
-- Tables and grants
-- ---------------------------------------------------------------------
select test.ok((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.task_nudges'::regclass, 'public.task_starts'::regclass)),
               'task_nudges and task_starts: RLS on');
select test.ok(not has_table_privilege('anon', 'public.task_nudges', 'select') and not has_table_privilege('anon', 'public.task_starts', 'select')
               and not has_table_privilege('authenticated', 'public.task_nudges', 'insert') and not has_table_privilege('authenticated', 'public.task_nudges', 'delete')
               and not has_table_privilege('authenticated', 'public.task_starts', 'insert') and not has_table_privilege('authenticated', 'public.task_starts', 'update'),
               '... nothing for anon; signed in, read only (the functions write)');
select test.ok(has_function_privilege('authenticated', 'public.nudge_task(uuid, date)', 'execute') and not has_function_privilege('anon', 'public.nudge_task(uuid, date)', 'execute')
               and has_function_privilege('authenticated', 'public.unnudge_task(uuid)', 'execute') and not has_function_privilege('anon', 'public.unnudge_task(uuid)', 'execute')
               and has_function_privilege('authenticated', 'public.task_week(uuid, date)', 'execute') and not has_function_privilege('anon', 'public.task_week(uuid, date)', 'execute')
               and has_function_privilege('anon', 'public.start_by_token(text, uuid, date)', 'execute')
               and has_function_privilege('anon', 'public.get_person_day(text)', 'execute'),
               'nudge_task, unnudge_task, task_week: signed in only; start_by_token and get_person_day: anon');
select test.ok(not has_function_privilege('anon', 'private.get_person_day_v33(text)', 'execute') and not has_function_privilege('authenticated', 'private.get_person_day_v33(text)', 'execute')
               and not has_function_privilege('authenticated', 'private.task_week(uuid, date)', 'execute') and not has_function_privilege('anon', 'private.coach_view(uuid)', 'execute'),
               '... the moved get_person_day, private.task_week and the coach view: nobody');
select test.is((select string_agg(distinct array_to_string(p.proconfig, ','), ' ') from pg_proc p
                where p.oid in ('public.nudge_task(uuid, date)'::regprocedure, 'public.unnudge_task(uuid)'::regprocedure, 'public.start_by_token(text, uuid, date)'::regprocedure,
                                'public.get_person_day(text)'::regprocedure, 'public.task_week(uuid, date)'::regprocedure, 'private.task_week(uuid, date)'::regprocedure,
                                'private.coach_view(uuid)'::regprocedure)),
               'search_path=""', 'every new function: an empty search_path');
select test.is((select k.pts_start from homework_kids k where k.kid_id = test.person('Taylor')), 5, 'pts_start: 5 by default');

-- ---------------------------------------------------------------------
-- His My day: can_start on his own open tasks, nothing for others
-- ---------------------------------------------------------------------
:as_anon
select get_person_day(test.token('Taylor')) as d0 \gset
select test.is(pg_temp.mark(:'d0', 'Make bed') || ' | ' || pg_temp.mark(:'d0', 'Take out trash') || ' | ' || pg_temp.mark(:'d0', 'Return library books'),
               'can_start | can_start | can_start', 'his My day: each open task of his can be started, a late one too');
:as_owner
select test.is(get_person_day(test.token('Morgan')), private.get_person_day_v33(test.token('Morgan')), 'the helper''s My day: exactly as on 33');
select test.ok(not (get_person_day(test.token('Morgan'))::text ~ 'can_start|started'), '... no Start on it');

-- ---------------------------------------------------------------------
-- Nudge
-- ---------------------------------------------------------------------
:as_anon
select test.ok(pg_temp.run(format('select nudge_task(%L, %L)', pg_temp.task('Take out trash'), '2026-11-03')) ~ '^42501', 'anon can''t nudge');
:as_adult
select test.is(pg_temp.run(format('select nudge_task(%L, %L)', pg_temp.task('Take out trash'), '2026-11-03')), '42501 Only a parent can nudge.', 'Sam (an adult, not the coach) can''t nudge');
:as_admin
select test.is(pg_temp.run(format('select nudge_task(%L, %L)', pg_temp.task('Mow the lawn'), '2026-11-03')), '22023 Only a kid''s task can be nudged.', 'Sam''s lawn: not a kid''s task');
select test.is(pg_temp.run(format('select nudge_task(%L, %L)', pg_temp.task('Take out trash'), '2026-11-04')), '22023 Only a task due today or in the last 30 days can be nudged.', 'a date still to come');
select test.is(pg_temp.run(format('select nudge_task(%L, null)', pg_temp.task('Take out trash'))), '22023 That needs the task and its date.', 'no date');
select test.is(pg_temp.run(format('select nudge_task(%L, %L)', gen_random_uuid(), '2026-11-03')), '22023 That task is gone.', 'an unknown task');
select nudge_task(pg_temp.task('Take out trash'), '2026-11-03') as n1 \gset
select test.is((:'n1'::jsonb ->> 'count')::int, 1, 'Alex nudges his trash at 6:30am: count 1');
select test.is((select n.who || ' ' || to_char(n.at at time zone 'America/New_York', 'HH24:MI') || ' ' || n.occurrence from task_nudges n where n.id = (:'n1'::jsonb ->> 'id')::uuid),
               'alex@example.com 06:30 2026-11-03', '... time-stamped, by Alex, for the date');
select (nudge_task(pg_temp.task('Take out trash'), '2026-11-03') ->> 'count')::int as c2 \gset
select test.is(:'c2'::int, 2, 'and again: as many as needed (2)');
select test.is(unnudge_task((select n.id from task_nudges n order by n.at desc, n.id limit 1)), true, 'Undo within 15 minutes: the second goes');
select test.is((select count(*) from task_nudges)::int, 1, '... one left');
:as_adult
select test.is((select count(*) from task_nudges)::int, 0, 'Sam reads no nudges');
:as_anon
select get_person_day(test.token('Taylor')) as d1 \gset
select test.ok(not (:'d1'::text ~* 'nudg|remind'), 'a nudge never reaches his My day');

-- ---------------------------------------------------------------------
-- Start
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-03 07:05 America/New_York';
:as_anon
select test.is(start_by_token(test.token('Morgan'), pg_temp.task('Feed the cat'), '2026-11-03'), null, 'the helper''s token: null (kids with homework only)');
select test.is(pg_temp.run(format('select start_by_token(%L, %L, %L)', test.token('Taylor'), pg_temp.task('Mow the lawn'), '2026-11-03')), '42501 That isn''t on your day.', 'Sam''s lawn: not his');
select test.is(pg_temp.run(format('select start_by_token(%L, %L, %L)', test.token('Taylor'), pg_temp.task('Make bed'), '2026-11-02')), '22023 That isn''t on your day any more.', 'a date that isn''t the task''s');
select test.is(pg_temp.run(format('select start_by_token(%L, %L, null)', test.token('Taylor'), pg_temp.task('Make bed'))), '22023 That needs the task and its date.', 'no date');
select start_by_token(test.token('Taylor'), pg_temp.task('Make bed'), '2026-11-03') as s1 \gset
select test.is((:'s1'::jsonb ->> 'paid')::int, 5, 'Start on his bed at 7:05am, with no nudge: +5');
select test.is(pg_temp.mark(:'s1', 'Make bed'), '07:05', '... the answer is his day, the bed marked started 07:05');
select test.is((start_by_token(test.token('Taylor'), pg_temp.task('Make bed'), '2026-11-03') ->> 'paid')::int, 0, 'Start again: nothing more');
:as_owner
select test.is((select count(*) from task_starts)::int, 1, '... one start');
select test.is((select l.kind || ' ' || l.delta || ' ' || l.note || ' ' || l.who from points_ledger l where l.kind = 'start'), 'start 5 Make bed Taylor (My day)', 'the ledger line');
set hub.now = '2026-11-03 07:20 America/New_York';
:as_anon
select complete_by_token(test.token('Taylor'), pg_temp.task('Make bed'), '2026-11-03') is not null as ticked \gset
select test.ok(:'ticked', 'he ticks his bed at 7:20am');
:as_owner
set hub.now = '2026-11-03 17:30 America/New_York';
:as_anon
select test.is((start_by_token(test.token('Taylor'), pg_temp.task('Take out trash'), '2026-11-03') ->> 'paid')::int, 0, 'Start on the trash at 5:30pm, nudged this morning: no bonus');
:as_owner
set hub.now = '2026-11-03 17:40 America/New_York';
:as_anon
select complete_by_token(test.token('Taylor'), pg_temp.task('Take out trash'), '2026-11-03') is not null as ticked2 \gset
select test.ok(:'ticked2', 'he ticks the trash at 5:40pm');

-- ---------------------------------------------------------------------
-- The week's numbers (Mon Nov 2 to Tue Nov 3 so far), worked by hand:
--   assigned 2: the bed (done) and the trash (done); the library books were due last week and the bed's next date is
--     tomorrow, so neither counts yet.
--   done 2; on time 1 (the trash, 5:40pm by 6:00pm; the bed, 7:20am after 7:00am, is late); reminders 1;
--   started 2, unprompted 1 (the bed); minutes to start: bed 5, trash 0 (before its time) -> 2.5 -> 3;
--   minutes to finish: bed 15, trash 10 -> 12.5 -> 13; points 5.
-- ---------------------------------------------------------------------
:as_admin
select task_week(test.person('Taylor'), '2026-11-04') as w \gset
select test.is(:'w'::jsonb - 'from' - 'to',
               '{"assigned": 2, "done": 2, "on_time": 1, "reminders": 1, "started": 2, "started_unprompted": 1, "avg_minutes_to_start": 3, "avg_minutes_to_finish": 13, "points": 5}'::jsonb,
               'task_week: the numbers worked by hand');
select test.is((:'w'::jsonb ->> 'from') || ' ' || (:'w'::jsonb ->> 'to'), '2026-11-02 2026-11-08', '... for the week Mon Nov 2 to Sun Nov 8 (any day of it)');
select test.is((task_week(test.person('Taylor'), '2026-10-26') - 'from' - 'to') ->> 'assigned', '1', 'last week: the library books, still open');
select test.is(pg_temp.run(format('select task_week(%L, null)', test.person('Sam'))), '22023 That isn''t a kid.', 'task_week of an adult: refused');
:as_adult
select test.is(pg_temp.run(format('select task_week(%L, null)', test.person('Taylor'))), '42501 Only a parent can see this.', 'Sam can''t read it');
:as_anon
select test.ok(pg_temp.run(format('select task_week(%L, null)', test.person('Taylor'))) ~ '^42501', 'nor anon');

-- The tutor link's coach view: this week and last week.
:as_admin
select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true);
select set_tutor_coach((select id from tutor_links where label = 'Pat Lee, tutor'), true);
:as_owner
select private.coach_view((select id from tutor_links where label = 'Pat Lee, tutor')) -> 'week' as cw \gset
select test.is(:'cw'::jsonb -> 'this', :'w'::jsonb, 'the coach view: this week''s numbers, as task_week');
select test.is(:'cw'::jsonb -> 'last' ->> 'from', '2026-10-26', '... and last week''s');
select test.ok(not (:'cw'::text ~ 'alex@|who'), '... never who nudged');

-- ---------------------------------------------------------------------
-- The bonus: at most 3 a day; none with points off
-- ---------------------------------------------------------------------
insert into tasks (title, category, responsible_id, due_date, repeat_mode, active) values
  ('Chore A', 'home', test.person('Taylor'), '2026-11-03', 'none', true),
  ('Chore B', 'home', test.person('Taylor'), '2026-11-03', 'none', true),
  ('Chore C', 'home', test.person('Taylor'), '2026-11-03', 'none', true);
:as_anon
select test.is((start_by_token(test.token('Taylor'), pg_temp.task('Chore A'), '2026-11-03') ->> 'paid')
               || ' ' || (start_by_token(test.token('Taylor'), pg_temp.task('Chore B'), '2026-11-03') ->> 'paid')
               || ' ' || (start_by_token(test.token('Taylor'), pg_temp.task('Chore C'), '2026-11-03') ->> 'paid'),
               '5 5 0', 'three more starts with no nudge: 5, 5, then nothing (3 a day)');
:as_owner
insert into tasks (title, category, responsible_id, due_date, repeat_mode, active) values ('Chore D', 'home', test.person('Taylor'), '2026-11-03', 'none', true);
set hub.now = '2026-11-04 08:00 America/New_York';
update tasks set due_date = '2026-11-04' where title = 'Chore D';
update homework_kids set points_on = false where kid_id = test.person('Taylor');
:as_anon
select test.is((start_by_token(test.token('Taylor'), pg_temp.task('Chore D'), '2026-11-04') ->> 'paid')::int, 0, 'points off: Start is kept, nothing paid');
:as_owner
select test.is(pg_temp.balance(), 15, 'his balance: three starts of 5');
select test.is((select count(*) from task_starts)::int, 6, 'six starts kept');

-- unnudge: only your own, within 15 minutes.
:as_admin
select nudge_task(pg_temp.task('Make bed'), '2026-11-04') ->> 'id' as n3 \gset
:as_owner
set hub.now = '2026-11-04 08:16 America/New_York';
:as_admin
select test.is(unnudge_task(:'n3'::uuid), false, 'Undo after 16 minutes: refused (false), the nudge stays');
