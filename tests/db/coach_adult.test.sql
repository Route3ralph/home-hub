-- The coach (migration 0021, docs/v1.3-homework.md §25): a box on an adult's card (people.coach, set only by the parents
-- with set_coach) that lets that adult, while active and able to sign in, do on the Homework page what a parent does for
-- the kids: assignments and rewards (the table policies), plans and steps, Yes or Not now, points given (at most 200 a
-- household week to a kid) and voided, the AI's preview and drafts (and hub-jobs' homework_ai_start, never Test), New
-- from school, and the routine (its points as they are). Everything else stays the parents': the switches, homework
-- time, tutor and school links, Erase, the family list, the board. With the box off nothing changes for anyone.
-- The household is fixtures.sql's: Alex (admin), Sam (adult, a member), Taylor (the kid with homework), Jordan (a
-- removed parent); plus Riley, an adult who can't sign in. Everything is made up. hub.now is Wed Nov 4, 2026, 5:30pm
-- (America/New_York): this household week is Mon Nov 2 to Sun Nov 8.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-04 17:30 America/New_York';
insert into people (name, role, sort_order) values ('Riley', 'adult', 6);
-- Whether a call gets past the parents' check: 'parent-only' (refused as not a parent), 'denied' (no privilege), or
-- 'passes' (any other answer: done, or refused for another reason after the check).
create function pg_temp.gate(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'passes';
exception
  when insufficient_privilege then
    return case when sqlerrm like 'Only a parent%' or sqlerrm like 'Only an admin%' or sqlerrm like 'Only family%' then 'parent-only'
                when sqlerrm like 'permission denied%' or sqlerrm like 'new row violates row-level security%' then 'denied'
                else 'passes' end;
  when others then
    return 'passes';
end;
$$;
grant execute on function pg_temp.gate(text) to authenticated, anon;
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to authenticated, anon;
create function pg_temp.coach_of(p_name text) returns boolean language sql stable security definer as $$
  select coach from public.people where name = p_name
$$;
create function pg_temp.balance(p_kid uuid) returns int language sql stable security definer as $$
  select balance from private.points_balance(p_kid)
$$;
grant execute on function pg_temp.balance(uuid) to authenticated;

:as_admin
select save_homework_kid(test.person('Taylor'), true);
update homework_kids set points_on = true where kid_id = test.person('Taylor');
:as_owner
insert into assignments (id, kid_id, kind, title, subject, due_date, status) values
  ('a0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'assignment', 'Volcano poster', 'Science', '2026-11-10', 'open');
insert into points_ledger (id, kid_id, at, day, kind, delta, note, who) values
  ('c0000000-0000-4000-8000-000000000001', test.person('Taylor'), '2026-11-03 21:50+00', '2026-11-03', 'given', 300, 'Starting points', 'alex@example.com');
insert into rewards (id, kid_id, title, cost, active, instant, suggested, sort_order) values
  ('d0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'Pick the movie', 200, true, false, false, 1);
insert into reward_asks (id, kid_id, reward_id, title, cost, status, asked_at) values
  ('e0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'd0000000-0000-4000-8000-000000000001', 'Pick the movie', 200, 'waiting', '2026-11-04 21:00+00');

-- ---------------------------------------------------------------------
-- The schema, the signatures, their grants
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 26, 'hub_schema_version is 26');
select test.is((select string_agg(name || ' ' || coach, ', ' order by name) from people), 'Alex false, Jordan false, Morgan false, Riley false, Sam false, Taylor false',
               'people.coach is off for everyone');
select test.ok(has_function_privilege('authenticated', 'public.can_coach()', 'execute') and not has_function_privilege('anon', 'public.can_coach()', 'execute')
               and has_function_privilege('authenticated', 'public.set_coach(uuid, boolean)', 'execute') and not has_function_privilege('anon', 'public.set_coach(uuid, boolean)', 'execute'),
               'can_coach and set_coach: authenticated only');
select test.ok(has_function_privilege('authenticated', 'private.is_coach()', 'execute') and not has_function_privilege('anon', 'private.is_coach()', 'execute'),
               'private.is_coach: authenticated (the policies ask it), not anon');
select test.ok(not has_function_privilege('authenticated', 'private.is_coach_email(text)', 'execute') and not has_function_privilege('anon', 'private.is_coach_email(text)', 'execute')
               and not has_function_privilege('authenticated', 'private.coach_rewrite(boolean)', 'execute') and not has_function_privilege('service_role', 'private.coach_rewrite(boolean)', 'execute')
               and not has_function_privilege('authenticated', 'private.give_points_v20(uuid, integer, text, uuid)', 'execute')
               and not has_function_privilege('authenticated', 'private.save_routine_v20(uuid, jsonb, integer)', 'execute'),
               'is_coach_email, coach_rewrite and the two wrapped functions: nobody');
select test.ok(has_function_privilege('authenticated', 'public.give_points(uuid, integer, text, uuid)', 'execute') and not has_function_privilege('anon', 'public.give_points(uuid, integer, text, uuid)', 'execute')
               and not has_function_privilege('service_role', 'public.give_points(uuid, integer, text, uuid)', 'execute')
               and has_function_privilege('authenticated', 'public.save_routine(uuid, jsonb, integer)', 'execute') and not has_function_privilege('anon', 'public.save_routine(uuid, jsonb, integer)', 'execute'),
               'give_points and save_routine keep their grants (authenticated only)');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%') from pg_proc p
                where p.proname in ('is_coach', 'is_coach_email', 'can_coach', 'set_coach', 'coach_rewrite', 'give_points', 'give_points_v20', 'save_routine', 'save_routine_v20')),
               '... each with set search_path');
select test.is((select count(*)::int from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosrc like '%is_coach%'
                and p.proname not in ('is_coach', 'can_coach')), 13,
               'is_coach is asked by the ten rewritten functions, the two wrappers and the routine''s wrapped one... (13 bodies)');

-- ---------------------------------------------------------------------
-- Off: an adult who signs in is as before
-- ---------------------------------------------------------------------
:as_adult
select test.is(can_coach(), false, 'Sam, an adult, isn''t the coach');
select test.is(pg_temp.gate($$select save_homework_plan('a0000000-0000-4000-8000-000000000001', '[]', 0)$$), 'parent-only', '... can''t save a plan');
select test.is(pg_temp.gate($$select give_points(test.person('Taylor'), 5, 'Nice', 'f0000000-0000-4000-8000-000000000009')$$), 'parent-only', '... nor give points');
select test.is(pg_temp.gate($$insert into assignments (kid_id, kind, title, due_date) values (test.person('Taylor'), 'assignment', 'x', '2026-11-12')$$), 'denied',
               '... nor add an assignment');
:as_admin
select test.is(can_coach(), true, 'a parent is the coach too (can_coach)');
:as_removed
select test.is(can_coach(), false, 'a removed parent isn''t');
:as_stranger
select test.is(can_coach(), false, 'nor a stranger');
:as_anon
select test.is(pg_temp.run('select can_coach()'), '42501 permission denied for function can_coach', 'anon can''t ask');

-- ---------------------------------------------------------------------
-- The box: set_coach (parents)
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.run($$select set_coach(test.person('Sam'), true)$$), '42501 Only an admin can change the family list.', 'an adult can''t tick his own box');
:as_anon
select test.is(pg_temp.run($$select set_coach(test.person('Sam'), true)$$), '42501 permission denied for function set_coach', 'anon can''t');
:as_admin
select test.is(pg_temp.run($$select set_coach(test.person('Taylor'), true)$$), '22023 Only an adult on the family list can manage the kids'' homework.', 'a kid can''t be the coach');
select test.is(pg_temp.run($$select set_coach(test.person('Jordan'), true)$$), '22023 Only an adult on the family list can manage the kids'' homework.', 'nor a parent (the box is for adults)');
select test.is(pg_temp.run($$select set_coach(test.person('Riley'), true)$$), '22023 Tick Can sign in first.', 'an adult who can''t sign in: "Tick Can sign in first."');
select test.is(pg_temp.run($$select set_coach(test.person('Sam'), null)$$), '22023 Choose on or off.', 'null: "Choose on or off."');
select test.is(pg_temp.run($$select set_coach('00000000-0000-4000-8000-000000000000', true)$$), '22023 That person is gone.', 'an unknown person');
select test.is(pg_temp.run($$select set_coach(test.person('Riley'), false)$$), 'ok', 'off always works');
select test.is(pg_temp.run($$select set_coach(test.person('Sam'), true)$$), 'ok', 'Sam''s box ticked');
select test.is(pg_temp.coach_of('Sam'), true, '... people.coach is on');

