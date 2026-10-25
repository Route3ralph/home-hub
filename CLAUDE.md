# Working on Home Hub

A private family web app (static site on GitHub Pages + Supabase). See `README.md` for what it does and `docs/v2-design.md` for the v2 build contract.

## Before every PR

- Run `tests/run.sh` and make sure it ends with `0 failed` and exit status 0. It runs the database tests (`tests/db/run.sh`, when present), the Edge Function tests (`tests/fn/*.test.ts`) and the browser tests (`tests/e2e/*.test.js`). See `tests/README.md`.
- New behaviour gets new tests. Never weaken or delete an existing check to make a change pass; fix the code, or explain in the PR why the old expectation was wrong.

## Database changes

- `supabase/schema.sql` is the v1 baseline. Don't edit it for new work.
- Every schema change is a new, numbered file in `supabase/migrations/` (`0002_home_hub_v2.sql`, then `0003_…`). A fresh install is `schema.sql` followed by `migrations/*.sql` in order.
- Migrations are additive, so the site that is already live keeps working until it is updated, and each runs in one transaction.
- Follow the rules in `docs/v2-design.md` §3: RLS on every table, `set search_path = ''` on every function, and explicit `revoke … from public, anon` / `grant … to authenticated` on every new public function.

## Deploy order (needs Supabase access; from `docs/v2-design.md` §7)

0. Move the project into the paid organization (owner); confirm the URL and project ref are unchanged.
1. Run `supabase/preflight.sql` (read-only checks) and `list_migrations`.
2. Merge the client PRs. The site stays in v1 mode until step 3 (the core reads `hub_schema_version()`; when it's missing, the site shows the v1 pages).
3. Apply the migration (the site switches to v2 on next load).
4. Deploy `hub-jobs` from main (verify_jwt false). Secrets: `HUB_CRON_SECRET` (at least 32 characters), optional `HEALTHCHECK_URL`.
5. Create the Vault secret by hand, then run `supabase/cron.sql`.
6. Smoke checks: no header → 401; preview → rendered JSON; Settings shows the last run; next morning `notification_log` has sent rows.
7. Ops hardening: Auth email rate limit about 6/hour; the signup hook stays on; Resend click/open tracking off.

Never apply a migration before the client code that understands it is live.

## Test data

Never put real names, phone numbers, email addresses, street addresses, account numbers, Supabase project refs or other real IDs in fixtures, tests, screenshots or examples. Use made-up people (Alex, Sam, Jordan, Pat Lee), fictional numbers in the 555-0100 to 555-0199 range (for example `(201) 555-0100`), and `example.com` or `.example` addresses.

## Client code

- `assets/hub.js` is the core: sign-in, the shell and router, forms, data access, message helpers, toasts. Pages are modules in `assets/modules/`. Each one calls `HomeHub.register({ name, schema: { min, max }, nav, match, render })`; the contract is documented at the top of the "MODULES & SCHEMA VERSION" section of `hub.js`.
- A module is shown only when the database's schema version (from `hub_schema_version()`, or 1 when that function doesn't exist or the request gets no answer at all) is within its `schema` range.
- `index.html` loads `config.js`, supabase-js, `gantt.js`, `hub.js`, then the module files, in that order, without `async`. A new module needs its own script tag after `hub.js`.
- Every script and the stylesheet in `index.html` carries the same `?v=…` (for example `?v=20261025a`). Bump all of them together, to one new value, in every release that changes any of those files, so phones don't mix old and new code.
- `share.html` is the public page. It uses `gantt.js` and `styles.css` but not the hub, so check it still works when you change those (the e2e tests cover it).

## Secrets

`config.js` holds only the publishable key. Never commit a `service_role` or secret key, an access token, or a Resend API key.
