-- Take points on the tutor link (migration 0033, docs/v1.3-homework.md §33): coach_reward_by_token's 'take' action
-- ({points, note}) takes 1 to 200 points off the link's kid, with the reason he sees, as a 'taken' line written
-- "<label> (tutor link)". Only on a link whose coach view and Can manage rewards are on (else null and nothing
-- written); points on; never more than his free points (his balance less what his waiting asks hold); at most 200 a
-- household week taken through tutor links; once per key. Every other action is 0012's, unchanged. The coach view's
-- manage gains take: true and free.
-- The household is fixtures.sql's: Alex (admin), Taylor (the kid with homework). The tutor is only a link's label,
-- "Pat Lee, tutor". hub.now is Wed Nov 4, 2026, 5:30pm (America/New_York): this household week is Mon Nov 2 to Sun Nov 8.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-04 17:30 America/New_York';
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
create function pg_temp.act(p_label text, p_action text, p_key uuid, p_fields jsonb) returns text language plpgsql as $$
declare v jsonb;
begin
  v := public.coach_reward_by_token(pg_temp.token(p_label), p_action, p_key, p_fields);
  if v is null then
    return 'null';
  end if;
  return 'ok ' || (v ->> 'changed');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.act(text, text, uuid, jsonb) to anon;
create function pg_temp.free() returns text language sql stable as $$
  select (public.coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'manage' ->> 'free')
$$;
grant execute on function pg_temp.free() to anon;

select test.is(hub_schema_version(), 39, 'hub_schema_version is 39');

:as_admin
select save_homework_kid(test.person('Taylor'), true);
select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true);
select set_tutor_coach(pg_temp.lid('Pat Lee, tutor'), true);
:as_owner
-- 20 + 300 - 15 = 305, and his waiting ask holds 200: 105 free.
insert into points_ledger (id, kid_id, at, day, kind, delta, note, who) values
  ('c0000000-0000-4000-8000-000000000001', test.person('Taylor'), '2026-11-02 21:50+00', '2026-11-02', 'focus', 20, 'Find 2 sources', 'Taylor (My day)'),
  ('c0000000-0000-4000-8000-000000000002', test.person('Taylor'), '2026-11-03 21:50+00', '2026-11-03', 'given', 300, 'Starting points', 'alex@example.com'),
  ('c0000000-0000-4000-8000-000000000004', test.person('Taylor'), '2026-11-04 18:00+00', '2026-11-04', 'trade', -15, 'Extra game time', 'Taylor (My day)');
insert into rewards (id, kid_id, title, cost, active, instant, suggested, sort_order) values
  ('d0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'Pick the movie', 200, true, false, false, 2);
insert into reward_asks (id, kid_id, reward_id, title, cost, status, asked_at) values
  ('e0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'd0000000-0000-4000-8000-000000000002', 'Pick the movie', 200, 'waiting', '2026-11-03 21:00+00');

-- ---------------------------------------------------------------------
-- Off: Can manage rewards off, so nothing
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 5, "note": "Phone at the table"}'), 'null',
               'coach view on, rewards off: take answers null');
select test.ok(not (coalesce(coach_view_by_token(pg_temp.token('Pat Lee, tutor')), '{}') ? 'manage'), '... and the coach view has no manage, so no take or free');
:as_owner
select test.is((select count(*) from points_ledger where kind = 'taken')::int, 0, '... and nothing was taken');

-- ---------------------------------------------------------------------
-- On: manage says take, and how many are free
-- ---------------------------------------------------------------------
:as_admin
select set_tutor_rewards(pg_temp.lid('Pat Lee, tutor'), true);
:as_anon
select test.is((coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'manage' ->> 'take'), 'true', 'rewards on: manage has take: true');
select test.is(pg_temp.free(), '105', '... and free: 305 less the 200 his ask holds');
:as_owner
select test.is(private.coach_view_v32(pg_temp.lid('Pat Lee, tutor')),
               (private.coach_view(pg_temp.lid('Pat Lee, tutor')) #- '{manage,take}'::text[] #- '{manage,free}'::text[]) - 'week'::text, '... and otherwise exactly 0032''s coach view (0034 adds week)');

-- ---------------------------------------------------------------------
-- What it refuses
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 0, "note": "x"}'), '22023 Take 1 to 200 points.', 'zero points');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 201, "note": "x"}'), '22023 Take 1 to 200 points.', 'over 200');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": "5", "note": "x"}'), '22023 Take 1 to 200 points.', 'points as text');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 5}'), '22023 Say why the points come off.', 'no reason');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 5, "note": "   "}'), '22023 Say why the points come off.', 'a blank reason');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', jsonb_build_object('points', 5, 'note', repeat('x', 121))), '22023 That''s too long.', 'a reason over 120');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', null, '{"points": 5, "note": "x"}'), '22023 That needs its id.', 'no key');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '[1]'), '22023 That can''t be saved.', 'fields not an object');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'c0000000-0000-4000-8000-000000000002', '{"points": 5, "note": "x"}'), '22023 That id is taken.', 'the key of a line that isn''t a take');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 106, "note": "x"}'),
               'P0001 Only 105 points are free to take (the rest are spent or held for a reward he asked for).', 'more than his free points');
select test.is(public.coach_reward_by_token('not-a-real-token-at-all-000000000000', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 5, "note": "x"}'), null,
               'an unknown token: null');
:as_owner
select test.is((select count(*) from points_ledger where kind = 'taken')::int, 0, '... none of those took anything');
select test.is(pg_temp.writes('Pat Lee, tutor'), 0, '... nor counted as one of the link''s writes');

