-- The coach view (migration 0007, docs/v1.3-homework.md §20): a per-link switch, tutor_links.coach, off by
-- default and set only by the parents (set_tutor_coach). With it off nothing changes for the link (its
-- view has no new key, and the two coach functions answer null and write nothing). With it on, the link
-- also reads (coach_view_by_token, read-only) the kid's points (balance, this week's and last week's by
-- kind, the last 30 days of ledger lines without who wrote them), his rewards and his asks and cash-ins,
-- his focus sessions of the last 30 days, his own calendar (the last 7 and next 14 days of the events and
-- Google events he is in charge of, or is the only one on with nobody in charge; private ones as "Private
-- item") and his daily tasks (his My day tasks of today and the last 7 days, done or not), and may leave the
-- parents a note (coach_note_by_token), which only the parents read and mark done (coach_note_done).
-- Nothing of anyone else: the household is seeded with other people's events and tasks that overlap his
-- (a family dinner he is along on, a movie night with another kid, a weekly class someone else is in
-- charge of except on one day), a second kid with his own homework, points and tutor link, dinners, the
-- shopping list and a directory entry with a phone number. Then the tutor-link rules (Off, the end date,
-- New link, homework off), the caps and retention of the notes, Erase, and the privileges.
-- The household is fixtures.sql's: Alex (admin), Sam (adult), Taylor (the kid with homework), Morgan
-- (the helper); plus Robin, a second kid. The tutor is only a link's label, "Pat Lee, tutor".
-- hub.now is Wed Nov 4, 2026, 5:30pm (America/New_York) unless a case moves it: this week is Mon Nov 2 to
-- Sun Nov 8, last week Mon Oct 26 to Sun Nov 1 (the clocks went back on Nov 1).
\ir roles.sql
\ir fixtures.sql

:as_owner
set hub.now = '2026-11-04 17:30 America/New_York';   -- a Wednesday
insert into people (name, role, sort_order) values ('Robin', 'kid', 5);
-- Runs a statement and keeps what it did: 'ok', or the error's code and message.
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
create function pg_temp.keys(j jsonb) returns text language sql immutable as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(j) k
$$;
-- An array's elements as "f1 f2 …", joined with " | ", in order ('-' for a null).
create function pg_temp.rows(j jsonb, f text[]) returns text language sql immutable as $$
  select string_agg((select string_agg(coalesce(x ->> u.k, '-'), ' ' order by u.o) from unnest(f) with ordinality u (k, o)), ' | ' order by t.n)
  from jsonb_array_elements(j) with ordinality t (x, n)
$$;
-- Every key used anywhere in a value.
create function pg_temp.all_keys(j jsonb) returns text language sql immutable as $$
  with recursive walk (v) as (
    select j
    union all
    select c.v from walk w
    cross join lateral (select e.value from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}' end) e
                        union all
                        select a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]' end) a) c (v)
  )
  select string_agg(distinct k, ',' order by k) from walk w cross join lateral jsonb_object_keys(case when jsonb_typeof(w.v) = 'object' then w.v else '{}' end) k
$$;
create function pg_temp.token(p_label text) returns text language sql stable security definer as $$
  select token from public.tutor_links where label = p_label
$$;
create function pg_temp.lid(p_label text) returns uuid language sql stable security definer as $$
  select id from public.tutor_links where label = p_label
$$;
create function pg_temp.link(p_label text) returns public.tutor_links language sql stable security definer as $$
  select * from public.tutor_links where label = p_label
$$;
create function pg_temp.notes(p_label text) returns int language sql stable security definer as $$
  select count(*)::int from public.coach_notes where link_id = (select id from public.tutor_links where label = p_label)
$$;
create function pg_temp.writes(p_label text) returns int language sql stable security definer as $$
  select coalesce(sum(n), 0)::int from public.homework_use
  where actor_id = (select id from public.tutor_links where label = p_label) and what = 'writes'
$$;

-- ---------------------------------------------------------------------
-- The household: homework on for Taylor and Robin; Pat's link and Casey's (Spanish) for Taylor, Riley's for Robin
-- ---------------------------------------------------------------------
:as_admin
select save_homework_kid(test.person('Taylor'), true);
select save_homework_kid(test.person('Robin'), true);
select save_tutor_link(null, test.person('Taylor'), 'Pat Lee, tutor', 'en', null, true, true);
select save_tutor_link(null, test.person('Taylor'), 'Casey, tutor', 'es', null, false, true);
select save_tutor_link(null, test.person('Robin'), 'Riley, tutor', 'en', null, false, true);
:as_owner
insert into assignments (id, kid_id, title, subject, due_date, given_at, given_by) values
  ('a0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'Science project', 'Science', '2026-11-13', '2026-10-30 20:00+00', 'alex@example.com'),
  ('a0000000-0000-4000-8000-000000000002', test.person('Robin'), 'Robin''s essay', 'English', '2026-11-12', '2026-10-30 20:00+00', 'alex@example.com');
insert into homework_steps (id, assignment_id, pos, kind, title, minutes, day) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 1, 'step', 'Find 2 sources', 20, '2026-11-02'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 1, 'step', 'Robin''s outline', 20, '2026-11-03');

-- His points: this week (Mon Nov 2 to Sun Nov 8) and last week (Oct 26 to Nov 1) of every kind, and one
-- older line (in the balance, not in the last 30 days). Robin's points never show.
insert into points_ledger (id, kid_id, at, day, kind, delta, note, who) values
  ('c0000000-0000-4000-8000-000000000001', test.person('Taylor'), '2026-11-02 21:50+00', '2026-11-02', 'focus', 20, 'Find 2 sources', 'Taylor (My day)'),
  ('c0000000-0000-4000-8000-000000000002', test.person('Taylor'), '2026-11-02 21:50+00', '2026-11-02', 'on_time', 10, 'Find 2 sources', 'Taylor (My day)'),
  ('c0000000-0000-4000-8000-000000000003', test.person('Taylor'), '2026-11-03 22:00+00', '2026-11-03', 'milestone_done', 20, 'Outline', 'Taylor (My day)'),
  ('c0000000-0000-4000-8000-000000000004', test.person('Taylor'), '2026-11-03 23:00+00', '2026-11-03', 'milestone', 20, 'Outline', 'Pat Lee, tutor (tutor link)'),
  ('c0000000-0000-4000-8000-000000000005', test.person('Taylor'), '2026-11-03 23:30+00', '2026-11-03', 'given', 15, 'Great session', 'alex@example.com'),
  ('c0000000-0000-4000-8000-000000000006', test.person('Taylor'), '2026-11-04 21:00+00', '2026-11-04', 'trade', -15, 'Extra game time', 'Taylor (My day)'),
  ('c0000000-0000-4000-8000-000000000008', test.person('Taylor'), '2026-10-27 21:30+00', '2026-10-27', 'focus', 25, 'Read chapter 3', 'Taylor (My day)'),
  ('c0000000-0000-4000-8000-000000000009', test.person('Taylor'), '2026-10-29 21:30+00', '2026-10-29', 'on_time', 10, 'Read chapter 4', 'Taylor (My day)'),
  ('c0000000-0000-4000-8000-000000000010', test.person('Taylor'), '2026-10-30 22:00+00', '2026-10-30', 'given', 30, 'A good week', 'sam@example.com'),
  ('c0000000-0000-4000-8000-000000000011', test.person('Taylor'), '2026-11-01 18:00+00', '2026-11-01', 'trade', -60, 'Pick the movie', 'alex@example.com'),
  ('c0000000-0000-4000-8000-000000000012', test.person('Taylor'), '2026-09-20 18:00+00', '2026-09-20', 'given', 100, 'Starting points', 'alex@example.com'),
  ('c0000000-0000-4000-8000-000000000013', test.person('Robin'), '2026-11-03 18:00+00', '2026-11-03', 'given', 50, 'Robin''s points', 'alex@example.com');
