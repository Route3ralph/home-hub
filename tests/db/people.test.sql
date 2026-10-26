-- The family list (save_person, remove_person, rotate_day_token) and the My day token
-- functions (get_person_day, complete_by_token, confirm_digest, stop_digest).
\ir roles.sql
\ir fixtures.sql

-- ---------------------------------------------------------------------
-- save_person
-- ---------------------------------------------------------------------
:as_adult
select test.throws($$select save_person('{"name": "Robin", "role": "kid"}', false)$$, 'Only an admin', 'adults cannot change the family list');
:as_removed
select test.throws($$select save_person('{"name": "Robin", "role": "kid"}', false)$$, 'Only an admin', 'a removed member cannot either');

:as_admin
select test.is((select name || ' ' || role || ' ' || (day_token ~ '^[0-9a-f]{32}$') from save_person('{"name": "  Robin ", "role": "kid", "phone": " 555-0105 "}', false)),
               'Robin kid true', 'admin adds a kid: name trimmed, a 32-hex My day token');
select test.is((select phone || ' ' || color || ' ' || language || ' ' || digest_enabled from people where name = 'Robin'), '555-0105 #64748b en false',
               'new people get the defaults');
select test.throws($$select save_person('{"name": "Robin 2", "role": "kid"}', true)$$, 'Only parents and adults can sign in', 'kids cannot sign in');
select test.throws($$select save_person('{"name": "Helper 2", "role": "helper", "email": "h2@example.com"}', true)$$, 'Only parents and adults can sign in', 'helpers cannot sign in');
select test.throws($$select save_person('{"name": "Casey", "role": "adult"}', true)$$, 'Add an email address', 'sign-in needs an email');
select test.throws($$select save_person('{"name": "Casey", "role": "adult", "email": "casey@example.com", "active": false}', true)$$, 'isn''t active', 'sign-in needs an active person');
select test.throws($$select save_person('{"name": "Casey", "role": "boss"}', false)$$, 'violates check constraint', 'roles are checked');
select test.throws($$select save_person('"Casey"', false)$$, 'needs a person', 'p must be an object');
select test.throws($$select save_person('{"name": "Sam 2", "role": "adult", "email": "SAM@example.com"}', false)$$,
                   'already has that email', 'emails are unique on the family list');

select save_person('{"name": "Casey", "role": "adult", "email": " Casey@Example.com ", "digest_scope": "everyone"}', true);
select test.is((select email || ' ' || digest_scope from people where name = 'Casey'), 'casey@example.com mine',
               'email lowercased; only parents can get everyone''s items');
select test.is((select name || ' ' || role from members where email = 'casey@example.com'), 'Casey member', 'an adult who can sign in is a member');
select save_person('{"name": "Riley", "role": "parent", "email": "riley@example.com"}', true);
select test.is((select role from members where email = 'riley@example.com'), 'admin', 'a parent who can sign in is an admin');

-- Changing someone: keys left out keep their value; members follows.
:as_owner
update people set email_verified_at = now(), phone = '555-0106' where name = 'Casey';
:as_admin
select save_person(jsonb_build_object('id', test.person('Casey'), 'name', 'Casey Example'), true);
select test.is((select name || ' ' || email || ' ' || phone || ' ' || (email_verified_at is not null) from people where id = test.person('Casey Example')),
               'Casey Example casey@example.com 555-0106 true', 'a partial change keeps the other fields');
select test.is((select name from members where email = 'casey@example.com'), 'Casey Example', 'members.name follows');
select save_person(jsonb_build_object('id', test.person('Casey Example'), 'email', 'casey.e@example.com'), true);
select test.is((select string_agg(email, ' ' order by email) from members where email like 'casey%'), 'casey.e@example.com',
               'an email change moves the sign-in');
