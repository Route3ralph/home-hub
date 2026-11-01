// The site as it is now, on the database as it is live before project guests (schema.sql, the v1 household, migrations
// 0002 to 0010, then the v2 household): the site goes live before migration 0011 is applied (docs/v1.4-project-guests.md
// §8), so on schema 10 nothing new shows (no Guest access, no Documents, no Project guests card) and nothing new is
// asked for, and a guest's address gets no code. Then 0011 is pasted while the hub runs: the next load shows Guest
// access, and a second paste is refused.
// Run through tests/realdb/run.sh (its own copy of the v10 template database).
const { setup } = require('./lib');

const KITCHEN = 'a0000000-0000-4000-8000-000000000001';
const NEW_CALLS = /^\/rest\/v1\/(guests|project_guests|project_contacts|rpc\/(guest_whoami|guest_contacts|guest_save_contact|add_project_guest|remove_project_guest|remove_guest))$/;

(async () => {
  const h = await setup('v10db', { v10: true });
  const { check, flow, sql, open, tc, until } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const asksNew = (reqs) => reqs.filter((r) => NEW_CALLS.test(r.path) || /documents_url/.test(`${r.query || ''} ${r.body || ''}`));

  await flow('schema 10', async () => {
    const v = await one('select public.hub_schema_version() as v');
    check('v10 db: the database is schema 10 (0010, no 0011): no guests table, no documents_url', v.v === '10' && !(await one("select to_regclass('public.guests') as t")).t
      && !(await sql("select 1 from information_schema.columns where table_name = 'projects' and column_name = 'documents_url'")).length, v);
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/projects/${KITCHEN}`, label: 'v10-project' });
    await page.waitForSelector('#main h1');
    await page.click('[data-act="settings"]');
    await page.waitForSelector('#formDialog [name="name"]');
    check('v10 db: the project page has no Guest access, no Documents, and its settings no documents folder',
      (await page.evaluate(() => HomeHub.core.schemaVersion)) === 10 && !(await page.$('[data-act="guests"], [data-ref="docs"]')) && !(await page.$('#formDialog [name="documents_url"]')));
    await page.fill('#formDialog [name="summary"]', 'Cabinets and counters.');
    await page.click('#formDialog button[type="submit"]');
    await until(async () => !(await page.evaluate(() => document.getElementById('formDialog').open)));
    check('v10 db: saving the settings works as before', (await one(`select summary from projects where id = '${KITCHEN}'`)).summary === 'Cabinets and counters.');
    await h.go(page, '#/settings');
    check('v10 db: Settings has no Project guests card', !(await page.$('[data-ref="guests"]')) && /Settings/.test(await tc(page, '#main h1')));
    await context.close();
    const otp = await h.api('/auth/v1/otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'riley@example.com', create_user: true }) });
    check('v10 db: an address not on the family list still gets no code', otp.status >= 400, otp);
    const extra = asksNew(await h.requests());
    // (the deliberate /auth/v1/otp above aside)
    check('v10 db: no page asked for guests, project_guests, project_contacts, a guest function or documents_url', !extra.length, extra.map((r) => `${r.method} ${r.path}${r.query}`));
    const f = (await failures()).filter((x) => !x.startsWith('POST /auth/v1/otp'));
    check('v10 db: no API request failed', !f.length, f);
  });

  await flow('0011 pasted', async () => {
    const out = await h.migrate('supabase/migrations/0011_project_guests.sql');
    check('0011 pasted while the hub runs: no error, schema 11', !out.error && (await one('select public.hub_schema_version() as v')).v === '11', out.error);
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/projects/${KITCHEN}`, label: 'v11-project' });
    await page.waitForSelector('#main h1');
    check('... the next load shows Guest access', !!(await page.$('[data-act="guests"]')));
    await context.close();
    const again = await h.migrate('supabase/migrations/0011_project_guests.sql');
    check('... a second paste is refused, changing nothing', !!again.error && /already installed/.test(again.error.message || ''), again.error);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  v10db stopped: ${e && e.stack}`); process.exit(1); });
