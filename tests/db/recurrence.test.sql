-- Recurrence: weekly events (ISO weeks), until dates, days off, one-day changes,
-- multi-day events, task series (months clamp, counted from the anchor) and DST instants.
\ir roles.sql
\ir fixtures.sql

-- ---------------------------------------------------------------------
-- Weekly events
-- ---------------------------------------------------------------------
:as_adult
-- Every 2 weeks on Mon and Wed, starting on a Wednesday. Weeks run Monday to Sunday, so the
-- first week is Oct 26–Nov 1 (only Wed Oct 28 is on or after the start), the next is Nov 9–15.
insert into events (title, start_date, start_time, end_time, repeat, repeat_every, repeat_weekdays, responsible_id, participant_ids, notes)
values ('Piano', '2026-10-28', '16:00', '17:00', 'weekly', 2, '{1,3}', test.person('Morgan'), array[test.person('Taylor')], 'Bring the blue book');
select test.is((select string_agg(day::text, ' ' order by day) from agenda('2026-10-26', '2026-11-30') where title = 'Piano'),
               '2026-10-28 2026-11-09 2026-11-11 2026-11-23 2026-11-25', 'every 2 weeks on Mon+Wed from a Wednesday');

-- The first day's weekday is always in the series.
insert into events (title, start_date, start_time, repeat, repeat_weekdays) values ('Choir', '2026-11-04', '18:00', 'weekly', '{1}');
select test.is((select repeat_weekdays from events where title = 'Choir'), '{1,3}'::int[], 'a weekly event gets its first day''s weekday');
select test.is((select string_agg(day::text, ' ' order by day) from agenda('2026-11-01', '2026-11-14') where title = 'Choir'),
               '2026-11-04 2026-11-09 2026-11-11', 'weekly Mon+Wed from a Wednesday, every week');
insert into events (title, start_date, start_time, repeat) values ('Soccer', '2026-11-07', '09:00', 'weekly');
select test.is((select repeat_weekdays from events where title = 'Soccer'), '{6}'::int[], 'weekly with no days repeats on the first day''s weekday');
insert into events (title, start_date, repeat_weekdays) values ('Garage sale', '2026-11-07', '{6}');
select test.is((select repeat_weekdays from events where title = 'Garage sale'), '{}'::int[], 'weekdays only for weekly events: a one-off has them cleared');
update events set repeat = 'none' where title = 'Soccer';
select test.is((select repeat || ' ' || repeat_weekdays::text from events where title = 'Soccer'), 'none {}',
               'switching a weekly event to "doesn''t repeat" clears its weekdays');
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30') where title = 'Soccer'), 1::bigint, '... and it happens once');
update events set repeat = 'weekly' where title = 'Soccer';
select test.is((select repeat_weekdays from events where title = 'Soccer'), '{6}'::int[], 'and back to weekly: its first day''s weekday again');

-- Until is the last day that can have an occurrence.
insert into events (title, start_date, start_time, repeat, repeat_until) values ('Practice', '2026-11-05', '19:30', 'weekly', '2026-11-19');
select test.is((select string_agg(day::text, ' ' order by day) from agenda('2026-11-01', '2026-12-31') where title = 'Practice'),
               '2026-11-05 2026-11-12 2026-11-19', 'repeat_until includes its own day and stops there');
select test.throws($$insert into events (title, start_date, repeat, repeat_until) values ('Bad', '2026-11-05', 'weekly', '2026-11-01')$$,
                   'violates check constraint', 'repeat_until cannot be before the start');

-- Days off (school holidays) are skipped only by events that ask for it.
:as_admin
update household set days_off = '{2026-11-11, 2026-11-26}';
:as_adult
insert into events (title, start_date, start_time, repeat, repeat_weekdays, skip_days_off)
values ('School pickup', '2026-11-09', '15:00', 'weekly', '{1,2,3,4,5}', true);
select test.is((select string_agg(day::text, ' ' order by day) from agenda('2026-11-09', '2026-11-13') where title = 'School pickup'),
               '2026-11-09 2026-11-10 2026-11-12 2026-11-13', 'skip_days_off skips the household''s days off');
select test.is((select count(*) from agenda('2026-11-11', '2026-11-11') where title = 'Piano'), 1::bigint,
               'events without skip_days_off still happen on days off');

