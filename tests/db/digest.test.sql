-- The morning email: email_budget_left, digest_due (including both DST days), claim and
-- finish, digest_for's shape and routing (Spanish too), and day_text's wording.
\ir roles.sql
\ir fixtures.sql

-- ---------------------------------------------------------------------
-- email_budget_left: 60 a day (UTC), counting the email log and claimed notifications
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-01 12:00+00';
:as_service
select test.is(email_budget_left(), 60, 'budget: 60 on a quiet day');
:as_owner
insert into email_log (sent_by, recipients, subject, created_at)
select 'alex@example.com', '{pat@lee.example}', 'Hi', '2026-11-01 01:00+00' from generate_series(1, 5);
insert into email_log (sent_by, recipients, subject, created_at) values ('alex@example.com', '{pat@lee.example}', 'Hi', '2026-10-31 23:59+00');
insert into notification_log (person_id, local_date, kind, status, claimed_at) values
  (test.person('Alex'), '2026-11-01', 'digest', 'sent', '2026-11-01 11:30+00'),
  (test.person('Sam'), '2026-11-01', 'digest', 'sending', '2026-11-01 11:31+00'),
  (test.person('Jordan'), '2026-11-01', 'digest', 'failed', '2026-11-01 11:32+00'),
  (test.person('Morgan'), '2026-11-01', 'digest', 'skipped', '2026-11-01 11:33+00'),
  (test.person('Alex'), '2026-10-31', 'digest', 'sent', '2026-10-31 11:30+00');
:as_service
select test.is(email_budget_left(), 53, 'budget: today''s emails and sent or sending notifications count; failed, skipped and yesterday''s don''t');
:as_owner
insert into email_log (sent_by, recipients, subject, created_at)
select 'alex@example.com', '{pat@lee.example}', 'Hi', '2026-11-01 02:00+00' from generate_series(1, 70);
:as_service
select test.is(email_budget_left(), 0, 'budget: never below 0');
:as_owner
delete from email_log;
delete from notification_log;

-- ---------------------------------------------------------------------
-- digest_due: who gets an email now
-- ---------------------------------------------------------------------
-- Alex: morning email at the household time (06:30). Sam: tomorrow's plan at 20:30.
-- Morgan: email on but not confirmed (gets a confirmation email). Jordan: inactive.
update people set digest_enabled = true, email_verified_at = '2026-10-01' where name in ('Alex', 'Sam', 'Jordan');
update people set digest_day = 'tomorrow', digest_time = '20:30' where name = 'Sam';
update people set active = false where name = 'Jordan';
update people set digest_enabled = true where name = 'Morgan';
create temp view due as
  select string_agg(r, ', ' order by r) as rows
  from (select (select name from people where id = d.person_id) || ' ' || d.kind || ' ' || d.local_date as r from digest_due(50) d) due_rows;
grant select on due to service_role;

set hub.now = '2026-10-31 20:30 America/New_York';
:as_service
select test.is((select rows from due), 'Morgan confirm 2026-10-31, Sam digest 2026-11-01',
               'Oct 31 20:30: the evening-before person gets Nov 1''s plan; the morning person does not');
