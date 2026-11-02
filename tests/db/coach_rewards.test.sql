-- The coach's rewards (migration 0012, docs/v1.3-homework.md §22): a per-link switch, tutor_links.rewards, off by
-- default and set only by the parents (set_tutor_rewards). It counts only while the link's coach view is on too. With
-- either off nothing changes for the link (its coach view as 0007's, and coach_reward_by_token answers null and writes
-- nothing). With both on, the coach view adds manage (ids for his rewards, his waiting asks and the ledger lines), and
-- coach_reward_by_token saves, prices, retires and removes rewards, decides asks, gives points (at most 200 a household
-- week through tutor links) and voids them, each as the parents' own, written as "<label> (tutor link)". Nothing of
-- another kid's.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (the kid with homework); plus Robin, a second kid.
-- The tutor is only a link's label, "Pat Lee, tutor". hub.now is Wed Nov 4, 2026, 5:30pm (America/New_York): this
-- household week is Mon Nov 2 to Sun Nov 8.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-04 17:30 America/New_York';
insert into people (name, role, sort_order) values ('Robin', 'kid', 5);
create function pg_temp.token(p_label text) returns text language sql stable security definer as $$
  select token from public.tutor_links where label = p_label
$$;
create function pg_temp.lid(p_label text) returns uuid language sql stable security definer as $$
  select id from public.tutor_links where label = p_label
$$;
create function pg_temp.writes(p_label text) returns int language sql stable security definer as $$
  select coalesce(sum(n), 0)::int from public.homework_use
  where actor_id = (select id from public.tutor_links where label = p_label) and what = 'writes'
$$;
create function pg_temp.balance(p_kid uuid) returns int language sql stable security definer as $$
  select balance from private.points_balance(p_kid)
$$;
create function pg_temp.reward(p_id uuid) returns text language sql stable security definer as $$
  select title || ' ' || coalesce(cost::text, '-') || ' ' || active || ' ' || instant || ' ' || coalesce(updated_by, '-') from public.rewards where id = p_id
$$;
-- What a link may do now: the call's error, or 'ok'.
create function pg_temp.act(p_label text, p_action text, p_key uuid, p_fields jsonb) returns text language plpgsql as $$
begin
  if public.coach_reward_by_token(pg_temp.token(p_label), p_action, p_key, p_fields) is null then
    return 'null';
  end if;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.act(text, text, uuid, jsonb) to anon;

:as_admin
select save_homework_kid(test.person('Taylor'), true);
select save_homework_kid(test.person('Robin'), true);
select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true);
select save_tutor_link(null, test.person('Robin'), 'Riley, tutor', 'en', null, false, true);
select set_tutor_coach(pg_temp.lid('Pat Lee, tutor'), true);
:as_owner
insert into points_ledger (id, kid_id, at, day, kind, delta, note, who) values
  ('c0000000-0000-4000-8000-000000000001', test.person('Taylor'), '2026-11-02 21:50+00', '2026-11-02', 'focus', 20, 'Find 2 sources', 'Taylor (My day)'),
  ('c0000000-0000-4000-8000-000000000002', test.person('Taylor'), '2026-11-03 21:50+00', '2026-11-03', 'given', 300, 'Starting points', 'alex@example.com'),
  ('c0000000-0000-4000-8000-000000000003', test.person('Robin'), '2026-11-03 18:00+00', '2026-11-03', 'given', 50, 'Robin''s points', 'alex@example.com'),
  ('c0000000-0000-4000-8000-000000000004', test.person('Taylor'), '2026-11-04 18:00+00', '2026-11-04', 'trade', -15, 'Extra game time', 'Taylor (My day)');