select test.is((select email_verified_at from people where id = test.person('Casey Example')), null, 'an email change clears email_verified_at');
select save_person(jsonb_build_object('id', test.person('Casey Example'), 'role', 'parent'), true);
select test.is((select role from members where email = 'casey.e@example.com'), 'admin', 'adult → parent makes them an admin');
select save_person(jsonb_build_object('id', test.person('Casey Example'), 'digest_scope', 'everyone'), true);
:as_owner
create temp table casey_link as select day_token from people where name = 'Casey Example';
grant all on casey_link to public;
:as_admin
select save_person(jsonb_build_object('id', test.person('Casey Example')), false);
select test.is((select count(*) from members where email = 'casey.e@example.com'), 0::bigint, 'sign-in off removes the members row');
select test.is((select count(*) from people where id = test.person('Casey Example')), 1::bigint, '... and keeps the person');
-- Taking sign-in away takes away what came with it: everyone's items in the morning email,
-- and the My day link they could copy while signed in.
select test.is((select digest_scope from people where name = 'Casey Example'), 'mine', '... and everyone''s items in their morning email');
select test.ok((select day_token from people where name = 'Casey Example') <> (select day_token from casey_link), '... and gives them a new My day link');
:as_owner
update casey_link set day_token = (select day_token from people where name = 'Casey Example');
:as_admin
select save_person(jsonb_build_object('id', test.person('Casey Example'), 'digest_scope', 'everyone'), false);
select test.is((select digest_scope || ' ' || (day_token = (select day_token from casey_link)) from people where name = 'Casey Example'), 'everyone true',
               'a parent without sign-in can still choose everyone''s items, and saving them again keeps their link');
select save_person(jsonb_build_object('id', test.person('Robin'), 'day_token', repeat('a', 32), 'email_verified_at', '2026-01-01'), false);
select test.is((select day_token <> repeat('a', 32) and email_verified_at is null from people where name = 'Robin'), true,
               'the client cannot set day_token or email_verified_at');
select test.throws($$select save_person('{"id": "00000000-0000-0000-0000-000000000000", "name": "Ghost"}', false)$$,
                   'no longer on the family list', 'unknown id');

-- A v1 sign-in for someone who is then added without sign-in is removed.
:as_owner
insert into members (email, name, role) values ('quinn@example.com', 'Quinn', 'member');
:as_admin
select save_person('{"name": "Quinn", "role": "adult", "email": "quinn@example.com"}', false);
select test.is((select count(*) from members where email = 'quinn@example.com'), 0::bigint, 'adding someone without sign-in removes an old v1 sign-in');

-- Your own sign-in.
select test.throws($$select save_person(jsonb_build_object('id', test.person('Alex')), false)$$, 'your own sign-in', 'cannot turn off your own sign-in');
select test.throws($$select save_person(jsonb_build_object('id', test.person('Alex'), 'email', 'alex2@example.com'), true)$$, 'your own sign-in', 'cannot change your own email');
select test.throws($$select save_person(jsonb_build_object('id', test.person('Alex'), 'role', 'adult'), true)$$, 'your own sign-in', 'cannot demote yourself');
select test.throws($$select save_person(jsonb_build_object('id', test.person('Alex'), 'active', false), true)$$, 'isn''t active', 'cannot deactivate yourself');
select save_person(jsonb_build_object('id', test.person('Alex'), 'name', 'Alex Example', 'digest_scope', 'everyone'), true);
select test.is((select p.name || ' ' || p.digest_scope || ' ' || m.name || ' ' || m.role from people p join members m on m.email = p.email where p.email = 'alex@example.com'),
               'Alex Example everyone Alex Example admin', 'you can change your own name and settings');

-- ---------------------------------------------------------------------
-- remove_person and rotate_day_token
-- ---------------------------------------------------------------------
:as_adult
insert into events (title, start_date, participant_ids, responsible_id) values ('Zoo trip', '2026-11-14', array[test.person('Riley'), test.person('Taylor')], test.person('Sam'));
select test.throws($$select remove_person(test.person('Riley'))$$, 'Only an admin', 'adults cannot remove people');
:as_admin
select remove_person(test.person('Riley'));
select test.is((select count(*) from people where name = 'Riley') + (select count(*) from members where email = 'riley@example.com'), 0::bigint,
               'remove_person removes the person and their sign-in');