insert into points_ledger (id, kid_id, at, day, kind, delta, note, who, void_of) values
  ('c0000000-0000-4000-8000-000000000007', test.person('Taylor'), '2026-11-04 21:10+00', '2026-11-04', 'void', -10, 'That start was late', 'morgan@example.com',
   'c0000000-0000-4000-8000-000000000002');

-- His rewards (one instant, one off, one suggestion nobody priced) and his asks and cash-ins (one waiting,
-- one cashed today, one approved 15 days ago, one declined two months ago). Robin's are his own.
insert into rewards (id, kid_id, title, cost, active, instant, suggested, sort_order) values
  ('d0000000-0000-4000-8000-000000000001', test.person('Taylor'), 'Extra game time', 15, true, true, false, 1),
  ('d0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'Pick the movie', 200, true, false, false, 2),
  ('d0000000-0000-4000-8000-000000000003', test.person('Taylor'), 'Old prize', 50, false, false, false, 3),
  ('d0000000-0000-4000-8000-000000000004', test.person('Taylor'), 'Skip a chore', null, false, false, true, 4),
  ('d0000000-0000-4000-8000-000000000005', test.person('Robin'), 'Robin''s prize', 30, true, false, false, 1);
insert into reward_asks (kid_id, reward_id, title, cost, status, asked_at, decided_at, decided_by, note) values
  (test.person('Taylor'), 'd0000000-0000-4000-8000-000000000002', 'Pick the movie', 200, 'waiting', '2026-11-03 21:00+00', null, null, null),
  (test.person('Taylor'), 'd0000000-0000-4000-8000-000000000001', 'Extra game time', 15, 'cashed', '2026-11-04 21:00+00', '2026-11-04 21:00+00', 'Taylor (My day)', null),
  (test.person('Taylor'), 'd0000000-0000-4000-8000-000000000002', 'Pick the movie', 200, 'approved', '2026-10-20 21:00+00', '2026-10-21 12:00+00', 'alex@example.com', null),
  (test.person('Taylor'), 'd0000000-0000-4000-8000-000000000002', 'Pick the movie', 200, 'declined', '2026-09-01 21:00+00', '2026-09-02 12:00+00', 'alex@example.com', 'Not this week'),
  (test.person('Robin'), 'd0000000-0000-4000-8000-000000000005', 'Robin''s prize', 30, 'waiting', '2026-11-03 21:00+00', null, null, null);

-- His focus blocks: one on a step (with Pat), one on an assignment (with a parent), one of his own (no
-- homework), one 40 days ago, and one running now; and Robin's.
insert into focus_sessions (id, kid_id, assignment_id, step_id, minutes, with_whom, started_at, ends_at, ended_at, result, seen_minutes, points, note) values
  ('e0000000-0000-4000-8000-000000000001', test.person('Taylor'), null, 'b0000000-0000-4000-8000-000000000001', 20, 'tutor',
   '2026-11-02 21:30+00', '2026-11-02 21:50+00', '2026-11-02 21:48+00', 'done', 18, 28, 'found 2 sources'),
  ('e0000000-0000-4000-8000-000000000002', test.person('Taylor'), 'a0000000-0000-4000-8000-000000000001', null, 15, 'parent',
   '2026-10-27 21:00+00', '2026-10-27 21:15+00', '2026-10-27 21:15+00', 'more', 15, 15, null),
  ('e0000000-0000-4000-8000-000000000003', test.person('Taylor'), null, null, 10, 'alone',
   '2026-11-03 22:00+00', '2026-11-03 22:10+00', '2026-11-03 22:04+00', 'stopped', 4, 0, null),
  ('e0000000-0000-4000-8000-000000000004', test.person('Taylor'), 'a0000000-0000-4000-8000-000000000001', null, 20, 'alone',
   '2026-09-25 21:00+00', '2026-09-25 21:20+00', '2026-09-25 21:20+00', 'done', 20, 20, 'an old block'),
  ('e0000000-0000-4000-8000-000000000006', test.person('Robin'), 'a0000000-0000-4000-8000-000000000002', null, 20, 'alone',
   '2026-11-03 21:00+00', '2026-11-03 21:20+00', '2026-11-03 21:20+00', 'done', 20, 20, 'Robin''s block');
insert into focus_sessions (id, kid_id, assignment_id, step_id, minutes, with_whom, started_at, ends_at) values
  ('e0000000-0000-4000-8000-000000000005', test.person('Taylor'), 'a0000000-0000-4000-8000-000000000001', null, 20, 'alone',
   '2026-11-04 22:20+00', '2026-11-04 22:40+00');

-- His calendar, and everyone else's around it. Today is Wed Nov 4: the coach sees Wed Oct 28 to Tue Nov 17.
insert into events (title, start_date, start_time, end_time, repeat, repeat_weekdays, responsible_id, participant_ids, private,
                    contractor_id, location, notes, end_date) values
  -- His (in charge; Morgan drives him): Tuesdays, cancelled on Nov 10.
  ('Piano lesson', '2026-10-06', '17:00', '17:45', 'weekly', '{2}', test.person('Taylor'), array[test.person('Morgan')], false, null, null, null, null),
  -- Nobody in charge, he is the only one on it.
  ('Swim practice', '2026-11-07', '09:00', '10:00', 'none', '{}', null, array[test.person('Taylor')], false, null, null, null, null),
  -- His, with a directory entry (a phone number), a place and notes: only its title and times show.
  ('Guitar class', '2026-11-02', '16:00', null, 'none', '{}', test.person('Taylor'), '{}', false, test.contractor('Rivera Music'),
   '12 Elm Street', 'Gate code 4321', null),
  -- His, private.
  ('Doctor visit', '2026-11-09', '10:00', '11:00', 'none', '{}', test.person('Taylor'), '{}', true, null, null, null, null),
  -- His, all day over two days.
  ('Science fair', '2026-11-13', null, null, 'none', '{}', test.person('Taylor'), '{}', false, null, null, null, '2026-11-14'),
  -- His, but outside the window (the day before it starts, the day after it ends).
  ('Old club', '2026-10-27', '15:00', '16:00', 'none', '{}', test.person('Taylor'), '{}', false, null, null, null, null),
  ('Far trip', '2026-11-18', '08:00', '09:00', 'none', '{}', test.person('Taylor'), '{}', false, null, null, null, null),
  -- Other people's, with him along: Alex's family dinner (Sam too), a movie night with Robin and nobody in charge.
  ('Family dinner out', '2026-11-06', '18:30', '20:00', 'none', '{}', test.person('Alex'), array[test.person('Taylor'), test.person('Sam')], false, null, null, null, null),
  ('Movie night', '2026-10-31', '19:00', '21:00', 'none', '{}', null, array[test.person('Taylor'), test.person('Robin')], false, null, null, null, null),
  -- Other people's own.
  ('Dentist checkup', '2026-11-05', '15:00', '16:00', 'none', '{}', test.person('Alex'), '{}', false, null, null, null, null),
  ('Recital', '2026-11-08', '14:00', '15:00', 'none', '{}', test.person('Robin'), '{}', false, null, null, null, null),
  -- Sam's weekly class on Thursdays with him along: his only on Nov 12 (he is in charge that day) and on
  -- Oct 29 (nobody in charge, and he is the only one on it that day).
  ('Soccer', '2026-10-01', '16:00', '17:00', 'weekly', '{4}', test.person('Sam'), array[test.person('Taylor')], false, null, null, null, null);
insert into event_changes (event_id, on_date, cancelled, responsible_id, nobody_in_charge, participant_ids) values
  (test.event('Piano lesson'), '2026-11-10', true, null, false, null),
  (test.event('Soccer'), '2026-11-12', false, test.person('Taylor'), false, '{}'),
  (test.event('Soccer'), '2026-10-29', false, null, true, array[test.person('Taylor')]);
-- Google: his own calendar (a timed event and a private one), Alex's, and a Family calendar shown to kids.
insert into calendars (google_id, kind, person_id, label, writes, for_kids, status, access_role) values
  ('taylor.reads@example.com', 'person', test.person('Taylor'), 'Taylor', false, false, 'ok', 'reader'),
  ('alex.reads@example.com', 'person', test.person('Alex'), 'Alex', false, false, 'ok', 'reader'),
  ('family.reads@example.com', 'family', null, 'Family', false, true, 'ok', 'reader');
insert into google_events (calendar_id, google_calendar, event_id, title, all_day, start_day, end_day, start_at, end_at, private, read_at)
select c.id, c.google_id, v.e, v.t, v.a, v.s, v.d, v.sa, v.ea, v.p, now()
from calendars c
join (values ('taylor.reads@example.com', 'g-1', 'Orthodontist', false, date '2026-11-10', date '2026-11-10',
              timestamptz '2026-11-10 19:00+00', timestamptz '2026-11-10 19:30+00', false),
             ('taylor.reads@example.com', 'g-2', '', true, date '2026-11-11', date '2026-11-11', null, null, true),
             ('alex.reads@example.com', 'g-3', 'Work trip', true, date '2026-11-05', date '2026-11-05', null, null, false),
             ('family.reads@example.com', 'g-4', 'School picture day', true, date '2026-11-06', date '2026-11-06', null, null, false))
  v (cal, e, t, a, s, d, sa, ea, p) on v.cal = c.google_id;

-- His daily tasks of the last 7 days and today (Oct 28 to Nov 4), and other people's.
insert into tasks (title, responsible_id, due_date, done_at, done_by, private) values
  ('Feed the cat', test.person('Taylor'), '2026-11-04', null, null, false),
  ('Pack gym bag', test.person('Taylor'), '2026-11-02', '2026-11-02 12:00+00', 'Taylor (My day)', false),
  ('Diary', test.person('Taylor'), '2026-11-01', '2026-11-01 12:00+00', 'Taylor (My day)', true),
  ('Library books', test.person('Taylor'), '2026-11-06', null, null, false),
  ('Recycling', test.person('Sam'), '2026-11-04', null, null, false),
  ('Robin chores', test.person('Robin'), '2026-11-03', null, null, false);
insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit, anchor_date) values
  ('Make bed', test.person('Taylor'), '2026-11-04', 'schedule', 1, 'day', '2026-10-01');