insert into rewards (id, kid_id, title, cost, active, instant, suggested, sort_order) values
  ('d0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'Extra game time', 15, true, true, false, 1),
  ('d0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'Pick the movie', 200, true, false, false, 2),
  ('d0000000-0000-4000-8000-000000000003', test.person('Taylor'), 'Skip a chore', null, false, false, true, 3),
  ('d0000000-0000-4000-8000-000000000004', test.person('Taylor'), 'Late bedtime', null, false, false, true, 4),
  ('d0000000-0000-4000-8000-000000000005', test.person('Robin'), 'Robin''s prize', 30, true, false, false, 1);
insert into reward_asks (id, kid_id, reward_id, title, cost, status, asked_at) values
  ('e0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'd0000000-0000-4000-8000-000000000002', 'Pick the movie', 200, 'waiting', '2026-11-03 21:00+00'),
  ('e0000000-0000-4000-8000-000000000003', test.person('Robin'), 'd0000000-0000-4000-8000-000000000005', 'Robin''s prize', 30, 'waiting', '2026-11-03 21:00+00');

-- ---------------------------------------------------------------------
-- Off: the switch is off by default, and counts only with the coach view on
-- ---------------------------------------------------------------------
select test.is((select string_agg(label || ' ' || rewards, ', ' order by label) from tutor_links), 'Pat Lee, tutor false, Riley, tutor false',
               'every link starts with the rewards switch off');
:as_anon
create temp table v7 as select coach_view_by_token(pg_temp.token('Pat Lee, tutor')) as v;
select test.ok((select v from v7) is not null and not ((select v from v7) ? 'manage'), 'coach view on, rewards off: the coach view has no manage');
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000001', '{"points": 5, "note": "Nice"}'), 'null',
               '... and coach_reward_by_token answers null');
:as_owner
select test.is((select v from v7), private.coach_view_v7(pg_temp.lid('Pat Lee, tutor')), 'with the switch off, the coach view is exactly 0007''s');
select test.is((select count(*) from points_ledger where id = 'f0000000-0000-4000-8000-000000000001')::int, 0, '... and wrote nothing');
-- The switch alone, coach view off: still nothing.
:as_admin
select set_tutor_rewards(pg_temp.lid('Pat Lee, tutor'), true);
select set_tutor_coach(pg_temp.lid('Pat Lee, tutor'), false);
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000001', '{"points": 5, "note": "Nice"}'), 'null',
               'rewards on, coach view off: null');
select test.is(coach_view_by_token(pg_temp.token('Pat Lee, tutor')), null, '... and no coach view');
:as_admin
select set_tutor_coach(pg_temp.lid('Pat Lee, tutor'), true);

-- ---------------------------------------------------------------------
-- Who sets the switch
-- ---------------------------------------------------------------------
:as_adult
select test.throws($$select set_tutor_rewards(pg_temp.lid('Pat Lee, tutor'), false)$$, 'Only a parent can change homework.', 'an adult can''t set the switch');
:as_anon
select test.throws($$select set_tutor_rewards(pg_temp.lid('Pat Lee, tutor'), false)$$, 'permission denied', 'anon can''t call set_tutor_rewards');
:as_admin
select test.throws($$select set_tutor_rewards(pg_temp.lid('Pat Lee, tutor'), null)$$, 'Choose on or off.', 'null: "Choose on or off."');
select test.throws($$select set_tutor_rewards('00000000-0000-4000-8000-000000000000', true)$$, 'That link is gone.', 'an unknown link: "That link is gone."');

-- ---------------------------------------------------------------------
-- On: the coach view's manage
-- ---------------------------------------------------------------------
:as_anon
create temp table v12 as select coach_view_by_token(pg_temp.token('Pat Lee, tutor')) as v;
select test.is((select v - 'manage' from v12), (select v from v7), 'switch on: everything 0007 had is unchanged');
select test.is((select string_agg(k, ',' order by k) from v12, jsonb_object_keys(v -> 'manage') k), 'asks,instant_day,lines,points_on,rewards',
               '... plus manage: asks, instant_day, lines, points_on, rewards');
select test.is((select string_agg(x ->> 'title' || ' ' || (x ->> 'active'), ', ' order by n) from v12, jsonb_array_elements(v -> 'manage' -> 'rewards') with ordinality t (x, n)),
               'Extra game time true, Pick the movie true, Skip a chore false, Late bedtime false',
               '... his rewards, the suggestions nobody priced too; never Robin''s');
select test.is((select string_agg(x ->> 'id' || ' ' || (x ->> 'title'), ', ') from v12, jsonb_array_elements(v -> 'manage' -> 'asks') x),
               'e0000000-0000-4000-8000-000000000001 Pick the movie', '... his waiting ask with its id; never Robin''s');
select test.is((select string_agg(x ->> 'kind' || ' ' || (x ->> 'delta') || ' ' || (x ->> 'voided'), ', ' order by n) from v12, jsonb_array_elements(v -> 'manage' -> 'lines') with ordinality t (x, n)),
               'trade -15 false, given 300 false, focus 20 false', '... his ledger lines with ids, newest first, none voided yet');
select test.ok(not (select (v -> 'manage')::text ~ '(alex|sam)@example\.com|Robin' from v12), '... and never who wrote a line, nor Robin');

-- ---------------------------------------------------------------------
-- save_reward and remove_reward
-- ---------------------------------------------------------------------
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000010', '{"title": "  Pizza\nnight ", "cost": 150, "instant": false}'), 'ok', 'a new reward');
select test.is(pg_temp.reward('d0000000-0000-4000-8000-000000000010'), 'Pizza night 150 true false Pat Lee, tutor (tutor link)', '... cleaned, on his list, by the link');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000010', '{"title": "Pizza night", "cost": 150, "instant": false}'), 'ok', 'the same again (a resend)');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000002', '{"cost": 180}'), 'ok', 'a new price');
select test.is(pg_temp.reward('d0000000-0000-4000-8000-000000000002'), 'Pick the movie 180 true false Pat Lee, tutor (tutor link)', '... changed');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000003', '{"cost": 40, "active": true}'), 'ok', 'his suggestion priced');
select test.is(pg_temp.reward('d0000000-0000-4000-8000-000000000003'), 'Skip a chore 40 true false Pat Lee, tutor (tutor link)', '... and on his list');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000001', '{"active": false}'), 'ok', 'a reward retired');
select test.is(pg_temp.reward('d0000000-0000-4000-8000-000000000001'), 'Extra game time 15 false true Pat Lee, tutor (tutor link)', '... off his list, kept');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000011', '{"title": "", "cost": 5}'), '22023 A reward needs a name.', 'no title');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000011', '{"title": "Too much", "cost": 10001}'), '22023 A reward costs 1 to 10000 points.', 'too dear');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000011', '{"title": "Free", "cost": 0}'), '22023 A reward costs 1 to 10000 points.', 'free');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000011', '{"title": "No price"}'), '22023 A reward on his list needs a price.', 'no price');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000011', jsonb_build_object('title', repeat('x', 61), 'cost', 5)), '22023 That''s too long.', 'a title over 60');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000011', '{"title": "Odd", "cost": "lots"}'), '22023 A reward costs 1 to 10000 points.', 'a cost that isn''t a number');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000005', '{"cost": 1}'), '42501 That reward isn''t on this link.', 'Robin''s reward: refused');
select test.is(pg_temp.act('Pat Lee, tutor', 'remove_reward', 'd0000000-0000-4000-8000-000000000002', '{}'), '22023 Only his suggestion can be deleted. Take a reward off his list instead.',
               'a priced reward can''t be deleted');
