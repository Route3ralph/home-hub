-- Adding school items automatically (migration 0030, docs/v1.3-homework.md §30): an Assignments link with auto_add on
-- puts its new items, due from today to 30 days ahead, straight onto the kid's homework at each read, as Add does,
-- except one the family hid before (the same title and class, hidden on that link) or already has by hand (the same
-- title and due date): those are hidden instead. Never a past item, on a paused or unchecked link, on a link dated by
-- the day each was given, or while his homework is off. set_school_auto_add (a parent only) turns it on, adding what is
-- waiting at once; the status card shows the switch.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (the kid with homework). Everything is made up:
-- the school's host is academy.school.example (the allowed suffix is replaced below).
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-15 09:00 America/New_York';   -- a Sunday
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.run(text) to anon, authenticated, service_role;
create function pg_temp.fid() returns uuid language sql stable security definer as $$
  select id from public.school_feeds where kid_id = test.person('Taylor') and kind = 'assignments'
$$;
grant execute on function pg_temp.fid() to anon, authenticated, service_role;
-- His homework from school, as "title due (who)", and the items left waiting or hidden.
create function pg_temp.hw() returns text language sql stable security definer as $$
  select coalesce(string_agg(a.title || ' ' || a.due_date || ' (' || a.created_by || ')', ' | ' order by a.due_date, a.title), '')
  from public.assignments a where a.kid_id = test.person('Taylor') and a.added_by = 'school'
$$;
create function pg_temp.waiting() returns text language sql stable security definer as $$
  select coalesce(string_agg(i.title, ' | ' order by i.due_date, i.title), '')
  from public.school_items i where i.feed_id = pg_temp.fid() and i.made_at is null and not i.hidden and i.gone_at is null
$$;
create function pg_temp.hidden() returns text language sql stable security definer as $$
  select coalesce(string_agg(i.title || ' ' || i.due_date, ' | ' order by i.due_date, i.title), '')
  from public.school_items i where i.feed_id = pg_temp.fid() and i.hidden
$$;
grant execute on function pg_temp.hw() to anon, authenticated, service_role;
grant execute on function pg_temp.waiting() to anon, authenticated, service_role;
grant execute on function pg_temp.hidden() to anon, authenticated, service_role;
-- One read, as hub-jobs makes it.
create function pg_temp.read(p_items jsonb) returns jsonb language plpgsql as $$
declare
  b jsonb;
  r jsonb;
begin
  b := public.school_begin(true);
  if not coalesce((b ->> 'go')::boolean, false) then
    return jsonb_build_object('begin', b);
  end if;
  r := public.school_store(p_run => (b ->> 'run_id')::uuid, p_feed => pg_temp.fid(), p_items => p_items,
                           p_stop => null, p_repeats => 0, p_from => public.today_local() - 180);
  perform public.school_finish((b ->> 'run_id')::uuid);
  return r;
end;
$$;
create or replace function private.school_host_suffix() returns text language sql immutable set search_path = '' as $$ select '.school.example' $$;

-- ---------------------------------------------------------------------
-- The schema, the switch and its grants
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 34, 'hub_schema_version is 34');
select test.is((select format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull || ' ' || pg_get_expr(d.adbin, d.adrelid)
                from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                where a.attrelid = 'public.school_feeds'::regclass and a.attname = 'auto_add'),
               'boolean true false', 'school_feeds.auto_add: boolean, not null, false (off for every link)');
select test.ok(has_function_privilege('authenticated', 'public.set_school_auto_add(uuid, boolean)', 'execute')
               and not has_function_privilege('anon', 'public.set_school_auto_add(uuid, boolean)', 'execute')
               and not has_function_privilege('service_role', 'public.set_school_auto_add(uuid, boolean)', 'execute')
               and (select p.prosecdef from pg_proc p where p.oid = 'public.set_school_auto_add(uuid, boolean)'::regprocedure),
               'set_school_auto_add: signed-in users only (it checks a parent itself), a definer');
select test.ok(has_function_privilege('authenticated', 'public.school_feed_status(uuid)', 'execute')
               and not has_function_privilege('anon', 'public.school_feed_status(uuid)', 'execute')
               and not has_function_privilege('service_role', 'public.school_feed_status(uuid)', 'execute'),
               'school_feed_status: the same grants as before (signed in only)');