-- The entries the hub wrote while they were his: Make bed's days, and the ticks of his two done one-offs
-- (complete_task writes one for a one-off too).
insert into task_log (task_id, occurrence, status, done_on, done_by) values
  (test.task('Make bed'), '2026-11-03', 'done', '2026-11-03', 'Taylor (My day)'),
  (test.task('Make bed'), '2026-11-02', 'missed', null, null),
  (test.task('Make bed'), '2026-11-01', 'skipped', null, 'alex@example.com'),
  (test.task('Make bed'), '2026-10-20', 'done', '2026-10-20', 'Taylor (My day)'),
  (test.task('Pack gym bag'), '2026-11-02', 'done', '2026-11-02', 'Taylor (My day)'),
  (test.task('Diary'), '2026-11-01', 'done', '2026-11-01', 'Taylor (My day)');

-- What a coach never sees: dinners and the shopping list.
insert into meals (day, kind, title, cook_id) values ('2026-11-04', 'cook', 'Tacos', test.person('Morgan'));
insert into shopping_items (name, added_by) values ('Milk', test.person('Alex'));

-- ---------------------------------------------------------------------
-- The switch: off by default; nothing new for a link with it off
-- ---------------------------------------------------------------------
:as_owner
select test.is((select string_agg(label || ' ' || coach, ', ' order by label) from tutor_links),
               'Casey, tutor false, Pat Lee, tutor false, Riley, tutor false', 'tutor_links.coach: off for every link, new or old');
select test.is((select column_default || ' ' || is_nullable from information_schema.columns
                where table_schema = 'public' and table_name = 'tutor_links' and column_name = 'coach'),
               'false NO', '... a not-null column with default false');
:as_anon
select test.is(pg_temp.keys(tutor_view_by_token(pg_temp.token('Pat Lee, tutor'))),
               'ai,as_of,assignments,ends_on,kid,language,pace,plans,questions,record,server_now,to_check,to_talk_about,today,tutor,week',
               'coach off: the tutor''s view has exactly 0006''s keys (no coach)');
select test.ok(not (tutor_view_by_token(pg_temp.token('Pat Lee, tutor'), 'a0000000-0000-4000-8000-000000000001') ? 'coach'),
               'coach off: ... with an assignment too');
select test.is(coach_view_by_token(pg_temp.token('Pat Lee, tutor')), null, 'coach off: coach_view_by_token answers null');
select test.is(pg_temp.keys(homework_by_token(test.token('Taylor')) -> 'me'), 'cue,first_name,if_stuck,length,lengths,points_on,tutor',
               'coach off: his own view''s me is as on 6 (no coach)');
select test.is(coach_note_by_token(pg_temp.token('Pat Lee, tutor'), 'f0000000-0000-4000-8000-000000000001', 'Hello'), null,
               'coach off: coach_note_by_token answers null ...');
:as_owner
select test.is(pg_temp.notes('Pat Lee, tutor') || ' ' || pg_temp.writes('Pat Lee, tutor'), '0 0', '... and writes nothing, and counts nothing');

-- Only a parent sets it.
:as_adult
select test.throws(format($$select set_tutor_coach(%L, true)$$, pg_temp.lid('Pat Lee, tutor')), 'Only a parent can change homework.',
                   'Sam can''t turn the coach view on');
:as_anon
select test.is(test.can(format($$select set_tutor_coach(%L, true)$$, pg_temp.lid('Pat Lee, tutor'))), 'denied', 'anon can''t call set_tutor_coach');
:as_admin
select test.throws($$select set_tutor_coach(gen_random_uuid(), true)$$, 'That link is gone.', 'an unknown link: "That link is gone."');
select test.throws(format($$select set_tutor_coach(%L, null)$$, pg_temp.lid('Pat Lee, tutor')), 'Choose on or off.', 'null: "Choose on or off."');
select set_tutor_coach(pg_temp.lid('Pat Lee, tutor'), true);
:as_owner
select test.is((select coach || ' ' || updated_by from tutor_links where label = 'Pat Lee, tutor'), 'true alex@example.com',
               'a parent turns it on for Pat''s link (stamped)');
select test.is((select string_agg(label, ', ' order by label) from tutor_links where coach), 'Pat Lee, tutor', '... and only for that link');
-- A parent can't set it any other way: no column grant.
:as_admin
select test.is(test.try(format($$update public.tutor_links set coach = false where id = %L$$, pg_temp.lid('Pat Lee, tutor'))), 'denied',
               'no direct update of tutor_links.coach, even for a parent');