select test.is(pg_temp.act('Pat Lee, tutor', 'remove_reward', 'd0000000-0000-4000-8000-000000000005', '{}'), '42501 That reward isn''t on this link.', 'Robin''s: refused');
select test.is(pg_temp.act('Pat Lee, tutor', 'remove_reward', 'd0000000-0000-4000-8000-000000000004', '{}'), 'ok', 'an unpriced suggestion deleted');
select test.is(pg_temp.act('Pat Lee, tutor', 'remove_reward', 'd0000000-0000-4000-8000-000000000004', '{}'), 'ok', '... a resend changes nothing');
:as_owner
select test.is((select count(*) from rewards where id = 'd0000000-0000-4000-8000-000000000004')::int || ' ' || pg_temp.reward('d0000000-0000-4000-8000-000000000005'),
               '0 Robin''s prize 30 true false -', '... gone; Robin''s untouched');

-- ---------------------------------------------------------------------
-- decide
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'decide', 'e0000000-0000-4000-8000-000000000003', '{"approve": true}'), '42501 That ask isn''t on this link.', 'Robin''s ask: refused');
select test.is(pg_temp.act('Pat Lee, tutor', 'decide', 'e0000000-0000-4000-8000-000000000009', '{"approve": true}'), '22023 That ask is gone.', 'an unknown ask');
select test.is(pg_temp.act('Pat Lee, tutor', 'decide', 'e0000000-0000-4000-8000-000000000001', '{}'), '22023 Choose Yes or Not now.', 'neither');
select test.is(pg_temp.act('Pat Lee, tutor', 'decide', 'e0000000-0000-4000-8000-000000000001', '{"approve": true}'), 'ok', 'Yes on his ask (305 points, 200 asked)');
:as_owner
select test.is((select status || ' ' || decided_by from reward_asks where id = 'e0000000-0000-4000-8000-000000000001') || ' ' || pg_temp.balance(test.person('Taylor')),
               'approved Pat Lee, tutor (tutor link) 105', '... approved by the link, the points traded');
