// The site and hub-jobs as they are now, on the v2 database before v1.1 (schema.sql, the v1 household,
// migration 0002 only, then the v2 household): both go live before migration 0003 is applied
// (docs/v1.1-google-calendar.md §8.3), so on schema 2 they must work as before. The pages make no
// failing request and never ask for google_items, a calendar_* function or a calendar table, nor for
// v1.2's dinners and shopping list (migration 0004: meals, shopping_items, my_day_use and their
// functions), nor v1.3's homework (migration 0005); Settings' Google card says it is waiting for the database update; hub-jobs answers the calendar
// job, Sync now and Test with 503 no_schema without calling Google, and sends the morning email as before.
// Run through tests/realdb/run.sh (its own copy of the v2 template database).
const { setup, HOMEWORK_CALLS, SCHOOL_CALLS } = require('./lib');

const CALENDAR_CALLS = /\/rpc\/(google_items|calendar_\w+)$|\/rest\/v1\/(calendars|calendar_links|google_events|calendar_sync)$/;
const FOOD_CALLS = /\/rpc\/(shopping_list|add_to_list|buy_item|get_list_by_token|add_to_list_by_token|buy_item_by_token)$|\/rest\/v1\/(meals|shopping_items|my_day_use)$/;

(async () => {
  const h = await setup('v2db', { v2: true });
  const { check, flow, sql, open, go, tc, until } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || r.error.error || ''}` : ''}`);

  await flow('schema 2', async () => {
    const v = await one('select public.hub_schema_version() as v');
    check('v2 db: the database is schema 2 (no migration 0003)', v.v === '2' && !(await one("select to_regclass('public.calendars') as t")).t, v);
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/', label: 'v2db-alex' });
    check('v2 db: the new site signs in and runs its v2 pages (schema version 2)', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 2
      && !!(await page.$('.bottombar')) && /Good morning, Alex/.test(await tc(page, '#main h1')), await tc(page, '#main h1'));
    for (const hash of ['#/calendar', '#/calendar/2026-11-03', '#/tasks/everyone', '#/']) await go(page, hash);
    await go(page, '#/settings');
    await until(async () => /Waiting for the database update/.test(await tc(page, '[data-ref="calendar"]')));
    check('v2 db: Settings\' Google Calendar & Hearth card says it is waiting for the database update', (await tc(page, '[data-ref="calendar"]')) === 'Waiting for the database update',
      await tc(page, '[data-ref="calendar"]'));
    await until(async () => (await tc(page, '[data-ref="status"]')) !== '');
    const reqs = await h.requests();
    const cal = reqs.filter((r) => CALENDAR_CALLS.test(r.path));
    check('v2 db: no google_items, calendar_* or calendar table request from Today, Calendar, Tasks or Settings', !cal.length, cal.map((r) => r.path));
    const food = reqs.filter((r) => FOOD_CALLS.test(r.path));
    check('v2 db: no meals, shopping_items or shopping list request either (no Food tab on schema 2)', !food.length
      && !(await page.$('.tabs a[data-tab="food"], .bottombar a[data-tab="food"]')), food.map((r) => r.path));
    const hw = reqs.filter((r) => (HOMEWORK_CALLS.test(r.path) || SCHOOL_CALLS.test(r.path)));
    check('v2 db: no homework table or function request either (no Homework tab on schema 2)', !hw.length
      && !(await page.$('.tabs a[data-tab="homework"], .bottombar a[data-tab="homework"]')), hw.map((r) => r.path));
    check('v2 db: the pages read the agenda as before', reqs.some((r) => r.path === '/rest/v1/rpc/agenda'), reqs.map((r) => r.path));
    const f = await failures();
    check('v2 db: no API request failed', !f.length, f);
    await context.close();
  });

  await flow('hub-jobs on schema 2', async () => {
    const run = await h.runCalendar();
    check('v2 db: the calendar job (pg_cron) answers 503 no_schema', run.status === 503 && run.body.ok === false && run.body.stop === 'no_schema', run);
    const sync = await h.hubJobsAs('alex@example.com', { action: 'calendar' });
    check('v2 db: Sync now answers 503 no_schema (Settings shows "Waiting for the hub-jobs update")', sync.status === 503 && sync.body.stop === 'no_schema', sync);
    const test = await h.hubJobsAs('alex@example.com', { action: 'calendar_test', calendar_id: '00000000-0000-4000-8000-000000000001' });
    check('v2 db: Test answers 503 no_schema', test.status === 503 && test.body.stop === 'no_schema', test);
    check('v2 db: Google is never called (no token, no Calendar API call)', h.google.tokens() === 0 && !h.google.requests.length, h.google.requests);
    const digest = await h.runDigest();
    check('v2 db: the morning email run answers as before (200 ok)', digest.status === 200 && digest.body.ok === true, digest.body);
    const status = await h.hubJobsAs('alex@example.com', { action: 'status' });
    check('v2 db: Settings\' status from hub-jobs answers as before', status.status === 200 && !!status.body && typeof status.body === 'object', status);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  v2db stopped: ${e && e.stack}`); process.exit(1); });
