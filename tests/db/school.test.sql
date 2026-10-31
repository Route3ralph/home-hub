-- The school feed (migration 0006, docs/v1.3-homework.md §11 and §12): the parents' links (Add,
-- Replace, Remove) and the address check; the address as a secret (no role but the job's own
-- function reads it); the job's lease and what it stores (keys, a UID repeated in one read, the
-- window, the caps, an empty read, failures and their backoff, items no longer on the school site,
-- a moved item without a UID); the first-import check; Jordan's New from school (Quick, Plan with
-- Pat, Hide) and the parents' Add, Hide and Show; school changes reaching an assignment unless a
-- person changed that field; schedule and games as busy time; the status card; Remove and Erase.
-- After the review (on Robin's links, at the end): the description trimmed on the item and in applied by
-- the hourly run, paused or not; a run that dies partway; two classes' items without a UID, and the
-- moved-item step's limits; Remove and Add again; Resume and homework back on not stale.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (the kid with homework),
-- Morgan (the helper), plus Robin, a second kid. Everything is made up: the school's host is
-- academy.school.example (the allowed suffix is replaced below), the classes and titles too.
-- hub.now is Mon Nov 2, 2026 (America/New_York, the day after the clock change) unless a case moves it.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-02 09:00 America/New_York';   -- a Monday
insert into people (name, role, sort_order) values ('Robin', 'kid', 5);
-- Runs a statement and keeps what it did: 'ok', or the error's code and message.
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
create function pg_temp.keys(j jsonb) returns text language sql immutable as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(j) k
$$;
-- Rows by title or kind, whoever is asking.
create function pg_temp.item(p_title text) returns public.school_items language sql stable security definer as $$
  select * from public.school_items where title = p_title
$$;
create function pg_temp.iid(p_title text) returns uuid language sql stable security definer as $$
  select id from public.school_items where title = p_title
$$;
create function pg_temp.feed(p_kid text, p_kind text) returns public.school_feeds language sql stable security definer as $$
  select * from public.school_feeds where kid_id = test.person(p_kid) and kind = p_kind
$$;
create function pg_temp.fid(p_kid text, p_kind text) returns uuid language sql stable security definer as $$
  select id from public.school_feeds where kid_id = test.person(p_kid) and kind = p_kind
$$;
create function pg_temp.asg(p_title text) returns public.assignments language sql stable security definer as $$
  select * from public.assignments where title = p_title
$$;
create function pg_temp.el(j jsonb, p_title text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(j) x where x ->> 'title' = p_title limit 1
$$;
create function pg_temp.titles(j jsonb) returns text language sql immutable as $$
  select string_agg(x ->> 'title', ' | ' order by n) from jsonb_array_elements(j) with ordinality t (x, n)
$$;
create function pg_temp.pat() returns text language sql stable security definer as $$
  select token from public.tutor_links where label = 'Pat Lee, tutor'
$$;
create function pg_temp.sync() returns private.school_sync language sql stable security definer as $$
  select * from private.school_sync where id
$$;
create function pg_temp.lease() returns uuid language sql stable security definer as $$
  select run_id from private.school_sync where id
$$;
-- One read as hub-jobs stores it: take the lease, store, end the run (as service_role).
create function pg_temp.read(p_kid text, p_kind text, p_items jsonb, p_stop text default null, p_repeats int default 0)
returns jsonb language plpgsql as $$
declare
  b jsonb;
  r jsonb;
begin
  b := public.school_begin(true);
  if not coalesce((b ->> 'go')::boolean, false) then
    return jsonb_build_object('begin', b);
  end if;
  r := public.school_store((b ->> 'run_id')::uuid, pg_temp.fid(p_kid, p_kind), p_items, p_stop, p_repeats);
  perform public.school_finish((b ->> 'run_id')::uuid);
  return r;
end;
$$;

-- ---------------------------------------------------------------------
-- The links: Add, Replace, Remove, and the address check (§11.3)
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
select save_homework_kid(test.person('Robin'), true);
select add_homework_time(test.person('Taylor'), '{1,2,3,4}', '16:30', '17:15') as hw_event \gset
select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true) as pat_link \gset
:as_owner
select test.is(private.school_host_suffix(), '.myschoolapp.com', 'the address check allows hosts ending in .myschoolapp.com only');
:as_admin
select test.is(pg_temp.run($$select set_school_feed(test.person('Taylor'), 'assignments',
                                                    'https://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6')$$),
               '22023 That isn''t a school calendar link. Copy it from the calendar''s feed button: it starts with webcal:// or https:// and has /podium/feed/iCal.aspx?z= in it.',
               'with the real host check, a made-up school''s host is refused (22023)');
-- From here on the allowed suffix is a made-up one, as hub-jobs' tests replace theirs.
:as_owner
create or replace function private.school_host_suffix() returns text language sql immutable set search_path = '' as $$ select '.school.example' $$;

:as_adult
select test.throws($$select set_school_feed(test.person('Taylor'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6')$$,
                   'Only a parent can change homework.', 'Sam can''t add a school link (his page is read-only)');
:as_stranger
select test.throws($$select set_school_feed(test.person('Taylor'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6')$$,
                   'Only a parent can change homework.', 'a stranger can''t either');
:as_admin
select test.throws($$select set_school_feed(test.person('Morgan'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6')$$,
                   'Turn on homework for this kid first.', 'a link needs homework on for the kid');
select test.throws($$select set_school_feed(test.person('Taylor'), 'class_events', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6')$$,
                   'Choose assignments, schedule or games.', 'only the Assignments, Schedule and Games/Practices links');
select test.is((select string_agg(u, ' | ' order by u) from unnest(array[
                  'http://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://academy.school.example:8443/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://pat:pw@academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://academy@academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://academy.school.example.attacker.example/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://evilschool.example/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://school.example/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://10.0.0.1/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://[::1]/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'https://academy.school.example/podium/feed/other.aspx?z=Q1w2E3r4',
                  'https://academy.school.example/podium/feed/iCal.aspx?t=Q1w2E3r4',
                  'https://academy.school.example/podium/feed/iCal.aspx?z=',
                  'https://academy.school.example/podium/feed/iCal.aspx',
                  'https://academy.school.example/podium/feed/iCal.aspx?z=Q1w2 E3r4',
                  'https://academy.school.example/podium/feed/iCal.aspx?z=<Q1w2E3r4>',
                  'https://academy.school.example/podium/feed/iCal.aspx?z=' || repeat('a', 460),
                  'ftp://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  'academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4',
                  ''
                ]) u
                where pg_temp.run(format('select set_school_feed(%L, %L, %L)', test.person('Taylor'), 'assignments', nullif(u, '')))
                      not like '22023 That isn''t a school calendar link.%'
                  and not (u = '' and pg_temp.run(format('select set_school_feed(%L, %L, %L)', test.person('Taylor'), 'assignments', u)) = 'ok')),
               null,
               'refused, each with the same words: http, port 8443, user info, a look-alike host, another domain, the bare domain, an IP, '
               'another path, no z, an empty z, a space, angle brackets, over 500 characters, ftp, no scheme (and nothing to remove is fine)');
select test.is((select count(*) from school_feeds), 0::bigint, '... and nothing was saved');

select set_school_feed(test.person('Taylor'), 'assignments',
                       '  webcal://Academy.School.Example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6U7i8a1b2  ') as added \gset
select test.is(pg_temp.keys(:'added'::jsonb), 'host,id,kind,url_end', 'Add link answers the link''s id, kind, host and last 4 characters only');
select test.is((:'added'::jsonb ->> 'kind') || ' ' || (:'added'::jsonb ->> 'host') || ' …' || (:'added'::jsonb ->> 'url_end'),
               'assignments academy.school.example …a1b2', '... the host in lower case, for the status line, and "…a1b2"');
select test.ok(strpos(:'added', 'Q1w2E3') = 0 and strpos(:'added', 'podium') = 0, '... never the address or any of z but its last 4');
:as_owner
select test.is((select url from private.school_feed_urls where feed_id = (:'added'::jsonb ->> 'id')::uuid),
               'https://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6U7i8a1b2',
               'the address is kept in private.school_feed_urls: webcal:// made https://, the host lower case, the spaces trimmed');
select test.is((select created_by || ' ' || checked || ' ' || date_rule || ' ' || date_shift || ' ' || paused || ' ' || fails
                       || ' ' || (next_at = '2026-11-02 09:00 America/New_York'::timestamptz)
                from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid),
               'alex@example.com false end 0 false 0 true', '... a new link: stamped, not checked yet, the end date, due to be read now');
:as_admin
select set_school_feed(test.person('Taylor'), 'assignments', 'https://academy.school.example/podium/feed/iCal.aspx?z=Z9x8C7v6B5n4M3c3d4') as replaced \gset
select test.is((:'replaced'::jsonb ->> 'id') || ' …' || (:'replaced'::jsonb ->> 'url_end'), (:'added'::jsonb ->> 'id') || ' …c3d4',
               'Replace keeps the link''s row and shows the new last 4');
:as_owner
select test.is((select string_agg(url, ' ') from private.school_feed_urls), 'https://academy.school.example/podium/feed/iCal.aspx?z=Z9x8C7v6B5n4M3c3d4',
               '... and only the new address is kept');
:as_admin
select set_school_feed(test.person('Taylor'), 'schedule', 'https://academy.school.example:443/podium/feed/iCal.aspx?z=S1s2S3s4S5s6S7s8') as sched \gset
select set_school_feed(test.person('Taylor'), 'games', 'WEBCAL://academy.school.example/podium/feed/ICAL.ASPX?z=G1g2G3g4G5g6G7g8') as games \gset
select set_school_feed(test.person('Robin'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=R1r2R3r4R5r6R7r8') as robin \gset
:as_owner
select test.is((select string_agg(url, ' ' order by url) from private.school_feed_urls u join school_feeds f on f.id = u.feed_id where f.kind <> 'assignments'),
               'https://academy.school.example/podium/feed/ICAL.ASPX?z=G1g2G3g4G5g6G7g8 https://academy.school.example/podium/feed/iCal.aspx?z=S1s2S3s4S5s6S7s8',
               'port 443 written out is the same address; the path''s case is kept');

-- ---------------------------------------------------------------------
-- The address is a secret: no role reads it but hub-jobs' own function (§11.3)
-- ---------------------------------------------------------------------
:as_owner
select test.is((select string_agg(r, ', ') from unnest(array['anon', 'authenticated', 'service_role']) r
                where has_table_privilege(r, 'private.school_feed_urls', 'select, insert, update, delete, truncate, references, trigger')
                   or has_any_column_privilege(r, 'private.school_feed_urls', 'select, insert, update, references')),
               null, 'private.school_feed_urls: no privilege for anon, authenticated or service_role');
select test.is((select c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
                from pg_class c where c.oid = 'private.school_feed_urls'::regclass), true, '... row-level security on, no policies');
select test.is((select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
                where a.attrelid = 'public.school_feeds'::regclass and a.attnum > 0 and not a.attisdropped),
               'id,kid_id,kind,host,url_end,date_rule,date_shift,checked,paused,next_at,last_try_at,last_ok_at,last_count,last_repeats,last_stop,fails,removed_at,created_at,created_by,updated_at,updated_by',
               'school_feeds has no address column: the host and its last 4 characters');
:as_anon
select test.is(test.try('select * from private.school_feed_urls'), 'denied', 'anon can''t read the addresses');
select test.is(test.try('select school_begin()'), 'denied', '... or start a read');
:as_admin
select test.is(test.try('select * from private.school_feed_urls'), 'denied', 'a parent can''t read them back');
select test.is(test.try('select school_begin()'), 'denied', '... or start a read');
select test.ok(strpos((select string_agg(to_jsonb(f)::text, ' ') from school_feeds f), 'Z9x8C7') = 0
               and strpos(school_feed_status(test.person('Taylor'))::text, 'Z9x8C7') = 0
               and strpos(school_feed_status(test.person('Taylor'))::text, 'podium') = 0,
               '... and nothing a parent reads (school_feeds, the status card) has the address');
:as_service
select test.is(test.try('select * from private.school_feed_urls'), 'denied', 'service_role can''t read the table either');
select test.is(test.try('select * from public.school_feeds'), 'rows:4', '... it reads the links'' settings');
:as_anon
select test.is(test.try($$select school_item_by_token(repeat('0', 32), gen_random_uuid(), 'hide')$$), 'rows:1', 'anon may call school_item_by_token (null for a bad token)');
select test.is(school_item_by_token(repeat('0', 32), gen_random_uuid(), 'hide'), null, '... which answers null');

-- ---------------------------------------------------------------------
-- The job: the lease, and what school_begin hands over (§11.3)
-- ---------------------------------------------------------------------
:as_service
select school_begin() as b \gset
select test.is((:'b'::jsonb ->> 'go') || ' ' || (:'b'::jsonb ->> 'today') || ' ' || (:'b'::jsonb ->> 'tz') || ' ' || jsonb_array_length(:'b'::jsonb -> 'feeds'),
               'true 2026-11-02 America/New_York 4', 'school_begin takes the lease and hands over the four links that are due, with the household''s day and zone');
select test.is((select string_agg(x ->> 'kind' || ' ' || (x ->> 'url'), ' | ' order by x ->> 'url') from jsonb_array_elements(:'b'::jsonb -> 'feeds') x
                where (x ->> 'feed_id')::uuid = (:'added'::jsonb ->> 'id')::uuid),
               'assignments https://academy.school.example/podium/feed/iCal.aspx?z=Z9x8C7v6B5n4M3c3d4', '... each with its id, kind and address (only this function reads it)');
select test.is(pg_temp.keys(:'b'::jsonb -> 'feeds' -> 0), 'feed_id,kind,url', '... and nothing else');
select test.is(school_begin(), '{"go": false, "stop": "busy"}'::jsonb, 'a second run while the first holds the lease: busy');
select test.is(school_store(gen_random_uuid(), (:'added'::jsonb ->> 'id')::uuid, '[]', null), '{"stored": false, "stop": "late"}'::jsonb,
               'a store without the lease''s run id changes nothing (late)');
select school_finish((:'b'::jsonb ->> 'run_id')::uuid);
select test.is((select (run_id is null) || ' ' || (lease_until is null) || ' ' || (last_run_at = '2026-11-02 09:00 America/New_York'::timestamptz)
                from pg_temp.sync()), 'true true true', 'school_finish ends the run and notes when it ran');
select test.is(school_store((:'b'::jsonb ->> 'run_id')::uuid, (:'added'::jsonb ->> 'id')::uuid, '[]', null), '{"stored": false, "stop": "late"}'::jsonb,
               '... after which that run can store nothing');
:as_owner
update private.school_sync set run_id = gen_random_uuid(), lease_until = '2026-11-02 08:58 America/New_York';
:as_service
select test.is(school_begin() ->> 'go', 'true', 'a lease that ran out (a run that died) is taken by the next run');
select school_finish(pg_temp.lease());

-- ---------------------------------------------------------------------
-- An Assignments read (school_store)
-- ---------------------------------------------------------------------
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-101@academy.school.example", "title": "Lab report: water filters", "subject": "Biology",
   "details": "Write up the lab.\nUse the template on the class page.", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"uid": "a-102@academy.school.example", "title": "Read chapter 5", "subject": "History", "first_day": "2026-11-03", "last_day": "2026-11-03"},
  {"uid": "a-103@academy.school.example", "title": "Essay: a person who changed a town", "subject": "English",
   "first_day": "2026-11-02", "last_day": "2026-11-16"},
  {"uid": "a-104@academy.school.example", "title": "Old worksheet", "subject": "Math", "first_day": "2026-10-01", "last_day": "2026-10-01"},
  {"uid": "a-105@academy.school.example", "title": "Far-off project", "subject": "Art", "first_day": "2027-05-20", "last_day": "2027-05-20"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-04", "last_day": "2026-11-04"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-11-06", "last_day": "2026-11-06"},
  {"uid": "a-106@academy.school.example", "title": "Poem", "subject": "English", "first_day": "2026-11-12", "last_day": "2026-11-12"},
  {"uid": "a-107@academy.school.example", "title": "   ", "first_day": "2026-11-06", "last_day": "2026-11-06"},
  {"uid": "a-108@academy.school.example", "title": "Bad date", "first_day": "2026-13-40", "last_day": "2026-13-40"},
  "not an item"
]') as r1 \gset
select test.is(:'r1'::jsonb - 'added' - 'gone' - 'missing', '{"stored": true, "stop": null, "kept": 5}'::jsonb,
               'a read is stored: five kept (outside the window, no title, a bad date or not an object: left out)');
select test.is((:'r1'::jsonb ->> 'added')::int, 5, '... all five new');
:as_owner
select test.is((select string_agg(title || ' ' || coalesce(subject, '-') || ' ' || first_day || ' ' || last_day || ' ' || due_date || ' ' || has_uid, ' | '
                                  order by due_date, title) from school_items),
               'Read chapters 5 and 6 History 2026-11-04 2026-11-04 2026-11-04 true | Lab report: water filters Biology 2026-11-05 2026-11-05 2026-11-05 true | '
               'Vocabulary quiz Spanish 2026-11-06 2026-11-06 2026-11-06 false | Poem English 2026-11-12 2026-11-12 2026-11-12 true | '
               'Essay: a person who changed a town English 2026-11-02 2026-11-16 2026-11-16 true',
               'the items: a UID repeated in one read is one item, the last one wins; the due date is the span''s end (the default rule)');
select test.is((select key = md5('uid:a-101@academy.school.example') from school_items where title = 'Lab report: water filters'), true,
               'an item''s key is the md5 of its UID');
select test.is((select key = md5('title:spanish' || E'\n' || 'vocabulary quiz|2026-11-06') from school_items where title = 'Vocabulary quiz'), true,
               '... or, without one, of its class, its title and its first day (a line break, which neither can hold, between class and title)');
select test.is((pg_temp.item('Lab report: water filters')).details, E'Write up the lab.\nUse the template on the class page.',
               'the item''s description is kept, with its line break');
select test.is((select last_ok_at = private.now() and last_try_at = private.now() and last_count = 5 and last_stop is null and fails = 0
                       and next_at = private.now() + interval '50 minutes' and last_repeats = 0
                from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid), true,
               'the link''s status: read now, 5 items, no stop, due again in 50 minutes (the next hourly run)');

-- Nothing reaches Taylor (or the tutor) before the first-import check.
:as_anon
select homework_by_token(test.token('Taylor')) as kv0 \gset
select test.is(:'kv0'::jsonb ? 'from_school', false, 'before the first-import check, her view has no New from school');
select test.is(get_person_day(test.token('Taylor')) -> 'homework' ? 'from_school', false, '... nor her card');
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''hide'')', test.token('Taylor'), pg_temp.iid('Poem'))),
               '42501 That isn''t on your list from school.', '... and she can''t act on an item yet');
:as_admin
select school_feed_status(test.person('Taylor')) as st0 \gset
select test.is(pg_temp.keys(:'st0'::jsonb), 'check,feeds,gone,hidden,kid_id,last_run_at,moved,new', 'the status card''s keys');
select test.is(pg_temp.titles(:'st0'::jsonb -> 'check'),
               'Read chapters 5 and 6 | Lab report: water filters | Vocabulary quiz | Poem | Essay: a person who changed a town',
               '... the first-import check shows the next five items, by due date');
select test.is(pg_temp.keys(:'st0'::jsonb -> 'check' -> 0), 'due_date,first_day,id,last_day,subject,title', '... each with its dates');
select test.is(:'st0'::jsonb -> 'new', '[]'::jsonb, '... and nothing is new for her yet');
select test.is(pg_temp.keys(:'st0'::jsonb -> 'feeds' -> 0),
               'checked,date_rule,date_shift,fails,host,id,kind,last_count,last_ok_at,last_repeats,last_stop,last_try_at,next_at,paused,stale,url_end',
               '... a link''s status');
select test.is((select string_agg(x ->> 'kind', ',' order by n) from jsonb_array_elements(:'st0'::jsonb -> 'feeds') with ordinality t (x, n)),
               'assignments,schedule,games', '... the links in a fixed order');

-- ---------------------------------------------------------------------
-- The first-import check (check_school_feed)
-- ---------------------------------------------------------------------
:as_adult
select test.throws(format('select check_school_feed(%L, ''end'', 0)', :'added'::jsonb ->> 'id'), 'Only a parent can change homework.', 'Sam can''t answer the check');
select test.is(school_feed_status(test.person('Taylor')) -> 'check' -> 0 ->> 'title', 'Read chapters 5 and 6', '... but reads the status card');
:as_stranger
select test.is(school_feed_status(test.person('Taylor')), null, 'a stranger gets null');
:as_admin
select test.throws(format('select check_school_feed(%L, ''middle'', 0)', :'added'::jsonb ->> 'id'),
                   'Choose the start or the end date, and a shift of -1, 0 or 1 day.', 'a date rule is start or end');
select test.throws(format('select check_school_feed(%L, ''end'', 2)', :'added'::jsonb ->> 'id'),
                   'Choose the start or the end date, and a shift of -1, 0 or 1 day.', '... and the shift -1, 0 or 1');
select test.throws(format('select check_school_feed(%L, ''end'', 0)', :'sched'::jsonb ->> 'id'),
                   'Only the Assignments link has dates to check.', 'the Schedule link has no check');
select test.throws(format('select check_school_feed(%L, ''end'', 0)', gen_random_uuid()), 'That school link isn''t there any more.', 'an unknown link');
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'start', 0);
select test.is((pg_temp.item('Essay: a person who changed a town')).due_date, '2026-11-02'::date, '"They''re the assigned dates": the start date');
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'end', -1);
select test.is((pg_temp.item('Essay: a person who changed a town')).due_date, '2026-11-15'::date, '"One day off": the end date less a day');
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'end', 0) as st1 \gset
select test.is((select string_agg(title || ' ' || due_date, ' | ' order by due_date) from school_items),
               'Read chapters 5 and 6 2026-11-04 | Lab report: water filters 2026-11-05 | Vocabulary quiz 2026-11-06 | Poem 2026-11-12 | '
               'Essay: a person who changed a town 2026-11-16',
               '"Looks right": the end date; every item''s due date follows the answer');
select test.is((pg_temp.feed('Taylor', 'assignments')).checked, true, '... the link is checked');
select test.is(:'st1'::jsonb -> 'check', '[]'::jsonb, '... and the check is answered');
select test.is(pg_temp.titles(:'st1'::jsonb -> 'new'), 'Read chapters 5 and 6 | Lab report: water filters | Vocabulary quiz | Poem | Essay: a person who changed a town',
               '... and what is new for her shows on the card');

-- ---------------------------------------------------------------------
-- Her New from school (homework_by_token's from_school; the card's count)
-- ---------------------------------------------------------------------
:as_anon
select homework_by_token(test.token('Taylor')) as kv \gset
select test.is(pg_temp.titles(:'kv'::jsonb -> 'from_school'),
               'Read chapters 5 and 6 | Lab report: water filters | Vocabulary quiz | Poem | Essay: a person who changed a town',
               'her view: New from school, by due date');
select test.is(pg_temp.keys(:'kv'::jsonb -> 'from_school' -> 0), 'due_date,id,quick,subject,title', '... each with its class, due date and whether Quick is offered');
select test.is((select string_agg(x ->> 'title' || ' ' || (x ->> 'quick'), ' | ' order by n) from jsonb_array_elements(:'kv'::jsonb -> 'from_school') with ordinality t (x, n)),
               'Read chapters 5 and 6 true | Lab report: water filters true | Vocabulary quiz false | Poem false | Essay: a person who changed a town false',
               '... Quick for one due within 3 days (as v1.3''s Quick)');
select test.ok(strpos(:'kv', 'Use the template') = 0 and strpos(:'kv', 'academy') = 0, '... never the description, the UID or the host');
select test.is(get_person_day(test.token('Taylor')) -> 'homework' -> 'from_school', '5'::jsonb, 'her card counts what is new from school');

-- Hide, and a parent's Show.
select school_item_by_token(test.token('Taylor'), pg_temp.iid('Vocabulary quiz'), 'hide') as hid \gset
select test.is(pg_temp.titles(:'hid'::jsonb -> 'from_school'), 'Read chapters 5 and 6 | Lab report: water filters | Poem | Essay: a person who changed a town',
               'Hide: it leaves her list (the answer is her view)');
select test.is(school_item_by_token(test.token('Taylor'), pg_temp.iid('Vocabulary quiz'), 'hide') -> 'from_school', :'hid'::jsonb -> 'from_school',
               '... a resent Hide changes nothing');
:as_admin
select test.is(pg_temp.titles(school_feed_status(test.person('Taylor')) -> 'hidden'), 'Vocabulary quiz', 'the parents see what she hid');
:as_adult
select test.throws(format('select school_item_action(%L, ''show'')', pg_temp.iid('Vocabulary quiz')), 'Only a parent can change homework.', 'Sam can''t bring it back');
:as_admin
select test.throws(format('select school_item_action(%L, ''delete'')', pg_temp.iid('Vocabulary quiz')), 'Choose add, hide or show.', 'a parent''s actions: add, hide or show');
select test.throws(format('select school_item_action(%L, ''show'')', gen_random_uuid()), 'That item from school isn''t there any more.', '... on an item that exists');
select test.is(pg_temp.titles(school_item_action(pg_temp.iid('Vocabulary quiz'), 'show') -> 'new'),
               'Read chapters 5 and 6 | Lab report: water filters | Vocabulary quiz | Poem | Essay: a person who changed a town', 'a parent''s Show brings it back');

-- Who may act, and on what.
:as_anon
select test.is(school_item_by_token(test.token('Morgan'), pg_temp.iid('Poem'), 'hide'), null, 'the helper''s My day token: null');
select test.is(school_item_by_token('not a token', pg_temp.iid('Poem'), 'hide'), null, 'a malformed token: null');
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''plan'')', test.token('Taylor'), pg_temp.iid('Poem'))),
               '22023 Choose quick, with_tutor or hide.', 'her actions: quick, with_tutor or hide');
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''quick'', 3)', test.token('Taylor'), pg_temp.iid('Poem'))),
               '22023 A step is 5 to 60 minutes.', 'Quick takes 5 to 60 minutes');
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''hide'')', test.token('Taylor'), gen_random_uuid())),
               '42501 That isn''t on your list from school.', 'an unknown item: 42501');
