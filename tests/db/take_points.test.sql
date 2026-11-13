-- Take points (migration 0028, docs/v1.3-homework.md §28): the other side of Give points. A parent or the coach takes 1
-- to 200 points with a reason he sees ('taken', a negative ledger row). Never below zero: only his free points (his
-- balance less what his waiting asks hold); more is refused and says how many are free. A coach takes at most 200 a
-- household week from a kid. A resent key writes nothing more. Refused while points are off. Grants, checks, his view.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (a kid), Morgan (a helper), Jordan (removed).
-- Everything is made up.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-13 17:00 America/New_York';
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated;
create function pg_temp.balance(p_kid uuid) returns int language sql stable security definer as $$
  select coalesce(sum(delta), 0)::int from public.points_ledger where kid_id = p_kid
$$;
grant execute on function pg_temp.balance(uuid) to anon, authenticated;
create function pg_temp.held(p_kid uuid) returns int language sql stable security definer as $$
  select coalesce(sum(cost), 0)::int from public.reward_asks where kid_id = p_kid and status = 'waiting'
$$;
grant execute on function pg_temp.held(uuid) to anon, authenticated;

:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
update homework_kids set points_on = true where kid_id = test.person('Taylor');
insert into points_ledger (kid_id, at, day, kind, delta, note, who)
values (test.person('Taylor'), now(), '2026-11-12', 'given', 100, 'Great week', 'alex@example.com');

-- ---------------------------------------------------------------------
-- The schema, the signature, its grants and the ledger's checks
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 28, 'hub_schema_version is 28');
select test.ok(has_function_privilege('authenticated', 'public.take_points(uuid, integer, text, uuid)', 'execute')
               and not has_function_privilege('anon', 'public.take_points(uuid, integer, text, uuid)', 'execute')
               and not has_function_privilege('service_role', 'public.take_points(uuid, integer, text, uuid)', 'execute'),
               'take_points: signed-in users only (it checks a parent or the coach itself)');
select test.ok((select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%' from pg_proc p where p.proname = 'take_points'),
               '... a definer, with set search_path');
select test.is(pg_temp.run($$insert into points_ledger (kid_id, at, day, kind, delta, note, who) values (test.person('Taylor'), now(), '2026-11-13', 'taken', 5, 'x', 'x')$$),
               '23514 new row for relation "points_ledger" violates check constraint "points_ledger_check"', 'a ''taken'' row is never positive');
select test.is(pg_temp.run($$insert into points_ledger (kid_id, at, day, kind, delta, note, who) values (test.person('Taylor'), now(), '2026-11-13', 'given', -5, 'x', 'x')$$),
               '23514 new row for relation "points_ledger" violates check constraint "points_ledger_check"', '... and a ''given'' one still never negative');

-- ---------------------------------------------------------------------
-- A parent takes
-- ---------------------------------------------------------------------
:as_admin
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 10, 'Phone at the dinner table', 'f2000000-0000-4000-8000-000000000001')$$), 'ok', 'Alex takes 10 with a reason');
:as_owner
select test.is((select kind || ' ' || delta || ' ' || note || ' ' || who || ' ' || day from points_ledger where id = 'f2000000-0000-4000-8000-000000000001'),
               'taken -10 Phone at the dinner table alex@example.com 2026-11-13', '... a ''taken'' row of −10, the reason, by Alex, today');
select test.is(pg_temp.balance(test.person('Taylor')), 90, '... 90 left');
:as_admin
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 10, 'Phone at the dinner table', 'f2000000-0000-4000-8000-000000000001')$$), 'ok', 'the same take sent again ...');
select test.is(pg_temp.balance(test.person('Taylor')), 90, '... takes nothing more');
select test.is((take_points(test.person('Taylor'), 10, 'Phone at the dinner table', 'f2000000-0000-4000-8000-000000000001') -> 'entry' ->> 'delta'), '-10', '... and answers the first entry');

-- The checks.
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 0, 'x', 'f2000000-0000-4000-8000-000000000002')$$), '22023 Take 1 to 200 points.', '0: refused');
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 201, 'x', 'f2000000-0000-4000-8000-000000000002')$$), '22023 Take 1 to 200 points.', '201: refused');
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 5, '   ', 'f2000000-0000-4000-8000-000000000002')$$), '22023 Say why the points come off.', 'no reason: refused');
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 5, repeat('x', 121), 'f2000000-0000-4000-8000-000000000002')$$), '22023 That''s too long.', 'a reason over 120: refused');
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 5, 'x', null)$$), '22023 Points need their id.', 'no key: refused');
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 5, 'x', (select id from points_ledger where kind = 'given' limit 1))$$), '22023 That id is taken.', 'a key of a given row: refused');

