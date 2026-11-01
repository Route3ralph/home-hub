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

**v1.3 — Homework (the site goes live first; then the migration, after 0004)**
- A Homework page (`#/homework`) for the parents; on a kid's My day, his homework in small steps, a focus timer, points and rewards; and a tutor link (`day.html?h=<token>`) that shows one kid's homework and nothing else. A later PR adds the AI planner (a `hub-jobs` change, no migration).
- The build contract is `docs/v1.3-homework.md`. Its database part is migration `0005_homework.sql`, summarised in §10 below.

**v1.3 — the school feed (the site and `hub-jobs` go live first; then the migration, after 0005, and `cron.sql` again)**
- The school's Blackbaud calendar links (Assignments, Schedule, Games/Practices), copied by a parent and kept as secrets: `hub-jobs` reads them hourly; his assignments reach his My day as New from school, his schedule and games are busy time. A `hub-jobs` and `cron.sql` change, no new secret.
- The build contract is `docs/v1.3-homework.md` §11 and §12. Its database part is migration `0006_homework_school.sql`, summarised in §11 below.

**v1.3 — the coach view (the site goes live first; then the migration, after 0006)**
- The tutor is also the kid's coach: a per-link switch, off by default and set only by the parents, lets the tutor link also show, read-only, the kid's points and rewards, his focus sessions, his own calendar and his daily tasks (never the rest of the family), and lets the tutor leave the parents a note. No Edge Function and no `cron.sql` change.
- The build contract is `docs/v1.3-homework.md` §20. Its database part is migration `0007_homework_coach.sql`, summarised in §12 below.

**v1.3 — the first-import check's past items (the site goes live first; then the migration, after 0007)**
- A school link read over a weekend or a holiday may hold only assignments already past. The status card's first-import check then showed nothing to answer, so nothing from the link could reach the kid or the tutor. From 0008 the check fills up with the latest past ones, each marked past, and the page says so. No Edge Function and no `cron.sql` change.
- The build contract is `docs/v1.3-homework.md` §11.2 step 7, §12.8 and §16.6. Its database part is migration `0008_school_check.sql`, summarised in §13 below.

**v1.3 — the school items' keys (a paste after 0008; no site, Edge Function or `cron.sql` change)**
- Blackbaud gives every event a new UID each time it makes its feed again, every hour or two (confirmed on the live database, 2026-10-31), and 0006 keyed an item with a UID by it: each change of UIDs added every item again and marked the ones before missing, then gone. From 0009 an item is keyed by what it is (an assignment by its class, title and first day; a schedule or games item by its title and start), never by its UID, and the copies already stored become one row an item.
- The build contract is `docs/v1.3-homework.md` §2.8, §11.3, §12 item 9 and §16.8. Its database part is migration `0009_school_keys.sql`, summarised in §14 below.

**v1.1 — Hearth people: a shared calendar sorted by Hearth person (the site goes live first, then `hub-jobs`, then the migration, after 0009)**
- The kitchen wall keeps its own events in one Google calendar, "Hearth Calendar", and marks whose each is by adding that Hearth profile as a guest (`jordan@team-…`). With **Sort by Hearth person** on that calendar, the hub sends each event to the people its tags reach, as the parents matched them once in Settings: a person, Family, or the grown-ups. `hub-jobs` asks Google for guest addresses only for such a calendar and keeps only Hearth-shaped ones. No new Edge Function, secret or `cron.sql` change.
- The build contract is `docs/v1.1-google-calendar.md` §11. Its database part is migration `0010_hearth_people.sql`, summarised in §15 below.

