# Tests

Run everything from the repository root:

```sh
tests/run.sh            # all suites, then the totals; exit status 0 only if everything passed (about 9 minutes)
tests/run.sh fn e2e     # only the suites named (db, contract, fn, e2e, realdb, docs)
```

Each suite also runs on its own:

```sh
bash tests/db/run.sh
bash tests/contract/check.sh                     # or: bash tests/contract/check.sh assets/modules/today.js
node --experimental-strip-types tests/fn/send-email.test.ts
node tests/e2e/v1.test.js
bash tests/realdb/run.sh                         # or: bash tests/realdb/run.sh flows   (one file)
node tests/docs/docs.test.js
```

## What you need

- **Node 22 or later** (the Edge Function tests use Node's built-in TypeScript type stripping).
- **Playwright with Chromium** for the browser tests: `require('playwright')` must work (`npm install -g playwright && npx playwright install chromium`).
- **PostgreSQL 16** binaries for the database tests, the contract check, `fn/cron-sql.test.ts` and the real-database tests (see `tests/db/`).
- **git history** back to commit `b980d4c` (the v1 site) and `bcf296a` (PR A) for the real-database tests' v1-on-v2 checks; in a clone without them those checks print `SKIP` and are left out.

No network access is needed. The browser tests never reach Supabase or a CDN.

## The suites

| Folder | What it checks | How |
|---|---|---|
| `db/` | Row-level security, functions, recurrence and the other database rules | `tests/db/run.sh` loads `supabase/schema.sql` and `supabase/migrations/*` into a throwaway Postgres |
| `contract/` | Every database call in the site and the Edge Functions (`sb.rpc`, `core.v2.call`, `.from`) names a function or table that exists, with argument names it takes, and that the caller (signed out, signed in, Edge Function) may use | `tests/contract/check.sh` builds the same throwaway Postgres (`tests/db/cluster.sh`), reads its catalog and runs `check.js` over the code |
| `fn/` | Edge Function handlers (`supabase/functions/*/handler.ts`) and `supabase/cron.sql` | `tests/fn/*.test.ts`, in Node with type stripping; Resend, the database and the clock are injected fakes (`cron-sql.test.ts` runs cron.sql in a throwaway Postgres) |
| `e2e/` | The site in Chromium: sign-in, every page, the share page, My day, phone layouts | `tests/e2e/*.test.js`: Playwright against `mock.js`, an in-browser stand-in for Supabase |
| `realdb/` | The family's key flows in Chromium against the **real** database: schema, migrations, RLS, every function, the real hub-jobs handler; and the v1 sites on the v2 database | `tests/realdb/run.sh`: a throwaway Postgres behind `server.js`, a stand-in for PostgREST and Supabase Auth (about 1.5 minutes) |
| `docs/` | `CLAUDE.md`, `README.md`, `docs/v2-design.md` and this file say what the code does | `tests/docs/*.test.js`: reads the files only |

Every test file prints one line per check, `PASS  name` or `FAIL  name  (detail)`, and exits non-zero if anything failed. `run.sh` adds up those lines. A file that crashes, or exits non-zero without a `FAIL` line, also fails the run. (A `SKIP  …` line is a note, not counted.) New test files only need to follow the same pattern and be named `*.test.ts` (fn) or `*.test.js` (e2e, realdb, docs).

## Browser tests (`e2e/`)

- `server.js` serves the repository on a free local port; each test file starts and stops its own.
- `mock.js` answers everything the site asks of Supabase: Auth (sign-in codes), tables (`/rest/v1/<table>` with the usual filters, ordering and row-level security for members only), RPCs and Edge Functions. `makeDb()` returns a fresh fictional household: two members, two contractors and three projects (the kitchen schedule comes from `supabase/kitchen-renovation.json`). Add tables by adding arrays to the object it returns.
- `vendor/supabase.js` is supabase-js 2.117.3 (the version `index.html` loads from jsDelivr), served in place of the CDN copy. Its licence is in `vendor/supabase-js-LICENSE`.
- `install(page, db, log, opts)` options: `noConfig`, `emailSending`, `smtpDown`, `offline`, `fnStatus` / `fnBody` (Edge Function reply), and `rpc: { name: (db, body, email) => result }` for database functions. An RPC without a handler answers 404 "Could not find the function", like PostgREST. That is how the v1 tests run: there is no `hub_schema_version`, so the site is in v1 mode. Pass `rpc: { hub_schema_version: () => 2 }` for v2 mode.
- `signIn(context, email)` starts a browser context already signed in.
- Screenshots go to `e2e/shots/`, which git ignores. Look at them after changing a page, on desktop and phone sizes.
- In v2 mode the core loads the people, the household and the clock at sign-in, so a v2 test needs `db.people` and `db.household` arrays and RPC fakes for `clock` (`{ local_date, local_time, tz }`) and `mark_signed_in` (`null`). Fakes should answer with exactly the shapes in `supabase/migrations/0002_home_hub_v2.sql`.
- Saving a project schedule sends `task_dates_at` from the device clock. A test that saves a schedule twice should let the clock move (`page.clock.install` then `resume`) rather than fix it, or the two saves carry the same timestamp.
- `modules.test.js` checks the module system (script order, which tabs show for each schema version, `ctx.signal`). It adds throwaway "probe" modules by appending them to the last module script in the browser, so nothing test-only ships in the site.

The browser suites:

| File | What it checks |
|---|---|
| `v1.test.js`, `messages.test.js` | v1 mode (a database without `hub_schema_version`): every v1 page, the share page, messages to contractors |
| `modules.test.js` | Script order, which pages show for each schema version, tab order, the page context |
| `core-v2.test.js` | The v2 core: sign-in caches, the household clock and time zone, formatting, people chips, item rows, toasts with Undo, the shell and bottom bar, the Add sheet, task dates |
| `today.test.js`, `calendar.test.js`, `tasks.test.js`, `directory.test.js`, `people.test.js`, `settings.test.js`, `projects-v2.test.js` | One v2 page each (the other pages are stubbed) |
| `day.test.js` | The public My day page (`day.html`) |
| `walkthrough.test.js` | Every real page together on one household database, the way a family uses it (add a helper, a weekly event, a monthly task, the starter list, an account number, days off, a project owner and task, My day), at 390px and 1280px, light and dark, plus v1 mode. Its database functions follow the migration, so a write on one page shows up on the next |

## Real-database tests (`realdb/`)

The browser tests in `e2e/` answer the site from JavaScript fakes of each database function. This suite runs the same kind of flows against the real SQL, so a fake that drifts from the migration (a renamed parameter, a different shape, a policy that refuses) shows up here.

- `run.sh` starts a throwaway cluster (`tests/db/cluster.sh`) and builds two template databases: `realdb_t` (the Supabase stand-ins, `schema.sql`, a v1-era household from `seed_v1.sql`, `migrations/*.sql`, then `seed_v2.sql`) and `realdb_v1t` (the v1 database as it is live before the deploy). It exports the older sites into `tests/.tmp/` (`b980d4c`, the v1 site, under `/v1/`; `bcf296a`, PR A, under `/v1a/`) and runs every `tests/realdb/*.test.js`. Each file copies a template into its own database and starts its own server, so files share nothing.
- `server.js` serves the repository and answers `/rest/v1/…`, `/rest/v1/rpc/…` and `/auth/v1/…` the way PostgREST and Supabase Auth do: each request runs in its own transaction as `anon` or `authenticated`, with the JWT's claims in `request.jwt.claims`, so row-level security and grants apply for real. The sign-in code is always `123456`; new emails go through `hook_family_only_signup`. `/functions/v1/hub-jobs` runs the real handler (`supabase/functions/hub-jobs/handler.ts`) with only Resend faked. Test-only endpoints: `/__test/sql`, `/__test/clock`, `/__test/requests`.
- `lib.js` gives each file `setup(name)`: `open({ email, phone, path })` for a signed-in (or signed-out) browser, `sql(…)` to look at what the database kept, `requests()` / `failed()` for what the site asked, `runDigest()` for the morning email, `setClock(…)` to move the household's clock (it starts on Tue 2026-10-27 at 09:00 in New York; the browsers run in Los Angeles).
- The files: `flows.test.js` (sign-in, Today, a weekly event, a monthly task, the starter list, the Directory, Family, Settings, Projects, My day, a member's view, the v1 sites), `jobs.test.js` (the morning and evening email runs, Settings' status and preview), `access.test.js` (what anon and a non-member can reach), `v1db.test.js` (the new site in v1 mode on the live v1 database).
- Screenshots go to `e2e/shots/realdb-*.png`. `ONLY=flow1,flow2 bash tests/realdb/run.sh flows` runs only the named flows of a file.

## Docs check (`docs/`)

`docs.test.js` reads files only. It checks that deploy steps 4 and 5 (in `CLAUDE.md`, `docs/v2-design.md` §7 and the README) name every secret hub-jobs reads and both Vault secrets `cron.sql` needs; that `CLAUDE.md` and this file name every suite `run.sh` runs; that `index.html` and `day.html` carry one `?v=`; and that `docs/v2-design.md` names every table, column and public function the migrations add, with the real parameter names in every signature it writes out. When it fails, fix the doc (or the code), not the check.

`tests/.tmp/` is git-ignored scratch space for any suite that needs it.

## Test data

Fixtures are fictional: people such as Alex, Sam and Jordan Example, numbers in the 555-0100 to 555-0199 range, and `example.com` or `.example` addresses. Never use a real person's name, number, address or account, or a real project ID.
