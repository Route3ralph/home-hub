-- Hearth people (migration 0010, docs/v1.1-google-calendar.md §11): the kitchen wall keeps its own events in one
-- Google calendar, "Hearth Calendar", and marks whose each one is by adding that Hearth profile as a guest
-- (jordan@team-example-0000). With Sort by Hearth person (calendars.sort_by_guest) on, the hub sends each event
-- to the people its tags reach: a tag matched to a person on the family list reaches that person; one matched to
-- Family reaches every kid and every parent's and adult's email (never a helper); anything else (the grown-ups,
-- New, a person off the family list or removed) reaches the grown-ups' emails and days on Today only; an event
-- with no tag is the grown-ups'. The household is calendar_fixtures.sql's: Alex and Morgan (parents), Sam
-- (adult), Jordan (kid), Taylor (the Spanish-speaking helper), in that family-list order; the clock is
-- Tue Oct 27 9:00am. The fixture of §11.8: twelve wall events on Wed Oct 28 to Fri Oct 30, the tags jordan →
-- Jordan, sam → Sam, taylor → Taylor, familyanddogs → Family, dogs → the grown-ups and grandma New; Jordan's
-- homework time Mon–Fri 4:00–5:30pm; Alex's email "mine", Morgan's "everyone"; Pat's tutor link with the
-- coach view on. Then: the exact set each person gets (My day, day_text, the email, busy time, the tutor's
-- week, the coach view) and the who-text; a person made inactive and removed; the switch off; set_hearth_tag;
-- calendar_store_events (the guests, the tag list, the 90-day rule, the 50 cap, a failing tag list);
-- the calendars rules (the checks, the tidy trigger, a new Google ID, Disconnect); calendar_read_due; and the
-- privileges and row-level security of what 0010 adds.
\ir roles.sql
\ir calendar_fixtures.sql

