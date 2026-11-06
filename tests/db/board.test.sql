-- The family board (migration 0020, docs/v2-design.md §25): one screen for the house with no sign-in. A parent makes,
-- replaces or turns off its link (board_link). board_by_token gives today for the house: each active person's column,
-- a Family column (an event with 4 or more of the family, or nobody; a task with nobody in charge), late tasks, a
-- kid's routine without points, and today's meals; Private items, health tasks and Google's private events read
-- "Private item", and only the Google calendars the wall shows are read. Ticks: board_tick_by_token (done by "Family
-- board"), board_undo_by_token (only the board's own, within 15 minutes), board_routine_by_token (as his My day does,
-- the section's bonus once a day). The grants, row-level security, and that a wrong link gets nothing.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Jordan (a parent, no longer signing in), Taylor (the kid),
-- Morgan (the helper, Spanish). Everything is made up. hub.now is Tue Nov 3, 2026, 7:00am (America/New_York).
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
-- A column by name ('Family' for the Family column), and its items' or late tasks' titles.
create function pg_temp.col(j jsonb, p_name text) returns jsonb language sql immutable as $$
  select case when p_name = 'Family' then j -> 'family'
              else (select x from jsonb_array_elements(j -> 'people') x where x ->> 'name' = p_name) end
$$;
create function pg_temp.titles(a jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(coalesce(x ->> 'time_label' || ' ', '') || (x ->> 'title') || ' [' || (x ->> 'status') || ']', ' | ' order by n), '-')
  from jsonb_array_elements(a) with ordinality t (x, n)
$$;
create function pg_temp.task(p_title text) returns uuid language sql stable security definer as $$
  select t.id from public.tasks t where t.title = p_title
$$;
create function pg_temp.item(p_title text) returns uuid language sql stable security definer as $$
  select it.id from public.routine_items it where it.title = p_title
$$;
create function pg_temp.log_of(p_title text) returns text language sql stable security definer as $$
  select coalesce(string_agg(l.status || ' ' || l.done_by, ', ' order by l.seq), '-')
  from public.task_log l join public.tasks t on t.id = l.task_id where t.title = p_title
$$;

-- Today, Tuesday Nov 3. Events: piano with the helper along; dinner at Grandma's with four of the family (Family); a
-- gate to fix with nobody on it (Family); Alex's private doctor's visit; a class cancelled today; one tomorrow.
insert into events (title, notes, location, start_date, start_time, end_time, responsible_id, participant_ids, contractor_id, private) values
  ('Piano', 'Bring the green book', 'Rivera Music', '2026-11-03', '15:00', '16:00', test.person('Taylor'), array[test.person('Morgan')], test.contractor('Rivera Music'), false),
  ('Dinner at Grandma''s', null, null, '2026-11-03', '18:00', '20:00', test.person('Alex'), array[test.person('Sam'), test.person('Jordan'), test.person('Taylor')], null, false),
  ('Fix the gate', null, null, '2026-11-03', null, null, null, '{}', null, false),
  ('Doctor', 'Bloodwork', 'Clinic', '2026-11-03', '10:00', '10:30', test.person('Alex'), '{}', null, true),
  ('Art class', null, null, '2026-11-03', '16:30', '17:30', test.person('Sam'), '{}', null, false),
  ('Swim', null, null, '2026-11-04', '16:00', '17:00', test.person('Taylor'), '{}', null, false);
insert into event_changes (event_id, on_date, cancelled) select id, '2026-11-03', true from events where title = 'Art class';
-- Tasks: his trash today and his late library books; the helper's daily cat feeding (repeating); Alex's pills (health);
-- the plants with nobody in charge; Sam's lawn tomorrow; a paused one; one in the inbox (no date).
insert into tasks (title, notes, category, responsible_id, due_date, repeat_mode, every_count, every_unit, anchor_date, active) values
  ('Take out trash', 'Blue bin', 'home', test.person('Taylor'), '2026-11-03', 'none', null, null, null, true),
  ('Return library books', null, 'other', test.person('Taylor'), '2026-11-01', 'none', null, null, null, true),
  ('Feed the cat', null, 'pets', test.person('Morgan'), '2026-11-03', 'schedule', 1, 'day', '2026-11-03', true),
  ('Pills', null, 'health', test.person('Alex'), '2026-11-03', 'none', null, null, null, true),
  ('Water plants', null, 'home', null, '2026-11-03', 'none', null, null, null, true),
  ('Mow lawn', null, 'home', test.person('Sam'), '2026-11-04', 'none', null, null, null, true),
  ('Clean garage', null, 'home', test.person('Sam'), '2026-11-03', 'none', null, null, null, false),
  ('Someday', null, 'other', test.person('Sam'), null, 'none', null, null, null, true);
-- Google: Taylor's Hub calendar (the hub writes it, so the wall shows it) with a photo and a private event; Alex's own
-- calendar the hub only reads (not on the wall); a Family calendar the hub reads and shows to kids.
insert into calendars (google_id, kind, person_id, label, writes, for_kids, status, access_role) values
  ('hub-taylor@group.calendar.google.com', 'person', test.person('Taylor'), 'Taylor', true, false, 'ok', 'writer'),
  ('alex.reads@example.com', 'person', test.person('Alex'), 'Alex', false, false, 'ok', 'reader'),
  ('family.reads@example.com', 'family', null, 'Family', false, true, 'ok', 'reader');
insert into google_events (calendar_id, google_calendar, event_id, title, all_day, start_day, end_day, start_at, end_at, private, read_at)
select c.id, c.google_id, v.e, v.t, v.a, v.s, v.d, v.sa, v.ea, v.p, now()
from calendars c
join (values ('hub-taylor@group.calendar.google.com', 'g-1', 'Team photo', false, date '2026-11-03', date '2026-11-03',
              timestamptz '2026-11-03 13:00+00', timestamptz '2026-11-03 13:30+00', false),
             ('hub-taylor@group.calendar.google.com', 'g-2', '', true, date '2026-11-03', date '2026-11-03', null, null, true),
             ('alex.reads@example.com', 'g-3', 'Work trip', true, date '2026-11-03', date '2026-11-03', null, null, false),
             ('family.reads@example.com', 'g-4', 'School picture day', true, date '2026-11-03', date '2026-11-03', null, null, false))
  v (cal, e, t, a, s, d, sa, ea, p) on v.cal = c.google_id;
-- Meals: tacos for dinner, Sam cooking; a locked lunch with Jordan on it.
insert into meals (day, slot, kind, title, cook_id, note, private) values
  ('2026-11-03', 'dinner', 'cook', 'Tacos', test.person('Sam'), 'Double the beans', false),
  ('2026-11-03', 'lunch', 'cook', 'Surprise party lunch', test.person('Jordan'), null, true);
select color as tcolor from people where name = 'Taylor' \gset

-- ---------------------------------------------------------------------
-- The schema, the signatures, their grants and row-level security
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 22, 'hub_schema_version is 22 (0020 made it 20, 0021 21, 0022 22)');
select test.ok((select bool_and(has_function_privilege('anon', f, 'execute') and has_function_privilege('authenticated', f, 'execute')
                                and not has_function_privilege('service_role', f, 'execute'))
                from unnest(array['public.board_by_token(text, text)', 'public.board_tick_by_token(text, uuid, date, text)',
                                  'public.board_undo_by_token(text, uuid, text)', 'public.board_routine_by_token(text, uuid, boolean, text)']) f),
               'the board''s four token functions: anon and authenticated, not service_role (as My day''s)');