-- Never below zero, and never what his waiting asks hold.
:as_owner
insert into reward_asks (kid_id, title, cost, status, asked_at) values (test.person('Taylor'), 'Pizza night', 30, 'waiting', now());
:as_admin
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 61, 'x', 'f2000000-0000-4000-8000-000000000003')$$),
               'P0001 Only 60 points are free to take (the rest are spent or held for a reward he asked for).', '90 with 30 held: 61 refused, and it says 60 are free');
select test.is(pg_temp.balance(test.person('Taylor')), 90, '... nothing taken');
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 60, 'Late to bed', 'f2000000-0000-4000-8000-000000000003')$$), 'ok', 'all 60 free: fine');
select test.is(pg_temp.balance(test.person('Taylor')) || ' ' || pg_temp.held(test.person('Taylor')), '30 30', '... 30 left, all of it held for his ask');
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 1, 'x', 'f2000000-0000-4000-8000-000000000004')$$), 'P0001 There are no free points to take.', 'nothing free: refused');

-- Who: Sam (not the coach), a stranger and anon can't.
:as_adult
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 1, 'x', 'f2000000-0000-4000-8000-000000000005')$$), '42501 Only a parent can change homework.', 'Sam (not the coach): refused');
:as_stranger
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 1, 'x', 'f2000000-0000-4000-8000-000000000005')$$), '42501 Only a parent can change homework.', 'a stranger: refused');
:as_anon
select test.ok(pg_temp.run($$select take_points(test.person('Taylor'), 1, 'x', 'f2000000-0000-4000-8000-000000000005')$$) like '42501 permission denied%', 'anon: refused');

-- ---------------------------------------------------------------------
-- The coach: at most 200 a week from a kid
-- ---------------------------------------------------------------------
:as_admin
select set_coach(test.person('Sam'), true);
:as_owner
update reward_asks set status = 'cancelled' where kid_id = test.person('Taylor');
insert into points_ledger (kid_id, at, day, kind, delta, note, who)
values (test.person('Taylor'), now(), '2026-11-12', 'given', 900, 'Big week', 'alex@example.com');
:as_adult
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 150, 'Rude to his sister', 'f2000000-0000-4000-8000-000000000006')$$), 'ok', 'Sam (the coach) takes 150');
select test.is((select who from points_ledger where id = 'f2000000-0000-4000-8000-000000000006'), 'sam@example.com', '... written as Sam');
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 51, 'More', 'f2000000-0000-4000-8000-000000000007')$$),
               'P0001 That''s more than 200 points this week from you. A parent can take more.', '... 51 more this week: refused (201)');
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 50, 'More', 'f2000000-0000-4000-8000-000000000007')$$), 'ok', '... 50 more: fine (200)');
:as_admin
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 200, 'Parent', 'f2000000-0000-4000-8000-000000000008')$$), 'ok', 'a parent has no weekly limit');
:as_owner
set hub.now = '2026-11-16 17:00 America/New_York';
:as_adult
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 100, 'Next week', 'f2000000-0000-4000-8000-000000000009')$$), 'ok', 'a new week (Mon Nov 16): the coach may take again');

-- Points off: refused.
:as_owner
update homework_kids set points_on = false where kid_id = test.person('Taylor');
:as_admin
select test.is(pg_temp.run($$select take_points(test.person('Taylor'), 1, 'x', 'f2000000-0000-4000-8000-000000000010')$$), '42501 Points are off.', 'points off: refused');
:as_owner
update homework_kids set points_on = true where kid_id = test.person('Taylor');

-- ---------------------------------------------------------------------
-- His view: the taken rows, with their reasons
-- ---------------------------------------------------------------------
:as_anon
select test.ok((select bool_or(x ->> 'kind' = 'taken' and x ->> 'note' = 'Next week' and (x ->> 'delta')::int = -100)
                from jsonb_array_elements(homework_by_token(test.token('Taylor')) -> 'recent') x),
               'his My day''s recent points: "−100 · Next week", kind taken');
select test.is((homework_by_token(test.token('Taylor')) -> 'points' ->> 'balance')::int, pg_temp.balance(test.person('Taylor')), '... and his balance counts them');
