-- Tasks: complete (on time, late, early, another day), double taps, after_done, skip, undo,
-- the daily roll-on of missed dates, how tasks show in agenda/late_items/heads_up,
-- project tasks on the calendar, and the task_dates staleness trigger.
\ir roles.sql
\ir fixtures.sql

:as_owner
insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit) values
  ('Pill', test.person('Taylor'), '2026-11-01', 'schedule', 1, 'month'),
  ('Filter', null, '2026-11-01', 'schedule', 1, 'month'),
  ('Vitamins', null, '2026-11-01', 'schedule', 1, 'month'),
  ('Gutters', null, '2026-10-01', 'schedule', 1, 'month'),
  ('Water plants', test.person('Morgan'), '2026-11-02', 'schedule', 1, 'week'),
  ('Furnace filter', test.person('Sam'), '2026-11-01', 'after_done', 60, 'day'),
  ('Car wash', null, '2026-11-01', 'after_done', 2, 'week');
insert into tasks (title, due_date) values ('Call plumber', '2026-11-03');

-- ---------------------------------------------------------------------
-- complete_task
-- ---------------------------------------------------------------------
set hub.now = '2026-11-01 08:00-04';
:as_admin
select test.is(today_local(), '2026-11-01'::date, 'hub.now sets the household''s today');
select test.ok(complete_task(test.task('Pill'), '2026-11-01') is not null, 'complete_task returns the log id');
select test.is((select due_date || ' ' || last_done from tasks where title = 'Pill'), '2026-12-01 2026-11-01', 'on time: next month, last done today');
select test.is((select occurrence || ' ' || status || ' ' || done_on || ' ' || done_by || ' ' || prev_due || ' ' || coalesce(prev_last_done::text, '-')
                from task_log where task_id = test.task('Pill')),
               '2026-11-01 done 2026-11-01 alex@example.com 2026-11-01 -', 'on time: the log row');
select test.throws($$select complete_task(test.task('Pill'), '2026-11-01')$$, 'already completed', 'a second tap on the same date says already completed');
select test.throws($$select complete_task(test.task('Pill'), null, '2026-11-02')$$, 'hasn''t happened yet', 'done_on cannot be in the future');

-- Done early, on another day: the next date still comes from the due date.
select complete_task(test.task('Vitamins'), null, '2026-10-28');
select test.is((select due_date || ' ' || last_done from tasks where title = 'Vitamins'), '2026-12-01 2026-10-28', 'early: next month, last done the earlier day');

set hub.now = '2026-11-05 08:00-05';
select complete_task(test.task('Filter'), '2026-11-01');
select test.is((select due_date || ' ' || last_done from tasks where title = 'Filter'), '2026-12-01 2026-11-05', 'late: next month, last done today');
select complete_task(test.task('Gutters'));
select test.is((select due_date from tasks where title = 'Gutters'), '2026-12-01'::date, 'very late: the next date after today (Nov 1 has passed)');
select test.is((select string_agg(status || ' ' || occurrence, ', ' order by seq) from task_log where task_id = test.task('Gutters')),
               'missed 2026-10-01, done 2026-11-01', '... Oct 1 is logged as missed and Nov 1 as done, as if the hourly job had run');
select test.throws($$select complete_task(test.task('Pill'), null, '2025-11-30')$$, 'more than a year', 'done_on more than a year before the due date is refused');

-- after_done: counted from the day it was done.
select complete_task(test.task('Furnace filter'));
select test.is((select due_date || ' ' || last_done from tasks where title = 'Furnace filter'), '2027-01-04 2026-11-05', 'after_done: 60 days after it was done');

-- One-off tasks.
:as_adult
select complete_task(test.task('Call plumber'), null, null, 'Booked for Friday');
select test.is((select done_by || ' ' || (done_at = '2026-11-05 08:00-05') from tasks where title = 'Call plumber'), 'sam@example.com true',
               'one-off: done_at and done_by set');
select test.is((select note || ' ' || done_on from task_log where task_id = test.task('Call plumber')), 'Booked for Friday 2026-11-05', 'one-off: note and day logged');
select test.throws($$select complete_task(test.task('Call plumber'))$$, 'already done', 'one-off: a second tap says already done');
select test.throws($$select complete_task('00000000-0000-0000-0000-000000000000')$$, 'no longer exists', 'unknown task');

