-- What to do, Test and Check the portal (migration 0032, docs/v1.3-homework.md §32): assignments.what and is_test are
-- generated from each assignment's text and title; homework_kids.portal_classes holds the classes a parent ticked; his
-- homework view and Due tomorrow's due_list carry what, test and portal on each assignment where they apply.
-- The household is fixtures.sql's (all made up): Alex (admin), Sam (adult), Taylor (the kid with homework). The
-- classes and texts are made up too.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-15 15:00 America/New_York';   -- a Sunday
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- The schema, the columns and the grants
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 37, 'hub_schema_version is 37');
select test.is((select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attgenerated::text, ', ' order by a.attname)
                from pg_attribute a where a.attrelid = 'public.assignments'::regclass and a.attname in ('what', 'is_test')),
               'is_test boolean s, what text s', 'assignments.what (text) and is_test (boolean): generated, stored');
select test.is((select format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull || ' ' || pg_get_expr(d.adbin, d.adrelid)
                from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                where a.attrelid = 'public.homework_kids'::regclass and a.attname = 'portal_classes'),
               'text[] true ''{}''::text[]', 'homework_kids.portal_classes: text[], not null, {} (nothing ticked)');
select test.ok(has_column_privilege('authenticated', 'public.homework_kids', 'portal_classes', 'update')
               and not has_column_privilege('authenticated', 'public.assignments', 'what', 'update')
               and not has_column_privilege('anon', 'public.homework_kids', 'portal_classes', 'select'),
               'grants: signed-in users may update portal_classes (the policy decides who); what is never written; anon nothing');
select test.ok(not has_function_privilege('anon', 'private.assignment_what(text)', 'execute')
               and not has_function_privilege('authenticated', 'private.portal_class(uuid, text)', 'execute')
               and has_function_privilege('service_role', 'public.due_list(date, text)', 'execute')
               and not has_function_privilege('authenticated', 'public.due_list(date, text)', 'execute'),
               'functions: the text checks for signed-in writers only, portal_class for definers and the job, due_list service_role only');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%')
                from pg_proc p where p.proname in ('assignment_what', 'assignment_is_test', 'portal_classes_ok', 'portal_class', 'homework_view_kid', 'due_list')),
               '... each with set search_path');

-- ---------------------------------------------------------------------
-- What to do
-- ---------------------------------------------------------------------
select test.is(private.assignment_what('This practice will help you get ready for the unit exam. Please read the instructions. What to turn in: Print the story PDF from the class page. Underline the verbs as Part I says. Bring it on Monday.'),
               'Print the story PDF from the class page. Underline the verbs as Part I says.',
               'what: the words after "What to turn in:", the short first sentence with the next one');
select test.is(private.assignment_what('Part 1: Listening - Summative GRADE Listen to the audio clips about chapters 1 to 6. Answer the questions.'),
               'Part 1: Listening - Summative GRADE Listen to the audio clips about chapters 1 to 6.', '... no "What to turn in": the first sentence');
select test.is(private.assignment_what(E'Read pages 4 to 9.\n\nAnswer questions 1 to 3 in full sentences.'), 'Read pages 4 to 9. Answer questions 1 to 3 in full sentences.',
               '... line breaks are spaces');
select test.is(private.assignment_what('what to SUBMIT:   the poster'), 'the poster', '... "What to submit:", any case');
select test.is(char_length(private.assignment_what(repeat('word ', 80))), 200, '... at most 200 characters, cut at a word, with …');
select test.ok(private.assignment_what(repeat('word ', 80)) like '%word…', '... ending in …');
select test.ok(private.assignment_what(null) is null and private.assignment_what('   ') is null, '... nothing with no text');

-- ---------------------------------------------------------------------
-- Test
-- ---------------------------------------------------------------------
select test.ok(private.assignment_is_test('Unit 3 test', null) and private.assignment_is_test('Vocabulary quiz', null)
               and private.assignment_is_test('Examen del capítulo 2', null) and private.assignment_is_test('Prueba de verbos', null),
               'test: a title with test, quiz, examen or prueba');
