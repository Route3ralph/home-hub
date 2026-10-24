# Home Hub

A private family web app for running the house: projects with Gantt schedules, a contractor directory, and the list of family members who can sign in.

- **Hub (family only):** https://route3ralph.github.io/home-hub/
- **Share links (for contractors):** each project can have its own read-only link, made from the project's **Share** button.

## Using it

| To… | Do this |
|---|---|
| Sign in | Enter your email, then click the link that arrives. Each device stays signed in. |
| Start a project | **Home → + New project**. Start blank or copy an existing project's tasks. |
| Add or change a task | Open the project, click **+ Task**, or click any task, then **Edit task**. |
| Record progress | Click a task, then **Mark done** or **Mark in progress**. |
| Lock in a contractor's date | Edit the task and set **Confirmed start date**. Later tasks reflow automatically. |
| Link a contractor to a trade | Project → **Trades & contractors** |
| Send a contractor their dates | Project → **Share** → turn on, copy the link. On the shared page, tap a trade to get a link showing only that trade. |
| Add someone to the family | **Family → + Add family member** (admins only) |

Each task has two kinds of notes. **Notes** appear on the shared link. **Private notes** are family-only and never shared, so they're the place for gate codes and similar details.

## Messaging contractors

A **Message** button appears in three places: a project's Team cards, a task's details, and the Contractors page. It drafts a note with that contractor's upcoming dates and, if sharing is on, a link to their part of the live schedule. Edit the draft, then choose how to send it:

- **Text** or **WhatsApp** opens the app on your phone with the message ready to send.
- **Open in my email** does the same with your email app.
- **Send email now** sends it from the hub through SendGrid, with your address set for replies. This only appears once SendGrid is set up (see below).

The first three come from your own phone number or email address, so replies come straight back to you, and they need no setup.

## How the data is protected

- Everything lives in a Supabase database. Every table has row-level security, so only emails on the family list can read or change anything. Signed-out visitors and other accounts see nothing.
- The share page can read one project by its secret link. It returns only the schedule plus each contractor's name and company. It never returns phone numbers, emails or private notes. Turning sharing off, or clicking **Get a new link**, stops the old link immediately.
- This repository is public, but it contains only code. `config.js` holds a *publishable* key, which is designed to be public. Never put a `service_role` or secret key in this repo.

The rules are in [`supabase/schema.sql`](supabase/schema.sql).

## One-time setup

1. **Create a Supabase project.** Then run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor.
2. **Add yourself as the first admin.** In the SQL editor:
   `insert into members (email, name, role) values ('you@example.com', 'Your Name', 'admin');`
3. **Connect the site.** Put the project URL and publishable key in [`config.js`](config.js).
4. **Set the sign-in redirect.** In Supabase, open **Authentication → URL Configuration**:
   - Set **Site URL** to `https://route3ralph.github.io/home-hub/`.
   - Add the same address under **Redirect URLs**.
5. **Recommended: block strangers from creating logins.** Go to **Authentication → Hooks → Before User Created → Postgres function** and choose `hook_family_only_signup`.
6. **Publish.** In GitHub, open **Settings → Pages** and deploy from branch `main`, folder `/ (root)`.

The kitchen renovation's starting schedule is in [`supabase/kitchen-renovation.json`](supabase/kitchen-renovation.json).

## If the hub says it can't reach the database

On Supabase's free plan, a project that sees little use for about a week gets **paused**. Supabase emails a warning first, and nothing is lost. To resume it, open the [Supabase dashboard](https://supabase.com/dashboard), select the project and click **Resume project**. Regular family use keeps it awake.

## Email through SendGrid (optional)

Out of the box, sign-in emails come from Supabase's built-in sender, which allows only a few per hour. SendGrid removes that limit and makes **Send email now** work.

1. **Authenticate a domain you own** in SendGrid: **Settings → Sender Authentication → Authenticate Your Domain**, which adds a few DNS records. Don't send "from" a gmail.com address: SendGrid warns those messages are likely to be rejected or marked as spam.
2. **Create an API key** with *Mail Send* permission: **Settings → API Keys**.
3. **Sign-in emails.** In Supabase, open **Authentication → Emails → SMTP Settings** and enter:
   - Host: `smtp.sendgrid.net`
   - Port: `587`
   - Username: `apikey`
   - Password: your API key
   - Sender: an address on your domain
4. **Emails from the hub.** In Supabase, open **Edge Functions → Secrets** and add:
   - `SENDGRID_API_KEY`
   - `EMAIL_FROM` (an address on your domain)
   - `EMAIL_FROM_NAME` (optional; defaults to "Home Hub")
5. **Deploy and switch on.** Deploy [`supabase/functions/send-email`](supabase/functions/send-email), then set `emailSending: true` in [`config.js`](config.js).

The function only sends for signed-in family members. It sets each email's reply-to address to whoever sent it, sends to at most 10 people at a time, stops after 50 emails in 24 hours, and records every send in the `email_log` table.

Paste API keys only into SendGrid and Supabase, never into this repository or a chat.

## Texting

The **Text** and **WhatsApp** buttons use your own phone, so they need no setup and cost nothing. Having the hub send texts *on its own* is a different matter: for example, an automatic reminder the day before a contractor arrives. In the US that requires a messaging provider such as Twilio, with your number registered under the A2P 10DLC rules. WhatsApp would require Meta's Business Platform, with pre-approved message templates and per-message fees. Neither is set up.

## Files

| File | What it is |
|---|---|
| `index.html`, `assets/hub.js` | The private hub |
| `share.html` | The public, read-only project page |
| `assets/gantt.js` | Schedule engine and Gantt chart, shared by both pages |
| `assets/styles.css` | Styles, with automatic light and dark mode |
| `config.js` | Database connection settings |
| `supabase/schema.sql` | Tables, security rules and functions |
| `supabase/functions/send-email/` | Edge Function that sends email through SendGrid |
