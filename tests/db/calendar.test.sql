-- Google Calendar (migration 0003, docs/v1.1-google-calendar.md): the calendars table's rules,
-- which events Google should have (routing, titles, descriptions, ids, bodies, daylight saving,
-- the window), the plan and what Google answered, storing a read and putting back changes made in
-- Google, Google events on the pages, My day, day_text and the email, the preview, and the run's
-- lease; and meals on the wall (migration 0004, docs/v1.2-kitchen.md §10). The household is
-- calendar_fixtures.sql's (Taylor is the Spanish-speaking helper).
\ir roles.sql
\ir calendar_fixtures.sql

-- Helpers (owner): what calendar_desired gives for the window, by calendar label.
:as_owner
create function pg_temp.d(p_site text default 'https://hub.example.com/')
returns table (cal text, google_calendar text, day date, end_day date, title text, item_kind text, item_id uuid, job_id text,
               part text, private boolean, base_id text, body jsonb, hash text)
language sql as $$
  select c.label, d.google_calendar, d.day, d.end_day, d.title, d.item_kind, d.item_id, d.job_id, d.part, d.private, d.base_id, d.body, d.hash
  from private.calendar_desired(public.today_local() - 1, public.today_local() + 60, p_site) d
  join public.calendars c on c.id = d.calendar_id
$$;
-- What one calendar gets between two days: "10-27 Piano (con Jordan) | …", all-day first within a day.
create function pg_temp.on_cal(p_cal text, p_from date, p_to date) returns text language sql as $$
  select string_agg(to_char(day, 'MM-DD') || ' ' || title, ' | ' order by day, body -> 'start' ->> 'dateTime' nulls first, title)
  from pg_temp.d() where cal = p_cal and day between p_from and p_to
$$;
create function pg_temp.body(p_cal text, p_title text, p_day date) returns jsonb language sql as $$
  select body from pg_temp.d() where cal = p_cal and title = p_title and day = p_day
$$;
create function pg_temp.desc_of(p_cal text, p_title text, p_day date) returns text language sql as $$
  select pg_temp.body(p_cal, p_title, p_day) ->> 'description'
$$;
-- Writes everything the plan offers and records Google's "ok" (as hub-jobs would), up to p_rounds plans.
create function pg_temp.sync(p_rounds int default 5) returns int language plpgsql as $$
declare
  n int := 0;
  got int;
begin
  for i in 1 .. p_rounds loop
    select count(*) into got from public.calendar_plan('https://hub.example.com/', 1000);
    exit when got = 0;
    perform public.calendar_record((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
                                     'ok', true, 'google_hash', 'g-' || p.event_id, 'google_updated', '2026-10-27T13:00:00Z'))
                                    from public.calendar_plan('https://hub.example.com/', 1000) p));
    n := n + got;
  end loop;
  return n;
end;
$$;
-- The plan as "op title day" lines.
create function pg_temp.plan(p_limit int default 1000) returns text language sql as $$
  select string_agg(op || ' ' || title || ' ' || to_char(day, 'MM-DD'), ' | ' order by n)
  from (select p.*, row_number() over () as n from public.calendar_plan('https://hub.example.com/', p_limit) p) x
$$;
create function pg_temp.cal(p_label text) returns uuid language sql as $$ select id from public.calendars where label = p_label $$;
create function pg_temp.gid(p_label text) returns text language sql as $$ select google_id from public.calendars where label = p_label $$;

-- ---------------------------------------------------------------------
-- The calendars table
-- ---------------------------------------------------------------------
:as_owner
select test.throws($$insert into calendars (google_id, kind, person_id, label) values ('sam@example.com', 'person', test.person('Sam'), 'Sam')$$,
                   'violates check constraint', 'a calendar the hub writes must be a secondary calendar (never someone''s main calendar)');
select test.is(test.try($$insert into calendars (google_id, kind, label, writes) values ('en.usa#holiday@group.v.calendar.google.com', 'family', 'Holidays', false)$$),
               'rows:1', 'a calendar the hub only reads may have a # (holiday calendars)');
select test.throws($$insert into calendars (google_id, kind, label, writes) values ('en.usa#holiday@group.v.calendar.google.com', 'family', 'Holidays', true)$$,
                   'violates check constraint', '... a writing one may not');
select test.throws($$insert into calendars (google_id, kind, person_id, label) values ('hub-alex2@group.calendar.google.com', 'person', test.person('Alex'), 'Alex')$$,
                   'calendars_one_writer', 'one writing calendar per person');
select test.throws($$insert into calendars (google_id, kind, label) values ('hub-family2@group.calendar.google.com', 'family', 'Family')$$,
                   'calendars_one_writer', '... and one for Family');
select test.is(test.try($$insert into calendars (google_id, kind, person_id, label, writes) values ('alex.example@example.com', 'person', test.person('Alex'), 'Alex', false)$$),
               'rows:1', '... while calendars to read can be added beside it');
select test.throws($$insert into calendars (google_id, kind, label, writes, for_kids) values ('kids@example.com', 'family', 'Kids', true, true)$$,
                   'violates check constraint', 'Show to kids only on a read-only calendar');
select test.throws($$insert into calendars (google_id, kind, person_id, label, writes, for_kids) values ('jordan.example@example.com', 'person', test.person('Jordan'), 'Jordan', false, true)$$,
                   'violates check constraint', '... and only on a Family one');
select test.throws($$insert into calendars (google_id, kind, label, writes) values ('someone@example.com', 'person', 'Someone', false)$$,
                   'violates check constraint', 'a person''s calendar needs the person');
select test.throws($$insert into calendars (google_id, kind, person_id, label, writes) values ('fam@example.com', 'family', test.person('Sam'), 'Family', false)$$,
                   'violates check constraint', '... and only a person''s calendar has one');
select test.throws($$insert into calendars (google_id, kind, label, writes) values ('x@example.com', 'family', repeat('x', 41), false)$$,
                   'violates check constraint', 'labels are at most 40 characters');
select test.throws($$insert into calendars (google_id, kind, label, writes) values ('not an id', 'family', 'Family', false)$$,
                   'violates check constraint', 'a Calendar ID looks like an address');
select test.is(test.try($$insert into calendars (google_id, kind, label, writes) values ('  Hub-Extra@Group.Calendar.Google.com ', 'family', '  Extra  ', false)$$),
               'rows:1', 'a pasted ID with spaces and capitals is accepted ...');
insert into calendars (google_id, kind, label, writes) values ('  Hub-Extra@Group.Calendar.Google.com ', 'family', '  Extra  ', false);
select test.is((select google_id || '|' || label from calendars where label = 'Extra'), 'hub-extra@group.calendar.google.com|Extra',
               '... and stored trimmed and lowercased');
delete from calendars where label = 'Extra';

-- Re-pointing a calendar starts it again; the job's own writes don't look like an admin's edit.
begin;
:as_service
update calendars set status = 'error', status_detail = 'x', checked_at = now(), google_name = 'Hub – Taylor' where label = 'Taylor';
select test.ok((select updated_at = created_at and updated_by is null from calendars where label = 'Taylor'),
               'a change by hub-jobs (status, name) keeps updated_at and updated_by');
:as_admin
update calendars set label = 'Taylor' where label = 'Taylor';
update calendars set google_id = 'Hub-Taylor-New@group.calendar.google.com' where label = 'Taylor';
select test.is((select concat_ws(' ', google_id, status, coalesce(status_detail, '-'), coalesce(google_name, '-'),
                                 coalesce(access_role, '-'), coalesce(checked_at::text, '-'), coalesce(read_at::text, '-'),
                                 coalesce(copy_approved_at::text, '-'), updated_by)
                from calendars where label = 'Taylor'),
               'hub-taylor-new@group.calendar.google.com new - - - - - - alex@example.com',
               'a new Google ID: status new, and the name, role, times and Start copying are forgotten');
rollback;
begin;
:as_admin
update calendars set writes = false where label = 'Family';
select test.is((select status || ' ' || coalesce(copy_approved_at::text, '-') from calendars where label = 'Family'), 'new -',
               'switching a calendar between writing and reading starts it again too');
rollback;

-- ---------------------------------------------------------------------
-- Routing (§4): which calendar each item goes on, and its title
-- ---------------------------------------------------------------------
:as_owner
select test.is(pg_temp.on_cal('Alex', '2026-10-26', '2026-11-02'),
               '10-28 ☐ Dogs: Walk dogs | 10-28 ☐ House: Pay water bill | 10-31 Swim (with Jordan) | 11-01 Night flight | 11-02 Kitchen: Paint starts',
               'Alex: his events with who is along, his tasks (☐; pets and home tasks with the Pets and House labels as prefix), his project''s jobs');
select test.is(pg_temp.on_cal('Jordan', '2026-10-26', '2026-11-04'),
               '10-27 2 late: Feed fish, Trash | 10-27 Piano (Taylor) | 10-29 ☐ Private item | 10-29 Carpool (with Taylor) | 10-31 Swim (Alex) | 11-03 Piano (Taylor) | 11-04 Dentist (Morgan)',
               'Jordan: copies of what he is along on, naming who is in charge; a health task as Private item; the late line');
select test.is(pg_temp.on_cal('Taylor', '2026-10-26', '2026-11-03'),
               '10-27 2 atrasadas: Asunto privado, Water plants | 10-27 Piano (con Jordan) | 10-29 Carpool (con Jordan) | 10-31 Family dinner (Alex) | 11-01 ☐ Dogs: Heartworm pill | 11-03 Piano (con Jordan)',
               'Taylor: Spanish words ("con", "2 atrasadas", "Asunto privado"); a private late task counted, not named');
select test.is(pg_temp.on_cal('Dogs', '2026-10-26', '2026-12-26'), '10-30 ☐ Nail trim', 'Pets ("Dogs"): unassigned pets tasks only');
select test.is(pg_temp.on_cal('House', '2026-10-26', '2026-12-26'), '11-05 ☐ Furnace filter | 11-16 Deck: Footings',
               'House: unassigned home tasks, and the jobs of a project with no owner');
select test.is(pg_temp.on_cal('Family', '2026-10-26', '2026-11-05'),
               '10-28 ☐ Call plumber | 10-31 Family dinner | 11-02 Recital',
               'Family: unassigned tasks, an event with 4 or more family members (once), an event nobody is on');
select test.is((select count(*) from pg_temp.d() where cal = 'Family account'), 0::bigint, 'nothing is written to a calendar the hub only reads');
select test.is((select count(*) from pg_temp.d() where title like 'Gym%'), 0::bigint, 'Sam has no calendar: his Gym goes nowhere (nothing falls back to Family)');
select test.is((select count(*) from pg_temp.d() where title like 'Dentist%'), 1::bigint,
               'Morgan has no calendar: his Dentist goes only on Jordan''s, as a copy');
select test.is(pg_temp.desc_of('Family', 'Family dinner', '2026-10-31'),
               E'Made by Home Hub: changes made here are undone. Change it in Home Hub.\nWho''s on it: Alex with Morgan, Sam, Jordan, Taylor\nOpen in Home Hub: https://hub.example.com/#/calendar/2026-10-31',
               '4 or more family members: the description says who''s on it');
select test.is((select string_agg(cal, ', ' order by cal) from pg_temp.d() where title like 'Recital%'), 'Family', 'nobody in charge and nobody along: Family only');
select test.is((select string_agg(cal || ': ' || title, ', ' order by cal) from pg_temp.d() where title like 'Carpool%'),
               'Jordan: Carpool (with Taylor), Taylor: Carpool (con Jordan)', 'nobody in charge with people along: their copies, not Family');
select test.is((select count(*) from pg_temp.d() where title like 'Return books%'), 0::bigint, 'a done task goes nowhere');
select test.is((select string_agg(to_char(day, 'MM-DD'), ' ' order by day) from pg_temp.d() where cal = 'Taylor' and title like 'Piano%'),
               '10-27 11-03 11-17 11-24 12-01 12-08 12-15 12-22', 'a cancelled day of a repeating event goes nowhere; the other days stay');

-- Private items: "Private item", no place, private visibility, only the description's first line.
select test.is(pg_temp.body('Alex', 'Private item', '2026-11-07') - 'id' - 'extendedProperties' - 'start' - 'end',
               '{"status": "confirmed", "summary": "Private item", "description": "Made by Home Hub: changes made here are undone. Change it in Home Hub.",
                 "transparency": "opaque", "visibility": "private"}'::jsonb,
               'a private event: "Private item", no place, private visibility, no link');
select test.is((select private from pg_temp.d() where cal = 'Jordan' and day = '2026-10-29' and item_kind = 'task'), true,
               'a health task is private, whatever its own switch');
select test.is(pg_temp.body('Jordan', '☐ Private item', '2026-10-29') ->> 'visibility', 'private', '... with private visibility');

-- Without Family, Pets or House.
begin;
:as_owner
delete from calendars where label in ('Family', 'Dogs', 'House');
select test.is((select string_agg(cal || ': ' || title, ', ' order by cal) from pg_temp.d() where title like 'Family dinner%'),
               'Alex: Family dinner (with Morgan, Sam, Jordan, Taylor), Jordan: Family dinner (Alex), Taylor: Family dinner (Alex)',
               'no Family calendar: 4 family members get rules 1 and 2 instead');
select test.is((select count(*) from pg_temp.d() where title like any (array['Recital%', '%Nail trim', '%Furnace filter', '%Call plumber', 'Deck%'])), 0::bigint,
               'no Family calendar: unassigned items go nowhere');
select test.is(pg_temp.on_cal('Alex', '2026-10-28', '2026-10-28'), '10-28 ☐ Pets: Walk dogs | 10-28 ☐ House: Pay water bill',
               'no Pets or House calendar: the prefix is the word ("Pets", "House")');
select test.is(pg_temp.on_cal('Taylor', '2026-11-01', '2026-11-01'), '11-01 ☐ Mascotas: Heartworm pill', '... in the calendar''s language');
rollback;
begin;
:as_owner
delete from calendars where label in ('Dogs', 'House');
select test.is((select string_agg(cal || ': ' || title, ', ' order by cal, title) from pg_temp.d() where title like any (array['%Nail trim', '%Furnace filter', 'Deck%'])),
               'Family: Deck: Footings, Family: ☐ Furnace filter, Family: ☐ Nail trim', 'no Pets or House calendar: their items go on Family');
rollback;

-- People off the family list count as nobody.
begin;
:as_owner
update people set active = false where name = 'Jordan';
select test.is((select count(*) from pg_temp.d() where cal = 'Jordan'), 0::bigint, 'an inactive person''s calendar gets nothing');
select test.is(pg_temp.on_cal('Taylor', '2026-10-27', '2026-10-27'), '10-27 2 atrasadas: Asunto privado, Water plants | 10-27 Piano',
               '... and they aren''t named on anyone else''s');
select test.is((select string_agg(title, ', ' order by day, title) from pg_temp.d() where cal = 'Family' and day between '2026-10-26' and '2026-10-31'),
               '2 late: Feed fish, Trash, ☐ Call plumber, ☐ Private item',
               '... their tasks are nobody''s, so they go on Family');
select test.is((select string_agg(cal || ': ' || title, ', ' order by cal) from pg_temp.d() where title like 'Family dinner%'),
               'Alex: Family dinner (with Morgan, Sam, Taylor), Taylor: Family dinner (Alex)',
               '... and Family dinner, with 3 family members left, is Alex''s with copies again');
rollback;

