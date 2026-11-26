-- The school's missing-assignment emails (migration 0037, docs/v1.3-homework.md §37): hub-jobs reads a forwarded notice
-- and calls school_missing_by_email(title, class, due, by), which finds the assignment (his own, then an item from
-- school not made one yet, else, with one kid, his homework now) and marks it Missing, so 0036's points follow, written
-- as the forwarder. service_role only.
-- The household is fixtures.sql's: Alex (admin), Taylor (a kid). Everything is made up.
-- hub.now is Wed Nov 4, 2026 (America/New_York).
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
grant execute on function pg_temp.run(text) to anon, authenticated, service_role;
create function pg_temp.got(r jsonb) returns text language sql immutable as $$
  select (r ->> 'status') || ' ' || coalesce(r ->> 'kid', '-') || ' ' || coalesce(r ->> 'title', '-') || ' ' || coalesce(r ->> 'subject', '-')
         || ' ' || coalesce(r ->> 'due', '-') || ' ' || coalesce(r ->> 'points', '-')
$$;
grant execute on function pg_temp.got(jsonb) to service_role;

select test.is(hub_schema_version(), 40, 'hub_schema_version is 40');
select test.is((select string_agg(r || ':' || has_function_privilege(r, 'public.school_missing_by_email(text, text, date, text)', 'execute'), ',' order by r)
                from unnest(array['anon', 'authenticated', 'service_role']) r),
               'anon:false,authenticated:false,service_role:true', 'school_missing_by_email: service_role only');
select test.is((select array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'public.school_missing_by_email(text, text, date, text)'::regprocedure),
               'search_path=""', '... with an empty search_path');

:as_service
select test.is(pg_temp.got(school_missing_by_email('Lab report', 'Science 6 - A', '2026-11-03', 'Alex (email)')), 'no_kid - - - - -',
               'no kid with homework on: no_kid, nothing added');

:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
insert into points_ledger (kid_id, at, day, kind, delta, note, who) values
  (test.person('Taylor'), '2026-11-02 21:00+00', '2026-11-02', 'given', 100, 'Starting points', 'alex@example.com');
insert into assignments (id, kid_id, kind, title, subject, due_date, status) values
  ('a0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'assignment', 'Lab report', 'Science 6', '2026-11-03', 'open'),
  ('a0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'assignment', 'Lab report', 'Science 6', '2026-10-01', 'done');
insert into school_feeds (id, kid_id, kind, host, url_end) values
  ('f0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'assignments', 'school.example', 'a1b2');
insert into school_items (feed_id, key, has_uid, title, subject, first_day, last_day, due_date, first_seen_at, last_seen_at) values
  ('f0000000-0000-4000-8000-000000000001', md5('volcano'), false, 'Volcano poster', 'Science 6', '2026-11-05', '2026-11-05', '2026-11-05', now(), now());

-- ---------------------------------------------------------------------
-- His own assignment: the class without its section, the nearest due date
-- ---------------------------------------------------------------------
:as_service
select test.is(pg_temp.got(school_missing_by_email('Lab report', 'Science 6 - A', '2026-11-03', 'Alex (email)')), 'marked Taylor Lab report Science 6 2026-11-03 -10',
               'his Lab report (Science 6 - A is Science 6; the Oct 1 one is further away): marked Missing, 10 points off');
:as_owner
select test.is((select school_mark from assignments where id = 'a0000000-0000-4000-8000-000000000001'), 'missing', '... marked Missing');
select test.is((select school_mark from assignments where id = 'a0000000-0000-4000-8000-000000000002'), null, '... the older one untouched');
select test.is((select who || ' | ' || note from points_ledger where kind = 'mark_off'), 'Alex (email) | Missing: Lab report', '... the line written as the forwarder');
:as_service
select test.is(pg_temp.got(school_missing_by_email('LAB REPORT ', 'Science 6 - A', '2026-11-03', 'Alex (email)')), 'already Taylor Lab report Science 6 2026-11-03 0',
               'the same notice again (any case, spaces): already, nothing more taken');
:as_owner
select test.is((select count(*) from points_ledger where kind = 'mark_off')::int, 1, '... one line only');

-- ---------------------------------------------------------------------
-- An item from school not added yet: made his homework, then marked
-- ---------------------------------------------------------------------
:as_service
select test.is(pg_temp.got(school_missing_by_email('Volcano poster', 'Science 6 - A', '2026-11-05', 'Alex (email)')), 'added Taylor Volcano poster Science 6 2026-11-05 -10',
               'an item from school not made one yet: made his homework (added), marked, 10 off');
:as_owner
select test.is((select made_at is not null and assignment_id is not null from school_items where title = 'Volcano poster'), true, '... the item notes it was made one');

-- ---------------------------------------------------------------------
-- Not on the hub: added as his homework, then marked
-- ---------------------------------------------------------------------
:as_service
select test.is(pg_temp.got(school_missing_by_email('Delightful Problems', 'Math 7 - B', '2026-11-02', 'Alex (email)')), 'added Taylor Delightful Problems Math 7 2026-11-02 -10',
               'not on the hub: added (Math 7, due Nov 2), marked, 10 off');
:as_owner
select test.is((select added_by || ' ' || created_by || ' ' || status from assignments where title = 'Delightful Problems'), 'school Alex (email) open',
               '... as from school, by the forwarder, open');
select test.is((select school_mark from assignments where title = 'Delightful Problems'), 'missing', '... and marked Missing');

-- ---------------------------------------------------------------------
-- Refusals and several kids
-- ---------------------------------------------------------------------
:as_service
select test.is(pg_temp.run($$select school_missing_by_email('', 'Science 6', '2026-11-03', 'Alex (email)')$$), '22023 That needs the title and the due date.', 'no title: refused');
select test.is(pg_temp.run($$select school_missing_by_email('Lab report', 'Science 6', null, 'Alex (email)')$$), '22023 That needs the title and the due date.', 'no due date: refused');
:as_admin
select pg_temp.run($$select save_homework_kid(test.person('Sam'), true)$$);
:as_owner
update people set role = 'kid' where id = test.person('Sam') and not exists (select 1 from homework_kids where kid_id = test.person('Sam'));
insert into homework_kids (kid_id) select test.person('Sam') where not exists (select 1 from homework_kids where kid_id = test.person('Sam'));
:as_service
select test.is((pg_temp.got(school_missing_by_email('Poem', 'Language Arts 6 - C', '2026-11-04', 'Alex (email)')) like 'many%'), true,
               'two kids with homework on and neither has it: many, nothing added');
:as_owner
select test.is((select count(*) from assignments where title = 'Poem')::int, 0, '... no Poem added');