:as_owner
set hub.now = '2026-11-01 06:29 America/New_York';
:as_service
select test.is((select rows from due where rows like '%Alex%'), null, 'Nov 1 (fall back) 06:29: not yet');
:as_owner
set hub.now = '2026-11-01 06:30 America/New_York';
:as_service
select test.is((select rows from due), 'Alex digest 2026-11-01, Morgan confirm 2026-11-01', 'Nov 1 (fall back) 06:30: due');
select test.is(private.now(), '2026-11-01 11:30+00'::timestamptz, 'Nov 1 06:30 local is 11:30 UTC');
:as_owner
set hub.now = '2026-11-01 09:29 America/New_York';
:as_service
select test.ok((select rows from due) like '%Alex digest 2026-11-01%', 'still due within 3 hours');
:as_owner
set hub.now = '2026-11-01 09:31 America/New_York';
:as_service
select test.is((select rows from due where rows like '%Alex%'), null, 'not due after 3 hours (a missed morning is not sent at noon)');
:as_owner
set hub.now = '2027-03-13 20:30 America/New_York';
:as_service
select test.is((select rows from due where rows like '%Alex%'), null, 'Mar 13 20:30 (evening before spring forward): morning person not due');
select test.ok((select rows from due) like '%Sam digest 2027-03-14%', 'Mar 13 20:30: evening person gets Mar 14''s plan');
:as_owner
set hub.now = '2027-03-14 06:29 America/New_York';
:as_service
select test.is((select rows from due where rows like '%Alex%'), null, 'Mar 14 (spring forward) 06:29: not yet');
:as_owner
set hub.now = '2027-03-14 06:30 America/New_York';
:as_service
select test.ok((select rows from due) like '%Alex digest 2027-03-14%', 'Mar 14 (spring forward) 06:30: due');
select test.is(private.now(), '2027-03-14 10:30+00'::timestamptz, 'Mar 14 06:30 local is 10:30 UTC');
select test.is((select count(*) from digest_due(1)), 1::bigint, 'digest_due honours its limit');

-- ---------------------------------------------------------------------
-- claim_notification and finish_notification
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-01 06:30 America/New_York';
create temp table claim (id uuid);
grant all on claim to service_role;
:as_service
insert into claim select claim_notification(test.person('Alex'), '2026-11-01', 'digest');
select test.ok((select id from claim) is not null, 'claim: the first claim gets an id');
select test.is(claim_notification(test.person('Alex'), '2026-11-01', 'digest'), null, 'claim: a second claim while sending gets null');
select test.is((select rows from due where rows like '%Alex%'), null, 'digest_due leaves out an email being sent');
select finish_notification((select id from claim), 'failed', 'Resend said 500');
select test.is((select rows from due where rows like '%Alex%'), 'Alex digest 2026-11-01, Morgan confirm 2026-11-01', 'digest_due offers a failed email again');
select test.is(claim_notification(test.person('Alex'), '2026-11-01', 'digest'), (select id from claim), 'claim: a failed email can be claimed again (same row)');
select test.is((select attempts || ' ' || status || ' ' || coalesce(detail, '-') from notification_log where id = (select id from claim)), '2 sending -',
               'claim again: attempts 2, sending, detail cleared');
:as_owner
set hub.now = '2026-11-01 06:41 America/New_York';
:as_service
select test.is(claim_notification(test.person('Alex'), '2026-11-01', 'digest'), (select id from claim), 'claim: stuck in sending for over 10 minutes → retried');
select finish_notification((select id from claim), 'failed', repeat('x', 600));
select test.is((select length(detail) from notification_log where id = (select id from claim)), 500, 'finish: detail is cut to 500 characters');
select test.is(claim_notification(test.person('Alex'), '2026-11-01', 'digest'), null, 'claim: no fourth attempt');
select test.is((select rows from due where rows like '%Alex%'), null, 'digest_due leaves out an email that ran out of attempts');
insert into claim select claim_notification(test.person('Sam'), '2026-11-01', 'digest');
select finish_notification((select id from claim where id <> (select id from notification_log where person_id = test.person('Alex'))), 'sent');
select test.is(claim_notification(test.person('Sam'), '2026-11-01', 'digest'), null, 'claim: a sent email is never claimed again');
select test.ok(claim_notification(test.person('Sam'), '2026-11-01', 'confirm') is not null, 'claim: kinds are separate');
select test.throws($$select finish_notification((select id from claim limit 1), 'sending')$$, 'sent, failed or skipped', 'finish: only a final status');
select finish_notification((select id from notification_log where person_id = test.person('Sam') and kind = 'digest'), 'failed');
select test.is((select status from notification_log where person_id = test.person('Sam') and kind = 'digest'), 'sent', 'finish: only changes a row that is sending');