select test.is((select status from reward_asks where id = 'e0000000-0000-4000-8000-000000000003'), 'waiting', '... Robin''s still waiting');
insert into reward_asks (id, kid_id, reward_id, title, cost, status, asked_at) values
  ('e0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'd0000000-0000-4000-8000-000000000010', 'Pizza night', 150, 'waiting', '2026-11-04 21:00+00');
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'decide', 'e0000000-0000-4000-8000-000000000002', '{"approve": true}'), '42501 Not enough points yet.', 'Yes with 105 for 150: "Not enough points yet."');
select test.is(pg_temp.act('Pat Lee, tutor', 'decide', 'e0000000-0000-4000-8000-000000000002', '{"approve": false, "note": "After the test"}'), 'ok', 'Not now, with a word');
:as_owner
select test.is((select status || ' ' || note || ' ' || decided_by from reward_asks where id = 'e0000000-0000-4000-8000-000000000002'),
               'declined After the test Pat Lee, tutor (tutor link)', '... declined, with the word');

-- ---------------------------------------------------------------------
-- give: 1 to 200, a note, and at most 200 a household week through tutor links
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000001', '{"points": 0, "note": "Nice"}'), '22023 Give 1 to 200 points.', 'zero points');
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000001', '{"points": 201, "note": "Nice"}'), '22023 Give 1 to 200 points.', 'over 200');
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000001', '{"points": 20}'), '22023 Say what the points are for.', 'no note');
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000001', '{"points": 150, "note": "Great focus"}'), 'ok', '150 points with a note');
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000001', '{"points": 150, "note": "Great focus"}'), 'ok', '... a resend');
:as_owner
select test.is((select count(*) || ' ' || sum(delta) || ' ' || min(who) || ' ' || min(note) from points_ledger where id = 'f0000000-0000-4000-8000-000000000001'),
               '1 150 Pat Lee, tutor (tutor link) Great focus', '... written once, by the link');
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000002', '{"points": 51, "note": "More"}'),
               'P0001 That''s more than 200 points this week from the tutor link. A parent can give more.', '51 more this week: over the 200 cap');
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000002', '{"points": 50, "note": "More"}'), 'ok', '... 50 more: exactly 200');
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'c0000000-0000-4000-8000-000000000003', '{"points": 5, "note": "Hi"}'), '22023 That id is taken.', 'another kid''s line''s id: taken');
:as_anon
select test.ok(pg_temp.writes('Pat Lee, tutor') between 8 and 20, 'each change is one of the link''s writes (' || pg_temp.writes('Pat Lee, tutor') || ' so far)');
:as_admin
select give_points(test.person('Taylor'), 200, 'A parent''s points don''t count', gen_random_uuid());
:as_owner
-- Next week the cap starts again.
set hub.now = '2026-11-09 17:30 America/New_York';
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000003', '{"points": 200, "note": "New week"}'), 'ok',
               'next Monday: 200 again (a parent''s 200 last week never counted)');
:as_owner
set hub.now = '2026-11-04 17:30 America/New_York';
update homework_kids set points_on = false where kid_id = test.person('Taylor');
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000004', '{"points": 5, "note": "Hi"}'), '42501 Points are off.', 'points off: refused');
:as_owner
update homework_kids set points_on = true where kid_id = test.person('Taylor');