select test.is((select participant_ids = array[test.person('Taylor')] from events where title = 'Zoo trip'), true, 'and takes them off events');
select test.throws($$select remove_person(test.person('Alex Example'))$$, 'can''t remove yourself', 'cannot remove yourself');

-- A day someone was covering doesn't go back to the usual person when they're removed:
-- nobody is in charge that day, so it shows under "Nobody's on it".
:as_adult
insert into events (title, start_date, start_time, repeat, responsible_id, participant_ids)
values ('Swim class', '2026-11-03', '16:00', 'weekly', test.person('Morgan'), array[test.person('Taylor')]);
:as_admin
select save_person('{"name": "Grandpa Pat", "role": "adult"}', false);
:as_adult
insert into event_changes (event_id, on_date, responsible_id, note) values (test.event('Swim class'), '2026-11-17', test.person('Grandpa Pat'), 'Morgan is off');
:as_admin
select remove_person(test.person('Grandpa Pat'));
:as_adult
select test.is((select coalesce(responsible_id::text, 'nobody') || ' ' || changed from agenda('2026-11-17', '2026-11-17') where title = 'Swim class'),
               'nobody true', 'removing someone who covered a day leaves nobody in charge that day, not the usual person');
select test.ok(day_text(test.person('Morgan'), '2026-11-17') not like '%Swim class%', '... so it isn''t back on Morgan''s day off');
select test.is((select responsible_id = test.person('Morgan') from agenda('2026-11-10', '2026-11-10') where title = 'Swim class'), true,
               '... the other days are as usual');
update event_changes set responsible_id = test.person('Sam') where event_id = test.event('Swim class') and on_date = '2026-11-17';
select test.is((select responsible_id = test.person('Sam') from agenda('2026-11-17', '2026-11-17') where title = 'Swim class'), true,
               '... someone can be put in charge of that day');
update event_changes set responsible_id = null where event_id = test.event('Swim class') and on_date = '2026-11-17';
select test.is((select responsible_id = test.person('Morgan') from agenda('2026-11-17', '2026-11-17') where title = 'Swim class'), true,
               '... or it can go back to the usual person');
delete from events where title = 'Swim class';

:as_adult
select test.throws($$select rotate_day_token(test.person('Taylor'))$$, 'Only an admin', 'adults cannot make a new My day link');
:as_owner
create temp table old_token as select test.token('Taylor') as token;
grant select on old_token to public;
:as_admin
select test.ok(rotate_day_token(test.person('Taylor')) ~ '^[0-9a-f]{32}$', 'rotate_day_token returns a new 32-hex token');
:as_anon
select test.is(get_person_day((select token from old_token)), null, 'the old link stops working');
select test.is(get_person_day(test.token('Taylor')) -> 'person' ->> 'name', 'Taylor', 'the new link works');

-- ---------------------------------------------------------------------
-- My day (anon, by token)
-- ---------------------------------------------------------------------
:as_owner
set hub.now = '2026-11-09 08:00-05';
insert into events (title, start_date, start_time, end_time, repeat, responsible_id, participant_ids, contractor_id, notes, location) values
  ('Piano', '2026-11-02', '16:00', '17:00', 'weekly', test.person('Morgan'), array[test.person('Taylor')], test.contractor('Rivera Music'), 'secret note', 'Music school'),
  ('Chess', '2026-11-03', '15:00', null, 'weekly', test.person('Taylor'), '{}', null, null, null),
  ('Dentist', '2026-11-09', '09:00', null, 'none', test.person('Sam'), '{}', null, null, null);
insert into event_changes (event_id, on_date, cancelled) values (test.event('Chess'), '2026-11-10', true);
insert into events (title, start_date, participant_ids, private) values ('Gift shopping', '2026-11-10', array[test.person('Taylor')], true);
insert into tasks (title, responsible_id, due_date, notes) values
  ('Homework', test.person('Taylor'), '2026-11-10', 'secret note'),
  ('Feed fish', test.person('Taylor'), '2026-11-05', null),
  ('Sam''s errand', test.person('Sam'), '2026-11-09', null);
insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit)
values ('Trash', test.person('Taylor'), '2026-11-09', 'schedule', 1, 'week');

:as_anon
select test.is(get_person_day(repeat('0', 32)), null, 'unknown token → null');
select test.is(get_person_day('not-a-token'), null, 'malformed token → null');
select test.is(get_person_day(null), null, 'no token → null');
select test.is(get_person_day(test.token('Taylor')) -> 'person', '{"name": "Taylor", "language": "en", "digest_enabled": false, "email_confirmed": false}'::jsonb,
               'person: name, language, email settings only');
select test.is(get_person_day(test.token('Taylor')) ->> 'today', '2026-11-09', 'today comes from the household clock');
select test.is((select string_agg(d ->> 'day' || ': ' || coalesce((select string_agg(i ->> 'title', ', ') from jsonb_array_elements(d -> 'items') i), ''), ' | ')
                from jsonb_array_elements(get_person_day(test.token('Taylor')) -> 'days') d),
               '2026-11-09: Piano, Trash | 2026-11-10: Private item, Homework',
               'today and tomorrow: their items in order; private titles hidden; cancelled days left out');
select test.is((select string_agg(i ->> 'title', ', ') from jsonb_array_elements(get_person_day(test.token('Taylor')) -> 'late') i), 'Feed fish', 'late: their open past-due tasks');
select test.is((get_person_day(test.token('Taylor')) -> 'days' -> 0 -> 'items' -> 0) - 'item_id',
               '{"kind": "event", "occurrence": "2026-11-09", "day": "2026-11-09", "end_day": "2026-11-09", "title": "Piano", "all_day": false,
                 "start_time": "16:00", "end_time": "17:00", "time_label": "4:00pm", "location": "Music school",
                 "contractor_name": "Rivera Music", "contractor_phone": "555-0150", "note": null, "status": "open", "mine": false}'::jsonb,
               'an item has exactly the page''s fields');
select test.is(get_person_day(test.token('Taylor')) -> 'days' -> 0 -> 'items' -> 1 ->> 'mine', 'true', 'their own tasks are marked mine');
select test.is(jsonb_path_exists(get_person_day(test.token('Taylor')), '$.**.notes'), false, 'no notes key anywhere');
select test.is(get_person_day(test.token('Taylor'))::text like '%secret note%', false, 'no notes text anywhere');
select test.is(get_person_day(test.token('Taylor'))::text like '%Dentist%' or get_person_day(test.token('Taylor'))::text like '%errand%', false,
               'no other people''s items');
select test.is((select string_agg(i ->> 'time_label', ', ') from jsonb_array_elements(get_person_day(test.token('Morgan')) -> 'days' -> 0 -> 'items') i),
               '16:00', 'Spanish speakers get 24-hour times');

-- complete_by_token: only tasks they're in charge of.
select test.is(complete_by_token(repeat('0', 32), test.task('Trash'), '2026-11-09'), null, 'complete_by_token: unknown token → null');
select test.throws($$select complete_by_token(test.token('Taylor'), test.task('Sam''s errand'), '2026-11-09')$$, 'isn''t on your list',
                   'complete_by_token: not their task');
select test.throws($$select complete_by_token(test.token('Morgan'), test.task('Trash'), '2026-11-09')$$, 'isn''t on your list',
                   'complete_by_token: someone else''s token');
select test.ok(complete_by_token(test.token('Taylor'), test.task('Trash'), '2026-11-09') is not null, 'complete_by_token: their task');
select test.throws($$select complete_by_token(test.token('Taylor'), test.task('Trash'), '2026-11-09')$$, 'already completed', 'complete_by_token: a double tap');
select complete_by_token(test.token('Taylor'), test.task('Homework'), null);
:as_owner
select test.is((select due_date from tasks where title = 'Trash'), '2026-11-16'::date, 'complete_by_token moves a repeating task on');
select test.is((select string_agg(done_by, ', ' order by done_by) from task_log), 'Taylor (My day), Taylor (My day)', 'the log says who, via My day');
select test.is((select done_by from tasks where title = 'Homework'), 'Taylor (My day)', 'a one-off done from My day');
:as_adult
select test.ok(complete_by_token(test.token('Taylor'), test.task('Feed fish'), null) is not null, 'signed-in callers can use a token too');
:as_owner
select test.is((select done_by from task_log where task_id = test.task('Feed fish')), 'Taylor (My day)', '... and it is logged as the token''s person');

