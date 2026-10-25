# Home Hub

A private family web app for running the house: today's plan for everyone, a shared calendar, tasks that come round again, projects with Gantt schedules, a directory of contractors and accounts, and the family list. Kids and helpers get their own **My day** page, with no sign-in.

- **Hub (family only):** https://route3ralph.github.io/home-hub/
- **Share links (for contractors):** each project can have its own read-only link, made from the project's **Share** button.
- **My day links (for kids and helpers):** each person on the Family page has one. It shows their today and tomorrow.

## What's new in v2

v2 turns on by itself once the database is upgraded (see [Upgrading to v2](#upgrading-to-v2)). Until then the site shows the pages it always had.

| Page | What it's for |
|---|---|
| **Today** | Your day at a glance: your events in time order, then your tasks with a box to tick (and **Undo** for 6 seconds). Chips at the top show anyone else's day, or **Everyone**. Below: what's **Late**, a **Heads-up** for what's coming (tasks with a heads-up, contracts ending soon), **Nobody's on it** for parents, **Send their day** for kids and helpers, and one line per project with work today. Tap a row to open it on the Calendar or Tasks. A short checklist helps you set the hub up the first time. |
| **Calendar** | A week view (the default on phones) and a month grid. Filter by person; everything is coloured by who's in charge. Tap an event for its details, **Edit**, and for repeating ones **Change this day** or **Skip this day**. Project work shows as bars. |
| **Tasks** | Late · Today · Coming up · No date · Done (last 2 weeks), for you, everyone or one person. A task can repeat **on set dates** ("the 1st of every month") or **a while after it's done** ("60 days after the last filter change"). Its menu has done on another day, skip, pause, edit and delete. **Repeating → Add from starter list** adds the usual jobs (furnace filter, smoke alarms, heartworm pills…) spread over the next 4 weeks and given to whoever Settings says looks after the house or the pets. |
| **Projects** | As before, plus an **owner** (who gets the project in their morning email), **Show in Home Hub calendar**, and a **Tasks** card for calls, orders and errands. **Put on the schedule** turns one of those into a Gantt task. |
| **Directory** | Replaces Contractors. Contractors, **accounts and utilities**, services and emergency numbers, with search and one tap to call, text, WhatsApp, email or open the website. Account numbers are for admins only, masked until **Show**. A contract or promo end date gets a reminder 30 days ahead. |
| **Family** | One list of everyone in the house: parents, adults, kids and helpers, each with a colour, language (English or Spanish), phone and email. Parents and adults can sign in; kids and helpers get a **My day link** (Copy, WhatsApp, Text, New link). |
| **Settings** | Time zone, the usual morning-email time, days off (school holidays: repeating events can skip them), who new pet and house tasks go to, and whether the morning email is running. |

**Event or task?** The ＋ button asks first. *Piano, pickups, appointments → Event. Pills, filters, chores, calls → Task.*

**My day.** A kid or helper opens their link (no password, nothing to install) and sees their today and tomorrow in their language. They can tick off their own tasks, with Undo. "Add to Home Screen" keeps it one tap away. If the link ever gets passed around, **New link** on the Family page stops the old one at once.

**Morning email.** Anyone with an email address can get their day before breakfast (or tomorrow's plan in the evening). Parents also get a block per kid or helper with Send buttons, what nobody is on, and the project lines. The first email asks the person to confirm their address; signing in to the hub confirms it too. Every email has a link to stop them.

**On a phone.** The bottom bar has Today · Calendar · ＋ · Tasks · More. Add the hub to your Home Screen (Settings explains how on iPhone and Android) and it opens like an app.

Every date and time is in the household's time zone, wherever your phone is.

## Using it

| To… | Do this |
|---|---|
| Sign in | Enter your email, then type the code from the email that arrives. Each device stays signed in. |
| Add an event or a task | **＋** (or **Add** on a computer), then **Event** or **Task**. Tap a name once to put them in charge, again on more names for who's with them. |
| Tick something off | The box on Today, Calendar or Tasks. **Undo** appears for 6 seconds. |
| Send a kid or helper their day | **Today → Send their day → WhatsApp** or **Text**: the message is ready to send from your phone. |
| Give someone their My day link | **Family →** their card **→ Copy**, **WhatsApp** or **Text**. |
| Start a project | **Projects → + New project**. Start blank or copy an existing project's tasks. |
| Add or change a schedule task | Open the project, click **+ Schedule task**, or click any task, then **Edit task**. |
| Record progress | Click a schedule task, then **Mark done** or **Mark in progress**. |
| Lock in a contractor's date | Edit the task and set **Confirmed start date**. Later tasks reflow automatically. |
| Link a contractor to a trade | Project → **Trades & contractors** |
| Send a contractor their dates | Project → **Share** → turn on, copy the link. On the shared page, tap a trade to get a link showing only that trade. |
| Add someone to the family | **Family → Add person** (admins only) |

Each schedule task has two kinds of notes. **Notes** appear on the shared link. **Private notes** are family-only and never shared, so they're the place for gate codes and similar details.

## Messaging contractors

A **Message** button appears on a project's Team cards and in a schedule task's details (and on the Contractors page before v2). It drafts a note with that contractor's upcoming dates and, if sharing is on, a link to their part of the live schedule. Edit the draft, then choose how to send it:

- **Text** or **WhatsApp** opens the app on your phone with the message ready to send.
- **Open in my email** does the same with your email app.
- **Send email now** sends it from the hub through Resend, with your address set for replies.

The first three come from your own phone number or email address, so replies come straight back to you, and they need no setup. The Directory's cards have one-tap Call, Text and WhatsApp as well.

## How the data is protected

- Everything lives in a Supabase database. Every table has row-level security, so only the family members who can sign in can read or change anything. Signed-out visitors and other accounts see nothing.
- Account numbers in the Directory are for admins (parents who sign in) only, and the page asks for them only when an admin is looking.
- A **My day** link shows only that person's own items for today and tomorrow, never notes or anyone else's details. Items marked **Private** show as "Private item".
- The email that asks someone to confirm their address carries its own confirmation code, never their My day link, so an email that goes to a mistyped address gives nothing away.
- The share page can read one project by its secret link. It returns only the schedule plus each contractor's name and company. It never returns phone numbers, emails or private notes. Turning sharing off, or clicking **Get a new link**, stops the old link immediately.
- This repository is public, but it contains only code. `config.js` holds a *publishable* key, which is designed to be public. Never put a `service_role` or secret key in this repo.

The rules are in [`supabase/schema.sql`](supabase/schema.sql) and [`supabase/migrations/`](supabase/migrations/).

## One-time setup

1. **Create a Supabase project.** Then run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor, followed by each file in [`supabase/migrations/`](supabase/migrations/) in order (for v2).
2. **Add yourself as the first admin.** In the SQL editor:
   `insert into members (email, name, role) values ('you@example.com', 'Your Name', 'admin');`
   (On a v2 database, run this before the migration, or add yourself on the Family page afterwards: the migration makes a person for every member it finds.)
3. **Connect the site.** Put the project URL and publishable key in [`config.js`](config.js).
4. **Set the sign-in redirect.** In Supabase, open **Authentication → URL Configuration**:
   - Set **Site URL** to `https://route3ralph.github.io/home-hub/`.
   - Add the same address under **Redirect URLs**.
5. **Recommended: block strangers from creating logins.** Go to **Authentication → Hooks → Before User Created → Postgres function** and choose `hook_family_only_signup`.
6. **Set up email.** This step is required: see [Email through Resend](#email-through-resend) below.
7. **Publish.** In GitHub, open **Settings → Pages** and deploy from branch `main`, folder `/ (root)`.
8. **For the morning email (v2):** steps 4–7 of [Upgrading to v2](#upgrading-to-v2).

The kitchen renovation's starting schedule is in [`supabase/kitchen-renovation.json`](supabase/kitchen-renovation.json).

## Upgrading to v2

The order matters, and it's written out in [`CLAUDE.md`](CLAUDE.md) under **Deploy order** (and in [`docs/v2-design.md`](docs/v2-design.md) §7). In short:

0. Move the Supabase project into the paid organization, and check its URL and project ref haven't changed.
1. Run [`supabase/preflight.sql`](supabase/preflight.sql) in the SQL editor. It only reads. Go on only if every row says ok.
2. Publish the new site. It keeps showing the v1 pages until the next step, because it asks the database for its version first.
3. Apply [`supabase/migrations/0002_home_hub_v2.sql`](supabase/migrations/0002_home_hub_v2.sql). The site switches to v2 the next time each phone loads it. **Never apply a migration before the site that understands it is live.**
4. Deploy [`supabase/functions/hub-jobs`](supabase/functions/hub-jobs) with JWT verification turned off (`supabase functions deploy hub-jobs --no-verify-jwt`; it checks who is asking itself). In **Edge Functions → Secrets**, add:
   - `HUB_CRON_SECRET`: at least 32 random characters, for example from `openssl rand -hex 32`. Without it every run is refused.
   - `SITE_URL`: the site's address, such as `https://route3ralph.github.io/home-hub/`, for the My day and confirmation links in the emails.
   - `HEALTHCHECK_URL` (optional): a ping address, such as one from healthchecks.io, called after every good run, so you hear about it if the email stops.
   - `RESEND_API_KEY`, `EMAIL_FROM` and `EMAIL_FROM_NAME` are the same as for `send-email`.
5. Create two Vault secrets by hand (`hub_cron_secret`, with the same value as `HUB_CRON_SECRET`, and `hub_jobs_url`), then run [`supabase/cron.sql`](supabase/cron.sql). Its header shows the exact commands. It refuses to run with a missing or placeholder secret and is safe to run again.
6. Smoke checks: a POST to hub-jobs without the header answers 401; **Settings → Preview my morning email** shows an email; **Settings → Morning email** shows the last run; the next morning `notification_log` has `sent` rows.
7. Ops hardening: set the Auth email rate limit to about 6 an hour, keep the signup hook on, and turn Resend's click and open tracking off (so links in emails aren't rewritten).

Until hub-jobs is deployed, Settings says the morning email is **Not set up yet**; everything else works.

## Coming next: Google Calendar and Hearth (v1.1)

Hearth shows Google calendars only, one column per calendar. v1.1 will copy hub items one way into one Google calendar per Hearth column (one per person, plus pets, house and family), and show the other Google events on the Calendar page and in the morning email. Settings already has a "Not connected yet" row for it.

Before any of it is built, the owner runs two short tests on a real calendar, because the plan depends on both:

1. **The service-account key downloads.** In a Google Cloud project created while signed in as the family Gmail (not a work Workspace, whose newer organizations block keys by default), enable the Calendar API, create a service account and download its JSON key.
2. **It can add and delete an event on a shared calendar.** In the family Gmail, create one secondary calendar, share it with the service account's `…iam.gserviceaccount.com` address as **Make changes to events**, then add one test event through the API and delete it again (about 5 minutes).

If either fails, v1.1 uses Google sign-in (OAuth, with the app published "In production") instead. Events will never have attendees: who an event is for comes from which calendar it's on.

## If the hub says it can't reach the database

On Supabase's free plan, a project that sees little use for about a week gets **paused**. Supabase emails a warning first, and nothing is lost. To resume it, open the [Supabase dashboard](https://supabase.com/dashboard), select the project and click **Resume project**. Regular family use keeps it awake. (The paid organization doesn't pause projects.)

## Email through Resend

Supabase's built-in email sender only delivers to people on your Supabase organization's team, and only a few messages an hour, so family members can't get sign-in codes without a sender of your own. Resend's free plan (3,000 emails a month, up to 100 a day) is plenty. It sends the sign-in emails, the morning emails and **Send email now**. The morning email holds back once the hub's own emails (morning emails and Send email now) reach 60 in a day, so about 40 are always left for sign-in codes.

1. **Verify a domain you own** in Resend: **Domains → Add Domain**. Add the DNS records it shows at your domain's DNS host, then wait for **Verified**.
2. **Create an API key** with sending access: **API Keys → Create API Key**.
3. **Sign-in emails.** In Supabase, open **Authentication → Emails → SMTP Settings**, turn on custom SMTP and enter:
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: your API key
   - Sender: an address on your domain, such as `home@yourdomain.com`
4. **Send a code instead of a link.** In **Authentication → Emails → Templates**, set both **Confirm signup** (someone's first sign-in) and **Magic Link** (every sign-in after that) to the subject `Your Home Hub sign-in code` and the body in [`supabase/email-templates/sign-in-code.html`](supabase/email-templates/sign-in-code.html).
5. **Emails from the hub.** In **Edge Functions → Secrets**, add:
   - `RESEND_API_KEY`
   - `EMAIL_FROM` (an address on your domain)
   - `EMAIL_FROM_NAME` (optional; defaults to "Home Hub")
6. **Deploy** [`supabase/functions/send-email`](supabase/functions/send-email) with JWT verification turned off. Supabase's built-in check only works with the legacy API keys, so the function checks who is signed in itself. **Send email now** is switched on by `emailSending` in [`config.js`](config.js).

The function only sends for signed-in family members. It sets each email's reply-to address to whoever sent it, sends to at most 10 people at a time, stops after 50 emails in 24 hours, and records every send in the `email_log` table.

**Why a code and not a link.** Email security scanners, such as Microsoft's in Outlook and Microsoft 365, open the links in new mail to check them. A sign-in link works only once, so a scanner can use it up before you tap it, and you'd see "Email link is invalid or has expired". The code is the same one-time token, so the email deliberately has no sign-in link for a scanner to open. For the same reason, the links in the morning email never change anything by being opened: confirming or stopping the emails takes a tap on a button on the My day page.

Paste API keys only into Resend and Supabase, never into this repository or a chat.

## Texting

The **Text** and **WhatsApp** buttons (Send their day, My day links, contractors) use your own phone, so they need no setup and cost nothing. Having the hub send texts *on its own* is a different matter: for example, an automatic reminder the day before a contractor arrives. In the US that requires a messaging provider such as Twilio, with your number registered under the A2P 10DLC rules. WhatsApp would require Meta's Business Platform, with pre-approved message templates and per-message fees. Neither is set up.

## Working on the hub with Claude Code

Claude Code sessions on this repo reach the home-hub Supabase project through [`.mcp.json`](.mcp.json), separately from the Supabase connector in claude.ai, so that connector can stay on another organization. The connection needs, in the cloud environment's settings:

- A secret `SUPABASE_ACCESS_TOKEN`: a Supabase *scoped* access token limited to the home-hub project (Account → Access Tokens). Don't use a classic token: it reaches every organization on the account.
- `mcp.supabase.com` and `api.supabase.com` under **Network access → Allowed domains**.

Never commit the token. The rules for changing the repo (tests, migrations, deploy order, test data) are in [`CLAUDE.md`](CLAUDE.md).

## Files

| File | What it is |
|---|---|
| `index.html`, `assets/hub.js` | The private hub: `hub.js` is the core (sign-in, the shell and bottom bar, forms, data access, messages, toasts, the shared v2 pieces) |
| `assets/modules/` | The hub's pages, one file each. v2: `today.js`, `calendar.js`, `tasks.js`, `projects.js` (v1 and v2), `directory.js`, `people.js` (Family), `settings.js`. v1: `home.js`, `contractors.js`, `family.js`. Each page shows only for the database version it was made for |
| `assets/styles.css`, `assets/css/` | Styles with automatic light and dark mode: the shared ones, then one file per v2 page |
| `day.html`, `assets/day.js` | The public My day page for kids and helpers (no sign-in; the link carries the person's code) |
| `share.html` | The public, read-only project page |
| `assets/gantt.js` | Schedule engine and Gantt chart, shared by the hub and the share page |
| `manifest.webmanifest`, `assets/icons/` | The Home Screen app: name, colours and icons |
| `config.js` | Database connection settings |
| `supabase/schema.sql` | The v1 tables, security rules and functions (the baseline) |
| `supabase/migrations/` | Every database change since, in order: `0002_home_hub_v2.sql` is v2 |
| `supabase/preflight.sql` | Read-only checks to run before applying the v2 migration |
| `supabase/cron.sql` | Schedules the morning email (pg_cron) once hub-jobs is deployed |
| `supabase/config.toml` | Supabase CLI settings: both Edge Functions deploy with JWT verification off |
| `supabase/functions/hub-jobs/` | Edge Function for the morning email: sending, preview and status |
| `supabase/functions/send-email/` | Edge Function that sends email through Resend |
| `supabase/email-templates/` | The sign-in email, for Supabase's email templates |
| `docs/v2-design.md` | The v2 design: what was built and why |
| `.mcp.json`, `.claude/settings.json` | Supabase access for Claude Code sessions (token comes from the environment) |
| `tests/` | Automated tests: run `tests/run.sh` (see [`tests/README.md`](tests/README.md)) |
| `CLAUDE.md` | Rules for changing this repo: tests, migrations, deploy order, test data |