select test.ok(has_function_privilege('authenticated', 'public.board_link(text)', 'execute') and not has_function_privilege('anon', 'public.board_link(text)', 'execute')
               and not has_function_privilege('service_role', 'public.board_link(text)', 'execute'),
               'board_link: authenticated only');
select test.ok((select bool_and(not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute'))
                from unnest(array['private.board_ok(text)', 'private.board_item(public.agenda_item, text, boolean)', 'private.board_view(text)']) f),
               'private.board_ok, board_item and board_view: nobody but the definer functions');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%') from pg_proc p
                where p.proname in ('board_link', 'board_by_token', 'board_tick_by_token', 'board_undo_by_token', 'board_routine_by_token', 'board_ok', 'board_item', 'board_view')),
               '... each with set search_path');
select test.ok((select c.relrowsecurity from pg_class c where c.oid = 'public.family_board'::regclass)
               and not exists (select 1 from pg_policies p where p.tablename = 'family_board')
               and not has_table_privilege('anon', 'public.family_board', 'select') and not has_table_privilege('authenticated', 'public.family_board', 'select')
               and not has_table_privilege('service_role', 'public.family_board', 'select'),
               'family_board: row-level security, no policies, and no privileges for anon, authenticated or service_role');
:as_anon
select test.is(test.try('select * from public.family_board'), 'denied', 'anon reads no board link');
select test.is(test.try($$select board_link('show')$$), 'denied', 'anon can''t call board_link');
:as_admin
select test.is(test.try('select * from public.family_board'), 'denied', 'a parent reads no board link directly either');

