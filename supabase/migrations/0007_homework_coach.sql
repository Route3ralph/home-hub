-- =====================================================================
-- HOME HUB v1.3 — migration 0007: the coach view (the tutor link, for a tutor who is also the kid's coach)
-- Apply once, after 0006, and only once the site that understands it is live (docs/v1.3-homework.md §20.7).
-- The contract is docs/v1.3-homework.md §20; the owner's decision is §1.2 decision 16.
--
-- What it adds
--   • tutor_links.coach: a per-link switch, off by default; only the parents set it (set_tutor_coach),
--     on the Homework page's tutor-link panel. With it off nothing changes for the link.
--   • coach_notes: a note the coach leaves for the parents ("suggest lowering the on-time bonus"), shown
--     on the parents' Homework page; only the parents read them (and mark them done, coach_note_done).
--   • The tutor link (anon, by its token): coach_view_by_token (read-only, null unless the link works and
--     its coach view is on): the kid's points (balance, this week's and last week's by kind, the last 30
--     days of ledger lines without who wrote them), his rewards and his asks and cash-ins, his focus
--     sessions of the last 30 days, his own calendar (the last 7 and the next 14 days: the events and
--     Google events he is in charge of, or is the only one on with nobody in charge, as agenda() and
--     google_for() have them that day; private ones as "Private item") and his daily tasks (his My day
--     tasks of today and the last 7 days, done or not); and coach_note_by_token (a note for the parents).
--     Twenty-two token functions for anon in all.
--   • Replaced, with the same signatures: private.homework_view_tutor (0006's wrapper, which adds
--     coach: true for a link with the coach view on), private.homework_view_kid (0006's wrapper, which adds
--     me.coach, the coach link's first word, so his screen says who sees his points), each otherwise
--     0006's body (0005's _v5 bodies aren't touched), and hub_schema_version() (7).
--
-- Rules
--   • One transaction. It refuses to run without 0006, twice, or on a database that isn't as 0006 left it.
--   • Additive: with the coach view off on every link (as this leaves them) every page, view, email and
--     text is as on 6 (tests/db/run.sh 5d, 5e, 5f).
--   • RLS on every table. No rows are seeded. Nothing here names anyone but the kid (his first name), or
--     carries an email, a phone number, another person's item, the shopping list, dinners or the directory.
--   • Every time the functions write is private.now().
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0006 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 6 then
    raise exception 'The school feed (migration 0006) isn''t installed (hub_schema_version() is %). Run 0006_homework_school.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 7 then
    raise exception 'The coach view (migration 0007) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  -- A database set back as docs/v1.3-homework.md §20.7 says: before the shape check, so it gets the right message.
  if to_regclass('public.coach_notes') is not null then
    raise exception 'The coach view (migration 0007) is already installed, but hub_schema_version() was set back to 6. To switch it on again, make hub_schema_version() return 7 (docs/v1.3-homework.md §20.7). Nothing was changed.';
  end if;
  -- What this migration changes, replaces and reads is as 0006 left it.
  if to_regclass('public.tutor_links') is null
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.tutor_links'::regclass and a.attname = 'coach' and not a.attisdropped)
     or to_regprocedure('private.homework_view_tutor(uuid, uuid, text)') is null
     or to_regprocedure('private.homework_view_tutor_v5(uuid, uuid, text)') is null
     or to_regprocedure('private.homework_view_kid(uuid, text)') is null
     or to_regprocedure('private.homework_view_kid_v5(uuid, text)') is null
     or to_regprocedure('private.school_new(uuid)') is null
     or to_regprocedure('private.school_marks(uuid)') is null
     or to_regprocedure('private.tutor_link_by_token(text)') is null
     or to_regprocedure('private.count_homework(uuid, text, int)') is null
     or to_regprocedure('private.points_balance(uuid)') is null
     or to_regprocedure('public.agenda(date, date)') is null
     or to_regprocedure('private.google_for(uuid, date, date, boolean)') is null then
    raise exception 'This database isn''t as migration 0006 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The switch, and the coach's notes (§20.2)
-- ---------------------------------------------------------------------

-- The coach view: off until a parent turns it on for this link (set_tutor_coach). The table's select grant
-- (the parents, by its policy) covers the new column; there is no update grant on tutor_links.
alter table public.tutor_links
  add column coach boolean not null default false;

-- A note the coach leaves for the parents, from the tutor link. Only the parents read it; written only
-- through coach_note_by_token, marked done only through coach_note_done.
create table public.coach_notes (
  id         uuid primary key,                -- the page's key: a resend finds it
  link_id    uuid not null references public.tutor_links (id) on delete cascade,
  note       text not null check (char_length(note) between 1 and 500),   -- cleaned, line breaks kept
  written_by text not null,                   -- "<the link's label> (tutor link)", as the link's other writes
  created_at timestamptz not null,            -- private.now()
  done_at    timestamptz,                     -- a parent's Done
  done_by    text,                            -- that parent's email
  check ((done_at is null) = (done_by is null))
);
create index coach_notes_link on public.coach_notes (link_id, created_at desc);

alter table public.coach_notes enable row level security;
create policy "Parents can see the coach's notes" on public.coach_notes
  for select to authenticated using (private.is_admin());
-- Supabase's default privileges would give anon and authenticated everything on a new table (truncate
-- ignores row-level security). Anon gets nothing; signed-in users read (row-level security: the parents);
-- nobody writes it directly. service_role keeps the defaults, as on 0005's tables.
revoke all on public.coach_notes from public, anon, authenticated;
grant select on public.coach_notes to authenticated;

