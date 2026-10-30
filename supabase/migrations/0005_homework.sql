-- =====================================================================
-- HOME HUB v1.3 — migration 0005: Homework (plans, focus sessions, points, the tutor link)
-- Apply once, after 0004. The build contract is docs/v1.3-homework.md
-- (§3 lists everything here; the section numbers below are that file's).
--
-- What it adds
--   • Tables: homework_kids (homework is on for a kid), homework_times (which repeating events
--     are his homework time), tutor_links (the tutor's way in), assignments (and lessons),
--     homework_steps (a plan's steps), focus_sessions (the timer's blocks), rewards and
--     reward_asks (what points buy, and his trades), points_ledger (every point), homework_use
--     (what each link did today: the caps) and ai_runs (one row per AI request; PR B calls it).
--     household gains homework_ai, homework_ai_month and homework_never_send.
--   • Pages: homework_week(); the parents' actions (save_homework_kid, add_homework_time,
--     save_homework_plan, homework_step, decide_reward, give_points, void_points, save_tutor_link,
--     new_tutor_token, homework_ai_preview, erase_homework).
--   • My day: Jordan's seven token functions (homework_by_token, step_by_token, plan_by_token,
--     focus_by_token, reward_by_token, assignment_by_token, homework_prefs_by_token), and the
--     tutor link's four (tutor_view_by_token, tutor_assignment_by_token, tutor_plan_by_token,
--     tutor_step_by_token).
--   • hub-jobs (PR B): homework_ai_start and homework_ai_finish. Nothing calls them yet.
--   • Replaced, with the same signatures: get_person_day (the homework card) and
--     hub_schema_version() (5). digest_for, day_text, calendar_desired, calendar_plan, agenda and
--     person_items are not touched: 0005 touches neither wrapper of 0004.
--
-- Rules
--   • One transaction. It refuses to run without 0004, twice, or on a database that isn't as
--     0004 left it.
--   • Additive: every v2 page works the same on 4 and 5.
--   • Every table has row-level security. No rows are seeded: with homework off for everyone,
--     the email, the texts, My day and the wall come out byte for byte as on 4 (§3.7).
--   • Eleven new functions for anon (the token functions). A tutor token is never a My day
--     token: every other token function looks up people.day_token only.
--   • Every time the functions write is private.now(), so the tests can move the clock.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002, 0003 and 0004 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 4 then
    raise exception 'Meals and shopping (migration 0004) isn''t installed (hub_schema_version() is %). Run 0004_meals_and_shopping.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 5 then
    raise exception 'Homework (migration 0005) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  -- A database rolled back as §16.3 says: before the shape check, so it gets the right message.
  if to_regclass('public.homework_kids') is not null then
    raise exception 'Homework (migration 0005) is already installed, but hub_schema_version() was set back to 4. To switch it on again, make hub_schema_version() return 5 (docs/v1.3-homework.md §16.3). Nothing was changed.';
  end if;
  -- What this migration replaces and reads is as 0004 left it.
  if to_regprocedure('public.get_person_day(text)') is null
     or to_regprocedure('private.digest_for_v3(uuid, date)') is null
     or to_regclass('public.shopping_items') is null then
    raise exception 'This database isn''t as migration 0004 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables (§3.2)
-- ---------------------------------------------------------------------

-- Homework is on for this kid: one row per kid, made by a parent (save_homework_kid).
create table public.homework_kids (
  kid_id             uuid primary key references public.people (id) on delete cascade,
  active             boolean not null default true,     -- off: no card on his My day, his tutor links answer null, the AI refuses; nothing deleted
  points_on          boolean not null default true,     -- off: nothing earned; points, rewards and asks hidden on My day
  focus_minutes      int not null default 20 check (focus_minutes in (10, 15, 20, 25)),   -- the length offered first
  cue                text check (cue is null or char_length(cue) between 1 and 120),           -- his start cue, in his words
  if_stuck           text check (if_stuck is null or char_length(if_stuck) between 1 and 120), -- his if-then line
  pts_focus          int not null default 1 check (pts_focus between 0 and 5),                -- per 5 minutes of a block
  pts_on_time        int not null default 5 check (pts_on_time between 0 and 50),
  pts_milestone      int not null default 20 check (pts_milestone between 0 and 100),
  pts_day_cap        int not null default 20 check (pts_day_cap between 0 and 300),           -- focus and on-time points a day
  pts_milestone_week int not null default 80 check (pts_milestone_week between 0 and 400),    -- milestone points a household week (Mon–Sun)
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text
);

-- Which repeating events are a kid's homework time. The event itself is changed on the Calendar
-- page, as any event; deleting it removes the link.
create table public.homework_times (
  event_id uuid primary key references public.events (id) on delete cascade,
  kid_id   uuid not null references public.homework_kids (kid_id) on delete cascade
);
create index homework_times_kid on public.homework_times (kid_id);

-- A tutor's way in: one kid's homework and nothing else; at most 3 per kid. Never a person.
create table public.tutor_links (
  id           uuid primary key default gen_random_uuid(),
  kid_id       uuid not null references public.homework_kids (kid_id) on delete cascade,
  token        text not null unique default encode(extensions.gen_random_bytes(16), 'hex') check (token ~ '^[0-9a-f]{32}$'),
  label        text not null check (char_length(label) between 1 and 60),   -- "Pat Lee, tutor"
  language     text not null default 'en' check (language in ('en', 'es')),
  active       boolean not null default true,     -- Off: the link answers null at once
  expires_on   date not null,                     -- today + 180 unless a parent sets it; at most today + 400
  can_ai       boolean not null default true,     -- may send an assignment to Claude (while household.homework_ai is on)
  last_used_at timestamptz,                       -- the last call through the link, to the minute
  created_at   timestamptz not null default now(),
  created_by   text,
  updated_at   timestamptz not null default now(),
  updated_by   text
);
create index tutor_links_kid on public.tutor_links (kid_id);

-- An assignment from school, or a lesson a parent or the tutor plans.
create table public.assignments (
  id         uuid primary key default gen_random_uuid(),   -- made by the page for adds from Jordan's and the tutor's links
  kid_id     uuid not null references public.homework_kids (kid_id) on delete cascade,
  kind       text not null default 'assignment' check (kind in ('assignment', 'lesson')),
  added_by   text not null default 'family' check (added_by in ('family', 'tutor', 'kid')),   -- "added by Jordan"
  title      text not null check (char_length(title) between 1 and 120),
  subject    text check (subject is null or char_length(subject) between 1 and 40),   -- "Science"
  due_date   date not null,                     -- a lesson's "do by" day
  details    text check (details is null or char_length(details) between 1 and 4000),
             -- the teacher's text, pasted, line breaks kept: what the AI reads; emptied 30 days after due_date
  stretch    text check (stretch is null or char_length(stretch) between 1 and 160),
             -- an optional "interesting angle" question for him; earns nothing and is never a step
  status     text not null default 'open' check (status in ('open', 'done', 'dropped')),
  done_at    timestamptz,                       -- set by the tidy trigger when status becomes 'done'
  given_at   timestamptz,                       -- the plan is on his My day since
  given_by   text,                              -- by: an email, "<label> (tutor link)", or "<name> (My day)" for Quick
  plan_rev   int not null default 0,            -- +1 on every change to its steps (his ticks and moves too)
  ai_state   text check (ai_state in ('running', 'ready', 'failed')),
  ai_stop    text,                              -- the last run's fixed code when it failed
  ai_draft   jsonb,                             -- the last AI draft, checked and placed; never the plan
  ai_prev    jsonb,                             -- the draft before it (one Undo)
  ai_at      timestamptz,                       -- when ai_draft was written; both cleared 30 days after
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  check ((status = 'done') = (done_at is not null)),
  check ((given_at is null) = (given_by is null))
);
create index assignments_kid on public.assignments (kid_id, status, due_date);

-- An assignment's plan: its steps in order. Only plans people saved: an AI draft is never here.
-- No unique index on pos: a save rewrites positions in one go; reads order by pos, id.
create table public.homework_steps (
  id              uuid primary key default gen_random_uuid(),   -- Make it smaller: the phone's key
  assignment_id   uuid not null references public.assignments (id) on delete cascade,
  pos             int not null check (pos between 1 and 20),
  kind            text not null default 'step' check (kind in ('start', 'step', 'milestone', 'check', 'turn_in')),
  title           text not null check (char_length(title) between 3 and 80),
  done_looks_like text check (done_looks_like is null or char_length(done_looks_like) between 1 and 160),
  minutes         int not null check (minutes between 5 and 60),
  day             date not null,                 -- the day it's planned for
  moved_from      date,                          -- the day before his last "Not today"
  source          text not null default 'typed' check (source in ('typed', 'template', 'ai')),
                                                 -- 'typed' once a person changes it: a revision keeps it ("locked")
  done_at         timestamptz,
  done_by         text,                          -- "<name> (My day)", "<label> (tutor link)", an email
  checked_at      timestamptz,
  checked_by      text,                          -- a milestone the tutor or a parent looked at: its points are paid then
  not_yet_at      timestamptz,                   -- Not yet; cleared by his next tick
  coach_note      text check (coach_note is null or char_length(coach_note) between 1 and 160),
  coach_note_by   text check (coach_note_by in ('tutor', 'family')),
  coach_note_at   timestamptz,
  question        text check (question is null or char_length(question) between 1 and 200),   -- Ask Pat
  question_at     timestamptz,
  answer          text check (answer is null or char_length(answer) between 1 and 200),
  answer_by       text,                          -- the writer's label: an email, or "<label> (tutor link)"
  answer_at       timestamptz,
  qa_log          jsonb not null default '[]',   -- earlier questions, answers and notes on this step (at most 10)
  updated_at      timestamptz not null default now(),
  updated_by      text,                          -- set by plan_save and step_act; no stamp trigger
  check ((done_at is null) = (done_by is null)),
  check ((checked_at is null) = (checked_by is null)),
  check (checked_at is null or (kind = 'milestone' and done_at is not null)),
  check ((coach_note is null) = (coach_note_at is null) and (coach_note is null) = (coach_note_by is null))
);
create index homework_steps_assignment on public.homework_steps (assignment_id, pos);
create index homework_steps_open_day on public.homework_steps (day) where done_at is null;