-- ---------------------------------------------------------------------
-- One-day changes: cancel, move, reassign
-- ---------------------------------------------------------------------
insert into event_changes (event_id, on_date, cancelled) values (test.event('Piano'), '2026-11-09', true);
insert into event_changes (event_id, on_date, start_time, end_time, note) values (test.event('Piano'), '2026-11-23', '17:30', '18:30', 'Teacher is late');
insert into event_changes (event_id, on_date, responsible_id, participant_ids)
values (test.event('Piano'), '2026-11-25', test.person('Sam'), array[test.person('Taylor'), test.person('Sam')]);
select test.is((select status from agenda('2026-11-09', '2026-11-09') where title = 'Piano'), 'cancelled', 'cancel: the day comes back as cancelled');
select test.is((select count(*) from agenda('2026-11-09', '2026-11-09') where title = 'Piano'), 1::bigint, 'cancel: still one row (the Calendar strikes it through)');
select test.is((select local_start || ' ' || local_end || ' ' || start_at || ' ' || changed
                from agenda('2026-11-23', '2026-11-23') where title = 'Piano'),
               '17:30:00 18:30:00 2026-11-23 22:30:00+00 true', 'move: new time and instant, marked changed');
select test.is((select notes from agenda('2026-11-23', '2026-11-23') where title = 'Piano'), E'Teacher is late\n\nBring the blue book',
               'move: the day''s note comes first');
-- The day's note is for whoever is on it ("Pick up at the side door"): it reaches their day
-- text, My day and morning email. The series' own notes stay family-only.
select test.is((select day_note from agenda('2026-11-23', '2026-11-23') where title = 'Piano'), 'Teacher is late', 'the day''s note on its own: day_note');
select test.is((select day_note from agenda('2026-11-11', '2026-11-11') where title = 'Piano'), null, '... none on an ordinary day');
select test.is(day_text(test.person('Taylor'), '2026-11-23'), E'Taylor · Mon Nov 23\n5:30pm Piano · Morgan · Teacher is late',
               'day_text carries the day''s note, never the series'' notes');
:as_owner
set hub.now = '2026-11-23 08:00 America/New_York';
:as_anon
select test.is((select i ->> 'note' from jsonb_array_elements(get_person_day(test.token('Morgan')) -> 'days' -> 0 -> 'items') i where i ->> 'title' = 'Piano'),
               'Teacher is late', 'My day shows the day''s note');
select test.is(get_person_day(test.token('Morgan'))::text like '%blue book%', false, '... never the series'' notes');
:as_service
select test.is((select x ->> 'detail' from jsonb_array_elements(digest_for(test.person('Morgan'), '2026-11-23') -> 'today') x where x ->> 'title' = 'Piano'),
               'con Taylor · Teacher is late', 'the morning email shows it too');
select test.is(digest_for(test.person('Morgan'), '2026-11-23')::text like '%blue book%', false, '... never the series'' notes');
:as_owner
reset hub.now;
:as_adult
select test.is((select (responsible_id = test.person('Sam'))::text || ' ' || (participant_ids = array[test.person('Taylor')])::text
                from agenda('2026-11-25', '2026-11-25') where title = 'Piano'),
               'true true', 'reassign: new person in charge, and they aren''t also listed as with');
select test.is((select status || ' ' || changed || ' ' || (responsible_id = test.person('Morgan'))::text
                from agenda('2026-11-11', '2026-11-11') where title = 'Piano'),
               'open false true', 'other days keep the series'' time and people');
select test.ok(day_text(test.person('Morgan'), '2026-11-09') not like '%Piano%', 'a cancelled day is left out of day_text');

-- ---------------------------------------------------------------------
-- Multi-day, all-day, late-night and range limits
-- ---------------------------------------------------------------------
insert into events (title, start_date, end_date) values ('Camp', '2026-11-27', '2026-11-29');
select test.is((select day || ' ' || end_day || ' ' || all_day || ' ' || coalesce(start_at::text, 'no instant')
                from agenda('2026-11-28', '2026-11-28') where title = 'Camp'),
               '2026-11-27 2026-11-29 true no instant', 'a multi-day event is one row from day to end_day');
select test.throws($$insert into events (title, start_date, end_date, start_time) values ('Bad', '2026-11-27', '2026-11-29', '10:00')$$,
                   'violates check constraint', 'multi-day events are all-day');
