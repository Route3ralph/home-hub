-- Missing and Graded (migration 0023, docs/v1.3-homework.md §26): a parent or the coach marks an assignment as the
-- school's portal says it is, "missing" or "graded" with an optional grade (1 to 20 characters, one line). The columns
-- are public.assignments.school_mark and grade; who changes them is the table's own policies (private.is_coach(): a
-- parent, or an adult whose coach box is ticked). Nothing else shows them: not a kid's My day or homework, not the
-- tutor link. Grants, the checks, and that nothing else changes.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (a kid), Jordan (removed). Everything is made up.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-06 18:00 America/New_York';
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated;
create function pg_temp.mark(p_id uuid) returns text language sql stable security definer as $$
  select coalesce(school_mark, '-') || ' ' || coalesce(grade, '-') from public.assignments where id = p_id
$$;
grant execute on function pg_temp.mark(uuid) to anon, authenticated;
create function pg_temp.ltok(p_label text) returns text language sql stable security definer as $$
  select token from public.tutor_links where label = p_label
$$;
grant execute on function pg_temp.ltok(text) to anon, authenticated;

:as_admin
select save_homework_kid(test.person('Taylor'), true);
select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true);
:as_owner
insert into assignments (id, kid_id, kind, title, subject, due_date, status) values
  ('a0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'assignment', 'Volcano poster', 'Science', '2026-11-10', 'open'),
  ('a0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'assignment', 'Verbs worksheet', 'Spanish', '2026-11-05', 'open');

-- ---------------------------------------------------------------------
-- The schema and its grants
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 27, 'hub_schema_version is 27');
select test.is((select string_agg(column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '-'), ', ' order by column_name)
                from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name in ('school_mark', 'grade')),
               'grade text YES -, school_mark text YES -', 'assignments.school_mark and grade: text, null by default');
select test.is((select string_agg(pg_temp.mark(id), ', ' order by id) from assignments), '- -, - -', 'every assignment unmarked at first');
select test.ok(has_column_privilege('authenticated', 'public.assignments', 'school_mark', 'update') and has_column_privilege('authenticated', 'public.assignments', 'grade', 'update')
               and not has_column_privilege('anon', 'public.assignments', 'school_mark', 'select') and not has_column_privilege('anon', 'public.assignments', 'grade', 'update'),
               'grants: authenticated may update the two (the policies decide who); anon nothing');
select test.is((select count(*)::int from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                and (p.prosrc ~ '\mschool_mark\M' or p.prosrc ~ '\mgrade\M')), 0, 'no function reads them (not My day, the tutor link, the board, Google or an email)');

