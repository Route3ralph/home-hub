// Browser tests for the Watch page (assets/modules/watch.js; docs/v2-design.md §27, migration 0022): the tab only on
// schema 22; the list to watch, newest first, with each row's kind, where, service, "until" for a cinema or theatre
// (red within a week, "ended" after), who added it (a member's first name, or the kid's from "Jordan (My day)"), its
// link (https, a new tab) and note; the chips by where; + Add (title, movie or show, where, which one, showing until,
// link, note: cleaned, a link that isn't https refused in the form); Edit and Delete (asks first); Watched folds it into
// Seen, and Not yet brings it back; Plan it opens the Calendar's event form with "Movie night: …" at 7pm; a hostile title
// as text; a failed read with Try again; 390px with no sideways scroll, light and dark.
// mock.js answers the table (watch_items, members only) as PostgREST would; the other pages are small stubs.
// Everyone is made up. Run alone with: node tests/e2e/watch.test.js
const { chromium } = require('playwright');
const { makeDb, install, signIn, SUPA } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-11-06';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const ID = { alex: 'f00d0000-0000-4000-8000-000000000011', sam: 'f00d0000-0000-4000-8000-000000000012', jordan: 'f00d0000-0000-4000-8000-000000000013' };
const person = (id, name, role, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color: '#2563eb', language: 'en', day_token: id.replace(/-/g, ''),
  digest_enabled: false, digest_time: null, digest_day: 'today', digest_scope: 'mine', sort_order: 1, active: true, created_at: T, updated_at: T,
}, extra);
const item = (o) => Object.assign({ id: crypto.randomUUID(), title: '', kind: 'movie', place: 'netflix', service: null, url: null, note: null, showing_until: null,
  watched_at: null, created_at: T, created_by: 'alex@example.com', updated_at: T, updated_by: 'alex@example.com' }, o);

function watchDb() {
  const db = makeDb();
  db.people = [person(ID.alex, 'Alex Example', 'parent', { email: 'alex@example.com' }), person(ID.sam, 'Sam Example', 'adult', { email: 'sam@example.com' }),
    person(ID.jordan, 'Jordan Example', 'kid')];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '18:00:00', tz: 'America/New_York' };
  db.watch_items = [
    item({ id: 'aaaa0000-0000-4000-8000-000000000001', title: 'Nature series', kind: 'show', place: 'streaming', service: 'Disney+', created_at: '2026-11-01T12:00:00+00:00' }),
    item({ id: 'aaaa0000-0000-4000-8000-000000000002', title: 'Paddington in Peru', place: 'cinema', service: 'AMC', showing_until: '2026-11-10', url: 'https://tickets.example/paddington',
      note: 'PG', created_at: '2026-11-03T12:00:00+00:00', created_by: 'sam@example.com' }),
    item({ id: 'aaaa0000-0000-4000-8000-000000000003', title: 'Wild Robot', created_at: '2026-11-05T12:00:00+00:00', created_by: 'Jordan (My day)' }),
    item({ id: 'aaaa0000-0000-4000-8000-000000000004', title: 'Old musical', kind: 'show', place: 'theatre', showing_until: '2026-11-02', created_at: '2026-10-20T12:00:00+00:00' }),
    item({ id: 'aaaa0000-0000-4000-8000-000000000005', title: 'Seen movie', watched_at: '2026-11-04T01:00:00+00:00', created_at: '2026-10-01T12:00:00+00:00' }),
  ];
  return db;
}

const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true }, provides: 'openEventForm' },
};
const stubModule = (name, s) => `;(function () {
  var provides = {};
  ${s.provides ? `provides[${JSON.stringify(s.provides)}] = function (defaults) { (window.__planned = window.__planned || []).push(defaults); return Promise.resolve(); };` : ''}
  HomeHub.register({
    name: ${JSON.stringify(name)}, schema: { min: 2, max: 99 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return parts[0] === ${JSON.stringify(name)}${s.root ? ' || !parts.length' : ''} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1>'; },
    provides: provides,
  });
})();`;
const RPC = (v) => ({ hub_schema_version: () => v, clock: (db) => Object.assign({}, db.clock), mark_signed_in: () => null });