-- Confirmation emails: at most one every 3 days.
:as_owner
delete from notification_log;
insert into notification_log (person_id, local_date, kind, status) values (test.person('Morgan'), '2026-10-31', 'confirm', 'sent');
:as_service
select test.is((select rows from due), 'Alex digest 2026-11-01', 'confirm: not again the day after');
:as_owner
set hub.now = '2026-11-03 09:00 America/New_York';
:as_service
select test.is((select rows from due), 'Alex digest 2026-11-03, Morgan confirm 2026-11-03', 'confirm: again 3 days later');
:as_owner
delete from notification_log;
update people set active = true, digest_enabled = false, email_verified_at = null where name = 'Jordan';
update people set digest_enabled = false where name in ('Alex', 'Sam', 'Morgan');

-- ---------------------------------------------------------------------
-- A Monday for digest_for and day_text (Nov 9, 2026)
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-09 06:30 America/New_York';
insert into people (name, role, sort_order) values ('Robin', 'kid', 5);
insert into events (title, start_date, start_time, end_time, responsible_id, participant_ids, contractor_id, notes, private) values
  ('Drop off dogs', '2026-11-09', '08:00', null, test.person('Alex'), '{}', null, null, false),
  ('Team call', '2026-11-09', '10:00', '11:00', test.person('Alex'), '{}', null, null, false),
  ('Dentist', '2026-11-09', '09:00', null, test.person('Sam'), '{}', null, null, false),
  ('Pick up Taylor', '2026-11-09', '15:00', null, test.person('Morgan'), array[test.person('Taylor')], null, null, false),
  ('Piano', '2026-11-09', '16:00', '17:00', test.person('Morgan'), array[test.person('Taylor')], test.contractor('Rivera Music'), 'secret note', false),
  ('Early meeting', '2026-11-10', '07:30', null, test.person('Alex'), '{}', null, null, false),
  ('Late dinner', '2026-11-10', '19:00', null, test.person('Alex'), '{}', null, null, false);
insert into events (title, start_date) values ('Recital', '2026-11-09');
insert into events (title, start_date, participant_ids) values ('School trip', '2026-11-10', array[test.person('Taylor')]);
insert into tasks (title, responsible_id, due_date, lead_days, private) values
  ('Pay water bill', test.person('Alex'), '2026-11-09', 0, false),
  ('Book flights', null, '2026-11-09', 0, false),
  ('Trash', test.person('Taylor'), '2026-11-09', 0, false),
  ('Payday', test.person('Morgan'), '2026-11-09', 0, true),
  ('Feed fish', test.person('Taylor'), '2026-11-05', 0, false),
  ('Renew passport', test.person('Alex'), '2026-11-01', 0, false),
  ('Return library books', test.person('Alex'), '2026-11-02', 0, false),
  ('Call bank', test.person('Alex'), '2026-11-03', 0, false),
  ('Fix fence', test.person('Alex'), '2026-11-04', 0, false),
  ('Clean gutters', null, '2026-11-06', 0, false),
  ('Vet visit', test.person('Alex'), '2026-11-12', 5, false);
insert into tasks (title) values ('Fix squeaky door'), ('Sort photos');
update contractors set contract_end = '2026-11-30' where name = 'City Water';
update projects set owner_id = test.person('Alex'), task_dates = '[
  {"id": "a", "name": "Wire", "trade": "electrician", "start": "2026-11-09", "end": "2026-11-10", "days": 2, "status": ""},
  {"id": "p", "name": "Paint", "trade": "painter", "start": "2026-11-02", "end": "2026-11-12", "days": 8, "status": ""},
  {"id": "i", "name": "Inspection", "trade": "inspection", "start": "2026-11-09", "end": "2026-11-09", "days": 0, "status": "", "milestone": true}]'