-- ---------------------------------------------------------------------
-- The link: a parent shows, makes, replaces and turns it off
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.run($$select board_link('new')$$), '42501 Only an admin can do that.', 'Sam (an adult) can''t make the link');
select test.is(pg_temp.run($$select board_link('show')$$), '42501 Only an admin can do that.', '... nor see it');
:as_removed
select test.is(pg_temp.run($$select board_link('show')$$), '42501 Only an admin can do that.', 'nor Jordan, who no longer signs in');
:as_admin
select test.is(board_link('show'), null, 'no board yet: show answers null');
select test.is(pg_temp.run($$select board_link('maybe')$$), '22023 Say show, new or off.', 'another action: refused');
select test.is(pg_temp.run($$select board_link(null)$$), '22023 Say show, new or off.', 'no action: refused');
select board_link('new') as tok1 \gset
select test.ok(:'tok1' ~ '^[0-9a-f]{32}$', 'new: a token of 32 hex characters');
select test.is(board_link('show'), :'tok1', 'show: the same token');
:as_owner
select test.is((select created_by from public.family_board), 'alex@example.com', '... made by Alex');
:as_admin
select board_link('new') as tok \gset
select test.ok(:'tok' <> :'tok1' and :'tok' ~ '^[0-9a-f]{32}$', 'new again: another token');
:as_owner
select test.is((select count(*) from public.family_board), 1::bigint, '... still one link');
:as_anon
select test.is(board_by_token(:'tok1', 'en'), null, '... and the old link answers null at once');

-- ---------------------------------------------------------------------
-- A link that doesn't work gets nothing, and changes nothing
-- ---------------------------------------------------------------------
:as_anon
select test.is(board_by_token(repeat('f', 32), 'en'), null, 'an unknown token: null');
select test.is(board_by_token('not-a-token', 'en'), null, 'a malformed one: null');
select test.is(board_by_token(null, 'en'), null, 'none: null');
select test.is(board_by_token(test.token('Taylor'), 'en'), null, 'a My day token isn''t a board link: null');
select test.is(board_tick_by_token(repeat('f', 32), pg_temp.task('Take out trash'), '2026-11-03', 'en'), null, 'a tick with an unknown token: null');
select test.is(board_routine_by_token(test.token('Taylor'), gen_random_uuid(), true, 'en'), null, 'a routine tick with a My day token: null');
select test.is(board_undo_by_token(repeat('f', 32), gen_random_uuid(), 'en'), null, 'an undo with an unknown token: null');
:as_owner
select test.is((select count(*) from public.task_log), 0::bigint, '... and nothing was ticked');

-- ---------------------------------------------------------------------
-- What the board shows
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
select save_routine(test.person('Taylor'),
  '[{"title": "Morning", "note": "At home", "items": [{"title": "Make bed"}, {"title": "Out of the house", "tag": "30 min early", "school_days": true}]},
    {"title": "Before bed", "items": [{"title": "Bag packed", "part": "Pack up"}, {"title": "Lights out", "part": "Wind down"}]}]'::jsonb, 2);
