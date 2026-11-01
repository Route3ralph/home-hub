-- The school feed (migration 0006, docs/v1.3-homework.md §11 and §12): the parents' links (Add,
-- Replace, Remove) and the address check; the address as a secret (no role but the job's own
-- function reads it); the job's lease and what it stores (keys, an item repeated in one read, the
-- window, the caps, an empty read, failures and their backoff, items no longer on the school site,
-- a moved item); the first-import check; Jordan's New from school (Quick, Plan with
-- Pat, Hide) and the parents' Add, Hide and Show; school changes reaching an assignment unless a
-- person changed that field; schedule and games as busy time; the status card; Remove and Erase.
-- After the review (on Robin's links, at the end): the description trimmed on the item and in applied by
-- the hourly run, paused or not; a run that dies partway; two classes' items without a UID, and the
-- moved-item step's limits; Remove and Add again; Resume and homework back on not stale.
-- From migration 0008 (last, on Riley's link, a third kid): the first-import check when nothing is due yet (the
-- ones to come first, then the latest past ones, each with past), as the clock moves on.
-- From migration 0009 (last, on Quinn's links, a fourth kid): Blackbaud gives every event a new UID each time it makes
-- its feed again (every hour or two), so a UID is never part of an item's key: an assignment is its class, its title
-- and its first day, a schedule or games item its title and its start, UID or not (has_uid is false on every row
-- read). The same assignments read again and again with new UIDs are one row each; then private.school_rekey (0009
-- runs it once) on the copies a 0008 database has.
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
-- "title past" for each item of a check, in its order.
create function pg_temp.tp(j jsonb) returns text language sql immutable as $$
  select string_agg((x ->> 'title') || ' ' || coalesce(x ->> 'past', '-'), ' | ' order by n) from jsonb_array_elements(j) with ordinality t (x, n)
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
  {"uid": "a-109@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-04", "last_day": "2026-11-05"},
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
               'Read chapters 5 and 6 History 2026-11-04 2026-11-04 2026-11-04 false | Lab report: water filters Biology 2026-11-05 2026-11-05 2026-11-05 false | '
               'Vocabulary quiz Spanish 2026-11-06 2026-11-06 2026-11-06 false | Poem English 2026-11-12 2026-11-12 2026-11-12 false | '
               'Essay: a person who changed a town English 2026-11-02 2026-11-16 2026-11-16 false',
               'the items: one repeated in one read (the same class, title and first day, whatever its UID) is one item, the last one wins; '
               'the due date is the span''s end (the default rule); has_uid false on each (0009)');
select test.is((select key = md5('title:biology' || E'\n' || 'lab report: water filters|2026-11-05') from school_items where title = 'Lab report: water filters'), true,
               'an item''s key is the md5 of its class, its title and its first day, though it has a UID (0009: Blackbaud''s change every hour or two)');
select test.is((select key = md5('title:spanish' || E'\n' || 'vocabulary quiz|2026-11-06') from school_items where title = 'Vocabulary quiz'), true,
               '... and without one, the same (a line break, which neither can hold, between class and title)');
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
select test.is(pg_temp.keys(:'st0'::jsonb -> 'check' -> 0), 'due_date,first_day,id,last_day,past,subject,title', '... each with its dates (and, from 0008, past)');
select test.is((select string_agg(x ->> 'past', ',') from jsonb_array_elements(:'st0'::jsonb -> 'check') x), 'false,false,false,false,false',
               '... none of them past (five or more to come: as 0006 had it, past false on each)');
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
-- (From 0009 the title is part of the key, so the school's changes to the two titles here are of case only: a title
-- it rewords is another item, at the end.)
-- ---------------------------------------------------------------------
:as_admin
update assignments set title = 'Essay: my town' where id = :'wt_id';
:as_owner
set hub.now = '2026-11-02 10:23 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"uid": "a-101@academy.school.example", "title": "Lab Report: Water Filters", "subject": "Biology",
   "details": "Write up the lab.\nUse the template on the class page.\nDue at the start of class.", "first_day": "2026-11-06", "last_day": "2026-11-06"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"uid": "a-103@academy.school.example", "title": "Essay: A person who changed a town", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-17"},
  {"title": "Vocabulary quiz", "subject": "Spanish", "first_day": "2026-11-09", "last_day": "2026-11-09"},
  {"uid": "a-106@academy.school.example", "title": "Poem", "subject": "English", "first_day": "2026-11-12", "last_day": "2026-11-12"}
]') as r2 \gset
select test.is((:'r2'::jsonb ->> 'kept') || ' ' || (:'r2'::jsonb ->> 'added'), '5 0', 'a second read: five kept, none new');
select test.is((select title || ' ' || due_date || ' ' || details from assignments where id = :'lab'),
               E'Lab Report: Water Filters 2026-11-06 Write up the lab.\nUse the template on the class page.\nDue at the start of class.',
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
  {"uid": "a-101@academy.school.example", "title": "Lab Report: Water Filters", "subject": "Biology",
   "details": "Write up the lab.\nUse the template on the class page.\nDue at the start of class.", "first_day": "2026-11-11", "last_day": "2026-11-11"},
  {"uid": "a-102@academy.school.example", "title": "Read chapters 5 and 6", "subject": "History", "first_day": "2026-11-05", "last_day": "2026-11-05"},
  {"uid": "a-103@academy.school.example", "title": "Essay: A person who changed a town", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-17"},
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
  {"uid": "a-101@academy.school.example", "title": "Lab Report: Water Filters", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
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
  {"uid": "a-101@academy.school.example", "title": "Lab Report: Water Filters", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
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
  {"uid": "a-101@academy.school.example", "title": "Lab Report: Water Filters", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
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
               'Essay: A person who changed a town 2 true | Lab Report: Water Filters 0 false | Map of the river 0 false | '
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
  {"uid": "a-101@academy.school.example", "title": "Lab Report: Water Filters", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
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
select test.is((select key = md5('title:orchestra rehearsal|2026-11-03T21:00:00') from school_items where title = 'Orchestra rehearsal'), true,
               'a schedule item''s key is its title and its start (UTC), though it has a UID (0009)');
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
  {"uid": "a-101@academy.school.example", "title": "Lab Report: Water Filters", "subject": "Biology", "first_day": "2026-11-11", "last_day": "2026-11-11"},
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
               '1 true 0 Essay: A person who changed a town | Graph the results | Lab Report: Water Filters | Read chapters 5 and 6 0',
               '... the address and the items nobody made an assignment go; the four made assignments stay, on a row marked removed');
:as_admin
select test.is((select string_agg(x ->> 'kind', ',' order by n) from jsonb_array_elements(school_feed_status(test.person('Taylor')) -> 'feeds') with ordinality t (x, n)),
               'schedule,games', '... and the status card no longer shows it');
select test.is((select string_agg(title || ' ' || added_by || ' ' || status, ' | ' order by title) from assignments where kid_id = test.person('Taylor')),
               'Essay: my town school open | Graph the results school open | Lab Report: Water Filters school open | Read chapters 5 and 6 school open',
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
-- Four to come, so from 0008 the latest past item still on the link fills the fifth place: December's quiz, made
-- homework before Remove (0006 showed only the four).
select test.is(pg_temp.tp(school_feed_status(test.person('Robin')) -> 'check'),
               'Vocabulary quiz true | Reading log false | Vocabulary quiz false | Lab report false | Read chapter 5 false',
               'added again, the link asks the first-import check again (four to come, and the latest past one)');
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

-- ---------------------------------------------------------------------
-- The first-import check when nothing is due yet (migration 0008, docs/v1.3-homework.md §11.2 step 7)
-- Read over a school break, an Assignments link may hold only past items (the reader keeps those due from 14
-- days back). The check still shows five, so a parent can answer it: the ones to come first, earliest
-- first; fewer than five, the latest past ones fill it, latest first; the chosen ones in date order, each
-- with past. One link (Riley's), one list of items, and the clock moving on.
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2027-01-02 10:00 America/New_York';   -- a Saturday in the winter break
insert into people (name, role, sort_order) values ('Riley', 'kid', 6);
-- Riley's assignments as the school lists them; p_skip leaves one out (the school took it off its site).
create function pg_temp.riley(p_skip text default null) returns jsonb language sql immutable as $$
  select jsonb_agg(x order by n) from jsonb_array_elements('[
    {"uid": "k-101", "title": "Winter reading log", "subject": "English", "first_day": "2026-12-14", "last_day": "2026-12-28"},
    {"uid": "k-102", "title": "Map of Europe", "subject": "Geography", "first_day": "2026-12-30", "last_day": "2026-12-30"},
    {"uid": "k-103", "title": "Lab safety quiz", "subject": "Biology", "first_day": "2027-01-04", "last_day": "2027-01-04"},
    {"uid": "k-104", "title": "Fractions worksheet", "subject": "Math", "first_day": "2027-01-05", "last_day": "2027-01-05"},
    {"uid": "k-105", "title": "Poem recital", "subject": "English", "first_day": "2027-01-06", "last_day": "2027-01-06"},
    {"uid": "k-106", "title": "Vocabulary list", "subject": "Spanish", "first_day": "2027-01-06", "last_day": "2027-01-06"},
    {"uid": "k-107", "title": "Book report", "subject": "English", "first_day": "2027-01-07", "last_day": "2027-01-07"},
    {"uid": "k-108", "title": "Science poster", "subject": "Biology", "first_day": "2027-01-08", "last_day": "2027-01-08"},
    {"uid": "k-109", "title": "Unit test review", "subject": "Math", "first_day": "2027-01-11", "last_day": "2027-01-11"}
  ]'::jsonb) with ordinality t (x, n)
  where p_skip is null or x ->> 'title' <> p_skip
$$;
:as_admin
select save_homework_kid(test.person('Riley'), true);
select set_school_feed(test.person('Riley'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=K1k2K3k4K5k6K7k8') ->> 'id' as riley_feed \gset
:as_service
select test.is(pg_temp.read('Riley', 'assignments', pg_temp.riley()) ->> 'kept', '9', 'Riley''s first read: nine assignments, two of them past');
:as_admin
select test.is(pg_temp.tp(school_feed_status(test.person('Riley')) -> 'check'),
               'Lab safety quiz false | Fractions worksheet false | Poem recital false | Vocabulary list false | Book report false',
               'seven to come: the check is the five earliest of them, none past, as 0006 had it (the two past ones not on it)');
-- A parent makes the unit test review homework now, before the check (school_item_action add).
select school_item_action(pg_temp.iid('Unit test review'), 'add') ->> 'assignment_id' as riley_asg \gset

:as_owner
set hub.now = '2027-01-08 10:00 America/New_York';   -- Friday: two to come, one of them due today
:as_admin
select test.is(pg_temp.tp(school_feed_status(test.person('Riley')) -> 'check'),
               'Poem recital true | Vocabulary list true | Book report true | Science poster false | Unit test review false',
               'two to come (one due today, not past): those two and the three latest past ones, in date order');

:as_owner
set hub.now = '2027-01-12 10:00 America/New_York';   -- Tuesday: nothing to come
:as_admin
select school_feed_status(test.person('Riley')) as rs \gset
select test.is(pg_temp.tp(:'rs'::jsonb -> 'check'),
               'Poem recital true | Vocabulary list true | Book report true | Science poster true | Unit test review true',
               'nothing to come: the check is the five latest, each past, in date order (the one made homework too, as before 0008)');
select test.is(pg_temp.keys(:'rs'::jsonb -> 'check' -> 0), 'due_date,first_day,id,last_day,past,subject,title', '... each with its dates and past');
select test.is(pg_temp.el(:'rs'::jsonb -> 'check', 'Book report') - 'id',
               '{"title": "Book report", "subject": "English", "first_day": "2027-01-07", "last_day": "2027-01-07", "due_date": "2027-01-07", "past": true}'::jsonb,
               '... as the school wrote it (the end date the default rule)');
-- The school takes the poster off its site: absent from two reads, it is gone, and leaves the check.
:as_service
select test.is(pg_temp.read('Riley', 'assignments', pg_temp.riley('Science poster')) ->> 'missing', '1', 'Science poster is missing from a read ...');
select test.is(pg_temp.read('Riley', 'assignments', pg_temp.riley('Science poster')) ->> 'gone', '1', '... and from the next: no longer on the school site');
:as_admin
select school_feed_status(test.person('Riley')) as rs \gset
select test.is(pg_temp.tp(:'rs'::jsonb -> 'check'),
               'Fractions worksheet true | Poem recital true | Vocabulary list true | Book report true | Unit test review true',
               'an item gone from the school site is never on the check: the next latest takes its place');
select test.is((select (x ->> 'last_count') || ' ' || (x ->> 'checked') || ' ' || (x ->> 'last_ok_at' is not null)
                from jsonb_array_elements(:'rs'::jsonb -> 'feeds') x where x ->> 'kind' = 'assignments'), '7 false true',
               '... the link read (7 items, all past), not checked yet');
:as_adult
select test.is(pg_temp.tp(school_feed_status(test.person('Riley')) -> 'check'),
               'Fractions worksheet true | Poem recital true | Vocabulary list true | Book report true | Unit test review true', 'Sam reads the same check');
:as_stranger
select test.is(school_feed_status(test.person('Riley')), null, 'a stranger gets null');
:as_anon
select test.is(test.try(format('select school_feed_status(%L)', test.person('Riley'))), 'denied', 'anon can''t call it');
select test.is(homework_by_token(test.token('Riley')) ? 'from_school', false, 'until a parent answers it, nothing from the link reaches Riley');
:as_admin
select check_school_feed(:'riley_feed'::uuid, 'end', 0) as rk \gset
select test.is((:'rk'::jsonb -> 'check')::text || ' ' || (select x ->> 'checked' from jsonb_array_elements(:'rk'::jsonb -> 'feeds') x where x ->> 'kind' = 'assignments'),
               '[] true', 'Looks right on a check of past items: the link is checked, and a checked link has no check');
:as_anon
select test.is(homework_by_token(test.token('Riley')) ? 'from_school', true, '... and the link reaches Riley');
:as_admin
select test.is(set_school_feed(test.person('Riley'), 'assignments', null), null, 'Remove Riley''s Assignments link');
:as_owner
select test.is((select f.checked || ' ' || (f.removed_at is not null) || ' ' || string_agg(i.title, ',')
                from school_feeds f join school_items i on i.feed_id = f.id and i.gone_at is null where f.id = :'riley_feed' group by f.id),
               'false true Unit test review', '... its row stays for the item made homework: removed, not checked, the item there and past');
:as_admin
select test.is(school_feed_status(test.person('Riley')) -> 'check', '[]'::jsonb, '... and a removed link has no check');

-- ---------------------------------------------------------------------
-- Added again after Remove: a new link, not read yet (migration 0008, docs/v1.3-homework.md §12 item 2)
-- Remove keeps the row for what was made homework, with the old link's last read on it (0006). Adding the link again
-- takes that row; from 0008 it starts as a new link, not read yet: the old read's time, count and repeating events go,
-- so the page doesn't describe the old link's last read ("all 7 of its assignments are already past") as the new one's.
-- Replace on a live link keeps its last read. The clock is still Tue Jan 12, 10:00am, the time of the last read.
-- ---------------------------------------------------------------------
create function pg_temp.readstate(j jsonb) returns text language sql immutable as $$
  select concat_ws(' ', x ->> 'checked', coalesce(x ->> 'last_try_at', '-'), coalesce(x ->> 'last_ok_at', '-'), coalesce(x ->> 'last_count', '-'),
                   coalesce(x ->> 'last_repeats', '-'), coalesce(x ->> 'last_stop', '-'), x ->> 'fails')
  from jsonb_array_elements(j -> 'feeds') x where x ->> 'kind' = 'assignments'
$$;
:as_owner
select test.is((select (last_ok_at is not null) || ' ' || last_count from school_feeds where id = :'riley_feed'), 'true 7',
               'removed, the row still has the old link''s last read (as 0006 leaves it)');
:as_admin
select set_school_feed(test.person('Riley'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=L1l2L3l4L5l6L7l8') ->> 'id' as riley_again \gset
select school_feed_status(test.person('Riley')) as rs \gset
select test.is(:'riley_again', :'riley_feed', 'Add Riley''s link again: the same row');
select test.is(pg_temp.readstate(:'rs'::jsonb), 'false - - - - - 0',
               '... as a new link, not read yet: not checked, and none of the old link''s last read (its time, count or repeating events)');
select test.is(pg_temp.tp(:'rs'::jsonb -> 'check'), 'Unit test review true', '... its check: the item made homework before Remove, still on the school site');
:as_service
select test.is((select count(*) from jsonb_array_elements(school_begin(true) -> 'feeds') x where x ->> 'feed_id' = :'riley_feed'), 1::bigint,
               '... and Check now reads it at once, a minute after the old link''s last read or not');
select school_finish(pg_temp.lease());
-- The school takes the unit test review off its site: absent from two reads of the new link, it is gone.
select test.is(pg_temp.read('Riley', 'assignments', pg_temp.riley('Unit test review')) ->> 'missing', '1', 'the new link''s first read: the unit test review missing once ...');
select test.is(pg_temp.read('Riley', 'assignments', pg_temp.riley('Unit test review')) ->> 'gone', '1', '... and from the next: gone');
:as_admin
select school_feed_status(test.person('Riley')) as rs \gset
select test.is(split_part(pg_temp.readstate(:'rs'::jsonb), ' ', 1) || ' ' || ((select x ->> 'last_ok_at' from jsonb_array_elements(:'rs'::jsonb -> 'feeds') x
                                                                               where x ->> 'kind' = 'assignments')::timestamptz = private.now())
               || ' ' || split_part(pg_temp.readstate(:'rs'::jsonb), ' ', 4), 'false true 7', '... the new link read now, with 7 items');
-- Replace on the live link: the same row, its items and its last read kept.
select set_school_feed(test.person('Riley'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=M1m2M3m4M5m6M7m8');
select test.is(pg_temp.readstate(school_feed_status(test.person('Riley'))), pg_temp.readstate(:'rs'::jsonb),
               'Replace on a live link keeps its last read (only a removed link added again starts as not read)');
-- Remove, with the only item made homework now gone from the school site; then Add again: nothing for the check.
select test.is(set_school_feed(test.person('Riley'), 'assignments', null), null, 'Remove it again');
:as_owner
select test.is((select count(*) || ' ' || bool_and(i.gone_at is not null and i.made_at is not null) || ' ' || (f.last_ok_at is not null) || ' ' || f.last_count
                from school_feeds f join school_items i on i.feed_id = f.id where f.id = :'riley_feed' group by f.id),
               '1 true true 7', '... the row stays for the one item made homework, gone from the school site, with the last read on it');
:as_admin
select set_school_feed(test.person('Riley'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=N1n2N3n4N5n6N7n8');
select school_feed_status(test.person('Riley')) as rs \gset
select test.is((:'rs'::jsonb -> 'check')::text || ' ' || pg_temp.readstate(:'rs'::jsonb), '[] false - - - - - 0',
               'added again with every item kept gone: the check empty, and the link not read yet (so the page says "Once the Assignments link is read…")');
:as_stranger
select test.is(school_feed_status(test.person('Riley')), null, 'a stranger still gets null');

-- ---------------------------------------------------------------------
-- Blackbaud's UIDs change every hour or two (migration 0009, docs/v1.3-homework.md §11.3)
-- Blackbaud makes its feed again every hour or two, and each time every event has a new UID (within one read they are
-- unique). Before 0009 an item with a UID was keyed by it, so each new set of UIDs added every item again and marked the
-- ones before missing, then gone. From 0009 the key is what the item is: an assignment's class, title and first day, a
-- schedule or games item's title and start. Quinn's links (a fourth kid), read again and again with new UIDs.
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2027-02-01 09:00 America/New_York';   -- a Monday
insert into people (name, role, sort_order) values ('Quinn', 'kid', 7);
-- Quinn's assignments as the school lists them, every UID new in each batch; p_moved: the titles whose days the school
-- moves a day on; p_renamed: a title it rewords (": Europe" added).
create function pg_temp.quinn(p_batch int, p_moved text[] default '{}', p_renamed text default null) returns jsonb language sql immutable as $$
  select jsonb_agg(x || jsonb_build_object('uid', 'q' || p_batch || '-' || n || '@academy.school.example')
                     || case when x ->> 'title' = any (p_moved)
                             then jsonb_build_object('first_day', (x ->> 'first_day')::date + 1, 'last_day', (x ->> 'last_day')::date + 1) else '{}' end
                     || case when x ->> 'title' = p_renamed then jsonb_build_object('title', (x ->> 'title') || ': Europe') else '{}' end
                   order by n)
  from jsonb_array_elements('[
    {"title": "Lab report", "subject": "Biology", "first_day": "2027-02-03", "last_day": "2027-02-03"},
    {"title": "Read chapter 7", "subject": "History", "first_day": "2027-02-04", "last_day": "2027-02-04"},
    {"title": "Homework", "subject": "Math 7", "first_day": "2027-02-05", "last_day": "2027-02-05"},
    {"title": "Homework", "subject": "Science 7", "first_day": "2027-02-05", "last_day": "2027-02-05"},
    {"title": "Map quiz", "subject": "Geography", "first_day": "2027-02-08", "last_day": "2027-02-08"},
    {"title": "Essay draft", "subject": "English", "first_day": "2027-02-01", "last_day": "2027-02-12"}
  ]'::jsonb) with ordinality t (x, n)
$$;
-- Quinn's Schedule link: three classes, every UID new in each batch.
create function pg_temp.qsched(p_batch int) returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('uid', 'qs' || p_batch || '-' || v.n || '@academy.school.example', 'title', v.t, 'starts_at', v.s, 'ends_at', v.e)
                   order by v.n)
  from (values (1, 'Biology - 7 (A)', '2027-02-02T13:15:00Z', '2027-02-02T14:00:00Z'),
               (2, 'History - 7 (B)', '2027-02-02T14:05:00Z', '2027-02-02T14:50:00Z'),
               (3, 'Orchestra rehearsal', '2027-02-03T21:00:00Z', '2027-02-03T21:45:00Z')) v (n, t, s, e)
$$;
-- His Assignments link's rows: "class title due missing gone", by due date and class.
create function pg_temp.qitems() returns text language sql stable security definer as $$
  select string_agg(coalesce(i.subject, '-') || ' ' || i.title || ' ' || i.due_date || ' ' || i.missing || ' ' || (i.gone_at is not null), ' | '
                    order by i.due_date, i.subject, i.title)
  from public.school_items i join public.school_feeds f on f.id = i.feed_id
  where f.kid_id = test.person('Quinn') and f.kind = 'assignments'
$$;
create function pg_temp.qid(p_subject text, p_title text) returns uuid language sql stable security definer as $$
  select i.id from public.school_items i join public.school_feeds f on f.id = i.feed_id
  where f.kid_id = test.person('Quinn') and f.kind = 'assignments' and i.subject = p_subject and i.title = p_title
$$;
-- A list's items as "class title", by due date and class (two classes' "Homework" are due the same day, and the
-- views put those in id order).
create function pg_temp.ct(j jsonb) returns text language sql immutable as $$
  select string_agg((x ->> 'subject') || ' ' || (x ->> 'title'), ' | ' order by x ->> 'due_date', x ->> 'subject', x ->> 'title')
  from jsonb_array_elements(j) x
$$;
:as_admin
select save_homework_kid(test.person('Quinn'), true);
select add_homework_time(test.person('Quinn'), '{1,2,3,4}', '16:30', '17:15') is not null;
select set_school_feed(test.person('Quinn'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Q5u6I7n8N9q0U1i2') ->> 'id' as quinn_feed \gset
select set_school_feed(test.person('Quinn'), 'schedule', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Q3s4C5h6E7d8U9l0') ->> 'id' as quinn_sched \gset
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn(1)) - 'stored' - 'stop', '{"kept": 6, "added": 6, "missing": 0, "gone": 0}'::jsonb,
               'Quinn''s first read: six assignments, all new');
:as_owner
set hub.now = '2027-02-01 10:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn(2)) - 'stored' - 'stop', '{"kept": 6, "added": 0, "missing": 0, "gone": 0}'::jsonb,
               'the feed made again an hour later, every UID new: nothing added, nothing missing (0008 added all six again)');
:as_admin
select test.is(pg_temp.ct(school_feed_status(test.person('Quinn')) -> 'check'),
               'Biology Lab report | History Read chapter 7 | Math 7 Homework | Science 7 Homework | Geography Map quiz',
               'the first-import check: each assignment once (and the two classes'' "Homework" due the same day, both)');
select check_school_feed(:'quinn_feed'::uuid, 'end', 0) is not null;
:as_owner
set hub.now = '2027-02-01 12:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn(3)) - 'stored' - 'stop', '{"kept": 6, "added": 0, "missing": 0, "gone": 0}'::jsonb,
               'checked, and every UID new again: nothing added, nothing missing');
:as_owner
select test.is(pg_temp.qitems(),
               'Biology Lab report 2027-02-03 0 false | History Read chapter 7 2027-02-04 0 false | Math 7 Homework 2027-02-05 0 false | '
               'Science 7 Homework 2027-02-05 0 false | Geography Map quiz 2027-02-08 0 false | English Essay draft 2027-02-12 0 false',
               'three reads, three sets of UIDs: one row each, never missing or gone; two classes'' "Homework" due the same day are two');
select test.is((select count(*) || ' ' || bool_and(not has_uid) || ' ' || bool_and(first_seen_at = '2027-02-01 09:00 America/New_York')
                       || ' ' || bool_and(key = md5('title:' || lower(subject) || E'\n' || lower(title) || '|' || to_char(first_day, 'YYYY-MM-DD')))
                from school_items where feed_id = :'quinn_feed'),
               '6 true true true', '... each first seen at the first read, keyed by its class, its title and its first day, has_uid false');
:as_anon
select test.is(pg_temp.ct(homework_by_token(test.token('Quinn')) -> 'from_school'),
               'Biology Lab report | History Read chapter 7 | Math 7 Homework | Science 7 Homework | Geography Map quiz | English Essay draft',
               'his New from school: each once');
select test.is(get_person_day(test.token('Quinn')) -> 'homework' -> 'from_school', '6'::jsonb, '... and his card counts six');
:as_admin
select test.is(pg_temp.ct(school_feed_status(test.person('Quinn')) -> 'new'),
               'Biology Lab report | History Read chapter 7 | Math 7 Homework | Science 7 Homework | Geography Map quiz | English Essay draft',
               '... and the parents'' New from school for him, each once');

-- He makes two of them assignments (Quick on the chapter, due Thursday: one step tonight; the parents' Add on the lab
-- report); the feed is made again twice more.
:as_anon
select school_item_by_token(test.token('Quinn'), pg_temp.qid('History', 'Read chapter 7'), 'quick', 20) ->> 'assignment_id' as q_ch7 \gset
:as_admin
select school_item_action(pg_temp.qid('Biology', 'Lab report'), 'add') ->> 'assignment_id' as q_lab \gset
select pg_temp.qid('History', 'Read chapter 7') as q_ch7_item \gset
:as_owner
set hub.now = '2027-02-01 13:23 America/New_York';
:as_service
select pg_temp.read('Quinn', 'assignments', pg_temp.quinn(4));
:as_owner
set hub.now = '2027-02-01 14:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn(5)) - 'stored' - 'stop', '{"kept": 6, "added": 0, "missing": 0, "gone": 0}'::jsonb,
               'two more reads with new UIDs after two were made assignments: nothing added, nothing missing');
:as_owner
select test.is((select count(*) || ' ' || count(*) filter (where gone_at is null and missing = 0)
                       || ' ' || bool_or(id = :'q_ch7_item' and assignment_id = :'q_ch7')
                from school_items where feed_id = :'quinn_feed'),
               '6 6 true', '... six rows, all on the school site; the chapter''s item keeps its row and its assignment');
:as_anon
select homework_by_token(test.token('Quinn')) as qv \gset
select test.is((pg_temp.el(:'qv'::jsonb -> 'assignments', 'Read chapter 7') -> 'school')::text || ' '
                 || (pg_temp.el(:'qv'::jsonb -> 'assignments', 'Lab report') -> 'school')::text,
               '{"gone": false, "moved_to": null} {"gone": false, "moved_to": null}',
               '... neither assignment is marked "no longer on the school site" (0008 marked both after two reads)');
select test.is(pg_temp.ct(:'qv'::jsonb -> 'from_school'), 'Math 7 Homework | Science 7 Homework | Geography Map quiz | English Essay draft',
               '... and his New from school has the other four, each once (0008 showed the two made assignments as new again)');
:as_admin
select school_feed_status(test.person('Quinn')) as qst \gset
select test.is((:'qst'::jsonb -> 'gone')::text || ' ' || (:'qst'::jsonb -> 'moved')::text || ' ' || jsonb_array_length(:'qst'::jsonb -> 'new'), '[] [] 4',
               '... and the parents'' card: nothing gone, nothing moved, four new');

-- The school moves the chapter and the lab report a day on, in a read with new UIDs: each keeps its row and its
-- assignment; the planned chapter is marked (moved_to), the lab report (no plan) follows.
:as_owner
set hub.now = '2027-02-01 15:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn(6, '{Read chapter 7,Lab report}')) - 'stored' - 'stop',
               '{"kept": 6, "added": 0, "missing": 0, "gone": 0}'::jsonb, 'the school moves two due dates, every UID new: nothing added, nothing missing');
:as_owner
select test.is((select due_date || ' ' || (id = :'q_ch7_item') || ' ' || (assignment_id = :'q_ch7') from school_items
                where feed_id = :'quinn_feed' and title = 'Read chapter 7'),
               '2027-02-05 true true', '... the chapter''s item keeps its row and its assignment, with the school''s new date');
select test.is((select string_agg(title || ' ' || due_date, ', ' order by title) from assignments where id in (:'q_ch7', :'q_lab')),
               'Lab report 2027-02-04, Read chapter 7 2027-02-04', '... the lab report''s assignment (no plan) follows; the planned chapter''s stays');
:as_anon
select test.is(pg_temp.el(homework_by_token(test.token('Quinn')) -> 'assignments', 'Read chapter 7') -> 'school', '{"gone": false, "moved_to": "2027-02-05"}'::jsonb,
               '... and is marked: the school''s date moved to Fri Feb 5');
:as_admin
select test.is(pg_temp.titles(school_feed_status(test.person('Quinn')) -> 'moved'), 'Read chapter 7', '... and the parents see "Due date moved"');
:as_owner
set hub.now = '2027-02-01 16:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn(7, '{Read chapter 7,Lab report}')) - 'stored' - 'stop',
               '{"kept": 6, "added": 0, "missing": 0, "gone": 0}'::jsonb, '... and the next read, new UIDs again, changes nothing');

-- A title the school rewords is another item now (no UID ties the two): the old one is missing, then gone.
:as_owner
set hub.now = '2027-02-01 17:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn(8, '{Read chapter 7,Lab report}', 'Map quiz')) - 'stored' - 'stop',
               '{"kept": 6, "added": 1, "missing": 1, "gone": 0}'::jsonb,
               'a title the school rewords ("Map quiz: Europe") is a new item, and the old one is missing once');
:as_owner
set hub.now = '2027-02-01 18:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn(9, '{Read chapter 7,Lab report}', 'Map quiz')) ->> 'gone', '1',
               '... and from the next read, gone');
:as_anon
select test.is(pg_temp.ct(homework_by_token(test.token('Quinn')) -> 'from_school'),
               'Math 7 Homework | Science 7 Homework | Geography Map quiz: Europe | English Essay draft',
               '... his New from school has the new title, once, and not the old');

-- His Schedule link: the same classes with new UIDs are the same rows (busy time once, not twice).
:as_service
select test.is(pg_temp.read('Quinn', 'schedule', pg_temp.qsched(1)) - 'stored' - 'stop', '{"kept": 3, "added": 3, "missing": 0, "gone": 0}'::jsonb,
               'Quinn''s Schedule link: three classes');
:as_owner
set hub.now = '2027-02-01 19:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'schedule', pg_temp.qsched(2)) - 'stored' - 'stop', '{"kept": 3, "added": 0, "missing": 0, "gone": 0}'::jsonb,
               'read again with every UID new: no new rows, nothing missing');
:as_owner
select test.is((select count(*) || ' ' || bool_and(not has_uid)
                       || ' ' || bool_and(key = md5('title:' || lower(title) || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')))
                from school_items where feed_id = :'quinn_sched'),
               '3 true true', '... three rows, each keyed by its title and its start, has_uid false');
:as_admin
select test.is((select (x -> 'busy')::text from jsonb_array_elements(homework_week(test.person('Quinn'), '2027-02-01', 4)) x where x ->> 'day' = '2027-02-03'),
               '[{"ends": "16:45", "title": "Orchestra rehearsal", "starts": "16:00"}]', '... and the rehearsal is busy time on Wednesday once');

-- ---------------------------------------------------------------------
-- The rows a 0008 database already has: private.school_rekey (0009 runs it once, in its own transaction)
-- Every row gets its content key and has_uid false. Of the copies of one item on one link (the same content key) one
-- row stays: the one made an assignment, else one made one once (its assignment deleted since), else one hidden, else
-- one still on the school site, else the one seen last, then by id. It is hidden if any copy was, first seen when the
-- first was and last seen when the latest was, and on the school site (not missing, not gone) if any copy was in the
-- link's last good read. The other copies are deleted, but never one made an assignment: a second of those stays on
-- its old key as it was, and the next reads mark it missing, then gone. The copies are written here as the owner, as
-- 0008's reads left them (on 0009 no read makes one).
-- ---------------------------------------------------------------------
:as_owner
select last_ok_at as q_ok from school_feeds where id = :'quinn_feed' \gset
-- A copy as 0008 stored it: keyed by its UID, last seen p_ago before the link's last good read (first seen an hour
-- before that), missing, gone, hidden, made an assignment.
create function pg_temp.copy(p_uid text, p_subject text, p_title text, p_day date, p_ago interval, p_missing int, p_gone boolean,
                             p_hidden boolean default false, p_asg uuid default null) returns uuid language sql as $$
  insert into public.school_items (feed_id, key, has_uid, title, subject, first_day, last_day, due_date, hidden, assignment_id, made_at, applied,
                                   first_seen_at, last_seen_at, missing, gone_at)
  select f.id, md5('uid:' || p_uid), true, p_title, p_subject, p_day, p_day, p_day, p_hidden, p_asg,
         case when p_asg is not null then f.last_ok_at - interval '6 hours' end,
         case when p_asg is not null then jsonb_build_object('title', p_title, 'subject', p_subject, 'due_date', p_day, 'details', null) end,
         f.last_ok_at - p_ago - interval '1 hour', f.last_ok_at - p_ago, p_missing, case when p_gone then f.last_ok_at - interval '30 minutes' end
  from public.school_feeds f where f.kid_id = test.person('Quinn') and f.kind = 'assignments'
  returning id
$$;
create function pg_temp.qasg(p_title text, p_subject text, p_day date) returns uuid language sql as $$
  insert into public.assignments (kid_id, title, subject, due_date, added_by) values (test.person('Quinn'), p_title, p_subject, p_day, 'school') returning id
$$;
select pg_temp.qasg('Poster', 'Art', '2027-02-16') as asg_poster \gset
select pg_temp.qasg('Book report', 'English', '2027-02-18') as asg_br1 \gset
select pg_temp.qasg('Book report', 'English', '2027-02-18') as asg_br2 \gset
select pg_temp.qasg('Field trip form', 'English', '2027-02-19') as asg_trip \gset
-- The science fair form: three batches, the first gone (as Taylor's link had it on the live database).
select pg_temp.copy('sf-1', 'Biology', 'Science fair form', '2027-02-15', '3 hours', 2, true) as g1a \gset
select pg_temp.copy('sf-2', 'Biology', 'Science fair form', '2027-02-15', '1 hour', 1, false) as g1b \gset
select pg_temp.copy('sf-3', 'Biology', 'Science fair form', '2027-02-15', '0', 0, false) as g1c \gset
-- The poster: made an assignment from the copy that is now gone; a later copy on the school site.
select pg_temp.copy('po-1', 'Art', 'Poster', '2027-02-16', '3 hours', 2, true, false, :'asg_poster') as g2a \gset
select pg_temp.copy('po-2', 'Art', 'Poster', '2027-02-16', '0', 0, false) as g2b \gset
-- The spelling list: he hid the older copy; the later one is new for him.
select pg_temp.copy('sp-1', 'English', 'Spelling list', '2027-02-17', '1 hour', 1, false, true) as g3a \gset
select pg_temp.copy('sp-2', 'English', 'Spelling list', '2027-02-17', '0', 0, false) as g3b \gset
-- The book report: made an assignment twice (once from each of two copies), and a third copy.
select pg_temp.copy('br-1', 'English', 'Book report', '2027-02-18', '1 hour', 1, false, false, :'asg_br1') as g4a \gset
select pg_temp.copy('br-2', 'English', 'Book report', '2027-02-18', '0', 0, false, false, :'asg_br2') as g4b \gset
select pg_temp.copy('br-3', 'English', 'Book report', '2027-02-18', '0', 0, false) as g4c \gset
-- The field trip form: made an assignment once, deleted since (never new again); a later copy.
select pg_temp.copy('ft-1', 'English', 'Field trip form', '2027-02-19', '1 hour', 1, false, false, :'asg_trip') as g5a \gset
select pg_temp.copy('ft-2', 'English', 'Field trip form', '2027-02-19', '0', 0, false) as g5b \gset
delete from assignments where id = :'asg_trip';
:as_anon
select test.is(pg_temp.ct(homework_by_token(test.token('Quinn')) -> 'from_school'),
               'Math 7 Homework | Science 7 Homework | Geography Map quiz: Europe | English Essay draft | Biology Science fair form | '
               'Biology Science fair form | Art Poster | English Spelling list | English Book report | English Field trip form',
               'as 0008 left them: the copies are new for him again (the science fair form twice)');
:as_owner
select md5(string_agg(i::text, ',' order by i.id)) as others_before from school_items i where feed_id <> :'quinn_feed' \gset
select test.is(private.school_rekey(), 6,
               'school_rekey deletes six copies: two of the science fair form, one each of the poster, the spelling list, the book report and the field trip form');
select test.is((select string_agg(i.title || ' ' || (i.key = md5('title:' || lower(i.subject) || E'\n' || lower(i.title) || '|' || to_char(i.first_day, 'YYYY-MM-DD')))
                                  || ' ' || i.has_uid || ' ' || i.missing || ' ' || (i.gone_at is not null) || ' ' || i.hidden
                                  || ' ' || (i.made_at is not null) || ' ' || (i.assignment_id is not null), ' | ' order by i.first_day, i.has_uid)
                from school_items i where i.feed_id = :'quinn_feed' and i.first_day >= '2027-02-15'),
               'Science fair form true false 0 false false false false | Poster true false 0 false false true true | '
               'Spelling list true false 0 false true false false | Book report true false 0 false false true true | '
               'Book report false true 1 false false true true | Field trip form true false 0 false false true false',
               'one row an item, on its content key, has_uid false, on the school site; the second book report made an assignment kept as it was');
select test.is((select string_agg(id::text, ',' order by first_day, has_uid) from school_items where feed_id = :'quinn_feed' and first_day >= '2027-02-15'),
               concat_ws(',', :'g1c', :'g2a', :'g3a', :'g4b', :'g4a', :'g5a'),
               '... the rows kept: the science fair form seen last, the poster made an assignment (though gone), the hidden spelling list, '
               'the book report seen last of the two made assignments (and the other), the field trip form made one once');
select test.is((select (first_seen_at = :'q_ok'::timestamptz - interval '4 hours') || ' ' || (last_seen_at = :'q_ok'::timestamptz) from school_items where id = :'g1c')
                 || ' ' || (select (first_seen_at = :'q_ok'::timestamptz - interval '4 hours') || ' ' || (last_seen_at = :'q_ok'::timestamptz) from school_items where id = :'g2a'),
               'true true true true', '... each first seen when its first copy was, last seen when its latest was (the last good read)');
select test.is((select md5(string_agg(i::text, ',' order by i.id)) from school_items i where feed_id <> :'quinn_feed'), :'others_before',
               '... and the other links'' rows, one an item and on their keys already, are as they were');
:as_anon
select homework_by_token(test.token('Quinn')) as qr \gset
select test.is(pg_temp.ct(:'qr'::jsonb -> 'from_school'),
               'Math 7 Homework | Science 7 Homework | Geography Map quiz: Europe | English Essay draft | Biology Science fair form',
               'his New from school: the science fair form once; not the spelling list (hidden), the poster or the book report (made '
               'assignments), or the field trip form (made one once)');
select test.is((pg_temp.el(:'qr'::jsonb -> 'assignments', 'Poster') -> 'school')::text, '{"gone": false, "moved_to": null}',
               'the poster''s assignment, made from the copy that was gone, isn''t marked "no longer on the school site": its item is on it');
:as_admin
select test.is(pg_temp.titles(school_feed_status(test.person('Quinn')) -> 'hidden'), 'Spelling list', 'the spelling list stays hidden, once (the parents'' Hidden)');
-- The next reads, every UID new: nothing added; only the second book report made an assignment, on its old key, goes.
create function pg_temp.quinn_more(p_batch int) returns jsonb language sql immutable as $$
  select pg_temp.quinn(p_batch, '{Read chapter 7,Lab report}', 'Map quiz')
         || jsonb_agg(jsonb_build_object('uid', 'qm' || p_batch || '-' || v.n || '@academy.school.example', 'title', v.t, 'subject', v.s,
                                         'first_day', v.d, 'last_day', v.d) order by v.n)
  from (values (1, 'Science fair form', 'Biology', '2027-02-15'), (2, 'Poster', 'Art', '2027-02-16'), (3, 'Spelling list', 'English', '2027-02-17'),
               (4, 'Book report', 'English', '2027-02-18'), (5, 'Field trip form', 'English', '2027-02-19')) v (n, t, s, d)
$$;
:as_owner
set hub.now = '2027-02-01 20:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn_more(10)) - 'stored' - 'stop', '{"kept": 11, "added": 0, "missing": 1, "gone": 1}'::jsonb,
               'the next read, every UID new: nothing added; only the second book report made an assignment, on its old key (missing once already), '
               'is missing, and so gone');
:as_owner
set hub.now = '2027-02-01 21:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.quinn_more(11)) - 'stored' - 'stop', '{"kept": 11, "added": 0, "missing": 0, "gone": 0}'::jsonb,
               '... and the one after changes nothing');
:as_anon
select test.is((select string_agg(case when (x ->> 'id')::uuid = :'asg_br1' then 'first ' else 'second ' end || (x -> 'school' ->> 'gone'), ', '
                                  order by (x ->> 'id')::uuid = :'asg_br1' desc)
                from jsonb_array_elements(homework_by_token(test.token('Quinn')) -> 'assignments') x where x ->> 'title' = 'Book report'),
               'first true, second false',
               'of the book report''s two assignments, the one whose copy stayed on its old key is marked "no longer on the school site" (one the parents can delete)');
:as_admin
select test.is(pg_temp.titles(school_feed_status(test.person('Quinn')) -> 'gone'), 'Book report', '... and the parents see it');
:as_owner
select md5(string_agg(i::text, ',' order by i.id)) as all_before from school_items i \gset
select test.is(private.school_rekey(), 0, 'school_rekey run again deletes nothing ...');
select test.is((select md5(string_agg(i::text, ',' order by i.id)) from school_items i), :'all_before', '... and changes nothing (0009 runs again after its undo)');

-- ---------------------------------------------------------------------
-- The moved-date step without a UID to go by (0009 replaces school_store, §11.3): every Blackbaud item now goes through
-- it, so it pairs the read's new keys with the old rows nearest first across the whole read (not in feed order), and a
-- row hidden, or made an assignment that is no longer open, is never moved: a same-class, same-title item deleted and
-- another added in one read looks like a move, and moving such a row would hide the new one.
-- ---------------------------------------------------------------------
-- Quinn's read with other classes besides (p_extra: {subject, title, first_day}, each one day long, every UID new).
create function pg_temp.qmore(p_batch int, p_extra jsonb) returns jsonb language sql immutable as $$
  select pg_temp.quinn_more(p_batch)
         || (select jsonb_agg(x || jsonb_build_object('uid', 'qx' || p_batch || '-' || n || '@academy.school.example', 'last_day', x -> 'first_day') order by n)
             from jsonb_array_elements(p_extra) with ordinality t (x, n))
$$;
create function pg_temp.qday(p_subject text, p_title text, p_day date) returns uuid language sql stable security definer as $$
  select i.id from public.school_items i join public.school_feeds f on f.id = i.feed_id
  where f.kid_id = test.person('Quinn') and f.kind = 'assignments' and i.subject = p_subject and i.title = p_title and i.first_day = p_day
$$;
-- "class title due" of his New from school, for the classes named.
create function pg_temp.qnew(j jsonb, p_subjects text[]) returns text language sql immutable as $$
  select string_agg((x ->> 'subject') || ' ' || (x ->> 'title') || ' ' || (x ->> 'due_date'), ' | ' order by x ->> 'subject', x ->> 'due_date')
  from jsonb_array_elements(j) x where x ->> 'subject' = any (p_subjects)
$$;
:as_owner
set hub.now = '2027-02-01 22:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.qmore(12, '[
    {"subject": "Algebra", "title": "Practice set", "first_day": "2027-02-02"},
    {"subject": "Geometry", "title": "Proof sheet", "first_day": "2027-02-02"},
    {"subject": "Chemistry", "title": "Lab sheet", "first_day": "2027-02-02"},
    {"subject": "Physics", "title": "Problem set", "first_day": "2027-02-02"},
    {"subject": "Spanish 7", "title": "Homework", "first_day": "2027-02-02"},
    {"subject": "Spanish 7", "title": "Homework", "first_day": "2027-02-03"},
    {"subject": "Spanish 7", "title": "Homework", "first_day": "2027-02-04"},
    {"subject": "French 7", "title": "Worksheet", "first_day": "2027-02-03"},
    {"subject": "Art 7", "title": "Sketch", "first_day": "2027-02-03"}
  ]')) - 'stored' - 'stop', '{"kept": 20, "added": 9, "missing": 0, "gone": 0}'::jsonb,
               'Quinn''s link with nine more items (four classes'' one each, Spanish''s "Homework" three days running, French''s and Art''s)');
-- Plan with Pat on the four classes' items, two of them then given a plan; he hides Spanish's Wednesday homework and
-- French's worksheet; Plan with Pat on Spanish's Thursday homework, and on Art's sketch, which he then finishes.
:as_anon
select school_item_by_token(test.token('Quinn'), pg_temp.qday('Algebra', 'Practice set', '2027-02-02'), 'with_tutor') ->> 'assignment_id' as m_alg \gset
select school_item_by_token(test.token('Quinn'), pg_temp.qday('Geometry', 'Proof sheet', '2027-02-02'), 'with_tutor') ->> 'assignment_id' as m_geo \gset
select school_item_by_token(test.token('Quinn'), pg_temp.qday('Chemistry', 'Lab sheet', '2027-02-02'), 'with_tutor') ->> 'assignment_id' as m_chem \gset
select school_item_by_token(test.token('Quinn'), pg_temp.qday('Physics', 'Problem set', '2027-02-02'), 'with_tutor') ->> 'assignment_id' as m_phys \gset
select test.ok(school_item_by_token(test.token('Quinn'), pg_temp.qday('Spanish 7', 'Homework', '2027-02-03'), 'hide') is not null, 'he hides Spanish''s Wednesday homework');
select test.ok(school_item_by_token(test.token('Quinn'), pg_temp.qday('French 7', 'Worksheet', '2027-02-03'), 'hide') is not null, '... and French''s worksheet');
select school_item_by_token(test.token('Quinn'), pg_temp.qday('Spanish 7', 'Homework', '2027-02-04'), 'with_tutor') ->> 'assignment_id' as m_spa \gset
select school_item_by_token(test.token('Quinn'), pg_temp.qday('Art 7', 'Sketch', '2027-02-03'), 'with_tutor') ->> 'assignment_id' as m_art \gset
:as_owner
insert into homework_steps (assignment_id, pos, title, minutes, day) values (:'m_geo', 1, 'Do the proofs', 20, '2027-02-01'), (:'m_phys', 1, 'Do the problems', 20, '2027-02-01');
update assignments set status = 'done', done_at = now() where id = :'m_art';
select pg_temp.qday('Spanish 7', 'Homework', '2027-02-03') as m_spa_hid \gset
select pg_temp.qday('Art 7', 'Sketch', '2027-02-03') as m_art_item \gset
-- The next read, every UID new: each of the four classes' items moved a day, and another of each posted a day after
-- that (Algebra and Geometry list the farther one first, Chemistry and Physics the nearer); Spanish's Wednesday and
-- Thursday homework deleted and Monday's and Tuesday's posted; French's worksheet and Art's sketch deleted and next
-- week's posted.
set hub.now = '2027-02-01 23:23 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.qmore(13, '[
    {"subject": "Algebra", "title": "Practice set", "first_day": "2027-02-04"},
    {"subject": "Algebra", "title": "Practice set", "first_day": "2027-02-03"},
    {"subject": "Geometry", "title": "Proof sheet", "first_day": "2027-02-04"},
    {"subject": "Geometry", "title": "Proof sheet", "first_day": "2027-02-03"},
    {"subject": "Chemistry", "title": "Lab sheet", "first_day": "2027-02-03"},
    {"subject": "Chemistry", "title": "Lab sheet", "first_day": "2027-02-04"},
    {"subject": "Physics", "title": "Problem set", "first_day": "2027-02-03"},
    {"subject": "Physics", "title": "Problem set", "first_day": "2027-02-04"},
    {"subject": "Spanish 7", "title": "Homework", "first_day": "2027-02-02"},
    {"subject": "Spanish 7", "title": "Homework", "first_day": "2027-02-08"},
    {"subject": "Spanish 7", "title": "Homework", "first_day": "2027-02-09"},
    {"subject": "French 7", "title": "Worksheet", "first_day": "2027-02-10"},
    {"subject": "Art 7", "title": "Sketch", "first_day": "2027-02-10"}
  ]')) - 'stored' - 'stop', '{"kept": 24, "added": 7, "missing": 3, "gone": 0}'::jsonb,
               'the next read: seven new (the four classes'' later ones, Spanish''s Tuesday, French''s and Art''s next week), three missing '
               '(Spanish''s hidden Wednesday, French''s hidden worksheet, Art''s finished sketch)');
:as_owner
select test.is((select string_agg(a.subject || ' ' || i.due_date || ' ' || a.due_date, ' | ' order by a.subject)
                from assignments a join school_items i on i.assignment_id = a.id where a.id in (:'m_alg', :'m_geo', :'m_chem', :'m_phys')),
               'Algebra 2027-02-03 2027-02-03 | Chemistry 2027-02-03 2027-02-03 | Geometry 2027-02-03 2027-02-02 | Physics 2027-02-03 2027-02-02',
               'each moved item keeps its row on the nearest new date (Feb 3) whichever the feed lists first; the ones without a plan follow, the planned ones stay');
:as_anon
select homework_by_token(test.token('Quinn')) as mv \gset
select test.is((select string_agg((x ->> 'subject') || ' ' || coalesce(x -> 'school' ->> 'moved_to', '-'), ' | ' order by x ->> 'subject')
                from jsonb_array_elements(:'mv'::jsonb -> 'assignments') x where (x ->> 'id')::uuid in (:'m_alg', :'m_geo', :'m_chem', :'m_phys')),
               'Algebra - | Chemistry - | Geometry 2027-02-03 | Physics 2027-02-03', '... the planned ones marked: the school''s date moved to Feb 3');
select test.is(pg_temp.qnew(:'mv'::jsonb -> 'from_school', '{Algebra,Geometry,Chemistry,Physics,Spanish 7,French 7,Art 7}'),
               'Algebra Practice set 2027-02-04 | Art 7 Sketch 2027-02-10 | Chemistry Lab sheet 2027-02-04 | French 7 Worksheet 2027-02-10 | '
               'Geometry Proof sheet 2027-02-04 | Physics Problem set 2027-02-04 | Spanish 7 Homework 2027-02-02 | Spanish 7 Homework 2027-02-09',
               '... and his New from school has every new one: the four later ones, Spanish''s Tuesday, French''s and Art''s next week');
select test.is((select (x -> 'school')::text || ' ' || (x ->> 'due_date') from jsonb_array_elements(:'mv'::jsonb -> 'assignments') x where (x ->> 'id')::uuid = :'m_spa'),
               '{"gone": false, "moved_to": null} 2027-02-08',
               'Spanish''s open Thursday homework takes the nearest new one (Monday''s, and follows it); the hidden Wednesday one is never moved');
:as_admin
select school_feed_status(test.person('Quinn')) as mvs \gset
select test.is((select string_agg((x ->> 'subject') || ' ' || (x ->> 'title') || ' ' || (x ->> 'due_date'), ' | ' order by x ->> 'due_date', x ->> 'subject')
                from jsonb_array_elements(:'mvs'::jsonb -> 'hidden') x),
               'French 7 Worksheet 2027-02-03 | Spanish 7 Homework 2027-02-03 | English Spelling list 2027-02-17',
               '... the parents'' Hidden: only what he hid (not Spanish''s Tuesday homework or French''s next worksheet)');
select test.is(pg_temp.titles(:'mvs'::jsonb -> 'moved'), 'Problem set | Proof sheet | Read chapter 7', '... and "Due date moved": the two planned ones (and the chapter, before)');
:as_owner
select test.is((select due_date || ' ' || missing || ' ' || (assignment_id = :'m_art') from school_items where id = :'m_art_item')
                 || ' ' || (select due_date || ' ' || status from assignments where id = :'m_art'),
               '2027-02-03 1 true 2027-02-03 done', 'Art''s finished sketch keeps its row and its date (missing once), and its assignment is as it was');
set hub.now = '2027-02-01 23:53 America/New_York';
:as_service
select test.is(pg_temp.read('Quinn', 'assignments', pg_temp.qmore(14, '[
    {"subject": "Algebra", "title": "Practice set", "first_day": "2027-02-03"},
    {"subject": "Algebra", "title": "Practice set", "first_day": "2027-02-04"},
    {"subject": "Geometry", "title": "Proof sheet", "first_day": "2027-02-03"},
    {"subject": "Geometry", "title": "Proof sheet", "first_day": "2027-02-04"},
    {"subject": "Chemistry", "title": "Lab sheet", "first_day": "2027-02-04"},
    {"subject": "Chemistry", "title": "Lab sheet", "first_day": "2027-02-03"},
    {"subject": "Physics", "title": "Problem set", "first_day": "2027-02-04"},
    {"subject": "Physics", "title": "Problem set", "first_day": "2027-02-03"},
    {"subject": "Spanish 7", "title": "Homework", "first_day": "2027-02-09"},
    {"subject": "Spanish 7", "title": "Homework", "first_day": "2027-02-08"},
    {"subject": "Spanish 7", "title": "Homework", "first_day": "2027-02-02"},
    {"subject": "French 7", "title": "Worksheet", "first_day": "2027-02-10"},
    {"subject": "Art 7", "title": "Sketch", "first_day": "2027-02-10"}
  ]')) - 'stored' - 'stop', '{"kept": 24, "added": 0, "missing": 3, "gone": 3}'::jsonb,
               '... the read after, every UID new and in another order: nothing added, nothing moved; the three deleted ones gone');
:as_owner
select test.is((select hidden || ' ' || (gone_at is not null) from school_items where id = :'m_spa_hid'), 'true true',
               '... Spanish''s hidden Wednesday homework, on its own row, is gone');

-- 0009 run again after its undo (§16.9): a copy on its content key made an assignment on 9, gone after the undo's
-- reads, and a later copy on a UID key made one too, in the last good read. The one already on the key stays (else the
-- other couldn't take the key: unique (feed_id, key)) and is on the school site again; the UID copy stays as it was.
:as_owner
select pg_temp.qasg('Poem', 'English', '2027-02-22') as asg_poem1 \gset
select pg_temp.qasg('Poem', 'English', '2027-02-22') as asg_poem2 \gset
select pg_temp.copy('pm-1', 'English', 'Poem', '2027-02-22', '3 hours', 2, true, false, :'asg_poem1') as g6a \gset
update school_items set key = md5('title:english' || E'\n' || 'poem|2027-02-22'), has_uid = false where id = :'g6a';
select pg_temp.copy('pm-2', 'English', 'Poem', '2027-02-22', '0', 0, false, false, :'asg_poem2') as g6b \gset
select key as g6b_key from school_items where id = :'g6b' \gset
select test.is(private.school_rekey(), 0, 'school_rekey after the undo: two copies made assignments, one already on the content key: nothing deleted, no clash');
select test.is((select string_agg((i.id = :'g6a') || ' ' || (i.key = md5('title:english' || E'\n' || 'poem|2027-02-22')) || ' ' || (i.key = :'g6b_key')
                                  || ' ' || i.has_uid || ' ' || i.missing || ' ' || (i.gone_at is not null), ' | ' order by i.id = :'g6a' desc)
                from school_items i where i.feed_id = :'quinn_feed' and i.title = 'Poem'),
               'true true false false 0 false | false false true true 0 false',
               '... the copy on the key kept, on the school site again (seen by the last good read); the UID copy on its old key, as it was');

-- A copy the school lists without a class (a summary without "Class: ", so school.ts sends subject null): its two
-- copies are one row, on the key school_rows gives it. Run in a session not on UTC: a start's key is in UTC whatever
-- the session's time zone, so his schedule rows stay on theirs.
select pg_temp.copy('ps-1', null, 'Permission slip', '2027-02-20', '1 hour', 1, false) as g7a \gset
select pg_temp.copy('ps-2', null, 'Permission slip', '2027-02-20', '0', 0, false) as g7b \gset
set timezone = 'America/New_York';
select test.is(private.school_rekey(), 1, 'school_rekey, in a session on New York time: of a class-less item''s two copies, one is deleted');
reset timezone;
select test.is((select string_agg(i.id || ' ' || i.has_uid || ' ' || i.missing || ' ' || (i.gone_at is not null), ',') from school_items i
                where i.feed_id = :'quinn_feed' and i.title = 'Permission slip'),
               :'g7b' || ' false 0 false', '... the copy seen last stays, has_uid false, on the school site');
select test.is((select key from school_items where id = :'g7b'),
               (select r.key from private.school_rows('assignments', '[{"title": "Permission slip", "first_day": "2027-02-20", "last_day": "2027-02-20"}]',
                                                      'end', 0, '2027-02-01') r),
               '... on the key school_rows gives an item without a class');
select test.ok((select bool_and(key = md5('title:' || lower(title) || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')))
                from school_items where feed_id = :'quinn_sched'),
               '... and his schedule rows are on their keys still (a start''s key in UTC)');

-- The cost, accepted (§11.3): two classes the hub reads as one (school.ts leaves a section and a block out of the
-- class: "Music - Band (A)" and "Music - Choir (B)" are both Music) with the same title on the same first day are one
-- item: the last in the read wins. (0008 kept them apart by their UIDs, but no UID lasts an hour.)
select test.is((select count(*) || ' ' || string_agg(r.subject || ' ' || r.title || ' ' || r.first_day || ' ' || r.details, ', ')
                from private.school_rows('assignments', '[
                  {"uid": "mb-1@academy.school.example", "title": "Practice log", "subject": "Music", "details": "Band: scales.", "first_day": "2027-02-05", "last_day": "2027-02-05"},
                  {"uid": "mc-1@academy.school.example", "title": "Practice log", "subject": "Music", "details": "Choir: warm-ups.", "first_day": "2027-02-05", "last_day": "2027-02-05"}
                ]', 'end', 0, '2027-02-01') r),
               '1 Music Practice log 2027-02-05 Choir: warm-ups.',
               'two classes read as one ("Music") with the same title on the same first day: one item, the last in the read');
