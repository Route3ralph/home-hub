-- The routine (migration 0019, docs/v1.3-homework.md §24): a kid's day as sections of items he ticks on his My day,
-- the same every day, starting again each day. A parent saves it whole (save_routine, parents only, with its
-- limits); routine_status reads it for the Homework page. get_person_day carries 'routine' (today's view: an item for
-- school days only left out on a weekend or a household day off) only for a kid with homework on and something to
-- show. routine_tick_by_token ticks and unticks his own items today and pays the section's bonus once a day (points
-- on, routine_points above 0); unticking keeps it. The grants, row-level security, and that nothing else changes.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (the kid with homework), Morgan (the helper).
-- Everything is made up. hub.now is Tue Nov 3, 2026 (America/New_York) unless a case moves it.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-03 07:00 America/New_York';   -- a Tuesday
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
create function pg_temp.item(p_title text) returns uuid language sql stable security definer as $$
  select it.id from public.routine_items it where it.title = p_title
$$;
create function pg_temp.sec(j jsonb, p_title text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(j -> 'sections') x where x ->> 'title' = p_title
$$;
create function pg_temp.titles(j jsonb) returns text language sql immutable as $$
  select string_agg(x ->> 'title', ' | ' order by n) from jsonb_array_elements(j) with ordinality t (x, n)
$$;
create function pg_temp.ledger() returns text language sql stable security definer as $$
  select coalesce(string_agg(l.day || ' ' || l.delta || ' ' || l.note, ', ' order by l.day, l.at), '-') from public.points_ledger l where l.kind = 'routine'
$$;

-- ---------------------------------------------------------------------
-- The schema, the signatures, their grants and row-level security
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 20, 'hub_schema_version is 20 (0019 made it 19, 0020 20)');
select test.ok(has_function_privilege('anon', 'public.routine_tick_by_token(text, uuid, boolean)', 'execute')
               and has_function_privilege('authenticated', 'public.routine_tick_by_token(text, uuid, boolean)', 'execute')
               and not has_function_privilege('service_role', 'public.routine_tick_by_token(text, uuid, boolean)', 'execute'),
               'routine_tick_by_token: anon and authenticated, not service_role (as school_item_by_token)');
select test.ok(has_function_privilege('authenticated', 'public.routine_status(uuid)', 'execute') and not has_function_privilege('anon', 'public.routine_status(uuid)', 'execute')
               and has_function_privilege('authenticated', 'public.save_routine(uuid, jsonb, int)', 'execute') and not has_function_privilege('anon', 'public.save_routine(uuid, jsonb, int)', 'execute'),
               'routine_status and save_routine: authenticated only');
select test.ok(not has_function_privilege('anon', 'private.routine_view(uuid, date)', 'execute') and not has_function_privilege('authenticated', 'private.routine_view(uuid, date)', 'execute')
               and not has_function_privilege('authenticated', 'private.routine_school_day(date)', 'execute'),
               'private.routine_view and routine_school_day: nobody but the definer functions');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%') from pg_proc p
                where p.proname in ('routine_tick_by_token', 'routine_status', 'save_routine', 'routine_view', 'routine_school_day', 'get_person_day')),
               '... each with set search_path');
