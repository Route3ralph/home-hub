# Tests

Run everything from the repository root:

```sh
tests/run.sh            # all suites, then the totals; exit status 0 only if everything passed
tests/run.sh fn e2e     # only the suites named (db, fn, e2e)
```

Each suite also runs on its own:

```sh
bash tests/db/run.sh
node --experimental-strip-types tests/fn/send-email.test.ts
node tests/e2e/v1.test.js
```

## What you need

- **Node 22 or later** (the Edge Function tests use Node's built-in TypeScript type stripping).
- **Playwright with Chromium** for the browser tests: `require('playwright')` must work (`npm install -g playwright && npx playwright install chromium`).
- **PostgreSQL 16** binaries for the database tests (see `tests/db/`).

No network access is needed. The browser tests never reach Supabase or a CDN.

## The suites

| Folder | What it checks | How |
|---|---|---|
| `db/` | Row-level security, functions, recurrence and the other database rules | `tests/db/run.sh` loads `supabase/schema.sql` and `supabase/migrations/*` into a throwaway Postgres |
| `fn/` | Edge Function handlers (`supabase/functions/*/handler.ts`) | Node with type stripping; Resend, the database and the clock are injected fakes |
| `e2e/` | The site in Chromium: sign-in, every page, the share page, phone layouts | Playwright against `mock.js`, an in-browser stand-in for Supabase |

Every test file prints one line per check, `PASS  name` or `FAIL  name  (detail)`, and exits non-zero if anything failed. `run.sh` adds up those lines. A file that crashes, or exits non-zero without a `FAIL` line, also fails the run. New test files only need to follow the same pattern and be named `*.test.ts` (fn) or `*.test.js` (e2e).

## Browser tests (`e2e/`)

- `server.js` serves the repository on a free local port; each test file starts and stops its own.
- `mock.js` answers everything the site asks of Supabase: Auth (sign-in codes), tables (`/rest/v1/<table>` with the usual filters, ordering and row-level security for members only), RPCs and Edge Functions. `makeDb()` returns a fresh fictional household: two members, two contractors and three projects (the kitchen schedule comes from `supabase/kitchen-renovation.json`). Add tables by adding arrays to the object it returns.
- `vendor/supabase.js` is supabase-js 2.117.3 (the version `index.html` loads from jsDelivr), served in place of the CDN copy. Its licence is in `vendor/supabase-js-LICENSE`.
- `install(page, db, log, opts)` options: `noConfig`, `emailSending`, `smtpDown`, `offline`, `fnStatus` / `fnBody` (Edge Function reply), and `rpc: { name: (db, body, email) => result }` for database functions. An RPC without a handler answers 404 "Could not find the function", like PostgREST. That is how the v1 tests run: there is no `hub_schema_version`, so the site is in v1 mode. Pass `rpc: { hub_schema_version: () => 2 }` for v2 mode.
- `signIn(context, email)` starts a browser context already signed in.
- Screenshots go to `e2e/shots/`, which git ignores. Look at them after changing a page, on desktop and phone sizes.
- `modules.test.js` checks the module system (script order, which tabs show for each schema version, `ctx.signal`). It adds throwaway "probe" modules by appending them to the last module script in the browser, so nothing test-only ships in the site.

`tests/.tmp/` is git-ignored scratch space for any suite that needs it.

## Test data

Fixtures are fictional: people such as Alex, Sam and Jordan Example, numbers in the 555-0100 to 555-0199 range, and `example.com` or `.example` addresses. Never use a real person's name, number, address or account, or a real project ID.
