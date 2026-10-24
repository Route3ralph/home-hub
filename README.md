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

## Sign-in emails

Supabase's built-in email sender allows only a few sign-in emails per hour. That's fine for a family, since each device stays signed in. If you hit the limit, wait a little and try again, or set up your own email sender under **Authentication → Emails → SMTP Settings**.

## Files

| File | What it is |
|---|---|
| `index.html`, `assets/hub.js` | The private hub |
| `share.html` | The public, read-only project page |
| `assets/gantt.js` | Schedule engine and Gantt chart, shared by both pages |
| `assets/styles.css` | Styles, with automatic light and dark mode |
| `config.js` | Database connection settings |
| `supabase/schema.sql` | Tables, security rules and functions |
