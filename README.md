# Home Hub

A private family web app for running the house: today's plan for everyone, a shared calendar, tasks that come round again, projects with Gantt schedules, a directory of contractors and accounts, and the family list. Kids and helpers get their own **My day** page, with no sign-in.

- **Hub (family only):** https://hub.webshek.com/ (the old address, https://route3ralph.github.io/home-hub/, forwards there)
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
| **Settings** | Time zone, the usual morning-email time, days off (school holidays: repeating events can skip them), who new pet and house tasks go to, whether the morning email is running, and (v1.1) [Google Calendar and Hearth](#google-calendar-and-hearth). |
| **Food** (v1.2) | This week's dinners and the family's one shopping list: see [Food](#food-dinners-and-the-shopping-list-v12). |

**Event or task?** The ＋ button asks first. *Piano, pickups, appointments → Event. Pills, filters, chores, calls → Task.* With v1.2 it also offers **Shopping**, for something to buy.

**My day.** A kid or helper opens their link (no password, nothing to install) and sees their today and tomorrow in their language. They can tick off their own tasks, with Undo. "Add to Home Screen" keeps it one tap away. If the link ever gets passed around, **New link** on the Family page stops the old one at once.

**Morning email.** Anyone with an email address can get their day before breakfast (or tomorrow's plan in the evening). Parents also get a block per kid or helper with Send buttons, what nobody is on, and the project lines. The first email asks the person to confirm their address; signing in to the hub confirms it too. Every email has a link to stop them.

**On a phone.** The bottom bar has Today · Calendar · ＋ · Tasks · More (with v1.2: Today · Calendar · ＋ · Tasks · Food · More). Add the hub to your Home Screen (Settings explains how on iPhone and Android) and it opens like an app.

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

## Food: dinners and the shopping list (v1.2)

The **Food** page has this week's dinners at the top and the family's one shopping list below: groceries, and household things too (batteries, detergent). It turns on by itself once the database is upgraded to v1.2 (see [Turning on Food](#turning-on-food)). The design, with every rule, is [`docs/v1.2-kitchen.md`](docs/v1.2-kitchen.md).

**The shopping list**
- **Add:** **Food →** type **→ Enter** (the box stays ready for the next one), or **＋ → Shopping** from any page. "2 milk", "2 lb ground beef" or "Milk: 2 gallons" put the amount in a small note. Something already on the list isn't added twice ("Already on the list"), and "Leche" joins "Milk".
- **Tap = bought.** The line is struck through, with **Undo**, then moves to **Just bought** (today's buys; tap one to put it back). **Buy again** (folded away) has what was bought in the last 60 days: one tap puts it back on the list, so the weekly milk is one tap.
- Lines are grouped by aisle, in store order, cold things last. The hub guesses the aisle; **Aisle?** or **⋯ → Edit** corrects it, and the item remembers.
- **⋯ → Forget** removes a line for good (a typo), so it isn't suggested again.
- **The lock** next to **Add** (or in **⋯ → Edit**). Locked: hidden from My day links; every grown-up who signs in still sees it. The list is seen by Taylor and anyone her link reaches: lock anything private. (So it isn't for a gift for someone who signs in.)
- **Taylor's list.** Her My day shows a **Lista de compras** button: the list in Spanish, in big rows, where she ticks things off (and can undo her own tick for 15 minutes) and adds what has run out. **Send Taylor the list** on the Food page sends her the link. At the foot of the Food page a parent chooses what she can do: Off · See and tick · See, tick and add. Kids see dinners on their My day, not the list.
- **Two phones, bad signal.** The list checks for changes every 10 seconds while it's open. With no signal, ticks and adds wait on the phone ("Not sent yet") and go when it's back. **Open Food before you go into the store, and don't reload it there:** the hub can't start without the database.

**Dinners**
- Tap a day: a name ("Tacos", with your usual dinners as suggestions), or one tap for Leftovers · Eating out · Takeout · Fend for yourself. Empty days are fine.
- **Who cooks** (optional; for Leftovers and Takeout, who's on dinner): they see the note and the recipe link on their My day and in their email, and get the email that day even with nothing else in it.
- **Keep the title private** (under More) locks a dinner: the wall, other people's My day and every email subject say "Private item". Grown-ups who sign in still see it.
- **Add a prep reminder…** on a saved dinner makes an ordinary task for the day before ("Prep: Tacos"). It doesn't move if the dinner moves. On a locked dinner it starts as a private task (Private is ticked under More), so the wall, My day and email subjects say "Private item".
- Dinner shows on **Today**, on everyone's **My day**, at the end of Today in the morning email, in the cook's **Send their day** text, and on the wall's **Family column** as "Dinner: Tacos (Sam)", all day, once [Google Calendar and Hearth](#google-calendar-and-hearth) has a Family calendar. A parent can turn the wall copy off at the foot of the Food page.

**Hearth's Meals and Groceries.** Use Home Hub's, not Hearth's Meals or Groceries: anything added there won't reach Taylor, the email or the hub. Home Hub can't read or fill them, and using both puts every dinner on the wall twice.

### Turning on Food

The order matters (the design's §15):
1. `tests/run.sh` ends with `0 failed`; merge. The site stays on schema 3, with no Food tab and nothing new.
2. Nothing to deploy: hub-jobs and `supabase/cron.sql` don't change.
3. The owner runs [`supabase/migrations/0004_meals_and_shopping.sql`](supabase/migrations/0004_meals_and_shopping.sql) in the Supabase SQL editor. Food appears at the next load. If it says "already installed" or "isn't installed", nothing was changed.

To hide Food again, turn off both switches at the foot of the Food page first, then follow the design's §15.

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
- **Google Calendar (v1.1)** copies to the kitchen wall only what everyone in the house may see, and only after an admin has looked at it: see [Privacy](#privacy) under Google Calendar and Hearth.
- **The shopping list (v1.2)** is seen by every grown-up who signs in, and by the helper's My day link (and so anyone her link reaches) while a parent allows it. A locked line never reaches a My day link. What is typed there is shown as plain text, only on the Food page and her own screen, never in an email, a text or on the wall. A dinner's note and recipe link go only to the person cooking it.
- This repository is public, but it contains only code. `config.js` holds a *publishable* key, which is designed to be public. Never put a `service_role` or secret key in this repo.

The rules are in [`supabase/schema.sql`](supabase/schema.sql) and [`supabase/migrations/`](supabase/migrations/).

## One-time setup

1. **Create a Supabase project.** Then run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor, followed by each file in [`supabase/migrations/`](supabase/migrations/) in order (for v2).
2. **Add yourself as the first admin.** In the SQL editor:
   `insert into members (email, name, role) values ('you@example.com', 'Your Name', 'admin');`
   (On a v2 database, run this before the migration, or add yourself on the Family page afterwards: the migration makes a person for every member it finds.)
3. **Connect the site.** Put the project URL and publishable key in [`config.js`](config.js).
4. **Set the sign-in redirect.** In Supabase, open **Authentication → URL Configuration**:
   - Set **Site URL** to the site's address, here `https://hub.webshek.com/`.
   - Add the same address followed by `**` (`https://hub.webshek.com/**`) under **Redirect URLs**.
5. **Recommended: block strangers from creating logins.** Go to **Authentication → Hooks → Before User Created → Postgres function** and choose `hook_family_only_signup`.
6. **Set up email.** This step is required: see [Email through Resend](#email-through-resend) below.
7. **Publish.** In GitHub, open **Settings → Pages** and deploy from branch `main`, folder `/ (root)`.
   - **Your own address (optional).** At your domain's DNS host, add a CNAME record from a subdomain (here `hub`) to `<your GitHub user>.github.io`. Then in **Settings → Pages**, enter it under **Custom domain**, and tick **Enforce HTTPS** once GitHub offers it. Afterwards change the **Site URL** and **Redirect URLs** (step 4) and the `SITE_URL` secret to the new address. The `github.io` address keeps working and forwards to it.
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
   - `SITE_URL`: the site's address, such as `https://hub.webshek.com/`, for the My day and confirmation links in the emails.
   - `HEALTHCHECK_URL` (optional): a ping address, such as one from healthchecks.io, called after every good run, so you hear about it if the email stops.
   - `RESEND_API_KEY`, `EMAIL_FROM` and `EMAIL_FROM_NAME` are the same as for `send-email`.
   - `GOOGLE_SA_JSON` (optional, for [Google Calendar and Hearth](#google-calendar-and-hearth)): the whole service-account key file (step B there). Without it the calendar job stops at once and the morning email is unchanged.
5. Create two Vault secrets by hand (`hub_cron_secret`, with the same value as `HUB_CRON_SECRET`, and `hub_jobs_url`), then run [`supabase/cron.sql`](supabase/cron.sql). Its header shows the exact commands. It refuses to run with a missing or placeholder secret and is safe to run again. Run it again after a release that changes it: v1.1 adds the `hub-calendar` job.
6. Smoke checks: a POST to hub-jobs without the header answers 401; **Settings → Preview my morning email** shows an email; **Settings → Morning email** shows the last run; the next morning `notification_log` has `sent` rows.
7. Ops hardening: set the Auth email rate limit to about 6 an hour, keep the signup hook on, and turn Resend's click and open tracking off (so links in emails aren't rewritten).

Until hub-jobs is deployed, Settings says the morning email is **Not set up yet**; everything else works.

## Google Calendar and Hearth

Hearth, the kitchen wall display, shows Google calendars only, one column per calendar. Home Hub copies its items, one way, into one Google calendar per column ("Hub – Alex", "Hub – Jordan", …, "Hub – Family", and "Hub – Pets" and "Hub – House" if wanted), within 5 minutes of a change. It also reads the events people type into Google (on a phone, or into the family account's own calendar) and shows them in the hub. Home Hub stays the source of truth: a change made in Google to one of the hub's events is put back, and the parents are told. The design, with every rule, is [`docs/v1.1-google-calendar.md`](docs/v1.1-google-calendar.md).

**What goes where.**
- An event or task goes on the calendar of the person in charge. Everyone along gets a copy that says who's in charge ("Piano (Taylor)"). An event with 4 or more family members goes once on Family instead.
- A task nobody is in charge of goes on Pets, House or Family, by its category. An event nobody is on goes on Family.
- Done tasks and skipped days are taken off Google. Late tasks become one line on today ("2 late: Heartworm pill, Nail trim").
- Private items and health tasks show as "Private item", with no place and no details.
- Someone without a Hub calendar gets nothing on Google: Settings lists them under **Not on Google**.
- Hub items reach Google up to 60 days ahead. Events read from Google show in the hub from yesterday to 60 days ahead.
- Events read from Google show on the Calendar and Today pages (with a "Google" tag and no box to tick) and in grown-ups' morning emails. A kid's or helper's My day, texts and email get the events of a calendar that is theirs (their Hub calendar, or a calendar to read given to them under **Whose**), and of Pets or House if they look after those. A kid also gets Hub – Family's and those of a Family calendar marked **Show to kids**; a helper never gets a Family calendar's. The hub never changes them: change them in Google Calendar.

### Turning it on

The order matters (the design's §8.3):
1. `tests/run.sh` ends with `0 failed`; merge. The site stays on schema 2, and Settings' Google card says **Waiting for the database update**.
2. Deploy `hub-jobs` (`index.ts`, `handler.ts`, `render.ts`, `util.ts`, `google.ts`, `calendar.ts`) with JWT verification off. Until the migration is applied it answers the calendar job with 503 `no_schema`, and the morning email is unchanged.
3. The owner runs [`supabase/migrations/0003_google_calendar.sql`](supabase/migrations/0003_google_calendar.sql) in the Supabase SQL editor, then [`supabase/cron.sql`](supabase/cron.sql) again (it adds the `hub-calendar` job).
4. The owner sets up the calendars and Hearth (steps D to G below).

### Setting it up (about 2 to 2½ hours, over three sittings)

Before you start, turn on 2-step verification for the family Gmail (it holds the calendars and signs the wall in) and for the parent's own Google account used in step A.

**Sitting 1: the key (about 25 minutes)**

A. **Google Cloud and the key.** Signed in as a parent's own personal Gmail (not a work or school account), at console.cloud.google.com:
   1. Make a new project "Home Hub", with Location **No organization**. Accept the terms if asked.
   2. **APIs & Services → Library → Google Calendar API → Enable.**
   3. **IAM & Admin → Service Accounts → Create service account**: name it `home-hub-sync` and give it no roles.
   4. Open it → **Keys → Add key → Create new key → JSON**. The file downloads. If Google says "Service account key creation is disabled", stop here and tell Claude: the hub then signs in another way.
   5. Check that **Keys** lists exactly one key.
   6. **IAM → Grant access**: the other parent's Google account, role **Owner**, so the project doesn't depend on one person. They accept the invitation email; then check that **IAM** lists them as Owner (until they accept, the project still depends on one person).

B. **The secret.** Supabase → **Edge Functions → Secrets**: add `GOOGLE_SA_JSON`. Its value is the whole JSON file: open it in a text editor, select all, copy, paste. Then delete the file and empty the trash. Never email it, put it in a chat or commit it.

**Between sittings: when the new site and hub-jobs are live**

C. **Database and schedule.** In the Supabase SQL editor, run `supabase/migrations/0003_google_calendar.sql`, then `supabase/cron.sql` again.

**Sitting 2: the calendars (about an hour)**

D. **One pass per calendar.** Open the hub's **Settings → Google Calendar & Hearth** next to Google Calendar (signed in as the family Gmail, on a computer). Do Taylor's first, then Alex, Morgan, Sam, Jordan and Family. For each row:
   1. In Settings, press **Copy** next to the name it suggests ("Hub – Taylor").
   2. In Google Calendar: **Other calendars → + → Create new calendar** → paste the name → **Create calendar**.
   3. Open that calendar's **Settings and sharing**:
      - **Share with specific people → Add people**: paste the hub's address (Settings has a **Copy** button for it) and choose **Make changes and see event details** (not "Make changes and manage sharing", and not "Make changes (see private events as free/busy)") → **Send**.
      - **Event notifications** and **All-day event notifications**: remove every notification, or every phone signed in to the family account rings for every hub item.
      - **Integrate calendar → Calendar ID**: copy it.
   4. In Settings, **Set** on that row → paste → **Save**. The hub tests the calendar, shows its name in Google, then lists everything it will copy there: yesterday to 60 days ahead (later days follow as they come). Press **Make private** on anything that shouldn't be on the wall (health, trips and away days, anything with a code or money), then **Start copying**. Make private changes the item itself: kids and helpers then see only "Private item" for it, even for their own, on every day it repeats. To keep a project's jobs off the wall, untick **Show in Home Hub calendar** on the project.
   If, after sharing it with **Make changes and see event details** (step 3), Taylor's Test still says "Home Hub can't change this calendar", "Shared correctly, but Google won't let Home Hub add an event to it", "Google refused…" or "Google answered differently than expected", stop and tell Claude. (A Test that names "Make changes (see private events as free/busy)" only means that option was chosen: share it again with **Make changes and see event details**.)

E. **The family account's main calendar.** Events typed on a phone usually land here. In Google Calendar, the family Gmail's own calendar → **Settings and sharing → Share with specific people**: the hub's address, **See event details**. Then in Settings → **Calendars to read → Family account's main calendar → Set** → the family Gmail address → **Save**.

Optional: **Pets and House**, only if pet or house tasks are often left with nobody in charge: make "Hub – Pets" and "Hub – House" the same way as step D.

Settings shows "Copying N items to Google…" for about 30 minutes after the first calendars are set.

**Sitting 3: Hearth (about 45 minutes, once Copying has reached 0)**

F. **Hearth.** In the Hearth Companion app, signed in as a parent whose profile will stay (if that profile is ever deleted, every calendar it connected leaves the wall):
   1. **Calendars**: note what is connected now, and from which profile. If the family Gmail is already connected, open it and tick the Hub calendars; don't add it a second time and don't untick anything. Otherwise **add Google**, sign in as the family Gmail, and tick the Hub calendars and the main calendar.
   2. Profiles: Taylor as a kid **without email** (never an adult profile), and a no-email profile called "Family".
   3. Give each Hub calendar to its person's profile, and Hub – Family and the main calendar to Family. Pets and House go to profiles of their own or to Family.
   4. Look at the wall, then time how long a change in the hub takes to reach it (use **Resync** in the app if needed). Add one event on the wall in Jordan's column, and see whether, and in which calendar, it shows up in Google Calendar. If it does, add that calendar under **Calendars to read**; if not, add events in the hub or in Google, not on the wall.

G. **Phones** (optional). Share Hub calendars with people's own personal Google accounts (never a school or work account): each parent gets **Make changes and see event details** on every Hub calendar; everyone else gets **See event details** on their own. Each person sets that calendar's notifications on their phone. Parents: keep Family and your own calendar shown and hide the rest, or events with two people show twice.

### What Settings says

| It says | What it means |
|---|---|
| **Not set up:** add the Google key… | `GOOGLE_SA_JSON` isn't in hub-jobs' secrets (step B). Add it, then press **Sync now**. |
| In red: "Google refused the key…", "GOOGLE_SA_JSON isn't a service-account key…", "The Google Calendar API isn't turned on…" | The last run stopped. Do what it says: make a new key (step A.4) and replace the secret, paste the whole file again, or turn the API on (step A.2). |
| Signed in as `home-hub-sync@…` · key …a1b2c3 | The address to share each Hub calendar with, and the end of the key's id: Cloud Console's **Keys** tab must list exactly one key, ending the same way. |
| Not checked yet · Waiting: press Preview, then Start copying · Connected | Press **Test**; press **Preview**, look at what it copies and press **Start copying**; all is well. |
| Can't reach it | The calendar isn't shared with the hub's address, or only to see events, or with "Make changes (see private events as free/busy)". Share it with **Make changes and see event details** (a calendar it only reads: **See event details**). The hub notices by itself within an hour. |
| Problem | Usually the calendar's name doesn't start with "Hub" (the hub writes only to calendars named "Hub …"), or it was shared with "Make changes and manage sharing". Rename it, or share it again with **Make changes and see event details**. While it is a Problem, the hub still takes off what it put there that was made private or deleted. |
| "This calendar is called 'Hub – Jordan'. Is that Taylor's?" | The Calendar ID on that row may be the wrong one. **Set** it again with the right one. |
| Copying N items to Google… / Hiding N items in Google… | The first copy, or a burst of changes, is on its way: up to 60 changes every 5 minutes, nearest days first, private ones first. |
| Paused by Google until 3:40pm | Google asked the hub to slow down. It carries on by itself. |
| Last synced more than 30 minutes ago… | The calendar job isn't running: run `supabase/cron.sql` again, and check hub-jobs was deployed with JWT verification off (see the log below). |
| Waiting for the hub-jobs update | The hub-jobs that is deployed is from before v1.1, or isn't deployed: deploy it. |
| **Problems** | Items Google refused, with its reason. Each is tried again by itself, further apart each time. The parents' morning email mentions one only after 24 hours. An item that keeps failing until its day has passed is dropped from the list: Google keeps the copy it has, as for any past day. "Someone keeps changing it in Google" means a family member keeps editing it on a phone: change it in the hub instead. |
| **Changed in Google and put back** | Someone changed or deleted one of the hub's events in Google, and the hub put it back. Change it in the hub instead; to skip one day of a repeat, use **Skip this day**. |
| **Projects with stale dates** | That project's work isn't updated on Google until the project is opened in Projects. |

The parents' morning email also says "Google Calendar isn't up to date…" when the last good sync is more than 2 hours old or a calendar can't be reached, and lists what was put back.

### Day to day

- **Mark Private** in the hub anything about health, trips and away days, or with codes or money: everyone in the house sees the wall, including the helper and visitors. Google's own Private setting doesn't hide anything on the wall, because Hearth reads each calendar as its owner. Any member can change an item, and from yesterday onward the change reaches the wall within 5 minutes. Earlier days stay on Google as they were: only Private or Delete takes a past item off.
- **To put an event in Jordan's column from Google,** choose "Hub – Jordan" in the event's calendar menu.
- **To end a repeat,** set its end date in the hub. Deleting it also takes its past days off Google.
- **Something missing from the wall?** In the Hearth app, press **Resync**.
- **A new person** needs a new Hub calendar, set in Settings, and ticked and given to their profile in the Hearth app.

### When a helper leaves

1. On the Family page, remove her: her Hub calendar goes with her, and the hub's events come off it. (Only turned off the list? Settings reminds you to **Disconnect** her calendar.) Give the next helper their own My day link.
2. In Google Calendar, stop sharing "Hub – Taylor" with her own Google account.
3. Delete her Hearth profile.
4. For the next helper, make a new Hub calendar rather than reusing the old one.

### Looking at the job, and stopping it

In the Supabase SQL editor:

```sql
-- The calendar job's last runs, and what hub-jobs answered (counts and fixed codes only)
select status, return_message, start_time from cron.job_run_details d
  join cron.job j using (jobid) where j.jobname = 'hub-calendar' order by start_time desc limit 10;
select status_code, error_msg, left(content, 300) as answer, created from net._http_response order by created desc limit 10;
-- What the job last did
select last_run_at, last_ok_at, last_stop, last_error, last_result from public.calendar_sync;
```

A 401 in `net._http_response` on every run means hub-jobs was deployed with JWT verification on.

To stop it: **Disconnect** a calendar in Settings (the hub's events are taken off it within a few minutes, if the hub can still reach it: one that says **Can't reach it** keeps them, so delete that calendar in Google Calendar, or share it again and wait for it to connect before you Disconnect), or stop the whole job with `select cron.unschedule('hub-calendar');` (what is already in Google stays). Migration 0003 only adds, so the site's pages work either way.

### Privacy

- **The wall is public in the house.** Copied: titles, times, an event's place, a project job's name, and a linked directory entry's name and business number. Never copied: notes and a day's own note, private items' and health tasks' titles and places, the family's phone numbers and emails, account numbers, My day and confirmation links.
- **The key is a password for every Hub calendar.** It lives only in Supabase's Edge Function secrets, never in this repository, the database, a chat or a log. To rotate it: Cloud Console → the service account → **Keys → Add key**, replace `GOOGLE_SA_JSON`, delete the old key, and check that Settings shows the new key id. If it ever leaks, delete it in Cloud Console at once: that revokes it.
- **The hub writes only** to a calendar that an admin set in Settings, whose ID ends in `@group.calendar.google.com` (never someone's main calendar), whose Google name starts with "Hub", that is shared with **Make changes and see event details** (which can't change sharing), and whose preview (everything it copies, yesterday to 60 days ahead) an admin looked at before pressing **Start copying**.
- **Reading is opt-in per calendar.** Only calendars an admin sets are read, and only ordinary events the calendar made or accepted: an invitation from a stranger never reaches an email or a helper's My day. A Google event marked private is kept without its title or place. A place from Google is shown as plain text, never as a link.
- **No attendees and no reminders** are ever set, so Google sends nobody an invitation or an email.
- **Phones:** share Hub calendars only with personal Google accounts, never a school or work account. Never turn on **Make available to public**, and never hand out the **Secret address in iCal format**.

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
| `assets/modules/` | The hub's pages, one file each. v2: `today.js`, `calendar.js`, `tasks.js`, `projects.js` (v1 and v2), `directory.js`, `people.js` (Family), `settings.js`; v1.2: `food.js` (Food). v1: `home.js`, `contractors.js`, `family.js`. Each page shows only for the database version it was made for |
| `assets/shoplist.js` | The shopping list's shared pieces, for the Food page and My day: aisles in English and Spanish, grouping, and the outbox that keeps changes on the phone until they are sent |
| `assets/styles.css`, `assets/css/` | Styles with automatic light and dark mode: the shared ones, then one file per v2 page (`food.css` for Food) |
| `day.html`, `assets/day.js` | The public My day page for kids and helpers (no sign-in; the link carries the person's code), with the helper's shopping list (`#list`) |
| `share.html` | The public, read-only project page |
| `assets/gantt.js` | Schedule engine and Gantt chart, shared by the hub and the share page |
| `manifest.webmanifest`, `assets/icons/` | The Home Screen app: name, colours and icons |
| `config.js` | Database connection settings |
| `supabase/schema.sql` | The v1 tables, security rules and functions (the baseline) |
| `supabase/migrations/` | Every database change since, in order: `0002_home_hub_v2.sql` is v2, `0003_google_calendar.sql` is v1.1 (Google Calendar), `0004_meals_and_shopping.sql` is v1.2 (Food) |
| `supabase/preflight.sql` | Read-only checks to run before applying the v2 migration (0002 only) |
| `supabase/cron.sql` | Schedules the morning email and the Google Calendar job (pg_cron) once hub-jobs is deployed |
| `supabase/config.toml` | Supabase CLI settings: both Edge Functions deploy with JWT verification off |
| `supabase/functions/hub-jobs/` | Edge Function for the morning email (sending, preview and status) and the Google Calendar job: `handler.ts` checks who is asking, `render.ts` makes the email, `calendar.ts` runs the calendar job and Test, `google.ts` signs in to Google and calls it, `util.ts` holds what they share |
| `supabase/functions/send-email/` | Edge Function that sends email through Resend |
| `supabase/email-templates/` | The sign-in email, for Supabase's email templates |
| `docs/v2-design.md` | The v2 design: what was built and why |
| `docs/v1.1-google-calendar.md` | The v1.1 design: Google Calendar and Hearth |
| `docs/v1.2-kitchen.md` | The v1.2 design: Food, dinners and the shopping list |
| `.mcp.json`, `.claude/settings.json` | Supabase access for Claude Code sessions (token comes from the environment) |
| `tests/` | Automated tests: run `tests/run.sh` (see [`tests/README.md`](tests/README.md)) |
| `CLAUDE.md` | Rules for changing this repo: tests, migrations, deploy order, test data |