select test.ok(private.assignment_is_test('Listening, chapters 1 to 6', 'Part 1: Listening - Summative GRADE Listen to the audio clips.')
               and private.assignment_is_test('Grammar, chapters 1 to 6', 'Part 3: Grammar - Formative GRADE Use the verbs.'),
               '... a text that opens with "summative grade" or "formative grade" (an exam''s part)');
select test.ok(not private.assignment_is_test('Study for the novel', 'This practice assignment will help prepare you for your upcoming summative exam. What to turn in: the PDF.'),
               '... not practice for one ("Study for …", "prepare you for …")');
select test.ok(not private.assignment_is_test('Vocabulary practice', 'Please complete the Quiz on the class website. You can retake it.')
               and not private.assignment_is_test('Contest poster', null) and not private.assignment_is_test(null, null),
               '... not a quiz the text only mentions, nor "contest", nor nothing');

-- ---------------------------------------------------------------------
-- The columns, and Check the portal
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
insert into assignments (id, kid_id, kind, title, subject, due_date, details, status, added_by) values
  ('c0000000-0000-4000-8000-0000000000a1', test.person('Taylor'), 'assignment', 'Study for the novel', 'Spanish 6', '2026-11-16',
   'This practice assignment will help prepare you for your upcoming summative exam. What to turn in: Print the story PDF from the class page. Underline the verbs as Part I says.', 'open', 'family'),
  ('c0000000-0000-4000-8000-0000000000a2', test.person('Taylor'), 'assignment', 'Listening, chapters 1 to 6', 'Spanish 6', '2026-11-16',
   'Part 1: Listening - Summative GRADE Listen to the audio clips about chapters 1 to 6. Answer the questions.', 'open', 'family'),
  ('c0000000-0000-4000-8000-0000000000a3', test.person('Taylor'), 'assignment', 'Volcano poster', 'Science', '2026-11-16', null, 'open', 'family');
select test.is((select what || ' | ' || is_test from assignments where id = 'c0000000-0000-4000-8000-0000000000a1'),
               'Print the story PDF from the class page. Underline the verbs as Part I says. | false', 'an assignment''s what and is_test, from its text');
:as_admin
select test.is(pg_temp.run($$update assignments set details = 'What to do: Bring the printed PDF.' where id = 'c0000000-0000-4000-8000-0000000000a1'$$), 'ok',
               'a parent changes its text ...');
select test.is((select what from assignments where id = 'c0000000-0000-4000-8000-0000000000a1'), 'Bring the printed PDF.', '... and its what follows');
select test.is(pg_temp.run($$update assignments set what = 'x' where id = 'c0000000-0000-4000-8000-0000000000a1'$$), '428C9 column "what" can only be updated to DEFAULT',
               '... what is never written');
update assignments set details = 'This practice assignment will help prepare you for your upcoming summative exam. What to turn in: Print the story PDF from the class page. Underline the verbs as Part I says.'
  where id = 'c0000000-0000-4000-8000-0000000000a1';
select test.is(pg_temp.run($$update homework_kids set portal_classes = '{" spanish 6 "}' where kid_id = test.person('Taylor')$$), 'ok', 'Alex ticks Spanish 6 (Check the portal)');
:as_adult
select test.is(pg_temp.run($$update homework_kids set portal_classes = '{Science}' where kid_id = test.person('Taylor')$$), 'ok', 'Sam (an adult) ...');
:as_owner
select test.is((select portal_classes::text from homework_kids where kid_id = test.person('Taylor')), '{" spanish 6 "}', '... changes nothing (RLS: parents only)');
:as_admin
select test.ok(pg_temp.run(format($$update homework_kids set portal_classes = %L where kid_id = test.person('Taylor')$$, (select array_agg('Class ' || n) from generate_series(1, 21) n)::text)) like '23514%',
               'more than 20 classes: refused');
select test.ok(pg_temp.run(format($$update homework_kids set portal_classes = %L where kid_id = test.person('Taylor')$$, array[repeat('x', 41)]::text)) like '23514%',
               'a class over 40 characters: refused');