-- ---------------------------------------------------------------------
-- skip_task
-- ---------------------------------------------------------------------
select test.ok(skip_task(test.task('Water plants'), '2026-11-02') is not null, 'skip_task returns the log id');
select test.is((select due_date from tasks where title = 'Water plants'), '2026-11-09'::date, 'skip (schedule): the next date after today');
select test.is((select status || ' ' || occurrence || ' ' || done_by from task_log where task_id = test.task('Water plants')),
               'skipped 2026-11-02 sam@example.com', 'skip is logged');
select test.throws($$select skip_task(test.task('Water plants'), '2026-11-02')$$, 'already completed', 'skip with a stale date says already completed');
select skip_task(test.task('Car wash'));
select test.is((select due_date from tasks where title = 'Car wash'), '2026-11-19'::date, 'skip (after_done): counted from today');
-- Skipping one that isn't due yet never brings it closer.
:as_owner
insert into tasks (title, due_date, repeat_mode, every_count, every_unit) values ('Oil change', '2026-11-30', 'after_done', 2, 'week');
:as_adult
select skip_task(test.task('Oil change'), '2026-11-30');
select test.is((select due_date from tasks where title = 'Oil change'), '2026-12-14'::date, 'skip (after_done) before it is due: counted from the due date, never sooner');
select test.throws($$select skip_task(test.task('Call plumber'))$$, 'Only repeating tasks', 'one-off tasks cannot be skipped');

-- Paused tasks can't be ticked off or skipped.
:as_owner
insert into tasks (title, due_date, repeat_mode, every_count, every_unit, active) values ('Paused pill', '2026-11-05', 'schedule', 1, 'month', false);
:as_adult
select test.throws($$select complete_task(test.task('Paused pill'), '2026-11-05')$$, 'paused', 'complete_task: a paused task can''t be ticked off');
select test.throws($$select skip_task(test.task('Paused pill'), '2026-11-05')$$, 'paused', 'skip_task: nor skipped');
select test.is((select due_date || ' ' || coalesce(last_done::text, 'never') from tasks where title = 'Paused pill'), '2026-11-05 never',
               '... and it stays as it was');

-- ---------------------------------------------------------------------
-- How tasks show on the calendar
-- ---------------------------------------------------------------------
select test.is((select string_agg(title || ' ' || day || ' ' || status, ', ' order by title, day)
                from agenda('2026-11-01', '2026-11-10') where kind = 'task'),
               'Call plumber 2026-11-03 done, Car wash 2026-11-01 skipped, Filter 2026-11-01 done, Furnace filter 2026-11-05 done, '
               'Gutters 2026-11-01 done, Pill 2026-11-01 done, Vitamins 2026-11-01 done, Water plants 2026-11-02 skipped, Water plants 2026-11-09 open',
               'agenda: done and skipped history, done one-offs and open tasks; no projected repeats '
               '("a while after it''s done" is on the day it was done: Furnace filter, due Nov 1, done Nov 5; '
               'Gutters, due Oct 1 and ticked off on Nov 5, was done for Nov 1, the date it showed by then)');
select test.is((select repeating::text || ' ' || all_day from agenda('2026-11-09', '2026-11-09') where title = 'Water plants'), 'true true', 'agenda task flags');

-- ---------------------------------------------------------------------
-- undo_task
-- ---------------------------------------------------------------------
:as_admin
select complete_task(test.task('Filter'));
select test.is((select due_date from tasks where title = 'Filter'), '2027-01-01'::date, 'done twice: Jan 1');
select test.throws($$select undo_task((select id from task_log where task_id = test.task('Filter') and prev_due = '2026-11-01'))$$,
                   'Only the latest change', 'only the latest entry can be undone (same clock tick)');
select test.is(undo_task((select id from task_log where task_id = test.task('Filter') and prev_due = '2026-12-01')), test.task('Filter'), 'undo returns the task id');
select test.is((select due_date || ' ' || last_done from tasks where title = 'Filter'), '2026-12-01 2026-11-05', 'undo puts back the due date and last done');
select undo_task((select id from task_log where task_id = test.task('Filter')));
select test.is((select due_date || ' ' || coalesce(last_done::text, 'never') from tasks where title = 'Filter'), '2026-11-01 never', 'undo again: back to the start');
select test.is((select count(*) from task_log where task_id = test.task('Filter')), 0::bigint, 'undo deletes the log rows');
select undo_task((select id from task_log where task_id = test.task('Call plumber')));
select test.is((select coalesce(done_at::text, 'open') || ' ' || coalesce(done_by, 'nobody') from tasks where title = 'Call plumber'), 'open nobody',
               'undo a one-off: open again');
