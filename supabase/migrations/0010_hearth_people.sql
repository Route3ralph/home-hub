-- =====================================================================
-- HOME HUB v1.1 — migration 0010: a shared calendar sorted by Hearth person
-- Apply once, after 0009, and only once the site and hub-jobs that understand it are live (docs/v1.1-google-calendar.md §11.9).
-- The contract is docs/v1.1-google-calendar.md §11 (§11.2 the data, §11.4 the routing, §11.5 the functions).
--
-- Why
--   The kitchen wall (Hearth) keeps every event made on it in one Google calendar, "Hearth Calendar", for everyone,
--   and marks whose an event is by adding that Hearth profile as a guest, with an address like
--   jordan@team-example-0000 ("<profile>@team-<family>-<digits>": no dot after the @, so no real mailbox). Read as
--   Family, every person's events were everyone's: all of them reached the grown-ups' emails and a kid got none (or,
--   with Show to kids, all of them), so his lessons never became his busy time. From 0010 the hub can send each event
--   of such a calendar to its people by its Hearth guests, which the parents match once in Settings.
--
-- What it adds and changes
--   • Columns: calendars.sort_by_guest ("Sort by Hearth person"; false on every row, so with nothing sorted every answer
--     is 9's), with two checks: only on a calendar the hub reads as Family (kind 'family', not writes), and never with
--     Show to kids (for_kids); signed-in users may update it (row-level security: admins only, as for_kids), not insert
--     it. google_events.guests: a cached event's Hearth tags (private.hearth_tag's answers, distinct, sorted, at most 16;
--     '{}' on every calendar without the switch).
--   • Table: hearth_tags (the Hearth people seen on a sorted calendar, per calendar, and what a parent matched each to:
--     a person, 'family' or 'grown_ups'; null until then, "New"). Row-level security: members select; no write policy;
--     revoked from public, anon and authenticated, then select granted to authenticated; service_role keeps Supabase's
--     default privileges (calendar_store_events runs as it). Written only by calendar_store_events and set_hearth_tag.
--   • New: set_hearth_tag(p_id uuid, p_to text, p_person uuid default null) returns jsonb (SECURITY DEFINER, the parents
--     only: match a tag to a person, Family or the grown-ups, or forget it); private.hearth_tag(p_email text) returns
--     text (IMMUTABLE: a guest address as a tag, or null; for hub-jobs' store only); private.hearth_whose(g, c, out
--     people uuid[], out family boolean, out grown_ups boolean) (STABLE: whom a sorted calendar's row reaches; members
--     and hub-jobs, since google_item runs with a member's rights).
--   • Replaced, with the same signatures (create or replace, so they keep their grants), from 0003's bodies (no later
--     migration replaces them): private.google_item(g, c) (a sorted calendar's row has nobody in charge, its people
--     along and category 'family', 'grown_ups' or null) and private.google_for(p_person, p_from, p_to, p_grown_up) (who
--     a sorted row reaches, from the row's own fields); private.calendars_tidy() (the switch's rules); and
--     calendar_store_events(…) (each kept event's guests; read_at left alone after a sorted calendar's read without
--     guests; the tag list, in a block of its own; the 90-day rule). Its answer is unchanged.
--   • Dropped and made again (its answer gains a column, which create or replace can't do): calendar_read_due(p_force,
--     p_limit) answers sort_by_guest last; 0003's revoke and grant again.
--   • hub_schema_version() (10).
--   Everything else that takes Google events (google_items, person_items, get_person_day, day_text, digest_for,
--   free_minutes, homework_week, the token functions, the tutor's and the coach view) takes them through google_item and
--   google_for, so it keeps its code. Nothing new for anon. The hub never writes a sorted calendar (it is read-only by
--   the check), and calendar_desired never reads Google events.
--
-- Rules
--   • One transaction. It refuses to run without 0009, twice, on a database set back to 9 (hearth_tags already there),
--     or on a database that isn't as 0009 left it (the columns of calendars and google_events it reads, and no
--     sort_by_guest or guests yet; calendar_read_due answering its 8 columns; the functions it replaces or calls with the
--     arguments their migrations gave them; none of its own three functions yet). Then it locks calendar_sync, so no
--     calendar run begins until it commits (calendar_begin waits, then the run uses the new functions), and refuses
--     while a run holds the lease ("A calendar run is under way. Try again in a minute."): a store begun under 0003's
--     body would otherwise skip every event of its calendar once this commits.
--   • Row-level security on the new table; set search_path = '' on every function; revoke then grant on every new one.
--     The only new SECURITY DEFINER function is set_hearth_tag.
--
-- Undo (not needed: with the switch off on every calendar, every answer is 9's). If wanted, in one go in the SQL
-- editor, in this order:
--   update public.calendars set sort_by_guest = false;
--   0003's "create function private.google_item(g public.google_events, c public.calendars)", "create function
--   private.google_for(p_person uuid, p_from date, p_to date, p_grown_up boolean)", "create function
--   private.calendars_tidy()" and "create function public.calendar_store_events(p_calendar uuid, …" blocks again, each
--   to its "$$;", with create or replace;
--   drop function public.calendar_read_due(boolean, int); then 0003's "create function public.calendar_read_due(…)" block
--   and its two lines "revoke execute on function public.calendar_read_due(boolean, int) from public, anon,
--   authenticated;" and "grant execute on function public.calendar_read_due(boolean, int) to service_role;";
--   drop function public.set_hearth_tag(uuid, text, uuid); drop function private.hearth_whose(public.google_events,
--   public.calendars); drop function private.hearth_tag(text);
--   drop table public.hearth_tags;
--   alter table public.google_events drop column guests; alter table public.calendars drop column sort_by_guest;
--   (their checks and the column grant go with them)
--   create or replace function public.hub_schema_version() returns int language sql immutable set search_path = ''
--   as $$ select 9 $$;
-- 0010 can then run again. The site and hub-jobs need no change: both work on 9. Setting hub_schema_version() back to 9
-- alone is not an undo (the database still sorts while a switch is on); 0010's guard names that state.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0009 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 9 then
    raise exception 'The school items'' keys (migration 0009) aren''t installed (hub_schema_version() is %). Run 0009_school_keys.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 10 then
    raise exception 'Hearth people (migration 0010) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.hearth_tags') is not null then
    raise exception 'Hearth people (migration 0010) is already installed, but hub_schema_version() was set back to 9. To switch it on again, make hub_schema_version() return 10 (docs/v1.1-google-calendar.md §11.9). Nothing was changed.';
  end if;
  -- What this migration replaces, reads and adds to is as 0009 left it (or as the undo above leaves it: the same).
  if (select count(*) from pg_attribute a
      where not a.attisdropped and a.attnum > 0
        and ((a.attrelid = to_regclass('public.calendars') and a.attname in ('kind', 'person_id', 'writes', 'for_kids', 'google_id', 'read_at'))
             or (a.attrelid = to_regclass('public.google_events')
                 and a.attname in ('calendar_id', 'google_calendar', 'event_id', 'title', 'location', 'all_day', 'start_day', 'end_day',
                                   'start_at', 'end_at', 'private', 'repeating', 'google_updated', 'read_at')))) <> 20
     or (select count(*) from pg_attribute a where a.attrelid = to_regclass('public.google_events') and not a.attisdropped and a.attnum > 0) <> 14
     or exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.calendars') and a.attname = 'sort_by_guest' and not a.attisdropped)
     or (select count(*) from pg_proc p cross join lateral unnest(p.proargmodes) m (mode)
         where p.oid = to_regprocedure('public.calendar_read_due(boolean,int)') and m.mode = 't') <> 8
     or to_regprocedure('private.google_item(public.google_events,public.calendars)') is null
     or to_regprocedure('private.google_for(uuid,date,date,boolean)') is null
     or to_regprocedure('private.calendars_tidy()') is null
     or to_regprocedure('public.calendar_store_events(uuid,text,date,date,text,text,boolean,jsonb,jsonb)') is null
     or to_regprocedure('private.active_person(uuid)') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('private.is_member()') is null
     or to_regprocedure('private.now()') is null
     or to_regprocedure('public.current_email()') is null
     or to_regprocedure('private.free_minutes(uuid,date,date,uuid)') is null
     or to_regprocedure('private.coach_view(uuid)') is null
     or exists (select 1 from pg_proc p
                where (p.pronamespace = to_regnamespace('public') and p.proname = 'set_hearth_tag')
                   or (p.pronamespace = to_regnamespace('private') and p.proname in ('hearth_whose', 'hearth_tag'))) then
    raise exception 'This database isn''t as migration 0009 left it. Nothing was changed.';
  end if;
end;
$$;

-- No calendar run while the columns are added and the functions replaced (Rules, above): a calendar_store_events call
-- that began under 0003's body would, after this commit, build each row for 14 columns of 15, skip every event and
-- empty that calendar's cache. calendar_sync first: calendar_begin writes it before a run does anything else, so a run
-- that starts now waits for this commit, then reads and stores with the new functions; and a run that holds the lease
-- (calendar_begin's rule: running_since in the last 10 minutes) stops this migration before anything changes. Plain
-- reads (the pages, the status card) aren't held up.
lock table public.calendar_sync in exclusive mode;

do $$
begin
  if exists (select 1 from public.calendar_sync y where y.running_since >= private.now() - interval '10 minutes') then
    raise exception 'A calendar run is under way. Try again in a minute. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Columns and the table (§11.2)
-- ---------------------------------------------------------------------

-- "Sort by Hearth person": only on a calendar the hub reads as Family, and never with Show to kids (the matches
-- replace it). private.calendars_tidy keeps both (below).
alter table public.calendars
  add column sort_by_guest boolean not null default false
    check (not sort_by_guest or (kind = 'family' and not writes))
    check (not (sort_by_guest and for_kids));

-- A cached event's Hearth tags: private.hearth_tag's answers, distinct, sorted, at most 16; '{}' on every calendar
-- without the switch (calendar_store_events).
alter table public.google_events
  add column guests text[] not null default '{}' check (cardinality(guests) <= 16);

-- The Hearth people seen on a sorted calendar, and what a parent matched each to. Written only by
-- calendar_store_events (as service_role: added when first seen, last_seen moved, the 90-day rule) and set_hearth_tag.
create table public.hearth_tags (
  id          uuid primary key default gen_random_uuid(),                -- set_hearth_tag's p_id
  calendar_id uuid not null references public.calendars (id) on delete cascade,
  tag         text not null check (tag ~ '^[a-z0-9._+-]{1,64}@team-[a-z0-9-]{1,120}$'),
  name        text generated always as (split_part(tag, '@', 1)) stored,   -- what Settings shows: "jordan"
  matched_to  text check (matched_to in ('person', 'family', 'grown_ups')),  -- null: never matched ("New")
  person_id   uuid references public.people (id) on delete set null,     -- with 'person'; null again after remove_person
  last_seen   timestamptz not null,                                      -- the last read with guests that found it on a kept event
  matched_at  timestamptz,                                               -- the last set_hearth_tag
  matched_by  text,                                                      -- public.current_email() then
  unique (calendar_id, tag),
  check (person_id is null or matched_to = 'person'),
  check ((matched_to is null) = (matched_at is null))
);

alter table public.hearth_tags enable row level security;
create policy "Family can see the Hearth people" on public.hearth_tags
  for select to authenticated using (private.is_member());

-- Supabase's default privileges give anon and authenticated everything on a new table. Anon gets nothing; signed-in
-- users read it (row-level security decides). service_role keeps the defaults: calendar_store_events runs as it.
revoke all on public.hearth_tags from public, anon, authenticated;
grant select on public.hearth_tags to authenticated;
-- The switch is a setting column, as for_kids: admins update it (the policy "Admins change calendars"); not on insert.
grant update (sort_by_guest) on public.calendars to authenticated;

-- ---------------------------------------------------------------------
-- What one tag is, and whom one row reaches (§11.4)
-- ---------------------------------------------------------------------

-- A guest address as a Hearth tag: lower(btrim(p_email)) when it is shaped like Hearth's
-- ("<profile>@team-<family>-<digits>", no dot after the @), else null. hub-jobs keeps only these (calendar.ts
-- hearthTags, the same pattern), and calendar_store_events reads every guest through it again.
create function private.hearth_tag(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select x.t from (select lower(btrim(p_email)) as t) x where x.t ~ '^[a-z0-9._+-]{1,64}@team-[a-z0-9-]{1,120}$';
$$;

-- For one cached row g of a sorted calendar c (c.sort_by_guest, which the checks allow only on a read-only Family
-- calendar, and g read from its current Google ID), from that calendar's hearth_tags and the rule for one tag (§11.2):
-- matched to a person on the family list (private.active_person), that person; to Family, Family; anything else (the
-- grown-ups, New, not listed, or matched to someone off the family list or removed), the grown-ups.
--   people:    the people on the family list its tags reach, each once, in family-list order (sort_order, name, id);
--   family:    whether any of its tags reaches Family;
--   grown_ups: whether it has no tag, or any tag that reaches the grown-ups.
-- For any other row: '{}', false and false. A helper of google_item only.
create function private.hearth_whose(g public.google_events, c public.calendars,
                                     out people uuid[], out family boolean, out grown_ups boolean)
language sql
stable
set search_path = ''
as $$
  with s as (
    select coalesce(c.sort_by_guest, false) and g.google_calendar = c.google_id as sorted
  ),
  t as (
    select case when h.matched_to = 'person' and private.active_person(h.person_id) is not null then 'person'
                when h.matched_to = 'family' then 'family'
                else 'grown_ups' end as reach,
           h.person_id
    from s
    cross join unnest(g.guests) x (tag)
    left join public.hearth_tags h on h.calendar_id = c.id and h.tag = x.tag
    where s.sorted
  )
  select coalesce((select array_agg(p.id order by p.sort_order, p.name, p.id) from public.people p
                   where p.id in (select t.person_id from t where t.reach = 'person')), '{}'),
         coalesce((select s.sorted from s) and exists (select 1 from t where t.reach = 'family'), false),
         coalesce((select s.sorted from s) and (cardinality(g.guests) = 0 or exists (select 1 from t where t.reach = 'grown_ups')), false);
$$;

-- ---------------------------------------------------------------------
-- Replaced: Google events as agenda rows, and whose day each reaches (§11.4; 0003's, same signatures)
-- ---------------------------------------------------------------------

-- One cached Google event as an agenda row (kind 'google'). Whose it is comes from its calendar: a person's calendar is
-- theirs, Pets and House are their owners' (household). notes names the source; notes never reach My day, day_text
-- or the email. 0010: a sorted calendar's row (private.hearth_whose) has nobody in charge, the people its tags reach
-- along, and category 'family' when a tag reaches Family, else 'grown_ups' when one reaches the grown-ups (or it has
-- none), else null. Every other row is exactly 0003's.
create or replace function private.google_item(g public.google_events, c public.calendars)
returns public.agenda_item
language sql
stable
set search_path = ''
as $$
  select row(
    'google', md5(g.calendar_id::text || '/' || g.event_id)::uuid, g.start_day, g.title, g.start_day, g.end_day, g.all_day,
    g.start_at, g.end_at, (g.start_at at time zone private.tz())::time, (g.end_at at time zone private.tz())::time,
    case when s.sorted then null
         else case c.kind when 'person' then c.person_id
                          when 'pets' then (select h.pets_owner_id from public.household h)
                          when 'house' then (select h.house_owner_id from public.household h) end end,
    case when s.sorted then w.people else '{}' end, 'open',
    case when s.sorted then case when w.family then 'family' when w.grown_ups then 'grown_ups' end
         else case c.kind when 'family' then 'family' when 'pets' then 'pets' when 'house' then 'home' end end,
    null, null, null, null, null,
    g.location, 'From Google Calendar · ' || coalesce(nullif(c.google_name, ''), c.label),
    g.private, g.repeating, false, null, false, null
  )::public.agenda_item
  from (select coalesce(c.sort_by_guest, false) and g.google_calendar = c.google_id as sorted) s
  cross join lateral private.hearth_whose(g, c) w;
$$;

-- The Google events that reach one person's day (§5.4):
--   a person's calendar (writing or read only):  that person
--   Pets / House:                                its owner (household.pets_owner_id / house_owner_id)
--   Family, writing (Hub – Family):              grown-ups' email: every parent and adult; otherwise every kid
--   Family, read only:                           grown-ups' email: every parent and adult; otherwise kids,
--                                                and only with "Show to kids"
--   0010, a sorted calendar (§11.4), from the row google_item built (as the pages do): each person on it, whatever
--   their role; 'family' every kid (and every parent's and adult's email); 'grown_ups' every parent's and adult's email
-- Helpers get only their own calendar, and on a sorted one only the events with their own tag. p_grown_up is true for
-- a parent's or adult's email, false for My day, day_text and the kids' and helpers' email.
create or replace function private.google_for(p_person uuid, p_from date, p_to date, p_grown_up boolean)
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
    and case when c.sort_by_guest
             then p_person = any (i.participant_ids)
                  or (i.category = 'family' and case when p_grown_up then me.role in ('parent', 'adult') else me.role = 'kid' end)
                  or (i.category = 'grown_ups' and p_grown_up and me.role in ('parent', 'adult'))
             when c.kind = 'family'
             then case when p_grown_up then me.role in ('parent', 'adult')
                       else me.role = 'kid' and (c.writes or c.for_kids) end
             else i.responsible_id = p_person end
  order by i.day, i.local_start nulls last, i.title, i.item_id;
$$;

-- ---------------------------------------------------------------------
-- Replaced: calendars' tidy trigger (§11.2; 0003's, with four additions)
-- ---------------------------------------------------------------------
-- Trims the label and lowercases the Google ID. A new Google ID (or switching between
-- writing and reading) starts the calendar again: status 'new', and what was learned about
-- the old one is forgotten, Start copying included. Its cached Google events stop showing
-- at once (pages match google_events.google_calendar to google_id) and the next run deletes
-- them: this trigger runs with the admin's rights, which can't write google_events.
-- An update that changes only hub-jobs' columns keeps updated_at and updated_by, so the job's
-- status writes don't look like an admin's edit.
-- 0010, before the checks run: a calendar that isn't read-only Family isn't sorted (so changing Whose, or switching a
-- row to writing, turns the switch off rather than tripping the check); an update that turns the switch on turns Show
-- to kids off; one after which a row is still sorted with Show to kids on (ticked in a tab opened before the switch
-- went on) is refused, 22023 "Turn off Sort by Hearth person first."; and a change of the switch clears read_at (the
-- next run reads it first) and counts as an admin's edit.
-- Same-event triggers fire in name order: calendars_stamp runs before calendars_tidy.
create or replace function private.calendars_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.label := btrim(new.label);
  new.google_id := lower(btrim(new.google_id));
  -- 0010: only a calendar the hub reads as Family is sorted.
  if new.kind is distinct from 'family' or new.writes is not false then
    new.sort_by_guest := false;
  end if;
  if tg_op = 'UPDATE' then
    -- 0010: the switch on turns Show to kids off; Show to kids on a row still sorted is refused.
    if new.sort_by_guest and not old.sort_by_guest then
      new.for_kids := false;
    elsif new.sort_by_guest and old.sort_by_guest and new.for_kids then
      raise exception 'Turn off Sort by Hearth person first.' using errcode = '22023';
    end if;
    -- 0010: a change of the switch: read it first next time.
    if new.sort_by_guest is distinct from old.sort_by_guest then
      new.read_at := null;
    end if;
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
          and new.copy_approved_at is not distinct from old.copy_approved_at
          and new.sort_by_guest is not distinct from old.sort_by_guest then
      new.updated_at := old.updated_at;
      new.updated_by := old.updated_by;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Dropped and made again: the calendars to read now (§11.3; 0003's, plus sort_by_guest)
-- ---------------------------------------------------------------------
-- The calendars to read now (§5.1): never-read ones first, then the one Google answered about
-- longest ago (a calendar whose reads are always cut off keeps an old read_at, so it doesn't go
-- first every time). A calendar is due when its last complete read is 14 minutes old; one that is
-- no_access or error at most once an hour, so fixed sharing is noticed by itself. p_force (an
-- admin's Sync now): every calendar.
-- time_min and time_max are local midnight at the start of the window and after its last day.
-- 0010: sort_by_guest, so hub-jobs asks Google for guest addresses only for a sorted calendar (a calendar just
-- switched has read_at cleared, so it goes first).
drop function public.calendar_read_due(boolean, int);
create function public.calendar_read_due(p_force boolean default false, p_limit int default 10)
returns table (calendar_id uuid, google_id text, writes boolean, w_from date, w_to date,
               time_min timestamptz, time_max timestamptz, tz text, sort_by_guest boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  with s as (
    select public.today_local() - 1 as w_from, public.today_local() + 60 as w_to, private.tz() as tz, private.now() as now
  )
  select c.id, c.google_id, c.writes, s.w_from, s.w_to,
         s.w_from::timestamp at time zone s.tz, (s.w_to + 1)::timestamp at time zone s.tz, s.tz, c.sort_by_guest
  from public.calendars c
  cross join s
  where coalesce(p_force, false)
     or (c.status in ('new', 'ok') and (c.read_at is null or c.read_at < s.now - interval '14 minutes'))
     or (c.status in ('no_access', 'error')
         and (coalesce(c.checked_at, c.read_at) is null or coalesce(c.checked_at, c.read_at) < s.now - interval '1 hour'))
  order by c.read_at is not null, greatest(c.read_at, c.checked_at) nulls first, c.id
  limit greatest(coalesce(p_limit, 10), 0);
$$;

-- ---------------------------------------------------------------------
-- Replaced: storing a read (§11.2; 0003's, same signature and answer)
-- ---------------------------------------------------------------------
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
-- 0010 (§11.2): an event of p_events may carry guests (hub-jobs sends the key on every event of a read that asked
-- Google for guest addresses, which it does only for a sorted calendar). A read "with guests" is one whose p_events has
-- an event with that key, or has no events at all. On a sorted calendar (its sort_by_guest at this store) each kept
-- event of p_events stores its guests, each through private.hearth_tag, nulls dropped, distinct, sorted, the first 16;
-- every other event, and every event of any other calendar, '{}' (p_seen is never read for guests). A sorted
-- calendar's read without guests stores its events with '{}' but leaves read_at, so it stays due. After a read with
-- guests of a sorted calendar, in a block of its own (a failure there leaves the tag list as it was and the events
-- stored): every tag on a kept event the calendar doesn't list yet is added, in tag order, while it has fewer than 50;
-- every listed one on a kept event gets last_seen = greatest(last_seen, now); and after a complete read only, the
-- calendar's New, the grown-ups' and a removed person's tags not seen for 90 days are deleted. The rows are built by
-- column name. Nothing about tags is in any answer, status or message.
create or replace function public.calendar_store_events(p_calendar uuid, p_google_id text, p_from date, p_to date, p_name text,
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
  v_events   jsonb;
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
  -- 0010
  v_sorted   boolean;     -- the calendar's switch at this store
  v_guests   boolean;     -- a read with guests
  v_in_seen  boolean;     -- this item came in p_seen
  r          public.google_events;
  v_tags     text[];      -- the tags on its kept events
  v_listed   int;         -- how many the calendar lists
begin
  select * into cal from public.calendars c where c.id = p_calendar and c.google_id = p_google_id for update;
  if not found then
    return jsonb_build_object('kept', 0, 'skipped', 0, 'seen', 0, 'repaired', 0, 'adopted', 0);
  end if;

  select x.status, x.detail into v_status, v_detail
  from private.calendar_status(cal.writes, coalesce(p_name, cal.google_name), coalesce(p_access, cal.access_role)) x;

  v_events := case when jsonb_typeof(p_events) = 'array' then p_events else '[]' end;
  v_items := v_events || case when jsonb_typeof(p_seen) = 'array' then p_seen else '[]' end;
  -- 0010
  v_sorted := coalesce(cal.sort_by_guest, false);
  v_guests := jsonb_array_length(v_events) = 0
              or exists (select 1 from jsonb_array_elements(v_events) x where jsonb_typeof(x) = 'object' and x ? 'guests');

  for e, v_in_seen in select x.e, x.n > jsonb_array_length(v_events) from jsonb_array_elements(v_items) with ordinality x (e, n) loop
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
        -- 0010: built by column name (0003 built it by position), with the event's tags on a sorted calendar.
        r := null;
        r.calendar_id := p_calendar;
        r.google_calendar := p_google_id;
        r.event_id := v_id;
        r.title := case when v_private then '' else private.clean_text(coalesce(e ->> 'title', ''), 200) end;
        r.location := case when not v_private then nullif(private.clean_text(e ->> 'location', 200), '') end;
        r.all_day := v_all_day;
        r.start_day := v_s_day;
        r.end_day := v_e_day;
        r.start_at := v_s_at;
        r.end_at := v_e_at;
        r.private := v_private;
        r.repeating := coalesce(e -> 'recurring' = 'true', false);
        r.google_updated := v_upd;
        r.read_at := v_now;
        r.guests := case when v_sorted and not v_in_seen and jsonb_typeof(e -> 'guests') = 'array'
                         then (select coalesce((array_agg(y.t order by y.t collate "C"))[1:16], '{}')
                               from (select distinct private.hearth_tag(x #>> '{}') as t
                                     from jsonb_array_elements(e -> 'guests') x
                                     where jsonb_typeof(x) = 'string') y
                               where y.t is not null)
                         else '{}' end;
        v_keep := v_keep || r;
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

  -- 0010: a sorted calendar read without guests stays due (read_at as it was).
  update public.calendars
  set google_name = coalesce(nullif(private.clean_text(p_name, 200), ''), google_name),
      access_role = coalesce(nullif(private.clean_text(p_access, 40), ''), access_role),
      checked_at = v_now,
      read_at = case when v_complete and (v_guests or not v_sorted) then v_now else read_at end,
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

  -- 0010: the tag list, after a read with guests of a sorted calendar (not one the hub can't read), in a block of its
  -- own: if any step fails, it stays as it was and the events are still stored.
  if v_sorted and v_guests and v_status <> 'no_access' then
    begin
      v_tags := array(select distinct t from unnest(v_keep) k cross join lateral unnest(k.guests) t);
      select count(*) into v_listed from public.hearth_tags h where h.calendar_id = p_calendar;
      insert into public.hearth_tags (calendar_id, tag, last_seen)
      select p_calendar, t, v_now
      from unnest(v_tags) t
      where not exists (select 1 from public.hearth_tags h where h.calendar_id = p_calendar and h.tag = t)
      order by t collate "C"
      limit greatest(50 - v_listed, 0)
      on conflict (calendar_id, tag) do nothing;
      update public.hearth_tags h
      set last_seen = greatest(h.last_seen, v_now)
      where h.calendar_id = p_calendar and h.tag = any (v_tags);
      if v_complete then
        delete from public.hearth_tags h
        where h.calendar_id = p_calendar
          and (h.matched_to is null or h.matched_to = 'grown_ups' or (h.matched_to = 'person' and h.person_id is null))
          and h.last_seen < v_now - interval '90 days';
      end if;
    exception when others then
      null;
    end;
  end if;

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

-- ---------------------------------------------------------------------
-- Matching, for the parents (§11.5)
-- ---------------------------------------------------------------------
-- One tag of a sorted calendar matched to a person on the family list ('person', with p_person), to Family
-- ('family') or to the grown-ups ('grown_ups'); or forgotten ('forget': the row is deleted, and the next read with
-- guests lists the tag again, as New, if Hearth still uses it). p_person is ignored unless p_to is 'person'. A match
-- works at once: the next page load, My day, text or email uses it. Answers {id, name, to, person_id}, or for
-- 'forget' {id, name, to}. Refuses: 42501 "Only a parent can match Hearth people." unless private.is_admin(); 22023
-- "Choose a person, Family or the grown-ups." for any other p_to (null included); 22023 "That Hearth person isn't there
-- any more." for an unknown p_id; 22023 "Turn on Sort by Hearth person first." while its calendar's switch is off;
-- 22023 "Choose someone on the family list." for 'person' with p_person null, unknown or not active.
create function public.set_hearth_tag(p_id uuid, p_to text, p_person uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tag    public.hearth_tags;
  v_sorted boolean;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can match Hearth people.' using errcode = '42501';
  end if;
  if p_to is null or p_to not in ('person', 'family', 'grown_ups', 'forget') then
    raise exception 'Choose a person, Family or the grown-ups.' using errcode = '22023';
  end if;
  select * into v_tag from public.hearth_tags h where h.id = p_id for update;
  if not found then
    raise exception 'That Hearth person isn''t there any more.' using errcode = '22023';
  end if;
  select c.sort_by_guest into v_sorted from public.calendars c where c.id = v_tag.calendar_id;
  if not coalesce(v_sorted, false) then
    raise exception 'Turn on Sort by Hearth person first.' using errcode = '22023';
  end if;
  if p_to = 'person' and private.active_person(p_person) is null then
    raise exception 'Choose someone on the family list.' using errcode = '22023';
  end if;

  if p_to = 'forget' then
    delete from public.hearth_tags h where h.id = v_tag.id;
    return jsonb_build_object('id', v_tag.id, 'name', v_tag.name, 'to', 'forget');
  end if;
  update public.hearth_tags h
  set matched_to = p_to,
      person_id = case when p_to = 'person' then p_person end,
      matched_at = private.now(),
      matched_by = public.current_email()
  where h.id = v_tag.id;
  return jsonb_build_object('id', v_tag.id, 'name', v_tag.name, 'to', p_to, 'person_id', case when p_to = 'person' then p_person end);
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages ask for hearth_tags and calendars.sort_by_guest only on 10 (and take every version up to 99).
-- (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 10;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- set_hearth_tag for signed-in users (the parents, by its own check); hearth_tag for hub-jobs' store (service_role);
-- hearth_whose for members and hub-jobs (google_item runs with a member's rights in google_items, day_text and
-- homework_week); calendar_read_due again as 0003 granted it. The replaced functions keep their grants.
-- ---------------------------------------------------------------------
revoke execute on function public.set_hearth_tag(uuid, text, uuid)                              from public, anon, service_role;
revoke execute on function private.hearth_tag(text)                                             from public, anon, authenticated;
revoke execute on function private.hearth_whose(public.google_events, public.calendars)         from public, anon;
revoke execute on function public.calendar_read_due(boolean, int)                               from public, anon, authenticated;
grant  execute on function public.set_hearth_tag(uuid, text, uuid)                              to authenticated;
grant  execute on function private.hearth_tag(text)                                             to service_role;
grant  execute on function private.hearth_whose(public.google_events, public.calendars)         to authenticated, service_role;
grant  execute on function public.calendar_read_due(boolean, int)                               to service_role;

commit;