-- One focus block on the timer. Only the database's clock counts.
create table public.focus_sessions (
  id            uuid primary key,                -- made by the phone, so a resent Start finds it (only its kid's)
  kid_id        uuid not null references public.homework_kids (kid_id) on delete cascade,
  assignment_id uuid references public.assignments (id) on delete set null,
  step_id       uuid references public.homework_steps (id) on delete set null,
  minutes       int not null check (minutes in (10, 15, 20, 25)),   -- the length chosen
  with_whom     text not null default 'alone' check (with_whom in ('alone', 'tutor', 'parent')),   -- recorded, not rewarded
  started_at    timestamptz not null,            -- private.now()
  ends_at       timestamptz not null,            -- started_at + minutes
  ended_at      timestamptz,
  result        text check (result in ('done', 'more', 'stopped', 'expired')),
  seen_minutes  int check (seen_minutes is null or seen_minutes between 0 and 25),   -- whole minutes the server saw
  on_time       boolean not null default false,  -- the day's first block, started in the on-time window
  points        int not null default 0,          -- what it earned (focus and on-time), for the record
  note          text check (note is null or char_length(note) between 1 and 120),   -- "what I got done"
  check ((ended_at is null) = (result is null)),
  check (ends_at = started_at + make_interval(mins => minutes))
);
create unique index focus_sessions_open on public.focus_sessions (kid_id) where ended_at is null;
create index focus_sessions_kid on public.focus_sessions (kid_id, started_at desc);

-- What points buy: the parents' list, and his suggestions.
create table public.rewards (
  id         uuid primary key default gen_random_uuid(),   -- a suggestion: the phone's key
  kid_id     uuid not null references public.homework_kids (kid_id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 60),   -- "Choose Friday's dinner"
  cost       int check (cost is null or cost between 1 and 10000),         -- null: a suggestion nobody has priced yet
  active     boolean not null default true,
  suggested  boolean not null default false,     -- he suggested it
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  check (cost is not null or not active)
);

-- His trades: each asked by him, decided by a parent.
create table public.reward_asks (
  id         uuid primary key default gen_random_uuid(),   -- the phone's key
  kid_id     uuid not null references public.homework_kids (kid_id) on delete cascade,
  reward_id  uuid references public.rewards (id) on delete set null,
  title      text not null,                     -- copied when asked, so a later edit doesn't change a trade
  cost       int not null,
  status     text not null default 'waiting' check (status in ('waiting', 'approved', 'declined', 'cancelled')),
  asked_at   timestamptz not null,
  decided_at timestamptz,
  decided_by text,
  note       text check (note is null or char_length(note) between 1 and 120)   -- a parent's word with a decline
);
create unique index reward_asks_waiting on public.reward_asks (kid_id, reward_id) where status = 'waiting';
create index reward_asks_kid on public.reward_asks (kid_id, asked_at desc);

-- Every point earned, given, voided and traded. Rows are never changed; the only delete is a
-- milestone check taken back within 15 minutes (a mis-tap).
create table public.points_ledger (
  id         uuid primary key default gen_random_uuid(),   -- given points: the parent's page's key
  kid_id     uuid not null references public.homework_kids (kid_id) on delete cascade,
  at         timestamptz not null,              -- private.now()
  day        date not null,                     -- the household's day it counts for: a block's start day for focus and on_time
  kind       text not null check (kind in ('focus', 'on_time', 'milestone', 'given', 'void', 'trade')),
  delta      int not null check (delta <> 0 and delta between -10000 and 1000),
  session_id uuid references public.focus_sessions (id) on delete set null,
  step_id    uuid references public.homework_steps (id) on delete set null,
  ask_id     uuid references public.reward_asks (id) on delete set null,
  void_of    uuid references public.points_ledger (id) on delete set null,   -- the entry a 'void' cancels
  note       text check (note is null or char_length(note) between 1 and 120),   -- the step's or reward's title, a parent's reason
  who        text not null,                     -- "<name> (My day)", "<label> (tutor link)", a parent's email
  check ((kind in ('void', 'trade')) = (delta < 0))
);
create unique index points_focus_once on public.points_ledger (session_id) where kind = 'focus';
create unique index points_on_time_once on public.points_ledger (kid_id, day) where kind = 'on_time';
create unique index points_milestone_once on public.points_ledger (step_id) where kind = 'milestone';
create unique index points_void_once on public.points_ledger (void_of) where kind = 'void';
create index points_ledger_kid on public.points_ledger (kid_id, at desc);

-- What each link did to homework today (the caps in §13.1). Only private.count_homework, a
-- definer function, writes and reads it.
create table public.homework_use (
  actor_id uuid,                                -- the kid (his My day) or the tutor link
  day      date,                                -- the household's day
  what     text check (what in ('writes', 'starts')),
  n        int not null default 0,
  primary key (actor_id, day, what)
);

-- One row per AI request: who, when, what it cost; never the prompt or the answer.
create table public.ai_runs (
  id                 uuid primary key default gen_random_uuid(),
  kid_id             uuid references public.homework_kids (kid_id) on delete cascade,   -- null for Test the AI planner
  assignment_id      uuid references public.assignments (id) on delete set null,
  link_id            uuid references public.tutor_links (id) on delete set null,
  kind               text not null check (kind in ('plan', 'revise', 'test')),
  asked_by           text not null,             -- a parent's email, or "<label> (tutor link)"
  key                uuid not null unique,      -- the page's key: a resend gets this run
  status             text not null default 'running' check (status in ('running', 'ready', 'failed')),
  stop               text,                      -- a fixed code (§6.9)
  model              text,                      -- the model that answered (a fallback names its own)
  started_at         timestamptz not null,
  lease_until        timestamptz not null,
  finished_at        timestamptz,
  input_tokens       int,
  cache_read_tokens  int,
  cache_write_tokens int,
  output_tokens      int,
  cents              numeric(8, 2)              -- an estimate, from fixed prices in homework.ts
);
create index ai_runs_started on public.ai_runs (started_at);
create index ai_runs_assignment on public.ai_runs (assignment_id, started_at);

-- Three switches for parents (household's policies: members read, admins update).
alter table public.household
  add column homework_ai         boolean not null default false,   -- the AI planner; off until a parent turns it on
  add column homework_ai_month   int not null default 150 check (homework_ai_month between 0 and 500),   -- AI runs a month, at most
  add column homework_never_send text[] not null default '{}' check (cardinality(homework_never_send) <= 20);
                                 -- words the AI must never see (the school's name, teachers' names)

-- ---------------------------------------------------------------------
-- Words and text (§3.5)
-- ---------------------------------------------------------------------

-- v1.3's fixed words in English and Spanish. Anything else falls back to private.food_word, and
-- so to private.calendar_word and private.word (all left as they are).
create function private.homework_word(p_key text, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(w -> p_lang ->> p_key, w -> 'en' ->> p_key, private.food_word(p_key, p_lang))
  from (select '{
    "en": {"homework": "Homework", "turn_in": "Turn it in"},
    "es": {"homework": "Tarea", "turn_in": "Entregarlo"}
  }'::jsonb as w) dictionary;
$$;

-- As private.clean_text(p_text, p_max), but keeps line breaks: each line cleaned on its own
-- (control, bidi and zero-width characters out, runs of spaces one space), never two blank lines
-- in a row, none at the start or the end, at most 60 lines, then cut to p_max characters.
-- \r\n, \r, U+2028 and U+2029 are line breaks. Null stays null.
create function private.clean_block(p_text text, p_max int)
returns text
language sql
immutable
set search_path = ''
as $$
  with lines as (
    select x.n, private.clean_text(x.l, greatest(p_max, 0)) as l
    from regexp_split_to_table(regexp_replace(p_text, '\r\n?|[  \u000b\u000c\u0085]', E'\n', 'g'), E'\n')
         with ordinality x (l, n)
  ),
  kept as (
    select y.n, y.l
    from (select l.n, l.l, lag(l.l) over (order by l.n) as prev from lines l) y
    where not (y.l = '' and coalesce(y.prev, '') = '')   -- a blank line after a blank line, or at the start
  )
  select rtrim(left(regexp_replace(string_agg(k.l, E'\n' order by k.n), '\n+$', ''), greatest(p_max, 0)), E' \n')
  from (select z.n, z.l from kept z order by z.n limit 60) k
  where p_text is not null;
$$;

-- ---------------------------------------------------------------------
-- Tidy values (the triggers). Same-event triggers fire in name order: each table's _stamp runs
-- before its _tidy.
-- ---------------------------------------------------------------------

-- His start cue and if-stuck line: one line each, at most 120 characters; '' becomes null.
create function private.homework_kids_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.cue := nullif(private.clean_text(new.cue, 120), '');
  new.if_stuck := nullif(private.clean_text(new.if_stuck, 120), '');
  return new;
end;
$$;

-- An assignment's title and class on one line, the teacher's text with its line breaks
-- (private.clean_block), the stretch question on one line; '' becomes null (a title of spaces
-- is then too short). done_at follows status: set when it becomes 'done', kept while it stays so,
-- null otherwise.
create function private.assignments_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := private.clean_text(new.title, 120);
  new.subject := nullif(private.clean_text(new.subject, 40), '');
  new.details := nullif(private.clean_block(new.details, 4000), '');
  new.stretch := nullif(private.clean_text(new.stretch, 160), '');
  new.done_at := case when new.status <> 'done' then null
                      when tg_op = 'UPDATE' and old.status = 'done' then old.done_at
                      else private.now() end;
  return new;
end;
$$;

-- A reward's title on one line, at most 60 characters.
create function private.rewards_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := private.clean_text(new.title, 60);
  return new;
end;
$$;

-- A tutor link's label on one line, at most 60 characters.
create function private.tutor_links_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.label := private.clean_text(new.label, 60);
  return new;
end;
$$;

-- The household's AI words: each never-send word 2 to 40 characters on one line, and the AI
-- planner on only with at least one. Plain SQL and no other function: it runs as the parent
-- who saves the household.
create function private.household_homework_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from unnest(new.homework_never_send) w
             where w is null or char_length(w) not between 2 and 40 or w ~ '[[:cntrl:]  ]') then
    raise exception 'Words never to send: each 2 to 40 characters, one line.' using errcode = '22023';
  end if;
  if new.homework_ai and cardinality(new.homework_never_send) = 0 then
    raise exception 'Add the school''s name to Words never to send first.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger homework_kids_stamp before insert or update on public.homework_kids
  for each row execute function private.stamp();
create trigger homework_kids_tidy before insert or update on public.homework_kids
  for each row execute function private.homework_kids_tidy();
-- A read through the link sets last_used_at only: that never changes updated_at.
create trigger tutor_links_stamp before insert on public.tutor_links
  for each row execute function private.stamp();
create trigger tutor_links_stamp_change before update on public.tutor_links
  for each row when ((to_jsonb(old) - 'last_used_at') is distinct from (to_jsonb(new) - 'last_used_at'))
  execute function private.stamp();
create trigger tutor_links_tidy before insert or update on public.tutor_links
  for each row execute function private.tutor_links_tidy();
create trigger assignments_stamp before insert or update on public.assignments
  for each row execute function private.stamp();
create trigger assignments_tidy before insert or update on public.assignments
  for each row execute function private.assignments_tidy();
create trigger rewards_stamp before insert or update on public.rewards
  for each row execute function private.stamp();
create trigger rewards_tidy before insert or update on public.rewards
  for each row execute function private.rewards_tidy();
create trigger household_homework_check before insert or update on public.household
  for each row execute function private.household_homework_check();

-- ---------------------------------------------------------------------
-- Row-level security and grants (§3.2, §3.3)
-- ---------------------------------------------------------------------
alter table public.homework_kids  enable row level security;
alter table public.homework_times enable row level security;
alter table public.tutor_links    enable row level security;
alter table public.assignments    enable row level security;
alter table public.homework_steps enable row level security;
alter table public.focus_sessions enable row level security;
alter table public.rewards        enable row level security;
alter table public.reward_asks    enable row level security;
alter table public.points_ledger  enable row level security;
alter table public.homework_use   enable row level security;
alter table public.ai_runs        enable row level security;

-- Every grown-up who signs in reads homework; only the parents change it. Rows are made through
-- save_homework_kid and removed through erase_homework.
create policy "Family can see homework settings" on public.homework_kids
  for select to authenticated using (private.is_member());
create policy "Parents change homework settings" on public.homework_kids
  for update to authenticated using (private.is_admin()) with check (private.is_admin());

create policy "Family can see homework time" on public.homework_times
  for select to authenticated using (private.is_member());
create policy "Parents add homework time" on public.homework_times
  for insert to authenticated with check (private.is_admin());
create policy "Parents remove homework time" on public.homework_times
  for delete to authenticated using (private.is_admin());

-- The parents read a link to copy and send it; writes go through save_tutor_link and new_tutor_token.
create policy "Parents can see tutor links" on public.tutor_links
  for select to authenticated using (private.is_admin());

create policy "Family can see assignments" on public.assignments
  for select to authenticated using (private.is_member());
create policy "Parents add assignments" on public.assignments
  for insert to authenticated with check (private.is_admin());
create policy "Parents change assignments" on public.assignments
  for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy "Parents remove assignments" on public.assignments
  for delete to authenticated using (private.is_admin());

-- Steps, blocks, asks and points: read only. The functions in §3.5 write.
create policy "Family can see homework plans" on public.homework_steps
  for select to authenticated using (private.is_member());
create policy "Family can see focus sessions" on public.focus_sessions
  for select to authenticated using (private.is_member());
create policy "Family can see reward asks" on public.reward_asks
  for select to authenticated using (private.is_member());
create policy "Family can see points" on public.points_ledger
  for select to authenticated using (private.is_member());

create policy "Family can see rewards" on public.rewards
  for select to authenticated using (private.is_member());
create policy "Parents add rewards" on public.rewards
  for insert to authenticated with check (private.is_admin());
create policy "Parents change rewards" on public.rewards
  for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy "Parents remove rewards" on public.rewards
  for delete to authenticated using (private.is_admin());

-- Who asked the AI, when, the result and the estimated cost: the parents. hub-jobs writes
-- through homework_ai_start and homework_ai_finish.
create policy "Parents can see AI runs" on public.ai_runs
  for select to authenticated using (private.is_admin());

-- homework_use: no policies.

-- Supabase's default privileges would give anon and authenticated everything on a new table
-- (truncate ignores row-level security). Anon gets nothing; members read (row-level security
-- decides: tutor_links and ai_runs are the parents' only), and the parents write only the columns
-- the Homework page sets: never given_*, plan_rev, done_at, cue, added_by, the AI's columns or the
-- audit columns. Steps, blocks, asks, points and AI runs have no write grant at all.
-- service_role keeps the defaults on the rest (hub-jobs calls only definer functions anyway);
-- homework_use is for its owner only.
revoke all on public.homework_kids, public.homework_times, public.tutor_links, public.assignments,
              public.homework_steps, public.focus_sessions, public.rewards, public.reward_asks,
              public.points_ledger, public.homework_use, public.ai_runs
  from public, anon, authenticated;
grant select on public.homework_kids, public.homework_times, public.tutor_links, public.assignments,
                public.homework_steps, public.focus_sessions, public.rewards, public.reward_asks,
                public.points_ledger, public.ai_runs to authenticated;
grant update (active, points_on, focus_minutes, pts_focus, pts_on_time, pts_milestone, pts_day_cap, pts_milestone_week)
  on public.homework_kids to authenticated;
grant insert (event_id, kid_id), delete on public.homework_times to authenticated;
grant insert (kid_id, kind, title, subject, due_date, details, stretch, status),
      update (kind, title, subject, due_date, details, stretch, status), delete on public.assignments to authenticated;
grant insert (kid_id, title, cost, active, sort_order), update (title, cost, active, sort_order), delete
  on public.rewards to authenticated;
revoke all on public.homework_use from service_role;

-- ---------------------------------------------------------------------
-- Who a link is (§3.5)
-- ---------------------------------------------------------------------

-- The kid whose My day token this is, when homework is on for him: private.person_by_token (an
-- active person with a well-formed token), with role 'kid' and an active homework_kids row.
-- Else a null row.
create function private.homework_kid_by_token(p_token text)
returns public.people
language sql
stable
security definer
set search_path = ''
as $$
  select p.*
  from private.person_by_token(p_token) p
  where p.role = 'kid'
    and exists (select 1 from public.homework_kids k where k.kid_id = p.id and k.active);
$$;

-- The tutor link whose token this is (32 hex characters): on, not past its end date, for a kid
-- who is active, still a kid and has homework on. Else a null row. It notes the call in
-- last_used_at, to the minute, when that is older than a minute (the stamp trigger skips that
-- column, so a read never changes updated_at). Only people.day_token opens anything else.
create function private.tutor_link_by_token(p_token text)
returns public.tutor_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.tutor_links;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return null;
  end if;
  select l.* into v_link
  from public.tutor_links l
  join public.homework_kids k on k.kid_id = l.kid_id and k.active
  join public.people p on p.id = l.kid_id and p.active and p.role = 'kid'
  where l.token = p_token and l.active and l.expires_on >= public.today_local();
  if v_link.id is null then
    return null;
  end if;
  if v_link.last_used_at is null or v_link.last_used_at < private.now() - interval '1 minute' then
    update public.tutor_links set last_used_at = date_trunc('minute', private.now()) where id = v_link.id;
  end if;
  return v_link;
end;
$$;

-- One more write ('writes') or Start ('starts') for this actor (the kid, or a tutor link) today.
-- The upsert's row lock queues parallel calls, so the count is exact. Past p_max it refuses
-- (P0001), and the refused call's own count rolls back with it. Rows older than 2 days go.
create function private.count_homework(p_actor uuid, p_what text, p_max int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.today_local();
  v_n     int;
begin
  if p_what is null or p_what not in ('writes', 'starts') then
    raise exception 'count_homework counts writes or starts.' using errcode = '22023';
  end if;
  insert into public.homework_use as u (actor_id, day, what, n)
  values (p_actor, v_today, p_what, 1)
  on conflict (actor_id, day, what) do update set n = u.n + 1
  returning u.n into v_n;
  if v_n = 1 then
    delete from public.homework_use u where u.day < v_today - 2;
  end if;
  if v_n > p_max then
    raise exception 'That''s a lot for one day.' using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Homework time, busy time and placement (§5)
-- ---------------------------------------------------------------------

-- A kid's homework time from p_from to p_to (cut to p_from + 55: public.agenda takes at most 62
-- days), one row per day that has some, with the caller's rights (a non-member gets none):
--   starts, ends:    the day's homework-time occurrences (public.agenda's events whose item is in
--                    homework_times for the kid, not cancelled, after one-day changes): first
--                    start, last end;
--   window_minutes:  their minutes, each once (at most 240);
--   free:            what is left after busy time (at most 240): every timed item of his that day
--                    (events he is in charge of or along on, tasks with a time, the Google events
--                    that reach his day; not the homework-time events themselves; an item with no
--                    end lasts an hour, as agenda counts an event), plus 15 minutes after one that
--                    ends inside the homework time. All-day items don't block time;
--   planned:         minutes of not-done steps on that day in his open assignments, all but p_except;
--   busy:            the blocks that touch the homework time, [{starts, ends, title}];
--   first_free:      the first free minute (the on-time window is around it, §7.1), or null.
-- Minutes count from the day's local midnight, so a clock change doesn't move them.
create function private.free_minutes(p_kid uuid, p_from date, p_to date, p_except uuid)
returns table (day date, starts time, ends time, window_minutes int, free int, planned int, busy jsonb, first_free time)
language sql
stable
set search_path = ''
as $$
  with r as (
    select p_from as f, least(p_to, p_from + 55) as t, private.tz() as tz
    where p_kid is not null and p_from is not null and p_to is not null and p_to >= p_from
  ),
  ag as materialized (
    select a.* from r cross join lateral public.agenda(r.f, r.t) a
  ),
  win as (
    select a.day,
           floor(extract(epoch from (a.start_at at time zone r.tz) - a.day::timestamp) / 60)::int as s,
           least(ceil(extract(epoch from (a.end_at at time zone r.tz) - a.day::timestamp) / 60), 1440)::int as e
    from ag a cross join r
    where a.kind = 'event' and a.status <> 'cancelled' and a.start_at is not null
      and exists (select 1 from public.homework_times h where h.event_id = a.item_id and h.kid_id = p_kid)
  ),
  blocks as (
    select a.day, a.title, a.start_at, coalesce(a.end_at, a.start_at + interval '1 hour') as end_at
    from ag a
    where (a.responsible_id = p_kid or p_kid = any (a.participant_ids))
      and a.status <> 'cancelled' and a.start_at is not null
      and not (a.kind = 'event' and exists (select 1 from public.homework_times h where h.event_id = a.item_id and h.kid_id = p_kid))
    union all
    select g.day, g.title, g.start_at, coalesce(g.end_at, g.start_at + interval '1 hour')
    from r cross join lateral private.google_for(p_kid, r.f, r.t, false) g
    where not g.all_day and g.start_at is not null
  ),
  bl as (
    select b.day, b.title, (b.start_at at time zone r.tz) as ls, (b.end_at at time zone r.tz) as le,
           floor(extract(epoch from (b.start_at at time zone r.tz) - b.day::timestamp) / 60)::int as s,
           least(ceil(extract(epoch from (b.end_at at time zone r.tz) - b.day::timestamp) / 60), 1440)::int as e
    from blocks b cross join r
  ),
  -- The busy blocks that touch the homework time, with 15 minutes after one that ends inside it.
  bx as (
    select b.day, b.title, b.ls, b.le, b.s,
           b.e + case when exists (select 1 from win w where w.day = b.day and w.s < b.e and b.e < w.e) then 15 else 0 end as e
    from bl b
    where exists (select 1 from win w where w.day = b.day and b.s < w.e and b.e > w.s)
  ),
  -- Each minute of the homework time once, and whether a busy block takes it.
  wm as (
    select x.day, x.m, exists (select 1 from bx where bx.day = x.day and x.m >= bx.s and x.m < bx.e) as busy
    from (select distinct w.day, m.m from win w cross join lateral generate_series(w.s, w.e - 1) m (m)) x
  ),
  fm as (
    select wm.day, count(*)::int as wmin, (count(*) filter (where not wm.busy))::int as fmin,
           min(wm.m) filter (where not wm.busy) as first_m
    from wm
    group by wm.day
  ),
  pl as (
    select st.day, sum(st.minutes)::int as m
    from public.homework_steps st
    join public.assignments a on a.id = st.assignment_id
    cross join r
    where a.kid_id = p_kid and a.status = 'open' and a.id is distinct from p_except
      and st.done_at is null and st.day between r.f and r.t
    group by st.day
  ),
  dd as (
    select w.day, min(w.s) as s, max(w.e) as e from win w group by w.day
  )
  select d.day,
         make_time(d.s / 60, d.s % 60, 0),
         make_time(d.e / 60, d.e % 60, 0),
         least(f.wmin, 240),
         least(f.fmin, 240),
         coalesce(p.m, 0),
         coalesce((select jsonb_agg(jsonb_build_object('starts', to_char(bx.ls, 'HH24:MI'), 'ends', to_char(bx.le, 'HH24:MI'),
                                                       'title', bx.title) order by bx.ls, bx.title)
                   from bx where bx.day = d.day), '[]'),
         case when f.first_m is not null then make_time(f.first_m / 60, f.first_m % 60, 0) end
  from dd d
  join fm f on f.day = d.day
  left join pl p on p.day = d.day
  order by d.day;
$$;

-- The one placement rule (§5.4), for starter plans, AI drafts, Place again, Re-plan and Quick.
-- p_steps is the plan in order: [{kind, minutes, day?, fixed?, done?, …}]. A step that is done or
-- fixed keeps its day (a person's day, a checkpoint in Re-plan). The others are placed:
--   1. Days to use: from today, if today's homework time hasn't ended yet, else tomorrow, to the
--      last work day: the day before the due date, or two days before when it is 7 or more days
--      away; a lesson's "do by" day itself. Never past the 56th day from today (horizon). A turn-in
--      goes on the due date (today, for one past due).
--   2. Room on a day: free − planned (his other assignments) − what this plan already put there.
--   3. In order: a step's own day (an AI draft's) is kept when it is in range, not before the
--      previous step's day and has room; else the first day on or after the previous step's day,
--      and not after the next fixed step's day, with room ("stays between them while there is
--      room"); else, past it, up to the last work day.
--   4. No room: the day with the most room left (on or after the previous step's day), and the
--      answer says fits false with over (the minutes too many).
-- Answers {steps (each with its day), fits, over, horizon, minutes_left, time_left}: time_left is
-- the room from the first day to the last work day before this plan; minutes_left the not-done
-- steps' minutes. With no homework time at all: {fits: false, no_time: true}.
create function private.place_steps(p_kid uuid, p_assignment uuid, p_due date, p_steps jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today   date := public.today_local();
  v_cap     date := public.today_local() + 55;
  v_lesson  boolean;
  v_due     date := greatest(p_due, public.today_local());
  v_last    date;     -- the last work day, inside the horizon
  v_hard    date;     -- the latest day any step but the turn-in may have
  v_horizon date;
  v_first   date;
  v_open    boolean;
  v_days    date[];
  v_room    int[];
  v_n       int := coalesce(jsonb_array_length(p_steps), 0);
  v_out     jsonb := '[]';
  v_prev    date;
  v_ub      date;
  v_day     date;
  v_want    date;
  v_min     int;
  v_over    int := 0;
  v_left    int := 0;
  v_mins    int := 0;
  e         jsonb;
  i         int;
  j         int;
  v_pick    int;
begin
  select a.kind = 'lesson' into v_lesson from public.assignments a where a.id = p_assignment;
  v_last := case when coalesce(v_lesson, false) then v_due
                 when p_due - v_today >= 7 then p_due - 2
                 when p_due > v_today then p_due - 1
                 else v_today end;
  v_hard := case when coalesce(v_lesson, false) then v_due else greatest(p_due - 1, v_today) end;
  if v_last > v_cap then
    v_last := v_cap;
    v_horizon := v_cap;
  end if;
  select array_agg(f.day order by f.day), array_agg(f.free - f.planned order by f.day),
         bool_or(f.day = v_today and f.ends > (private.now() at time zone private.tz())::time)
  into v_days, v_room, v_open
  from private.free_minutes(p_kid, v_today, v_cap, p_assignment) f;
  if v_days is null then
    return jsonb_build_object('fits', false, 'no_time', true);
  end if;
  v_first := case when coalesce(v_open, false) then v_today else v_today + 1 end;

  -- The room there was before this plan, and what its fixed steps already take.
  select coalesce(sum(greatest(v_room[k], 0)), 0) into v_left
  from generate_subscripts(v_days, 1) k where v_days[k] between v_first and v_last;
  for i in 0 .. v_n - 1 loop
    e := p_steps -> i;
    if not coalesce((e ->> 'done')::boolean, false) then
      v_mins := v_mins + coalesce((e ->> 'minutes')::int, 0);
      if coalesce((e ->> 'fixed')::boolean, false) and e ->> 'day' is not null then
        j := array_position(v_days, (e ->> 'day')::date);
        if j is not null then
          v_room[j] := v_room[j] - coalesce((e ->> 'minutes')::int, 0);
        end if;
      end if;
    end if;
  end loop;

  v_prev := v_first;
  for i in 0 .. v_n - 1 loop
    e := p_steps -> i;
    if coalesce((e ->> 'done')::boolean, false) or (coalesce((e ->> 'fixed')::boolean, false) and e ->> 'day' is not null) then
      if not coalesce((e ->> 'done')::boolean, false) then
        v_prev := greatest(v_prev, (e ->> 'day')::date);
      end if;
      v_out := v_out || jsonb_build_array(e);
      continue;
    end if;
    if e ->> 'kind' = 'turn_in' then
      v_out := v_out || jsonb_build_array(e || jsonb_build_object('day', v_due));
      continue;
    end if;
    v_min := coalesce((e ->> 'minutes')::int, 0);
    v_want := private.safe_date(e ->> 'day');
    -- Not after the next fixed step that isn't done (a checkpoint the plain steps keep before).
    select min((x ->> 'day')::date) into v_ub
    from jsonb_array_elements(p_steps) with ordinality y (x, k)
    where y.k > i + 1 and coalesce((x ->> 'fixed')::boolean, false) and not coalesce((x ->> 'done')::boolean, false)
      and x ->> 'day' is not null and (x ->> 'day')::date >= v_today;
    v_ub := least(coalesce(v_ub, v_last), v_last);
    v_pick := null;
    if v_want is not null and v_want between v_prev and v_ub then
      j := array_position(v_days, v_want);
      if j is not null and v_room[j] >= v_min then
        v_pick := j;
      end if;
    end if;
    if v_pick is null then
      select min(k) into v_pick from generate_subscripts(v_days, 1) k
      where v_days[k] between v_prev and v_ub and v_room[k] >= v_min;
    end if;
    if v_pick is null and v_ub < v_last then
      select min(k) into v_pick from generate_subscripts(v_days, 1) k
      where v_days[k] between v_prev and v_last and v_room[k] >= v_min;
    end if;
    if v_pick is null then
      -- No room: the day with the most room left.
      select k into v_pick from generate_subscripts(v_days, 1) k
      where v_days[k] between v_prev and v_last
      order by v_room[k] desc, k
      limit 1;
      v_over := v_over + v_min - coalesce(greatest(v_room[v_pick], 0), 0);
    end if;
    if v_pick is not null then
      v_day := v_days[v_pick];
      v_room[v_pick] := v_room[v_pick] - v_min;
    else
      -- No homework day at all between the previous step's day and the last work day.
      v_day := least(v_prev, v_hard);
    end if;
    v_prev := greatest(v_prev, v_day);
    v_out := v_out || jsonb_build_array(e || jsonb_build_object('day', v_day));
  end loop;

  return jsonb_build_object('steps', v_out, 'fits', v_over = 0, 'over', v_over, 'horizon', v_horizon,
                            'minutes_left', v_mins, 'time_left', v_left);
end;
$$;

-- ---------------------------------------------------------------------
-- Plans (§4)
-- ---------------------------------------------------------------------

-- A plan's shape (§4.2), the same for every saver: at most 20 steps (an AI draft: 1 to 12); kinds
-- start, step, milestone, check, turn_in; at most 4 milestones; at most one turn-in, and it is
-- last; titles 3 to 80 characters and "done looks like" up to 160, both through
-- private.clean_text; minutes 5 to 60; no day after p_due; an id at most once. Raises 22023 with a
-- fixed message, or answers the cleaned steps [{id, kind, title, done_looks_like, minutes, day,
-- source}]. An AI draft (p_ai) is checked as §6.8 says: a start first when it has 3 or more steps,
-- "done looks like" 3 to 160, its minutes clamped (5 to 60; a start at most 10, a turn-in 5) and a
-- day it can't have dropped (the draft is placed again), its ref kept. The rules that need today
-- (nothing new in the past) are plan_save's.
create function private.plan_check(p_steps jsonb, p_due date, p_ai boolean)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ai    boolean := coalesce(p_ai, false);
  v_n     int;
  v_out   jsonb := '[]';
  v_ids   uuid[] := '{}';
  v_ms    int := 0;
  v_ti    int := 0;
  v_tipos int;
  e       jsonb;
  i       int := 0;
  v_kind  text;
  v_title text;
  v_done  text;
  v_min   int;
  v_day   date;
  v_id    uuid;
  v_src   text;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'A plan is a list of steps.' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_steps);
  if v_n > (case when v_ai then 12 else 20 end) then
    raise exception 'At most % steps.', case when v_ai then 12 else 20 end using errcode = '22023';
  end if;
  if v_ai and v_n = 0 then
    raise exception 'A plan needs a step.' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(p_steps) x loop
    i := i + 1;
    if jsonb_typeof(e) <> 'object' then
      raise exception 'Each step needs a title and minutes.' using errcode = '22023';
    end if;
    v_kind := coalesce(e ->> 'kind', 'step');
    if v_kind not in ('start', 'step', 'milestone', 'check', 'turn_in') then
      raise exception 'A step is a start, a step, a milestone, a check or the turn-in.' using errcode = '22023';
    end if;
    v_title := private.clean_text(e ->> 'title', 200);
    if v_title is null or char_length(v_title) not between 3 and 80 then
      raise exception 'A step''s title is 3 to 80 characters.' using errcode = '22023';
    end if;
    v_done := nullif(private.clean_text(e ->> 'done_looks_like', 400), '');
    if char_length(v_done) > 160 or (v_ai and coalesce(char_length(v_done), 0) < 3) then
      raise exception '"Done looks like" is % characters.', case when v_ai then '3 to 160' else 'at most 160' end
        using errcode = '22023';
    end if;
    if jsonb_typeof(e -> 'minutes') <> 'number' or (e ->> 'minutes') !~ '^[0-9]{1,4}$' then
      raise exception 'A step is 5 to 60 minutes.' using errcode = '22023';
    end if;
    v_min := (e ->> 'minutes')::int;
    if v_ai then
      v_min := case v_kind when 'turn_in' then 5 when 'start' then least(greatest(v_min, 5), 10) else least(greatest(v_min, 5), 60) end;
    elsif v_min not between 5 and 60 then
      raise exception 'A step is 5 to 60 minutes.' using errcode = '22023';
    end if;
    v_day := null;
    if e ->> 'day' is not null then
      if e ->> 'day' ~ '^\d{4}-\d{2}-\d{2}$' then
        v_day := private.safe_date(e ->> 'day');
      end if;
      if v_day is null and not v_ai then
        raise exception 'That day isn''t a date.' using errcode = '22023';
      end if;
      if v_day > p_due then
        if v_ai then
          v_day := null;
        else
          raise exception 'A step can''t be after the due date.' using errcode = '22023';
        end if;
      end if;
    end if;
    v_id := null;
    if e ->> 'id' is not null then
      if e ->> 'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'That step isn''t in this plan.' using errcode = '22023';
      end if;
      v_id := (e ->> 'id')::uuid;
      if v_id = any (v_ids) then
        raise exception 'A step is in the plan twice.' using errcode = '22023';
      end if;
      v_ids := v_ids || v_id;
    end if;
    v_src := case when e ->> 'source' in ('typed', 'template', 'ai') then e ->> 'source' end;
    if v_kind = 'milestone' then
      v_ms := v_ms + 1;
    elsif v_kind = 'turn_in' then
      v_ti := v_ti + 1;
      v_tipos := i;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'kind', v_kind, 'title', v_title, 'done_looks_like', v_done,
                                                           'minutes', v_min, 'day', v_day, 'source', v_src)
                                        || case when v_ai then jsonb_build_object('ref', e -> 'ref') else '{}' end);
  end loop;
  if v_ms > 4 then
    raise exception 'At most 4 milestones.' using errcode = '22023';
  end if;
  if v_ti > 1 then
    raise exception 'A plan has one turn-in.' using errcode = '22023';
  end if;
  if v_ti = 1 and v_tipos <> v_n then
    raise exception 'The turn-in is the last step.' using errcode = '22023';
  end if;
  if v_ai and v_n >= 3 and v_out -> 0 ->> 'kind' <> 'start' then
    raise exception 'A plan of 3 or more steps starts with a start.' using errcode = '22023';
  end if;
  return v_out;
end;
$$;

-- The one save rule for the parents, the tutor and the kid (§4.3, §4.4), and Re-plan.
-- p_steps is the whole plan in order, [{id?, kind, title, done_looks_like?, minutes, day?, source?}]:
-- steps with an id (one of this plan's) are changed, without one added, and the plan's steps
-- missing from the list deleted, except steps already done, which stay as they are whatever the
-- list says (at their place). p_rev must be the assignment's plan_rev (0 for a first plan), else
-- P0001 "This plan was changed since you opened it.": a save made on an old copy never deletes a
-- step he added since. Every save bumps plan_rev.
--   • Days: a step with a day keeps it (a new or moved one not in the past, and only the turn-in
--     on the due date); steps without one are placed (private.place_steps); with no homework time
--     at all that is 22023 "Set a homework time first.".
--   • source: a step a person adds or changes (its kind, title, "done looks like", minutes, or a day
--     given by hand) is 'typed'; a starter plan's new steps are 'template' (their minutes cut to his
--     first length; the turn-in 5), a used AI draft's 'ai'.
--   • p_role 'kid': only a plan given to him; plain steps (start, step, check) not done are his to
--     reorder, move, change, rename, delete and add; milestones and the turn-in keep their kind,
--     title, minutes and day and can't be added or removed (42501 "That's a checkpoint."). p_steps
--     null is Re-plan: his plain steps not done are placed again from today; milestones, the turn-in
--     and done steps keep their days.
--   • p_give (the tutor and the parents): the plan is on his My day from then on (given_at, given_by
--     set the first time).
-- Answers {plan: {assignment_id, plan_rev, steps, fits, over, horizon, minutes_left, time_left,
-- no_time, talk}}: talk is the milestones not done that are past their day, or that a step before
-- them can't reach any more (§4.5 Re-plan). Steps carry no names.
create function private.plan_save(p_assignment uuid, p_steps jsonb, p_give boolean, p_rev int, p_role text, p_who text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_a       public.assignments;
  v_k       public.homework_kids;
  v_today   date := public.today_local();
  v_now     timestamptz := private.now();
  v_kid     boolean := p_role = 'kid';
  v_in      jsonb;
  v_old     jsonb;            -- the plan's steps as they are: {id: row}
  v_list    jsonb := '[]';    -- the plan as it will be
  v_place   jsonb;
  v_ids     uuid[] := '{}';
  e         jsonb;
  o         jsonb;
  v_i       int := 0;
  v_pos     int := 0;
  v_id      uuid;
  v_src     text;
  v_min     int;
  v_moved   boolean;
  v_changed boolean;
  v_left    int;
  v_time    int;
  v_over    int;
begin
  if p_role is null or p_role not in ('kid', 'tutor', 'family') then
    raise exception 'A plan is saved by the kid, the tutor or the family.' using errcode = '22023';
  end if;
  if p_steps is not null and char_length(p_steps::text) > 20000 then
    raise exception 'That plan is too long.' using errcode = '22023';
  end if;
  select * into v_a from public.assignments a where a.id = p_assignment for update;
  if v_a.id is null then
    raise exception 'That assignment is gone.' using errcode = '22023';
  end if;
  if p_rev is null or p_rev <> v_a.plan_rev then
    raise exception 'This plan was changed since you opened it.' using errcode = 'P0001';
  end if;
  if v_a.status <> 'open' then
    raise exception 'This assignment is done or dropped. Open it again first.' using errcode = 'P0001';
  end if;
  if v_kid and v_a.given_at is null then
    raise exception 'Plan this one with Pat.' using errcode = '42501';
  end if;
  if p_steps is null and not v_kid then
    raise exception 'Send the plan''s steps.' using errcode = '22023';
  end if;
  select * into v_k from public.homework_kids k where k.kid_id = v_a.kid_id;
  select coalesce(jsonb_object_agg(s.id, to_jsonb(s)), '{}') into v_old
  from public.homework_steps s where s.assignment_id = v_a.id;

  if p_steps is null then
    -- Re-plan: the plan as it is, with no day on his plain steps not done.
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id, 'kind', s.kind, 'title', s.title, 'done_looks_like', s.done_looks_like, 'minutes', s.minutes,
             'day', case when s.done_at is not null or s.kind in ('milestone', 'turn_in') then s.day end, 'source', s.source)
           order by s.pos, s.id), '[]')
    into v_in
    from public.homework_steps s where s.assignment_id = v_a.id;
  else
    v_in := private.plan_check(p_steps, greatest(v_a.due_date, v_today), false);
  end if;

  for e in select x from jsonb_array_elements(v_in) x loop
    v_i := v_i + 1;
    v_id := (e ->> 'id')::uuid;
    o := null;
    if v_id is not null then
      o := v_old -> v_id::text;
      if o is null then
        if v_kid then
          raise exception 'That step isn''t on your plan.' using errcode = '42501';
        end if;
        raise exception 'That step isn''t in this plan.' using errcode = '22023';
      end if;
      v_ids := v_ids || v_id;
      if o ->> 'done_at' is not null then
        -- Done: kept as it is, at this place in the list.
        v_list := v_list || jsonb_build_array(jsonb_build_object(
                    'id', v_id, 'kind', o ->> 'kind', 'title', o ->> 'title', 'done_looks_like', o ->> 'done_looks_like',
                    'minutes', (o ->> 'minutes')::int, 'day', o ->> 'day', 'source', o ->> 'source',
                    'done', true, 'fixed', true, 'k', v_i, 'old_pos', (o ->> 'pos')::int));
        continue;
      end if;
      if v_kid and (o ->> 'kind' in ('milestone', 'turn_in') or e ->> 'kind' in ('milestone', 'turn_in'))
         and (e ->> 'kind' is distinct from o ->> 'kind' or e ->> 'title' is distinct from o ->> 'title'
              or e ->> 'done_looks_like' is distinct from o ->> 'done_looks_like'
              or (e ->> 'minutes')::int is distinct from (o ->> 'minutes')::int
              or e ->> 'day' is distinct from o ->> 'day') then
        raise exception 'That''s a checkpoint. Change it with Pat.' using errcode = '42501';
      end if;
      v_moved := e ->> 'day' is not null and e ->> 'day' is distinct from o ->> 'day';
      v_changed := e ->> 'kind' is distinct from o ->> 'kind' or e ->> 'title' is distinct from o ->> 'title'
                   or e ->> 'done_looks_like' is distinct from o ->> 'done_looks_like'
                   or (e ->> 'minutes')::int is distinct from (o ->> 'minutes')::int or v_moved;
      v_src := case when v_changed then 'typed' else o ->> 'source' end;
      v_min := (e ->> 'minutes')::int;
    else
      if v_kid and e ->> 'kind' in ('milestone', 'turn_in') then
        raise exception 'That''s a checkpoint. Change it with Pat.' using errcode = '42501';
      end if;
      v_moved := e ->> 'day' is not null;
      v_src := coalesce(e ->> 'source', 'typed');
      v_min := case when v_src = 'template' and e ->> 'kind' = 'turn_in' then 5
                    when v_src = 'template' then least((e ->> 'minutes')::int, greatest(v_k.focus_minutes, 5))
                    else (e ->> 'minutes')::int end;
    end if;
    if v_moved then
      if (e ->> 'day')::date < v_today then
        raise exception 'A step can''t go in the past.' using errcode = '22023';
      end if;
      if e ->> 'kind' <> 'turn_in' and v_a.kind = 'assignment' and v_a.due_date > v_today and (e ->> 'day')::date >= v_a.due_date then
        raise exception 'Only the turn-in goes on the due date.' using errcode = '22023';
      end if;
    end if;
    v_list := v_list || jsonb_build_array(jsonb_build_object(
                'id', v_id, 'kind', e ->> 'kind', 'title', e ->> 'title', 'done_looks_like', e ->> 'done_looks_like',
                'minutes', v_min, 'day', e ->> 'day', 'source', v_src,
                'done', false, 'fixed', e ->> 'day' is not null, 'k', v_i, 'old_pos', (o ->> 'pos')::int));
  end loop;

  -- The plan's steps missing from the list: a done one stays where it was (after the listed step
  -- that came before it); a checkpoint can't go from his side; the rest are deleted below.
  for o in select x.value from jsonb_each(v_old) x where not ((x.key)::uuid = any (v_ids)) order by (x.value ->> 'pos')::int loop
    if o ->> 'done_at' is not null then
      v_list := v_list || jsonb_build_array(jsonb_build_object(
                  'id', o ->> 'id', 'kind', o ->> 'kind', 'title', o ->> 'title', 'done_looks_like', o ->> 'done_looks_like',
                  'minutes', (o ->> 'minutes')::int, 'day', o ->> 'day', 'source', o ->> 'source', 'done', true, 'fixed', true,
                  'k', coalesce((select max((y ->> 'k')::numeric) from jsonb_array_elements(v_list) y
                                 where (y ->> 'old_pos')::int < (o ->> 'pos')::int), 0) + (o ->> 'pos')::int / 1000.0,
                  'old_pos', (o ->> 'pos')::int));
      v_ids := v_ids || (o ->> 'id')::uuid;
    elsif v_kid and o ->> 'kind' in ('milestone', 'turn_in') then
      raise exception 'That''s a checkpoint. Change it with Pat.' using errcode = '42501';
    end if;
  end loop;
  select coalesce(jsonb_agg(y order by (y ->> 'k')::numeric), '[]') into v_list from jsonb_array_elements(v_list) y;
  if jsonb_array_length(v_list) > 20 then
    raise exception 'At most 20 steps.' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(v_list) y where y ->> 'kind' = 'milestone') > 4 then
    raise exception 'At most 4 milestones.' using errcode = '22023';
  end if;

  v_place := private.place_steps(v_a.kid_id, v_a.id, v_a.due_date, v_list);
  if v_place ? 'no_time' then
    if exists (select 1 from jsonb_array_elements(v_list) y where y ->> 'day' is null) then
      raise exception 'Set a homework time first.' using errcode = '22023';
    end if;
  else
    v_list := v_place -> 'steps';
  end if;

  -- Write: the steps no longer in the plan go (never a done one); each step at its place.
  delete from public.homework_steps s where s.assignment_id = v_a.id and s.done_at is null and not (s.id = any (v_ids));
  for e in select x from jsonb_array_elements(v_list) x loop
    v_pos := v_pos + 1;
    if e ->> 'id' is null then
      insert into public.homework_steps (assignment_id, pos, kind, title, done_looks_like, minutes, day, source, updated_at, updated_by)
      values (v_a.id, v_pos, e ->> 'kind', e ->> 'title', e ->> 'done_looks_like', (e ->> 'minutes')::int, (e ->> 'day')::date,
              e ->> 'source', v_now, p_who);
    elsif (e ->> 'done')::boolean then
      update public.homework_steps s set pos = v_pos, updated_at = v_now, updated_by = p_who
      where s.id = (e ->> 'id')::uuid and s.pos <> v_pos;
    else
      update public.homework_steps s
      set pos = v_pos, kind = e ->> 'kind', title = e ->> 'title', done_looks_like = e ->> 'done_looks_like',
          minutes = (e ->> 'minutes')::int, day = (e ->> 'day')::date, source = e ->> 'source', updated_at = v_now, updated_by = p_who
      where s.id = (e ->> 'id')::uuid
        and (s.pos, s.kind, s.title, s.done_looks_like, s.minutes, s.day, s.source)
            is distinct from (v_pos, e ->> 'kind', e ->> 'title', e ->> 'done_looks_like', (e ->> 'minutes')::int, (e ->> 'day')::date, e ->> 'source');
    end if;
  end loop;
  update public.assignments a
  set plan_rev = a.plan_rev + 1,
      given_at = case when coalesce(p_give, false) and not v_kid then coalesce(a.given_at, v_now) else a.given_at end,
      given_by = case when coalesce(p_give, false) and not v_kid then coalesce(a.given_by, p_who) else a.given_by end,
      updated_by = p_who
  where a.id = v_a.id;

  v_left := coalesce((v_place ->> 'minutes_left')::int, 0);
  v_time := coalesce((v_place ->> 'time_left')::int, 0);
  v_over := greatest(coalesce((v_place ->> 'over')::int, 0), v_left - v_time, 0);
  return jsonb_build_object('plan', jsonb_build_object(
    'assignment_id', v_a.id,
    'plan_rev', v_a.plan_rev + 1,
    'steps', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'pos', s.pos, 'kind', s.kind, 'title', s.title,
                                                           'done_looks_like', s.done_looks_like, 'minutes', s.minutes, 'day', s.day,
                                                           'source', s.source, 'done', s.done_at is not null)
                                        order by s.pos, s.id), '[]')
              from public.homework_steps s where s.assignment_id = v_a.id),
    'fits', not (v_place ? 'no_time') and v_over = 0,
    'over', v_over,
    'horizon', v_place -> 'horizon',
    'minutes_left', v_left,
    'time_left', v_time,
    'no_time', v_place ? 'no_time',
    'talk', (select coalesce(jsonb_agg(jsonb_build_object('title', m.title, 'day', m.day) order by m.pos), '[]')
             from public.homework_steps m
             where m.assignment_id = v_a.id and m.kind = 'milestone' and m.done_at is null
               and (m.day < v_today
                    or exists (select 1 from public.homework_steps y
                               where y.assignment_id = m.assignment_id and y.done_at is null and y.kind <> 'milestone'
                                 and y.pos < m.pos and y.day > m.day)))),
    '_changed', true);