-- ---------------------------------------------------------------------
-- Coach on: the flag on the tutor's view, and exactly the listed data
-- ---------------------------------------------------------------------
:as_anon
select test.is(tutor_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'coach', 'true'::jsonb, 'coach on: the tutor''s view says coach: true');
select test.is(pg_temp.keys(tutor_view_by_token(pg_temp.token('Pat Lee, tutor')) - 'coach'),
               'ai,as_of,assignments,ends_on,kid,language,pace,plans,questions,record,server_now,to_check,to_talk_about,today,tutor,week',
               '... and nothing else is new in it');
select test.is(pg_temp.keys(tutor_view_by_token(pg_temp.token('Pat Lee, tutor'), 'a0000000-0000-4000-8000-000000000001', 'ai')), 'assignment',
               '... the AI poll answers as before (no coach key)');
select test.ok(not (tutor_view_by_token(pg_temp.token('Casey, tutor')) ? 'coach'), '... Casey''s link (coach off) has no coach key');
select test.is(coach_view_by_token(pg_temp.token('Casey, tutor')), null, '... and Casey''s link reads no coach view');
select test.is(homework_by_token(test.token('Taylor')) -> 'me' ->> 'coach', 'Pat',
               'his own view names the coach (the first word of the link''s label), so his screen can say who sees his points');
select test.is(pg_temp.keys((homework_by_token(test.token('Taylor')) -> 'me') - 'coach'), 'cue,first_name,if_stuck,length,lengths,points_on,tutor',
               '... and nothing else is new in his me');

create temp table cv as select coach_view_by_token(pg_temp.token('Pat Lee, tutor')) as v;
select test.is(pg_temp.keys((select v from cv)), 'as_of,asks,calendar,focus,kid,language,notes,points,rewards,tasks,today',
               'the coach view: exactly its keys');
select test.is((select v ->> 'kid' || ' ' || (v ->> 'language') || ' ' || (v ->> 'today') || ' ' || (v ->> 'as_of') from cv),
               'Taylor en 2026-11-04 2026-11-04T17:30', '... the kid''s first name, the link''s language, today and the time');
select test.is(pg_temp.all_keys((select v from cv)),
               'all_day,as_of,asked_on,asks,assignment,balance,calendar,cost,day,decided_on,delta,end_day,ends,focus,given,instant,kid,kind,'
               'language,last_week,lines,milestones,minutes,note,notes,on_time,points,result,rewards,seen_minutes,starts,status,tasks,'
               'this_week,title,today,trades,voided',
               '... and no key anywhere but those (no who, no email, no person, no id, no with_whom)');

-- Points: the balance, this week's and last week's by kind, the last 30 days of lines (newest first).
select test.is((select (v -> 'points' ->> 'balance')::int from cv), 165, 'points: his balance (every line he has, the old one too)');
select test.is((select v -> 'points' -> 'this_week' from cv),
               '{"focus": 20, "on_time": 10, "milestones": 40, "given": 15, "voided": -10, "trades": -15}'::jsonb,
               'points: this week (Mon Nov 2 to Sun Nov 8) by kind: focus, on time, milestones (both halves), given, voided, trades');
select test.is((select v -> 'points' -> 'last_week' from cv),
               '{"focus": 25, "on_time": 10, "milestones": 0, "given": 30, "voided": 0, "trades": -60}'::jsonb,
               'points: last week (Oct 26 to Nov 1) by kind');
select test.is((select pg_temp.rows(v -> 'points' -> 'lines', '{day,kind,delta,note}') from cv),
               '2026-11-04 void -10 That start was late | 2026-11-04 trade -15 Extra game time | 2026-11-03 given 15 Great session | '
               '2026-11-03 milestone 20 Outline | 2026-11-03 milestone_done 20 Outline | 2026-11-02 focus 20 Find 2 sources | '
               '2026-11-02 on_time 10 Find 2 sources | 2026-11-01 trade -60 Pick the movie | 2026-10-30 given 30 A good week | '
               '2026-10-29 on_time 10 Read chapter 4 | 2026-10-27 focus 25 Read chapter 3',
               'points: the last 30 days'' lines, newest first: day, kind, points and the note he sees (never who wrote them)');

-- Rewards and asks.
select test.is((select pg_temp.rows(v -> 'rewards', '{title,cost,instant}') from cv), 'Extra game time 15 true | Pick the movie 200 false',
               'rewards: his active ones with cost and the instant flag (not one that is off, not a suggestion, not Robin''s)');
select test.is((select pg_temp.rows(v -> 'asks', '{title,cost,status,asked_on,decided_on}') from cv),
               'Extra game time 15 cashed 2026-11-04 2026-11-04 | Pick the movie 200 waiting 2026-11-03 - | Pick the movie 200 approved 2026-10-20 2026-10-21',
               'asks and cash-ins: waiting, and those of the last 30 days, newest first, with status and dates (not the old one, not Robin''s)');

-- Focus sessions of the last 30 days: finished blocks only, never one running now.
select test.is((select pg_temp.rows(v -> 'focus', '{day,assignment,minutes,seen_minutes,result,note}') from cv),
               '2026-11-03 - 10 4 stopped - | 2026-11-02 Science project 20 18 done found 2 sources | 2026-10-27 Science project 15 15 more -',
               'focus: day, assignment, minutes chosen, minutes the server saw, result, his note (no block running now, none older, not Robin''s)');

-- His own calendar: Wed Oct 28 to Tue Nov 17.
select test.is((select pg_temp.rows(v -> 'calendar', '{day,end_day,all_day,starts,ends,title}') from cv),
               '2026-10-29 2026-10-29 false 16:00 17:00 Soccer | 2026-11-02 2026-11-02 false 16:00 - Guitar class | '
               '2026-11-03 2026-11-03 false 17:00 17:45 Piano lesson | 2026-11-07 2026-11-07 false 09:00 10:00 Swim practice | '
               '2026-11-09 2026-11-09 false 10:00 11:00 Private item | 2026-11-10 2026-11-10 false 14:00 14:30 Orthodontist | '
               '2026-11-11 2026-11-11 true - - Private item | 2026-11-12 2026-11-12 false 16:00 17:00 Soccer | '
               '2026-11-13 2026-11-14 true - - Science fair | 2026-11-17 2026-11-17 false 17:00 17:45 Piano lesson',
               'calendar: what he is in charge of, or the only one on with nobody in charge, that day as the hub has it (a day''s change '
               'counts, a cancelled day doesn''t), and his own Google calendar; private ones as "Private item"');

-- His daily tasks: today and the last 7 days.
select test.is((select pg_temp.rows(v -> 'tasks', '{day,status,title}') from cv),
               '2026-11-04 open Feed the cat | 2026-11-04 open Make bed | 2026-11-03 done Make bed | 2026-11-02 missed Make bed | '
               '2026-11-02 done Pack gym bag | 2026-11-01 skipped Make bed | 2026-11-01 done Private item',
               'tasks: his own of today and the last 7 days, done or not (open, done, skipped, missed); a private one as "Private item"');
select test.is((select v -> 'notes' from cv), '[]'::jsonb, 'notes: none yet');

-- Nothing of anyone else.
select test.is((select string_agg(w, ', ' order by w) from cv cross join unnest(array[
                  'Alex', 'Sam', 'Morgan', 'Robin', 'Riley', 'Casey', 'Jordan', 'Pat', '@', '555-', 'Rivera', 'Elm', 'Gate code', 'Tacos', 'Milk',
                  'Family dinner', 'Movie night', 'Dentist', 'Recital', 'Work trip', 'School picture', 'Recycling', 'Library', 'Old club',
                  'Far trip', 'Not this week', 'Doctor visit', 'Diary', 'Old prize', 'Skip a chore', 'an old block', 'Starting points',
                  'Taylor (My day)', 'tutor link']) w
                where position(w in v::text) > 0), null,
               'nothing of anyone else: no other person, tutor, email, phone, directory entry, place, notes, dinner, list, other people''s events '
               'or tasks, private titles, or anything outside the windows');