:as_owner
select (select id from routine_sections where title = 'Morning') as morning, (select id from routine_sections where title = 'Before bed') as bedtime \gset
:as_anon
select board_by_token(:'tok', 'en') as b \gset
select test.is(:'b'::jsonb ->> 'today', '2026-11-03', 'today is the household''s');
select test.is(:'b'::jsonb ->> 'tz', 'America/New_York', '... with its time zone');
select test.is(:'b'::jsonb ->> 'now', (floor(extract(epoch from timestamptz '2026-11-03 07:00 America/New_York') * 1000)::bigint)::text, '... and its clock (hub.now), in ms');
select test.is(:'b'::jsonb ->> 'lang', 'en', '... in English');
select test.is((select string_agg(x ->> 'name', ', ' order by n) from jsonb_array_elements(:'b'::jsonb -> 'people') with ordinality t (x, n)),
               'Alex, Sam, Jordan, Taylor, Morgan', 'a column for each active person, in the family list''s order, by first name');
select test.is(pg_temp.col(:'b'::jsonb, 'Taylor') ->> 'color', :'tcolor', '... each with their colour');
select test.is(pg_temp.titles(pg_temp.col(:'b'::jsonb, 'Taylor') -> 'items'),
               '8:00am Team photo [open] | 3:00pm Piano [open] | Private item [open] | Take out trash [open]',
               'Taylor: his Google photo (his Hub calendar), piano, his private Google event, and his trash');
select test.is(pg_temp.titles(pg_temp.col(:'b'::jsonb, 'Taylor') -> 'late'), 'Return library books [late]', '... his late books');
select test.is(pg_temp.col(:'b'::jsonb, 'Taylor') -> 'late' -> 0 ->> 'due_label', 'Nov 1', '... with their due date');
select test.is(pg_temp.titles(pg_temp.col(:'b'::jsonb, 'Morgan') -> 'items'), '3:00pm Piano [open] | Feed the cat [open]',
               'Morgan: piano (she''s along) and the cat');
select test.is(pg_temp.titles(pg_temp.col(:'b'::jsonb, 'Alex') -> 'items'), '10:00am Private item [open] | Private item [open]',
               'Alex: his private doctor''s visit and his health task, both "Private item"; not his own calendar''s work trip, nor dinner (Family)');
select test.is(pg_temp.titles(pg_temp.col(:'b'::jsonb, 'Sam') -> 'items'), '-', 'Sam: nothing (art cancelled today, the lawn is tomorrow, the garage paused, Someday has no date)');
select test.is(pg_temp.titles(pg_temp.col(:'b'::jsonb, 'Family') -> 'items'),
               '6:00pm Dinner at Grandma''s [open] | Fix the gate [open] | School picture day [open] | Water plants [open]',
               'Family: the dinner with four of the family, the gate with nobody, the Family calendar shown to kids, and the plants with nobody in charge');
select test.is(pg_temp.titles(pg_temp.col(:'b'::jsonb, 'Family') -> 'late'), '-', '... no late task without someone in charge');
select test.is((pg_temp.col(:'b'::jsonb, 'Alex') -> 'items' -> 0) - 'item_id' - 'occurrence',
               '{"kind": "event", "title": "Private item", "status": "open", "all_day": false, "private": true, "time_label": "10:00am"}'::jsonb,
               'an item is its kind, ids, title, time, whether it is all day, its status and whether it is private: nothing more');
select test.ok(position('Doctor' in :'b') = 0 and position('Bloodwork' in :'b') = 0 and position('Clinic' in :'b') = 0 and position('Pills' in :'b') = 0,
               'never the private event''s title, notes or place, nor the health task''s title');
select test.ok(position('Work trip' in :'b') = 0, 'never an event from a calendar the hub only reads for one person');
select test.ok(position('555-' in :'b') = 0 and position('Rivera' in :'b') = 0 and position('green book' in :'b') = 0 and position('Blue bin' in :'b') = 0
               and position('Double the beans' in :'b') = 0 and position('Surprise' in :'b') = 0,
               'never a phone number, a contractor, an event''s or task''s notes, a meal''s note or a locked meal''s title');
select test.is(:'b'::jsonb -> 'meals',
               '[{"slot": "lunch", "label": "Lunch", "title": "Private item", "cook": null}, {"slot": "dinner", "label": "Dinner", "title": "Tacos", "cook": "Sam"}]'::jsonb,
               'meals: the locked lunch as "Private item" without who''s on it, and dinner with its cook');
