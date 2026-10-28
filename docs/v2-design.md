# Home Hub v2 — design (revised after critique)

This is the build contract for Home Hub v2. It replaces the first draft after four independent reviews (security, correctness, family experience, scope). Research facts referenced as H1…S3 come from the research brief (Hearth = Google-calendar-only; a Google service account cannot add attendees; Resend free = 100/day shared with sign-in codes; free Supabase projects pause after ~7 idle days).

## 0. What ships when

**PR A — foundation (no database change; safe to merge any time)**
- Tests move into the repo (`tests/`), with one runner (`tests/run.sh`).
- `assets/hub.js` becomes a small core plus modules, with **no behaviour change**: the existing pages move verbatim into `assets/modules/home.js`, `projects.js`, `contractors.js`, `family.js`.
- Schema guard: the core asks the database for `hub_schema_version()`; if it's missing (today's database) the site runs exactly as now ("v1 mode").

**PR B — v2 (merge any time; it switches on when the migration is applied)**
- Migration `supabase/migrations/0002_home_hub_v2.sql`, `supabase/preflight.sql`.
- New pages: Today, Calendar, Tasks, Directory (replaces Contractors), Family (replaces the old Family), Settings, and a public-by-token **My day** page (`day.html`) for helpers and kids.
- Projects: computed task dates (with a staleness guard), project owner, project tasks on the calendar.
- Edge Function `hub-jobs` (daily email digest, confirmation emails, preview, status) and `supabase/cron.sql`.
- Home-screen web-app manifest and icons. English/Spanish for messages and My day.

**v1.1 — Google Calendar and Hearth (after the owner passes two gates on a real calendar: service-account key downloads; insert/delete on a shared secondary calendar works)**
- One-way sync of hub items to one Google calendar per Hearth column, reading external Google events into the calendar and digests. Not built in PR B; PR B's data model leaves room for it (`calendars` table is added in v1.1).
- The build contract is `docs/v1.1-google-calendar.md`. Its database part is migration `0003_google_calendar.sql`, summarised in §8 below.

**v1.2 — Food: dinners and the shopping list (the site goes live first; then the migration)**
- A new Food page (`#/food`): this week's dinners, and one shared shopping list, which the helper can also use from her My day link (in Spanish, with no sign-in). Dinner also shows on Today, My day, the morning email, texts and the wall's Family column. No Edge Function change and no `cron.sql` change.
- The build contract is `docs/v1.2-kitchen.md`. Its database part is migration `0004_meals_and_shopping.sql`, summarised in §9 below.

Later: web push, Twilio SMS.

## 1. Item model — two kinds

| Kind | Plain-language test | Examples |
|---|---|---|
| **Event** | Happens at a time; nothing to tick off | Piano (every Tue 4pm, Taylor takes Jordan), school pickup, dentist, "Morgan away Thu–Sun" |
| **Task** | Needs doing; gets ticked off; may repeat | Heartworm pill on the 1st, furnace filter 60 days after last change, Jordan takes the trash out Mondays, call plumber |

The Add sheet starts with an Event | Task switch and the help line *"Piano, pickups, appointments → Event. Pills, filters, chores, calls → Task."*

## 2. People, sign-in and access

- `people` is the single household list. Roles: **parent**, **adult**, **kid**, **helper**.
- Sign-in is allowed only for parents and adults in v2. A parent who can sign in is an admin (`members.role = 'admin'`); an adult who can sign in is a member. Kids and helpers never get a login; they get a **My day link**.
- The client never writes `members` directly. `save_person(p jsonb, p_can_sign_in boolean)` (admin only, SECURITY DEFINER) upserts the person and adds/updates/removes the matching `members` row in one transaction. It refuses to remove or rename the caller's own login and refuses sign-in for kids/helpers. Taking someone's sign-in away also resets their `digest_scope` to `'mine'` and gives them a new My day link (they could copy the old one while signed in). `remove_person(p_person uuid)` takes someone off the list with their sign-in; their items stay, with nobody in charge.
- An email address is confirmed before any morning email goes to it: by the button on the page the confirmation email opens (`confirm_digest`, §3), or by signing in with a code sent to it (the core calls `mark_signed_in()` after every sign-in).
- The migration seeds one person per existing member (admin → parent; member → adult), one `household` row, and colours.
- Account numbers (`contractor_secrets`) are **admins only**. Revoked from `anon` and `service_role` too.
- Invariant: every policy is `private.is_member()`-gated (full members = everyone who can sign in in v2), except the anonymous token functions, which check the token: My day's `get_person_day`, `complete_by_token`, `undo_by_token` and `stop_digest`, the confirmation email's `confirm_digest`, and (v1.2, §9) the helper's shopping list, `get_list_by_token`, `add_to_list_by_token` and `buy_item_by_token`.

## 3. Database (migration 0002; schema.sql stays the v1 baseline)

Fresh install = `schema.sql` + `migrations/*.sql` in order. The migration is one transaction, starts with a guard that raises if `hub_schema_version()` already exists, and is **additive** (the v1 site keeps working on the v2 schema).

Rules for every object: RLS enabled on every table; every function `set search_path = ''` with qualified names; every new public function `revoke execute … from public, anon` then `grant … to authenticated` (or `service_role`/`anon` where stated); SECURITY DEFINER functions live in `private` unless they must be RPCs; definer RPCs check `private.is_member()`/`is_admin()`/token first. Audit columns are set by triggers (`created_by`, `updated_by`, `done_by` := `current_email()` whenever a JWT is present), never trusted from the client.

Clock: `private.now()` = `coalesce(nullif(current_setting('hub.now', true), '')::timestamptz, now())`; everything uses it (tests set `hub.now`). `public.clock()` → `(local_date date, local_time time, tz text)`; `public.today_local()`.

