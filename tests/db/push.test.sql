-- Phone reminders (migration 0031, docs/v1.3-homework.md §31): a kid with homework on turns reminders on from his My
-- day (push_by_token), which keeps his phone's push address and keys in public.push_subscriptions (nobody signed in or
-- out reads it). Every day from household.push_at (null: off) push_due names each such kid once; hub-jobs claims it
-- (push_claim, channel 'push'), reads his phones (push_targets) and says what each push service answered (push_result).
-- Settings lists who turned them on (push_people, admins).
-- The household is fixtures.sql's (all made up): Alex (admin), Sam (adult), Taylor (a kid), Morgan (a helper).
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-13 15:00 America/New_York';   -- a Friday
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated, service_role;
create function pg_temp.tok(p_name text) returns text language sql stable security definer as $$
  select day_token from public.people where name like p_name || '%'
$$;
grant execute on function pg_temp.tok(text) to anon, authenticated, service_role;
create function pg_temp.phones() returns text language sql stable security definer as $$
  select coalesce(string_agg((select name from public.people p where p.id = s.person_id) || ' ' || right(s.endpoint, 4) || ' ' || s.fails, ', '
                             order by s.created_at, s.endpoint), '')
  from public.push_subscriptions s
$$;
grant execute on function pg_temp.phones() to anon, authenticated, service_role;
create function pg_temp.due() returns text language sql volatile as $$
  select coalesce(string_agg((select name from public.people where id = d.person_id) || ' ' || d.kind || ' ' || d.local_date, ', '
                             order by d.person_id), '')
  from public.push_due(50) d
$$;
grant execute on function pg_temp.due() to service_role;
-- A phone's address and keys, as a browser gives them (made up, in the right shapes).
\set apple1 'https://web.push.apple.com/QGuYzA1b2C3d4E5f6G7h8Ia001'
\set apple2 'https://web.push.apple.com/QGuYzA1b2C3d4E5f6G7h8Ia002'
\set apple3 'https://web.push.apple.com/QGuYzA1b2C3d4E5f6G7h8Ia003'
\set apple4 'https://web.push.apple.com/QGuYzA1b2C3d4E5f6G7h8Ia004'
\set key 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
\set auth 'tBHItJI5svbpez7KI4CCXg'

-- ---------------------------------------------------------------------
-- The table, the column, the functions and their grants
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 31, 'hub_schema_version is 31');
select test.ok((select relrowsecurity from pg_class where oid = 'public.push_subscriptions'::regclass)
               and not exists (select 1 from pg_policies where tablename = 'push_subscriptions'),
               'push_subscriptions: RLS on, no policies');
select test.ok(not has_table_privilege('anon', 'public.push_subscriptions', 'select')
               and not has_table_privilege('authenticated', 'public.push_subscriptions', 'select')
               and not has_table_privilege('authenticated', 'public.push_subscriptions', 'insert'),
               '... nobody signed in or out reads or writes it');
select test.is((select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.household'::regclass and attname = 'push_at'),
               'time without time zone', 'household.push_at: a time');
select test.ok((select push_at is null from public.household), '... null for the household: off');
select test.ok(has_function_privilege('anon', 'public.push_by_token(text, text, text, text, text)', 'execute')
               and not has_function_privilege('service_role', 'public.push_by_token(text, text, text, text, text)', 'execute'),
               'push_by_token: anon (My day), not the job');
select test.ok(has_function_privilege('authenticated', 'public.push_people()', 'execute') and not has_function_privilege('anon', 'public.push_people()', 'execute'),
               'push_people: signed in only');
select test.ok((select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute')
                                and not has_function_privilege('anon', f, 'execute'))
                from unnest(array['public.push_due(integer)', 'public.push_claim(uuid, date)', 'public.push_targets(uuid)', 'public.push_result(text, text)']) f),
               'push_due, push_claim, push_targets, push_result: service_role only');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%')
                from pg_proc p where p.proname in ('push_by_token', 'push_people', 'push_due', 'push_claim', 'push_targets', 'push_result')),
               '... each with set search_path');

