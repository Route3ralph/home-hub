# Working on Home Hub

A private family web app (static site on GitHub Pages + Supabase). See `README.md` for what it does and `docs/v2-design.md` for the v2 build contract.

## Before every PR

- Run `tests/run.sh` and make sure it ends with `0 failed` and exit status 0 (about 9 minutes). It runs, in order:
  - the database tests (`tests/db/run.sh`): RLS, functions, recurrence in a throwaway Postgres;
  - the contract check (`tests/contract/check.sh`): every `.rpc()` / `.from()` in the site and the Edge Functions names a function or table that exists in the migrated schema, with argument names it takes, and that the caller (signed out, signed in, Edge Function) may use. Rename a function or a parameter and this fails until every caller is updated;
  - the Edge Function tests (`tests/fn/*.test.ts`);
  - the browser tests (`tests/e2e/*.test.js`), against a JavaScript fake of Supabase (`tests/e2e/mock.js`);
  - the real-database tests (`tests/realdb/run.sh`): the same pages in Chromium against the real schema, migrations, RLS and functions, so the fakes can't drift unnoticed (about 1.5 minutes);
  - the docs check (`tests/docs/*.test.js`): this file, `README.md` and `docs/v2-design.md` against the code (deploy secrets, test suites, function signatures, tables and columns), and the function signatures in `docs/v1.1-google-calendar.md`.
  `tests/run.sh fn e2e` runs only the suites named. See `tests/README.md`.
- New behaviour gets new tests. Never weaken or delete an existing check to make a change pass; fix the code, or explain in the PR why the old expectation was wrong.

## Database changes

- `supabase/schema.sql` is the v1 baseline. Don't edit it for new work.
- Every schema change is a new, numbered file in `supabase/migrations/` (`0002_home_hub_v2.sql`, `0003_google_calendar.sql`, `0004_meals_and_shopping.sql`, then `0005_…`). A fresh install is `schema.sql` followed by `migrations/*.sql` in order.
- `supabase/preflight.sql` is for 0002 only (a v1 database before v2). 0003 and 0004 check for themselves: each refuses to run without the one before it, or twice, and any clash rolls it back.
- Migrations are additive, so the site that is already live keeps working until it is updated, and each runs in one transaction.
- Follow the rules in `docs/v2-design.md` §3: RLS on every table, `set search_path = ''` on every function, and explicit `revoke … from public, anon` / `grant … to authenticated` on every new public function.
- Keep `docs/v2-design.md` in step: a new or changed table, column or public function, or a changed signature, goes in it in the same PR (the docs check names what's missing).

## Deploy order (needs Supabase access; from `docs/v2-design.md` §7)

0. Move the project into the paid organization (owner); confirm the URL and project ref are unchanged.
1. Run `supabase/preflight.sql` (read-only checks) and `list_migrations`.
2. Merge the client PRs. The site stays in v1 mode until step 3 (the core reads `hub_schema_version()`; when it's missing, the site shows the v1 pages).
3. Apply the migration (the site switches to v2 on next load).
4. Deploy `hub-jobs` from main with verify_jwt false (`supabase/config.toml` pins it for the CLI; with the dashboard or the Supabase MCP's `deploy_edge_function`, whose default is true, turn it off by hand). Secrets: `HUB_CRON_SECRET` (at least 32 characters); `SITE_URL` (required: the site's address, for the links in the emails; without it every run stops with `stop: 'config'` and Settings → Preview answers 503); `RESEND_API_KEY` and `EMAIL_FROM` (required) and `EMAIL_FROM_NAME`, the same as for `send-email`; `HEALTHCHECK_URL`, which is optional; and for Google Calendar (v1.1) `GOOGLE_SA_JSON`, also optional: the whole service-account key file (without it the calendar job stops with `not_set_up` and the morning email is unchanged).
5. Create the two Vault secrets by hand (`hub_cron_secret`, the same value as `HUB_CRON_SECRET`, and `hub_jobs_url`, the function's address), then run `supabase/cron.sql`. Its header has the exact commands; it refuses to run while either is missing or a placeholder. Run it again after every release that changes it (v1.1 adds the `hub-calendar` job); it is safe to run again.
6. Smoke checks: no header → 401; preview → rendered JSON; Settings shows the last run; next morning `notification_log` has sent rows.
7. Ops hardening: Auth email rate limit about 6/hour; the signup hook stays on; Resend click/open tracking off.

Never apply a migration before the client code that understands it is live. For v1.1 (migration 0003) that means the site and `hub-jobs` go live first; its order is in `docs/v1.1-google-calendar.md` §8.3. For v1.2 (0004) the site goes live first; it changes no Edge Function and not `cron.sql` (its order is in `docs/v1.2-kitchen.md` §15).

## Test data

Never put real names, phone numbers, email addresses, street addresses, account numbers, Supabase project refs or other real IDs in fixtures, tests, screenshots or examples. Use made-up people (Alex, Sam, Jordan, Taylor, Morgan, Pat Lee), fictional numbers in the 555-0100 to 555-0199 range (for example `(201) 555-0100`), and `example.com` or `.example` addresses.

## Client code

- `assets/hub.js` is the core: sign-in, the shell and router, forms, data access, message helpers, toasts. Pages are modules in `assets/modules/`. Each one calls `HomeHub.register({ name, schema: { min, max }, nav, match, render })`; the contract is documented at the top of the "MODULES & SCHEMA VERSION" section of `hub.js`.
- A module is shown only when the database's schema version (from `hub_schema_version()`, or 1 when that function doesn't exist or the request gets no answer at all) is within its `schema` range.
- `index.html` loads `config.js`, supabase-js, `gantt.js`, `hub.js`, `shoplist.js` (the shopping list's shared pieces, also used by My day), then the module files, in that order, without `async`. A new module needs its own script tag after `hub.js`.
- Every script and stylesheet in `index.html` and `day.html` carries the same `?v=…` (for example `?v=20261025a`). Bump all of them together, in both files, to one new value, in every release that changes any of those files, so phones don't mix old and new code. (The docs check fails while they differ.)
- `share.html` is the public project page. It uses `gantt.js` and `styles.css` but not the hub, so check it still works when you change those (the e2e tests cover it).
- `day.html` is the second public page: **My day**, for kids and helpers, with no sign-in (`day.html?t=<day token>`; the confirmation email opens `day.html?c=<confirmation secret>#confirm`, which shows only the confirm question). It loads `config.js`, supabase-js, `assets/shoplist.js` and `assets/day.js`, not the hub, and shares `styles.css` (plus `assets/css/day.css`), so a change to `styles.css` needs checking there too (`tests/e2e/day.test.js` and the realdb tests cover it). It calls only the eight anon token functions (`get_person_day`, `complete_by_token`, `undo_by_token`, `confirm_digest`, `stop_digest`, and for the helper's shopping list `get_list_by_token`, `add_to_list_by_token`, `buy_item_by_token`).

## Secrets

`config.js` holds only the publishable key. Never commit a `service_role` or secret key, an access token, or a Resend API key.
