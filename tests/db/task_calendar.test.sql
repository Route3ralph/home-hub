-- Tasks on the calendar (migration 0027, docs/v2-design.md §33): public.tasks.on_calendar, false by default, which the
-- Calendar page reads to show a task only when it is ticked. Members change it as the rest of a task (the table's
-- policy); anon and a stranger can't. Nothing else reads it: agenda, My day and the emails show every task as before.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (a kid), Morgan (a helper), Jordan (removed).
-- Everything is made up.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-13 09:00 America/New_York';
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated;
create function pg_temp.oncal(p_title text) returns text language sql stable security definer as $$
  select coalesce(string_agg(on_calendar::text, ','), '-') from public.tasks where title = p_title
$$;
grant execute on function pg_temp.oncal(text) to anon, authenticated;

select test.is(hub_schema_version(), 28, 'hub_schema_version is 28');
select test.is((select data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '-') from information_schema.columns
                where table_schema = 'public' and table_name = 'tasks' and column_name = 'on_calendar'),
               'boolean NO false', 'tasks.on_calendar: boolean, not null, false by default');
select test.ok(has_column_privilege('authenticated', 'public.tasks', 'on_calendar', 'insert') and has_column_privilege('authenticated', 'public.tasks', 'on_calendar', 'update'),
               'grants: signed-in users may insert and update it, as every column of tasks (the policy decides who)');

-- A member adds a task: off the Calendar unless asked.
:as_admin
select test.is(pg_temp.run($$insert into tasks (title, due_date) values ('Call the plumber', '2026-11-20')$$), 'ok', 'Alex adds a task without saying');
select test.is(pg_temp.oncal('Call the plumber'), 'false', '... it is off the Calendar');
select test.is(pg_temp.run($$insert into tasks (title, due_date, on_calendar) values ('Dentist forms', '2026-11-18', true)$$), 'ok', 'Alex adds one with Show on the calendar ticked');
select test.is(pg_temp.oncal('Dentist forms'), 'true', '... it is on');
select test.is(pg_temp.run($$update tasks set on_calendar = true where title = 'Call the plumber'$$), 'ok', 'Alex ticks the first one');
select test.is(pg_temp.oncal('Call the plumber'), 'true', '... on now');
:as_adult
select test.is(pg_temp.run($$update tasks set on_calendar = false where title = 'Call the plumber'$$), 'ok', 'Sam (a member) unticks it');
select test.is(pg_temp.oncal('Call the plumber'), 'false', '... off again');
select test.is(pg_temp.run($$update tasks set on_calendar = null where title = 'Call the plumber'$$),
               '23502 null value in column "on_calendar" of relation "tasks" violates not-null constraint', 'null: refused (false means off)');
:as_stranger
select test.is(pg_temp.run($$update tasks set on_calendar = true where title = 'Call the plumber'$$), 'ok', 'a stranger''s update runs ...');
:as_anon
select test.is(pg_temp.run($$update tasks set on_calendar = true where title = 'Call the plumber'$$), 'ok', 'anon''s too (row-level security: no rows) ...');
select test.is(pg_temp.oncal('Call the plumber'), 'false', '... and neither changed it');

-- Nothing else reads it: agenda still has both tasks, ticked or not.
:as_admin
select test.is((select string_agg(title, ', ' order by title) from agenda('2026-11-16', '2026-11-22') a where a.kind = 'task'
                and title in ('Call the plumber', 'Dentist forms')),
               'Call the plumber, Dentist forms', 'agenda (My day, Today and the emails read it) still has every task, on the Calendar or not');
:as_owner
select test.is((select count(*)::int from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                and p.prosrc ~ '\mon_calendar\M' and p.prosrc ~ '\mtasks\M' and p.prosrc !~ 'p\.on_calendar'), 0,
               'no function reads tasks.on_calendar (only the Calendar page does)');