select test.ok((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.routine_sections'::regclass, 'public.routine_items'::regclass, 'public.routine_ticks'::regclass)),
               'the three tables have row-level security');
:as_anon
select test.is(test.try('select * from public.routine_sections'), 'denied', 'anon reads no routine');
select test.is(test.try('select * from public.routine_ticks'), 'denied', '... nor its ticks');
:as_adult
select test.is(test.try('insert into public.routine_sections (kid_id, pos, title) values (''' || test.person('Taylor') || ''', 1, ''x'')'), 'denied', 'a member writes no routine directly');

-- ---------------------------------------------------------------------
-- No routine yet: nothing changes
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_anon
select test.ok(not (get_person_day(test.token('Taylor')) ? 'routine'), 'no routine: My day has no routine key');
:as_adult
select routine_status(test.person('Taylor')) as st0 \gset
select test.is(:'st0'::jsonb -> 'sections', '[]'::jsonb, 'routine_status: no sections');
select test.is(:'st0'::jsonb -> 'today', 'null'::jsonb, '... and nothing today');
select test.is(:'st0'::jsonb ->> 'points', '0', '... points 0 (the default)');

-- ---------------------------------------------------------------------
-- A parent saves it; its limits
-- ---------------------------------------------------------------------
\set R '''[{"title": "Morning", "note": "At home", "items": [{"title": "Make bed"}, {"title": "Out of the house", "tag": "30 min early", "school_days": true}]}, {"title": "Before bed", "items": [{"title": "Bag packed", "part": "Pack up"}, {"title": "Lights out", "part": "Wind down"}]}]'''
:as_adult
select test.is(pg_temp.run(format('select save_routine(%L, %L, 2)', test.person('Taylor'), :R)), '42501 Only a parent can change homework.', 'Sam can''t save a routine');
:as_admin
select test.is(pg_temp.run(format('select save_routine(%L, %L, 11)', test.person('Taylor'), :R)), '22023 Points for a finished section: 0 to 10.', 'points past 10: refused');
select test.is(pg_temp.run(format('select save_routine(%L, %L, 2)', test.person('Taylor'),
                 (select jsonb_agg(jsonb_build_object('title', 'S' || n, 'items', '[{"title": "x"}]'::jsonb)) from generate_series(1, 9) n))),
               '22023 A routine has at most 8 sections.', '9 sections: refused');
select test.is(pg_temp.run(format('select save_routine(%L, %L, 2)', test.person('Taylor'),
                 jsonb_build_array(jsonb_build_object('title', 'A', 'items', (select jsonb_agg(jsonb_build_object('title', 'i' || n)) from generate_series(1, 41) n))))),
               '22023 A routine has at most 40 items.', '41 items: refused');
select test.is(pg_temp.run(format('select save_routine(%L, %L, 2)', test.person('Taylor'), '[{"title": "Morning", "items": []}]')),
               '22023 Each section needs 1 to 30 items.', 'a section with no items: refused');
select test.is(pg_temp.run(format('select save_routine(%L, %L, 2)', test.person('Taylor'), '[{"title": " ", "items": [{"title": "x"}]}]')),
               '22023 Each section needs a title.', 'a section without a title: refused');
select test.is(pg_temp.run(format('select save_routine(%L, %L, 2)', test.person('Taylor'), '[{"title": "Morning", "items": [{"title": ""}]}]')),
               '22023 Each item needs a title.', 'an item without a title: refused');
select test.is(pg_temp.run(format('select save_routine(%L, %L, 2)', test.person('Taylor'), '[{"title": "Morning", "items": [{"title": "x", "school_days": "maybe"}]}]')),
               '22023 That routine can''t be saved.', 'school_days that isn''t true or false: refused');
select test.is(pg_temp.run(format('select save_routine(%L, %L, 2)', test.person('Sam'), '[{"title": "Morning", "items": [{"title": "x"}]}]')),
               '22023 Turn on homework for this kid first.', 'someone without homework: refused');
:as_owner
select test.is((select count(*) from public.routine_sections), 0::bigint, '... and nothing was saved');
:as_admin
select save_routine(test.person('Taylor'), :R::jsonb, 2) as st \gset
select test.is(pg_temp.titles(:'st'::jsonb -> 'sections'), 'Morning | Before bed', 'saved: the two sections, in order');
select test.is(pg_temp.sec(:'st'::jsonb, 'Morning') -> 'items', jsonb_build_array(
                 jsonb_build_object('id', pg_temp.item('Make bed'), 'title', 'Make bed', 'tag', null, 'part', null, 'school_days', false),
                 jsonb_build_object('id', pg_temp.item('Out of the house'), 'title', 'Out of the house', 'tag', '30 min early', 'part', null, 'school_days', true)),
               '... each item with its tag, part and school-days flag');
select test.is(:'st'::jsonb ->> 'points', '2', '... points 2');
select test.is(:'st'::jsonb -> 'today' ->> 'school_day', 'true', '... today (a Tuesday) is a school day');

-- ---------------------------------------------------------------------
-- His My day: today's routine, ticks, the section's bonus once a day
-- ---------------------------------------------------------------------
:as_anon
select get_person_day(test.token('Taylor')) -> 'routine' as r \gset
select test.is((select string_agg((x ->> 'title') || ' ' || (x ->> 'done') || '/' || (x ->> 'total') || ' ' || (x ->> 'paid'), ', ') from jsonb_array_elements(:'r'::jsonb -> 'sections') x),
               'Morning 0/2 false, Before bed 0/2 false', 'My day: his routine, both sections, nothing done');
select test.is(pg_temp.sec(:'r'::jsonb, 'Before bed') -> 'items' -> 0 ->> 'part', 'Pack up', '... an item''s part');
select test.is(:'r'::jsonb ->> 'points', '2', '... what a finished section pays');
select test.is(pg_temp.run(format('select routine_tick_by_token(%L, %L, null)', test.token('Taylor'), pg_temp.item('Make bed'))), '22023 Choose done or not done.', 'p_done null: refused');
select test.is(pg_temp.run(format('select routine_tick_by_token(%L, %L, true)', test.token('Taylor'), gen_random_uuid())), '42501 That isn''t on your routine.', 'an item that isn''t his: refused');
select test.is(routine_tick_by_token(test.token('Morgan'), pg_temp.item('Make bed'), true), null, 'the helper''s token: null');
select routine_tick_by_token(test.token('Taylor'), pg_temp.item('Make bed'), true) as t1 \gset
select test.is(:'t1'::jsonb ->> 'paid', '0', 'Make bed ticked: nothing paid yet');
select test.is(pg_temp.sec(:'t1'::jsonb -> 'routine', 'Morning') ->> 'done', '1', '... the answer is My day: Morning 1 done');
select test.ok(:'t1'::jsonb ? 'days' and :'t1'::jsonb ? 'homework', '... the whole day, with his homework card');
select routine_tick_by_token(test.token('Taylor'), pg_temp.item('Out of the house'), true) as t2 \gset
select test.is(:'t2'::jsonb ->> 'paid', '2', 'the last item of Morning: the section''s bonus, 2');
select test.is(pg_temp.sec(:'t2'::jsonb -> 'routine', 'Morning') ->> 'paid', 'true', '... Morning paid');
select test.is(pg_temp.ledger(), '2026-11-03 2 Morning', '... one routine entry: 2 points, "Morning"');
select test.is(routine_tick_by_token(test.token('Taylor'), pg_temp.item('Out of the house'), false) ->> 'paid', '0', 'untick: nothing taken back');
select test.is(routine_tick_by_token(test.token('Taylor'), pg_temp.item('Out of the house'), true) ->> 'paid', '0', 'tick again: nothing more paid');
select test.is(pg_temp.ledger(), '2026-11-03 2 Morning', '... still one entry');
select test.is(routine_tick_by_token(test.token('Taylor'), pg_temp.item('Out of the house'), true) ->> 'paid', '0', 'a tick sent twice: as one');
:as_owner
select test.is((select count(*) from public.routine_ticks), 2::bigint, '... two ticks today');
select test.is((select who from public.routine_ticks t where t.item_id = pg_temp.item('Make bed')), 'Taylor (My day)', '... noted as his');

-- ---------------------------------------------------------------------
-- A weekend, and a household day off: the school-days items stay off
-- ---------------------------------------------------------------------
set hub.now = '2026-11-07 09:00 America/New_York';   -- a Saturday
:as_anon
select get_person_day(test.token('Taylor')) -> 'routine' as r2 \gset
select test.is(:'r2'::jsonb ->> 'school_day', 'false', 'Saturday: not a school day');
select test.is(pg_temp.titles(pg_temp.sec(:'r2'::jsonb, 'Morning') -> 'items') || ' ' || (pg_temp.sec(:'r2'::jsonb, 'Morning') ->> 'total'), 'Make bed 1',
               '... Morning without "Out of the house" (school days only); nothing done (a new day)');
select test.is(pg_temp.run(format('select routine_tick_by_token(%L, %L, true)', test.token('Taylor'), pg_temp.item('Out of the house'))), '22023 That one is for school days.',
               'ticking a school-days item on Saturday: refused');
select test.is(routine_tick_by_token(test.token('Taylor'), pg_temp.item('Make bed'), true) ->> 'paid', '2', 'Saturday''s Morning finished with its one item: 2');
select test.is(pg_temp.ledger(), '2026-11-03 2 Morning, 2026-11-07 2 Morning', '... a second entry, for Saturday');
:as_owner
update public.household set days_off = days_off || '{2026-11-09}'::date[];
set hub.now = '2026-11-09 09:00 America/New_York';   -- a Monday, a day off
:as_anon
select test.is(get_person_day(test.token('Taylor')) -> 'routine' ->> 'school_day', 'false', 'a household day off (a Monday): not a school day');

-- A section whose every item is for school days: left out on a weekend.
:as_admin
select save_routine(test.person('Taylor'), jsonb_build_array(
  jsonb_build_object('title', 'Morning', 'items', jsonb_build_array(jsonb_build_object('id', pg_temp.item('Make bed'), 'title', 'Make bed'),
                                                                    jsonb_build_object('id', pg_temp.item('Out of the house'), 'title', 'Out of the house', 'tag', '30 min early', 'school_days', true))),
  jsonb_build_object('title', 'Home time', 'items', '[{"title": "Water bottle", "school_days": true}]'::jsonb),
  jsonb_build_object('title', 'Before bed', 'items', jsonb_build_array(jsonb_build_object('id', pg_temp.item('Bag packed'), 'title', 'Bag packed', 'part', 'Pack up'),
                                                                       jsonb_build_object('id', pg_temp.item('Lights out'), 'title', 'Lights out', 'part', 'Wind down')))), 2) as st2 \gset
select test.is(pg_temp.titles(:'st2'::jsonb -> 'today' -> 'sections'), 'Morning | Before bed', 'a day off: the section of school-days items (Home time) is left out');
select test.is(pg_temp.titles(:'st2'::jsonb -> 'sections'), 'Morning | Home time | Before bed', '... but the editor has it');

-- ---------------------------------------------------------------------
-- Saving again: ids keep their ticks; an item left out goes with its ticks
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-10 07:00 America/New_York';   -- a Tuesday
:as_anon
select routine_tick_by_token(test.token('Taylor'), pg_temp.item('Make bed'), true);
select routine_tick_by_token(test.token('Taylor'), pg_temp.item('Bag packed'), true);
:as_admin
select save_routine(test.person('Taylor'), jsonb_build_array(
  jsonb_build_object('title', 'Before bed', 'items', jsonb_build_array(jsonb_build_object('id', pg_temp.item('Lights out'), 'title', 'Lights out'),
                                                                       jsonb_build_object('id', pg_temp.item('Bag packed'), 'title', 'Bag packed, books too'))),
  jsonb_build_object('title', 'Morning', 'items', jsonb_build_array(jsonb_build_object('id', pg_temp.item('Make bed'), 'title', 'Make bed')))), 2) as st3 \gset
select test.is(pg_temp.titles(:'st3'::jsonb -> 'sections'), 'Before bed | Morning', 'saved in a new order');
select test.is((select string_agg((x ->> 'title') || ' ' || (x ->> 'done') || '/' || (x ->> 'total'), ', ') from jsonb_array_elements(:'st3'::jsonb -> 'today' -> 'sections') x),
               'Before bed 1/2, Morning 1/1', '... today''s ticks kept (the renamed bag item too)');
:as_owner
select test.is((select count(*) from public.routine_items where title in ('Out of the house', 'Water bottle')), 0::bigint, 'the items left out are gone');
select test.is((select count(*) from public.routine_sections where title = 'Home time'), 0::bigint, '... and the section left out');

-- ---------------------------------------------------------------------
-- Points off, routine points 0, homework off; ticks kept 30 days
-- ---------------------------------------------------------------------
update public.homework_kids set points_on = false where kid_id = test.person('Taylor');
:as_anon
select test.is(get_person_day(test.token('Taylor')) -> 'routine' ->> 'points', '0', 'points off: a finished section pays 0');
select test.is(routine_tick_by_token(test.token('Taylor'), pg_temp.item('Lights out'), true) ->> 'paid', '0', '... and finishing one pays nothing');
:as_owner
update public.homework_kids set points_on = true, routine_points = 0 where kid_id = test.person('Taylor');
select test.is(pg_temp.ledger(), '2026-11-03 2 Morning, 2026-11-07 2 Morning', 'routine points 0 (and points off): no entry');
set hub.now = '2026-12-12 07:00 America/New_York';
:as_anon
select routine_tick_by_token(test.token('Taylor'), pg_temp.item('Make bed'), true);
:as_owner
select test.is((select string_agg(t.day::text, ',' order by t.day) from public.routine_ticks t), '2026-12-12', 'a tick: ticks older than 30 days go');
update public.homework_kids set active = false where kid_id = test.person('Taylor');
:as_anon
select test.ok(not (get_person_day(test.token('Taylor')) ? 'routine'), 'homework off: no routine on My day');
select test.is(routine_tick_by_token(test.token('Taylor'), pg_temp.item('Make bed'), true), null, '... and his ticks answer null');