-- ---------------------------------------------------------------------
-- On: what the coach can do
-- ---------------------------------------------------------------------
:as_adult
select test.is(can_coach(), true, 'Sam is the coach');
select test.is(pg_temp.gate($$select save_homework_plan('00000000-0000-4000-8000-000000000000', '[]', 0)$$), 'passes', 'save_homework_plan gets past the check');
select test.is(pg_temp.gate($$select homework_step('00000000-0000-4000-8000-000000000000', 'check')$$), 'passes', 'homework_step (Answer, Looks done, Not yet)');
select test.is(pg_temp.gate($$select homework_ai_preview('a0000000-0000-4000-8000-000000000001')$$), 'passes', 'homework_ai_preview');
select test.is(pg_temp.gate($$select homework_ai_draft('a0000000-0000-4000-8000-000000000001', 'dismiss')$$), 'passes', 'homework_ai_draft');
select test.is(pg_temp.gate($$select school_item_action('00000000-0000-4000-8000-000000000000', 'hide')$$), 'passes', 'school_item_action (New from school)');
select test.is(pg_temp.gate($$select void_points('00000000-0000-4000-8000-000000000000', 'Oops')$$), 'passes', 'void_points');
select test.is(pg_temp.run($$insert into assignments (kid_id, kind, title, due_date) values (test.person('Taylor'), 'assignment', 'Read chapter 4', '2026-11-12')$$), 'ok',
               'adds an assignment');