-- The late line: one per calendar on today, gone when nothing is late, the same id the next day.
:as_owner
create temp table late_id as select base_id from pg_temp.d() where cal = 'Jordan' and item_kind = 'late';
set hub.now = '2026-10-28 09:00 America/New_York';
select test.is((select base_id from pg_temp.d() where cal = 'Jordan' and item_kind = 'late'), (select base_id from late_id),
               'the late line keeps its id from day to day');
select test.is((select day from pg_temp.d() where cal = 'Jordan' and item_kind = 'late'), '2026-10-28'::date, '... and moves to today');
-- A missed weekly task: on its next date it leaves the late line and has its own event on today.
set hub.now = '2026-11-02 09:00 America/New_York';
select test.is(pg_temp.on_cal('Jordan', '2026-11-02', '2026-11-02'), '11-02 2 late: Feed fish, Private item | 11-02 ☐ Trash',
               'a missed weekly task that reaches its next date leaves the late line and is on today again');
begin;
update tasks set done_at = now() where title in ('Feed fish', 'Allergy pills');
select test.is((select count(*) from pg_temp.d() where cal = 'Jordan' and item_kind = 'late'), 0::bigint, 'no late tasks: no late line');
rollback;
set hub.now = '2026-10-27 09:00 America/New_York';

-- Projects (rule 11).
:as_owner
select test.is(pg_temp.on_cal('Alex', '2026-11-03', '2026-11-12'),
               '11-07 Swim (with Jordan) | 11-07 Private item | 11-09 Kitchen: Inspection | 11-09 Kitchen: Wire | 11-12 Kitchen: Paint finishes',
               'projects: a long job is two markers, a 2-day job and a milestone are one event each, a done job is left out');
select test.is((select end_day from pg_temp.d() where title = 'Kitchen: Wire'), '2026-11-10'::date, '... a 2-day job covers its days');
select test.is((select count(distinct base_id) from pg_temp.d() where title in ('Kitchen: Wire', 'Kitchen: Inspection')), 2::bigint,
               'two jobs of one project starting the same day get two events (two ids)');
create temp table wire_id as select base_id from pg_temp.d() where title = 'Kitchen: Wire';
begin;
update projects set task_dates = jsonb_set(task_dates, '{2,name}', '"Rewire"') where name = 'Kitchen';
select test.is((select base_id from pg_temp.d() where title = 'Kitchen: Rewire'), (select base_id from wire_id), 'renaming a job keeps its id');
rollback;
begin;
set hub.now = '2026-11-05 09:00 America/New_York';
select test.is((select string_agg(title || ' ' || to_char(day, 'MM-DD'), ', ' order by day) from pg_temp.d() where title like 'Kitchen: Paint%'),
               'Kitchen: Paint finishes 11-12', 'a job that started before the window: only its finish marker');
rollback;
set hub.now = '2026-10-27 09:00 America/New_York';

-- ---------------------------------------------------------------------
-- Descriptions
-- ---------------------------------------------------------------------
select test.is(pg_temp.desc_of('Taylor', 'Piano (con Jordan)', '2026-10-27'),
               E'Hecho por Home Hub: si lo cambias aquí, se deshace. Se cambia en Home Hub.\nRivera Music 555-0150',
               'the first line in the calendar''s language; the linked directory entry''s name and number; no link on a helper''s calendar');
select test.is(pg_temp.desc_of('Jordan', 'Piano (Taylor)', '2026-10-27'),
               E'Made by Home Hub: changes made here are undone. Change it in Home Hub.\nRivera Music 555-0150',
               '... no link and no Skip hint on a kid''s calendar');
select test.is(pg_temp.desc_of('Alex', 'Swim (with Jordan)', '2026-10-31'),
               E'Made by Home Hub: changes made here are undone. Change it in Home Hub. To cancel one day, use Skip this day in Home Hub.\nOpen in Home Hub: https://hub.example.com/#/calendar/2026-10-31',
               'a repeating event on a grown-up''s calendar: the Skip hint, and the link to that day');
select test.is(pg_temp.desc_of('Alex', '☐ House: Pay water bill', '2026-10-28'),
               E'Made by Home Hub: changes made here are undone. Change it in Home Hub.\nCity Water 555-0160\nOpen in Home Hub: https://hub.example.com/#/calendar/2026-10-28',
               'a task: no Skip hint; a directory entry with an account number shows only its name and number');
select test.is((select count(*) from pg_temp.d(null) where body ->> 'description' like '%Open in Home Hub%'), 0::bigint, 'no SITE_URL: no link');
select test.is((select string_agg(distinct cal, ', ') from pg_temp.d()
                where concat_ws(' ', body ->> 'summary', body ->> 'description', body ->> 'location')
                      ~ 'green book|Side door|code 1234|Gate code|Account on file|0000-1111-2222|day\.html|555-010[2-6]|@'),
               null, 'never notes, a day''s own note, codes, account numbers, the family''s phones or emails, or a My day link');
select test.is((select count(*) from pg_temp.d() d where exists (select 1 from people p where d.body::text like '%' || p.day_token || '%')
                                                     or exists (select 1 from people_confirm c where d.body::text like '%' || c.token || '%')), 0::bigint,
               'never a My day token or a confirmation secret');
select test.is((select count(*) from pg_temp.d() where body ? 'attendees' or body ? 'reminders' or body ? 'colorId'), 0::bigint,
               'no attendees, reminders or colours');

-- ---------------------------------------------------------------------
-- Ids and bodies
-- ---------------------------------------------------------------------
select test.is((select count(*) from pg_temp.d() where base_id !~ '^hh[0-9a-f]{32}$' or body ->> 'id' <> base_id), 0::bigint,
               'every id is hh and 32 hex characters (Google allows [a-v0-9]), and the body carries it');
select test.is((select count(*) from pg_temp.d()), (select count(distinct (google_calendar, base_id)) from pg_temp.d()),
               'no two events share an id on one Google calendar');
select test.is((select count(*) from pg_temp.d()), 57::bigint, 'the fixture''s window holds 57 events');
select test.is((select string_agg(base_id || hash, ',' order by google_calendar, base_id) from pg_temp.d()),
               (select string_agg(base_id || hash, ',' order by google_calendar, base_id) from pg_temp.d()), 'ids and hashes are the same on every call');
select test.is((select count(distinct base_id) from pg_temp.d() where title like 'Piano%' and day = '2026-10-27'), 2::bigint,
               'the same occurrence gets a different id on each Google calendar');
select test.is((select base_id from pg_temp.d() where cal = 'Taylor' and title like 'Piano%' and day = '2026-10-27'),
               'hh' || md5('event|' || test.event('Piano') || '|2026-10-27|hub-taylor@group.calendar.google.com|'),
               'an event''s id: event|<id>|<occurrence>|<Google calendar ID>|');
select test.is((select base_id from pg_temp.d() where title = 'Kitchen: Paint starts'),
               'hh' || md5('project|' || test.project('Kitchen') || '|p|hub-alex@group.calendar.google.com|start'),
               'a project job''s id: project|<project id>|<job id>|<Google calendar ID>|<part>');
select test.is((select base_id from pg_temp.d() where cal = 'Jordan' and item_kind = 'late'), 'hh' || md5('late|hub-jordan@group.calendar.google.com'),
               'a late line''s id: late|<Google calendar ID>');
select test.is(pg_temp.body('Taylor', 'Piano (con Jordan)', '2026-11-03') - 'id',
               jsonb_build_object(
                 'status', 'confirmed', 'summary', 'Piano (con Jordan)', 'location', 'Rivera Music, 12 Elm St',
                 'description', E'Hecho por Home Hub: si lo cambias aquí, se deshace. Se cambia en Home Hub.\nRivera Music 555-0150',
                 'start', '{"dateTime": "2026-11-03T21:00:00Z", "timeZone": "America/New_York"}'::jsonb,
                 'end', '{"dateTime": "2026-11-03T22:00:00Z", "timeZone": "America/New_York"}'::jsonb,
                 'transparency', 'opaque', 'visibility', 'default',
                 'extendedProperties', jsonb_build_object('private', jsonb_build_object(
                   'homehub', '1', 'homehub_base', (select base_id from pg_temp.d() where cal = 'Taylor' and title = 'Piano (con Jordan)' and day = '2026-11-03'),
                   'homehub_kind', 'event', 'homehub_item', test.event('Piano')::text, 'homehub_occurrence', '2026-11-03'))),
               'the body of Taylor''s Piano on Tue Nov 3 (the design''s example): instants in UTC, the household''s zone, no attendees');
select test.is((select hash from pg_temp.d() where cal = 'Taylor' and title = 'Piano (con Jordan)' and day = '2026-11-03'),
               md5(pg_temp.body('Taylor', 'Piano (con Jordan)', '2026-11-03')::text), 'the hash is md5 of the body');
select test.is((pg_temp.body('Alex', 'Kitchen: Wire', '2026-11-09') -> 'extendedProperties' -> 'private') - 'homehub_base',
               jsonb_build_object('homehub', '1', 'homehub_kind', 'project', 'homehub_item', test.project('Kitchen')::text, 'homehub_job', 'a'),
               'a project job carries homehub_job (and homehub_part for a marker)');
select test.is(pg_temp.body('Alex', 'Kitchen: Paint starts', '2026-11-02') -> 'extendedProperties' -> 'private' ->> 'homehub_part', 'start',
               '... a marker''s part');
select test.is((pg_temp.body('Jordan', '2 late: Feed fish, Trash', '2026-10-27') -> 'extendedProperties' -> 'private') - 'homehub_base',
               '{"homehub": "1", "homehub_kind": "late"}'::jsonb, 'a late line is kind late, with no item');

-- Session settings change nothing.
create temp table hashes as select string_agg(base_id || ' ' || hash, ',' order by google_calendar, base_id) as h from pg_temp.d();
set datestyle = 'SQL, DMY';
set timezone = 'Asia/Tokyo';
select test.is((select string_agg(base_id || ' ' || hash, ',' order by google_calendar, base_id) from pg_temp.d()), (select h from hashes),
               'with DateStyle SQL, DMY and TimeZone Asia/Tokyo: the same ids, bodies and hashes');
reset datestyle;
reset timezone;

-- ---------------------------------------------------------------------
-- Daylight saving, timed tasks and all-day ends
-- ---------------------------------------------------------------------
:as_owner
create function pg_temp.times(p_cal text, p_title text, p_day date) returns text language sql as $$
  select coalesce(body -> 'start' ->> 'dateTime', body -> 'start' ->> 'date') || ' ' || coalesce(body -> 'end' ->> 'dateTime', body -> 'end' ->> 'date')
         || ' ' || (body ->> 'transparency')
  from pg_temp.d() where cal = p_cal and title = p_title and day = p_day
$$;
select test.is(pg_temp.times('Taylor', 'Piano (con Jordan)', '2026-10-27') || ' / ' || pg_temp.times('Taylor', 'Piano (con Jordan)', '2026-11-03'),
               '2026-10-27T20:00:00Z 2026-10-27T21:00:00Z opaque / 2026-11-03T21:00:00Z 2026-11-03T22:00:00Z opaque',
               'a weekly 4pm event: 20:00Z on Oct 27, 21:00Z on Nov 3 after the clock goes back (timed events are opaque)');
select test.is(pg_temp.times('Alex', 'Night flight', '2026-11-01'), '2026-11-01T06:30:00Z 2026-11-01T07:30:00Z opaque',
               '01:30 on Nov 1, the hour that happens twice: 06:30Z (as Postgres reads it); no end time: one real hour');
begin;
insert into events (title, start_date, start_time, responsible_id) values
  ('Early train', '2027-03-14', '02:30', test.person('Alex')),
  ('Red-eye', '2027-03-14', '01:30', test.person('Alex'));
set hub.now = '2027-03-01 09:00 America/New_York';
select test.is(pg_temp.times('Alex', 'Early train', '2027-03-14'), '2027-03-14T07:30:00Z 2027-03-14T08:30:00Z opaque',
               '02:30 on Mar 14, 2027, the hour that doesn''t happen: 07:30Z');
select test.is(pg_temp.times('Alex', 'Red-eye', '2027-03-14'), '2027-03-14T06:30:00Z 2027-03-14T07:30:00Z opaque',
               'an event with no end time across the change lasts one real hour');
rollback;
select test.is(pg_temp.times('Alex', '☐ House: Pay water bill', '2026-10-28'), '2026-10-28T13:30:00Z 2026-10-28T14:00:00Z opaque',
               'a task with a time is a 30-minute event');
select test.is(pg_temp.times('Family', 'Recital', '2026-11-02'), '2026-11-02 2026-11-03 transparent',
               'an all-day event ends on the next day (Google''s end is exclusive) and doesn''t block free/busy');
select test.is(pg_temp.times('Alex', 'Trip', '2026-11-13'), '2026-11-13 2026-11-16 transparent', '... a 3-day one too');
select test.is((pg_temp.body('Alex', 'Night flight', '2026-11-01') -> 'start' ->> 'timeZone'), 'America/New_York', 'timed events carry the household''s zone');

-- The window: yesterday to today + 60.
begin;
insert into events (title, start_date, responsible_id) values
  ('Two days ago', '2026-10-25', test.person('Alex')), ('Yesterday', '2026-10-26', test.person('Alex')),
  ('Day 60', '2026-12-26', test.person('Alex')), ('Day 61', '2026-12-27', test.person('Alex'));
select test.is((select string_agg(title, ', ' order by day) from pg_temp.d() where title in ('Two days ago', 'Yesterday', 'Day 60', 'Day 61')),
               'Yesterday, Day 60', 'the window is yesterday to today + 60: today + 61 is not in it yet');
rollback;

-- ---------------------------------------------------------------------
-- calendar_preview: everything Start copying puts on one calendar (admins)
-- ---------------------------------------------------------------------
:as_admin
select test.is((select string_agg(to_char(day, 'MM-DD') || ' ' || title || ' ' || item_kind || case when private then ' private' else '' end, ' | ')
                from calendar_preview(pg_temp.cal('Taylor'))),
               '10-27 2 atrasadas: Asunto privado, Water plants late | 10-27 Piano (con Jordan) event | 10-29 Carpool (con Jordan) event | '
               '10-31 Family dinner (Alex) event | 11-01 ☐ Dogs: Heartworm pill task | 11-03 Piano (con Jordan) event | '
               '11-17 Piano (con Jordan) event | 11-24 Piano (con Jordan) event | 12-01 Piano (con Jordan) event | 12-08 Piano (con Jordan) event | '
               '12-15 Piano (con Jordan) event | 12-22 Piano (con Jordan) event',
               'preview: everything Start copying puts on the calendar, as the wall will show it, in order');
select test.is((select string_agg(title || ' ' || private, ', ') from calendar_preview(pg_temp.cal('Alex')) where day = '2026-11-07'),
               'Swim (with Jordan) false, Private item true', 'preview: private items as "Private item", marked private');
select test.is((select max(day) from calendar_preview(pg_temp.cal('Alex'))), '2026-12-26'::date,
               'preview: up to 60 days ahead, the window the job copies (not just the next 14 days)');
select test.is((select string_agg(to_char(day, 'MM-DD') || ' ' || title, ', ' order by day) from calendar_preview(pg_temp.cal('Alex'))
                where day >= '2026-11-10' and item_kind = 'event' and title not like 'Swim%'),
               '11-13 Trip', '... so a trip three weeks out is shown before it is copied');
begin;
:as_owner
insert into events (title, start_date, responsible_id) values
  ('Yesterday errand', '2026-10-26', test.person('Alex')), ('Day 60 errand', '2026-12-26', test.person('Alex')),
  ('Day 61 errand', '2026-12-27', test.person('Alex'));
