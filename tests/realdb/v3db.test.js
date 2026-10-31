// The site as it is now, on the database as it is live before v1.2 (schema.sql, the v1 household,
// migrations 0002 and 0003, then the v2 household): the site goes live before migration 0004 is
// applied (docs/v1.2-kitchen.md §15 step 1), so on schema 3 nothing changes for the family. The pages
// make no failing request, show no Food tab and no Shopping in the Add sheet, and never ask for meals,
// shopping_items, my_day_use or a shopping list function, nor for v1.3's homework (migration 0005: its
// tables and functions); My day (a helper's and a kid's link) works as before, with no list button,
// no list request and no homework request, even at #list.
// Run through tests/realdb/run.sh (its own copy of the v3 template database).
const { setup, HOMEWORK_CALLS, SCHOOL_CALLS } = require('./lib');

const FOOD_CALLS = /\/rpc\/(shopping_list|add_to_list|buy_item|get_list_by_token|add_to_list_by_token|buy_item_by_token)$|\/rest\/v1\/(meals|shopping_items|my_day_use)$/;
const TOKEN_FNS = /^\/rest\/v1\/rpc\/(get_person_day|complete_by_token|undo_by_token|confirm_digest|stop_digest)$/;

(async () => {
  const h = await setup('v3db', { v3: true });
  const { check, flow, sql, open, go, tc, titles, until } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || r.error.error || ''}` : ''}`);

  await flow('schema 3', async () => {
    const v = await one('select public.hub_schema_version() as v');
    check('v3 db: the database is schema 3 (migration 0003, no 0004)', v.v === '3' && !(await one("select to_regclass('public.meals') as t")).t, v);
    await sql(`insert into tasks (title, responsible_id, due_date) values ('Heartworm pill', '${P.taylor.id}', '2026-10-27');
               insert into events (title, start_date, start_time, end_time, responsible_id, participant_ids)
               values ('Piano', '2026-10-27', '16:00', '17:00', '${P.taylor.id}', '{${P.jordan.id}}')`);
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', phone: true, path: '/', label: 'v3db-alex' });
    const bar = await page.$$eval('.bottombar a[data-tab]', (as) => as.map((a) => a.dataset.tab));
    check('v3 db: the new site runs its v2 pages on schema 3, and the bottom bar has no Food (Today · Calendar · ＋ · Tasks · More)',
      (await page.evaluate(() => HomeHub.core.schemaVersion)) === 3 && /Good morning, Alex/.test(await tc(page, '#main h1'))
      && JSON.stringify(bar) === JSON.stringify(['today', 'calendar', 'tasks']) && !!(await page.$('.bottombar .bb-add')), { bar, h1: await tc(page, '#main h1') });
    check('v3 db: Today has no dinner line', !(await page.$('.today-dinner')));
    await page.click('.bb-add');
    await page.waitForSelector('#sheet [data-add]');
    const choices = await page.$$eval('#sheet [data-add]', (bs) => bs.map((b) => b.dataset.add));
    check('v3 db: the Add sheet offers Event and Task, not Shopping', JSON.stringify(choices) === JSON.stringify(['event', 'task']), choices);
    await page.keyboard.press('Escape');
    for (const hash of ['#/calendar', '#/tasks/everyone', '#/people', '#/settings', '#/food', '#/food/2026-10-27', '#/']) await go(page, hash);
    check('v3 db: #/food isn\'t a page on schema 3 (no Food heading)', !/^Food/.test(await tc(page, '#main h1')), await tc(page, '#main h1'));
    await context.close();

    const desk = await open({ email: 'sam@example.com', path: '/', label: 'v3db-sam' });
    const tabs = await desk.page.$$eval('.tabs a', (as) => as.map((a) => a.textContent.trim()));
    check('v3 db: the desktop tabs have no Food', tabs.length > 0 && !tabs.includes('Food'), tabs);
    await desk.context.close();

    const reqs = await h.requests();
    const food = reqs.filter((r) => FOOD_CALLS.test(r.path));
    check('v3 db: no meals, shopping_items, my_day_use or shopping list request from any page', !food.length, food.map((r) => r.path));
    const hw = reqs.filter((r) => (HOMEWORK_CALLS.test(r.path) || SCHOOL_CALLS.test(r.path)));
    check('v3 db: no homework table or function request either (no Homework tab below schema 5)', !hw.length && !tabs.includes('Homework'), hw.map((r) => r.path));
    check('v3 db: the pages read the agenda and the Google items as before', reqs.some((r) => r.path === '/rest/v1/rpc/agenda') && reqs.some((r) => r.path === '/rest/v1/rpc/google_items'),
      [...new Set(reqs.map((r) => r.path))]);
    const f = await failures();
    check('v3 db: no API request failed', !f.length, f);
  });

  await flow('my day on schema 3', async () => {
    await h.mark();
    for (const [who, hash] of [['taylor', ''], ['jordan', ''], ['taylor', '#list']]) {
      const { page, context } = await open({ phone: true, path: `/day.html?t=${P[who].day_token}${hash}`, label: `v3db-${who}${hash}` });
      await page.waitForSelector('.day-head', { timeout: 8000 });
      await until(async () => (await titles(page, 'section[aria-labelledby="day-today"]')).length > 0);
      const today = await titles(page, 'section[aria-labelledby="day-today"]');
      check(`v3 db: ${who}'s My day${hash ? ` at ${hash}` : ''} shows the day as before (Piano${who === 'taylor' ? ' and the pill' : ''}), with no dinner rows and no list button`,
        today.includes('Piano') && (who !== 'taylor' || today.includes('Heartworm pill')) && !(await page.$('.k-meal')) && !(await page.$('.day-list-btn, .list-head')), today);
      await context.close();
    }
    const reqs = await h.requests();
    check('v3 db: My day calls get_person_day only (signed out): no list or homework request, as get_person_day has no list on schema 3',
      reqs.length > 0 && reqs.every((r) => r.role === 'anon' && TOKEN_FNS.test(r.path)) && !reqs.some((r) => FOOD_CALLS.test(r.path) || (HOMEWORK_CALLS.test(r.path) || SCHOOL_CALLS.test(r.path))),
      reqs.map((r) => `${r.role} ${r.path}`));
    const day = await h.api('/rest/v1/rpc/get_person_day', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_token: P.taylor.day_token }) });
    check('v3 db: get_person_day\'s answer has no list, meals or homework keys', day.status === 200 && !!day.body && !('list' in day.body) && !('homework' in day.body)
      && (day.body.days || []).every((d) => !('meals' in d)), JSON.stringify(day.body).slice(0, 300));
    const f = await failures();
    check('v3 db: no My day request failed', !f.length, f);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  v3db stopped: ${e && e.stack}`); process.exit(1); });