### Tables
```
household (one row; id boolean PK default true check (id))
  tz text not null default 'America/New_York' check (tz in US list: America/New_York, America/Chicago, America/Denver,
     America/Phoenix, America/Los_Angeles, America/Anchorage, Pacific/Honolulu)
  digest_time time not null default '06:30' check (digest_time <= '23:45')
  days_off date[] not null default '{}'          -- school holidays etc.
  pets_owner_id uuid → people (set null), house_owner_id uuid → people (set null)
  updated_at, updated_by
  RLS: members select; admins update.

people
  id uuid PK, name text not null (trimmed, non-empty), role text not null check in ('parent','adult','kid','helper'),
  email text unique null (lowercase, '%_@_%'), email_verified_at timestamptz null (cleared by trigger when email changes),
  phone text null, color text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  language text not null default 'en' check in ('en','es'),
  day_token text not null unique default encode(extensions.gen_random_bytes(16),'hex') check (32 hex characters),
  digest_enabled boolean not null default false,
  digest_time time null check (digest_time <= '23:45')   -- null = household default ('tomorrow' people: 19:00)
  digest_day text not null default 'today' check in ('today','tomorrow'),   -- 'tomorrow' = evening preview
  digest_scope text not null default 'mine' check in ('mine','everyone'), check (digest_scope = 'mine' or role = 'parent'),
  sort_order int not null default 0, active boolean not null default true, created_at, updated_at
  RLS: members select (all columns incl. day_token); no direct writes (save_person / remove_person / rotate_day_token RPCs, admin).

people_confirm (the confirmation email's secret; service_role select only, no policies, nothing for anon/authenticated)
  person_id uuid PK → people on delete cascade, token text not null unique default 32 hex characters, created_at
  Kept in step by an AFTER trigger on people (private.people_confirm_sync, definer): a new or changed email gets a new
  token (the old link stops working) and forgets that person's earlier 'confirm' notification_log rows; turning the
  morning email on makes sure there is one; no email, no row. Confirming keeps it (a second tap still says "confirmed").

members (existing): unchanged columns; rows are managed by save_person.

events
  id uuid PK, title text not null, notes text, location text,
  start_date date not null, end_date date null,      -- end_date only for all-day, non-repeating multi-day events
  start_time time null, end_time time null, ends_next_day boolean not null default false,
  responsible_id uuid → people (set null), participant_ids uuid[] not null default '{}',
  contractor_id uuid → contractors (set null), private boolean not null default false,
  repeat text not null default 'none' check in ('none','weekly'),
  repeat_every int not null default 1 check between 1 and 4,
  repeat_weekdays int[] not null default '{}' (values 1..7, ISO; weekly only; a trigger adds start_date's weekday if missing),
  repeat_until date null, skip_days_off boolean not null default false,
  created_by, updated_by, created_at, updated_at
  checks: end_date is null or (end_date >= start_date and start_time is null and repeat = 'none');
          end_time is null or start_time is not null; end_time is null or ends_next_day or end_time > start_time;
          repeat_until is null or repeat_until >= start_date; repeat = 'weekly' or cardinality(repeat_weekdays) = 0;
          responsible_id is null or not (responsible_id = any(participant_ids))
  RLS: members all.
event_changes (one-day changes to a repeating event; a null column means "as usual")
  event_id uuid → events on delete cascade, on_date date, cancelled boolean not null default false,
  start_time time, end_time time, responsible_id uuid → people (set null), participant_ids uuid[] null,
  nobody_in_charge boolean not null default false,   -- remove_person sets it on the days the removed person covered;
                                                     -- putting someone in responsible_id clears it (trigger)
  note text,                                         -- the day's own note ("Pick up at the side door"): unlike the
                                                     -- event's notes it reaches My day, day_text and the email
  PK (event_id, on_date). RLS: members all.

tasks
  id uuid PK, title text not null, notes text,
  category text not null default 'other' check in ('home','pets','vehicle','health','family','other'),
  responsible_id uuid → people (set null),
  due_date date null (null = inbox / no date), due_time time null (requires due_date),
  lead_days int not null default 0 check between 0 and 90,
  project_id uuid → projects on delete cascade, contractor_id uuid → contractors (set null), private boolean default false,
  repeat_mode text not null default 'none' check in ('none','schedule','after_done'),
  every_count int null check between 1 and 120, every_unit text null check in ('day','week','month','year'),
  repeat_weekdays int[] not null default '{}' (only schedule + week),
  anchor_date date null (the series counts from it; defaults to due_date — see "Re-anchoring" below),
  last_done date null, active boolean not null default true,
  done_at timestamptz null, done_by text null,        -- non-repeating only
  created_by, updated_by, created_at, updated_at
  checks: repeating ⇒ every_count, every_unit, due_date, anchor_date not null; non-repeating ⇒ those null/empty;
          due_time null or due_date not null; done_at only when repeat_mode = 'none'
  RLS: members all.
task_log
  id uuid PK, task_id → tasks on delete cascade,
  occurrence date (the due date the entry is for; after_done: the day it was done),
  status text check in ('done','skipped','missed'),
  done_on date, done_by text, note text, prev_due date, prev_last_done date, prev_done_at timestamptz, created_at,
  seq bigint generated always as identity            -- write order; "the task's latest entry" for undo
  RLS: members select; inserts only via functions (no insert policy).

contractors (existing — becomes the Directory)
  + kind text not null default 'contractor' check in ('contractor','account','service','emergency')
  + category text, + address text, + contract_end date, + updated_by text
  policies: members select/insert/update/delete. Changing or deleting an entry that has a secrets row is admin-only,
  enforced by a BEFORE UPDATE OR DELETE trigger, private.contractors_guard(), which raises 42501 with the reason in
  plain words ("Only an admin can change Example Water Co, because it has account details saved…"); a policy would
  quietly skip the row and the page (v1's too) would say "deleted" when nothing was. private.has_secrets(p_id) (definer)
  answers "does it have a secrets row?" for callers who can't read contractor_secrets.
contractor_secrets (admins only; revoked from anon and service_role)
  contractor_id uuid PK → contractors on delete cascade, account_number text, account_name text, secret_notes text,
  updated_at, updated_by

projects (existing)
  + task_dates jsonb null      -- null = stale; [{id,name,trade,trade_name,start,end,days,status,milestone}]
  + task_dates_at timestamptz null   -- when the client computed task_dates (the device clock); sent with every schedule write
  + on_calendar boolean not null default true
  + owner_id uuid → people (set null)
  BEFORE UPDATE trigger (private.projects_mark_dates_stale): if new.schedule is distinct from old.schedule and
  new.task_dates_at is not distinct from old.task_dates_at → new.task_dates := null (so a write from an old client, or
  one that forgot, marks the dates stale). The timestamp is the signal, not the dates: a schedule change that leaves
  every date where it was sends the same task_dates, and those are fresh.

notification_log
  id uuid PK, person_id uuid → people on delete cascade, local_date date, kind text check in ('digest','confirm'),
  channel text default 'email', status text check in ('sending','sent','failed','skipped'), attempts int default 1,
  claimed_at timestamptz, detail text, created_at; unique (person_id, local_date, kind, channel)
  RLS: admins select.
job_runs: id, action text, started_at, finished_at, ok boolean, sent int, detail text. RLS: admins select.
```

### Recurrence (one implementation, in SQL)
- Weekly events and weekly-with-weekdays tasks: occurrences are the dates `d >= start` with `isodow(d) ∈ weekdays` and `((monday(d) - monday(start)) / 7) % every = 0` (ISO weeks, Monday start). Never `generate_series` over months.
- Task series with unit day/week(no weekdays)/month/year: `anchor + make_interval(k * count units)` for integer k ≥ 0 — computed from the anchor, so Jan 31 monthly gives Feb 28, Mar 31, Apr 30; Feb 29 yearly gives Feb 28 in common years and Feb 29 in leap years.
- `private.series_after(t, p_after)` = first series date strictly after `p_after`; `private.series_on_or_before(t, p_on)` = the last one on or before `p_on`.
- **Re-anchoring.** A series counts from `anchor_date`. A person editing a repeating task's due date, mode, count, unit or weekdays restarts the series from the new due date (`anchor_date := due_date`, in the BEFORE trigger `private.tasks_defaults`), unless the same write sets `anchor_date` itself: "the 1st of every month" moved to the 5th means the 5th from now on. The hub's own moves (complete, skip, undo, the daily roll) keep the anchor — they set `hub.task_move = 'on'` around their update — so Jan 31 monthly still comes back to Mar 31 after Feb 28.
- **Where a missed task shows.** `private.current_due(t)`: a schedule-mode task whose next date has come undone is shown (agenda, late_items, My day, the email) on its latest date that has come, not on the first date it was missed, whether or not the roll has run yet; the roll, or ticking it off, then writes that move down.
- Event occurrences skip `household.days_off` when `skip_days_off`, and apply `event_changes` (cancelled days are returned with status `cancelled`; consumers hide them except the Calendar page, which shows them struck through).
- Timed occurrence instants: `start_at = (d + start_time) at time zone tz`; `end_at = (d + coalesce(end_time, start_time + 1h) [+ 1 day if ends_next_day]) at time zone tz`. Edge Functions and the client never compute offsets themselves.

### Task completion
- `complete_task(p_id uuid, p_occurrence date default null, p_done_on date default null, p_note text default null) returns uuid` (log id). Locks the row; refuses a paused task. A missed date the pages already show as moved on (`current_due`) is rolled for real first. Shares `private.complete_task(p_id, p_occurrence, p_done_on, p_note, p_who)` with `complete_by_token`; `done_by` is the signed-in email, or "<name> (My day)".
  - Non-repeating: raises `already done` if done_at is set; sets done_at/done_by; logs `done` with prev_done_at.
  - Repeating: raises `already completed` if `p_occurrence` is given and ≠ due_date (stale screen / double tap). `done_on` defaults to today_local(); must be ≤ today_local() and ≥ due_date − 1 year.
    - schedule: new due = `series_after(greatest(due_date, done_on))`; the log entry's occurrence is the due date.
    - after_done: new due = `done_on + count units`; the log entry's occurrence is `done_on` (done a day early, the next due date can be the very date it was due, and one day must not show it both done and to do).
    - last_done = done_on. Log `done` with prev_due, prev_last_done.
- `skip_task(p_id uuid, p_occurrence date default null)`: repeating only. schedule: `series_after(greatest(due_date, today_local()))`; after_done: `greatest(due_date, today_local()) + count units` (a skip never brings a task closer). Logs `skipped`.
- `undo_task(p_log_id uuid) returns uuid` (task id): only the task's latest log entry (by `seq`), created within 7 days; restores the prev values; deletes the entry. Shares `private.undo_task(p_log_id, p_person, p_who)` with `undo_by_token`.
- `roll_missed_tasks() returns int` (how many moved; service_role): hourly from cron.sql (`hub-roll-missed`) and at the start of each digest run. For active schedule-mode tasks whose next series date after due_date is ≤ today_local(), log `missed` and move due_date to the latest series date ≤ today_local() (`private.roll_task`). after_done tasks never roll; they stay late until done.