select test.ok(pg_temp.col(:'b'::jsonb, 'Taylor') ? 'routine' and not (pg_temp.col(:'b'::jsonb, 'Alex') ? 'routine')
               and not (pg_temp.col(:'b'::jsonb, 'Morgan') ? 'routine'),
               'the routine: only on Taylor''s column (the kid with homework on and a routine)');
select test.is(pg_temp.col(:'b'::jsonb, 'Taylor') -> 'routine',
               jsonb_build_object('sections', jsonb_build_array(
                 jsonb_build_object('id', :'morning'::uuid, 'title', 'Morning', 'note', 'At home', 'done', 0, 'total', 2,
                   'items', jsonb_build_array(
                     jsonb_build_object('id', pg_temp.item('Make bed'), 'title', 'Make bed', 'tag', null, 'part', null, 'done', false),
                     jsonb_build_object('id', pg_temp.item('Out of the house'), 'title', 'Out of the house', 'tag', '30 min early', 'part', null, 'done', false))),
                 jsonb_build_object('id', :'bedtime'::uuid, 'title', 'Before bed', 'note', null, 'done', 0, 'total', 2,
                   'items', jsonb_build_array(
                     jsonb_build_object('id', pg_temp.item('Bag packed'), 'title', 'Bag packed', 'tag', null, 'part', 'Pack up', 'done', false),
                     jsonb_build_object('id', pg_temp.item('Lights out'), 'title', 'Lights out', 'tag', null, 'part', 'Wind down', 'done', false))))),
               '... its sections and items as My day has them, without points or "paid"');
select board_by_token(:'tok', 'es') as bes \gset
select test.is(:'bes'::jsonb ->> 'lang', 'es', 'in Spanish: lang es');
select test.is(pg_temp.titles(pg_temp.col(:'bes'::jsonb, 'Alex') -> 'items'), '10:00 Asunto privado [open] | Asunto privado [open]', '... "Asunto privado", 24-hour times');
select test.is(:'bes'::jsonb -> 'meals' -> 1 ->> 'label', 'Cena', '... and the meals'' words');
select test.is(board_by_token(:'tok', 'fr') ->> 'lang', 'en', 'another language: English');
:as_admin
select test.is(board_by_token(:'tok', 'en'), :'b'::jsonb, 'signed in, the link answers the same');

-- ---------------------------------------------------------------------
-- Ticking off on the board, and Undo
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.run(format('select board_tick_by_token(%L, %L, %L, %L)', :'tok', pg_temp.task('Mow lawn'), '2026-11-04', 'en')),
               '42501 That isn''t on the board.', 'a task due tomorrow: refused');
select test.is(pg_temp.run(format('select board_tick_by_token(%L, %L, %L, %L)', :'tok', pg_temp.task('Someday'), null, 'en')),
               '42501 That isn''t on the board.', 'a task with no date: refused');
select test.is(pg_temp.run(format('select board_tick_by_token(%L, %L, %L, %L)', :'tok', gen_random_uuid(), null, 'en')),
               '42501 That isn''t on the board.', 'a task that isn''t there: refused');
select test.is(pg_temp.run(format('select board_tick_by_token(%L, %L, %L, %L)', :'tok', pg_temp.task('Clean garage'), '2026-11-03', 'en')),
               '22023 This task is paused. Turn it back on before ticking it off.', 'a paused task: refused, as on the hub''s pages');
select test.is(pg_temp.run(format('select board_tick_by_token(%L, %L, %L, %L)', :'tok', pg_temp.task('Feed the cat'), null, 'en')),
               'P0001 already completed', 'a repeating task without the date the board showed: refused');
select board_tick_by_token(:'tok', pg_temp.task('Take out trash'), '2026-11-03', 'en') as t1 \gset
select test.ok((:'t1'::jsonb ->> 'log_id') ~ '^[0-9a-f-]{36}$', 'the trash ticked: the answer carries the entry for Undo');
select test.is(pg_temp.titles(pg_temp.col(:'t1'::jsonb, 'Taylor') -> 'items'),
               '8:00am Team photo [open] | 3:00pm Piano [open] | Private item [open] | Take out trash [done]', '... and is the board, the trash done');