select test.is(pg_temp.run($$update assignments set title = 'Read chapters 4 and 5' where title = 'Read chapter 4'$$), 'ok', '... changes it');
select test.is((select title from assignments where title like 'Read chapter%'), 'Read chapters 4 and 5', '... changed');
select test.is(pg_temp.run($$delete from assignments where title = 'Read chapters 4 and 5'$$), 'ok', '... and removes it');
select test.is((select count(*)::int from assignments where title like 'Read chapter%'), 0, '... gone');
select test.is(pg_temp.run($$insert into rewards (kid_id, title, cost, active, instant, sort_order) values (test.person('Taylor'), 'Pizza night', 150, true, false, 2)$$), 'ok',
               'adds a reward');
select test.is(pg_temp.run($$update rewards set cost = 120 where title = 'Pizza night'$$), 'ok', '... prices it');
select test.is(pg_temp.run($$delete from rewards where title = 'Pizza night'$$), 'ok', '... removes it');
select test.is(pg_temp.run($$select decide_reward('e0000000-0000-4000-8000-000000000001', true)$$), 'ok', 'Yes on his ask');
select test.is((select status || ' ' || decided_by from reward_asks where id = 'e0000000-0000-4000-8000-000000000001'), 'approved sam@example.com', '... approved, by Sam');
select test.is(pg_temp.balance(test.person('Taylor')), 100, '... and paid for (300 − 200)');

-- Points given: at most 200 a household week to a kid from the coach; a parent as before.
select test.is(pg_temp.run($$select give_points(test.person('Taylor'), 150, 'Great week', 'f0000000-0000-4000-8000-000000000001')$$), 'ok', 'gives 150 points');
select test.is((select delta || ' ' || who from points_ledger where id = 'f0000000-0000-4000-8000-000000000001'), '150 sam@example.com', '... written as Sam');
select test.is(pg_temp.run($$select give_points(test.person('Taylor'), 60, 'More', 'f0000000-0000-4000-8000-000000000002')$$),
               'P0001 That''s more than 200 points this week from you. A parent can give more.', '60 more: over 200 this week, refused');