:as_admin
select test.is((select string_agg(title, ', ' order by day) from calendar_preview(pg_temp.cal('Alex')) where title like '%errand'),
               'Yesterday errand, Day 60 errand', 'preview: from yesterday to today + 60, the same days as the plan');
rollback;
:as_admin
select test.is((select concat_ws(' | ', place, details) from calendar_preview(pg_temp.cal('Taylor')) where day = '2026-11-03'),
               'Rivera Music, 12 Elm St | Rivera Music 555-0150',
               'preview: the place and the directory entry''s name and number, as they go on the wall');
select test.is((select details from calendar_preview(pg_temp.cal('Family')) where title = 'Family dinner'),
               'Who''s on it: Alex with Morgan, Sam, Jordan, Taylor', '... and who''s on a Family event');
select test.is((select concat_ws(' | ', coalesce(place, '-'), coalesce(details, '-')) from calendar_preview(pg_temp.cal('Alex')) where title = 'Private item'),
               '- | -', '... nothing for a private item');
select test.is((select item_id from calendar_preview(pg_temp.cal('Jordan')) where title = '☐ Private item'), test.task('Allergy pills'),
               'preview: each row names its item, for Make private');
select test.is((select count(*) from calendar_preview(pg_temp.cal('Family account'))), 0::bigint, 'preview: nothing for a calendar the hub only reads');
:as_adult
select test.throws($$select * from calendar_preview(pg_temp.cal('Taylor'))$$, 'Only an admin', 'preview: admins only');

-- ---------------------------------------------------------------------
-- The plan and calendar_record (§3.3), as hub-jobs (service_role)
-- ---------------------------------------------------------------------
:as_owner
insert into events (title, start_date, end_date, responsible_id) values
  ('Camping', '2026-10-24', '2026-10-28', test.person('Alex')),       -- began 3 days ago, still going
  ('Sabbatical', '2026-09-22', '2026-10-31', test.person('Alex'));    -- 40 days, began 35 days ago
:as_service
select test.is(pg_temp.plan(5),
               'insert Sabbatical 09-22 | insert Camping 10-24 | insert 2 atrasadas: Asunto privado, Water plants 10-27 | '
               'insert 2 late: Feed fish, Trash 10-27 | insert Piano (Taylor) 10-27',
               'the first plan: all inserts, nearest days first, at most p_limit rows');
select test.is((select min(pending) || ' ' || max(pending) || ' ' || max(hiding) || ' ' || count(*) from calendar_plan('https://hub.example.com/', 5)),
               '59 59 0 5', '... each row says how many writes are pending in all, and how many hide something');
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000)
                where op <> 'insert' or event_id <> base_id or gen <> 0 or hash <> md5(body::text) or body ->> 'id' <> event_id),
               0::bigint, '... an insert''s event_id is its base_id, and its hash the body''s');
select test.is(pg_temp.sync(), 59, 'hub-jobs writes them, and calendar_record records Google''s answers');
select test.is(pg_temp.plan(), null, 'after calendar_record the plan is empty (a 40-day event that began 35 days ago included)');
select test.is((select count(*) || ' ' || count(*) filter (where status = 'ok' and synced_at = private.now() and hash is not null and tried_hash = hash
                                                            and attempts = 0 and google_hash = 'g-' || event_id
                                                            and google_updated = '2026-10-27 13:00+00')
                from calendar_links), '59 59', 'every link is ok, with the hash written and Google''s hash and time');

:as_owner
update events set title = 'School recital' where title = 'Recital';
:as_service
select test.is(pg_temp.plan(), 'update School recital 11-02', 'one edited title: one update');
select pg_temp.sync();

:as_owner
update events set title = 'Dentist checkup' where title = 'Dentist';
update events set private = true where title = 'Carpool';
:as_service
select test.is(pg_temp.plan(), 'update Asunto privado 10-29 | update Private item 10-29 | update Dentist checkup (Morgan) 11-04',
               'an item just made private is updated first');
select test.is((select min(pending) || ' ' || min(hiding) from calendar_plan('https://hub.example.com/', 1)), '3 2',
               '... and counted as hiding ("Hiding 2 items in Google…")');
select pg_temp.sync();

:as_owner
delete from events where title = 'Camping';
:as_service
select test.is(pg_temp.plan(), 'delete Camping 10-24', 'deleting an event that began 3 days ago and is still going: a delete');
select pg_temp.sync();
select test.is((select count(*) from calendar_links where title = 'Camping'), 0::bigint, '... and its link goes once Google deleted it');

-- The past is kept, unless the item was deleted or is now private (or a health task).
begin;
:as_owner
set hub.now = '2026-11-20 09:00 America/New_York';
update events set private = true where title = 'Dentist checkup';
delete from events where title = 'Family dinner';
:as_service
select test.is((select string_agg(op || ' ' || title || ' ' || to_char(day, 'MM-DD'), ' | ' order by day, title)
                from calendar_plan('https://hub.example.com/', 1000) where day < '2026-11-19'),
               'delete Asunto privado 10-29 | delete Private item 10-29 | delete ☐ Private item 10-29 | delete Family dinner 10-31 | '
               'delete Family dinner (Alex) 10-31 | delete Dentist checkup (Morgan) 11-04 | delete Private item 11-07',
               'three weeks on: past events of deleted or now-private items (and health tasks) are deleted; the rest of the past stays');
select test.is((select op || ' ' || title || ' ' || to_char(day, 'MM-DD') from calendar_plan('https://hub.example.com/', 1000)
                where item_kind = 'late' and google_calendar = 'hub-jordan@group.calendar.google.com'),
               'update 3 late: Feed fish, Private item, Trash 11-20', '... and the late line moves to today (same id)');
rollback;

-- A new Google ID: the old calendar's events are deleted; the new one waits for its check and approval.
begin;
:as_admin
update calendars set google_id = 'hub-jordan-2@group.calendar.google.com' where label = 'Jordan';
:as_service
select test.is((select string_agg(distinct op || ' ' || google_calendar, ', ') || ' ' || count(*) from calendar_plan('https://hub.example.com/', 1000)),
               'delete hub-jordan@group.calendar.google.com ' || (select count(*) from calendar_links where google_calendar = 'hub-jordan@group.calendar.google.com'),
               'a changed Google ID: every event on the old calendar is deleted, whatever its day; nothing yet on the new one');
select calendar_mark(pg_temp.cal('Jordan'), 'hub-jordan-2@group.calendar.google.com', 'ok', null, 'Hub – Jordan', 'writer');
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000) where op = 'insert'), 0::bigint,
               '... checked but not approved: still nothing on the new one');
:as_admin
update calendars set copy_approved_at = now() where label = 'Jordan';
:as_service
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000) where op = 'insert' and google_calendar = 'hub-jordan-2@group.calendar.google.com'),
               (select count(*) from calendar_links where google_calendar = 'hub-jordan@group.calendar.google.com'),
               '... approved (Start copying): everything is inserted on the new one');
rollback;

-- Disconnect: the hub's events come off; a failing delete backs off, and is forgotten after 10 tries.
begin;
:as_admin
delete from calendars where label = 'Taylor';
:as_service
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000) where op = 'delete' and google_calendar = 'hub-taylor@group.calendar.google.com'),
               (select count(*) from calendar_links where calendar_id is null and google_calendar = 'hub-taylor@group.calendar.google.com'),
               'Disconnect: every event the hub wrote there is deleted, whatever its day');
select calendar_record((select jsonb_agg(to_jsonb(p) || '{"ok": false, "http": 500, "error": "Backend Error"}') from calendar_plan('https://hub.example.com/', 1000) p));
select test.is(pg_temp.plan(), null, '... a failed delete backs off');
select test.is((select string_agg(distinct concat_ws(' ', status, attempts, error, next_try_at - private.now(), failing_since = private.now(), hash is null, tried_hash), ', ')
                from calendar_links where calendar_id is null),
               'error 1 Backend Error 00:05:00 t t delete', '... error, 5 minutes, failing since now, the hash forgotten, tried "delete"');
:as_owner
set hub.now = '2026-10-27 09:06 America/New_York';
:as_service
select test.ok((select count(*) from calendar_plan('https://hub.example.com/', 1000) where op = 'delete') > 0, '... and is tried again after 5 minutes');
select calendar_record((select jsonb_agg(to_jsonb(p) || '{"ok": false, "http": 500, "error": "Backend Error"}') from calendar_plan('https://hub.example.com/', 1000) p));
select test.is((select string_agg(distinct (next_try_at - private.now())::text, ', ') from calendar_links where calendar_id is null), '00:10:00',
               '... then after 10 minutes (5 × 2^(attempts − 1))');
:as_owner
do $$
begin
  for i in 3 .. 10 loop
    perform set_config('hub.now', (private.now() + interval '7 hours')::text, false);
    perform public.calendar_record((select jsonb_agg(to_jsonb(p) || '{"ok": false, "http": 500, "error": "Backend Error"}')
                                    from public.calendar_plan('https://hub.example.com/', 1000) p where p.op = 'delete'));
  end loop;
end;
$$;
select test.is((select count(*) from calendar_links where calendar_id is null), 0::bigint, '... and forgotten after 10 tries');
rollback;
begin;
:as_admin
delete from calendars where label = 'Taylor';
:as_service
select calendar_record((select jsonb_agg(to_jsonb(p) || '{"ok": false, "forget": true, "http": 404, "error": "Not Found"}')
                        from calendar_plan('https://hub.example.com/', 1000) p));
select test.is((select count(*) from calendar_links where google_calendar = 'hub-taylor@group.calendar.google.com'), 0::bigint,
               'Disconnect: a confirmed calendar-level 404 (forget) forgets the links at once');
rollback;

-- A project whose dates are out of date: its events are left alone.
begin;
:as_owner
update projects set task_dates = null where name = 'Kitchen';
:as_service
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000) where item_kind = 'project'), 0::bigint,
               'a project on the calendar whose dates are stale: no op for its events (neither delete nor update)');
:as_owner
update projects set status = 'done' where name = 'Kitchen';
:as_service
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000) where item_kind = 'project' and op = 'delete'), 4::bigint,
               '... a done project''s events are deleted');
rollback;

-- What holds writes back.
:as_owner
insert into events (title, start_date, start_time, responsible_id) values ('Haircut', '2026-10-30', '11:00', test.person('Alex'));
:as_service
select test.is(pg_temp.plan(), 'insert Haircut 10-30', 'a new event on Alex''s calendar: one insert');
begin;
update calendars set status = 'new' where label = 'Alex';
select test.is(pg_temp.plan(), null, '... none while the calendar is new (not checked at its Google ID)');
rollback;
begin;
update calendars set status = 'no_access' where label = 'Alex';
select test.is(pg_temp.plan(), null, '... or no_access');
rollback;
begin;
update calendars set copy_approved_at = null where label = 'Alex';
select test.is(pg_temp.plan(), null, '... or not approved (Start copying)');
rollback;
begin;
update calendars set access_role = 'owner' where label = 'Alex';
select test.is(pg_temp.plan(), null, '... or seen with the wrong access role (owner, for the service account)');
update calendar_sync set auth = 'oauth';
select test.is(pg_temp.plan(), 'insert Haircut 10-30', '... which is the right one when signed in with OAuth');
update calendars set access_role = 'writer' where label = 'Alex';
select test.is(pg_temp.plan(), null, '... where writer is the wrong one');
rollback;
begin;
update calendar_sync set paused_until = private.now() + interval '10 minutes';
select test.is(pg_temp.plan(), null, '... or while Google''s pause lasts');
rollback;

-- Backoff on one link: respected, unless the item changed in the hub.
select calendar_record((select jsonb_agg(to_jsonb(p) || '{"ok": false, "http": 503, "error": "Backend Error"}') from calendar_plan('https://hub.example.com/', 1000) p));
select test.is(pg_temp.plan(), null, 'a failed insert backs off');
select test.is((select concat_ws(' ', status, attempts, synced_at is null, hash is null) from calendar_links where title = 'Haircut'), 'error 1 t t',
               '... unwritten, so the next try is an insert');
:as_owner
update events set title = 'Haircut and color' where title = 'Haircut';
:as_service
select test.is(pg_temp.plan(), 'insert Haircut and color 10-30', '... a change in the hub is tried at once');
select pg_temp.sync();
select test.is((select concat_ws(' ', status, attempts, coalesce(error, '-'), coalesce(next_try_at::text, '-'), coalesce(failing_since::text, '-'))
                from calendar_links where title = 'Haircut and color'), 'ok 0 - - -', '... and once written the link is ok again');

-- A failed delete of an item that is wanted again becomes an update.
:as_owner
update tasks set done_at = now() where title = 'Walk dogs';
:as_service
select test.is(pg_temp.plan(), 'delete ☐ Dogs: Walk dogs 10-28', 'a task done: a delete');
select calendar_record((select jsonb_agg(to_jsonb(p) || '{"ok": false, "http": 500, "error": "Backend Error"}') from calendar_plan('https://hub.example.com/', 1000) p));
:as_owner
update tasks set done_at = null where title = 'Walk dogs';
:as_service
select test.is(pg_temp.plan(), 'update ☐ Dogs: Walk dogs 10-28', '... undone before the delete got through: an update, at once');
select pg_temp.sync();
select test.is(pg_temp.plan(), null, '... and all is in step again');

-- calendar_record: one bad row doesn't lose the others; a calendar disconnected during the run; a clash.
begin;
:as_owner
insert into events (title, start_date, responsible_id) select 'Practice ' || i, '2026-11-20', test.person('Alex') from generate_series(1, 20) i;
:as_service
create temp table batch as select row_number() over () as n, to_jsonb(p) as r from calendar_plan('https://hub.example.com/', 1000) p;
select calendar_record((select jsonb_agg(case when n = 7 then r || '{"day": "not a date"}' else r end || '{"ok": true}' order by n) from batch));
select test.is((select count(*) from calendar_links where title like 'Practice %'), 19::bigint, 'calendar_record: one bad row doesn''t lose the other 19');
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000)), 1::bigint, '... and the bad one is planned again');
rollback;
begin;
:as_owner
insert into tasks (title, due_date, category) values ('Brush dogs', '2026-11-01', 'pets');
:as_service
create temp table run_rows as select to_jsonb(p) as r from calendar_plan('https://hub.example.com/', 1000) p;
delete from calendars where label = 'Dogs';
select calendar_record((select jsonb_agg(r || '{"ok": true}') from run_rows));
select test.is((select concat_ws(' ', calendar_id is null, status) from calendar_links where title = '☐ Brush dogs'), 't ok',
               'a calendar disconnected while the run wrote to it: the link is kept with calendar_id null');
select test.is(pg_temp.plan(),
               'delete ☐ Nail trim 10-30 | delete ☐ Brush dogs 11-01 | update ☐ Pets: Walk dogs 10-28 | insert ☐ Nail trim 10-30 | '
               'insert ☐ Brush dogs 11-01 | update ☐ Mascotas: Heartworm pill 11-01',
               '... and the next plan deletes it (and moves what was on Pets to Family, with the word as prefix)');
rollback;
begin;
:as_owner
insert into events (title, start_date, responsible_id) values ('Picture day', '2026-11-06', test.person('Jordan'));
:as_service
select calendar_record((select jsonb_agg(to_jsonb(p) || '{"ok": false, "clash": true}') from calendar_plan('https://hub.example.com/', 1000) p));
select test.is((select concat_ws(' ', gen, event_id = 'hh' || md5('event|' || test.event('Picture day') || '|2026-11-06|hub-jordan@group.calendar.google.com||1'),
                                 base_id = 'hh' || md5('event|' || test.event('Picture day') || '|2026-11-06|hub-jordan@group.calendar.google.com|'),
                                 synced_at is null, hash is null)
                from calendar_links where title = 'Picture day'),
               '1 t t t t', 'a clash (the id is taken elsewhere): gen 1 and a new id from the key and gen');