select test.ok(not has_function_privilege('authenticated', 'private.school_auto_add(uuid)', 'execute')
               and not has_function_privilege('anon', 'private.school_auto_add(uuid)', 'execute')
               and not has_function_privilege('authenticated', 'private.school_apply(uuid)', 'execute'),
               'private.school_auto_add and school_apply: nobody signed in or signed out');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%')
                from pg_proc p where p.oid in ('private.school_auto_add(uuid)'::regprocedure, 'private.school_apply(uuid)'::regprocedure,
                                               'public.set_school_auto_add(uuid, boolean)'::regprocedure, 'public.school_feed_status(uuid)'::regprocedure)),
               '... each with set search_path');

-- ---------------------------------------------------------------------
-- The link, checked by due date, and a first read with it off
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
select set_school_feed(test.person('Taylor'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6') as added \gset
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'end', 0);
select test.is((select f ->> 'auto_add' from jsonb_array_elements(school_feed_status(test.person('Taylor')) -> 'feeds') f), 'false',
               'the status card: auto_add false');
:as_owner
insert into assignments (kid_id, kind, title, subject, due_date, status, added_by) values
  (test.person('Taylor'), 'assignment', 'Chapter review', 'Math', '2026-11-16', 'open', 'family');
:as_service
select pg_temp.read('[
  {"title": "Grammar quiz", "subject": "Spanish", "first_day": "2026-11-16", "last_day": "2026-11-16"},
  {"title": "Chapter review", "subject": "Math", "first_day": "2026-11-16", "last_day": "2026-11-16"},
  {"title": "Practice topics due Friday", "subject": "Math", "first_day": "2026-11-13", "last_day": "2026-11-13"},
  {"title": "Practice topics due Friday", "subject": "Math", "first_day": "2026-11-20", "last_day": "2026-11-20"},
  {"title": "Page 116 questions", "subject": "Science", "first_day": "2026-11-12", "last_day": "2026-11-12"},
  {"title": "Essay", "subject": "English", "first_day": "2026-12-30", "last_day": "2026-12-30"}
]') ->> 'kept';
select test.is(pg_temp.hw(), '', 'off: nothing is added by a read');
select test.is(pg_temp.waiting(), 'Page 116 questions | Practice topics due Friday | Chapter review | Grammar quiz | Practice topics due Friday | Essay',
               '... all six wait in New from school, as on 29');
-- The family hides last week's practice topics (they enter it by hand with a count).
:as_admin
select test.is(pg_temp.run($$select school_item_action((select id from public.school_items where title = 'Practice topics due Friday' and due_date = '2026-11-13'), 'hide')$$),
               'ok', 'last week''s "Practice topics due Friday" hidden');

-- ---------------------------------------------------------------------
-- Who may turn it on
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.run($$select set_school_auto_add(pg_temp.fid(), true)$$), '42501 Only a parent can change homework.', 'Sam (an adult) can''t');
:as_admin
select set_coach(test.person('Sam'), true);
:as_adult
select test.is(pg_temp.run($$select set_school_auto_add(pg_temp.fid(), true)$$), '42501 Only a parent can change homework.',
               '... nor as the coach (a switch is a parent''s)');
:as_anon
select test.ok(pg_temp.run($$select set_school_auto_add(pg_temp.fid(), true)$$) like '42501%', 'anon can''t');
:as_admin
select test.is(pg_temp.run($$select set_school_auto_add(pg_temp.fid(), null)$$), '22023 Choose on or off.', 'on or off, never null');
select test.is(pg_temp.run($$select set_school_auto_add('00000000-0000-4000-8000-000000000999', true)$$),
               '22023 That school link isn''t there any more.', 'a link that isn''t there');
select test.is(pg_temp.hw(), '', 'nothing refused added anything');

-- ---------------------------------------------------------------------
-- On: what is waiting goes on at once, by the rules
-- ---------------------------------------------------------------------
select set_school_auto_add(pg_temp.fid(), true) as on1 \gset
select test.is(:'on1'::jsonb ->> 'added', '1', 'Alex turns it on: one added at once');
select test.is(pg_temp.hw(), 'Grammar quiz 2026-11-16 (alex@example.com)',
               '... the grammar quiz, with its due date (stamped as Alex, who turned it on, as his Add would be)');