select test.is(pg_temp.run($$select give_points(test.person('Taylor'), 150, 'Great week', 'f0000000-0000-4000-8000-000000000001')$$), 'ok',
               'a resend of the first answers as it was (no second 150)');
select test.is((select count(*)::int from points_ledger where kind = 'given' and who = 'sam@example.com'), 1, '... one line');
select test.is(pg_temp.run($$select give_points(test.person('Taylor'), 50, 'Done early', 'f0000000-0000-4000-8000-000000000003')$$), 'ok', 'exactly 200: allowed');
select test.is(pg_temp.run($$select void_points('f0000000-0000-4000-8000-000000000003', 'Wrong kid')$$), 'ok', 'voids his own line');
select test.is(pg_temp.run($$select give_points(test.person('Taylor'), 1, 'One more', 'f0000000-0000-4000-8000-000000000004')$$),
               'P0001 That''s more than 200 points this week from you. A parent can give more.', 'a void doesn''t give the week''s room back');
:as_owner
set hub.now = '2026-11-09 17:30 America/New_York';   -- Monday: a new household week
:as_adult
select test.is(pg_temp.run($$select give_points(test.person('Taylor'), 200, 'New week', 'f0000000-0000-4000-8000-000000000005')$$), 'ok', 'a new week: 200 again');
:as_admin
select test.is(pg_temp.run($$select give_points(test.person('Taylor'), 200, 'From a parent', 'f0000000-0000-4000-8000-000000000006')$$), 'ok', 'a parent has no weekly limit');
select test.is(pg_temp.run($$select give_points(test.person('Taylor'), 200, 'And more', 'f0000000-0000-4000-8000-000000000007')$$), 'ok', '... none at all');
:as_owner
set hub.now = '2026-11-04 17:30 America/New_York';

-- The routine: the coach saves it, with its points as they are.
:as_adult
select test.is(pg_temp.run($$select save_routine(test.person('Taylor'), '[{"title": "Morning", "items": [{"title": "Make the bed"}]}]', 0)$$), 'ok',
               'writes the routine (points as they are: 0)');
select test.is((select count(*)::int from routine_items), 1, '... saved');
select test.is(pg_temp.run($$select save_routine(test.person('Taylor'), '[{"title": "Morning", "items": [{"title": "Make the bed"}]}]', 2)$$),
               '42501 Only a parent can change the routine''s points.', 'can''t change its points');
:as_admin
select test.is(pg_temp.run($$select save_routine(test.person('Taylor'), '[{"title": "Morning", "items": [{"title": "Make the bed"}]}]', 2)$$), 'ok', 'a parent sets 2 points');
:as_adult
select test.is(pg_temp.run($$select save_routine(test.person('Taylor'), '[{"title": "Morning", "items": [{"title": "Make the bed"}, {"title": "Brush teeth"}]}]', 2)$$), 'ok',
               'the coach changes the items, points still 2');
select test.is((select routine_points from homework_kids where kid_id = test.person('Taylor')), 2, '... points kept');