**v1.4 — project guests (the site goes live first, then the migration, after 0010; no Edge Function or `cron.sql` change)**
- A project guest, such as an interior designer, signs in with an emailed code like the family but is not a member: every policy and function gated on `private.is_member()` or `private.is_admin()` keeps them out, unchanged. A parent gives them a project from its **Guest access**; they then see and manage only that project's schedule, trades and the contractors on it (names, phones, emails; never account details), and nothing else. A project gets a **Documents** link to its shared Google Drive folder.
- The build contract is `docs/v1.4-project-guests.md`. Its database part is migration `0011_project_guests.sql`, summarised in §16 below.

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
- v1.4 (§16): a **project guest** signs in with a code but is not a member (`guests`, not `members`), so the invariant below keeps them out of everything except the projects a parent gives them (`project_guests`; the policies "Guests see their projects" and "Guests update their projects"). `whoami()` is null for them; the site asks `guest_whoami()` instead.
- Invariant: every policy is `private.is_member()`-gated (full members = everyone who can sign in in v2), except the project guests' two policies on `projects` (§16), and except the anonymous token functions, which check the token: My day's `get_person_day`, `complete_by_token`, `undo_by_token` and `stop_digest`, the confirmation email's `confirm_digest`, (v1.2, §9) the helper's shopping list, `get_list_by_token`, `add_to_list_by_token` and `buy_item_by_token`; (v1.3, §10) a kid's homework on My day, `homework_by_token`, `step_by_token`, `plan_by_token`, `focus_by_token`, `reward_by_token`, `assignment_by_token` and `homework_prefs_by_token`; and v1.3's tutor link, whose four functions find one kid's homework by its token: `tutor_view_by_token`, `tutor_assignment_by_token`, `tutor_plan_by_token` and `tutor_step_by_token`.

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
A secret is the only key: the person's My day token (`people.day_token`) for fifteen of them, the confirmation secret (`people_confirm.token`) for `confirm_digest`, and a tutor link's token (`tutor_links.token`) for the tutor link's six. These twenty-two are the only new functions anon can call (v1's `get_shared_project` is the other one): 0002 adds the first five, migration 0004 (v1.2, §9) the next three, for the helper's shopping list, migration 0005 (v1.3, §10) eleven, seven for a kid's homework on his My day and four for the tutor link, migration 0006 (§11) one, his New from school, and migration 0007 (§12) the last two, the tutor link's coach view. A tutor token is never a My day token: the My day functions look up `people.day_token` only, and the tutor link's six `tutor_links.token` only.
- `get_person_day(p_token text) returns jsonb` → `{person:{name, language, digest_enabled, email_confirmed}, today: date, days:[{day, items:[…]}], late:[…]}` for today and tomorrow; only that person's items (responsible or participant); item fields: kind, item_id, occurrence, day, end_day, title, all_day, start_time, end_time, time_label, location, contractor_name, contractor_phone, note (a changed day's own note), status, mine (a task they're in charge of). No notes, no other people's details; private items read "Private item". Returns null for an unknown token or inactive person. (v1.2 adds `meals` to a day that has any, and `list` for a helper; both are left out when empty: §9.)
- `complete_by_token(p_token text, p_task_id uuid, p_occurrence date) returns uuid` (log id, for Undo) → only tasks where that person is responsible; a repeating task needs `p_occurrence` (a page left open overnight can't tick off the next date); otherwise the same rules as complete_task. Logged as done by "<name> (My day)".
- `undo_by_token(p_token text, p_log_id uuid) returns uuid` (task id) → the toast's Undo on My day: only a `done` entry that person made on My day, on a task they're in charge of, that is still the task's latest entry, within 15 minutes.
- `confirm_digest(p_confirm text) returns boolean` → the button on the page the confirmation email opens (`day.html?c=<secret>#confirm`). The secret is the whole key: the link carries no My day token, so an email that goes to a mistyped address gives away nothing but the chance to confirm that address, and a My day link (which a kid, a helper or a WhatsApp group may have) confirms nothing. Sets email_verified_at. True also when the address was already confirmed (a second tap, or the email opened again later; the secret is kept); false for an unknown, malformed or replaced secret (the address changed since) or an inactive person.
- `stop_digest(p_token text) returns boolean` → digest_enabled = false.
- `get_list_by_token(p_token text) returns jsonb` (v1.2) → the shopping list on a helper's My day: `{language, as_of, can_add, items, bought, suggest}`, unlocked lines only, with no person's name or id. Null for anyone but a helper, and while `household.helper_list` is `'off'`.
- `add_to_list_by_token(p_token text, p_name text, p_key uuid default null) returns jsonb` (v1.2) → her add, while `helper_list` is `'add'`: `{result, item_id, name, seen}` (`seen`: the line's `added_at`) and her list. Only ever finds or makes an unlocked line; anything over 200 characters is refused before any work; counted (30 changes a day) and capped (150 things to buy). `p_key` is her phone's key for the add: a second try gets the first answer, changes nothing and isn't counted again (§9, `private.list_done`).
- `buy_item_by_token(p_token text, p_item uuid, p_bought boolean, p_seen timestamptz, p_key uuid default null) returns jsonb` (v1.2) → her tick, or the Undo of her own tick within 15 minutes: `{changed, seen}` (`seen`: the one it gave the line, when it changed it) and her list. `p_seen` is the row's state as her phone saw it, so a tick that waited offline never buys a line put back since; a locked line's id answers as an unknown id (`false`); counted (100 ticks a day). `p_key` as for her add.
- `homework_by_token(p_token text) returns jsonb` (v1.3) → a kid's homework view (`docs/v1.3-homework.md` §3.4): his steps, his homework time, the block running, his points and rewards, with no name but his own first name and the tutor's first word, no teacher's text and no AI draft. Null for an unknown token, an inactive person, anyone who isn't a kid, or a kid whose homework is off; the same for each of the seven.
- `step_by_token(p_token text, p_step uuid, p_action text, p_text text default null, p_day date default null, p_key uuid default null) returns jsonb` (v1.3) → his tick (a milestone's tick pays half its points at once, answered as `paid`), Undo (his own, 15 minutes; on a milestone it takes that half back), Not today, Ask and Make it smaller on one step of a plan given to him; any other step is 42501 "That step isn't on your plan.".
- `plan_by_token(p_token text, p_assignment uuid, p_steps jsonb, p_rev int) returns jsonb` (v1.3) → his own changes to a plan given to him (milestones and the turn-in stay as they are); `p_steps` null is Re-plan.
- `focus_by_token(p_token text, p_action text, p_session uuid, p_minutes int default null, p_step uuid default null, p_assignment uuid default null, p_with text default null, p_result text default null, p_note text default null) returns jsonb` (v1.3) → the timer: start, switch and end a block; only the database's clock counts, and the points follow from it, paid at the block's end. `p_result` `'time'` is the phone's End the second the ring runs out (paid then); his answer (`'done'`, `'more'`, `'stopped'`) follows as a second End that pays nothing more.
- `reward_by_token(p_token text, p_action text, p_reward uuid default null, p_text text default null, p_key uuid default null, p_cost int default null) returns jsonb` (v1.3) → ask for a reward, cash an instant one on the spot (`'cash'`: from his free points, at most `homework_kids.instant_day` a day, at the price his button showed, `p_cost`, else 22023 "That reward's price changed."; the ask is `'cashed'` and the trade written at once), cancel his own ask, or suggest one.
- `assignment_by_token(p_token text, p_action text, p_assignment uuid, p_title text default null, p_subject text default null, p_due_date date default null, p_minutes int default null) returns jsonb` (v1.3) → homework he writes down himself: add, Quick (one step, given at once), drop.
- `homework_prefs_by_token(p_token text, p_cue text, p_if_stuck text, p_minutes int) returns jsonb` (v1.3) → his start cue, his if-stuck line and his first length.
- `tutor_view_by_token(p_token text, p_assignment uuid default null, p_part text default 'all') returns jsonb` (v1.3) → the tutor's view of one kid's homework: plans, steps to check, questions, his free minutes (no titles) and a 14-day record of finished blocks; never a block running now, points, rewards, other people, family event titles or any token. Null for an unknown or replaced token, a link that is off or past its end date, or a kid whose homework is off or who is no longer active; the same for each of the four.
- `tutor_assignment_by_token(p_token text, p_fields jsonb) returns jsonb` (v1.3) → adds or changes an assignment or lesson of the link's kid, and with `ai` `'undo'` or `'dismiss'` does that to its AI draft (as `homework_ai_draft`); any other is 42501 "That assignment isn't on this link.". A title that cleans to nothing is refused (22023), on a change too.
- `tutor_plan_by_token(p_token text, p_assignment uuid, p_steps jsonb, p_rev int, p_give boolean default false) returns jsonb` (v1.3) → a plan saved from the link, given to him with `p_give`.
- `tutor_step_by_token(p_token text, p_step uuid, p_action text, p_text text default null) returns jsonb` (v1.3) → checks a milestone (Not yet, and taking a check back within 15 minutes), and answers his question.
- `school_item_by_token(p_token text, p_item uuid, p_action text, p_minutes int default null) returns jsonb` (v1.3, 0006) → his New from school: `'quick'` (`p_minutes` 5 to 60; the item becomes an assignment from school and Quick makes it tonight's one step, by `assignment_by_token`'s rules: "Plan this one with Pat." for one due 4 or more days out, and then nothing is made), `'with_tutor'` (Plan with Pat: an assignment from school with no plan, on the tutor's link) or `'hide'`. Only an item of his checked Assignments link still on the school site; any other is 42501 "That isn't on your list from school.". Counted as his writes; answers `{assignment_id}` and his view.
- `coach_view_by_token(p_token text) returns jsonb` (v1.3, 0007) → the coach view of a tutor link whose coach view a parent turned on (`docs/v1.3-homework.md` §20.3): the kid's points (balance, this week's and last week's by kind, the last 30 days' lines without who), his rewards, asks and cash-ins, his focus sessions of the last 30 days, his own calendar (the last 7 and next 14 days) and his daily tasks (today and the last 7 days), private ones as "Private item"; never anyone else's. Null, as the tutor link's four, for a link that doesn't work, and for one whose coach view is off.
- `coach_note_by_token(p_token text, p_key uuid, p_note text) returns jsonb` (v1.3, 0007) → a note for the parents (1 to 500 characters, the page's key for a resend, at most 5 a day), which only they read; answers `{note_id, changed}` and the coach view. Null as above.
Each v1.3 writer is counted (150 writes and 20 Starts a day for his link, 200 writes a day for a tutor link: P0001 "That's a lot for one day.") and answers with the view, so the page redraws without a second read (§10).
Tokens and secrets are 32 hex characters; `rotate_day_token(p_person uuid)` (admin) replaces a My day token, and the old link stops working at once; `new_tutor_token(p_link uuid)` (admin, v1.3) replaces a tutor link's.

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
`hub_schema_version()` returns 2 (authenticated); migration 0003 makes it 3 (§8), migration 0004 makes it 4 (§9), migration 0005 makes it 5 (§10), migration 0006 makes it 6 (§11), migration 0007 makes it 7 (§12), migration 0008 makes it 8 (§13), migration 0009 makes it 9 (§14), migration 0010 makes it 10 (§15), and migration 0011 makes it 11 (§16). `whoami()` gains `person` (id, name, role, language, color) when a person row matches the caller's email; existing keys unchanged. `mark_signed_in()` (authenticated; the core calls it after every sign-in): signing in with a code sent to an address proves it works, so the caller's own person row gets email_verified_at (the first time only). The confirmation secret stays, so the button in a confirmation email sent earlier says "confirmed" too. Does nothing for anyone who isn't a member.

## 4. Client

### Core and modules
- `assets/hub.js` = core: sign-in (then `mark_signed_in()`), shell, router, forms, api helpers, message helpers (sms/wa.me/mailto), toasts (with an Undo action; going to another page takes an Undo toast away, since its Undo was for the page left), caches (people, household, clock), schema version.
- Module contract: `HomeHub.register({ name, schema: { min, max }, nav: { label, order, primary }, match(parts) → params | null, render(main, ctx) })`, where `ctx = { seq, params, signal, stale() }`. The core aborts `signal` on navigation; modules add listeners with `{ signal }`.
- Script tags load in a fixed order without async; every `src` carries the same `?v=…`, bumped together on each release.
- Formatting uses the household time zone (`Intl.DateTimeFormat(…, { timeZone })`); "today" comes from `clock()`.

### Navigation
- Desktop: top tabs — Today · Calendar · Tasks · Projects · Directory · Family · Settings; on schema 4 (v1.2) Food comes after Tasks: Today · Calendar · Tasks · Food · Projects · Directory · Family · Settings; on schema 5 (v1.3) Homework comes after Food: Today · Calendar · Tasks · Food · Homework · Projects · Directory · Family · Settings.
- Phones (< 640px): bottom bar — Today · Calendar · ＋ · Tasks · More (More: Projects, Directory, Family, Settings, Sign out); on schema 4 Food gets a button of its own: Today · Calendar · ＋ · Tasks · Food · More. On schema 5 the bar stays at those six cells, and Homework is first in More (Homework, Projects, Directory, Family, Settings). ＋ opens the Add sheet: Event | Task, and on schema 4 also Shopping ("Something to buy", the Food page's one-field add, `use('food').openListAdd`).
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
- **Homework** (v1.3, schema 5; `#/homework`, and `#/homework/<assignment id>` for one assignment or lesson; heading "Homework", "Plans, focus sessions and points"): §10 has the database, `docs/v1.3-homework.md` §9.1 every rule. The parents act; an adult reads it all, with no buttons drawn (the database refuses anyway). On schema 7 each tutor link also has its **Coach view** switch (`set_tutor_coach`, off by default, with what it shows in plain words) and the coach's notes for the parents (`coach_notes`, with **Done**, `coach_note_done`).
  - The kid line: his points and his homework time (a kid picker with two kids). The first visit turns homework on for a kid (`save_homework_kid`), sets his homework time (a weekly event in his name, `add_homework_time`, prefilled Mon–Thu 4:30–5:15; changed on the Calendar page as any event) and asks for three rewards in three sizes.
  - Then, each left out when empty: **To approve** (his asks, with his balance and where this week's points came from: Yes, Not now; his suggestions to price), **To check** (milestones he ticked: Looks done with an optional note, Not yet with one), **To talk about** (milestones his steps can't reach), **Questions and notes** (open questions with Answer; every answer and coach's note of the last 7 days, with who and when), **Assignments and lessons** (+ Assignment, + Lesson; the teacher's text, pasted, with the Live Text hint; Done (30 days) folded), **This week** (the week strip from `homework_week`, with busy titles; focused minutes, pace, his blocks), **Points and rewards** (Give points, Void, the rewards) and **Switches** (homework on, points and their values and caps, the tutor's links: Copy, WhatsApp, Text, New link, Off, Extend 180 days; Erase).
  - An assignment opens `assets/plan.js`'s plan editor with a parent's rules: starter plans (placed by the database), steps and milestones, Place again, **Give Jordan this plan**, and "Changed since you opened it" on a stale save (`plan_rev`).
  - It reads on open, on focus and after each write; nothing polls. The AI parts (the drafts, Send to Claude, the AI switch) come with the AI planner's PR.
- **Today** (v1.3, schema 5, parents only): under the person chips (after the dinner line), the same under every chip, one line per waiting reward ask ("Jordan asks: Pick the movie · 100 · balance 118 (this week: +24 focus and on time, +40 milestones checked by Pat)", with **Yes** and **Not now**, one tap each) and one for questions and milestones to check ("Homework: 1 question · 2 milestones to check ›"). No line and no request for anyone else, or below schema 5; a failed read leaves them out.
- **Projects**: unchanged plus: dates recomputed on every schedule write in one choke point (`api.updateProject`/`createProject`), which sends `task_dates` with a new `task_dates_at` (the device clock), and backfilled when stale; project owner; "Show in Home Hub calendar"; a Tasks card listing the project's tasks with "Put on the schedule" (turns a task into a 1-day Gantt task with a trade picker, then deletes the task).
- **My day** (`day.html?t=<day_token>`): no sign-in; today and tomorrow for that person; check off own tasks (Undo for a few seconds, `undo_by_token`); in their language; stop the morning email with a button (`#stop`); "Add to Home Screen" hint. The confirmation email opens `day.html?c=<secret>#confirm` (no `t=`): that page shows only the confirm screen, whose button calls `confirm_digest(p_confirm)`. Opening a link never changes anything; only the buttons do (they're POSTs).
  - v1.2: each day ends with its meals ("Cena · Tacos · Cocina Sam"; the note and a **Receta** link only for the person on it). A helper, while the parents allow it, gets a **Lista de compras · 7 ›** button that opens `#list`: the unlocked lines in big rows by aisle (headings in her language), tick, the 15-minute Undo of her own tick, and (with See, tick and add) an add box and **Comprar otra vez**. It is read every 10 seconds while on screen, saved on the phone (under a hash of the link, never the link), shown from there when there is no connection, and her changes wait in the same outbox as the Food page's. Kids get the meals and no list.
  - v1.3: a kid with homework on (`get_person_day`'s `homework` key) gets a card under the greeting: the next step with its own **Start**, tonight's steps and minutes, his points. Behind it `#homework` (Now, with his start cue and one big Start; Tonight; From earlier, folded, with Re-plan; Due soon, with the two bars; + Homework and Quick), `#focus` (a shrinking ring counted to the server's end of the block; I'm stuck, Done, Stop; the stuck sheet: Make it smaller, Ask Pat, Next step; the end screen with the points the server saw), `#points` (his balance, the rewards, his asks and suggestions) and `#plan/<id>` (the plan editor with his rules: plain steps are his, milestones are set with the tutor), from `homework_by_token` and his six writers. Without the key there is no card and no homework request.
- **The tutor link** (v1.3, `day.html?h=<token>`, no `t=`): a third mode of `day.html`, which loads nobody's day. `plan.js`'s tutor view shows one kid's homework in a fixed order (To check, To talk about, Questions, Plans to look at, Assignments, His week, the last 14 days' finished blocks), opening each assignment in the plan editor, and calls only the four `tutor_*_by_token` functions (and, for v1.3's AI planner, `hub-jobs`' `homework_ai` action with the link's token in the body, never a sign-in). No points, rewards, family names, event titles or anything live (no block running now, no "alone"). A null answer: "This link no longer works."; before 0005: "This link doesn't work yet.". From 0007, for a link whose answer says `coach: true` (a parent turned its coach view on), a **Coach** section under the list, day.js's own, read with `coach_view_by_token` (his points by kind, rewards and asks, focus sessions, his own calendar, his daily tasks) and a note for the family (`coach_note_by_token`); with it off, nothing more is asked.
- `day.html` is a second public page: it loads `config.js`, supabase-js, `assets/shoplist.js` (v1.2), `assets/plan.js` (v1.3) and `assets/day.js` (not the hub), shares `assets/styles.css` (plus `assets/css/day.css` and, from v1.3, `assets/css/plan.css`), and carries the same `?v=` as `index.html`.

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
  - `tests/docs/*.test.js` — the docs against the code: deploy secrets, test suites, `?v=`, the scripts each page loads, and this document's tables, columns and function signatures; and (v1.3) no word of a medical or learning label in any file.
- `CLAUDE.md`: run `tests/run.sh` before every PR; deploy order; never put real names, numbers or IDs in fixtures.

## 7. Deploy order (needs Supabase access)
0. Move the project into the paid organization (owner); confirm the URL and project ref are unchanged.
1. `preflight.sql` (read-only checks) and `list_migrations`.
2. Merge PR A, then PR B (site stays in v1 mode until step 3).
3. Apply migration 0002 (site switches to v2 on next load).
4. Deploy `hub-jobs` from main with verify_jwt false (`supabase/config.toml` pins it for the CLI; the dashboard and the MCP's `deploy_edge_function` need it turned off by hand). Secrets: `HUB_CRON_SECRET` (≥ 32 chars), `SITE_URL` (required: the site's address, for the links in the emails; without it every run stops with `stop: 'config'` and Preview answers 503), `RESEND_API_KEY` and `EMAIL_FROM` (required) and `EMAIL_FROM_NAME`, shared with `send-email`; and `HEALTHCHECK_URL`, which is optional. For v1.1, `GOOGLE_SA_JSON` (optional: the Google service-account key; without it the calendar job stops with `not_set_up` and the morning email is unchanged). For v1.3's AI planner, `ANTHROPIC_API_KEY` (optional: the key from the family's Anthropic workspace; without it the `homework_ai` action answers `not_set_up` and everything else works; `docs/v1.3-homework.md` §6.12).
5. Create the two Vault secrets by hand (`hub_cron_secret`, the same value as `HUB_CRON_SECRET`, and `hub_jobs_url`, the function's address), then run `cron.sql` (enables pg_cron/pg_net; refuses a missing or placeholder secret; idempotent). Run `cron.sql` again after a release that changes it: v1.1 adds the `hub-calendar` job, and v1.3's school feed (migration 0006) the `hub-school` job.
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
  label, writes, for_kids, and updates those and copy_approved_at; nothing else. (0010 adds sort_by_guest, updated
  only: §15.)
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
- `google_items(p_from date, p_to date)` returns `setof public.agenda_item`: Google events as agenda rows of kind `'google'` (a fifth kind beside 'event', 'task', 'project' and 'contract'), with `item_id = md5(calendar_id || '/' || event_id)`, the calendar's person (or the household's pets or house owner) as `responsible_id`, and the source in `notes`. Range 1 to 62 days, like `agenda(p_from, p_to)`. (A calendar sorted by Hearth person's rows have nobody in charge and their people along: §15.)
- `calendar_preview(p_calendar uuid)` returns table `(day, title, private, item_kind, item_id, place, details)`: everything Start copying puts on one calendar (the job's window, yesterday to 60 days ahead), as the wall will show it, with each event's place and the rest of its description on one line. Admins only.

The calendar job (`service_role` only):
- `calendar_begin()` returns jsonb `{go, stop, run_id}`: takes the lease (`stop` is 'busy' or 'paused' when `go` is false).
- `calendar_signed_in(p_run uuid, p_auth text, p_account text, p_key_id text)`: how this run signed in to Google.
- `calendar_read_due(p_force boolean default false, p_limit int default 10)` returns table `(calendar_id, google_id, writes, w_from, w_to, time_min, time_max, tz)`: the calendars to read now (never-read ones first, then the one Google answered about longest ago). (Made again by 0010 with `sort_by_guest` last: §15.)
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
- `list_done`: indexes `list_done_at` on `(at)` and `list_done_by` on `(by_id, at)`. RLS on, no policies and no privileges (`revoke all … from public, anon, authenticated, service_role`): only `private.list_claim`, under the list's definer functions, reads and writes it. The outbox gives every change a key (a random uuid) and sends it with every try (`p_key` on `add_to_list`, `buy_item` and the two token writers): the first try that arrives does the change and keeps its answer, and a later one (its answer lost, or sent again by a reloaded page or a second tab) gets that answer, with the `seen` the change gave the line, and changes nothing, so a resent add never brings back a line bought in between, and the change waiting behind it on the phone goes with the line as this change left it. A key someone else sends, from the other side (My day or signed in), or with another change (another name or lock for an add, another line or direction for a tick, whatever its `seen`) counts as no key. Kept 2 days (a phone drops a change after 24 hours) and a sender's latest 200, trimmed at each new key, so a My day link can't make it grow without end (a member with no person sends with no id, so that member's keys go by the 2 days only).
- `household`'s two columns follow its policies: members read, admins update.
- Grants: Supabase's default privileges would give anon and authenticated everything on a new table, so all three start from `revoke all … from public, anon, authenticated` (and `my_day_use` from service_role). Signed-in users then get select and delete on `meals` and insert and update of its own columns (`day, slot, kind, title, cook_id, note, link, private`, never the audit columns), and select, delete and update of `name, note, aisle, private` on `shopping_items` (never `added_*` or `bought_*`). Anon has no privilege on the three. service_role keeps the defaults on `meals` and `shopping_items`: `digest_for` and the calendar job read them as it.

### Functions
Pages (`authenticated`, `service_role`; SECURITY INVOKER, so row-level security decides and a non-member gets empty lists):
- `shopping_list()` returns jsonb `{as_of, to_buy: [{id, name, note, aisle, private, added_by, seen, other}], bought: [{id, name, note, aisle, private, bought_by, seen}]}`: what is to buy (A–Z by `name_key`, then id) and everything bought since the household's midnight, plus the caller's own ticks of the last 15 minutes, as `list_for_helper` keeps hers (for a member with no person, the ticks with no `bought_by`, as the database records theirs) (`bought_at desc, name_key, id`). `as_of` is the household's local date and time; `added_by` and `bought_by` are person ids; `seen` is the row's state as the phone saw it (`added_at` to buy, `bought_at` bought, as `to_jsonb` writes a `timestamptz`), which the page sends back as `p_seen`; `other` is the name in the reader's language when the word list knows it in the other one ("Leche" carries `other: 'milk'` for Alex), left out when there is none. The Food page reads it every 10 seconds while the list is on screen; Buy again comes from the page's own read of the table, so this answer stays small.

Signed-in actions (`authenticated` only; SECURITY DEFINER, in `public` because the page calls them; each raises 42501 "Only the family can change the shopping list." unless `private.is_member()`, and reads its snapshot in a statement after the write):
- `add_to_list(p_name text, p_private boolean default false, p_key uuid default null)` returns jsonb `{result, item_id, name, seen}` and the list: `private.list_add`'s rule, for the caller, once per key (`private.list_add_once`). `result` is `'added'` (a new line), `'already'` (it was to buy: still one line, and a new note joins the old with " · ") or `'back'` (it was bought: back on the list, its aisle kept); `name` is the line's own name ("Milk" when "Leche" joined it); `seen` is the line's `added_at` once the add is done.
- `buy_item(p_item uuid, p_bought boolean, p_seen timestamptz, p_key uuid default null)` returns jsonb `{changed, seen}` and the list (`seen`: the one it gave the line when it changed it, a tick's `bought_at` or an un-tick's new `added_at`; else null): `private.list_buy`'s rule, for the caller, once per key (`private.list_buy_once`). `p_seen` is required: a buy changes only a line to buy whose `added_at` is `p_seen`, and a put-back only a bought line whose `bought_at` is `p_seen`, so a resend changes nothing and a change that waited offline never undoes a newer one; with `p_key`, a resend gets the first try's answer (`changed: true` when it was done, with that try's `seen`, whatever happened to the line since).

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
- `private.list_claim(p_key uuid, p_by uuid, p_my_day boolean, p_ask text, out held boolean, out answer jsonb)`: a change's key in `private.list_done`, claimed for this call (`held`: do the change, then keep its answer), or the answer the first try of the same change got (`answer`: give it and do nothing). Neither without a key, or with one that is someone else's, from the other side, or another change's (`p_ask`, the change and its arguments: an add's name and lock, a tick's line and direction, not its `seen`): the call is done and nothing kept. A second try that arrives while the first is still running waits on the key, then reads its answer. Each new key trims the table (2 days, and the sender's latest 200 when the sender has an id). Nobody.
- `private.list_add_once(p_key uuid, p_name text, p_private boolean, p_by uuid, p_my_day boolean)` returns jsonb `{result, item_id, name, seen}`, and `private.list_buy_once(p_key uuid, p_item uuid, p_bought boolean, p_seen timestamptz, p_by uuid, p_my_day boolean)` returns jsonb `{changed, seen}`: `list_add` and `list_buy` once per key, through `list_claim`, with the `seen` the change gave the line (the line's `added_at` after an add; a tick's `bought_at`, an un-tick's new `added_at`, or null when nothing changed); a second try gets the first answer, `seen` and all, changes nothing and isn't counted. Nobody.
- `private.count_my_day(p_person uuid, p_what text)`: SECURITY DEFINER. One more `'changes'` or `'ticks'` for her today in `my_day_use` (an upsert, whose row lock queues her parallel calls, so the count is exact); past 30 changes or 100 ticks a day, P0001 "Too many changes from My day today." / "Too many ticks from My day today." Nobody.
- `private.list_for_helper(p_person uuid)` returns jsonb: My day's list, `{language, as_of, can_add, items: [{id, name, note, aisle, seen, other}], bought: [{id, name, note, aisle, seen, undo}], suggest: [{name, aisle, other}]}`: unlocked lines only; `bought` is what was bought since the household's midnight plus her own ticks of the last 15 minutes (`undo` true for those); `suggest` (only when she can add) is up to 60 unlocked names bought in the last 30 days and not to buy now. No names of family members, no ids of people. Nobody.
- `private.food_word(p_key text, p_lang text)`: v1.2's fixed words in English and Spanish (the slots, the quick kinds, "{name} cooks" / "Cocina {name}", "You cook" / "Cocinas tú", "{name}'s on dinner" / "{name} se encarga de la cena", "You're on dinner" / "Te encargas tú"), falling back to `private.calendar_word(p_key, p_lang)`, and so to `private.word(p_key, p_lang)`, both unchanged. Authenticated, service_role.
- `private.meal_title(m public.meals, p_lang text)`: a cooked meal's title, else the quick kind's word ("Leftovers" / "Sobras"). Authenticated, service_role.
- `private.meal_digest_item(m public.meals, p_person uuid, p_lang text, p_hide boolean)` returns jsonb: one meal as a row of the email's Today, in the shape `render.ts` already draws, `{kind: 'meal', item_id, occurrence, time: 'Dinner', title, detail, contractor_phone: null, status: 'open'}`, so `hub-jobs` needed no change: "Dinner | Tacos · Sam cooks"; for the person on it "You cook" and then the note. Service_role.
- `private.meal_events(p_from date, p_to date, p_site text)` returns the same 14 columns as `private.calendar_desired`: one all-day, transparent event per meal on the writing Family calendar (Hub – Family), while `household.meals_on_wall` is on: "Dinner: Tacos (Sam)", with the first name of the person on it while they are on the family list; a locked meal is "Dinner: Private item", `visibility: private`, with no name. The description is "Made by Home Hub…", who's on it unless locked, and with a site the link to `#/food`; never the note, the link or anything from the list. Its id is `private.calendar_event_id(p_key)` of `private.calendar_key(p_kind, p_item, p_job, p_occurrence, p_google, p_part)` with kind `'meal'`. Authenticated (the preview), service_role.
- `private.meals_tidy()` and `private.shopping_items_tidy()`: the triggers above.

"Nobody" means revoked from public, anon and authenticated: only the definer functions above call them. day_text runs as a member (Today's "Send their day") and as service_role (inside the email), the wall as an admin (the preview) and as service_role, and `shopping_list()` as the member who calls it, so what those reach is granted to both.

One grant changes: `private.clean_text(p_text, p_max)` is also granted to authenticated (before, service_role only). It is a pure function, and the two tidy triggers run as the member who saves a meal or renames an item.

## 10. v1.3: Homework

The build contract is `docs/v1.3-homework.md`; this section lists what its migration, `supabase/migrations/0005_homework.sql`, adds to the database, so the docs check can hold the two together. Fresh install = `schema.sql`, then `0002`, `0003`, `0004` and `0005`. It is one transaction and additive (the v2 pages work the same on 4 and 5), every rule in §3 applies, and it seeds no rows: with homework off for everyone (no `homework_kids` row on, whatever else is stored), the email, the texts, My day and the wall come out byte for byte as on 4 (check 5d in `tests/db/run.sh`). It opens with guards, each of which changes nothing: without `hub_schema_version()` it raises "Home Hub v2 (migration 0002) isn't installed"; below 4, "Meals and shopping (migration 0004) isn't installed"; at 5 or more, "Homework (migration 0005) is already installed"; with `homework_kids` there but the version set back to 4 (`docs/v1.3-homework.md` §16.3), "… set back to 4"; and unless `get_person_day(text)`, `private.digest_for_v3(uuid, date)` and `shopping_items` are as 0004 left them, "This database isn't as migration 0004 left it". It ends by making `hub_schema_version()` return 5. No Edge Function change and no `cron.sql` change, so the site goes live first, then the owner applies 0005 (`docs/v1.3-homework.md` §16.1). **0005 touches neither wrapper**: `digest_for`, `private.digest_for_v3`, `calendar_desired`, `private.calendar_desired_v3`, `day_text`, `calendar_plan`, `agenda` and `person_items` are as 0004 left them. Eleven new functions for anon (§3 "Anonymous token functions"): seven for a kid's homework on his My day and four for the tutor link.

### Tables
```sql
-- Homework is on for this kid: one row per kid, made by a parent (save_homework_kid).
create table public.homework_kids (
  kid_id             uuid primary key references public.people (id) on delete cascade,
  active             boolean not null default true,     -- off: no card on his My day, his tutor links answer null, the AI refuses; nothing deleted
  points_on          boolean not null default true,     -- off: nothing earned; points, rewards and asks hidden on My day
  focus_minutes      int not null default 10 check (focus_minutes in (10, 15, 20, 25)),   -- the length offered first
  cue                text check (cue is null or char_length(cue) between 1 and 120),           -- his start cue, in his words
  if_stuck           text check (if_stuck is null or char_length(if_stuck) between 1 and 120), -- his if-then line
  pts_focus          int not null default 1 check (pts_focus between 0 and 5),                -- per focused minute of a block
  pts_on_time        int not null default 10 check (pts_on_time between 0 and 50),
  pts_milestone      int not null default 40 check (pts_milestone between 0 and 100),         -- half at his tick, the rest at the check
  pts_day_cap        int not null default 60 check (pts_day_cap between 0 and 300),           -- focus and on-time points a day
  pts_milestone_week int not null default 160 check (pts_milestone_week between 0 and 400),   -- milestone points a household week (Mon–Sun)
  instant_day        int not null default 2 check (instant_day between 0 and 10),             -- instant rewards he may cash a day
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
  dropped_at timestamptz,                       -- set by the tidy trigger when status becomes 'dropped' (§13.3 counts from it)
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
  check ((status = 'dropped') = (dropped_at is not null)),
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
  result        text check (result in ('done', 'more', 'stopped', 'time', 'expired')),   -- time: the ring ran out, his answer to come
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
  instant    boolean not null default false,     -- he cashes it on the spot (no parent's yes), at most instant_day a day
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
  status     text not null default 'waiting' check (status in ('waiting', 'approved', 'declined', 'cancelled', 'cashed')),
                                                -- cashed: an instant reward he took on the spot (decided at once, by him)
  asked_at   timestamptz not null,
  decided_at timestamptz,
  decided_by text,
  note       text check (note is null or char_length(note) between 1 and 120)   -- a parent's word with a decline
);
create unique index reward_asks_waiting on public.reward_asks (kid_id, reward_id) where status = 'waiting';
create index reward_asks_kid on public.reward_asks (kid_id, asked_at desc);

-- Every point earned, given, voided and traded. Rows are never changed; the only deletes are a
-- milestone check taken back within 15 minutes (a mis-tap), and the half a milestone paid at his
-- tick when he unticks it himself.
create table public.points_ledger (
  id         uuid primary key default gen_random_uuid(),   -- given points: the parent's page's key
  kid_id     uuid not null references public.homework_kids (kid_id) on delete cascade,
  at         timestamptz not null,              -- private.now()
  day        date not null,                     -- the household's day it counts for: a block's start day for focus and on_time
  kind       text not null check (kind in ('focus', 'on_time', 'milestone_done', 'milestone', 'given', 'void', 'trade')),
                                                -- milestone_done: half a milestone, at his tick; milestone: the rest, at the check
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
create unique index points_milestone_done_once on public.points_ledger (step_id) where kind = 'milestone_done';
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
```
- `homework_kids`: one row per kid with homework on, made by `save_homework_kid`, removed (with everything that cascades from it) by `erase_homework`. Triggers `homework_kids_stamp` (`private.stamp()`) and `homework_kids_tidy` (`private.homework_kids_tidy()`: his cue and if-stuck line through `private.clean_text`, one line, at most 120 characters, `''` becomes null). RLS: members select, admins update.
- `homework_times`: which repeating events are a kid's homework time (made by `add_homework_time`; the event itself is changed on the Calendar page, and deleting it removes the link). Index `homework_times_kid` on `(kid_id)`. RLS: members select, admins insert and delete.
- `tutor_links`: index `tutor_links_kid` on `(kid_id)`. Triggers `tutor_links_stamp` (insert) and `tutor_links_stamp_change` (an update that changes anything but `last_used_at`), both `private.stamp()`, so a read through the link never changes `updated_at`; and `tutor_links_tidy` (the label on one line, at most 60). RLS: admins select (the token is the link); writes go through `save_tutor_link` and `new_tutor_token`.
- `assignments`: index `assignments_kid` on `(kid_id, status, due_date)`. Triggers `assignments_stamp` and `assignments_tidy` (title and class on one line, the teacher's text through `private.clean_block`, which keeps its line breaks, the stretch question on one line, `''` becomes null; `done_at` and `dropped_at` follow `status`). RLS: members select, admins insert, update and delete.
- `homework_steps`: indexes `homework_steps_assignment` on `(assignment_id, pos)` and `homework_steps_open_day` on `(day)` where it is not done. No stamp trigger: `private.plan_save` and `private.step_act` set `updated_at` and `updated_by`. RLS: members select; no write policy.
- `focus_sessions`: the unique index `focus_sessions_open` on `(kid_id)` where it is still open (one block at a time), and `focus_sessions_kid` on `(kid_id, started_at desc)`. RLS: members select; no write policy.
- `rewards`: triggers `rewards_stamp` and `rewards_tidy` (the title on one line, at most 60). RLS: members select, admins insert, update and delete.
- `reward_asks`: the unique index `reward_asks_waiting` on `(kid_id, reward_id)` while waiting, and `reward_asks_kid` on `(kid_id, asked_at desc)`. RLS: members select; no write policy.
- `points_ledger`: each focus block, each day's on-time start, each milestone's two halves (`milestone_done` at his tick, `milestone` at the check) and each void is paid once (unique indexes `points_focus_once`, `points_on_time_once`, `points_milestone_done_once`, `points_milestone_once`, `points_void_once`), and `points_ledger_kid` on `(kid_id, at desc)`. Rows are never changed; the only deletes are a milestone check taken back within 15 minutes, and the half his tick paid when he unticks it himself. RLS: members select; no write policy.
- `homework_use`: RLS on, no policies and no privileges (`revoke all … from public, anon, authenticated, service_role`): only `private.count_homework` (a definer function) writes and reads it, as `my_day_use` (§9).
- `ai_runs`: one row per AI request, never the prompt or the answer. Indexes `ai_runs_started` on `(started_at)` and `ai_runs_assignment` on `(assignment_id, started_at)`. RLS: admins select; `homework_ai_start` and `homework_ai_finish` write.
- `household`'s three columns follow its policies (members read, admins update). The trigger `household_homework_check` (`private.household_homework_check()`, plain SQL and no other function, as it runs as the parent who saves) refuses a never-send word that isn't 2 to 40 characters on one line (22023 "Words never to send: each 2 to 40 characters, one line.") and the AI turned on with no such word (22023 "Add the school's name to Words never to send first.").
- Grants: all eleven start from `revoke all … from public, anon, authenticated`. Signed-in users then get select on all but `homework_use` (row-level security decides: `tutor_links` and `ai_runs` are the parents' only); update of `active, points_on, focus_minutes, pts_focus, pts_on_time, pts_milestone, pts_day_cap, pts_milestone_week, instant_day` on `homework_kids` (never `cue` or `if_stuck`, which are his); insert of `event_id, kid_id` and delete on `homework_times`; insert of `kid_id, kind, title, subject, due_date, details, stretch, status`, update of the same less `kid_id`, and delete on `assignments` (never `added_by`, `given_*`, `plan_rev`, `done_at`, the AI's columns or the audit columns); and insert of `kid_id, title, cost, active, instant, sort_order`, update of the same less `kid_id`, and delete on `rewards`. Steps, blocks, asks, points and AI runs have no write grant at all. Anon has no privilege on any of them. service_role keeps the defaults on all but `homework_use`.

### Functions
Page read (`authenticated`; STABLE, SECURITY INVOKER, so row-level security decides and a non-member gets empty days):
- `homework_week(p_kid uuid, p_from date, p_days int default 14)` returns jsonb: `p_days` days (1 to 56) from `p_from`, `[{day, window: {starts, ends} | null, busy: [{starts, ends, title}], free, planned, over}]` (`docs/v1.3-homework.md` §5): the day's homework time, what blocks it, its free minutes, the minutes of not-done steps planned on it in his open assignments, and how much planned is more than free. Busy titles are the members' own events, which they can read anyway.

Signed-in actions (`authenticated` only; SECURITY DEFINER unless said, in `public` because the page calls them; each raises 42501 "Only a parent can change homework." unless `private.is_admin()`, so an adult's page is read-only):
- `save_homework_kid(p_kid uuid, p_active boolean)` returns void: makes the row for an active person with role kid (22023 "Homework is for kids." otherwise), or turns it on or off. Off deletes nothing.
- `add_homework_time(p_kid uuid, p_weekdays int[], p_start time, p_end time)` returns uuid (the event's id): SECURITY INVOKER. One weekly event in his name, titled `private.homework_word('homework', <his language>)`, on the ISO weekdays `p_weekdays` (1 = Monday to 7 = Sunday, as `events.repeat_weekdays`), from `p_start` to `p_end` (after it, at most 4 hours), skipping days off, starting on the first day from today on one of those weekdays; and its `homework_times` row.
- `save_homework_plan(p_assignment uuid, p_steps jsonb, p_rev int, p_give boolean default false)` returns jsonb → `private.plan_save` as the family. `p_rev` is required (0 for a first plan).
- `homework_step(p_step uuid, p_action text, p_text text default null)` returns jsonb → `private.step_act` as the family: `'check'`, `'not_yet'`, `'uncheck'`, `'answer'`, `'clear'`, `'done'`, `'undo'`.
- `decide_reward(p_ask uuid, p_approve boolean, p_note text default null)` returns jsonb `{ask, balance}`: Yes checks his free points again, under his `homework_kids` row's lock (as every writer of his balance), and writes a `'trade'` of −cost; Not now takes nothing and can carry a word he sees (at most 120). An ask already decided answers as it is.
- `give_points(p_kid uuid, p_points int, p_note text, p_key uuid)` returns jsonb: 1 to 200, with a note he sees; `p_key` is the ledger row's id, so a resend writes nothing more. Refused while points are off.
- `void_points(p_entry uuid, p_note text)` returns jsonb: one `focus`, `on_time`, `milestone_done`, `milestone` or `given` entry gets a `'void'` of the same size with a reason he sees; refused when it would take his balance below zero ("Those points are already spent.").
- `save_tutor_link(p_link uuid, p_kid uuid, p_label text, p_language text, p_expires_on date, p_can_ai boolean, p_active boolean)` returns uuid: makes (`p_link` null) or changes a link. At most 3 per kid; the end date from today to today + 400 (a change may keep the link's own end date, even a past one: Off, On or a new name on a link that has ended), null meaning today + 180.
- `new_tutor_token(p_link uuid)` returns void: a new token; the old link stops at once.
- `homework_ai_preview(p_assignment uuid, p_kind text default 'plan', p_request text default null, p_answers text[] default null)` returns text: exactly the message the AI would get (`private.ai_input`'s `message`, as a parent asks), the same text `homework_ai_start` hands `hub-jobs`; no run, nothing counted.
- `homework_ai_draft(p_assignment uuid, p_action text)` returns jsonb `{assignment_id, changed}`: Undo (`'undo'`: `ai_prev` back as the draft, one level, with its own time) or Dismiss (`'dismiss'`: the draft, the one before it, its time, and its state unless a run is open, cleared) on an assignment's AI draft (`docs/v1.3-homework.md` §6.10), so either sticks; nothing to undo or dismiss changes nothing. Pat's link does the same with `tutor_assignment_by_token`'s `ai` field.
- `erase_homework(p_kid uuid, p_confirm text)` returns jsonb: with `p_confirm = 'ERASE'`, deletes his `homework_kids` row and so everything that cascades from it (assignments, steps, blocks, points, rewards, asks, tutor links, AI run records, the homework-time links), and his and his links' counts. The homework-time events stay on the calendar. Answers the counts.

My day and the tutor link (`anon`, `authenticated`; SECURITY DEFINER): the seven `homework_by_token`, `step_by_token`, `plan_by_token`, `focus_by_token`, `reward_by_token`, `assignment_by_token`, `homework_prefs_by_token`, and the tutor link's four `tutor_view_by_token`, `tutor_assignment_by_token`, `tutor_plan_by_token`, `tutor_step_by_token`, with their signatures in §3 "Anonymous token functions". The seven start from `private.homework_kid_by_token(p_token)` and the four from `private.tutor_link_by_token(p_token)`: no match is null. Every writer then counts the call (`private.count_homework`), trims (`private.homework_trim`), writes as "<name> (My day)" or "<label> (tutor link)", and answers its own keys merged into the view (`private.homework_view_kid` or `private.homework_view_tutor`). Text over its limit is refused with 22023 before anything is counted, and a resend (a write that finds its own earlier work) changes nothing and isn't counted. A constraint a write would break answers 22023 "That can't be saved." with no detail: PostgREST would hand the caller the constraint's DETAIL, which is the whole row (a parent's email in it).

`hub-jobs` (`service_role` only; SECURITY DEFINER; nothing calls them until the AI planner's PR):
- `homework_ai_start(p_token text, p_email text, p_assignment uuid, p_kind text, p_request text, p_answers text[], p_key uuid)` returns jsonb: who first (the tutor link's token with `can_ai`, or an admin's email, never both; anyone else `{stop: 'not_found'}`), then, with the household row locked, the sweep, a resend's run, the switch, a run still open (`busy`), the caps (`cap`, `month`), and the new run: `{run_id, input}` (`docs/v1.3-homework.md` §6.3).
- `homework_ai_finish(p_run uuid, p_stop text, p_draft jsonb, p_usage jsonb, p_model text)` returns jsonb: only a run still running inside its lease (else `{stop: 'late'}`); a failure's fixed code, or the draft checked again in SQL, placed, and stored as the assignment's `ai_draft` (the one before it in `ai_prev`) (§6.8 there).

Replaced, with the same signatures (`create or replace`, so they keep their grants):
- `hub_schema_version()` returns 5.
- `get_person_day(p_token text)`: 0004's body plus one top-level key, `homework`, left out unless the person is a kid with homework on, so with homework off for everyone it is exactly 0004's answer: the card from `private.homework_card` (the next step, today's steps and minutes, his homework time, a block running or one whose answer is still due, his points and the next-reward bar). Its lines are marked "v1.3" in the body.

New in private (revoked from public and anon; "nobody" means also from authenticated, so only the definer functions above call them):
- `private.homework_word(p_key text, p_lang text)`: v1.3's fixed words ("Homework" / "Tarea", "Turn it in" / "Entregarlo"), falling back to `private.food_word`, and so to `calendar_word` and `word`, all unchanged. IMMUTABLE. Authenticated, service_role (`add_homework_time` runs as the parent).
- `private.clean_block(p_text text, p_max int)`: as `private.clean_text(p_text, p_max)`, but keeps line breaks (each line cleaned on its own, never two blank lines in a row, at most 60 lines). IMMUTABLE. Authenticated, service_role (the tidy trigger runs as the parent who saves).
- `private.homework_kid_by_token(p_token text)` returns `public.people`: `private.person_by_token`, plus role kid and an active `homework_kids` row; else a null row. STABLE, definer. Nobody.
- `private.tutor_link_by_token(p_token text)` returns `public.tutor_links`: the link that is on, not past its end date, whose kid is active, a kid and has homework on; else a null row. Sets `last_used_at` (to the minute) when it is older than a minute. Definer. Nobody.
- `private.count_homework(p_actor uuid, p_what text, p_max int)` returns void: one more `'writes'` or `'starts'` for the kid or the link today in `homework_use` (an upsert, whose row lock queues parallel calls, so the count is exact); past `p_max`, P0001 "That's a lot for one day.". Rows older than 2 days go. Definer. Nobody.
- `private.free_minutes(p_kid uuid, p_from date, p_to date, p_except uuid)` returns table `(day date, starts time, ends time, window_minutes int, free int, planned int, busy jsonb, first_free time)`: his homework time per day (`p_to` cut to `p_from + 55`, inside `agenda`'s 62 days) less what blocks it (his timed events and tasks, the Google events on his day, 15 minutes after one that ends inside it; all-day items and the homework-time events don't block), the minutes planned in his other open assignments (all but `p_except`), and the first free minute (the on-time window is around it). STABLE, with the caller's rights. Authenticated, service_role (`homework_week` runs as the member).
- `private.place_steps(p_kid uuid, p_assignment uuid, p_due date, p_steps jsonb)` returns jsonb: the one placement rule (`docs/v1.3-homework.md` §5.4), `{steps, fits, over, horizon, minutes_left, time_left}`, or `{fits: false, no_time: true}` with no homework time. STABLE. Nobody.
- `private.plan_check(p_steps jsonb, p_due date, p_ai boolean)` returns jsonb: a plan's shape (§4.2 there), every text through `clean_text`; 22023 with a fixed message, or the cleaned steps. IMMUTABLE. Nobody.
- `private.plan_save(p_assignment uuid, p_steps jsonb, p_give boolean, p_rev int, p_role text, p_who text)` returns jsonb: the one save rule for parents, the tutor and the kid, and Re-plan (`p_steps` null); P0001 "This plan was changed since you opened it." on an old `p_rev`. Nobody.
- `private.step_act(p_step uuid, p_action text, p_text text, p_day date, p_key uuid, p_role text, p_who text)` returns jsonb: the one step rule: ticks, Undo, Not today, checks with notes, Not yet, questions, answers, Make it smaller, and milestone points. Nobody.
- `private.award(p_kid uuid, p_kind text, p_delta int, p_day date, p_session uuid, p_step uuid, p_ask uuid, p_void_of uuid, p_note text, p_who text)` returns int: one ledger row, paid once, within the day's cap (`focus` and `on_time`) or the week's (`milestone_done` and `milestone` together); nothing earned or given while points are off. Answers the points written. Nobody.
- `private.points_balance(p_kid uuid, out balance int, out held int)`: his balance and what his waiting asks hold. STABLE. Nobody.
- `private.homework_pace(p_kid uuid)` returns numeric: the median of worked ÷ planned minutes over his last 10 done steps with blocks, 0.5 to 3; null with fewer than 5. STABLE. Nobody.
- `private.focus_act(p_kid uuid, p_action text, p_session uuid, p_minutes int, p_step uuid, p_assignment uuid, p_with text, p_result text, p_note text)` returns jsonb: the timer's rules and their points (§7.1 and §8.1 there). Nobody.
- `private.ai_sweep()` returns void: every AI run still running past its lease becomes failed (`timeout`). Nobody.
- `private.ai_draft_act(p_assignment uuid, p_action text)` returns boolean: Undo or Dismiss on one assignment's AI draft, for `homework_ai_draft` and `tutor_assignment_by_token`'s `ai`, whose callers check who may; whether anything changed. Nobody.
- `private.homework_trim(p_kid uuid)` returns void: the retention rules (§13.3 there), done at writes, and `ai_sweep`. Nobody.
- `private.homework_view_kid(p_kid uuid, p_lang text)`, `private.homework_card(p_kid uuid, p_lang text)` and `private.homework_view_tutor(p_link uuid, p_assignment uuid, p_part text)` return jsonb: his view, his card and the tutor's view (§3.4 there). STABLE; the card never raises. Nobody.
- `private.scrub(p_text text, p_kid uuid)` returns text: invisible characters first, then links (with or without `https://`), emails, phone numbers, ids, titled names, the family's names (every person's, and each capitalized word of a name), the tutor links' labels (but not a label's class or role words) and the never-send words out, a phrase matched across line breaks, and `<` `>` replaced. STABLE. Nobody.
- `private.ai_input(p_assignment uuid, p_kind text, p_request text, p_answers text[], p_from text)` returns jsonb `{fields, message}`: the AI's input built from the database, and the one user message, which is also the preview; `p_from` (`'tutor'` or `'parent'`) is the role the request is wrapped with, never a name. STABLE. Nobody.
- `private.homework_kids_tidy()`, `private.assignments_tidy()`, `private.rewards_tidy()`, `private.tutor_links_tidy()` and `private.household_homework_check()`: the triggers above.

## 11. v1.3: the school feed

The build contract is `docs/v1.3-homework.md` (§11 and §12); this section lists what its migration, `supabase/migrations/0006_homework_school.sql`, adds to the database, so the docs check can hold the two together. Fresh install = `schema.sql`, then `0002` to `0006`. It is one transaction and additive (the v2 pages work the same on 5 and 6), every rule in §3 applies, and it seeds no rows: with no school link, every page, view, email and text is as on 5, and with links and items stored the email, the texts and My day still come out as on 4 (check 5d in `tests/db/run.sh`). It opens with guards, each of which changes nothing: without `hub_schema_version()` it raises "Home Hub v2 (migration 0002) isn't installed"; below 5, "Homework (migration 0005) isn't installed"; at 6 or more, "The school feed (migration 0006) is already installed"; with `school_feeds` there but the version set back to 5 (`docs/v1.3-homework.md` §16.5), "… set back to 5"; and unless `private.free_minutes`, `private.homework_view_kid`, `private.homework_view_tutor`, `private.homework_card`, `assignment_by_token` and `assignments_added_by_check` are as 0005 left them, "This database isn't as migration 0005 left it". It ends by making `hub_schema_version()` return 6. **`hub-jobs` and `cron.sql` change** (a `school` action, `school.ts` and `ical.ts`; a fifth job, `hub-school`; no new secret), so the site and `hub-jobs` go live first, then the owner applies 0006 and runs `cron.sql` again (`docs/v1.3-homework.md` §16.4). One new function for anon (§3 "Anonymous token functions"): a kid's New from school. **The address is a secret**: it is kept only in `private.school_feed_urls`, on which no API role (anon, authenticated, service_role) has any privilege; only `school_begin` (SECURITY DEFINER, service_role only) reads it, to hand it to `hub-jobs`; nothing answers or logs it, and pages see the host and its last 4 characters.

### Tables
```sql
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
  removed_at   timestamptz,                     -- Remove, while items made assignments remain: the row stays only for
                                                -- them (no address, not read, not on the status card); Add link takes it back
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
                -- md5 of 'uid:' and its UID (with its start, for schedule and games), or without one of 'title:',
                -- its class, a line break, its title and its first day (its title and its start, for schedule and games).
                -- From 0009 always the second, UID or not (Blackbaud's UIDs change every hour or two): §14
  has_uid       boolean not null,               -- from 0009 false on every row a read writes
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
  last_run_at timestamptz,
  handed      uuid[]       -- the links the run holding the lease was handed and hasn't stored yet, in order
);
create index school_items_feed_due on public.school_items (feed_id, due_date);
create index school_items_feed_start on public.school_items (feed_id, starts_at);
create index school_items_assignment on public.school_items (assignment_id);

-- An assignment made from a school item says so.
alter table public.assignments drop constraint assignments_added_by_check;
alter table public.assignments add constraint assignments_added_by_check check (added_by in ('family', 'tutor', 'kid', 'school'));
```

- Row-level security on all four. `school_feeds` and `school_items`: members select (policies "Family can see school links" and "Family can see school items"); no write grant (the functions write). `private.school_feed_urls` and `private.school_sync`: no policies, and `revoke all … from public, anon, authenticated, service_role`. service_role keeps the defaults on `school_feeds` and `school_items` (the job's functions are definers anyway).
- `school_feeds` is stamped by `private.stamp()` (`school_feeds_stamp` on insert; `school_feeds_stamp_change` on an update that changes more than the read's status: `next_at`, `last_try_at`, `last_ok_at`, `last_count`, `last_repeats`, `last_stop` and `fails`), so a read never changes `updated_at`.
- `assignments.added_by` gains `'school'`: an assignment made from a school item (Quick, Plan with Pat, a parent's Add). The views pass it through, so the pages can say "from school".
- A trigger on `homework_kids`, `homework_kids_school_due` (after an update of `active`, when homework is turned back on): `private.school_feeds_due()` makes that kid's links due now (unless a backoff has one later), so the status card doesn't call them stale at once. It is SECURITY DEFINER, since a parent may turn homework on with a plain update and `school_feeds` takes no writes.

### Functions
Page read (`authenticated`; SECURITY DEFINER, so the status card can say when the job last ran; null for anyone who isn't a member):
- `school_feed_status(p_kid uuid)` returns jsonb: `{kid_id, last_run_at, feeds: [{id, kind, host, url_end, checked, date_rule, date_shift, paused, last_try_at, last_ok_at, last_count, last_repeats, last_stop, fails, next_at, stale}], check, new, hidden, moved, gone}`: each link's status (`stale`: a link the job would read, not paused and the kid's homework on, due for over 2 hours and not read, so the job isn't running), the first-import check (an Assignments link not checked yet: its next 5 items; from 0008, §13, when fewer than 5 are still to come, the latest past ones fill it, and each item carries `past`), what is new for him, what he hid, planned assignments whose school date moved, and open ones no longer on the school site. A removed link (its row kept for the assignments made from it) isn't on it, nor its items in the check, new or hidden. Never the address.

Signed-in actions (`authenticated` only; SECURITY DEFINER; each raises 42501 "Only a parent can change homework." unless `private.is_admin()`):
- `set_school_feed(p_kid uuid, p_kind text, p_url text)` returns jsonb `{id, kind, host, url_end}`: Add link and Replace (`p_url` an address that passes `private.school_url`, else 22023 "That isn't a school calendar link. …", the same words for every way it can fail), or Remove (`p_url` null or empty: answers null, and deletes the link's address and every item no one made an assignment; assignments made from it stay. While such items remain the row stays for them, marked removed (`removed_at`; not read, not on the status card, `checked` taken back, check and pause refused), so adding the link again takes the same row and the next read finds those items by their keys; with none left, the row goes too; from 0008, §13, that row starts as not read). `p_kind` `'assignments'`, `'schedule'` or `'games'`. A new or replaced link is due to be read at once.
- `check_school_feed(p_feed uuid, p_date_rule text, p_date_shift int)` returns jsonb (the status card): the first-import check on an Assignments link: an item's due date is its first (`'start'`) or last (`'end'`) day, moved −1 to 1 days; every item's due date follows, and so do the assignments made from them that nobody changed.
- `pause_school_feed(p_feed uuid, p_paused boolean)` returns void: a paused link isn't read; its items stay. Resume makes it due now (unless a backoff has it later).
- `school_item_action(p_item uuid, p_action text)` returns jsonb `{assignment_id}` and the status card: `'add'` (make an Assignments item an assignment from school now), `'hide'` and `'show'` (off and back on his New from school).

My day (`anon`, `authenticated`; SECURITY DEFINER): `school_item_by_token(p_token text, p_item uuid, p_action text, p_minutes int default null)` (its signature in §3 "Anonymous token functions"). It starts from `private.homework_kid_by_token(p_token)`, as his seven do.

`hub-jobs` (`service_role` only; SECURITY DEFINER):
- `school_begin(p_force boolean default false)` returns jsonb `{go, stop, run_id, today, tz, feeds: [{feed_id, kind, url}]}`: takes the read job's lease (5 minutes; `{go: false, stop: 'busy'}` while another run holds it) and hands over at most 10 links that are due (next_at passed, not paused or removed, the kid active with homework on; `p_force`, a parent's Check now: every such link not read in the last minute), those reading well first, noting them in order (`private.school_sync.handed`). The only reader of the addresses. Before that, a run that died (its lease ran out with links still noted) has the first of them, the one it was reading, stored as a failed read (`'error'`, backed off), and the household's school rows are trimmed (`private.school_trim`).
- `school_store(p_run uuid, p_feed uuid, p_items jsonb, p_stop text, p_repeats int default 0)` returns jsonb `{stored, stop, kept, added, missing, gone}`: only while `p_run` holds the lease (else `{stored: false, stop: 'late'}`); it takes the link off the run's noted ones, and a removed link answers `{stored: false, stop: 'removed'}`. A failed read (`p_stop`, a fixed code; anything else is stored as `'error'`) changes only the link's status: one more failure, and the next read 1, 2, 4, then 8 hours on. A good one stores the items: what the hub uses (assignments due from today − 14 to today + 120, schedule and games items from today to today + 55), at most 400 or 2,000 (`'too_many'`, nothing applied); a read with nothing in it when 3 or more items were there is `'empty'` and not applied; an item without a UID whose date moved (one the last good read saw, inside the window, of the same class and title) keeps its row (from 0009 every item, paired nearest first across the read, never a hidden or closed row: §14); an item absent from two good reads in a row while inside the window is gone (marked; a busy item is deleted); past items nobody made an assignment are let go; then the school's changes reach the assignments made from them (`private.school_apply`). Only fixed codes are stored.
- `school_finish(p_run uuid)` returns void: the lease is free, and the run is noted; a link it was handed and didn't store (no time left) stays due and counts no failure.

Replaced, with the same signatures (`create or replace`, so they keep their grants):
- `hub_schema_version()` returns 6.
- `private.free_minutes(p_kid uuid, p_from date, p_to date, p_except uuid)`: 0005's body, plus his school schedule and games items (timed, not gone) as busy blocks, on their household day (the lines are marked "0006"). Placement, the views' bars and `homework_week` follow.

Wrapped (0005's bodies renamed, unchanged): `private.homework_view_kid` is now `private.homework_view_kid_v5`, `private.homework_view_tutor` is now `private.homework_view_tutor_v5`, and `private.homework_card` is now `private.homework_card_v5`; the new `private.homework_card(p_kid uuid, p_lang text)` is 0005's card (which reads his view through the wrapper) plus `from_school`, how many items are new from school, left out when none; the new `private.homework_view_kid(p_kid uuid, p_lang text)` and `private.homework_view_tutor(p_link uuid, p_assignment uuid, p_part text)` call them and add the school's marks (`school: {gone, moved_to}`) to each assignment made from school, and his view `from_school` (his New from school) once he has a checked Assignments link. Without a school link all three answer exactly as 0005's (`tests/db/run.sh` step 5e). As for the `_v3` bodies, a later change to a wrapped function replaces the wrapper and its `_v5` body together. Nobody may call any of them.

New in private (revoked from public, anon and authenticated; only the definer functions above call them):
- `private.school_host_suffix()` returns text: `'.myschoolapp.com'`, the hosts a link may name (the database tests replace it). IMMUTABLE.
- `private.school_url(p_url text)` returns text: the address check (webcal:// to https://; https only, port 443, no user info, the host suffix, the path `/podium/feed/iCal.aspx`, a z value, at most 500 characters), as the link is kept, or null. STABLE.
- `private.safe_instant(s text)` returns timestamptz: an ISO 8601 instant with Z or an offset, or null. IMMUTABLE.
- `private.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)` returns table: one read's items cleaned, keyed and inside the window, a repeated key's last one. STABLE. (Replaced by 0009: never keyed by a UID, §14.)
- `private.school_assignment(p_item uuid, p_who text)` returns uuid: an assignment from a school item, noted on the item.
- `private.school_apply(p_feed uuid)` returns int: the school's changes into the open assignments made from a link's items, a field at a time, never one a person changed.
- `private.school_marks(p_kid uuid)` returns jsonb: the marks above, by assignment id. STABLE.
- `private.school_new(p_kid uuid)` returns jsonb: his New from school (at most 20, due from today to today + 30), or null with no checked Assignments link. STABLE.
- `private.school_failed(p_feed uuid, p_stop text)` returns void: one failed read of a link (its fixed code, one more failure, the backoff). `school_store` and `school_begin` call it.
- `private.school_trim()` returns void: the school rows' retention for the household, whatever a link's state: an item's description and the copy in `applied` emptied 30 days after its due date; past items nobody made an assignment deleted (assignments due before today − 14, busy time that ended); a removed link's row once no item is left. `school_begin` calls it.
- `private.school_feeds_due()` returns trigger: the trigger above. SECURITY DEFINER.

## 12. v1.3: the coach view

The build contract is `docs/v1.3-homework.md` §20; this section lists what its migration, `supabase/migrations/0007_homework_coach.sql`, adds to the database, so the docs check can hold the two together. Fresh install = `schema.sql`, then `0002` to `0007`. It is one transaction and additive, every rule in §3 applies, and it seeds no rows: it leaves the coach view off on every link, and with it off every page, view, email and text is as on 6.

### Tables
```sql
-- The coach view: off until a parent turns it on for this link (set_tutor_coach).
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

-- Who was in charge when the hub wrote it, so the coach view never takes someone else's days for his.
-- The default is only for the rows already there (0007's time): it is dropped at once.
alter table public.task_log
  add column responsible_id uuid references public.people (id) on delete set null;
alter table public.tasks
  add column responsible_changed_at timestamptz default now();
alter table public.events
  add column people_changed_at timestamptz default now();
alter table public.tasks alter column responsible_changed_at drop default;
alter table public.events alter column people_changed_at drop default;
```

- `task_log.responsible_id` is the task's person in charge as the entry is written (the trigger `task_log_in_charge`, before insert, SECURITY DEFINER: whatever the entry is given); null on the entries from before 0007. `tasks.responsible_changed_at` and `events.people_changed_at` are when the person in charge last changed (for an event with nobody in charge before and after, its people, as a set): the triggers `tasks_in_charge_since` and `events_people_since` (before update) set `private.now()` then and otherwise keep the row's time, whatever a save sends; a new row keeps what it is given (none, or a row put back with Undo). The tasks and events already there take 0007's time, without a save. Nothing else reads them.
- Row-level security on `coach_notes`: the parents select (policy "Parents can see the coach's notes"); `revoke all … from public, anon, authenticated`, then `grant select … to authenticated`; no write grant (the functions write). service_role keeps the defaults, as on 0005's tables.
- `tutor_links` keeps its grants (the parents read it; no update grant), so `set_tutor_coach` is the only way to change `coach`; its stamp trigger stamps the change. New link, Off, On, Extend and a new name keep the switch.

### Functions
The tutor link (`anon`, `authenticated`; SECURITY DEFINER): `coach_view_by_token(p_token text)` and `coach_note_by_token(p_token text, p_key uuid, p_note text)` (their signatures in §3 "Anonymous token functions"). Each starts from `private.tutor_link_by_token(p_token)`, as the tutor link's four do, and answers null when the link's coach view is off.

Signed-in actions (`authenticated` only; SECURITY DEFINER; each raises 42501 "Only a parent can change homework." unless `private.is_admin()`):
- `set_tutor_coach(p_link uuid, p_coach boolean)` returns void: the coach view on or off for one link, at once (22023 "That link is gone.", "Choose on or off.").
- `coach_note_done(p_note uuid)` returns void: Done on a coach's note; a second Done changes nothing (22023 "That note is gone." for an unknown one).

New in private (revoked from public, anon and authenticated; only the two token functions call the first, and the other three are triggers):
- `private.coach_view(p_link uuid)` returns jsonb: the coach view (`docs/v1.3-homework.md` §20.3), null for a link whose coach view is off. "His own" calendar is the events of `agenda` that day that he is in charge of, or that have nobody in charge and him as the only one on them (not a day that began before the series last changed hands, `events.people_changed_at`, unless that day's own change made it his), and the Google events `private.google_for` puts in his charge; his daily tasks are his open tasks of `agenda` and his late ones, and only the history the hub wrote while he was in charge (`task_log.responsible_id`: done, skipped, and missed for a day after `tasks.responsible_changed_at`); private and health tasks are "Private item". STABLE.
- `private.task_log_in_charge()` (SECURITY DEFINER), `private.tasks_in_charge_since()` and `private.events_people_since()`, each `returns trigger`: the three stamp triggers above.

Replaced, with the same signatures (`create or replace`, so they keep their grants); each is 0006's wrapper with one marked part, and 0005's `_v5` bodies aren't touched:
- `private.homework_view_tutor(p_link uuid, p_assignment uuid, p_part text)`: `coach: true` for a link with the coach view on (not for the AI poll).
- `private.homework_view_kid(p_kid uuid, p_lang text)`: `me.coach`, the first word of the label of his first tutor link with the coach view on, so his screen can say what it sees.
- `hub_schema_version()` returns 7.

## 13. v1.3: the first-import check's past items

The build contract is `docs/v1.3-homework.md` §11.2 step 7 and §12.8; this section lists what its migration, `supabase/migrations/0008_school_check.sql`, changes in the database. Fresh install = `schema.sql`, then `0002` to `0008`. It is one transaction; it refuses to run without 0007 (`hub_schema_version() < 7`: "The coach view (migration 0007) isn't installed"), twice ("already installed"), or on a database that isn't as 0007 left it (`coach_notes`, `school_feed_status(uuid)` and `set_school_feed(uuid, text, text)` returning jsonb, `today_local`, `private.now`, `private.is_member`, `private.is_admin`, `private.school_url`, `private.school_feed_urls`, and the columns it reads on `school_items`, `school_feeds`, `private.school_sync`, `private.school_feed_urls`, `homework_kids`, `people` and `assignments`). It adds no table, column or row, so row-level security is as 0007 left it.

### Functions
Replaced, with the same signature:
- `school_feed_status(p_kid uuid)` returns jsonb (§11): every key exactly as 0006 made it but `check`, which is now `[{id, title, subject, first_day, last_day, due_date, past}]`. It is still there only for an Assignments link that isn't removed and isn't checked (else `[]`), and holds up to 5 of its items still on the school site (`gone_at` null), chosen as: the ones to come (`due_date >= today_local()`), earliest first; when fewer than 5 are to come, the most recent past ones (`due_date < today`), latest first, fill it. The chosen ones are answered in date order (`due_date, title, id`), each with `past` (`due_date < today`). With 5 or more to come it is 0006's check, with `past: false` on each. Still SECURITY DEFINER, STABLE, `set search_path = ''`, null for anyone who isn't a member; `revoke execute … from public, anon, service_role` and `grant execute … to authenticated` again, as 0006 does.
- `set_school_feed(p_kid uuid, p_kind text, p_url text)` returns jsonb (§11): exactly as 0006 made it, but Add link on a removed row (Remove kept it for the assignments made from it) starts it as a new link, not read yet: its on-conflict update also sets `last_try_at`, `last_ok_at`, `last_count` and `last_repeats` to null when the row was removed (`removed_at` not null), and keeps them on Replace of a live link. So the status card no longer shows the old link's last read for a link nothing has been read from, and Check now reads it at once. Still SECURITY DEFINER, `set search_path = ''`, parents only (42501 for anyone else); `revoke execute … from public, anon, service_role` and `grant execute … to authenticated` again, as 0006 does.
- `hub_schema_version()` returns 8. The pages take every version up to 99 and none asks for anything new on 8: the Homework page reads the check the same way on 7 (no `past`, and `[]` when everything is past) and on 8.

Undoing it isn't needed (the answer is a superset of 7's, the page reads both, and a link added again that starts as not read is read within the hour). If wanted, in one go: 0006's `create function public.school_feed_status(p_kid uuid)` and `create function public.set_school_feed(p_kid uuid, p_kind text, p_url text)` blocks again, each to its `$$;`, with `create or replace`, and `hub_schema_version()` returning 7 (`docs/v1.3-homework.md` §16.7). 0008 can then run again.

## 14. v1.3: the school items' keys

The build contract is `docs/v1.3-homework.md` §2.8, §11.3 and §12 item 9; this section lists what its migration, `supabase/migrations/0009_school_keys.sql`, changes in the database. Fresh install = `schema.sql`, then `0002` to `0009`. It is one transaction; it refuses to run without 0008 (`hub_schema_version() < 8`: "The first-import check (migration 0008) isn't installed"), twice ("already installed"), or on a database that isn't as 0008 left it (`private.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)` returning a set of records, `school_store(p_run uuid, p_feed uuid, p_items jsonb, p_stop text, p_repeats int default 0)`, `private.clean_text`, `private.clean_block`, `private.safe_date`, `private.safe_instant`, `private.tz`, `school_store`'s helpers (`private.school_failed`, `private.school_apply`, `public.today_local`, `private.now`), `private.school_sync` and its lease columns, the `school_items` columns it rekeys and reads, the `school_feeds` columns `school_store` reads, `assignments.id` and `status`, and `school_items`' unique `(feed_id, key)`). After that check it locks `private.school_sync`, `public.school_feeds` and `public.school_items` in exclusive mode until it commits (writes wait, plain reads don't; `school_sync` first, as `school_begin` and `school_store` write it first): a read or an item action under way finishes first and the rekey sees it, and one that starts meanwhile waits, then keys its items the new way. No table or column changes, so row-level security is as 0008 left it. Why: Blackbaud makes its feeds again every hour or two and every event then has a new UID (on the live database, 2026-10-31: 54 rows for an Assignments link's 18 assignments, three sets of keys, the first marked gone; 570 for a Schedule link's 285 classes), and 0006 keyed an item with a UID by it, its moved-date step taking only items without one.

### Functions
Replaced, with the same signature:
- `private.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)` returns table (§11): every item keyed as 0006 keys one without a UID, `md5('title:' || lower(coalesce(subject, '')) || E'\n' || lower(title) || '|' || to_char(first_day, 'YYYY-MM-DD'))` for an assignment and `md5('title:' || lower(title) || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'))` for a schedule or games item, and `has_uid` false on every row; the uid is no longer read; everything else exactly as 0006 made it. STABLE, not a definer, `set search_path = ''`; revoked from public, anon and authenticated, as 0006 revoked it (0009 revokes it again). So `school_store`'s moved-date step (an Assignments item `not has_uid`, of the same class and title, that the last good read saw and this one doesn't, takes the new key) covers every item, and a due date the school moves keeps the row and its assignment, whatever the UIDs. A title the school rewords is a new item; two of one class with the same title on the same first day are one, and so are two classes the hub reads as one (a section and a block left out of the class: "Music - Band (A)" and "Music - Choir (B)" are both Music) with the same title on the same first day: the last in the read wins.
- `school_store(p_run uuid, p_feed uuid, p_items jsonb, p_stop text, p_repeats int default 0)` returns jsonb (§11), for its moved-date step alone; everything else exactly as 0006 made it. The step reads every (new key, old row) pair of one class and title once and takes them fewest days apart first (then the feed's order, then the oldest row), skipping a pair whose row or key was taken already, so a moved date takes the nearest new one whatever the feed lists first; and it never moves a row that is `hidden`, or one made an assignment that isn't `open` (or was deleted since): without a UID, an item deleted and another of that class and title added in one read looks like a move, and moving such a row would hide the new item. A definer, `set search_path = ''`; revoked from public, anon and authenticated and granted to service_role, as 0006 does (0009 does both again).
- `hub_schema_version()` returns 9. The pages take every version up to 99 and none asks for anything new on 9.

New:
- `private.school_rekey()` returns int: run once by 0009, in its transaction (and only by the owner after that: run again it changes nothing). Every `school_items` row on the key `school_rows` gives it, computed from its stored `subject`, `title` and `first_day` (an Assignments link's) or `title` and `starts_at` (a Schedule or Games link's), and `has_uid` false. Of one link's rows with the same key one stays, chosen in this order: the one made an assignment (`assignment_id`); else one made one once (`made_at`, its assignment deleted since: never new again); else one hidden; else one still on the school site (`gone_at` null); else the latest `last_seen_at`; then by id. It takes `hidden` if any copy had it, the earliest `first_seen_at` and the latest `last_seen_at`, and, if any copy was in the link's last good read (`last_seen_at >= school_feeds.last_ok_at`), `missing` 0 and `gone_at` null; else its own. The others are deleted, but never a row made an assignment: when a group has two or more of those, the one already on the key stays if there is one (else as above), and each other stays on its old key, unchanged, so the next reads mark it missing and then gone, and its assignment "no longer on the school site" (a copy the parents can delete). Answers how many rows it deleted. Not a definer, `set search_path = ''`; revoked from public, anon, authenticated and service_role.

Undoing it isn't needed (nothing on the pages changes). If wanted, in one go: 0006's `create function private.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)` and `create function public.school_store(p_run uuid, p_feed uuid, p_items jsonb, p_stop text, p_repeats int default 0)` blocks again, each to its `$$;`, with `create or replace`, and `hub_schema_version()` returning 8 (`docs/v1.3-homework.md` §16.9). The rekeyed rows then change once more at the next read, and every change of UIDs adds them again, as before 0009; `private.school_rekey` can stay. 0009 can then run again.

## 15. v1.1: Hearth people (a shared calendar sorted by Hearth person)

The build contract is `docs/v1.1-google-calendar.md` §11; this section lists what its migration, `supabase/migrations/0010_hearth_people.sql`, adds to the database, so the docs check can hold the two together. Fresh install = `schema.sql`, then `0002` to `0010`. It is one transaction and additive, and every rule in §3 applies. It refuses to run without 0009 (`hub_schema_version() < 9`: "The school items' keys (migration 0009) aren't installed"), twice ("Hearth people (migration 0010) is already installed"), on a database set back to 9 (`hearth_tags` already there: "… was set back to 9"), or on a database that isn't as 0009 left it (`calendars`' `kind`, `person_id`, `writes`, `for_kids`, `google_id` and `read_at` and no `sort_by_guest`; `google_events`' 14 columns of §8 and nothing else; `calendar_read_due` answering 8 columns; `private.google_item`, `private.google_for`, `private.calendars_tidy`, `calendar_store_events`, `private.active_person`, `private.is_admin`, `private.is_member`, `private.now`, `current_email`, `private.free_minutes` and `private.coach_view` with their arguments; none of its own three functions yet), or while a calendar run holds the lease ("A calendar run is under way. Try again in a minute."; it first locks `calendar_sync` in exclusive mode, so a run that begins meanwhile waits for its commit). It leaves the switch off on every calendar, so with nothing sorted every page, email, text and view answers exactly as on 9. Nothing new for anon; the only new SECURITY DEFINER function is `set_hearth_tag`.

### Tables
```sql
-- "Sort by Hearth person": only on a calendar the hub reads as Family, and never with Show to kids (the matches
-- replace it). private.calendars_tidy keeps both.
alter table public.calendars
  add column sort_by_guest boolean not null default false
    check (not sort_by_guest or (kind = 'family' and not writes))
    check (not (sort_by_guest and for_kids));

-- A cached event's Hearth tags: private.hearth_tag's answers, distinct, sorted, at most 16; '{}' on every calendar
-- without the switch (calendar_store_events).
alter table public.google_events
  add column guests text[] not null default '{}' check (cardinality(guests) <= 16);

-- The Hearth people seen on a sorted calendar, and what a parent matched each to.
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
```

- `calendars.sort_by_guest`: signed-in users may update it (`grant update (sort_by_guest)`; row-level security lets only admins, as for `for_kids`), never insert it. The tidy trigger (below) keeps it on a read-only Family row only.
- `google_events.guests`: members read it with the row (row-level security decides); only hub-jobs writes it, through `calendar_store_events`.
- Row-level security on `hearth_tags`: members select (policy "Family can see the Hearth people"); no write policy. `revoke all … from public, anon, authenticated`, then `grant select … to authenticated`; service_role keeps Supabase's default privileges, which it needs: `calendar_store_events` runs as it. Written only by `calendar_store_events` and `set_hearth_tag`. Disconnect deletes a calendar's tags with it; a new Google ID keeps them (a tag names a Hearth profile, not a Google calendar); `remove_person` sets `person_id` null and keeps `matched_to` 'person'.
- **What one tag reaches:** matched to a person on the family list (`private.active_person`), that person; to Family (`'family'`), every kid and every parent's and adult's email (never a helper); anything else (`'grown_ups'`, New, not listed, or a person off the family list or removed), the grown-ups (every parent's and adult's email and their days on Today; never a My day or a text). An event goes to everyone its tags reach; one with no tag is the grown-ups'.

### Functions
New:
- `set_hearth_tag(p_id uuid, p_to text, p_person uuid default null)` returns jsonb: the parents match one tag of a sorted calendar to a person on the family list (`'person'`, with `p_person`), to Family (`'family'`) or to the grown-ups (`'grown_ups'`), setting `matched_to`, `person_id`, `matched_at` (`private.now()`) and `matched_by` (`current_email()`), and answers `{id, name, to, person_id}`; or forgets it (`'forget'`: the row is deleted, answers `{id, name, to}`, and the next read with guests lists the tag again as New). It locks the row. Works at once. Refuses 42501 "Only a parent can match Hearth people." unless `private.is_admin()`; 22023 "Choose a person, Family or the grown-ups." for any other `p_to`; 22023 "That Hearth person isn't there any more." for an unknown `p_id`; 22023 "Turn on Sort by Hearth person first." while its calendar's switch is off; 22023 "Choose someone on the family list." for `'person'` with `p_person` null, unknown or not active. SECURITY DEFINER; revoked from public, anon and service_role; granted to authenticated.
- `private.hearth_tag(p_email text)` returns text: `lower(btrim(p_email))` when it matches `^[a-z0-9._+-]{1,64}@team-[a-z0-9-]{1,120}$` (Hearth's `<profile>@team-<family>-<digits>`), else null. IMMUTABLE. Revoked from public, anon and authenticated; granted to service_role (`calendar_store_events`).
- `private.hearth_whose(g public.google_events, c public.calendars, out people uuid[], out family boolean, out grown_ups boolean)`: for a row of a sorted calendar (read from its current Google ID), from that calendar's `hearth_tags` and the rule above: the people on the family list its tags reach, each once, in family-list order (`sort_order`, `name`, `id`); whether any tag reaches Family; whether it has no tag or any tag that reaches the grown-ups. Any other row: `'{}'`, false, false. STABLE. A helper of `google_item` only; revoked from public and anon, granted to authenticated and service_role (`google_item` runs with a member's rights in `google_items`, `day_text` and `homework_week`).

Replaced, with the same signatures (`create or replace`, so they keep their grants), from 0003's bodies:
- `private.google_item(g, c)`: a sorted calendar's row has `responsible_id` null, `participant_ids` its `hearth_whose` people, and `category` `'family'` when a tag reaches Family, else `'grown_ups'` (new; only a sorted calendar's rows have it) when it reaches the grown-ups, else null. Every other row exactly as 0003 made it.
- `private.google_for(p_person, p_from, p_to, p_grown_up)`: 0003's rule for every other calendar; a sorted calendar's row, as `google_item` built it, reaches `p_person` when they are on it (whatever their role), or it is `'family'` and they are a kid (with `p_grown_up` false) or a parent or adult (with `p_grown_up` true), or it is `'grown_ups'`, `p_grown_up` is true and they are a parent or adult. It reads only the row's fields, as the pages do. So My day, `day_text`, `private.person_items`, `get_person_day`, `digest_for`, `private.free_minutes` (busy time), `homework_week`, the tutor's week and the coach view follow without code of their own; the coach view, which takes only Google rows its kid is in charge of, shows none of a sorted calendar's.
- `private.calendars_tidy()`: before the checks run, a calendar that isn't read-only Family gets `sort_by_guest` false (changing Whose or switching to writing turns it off); an update that turns it on sets `for_kids` false; an update after which a row is still sorted with `for_kids` true is refused, 22023 "Turn off Sort by Hearth person first."; a change of `sort_by_guest` clears `read_at` (the next run reads it first) and counts as an admin's edit (`updated_at` moves).
- `calendar_store_events(p_calendar uuid, p_google_id text, p_from date, p_to date, p_name text, p_access text, p_complete boolean, p_events jsonb, p_seen jsonb)`: 0003's, with rows built by column name. A read "with guests" is one whose `p_events` has an event with a `guests` key, or has no events. On a sorted calendar each kept event of `p_events` stores its `guests` through `private.hearth_tag`, nulls dropped, distinct, sorted, the first 16 (`'{}'` on any other calendar, and for `p_seen`'s entries); a sorted calendar's read without guests stores `'{}'` and leaves `read_at`, so it stays due. After a read with guests of a sorted calendar (not one found `no_access`), in a block of its own that can't fail the store: every tag on a kept event it doesn't list yet is added (`last_seen` now), in tag order, while it lists fewer than 50; every listed one on a kept event gets `last_seen = greatest(last_seen, now)`; and after a complete read only, its New, `'grown_ups'` and removed person's (`'person'`, `person_id` null) tags with `last_seen` over 90 days ago are deleted. Its answer is unchanged: `{kept, skipped, seen, repaired, adopted}`.
- `hub_schema_version()` returns 10. The pages ask for `hearth_tags` and `calendars.sort_by_guest` only on 10.

Dropped and made again (its answer gains a column):
- `calendar_read_due(p_force boolean default false, p_limit int default 10)` returns table `(calendar_id, google_id, writes, w_from, w_to, time_min, time_max, tz, sort_by_guest)`: 0003's, plus `sort_by_guest`, so hub-jobs asks Google for guest addresses (`attendees(email,…)`) only for a sorted calendar and keeps only Hearth-shaped ones (`calendar.ts`, §11.3). Revoked from public, anon and authenticated; granted to service_role, as 0003.

Undoing it isn't needed (with the switch off on every calendar every answer is 9's). If wanted, in one go, as the migration's header writes it out: `update public.calendars set sort_by_guest = false`; 0003's `private.google_item`, `private.google_for`, `private.calendars_tidy` and `calendar_store_events` blocks again with `create or replace`; `calendar_read_due` dropped and made again from 0003's block, with 0003's revoke and grant; drop `set_hearth_tag`, `private.hearth_whose` and `private.hearth_tag`; drop table `hearth_tags`; drop the columns `google_events.guests` and `calendars.sort_by_guest`; `hub_schema_version()` returning 9 (`docs/v1.1-google-calendar.md` §11.9). 0010 can then run again.

## 16. v1.4: project guests

The build contract is `docs/v1.4-project-guests.md`; this section lists what its migration, `supabase/migrations/0011_project_guests.sql`, adds to the database, so the docs check can hold the two together. Fresh install = `schema.sql`, then `0002` to `0011`. It is one transaction and additive, and every rule in §3 applies. It refuses to run without 0010 (`hub_schema_version() < 10`: "Hearth people (migration 0010) isn't installed"), twice ("Project guests (migration 0011) is already installed"), on a database set back to 10 (`guests` already there: "… was set back to 10"), or on a database that isn't as 0010 left it (`projects`' `id`, `name`, `schedule`, `owner_id`, `on_calendar`, `sharing_enabled`, `share_token` and `created_at` and no `documents_url`; `contractors`' `id`, `name`, `company`, `trade`, `phone`, `email`, `website` and `kind`; `members`, `hook_family_only_signup`, `private.is_admin`, `private.is_member`, `private.has_secrets` and `current_email`; none of its own functions yet). With no guest added every page, email and view answers exactly as on 10. Nothing new for anon.

### Tables
```sql
-- Who may sign in as a project guest. Never a member (add_project_guest refuses one).
create table public.guests (
  email      text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  name       text not null check (length(name) between 1 and 80 and name = btrim(name)),
  created_at timestamptz not null default now(),
  created_by text
);

-- Which projects each guest sees and manages.
create table public.project_guests (
  project_id  uuid not null references public.projects (id) on delete cascade,
  guest_email text not null references public.guests (email) on delete cascade,
  added_at    timestamptz not null default now(),
  added_by    text,
  primary key (project_id, guest_email)
);

-- The contractors a guest added to a project.
create table public.project_contacts (
  project_id    uuid not null references public.projects (id) on delete cascade,
  contractor_id uuid not null references public.contractors (id) on delete cascade,
  added_at      timestamptz not null default now(),
  added_by      text,
  primary key (project_id, contractor_id)
);

-- The project's shared folder (drawings, quotes, invoices, photos): a Google Drive address only.
alter table public.projects
  add column documents_url text
    check (documents_url is null or (length(documents_url) <= 500 and documents_url ~ '^https://drive\.google\.com/[^\s<>"'']*$'));
```

- Row-level security on the three tables: `guests` and `project_guests` admins select ("Admins can see the guests", "Admins can see who sees each project"); `project_contacts` members select ("Family can see the contractors guests added"); no write policies (only the functions below write them). `revoke all … from public, anon, authenticated`, then `grant select … to authenticated`; service_role keeps Supabase's defaults. Index `project_guests_guest_idx` on `project_guests (guest_email)`.
- `projects.documents_url`: members and a project's guests write it with the row; not on the share link (`get_shared_project` is unchanged).
- On `projects`, two more policies: "Guests see their projects" (select) and "Guests update their projects" (update), both checking `private.is_guest_of` with the row's id. No insert or delete for a guest. The trigger `projects_guest_guard` (before update, `private.projects_guest_guard()`) refuses, for a signed-in caller who isn't a member, any change to `id`, `created_at`, `owner_id`, `on_calendar`, `sharing_enabled` or `share_token` (42501 "Only the family can change the owner, the calendar switch or sharing."), and a schedule whose trades link a contractor not already on the project (42501 "Link a trade only to a contractor on this project. Add new ones under Contractors.").

### Functions
New:
- `guest_whoami()` returns jsonb: `{email, name, projects}` (the caller's project ids, oldest project first) when the signed-in address is in `guests` and not in `members`; else null. The core calls it only when `whoami()` is null. SECURITY DEFINER, STABLE.
- `guest_contacts(p_project uuid)` returns table `(id uuid, name text, company text, trade text, phone text, email text, website text, kind text, editable boolean)`: the contractors on one of the caller's projects (`private.guest_contact_ids`), by name; `editable` false when it has account details saved. Never notes, addresses or account details. Refuses 42501 "That project isn't shared with you." unless `private.is_guest_of(p_project)`. SECURITY DEFINER, STABLE.
- `guest_save_contact(p_project uuid, p_contact jsonb)` returns jsonb: the caller, a guest of the project, adds a contractor (`{name, company?, trade?, phone?, email?, website?}`: a new `contractors` row of kind `'contractor'` and a `project_contacts` row with `added_by`) or edits one on the project (`id` given) that has no account details; answers the row as `guest_contacts` does. Trims every field, lower-cases the email. Refuses 42501 "That project isn't shared with you."; 22023 for a missing or long name, a detail over 200 characters or an email that doesn't look like one; 42501 "That contractor isn't on this project."; 42501 "This contractor has account details saved, so only a parent can change them." SECURITY DEFINER.
- `add_project_guest(p_project uuid, p_email text, p_name text default null)` returns jsonb `{email, name, project_id}`: the parents give a guest a project, making the guest (with `p_name`) or renaming them, then linking the project (again: nothing changes). Refuses 42501 "Only a parent can give someone access to a project." unless `private.is_admin()`; 22023 for an address that doesn't look like one, a member's ("… already signs in as family, so they see every project."), a project that isn't there, a long name, or a new guest without a name. SECURITY DEFINER.
- `remove_project_guest(p_project uuid, p_email text)` returns boolean (whether they had it): the parents take a project away; the guest keeps their sign-in, with no projects. Refuses 42501 unless `private.is_admin()`. SECURITY DEFINER.
- `remove_guest(p_email text)` returns boolean (whether they were a guest): the parents remove a guest everywhere (the row, and with it their projects); the sign-up hook then turns the address down. A login already made stays in Supabase Auth until deleted there, and sees nothing. Refuses 42501 unless `private.is_admin()`. SECURITY DEFINER.
- `private.is_guest_of(p_project uuid)` returns boolean: the signed-in address has the project in `project_guests`. SECURITY DEFINER, STABLE; for the policies (granted to authenticated, as `private.is_member`).
- `private.schedule_contractors(p_schedule jsonb)` returns uuid[]: the contractors a schedule's trades link (`trades.<key>.contractor_id`, uuids only). IMMUTABLE; granted to authenticated.
- `private.guest_contact_ids(p_project uuid)` returns uuid[]: the contractors on a project (its schedule's links and its `project_contacts`) that are in the directory. SECURITY DEFINER, STABLE; no API role may call it.
- `private.projects_guest_guard()`: the trigger above. SECURITY DEFINER (a guest can't read `project_contacts`); no API role may call it.
Every new public function is revoked from public, anon and service_role and granted to authenticated; each checks its caller itself.

Replaced, with the same signature and grants:
- `hook_family_only_signup(event jsonb)` returns jsonb: schema.sql's body, letting an address in `members` or in `guests` make a login; anyone else gets 403 "This email is not on the family list."
- `hub_schema_version()` returns 11. The site shows a guest their projects, and the parents Guest access, the Project guests card in Settings and the documents folder, only on 11.

Undoing it isn't needed (with no guest added every answer is 10's). If wanted, in one go, as the migration's header writes it out: drop the six public functions, the trigger and its function, the two policies on `projects`, the three private helpers, the three tables and `projects.documents_url`; schema.sql's `hook_family_only_signup` block again; `hub_schema_version()` returning 10. 0011 can then run again.