insert into events (title, start_date, start_time, end_time, ends_next_day) values ('Night shift', '2026-11-01', '23:30', '00:30', true);
select test.is((select start_at || ' ' || end_at || ' ' || end_day from agenda('2026-11-01', '2026-11-01') where title = 'Night shift'),
               '2026-11-02 04:30:00+00 2026-11-02 05:30:00+00 2026-11-02', 'ends_next_day ends on the next day');
insert into events (title, start_date, start_time) values ('Late call', '2026-11-03', '23:30');
select test.is((select end_at - start_at from agenda('2026-11-03', '2026-11-03') where title = 'Late call'), interval '1 hour',
               'no end time means one hour, even across midnight');
select test.throws($$select * from agenda('2026-11-01', '2027-01-02')$$, '1 to 62 days', 'agenda refuses more than 62 days');
select test.throws($$select * from agenda('2026-11-02', '2026-11-01')$$, '1 to 62 days', 'agenda refuses a backwards range');
select test.is(test.try($$select * from agenda('2026-11-01', '2027-01-01')$$) like 'rows:%', true, 'agenda allows exactly 62 days');

-- ---------------------------------------------------------------------
-- DST: wall-clock times stay put; the instants move
-- ---------------------------------------------------------------------
insert into events (title, start_date, start_time, repeat) values ('Swim', '2026-10-25', '10:00', 'weekly');
select test.is((select string_agg(day || ' ' || start_at, ', ' order by day) from agenda('2026-10-25', '2026-11-01') where title = 'Swim'),
               '2026-10-25 2026-10-25 14:00:00+00, 2026-11-01 2026-11-01 15:00:00+00', 'Nov 1 2026: 10:00 is 15:00 UTC after falling back');
select test.is((select string_agg(day || ' ' || start_at, ', ' order by day) from agenda('2027-03-07', '2027-03-14') where title = 'Swim'),
               '2027-03-07 2027-03-07 15:00:00+00, 2027-03-14 2027-03-14 14:00:00+00', 'Mar 14 2027: 10:00 is 14:00 UTC after springing forward');
select test.is((select end_at from agenda('2026-11-01', '2026-11-01') where title = 'Night shift'), '2026-11-02 05:30:00+00'::timestamptz,
               'Nov 1 2026: a late event ends at the right instant');
-- No end time means one real hour, also next to the clock change.
insert into events (title, start_date, start_time) values ('Night feed', '2026-11-01', '00:30'), ('Early flight', '2027-03-14', '02:30');
select test.is((select end_at - start_at from agenda('2026-11-01', '2026-11-01') where title = 'Night feed'), interval '1 hour',
               'Nov 1 2026: an event at 12:30am with no end time lasts one hour, not two');
select test.is((select end_at - start_at from agenda('2027-03-14', '2027-03-14') where title = 'Early flight'), interval '1 hour',
               'Mar 14 2027: an event at 2:30am (a skipped time) with no end time lasts one hour, not zero');
:as_admin
update household set tz = 'America/Los_Angeles';
:as_adult
select test.is((select start_at from agenda('2026-11-01', '2026-11-01') where title = 'Swim'), '2026-11-01 18:00:00+00'::timestamptz,
               'instants follow the household time zone');
:as_admin
update household set tz = 'America/New_York';

-- ---------------------------------------------------------------------
-- Task series (computed from the anchor)
-- ---------------------------------------------------------------------
:as_owner
insert into tasks (title, due_date, repeat_mode, every_count, every_unit) values
  ('Rent', '2026-01-31', 'schedule', 1, 'month'),
  ('Leap check', '2024-02-29', 'schedule', 1, 'year'),
  ('Quarterly', '2026-11-30', 'schedule', 3, 'month'),
  ('Fish food', '2026-11-01', 'schedule', 3, 'day'),
  ('Sheets', '2026-11-02', 'schedule', 2, 'week');
