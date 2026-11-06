-- The watch list (migration 0022, docs/v2-design.md §27): movies and shows the family wants to see, on the Watch page.
-- Every member reads and changes watch_items (row-level security: private.is_member()); anon, a stranger, a removed
-- parent and a project guest see nothing. A kid's My day reads the list not yet watched (watch_by_token: titles,
-- kinds, places, the service and "mine"; never a link, a note or a name) and adds to it (watch_add_by_token: written
-- as "<his first name> (My day)", one of his 30 My day changes a day, a resent key adds nothing). Grants, cleaning,
-- limits, and that nothing else changes.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (a kid), Morgan (a helper), Jordan (removed).
-- Everything is made up.
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
create function pg_temp.tok(p_name text) returns text language sql stable security definer as $$
  select day_token from public.people where name = p_name
$$;
grant execute on function pg_temp.tok(text) to anon, authenticated;
create function pg_temp.titles(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(x ->> 'title', ' | ' order by n), '-') from jsonb_array_elements(j -> 'items') with ordinality t (x, n)
$$;
grant execute on function pg_temp.titles(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------
-- The schema, the signatures, their grants and row-level security
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 22, 'hub_schema_version is 22 (0021 made it 21, 0022 22)');
select test.ok((select c.relrowsecurity from pg_class c where c.oid = 'public.watch_items'::regclass), 'watch_items has row-level security');
select test.ok(has_function_privilege('anon', 'public.watch_by_token(text)', 'execute') and has_function_privilege('authenticated', 'public.watch_by_token(text)', 'execute')
               and not has_function_privilege('service_role', 'public.watch_by_token(text)', 'execute')
               and has_function_privilege('anon', 'public.watch_add_by_token(text, text, text, text, uuid)', 'execute')
               and not has_function_privilege('service_role', 'public.watch_add_by_token(text, text, text, text, uuid)', 'execute'),
               'watch_by_token and watch_add_by_token: anon and authenticated, not service_role (as the other My day functions)');
select test.ok(not has_function_privilege('anon', 'private.watch_view(uuid)', 'execute') and not has_function_privilege('authenticated', 'private.watch_view(uuid)', 'execute')
               and not has_function_privilege('authenticated', 'private.watch_tidy()', 'execute'),
               'private.watch_view and watch_tidy: nobody but the functions and the trigger');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%') from pg_proc p
                where p.proname in ('watch_by_token', 'watch_add_by_token', 'watch_view', 'watch_tidy')),
               '... each with set search_path');
select test.ok(not has_table_privilege('anon', 'public.watch_items', 'select') and not has_table_privilege('service_role', 'public.watch_items', 'select')
               and has_table_privilege('authenticated', 'public.watch_items', 'select') and has_table_privilege('authenticated', 'public.watch_items', 'delete')
               and not has_column_privilege('authenticated', 'public.watch_items', 'created_by', 'insert')
               and not has_column_privilege('authenticated', 'public.watch_items', 'created_by', 'update')
               and has_column_privilege('authenticated', 'public.watch_items', 'watched_at', 'update'),
               'grants: anon and service_role nothing; members select, delete and the table''s own columns, never the audit columns');

