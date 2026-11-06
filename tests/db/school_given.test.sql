-- Keeping what the school gave (migration 0018, docs/v1.3-homework.md §23.6): on an Assignments link dated by the day
-- each item was given ('assigned'), New from school (hers and the parents') reaches 30 days back, an item nobody
-- added is kept (and read again) for 30 days after it was given, and homework made from one that is still open is
-- read again for as long as the read covers the day it was given (school_store's p_from): a new description reaches
-- it, and one taken off the school site goes missing, then gone. A read from a hub-jobs before 0018 (no p_from)
-- covers 14 days back, as on 17, and never marks older homework missing. A 'start' or 'end' link is as on 17
-- (school.test.sql). The new signature's grants, and the old one gone.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (the kid with homework), Morgan (the helper).
-- Everything is made up: the school's host is academy.school.example (the allowed suffix is replaced below).
-- hub.now is Tue Nov 3, 2026 (America/New_York) unless a case moves it.
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-03 09:00 America/New_York';   -- a Tuesday
create function pg_temp.item(p_title text) returns public.school_items language sql stable security definer as $$
  select * from public.school_items where title = p_title
$$;
create function pg_temp.iid(p_title text) returns uuid language sql stable security definer as $$
  select id from public.school_items where title = p_title
$$;
create function pg_temp.fid(p_kid text, p_kind text) returns uuid language sql stable security definer as $$
  select id from public.school_feeds where kid_id = test.person(p_kid) and kind = p_kind
$$;
create function pg_temp.asg(p_title text) returns public.assignments language sql stable security definer as $$
  select * from public.assignments where title = p_title
$$;
create function pg_temp.titles(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(x ->> 'title', ' | ' order by n), '') from jsonb_array_elements(j) with ordinality t (x, n)
$$;
-- One read, as hub-jobs makes it: from 0018 with p_from (the first day it covered); null, as a hub-jobs before 0018.
create function pg_temp.read(p_kid text, p_kind text, p_items jsonb, p_from date) returns jsonb language plpgsql as $$
declare
  b jsonb;
  r jsonb;
begin
  b := public.school_begin(true);
  if not coalesce((b ->> 'go')::boolean, false) then
    return jsonb_build_object('begin', b);
  end if;
  r := public.school_store(p_run => (b ->> 'run_id')::uuid, p_feed => pg_temp.fid(p_kid, p_kind), p_items => p_items,
                           p_stop => null, p_repeats => 0, p_from => p_from);
  perform public.school_finish((b ->> 'run_id')::uuid);
  return r;
end;
$$;
create or replace function private.school_host_suffix() returns text language sql immutable set search_path = '' as $$ select '.school.example' $$;

-- ---------------------------------------------------------------------
-- The schema, the signature and its grants
-- ---------------------------------------------------------------------
select test.is(hub_schema_version(), 22, 'hub_schema_version is 22 (0018 made it 18, 0019 19, 0020 20, 0021 21, 0022 22)');
select test.is((select string_agg(p.oid::regprocedure::text, ' | ' order by p.oid::regprocedure::text) from pg_proc p where p.proname in ('school_store', 'school_kept')),
               'private.school_kept(uuid,jsonb,date,date) | school_store(uuid,uuid,jsonb,text,integer,date)',
               'school_store takes p_from (the old signature is gone); school_kept is new');
select test.ok(has_function_privilege('service_role', 'public.school_store(uuid, uuid, jsonb, text, int, date)', 'execute')
               and not has_function_privilege('anon', 'public.school_store(uuid, uuid, jsonb, text, int, date)', 'execute')
               and not has_function_privilege('authenticated', 'public.school_store(uuid, uuid, jsonb, text, int, date)', 'execute'),
               'school_store: service_role only (as 0006)');
select test.ok(not has_function_privilege('anon', 'private.school_kept(uuid, jsonb, date, date)', 'execute')
               and not has_function_privilege('authenticated', 'private.school_kept(uuid, jsonb, date, date)', 'execute'),
               'private.school_kept: not anon, not authenticated');
select test.ok((select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%')
                from pg_proc p where p.oid in ('public.school_store(uuid, uuid, jsonb, text, int, date)'::regprocedure,
                                               'private.school_kept(uuid, jsonb, date, date)'::regprocedure,
                                               'private.school_new(uuid)'::regprocedure, 'public.school_feed_status(uuid)'::regprocedure,
                                               'private.school_trim()'::regprocedure)),
               '... each with set search_path');
select test.ok((select p.prosecdef from pg_proc p where p.oid = 'public.school_store(uuid, uuid, jsonb, text, int, date)'::regprocedure)
               and not (select p.prosecdef from pg_proc p where p.oid = 'private.school_kept(uuid, jsonb, date, date)'::regprocedure),
               'school_store a definer (as 0006), school_kept not');

-- ---------------------------------------------------------------------
-- A link dated by the day each was given: 30 days back
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
select set_school_feed(test.person('Taylor'), 'assignments', 'webcal://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6') as added \gset
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Book report", "subject": "English", "details": "Read the book.", "first_day": "2026-10-05", "last_day": "2026-10-05"},
  {"title": "Old quiz", "subject": "Math", "first_day": "2026-10-03", "last_day": "2026-10-03"},
  {"title": "Poem", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Map of the rivers", "subject": "Geography", "first_day": "2026-10-20", "last_day": "2026-10-20"}
]', '2026-05-07') ->> 'kept' as kept \gset
-- Not checked yet, the link is read by its default rule (each item's last day, 0006): 14 days back, whatever the read covered.
select test.is(:'kept', '2', 'not checked yet: from 14 days back (the poem and the map), as on 17, though the read covered 180');
:as_admin
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'assigned', 0);
:as_owner
set hub.now = '2026-11-03 10:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Book report", "subject": "English", "details": "Read the book.", "first_day": "2026-10-05", "last_day": "2026-10-05"},
  {"title": "Old quiz", "subject": "Math", "first_day": "2026-10-03", "last_day": "2026-10-03"},
  {"title": "Poem", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Map of the rivers", "subject": "Geography", "first_day": "2026-10-20", "last_day": "2026-10-20"}
]', '2026-05-07') as r \gset
select test.is(:'r'::jsonb ->> 'kept', '3', 'checked as assigned: what was given from 30 days back is kept (the book report, 29 days ago), not the quiz (31)');
select test.is((pg_temp.item('Old quiz')).id, null, '... the quiz isn''t on the hub at all');
:as_admin
select school_feed_status(test.person('Taylor')) as st \gset
select test.is(pg_temp.titles(:'st'::jsonb -> 'new'), 'Book report | Map of the rivers | Poem', 'New from school: given from 30 days ago on, by the day it was given');
:as_anon
select test.is(pg_temp.titles(homework_by_token(test.token('Taylor')) -> 'from_school'), 'Book report | Map of the rivers | Poem', 'her New from school: the same three');

-- Hidden reaches 30 days back too.
:as_admin
select test.is(pg_temp.titles(school_item_action(pg_temp.iid('Map of the rivers'), 'hide') -> 'hidden'), 'Map of the rivers', 'Hide: on the hidden list, given 14 days ago');

-- The book report becomes homework, due after it would have left on 17.
select school_item_action(pg_temp.iid('Book report'), 'add', '2026-11-25');
:as_owner
select test.is((pg_temp.asg('Book report')).due_date || ' ' || (pg_temp.asg('Book report')).status, '2026-11-25 open', 'the book report on her homework, due Nov 25');

-- ---------------------------------------------------------------------
-- Kept 30 days, then let go; followed while its homework is open
-- ---------------------------------------------------------------------
-- Nov 20: the book report was given 46 days ago, the map 31, the poem 18.
set hub.now = '2026-11-20 09:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Book report", "subject": "English", "details": "Read the book, chapters 1 to 6.", "first_day": "2026-10-05", "last_day": "2026-10-05"},
  {"title": "Poem", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Map of the rivers", "subject": "Geography", "first_day": "2026-10-20", "last_day": "2026-10-20"}
]', '2026-05-24') as r \gset
select test.is(:'r'::jsonb ->> 'kept', '2', 'the open book report (46 days) and the poem (18 days) are kept; the hidden map (31 days) isn''t');
:as_owner
select test.is((pg_temp.asg('Book report')).details, 'Read the book, chapters 1 to 6.', 'the school''s new description reaches the open homework, 46 days on');
select test.is((pg_temp.item('Book report')).details, 'Read the book, chapters 1 to 6.', '... and the item keeps it while the homework is open');
select test.is((pg_temp.item('Map of the rivers')).id, null, 'the map nobody added is let go 31 days after it was given');
select test.is((pg_temp.item('Poem')).id is not null and (pg_temp.item('Poem')).made_at is null, true, 'the poem (18 days, nobody added it) is still there');
:as_admin
select test.is(pg_temp.titles(school_feed_status(test.person('Taylor')) -> 'new'), 'Poem', '... in New from school (on 17 it left after 10 days)');

-- school_begin's trim keeps the same rules: the description of open homework stays, items nobody added go at 30 days.
:as_owner
set hub.now = '2026-11-20 10:00 America/New_York';
select private.school_trim();
select test.is((pg_temp.item('Book report')).details, 'Read the book, chapters 1 to 6.', 'school_trim: the open homework''s item keeps its description (46 days)');
select test.is((pg_temp.item('Poem')).id is not null, true, 'school_trim: the poem nobody added (18 days) stays (on 17: deleted at 14)');

-- A read from a hub-jobs before 0018 (no p_from: 14 days back) doesn't hold the book report: it isn't missing.
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Poem", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Lab notes", "subject": "Science", "first_day": "2026-11-18", "last_day": "2026-11-18"}
]', null) as r \gset
select test.is(:'r'::jsonb ->> 'kept' || ' ' || (:'r'::jsonb ->> 'missing'), '1 0',
               'a read without p_from (a hub-jobs before 0018) covers 14 days back: the lab notes kept, nothing older missing');