select undo_task((select id from task_log where task_id = test.task('Water plants')));
select test.is((select due_date from tasks where title = 'Water plants'), '2026-11-02'::date, 'undo a skip');
-- "Latest" is the entry written last. created_at is when its transaction started, so two taps
-- racing for the same task can write the later entry with the earlier time.
:as_owner
insert into tasks (title, due_date, repeat_mode, every_count, every_unit) values ('Meds', '2026-11-05', 'schedule', 1, 'day');
:as_admin
set hub.now = '2026-11-05 08:00:05-05';
select complete_task(test.task('Meds'));
set hub.now = '2026-11-05 08:00:00-05';
select complete_task(test.task('Meds'));
select test.throws($$select undo_task((select id from task_log where task_id = test.task('Meds') and prev_due = '2026-11-05'))$$,
                   'Only the latest change', 'the entry written first cannot be undone, even with a later clock time');
select test.is(undo_task((select id from task_log where task_id = test.task('Meds') and prev_due = '2026-11-06')), test.task('Meds'),
               'the entry written last can be undone, even with an earlier clock time');
select test.is((select due_date from tasks where title = 'Meds'), '2026-11-06'::date, '... and it puts back its own due date');
set hub.now = '2026-11-05 08:00-05';
set hub.now = '2026-11-13 08:00-05';
select test.throws($$select undo_task((select id from task_log where task_id = test.task('Furnace filter')))$$, 'more than 7 days', 'no undo after 7 days');
select test.throws($$select undo_task('00000000-0000-0000-0000-000000000000')$$, 'nothing to undo', 'unknown log id');
:as_stranger
select test.throws($$select undo_task(gen_random_uuid())$$, 'Only family members', 'strangers cannot undo');

-- ---------------------------------------------------------------------
-- roll_missed_tasks (daily, service_role)
-- ---------------------------------------------------------------------
:as_owner
insert into tasks (title, due_date, repeat_mode, every_count, every_unit, active) values
  ('Recycling', '2026-11-02', 'schedule', 1, 'week', true),
  ('Feed fish', '2026-11-01', 'schedule', 1, 'day', true),
  ('Paused', '2026-11-02', 'schedule', 1, 'week', false),
  ('Mow', '2026-11-02', 'after_done', 1, 'week', true);
set hub.now = '2026-11-10 06:00-05';
:as_service
select test.ok(roll_missed_tasks() >= 3, 'roll_missed_tasks moves the missed ones');
select test.is((select due_date from tasks where title = 'Recycling'), '2026-11-09'::date, 'weekly: moved to the latest date that has come');
select test.is((select due_date from tasks where title = 'Feed fish'), '2026-11-10'::date, 'daily: moved to today');
select test.is((select due_date from tasks where title = 'Pill'), '2026-12-01'::date, 'monthly, next date not yet come: stays');
select test.is((select due_date from tasks where title = 'Mow'), '2026-11-02'::date, 'after_done: never rolls, stays late');
select test.is((select due_date from tasks where title = 'Paused'), '2026-11-02'::date, 'inactive tasks do not roll');
select test.is((select status || ' ' || occurrence || ' ' || prev_due from task_log where task_id = test.task('Recycling')),
               'missed 2026-11-02 2026-11-02', 'a missed date is logged');
select test.is(roll_missed_tasks(), 0, 'rolling twice the same day moves nothing');
:as_adult
-- Rolled weekly tasks sit on Monday Nov 9, so on Tuesday they are a day late; Filter (monthly) and
-- Mow (after_done) didn't roll; Call plumber is a one-off that was undone.
select test.is((select string_agg(title || ' ' || day, ', ') from late_items()),
               'Filter 2026-11-01, Mow 2026-11-02, Call plumber 2026-11-03, Recycling 2026-11-09, Water plants 2026-11-09',
               'late_items: open tasks past due, oldest first');
