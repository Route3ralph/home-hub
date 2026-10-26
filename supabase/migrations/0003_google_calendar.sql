-- =====================================================================
-- HOME HUB v1.1 — migration 0003: Google Calendar and Hearth
-- Apply once, after 0002. The build contract is docs/v1.1-google-calendar.md
-- (§2 lists everything here; the section numbers below are that file's).
--
-- What it adds
--   • Tables: calendars (which Google calendar is whose), calendar_links (what
--     hub-jobs wrote to Google), google_events (events read from Google) and
--     calendar_sync (the calendar job's state, one row).
--   • google_items(p_from, p_to): events typed into Google, as agenda rows.
--   • calendar_preview(p_calendar): what Start copying would put on one calendar (yesterday to 60 days ahead).
--   • The calendar job's functions, for hub-jobs only (service_role):
--     calendar_begin, calendar_signed_in, calendar_read_due, calendar_store_events,
--     calendar_mark, calendar_plan, calendar_record, calendar_finish.
--   • Replaced, with the same signatures: private.item_order, private.text_line,
--     private.digest_item and private.person_items (Google events reach My day,
--     day_text and the email), and digest_for (Google events, and the parents'
--     Google Calendar lines). hub_schema_version() returns 3.
--
-- Rules
--   • One transaction. It refuses to run without 0002, or twice.
--   • Additive: the v2 pages work on either version.
--   • Home Hub's database is the source of truth. Google gets a one-way copy of
--     hub items; events read from Google are only shown, never written back.
--   • Every table has row-level security. hub-jobs writes as service_role; admins
--     write only the setting columns of calendars (column grants).
--   • No new SECURITY DEFINER function, and nothing new for anon.
--   • Every job timestamp uses private.now(), so the tests can move the clock.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002_home_hub_v2.sql first. Nothing was changed.';
  end if;
  if public.hub_schema_version() <> 2 then
    raise exception 'Google Calendar (migration 0003) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- Which Google calendar is whose: one per Hearth column (a person, Pets, House or
-- Family) that the hub writes to, plus calendars it only reads. Admins set the
-- first group of columns (column grants); hub-jobs writes the second.
create table public.calendars (
  id               uuid primary key default gen_random_uuid(),
  google_id        text not null unique   -- Google's "Calendar ID"; trimmed and lowercased by private.calendars_tidy
                   check (google_id ~ '^[a-z0-9._+#-]{1,200}@[a-z0-9.-]+\.[a-z]{2,}$'),   -- '#' for holiday calendars (read only)
  kind             text not null check (kind in ('person', 'pets', 'house', 'family')),   -- whose column it is
  person_id        uuid references public.people (id) on delete cascade,                  -- kind 'person' only
  label            text not null check (length(label) between 1 and 40 and label = trim(label)),
                   -- what Settings calls it: the person's first name, "Family", or for pets and house
                   -- the title prefix ("Dogs: Heartworm pill")
  writes           boolean not null default true,    -- the hub copies its items here; false = only read
  for_kids         boolean not null default false,   -- read-only Family calendars: "Show to kids"
  copy_approved_at timestamptz,                      -- "Start copying" after the preview; null = nothing is written
  -- Written by hub-jobs only.
  google_name      text,                             -- the calendar's name in Google, from the last read or Test
  access_role      text,                             -- Google's accessRole for the hub, from the last read or Test
  status           text not null default 'new' check (status in ('new', 'ok', 'no_access', 'error')),
  status_detail    text check (length(status_detail) <= 300),   -- a fixed message and Google's reason
  checked_at       timestamptz,                      -- the last time Google answered about it (read, write or Test)
  read_at          timestamptz,                      -- the last complete read of its events
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       text,
  check ((kind = 'person') = (person_id is not null)),
  check (not writes or google_id ~ '^[a-z0-9._-]+@group\.calendar\.google\.com$'),   -- never a main (personal) calendar
  check (not for_kids or (kind = 'family' and not writes))
);
-- One writing calendar per column.
create unique index calendars_one_writer
  on public.calendars (kind, coalesce(person_id, '00000000-0000-0000-0000-000000000000')) where writes;

-- What hub-jobs wrote to Google: one row per Google event. Rows are kept after the
-- event is in the past, so a deleted or now-private item and Disconnect reach it too.
create table public.calendar_links (
  google_calendar text not null,         -- the Google calendar it was written to, as in the plan row
  base_id         text not null check (base_id ~ '^hh[0-9a-f]{32}$'),    -- private.calendar_event_id(key)
  event_id        text not null check (event_id ~ '^hh[0-9a-f]{32}$'),   -- the id in Google: base_id, or a new one after a clash
  gen             int not null default 0,    -- bumped when the id is taken but the event isn't on this calendar
  calendar_id     uuid references public.calendars (id) on delete set null,   -- null: the mapping is gone, so the event is deleted
  item_kind       text check (item_kind in ('event', 'task', 'project', 'late')),
  item_id         uuid,
  job_id          text,                      -- a project job's task_dates id
  occurrence      date,
  part            text not null default '' check (part in ('', 'start', 'finish')),   -- a long project job's two markers
  day             date not null,             -- the first and last household day the Google event covers, as last written
  end_day         date not null,
  title           text not null default '',  -- as written, for Settings
  hash            text,                      -- md5 of the body last written; null = write it again
  tried_hash      text,                      -- the hash (or 'delete') of the last attempt, for the backoff
  google_hash     text,                      -- the content hash of Google's copy after our last write
  google_updated  timestamptz,               -- Google's "updated" after our last write
  repairs         int not null default 0,
  repaired_at     timestamptz,
  repair_kind     text check (repair_kind in ('edited', 'deleted')),   -- put back after a change in Google
  status          text not null default 'pending' check (status in ('pending', 'ok', 'error')),
  attempts        int not null default 0,
  next_try_at     timestamptz,
  failing_since   timestamptz,
  error           text,
  synced_at       timestamptz,               -- the last successful write; null = never written
  created_at      timestamptz not null default now(),
  primary key (google_calendar, base_id),
  unique (google_calendar, event_id)
);
create index calendar_links_calendar_idx on public.calendar_links (calendar_id);
create index calendar_links_end_day_idx on public.calendar_links (end_day);

-- Events read from Google that the hub didn't write. Each complete read of a
-- calendar replaces its rows. Only shown, never written back to Google.
create table public.google_events (
  calendar_id     uuid not null references public.calendars (id) on delete cascade,
  google_calendar text not null,           -- the Google ID it was read from: rows whose calendar now has
                                           -- another google_id are never shown, and calendar_finish deletes them
  event_id        text not null,           -- Google's id (for one day of a repeating event, the instance's id)
  title           text not null,           -- cleaned, one line, at most 200 characters; '' for a private one
  location        text,                    -- cleaned, one line, at most 200 characters; null for a private one
  all_day         boolean not null,
  start_day       date not null,           -- the household's days, inclusive
  end_day         date not null,
  start_at        timestamptz,             -- timed events only
  end_at          timestamptz,
  private         boolean not null default false,   -- Google's visibility 'private' or 'confidential'
  repeating       boolean not null default false,
  google_updated  timestamptz,
  read_at         timestamptz not null,
  primary key (calendar_id, event_id),
  check (end_day >= start_day),
  check (all_day = (start_at is null)),
  check (start_at is null or end_at >= start_at)
);
create index google_events_start_day_idx on public.google_events (start_day);

-- The calendar job's state: one row, as household is one row of settings.
create table public.calendar_sync (
  id            boolean primary key default true check (id),
  auth          text check (auth in ('service_account', 'oauth')),   -- how the last run signed in (after it got a token)
  account       text,                    -- the service account's address (what to share calendars with); null for OAuth
  key_id        text,                    -- the key's private_key_id (not secret): Settings shows its last 6 characters
  running_since timestamptz,             -- the lease (calendar_begin); a run older than 10 minutes counts as dead
  run_id        uuid,
  last_run_at   timestamptz,
  last_ok_at    timestamptz,             -- the last run with no run-level stop
  last_stop     text,                    -- the last run's stop and its fixed message
  last_error    text,
  last_result   jsonb not null default '{}',   -- {read, stored, skipped, repaired, inserted, updated, deleted, failed,
                                               --  pending, hiding, stop}
  window_from   date,                    -- the days the last run covered
  window_to     date,
  paused_until  timestamptz,             -- Google said "slow down"
  pause_step    int not null default 0
);
insert into public.calendar_sync (id) values (true);

-- ---------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------