select test.is((select concat_ws(' ', op, gen, event_id = (select event_id from calendar_links where title = 'Picture day'), body ->> 'id' = event_id, base_id <> event_id)
                from calendar_plan('https://hub.example.com/', 1000)), 'insert 1 t t t', '... and the next insert uses the new id');
select pg_temp.sync();
select test.is((select status || ' ' || gen from calendar_links where title = 'Picture day'), 'ok 1', '... which is then the event''s');
rollback;

-- ---------------------------------------------------------------------
-- The run: calendar_read_due, calendar_begin, calendar_signed_in, calendar_finish
-- ---------------------------------------------------------------------
:as_service
select test.is((select count(*) from calendar_read_due()), 0::bigint, 'read_due: nothing read 5 minutes ago is due');
select test.is((select count(*) from calendar_read_due(true)), 7::bigint, 'read_due: Sync now (p_force) reads every calendar');
select test.is((select concat_ws(' ', w_from, w_to, time_min, time_max, tz) from calendar_read_due(true) limit 1),
               '2026-10-26 2026-12-26 2026-10-26 04:00:00+00 2026-12-27 05:00:00+00 America/New_York',
               'read_due: the window, and local midnight before it and after its last day');
begin;
update calendars set read_at = null where label = 'House';
update calendars set read_at = '2026-10-27 12:45+00' where label = 'Dogs';
update calendars set status = 'error', read_at = '2026-10-27 11:00+00', checked_at = '2026-10-27 12:30+00' where label = 'Family';
update calendars set status = 'no_access', read_at = '2026-10-27 10:00+00', checked_at = '2026-10-27 11:59+00' where label = 'Family account';
select test.is((select string_agg(c.label, ', ') from calendar_read_due() r join calendars c on c.id = r.calendar_id),
               'House, Family account, Dogs',
               'read_due: never read first, then the oldest; 14 minutes for ok ones, an hour for no_access and error ones');
select test.is((select count(*) from calendar_read_due(false, 1)), 1::bigint, 'read_due honours p_limit');
rollback;

create temp table runs (id uuid);
insert into runs select (calendar_begin() ->> 'run_id')::uuid;
select test.ok((select id from runs) is not null, 'begin: the first run gets the lease');
select test.is(calendar_begin(), '{"go": false, "stop": "busy", "run_id": null}'::jsonb, 'begin: a second one at the same time is busy');
select calendar_signed_in((select id from runs), 'service_account', 'home-hub-sync@example.com', 'a1b2c3d4e5f6');
select calendar_signed_in(gen_random_uuid(), 'oauth', null, null);
select test.is((select concat_ws(' ', auth, account, key_id) from calendar_sync), 'service_account home-hub-sync@example.com a1b2c3d4e5f6',
               'signed_in records how this run signed in (and only this run)');
select test.throws($$select calendar_signed_in((select id from runs), 'password', null, null)$$, 'service_account or oauth', 'signed_in: only the two ways');
select calendar_finish(gen_random_uuid(), '{"inserted": 1}');
select test.ok((select running_since is not null from calendar_sync), 'finish: a stale run id doesn''t release the lease');
:as_owner
set hub.now = '2026-10-27 09:11 America/New_York';
:as_service
select test.is(calendar_begin() ->> 'go', 'true', 'begin: a lease older than 10 minutes is dead, and taken over');
insert into runs select (calendar_begin() ->> 'run_id')::uuid;
delete from runs;
update calendar_sync set running_since = null;
insert into runs select (calendar_begin() ->> 'run_id')::uuid;
select calendar_finish((select id from runs), '{"read": 7, "inserted": 2, "updated": 0, "deleted": 0, "failed": 1}', 'time', null);
select test.is((select concat_ws(' ', running_since is null, last_run_at = private.now(), last_ok_at = private.now(), last_stop, coalesce(last_error, '-'),
                                 last_result ->> 'inserted', last_result ->> 'stop', window_from, window_to)
                from calendar_sync),
               't t t time - 2 time 2026-10-26 2026-12-26',
               'finish: releases the lease and records the run; a run stopped for time (or with a failed item) is still ok');
create temp table ok_at as select last_ok_at from calendar_sync;
:as_owner
set hub.now = '2026-10-27 09:20 America/New_York';
:as_service
delete from runs;
insert into runs select (calendar_begin() ->> 'run_id')::uuid;
select calendar_finish((select id from runs), '{}', 'error', 'The database didn''t answer.');
select test.is((select concat_ws(' ', last_ok_at = (select last_ok_at from ok_at), last_stop, last_error, auth) from calendar_sync),
               't error The database didn''t answer. service_account', 'finish: a run-level stop leaves last_ok_at, with its fixed message');
delete from runs;
insert into runs select (calendar_begin() ->> 'run_id')::uuid;
select calendar_finish((select id from runs), '{}', 'auth', 'Google refused the key.');
select test.is((select concat_ws(' ', coalesce(auth, '-'), coalesce(account, '-'), coalesce(key_id, '-'), last_stop) from calendar_sync), '- - - auth',
               'finish: auth (and config, not_set_up) forgets how the hub signed in');

-- Google's "slow down": 10 minutes, doubling, at most an hour; a run that wrote ends it.
create function pg_temp.slow_down() returns text language plpgsql as $$
declare
  r uuid;
begin
  update public.calendar_sync set paused_until = null, running_since = null;
  r := (public.calendar_begin() ->> 'run_id')::uuid;
  perform public.calendar_finish(r, '{}', 'slow_down', 'Google said slow down');
  return (select pause_step || ' ' || (paused_until - private.now()) from public.calendar_sync);
end;
$$;
select test.is(pg_temp.slow_down() || ', ' || pg_temp.slow_down() || ', ' || pg_temp.slow_down() || ', ' || pg_temp.slow_down() || ', ' || pg_temp.slow_down(),
               '1 00:10:00, 2 00:20:00, 3 00:40:00, 4 01:00:00, 5 01:00:00', 'slow_down pauses 10 minutes, doubling, at most an hour');
select test.is(calendar_begin(), '{"go": false, "stop": "paused", "run_id": null}'::jsonb, 'begin: paused while the pause lasts');
update calendar_sync set paused_until = null, running_since = null;
delete from runs;
insert into runs select (calendar_begin() ->> 'run_id')::uuid;
select calendar_finish((select id from runs), '{"inserted": 0, "updated": 1, "deleted": 0}', null, null);
select test.is((select pause_step from calendar_sync), 0, 'a run that wrote something ends the doubling');
:as_owner
update calendar_sync set auth = 'service_account', account = 'home-hub-sync@example.com', key_id = 'k0000000a1b2c3', last_stop = null, last_error = null;
set hub.now = '2026-10-27 09:00 America/New_York';

-- ---------------------------------------------------------------------
-- calendar_store_events: storing a read (§5.2)
-- ---------------------------------------------------------------------
:as_service
-- What hub-jobs sends for the hub's own events on Jordan's calendar, as Google has them now.
create temp table jordan_seen as
  select jsonb_agg(jsonb_build_object(
           'id', event_id, 'status', 'confirmed', 'title', title,
           'start', jsonb_build_object('date', to_char(day, 'YYYY-MM-DD')), 'end', jsonb_build_object('date', to_char(end_day + 1, 'YYYY-MM-DD')),
           'updated', '2026-10-27T13:00:00Z', 'hash', google_hash, 'organizer_self', true,
           'props', jsonb_build_object('homehub', '1', 'homehub_base', base_id, 'homehub_kind', item_kind))
         order by day, base_id) as s
  from calendar_links where google_calendar = 'hub-jordan@group.calendar.google.com';
-- Events typed into Google.
create temp table typed (e jsonb);
insert into typed values
  ('{"id": "soccer1", "status": "confirmed", "title": "Soccer", "location": "Field 3", "start": {"dateTime": "2026-10-28T21:00:00Z"},
     "end": {"dateTime": "2026-10-28T22:00:00Z"}, "organizer_self": true, "recurring": true, "updated": "2026-10-20T10:00:00Z", "hash": "h1"}'),
  ('{"id": "zero1", "status": "confirmed", "title": "Midnight check", "start": {"dateTime": "2026-10-29T04:00:00Z"},
     "end": {"dateTime": "2026-10-29T04:00:00Z"}, "organizer_self": true}'),
  ('{"id": "allday1", "status": "confirmed", "title": "Book fair", "start": {"date": "2026-10-30"}, "end": {"date": "2026-10-30"}, "organizer_self": true}'),
  ('{"id": "noend1", "status": "confirmed", "title": "Call grandma", "start": {"dateTime": "2026-10-31T16:00:00Z"}, "organizer_self": true}'),
  ('{"id": "bad1", "status": "confirmed", "title": "Broken", "start": {"dateTime": "soon"}, "organizer_self": true}'),
  ('{"id": "secret1", "status": "confirmed", "title": "Therapy", "location": "Clinic", "visibility": "private",
     "start": {"dateTime": "2026-10-30T19:00:00Z"}, "end": {"dateTime": "2026-10-30T20:00:00Z"}, "organizer_self": true}'),
  ('{"id": "hostile1", "status": "confirmed", "title": "<img src=x onerror=alert(1)>\nLine two\u202eevil\u200b!", "location": "A\u2028B\u2066C",
     "start": {"date": "2026-11-01"}, "end": {"date": "2026-11-02"}, "organizer_self": true}'),
  ('{"id": "invite1", "status": "confirmed", "title": "Webinar", "start": {"date": "2026-11-02"}, "end": {"date": "2026-11-03"}, "response": "needsAction"}'),
  ('{"id": "invite2", "status": "tentative", "title": "Team lunch", "start": {"date": "2026-11-02"}, "end": {"date": "2026-11-03"}, "response": "accepted"}'),
  ('{"id": "gone1", "status": "cancelled", "title": "Old plan", "start": {"date": "2026-11-02"}, "end": {"date": "2026-11-03"}, "organizer_self": true}'),
  ('{"id": "copy1", "status": "confirmed", "title": "Piano (Taylor)", "start": {"date": "2026-11-04"}, "end": {"date": "2026-11-05"}, "organizer_self": true,
     "props": {"homehub": "1", "homehub_base": "hh00000000000000000000000000000000"}}');
insert into typed
select jsonb_build_object('id', event_id, 'status', 'confirmed', 'title', 'Sneaky', 'start', jsonb_build_object('date', to_char(day, 'YYYY-MM-DD')),
                          'end', jsonb_build_object('date', to_char(day + 1, 'YYYY-MM-DD')), 'organizer_self', true)
from calendar_links where google_calendar = 'hub-jordan@group.calendar.google.com' and title = 'Swim (Alex)' and day = '2026-10-31';
create function pg_temp.store(p_cal text, p_events jsonb, p_seen jsonb, p_complete boolean default true,
                              p_name text default null, p_access text default null) returns jsonb language sql as $$
  select public.calendar_store_events(c.id, c.google_id, '2026-10-26', '2026-12-26', coalesce(p_name, 'Hub – ' || c.label),
                                      coalesce(p_access, case when c.writes then 'writer' else 'reader' end), p_complete, p_events, p_seen)
  from public.calendars c where c.label = p_cal
$$;

select test.is(pg_temp.store('Jordan', (select jsonb_agg(e) from typed), (select s from jordan_seen)),
               jsonb_build_object('kept', 8, 'skipped', 4, 'seen', (select jsonb_array_length(s) from jordan_seen), 'repaired', 0, 'adopted', 0),
               'store: 8 kept; skipped: unreadable, an invitation nobody accepted, cancelled, an id the hub linked; the hub''s own seen');
select test.is((select string_agg(concat_ws(' ', event_id, start_day, end_day, all_day, coalesce(to_char(start_at at time zone 'UTC', 'HH24:MI'), '-'),
                                            coalesce(to_char(end_at at time zone 'UTC', 'HH24:MI'), '-'), coalesce(location, '-'), private, repeating), ' | ' order by event_id)
                from google_events where event_id in ('soccer1', 'zero1', 'allday1', 'noend1', 'secret1')),
               'allday1 2026-10-30 2026-10-30 t - - - f f | noend1 2026-10-31 2026-10-31 f 16:00 16:00 - f f | '
               'secret1 2026-10-30 2026-10-30 f 19:00 20:00 - t f | soccer1 2026-10-28 2026-10-28 f 21:00 22:00 Field 3 f t | '
               'zero1 2026-10-29 2026-10-29 f 04:00 04:00 - f f',
               'store: a zero-length event at midnight, an all-day one ending as it starts and one with no end are kept; the household''s days');
select test.is((select title from google_events where event_id = 'secret1'), '', 'store: a private Google event is kept without its title or place');
select test.is((select title || ' | ' || location from google_events where event_id = 'hostile1'), '<img src=x onerror=alert(1)> Line twoevil! | A BC',
               'store: newlines, line separators, bidi controls and zero-width characters are cleaned (markup stays text: the pages escape it)');
select test.ok((select bool_and(read_at = private.now() and google_calendar = 'hub-jordan@group.calendar.google.com') from google_events), 'store: each row records the read and the Google ID');
select test.is((select string_agg(event_id, ', ' order by event_id) from google_events where event_id in ('invite2', 'copy1', 'invite1', 'gone1', 'bad1')),
               'copy1, invite2', 'store: an accepted invitation, and a duplicated hub event (another id) are kept as ordinary Google events');
select test.is((select concat_ws(' ', status, coalesce(status_detail, '-'), google_name, access_role, read_at = private.now(), checked_at = private.now()) from calendars where label = 'Jordan'),
               'ok - Hub – Jordan writer t t', 'store: the calendar is ok, with its Google name, the access role and the times');

select test.is(pg_temp.store('Jordan', (select jsonb_agg(e) from typed where e ->> 'id' = 'soccer1'), (select s from jordan_seen)) ->> 'kept', '1',
               'store: a complete read replaces the calendar''s rows ...');
select test.is((select string_agg(event_id, ', ') from google_events where calendar_id = pg_temp.cal('Jordan')), 'soccer1', '... all of them');
select test.is(calendar_store_events(pg_temp.cal('Jordan'), 'hub-elsewhere@group.calendar.google.com', '2026-10-26', '2026-12-26', 'Hub – Jordan', 'writer', true, '[]', '[]'),
               '{"kept": 0, "skipped": 0, "seen": 0, "repaired": 0, "adopted": 0}'::jsonb, 'store: nothing happens if the calendar was re-pointed during the run');
select test.is(calendar_store_events(gen_random_uuid(), 'hub-jordan@group.calendar.google.com', '2026-10-26', '2026-12-26', 'Hub – Jordan', 'writer', true, '[]', '[]') ->> 'kept',
               '0', '... or is gone');
select test.is((select count(*) from google_events where calendar_id = pg_temp.cal('Jordan')), 1::bigint, '... and the rows are as they were');

-- A cut-off read (p_complete false) replaces only the days it covered.
select pg_temp.store('Jordan', (select jsonb_agg(e) from typed where e ->> 'id' in ('soccer1', 'allday1', 'noend1')), (select s from jordan_seen));
create temp table jordan_read as select read_at from calendars where label = 'Jordan';
:as_owner
set hub.now = '2026-10-27 09:02 America/New_York';
:as_service
select test.is(pg_temp.store('Jordan', (select jsonb_agg(e) from typed where e ->> 'id' = 'zero1'), (select s from jordan_seen), false) ->> 'kept', '1',
               'store: a cut-off read keeps what it read ...');