end;
$$;

-- The one step rule (§4.5, §8.1): what the kid, the tutor and the parents do to one step. The caller
-- has already found the step on its side (his given plan, the link's kid, any for a parent).
--   'done' (kid, family): ticked by p_who; Not yet and the coach's note cleared (the note kept in
--          qa_log). The turn-in, or the last open step, makes the assignment done. A done step stays
--          as it is (a resend).
--   'undo' (kid: only his own tick of the last 15 minutes; family: any tick), never a checked one;
--          a done assignment opens again.
--   'not_today' (kid, plain steps): to the next day after today with homework time and room for it,
--          up to the last work day (moved_from keeps the old day). p_day is the day his screen
--          showed: a step no longer on it was moved already (a resend) and stays.
--   'ask' (kid): his question (at most 200); an earlier question and its answer go to qa_log.
--   'smaller' (kid): a new plain step titled p_text (3 to 80), 10 minutes, just before this one, on
--          its day (today if that has passed), with p_key as its id (a resend finds it); a block
--          running on the old step moves to it.
--   'check' (tutor, family): a milestone, ticked too if it wasn't (the work was seen), with an
--          optional note; its points (private.award, so the weekly cap applies: past it the check is
--          recorded and pays nothing: the answer has paid and used_up).
--   'not_yet' (tutor, family): a ticked milestone not checked, with a note saying what's missing:
--          unticked, nothing taken.
--   'uncheck' (tutor, family): the one who checked it, within 15 minutes: the check and its points go.
--   'answer' (tutor, family): an answer to his question (at most 200); its writer can change it for 15
--          minutes from the first answer (the old one kept in qa_log).
--   'clear' (family): an answer (p_text 'answer') or a coach's note ('note'); null: the answer if there
--          is one, else the note. Kept in qa_log.
-- qa_log keeps the last 10 entries. Every change bumps the assignment's plan_rev and sets the step's
-- updated_at and updated_by. Answers {step_id, …} and _changed (false for a resend).
create function private.step_act(p_step uuid, p_action text, p_text text, p_day date, p_key uuid, p_role text, p_who text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_s     public.homework_steps;
  v_a     public.assignments;
  v_k     public.homework_kids;
  v_today date := public.today_local();
  v_now   timestamptz := private.now();
  v_coach text := case when p_role = 'tutor' then 'tutor' else 'family' end;
  v_aid   uuid;
  v_text  text;
  v_day   date;
  v_last  date;
  v_pts   int;
  v_log   jsonb;
  v_add   jsonb := '[]';   -- entries for qa_log
  v_ch    boolean := false;
  v_out   jsonb := '{}';
  v_which text;
begin
  if p_role is null or p_role not in ('kid', 'tutor', 'family')
     or p_action is null
     or not (p_action = any (case p_role when 'kid' then array['done', 'undo', 'not_today', 'ask', 'smaller']
                                         when 'tutor' then array['check', 'not_yet', 'uncheck', 'answer']
                                         else array['check', 'not_yet', 'uncheck', 'answer', 'clear', 'done', 'undo'] end)) then
    raise exception 'That isn''t something you can do to a step.' using errcode = '22023';
  end if;
  -- The assignment first, then the step: plan_save locks them in the same order.
  select s.assignment_id into v_aid from public.homework_steps s where s.id = p_step;
  select * into v_a from public.assignments a where a.id = v_aid for update;
  select * into v_s from public.homework_steps s where s.id = p_step for update;
  if v_a.id is null or v_s.id is null then
    raise exception 'That step isn''t on your plan.' using errcode = '42501';
  end if;
  select * into v_k from public.homework_kids k where k.kid_id = v_a.kid_id;

  if p_action = 'done' then
    if v_s.done_at is null then
      if v_s.coach_note is not null then
        v_add := jsonb_build_array(jsonb_build_object('note', v_s.coach_note, 'at', v_s.coach_note_at, 'by', v_s.coach_note_by));
      end if;
      update public.homework_steps
      set done_at = v_now, done_by = p_who, not_yet_at = null, coach_note = null, coach_note_by = null, coach_note_at = null
      where id = v_s.id;
      v_ch := true;
    end if;

  elsif p_action = 'undo' then
    if v_s.done_at is not null then
      if v_s.checked_at is not null or (p_role = 'kid' and (v_s.done_by is distinct from p_who or v_s.done_at < v_now - interval '15 minutes')) then
        raise exception '%', case when p_role = 'kid' then 'Only your own tick can be undone, for 15 minutes.'
                                  else 'That milestone is checked: take the check back first.' end
          using errcode = '42501';
      end if;
      update public.homework_steps set done_at = null, done_by = null where id = v_s.id;
      v_ch := true;
    end if;

  elsif p_action = 'not_today' then
    if v_s.kind not in ('start', 'step', 'check') then
      raise exception 'That''s a checkpoint. Change it with Pat.' using errcode = '42501';
    end if;
    if p_day is null then
      raise exception 'Say which day the step was on.' using errcode = '22023';
    end if;
    if v_s.done_at is null and v_s.day = p_day then
      v_last := case when v_a.kind = 'lesson' then greatest(v_a.due_date, v_today)
                     when v_a.due_date - v_today >= 7 then v_a.due_date - 2
                     when v_a.due_date > v_today then v_a.due_date - 1
                     else v_today end;
      select f.day into v_day
      from private.free_minutes(v_a.kid_id, v_today + 1, v_last, v_a.id) f
      where f.free - f.planned
            - coalesce((select sum(x.minutes) from public.homework_steps x
                        where x.assignment_id = v_a.id and x.done_at is null and x.day = f.day and x.id <> v_s.id), 0) >= v_s.minutes
      order by f.day
      limit 1;
      if v_day is null then
        if not exists (select 1 from private.free_minutes(v_a.kid_id, v_today, v_today + 55, null)) then
          raise exception 'Set a homework time first.' using errcode = '22023';
        end if;
        raise exception 'No homework day before it''s due has room. Re-plan, make it smaller, or ask Pat.' using errcode = 'P0001';
      end if;
      update public.homework_steps set moved_from = v_s.day, day = v_day where id = v_s.id;
      v_ch := true;
    end if;

  elsif p_action = 'ask' then
    v_text := nullif(private.clean_text(p_text, 200), '');
    if v_text is null then
      raise exception 'Type your question.' using errcode = '22023';
    end if;
    if v_s.question is distinct from v_text or v_s.answer is not null then
      if v_s.question is not null then
        v_add := jsonb_build_array(jsonb_build_object(
                   'question', v_s.question, 'asked_at', v_s.question_at, 'answer', v_s.answer, 'answered_at', v_s.answer_at,
                   'answered_by', v_s.answer_by,
                   'by', case when v_s.answer_by is null then null when v_s.answer_by like '% (tutor link)' then 'tutor' else 'family' end));
      end if;
      update public.homework_steps
      set question = v_text, question_at = v_now, answer = null, answer_by = null, answer_at = null
      where id = v_s.id;
      v_ch := true;
    end if;

  elsif p_action = 'smaller' then
    v_text := private.clean_text(p_text, 200);
    if v_text is null or char_length(v_text) not between 3 and 80 then
      raise exception 'A step''s title is 3 to 80 characters.' using errcode = '22023';
    end if;
    if p_key is null then
      raise exception 'A new step needs its id.' using errcode = '22023';
    end if;
    select s.assignment_id into v_aid from public.homework_steps s where s.id = p_key;
    if v_aid is not null and v_aid <> v_a.id then
      raise exception 'That step isn''t on your plan.' using errcode = '42501';
    end if;
    if v_aid is null then
      if (select count(*) from public.homework_steps s where s.assignment_id = v_a.id) >= 20 then
        raise exception 'At most 20 steps.' using errcode = '22023';
      end if;
      update public.homework_steps s set pos = s.pos + 1 where s.assignment_id = v_a.id and s.pos >= v_s.pos;
      v_day := greatest(v_s.day, v_today);
      if v_a.kind = 'assignment' and v_a.due_date > v_today then
        v_day := least(v_day, v_a.due_date - 1);
      end if;
      insert into public.homework_steps (id, assignment_id, pos, kind, title, minutes, day, source, updated_at, updated_by)
      values (p_key, v_a.id, v_s.pos, 'step', v_text, 10, v_day, 'typed', v_now, p_who);
      -- A block running on the old step goes on with the new one, so Step done ticks what he did.
      update public.focus_sessions f set step_id = p_key, assignment_id = v_a.id
      where f.kid_id = v_a.kid_id and f.step_id = v_s.id and f.ended_at is null;
      v_ch := true;
    end if;
    v_out := jsonb_build_object('new_step_id', p_key);

  elsif p_action = 'check' then
    if v_s.kind <> 'milestone' then
      raise exception 'Only a milestone is checked.' using errcode = '22023';
    end if;
    v_out := jsonb_build_object('paid', 0, 'used_up', false);
    if v_s.checked_at is null then
      v_text := nullif(private.clean_text(p_text, 160), '');
      if v_s.coach_note is not null then
        v_add := jsonb_build_array(jsonb_build_object('note', v_s.coach_note, 'at', v_s.coach_note_at, 'by', v_s.coach_note_by));
      end if;
      update public.homework_steps
      set done_at = coalesce(done_at, v_now), done_by = coalesce(done_by, p_who), checked_at = v_now, checked_by = p_who,
          not_yet_at = null, coach_note = v_text, coach_note_by = case when v_text is not null then v_coach end,
          coach_note_at = case when v_text is not null then v_now end
      where id = v_s.id;
      v_pts := private.award(v_a.kid_id, 'milestone', v_k.pts_milestone, v_today, null, v_s.id, null, null, v_s.title, p_who);
      v_out := jsonb_build_object('paid', v_pts,
                                  'used_up', v_k.points_on and v_k.pts_milestone > 0 and v_pts < v_k.pts_milestone);
      v_ch := true;
    end if;

  elsif p_action = 'not_yet' then
    if v_s.kind <> 'milestone' then
      raise exception 'Only a milestone is checked.' using errcode = '22023';
    end if;
    v_text := nullif(private.clean_text(p_text, 160), '');
    if v_text is null then
      raise exception 'Say what''s missing.' using errcode = '22023';
    end if;
    if v_s.checked_at is not null then
      raise exception 'That milestone is checked: take the check back first.' using errcode = '42501';
    end if;
    if v_s.done_at is not null then
      if v_s.coach_note is not null then
        v_add := jsonb_build_array(jsonb_build_object('note', v_s.coach_note, 'at', v_s.coach_note_at, 'by', v_s.coach_note_by));
      end if;
      update public.homework_steps
      set done_at = null, done_by = null, not_yet_at = v_now, coach_note = v_text, coach_note_by = v_coach, coach_note_at = v_now
      where id = v_s.id;
      v_ch := true;
    elsif not (v_s.not_yet_at is not null and v_s.coach_note = v_text) then
      raise exception 'Not yet is for a ticked milestone.' using errcode = '22023';
    end if;

  elsif p_action = 'uncheck' then
    if v_s.checked_at is not null then
      if v_s.checked_by is distinct from p_who or v_s.checked_at < v_now - interval '15 minutes' then
        raise exception 'Only the one who checked it can take it back, for 15 minutes.' using errcode = '42501';
      end if;
      delete from public.points_ledger l
      where l.kind = 'void' and l.void_of in (select m.id from public.points_ledger m where m.step_id = v_s.id and m.kind = 'milestone');
      delete from public.points_ledger l where l.step_id = v_s.id and l.kind = 'milestone';
      update public.homework_steps set checked_at = null, checked_by = null where id = v_s.id;
      v_ch := true;
    end if;

  elsif p_action = 'answer' then
    v_text := nullif(private.clean_text(p_text, 200), '');
    if v_text is null then
      raise exception 'Type the answer.' using errcode = '22023';
    end if;
    if v_s.question is null then
      raise exception 'There''s no question to answer.' using errcode = '22023';
    end if;
    if v_s.answer is distinct from v_text then
      if v_s.answer is not null then
        if v_s.answer_by is distinct from p_who or v_s.answer_at < v_now - interval '15 minutes' then
          raise exception 'Only your own answer can be changed, for 15 minutes.' using errcode = '42501';
        end if;
        v_add := jsonb_build_array(jsonb_build_object(
                   'question', v_s.question, 'asked_at', v_s.question_at, 'answer', v_s.answer, 'answered_at', v_s.answer_at,
                   'answered_by', v_s.answer_by, 'by', v_coach, 'replaced_at', v_now));
      end if;
      -- A change (a typo) keeps the answer's time: the 15 minutes count from the first answer.
      update public.homework_steps set answer = v_text, answer_by = p_who, answer_at = coalesce(v_s.answer_at, v_now) where id = v_s.id;
      v_ch := true;
    end if;

  elsif p_action = 'clear' then
    v_which := coalesce(p_text, case when v_s.answer is not null then 'answer' else 'note' end);
    if v_which not in ('answer', 'note') then
      raise exception 'Clear an answer or a note.' using errcode = '22023';
    end if;
    if v_which = 'answer' and v_s.answer is not null then
      v_add := jsonb_build_array(jsonb_build_object(
                 'question', v_s.question, 'asked_at', v_s.question_at, 'answer', v_s.answer, 'answered_at', v_s.answer_at,
                 'answered_by', v_s.answer_by,
                 'by', case when v_s.answer_by like '% (tutor link)' then 'tutor' else 'family' end,
                 'cleared_at', v_now, 'cleared_by', p_who));
      update public.homework_steps set answer = null, answer_by = null, answer_at = null where id = v_s.id;
      v_ch := true;
    elsif v_which = 'note' and v_s.coach_note is not null then
      v_add := jsonb_build_array(jsonb_build_object('note', v_s.coach_note, 'at', v_s.coach_note_at, 'by', v_s.coach_note_by,
                                                    'cleared_at', v_now, 'cleared_by', p_who));
      update public.homework_steps set coach_note = null, coach_note_by = null, coach_note_at = null where id = v_s.id;
      v_ch := true;
    end if;
  end if;

  if v_ch then
    -- qa_log keeps the last 10 entries.
    v_log := v_s.qa_log || v_add;
    if jsonb_array_length(v_log) > 10 then
      select jsonb_agg(x order by n) into v_log
      from jsonb_array_elements(v_log) with ordinality t (x, n)
      where n > jsonb_array_length(v_log) - 10;
    end if;
    update public.homework_steps set qa_log = v_log, updated_at = v_now, updated_by = p_who where id = v_s.id;
    update public.assignments a
    set plan_rev = a.plan_rev + 1,
        -- the turn-in, or the last open step, ticked: the assignment is done; a step unticked: open again
        status = case when p_action in ('done', 'check') and a.status = 'open'
                           and (v_s.kind = 'turn_in'
                                or not exists (select 1 from public.homework_steps x where x.assignment_id = a.id and x.done_at is null))
                      then 'done'
                      when p_action in ('undo', 'not_yet') and a.status = 'done' then 'open'
                      else a.status end,
        updated_by = p_who
    where a.id = v_a.id;
  end if;
  return v_out || jsonb_build_object('step_id', v_s.id, '_changed', v_ch);
end;
$$;

-- ---------------------------------------------------------------------
-- Points (§8)
-- ---------------------------------------------------------------------

-- One ledger row at private.now(), for the household's day p_day (a block's start day for 'focus'
-- and 'on_time', today otherwise), on conflict do nothing (each block, each day's on-time start,
-- each milestone and each void is paid once). Caps: 'focus' and 'on_time' together at most
-- pts_day_cap on p_day (a block crossing it gets the rest); 'milestone' at most pts_milestone_week
-- in p_day's household week (Mon–Sun). Nothing earned or given while points are off; a trade and a
-- void are written whatever the switch says. The kid's homework_kids row is locked first, so two
-- calls can't both take the last of a cap. Answers the points written (0 when capped or already there).
create function private.award(p_kid uuid, p_kind text, p_delta int, p_day date, p_session uuid, p_step uuid, p_ask uuid,
                              p_void_of uuid, p_note text, p_who text)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_k    public.homework_kids;
  v_d    int := coalesce(p_delta, 0);
  v_used int;
  v_n    int;