-- The AI planner (hub-jobs, as service_role, with the coach's email): a plan, never the parents' Test.
:as_service
select test.ok(homework_ai_start(null, 'sam@example.com', 'a0000000-0000-4000-8000-000000000001', 'plan', null, null, 'b0000000-0000-4000-8000-000000000001') ->> 'stop'
               is distinct from 'not_found', 'homework_ai_start takes the coach for a plan (the switch decides the rest)');
select test.is(homework_ai_start(null, 'sam@example.com', null, 'test', null, null, 'b0000000-0000-4000-8000-000000000002') ->> 'stop', 'not_found',
               '... never for Test');
select test.ok(homework_ai_start(null, 'alex@example.com', null, 'test', null, null, 'b0000000-0000-4000-8000-000000000003') ->> 'stop'
               is distinct from 'not_found', 'a parent''s Test as before');
select test.is(homework_ai_start(null, 'morgan@example.com', 'a0000000-0000-4000-8000-000000000001', 'plan', null, null, 'b0000000-0000-4000-8000-000000000004') ->> 'stop',
               'not_found', 'anyone else: not_found, as before');

-- ---------------------------------------------------------------------
-- What stays the parents'
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.gate($$select save_homework_kid(test.person('Taylor'), false)$$), 'parent-only', 'homework on or off');
select test.is(pg_temp.gate($$select add_homework_time(test.person('Taylor'), '{1,2,3}', '16:00', '17:00')$$), 'parent-only', 'homework time');
select test.is(pg_temp.gate($$select erase_homework(test.person('Taylor'), 'ERASE')$$), 'parent-only', 'Erase');
select test.is(pg_temp.gate($$select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true)$$), 'parent-only', 'tutor links');
select test.is(pg_temp.gate($$select set_tutor_coach('00000000-0000-4000-8000-000000000000', true)$$), 'parent-only', '... their coach view');
select test.is(pg_temp.gate($$select set_tutor_rewards('00000000-0000-4000-8000-000000000000', true)$$), 'parent-only', '... their rewards switch');
select test.is(pg_temp.gate($$select set_school_feed(test.person('Taylor'), 'assignments', 'https://school.example/feed.ics')$$), 'parent-only', 'school links');
select test.is(pg_temp.gate($$select pause_school_feed('00000000-0000-4000-8000-000000000000', true)$$), 'parent-only', '... pausing one');
select test.is(pg_temp.gate($$select check_school_feed('00000000-0000-4000-8000-000000000000', 'due', 0)$$), 'parent-only', '... Change dates');
select test.is(pg_temp.gate($$select coach_note_done('00000000-0000-4000-8000-000000000000')$$), 'parent-only', 'the tutor''s notes');
select test.is(pg_temp.gate($$select set_coach(test.person('Sam'), false)$$), 'parent-only', 'the box itself');
select test.is(pg_temp.gate($$select board_link('show')$$), 'parent-only', 'the family board''s link');
select test.is(pg_temp.gate($$select save_person('{"name": "Quinn", "role": "kid"}', false)$$), 'parent-only', 'the family list');
select test.is(pg_temp.run($$update homework_kids set pts_focus = 5 where kid_id = test.person('Taylor')$$), 'ok', 'a points value: the update runs...');
select test.is((select pts_focus from homework_kids where kid_id = test.person('Taylor')) <> 5, true, '... and changes nothing (row-level security)');
select test.is((select count(*)::int from tutor_links), 0, 'reads no tutor links');
select test.is((select count(*)::int from ai_runs), 0, 'nor the AI runs');
select test.is(pg_temp.gate($$update household set homework_ai = true$$), 'passes', 'the AI''s switch: the update runs...');
:as_owner
select test.is((select homework_ai from household), false, '... and changes nothing');

-- ---------------------------------------------------------------------
-- The box counts only while Sam is an active adult who can sign in
-- ---------------------------------------------------------------------
update people set role = 'helper' where name = 'Sam';
:as_adult
select test.is(can_coach(), false, 'Sam as a helper: not the coach (the box stays)');
:as_owner
update people set role = 'adult', active = false where name = 'Sam';
:as_adult
select test.is(can_coach(), false, 'inactive: not the coach');
:as_owner
update people set active = true where name = 'Sam';
:as_adult
select test.is(can_coach(), true, 'active again: the coach');
:as_admin
select set_coach(test.person('Sam'), false);
:as_adult
select test.is(can_coach(), false, 'box off: not the coach');
select test.is(pg_temp.gate($$select give_points(test.person('Taylor'), 5, 'x', 'f0000000-0000-4000-8000-000000000010')$$), 'parent-only', '... and refused again');
select test.is(pg_temp.gate($$select save_routine(test.person('Taylor'), '[]', 2)$$), 'parent-only', '... the routine too');
