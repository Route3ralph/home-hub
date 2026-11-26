// Browser tests for the Birthdays page (assets/modules/birthdays.js; docs/v2-design.md §46, migration 0040): the tab only
// on schema 40; the list, the next birthday first (today counts), each with its day, "turns N" when the year is known
// and "in N days"; 29 February on the 28th in other years; + Add (name, month, day, year, who: cleaned; a day the month
// hasn't, a year with no 29 February and a far-off year refused in the form); Edit and Delete (asks first); an adult who
// isn't an admin reads it but has no + Add or Edit; a hostile name as text; a failed read with Try again; 390px with no
// sideways scroll, light and dark.
// mock.js answers the table (birthdays, members only) as PostgREST would; the other pages are small stubs.
// Everyone is made up. Run alone with: node tests/e2e/birthdays.test.js
const { chromium } = require('playwright');
const { makeDb, install, signIn } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-11-06';   // before the real clock: a later one outlives the mock's sign-in, which then refreshes as Alex
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const ID = { alex: 'f00d0000-0000-4000-8000-000000000011', sam: 'f00d0000-0000-4000-8000-000000000012', jordan: 'f00d0000-0000-4000-8000-000000000013' };
const person = (id, name, role, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color: '#2563eb', language: 'en', day_token: id.replace(/-/g, ''),
  digest_enabled: false, digest_time: null, digest_day: 'today', digest_scope: 'mine', sort_order: 1, active: true, created_at: T, updated_at: T,
}, extra);
const bday = (o) => Object.assign({ id: crypto.randomUUID(), name: '', month: 1, day: 1, born_year: null, person_id: null,
  created_at: T, created_by: 'alex@example.com', updated_at: T, updated_by: 'alex@example.com' }, o);
const B = { jordan: 'bbbb0000-0000-4000-8000-000000000001', sam: 'bbbb0000-0000-4000-8000-000000000002', pat: 'bbbb0000-0000-4000-8000-000000000003', alex: 'bbbb0000-0000-4000-8000-000000000004' };

function bdayDb() {
  const db = makeDb();
  db.people = [person(ID.alex, 'Alex Example', 'parent', { email: 'alex@example.com' }), person(ID.sam, 'Sam Example', 'adult', { email: 'sam@example.com' }),
    person(ID.jordan, 'Jordan Example', 'kid')];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '18:00:00', tz: 'America/New_York' };
  db.birthdays = [
    bday({ id: B.alex, name: 'Alex Example', month: 11, day: 5, born_year: 1980, person_id: ID.alex }),   // yesterday: next year's
    bday({ id: B.jordan, name: 'Jordan', month: 11, day: 11, born_year: 2014, person_id: ID.jordan }),
    bday({ id: B.sam, name: 'Sam', month: 11, day: 6, person_id: ID.sam }),                              // today
    bday({ id: B.pat, name: 'Grandma Pat', month: 2, day: 29, born_year: 1952 }),
  ];
  return db;
}

const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true } },
};
const stubModule = (name, s) => `;(function () {
  HomeHub.register({
    name: ${JSON.stringify(name)}, schema: { min: 2, max: 99 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return parts[0] === ${JSON.stringify(name)}${s.root ? ' || !parts.length' : ''} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1>'; },
  });
})();`;
const RPC = (v) => ({ hub_schema_version: () => v, clock: (db) => Object.assign({}, db.clock), mark_signed_in: () => null });