select test.is(pg_temp.log_of('Take out trash'), 'done Family board', '... logged as done by "Family board"');
select test.is(pg_temp.run(format('select board_tick_by_token(%L, %L, %L, %L)', :'tok', pg_temp.task('Take out trash'), '2026-11-03', 'en')),
               'P0001 already done', 'ticked twice: "already done"');
select board_tick_by_token(:'tok', pg_temp.task('Feed the cat'), '2026-11-03', 'en') as t2 \gset
select test.is(pg_temp.titles(pg_temp.col(:'t2'::jsonb, 'Morgan') -> 'items'), '3:00pm Piano [open] | Feed the cat [done]', 'the cat fed (a repeating task): done today');
:as_owner
select test.is((select due_date from tasks where title = 'Feed the cat'), date '2026-11-04', '... and due again tomorrow');
:as_anon
select test.is(pg_temp.titles(pg_temp.col(board_tick_by_token(:'tok', pg_temp.task('Return library books'), '2026-11-01', 'en'), 'Taylor') -> 'late'), '-',
               'the late books ticked: off the late list');
select test.is(pg_temp.titles(pg_temp.col(board_tick_by_token(:'tok', pg_temp.task('Water plants'), '2026-11-03', 'en'), 'Family') -> 'items'),
               '6:00pm Dinner at Grandma''s [open] | Fix the gate [open] | School picture day [open] | Water plants [done]', 'the plants (nobody in charge) ticked in Family');
select test.is(pg_temp.titles(pg_temp.col(board_undo_by_token(:'tok', (:'t1'::jsonb ->> 'log_id')::uuid, 'en'), 'Taylor') -> 'items'),
               '8:00am Team photo [open] | 3:00pm Piano [open] | Private item [open] | Take out trash [open]', 'Undo: the trash back on the board, open');
select test.is(pg_temp.log_of('Take out trash'), '-', '... its entry gone');
select test.is(pg_temp.run(format('select board_undo_by_token(%L, %L, %L)', :'tok', :'t1'::jsonb ->> 'log_id', 'en')),
               'P0002 There''s nothing to undo.', 'Undo twice: nothing to undo');
-- A tick from Taylor's My day isn't the board's to take back.
select complete_by_token(test.token('Taylor'), pg_temp.task('Take out trash'), '2026-11-03') as myday \gset
select test.is(pg_temp.run(format('select board_undo_by_token(%L, %L, %L)', :'tok', :'myday', 'en')),
               '42501 Only something ticked off on the board can be undone here.', 'a tick made on his My day: the board can''t undo it');
:as_owner
select test.is(pg_temp.log_of('Take out trash'), 'done Taylor (My day)', '... it stays');
:as_anon
-- After 15 minutes the board's own tick stays.
select board_tick_by_token(:'tok', pg_temp.task('Pills'), '2026-11-03', 'en') ->> 'log_id' as pills \gset
:as_owner
set hub.now = '2026-11-03 07:16 America/New_York';
:as_anon
select test.is(pg_temp.run(format('select board_undo_by_token(%L, %L, %L)', :'tok', :'pills', 'en')),
               '22023 That was more than 15 minutes ago, so it can''t be undone here.', 'Undo after 15 minutes: refused');
:as_owner
select test.is(pg_temp.log_of('Pills'), 'done Family board', '... the pills stay done');
set hub.now = '2026-11-03 07:20 America/New_York';

-- ---------------------------------------------------------------------
-- His routine, ticked on the board
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.run(format('select board_routine_by_token(%L, %L, null, %L)', :'tok', pg_temp.item('Make bed'), 'en')),
               '22023 Choose done or not done.', 'p_done null: refused');
select test.is(pg_temp.run(format('select board_routine_by_token(%L, %L, true, %L)', :'tok', gen_random_uuid(), 'en')),
               '42501 That isn''t on the board.', 'an item that isn''t there: refused');