where name = 'Kitchen';
create temp table d as select name, digest_for(id, '2026-11-09') as j from people;
grant select on d to public;
create function pg_temp.titles(a jsonb) returns text language sql as $$ select string_agg(x ->> 'title', ', ') from jsonb_array_elements(a) x $$;

-- ---------------------------------------------------------------------
-- day_text
-- ---------------------------------------------------------------------
:as_admin
select test.is(day_text(test.person('Taylor'), '2026-11-09'),
               E'Taylor · Mon Nov 9\n3:00pm Pick up Taylor · Morgan\n4:00pm Piano · Morgan · Rivera Music 555-0150\n☐ Trash\nLate:\n☐ Feed fish (Nov 5)',
               'day_text: someone along sees who is in charge ("Piano · Morgan"), contractor phone, tasks, late');
select test.is(day_text(test.person('Morgan'), '2026-11-09'),
               E'Morgan · lun 9 nov\n15:00 Pick up Taylor · con Taylor\n16:00 Piano · con Taylor · Rivera Music 555-0150\n☐ Asunto privado',
               'day_text: the person in charge sees "con Taylor"; Spanish words and 24-hour times; private titles hidden');
select test.is(day_text(test.person('Taylor'), '2026-11-10'), E'Taylor · Tue Nov 10\nAll day: School trip\nLate:\n☐ Feed fish (Nov 5)\n☐ Trash (Nov 9)',
               'day_text: all-day events; late counts from that day');
select test.is(day_text(test.person('Alex'), '2026-11-09'),
               E'Alex · Mon Nov 9\n8:00am Drop off dogs\n10:00am Team call\nKitchen: Inspection\nKitchen: Wire · Pat Lee 555-0100\n☐ Pay water bill\nLate:\n☐ Renew passport (Nov 1)\n☐ Return library books (Nov 2)\n☐ Call bank (Nov 3)\n+1 more'
               , 'day_text: project tasks on their first day; at most 3 late tasks, then "+N more"');
select test.is(day_text(test.person('Robin'), '2026-11-09'), E'Robin · Mon Nov 9\nNothing planned', 'day_text: an empty day');
select test.ok(day_text(test.person('Taylor'), '2026-11-09') not like '%secret%', 'day_text never includes notes');

-- ---------------------------------------------------------------------
-- digest_for: a parent
-- ---------------------------------------------------------------------
:as_service
select test.is((select (j -> 'recipient') - 'id' - 'day_token' from d where name = 'Alex'),
               '{"name": "Alex", "email": "alex@example.com", "language": "en", "role": "parent"}'::jsonb, 'parent: recipient');
select test.is((select j -> 'recipient' ->> 'day_token' from d where name = 'Alex'), test.token('Alex'), 'parent: recipient carries their My day token for links');
select test.is((select j ->> 'subject' from d where name = 'Alex'), 'Mon Nov 9: 8:00am Drop off dogs · 10:00am Team call · +1',
               'parent: the subject carries the first two items and a count');
select test.is((select pg_temp.titles(j -> 'today') from d where name = 'Alex'), 'Drop off dogs, Team call, Pay water bill', 'parent: today, timed first');
select test.is((select (j -> 'today' -> 1) - 'item_id' from d where name = 'Alex'),
               '{"kind": "event", "occurrence": "2026-11-09", "time": "10:00am", "title": "Team call", "detail": null, "contractor_phone": null, "status": "open"}'::jsonb,
               'an item: kind, item_id, occurrence, time, title, detail, contractor_phone, status');
select test.is((select pg_temp.titles(j -> 'late') || ' +' || (j ->> 'late_more') from d where name = 'Alex'),
               'Renew passport, Return library books, Call bank +1', 'parent: late, 3 at most, oldest first, and how many more');
