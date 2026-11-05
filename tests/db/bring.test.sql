-- Bring and the Tomorrow message (migration 0017, docs/v2-design.md §22).
-- events.bring is what to bring every day the event happens; event_changes.bring is one day's own (null = as usual).
-- Both are tidied to one line of at most 120 characters ('' becomes null). private.bring_of(p_event, p_day) is the
-- day's own, else the event's. My day gets a 'bring' key, the texts "· Bring: …" and the email "Bring: …" in the
-- detail, each only when there is one, and never on a private item (My day, the texts) or a hidden one (the email):
-- with no Bring every answer is exactly as before. tomorrow_text(p_person) is tomorrow's plan for one person in their
-- language, with the place and Bring and no Late section; members call it, anon and service_role can't. Bring never
-- goes to Google or to the tutor link and its coach view.
-- The household is calendar_fixtures.sql's: Piano (Taylor, helper, Spanish, in charge; Jordan, kid, along; Tuesdays
-- 4pm at "Rivera Music, 12 Elm St"; a note on Nov 3; Nov 10 cancelled), Gym (Sam), Surprise party (Alex, private).
\ir roles.sql
\ir calendar_fixtures.sql

:as_owner
select test.is(hub_schema_version(), 20, 'hub_schema_version is 20 (0017 made it 17, 0018 18, 0019 19, 0020 20)');
-- Runs a statement and keeps what it did: 'ok', or the error's code and message.
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
create function pg_temp.bring(p_title text) returns text language sql stable security definer as $$
  select bring from public.events where title = p_title
$$;
create function pg_temp.day_bring(p_title text, p_day date) returns text language sql stable security definer as $$
  select c.bring from public.event_changes c join public.events e on e.id = c.event_id where e.title = p_title and c.on_date = p_day
$$;
-- A line of a message that mentions p_word.
create function pg_temp.line(p_text text, p_word text) returns text language sql immutable as $$
  select l from regexp_split_to_table(p_text, E'\n') l where position(p_word in l) > 0 limit 1
$$;
-- My day's items on day i (0 today, 1 tomorrow) for a person.
create function pg_temp.my_day(p_name text, i int) returns jsonb language sql stable security definer as $$
  select public.get_person_day(test.token(p_name)) -> 'days' -> i -> 'items'
$$;
-- What Google is to have, for the whole window.
create function pg_temp.desired() returns text language sql stable security definer as $$
  select md5(coalesce(string_agg(d::text, ',' order by d::text), '')) from private.calendar_desired('2026-10-26', '2026-12-26', 'https://hub.example.com/') d
$$;
create function pg_temp.desired_has(p_word text) returns bigint language sql stable security definer as $$
  select count(*) from private.calendar_desired('2026-10-26', '2026-12-26', 'https://hub.example.com/') d where position(p_word in d::text) > 0
$$;

-- ---------------------------------------------------------------------
-- The columns, the tidy trigger and the functions
-- ---------------------------------------------------------------------
select test.is((select string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || (not a.attnotnull)::text, ',' order by c.relname)
                from pg_attribute a join pg_class c on c.oid = a.attrelid
                where c.relnamespace = 'public'::regnamespace and c.relname in ('events', 'event_changes') and a.attname = 'bring' and not a.attisdropped),
               'event_changes.bring:text:true,events.bring:text:true', 'events.bring and event_changes.bring: nullable text');
