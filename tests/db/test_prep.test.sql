-- Study before tests (migration 0038, docs/v1.3-homework.md §38): with homework_kids.test_prep_days set, each of the
-- kid's open tests with no plan of its own gets the starter test plan's five study steps on the days before it, keeps
-- its turn-in (or gets one), and is given to his My day. Once per test. Setting the days plans at once; the hourly
-- school read (private.school_apply) plans what came in since.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (a kid). Everything is made up.
-- hub.now is Wed Nov 4, 2026, 14:00 in the household's time zone.
\ir roles.sql
\ir fixtures.sql

:as_owner
select set_config('hub.now', ((date '2026-11-04' + time '14:00') at time zone private.tz())::text, false);
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated, service_role;
-- An assignment's plan, in order: "kind day minutes title".
create function pg_temp.plan(p_title text) returns text language sql stable security definer as $$
  select coalesce(string_agg(s.kind || ' ' || to_char(s.day, 'MM-DD') || ' ' || s.minutes || ' ' || s.title, ' | ' order by s.pos, s.id), '-')
  from public.homework_steps s join public.assignments a on a.id = s.assignment_id where a.title = p_title
$$;
grant execute on function pg_temp.plan(text) to anon, authenticated, service_role;
create function pg_temp.planned() returns text language sql stable security definer as $$
  select coalesce(string_agg(a.title, ', ' order by a.title), '-') from public.assignments a where a.test_prep_at is not null
$$;
grant execute on function pg_temp.planned() to anon, authenticated, service_role;

select test.is(hub_schema_version(), 41, 'hub_schema_version is 41');

-- ---------------------------------------------------------------------
-- The setting, the mark and the grants
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
select test.is((select test_prep_days from homework_kids where kid_id = test.person('Taylor')), 0, 'test_prep_days is 0 (off) by default');
select test.is(pg_temp.run($$update homework_kids set test_prep_days = 8 where kid_id = test.person('Taylor')$$),
               '23514 new row for relation "homework_kids" violates check constraint "homework_kids_test_prep_days_check"', '... 0 to 7');
select test.ok(has_column_privilege('authenticated', 'public.homework_kids', 'test_prep_days', 'update')
               and not has_column_privilege('anon', 'public.homework_kids', 'test_prep_days', 'update')
               and not has_column_privilege('authenticated', 'public.assignments', 'test_prep_at', 'update'),
               'a parent changes the days (a column grant; the policy decides who); nobody writes test_prep_at from the browser');
select test.ok(not has_function_privilege('authenticated', 'private.test_prep(uuid)', 'execute')
               and not has_function_privilege('anon', 'private.test_prep(uuid)', 'execute')
               and not has_function_privilege('authenticated', 'private.school_apply(uuid)', 'execute')
               and not has_function_privilege('authenticated', 'private.homework_kids_test_prep()', 'execute'),
               'private.test_prep, school_apply and the trigger function: nobody calls them directly');
select test.is((select string_agg(distinct array_to_string(p.proconfig, ','), ' ') from pg_proc p
                where p.oid in ('private.test_prep(uuid)'::regprocedure, 'private.school_apply(uuid)'::regprocedure,
                                'private.homework_kids_test_prep()'::regprocedure)),
               'search_path=""', 'every new function: an empty search_path');

