-- =====================================================================
-- HOME HUB v2 — migration 0002: people, calendar, tasks, morning email
-- Apply once, after schema.sql. Run supabase/preflight.sql first: it
-- checks that the live database matches schema.sql and has no v2 objects.
--
-- What it adds
--   • Tables: household, people, events, event_changes, tasks, task_log,
--     contractor_secrets, notification_log, job_runs.
--   • contractors becomes the Directory (kind, category, address, contract
--     end); projects gains computed task dates, a calendar switch and an owner.
--   • whoami() also returns the caller's person row.
--   • Functions for the pages (agenda, late_items, heads_up, day_text), task
--     actions, the family list, the My day page's token functions and the
--     morning-email jobs.
--
-- Rules
--   • One transaction, and it refuses to run twice.
--   • Additive: v1 tables, columns, policies and functions keep working.
--   • Every table has row-level security gated on private.is_member(). In v2
--     only parents and adults can sign in, so members are the grown-ups.
--   • Kids and helpers have no login. Their My day link carries a secret
--     token; the four token functions are the only new ones anon can call.
--   • Account numbers (contractor_secrets) are admins only, and revoked from
--     anon and service_role.
--   • created_by, updated_by and done_by come from the signed-in email,
--     set by triggers, never taken from the client.
--   • The clock is private.now(), so tests can pin it: set hub.now = '…'.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is not null then
    raise exception 'Home Hub v2 is already installed (public.hub_schema_version() exists). Nothing was changed.';
  end if;
end;
$$;

-- service_role (the hub-jobs function) runs the job functions with its own
-- rights, and they use the helpers in private.
grant usage on schema private to service_role;

-- The hub's clock. Everything that asks "what time is it?" uses this, so the
-- tests can pin the time with: set hub.now = '2026-11-01 06:30 America/New_York';
create function private.now()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('hub.now', true), '')::timestamptz, now());
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- The household list: parents and adults (who can sign in), kids and helpers
-- (who get a My day link instead). Changed only through save_person,
-- remove_person and rotate_day_token.
create table public.people (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(name) > 0 and name = trim(name)),
  role              text not null check (role in ('parent', 'adult', 'kid', 'helper')),
  email             text unique check (email = lower(email) and email like '%_@_%'),
  email_verified_at timestamptz,   -- set when they confirm the morning email; cleared when the email changes
  phone             text,
  color             text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  language          text not null default 'en' check (language in ('en', 'es')),
  day_token         text not null unique default encode(extensions.gen_random_bytes(16), 'hex')
                    check (day_token ~ '^[0-9a-f]{32}$'),
  digest_enabled    boolean not null default false,
  digest_time       time,          -- null = the household's time
  digest_day        text not null default 'today' check (digest_day in ('today', 'tomorrow')),  -- 'tomorrow' = evening preview
  digest_scope      text not null default 'mine' check (digest_scope in ('mine', 'everyone')),
  sort_order        int not null default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (digest_scope = 'mine' or role = 'parent')
);

-- One row of household settings.
create table public.household (
  id             boolean primary key default true check (id),
  tz             text not null default 'America/New_York'
                 check (tz in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
                               'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu')),
  digest_time    time not null default '06:30',
  days_off       date[] not null default '{}',   -- school holidays etc.
  pets_owner_id  uuid references public.people (id) on delete set null,
  house_owner_id uuid references public.people (id) on delete set null,
  updated_at     timestamptz not null default now(),
  updated_by     text
);

-- Events happen at a time; nothing to tick off. Weekly repeats only.
create table public.events (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (length(trim(title)) > 0),
  notes           text,
  location        text,
  start_date      date not null,
  end_date        date,            -- only for all-day, non-repeating, multi-day events
  start_time      time,
  end_time        time,
  ends_next_day   boolean not null default false,
  responsible_id  uuid references public.people (id) on delete set null,
  participant_ids uuid[] not null default '{}',
  contractor_id   uuid references public.contractors (id) on delete set null,
  private         boolean not null default false,
  repeat          text not null default 'none' check (repeat in ('none', 'weekly')),
  repeat_every    int not null default 1 check (repeat_every between 1 and 4),
  repeat_weekdays int[] not null default '{}' check (repeat_weekdays <@ '{1,2,3,4,5,6,7}'),  -- ISO, 1 = Monday
  repeat_until    date,
  skip_days_off   boolean not null default false,
  created_by      text,
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_date is null or (end_date >= start_date and start_time is null and repeat = 'none')),
  check (end_time is null or start_time is not null),
  check (end_time is null or ends_next_day or end_time > start_time),
  check (repeat_until is null or repeat_until >= start_date),
  check (repeat = 'weekly' or cardinality(repeat_weekdays) = 0),
  check (responsible_id is null or not (responsible_id = any (participant_ids)))
);

-- One-day changes to a repeating event: cancel it, change the time, or
-- change who's on it. on_date is the occurrence's own date.
create table public.event_changes (
  event_id        uuid not null references public.events (id) on delete cascade,
  on_date         date not null,
  cancelled       boolean not null default false,
  start_time      time,
  end_time        time,
  responsible_id  uuid references public.people (id) on delete set null,
  participant_ids uuid[],
  note            text,
  primary key (event_id, on_date)
);

-- Tasks need doing and get ticked off; they may repeat.
--   schedule:   on set dates (the 1st of every month), counted from anchor_date
--   after_done: a while after it's done (60 days after the last change)
create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (length(trim(title)) > 0),
  notes           text,
  category        text not null default 'other' check (category in ('home', 'pets', 'vehicle', 'health', 'family', 'other')),
  responsible_id  uuid references public.people (id) on delete set null,
  due_date        date,            -- null = inbox, no date yet
  due_time        time,
  lead_days       int not null default 0 check (lead_days between 0 and 90),
  project_id      uuid references public.projects (id) on delete cascade,
  contractor_id   uuid references public.contractors (id) on delete set null,
  private         boolean not null default false,
  repeat_mode     text not null default 'none' check (repeat_mode in ('none', 'schedule', 'after_done')),
  every_count     int check (every_count between 1 and 120),
  every_unit      text check (every_unit in ('day', 'week', 'month', 'year')),
  repeat_weekdays int[] not null default '{}' check (repeat_weekdays <@ '{1,2,3,4,5,6,7}'),
  anchor_date     date,
  last_done       date,
  active          boolean not null default true,
  done_at         timestamptz,     -- one-off tasks only
  done_by         text,
  created_by      text,
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((repeat_mode = 'none' and every_count is null and every_unit is null and anchor_date is null
          and cardinality(repeat_weekdays) = 0)
      or (repeat_mode <> 'none' and every_count is not null and every_unit is not null
          and due_date is not null and anchor_date is not null)),
  check (cardinality(repeat_weekdays) = 0 or (repeat_mode = 'schedule' and every_unit = 'week')),
  check (due_time is null or due_date is not null),
  check (done_at is null or repeat_mode = 'none')
);

-- What happened to each task: done, skipped, or missed (rolled on by the
-- daily job). The prev_* columns let undo_task put things back.
create table public.task_log (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references public.tasks (id) on delete cascade,
  occurrence     date,             -- the due date this entry is for
  status         text not null check (status in ('done', 'skipped', 'missed')),
  done_on        date,
  done_by        text,
  note           text,
  prev_due       date,
  prev_last_done date,
  prev_done_at   timestamptz,
  created_at     timestamptz not null default private.now(),
  seq            bigint generated always as identity   -- the order entries were written in (undo_task uses it)
);
create index task_log_task_idx on public.task_log (task_id, seq desc);

-- The Directory: contractors, accounts and utilities, services, emergency numbers.
alter table public.contractors
  add column kind         text not null default 'contractor' check (kind in ('contractor', 'account', 'service', 'emergency')),
  add column category     text,
  add column address      text,
  add column contract_end date,
  add column updated_by   text;

-- Account numbers: admins only.
create table public.contractor_secrets (
  contractor_id  uuid primary key references public.contractors (id) on delete cascade,
  account_number text,
  account_name   text,
  secret_notes   text,
  updated_at     timestamptz not null default now(),
  updated_by     text
);

-- task_dates is the Gantt engine's output, written by the client with every
-- schedule change: [{id, name, trade, trade_name, start, end, days, status, milestone}].
-- null = stale (see private.projects_mark_dates_stale).
alter table public.projects
  add column task_dates  jsonb check (task_dates is null or jsonb_typeof(task_dates) = 'array'),
  add column on_calendar boolean not null default true,
  add column owner_id    uuid references public.people (id) on delete set null;

