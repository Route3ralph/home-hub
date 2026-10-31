-- =====================================================================
-- HOME HUB v1.3 — migration 0006: the school feed (the school's Blackbaud calendar links)
-- Apply once, after 0005, and only once the site and hub-jobs that understand it are live
-- (docs/v1.3-homework.md §16.4). The contract is docs/v1.3-homework.md §11 and §12.
--
-- What it adds
--   • Tables: school_feeds (a kid's school calendar link, Assignments, Schedule or Games/Practices:
--     its settings and status, never its address) and school_items (what the links hold that the hub
--     uses: assignments, and schedule and games as busy time); in private, school_feed_urls (the
--     addresses, which work like passwords) and school_sync (the read job's lease).
--     assignments.added_by gains 'school' (an assignment made from a school item).
--   • Pages (parents; Sam reads the status): set_school_feed (Add link, Replace, Remove),
--     check_school_feed (the first-import check), pause_school_feed, school_item_action (Add to
--     homework, Hide, Show) and school_feed_status (the status card).
--   • My day: school_item_by_token (his New from school: Quick, Plan with Pat, Hide). Twenty token
--     functions for anon in all.
--   • hub-jobs (its school action, supabase/functions/hub-jobs/school.ts): school_begin (the lease, and
--     the only reader of the addresses), school_store, school_finish.
--   • Replaced, with the same signatures: free_minutes (his schedule and games are busy time),
--     homework_card (a count of what is new from school) and hub_schema_version() (6). Wrapped:
--     homework_view_kid and homework_view_tutor; 0005's bodies are renamed homework_view_kid_v5 and
--     homework_view_tutor_v5 and are not changed. The wrappers add the school's marks to an
--     assignment made from school, and his view New from school once an Assignments link is checked.
--     A later change to a wrapped function replaces the wrapper and its _v5 body together.
--
-- Rules
--   • One transaction. It refuses to run without 0005, twice, or on a database that isn't as 0005
--     left it.
--   • Additive: with no school link every page, view, email and text is as on 5 (tests/db/run.sh 5d).
--   • RLS on every table. No rows are seeded. Nothing here returns or logs a link's address: only
--     school_begin (security definer, service_role only) reads private.school_feed_urls, and no API
--     role (anon, authenticated, service_role) has any privilege on it.
--   • Every time the functions write is private.now().
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0005 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 5 then
    raise exception 'Homework (migration 0005) isn''t installed (hub_schema_version() is %). Run 0005_homework.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 6 then
    raise exception 'The school feed (migration 0006) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  -- A database set back as docs/v1.3-homework.md §16.5 says: before the shape check, so it gets the right message.
  if to_regclass('public.school_feeds') is not null then
    raise exception 'The school feed (migration 0006) is already installed, but hub_schema_version() was set back to 5. To switch it on again, make hub_schema_version() return 6 (docs/v1.3-homework.md §16.5). Nothing was changed.';
  end if;
  -- What this migration replaces, wraps and reads is as 0005 left it.
  if to_regprocedure('private.free_minutes(uuid, date, date, uuid)') is null
     or to_regprocedure('private.homework_view_kid(uuid, text)') is null
     or to_regprocedure('private.homework_view_tutor(uuid, uuid, text)') is null
     or to_regprocedure('private.homework_card(uuid, text)') is null
     or to_regprocedure('public.assignment_by_token(text, text, uuid, text, text, date, int)') is null
     or to_regprocedure('private.homework_view_kid_v5(uuid, text)') is not null
     or not exists (select 1 from pg_constraint where conrelid = 'public.assignments'::regclass and conname = 'assignments_added_by_check') then
    raise exception 'This database isn''t as migration 0005 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables (§12)
-- ---------------------------------------------------------------------

-- A kid's school calendar link (Assignments, Schedule or Games/Practices): its settings and status.
-- The address itself is in private.school_feed_urls. Written only through the functions below.
create table public.school_feeds (
  id           uuid primary key default gen_random_uuid(),
  kid_id       uuid not null references public.homework_kids (kid_id) on delete cascade,
  kind         text not null check (kind in ('assignments', 'schedule', 'games')),
  host         text not null check (char_length(host) between 1 and 253),   -- "<school>.myschoolapp.com", for the status line
  url_end      text not null check (char_length(url_end) = 4),               -- the address's last 4 characters: "…a1b2"
  date_rule    text not null default 'end' check (date_rule in ('start', 'end')),   -- an item's due date: its first or last day
  date_shift   int not null default 0 check (date_shift between -1 and 1),          -- … moved this many days
  checked      boolean not null default false,  -- a parent answered the first-import check (Assignments only)
  paused       boolean not null default false,  -- not read; its items stay
  next_at      timestamptz,                     -- read when this has passed (now, for a new or replaced link)
  last_try_at  timestamptz,
  last_ok_at   timestamptz,
  last_count   int,                             -- items the last good read kept
  last_repeats int,                             -- repeating events (RRULE or RDATE) the last good read saw and didn't expand
  last_stop    text check (last_stop in ('bad_link', 'redirect', 'unreachable', 'timeout', 'too_big', 'refused', 'gone',
                                         'down', 'http', 'sign_in', 'not_calendar', 'empty', 'too_many', 'error')),
                                                -- the last read's fixed code; null when it went well
  fails        int not null default 0,          -- failed reads in a row (the backoff)
  created_at   timestamptz not null default now(),
  created_by   text,
  updated_at   timestamptz not null default now(),
  updated_by   text,
  unique (kid_id, kind)
);

-- What the links hold that the hub uses. An Assignments item becomes an assignment (added_by 'school')
-- when he taps Quick or Plan with Pat, or a parent taps Add; Schedule and Games items are busy time.
create table public.school_items (
  id            uuid primary key default gen_random_uuid(),
  feed_id       uuid not null references public.school_feeds (id) on delete cascade,
  key           text not null check (key ~ '^[0-9a-f]{32}$'),
                -- md5 of 'uid:' and its UID (with its start, for schedule and games), or of 'title:', its title
                -- and its first day (its start) without one
  has_uid       boolean not null,
  title         text not null check (char_length(title) between 1 and 120),
  subject       text check (subject is null or char_length(subject) between 1 and 40),         -- the class, when the title names it
  details       text check (details is null or char_length(details) between 1 and 4000),      -- an assignment's description, as the school wrote it
  first_day     date,                           -- an assignment's days (an all-day end is moved back a day)
  last_day      date,
  due_date      date,                           -- first_day or last_day (the link's date_rule) + date_shift
  starts_at     timestamptz,                    -- schedule and games
  ends_at       timestamptz,
  assignment_id uuid references public.assignments (id) on delete set null,   -- the assignment made from it
  made_at       timestamptz,                    -- when it was made one: it is never new again
  applied       jsonb,                          -- what the feed last wrote into that assignment: {title, subject, due_date, details}
  hidden        boolean not null default false, -- he hid it (a parent can show it again)
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,
  missing       int not null default 0,         -- good, non-empty reads in a row it was absent from (inside the window)
  gone_at       timestamptz,                    -- absent from two: no longer on the school site (marked, never deleted)
  unique (feed_id, key),
  check ((due_date is null) <> (starts_at is null)),
  check ((due_date is null) = (first_day is null) and (first_day is null) = (last_day is null)),
  check (last_day is null or last_day >= first_day),
  check (ends_at is null or ends_at >= starts_at),
  check ((made_at is null) = (applied is null))
);
create index school_items_feed_due on public.school_items (feed_id, due_date);
create index school_items_feed_start on public.school_items (feed_id, starts_at);
create index school_items_assignment on public.school_items (assignment_id);

-- The addresses: passwords, in effect. Only public.school_begin reads them.
create table private.school_feed_urls (
  feed_id uuid primary key references public.school_feeds (id) on delete cascade,
  url     text not null check (char_length(url) between 20 and 500)
);

-- The read job's lease: one row.
create table private.school_sync (
  id          boolean primary key default true check (id),
  run_id      uuid,
  lease_until timestamptz,
  last_run_at timestamptz
);

-- An assignment made from a school item says so.
alter table public.assignments drop constraint assignments_added_by_check;
alter table public.assignments add constraint assignments_added_by_check check (added_by in ('family', 'tutor', 'kid', 'school'));

-- The settings are stamped; the job's status columns aren't (a read never changes updated_at).
create trigger school_feeds_stamp before insert on public.school_feeds
  for each row execute function private.stamp();
create trigger school_feeds_stamp_change before update on public.school_feeds
  for each row when ((to_jsonb(old) - '{next_at,last_try_at,last_ok_at,last_count,last_repeats,last_stop,fails}'::text[])
                     is distinct from (to_jsonb(new) - '{next_at,last_try_at,last_ok_at,last_count,last_repeats,last_stop,fails}'::text[]))
  execute function private.stamp();

-- ---------------------------------------------------------------------
-- Row-level security and grants (§12)
-- ---------------------------------------------------------------------
alter table public.school_feeds      enable row level security;
alter table public.school_items      enable row level security;
alter table private.school_feed_urls enable row level security;
alter table private.school_sync      enable row level security;

-- Every grown-up who signs in reads homework (the status line and the items); the parents change it,
-- through the functions. The private tables have no policies.
create policy "Family can see school links" on public.school_feeds
  for select to authenticated using (private.is_member());
create policy "Family can see school items" on public.school_items
  for select to authenticated using (private.is_member());

revoke all on public.school_feeds, public.school_items from public, anon, authenticated;
grant select on public.school_feeds, public.school_items to authenticated;
revoke all on private.school_feed_urls, private.school_sync from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- The address check (§11.3), and small helpers
-- ---------------------------------------------------------------------

-- The hosts a school link may name: *.myschoolapp.com, Blackbaud's. A school on its own domain needs
-- this widened on purpose (§17.2). The database tests replace it with a made-up one.
create function private.school_host_suffix()
returns text
language sql
immutable
set search_path = ''
as $$
  select '.myschoolapp.com';
$$;

-- A pasted link as the hub keeps it, or null: spaces trimmed; webcal:// becomes https://; https only;
-- port 443 or none; no user info; a host of letters, digits, dots and hyphens ending in the suffix (in
-- lower case); the path /podium/feed/iCal.aspx (any case, kept as written); a z value; at most 500
-- characters, with no spaces, control characters, quotes, backslashes or angle brackets.
-- hub-jobs checks the same before every read (school.ts).
create function private.school_url(p_url text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v      text := btrim(p_url);
  v_suf  text := private.school_host_suffix();
  v_host text;
  m      text[];
begin
  if v is null or char_length(v) > 500 or v ~ '[[:space:][:cntrl:]<>"\\]' then
    return null;
  end if;
  v := regexp_replace(v, '^webcal://', 'https://', 'i');
  m := regexp_match(v, '^https://([^/?#@:]+)(:443)?(/[^?#]*)\?([^#]*)$', 'i');
  if m is null then
    return null;
  end if;
  v_host := lower(m[1]);
  if v_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
     or char_length(v_host) <= char_length(v_suf) or right(v_host, char_length(v_suf)) <> v_suf
     or lower(m[3]) <> '/podium/feed/ical.aspx' or m[4] !~ '(^|&)z=[^&]+' then
    return null;
  end if;
  return 'https://' || v_host || m[3] || '?' || m[4];
end;
$$;

-- An instant written as ISO 8601 with Z or an offset ("2026-11-03T21:00:00Z"), or null.
create function private.safe_instant(s text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  if s is null or s !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$' then
    return null;
  end if;
  return s::timestamptz;
exception when others then
  return null;
end;
$$;

-- One read's items as the hub keeps them (school_store): each object's text cleaned as the
-- assignments' tidy trigger cleans it (title on one line, at most 120; class at most 40; description
-- with its line breaks, at most 4000), keyed, and only what the hub uses: assignments due from
-- p_today - 14 to p_today + 120 (the due date by p_rule and p_shift), schedule and games items with a
-- start from p_today to p_today + 55 (busy time can't use more, §5.3). An item without a title, or
-- without its dates, is left out; an end before the start is dropped. A key repeated in one read:
-- the last one wins.
create function private.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)
returns table (n bigint, key text, has_uid boolean, title text, subject text, details text,
               first_day date, last_day date, due_date date, starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with raw as (
    select x.n,
           nullif(private.clean_text(x.j ->> 'uid', 255), '') as uid,
           nullif(private.clean_text(x.j ->> 'title', 120), '') as title,
           nullif(private.clean_text(x.j ->> 'subject', 40), '') as subject,
           nullif(private.clean_block(x.j ->> 'details', 4000), '') as details,
           private.safe_date(x.j ->> 'first_day') as f,
           private.safe_date(x.j ->> 'last_day') as l,
           private.safe_instant(x.j ->> 'starts_at') as s,
           private.safe_instant(x.j ->> 'ends_at') as e
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]' end) with ordinality x (j, n)
    where jsonb_typeof(x.j) = 'object'
  ),
  shaped as (
    select r.n, r.uid, r.title, r.subject, r.details,
           r.f, greatest(coalesce(r.l, r.f), r.f) as l,
           (case when p_rule = 'start' then r.f else greatest(coalesce(r.l, r.f), r.f) end) + coalesce(p_shift, 0) as due,
           r.s, case when r.e >= r.s then r.e end as e
    from raw r
    where r.title is not null
      and case when p_kind = 'assignments' then r.f is not null else r.s is not null end
  ),
  kept as (
    select s.*,
           md5(case when p_kind = 'assignments'
                    then coalesce('uid:' || s.uid, 'title:' || lower(s.title) || '|' || to_char(s.f, 'YYYY-MM-DD'))
                    else coalesce('uid:' || s.uid, 'title:' || lower(s.title)) || '|' || to_char(s.s at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') end) as k
    from shaped s
    where case when p_kind = 'assignments' then s.due between p_today - 14 and p_today + 120
               else (s.s at time zone private.tz())::date between p_today and p_today + 55 end
  )
  select distinct on (k.k) k.n, k.k, k.uid is not null, k.title,
         case when p_kind = 'assignments' then k.subject end,
         case when p_kind = 'assignments' then k.details end,
         case when p_kind = 'assignments' then k.f end,
         case when p_kind = 'assignments' then k.l end,
         case when p_kind = 'assignments' then k.due end,
         case when p_kind <> 'assignments' then k.s end,
         case when p_kind <> 'assignments' then k.e end
  from kept k
  order by k.k, k.n desc;
$$;

-- An assignment from a school item (Quick, Plan with Pat, a parent's Add): kind 'assignment',
-- added_by 'school', the item's title, class, due date and description (as its teacher's text), written
-- by p_who. Notes it on the item (assignment_id, made_at, and what was written in applied). An item
-- made one before answers its assignment (null if that was deleted since).
create function private.school_assignment(p_item uuid, p_who text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_i   public.school_items;
  v_kid uuid;
  v_a   public.assignments;
begin
  select i.* into v_i from public.school_items i where i.id = p_item for update;
  if v_i.id is null or v_i.due_date is null then
    raise exception 'That item from school isn''t there any more.' using errcode = '22023';
  end if;
  if v_i.made_at is not null then
    return v_i.assignment_id;
  end if;
  select f.kid_id into v_kid from public.school_feeds f where f.id = v_i.feed_id;
  insert into public.assignments (kid_id, kind, added_by, title, subject, due_date, details, created_by, updated_by)
  values (v_kid, 'assignment', 'school', v_i.title, v_i.subject, v_i.due_date, v_i.details, p_who, p_who)
  returning * into v_a;
  update public.school_items i
  set assignment_id = v_a.id, made_at = private.now(), hidden = false,
      applied = jsonb_build_object('title', v_a.title, 'subject', v_a.subject, 'due_date', v_a.due_date, 'details', v_a.details)
  where i.id = p_item;
  return v_a.id;
end;
$$;

-- The school's changes reach the open assignments made from a link's items, field by field (title,
-- class, due date, description): a field follows the school while it still has what the feed last
-- wrote there (applied); once a person changed it (Jordan, the tutor, a parent, or the retention trim),
-- it is never written again, until it has the school's value once more. A due date doesn't move by
-- itself on an assignment with a plan: the views mark it (moved_to) and a person places it again.
-- Answers how many assignments changed.
create function private.school_apply(p_feed uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  r       record;
  v_ap    jsonb;
  v_title text;
  v_subj  text;
  v_due   date;
  v_det   text;
  v_plan  boolean;
  v_n     int := 0;
begin
  for r in
    select i.id as item_id, i.title, i.subject, i.due_date, i.details, coalesce(i.applied, '{}') as applied,
           a.id as aid, a.title as a_title, a.subject as a_subject, a.due_date as a_due, a.details as a_details
    from public.school_items i
    join public.assignments a on a.id = i.assignment_id
    where i.feed_id = p_feed and i.gone_at is null and i.due_date is not null and a.status = 'open'
    order by a.id
    for update of a
  loop
    v_ap := r.applied;
    v_plan := exists (select 1 from public.homework_steps s where s.assignment_id = r.aid);
    v_title := case when r.a_title is not distinct from v_ap ->> 'title' then r.title else r.a_title end;
    v_subj := case when r.a_subject is not distinct from v_ap ->> 'subject' then r.subject else r.a_subject end;
    v_due := case when r.a_due is not distinct from (v_ap ->> 'due_date')::date and not v_plan then r.due_date else r.a_due end;
    v_det := case when r.a_details is not distinct from v_ap ->> 'details' then r.details else r.a_details end;
    if v_title is distinct from r.a_title or v_subj is distinct from r.a_subject or v_due is distinct from r.a_due
       or v_det is distinct from r.a_details then
      update public.assignments a
      set title = v_title, subject = v_subj, due_date = v_due, details = v_det, updated_by = 'school link'
      where a.id = r.aid;
      v_n := v_n + 1;
    end if;
    -- What the feed has written there now (a field that has the school's value again follows it again).
    update public.school_items i
    set applied = jsonb_build_object(
          'title', case when v_title is not distinct from r.title then r.title else v_ap ->> 'title' end,
          'subject', case when v_subj is not distinct from r.subject then r.subject else v_ap ->> 'subject' end,
          'due_date', case when v_due is not distinct from r.due_date then r.due_date else (v_ap ->> 'due_date')::date end,
          'details', case when v_det is not distinct from r.details then r.details else v_ap ->> 'details' end)
    where i.id = r.item_id;
  end loop;
  return v_n;
end;
$$;

-- The school's marks on a kid's assignments made from school: {"<assignment id>": {gone, moved_to}}.
-- gone: no longer on the school site. moved_to: the school's due date, when it differs from the
-- assignment's and nobody changed the assignment's (a planned one doesn't move by itself).
create function private.school_marks(p_kid uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(a.id::text, jsonb_build_object(
           'gone', i.gone_at is not null,
           'moved_to', case when i.due_date is distinct from a.due_date and a.due_date = (i.applied ->> 'due_date')::date
                            then i.due_date end)), '{}')
  from public.school_items i
  join public.school_feeds f on f.id = i.feed_id
  join public.assignments a on a.id = i.assignment_id
  where f.kid_id = p_kid;
$$;

-- His New from school (§11.4): the items of his checked Assignments links that nobody made an
-- assignment, he didn't hide and are still on the school site, due from today to today + 30, by due
-- date, at most 20: [{id, title, subject, due_date, quick}] (quick: due within 3 days, as v1.3's
-- Quick). Null while he has no checked Assignments link (his view then has no from_school key).
create function private.school_new(p_kid uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when exists (select 1 from public.school_feeds f where f.kid_id = p_kid and f.kind = 'assignments' and f.checked) then
    (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subject', x.subject, 'due_date', x.due_date,
                                                  'quick', x.due_date - public.today_local() <= 3)
                               order by x.due_date, x.title, x.id), '[]')
     from (select i.id, i.title, i.subject, i.due_date
           from public.school_items i
           join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.checked
           where i.made_at is null and not i.hidden and i.gone_at is null
             and i.due_date between public.today_local() and public.today_local() + 30
           order by i.due_date, i.title, i.id
           limit 20) x)
  end;
$$;

-- ---------------------------------------------------------------------
-- Busy time (§12.3): free_minutes, replaced. 0005's body, with his schedule and games items as
-- busy blocks (marked "0006"): his timed school items that aren't gone, on their household day.
-- ---------------------------------------------------------------------

-- A kid's homework time from p_from to p_to (cut to p_from + 55: public.agenda takes at most 62
-- days), one row per day that has some, with the caller's rights (a non-member gets none):
--   starts, ends:    the day's homework-time occurrences (public.agenda's events whose item is in
--                    homework_times for the kid, not cancelled, after one-day changes): first
--                    start, last end;
--   window_minutes:  their minutes, each once (at most 240);
--   free:            what is left after busy time (at most 240): every timed item of his that day
--                    (events he is in charge of or along on, tasks with a time, the Google events
--                    that reach his day, and from 0006 his school schedule and games; not the
--                    homework-time events themselves; an item with no end lasts an hour, as agenda
--                    counts an event), plus 15 minutes after one that ends inside the homework time.
--                    All-day items don't block time;
--   planned:         minutes of not-done steps on that day in his open assignments, all but p_except;
--   busy:            the blocks that touch the homework time, [{starts, ends, title}];
--   first_free:      the first free minute (the on-time window is around it, §7.1), or null.
-- Minutes count from the day's local midnight, so a clock change doesn't move them.
create or replace function private.free_minutes(p_kid uuid, p_from date, p_to date, p_except uuid)
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
    -- 0006: his school schedule and games.
    union all
    select (s.starts_at at time zone r.tz)::date, s.title, s.starts_at, coalesce(s.ends_at, s.starts_at + interval '1 hour')
    from r
    cross join public.school_items s
    join public.school_feeds sf on sf.id = s.feed_id
    where sf.kid_id = p_kid and sf.kind in ('schedule', 'games') and s.starts_at is not null and s.gone_at is null
      and (s.starts_at at time zone r.tz)::date between r.f and r.t
    -- end 0006
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

-- ---------------------------------------------------------------------
-- His view, the tutor's view and his card (§11.4)
-- ---------------------------------------------------------------------
alter function private.homework_view_kid(uuid, text) rename to homework_view_kid_v5;
alter function private.homework_view_tutor(uuid, uuid, text) rename to homework_view_tutor_v5;

-- His view: 0005's (homework_view_kid_v5), with the school's marks on each assignment made from
-- school (school: {gone, moved_to}) and, once he has a checked Assignments link, from_school (his New
-- from school, private.school_new). Without a school link it is exactly 0005's.
create function private.homework_view_kid(p_kid uuid, p_lang text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := private.homework_view_kid_v5(p_kid, p_lang);
  m jsonb;
  n jsonb;
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
  return v;
end;
$$;

-- The tutor's view: 0005's (homework_view_tutor_v5), with the school's marks on each assignment made
-- from school, in the list and with p_assignment. p_part 'ai' answers as 0005's.
create function private.homework_view_tutor(p_link uuid, p_assignment uuid, p_part text)
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
  if m = '{}' then
    return v;
  end if;
  v := jsonb_set(v, '{assignments}',
                 (select coalesce(jsonb_agg(case when m ? (x ->> 'id') then x || jsonb_build_object('school', m -> (x ->> 'id')) else x end
                                            order by t.n), '[]')
                  from jsonb_array_elements(v -> 'assignments') with ordinality t (x, n)));
  if jsonb_typeof(v -> 'assignment') = 'object' and m ? (v -> 'assignment' ->> 'id') then
    v := jsonb_set(v, '{assignment,school}', m -> (v -> 'assignment' ->> 'id'));
  end if;
  return v;
end;
$$;

-- The card on his My day (get_person_day's homework key): 0005's, plus from_school, how many items
-- are new from school, when there are any (marked "0006"). {next: {id, title, assignment, minutes} |
-- null, length, steps, minutes, earlier?, window?, session?: {ends_in_s}, points?, from_school?}. next
-- is his view's now; steps and minutes count today's open steps; earlier is left out when there are
-- none or no homework time today, window when there is none today, session when no block is open,
-- points when points are off, from_school when nothing is new. Never raises: anything wrong leaves
-- the card out.
create or replace function private.homework_card(p_kid uuid, p_lang text)
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
         || case when jsonb_typeof(v -> 'points') = 'object' then jsonb_build_object('points', v -> 'points' -> 'balance') else '{}' end
         -- 0006
         || case when jsonb_typeof(v -> 'from_school') = 'array' and jsonb_array_length(v -> 'from_school') > 0
                 then jsonb_build_object('from_school', jsonb_array_length(v -> 'from_school')) else '{}' end;
         -- end 0006
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- The parents (§11.2, §12). Each change raises 42501 "Only a parent can change homework." unless
-- private.is_admin(); Sam reads the status card.
-- ---------------------------------------------------------------------

-- The status card (members; null for anyone else, or a kid without homework):
--   {kid_id, last_run_at (the read job's last run),
--    feeds: [{id, kind, host, url_end, checked, date_rule, date_shift, paused, last_try_at, last_ok_at,
--             last_count, last_repeats, last_stop, fails, next_at, stale}] (Assignments, Schedule, Games),
--    check: [{id, title, subject, first_day, last_day, due_date}] (the first-import check: an Assignments
--           link not checked yet, its next 5 items by due date; else []),
--    new: [{id, title, subject, due_date}] (what is new for him, as on his screen, at most 50),
--    hidden: [{id, title, subject, due_date}] (what he hid, still to come),
--    moved: [{assignment_id, title, from, to}] (a planned assignment whose school date moved),
--    gone: [{assignment_id, title, due_date}] (an open assignment no longer on the school site)}
-- stale: a link due for over 2 hours and not read (about 3 hours since the last read): the job isn't
-- running ("run supabase/cron.sql again"). Never the address.
create function public.school_feed_status(p_kid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now   timestamptz := private.now();
  v_today date := public.today_local();
begin
  if not private.is_member() or not exists (select 1 from public.homework_kids k where k.kid_id = p_kid) then
    return null;
  end if;
  return jsonb_build_object(
    'kid_id', p_kid,
    'last_run_at', (select y.last_run_at from private.school_sync y where y.id),
    'feeds', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', f.id, 'kind', f.kind, 'host', f.host, 'url_end', f.url_end, 'checked', f.checked,
                       'date_rule', f.date_rule, 'date_shift', f.date_shift, 'paused', f.paused,
                       'last_try_at', f.last_try_at, 'last_ok_at', f.last_ok_at, 'last_count', f.last_count,
                       'last_repeats', f.last_repeats, 'last_stop', f.last_stop, 'fails', f.fails, 'next_at', f.next_at,
                       'stale', not f.paused and coalesce(f.next_at < v_now - interval '2 hours', false))
                     order by case f.kind when 'assignments' then 1 when 'schedule' then 2 else 3 end), '[]')
              from public.school_feeds f where f.kid_id = p_kid),
    'check', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subject', x.subject,
                                                           'first_day', x.first_day, 'last_day', x.last_day, 'due_date', x.due_date)
                                        order by x.due_date, x.title, x.id), '[]')
              from (select i.* from public.school_items i
                    join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and not f.checked
                    where i.due_date >= v_today and i.gone_at is null
                    order by i.due_date, i.title, i.id limit 5) x),
    'new', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subject', x.subject, 'due_date', x.due_date)
                                      order by x.due_date, x.title, x.id), '[]')
            from (select i.* from public.school_items i
                  join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.checked
                  where i.made_at is null and not i.hidden and i.gone_at is null and i.due_date between v_today and v_today + 30
                  order by i.due_date, i.title, i.id limit 50) x),
    'hidden', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'subject', i.subject, 'due_date', i.due_date)
                                         order by i.due_date, i.title, i.id), '[]')
               from public.school_items i
               join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments'
               where i.made_at is null and i.hidden and i.gone_at is null and i.due_date >= v_today),
    'moved', (select coalesce(jsonb_agg(jsonb_build_object('assignment_id', a.id, 'title', a.title, 'from', a.due_date, 'to', i.due_date)
                                        order by a.due_date, a.title, a.id), '[]')
              from public.school_items i
              join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid
              join public.assignments a on a.id = i.assignment_id and a.status = 'open'
              where i.gone_at is null and i.due_date is distinct from a.due_date and a.due_date = (i.applied ->> 'due_date')::date),
    'gone', (select coalesce(jsonb_agg(jsonb_build_object('assignment_id', a.id, 'title', a.title, 'due_date', a.due_date)
                                       order by a.due_date, a.title, a.id), '[]')
             from public.school_items i
             join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid
             join public.assignments a on a.id = i.assignment_id and a.status = 'open'
             where i.gone_at is not null));