-- ---------------------------------------------------------------------
-- Helpers (owner)
-- ---------------------------------------------------------------------
:as_owner
-- Runs a statement and keeps what it did: 'ok', or the error's code and message.
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
create function pg_temp.cal(p_label text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.calendars where label = p_label
$$;
create function pg_temp.tag(p_name text) returns uuid language sql stable security definer set search_path = '' as $$
  select h.id from public.hearth_tags h join public.calendars c on c.id = h.calendar_id where c.label = 'Hearth' and h.name = p_name
$$;
-- The Hearth calendar's tag list: "name matched_to person" (- for none), by name.
create function pg_temp.tags() returns text language sql stable security definer set search_path = '' as $$
  select string_agg(h.name || ' ' || coalesce(h.matched_to, '-') || ' ' || coalesce(p.name, '-'), ', ' order by h.name)
  from public.hearth_tags h join public.calendars c on c.id = h.calendar_id left join public.people p on p.id = h.person_id
  where c.label = 'Hearth'
$$;
-- One wall event as hub-jobs sends it (§11.3): organizer the calendar itself, guests its Hearth tags.
create function pg_temp.ev(p_id text, p_title text, p_start text, p_end text, p_extra jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'status', 'confirmed', 'title', p_title,
                            'start', case when p_start ~ 'T' then jsonb_build_object('dateTime', p_start) else jsonb_build_object('date', p_start) end,
                            'end', case when p_end ~ 'T' then jsonb_build_object('dateTime', p_end) else jsonb_build_object('date', p_end) end,
                            'organizer_self', true, 'updated', '2026-10-26T12:00:00Z', 'visibility', 'default', 'response', null) || p_extra
$$;
-- A row of this calendar (its notes name it), by its title; the two private ones by how they came.
create function pg_temp.mine(a public.agenda_item) returns boolean language sql immutable as $$
  select a.kind = 'google' and a.notes = 'From Google Calendar · Hearth Calendar'
$$;
create function pg_temp.lbl(a public.agenda_item) returns text language sql immutable as $$
  select case when not a.private then a.title when a.local_start = '17:00' then 'Private (tags sent)' else 'Private (as Google sends it)' end
$$;
-- private.google_for for one person, Wed Oct 28 to Fri Oct 30: this calendar's rows, by name.
create function pg_temp.gf(p_name text, p_grown_up boolean) returns text language sql stable as $$
  select string_agg(pg_temp.lbl(g), ', ' order by pg_temp.lbl(g))
  from private.google_for(test.person(p_name), '2026-10-28', '2026-10-30', p_grown_up) g where pg_temp.mine(g)
$$;
-- private.person_items for one person, each day Wed Oct 28 to Fri Oct 30: this calendar's rows, by name.
create function pg_temp.pi(p_name text) returns text language sql stable as $$
  select string_agg(pg_temp.lbl(i), ', ' order by pg_temp.lbl(i))
  from generate_series(date '2026-10-28', date '2026-10-30', interval '1 day') d
  cross join lateral private.person_items(test.person(p_name), d::date) i where pg_temp.mine(i)
$$;
-- The wall events' lines of a person's day_text, Wed Oct 28 to Fri Oct 30, in order.
create function pg_temp.dt(p_name text) returns text language sql stable as $$
  select string_agg(t.l, ' | ' order by d, t.n)
  from generate_series(date '2026-10-28', date '2026-10-30', interval '1 day') d
  cross join lateral regexp_split_to_table(public.day_text(test.person(p_name), d::date), E'\n') with ordinality t (l, n)
  where t.l ~ '^([0-9:]+(am|pm)? |All day: |Todo el día: )(Piano|Furnace check|Visit|Movie|Practice|Field trip|Vet|Swim|Private item|Asunto privado|Dinner|Tea)( · .*)?$'
$$;
-- The Google items of a person's My day (today and tomorrow), as "MM-DD title" ("Private item" with its time), in order.
create function pg_temp.md(p_name text) returns text language sql stable as $$
  select string_agg(to_char((x ->> 'day')::date, 'MM-DD') || ' ' || (x ->> 'title')
                    || case when x ->> 'title' = 'Private item' then ' ' || (x ->> 'time_label') else '' end, ' | ' order by dn, xn)
  from jsonb_array_elements(public.get_person_day(test.token(p_name)) -> 'days') with ordinality a (d, dn)
  cross join lateral jsonb_array_elements(a.d -> 'items') with ordinality b (x, xn)
  where x ->> 'kind' = 'google'
$$;
-- The Google items of a person's morning email (Today, Wed Oct 28 to Fri Oct 30), as "title · detail"
-- ("Private item" with its time), sorted.
create function pg_temp.em(p_name text) returns text language sql stable as $$
  select string_agg(y.l, ' | ' order by y.l)
  from generate_series(date '2026-10-28', date '2026-10-30', interval '1 day') d
  cross join lateral jsonb_array_elements(public.digest_for(test.person(p_name), d::date) -> 'today') x
  cross join lateral (select concat_ws(' · ', x ->> 'title', x ->> 'detail')
                             || case when x ->> 'title' = 'Private item' then ' (' || (x ->> 'time') || ')' else '' end) y (l)
  where x ->> 'kind' = 'google'
$$;
-- Busy blocks as "MM-DD starts-ends title" (a title only when there is one), in order.
create function pg_temp.busy(p_days jsonb) returns text language sql immutable as $$
  select string_agg(to_char((d ->> 'day')::date, 'MM-DD') || ' ' || (b ->> 'starts') || '-' || (b ->> 'ends') || coalesce(' ' || nullif(b ->> 'title', ''), ''),
                    ' | ' order by dn, bn)
  from jsonb_array_elements(p_days) with ordinality t (d, dn)
  cross join lateral jsonb_array_elements(d -> 'busy') with ordinality u (b, bn)
  where (d ->> 'day')::date between '2026-10-28' and '2026-10-30'
$$;
-- This calendar's google_items rows: "title people category in-charge" (- for none), people in the row's order.
create function pg_temp.rows() returns text language sql stable as $$
  select string_agg(pg_temp.lbl(g) || ' ' || coalesce((select string_agg(p.name, ',' order by u.n) from unnest(g.participant_ids) with ordinality u (id, n)
                                                        join public.people p on p.id = u.id), '-')
                    || ' ' || coalesce(g.category, '-') || ' ' || coalesce((select p.name from public.people p where p.id = g.responsible_id), '-'),
                    ' | ' order by pg_temp.lbl(g))
  from public.google_items('2026-10-28', '2026-10-30') g where pg_temp.mine(g)
$$;
grant execute on function pg_temp.run(text), pg_temp.cal(text), pg_temp.tag(text), pg_temp.tags(), pg_temp.rows() to public;

-- ---------------------------------------------------------------------
-- The household: Morgan's email has everyone's items; Jordan's homework on, Mon–Fri 4:00–5:30pm; Pat's link
-- with the coach view on
-- ---------------------------------------------------------------------
update people set digest_scope = 'everyone' where name = 'Morgan';
:as_admin
select save_homework_kid(test.person('Jordan'), true);
select add_homework_time(test.person('Jordan'), '{1,2,3,4,5}', '16:00', '17:30');
select save_tutor_link(null, test.person('Jordan'), 'Pat Lee, tutor', 'en', null, false, true);
select set_tutor_coach((select id from tutor_links where label = 'Pat Lee, tutor'), true);
:as_owner
create function pg_temp.pat() returns text language sql stable security definer set search_path = '' as $$
  select token from public.tutor_links where label = 'Pat Lee, tutor'
$$;
grant execute on function pg_temp.pat() to public;

-- ---------------------------------------------------------------------
-- Hearth Calendar: added as Family, read only; the switch on
-- ---------------------------------------------------------------------
:as_admin
insert into calendars (google_id, kind, label, writes) values ('hearth-0000@group.calendar.google.com', 'family', 'Hearth', false);
select test.is((select sort_by_guest from calendars where label = 'Hearth'), false, 'a new calendar is not sorted (sort_by_guest defaults to false)');
select test.is(test.try($$update public.calendars set sort_by_guest = true where label = 'Hearth'$$), 'rows:1', 'an admin turns on Sort by Hearth person (a column grant)');
update calendars set sort_by_guest = true where label = 'Hearth';
:as_adult
select test.is(test.try($$update public.calendars set sort_by_guest = false where label = 'Hearth'$$), 'rows:0', '... Sam''s update changes nothing (admins only, by policy)');
:as_admin
select test.is(test.try($$insert into public.calendars (google_id, kind, label, writes, sort_by_guest) values ('wall@example.com', 'family', 'Wall', false, true)$$),
               'denied', '... and it can''t be set when a calendar is added (no insert grant)');

-- calendar_read_due: one more column, and the calendar is first (not read yet).
:as_service
select test.is((select string_agg(u.n, ',' order by u.o) from pg_proc p, unnest(p.proargnames, p.proargmodes) with ordinality u (n, m, o)
                where p.oid = 'public.calendar_read_due(boolean, int)'::regprocedure and u.m = 't'),
               'calendar_id,google_id,writes,w_from,w_to,time_min,time_max,tz,sort_by_guest', 'calendar_read_due answers sort_by_guest as its last column');
select test.is((select string_agg(c.label || ' ' || d.sort_by_guest, ', ') from calendar_read_due() d join calendars c on c.id = d.calendar_id),
               'Hearth true', 'calendar_read_due: the new calendar is due, with sort_by_guest true');
select test.is((select string_agg(d.sort_by_guest::text, ',') from calendar_read_due(true, 10) d join calendars c on c.id = d.calendar_id where c.label <> 'Hearth'),
               'false,false,false,false,false,false,false', '... every other calendar has sort_by_guest false');

-- The wall's events (§11.8), as the read that asked Google for guests sends them.
create temp table wall (e jsonb);
insert into wall values
  (pg_temp.ev('piano1', 'Piano', '2026-10-28T20:30:00Z', '2026-10-28T21:15:00Z', '{"guests": ["jordan@team-example-0000"]}')),
  (pg_temp.ev('furnace1', 'Furnace check', '2026-10-28T14:00:00Z', '2026-10-28T15:00:00Z', '{"guests": ["sam@team-example-0000"]}')),
  (pg_temp.ev('visit1', 'Visit', '2026-10-28T20:00:00Z', '2026-10-28T20:30:00Z', '{"guests": ["familyanddogs@team-example-0000"]}')),
  (pg_temp.ev('movie1', 'Movie', '2026-10-28T20:45:00Z', '2026-10-28T22:00:00Z', '{"guests": []}')),
  (pg_temp.ev('practice1', 'Practice', '2026-10-29T20:00:00Z', '2026-10-29T21:00:00Z', '{"guests": ["jordan@team-example-0000", "sam@team-example-0000"]}')),
  (pg_temp.ev('trip1', 'Field trip', '2026-10-29', '2026-10-30', '{"guests": ["jordan@team-example-0000"]}')),
  (pg_temp.ev('vet1', 'Vet', '2026-10-29T20:30:00Z', '2026-10-29T21:00:00Z', '{"guests": ["dogs@team-example-0000", "taylor@team-example-0000"]}')),
  (pg_temp.ev('swim1', 'Swim', '2026-10-30T20:00:00Z', '2026-10-30T21:00:00Z', '{"guests": ["dogs@team-example-0000", "jordan@team-example-0000"]}')),
  (pg_temp.ev('private1', 'Orthodontist', '2026-10-30T21:00:00Z', '2026-10-30T21:30:00Z',
              '{"guests": ["jordan@team-example-0000"], "visibility": "private", "location": "4 Elm St"}')),
  (pg_temp.ev('private2', '', '2026-10-30T20:30:00Z', '2026-10-30T21:00:00Z', '{"guests": [], "visibility": "private"}')),
  (pg_temp.ev('dinner1', 'Dinner', '2026-10-30T22:00:00Z', '2026-10-30T23:00:00Z', '{"guests": ["familyanddogs@team-example-0000", "taylor@team-example-0000"]}')),
  (pg_temp.ev('tea1', 'Tea', '2026-10-30T19:00:00Z', '2026-10-30T20:00:00Z', '{"guests": ["grandma@team-example-0000"]}'));
-- The same read without guests (an older hub-jobs, or a read that asked Google before the switch went on).
create temp table wall_plain as select e - 'guests' as e from wall;
create function pg_temp.store(p_label text, p_events jsonb, p_seen jsonb default '[]', p_complete boolean default true) returns jsonb language sql as $$
  select public.calendar_store_events(c.id, c.google_id, '2026-10-26', '2026-12-26', case when c.label = 'Hearth' then 'Hearth Calendar' else coalesce(c.google_name, c.label) end,
                                      'reader', p_complete, p_events, p_seen)
  from public.calendars c where c.label = p_label
$$;
create function pg_temp.events() returns jsonb language sql as $$ select jsonb_agg(e order by e ->> 'id') from wall $$;

select test.is(pg_temp.store('Hearth', pg_temp.events()), '{"kept": 12, "skipped": 0, "seen": 0, "repaired": 0, "adopted": 0}'::jsonb,
               'store: the twelve wall events are kept; the answer has its keys as before');
select test.is((select string_agg(event_id || ' ' || guests::text, ', ' order by event_id) from google_events where calendar_id = pg_temp.cal('Hearth')),
               'dinner1 {familyanddogs@team-example-0000,taylor@team-example-0000}, furnace1 {sam@team-example-0000}, movie1 {}, '
               'piano1 {jordan@team-example-0000}, practice1 {jordan@team-example-0000,sam@team-example-0000}, private1 {jordan@team-example-0000}, '
               'private2 {}, swim1 {dogs@team-example-0000,jordan@team-example-0000}, tea1 {grandma@team-example-0000}, trip1 {jordan@team-example-0000}, '
               'vet1 {dogs@team-example-0000,taylor@team-example-0000}, visit1 {familyanddogs@team-example-0000}',
               'store: each kept event of a sorted calendar keeps its tags (google_events.guests), sorted');
select test.is((select concat_ws(' | ', title, coalesce(location, '-'), private, guests::text) from google_events where event_id = 'private1'),
               ' | - | t | {jordan@team-example-0000}', 'store: a private event sent with its tags keeps them, and no title or place');
select test.is((select concat_ws(' ', status, google_name, read_at = private.now(), checked_at = private.now()) from calendars where label = 'Hearth'),
               'ok Hearth Calendar t t', 'store: a complete read with guests of a sorted calendar is a complete read (read_at set)');
select test.is(pg_temp.tags(), 'dogs - -, familyanddogs - -, grandma - -, jordan - -, sam - -, taylor - -',
               'store: the tags on its events are listed, each New (matched_to null)');
select test.is((select string_agg(tag || ' ' || name || ' ' || (last_seen = private.now()) || ' ' || (matched_at is null) || ' ' || (matched_by is null), ', ' order by tag)
                from hearth_tags), 'dogs@team-example-0000 dogs true true true, familyanddogs@team-example-0000 familyanddogs true true true, '
               'grandma@team-example-0000 grandma true true true, jordan@team-example-0000 jordan true true true, sam@team-example-0000 sam true true true, '
               'taylor@team-example-0000 taylor true true true', '... with name (the part before the @), last_seen the read''s time, never matched');
select test.is((select count(*) from calendar_read_due()), 0::bigint, 'calendar_read_due: read just now, so not due');

-- Nothing matched yet: every event is the grown-ups'.
:as_owner
select test.is(pg_temp.gf('Jordan', false), null, 'before any match: Jordan gets none of the wall''s events');
select test.is(pg_temp.gf('Taylor', false), null, '... nor Taylor');
select test.is(pg_temp.gf('Alex', true), 'Dinner, Field trip, Furnace check, Movie, Piano, Practice, Private (as Google sends it), Private (tags sent), Swim, Tea, Vet, Visit',
               '... and Alex''s email gets every one (New reaches the grown-ups)');

-- ---------------------------------------------------------------------
-- set_hearth_tag: the parents match each tag (§11.5)
-- ---------------------------------------------------------------------
:as_admin
select test.is(set_hearth_tag(pg_temp.tag('jordan'), 'person', test.person('Jordan')),
               jsonb_build_object('id', pg_temp.tag('jordan'), 'name', 'jordan', 'to', 'person', 'person_id', test.person('Jordan')),
               'set_hearth_tag: jordan → Jordan answers {id, name, to, person_id}');
select test.is(set_hearth_tag(pg_temp.tag('sam'), 'person', test.person('Sam')) ->> 'person_id', test.person('Sam')::text, '... sam → Sam');
select test.is(set_hearth_tag(pg_temp.tag('taylor'), 'person', test.person('Taylor')) ->> 'person_id', test.person('Taylor')::text, '... a helper can be matched: taylor → Taylor');
select test.is(set_hearth_tag(pg_temp.tag('familyanddogs'), 'family', test.person('Jordan')),
               jsonb_build_object('id', pg_temp.tag('familyanddogs'), 'name', 'familyanddogs', 'to', 'family', 'person_id', null),
               '... familyanddogs → Family (p_person is ignored unless ''person'')');
select test.is(set_hearth_tag(pg_temp.tag('dogs'), 'grown_ups'),
               jsonb_build_object('id', pg_temp.tag('dogs'), 'name', 'dogs', 'to', 'grown_ups', 'person_id', null), '... dogs → the grown-ups');
select test.is(pg_temp.tags(), 'dogs grown_ups -, familyanddogs family -, grandma - -, jordan person Jordan, sam person Sam, taylor person Taylor',
               '... and grandma stays New');
select test.is((select string_agg(name || ' ' || (matched_at = private.now()) || ' ' || matched_by, ', ' order by name) from hearth_tags where matched_to is not null),
               'dogs true alex@example.com, familyanddogs true alex@example.com, jordan true alex@example.com, sam true alex@example.com, taylor true alex@example.com',
               '... each with matched_at (private.now()) and matched_by (the parent''s email)');

-- ---------------------------------------------------------------------
-- Routing (§11.4), at once: no new read
-- ---------------------------------------------------------------------
:as_adult
select test.is(pg_temp.rows(),
               'Dinner Taylor family - | Field trip Jordan - - | Furnace check Sam - - | Movie - grown_ups - | Piano Jordan - - | Practice Sam,Jordan - - | '
               'Private (as Google sends it) - grown_ups - | Private (tags sent) Jordan - - | Swim Jordan grown_ups - | Tea - grown_ups - | '
               'Vet Taylor grown_ups - | Visit - family -',
               'google_items: nobody in charge of any; the people its tags reach along, in family-list order; Family''s ''family'', the grown-ups'' ''grown_ups''');
:as_owner
select test.is(pg_temp.gf('Jordan', false), 'Dinner, Field trip, Piano, Practice, Private (tags sent), Swim, Visit',
               'google_for, Jordan (My day, texts, his email): his own, his shared ones and Family''s; a match works without a new read');
select test.is(pg_temp.gf('Jordan', true), 'Field trip, Piano, Practice, Private (tags sent), Swim', '... with p_grown_up true (never asked for a kid): only those he is on');
select test.is(pg_temp.gf('Taylor', false), 'Dinner, Vet', 'google_for, Taylor: only the events with her own tag (never through Family or the grown-ups)');
select test.is(pg_temp.gf('Taylor', true), 'Dinner, Vet', '... the same with p_grown_up true');
select test.is(pg_temp.gf('Sam', false), 'Furnace check, Practice', 'google_for, Sam''s My day: only his own (not even Family''s or the grown-ups'')');
select test.is(pg_temp.gf('Sam', true), 'Dinner, Furnace check, Movie, Practice, Private (as Google sends it), Swim, Tea, Vet, Visit',
               '... Sam''s email: his own, Family''s and the grown-ups''');
select test.is(pg_temp.gf('Alex', true), 'Dinner, Movie, Private (as Google sends it), Swim, Tea, Vet, Visit',
               'google_for, Alex''s email: Family''s and the grown-ups'', not Jordan''s alone');
select test.is(pg_temp.gf('Alex', false), null, '... Alex''s My day: none (as for a read-only Family calendar)');
select test.is(pg_temp.gf('Morgan', true), pg_temp.gf('Alex', true), '... Morgan''s the same');
select test.is(pg_temp.gf('Morgan', false), null, '... and none on her My day');
select test.is(pg_temp.pi('Jordan'), 'Dinner, Field trip, Piano, Practice, Private (tags sent), Swim, Visit', 'person_items: Jordan''s days have the same seven');
select test.is(pg_temp.pi('Taylor'), 'Dinner, Vet', '... Taylor''s her two');
select test.is(pg_temp.pi('Sam'), 'Furnace check, Practice', '... Sam''s his two');
select test.is(pg_temp.pi('Alex'), null, '... Alex''s none');
-- day_text, and its who-text: with nobody in charge, someone on the row sees no other name; anyone else the row's people.
select test.is(pg_temp.dt('Jordan'), '4:00pm Visit | 4:30pm Piano | 4:00pm Practice | All day: Field trip | 4:00pm Swim | 5:00pm Private item | 6:00pm Dinner · Taylor',
               'day_text, Jordan: "4:30pm Piano", "4:00pm Practice" (not Sam), "6:00pm Dinner · Taylor"; the private one as "Private item"');
select test.is(pg_temp.dt('Taylor'), '16:30 Vet | 18:00 Dinner', 'day_text, Taylor (in Spanish): Vet and Dinner, with no name');
select test.is(pg_temp.dt('Sam'), '10:00am Furnace check | 4:00pm Practice', 'day_text, Sam: his two, with no other name');
select test.is(pg_temp.dt('Alex'), null, 'day_text, Alex: none of them');
-- My day (today and tomorrow).
set hub.now = '2026-10-28 07:00 America/New_York';
:as_anon
select test.is(pg_temp.md('Jordan'), '10-28 Visit | 10-28 Piano | 10-29 Practice | 10-29 Field trip', 'My day, Jordan on Wed: Visit, Piano; Thu: Practice, Field trip');
select test.is(pg_temp.md('Taylor'), '10-29 Vet', 'My day, Taylor on Wed: Vet tomorrow (not Visit)');
select test.is(pg_temp.md('Sam'), '10-28 Furnace check | 10-29 Practice', 'My day, Sam on Wed: his own two');
select test.is(pg_temp.md('Alex'), null, 'My day, Alex: none');
:as_owner
set hub.now = '2026-10-30 07:00 America/New_York';
:as_anon
select test.is(pg_temp.md('Jordan'), '10-30 Swim | 10-30 Private item 5:00pm | 10-30 Dinner', 'My day, Jordan on Fri: Swim, the private one with his tag, Dinner');
select test.is(pg_temp.md('Taylor'), '10-30 Dinner', 'My day, Taylor on Fri: Dinner (Family''s and hers, by her own tag)');
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';
-- The morning email, and its who-text.
:as_service
select test.is(pg_temp.em('Jordan'), 'Dinner · Taylor | Field trip | Piano | Practice | Private item (5:00pm) | Swim | Visit', 'email, Jordan: his seven');
select test.is(pg_temp.em('Taylor'), 'Dinner | Vet', 'email, Taylor: her two, with no name');
select test.is(pg_temp.em('Sam'), 'Dinner · Taylor | Furnace check | Movie | Practice | Private item (4:30pm) | Swim · Jordan | Tea | Vet · Taylor | Visit',
               'email, Sam: Furnace check, Visit, Movie, Practice, Vet, Swim, the private one as Google sends it, Dinner, Tea');
select test.is(pg_temp.em('Alex'), 'Dinner · Taylor | Movie | Private item (4:30pm) | Swim · Jordan | Tea | Vet · Taylor | Visit',
               'email, Alex ("mine"): Visit, Movie, Vet, Swim, the private one as Google sends it, Dinner, Tea; it says whose each is');
select test.is(pg_temp.em('Morgan'), 'Dinner · Taylor | Field trip · Jordan | Furnace check · Sam | Movie | Piano · Jordan | Practice · Sam, Jordan | '
               'Private item (4:30pm) | Private item (5:00pm) | Swim · Jordan | Tea | Vet · Taylor | Visit',
               'email, Morgan ("everyone"): all twelve; "Piano · Jordan", "Practice · Sam, Jordan"; one with no people names nobody; a private one has no who part');
:as_adult
select test.is((select string_agg(private.text_line(g, test.person('Alex'), 'en'), ' | ' order by g.day, g.local_start nulls last, g.title)
                from google_items('2026-10-28', '2026-10-30') g where pg_temp.mine(g)),
               '10:00am Furnace check · Sam | 4:00pm Visit | 4:30pm Piano · Jordan | 4:45pm Movie | 4:00pm Practice · Sam, Jordan | 4:30pm Vet · Taylor | '
               'All day: Field trip · Jordan | 3:00pm Tea | 4:00pm Swim · Jordan | 4:30pm Private item | 5:00pm Private item | 6:00pm Dinner · Taylor',
               'text_line, seen by a parent: each line says whose it is (people along, in family-list order); none for Visit, Movie, Tea or a private one');
-- Busy time: his timed events that touch his homework time (4:00–5:30pm).
:as_owner
select test.is((select pg_temp.busy(jsonb_agg(jsonb_build_object('day', f.day, 'busy', f.busy)))
                from private.free_minutes(test.person('Jordan'), '2026-10-28', '2026-10-30', null) f),
               '10-28 16:00-16:30 Visit | 10-28 16:30-17:15 Piano | 10-29 16:00-17:00 Practice | 10-30 16:00-17:00 Swim | 10-30 17:00-17:30',
               'free_minutes, Jordan: Visit, Piano, Practice, Swim and the private one with his tag; not Movie, Vet, the other private one, Field trip, Dinner or Tea');
:as_admin
select test.is(pg_temp.busy(homework_week(test.person('Jordan'), '2026-10-28', 3)),
               '10-28 16:00-16:30 Visit | 10-28 16:30-17:15 Piano | 10-29 16:00-17:00 Practice | 10-30 16:00-17:00 Swim | 10-30 17:00-17:30',
               'homework_week (the Homework page''s week strip): the same busy blocks');
:as_anon
select test.is(pg_temp.busy(tutor_view_by_token(pg_temp.pat()) -> 'week'),
               '10-28 16:00-16:30 | 10-28 16:30-17:15 | 10-29 16:00-17:00 | 10-30 16:00-17:00 | 10-30 17:00-17:30',
               'the tutor''s week: the same blocks, without titles');
select test.is((select count(*) from jsonb_array_elements(tutor_view_by_token(pg_temp.pat()) -> 'week') d, jsonb_array_elements(d -> 'busy') b where b ? 'title'),
               0::bigint, '... no busy block of his week has a title');
-- The coach view: none of the twelve (a sorted row never has a person in charge), exactly as with the switch off.
create temp table coach_on as select coach_view_by_token(pg_temp.pat()) as j;
select test.ok((select j is not null and j ? 'calendar' from coach_on), 'the coach view is on for Pat''s link');
select test.is((select count(*) from coach_on, jsonb_array_elements(j -> 'calendar') x
                where x ->> 'title' in ('Piano', 'Furnace check', 'Visit', 'Movie', 'Practice', 'Field trip', 'Vet', 'Swim', 'Private item', 'Dinner', 'Tea')
                  and (x ->> 'day')::date between '2026-10-28' and '2026-10-30'), 0::bigint,
               'coach view: none of the wall''s twelve events');
:as_admin
update calendars set sort_by_guest = false where label = 'Hearth';
:as_anon
select test.is(coach_view_by_token(pg_temp.pat()), (select j from coach_on), '... exactly its answer with the switch off');
:as_admin
update calendars set sort_by_guest = true where label = 'Hearth';
:as_service
select pg_temp.store('Hearth', pg_temp.events());

-- ---------------------------------------------------------------------
-- A person off the family list: made inactive, then removed
-- ---------------------------------------------------------------------
:as_owner
update people set active = false where name = 'Jordan';
:as_service
select test.is(pg_temp.em('Alex'), 'Dinner · Taylor | Field trip | Movie | Piano | Practice · Sam | Private item (4:30pm) | Private item (5:00pm) | Swim | Tea | Vet · Taylor | Visit',
               'Jordan made inactive: his tags reach the grown-ups (Piano, Field trip and the private one in Alex''s email; Practice as Sam''s and the grown-ups'')');
select test.is(pg_temp.em('Sam'), 'Dinner · Taylor | Field trip | Furnace check | Movie | Piano | Practice | Private item (4:30pm) | Private item (5:00pm) | Swim | Tea | Vet · Taylor | Visit',
               '... and Sam''s (Practice his, with no other name)');
:as_adult
select test.is((select string_agg(pg_temp.lbl(g) || ' ' || coalesce(g.category, '-'), ', ' order by pg_temp.lbl(g)) from google_items('2026-10-28', '2026-10-30') g
                where pg_temp.mine(g) and pg_temp.lbl(g) in ('Piano', 'Practice', 'Swim')),
               'Piano grown_ups, Practice grown_ups, Swim grown_ups', '... their rows are the grown-ups''');
select test.is(pg_temp.tags(), 'dogs grown_ups -, familyanddogs family -, grandma - -, jordan person Jordan, sam person Sam, taylor person Taylor',
               '... and his match is kept');
:as_owner
update people set active = true where name = 'Jordan';
select test.is(pg_temp.gf('Jordan', false), 'Dinner, Field trip, Piano, Practice, Private (tags sent), Swim, Visit', 'back on the family list: his events are his again');
select test.is(pg_temp.gf('Alex', true), 'Dinner, Movie, Private (as Google sends it), Swim, Tea, Vet, Visit', '... and not Alex''s');
begin;
:as_owner
create temp table gone_person as select test.person('Taylor') as id;
grant select on gone_person to public;
:as_admin
select remove_person(test.person('Taylor'));
select test.is(pg_temp.tags(), 'dogs grown_ups -, familyanddogs family -, grandma - -, jordan person Jordan, sam person Sam, taylor person -',
               'a person matched and then removed (remove_person): the tag is kept, matched_to still ''person'', person_id null');
select test.is((select string_agg(pg_temp.lbl(g) || ' ' || coalesce(array_length(g.participant_ids, 1)::text, '0') || ' ' || coalesce(g.category, '-'), ', ' order by pg_temp.lbl(g))
                from google_items('2026-10-28', '2026-10-30') g where pg_temp.mine(g) and pg_temp.lbl(g) in ('Vet', 'Dinner')),
               'Dinner 0 family, Vet 0 grown_ups', '... it reaches the grown-ups (Vet the grown-ups'' only; Dinner still Family''s)');
:as_admin
select test.is(pg_temp.run($$select public.set_hearth_tag(pg_temp.tag('taylor'), 'person', '$$ || (select id from gone_person) || $$')$$),
               '22023 Choose someone on the family list.', '... a removed person can''t be chosen again');
rollback;

-- ---------------------------------------------------------------------
-- The switch off: at once a read-only Family calendar's rule (0003), with the guests still cached
-- ---------------------------------------------------------------------
:as_admin
update calendars set sort_by_guest = false where label = 'Hearth';
:as_adult
select test.is((select string_agg(distinct coalesce(array_length(g.participant_ids, 1)::text, '0') || ' ' || g.category || ' ' || coalesce(g.responsible_id::text, '-'), ', ')
                from google_items('2026-10-28', '2026-10-30') g where pg_temp.mine(g)),
               '0 family -', 'switch off: every row is a Family calendar''s (nobody in charge, nobody along, ''family'')');
:as_owner
select test.is(pg_temp.gf('Alex', true), 'Dinner, Field trip, Furnace check, Movie, Piano, Practice, Private (as Google sends it), Private (tags sent), Swim, Tea, Vet, Visit',
               '... a parent''s email gets all twelve');
select test.is(concat_ws(' ', coalesce(pg_temp.gf('Jordan', false), 'none'), coalesce(pg_temp.gf('Taylor', false), 'none'), coalesce(pg_temp.gf('Sam', false), 'none')),
               'none none none', '... Jordan, Taylor and Sam''s My day get none (Show to kids is off)');
select test.is((select count(*) from google_events where calendar_id = pg_temp.cal('Hearth') and guests <> '{}'), 10::bigint, '... and the guests are still cached');
select test.is(pg_temp.tags(), 'dogs grown_ups -, familyanddogs family -, grandma - -, jordan person Jordan, sam person Sam, taylor person Taylor', '... and the matches kept');
:as_admin
select test.is(pg_temp.run($$update public.calendars set for_kids = true where label = 'Hearth'$$), 'ok', '... Show to kids can be turned on again');
:as_owner
select test.is(pg_temp.gf('Jordan', false), 'Dinner, Field trip, Furnace check, Movie, Piano, Practice, Private (as Google sends it), Private (tags sent), Swim, Tea, Vet, Visit',
               '... and then a kid gets all twelve, never sorted (0003''s rule)');
:as_admin
update calendars set sort_by_guest = true where label = 'Hearth';
select test.is((select for_kids from calendars where label = 'Hearth'), false, 'turning the switch on again turns Show to kids off');
:as_owner
select test.is(pg_temp.gf('Jordan', false), 'Dinner, Field trip, Piano, Practice, Private (tags sent), Swim, Visit', '... and the matches apply at once');
:as_service
select pg_temp.store('Hearth', pg_temp.events());

-- ---------------------------------------------------------------------
-- set_hearth_tag: refusals, and Forget
-- ---------------------------------------------------------------------
:as_admin
select test.is(pg_temp.run($$select public.set_hearth_tag(pg_temp.tag('grandma'), 'someone')$$), '22023 Choose a person, Family or the grown-ups.',
               'set_hearth_tag: an unknown p_to is refused (22023)');
select test.is(pg_temp.run($$select public.set_hearth_tag(pg_temp.tag('grandma'), null)$$), '22023 Choose a person, Family or the grown-ups.', '... and a null one');
select test.is(pg_temp.run($$select public.set_hearth_tag(gen_random_uuid(), 'family')$$), '22023 That Hearth person isn''t there any more.', '... an unknown p_id');
select test.is(pg_temp.run($$select public.set_hearth_tag(pg_temp.tag('grandma'), 'person')$$), '22023 Choose someone on the family list.', '... ''person'' with no person');
select test.is(pg_temp.run($$select public.set_hearth_tag(pg_temp.tag('grandma'), 'person', gen_random_uuid())$$), '22023 Choose someone on the family list.',
               '... ''person'' with someone who isn''t there');
:as_owner
update people set active = false where name = 'Morgan';
:as_admin
select test.is(pg_temp.run($$select public.set_hearth_tag(pg_temp.tag('grandma'), 'person', '$$ || test.person('Morgan') || $$')$$),
               '22023 Choose someone on the family list.', '... ''person'' with someone off the family list (not active)');
:as_owner
update people set active = true where name = 'Morgan';
:as_admin
update calendars set sort_by_guest = false where label = 'Hearth';
select test.is(pg_temp.run($$select public.set_hearth_tag(pg_temp.tag('grandma'), 'grown_ups')$$), '22023 Turn on Sort by Hearth person first.',
               '... while the calendar''s switch is off');
select test.is(pg_temp.run($$select public.set_hearth_tag(pg_temp.tag('grandma'), 'forget')$$), '22023 Turn on Sort by Hearth person first.', '... Forget too');
update calendars set sort_by_guest = true where label = 'Hearth';
:as_adult
select test.is(pg_temp.run($$select public.set_hearth_tag(pg_temp.tag('grandma'), 'grown_ups')$$), '42501 Only a parent can match Hearth people.', '... Sam (an adult member): 42501');
:as_stranger
select test.is(pg_temp.run($$select public.set_hearth_tag(gen_random_uuid(), 'grown_ups')$$), '42501 Only a parent can match Hearth people.', '... someone not on the family list');
:as_anon
select test.is(test.can($$select public.set_hearth_tag(gen_random_uuid(), 'grown_ups')$$), 'denied', '... anon may not call it');
:as_service
select test.is(test.can($$select public.set_hearth_tag(gen_random_uuid(), 'grown_ups')$$), 'denied', '... nor hub-jobs (service_role)');
:as_owner
select test.is(pg_temp.tags(), 'dogs grown_ups -, familyanddogs family -, grandma - -, jordan person Jordan, sam person Sam, taylor person Taylor', '... and none of them changed anything');
:as_admin
select test.is(set_hearth_tag(pg_temp.tag('sam'), 'forget'), jsonb_build_object('id', pg_temp.tag('sam'), 'name', 'sam', 'to', 'forget'),
               'Forget: answers {id, name, to: ''forget''}');
select test.is(pg_temp.tags(), 'dogs grown_ups -, familyanddogs family -, grandma - -, jordan person Jordan, taylor person Taylor', '... and deletes the row');
:as_adult
select test.is((select string_agg(pg_temp.lbl(g) || ' ' || coalesce((select string_agg(p.name, ',') from unnest(g.participant_ids) u (id) join people p on p.id = u.id), '-')
                                  || ' ' || coalesce(g.category, '-'), ', ' order by pg_temp.lbl(g))
                from google_items('2026-10-28', '2026-10-30') g where pg_temp.mine(g) and pg_temp.lbl(g) in ('Furnace check', 'Practice')),
               'Furnace check - grown_ups, Practice Jordan grown_ups', '... its events reach the grown-ups (a tag the calendar doesn''t list), the other tags still theirs');
:as_service
select pg_temp.store('Hearth', pg_temp.events());
select test.is(pg_temp.tags(), 'dogs grown_ups -, familyanddogs family -, grandma - -, jordan person Jordan, sam - -, taylor person Taylor',
               '... the next read with guests lists it again, as New');
:as_admin
select set_hearth_tag(pg_temp.tag('sam'), 'person', test.person('Sam'));

-- ---------------------------------------------------------------------
-- calendar_store_events: the guests and the tag list (§11.2)
-- ---------------------------------------------------------------------
:as_service
-- Guests are kept only on a sorted calendar.
begin;
select pg_temp.store('Family account', jsonb_build_array(pg_temp.ev('club1', 'Book club', '2026-10-29T00:00:00Z', '2026-10-29T01:30:00Z',
                                                                    '{"guests": ["jordan@team-example-0000"]}')));
select test.is((select guests::text from google_events where event_id = 'club1'), '{}', 'store: guests sent for a calendar that isn''t sorted are stored ''{}''');
select test.is((select count(*) from hearth_tags where calendar_id = pg_temp.cal('Family account')), 0::bigint, '... and it lists no tags');
rollback;
-- Cleaned: trimmed and lowercased, only Hearth-shaped addresses, distinct, sorted.
begin;
select pg_temp.store('Hearth', jsonb_build_array(pg_temp.ev('mixed1', 'Mixed', '2026-10-28T13:00:00Z', '2026-10-28T13:30:00Z',
  jsonb_build_object('guests', jsonb_build_array(' Jordan@Team-Example-0000 ', 'jordan@team-example-0000.com', 'alex@example.com', '', 5, null, true,
                                                 jsonb_build_object('email', 'sam@team-example-0000'), jsonb_build_array('sam@team-example-0000'),
                                                 'jordan@team-example-0000', 'pat lee@team-example-0000', 'taylor@team.example')))));
select test.is((select guests::text from google_events where event_id = 'mixed1'), '{jordan@team-example-0000}',
               'store: tags are trimmed and lowercased; a dotted domain, a real-looking address, an empty or non-string entry are dropped; duplicates once');
rollback;
begin;
select pg_temp.store('Hearth', jsonb_build_array(pg_temp.ev('crowd1', 'Party', '2026-10-28T13:00:00Z', '2026-10-28T13:30:00Z',
  jsonb_build_object('guests', (select jsonb_agg('kid' || lpad(n::text, 2, '0') || '@team-example-0000' order by n desc) from generate_series(1, 17) n)))));
select test.is((select cardinality(guests) || ' ' || guests[1] || ' ' || guests[16] from google_events where event_id = 'crowd1'),
               '16 kid01@team-example-0000 kid16@team-example-0000', 'store: 17 tags → the first 16, sorted');
rollback;
-- p_seen's entries are never read for guests, and don't make a read "with guests". (Twenty minutes after the last read.)
:as_owner
set hub.now = '2026-10-27 09:20 America/New_York';
:as_service
begin;
select pg_temp.store('Hearth', (select jsonb_agg(e) from wall_plain where e ->> 'id' = 'piano1'),
                     jsonb_build_array(pg_temp.ev('seen1', 'Seen', '2026-10-28T13:00:00Z', '2026-10-28T13:30:00Z', '{"guests": ["sam@team-example-0000"]}'),
                                       pg_temp.ev('hh' || md5('wall-1'), 'Hub event', '2026-10-28T13:00:00Z', '2026-10-28T13:30:00Z',
                                                  '{"guests": ["sam@team-example-0000"], "props": {"homehub": "1"}}')));
select test.is((select string_agg(event_id || ' ' || guests::text, ', ' order by event_id) from google_events where calendar_id = pg_temp.cal('Hearth')),
               'piano1 {}, seen1 {}', 'store: guests on an entry of p_seen are ignored (the hub''s own is never cached)');
select test.is((select read_at from calendars where label = 'Hearth') < private.now() - interval '1 second', true,
               '... a guests key in p_seen doesn''t make it a read with guests (read_at stays)');
rollback;
-- A sorted calendar read without guests: its events are stored, with '{}', but it stays due and the tags aren't touched.
create temp table before_plain as select read_at, (select jsonb_object_agg(tag, last_seen) from hearth_tags) as seen from calendars where label = 'Hearth';
begin;
select test.is(pg_temp.store('Hearth', (select jsonb_agg(e order by e ->> 'id') from wall_plain)),
               '{"kept": 12, "skipped": 0, "seen": 0, "repaired": 0, "adopted": 0}'::jsonb, 'a sorted calendar''s read without guests: the events are stored ...');
select test.is((select count(*) || ' ' || count(*) filter (where guests = '{}') from google_events where calendar_id = pg_temp.cal('Hearth')), '12 12', '... each with ''{}''');
select test.is((select read_at = (select read_at from before_plain) and checked_at = private.now() from calendars where label = 'Hearth'), true,
               '... read_at stays as it was (checked_at moves)');
select test.is((select jsonb_object_agg(tag, last_seen) from hearth_tags), (select seen from before_plain), '... and the tags aren''t touched (last_seen as it was)');
:as_owner
set hub.now = '2026-10-27 09:21 America/New_York';
:as_service
select test.is((select bool_or(c.label = 'Hearth') from calendar_read_due() d join calendars c on c.id = d.calendar_id), true, '... so it stays due, and the next run reads it again');
:as_owner
select test.is(pg_temp.gf('Jordan', false), null, '... until then every event is the grown-ups'' (fails closed)');
rollback;
-- ... whereas a read with guests sets read_at, and refreshes last_seen.
begin;
select pg_temp.store('Hearth', pg_temp.events());
select test.is((select read_at = private.now() from calendars where label = 'Hearth'), true, 'a read with guests sets read_at');
select test.is((select bool_and(last_seen = private.now()) from hearth_tags), true, '... and last_seen of every tag on a kept event');
:as_owner
set hub.now = '2026-10-27 09:21 America/New_York';
:as_service
select test.is((select bool_or(c.label = 'Hearth') from calendar_read_due() d join calendars c on c.id = d.calendar_id), false, '... so it isn''t due a minute later');
rollback;
-- A read with no events at all is a read with guests.
begin;
select pg_temp.store('Hearth', '[]');
select test.is((select read_at = private.now() from calendars where label = 'Hearth'), true, 'an empty read counts as a read with guests (read_at set)');
rollback;
:as_owner
set hub.now = '2026-10-27 09:00 America/New_York';
:as_service
-- last_seen never moves back: a clock set before a stored last_seen.
begin;
:as_owner
update hearth_tags set last_seen = '2026-11-02 12:00+00' where name = 'jordan';
:as_service
select test.is(pg_temp.store('Hearth', pg_temp.events()) ->> 'kept', '12', 'with hub.now before a stored last_seen, the store succeeds ...');
select test.is((select last_seen = '2026-11-02 12:00+00' from hearth_tags where name = 'jordan'), true, '... and that last_seen doesn''t move back');
select test.is((select bool_and(last_seen = private.now()) from hearth_tags where name <> 'jordan'), true, '... the others move to the read''s time');
rollback;
-- A cut-off read adds and refreshes, and deletes nothing.
begin;
:as_owner
update hearth_tags set last_seen = private.now() - interval '100 days' where name in ('grandma', 'dogs');
:as_service
select pg_temp.store('Hearth', jsonb_build_array(pg_temp.ev('new1', 'Lunch', '2026-10-28T16:00:00Z', '2026-10-28T17:00:00Z', '{"guests": ["robin@team-example-0000"]}')),
                     '[]', false);
select test.is(pg_temp.tags(), 'dogs grown_ups -, familyanddogs family -, grandma - -, jordan person Jordan, robin - -, sam person Sam, taylor person Taylor',
               'a cut-off read (p_complete false): a new tag is added, none deleted (not even ones unseen for 100 days)');
rollback;
-- The 90-day rule: after a complete read, New, the grown-ups' and a removed person's tags not seen for 90 days go;
-- a tag matched to a person (on the family list or not) or to Family is kept.
begin;
:as_owner
insert into hearth_tags (calendar_id, tag, matched_to, person_id, last_seen, matched_at, matched_by)
values (pg_temp.cal('Hearth'), 'gone@team-example-0000', 'person', null, private.now() - interval '91 days', private.now() - interval '200 days', 'alex@example.com'),
       (pg_temp.cal('Hearth'), 'recent@team-example-0000', null, null, private.now() - interval '89 days', null, null);
update hearth_tags set last_seen = private.now() - interval '91 days' where name in ('grandma', 'dogs', 'jordan', 'familyanddogs');
update people set active = false where name = 'Sam';
update hearth_tags set last_seen = private.now() - interval '91 days' where name = 'sam';
:as_service
select pg_temp.store('Hearth', '[]', '[]', false);
select test.is((select count(*) from hearth_tags), 8::bigint, 'the 90-day rule: not after a cut-off read');
:as_admin
update calendars set sort_by_guest = false where label = 'Hearth';
:as_service
select pg_temp.store('Hearth', '[]');
select test.is((select count(*) from hearth_tags), 8::bigint, '... never while the switch is off');
:as_admin
update calendars set sort_by_guest = true where label = 'Hearth';
:as_service
select pg_temp.store('Hearth', '[]');
select test.is(pg_temp.tags(), 'familyanddogs family -, jordan person Jordan, recent - -, sam person Sam, taylor person Taylor',
               '... after a complete read with guests: New (grandma), the grown-ups'' (dogs) and a removed person''s (gone) unseen for 91 days are deleted; '
               '89 days is kept; matched to a person (Sam, off the family list) or Family kept');
rollback;
begin;
:as_owner
update hearth_tags set last_seen = private.now() - interval '91 days' where name in ('grandma', 'dogs');
:as_service
select pg_temp.store('Hearth', pg_temp.events());
select test.is((select count(*) from hearth_tags), 6::bigint, '... a tag on a kept event is refreshed first, so never deleted');
rollback;
-- The 50-row cap.
begin;
:as_owner
insert into hearth_tags (calendar_id, tag, last_seen)
select pg_temp.cal('Hearth'), 'extra' || lpad(n::text, 2, '0') || '@team-example-0000', private.now() from generate_series(1, 43) n;
:as_service
select pg_temp.store('Hearth', pg_temp.events() || jsonb_build_array(pg_temp.ev('new2', 'Picnic', '2026-10-28T16:00:00Z', '2026-10-28T17:00:00Z',
                     '{"guests": ["zed@team-example-0000", "robin@team-example-0000", "quinn@team-example-0000"]}')));
select test.is((select count(*) || ' ' || string_agg(name, ',' order by name) filter (where name in ('quinn', 'robin', 'zed')) from hearth_tags), '50 quinn',
               'the 50 cap: with 49 listed, of three new tags only the first in tag order is added');
select test.is((select guests::text from google_events where event_id = 'new2'), '{quinn@team-example-0000,robin@team-example-0000,zed@team-example-0000}',
               '... the event still carries all three');
:as_owner
select test.is((select coalesce(array_length(g.participant_ids, 1), 0) || ' ' || g.category from google_items('2026-10-28', '2026-10-28') g where g.title = 'Picnic'),
               '0 grown_ups', '... and reaches the grown-ups through the ones not listed');
:as_service
select pg_temp.store('Hearth', pg_temp.events() || jsonb_build_array(pg_temp.ev('new3', 'Picnic', '2026-10-28T16:00:00Z', '2026-10-28T17:00:00Z',
                     '{"guests": ["ann@team-example-0000"]}')));
select test.is((select count(*) from hearth_tags), 50::bigint, '... at 50, a new tag isn''t listed');
rollback;
-- Nothing about tags can fail a store: a trigger that raises on hearth_tags.
begin;
:as_owner
create function pg_temp.no_tags() returns trigger language plpgsql as $$ begin raise exception 'tags are broken'; end; $$;
create trigger no_tags before insert or update or delete on public.hearth_tags for each row execute function pg_temp.no_tags();
:as_service
select test.is(pg_temp.store('Hearth', pg_temp.events() || jsonb_build_array(pg_temp.ev('new4', 'Lunch', '2026-10-28T16:00:00Z', '2026-10-28T17:00:00Z',
                                                                                         '{"guests": ["robin@team-example-0000"]}'))),
               '{"kept": 13, "skipped": 0, "seen": 0, "repaired": 0, "adopted": 0}'::jsonb, 'a tag list that fails: the store answers as usual ...');
select test.is((select guests::text from google_events where event_id = 'new4'), '{robin@team-example-0000}', '... the events are stored, with their tags');
select test.is(pg_temp.tags(), 'dogs grown_ups -, familyanddogs family -, grandma - -, jordan person Jordan, sam person Sam, taylor person Taylor',
               '... and the tag list is as it was');
rollback;

-- ---------------------------------------------------------------------
-- calendars: the checks and the tidy trigger (§11.2)
-- ---------------------------------------------------------------------
:as_owner
select test.is((select string_agg(pg_get_constraintdef(c.oid), ' | ' order by pg_get_constraintdef(c.oid)) from pg_constraint c
                where c.conrelid = 'public.calendars'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%sort_by_guest%'),
               'CHECK (((NOT sort_by_guest) OR ((kind = ''family''::text) AND (NOT writes)))) | CHECK ((NOT (sort_by_guest AND for_kids)))',
               'calendars: two checks: only a calendar the hub reads as Family is sorted, and never with Show to kids');
begin;
alter table public.calendars disable trigger calendars_tidy;
select test.throws($$insert into public.calendars (google_id, kind, person_id, label, writes, sort_by_guest) values ('hub-wall@group.calendar.google.com', 'person', test.person('Sam'), 'Wall', true, true)$$,
                   'violates check constraint', '... the first check (seen with the tidy trigger off: the trigger turns it off first)');
rollback;
select test.throws($$insert into public.calendars (google_id, kind, label, writes, for_kids, sort_by_guest) values ('wall@example.com', 'family', 'Wall', false, true, true)$$,
                   'violates check constraint', '... the second check');
:as_admin
select test.is(pg_temp.run($$update public.calendars set for_kids = true where label = 'Hearth'$$), '22023 Turn off Sort by Hearth person first.',
               'tidy: Show to kids on a sorted calendar (a tab opened before the switch went on) is refused, 22023');
begin;
update calendars set sort_by_guest = false where label = 'Hearth';
update calendars set for_kids = true where label = 'Hearth';
update calendars set sort_by_guest = true where label = 'Hearth';
select test.is((select sort_by_guest || ' ' || for_kids from calendars where label = 'Hearth'), 'true false', 'tidy: turning the switch on turns Show to kids off');
rollback;
begin;
update calendars set kind = 'person', person_id = test.person('Jordan') where label = 'Hearth';
select test.is((select kind || ' ' || sort_by_guest from calendars where label = 'Hearth'), 'person false', 'tidy: changing Whose to a person turns the switch off');
rollback;
begin;
:as_owner
delete from calendars where label = 'Family';
:as_admin
update calendars set writes = true where label = 'Hearth';
select test.is((select writes || ' ' || sort_by_guest || ' ' || status from calendars where label = 'Hearth'), 'true false new', 'tidy: switching it to writing turns the switch off');
rollback;
begin;
create temp table cal_before as select updated_at, read_at from calendars where label = 'Hearth';
update calendars set sort_by_guest = false where label = 'Hearth';
select test.is((select concat_ws(' ', read_at is null, updated_at > (select updated_at from cal_before), updated_by) from calendars where label = 'Hearth'),
               't t alex@example.com', 'tidy: a change of the switch clears read_at and counts as an admin''s edit (updated_at moves)');
rollback;
:as_service
create temp table cal_job as select updated_at, updated_by from calendars where label = 'Hearth';
select pg_temp.store('Hearth', pg_temp.events());
select test.is((select updated_at = (select updated_at from cal_job) from calendars where label = 'Hearth'), true, '... the job''s own writes don''t move updated_at');
-- A new Google ID keeps the matches and hides the old cache; Disconnect deletes the tags.
begin;
:as_admin
update calendars set google_id = 'hearth-0001@group.calendar.google.com' where label = 'Hearth';
select test.is((select sort_by_guest || ' ' || status from calendars where label = 'Hearth'), 'true new', 'a new Google ID: still sorted, not read yet');
select test.is((select count(*) from google_items('2026-10-28', '2026-10-30') g where pg_temp.mine(g)), 0::bigint, '... the old calendar''s events stop showing at once');
select test.is((select count(*) from hearth_tags), 6::bigint, '... and the matches are kept');
rollback;
begin;
:as_admin
delete from calendars where label = 'Hearth';
:as_owner
select test.is((select count(*) || ' ' || (select count(*) from google_events where google_calendar like 'hearth%') from hearth_tags), '0 0',
               'Disconnect: the tags and matches go with the calendar (and its cached events)');
rollback;

-- calendar_read_due: a calendar just switched is first.
:as_admin
update calendars set sort_by_guest = false where label = 'Hearth';
:as_service
select test.is((select string_agg(c.label || ' ' || d.sort_by_guest, ', ') from calendar_read_due() d join calendars c on c.id = d.calendar_id), 'Hearth false',
               'calendar_read_due: a calendar just switched off is due (read_at cleared)');
:as_admin
update calendars set sort_by_guest = true where label = 'Hearth';
:as_service
select test.is((select c.label || ' ' || d.sort_by_guest from calendar_read_due(true, 10) d join calendars c on c.id = d.calendar_id limit 1), 'Hearth true',
               '... and first, even with Sync now (every calendar)');
select pg_temp.store('Hearth', pg_temp.events());

-- ---------------------------------------------------------------------
-- Privileges and row-level security (§11.2, §11.5, §11.7)
-- ---------------------------------------------------------------------
:as_owner
insert into test.samples (tbl, ins, upd) values
  ('hearth_tags', $$insert into public.hearth_tags (calendar_id, tag, last_seen) select id, 'robin@team-example-0000', now() from public.calendars where label = 'Hearth'$$,
                  $$update public.hearth_tags set last_seen = last_seen$$);
select test.is((select relrowsecurity from pg_class where oid = 'public.hearth_tags'::regclass), true, 'hearth_tags has row-level security');
select test.is((select string_agg(policyname || ' ' || cmd || ' ' || array_to_string(roles, ','), ', ') from pg_policies where tablename = 'hearth_tags'),
               'Family can see the Hearth people SELECT authenticated', '... one policy: members select (no write policy)');
:as_anon
select test.matrix('anon', 'hearth_tags', 'denied', 'denied', 'denied', 'denied');
:as_stranger
select test.matrix('stranger', 'hearth_tags', 'rows:0', 'denied', 'denied', 'denied');
:as_removed
select test.matrix('removed', 'hearth_tags', 'rows:0', 'denied', 'denied', 'denied');
:as_adult
select test.matrix('adult', 'hearth_tags', 'rows:6', 'denied', 'denied', 'denied');
:as_admin
select test.matrix('admin', 'hearth_tags', 'rows:6', 'denied', 'denied', 'denied');
:as_service
select test.matrix('service', 'hearth_tags', 'rows:6', 'rows:1', 'rows:6', 'rows:6');
:as_owner
select test.is((select string_agg(r || ':' || p, ' ' order by r, p) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
                where has_table_privilege(r, 'public.hearth_tags', p)), 'authenticated:select', 'hearth_tags: anon has no privilege; signed-in users select only');
select test.is((select has_column_privilege('authenticated', 'public.calendars', 'sort_by_guest', 'update') || ' ' ||
                       has_column_privilege('authenticated', 'public.calendars', 'sort_by_guest', 'insert') || ' ' ||
                       has_column_privilege('anon', 'public.calendars', 'sort_by_guest', 'select')),
               'true false false', 'calendars.sort_by_guest: signed-in users may update it (admins only, by policy), not insert it; anon nothing');
select test.is((select has_column_privilege('authenticated', 'public.google_events', 'guests', 'update') || ' ' || has_column_privilege('authenticated', 'public.google_events', 'guests', 'select')),
               'false true', 'google_events.guests: members read it (row-level security decides), nobody writes it but hub-jobs');
select test.is((select string_agg(p.oid::regprocedure::text || ' ' || p.prosecdef || ' ' || p.provolatile::text || ' ' || array_to_string(p.proconfig, ',')
                                  || ' ' || (select string_agg(r || ':' || has_function_privilege(r, p.oid, 'execute'), ' ' order by r)
                                             from unnest(array['public', 'anon', 'authenticated', 'service_role']) r), ' | ' order by p.oid::regprocedure::text)
                from pg_proc p where p.oid in ('public.set_hearth_tag(uuid, text, uuid)'::regprocedure, 'private.hearth_tag(text)'::regprocedure,
                                               'private.hearth_whose(public.google_events, public.calendars)'::regprocedure)),
               'private.hearth_tag(text) false i search_path="" anon:false authenticated:false public:false service_role:true | '
               'private.hearth_whose(google_events,calendars) false s search_path="" anon:false authenticated:true public:false service_role:true | '
               'set_hearth_tag(uuid,text,uuid) true v search_path="" anon:false authenticated:true public:false service_role:false',
               'the three new functions: only set_hearth_tag is a definer; set_hearth_tag for signed-in users, hearth_whose for members and hub-jobs, hearth_tag for hub-jobs only; each sets search_path = ''''');
select test.is((select string_agg(p.oid::regprocedure::text || ' ' || p.prosecdef || ' ' || array_to_string(p.proconfig, ',')
                                  || ' ' || (select string_agg(r || ':' || has_function_privilege(r, p.oid, 'execute'), ' ' order by r)
                                             from unnest(array['anon', 'authenticated', 'service_role']) r), ' | ' order by p.oid::regprocedure::text)
                from pg_proc p where p.oid in ('public.calendar_read_due(boolean, int)'::regprocedure,
                                               'public.calendar_store_events(uuid, text, date, date, text, text, boolean, jsonb, jsonb)'::regprocedure,
                                               'private.google_item(public.google_events, public.calendars)'::regprocedure,
                                               'private.google_for(uuid, date, date, boolean)'::regprocedure, 'private.calendars_tidy()'::regprocedure)),
               'calendar_read_due(boolean,integer) false search_path="" anon:false authenticated:false service_role:true | '
               'calendar_store_events(uuid,text,date,date,text,text,boolean,jsonb,jsonb) false search_path="" anon:false authenticated:false service_role:true | '
               'private.calendars_tidy() false search_path="" anon:false authenticated:false service_role:false | '
               'private.google_for(uuid,date,date,boolean) false search_path="" anon:false authenticated:true service_role:true | '
               'private.google_item(google_events,calendars) false search_path="" anon:false authenticated:true service_role:true',
               'the replaced and remade ones keep 0003''s rules: none a definer, search_path = ''''; calendar_read_due and calendar_store_events hub-jobs'' only');
select test.is(private.hearth_tag('  Jordan@Team-Example-0000 ') || ' ' || coalesce(private.hearth_tag('jordan@team-example-0000.com'), '-') || ' '
               || coalesce(private.hearth_tag('alex@example.com'), '-') || ' ' || coalesce(private.hearth_tag(''), '-') || ' ' || coalesce(private.hearth_tag(null), '-'),
               'jordan@team-example-0000 - - - -', 'private.hearth_tag: a Hearth-shaped address, trimmed and lowercased; anything else null');
:as_admin
select test.is(test.can($$select private.hearth_tag('jordan@team-example-0000')$$), 'denied', 'members may not call private.hearth_tag');
select test.is(test.can($$select private.hearth_whose(g, c) from public.google_events g join public.calendars c on c.id = g.calendar_id$$), 'ok',
               '... but may call private.hearth_whose (google_item runs with their rights)');
:as_anon
select test.is(test.can($$select private.hearth_whose(null::public.google_events, null::public.calendars)$$), 'denied', 'anon may not call private.hearth_whose');
:as_owner
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
                  and p.proname in ('set_hearth_tag', 'hearth_tag', 'hearth_whose', 'google_item', 'google_for', 'calendars_tidy', 'calendar_store_events', 'calendar_read_due')),
               'set_hearth_tag', 'of the functions 0010 adds, replaces or makes again, set_hearth_tag is the only definer');
select test.is(hub_schema_version(), 10, 'hub_schema_version is 10');