-- Morning emails and confirmation emails: one row per person, day and kind.
-- The unique key is the claim, so two job runs never send the same email.
create table public.notification_log (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references public.people (id) on delete cascade,
  local_date date not null,        -- the day the email is about
  kind       text not null check (kind in ('digest', 'confirm')),
  channel    text not null default 'email',
  status     text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'skipped')),
  attempts   int not null default 1,
  claimed_at timestamptz not null default private.now(),
  detail     text,
  created_at timestamptz not null default private.now(),
  unique (person_id, local_date, kind, channel)
);

-- One row per hub-jobs run, for the Settings page.
create table public.job_runs (
  id          uuid primary key default gen_random_uuid(),
  action      text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  sent        int not null default 0,
  detail      text
);

create index events_start_idx on public.events (start_date);
create index tasks_due_idx on public.tasks (due_date) where active;
create index notification_log_claimed_idx on public.notification_log (claimed_at);

-- One row of agenda(), late_items() and heads_up().
create type public.agenda_item as (
  kind             text,        -- 'event', 'task', 'project' (heads_up also 'contract')
  item_id          uuid,        -- events.id, tasks.id, projects.id or contractors.id
  occurrence       date,        -- which occurrence: an event's own date, a task's due date
  title            text,
  day              date,
  end_day          date,
  all_day          boolean,
  start_at         timestamptz, -- timed items only
  end_at           timestamptz,
  local_start      time,
  local_end        time,
  responsible_id   uuid,
  participant_ids  uuid[],
  status           text,        -- 'open', 'done', 'cancelled', 'late', 'skipped'
  category         text,
  project_id       uuid,
  project_name     text,
  contractor_id    uuid,
  contractor_name  text,
  contractor_phone text,
  location         text,
  notes            text,
  private          boolean,
  repeating        boolean,
  changed          boolean,     -- an event_changes row applies to this day
  lead_days        int,
  milestone        boolean
);

-- ---------------------------------------------------------------------
-- The household's clock
-- ---------------------------------------------------------------------
-- The household's time zone, readable by every function whoever calls it.
create function private.tz()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select h.tz from public.household h), 'America/New_York');
$$;

create function public.clock(out local_date date, out local_time time, out tz text)
language sql
stable
set search_path = ''
as $$
  select (private.now() at time zone private.tz())::date,
         date_trunc('second', private.now() at time zone private.tz())::time,
         private.tz();
$$;

create function public.today_local()
returns date
language sql
stable
set search_path = ''
as $$
  select (private.now() at time zone private.tz())::date;
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

-- Audit columns come from the signed-in email, never from the client.
-- One function for every table; columns a table doesn't have are ignored.
-- Without a signed-in email (service_role, the SQL editor) the values are left alone.
create function private.stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  who   text := public.current_email();
  patch jsonb;