:as_service
-- (Due in December: the hourly run's trim lets the household's past items go, and the clock visits Nov 28 below.)
select pg_temp.read('Robin', 'assignments', '[{"uid": "r-1", "title": "Robin''s map", "subject": "Geography", "first_day": "2026-12-05", "last_day": "2026-12-05"}]');
:as_anon
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''hide'')', test.token('Taylor'), pg_temp.iid('Robin''s map'))),
               '42501 That isn''t on your list from school.', 'another kid''s item: the same 42501');

-- Quick: one tap makes it an assignment "from school" with tonight's step.
select school_item_by_token(test.token('Taylor'), pg_temp.iid('Read chapters 5 and 6'), 'quick', 20) as q \gset
:as_owner
select test.is((select a.kind || ' ' || a.added_by || ' ' || a.title || ' ' || a.subject || ' ' || a.due_date || ' ' || (a.details is null)
                       || ' ' || (a.given_by = 'Taylor (My day)') || ' ' || a.created_by
                from assignments a where a.id = (:'q'::jsonb ->> 'assignment_id')::uuid),
               'assignment school Read chapters 5 and 6 History 2026-11-04 true true Taylor (My day)',
               'Quick: an assignment marked from school (added_by school): its title, class and due date, given by her');
:as_anon
select test.is((:'q'::jsonb -> 'now' ->> 'title') || ' ' || (:'q'::jsonb -> 'now' ->> 'minutes') || ' ' || (:'q'::jsonb -> 'now' ->> 'day'),
               'Read chapters 5 and 6 20 2026-11-02', '... with one step of her minutes tonight: her Now');