begin
  select * into v_k from public.homework_kids k where k.kid_id = p_kid for update;
  if v_k.kid_id is null or p_kind is null then
    return 0;
  end if;
  if p_kind in ('focus', 'on_time', 'milestone', 'given') and (not v_k.points_on or v_d <= 0) then
    return 0;
  end if;
  if p_kind in ('focus', 'on_time') then
    select coalesce(sum(l.delta), 0) into v_used
    from public.points_ledger l
    where l.kid_id = p_kid and l.day = p_day and l.kind in ('focus', 'on_time');
    v_d := least(v_d, v_k.pts_day_cap - v_used);
  elsif p_kind = 'milestone' then
    select coalesce(sum(l.delta), 0) into v_used
    from public.points_ledger l
    where l.kid_id = p_kid and l.kind = 'milestone' and l.day between private.monday(p_day) and private.monday(p_day) + 6;
    v_d := least(v_d, v_k.pts_milestone_week - v_used);
  end if;
  if v_d = 0 or ((p_kind in ('void', 'trade')) <> (v_d < 0)) then
    return 0;
  end if;
  insert into public.points_ledger (kid_id, at, day, kind, delta, session_id, step_id, ask_id, void_of, note, who)
  values (p_kid, private.now(), p_day, p_kind, v_d, p_session, p_step, p_ask, p_void_of,
          nullif(private.clean_text(p_note, 120), ''), p_who)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return case when v_n = 1 then v_d else 0 end;
end;
$$;