-- ---------------------------------------------------------------------
-- His My day
-- ---------------------------------------------------------------------
:as_anon
select test.is(push_by_token(pg_temp.tok('Taylor'), 'status'), null, 'homework off: push_by_token answers null (nothing to show)');
:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_anon
select test.is(push_by_token(pg_temp.tok('Taylor'), 'status')::text, '{"at": null, "on": false}', 'homework on: status, off, no time set yet');
select test.is(push_by_token(pg_temp.tok('Morgan'), 'status'), null, 'Morgan (a helper): null');
select test.is(push_by_token('0123456789abcdef0123456789abcdef', 'status'), null, 'a code that isn''t anyone''s: null');
select test.is(pg_temp.run($$select push_by_token(pg_temp.tok('Taylor'), 'maybe')$$), '22023 Choose on, off or status.', 'an action that isn''t one: refused');
select test.is(pg_temp.run($$select push_by_token(pg_temp.tok('Taylor'), 'on', null, null, null)$$),
               '22023 This phone didn''t give what reminders need. Try again.', 'on with nothing: refused');
select test.is(pg_temp.run(format($$select push_by_token(pg_temp.tok('Taylor'), 'on', %L, %L, %L)$$, 'https://evil.example/push/abc', :'key', :'auth')),
               '22023 This phone''s reminder address isn''t one Home Hub can use.', 'an address that isn''t a push service''s: refused, the row never in the error');
select test.is(pg_temp.run(format($$select push_by_token(pg_temp.tok('Taylor'), 'on', %L, %L, %L)$$, 'https://web.push.apple.com.evil.example/abc', :'key', :'auth')),
               '22023 This phone''s reminder address isn''t one Home Hub can use.', '... nor a host that only starts like one');
select test.is(pg_temp.run(format($$select push_by_token(pg_temp.tok('Taylor'), 'on', %L, %L, %L)$$, :'apple1', 'short', :'auth')),
               '22023 This phone''s reminder address isn''t one Home Hub can use.', '... nor keys of the wrong shape');
select test.is(pg_temp.phones(), '', 'nothing refused was kept');
select test.ok(not (homework_by_token(pg_temp.tok('Taylor')) ? 'reminders'), 'his view while push_at is null: no reminders key (exactly 0026''s)');
:as_owner
update public.household set push_at = '16:00';
:as_anon
select test.is(homework_by_token(pg_temp.tok('Taylor')) -> 'reminders', '{"at": "16:00"}'::jsonb, 'push_at set: his view says reminders are on, with the time');
select test.is(push_by_token(pg_temp.tok('Taylor'), 'on', :'apple1', :'key', :'auth')::text, '{"at": "16:00", "on": true}', 'on: kept, with the time');
select test.is(pg_temp.phones(), 'Taylor a001 0', '... one phone of his');
select test.is(push_by_token(pg_temp.tok('Taylor'), 'status', :'apple1')::text, '{"at": "16:00", "on": true}', 'status for that phone: on');
select test.is(push_by_token(pg_temp.tok('Taylor'), 'status', :'apple2')::text, '{"at": "16:00", "on": false}', 'status for another phone: off');
select test.is(push_by_token(pg_temp.tok('Taylor'), 'on', :'apple1', :'key', :'auth')::text, '{"at": "16:00", "on": true}', 'on again: the same phone, once');
:as_owner
set hub.now = '2026-11-13 15:01 America/New_York';
:as_anon
select push_by_token(pg_temp.tok('Taylor'), 'on', :'apple2', :'key', :'auth');
:as_owner
set hub.now = '2026-11-13 15:02 America/New_York';
:as_anon
select push_by_token(pg_temp.tok('Taylor'), 'on', :'apple3', :'key', :'auth');
:as_owner
set hub.now = '2026-11-13 15:03 America/New_York';
:as_anon
select push_by_token(pg_temp.tok('Taylor'), 'on', :'apple4', :'key', :'auth');
select test.is(pg_temp.phones(), 'Taylor a002 0, Taylor a003 0, Taylor a004 0', 'a fourth phone: at most 3, the oldest let go');
select test.is(push_by_token(pg_temp.tok('Taylor'), 'off', :'apple4')::text, '{"at": "16:00", "on": false}', 'off for one phone');
select test.is(pg_temp.phones(), 'Taylor a002 0, Taylor a003 0', '... that one gone, the others kept');
:as_admin
select test.is(push_people() -> 0 ->> 'name', 'Taylor', 'Settings (Alex): Taylor ...');
select test.is(push_people() -> 0 ->> 'phones', '2', '... with 2 phones');
:as_adult
select test.is(pg_temp.run($$select push_people()$$), '42501 Only a parent can see this.', 'Sam (an adult) can''t see who turned them on');