:as_owner
select test.is((select string_agg(p.name, ', ') from cv, people p where position(p.id::text in v::text) > 0), null, '... and no person''s id');

-- The Spanish link reads its own language, with "Private item" in it.
:as_owner
create temp table es_word as select private.word('private_item', 'es') as w;
grant select on es_word to public;
:as_admin
select set_tutor_coach(pg_temp.lid('Casey, tutor'), true);
:as_anon
select test.is((select x ->> 'title' from jsonb_array_elements(coach_view_by_token(pg_temp.token('Casey, tutor')) -> 'calendar') x
                where x ->> 'day' = '2026-11-09'), (select w from es_word),
               'a Spanish link: its own language ("Private item" in Spanish)');
:as_owner
select test.is(coach_view_by_token(pg_temp.token('Casey, tutor')) ->> 'language', 'es', '... language es');

-- Points off: no points, rewards or asks, as on his My day; the rest stays.
update homework_kids set points_on = false where kid_id = test.person('Taylor');
:as_anon
select test.is((select jsonb_build_array(v -> 'points', v -> 'rewards', v -> 'asks') from (select coach_view_by_token(pg_temp.token('Pat Lee, tutor')) as v) x),
               '[null, null, null]'::jsonb, 'points off: points, rewards and asks are null');
select test.ok(jsonb_array_length(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'calendar') = 10, '... his calendar still shows');
:as_owner
update homework_kids set points_on = true where kid_id = test.person('Taylor');

-- Robin's link, with the coach view on, sees only Robin.
:as_admin
select set_tutor_coach(pg_temp.lid('Riley, tutor'), true);
:as_anon
select test.is((select v ->> 'kid' || ' | ' || (v -> 'points' ->> 'balance') || ' | ' || pg_temp.rows(v -> 'rewards', '{title}') || ' | '
                       || pg_temp.rows(v -> 'focus', '{note}') || ' | ' || (v -> 'calendar')::text || ' | ' || pg_temp.rows(v -> 'tasks', '{title}')
                from (select coach_view_by_token(pg_temp.token('Riley, tutor')) as v) x),
               'Robin | 50 | Robin''s prize | Robin''s block | [{"day": "2026-11-08", "ends": "15:00", "title": "Recital", "starts": "14:00", "all_day": false, "end_day": "2026-11-08"}] | Robin chores',
               'another kid''s link sees only that kid (his own Recital, never the movie night he shares)');
:as_admin
select set_tutor_coach(pg_temp.lid('Riley, tutor'), false);

-- The writers' answers carry the flag too (they answer with the tutor's view).
:as_anon
select test.is(tutor_assignment_by_token(pg_temp.token('Pat Lee, tutor'), '{"id": "a0000000-0000-4000-8000-000000000001", "subject": "Science"}') -> 'coach',
               'true'::jsonb, 'a writer''s answer (the tutor''s view) says coach: true too');

-- ---------------------------------------------------------------------
-- Whose days they were: a task's history is the person in charge when the hub wrote it (task_log.responsible_id),
-- not the task's person now; a series that changed hands shows only its days from then on (review findings 1 and 5)
-- ---------------------------------------------------------------------
-- Sam's daily chore, weekly chore and a one-off, with Sam's last week on them; on Mon Nov 2 at 9am a parent hands
-- all three to Taylor (rotating chores). Every entry is written as the pages write it.
:as_owner
set hub.now = '2026-10-28 08:00 America/New_York';
insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit, anchor_date) values
  ('Walk the dog', test.person('Sam'), '2026-10-29', 'schedule', 1, 'day', '2026-10-01'),
  ('Take out the bins', test.person('Sam'), '2026-10-28', 'schedule', 1, 'week', '2026-10-07');