-- ---------------------------------------------------------------------
-- What the coach sees (§20.3)
-- ---------------------------------------------------------------------

-- The coach view of one tutor link, or null when its coach view is off:
--   {language, as_of, today, kid (his first name),
--    points: {balance, this_week, last_week, lines} | null (null with points off, as on his My day);
--      this_week and last_week (Mon–Sun): {focus, on_time, milestones (both halves), given, voided, trades};
--      lines: the last 30 days' ledger lines [{day, kind, delta, note}], newest first (the note he sees: a
--      step's or reward's title, a parent's words with given points or a correction; never who wrote it),
--    rewards: [{title, cost, instant}] | null (his active ones),
--    asks: [{title, cost, status, asked_on, decided_on}] | null (waiting, and asked in the last 30 days),
--    focus: [{day, assignment, minutes, seen_minutes, result, note}] (finished blocks that started in the
--      last 30 days, newest first: never a block running now, nor with whom),
--    calendar: [{day, end_day, all_day, starts, ends, title}] (today − 7 to today + 13: events he is in charge
--      of that day, or is the only one on with nobody in charge, not cancelled, as agenda() has them, and the
--      Google events of his own calendar, google_for(); a private one's title is "Private item"; never who
--      else, a place, notes, a directory entry or a day's note),
--    tasks: [{day, title, status}] (today − 7 to today: his tasks as his My day has them (agenda()), status
--      'open', 'done' or 'skipped', and the days the daily job logged 'missed'; a private one is "Private item"),
--    notes: [{id, note, day}] (this link's own notes to the parents of the last 30 days, newest first; day: the household's)}
-- Never a name but the kid's first name, an email, a phone number, a person's id, another person's item,
-- the shopping list, dinners, the directory, other kids. STABLE; the definer token functions call it.
create function private.coach_view(p_link uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_l     public.tutor_links;
  v_k     public.homework_kids;
  v_me    public.people;
  v_now   timestamptz := private.now();
  v_tz    text := private.tz();
  v_today date := public.today_local();
  v_mon   date := private.monday(public.today_local());
  v_lang  text;
  v_kid   uuid;
  v_bal   int;
  v_items jsonb;
  v_tasks jsonb;
begin
  select * into v_l from public.tutor_links l where l.id = p_link;
  if v_l.id is null or not v_l.coach then
    return null;
  end if;
  v_kid := v_l.kid_id;
  v_lang := v_l.language;
  select * into v_k from public.homework_kids k where k.kid_id = v_kid;
  select * into v_me from public.people p where p.id = v_kid;
  select b.balance into v_bal from private.points_balance(v_kid) b;

  -- His own calendar: the events he is in charge of that day, or is the only one on with nobody in charge,
  -- and his own Google calendar's events (google_for: a person's calendar is in charge of its person).
  with items as (
    select a.day, a.end_day, a.all_day, a.local_start, a.local_end, a.title, coalesce(a.private, false) as private
    from public.agenda(v_today - 7, v_today + 13) a
    where a.kind = 'event' and a.status <> 'cancelled'
      and (a.responsible_id = v_kid
           or (a.responsible_id is null and a.participant_ids <@ array[v_kid] and v_kid = any (a.participant_ids)))
    union all
    select g.day, g.end_day, g.all_day, g.local_start, g.local_end, g.title, coalesce(g.private, false)
    from private.google_for(v_kid, v_today - 7, v_today + 13, false) g
    where g.responsible_id = v_kid
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', i.day, 'end_day', i.end_day, 'all_day', i.all_day,
           'starts', case when not i.all_day and i.local_start is not null then to_char(date '2000-01-01' + i.local_start, 'HH24:MI') end,
           'ends', case when not i.all_day and i.local_end is not null then to_char(date '2000-01-01' + i.local_end, 'HH24:MI') end,
           'title', case when i.private then private.word('private_item', v_lang) else i.title end)
         order by i.day, i.all_day desc, i.local_start, i.title), '[]')
  into v_items
  from items i;

  -- His daily tasks, as his My day has them, and the days the daily job logged missed.
  with t as (
    select a.day, a.title, coalesce(a.private, false) as private, a.status
    from public.agenda(v_today - 7, v_today) a
    where a.kind = 'task' and a.responsible_id = v_kid
    union all
    select l.occurrence, x.title, x.private, 'missed'
    from public.task_log l join public.tasks x on x.id = l.task_id
    where x.responsible_id = v_kid and l.status = 'missed' and l.occurrence between v_today - 7 and v_today
  ),
  shown as (
    select t.day, case when t.private then private.word('private_item', v_lang) else t.title end as title, t.status from t
  )
  select coalesce(jsonb_agg(jsonb_build_object('day', s.day, 'title', s.title, 'status', s.status) order by s.day desc, s.title, s.status), '[]')
  into v_tasks
  from shown s;

  return jsonb_build_object(
    'language', v_lang,
    'as_of', to_char(v_now at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI'),
    'today', v_today,
    'kid', split_part(v_me.name, ' ', 1),
    'points', case when v_k.points_on then jsonb_build_object(
      'balance', coalesce(v_bal, 0),
      'this_week', (select jsonb_build_object(
                      'focus', coalesce(sum(l.delta) filter (where l.kind = 'focus'), 0),
                      'on_time', coalesce(sum(l.delta) filter (where l.kind = 'on_time'), 0),
                      'milestones', coalesce(sum(l.delta) filter (where l.kind in ('milestone_done', 'milestone')), 0),
                      'given', coalesce(sum(l.delta) filter (where l.kind = 'given'), 0),
                      'voided', coalesce(sum(l.delta) filter (where l.kind = 'void'), 0),
                      'trades', coalesce(sum(l.delta) filter (where l.kind = 'trade'), 0))
                    from public.points_ledger l where l.kid_id = v_kid and l.day between v_mon and v_mon + 6),
      'last_week', (select jsonb_build_object(
                      'focus', coalesce(sum(l.delta) filter (where l.kind = 'focus'), 0),
                      'on_time', coalesce(sum(l.delta) filter (where l.kind = 'on_time'), 0),
                      'milestones', coalesce(sum(l.delta) filter (where l.kind in ('milestone_done', 'milestone')), 0),
                      'given', coalesce(sum(l.delta) filter (where l.kind = 'given'), 0),
                      'voided', coalesce(sum(l.delta) filter (where l.kind = 'void'), 0),
                      'trades', coalesce(sum(l.delta) filter (where l.kind = 'trade'), 0))
                    from public.points_ledger l where l.kid_id = v_kid and l.day between v_mon - 7 and v_mon - 1),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('day', x.day, 'kind', x.kind, 'delta', x.delta, 'note', x.note)
                                          order by x.at desc, x.id), '[]')
                from (select l.* from public.points_ledger l
                      where l.kid_id = v_kid and l.day between v_today - 29 and v_today
                      order by l.at desc, l.id limit 300) x)) end,
    'rewards', case when v_k.points_on then
      (select coalesce(jsonb_agg(jsonb_build_object('title', r.title, 'cost', r.cost, 'instant', r.instant)
                                 order by r.sort_order, r.cost, r.title, r.id), '[]')
       from public.rewards r where r.kid_id = v_kid and r.active) end,
    'asks', case when v_k.points_on then
      (select coalesce(jsonb_agg(jsonb_build_object('title', q.title, 'cost', q.cost, 'status', q.status,
                                                    'asked_on', (q.asked_at at time zone v_tz)::date,
                                                    'decided_on', (q.decided_at at time zone v_tz)::date)
                                 order by q.asked_at desc, q.id), '[]')
       from (select * from public.reward_asks q
             where q.kid_id = v_kid and (q.status = 'waiting' or q.asked_at >= v_now - interval '30 days')
             order by q.asked_at desc, q.id limit 100) q) end,
    'focus', (select coalesce(jsonb_agg(jsonb_build_object(
                       'day', (f.started_at at time zone v_tz)::date,
                       'assignment', a.title,
                       'minutes', f.minutes, 'seen_minutes', f.seen_minutes, 'result', f.result, 'note', f.note)
                     order by f.started_at desc, f.id), '[]')
              from public.focus_sessions f
              left join public.homework_steps s on s.id = f.step_id
              left join public.assignments a on a.id = coalesce(f.assignment_id, s.assignment_id) and a.kid_id = v_kid
              where f.kid_id = v_kid and f.ended_at is not null
                and (f.started_at at time zone v_tz)::date between v_today - 29 and v_today),
    'calendar', v_items,
    'tasks', v_tasks,
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'note', n.note, 'day', (n.created_at at time zone v_tz)::date)
                                        order by n.created_at desc, n.id desc), '[]')
              from public.coach_notes n where n.link_id = v_l.id and n.created_at >= v_now - interval '30 days'));