(async () => {
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  async function open(opts = {}) {
    const db = opts.db || watchDb();
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' }, opts.ctx));
    await signIn(context, opts.email || 'sam@example.com');
    const page = await context.newPage();
    await page.clock.install({ time: new Date(`${TODAY}T23:00:00Z`) });
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !(opts.allowConsole && opts.allowConsole.test(m.text()))) errors.push(`${opts.label} console: ${m.text()}`); });
    page.on('dialog', (d) => (db.confirm === false ? d.dismiss() : d.accept()));
    await install(page, db, [], { rpc: RPC(opts.version || 22) });
    if (db.failRead) {
      await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/watch_items', (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        if (db.failRead && route.request().method() === 'GET') return route.fulfill({ status: 500, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"message":"down"}' });
        return route.fallback();
      });
    }
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: stubModule(name, s) }));
    }
    await page.goto(BASE + (opts.path || '/#/watch'));
    await page.waitForSelector('#main', { timeout: 6000 });
    await page.waitForFunction(() => !document.querySelector('#main .loading'), null, { timeout: 6000 }).catch(() => {});
    await sleep(300);
    return { page, db };
  }
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const lastToast = async (page) => (await texts(page, '.toasts .toast')).slice(-1)[0] || '';
  const openTitles = (page) => texts(page, '#main > .watch-list .watch-title');
  const row = (id) => `#main .watch-row[data-id="${id}"]`;
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  // ---- The tab only on 22
  let { page, db } = await open({ label: 'v21', version: 21, path: '/#/' });
  check('schema 21: no Watch tab', !(await page.$('[data-tab="watch"]')));
  await page.context().close();

  ({ page, db } = await open({ label: 'list' }));
  check('schema 22: the Watch tab', !!(await page.$('[data-tab="watch"]')));
  check('the list to watch, newest first, the watched one left out', same(await openTitles(page), ['Wild Robot', 'Paddington in Peru', 'Nature series', 'Old musical']),
    JSON.stringify(await openTitles(page)));
  check('a row: "Movie · Cinema · AMC · added by Sam · until Tue …" in red within a week, its link in a new tab, its note',
    /^Movie · Cinema · AMC · added by Sam · until /.test(await tc(page, `${row('aaaa0000-0000-4000-8000-000000000002')} .watch-sub`))
    && !!(await page.$(`${row('aaaa0000-0000-4000-8000-000000000002')} .watch-soon`))
    && (await page.$eval(`${row('aaaa0000-0000-4000-8000-000000000002')} a.watch-title`, (a) => a.target === '_blank' && a.rel.includes('noopener') && a.href)) === 'https://tickets.example/paddington'
    && (await tc(page, `${row('aaaa0000-0000-4000-8000-000000000002')} .watch-note`)) === 'PG', await tc(page, `${row('aaaa0000-0000-4000-8000-000000000002')} .watch-sub`));
  check('the kid\'s: "added by Jordan" (from "Jordan (My day)")', /added by Jordan/.test(await tc(page, `${row('aaaa0000-0000-4000-8000-000000000003')} .watch-sub`)));
  check('a theatre show past its last day: "ended …"', /ended /.test(await tc(page, `${row('aaaa0000-0000-4000-8000-000000000004')} .watch-sub`)));
  check('Seen (1), folded', /Seen \(1\)/.test(await tc(page, '.watch-seen summary')) && !(await page.$eval('.watch-seen', (d) => d.open)));

  // Chips
  await page.click('[data-act="place"][data-place="cinema"]');
  check('the Cinema chip: only the cinema one', same(await openTitles(page), ['Paddington in Peru']) && (await page.getAttribute('[data-place="cinema"]', 'aria-pressed')) === 'true');
  await page.click('[data-act="place"][data-place="all"]');

  // + Add
  await page.click('[data-act="add"]');
  await page.fill('#formDialog input[name="title"]', '  Wicked:   For Good ');
  await page.selectOption('#formDialog select[name="kind"]', 'movie');
  await page.selectOption('#formDialog select[name="place"]', 'cinema');
  await page.fill('#formDialog input[name="service"]', 'Regal');
  await page.fill('#formDialog input[name="showing_until"]', '2026-12-01');
  await page.fill('#formDialog input[name="url"]', 'javascript:alert(1)');
  await page.click('#formDialog [type="submit"]');
  await sleep(300);
  check('+ Add with a link that isn\'t https: refused in the form, nothing saved', /https/.test(await tc(page, '#formDialog .form-error'))
    && db.watch_items.length === 5, await tc(page, '#formDialog .form-error'));
  await page.fill('#formDialog input[name="url"]', 'https://tickets.example/wicked');
  await page.click('#formDialog [type="submit"]');
  await sleep(500);
  const added = db.watch_items.find((x) => /Wicked/.test(x.title));
  check('+ Add: saved cleaned, its https link kept, toast "Added Wicked: For Good"', !!added && added.title === 'Wicked: For Good' && added.place === 'cinema' && added.service === 'Regal'
    && added.showing_until === '2026-12-01' && added.url === 'https://tickets.example/wicked' && (await lastToast(page)) === 'Added Wicked: For Good', JSON.stringify(added));
  check('... and on the list', (await openTitles(page)).includes('Wicked: For Good'));

  // Watched → Seen; Not yet
  await page.click(`${row('aaaa0000-0000-4000-8000-000000000003')} [data-act="watched"]`);
  await sleep(400);
  check('Watched: it leaves the list for Seen (2), with a toast', !(await openTitles(page)).includes('Wild Robot') && /Seen \(2\)/.test(await tc(page, '.watch-seen summary'))
    && !!db.watch_items.find((x) => x.id === 'aaaa0000-0000-4000-8000-000000000003').watched_at && (await lastToast(page)) === 'Watched: Wild Robot');
  await page.click('.watch-seen summary');
  await page.click(`.watch-seen .watch-row[data-id="aaaa0000-0000-4000-8000-000000000003"] [data-act="unwatch"]`);
  await sleep(400);
  check('Not yet: back on the list', (await openTitles(page)).includes('Wild Robot') && db.watch_items.find((x) => x.id === 'aaaa0000-0000-4000-8000-000000000003').watched_at == null);

  // Plan it
  await page.click(`${row('aaaa0000-0000-4000-8000-000000000001')} [data-act="plan"]`);
  await sleep(200);
  const planned = await page.evaluate(() => window.__planned || []);
  check('Plan it: the Calendar\'s event form with "Movie night: Nature series" at 7pm today', same(planned, [{ title: 'Movie night: Nature series', start_time: '19:00', date: TODAY }]), JSON.stringify(planned));

  // Edit and Delete
  await page.click(`${row('aaaa0000-0000-4000-8000-000000000001')} [data-act="edit"]`);
  check('Edit: the form has its values', (await page.inputValue('#formDialog input[name="title"]')) === 'Nature series' && (await page.inputValue('#formDialog select[name="place"]')) === 'streaming'
    && (await page.inputValue('#formDialog input[name="service"]')) === 'Disney+');
  await page.fill('#formDialog input[name="note"]', 'Sunday mornings').catch(async () => page.fill('#formDialog textarea[name="note"]', 'Sunday mornings'));
  await page.click('#formDialog [type="submit"]');
  await sleep(400);
  check('Edit saved: the note', db.watch_items.find((x) => x.id === 'aaaa0000-0000-4000-8000-000000000001').note === 'Sunday mornings' && (await lastToast(page)) === 'Saved');
  await page.click(`${row('aaaa0000-0000-4000-8000-000000000004')} [data-act="edit"]`);
  await page.click('#formDialog [data-extra="0"]');
  await sleep(400);
  check('Delete (asks first): gone', !db.watch_items.some((x) => x.id === 'aaaa0000-0000-4000-8000-000000000004') && !(await openTitles(page)).includes('Old musical'));
  await page.context().close();

  // A hostile title, as text.
  const evil = watchDb();
  evil.watch_items.push(item({ title: '<img src=x onerror="window.__pwned=1">', note: '<script>window.__pwned=2</script>', created_at: '2026-11-06T12:00:00+00:00' }));
  ({ page, db } = await open({ label: 'evil', db: evil }));
  check('a hostile title and note show as text', (await openTitles(page))[0] === '<img src=x onerror="window.__pwned=1">' && !(await page.evaluate(() => window.__pwned)));
  await page.context().close();

  // A failed read.
  const bad = watchDb();
  bad.failRead = true;
  ({ page, db } = await open({ label: 'fail', db: bad, allowConsole: /status of 500/ }));
  check('a failed read: "The list couldn\'t be loaded" with Try again', /couldn't be loaded/.test(await tc(page, '#main')) && !!(await page.$('[data-act="retry"]')));
  bad.failRead = false;
  await page.click('[data-act="retry"]');
  await sleep(500);
  check('... Try again reads it', (await openTitles(page)).length === 4);
  await page.context().close();

  // Phone and dark.
  for (const scheme of ['light', 'dark']) {
    ({ page, db } = await open({ label: `390-${scheme}`, ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme } }));
    check(`390px ${scheme}: the list, no sideways page scroll`, (await openTitles(page)).length === 4 && await noSideScroll(page));
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