insert into tasks (title, responsible_id, due_date) values ('Return the library DVDs', test.person('Sam'), '2026-10-30');
set hub.now = '2026-10-29 18:00 America/New_York';
:as_adult
select complete_task(test.task('Walk the dog'), '2026-10-29');
:as_owner
set hub.now = '2026-10-30 18:00 America/New_York';
:as_adult
select complete_task(test.task('Return the library DVDs'));
:as_owner
set hub.now = '2026-10-31 08:00 America/New_York';
:as_service
select roll_missed_tasks();                                      -- Walk the dog: Oct 30 missed (Sam's)
:as_admin
select skip_task(test.task('Walk the dog'), '2026-10-31');
:as_owner
set hub.now = '2026-11-01 18:00 America/New_York';
:as_adult
select complete_task(test.task('Walk the dog'), '2026-11-01');
:as_owner
set hub.now = '2026-11-02 09:00 America/New_York';
:as_admin
update tasks set responsible_id = test.person('Taylor') where title in ('Walk the dog', 'Take out the bins', 'Return the library DVDs');
:as_owner
set hub.now = '2026-11-02 19:00 America/New_York';
:as_anon
select complete_by_token(test.token('Taylor'), test.task('Walk the dog'), '2026-11-02');   -- his own, from his My day
:as_owner
set hub.now = '2026-11-04 08:00 America/New_York';
:as_service
select roll_missed_tasks();          -- Walk the dog: Nov 3 missed (his); the bins: Oct 28 missed, logged now but Sam's day
:as_owner
set hub.now = '2026-11-04 17:30 America/New_York';
create temp table handed as
  select x from jsonb_array_elements(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'tasks') x
  where x ->> 'title' in ('Walk the dog', 'Take out the bins', 'Return the library DVDs');
select test.is((select string_agg(x ->> 'day' || ' ' || (x ->> 'status') || ' ' || (x ->> 'title'), ' | ') from handed),
               '2026-11-04 open Take out the bins | 2026-11-04 open Walk the dog | 2026-11-03 missed Walk the dog | 2026-11-02 done Walk the dog',
               'chores handed to him: his days since (done, missed) and what is open now; none of Sam''s days before (done, skipped, '
               'missed), nor Sam''s done one-off, nor a day Sam missed that the daily job logged after the hand-over');
select test.is((select string_agg(coalesce(to_jsonb(l) ->> 'responsible_id', '-') || ' ' || l.status, ', ' order by l.seq)
                from task_log l where l.task_id = test.task('Walk the dog')),
               (select string_agg(p || ' ' || s, ', ' order by n) from unnest(array[test.person('Sam'), test.person('Sam'), test.person('Sam'),
                       test.person('Sam'), test.person('Taylor'), test.person('Taylor')]::text[],
                       array['done', 'missed', 'skipped', 'done', 'done', 'missed']) with ordinality u (p, s, n)),
               'task_log.responsible_id: each entry keeps who was in charge when the hub wrote it');
select test.is((select to_jsonb(t) ->> 'responsible_changed_at' from tasks t where t.title = 'Walk the dog')::timestamptz,
               timestamptz '2026-11-02 14:00+00', 'tasks.responsible_changed_at: when the task last changed hands');
select test.is((select to_jsonb(t) ->> 'responsible_changed_at' from tasks t where t.title = 'Feed the cat'), null,
               '... none for a task that never changed hands');

-- A series handed to him shows its days from then on: Sam's Monday and Wednesday physio and Wednesday chess, handed
-- to Taylor now (Wed Nov 4, 5:30pm). Today's 4pm physio was still Sam's; tonight's chess is his. A day whose own change
-- put him in charge (Mon Nov 2) was his.
:as_owner
insert into events (title, start_date, start_time, end_time, repeat, repeat_weekdays, responsible_id, participant_ids) values
  ('Physio', '2026-10-05', '16:00', '17:00', 'weekly', '{1,3}', test.person('Sam'), '{}'),
  ('Evening chess', '2026-10-07', '19:00', '20:00', 'weekly', '{3}', test.person('Sam'), '{}'),
  ('Board games', '2026-10-07', '18:00', '19:00', 'weekly', '{3}', null, array[test.person('Robin')]);
insert into event_changes (event_id, on_date, responsible_id) values (test.event('Physio'), '2026-11-02', test.person('Taylor'));
:as_admin
update events set responsible_id = test.person('Taylor') where title in ('Physio', 'Evening chess');
update events set participant_ids = array[test.person('Taylor')] where title = 'Board games';
:as_anon
select test.is((select string_agg(x ->> 'day' || ' ' || (x ->> 'starts') || ' ' || (x ->> 'title'), ' | ')
                from jsonb_array_elements(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'calendar') x
                where x ->> 'title' in ('Physio', 'Evening chess', 'Board games')),
               '2026-11-02 16:00 Physio | 2026-11-04 18:00 Board games | 2026-11-04 19:00 Evening chess | 2026-11-09 16:00 Physio | '
               '2026-11-11 16:00 Physio | 2026-11-11 18:00 Board games | 2026-11-11 19:00 Evening chess | 2026-11-16 16:00 Physio',
               'series handed to him: only what began after (tonight''s board games and chess, the coming days) and a day its own change '
               'put him in charge; none of Sam''s days before, nor today''s 4pm physio, nor a nobody-in-charge series'' day before he '
               'became its only one');
:as_owner
select test.is((select string_agg(title || ' ' || coalesce(to_jsonb(e) ->> 'people_changed_at', '-'), ', ' order by title) from events e
                where title in ('Physio', 'Board games', 'Piano lesson')),
               'Board games 2026-11-04T22:30:00+00:00, Physio 2026-11-04T22:30:00+00:00, Piano lesson -',
               'events.people_changed_at: when the series'' person in charge (or, with nobody in charge, its people) last changed');

-- A health task of his (not switched private) is "Private item" with its day and status, as on the wall (finding 2).
:as_owner
insert into tasks (title, category, responsible_id, due_date, due_time, repeat_mode, every_count, every_unit, anchor_date) values
  ('Allergy medicine with breakfast', 'health', test.person('Taylor'), '2026-11-04', '07:30', 'schedule', 1, 'day', '2026-10-01');
insert into task_log (task_id, occurrence, status, done_on, done_by) values
  (test.task('Allergy medicine with breakfast'), '2026-11-03', 'done', '2026-11-03', 'Taylor (My day)'),
  (test.task('Allergy medicine with breakfast'), '2026-11-02', 'missed', null, null);
:as_anon
create temp table cv_health as select coach_view_by_token(pg_temp.token('Pat Lee, tutor')) as v;
select test.is((select string_agg(x ->> 'day' || ' ' || (x ->> 'status'), ' | ') from cv_health, jsonb_array_elements(v -> 'tasks') x
                where x ->> 'title' = 'Private item' and x ->> 'day' >= '2026-11-02'),
               '2026-11-04 open | 2026-11-03 done | 2026-11-02 missed', 'a health task of his: "Private item", with its days and status');
select test.ok((select position('Allergy' in v::text) = 0 from cv_health), '... and its title appears nowhere');

-- His open tasks due before the last 7 days are there too, as Late on his My day (finding 4): first, oldest first.
:as_owner
insert into tasks (title, responsible_id, due_date, active) values
  ('Return library book', test.person('Taylor'), '2026-10-25', true),
  ('Old paused form', test.person('Taylor'), '2026-10-20', false),
  ('Sam''s overdue form', test.person('Sam'), '2026-10-20', true);
insert into tasks (title, category, responsible_id, due_date) values ('Eye drops refill', 'health', test.person('Taylor'), '2026-10-22');
:as_anon
select test.is((select string_agg(x ->> 'day' || ' ' || (x ->> 'status') || ' ' || (x ->> 'title'), ' | ' order by n)
                from jsonb_array_elements(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'tasks') with ordinality t (x, n)
                where n <= 2),
               '2026-10-22 late Private item | 2026-10-25 late Return library book',
               'his open tasks due before the window: status late, on their due day, first and oldest first (a health one as '
               '"Private item"; not a paused one, not Sam''s)');
select test.ok(not exists (select 1 from jsonb_array_elements(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'tasks') x
                           where x ->> 'title' in ('Old paused form', 'Sam''s overdue form')), '... a paused one and Sam''s aren''t there');

-- An ask decided in the last 30 days shows, however long ago he asked, newest decision first (finding 7).
:as_owner
insert into rewards (id, kid_id, title, cost, active) values ('d0000000-0000-4000-8000-000000000009', test.person('Taylor'), 'New bike helmet', 500, true);
insert into reward_asks (kid_id, reward_id, title, cost, status, asked_at, decided_at, decided_by) values
  (test.person('Taylor'), 'd0000000-0000-4000-8000-000000000009', 'New bike helmet', 500, 'approved', '2026-09-25 21:00+00', '2026-11-03 22:00+00', 'alex@example.com');
:as_anon
select test.is((select pg_temp.rows(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'asks', '{title,cost,status,asked_on,decided_on}')),
               'Extra game time 15 cashed 2026-11-04 2026-11-04 | New bike helmet 500 approved 2026-09-25 2026-11-03 | '
               'Pick the movie 200 waiting 2026-11-03 - | Pick the movie 200 approved 2026-10-20 2026-10-21',
               'asks: one asked 40 days ago and approved yesterday shows, by its newest date (not the one asked and declined two months ago)');

-- The stamps can't be written another way: an entry always takes the task's person, a save that leaves who is in
-- charge as it is keeps the time, and an entry from before 0007 (no stamp) never shows.
:as_owner
insert into task_log (task_id, occurrence, status, done_on, done_by, responsible_id)
  values (test.task('Make bed'), '2026-10-29', 'done', '2026-10-29', 'Taylor (My day)', test.person('Robin'));
select test.is((select responsible_id from task_log where task_id = test.task('Make bed') and occurrence = '2026-10-29'),
               test.person('Taylor'), 'task_log.responsible_id: an entry takes the task''s person in charge, whatever it is given');
:as_admin
update tasks set responsible_changed_at = null, notes = 'Round the block' where title = 'Walk the dog';
update events set people_changed_at = null, participant_ids = array[test.person('Morgan')] where title = 'Physio';
:as_owner
select test.is((select responsible_changed_at from tasks where title = 'Walk the dog'), timestamptz '2026-11-02 14:00+00',
               'a save that leaves the task''s person as it is keeps responsible_changed_at (a page can''t clear it)');
select test.is((select people_changed_at from events where title = 'Physio'), timestamptz '2026-11-04 22:30+00',
               '... and an event''s people_changed_at (the people along don''t count while someone is in charge)');
update task_log set responsible_id = null where task_id = test.task('Make bed') and occurrence = '2026-10-29';
:as_anon
select test.ok(not exists (select 1 from jsonb_array_elements(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'tasks') x
                           where x ->> 'day' = '2026-10-29'), 'an entry with no stamp (from before 0007) doesn''t show');

-- ---------------------------------------------------------------------
-- Notes for the parents
-- ---------------------------------------------------------------------
:as_owner
create temp table w0 as select pg_temp.writes('Pat Lee, tutor') as n;
:as_anon
create temp table n1 as select coach_note_by_token(pg_temp.token('Pat Lee, tutor'), 'f0000000-0000-4000-8000-000000000001',
                                                   E'  Suggest lowering\tthe on-time bonus.\n\nHe starts on time anyway.  ') as v;
select test.is((select (v ->> 'note_id') || ' ' || (v ->> 'changed') from n1), 'f0000000-0000-4000-8000-000000000001 true',
               'a note: answers its id and changed');
select test.is((select pg_temp.rows(v -> 'notes', '{id,note}') from n1),
               E'f0000000-0000-4000-8000-000000000001 Suggest lowering the on-time bonus.\n\nHe starts on time anyway.',
               '... and the coach view, with the note in it (cleaned, its lines kept)');
select test.is((select pg_temp.keys(v -> 'notes' -> 0) || ' ' || (v -> 'notes' -> 0 ->> 'day') from n1), 'day,id,note 2026-11-04',
               '... each note with its id, its text and the household''s day it was written');
:as_owner
select test.is((select note || ' | ' || written_by || ' | ' || (created_at = private.now()) || ' | ' || (done_at is null) from coach_notes),
               E'Suggest lowering the on-time bonus.\n\nHe starts on time anyway. | Pat Lee, tutor (tutor link) | true | true',
               '... kept with who wrote it ("<label> (tutor link)") and when');
select test.is(pg_temp.writes('Pat Lee, tutor') - (select n from w0), 1, '... counted as one of the link''s writes');
:as_anon
select test.is(coach_note_by_token(pg_temp.token('Pat Lee, tutor'), 'f0000000-0000-4000-8000-000000000001', 'Something else') ->> 'changed', 'false',
               'a resend of the same note changes nothing ...');
:as_owner
select test.is(pg_temp.notes('Pat Lee, tutor') || ' ' || (pg_temp.writes('Pat Lee, tutor') - (select n from w0)) || ' '
               || (select note from coach_notes where id = 'f0000000-0000-4000-8000-000000000001') like '1 1 Suggest%', true,
               '... one note, counted once, as it was');
:as_anon
select test.throws(format($$select coach_note_by_token(%L, 'f0000000-0000-4000-8000-000000000001', 'Hi')$$, pg_temp.token('Casey, tutor')),
                   'That note isn''t on this link.', 'another link can''t use that note''s id');
select test.throws(format($$select coach_note_by_token(%L, 'f0000000-0000-4000-8000-000000000002', repeat('x', 501))$$, pg_temp.token('Pat Lee, tutor')),
                   'That''s too long.', 'a note over 500 characters: "That''s too long."');
select test.throws(format($$select coach_note_by_token(%L, 'f0000000-0000-4000-8000-000000000002', E' \t\n ')$$, pg_temp.token('Pat Lee, tutor')),
                   'Write a note first.', 'an empty note: "Write a note first."');
select test.throws(format($$select coach_note_by_token(%L, null, 'Hi')$$, pg_temp.token('Pat Lee, tutor')),
                   'A note needs its id.', 'a note without its key: refused');
select test.is((select count(*) from (select coach_note_by_token(pg_temp.token('Pat Lee, tutor'), ('f0000000-0000-4000-8000-00000000001' || g)::uuid, 'Note ' || g)
                                      from generate_series(0, 3) g) x), 4::bigint, 'four more notes today (five in all) ...');
select test.throws(format($$select coach_note_by_token(%L, 'f0000000-0000-4000-8000-000000000099', 'One more')$$, pg_temp.token('Pat Lee, tutor')),
                   'That''s a lot for one day.', '... a sixth today: "That''s a lot for one day."');
:as_owner
select test.is(pg_temp.notes('Pat Lee, tutor'), 5, '... nothing written for it');
set hub.now = '2026-11-05 09:00 America/New_York';
:as_anon
select test.is(coach_note_by_token(pg_temp.token('Pat Lee, tutor'), 'f0000000-0000-4000-8000-000000000099', 'Next day') ->> 'changed', 'true',
               'the next day the link may write again');
-- The coach view shows the link's own notes of the last 30 days, newest first; never another link's.
select test.is((select pg_temp.rows(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) -> 'notes', '{note}')),
               'Next day | Note 3 | Note 2 | Note 1 | Note 0 | ' || E'Suggest lowering the on-time bonus.\n\nHe starts on time anyway.',
               'the coach view lists the link''s own notes, newest first');