select test.is(pg_temp.titles(:'q'::jsonb -> 'from_school'), 'Lab report: water filters | Vocabulary quiz | Poem | Essay: a person who changed a town',
               '... and it leaves New from school');
select test.is(pg_temp.keys(pg_temp.el(:'q'::jsonb -> 'assignments', 'Read chapters 5 and 6')),
               'added_by,ai_help,behind,due_date,given_by,horizon,id,kind,minutes_left,next_milestone,no_time,plan_rev,school,state,status,steps,stretch,subject,time_left,title',
               '... in her assignments, with the school''s marks');
select test.is(pg_temp.el(:'q'::jsonb -> 'assignments', 'Read chapters 5 and 6') -> 'school', '{"gone": false, "moved_to": null}'::jsonb,
               '... still on the school site, its date not moved');
:as_owner
select test.is((select count(*) from assignments where title = 'Read chapters 5 and 6')
                 || ' ' || (select count(*) from homework_steps s join assignments a on a.id = s.assignment_id where a.title = 'Read chapters 5 and 6'),
               '1 1', '... one assignment, one step');
:as_anon
select test.is(school_item_by_token(test.token('Taylor'), pg_temp.iid('Read chapters 5 and 6'), 'quick', 20) ->> 'assignment_id',
               :'q'::jsonb ->> 'assignment_id', 'a resent Quick finds the same assignment');