### Read model
`agenda(p_from date, p_to date)` — SECURITY INVOKER, range ≤ 62 days, authenticated (and service_role). Returns `public.agenda_item` rows (a composite type; `late_items()` and `heads_up(p_day)` return it too):
```
kind text ('event','task','project'; heads_up also 'contract'), item_id uuid, occurrence date, title text, day date, end_day date,
all_day boolean, start_at timestamptz, end_at timestamptz, local_start time, local_end time,
responsible_id uuid, participant_ids uuid[], status text ('open','done','cancelled','late','skipped'),
category text, project_id uuid, project_name text, contractor_id uuid, contractor_name text, contractor_phone text,
location text, notes text, private boolean, repeating boolean, changed boolean, lead_days int, milestone boolean,
day_note text   -- an event's note for this one day (event_changes.note), for whoever is on it
```
- events: every occurrence in range (multi-day: one row with day/end_day).
- tasks: open tasks whose due date (`current_due`) is in range (status open); non-repeating done tasks whose due_date is in range (done); task_log `done`/`skipped` rows whose occurrence is in range (done/skipped). No projections of future repeats.
- project tasks: for projects with on_calendar and non-null task_dates that are under way (not an idea, on hold or done), each task overlapping the range (day = start, end_day = end; status from raw task status; milestone flag); contractor from the trade's contractor_id.
`late_items()` — same shape: open tasks whose due date (`current_due`) is before today_local() (status late). `heads_up(p_day date)` — open tasks with `due_date - lead_days <= p_day < due_date`, plus directory `contract_end` within 30 days (kind 'contract').
`day_text(p_person uuid, p_day date) returns text` — the message for one person's day in their language (used by the Today page "Send their day" buttons and the digest; covered by SQL tests). Lines: timed events in order, all-day events, tasks due, then up to 3 late tasks ("+N more"). People are named by first name (`private.short_name`: the whole name only when another active person has the same first name): the person in charge's copy reads "Piano · with Jordan"; the copy for someone along reads "Piano · Taylor". Linked directory entries add their phone; a changed day's own note comes last. Never the event's or task's notes, never account numbers; private items read "Private item". (v1.2 adds the line of a meal the person is on, before the late tasks: §9.)