select test.is((select string_agg(event_id, ', ' order by event_id) from google_events where calendar_id = pg_temp.cal('Jordan')), 'allday1, noend1, zero1',
               '... replaces the days it covered (up to its last day) and keeps the rest');
select test.is((select read_at = (select read_at from jordan_read) and checked_at = private.now() from calendars where label = 'Jordan'), true,
               '... and isn''t a complete read (read_at stays)');

-- Changes made in Google to the hub's events are put back.
create temp table seen2 as
  select jsonb_agg(case when x ->> 'title' = 'Piano (Taylor)' and x -> 'start' ->> 'date' = '2026-11-03'
                        then x || '{"updated": "2026-10-27T14:00:00Z", "hash": "changed"}'
                        when x ->> 'title' = 'Piano (Taylor)' and x -> 'start' ->> 'date' = '2026-11-17'
                        then x || '{"updated": "2026-10-27T14:00:00Z"}'
                        else x end order by x ->> 'id') filter (where x ->> 'title' not like 'Dentist%') as s
  from jsonb_array_elements((select s from jordan_seen)) x;
select test.is(pg_temp.store('Jordan', '[]', (select s from seen2), false) ->> 'repaired', '0', 'a cut-off read puts nothing back');
select test.is(pg_temp.store('Jordan', '[]', (select s from seen2)) ->> 'repaired', '2', 'a complete read: one event edited in Google, one deleted');
select test.is((select string_agg(concat_ws(' ', title, to_char(day, 'MM-DD'), repair_kind, repairs, coalesce(hash, 'null'), status), ', ' order by day)
                from calendar_links where repaired_at = private.now()),
               'Piano (Taylor) 11-03 edited 1 null ok, Dentist checkup (Morgan) 11-04 deleted 1 null ok',
               '... edited by its content hash (not by updated alone, as a change of reminders); the hash forgotten, the repair recorded');
select test.is(pg_temp.plan(), 'update Piano (Taylor) 11-03 | update Dentist checkup (Morgan) 11-04', '... so the next plan puts them back');
select pg_temp.store('Jordan', '[]', (select s from seen2));
select pg_temp.store('Jordan', '[]', (select s from seen2));
select test.is((select string_agg(concat_ws(' ', repairs, status), ', ') from calendar_links where repaired_at = private.now()), '3 ok, 3 ok',
               'three repairs in 24 hours: still ok');
select pg_temp.store('Jordan', '[]', (select s from seen2));
select test.is((select string_agg(concat_ws(' ', repairs, status, error, next_try_at - private.now()), ', ') from calendar_links where repaired_at = private.now()),
               '4 error Google keeps changing this event 1 day, 4 error Google keeps changing this event 1 day',
               'the fourth repair of one event within 24 hours: an error, tried again in a day');
select test.is(pg_temp.plan(), null, '... meanwhile it is left alone');
:as_owner
update events set title = 'Dentist visit' where title = 'Dentist checkup';
:as_service
select test.is(pg_temp.plan(), 'update Dentist visit (Morgan) 11-04', '... unless the item changes in the hub');
select pg_temp.sync();
:as_owner
update calendar_links set repairs = 3, repaired_at = private.now() - interval '25 hours'
where google_calendar = 'hub-jordan@group.calendar.google.com' and title = 'Swim (Alex)' and day = '2026-10-31';
:as_service
select pg_temp.store('Jordan', '[]', (select jsonb_agg(x) filter (where not (x ->> 'title' = 'Swim (Alex)' and x -> 'start' ->> 'date' = '2026-10-31'))
                                     from jsonb_array_elements((select s from jordan_seen)) x));
select test.is((select concat_ws(' ', repair_kind, repairs, status) from calendar_links
                where google_calendar = 'hub-jordan@group.calendar.google.com' and title = 'Swim (Alex)' and day = '2026-10-31'),
               'deleted 1 ok', 'repairs count again from 1 after 24 hours');
select pg_temp.sync();

-- Orphans: hub events without a link (a run died before calendar_record) are adopted.
create temp table orphans as select jsonb_build_array(
  jsonb_build_object('id', 'hh' || md5('orphan-1'), 'status', 'confirmed', 'title', 'Picture day', 'start', '{"date": "2026-11-06"}'::jsonb,
                     'end', '{"date": "2026-11-07"}'::jsonb, 'organizer_self', true, 'updated', '2026-10-27T12:00:00Z', 'hash', 'o1',
                     'props', jsonb_build_object('homehub', '1', 'homehub_base', 'hh' || md5('orphan-base'), 'homehub_kind', 'event',
                                                 'homehub_item', test.event('Carpool')::text, 'homehub_occurrence', '2026-11-06')),
  jsonb_build_object('id', 'hh' || md5('orphan-2'), 'status', 'confirmed', 'title', 'No base', 'start', '{"date": "2026-11-08"}'::jsonb,
                     'end', '{"date": "2026-11-09"}'::jsonb, 'organizer_self', true, 'props', '{"homehub": "1"}'::jsonb),
  jsonb_build_object('id', 'hh' || md5('orphan-3'), 'status', 'confirmed', 'title', 'Bad item', 'start', '{"date": "2026-11-08"}'::jsonb,
                     'end', '{"date": "2026-11-09"}'::jsonb, 'organizer_self', true, 'props', '{"homehub": "1", "homehub_item": "not-a-uuid"}'::jsonb),
  jsonb_build_object('id', 'hh' || md5('orphan-4'), 'status', 'confirmed', 'title', 'Bad date', 'start', '{"date": "2026-13-45"}'::jsonb,
                     'organizer_self', true, 'props', '{"homehub": "1"}'::jsonb),
  jsonb_build_object('id', 'hh' || md5('orphan-5'), 'status', 'confirmed', 'title', 'Bad day', 'start', '{"date": "2026-11-08"}'::jsonb,
                     'organizer_self', true, 'props', '{"homehub": "1", "homehub_occurrence": "tomorrow"}'::jsonb),
  jsonb_build_object('id', 'hh' || md5('orphan-6'), 'status', 'confirmed', 'title', 'Bad kind', 'start', '{"date": "2026-11-08"}'::jsonb,
                     'organizer_self', true, 'props', '{"homehub": "1", "homehub_kind": "meeting"}'::jsonb)) as o;
select test.is(pg_temp.store('Jordan', '[]', (select s from jordan_seen) || (select o from orphans), false) ->> 'adopted', '0', 'a cut-off read adopts nothing');
select test.is(pg_temp.store('Jordan', '[]', (select s from jordan_seen) || (select o from orphans)) ->> 'adopted', '2',
               'a complete read adopts hub events without a link; a bad uuid, date or kind skips only that event');
select test.is((select string_agg(concat_ws(' ', title, base_id = 'hh' || md5(case when title = 'Picture day' then 'orphan-base' else 'orphan-2' end),
                                            event_id ~ '^hh', coalesce(item_kind, '-'), coalesce(item_id = test.event('Carpool'), false), coalesce(occurrence::text, '-'),
                                            to_char(day, 'MM-DD'), to_char(end_day, 'MM-DD'), coalesce(hash, 'null'), synced_at = private.now(), status),
                                  ', ' order by title)
                from calendar_links where event_id in ('hh' || md5('orphan-1'), 'hh' || md5('orphan-2'))),
               'No base t t - f - 11-08 11-08 null t pending, Picture day t t event t 2026-11-06 11-06 11-06 null t pending',
               '... with base_id from homehub_base (or its own id), the item from its properties, its days, hash null');
select test.is(pg_temp.plan(), 'delete Picture day 11-06 | delete No base 11-08',
               '... so the next plan updates them if wanted, and deletes them if not (here: not)');
select test.is((select count(*) from google_events where event_id like 'hh%'), 0::bigint, 'the hub''s own events are never cached');
select test.is(pg_temp.store('Family account', '[]', (select o from orphans)), '{"kept": 0, "skipped": 0, "seen": 6, "repaired": 0, "adopted": 0}'::jsonb,
               'a calendar the hub only reads: hub events are kept out of the cache, and never adopted');
select pg_temp.sync();

-- The calendar's status, from its Google name and the access role.
create temp table stored (x jsonb);
insert into stored select pg_temp.store('Jordan', (select jsonb_agg(e) from typed where e ->> 'id' = 'soccer1'), (select s from jordan_seen), true, 'Jordan''s calendar');
select test.is((select concat_ws(' | ', (select x ->> 'kept' from stored), status, status_detail) from calendars where label = 'Jordan'),
               '1 | error | This calendar isn''t named ''Hub …''. The hub writes only to calendars whose name starts with Hub. If it is the right one, rename it in Google.',
               'a calendar the hub writes, not named "Hub…": error (its events are still read)');
select pg_temp.store('Jordan', '[]', (select s from jordan_seen), true, 'hub jordan');
select test.is((select status from calendars where label = 'Jordan'), 'ok', '... "Hub" in any case is fine');
delete from stored;
insert into stored select pg_temp.store('Jordan', (select jsonb_agg(e) from typed where e ->> 'id' = 'soccer1'), (select s from jordan_seen), true, null, 'reader');
select test.is((select concat_ws(' | ', (select x ->> 'kept' from stored), status, status_detail,
                                 (select count(*) from google_events where calendar_id = pg_temp.cal('Jordan')))
                from calendars where label = 'Jordan'),
               '0 | no_access | Share it with home-hub-sync@example.com and choose Make changes and see event details. | 0',
               'shared read only: no_access, saying what to share, and nothing cached');
select pg_temp.store('Jordan', '[]', (select s from jordan_seen), true, null, 'owner');
select test.is((select status || ' | ' || status_detail from calendars where label = 'Jordan'),
               'error | Share it with Make changes and see event details, not Make changes and manage sharing.', 'the service account as owner: refused');
select pg_temp.store('Jordan', '[]', (select s from jordan_seen));
select test.is((select status from calendars where label = 'Jordan'), 'ok', '... a read that sees the right role clears it');
select pg_temp.store('Family account', (select jsonb_agg(e) from typed where e ->> 'id' = 'soccer1'), '[]', true, 'Family', 'freeBusyReader');
select test.is((select status from calendars where label = 'Family account'), 'no_access', 'a calendar the hub only reads: free/busy only is no_access');
select pg_temp.store('Family account', '[]', '[]', true, 'Family', 'reader');
select test.is((select status from calendars where label = 'Family account'), 'ok', '... reader or better is ok, whatever its name');
-- Google's "Make changes (see private events as free/busy)" (accessRole writerWithoutPrivateAccess).
select pg_temp.store('Family account', (select jsonb_agg(e) from typed where e ->> 'id' = 'soccer1'), '[]', true, 'Family', 'writerWithoutPrivateAccess');
select test.is((select concat_ws(' | ', status, coalesce(status_detail, '-'), access_role,
                                 (select count(*) from google_events where calendar_id = pg_temp.cal('Family account')))
                from calendars where label = 'Family account'),
               'ok | - | writerWithoutPrivateAccess | 1',
               'a calendar the hub only reads, shared with "Make changes (see private events as free/busy)": it can read it, so ok, and its events are kept');
select pg_temp.store('Family account', '[]', '[]', true, 'Family', 'reader');
select pg_temp.store('Jordan', '[]', (select s from jordan_seen), true, null, 'writerWithoutPrivateAccess');
select test.is((select status || ' | ' || status_detail from calendars where label = 'Jordan'),
               'no_access | Shared with ''Make changes (see private events as free/busy)'': Home Hub can''t change its private items there. '
               'Share it with home-hub-sync@example.com and choose Make changes and see event details.',
               'a calendar the hub writes, shared that way: refused, saying which option to choose instead');
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000) where google_calendar = 'hub-jordan@group.calendar.google.com' and op <> 'delete'),
               0::bigint, '... and nothing is written to it');
select calendar_mark(pg_temp.cal('Jordan'), 'hub-jordan@group.calendar.google.com', 'ok', null, 'Hub – Jordan', 'writerWithoutPrivateAccess');
select test.is((select status from calendars where label = 'Jordan'), 'no_access', '... Test (calendar_mark) says the same');
select pg_temp.store('Jordan', '[]', (select s from jordan_seen));

-- calendar_mark: what a failed read, a write's 403 or Test found.
select calendar_mark(pg_temp.cal('Jordan'), 'hub-jordan@group.calendar.google.com', 'ok', null, 'Jordan', 'writer');
select test.is((select status from calendars where label = 'Jordan'), 'error', 'mark: "ok" is checked against the name rule');
select calendar_mark(pg_temp.cal('Jordan'), 'hub-jordan@group.calendar.google.com', 'ok', null, 'Hub – Jordan', 'writer');
select test.is((select concat_ws(' ', status, coalesce(status_detail, '-'), google_name) from calendars where label = 'Jordan'), 'ok - Hub – Jordan', '... and the role');
select pg_temp.store('Jordan', (select jsonb_agg(e) from typed where e ->> 'id' = 'soccer1'), (select s from jordan_seen));
select calendar_mark(pg_temp.cal('Jordan'), 'hub-elsewhere@group.calendar.google.com', 'no_access', 'Not shared');
select test.is((select status from calendars where label = 'Jordan'), 'ok', 'mark: only while the Google ID is the one it checked');
select calendar_mark(pg_temp.cal('Jordan'), 'hub-jordan@group.calendar.google.com', 'no_access', E'Home Hub can''t change this calendar.\nShare it.');
select test.is((select concat_ws(' | ', status, status_detail, (select count(*) from google_events where calendar_id = pg_temp.cal('Jordan'))) from calendars where label = 'Jordan'),
               'no_access | Home Hub can''t change this calendar. Share it. | 0', 'mark: no_access deletes the cached events; the detail is one line');
select test.throws($$select calendar_mark(pg_temp.cal('Jordan'), 'hub-jordan@group.calendar.google.com', 'fine')$$, 'status must be', 'mark: a known status only');
select calendar_mark(pg_temp.cal('Jordan'), 'hub-jordan@group.calendar.google.com', 'error',
                     'Google said: Invalid Credentials ya29.a0AfB_byC-example_token and 1//0gExample-refresh and eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2ln ' || repeat('x', 400));
select test.is((select left(status_detail, 63) || ' ' || length(status_detail) from calendars where label = 'Jordan'),
               'Google said: Invalid Credentials … and … and … xxxxxxxxxxxxxxxx 300',
               'stored messages drop anything shaped like a token, and are cut to 300 characters');
select pg_temp.store('Jordan', '[]', (select s from jordan_seen));

-- A new Google ID hides the old one's events at once; the next run deletes them.
begin;
select pg_temp.store('Jordan', (select jsonb_agg(e) from typed where e ->> 'id' = 'soccer1'), (select s from jordan_seen));
:as_admin
update calendars set google_id = 'hub-jordan-2@group.calendar.google.com' where label = 'Jordan';
select test.is((select count(*) from google_items('2026-10-26', '2026-11-25') where title = 'Soccer'), 0::bigint,
               'a new Google ID: the old calendar''s events stop showing at once');