select test.is((select j -> 'late' -> 0 ->> 'detail' from d where name = 'Alex'), 'due Nov 1', 'late items say when they were due');
select test.is((select string_agg(x ->> 'title' || ' (' || concat_ws(', ', x ->> 'time', x ->> 'detail') || ')', ', ')
                from d, jsonb_array_elements(j -> 'heads_up') x where name = 'Alex'),
               'Early meeting (Tomorrow 7:30am), Vet visit (due Nov 12), City Water (contract ends Nov 30)',
               'parent: heads-up has tomorrow before 9am, lead-time tasks and contract ends');
select test.is((select string_agg(x ->> 'name' || ' ' || (x ->> 'count') || ' ' || coalesce(x ->> 'phone', '-'), ', ') from d, jsonb_array_elements(j -> 'people') x where name = 'Alex'),
               'Taylor 3 555-0103, Morgan 3 555-0104, Robin 0 -', 'parent: a block per kid and helper, in the household''s order');
select test.is((select x ->> 'text' from d, jsonb_array_elements(j -> 'people') x where name = 'Alex' and x ->> 'name' = 'Morgan'),
               day_text(test.person('Morgan'), '2026-11-09'), 'parent: each block''s text is day_text, in that person''s language');
select test.is((select pg_temp.titles(j -> 'nobody') || ' +' || (j ->> 'nobody_more') from d where name = 'Alex'), 'Recital, Book flights, Clean gutters +0',
               'parent: nobody''s on it has today''s unassigned items, then unassigned late tasks');
select test.is((select j -> 'projects' -> 0 ->> 'text' from d where name = 'Alex'), 'Kitchen: Inspection; Wire starts (Pat Lee 555-0100)',
               'parent: one line per project with tasks starting today (ongoing ones left out)');
select test.is((select j ->> 'inbox_count' from d where name = 'Alex'), '2', 'parent: on Mondays, how many tasks have no date');
select test.is((select j -> 'labels' ->> 'inbox' from d where name = 'Alex'), 'Inbox: 2 tasks with no date', 'parent: the inbox line');
select test.is((select j -> 'labels' ->> 'late_more' from d where name = 'Alex'), 'and 1 more', 'labels: and N more');
select test.is(digest_for(test.person('Alex'), '2026-11-10') -> 'inbox_count', 'null'::jsonb, 'parent: no inbox line on other days');
select test.is((select (j -> 'empty')::text from d where name = 'Alex'), 'false', 'a parent''s email is never empty');
select test.is(jsonb_path_exists((select j from d where name = 'Alex'), '$.**.notes') or (select j::text from d where name = 'Alex') like '%secret%',
               false, 'no notes anywhere in the email');

-- A parent who isn't the project's owner, with everyone's items.
:as_owner
update people set digest_scope = 'everyone' where name = 'Jordan';
:as_service
select test.is(pg_temp.titles(digest_for(test.person('Jordan'), '2026-11-09') -> 'today'),
               'Drop off dogs, Dentist, Team call, Pick up Taylor, Piano, Pay water bill, Payday, Trash',
               'parent with everyone: every assigned item (unassigned ones are in nobody''s on it)');
select test.is(digest_for(test.person('Jordan'), '2026-11-09') -> 'projects', '[]'::jsonb, 'project lines go to the project''s owner');
select test.is(pg_temp.titles(digest_for(test.person('Jordan'), '2026-11-09') -> 'late'), 'Renew passport, Return library books, Call bank',
               'parent with everyone: everybody''s late tasks');

-- ---------------------------------------------------------------------
-- digest_for: kids, helpers and adults
-- ---------------------------------------------------------------------
select test.is((select pg_temp.titles(j -> 'today') from d where name = 'Taylor'), 'Pick up Taylor, Piano, Trash', 'kid: their own items');
select test.is((select j -> 'today' -> 1 ->> 'detail' || ' | ' || (j -> 'today' -> 1 ->> 'contractor_phone') from d where name = 'Taylor'),
               'Morgan · Rivera Music | 555-0150', 'kid: detail says who is in charge and the contractor; phone separate');
