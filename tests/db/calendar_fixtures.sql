-- The household of docs/v1.1-google-calendar.md for calendar.test.sql (all fictional), on the
-- clock tests/realdb uses: Tue 2026-10-27, 9:00 in New York. Include after roles.sql.
-- Already there from v1_data.sql and migration 0002's seeding: Alex (parent, admin), Sam (adult,
-- member), Pat Lee (contractor) and the Kitchen project. Added here:
--   Morgan  parent, admin (no Google calendar)
--   Jordan  kid
--   Taylor  helper, speaks Spanish
--   Rivera Music (a service) and City Water (an account with an account number)
--   household: pets owned by Taylor, the house by Sam
-- Google calendars: writing ones for Alex, Jordan and Taylor, Pets labelled "Dogs", House and
-- Family; and the family account's main calendar, read only. Sam and Morgan have none. Every
-- calendar is ok, seen with the right access role and approved (Start copying).
-- Items (the window is Oct 26 to Dec 26):
--   events  Piano (Taylor with Jordan, Tuesdays 4pm, Nov 10 cancelled, a day note on Nov 3),
--           Swim (Alex with Jordan, Saturdays 9am), Family dinner (Alex with Morgan, Sam, Jordan
--           and Taylor), Recital (nobody), Carpool (nobody in charge; Jordan and Taylor along),
--           Dentist (Morgan with Jordan), Surprise party (Alex, private), Gym (Sam), Trip (Alex,
--           3 days), Night flight (Alex, 01:30 on the day the clock goes back)
--   tasks   Heartworm pill (Taylor, pets), Walk dogs (Alex, pets), Nail trim (nobody, pets),
--           Furnace filter (nobody, home), Call plumber (nobody), Allergy pills (Jordan, health),
--           Pay water bill (Alex, 9:30am), Return books (Alex, done); late: Trash (Jordan, weekly,
--           missed Monday), Feed fish (Jordan), Water plants (Taylor), Payday (Taylor, private)
--   projects Kitchen (Alex): Demo (done), Paint (Nov 2-12), Wire (Nov 9-10), Inspection (Nov 9,
--           milestone); Deck (no owner): Footings (Nov 16)
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';
insert into members (email, name, role) values ('morgan@example.com', 'Morgan', 'admin');
update people set phone = '555-0102', sort_order = 0 where name = 'Alex';
update people set phone = '555-0106', sort_order = 2 where name = 'Sam';
insert into people (name, role, email, phone, language, sort_order) values
  ('Morgan', 'parent', 'morgan@example.com', '555-0105', 'en', 1),
  ('Jordan', 'kid', null, '555-0103', 'en', 3),
  ('Taylor', 'helper', null, '555-0104', 'es', 4);
update household set pets_owner_id = test.person('Taylor'), house_owner_id = test.person('Sam');
insert into contractors (name, company, phone, kind) values
  ('Rivera Music', 'Rivera Music', '555-0150', 'service'),
  ('City Water', null, '555-0160', 'account');
insert into contractor_secrets (contractor_id, account_number, account_name)
values (test.contractor('City Water'), '0000-1111-2222', 'Alex Example');

insert into calendars (google_id, kind, person_id, label, writes, status, access_role, google_name, copy_approved_at, read_at, checked_at)
values
  ('hub-alex@group.calendar.google.com',   'person', test.person('Alex'),   'Alex',   true,  'ok', 'writer', 'Hub – Alex',   '2026-10-26', '2026-10-27 12:55+00', '2026-10-27 12:55+00'),
  ('hub-jordan@group.calendar.google.com', 'person', test.person('Jordan'), 'Jordan', true,  'ok', 'writer', 'Hub – Jordan', '2026-10-26', '2026-10-27 12:55+00', '2026-10-27 12:55+00'),
  ('hub-taylor@group.calendar.google.com', 'person', test.person('Taylor'), 'Taylor', true,  'ok', 'writer', 'Hub – Taylor', '2026-10-26', '2026-10-27 12:55+00', '2026-10-27 12:55+00'),
  ('hub-pets@group.calendar.google.com',   'pets',   null,                  'Dogs',   true,  'ok', 'writer', 'Hub – Pets',   '2026-10-26', '2026-10-27 12:55+00', '2026-10-27 12:55+00'),
  ('hub-house@group.calendar.google.com',  'house',  null,                  'House',  true,  'ok', 'writer', 'Hub – House',  '2026-10-26', '2026-10-27 12:55+00', '2026-10-27 12:55+00'),
  ('hub-family@group.calendar.google.com', 'family', null,                  'Family', true,  'ok', 'writer', 'Hub – Family', '2026-10-26', '2026-10-27 12:55+00', '2026-10-27 12:55+00'),
  ('family@example.com',                   'family', null,                  'Family account', false, 'ok', 'reader', 'Family', null, '2026-10-27 12:55+00', '2026-10-27 12:55+00');