:as_owner
select test.is((select count(*) from assignments where title = 'Read chapters 5 and 6')
                 || ' ' || (select count(*) from homework_steps s join assignments a on a.id = s.assignment_id where a.title = 'Read chapters 5 and 6'),
               '1 1', '... and makes no second one, nor a second step');
:as_anon
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''hide'')', test.token('Taylor'), pg_temp.iid('Read chapters 5 and 6'))),
               'P0001 That one is on your homework already.', 'Hide on one already made an assignment is refused');
-- Quick for one due in 14 days: "Plan this one with Pat.", and nothing is made.
select test.is(pg_temp.run(format('select school_item_by_token(%L, %L, ''quick'', 15)', test.token('Taylor'), pg_temp.iid('Essay: a person who changed a town'))),
               '42501 Plan this one with Pat.', 'Quick on one due in 14 days: "Plan this one with Pat."');
:as_owner
select test.is((select count(*) from assignments where title like 'Essay%') || ' ' || ((pg_temp.item('Essay: a person who changed a town')).made_at is null),
               '0 true', '... and nothing was made');
:as_anon
-- Plan with Pat.
select school_item_by_token(test.token('Taylor'), pg_temp.iid('Essay: a person who changed a town'), 'with_tutor') as wt \gset
select :'wt'::jsonb ->> 'assignment_id' as wt_id \gset
:as_owner
select test.is((select a.added_by || ' ' || a.due_date || ' ' || (a.given_at is null) || ' ' || (select count(*) from homework_steps s where s.assignment_id = a.id)
                from assignments a where a.id = (:'wt'::jsonb ->> 'assignment_id')::uuid),
               'school 2026-11-16 true 0', 'Plan with Pat: an assignment from school, no plan yet');
:as_anon
select test.is(pg_temp.el(:'wt'::jsonb -> 'assignments', 'Essay: a person who changed a town') ->> 'state', 'none', '... on her list as not planned yet');
select test.is(school_item_by_token(test.token('Taylor'), pg_temp.iid('Essay: a person who changed a town'), 'with_tutor') ->> 'assignment_id',
               :'wt'::jsonb ->> 'assignment_id', '... a resend finds it');
select tutor_view_by_token(pg_temp.pat()) as pv \gset
select test.is(pg_temp.el(:'pv'::jsonb -> 'assignments', 'Essay: a person who changed a town') ->> 'added_by', 'school', 'the tutor sees it, added by the school');
select test.is(pg_temp.el(:'pv'::jsonb -> 'assignments', 'Essay: a person who changed a town') -> 'school', '{"gone": false, "moved_to": null}'::jsonb,
               '... with the school''s marks');
select test.is(pg_temp.keys(:'pv'::jsonb), 'ai,as_of,assignments,ends_on,kid,language,pace,plans,questions,record,server_now,to_check,to_talk_about,today,tutor,week',
               '... and the tutor''s view keeps its keys (no New from school there)');
select test.is(tutor_view_by_token(pg_temp.pat(), (:'wt'::jsonb ->> 'assignment_id')::uuid) -> 'assignment' -> 'school',
               '{"gone": false, "moved_to": null}'::jsonb, '... and the marks with p_assignment');
-- A parent's Add, with the description as the teacher's text.
:as_admin
select school_item_action(pg_temp.iid('Lab report: water filters'), 'add') ->> 'assignment_id' as lab \gset
select test.is((select added_by || ' ' || due_date || ' ' || details || ' ' || created_by from assignments where id = :'lab'),
               E'school 2026-11-05 Write up the lab.\nUse the template on the class page. alex@example.com',
               'a parent''s Add: an assignment from school, the description as its teacher''s text');
:as_anon
select test.ok(strpos(homework_by_token(test.token('Taylor'))::text, 'Use the template') = 0, 'her view never carries the description');

-- ---------------------------------------------------------------------
-- The next read: school changes reach an assignment unless a person changed that field
-- ---------------------------------------------------------------------
:as_admin
update assignments set title = 'Essay: my town' where id = :'wt_id';
:as_owner
set hub.now = '2026-11-02 10:23 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-101@academy.school.example", "title": "Lab report: water filters (final)", "subject": "Biology",
   "details": "Write up the lab.\nUse the template on the class page.\nDue at the start of class.", "first_day": "2026-11-06", "last_day": "2026-11-06"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"uid": "a-103@academy.school.example", "title": "Essay: a person who changed our town", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-17"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-11-09", "last_day": "2026-11-09"},
  {"uid": "a-106@academy.school.example", "title": "Poem", "subject": "English", "first_day": "2026-11-12", "last_day": "2026-11-12"}
]') as r2 \gset
select test.is((:'r2'::jsonb ->> 'kept') || ' ' || (:'r2'::jsonb ->> 'added'), '5 0', 'a second read: five kept, none new');
select test.is((select title || ' ' || due_date || ' ' || details from assignments where id = :'lab'),
               E'Lab report: water filters (final) 2026-11-06 Write up the lab.\nUse the template on the class page.\nDue at the start of class.',
               'an assignment nobody changed follows the school: its title, due date and description');
select test.is((select title || ' ' || due_date || ' ' || updated_by from assignments where id = :'wt_id'), 'Essay: my town 2026-11-17 school link',
               'a title a parent changed is never overwritten; its due date (not changed, no plan) still follows');
select test.is((select due_date from assignments where id = (:'q'::jsonb ->> 'assignment_id')::uuid), '2026-11-04'::date,
               'a planned assignment''s due date doesn''t move by itself ...');
:as_anon
select test.is(pg_temp.el(homework_by_token(test.token('Taylor')) -> 'assignments', 'Read chapters 5 and 6') -> 'school',
               '{"gone": false, "moved_to": "2026-11-05"}'::jsonb, '... it is marked: the school''s date moved to Thu Nov 5');
:as_admin
select test.is((school_feed_status(test.person('Taylor')) -> 'moved' -> 0) - 'assignment_id',
               '{"title": "Read chapters 5 and 6", "from": "2026-11-04", "to": "2026-11-05"}'::jsonb, '... and the parents see "Due date moved"');
select test.is((select count(*) from school_items where title = 'Vocabulary quiz') || ' ' || (pg_temp.item('Vocabulary quiz')).due_date
                 || ' ' || (pg_temp.item('Vocabulary quiz')).missing,
               '1 2026-11-09 0', 'an item without a UID whose date moved is the same item, with the new date (not one gone and one new)');
-- A parent moves the date of an assignment from school: from then on the school's date for it doesn't move it.
update assignments set due_date = '2026-11-10' where id = :'lab';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-101@academy.school.example", "title": "Lab report: water filters (final)", "subject": "Biology",
   "details": "Write up the lab.\nUse the template on the class page.\nDue at the start of class.", "first_day": "2026-11-11", "last_day": "2026-11-11"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"uid": "a-103@academy.school.example", "title": "Essay: a person who changed our town", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-17"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-11-09", "last_day": "2026-11-09"}
]');
select test.is((select due_date from assignments where id = :'lab'), '2026-11-10'::date, 'a due date a parent set is never overwritten');
select test.is((select missing || ' ' || (gone_at is null) from school_items where title = 'Poem'), '1 true',
               'an item absent from one good read: missing once, still on the list');
:as_anon
select test.ok(pg_temp.el(homework_by_token(test.token('Taylor')) -> 'from_school', 'Poem') is not null, '... and still new for her');