:as_service
select test.is((select count(*) from google_events where calendar_id = pg_temp.cal('Jordan')), 1::bigint, '... they are still stored');
select calendar_finish(gen_random_uuid(), '{}');
select test.is((select count(*) from google_events where calendar_id = pg_temp.cal('Jordan')), 0::bigint, '... until calendar_finish deletes them');
rollback;
begin;
select pg_temp.store('Jordan', (select jsonb_agg(e) from typed where e ->> 'id' = 'soccer1'), (select s from jordan_seen));
:as_owner
set hub.now = '2026-10-28 09:03 America/New_York';
:as_service
select calendar_finish(gen_random_uuid(), '{}');
select test.is((select count(*) from google_events where calendar_id = pg_temp.cal('Jordan')), 0::bigint,
               'calendar_finish deletes the events of a calendar not read completely for 24 hours');
rollback;

-- ---------------------------------------------------------------------
-- Google events on the pages, My day, day_text and the email (§5.3, §5.4)
-- ---------------------------------------------------------------------
-- (The repairs made above are cleared first.)
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';
update calendar_links set repaired_at = null, repair_kind = null, repairs = 0, status = 'ok', error = null, next_try_at = null, failing_since = null;
:as_admin
insert into calendars (google_id, kind, label, writes, for_kids) values ('school@example.com', 'family', 'School', false, true);
:as_service
create function pg_temp.ev(p_id text, p_title text, p_start jsonb, p_end jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', 'confirmed', 'title', p_title, 'start', p_start, 'end', p_end, 'organizer_self', true,
                            'updated', '2026-10-27T12:00:00Z') || p_extra
$$;
-- The hub's own events on a calendar, as a read finds them (unchanged).
create function pg_temp.seen(p_cal text) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.event_id, 'status', 'confirmed', 'title', l.title, 'start', jsonb_build_object('date', to_char(l.day, 'YYYY-MM-DD')),
           'updated', to_char(l.google_updated at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'hash', l.google_hash, 'organizer_self', true,
           'props', jsonb_build_object('homehub', '1', 'homehub_base', l.base_id))), '[]')
  from public.calendar_links l join public.calendars c on c.google_id = l.google_calendar where c.label = p_cal
$$;
select pg_temp.store('Jordan', jsonb_build_array(
  pg_temp.ev('soccer1', 'Soccer', '{"dateTime": "2026-10-28T21:00:00Z"}', '{"dateTime": "2026-10-28T22:00:00Z"}', '{"location": "Field 3", "recurring": true}'),
  pg_temp.ev('bus1', 'Bus trip', '{"dateTime": "2026-10-29T12:00:00Z"}', '{"dateTime": "2026-10-29T13:00:00Z"}'),
  pg_temp.ev('secret1', 'Therapy', '{"dateTime": "2026-10-29T19:00:00Z"}', '{"dateTime": "2026-10-29T20:00:00Z"}', '{"visibility": "private", "location": "Clinic"}')),
  pg_temp.seen('Jordan'));
select pg_temp.store('Taylor', jsonb_build_array(pg_temp.ev('dentista1', 'Dentista', '{"date": "2026-10-28"}', '{"date": "2026-10-29"}')), pg_temp.seen('Taylor'));
select pg_temp.store('Family', jsonb_build_array(pg_temp.ev('picnic1', 'Picnic', '{"date": "2026-10-28"}', '{"date": "2026-10-29"}')), pg_temp.seen('Family'));
select pg_temp.store('Family account', jsonb_build_array(pg_temp.ev('club1', 'Book club', '{"dateTime": "2026-10-29T00:00:00Z"}', '{"dateTime": "2026-10-29T01:30:00Z"}')), '[]',
                     true, 'Family');
select pg_temp.store('Dogs', jsonb_build_array(pg_temp.ev('vet1', 'Vet', '{"dateTime": "2026-10-28T14:00:00Z"}', '{"dateTime": "2026-10-28T15:00:00Z"}')), pg_temp.seen('Dogs'));
select pg_temp.store('House', jsonb_build_array(pg_temp.ev('roof1', 'Roofer', '{"date": "2026-10-30"}', '{"date": "2026-10-31"}')), pg_temp.seen('House'));
select test.is((select count(*) from calendar_links where repaired_at is not null), 0::bigint, 'reads that find the hub''s events unchanged repair nothing');
select pg_temp.store('School', jsonb_build_array(pg_temp.ev('hol1', 'School holiday', '{"date": "2026-10-28"}', '{"date": "2026-10-29"}')), '[]',
                     true, 'Example School');
select test.is((select count(*) from google_events), 9::bigint, 'nine Google events are cached');

-- google_items: Google events as agenda rows.
:as_adult
select test.is((select to_jsonb(g) - 'start_at' - 'end_at' from google_items('2026-10-28', '2026-10-28') g where title = 'Soccer'),
               jsonb_build_object('kind', 'google', 'item_id', md5(pg_temp.cal('Jordan')::text || '/soccer1')::uuid, 'occurrence', '2026-10-28',
                                  'title', 'Soccer', 'day', '2026-10-28', 'end_day', '2026-10-28', 'all_day', false,
                                  'local_start', '17:00:00', 'local_end', '18:00:00', 'responsible_id', test.person('Jordan'),
                                  'participant_ids', '[]'::jsonb, 'status', 'open', 'category', null, 'project_id', null, 'project_name', null,
                                  'contractor_id', null, 'contractor_name', null, 'contractor_phone', null, 'location', 'Field 3',
                                  'notes', 'From Google Calendar · Hub – Jordan', 'private', false, 'repeating', true, 'changed', false,
                                  'lead_days', null, 'milestone', false, 'day_note', null),
               'google_items: kind google, a stable item_id, the person whose calendar it is, local times, the source in notes');
select test.is((select string_agg(concat_ws(' ', nullif(title, ''), to_char(local_start, 'HH24:MI'), coalesce(category, '-'),
                                            coalesce((select name from people where id = responsible_id), '-'), private, notes), ' | ')
                from google_items('2026-10-28', '2026-10-29')),
               'Vet 10:00 pets Taylor f From Google Calendar · Hub – Dogs | Soccer 17:00 - Jordan f From Google Calendar · Hub – Jordan | '
               'Book club 20:00 family - f From Google Calendar · Family | Dentista - Taylor f From Google Calendar · Hub – Taylor | '
               'Picnic family - f From Google Calendar · Hub – Family | School holiday family - f From Google Calendar · Example School | '
               'Bus trip 08:00 - Jordan f From Google Calendar · Hub – Jordan | 15:00 - Jordan t From Google Calendar · Hub – Jordan',
               'google_items: Pets is its owner''s, Family has nobody; days and times in the household''s zone (8pm on the 28th is the 29th in UTC)');
select test.is((select title from google_items('2026-10-29', '2026-10-29') where private), '', 'google_items: a private one has no title (the pages show "Private item")');
select test.throws($$select * from google_items('2026-10-01', '2026-12-31')$$, '1 to 62 days', 'google_items: at most 62 days, like agenda');
:as_stranger
select test.is((select count(*) from google_items('2026-10-26', '2026-11-25')), 0::bigint, 'google_items: someone not on the family list sees none');

-- google_for: whose day each one reaches.
:as_admin
create function pg_temp.gf(p_name text, p_grown_up boolean) returns text language sql as $$
  select string_agg(title, ', ') from private.google_for(test.person(p_name), '2026-10-28', '2026-10-28', p_grown_up)
$$;
select test.is(pg_temp.gf('Jordan', false), 'Soccer, Picnic, School holiday', 'google_for, a kid: his own calendar, Hub – Family, and read-only calendars with Show to kids');
select test.is(pg_temp.gf('Taylor', false), 'Vet, Dentista', 'google_for, the helper: her own calendar (and Pets, which she owns); never a Family one');
select test.is(pg_temp.gf('Alex', true), 'Book club, Picnic, School holiday', 'google_for, a parent''s email: every Family calendar');
select test.is(pg_temp.gf('Alex', false), null, '... his My day: none of them');
select test.is(pg_temp.gf('Sam', true), 'Book club, Picnic, School holiday', 'google_for, an adult''s email: the Family calendars too');
select test.is((select string_agg(title, ', ') from private.google_for(test.person('Sam'), '2026-10-30', '2026-10-30', false)), 'Roofer',
               'google_for: House is its owner''s');

-- person_items, day_text and My day.
select test.is(day_text(test.person('Jordan'), '2026-10-28'),
               E'Jordan · Wed Oct 28\n5:00pm Soccer\nAll day: Picnic\nAll day: School holiday\nLate:\n☐ Feed fish (Oct 20)\n☐ Trash (Oct 26)',
               'day_text: Google events in the day, in time order; an all-day one reads "All day:"');
select test.is(day_text(test.person('Taylor'), '2026-10-28'),
               E'Taylor · mié 28 oct\n10:00 Vet\nTodo el día: Dentista\nAtrasado:\n☐ Asunto privado (24 oct)\n☐ Water plants (25 oct)',
               'day_text: the helper''s own Google events, in Spanish');
select test.is(day_text(test.person('Jordan'), '2026-10-29') like E'%\n3:00pm Private item\n%', true, 'day_text: a private Google event is "Private item"');
select test.is((select private.text_line(g, test.person('Alex'), 'en') from google_items('2026-10-28', '2026-10-28') g where title = 'Soccer'),
               '5:00pm Soccer · Jordan', 'text_line: someone else''s Google event names whose it is');
select test.is((select string_agg(kind || ' ' || title, ', ') from private.person_items(test.person('Jordan'), '2026-10-29')),
               'google Bus trip, event Carpool, google , task Allergy pills', 'person_items: hub items and Google events, in time order');
:as_owner
set hub.now = '2026-10-28 07:00 America/New_York';
:as_anon
select test.is((select jsonb_agg(x - 'item_id') from jsonb_array_elements(get_person_day(test.token('Jordan')) -> 'days' -> 0 -> 'items') x where x ->> 'kind' = 'google'),
               '[{"kind": "google", "occurrence": "2026-10-28", "day": "2026-10-28", "end_day": "2026-10-28", "title": "Soccer", "all_day": false,
                  "start_time": "17:00", "end_time": "18:00", "time_label": "5:00pm", "location": "Field 3", "contractor_name": null,
                  "contractor_phone": null, "note": null, "status": "open", "mine": false},
                 {"kind": "google", "occurrence": "2026-10-28", "day": "2026-10-28", "end_day": "2026-10-28", "title": "Picnic", "all_day": true,
                  "start_time": null, "end_time": null, "time_label": null, "location": null, "contractor_name": null,
                  "contractor_phone": null, "note": null, "status": "open", "mine": false},
                 {"kind": "google", "occurrence": "2026-10-28", "day": "2026-10-28", "end_day": "2026-10-28", "title": "School holiday", "all_day": true,
                  "start_time": null, "end_time": null, "time_label": null, "location": null, "contractor_name": null,
                  "contractor_phone": null, "note": null, "status": "open", "mine": false}]'::jsonb,
               'My day: a kid''s Google events, with no box to tick (mine false)');
select test.is((select x ->> 'title' from jsonb_array_elements(get_person_day(test.token('Jordan')) -> 'days' -> 1 -> 'items') x where x ->> 'kind' = 'google' and x ->> 'time_label' = '3:00pm'),
               'Private item', 'My day: a private Google event reads "Private item"');
select test.is((select string_agg(x ->> 'title', ', ') from jsonb_array_elements(get_person_day(test.token('Taylor')) -> 'days' -> 0 -> 'items') x where x ->> 'kind' = 'google'),
               'Vet, Dentista', 'My day: the helper gets her own calendar''s events (and Pets''), not Family''s');
select test.is(get_person_day(test.token('Alex'))::text like '%Book club%', false, 'My day: a parent''s My day doesn''t get the read-only calendar');
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';

-- The email.
:as_service
create function pg_temp.titles(a jsonb) returns text language sql as $$ select string_agg(x ->> 'title', ', ') from jsonb_array_elements(a) x $$;
select test.is(pg_temp.titles(digest_for(test.person('Jordan'), '2026-10-28') -> 'today'), 'Soccer, Picnic, School holiday',
               'email, a kid: his Google events in Today');
select test.is((select x ->> 'time' || ' ' || (x ->> 'title') from jsonb_array_elements(digest_for(test.person('Jordan'), '2026-10-28') -> 'heads_up') x where x ->> 'kind' = 'google'),
               'Tomorrow 8:00am Bus trip', 'email: a Google event tomorrow before 9am is in the heads-up');
select test.is((select x ->> 'time' from jsonb_array_elements(digest_for(test.person('Jordan'), '2026-10-28') -> 'today') x where x ->> 'title' = 'Picnic'),
               'All day', 'email: an all-day Google event says "All day"');
select test.is(pg_temp.titles(digest_for(test.person('Alex'), '2026-10-28') -> 'today'), 'Pay water bill, Book club, Picnic, Sabbatical, School holiday, Walk dogs',
               'email, a parent: the Family calendars'' events with his own, in time order');
select test.is((select count(*) from jsonb_array_elements(digest_for(test.person('Alex'), '2026-10-28') -> 'nobody') x where x ->> 'kind' = 'google'), 0::bigint,
               'email: never in "Nobody''s on it" (the hub can''t assign a Google event)');
:as_owner
update people set digest_scope = 'everyone' where name = 'Morgan';
:as_service
select test.is(pg_temp.titles(digest_for(test.person('Morgan'), '2026-10-28') -> 'today'),
               'Gym, Pay water bill, Vet, Soccer, Book club, Dentista, Picnic, Sabbatical, School holiday, Walk dogs',
               'email, a parent with everyone''s items: every Google event');
select test.is((select (j ->> 'empty') || ' ' || pg_temp.titles(j -> 'today') from (select digest_for(test.person('Sam'), '2026-10-30') as j) x),
               'false Roofer', 'email: a non-parent with only a Google event that day isn''t empty');
select test.is(digest_for(test.person('Jordan'), '2026-10-29') ->> 'subject', 'Thu Oct 29: 8:00am Bus trip · 8:00am Private item · +2',
               'email: Google events count in the subject (Carpool was made private above)');
select test.is(digest_for(test.person('Morgan'), '2026-10-29') ->> 'subject' like '%Therapy%', false, 'email: a private Google event''s title is never in the subject');
select test.is((select x ->> 'title' from jsonb_array_elements(digest_for(test.person('Morgan'), '2026-10-29') -> 'today') x where x ->> 'kind' = 'google' and x ->> 'time' = '3:00pm'),
               'Private item', '... nor in the email, even a parent''s');
select test.is(digest_for(test.person('Alex'), '2026-10-28')::text like '%From Google Calendar%', false, 'email: never notes');
:as_owner
update people set digest_scope = 'mine' where name = 'Morgan';