update calendar_sync set auth = 'service_account', account = 'home-hub-sync@example.com', key_id = 'k0000000a1b2c3',
                         last_run_at = '2026-10-27 12:55+00', last_ok_at = '2026-10-27 12:55+00';

insert into events (title, start_date, end_date, start_time, end_time, responsible_id, participant_ids, contractor_id, location,
                    notes, private, repeat, repeat_weekdays) values
  ('Piano', '2026-10-27', null, '16:00', '17:00', test.person('Taylor'), array[test.person('Jordan')], test.contractor('Rivera Music'),
   'Rivera Music, 12 Elm St', 'Bring the green book', false, 'weekly', '{2}'),
  ('Swim', '2026-10-31', null, '09:00', '10:00', test.person('Alex'), array[test.person('Jordan')], null, 'Pool', null, false, 'weekly', '{6}'),
  ('Family dinner', '2026-10-31', null, '18:00', null, test.person('Alex'),
   array[test.person('Morgan'), test.person('Sam'), test.person('Jordan'), test.person('Taylor')], null, null, null, false, 'none', '{}'),
  ('Recital', '2026-11-02', null, null, null, null, '{}', null, 'School hall', null, false, 'none', '{}'),
  ('Carpool', '2026-10-29', null, '08:00', null, null, array[test.person('Jordan'), test.person('Taylor')], null, null, null, false, 'none', '{}'),
  ('Dentist', '2026-11-04', null, '10:00', null, test.person('Morgan'), array[test.person('Jordan')], null, null, null, false, 'none', '{}'),
  ('Surprise party', '2026-11-07', null, '19:00', null, test.person('Alex'), '{}', null, '4 Oak Lane', 'Gate code 4321', true, 'none', '{}'),
  ('Gym', '2026-10-28', null, '07:00', null, test.person('Sam'), '{}', null, null, null, false, 'none', '{}'),
  ('Trip', '2026-11-13', '2026-11-15', null, null, test.person('Alex'), '{}', null, null, null, false, 'none', '{}'),
  ('Night flight', '2026-11-01', null, '01:30', null, test.person('Alex'), '{}', null, null, null, false, 'none', '{}');
insert into event_changes (event_id, on_date, cancelled, note) values
  (test.event('Piano'), '2026-11-10', true, null),
  (test.event('Piano'), '2026-11-03', false, 'Side door, code 1234');

insert into tasks (title, responsible_id, due_date, due_time, category, private, contractor_id, notes) values
  ('Walk dogs', test.person('Alex'), '2026-10-28', null, 'pets', false, null, null),
  ('Nail trim', null, '2026-10-30', null, 'pets', false, null, null),
  ('Furnace filter', null, '2026-11-05', null, 'home', false, null, null),
  ('Call plumber', null, '2026-10-28', null, 'other', false, null, null),
  ('Allergy pills', test.person('Jordan'), '2026-10-29', null, 'health', false, null, null),
  ('Pay water bill', test.person('Alex'), '2026-10-28', '09:30', 'home', false, test.contractor('City Water'), 'Account on file'),
  ('Feed fish', test.person('Jordan'), '2026-10-20', null, 'other', false, null, null),
  ('Water plants', test.person('Taylor'), '2026-10-25', null, 'home', false, null, null),
  ('Payday', test.person('Taylor'), '2026-10-24', null, 'other', true, null, null);
insert into tasks (title, responsible_id, due_date, category, repeat_mode, every_count, every_unit, repeat_weekdays) values
  ('Heartworm pill', test.person('Taylor'), '2026-11-01', 'pets', 'schedule', 1, 'month', '{}'),
  ('Trash', test.person('Jordan'), '2026-10-26', 'other', 'schedule', 1, 'week', '{1}');
insert into tasks (title, responsible_id, due_date, done_at, done_by) values
  ('Return books', test.person('Alex'), '2026-10-29', '2026-10-27 12:00+00', 'alex@example.com');

update projects set owner_id = test.person('Alex'), task_dates = '[
  {"id": "d", "name": "Demo", "trade": "electrician", "start": "2026-10-28", "end": "2026-10-28", "days": 1, "status": "done"},
  {"id": "p", "name": "Paint", "trade": "painter", "start": "2026-11-02", "end": "2026-11-12", "days": 8, "status": ""},
  {"id": "a", "name": "Wire", "trade": "electrician", "start": "2026-11-09", "end": "2026-11-10", "days": 2, "status": ""},
  {"id": "i", "name": "Inspection", "trade": "inspection", "start": "2026-11-09", "end": "2026-11-09", "days": 0, "status": "", "milestone": true}]'
where name = 'Kitchen';
insert into projects (name, status, task_dates)
values ('Deck', 'active', '[{"id": "f", "name": "Footings", "start": "2026-11-16", "end": "2026-11-16", "days": 1, "status": ""}]');
