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

Later: web push, Twilio SMS.

## 1. Item model — two kinds

| Kind | Plain-language test | Examples |
|---|---|---|
| **Event** | Happens at a time; nothing to tick off | Piano (every Tue 4pm, Lorena takes Max), school pickup, dentist, "Lara away Thu–Sun" |
| **Task** | Needs doing; gets ticked off; may repeat | Heartworm pill on the 1st, furnace filter 60 days after last change, Max takes trash out Mondays, call plumber |

The Add sheet starts with an Event | Task switch and the help line *"Piano, pickups, appointments → Event. Pills, filters, chores, calls → Task."*

## 2. People, sign-in and access

- `people` is the single household list. Roles: **parent**, **adult**, **kid**, **helper**.
- Sign-in is allowed only for parents and adults in v2. A parent who can sign in is an admin (`members.role = 'admin'`); an adult who can sign in is a member. Kids and helpers never get a login; they get a **My day link**.
- The client never writes `members` directly. `save_person(p jsonb, p_can_sign_in boolean)` (admin only, SECURITY DEFINER) upserts the person and adds/updates/removes the matching `members` row in one transaction. It refuses to remove or rename the caller's own login and refuses sign-in for kids/helpers.
- The migration seeds one person per existing member (admin → parent; member → adult), one `household` row, and colours.
- Account numbers (`contractor_secrets`) are **admins only**. Revoked from `anon` and `service_role` too.
- Invariant: every policy is `private.is_member()`-gated (full members = everyone who can sign in in v2), except the anonymous token functions, which check the token.

## 3. Database (migration 0002; schema.sql stays the v1 baseline)

Fresh install = `schema.sql` + `migrations/*.sql` in order. The migration is one transaction, starts with a guard that raises if `hub_schema_version()` already exists, and is **additive** (the v1 site keeps working on the v2 schema).

Rules for every object: RLS enabled on every table; every function `set search_path = ''` with qualified names; every new public function `revoke execute … from public, anon` then `grant … to authenticated` (or `service_role`/`anon` where stated); SECURITY DEFINER functions live in `private` unless they must be RPCs; definer RPCs check `private.is_member()`/`is_admin()`/token first. Audit columns are set by triggers (`created_by`, `updated_by`, `done_by` := `current_email()` whenever a JWT is present), never trusted from the client.

Clock: `private.now()` = `coalesce(nullif(current_setting('hub.now', true), '')::timestamptz, now())`; everything uses it (tests set `hub.now`). `public.clock()` → `(local_date date, local_time time, tz text)`; `public.today_local()`.