:as_owner
select test.is((pg_temp.item('Book report')).missing, 0, '... the book report isn''t');

-- The school takes it off its site: missing after one read that covers it, gone after two.
set hub.now = '2026-11-20 11:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Poem", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Lab notes", "subject": "Science", "first_day": "2026-11-18", "last_day": "2026-11-18"}
]', '2026-05-24') as r \gset
select test.is(:'r'::jsonb ->> 'missing' || ' ' || (:'r'::jsonb ->> 'gone'), '1 0', 'off the school site: missing once');
:as_owner
set hub.now = '2026-11-20 12:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Poem", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Lab notes", "subject": "Science", "first_day": "2026-11-18", "last_day": "2026-11-18"}
]', '2026-05-24') as r \gset
select test.is(:'r'::jsonb ->> 'gone', '1', '... then gone');
:as_admin
select test.is(pg_temp.titles(school_feed_status(test.person('Taylor')) -> 'gone'), 'Book report', 'the status card: the book report is no longer on the school site');
:as_anon
select test.is((select x -> 'school' ->> 'gone' from jsonb_array_elements(homework_by_token(test.token('Taylor')) -> 'assignments') x where x ->> 'title' = 'Book report'),
               'true', '... and on her homework');

-- Back on the site: no longer gone.
:as_owner
set hub.now = '2026-11-20 13:00 America/New_York';
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Book report", "subject": "English", "details": "Read the book, chapters 1 to 6.", "first_day": "2026-10-05", "last_day": "2026-10-05"},
  {"title": "Poem", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Lab notes", "subject": "Science", "first_day": "2026-11-18", "last_day": "2026-11-18"}
]', '2026-05-24');
:as_owner
select test.is((pg_temp.item('Book report')).gone_at is null and (pg_temp.item('Book report')).missing = 0, true, 'back on the school site: not gone');

