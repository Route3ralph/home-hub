// The site as it is now, on the live v1 database as it is today (schema.sql, no migrations): deploy
// step 2 publishes this site before the migration is applied, so it must run in v1 mode against the
// real v1 database, with PostgREST's real answer for the missing hub_schema_version() (404 PGRST202).
// Run through tests/realdb/run.sh (its own copy of the v1 template database).
const { setup } = require('./lib');

const KITCHEN = 'a0000000-0000-4000-8000-000000000001';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const h = await setup('v1db', { v1: true });
  const { check, flow, sql, open, settle, go, tc } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code} ${r.error.message || r.error.msg}` : ''}`);

  await flow('v1 mode', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/', label: 'v1db-alex' });
    const tabs = await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent.trim()));
    check('v1 db: the new site signs in, gets 404 for hub_schema_version and runs in v1 mode', same(tabs, ['Home', 'Projects', 'Contractors', 'Family'])
      && (await page.evaluate(() => HomeHub.core.schemaVersion)) === 1 && !(await page.$('.bottombar')), tabs);
    const reqs = await h.requests();
    const v2reads = reqs.filter((r) => /\/rest\/v1\/(people|household|tasks|events|task_log|contractor_secrets|meals|shopping_items|my_day_use)|rpc\/(clock|agenda|mark_signed_in|late_items|heads_up|shopping_list|add_to_list|buy_item|get_list_by_token)/.test(r.path));
    check('v1 db: no v2 reads or calls (nor v1.2\'s dinners and shopping list)', !v2reads.length, v2reads.map((r) => r.path));
    await go(page, `#/projects/${KITCHEN}`);
    await page.click('.g-label[data-id="design"]');
    await page.waitForTimeout(300);
    await page.click('[data-task-act="done"]');
    await settle(page, 600);
    const k = await one(`select schedule #>> '{phases,0,tasks,0,status}' as status from projects where id = '${KITCHEN}'`);
    check('v1 db: a schedule change saves (no task_dates on a v1 database)', k.status === 'done', k);
    await go(page, '#/contractors');
    await page.click('[data-act=new-contractor] >> nth=0');
    await page.fill('#formDialog input[name=name]', 'Dana Brooks');
    await page.fill('#formDialog input[name=phone]', '(201) 555-0108');
    await page.click('#formDialog [type=submit]');
    await settle(page, 500);
    check('v1 db: adding a contractor works', !!(await one("select id from contractors where name = 'Dana Brooks'")));
    await go(page, '#/family');
    await page.click('[data-act=add-member]');
    await page.fill('#formDialog input[name=name]', 'Jordan Example');
    await page.fill('#formDialog input[name=email]', 'Jordan@Example.com');
    await page.click('#formDialog [type=submit]');
    await settle(page, 500);
    check('v1 db: adding a family member works (lowercased)', !!(await one("select email from members where email = 'jordan@example.com'")));
    const f = (await failures()).filter((x) => !/rpc\/hub_schema_version → 404 PGRST202/.test(x));
    check('v1 db: no API request failed other than hub_schema_version\'s 404', !f.length, f);
    await context.close();
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  v1db stopped: ${e && e.stack}`); process.exit(1); });