-- ---------------------------------------------------------------------
-- void
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'void', 'c0000000-0000-4000-8000-000000000001', '{}'), '22023 Say why.', 'no reason');
select test.is(pg_temp.act('Pat Lee, tutor', 'void', 'c0000000-0000-4000-8000-000000000003', '{"note": "Oops"}'), '42501 Those points aren''t on this link.', 'Robin''s line: refused');
select test.is(pg_temp.act('Pat Lee, tutor', 'void', 'c0000000-0000-4000-8000-000000000004', '{"note": "Oops"}'), '22023 Only earned or given points can be voided.', 'a trade can''t be voided');
select test.is(pg_temp.act('Pat Lee, tutor', 'void', 'c0000000-0000-4000-8000-000000000001', '{"note": "Counted twice"}'), 'ok', 'a focus line voided');
select test.is(pg_temp.act('Pat Lee, tutor', 'void', 'c0000000-0000-4000-8000-000000000001', '{"note": "Counted twice"}'), 'ok', '... a second time changes nothing');
:as_owner
select test.is((select count(*) || ' ' || sum(delta) || ' ' || min(who) || ' ' || min(note) from points_ledger where void_of = 'c0000000-0000-4000-8000-000000000001'),
               '1 -20 Pat Lee, tutor (tutor link) Counted twice', '... one void, by the link, with the reason');
:as_anon
select test.ok((select (x ->> 'voided')::boolean from jsonb_array_elements(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'manage' -> 'lines') x
                where x ->> 'id' = 'c0000000-0000-4000-8000-000000000001'), '... and the coach view marks it voided');
:as_owner
select test.is((select string_agg(kind || ' ' || delta, ', ' order by at) from points_ledger where kid_id = test.person('Robin')), 'given 50', 'Robin''s points untouched');

-- ---------------------------------------------------------------------
-- Errors never carry a row; bad input; the write count; a bad token
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'steal', 'f0000000-0000-4000-8000-000000000009', '{}'), '22023 That can''t be done here.', 'an unknown action');
select test.is(pg_temp.act('Pat Lee, tutor', 'give', null, '{"points": 5, "note": "x"}'), '22023 That needs its id.', 'no id');
select test.is(pg_temp.act('Pat Lee, tutor', 'decide', 'e0000000-0000-4000-8000-000000000002', '{"approve": "maybe"}'), '22023 Choose Yes or Not now.', 'a Yes that isn''t a yes or no');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000010', '{"instant": "maybe"}'), '22023 That can''t be saved.', 'an instant that isn''t a yes or no');
select test.is(pg_temp.act('Pat Lee, tutor', 'save_reward', 'd0000000-0000-4000-8000-000000000012', '[1]'), '22023 That can''t be saved.', 'fields that aren''t an object');
select test.is(coach_reward_by_token('not-a-token', 'give', gen_random_uuid(), '{"points": 5, "note": "x"}'), null, 'a malformed token: null');
select test.is(coach_reward_by_token(test.token('Taylor'), 'give', gen_random_uuid(), '{"points": 5, "note": "x"}'), null, 'his My day token: null');
select test.is(pg_temp.act('Riley, tutor', 'give', gen_random_uuid(), '{"points": 5, "note": "x"}'), 'null', 'Robin''s link (no coach view, no switch): null');
:as_admin
select save_tutor_link(pg_temp.lid('Pat Lee, tutor'), test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, false);
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'give', gen_random_uuid(), '{"points": 5, "note": "x"}'), 'null', 'the link off: null');

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
:as_owner
select test.is((select string_agg(p.oid::regprocedure::text || ' ' || r, ', ' order by p.oid::regprocedure::text, r)
                from pg_proc p cross join unnest(array['anon', 'authenticated', 'service_role']) r
                where p.proname in ('coach_reward_by_token', 'set_tutor_rewards', 'coach_view', 'coach_view_v7')
                  and has_function_privilege(r, p.oid, 'execute')),
               'coach_reward_by_token(text,text,uuid,jsonb) anon, coach_reward_by_token(text,text,uuid,jsonb) authenticated, set_tutor_rewards(uuid,boolean) authenticated',
               'who may call what: the token function anon and signed in; the parents'' setter signed in; the coach views nobody');
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.proname in ('coach_reward_by_token', 'set_tutor_rewards') and not p.prosecdef), null, 'both are SECURITY DEFINER');
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.proname in ('coach_reward_by_token', 'set_tutor_rewards', 'coach_view', 'coach_view_v7')
                  and not coalesce(p.proconfig, '{}') @> '{"search_path=\"\""}'), null, '... and every one sets search_path = ''''');
select test.is((select string_agg(a.attname, ', ') from pg_attribute a
                where a.attrelid = 'public.tutor_links'::regclass and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege('authenticated', 'public.tutor_links', a.attname, 'update')), null,
               'tutor_links: still no column signed-in users may update');