select test.is((select (j -> 'people')::text || (j -> 'nobody')::text || (j -> 'projects')::text || coalesce(j ->> 'inbox_count', 'none') from d where name = 'Taylor'),
               '[][][]none', 'kid: no parent sections');
select test.is((select (j -> 'empty')::text from d where name = 'Taylor'), 'false', 'kid with items: not empty');
select test.is((select (j -> 'empty')::text from d where name = 'Robin'), 'true', 'kid with nothing: empty (no email is sent)');
select test.is((select pg_temp.titles(j -> 'today') from d where name = 'Sam'), 'Dentist', 'adult: their own items');
select test.is((select j -> 'people' from d where name = 'Sam'), '[]'::jsonb, 'adult: no kid blocks');

select test.is((select j ->> 'subject' from d where name = 'Morgan'), 'lun 9 nov: 15:00 Pick up Taylor · 16:00 Piano · +1', 'Spanish: subject');
select test.is((select pg_temp.titles(j -> 'today') from d where name = 'Morgan'), 'Pick up Taylor, Piano, Asunto privado',
               'Spanish: a helper sees private items as "Asunto privado"; titles stay as typed');
select test.is((select j -> 'today' -> 0 ->> 'detail' from d where name = 'Morgan'), 'con Taylor', 'Spanish: con');
select test.is((select j -> 'labels' ->> 'today' || ' / ' || (j -> 'labels' ->> 'late') || ' / ' || (j -> 'labels' ->> 'heads_up') || ' / ' || (j ->> 'date_label')
                from d where name = 'Morgan'), 'Hoy / Atrasado / Atención / lun 9 nov', 'Spanish: fixed words and dates');
select test.is(pg_temp.titles(digest_for(test.person('Jordan'), '2026-11-09') -> 'today') like '%Payday%', true, 'parents see private titles');

-- A project whose owner isn't a parent goes to every parent, like one with no owner
-- (only parents get project lines, so otherwise nobody would hear about it).
:as_owner
insert into projects (name, owner_id, task_dates)
values ('Deck', test.person('Sam'), '[{"id": "f", "name": "Footings", "start": "2026-11-09", "end": "2026-11-09", "days": 1, "status": ""}]');
:as_service
select test.is((select string_agg(x ->> 'text', ' | ') from jsonb_array_elements(digest_for(test.person('Jordan'), '2026-11-09') -> 'projects') x),
               'Deck: Footings starts', 'a project owned by an adult goes to every parent');
select test.is((select string_agg(x ->> 'name', ', ' order by x ->> 'name') from jsonb_array_elements(digest_for(test.person('Alex'), '2026-11-09') -> 'projects') x),
               'Deck, Kitchen', '... including the parent who owns another project');

-- The evening-before email is read the day before the day it is about: that day is
-- "Tomorrow", and the next morning's early items are named by their day.
:as_owner
update people set digest_day = 'tomorrow', digest_time = '20:30' where name = 'Alex';
:as_service
select test.is(digest_for(test.person('Alex'), '2026-11-09') -> 'labels' ->> 'today', 'Tomorrow', 'evening email: the day it is about is "Tomorrow"');
select test.is((select x ->> 'time' from jsonb_array_elements(digest_for(test.person('Alex'), '2026-11-09') -> 'heads_up') x where x ->> 'title' = 'Early meeting'),
               'Tue Nov 10 7:30am', 'evening email: an early item the morning after says which day, not "Tomorrow"');
:as_owner
update people set digest_day = 'today', digest_time = null where name = 'Alex';
:as_service

select test.is(digest_for(gen_random_uuid(), '2026-11-09'), null, 'unknown person → null');
:as_owner
update people set active = false where name = 'Robin';
:as_service
select test.is(digest_for(test.person('Robin'), '2026-11-09'), null, 'inactive person → null');