-- Text from Google, made safe to store and show on one line: control characters, line and
-- paragraph separators become spaces; bidi overrides and isolates (U+202A–202E, U+2066–2069)
-- and zero-width characters are removed; runs of spaces become one; then it is cut to p_max
-- characters. (The characters are written as \u escapes here, never in hub-jobs' source.)
create function private.clean_text(p_text text, p_max int)
returns text
language sql
immutable
set search_path = ''
as $$
  select rtrim(left(btrim(
           regexp_replace(
             regexp_replace(
               regexp_replace(p_text, '[\u0001-\u001f\u007f-\u009f\u2028\u2029]', ' ', 'g'),
               '[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]', '', 'g'),
             '[[:space:]\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+', ' ', 'g')),
         greatest(p_max, 0)));
$$;

-- An error or status message, as stored for Settings and the email (members can read a calendar's
-- status and the job's last error): one line of at most 300 characters, with anything shaped like a
-- Google token (ya29.…, 1//…, a JWT) removed, should one ever reach a message (§6.4).
create function private.clean_error(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(private.clean_text(
           regexp_replace(p_text, '(ya29\.[0-9A-Za-z._~+/=-]+|1//[0-9A-Za-z._~+/=-]+|eyJ[0-9A-Za-z_-]*\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]*)', '…', 'g'),
           300), '');
$$;

-- A Google event id the hub chooses: 'hh' and 32 hex characters, inside the characters
-- Google allows ([a-v0-9], 5 to 1024 long). Always the same for the same key.
create function private.calendar_event_id(p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'hh' || md5(p_key);
$$;

-- The key one Google event's id is made from (§3.2): the item, which day of it (or which
-- job and marker of a project), and the Google calendar it goes on.
--   events and tasks:  <kind>|<item id>|<occurrence>|<Google calendar ID>|
--   project jobs:      project|<project id>|<job id>|<Google calendar ID>|<part>
--   late-tasks lines:  late|<Google calendar ID>
-- Dates are written with to_char, never date::text (which follows the session's DateStyle).
create function private.calendar_key(p_kind text, p_item uuid, p_job text, p_occurrence date, p_google text, p_part text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'late' then 'late|' || p_google
    when 'project' then concat_ws('|', 'project', p_item::text, p_job, p_google, coalesce(p_part, ''))
    else concat_ws('|', p_kind, p_item::text, to_char(p_occurrence::timestamp, 'YYYY-MM-DD'), p_google, '')
  end;
$$;

-- The calendar's fixed words, in English and Spanish. Anything else falls back to
-- private.word (which this migration leaves as it is).
create function private.calendar_word(p_key text, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(w -> p_lang ->> p_key, w -> 'en' ->> p_key, private.word(p_key, p_lang))
  from (select '{
    "en": {
      "finishes": "finishes",
      "made_by_hub": "Made by Home Hub: changes made here are undone. Change it in Home Hub.",
      "skip_hint": "To cancel one day, use Skip this day in Home Hub.",
      "open_in_hub": "Open in Home Hub: {url}",
      "who_is_on": "Who''s on it: {names}",
      "pets": "Pets", "house": "House",
      "calendar_warning": "Google Calendar isn''t up to date (last synced {when}). See Settings.",
      "calendar_never": "Google Calendar isn''t up to date (it hasn''t synced yet). See Settings.",
      "calendar_items_failed": "{n} items couldn''t be copied to Google. See Settings.",
      "calendar_items_failed_one": "1 item couldn''t be copied to Google. See Settings.",
      "calendar_put_back": "{title}, {day}: {what}.",
      "edited_in_google": "changed in Google and put back",
      "deleted_in_google": "deleted in Google and put back"
    },
    "es": {
      "finishes": "termina",
      "made_by_hub": "Hecho por Home Hub: si lo cambias aquí, se deshace. Se cambia en Home Hub.",
      "skip_hint": "Para cancelar un día, usa Skip this day en Home Hub.",
      "open_in_hub": "Abrir en Home Hub: {url}",
      "who_is_on": "Quién va: {names}",
      "pets": "Mascotas", "house": "Casa",
      "calendar_warning": "Google Calendar no está al día (última sincronización: {when}). Mira Ajustes.",
      "calendar_never": "Google Calendar no está al día (todavía no se ha sincronizado). Mira Ajustes.",
      "calendar_items_failed": "{n} elementos no se pudieron copiar a Google. Mira Ajustes.",
      "calendar_items_failed_one": "1 elemento no se pudo copiar a Google. Mira Ajustes.",
      "calendar_put_back": "{title}, {day}: {what}.",
      "edited_in_google": "cambiado en Google y restaurado",
      "deleted_in_google": "borrado en Google y restaurado"
    }
  }'::jsonb as w) dictionary;
$$;

-- What a calendar's status should be, from its Google name and the access role Google
-- gave the hub (§5.2). Used by a read (calendar_store_events) and by Test (calendar_mark).
--   read only: ok with reader or better (writerWithoutPrivateAccess, Google's "Make changes
--              (see private events as free/busy)", reads too).
--   written:   ok only if its name starts with "Hub" (any case) and the role is the one this
--              sign-in needs: writer for the service account, owner for OAuth (calendar_sync.auth).
--              writerWithoutPrivateAccess is refused with its own message: the hub couldn't change
--              its own private items there.
-- The sharing options are named as Google Calendar names them: "See event details", "Make changes
-- and see event details", "Make changes and manage sharing".
create function private.calendar_status(p_writes boolean, p_name text, p_access text, out status text, out detail text)
language sql
stable
set search_path = ''
as $$
  with s as (
    select coalesce(y.auth, 'service_account') as auth,
           case coalesce(y.auth, 'service_account') when 'oauth' then 'owner' else 'writer' end as needs,
           coalesce(y.account, 'Home Hub''s service account') as account
    from (select 1) one
    left join public.calendar_sync y on y.id
  )
  select case
           when not p_writes and p_access in ('reader', 'writerWithoutPrivateAccess', 'writer', 'owner') then 'ok'
           when not p_writes then 'no_access'
           when coalesce(btrim(p_name), '') !~* '^hub' then 'error'
           when p_access = s.needs then 'ok'
           when p_access in ('writer', 'owner') then 'error'
           else 'no_access'
         end,
         case
           when not p_writes and p_access in ('reader', 'writerWithoutPrivateAccess', 'writer', 'owner') then null
           when not p_writes
             then 'Home Hub can''t read this calendar. In Google Calendar, share it with ' || s.account || ' and choose See event details.'
           when coalesce(btrim(p_name), '') !~* '^hub'
             then 'This calendar isn''t named ''Hub …''. The hub writes only to calendars whose name starts with Hub. '
                  'If it is the right one, rename it in Google.'
           when p_access = s.needs then null
           when s.auth = 'oauth'
             then 'This calendar isn''t in the family account: the hub writes only to calendars the family account owns.'
           when p_access = 'owner' then 'Share it with Make changes and see event details, not Make changes and manage sharing.'
           when p_access = 'writerWithoutPrivateAccess'
             then 'Shared with ''Make changes (see private events as free/busy)'': Home Hub can''t change its private items there. '
                  'Share it with ' || s.account || ' and choose Make changes and see event details.'
           else 'Share it with ' || s.account || ' and choose Make changes and see event details.'
         end
  from s;
$$;

-- ---------------------------------------------------------------------
-- calendars: tidy values, and keep the job's writes from looking like an admin's
-- ---------------------------------------------------------------------
-- Trims the label and lowercases the Google ID. A new Google ID (or switching between
-- writing and reading) starts the calendar again: status 'new', and what was learned about
-- the old one is forgotten, Start copying included. Its cached Google events stop showing
-- at once (pages match google_events.google_calendar to google_id) and the next run deletes
-- them: this trigger runs with the admin's rights, which can't write google_events.
-- An update that changes only hub-jobs' columns keeps updated_at and updated_by, so the job's
-- status writes don't look like an admin's edit.
-- Same-event triggers fire in name order: calendars_stamp runs before calendars_tidy.
create function private.calendars_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.label := btrim(new.label);
  new.google_id := lower(btrim(new.google_id));
  if tg_op = 'UPDATE' then
    if new.google_id is distinct from old.google_id or new.writes is distinct from old.writes then
      new.status := 'new';
      new.status_detail := null;
      new.access_role := null;
      new.checked_at := null;
      new.read_at := null;
      new.copy_approved_at := null;
      if new.google_id is distinct from old.google_id then
        new.google_name := null;
      end if;
    elsif new.kind is not distinct from old.kind and new.person_id is not distinct from old.person_id
          and new.label is not distinct from old.label and new.for_kids is not distinct from old.for_kids
          and new.copy_approved_at is not distinct from old.copy_approved_at then
      new.updated_at := old.updated_at;
      new.updated_by := old.updated_by;
    end if;
  end if;
  return new;
end;
$$;

create trigger calendars_stamp before insert or update on public.calendars
  for each row execute function private.stamp();
create trigger calendars_tidy before insert or update on public.calendars
  for each row execute function private.calendars_tidy();

-- ---------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------
alter table public.calendars      enable row level security;
alter table public.calendar_links enable row level security;
alter table public.google_events  enable row level security;
alter table public.calendar_sync  enable row level security;

create policy "Family can see the calendars" on public.calendars
  for select to authenticated using (private.is_member());
create policy "Admins add calendars" on public.calendars
  for insert to authenticated with check (private.is_admin());
create policy "Admins change calendars" on public.calendars
  for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy "Admins remove calendars" on public.calendars
  for delete to authenticated using (private.is_admin());

-- Written by hub-jobs (service_role) only.
create policy "Admins can see what was copied to Google" on public.calendar_links
  for select to authenticated using (private.is_admin());
create policy "Family can see Google events" on public.google_events
  for select to authenticated using (private.is_member());
create policy "Family can see the calendar job" on public.calendar_sync
  for select to authenticated using (private.is_member());

-- Supabase's default privileges give anon and authenticated everything on a new table
-- (truncate ignores row-level security). Anon gets nothing; signed-in users get what
-- the policies above need, and on calendars only the setting columns.
revoke all on public.calendars, public.calendar_links, public.google_events, public.calendar_sync
  from public, anon, authenticated;
grant select on public.calendars, public.calendar_links, public.google_events, public.calendar_sync to authenticated;
grant delete on public.calendars to authenticated;
grant insert (google_id, kind, person_id, label, writes, for_kids) on public.calendars to authenticated;
grant update (google_id, kind, person_id, label, writes, for_kids, copy_approved_at) on public.calendars to authenticated;

-- ---------------------------------------------------------------------
-- Google events as agenda rows (§5.3, §5.4)
-- ---------------------------------------------------------------------

-- One cached Google event as an agenda row (kind 'google'). Whose it is comes from its
-- calendar: a person's calendar is theirs, Pets and House are their owners' (household).
-- notes names the source; notes never reach My day, day_text or the email.
create function private.google_item(g public.google_events, c public.calendars)
returns public.agenda_item
language sql
stable
set search_path = ''
as $$
  select row(
    'google', md5(g.calendar_id::text || '/' || g.event_id)::uuid, g.start_day, g.title, g.start_day, g.end_day, g.all_day,
    g.start_at, g.end_at, (g.start_at at time zone private.tz())::time, (g.end_at at time zone private.tz())::time,
    case c.kind when 'person' then c.person_id
                when 'pets' then (select h.pets_owner_id from public.household h)
                when 'house' then (select h.house_owner_id from public.household h) end,
    '{}', 'open',
    case c.kind when 'family' then 'family' when 'pets' then 'pets' when 'house' then 'home' end,
    null, null, null, null, null,
    g.location, 'From Google Calendar · ' || coalesce(nullif(c.google_name, ''), c.label),
    g.private, g.repeating, false, null, false, null
  )::public.agenda_item;
$$;

-- Events read from Google between two dates (at most 62 days), with the caller's rights:
-- members see them, everyone else sees none. Only rows read from the calendar's current
-- Google ID count. agenda() doesn't change, so nothing read from Google can be written back.
create function public.google_items(p_from date, p_to date)
returns setof public.agenda_item
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 61 then
    raise exception 'google_items() needs a range of 1 to 62 days.' using errcode = '22023';
  end if;

  return query
  select i.*
  from public.google_events g
  join public.calendars c on c.id = g.calendar_id and c.google_id = g.google_calendar
  cross join lateral private.google_item(g, c) i
  where g.start_day <= p_to and g.end_day >= p_from
  order by i.day, i.local_start nulls last, i.title, i.item_id;
end;
$$;

-- The Google events that reach one person's day (§5.4):
--   a person's calendar (writing or read only):  that person
--   Pets / House:                                its owner (household.pets_owner_id / house_owner_id)
--   Family, writing (Hub – Family):              grown-ups' email: every parent and adult; otherwise every kid
--   Family, read only:                           grown-ups' email: every parent and adult; otherwise kids,
--                                                and only with "Show to kids"
-- Helpers get only their own calendar. p_grown_up is true for a parent's or adult's email,
-- false for My day, day_text and the kids' and helpers' email.
create function private.google_for(p_person uuid, p_from date, p_to date, p_grown_up boolean)
returns setof public.agenda_item
language sql
stable
set search_path = ''
as $$
  select i.*
  from public.google_events g
  join public.calendars c on c.id = g.calendar_id and c.google_id = g.google_calendar
  cross join lateral private.google_item(g, c) i
  left join public.people me on me.id = p_person
  where g.start_day <= p_to and g.end_day >= p_from
    and case when c.kind = 'family'
             then case when p_grown_up then me.role in ('parent', 'adult')
                       else me.role = 'kid' and (c.writes or c.for_kids) end
             else i.responsible_id = p_person end
  order by i.day, i.local_start nulls last, i.title, i.item_id;
$$;

-- ---------------------------------------------------------------------
-- Replaced: the day's order and lines treat a Google event like an event, and a
-- person's day includes the Google events that reach it (same signatures as 0002)
-- ---------------------------------------------------------------------

-- Sort order for one day's items: timed items by time, then all-day events (and all-day
-- Google events), then project tasks, then tasks without a time.
create or replace function private.item_order(a public.agenda_item)
returns int
language sql
immutable
set search_path = ''
as $$
  select case when a.local_start is not null then 0 when a.kind in ('event', 'google') then 1 when a.kind = 'project' then 2 else 3 end;
$$;

-- One person's items on one day: theirs (in charge or with), not cancelled, project tasks
-- only on the day they start, and the Google events that reach their day (private.google_for,
-- as for My day: Hub – Family only for kids, read-only calendars only with Show to kids).
create or replace function private.person_items(p_person uuid, p_day date)
returns setof public.agenda_item
language sql
stable
set search_path = ''
as $$
  with rows (a) as (
    select a
    from public.agenda(p_day, p_day) a
    where (a.responsible_id = p_person or p_person = any (a.participant_ids))
      and a.status <> 'cancelled'
      and (a.kind <> 'project' or a.day = p_day)
    union all
    select g
    from private.google_for(p_person, p_day, p_day, false) g
  )
  select (r.a).*
  from rows r
  order by private.item_order(r.a), (r.a).local_start, (r.a).title;
$$;

-- One line of a day's message: "3:00pm Piano · with Taylor · Rivera Music 555-0150 · Side door".
-- The last part is the day's own note, if a parent left one (never the event's notes).
-- Private items show as "Private item", without who, which contractor or a note.
-- An all-day Google event reads "All day: …" like an event.
create or replace function private.text_line(a public.agenda_item, p_person uuid, p_lang text)
returns text
language sql
stable
set search_path = ''
as $$
  select concat_ws(' · ',
    coalesce(private.time_label(a.local_start, p_lang) || ' ', '')
      || case when a.local_start is null and a.kind in ('event', 'google') then private.word('all_day', p_lang) || ': ' else '' end
      || case when a.kind = 'task' then '☐ ' else '' end
      || case when a.kind = 'project' then a.project_name || ': ' else '' end
      || case when a.private then private.word('private_item', p_lang) else a.title end,
    case when not a.private then private.who_text(a, p_person, p_lang) end,
    case when not a.private then nullif(concat_ws(' ', a.contractor_name, a.contractor_phone), '') end,
    case when not a.private then a.day_note end);
$$;

-- One item in the morning email. detail: p_detail (when it was due, for instance), who
-- else is on it, its contractor and a changed day's own note; a hidden private item
-- ("Private item" for kids and helpers) has only p_detail. An all-day Google event says
-- "All day" like an event, and a private Google event is "Private item" for everyone
-- (its title isn't stored).
create or replace function private.digest_item(a public.agenda_item, p_person uuid, p_lang text, p_hide boolean,
                                               p_time text, p_detail text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', a.kind,
    'item_id', a.item_id,
    'occurrence', a.occurrence,
    'time', coalesce(p_time, private.time_label(a.local_start, p_lang),
                     case when a.kind in ('event', 'google') then private.word('all_day', p_lang) end),
    'title', case when h.hide then private.word('private_item', p_lang) else a.title end,
    'detail', case when h.hide then p_detail
                   else nullif(concat_ws(' · ', p_detail, private.who_text(a, p_person, p_lang),
                                         case when a.kind <> 'contract' then a.contractor_name end, a.day_note), '') end,
    'contractor_phone', case when not h.hide then a.contractor_phone end,
    'status', a.status)
  from (select coalesce(p_hide, false) or (a.kind = 'google' and coalesce(a.private, false)) as hide) h;
$$;

-- ---------------------------------------------------------------------
-- The events Google should have (§3.2, §4)
-- ---------------------------------------------------------------------
-- One row per (item, occurrence or job, Google calendar, part), for the calendars the hub
-- writes to, whatever their status or approval (those only hold the writes back, §3.3).
-- Run as service_role (or as an admin, for calendar_preview) so agenda() sees everything.
--   Input: events that aren't cancelled and open tasks due today or later, from agenda();
--          project jobs straight from projects.task_dates (agenda's project rows carry the
--          project's id, so two jobs starting the same day would share an id); every late
--          task, for the late-tasks lines. Never google_events.
--   Routing (§4): the person in charge gets the event and everyone along a copy; 4 or more
--          family members go once on Family; unassigned items go on Family (pets and home
--          tasks on Pets and House when those are set up); project jobs on the owner's
--          calendar, else House, else Family. People without a calendar get no copy.
--   Body:  built here, in the calendar's language; its hash is md5(body::text). Nothing in it
--          depends on the session's DateStyle or TimeZone.
create function private.calendar_desired(p_from date, p_to date, p_site text)
returns table (calendar_id uuid, google_calendar text, base_id text, item_kind text, item_id uuid, job_id text,
               occurrence date, part text, day date, end_day date, title text, private boolean, body jsonb, hash text)
language sql
stable
set search_path = ''
as $$
  with s as (
    select private.tz() as tz, public.today_local() as today, nullif(btrim(p_site), '') as site
  ),
  -- The calendars the hub writes to, the language of their fixed words, and whether grown-ups
  -- read them (they get the "Skip this day" hint and the link to the hub). A person's calendar
  -- counts only while they are on the family list.
  cal as (
    select c.id, c.google_id, c.kind, c.person_id, c.label,
           case when c.kind = 'person' then p.language else 'en' end as lang,
           c.kind <> 'person' or p.role in ('parent', 'adult') as grown_up
    from public.calendars c
    left join public.people p on p.id = c.person_id
    where c.writes and (c.kind <> 'person' or coalesce(p.active, false))
  ),
  -- Events and tasks; people off the family list count as nobody (private.active_only), and
  -- each person along counts once. Health tasks are private, whatever their own switch.
  src as (
    select x.kind, x.item_id, x.occurrence, x.title, x.day, x.end_day, x.all_day, x.start_at,
           case when x.kind = 'task' then x.start_at + interval '30 minutes' else x.end_at end as end_at,
           x.responsible_id as resp,
           array(select u.id from unnest(x.participant_ids) with ordinality u (id, n)
                 where u.id is distinct from x.responsible_id
                 group by u.id order by min(u.n)) as parts,
           x.category, x.location,
           nullif(concat_ws(' ', x.contractor_name, x.contractor_phone), '') as contact,
           coalesce(x.private, false) or coalesce(x.category = 'health', false) as hidden,
           coalesce(x.repeating, false) as repeating
    from public.agenda(p_from, p_to) a
    cross join lateral private.active_only(a) x
    cross join s
    where (x.kind = 'event' and x.status <> 'cancelled')
       or (x.kind = 'task' and x.status = 'open' and x.occurrence >= s.today)
  ),
  -- Rule 3: an event with 4 or more family members (parents, adults, kids) goes once on Family.
  ev as (
    select e.*,
           exists (select 1 from cal f where f.kind = 'family')
           and (select count(*) from public.people p
                where (p.id = e.resp or p.id = any (e.parts)) and p.role in ('parent', 'adult', 'kid')) >= 4 as on_family
    from src e
    where e.kind = 'event'
  ),
  ev_rows as (
    select e.*, f.id as cal_id, 'family'::text as how, null::uuid as who
    from ev e join cal f on f.kind = 'family'
    where e.on_family
    union all
    -- Rule 1: the person in charge (on a Family event, only a helper still gets her own copy).
    select e.*, c.id, 'charge', e.resp
    from ev e join cal c on c.kind = 'person' and c.person_id = e.resp
    where not e.on_family or exists (select 1 from public.people p where p.id = e.resp and p.role = 'helper')
    union all
    -- Rules 2 and 5b: a copy for each person along.
    select e.*, c.id, 'along', u.id
    from ev e
    cross join lateral unnest(e.parts) u (id)
    join cal c on c.kind = 'person' and c.person_id = u.id
    where not e.on_family or exists (select 1 from public.people p where p.id = u.id and p.role = 'helper')
    union all
    -- Rule 5: nobody in charge and nobody along.
    select e.*, f.id, 'nobody', null
    from ev e join cal f on f.kind = 'family'
    where e.resp is null and cardinality(e.parts) = 0
  ),
  ev_out (cal_id, kind, item_id, job_id, occurrence, part, day, end_day, all_day, start_at, end_at,
          hidden, repeating, title, who_line, location, contact) as (
    select r.cal_id, r.kind, r.item_id, null::text, r.occurrence, ''::text, r.day, r.end_day, r.all_day, r.start_at, r.end_at,
           r.hidden, r.repeating,
           case when r.hidden then private.word('private_item', c.lang)
                when r.how = 'charge'
                  then r.title || coalesce(' (' || private.word('with', c.lang) || ' ' || private.names(r.parts) || ')', '')
                when r.how = 'along' and r.resp is not null
                  then r.title || coalesce(' (' || private.names(array[r.resp]) || ')', '')
                when r.how = 'along'
                  then r.title || coalesce(' (' || private.word('with', c.lang) || ' ' || private.names(array_remove(r.parts, r.who)) || ')', '')
                else r.title end,
           case when r.how = 'family'
                then replace(private.calendar_word('who_is_on', c.lang), '{names}',
                             concat_ws(' ' || private.word('with', c.lang) || ' ',
                                       private.names(array[r.resp]), private.names(r.parts))) end,
           r.location, r.contact
    from ev_rows r join cal c on c.id = r.cal_id
  ),
  -- Tasks (rules 1, 4 and 6): the person in charge's calendar; nobody in charge: Pets, House
  -- or Family by category, then Family. Pets and home tasks someone is in charge of get a prefix.
  tk_out as (
    select t.cal_id, 'task'::text, t.item_id, null::text, t.occurrence, ''::text, t.day, t.end_day, t.all_day, t.start_at, t.end_at,
           t.hidden, t.repeating,
           '☐ ' || case when t.hidden then private.word('private_item', c.lang)
                        else coalesce(case when t.resp is not null and t.category = 'pets'
                                             then coalesce((select p.label from cal p where p.kind = 'pets'), private.calendar_word('pets', c.lang))
                                           when t.resp is not null and t.category = 'home'
                                             then coalesce((select h.label from cal h where h.kind = 'house'), private.calendar_word('house', c.lang))
                                      end || ': ', '') || t.title end,
           null::text, null::text, t.contact
    from (
      select x.*,
             case when x.resp is not null then (select c.id from cal c where c.kind = 'person' and c.person_id = x.resp)
                  else coalesce(case x.category when 'pets' then (select c.id from cal c where c.kind = 'pets')
                                                when 'home' then (select c.id from cal c where c.kind = 'house') end,
                                (select c.id from cal c where c.kind = 'family')) end as cal_id
      from src x
      where x.kind = 'task'
    ) t
    join cal c on c.id = t.cal_id
  ),
  -- Project jobs (rule 11), as agenda() picks them; the first row per (project, job id).
  jobs as (
    select distinct on (p.id, x.value ->> 'id')
           p.id as project_id, p.name as project_name, p.schedule, private.active_person(p.owner_id) as owner, x.value as job
    from public.projects p
    cross join lateral jsonb_array_elements(p.task_dates) with ordinality x (value, n)
    where p.on_calendar and p.task_dates is not null and p.status not in ('idea', 'on-hold', 'done')
      and x.value ->> 'id' is not null
    order by p.id, x.value ->> 'id', x.n
  ),
  job_days as (
    select j.project_id, j.project_name, j.owner, j.job ->> 'id' as job_id, coalesce(j.job ->> 'name', '') as job_name,
           private.safe_date(j.job ->> 'start') as s_day, private.safe_date(j.job ->> 'end') as e_day,
           coalesce(j.job -> 'milestone' = 'true', false) as milestone,
           nullif(concat_ws(' ', k.name, k.phone), '') as contact
    from jobs j
    left join public.contractors k on k.id::text = j.schedule -> 'trades' -> (j.job ->> 'trade') ->> 'contractor_id'
    where coalesce(j.job ->> 'status', '') <> 'done'
  ),
  -- A job over 2 calendar days or less (or a milestone) is one all-day event over its days;
  -- a longer one is two markers, "starts" on its first day and "finishes" on its last, each
  -- only when its day is in the range.
  pj as (
    select coalesce((select c.id from cal c where c.kind = 'person' and c.person_id = d.owner),
                    (select c.id from cal c where c.kind = 'house'),
                    (select c.id from cal c where c.kind = 'family')) as cal_id,
           d.project_id, d.job_id, m.part, m.day, m.end_day, d.project_name || ': ' || d.job_name as title, m.word, d.contact
    from job_days d
    cross join lateral (
      select ''::text as part, d.s_day as day, d.e_day as end_day, null::text as word
      where d.milestone or d.e_day - d.s_day + 1 <= 2
      union all
      select 'start', d.s_day, d.s_day, 'starts'
      where not (d.milestone or d.e_day - d.s_day + 1 <= 2) and d.s_day between p_from and p_to
      union all
      select 'finish', d.e_day, d.e_day, 'finishes'
      where not (d.milestone or d.e_day - d.s_day + 1 <= 2) and d.e_day between p_from and p_to
    ) m
    where d.s_day is not null and d.e_day is not null and d.e_day >= d.s_day and d.s_day <= p_to and d.e_day >= p_from
  ),
  pj_out as (
    select p.cal_id, 'project'::text, p.project_id, p.job_id, null::date, p.part, p.day, p.end_day, true,
           null::timestamptz, null::timestamptz, false, false,
           p.title || case p.word when 'starts' then ' ' || private.word('starts', c.lang)
                                  when 'finishes' then ' ' || private.calendar_word('finishes', c.lang) else '' end,
           null::text, null::text, p.contact
    from pj p join cal c on c.id = p.cal_id
  ),
  -- Rule 8: late tasks aren't events of their own. Each calendar that has some (by the task
  -- rules) gets one all-day line on today: "2 late: Heartworm pill, Nail trim". Private and
  -- health tasks are counted and shown as "Private item".
  late_out as (
    select l.cal_id, 'late'::text, null::uuid, null::text, null::date, ''::text, s.today, s.today, true,
           null::timestamptz, null::timestamptz, false, false,
           private.count_word('n_late', count(*)::int, c.lang) || ': '
             || string_agg(case when l.hidden then private.word('private_item', c.lang) else l.title end, ', ' order by l.due, l.title),
           null::text, null::text, null::text
    from (
      select x.title, x.day as due,
             coalesce(x.private, false) or coalesce(x.category = 'health', false) as hidden,
             case when x.responsible_id is not null
                  then (select c.id from cal c where c.kind = 'person' and c.person_id = x.responsible_id)
                  else coalesce(case x.category when 'pets' then (select c.id from cal c where c.kind = 'pets')
                                                when 'home' then (select c.id from cal c where c.kind = 'house') end,
                                (select c.id from cal c where c.kind = 'family')) end as cal_id
      from public.late_items() i
      cross join lateral private.active_only(i) x
    ) l
    join cal c on c.id = l.cal_id
    cross join s
    where s.today between p_from and p_to
    group by l.cal_id, c.lang, s.today
  ),
  all_rows as (
    select * from ev_out
    union all select * from tk_out
    union all select * from pj_out
    union all select * from late_out
  ),
  built as (
    select r.*, c.google_id, c.grown_up, k.base,
           left(r.title, 120) as summary,
           concat_ws(E'\n',
             private.calendar_word('made_by_hub', c.lang)
               || case when r.kind = 'event' and r.repeating and c.grown_up then ' ' || private.calendar_word('skip_hint', c.lang) else '' end,
             case when not r.hidden then r.who_line end,
             case when not r.hidden then r.contact end,
             case when not r.hidden and c.grown_up and s.site is not null
                  then replace(private.calendar_word('open_in_hub', c.lang), '{url}',
                               s.site || '#/calendar/' || to_char(r.day::timestamp, 'YYYY-MM-DD')) end) as description
    from all_rows r
    join cal c on c.id = r.cal_id
    cross join s
    cross join lateral (select private.calendar_event_id(
                          private.calendar_key(r.kind, r.item_id, r.job_id, r.occurrence, c.google_id, r.part)) as base) k
  ),
  bodies as (
    select b.*, jsonb_strip_nulls(jsonb_build_object(
             'id', b.base,
             'status', 'confirmed',
             'summary', b.summary,
             'location', case when b.kind = 'event' and not b.hidden then nullif(btrim(b.location), '') end,
             'description', b.description,
             'start', case when b.all_day or b.start_at is null
                           then jsonb_build_object('date', to_char(b.day::timestamp, 'YYYY-MM-DD'))
                           else jsonb_build_object('dateTime', to_char(b.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                                   'timeZone', s.tz) end,
             'end', case when b.all_day or b.start_at is null
                         then jsonb_build_object('date', to_char((b.end_day + 1)::timestamp, 'YYYY-MM-DD'))
                         else jsonb_build_object('dateTime', to_char(b.end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                                 'timeZone', s.tz) end,
             'transparency', case when b.all_day or b.start_at is null then 'transparent' else 'opaque' end,
             'visibility', case when b.hidden then 'private' else 'default' end,
             'extendedProperties', jsonb_build_object('private', jsonb_build_object(
               'homehub', '1',
               'homehub_base', b.base,
               'homehub_kind', b.kind,
               'homehub_item', b.item_id::text,
               'homehub_occurrence', to_char(b.occurrence::timestamp, 'YYYY-MM-DD'),
               'homehub_job', b.job_id,
               'homehub_part', nullif(b.part, ''))))) as body
    from built b
    cross join s
  )
  -- Two rows can't share an id on one Google calendar: the first in a fixed order is kept.
  select distinct on (x.google_id, x.base)
         x.cal_id, x.google_id, x.base, x.kind, x.item_id, x.job_id, x.occurrence, x.part, x.day, x.end_day,
         x.summary, x.hidden, x.body, md5(x.body::text)
  from bodies x
  order by x.google_id, x.base, x.day, x.summary, x.kind, x.item_id;
$$;

-- ---------------------------------------------------------------------
-- Pages: the preview before "Start copying" (admins)
-- ---------------------------------------------------------------------
-- Everything Start copying puts on one calendar: the job's whole window (yesterday to 60 days
-- ahead), as the wall will show it, so nothing goes on the wall unseen. private: the item shows as
-- "Private item" (it is private, or a health task). item_kind is 'event', 'task', 'project'
-- or 'late' (the late-tasks line, item_id null); only events and tasks can be made private.
-- place is the event's place as copied, details the rest of what the event's description shows
-- on the wall (who's on it, a directory entry's name and number), one line, or null.
create function public.calendar_preview(p_calendar uuid)
returns table (day date, title text, private boolean, item_kind text, item_id uuid, place text, details text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_admin() then
    raise exception 'Only an admin can see what goes on a calendar.' using errcode = '42501';
  end if;
  return query
  select d.day, d.title, d.private, d.item_kind, d.item_id, d.body ->> 'location',
         nullif(array_to_string((string_to_array(d.body ->> 'description', E'\n'))[2:], ' · '), '')
  from private.calendar_desired(public.today_local() - 1, public.today_local() + 60, null) d
  where d.calendar_id = p_calendar
  order by d.day, d.body -> 'start' ->> 'dateTime' nulls first, d.title, d.base_id;
end;
$$;

-- ---------------------------------------------------------------------
-- The calendar job (hub-jobs {action: 'calendar'}, service_role only)
-- ---------------------------------------------------------------------

-- Takes the lease for one run: {go, stop, run_id}. One update takes it, so two callers can't
-- both get go. stop is 'paused' while Google's "slow down" lasts, or 'busy' while another run
-- holds the lease (a run older than 10 minutes counts as dead).
create function public.calendar_begin()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run uuid;
begin
  insert into public.calendar_sync (id) values (true) on conflict (id) do nothing;
  if exists (select 1 from public.calendar_sync y where y.id and y.paused_until > private.now()) then
    return jsonb_build_object('go', false, 'stop', 'paused', 'run_id', null);
  end if;
  update public.calendar_sync
  set running_since = private.now(), run_id = gen_random_uuid()
  where id and (running_since is null or running_since < private.now() - interval '10 minutes')
    and not coalesce(paused_until > private.now(), false)
  returning run_id into v_run;
  if v_run is null then
    return jsonb_build_object('go', false, 'stop', 'busy', 'run_id', null);
  end if;
  return jsonb_build_object('go', true, 'stop', null, 'run_id', v_run);
end;
$$;

-- How this run signed in, once Google has given it a token: 'service_account' with the
-- account's address and the key's id, or 'oauth'. Only while p_run holds the lease's id.
create function public.calendar_signed_in(p_run uuid, p_auth text, p_account text, p_key_id text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_auth is null or p_auth not in ('service_account', 'oauth') then
    raise exception 'calendar_signed_in: auth must be service_account or oauth.' using errcode = '22023';
  end if;
  update public.calendar_sync
  set auth = p_auth,
      account = case when p_auth = 'service_account' then nullif(private.clean_text(p_account, 200), '') end,
      key_id = nullif(private.clean_text(p_key_id, 100), '')
  where id and run_id = p_run;
end;
$$;

-- The calendars to read now (§5.1): never-read ones first, then the one Google answered about
-- longest ago (a calendar whose reads are always cut off keeps an old read_at, so it doesn't go
-- first every time). A calendar is due when its last complete read is 14 minutes old; one that is
-- no_access or error at most once an hour, so fixed sharing is noticed by itself. p_force (an
-- admin's Sync now): every calendar.
-- time_min and time_max are local midnight at the start of the window and after its last day.
create function public.calendar_read_due(p_force boolean default false, p_limit int default 10)
returns table (calendar_id uuid, google_id text, writes boolean, w_from date, w_to date,
               time_min timestamptz, time_max timestamptz, tz text)
language sql
stable
security invoker
set search_path = ''
as $$
  with s as (
    select public.today_local() - 1 as w_from, public.today_local() + 60 as w_to, private.tz() as tz, private.now() as now
  )
  select c.id, c.google_id, c.writes, s.w_from, s.w_to,
         s.w_from::timestamp at time zone s.tz, (s.w_to + 1)::timestamp at time zone s.tz, s.tz
  from public.calendars c
  cross join s
  where coalesce(p_force, false)
     or (c.status in ('new', 'ok') and (c.read_at is null or c.read_at < s.now - interval '14 minutes'))
     or (c.status in ('no_access', 'error')
         and (coalesce(c.checked_at, c.read_at) is null or coalesce(c.checked_at, c.read_at) < s.now - interval '1 hour'))
  order by c.read_at is not null, greatest(c.read_at, c.checked_at) nulls first, c.id
  limit greatest(coalesce(p_limit, 10), 0);
$$;

-- Stores one calendar's read, in one transaction (§5.2), and returns
-- {kept, skipped, seen, repaired, adopted}. Does nothing if the calendar is gone or its
-- google_id is no longer p_google_id (it was re-pointed during the run).
-- p_events: what Google listed, each as hub-jobs maps it:
--   {id, status, title, location, start: {date} | {dateTime}, end: {date} | {dateTime}, visibility,
--    recurring, updated, organizer_self, response, props, hash}
--   (props: the event's extendedProperties.private, or null; response: the calendar's own
--   attendee answer, or null; hash: the content hash of Google's copy).
-- p_seen: the hub's own events (props.homehub set and an id like hh + 32 hex), in the same
--   shape. They may also come in p_events: either way they are never cached, a hub event
--   missing from a complete read was deleted in Google, and one without a link is adopted.
-- Kept: confirmed or tentative events the calendar made or accepted, not the hub's own (nor any
-- id the hub linked on that calendar), whose dates can be read. A private or confidential one is
-- stored without its title or place. At most 1,000; past that the read counts as cut off.
-- A cut-off read (p_complete false) replaces only the days it covered, and skips repairs and
-- adoptions.
create function public.calendar_store_events(p_calendar uuid, p_google_id text, p_from date, p_to date, p_name text,
                                             p_access text, p_complete boolean, p_events jsonb, p_seen jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cal        public.calendars;
  v_now      timestamptz := private.now();
  v_tz       text := private.tz();
  v_complete boolean := coalesce(p_complete, false);
  v_status   text;
  v_detail   text;
  v_items    jsonb;
  e          jsonb;
  v_id       text;
  v_props    jsonb;
  v_hub      boolean;
  v_all_day  boolean;
  v_s_day    date;
  v_e_day    date;
  v_s_at     timestamptz;
  v_e_at     timestamptz;
  v_upd      timestamptz;
  v_private  boolean;
  v_ok       boolean;
  v_keep     public.google_events[] := '{}';
  v_ids      text[] := '{}';
  v_seen     jsonb := '{}';
  v_last_day date;
  l          public.calendar_links;
  s          jsonb;
  v_kind     text;
  v_n        int;
  v_base     text;
  v_wanted   text[];      -- the base_ids the plan wants on this calendar (worked out once, if needed)
  n_skipped  int := 0;
  n_repaired int := 0;
  n_adopted  int := 0;
begin
  select * into cal from public.calendars c where c.id = p_calendar and c.google_id = p_google_id for update;
  if not found then
    return jsonb_build_object('kept', 0, 'skipped', 0, 'seen', 0, 'repaired', 0, 'adopted', 0);
  end if;

  select x.status, x.detail into v_status, v_detail
  from private.calendar_status(cal.writes, coalesce(p_name, cal.google_name), coalesce(p_access, cal.access_role)) x;

  v_items := case when jsonb_typeof(p_events) = 'array' then p_events else '[]' end
          || case when jsonb_typeof(p_seen) = 'array' then p_seen else '[]' end;

  for e in select x from jsonb_array_elements(v_items) x loop
    v_ok := true;
    begin
      v_id := e ->> 'id';
      v_props := case when jsonb_typeof(e -> 'props') = 'object' then e -> 'props' end;
      v_hub := v_props ->> 'homehub' is not null and coalesce(v_id ~ '^hh[0-9a-f]{32}$', false);
      if v_id is null or v_id = '' or (not v_hub and v_id = any (v_ids)) or coalesce(e ->> 'status', '') = 'cancelled' then
        raise exception 'skip';
      end if;

      -- The dates, as the household's days (§5.2). For the hub's own events a bad date only
      -- means they can't be adopted.
      v_s_day := null; v_e_day := null; v_s_at := null; v_e_at := null;
      begin
        if e -> 'start' ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$' then
          v_all_day := true;
          v_s_day := (e -> 'start' ->> 'date')::date;
          v_e_day := greatest(v_s_day, case when e -> 'end' ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$'
                                            then (e -> 'end' ->> 'date')::date - 1 end);
        elsif e -> 'start' ->> 'dateTime' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' then
          v_all_day := false;
          v_s_at := (e -> 'start' ->> 'dateTime')::timestamptz;
          v_e_at := greatest(v_s_at, case when e -> 'end' ->> 'dateTime' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
                                          then (e -> 'end' ->> 'dateTime')::timestamptz end);
          v_s_day := (v_s_at at time zone v_tz)::date;
          v_e_day := greatest(v_s_day, ((v_e_at - interval '1 microsecond') at time zone v_tz)::date);
        end if;
      exception when others then
        v_s_day := null;
      end;
      v_upd := case when e ->> 'updated' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' then (e ->> 'updated')::timestamptz end;

      if v_hub then
        -- The hub's own: never cached; kept for the repairs and adoptions below.
        if not v_seen ? v_id then
          v_seen := v_seen || jsonb_build_object(v_id, jsonb_build_object(
            'updated', v_upd, 'hash', e ->> 'hash', 'day', v_s_day, 'end_day', v_e_day, 'props', v_props,
            'title', private.clean_text(coalesce(e ->> 'title', ''), 120)));
        end if;
        v_ok := false;
      elsif not (coalesce(e -> 'organizer_self' = 'true', false) or coalesce(e ->> 'response' in ('accepted', 'tentative'), false)) then
        raise exception 'skip';   -- an invitation nobody accepted
      elsif exists (select 1 from public.calendar_links k where k.google_calendar = p_google_id and k.event_id = v_id) then
        raise exception 'skip';   -- an id the hub linked on this calendar
      elsif v_s_day is null then
        raise exception 'skip';   -- dates that can't be read
      elsif cardinality(v_keep) >= 1000 then
        v_complete := false;      -- too many to keep: the rest is left out, as a cut-off read
        raise exception 'skip';
      else
        v_private := coalesce(e ->> 'visibility' in ('private', 'confidential'), false);
        v_keep := v_keep || row(
          p_calendar, p_google_id, v_id,
          case when v_private then '' else private.clean_text(coalesce(e ->> 'title', ''), 200) end,
          case when not v_private then nullif(private.clean_text(e ->> 'location', 200), '') end,
          v_all_day, v_s_day, v_e_day, v_s_at, v_e_at, v_private,
          coalesce(e -> 'recurring' = 'true', false), v_upd, v_now)::public.google_events;
        v_ids := v_ids || v_id;
        v_last_day := greatest(v_last_day, v_s_day);
        v_ok := false;
      end if;
    exception when others then
      v_ok := true;
    end;
    if v_ok then
      n_skipped := n_skipped + 1;
    end if;
  end loop;

  update public.calendars
  set google_name = coalesce(nullif(private.clean_text(p_name, 200), ''), google_name),
      access_role = coalesce(nullif(private.clean_text(p_access, 40), ''), access_role),
      checked_at = v_now,
      read_at = case when v_complete then v_now else read_at end,
      status = v_status,
      status_detail = v_detail
  where id = p_calendar;

  -- The cache: a complete read replaces it; a cut-off read replaces the days it covered.
  -- A calendar the hub can't read properly keeps nothing.
  if v_status = 'no_access' then
    delete from public.google_events where calendar_id = p_calendar;
    v_keep := '{}';
  elsif v_complete then
    delete from public.google_events where calendar_id = p_calendar;
  else
    delete from public.google_events
    where calendar_id = p_calendar
      and (google_calendar <> p_google_id or start_day < v_last_day or event_id = any (v_ids));
  end if;
  insert into public.google_events select * from unnest(v_keep);

  -- Changes made in Google to the hub's events are put back (§5.2): only on a calendar the
  -- hub writes and may write now (ok, and approved with Start copying), after a complete read,
  -- for links written successfully whose days are in the window, and only for events the plan
  -- will write again (still wanted: not a stale project's, not one about to be deleted), so
  -- what is recorded as put back really is. (A link ending on the window's first day is left
  -- out: Google doesn't list an event that ends exactly at the window's start.)
  if cal.writes and v_complete and v_status = 'ok' then
    for l in
      select * from public.calendar_links k
      where k.google_calendar = p_google_id and k.status = 'ok' and k.synced_at is not null
        and k.day <= p_to and k.end_day > p_from and cal.copy_approved_at is not null
      for update
    loop
      s := v_seen -> l.event_id;
      v_kind := case when s is null then 'deleted'
                     when (s ->> 'updated')::timestamptz is distinct from l.google_updated
                          and s ->> 'hash' is distinct from l.google_hash then 'edited' end;
      continue when v_kind is null;
      if v_wanted is null then
        v_wanted := array(select d.base_id from private.calendar_desired(p_from, p_to, null) d where d.google_calendar = p_google_id);
      end if;
      continue when not (l.base_id = any (v_wanted));
      v_n := case when l.repaired_at is null or l.repaired_at < v_now - interval '24 hours' then 1 else l.repairs + 1 end;
      update public.calendar_links
      set hash = null, repaired_at = v_now, repair_kind = v_kind, repairs = v_n,
          status = case when v_n >= 4 then 'error' else status end,
          error = case when v_n >= 4 then 'Google keeps changing this event' else error end,
          -- tried_hash stays the hash last written, so only a change in the hub tries again sooner.
          next_try_at = case when v_n >= 4 then v_now + interval '1 day' else next_try_at end,
          failing_since = case when v_n >= 4 then coalesce(failing_since, v_now) else failing_since end
      where google_calendar = l.google_calendar and base_id = l.base_id;
      n_repaired := n_repaired + 1;
    end loop;

    -- Orphans: hub events with no link (a run died between Google and calendar_record) get one,
    -- with hash null, so the next plan updates or deletes them. A bad value skips that event.
    for v_id, s in select key, value from jsonb_each(v_seen) loop
      continue when exists (select 1 from public.calendar_links k where k.google_calendar = p_google_id and k.event_id = v_id);
      begin
        v_base := s -> 'props' ->> 'homehub_base';
        if v_base is null or v_base !~ '^hh[0-9a-f]{32}$'
           or exists (select 1 from public.calendar_links k where k.google_calendar = p_google_id and k.base_id = v_base) then
          v_base := v_id;
        end if;
        if s ->> 'day' is null or (s -> 'props' ->> 'homehub_occurrence' is not null
                                   and s -> 'props' ->> 'homehub_occurrence' !~ '^\d{4}-\d{2}-\d{2}$') then
          raise exception 'skip';
        end if;
        insert into public.calendar_links (google_calendar, base_id, event_id, gen, calendar_id, item_kind, item_id, job_id,
                                           occurrence, part, day, end_day, title, hash, google_hash, google_updated,
                                           status, synced_at)
        values (p_google_id, v_base, v_id, 0, p_calendar, s -> 'props' ->> 'homehub_kind', (s -> 'props' ->> 'homehub_item')::uuid,
                s -> 'props' ->> 'homehub_job', (s -> 'props' ->> 'homehub_occurrence')::date,
                coalesce(s -> 'props' ->> 'homehub_part', ''), (s ->> 'day')::date, (s ->> 'end_day')::date,
                coalesce(s ->> 'title', ''), null, s ->> 'hash', (s ->> 'updated')::timestamptz, 'pending', v_now);
        n_adopted := n_adopted + 1;
      exception when others then
        null;
      end;
    end loop;
  end if;

  return jsonb_build_object('kept', cardinality(v_keep), 'skipped', n_skipped, 'seen', (select count(*) from jsonb_object_keys(v_seen)),
                            'repaired', n_repaired, 'adopted', n_adopted);
end;
$$;

-- What a failed read, a write's 403 or a Test found about one calendar, while its google_id is
-- still p_google_id. 'ok' is recorded only if the name and access role pass the rules a read
-- uses (private.calendar_status); otherwise what those rules say. 'no_access' also deletes the
-- calendar's cached Google events.
create function public.calendar_mark(p_calendar uuid, p_google_id text, p_status text, p_detail text default null,
                                     p_name text default null, p_access text default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cal      public.calendars;
  v_status text := p_status;
  v_detail text := private.clean_error(p_detail);
  v_name   text := nullif(private.clean_text(p_name, 200), '');
  v_access text := nullif(private.clean_text(p_access, 40), '');
begin
  if p_status is null or p_status not in ('new', 'ok', 'no_access', 'error') then
    raise exception 'calendar_mark: status must be new, ok, no_access or error.' using errcode = '22023';
  end if;
  select * into cal from public.calendars c where c.id = p_calendar and c.google_id = p_google_id for update;
  if not found then
    return;
  end if;
  if p_status = 'ok' then
    select x.status, x.detail into v_status, v_detail
    from private.calendar_status(cal.writes, coalesce(v_name, cal.google_name), coalesce(v_access, cal.access_role)) x;
  end if;
  update public.calendars
  set status = v_status, status_detail = v_detail,
      google_name = coalesce(v_name, google_name), access_role = coalesce(v_access, access_role),
      checked_at = private.now()
  where id = p_calendar;
  if v_status = 'no_access' then
    delete from public.google_events where calendar_id = p_calendar;
  end if;
end;
$$;

-- The next Google writes (§3.3), read only: what calendar_desired says Google should have for
-- the window (yesterday to 60 days ahead), compared with calendar_links on (Google calendar,
-- base_id). Each row also carries pending (all the writes still to do) and hiding (how many of
-- those hide something: an update that makes an item private, or a delete).
--   insert: desired, and never written (no link, or synced_at null)
--   update: desired, and the body changed (or hash is null: write it again)
--   delete: not desired, and the link ends in the window; or in the past, but its item was
--           deleted or is now private (or a health task), or it is a late-tasks line; or its
--           mapping is gone (calendar_id null, the calendar points elsewhere or only reads now)
-- Held back: inserts and updates for a calendar that isn't ok, wasn't seen with the access
-- role this sign-in needs, or wasn't approved (Start copying); deletes on a calendar that is
-- no_access or error (but not a gone mapping's); a link backing off (next_try_at) unless the
-- hub's version changed since the last try; the links of a project whose dates are stale; and
-- everything while Google's pause lasts.
-- Except: hiding what the hub itself wrote never waits for a calendar in error while Google still
-- lets the hub write there (access role writer or owner: renamed in Google, shared with "Make
-- changes and manage sharing", or one refused read). An update that makes an item private, and a
-- delete, of a link written there (synced_at set) go ahead; inserts and other updates still wait.
-- Order: updates that make an item private; then deletes in the window, and any delete of an item
-- that is now private (or a health task); then the rest by day, title, base_id; then the other
-- deletes of the past (deleted items, old late lines, a disconnected calendar's history), so a
-- mass delete of history never holds up today's changes.
create function public.calendar_plan(p_site text default null, p_limit int default 60)
returns table (op text, calendar_id uuid, google_calendar text, base_id text, event_id text, gen int,
               item_kind text, item_id uuid, job_id text, occurrence date, part text, day date, end_day date,
               title text, body jsonb, hash text, pending int, hiding int)
language sql
stable
security invoker
set search_path = ''
as $$
  with s as (
    select public.today_local() - 1 as w_from, public.today_local() + 60 as w_to, private.now() as now,
           case y.auth when 'oauth' then 'owner' else 'writer' end as role
    from public.calendar_sync y
    where y.id and not coalesce(y.paused_until > private.now(), false)
  ),
  d as (
    select x.* from s cross join lateral private.calendar_desired(s.w_from, s.w_to, p_site) x
  ),
  wanted as (
    select case when l.base_id is null or l.synced_at is null then 'insert' else 'update' end as op,
           d.calendar_id, d.google_calendar, d.base_id, coalesce(l.event_id, d.base_id) as event_id, coalesce(l.gen, 0) as gen,
           d.item_kind, d.item_id, d.job_id, d.occurrence, d.part, d.day, d.end_day, d.title, b.body, md5(b.body::text) as hash,
           l.base_id as link, l.synced_at, l.hash as link_hash, l.next_try_at, l.tried_hash,
           c.status, c.access_role, c.copy_approved_at
    from d
    join public.calendars c on c.id = d.calendar_id
    left join public.calendar_links l on l.google_calendar = d.google_calendar and l.base_id = d.base_id
    cross join lateral (select case when l.event_id is not null and l.event_id <> d.base_id
                                    then jsonb_set(d.body, '{id}', to_jsonb(l.event_id)) else d.body end as body) b
  ),
  -- grp, the order: 0 updates that make an item private; 1 deletes that hide something now (in
  -- the window, or of an item that is now private or a health task); 2 the rest; 3 the other
  -- deletes of the past.
  ops as (
    select w.op, w.calendar_id, w.google_calendar, w.base_id, w.event_id, w.gen, w.item_kind, w.item_id, w.job_id,
           w.occurrence, w.part, w.day, w.end_day, w.title, w.body, w.hash,
           case when w.op = 'update' and w.body ->> 'visibility' = 'private' then 0 else 2 end as grp
    from wanted w
    cross join s
    where (w.link is null or w.synced_at is null or w.link_hash is distinct from w.hash)
      and ((w.status = 'ok' and w.access_role = s.role and w.copy_approved_at is not null)
           -- Making private what the hub already wrote there waits for nothing but write access.
           or (w.op = 'update' and w.synced_at is not null and w.body ->> 'visibility' = 'private'
               and w.status in ('ok', 'error') and w.access_role in ('writer', 'owner')))
      and not coalesce(w.next_try_at > s.now and w.hash is not distinct from w.tried_hash, false)
    union all
    select 'delete', l.calendar_id, l.google_calendar, l.base_id, l.event_id, l.gen, l.item_kind, l.item_id, l.job_id,
           l.occurrence, l.part, l.day, l.end_day, l.title, null, null,
           case when l.end_day >= s.w_from
                     or (l.item_kind = 'event' and exists (select 1 from public.events e where e.id = l.item_id and e.private))
                     or (l.item_kind = 'task' and exists (select 1 from public.tasks t
                                                          where t.id = l.item_id and (t.private or t.category = 'health')))
                then 1 else 3 end
    from public.calendar_links l
    cross join s
    left join public.calendars c on c.id = l.calendar_id
    where not exists (select 1 from d where d.google_calendar = l.google_calendar and d.base_id = l.base_id)
      and not coalesce(l.next_try_at > s.now and l.tried_hash = 'delete', false)
      and (c.id is null or c.google_id <> l.google_calendar or not c.writes
           or ((c.status not in ('no_access', 'error')
                -- A calendar in error that the hub can still write to: what it wrote there comes off.
                or (c.status = 'error' and c.access_role in ('writer', 'owner') and l.synced_at is not null))
               and not (l.item_kind = 'project'
                        and exists (select 1 from public.projects p
                                    where p.id = l.item_id and p.on_calendar and p.task_dates is null
                                      and p.status not in ('idea', 'on-hold', 'done')))
               and (l.end_day >= s.w_from
                    or case l.item_kind
                         when 'event' then not exists (select 1 from public.events e where e.id = l.item_id and not e.private)
                         when 'task' then not exists (select 1 from public.tasks t
                                                      where t.id = l.item_id and not t.private and t.category <> 'health')
                         when 'project' then not exists (select 1 from public.projects p
                                                         where p.id = l.item_id
                                                           and (p.task_dates is null
                                                                or exists (select 1 from jsonb_array_elements(p.task_dates) x
                                                                           where x ->> 'id' = l.job_id)))
                         else true end)))
  )
  select o.op, o.calendar_id, o.google_calendar, o.base_id, o.event_id, o.gen, o.item_kind, o.item_id, o.job_id,
         o.occurrence, o.part, o.day, o.end_day, o.title, o.body, o.hash,
         (count(*) over ())::int, (count(*) filter (where o.grp <> 2) over ())::int
  from ops o
  order by o.grp, o.day, o.title, o.base_id
  limit greatest(coalesce(p_limit, 60), 0);
$$;

-- What Google answered for a batch of plan rows (§3.3): p_results is an array of plan rows,
-- each with ok, gone, clash, forget, google_hash, google_updated, http and error added.
-- Each row is recorded in its own sub-block, so one bad row doesn't lose the others.
-- calendar_id is looked up again (null if the calendar was disconnected during the run, so the
-- next plan deletes the event); google_calendar is the plan row's, as it is.
--   insert or update done:   the link is ok, with the hash written and Google's hash and time
--   delete done, or gone:    the link row is deleted
--   clash:                   gen + 1 and a new event_id; the next plan inserts with it
--   failed:                  status error, attempts + 1, backing off 5 minutes × 2^(attempts − 1),
--                            at most 6 hours; a failed delete also forgets the hash
--   forgotten:               a gone mapping's delete that failed 10 times, or met a calendar-level
--                            403 or 404 (forget)
create function public.calendar_record(p_results jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r        jsonb;
  v_now    timestamptz := private.now();
  v_op     text;
  v_gcal   text;
  v_base   text;
  v_cal    uuid;
  v_hash   text;
  v_gen    int;
  v_n      int;
  v_gone   boolean;
  link     public.calendar_links;
begin
  for r in select x from jsonb_array_elements(case when jsonb_typeof(p_results) = 'array' then p_results else '[]' end) x loop
    begin
      v_op := r ->> 'op';
      v_gcal := r ->> 'google_calendar';
      v_base := r ->> 'base_id';
      v_hash := r ->> 'hash';
      if v_op is null or v_op not in ('insert', 'update', 'delete') or v_gcal is null or v_base is null then
        raise exception 'calendar_record: not a plan row';
      end if;
      v_cal := (select c.id from public.calendars c where c.id = (r ->> 'calendar_id')::uuid);
      select * into link from public.calendar_links k where k.google_calendar = v_gcal and k.base_id = v_base for update;
      -- A gone mapping: the calendar was disconnected, points elsewhere now, or only reads.
      v_gone := not exists (select 1 from public.calendars c where c.id = v_cal and c.google_id = v_gcal and c.writes);

      if v_op in ('insert', 'update') and coalesce((r ->> 'ok')::boolean, false) then
        insert into public.calendar_links as k (google_calendar, base_id, event_id, gen, calendar_id, item_kind, item_id, job_id,
                                                occurrence, part, day, end_day, title, hash, tried_hash, google_hash,
                                                google_updated, status, attempts, next_try_at, failing_since, error, synced_at)
        values (v_gcal, v_base, r ->> 'event_id', coalesce((r ->> 'gen')::int, 0), v_cal, r ->> 'item_kind',
                (r ->> 'item_id')::uuid, r ->> 'job_id', (r ->> 'occurrence')::date, coalesce(r ->> 'part', ''),
                (r ->> 'day')::date, (r ->> 'end_day')::date, coalesce(r ->> 'title', ''), v_hash, v_hash,
                r ->> 'google_hash', (r ->> 'google_updated')::timestamptz, 'ok', 0, null, null, null, v_now)
        on conflict (google_calendar, base_id) do update
        set event_id = excluded.event_id, gen = excluded.gen, calendar_id = excluded.calendar_id,
            item_kind = excluded.item_kind, item_id = excluded.item_id, job_id = excluded.job_id,
            occurrence = excluded.occurrence, part = excluded.part, day = excluded.day, end_day = excluded.end_day,
            title = excluded.title, hash = excluded.hash, tried_hash = excluded.tried_hash,
            google_hash = excluded.google_hash, google_updated = excluded.google_updated, status = 'ok',
            attempts = 0, next_try_at = null, failing_since = null, error = null, synced_at = excluded.synced_at;

      elsif v_op = 'delete' and (coalesce((r ->> 'ok')::boolean, false) or coalesce((r ->> 'gone')::boolean, false)) then
        delete from public.calendar_links where google_calendar = v_gcal and base_id = v_base;

      elsif v_op = 'delete' and coalesce((r ->> 'forget')::boolean, false) and v_gone then
        delete from public.calendar_links where google_calendar = v_gcal and base_id = v_base;

      elsif v_op in ('insert', 'update') and coalesce((r ->> 'clash')::boolean, false) then
        v_gen := coalesce((r ->> 'gen')::int, link.gen, 0) + 1;
        insert into public.calendar_links as k (google_calendar, base_id, event_id, gen, calendar_id, item_kind, item_id, job_id,
                                                occurrence, part, day, end_day, title, hash, status, synced_at)
        values (v_gcal, v_base,
                private.calendar_event_id(private.calendar_key(r ->> 'item_kind', (r ->> 'item_id')::uuid, r ->> 'job_id',
                                                               (r ->> 'occurrence')::date, v_gcal, coalesce(r ->> 'part', ''))
                                          || '|' || v_gen),
                v_gen, v_cal, r ->> 'item_kind', (r ->> 'item_id')::uuid, r ->> 'job_id', (r ->> 'occurrence')::date,
                coalesce(r ->> 'part', ''), (r ->> 'day')::date, (r ->> 'end_day')::date, coalesce(r ->> 'title', ''),
                null, 'pending', null)
        on conflict (google_calendar, base_id) do update
        set event_id = excluded.event_id, gen = excluded.gen, calendar_id = excluded.calendar_id,
            synced_at = null, hash = null, status = 'pending', error = null, next_try_at = null;

      else
        -- It failed: back off on this link alone.
        v_n := coalesce(link.attempts, 0) + 1;
        insert into public.calendar_links as k (google_calendar, base_id, event_id, gen, calendar_id, item_kind, item_id, job_id,
                                                occurrence, part, day, end_day, title, hash, tried_hash, status, attempts,
                                                next_try_at, failing_since, error)
        values (v_gcal, v_base, r ->> 'event_id', coalesce((r ->> 'gen')::int, 0), v_cal, r ->> 'item_kind',
                (r ->> 'item_id')::uuid, r ->> 'job_id', (r ->> 'occurrence')::date, coalesce(r ->> 'part', ''),
                (r ->> 'day')::date, (r ->> 'end_day')::date, coalesce(r ->> 'title', ''), null,
                case when v_op = 'delete' then 'delete' else v_hash end, 'error', v_n,
                v_now + least(interval '5 minutes' * power(2, least(v_n - 1, 12)), interval '6 hours'), v_now,
                coalesce(private.clean_error(coalesce(r ->> 'error', 'HTTP ' || (r ->> 'http'))), 'Google didn''t answer.'))
        on conflict (google_calendar, base_id) do update
        set calendar_id = excluded.calendar_id, status = 'error', attempts = excluded.attempts,
            tried_hash = excluded.tried_hash, next_try_at = excluded.next_try_at,
            failing_since = coalesce(k.failing_since, excluded.failing_since), error = excluded.error,
            hash = case when v_op = 'delete' then null else k.hash end;
        if v_op = 'delete' and v_n >= 10 and v_gone then
          delete from public.calendar_links where google_calendar = v_gcal and base_id = v_base;
        end if;
      end if;
    exception when others then
      null;   -- a row that can't be recorded is planned again next time
    end;
  end loop;
end;
$$;

-- Ends a run (§3.4). Only while p_run still holds the lease: releases it, and records the
-- result, its stop and fixed message, and the window it covered. last_ok_at moves on unless the
-- run stopped for a run-level reason (not_set_up, config, auth, error, slow_down), or ran out of
-- time ('time') without writing anything while writes were pending (so a run that keeps getting
-- nowhere shows up in the parents' email); otherwise 'time' is not a failure, and neither are
-- single items that failed. not_set_up, config and auth forget how the hub signed in. slow_down
-- starts or doubles the pause (10 minutes, at most an hour); a run that wrote something ends it.
-- Then the clean-up, for every calendar:
--   • Google events not refreshed by a read for 24 hours (each read stamps the rows it stores, so a
--     cut-off read keeps what it read), or read from a Google ID the calendar no longer has;
--   • failed writes that have gone past: an insert or update (never a delete) that failed, on a
--     calendar still mapped, whose item is no longer wanted and whose last day is before the
--     window. Google's copy stays as history, as for any past event: a link never written is
--     forgotten, any other is ok again, without its error and backoff.
create function public.calendar_finish(p_run uuid, p_result jsonb, p_stop text default null, p_error text default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now    timestamptz := private.now();
  v_today  date := public.today_local();
  v_result jsonb := case when jsonb_typeof(p_result) = 'object' then p_result else '{}' end;
  v_failed boolean := coalesce(p_stop in ('not_set_up', 'config', 'auth', 'error', 'slow_down'), false);
  v_forget boolean := coalesce(p_stop in ('not_set_up', 'config', 'auth'), false);
  v_wrote  boolean;
  v_stuck  boolean;
begin
  select coalesce(sum((v_result ->> k)::numeric), 0) > 0 into v_wrote
  from unnest(array['inserted', 'updated', 'deleted']) k
  where jsonb_typeof(v_result -> k) = 'number';
  v_stuck := coalesce(p_stop = 'time', false) and not v_wrote
             and jsonb_typeof(v_result -> 'pending') = 'number' and (v_result ->> 'pending')::numeric > 0;

  update public.calendar_sync y
  set running_since = null,
      last_run_at = v_now,
      last_result = v_result || jsonb_build_object('stop', p_stop),
      last_stop = p_stop,
      last_error = private.clean_error(p_error),
      last_ok_at = case when v_failed or v_stuck then y.last_ok_at else v_now end,
      auth = case when v_forget then null else y.auth end,
      account = case when v_forget then null else y.account end,
      key_id = case when v_forget then null else y.key_id end,
      pause_step = case when p_stop = 'slow_down' then least(y.pause_step + 1, 10) when v_wrote then 0 else y.pause_step end,
      paused_until = case when p_stop = 'slow_down'
                          then v_now + least(interval '10 minutes' * power(2, least(y.pause_step, 9)), interval '1 hour')
                          else y.paused_until end,
      window_from = v_today - 1,
      window_to = v_today + 60
  where y.id and y.run_id = p_run;

  delete from public.google_events g
  using public.calendars c
  where c.id = g.calendar_id
    and (g.google_calendar <> c.google_id or g.read_at < v_now - interval '24 hours');

  if exists (select 1 from public.calendar_links l
             where l.status = 'error' and l.end_day < v_today - 1 and l.tried_hash is distinct from 'delete') then
    with wanted as materialized (
      select x.google_calendar, x.base_id from private.calendar_desired(v_today - 1, v_today + 60, null) x
    ),
    past as (
      select l.google_calendar, l.base_id, l.synced_at
      from public.calendar_links l
      join public.calendars c on c.id = l.calendar_id and c.google_id = l.google_calendar and c.writes
      where l.status = 'error' and l.end_day < v_today - 1 and l.tried_hash is distinct from 'delete'
        and not exists (select 1 from wanted w where w.google_calendar = l.google_calendar and w.base_id = l.base_id)
    ),
    forgotten as (
      delete from public.calendar_links k
      using past p
      where k.google_calendar = p.google_calendar and k.base_id = p.base_id and p.synced_at is null
      returning 1
    )
    update public.calendar_links k
    set status = 'ok', attempts = 0, next_try_at = null, failing_since = null, error = null
    from past p
    where k.google_calendar = p.google_calendar and k.base_id = p.base_id and p.synced_at is not null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Replaced: the morning email (same signature as 0002)
-- ---------------------------------------------------------------------
-- As in 0002, plus:
--   • Google events (§5.4): "Today" and the heads-up's "tomorrow before 9am" take the Google
--     events private.google_for gives this person (p_grown_up for a parent or adult), or every
--     Google event for a parent with everyone's items. Never in "Nobody's on it": the hub can't
--     assign a Google event. A non-parent with only a Google event that day isn't empty.
--   • calendar (§5.6): for parents, when any calendar is set up, the Google Calendar lines in
--     their language, or null when there is nothing to say:
--       warning:      Google Calendar isn't up to date (the last good run is more than 2 hours
--                     old, or never) or a calendar can't be reached;
--       items_failed: how many items have failed for more than 24 hours;
--       put_back:     up to 3 lines for events put back after a change in Google in the last 24 hours.
-- Everything the morning email needs, for one person and the day it's about.
-- Sections: today, late (3 at most), heads_up, projects (one line per project of
-- theirs with tasks starting that day); parents also get people (one block per kid
-- or helper, with the text to send them), nobody (items nobody is on), the lines
-- of projects no parent owns and, on Mondays, inbox_count (when there's anything
-- with no date). empty = a non-parent with nothing to say (send nothing).
-- The subject never has a private item's title, whoever it's for: it shows on lock
-- screens and watches.
-- An evening-before email (digest_day 'tomorrow') is read the day before: its
-- "today" label says Tomorrow, and the morning after is named by its day.
-- Inactive people are left off every item, so what only they were on counts as nobody's.
create or replace function public.digest_for(p_person uuid, p_local_date date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d        date := p_local_date;
  me       public.people;
  lang     text;
  parent   boolean;
  everyone boolean;
  hide     boolean;    -- kids and helpers see private items as "Private item"
  evening  boolean;    -- read the evening before d
  day_rows public.agenda_item[];
  google_rows public.agenda_item[];
  google_next public.agenda_item[];
  mine     public.agenda_item[];
  v_late   jsonb;
  late_n   int;
  v_heads  jsonb;
  v_people jsonb := '[]';
  v_nobody jsonb := '[]';
  nobody_n int := 0;
  v_projects jsonb := '[]';
  v_inbox  int;
  v_calendar jsonb;
  subject  text;
begin
  select * into me from public.people p where p.id = p_person and p.active;
  if not found or d is null then
    return null;
  end if;
  lang     := me.language;
  parent   := me.role = 'parent';
  everyone := parent and me.digest_scope = 'everyone';
  hide     := me.role in ('kid', 'helper');
  evening  := me.digest_day = 'tomorrow';

  day_rows := array(select private.active_only(a) from public.agenda(d, d) a where a.status = 'open');

  -- Google events for that day and the next (§5.4).
  google_rows := case when everyone then array(select g from public.google_items(d, d) g)
                      else array(select g from private.google_for(me.id, d, d, me.role in ('parent', 'adult')) g) end;
  google_next := case when everyone then array(select g from public.google_items(d + 1, d + 1) g)
                      else array(select g from private.google_for(me.id, d + 1, d + 1, me.role in ('parent', 'adult')) g) end;

  -- Today: their events and tasks (with 'everyone', everybody's), and their Google events, in
  -- time order. Items nobody is on go to the parents' "Nobody's on it" instead.
  mine := array(
    select x.a
    from (
      select a
      from unnest(day_rows) a
      where a.kind in ('event', 'task')
        and case when everyone then a.responsible_id is not null or cardinality(a.participant_ids) > 0
                 else a.responsible_id = me.id or me.id = any (a.participant_ids) end
      union all
      select g
      from unnest(google_rows) g
    ) x (a)
    order by private.item_order(x.a), (x.a).local_start, (x.a).title);

  -- Late: at most 3, oldest first.
  select count(*) into late_n
  from public.tasks t
  where t.active and t.done_at is null and private.current_due(t) < d
    and case when everyone then private.active_person(t.responsible_id) is not null else t.responsible_id = me.id end;
  select coalesce(jsonb_agg(private.digest_item(x.i, me.id, lang, hide and x.private, null,
                                                replace(private.word('due', lang), '{d}', private.short_date(x.due, lang)))
                            order by x.due, x.title), '[]')
  into v_late
  from (select private.active_only(i) as i, t.private, cd.due, t.title
        from public.tasks t
        cross join lateral (select private.current_due(t) as due) cd
        cross join lateral private.task_item(t, cd.due, 'late') i
        where t.active and t.done_at is null and cd.due < d
          and case when everyone then private.active_person(t.responsible_id) is not null else t.responsible_id = me.id end
        order by cd.due, t.title
        limit 3) x;

  -- Heads-up: tasks inside their lead time, contracts ending within 30 days
  -- (parents), and anything tomorrow before 9am (Google events too).
  select coalesce(jsonb_agg(h.item order by h.day, h.sort, h.title), '[]')
  into v_heads
  from (
    select distinct on (u.kind, u.item_id) u.item, u.day, u.sort, u.title
    from (
      select private.digest_item(a, me.id, lang, hide and a.private, null,
               replace(private.word(case when a.kind = 'contract' then 'contract_ends' else 'due' end, lang),
                       '{d}', private.short_date(a.day, lang))) as item,
             a.kind, a.item_id, a.day, 1 as sort, a.title
      from public.heads_up(d) h
      cross join lateral private.active_only(h) a
      where (a.kind = 'task' and (a.responsible_id = me.id or (parent and (everyone or a.responsible_id is null))))
         or (a.kind = 'contract' and parent)
      union all
      select private.digest_item(a, me.id, lang, hide and a.private,
               case when evening then private.day_label(d + 1, lang) else private.word('tomorrow', lang) end
                 || ' ' || private.time_label(a.local_start, lang), null),
             a.kind, a.item_id, a.day, 0, a.title
      from public.agenda(d + 1, d + 1) n
      cross join lateral private.active_only(n) a
      where a.status = 'open' and a.kind in ('event', 'task') and a.local_start < '09:00'
        and case when everyone then a.responsible_id is not null or cardinality(a.participant_ids) > 0
                 else a.responsible_id = me.id or me.id = any (a.participant_ids) end
      union all
      select private.digest_item(g, me.id, lang, hide and g.private,
               case when evening then private.day_label(d + 1, lang) else private.word('tomorrow', lang) end
                 || ' ' || private.time_label(g.local_start, lang), null),
             g.kind, g.item_id, g.day, 0, g.title
      from unnest(google_next) g
      where g.local_start < '09:00'
    ) u
    order by u.kind, u.item_id, u.sort
  ) h;

  -- Projects: one line per project with tasks starting today. Each owner gets their own
  -- projects' lines, whoever they are (day_text and My day show them those tasks too);
  -- a project with no owner who is an active parent goes to every parent as well.
  select coalesce(jsonb_agg(jsonb_build_object('project_id', x.project_id, 'name', x.project_name,
                                               'text', x.project_name || ': ' || x.line, 'items', x.items)
                            order by x.project_name), '[]')
  into v_projects
  from (
    select a.project_id, a.project_name,
           string_agg(a.title || case when a.milestone then '' else ' ' || private.word('starts', lang) end
                        || coalesce(' (' || nullif(concat_ws(' ', a.contractor_name, a.contractor_phone), '') || ')', ''),
                      '; ' order by a.title) as line,
           jsonb_agg(jsonb_build_object('title', a.title, 'milestone', a.milestone,
                                        'contractor_name', a.contractor_name, 'contractor_phone', a.contractor_phone)
                     order by a.title) as items
    from unnest(day_rows) a
    where a.kind = 'project' and a.day = d
      and (a.responsible_id = me.id
           or (parent and not exists (select 1 from public.people o where o.id = a.responsible_id and o.role = 'parent' and o.active)))
    group by a.project_id, a.project_name
  ) x;

  if parent then
    -- One block per kid or helper, with the message to send them.
    select coalesce(jsonb_agg(jsonb_build_object(
             'person_id', p.id, 'name', private.short_name(p), 'role', p.role, 'phone', p.phone, 'language', p.language,
             'count', (select count(*) from private.person_items(p.id, d) a where a.status = 'open'),
             'text', public.day_text(p.id, d))
           order by p.sort_order, p.name), '[]')
    into v_people
    from public.people p
    where p.active and p.role in ('kid', 'helper');

    -- Nobody's on it: today's unassigned items, then unassigned late tasks (5 at most).
    with unassigned as (
      select private.digest_item(a, me.id, lang, false, null, null) as item, 0 as grp, a.day, private.item_order(a) as o,
             a.local_start, a.title
      from unnest(day_rows) a
      where a.kind in ('event', 'task') and a.responsible_id is null and cardinality(a.participant_ids) = 0
      union all
      select private.digest_item(i, me.id, lang, false, null,
               replace(private.word('due', lang), '{d}', private.short_date(cd.due, lang))),
             1, cd.due, 3, null, t.title
      from public.tasks t
      cross join lateral (select private.current_due(t) as due) cd
      cross join lateral private.task_item(t, cd.due, 'late') l
      cross join lateral private.active_only(l) i
      where t.active and t.done_at is null and cd.due < d and private.active_person(t.responsible_id) is null
    )
    select coalesce((select jsonb_agg(item order by grp, day, o, local_start, title)
                     from (select * from unassigned order by grp, day, o, local_start, title limit 5) top), '[]'),
           count(*)
    into v_nobody, nobody_n
    from unassigned;

    -- Mondays: how many tasks have no date yet (no line when there are none).
    if extract(isodow from d) = 1 then
      select nullif(count(*), 0) into v_inbox from public.tasks t where t.active and t.done_at is null and t.due_date is null;
    end if;

    -- Google Calendar (§5.6): the calendar's dead-man's switch.
    if exists (select 1 from public.calendars) then
      select case when w.warning is null and f.items_failed is null and b.put_back = '[]' then null
                  else jsonb_build_object('warning', w.warning, 'items_failed', f.items_failed, 'put_back', b.put_back) end
      into v_calendar
      from (
        select case
                 when y.last_ok_at is null
                   then private.calendar_word('calendar_never', lang)
                 when y.last_ok_at < private.now() - interval '2 hours'
                      or exists (select 1 from public.calendars c where c.status in ('no_access', 'error'))
                   then replace(private.calendar_word('calendar_warning', lang), '{when}',
                          case when (y.last_ok_at at time zone private.tz())::date > public.today_local() - 6
                               then case lang
                                      when 'es' then (array['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'])
                                                     [extract(isodow from (y.last_ok_at at time zone private.tz()))]
                                      else (array['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
                                           [extract(isodow from (y.last_ok_at at time zone private.tz()))] end
                               else private.short_date((y.last_ok_at at time zone private.tz())::date, lang) end
                          || ' ' || private.time_label((y.last_ok_at at time zone private.tz())::time, lang))
               end as warning
        from (select 1) one
        left join public.calendar_sync y on y.id
      ) w
      cross join (
        select case when count(*) = 1 then private.calendar_word('calendar_items_failed_one', lang)
                    when count(*) > 1 then replace(private.calendar_word('calendar_items_failed', lang), '{n}', count(*)::text)
               end as items_failed
        from public.calendar_links k
        where k.failing_since < private.now() - interval '24 hours'
      ) f
      cross join (
        select coalesce(jsonb_agg(x.line order by x.repaired_at desc, x.line), '[]') as put_back
        from (
          select replace(replace(replace(private.calendar_word('calendar_put_back', lang),
                                         '{day}', private.day_label(k.day, lang)),
                                 '{what}', private.calendar_word(case k.repair_kind when 'deleted' then 'deleted_in_google'
                                                                                   else 'edited_in_google' end, lang)),
                         '{title}', k.title)
                   || case when k.item_kind = 'event'
                                and exists (select 1 from public.events e where e.id = k.item_id and e.repeat <> 'none')
                           then ' ' || private.calendar_word('skip_hint', lang) else '' end as line,
                 k.repaired_at
          from public.calendar_links k
          where k.repaired_at >= private.now() - interval '24 hours'
          order by k.repaired_at desc, k.title
          limit 3
        ) x
      ) b;
    end if;
  end if;

  -- The subject carries the content: "Tue Oct 27: 8:00am Drop off dogs · 3:00pm Pick up Taylor · +2".
  -- A private item is "Private item" here even for a parent (the email itself has its title).
  subject := private.day_label(d, lang) || ': ' || coalesce(
    (select string_agg(coalesce(private.time_label(mine[i].local_start, lang) || ' ', '')
                         || case when mine[i].private then private.word('private_item', lang) else mine[i].title end,
                       ' · ' order by i)
     from generate_subscripts(mine, 1) i
     where i <= 2)
      || case when cardinality(mine) > 2 then ' · +' || (cardinality(mine) - 2) else '' end,
    case when late_n > 0 then private.count_word('n_late', late_n, lang) end,
    private.word('nothing_planned', lang));

  return jsonb_build_object(
    'recipient', jsonb_build_object('id', me.id, 'name', me.name, 'email', me.email, 'language', lang,
                                    'role', me.role, 'day_token', me.day_token),
    'local_date', d,
    'date_label', private.day_label(d, lang),
    'subject', subject,
    'today', coalesce((select jsonb_agg(private.digest_item(mine[i], me.id, lang, hide and mine[i].private, null, null) order by i)
                       from generate_subscripts(mine, 1) i), '[]'),
    'late', v_late,
    'late_more', greatest(late_n - 3, 0),
    'heads_up', v_heads,
    'people', v_people,
    'nobody', v_nobody,
    'nobody_more', greatest(nobody_n - 5, 0),
    'projects', v_projects,
    'inbox_count', v_inbox,
    'calendar', v_calendar,
    'empty', not parent and cardinality(mine) = 0 and late_n = 0 and jsonb_array_length(v_heads) = 0
             and jsonb_array_length(v_projects) = 0,
    'labels', jsonb_build_object(
      'today', private.word(case when evening then 'tomorrow' else 'today' end, lang),
      'tomorrow', private.word('tomorrow', lang),
      'late', private.word('late', lang),
      'late_more', case when late_n > 3 then replace(private.word('and_more', lang), '{n}', (late_n - 3)::text) end,
      'heads_up', private.word('heads_up', lang),
      'their_day', private.word('their_day', lang),
      'nobody', private.word('nobody', lang),
      'nobody_more', case when nobody_n > 5 then replace(private.word('and_more', lang), '{n}', (nobody_n - 5)::text) end,
      'projects', private.word('projects', lang),
      'inbox', case when v_inbox is not null then private.count_word('inbox', v_inbox, lang) end,
      'nothing_planned', private.word('nothing_planned', lang),
      'open_my_day', private.word('open_my_day', lang),
      'send_whatsapp', private.word('send_whatsapp', lang),
      'send_text', private.word('send_text', lang),
      'stop_emails', private.word('stop_emails', lang)));
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The v1.1 client shows the Google card, and asks for Google events, only on 3.
-- (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 3;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- New public functions: revoke from public and anon (and authenticated, for the job's),
-- then grant to who calls them. Replaced functions keep their grants.
-- ---------------------------------------------------------------------

-- Pages.
revoke execute on function public.google_items(date, date)  from public, anon;
revoke execute on function public.calendar_preview(uuid)    from public, anon;
grant  execute on function public.google_items(date, date)  to authenticated, service_role;
grant  execute on function public.calendar_preview(uuid)    to authenticated, service_role;

-- The calendar job: service_role only.
revoke execute on function public.calendar_begin()                                  from public, anon, authenticated;
revoke execute on function public.calendar_signed_in(uuid, text, text, text)        from public, anon, authenticated;
revoke execute on function public.calendar_read_due(boolean, int)                   from public, anon, authenticated;
revoke execute on function public.calendar_store_events(uuid, text, date, date, text, text, boolean, jsonb, jsonb)
                                                                                    from public, anon, authenticated;
revoke execute on function public.calendar_mark(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.calendar_plan(text, int)                          from public, anon, authenticated;
revoke execute on function public.calendar_record(jsonb)                            from public, anon, authenticated;
revoke execute on function public.calendar_finish(uuid, jsonb, text, text)          from public, anon, authenticated;
grant  execute on function public.calendar_begin()                                  to service_role;
grant  execute on function public.calendar_signed_in(uuid, text, text, text)        to service_role;
grant  execute on function public.calendar_read_due(boolean, int)                   to service_role;
grant  execute on function public.calendar_store_events(uuid, text, date, date, text, text, boolean, jsonb, jsonb)
                                                                                    to service_role;
grant  execute on function public.calendar_mark(uuid, text, text, text, text, text) to service_role;
grant  execute on function public.calendar_plan(text, int)                          to service_role;
grant  execute on function public.calendar_record(jsonb)                            to service_role;
grant  execute on function public.calendar_finish(uuid, jsonb, text, text)          to service_role;

-- Helpers in private: none for anon. The preview (an admin) and day_text (a member) reach
-- calendar_desired and google_for, so those and what they call are granted to authenticated.
revoke execute on function private.clean_text(text, int)                                     from public, anon;
revoke execute on function private.clean_error(text)                                         from public, anon;
revoke execute on function private.calendar_event_id(text)                                   from public, anon;
revoke execute on function private.calendar_key(text, uuid, text, date, text, text)          from public, anon;
revoke execute on function private.calendar_word(text, text)                                 from public, anon;
revoke execute on function private.calendar_status(boolean, text, text)                      from public, anon;
revoke execute on function private.calendars_tidy()                                          from public, anon;
revoke execute on function private.google_item(public.google_events, public.calendars)       from public, anon;
revoke execute on function private.google_for(uuid, date, date, boolean)                     from public, anon;
revoke execute on function private.calendar_desired(date, date, text)                        from public, anon;
grant  execute on function private.clean_text(text, int)                                     to service_role;
grant  execute on function private.clean_error(text)                                         to service_role;
grant  execute on function private.calendar_event_id(text)                                   to authenticated, service_role;
grant  execute on function private.calendar_key(text, uuid, text, date, text, text)          to authenticated, service_role;
grant  execute on function private.calendar_word(text, text)                                 to authenticated, service_role;
grant  execute on function private.calendar_status(boolean, text, text)                      to service_role;
grant  execute on function private.google_item(public.google_events, public.calendars)       to authenticated, service_role;
grant  execute on function private.google_for(uuid, date, date, boolean)                     to authenticated, service_role;
grant  execute on function private.calendar_desired(date, date, text)                        to authenticated, service_role;
-- calendar_desired leaves inactive people off each item, as the email does.
grant  execute on function private.active_person(uuid)                                       to authenticated;
grant  execute on function private.active_only(public.agenda_item)                           to authenticated;

commit;
