-- Due tomorrow (migration 0029, docs/v1.3-homework.md §29): every evening at household.due_at (null: off) the people on
-- household.due_to get one email of each homework kid's lists. household's two columns are checked by a trigger;
-- admins change them, nobody else. public.due_list(p_day, p_lang) is the lists for the evening of p_day: due tomorrow
-- (ticked when done), still open from today or before (and Missing), and due in the 3 days after tomorrow.
-- public.due_due(p_limit) is who gets it now: every evening from due_at, everyone on due_to who is active with a
-- confirmed address, once an evening, while a kid has homework on. Both for service_role only.
-- The household is fixtures.sql's (all made up): Alex (admin), Sam (adult), Taylor (a kid), Morgan (a helper, Spanish).
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-13 17:00 America/New_York';   -- a Friday
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated, service_role;
-- A list as "title [subject] due_label ✓ missing n/goal", joined by " | ".
create function pg_temp.list(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(concat_ws(' ', x ->> 'title', '[' || (x ->> 'subject') || ']', x ->> 'due_label',
                                       case when (x ->> 'done')::boolean then '✓' end,
                                       case when (x ->> 'missing')::boolean then 'missing' end,
                                       (x -> 'count' ->> 'done') || '/' || (x -> 'count' ->> 'goal')), ' | ' order by n), '')
  from jsonb_array_elements(j) with ordinality t (x, n)
$$;
grant execute on function pg_temp.list(jsonb) to service_role;
create function pg_temp.due() returns text language sql volatile as $$
  select coalesce(string_agg((select name from public.people where id = d.person_id) || ' ' || d.kind || ' ' || d.local_date, ', '
                             order by d.person_id), '')
  from public.due_due(50) d
$$;
grant execute on function pg_temp.due() to service_role;

-- ---------------------------------------------------------------------
-- The columns, the check, the functions and their grants
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 29, 'hub_schema_version is 29');
select test.is((select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || (not a.attnotnull)::text
                                  || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' order by a.attname)
                from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                where a.attrelid = 'public.household'::regclass and a.attname like 'due%' and not a.attisdropped),
               'due_at:time without time zone:true:-,due_to:uuid[]:false:''{}''::uuid[]',
               'household: due_at (nullable, off) and due_to {} by default');
select test.is((select due_at is null and due_to = '{}' from household), true, 'off on a database that had it before');
select test.ok((select bool_and(p.proconfig @> '{"search_path=\"\""}') from pg_proc p
                where p.oid in ('private.household_due_check()'::regprocedure, 'public.due_list(date, text)'::regprocedure,
                                'public.due_due(int)'::regprocedure)),
               'search_path is set on every new function');
select test.is((select string_agg(r || ':' || has_function_privilege(r, f, 'execute'), ',' order by f, r)
                from unnest(array['public.due_list(date, text)', 'public.due_due(int)']) f,
                     unnest(array['anon', 'authenticated', 'service_role']) r),
               'anon:false,authenticated:false,service_role:true,anon:false,authenticated:false,service_role:true',
               'due_list and due_due: service_role only');
select test.ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'notification_log_kind_check')) like '%''due''%',
               'notification_log may hold a ''due'' row');

-- Admins change the settings; a member's update changes nothing (RLS), anon can't.
:as_admin
select test.is(pg_temp.run($$update public.household set due_at = '17:30', due_to = array[test.person('Alex')]$$), 'ok', 'an admin turns it on');
:as_adult
select test.is(pg_temp.run($$update public.household set due_at = '08:00'$$), 'ok', 'a member''s update runs ...');
:as_owner
select test.is((select due_at::text from household), '17:30:00', '... and changes nothing (row-level security)');
:as_anon
select pg_temp.run($$update public.household set due_at = '08:00'$$);
:as_owner
select test.is((select due_at::text from household), '17:30:00', 'anon changes nothing either');

-- The check.
:as_admin
select test.is(pg_temp.run($$update public.household set due_to = array[test.person('Alex'), test.person('Alex')]$$),
               '22023 Due tomorrow: someone is on the list twice.', 'nobody twice');
select test.is(pg_temp.run($$update public.household set due_to = array['00000000-0000-4000-8000-000000000999'::uuid]$$),
               '22023 Due tomorrow: it can go only to people on the family list.', 'only people on the family list');