select test.is((select string_agg(t.tgname || ':' || c.relname, ',' order by t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
                where t.tgfoid = 'private.bring_tidy()'::regprocedure),
               'event_changes_bring_tidy:event_changes,events_bring_tidy:events', 'a tidy trigger on each table');
select test.ok((select bool_and(p.proconfig @> '{"search_path=\"\""}') from pg_proc p
                where p.oid in ('private.bring_tidy()'::regprocedure, 'private.bring_of(uuid, date)'::regprocedure, 'private.bring_text(text, text)'::regprocedure,
                                'private.tomorrow_line(public.agenda_item, uuid, text)'::regprocedure, 'public.tomorrow_text(uuid)'::regprocedure,
                                'private.my_day_item(public.agenda_item, uuid, text)'::regprocedure, 'private.text_line(public.agenda_item, uuid, text)'::regprocedure,
                                'private.digest_item(public.agenda_item, uuid, text, boolean, text, text)'::regprocedure)),
               'every new and replaced function has search_path = ''''');
select test.is((select p.prosecdef from pg_proc p where p.oid = 'public.tomorrow_text(uuid)'::regprocedure), false, 'tomorrow_text runs with the caller''s rights');
select test.is(has_function_privilege('authenticated', 'public.tomorrow_text(uuid)', 'execute'), true, 'authenticated may call tomorrow_text');
select test.is(has_function_privilege('anon', 'public.tomorrow_text(uuid)', 'execute'), false, '... anon may not');
select test.is(has_function_privilege('service_role', 'public.tomorrow_text(uuid)', 'execute'), false, '... nor service_role');
select test.is((select count(*) from information_schema.routine_privileges where routine_name in ('tomorrow_text', 'tomorrow_line', 'bring_of', 'bring_text', 'bring_tidy') and grantee = 'PUBLIC'),
               0::bigint, 'public may call none of the new functions');
select test.is(has_function_privilege('anon', 'private.bring_of(uuid, date)', 'execute') or has_function_privilege('anon', 'private.bring_text(text, text)', 'execute')
               or has_function_privilege('anon', 'private.tomorrow_line(public.agenda_item, uuid, text)', 'execute'), false, 'anon may call none of the private helpers');
select test.is(has_function_privilege('authenticated', 'private.bring_tidy()', 'execute'), false, 'nobody but the owner calls bring_tidy (a trigger)');
-- The three readers keep their grants: my_day_item none, text_line to authenticated and service_role, digest_item to service_role.
select test.is(has_function_privilege('authenticated', 'private.text_line(public.agenda_item, uuid, text)', 'execute')
               and has_function_privilege('service_role', 'private.digest_item(public.agenda_item, uuid, text, boolean, text, text)', 'execute')
               and not has_function_privilege('authenticated', 'private.digest_item(public.agenda_item, uuid, text, boolean, text, text)', 'execute')
               and not has_function_privilege('authenticated', 'private.my_day_item(public.agenda_item, uuid, text)', 'execute'), true,
               'the replaced readers keep their grants');

-- ---------------------------------------------------------------------
-- With no Bring anywhere, every answer is as before; Bring on someone else's event changes none of Jordan's
-- ---------------------------------------------------------------------
select md5(get_person_day(test.token('Jordan'))::text) as pd_before, md5(day_text(test.person('Jordan'), '2026-10-27')) as dt_before,
       md5(digest_for(test.person('Jordan'), '2026-10-27')::text) as df_before \gset
update events set bring = 'Towel' where title = 'Gym';
select test.is(pg_temp.bring('Gym'), 'Towel', 'Bring on Gym (Sam''s)');
select test.is(md5(get_person_day(test.token('Jordan'))::text), :'pd_before', '... Jordan''s My day is exactly as before');
select test.is(md5(day_text(test.person('Jordan'), '2026-10-27')), :'dt_before', '... and his day''s text');
select test.is(md5(digest_for(test.person('Jordan'), '2026-10-27')::text), :'df_before', '... and his email');
select test.is((select count(*) from jsonb_array_elements(pg_temp.my_day('Jordan', 0)) x where x ? 'bring'), 0::bigint, '... none of his items has a bring key');

-- ---------------------------------------------------------------------
-- Tidy: one line, at most 120 characters, '' becomes null
-- ---------------------------------------------------------------------
update events set bring = E'  Music\tbook \n ' where title = 'Piano';
select test.is(pg_temp.bring('Piano'), 'Music book', 'Bring is one line, spaces tidied');
update events set bring = E'Music​book‮' where title = 'Piano';
select test.is(pg_temp.bring('Piano'), 'Musicbook', '... with no zero-width or bidi characters');
update events set bring = repeat('a', 130) where title = 'Piano';
select test.is(char_length(pg_temp.bring('Piano')), 120, '... and at most 120 characters');
update events set bring = '   ' where title = 'Piano';
select test.is(pg_temp.bring('Piano'), null, '... and blank is null');
select test.is(pg_temp.run($$update public.events set bring = 'x' where false$$), 'ok', '(an update that touches no row is fine)');
update events set bring = 'Music book' where title = 'Piano';
update event_changes set bring = E' Music book,\t recital form ' where event_id = test.event('Piano') and on_date = '2026-11-03';
select test.is(pg_temp.day_bring('Piano', '2026-11-03'), 'Music book, recital form', 'a day''s own Bring, tidied too');
insert into event_changes (event_id, on_date, bring) values (test.event('Piano'), '2026-11-17', '');
select test.is(pg_temp.day_bring('Piano', '2026-11-17'), null, '... and a blank one is null (as usual)');
delete from event_changes where event_id = test.event('Piano') and on_date = '2026-11-17';

-- ---------------------------------------------------------------------
-- Who writes it: members, under the tables' own policies
-- ---------------------------------------------------------------------
:as_stranger
select test.is(test.try($$update public.events set bring = 'Hat' where title = 'Gym'$$), 'rows:0', 'a stranger changes no event''s Bring');
:as_anon
select test.is(test.try($$update public.events set bring = 'Hat' where title = 'Gym'$$), 'rows:0', 'anon changes none');
:as_adult
select test.is(test.try($$update public.events set bring = 'Hat' where title = 'Gym'$$), 'rows:1', 'a member (Sam) can');
select test.is(test.try($$update public.event_changes set bring = 'Hat' where on_date = '2026-11-03'$$), 'rows:1', '... a day''s too');
:as_owner
select test.is(pg_temp.bring('Gym'), 'Towel', '(test.try undid them)');

-- ---------------------------------------------------------------------
-- bring_of: the day's own, else the event's
-- ---------------------------------------------------------------------
select test.is(private.bring_of(test.event('Piano'), '2026-10-27'), 'Music book', 'bring_of: the event''s on a usual day');
select test.is(private.bring_of(test.event('Piano'), '2026-11-03'), 'Music book, recital form', '... the day''s own on Nov 3 (a day with a note too)');
select test.is(private.bring_of(test.event('Piano'), '2026-11-10'), 'Music book', '... the event''s on a cancelled day with no Bring of its own');
select test.is(private.bring_of(test.event('Swim'), '2026-10-31'), null, '... null for an event with none');
select test.is(private.bring_text('Cleats', 'en') || ' / ' || private.bring_text('Cleats', 'es'), 'Bring: Cleats / Llevar: Cleats', 'bring_text: Bring / Llevar');
select test.is(private.bring_text(null, 'en'), null, '... null when there''s nothing to bring');

-- ---------------------------------------------------------------------
-- My day: a 'bring' key only when there is one, never on a private item
-- ---------------------------------------------------------------------
insert into events (title, start_date, start_time, responsible_id, private, bring)
values ('Checkup', '2026-10-27', '11:00', test.person('Jordan'), true, 'Insurance card');
select test.is((select x ->> 'bring' from jsonb_array_elements(pg_temp.my_day('Jordan', 0)) x where x ->> 'title' = 'Piano'), 'Music book',
               'Jordan''s My day: Piano today with bring "Music book"');
select test.is((select count(*) from jsonb_array_elements(pg_temp.my_day('Jordan', 0)) x where x ->> 'title' = 'Private item' and not x ? 'bring'), 1::bigint,
               '... his private Checkup is "Private item", with no bring key');
select test.ok(position('Insurance card' in get_person_day(test.token('Jordan'))::text) = 0, '... and its Bring is nowhere in his answer');
select test.is((select count(*) from jsonb_array_elements(pg_temp.my_day('Taylor', 0)) x where x ->> 'title' = 'Piano' and x ->> 'bring' = 'Music book'), 1::bigint,
               'Taylor''s My day (Spanish, in charge) has it too');

-- ---------------------------------------------------------------------
-- The day's text (Send their day) and the email: "Bring: …" at the end, not on a private or hidden item
-- ---------------------------------------------------------------------
select test.ok(pg_temp.line(day_text(test.person('Jordan'), '2026-10-27'), 'Piano') like '4:00pm Piano · Taylor · % · Bring: Music book',
               'day_text: Jordan''s Piano line ends "· Bring: Music book"');
select test.ok(pg_temp.line(day_text(test.person('Taylor'), '2026-11-03'), 'Piano') like '% · Side door, code 1234 · Llevar: Music book, recital form',
               '... Taylor''s (Spanish) on Nov 3: the day''s note, then "Llevar: …" with the day''s own');
select test.ok(position('Insurance card' in day_text(test.person('Jordan'), '2026-10-27')) = 0 and pg_temp.line(day_text(test.person('Jordan'), '2026-10-27'), 'Private item') is not null,
               '... his private Checkup: "Private item", no Bring');
:as_service
select test.ok(position('Bring: Music book' in digest_for(test.person('Jordan'), '2026-10-27')::text) > 0, 'the email: Jordan''s Piano detail has "Bring: Music book"');
select test.ok(position('Llevar: Music book, recital form' in digest_for(test.person('Taylor'), '2026-11-03')::text) > 0, '... Taylor''s on Nov 3, in Spanish');
select test.ok(position('Insurance card' in digest_for(test.person('Jordan'), '2026-10-27')::text) = 0, '... not on his hidden private Checkup');
:as_owner
update events set bring = 'Gift' where title = 'Surprise party';
:as_service
select test.ok(position('Bring: Gift' in digest_for(test.person('Alex'), '2026-11-07')::text) > 0, '... a parent''s own private item isn''t hidden from them, Bring included');
:as_owner

-- ---------------------------------------------------------------------
-- Never to Google, the tutor link or the coach view
-- ---------------------------------------------------------------------
insert into homework_kids (kid_id) values (test.person('Jordan'));
insert into tutor_links (kid_id, label, expires_on) values (test.person('Jordan'), 'Pat Lee, tutor', '2027-05-01');
update tutor_links set coach = true where label = 'Pat Lee, tutor';
create function pg_temp.tutor() returns text language sql stable security definer as $$
  select token from public.tutor_links where label = 'Pat Lee, tutor'
$$;
-- The same answers with every Bring there, and with every Bring cleared (then put back).
select pg_temp.desired() as g_with, md5(coach_view_by_token(pg_temp.tutor())::text) as cv_with, md5(tutor_view_by_token(pg_temp.tutor())::text) as tv_with \gset
begin;
update events set bring = null where bring is not null;
update event_changes set bring = null where bring is not null;
select pg_temp.desired() as g_without, md5(coach_view_by_token(pg_temp.tutor())::text) as cv_without, md5(tutor_view_by_token(pg_temp.tutor())::text) as tv_without \gset
rollback;
select test.is(pg_temp.bring('Piano'), 'Music book', '(every Bring back after the rollback)');
select test.is(:'g_with', :'g_without', 'Google: Bring changes nothing the hub writes there');
select test.is(pg_temp.desired_has('Music book'), 0::bigint, '... no body mentions it');
select test.ok(pg_temp.desired_has('Piano') > 0, '(Piano is on Google)');
select test.is(:'cv_with', :'cv_without', 'the coach view: Bring changes nothing');
select test.is(:'tv_with', :'tv_without', 'the tutor link: Bring changes nothing');
:as_anon
select test.ok(position('Music book' in coach_view_by_token(pg_temp.tutor())::text) = 0 and position('Music book' in tutor_view_by_token(pg_temp.tutor())::text) = 0,
               '... neither mentions it');
:as_owner

-- ---------------------------------------------------------------------
-- tomorrow_text: tomorrow's plan, in their language, with the place and Bring, and no Late section
-- ---------------------------------------------------------------------
set hub.now = '2026-11-02 19:30 America/New_York';
:as_admin
select tomorrow_text(test.person('Taylor')) as tt_taylor, tomorrow_text(test.person('Jordan')) as tt_jordan \gset
select test.is(split_part(:'tt_taylor', E'\n', 1), 'Taylor · Mañana, mar 3 nov', 'tomorrow_text (Taylor, Spanish): "Mañana" and the date');
select test.ok(pg_temp.line(:'tt_taylor', 'Piano') like '16:00–17:00 Piano · con Jordan · Rivera Music, 12 Elm St · Rivera Music % · Side door, code 1234 · Llevar: Music book, recital form',
               '... Piano: start and end, who''s with her, the place, the contact, the day''s note and the day''s Bring');
select test.ok(position('Atrasado' in :'tt_taylor') = 0 and position('Atrasado' in day_text(test.person('Taylor'), '2026-11-03')) > 0,
               '... no Late section (day_text for the same day has one)');
select test.is(split_part(:'tt_jordan', E'\n', 1), 'Jordan · Tomorrow, Tue Nov 3', 'Jordan''s (English): "Tomorrow" and the date');
select test.ok(pg_temp.line(:'tt_jordan', 'Piano') like '4:00pm–5:00pm Piano · Taylor · Rivera Music, 12 Elm St · % · Bring: Music book, recital form',
               '... Piano: start and end (the driver''s pickup), who''s in charge, the place, Bring');
select test.is(tomorrow_text(test.person('Jordan')), tomorrow_text(test.person('Jordan')), '(the same twice)');
:as_owner
insert into people (name, role, language, sort_order) values ('Casey', 'adult', 'en', 9);
:as_adult
select test.is(tomorrow_text(test.person('Casey')), E'Casey · Tomorrow, Tue Nov 3\nNothing planned', 'someone with nothing tomorrow: "Nothing planned"');
select test.is(tomorrow_text('00000000-0000-0000-0000-000000000000'), null, 'an unknown person: null');
select test.is(tomorrow_text(null), null, '... and null for null');
:as_stranger
select test.is(tomorrow_text(test.person('Taylor')), null, 'a stranger: null (no people to read)');
:as_anon
select test.ok(pg_temp.run($$select public.tomorrow_text(test.person('Taylor'))$$) like '42501 %', 'anon can''t call it');
:as_service
select test.ok(pg_temp.run($$select public.tomorrow_text(test.person('Taylor'))$$) like '42501 %', 'service_role can''t either');
:as_owner
-- A chore on set dates is in the message when tomorrow is one of its dates, even while today's (or a missed one) is
-- still open: Jordan's Trash is every Monday and last Monday's wasn't done.
set hub.now = '2026-11-01 19:30 America/New_York';
:as_admin
select test.ok(pg_temp.line(tomorrow_text(test.person('Jordan')), 'Trash') = '☐ Trash', 'Sun Nov 1 evening: Jordan''s Monday Trash is in tomorrow''s message (last Monday''s still open)');
select test.ok(not exists (select 1 from regexp_split_to_table(day_text(test.person('Jordan'), '2026-11-02'), E'\n') l where l = '☐ Trash')
               and pg_temp.line(day_text(test.person('Jordan'), '2026-11-02'), 'Trash') like '☐ Trash (%)',
               '(day_text for Monday, read on Sunday, has it only under Late, with its open date: agenda puts it there)');
:as_owner
insert into tasks (title, responsible_id, due_date, category, repeat_mode, every_count, every_unit, anchor_date)
values ('Water the ferns', test.person('Taylor'), '2026-11-02', 'home', 'schedule', 1, 'day', '2026-11-02'),
       ('Sweep the porch', test.person('Taylor'), '2026-11-02', 'home', 'after_done', 2, 'day', '2026-11-02');
set hub.now = '2026-11-02 19:30 America/New_York';
:as_admin
select test.is((select count(*) from regexp_split_to_table(tomorrow_text(test.person('Taylor')), E'\n') l where l = '☐ Water the ferns'), 1::bigint,
               'Mon Nov 2 evening: Taylor''s daily chore, still open today, is in tomorrow''s message once');
select test.ok(pg_temp.line(tomorrow_text(test.person('Taylor')), 'Sweep the porch') is null, '... one repeated a while after it''s done isn''t (it doesn''t move until done)');
select complete_task(test.task('Water the ferns'), '2026-11-02');
select test.is((select count(*) from regexp_split_to_table(tomorrow_text(test.person('Taylor')), E'\n') l where l = '☐ Water the ferns'), 1::bigint,
               '... and once after today''s is ticked (now due tomorrow)');
:as_owner
-- After midnight, tomorrow is the next day.
set hub.now = '2026-11-03 00:30 America/New_York';
select test.is(split_part(tomorrow_text(test.person('Jordan')), E'\n', 1), 'Jordan · Tomorrow, Wed Nov 4', 'at 12:30am, tomorrow is the next household day');