select test.is((select distinct status from late_items()), 'late', 'late_items status is late');
:as_admin
select undo_task((select id from task_log where task_id = test.task('Recycling')));
select test.is((select due_date from tasks where title = 'Recycling'), '2026-11-02'::date, 'a missed entry can be undone');

-- ---------------------------------------------------------------------
-- heads_up: lead time and contract ends
-- ---------------------------------------------------------------------
:as_adult
insert into tasks (title, due_date, lead_days) values ('Vet visit', '2026-11-20', 5);
:as_admin
update contractors set contract_end = '2026-12-01' where name = 'City Water';   -- has an account number: admins only
:as_adult
select test.is((select string_agg(kind || ':' || title, ', ' order by kind) from heads_up('2026-11-15')), 'contract:City Water, task:Vet visit',
               'heads_up: inside the lead time, and a contract ending within 30 days');
select test.is((select count(*) from heads_up('2026-11-14') where kind = 'task'), 0::bigint, 'heads_up: not before the lead time');
select test.is((select count(*) from heads_up('2026-11-20') where kind = 'task'), 0::bigint, 'heads_up: not on the due day itself');
select test.is((select count(*) from heads_up('2026-10-31') where kind = 'contract'), 0::bigint, 'heads_up: contract more than 30 days away');

-- ---------------------------------------------------------------------
-- Project tasks: on the calendar from task_dates; staleness trigger
-- ---------------------------------------------------------------------
:as_adult
update projects set owner_id = test.person('Alex'), task_dates = '[
  {"id": "a", "name": "Wire", "trade": "electrician", "trade_name": "Electrician", "start": "2026-11-02", "end": "2026-11-03", "days": 2, "status": "", "milestone": false},
  {"id": "i", "name": "Inspection", "trade": "inspection", "start": "2026-11-04", "end": "2026-11-04", "days": 0, "status": "done", "milestone": true},
  {"id": "x", "name": "Broken", "start": "not a date", "end": "2026-11-04"}]' where name = 'Kitchen';
select test.is((select title || ' ' || day || '–' || end_day || ' ' || contractor_name || ' ' || contractor_phone || ' ' || project_name || ' ' || status
                from agenda('2026-11-03', '2026-11-03') where kind = 'project'),
               'Wire 2026-11-02–2026-11-03 Pat Lee 555-0100 Kitchen open', 'a project task overlapping the range, with its trade''s contractor');
select test.is((select milestone::text || ' ' || status || ' ' || (responsible_id = test.person('Alex'))::text
                from agenda('2026-11-04', '2026-11-04') where kind = 'project'),
               'true done true', 'milestone flag, raw status, owner as the person in charge');
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30') where title = 'Broken'), 0::bigint, 'a task with a bad date is skipped, not an error');
update projects set on_calendar = false where name = 'Kitchen';
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30') where kind = 'project'), 0::bigint, 'on_calendar off hides the project');
-- Only projects under way are on the calendar (and so in the email, day_text and My day), as on
-- the Today page: not an idea, a project on hold or a finished one.
update projects set on_calendar = true, status = 'on-hold' where name = 'Kitchen';
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30') where kind = 'project'), 0::bigint, 'a project on hold isn''t on the calendar');
update projects set status = 'idea' where name = 'Kitchen';
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30') where kind = 'project'), 0::bigint, '... nor an idea with a drafted schedule');
update projects set status = 'done' where name = 'Kitchen';
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30') where kind = 'project'), 0::bigint, '... nor a finished project');
update projects set status = 'planning' where name = 'Kitchen';
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30') where kind = 'project'), 2::bigint, 'a project being planned is');
update projects set status = 'active' where name = 'Kitchen';
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30') where kind = 'project'), 2::bigint, '... and an active one');

update projects set name = 'Kitchen remodel' where name = 'Kitchen';
select test.ok((select task_dates is not null from projects where name = 'Kitchen remodel'), 'changing other columns keeps task_dates');
-- The v2 client sends schedule, task_dates and task_dates_at (when it computed them) together.
update projects set schedule = schedule || '{"note": "v2 client"}', task_dates = '[]', task_dates_at = '2026-11-05 09:00-05'
where name = 'Kitchen remodel';
select test.is((select task_dates from projects where name = 'Kitchen remodel'), '[]'::jsonb, 'schedule, task_dates and task_dates_at written together: kept');
update projects set schedule = schedule || '{"note": "renamed a phase"}', task_dates = '[]', task_dates_at = '2026-11-05 09:01-05'
where name = 'Kitchen remodel';
select test.is((select task_dates from projects where name = 'Kitchen remodel'), '[]'::jsonb,
               'a schedule change that leaves every date where it was, with a new task_dates_at: kept');