-- Inactive people's links stop working.
update people set active = false where name = 'Taylor';
:as_anon
select test.is(get_person_day(test.token('Taylor')), null, 'inactive person → null');
select test.is(complete_by_token(test.token('Taylor'), test.task('Feed fish'), null), null, 'inactive person cannot complete');
select test.is(undo_by_token(test.token('Taylor'), test.last_log('Feed fish')), null, 'inactive person cannot undo');
:as_owner
update people set active = true where name = 'Taylor';

-- A repeating task needs the date the page showed; a paused task can't be ticked off.
:as_anon
select test.throws($$select complete_by_token(test.token('Taylor'), test.task('Trash'), null)$$, 'already completed',
                   'complete_by_token: a repeating task without the date the page showed says already completed');
:as_owner
insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit, active)
values ('Paused chore', test.person('Taylor'), '2026-11-09', 'schedule', 1, 'week', false);
:as_anon
select test.throws($$select complete_by_token(test.token('Taylor'), test.task('Paused chore'), '2026-11-09')$$, 'paused',
                   'complete_by_token: a paused task can''t be ticked off');

-- ---------------------------------------------------------------------
-- undo_by_token: their own latest tick from My day, within 15 minutes
-- ---------------------------------------------------------------------
select test.is(undo_by_token(repeat('0', 32), test.last_log('Trash')), null, 'undo_by_token: unknown token → null');
select test.is(undo_by_token('not-a-token', test.last_log('Trash')), null, 'undo_by_token: malformed token → null');
select test.throws($$select undo_by_token(test.token('Morgan'), test.last_log('Trash'))$$, 'ticked off on this page',
                   'undo_by_token: not their task');
select test.throws($$select undo_by_token(test.token('Taylor'), gen_random_uuid())$$, 'nothing to undo', 'undo_by_token: unknown entry');
:as_adult
select complete_task(test.task('Sam''s errand'));
:as_anon
select test.throws($$select undo_by_token(test.token('Sam'), test.last_log('Sam''s errand'))$$, 'ticked off on this page',
                   'undo_by_token: a tick made signed in can''t be undone from My day, even on their own task');
select test.is(undo_by_token(test.token('Taylor'), test.last_log('Homework')), test.task('Homework'), 'undo_by_token: returns the task id');
:as_owner
select test.is((select coalesce(done_at::text, 'open') || ' ' || coalesce(done_by, 'nobody') from tasks where title = 'Homework'), 'open nobody',
               'undo_by_token: a one-off is open again');
select test.is((select count(*) from task_log where task_id = test.task('Homework')), 0::bigint, 'undo_by_token: the entry is gone');
set hub.now = '2026-11-09 08:15-05';
:as_anon
select test.is(undo_by_token(test.token('Taylor'), test.last_log('Trash')), test.task('Trash'), 'undo_by_token: 15 minutes later still works');
:as_owner
select test.is((select due_date || ' ' || coalesce(last_done::text, 'never') from tasks where title = 'Trash'), '2026-11-09 never',
               'undo_by_token: a repeating task goes back to its date');
:as_anon
select test.ok(complete_by_token(test.token('Taylor'), test.task('Trash'), '2026-11-09') is not null, 'and it can be ticked off again');
:as_admin
select skip_task(test.task('Trash'), '2026-11-16');
:as_anon
select test.throws($$select undo_by_token(test.token('Taylor'), test.last_log('Trash', 'done'))$$, 'Only the latest change',
                   'undo_by_token: only the latest change to the task');
select test.throws($$select undo_by_token(test.token('Taylor'), test.last_log('Trash', 'skipped'))$$, 'ticked off on this page',
                   'undo_by_token: a parent''s skip isn''t theirs to undo');
