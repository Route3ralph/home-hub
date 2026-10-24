# Home Hub

A private family web app for running the house: projects with Gantt schedules, a contractor directory, and the list of family members who can sign in.

- **Hub (family only):** https://route3ralph.github.io/home-hub/
- **Share links (for contractors):** each project can have its own read-only link, made from the project's **Share** button.

## Using it

| To… | Do this |
|---|---|
| Sign in | Enter your email, then type the code from the email that arrives. Each device stays signed in. |
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
- **Send email now** sends it from the hub through Resend, with your address set for replies.

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
6. **Set up email.** This step is required: see [Email through Resend](#email-through-resend) below.
7. **Publish.** In GitHub, open **Settings → Pages** and deploy from branch `main`, folder `/ (root)`.

The kitchen renovation's starting schedule is in [`supabase/kitchen-renovation.json`](supabase/kitchen-renovation.json).

## If the hub says it can't reach the database

On Supabase's free plan, a project that sees little use for about a week gets **paused**. Supabase emails a warning first, and nothing is lost. To resume it, open the [Supabase dashboard](https://supabase.com/dashboard), select the project and click **Resume project**. Regular family use keeps it awake.

## Email through Resend

Supabase's built-in email sender only delivers to people on your Supabase organization's team, and only a few messages an hour, so family members can't get sign-in codes without a sender of your own. Resend's free plan (3,000 emails a month, up to 100 a day) is plenty. It sends the sign-in emails and powers **Send email now**.

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

**Why a code and not a link.** Email security scanners, such as Microsoft's in Outlook and Microsoft 365, open the links in new mail to check them. A sign-in link works only once, so a scanner can use it up before you tap it, and you'd see "Email link is invalid or has expired". The code is the same one-time token, so the email deliberately has no sign-in link for a scanner to open.

Paste API keys only into Resend and Supabase, never into this repository or a chat.

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
| `supabase/functions/send-email/` | Edge Function that sends email through Resend |
| `supabase/email-templates/` | The sign-in email, for Supabase's email templates |