### Tables
```
household (one row; id boolean PK default true check (id))
  tz text not null default 'America/New_York' check (tz in US list: America/New_York, America/Chicago, America/Denver,
     America/Phoenix, America/Los_Angeles, America/Anchorage, Pacific/Honolulu)
  digest_time time not null default '06:30'
  days_off date[] not null default '{}'          -- school holidays etc.
  pets_owner_id uuid → people (set null), house_owner_id uuid → people (set null)
  updated_at, updated_by
  RLS: members select; admins update.

people
  id uuid PK, name text not null (trimmed, non-empty), role text not null check in ('parent','adult','kid','helper'),
  email text unique null (lowercase, '%_@_%'), email_verified_at timestamptz null (cleared by trigger when email changes),
  phone text null, color text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  language text not null default 'en' check in ('en','es'),
  day_token text not null unique default encode(extensions.gen_random_bytes(16),'hex'),
  digest_enabled boolean not null default false, digest_time time null (null = household default),
  digest_day text not null default 'today' check in ('today','tomorrow'),   -- 'tomorrow' = evening preview
  digest_scope text not null default 'mine' check in ('mine','everyone'), check (digest_scope = 'mine' or role = 'parent'),
  sort_order int not null default 0, active boolean not null default true, created_at, updated_at
  RLS: members select (all columns incl. day_token); no direct writes (save_person / remove_person / rotate_day_token RPCs, admin).

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
event_changes (one-day changes to a repeating event)
  event_id uuid → events on delete cascade, on_date date, cancelled boolean not null default false,
  start_time time, end_time time, responsible_id uuid → people (set null), participant_ids uuid[] null, note text,
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
  repeat_weekdays int[] not null default '{}' (only schedule + week), anchor_date date null,
  last_done date null, active boolean not null default true,
  done_at timestamptz null, done_by text null,        -- non-repeating only
  created_by, updated_by, created_at, updated_at
  checks: repeating ⇒ every_count, every_unit, due_date, anchor_date not null; non-repeating ⇒ those null/empty;
          due_time null or due_date not null; done_at only when repeat_mode = 'none'
  RLS: members all.
task_log
  id uuid PK, task_id → tasks on delete cascade, occurrence date, status text check in ('done','skipped','missed'),
  done_on date, done_by text, note text, prev_due date, prev_last_done date, prev_done_at timestamptz, created_at
  RLS: members select; inserts only via functions (no insert policy).

contractors (existing — becomes the Directory)
  + kind text not null default 'contractor' check in ('contractor','account','service','emergency')
  + category text, + address text, + contract_end date, + updated_by text
  delete/update policy: members, except entries that have a secrets row — those need admin (private.has_secrets(id), definer).
contractor_secrets (admins only; revoked from anon and service_role)
  contractor_id uuid PK → contractors on delete cascade, account_number text, account_name text, secret_notes text,
  updated_at, updated_by

projects (existing)
  + task_dates jsonb null      -- null = stale; [{id,name,trade,trade_name,start,end,days,status,milestone}]
  + on_calendar boolean not null default true
  + owner_id uuid → people (set null)
  BEFORE UPDATE trigger: if new.schedule is distinct from old.schedule and new.task_dates is not distinct from old.task_dates
  → new.task_dates := null (so writes from an old client mark dates stale).

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
- `private.series_after(task, after date)` = first series date strictly after `after`.
- Event occurrences skip `household.days_off` when `skip_days_off`, and apply `event_changes` (cancelled days are returned with status `cancelled`; consumers hide them except the Calendar page, which shows them struck through).
- Timed occurrence instants: `start_at = (d + start_time) at time zone tz`; `end_at = (d + coalesce(end_time, start_time + 1h) [+ 1 day if ends_next_day]) at time zone tz`. Edge Functions and the client never compute offsets themselves.

### Task completion
- `complete_task(p_id uuid, p_occurrence date default null, p_done_on date default null, p_note text default null) returns uuid` (log id). Locks the row.
  - Non-repeating: raises `already done` if done_at is set; sets done_at/done_by; logs `done` with prev_done_at.
  - Repeating: raises `already completed` if `p_occurrence` is given and ≠ due_date (stale screen / double tap). `done_on` defaults to today_local(); must be ≤ today_local() and ≥ due_date − 1 year.
    - schedule: new due = `series_after(greatest(due_date, done_on))`.
    - after_done: new due = `done_on + count units`.
    - last_done = done_on. Log `done` with prev_due, prev_last_done.
- `skip_task(p_id, p_occurrence)`: repeating only. schedule: `series_after(greatest(due_date, today_local()))`; after_done: `today_local() + count units`. Logs `skipped`.
- `undo_task(p_log_id)`: only the task's latest log row, created within 7 days; restores prev values; deletes the row.
- `roll_missed_tasks()` (service_role + cron, also called at the start of each digest run): for active schedule-mode tasks whose next series date after due_date is ≤ today_local(), log `missed` and move due_date to the latest series date ≤ today_local(). after_done tasks never roll; they stay late until done.

### Read model
`agenda(p_from date, p_to date)` — SECURITY INVOKER, range ≤ 62 days, authenticated (and service_role). Returns rows:
```
kind text ('event','task','project'), item_id uuid, occurrence date, title text, day date, end_day date,
all_day boolean, start_at timestamptz, end_at timestamptz, local_start time, local_end time,
responsible_id uuid, participant_ids uuid[], status text ('open','done','cancelled','late','skipped'),
category text, project_id uuid, project_name text, contractor_id uuid, contractor_name text, contractor_phone text,
location text, notes text, private boolean, repeating boolean, changed boolean, lead_days int, milestone boolean
```
- events: every occurrence in range (multi-day: one row with day/end_day).
- tasks: open tasks whose due_date is in range (status open); non-repeating done tasks whose due_date is in range (done); task_log `done`/`skipped` rows whose occurrence is in range (done/skipped). No projections of future repeats.
- project tasks: for projects with on_calendar and non-null task_dates, each task overlapping the range (day = start, end_day = end; status from raw task status; milestone flag); contractor from the trade's contractor_id.
`late_items()` — same shape: open tasks with due_date < today_local() (status late). `heads_up(p_day)` — open tasks with `due_date - lead_days <= p_day < due_date`, plus directory `contract_end` within 30 days (kind 'contract').
`day_text(p_person uuid, p_day date) returns text` — the message for one person's day in their language (used by the Today page "Send their day" buttons and the digest; covered by SQL tests). Lines: timed events in order, all-day events, tasks due, then up to 3 late tasks ("+N more"). Participant copies read "Piano · Lorena"; the responsible person's copy reads "Piano · with Max". Linked directory entries add their phone. Never notes, never account numbers.

### Anonymous token functions (My day page; `grant execute to anon, authenticated`)
- `get_person_day(p_token text) returns jsonb` → `{person:{name,language}, today: date, days:[{day, items:[…]}], late:[…]}` for today and tomorrow; only that person's items (responsible or participant); fields: kind, item_id, occurrence, title, time range, all_day, location, contractor name+phone, status. No notes, no other people's items. Returns null for an unknown token or inactive person.
- `complete_by_token(p_token, p_task_id uuid, p_occurrence date)` → only tasks where that person is responsible; same rules as complete_task.
- `confirm_digest(p_token)` → sets email_verified_at. `stop_digest(p_token)` → digest_enabled = false.
Tokens are 32 hex characters; `rotate_day_token(p_person)` (admin) replaces one.

### Jobs support (service_role only)
- `email_budget_left() returns int` = 60 − (email_log rows + notification_log rows with status in ('sending','sent')) since 00:00 UTC. (Resend free allows 100/day shared with sign-in codes; this leaves 40 for sign-in.)
- `digest_due(p_limit int) returns setof (person_id, local_date, kind)` — people with digest_enabled, email, email_verified_at, active, whose due instant `(local_date + coalesce(digest_time, household.digest_time)) at time zone tz` is ≤ now() and within 3 hours, and who have no log row in a final state for that date; plus confirmation candidates (digest_enabled, email, not verified, no `confirm` row in the last 3 days).
- `claim_notification(p_person, p_local_date, p_kind) returns uuid` — insert … on conflict do update (retry when failed or stale 'sending' > 10 min, attempts < 3) returning id, else null.
- `finish_notification(p_id, p_status, p_detail)`.
- `digest_for(p_person uuid, p_local_date date) returns jsonb` — everything the email needs, computed in SQL (see §5).

### Schema version
`hub_schema_version()` returns 2 (authenticated). `whoami()` gains `person` (id, name, role, language, color) when a person row matches the caller's email; existing keys unchanged.

## 4. Client

### Core and modules
- `assets/hub.js` = core: sign-in, shell, router, forms, api helpers, message helpers (sms/wa.me/mailto), toasts (with an Undo action), caches (people, household, clock), schema version.
- Module contract: `HomeHub.register({ name, schema: { min, max }, nav: { label, order, primary }, match(parts) → params | null, render(main, ctx) })`, where `ctx = { seq, params, signal, stale() }`. The core aborts `signal` on navigation; modules add listeners with `{ signal }`.
- Script tags load in a fixed order without async; every `src` carries the same `?v=…`, bumped together on each release.
- Formatting uses the household time zone (`Intl.DateTimeFormat(…, { timeZone })`); "today" comes from `clock()`.

### Navigation
- Desktop: top tabs — Today · Calendar · Tasks · Projects · Directory · Family · Settings.
- Phones (< 640px): bottom bar — Today · Calendar · ＋ · Tasks · More (More: Projects, Directory, Family, Settings, Sign out). ＋ opens the Add sheet.
- v1 mode (no migration yet): exactly today's tabs and pages.

### Pages
- **Today**: person chips (Me · each person · Everyone; default Me); that person's day (events in time order, then tasks due, checkboxes on tasks); Late (≤ 3 + "N more"); Heads-up; "Nobody's on it" (parents); "Send <name> their day" (WhatsApp / Text) for kids and helpers with a phone, using `day_text`; one line per active project; first-run checklist until done (add people → turn on morning email → add the weekly routine → directory from bills → starter tasks).
- **Calendar**: week agenda (default on phones) and month grid; person filter chips; colours by person; tap → details with Edit, and for repeating events "Change this day" / "Skip this day" / edit "This day · All"; ＋ Event.
- **Tasks**: filters Me / Everyone / person / Repeating / Project; groups Late · Today · Coming up · No date · Done (14 days); one-tap checkbox = done today with "Done · Undo" toast; menu: done on another day, skip, edit, delete; Repeating view grouped Home/Pets/Car/Health with "Add from starter list" (staggered first due dates, ≤ 2 per day over 4 weeks; owner defaults from household pets/house owner).
- **Add / edit forms**: What · When (Today / Tomorrow / date; time or All day) · Who (people chips: first tap = in charge (ring), more taps = with) · Repeats (presets from the date: Every <weekday>, Every weekday, Every day, Custom…; tasks also "Monthly on the Nth", "Every N months/days after done"). "More" reveals end time / end date, place, directory contact, notes, private, until.
  - Task repeat wording: "On set dates (e.g. the 1st of every month)" vs "A while after it's done (e.g. 60 days after the last change)" with "When was it last done?" / "Next one is due".
- **Directory**: kind filter (All · Contractors · Accounts & utilities · Services · Emergency), search, cards with tap-to-call/text/WhatsApp/email/website, contract end; account number masked with Show (admins only; loaded separately).
- **Family**: one list of people; add/edit person (name, role, email, phone, colour, language, morning email on/off, time, today/tomorrow, everyone (parents), can sign in (parents/adults)); "unconfirmed" badge until the email is confirmed; My day link: Copy / Send by WhatsApp / Text / New link.
- **Settings**: time zone, default morning-email time, days off, default owners for pets/house, digest status ("Last run 6:30 · 4 sent", failures), Google Calendar "not connected yet" (v1.1).
- **Projects**: unchanged plus: dates recomputed on every schedule write in one choke point (`api.updateProject`/`createProject`) and backfilled when stale; project owner; "Show in Home Hub calendar"; a Tasks card listing the project's tasks with "Put on the schedule" (turns a task into a 1-day Gantt task with a trade picker, then deletes the task).
- **My day** (`day.html?t=…`): no sign-in; today and tomorrow for that person; check off own tasks; in their language; confirm / stop morning email via POST buttons (`#confirm`, `#stop`); "Add to Home Screen" hint.