-- ---------------------------------------------------------------------
-- Members: add, change, watch, delete
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.run($$insert into watch_items (id, title, kind, place, service, url, note, showing_until) values
  ('b0000000-0000-4000-8000-000000000001', '  Paddington
 in Peru ', 'movie', 'cinema', 'AMC', 'https://tickets.example/paddington', 'PG', '2026-11-20')$$), 'ok', 'Sam adds a movie in cinemas');
select test.is((select title || ' · ' || kind || ' · ' || place || ' · ' || service || ' · ' || showing_until || ' · ' || created_by from watch_items where id = 'b0000000-0000-4000-8000-000000000001'),
               'Paddington in Peru · movie · cinema · AMC · 2026-11-20 · sam@example.com', '... cleaned to one line, written as Sam');
:as_admin
select test.is(pg_temp.run($$insert into watch_items (id, title, kind, place) values ('b0000000-0000-4000-8000-000000000002', 'Wicked', 'show', 'theatre')$$), 'ok', 'Alex adds a show at the theatre');
select test.is(pg_temp.run($$insert into watch_items (id, title) values ('b0000000-0000-4000-8000-000000000003', 'Nature series')$$), 'ok', 'a title alone: a movie on Netflix');
select test.is((select kind || ' ' || place from watch_items where id = 'b0000000-0000-4000-8000-000000000003'), 'movie netflix', '... by default');
select test.is(pg_temp.run($$update watch_items set watched_at = now() where id = 'b0000000-0000-4000-8000-000000000003'$$), 'ok', 'Alex marks one watched');
select test.is(pg_temp.run($$insert into watch_items (title, place) values ('x', 'drive-in')$$), '23514 new row for relation "watch_items" violates check constraint "watch_items_place_check"',
               'a place that isn''t on the list: refused');
select test.is(pg_temp.run($$insert into watch_items (title, url) values ('x', 'javascript:alert(1)')$$), '23514 new row for relation "watch_items" violates check constraint "watch_items_url_check"',
               'a link that isn''t https: refused');
select test.is(pg_temp.run($$insert into watch_items (title) values ('   ')$$), '23514 new row for relation "watch_items" violates check constraint "watch_items_title_check"',
               'an empty title: refused');
select test.is(pg_temp.run($$insert into watch_items (title, created_by) values ('x', 'someone')$$), '42501 permission denied for table watch_items',
               'nobody sets created_by');
:as_adult
select test.is(pg_temp.run($$delete from watch_items where id = 'b0000000-0000-4000-8000-000000000002'$$), 'ok', 'Sam deletes one');
select test.is((select count(*)::int from watch_items), 2, '... gone');

-- Who sees nothing.
:as_anon
select test.is(test.try('select * from public.watch_items'), 'denied', 'anon reads nothing');
:as_stranger
select test.is((select count(*)::int from watch_items), 0, 'a stranger reads nothing');
select test.is(pg_temp.run($$insert into watch_items (title) values ('x')$$), '42501 new row violates row-level security policy for table "watch_items"', '... and adds nothing');
:as_removed
select test.is((select count(*)::int from watch_items), 0, 'a removed parent reads nothing');

-- ---------------------------------------------------------------------
-- A kid's My day
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.titles(watch_by_token(pg_temp.tok('Taylor'))), 'Paddington in Peru', 'Taylor''s list: what isn''t watched yet');
select test.is((select string_agg(k, ',' order by k) from jsonb_object_keys(watch_by_token(pg_temp.tok('Taylor')) -> 'items' -> 0) k), 'id,kind,mine,place,service,showing_until,title',
               '... with only its title, kind, place, service, last day and "mine": never a link, a note or a name');
select test.is(pg_temp.run($$select watch_add_by_token(pg_temp.tok('Taylor'), ' Wild   Robot ', 'movie', 'netflix', 'c0000000-0000-4000-8000-000000000001')$$), 'ok', 'Taylor adds one');
select test.is(pg_temp.titles(watch_by_token(pg_temp.tok('Taylor'))), 'Wild Robot | Paddington in Peru', '... newest first');
select test.is((select (x ->> 'mine') from jsonb_array_elements(watch_by_token(pg_temp.tok('Taylor')) -> 'items') x where x ->> 'title' = 'Wild Robot'), 'true', '... marked his');
select test.is(pg_temp.run($$select watch_add_by_token(pg_temp.tok('Taylor'), 'Wild Robot', 'movie', 'netflix', 'c0000000-0000-4000-8000-000000000001')$$), 'ok', 'a resend of the same key');
:as_owner
select test.is((select count(*)::int || ' ' || min(created_by) from watch_items where title = 'Wild Robot'), '1 Taylor (My day)', '... adds nothing more; written as "Taylor (My day)"');
select test.is((select changes from my_day_use where person_id = test.person('Taylor')), 1, '... and counted once');
:as_anon
select test.is(pg_temp.run($$select watch_add_by_token(pg_temp.tok('Taylor'), '', 'movie', 'netflix', 'c0000000-0000-4000-8000-000000000002')$$), '22023 Write what you want to watch.', 'an empty title');
select test.is(pg_temp.run($$select watch_add_by_token(pg_temp.tok('Taylor'), 'x', 'game', 'netflix', 'c0000000-0000-4000-8000-000000000002')$$), '22023 Choose a movie or a show.', 'a kind that isn''t movie or show');
select test.is(pg_temp.run($$select watch_add_by_token(pg_temp.tok('Taylor'), 'x', 'movie', 'drive-in', 'c0000000-0000-4000-8000-000000000002')$$), '22023 Choose where.', 'a place that isn''t on the list');
select test.is(pg_temp.run($$select watch_add_by_token(pg_temp.tok('Taylor'), repeat('x', 201), 'movie', 'netflix', 'c0000000-0000-4000-8000-000000000002')$$), '22023 That''s too long.', 'over 200 characters');
select test.is(pg_temp.run($$select watch_add_by_token(pg_temp.tok('Taylor'), 'x', 'movie', 'netflix', null)$$), '22023 It needs its id.', 'no key');
select test.is(pg_temp.run($$select watch_add_by_token(pg_temp.tok('Taylor'), 'x', 'movie', 'netflix', 'b0000000-0000-4000-8000-000000000001')$$), '22023 That id is taken.', 'a key someone else used');
select test.is(watch_by_token(pg_temp.tok('Morgan')), null, 'a helper''s token: null (kids only)');
select test.is(watch_add_by_token(pg_temp.tok('Morgan'), 'x', 'movie', 'netflix', 'c0000000-0000-4000-8000-000000000003'), null, '... and adds nothing');
select test.is(watch_by_token('0123456789abcdef0123456789abcdef'), null, 'an unknown token: null');
select test.is(watch_by_token('not a token'), null, 'a malformed one: null');
:as_owner
update people set active = false where name = 'Taylor';
:as_anon
select test.is(watch_by_token(pg_temp.tok('Taylor')), null, 'an inactive kid''s token: null');
:as_owner
update people set active = true where name = 'Taylor';
-- 30 changes a day from My day.
update my_day_use set changes = 30 where person_id = test.person('Taylor');
:as_anon
select test.is(pg_temp.run($$select watch_add_by_token(pg_temp.tok('Taylor'), 'One more', 'show', 'streaming', 'c0000000-0000-4000-8000-000000000004')$$),
               'P0001 Too many changes from My day today.', 'his 31st change of the day: refused');
:as_owner
select test.is((select count(*)::int from watch_items where title = 'One more'), 0, '... nothing added');

-- Members see what he added, and the watched one is still there for the page's Seen fold.
:as_adult
select test.is((select string_agg(title || ' ' || (watched_at is not null), ', ' order by title) from watch_items), 'Nature series true, Paddington in Peru false, Wild Robot false',
               'Sam sees everything, the watched one too');

-- ---------------------------------------------------------------------
-- get_person_day: 21's answer, plus 'watch' for an active kid
-- ---------------------------------------------------------------------
:as_owner
select test.ok(has_function_privilege('anon', 'public.get_person_day(text)', 'execute') and has_function_privilege('authenticated', 'public.get_person_day(text)', 'execute')
               and not has_function_privilege('service_role', 'public.get_person_day(text)', 'execute')
               and not has_function_privilege('anon', 'private.get_person_day_v21(text)', 'execute')
               and not has_function_privilege('authenticated', 'private.get_person_day_v21(text)', 'execute'),
               'get_person_day keeps its grants (anon and authenticated); 21''s, kept as private.get_person_day_v21, is for nobody');
select test.is(get_person_day(pg_temp.tok('Taylor')) - 'watch', private.get_person_day_v21(pg_temp.tok('Taylor')), 'a kid''s day is 21''s...');
select test.is((get_person_day(pg_temp.tok('Taylor')) ->> 'watch')::int, 2, '... plus watch: how many are still to watch (2)');
select test.is(get_person_day(pg_temp.tok('Morgan')), private.get_person_day_v21(pg_temp.tok('Morgan')), 'a helper''s day: exactly 21''s, no watch key');
select test.is(get_person_day('0123456789abcdef0123456789abcdef'), null, 'an unknown token: null, as before');