select board_routine_by_token(:'tok', pg_temp.item('Make bed'), true, 'en') as r1 \gset
select test.is(pg_temp.col(:'r1'::jsonb, 'Taylor') -> 'routine' -> 'sections' -> 0 ->> 'done', '1', 'Make bed ticked: Morning 1 done, and the answer is the board');
select test.is(pg_temp.col(:'r1'::jsonb, 'Taylor') -> 'routine' -> 'sections' -> 0 -> 'items' -> 0 ->> 'done', 'true', '... the item ticked');
select test.ok(not (:'r1'::jsonb ? 'paid'), '... no points in the answer');
select board_routine_by_token(:'tok', pg_temp.item('Out of the house'), true, 'en') as r2 \gset
:as_owner
select test.is((select string_agg(l.delta || ' ' || l.note || ' ' || l.who, ', ') from points_ledger l where l.kind = 'routine'), '2 Morning Family board',
               'Morning finished on the board: its bonus, once, by "Family board"');
select test.is((select string_agg(distinct who, ',') from routine_ticks), 'Family board', '... the ticks noted as the board''s');
select test.is((select n from homework_use where actor_id = test.person('Taylor') and what = 'writes'), 2, '... each tick one of his writes');
:as_anon
select board_routine_by_token(:'tok', pg_temp.item('Out of the house'), false, 'en') as r3 \gset
select board_routine_by_token(:'tok', pg_temp.item('Out of the house'), true, 'en') as r4 \gset
:as_owner
select test.is((select count(*) from points_ledger l where l.kind = 'routine'), 1::bigint, 'untick and tick again: still one bonus');
-- His My day sees the board's ticks.
:as_anon
select test.is(get_person_day(test.token('Taylor')) -> 'routine' -> 'sections' -> 0 ->> 'done', '2', 'his My day sees Morning done');
-- Saturday: a school-days item can't be ticked.
:as_owner
set hub.now = '2026-11-07 09:00 America/New_York';
:as_anon
select test.is(pg_temp.run(format('select board_routine_by_token(%L, %L, true, %L)', :'tok', pg_temp.item('Out of the house'), 'en')),
               '22023 That one is for school days.', 'Saturday: a school-days item refused');
select test.is(pg_temp.col(board_by_token(:'tok', 'en'), 'Taylor') -> 'routine' -> 'sections' -> 0 ->> 'total', '1', '... and left off his Morning');
:as_owner
-- Homework off for him: no routine on the board, and its ticks are refused.
update homework_kids set active = false where kid_id = test.person('Taylor');
:as_anon
select test.ok(not (pg_temp.col(board_by_token(:'tok', 'en'), 'Taylor') ? 'routine'), 'homework off: no routine on the board');
select test.is(pg_temp.run(format('select board_routine_by_token(%L, %L, true, %L)', :'tok', pg_temp.item('Make bed'), 'en')),
               '42501 That isn''t on the board.', '... and its ticks refused');
:as_owner
update homework_kids set active = true where kid_id = test.person('Taylor');
set hub.now = '2026-11-03 07:30 America/New_York';

-- ---------------------------------------------------------------------
-- Someone off the family list
-- ---------------------------------------------------------------------
:as_owner
update people set active = false where name = 'Morgan';
:as_anon
select board_by_token(:'tok', 'en') as off \gset
select test.is((select string_agg(x ->> 'name', ', ' order by n) from jsonb_array_elements(:'off'::jsonb -> 'people') with ordinality t (x, n)),
               'Alex, Sam, Jordan, Taylor', 'Morgan off the family list: no column');
select test.ok(position('Morgan' in :'off') = 0, '... and not named anywhere');
:as_owner
update people set active = true where name = 'Morgan';

-- ---------------------------------------------------------------------
-- Off
-- ---------------------------------------------------------------------
:as_admin
select test.is(board_link('off'), null, 'off: answers null');
select test.is(board_link('show'), null, '... show: null');
:as_anon
select test.is(board_by_token(:'tok', 'en'), null, '... and the link answers null');
select test.is(board_tick_by_token(:'tok', pg_temp.task('Water plants'), '2026-11-03', 'en'), null, '... its ticks too');
:as_owner
select test.is((select count(*) from public.family_board), 0::bigint, '... no link kept');