select test.is(coach_view_by_token(pg_temp.token('Casey, tutor')) -> 'notes', '[]'::jsonb, '... and Casey''s link none of Pat''s');

-- Only the parents read them, and mark them done; nobody writes them directly.
:as_admin
select test.is((select count(*) from coach_notes), 6::bigint, 'the parents read the notes');
select test.is(test.try($$insert into public.coach_notes (id, link_id, note, written_by, created_at)
                          select gen_random_uuid(), id, 'x', 'x', now() from public.tutor_links limit 1$$), 'denied', '... but can''t add one');
select test.is(test.try($$update public.coach_notes set note = note$$), 'denied', '... or change one');
select test.is(test.try($$delete from public.coach_notes$$), 'denied', '... or delete one');
:as_adult
select test.is((select count(*) from coach_notes), 0::bigint, 'Sam reads no notes (they are the parents'')');
select test.throws($$select coach_note_done('f0000000-0000-4000-8000-000000000001')$$, 'Only a parent can change homework.', 'Sam can''t mark one done');
:as_stranger
select test.is((select count(*) from coach_notes), 0::bigint, 'someone not on the family list reads none');
:as_anon
select test.is(test.try('select * from public.coach_notes'), 'denied', 'anon: no privilege on coach_notes');
select test.is(test.can($$select coach_note_done('f0000000-0000-4000-8000-000000000001')$$), 'denied', 'anon can''t call coach_note_done');
:as_admin
select coach_note_done('f0000000-0000-4000-8000-000000000001');
select test.is((select (done_at = private.now()) || ' ' || done_by from coach_notes where id = 'f0000000-0000-4000-8000-000000000001'),
               'true alex@example.com', 'a parent marks a note done');
set hub.now = '2026-11-05 10:00 America/New_York';
select coach_note_done('f0000000-0000-4000-8000-000000000001');
select test.is((select done_at = timestamptz '2026-11-05 14:00+00' from coach_notes where id = 'f0000000-0000-4000-8000-000000000001'), true,
               '... a second Done changes nothing');
select test.throws($$select coach_note_done(gen_random_uuid())$$, 'That note is gone.', 'an unknown note: "That note is gone."');
:as_service
select test.is(test.can($$select coach_note_done('f0000000-0000-4000-8000-000000000001')$$), 'denied', 'service_role can''t call coach_note_done');
select test.is(test.can(format($$select set_tutor_coach(%L, true)$$, pg_temp.lid('Pat Lee, tutor'))), 'denied', '... or set_tutor_coach');
select test.is(test.can(format($$select coach_view_by_token(%L)$$, pg_temp.token('Pat Lee, tutor'))), 'denied', '... or the coach''s token functions');

-- Notes are kept 180 days: a write deletes the link's older ones.
:as_owner
update coach_notes set created_at = created_at - interval '181 days' where id = 'f0000000-0000-4000-8000-000000000010';
set hub.now = '2026-11-06 09:00 America/New_York';
:as_anon
select coach_note_by_token(pg_temp.token('Pat Lee, tutor'), 'f0000000-0000-4000-8000-000000000098', 'A week of good starts');
:as_owner
select test.is((select count(*) from coach_notes where id = 'f0000000-0000-4000-8000-000000000010'), 0::bigint,
               'a note older than 180 days goes at the link''s next note');
