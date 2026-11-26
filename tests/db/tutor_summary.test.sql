-- The Sunday summary (migration 0035, docs/v1.3-homework.md §35): a parent sets an email address on a tutor link
-- (set_tutor_summary); every Sunday from 17:00 (the household's time) summary_due names each link that is on, not
-- ended, has its coach view on and an address, and whose kid has homework on; summary_claim and summary_finish log it
-- once a week (at most 3 tries); tutor_summary gives what the email says (the kid's first name, the label, the two
-- weeks' numbers). The four run functions are for service_role only.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (the kid). The tutors are only links' labels,
-- "Pat Lee, tutor" and "Riley Coach". Everything is made up. hub.now moves through Sun Nov 8, 2026 (America/New_York):
-- this household week is Mon Nov 2 to Sun Nov 8.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-08 16:30 America/New_York';
create function pg_temp.lid(p_label text) returns uuid language sql stable security definer as $$
  select id from public.tutor_links where label = p_label
$$;
grant execute on function pg_temp.lid(text) to authenticated, service_role;
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated, service_role;
create function pg_temp.due() returns text language sql stable as $$
  select coalesce(string_agg(l.label || ' ' || d.week, ', ' order by l.label), '-')
  from public.summary_due(20) d join public.tutor_links l on l.id = d.link_id
$$;
grant execute on function pg_temp.due() to service_role;

select test.is(hub_schema_version(), 40, 'hub_schema_version is 40 (0035 made it 35, 0036 36)');

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
select test.is((select string_agg(r || ':' || has_function_privilege(r, f, 'execute'), ',' order by f, r)
                from unnest(array['public.summary_due(int)', 'public.summary_claim(uuid, date)', 'public.summary_finish(uuid, text, text)', 'public.tutor_summary(uuid)']) f,
                     unnest(array['anon', 'authenticated', 'service_role']) r),
               'anon:false,authenticated:false,service_role:true,anon:false,authenticated:false,service_role:true,'
               || 'anon:false,authenticated:false,service_role:true,anon:false,authenticated:false,service_role:true',
               'summary_claim, summary_due, summary_finish and tutor_summary: service_role only');
select test.ok(has_function_privilege('authenticated', 'public.set_tutor_summary(uuid, text)', 'execute')
               and not has_function_privilege('anon', 'public.set_tutor_summary(uuid, text)', 'execute')
               and not has_function_privilege('service_role', 'public.set_tutor_summary(uuid, text)', 'execute'),
               'set_tutor_summary: signed in only');
select test.ok((select c.relrowsecurity from pg_class c where c.oid = 'public.tutor_summary_log'::regclass)
               and not has_table_privilege('anon', 'public.tutor_summary_log', 'select')
               and has_table_privilege('authenticated', 'public.tutor_summary_log', 'select')
               and not has_table_privilege('authenticated', 'public.tutor_summary_log', 'insert')
               and not has_table_privilege('authenticated', 'public.tutor_summary_log', 'update')
               and not has_column_privilege('authenticated', 'public.tutor_links', 'summary_to', 'update'),
               'tutor_summary_log: RLS on, nothing for anon, read only when signed in; summary_to: no update grant');
select test.is((select string_agg(distinct array_to_string(p.proconfig, ','), ' ') from pg_proc p
                where p.oid in ('public.set_tutor_summary(uuid, text)'::regprocedure, 'public.summary_due(int)'::regprocedure,
                                'public.summary_claim(uuid, date)'::regprocedure, 'public.summary_finish(uuid, text, text)'::regprocedure,
                                'public.tutor_summary(uuid)'::regprocedure)),
               'search_path=""', 'every new function: an empty search_path');

-- ---------------------------------------------------------------------
-- The address
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true);
select save_tutor_link(null, test.person('Taylor'), 'Riley Coach', 'es', null, true, true);
select set_tutor_coach(pg_temp.lid('Pat Lee, tutor'), true);
select set_tutor_coach(pg_temp.lid('Riley Coach'), true);
select test.is(pg_temp.run($$select set_tutor_summary(pg_temp.lid('Pat Lee, tutor'), '  Pat.Lee@Example.com ')$$), 'ok', 'a parent sets an address');
select test.is((select summary_to from tutor_links where id = pg_temp.lid('Pat Lee, tutor')), 'pat.lee@example.com', '... trimmed and in lower case');
select test.is(pg_temp.run($$select set_tutor_summary(pg_temp.lid('Pat Lee, tutor'), 'pat at example')$$),
               '22023 That doesn''t look like an email address.', 'an address without @ is refused');
select test.is(pg_temp.run($$select set_tutor_summary(pg_temp.lid('Pat Lee, tutor'), 'a@b.co, c@d.co')$$),
               '22023 That doesn''t look like an email address.', 'two addresses are refused');
select test.is(pg_temp.run($$select set_tutor_summary(gen_random_uuid(), 'pat@example.com')$$),
               '22023 That link is gone.', 'an unknown link is refused');
select test.is((select summary_to from tutor_links where id = pg_temp.lid('Pat Lee, tutor')), 'pat.lee@example.com', '... and the refusals changed nothing');
:as_adult
select test.is(pg_temp.run($$select set_tutor_summary(pg_temp.lid('Pat Lee, tutor'), 'sam@example.com')$$),
               '42501 Only a parent can change homework.', 'Sam (not a parent) is refused');
:as_admin
select test.is(pg_temp.run($$select set_tutor_summary(pg_temp.lid('Riley Coach'), 'riley@example.com')$$), 'ok', 'a second link gets an address');
select test.is(pg_temp.run($$select set_tutor_summary(pg_temp.lid('Riley Coach'), '  ')$$), 'ok', '... a blank clears it');
select test.is((select summary_to from tutor_links where id = pg_temp.lid('Riley Coach')), null, '... to null');

-- ---------------------------------------------------------------------
-- When it is due
-- ---------------------------------------------------------------------
:as_service
select test.is(pg_temp.due(), '-', 'Sunday 4:30pm: nothing due yet');
:as_owner
set hub.now = '2026-11-08 17:00 America/New_York';
:as_service
select test.is(pg_temp.due(), 'Pat Lee, tutor 2026-11-02', 'Sunday 5:00pm: the link with an address, for the week of Mon Nov 2 (not the one without)');
:as_owner
set hub.now = '2026-11-07 18:00 America/New_York';
:as_service
select test.is(pg_temp.due(), '-', 'Saturday 6:00pm: nothing (Sundays only)');
:as_owner
set hub.now = '2026-11-08 18:00 America/New_York';
update tutor_links set coach = false where label = 'Pat Lee, tutor';
:as_service
select test.is(pg_temp.due(), '-', 'coach view off: not due');
:as_owner
update tutor_links set coach = true, active = false where label = 'Pat Lee, tutor';
:as_service
select test.is(pg_temp.due(), '-', 'link off: not due');
select test.is(tutor_summary(pg_temp.lid('Pat Lee, tutor')), null, '... and tutor_summary is null for it');
:as_owner
update tutor_links set active = true, expires_on = '2026-11-07' where label = 'Pat Lee, tutor';
:as_service
select test.is(pg_temp.due(), '-', 'link ended yesterday: not due');
:as_owner
update tutor_links set expires_on = '2027-03-01' where label = 'Pat Lee, tutor';
update homework_kids set active = false where kid_id = test.person('Taylor');
:as_service
select test.is(pg_temp.due(), '-', 'homework off for the kid: not due');
:as_owner
update homework_kids set active = true where kid_id = test.person('Taylor');
:as_service
select test.is(pg_temp.due(), 'Pat Lee, tutor 2026-11-02', 'all on again: due');

-- ---------------------------------------------------------------------
-- What it says
-- ---------------------------------------------------------------------
:as_owner
insert into tasks (title, category, responsible_id, due_date, due_time, repeat_mode, active, done_at) values
  ('Take out trash', 'home', test.person('Taylor'), '2026-11-05', '18:00', 'none', true, '2026-11-05 22:50+00');
insert into task_log (task_id, occurrence, status, created_at)
  select id, '2026-11-05', 'done', '2026-11-05 22:50+00' from tasks where title = 'Take out trash';
:as_service
select tutor_summary(pg_temp.lid('Pat Lee, tutor')) as s \gset
select test.is(:'s'::jsonb ->> 'to', 'pat.lee@example.com', 'tutor_summary: to');
select test.is(:'s'::jsonb ->> 'language', 'en', '... language (the link''s)');
select test.is(:'s'::jsonb ->> 'label', 'Pat Lee, tutor', '... label');
select test.is(:'s'::jsonb ->> 'kid', 'Taylor', '... the kid''s first name');
select test.is((select string_agg(k, ',' order by k) from jsonb_object_keys(:'s'::jsonb) k), 'kid,label,language,to,week', '... and nothing else');
select test.is(:'s'::jsonb -> 'week' -> 'this' ->> 'from', '2026-11-02', '... this week from Mon Nov 2');
select test.is(:'s'::jsonb -> 'week' -> 'last' ->> 'from', '2026-10-26', '... last week from Mon Oct 26');
select test.is((:'s'::jsonb -> 'week' -> 'this' ->> 'done')::int, 1, '... this week''s done: the trash');
select test.is((:'s'::jsonb -> 'week' -> 'this' ->> 'on_time')::int, 1, '... on time (5:50pm, by 6:00pm)');
select test.is(tutor_summary(pg_temp.lid('Riley Coach')), null, 'tutor_summary: null for a link without an address');

-- ---------------------------------------------------------------------
-- Claim and finish: once a week, at most 3 tries
-- ---------------------------------------------------------------------
select summary_claim(pg_temp.lid('Pat Lee, tutor'), '2026-11-02') as c1 \gset
select test.ok(:'c1' <> '', 'summary_claim: a new claim');
select test.is(summary_claim(pg_temp.lid('Pat Lee, tutor'), '2026-11-02'), null, '... a second claim while it is sending: null');
select test.is(pg_temp.due(), '-', '... and it is not due while in flight');
select summary_finish(:'c1', 'failed', 'Resend 500');
select test.is(pg_temp.due(), 'Pat Lee, tutor 2026-11-02', 'failed: due again');
select test.ok(summary_claim(pg_temp.lid('Pat Lee, tutor'), '2026-11-02') = :'c1'::uuid, '... claimed again (the same row)');
select summary_finish(:'c1', 'failed', 'Resend 500');
select test.ok(summary_claim(pg_temp.lid('Pat Lee, tutor'), '2026-11-02') = :'c1'::uuid, '... a third try');
select summary_finish(:'c1', 'failed', 'Resend 500');
select test.is(summary_claim(pg_temp.lid('Pat Lee, tutor'), '2026-11-02'), null, '... out of tries: null');
select test.is(pg_temp.due(), '-', '... and not due');
:as_owner
delete from tutor_summary_log;
:as_service
select summary_claim(pg_temp.lid('Pat Lee, tutor'), '2026-11-02') as c2 \gset
select summary_finish(:'c2', 'sent', 'Resend abc');
select test.is(pg_temp.due(), '-', 'sent: not due again this week');
select test.is(summary_claim(pg_temp.lid('Pat Lee, tutor'), '2026-11-02'), null, '... and no claim');
select test.is(pg_temp.run($$select summary_finish(gen_random_uuid(), 'done')$$),
               '22023 summary_finish: status must be sent, failed or skipped.', 'summary_finish refuses an unknown status');
:as_admin
select test.is((select status || ' ' || detail from tutor_summary_log), 'sent Resend abc', 'a parent reads the log (the Homework page''s Last sent)');
:as_adult
select test.is((select count(*) from tutor_summary_log)::int, 0, 'Sam reads nothing of it');
:as_owner
set hub.now = '2026-11-15 17:05 America/New_York';
:as_service
select test.is(pg_temp.due(), 'Pat Lee, tutor 2026-11-09', 'next Sunday: due for the week of Mon Nov 9');
:as_owner
delete from tutor_links where label = 'Pat Lee, tutor';
select test.is((select count(*) from tutor_summary_log)::int, 0, 'a link deleted takes its log with it');