-- ---------------------------------------------------------------------
-- A take
-- ---------------------------------------------------------------------
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 30, "note": "  Phone at\nthe table "}'), 'ok true', '30 points taken');
:as_owner
select test.is((select kind || ' ' || delta || ' ' || note || ' ' || who || ' ' || day from points_ledger where id = 'f0000000-0000-4000-8000-000000000001'),
               'taken -30 Phone at the table Pat Lee, tutor (tutor link) 2026-11-04', '... a taken line, the reason cleaned, as the link, today');
select test.is(pg_temp.balance(test.person('Taylor')), 275, '... his balance 305 - 30');
select test.is(pg_temp.writes('Pat Lee, tutor'), 1, '... one of the link''s writes');
:as_anon
select test.is(pg_temp.free(), '75', '... and 75 free now');
select test.ok((select (coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'manage' -> 'lines' -> 0 ->> 'kind') = 'taken'), '... first in his lines');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 30, "note": "Phone at the table"}'), 'ok false', 'sent again with its key: no change');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000001', '{"points": 999}'), 'ok false', '... whatever the fields say');
:as_owner
select test.is(pg_temp.balance(test.person('Taylor')), 275, '... still 275');
select test.is(pg_temp.writes('Pat Lee, tutor'), 1, '... and still one write');

-- ---------------------------------------------------------------------
-- 200 a household week through tutor links (apart from giving), never below free
-- ---------------------------------------------------------------------
:as_owner
insert into points_ledger (id, kid_id, at, day, kind, delta, note, who) values
  ('c0000000-0000-4000-8000-000000000005', test.person('Taylor'), '2026-11-04 19:00+00', '2026-11-04', 'given', 400, 'More', 'alex@example.com'),
  -- Last week's take through a link and a parent's this week don't count.
  ('c0000000-0000-4000-8000-000000000006', test.person('Taylor'), '2026-10-30 19:00+00', '2026-10-30', 'taken', -150, 'Last week', 'Pat Lee, tutor (tutor link)'),
  ('c0000000-0000-4000-8000-000000000007', test.person('Taylor'), '2026-11-04 19:10+00', '2026-11-04', 'taken', -150, 'A parent', 'alex@example.com');
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'give', 'f0000000-0000-4000-8000-000000000009', '{"points": 50, "note": "Nice"}'), 'ok true', 'giving still works (0012''s action)');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000002', '{"points": 171, "note": "x"}'),
               'P0001 That''s more than 200 points this week taken through the tutor link. A parent can take more.', '30 + 171 is over 200 this week');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000002', '{"points": 170, "note": "Late again"}'), 'ok true', '30 + 170 is 200: allowed');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000003', '{"points": 1, "note": "x"}'),
               'P0001 That''s more than 200 points this week taken through the tutor link. A parent can take more.', '... and then not one more');
:as_owner
select test.is(pg_temp.balance(test.person('Taylor')), 275 + 400 - 150 - 150 + 50 - 170, '... his balance');
-- No free points: his balance less what his asks hold.
update points_ledger set delta = -1000 where id = 'c0000000-0000-4000-8000-000000000007';
set hub.now = '2026-11-10 17:30 America/New_York';
:as_anon
select test.is(pg_temp.free(), '0', 'spent or held: 0 free, never below');
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000003', '{"points": 1, "note": "x"}'),
               'P0001 There are no free points to take.', 'nothing free: refused');
:as_owner
update points_ledger set delta = -150 where id = 'c0000000-0000-4000-8000-000000000007';
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000003', '{"points": 5, "note": "New week"}'), 'ok true', 'a new week: the link may take again');

-- ---------------------------------------------------------------------
-- Points off, or the switch off: nothing
-- ---------------------------------------------------------------------
:as_owner
update homework_kids set points_on = false where kid_id = test.person('Taylor');
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000004', '{"points": 5, "note": "x"}'), '42501 Points are off.', 'points off: refused');
:as_owner
update homework_kids set points_on = true where kid_id = test.person('Taylor');
:as_admin
select set_tutor_rewards(pg_temp.lid('Pat Lee, tutor'), false);
:as_anon
select test.is(pg_temp.act('Pat Lee, tutor', 'take', 'f0000000-0000-4000-8000-000000000004', '{"points": 5, "note": "x"}'), 'null', 'the switch off again: null');
:as_owner
select test.is((select count(*) from points_ledger where id = 'f0000000-0000-4000-8000-000000000004')::int, 0, '... and nothing written');

-- ---------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------
select test.ok(has_function_privilege('anon', 'public.coach_reward_by_token(text, text, uuid, jsonb)', 'execute'), 'anon may call coach_reward_by_token');
select test.ok(has_function_privilege('authenticated', 'public.coach_reward_by_token(text, text, uuid, jsonb)', 'execute'), '... and authenticated');
select test.ok(not has_function_privilege('anon', 'private.coach_reward_by_token_v32(text, text, uuid, jsonb)', 'execute'), 'anon can''t call 0012''s, moved');
select test.ok(not has_function_privilege('authenticated', 'private.coach_reward_by_token_v32(text, text, uuid, jsonb)', 'execute'), '... nor authenticated');
select test.ok(not has_function_privilege('anon', 'private.coach_view(uuid)', 'execute'), 'anon can''t call private.coach_view');
select test.is((select p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'public.coach_reward_by_token(text, text, uuid, jsonb)'::regprocedure),
               'true search_path=""', 'coach_reward_by_token is security definer with an empty search_path');
select test.is((select array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'private.coach_view(uuid)'::regprocedure), 'search_path=""', '... and coach_view''s is empty');