end;
$$;

-- ---------------------------------------------------------------------
-- The tutor link (§20.4): its token is the key (private.tutor_link_by_token, as for its four other
-- functions: an unknown, malformed or replaced token, a link that is off or past its end date, or a kid
-- whose homework is off or who is no longer active: null), and the link's coach view must be on.
-- ---------------------------------------------------------------------

-- The coach view (read-only). Notes when the link was last used, as tutor_view_by_token does.
create function public.coach_view_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.tutor_links;
begin
  l := private.tutor_link_by_token(p_token);
  if l.id is null or not l.coach then
    return null;
  end if;
  return private.coach_view(l.id);
end;
$$;

-- A note for the parents, with the id the page made (p_key: a resend finds it, changes nothing and isn't
-- counted). 1 to 500 characters (cleaned, line breaks kept): over 500 → 22023 "That's too long.", nothing
-- left → 22023 "Write a note first."; another link's id → 42501 "That note isn't on this link.". Counted
-- as one of the link's writes (200 a day), and at most 5 notes a day for a link (P0001 "That's a lot for
-- one day."). The link's notes older than 180 days go as it writes. Answers {note_id, changed} and the
-- coach view.
create function public.coach_note_by_token(p_token text, p_key uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l      public.tutor_links;
  v_old  public.coach_notes;
  v_note text;
  v_tz   text := private.tz();
begin
  l := private.tutor_link_by_token(p_token);
  if l.id is null or not l.coach then
    return null;
  end if;
  if char_length(p_note) > 500 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if p_key is null then
    raise exception 'A note needs its id.' using errcode = '22023';
  end if;
  select * into v_old from public.coach_notes n where n.id = p_key;
  if v_old.id is not null then
    if v_old.link_id <> l.id then
      raise exception 'That note isn''t on this link.' using errcode = '42501';
    end if;
    return jsonb_build_object('note_id', v_old.id, 'changed', false) || private.coach_view(l.id);
  end if;
  v_note := nullif(private.clean_block(p_note, 500), '');
  if v_note is null then
    raise exception 'Write a note first.' using errcode = '22023';
  end if;
  -- The count's row lock queues this link's parallel writes, so the day's notes are counted exactly.
  perform private.count_homework(l.id, 'writes', 200);
  if (select count(*) from public.coach_notes n
      where n.link_id = l.id and (n.created_at at time zone v_tz)::date = public.today_local()) >= 5 then
    raise exception 'That''s a lot for one day.' using errcode = 'P0001';
  end if;
  delete from public.coach_notes n where n.link_id = l.id and n.created_at < private.now() - interval '180 days';
  insert into public.coach_notes (id, link_id, note, written_by, created_at)
  values (p_key, l.id, v_note, l.label || ' (tutor link)', private.now());
  return jsonb_build_object('note_id', p_key, 'changed', true) || private.coach_view(l.id);
exception
  -- A constraint's DETAIL is the whole row: never to a link (as the link's other writers).
  when integrity_constraint_violation then
    raise exception 'That can''t be saved.' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------