end;
$$;

-- Add link, Replace (p_url an address) and Remove (p_url null or ''). p_kind 'assignments',
-- 'schedule' or 'games'. The address must pass private.school_url (22023 otherwise, the same words for
-- every way it can fail); it is kept in private.school_feed_urls and never answered. A new or replaced
-- link is due to be read at once (the next run, or Check now); Replace keeps the link's row, its
-- first-import answer and its items. Remove deletes the link, its address and every item no one made
-- an assignment (assignments made from it stay, added_by 'school'). Answers {id, kind, host,
-- url_end}, or null for Remove.
create function public.set_school_feed(p_kid uuid, p_kind text, p_url text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_f   public.school_feeds;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('assignments', 'schedule', 'games') then
    raise exception 'Choose assignments, schedule or games.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.homework_kids k where k.kid_id = p_kid) then
    raise exception 'Turn on homework for this kid first.' using errcode = '22023';
  end if;
  if nullif(btrim(p_url), '') is null then
    delete from public.school_feeds f where f.kid_id = p_kid and f.kind = p_kind;
    return null;
  end if;
  v_url := private.school_url(p_url);
  if v_url is null then
    raise exception 'That isn''t a school calendar link. Copy it from the calendar''s feed button: it starts with webcal:// or https:// and has /podium/feed/iCal.aspx?z= in it.'
      using errcode = '22023';
  end if;
  insert into public.school_feeds as f (kid_id, kind, host, url_end, next_at)
  values (p_kid, p_kind, split_part(substr(v_url, 9), '/', 1), right(v_url, 4), private.now())
  on conflict (kid_id, kind) do update
  set host = excluded.host, url_end = excluded.url_end, next_at = excluded.next_at, fails = 0, last_stop = null
  returning * into v_f;
  insert into private.school_feed_urls as u (feed_id, url) values (v_f.id, v_url)
  on conflict (feed_id) do update set url = excluded.url;
  return jsonb_build_object('id', v_f.id, 'kind', v_f.kind, 'host', v_f.host, 'url_end', v_f.url_end);
end;
$$;

-- The first-import check (§11.2 step 8), on an Assignments link: the due date is an item's first
-- ('start') or last ('end') day, moved p_date_shift days (-1 to 1). Every item's due date follows,
-- and so do the assignments made from them that nobody changed. Answers the status card.
create function public.check_school_feed(p_feed uuid, p_date_rule text, p_date_shift int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.school_feeds;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  select * into v_f from public.school_feeds f where f.id = p_feed for update;
  if v_f.id is null then
    raise exception 'That school link isn''t there any more.' using errcode = '22023';
  end if;
  if v_f.kind <> 'assignments' then
    raise exception 'Only the Assignments link has dates to check.' using errcode = '22023';
  end if;
  if p_date_rule is null or p_date_rule not in ('start', 'end') or p_date_shift is null or p_date_shift not between -1 and 1 then
    raise exception 'Choose the start or the end date, and a shift of -1, 0 or 1 day.' using errcode = '22023';
  end if;
  update public.school_feeds f set date_rule = p_date_rule, date_shift = p_date_shift, checked = true where f.id = p_feed;
  update public.school_items i
  set due_date = (case when p_date_rule = 'start' then i.first_day else i.last_day end) + p_date_shift
  where i.feed_id = p_feed and i.first_day is not null;
  perform private.school_apply(p_feed);
  return public.school_feed_status(v_f.kid_id);
end;
$$;

-- Pause (or go on reading) a link. A paused link isn't read; its items stay.
create function public.pause_school_feed(p_feed uuid, p_paused boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_paused is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  update public.school_feeds f set paused = p_paused where f.id = p_feed;
  if not found then
    raise exception 'That school link isn''t there any more.' using errcode = '22023';
  end if;
end;
$$;

-- A parent's actions on an Assignments item: 'add' (make it an assignment from school now, as Plan
-- with Pat does; with or without the first-import check), 'hide' (off his New from school) and
-- 'show' (back on it). Answers {assignment_id} (for 'add') and the status card.
create function public.school_item_action(p_item uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kid uuid;
  v_aid uuid;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('add', 'hide', 'show') then
    raise exception 'Choose add, hide or show.' using errcode = '22023';
  end if;
  select f.kid_id into v_kid
  from public.school_items i join public.school_feeds f on f.id = i.feed_id and f.kind = 'assignments'
  where i.id = p_item;
  if v_kid is null then
    raise exception 'That item from school isn''t there any more.' using errcode = '22023';
  end if;
  if p_action = 'add' then
    v_aid := private.school_assignment(p_item, public.current_email());
  else
    update public.school_items i set hidden = (p_action = 'hide') where i.id = p_item and i.made_at is null;
  end if;
  return jsonb_build_object('assignment_id', v_aid) || public.school_feed_status(v_kid);
exception
  when integrity_constraint_violation then
    raise exception 'That can''t be saved.' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------
-- My day: Jordan's New from school (§11.4). His My day token is the key, as for his seven functions
-- (private.homework_kid_by_token: null for anything else, or with homework off).
-- ---------------------------------------------------------------------

-- p_action 'quick' (p_minutes 5 to 60: the item becomes an assignment from school and Quick makes it
-- tonight's one step, given at once, through assignment_by_token's 'quick' and its rules: "Plan this
-- one with Pat." for one due 4 or more days out, and then nothing is made), 'with_tutor' (Plan with
-- Pat: it becomes an assignment from school with no plan, on the tutor's link) or 'hide' (off his
-- list; not one made an assignment). Only an item of his checked Assignments link that is still on the
-- school site: else 42501 "That isn't on your list from school.", the same for each. A resend finds
-- what it made. Counted (150 writes a day). Answers {assignment_id} and his view.
create function public.school_item_by_token(p_token text, p_item uuid, p_action text, p_minutes int default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me    public.people;
  v_i   public.school_items;
  v_aid uuid;
  v_ch  boolean := false;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if p_action is null or p_action not in ('quick', 'with_tutor', 'hide') then
    raise exception 'Choose quick, with_tutor or hide.' using errcode = '22023';
  end if;
  if p_action = 'quick' and (p_minutes is null or p_minutes not between 5 and 60) then
    raise exception 'A step is 5 to 60 minutes.' using errcode = '22023';
  end if;
  select i.* into v_i
  from public.school_items i
  where i.id = p_item
    and exists (select 1 from public.school_feeds f where f.id = i.feed_id and f.kid_id = me.id and f.kind = 'assignments' and f.checked)
  for update;
  if v_i.id is null or v_i.gone_at is not null or (v_i.made_at is not null and v_i.assignment_id is null) then
    raise exception 'That isn''t on your list from school.' using errcode = '42501';
  end if;

  if p_action = 'hide' then
    if v_i.made_at is not null then
      raise exception 'That one is on your homework already.' using errcode = 'P0001';
    end if;
    if not v_i.hidden then
      update public.school_items i set hidden = true where i.id = v_i.id;
      v_ch := true;
    end if;
  else
    if v_i.made_at is null then
      v_aid := private.school_assignment(v_i.id, private.short_name(me) || ' (My day)');
      v_ch := true;
    else
      v_aid := v_i.assignment_id;
    end if;
    if p_action = 'quick' then
      -- Quick counts its own write; a refusal there undoes the assignment made here too.
      return public.assignment_by_token(p_token, 'quick', v_aid, null, null, null, p_minutes);
    end if;
  end if;

  if v_ch then
    perform private.count_homework(me.id, 'writes', 150);
  end if;
  perform private.homework_trim(me.id);
  return jsonb_build_object('assignment_id', v_aid) || private.homework_view_kid(me.id, me.language);
exception
  -- A constraint's DETAIL is the whole row: never to a link (§3.4).
  when integrity_constraint_violation then
    raise exception 'That can''t be saved.' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------
-- The read job: hub-jobs {action: 'school'} (service_role only, §11.3)
-- ---------------------------------------------------------------------

-- Takes the lease for one run (5 minutes; a run past it counts as dead) and hands over the links to
-- read: {go, stop, run_id, today, tz, feeds: [{feed_id, kind, url}]}, at most 10, the longest due
-- first. A link is due when its next_at has passed, it isn't paused, and its kid is active with
-- homework on; p_force (a parent's Check now): every such link not tried in the last minute. While
-- another run holds the lease: {go: false, stop: 'busy'}. The only reader of the addresses.
create function public.school_begin(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.now();
  v_run uuid;
begin
  insert into private.school_sync (id) values (true) on conflict (id) do nothing;
  update private.school_sync y
  set run_id = gen_random_uuid(), lease_until = v_now + interval '5 minutes'
  where y.id and (y.lease_until is null or y.lease_until < v_now)
  returning y.run_id into v_run;
  if v_run is null then
    return jsonb_build_object('go', false, 'stop', 'busy');
  end if;
  return jsonb_build_object(
    'go', true, 'stop', null, 'run_id', v_run, 'today', public.today_local(), 'tz', private.tz(),
    'feeds', (select coalesce(jsonb_agg(jsonb_build_object('feed_id', x.id, 'kind', x.kind, 'url', u.url) order by x.next_at, x.id), '[]')
              from (select f.id, f.kind, f.next_at
                    from public.school_feeds f
                    join public.homework_kids k on k.kid_id = f.kid_id and k.active
                    join public.people p on p.id = f.kid_id and p.active
                    where not f.paused
                      and case when coalesce(p_force, false) then f.last_try_at is null or f.last_try_at < v_now - interval '1 minute'
                               else f.next_at is null or f.next_at <= v_now end
                    order by f.next_at nulls first, f.id
                    limit 10) x
              join private.school_feed_urls u on u.feed_id = x.id));
end;
$$;

-- One link's read, while p_run holds the lease (else {stored: false, stop: 'late'}, nothing changed).
-- p_stop: the read's fixed code when it failed (anything else is stored as 'error'); nothing changes but
-- the link's status: fails + 1 and the next read 1, 2, 4, then 8 hours on (each 10 minutes early, so
-- the hourly run finds it due). Otherwise p_items (the shape private.school_rows reads; at most 400
-- assignments or 2,000 schedule or games items: else 'too_many', nothing applied) are stored:
--   • a read with nothing in it when 3 or more items were there is 'empty' and not applied;
--   • new items are added, the others updated (an item back on the site is no longer gone);
--   • an Assignments item without a UID that is absent, with a new key of the same title in this read,
--     is the same item with its date moved (it keeps its row, and its assignment);
--   • an item inside the window absent from a good, non-empty read is missing once more; from two in a
--     row it is gone (marked; a schedule or games item is deleted, being only busy time);
--   • past items nobody made an assignment are let go (assignments due before today - 14, busy time
--     before today);
--   • the school's changes reach the assignments made from it (private.school_apply).
-- A good read clears the failures and is due again in 50 minutes. Answers {stored, stop, kept, added,
-- missing, gone}. Only fixed codes are stored, never the job's error text or anything from the feed.
create function public.school_store(p_run uuid, p_feed uuid, p_items jsonb, p_stop text, p_repeats int default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now     timestamptz := private.now();
  v_today   date := public.today_local();
  v_tz      text := private.tz();
  v_f       public.school_feeds;
  v_asg     boolean;
  v_stop    text;
  v_n       int;
  v_live    int;
  v_added   int := 0;
  v_missing int := 0;
  v_gone    int := 0;
  c         record;
begin
  if not exists (select 1 from private.school_sync y where y.id and y.run_id = p_run and y.lease_until >= v_now) then
    return jsonb_build_object('stored', false, 'stop', 'late');
  end if;
  select * into v_f from public.school_feeds f where f.id = p_feed for update;
  if v_f.id is null then
    return jsonb_build_object('stored', false, 'stop', 'removed');
  end if;
  v_asg := v_f.kind = 'assignments';
  v_stop := case when p_stop is null then null
                 when p_stop in ('bad_link', 'redirect', 'unreachable', 'timeout', 'too_big', 'refused', 'gone', 'down', 'http',
                                 'sign_in', 'not_calendar', 'empty', 'too_many') then p_stop
                 else 'error' end;
  if v_stop is null and jsonb_typeof(p_items) is distinct from 'array' then
    v_stop := 'error';
  end if;
  if v_stop is null and jsonb_array_length(p_items) > 20000 then
    v_stop := 'too_many';
  end if;
  if v_stop is null then
    select count(*) into v_n from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today) x;
    if v_n > (case when v_asg then 400 else 2000 end) then
      v_stop := 'too_many';
    end if;
  end if;
  if v_stop is null and v_n = 0 then
    select count(*) into v_live from public.school_items i
    where i.feed_id = p_feed and i.gone_at is null
      and (i.due_date between v_today - 14 and v_today + 120
           or (i.starts_at at time zone v_tz)::date between v_today and v_today + 55);
    if v_live >= 3 then
      v_stop := 'empty';
    end if;
  end if;

  if v_stop is not null then
    update public.school_feeds f
    set last_try_at = v_now, last_stop = v_stop, fails = f.fails + 1,
        next_at = v_now + make_interval(mins => (60 * power(2, least(f.fails, 3)))::int - 10)
    where f.id = p_feed;
    return jsonb_build_object('stored', false, 'stop', v_stop);
  end if;

  -- An Assignments item without a UID whose date moved: the absent one of the same title takes the new key.
  if v_asg then
    for c in
      select x.key, x.title, x.first_day
      from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today) x
      where not x.has_uid and not exists (select 1 from public.school_items i where i.feed_id = p_feed and i.key = x.key)
      order by x.n
    loop
      update public.school_items i set key = c.key
      where i.id = (select o.id from public.school_items o
                    where o.feed_id = p_feed and not o.has_uid and lower(o.title) = lower(c.title)
                      and not exists (select 1 from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today) y
                                      where y.key = o.key)
                    order by abs(o.first_day - c.first_day), o.first_seen_at, o.id
                    limit 1);
    end loop;
  end if;

  with x as (
    select * from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today)
  ),
  up as (
    insert into public.school_items as i (feed_id, key, has_uid, title, subject, details, first_day, last_day, due_date,
                                          starts_at, ends_at, first_seen_at, last_seen_at)
    select p_feed, x.key, x.has_uid, x.title, x.subject, x.details, x.first_day, x.last_day, x.due_date,
           x.starts_at, x.ends_at, v_now, v_now
    from x
    on conflict (feed_id, key) do update
    set has_uid = excluded.has_uid, title = excluded.title, subject = excluded.subject, details = excluded.details,
        first_day = excluded.first_day, last_day = excluded.last_day, due_date = excluded.due_date,
        starts_at = excluded.starts_at, ends_at = excluded.ends_at, last_seen_at = v_now, missing = 0, gone_at = null
    returning (xmax = 0) as added
  )
  select count(*) filter (where up.added) into v_added from up;

  -- Missing from this read (a good, non-empty one), inside the window: once more; from two, gone.
  if v_n > 0 then
    with m as (
      update public.school_items i
      set missing = i.missing + 1, gone_at = case when i.missing + 1 >= 2 then v_now end
      where i.feed_id = p_feed and i.gone_at is null
        and not exists (select 1 from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today) x where x.key = i.key)
        and (i.due_date between v_today - 14 and v_today + 120
             or (i.starts_at at time zone v_tz)::date between v_today and v_today + 55)
      returning i.gone_at
    )
    select count(*), count(m.gone_at) into v_missing, v_gone from m;
  end if;
  -- Schedule and games items gone, and past items nobody made an assignment, are let go.
  delete from public.school_items i
  where i.feed_id = p_feed
    and ((not v_asg and i.gone_at is not null)
         or (i.due_date < v_today - 14 and i.assignment_id is null)
         or coalesce(i.ends_at, i.starts_at) < (v_today::timestamp at time zone v_tz));

  perform private.school_apply(p_feed);

  update public.school_feeds f
  set last_try_at = v_now, last_ok_at = v_now, last_stop = null, fails = 0, last_count = v_n,
      last_repeats = greatest(coalesce(p_repeats, 0), 0), next_at = v_now + interval '50 minutes'
  where f.id = p_feed;
  return jsonb_build_object('stored', true, 'stop', null, 'kept', v_n, 'added', v_added, 'missing', v_missing, 'gone', v_gone);
end;
$$;

-- Ends a run: the lease is free, and the run is noted (the status card's last_run_at).
create function public.school_finish(p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.school_sync y
  set run_id = null, lease_until = null, last_run_at = private.now()
  where y.id and y.run_id = p_run;
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The school parts of the pages show, and ask for anything, only on 6.
-- (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 6;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- New functions, public and private: revoke from public and anon (and whoever else mustn't call
-- them), then grant to who calls them. Replaced functions (free_minutes, homework_card) and renamed
-- ones (homework_view_kid_v5, homework_view_tutor_v5) keep their grants.
-- ---------------------------------------------------------------------

-- The parents' (and Sam's status card).
revoke execute on function public.school_feed_status(uuid)                        from public, anon, service_role;
revoke execute on function public.set_school_feed(uuid, text, text)               from public, anon, service_role;
revoke execute on function public.check_school_feed(uuid, text, int)              from public, anon, service_role;
revoke execute on function public.pause_school_feed(uuid, boolean)                from public, anon, service_role;
revoke execute on function public.school_item_action(uuid, text)                  from public, anon, service_role;
grant  execute on function public.school_feed_status(uuid)                        to authenticated;
grant  execute on function public.set_school_feed(uuid, text, text)               to authenticated;
grant  execute on function public.check_school_feed(uuid, text, int)              to authenticated;
grant  execute on function public.pause_school_feed(uuid, boolean)                to authenticated;
grant  execute on function public.school_item_action(uuid, text)                  to authenticated;

-- My day: his token is the key.
revoke execute on function public.school_item_by_token(text, uuid, text, int)     from public, service_role;
grant  execute on function public.school_item_by_token(text, uuid, text, int)     to anon, authenticated;

-- hub-jobs.
revoke execute on function public.school_begin(boolean)                           from public, anon, authenticated;
revoke execute on function public.school_store(uuid, uuid, jsonb, text, int)      from public, anon, authenticated;
revoke execute on function public.school_finish(uuid)                             from public, anon, authenticated;
grant  execute on function public.school_begin(boolean)                           to service_role;
grant  execute on function public.school_store(uuid, uuid, jsonb, text, int)      to service_role;
grant  execute on function public.school_finish(uuid)                             to service_role;

-- Private: the definer functions above call them; nobody else.
revoke execute on function private.school_host_suffix()                           from public, anon, authenticated;
revoke execute on function private.school_url(text)                               from public, anon, authenticated;
revoke execute on function private.safe_instant(text)                             from public, anon, authenticated;
revoke execute on function private.school_rows(text, jsonb, text, int, date)      from public, anon, authenticated;
revoke execute on function private.school_assignment(uuid, text)                  from public, anon, authenticated;
revoke execute on function private.school_apply(uuid)                             from public, anon, authenticated;
revoke execute on function private.school_marks(uuid)                             from public, anon, authenticated;
revoke execute on function private.school_new(uuid)                               from public, anon, authenticated;
revoke execute on function private.homework_view_kid(uuid, text)                  from public, anon, authenticated;
revoke execute on function private.homework_view_tutor(uuid, uuid, text)          from public, anon, authenticated;

commit;