-- A failed read, and an empty one, count for nothing.
:as_service
select test.is(pg_temp.read('Taylor', 'assignments', '[]', 'timeout') ->> 'stop', 'timeout', 'a failed read is stored as its fixed code');
select test.is(pg_temp.read('Taylor', 'assignments', '[]') ->> 'stop', 'empty',
               'a read with nothing in it, when there were 3 or more: "empty", not applied');
:as_owner
select test.is((select count(*) || ' ' || sum(missing) || ' ' || count(gone_at) from school_items i join school_feeds f on f.id = i.feed_id
                where f.kid_id = test.person('Taylor')), '5 1 0', '... neither changes an item');
select test.is((select last_stop || ' ' || fails from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid),
               'empty 2', '... each counts as a failure on the link');
-- The second good read without it: no longer on the school site.
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-101@academy.school.example", "title": "Lab report: water filters (final)", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-11-09", "last_day": "2026-11-09"}
]') as r4 \gset
select test.is((:'r4'::jsonb ->> 'gone')::int, 1, 'two good reads without it: one item gone (the poem)');
select test.is((select (gone_at is not null) || ' ' || missing from school_items where title = 'Poem'), 'true 2', '... marked, not deleted');
select test.is((select missing from school_items where title like 'Essay%'), 1, '... the essay (made an assignment) is missing once');
:as_anon
select test.ok(pg_temp.el(homework_by_token(test.token('Taylor')) -> 'from_school', 'Poem') is null, '... the poem leaves her New from school');
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-101@academy.school.example", "title": "Lab report: water filters (final)", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-11-09", "last_day": "2026-11-09"}
]');
:as_anon
select test.is(pg_temp.el(homework_by_token(test.token('Taylor')) -> 'assignments', 'Essay: my town') -> 'school', '{"gone": true, "moved_to": null}'::jsonb,
               'an assignment whose school item is gone stays, marked "no longer on the school site"');
:as_admin
select test.is(pg_temp.titles(school_feed_status(test.person('Taylor')) -> 'gone'), 'Essay: my town', '... and the parents see it');
select test.is((select status from assignments where id = :'wt_id'), 'open', '... it is never deleted or closed by the feed');
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-101@academy.school.example", "title": "Lab report: water filters (final)", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"uid": "a-106@academy.school.example", "title": "Poem", "subject": "English", "first_day": "2026-11-12", "last_day": "2026-11-12"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-11-09", "last_day": "2026-11-09"}
]');
select test.is((select (gone_at is null) || ' ' || missing from school_items where title = 'Poem'), 'true 0', 'an item that comes back is on the list again');
-- An item that ages out of the window isn't "missing" (it is let go once it is past and nobody made it an assignment).
:as_owner
set hub.now = '2026-11-28 10:23 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-201@academy.school.example", "title": "Map of the river", "subject": "Geography", "first_day": "2026-12-02", "last_day": "2026-12-02"}
]');
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-201@academy.school.example", "title": "Map of the river", "subject": "Geography", "first_day": "2026-12-02", "last_day": "2026-12-02"}
]');
:as_owner
select test.is((select string_agg(title || ' ' || missing || ' ' || (gone_at is not null), ' | ' order by title) from school_items i
                join school_feeds f on f.id = i.feed_id where f.kid_id = test.person('Taylor')),
               'Essay: a person who changed our town 2 true | Lab report: water filters (final) 0 false | Map of the river 0 false | '
               'Read chapters 5 and 6 0 false',
               'items whose date passed out of the window aren''t counted missing; the poem and the quiz (past, never made assignments) are let go');
set hub.now = '2026-11-02 11:23 America/New_York';

-- ---------------------------------------------------------------------
-- Stops, the caps and the backoff
-- ---------------------------------------------------------------------
:as_owner
update school_feeds set fails = 0, last_stop = null where id = (:'added'::jsonb ->> 'id')::uuid;
:as_service
select test.is(pg_temp.read('Taylor', 'assignments',
                 (select jsonb_agg(jsonb_build_object('uid', 'n-' || g, 'title', 'Worksheet ' || g, 'first_day', '2026-11-20', 'last_day', '2026-11-20'))
                  from generate_series(1, 401) g)) ->> 'stop', 'too_many', '401 assignments in one read: too_many, nothing applied');
:as_owner
select test.is((select count(*) from school_items where title like 'Worksheet %'), 0::bigint, '... none stored');
select test.is((select fails || ' ' || (next_at = private.now() + interval '50 minutes') from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid),
               '1 true', '... after the first failure the next read is at the next hourly run (in 50 minutes)');
:as_service
select pg_temp.read('Taylor', 'assignments', '[]', 'unreachable');
:as_owner
select test.is((select fails || ' ' || (next_at = private.now() + interval '110 minutes') from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid),
               '2 true', '... after the second, about 2 hours');
:as_service
select pg_temp.read('Taylor', 'assignments', '[]', 'down');
select pg_temp.read('Taylor', 'assignments', '[]', 'down');
:as_owner
select test.is((select fails || ' ' || (next_at = private.now() + interval '470 minutes') from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid),
               '4 true', '... 4 hours after the third, then 8 hours');
:as_service
select test.is(pg_temp.read('Taylor', 'assignments', '[]', 'error sending request for url (https://academy.school.example/podium/feed/iCal.aspx?z=SECRETMARKER)') ->> 'stop',
               'error', 'a stop that isn''t one of the fixed codes is stored as "error"');
:as_owner
select test.ok(strpos((select string_agg(to_jsonb(f)::text, ' ') from school_feeds f), 'SECRETMARKER') = 0, '... and its text is kept nowhere');
select test.is((select string_agg(conname, ',') from pg_constraint where conrelid = 'public.school_feeds'::regclass and conname like '%last_stop%'),
               'school_feeds_last_stop_check', 'school_feeds.last_stop takes only the fixed codes (a check)');
:as_service
select test.is(pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-101@academy.school.example", "title": "Lab report: water filters (final)", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-11-09", "last_day": "2026-11-09"}
]', null, 2) ->> 'stored', 'true', 'a good read ...');
:as_owner
select test.is((select fails || ' ' || coalesce(last_stop, '-') || ' ' || last_repeats || ' ' || (next_at = private.now() + interval '50 minutes')
                from school_feeds where id = (:'added'::jsonb ->> 'id')::uuid),
               '0 - 2 true', '... clears the failures, and notes the repeating events it didn''t expand');

-- ---------------------------------------------------------------------
-- Schedule and Games/Practices: busy time (free_minutes)
-- ---------------------------------------------------------------------
:as_service
select test.is(pg_temp.read('Taylor', 'schedule', '[
  {"uid": "s-1@academy.school.example", "title": "Orchestra rehearsal", "starts_at": "2026-11-03T21:00:00Z", "ends_at": "2026-11-03T21:45:00Z"},
  {"uid": "s-2@academy.school.example", "title": "Biology - 2 (B)", "starts_at": "2026-11-02T13:15:00Z", "ends_at": "2026-11-02T14:00:00Z"},
  {"uid": "s-3@academy.school.example", "title": "Far away", "starts_at": "2027-02-01T21:00:00Z", "ends_at": "2027-02-01T22:00:00Z"},
  {"uid": "s-4@academy.school.example", "title": "No time", "first_day": "2026-11-03", "last_day": "2026-11-03"},
  {"uid": "s-5@academy.school.example", "title": "Backwards", "starts_at": "2026-11-05T21:00:00Z", "ends_at": "2026-11-05T20:00:00Z"}
]') ->> 'kept', '3', 'a Schedule read keeps timed items inside 56 days (an all-day item and one far off are left out)');
select pg_temp.read('Taylor', 'games', '[
  {"uid": "g-1@academy.school.example", "title": "Soccer game", "starts_at": "2026-11-04T21:15:00Z", "ends_at": "2026-11-04T23:00:00Z"}
]');
:as_owner
select test.is((select key = md5('uid:s-1@academy.school.example|2026-11-03T21:00:00') from school_items where title = 'Orchestra rehearsal'), true,
               'a schedule item''s key is its UID and its start');
select test.is((select ends_at is null from school_items where title = 'Backwards'), true, 'an end before the start is dropped (an hour long, as agenda counts it)');
:as_admin
select homework_week(test.person('Taylor'), '2026-11-02', 4) as wk \gset
select test.is((select string_agg((x ->> 'day') || ' ' || (x ->> 'free') || ' ' || (x -> 'busy')::text, ' | ' order by n)
                from jsonb_array_elements(:'wk'::jsonb) with ordinality t (x, n)),
               '2026-11-02 45 [] | 2026-11-03 15 [{"ends": "16:45", "title": "Orchestra rehearsal", "starts": "16:00"}] | '
               '2026-11-04 0 [{"ends": "18:00", "title": "Soccer game", "starts": "16:15"}] | '
               '2026-11-05 0 [{"ends": "17:00", "title": "Backwards", "starts": "16:00"}]',
               'busy time: the rehearsal (to 4:45, and 15 minutes after) leaves 15 minutes on Tuesday; the game takes Wednesday''s; a class at 8:15 none');
:as_anon
select test.is((select string_agg((x ->> 'day') || ' ' || (x ->> 'free') || ' ' || (x -> 'busy')::text, ' | ' order by n)
                from jsonb_array_elements(tutor_view_by_token(pg_temp.pat()) -> 'week') with ordinality t (x, n)
                where (x ->> 'day') in ('2026-11-03', '2026-11-04')),
               '2026-11-03 15 [{"ends": "16:45", "starts": "16:00"}] | 2026-11-04 0 [{"ends": "18:00", "starts": "16:15"}]',
               'the tutor''s week shows them as Busy, without titles');
-- Placement uses it: Quick for the lab report (due Wed Nov 11) goes on the first homework day with room.
:as_owner
set hub.now = '2026-11-02 18:00 America/New_York';   -- Monday's homework time is over
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-301@academy.school.example", "title": "Graph the results", "subject": "Biology", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"uid": "a-101@academy.school.example", "title": "Lab report: water filters (final)", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-05", "last_day": "2026-11-05"}
]');
:as_anon
select school_item_by_token(test.token('Taylor'), pg_temp.iid('Graph the results'), 'quick', 20) as g \gset
:as_owner
select test.is((select s.day from homework_steps s join assignments a on a.id = s.assignment_id where a.title = 'Graph the results'), '2026-11-03'::date,
               'placement counts busy time: with no day before it''s due that has 20 minutes, Quick takes the one with the most room (Tuesday''s 15, not the game''s Wednesday)');
