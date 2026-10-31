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
| **Homework** (v1.3) | Jordan's assignments in small steps, a focus timer on his My day, points and rewards, and a link for his tutor: see [Homework](#homework-plans-focus-sessions-and-points-v13). |

**Event or task?** The ＋ button asks first. *Piano, pickups, appointments → Event. Pills, filters, chores, calls → Task.* With v1.2 it also offers **Shopping**, for something to buy.

**My day.** A kid or helper opens their link (no password, nothing to install) and sees their today and tomorrow in their language. They can tick off their own tasks, with Undo. "Add to Home Screen" keeps it one tap away. If the link ever gets passed around, **New link** on the Family page stops the old one at once.

**Morning email.** Anyone with an email address can get their day before breakfast (or tomorrow's plan in the evening). Parents also get a block per kid or helper with Send buttons, what nobody is on, and the project lines. The first email asks the person to confirm their address; signing in to the hub confirms it too. Every email has a link to stop them.

**On a phone.** The bottom bar has Today · Calendar · ＋ · Tasks · More (with v1.2: Today · Calendar · ＋ · Tasks · Food · More; with v1.3, Homework is under More). Add the hub to your Home Screen (Settings explains how on iPhone and Android) and it opens like an app.

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

## Homework: plans, focus sessions and points (v1.3)

The **Homework** page helps Jordan with big homework: a two-week project broken into small steps he can start, a timer for working in short blocks, and points he trades for rewards the parents list. Pat Lee, his tutor, plans with him through a link of Pat's own. It turns on by itself once the database is upgraded to v1.3 (see [Turning on Homework](#turning-on-homework)). On a phone it is under **More**; on a computer it is a tab after Food. The design, with every rule, is [`docs/v1.3-homework.md`](docs/v1.3-homework.md).

It is help with starting, timing and planning that suits any kid. Nothing in the hub gives anyone a medical or learning label, and nothing asks for one.

**What Jordan sees (on his My day)**
- A **Homework** card under his greeting: tonight's steps and minutes, his points, the next step with its own **Start** (one tap from My day to a running timer), and the **next-reward bar**: "6 points to A new book", or "You can get 15 minutes of extra game time now!". The bar is on every homework screen.
- **Open ›** shows **Now** (the next step, what "done" looks like, his own start cue, and one big **Start**: 10, 15, 20 or 25 minutes, 10 offered first, alone, with Pat or with a parent), **Tonight**, **From earlier** (folded; **Re-plan** puts his steps on the next homework days with room), and **Due soon**, with two bars: the work left and the homework time left before it's due.
- **+ Homework:** he writes down tonight's homework himself (what, class, due date, about how many minutes). **Quick** makes a small one tonight's step in one tap; anything due 4 or more days out he plans with Pat.
- **The timer** is a ring that shrinks. It counts from the hub's clock, so it's right whenever he looks, even after the phone was locked. Under it his points count up while he works ("★ 118 +12 so far", a point a minute, never more than the hub will pay). **I'm stuck** opens his own if-stuck plan and three ways on: **Make it smaller** (a tiny first piece; the timer moves to it), **Ask Pat** (a short question Pat answers on the link) and **Next step**. **The second the ring runs out he is paid**: his balance counts up to the new total, a "+30" pops up, and a short sound plays if sound is on. Then **Step done** and **More to do** (they earn the same), with an optional "what I got done".
- A step's box ticks it (with **Undo** for 15 minutes); **Not today** moves a plain step to the next homework day with room. He can rename, move and add plain steps. **Milestones** are checkpoints he sets with Pat: their days stay put until they change them together. Ticking one pays half its points at once ("+20 now · +20 more when Pat checks it").
- **Points** (★): his balance, the rewards (**Get it now** on an instant one, which is his on the spot; **Ask** on the others, and a parent says yes), and **Suggest a reward** (a parent prices it).
- His screen says who sees what: "Pat and the grown-ups in your family see your plan and your notes. The grown-ups see your points."

**What Pat sees (the tutor link)**
- A link with no sign-in that shows only Jordan's homework, in a fixed order, so a check-in takes under 15 minutes: **To check** (milestones he ticked: **Looks done**, with a word about the work, or **Not yet**, saying what's missing), **To talk about** (a milestone his steps can't reach any more), **Questions** (**Answer**), plans to look at, his assignments (Pat can add assignments and lessons, plan them with him from a starter plan, and **Give Jordan this plan**), his homework time for two weeks with his other commitments shown only as "Busy", and his finished blocks of the last 14 days.
- With the [AI planner](#the-ai-planner-v13-optional) on, and **Can ask the AI** on for the link: **Send to Claude** on an assignment, for a draft Pat checks with Jordan.
- Never: points, rewards, family names, the family's events, phone numbers, or whether he is working right now. (With the [coach view](#the-coach-view-v13-migration-0007) on, Pat also sees his points, rewards, focus sessions, his own calendar and his daily tasks, and still nothing of anyone else.)
- **Open it on your own phone or computer**, not Jordan's or a shared one. It ends after 180 days (the family can **Extend** it); if it is ever passed around, **New link** on the Homework page stops the old one at once.

**What the parents do (the Homework page)**
- **Turn on homework for Jordan**, then set his **homework time**: an ordinary repeating event in his name ("Homework", Mon–Thu 4:30–5:15), which shows on his My day, the Calendar page, the morning email and the wall like any event. Change it, skip a day or make a one-day change on the Calendar page (**Change** opens it there); tick **Private** on it if the wall shouldn't name it. Steps are placed only into homework time, less his other timed events that day (piano, tutoring with Pat), up to 8 weeks ahead.
- **+ Assignment** or **+ Lesson:** title, class, due date (a lesson's "do by" day), and the teacher's text, pasted. To use a photo of the sheet, copy its text with the phone's Live Text and paste it: photos aren't sent anywhere.
- Plan it with Jordan: **Start from a starter plan** (Essay or project, Test, Reading, Practice, Short), rename each step to the real work ("Find 2 sources and save their links"), set one to four milestones, then **Give Jordan this plan**. Until then he sees "Being planned". **Place again** puts the steps not done on homework days again (after a due date moves, or a week went sideways).
- **To approve:** his asks for rewards, with his balance and where this week's points came from beside each, **Yes** or **Not now** (also on **Today**). An instant reward he got shows on **Today** ("Jordan cashed in: 15 minutes of extra game time · 15 · 4:52pm") and in **Recent**, with nothing to decide. **To check:** milestones he ticked. **Questions and notes:** his open questions, and every answer and note Pat or a parent wrote to him in the last 7 days, with who wrote it.
- **Points and rewards:** **Give points** (with a note he sees, for what the rules can't see) and **Void** (a correction with a reason he sees, never a penalty); the rewards, in three sizes to start, each **Instant** or not (an instant one he gets on the spot, at most 2 a day).
- **Switches:** homework on or off, points on or off and their values (with the instant rewards a day and the focus length offered first), the tutor's link (**Copy**, **WhatsApp**, **Text**, **New link**, **Off**, **Extend 180 days**, **Can ask the AI**), the [AI planner](#the-ai-planner-v13-optional), and **Erase Jordan's homework** (type ERASE; the homework-time events stay on the calendar, and Erase also deletes his AI run records).
- Sam sees all of it, read-only. Taylor's link shows none of it.

**Points**

| What | Points |
|---|---|
| A focus block on a step or an assignment | 1 for every minute the hub saw, paid the second the block ends, whatever he answers then (a 20-minute block is 20) |
| Starting the day's first block on time: from 30 minutes before to 10 minutes after his homework time starts (when piano runs into it, after piano ends, plus 15 minutes) | +10, paid once 5 minutes of it are done |
| A milestone | +40: +20 when he ticks it, +20 when Pat or a parent checks it |
| At most | 60 a day from blocks and on-time starts; 160 a week from milestones |

Nothing is ever taken away: **Not yet** on a milestone keeps the 20 his tick paid, and taking a check back removes only what the check paid, never below zero. There are no streaks to break, and nothing earns for grades, for making steps, or for a block on something that isn't homework (his own projects keep the timer, without points). About 340 to 380 points in two weeks; a homework day earns 30 to 50. Start with rewards in three sizes, for example "15 minutes of extra game time · 15" (instant), "Pick the movie · 200" and "A trip to the water park · 500". **Instant rewards** are his on the spot (the points go at once, from his free points, at most 2 a day; you see each one on Today); the others he asks for and a parent says **Yes** or **Not now**. Each value is yours to change on the switches card. Tell Jordan at the start that you'll look at the points with him after a term; a change agreed then isn't a penalty.

**Where he works, and his reminder**
- **On his phone:** face up beside him, with a **Focus scheduled for his homework time**, so other apps stay quiet while the ring runs. iPhone: **Settings → Focus → + → Custom**, name it "Homework" → **Add Schedule** → the same days and times as his homework time. Android: **Settings → Do Not Disturb** (or **Modes**) → **Schedules** → the same days and times.
- **On a family computer:** My day in its own small window beside his work. It can show a notification when a block ends (it asks once).
- **Not on a school-managed laptop:** its web filter may log the addresses he opens, and his My day address carries his link.
- **A web page can't ring at 4:30**, or while the phone is locked. Set a **repeating alarm on his phone, "Homework: open My day"**, at his usual time. Optionally, on an iPhone: **Shortcuts → Automation → + → Alarm** → "Homework" → **Is Stopped** → **Run Immediately** → **Open URLs** → his My day link with `#homework` at the end, so stopping the alarm opens his homework. Try it on his phone.
- Add My day to his Home Screen. During a block the screen stays on where the phone allows it; where it doesn't, the timer is right when he looks. The silent switch may mute the chime at the end; the end always shows on the screen.

### Turning on Homework

The order matters (the design's §16.1). The owner's part is about 25 minutes, plus 5 if Food isn't on yet:
1. `tests/run.sh` ends with `0 failed`; merge. The site stays on schema 3 or 4: no Homework tab, no new request, My day as before.
2. Nothing to deploy: hub-jobs and `supabase/cron.sql` don't change.
3. **Only if Food (v1.2) isn't on yet, about 5 minutes:** run [`supabase/migrations/0004_meals_and_shopping.sql`](supabase/migrations/0004_meals_and_shopping.sql) first ([Turning on Food](#turning-on-food)).
4. **About 5 minutes:** run [`supabase/migrations/0005_homework.sql`](supabase/migrations/0005_homework.sql) in the Supabase SQL editor. "isn't installed" means 0004 is missing; "already installed" means it's done; either way nothing was changed. Reload the hub: **More → Homework**.
5. **About 10 minutes, on a computer:** Homework → **Turn on homework for Jordan** → his homework time (days, from, to) → **Add** (a second time for Sunday if it differs) → three rewards (about 15 and instant, 200 and 500 points) → **+ Tutor link**: "Pat Lee, tutor" and Pat's language → **Make the link** → **WhatsApp** or **Text**.
6. **About 10 minutes, with Jordan:** add his real next assignment and paste the teacher's text → a starter plan → change a step → **Give Jordan this plan**. On his phone: My day shows the card; he types his start cue and if-stuck line; he taps **Start** on the card, watches his points count up, lets the ring run out and sees them arrive, taps **Step done**; he sees the next-reward bar and how **Get it now** works; he adds tonight's homework himself with **+ Homework** and **Quick**. Set the Homework Focus on his phone (2 minutes) and the repeating alarm.
7. **Tell Pat** (one message): the link shows only Jordan's homework; open it on your own phone or computer; plan at the next session; keep the link private.

To turn it off: **Homework for Jordan** off on the switches card hides his card and stops Pat's link at once, and deletes nothing. If the hub can't be reached, paste this in the Supabase SQL editor; it stops every homework function and link without deleting anything:

```sql
update public.homework_kids set active = false;
update public.household set homework_ai = false;
update public.tutor_links set active = false;
```

To hide the page altogether, follow the design's §16.3.

### The school's calendar links (v1.3, migration 0006)

Home Hub can read Jordan's assignments, and his class schedule and games, from the school's Blackbaud site, so his assignments appear on his My day as **New from school** and his classes and games are busy time when steps are placed. A parent's own login is enough.

**Turning it on** (`hub-jobs` and `supabase/cron.sql` change, so the order matters):
1. `tests/run.sh` ends with `0 failed`; merge. Nothing changes until step 3: the school parts show only on schema 6.
2. **Claude deploys `hub-jobs`** from main with JWT verification off, as before. There is **no new secret**: the links live in the database. Until step 3 its `school` action answers 503 `no_schema`, which is harmless.
3. **About 5 minutes:** run [`supabase/migrations/0006_homework_school.sql`](supabase/migrations/0006_homework_school.sql) in the Supabase SQL editor. "isn't installed" means 0005 is missing; "already installed" means it's done; either way nothing was changed.
4. **About 2 minutes:** run [`supabase/cron.sql`](supabase/cron.sql) again. It adds the `hub-school` job (every hour at 23 minutes past) and is safe to run again.
5. **About 5 minutes, on a computer, the links:** sign in to the school's Blackbaud site **as yourself** → under **Jordan's Calendars**, open **Calendar** → the feed button → **WebCal Feed for External Calendar** → under **Individual Filter Feeds**, right-click **Assignments** → **Copy Link Address** (not **Entire Calendar**). In Home Hub: **Homework → Switches → School links → Assignments** → paste → **Save**. Do the same for **Schedule** and **Games/Practices** if you like (busy time only). Then **Check now**, and answer the first-import check: the card shows the next five items, or, when fewer than five are due yet (a weekend or a holiday), the five latest ones, marked "was due" (from [migration 0008](#the-first-import-check-when-nothing-is-due-yet-v13-migration-0008); Blackbaud still lists past assignments, so you can compare those too); tap **Looks right** if their dates are the due dates Blackbaud shows (or **Use the first date**, or **One day off**). Nothing from the Assignments link reaches Jordan or Pat until you do.

**Treat each link like a password.** Anyone with it can read his calendar, and Blackbaud offers no way to cancel one. Home Hub keeps it where no page, no tutor link and no My day can read it back; it shows only the school's address and the link's last 4 characters ("…a1b2"), and never writes it to a log. To stop using one, **Remove** it on the switches card. Don't paste it anywhere else.

**Day to day:** the hub reads each link every hour; Blackbaud itself can take up to an hour to show a change. On Jordan's My day, **New from school** lists what's coming up: **Quick** (one tap: a small one becomes tonight's step), **Plan with Pat** (it goes on Pat's link) or **Hide**. Once an assignment is on his homework, the school's later changes (a new title, a new due date, the description) reach it, except anything you, Jordan or Pat changed by hand; a due date never moves by itself on an assignment with a plan (the page says "Due date moved", and you place it again). One taken off the school site stays, marked. The switches card says when each link was last read, how many items it had, and what went wrong, in words: "Blackbaud answered with a sign-in page" (the link was replaced at the school: copy it again), "came back empty: new school year?", "not checked for over 3 hours: run supabase/cron.sql again". If Assignments shows nothing, the school may need to switch on calendar feeds for families (the email to send is in the design's §11.2 C).

### The AI planner (v1.3, optional)

With it on, Pat or a parent can tap **Send to Claude** on an assignment and get a draft plan, usually in under a minute, from Anthropic's Claude. It drafts plans and nothing else: it never does the work for Jordan, and Jordan's own link can't ask it. The draft is labelled **"Draft · Suggested by AI (Claude). Check it with Jordan."** and becomes the plan only when a person saves it: **Use this plan** puts its steps in the editor (each marked AI until someone changes it), then **Save** or **Give Jordan this plan**; its optional question for him is copied too. **Ask again** sends a revision ("Smaller steps", "Fewer steps", "Nothing on Wednesday", "Start later", "More time for writing", a note, his answers to its questions): every step a person typed or changed comes back as the person left it. **Undo** puts the draft before back; **Dismiss** clears it. Every failure says why in a line and leaves **Start from a starter plan** where it always is. His My day says "Plan by Pat, with AI help" (or "Plan by your parents, with AI help") on a plan made from a draft.

**What is sent, and what never is.** One assignment at a time, only when someone taps the button: its title, class, kind and dates, the teacher's text, Jordan's free minutes per day (minutes only, never what fills the rest of his day), how long his steps take against the plan, his first focus length, and for a revision the plan as it stands, the request and his short answers. Before it leaves the database, every name Home Hub knows (the family's, the tutor link's) and every **Word never to send** becomes `[name]`, and email addresses, phone numbers, links and ids become `[email]`, `[phone]`, `[link]` and `[id]`. **What Claude will see**, above **Send to Claude**, shows exactly that text, open whenever it has changed since the last send; if it changes after it is shown (the school's update, an edit on another phone), **Send to Claude** shows it again and sends nothing until the next tap. Never sent: a name, the school's name (once it is a word never to send), Jordan's My day link or Pat's link, points, rewards, events, notes, or any other assignment. Anthropic doesn't train on it; it may keep it up to 30 days, or up to 2 years if its safety checks flag it. The hub keeps a record of each run (who asked, when, how it ended, its tokens and an estimated cost), never the text sent; the draft stays with the assignment until it is dismissed or 30 days pass.

**What it costs.** About 6 cents a plan, about $3–4 a month. The hub stops at 12 runs a day (10 from each tutor link), 8 for one assignment and 150 a month, and the spend limit you set at Anthropic (step 2) stops it at $15 a month whatever happens.

**Setting it up** (about 15 minutes, on a computer, once this release is live; the design's §6.12):
1. **Anthropic.** platform.claude.com: sign in as a parent → **Settings → Billing → Buy credits** ($10 lasts about three months), unless the family's plan includes API credits. Turn on auto-reload, or set a reminder for three months.
2. **Settings → Workspaces → Create workspace** "Home Hub" → open it → **Spend limits**: **$15 a month**, with an alert at $5.
3. In that workspace, create an API key named "homework" and copy it.
4. **Supabase:** **Edge Functions → Secrets** → name `ANTHROPIC_API_KEY`, paste, **Save** (no redeploy needed). Close the Console page. The key goes nowhere else: not in a chat, an email, the database or this repository.
5. **Home Hub:** **Homework → Switches → AI planner → Words never to send**: the school's name and its short form, and Jordan's teachers' names (2 to 40 characters each, up to 20).
6. **Test the AI planner.** It sends a made-up assignment (nothing about the family) and should answer "Working · claude-opus-5-5 · 18 s · about 3 cents". It works while the AI planner is still off.
7. Read the line under **AI planner**, then turn it on. It can't be turned on before steps 5 and 6. Each tutor link has its own **Can ask the AI** (on when the link is made).

**What the switches card says.** "AI planner: not set up (README → Homework)": the secret isn't there (step 4). "Anthropic refused the key. Make a new key and replace ANTHROPIC_API_KEY.": do that (steps 3 and 4). "This month's limit at Anthropic is reached": wait for next month, or raise the limit (step 2). "Anthropic says the account is out of credit": buy credits (step 1). It also shows this month's runs and their estimated cost, and today's count.

**To stop it:** the **AI planner** switch (every request stops at once; the starter plans keep working); or delete the key in Anthropic's Console (it stops at once); or remove the secret. **Erase Jordan's homework** deletes his run records; Anthropic's copy goes on its own schedule (above).

### The coach view (v1.3, migration 0007)

Pat is Jordan's tutor and also his coach for starting, timing and planning. With the **coach view** on for Pat's link, the link also shows, read-only, in a **Coach** section under the homework:
- his **points**: the balance, this week's and last week's by kind (focus, on time, milestones, given, voided, trades) and the last 30 days, without who gave or took them;
- his **rewards** (cost, instant or not) and his asks and cash-ins asked or decided in the last 30 days;
- his **focus sessions** of the last 30 days: the day, the assignment, the minutes he chose and the minutes the hub saw, how it ended, his note;
- **his own calendar**, the next 14 days and the last 7: what he is in charge of, or is the only one on with nobody in charge (an event he is only along on is the family's); private ones as "Private item";
- **his daily tasks**, today and the last 7 days, done or not, and before them the ones still late; private items and health tasks as "Private item".

Only his own days: a chore or a weekly event handed to him from Sam shows his days from the hand-over on, never Sam's from before (the hub notes who was in charge from 0007 on, so nothing from before it shows).

Never the rest of the family: no one else's events, tasks or names, no dinners, shopping list or contacts, and nothing live. Pat can also leave you a note ("suggest lowering the on-time bonus"), which shows under Pat's link on the Homework page with **Done**; that is all Pat can change. Jordan's screen then says what Pat sees too.

**Turning it on** (nothing to deploy: no Edge Function and no `cron.sql` change):
1. `tests/run.sh` ends with `0 failed`; merge. Nothing changes until step 2: the coach parts show only on schema 7.
2. **About 2 minutes:** run [`supabase/migrations/0007_homework_coach.sql`](supabase/migrations/0007_homework_coach.sql) in the Supabase SQL editor. "isn't installed" means 0006 is missing; "already installed" means it's done; either way nothing was changed. Every link's coach view starts **off**.
3. **About 1 minute:** Homework → **Switches** → **Tutor links** → Pat Lee, tutor → tick **Coach view** (off by default; turn it on for the tutor). Tell Pat (the Coach section shows the next time the link is opened) and Jordan.

To stop it for one link, untick **Coach view**: it stops at once, and Pat's link is as before. **Off** and **New link** stop the whole link, as always. If the hub can't be reached: `update public.tutor_links set coach = false;` in the SQL editor.

### The first-import check when nothing is due yet (v1.3, migration 0008)

The school links' first-import check (**Check the dates**) used to show only assignments still to come. A link added over a weekend or a holiday may hold only past ones (the hub keeps those due in the last 14 days), so the card had nothing to ask, and nothing from the link could reach Jordan or Pat until the school posted something new. From 0008 the card shows the next five, or, when fewer than five are due yet, the five latest, each marked "was due …", and says so; answer it as before. When it is still empty it says why: not read yet, read with nothing in it, or everything on it already past.

**Turning it on** (nothing to deploy: no Edge Function and no `cron.sql` change):
1. `tests/run.sh` ends with `0 failed`; merge. The page works as before on schema 7, and says why an empty check is empty.
2. **About 1 minute:** run [`supabase/migrations/0008_school_check.sql`](supabase/migrations/0008_school_check.sql) in the Supabase SQL editor. "isn't installed" means 0007 is missing; "already installed" means it's done; either way nothing was changed.

There is nothing to switch off: the answer only adds the past ones, and the page reads both. The design's §16.7 has the undo, if ever wanted.

### What goes where

- **Never in an email, a text or on the wall:** the teacher's text, steps, questions, notes, points, rewards or asks. Only the homework-time event shows there, as any event does.
- **Jordan's My day** never shows the teacher's text, and never a parent's name or email: notes are "Pat:" or "Your parents:".
- **Pat's link** never shows points, rewards, asks, family names, event titles (only "Busy"), or anything live, unless you turn on its coach view: then it also shows, read-only, his points, rewards and asks, his focus sessions, his own calendar's titles and his daily tasks (health tasks as "Private item"), and still never anyone else's, nor anything live.
- **Anthropic (Claude)**, only while the AI planner is on and only when someone taps **Send to Claude**: what **What Claude will see** shows, nothing else (see [the AI planner](#the-ai-planner-v13-optional)).
- **Everyone who signs in** reads the Homework page; only the parents change it.
- **The school links** are never shown again once saved, not even to the parents: only "…a1b2". An assignment's description from the school is its teacher's text: for the grown-ups and Pat, never on Jordan's screen.
- **How long things are kept:** the teacher's text until 30 days after the due date; done and dropped assignments, focus blocks, questions and notes 180 days; points until **Erase**.

## Messaging contractors

A **Message** button appears on a project's Team cards and in a schedule task's details (and on the Contractors page before v2). It drafts a note with that contractor's upcoming dates and, if sharing is on, a link to their part of the live schedule. Edit the draft, then choose how to send it:

- **Text** or **WhatsApp** opens the app on your phone with the message ready to send.
- **Share** opens your device's share menu with the same message, for WhatsApp Business or any other app. It appears wherever the browser has a share menu (phones, and some desktop browsers such as Safari on a Mac), beside every WhatsApp button that sends a ready message.
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
- **Homework (v1.3)** is read by every grown-up who signs in; only the parents change it. Jordan's My day shows his own homework and points, never the teacher's text or anyone's email. The tutor's link shows only Jordan's homework: never points, rewards, family names, the family's events or anything live; it ends after 180 days, and **New link** or **Off** stops it at once. Nothing about homework goes into an email, a text or onto the wall, except the homework-time event, as any event.
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
   - `ANTHROPIC_API_KEY` (optional, for v1.3's [AI planner](#the-ai-planner-v13-optional)): the key from the family's Anthropic workspace (step 4 there). Without it the `homework_ai` action answers `not_set_up` and everything else works.
5. Create two Vault secrets by hand (`hub_cron_secret`, with the same value as `HUB_CRON_SECRET`, and `hub_jobs_url`), then run [`supabase/cron.sql`](supabase/cron.sql). Its header shows the exact commands. It refuses to run with a missing or placeholder secret and is safe to run again. Run it again after a release that changes it: v1.1 adds the `hub-calendar` job, and v1.3's school feed (migration 0006) the `hub-school` job.
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
| `assets/modules/` | The hub's pages, one file each. v2: `today.js`, `calendar.js`, `tasks.js`, `projects.js` (v1 and v2), `directory.js`, `people.js` (Family), `settings.js`; v1.2: `food.js` (Food); v1.3: `homework.js` (Homework). v1: `home.js`, `contractors.js`, `family.js`. Each page shows only for the database version it was made for |
| `assets/shoplist.js` | The shopping list's shared pieces, for the Food page and My day: aisles in English and Spanish, grouping, and the outbox that keeps changes on the phone until they are sent |
| `assets/plan.js` | Homework's shared pieces, for the Homework page, My day and the tutor link: the plan editor, the starter plans, the week strip and the two bars, the timer's arithmetic, the tutor's view, and their words in English and Spanish |
| `assets/styles.css`, `assets/css/` | Styles with automatic light and dark mode: the shared ones, then one file per v2 page (`food.css` for Food; `plan.css` and `homework.css` for Homework) |
| `day.html`, `assets/day.js` | The public My day page for kids and helpers (no sign-in; the link carries the person's code), with the helper's shopping list (`#list`) and a kid's homework (`#homework`, `#focus`, `#points`); and the tutor's link (`day.html?h=…`), which shows one kid's homework only |
| `share.html` | The public, read-only project page |
| `assets/gantt.js` | Schedule engine and Gantt chart, shared by the hub and the share page |
| `manifest.webmanifest`, `assets/icons/` | The Home Screen app: name, colours and icons |
| `config.js` | Database connection settings |
| `supabase/schema.sql` | The v1 tables, security rules and functions (the baseline) |
| `supabase/migrations/` | Every database change since, in order: `0002_home_hub_v2.sql` is v2, `0003_google_calendar.sql` is v1.1 (Google Calendar), `0004_meals_and_shopping.sql` is v1.2 (Food), `0005_homework.sql` is v1.3 (Homework), `0006_homework_school.sql` its school feed, `0007_homework_coach.sql` its coach view and `0008_school_check.sql` its first-import check when nothing is due yet |
| `supabase/preflight.sql` | Read-only checks to run before applying the v2 migration (0002 only) |
| `supabase/cron.sql` | Schedules the morning email and the Google Calendar job (pg_cron) once hub-jobs is deployed |
| `supabase/config.toml` | Supabase CLI settings: both Edge Functions deploy with JWT verification off |
| `supabase/functions/hub-jobs/` | Edge Function for the morning email (sending, preview and status) and the Google Calendar job: `handler.ts` checks who is asking, `render.ts` makes the email, `calendar.ts` runs the calendar job and Test, `google.ts` signs in to Google and calls it, `util.ts` holds what they share |
| `supabase/functions/send-email/` | Edge Function that sends email through Resend |
| `supabase/email-templates/` | The sign-in email, for Supabase's email templates |
| `docs/v2-design.md` | The v2 design: what was built and why |
| `docs/v1.1-google-calendar.md` | The v1.1 design: Google Calendar and Hearth |
| `docs/v1.2-kitchen.md` | The v1.2 design: Food, dinners and the shopping list |
| `docs/v1.3-homework.md` | The v1.3 design: Homework, plans, focus sessions and points, and the tutor's link |
| `.mcp.json`, `.claude/settings.json` | Supabase access for Claude Code sessions (token comes from the environment) |
| `tests/` | Automated tests: run `tests/run.sh` (see [`tests/README.md`](tests/README.md)) |
| `CLAUDE.md` | Rules for changing this repo: tests, migrations, deploy order, test data |