### Anonymous token functions (My day page; `grant execute to anon, authenticated`)
A secret is the only key: the person's My day token (`people.day_token`) for seven of them, the confirmation secret (`people_confirm.token`) for `confirm_digest`. These eight are the only new functions anon can call (v1's `get_shared_project` is the other one): 0002 adds the first five, and migration 0004 (v1.2, §9) the last three, for the helper's shopping list.
- `get_person_day(p_token text) returns jsonb` → `{person:{name, language, digest_enabled, email_confirmed}, today: date, days:[{day, items:[…]}], late:[…]}` for today and tomorrow; only that person's items (responsible or participant); item fields: kind, item_id, occurrence, day, end_day, title, all_day, start_time, end_time, time_label, location, contractor_name, contractor_phone, note (a changed day's own note), status, mine (a task they're in charge of). No notes, no other people's details; private items read "Private item". Returns null for an unknown token or inactive person. (v1.2 adds `meals` to a day that has any, and `list` for a helper; both are left out when empty: §9.)
- `complete_by_token(p_token text, p_task_id uuid, p_occurrence date) returns uuid` (log id, for Undo) → only tasks where that person is responsible; a repeating task needs `p_occurrence` (a page left open overnight can't tick off the next date); otherwise the same rules as complete_task. Logged as done by "<name> (My day)".
- `undo_by_token(p_token text, p_log_id uuid) returns uuid` (task id) → the toast's Undo on My day: only a `done` entry that person made on My day, on a task they're in charge of, that is still the task's latest entry, within 15 minutes.
- `confirm_digest(p_confirm text) returns boolean` → the button on the page the confirmation email opens (`day.html?c=<secret>#confirm`). The secret is the whole key: the link carries no My day token, so an email that goes to a mistyped address gives away nothing but the chance to confirm that address, and a My day link (which a kid, a helper or a WhatsApp group may have) confirms nothing. Sets email_verified_at. True also when the address was already confirmed (a second tap, or the email opened again later; the secret is kept); false for an unknown, malformed or replaced secret (the address changed since) or an inactive person.
- `stop_digest(p_token text) returns boolean` → digest_enabled = false.
- `get_list_by_token(p_token text) returns jsonb` (v1.2) → the shopping list on a helper's My day: `{language, as_of, can_add, items, bought, suggest}`, unlocked lines only, with no person's name or id. Null for anyone but a helper, and while `household.helper_list` is `'off'`.
- `add_to_list_by_token(p_token text, p_name text, p_key uuid default null) returns jsonb` (v1.2) → her add, while `helper_list` is `'add'`: `{result, item_id, name}` and her list. Only ever finds or makes an unlocked line; anything over 200 characters is refused before any work; counted (30 changes a day) and capped (150 things to buy). `p_key` is her phone's key for the add: a second try gets the first answer, changes nothing and isn't counted again (§9, `private.list_done`).
- `buy_item_by_token(p_token text, p_item uuid, p_bought boolean, p_seen timestamptz, p_key uuid default null) returns jsonb` (v1.2) → her tick, or the Undo of her own tick within 15 minutes: `{changed}` and her list. `p_seen` is the row's state as her phone saw it, so a tick that waited offline never buys a line put back since; a locked line's id answers as an unknown id (`false`); counted (100 ticks a day). `p_key` as for her add.
Tokens and secrets are 32 hex characters; `rotate_day_token(p_person uuid)` (admin) replaces a My day token, and the old link stops working at once.

### Jobs support (service_role only)
- `email_budget_left() returns int` = 60 − (email_log rows + notification_log rows with status in ('sending','sent') claimed) since 00:00 UTC, never below 0. (Resend free allows 100/day shared with sign-in codes; this leaves 40 for sign-in.)
- `digest_due(p_limit int default 50) returns table (person_id uuid, local_date date, kind text)` — who should get an email now, oldest first:
  - `digest`: active people with digest_enabled, an email and email_verified_at. Their send time today is `today + coalesce(people.digest_time, '19:00' when digest_day = 'tomorrow', household.digest_time)` in the household's zone: an evening ("tomorrow") email without a time of its own goes at **19:00**, not at the household's morning time. local_date is the day the email is about (today, or tomorrow for 'tomorrow' people).
  - `confirm`: active people with digest_enabled, an email that isn't confirmed, and a `people_confirm` secret. The first one goes at once; a reminder is offered 3 days after the last one, at their email time, until 3 have been sent (hub-jobs itself sends the email and one reminder, and marks any further one `skipped`). A new address starts afresh (people_confirm_sync forgets the old rows).
  - Only rows whose send time is ≤ now and within the last 3 hours, and never after midnight (a late run must not send yesterday's "Today" email; email times are 23:45 at the latest, the day's last quarter-hour run). Rows already sent, skipped, in flight or out of attempts are left out.
- `claim_notification(p_person uuid, p_local_date date, p_kind text) returns uuid` — insert … on conflict do update (retry when failed or stale 'sending' > 10 min, attempts < 3) returning id, else null.
- `finish_notification(p_id uuid, p_status text, p_detail text default null)` — p_status sent, failed or skipped; only a row still 'sending' changes.
- `digest_for(p_person uuid, p_local_date date) returns jsonb` — everything the email needs, computed in SQL (see §5): subject, today, late, heads_up, projects; for parents also people, nobody and, on Mondays, inbox_count; `empty` = a non-parent with nothing to say (send nothing). Null for an inactive person. (v1.2 wraps it to add the day's meals: §9.)

### Schema version, whoami and sign-in
`hub_schema_version()` returns 2 (authenticated); migration 0003 makes it 3 (§8), and migration 0004 makes it 4 (§9). `whoami()` gains `person` (id, name, role, language, color) when a person row matches the caller's email; existing keys unchanged. `mark_signed_in()` (authenticated; the core calls it after every sign-in): signing in with a code sent to an address proves it works, so the caller's own person row gets email_verified_at (the first time only). The confirmation secret stays, so the button in a confirmation email sent earlier says "confirmed" too. Does nothing for anyone who isn't a member.

## 4. Client

### Core and modules
- `assets/hub.js` = core: sign-in (then `mark_signed_in()`), shell, router, forms, api helpers, message helpers (sms/wa.me/mailto), toasts (with an Undo action; going to another page takes an Undo toast away, since its Undo was for the page left), caches (people, household, clock), schema version.
- Module contract: `HomeHub.register({ name, schema: { min, max }, nav: { label, order, primary }, match(parts) → params | null, render(main, ctx) })`, where `ctx = { seq, params, signal, stale() }`. The core aborts `signal` on navigation; modules add listeners with `{ signal }`.
- Script tags load in a fixed order without async; every `src` carries the same `?v=…`, bumped together on each release.
- Formatting uses the household time zone (`Intl.DateTimeFormat(…, { timeZone })`); "today" comes from `clock()`.

### Navigation
- Desktop: top tabs — Today · Calendar · Tasks · Projects · Directory · Family · Settings; on schema 4 (v1.2) Food comes after Tasks: Today · Calendar · Tasks · Food · Projects · Directory · Family · Settings.
- Phones (< 640px): bottom bar — Today · Calendar · ＋ · Tasks · More (More: Projects, Directory, Family, Settings, Sign out); on schema 4 Food gets a button of its own: Today · Calendar · ＋ · Tasks · Food · More. ＋ opens the Add sheet: Event | Task, and on schema 4 also Shopping ("Something to buy", the Food page's one-field add, `use('food').openListAdd`).
- v1 mode (no migration yet): exactly today's tabs and pages.

### Pages
- **Today**: person chips (Me · each person · Everyone; default Me); that person's day (events in time order, then tasks due, checkboxes on tasks); Late (≤ 3 + "N more"); Heads-up; "Nobody's on it" (parents); "Send <name> their day" (WhatsApp / Text) for kids and helpers with a phone, using `day_text`; one line per active project; first-run checklist until done (add people → turn on morning email → add the weekly routine → directory from bills → starter tasks).
- **Calendar**: week agenda (default on phones) and month grid; person filter chips; colours by person; tap → details with Edit, and for repeating events "Change this day" / "Skip this day" / edit "This day · All"; ＋ Event.
- **Tasks**: filters Me / Everyone / person / Repeating / Project; groups Late · Today · Coming up · No date · Done (14 days); one-tap checkbox = done today with "Done · Undo" toast; menu: done on another day, skip, edit, delete; Repeating view grouped Home/Pets/Car/Health with "Add from starter list" (staggered first due dates, ≤ 2 per day over 4 weeks; owner defaults from household pets/house owner).
- **Add / edit forms**: What · When (Today / Tomorrow / date; time or All day) · Who (people chips: first tap = in charge (ring), more taps = with) · Repeats (presets from the date: Every <weekday>, Every weekday, Every day, Custom…; tasks also "Monthly on the Nth", "Every N months/days after done"). "More" reveals end time / end date, place, directory contact, notes, private, until.
  - Task repeat wording: "On set dates (e.g. the 1st of every month)" vs "A while after it's done (e.g. 60 days after the last change)" with "When was it last done?" / "Next one is due".
- **Directory**: kind filter (All · Contractors · Accounts & utilities · Services · Emergency), search, cards with tap-to-call/text/WhatsApp/email/website, contract end; account number masked with Show (admins only; loaded separately).
- **Family**: one list of people; add/edit person (name, role, email, phone, colour, language, morning email on/off, time, today/tomorrow, everyone (parents), can sign in (parents/adults)); "unconfirmed" badge until the email is confirmed (by the confirmation email's button, or by signing in); My day link: Copy / Send by WhatsApp / Text / New link.
- **Settings**: time zone, default morning-email time, days off, default owners for pets/house, digest status ("Last run 6:30 · 4 sent", failures), the Google Calendar & Hearth card (v1.1, §8). On schema 4 a dinner in the card's preview has no **Make private**, and a hint says to lock it on the Food page instead.
- **Food** (v1.2, schema 4; `#/food`, and `#/food/<YYYY-MM-DD>` for that day's dinner; heading "Food", "Dinners and the shopping list"): §9 has the database, `docs/v1.2-kitchen.md` §6.1 every rule.
  - **This week's dinners**: one row of 7 cards, today first ("Today · Tacos · Sam", "Wed · —"). A card opens the dinner dialog: a name, with the family's 8 most frequent dinners of the last 180 days as suggestions, or one tap on Leftovers · Eating out · Takeout · Fend for yourself; **Who cooks?** (for Leftovers and Takeout **Who's on dinner?**; optional); under More a note and a recipe link (both only for the cook) and **Keep the title private**; Save, **Clear this day**, and on a saved dinner **Add a prep reminder…** (the task form, due the day before, never before today; a private task when the dinner is locked). A family that planned no dinner in the last 14 days and none for the next 7 sees one line instead, "Plan dinners ›".
  - **The shopping list**: an add box (Enter adds and keeps the focus; "2 milk" or "Milk: 2 gallons" put the amount in the note; a lock makes the next add private; suggestions from the household's own items); **To buy**, grouped in ten aisles in store order, cold things last (a guess from a built-in English and Spanish word list; the **Aisle?** chip or Edit corrects it, and the item keeps it); a tap marks a line bought, struck through where it is, with "Bought · Undo", and it moves to **Just bought** (everything bought since midnight) 3 seconds after the last tap; **Buy again** (folded: bought in the last 60 days, one tap puts it back); **⋯** Edit (aisle, name, note, lock) and **Forget**; **Send Taylor the list** (her My day link with `#list`); and the parents' two switches, the list on helpers' My day (Off · See and tick · See, tick and add) and dinners on the kitchen wall.
  - The list is read again every 10 seconds while it is on screen (`shopping_list()`), with nothing redrawn when nothing changed and no row moving under a finger. Every change goes through the outbox in `assets/shoplist.js` (shared with My day): it shows at once, is saved on the phone for whoever is signed in (`homehub.shop.hub`, removed at sign-out), and waits, marked "Not sent yet", until there is signal.
- **Today** (v1.2, schema 4): one line under the person chips, "Dinner: Tacos · Sam cooks ›" (to the Food page); with no dinner today, a quiet "What's for dinner? ›" only when one was planned in the last 14 days. On schema 3 it asks for nothing.
- **Projects**: unchanged plus: dates recomputed on every schedule write in one choke point (`api.updateProject`/`createProject`), which sends `task_dates` with a new `task_dates_at` (the device clock), and backfilled when stale; project owner; "Show in Home Hub calendar"; a Tasks card listing the project's tasks with "Put on the schedule" (turns a task into a 1-day Gantt task with a trade picker, then deletes the task).
- **My day** (`day.html?t=<day_token>`): no sign-in; today and tomorrow for that person; check off own tasks (Undo for a few seconds, `undo_by_token`); in their language; stop the morning email with a button (`#stop`); "Add to Home Screen" hint. The confirmation email opens `day.html?c=<secret>#confirm` (no `t=`): that page shows only the confirm screen, whose button calls `confirm_digest(p_confirm)`. Opening a link never changes anything; only the buttons do (they're POSTs).
  - v1.2: each day ends with its meals ("Cena · Tacos · Cocina Sam"; the note and a **Receta** link only for the person on it). A helper, while the parents allow it, gets a **Lista de compras · 7 ›** button that opens `#list`: the unlocked lines in big rows by aisle (headings in her language), tick, the 15-minute Undo of her own tick, and (with See, tick and add) an add box and **Comprar otra vez**. It is read every 10 seconds while on screen, saved on the phone (under a hash of the link, never the link), shown from there when there is no connection, and her changes wait in the same outbox as the Food page's. Kids get the meals and no list.
- `day.html` is a second public page: it loads `config.js`, supabase-js, `assets/shoplist.js` (v1.2) and `assets/day.js` (not the hub), shares `assets/styles.css` (plus `assets/css/day.css`), and carries the same `?v=` as `index.html`.

## 5. Morning email (`hub-jobs`)

One Edge Function, `hub-jobs` (verify_jwt off; each action authorizes itself; `send-email` untouched):
- `digest` — header `x-hub-cron: <HUB_CRON_SECRET>` (constant-time compare; missing/short secret → 503). Writes a `job_runs` row first. Without `SITE_URL` (the links), or `RESEND_API_KEY` and `EMAIL_FROM`, the run stops with `stop: 'config'` (500, nothing sent). Otherwise calls `roll_missed_tasks()`, then `digest_due()`; for each: budget check, `claim_notification`, `digest_for` (or the confirmation email), render, send with Resend (`Idempotency-Key: <kind>-<person>-<date>`, plus a fingerprint of the confirmation secret for a confirmation email), `finish_notification`. Pings `HEALTHCHECK_URL` (if set) after a run that sent everything due, and `HEALTHCHECK_URL/fail` after one that didn't. Ignores the request body. pg_cron calls it every 15 minutes (cron.sql).
- `preview` (admin via whoami with the caller's JWT) — returns rendered digests for a date without sending or logging.
- `status` (admin) — last runs and today's notification rows (counts and fixed messages only).

`digest_for` layout (JSON → HTML and plain text, every dynamic string escaped; no autolinking; only hub-generated links):
- Subject carries content: "Tue Oct 27: 8:00 Drop off dogs · 3:00 Pick up Jordan · +2".
- **Today**: timed items in order, then tasks due (late ones marked). **Late**: ≤ 3 + "and N more". **Heads-up**: lead-time tasks, contract ends ≤ 30 days, tomorrow before 9am.
- Parents also get: a compact block per kid/helper with their day and WhatsApp/Text buttons (`day_text`), **Nobody's on it** (unassigned items), one line per project with items today ("Kitchen: tile starts (Gomez Tile 555-0120)"), and on Mondays "Inbox: N tasks with no date".
- Non-parents with nothing today get no email. Links never change state: someone who can sign in gets links to the hub (Today; Family or Settings to stop the emails); kids and helpers get their My day page (`day.html?t=…`, and `#stop` there to stop).
- People are named by first name ("Piano · with Jordan"), as in `day_text`.
- `digest_day = 'tomorrow'` sends the next day's plan in the evening: at the person's own time, else 19:00.
- The **confirmation email** (`kind = 'confirm'`) goes when the morning email is turned on for an unconfirmed address, with one reminder 3 days later (`CONFIRM_MAX` in the handler). Its button opens `day.html?c=<secret>#confirm` — the `people_confirm` secret only, never the My day token — where a tap on "Yes" calls `confirm_digest`.
- Spanish strings from a small dictionary for people with language 'es'.

## 6. Tests (committed under `tests/`, fictional data only)
- `tests/run.sh`: starts a throwaway Postgres, loads Supabase stand-ins (anon, authenticated, service_role with BYPASSRLS, `auth.jwt()`, **Supabase's default grants to anon/authenticated/service_role**), `schema.sql`, then `migrations/*`, and runs:
  - `tests/db/*.sql` — RLS role matrix (anon; signed-in non-member; removed member with a parent person row; adult member; admin), every public table has RLS, no public function executable by anon except the token functions and `get_shared_project`, recurrence vectors, DST days (2026-11-01, 2027-03-14) via `hub.now`, task completion/undo/skip/roll, digest selection and claims, day_text, token functions.
  - `tests/contract/check.sh` — every `.from('t')`/`.rpc('f', {args})` in the client and the Edge Functions exists in the migrated schema with those parameter names, and the caller (anon, authenticated, service_role) may use it.
  - `tests/fn/*.test.ts` (Node, type stripping) — hub-jobs and send-email handlers with injected deps and clocks; `cron.sql` against stand-ins for pg_cron, pg_net and Vault.
  - `tests/e2e/*.test.js` (Playwright, mocked Supabase) — v1 mode unchanged; each v2 page; My day.
  - `tests/realdb/run.sh` (Playwright against the real database through a PostgREST/Auth stand-in) — the family's key flows and the morning email on the real schema, RLS and functions; the v1 site (b980d4c) and PR A (bcf296a) on the v2 database; the new site on the v1 database.
  - `tests/docs/*.test.js` — the docs against the code: deploy secrets, test suites, `?v=`, and this document's tables, columns and function signatures.
- `CLAUDE.md`: run `tests/run.sh` before every PR; deploy order; never put real names, numbers or IDs in fixtures.

## 7. Deploy order (needs Supabase access)
0. Move the project into the paid organization (owner); confirm the URL and project ref are unchanged.
1. `preflight.sql` (read-only checks) and `list_migrations`.
2. Merge PR A, then PR B (site stays in v1 mode until step 3).
3. Apply migration 0002 (site switches to v2 on next load).
4. Deploy `hub-jobs` from main with verify_jwt false (`supabase/config.toml` pins it for the CLI; the dashboard and the MCP's `deploy_edge_function` need it turned off by hand). Secrets: `HUB_CRON_SECRET` (≥ 32 chars), `SITE_URL` (required: the site's address, for the links in the emails; without it every run stops with `stop: 'config'` and Preview answers 503), `RESEND_API_KEY` and `EMAIL_FROM` (required) and `EMAIL_FROM_NAME`, shared with `send-email`; and `HEALTHCHECK_URL`, which is optional. For v1.1, `GOOGLE_SA_JSON` (optional: the Google service-account key; without it the calendar job stops with `not_set_up` and the morning email is unchanged).
5. Create the two Vault secrets by hand (`hub_cron_secret`, the same value as `HUB_CRON_SECRET`, and `hub_jobs_url`, the function's address), then run `cron.sql` (enables pg_cron/pg_net; refuses a missing or placeholder secret; idempotent). Run `cron.sql` again after a release that changes it: v1.1 adds the `hub-calendar` job.
6. Smoke checks: no header → 401; preview → rendered JSON; Settings shows the last run; next morning `notification_log` has sent rows.
7. Ops hardening: Auth email rate limit ≈ 6/hour; the signup hook stays on; Resend click/open tracking off.

## 8. v1.1: Google Calendar

The build contract is `docs/v1.1-google-calendar.md`; this section lists what its migration, `supabase/migrations/0003_google_calendar.sql`, adds to the database, so the docs check can hold the two together. Fresh install = `schema.sql`, then `0002`, then `0003`. It is one transaction and additive, and every rule in §3 applies. It opens with two guards: without `hub_schema_version()` it raises "Home Hub v2 (migration 0002) isn't installed"; unless that returns 2 it raises "Google Calendar (migration 0003) is already installed". It ends by making `hub_schema_version()` return 3. `preflight.sql` stays a 0002-only check. No new SECURITY DEFINER function, and nothing new for anon.

### Tables
```
calendars (which Google calendar is whose; one writing calendar per Hearth column, plus calendars the hub only reads)
  id uuid PK, google_id text not null unique (Google's Calendar ID; trimmed and lowercased by trigger;
  check '^[a-z0-9._+#-]{1,200}@[a-z0-9.-]+\.[a-z]{2,}$'), kind text check in ('person','pets','house','family'),
  person_id uuid → people (cascade; kind 'person' only), label text (trimmed, 1–40 characters),
  writes boolean default true, for_kids boolean default false ("Show to kids"), copy_approved_at timestamptz ("Start copying")
  -- written by hub-jobs: google_name, access_role, status ('new','ok','no_access','error'), status_detail (≤ 300),
  -- checked_at, read_at (the last complete read)
  created_at, updated_at, updated_by
  checks: (kind = 'person') = (person_id is not null); a writing calendar is '…@group.calendar.google.com';
          for_kids only on a read-only Family row. Unique index calendars_one_writer: one writing calendar per column.
  Triggers calendars_stamp (private.stamp()) and calendars_tidy (private.calendars_tidy()).
  RLS: members select; admins insert, update, delete. Column grants: authenticated inserts google_id, kind, person_id,
  label, writes, for_kids, and updates those and copy_approved_at; nothing else.
calendar_links (what hub-jobs wrote to Google: one row per Google event; kept after the event is past)
  google_calendar text, base_id text ('^hh[0-9a-f]{32}$'), event_id text (base_id, or a new one after a clash), gen int,
  calendar_id uuid → calendars (set null), item_kind ('event','task','project','late'; 0004 adds 'meal', §9), item_id uuid, job_id text,
  occurrence date, part ('','start','finish'), day date, end_day date, title text, hash, tried_hash, google_hash,
  google_updated, repairs int, repaired_at, repair_kind ('edited','deleted'), status ('pending','ok','error'),
  attempts int, next_try_at, failing_since, error, synced_at, created_at
  PK (google_calendar, base_id); unique (google_calendar, event_id). RLS: admins select; no write policies.
google_events (events read from Google that the hub didn't write; a complete read replaces a calendar's rows)
  calendar_id uuid → calendars (cascade), google_calendar text (the Google ID it was read from), event_id text,
  title text ('' for a private one), location text, all_day boolean, start_day date, end_day date, start_at, end_at,
  private boolean, repeating boolean, google_updated, read_at
  PK (calendar_id, event_id). RLS: members select; no write policies.
calendar_sync (one row: the calendar job's state)
  id boolean PK, auth ('service_account','oauth'), account, key_id, running_since, run_id uuid (the lease),
  last_run_at, last_ok_at, last_stop, last_error, last_result jsonb, window_from date, window_to date,
  paused_until, pause_step int
  RLS: members select; no write policies. The migration inserts the row.
```
Anon has no privilege on the four tables. Signed-in users have select on all four (row-level security decides), delete on `calendars` and the column grants above; no insert, update, delete, truncate, references or trigger on the other three. hub-jobs (service_role) writes them.

### Functions
Pages (`authenticated`, `service_role`):
- `google_items(p_from date, p_to date)` returns `setof public.agenda_item`: Google events as agenda rows of kind `'google'` (a fifth kind beside 'event', 'task', 'project' and 'contract'), with `item_id = md5(calendar_id || '/' || event_id)`, the calendar's person (or the household's pets or house owner) as `responsible_id`, and the source in `notes`. Range 1 to 62 days, like `agenda(p_from, p_to)`.
- `calendar_preview(p_calendar uuid)` returns table `(day, title, private, item_kind, item_id, place, details)`: everything Start copying puts on one calendar (the job's window, yesterday to 60 days ahead), as the wall will show it, with each event's place and the rest of its description on one line. Admins only.

The calendar job (`service_role` only):
- `calendar_begin()` returns jsonb `{go, stop, run_id}`: takes the lease (`stop` is 'busy' or 'paused' when `go` is false).
- `calendar_signed_in(p_run uuid, p_auth text, p_account text, p_key_id text)`: how this run signed in to Google.
- `calendar_read_due(p_force boolean default false, p_limit int default 10)` returns table `(calendar_id, google_id, writes, w_from, w_to, time_min, time_max, tz)`: the calendars to read now (never-read ones first, then the one Google answered about longest ago).
- `calendar_store_events(p_calendar uuid, p_google_id text, p_from date, p_to date, p_name text, p_access text, p_complete boolean, p_events jsonb, p_seen jsonb)` returns jsonb `{kept, skipped, seen, repaired, adopted}`: stores one calendar's read, sets its status from its Google name and access role, puts back changes made in Google to the hub's events (on an approved calendar, for events the plan will write again), and adopts the hub's events that have no link.
- `calendar_mark(p_calendar uuid, p_google_id text, p_status text, p_detail text default null, p_name text default null, p_access text default null)`: what a failed read, a write's 403 or Test found.
- `calendar_plan(p_site text default null, p_limit int default 60)` returns table `(op, calendar_id, google_calendar, base_id, event_id, gen, item_kind, item_id, job_id, occurrence, part, day, end_day, title, body, hash, pending, hiding)`: the next Google writes, privacy first and the past's history last; read only. Hiding what the hub wrote (an item made private, a delete) goes ahead on a calendar in error the hub can still write to. (Migration 0004 replaces it so a past dinner stays on Google: §9.)
- `calendar_record(p_results jsonb)`: what Google answered for a batch of plan rows.
- `calendar_finish(p_run uuid, p_result jsonb, p_stop text default null, p_error text default null)`: ends a run, and cleans up: cached events no read has refreshed for 24 hours, and failed inserts and updates whose item has gone past (Google keeps its copy as history).

Replaced, with the same signatures:
- `hub_schema_version()` returns 3.
- `private.item_order(a)` and `private.text_line(a, p_person, p_lang)`: a Google event sorts and reads like an event ("All day: …").
- `private.digest_item(a, p_person, p_lang, p_hide, p_time, p_detail)`: the same, and a private Google event is "Private item" for everyone.
- `private.person_items(p_person, p_day)`: adds the Google events `private.google_for` gives that person (so My day, `day_text` and the email's blocks for kids and helpers have them).
- `digest_for(p_person, p_local_date)`: Google events in Today and in the heads-up's "tomorrow before 9am"; never in "Nobody's on it"; and a new key, `calendar` (parents only, when any calendar is set up, else null): `{warning, items_failed, put_back}`. (Migration 0004 keeps this body as `private.digest_for_v3` and wraps it: §9.)

New in private:
- `private.calendar_desired(p_from, p_to, p_site)`: the events Google should have (routing, titles, bodies, ids, hashes). Granted to authenticated for the preview, and to service_role. (Migration 0004 keeps this body as `private.calendar_desired_v3` and wraps it: §9.)
- `private.calendar_key(p_kind, p_item, p_job, p_occurrence, p_google, p_part)` and `private.calendar_event_id(p_key)`: an event's key and its id, `'hh' || md5(key)`.
- `private.calendar_word(p_key, p_lang)`: the calendar's fixed words in English and Spanish, falling back to `private.word(p_key, p_lang)` (which is unchanged).
- `private.calendar_status(p_writes, p_name, p_access)`: a calendar's status from its Google name and access role (`out status, out detail`; `writerWithoutPrivateAccess` reads a read-only calendar, and is refused on one the hub writes).
- `private.clean_text(p_text, p_max)`: text from Google on one line, without control, bidi or zero-width characters. Granted to service_role (and, from 0004, to authenticated: §9).
- `private.google_item(g, c)`, `private.google_for(p_person, p_from, p_to, p_grown_up)`: one cached Google event as an agenda row; the ones that reach one person's day.
- `private.calendars_tidy()`: the trigger above.
- `private.active_person(p_id)` and `private.active_only(a)` are now granted to authenticated too (`calendar_desired` uses them).

## 9. v1.2: Meals and shopping

The build contract is `docs/v1.2-kitchen.md`; this section lists what its migration, `supabase/migrations/0004_meals_and_shopping.sql`, adds to the database, so the docs check can hold the two together. Fresh install = `schema.sql`, then `0002`, `0003` and `0004`. It is one transaction and additive (the v2 pages work the same on 3 and 4), every rule in §3 applies, and it seeds no rows in `public` (only `private.food_pairs`, below, is filled from the word list): with no meals and no list, the email, the texts, My day and every event on the wall come out byte for byte as on 3 (checks 5b and 5c in `tests/db/run.sh`). It opens with guards, each of which changes nothing: without `hub_schema_version()` it raises "Home Hub v2 (migration 0002) isn't installed"; below 3, "Google Calendar (migration 0003) isn't installed"; at 4 or more, "Meals and shopping (migration 0004) is already installed"; with `meals` there but the version set back to 3 (`docs/v1.2-kitchen.md` §15), "… set back to 3"; and unless `digest_for`, `private.calendar_desired` and `calendar_links_item_kind_check` are as 0003 left them, "This database isn't as migration 0003 left it". It ends by making `hub_schema_version()` return 4. No Edge Function change and no `cron.sql` change, so the site goes live first, then the owner applies 0004 (`docs/v1.2-kitchen.md` §15). Three new functions for anon, the helper's shopping list (§3 "Anonymous token functions"); a locked line never appears in, is matched by, or is changed by any of them.

### Tables
```sql
-- One row per planned meal. v1.2's pages plan dinner only; everything in SQL handles any slot, ordered
-- breakfast, lunch, dinner with array_position (never order by slot, which is alphabetical).
create table public.meals (
  id         uuid primary key default gen_random_uuid(),
  day        date not null,                     -- the household's day
  slot       text not null default 'dinner' check (slot in ('breakfast', 'lunch', 'dinner')),
  kind       text not null default 'cook' check (kind in ('cook', 'leftovers', 'out', 'takeout', 'fend')),
  title      text check (title is null or char_length(title) between 1 and 80),   -- "Tacos", as typed; null for the quick kinds
  cook_id    uuid references public.people (id) on delete set null,
             -- who cooks (who's on dinner, for leftovers and takeout); optional; an inactive person counts as nobody
  note       text check (note is null or char_length(note) between 1 and 300),   -- for the cook
  link       text check (link is null or (link ~ '^https://[!#-;=?-~]{4,}$' and char_length(link) <= 508)),
             -- a recipe page: https only, printable ASCII only (no spaces, quotes, < >, control, bidi or zero-width
             -- characters), 4 to 500 characters after "https://"; the page saves new URL(typed).href
  private    boolean not null default false,
             -- locked: the title stays off the wall, other people's My day and every email subject
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (day, slot),                           -- the page upserts on (day, slot)
  check ((kind = 'cook') = (title is not null)),
  check (kind = 'cook' or link is null),
  check (kind not in ('out', 'fend') or cook_id is null)
);

-- The shopping list: one row per thing the household buys (and per lock), kept after it is bought. That
-- row is the item's history, the suggestions as you type, and the guard against duplicates.
create table public.shopping_items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 60),       -- as first typed, cleaned
  name_key   text generated always as (lower(name)) stored,                   -- "Milk" and "milk " are one item
  note       text check (note is null or char_length(note) between 1 and 80),  -- "2", "big pack", "2 gallons", "2 lb"
  aisle      text not null default 'other'
             check (aisle in ('produce', 'bakery', 'pantry', 'drinks', 'household', 'personal', 'meat', 'dairy', 'frozen', 'other')),
  private    boolean not null default false,
             -- locked: never read, matched or changed through a My day link; every member still sees it
  added_at   timestamptz not null default now(),   -- the last time it was put on the list (an Undo too)
  added_by   uuid references public.people (id) on delete set null,   -- who put it on the list last
  bought_at  timestamptz,                          -- null: to buy
  bought_by  uuid references public.people (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by text,                                 -- "<name> (My day)" for My day's writes
  check (bought_at is not null or bought_by is null)
);

-- What each My day link did to the list today: one row per helper per day she uses the list.
create table public.my_day_use (
  person_id uuid not null references public.people (id) on delete cascade,
  day       date not null,                        -- the household's day (public.today_local())
  changes   int not null default 0,               -- add calls that changed the list
  ticks     int not null default 0,               -- tick and Undo calls that changed a row
  primary key (person_id, day)
);

-- food_other's half of the word list (private.food_words()), worked out once by the migration, so that
-- food_other is a lookup: one row per pair with both words, each way, normalized as guess_aisle does.
create table private.food_pairs (
  side       text not null check (side in ('en', 'es')),   -- the language of give
  en         text not null,                                -- the pair's English word, as food_words has it (the tiebreak)
  word       text not null,                                -- the word to find, normalized
  forms      text[] not null,                              -- word, and word less a trailing "s" or "es"
  give       text not null,                                -- the word in side, as food_words has it
  give_forms text[] not null,                              -- give normalized, and less a trailing "s" or "es"
  primary key (side, en)
);

-- Each change a phone sent to the list, by its key, with its first answer: a second try gets that answer.
create table private.list_done (
  key    uuid primary key,                    -- the phone's key for the change
  by_id  uuid,                                -- who sent it (p_by): a person, or null for a member with no person
  my_day boolean not null,                    -- sent from a My day link
  ask    text not null,                       -- what was asked: the change and its arguments
  answer jsonb,                               -- the first answer: {result, item_id, name}, or the tick's true or false
  at     timestamptz not null                 -- private.now() when it was done
);

-- Two switches for parents.
alter table public.household
  add column meals_on_wall boolean not null default true,   -- meals on Hub – Family
  add column helper_list   text not null default 'add'
                           check (helper_list in ('off', 'see', 'add'));
                           -- the list on helpers' My day: off, see and tick, or also add

-- The wall's links can be meals': dropped and added again, by the same name, with 'meal' among the kinds.
alter table public.calendar_links drop constraint calendar_links_item_kind_check;
alter table public.calendar_links add constraint calendar_links_item_kind_check
  check (item_kind in ('event', 'task', 'project', 'late', 'meal'));
```
- `meals`: index `meals_cook` on `(cook_id)` where it is set. Triggers `meals_stamp` (`private.stamp()`) and `meals_tidy` (`private.meals_tidy()`: the title and note through `private.clean_text`, one line, no control, bidi or zero-width characters, at most 80 and 300 characters, `''` becomes null); same-event triggers fire in name order, so the stamp runs first. RLS: members all (`private.is_member()`), as events.
- `shopping_items`: the unique index `shopping_items_name_key` on `(name_key, private)`, so a locked and an unlocked line with the same name are two lines and nothing a My day link types can land on the locked one (a plain index, so `on conflict (name_key, private)` needs no predicate; `name_key` is computed after the BEFORE triggers, from the cleaned name), and `shopping_items_bought` on `(bought_at desc)` where it is set. Triggers `shopping_items_stamp` (`private.stamp()`) and `shopping_items_tidy` (`private.shopping_items_tidy()`: the name and note the same way, at most 60 and 80 characters, `''` note becomes null). RLS: members select, update and delete; no insert policy: adds go through `add_to_list` and `add_to_list_by_token`.
- `my_day_use`: RLS on, no policies and no grants (not even to service_role): only `private.count_my_day` (a definer function) writes it, and nothing else reads it. A table rather than a count of rows, because a call can change a row without changing who added or bought it (a note appended, a tick undone), and two parallel calls would each see the old count.
- `food_pairs`: RLS on, no policies and no privileges (`revoke all … from public, anon, authenticated, service_role`): only `private.food_other` (a definer function) reads it. The migration fills it from `private.food_words()` (about 300 rows); a later migration that changes `food_words` fills it again in the same transaction. It exists because `food_other` runs once per line in every poll of the list: working the ~300 pairs out on each call cost about 3.5 ms, about 1 s a poll at the 200-line cap. `food.test.sql` holds the lookup to that old version for every word.
- `list_done`: indexes `list_done_at` on `(at)` and `list_done_by` on `(by_id, at)`. RLS on, no policies and no privileges (`revoke all … from public, anon, authenticated, service_role`): only `private.list_claim`, under the list's definer functions, reads and writes it. The outbox gives every change a key (a random uuid) and sends it with every try (`p_key` on `add_to_list`, `buy_item` and the two token writers): the first try that arrives does the change and keeps its answer, and a later one (its answer lost, or sent again by a reloaded page) gets that answer and changes nothing, so a resent add never brings back a line bought in between. A key someone else sends, from the other side (My day or signed in), or with another change counts as no key. Kept 2 days (a phone drops a change after 24 hours) and a sender's latest 200, trimmed at each new key, so a My day link can't make it grow without end.
- `household`'s two columns follow its policies: members read, admins update.
- Grants: Supabase's default privileges would give anon and authenticated everything on a new table, so all three start from `revoke all … from public, anon, authenticated` (and `my_day_use` from service_role). Signed-in users then get select and delete on `meals` and insert and update of its own columns (`day, slot, kind, title, cook_id, note, link, private`, never the audit columns), and select, delete and update of `name, note, aisle, private` on `shopping_items` (never `added_*` or `bought_*`). Anon has no privilege on the three. service_role keeps the defaults on `meals` and `shopping_items`: `digest_for` and the calendar job read them as it.

### Functions
Pages (`authenticated`, `service_role`; SECURITY INVOKER, so row-level security decides and a non-member gets empty lists):
- `shopping_list()` returns jsonb `{as_of, to_buy: [{id, name, note, aisle, private, added_by, seen, other}], bought: [{id, name, note, aisle, private, bought_by, seen}]}`: what is to buy (A–Z by `name_key`, then id) and everything bought since the household's midnight, plus the caller's own ticks of the last 15 minutes, as `list_for_helper` keeps hers (`bought_at desc, name_key, id`). `as_of` is the household's local date and time; `added_by` and `bought_by` are person ids; `seen` is the row's state as the phone saw it (`added_at` to buy, `bought_at` bought, as `to_jsonb` writes a `timestamptz`), which the page sends back as `p_seen`; `other` is the name in the reader's language when the word list knows it in the other one ("Leche" carries `other: 'milk'` for Alex), left out when there is none. The Food page reads it every 10 seconds while the list is on screen; Buy again comes from the page's own read of the table, so this answer stays small.

Signed-in actions (`authenticated` only; SECURITY DEFINER, in `public` because the page calls them; each raises 42501 "Only the family can change the shopping list." unless `private.is_member()`, and reads its snapshot in a statement after the write):
- `add_to_list(p_name text, p_private boolean default false, p_key uuid default null)` returns jsonb `{result, item_id, name}` and the list: `private.list_add`'s rule, for the caller, once per key (`private.list_add_once`). `result` is `'added'` (a new line), `'already'` (it was to buy: still one line, and a new note joins the old with " · ") or `'back'` (it was bought: back on the list, its aisle kept); `name` is the line's own name ("Milk" when "Leche" joined it).
- `buy_item(p_item uuid, p_bought boolean, p_seen timestamptz, p_key uuid default null)` returns jsonb `{changed}` and the list: `private.list_buy`'s rule, for the caller, once per key (`private.list_buy_once`). `p_seen` is required: a buy changes only a line to buy whose `added_at` is `p_seen`, and a put-back only a bought line whose `bought_at` is `p_seen`, so a resend changes nothing and a change that waited offline never undoes a newer one; with `p_key`, a resend gets the first try's answer (`true` when it was done).

My day (`anon`, `authenticated`; SECURITY DEFINER): `get_list_by_token(p_token text)`, `add_to_list_by_token(p_token text, p_name text, p_key uuid default null)` and `buy_item_by_token(p_token text, p_item uuid, p_bought boolean, p_seen timestamptz, p_key uuid default null)`, in §3 "Anonymous token functions". An unknown token, an inactive person or no token gets null; a kid, a grown-up's link or the switch Off gets 42501 from the two writers ("The shopping list isn't on your My day."), and See and tick gets 42501 from the add ("You can't add to the list from My day.").

Replaced, with the same signatures (`create or replace`, so they keep their grants):
- `hub_schema_version()` returns 4.
- `get_person_day(p_token text)`: 0002's body plus two keys, each left out when empty, so with no meals and no list it is exactly 0002's answer. Each day gains `meals: [{slot, label, title, cook, cook_word, mine}]` when it has any, in breakfast, lunch, dinner order: `label` is the slot's word in their language ("Cena"); `title` is `private.meal_title`, or "Private item" for a locked meal they aren't on; `cook` is the first name of the person on it (`private.short_name`; null for nobody, or someone no longer active); `cook_word` is "Cocina Sam" / "Sam cooks" or "Sam se encarga de la cena" / "Sam's on dinner" ("Cocinas tú" / "You cook", "Te encargas tú" / "You're on dinner" when `mine`); the `note` and `link` only when `mine`. The top level gains `list: {to_buy}` (the number of unlocked lines to buy) for a helper while `household.helper_list` isn't `'off'`, once `shopping_items` has a row.
- `day_text(p_person uuid, p_day date)`: 0002's body, plus one line per meal the person is on that day, in slot order, after the day's items and before Late: "Dinner: Tacos · You cook" / "Cena: Sobras · Te encargas tú". A locked meal's title too (the text goes to the person on it); never its note or link. A day with only that line no longer says "Nothing planned".
- `calendar_plan(p_site text default null, p_limit int default 60)`: 0003's body with two changes marked "v1.2", both doing for meals what it does for events: a link to a past meal is no longer wanted only when that meal was deleted, moved or locked (so a past dinner stays on Google as history, instead of being deleted the day it leaves the window); and the past copy of a dinner locked later comes off with the deletes that hide something (first in the order).

Wrapped: the two longest functions keep their 0003 bodies, byte for byte, under a `_v3` name, and a thin new function under the old name adds the meals on top.
- `digest_for(p_person uuid, p_local_date date)`: 0003's function is renamed `digest_for_v3` and moved to `private` (`alter function … rename to`, then `… set schema private`): `private.digest_for_v3(p_person, p_local_date)`, with its body and its grant (service_role only). The new `public.digest_for` (plpgsql, STABLE, SECURITY INVOKER; service_role only, as before) returns `_v3`'s email unchanged when it is null or no meal is planned that day. Otherwise it appends one row per meal to `today` (`private.meal_digest_item`, slot order; "Private item" for a kid or helper who isn't on a locked meal); on a day `_v3` calls "Nothing planned" (nothing in Today or Late) the subject names the first meal instead ("Tue Oct 27: Dinner: Tacos · Sam cooks", "… · You cook" for the cook; a locked one is "Dinner: Private item" for everyone, as the subject shows on lock screens); and an `empty` email (nothing to say) is sent after all only to the person on a meal that day, so dinner alone emails only the cook. `_v3` calls `public.day_text` by name, so the parents' blocks for each kid and helper get the cook's line too.
- `private.calendar_desired(p_from date, p_to date, p_site text)`: 0003's function is renamed `calendar_desired_v3`: `private.calendar_desired_v3(p_from, p_to, p_site)`, with its body and its grants (authenticated, service_role). The new one (SQL, STABLE, the same 14 columns and grants) is `_v3`'s rows `union all` `private.meal_events(p_from, p_to, p_site)`. `calendar_plan`, `calendar_preview`, `calendar_store_events` and `calendar_finish` call it by name, so they get the meal rows with no change of their own.
- **A later migration that changes `digest_for` or `calendar_desired` replaces the wrapper and its `_v3` body together**, and says so here. Checks 5b ("same output": `digest_for`, `day_text` and `get_person_day`) and 5c ("same wall": `calendar_desired`, `calendar_plan` and `calendar_preview`) in `tests/db/run.sh` show what such a change does to the email and the wall.

New in private:
- `private.shop_who()` returns `public.people`: the signed-in caller's active person (`people.email = public.current_email()`), or a null row. It acts for nobody but the caller; `shopping_list()` needs it for the reader's language. Authenticated, service_role.
- `private.food_words()` returns table `(en text, es text, aisle text)`: the one built-in word list, everyday things as English/Spanish pairs with their aisle ("milk", "leche", dairy); words that mean something else in the other language ("pan", "red") are left out. A pair both guesses an aisle and makes "Leche" the same line as "Milk" (whole names only). Nobody.
- `private.guess_aisle(p_name text)`: an aisle from `food_words` for the parsed name (lowercased, accents dropped, the whole name first, then each word from the last, with a trailing "s" or "es" also tried), else `'other'`. Used once, when a line is first added. Nobody.
- `private.food_other(p_name text, p_lang text)`: the name in `p_lang` when the whole name is a `food_words` entry in the other language ("Leche" read in English is "milk"), else null. STABLE: a lookup in `private.food_pairs`, the name normalized once (a `materialized` CTE), well under a millisecond, since it runs once per line in `shopping_list()` and `list_for_helper` and in `list_add`'s twin search. SECURITY DEFINER, so a member's `shopping_list()` can read `food_pairs`. Authenticated, service_role.
- `private.list_add(p_name text, p_private boolean, p_by uuid, p_my_day boolean)` returns jsonb `{result, item_id, name}`: the one add rule, shared by `add_to_list` and `add_to_list_by_token` (`docs/v1.2-kitchen.md` §4.1). The text is cut to 200 characters, cleaned, and split into a name and a note ("2 lb ground beef" is ground beef, note "2 lb"; "Milk: 2 gallons" is Milk, note "2 gallons"). From My day only the unlocked line is ever looked at; signed in, the line with the lock asked for, else the other one (a re-add never unlocks). A resend that changes nothing is `'already'` and isn't counted (a note already in the line's note, as the whole note or a run of its " · " parts, changes nothing); anything else from My day is counted first. At most 200 lines to buy (150 from My day, so the family can always add): 54000 "The list is full." Nobody.
- `private.list_buy(p_item uuid, p_bought boolean, p_seen timestamptz, p_by uuid, p_my_day boolean)` returns boolean (true when something changed): the one tick rule (§4.2 there). From My day a locked line counts as no line, a call about to change a row is counted, and only her own tick of the last 15 minutes can be undone (else 42501). Bought less than 15 minutes ago, not bought is an Undo (`added_by` stays); older, the line goes back on the list (added by `p_by`). Either way `added_at` is now: it is the line's `seen`, so a tick sent again after someone's Undo (its reply lost) gets false instead of buying the line again. Nobody.
- `private.list_claim(p_key uuid, p_by uuid, p_my_day boolean, p_ask text, out held boolean, out answer jsonb)`: a change's key in `private.list_done`, claimed for this call (`held`: do the change, then keep its answer), or the answer the first try of the same change got (`answer`: give it and do nothing). Neither without a key, or with one that is someone else's, from the other side, or another change's (`p_ask`, the change and its arguments): the call is done and nothing kept. A second try that arrives while the first is still running waits on the key, then reads its answer. Each new key trims the table (2 days, the sender's latest 200). Nobody.
- `private.list_add_once(p_key uuid, p_name text, p_private boolean, p_by uuid, p_my_day boolean)` returns jsonb, and `private.list_buy_once(p_key uuid, p_item uuid, p_bought boolean, p_seen timestamptz, p_by uuid, p_my_day boolean)` returns boolean: `list_add` and `list_buy` once per key, through `list_claim`; a second try gets the first answer, changes nothing and isn't counted. Nobody.
- `private.count_my_day(p_person uuid, p_what text)`: SECURITY DEFINER. One more `'changes'` or `'ticks'` for her today in `my_day_use` (an upsert, whose row lock queues her parallel calls, so the count is exact); past 30 changes or 100 ticks a day, P0001 "Too many changes from My day today." / "Too many ticks from My day today." Nobody.
- `private.list_for_helper(p_person uuid)` returns jsonb: My day's list, `{language, as_of, can_add, items: [{id, name, note, aisle, seen, other}], bought: [{id, name, note, aisle, seen, undo}], suggest: [{name, aisle, other}]}`: unlocked lines only; `bought` is what was bought since the household's midnight plus her own ticks of the last 15 minutes (`undo` true for those); `suggest` (only when she can add) is up to 60 unlocked names bought in the last 30 days and not to buy now. No names of family members, no ids of people. Nobody.
- `private.food_word(p_key text, p_lang text)`: v1.2's fixed words in English and Spanish (the slots, the quick kinds, "{name} cooks" / "Cocina {name}", "You cook" / "Cocinas tú", "{name}'s on dinner" / "{name} se encarga de la cena", "You're on dinner" / "Te encargas tú"), falling back to `private.calendar_word(p_key, p_lang)`, and so to `private.word(p_key, p_lang)`, both unchanged. Authenticated, service_role.
- `private.meal_title(m public.meals, p_lang text)`: a cooked meal's title, else the quick kind's word ("Leftovers" / "Sobras"). Authenticated, service_role.
- `private.meal_digest_item(m public.meals, p_person uuid, p_lang text, p_hide boolean)` returns jsonb: one meal as a row of the email's Today, in the shape `render.ts` already draws, `{kind: 'meal', item_id, occurrence, time: 'Dinner', title, detail, contractor_phone: null, status: 'open'}`, so `hub-jobs` needed no change: "Dinner | Tacos · Sam cooks"; for the person on it "You cook" and then the note. Service_role.
- `private.meal_events(p_from date, p_to date, p_site text)` returns the same 14 columns as `private.calendar_desired`: one all-day, transparent event per meal on the writing Family calendar (Hub – Family), while `household.meals_on_wall` is on: "Dinner: Tacos (Sam)", with the first name of the person on it while they are on the family list; a locked meal is "Dinner: Private item", `visibility: private`, with no name. The description is "Made by Home Hub…", who's on it unless locked, and with a site the link to `#/food`; never the note, the link or anything from the list. Its id is `private.calendar_event_id(p_key)` of `private.calendar_key(p_kind, p_item, p_job, p_occurrence, p_google, p_part)` with kind `'meal'`. Authenticated (the preview), service_role.
- `private.meals_tidy()` and `private.shopping_items_tidy()`: the triggers above.

"Nobody" means revoked from public, anon and authenticated: only the definer functions above call them. day_text runs as a member (Today's "Send their day") and as service_role (inside the email), the wall as an admin (the preview) and as service_role, and `shopping_list()` as the member who calls it, so what those reach is granted to both.

One grant changes: `private.clean_text(p_text, p_max)` is also granted to authenticated (before, service_role only). It is a pure function, and the two tidy triggers run as the member who saves a meal or renames an item.