:as_anon
select test.is((select fits from (select (school_item_by_token(test.token('Taylor'), pg_temp.iid('Graph the results'), 'quick', 20) -> 'assignments') a) x
                cross join lateral (select (pg_temp.el(x.a, 'Graph the results') ->> 'time_left')::int = 15 as fits) y), true,
               '... and her bars say 15 minutes of homework time left before it''s due');
-- Two good reads without the rehearsal: it is no longer busy (a schedule item gone is deleted).
:as_service
select pg_temp.read('Taylor', 'schedule', '[{"uid": "s-2@academy.school.example", "title": "Biology - 2 (B)", "starts_at": "2026-11-09T14:15:00Z", "ends_at": "2026-11-09T15:00:00Z"}]');
select pg_temp.read('Taylor', 'schedule', '[{"uid": "s-2@academy.school.example", "title": "Biology - 2 (B)", "starts_at": "2026-11-09T14:15:00Z", "ends_at": "2026-11-09T15:00:00Z"}]');
:as_owner
select test.is((select string_agg(title, ', ' order by title) from school_items i join school_feeds f on f.id = i.feed_id where f.kind = 'schedule'),
               'Biology - 2 (B)', 'schedule items not in two good reads are deleted (only busy time)');

-- ---------------------------------------------------------------------
-- Pause, homework off, Remove, Erase
-- ---------------------------------------------------------------------
:as_admin
select test.throws(format('select pause_school_feed(%L, true)', gen_random_uuid()), 'That school link isn''t there any more.', 'Pause: an unknown link');
select pause_school_feed((:'games'::jsonb ->> 'id')::uuid, true);
:as_adult
select test.throws(format('select pause_school_feed(%L, false)', :'games'::jsonb ->> 'id'), 'Only a parent can change homework.', 'Sam can''t pause a link');
:as_owner
update school_feeds set next_at = private.now() - interval '3 hours';
:as_service
select school_begin() as b2 \gset
select test.is((select string_agg(x ->> 'kind', ',' order by x ->> 'kind') from jsonb_array_elements(:'b2'::jsonb -> 'feeds') x
                join school_feeds f on f.id = (x ->> 'feed_id')::uuid where f.kid_id = test.person('Taylor')),
               'assignments,schedule', 'a paused link isn''t read');
select school_finish((:'b2'::jsonb ->> 'run_id')::uuid);
:as_admin
select test.is((select string_agg((x ->> 'kind') || ' ' || (x ->> 'stale') || ' ' || (x ->> 'paused'), ', ' order by n)
                from jsonb_array_elements(school_feed_status(test.person('Taylor')) -> 'feeds') with ordinality t (x, n)),
               'assignments true false, schedule true false, games false true',
               'a link due for over 2 hours and not read is stale ("run supabase/cron.sql again"); a paused one isn''t');
select save_homework_kid(test.person('Taylor'), false);
:as_service
select school_begin() as b3 \gset
select test.is((select count(*) from jsonb_array_elements(:'b3'::jsonb -> 'feeds') x
                join school_feeds f on f.id = (x ->> 'feed_id')::uuid where f.kid_id = test.person('Taylor')), 0::bigint,
               'with homework off for her, none of her links is read');
select school_finish((:'b3'::jsonb ->> 'run_id')::uuid);
:as_anon
select test.is(school_item_by_token(test.token('Taylor'), pg_temp.iid('Vocabulary quiz'), 'hide'), null, '... and her token answers null');
:as_admin
select save_homework_kid(test.person('Taylor'), true);
select test.is(set_school_feed(test.person('Taylor'), 'assignments', null), null, 'Remove (no address) answers null');
-- Remove deletes the address and every item no one made an assignment; the items made assignments stay
-- (on the link's row, kept for them but no longer a link), so adding the link again doesn't show them as new.
:as_owner
select test.is((select count(*) || ' ' || bool_and(removed_at is not null) from school_feeds where kid_id = test.person('Taylor') and kind = 'assignments')
                 || ' ' || (select count(*) from private.school_feed_urls u where u.feed_id = (:'added'::jsonb ->> 'id')::uuid)
                 || ' ' || (select string_agg(title, ' | ' order by title) from school_items where feed_id = (:'added'::jsonb ->> 'id')::uuid)
                 || ' ' || (select count(*) from school_items where feed_id = (:'added'::jsonb ->> 'id')::uuid and made_at is null),
               '1 true 0 Essay: a person who changed our town | Graph the results | Lab report: water filters (final) | Read chapters 5 and 6 0',
               '... the address and the items nobody made an assignment go; the four made assignments stay, on a row marked removed');
:as_admin
select test.is((select string_agg(x ->> 'kind', ',' order by n) from jsonb_array_elements(school_feed_status(test.person('Taylor')) -> 'feeds') with ordinality t (x, n)),
               'schedule,games', '... and the status card no longer shows it');
select test.is((select string_agg(title || ' ' || added_by || ' ' || status, ' | ' order by title) from assignments where kid_id = test.person('Taylor')),
               'Essay: my town school open | Graph the results school open | Lab report: water filters (final) school open | Read chapters 5 and 6 school open',
               '... and the assignments made from it stay, marked from school');
:as_admin
select erase_homework(test.person('Taylor'), 'ERASE');
:as_owner
select test.is((select count(*) from school_feeds where kid_id = test.person('Taylor'))
                 || ' ' || (select count(*) from private.school_feed_urls u join school_feeds f on f.id = u.feed_id)
                 || ' ' || (select count(*) from school_items),
               '0 1 1', 'Erase deletes her links, their addresses and items (Robin''s stay)');

-- ---------------------------------------------------------------------
-- Row-level security and grants (§12)
-- ---------------------------------------------------------------------
:as_anon
select test.is(test.try('select * from public.school_feeds') || ' ' || test.try('select * from public.school_items'), 'denied denied', 'anon reads neither table');
:as_stranger
select test.is(test.try('select * from public.school_feeds') || ' ' || test.try('select * from public.school_items'), 'rows:0 rows:0', 'a stranger sees no rows');
:as_adult
select test.is(test.try('select * from public.school_feeds') || ' ' || test.try('select * from public.school_items'), 'rows:1 rows:1', 'Sam reads them');
select test.is(test.try('update public.school_items set hidden = true') || ' ' || test.try('delete from public.school_feeds')
                 || ' ' || test.try($$insert into public.school_feeds (kid_id, kind, host, url_end) values (test.person('Robin'), 'games', 'x.school.example', 'abcd')$$),
               'denied denied denied', '... and writes neither');
:as_admin
select test.is(test.try('update public.school_items set hidden = true') || ' ' || test.try('update public.school_feeds set checked = true')
                 || ' ' || test.try('delete from public.school_items'),
               'denied denied denied', 'a parent writes them only through the functions');
:as_owner
select test.is((select string_agg(t || ' ' || x, ', ' order by t, x)
                from unnest(array['school_feeds', 'school_items']) t cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate']) x
                where has_table_privilege('authenticated', 'public.' || t, x)), 'school_feeds select, school_items select',
               'signed-in users: select only');
select test.is((select string_agg(r, ', ') from unnest(array['anon', 'authenticated', 'service_role']) r
                where has_table_privilege(r, 'private.school_sync', 'select, insert, update, delete, truncate, references, trigger')),
               null, 'private.school_sync: no privilege for anyone but its owner');

-- =====================================================================
-- Review fixes, on Robin's links (Taylor's were erased above): the description's retention, a run that
-- dies partway, items without a UID (the class in the key, the moved-item step), Remove and Add again,
-- Resume and homework back on. hub.now is 6:00pm on Mon Nov 2 here, then moves.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The teacher's text is emptied 30 days after the due date on the item too (§11.3, §13.3)
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-02 19:00 America/New_York';
:as_service
select pg_temp.read('Robin', 'assignments', '[
  {"uid": "r-1", "title": "Robin''s map", "subject": "Geography", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"uid": "r-2", "title": "Goggles lab", "subject": "Chemistry", "details": "Teacher text: bring goggles.", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"uid": "r-3", "title": "Field notes", "subject": "Biology", "details": "Teacher text: three pages.", "first_day": "2026-11-06", "last_day": "2026-11-06"}
]');
:as_admin
select check_school_feed((:'robin'::jsonb ->> 'id')::uuid, 'end', 0) is not null;
select school_item_action(pg_temp.iid('Goggles lab'), 'add') ->> 'assignment_id' as goggles \gset
-- Paused, so no read (school_store) runs for the link from here on.
select pause_school_feed((:'robin'::jsonb ->> 'id')::uuid, true);
:as_owner
select test.is((select details || ' ' || (applied ->> 'details') from school_items where title = 'Goggles lab'),
               'Teacher text: bring goggles. Teacher text: bring goggles.', 'an item made an assignment keeps the description, and so does what the feed wrote (applied)');