## 5. Morning email (`hub-jobs`)

One Edge Function, `hub-jobs` (verify_jwt off; each action authorizes itself; `send-email` untouched):
- `digest` — header `x-hub-cron: <HUB_CRON_SECRET>` (constant-time compare; missing/short secret → 503). Calls `roll_missed_tasks()`, then `digest_due()`; for each: budget check, `claim_notification`, `digest_for` (or the confirmation email), render, send with Resend (`Idempotency-Key: <kind>-<person>-<date>`), `finish_notification`. Writes a `job_runs` row; pings `HEALTHCHECK_URL` if set and the run had no unhandled error. Ignores the request body.
- `preview` (admin via whoami with the caller's JWT) — returns rendered digests for a date without sending or logging.
- `status` (admin) — last runs and today's notification rows (counts and fixed messages only).

`digest_for` layout (JSON → HTML and plain text, every dynamic string escaped; no autolinking; only hub-generated links):
- Subject carries content: "Tue Oct 27: 8:00 Drop off dogs · 3:00 Pick up Max · +2".
- **Today**: timed items in order, then tasks due (late ones marked). **Late**: ≤ 3 + "and N more". **Heads-up**: lead-time tasks, contract ends ≤ 30 days, tomorrow before 9am.
- Parents also get: a compact block per kid/helper with their day and WhatsApp/Text buttons (`day_text`), **Nobody's on it** (unassigned items), one line per project with items today ("Kitchen: tile starts (Gomez Tile 555-0200)"), and on Mondays "Inbox: N tasks with no date".
- Non-parents with nothing today get no email. Links open the recipient's My day page (no sign-in), never change state.
- `digest_day = 'tomorrow'` sends the next day's plan at the chosen evening time.
- Spanish strings from a small dictionary for people with language 'es'.

## 6. Tests (committed under `tests/`, fictional data only)
- `tests/run.sh`: starts a throwaway Postgres, loads Supabase stand-ins (anon, authenticated, service_role with BYPASSRLS, `auth.jwt()`, **Supabase's default grants to anon/authenticated/service_role**), `schema.sql`, then `migrations/*`, and runs:
  - `tests/db/*.sql` — RLS role matrix (anon; signed-in non-member; removed member with a parent person row; adult member; admin), every public table has RLS, no public function executable by anon except the token functions and `get_shared_project`, recurrence vectors, DST days (2026-11-01, 2027-03-14) via `hub.now`, task completion/undo/skip/roll, digest selection and claims, day_text, token functions.
  - `tests/fn/*.test.ts` (Node, type stripping) — hub-jobs handler with injected deps and clocks.
  - `tests/e2e/*.test.js` (Playwright, mocked Supabase) — v1 mode unchanged; each v2 page.
  - `tests/contract` — every `.from('t')`/`.rpc('f', {args})` in the client exists in the migrated schema with those parameter names.
- `CLAUDE.md`: run `tests/run.sh` before every PR; deploy order; never put real names, numbers or IDs in fixtures.

## 7. Deploy order (needs Supabase access)
0. Move the project into the paid organization (owner); confirm the URL and project ref are unchanged.
1. `preflight.sql` (read-only checks) and `list_migrations`.
2. Merge PR A, then PR B (site stays in v1 mode until step 3).
3. Apply migration 0002 (site switches to v2 on next load).
4. Deploy `hub-jobs` from main (verify_jwt false). Secrets: `HUB_CRON_SECRET` (≥ 32 chars), optional `HEALTHCHECK_URL`.
5. Create the Vault secret by hand, run `cron.sql` (enables pg_cron/pg_net; refuses a missing/placeholder secret; idempotent).
6. Smoke checks: no header → 401; preview → rendered JSON; Settings shows the last run; next morning `notification_log` has sent rows.
7. Ops hardening: Auth email rate limit ≈ 6/hour; the signup hook stays on; Resend click/open tracking off.