-- ---------------------------------------------------------------------
-- hub-jobs: who, once a day, and what the phone said
-- ---------------------------------------------------------------------
:as_service
select test.is(pg_temp.due(), '', '3:03pm: not yet (push_at is 4:00pm)');
:as_owner
set hub.now = '2026-11-13 16:00 America/New_York';
:as_service
select test.is(pg_temp.due(), 'Taylor due 2026-11-13', '4:00pm: Taylor');
select push_claim(test.person('Taylor'), '2026-11-13') as claim \gset
select test.ok(:'claim' is not null, 'push_claim: claimed');
select test.is(pg_temp.due(), '', '... and while it sends, not named again');
select test.ok(push_claim(test.person('Taylor'), '2026-11-13') is null, '... a second claim gets nothing');
select test.is((select count(*)::int from push_targets(test.person('Taylor'))), 2, 'push_targets: his two phones');
select test.is((select string_agg(distinct day_token, '') from push_targets(test.person('Taylor'))), pg_temp.tok('Taylor'), '... with his My day code');
select finish_notification(:'claim', 'sent');
select test.is((select kind || ' ' || channel || ' ' || status from public.notification_log where id = :'claim'), 'due push sent', 'logged as kind due, channel push, sent');
select test.is(pg_temp.due(), '', 'sent: not again today');
select push_result(:'apple2', 'ok');
select test.ok((select last_ok_at is not null from public.push_subscriptions where endpoint = :'apple2'), 'push_result ok: last sent noted');
select push_result(:'apple3', 'gone');
select test.is(pg_temp.phones(), 'Taylor a002 0', 'push_result gone: that phone let go');
select test.is(pg_temp.run($$select push_result('x', 'maybe')$$), '22023 push_result: status must be ok, gone or failed.', 'push_result: a status that isn''t one');
:as_owner
set hub.now = '2026-11-14 16:30 America/New_York';
:as_service
select test.is(pg_temp.due(), 'Taylor due 2026-11-14', 'the next day: Taylor again');
:as_owner
set hub.now = '2026-11-14 19:01 America/New_York';
:as_service
select test.is(pg_temp.due(), '', '... but not 3 hours after the time (a day it couldn''t go is let go)');
:as_owner
set hub.now = '2026-11-15 16:30 America/New_York';
:as_service
select push_result(:'apple2', 'failed') from generate_series(1, 9);
select test.is(pg_temp.phones(), 'Taylor a002 9', 'push_result failed: counted');
select push_result(:'apple2', 'failed');
select test.is(pg_temp.phones(), '', '... the 10th in a row lets it go');
select test.is(pg_temp.due(), '', 'no phone: nobody due');
:as_anon
select push_by_token(pg_temp.tok('Taylor'), 'on', :'apple1', :'key', :'auth');
:as_admin
select save_homework_kid(test.person('Taylor'), false);
:as_service
select test.is(pg_temp.due(), '', 'his homework off: nobody due');
:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
update public.household set push_at = null;
:as_service
select test.is(pg_temp.due(), '', 'push_at null: off');
:as_anon
select test.is(push_by_token(pg_temp.tok('Taylor'), 'off')::text, '{"at": null, "on": false}', 'off with no address: every phone of his');
select test.is(pg_temp.phones(), '', '... gone');
-- The Due tomorrow email is untouched: the email's claim is separate from the reminder's.
:as_service
select test.is((select count(*)::int from public.notification_log where channel = 'email'), 0, 'no email row was made by any of it');