select test.ok(pg_temp.run($$update homework_kids set portal_classes = array[null::text] where kid_id = test.person('Taylor')$$) like '23514%', 'a null class: refused');
:as_owner
select test.ok(private.portal_class(test.person('Taylor'), 'Spanish 6') and private.portal_class(test.person('Taylor'), 'SPANISH 6 ')
               and not private.portal_class(test.person('Taylor'), 'Spanish') and not private.portal_class(test.person('Taylor'), null),
               'portal_class: the same words, any case, spaces at the ends ignored; not another class or none');

-- ---------------------------------------------------------------------
-- His view and the email
-- ---------------------------------------------------------------------
:as_anon
select homework_by_token(test.token('Taylor')) as v \gset
select test.is((select x - 'id' - 'kind' - 'state' - 'steps' - 'behind' - 'status' - 'ai_help' - 'horizon' - 'no_time' - 'stretch' - 'added_by' - 'due_date' - 'given_by'
                       - 'plan_rev' - 'time_left' - 'minutes_left' - 'next_milestone' - 'subject'
                from jsonb_array_elements(:'v'::jsonb -> 'assignments') x where x ->> 'id' = 'c0000000-0000-4000-8000-0000000000a1'),
               '{"what": "Print the story PDF from the class page. Underline the verbs as Part I says.", "title": "Study for the novel", "portal": true}'::jsonb,
               'his view: the study assignment with its what and portal (not a test)');
select test.is((select (x ->> 'test') || ' ' || (x ->> 'portal') from jsonb_array_elements(:'v'::jsonb -> 'assignments') x where x ->> 'id' = 'c0000000-0000-4000-8000-0000000000a2'),
               'true true', '... the listening part: a test, and check the portal');
select test.is((select string_agg(k, ',' order by k) from jsonb_array_elements(:'v'::jsonb -> 'assignments') x, jsonb_object_keys(x) k
                where x ->> 'id' = 'c0000000-0000-4000-8000-0000000000a3' and k in ('what', 'test', 'portal')), null,
               '... the poster (no text, not a test, another class): none of the three keys');
select test.ok(strpos(:'v', 'This practice assignment') = 0, '... never the rest of the text');
:as_service
select test.is((select x ->> 'what' || ' | ' || coalesce(x ->> 'test', '-') || ' | ' || coalesce(x ->> 'portal', '-')
                from jsonb_array_elements(due_list('2026-11-15', 'en') -> 'kids' -> 0 -> 'tomorrow') x where x ->> 'title' = 'Study for the novel'),
               'Print the story PDF from the class page. Underline the verbs as Part I says. | - | true', 'due_list: tomorrow''s study assignment with its what and portal');
select test.is((select x ->> 'test' from jsonb_array_elements(due_list('2026-11-15', 'en') -> 'kids' -> 0 -> 'tomorrow') x where x ->> 'title' = 'Listening, chapters 1 to 6'),
               'true', '... the listening part a test');
select test.is((select x - 'due' - 'due_label' from jsonb_array_elements(due_list('2026-11-15', 'en') -> 'kids' -> 0 -> 'tomorrow') x where x ->> 'title' = 'Volcano poster'),
               '{"title": "Volcano poster", "subject": "Science"}'::jsonb, '... the poster exactly as 0029 gave it');
-- With nothing ticked and no text, both answer as 0031 left them.
:as_owner
update homework_kids set portal_classes = '{}' where kid_id = test.person('Taylor');
update assignments set details = null where kid_id = test.person('Taylor');
update assignments set title = 'Listening, chapters 1 to 6 (part 1)' where id = 'c0000000-0000-4000-8000-0000000000a2';
:as_service
select test.is(due_list('2026-11-15', 'en'), private.due_list_v31('2026-11-15', 'en'), 'no text, no test word, nothing ticked: due_list is exactly 0029''s');
:as_owner
select test.is(private.homework_view_kid(test.person('Taylor'), 'en') - 'server_now', private.homework_view_kid_v31(test.person('Taylor'), 'en') - 'server_now',
               '... and his view exactly 0031''s');