:as_admin
select undo_task(test.last_log('Trash', 'skipped'));
:as_owner
set hub.now = '2026-11-09 08:31-05';
:as_anon
select test.throws($$select undo_by_token(test.token('Taylor'), test.last_log('Trash'))$$, 'more than 15 minutes',
                   'undo_by_token: not after 15 minutes');
:as_admin
select test.is(undo_task(test.last_log('Trash')), test.task('Trash'), '... though a parent still can');
:as_owner
set hub.now = '2026-11-09 08:00-05';

-- ---------------------------------------------------------------------
-- confirm_digest: the secret from the confirmation email is the whole key
-- ---------------------------------------------------------------------
-- The email links to day.html?c=<secret>#confirm, without the My day token, so a mistyped
-- address never gets that person's My day link. A My day link can't confirm anything either.
update people set digest_enabled = true where name in ('Morgan', 'Taylor');
select test.ok(test.confirm_token('Morgan') ~ '^[0-9a-f]{32}$', 'an unconfirmed email has a 32-hex confirmation secret');
select test.ok(test.confirm_token('Morgan') <> test.token('Morgan'), '... which isn''t the My day token');
select test.is(test.confirm_token('Taylor'), null, 'no email, no secret');
:as_anon
select test.is(confirm_digest(test.token('Morgan')), false, 'confirm_digest: false for a My day token');
select test.is(confirm_digest(repeat('0', 32)), false, 'confirm_digest: false for an unknown secret');
select test.is(confirm_digest('not-a-secret'), false, 'confirm_digest: false for a malformed one');
select test.is(confirm_digest(null), false, 'confirm_digest: false for none');
:as_owner
update people set active = false where name = 'Sam';
:as_anon
select test.is(confirm_digest(test.confirm_token('Sam')), false, 'confirm_digest: false for someone who isn''t active');
:as_owner
update people set active = true where name = 'Sam';
select test.is((select count(*) from people where name in ('Morgan', 'Sam') and email_verified_at is not null), 0::bigint,
               '... and none of those confirmed anything');
create temp table morgan_confirm as select test.confirm_token('Morgan') as token;
grant select on morgan_confirm to public;
:as_anon
select test.is(confirm_digest(test.confirm_token('Morgan')), true, 'confirm_digest: true with the secret from the email');
:as_owner
select test.is((select string_agg(name, ', ') from people where email_verified_at is not null), 'Morgan',
               '... which confirms that person''s address, and nobody else''s');
select test.is(test.confirm_token('Morgan'), (select token from morgan_confirm), 'the secret is kept once used');
:as_anon
select test.is(confirm_digest((select token from morgan_confirm)), true,
               'confirm_digest: a second tap, or the email opened again later, still says confirmed');
select test.is(stop_digest(test.token('Morgan')), true, 'stop_digest: true for a valid link');
select test.is(stop_digest('x'), false, 'stop_digest: false for a bad link');
:as_owner
select test.is((select email_verified_at || ' ' || digest_enabled from people where name = 'Morgan'), '2026-11-09 13:00:00+00 false',
               'confirm sets email_verified_at; stop turns the email off');

-- A new address: a new secret, and earlier confirmation emails are forgotten.
insert into notification_log (person_id, local_date, kind, status) values
  (test.person('Morgan'), '2026-11-09', 'confirm', 'sent'),
  (test.person('Morgan'), '2026-11-08', 'confirm', 'sent'),
  (test.person('Morgan'), '2026-11-09', 'digest', 'sent');
:as_admin
select save_person(jsonb_build_object('id', test.person('Morgan'), 'email', 'morgan.new@example.com'), false);
:as_owner
select test.is((select email_verified_at from people where name = 'Morgan'), null, 'a new email has to be confirmed again');
select test.ok(test.confirm_token('Morgan') ~ '^[0-9a-f]{32}$' and test.confirm_token('Morgan') <> (select token from morgan_confirm), '... with a new secret');
select test.is((select string_agg(kind, ', ') from notification_log where person_id = test.person('Morgan')), 'digest',
               '... and earlier confirmation emails are forgotten, so one can go to the new address today');