insert into assignments (id, kid_id, title, subject, due_date, status) values
  ('b0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'Unit 3 Test', 'Science', '2026-11-09', 'open'),
  ('b0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'Chapter 4 Quiz', 'Math', '2026-11-09', 'open'),
  ('b0000000-0000-4000-8000-000000000003', test.person('Taylor'), 'Vocab Test', 'English', '2026-11-10', 'open'),
  ('b0000000-0000-4000-8000-000000000004', test.person('Taylor'), 'Lab report', 'Science', '2026-11-09', 'open'),
  ('b0000000-0000-4000-8000-000000000005', test.person('Taylor'), 'Map Quiz', 'History', '2026-11-05', 'open'),
  ('b0000000-0000-4000-8000-000000000006', test.person('Taylor'), 'Spelling Test', 'English', '2026-11-04', 'open'),
  ('b0000000-0000-4000-8000-000000000007', test.person('Taylor'), 'Old Test', 'Math', '2026-11-09', 'done');
-- The quiz has only "Take the quiz" (as the page's quick plan writes it); the vocab test has a plan someone wrote.
insert into homework_steps (assignment_id, pos, kind, title, minutes, day, source) values
  ('b0000000-0000-4000-8000-000000000002', 1, 'turn_in', 'Take the Chapter 4 quiz', 5, '2026-11-09', 'typed'),
  ('b0000000-0000-4000-8000-000000000003', 1, 'step', 'Flash cards', 15, '2026-11-08', 'typed'),
  ('b0000000-0000-4000-8000-000000000003', 2, 'turn_in', 'Take the test', 5, '2026-11-10', 'typed');

select test.is(private.test_prep(test.person('Taylor')), 0, 'with test_prep_days 0 nothing is planned');
select test.is(pg_temp.planned(), '-', '... and no test is marked');

-- ---------------------------------------------------------------------
-- A parent sets 3 days: his waiting tests are planned at once
-- ---------------------------------------------------------------------
:as_admin
update homework_kids set test_prep_days = 3 where kid_id = test.person('Taylor');
select test.is(pg_temp.planned(), 'Chapter 4 Quiz, Map Quiz, Unit 3 Test',
               'setting 3 days plans the open tests with no plan of their own: not the one with a plan, the lab report, the one due today or the done one');
select test.is(pg_temp.plan('Unit 3 Test'),
               'start 11-06 10 List what the test covers | step 11-06 10 Make a study list | step 11-07 10 Practice the first half of the topics'
               || ' | milestone 11-07 10 Practice the second half | check 11-08 10 Quiz yourself | turn_in 11-09 5 Pack what you need',
               'Unit 3 Test (due Mon Nov 9): the five study steps over the 3 days before it, each cut to his first length (10), and the starter''s turn-in on the due date');
select test.is(pg_temp.plan('Chapter 4 Quiz'),
               'start 11-06 10 List what the test covers | step 11-06 10 Make a study list | step 11-07 10 Practice the first half of the topics'
               || ' | milestone 11-07 10 Practice the second half | check 11-08 10 Quiz yourself | turn_in 11-09 5 Take the Chapter 4 quiz',
               'Chapter 4 Quiz: the same study steps, and its own turn-in kept, last');
select test.is(pg_temp.plan('Map Quiz'),
               'start 11-04 10 List what the test covers | step 11-04 10 Make a study list | step 11-04 10 Practice the first half of the topics'
               || ' | milestone 11-04 10 Practice the second half | check 11-04 10 Quiz yourself | turn_in 11-05 5 Pack what you need',
               'Map Quiz (due tomorrow, at 2pm today): all five today, never before today');
select test.is(pg_temp.plan('Vocab Test'), 'step 11-08 15 Flash cards | turn_in 11-10 5 Take the test', 'the plan someone wrote is untouched');
select test.is(pg_temp.plan('Spelling Test') || ' / ' || pg_temp.plan('Old Test') || ' / ' || pg_temp.plan('Lab report'), '- / - / -',
               'nothing on the test due today, the done test or the lab report');
select test.is((select string_agg(distinct s.source || ' ' || s.updated_by || ' ' || (s.done_at is null), ', ') from homework_steps s
                where s.assignment_id = 'b0000000-0000-4000-8000-000000000001'),
               'template Home Hub true', 'the steps are ordinary steps: from the template, written by Home Hub, none done');
select test.is((select string_agg(a.title || ' ' || a.given_by || ' ' || a.plan_rev || ' ' || (a.given_at is not null), ', ' order by a.title)
                from assignments a where a.test_prep_at is not null),
               'Chapter 4 Quiz Home Hub 1 true, Map Quiz Home Hub 1 true, Unit 3 Test Home Hub 1 true',
               'each is given to his My day (by Home Hub), its plan_rev moved on');

-- ---------------------------------------------------------------------
-- Once per test
-- ---------------------------------------------------------------------
:as_owner
select test.is(private.test_prep(test.person('Taylor')), 0, 'running again plans nothing more');
delete from homework_steps s where s.assignment_id = 'b0000000-0000-4000-8000-000000000001' and s.kind <> 'turn_in';
select test.is(private.test_prep(test.person('Taylor')), 0, 'a parent who deletes the study steps isn''t overruled: the test was planned once');
select test.is(pg_temp.plan('Unit 3 Test'), 'turn_in 11-09 5 Pack what you need', '... its turn-in left as it is');

-- ---------------------------------------------------------------------
-- After 6pm, in Spanish, and on the hourly read
-- ---------------------------------------------------------------------
select set_config('hub.now', ((date '2026-11-04' + time '19:00') at time zone private.tz())::text, false);
update people set language = 'es' where id = test.person('Taylor');
insert into assignments (id, kid_id, title, subject, due_date, status) values
  ('b0000000-0000-4000-8000-000000000008', test.person('Taylor'), 'Examen de verbos', 'Spanish', '2026-11-06', 'open');
insert into school_feeds (id, kid_id, kind, host, url_end) values
  ('f0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'assignments', 'school.example', 'a1b2');
select private.school_apply('f0000000-0000-4000-8000-000000000001');
select test.is(pg_temp.plan('Examen de verbos'),
               'start 11-05 10 Apunta lo que entra en el examen | step 11-05 10 Haz una lista para estudiar | step 11-05 10 Practica la primera mitad de los temas'
               || ' | milestone 11-05 10 Practica la segunda mitad | check 11-05 10 Ponte a prueba | turn_in 11-06 5 Prepara lo que necesitas',
               'the hourly read plans a new test; at 7pm it starts tomorrow; in his language (Spanish)');
insert into assignments (id, kid_id, title, subject, due_date, status) values
  ('b0000000-0000-4000-8000-000000000009', test.person('Taylor'), 'Final Exam', 'Math', '2026-11-05', 'open');
select test.is(private.test_prep(test.person('Taylor')), 0, 'a test due tomorrow, found after 6pm, has no day left: nothing planned');
select test.is(pg_temp.plan('Final Exam'), '-', '... and it isn''t marked, so nothing is lost');

-- ---------------------------------------------------------------------
-- Who can set it, and homework off
-- ---------------------------------------------------------------------
update people set language = 'en' where id = test.person('Taylor');
update assignments set status = 'dropped' where title = 'Final Exam';
select set_config('hub.now', ((date '2026-11-04' + time '14:00') at time zone private.tz())::text, false);
update homework_kids set test_prep_days = 0 where kid_id = test.person('Taylor');
insert into assignments (id, kid_id, title, subject, due_date, status) values
  ('b0000000-0000-4000-8000-000000000010', test.person('Taylor'), 'Fractions Test', 'Math', '2026-11-12', 'open');
:as_adult
update homework_kids set test_prep_days = 2 where kid_id = test.person('Taylor');
:as_owner
select test.is((select test_prep_days from homework_kids where kid_id = test.person('Taylor')), 0, 'Sam (not a parent) can''t set it ...');
select test.is(pg_temp.plan('Fractions Test'), '-', '... so nothing is planned');
update homework_kids set active = false, test_prep_days = 2 where kid_id = test.person('Taylor');
select test.is(pg_temp.plan('Fractions Test'), '-', 'with his homework off nothing is planned, even when the days are set');
update homework_kids set active = true where kid_id = test.person('Taylor');
select test.is(private.test_prep(test.person('Taylor')), 1, 'homework on again: the next run plans it');
select test.is(pg_temp.plan('Fractions Test'),
               'start 11-10 10 List what the test covers | step 11-10 10 Make a study list | step 11-10 10 Practice the first half of the topics'
               || ' | milestone 11-11 10 Practice the second half | check 11-11 10 Quiz yourself | turn_in 11-12 5 Pack what you need',
               '... over the 2 days before it');