update projects set schedule = schedule || '{"note": "forgot the time"}', task_dates = '[{"id": "a", "start": "2026-11-09", "end": "2026-11-09"}]'
where name = 'Kitchen remodel';
select test.is((select task_dates from projects where name = 'Kitchen remodel'), null,
               'schedule and task_dates without a new task_dates_at: marked stale');
select test.is((select task_dates_at from projects where name = 'Kitchen remodel'), '2026-11-05 09:01-05'::timestamptz, '... task_dates_at stays as it was');
update projects set task_dates = '[]', task_dates_at = '2026-11-05 09:02-05' where name = 'Kitchen remodel';
select test.is((select task_dates from projects where name = 'Kitchen remodel'), '[]'::jsonb, 'filling in stale dates (schedule unchanged): kept');
update projects set schedule = schedule || '{"note": "old client"}' where name = 'Kitchen remodel';
select test.is((select task_dates from projects where name = 'Kitchen remodel'), null, 'schedule written without task_dates (old client): marked stale');
select test.throws($$update projects set task_dates = '{"not": "a list"}'$$, 'violates check constraint', 'task_dates must be a list');

-- ---------------------------------------------------------------------
-- A series' anchor: kept by the hub's own moves, restarted by a hand edit
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2027-02-28 08:00-05';
insert into tasks (title, due_date, anchor_date, repeat_mode, every_count, every_unit)
values ('Rent', '2027-02-28', '2027-01-31', 'schedule', 1, 'month');
:as_adult
select complete_task(test.task('Rent'), '2027-02-28');
select test.is((select due_date || ' ' || anchor_date from tasks where title = 'Rent'), '2027-03-31 2027-01-31',
               'complete keeps the anchor: Jan 31 monthly comes back to Mar 31 after Feb 28');
select undo_task(test.last_log('Rent'));
select test.is((select due_date || ' ' || anchor_date from tasks where title = 'Rent'), '2027-02-28 2027-01-31', 'undo keeps the anchor');
select skip_task(test.task('Rent'), '2027-02-28');
select test.is((select due_date || ' ' || anchor_date from tasks where title = 'Rent'), '2027-03-31 2027-01-31', 'skip keeps the anchor');
:as_owner
set hub.now = '2027-05-02 06:00-04';
:as_service
select roll_missed_tasks();
select test.is((select due_date || ' ' || anchor_date from tasks where title = 'Rent'), '2027-04-30 2027-01-31',
               'the daily roll keeps the anchor (Apr 30, the last date that has come)');
:as_adult
update tasks set due_date = '2027-05-05' where title = 'Rent';
select test.is((select anchor_date from tasks where title = 'Rent'), '2027-05-05'::date, 'moving the date by hand restarts the series there');
select test.is(private.series_after(test.task_row('Rent'), '2027-05-05'), '2027-06-05'::date, '... so "monthly" now means the 5th');
update tasks set notes = 'Pay online', title = 'Rent' where title = 'Rent';
select test.is((select anchor_date from tasks where title = 'Rent'), '2027-05-05'::date, 'other changes keep the anchor');
update tasks set due_date = '2027-05-10', anchor_date = '2027-01-10' where title = 'Rent';
select test.is((select due_date || ' ' || anchor_date from tasks where title = 'Rent'), '2027-05-10 2027-01-10',
               'a change that sets the anchor itself keeps it');
update tasks set every_count = 3 where title = 'Rent';
select test.is((select anchor_date from tasks where title = 'Rent'), '2027-05-10'::date,
               'changing how often it repeats restarts the series from the due date');
select test.is(private.series_after(test.task_row('Rent'), '2027-05-10'), '2027-08-10'::date, '... so every 3 months counts from May 10');
-- The hub's flag lasts only for its own update, not for the rest of the transaction.
begin;
select complete_task(test.task('Rent'), '2027-05-10');
update tasks set due_date = '2027-09-01' where title = 'Rent';
commit;
select test.is((select due_date || ' ' || anchor_date from tasks where title = 'Rent'), '2027-09-01 2027-09-01',
               'a hand edit after complete_task in the same transaction still restarts the series');