-- Done, it isn't followed any more: the next read lets its description go (at 30 days, as on 17), and nothing is missing.
:as_owner
update public.assignments set status = 'done', done_at = '2026-11-20 14:00 America/New_York' where title = 'Book report';
:as_owner
set hub.now = '2026-11-20 15:00 America/New_York';
select private.school_trim();
select test.is((pg_temp.item('Book report')).details, null, 'done: school_trim empties its description (given 46 days ago)');
:as_service
select pg_temp.read('Taylor', 'assignments', '[
  {"title": "Poem", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"},
  {"title": "Lab notes", "subject": "Science", "first_day": "2026-11-18", "last_day": "2026-11-18"}
]', '2026-05-24') as r \gset
select test.is(:'r'::jsonb ->> 'missing', '0', '... and a read without it marks nothing missing (it isn''t followed)');

-- ---------------------------------------------------------------------
-- A start or end link: p_from changes nothing
-- ---------------------------------------------------------------------
:as_admin
select check_school_feed((:'added'::jsonb ->> 'id')::uuid, 'end', 0);
:as_owner
select test.is((select string_agg(x.title, ' | ' order by x.title) from private.school_kept(pg_temp.fid('Taylor', 'assignments'), '[
  {"title": "Book report", "subject": "English", "first_day": "2026-10-05", "last_day": "2026-10-05"},
  {"title": "Essay", "subject": "English", "first_day": "2026-11-01", "last_day": "2026-11-12"},
  {"title": "Poem", "subject": "English", "first_day": "2026-11-02", "last_day": "2026-11-02"}
]'::jsonb, '2026-11-20', '2026-05-24') x), 'Essay', 'an end link keeps what is due from 14 days back (the essay, due Nov 12), whatever the read covered');