set hub.now = '2026-12-05 09:00 America/New_York';   -- 30 days after Nov 5
:as_service
select school_finish((school_begin() ->> 'run_id')::uuid);
:as_owner
select test.is((select details from school_items where title = 'Goggles lab'), 'Teacher text: bring goggles.', '30 days after the due date the item still has it');
select test.is((select string_agg(title, ' | ' order by title) from school_items where feed_id = (:'robin'::jsonb ->> 'id')::uuid), 'Goggles lab',
               '... and past items nobody made an assignment are let go by the hourly run, even on a paused link');
set hub.now = '2026-12-06 09:00 America/New_York';   -- 31 days after
:as_service
select school_finish((school_begin() ->> 'run_id')::uuid);
:as_owner
select test.is((select coalesce(details, '-') || ' ' || coalesce(applied ->> 'details', '-') || ' ' || (applied ? 'details') || ' ' || (applied ->> 'title')
                from school_items where title = 'Goggles lab'),
               '- - true Goggles lab', 'the next day the hourly run empties it on the item and in applied (the rest of applied stays), paused link and all');
:as_adult
select test.is((select coalesce(details, '-') || ' ' || coalesce(applied ->> 'details', '-') from school_items where title = 'Goggles lab'), '- -',
               '... so Sam (a member, reading the table) gets neither');
:as_owner
select private.homework_trim(test.person('Robin'));
:as_admin
select pause_school_feed((:'robin'::jsonb ->> 'id')::uuid, false);
:as_service
select pg_temp.read('Robin', 'assignments', '[{"uid": "r-4", "title": "Spelling list", "subject": "English", "first_day": "2026-12-08", "last_day": "2026-12-08"}]');
:as_owner
select test.is((select coalesce(a.details, '-') || ' ' || coalesce(i.details, '-') || ' ' || coalesce(i.applied ->> 'details', '-')
                from assignments a join school_items i on i.assignment_id = a.id where a.id = :'goggles'),
               '- - -', '... and once the assignment''s own copy is trimmed, a later read writes none of it back');