-- The parents' Google Calendar lines (§5.6).
:as_service
select test.is(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar', 'null'::jsonb, 'calendar block: nothing to say, null');
begin;
update calendar_sync set last_ok_at = '2026-10-27 06:05 America/New_York';
select test.is(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar',
               '{"warning": "Google Calendar isn''t up to date (last synced Tue 6:05am). See Settings.", "items_failed": null, "put_back": []}'::jsonb,
               'calendar block: the last good run is more than 2 hours old');
select test.is(digest_for(test.person('Jordan'), '2026-10-27') -> 'calendar', 'null'::jsonb, '... for parents only');
update calendar_sync set last_ok_at = null;
select test.is(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar' ->> 'warning',
               'Google Calendar isn''t up to date (it hasn''t synced yet). See Settings.', '... or there never was one');
update calendar_sync set last_ok_at = '2026-10-20 06:05 America/New_York';
select test.is(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar' ->> 'warning',
               'Google Calendar isn''t up to date (last synced Oct 20 6:05am). See Settings.', '... a week ago is named by its date');
update calendar_sync set last_ok_at = private.now();
update calendars set status = 'no_access' where label = 'Taylor';
select test.ok(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar' ->> 'warning' like 'Google Calendar isn''t up to date (last synced Tue 9:00am)%',
               '... or a calendar can''t be reached');
rollback;
begin;
update calendar_links set failing_since = private.now() - interval '23 hours', status = 'error' where title = 'Swim (Alex)' and day = '2026-11-07';
select test.is(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar', 'null'::jsonb, 'calendar block: an item failing for less than 24 hours: nothing yet');
update calendar_links set failing_since = private.now() - interval '25 hours' where title = 'Swim (Alex)' and day = '2026-11-07';
select test.is(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar',
               '{"warning": null, "items_failed": "1 item couldn''t be copied to Google. See Settings.", "put_back": []}'::jsonb,
               '... after 24 hours, a line (and no warning: one bad item doesn''t make Google look out of date)');
update calendar_links set failing_since = private.now() - interval '2 days', status = 'error' where title = 'Swim (Alex)' and day = '2026-11-14';
select test.is(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar' ->> 'items_failed', '2 items couldn''t be copied to Google. See Settings.', '... how many');
rollback;
begin;
update calendar_links set repaired_at = private.now() - interval '1 hour', repair_kind = 'deleted', repairs = 1
where google_calendar = 'hub-jordan@group.calendar.google.com' and title = 'Piano (Taylor)' and day = '2026-11-03';
update calendar_links set repaired_at = private.now() - interval '2 hours', repair_kind = 'edited', repairs = 1
where google_calendar = 'hub-family@group.calendar.google.com' and title = 'School recital';
update calendar_links set repaired_at = private.now() - interval '25 hours', repair_kind = 'edited', repairs = 1
where google_calendar = 'hub-alex@group.calendar.google.com' and title = 'Night flight';
select test.is(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar' -> 'put_back',
               '["Piano (Taylor), Tue Nov 3: deleted in Google and put back. To cancel one day, use Skip this day in Home Hub.",
                 "School recital, Mon Nov 2: changed in Google and put back."]'::jsonb,
               'calendar block: what was put back in the last 24 hours, newest first (the Skip hint for a repeating event)');
rollback;

-- ---------------------------------------------------------------------
-- After review (§3.3, §3.4, §5.2): failed writes that go past, hiding on a calendar in error, put
-- back only what the plan rewrites, the cache's age, the order of deletes, runs that get nowhere,
-- calendars to read given to a person, a calendar switched to read-only
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';
:as_service
select pg_temp.sync();
select test.is(pg_temp.plan(), null, '(everything is in step before these checks)');
create function pg_temp.plan_on(p_cal text) returns text language sql as $$
  select string_agg(op || ' ' || title || ' ' || to_char(day, 'MM-DD'), ' | ' order by n)
  from (select p.*, row_number() over () as n from public.calendar_plan('https://hub.example.com/', 1000) p) x
  where google_calendar = pg_temp.gid(p_cal)
$$;

-- A failed write whose item has gone past is settled when a run ends (Google keeps its copy, as
-- history); a failed delete, or a failed write of an item that is still wanted, is not.
begin;
:as_owner
update projects set task_dates = jsonb_set(jsonb_set(task_dates, '{2,start}', '"2026-10-28"'), '{2,end}', '"2026-10-29"') where name = 'Kitchen';
:as_service
select pg_temp.sync();
:as_owner
update projects set task_dates = jsonb_set(jsonb_set(task_dates, '{2,start}', '"2026-11-20"'), '{2,end}', '"2026-11-21"') where name = 'Kitchen';
update events set location = 'Pool B' where title = 'Swim';
insert into events (title, start_date, responsible_id) values ('Bake sale', '2026-10-30', test.person('Alex'));
delete from events where title = 'Night flight';
:as_service
select calendar_record((select jsonb_agg(to_jsonb(p) || '{"ok": false, "http": 400, "error": "Google said 400 badRequest: Bad Request"}')
                        from calendar_plan('https://hub.example.com/', 1000) p
                        where (p.title like 'Swim%' and p.day = '2026-10-31') or p.title in ('Bake sale', 'Kitchen: Wire', 'Night flight')));
select pg_temp.sync();
select test.is((select string_agg(title || ' ' || status, ', ' order by title) from calendar_links where status = 'error'),
               'Bake sale error, Kitchen: Wire error, Night flight error, Swim (Alex) error, Swim (with Jordan) error',
               '(five writes failed: two updates and an insert of items that are about to go past, a delete, an update of a moved job)');
:as_owner
set hub.now = '2026-11-03 09:00 America/New_York';
:as_service
select test.is(digest_for(test.person('Alex'), '2026-11-03') -> 'calendar' ->> 'items_failed', '5 items couldn''t be copied to Google. See Settings.',
               '(a week on, before the run ends, the email counts all five)');
select calendar_finish(gen_random_uuid(), '{}');
select test.is((select string_agg(concat_ws(' ', title, to_char(day, 'MM-DD'), status, attempts, coalesce(error, '-'), coalesce(next_try_at::text, '-'),
                                            coalesce(failing_since::text, '-'), hash is not null), ', ' order by title)
                from calendar_links where title like 'Swim%' and day = '2026-10-31'),
               'Swim (Alex) 10-31 ok 0 - - - t, Swim (with Jordan) 10-31 ok 0 - - - t',
               'calendar_finish: a failed update whose day has gone past is ok again, without its error or backoff (Google''s copy stays as history)');
select test.is((select count(*) from calendar_links where title = 'Bake sale'), 0::bigint, '... a failed insert whose day has gone past is forgotten');
select test.is((select status || ' ' || tried_hash from calendar_links where title = 'Night flight'), 'error delete',
               '... a failed delete is never settled: it is tried until it works (privacy)');
select test.is((select status from calendar_links where title = 'Kitchen: Wire'), 'error',
               '... nor a failed update of an item still wanted (a job moved ahead): it is tried again');
select test.is(digest_for(test.person('Alex'), '2026-11-03') -> 'calendar' ->> 'items_failed', '2 items couldn''t be copied to Google. See Settings.',
               '... so the parents'' email no longer counts items that went past');
rollback;
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';

-- Hiding what the hub wrote never waits for a calendar in error that the hub can still write to.
begin;
:as_service
select pg_temp.store('Alex', '[]', pg_temp.seen('Alex'), true, 'Alex');
select test.is((select status from calendars where label = 'Alex'), 'error', '(Alex''s calendar renamed "Alex" in Google: error)');
:as_owner
update events set private = true where title = 'Trip';
delete from events where title = 'Night flight';
insert into events (title, start_date, responsible_id) values ('Dog show', '2026-11-05', test.person('Alex'));
update events set title = 'Swim lesson' where title = 'Swim';
:as_service
select test.is(pg_temp.plan_on('Alex'), 'update Private item 11-13 | delete Night flight 11-01',
               'a calendar in error (renamed in Google) that the hub can still write to: an item made private and a deleted one come off; no insert, no other update');
select test.ok(pg_temp.plan_on('Jordan') like '%update Swim lesson (Alex)%', '... other calendars carry on as usual');
select test.is((select max(hiding) from calendar_plan('https://hub.example.com/', 1000)), 2, '... and both count as hiding ("Hiding 2 items in Google…")');
select pg_temp.store('Alex', '[]', pg_temp.seen('Alex'), true, 'Hub – Alex', 'owner');
select test.is((select status from calendars where label = 'Alex') || ' | ' || pg_temp.plan_on('Alex'), 'error | update Private item 11-13 | delete Night flight 11-01',
               '... the same when it is shared with "Make changes and manage sharing" (owner: error)');
select pg_temp.store('Alex', '[]', pg_temp.seen('Alex'), true, 'Alex', 'reader');
select test.is((select status from calendars where label = 'Alex') || ' | ' || coalesce(pg_temp.plan_on('Alex'), 'nothing'), 'error | nothing',
               '... but nothing at all when the hub may only read it');
rollback;

-- A change in Google is recorded as put back only when the plan will write the event again.
begin;
:as_owner
update projects set task_dates = null where name = 'Kitchen';
delete from events where title = 'School recital';
:as_service
create temp table missing_seen as
  select (select jsonb_agg(x) from jsonb_array_elements(pg_temp.seen('Alex')) x where x ->> 'title' <> 'Kitchen: Paint starts') as alex,
         (select jsonb_agg(x) from jsonb_array_elements(pg_temp.seen('Family')) x where x ->> 'title' <> 'School recital') as family;
do $$
begin
  for i in 1 .. 4 loop
    perform set_config('hub.now', (private.now() + interval '15 minutes')::text, false);
    perform pg_temp.store('Alex', '[]', (select alex from missing_seen));
    perform pg_temp.store('Family', '[]', (select family from missing_seen));
  end loop;
end;
$$;
select test.is((select concat_ws(' ', status, repairs, coalesce(repair_kind, '-'), coalesce(error, '-'), hash is not null)
                from calendar_links where title = 'Kitchen: Paint starts'),
               'ok 0 - - t', 'a stale project''s event deleted in Google: not recorded as put back (the plan leaves it alone), even after 4 reads');
select test.is((select concat_ws(' ', status, repairs) from calendar_links where title = 'School recital'), 'ok 0',
               '... nor one deleted in the hub as well (the plan deletes its link)');
select test.is(coalesce(digest_for(test.person('Alex'), '2026-10-27') -> 'calendar' -> 'put_back', '[]'), '[]'::jsonb,
               '... so the parents'' email doesn''t say it was put back');
:as_owner
update calendars set copy_approved_at = null where label = 'Jordan';
:as_service
select test.is(pg_temp.store('Jordan', '[]', (select jsonb_agg(x) from jsonb_array_elements(pg_temp.seen('Jordan')) x where x ->> 'title' not like 'Swim%')) ->> 'repaired',
               '0', 'a calendar not approved (Start copying): nothing is put back, since nothing is written');
rollback;
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';

-- The cache: each row's own read decides when it is too old.
begin;
:as_owner
update calendars set read_at = private.now() - interval '2 days', checked_at = private.now() - interval '2 days' where label = 'Family account';
:as_service
select pg_temp.store('Family account', jsonb_build_array(pg_temp.ev('club2', 'Chess club', '{"date": "2026-10-30"}', '{"date": "2026-10-31"}')), '[]', false, 'Family');
select calendar_finish(gen_random_uuid(), '{}');
select test.is((select count(*) from google_events where event_id = 'club2'), 1::bigint,
               'calendar_finish keeps what a cut-off read stored, even when the calendar''s last complete read is two days old');
select test.ok((select read_at < private.now() - interval '1 day' from calendars where label = 'Family account'), '... (read_at is still that complete read)');
:as_owner
set hub.now = '2026-10-28 09:01 America/New_York';
:as_service
select calendar_finish(gen_random_uuid(), '{}');
select test.is((select count(*) from google_events where event_id = 'club2'), 0::bigint, '... and deletes it once no read has refreshed it for 24 hours');
rollback;
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';
begin;
update calendars set read_at = '2026-10-27 12:00+00', checked_at = '2026-10-27 12:58+00' where label = 'Dogs';
update calendars set read_at = '2026-10-27 12:30+00', checked_at = '2026-10-27 12:30+00' where label = 'House';
:as_service
select test.is((select string_agg(c.label, ', ') from calendar_read_due() r join calendars c on c.id = r.calendar_id where c.label in ('Dogs', 'House')),
               'House, Dogs', 'read_due: a calendar whose reads are cut off (an old complete read, a fresh one) goes after one read longer ago');
rollback;

-- Deleting a lot of history never holds up today's changes; hiding a private item still goes first.
begin;
:as_owner
insert into calendar_links (google_calendar, base_id, event_id, calendar_id, item_kind, item_id, occurrence, day, end_day, title, hash, tried_hash, status, synced_at)
select 'hub-taylor@group.calendar.google.com', 'hh' || md5('history ' || i), 'hh' || md5('history ' || i), pg_temp.cal('Taylor'), 'event', test.event('Piano'),
       date '2025-10-27' + i, date '2025-10-27' + i, date '2025-10-27' + i, 'Piano (con Jordan)', 'h', 'h', 'ok', now()
from generate_series(0, 363) i;
:as_service
select test.is(pg_temp.plan(), null, '(a year of Piano on Taylor''s calendar is kept as history)');
:as_admin
delete from calendars where label = 'Taylor';
:as_owner
insert into events (title, start_date, start_time, responsible_id) values ('Haircut', '2026-10-27', '15:00', test.person('Alex'));
:as_service
create temp table big_plan as select p.*, row_number() over () as n from calendar_plan('https://hub.example.com/', 1000) p;
select test.ok((select count(*) from calendar_plan('https://hub.example.com/', 60) where op = 'insert' and title = 'Haircut') = 1,
               'Disconnect with a year of history: today''s new event is still in the first 60 writes');
select test.is((select string_agg(distinct case when day >= '2026-10-26' then 'window' else 'past' end, ', ') from big_plan where n < (select n from big_plan where title = 'Haircut')),
               'window', '... after the deletes in the window, and before the 364 deletes of the past');
select test.is((select count(*) from big_plan where op = 'delete' and day < '2026-10-26' and n > (select n from big_plan where title = 'Haircut')), 364::bigint,
               '... which all come after it');
select test.is((select max(hiding) from big_plan), (select count(*)::int from big_plan where op = 'delete'), '... every delete counts as hiding');
:as_owner
update events set private = true where title = 'Piano';
:as_service
select test.ok((select count(*) filter (where op = 'delete' and day < '2026-10-26') > 0 and count(*) filter (where title = 'Haircut') = 0
                from calendar_plan('https://hub.example.com/', 60)),
               '... but once Piano is made private, its past events come off before today''s changes (privacy first)');
rollback;

-- A run that ran out of time and wrote nothing while writes were pending doesn't count as a good sync.
begin;
:as_owner
update calendar_sync set running_since = null, paused_until = null, last_ok_at = '2026-10-27 12:00+00';
:as_service
delete from runs;
insert into runs select (calendar_begin() ->> 'run_id')::uuid;
select calendar_finish((select id from runs), '{"read": 3, "inserted": 0, "updated": 0, "deleted": 0, "failed": 0, "pending": 4, "hiding": 1}', 'time', null);
select test.is((select last_ok_at = '2026-10-27 12:00+00' and last_stop = 'time' from calendar_sync), true,
               'finish: a run that ran out of time without writing anything while writes were pending leaves last_ok_at (the email warns after 2 hours)');
delete from runs;
insert into runs select (calendar_begin() ->> 'run_id')::uuid;
select calendar_finish((select id from runs), '{"read": 3, "inserted": 0, "updated": 0, "deleted": 0, "failed": 0, "pending": 0, "hiding": 0}', 'time', null);
select test.is((select last_ok_at = private.now() from calendar_sync), true, '... with nothing pending it is a good sync');
rollback;

-- A calendar to read given to a kid or the helper reaches their own day: My day, day_text and the email.
begin;
:as_admin
insert into calendars (google_id, kind, person_id, label, writes) values
  ('tutoring@example.com', 'person', test.person('Jordan'), 'Tutoring', false),
  ('taylor.example@example.com', 'person', test.person('Taylor'), 'Taylor own', false);
:as_service
select pg_temp.store('Tutoring', jsonb_build_array(pg_temp.ev('tut1', 'Math tutor', '{"dateTime": "2026-10-28T20:00:00Z"}', '{"dateTime": "2026-10-28T21:00:00Z"}')),
                     '[]', true, 'Tutoring', 'reader');
select pg_temp.store('Taylor own', jsonb_build_array(pg_temp.ev('own1', 'Clase de inglés', '{"date": "2026-10-28"}', '{"date": "2026-10-29"}')),
                     '[]', true, 'Mine', 'reader');
select test.ok(day_text(test.person('Jordan'), '2026-10-28') like E'%\n4:00pm Math tutor\n%',
               'a calendar to read given to a kid: its events are in his day_text (no Show to kids needed: it is his)');
select test.ok(day_text(test.person('Taylor'), '2026-10-28') like '%Todo el día: Clase de inglés%', '... one given to the helper, in hers');
select test.ok(pg_temp.titles(digest_for(test.person('Jordan'), '2026-10-28') -> 'today') like '%Math tutor%', '... and in his morning email');
select test.ok(day_text(test.person('Alex'), '2026-10-28') not like '%Math tutor%', '... and in nobody else''s day');
:as_owner
set hub.now = '2026-10-28 07:00 America/New_York';
:as_anon
select test.ok(get_person_day(test.token('Jordan'))::text like '%Math tutor%', '... and on his My day');
select test.ok(get_person_day(test.token('Taylor'))::text like '%Clase de inglés%', '... and hers');
rollback;
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';

-- A calendar switched from writing to read-only: the hub's events there are deleted; when Google
-- refuses (it is now shared only to read), the links are forgotten at once.
begin;
:as_admin
update calendars set writes = false where label = 'Family';
:as_service
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000) where google_calendar = 'hub-family@group.calendar.google.com' and op = 'delete'),
               (select count(*) from calendar_links where google_calendar = 'hub-family@group.calendar.google.com'),
               'a calendar switched to read-only: every event the hub wrote there is deleted');
