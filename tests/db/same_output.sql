-- A household for run.sh's same-output check (step 5b), loaded into a database with migration 0002
-- only (all fictional). run.sh copies it, applies the later migrations to the copy, and compares
-- digest_for, day_text and get_person_day for every person and every day from Oct 25 to Nov 7,
-- 2026 (the clock goes back on Nov 1). No Google calendar is set up, so 0003's replaced functions
-- must give exactly what 0002's did.
-- On top of fixtures.sql: a parent with everyone's items, an evening-before email, an inactive
-- kid, weekly events with one-day changes, a missed weekly task, private and health items, a
-- project with three jobs, a contract ending, and items on both sides of the clock change.
\ir roles.sql
\ir fixtures.sql

:as_owner
insert into members (email, name, role) values ('jordan@example.com', 'Jordan', 'admin');
update people set digest_scope = 'everyone' where name = 'Jordan';
update people set digest_day = 'tomorrow', digest_time = '20:30' where name = 'Sam';
insert into people (name, role, sort_order, active) values ('Robin', 'kid', 5, false);
update household set pets_owner_id = test.person('Taylor'), house_owner_id = test.person('Sam'), days_off = '{2026-11-06}';
update contractors set contract_end = '2026-11-20' where name = 'City Water';

insert into events (title, start_date, start_time, end_time, responsible_id, participant_ids, contractor_id, notes,
                    location, repeat, repeat_weekdays, skip_days_off) values
  ('Piano', '2026-10-06', '16:00', '17:00', test.person('Morgan'), array[test.person('Taylor')], test.contractor('Rivera Music'),
   'Bring the book', '12 Elm St', 'weekly', '{2}', false),
  ('Swim', '2026-10-03', '09:00', null, test.person('Taylor'), '{}', null, null, null, 'weekly', '{6}', false),
  ('School run', '2026-10-05', '07:45', '08:15', test.person('Alex'), array[test.person('Taylor'), test.person('Robin')], null, null,
   null, 'weekly', '{1,3,5}', true);
insert into event_changes (event_id, on_date, cancelled, start_time, end_time, responsible_id, note) values
  (test.event('Piano'), '2026-10-27', false, '15:30', '16:30', null, 'Side door'),
  (test.event('Piano'), '2026-11-03', true, null, null, null, null),
  (test.event('Swim'), '2026-10-31', false, null, null, test.person('Alex'), null);
insert into events (title, start_date, end_date, start_time, end_time, ends_next_day, responsible_id, participant_ids, private) values
  ('School trip', '2026-10-30', null, null, null, false, null, array[test.person('Taylor')], false),
  ('Trip', '2026-11-05', '2026-11-07', null, null, false, test.person('Alex'), array[test.person('Jordan')], false),
  ('Doctor', '2026-10-28', null, '10:00', null, false, test.person('Sam'), '{}', true),
  ('Recital', '2026-11-02', null, '18:00', null, false, null, '{}', false),
  ('Night flight', '2026-11-01', null, '01:30', null, false, test.person('Alex'), '{}', false),
  ('Late show', '2026-10-31', null, '22:00', '01:00', true, test.person('Jordan'), array[test.person('Alex')], false),
  ('Early meeting', '2026-11-03', null, '07:30', null, false, test.person('Alex'), '{}', false),
  ('Robin''s match', '2026-11-04', null, '17:00', null, false, test.person('Robin'), array[test.person('Taylor')], false);

insert into tasks (title, responsible_id, due_date, due_time, lead_days, private, category, contractor_id, repeat_mode,
                   every_count, every_unit, repeat_weekdays) values
  ('Trash', test.person('Taylor'), '2026-10-19', null, 0, false, 'home', null, 'schedule', 1, 'week', '{1}'),
  ('Heartworm pill', test.person('Morgan'), '2026-11-01', null, 2, false, 'pets', null, 'schedule', 1, 'month', '{}'),
  ('Change filter', test.person('Sam'), '2026-11-02', null, 0, false, 'home', null, 'after_done', 60, 'day', '{}');
insert into tasks (title, responsible_id, due_date, due_time, lead_days, private, category, contractor_id) values
  ('Pay water bill', test.person('Alex'), '2026-10-29', null, 3, false, 'home', test.contractor('City Water')),
  ('Call plumber', null, '2026-10-28', null, 0, false, 'home', null),
  ('Payday', test.person('Morgan'), '2026-10-30', null, 0, true, 'other', null),
  ('Allergy shot', test.person('Taylor'), '2026-11-04', '08:00', 0, false, 'health', null),
  ('Book flights', test.person('Alex'), '2026-11-02', '07:30', 0, false, 'family', null),
  ('Order tiles', test.person('Alex'), '2026-11-02', null, 0, false, 'home', null),
  ('Tidy room', test.person('Robin'), '2026-10-26', null, 0, false, 'other', null),
  ('Feed fish', test.person('Taylor'), '2026-10-24', null, 0, false, 'pets', null);
insert into tasks (title, responsible_id, due_date, done_at, done_by) values
  ('Return books', test.person('Taylor'), '2026-10-27', '2026-10-27 12:00+00', 'alex@example.com');
insert into tasks (title) values ('Fix squeaky door');

update projects set owner_id = test.person('Alex'), task_dates = '[
  {"id": "a", "name": "Wire", "trade": "electrician", "start": "2026-11-02", "end": "2026-11-03", "days": 2, "status": ""},
  {"id": "p", "name": "Paint", "trade": "painter", "start": "2026-10-28", "end": "2026-11-05", "days": 6, "status": ""},
  {"id": "i", "name": "Inspection", "trade": "inspection", "start": "2026-11-02", "end": "2026-11-02", "days": 0, "status": "", "milestone": true}]'
where name = 'Kitchen';