(async () => {
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  async function open(opts = {}) {
    const db = opts.db || bdayDb();
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' }, opts.ctx));
    await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    await page.clock.install({ time: new Date(`${TODAY}T23:00:00Z`) });
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !(opts.allowConsole && opts.allowConsole.test(m.text()))) errors.push(`${opts.label} console: ${m.text()}`); });
    page.on('dialog', (d) => (db.confirm === false ? d.dismiss() : d.accept()));
    await install(page, db, [], { rpc: RPC(opts.version || 40) });
    if (db.failRead) {
      await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/birthdays', (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        if (db.failRead && route.request().method() === 'GET') return route.fulfill({ status: 500, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"message":"down"}' });
        return route.fallback();
      });
    }
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: stubModule(name, s) }));
    }
    await page.goto(BASE + (opts.path || '/#/birthdays'));
    await page.waitForSelector('#main', { timeout: 6000 });
    await page.waitForFunction(() => !document.querySelector('#main .loading'), null, { timeout: 6000 }).catch(() => {});
    await sleep(300);
    return { page, db };
  }
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const lastToast = async (page) => (await texts(page, '.toasts .toast')).slice(-1)[0] || '';
  const names = (page) => texts(page, '#main .bday-n');
  const row = (id) => `#main .bday-row[data-id="${id}"]`;
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  // ---- The tab only on 40
  let { page, db } = await open({ label: 'v39', version: 39, path: '/#/' });
  check('schema 39: no Birthdays tab', !(await page.$('[data-tab="birthdays"]')));
  await page.context().close();

  ({ page, db } = await open({ label: 'list' }));
  check('schema 40: the Birthdays tab', !!(await page.$('[data-tab="birthdays"]')));
  check('the next first: Sam (today), Jordan (Nov 11), Grandma Pat (Feb 28 next year), Alex (yesterday, so next year)',
    same(await names(page), ['Sam', 'Jordan', 'Grandma Pat', 'Alex Example']), JSON.stringify(await names(page)));
  check('today\'s: "… · today", marked soon', /· today$/.test(await tc(page, `${row(B.sam)} .bday-sub`)) && !!(await page.$(`${row(B.sam)}.is-soon`)),
    await tc(page, `${row(B.sam)} .bday-sub`));
  check('Jordan: "Wed Nov 11 · turns 12 · in 5 days"', /Nov 11 · turns 12 · in 5 days$/.test(await tc(page, `${row(B.jordan)} .bday-sub`)), await tc(page, `${row(B.jordan)} .bday-sub`));
  check('29 February: "Feb 28 · turns 75" in 2027', /Feb 28 · turns 75 · in 114 days$/.test(await tc(page, `${row(B.pat)} .bday-sub`)), await tc(page, `${row(B.pat)} .bday-sub`));
  check('yesterday\'s: a year away, "turns 47" (in 2027)', /Nov 5 · turns 47 · in 364 days$/.test(await tc(page, `${row(B.alex)} .bday-sub`)), await tc(page, `${row(B.alex)} .bday-sub`));
  check('a person on the family list has their dot', !!(await page.$(`${row(B.jordan)} .bday-name .pdot, ${row(B.jordan)} .bday-name [class*="dot"]`)));

  // + Add
  await page.click('[data-act="add"]');
  check('the form lists only people without a birthday yet', same((await page.$$eval('#formDialog select[name="person_id"] option', (os) => os.map((o) => o.textContent))),
    ['Someone not on the family list']), JSON.stringify(await page.$$eval('#formDialog select[name="person_id"] option', (os) => os.map((o) => o.textContent))));
  await page.fill('#formDialog input[name="name"]', '  Cousin   Morgan ');
  await page.selectOption('#formDialog select[name="month"]', '4');
  await page.selectOption('#formDialog select[name="day"]', '31');
  await page.click('#formDialog [type="submit"]');
  await sleep(300);
  check('31 April: "April has only 30 days.", nothing saved', /April has only 30 days/.test(await tc(page, '#formDialog .form-error')) && db.birthdays.length === 4,
    await tc(page, '#formDialog .form-error'));
  await page.selectOption('#formDialog select[name="month"]', '2');
  await page.selectOption('#formDialog select[name="day"]', '29');
  await page.fill('#formDialog input[name="born_year"]', '2011');
  await page.click('#formDialog [type="submit"]');
  await sleep(300);
  check('29 February 2011: "2011 had no 29 February."', /2011 had no 29 February/.test(await tc(page, '#formDialog .form-error')) && db.birthdays.length === 4);
  await page.fill('#formDialog input[name="born_year"]', '2099');
  await page.click('#formDialog [type="submit"]');
  await sleep(300);
  check('a year still to come: refused', /1900 to 2026/.test(await tc(page, '#formDialog .form-error')) && db.birthdays.length === 4, await tc(page, '#formDialog .form-error'));
  await page.selectOption('#formDialog select[name="month"]', '12');
  await page.selectOption('#formDialog select[name="day"]', '3');
  await page.fill('#formDialog input[name="born_year"]', '2012');
  await page.click('#formDialog [type="submit"]');
  await sleep(500);
  const added = db.birthdays.find((x) => /Morgan/.test(x.name));
  check('+ Add: saved cleaned, toast "Added Cousin Morgan\'s birthday"', !!added && added.name === 'Cousin Morgan' && added.month === 12 && added.day === 3
    && added.born_year === 2012 && added.person_id === null && (await lastToast(page)) === 'Added Cousin Morgan\'s birthday', JSON.stringify(added));
  check('... and in its place on the list', same(await names(page), ['Sam', 'Jordan', 'Cousin Morgan', 'Grandma Pat', 'Alex Example']), JSON.stringify(await names(page)));

  // Edit and Delete
  await page.click(`${row(B.jordan)} [data-act="edit"]`);
  check('Edit: the form has its values, and the person picked', (await page.inputValue('#formDialog input[name="name"]')) === 'Jordan'
    && (await page.inputValue('#formDialog select[name="month"]')) === '11' && (await page.inputValue('#formDialog select[name="day"]')) === '11'
    && (await page.inputValue('#formDialog input[name="born_year"]')) === '2014' && (await page.inputValue('#formDialog select[name="person_id"]')) === ID.jordan);
  await page.fill('#formDialog input[name="born_year"]', '2015');
  await page.click('#formDialog [type="submit"]');
  await sleep(400);
  check('Edit saved: turns 11 now', db.birthdays.find((x) => x.id === B.jordan).born_year === 2015 && /turns 11/.test(await tc(page, `${row(B.jordan)} .bday-sub`))
    && (await lastToast(page)) === 'Saved');
  db.confirm = false;
  await page.click(`${row(B.pat)} [data-act="edit"]`);
  await page.click('#formDialog [data-extra="0"]');
  await sleep(300);
  check('Delete, then No: kept', db.birthdays.some((x) => x.id === B.pat));
  db.confirm = true;
  await page.click('#formDialog [data-extra="0"]');
  await sleep(400);
  check('Delete (asks first): gone', !db.birthdays.some((x) => x.id === B.pat) && !(await names(page)).includes('Grandma Pat'));
  await page.context().close();

  // The gift switch (0041, docs/v2-design.md §47): on 41 the form has "Remind me to buy a gift", ticked for a new one and
  // as saved for an old one; off reads "no gift reminder" on the row. On 40 there is no box, and gift is never sent.
  ({ page, db } = await open({ label: 'gift-41', version: 41, db: Object.assign(bdayDb(), {}) }));
  db.birthdays.forEach((b) => { b.gift = true; });
  db.birthdays.find((b) => b.id === B.pat).gift = false;
  await page.reload();
  await page.waitForSelector('#main .bday-row');
  check('gift (41): Grandma Pat\'s row says "no gift reminder", Jordan\'s doesn\'t', /no gift reminder$/.test(await tc(page, `${row(B.pat)} .bday-sub`))
    && !/no gift reminder/.test(await tc(page, `${row(B.jordan)} .bday-sub`)), await tc(page, `${row(B.pat)} .bday-sub`));
  await page.click('[data-act="add"]');
  check('gift: a new birthday\'s box is ticked', await page.isChecked('#formDialog input[name="gift"]'));
  await page.fill('#formDialog input[name="name"]', 'Neighbour Kim');
  await page.selectOption('#formDialog select[name="month"]', '3');
  await page.selectOption('#formDialog select[name="day"]', '3');
  await page.uncheck('#formDialog input[name="gift"]');
  await page.click('#formDialog [type="submit"]');
  await sleep(500);
  const kim = db.birthdays.find((x) => x.name === 'Neighbour Kim');
  check('gift: unticked on Add saves gift false', !!kim && kim.gift === false, JSON.stringify(kim));
  await page.click(`${row(B.pat)} [data-act="edit"]`);
  check('gift: Edit shows the saved switch (off for Grandma Pat)', !(await page.isChecked('#formDialog input[name="gift"]')));
  await page.check('#formDialog input[name="gift"]');
  await page.click('#formDialog [type="submit"]');
  await sleep(500);
  check('gift: ticked on Edit saves gift true', db.birthdays.find((x) => x.id === B.pat).gift === true);
  await page.context().close();
  ({ page, db } = await open({ label: 'gift-40' }));
  await page.click('[data-act="add"]');
  check('gift (40): no box on the form', !(await page.$('#formDialog input[name="gift"]')));
  await page.fill('#formDialog input[name="name"]', 'Neighbour Lee');
  await page.selectOption('#formDialog select[name="month"]', '3');
  await page.selectOption('#formDialog select[name="day"]', '4');
  await page.click('#formDialog [type="submit"]');
  await sleep(500);
  const lee = db.birthdays.find((x) => x.name === 'Neighbour Lee');
  check('gift (40): gift is never sent', !!lee && !('gift' in lee), JSON.stringify(lee));
  await page.context().close();

  // An adult who isn't an admin reads it, with no + Add or Edit.
  ({ page, db } = await open({ label: 'adult', email: 'sam@example.com' }));
  check('Sam (an adult): the list, no + Add or Edit, "Only a parent can change the list."', (await names(page)).length === 4 && !(await page.$('[data-act="add"]'))
    && !(await page.$('[data-act="edit"]')) && /Only a parent can change the list/.test(await tc(page, '#main')),
    `${JSON.stringify(await names(page))} add:${!!(await page.$('[data-act="add"]'))} ${(await tc(page, '#main')).slice(0, 200)}`);
  await page.context().close();

  // Empty, hostile and failed.
  const empty = bdayDb();
  empty.birthdays = [];
  ({ page, db } = await open({ label: 'empty', db: empty }));
  check('no birthdays yet: says so', /No birthdays yet/.test(await tc(page, '#main')));
  await page.context().close();
  const evil = bdayDb();
  evil.birthdays.push(bday({ name: '<img src=x onerror="window.__pwned=1">', month: 11, day: 7 }));
  ({ page, db } = await open({ label: 'evil', db: evil }));
  check('a hostile name shows as text', (await names(page))[1] === '<img src=x onerror="window.__pwned=1">' && !(await page.evaluate(() => window.__pwned)));
  await page.context().close();
  const bad = bdayDb();
  bad.failRead = true;
  ({ page, db } = await open({ label: 'fail', db: bad, allowConsole: /status of 500/ }));
  check('a failed read: "The birthdays couldn\'t be loaded" with Try again', /couldn't be loaded/.test(await tc(page, '#main')) && !!(await page.$('[data-act="retry"]')));
  bad.failRead = false;
  await page.click('[data-act="retry"]');
  await sleep(500);
  check('... Try again reads them', (await names(page)).length === 4);
  await page.context().close();

  // Phone and dark.
  for (const scheme of ['light', 'dark']) {
    ({ page, db } = await open({ label: `390-${scheme}`, ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme } }));
    check(`390px ${scheme}: the list, no sideways page scroll`, (await names(page)).length === 4 && await noSideScroll(page));
    await page.context().close();
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
  await server.close();
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