insert into tasks (title, due_date, repeat_mode, every_count, every_unit, repeat_weekdays)
values ('Lessons', '2026-10-28', 'schedule', 2, 'week', '{3,1}');
select test.is((select anchor_date from tasks where title = 'Rent'), '2026-01-31'::date, 'a repeating task anchors on its first due date');
select test.is((select repeat_weekdays from tasks where title = 'Lessons'), '{1,3}'::int[], 'task weekdays are kept in order');
select test.is(private.series_after(test.task_row('Rent'), '2026-01-31'), '2026-02-28'::date, 'Jan 31 monthly → Feb 28');
select test.is(private.series_after(test.task_row('Rent'), '2026-02-28'), '2026-03-31'::date, 'Jan 31 monthly → Mar 31 (from the anchor, not from Feb 28)');
select test.is(private.series_after(test.task_row('Rent'), '2026-03-31'), '2026-04-30'::date, 'Jan 31 monthly → Apr 30');
select test.is(private.series_on_or_before(test.task_row('Rent'), '2026-03-15'), '2026-02-28'::date, 'Jan 31 monthly: last date on or before Mar 15 is Feb 28');
select test.is(private.series_after(test.task_row('Leap check'), '2026-03-01'), '2027-02-28'::date, 'Feb 29 yearly → 2027-02-28');
select test.is(private.series_after(test.task_row('Leap check'), '2027-02-28'), '2028-02-29'::date, 'Feb 29 yearly → 2028-02-29');
select test.is(private.series_after(test.task_row('Leap check'), '2023-06-01'), '2024-02-29'::date, 'before the anchor, the next date is the anchor');
select test.is(private.series_after(test.task_row('Quarterly'), '2026-11-30'), '2027-02-28'::date, 'every 3 months from Nov 30 → Feb 28');
select test.is(private.series_after(test.task_row('Quarterly'), '2027-02-28'), '2027-05-30'::date, 'every 3 months from Nov 30 → May 30');
select test.is(private.series_after(test.task_row('Fish food'), '2026-11-05'), '2026-11-07'::date, 'every 3 days from Nov 1, after Nov 5 → Nov 7');
select test.is(private.series_on_or_before(test.task_row('Fish food'), '2026-11-09'), '2026-11-07'::date, 'every 3 days: on or before Nov 9 → Nov 7');
select test.is(private.series_after(test.task_row('Sheets'), '2026-11-02'), '2026-11-16'::date, 'every 2 weeks → 14 days later');
select test.is(private.series_after(test.task_row('Lessons'), '2026-10-28'), '2026-11-09'::date, 'task every 2 weeks Mon+Wed: Oct 28 → Nov 9');
select test.is(private.series_after(test.task_row('Lessons'), '2026-11-09'), '2026-11-11'::date, 'task every 2 weeks Mon+Wed: Nov 9 → Nov 11');
select test.is(private.series_after(test.task_row('Lessons'), '2026-11-11'), '2026-11-23'::date, 'task every 2 weeks Mon+Wed: Nov 11 → Nov 23');
select test.is(private.series_on_or_before(test.task_row('Lessons'), '2026-11-20'), '2026-11-11'::date, 'task every 2 weeks Mon+Wed: on or before Nov 20 → Nov 11');
select test.is(private.add_units('2026-11-05', 60, 'day'), '2027-01-04'::date, '60 days after Nov 5 is Jan 4');
insert into tasks (title, due_date, repeat_mode, every_count, every_unit, repeat_weekdays) values ('Monthly check', '2026-11-02', 'schedule', 1, 'month', '{1}');
select test.is((select repeat_weekdays from tasks where title = 'Monthly check'), '{}'::int[], 'weekdays only for weekly schedules: others have them cleared');
insert into tasks (title, due_date, repeat_mode, every_count, every_unit, repeat_weekdays) values ('Plant care', '2026-11-02', 'after_done', 1, 'week', '{1}');
select test.is((select repeat_weekdays from tasks where title = 'Plant care'), '{}'::int[], '... including "a while after it''s done"');
update tasks set every_unit = 'month' where title = 'Lessons';
select test.is((select repeat_weekdays from tasks where title = 'Lessons'), '{}'::int[], 'switching a weekly schedule to monthly clears its weekdays');
select test.throws($$insert into tasks (title, repeat_mode, every_count, every_unit) values ('Bad', 'schedule', 1, 'month')$$,
                   'violates check constraint', 'a repeating task needs a due date');
select test.throws($$insert into tasks (title, due_time) values ('Bad', '09:00')$$, 'violates check constraint', 'a time needs a date');
update tasks set repeat_mode = 'none' where title = 'Sheets';
select test.is((select coalesce(every_count::text, '-') || ' ' || coalesce(every_unit, '-') || ' ' || coalesce(anchor_date::text, '-')
                from tasks where title = 'Sheets'), '- - -', 'turning a repeating task into a one-off clears its repeat settings');