begin
  if tg_op = 'INSERT' then
    patch := case when who <> '' then jsonb_build_object('created_by', who, 'updated_by', who) else '{}' end;
  else
    patch := jsonb_build_object('created_at', to_jsonb(old) -> 'created_at',
                                'created_by', to_jsonb(old) -> 'created_by',
                                'updated_at', now())
          || case when who <> '' then jsonb_build_object('updated_by', who) else '{}' end;
  end if;

  -- done_by is whoever ticked it off (null again when it's reopened).
  if who <> '' and to_jsonb(new) ? 'done_by'
     and (tg_op = 'INSERT'
          or to_jsonb(new) -> 'done_at' is distinct from to_jsonb(old) -> 'done_at'
          or to_jsonb(new) -> 'done_by' is distinct from to_jsonb(old) -> 'done_by') then
    patch := patch || jsonb_build_object('done_by', case when to_jsonb(new) -> 'done_at' = 'null' then null else who end);
  end if;

  return jsonb_populate_record(new, patch);
end;
$$;

create trigger household_stamp before insert or update on public.household
  for each row execute function private.stamp();
create trigger people_stamp before insert or update on public.people
  for each row execute function private.stamp();
create trigger events_stamp before insert or update on public.events
  for each row execute function private.stamp();
create trigger tasks_stamp before insert or update on public.tasks
  for each row execute function private.stamp();
create trigger contractors_stamp before insert or update on public.contractors
  for each row execute function private.stamp();
create trigger contractor_secrets_stamp before insert or update on public.contractor_secrets
  for each row execute function private.stamp();

-- A new email address has to be confirmed again before morning emails go to it.
create function private.people_email_changed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    new.email_verified_at := null;
  end if;
  return new;
end;
$$;

create trigger people_email_changed before update on public.people
  for each row execute function private.people_email_changed();

-- A weekly event always happens on its first day's weekday.
create function private.events_weekdays()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.repeat = 'weekly' then
    new.repeat_weekdays := array(
      select distinct w from unnest(new.repeat_weekdays || extract(isodow from new.start_date)::int) w order by w);
  end if;
  return new;
end;
$$;

create trigger events_weekdays before insert or update on public.events
  for each row execute function private.events_weekdays();

-- A one-off task has no repeat settings; a repeating one counts from its
-- first due date unless told otherwise.
create function private.tasks_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.repeat_mode = 'none' then
    new.every_count := null;
    new.every_unit := null;
    new.anchor_date := null;
    new.repeat_weekdays := '{}';
  elsif new.anchor_date is null then
    new.anchor_date := new.due_date;
  end if;
  new.repeat_weekdays := array(select distinct w from unnest(new.repeat_weekdays) w order by w);
  return new;
end;
$$;

create trigger tasks_defaults before insert or update on public.tasks
  for each row execute function private.tasks_defaults();

-- The v2 client writes task_dates with every schedule change. A schedule
-- written without new task_dates (an old client) marks the dates stale.
create function private.projects_mark_dates_stale()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.schedule is distinct from old.schedule and new.task_dates is not distinct from old.task_dates then
    new.task_dates := null;
  end if;
  return new;
end;
$$;

create trigger projects_mark_dates_stale before update on public.projects
  for each row execute function private.projects_mark_dates_stale();

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------

-- Does this directory entry have an account number? (Members can't see
-- contractor_secrets, so the check runs with the owner's rights.)
create function private.has_secrets(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.contractor_secrets s where s.contractor_id = p_id);
$$;

alter table public.household          enable row level security;
alter table public.people             enable row level security;
alter table public.events             enable row level security;
alter table public.event_changes      enable row level security;
alter table public.tasks              enable row level security;
alter table public.task_log           enable row level security;
alter table public.contractor_secrets enable row level security;
alter table public.notification_log   enable row level security;
alter table public.job_runs           enable row level security;

create policy "Family can see the household" on public.household
  for select to authenticated using (private.is_member());
create policy "Admins change the household" on public.household
  for update to authenticated using (private.is_admin()) with check (private.is_admin());

-- No write policies: save_person, remove_person and rotate_day_token do that.
create policy "Family can see the family list" on public.people
  for select to authenticated using (private.is_member());

create policy "Family manages events" on public.events
  for all to authenticated using (private.is_member()) with check (private.is_member());
create policy "Family manages event changes" on public.event_changes
  for all to authenticated using (private.is_member()) with check (private.is_member());
create policy "Family manages tasks" on public.tasks
  for all to authenticated using (private.is_member()) with check (private.is_member());

-- No write policies: complete_task, skip_task, undo_task and the daily job write it.
create policy "Family can see task history" on public.task_log
  for select to authenticated using (private.is_member());

-- The Directory: members manage it, except that entries with an account
-- number can be changed or removed only by an admin.
drop policy "Family manages contractors" on public.contractors;
create policy "Family can see the directory" on public.contractors
  for select to authenticated using (private.is_member());
create policy "Family adds to the directory" on public.contractors
  for insert to authenticated with check (private.is_member());
create policy "Family updates the directory" on public.contractors
  for update to authenticated
  using (private.is_member() and (private.is_admin() or not private.has_secrets(id)))
  with check (private.is_member() and (private.is_admin() or not private.has_secrets(id)));
create policy "Family removes from the directory" on public.contractors
  for delete to authenticated
  using (private.is_member() and (private.is_admin() or not private.has_secrets(id)));

create policy "Admins manage account numbers" on public.contractor_secrets
  for all to authenticated using (private.is_admin()) with check (private.is_admin());
revoke all on public.contractor_secrets from public, anon, service_role;

-- Written by hub-jobs as service_role.
create policy "Admins can see the email log" on public.notification_log
  for select to authenticated using (private.is_admin());
create policy "Admins can see job runs" on public.job_runs
  for select to authenticated using (private.is_admin());

-- ---------------------------------------------------------------------
-- Recurrence. One implementation, used by the pages, My day and the email.
-- ---------------------------------------------------------------------

-- Monday of d's ISO week.
create function private.monday(d date)
returns date
language sql
immutable
set search_path = ''
as $$
  select d - (extract(isodow from d)::int - 1);
$$;

-- Is d in a weekly series that starts on p_start and repeats every p_every
-- weeks on the ISO weekdays p_weekdays? Weeks are counted Monday to Sunday,
-- so "every 2 weeks on Mon and Wed" keeps both days in the same week.
create function private.in_weekly_series(d date, p_start date, p_weekdays int[], p_every int)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select d >= p_start
     and extract(isodow from d)::int = any (p_weekdays)
     and ((private.monday(d) - private.monday(p_start)) / 7) % p_every = 0;
$$;

-- d plus n days, weeks, months or years. Months clamp to the month's last day.
create function private.add_units(d date, n int, unit text)
returns date
language sql
immutable
set search_path = ''
as $$
  select (d + case unit
                when 'day'   then make_interval(days => n)
                when 'week'  then make_interval(weeks => n)
                when 'month' then make_interval(months => n)
                when 'year'  then make_interval(years => n)
              end)::date;
$$;

-- A repeating task's series: anchor + k × (every_count units), k = 0, 1, 2, …
-- Always counted from the anchor, never from the previous date, so a task on
-- Jan 31 gives Feb 28, Mar 31, Apr 30, and one on Feb 29 gives Feb 28 in
-- common years and Feb 29 in leap years.
-- With weekdays (schedule, unit week), the series is the weekly series above.

-- Calendar months from a's month to b's month (Jan 31 → Feb 1 is 1).
create function private.months_between(a date, b date)
returns int
language sql
immutable
set search_path = ''
as $$
  select ((extract(year from b) - extract(year from a)) * 12 + extract(month from b) - extract(month from a))::int;
$$;

-- The first series date strictly after p_after.
create function private.series_after(t public.tasks, p_after date)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  start date;
  step  int;
  k     int;
begin
  if t.repeat_mode = 'none' or t.anchor_date is null or p_after is null then
    return null;
  end if;

  if t.every_unit = 'week' and cardinality(t.repeat_weekdays) > 0 then
    start := greatest(p_after + 1, t.anchor_date);
    return (select g::date
            from generate_series(start, start + 7 * t.every_count + 6, interval '1 day') g
            where private.in_weekly_series(g::date, t.anchor_date, t.repeat_weekdays, t.every_count)
            order by g
            limit 1);
  end if;

  if p_after < t.anchor_date then
    return t.anchor_date;
  end if;

  if t.every_unit in ('day', 'week') then
    step := t.every_count * case t.every_unit when 'week' then 7 else 1 end;
    return t.anchor_date + ((p_after - t.anchor_date) / step + 1) * step;
  end if;

  step := t.every_count * case t.every_unit when 'year' then 12 else 1 end;
  k := private.months_between(t.anchor_date, p_after) / step;
  if private.add_units(t.anchor_date, k * step, 'month') > p_after then
    return private.add_units(t.anchor_date, k * step, 'month');
  end if;
  return private.add_units(t.anchor_date, (k + 1) * step, 'month');
end;
$$;

-- The last series date on or before p_on (null if the series starts later).
create function private.series_on_or_before(t public.tasks, p_on date)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  step int;
  k    int;
begin
  if t.repeat_mode = 'none' or t.anchor_date is null or p_on is null or p_on < t.anchor_date then
    return null;
  end if;

  if t.every_unit = 'week' and cardinality(t.repeat_weekdays) > 0 then
    return (select g::date
            from generate_series(p_on, greatest(t.anchor_date, p_on - 7 * t.every_count - 6), interval '-1 day') g
            where private.in_weekly_series(g::date, t.anchor_date, t.repeat_weekdays, t.every_count)
            order by g desc
            limit 1);
  end if;

  if t.every_unit in ('day', 'week') then
    step := t.every_count * case t.every_unit when 'week' then 7 else 1 end;
    return t.anchor_date + ((p_on - t.anchor_date) / step) * step;
  end if;

  step := t.every_count * case t.every_unit when 'year' then 12 else 1 end;
  k := private.months_between(t.anchor_date, p_on) / step;
  if private.add_units(t.anchor_date, k * step, 'month') <= p_on then
    return private.add_units(t.anchor_date, k * step, 'month');
  end if;
  return private.add_units(t.anchor_date, (k - 1) * step, 'month');
end;
$$;

-- A project's task_dates come from the client, so read them defensively.
create function private.safe_date(s text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  return to_date(s, 'YYYY-MM-DD');
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Words. Fixed words in English and Spanish; titles stay as typed.
-- ---------------------------------------------------------------------
create function private.word(p_key text, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(w -> p_lang ->> p_key, w -> 'en' ->> p_key, p_key)
  from (select '{
    "en": {
      "today": "Today", "tomorrow": "Tomorrow", "late": "Late", "n_late": "{n} late",
      "heads_up": "Heads-up", "all_day": "All day", "with": "with", "more": "+{n} more",
      "and_more": "and {n} more", "nobody": "Nobody''s on it", "projects": "Projects",
      "their_day": "Their day", "inbox": "Inbox: {n} tasks with no date",
      "nothing_planned": "Nothing planned", "private_item": "Private item", "due": "due {d}",
      "contract_ends": "contract ends {d}", "starts": "starts", "open_my_day": "Open my day",
      "send_whatsapp": "WhatsApp", "send_text": "Text", "stop_emails": "Stop these emails"
    },
    "es": {
      "today": "Hoy", "tomorrow": "Mañana", "late": "Atrasado", "n_late": "{n} atrasadas",
      "heads_up": "Atención", "all_day": "Todo el día", "with": "con", "more": "+{n} más",
      "and_more": "y {n} más", "nobody": "Sin responsable", "projects": "Proyectos",
      "their_day": "Su día", "inbox": "Bandeja: {n} tareas sin fecha",
      "nothing_planned": "Nada planeado", "private_item": "Asunto privado", "due": "vence {d}",
      "contract_ends": "el contrato vence {d}", "starts": "empieza", "open_my_day": "Abrir mi día",
      "send_whatsapp": "WhatsApp", "send_text": "Mensaje", "stop_emails": "No enviar más correos"
    }
  }'::jsonb as w) dictionary;
$$;

-- "Tue Oct 27" / "mar 27 oct"
create function private.day_label(d date, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_lang
    when 'es' then (array['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'])[extract(isodow from d)]
                   || ' ' || extract(day from d) || ' '
                   || (array['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'])[extract(month from d)]
    else (array['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])[extract(isodow from d)]
         || ' ' || (array['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])[extract(month from d)]
         || ' ' || extract(day from d)
  end;
$$;

-- "Oct 20" / "20 oct"
create function private.short_date(d date, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_lang
    when 'es' then extract(day from d) || ' '
                   || (array['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'])[extract(month from d)]
    else (array['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])[extract(month from d)]
         || ' ' || extract(day from d)
  end;
$$;

-- "3:30pm" / "15:30"
create function private.time_label(t time, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when t is null then null
    when p_lang = 'es' then to_char(date '2000-01-01' + t, 'FMHH24:MI')
    else to_char(date '2000-01-01' + t, 'FMHH12:MI') || case when t < '12:00' then 'am' else 'pm' end
  end;
$$;

-- ---------------------------------------------------------------------
-- Read model
-- ---------------------------------------------------------------------

-- One task as an agenda row.
create function private.task_item(t public.tasks, p_day date, p_status text)
returns public.agenda_item
language sql
stable
set search_path = ''
as $$
  select row(
    'task', t.id, p_day, t.title, p_day, p_day, t.due_time is null,
    (p_day + t.due_time) at time zone private.tz(), null, t.due_time, null,
    t.responsible_id, '{}', p_status, t.category,
    t.project_id, (select p.name from public.projects p where p.id = t.project_id),
    t.contractor_id, k.name, k.phone,
    null, t.notes, t.private, t.repeat_mode <> 'none', false, t.lead_days, false
  )::public.agenda_item
  from (select 1) one
  left join public.contractors k on k.id = t.contractor_id;
$$;

-- Everything on the calendar between two dates (at most 62 days), with the
-- caller's rights: members see everything, everyone else sees nothing.
--   events:   every occurrence (a multi-day event is one row, day to end_day);
--             cancelled days come back with status 'cancelled'
--   tasks:    open tasks due in the range, done one-off tasks, and the done or
--             skipped entries of repeating tasks; future repeats aren't projected
--   projects: Gantt tasks overlapping the range, for projects on the calendar
create function public.agenda(p_from date, p_to date)
returns setof public.agenda_item
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz       text := private.tz();
  v_days_off date[] := coalesce((select h.days_off from public.household h), '{}');
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 61 then
    raise exception 'agenda() needs a range of 1 to 62 days.' using errcode = '22023';
  end if;

  return query
  with occurrence as (
    select e.*, d.day
    from public.events e
    cross join lateral (
      select e.start_date as day
      where e.repeat = 'none' and e.start_date <= p_to and coalesce(e.end_date, e.start_date) >= p_from
      union all
      select g::date
      from generate_series(greatest(p_from, e.start_date), least(p_to, e.repeat_until), interval '1 day') g
      where e.repeat = 'weekly'
        and private.in_weekly_series(g::date, e.start_date, e.repeat_weekdays, e.repeat_every)
    ) d
    where not (e.skip_days_off and d.day = any (v_days_off))
  ),
  -- That day's change, if any: a new time, new people, or cancelled.
  effective as (
    select o.*,
           c.event_id is not null as changed,
           coalesce(c.cancelled, false) as cancelled,
           c.note as change_note,
           case when c.start_time is not null or c.end_time is not null
                then coalesce(c.start_time, o.start_time) else o.start_time end as st,
           case when c.start_time is not null or c.end_time is not null
                then c.end_time else o.end_time end as et,
           case when c.start_time is not null or c.end_time is not null
                then c.end_time is not null and c.end_time <= coalesce(c.start_time, o.start_time)
                else o.ends_next_day end as next_day,
           coalesce(c.responsible_id, o.responsible_id) as resp,
           coalesce(c.participant_ids, o.participant_ids) as parts
    from occurrence o
    left join public.event_changes c on c.event_id = o.id and c.on_date = o.day
  ),
  -- No end time means one real hour after the start instant (not start + 1h on the wall clock,
  -- which is 0 or 2 hours next to a clock change).
  timed as (
    select f.*,
           (f.day + f.st) at time zone v_tz as s_at,
           case when f.et is null then ((f.day + f.st) at time zone v_tz) + interval '1 hour'
                else (f.day + f.et + case when f.next_day then interval '1 day' else interval '0' end) at time zone v_tz
           end as e_at
    from effective f
  ),
  -- Tasks: open ones due in the range, done one-offs, and the history of repeating ones.
  task_rows as (
    select t as task, t.due_date as occ,
           case when t.repeat_mode = 'none' and t.done_at is not null then 'done' else 'open' end as st
    from public.tasks t
    where t.due_date between p_from and p_to
      and ((t.repeat_mode = 'none' and t.done_at is not null) or t.active)
    union all
    select t, l.occurrence, l.status
    from public.task_log l
    join public.tasks t on t.id = l.task_id
    where t.repeat_mode <> 'none' and l.status in ('done', 'skipped') and l.occurrence between p_from and p_to
  ),
  gantt as (
    select p.id, p.name, p.owner_id, p.schedule, x.value as task,
           private.safe_date(x.value ->> 'start') as s_day,
           private.safe_date(x.value ->> 'end') as e_day
    from public.projects p
    cross join lateral jsonb_array_elements(p.task_dates) x
    where p.on_calendar and p.task_dates is not null
  )
  select u.*
  from (
    select 'event'::text, t.id, t.day, t.title, t.day,
           coalesce(t.end_date, case when t.st is null then t.day else (t.e_at at time zone v_tz)::date end),
           t.st is null,
           case when t.st is not null then t.s_at end,
           case when t.st is not null then t.e_at end,
           t.st, t.et,
           t.resp, array_remove(t.parts, t.resp),
           case when t.cancelled then 'cancelled' else 'open' end,
           null::text, null::uuid, null::text,
           t.contractor_id, k.name, k.phone,
           t.location, nullif(concat_ws(E'\n\n', t.change_note, t.notes), ''),
           t.private, t.repeat <> 'none', t.changed, null::int, false
    from timed t
    left join public.contractors k on k.id = t.contractor_id
    union all
    select i.*
    from task_rows r
    cross join lateral private.task_item(r.task, r.occ, r.st) i
    union all
    select 'project', g.id, g.s_day, g.task ->> 'name', g.s_day, g.e_day, true,
           null, null, null, null,
           g.owner_id, '{}', case when g.task ->> 'status' = 'done' then 'done' else 'open' end,
           null, g.id, g.name,
           k.id, k.name, k.phone,
           null, null, false, false, false, null, coalesce(g.task -> 'milestone' = 'true', false)
    from gantt g
    left join public.contractors k
      on k.id::text = g.schedule -> 'trades' -> (g.task ->> 'trade') ->> 'contractor_id'
    where g.s_day <= p_to and g.e_day >= p_from
  ) u (kind, item_id, occurrence, title, day, end_day, all_day, start_at, end_at, local_start, local_end,
       responsible_id, participant_ids, status, category, project_id, project_name,
       contractor_id, contractor_name, contractor_phone, location, notes, private, repeating, changed,
       lead_days, milestone)
  order by u.day, u.local_start nulls last, u.kind, u.title;
end;
$$;

-- Open tasks that are past due.
create function public.late_items()
returns setof public.agenda_item
language sql
stable
security invoker
set search_path = ''
as $$
  select i.*
  from public.tasks t
  cross join lateral private.task_item(t, t.due_date, 'late') i
  where t.active and t.done_at is null and t.due_date < public.today_local()
  order by t.due_date, t.due_time nulls last, t.title;
$$;

-- What to mention ahead of time on p_day: tasks inside their lead time, and
-- directory entries whose contract ends within 30 days (kind 'contract').
create function public.heads_up(p_day date)
returns setof public.agenda_item
language sql
stable
security invoker
set search_path = ''
as $$
  select u.*
  from (
    select i.*
    from public.tasks t
    cross join lateral private.task_item(t, t.due_date, 'open') i
    where t.active and t.done_at is null and t.lead_days > 0
      and t.due_date - t.lead_days <= p_day and p_day < t.due_date
    union all
    select 'contract', k.id, k.contract_end, k.name, k.contract_end, k.contract_end, true,
           null, null, null, null,
           null, '{}', 'open', k.category, null, null,
           k.id, k.name, k.phone,
           k.address, null, false, false, false, null, false
    from public.contractors k
    where k.contract_end between p_day and p_day + 30
  ) u
  order by u.day, u.title;
$$;

-- Sort order for one day's items: timed items by time, then all-day events,
-- then project tasks, then tasks without a time.
create function private.item_order(a public.agenda_item)
returns int
language sql
immutable
set search_path = ''
as $$
  select case when a.local_start is not null then 0 when a.kind = 'event' then 1 when a.kind = 'project' then 2 else 3 end;
$$;

-- One person's items on one day: theirs (in charge or with), not cancelled,
-- and project tasks only on the day they start.
create function private.person_items(p_person uuid, p_day date)
returns setof public.agenda_item
language sql
stable
set search_path = ''
as $$
  select a.*
  from public.agenda(p_day, p_day) a
  where (a.responsible_id = p_person or p_person = any (a.participant_ids))
    and a.status <> 'cancelled'
    and (a.kind <> 'project' or a.day = p_day)
  order by private.item_order(a), a.local_start, a.title;
$$;

-- People's names, in the household's order: "Taylor, Sam".
create function private.names(p_ids uuid[])
returns text
language sql
stable
set search_path = ''
as $$
  select string_agg(p.name, ', ' order by p.sort_order, p.name) from public.people p where p.id = any (p_ids);
$$;

-- Who else is on an item, from p_person's point of view:
-- the person in charge sees "with Taylor"; someone along sees "Morgan".
create function private.who_text(a public.agenda_item, p_person uuid, p_lang text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when a.responsible_id = p_person then
      case when cardinality(a.participant_ids) > 0
           then private.word('with', p_lang) || ' ' || private.names(a.participant_ids) end
    when p_person = any (a.participant_ids) then private.names(array[a.responsible_id])
    else nullif(concat_ws(' ' || private.word('with', p_lang) || ' ',
                          private.names(array[a.responsible_id]), private.names(a.participant_ids)), '')
  end;
$$;

-- One line of a day's message: "3:00pm Piano · with Taylor · Rivera Music 555-0150".
-- Private items show as "Private item", without who or which contractor.
create function private.text_line(a public.agenda_item, p_person uuid, p_lang text)
returns text
language sql
stable
set search_path = ''
as $$
  select concat_ws(' · ',
    coalesce(private.time_label(a.local_start, p_lang) || ' ', '')
      || case when a.local_start is null and a.kind = 'event' then private.word('all_day', p_lang) || ': ' else '' end
      || case when a.kind = 'task' then '☐ ' else '' end
      || case when a.kind = 'project' then a.project_name || ': ' else '' end
      || case when a.private then private.word('private_item', p_lang) else a.title end,
    case when not a.private then private.who_text(a, p_person, p_lang) end,
    case when not a.private then nullif(concat_ws(' ', a.contractor_name, a.contractor_phone), '') end);
$$;

-- The message for one person's day, in their language: timed items in order,
-- all-day events, tasks due, then up to 3 late tasks. Used by the Today
-- page's "Send their day" buttons and by the morning email.
-- Never notes, never account numbers; private items show as "Private item".
create function public.day_text(p_person uuid, p_day date)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  me     public.people;
  lang   text;
  lines  text[];
  late_n int;
begin
  select * into me from public.people p where p.id = p_person;
  if not found or p_day is null then
    return null;
  end if;
  lang := me.language;

  lines := array[me.name || ' · ' || private.day_label(p_day, lang)]
        || array(select private.text_line(a, p_person, lang)
                 from private.person_items(p_person, p_day) a
                 where a.status = 'open'
                 order by private.item_order(a), a.local_start, a.title);
  if cardinality(lines) = 1 then
    lines := lines || private.word('nothing_planned', lang);
  end if;

  select count(*) into late_n
  from public.tasks t
  where t.responsible_id = p_person and t.active and t.done_at is null and t.due_date < p_day;
  if late_n > 0 then
    lines := lines || (private.word('late', lang) || ':')
          || array(select '☐ ' || case when t.private then private.word('private_item', lang) else t.title end
                          || ' (' || private.short_date(t.due_date, lang) || ')'
                   from public.tasks t
                   where t.responsible_id = p_person and t.active and t.done_at is null and t.due_date < p_day
                   order by t.due_date, t.title
                   limit 3);
    if late_n > 3 then
      lines := lines || replace(private.word('more', lang), '{n}', (late_n - 3)::text);
    end if;
  end if;

  return array_to_string(lines, E'\n');
end;
$$;

-- ---------------------------------------------------------------------
-- Tasks: done, skip, undo, and the daily roll-on of missed dates
-- ---------------------------------------------------------------------

-- Shared by complete_task (signed in) and complete_by_token (My day).
-- p_who is recorded as done_by.
create function private.complete_task(p_id uuid, p_occurrence date, p_done_on date, p_note text, p_who text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t       public.tasks;
  today   date := public.today_local();
  done_on date := coalesce(p_done_on, public.today_local());
  next_due date;
  log_id  uuid;
begin
  select * into t from public.tasks where id = p_id for update;
  if not found then
    raise exception 'That task no longer exists.' using errcode = 'P0002';
  end if;
  if done_on > today then
    raise exception 'A task can''t be done on a day that hasn''t happened yet.' using errcode = '22023';
  end if;

  if t.repeat_mode = 'none' then
    if t.done_at is not null then
      raise exception 'already done' using errcode = 'P0001', hint = 'Someone already ticked this off.';
    end if;
    update public.tasks set done_at = private.now(), done_by = p_who where id = t.id;
    insert into public.task_log (task_id, occurrence, status, done_on, done_by, note, prev_done_at)
    values (t.id, t.due_date, 'done', done_on, p_who, p_note, t.done_at)
    returning id into log_id;
    return log_id;
  end if;

  -- A stale screen or a double tap names an occurrence that has moved on.
  if p_occurrence is not null and p_occurrence is distinct from t.due_date then
    raise exception 'already completed' using errcode = 'P0001', hint = 'This date was already ticked off or skipped.';
  end if;
  if done_on < t.due_date - interval '1 year' then
    raise exception 'That date is more than a year before the task was due.' using errcode = '22023';
  end if;

  next_due := case t.repeat_mode
                when 'schedule' then private.series_after(t, greatest(t.due_date, done_on))
                else private.add_units(done_on, t.every_count, t.every_unit)
              end;
  update public.tasks set due_date = next_due, last_done = done_on where id = t.id;
  insert into public.task_log (task_id, occurrence, status, done_on, done_by, note, prev_due, prev_last_done)
  values (t.id, t.due_date, 'done', done_on, p_who, p_note, t.due_date, t.last_done)
  returning id into log_id;
  return log_id;
end;
$$;

-- Tick a task off. Repeating tasks move to their next date; p_occurrence is
-- the due date the screen showed. Returns the task_log id (for Undo).
create function public.complete_task(p_id uuid, p_occurrence date default null, p_done_on date default null, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_member() then
    raise exception 'Only family members can do that.' using errcode = '42501';
  end if;
  return private.complete_task(p_id, p_occurrence, p_done_on, p_note, public.current_email());
end;
$$;

-- Skip this time (repeating tasks only). Returns the task_log id.
create function public.skip_task(p_id uuid, p_occurrence date default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t        public.tasks;
  today    date := public.today_local();
  next_due date;
  log_id   uuid;
begin
  if not private.is_member() then
    raise exception 'Only family members can do that.' using errcode = '42501';
  end if;
  select * into t from public.tasks where id = p_id for update;
  if not found then
    raise exception 'That task no longer exists.' using errcode = 'P0002';
  end if;
  if t.repeat_mode = 'none' then
    raise exception 'Only repeating tasks can be skipped.' using errcode = '22023';
  end if;
  if p_occurrence is not null and p_occurrence is distinct from t.due_date then
    raise exception 'already completed' using errcode = 'P0001', hint = 'This date was already ticked off or skipped.';
  end if;

  -- after_done counts from today, or from the due date if that's later, so a skip never
  -- brings a task closer.
  next_due := case t.repeat_mode
                when 'schedule' then private.series_after(t, greatest(t.due_date, today))
                else private.add_units(greatest(t.due_date, today), t.every_count, t.every_unit)
              end;
  update public.tasks set due_date = next_due where id = t.id;
  insert into public.task_log (task_id, occurrence, status, done_by, prev_due, prev_last_done)
  values (t.id, t.due_date, 'skipped', public.current_email(), t.due_date, t.last_done)
  returning id into log_id;
  return log_id;
end;
$$;

-- Undo a done, skip or missed entry: only the task's latest one, within 7 days.
-- Returns the task id.
create function public.undo_task(p_log_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.task_log;
  t public.tasks;
begin
  if not private.is_member() then
    raise exception 'Only family members can do that.' using errcode = '42501';
  end if;
  select * into l from public.task_log where id = p_log_id;
  if not found then
    raise exception 'There''s nothing to undo.' using errcode = 'P0002';
  end if;
  select * into t from public.tasks where id = l.task_id for update;
  -- Read the entry again now that the task is locked: a second Undo tap may have removed it.
  select * into l from public.task_log where id = p_log_id;
  if not found then
    raise exception 'There''s nothing to undo.' using errcode = 'P0002';
  end if;

  -- Entries for one task are written while it is locked, so seq is their real order.
  -- (created_at is when each transaction started, which can be the other way round.)
  if exists (select 1 from public.task_log x where x.task_id = l.task_id and x.seq > l.seq) then
    raise exception 'Only the latest change to a task can be undone.' using errcode = '22023';
  end if;
  if l.created_at < private.now() - interval '7 days' then
    raise exception 'That was more than 7 days ago, so it can''t be undone.' using errcode = '22023';
  end if;

  if t.repeat_mode = 'none' then
    update public.tasks set done_at = l.prev_done_at, done_by = null where id = t.id;
  else
    update public.tasks set due_date = l.prev_due, last_done = l.prev_last_done where id = t.id;
  end if;
  delete from public.task_log where id = l.id;
  return t.id;
end;
$$;

-- Daily: a task on set dates whose next date has arrived undone is logged
-- 'missed' and moves to its latest date that isn't in the future.
-- Tasks done "a while after" never roll; they stay late until done.
-- Returns how many tasks moved.
create function public.roll_missed_tasks()
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t     public.tasks;
  today date := public.today_local();
  moved int := 0;
begin
  for t in
    select * from public.tasks
    where active and repeat_mode = 'schedule' and due_date < today
    order by id
    for update
  loop
    if private.series_after(t, t.due_date) <= today then
      insert into public.task_log (task_id, occurrence, status, prev_due, prev_last_done)
      values (t.id, t.due_date, 'missed', t.due_date, t.last_done);
      update public.tasks set due_date = private.series_on_or_before(t, today) where id = t.id;
      moved := moved + 1;
    end if;
  end loop;
  return moved;
end;
$$;

-- ---------------------------------------------------------------------
-- The family list (admins). The client never writes members directly:
-- these keep people and the sign-in list in step, in one transaction.
-- ---------------------------------------------------------------------

-- Add (no id) or change (with id) a person. Keys left out of p keep their
-- value. p_can_sign_in adds, updates or removes their sign-in.
-- Parents who can sign in are admins; adults are members; kids and helpers
-- can't sign in. Nobody can remove, rename or demote their own sign-in here.
create function public.save_person(p jsonb, p_can_sign_in boolean)
returns public.people
language plpgsql
security definer
set search_path = ''
as $$
declare
  me  text := public.current_email();
  old public.people;
  r   public.people;
  -- Never taken from the client.
  fixed text[] := array['id', 'day_token', 'email_verified_at', 'created_at', 'updated_at'];
begin
  if not private.is_admin() then
    raise exception 'Only an admin can change the family list.' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' or p_can_sign_in is null then
    raise exception 'save_person needs a person and whether they can sign in.' using errcode = '22023';
  end if;

  if p ->> 'id' is not null then
    select * into old from public.people where id = (p ->> 'id')::uuid for update;
    if not found then
      raise exception 'That person is no longer on the family list.' using errcode = 'P0002';
    end if;
    r := jsonb_populate_record(old, p - fixed);
  else
    r := jsonb_populate_record(null::public.people,
           '{"color": "#64748b", "language": "en", "digest_enabled": false, "digest_day": "today",
             "digest_scope": "mine", "sort_order": 0, "active": true}'::jsonb || (p - fixed));
  end if;
  r.name  := trim(r.name);
  r.email := lower(nullif(trim(r.email), ''));
  r.phone := nullif(trim(r.phone), '');
  if r.role is distinct from 'parent' then
    r.digest_scope := 'mine';
  end if;

  if p_can_sign_in then
    if r.role not in ('parent', 'adult') then
      raise exception 'Only parents and adults can sign in. Kids and helpers get a My day link instead.' using errcode = '22023';
    end if;
    if r.email is null then
      raise exception 'Add an email address before turning on sign-in.' using errcode = '22023';
    end if;
    if not r.active then
      raise exception 'Someone who isn''t active can''t sign in.' using errcode = '22023';
    end if;
  end if;
  if (old.email = me or r.email = me)
     and (not p_can_sign_in or r.email is distinct from me or r.role <> 'parent' or not r.active) then
    raise exception 'You can''t remove or change your own sign-in. Ask another admin.' using errcode = '42501';
  end if;

  if exists (select 1 from public.people x where x.email = r.email and x.id is distinct from old.id) then
    raise exception 'Someone on the family list already has that email address.' using errcode = '23505';
  end if;

  if old.id is null then
    insert into public.people (name, role, email, phone, color, language, digest_enabled, digest_time,
                               digest_day, digest_scope, sort_order, active)
    values (r.name, r.role, r.email, r.phone, r.color, r.language, r.digest_enabled, r.digest_time,
            r.digest_day, r.digest_scope, r.sort_order, r.active)
    returning * into r;
  else
    update public.people
    set name = r.name, role = r.role, email = r.email, phone = r.phone, color = r.color, language = r.language,
        digest_enabled = r.digest_enabled, digest_time = r.digest_time, digest_day = r.digest_day,
        digest_scope = r.digest_scope, sort_order = r.sort_order, active = r.active
    where id = old.id
    returning * into r;
  end if;

  -- The sign-in list follows.
  if old.email is not null and (old.email is distinct from r.email or not p_can_sign_in) then
    delete from public.members where email = old.email;
  end if;
  if p_can_sign_in then
    insert into public.members (email, name, role)
    values (r.email, r.name, case r.role when 'parent' then 'admin' else 'member' end)
    on conflict (email) do update set name = excluded.name, role = excluded.role;
  elsif r.email is not null then
    delete from public.members where email = r.email;
  end if;

  return r;
end;
$$;

-- Take someone off the family list, with their sign-in. Their items stay,
-- with nobody in charge.
create function public.remove_person(p_person uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  old public.people;
begin
  if not private.is_admin() then
    raise exception 'Only an admin can change the family list.' using errcode = '42501';
  end if;
  select * into old from public.people where id = p_person for update;
  if not found then
    return;
  end if;
  if old.email = public.current_email() then
    raise exception 'You can''t remove yourself. Ask another admin.' using errcode = '42501';
  end if;

  delete from public.members where email = old.email;
  update public.events set participant_ids = array_remove(participant_ids, old.id)
  where old.id = any (participant_ids);
  update public.event_changes set participant_ids = array_remove(participant_ids, old.id)
  where old.id = any (participant_ids);
  delete from public.people where id = old.id;
end;
$$;

-- A new My day link for one person; the old one stops working at once.
create function public.rotate_day_token(p_person uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text;
begin
  if not private.is_admin() then
    raise exception 'Only an admin can do that.' using errcode = '42501';
  end if;
  update public.people set day_token = encode(extensions.gen_random_bytes(16), 'hex')
  where id = p_person
  returning day_token into token;
  if token is null then
    raise exception 'That person is no longer on the family list.' using errcode = 'P0002';
  end if;
  return token;
end;
$$;

-- ---------------------------------------------------------------------
-- My day page (no sign-in). The token is the only key; these four are the
-- only new functions anon can call.
-- ---------------------------------------------------------------------
create function private.person_by_token(p_token text)
returns public.people
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.people p
  where p_token ~ '^[0-9a-f]{32}$' and p.day_token = p_token and p.active;
$$;

-- One My day item: what the page shows, and nothing more (no notes, no
-- other people's details). Private items show as "Private item".
create function private.my_day_item(a public.agenda_item, p_person uuid, p_lang text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', a.kind,
    'item_id', a.item_id,
    'occurrence', a.occurrence,
    'day', a.day,
    'end_day', a.end_day,
    'title', case when a.private then private.word('private_item', p_lang) else a.title end,
    'all_day', a.all_day,
    'start_time', to_char(date '2000-01-01' + a.local_start, 'HH24:MI'),
    'end_time', to_char(date '2000-01-01' + a.local_end, 'HH24:MI'),
    'time_label', private.time_label(a.local_start, p_lang),
    'location', case when not a.private then a.location end,
    'contractor_name', case when not a.private then a.contractor_name end,
    'contractor_phone', case when not a.private then a.contractor_phone end,
    'status', a.status,
    'mine', a.kind = 'task' and a.responsible_id = p_person);
$$;

-- Today and tomorrow for the person with this token, or null.
create function public.get_person_day(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me    public.people;
  today date := public.today_local();
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return null;
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
                    order by d.day)
             from (values (today), (today + 1)) d (day)),
    'late', coalesce((select jsonb_agg(private.my_day_item(i, me.id, me.language) order by t.due_date, t.title)
                      from public.tasks t
                      cross join lateral private.task_item(t, t.due_date, 'late') i
                      where t.responsible_id = me.id and t.active and t.done_at is null and t.due_date < today),
                     '[]'));
end;
$$;

-- Tick off one of their own tasks (only tasks they're in charge of).
-- Returns the task_log id, or null for an unknown link.
create function public.complete_by_token(p_token text, p_task_id uuid, p_occurrence date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.people;
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if not exists (select 1 from public.tasks t where t.id = p_task_id and t.responsible_id = me.id) then
    raise exception 'That task isn''t on your list.' using errcode = '42501';
  end if;
  return private.complete_task(p_task_id, p_occurrence, null, null, me.name || ' (My day)');
end;
$$;

-- The "Yes, send me the morning email" button. True if the link was valid.
create function public.confirm_digest(p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.people;
begin
  me := private.person_by_token(p_token);
  if me.id is null or me.email is null then
    return false;
  end if;
  update public.people set email_verified_at = private.now() where id = me.id;
  return true;
end;
$$;

-- The "Stop these emails" button. True if the link was valid.
create function public.stop_digest(p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.people;
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return false;
  end if;
  update public.people set digest_enabled = false where id = me.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Morning email jobs (service_role only: the hub-jobs function)
-- ---------------------------------------------------------------------

-- Emails left today (UTC day). Resend's free plan allows 100 a day, shared
-- with sign-in codes; the hub keeps 40 of those for sign-in.
create function public.email_budget_left()
returns int
language sql
stable
security invoker
set search_path = ''
as $$
  with since as (select date_trunc('day', private.now() at time zone 'UTC') at time zone 'UTC' as t)
  select greatest(0, 60
    - (select count(*) from public.email_log e, since where e.created_at >= since.t)
    - (select count(*) from public.notification_log n, since
       where n.status in ('sending', 'sent') and n.claimed_at >= since.t))::int;
$$;

-- Who should get an email now:
--   digest:  people with the morning email on and a confirmed address, whose
--            time came in the last 3 hours (local_date = the day it's about;
--            a 'tomorrow' person's evening email is about the next day)
--   confirm: people with the morning email on but an unconfirmed address,
--            at most one confirmation email every 3 days
-- Rows already sent, skipped, in flight or out of attempts are left out.
create function public.digest_due(p_limit int default 50)
returns table (person_id uuid, local_date date, kind text)
language sql
stable
security invoker
set search_path = ''
as $$
  with clock as (
    select private.now() as now, public.today_local() as today, private.tz() as tz,
           (select h.digest_time from public.household h) as digest_time
  ),
  candidates as (
    select p.id as person_id,
           s.send_date + case p.digest_day when 'tomorrow' then 1 else 0 end as local_date,
           'digest'::text as kind,
           (s.send_date + coalesce(p.digest_time, c.digest_time, '06:30')) at time zone c.tz as due_at
    from public.people p
    cross join clock c
    cross join lateral (values (c.today - 1), (c.today)) s (send_date)
    where p.active and p.digest_enabled and p.email is not null and p.email_verified_at is not null
    union all
    select p.id, c.today, 'confirm', c.now
    from public.people p
    cross join clock c
    where p.active and p.digest_enabled and p.email is not null and p.email_verified_at is null
      and not exists (select 1 from public.notification_log n
                      where n.person_id = p.id and n.kind = 'confirm'
                        and n.local_date > c.today - 3 and n.local_date < c.today)
  )
  select x.person_id, x.local_date, x.kind
  from candidates x
  cross join clock c
  where x.due_at <= c.now and x.due_at > c.now - interval '3 hours'
    and not exists (select 1 from public.notification_log n
                    where n.person_id = x.person_id and n.local_date = x.local_date
                      and n.kind = x.kind and n.channel = 'email'
                      and not (n.attempts < 3
                               and (n.status = 'failed'
                                    or (n.status = 'sending' and n.claimed_at < c.now - interval '10 minutes'))))
  order by x.due_at, x.person_id
  limit p_limit;
$$;

-- Claim one email before sending it. Returns the notification_log id, or
-- null if it was already sent, is being sent, or ran out of attempts.
-- A failed row, or one stuck in 'sending' for 10 minutes, is retried (3 tries).
create function public.claim_notification(p_person uuid, p_local_date date, p_kind text)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  insert into public.notification_log as n (person_id, local_date, kind, channel, status, attempts, claimed_at)
  values (p_person, p_local_date, p_kind, 'email', 'sending', 1, private.now())
  on conflict (person_id, local_date, kind, channel) do update
    set status = 'sending', attempts = n.attempts + 1, claimed_at = private.now(), detail = null
    where n.attempts < 3
      and (n.status = 'failed' or (n.status = 'sending' and n.claimed_at < private.now() - interval '10 minutes'))
  returning n.id;
$$;

create function public.finish_notification(p_id uuid, p_status text, p_detail text default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'finish_notification: status must be sent, failed or skipped.' using errcode = '22023';
  end if;
  update public.notification_log
  set status = p_status, detail = left(p_detail, 500)
  where id = p_id and status = 'sending';
end;
$$;

-- One item in the morning email.
create function private.digest_item(a public.agenda_item, p_person uuid, p_lang text, p_hide boolean,
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
                     case when a.kind = 'event' then private.word('all_day', p_lang) end),
    'title', case when p_hide then private.word('private_item', p_lang) else a.title end,
    'detail', case when p_hide then p_detail
                   else nullif(concat_ws(' · ', p_detail, private.who_text(a, p_person, p_lang),
                                         case when a.kind <> 'contract' then a.contractor_name end), '') end,
    'contractor_phone', case when not p_hide then a.contractor_phone end,
    'status', a.status);
$$;

-- Everything the morning email needs, for one person and the day it's about.
-- Sections: today, late (3 at most), heads_up; parents also get people (one
-- block per kid or helper, with the text to send them), nobody (items nobody
-- is on), projects (one line per project with tasks starting that day) and,
-- on Mondays, inbox_count. empty = a non-parent with nothing to say (send nothing).
-- An evening-before email (digest_day 'tomorrow') is read the day before: its
-- "today" label says Tomorrow, and the morning after is named by its day.
create function public.digest_for(p_person uuid, p_local_date date)
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
  mine     public.agenda_item[];
  v_late   jsonb;
  late_n   int;
  v_heads  jsonb;
  v_people jsonb := '[]';
  v_nobody jsonb := '[]';
  nobody_n int := 0;
  v_projects jsonb := '[]';
  v_inbox  int;
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

  day_rows := array(select a from public.agenda(d, d) a where a.status = 'open');

  -- Today: their events and tasks (with 'everyone', everybody's), in time order.
  -- Items nobody is on go to the parents' "Nobody's on it" instead.
  mine := array(
    select a from unnest(day_rows) a
    where a.kind in ('event', 'task')
      and case when everyone then a.responsible_id is not null or cardinality(a.participant_ids) > 0
               else a.responsible_id = me.id or me.id = any (a.participant_ids) end
    order by private.item_order(a), a.local_start, a.title);

  -- Late: at most 3, oldest first.
  select count(*) into late_n
  from public.tasks t
  where t.active and t.done_at is null and t.due_date < d
    and case when everyone then t.responsible_id is not null else t.responsible_id = me.id end;
  select coalesce(jsonb_agg(private.digest_item(x.i, me.id, lang, hide and x.private, null,
                                                replace(private.word('due', lang), '{d}', private.short_date(x.due_date, lang)))
                            order by x.due_date, x.title), '[]')
  into v_late
  from (select i, t.private, t.due_date, t.title
        from public.tasks t
        cross join lateral private.task_item(t, t.due_date, 'late') i
        where t.active and t.done_at is null and t.due_date < d
          and case when everyone then t.responsible_id is not null else t.responsible_id = me.id end
        order by t.due_date, t.title
        limit 3) x;

  -- Heads-up: tasks inside their lead time, contracts ending within 30 days
  -- (parents), and anything tomorrow before 9am.
  select coalesce(jsonb_agg(h.item order by h.day, h.sort, h.title), '[]')
  into v_heads
  from (
    select distinct on (u.kind, u.item_id) u.item, u.day, u.sort, u.title
    from (
      select private.digest_item(a, me.id, lang, hide and a.private, null,
               replace(private.word(case when a.kind = 'contract' then 'contract_ends' else 'due' end, lang),
                       '{d}', private.short_date(a.day, lang))) as item,
             a.kind, a.item_id, a.day, 1 as sort, a.title
      from public.heads_up(d) a
      where (a.kind = 'task' and (a.responsible_id = me.id or (parent and (everyone or a.responsible_id is null))))
         or (a.kind = 'contract' and parent)
      union all
      select private.digest_item(a, me.id, lang, hide and a.private,
               case when evening then private.day_label(d + 1, lang) else private.word('tomorrow', lang) end
                 || ' ' || private.time_label(a.local_start, lang), null),
             a.kind, a.item_id, a.day, 0, a.title
      from public.agenda(d + 1, d + 1) a
      where a.status = 'open' and a.kind in ('event', 'task') and a.local_start < '09:00'
        and case when everyone then a.responsible_id is not null or cardinality(a.participant_ids) > 0
                 else a.responsible_id = me.id or me.id = any (a.participant_ids) end
    ) u
    order by u.kind, u.item_id, u.sort
  ) h;

  if parent then
    -- One block per kid or helper, with the message to send them.
    select coalesce(jsonb_agg(jsonb_build_object(
             'person_id', p.id, 'name', p.name, 'role', p.role, 'phone', p.phone, 'language', p.language,
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
               replace(private.word('due', lang), '{d}', private.short_date(t.due_date, lang))),
             1, t.due_date, 3, null, t.title
      from public.tasks t
      cross join lateral private.task_item(t, t.due_date, 'late') i
      where t.active and t.done_at is null and t.due_date < d and t.responsible_id is null
    )
    select coalesce((select jsonb_agg(item order by grp, day, o, local_start, title)
                     from (select * from unassigned order by grp, day, o, local_start, title limit 5) top), '[]'),
           count(*)
    into v_nobody, nobody_n
    from unassigned;

    -- Projects: one line per project with tasks starting today. A project owned
    -- by a parent goes to that parent; any other (no owner, or an owner who gets
    -- no project lines because they aren't an active parent) goes to every parent.
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
             or not exists (select 1 from public.people o where o.id = a.responsible_id and o.role = 'parent' and o.active))
      group by a.project_id, a.project_name
    ) x;

    if extract(isodow from d) = 1 then
      select count(*) into v_inbox from public.tasks t where t.active and t.done_at is null and t.due_date is null;
    end if;
  end if;

  -- The subject carries the content: "Tue Oct 27: 8:00am Drop off dogs · 3:00pm Pick up Taylor · +2".
  subject := private.day_label(d, lang) || ': ' || coalesce(
    (select string_agg(coalesce(private.time_label(mine[i].local_start, lang) || ' ', '')
                         || case when hide and mine[i].private then private.word('private_item', lang) else mine[i].title end,
                       ' · ' order by i)
     from generate_subscripts(mine, 1) i
     where i <= 2)
      || case when cardinality(mine) > 2 then ' · +' || (cardinality(mine) - 2) else '' end,
    case when late_n > 0 then replace(private.word('n_late', lang), '{n}', late_n::text) end,
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
    'empty', not parent and cardinality(mine) = 0 and late_n = 0 and jsonb_array_length(v_heads) = 0,
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
      'inbox', case when v_inbox is not null then replace(private.word('inbox', lang), '{n}', v_inbox::text) end,
      'nothing_planned', private.word('nothing_planned', lang),
      'open_my_day', private.word('open_my_day', lang),
      'send_whatsapp', private.word('send_whatsapp', lang),
      'send_text', private.word('send_text', lang),
      'stop_emails', private.word('stop_emails', lang)));
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version and whoami
-- ---------------------------------------------------------------------

-- The client runs in v1 mode until this exists.
create function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 2;
$$;

-- As before, plus 'person': the caller's row on the family list, or null.
create or replace function public.whoami()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select to_jsonb(m) || jsonb_build_object('person', (
           select jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'language', p.language, 'color', p.color)
           from public.people p where p.email = m.email))
  from public.members m where m.email = public.current_email();
$$;

-- ---------------------------------------------------------------------
-- Starting data: one person per member (admin → parent, member → adult),
-- in the order they were added, with the hub's colours; one household row.
-- ---------------------------------------------------------------------
insert into public.people (name, role, email, color, sort_order)
select trim(m.name),
       case m.role when 'admin' then 'parent' else 'adult' end,
       m.email,
       (array['#9333ea', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#db2777', '#b91c1c', '#92622f', '#64748b'])
         [(row_number() over (order by m.created_at, m.email) - 1) % 10 + 1],
       row_number() over (order by m.created_at, m.email) - 1
from public.members m;

insert into public.household (id) values (true);

-- ---------------------------------------------------------------------
-- Function permissions
-- New public functions: revoke from public and anon, then grant to who calls them.
-- ---------------------------------------------------------------------

-- Signed-in pages (service_role too: the email uses the same read model).
revoke execute on function public.clock()                   from public, anon;
revoke execute on function public.today_local()             from public, anon;
revoke execute on function public.agenda(date, date)        from public, anon;
revoke execute on function public.late_items()              from public, anon;
revoke execute on function public.heads_up(date)            from public, anon;
revoke execute on function public.day_text(uuid, date)      from public, anon;
revoke execute on function public.hub_schema_version()      from public, anon;
grant  execute on function public.clock()                   to authenticated, service_role;
grant  execute on function public.today_local()             to authenticated, service_role;
grant  execute on function public.agenda(date, date)        to authenticated, service_role;
grant  execute on function public.late_items()              to authenticated, service_role;
grant  execute on function public.heads_up(date)            to authenticated, service_role;
grant  execute on function public.day_text(uuid, date)      to authenticated, service_role;
grant  execute on function public.hub_schema_version()      to authenticated, service_role;

-- Signed-in actions (each checks membership or admin first).
revoke execute on function public.complete_task(uuid, date, date, text) from public, anon, service_role;
revoke execute on function public.skip_task(uuid, date)                 from public, anon, service_role;
revoke execute on function public.undo_task(uuid)                       from public, anon, service_role;
revoke execute on function public.save_person(jsonb, boolean)           from public, anon, service_role;
revoke execute on function public.remove_person(uuid)                   from public, anon, service_role;
revoke execute on function public.rotate_day_token(uuid)                from public, anon, service_role;
grant  execute on function public.complete_task(uuid, date, date, text) to authenticated;
grant  execute on function public.skip_task(uuid, date)                 to authenticated;
grant  execute on function public.undo_task(uuid)                       to authenticated;
grant  execute on function public.save_person(jsonb, boolean)           to authenticated;
grant  execute on function public.remove_person(uuid)                   to authenticated;
grant  execute on function public.rotate_day_token(uuid)                to authenticated;

-- The My day page: the token is the key.
revoke execute on function public.get_person_day(text)                 from public, service_role;
revoke execute on function public.complete_by_token(text, uuid, date)  from public, service_role;
revoke execute on function public.confirm_digest(text)                 from public, service_role;
revoke execute on function public.stop_digest(text)                    from public, service_role;
grant  execute on function public.get_person_day(text)                 to anon, authenticated;
grant  execute on function public.complete_by_token(text, uuid, date)  to anon, authenticated;
grant  execute on function public.confirm_digest(text)                 to anon, authenticated;
grant  execute on function public.stop_digest(text)                    to anon, authenticated;

-- Jobs: service_role only.
revoke execute on function public.roll_missed_tasks()                        from public, anon, authenticated;
revoke execute on function public.email_budget_left()                        from public, anon, authenticated;
revoke execute on function public.digest_due(int)                            from public, anon, authenticated;
revoke execute on function public.claim_notification(uuid, date, text)       from public, anon, authenticated;
revoke execute on function public.finish_notification(uuid, text, text)      from public, anon, authenticated;
revoke execute on function public.digest_for(uuid, date)                     from public, anon, authenticated;
grant  execute on function public.roll_missed_tasks()                        to service_role;
grant  execute on function public.email_budget_left()                        to service_role;
grant  execute on function public.digest_due(int)                            to service_role;
grant  execute on function public.claim_notification(uuid, date, text)       to service_role;
grant  execute on function public.finish_notification(uuid, text, text)      to service_role;
grant  execute on function public.digest_for(uuid, date)                     to service_role;

-- v1 functions that anon never needs (the share page uses only get_shared_project).
revoke execute on function public.current_email()    from public, anon;
revoke execute on function public.touch_updated_at() from public, anon;
grant  execute on function public.current_email()    to authenticated, service_role;
grant  execute on function public.touch_updated_at() to authenticated, service_role;

-- Helpers in private: none for anon. The read model's helpers run with the
-- caller's rights; the ones that act for someone else (complete_task with a
-- given name, person_by_token) are reachable only through the RPCs above.
revoke execute on all functions in schema private from public, anon;
grant  execute on function private.is_member()   to authenticated;
grant  execute on function private.is_admin()    to authenticated;
grant  execute on function private.has_secrets(uuid) to authenticated;
grant  execute on function private.now()         to authenticated, service_role;
grant  execute on function private.tz()          to authenticated, service_role;
grant  execute on function private.monday(date)  to authenticated, service_role;
grant  execute on function private.in_weekly_series(date, date, int[], int) to authenticated, service_role;
grant  execute on function private.add_units(date, int, text)               to authenticated, service_role;
grant  execute on function private.months_between(date, date)               to authenticated, service_role;
grant  execute on function private.series_after(public.tasks, date)         to authenticated, service_role;
grant  execute on function private.series_on_or_before(public.tasks, date)  to authenticated, service_role;
grant  execute on function private.safe_date(text)                          to authenticated, service_role;
grant  execute on function private.word(text, text)                         to authenticated, service_role;
grant  execute on function private.day_label(date, text)                    to authenticated, service_role;
grant  execute on function private.short_date(date, text)                   to authenticated, service_role;
grant  execute on function private.time_label(time, text)                   to authenticated, service_role;
grant  execute on function private.task_item(public.tasks, date, text)      to authenticated, service_role;
grant  execute on function private.item_order(public.agenda_item)           to authenticated, service_role;
grant  execute on function private.person_items(uuid, date)                 to authenticated, service_role;
grant  execute on function private.names(uuid[])                            to authenticated, service_role;
grant  execute on function private.who_text(public.agenda_item, uuid, text) to authenticated, service_role;
grant  execute on function private.text_line(public.agenda_item, uuid, text) to authenticated, service_role;
grant  execute on function private.digest_item(public.agenda_item, uuid, text, boolean, text, text) to service_role;

commit;