-- His balance (the ledger's sum) and the points held by his waiting asks.
create function private.points_balance(p_kid uuid, out balance int, out held int)
language sql
stable
set search_path = ''
as $$
  select coalesce((select sum(l.delta) from public.points_ledger l where l.kid_id = p_kid), 0)::int,
         coalesce((select sum(r.cost) from public.reward_asks r where r.kid_id = p_kid and r.status = 'waiting'), 0)::int;
$$;

-- How long his steps take against the plan: the median of worked ÷ planned minutes over his last 10
-- done steps that had blocks (worked: the blocks' seen_minutes on the step), rounded to 0.1 and kept
-- between 0.5 and 3; null with fewer than 5. A fact about the plans, never a verdict on him.
create function private.homework_pace(p_kid uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  with w as (
    select st.id, st.minutes, st.done_at, sum(f.seen_minutes) as worked
    from public.homework_steps st
    join public.assignments a on a.id = st.assignment_id and a.kid_id = p_kid
    join public.focus_sessions f on f.step_id = st.id and f.ended_at is not null
    where st.done_at is not null
    group by st.id, st.minutes, st.done_at
    having sum(f.seen_minutes) > 0
    order by st.done_at desc, st.id
    limit 10
  )
  select case when count(*) >= 5
              then least(greatest(round((percentile_cont(0.5) within group (order by w.worked::numeric / w.minutes))::numeric, 1), 0.5), 3.0) end
  from w;
$$;

-- ---------------------------------------------------------------------
-- Focus blocks (§7.1)
-- ---------------------------------------------------------------------

-- The focus rules and their points. p_session is the block's id, made by the phone.
--   'start': p_minutes 10, 15, 20 or 25; p_with 'alone', 'tutor' or 'parent' (recorded, not
--            rewarded); a step of a plan given to him and not done, or one of his open assignments,
--            or neither (his own block: the timer works and earns nothing). A resend with the same id
--            answers that block. Another block still open: closed as 'expired' when it started more
--            than 24 hours ago, else P0001 "Finish the block you started first.". On time: the day's
--            first block with a step or an assignment, no on-time entry today yet, and now from 30
--            minutes before to 10 minutes after the first free minute of today's homework time.
--   'switch': the open block moves to another of his open steps (Keep going, Next step).
--   'end':    p_result 'done' (the step is ticked; on an assignment with no plan, the assignment is
--            done), 'more' or 'stopped', with an optional note; seen_minutes are the whole minutes from
--            its start to now, at most its length. Answered within 24 hours of its start, a block with
--            a step or an assignment earns pts_focus per 5 whole minutes seen, and an on-time block
--            seen for 8 minutes or more pts_on_time, both on its start day (private.award, so the
--            daily cap applies). Every answer earns the same for the same minutes. A block already
--            ended answers as it is.
-- A block id of another kid: 42501 "That block isn't yours.", as for an unknown one ('switch', 'end').
-- Answers {block, earned: {focus, on_time, capped}} and _changed (block, not session: his view's session
-- is the block still open).
create function private.focus_act(p_kid uuid, p_action text, p_session uuid, p_minutes int, p_step uuid, p_assignment uuid,
                                  p_with text, p_result text, p_note text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_k     public.homework_kids;
  v_me    public.people;
  v_f     public.focus_sessions;
  v_o     public.focus_sessions;
  v_st    public.homework_steps;
  v_now   timestamptz := private.now();
  v_tz    text := private.tz();
  v_today date := public.today_local();
  v_who   text;
  v_with  text := coalesce(p_with, 'alone');
  v_asg   uuid;
  v_first time;
  v_on    boolean := false;
  v_seen  int;
  v_day   date;
  v_title text;
  v_ch    boolean := false;
begin
  select * into v_k from public.homework_kids k where k.kid_id = p_kid;
  select * into v_me from public.people p where p.id = p_kid;
  v_who := private.short_name(v_me) || ' (My day)';
  if p_action is null or p_action not in ('start', 'switch', 'end') then
    raise exception 'Choose start, switch or end.' using errcode = '22023';
  end if;
  if p_session is null then
    raise exception 'A block needs its id.' using errcode = '22023';
  end if;
  select * into v_f from public.focus_sessions f where f.id = p_session for update;
  if v_f.id is not null and v_f.kid_id <> p_kid then
    raise exception 'That block isn''t yours.' using errcode = '42501';
  end if;

  if p_action = 'start' then
    if v_f.id is null then
      if p_minutes is null or p_minutes not in (10, 15, 20, 25) then
        raise exception 'Choose 10, 15, 20 or 25 minutes.' using errcode = '22023';
      end if;
      if v_with not in ('alone', 'tutor', 'parent') then
        raise exception 'Choose alone, with your tutor or with a parent.' using errcode = '22023';
      end if;
      if p_step is not null then
        select s.* into v_st
        from public.homework_steps s
        join public.assignments a on a.id = s.assignment_id
        where s.id = p_step and a.kid_id = p_kid and a.given_at is not null and a.status = 'open' and s.done_at is null;
        if v_st.id is null then
          raise exception 'That step isn''t on your plan.' using errcode = '42501';
        end if;
        v_asg := v_st.assignment_id;
      elsif p_assignment is not null then
        select a.id into v_asg from public.assignments a where a.id = p_assignment and a.kid_id = p_kid and a.status = 'open';
        if v_asg is null then
          raise exception 'That assignment isn''t on your list.' using errcode = '42501';
        end if;
      end if;
      select * into v_o from public.focus_sessions f where f.kid_id = p_kid and f.ended_at is null for update;
      if v_o.id is not null then
        if v_o.started_at >= v_now - interval '24 hours' then
          raise exception 'Finish the block you started first.' using errcode = 'P0001';
        end if;
        update public.focus_sessions set ended_at = v_now, result = 'expired', seen_minutes = 0 where id = v_o.id;
      end if;
      if v_asg is not null then
        select f.first_free into v_first from private.free_minutes(p_kid, v_today, v_today, null) f where f.day = v_today;
        v_on := v_first is not null
                and not exists (select 1 from public.focus_sessions f
                                where f.kid_id = p_kid and (f.step_id is not null or f.assignment_id is not null)
                                  and (f.started_at at time zone v_tz)::date = v_today)
                and not exists (select 1 from public.points_ledger l where l.kid_id = p_kid and l.kind = 'on_time' and l.day = v_today)
                and (v_now at time zone v_tz) between (v_today + v_first) - interval '30 minutes' and (v_today + v_first) + interval '10 minutes';
      end if;
      begin
        insert into public.focus_sessions (id, kid_id, assignment_id, step_id, minutes, with_whom, started_at, ends_at, on_time)
        values (p_session, p_kid, v_asg, p_step, p_minutes, v_with, v_now, v_now + make_interval(mins => p_minutes), v_on);
      exception when unique_violation then
        raise exception 'Finish the block you started first.' using errcode = 'P0001';
      end;
      v_ch := true;
    end if;

  elsif p_action = 'switch' then
    if v_f.id is null then
      raise exception 'That block isn''t yours.' using errcode = '42501';
    end if;
    if v_f.ended_at is null and v_f.step_id is distinct from p_step then
      select s.* into v_st
      from public.homework_steps s
      join public.assignments a on a.id = s.assignment_id
      where s.id = p_step and a.kid_id = p_kid and a.given_at is not null and a.status = 'open' and s.done_at is null;
      if v_st.id is null then
        raise exception 'That step isn''t on your plan.' using errcode = '42501';
      end if;
      update public.focus_sessions set step_id = v_st.id, assignment_id = v_st.assignment_id where id = v_f.id;
      v_ch := true;
    end if;

  else
    if v_f.id is null then
      raise exception 'That block isn''t yours.' using errcode = '42501';
    end if;
    if v_f.ended_at is null then
      if p_result is null or p_result not in ('done', 'more', 'stopped') then
        raise exception 'Choose step done, more to do or stop.' using errcode = '22023';
      end if;
      v_seen := least(floor(extract(epoch from v_now - v_f.started_at) / 60)::int, v_f.minutes);
      v_day := (v_f.started_at at time zone v_tz)::date;
      update public.focus_sessions
      set ended_at = v_now, result = p_result, seen_minutes = greatest(v_seen, 0), note = nullif(private.clean_text(p_note, 120), '')
      where id = v_f.id;
      if p_result = 'done' then
        if v_f.step_id is not null then
          perform private.step_act(v_f.step_id, 'done', null, null, null, 'kid', v_who);
        elsif v_f.assignment_id is not null then
          update public.assignments a set status = 'done', updated_by = v_who
          where a.id = v_f.assignment_id and a.status = 'open'
            and not exists (select 1 from public.homework_steps s where s.assignment_id = a.id);
        end if;
      end if;
      if (v_f.step_id is not null or v_f.assignment_id is not null) and v_now - v_f.started_at <= interval '24 hours' then
        v_title := coalesce((select s.title from public.homework_steps s where s.id = v_f.step_id),
                            (select a.title from public.assignments a where a.id = v_f.assignment_id));
        perform private.award(p_kid, 'focus', v_k.pts_focus * (greatest(v_seen, 0) / 5), v_day, v_f.id, v_f.step_id, null, null, v_title, v_who);
        if v_f.on_time and v_seen >= 8 then
          perform private.award(p_kid, 'on_time', v_k.pts_on_time, v_day, v_f.id, v_f.step_id, null, null, v_title, v_who);
        end if;
        update public.focus_sessions f
        set points = coalesce((select sum(l.delta) from public.points_ledger l
                               where l.session_id = f.id and l.kind in ('focus', 'on_time')), 0)
        where f.id = v_f.id;
      end if;
      v_ch := true;
    end if;
  end if;

  select * into v_f from public.focus_sessions f where f.id = p_session;
  return jsonb_build_object(
    'block', jsonb_build_object('id', v_f.id, 'step_id', v_f.step_id, 'assignment_id', v_f.assignment_id, 'minutes', v_f.minutes,
                                  'with', v_f.with_whom, 'started_at', v_f.started_at, 'ends_at', v_f.ends_at, 'ended_at', v_f.ended_at,
                                  'result', v_f.result, 'seen_minutes', v_f.seen_minutes, 'on_time', v_f.on_time, 'points', v_f.points),
    'earned', jsonb_build_object(
      'focus', coalesce((select sum(l.delta) from public.points_ledger l where l.session_id = v_f.id and l.kind = 'focus'), 0),
      'on_time', coalesce((select sum(l.delta) from public.points_ledger l where l.session_id = v_f.id and l.kind = 'on_time'), 0),
      'capped', v_k.points_on and v_f.ended_at is not null
                and coalesce((select sum(l.delta) from public.points_ledger l
                              where l.kid_id = p_kid and l.kind in ('focus', 'on_time')
                                and l.day = (v_f.started_at at time zone v_tz)::date), 0) >= v_k.pts_day_cap),
    '_changed', v_ch);
end;
$$;

-- ---------------------------------------------------------------------
-- Retention (§13.3) and the AI's lease (§6.3)
-- ---------------------------------------------------------------------

-- Every AI run still running past its lease becomes failed with stop 'timeout', and its
-- assignment's ai_state 'failed' (ai_stop 'timeout') when no other run is open on it.
create function private.ai_sweep()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := private.now();
  v_ids uuid[];
begin
  with gone as (
    update public.ai_runs r set status = 'failed', stop = 'timeout', finished_at = v_now
    where r.status = 'running' and r.lease_until < v_now
    returning r.assignment_id
  )
  select array_agg(distinct g.assignment_id) into v_ids from gone g where g.assignment_id is not null;
  if v_ids is not null then
    update public.assignments a set ai_state = 'failed', ai_stop = 'timeout'
    where a.id = any (v_ids) and a.ai_state = 'running'
      and not exists (select 1 from public.ai_runs r where r.assignment_id = a.id and r.status = 'running' and r.lease_until >= v_now);
  end if;
end;
$$;

-- The retention rules, done at writes (as list_done trims itself), for one kid:
--   the teacher's text emptied 30 days after the due date; AI drafts nobody used cleared 30 days
--   after they were written; AI runs deleted after 90 days (the household's, test runs too); done
--   assignments deleted 180 days after they were done, and dropped ones 180 days after their due
--   date (the table keeps no drop time), with their steps; focus blocks that started more than 180
--   days ago deleted; reward asks decided more than 180 days ago deleted. Ledger rows stay, their
--   links set null, so the balance never changes. Then private.ai_sweep().
create function private.homework_trim(p_kid uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now   timestamptz := private.now();
  v_today date := public.today_local();
begin
  update public.assignments a set details = null
  where a.kid_id = p_kid and a.details is not null and a.due_date < v_today - 30;
  update public.assignments a
  set ai_draft = null, ai_prev = null, ai_at = null,
      ai_state = case when a.ai_state = 'running' then a.ai_state end,
      ai_stop = case when a.ai_state = 'running' then a.ai_stop end
  where a.kid_id = p_kid and a.ai_at < v_now - interval '30 days';
  delete from public.ai_runs r where r.started_at < v_now - interval '90 days';
  delete from public.assignments a
  where a.kid_id = p_kid
    and ((a.status = 'done' and a.done_at < v_now - interval '180 days')
         or (a.status = 'dropped' and a.due_date < v_today - 180));
  delete from public.focus_sessions f where f.kid_id = p_kid and f.started_at < v_now - interval '180 days';
  delete from public.reward_asks r where r.kid_id = p_kid and r.status <> 'waiting' and r.decided_at < v_now - interval '180 days';
  perform private.ai_sweep();
end;
$$;

-- ---------------------------------------------------------------------
-- What his screen and the tutor's link show (§3.4). Neither ever raises.
-- ---------------------------------------------------------------------

-- Jordan's view (homework_by_token, and every answer of his writers):
--   {language, as_of, today, server_now,
--    me: {first_name, tutor, cue, if_stuck, length, lengths, points_on},
--    window: {starts, ends} | null, on_time: {from, until, done, points} | null, session: {…} | null,
--    now: step | null, tonight: [step], load: {planned, free}, earlier: [step],
--    assignments: [{id, kind, title, subject, due_date, status, state, plan_rev, added_by, given_by, ai_help,
--                   stretch, behind, minutes_left, time_left, horizon, no_time, next_milestone, steps}],
--    points: {balance, held, today, capped} | null, rewards | null, asks | null, recent | null,
--    pace: {ratio, steps} | null, week: {focused, last_week}}
--   step = {id, assignment_id, assignment, kind, title, done_looks_like, minutes, day, from_day, moved, done,
--           undo, checked, waiting, not_yet, coach: {by, text} | null, question, answer}
-- No names but his own first name and the tutor's first word, no emails, no ids of people, no
-- teacher's text, no AI draft, no tokens; coach.by and given_by are roles. Steps only of plans
-- given to him. Now (and the card's Next) is today's first open step, or, on a day with homework
-- time, the first earlier one; earlier steps are listed only on a day with homework time. plan_rev
-- is what his own plan save (plan_by_token's p_rev) needs; on_time.points is the on-time value his
-- words name ("+5").
create function private.homework_view_kid(p_kid uuid, p_lang text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_k      public.homework_kids;
  v_me     public.people;
  v_now    timestamptz := private.now();
  v_tz     text := private.tz();
  v_today  date := public.today_local();
  v_who    text;
  v_fm     jsonb;
  v_win    jsonb;
  v_first  date;
  v_steps  jsonb;
  v_tonight jsonb;
  v_earlier jsonb;
  v_nowst  jsonb;
  v_bal    int;
  v_held   int;
  v_pace   numeric;
  v_mon    date;
  v_out    jsonb;
begin
  select * into v_k from public.homework_kids k where k.kid_id = p_kid;
  select * into v_me from public.people p where p.id = p_kid;
  if v_k.kid_id is null or v_me.id is null then
    return null;
  end if;
  v_who := private.short_name(v_me) || ' (My day)';
  v_mon := private.monday(v_today);
  select coalesce(jsonb_agg(to_jsonb(f) order by f.day), '[]') into v_fm
  from private.free_minutes(p_kid, v_today, v_today + 55, null) f;
  select x into v_win from jsonb_array_elements(v_fm) x where (x ->> 'day')::date = v_today;
  v_first := case when (v_win ->> 'ends')::time > (v_now at time zone v_tz)::time then v_today else v_today + 1 end;

  -- Every step of the plans given to him on his screen, as it shows them, in order: by the
  -- assignment's due date, then the plan's order.
  select coalesce(jsonb_agg(x.j order by x.due_date, x.created_at, x.assignment_id, x.pos, x.id), '[]') into v_steps
  from (
    select a.due_date, a.created_at, st.assignment_id, st.pos, st.id,
           jsonb_build_object(
             'id', st.id, 'assignment_id', st.assignment_id, 'assignment', a.title, 'kind', st.kind, 'title', st.title,
             'done_looks_like', st.done_looks_like, 'minutes', st.minutes, 'day', st.day,
             'from_day', case when st.day < v_today then st.day end,
             'moved', st.moved_from is not null,
             'done', st.done_at is not null,
             'undo', st.done_at is not null and st.checked_at is null and st.done_by = v_who
                     and st.done_at >= v_now - interval '15 minutes',
             'checked', st.checked_at is not null,
             'waiting', case when st.kind = 'milestone' and st.done_at is not null and st.checked_at is null and v_k.points_on
                             then v_k.pts_milestone end,
             'not_yet', st.not_yet_at is not null,
             'coach', case when st.coach_note is not null then jsonb_build_object('by', st.coach_note_by, 'text', st.coach_note) end,
             'question', st.question,
             'answer', st.answer)
           || jsonb_build_object('_open', st.done_at is null and a.status = 'open') as j
    from public.homework_steps st
    join public.assignments a on a.id = st.assignment_id
    where a.kid_id = p_kid and a.given_at is not null
      and (a.status = 'open' or (a.status = 'done' and a.done_at >= v_now - interval '3 days'))
  ) x;
  -- Tonight: today's steps, open or ticked (not the open ones of an assignment marked done).
  select coalesce(jsonb_agg(x order by n), '[]') into v_tonight
  from jsonb_array_elements(v_steps) with ordinality t (x, n)
  where (x ->> 'day')::date = v_today and ((x ->> 'done')::boolean or (x ->> '_open')::boolean);
  select coalesce(jsonb_agg(x order by (x ->> 'day')::date, n), '[]') into v_earlier
  from jsonb_array_elements(v_steps) with ordinality t (x, n)
  where v_win is not null and (x ->> 'day')::date < v_today and (x ->> '_open')::boolean;
  select x into v_nowst from jsonb_array_elements(v_tonight) with ordinality t (x, n) where (x ->> '_open')::boolean order by n limit 1;
  if v_nowst is null then
    v_nowst := v_earlier -> 0;
  end if;
  select p.balance, p.held into v_bal, v_held from private.points_balance(p_kid) p;
  v_pace := private.homework_pace(p_kid);

  with fm as (
    select * from jsonb_to_recordset(v_fm)
      as f (day date, starts time, ends time, window_minutes int, free int, planned int, busy jsonb, first_free time)
  ),
  asg as (
    select a.*,
           case when a.kind = 'lesson' then greatest(a.due_date, v_today)
                when a.due_date - v_today >= 7 then a.due_date - 2
                when a.due_date > v_today then a.due_date - 1
                else v_today end as last_day
    from public.assignments a
    where a.kid_id = p_kid
      and (a.status = 'open'
           or (a.status = 'done' and a.done_at >= v_now - interval '3 days')
           or (a.status = 'dropped' and a.updated_at >= v_now - interval '3 days'))
  ),
  mine as (   -- each open assignment's not-done steps per day (fm.planned counts them all)
    select s.assignment_id, s.day, sum(s.minutes)::int as m
    from public.homework_steps s join asg a on a.id = s.assignment_id and a.status = 'open'
    where s.done_at is null
    group by s.assignment_id, s.day
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'kind', a.kind, 'title', a.title, 'subject', a.subject, 'due_date', a.due_date, 'status', a.status,
           'state', case when a.given_at is not null then 'given'
                         when a.ai_state = 'running' or a.ai_draft is not null
                              or exists (select 1 from public.homework_steps s where s.assignment_id = a.id) then 'planning'
                         else 'none' end,
           'plan_rev', a.plan_rev,
           'added_by', a.added_by,
           'given_by', case when a.given_by is null then null
                            when a.given_by like '% (tutor link)' then 'tutor'
                            when a.given_by like '% (My day)' then 'kid'
                            else 'family' end,
           'ai_help', exists (select 1 from public.homework_steps s where s.assignment_id = a.id and s.source = 'ai'),
           'stretch', a.stretch,
           'behind', case when a.given_at is not null and a.status = 'open' then
                       (select case when b.n > 0 or b.m is not null then jsonb_build_object('steps', b.n, 'milestone', b.m) end
                        from (select (select count(*) from public.homework_steps s
                                      where s.assignment_id = a.id and s.done_at is null and s.day < v_today)::int as n,
                                     (select jsonb_build_object('title', m.title, 'day', m.day)
                                      from public.homework_steps m
                                      where m.assignment_id = a.id and m.kind = 'milestone' and m.done_at is null
                                        and (m.day < v_today
                                             or exists (select 1 from public.homework_steps y
                                                        where y.assignment_id = a.id and y.done_at is null and y.kind <> 'milestone'
                                                          and y.pos < m.pos and y.day > m.day))
                                      order by m.pos, m.id limit 1) as m) b) end,
           'minutes_left', coalesce((select sum(s.minutes) from public.homework_steps s where s.assignment_id = a.id and s.done_at is null), 0),
           'time_left', coalesce((select sum(greatest(f.free - (f.planned - coalesce(mi.m, 0)), 0))
                                  from fm f
                                  left join mine mi on mi.assignment_id = a.id and mi.day = f.day
                                  where f.day between v_first and least(a.last_day, v_today + 55)), 0),
           'horizon', case when a.last_day > v_today + 55 then v_today + 55 end,
           'no_time', jsonb_array_length(v_fm) = 0,
           'next_milestone', (select jsonb_build_object('title', m.title, 'day', m.day) from public.homework_steps m
                              where m.assignment_id = a.id and m.kind = 'milestone' and m.done_at is null
                              order by m.pos, m.id limit 1),
           'steps', case when a.given_at is not null
                         then coalesce((select jsonb_agg(x - '_open' order by n) from jsonb_array_elements(v_steps) with ordinality t (x, n)
                                        where (x ->> 'assignment_id')::uuid = a.id), '[]')
                         else '[]' end)
         order by case a.status when 'open' then 0 else 1 end, a.due_date, a.created_at, a.id), '[]')
  into v_out
  from asg a;

  return jsonb_build_object(
    'language', p_lang,
    'as_of', to_char(v_now at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI'),
    'today', v_today,
    'server_now', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'me', jsonb_build_object(
      'first_name', split_part(v_me.name, ' ', 1),
      'tutor', (select nullif(split_part(btrim(split_part(l.label, ',', 1)), ' ', 1), '')
                from public.tutor_links l
                where l.kid_id = p_kid and l.active and l.expires_on >= v_today
                order by l.created_at, l.id limit 1),
      'cue', v_k.cue, 'if_stuck', v_k.if_stuck, 'length', v_k.focus_minutes, 'lengths', jsonb_build_array(10, 15, 20, 25),
      'points_on', v_k.points_on),
    'window', case when v_win is not null
                   then jsonb_build_object('starts', to_char(date '2000-01-01' + (v_win ->> 'starts')::time, 'HH24:MI'),
                                           'ends', to_char(date '2000-01-01' + (v_win ->> 'ends')::time, 'HH24:MI')) end,
    'on_time', case when v_k.points_on and v_win ->> 'first_free' is not null
                    then jsonb_build_object(
                           'from', to_char(date '2000-01-01' + (v_win ->> 'first_free')::time - interval '30 minutes', 'HH24:MI'),
                           'until', to_char(date '2000-01-01' + (v_win ->> 'first_free')::time + interval '10 minutes', 'HH24:MI'),
                           'done', exists (select 1 from public.focus_sessions f
                                           where f.kid_id = p_kid and (f.step_id is not null or f.assignment_id is not null)
                                             and (f.started_at at time zone v_tz)::date = v_today),
                           'points', v_k.pts_on_time) end,
    'session', (select jsonb_build_object('id', f.id, 'step_id', f.step_id, 'assignment_id', f.assignment_id,
                                          'title', coalesce(s.title, a.title), 'minutes', f.minutes,
                                          'started_at', f.started_at, 'ends_at', f.ends_at, 'with', f.with_whom)
                from public.focus_sessions f
                left join public.homework_steps s on s.id = f.step_id
                left join public.assignments a on a.id = f.assignment_id
                where f.kid_id = p_kid and f.ended_at is null),
    'now', case when v_nowst is not null then v_nowst - '_open' end,
    'tonight', (select coalesce(jsonb_agg(x - '_open' order by n), '[]') from jsonb_array_elements(v_tonight) with ordinality t (x, n)),
    'load', jsonb_build_object(
      'planned', coalesce((select sum((x ->> 'minutes')::int) from jsonb_array_elements(v_tonight) x where (x ->> '_open')::boolean), 0),
      'free', coalesce((v_win ->> 'free')::int, 0)),
    'earlier', (select coalesce(jsonb_agg(x - '_open' order by n), '[]') from jsonb_array_elements(v_earlier) with ordinality t (x, n)),
    'assignments', v_out,
    'points', case when v_k.points_on then jsonb_build_object(
                'balance', v_bal,
                'held', v_held,
                'today', coalesce((select sum(l.delta) from public.points_ledger l
                                   where l.kid_id = p_kid and l.day = v_today and l.delta > 0), 0),
                'capped', coalesce((select sum(l.delta) from public.points_ledger l
                                    where l.kid_id = p_kid and l.day = v_today and l.kind in ('focus', 'on_time')), 0) >= v_k.pts_day_cap) end,
    'rewards', case when v_k.points_on then
                 (select coalesce(jsonb_agg(jsonb_build_object(
                           'id', r.id, 'title', r.title, 'cost', r.cost,
                           'can_ask', v_bal - v_held >= r.cost
                                      and (select count(*) from public.reward_asks q where q.kid_id = p_kid and q.status = 'waiting') < 3
                                      and not exists (select 1 from public.reward_asks q
                                                      where q.kid_id = p_kid and q.reward_id = r.id and q.status = 'waiting'))
                         order by r.sort_order, r.cost, r.title, r.id), '[]')
                  from public.rewards r where r.kid_id = p_kid and r.active and r.cost is not null) end,
    'asks', case when v_k.points_on then
              (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', q.id, 'reward_id', q.reward_id, 'title', q.title, 'cost', q.cost, 'status', q.status,
                        'asked_at', q.asked_at, 'decided_at', q.decided_at, 'note', q.note)
                      order by q.asked_at desc, q.id), '[]')
               from public.reward_asks q
               where q.kid_id = p_kid
                 and (q.status = 'waiting' or (q.status in ('approved', 'declined') and q.decided_at >= v_now - interval '7 days'))) end,
    'recent', case when v_k.points_on then
                (select coalesce(jsonb_agg(jsonb_build_object('day', l.day, 'kind', l.kind, 'delta', l.delta, 'note', l.note)
                                           order by l.at desc, l.id), '[]')
                 from (select * from public.points_ledger l where l.kid_id = p_kid order by l.at desc, l.id limit 10) l) end,
    'pace', case when v_pace is not null then jsonb_build_object(
              'ratio', v_pace,
              'steps', (select count(*) from public.homework_steps st
                        join public.assignments a on a.id = st.assignment_id and a.kid_id = p_kid
                        where st.done_at is not null
                          and exists (select 1 from public.focus_sessions f where f.step_id = st.id and f.seen_minutes > 0))) end,
    'week', jsonb_build_object(
      'focused', coalesce((select sum(f.seen_minutes) from public.focus_sessions f
                           where f.kid_id = p_kid and f.ended_at is not null
                             and (f.started_at at time zone v_tz)::date between v_mon and v_mon + 6), 0),
      'last_week', coalesce((select sum(f.seen_minutes) from public.focus_sessions f
                             where f.kid_id = p_kid and f.ended_at is not null
                               and (f.started_at at time zone v_tz)::date between v_mon - 7 and v_mon - 1), 0)));
end;
$$;

-- The card on his My day (get_person_day's homework key): {next: {id, title, assignment, minutes} |
-- null, length, steps, minutes, earlier?, window?, session?: {ends_in_s}, points?}. next is his
-- view's now; steps and minutes count today's open steps; earlier is left out when there are none
-- or no homework time today, window when there is none today, session when no block is open,
-- points when points are off. Never raises: anything wrong leaves the card out.
create function private.homework_card(p_kid uuid, p_lang text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb;
begin
  v := private.homework_view_kid(p_kid, p_lang);
  if v is null then
    return null;
  end if;
  return jsonb_build_object(
           'next', case when jsonb_typeof(v -> 'now') = 'object'
                        then jsonb_build_object('id', v -> 'now' -> 'id', 'title', v -> 'now' -> 'title',
                                                'assignment', v -> 'now' -> 'assignment', 'minutes', v -> 'now' -> 'minutes') end,
           'length', v -> 'me' -> 'length',
           'steps', (select count(*) from jsonb_array_elements(v -> 'tonight') x where not (x ->> 'done')::boolean),
           'minutes', coalesce((select sum((x ->> 'minutes')::int) from jsonb_array_elements(v -> 'tonight') x
                                where not (x ->> 'done')::boolean), 0))
         || case when jsonb_typeof(v -> 'window') = 'object' and jsonb_array_length(v -> 'earlier') > 0
                 then jsonb_build_object('earlier', jsonb_array_length(v -> 'earlier')) else '{}' end
         || case when jsonb_typeof(v -> 'window') = 'object' then jsonb_build_object('window', v -> 'window') else '{}' end
         || case when jsonb_typeof(v -> 'session') = 'object'
                 then jsonb_build_object('session', jsonb_build_object(
                        'ends_in_s', greatest(0, ceil(extract(epoch from (v -> 'session' ->> 'ends_at')::timestamptz - private.now())))::int))
                 else '{}' end
         || case when jsonb_typeof(v -> 'points') = 'object' then jsonb_build_object('points', v -> 'points' -> 'balance') else '{}' end;
exception when others then
  return null;
end;
$$;

-- The tutor's view (tutor_view_by_token, and every answer of the link's writers):
--   {language, as_of, today, server_now, tutor (the link's label), kid (the first word of his name), ends_on,
--    ai: {on, left_today} | null, to_check, to_talk_about, questions, plans, assignments,
--    week: [{day, window, busy: [{starts, ends}], free, planned}] (14 days, no titles),
--    record: [{day, focused, sessions: [{minutes, with_tutor, result, step, note}]}] (the last 14 days,
--    finished blocks on homework only), pace}
--   with p_assignment (one of the link's kid's), also assignment: {id, kind, title, subject, due_date,
--   details, stretch, status, plan_rev, given_at, given_by, steps, ai, preview, fits, over, horizon};
--   p_part 'ai' (the poll while a run is open) answers only {assignment: {id, plan_rev, ai}}.
-- given_by, done_by, added_by and the by of qa_log are 'kid', 'tutor' or 'family': no family
-- member's name or email ever. Never a block running now, whether he worked alone or with a parent,
-- points, rewards, asks, other people, family event titles, any token. An AI run still running past
-- its lease reads as failed with stop 'timeout'.
create function private.homework_view_tutor(p_link uuid, p_assignment uuid, p_part text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_l      public.tutor_links;
  v_me     public.people;
  v_h      public.household;
  v_a      public.assignments;
  v_now    timestamptz := private.now();
  v_tz     text := private.tz();
  v_today  date := public.today_local();
  v_fm     jsonb;
  v_first  date;
  v_stale  boolean;
  v_ai     jsonb;
  v_pace   numeric;
  v_out    jsonb;
  v_detail jsonb;
begin
  select * into v_l from public.tutor_links l where l.id = p_link;
  if v_l.id is null then
    return null;
  end if;
  select * into v_me from public.people p where p.id = v_l.kid_id;
  select * into v_h from public.household h;
  if p_assignment is not null then
    select * into v_a from public.assignments a where a.id = p_assignment and a.kid_id = v_l.kid_id;
  end if;
  if v_a.id is not null then
    v_stale := v_a.ai_state = 'running'
               and not exists (select 1 from public.ai_runs r where r.assignment_id = v_a.id and r.status = 'running' and r.lease_until >= v_now);
    v_ai := case when v_a.ai_state is not null or v_a.ai_draft is not null then jsonb_build_object(
              'state', case when v_stale then 'failed' else v_a.ai_state end,
              'stop', case when v_stale then 'timeout' else v_a.ai_stop end,
              'draft', v_a.ai_draft, 'prev', v_a.ai_prev, 'at', v_a.ai_at) end;
  end if;
  if p_part = 'ai' then
    return jsonb_build_object('assignment', case when v_a.id is not null
                                                 then jsonb_build_object('id', v_a.id, 'plan_rev', v_a.plan_rev, 'ai', v_ai) end);
  end if;

  select coalesce(jsonb_agg(to_jsonb(f) order by f.day), '[]') into v_fm
  from private.free_minutes(v_l.kid_id, v_today, v_today + 55, null) f;
  v_first := case when exists (select 1 from jsonb_array_elements(v_fm) x
                               where (x ->> 'day')::date = v_today and (x ->> 'ends')::time > (v_now at time zone v_tz)::time)
                  then v_today else v_today + 1 end;
  v_pace := private.homework_pace(v_l.kid_id);

  with fm as (
    select * from jsonb_to_recordset(v_fm)
      as f (day date, starts time, ends time, window_minutes int, free int, planned int, busy jsonb, first_free time)
  ),
  asg as (   -- open, and done or dropped in the last 30 days
    select a.*,
           case when a.kind = 'lesson' then greatest(a.due_date, v_today)
                when a.due_date - v_today >= 7 then a.due_date - 2
                when a.due_date > v_today then a.due_date - 1
                else v_today end as last_day
    from public.assignments a
    where a.kid_id = v_l.kid_id
      and (a.status = 'open'
           or (a.status = 'done' and a.done_at >= v_now - interval '30 days')
           or (a.status = 'dropped' and a.updated_at >= v_now - interval '30 days'))
  ),
  mine as (
    select s.assignment_id, s.day, sum(s.minutes)::int as m
    from public.homework_steps s join asg a on a.id = s.assignment_id and a.status = 'open'
    where s.done_at is null
    group by s.assignment_id, s.day
  ),
  bars as (
    select a.id,
           coalesce((select sum(s.minutes) from public.homework_steps s where s.assignment_id = a.id and s.done_at is null), 0)::int as minutes_left,
           coalesce((select sum(greatest(f.free - (f.planned - coalesce(mi.m, 0)), 0))
                     from fm f left join mine mi on mi.assignment_id = a.id and mi.day = f.day
                     where f.day between v_first and least(a.last_day, v_today + 55)), 0)::int as time_left,
           case when a.last_day > v_today + 55 then v_today + 55 end as horizon
    from asg a
  ),
  days as (
    select g::date as day from generate_series(v_today, v_today + 13, interval '1 day') g
  ),
  planned as (
    select s.day, sum(s.minutes)::int as m
    from public.homework_steps s join public.assignments a on a.id = s.assignment_id
    where a.kid_id = v_l.kid_id and a.status = 'open' and s.done_at is null and s.day between v_today and v_today + 13
    group by s.day
  )
  select jsonb_build_object(
    'to_check', (select coalesce(jsonb_agg(jsonb_build_object(
                          'step_id', s.id, 'assignment', a.title, 'title', s.title, 'done_looks_like', s.done_looks_like,
                          'day', s.day, 'done_day', (s.done_at at time zone v_tz)::date)
                        order by s.done_at, s.id), '[]')
                 from public.homework_steps s join asg a on a.id = s.assignment_id
                 where s.kind = 'milestone' and s.done_at is not null and s.checked_at is null),
    'to_talk_about', (select coalesce(jsonb_agg(jsonb_build_object(
                               'assignment_id', a.id, 'title', a.title, 'milestone', m.title, 'planned_day', m.day)
                             order by m.day, a.due_date, m.pos, m.id), '[]')
                      from public.homework_steps m join asg a on a.id = m.assignment_id
                      where a.status = 'open' and a.given_at is not null and m.kind = 'milestone' and m.done_at is null
                        and (m.day < v_today
                             or exists (select 1 from public.homework_steps y
                                        where y.assignment_id = m.assignment_id and y.done_at is null and y.kind <> 'milestone'
                                          and y.pos < m.pos and y.day > m.day))),
    'questions', (select coalesce(jsonb_agg(jsonb_build_object(
                           'step_id', s.id, 'assignment', a.title, 'title', s.title, 'question', s.question,
                           'question_at', s.question_at, 'answer', s.answer)
                         order by s.answer is not null, s.question_at, s.id), '[]')
                  from public.homework_steps s join asg a on a.id = s.assignment_id
                  where s.question is not null and (s.answer is null or s.answer_at >= v_now - interval '7 days')),
    'plans', (select coalesce(jsonb_agg(jsonb_build_object(
                       'assignment_id', a.id, 'title', a.title,
                       'state', case when exists (select 1 from public.homework_steps s where s.assignment_id = a.id) then 'planning' else 'none' end,
                       'ai_state', case when a.ai_state = 'running'
                                             and not exists (select 1 from public.ai_runs r
                                                             where r.assignment_id = a.id and r.status = 'running' and r.lease_until >= v_now)
                                        then 'failed' else a.ai_state end)
                     order by a.due_date, a.created_at, a.id), '[]')
              from asg a
              where a.status = 'open' and a.given_at is null
                and (a.ai_state is not null or a.ai_draft is not null
                     or exists (select 1 from public.homework_steps s where s.assignment_id = a.id))),
    'assignments', (select coalesce(jsonb_agg(jsonb_build_object(
                             'id', a.id, 'kind', a.kind, 'title', a.title, 'subject', a.subject, 'due_date', a.due_date,
                             'status', a.status,
                             'state', case when a.given_at is not null then 'given'
                                           when a.ai_state = 'running' or a.ai_draft is not null
                                                or exists (select 1 from public.homework_steps s where s.assignment_id = a.id) then 'planning'
                                           else 'none' end,
                             'added_by', a.added_by,
                             'given_by', case when a.given_by is null then null
                                              when a.given_by like '% (tutor link)' then 'tutor'
                                              when a.given_by like '% (My day)' then 'kid'
                                              else 'family' end,
                             'minutes_left', b.minutes_left, 'time_left', b.time_left, 'horizon', b.horizon,
                             'no_time', jsonb_array_length(v_fm) = 0,
                             'steps_done', (select count(*) from public.homework_steps s where s.assignment_id = a.id and s.done_at is not null),
                             'steps', (select count(*) from public.homework_steps s where s.assignment_id = a.id),
                             'next_milestone', (select jsonb_build_object('title', m.title, 'day', m.day) from public.homework_steps m
                                                where m.assignment_id = a.id and m.kind = 'milestone' and m.done_at is null
                                                order by m.pos, m.id limit 1))
                           order by case a.status when 'open' then 0 else 1 end, a.due_date, a.created_at, a.id), '[]')
                    from asg a join bars b on b.id = a.id),
    'week', (select jsonb_agg(jsonb_build_object(
                      'day', d.day,
                      'window', case when f.day is not null
                                     then jsonb_build_object('starts', to_char(date '2000-01-01' + f.starts, 'HH24:MI'),
                                                             'ends', to_char(date '2000-01-01' + f.ends, 'HH24:MI')) end,
                      'busy', coalesce((select jsonb_agg(x - 'title' order by n) from jsonb_array_elements(f.busy) with ordinality t (x, n)), '[]'),
                      'free', coalesce(f.free, 0),
                      'planned', coalesce(p.m, 0))
                    order by d.day)
             from days d left join fm f on f.day = d.day left join planned p on p.day = d.day),
    'record', (select coalesce(jsonb_agg(jsonb_build_object('day', r.day, 'focused', r.focused, 'sessions', r.sessions) order by r.day desc), '[]')
               from (select (f.started_at at time zone v_tz)::date as day,
                            sum(coalesce(f.seen_minutes, 0))::int as focused,
                            jsonb_agg(jsonb_build_object('minutes', f.minutes, 'with_tutor', f.with_whom = 'tutor', 'result', f.result,
                                                         'step', coalesce(s.title, a.title), 'note', f.note)
                                      order by f.started_at, f.id) as sessions
                     from public.focus_sessions f
                     left join public.homework_steps s on s.id = f.step_id
                     left join public.assignments a on a.id = f.assignment_id
                     where f.kid_id = v_l.kid_id and f.ended_at is not null and f.result <> 'expired'
                       and (f.step_id is not null or f.assignment_id is not null)
                       and (f.started_at at time zone v_tz)::date between v_today - 13 and v_today
                     group by 1) r))
  into v_out;

  if v_a.id is not null then
    with fm as (
      select * from jsonb_to_recordset(v_fm)
        as f (day date, starts time, ends time, window_minutes int, free int, planned int, busy jsonb, first_free time)
    ),
    lastday as (
      select case when v_a.kind = 'lesson' then greatest(v_a.due_date, v_today)
                  when v_a.due_date - v_today >= 7 then v_a.due_date - 2
                  when v_a.due_date > v_today then v_a.due_date - 1
                  else v_today end as d
    ),
    b as (
      select coalesce((select sum(s.minutes) from public.homework_steps s where s.assignment_id = v_a.id and s.done_at is null), 0)::int as ml,
             coalesce((select sum(greatest(f.free - (f.planned
                                                      - case when v_a.status = 'open'
                                                             then coalesce((select sum(s.minutes) from public.homework_steps s
                                                                            where s.assignment_id = v_a.id and s.done_at is null and s.day = f.day), 0)
                                                             else 0 end), 0))
                       from fm f cross join lastday l where f.day between v_first and least(l.d, v_today + 55)), 0)::int as tl,
             (select case when l.d > v_today + 55 then v_today + 55 end from lastday l) as horizon
    )
    select jsonb_build_object(
      'id', v_a.id, 'kind', v_a.kind, 'title', v_a.title, 'subject', v_a.subject, 'due_date', v_a.due_date,
      'details', v_a.details, 'stretch', v_a.stretch, 'status', v_a.status, 'plan_rev', v_a.plan_rev,
      'given_at', v_a.given_at,
      'given_by', case when v_a.given_by is null then null
                       when v_a.given_by like '% (tutor link)' then 'tutor'
                       when v_a.given_by like '% (My day)' then 'kid'
                       else 'family' end,
      'steps', (select coalesce(jsonb_agg(jsonb_build_object(
                         'id', s.id, 'pos', s.pos, 'kind', s.kind, 'title', s.title, 'done_looks_like', s.done_looks_like,
                         'minutes', s.minutes, 'day', s.day, 'source', s.source, 'done', s.done_at is not null,
                         'done_by', case when s.done_by is null then null
                                         when s.done_by like '% (tutor link)' then 'tutor'
                                         when s.done_by like '% (My day)' then 'kid'
                                         else 'family' end,
                         'checked', s.checked_at is not null,
                         'coach', case when s.coach_note is not null then jsonb_build_object('by', s.coach_note_by, 'text', s.coach_note) end,
                         'moved_from', s.moved_from, 'question', s.question, 'answer', s.answer,
                         'qa_log', (select coalesce(jsonb_agg(x - 'answered_by' - 'cleared_by' order by n), '[]')
                                    from jsonb_array_elements(s.qa_log) with ordinality t (x, n)))
                       order by s.pos, s.id), '[]')
                from public.homework_steps s where s.assignment_id = v_a.id),
      'ai', v_ai,
      'preview', case when v_h.homework_ai and v_l.can_ai
                      then private.ai_input(v_a.id,
                                            case when v_a.ai_draft is not null
                                                      or exists (select 1 from public.homework_steps s where s.assignment_id = v_a.id)
                                                 then 'revise' else 'plan' end,
                                            null, null, 'tutor') ->> 'message' end,
      'fits', jsonb_array_length(v_fm) > 0 and b.ml <= b.tl,
      'over', greatest(b.ml - b.tl, 0),
      'horizon', b.horizon)
    into v_detail
    from b;
  end if;

  return jsonb_build_object(
    'language', v_l.language,
    'as_of', to_char(v_now at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI'),
    'today', v_today,
    'server_now', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'tutor', v_l.label,
    'kid', split_part(v_me.name, ' ', 1),
    'ends_on', v_l.expires_on,
    'ai', case when v_h.homework_ai and v_l.can_ai then jsonb_build_object(
            'on', true,
            'left_today', greatest(0, least(
              12 - (select count(*) from public.ai_runs r where (r.started_at at time zone v_tz)::date = v_today),
              10 - (select count(*) from public.ai_runs r where r.link_id = v_l.id and (r.started_at at time zone v_tz)::date = v_today)))) end,
    'pace', case when v_pace is not null then jsonb_build_object(
              'ratio', v_pace,
              'steps', (select count(*) from public.homework_steps st
                        join public.assignments a on a.id = st.assignment_id and a.kid_id = v_l.kid_id
                        where st.done_at is not null
                          and exists (select 1 from public.focus_sessions f where f.step_id = st.id and f.seen_minutes > 0))) end)
    || v_out
    || case when p_assignment is not null then jsonb_build_object('assignment', v_detail) else '{}' end;
end;
$$;

-- ---------------------------------------------------------------------
-- What the AI may see (§6.4). PR B's homework.ts sends input.message as it is.
-- ---------------------------------------------------------------------

-- Text made fit to send, best effort (the preview is the backstop): uuid-shaped strings become
-- [id]; links, email addresses and phone-number shapes [link], [email], [phone]; a title and one or
-- two capitalized words ("Ms. Rivera") [name]; every active person's first and full name (and the
-- kid's, p_kid), each tutor link's label, the part before its first comma ("Pat Lee") and each
-- word of that part ("Pat", "Lee"), and the parents' never-send words, as whole words in any case,
-- [name]; then every < and > becomes ‹ and ›, so no text can close its own field.
create function private.scrub(p_text text, p_kid uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v       text := p_text;
  v_words text[];
begin
  if v is null then
    return null;
  end if;
  v := regexp_replace(v, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '[id]', 'g');
  v := regexp_replace(v, '(https?://|www\.)[^[:space:]<>"]*[^[:space:]<>".,;:!?)''"]', '[link]', 'gi');
  v := regexp_replace(v, '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '[email]', 'g');
  v := regexp_replace(v, '(?<![[:alnum:]])(\+?1[ .-]?)?(\([0-9]{3}\)[ .-]?|[0-9]{3}[ .-])?[0-9]{3}[ .-][0-9]{4}(?![[:alnum:]])', '[phone]', 'g');
  v := regexp_replace(v, '(?<![[:alnum:]_])(Mrs|Mr|Miss|Ms|Mx|Dr|Profe|Prof|Coach|Srta|Sra|Sr)\.?[[:space:]]+[[:upper:]][[:alpha:]''-]*([[:space:]]+[[:upper:]][[:alpha:]''-]*)?',
                     '[name]', 'g');
  select array_agg(b.w order by char_length(b.w) desc, b.w) into v_words
  from (select distinct btrim(a.w) as w
        from (select p.name as w from public.people p where p.active or p.id = p_kid
              union all
              select split_part(p.name, ' ', 1) from public.people p where p.active or p.id = p_kid
              union all
              select l.label from public.tutor_links l
              union all
              select split_part(l.label, ',', 1) from public.tutor_links l
              union all
              select x.w from public.tutor_links l cross join lateral regexp_split_to_table(btrim(split_part(l.label, ',', 1)), '[[:space:]]+') x (w)
              union all
              select x.w from public.household h cross join lateral unnest(h.homework_never_send) x (w)) a) b
  where char_length(b.w) >= 2;
  if v_words is not null then
    v := regexp_replace(v, '(?<![[:alnum:]_])('
                           || array_to_string(array(select regexp_replace(w, '([][(){}.*+?^$|\\])', '\\\1', 'g') from unnest(v_words) w), '|')
                           || ')(?![[:alnum:]_])', '[name]', 'gi');
  end if;
  return translate(v, '<>', '‹›');
end;
$$;

-- The AI's input for one assignment, built from the database: {fields, message}. message is the
-- one user message (the fields, each in its own tag), which homework.ts sends as it is and the
-- preview shows as it is. Every text is scrubbed (private.scrub). free_time is his free minutes per
-- day from his first day with homework time left to the last work day (at most 28 days), less his
-- other assignments' steps: minutes only, never what fills the rest of the day. current_plan
-- (revise) is the saved steps not done (or the last draft's, when nothing is saved), with refs per
-- request, never ids; locked for 'typed' steps. request (revise) is wrapped with the asker's role
-- (p_from 'tutor' or 'parent'), never a name. p_kind 'test' builds a fixed, made-up assignment
-- and reads nothing about the family. Null for an assignment that isn't there.
create function private.ai_input(p_assignment uuid, p_kind text, p_request text, p_answers text[], p_from text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_a       public.assignments;
  v_k       public.homework_kids;
  v_me      public.people;
  v_today   date := public.today_local();
  v_due     date;
  v_last    date;
  v_first   date;
  v_kind    text;
  v_subject text;
  v_lang    text;
  v_mins    int;
  v_title   text;
  v_text    text;
  v_pace    text;
  v_free    text[];
  v_plan    jsonb;
  v_req     text;
  v_ans     text[];
  v_dist    int;
  v_fields  jsonb;
begin
  if p_kind = 'test' then
    v_due := v_today + 9;
    v_kind := 'assignment';
    v_subject := 'English';
    v_lang := 'en';
    v_mins := 20;
    v_title := 'Book report on a novel you choose';
    v_text := 'Read a novel of your choice and write a one-page report: the main character, the setting, and what you thought of the ending.'
              || E'\nHand it in at the start of class.';
    v_free := array(select to_char(d, 'Dy YYYY-MM-DD') || ': 45 min free'
                    from generate_series(v_today + 1, v_due - 2, interval '1 day') d
                    where extract(isodow from d) between 1 and 4
                    order by d);
  else
    select * into v_a from public.assignments a where a.id = p_assignment;
    if v_a.id is null then
      return null;
    end if;
    select * into v_k from public.homework_kids k where k.kid_id = v_a.kid_id;
    select * into v_me from public.people p where p.id = v_a.kid_id;
    v_due := v_a.due_date;
    v_kind := v_a.kind;
    v_subject := private.scrub(v_a.subject, v_a.kid_id);
    v_lang := coalesce(v_me.language, 'en');
    v_mins := coalesce(v_k.focus_minutes, 20);
    v_title := private.scrub(v_a.title, v_a.kid_id);
    v_text := private.scrub(left(v_a.details, 4000), v_a.kid_id);
    v_pace := 'Past steps took about ' || to_char(private.homework_pace(v_a.kid_id), 'FM0.0') || ' times the planned time.';
    v_last := case when v_a.kind = 'lesson' then greatest(v_due, v_today)
                   when v_due - v_today >= 7 then v_due - 2
                   when v_due > v_today then v_due - 1
                   else v_today end;
    v_first := case when exists (select 1 from private.free_minutes(v_a.kid_id, v_today, v_today, null) f
                                 where f.ends > (private.now() at time zone private.tz())::time)
                    then v_today else v_today + 1 end;
    v_free := array(select to_char(f.day, 'Dy YYYY-MM-DD') || ': ' || (f.free - f.planned) || ' min free'
                    from private.free_minutes(v_a.kid_id, v_first, least(v_last, v_today + 27), v_a.id) f
                    where f.free - f.planned > 0
                    order by f.day);
    if p_kind = 'revise' then
      select jsonb_agg(jsonb_build_object('ref', 's' || x.n, 'title', private.scrub(x.title, v_a.kid_id),
                                          'done_looks_like', private.scrub(x.done_looks_like, v_a.kid_id),
                                          'minutes', x.minutes, 'day', x.day, 'kind', x.kind, 'locked', x.source = 'typed')
                       order by x.n)
      into v_plan
      from (select s.*, row_number() over (order by s.pos, s.id) as n
            from public.homework_steps s where s.assignment_id = v_a.id and s.done_at is null) x;
      if v_plan is null and jsonb_typeof(v_a.ai_draft -> 'steps') = 'array' then
        select jsonb_agg(jsonb_build_object('ref', 's' || x.n, 'title', private.scrub(x.s ->> 'title', v_a.kid_id),
                                            'done_looks_like', private.scrub(x.s ->> 'done_looks_like', v_a.kid_id),
                                            'minutes', (x.s ->> 'minutes')::int, 'day', x.s ->> 'day', 'kind', x.s ->> 'kind',
                                            'locked', false)
                         order by x.n)
        into v_plan
        from jsonb_array_elements(v_a.ai_draft -> 'steps') with ordinality x (s, n);
      end if;
      v_req := nullif(private.scrub(private.clean_text(left(p_request, 200), 200), v_a.kid_id), '');
    end if;
    v_ans := array(select private.scrub(private.clean_text(left(x.a, 200), 200), v_a.kid_id)
                   from unnest(p_answers[1:3]) with ordinality x (a, n)
                   where nullif(private.clean_text(x.a, 200), '') is not null
                   order by x.n);
  end if;
  v_dist := v_due - v_today;
  v_fields := jsonb_build_object(
    'today', to_char(v_today, 'Dy YYYY-MM-DD'),
    'due', to_char(v_due, 'Dy YYYY-MM-DD') || ' ('
           || case when v_dist = 0 then 'today' when v_dist = 1 then '1 day away' when v_dist > 1 then v_dist || ' days away'
                   when v_dist = -1 then '1 day ago' else -v_dist || ' days ago' end || ')',
    'kind', v_kind,
    'subject', v_subject,
    'language', v_lang,
    'session_minutes', v_mins,
    'pace', v_pace,
    'free_time', to_jsonb(coalesce(v_free, '{}')),
    'assignment_title', v_title,
    'assignment_text', v_text,
    'current_plan', v_plan,
    'request', v_req,
    'answers', to_jsonb(coalesce(v_ans, '{}')));
  return jsonb_build_object('fields', v_fields, 'message', concat_ws(E'\n',
    '<today>' || (v_fields ->> 'today') || '</today>',
    '<due>' || (v_fields ->> 'due') || '</due>',
    '<kind>' || v_kind || '</kind>',
    '<subject>' || v_subject || '</subject>',
    '<language>' || v_lang || '</language>',
    '<session_minutes>' || v_mins || '</session_minutes>',
    '<pace>' || v_pace || '</pace>',
    '<free_time>' || E'\n' || coalesce(nullif(array_to_string(v_free, E'\n'), ''), 'none') || E'\n' || '</free_time>',
    '<assignment_title>' || v_title || '</assignment_title>',
    '<assignment_text>' || E'\n' || v_text || E'\n' || '</assignment_text>',
    '<current_plan>' || v_plan::text || '</current_plan>',
    '<request from="' || case when p_from = 'tutor' then 'tutor' else 'parent' end || '">' || v_req || '</request>',
    case when cardinality(v_ans) > 0
         then '<answers>' || E'\n' || array_to_string(array(select '- ' || x from unnest(v_ans) x), E'\n') || E'\n' || '</answers>' end));
end;
$$;

-- ---------------------------------------------------------------------
-- Pages: the week strip (§5.5)
-- ---------------------------------------------------------------------

-- A kid's week for the Homework page, with the caller's rights (a non-member's days are empty):
-- p_days days (1 to 56) from p_from, [{day, window: {starts, ends} | null, busy: [{starts, ends, title}],
-- free, planned, over}]. planned is the minutes of not-done steps on that day in his open
-- assignments; over is how much planned is more than free. Busy titles are the members' own
-- events, which they can read anyway.
create function public.homework_week(p_kid uuid, p_from date, p_days int default 14)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_from is null or p_days is null or p_days not between 1 and 56 then
    raise exception 'Choose 1 to 56 days.' using errcode = '22023';
  end if;
  return (
    with f as (
      select * from private.free_minutes(p_kid, p_from, p_from + p_days - 1, null)
    ),
    pl as (
      select s.day, sum(s.minutes)::int as m
      from public.homework_steps s join public.assignments a on a.id = s.assignment_id
      where a.kid_id = p_kid and a.status = 'open' and s.done_at is null and s.day between p_from and p_from + p_days - 1
      group by s.day
    )
    select jsonb_agg(jsonb_build_object(
             'day', d.day,
             'window', case when f.day is not null
                            then jsonb_build_object('starts', to_char(date '2000-01-01' + f.starts, 'HH24:MI'),
                                                    'ends', to_char(date '2000-01-01' + f.ends, 'HH24:MI')) end,
             'busy', coalesce(f.busy, '[]'),
             'free', coalesce(f.free, 0),
             'planned', coalesce(pl.m, 0),
             'over', greatest(coalesce(pl.m, 0) - coalesce(f.free, 0), 0))
           order by d.day)
    from (select g::date as day from generate_series(p_from, p_from + p_days - 1, interval '1 day') g) d
    left join f on f.day = d.day
    left join pl on pl.day = d.day);
end;
$$;

-- ---------------------------------------------------------------------
-- Signed-in actions (§3.5): the parents only. Each raises 42501 "Only a parent can change
-- homework." unless private.is_admin(); Sam's page is read-only.
-- ---------------------------------------------------------------------

-- Homework on (or off) for a kid: makes the row for an active person with role kid, or turns it on
-- or off. Turning it off deletes nothing.
create function public.save_homework_kid(p_kid uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_active is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  if p_active and not exists (select 1 from public.people p where p.id = p_kid and p.active and p.role = 'kid') then
    raise exception 'Homework is for kids.' using errcode = '22023';
  end if;
  if not p_active and not exists (select 1 from public.homework_kids k where k.kid_id = p_kid) then
    return;
  end if;
  insert into public.homework_kids as k (kid_id, active) values (p_kid, p_active)
  on conflict (kid_id) do update set active = excluded.active
  where k.active is distinct from excluded.active;
end;
$$;

-- Homework time: one weekly event in the kid's name, titled "Homework" in his language, on the ISO
-- weekdays p_weekdays (1 = Monday to 7 = Sunday, as events.repeat_weekdays), from p_start to p_end
-- (after it, at most 4 hours), skipping the household's days off, starting on the first day from
-- today on one of those weekdays (0002's events_weekdays trigger adds the start date's own weekday
-- to the series), and its homework_times row. With the caller's rights (row-level security decides).
-- Returns the event's id.
create function public.add_homework_time(p_kid uuid, p_weekdays int[], p_start time, p_end time)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_today date := public.today_local();
  v_days  int[] := array(select distinct w from unnest(p_weekdays) w where w is not null order by w);
  v_start date;
  v_lang  text;
  v_id    uuid;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.homework_kids k where k.kid_id = p_kid) then
    raise exception 'Turn on homework for this kid first.' using errcode = '22023';
  end if;
  if cardinality(v_days) not between 1 and 7 then
    raise exception 'Choose 1 to 7 days.' using errcode = '22023';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'Homework time ends after it starts.' using errcode = '22023';
  end if;
  if p_end - p_start > interval '4 hours' then
    raise exception 'Homework time is at most 4 hours.' using errcode = '22023';
  end if;
  select min(d)::date into v_start
  from generate_series(v_today, v_today + 6, interval '1 day') d
  where extract(isodow from d)::int = any (v_days);
  select p.language into v_lang from public.people p where p.id = p_kid;
  insert into public.events (title, start_date, start_time, end_time, responsible_id, participant_ids, repeat, repeat_weekdays, skip_days_off)
  values (private.homework_word('homework', coalesce(v_lang, 'en')), coalesce(v_start, v_today), p_start, p_end, p_kid, '{}',
          'weekly', v_days, true)
  returning id into v_id;
  insert into public.homework_times (event_id, kid_id) values (v_id, p_kid);
  return v_id;
end;
$$;

-- A plan saved by a parent (private.plan_save, as the family). p_rev is required (0 for a first plan).
create function public.save_homework_plan(p_assignment uuid, p_steps jsonb, p_rev int, p_give boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r     jsonb;
  v_kid uuid;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  select a.kid_id into v_kid from public.assignments a where a.id = p_assignment;
  if v_kid is null then
    raise exception 'That assignment is gone.' using errcode = '22023';
  end if;
  r := private.plan_save(p_assignment, p_steps, coalesce(p_give, false), p_rev, 'family', public.current_email());
  perform private.homework_trim(v_kid);
  return r - '_changed';
end;
$$;

-- A parent on one step (private.step_act, as the family): 'check' (an optional note), 'not_yet' (a note),
-- 'uncheck', 'answer', 'clear', 'done', 'undo'.
create function public.homework_step(p_step uuid, p_action text, p_text text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if char_length(p_text) > (case when p_action = 'answer' then 200 else 160 end) then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.homework_steps s where s.id = p_step) then
    raise exception 'That step is gone.' using errcode = '22023';
  end if;
  return private.step_act(p_step, p_action, p_text, null, null, 'family', public.current_email()) - '_changed';
end;
$$;

-- Yes or Not now on his ask. Yes checks the balance again (his points, less what his other waiting
-- asks hold, must cover it), then writes a 'trade' of −cost; Not now takes nothing and can carry a
-- word he sees (at most 120). An ask already decided answers as it is. Answers {ask, balance}.
create function public.decide_reward(p_ask uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q    public.reward_asks;
  v_bal  int;
  v_held int;
  v_who  text := public.current_email();
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if char_length(p_note) > 120 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if p_approve is null then
    raise exception 'Choose Yes or Not now.' using errcode = '22023';
  end if;
  select * into v_q from public.reward_asks q where q.id = p_ask for update;
  if v_q.id is null then
    raise exception 'That ask is gone.' using errcode = '22023';
  end if;
  if v_q.status = 'waiting' then
    select b.balance, b.held into v_bal, v_held from private.points_balance(v_q.kid_id) b;
    if p_approve then
      if v_bal - (v_held - v_q.cost) < v_q.cost then
        raise exception 'Not enough points yet.' using errcode = '42501';
      end if;
      perform private.award(v_q.kid_id, 'trade', -v_q.cost, public.today_local(), null, null, v_q.id, null, v_q.title, v_who);
      update public.reward_asks set status = 'approved', decided_at = private.now(), decided_by = v_who where id = v_q.id;
    else
      update public.reward_asks
      set status = 'declined', decided_at = private.now(), decided_by = v_who, note = nullif(private.clean_text(p_note, 120), '')
      where id = v_q.id;
    end if;
  end if;
  select * into v_q from public.reward_asks q where q.id = p_ask;
  return jsonb_build_object('ask', to_jsonb(v_q), 'balance', (select b.balance from private.points_balance(v_q.kid_id) b));
end;
$$;

-- Points a parent gives (1 to 200), with a note he sees, for what the rules can't see. p_key is the
-- ledger row's id: a resend writes nothing more. Refused while points are off.
create function public.give_points(p_kid uuid, p_points int, p_note text, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l    public.points_ledger;
  v_note text := nullif(private.clean_text(p_note, 120), '');
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_points is null or p_points not between 1 and 200 then
    raise exception 'Give 1 to 200 points.' using errcode = '22023';
  end if;
  if char_length(p_note) > 120 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if v_note is null then
    raise exception 'Say what the points are for.' using errcode = '22023';
  end if;
  if p_key is null then
    raise exception 'Points need their id.' using errcode = '22023';
  end if;
  select * into v_l from public.points_ledger l where l.id = p_key;
  if v_l.id is not null and (v_l.kid_id <> p_kid or v_l.kind <> 'given') then
    raise exception 'That id is taken.' using errcode = '22023';
  end if;
  if v_l.id is null then
    if not exists (select 1 from public.homework_kids k where k.kid_id = p_kid and k.points_on) then
      raise exception 'Points are off.' using errcode = '42501';
    end if;
    perform 1 from public.homework_kids k where k.kid_id = p_kid for update;
    insert into public.points_ledger (id, kid_id, at, day, kind, delta, note, who)
    values (p_key, p_kid, private.now(), public.today_local(), 'given', p_points, v_note, public.current_email())
    on conflict (id) do nothing;
  end if;
  select * into v_l from public.points_ledger l where l.id = p_key;
  return jsonb_build_object('entry', jsonb_build_object('id', v_l.id, 'delta', v_l.delta, 'note', v_l.note),
                            'balance', (select b.balance from private.points_balance(p_kid) b));
end;
$$;

-- A parent's correction, never a penalty rule: one focus, on_time, milestone or given entry gets a
-- 'void' of the same size, with a reason he sees. Refused when it would take his balance below
-- zero ("Those points are already spent."). An entry already voided answers as it is.
create function public.void_points(p_entry uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l    public.points_ledger;
  v_note text := nullif(private.clean_text(p_note, 120), '');
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if char_length(p_note) > 120 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if v_note is null then
    raise exception 'Say why.' using errcode = '22023';
  end if;
  select * into v_l from public.points_ledger l where l.id = p_entry;
  if v_l.id is null or v_l.kind not in ('focus', 'on_time', 'milestone', 'given') then
    raise exception 'Only earned or given points can be voided.' using errcode = '22023';
  end if;
  perform 1 from public.homework_kids k where k.kid_id = v_l.kid_id for update;
  if not exists (select 1 from public.points_ledger x where x.void_of = v_l.id and x.kind = 'void') then
    if (select b.balance from private.points_balance(v_l.kid_id) b) - v_l.delta < 0 then
      raise exception 'Those points are already spent.' using errcode = 'P0001';
    end if;
    perform private.award(v_l.kid_id, 'void', -v_l.delta, public.today_local(), null, null, null, v_l.id, v_note, public.current_email());
  end if;
  return jsonb_build_object('entry', (select jsonb_build_object('id', x.id, 'delta', x.delta, 'note', x.note)
                                      from public.points_ledger x where x.void_of = v_l.id and x.kind = 'void'),
                            'balance', (select b.balance from private.points_balance(v_l.kid_id) b));
end;
$$;

-- A tutor link made (p_link null) or changed: its label (1 to 60), language, end date (today to
-- today + 400; null: today + 180), whether it may ask the AI, and on or off. At most 3 per kid.
-- Returns its id.
create function public.save_tutor_link(p_link uuid, p_kid uuid, p_label text, p_language text, p_expires_on date,
                                       p_can_ai boolean, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.today_local();
  v_label text := private.clean_text(p_label, 200);
  v_ends  date := coalesce(p_expires_on, public.today_local() + 180);
  v_id    uuid;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if v_label is null or char_length(v_label) not between 1 and 60 then
    raise exception 'A link''s name is 1 to 60 characters.' using errcode = '22023';
  end if;
  if coalesce(p_language, 'en') not in ('en', 'es') then
    raise exception 'Choose English or Spanish.' using errcode = '22023';
  end if;
  if v_ends not between v_today and v_today + 400 then
    raise exception 'A link ends from today to 400 days from now.' using errcode = '22023';
  end if;
  if p_link is null then
    if not exists (select 1 from public.homework_kids k where k.kid_id = p_kid) then
      raise exception 'Turn on homework for this kid first.' using errcode = '22023';
    end if;
    perform 1 from public.homework_kids k where k.kid_id = p_kid for update;
    if (select count(*) from public.tutor_links l where l.kid_id = p_kid) >= 3 then
      raise exception 'At most 3 tutor links.' using errcode = '22023';
    end if;
    insert into public.tutor_links (kid_id, label, language, expires_on, can_ai, active)
    values (p_kid, v_label, coalesce(p_language, 'en'), v_ends, coalesce(p_can_ai, true), coalesce(p_active, true))
    returning id into v_id;
  else
    update public.tutor_links l
    set label = v_label, language = coalesce(p_language, l.language), expires_on = v_ends,
        can_ai = coalesce(p_can_ai, l.can_ai), active = coalesce(p_active, l.active)
    where l.id = p_link
    returning l.id into v_id;
    if v_id is null then
      raise exception 'That link is gone.' using errcode = '22023';
    end if;
  end if;
  return v_id;
end;
$$;

-- New link: a new token for a tutor link; the old address stops working at once.
create function public.new_tutor_token(p_link uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  update public.tutor_links set token = encode(extensions.gen_random_bytes(16), 'hex') where id = p_link;
  if not found then
    raise exception 'That link is gone.' using errcode = '22023';
  end if;
end;
$$;

-- What Claude would see (§6.4) for this kind ('plan', 'revise' or 'test'), request and answers,
-- from a parent: exactly the message homework_ai_start hands hub-jobs. No run, nothing counted.
create function public.homework_ai_preview(p_assignment uuid, p_kind text default 'plan', p_request text default null,
                                           p_answers text[] default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('plan', 'revise', 'test') then
    raise exception 'Choose plan, revise or test.' using errcode = '22023';
  end if;
  if char_length(p_request) > 200 or cardinality(p_answers) > 3
     or exists (select 1 from unnest(p_answers) x where char_length(x) > 200) then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if p_kind <> 'test' and not exists (select 1 from public.assignments a where a.id = p_assignment) then
    raise exception 'That assignment is gone.' using errcode = '22023';
  end if;
  return private.ai_input(p_assignment, p_kind, p_request, p_answers, 'parent') ->> 'message';
end;
$$;

-- Erase a kid's homework (p_confirm 'ERASE'): his homework_kids row, and so everything that
-- cascades from it (assignments, steps, blocks, points, rewards, asks, tutor links, AI run records,
-- the homework-time links), and his and his links' counts. The homework-time events stay on the
-- calendar. Answers the counts.
create function public.erase_homework(p_kid uuid, p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_confirm is distinct from 'ERASE' then
    raise exception 'Type ERASE to erase.' using errcode = '22023';
  end if;
  r := jsonb_build_object(
    'assignments', (select count(*) from public.assignments a where a.kid_id = p_kid),
    'steps', (select count(*) from public.homework_steps s join public.assignments a on a.id = s.assignment_id where a.kid_id = p_kid),
    'sessions', (select count(*) from public.focus_sessions f where f.kid_id = p_kid),
    'points', (select count(*) from public.points_ledger l where l.kid_id = p_kid),
    'rewards', (select count(*) from public.rewards w where w.kid_id = p_kid),
    'asks', (select count(*) from public.reward_asks q where q.kid_id = p_kid),
    'links', (select count(*) from public.tutor_links l where l.kid_id = p_kid),
    'ai_runs', (select count(*) from public.ai_runs x where x.kid_id = p_kid),
    'times', (select count(*) from public.homework_times t where t.kid_id = p_kid));
  delete from public.homework_use u
  where u.actor_id = p_kid or u.actor_id in (select l.id from public.tutor_links l where l.kid_id = p_kid);
  delete from public.homework_kids k where k.kid_id = p_kid;
  return r;
end;
$$;

-- ---------------------------------------------------------------------
-- My day: Jordan (§3.5). His My day token is the key (private.homework_kid_by_token): an unknown,
-- malformed or replaced token, an inactive person, someone who isn't a kid, a kid whose homework
-- is off, and no token all get null. Text over its limit is refused (22023) before any work. A
-- writer that changed something counts it (private.count_homework: 150 writes and 20 Starts a
-- day), trims (private.homework_trim), writes as "<his name> (My day)", and answers what it did
-- with his view (private.homework_view_kid), so the page redraws without a second read. A resend
-- that finds its own earlier work changes nothing, isn't counted, and answers the view.
-- ---------------------------------------------------------------------

-- His view (§3.4).
create function public.homework_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.people;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  return private.homework_view_kid(me.id, me.language);
end;
$$;

-- One of his steps (private.step_act, as the kid): 'done', 'undo', 'not_today' (p_day: the step's day
-- as his screen showed it), 'ask' (p_text, at most 200), 'smaller' (p_text 3 to 80, p_key the new
-- step's id). A step of another kid, of a plan not given to him, or unknown: 42501 "That step isn't
-- on your plan.", the same for each.
create function public.step_by_token(p_token text, p_step uuid, p_action text, p_text text default null, p_day date default null,
                                     p_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.people;
  r  jsonb;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if char_length(p_text) > (case when p_action = 'smaller' then 80 else 200 end) then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.homework_steps s join public.assignments a on a.id = s.assignment_id
                 where s.id = p_step and a.kid_id = me.id and a.given_at is not null) then
    raise exception 'That step isn''t on your plan.' using errcode = '42501';
  end if;
  r := private.step_act(p_step, p_action, p_text, p_day, p_key, 'kid', private.short_name(me) || ' (My day)');
  if (r ->> '_changed')::boolean then
    perform private.count_homework(me.id, 'writes', 150);
  end if;
  perform private.homework_trim(me.id);
  return (r - '_changed') || private.homework_view_kid(me.id, me.language);
end;
$$;

-- His own plan saved (private.plan_save, as the kid, with his rules); p_steps null is Re-plan.
create function public.plan_by_token(p_token text, p_assignment uuid, p_steps jsonb, p_rev int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.people;
  r  jsonb;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if char_length(p_steps::text) > 20000 then
    raise exception 'That plan is too long.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.assignments a where a.id = p_assignment and a.kid_id = me.id) then
    raise exception 'That plan isn''t on your list.' using errcode = '42501';
  end if;
  r := private.plan_save(p_assignment, p_steps, false, p_rev, 'kid', private.short_name(me) || ' (My day)');
  perform private.count_homework(me.id, 'writes', 150);
  perform private.homework_trim(me.id);
  return (r - '_changed') || private.homework_view_kid(me.id, me.language);
end;
$$;

-- His focus blocks (private.focus_act): 'start' (counted as a Start), 'switch', 'end'.
create function public.focus_by_token(p_token text, p_action text, p_session uuid, p_minutes int default null, p_step uuid default null,
                                      p_assignment uuid default null, p_with text default null, p_result text default null,
                                      p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.people;
  r  jsonb;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if char_length(p_note) > 120 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  r := private.focus_act(me.id, p_action, p_session, p_minutes, p_step, p_assignment, p_with, p_result, p_note);
  if (r ->> '_changed')::boolean then
    if p_action = 'start' then
      perform private.count_homework(me.id, 'starts', 20);
    else
      perform private.count_homework(me.id, 'writes', 150);
    end if;
  end if;
  perform private.homework_trim(me.id);
  return (r - '_changed') || private.homework_view_kid(me.id, me.language);
end;
$$;

-- Rewards from his side (§8.5): 'ask' (p_reward, an active priced reward of his; p_key the ask's id;
-- what he has free, his balance less what his waiting asks hold, must cover it; at most 3 waiting;
-- the points are held), 'cancel' (his own waiting ask: p_key its id, or p_reward), 'suggest' (p_text,
-- 1 to 60; p_key the new reward's id; it arrives unpriced and off; at most 5 waiting). While points
-- are off: 42501 "Points are off.".
create function public.reward_by_token(p_token text, p_action text, p_reward uuid default null, p_text text default null,
                                       p_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me     public.people;
  v_k    public.homework_kids;
  v_r    public.rewards;
  v_q    public.reward_asks;
  v_bal  int;
  v_held int;
  v_text text;
  v_who  text;
  v_ch   boolean := false;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  v_who := private.short_name(me) || ' (My day)';
  if p_action is null or p_action not in ('ask', 'cancel', 'suggest') then
    raise exception 'Choose ask, cancel or suggest.' using errcode = '22023';
  end if;
  if char_length(p_text) > 60 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  select * into v_k from public.homework_kids k where k.kid_id = me.id for update;
  if not v_k.points_on then
    raise exception 'Points are off.' using errcode = '42501';
  end if;

  if p_action = 'ask' then
    if p_key is null then
      raise exception 'An ask needs its id.' using errcode = '22023';
    end if;
    select * into v_q from public.reward_asks q where q.id = p_key;
    if v_q.id is not null and v_q.kid_id <> me.id then
      raise exception 'That reward isn''t on your list.' using errcode = '42501';
    end if;
    if v_q.id is null then
      select * into v_r from public.rewards w where w.id = p_reward and w.kid_id = me.id and w.active and w.cost is not null;
      if v_r.id is null then
        raise exception 'That reward isn''t on your list.' using errcode = '42501';
      end if;
      if not exists (select 1 from public.reward_asks q where q.kid_id = me.id and q.reward_id = v_r.id and q.status = 'waiting') then
        if (select count(*) from public.reward_asks q where q.kid_id = me.id and q.status = 'waiting') >= 3 then
          raise exception 'Three asks are waiting already. Wait for a parent first.' using errcode = 'P0001';
        end if;
        select b.balance, b.held into v_bal, v_held from private.points_balance(me.id) b;
        if v_bal - v_held < v_r.cost then
          raise exception 'Not enough points yet.' using errcode = '42501';
        end if;
        insert into public.reward_asks (id, kid_id, reward_id, title, cost, status, asked_at)
        values (p_key, me.id, v_r.id, v_r.title, v_r.cost, 'waiting', private.now());
        v_ch := true;
      end if;
    end if;

  elsif p_action = 'cancel' then
    select * into v_q from public.reward_asks q
    where (p_key is not null and q.id = p_key) or (p_key is null and q.reward_id = p_reward and q.kid_id = me.id and q.status = 'waiting')
    order by q.asked_at desc limit 1
    for update;
    if v_q.id is null or v_q.kid_id <> me.id then
      raise exception 'That ask isn''t yours.' using errcode = '42501';
    end if;
    if v_q.status = 'waiting' then
      update public.reward_asks set status = 'cancelled', decided_at = private.now(), decided_by = v_who where id = v_q.id;
      v_ch := true;
    end if;

  else
    v_text := private.clean_text(p_text, 60);
    if v_text is null or char_length(v_text) not between 1 and 60 then
      raise exception 'Type the reward.' using errcode = '22023';
    end if;
    if p_key is null then
      raise exception 'A suggestion needs its id.' using errcode = '22023';
    end if;
    select * into v_r from public.rewards w where w.id = p_key;
    if v_r.id is not null and (v_r.kid_id <> me.id or not v_r.suggested) then
      raise exception 'That reward isn''t on your list.' using errcode = '42501';
    end if;
    if v_r.id is null then
      if (select count(*) from public.rewards w where w.kid_id = me.id and w.suggested and w.cost is null) >= 5 then
        raise exception 'Five suggestions are waiting already. Wait for a parent first.' using errcode = 'P0001';
      end if;
      insert into public.rewards (id, kid_id, title, cost, active, suggested, created_by, updated_by)
      values (p_key, me.id, v_text, null, false, true, v_who, v_who);
      v_ch := true;
    end if;
  end if;

  if v_ch then
    perform private.count_homework(me.id, 'writes', 150);
  end if;
  perform private.homework_trim(me.id);
  return private.homework_view_kid(me.id, me.language);
end;
$$;

-- His own homework (§4.1): 'add' (p_assignment the id his phone made; title 1 to 120, class at most
-- 40, a due date from today to today + 60; no teacher's text; added_by 'kid'; at most 15 open ones
-- he added; with p_minutes it also does 'quick'), 'quick' (on an open assignment of his with no plan,
-- due within 3 days: one plain step of p_minutes (5 to 60), titled as the assignment, placed by §5.4
-- and given at once; due 4 or more days out, or planned already: 42501 "Plan this one with Pat."),
-- 'drop' (only one he added, with no done step).
create function public.assignment_by_token(p_token text, p_action text, p_assignment uuid, p_title text default null,
                                           p_subject text default null, p_due_date date default null, p_minutes int default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me      public.people;
  v_a     public.assignments;
  v_today date := public.today_local();
  v_who   text;
  v_title text;
  v_place jsonb;
  v_ch    boolean := false;
  v_quick boolean := p_action = 'quick' or (p_action = 'add' and p_minutes is not null);
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  v_who := private.short_name(me) || ' (My day)';
  if p_action is null or p_action not in ('add', 'quick', 'drop') then
    raise exception 'Choose add, quick or drop.' using errcode = '22023';
  end if;
  if char_length(p_title) > 120 or char_length(p_subject) > 40 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if v_quick and (p_minutes is null or p_minutes not between 5 and 60) then
    raise exception 'A step is 5 to 60 minutes.' using errcode = '22023';
  end if;
  if p_assignment is null then
    raise exception 'Homework needs its id.' using errcode = '22023';
  end if;
  select * into v_a from public.assignments a where a.id = p_assignment for update;
  if v_a.id is not null and v_a.kid_id <> me.id then
    raise exception 'That assignment isn''t on your list.' using errcode = '42501';
  end if;

  if p_action = 'add' and v_a.id is null then
    if nullif(private.clean_text(p_title, 120), '') is null then
      raise exception 'Type what the homework is.' using errcode = '22023';
    end if;
    if p_due_date is null or p_due_date not between v_today and v_today + 60 then
      raise exception 'Choose a due date from today to 60 days ahead.' using errcode = '22023';
    end if;
    if (select count(*) from public.assignments a where a.kid_id = me.id and a.added_by = 'kid' and a.status = 'open') >= 15 then
      raise exception 'Fifteen of your own are open already.' using errcode = 'P0001';
    end if;
    insert into public.assignments (id, kid_id, kind, added_by, title, subject, due_date, created_by, updated_by)
    values (p_assignment, me.id, 'assignment', 'kid', p_title, p_subject, p_due_date, v_who, v_who)
    returning * into v_a;
    v_ch := true;
  elsif v_a.id is null then
    raise exception 'That assignment isn''t on your list.' using errcode = '42501';
  end if;

  if v_quick then
    if v_a.status = 'open' and v_a.given_by = v_who
       and (select count(*) from public.homework_steps s where s.assignment_id = v_a.id) = 1 then
      null;   -- his Quick, done already (a resend)
    elsif v_a.status <> 'open' or v_a.given_at is not null or v_a.due_date - v_today > 3
          or exists (select 1 from public.homework_steps s where s.assignment_id = v_a.id) then
      raise exception 'Plan this one with Pat.' using errcode = '42501';
    else
      v_title := case when char_length(v_a.title) >= 3 then left(v_a.title, 80)
                      else private.homework_word('homework', me.language) || ': ' || v_a.title end;
      v_place := private.place_steps(me.id, v_a.id, v_a.due_date,
                                     jsonb_build_array(jsonb_build_object('kind', 'step', 'minutes', p_minutes)));
      if v_place ? 'no_time' then
        raise exception 'Set a homework time first.' using errcode = '22023';
      end if;
      insert into public.homework_steps (assignment_id, pos, kind, title, minutes, day, source, updated_at, updated_by)
      values (v_a.id, 1, 'step', v_title, p_minutes, (v_place -> 'steps' -> 0 ->> 'day')::date, 'typed', private.now(), v_who);
      update public.assignments a
      set given_at = private.now(), given_by = v_who, plan_rev = a.plan_rev + 1, updated_by = v_who
      where a.id = v_a.id;
      v_ch := true;
    end if;
  elsif p_action = 'drop' then
    if v_a.added_by <> 'kid' or exists (select 1 from public.homework_steps s where s.assignment_id = v_a.id and s.done_at is not null) then
      raise exception 'Only homework you added, with nothing ticked, can be dropped.' using errcode = '42501';
    end if;
    if v_a.status <> 'dropped' then
      update public.assignments a set status = 'dropped', updated_by = v_who where a.id = v_a.id;
      v_ch := true;
    end if;
  end if;

  if v_ch then
    perform private.count_homework(me.id, 'writes', 150);
  end if;
  perform private.homework_trim(me.id);
  return jsonb_build_object('assignment_id', v_a.id) || private.homework_view_kid(me.id, me.language);
end;
$$;

-- His start cue (at most 120), his if-stuck line (at most 120) and his first length (10, 15, 20 or 25;
-- null keeps it). Null clears a line.
create function public.homework_prefs_by_token(p_token text, p_cue text, p_if_stuck text, p_minutes int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me  public.people;
  v_k public.homework_kids;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if char_length(p_cue) > 120 or char_length(p_if_stuck) > 120 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if p_minutes is not null and p_minutes not in (10, 15, 20, 25) then
    raise exception 'Choose 10, 15, 20 or 25 minutes.' using errcode = '22023';
  end if;
  select * into v_k from public.homework_kids k where k.kid_id = me.id for update;
  if v_k.cue is distinct from nullif(private.clean_text(p_cue, 120), '')
     or v_k.if_stuck is distinct from nullif(private.clean_text(p_if_stuck, 120), '')
     or v_k.focus_minutes <> coalesce(p_minutes, v_k.focus_minutes) then
    update public.homework_kids k
    set cue = p_cue, if_stuck = p_if_stuck, focus_minutes = coalesce(p_minutes, k.focus_minutes),
        updated_by = private.short_name(me) || ' (My day)'
    where k.kid_id = me.id;
    perform private.count_homework(me.id, 'writes', 150);
  end if;
  perform private.homework_trim(me.id);
  return private.homework_view_kid(me.id, me.language);
end;
$$;

-- ---------------------------------------------------------------------
-- The tutor link (§3.5). Its token is the key (private.tutor_link_by_token): an unknown, malformed
-- or replaced token, a link that is off or past its end date, or a kid whose homework is off or who
-- is no longer active: null. The writers count (private.count_homework: 200 writes a day, for the
-- link), trim, write as "<label> (tutor link)", and answer with the link's view.
-- ---------------------------------------------------------------------

-- The link's view (§3.4); p_part 'ai' answers only the assignment's AI state. Notes when the link
-- was last used, so it isn't STABLE.
create function public.tutor_view_by_token(p_token text, p_assignment uuid default null, p_part text default 'all')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.tutor_links;
begin
  l := private.tutor_link_by_token(p_token);
  if l.id is null then
    return null;
  end if;
  return private.homework_view_tutor(l.id, p_assignment, case when p_part = 'ai' then 'ai' else 'all' end);
end;
$$;

-- An assignment or lesson for the link's kid, added or changed. p_fields always has the id: one not
-- yet used adds it (added_by 'tutor'; a title and a due date needed), one of the kid's changes the
-- fields sent (kind, title, subject, due_date, details, stretch, status 'open', 'done' or 'dropped';
-- never a delete); any other: 42501 "That assignment isn't on this link.". Anything over its limit
-- (the teacher's text 4,000 characters): 22023 "That's too long." before any work. A moved due date
-- places again, at once, the steps not done that now fall after the last work day (moved: how many).
create function public.tutor_assignment_by_token(p_token text, p_fields jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l       public.tutor_links;
  v_a     public.assignments;
  v_n     public.assignments;
  v_id    uuid;
  v_who   text;
  v_due   date;
  v_place jsonb;
  v_moved int := 0;
  v_today date := public.today_local();
  v_last  date;
begin
  l := private.tutor_link_by_token(p_token);
  if l.id is null then
    return null;
  end if;
  v_who := l.label || ' (tutor link)';
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or coalesce(p_fields ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'An assignment needs its id.' using errcode = '22023';
  end if;
  if char_length(p_fields ->> 'title') > 120 or char_length(p_fields ->> 'subject') > 40
     or char_length(p_fields ->> 'details') > 4000 or char_length(p_fields ->> 'stretch') > 160 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if (p_fields ? 'kind' and coalesce(p_fields ->> 'kind', '') not in ('assignment', 'lesson'))
     or (p_fields ? 'status' and coalesce(p_fields ->> 'status', '') not in ('open', 'done', 'dropped')) then
    raise exception 'That isn''t a kind or status an assignment has.' using errcode = '22023';
  end if;
  if p_fields ? 'due_date' then
    v_due := private.safe_date(p_fields ->> 'due_date');
    if v_due is null then
      raise exception 'Choose a due date.' using errcode = '22023';
    end if;
  end if;
  v_id := (p_fields ->> 'id')::uuid;
  select * into v_a from public.assignments a where a.id = v_id for update;
  if v_a.id is not null and v_a.kid_id <> l.kid_id then
    raise exception 'That assignment isn''t on this link.' using errcode = '42501';
  end if;
  if v_a.id is null then
    if nullif(private.clean_text(p_fields ->> 'title', 120), '') is null or v_due is null then
      raise exception 'An assignment needs a title and a due date.' using errcode = '22023';
    end if;
    insert into public.assignments (id, kid_id, kind, added_by, title, subject, due_date, details, stretch, status, created_by, updated_by)
    values (v_id, l.kid_id, coalesce(p_fields ->> 'kind', 'assignment'), 'tutor', p_fields ->> 'title', p_fields ->> 'subject', v_due,
            p_fields ->> 'details', p_fields ->> 'stretch', coalesce(p_fields ->> 'status', 'open'), v_who, v_who);
  else
    update public.assignments a
    set kind = case when p_fields ? 'kind' then p_fields ->> 'kind' else a.kind end,
        title = case when p_fields ? 'title' then p_fields ->> 'title' else a.title end,
        subject = case when p_fields ? 'subject' then p_fields ->> 'subject' else a.subject end,
        due_date = coalesce(v_due, a.due_date),
        details = case when p_fields ? 'details' then p_fields ->> 'details' else a.details end,
        stretch = case when p_fields ? 'stretch' then p_fields ->> 'stretch' else a.stretch end,
        status = case when p_fields ? 'status' then p_fields ->> 'status' else a.status end,
        updated_by = v_who
    where a.id = v_id
      -- only when something changes (a resend changes nothing and isn't counted)
      and (a.kind, a.title, a.subject, a.due_date, a.details, a.stretch, a.status)
          is distinct from (case when p_fields ? 'kind' then p_fields ->> 'kind' else a.kind end,
                            case when p_fields ? 'title' then private.clean_text(p_fields ->> 'title', 120) else a.title end,
                            case when p_fields ? 'subject' then nullif(private.clean_text(p_fields ->> 'subject', 40), '') else a.subject end,
                            coalesce(v_due, a.due_date),
                            case when p_fields ? 'details' then nullif(private.clean_block(p_fields ->> 'details', 4000), '') else a.details end,
                            case when p_fields ? 'stretch' then nullif(private.clean_text(p_fields ->> 'stretch', 160), '') else a.stretch end,
                            case when p_fields ? 'status' then p_fields ->> 'status' else a.status end)
    returning * into v_n;
    -- A moved due date: the steps not done that now fall after the last work day are placed again.
    if v_n.id is not null and v_n.due_date is distinct from v_a.due_date and v_n.status = 'open' then
      v_last := case when v_n.kind = 'lesson' then greatest(v_n.due_date, v_today)
                     when v_n.due_date - v_today >= 7 then v_n.due_date - 2
                     when v_n.due_date > v_today then v_n.due_date - 1
                     else v_today end;
      if exists (select 1 from public.homework_steps s
                 where s.assignment_id = v_id and s.done_at is null and s.kind <> 'turn_in' and s.day > v_last) then
        v_place := private.place_steps(l.kid_id, v_id, v_n.due_date,
                     (select jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'minutes', s.minutes, 'done', s.done_at is not null,
                                                          'fixed', s.done_at is not null or (s.kind <> 'turn_in' and s.day <= v_last),
                                                          'day', case when s.done_at is not null or (s.kind <> 'turn_in' and s.day <= v_last)
                                                                      then s.day end)
                                       order by s.pos, s.id)
                      from public.homework_steps s where s.assignment_id = v_id));
        if not (v_place ? 'no_time') then
          with p as (
            select (x ->> 'id')::uuid as id, (x ->> 'day')::date as day from jsonb_array_elements(v_place -> 'steps') x
          )
          update public.homework_steps s set day = p.day, updated_at = private.now(), updated_by = v_who
          from p where s.id = p.id and s.done_at is null and s.day is distinct from p.day;
          get diagnostics v_moved = row_count;
          if v_moved > 0 then
            update public.assignments a set plan_rev = a.plan_rev + 1 where a.id = v_id;
          end if;
        end if;
      end if;
    end if;
  end if;
  if v_a.id is null or v_n.id is not null then
    perform private.count_homework(l.id, 'writes', 200);
  end if;
  perform private.homework_trim(l.kid_id);
  return jsonb_build_object('assignment_id', v_id, 'moved', v_moved) || private.homework_view_tutor(l.id, v_id, 'all');
end;
$$;

-- A plan saved from the link (private.plan_save, as the tutor); p_give puts it on his My day.
create function public.tutor_plan_by_token(p_token text, p_assignment uuid, p_steps jsonb, p_rev int, p_give boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.tutor_links;
  r jsonb;
begin
  l := private.tutor_link_by_token(p_token);
  if l.id is null then
    return null;
  end if;
  if char_length(p_steps::text) > 20000 then
    raise exception 'That plan is too long.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.assignments a where a.id = p_assignment and a.kid_id = l.kid_id) then
    raise exception 'That assignment isn''t on this link.' using errcode = '42501';
  end if;
  r := private.plan_save(p_assignment, p_steps, coalesce(p_give, false), p_rev, 'tutor', l.label || ' (tutor link)');
  perform private.count_homework(l.id, 'writes', 200);
  perform private.homework_trim(l.kid_id);
  return (r - '_changed') || private.homework_view_tutor(l.id, p_assignment, 'all');
end;
$$;

-- The tutor on one step (private.step_act, as the tutor): 'check' (an optional note), 'not_yet' (a
-- note), 'uncheck', 'answer' (its own answer can be changed for 15 minutes).
create function public.tutor_step_by_token(p_token text, p_step uuid, p_action text, p_text text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l     public.tutor_links;
  r     jsonb;
  v_aid uuid;
begin
  l := private.tutor_link_by_token(p_token);
  if l.id is null then
    return null;
  end if;
  if char_length(p_text) > (case when p_action = 'answer' then 200 else 160 end) then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  select s.assignment_id into v_aid
  from public.homework_steps s join public.assignments a on a.id = s.assignment_id
  where s.id = p_step and a.kid_id = l.kid_id;
  if v_aid is null then
    raise exception 'That step isn''t on this link.' using errcode = '42501';
  end if;
  r := private.step_act(p_step, p_action, p_text, null, null, 'tutor', l.label || ' (tutor link)');
  if (r ->> '_changed')::boolean then
    perform private.count_homework(l.id, 'writes', 200);
  end if;
  perform private.homework_trim(l.kid_id);
  -- A check's paid is points, which the link never sees; used_up stays ("This week's milestone points
  -- are used up.").
  return (r - '_changed' - 'paid') || private.homework_view_tutor(l.id, v_aid, 'all');
end;
$$;

-- ---------------------------------------------------------------------
-- hub-jobs: the AI planner's SQL side (§6.3, §6.8). Nothing calls these until PR B.
-- ---------------------------------------------------------------------

-- Before a request to Claude. Who comes first, without a lock, so a caller with a made-up token
-- can't hold the household row: p_token (the tutor link's, through private.tutor_link_by_token, with
-- can_ai on and an assignment of its kid) or p_email (an admin member), never both; 'test' is for
-- p_email only. Anyone else, or an assignment that isn't theirs: {stop: 'not_found'}, the same for
-- each. Then, with the household row locked:
--   1. private.ai_sweep();
--   2. a run with this key: {run_id} when it has the same asker, kind and assignment (a resend
--      starts nothing and counts nothing), else not_found;
--   3. household.homework_ai off: {stop: 'off'}, except 'test'; the kid's homework off: not_found;
--   4. a run for this assignment still inside its lease: {stop: 'busy', run_id};
--   5. caps, from ai_runs (test runs count too): 12 a household day, 10 a day for this link, 8 for
--      this assignment ever ('cap'); household.homework_ai_month this calendar month ('month');
--   6. homework_trim, the run (its lease 6 minutes), the assignment's ai_state 'running':
--      {run_id, input: private.ai_input(…)}.
create function public.homework_ai_start(p_token text, p_email text, p_assignment uuid, p_kind text, p_request text,
                                         p_answers text[], p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l     public.tutor_links;
  v_a     public.assignments;
  v_r     public.ai_runs;
  v_h     public.household;
  v_now   timestamptz := private.now();
  v_tz    text := private.tz();
  v_today date := public.today_local();
  v_who   text;
  v_from  text;
  v_id    uuid;
begin
  if p_kind is null or p_kind not in ('plan', 'revise', 'test') or p_key is null then
    raise exception 'A request needs a kind (plan, revise or test) and a key.' using errcode = '22023';
  end if;
  if char_length(p_request) > 200 or cardinality(p_answers) > 3
     or exists (select 1 from unnest(p_answers) x where char_length(x) > 200) then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  -- Who, before any lock.
  if p_token is not null and p_email is null then
    v_l := private.tutor_link_by_token(p_token);
    if v_l.id is null or not v_l.can_ai or p_kind = 'test' then
      return jsonb_build_object('stop', 'not_found');
    end if;
    select * into v_a from public.assignments a where a.id = p_assignment and a.kid_id = v_l.kid_id;
    if v_a.id is null then
      return jsonb_build_object('stop', 'not_found');
    end if;
    v_who := v_l.label || ' (tutor link)';
    v_from := 'tutor';
  elsif p_email is not null and p_token is null
        and exists (select 1 from public.members m where m.email = lower(p_email) and m.role = 'admin') then
    if p_kind <> 'test' then
      select * into v_a from public.assignments a where a.id = p_assignment;
      if v_a.id is null then
        return jsonb_build_object('stop', 'not_found');
      end if;
    end if;
    v_who := lower(p_email);
    v_from := 'parent';
  else
    return jsonb_build_object('stop', 'not_found');
  end if;

  select * into v_h from public.household h for update;
  perform private.ai_sweep();
  select * into v_r from public.ai_runs r where r.key = p_key;
  if v_r.id is not null then
    if v_r.asked_by = v_who and v_r.kind = p_kind and v_r.assignment_id is not distinct from v_a.id then
      return jsonb_build_object('run_id', v_r.id);
    end if;
    return jsonb_build_object('stop', 'not_found');
  end if;
  if p_kind <> 'test' then
    if not v_h.homework_ai then
      return jsonb_build_object('stop', 'off');
    end if;
    if not exists (select 1 from public.homework_kids k where k.kid_id = v_a.kid_id and k.active) then
      return jsonb_build_object('stop', 'not_found');
    end if;
    select * into v_r from public.ai_runs r
    where r.assignment_id = v_a.id and r.status = 'running' and r.lease_until > v_now
    order by r.started_at desc limit 1;
    if v_r.id is not null then
      return jsonb_build_object('stop', 'busy', 'run_id', v_r.id);
    end if;
  end if;
  if (select count(*) from public.ai_runs r where (r.started_at at time zone v_tz)::date = v_today) >= 12
     or (v_l.id is not null
         and (select count(*) from public.ai_runs r where r.link_id = v_l.id and (r.started_at at time zone v_tz)::date = v_today) >= 10)
     or (v_a.id is not null and (select count(*) from public.ai_runs r where r.assignment_id = v_a.id) >= 8) then
    return jsonb_build_object('stop', 'cap');
  end if;
  if (select count(*) from public.ai_runs r
      where date_trunc('month', r.started_at at time zone v_tz) = date_trunc('month', v_now at time zone v_tz)) >= v_h.homework_ai_month then
    return jsonb_build_object('stop', 'month');
  end if;
  if v_a.id is not null then
    perform private.homework_trim(v_a.kid_id);
  end if;
  insert into public.ai_runs (kid_id, assignment_id, link_id, kind, asked_by, key, status, started_at, lease_until)
  values (v_a.kid_id, v_a.id, v_l.id, p_kind, v_who, p_key, 'running', v_now, v_now + interval '6 minutes')
  returning id into v_id;
  if v_a.id is not null then
    update public.assignments a set ai_state = 'running', ai_stop = null where a.id = v_a.id;
  end if;
  return jsonb_build_object('run_id', v_id,
                            'input', private.ai_input(v_a.id, p_kind, p_request, p_answers, v_from));
end;
$$;

-- After Claude answered (or didn't). Only a run still running inside its lease; otherwise nothing
-- changes and the answer is {stop: 'late'} (the sweep has closed it).
--   • p_stop set: the run failed with that code (a fixed code: anything else is 'error'); the
--     assignment's ai_state 'failed' and ai_stop the code. An existing draft stays.
--   • a 'test' run: ready, with its usage; nothing else is stored.
--   • a draft: checked again in SQL (§6.8: private.plan_check's AI rules; for an assignment exactly one
--     turn-in; summary 1 to 300, at most 3 questions of 1 to 160, stretch at most 160, note_for_adult at
--     most 300); a draft that fails is 'invalid' and nothing is stored. Minutes are clamped to his
--     session length; the steps are placed (private.place_steps); a ref of a step of the saved plan
--     carries its id. The old draft moves to ai_prev, the new one (steps, summary, questions, stretch,
--     fits, over, horizon, note_for_adult, model, at) to ai_draft; ai_state 'ready'.
-- p_usage: {input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens, cents}.
create function public.homework_ai_finish(p_run uuid, p_stop text, p_draft jsonb, p_usage jsonb, p_model text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r     public.ai_runs;
  v_a     public.assignments;
  v_k     public.homework_kids;
  v_now   timestamptz := private.now();
  v_stop  text;
  v_steps jsonb;
  v_place jsonb;
  v_draft jsonb;
  v_ids   jsonb;
  v_usage jsonb := coalesce(p_usage, '{}');
  v_model text := nullif(private.clean_text(p_model, 80), '');
begin
  select * into v_r from public.ai_runs r where r.id = p_run for update;
  if v_r.id is null or v_r.status <> 'running' or v_r.lease_until < v_now then
    return jsonb_build_object('stop', 'late');
  end if;
  select * into v_a from public.assignments a where a.id = v_r.assignment_id for update;
  select * into v_k from public.homework_kids k where k.kid_id = v_a.kid_id;
  v_stop := case when p_stop is null then null when p_stop ~ '^[a-z_]{1,40}$' then p_stop else 'error' end;

  if v_stop is null and v_r.kind <> 'test' then
    begin
      if jsonb_typeof(p_draft) <> 'object' or jsonb_typeof(p_draft -> 'steps') <> 'array'
         or jsonb_typeof(p_draft -> 'questions') <> 'array' or jsonb_typeof(p_draft -> 'fits') <> 'boolean'
         or coalesce(char_length(p_draft ->> 'summary'), 0) not between 1 and 300
         or jsonb_array_length(p_draft -> 'questions') > 3
         or exists (select 1 from jsonb_array_elements(p_draft -> 'questions') q
                    where jsonb_typeof(q) <> 'string' or char_length(q #>> '{}') not between 1 and 160)
         or char_length(p_draft ->> 'stretch') > 160 or char_length(p_draft ->> 'note_for_adult') > 300 then
        raise exception 'invalid' using errcode = '22023';
      end if;
      v_steps := private.plan_check(p_draft -> 'steps', v_a.due_date, true);
      if v_a.kind = 'assignment'
         and (select count(*) from jsonb_array_elements(v_steps) x where x ->> 'kind' = 'turn_in') <> 1 then
        raise exception 'invalid' using errcode = '22023';
      end if;
    exception when sqlstate '22023' then
      v_stop := 'invalid';
    end;
  end if;

  if v_stop is not null then
    update public.ai_runs
    set status = 'failed', stop = v_stop, finished_at = v_now, model = v_model,
        input_tokens = (v_usage ->> 'input_tokens')::int, cache_read_tokens = (v_usage ->> 'cache_read_input_tokens')::int,
        cache_write_tokens = (v_usage ->> 'cache_creation_input_tokens')::int, output_tokens = (v_usage ->> 'output_tokens')::int,
        cents = (v_usage ->> 'cents')::numeric
    where id = v_r.id;
    if v_a.id is not null then
      update public.assignments a set ai_state = 'failed', ai_stop = v_stop
      where a.id = v_a.id
        and not exists (select 1 from public.ai_runs x where x.assignment_id = a.id and x.id <> v_r.id
                        and x.status = 'running' and x.lease_until >= v_now);
    end if;
    return jsonb_build_object('ok', true, 'state', 'failed', 'stop', v_stop);
  end if;

  update public.ai_runs
  set status = 'ready', finished_at = v_now, model = v_model,
      input_tokens = (v_usage ->> 'input_tokens')::int, cache_read_tokens = (v_usage ->> 'cache_read_input_tokens')::int,
      cache_write_tokens = (v_usage ->> 'cache_creation_input_tokens')::int, output_tokens = (v_usage ->> 'output_tokens')::int,
      cents = (v_usage ->> 'cents')::numeric
  where id = v_r.id;
  if v_r.kind = 'test' or v_a.id is null then
    return jsonb_build_object('ok', true, 'state', 'ready');
  end if;

  -- Minutes to his session length; refs of the saved plan's steps (as private.ai_input numbered
  -- them: the steps not done, in order) carry their ids; the draft placed.
  select jsonb_object_agg('s' || x.n, x.id) into v_ids
  from (select s.id, row_number() over (order by s.pos, s.id) as n
        from public.homework_steps s where s.assignment_id = v_a.id and s.done_at is null) x;
  select jsonb_agg(x || jsonb_build_object(
           'minutes', case when x ->> 'kind' in ('turn_in', 'start') then (x ->> 'minutes')::int
                           else least((x ->> 'minutes')::int, coalesce(v_k.focus_minutes, 60)) end,
           'id', v_ids -> (x ->> 'ref'), 'source', 'ai')
         order by n)
  into v_steps
  from jsonb_array_elements(v_steps) with ordinality t (x, n);
  v_place := private.place_steps(v_a.kid_id, v_a.id, v_a.due_date, v_steps);
  v_draft := jsonb_build_object(
    'steps', coalesce(v_place -> 'steps', v_steps),
    'summary', private.clean_text(p_draft ->> 'summary', 300),
    'questions', (select coalesce(jsonb_agg(private.clean_text(q #>> '{}', 160) order by n), '[]')
                  from jsonb_array_elements(p_draft -> 'questions') with ordinality t (q, n)),
    'stretch', nullif(private.clean_text(p_draft ->> 'stretch', 160), ''),
    'fits', (p_draft ->> 'fits')::boolean and coalesce((v_place ->> 'fits')::boolean, false),
    'over', coalesce((v_place ->> 'over')::int, 0),
    'horizon', v_place -> 'horizon',
    'no_time', v_place ? 'no_time',
    'note_for_adult', nullif(private.clean_text(p_draft ->> 'note_for_adult', 300), ''),
    'model', v_model,
    'at', v_now);
  update public.assignments a
  set ai_prev = a.ai_draft, ai_draft = v_draft, ai_at = v_now, ai_state = 'ready', ai_stop = null
  where a.id = v_a.id;
  return jsonb_build_object('ok', true, 'state', 'ready');
end;
$$;

-- ---------------------------------------------------------------------
-- Replaced: My day (same signature as 0004)
-- ---------------------------------------------------------------------

-- Today and tomorrow for the person with this token, or null.
-- As in 0004, plus one key that is left out unless the person is a kid with an active
-- homework_kids row (so with homework off for everyone it is exactly 0004's answer):
--   • homework: the card (private.homework_card): the next step, today's steps and minutes,
--     his homework time, a block running, his points.
create or replace function public.get_person_day(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me    public.people;
  today date := public.today_local();
  v_mode text;   -- v1.2
  v_card jsonb;  -- v1.3
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  select h.helper_list into v_mode from public.household h;   -- v1.2
  -- v1.3: the homework card, for a kid with homework on.
  if me.role = 'kid' and exists (select 1 from public.homework_kids k where k.kid_id = me.id and k.active) then
    v_card := private.homework_card(me.id, me.language);
  end if;

  return jsonb_build_object(
    'person', jsonb_build_object('name', me.name, 'language', me.language,
                                 'digest_enabled', me.digest_enabled,
                                 'email_confirmed', me.email_verified_at is not null),
    'today', today,
    'days', (select jsonb_agg(jsonb_build_object(
                      'day', d.day,
                      'items', coalesce((select jsonb_agg(private.my_day_item(a, me.id, me.language)
                                                          order by private.item_order(a), a.local_start, a.title)
                                         from private.person_items(me.id, d.day) a), '[]'))
                      -- v1.2: the day's meals, left out when there are none.
                      || coalesce((select jsonb_build_object('meals', jsonb_agg(
                                            jsonb_build_object(
                                              'slot', m.slot,
                                              'label', private.food_word(m.slot, me.language),
                                              'title', case when m.private and not x.mine then private.word('private_item', me.language)
                                                            else private.meal_title(m, me.language) end,
                                              'cook', case when c.id is not null then private.short_name(c) end,
                                              'cook_word', case when c.id is null then null
                                                                when x.mine then private.food_word(case when m.kind = 'cook' then 'you_cook'
                                                                                                        else 'you_on_dinner' end, me.language)
                                                                else replace(private.food_word(case when m.kind = 'cook' then 'cooks'
                                                                                                    else 'on_dinner' end, me.language),
                                                                             '{name}', private.short_name(c)) end,
                                              'mine', x.mine)
                                            || case when x.mine then jsonb_strip_nulls(jsonb_build_object('note', m.note, 'link', m.link))
                                                    else '{}' end
                                            order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id))
                                   from public.meals m
                                   left join public.people c on c.id = m.cook_id and c.active
                                   cross join lateral (select coalesce(c.id = me.id, false) as mine) x
                                   where m.day = d.day
                                   having count(*) > 0), '{}')
                    order by d.day)
             from (values (today), (today + 1)) d (day)),
    'late', coalesce((select jsonb_agg(private.my_day_item(i, me.id, me.language) order by cd.due, t.title)
                      from public.tasks t
                      cross join lateral (select private.current_due(t) as due) cd
                      cross join lateral private.task_item(t, cd.due, 'late') i
                      where t.responsible_id = me.id and t.active and t.done_at is null and cd.due < today),
                     '[]'))
    -- v1.2: the list button, for a helper while the list is on her My day, once anyone has
    -- added the first item (so the same-output check is unchanged).
    || case when me.role = 'helper' and coalesce(v_mode, 'off') <> 'off' and exists (select 1 from public.shopping_items)
            then jsonb_build_object('list', jsonb_build_object(
                   'to_buy', (select count(*) from public.shopping_items i where i.bought_at is null and not i.private)))
            else '{}' end
    -- v1.3: the homework card, left out unless homework is on for this kid.
    || case when v_card is not null then jsonb_build_object('homework', v_card) else '{}' end;
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The v1.3 client shows Homework, and asks for anything of it, only on 5.
-- (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 5;
$$;

-- ---------------------------------------------------------------------
-- Function permissions (§3.6)
-- New functions, public and private: revoke from public and anon (and whoever else mustn't call
-- them), then grant to who calls them. Replaced functions keep their grants.
-- ---------------------------------------------------------------------

-- Page read (row-level security decides).
revoke execute on function public.homework_week(uuid, date, int)                                       from public, anon;
grant  execute on function public.homework_week(uuid, date, int)                                       to authenticated;

-- Signed-in actions (each checks admin first).
revoke execute on function public.save_homework_kid(uuid, boolean)                                     from public, anon, service_role;
revoke execute on function public.add_homework_time(uuid, int[], time, time)                           from public, anon, service_role;
revoke execute on function public.save_homework_plan(uuid, jsonb, int, boolean)                        from public, anon, service_role;
revoke execute on function public.homework_step(uuid, text, text)                                      from public, anon, service_role;
revoke execute on function public.decide_reward(uuid, boolean, text)                                   from public, anon, service_role;
revoke execute on function public.give_points(uuid, int, text, uuid)                                   from public, anon, service_role;
revoke execute on function public.void_points(uuid, text)                                              from public, anon, service_role;
revoke execute on function public.save_tutor_link(uuid, uuid, text, text, date, boolean, boolean)      from public, anon, service_role;
revoke execute on function public.new_tutor_token(uuid)                                                from public, anon, service_role;
revoke execute on function public.homework_ai_preview(uuid, text, text, text[])                        from public, anon, service_role;
revoke execute on function public.erase_homework(uuid, text)                                           from public, anon, service_role;
grant  execute on function public.save_homework_kid(uuid, boolean)                                     to authenticated;
grant  execute on function public.add_homework_time(uuid, int[], time, time)                           to authenticated;
grant  execute on function public.save_homework_plan(uuid, jsonb, int, boolean)                        to authenticated;
grant  execute on function public.homework_step(uuid, text, text)                                      to authenticated;
grant  execute on function public.decide_reward(uuid, boolean, text)                                   to authenticated;
grant  execute on function public.give_points(uuid, int, text, uuid)                                   to authenticated;
grant  execute on function public.void_points(uuid, text)                                              to authenticated;
grant  execute on function public.save_tutor_link(uuid, uuid, text, text, date, boolean, boolean)      to authenticated;
grant  execute on function public.new_tutor_token(uuid)                                                to authenticated;
grant  execute on function public.homework_ai_preview(uuid, text, text, text[])                        to authenticated;
grant  execute on function public.erase_homework(uuid, text)                                           to authenticated;

-- My day, Jordan: his token is the key.
revoke execute on function public.homework_by_token(text)                                              from public, service_role;
revoke execute on function public.step_by_token(text, uuid, text, text, date, uuid)                    from public, service_role;
revoke execute on function public.plan_by_token(text, uuid, jsonb, int)                                from public, service_role;
revoke execute on function public.focus_by_token(text, text, uuid, int, uuid, uuid, text, text, text)  from public, service_role;
revoke execute on function public.reward_by_token(text, text, uuid, text, uuid)                        from public, service_role;
revoke execute on function public.assignment_by_token(text, text, uuid, text, text, date, int)         from public, service_role;
revoke execute on function public.homework_prefs_by_token(text, text, text, int)                       from public, service_role;
grant  execute on function public.homework_by_token(text)                                              to anon, authenticated;
grant  execute on function public.step_by_token(text, uuid, text, text, date, uuid)                    to anon, authenticated;
grant  execute on function public.plan_by_token(text, uuid, jsonb, int)                                to anon, authenticated;
grant  execute on function public.focus_by_token(text, text, uuid, int, uuid, uuid, text, text, text)  to anon, authenticated;
grant  execute on function public.reward_by_token(text, text, uuid, text, uuid)                        to anon, authenticated;
grant  execute on function public.assignment_by_token(text, text, uuid, text, text, date, int)         to anon, authenticated;
grant  execute on function public.homework_prefs_by_token(text, text, text, int)                       to anon, authenticated;

-- The tutor link: its token is the key.
revoke execute on function public.tutor_view_by_token(text, uuid, text)                                from public, service_role;
revoke execute on function public.tutor_assignment_by_token(text, jsonb)                               from public, service_role;
revoke execute on function public.tutor_plan_by_token(text, uuid, jsonb, int, boolean)                 from public, service_role;
revoke execute on function public.tutor_step_by_token(text, uuid, text, text)                          from public, service_role;
grant  execute on function public.tutor_view_by_token(text, uuid, text)                                to anon, authenticated;
grant  execute on function public.tutor_assignment_by_token(text, jsonb)                               to anon, authenticated;
grant  execute on function public.tutor_plan_by_token(text, uuid, jsonb, int, boolean)                 to anon, authenticated;
grant  execute on function public.tutor_step_by_token(text, uuid, text, text)                          to anon, authenticated;

-- hub-jobs (PR B): service_role only.
revoke execute on function public.homework_ai_start(text, text, uuid, text, text, text[], uuid)        from public, anon, authenticated;
revoke execute on function public.homework_ai_finish(uuid, text, jsonb, jsonb, text)                   from public, anon, authenticated;
grant  execute on function public.homework_ai_start(text, text, uuid, text, text, text[], uuid)        to service_role;
grant  execute on function public.homework_ai_finish(uuid, text, jsonb, jsonb, text)                   to service_role;

-- Helpers in private: none for anon. The ones that act for someone else, or read what a member
-- mustn't (tutor links' tokens, the AI's input), are for nobody but the definer functions above.
-- homework_week runs as the member (free_minutes; service_role keeps homework_week's default grant, so
-- free_minutes is its too), and the tidy triggers as the parent who saves (clean_block, homework_word
-- through add_homework_time): so those are granted to authenticated.
revoke execute on function private.homework_word(text, text)                                           from public, anon;
revoke execute on function private.clean_block(text, int)                                              from public, anon;
revoke execute on function private.homework_kids_tidy()                                                from public, anon;
revoke execute on function private.assignments_tidy()                                                  from public, anon;
revoke execute on function private.rewards_tidy()                                                      from public, anon;
revoke execute on function private.tutor_links_tidy()                                                  from public, anon;
revoke execute on function private.household_homework_check()                                         from public, anon;
revoke execute on function private.free_minutes(uuid, date, date, uuid)                                from public, anon;
revoke execute on function private.homework_kid_by_token(text)                                         from public, anon, authenticated;
revoke execute on function private.tutor_link_by_token(text)                                           from public, anon, authenticated;
revoke execute on function private.count_homework(uuid, text, int)                                     from public, anon, authenticated;
revoke execute on function private.place_steps(uuid, uuid, date, jsonb)                                from public, anon, authenticated;
revoke execute on function private.plan_check(jsonb, date, boolean)                                    from public, anon, authenticated;
revoke execute on function private.plan_save(uuid, jsonb, boolean, int, text, text)                    from public, anon, authenticated;
revoke execute on function private.step_act(uuid, text, text, date, uuid, text, text)                  from public, anon, authenticated;
revoke execute on function private.award(uuid, text, int, date, uuid, uuid, uuid, uuid, text, text)    from public, anon, authenticated;
revoke execute on function private.points_balance(uuid)                                                from public, anon, authenticated;
revoke execute on function private.homework_pace(uuid)                                                 from public, anon, authenticated;
revoke execute on function private.focus_act(uuid, text, uuid, int, uuid, uuid, text, text, text)      from public, anon, authenticated;
revoke execute on function private.ai_sweep()                                                          from public, anon, authenticated;
revoke execute on function private.homework_trim(uuid)                                                 from public, anon, authenticated;
revoke execute on function private.homework_view_kid(uuid, text)                                       from public, anon, authenticated;
revoke execute on function private.homework_card(uuid, text)                                           from public, anon, authenticated;
revoke execute on function private.homework_view_tutor(uuid, uuid, text)                               from public, anon, authenticated;
revoke execute on function private.scrub(text, uuid)                                                   from public, anon, authenticated;
revoke execute on function private.ai_input(uuid, text, text, text[], text)                            from public, anon, authenticated;
grant  execute on function private.homework_word(text, text)                                           to authenticated, service_role;
grant  execute on function private.clean_block(text, int)                                              to authenticated, service_role;
grant  execute on function private.free_minutes(uuid, date, date, uuid)                                to authenticated, service_role;

commit;
