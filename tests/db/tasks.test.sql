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

-- ---------------------------------------------------------------------
-- How tasks show on the calendar
-- ---------------------------------------------------------------------
select test.is((select string_agg(title || ' ' || day || ' ' || status, ', ' order by title, day)
                from agenda('2026-11-01', '2026-11-10') where kind = 'task'),
               'Call plumber 2026-11-03 done, Car wash 2026-11-01 skipped, Filter 2026-11-01 done, Furnace filter 2026-11-01 done, '
               'Pill 2026-11-01 done, Vitamins 2026-11-01 done, Water plants 2026-11-02 skipped, Water plants 2026-11-09 open',
               'agenda: done and skipped history, done one-offs and open tasks; no projected repeats');
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

update projects set name = 'Kitchen remodel' where name = 'Kitchen';
select test.ok((select task_dates is not null from projects where name = 'Kitchen remodel'), 'changing other columns keeps task_dates');
update projects set schedule = schedule || '{"note": "v2 client"}', task_dates = '[]' where name = 'Kitchen remodel';
select test.is((select task_dates from projects where name = 'Kitchen remodel'), '[]'::jsonb, 'schedule and task_dates written together: kept');
update projects set schedule = schedule || '{"note": "old client"}' where name = 'Kitchen remodel';
select test.is((select task_dates from projects where name = 'Kitchen remodel'), null, 'schedule written without task_dates (old client): marked stale');
select test.throws($$update projects set task_dates = '{"not": "a list"}'$$, 'violates check constraint', 'task_dates must be a list');