-- ---------------------------------------------------------------------
-- A parent marks
-- ---------------------------------------------------------------------
:as_admin
select test.is(pg_temp.run($$update assignments set school_mark = 'missing' where id = 'a0000000-0000-4000-8000-000000000002'$$), 'ok', 'Alex marks one missing');
select test.is(pg_temp.mark('a0000000-0000-4000-8000-000000000002'), 'missing -', '... missing, with no grade');
select test.is(pg_temp.run($$update assignments set school_mark = 'graded', grade = 'B+' where id = 'a0000000-0000-4000-8000-000000000002'$$), 'ok', 'then graded B+');
select test.is(pg_temp.mark('a0000000-0000-4000-8000-000000000002'), 'graded B+', '... graded B+');
select test.is(pg_temp.run($$update assignments set school_mark = 'graded', grade = null where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ok', 'graded with no grade');
select test.is(pg_temp.run($$update assignments set school_mark = null, grade = null where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ok', 'and cleared');
select test.is(pg_temp.mark('a0000000-0000-4000-8000-000000000001'), '- -', '... unmarked');

-- The checks.
select test.is(pg_temp.run($$update assignments set school_mark = 'late' where id = 'a0000000-0000-4000-8000-000000000001'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_school_mark_check"', 'a mark that isn''t missing or graded: refused');
select test.is(pg_temp.run($$update assignments set school_mark = 'missing', grade = 'A' where id = 'a0000000-0000-4000-8000-000000000001'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_grade_graded"', 'a grade on a missing one: refused');
select test.is(pg_temp.run($$update assignments set grade = 'A' where id = 'a0000000-0000-4000-8000-000000000001'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_grade_graded"', 'a grade with no mark: refused');
select test.is(pg_temp.run($$update assignments set school_mark = 'graded', grade = repeat('9', 21) where id = 'a0000000-0000-4000-8000-000000000001'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_grade_check"', 'a grade over 20 characters: refused');
select test.is(pg_temp.run($$update assignments set school_mark = 'graded', grade = repeat('9', 20) where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ok', '... 20 is fine');
select test.is(pg_temp.run($$update assignments set school_mark = 'graded', grade = '' where id = 'a0000000-0000-4000-8000-000000000001'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_grade_check"', 'an empty grade: refused (null means none)');
select test.is(pg_temp.run($$update assignments set school_mark = 'graded', grade = ' 92' where id = 'a0000000-0000-4000-8000-000000000001'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_grade_check"', 'a grade with spaces round it: refused');
select test.is(pg_temp.run($$update assignments set school_mark = 'graded', grade = E'9\n2' where id = 'a0000000-0000-4000-8000-000000000001'$$),
               '23514 new row for relation "assignments" violates check constraint "assignments_grade_check"', 'a grade on two lines: refused');
select test.is(pg_temp.run($$update assignments set school_mark = null, grade = null where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ok', 'cleared again');

-- ---------------------------------------------------------------------
-- Who else: the coach can, an adult who isn't, a removed parent, a stranger and anon can't
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.run($$update assignments set school_mark = 'missing' where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ok', 'Sam, not the coach: the update runs...');
select test.is(pg_temp.mark('a0000000-0000-4000-8000-000000000001'), '- -', '... and changes nothing (the table''s policies)');
:as_admin
select set_coach(test.person('Sam'), true);
:as_adult
select test.is(pg_temp.run($$update assignments set school_mark = 'missing' where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ok', 'Sam, the coach, marks one missing');
select test.is(pg_temp.mark('a0000000-0000-4000-8000-000000000001'), 'missing -', '... it is');
select test.is((select school_mark from assignments where id = 'a0000000-0000-4000-8000-000000000001'), 'missing', '... and he reads it back');
:as_removed
select test.is(pg_temp.run($$update assignments set school_mark = null where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ok', 'a removed parent: the update runs...');
:as_stranger
select test.is(pg_temp.run($$update assignments set school_mark = null where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ok', 'a stranger: the update runs...');
:as_anon
select test.is(pg_temp.run($$update assignments set school_mark = null where id = 'a0000000-0000-4000-8000-000000000001'$$), '42501 permission denied for table assignments', 'anon: refused');
:as_owner
select test.is(pg_temp.mark('a0000000-0000-4000-8000-000000000001'), 'missing -', '... none of the three changed it');

-- ---------------------------------------------------------------------
-- Nothing else shows them: his homework on My day, his day, the tutor link
-- ---------------------------------------------------------------------
:as_anon
select test.ok(homework_by_token(test.token('Taylor')) is not null, 'Taylor''s homework on My day answers');
select test.ok(homework_by_token(test.token('Taylor'))::text !~ '\mschool_mark\M' and homework_by_token(test.token('Taylor'))::text not like '%B+%'
               and homework_by_token(test.token('Taylor'))::text not like '%"grade"%',
               '... and says nothing of Missing or Graded');
select test.ok(get_person_day(test.token('Taylor'))::text !~ '\mschool_mark\M' and get_person_day(test.token('Taylor'))::text not like '%B+%', 'nor does his day');
select test.ok(tutor_view_by_token(pg_temp.ltok('Pat Lee, tutor')) is not null, 'the tutor link answers');
select test.ok(tutor_view_by_token(pg_temp.ltok('Pat Lee, tutor'))::text !~ '\mschool_mark\M' and tutor_view_by_token(pg_temp.ltok('Pat Lee, tutor'))::text not like '%B+%'
               and tutor_view_by_token(pg_temp.ltok('Pat Lee, tutor'), 'a0000000-0000-4000-8000-000000000002')::text not like '%B+%',
               '... and says nothing of them, for the list or the assignment');

-- Marking changes nothing else on the row.
:as_owner
select test.is((select title || ' · ' || status || ' · ' || due_date from assignments where id = 'a0000000-0000-4000-8000-000000000002'), 'Verbs worksheet · open · 2026-11-05',
               'a marked assignment keeps its title, status and due date');