select test.is(pg_temp.run($$update public.household set due_to = array[null::uuid]$$),
               '22023 Due tomorrow: it can go only to people on the family list.', '... never a null');
select test.is(pg_temp.run($$update public.household set due_to = (select array_agg(id) from (select id from people union all select gen_random_uuid() from generate_series(1, 6)) x)$$),
               '22023 Due tomorrow: send it to at most 6 people.', 'at most 6 people');

-- ---------------------------------------------------------------------
-- The lists
-- ---------------------------------------------------------------------
select save_homework_kid(test.person('Taylor'), true);
:as_owner
insert into assignments (id, kid_id, kind, title, subject, due_date, status, school_mark, count_goal, count_done) values
  ('d0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'assignment', 'Volcano poster', 'Science', '2026-11-14', 'open', null, null, 0),
  ('d0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'assignment', 'Verbs worksheet', 'Spanish', '2026-11-14', 'done', null, null, 0),
  ('d0000000-0000-4000-8000-000000000003', test.person('Taylor'), 'assignment', 'Spelling list', 'English', '2026-11-14', 'dropped', null, null, 0),
  ('d0000000-0000-4000-8000-000000000004', test.person('Taylor'), 'assignment', 'Map quiz', 'History', '2026-11-13', 'open', null, null, 0),
  ('d0000000-0000-4000-8000-000000000005', test.person('Taylor'), 'assignment', 'Lab report', 'Science', '2026-11-05', 'open', 'missing', null, 0),
  ('d0000000-0000-4000-8000-000000000006', test.person('Taylor'), 'assignment', 'Old essay', 'English', '2026-10-01', 'open', null, null, 0),
  ('d0000000-0000-4000-8000-000000000007', test.person('Taylor'), 'assignment', 'Book report', 'English', '2026-09-20', 'open', 'missing', null, 0),
  ('d0000000-0000-4000-8000-000000000008', test.person('Taylor'), 'assignment', 'Math topics', 'Math', '2026-11-16', 'open', null, 7, 5),
  ('d0000000-0000-4000-8000-000000000009', test.person('Taylor'), 'lesson', 'Fractions practice', null, '2026-11-17', 'open', null, null, 0),
  ('d0000000-0000-4000-8000-000000000010', test.person('Taylor'), 'assignment', 'Science test', 'Science', '2026-11-18', 'open', null, null, 0),
  ('d0000000-0000-4000-8000-000000000011', test.person('Taylor'), 'assignment', 'Next week''s essay', 'English', '2026-11-20', 'open', null, null, 0),
  ('d0000000-0000-4000-8000-000000000012', test.person('Taylor'), 'assignment', 'Done early', 'Math', '2026-11-16', 'done', null, null, 0),
  ('d0000000-0000-4000-8000-000000000013', test.person('Taylor'), 'assignment', 'Handed in, missing', 'Math', '2026-11-10', 'done', 'missing', null, 0);
:as_service
select test.is((select pg_temp.list(k -> 'tomorrow') from jsonb_array_elements(due_list('2026-11-13') -> 'kids') k),
               'Verbs worksheet [Spanish] Sat Nov 14 ✓ | Volcano poster [Science] Sat Nov 14',
               'tomorrow: due Sat Nov 14, open or done (ticked), never dropped');
select test.is((select pg_temp.list(k -> 'late') from jsonb_array_elements(due_list('2026-11-13') -> 'kids') k),
               'Book report [English] Sun Sep 20 missing | Lab report [Science] Thu Nov 5 missing | Map quiz [History] Fri Nov 13',
               'late: open and due today or up to 30 days before (not the essay due Oct 1), and open and Missing whenever (never done, even when Missing)');
select test.is((select pg_temp.list(k -> 'coming') from jsonb_array_elements(due_list('2026-11-13') -> 'kids') k),
               'Math topics [Math] Mon Nov 16 5/7 | Fractions practice Tue Nov 17',
               'coming: open and due in the 3 days after tomorrow (Sun to Tue, so Monday''s shows on Friday): a lesson too, the count, no subject when none');
select test.is((select d ->> 'tomorrow' || ' ' || (d ->> 'tomorrow_label') || ' ' || (d ->> 'coming_to_label') || ' ' || jsonb_array_length(d -> 'kids')
                || ' ' || (d -> 'kids' -> 0 ->> 'name') from due_list('2026-11-13') d),
               '2026-11-14 Sat Nov 14 Tue Nov 17 1 Taylor', 'the days, and one list per homework kid');
select test.is((select d -> 'kids' -> 0 -> 'tomorrow' -> 0 ->> 'title' || ' ' || (d ->> 'tomorrow_label') from due_list('2026-11-13', 'es') d),
               'Verbs worksheet sáb 14 nov', 'in Spanish: the days are Spanish, the titles as written');
select test.ok((select not (d -> 'kids' -> 0 -> 'tomorrow' -> 1 ?| array['details', 'grade', 'plan', 'steps', 'points']) from due_list('2026-11-13') d),
               'an item never carries its text, grade, plan, steps or points');
select test.is((select pg_temp.list(k -> 'tomorrow') || ' / ' || pg_temp.list(k -> 'coming') from jsonb_array_elements(due_list('2026-11-15') -> 'kids') k),
               'Done early [Math] Mon Nov 16 ✓ | Math topics [Math] Mon Nov 16 5/7 / Fractions practice Tue Nov 17 | Science test [Science] Wed Nov 18',
               'Sunday evening: Monday''s, then Tue to Thu (not Friday''s essay)');
-- Homework off for a kid: no list.
:as_admin
select save_homework_kid(test.person('Taylor'), false);
:as_service
select test.is((select jsonb_array_length(due_list('2026-11-13') -> 'kids')), 0, 'a kid with homework off has no list');
:as_admin
select save_homework_kid(test.person('Taylor'), true);

-- ---------------------------------------------------------------------
-- Who gets it, and when
-- ---------------------------------------------------------------------
:as_owner
update people set email_verified_at = now() where name in ('Alex', 'Sam');
update people set email_verified_at = null where name = 'Morgan';
update household set due_at = '17:30', due_to = array[test.person('Alex'), test.person('Sam'), test.person('Morgan')];
:as_service
select test.is(pg_temp.due(), '', '17:00: not yet (it goes at 17:30)');
:as_owner
set hub.now = '2026-11-13 17:30 America/New_York';
:as_service
select test.is((select string_agg(x, ', ' order by x) from unnest(string_to_array(pg_temp.due(), ', ')) x),
               'Alex due 2026-11-13, Sam due 2026-11-13', '17:30: Alex and Sam, for today; not Morgan (her address isn''t confirmed)');
select test.is(pg_temp.run($$select claim_notification(test.person('Alex'), '2026-11-13', 'due')$$), 'ok', 'Alex''s is claimed');
:as_owner
update notification_log set status = 'sent' where kind = 'due' and person_id = test.person('Alex');
:as_service
select test.is(pg_temp.due(), 'Sam due 2026-11-13', '... and once sent, only Sam''s is left: once an evening');
select test.is((select count(*) from due_due(0)), 0::bigint, 'due_due honours its limit');
:as_owner
set hub.now = '2026-11-14 17:45 America/New_York';
:as_service
select test.is((select string_agg(x, ', ' order by x) from unnest(string_to_array(pg_temp.due(), ', ')) x),
               'Alex due 2026-11-14, Sam due 2026-11-14', 'the next evening (a Saturday): again, every day');
-- Not while nobody has homework on, not when off, not for someone who left.
:as_admin
select save_homework_kid(test.person('Taylor'), false);
:as_service
select test.is(pg_temp.due(), '', 'no kid with homework on: nobody gets it');
:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
update people set active = false where name = 'Sam';
:as_service
select test.is(pg_temp.due(), 'Alex due 2026-11-14', 'someone no longer on the family list is skipped');
:as_owner
update household set due_at = null;
:as_service
select test.is(pg_temp.due(), '', 'off (due_at null): nobody');
select test.ok(pg_temp.run($$select due_due(5)$$) = 'ok', 'service_role may ask');
:as_admin
select test.ok(pg_temp.run($$select due_list('2026-11-13')$$) like '42501%' and pg_temp.run($$select due_due(5)$$) like '42501%', 'a parent can''t call either');