-- ---------------------------------------------------------------------
-- "A while after it's done", ticked off early: one row a day, not two
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-09 08:00 America/New_York';
insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit)
values ('Water orchids', test.person('Taylor'), '2026-11-10', 'after_done', 1, 'day');
:as_anon
select complete_by_token(test.token('Taylor'), test.task('Water orchids'), '2026-11-10');
select test.is((select string_agg((d ->> 'day') || ' ' || (i ->> 'status'), ', ' order by d ->> 'day', i ->> 'status')
                from jsonb_array_elements(get_person_day(test.token('Taylor')) -> 'days') d, jsonb_array_elements(d -> 'items') i
                where i ->> 'title' = 'Water orchids'),
               '2026-11-09 done, 2026-11-10 open',
               'every day after it''s done, ticked off from tomorrow''s list: done today, due again tomorrow, one row each');
:as_owner
select test.is((select due_date || ' ' || last_done from tasks where title = 'Water orchids'), '2026-11-10 2026-11-09', '... (due tomorrow, last done today)');

-- ---------------------------------------------------------------------
-- Missed dates move on by themselves, even before the hourly job is set up
-- ---------------------------------------------------------------------
-- Without hub-jobs or cron.sql nothing calls roll_missed_tasks(), yet a daily pill must still
-- be due today, not late since the first day it was missed. The pages show a task on set dates
-- as the roll would leave it, and ticking it off rolls it first (logging the missed days).
:as_owner
set hub.now = '2026-10-26 08:00 America/New_York';
insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit, category)
values ('Give Biscuit his pill', test.person('Morgan'), '2026-10-26', 'schedule', 1, 'day', 'pets');
insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit)
values ('Take out bins', test.person('Sam'), '2026-10-19', 'schedule', 1, 'week');
:as_anon
select complete_by_token(test.token('Morgan'), test.task('Give Biscuit his pill'), '2026-10-26');
:as_owner
set hub.now = '2026-10-29 07:00 America/New_York';
:as_anon
select test.is((select string_agg(i ->> 'title' || ' ' || (i ->> 'occurrence'), ', ') from jsonb_array_elements(get_person_day(test.token('Morgan')) -> 'days' -> 0 -> 'items') i
                where i ->> 'title' like 'Give Biscuit%'),
               'Give Biscuit his pill 2026-10-29', 'a daily pill missed Tuesday and Wednesday is due today on My day');
select test.is((select count(*) from jsonb_array_elements(get_person_day(test.token('Morgan')) -> 'late') i where i ->> 'title' like 'Give Biscuit%'), 0::bigint,
               '... not late since Tuesday');
:as_adult
select test.is((select string_agg(occurrence || ' ' || status, ', ') from agenda('2026-10-26', '2026-10-31') where title = 'Give Biscuit his pill'),
               '2026-10-26 done, 2026-10-29 open', 'the calendar has it today');
select test.is((select count(*) from late_items() where title = 'Give Biscuit his pill'), 0::bigint, '... and not under Late');
select test.is((select string_agg(title || ' ' || day, ', ') from late_items() where title = 'Take out bins'), 'Take out bins 2026-10-26',
               'a weekly task is late from its latest date (Monday), not from the week before');
:as_admin
select test.is(day_text(test.person('Sam'), '2026-10-29'), E'Sam · Thu Oct 29\nNothing planned\nLate:\n☐ Take out bins (Oct 26)', '... in day_text too');
:as_anon
select test.ok(complete_by_token(test.token('Morgan'), test.task('Give Biscuit his pill'), '2026-10-29') is not null, 'ticking off today''s works');
:as_owner
select test.is((select due_date from tasks where title = 'Give Biscuit his pill'), '2026-10-30'::date, '... it is due tomorrow');
select test.is((select string_agg(status || ' ' || occurrence, ', ' order by seq) from task_log where task_id = test.task('Give Biscuit his pill')),
               'done 2026-10-26, missed 2026-10-27, done 2026-10-29', '... and the missed days are logged');
:as_service
select test.is(roll_missed_tasks(), 1, 'the hourly job, when there is one, rolls the rest (the bins)');
select test.is((select due_date from tasks where title = 'Take out bins'), '2026-10-26'::date, '... to the same date the pages showed');