-- ---------------------------------------------------------------------
-- A run that dies partway (the Edge Function stopped): the link it was reading backs off, the others are read
-- ---------------------------------------------------------------------
:as_admin
select set_school_feed(test.person('Robin'), 'schedule', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=R5r6S7s8R9r0S1s2') ->> 'id' as r_sched \gset
select set_school_feed(test.person('Robin'), 'games', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=R3r4G5g6R7r8G9g0') ->> 'id' as r_games \gset
:as_owner
set hub.now = '2026-12-07 10:23 America/New_York';
update school_feeds set next_at = private.now() - interval '3 minutes' where id = (:'robin'::jsonb ->> 'id')::uuid;
update school_feeds set next_at = private.now() - interval '2 minutes' where id = :'r_sched';
update school_feeds set next_at = private.now() - interval '1 minute' where id = :'r_games';
:as_service
select school_begin() as d1 \gset
select test.is((select string_agg(x ->> 'kind', ',' order by n) from jsonb_array_elements(:'d1'::jsonb -> 'feeds') with ordinality t (x, n)),
               'assignments,schedule,games', 'a run is handed the due links, the longest due first');
-- It dies reading the first: nothing stored, no school_finish. An hour later the lease has run out.
:as_owner
set hub.now = '2026-12-07 11:23 America/New_York';
:as_service
select school_begin() as d2 \gset
select test.is((:'d2'::jsonb ->> 'go') || ' ' || (select string_agg(x ->> 'kind', ',' order by n) from jsonb_array_elements(:'d2'::jsonb -> 'feeds') with ordinality t (x, n)),
               'true schedule,games', 'the next run isn''t handed the link the dead run was reading first again: the others are read');
:as_owner
select test.is((select last_stop || ' ' || fails || ' ' || (last_try_at = private.now()) || ' ' || (next_at = private.now() + interval '50 minutes')
                from school_feeds where id = (:'robin'::jsonb ->> 'id')::uuid),
               'error 1 true true', '... that link is a failed read (error), backed off like any failure');
:as_admin
select test.is((select string_agg((x ->> 'kind') || ' ' || coalesce(x ->> 'last_stop', '-') || ' ' || (x ->> 'stale'), ', ' order by n)
                from jsonb_array_elements(school_feed_status(test.person('Robin')) -> 'feeds') with ordinality t (x, n)),
               'assignments error false, schedule - false, games - false', '... and the status card says so, not "stale" (run cron.sql again)');
-- This run stores the schedule link, then dies too: the games link, next in line and never stored, is the one marked.
:as_service
select test.is(school_store((:'d2'::jsonb ->> 'run_id')::uuid, :'r_sched'::uuid, '[]', null) ->> 'stored', 'true', 'the next run stores one link, then dies');
:as_owner
set hub.now = '2026-12-07 12:23 America/New_York';
:as_service
select school_begin() as d3 \gset
:as_owner
select test.is((select string_agg(kind || ' ' || coalesce(last_stop, '-') || ' ' || fails, ', ' order by kind) from school_feeds where kid_id = test.person('Robin')),
               'assignments error 1, games error 1, schedule - 0', '... the link it was reading is marked; the one it stored isn''t');
select test.is((select string_agg(x ->> 'kind', ',' order by n) from jsonb_array_elements(:'d3'::jsonb -> 'feeds') with ordinality t (x, n)),
               'schedule,assignments', '... and of the links due, those that are reading well go first');
-- A run that ends normally (school_finish) after running out of time: the link it didn't reach isn't marked.
:as_service
select school_store((:'d3'::jsonb ->> 'run_id')::uuid, :'r_sched'::uuid, '[]', null);
select school_finish((:'d3'::jsonb ->> 'run_id')::uuid);
:as_owner
set hub.now = '2026-12-07 13:23 America/New_York';
:as_service
select school_finish((school_begin() ->> 'run_id')::uuid);
:as_owner
select test.is((select last_stop || ' ' || fails from school_feeds where id = (:'robin'::jsonb ->> 'id')::uuid), 'error 1',
               'a link a finished run didn''t reach (out of time) counts no failure');

-- ---------------------------------------------------------------------
-- Items without a UID: the class is part of the key; the moved-item step takes only an item the last good
-- read saw, inside the window, of the same class
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-12-07 14:23 America/New_York';   -- a Monday
:as_service
select test.is(pg_temp.read('Robin', 'assignments', '[
  {"title": "Homework", "subject": "Math 7", "first_day": "2026-12-10", "last_day": "2026-12-10"},
  {"title": "Homework", "subject": "Science 7", "first_day": "2026-12-10", "last_day": "2026-12-10"},
  {"title": "Reading log", "subject": "English", "first_day": "2026-12-11", "last_day": "2026-12-11"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-12-11", "last_day": "2026-12-11"},
  {"uid": "r-4", "title": "Spelling list", "subject": "English", "first_day": "2026-12-08", "last_day": "2026-12-08"}
]') ->> 'kept', '5', 'two classes'' "Homework" due the same day, without UIDs: both kept');
:as_owner
select test.is((select string_agg(subject || ' ' || (key = md5('title:' || lower(subject) || E'\n' || 'homework|2026-12-10')), ', ' order by subject)
                from school_items where title = 'Homework'),
               'Math 7 true, Science 7 true', '... two items, each keyed by its class, its title and its first day');
select id as math_hw from school_items where title = 'Homework' and subject = 'Math 7' \gset
:as_admin
select school_item_action(pg_temp.iid('Vocabulary quiz'), 'add') ->> 'assignment_id' as quiz \gset
:as_anon
select test.ok(school_item_by_token(test.token('Robin'), pg_temp.iid('Reading log'), 'hide') is not null, 'Robin hides the reading log');
-- An hour later the Math homework moved a day; the Science one didn't.
:as_owner
set hub.now = '2026-12-07 15:23 America/New_York';
:as_service
select test.is(pg_temp.read('Robin', 'assignments', '[
  {"title": "Homework", "subject": "Math 7", "first_day": "2026-12-11", "last_day": "2026-12-11"},
  {"title": "Homework", "subject": "Science 7", "first_day": "2026-12-10", "last_day": "2026-12-10"},
  {"title": "Reading log", "subject": "English", "first_day": "2026-12-11", "last_day": "2026-12-11"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-12-11", "last_day": "2026-12-11"},
  {"uid": "r-4", "title": "Spelling list", "subject": "English", "first_day": "2026-12-08", "last_day": "2026-12-08"}
]') ->> 'added', '0', 'a no-UID item whose date moved is still the same item ...');
:as_owner
select test.is((select string_agg(subject || ' ' || due_date, ', ' order by subject) from school_items where title = 'Homework')
                 || ' ' || (select (id = :'math_hw') from school_items where title = 'Homework' and subject = 'Math 7'),
               'Math 7 2026-12-11, Science 7 2026-12-10 true', '... the Math one keeps its row with the new date; the Science one is untouched');
-- Another class's "Homework" isn't the Math one moved.
:as_service
select test.is(pg_temp.read('Robin', 'assignments', '[
  {"title": "Homework", "subject": "Science 7", "first_day": "2026-12-10", "last_day": "2026-12-10"},
  {"title": "Homework", "subject": "Art 7", "first_day": "2026-12-12", "last_day": "2026-12-12"},
  {"title": "Reading log", "subject": "English", "first_day": "2026-12-11", "last_day": "2026-12-11"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-12-11", "last_day": "2026-12-11"},
  {"uid": "r-4", "title": "Spelling list", "subject": "English", "first_day": "2026-12-08", "last_day": "2026-12-08"}
]') ->> 'added', '1', 'a new "Homework" of another class is a new item ...');
:as_owner
select test.is((select missing || ' ' || due_date || ' ' || (id = :'math_hw') from school_items where title = 'Homework' and subject = 'Math 7'),
               '1 2026-12-11 true', '... and the Math one, absent, is missing once (not taken over)');
-- Three weeks on, the same weekly titles come again. Last time's are past the window: new items, not those moved.
set hub.now = '2026-12-29 10:23 America/New_York';
:as_service
select test.is(pg_temp.read('Robin', 'assignments', '[
  {"title": "Reading log", "subject": "English", "first_day": "2027-01-04", "last_day": "2027-01-04"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2027-01-04", "last_day": "2027-01-04"}
]') ->> 'added', '2', 'next month''s "Reading log" and "Vocabulary quiz" (no UIDs) are two new items');
:as_owner
select test.is((select string_agg(due_date || ' ' || (made_at is not null) || ' ' || coalesce((assignment_id = :'quiz')::text, '-'), ', ' order by due_date)
                from school_items where title = 'Vocabulary quiz'),
               '2026-12-11 true true, 2027-01-04 false -', '... the quiz made an assignment keeps its row and its date');
select test.is((select due_date || ' ' || status || ' ' || coalesce(updated_by, '-') from assignments where id = :'quiz'), '2026-12-11 open alex@example.com',
               '... and its open assignment''s due date doesn''t move');
:as_anon
select test.is((select string_agg((x ->> 'title') || ' ' || (x ->> 'due_date'), ', ' order by n)
                from jsonb_array_elements(homework_by_token(test.token('Robin')) -> 'from_school') with ordinality t (x, n)),
               'Reading log 2027-01-04, Vocabulary quiz 2027-01-04', '... the new ones are New from school for Robin, the reading log not hidden');

-- ---------------------------------------------------------------------
-- Remove keeps what was made an assignment; adding the link again doesn't bring it back as new
-- ---------------------------------------------------------------------
:as_service
select pg_temp.read('Robin', 'assignments', '[
  {"uid": "r-101", "title": "Lab report", "subject": "Biology", "first_day": "2027-01-05", "last_day": "2027-01-05"},
  {"uid": "r-102", "title": "Read chapter 5", "subject": "History", "first_day": "2027-01-06", "last_day": "2027-01-06"},
  {"title": "Reading log", "subject": "English", "first_day": "2027-01-04", "last_day": "2027-01-04"}
]');
:as_anon
select school_item_by_token(test.token('Robin'), pg_temp.iid('Lab report'), 'with_tutor') ->> 'assignment_id' as lab_r \gset
:as_owner
set hub.now = '2026-12-29 10:30 America/New_York';
:as_service
select school_begin(true) as d5 \gset
:as_admin
select test.is(set_school_feed(test.person('Robin'), 'assignments', ''), null, 'Remove Robin''s Assignments link');
:as_owner
select test.is((select string_agg(title, ' | ' order by title) from school_items where feed_id = (:'robin'::jsonb ->> 'id')::uuid)
                 || ' ' || (select count(*) from private.school_feed_urls where feed_id = (:'robin'::jsonb ->> 'id')::uuid),
               'Goggles lab | Lab report | Vocabulary quiz 0', '... the items made assignments stay; the rest and the address go');
:as_service
select test.is(school_store((:'d5'::jsonb ->> 'run_id')::uuid, (:'robin'::jsonb ->> 'id')::uuid,
                            '[{"uid": "r-103", "title": "Map quiz", "first_day": "2027-01-07", "last_day": "2027-01-07"}]', null),
               '{"stored": false, "stop": "removed"}'::jsonb, 'a run that was handed the link before Remove stores nothing for it');
select school_finish((:'d5'::jsonb ->> 'run_id')::uuid);
select test.is((select count(*) from jsonb_array_elements(school_begin(true) -> 'feeds') x where (x ->> 'feed_id')::uuid = (:'robin'::jsonb ->> 'id')::uuid),
               0::bigint, '... and no run is handed it again');
select school_finish(pg_temp.lease());
:as_admin
select test.is((select string_agg(x ->> 'kind', ',' order by n) from jsonb_array_elements(school_feed_status(test.person('Robin')) -> 'feeds') with ordinality t (x, n)),
               'schedule,games', 'the status card no longer shows it');
select test.throws(format('select check_school_feed(%L, ''end'', 0)', :'robin'::jsonb ->> 'id'), 'That school link isn''t there any more.',
                   'a removed link has no check ...');
select test.throws(format('select pause_school_feed(%L, true)', :'robin'::jsonb ->> 'id'), 'That school link isn''t there any more.', '... and no pause');
:as_anon
select homework_by_token(test.token('Robin')) as rv \gset
select test.is((:'rv'::jsonb ? 'from_school') || ' ' || (pg_temp.el(:'rv'::jsonb -> 'assignments', 'Lab report') -> 'school')::text,
               'false {"gone": false, "moved_to": null}', 'Robin has no New from school now; the assignment made from it keeps its school marks');
:as_admin
select set_school_feed(test.person('Robin'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=R1r2R3r4R5r6R7r8') ->> 'id' as robin_again \gset
select test.is(:'robin_again', :'robin'::jsonb ->> 'id', 'Add link again: the same link''s row');
:as_service
select test.is(pg_temp.read('Robin', 'assignments', '[
  {"uid": "r-101", "title": "Lab report", "subject": "Biology", "first_day": "2027-01-05", "last_day": "2027-01-05"},
  {"uid": "r-102", "title": "Read chapter 5", "subject": "History", "first_day": "2027-01-06", "last_day": "2027-01-06"},
  {"title": "Reading log", "subject": "English", "first_day": "2027-01-04", "last_day": "2027-01-04"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2027-01-04", "last_day": "2027-01-04"}
]') ->> 'added', '3', 'the first read adds only what wasn''t made an assignment (the lab report keeps its row)');
:as_admin
select test.is(pg_temp.titles(school_feed_status(test.person('Robin')) -> 'check'), 'Reading log | Vocabulary quiz | Lab report | Read chapter 5',
               'added again, the link asks the first-import check again');
select test.is(pg_temp.titles(check_school_feed(:'robin_again'::uuid, 'end', 0) -> 'new'), 'Reading log | Vocabulary quiz | Read chapter 5',
               '... and once answered, the lab report (made an assignment before Remove) isn''t new');
:as_anon
select test.is(school_item_by_token(test.token('Robin'), pg_temp.iid('Lab report'), 'with_tutor') ->> 'assignment_id', :'lab_r',
               'Plan with Pat on it finds the same assignment');
:as_owner
select test.is((select count(*) from assignments where title = 'Lab report' and kid_id = test.person('Robin')), 1::bigint, '... no second one is made');
-- Remove with nothing made from it: the row goes too.
:as_admin
select set_school_feed(test.person('Robin'), 'games', null);
:as_owner
select test.is((select count(*) from school_feeds where id = :'r_games'), 0::bigint, 'Remove a link nothing was made from: its row goes');

-- ---------------------------------------------------------------------
-- Resume, and homework back on: due now, not "stale" straight away
-- ---------------------------------------------------------------------
:as_admin
select pause_school_feed(:'r_sched'::uuid, true);
:as_owner
set hub.now = '2026-12-30 12:00 America/New_York';
:as_admin
select pause_school_feed(:'r_sched'::uuid, false);
select test.is((select (x ->> 'stale') || ' ' || ((x ->> 'next_at')::timestamptz = private.now())
                from jsonb_array_elements(school_feed_status(test.person('Robin')) -> 'feeds') x where x ->> 'kind' = 'schedule'),
               'false true', 'Resume after a day: due now, not stale');
select save_homework_kid(test.person('Robin'), false);
:as_owner
set hub.now = '2026-12-31 12:00 America/New_York';
:as_admin
select test.is((select string_agg(x ->> 'stale', ',') from jsonb_array_elements(school_feed_status(test.person('Robin')) -> 'feeds') x), 'false,false',
               'with homework off a link isn''t read on purpose: not stale');
select save_homework_kid(test.person('Robin'), true);
select test.is((select string_agg((x ->> 'stale') || ' ' || ((x ->> 'next_at')::timestamptz = private.now()), ',' order by x ->> 'kind')
                from jsonb_array_elements(school_feed_status(test.person('Robin')) -> 'feeds') x),
               'false true,false true', 'homework back on: its links are due now, not stale');