select calendar_record((select jsonb_agg(to_jsonb(p) || '{"ok": false, "forget": true, "http": 403, "error": "Home Hub can''t change this calendar."}')
                        from calendar_plan('https://hub.example.com/', 1000) p where p.google_calendar = 'hub-family@group.calendar.google.com'));
select test.is((select count(*) from calendar_links where google_calendar = 'hub-family@group.calendar.google.com'), 0::bigint,
               '... and when Google refuses (forget), the links are forgotten at once');
select test.is((select status from calendars where label = 'Family'), 'new', '... while the calendar itself is left as it is (no "can''t reach it")');
rollback;

-- ---------------------------------------------------------------------
-- Meals on the wall (migration 0004, docs/v1.2-kitchen.md §10): one all-day event per meal on
-- Hub – Family, and the plan keeps past dinners as history.
-- ---------------------------------------------------------------------
:as_service
select pg_temp.sync();
:as_owner
insert into meals (day, slot, kind, title, cook_id, note, link, private) values
  ('2026-10-25', 'dinner', 'cook', 'Pancakes', test.person('Alex'), null, null, false),     -- before the window
  ('2026-10-26', 'dinner', 'cook', 'Chili', test.person('Alex'), null, null, false),        -- yesterday: the window's first day
  ('2026-10-27', 'dinner', 'cook', 'Tacos', test.person('Sam'), 'Chicken is in the freezer', 'https://cooking.example.com/tacos', false),
  ('2026-10-28', 'dinner', 'takeout', null, test.person('Taylor'), 'Menu in the drawer', null, false),
  ('2026-10-29', 'dinner', 'cook', 'Surprise cake', test.person('Sam'), 'Hide the box', null, true),
  ('2026-10-30', 'dinner', 'fend', null, null, null, null, false),
  ('2026-12-26', 'dinner', 'cook', 'Roast', null, null, null, false),                       -- today + 60: its last day
  ('2026-12-27', 'dinner', 'cook', 'Stew', null, null, null, false);                        -- after the window
create function pg_temp.meal(p_day date) returns uuid language sql as $$ select id from public.meals where day = p_day and slot = 'dinner' $$;

select test.is((select string_agg(cal || ' ' || to_char(day, 'MM-DD') || ' ' || title, ' | ' order by day) from pg_temp.d() where item_kind = 'meal'),
               'Family 10-26 Dinner: Chili (Alex) | Family 10-27 Dinner: Tacos (Sam) | Family 10-28 Dinner: Takeout (Taylor) | '
               'Family 10-29 Dinner: Private item | Family 10-30 Dinner: Fend for yourself | Family 12-26 Dinner: Roast',
               'meals: one row per meal in the window (yesterday to 60 days ahead), on Family only: "Dinner: Tacos (Sam)"');
select test.is(pg_temp.body('Family', 'Dinner: Tacos (Sam)', '2026-10-27') - 'id' #- '{extendedProperties,private,homehub_base}' #- '{extendedProperties,private,homehub_item}',
               jsonb_build_object(
                 'status', 'confirmed', 'summary', 'Dinner: Tacos (Sam)',
                 'description', E'Made by Home Hub: changes made here are undone. Change it in Home Hub.\nSam cooks\nOpen in Home Hub: https://hub.example.com/#/food',
                 'start', jsonb_build_object('date', '2026-10-27'), 'end', jsonb_build_object('date', '2026-10-28'),
                 'transparency', 'transparent', 'visibility', 'default',
                 'extendedProperties', jsonb_build_object('private', jsonb_build_object('homehub', '1', 'homehub_kind', 'meal',
                                                                                        'homehub_occurrence', '2026-10-27'))),
               '... all day (to the next day), transparent, no place; the description: made by the hub, who cooks, the link to #/food');
select test.is((select (base_id = 'hh' || md5('meal|' || pg_temp.meal('2026-10-27') || '|2026-10-27|hub-family@group.calendar.google.com|'))::text
                       || ' ' || (body ->> 'id' = base_id) || ' ' || (body -> 'extendedProperties' -> 'private' ->> 'homehub_base' = base_id)
                       || ' ' || (body -> 'extendedProperties' -> 'private' ->> 'homehub_item' = pg_temp.meal('2026-10-27')::text)
                       || ' ' || (item_id = pg_temp.meal('2026-10-27')) || ' ' || to_char(end_day, 'MM-DD') || ' [' || part || '] ' || coalesce(job_id, '-')
                from pg_temp.d() where item_kind = 'meal' and day = '2026-10-27'),
               'true true true true true 10-27 [] -', '... a stable hh id from meal|<id>|<day>|<calendar>|, with the meal''s id; one day');
select test.is((select count(*) from pg_temp.d() where item_kind = 'meal'
                and (body::text like '%freezer%' or body::text like '%cooking.example.com%' or body::text like '%drawer%' or body::text like '%Hide the box%')),
               0::bigint, '... never the note or the recipe link');
select test.is(pg_temp.desc_of('Family', 'Dinner: Takeout (Taylor)', '2026-10-28'),
               E'Made by Home Hub: changes made here are undone. Change it in Home Hub.\nTaylor''s on dinner\nOpen in Home Hub: https://hub.example.com/#/food',
               'takeout: who''s on dinner');
select test.is((select concat_ws(' | ', title, private, body ->> 'visibility', body ->> 'description') from pg_temp.d() where item_kind = 'meal' and day = '2026-10-29'),
               E'Dinner: Private item | t | private | Made by Home Hub: changes made here are undone. Change it in Home Hub.\nOpen in Home Hub: https://hub.example.com/#/food',
               'a locked meal: "Dinner: Private item", private, with no name');
select test.is((select body ->> 'description' from pg_temp.d(null) where item_kind = 'meal' and day = '2026-10-27'),
               E'Made by Home Hub: changes made here are undone. Change it in Home Hub.\nSam cooks', 'without a site, no link');
begin;
update people set active = false where name = 'Sam';
select test.is((select title || ' | ' || (body ->> 'description') from pg_temp.d(null) where item_kind = 'meal' and day = '2026-10-27'),
               E'Dinner: Tacos | Made by Home Hub: changes made here are undone. Change it in Home Hub.', 'a cook off the family list is left out');
rollback;
begin;
update household set meals_on_wall = false;
select test.is((select count(*) from pg_temp.d() where item_kind = 'meal'), 0::bigint, '"Dinners on the kitchen wall" off: no meal rows');
rollback;
begin;
delete from calendars where label = 'Family';
select test.is((select count(*) from private.meal_events('2026-10-26', '2026-12-26', null)), 0::bigint, 'no writing Family calendar: no meal rows');
rollback;
:as_admin
select test.is((select string_agg(concat_ws(' ', to_char(day, 'MM-DD'), title, private, coalesce(details, '-')), ' | ' order by day)
                from calendar_preview(pg_temp.cal('Family')) where item_kind = 'meal'),
               '10-26 Dinner: Chili (Alex) f Alex cooks | 10-27 Dinner: Tacos (Sam) f Sam cooks | 10-28 Dinner: Takeout (Taylor) f Taylor''s on dinner | '
               '10-29 Dinner: Private item t - | 10-30 Dinner: Fend for yourself f - | 12-26 Dinner: Roast f -',
               'calendar_preview lists the meal rows (Family''s preview, before Start copying)');

-- The plan.
:as_service
select test.is(pg_temp.plan(),
               'insert Dinner: Chili (Alex) 10-26 | insert Dinner: Tacos (Sam) 10-27 | insert Dinner: Takeout (Taylor) 10-28 | '
               'insert Dinner: Private item 10-29 | insert Dinner: Fend for yourself 10-30 | insert Dinner: Roast 12-26',
               'plan: each new meal is one insert');
select test.is(pg_temp.sync(), 6, '... written');
select test.is((select string_agg(to_char(day, 'MM-DD') || ' ' || item_kind || ' ' || (item_id = pg_temp.meal(day)) || ' ' || occurrence, ' | ' order by day)
                from calendar_links where item_kind = 'meal'),
               '10-26 meal true 2026-10-26 | 10-27 meal true 2026-10-27 | 10-28 meal true 2026-10-28 | 10-29 meal true 2026-10-29 | '
               '10-30 meal true 2026-10-30 | 12-26 meal true 2026-12-26',
               '... and calendar_links keeps them (item_kind ''meal'')');

-- Turning the switch off takes yesterday's and later dinners off; older ones stay.
begin;
:as_owner
set hub.now = '2026-10-28 09:00 America/New_York';
update household set meals_on_wall = false;
:as_service
select test.is((select string_agg(op || ' ' || title || ' ' || to_char(day, 'MM-DD'), ' | ' order by day) from calendar_plan('https://hub.example.com/', 1000)
                where item_kind = 'meal'),
               'delete Dinner: Tacos (Sam) 10-27 | delete Dinner: Takeout (Taylor) 10-28 | delete Dinner: Private item 10-29 | '
               'delete Dinner: Fend for yourself 10-30 | delete Dinner: Roast 12-26',
               'the wall switch off: yesterday''s dinner and later ones are deleted; the one from two days before (Chili) is kept');
rollback;

:as_owner
update meals set title = 'Fish tacos' where day = '2026-10-27';
:as_service
select test.is(pg_temp.plan(), 'update Dinner: Fish tacos (Sam) 10-27', 'a changed title: one update (same id)');
select pg_temp.sync();
:as_owner
update meals set private = true where day = '2026-10-27';
update meals set kind = 'out' where day = '2026-10-30';
:as_service
select test.is(pg_temp.plan(), 'update Dinner: Private item 10-27 | update Dinner: Eating out 10-30',
               'locking a meal: one update to private, first in order');
select test.is((select body ->> 'visibility' from calendar_plan('https://hub.example.com/', 1) p), 'private', '... with visibility private');
select pg_temp.sync();
:as_owner
delete from meals where day = '2026-10-30';
:as_service
select test.is(pg_temp.plan(), 'delete Dinner: Eating out 10-30', 'a cleared day: a delete');
select pg_temp.sync();
:as_owner
update meals set day = '2026-10-31' where day = '2026-10-28';
:as_service
select test.is(pg_temp.plan(), 'delete Dinner: Takeout (Taylor) 10-28 | insert Dinner: Takeout (Taylor) 10-31',
               'a moved dinner: a delete and an insert');
select pg_temp.sync();

-- Past dinners stay on Google as history, unless deleted, moved or locked (as a past event's copies).
:as_owner
set hub.now = '2026-11-20 09:00 America/New_York';
:as_service
select test.is((select count(*) from calendar_plan('https://hub.example.com/', 1000) where item_kind = 'meal' and day in ('2026-10-26', '2026-10-31')),
               0::bigint, 'three weeks on: the past dinners'' events stay (Chili, Takeout)');
:as_owner
delete from meals where day = '2026-10-26';
update meals set day = '2026-10-20' where day = '2026-10-31';
:as_service
select test.is((select string_agg(op || ' ' || title || ' ' || to_char(day, 'MM-DD'), ' | ' order by n)
                from (select p.*, row_number() over () as n from calendar_plan('https://hub.example.com/', 1000) p) x where item_kind = 'meal'),
               'delete Dinner: Private item 10-27 | delete Dinner: Private item 10-29 | insert Dinner: Stew 12-27 | '
               'delete Dinner: Chili (Alex) 10-26 | delete Dinner: Takeout (Taylor) 10-31',
               '... locked ones come off first, with the deletes that hide something (10-27 locked later, 10-29 from the start); '
               'a deleted or moved past dinner''s event comes off last, with the other past deletes');
select pg_temp.sync();
select test.is((select string_agg(to_char(day, 'MM-DD'), ' ' order by day) from calendar_links where item_kind = 'meal'), '12-26 12-27',
               '... and then nothing else changes');

-- An orphan meal event (a run died between Google and calendar_record) is adopted.
begin;
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';
insert into meals (day, kind, title) values ('2026-11-05', 'cook', 'Soup');
:as_service
select test.is(pg_temp.store('Family', '[]',
                 (select jsonb_agg(jsonb_build_object(
                           'id', event_id, 'status', 'confirmed', 'title', title,
                           'start', jsonb_build_object('date', to_char(day, 'YYYY-MM-DD')), 'end', jsonb_build_object('date', to_char(end_day + 1, 'YYYY-MM-DD')),
                           'updated', '2026-10-27T13:00:00Z', 'hash', google_hash, 'organizer_self', true,
                           'props', jsonb_build_object('homehub', '1', 'homehub_base', base_id, 'homehub_kind', item_kind)))
                  from calendar_links where google_calendar = 'hub-family@group.calendar.google.com')
                 || jsonb_build_array(jsonb_build_object(
                      'id', d.base_id, 'status', 'confirmed', 'title', d.title, 'start', '{"date": "2026-11-05"}'::jsonb, 'end', '{"date": "2026-11-06"}'::jsonb,
                      'organizer_self', true, 'updated', '2026-10-27T12:00:00Z', 'hash', 'o1',
                      'props', jsonb_build_object('homehub', '1', 'homehub_base', d.base_id, 'homehub_kind', 'meal',
                                                  'homehub_item', pg_temp.meal('2026-11-05')::text, 'homehub_occurrence', '2026-11-05'))))
               ->> 'adopted', '1', 'calendar_store_events adopts a hub event of kind ''meal'' without a link')
from pg_temp.d() d where d.item_kind = 'meal' and d.day = '2026-11-05';
select test.is((select concat_ws(' ', item_kind, item_id = pg_temp.meal('2026-11-05'), occurrence, hash) from calendar_links
                where google_calendar = 'hub-family@group.calendar.google.com' and day = '2026-11-05'), 'meal t 2026-11-05',
               '... as its meal, with hash null');
select test.is((select string_agg(op || ' ' || title, ' | ') from calendar_plan('https://hub.example.com/', 1000) where item_kind = 'meal' and day = '2026-11-05'),
               'update Dinner: Soup', '... so the next plan updates it rather than inserting a second one');
rollback;
