// Project guests (v1.4, migration 0011, docs/v1.4-project-guests.md) against the real database: Alex gives a made-up
// designer, Riley Designer (riley@example.com), the Kitchen from its Guest access; Riley signs in through the real
// sign-up hook and code, lands on the Kitchen, adds a contractor, links a trade to them and sets the documents link,
// with only the guest's own requests and none failing; through the API Riley reads nothing else (every family table
// empty or refused, account numbers never), can't change sharing or someone else's project, and hub-jobs refuses them;
// then Alex's Settings lists Riley under Project guests, Remove guest ends it, and Riley's next load is "Not on the list
// yet". A stranger's address still gets no code.
// Run through tests/realdb/run.sh (its own copy of the full template database).
const { setup } = require('./lib');

const RILEY = 'riley@example.com';
const KITCHEN = 'a0000000-0000-4000-8000-000000000001';
const POOL = 'a0000000-0000-4000-8000-000000000002';
const WATER = 'c0000000-0000-4000-8000-000000000004';   // an account, with an account number (seed_v2.sql)
const DRIVE = 'https://drive.google.com/drive/folders/kitchen-example';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const h = await setup('guests');
  const { check, flow, sql, open, tc, texts, until, settle } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const asGuest = async (p, init = {}) => {
    const token = (await h.sessionFor(RILEY)).access_token;
    return h.api(p, Object.assign({}, init, { headers: Object.assign({ authorization: `Bearer ${token}`, 'content-type': 'application/json', apikey: 'sb_publishable_realdb' }, init.headers) }));
  };

  // The Kitchen's plumber links the water company (account details saved), so the guest sees its name and phone only.
  await sql(`update projects set schedule = jsonb_set(schedule, '{trades,plumber}', '{"name": "Plumber", "color": "#0891b2", "contractor_id": "${WATER}"}') where id = '${KITCHEN}'`);

  await flow('give access', async () => {
    const before = await h.api('/auth/v1/otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: RILEY, create_user: true }) });
    check('before: the sign-up hook gives Riley no code', before.status >= 400, before);
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/projects/${KITCHEN}`, label: 'alex-access' });
    await page.click('[data-act="guests"]');
    await until(async () => /Nobody outside the family/.test(await tc(page, '#formDialog')));
    await page.fill('#formDialog [name="name"]', 'Riley Designer');
    await page.fill('#formDialog [name="email"]', 'Riley@Example.com');
    await page.click('#formDialog button[type="submit"]');
    await until(async () => (await texts(page, '#formDialog .contact-list strong')).includes('Riley Designer'));
    const g = await sql('select g.email, g.name, g.created_by, pg.project_id, pg.added_by from guests g join project_guests pg on pg.guest_email = g.email');
    check('Guest access: add_project_guest saved Riley, lower-cased, on the Kitchen, by Alex',
      same(g, [{ email: RILEY, name: 'Riley Designer', created_by: 'alex@example.com', project_id: KITCHEN, added_by: 'alex@example.com' }]), g);
    check('... and lists them', same(await texts(page, '#formDialog .contact-list strong'), ['Riley Designer']));
    await h.shot(page, 'guest-access');
    const f = await failures();
    check('Guest access: no request failed', !f.length, f);
    await context.close();
  });

  await flow('guest', async () => {
    await h.mark();
    const { page, context } = await open({ email: RILEY, path: '/', label: 'riley' });
    await until(async () => (await tc(page, '#main h1')) === 'Kitchen Renovation');
    check('Riley signs in (the hook lets a guest\'s address in) and lands on the Kitchen', page.url().endsWith(`#/projects/${KITCHEN}`) && (await tc(page, '#main h1')) === 'Kitchen Renovation', page.url());
    check('... the header: Projects, Riley Designer, Sign out', same(await texts(page, '.topbar .tabs a'), ['Projects']) && (await tc(page, '.topbar .guest-name')) === 'Riley Designer');
    const html = await page.content();
    check('... the schedule names the linked contractors, never an account number or a directory note',
      /Pat Lee/.test(html) && /Example Water Co/.test(html) && !/5555 0101 9876|Licensed master electrician/.test(html));
    const paths = [...new Set((await h.requests()).map((r) => r.path).filter((x) => x.startsWith('/rest/')))].sort();
    check('... the site asked only for the guest\'s things', same(paths, ['/rest/v1/projects', '/rest/v1/rpc/clock', '/rest/v1/rpc/guest_contacts', '/rest/v1/rpc/guest_whoami',
      '/rest/v1/rpc/hub_schema_version', '/rest/v1/rpc/whoami']), paths);

    await page.click('[data-act="contacts"]');
    await page.waitForSelector('#formDialog .contact-list');
    check('Contractors: Pat Lee (editable) and Example Water Co (not editable)', same(await texts(page, '#formDialog .contact-list li strong'), ['Example Water Co', 'Pat Lee'])
      && (await page.$$('#formDialog [data-contact-edit]')).length === 1);
    await page.click('#formDialog [data-contact-new]');
    await page.waitForSelector('#formDialog [name="trade"]');
    await page.fill('#formDialog [name="name"]', 'Quinn Tile');
    await page.fill('#formDialog [name="trade"]', 'Tile');
    await page.fill('#formDialog [name="phone"]', '(201) 555-0170');
    await page.click('#formDialog button[type="submit"]');
    await until(async () => (await texts(page, '#formDialog .contact-list li strong')).includes('Quinn Tile'));
    const quinn = await one("select c.id, c.kind, c.updated_by, pc.project_id, pc.added_by from contractors c join project_contacts pc on pc.contractor_id = c.id where c.name = 'Quinn Tile'");
    check('+ New contractor: a directory entry on the Kitchen, stamped with Riley\'s address', quinn && quinn.kind === 'contractor' && quinn.project_id === KITCHEN
      && quinn.added_by === RILEY && quinn.updated_by === RILEY, quinn);
    await page.click('#formDialog [data-close]');

    await page.click('[data-act="trades"]');
    await page.waitForSelector('#formDialog .trade-row');
    await page.click('#formDialog [data-add]');
    await page.fill('#formDialog .trade-row:last-child [name="name"]', 'Tile setter');
    await page.selectOption('#formDialog .trade-row:last-child [name="contractor"]', quinn.id);
    await page.click('#formDialog button[type="submit"]');
    await until(async () => !(await page.evaluate(() => document.getElementById('formDialog').open)));
    const linked = await one(`select exists (select 1 from jsonb_each(schedule -> 'trades') t where t.value ->> 'contractor_id' = '${quinn.id}') as ok, task_dates is not null as dates from projects where id = '${KITCHEN}'`);
    check('Trades: Riley links a new trade to Quinn Tile (the guard allows a contractor on the project); the task dates are saved too', linked.ok === 't' && linked.dates === 't', linked);

    await page.click('[data-act="settings"]');
    await page.waitForSelector('#formDialog [name="documents_url"]');
    check('Settings: no owner, no calendar switch, no Delete project', !(await page.$('#formDialog [name="owner_id"], #formDialog [name="on_calendar"]')) && !/Delete project/.test(await tc(page, '#formDialog')));
    await page.fill('#formDialog [name="documents_url"]', DRIVE);
    await page.click('#formDialog button[type="submit"]');
    await until(async () => !!(await page.$('[data-ref="docs"]')));
    const k = await one(`select documents_url, owner_id is not null as owned, on_calendar from projects where id = '${KITCHEN}'`);
    check('... the documents link saved (owner and calendar switch as they were); the Documents button opens it', k.documents_url === DRIVE && k.on_calendar === 't'
      && (await page.getAttribute('[data-ref="docs"]', 'href')) === DRIVE, k);
    await h.shot(page, 'guest-project');
    const f = await failures();
    check('Riley: no request failed', !f.length, f);
    await context.close();
  });

  await flow('guest api', async () => {
    const tables = (await sql("select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> 'projects' order by 1")).map((r) => r.relname);
    const leaks = [];
    for (const t of tables) {
      const r = await asGuest(`/rest/v1/${t}?select=*`);
      if (!(r.status === 200 && Array.isArray(r.body) && r.body.length === 0) && !(r.status === 401 || r.status === 403)) leaks.push(`${t} ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    }
    check(`API as Riley: every other table (${tables.length}) answers no rows or is refused`, !leaks.length, leaks);
    const ps = await asGuest('/rest/v1/projects?select=id,name');
    check('... projects: the Kitchen only', ps.status === 200 && same(ps.body.map((p) => p.id), [KITCHEN]), ps);
    const share = await asGuest(`/rest/v1/projects?id=eq.${KITCHEN}`, { method: 'PATCH', body: JSON.stringify({ sharing_enabled: false }), headers: { prefer: 'return=representation' } });
    check('... turning sharing off is refused, with the reason', share.status === 403 && /Only the family can change/.test(JSON.stringify(share.body)), share);
    const pool = await asGuest(`/rest/v1/projects?id=eq.${POOL}`, { method: 'PATCH', body: JSON.stringify({ name: 'Mine' }), headers: { prefer: 'return=representation' } });
    check('... someone else\'s project: nothing changes', pool.status === 200 && same(pool.body, []) && (await one(`select name from projects where id = '${POOL}'`)).name === 'Pool repairs', pool);
    const water = await asGuest('/rest/v1/rpc/guest_save_contact', { method: 'POST', body: JSON.stringify({ p_project: KITCHEN, p_contact: { id: WATER, name: 'Water' } }) });
    check('... editing the water company (account details saved) is refused', water.status >= 400 && /account details saved/.test(JSON.stringify(water.body)), water);
    const contacts = await asGuest('/rest/v1/rpc/guest_contacts', { method: 'POST', body: JSON.stringify({ p_project: KITCHEN }) });
    check('... guest_contacts has no account number, note or address', contacts.status === 200 && !/5555 0101 9876|Licensed master|account_number|notes|address/.test(JSON.stringify(contacts.body)),
      JSON.stringify(contacts.body).slice(0, 200));
    const agenda = await asGuest('/rest/v1/rpc/agenda', { method: 'POST', body: JSON.stringify({ p_from: '2026-10-26', p_to: '2026-12-20' }) });
    check('... agenda: only the Kitchen\'s own dates, no event, task, meal or contractor phone', agenda.status === 200 && agenda.body.length > 0
      && agenda.body.every((a) => a.kind === 'project' && a.project_id === KITCHEN && a.contractor_phone === null), JSON.stringify(agenda.body).slice(0, 200));
    const samToken = (await h.sessionFor('sam@example.com')).access_token;
    const samDocs = await h.api(`/rest/v1/projects?id=eq.${KITCHEN}`, { method: 'PATCH', body: JSON.stringify({ documents_url: 'https://drive.google.com/drive/folders/other-example' }),
      headers: { authorization: `Bearer ${samToken}`, 'content-type': 'application/json', prefer: 'return=representation' } });
    check('... Sam (an adult) can\'t change the documents link: only a parent or the guest', samDocs.status === 403 && /Only a parent or the project's guest/.test(JSON.stringify(samDocs.body))
      && (await one(`select documents_url from projects where id = '${KITCHEN}'`)).documents_url === DRIVE, samDocs);
    const shared = await h.api('/rest/v1/rpc/get_shared_project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ share: 'kitchentoken0123456789ab' }) });
    check('... the public share page has the schedule but never the documents link', shared.status === 200 && !!shared.body && !/drive\.google/.test(JSON.stringify(shared.body)), JSON.stringify(shared.body).slice(0, 120));
    const preview = await h.hubJobsAs(RILEY, { action: 'preview' });
    check('... hub-jobs refuses Riley (not a family admin)', preview.status === 403, preview);
    const who = await asGuest('/rest/v1/rpc/whoami', { method: 'POST', body: '{}' });
    check('... whoami is null (so send-email refuses them too)', who.status === 200 && who.body === null, who);
  });

  await flow('remove', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'alex-settings' });
    await page.waitForSelector('[data-ref="guests"] .set-guests');
    check('Settings (Alex): Project guests lists Riley and the Kitchen', /Riley Designer · riley@example\.com\s*Kitchen Renovation/.test(await tc(page, '[data-ref="guests"]')), await tc(page, '[data-ref="guests"]'));
    await page.click('[data-guest-remove="riley@example.com"]');
    await until(async () => /No guests/.test(await tc(page, '[data-ref="guests"]')));
    check('Remove guest: Riley and their projects gone', (await one('select count(*) as n from guests')).n === '0' && (await one('select count(*) as n from project_guests')).n === '0');
    const f = await failures();
    check('Settings: no request failed', !f.length, f);
    await context.close();
    const sam = await open({ email: 'sam@example.com', path: '/#/settings', label: 'sam-settings' });
    check('Settings (Sam, an adult): no Project guests card', !(await sam.page.$('[data-ref="guests"]')));
    await sam.context.close();
    const r = await open({ email: RILEY, path: '/', label: 'riley-after' });
    await until(async () => /Not on the list yet/.test(await tc(r.page, '#app')));
    check('Riley\'s next load: Not on the list yet', /Not on the list yet/.test(await tc(r.page, '#app')), await tc(r.page, '#app'));
    await r.context.close();
    const stranger = await h.api('/auth/v1/otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'casey@example.com', create_user: true }) });
    check('a stranger still gets no code', stranger.status >= 400, stranger);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  guests stopped: ${e && e.stack}`); process.exit(1); });