:as_anon
select test.is(confirm_digest((select token from morgan_confirm)), false, '... and the secret for the old address stops working, even though it was used');
:as_owner
create temp table old_confirm as select test.confirm_token('Morgan') as token;
grant select on old_confirm to public;
:as_admin
select save_person(jsonb_build_object('id', test.person('Morgan'), 'name', 'Morgan', 'phone', '555-0107'), false);
:as_owner
select test.is(test.confirm_token('Morgan'), (select token from old_confirm), 'other changes keep the secret');
:as_admin
select save_person(jsonb_build_object('id', test.person('Morgan'), 'email', 'morgan.other@example.com'), false);
:as_anon
select test.is(confirm_digest((select token from old_confirm)), false, 'the secret sent to an earlier address stops working');
select test.is(confirm_digest(test.confirm_token('Morgan')), true, '... the new one works');

-- Turning the email on while unconfirmed makes sure there is a secret (keeping one already sent).
:as_owner
create temp table casey_confirm as select test.confirm_token('Casey Example') as token;
select test.ok((select token from casey_confirm) is not null, 'Casey (unconfirmed) has a secret');
update people set digest_enabled = true where name = 'Casey Example';
select test.is(test.confirm_token('Casey Example'), (select token from casey_confirm), 'turning the email on keeps the secret an earlier email carries');
update people set digest_enabled = false where name = 'Casey Example';
delete from people_confirm where person_id = test.person('Casey Example');
update people set digest_enabled = true where name = 'Casey Example';
select test.ok(test.confirm_token('Casey Example') ~ '^[0-9a-f]{32}$', 'turning the email on while unconfirmed makes a secret when there is none');
update people set email = null where name = 'Casey Example';
select test.is(test.confirm_token('Casey Example'), null, 'removing the email removes the secret');
update people set email = 'casey.e@example.com' where name = 'Casey Example';
select test.ok(test.confirm_token('Casey Example') is not null, 'adding an email makes one');
update casey_confirm set token = test.confirm_token('Casey Example');
update people set email_verified_at = now() where name = 'Casey Example';
select test.is(test.confirm_token('Casey Example'), (select token from casey_confirm), 'confirming keeps the secret (its link still says confirmed)');
update people set digest_enabled = false where name = 'Casey Example';
update people set digest_enabled = true where name = 'Casey Example';
select test.is(test.confirm_token('Casey Example'), (select token from casey_confirm), '... also when the email is turned off and on again');

-- ---------------------------------------------------------------------
-- mark_signed_in: signing in with a code sent to the address confirms it
-- ---------------------------------------------------------------------
select test.ok(test.confirm_token('Alex Example') is not null, 'Alex''s address starts unconfirmed');
:as_removed
select mark_signed_in();
:as_stranger
select mark_signed_in();
:as_owner
select test.is((select email_verified_at from people where name = 'Jordan'), null,
               'mark_signed_in does nothing for someone no longer a member, even with a person row');
select test.ok(test.confirm_token('Jordan') is not null, '... and keeps their secret');
:as_admin
select mark_signed_in();
:as_owner
select test.is((select email_verified_at from people where email = 'alex@example.com'), '2026-11-09 13:00:00+00'::timestamptz,
               'mark_signed_in confirms the member''s own address');
select test.ok(test.confirm_token('Alex Example') is not null, '... and keeps its secret');
:as_anon
select test.is(confirm_digest(test.confirm_token('Alex Example')), true, '... so the button in an earlier confirmation email still says confirmed');
:as_owner
select test.is((select count(*) from people where email_verified_at is not null and email <> 'alex@example.com' and name <> 'Morgan' and name <> 'Casey Example'),
               0::bigint, '... and nobody else''s');
set hub.now = '2026-11-10 08:00-05';
:as_admin
select mark_signed_in();
:as_owner
select test.is((select email_verified_at from people where email = 'alex@example.com'), '2026-11-09 13:00:00+00'::timestamptz,
               'signing in again keeps the first confirmation time');