select test.is(pg_temp.hidden(), 'Practice topics due Friday 2026-11-13 | Chapter review 2026-11-16 | Practice topics due Friday 2026-11-20',
               '... hidden instead: the chapter review (already on his list by hand, same title and day) and this week''s practice topics (hidden before)');
select test.is(pg_temp.waiting(), 'Page 116 questions | Essay', '... left waiting: only the past one and the one more than 30 days ahead');
select test.ok((select bool_and(i.made_at is null) from public.school_items i where i.title in ('Page 116 questions', 'Essay')),
               '... never a past item (Page 116, due Thursday) or one more than 30 days ahead (the essay)');
select test.is((select f ->> 'auto_add' from jsonb_array_elements(:'on1'::jsonb -> 'feeds') f), 'true', '... the status card says on');

-- The next read adds what's new, and next week's practice topics are hidden too.
:as_owner
set hub.now = '2026-11-16 09:00 America/New_York';
:as_service
select pg_temp.read('[
  {"title": "Grammar quiz", "subject": "Spanish", "first_day": "2026-11-16", "last_day": "2026-11-16"},
  {"title": "Chapter review", "subject": "Math", "first_day": "2026-11-16", "last_day": "2026-11-16"},
  {"title": "Practice topics due Friday", "subject": "Math", "first_day": "2026-11-20", "last_day": "2026-11-20"},
  {"title": "Practice topics due Friday", "subject": "Math", "first_day": "2026-11-27", "last_day": "2026-11-27"},
  {"title": "Writing test", "subject": "Spanish", "first_day": "2026-11-17", "last_day": "2026-11-17"},
  {"title": "Practice topics due Friday", "subject": "Science", "first_day": "2026-11-20", "last_day": "2026-11-20"}
]') ->> 'kept';
select test.is(pg_temp.hw(), 'Grammar quiz 2026-11-16 (alex@example.com) | Writing test 2026-11-17 (school (added automatically)) | Practice topics due Friday 2026-11-20 (school (added automatically))',
               'the next read: the writing test added, and the same title in another class (Science) isn''t one he hid');
select test.ok((select bool_and(i.hidden and i.made_at is null) from public.school_items i where i.title = 'Practice topics due Friday' and i.subject = 'Math'),
               '... next week''s Math practice topics hidden as well, so the week after finds it too');

-- ---------------------------------------------------------------------
-- Never when it shouldn't
-- ---------------------------------------------------------------------
:as_admin
select pause_school_feed(pg_temp.fid(), true);
:as_owner
insert into school_items (feed_id, key, has_uid, title, subject, first_day, last_day, due_date, first_seen_at, last_seen_at)
values (pg_temp.fid(), md5('k-paused'), false, 'While paused', 'Art', '2026-11-18', '2026-11-18', '2026-11-18', now(), now());
select private.school_apply(pg_temp.fid());
select test.ok(not (pg_temp.hw() like '%While paused%'), 'a paused link adds nothing');
:as_admin
select pause_school_feed(pg_temp.fid(), false);
select save_homework_kid(test.person('Taylor'), false);
:as_owner
select private.school_apply(pg_temp.fid());
select test.ok(not (pg_temp.hw() like '%While paused%'), 'his homework off: nothing added');
:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
select private.school_apply(pg_temp.fid());
select test.ok(pg_temp.hw() like '%While paused 2026-11-18%', '... back on, the next read adds it');
-- A link dated by the day each was given can't be turned on, and one turned on stops adding if its dates change.
:as_admin
select check_school_feed(pg_temp.fid(), 'assigned', 0);
select test.is(pg_temp.run($$select set_school_auto_add(pg_temp.fid(), true)$$),
               '22023 This link''s dates are the day each was given, so Home Hub can''t know the due dates. Use Paste due dates instead.',
               'an "assigned" link: refused, with what to do instead');
:as_owner
insert into school_items (feed_id, key, has_uid, title, subject, first_day, last_day, due_date, first_seen_at, last_seen_at)
values (pg_temp.fid(), md5('k-given'), false, 'Given today', 'Art', '2026-11-16', '2026-11-16', '2026-11-16', now(), now());
select private.school_apply(pg_temp.fid());
select test.ok(not (pg_temp.hw() like '%Given today%'), '... and an on link whose dates became "assigned" adds nothing');
:as_admin
select test.is((set_school_auto_add(pg_temp.fid(), false) -> 'feeds' -> 0 ->> 'auto_add'), 'false', 'off: the status card says so');