select test.is((select count(*) from coach_notes), 6::bigint, '... the others stay');

-- ---------------------------------------------------------------------
-- The tutor-link rules: Off, the end date, New link, homework off, a kid no longer active
-- ---------------------------------------------------------------------
:as_admin
select save_tutor_link(pg_temp.lid('Pat Lee, tutor'), test.person('Taylor'), 'Pat Lee, tutor', 'en', (pg_temp.link('Pat Lee, tutor')).expires_on, true, false);
:as_anon
select test.is(coach_view_by_token(pg_temp.token('Pat Lee, tutor')), null, 'a link that is Off reads no coach view');
select test.is(coach_note_by_token(pg_temp.token('Pat Lee, tutor'), 'f0000000-0000-4000-8000-000000000097', 'Hi'), null, '... and writes no note');
:as_admin
select save_tutor_link(pg_temp.lid('Pat Lee, tutor'), test.person('Taylor'), 'Pat Lee, tutor', 'en', (pg_temp.link('Pat Lee, tutor')).expires_on, true, true);
:as_owner
select test.is((select coach from tutor_links where label = 'Pat Lee, tutor'), true, 'Off and On keep the coach switch');
update tutor_links set expires_on = public.today_local() - 1 where label = 'Pat Lee, tutor';
:as_anon
select test.is(coach_view_by_token(pg_temp.token('Pat Lee, tutor')), null, 'a link past its end date reads no coach view');
:as_owner
update tutor_links set expires_on = public.today_local() + 100 where label = 'Pat Lee, tutor';
create temp table old_token as select pg_temp.token('Pat Lee, tutor') as t;
grant select on old_token to public;
:as_admin
select new_tutor_token(pg_temp.lid('Pat Lee, tutor'));
:as_anon
select test.is(coach_view_by_token((select t from old_token)), null, 'New link: the old address reads nothing');
select test.ok(coach_view_by_token(pg_temp.token('Pat Lee, tutor')) ->> 'kid' = 'Taylor', '... the new one does, with the coach view still on');
:as_admin
select save_homework_kid(test.person('Taylor'), false);
:as_anon
select test.is(coach_view_by_token(pg_temp.token('Pat Lee, tutor')), null, 'homework off for him: the link reads no coach view');
:as_admin
select save_homework_kid(test.person('Taylor'), true);
:as_owner
update people set active = false where name = 'Taylor';
:as_anon
select test.is(coach_view_by_token(pg_temp.token('Pat Lee, tutor')), null, 'a kid no longer active: nothing');
:as_owner
update people set active = true where name = 'Taylor';
-- The switch off again: back to nothing new.
:as_admin
select set_tutor_coach(pg_temp.lid('Pat Lee, tutor'), false);
:as_anon
select test.ok(not (tutor_view_by_token(pg_temp.token('Pat Lee, tutor')) ? 'coach') and coach_view_by_token(pg_temp.token('Pat Lee, tutor')) is null,
               'turned off again: no coach key and no coach view');
select test.ok((homework_by_token(test.token('Taylor')) -> 'me' ->> 'coach') = 'Casey',
               '... and his view names only a link whose coach view is still on (Casey''s)');
-- Pat's token opens nothing of My day, and a My day token opens no coach view.
select test.is(get_person_day(pg_temp.token('Pat Lee, tutor')), null, 'Pat''s token opens no My day');
select test.is(coach_view_by_token(test.token('Taylor')), null, 'his My day token opens no coach view');
select test.is(coach_view_by_token('not-a-token'), null, 'a malformed token: null');

-- ---------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------
:as_owner
select test.is((select relrowsecurity from pg_class where oid = 'public.coach_notes'::regclass), true, 'coach_notes has row-level security');
select test.is((select string_agg(polname, ', ') from pg_policy where polrelid = 'public.coach_notes'::regclass), 'Parents can see the coach''s notes',
               '... one policy: the parents read');
select test.is((select string_agg(r || ' ' || x, ', ' order by r, x) from unnest(array['anon', 'authenticated']) r
                cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) x
                where has_table_privilege(r, 'public.coach_notes', x)),
               'authenticated select', 'coach_notes: signed-in users select (row-level security decides), anon nothing');
select test.is((select string_agg(a.attname, ', ') from pg_attribute a
                where a.attrelid = 'public.tutor_links'::regclass and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege('authenticated', 'public.tutor_links', a.attname, 'update')), null,
               'tutor_links: still no column signed-in users may update');
select test.is((select string_agg(p.oid::regprocedure::text || ' ' || r, ', ' order by p.oid::regprocedure::text, r)
                from pg_proc p cross join unnest(array['anon', 'authenticated', 'service_role']) r
                where p.proname in ('coach_view_by_token', 'coach_note_by_token', 'set_tutor_coach', 'coach_note_done', 'coach_view')
                  and has_function_privilege(r, p.oid, 'execute')),
               'coach_note_by_token(text,uuid,text) anon, coach_note_by_token(text,uuid,text) authenticated, coach_note_done(uuid) authenticated, '
               'coach_view_by_token(text) anon, coach_view_by_token(text) authenticated, set_tutor_coach(uuid,boolean) authenticated',
               'who may call what: the two token functions anon and signed in; the parents'' two signed in; private.coach_view nobody');
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.proname in ('coach_view_by_token', 'coach_note_by_token', 'set_tutor_coach', 'coach_note_done') and not p.prosecdef), null,
               'the four are SECURITY DEFINER');
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.proname in ('coach_view_by_token', 'coach_note_by_token', 'set_tutor_coach', 'coach_note_done', 'coach_view')
                  and not coalesce(p.proconfig, '{}') @> '{"search_path=\"\""}'), null, '... and every one sets search_path = ''''');
select test.is((select string_agg(t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || p.proname || ' ' || p.prosecdef, ', ' order by t.tgname)
                from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                where t.tgname in ('task_log_in_charge', 'tasks_in_charge_since', 'events_people_since')),
               'events events_people_since events_people_since false, task_log task_log_in_charge task_log_in_charge true, '
               'tasks tasks_in_charge_since tasks_in_charge_since false',
               'the three stamp triggers (the entry''s one runs as its owner, so the stamp never depends on who writes)');
select test.is((select string_agg(p.proname || ' ' || r, ', ' order by p.proname, r) from pg_proc p
                cross join unnest(array['anon', 'authenticated', 'service_role']) r
                where p.pronamespace = 'private'::regnamespace and p.proname in ('task_log_in_charge', 'tasks_in_charge_since', 'events_people_since')
                  and (has_function_privilege(r, p.oid, 'execute') or not coalesce(p.proconfig, '{}') @> '{"search_path=\"\""}')), null,
               '... nobody may call their functions, and each sets search_path = ''''');
-- 7 since 0007; 0008 (the first-import check's past items) makes it 8.
select test.is(hub_schema_version(), 8, 'hub_schema_version is 8 (0007 made it 7, 0008 makes it 8)');

-- ---------------------------------------------------------------------
-- Erase takes the notes with it
-- ---------------------------------------------------------------------
:as_admin
select erase_homework(test.person('Taylor'), 'ERASE');
:as_owner
select test.is((select count(*) from coach_notes) || ' ' || (select count(*) from tutor_links where kid_id = test.person('Taylor')), '0 0',
               'Erase: his links and their notes are gone');