-- The parents (§20.5). Each raises 42501 "Only a parent can change homework." unless private.is_admin().
-- ---------------------------------------------------------------------

-- The coach view on or off for one tutor link. Off, the link is as on 6 at once; on, it also reads the
-- coach view. Unknown link: 22023 "That link is gone."; null: 22023 "Choose on or off.".
create function public.set_tutor_coach(p_link uuid, p_coach boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_coach is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  update public.tutor_links l set coach = p_coach where l.id = p_link;
  if not found then
    raise exception 'That link is gone.' using errcode = '22023';
  end if;
end;
$$;

-- Done on a coach's note: it leaves the list of notes to read (the page keeps the last 30 days' done ones
-- folded). A second Done changes nothing; an unknown note: 22023 "That note is gone.".
create function public.coach_note_done(p_note uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.coach_notes n where n.id = p_note) then
    raise exception 'That note is gone.' using errcode = '22023';
  end if;
  update public.coach_notes n set done_at = private.now(), done_by = public.current_email()
  where n.id = p_note and n.done_at is null;
end;
$$;

-- ---------------------------------------------------------------------
-- Replaced: his view and the tutor's view (0006's wrappers; same signatures, so they keep their grants)
-- ---------------------------------------------------------------------
-- His view: 0005's (homework_view_kid_v5), with the school's marks and his New from school (as 0006); and, when a
-- tutor link of his has the coach view on (active, not past its end date), me.coach: the first word of that link's
-- label (the first such link), so his screen can say that link sees his points too (§20.6). Left out with none, so
-- with the coach view off everywhere it is exactly 0006's.
create or replace function private.homework_view_kid(p_kid uuid, p_lang text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := private.homework_view_kid_v5(p_kid, p_lang);
  m jsonb;
  n jsonb;
  c text;
begin
  if v is null then
    return null;
  end if;
  m := private.school_marks(p_kid);
  if m <> '{}' and jsonb_typeof(v -> 'assignments') = 'array' then
    v := jsonb_set(v, '{assignments}',
                   (select coalesce(jsonb_agg(case when m ? (x ->> 'id') then x || jsonb_build_object('school', m -> (x ->> 'id')) else x end
                                              order by t.n), '[]')
                    from jsonb_array_elements(v -> 'assignments') with ordinality t (x, n)));
  end if;
  n := private.school_new(p_kid);
  if n is not null then
    v := v || jsonb_build_object('from_school', n);
  end if;
  -- 0007: a tutor link of his with the coach view on.
  c := (select nullif(split_part(btrim(split_part(l.label, ',', 1)), ' ', 1), '')
        from public.tutor_links l
        where l.kid_id = p_kid and l.active and l.coach and l.expires_on >= public.today_local()
        order by l.created_at, l.id limit 1);
  if c is not null and jsonb_typeof(v -> 'me') = 'object' then
    v := jsonb_set(v, '{me,coach}', to_jsonb(c));
  end if;
  return v;
end;
$$;

-- The tutor's view: 0005's (homework_view_tutor_v5), with the school's marks on each assignment made
-- from school, in the list and with p_assignment (as 0006); and, for a link with the coach view on,
-- coach: true (the page then reads coach_view_by_token). p_part 'ai' answers as 0005's.
create or replace function private.homework_view_tutor(p_link uuid, p_assignment uuid, p_part text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := private.homework_view_tutor_v5(p_link, p_assignment, p_part);
  m jsonb;
begin
  if v is null or jsonb_typeof(v -> 'assignments') is distinct from 'array' then
    return v;
  end if;
  m := private.school_marks((select l.kid_id from public.tutor_links l where l.id = p_link));
  if m <> '{}' then
    v := jsonb_set(v, '{assignments}',
                   (select coalesce(jsonb_agg(case when m ? (x ->> 'id') then x || jsonb_build_object('school', m -> (x ->> 'id')) else x end
                                              order by t.n), '[]')
                    from jsonb_array_elements(v -> 'assignments') with ordinality t (x, n)));
    if jsonb_typeof(v -> 'assignment') = 'object' and m ? (v -> 'assignment' ->> 'id') then
      v := jsonb_set(v, '{assignment,school}', m -> (v -> 'assignment' ->> 'id'));
    end if;
  end if;
  -- 0007: the coach view is on for this link.
  if exists (select 1 from public.tutor_links l where l.id = p_link and l.coach) then
    v := v || jsonb_build_object('coach', true);
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The coach switch and the coach's notes show on the Homework page, and it asks for them, only on 7.
-- (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 7;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- New functions, public and private: revoke from public and anon (and whoever else mustn't call them),
-- then grant to who calls them. The replaced ones (homework_view_kid, homework_view_tutor, hub_schema_version)
-- keep theirs.
-- ---------------------------------------------------------------------

-- The tutor link: its token is the key.
revoke execute on function public.coach_view_by_token(text)                from public, service_role;
revoke execute on function public.coach_note_by_token(text, uuid, text)    from public, service_role;
grant  execute on function public.coach_view_by_token(text)                to anon, authenticated;
grant  execute on function public.coach_note_by_token(text, uuid, text)    to anon, authenticated;

-- The parents.
revoke execute on function public.set_tutor_coach(uuid, boolean)           from public, anon, service_role;
revoke execute on function public.coach_note_done(uuid)                    from public, anon, service_role;
grant  execute on function public.set_tutor_coach(uuid, boolean)           to authenticated;
grant  execute on function public.coach_note_done(uuid)                    to authenticated;

-- Private: the definer token functions call it; nobody else.
revoke execute on function private.coach_view(uuid)                        from public, anon, authenticated;

commit;
