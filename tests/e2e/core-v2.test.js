// Browser tests for the v2 core: what HomeHub.core gives pages when the database is v2 (people,
// household and clock caches, core.v2.fmt / dates / ui / call, toasts with Undo, the Add and More
// sheets, the phone bottom bar) and the projects' task_dates (sent with every schedule save in v2,
// never in v1, and filled back in when the database marked them stale). Schema 4 (v1.2): the Food tab
// in a six-cell bottom bar, Shopping in the Add sheet (through use('food').openListAdd), and signing
// out forgetting the Food page's saved list (homehub.shop.hub). Schema 5 (v1.3): Homework under More, the
// bottom bar still six cells.
//
// The fake RPCs answer with the shapes in supabase/migrations/0002_home_hub_v2.sql. The v2 pages are
// replaced by small stub modules (served in place of assets/modules/<page>.js), so this file tests the
// core alone, whatever state the real pages are in. The browser runs in Pacific/Honolulu while the
// household is in America/New_York, so anything using the device's time zone shows a wrong time or day.
// Run alone with: node tests/e2e/core-v2.test.js
const { chromium } = require('playwright');
const { makeDb, install, signIn, SUPA } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 200)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const V = '20261101a';   // Hearth people (0010): Settings, Calendar and Today

// ---- Fixtures (fictional people only)
const T = '2026-10-24T16:00:00.000000+00:00';
const person = (id, name, role, color, sort, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color, language: 'en',
  day_token: id.replace(/[^a-f0-9]/g, '').padEnd(32, '0').slice(0, 32), digest_enabled: false, digest_time: null,
  digest_day: 'today', digest_scope: 'mine', sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);

function v2Db() {
  const db = makeDb();
  // Stored out of order: the core must ask for sort_order, then name.
  db.people = [
    person('p-morgan', 'Morgan Example', 'kid', '#9333ea', 4, { active: false }),
    person('p-taylor', 'Taylor Example', 'helper', '#fde047', 3, { phone: '(201) 555-0104' }),
    person('p-alex', 'Alex Example', 'parent', '#2563eb', 1, { email: 'alex@example.com', email_verified_at: T }),
    person('p-jordan', 'Jordan Example', 'kid', '#16a34a', 3),
    person('p-sam', 'Sam Example', 'adult', '#db2777', 2, { email: 'sam@example.com' }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: null, updated_at: T, updated_by: null }];
  db.projects.forEach((p) => Object.assign(p, { task_dates: [], task_dates_at: T, on_calendar: true, owner_id: null }));
  db.clock = { local_date: '2026-11-01', local_time: '09:15:00', tz: 'America/New_York' };
  return db;
}

// RPC fakes with the migration's shapes: clock() is one object; mark_signed_in() is void.
const v2Rpc = (extra) => Object.assign({
  hub_schema_version: () => 2,
  clock: (db) => (db.clockFail ? { __status: 500, body: { message: 'Database restarting' } } : Object.assign({}, db.clock)),
  mark_signed_in: (db, body, email) => {
    (db.signedIn = db.signedIn || []).push(email);
    return db.markFail ? { __status: 500, body: { message: 'Database restarting' } } : null;
  },
  day_text: () => 'Sun Nov 1\n4:00pm Piano · with Jordan',
  agenda: () => ({ __status: 400, body: { code: '22023', message: 'agenda() needs a range of 1 to 62 days.' } }),
}, extra);

// ---- Stub page modules: same register() contract as the real pages
const V2_PAGES = ['today', 'calendar', 'tasks', 'directory', 'people', 'settings'];
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true }, provides: 'openEventForm' },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true }, provides: 'openTaskForm' },
  projects: { nav: { label: 'Projects', order: 40 }, loadsProjects: true },
  directory: { nav: { label: 'Directory', order: 50 } },
  people: { nav: { label: 'Family', order: 60 } },
  settings: { nav: { label: 'Settings', order: 70 } },
  // Food comes with schema 4 (assets/modules/food.js); its openListAdd is the Add sheet's Shopping.
  food: { nav: { label: 'Food', order: 35, primary: true }, provides: 'openListAdd', min: 4 },
  // Homework comes with schema 5 (assets/modules/homework.js): a tab, not a primary page.
  homework: { nav: { label: 'Homework', order: 37 }, min: 5 },
};
const stubModule = (name, s) => `;(function () {
  var core = HomeHub.core;
  var provides = {};
  ${s.provides ? `provides[${JSON.stringify(s.provides)}] = function (defaults) {
    (window.__added = window.__added || []).push({ page: ${JSON.stringify(name)}, fn: ${JSON.stringify(s.provides)}, defaults: defaults, n: arguments.length });
    if ((defaults && defaults.fail) || window.__failAdd) throw new Error('That form is broken');
  };` : ''}
  HomeHub.register({
    name: ${JSON.stringify(name)},
    schema: { min: ${s.min || 2}, max: 99 },
    nav: ${JSON.stringify(s.nav)},
    match: function (parts) {
      if (${!!s.root} && !parts.length) return {};
      return parts[0] === ${JSON.stringify(name)} ? {} : null;
    },
    render: ${s.loadsProjects ? `async function (main) {
      var rows = await core.api.projects();
      window.__projects = rows;
      main.innerHTML = '<p id="probe">projects ' + rows.length + '</p>';
    }` : `function (main) {
      (window.__renders = window.__renders || []).push({ page: ${JSON.stringify(name)}, today: core.v2.dates.today() });
      main.innerHTML = '<h1>' + ${JSON.stringify(s.nav.label)} + '</h1><p id="probe">${name} ' + core.v2.dates.today() + '</p>'
        + '<div id="filler" style="height:1400px"></div><p id="last">End of page</p>';
    }`},
    provides: provides,
  });
})();`;

const emailOf = (req) => {
  const tok = (req.headers()['authorization'] || '').replace(/^Bearer\s+/i, '');
  try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email || null; } catch (e) { return null; }
};

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

  async function open(opts = {}) {
    const db = opts.db || (opts.v1 ? makeDb() : v2Db());
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 }, timezoneId: 'Pacific/Honolulu' }, opts.ctx));
    if (opts.email !== null) await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // v1 mode: the 404 for hub_schema_version is expected, as in the other files.
      if (opts.v1 && /status of 404/.test(m.text()) && /hub_schema_version$/.test(m.location().url || '')) return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => { (db.dialogs = db.dialogs || []).push(d.message()); return db.confirm === false ? d.dismiss() : d.accept(); });
    await install(page, db, log, { rpc: opts.v1 ? {} : v2Rpc(opts.rpc) });
    // Record what is written to projects, then let the mock answer.
    db.projectWrites = [];
    await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/projects', async (route) => {
      const req = route.request();
      if (req.method() === 'PATCH' || req.method() === 'POST') {
        db.projectWrites.push({ method: req.method(), url: decodeURIComponent(req.url()), body: JSON.parse(req.postData() || 'null') });
        if (req.method() === 'PATCH' && db.beforePatch) db.beforePatch();
        if (req.method() === 'PATCH' && db.failPatch) return route.fulfill({ status: 500, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"message":"Database restarting"}' });
      }
      return route.fallback();
    });
    // whoami() in v2 adds the caller's person: { id, name, role, language, color } or null.
    if (!opts.v1) {
      await page.route(`${SUPA}/rest/v1/rpc/whoami`, (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const m = db.members.find((x) => x.email === emailOf(req));
        const p = m && !db.whoamiNoPerson && (db.people || []).find((x) => x.email === m.email);
        const body = m ? Object.assign({}, m, { person: p ? { id: p.id, name: p.name, role: p.role, language: p.language, color: p.color } : null }) : null;
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      });
    }
    // The v2 pages: stubs in v2 mode; in v1 mode an empty file, as if they didn't exist yet.
    for (const name of V2_PAGES) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule(name, STUBS[name]) }));
    }
    if (!opts.v1) await page.route('**/assets/modules/projects.js*', (route) => route.fulfill({ contentType: 'application/javascript', body: stubModule('projects', STUBS.projects) }));
    // Food (schema 4 only), with openListAdd unless opts.food says otherwise.
    await page.route('**/assets/modules/food.js*', (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule('food', opts.food || STUBS.food) }));
    // Homework (schema 5 only).
    await page.route('**/assets/modules/homework.js*', (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule('homework', STUBS.homework) }));
    await page.goto(BASE + (opts.path || '/'));
    await page.waitForTimeout(opts.wait || 600);
    return { page, db, log, context };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(350); };
  const rpcCount = (db, name) => (db.rpcCalls || []).filter((c) => c.name === name).length;
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const rect = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; });

  // =====================================================================
  // 1. index.html: scripts, styles and the home-screen tags
  // =====================================================================
  // (call() is checked against a fake agenda() that answers 400, as PostgREST does for a raised error.)
  let { page, db, log } = await open({ label: 'v2-desktop', allowConsole: /status of 400/ });
  const head = await page.evaluate(() => ({
    scripts: [...document.querySelectorAll('script[src]')].map((s) => ({ src: s.getAttribute('src'), async: s.async || s.defer })),
    styles: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')),
    manifest: (document.querySelector('link[rel=manifest]') || {}).href,
    touchIcon: (document.querySelector('link[rel=apple-touch-icon]') || {}).href,
    theme: [...document.querySelectorAll('meta[name=theme-color]')].map((m) => m.content),
    capable: (document.querySelector('meta[name=apple-mobile-web-app-capable]') || {}).content,
    statusBar: (document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]') || {}).content,
    viewport: (document.querySelector('meta[name=viewport]') || {}).content,
  }));
  const order = head.scripts.map((s) => s.src.replace(/\?.*$/, '').replace(/^https:\/\/cdn\.jsdelivr\.net\/.*\/supabase\.js$/, 'supabase-js'));
  const v1Mods = ['home', 'projects', 'contractors', 'family'].map((m) => `assets/modules/${m}.js`);
  const v2Mods = V2_PAGES.map((m) => `assets/modules/${m}.js`);
  // v1.3 adds plan.js after shoplist.js and homework.js after food.js (on purpose).
  check('index.html: core first, then shoplist.js and plan.js, the v1 modules, the v2 modules, Food and Homework, in order',
    same(order, ['config.js', 'supabase-js', 'assets/gantt.js', 'assets/hub.js', 'assets/shoplist.js', 'assets/plan.js', ...v1Mods, ...v2Mods,
      'assets/modules/food.js', 'assets/modules/homework.js']), order.join(', '));
  check('index.html: no script is async or deferred', head.scripts.every((s) => !s.async));
  // Then projects.css: the Projects page is a v1 page and a v2 page; its styles apply to the v2 one only.
  // Then food.css (schema 4), and plan.css and homework.css (schema 5).
  check('index.html: page styles load after styles.css, in order',
    same(head.styles.map((h) => h.replace(/\?.*$/, '')), ['assets/styles.css', ...V2_PAGES.map((m) => `assets/css/${m}.css`), 'assets/css/projects.css', 'assets/css/food.css',
      'assets/css/plan.css', 'assets/css/homework.css']), head.styles.join(', '));
  const vers = new Set([...head.scripts.map((s) => s.src), ...head.styles].map((u) => (u.match(/[?&]v=([^&]+)/) || [])[1]));
  check(`index.html: every script and stylesheet carries ?v=${V}`, vers.size === 1 && vers.has(V), [...vers].join(', '));
  check('index.html: manifest, apple-touch-icon, theme-color and iPhone web-app tags',
    /manifest\.webmanifest$/.test(head.manifest || '') && /assets\/icons\/apple-touch-icon\.png$/.test(head.touchIcon || '')
    && head.theme.length >= 1 && head.capable === 'yes' && !!head.statusBar && /viewport-fit=cover/.test(head.viewport), JSON.stringify(head).slice(0, 200));
  const fetched = await page.evaluate(async (urls) => Promise.all(urls.map(async (u) => (await fetch(new URL(u, location.href))).status)),
    [head.manifest, head.touchIcon, ...head.styles]);
  check('index.html: the manifest, icon and every stylesheet exist', fetched.every((s) => s === 200), fetched.join(','));

  // =====================================================================
  // 2. Sign-in in v2: people, household, clock, mark_signed_in
  // =====================================================================
  const loaded = await page.evaluate(() => {
    const v2 = HomeHub.core.v2;
    return { version: HomeHub.core.schemaVersion, people: v2.people().map((p) => p.id), me: v2.mePerson && v2.mePerson.id,
      tz: v2.household && v2.household.tz, clock: v2.clock, sam: v2.person('p-sam') && v2.person('p-sam').name, nobody: v2.person('p-nobody') };
  });
  check('v2: schema version 2', loaded.version === 2);
  check('v2: people loaded, active and inactive, by sort_order then name', same(loaded.people, ['p-alex', 'p-sam', 'p-jordan', 'p-taylor', 'p-morgan']), loaded.people.join(','));
  check('v2: people are read with order=sort_order,name', log.some((l) => /^GET \/rest\/v1\/people\?select=\*&order=sort_order\.asc,name\.asc$/.test(decodeURIComponent(l))), log.filter((l) => l.includes('people')).join(' | '));
  check('v2: person(id) finds a person, or null', loaded.sam === 'Sam Example' && loaded.nobody === null);
  check('v2: mePerson comes from whoami().person', loaded.me === 'p-alex', loaded.me);
  check('v2: household row cached', loaded.tz === 'America/New_York');
  check('v2: clock cached as { local_date, local_time, tz }', same(loaded.clock, db.clock), JSON.stringify(loaded.clock));
  check('v2: mark_signed_in called once after sign-in', same(db.signedIn, ['alex@example.com']), JSON.stringify(db.signedIn));
  check('v2: the people array handed out is a copy', await page.evaluate(() => { HomeHub.core.v2.people().length = 0; return HomeHub.core.v2.people().length === 5; }));

  // =====================================================================
  // 3. Desktop shell: top tabs in order, Add and Sign out, no bottom bar
  // =====================================================================
  const tabs = await page.$$eval('.tabs a', (as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
  check('desktop: top tabs Today · Calendar · Tasks · Projects · Directory · Family · Settings',
    same(tabs.map((t) => t[0]), ['Today', 'Calendar', 'Tasks', 'Projects', 'Directory', 'Family', 'Settings']) && tabs[0][1] === '#/', JSON.stringify(tabs));
  check('desktop: the bottom bar is hidden', !(await page.isVisible('.bottombar')) && (await page.isVisible('.tabs')));
  check('desktop: Today is the first page and current', (await text(page, '#probe')) === 'today 2026-11-01' && (await page.getAttribute('.tabs a[data-tab="today"]', 'aria-current')) === 'page');
  check('desktop: Add and Sign out in the top bar', await page.isVisible('.topbar [data-shell="add"]') && await page.isVisible('.topbar [data-shell="sign-out"]'));
  await page.click('.topbar [data-shell="add"]');
  await page.waitForTimeout(150);
  check('desktop: Add opens the Add sheet', await page.$eval('#sheet', (d) => d.open) && (await text(page, '#sheet')).includes('Event'));
  await page.screenshot({ path: SHOTS + 'v2-desktop-add.png' });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: SHOTS + 'v2-desktop.png' });

  // =====================================================================
  // 4. The clock: refreshed on every navigation; a failed refresh keeps the last one
  // =====================================================================
  let before = rpcCount(db, 'clock');
  db.clock = { local_date: '2026-11-02', local_time: '00:00:05', tz: 'America/New_York' };
  await go(page, '#/calendar');
  const afterNav = await page.evaluate(() => ({ today: HomeHub.core.v2.dates.today(), last: window.__renders[window.__renders.length - 1] }));
  check('clock: re-read on navigation, before the page renders', rpcCount(db, 'clock') === before + 1 && afterNav.today === '2026-11-02' && afterNav.last.page === 'calendar' && afterNav.last.today === '2026-11-02', JSON.stringify(afterNav));
  await go(page, '#/');
  check('clock: re-read on every navigation', rpcCount(db, 'clock') === before + 2);

  // =====================================================================
  // 5. core.v2.call
  // =====================================================================
  const called = await page.evaluate(async () => {
    const out = {};
    out.text = await HomeHub.core.v2.call('day_text', { p_person: 'p-jordan', p_day: '2026-11-01' });
    try { await HomeHub.core.v2.call('agenda', { p_from: '2026-11-01', p_to: '2027-03-01' }); out.threw = null; } catch (e) { out.threw = e.message; out.code = e.code; }
    return out;
  });
  const dayTextCall = (db.rpcCalls || []).find((c) => c.name === 'day_text');
  check('call(): returns the RPC result and passes the args', called.text === 'Sun Nov 1\n4:00pm Piano · with Jordan' && same(dayTextCall.body, { p_person: 'p-jordan', p_day: '2026-11-01' }), JSON.stringify(called));
  check('call(): throws the database error', called.threw === 'agenda() needs a range of 1 to 62 days.' && called.code === '22023', JSON.stringify(called));
  await page.context().close();

  // a failed clock refresh: the page still shows, with the last clock
  ({ page, db } = await open({ label: 'clock-fail', allowConsole: /status of 500/ }));
  db.clockFail = true;
  await go(page, '#/tasks');
  check('clock: a failed refresh keeps the last clock and still shows the page', (await text(page, '#probe')) === 'tasks 2026-11-01' && !(await page.$('.banner-error')), await text(page, '#main'));
  await page.context().close();

  // =====================================================================
  // 6. fmt and dates in the household zone (New York) on a Honolulu device, incl. 2026-11-01 (DST ends)
  // =====================================================================
  ({ page, db } = await open({ label: 'fmt' }));
  const f = await page.evaluate(() => {
    const { fmt, dates } = HomeHub.core.v2;
    const deviceHour = new Date('2026-11-01T14:00:00Z').getHours();
    const it = (o) => Object.assign({ kind: 'event', all_day: false, day: '2026-11-01', end_day: '2026-11-01', local_start: null, local_end: null, start_at: null, end_at: null }, o);
    return {
      deviceHour,
      time: [fmt.time('16:00:00'), fmt.time('00:05'), fmt.time('12:30:00'), fmt.time('09:07:00.123'), fmt.time(null), fmt.time('nonsense'), fmt.time('24:00:00')],
      empty: [fmt.day(null), fmt.dayLong(''), fmt.short(undefined), fmt.relDay('not a date'), fmt.range(null)],
      dst: [fmt.time('2026-11-01T05:30:00Z'), fmt.time('2026-11-01T06:30:00Z'), fmt.time('2026-11-01T14:00:00+00:00'), fmt.time('2026-10-31T14:00:00+00:00')],
      day: [fmt.day('2026-11-01'), fmt.day('2026-10-27'), fmt.day('2026-11-02T09:30:00Z'), fmt.day('2026-11-01T03:30:00Z')],
      dayLong: [fmt.dayLong('2026-10-27'), fmt.dayLong('2026-11-01')],
      short: [fmt.short('2026-10-27'), fmt.short('2027-01-01')],
      rel: [fmt.relDay('2026-11-01'), fmt.relDay('2026-11-02'), fmt.relDay('2026-10-31'), fmt.relDay('2026-11-04'), fmt.relDay('2026-11-01T08:30:00Z')],
      range: [
        fmt.range(it({ all_day: true })),
        fmt.range(it({ all_day: true, day: '2026-10-27', end_day: '2026-10-30' })),
        fmt.range(it({ all_day: true, day: '2026-10-30', end_day: '2026-11-02' })),
        fmt.range(it({ local_start: '16:00:00', local_end: '17:00:00' })),
        fmt.range(it({ local_start: '11:00:00', local_end: '13:00:00' })),
        fmt.range(it({ kind: 'task', local_start: '08:30:00' })),
        fmt.range(it({ start_at: '2026-11-01T13:00:00+00:00', end_at: '2026-11-01T14:30:00+00:00' })),
        fmt.range(it({ local_start: '22:00:00', local_end: '01:00:00', end_day: '2026-11-02' })),
        fmt.range(it({ kind: 'task', all_day: true, local_start: null })),
      ],
      // agenda() gives end_at = start + 1 hour when no end time was entered; local_end stays null.
      rangeNoEnd: fmt.range(it({ local_start: '15:15:00', local_end: null, start_at: '2026-11-01T20:15:00+00:00', end_at: '2026-11-01T21:15:00+00:00' })),
      dates: {
        today: dates.today(),
        add: [dates.addDays('2026-10-31', 1), dates.addDays('2026-11-01', 1), dates.addDays('2027-03-14', 1), dates.addDays('2026-11-01', -7), dates.addDays('2026-12-31', 1)],
        wd: [dates.isoWeekday('2026-11-01'), dates.isoWeekday('2026-10-26'), dates.isoWeekday('2026-10-31')],
        monday: [dates.mondayOf('2026-11-01'), dates.mondayOf('2026-10-26'), dates.mondayOf('2027-01-01')],
        grid: dates.monthGrid('2026-11-15'),
      },
    };
  });
  check('fmt: the device really is in Honolulu (so the checks below mean something)', f.deviceHour === 4, f.deviceHour);
  check('fmt.time: wall-clock times', same(f.time, ['4:00pm', '12:05am', '12:30pm', '9:07am', '', '', '12:00am']), JSON.stringify(f.time));
  check('fmt: a missing or unreadable date gives an empty label, not an error', same(f.empty, ['', '', '', '', 'All day']), JSON.stringify(f.empty));
  check('fmt.time: instants in New York time across the 2026-11-01 DST change', same(f.dst, ['1:30am', '1:30am', '9:00am', '10:00am']), JSON.stringify(f.dst));
  check('fmt.day: Tue Oct 27 style; instants by the household date, not the device date', same(f.day, ['Sun Nov 1', 'Tue Oct 27', 'Mon Nov 2', 'Sat Oct 31']), JSON.stringify(f.day));
  check('fmt.dayLong and fmt.short', same(f.dayLong, ['Tuesday, October 27', 'Sunday, November 1']) && same(f.short, ['Oct 27', 'Jan 1']), JSON.stringify([f.dayLong, f.short]));
  check('fmt.relDay: Today / Tomorrow / Yesterday from the household clock, else the day', same(f.rel, ['Today', 'Tomorrow', 'Yesterday', 'Wed Nov 4', 'Today']), JSON.stringify(f.rel));
  check('fmt.range: All day, Oct 27–30, Oct 30–Nov 2, 4:00–5:00pm, 11:00am–1:00pm, a task time, instants on the DST day, past midnight',
    same(f.range, ['All day', 'Oct 27–30', 'Oct 30–Nov 2', '4:00–5:00pm', '11:00am–1:00pm', '8:30am', '8:00–9:30am', '10:00pm–1:00am', 'All day']), JSON.stringify(f.range));
  check('fmt.range: an agenda row without an end time shows only its start (not start + 1 hour)', f.rangeNoEnd === '3:15pm', f.rangeNoEnd);
  check('dates.today() is the household clock date', f.dates.today === '2026-11-01');
  check('dates.addDays across DST changes and the year end', same(f.dates.add, ['2026-11-01', '2026-11-02', '2027-03-15', '2026-10-25', '2027-01-01']), JSON.stringify(f.dates.add));
  check('dates.isoWeekday: 1 = Monday … 7 = Sunday', same(f.dates.wd, [7, 1, 6]), JSON.stringify(f.dates.wd));
  check('dates.mondayOf', same(f.dates.monday, ['2026-10-26', '2026-10-26', '2026-12-28']), JSON.stringify(f.dates.monday));
  const grid = f.dates.grid;
  check('dates.monthGrid: 6 weeks of 7 dates, Monday first, covering the month',
    grid.length === 6 && grid.every((w) => w.length === 7) && grid[0][0] === '2026-10-26' && grid[5][6] === '2026-12-06'
    && grid.flat().includes('2026-11-01') && grid.flat().includes('2026-11-30') && new Set(grid.flat()).size === 42, JSON.stringify([grid[0], grid[5]]));
  await page.context().close();

  // =====================================================================
  // 7. Phone shell: bottom bar, More sheet, Sign out
  // =====================================================================
  ({ page, db } = await open({ label: 'phone', ctx: phone }));
  const bar = await page.$$eval('.bottombar > *', (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { text: e.innerText.trim(), label: e.getAttribute('aria-label'), tab: e.dataset.tab || null, w: r.width, h: r.height };
  }));
  check('phone: bottom bar is Today · Calendar · ＋ · Tasks · More',
    same(bar.map((b) => b.tab || b.label || b.text), ['today', 'calendar', 'Add an event or task', 'tasks', 'More']) && same(bar.map((b) => b.text).filter(Boolean), ['Today', 'Calendar', 'Tasks', 'More']), JSON.stringify(bar.map((b) => b.tab || b.label || b.text)));
  check('phone: every bottom bar target is at least 44px', bar.every((b) => b.w >= 44 && b.h >= 44), JSON.stringify(bar.map((b) => [Math.round(b.w), Math.round(b.h)])));
  const barBox = await rect(page, '.bottombar');
  check('phone: the bottom bar is fixed to the bottom of the screen', Math.abs(barBox.bottom - 844) < 1 && barBox.left === 0 && Math.round(barBox.w) === 390, JSON.stringify(barBox));
  check('phone: top tabs and desktop buttons hidden', !(await page.isVisible('.topbar .tabs')) && !(await page.isVisible('.topbar [data-shell="add"]')) && await page.isVisible('.topbar .brand'));
  check('phone: Today is current in the bottom bar', (await page.getAttribute('.bottombar a[data-tab="today"]', 'aria-current')) === 'page');
  check('phone: no sideways scroll', await noSideScroll(page));
  await page.screenshot({ path: SHOTS + 'v2-phone.png' });
  // the end of a long page can scroll clear of the bar
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(100);
  const lastBox = await rect(page, '#last');
  const barTop = (await rect(page, '.bottombar')).top;
  check('phone: the end of the page scrolls clear of the bottom bar', lastBox.bottom <= barTop, `${lastBox.bottom} vs ${barTop}`);
  await page.click('.bottombar a[data-tab="calendar"]');
  await page.waitForTimeout(300);
  check('phone: tapping Calendar opens it and marks it current', (await text(page, '#probe')).startsWith('calendar') && (await page.getAttribute('.bottombar a[data-tab="calendar"]', 'aria-current')) === 'page'
    && (await page.getAttribute('.bottombar a[data-tab="today"]', 'aria-current')) === 'false');

  await page.click('.bb-more');
  await page.waitForTimeout(200);
  const more = await page.evaluate(() => ({
    open: document.querySelector('#sheet').open,
    title: document.querySelector('#sheet h3').textContent,
    links: [...document.querySelectorAll('#sheet .sheet-list a')].map((a) => [a.textContent, a.dataset.tab]),
    signOut: !!document.querySelector('#sheet [data-act="sign-out"]'),
    box: (() => { const r = document.querySelector('#sheet').getBoundingClientRect(); return { bottom: r.bottom, w: r.width }; })(),
    linkH: Math.min(...[...document.querySelectorAll('#sheet .sheet-list a, #sheet button')].map((a) => a.getBoundingClientRect().height)),
  }));
  check('More: a sheet with Projects, Directory, Family, Settings and Sign out', more.open && more.title === 'More'
    && same(more.links.map((l) => l[0]), ['Projects', 'Directory', 'Family', 'Settings']) && more.signOut, JSON.stringify(more));
  check('More: on phones it is a bottom sheet with 44px targets', Math.abs(more.box.bottom - 844) < 2 && Math.round(more.box.w) === 390 && more.linkH >= 44, JSON.stringify(more.box) + ' ' + more.linkH);
  await page.screenshot({ path: SHOTS + 'v2-phone-more.png' });
  await page.click('#sheet .sheet-list a[data-tab="directory"]');
  await page.waitForTimeout(300);
  check('More: a page link opens that page and closes the sheet', !(await page.$eval('#sheet', (d) => d.open)) && (await text(page, '#probe')).startsWith('directory'));
  check('More: stands for the current page when it is not in the bar', await page.$eval('.bb-more', (b) => b.classList.contains('is-current'))
    && (await page.$$eval('.bottombar a[aria-current="page"]', (a) => a.length)) === 0);
  await go(page, '#/tasks');
  check('More: no longer current on a bottom bar page', !(await page.$eval('.bb-more', (b) => b.classList.contains('is-current'))));
  await page.click('.bb-more');
  await page.waitForTimeout(150);
  await page.evaluate(() => ['homehub.shop.hub', 'homehub.shop.day', 'homehub.directory.kind'].forEach((k) => localStorage.setItem(k, '{"v":1,"owner":"p-alex"}')));
  await page.click('#sheet [data-act="sign-out"]');
  await page.waitForTimeout(600);
  const kept = await page.evaluate(() => ['homehub.shop.hub', 'homehub.shop.day', 'homehub.directory.kind'].map((k) => localStorage.getItem(k) !== null));
  check('Sign out forgets the Food page\'s saved shopping list (homehub.shop.hub), and nothing else', same(kept, [false, true, true]), JSON.stringify(kept));
  check('More: Sign out returns to the sign-in screen without the bar', (await text(page, 'body')).includes('Email me a sign-in code')
    && !(await page.$('.bottombar')) && !(await page.evaluate(() => document.body.classList.contains('has-bottombar'))) && !(await page.$eval('#sheet', (d) => d.open)));
  check('Sign out clears the v2 caches', await page.evaluate(() => HomeHub.core.v2.people().length === 0 && HomeHub.core.v2.mePerson === null && HomeHub.core.v2.clock === null));
  await page.context().close();

  // =====================================================================
  // 8. The Add sheet calls the right page's form
  // =====================================================================
  ({ page, db } = await open({ label: 'add', ctx: phone }));
  await page.click('.bb-add');
  await page.waitForTimeout(200);
  const addSheet = await page.evaluate(() => ({
    open: document.querySelector('#sheet').open,
    title: document.querySelector('#sheet h3').textContent,
    choices: [...document.querySelectorAll('#sheet [data-add]')].map((b) => [b.dataset.add, b.querySelector('b').textContent, b.getBoundingClientRect().height]),
    help: document.querySelector('#sheet .add-help').textContent,
  }));
  check('Add: sheet with an Event | Task switch and the help line', addSheet.open && addSheet.title === 'Add'
    && same(addSheet.choices.map((c) => c.slice(0, 2)), [['event', 'Event'], ['task', 'Task']]) && addSheet.choices.every((c) => c[2] >= 44)
    && addSheet.help === 'Piano, pickups, appointments → Event. Pills, filters, chores, calls → Task.', JSON.stringify(addSheet));
  check('Add: fits a phone without sideways scroll', await noSideScroll(page));
  await page.screenshot({ path: SHOTS + 'v2-phone-add.png' });
  await page.click('#sheet [data-add="task"]');
  await page.waitForTimeout(150);
  let added = await page.evaluate(() => window.__added || []);
  check('Add → Task calls tasks.openTaskForm and closes the sheet', added.length === 1 && added[0].page === 'tasks' && added[0].fn === 'openTaskForm' && same(added[0].defaults, {}) && !(await page.$eval('#sheet', (d) => d.open)), JSON.stringify(added));
  await page.click('.bb-add');
  await page.waitForTimeout(150);
  await page.click('#sheet [data-add="event"]');
  await page.waitForTimeout(150);
  added = await page.evaluate(() => window.__added);
  check('Add → Event calls calendar.openEventForm', added.length === 2 && added[1].page === 'calendar' && added[1].fn === 'openEventForm', JSON.stringify(added[1]));
  await page.evaluate(() => HomeHub.core.openAdd('event', { date: '2026-11-03' }));
  await page.waitForTimeout(100);
  added = await page.evaluate(() => window.__added);
  check('openAdd(kind, defaults) skips the sheet and passes the defaults', added.length === 3 && added[2].page === 'calendar' && same(added[2].defaults, { date: '2026-11-03' }) && !(await page.$eval('#sheet', (d) => d.open)), JSON.stringify(added[2]));
  await page.evaluate(() => HomeHub.core.openAdd('task', { fail: true }));
  await page.waitForTimeout(150);
  check('openAdd: a form that fails shows the error in a toast', (await text(page, '.toasts .toast-error')) === 'That form is broken', await text(page, '.toasts'));
  await page.context().close();

  // =====================================================================
  // 8b. Schema 4 (v1.2): Food in a six-cell bottom bar, Shopping in the Add sheet; 2 and 3 as pinned
  // =====================================================================
  const barOf = (p) => p.$$eval('.bottombar > *', (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    const label = e.querySelector('span');
    return { text: e.innerText.trim(), label: e.getAttribute('aria-label'), tab: e.dataset.tab || null, w: r.width, h: r.height,
      fits: !label || label.scrollWidth <= Math.ceil(label.getBoundingClientRect().width) + 1 };
  }));
  const v4 = { hub_schema_version: () => 4 };
  ({ page, db } = await open({ label: 'v4-phone', ctx: phone, rpc: v4 }));
  let bar4 = await barOf(page);
  check('schema 4 phone: the bottom bar is Today · Calendar · ＋ · Tasks · Food · More (six cells)',
    same(bar4.map((b) => b.tab || b.label || b.text), ['today', 'calendar', 'Add an event, a task or shopping', 'tasks', 'food', 'More'])
    && same(bar4.map((b) => b.text).filter(Boolean), ['Today', 'Calendar', 'Tasks', 'Food', 'More']), JSON.stringify(bar4.map((b) => b.tab || b.label || b.text)));
  check('schema 4 phone (390px): every cell at least 44px, every label fits, no sideways scroll',
    bar4.every((b) => b.w >= 44 && b.h >= 44 && b.fits) && await noSideScroll(page), JSON.stringify(bar4.map((b) => [Math.round(b.w), Math.round(b.h), b.fits])));
  check('schema 4 phone: Food has its own icon (ICON.food, a fork and knife), not the plain page icon', await page.evaluate(() => {
    const path = (html) => { const d = document.createElement('div'); d.innerHTML = html || ''; return (d.querySelector('path') || { getAttribute: () => null }).getAttribute('d'); };
    const drawn = document.querySelector('.bottombar a[data-tab="food"] svg path').getAttribute('d');
    return !!drawn && drawn === path(HomeHub.core.v2.ui.icon.food) && drawn !== path(HomeHub.core.v2.ui.icon.page);
  }));
  await page.screenshot({ path: SHOTS + 'v4-phone.png' });
  await page.click('.bottombar a[data-tab="food"]');
  await page.waitForTimeout(300);
  check('schema 4 phone: tapping Food opens it and marks it current', (await text(page, '#probe')).startsWith('food') && (await page.getAttribute('.bottombar a[data-tab="food"]', 'aria-current')) === 'page'
    && !(await page.$eval('.bb-more', (b) => b.classList.contains('is-current'))));
  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(150);
  bar4 = await barOf(page);
  check('schema 4 phone (360px): six cells, each at least 44px, every label fits, no sideways scroll',
    bar4.length === 6 && bar4.every((b) => b.w >= 44 && b.h >= 44 && b.fits) && await noSideScroll(page), JSON.stringify(bar4.map((b) => [Math.round(b.w), Math.round(b.h), b.fits])));
  await page.screenshot({ path: SHOTS + 'v4-phone-360.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.bb-add');
  await page.waitForTimeout(200);
  const add4 = await page.evaluate(() => ({
    open: document.querySelector('#sheet').open,
    group: document.querySelector('#sheet .add-switch').getAttribute('aria-label'),
    choices: [...document.querySelectorAll('#sheet [data-add]')].map((b) => [b.dataset.add, b.querySelector('b').textContent, b.querySelector('small').textContent, b.getBoundingClientRect().height, b.getBoundingClientRect().width]),
    oneRow: new Set([...document.querySelectorAll('#sheet [data-add]')].map((b) => Math.round(b.getBoundingClientRect().top))).size === 1,
    help: document.querySelector('#sheet .add-help').textContent,
  }));
  check('schema 4 Add: Event | Task | Shopping ("Something to buy") in one row, each at least 44px',
    add4.open && add4.group === 'Event, task or shopping' && same(add4.choices.map((c) => c.slice(0, 3)), [['event', 'Event', 'Happens at a time'], ['task', 'Task', 'Gets ticked off'], ['shopping', 'Shopping', 'Something to buy']])
    && add4.choices.every((c) => c[3] >= 44 && c[4] >= 44) && add4.oneRow, JSON.stringify(add4));
  check('schema 4 Add: the help line names Shopping too', add4.help === 'Piano, pickups, appointments → Event. Pills, filters, chores, calls → Task. Milk, batteries → Shopping.', add4.help);
  check('schema 4 Add: fits a phone without sideways scroll', await noSideScroll(page));
  await page.screenshot({ path: SHOTS + 'v4-phone-add.png' });
  await page.click('#sheet [data-add="shopping"]');
  await page.waitForTimeout(150);
  added = await page.evaluate(() => window.__added || []);
  check('Add → Shopping calls food.openListAdd() with nothing, and closes the sheet', added.length === 1 && added[0].page === 'food' && added[0].fn === 'openListAdd' && added[0].n === 0
    && !(await page.$eval('#sheet', (d) => d.open)), JSON.stringify(added));
  await page.click('.bb-add');
  await page.waitForTimeout(150);
  await page.click('#sheet [data-add="shopping"]');
  await page.waitForTimeout(150);
  added = await page.evaluate(() => window.__added);
  check('Add → Shopping again: two adds in a row, each through openListAdd', added.length === 2 && added.every((a) => a.fn === 'openListAdd'), JSON.stringify(added));
  await page.evaluate(() => HomeHub.core.openAdd('shopping'));
  await page.waitForTimeout(100);
  added = await page.evaluate(() => window.__added);
  check('openAdd(\'shopping\') skips the sheet', added.length === 3 && added[2].fn === 'openListAdd' && !(await page.$eval('#sheet', (d) => d.open)), JSON.stringify(added[2]));
  await page.evaluate(() => { window.__failAdd = true; HomeHub.core.openAdd('shopping'); });
  await page.waitForTimeout(150);
  check('openAdd(\'shopping\'): an add box that fails shows the error in a toast', (await text(page, '.toasts .toast-error')) === 'That form is broken', await text(page, '.toasts'));
  await page.context().close();

  // a schema-4 tablet: eight top tabs on their own row, all on screen
  ({ page } = await open({ label: 'v4-tablet', rpc: v4, ctx: { viewport: { width: 700, height: 1000 }, hasTouch: true } }));
  const tablet4 = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => [a.textContent, a.getBoundingClientRect().height]),
    tabsFit: [...document.querySelectorAll('.tabs a')].every((a) => a.getBoundingClientRect().right <= document.querySelector('.tabs').getBoundingClientRect().right + 1),
  }));
  check('schema 4 tablet: the eight top tabs (Food after Tasks) are on screen, each at least 44px',
    same(tablet4.tabs.map((t) => t[0]), ['Today', 'Calendar', 'Tasks', 'Food', 'Projects', 'Directory', 'Family', 'Settings']) && tablet4.tabs.every((t) => t[1] >= 44) && tablet4.tabsFit
    && await noSideScroll(page), JSON.stringify(tablet4));
  await page.screenshot({ path: SHOTS + 'v4-tablet.png' });
  await page.context().close();

  // schema 4, but a Food page without openListAdd (an older food.js): Event | Task only
  ({ page } = await open({ label: 'v4-no-list-add', ctx: phone, rpc: v4, food: { nav: { label: 'Food', order: 35, primary: true }, min: 4 } }));
  await page.click('.bb-add');
  await page.waitForTimeout(150);
  check('schema 4 without openListAdd: the Add sheet is Event | Task', same(await page.$$eval('#sheet [data-add]', (b) => b.map((x) => x.dataset.add)), ['event', 'task'])
    && (await page.getAttribute('.bb-add', 'aria-label')) === 'Add an event or task');
  await page.context().close();

  // schema 5 (v1.3): Homework is a tab, not a primary page: the bar stays Today · Calendar · ＋ · Tasks · Food · More,
  // and Homework is in the More sheet; a tablet shows nine top tabs, Homework after Food.
  const v5 = { hub_schema_version: () => 5 };
  ({ page } = await open({ label: 'v5-phone', ctx: phone, rpc: v5 }));
  const bar5 = await barOf(page);
  check('schema 5 phone: the bottom bar stays Today · Calendar · ＋ · Tasks · Food · More (six cells)',
    same(bar5.map((b) => b.tab || b.label || b.text), ['today', 'calendar', 'Add an event, a task or shopping', 'tasks', 'food', 'More'])
    && bar5.every((b) => b.w >= 44 && b.h >= 44 && b.fits) && await noSideScroll(page), JSON.stringify(bar5.map((b) => b.tab || b.label || b.text)));
  await page.click('.bb-more');
  await page.waitForTimeout(200);
  check('schema 5 phone: More lists Homework with the other pages', same(await page.$$eval('#sheet .sheet-list a', (as) => as.map((a) => a.textContent)),
    ['Homework', 'Projects', 'Directory', 'Family', 'Settings']), JSON.stringify(await page.$$eval('#sheet .sheet-list a', (as) => as.map((a) => a.textContent))));
  await page.click('#sheet .sheet-list a[data-tab="homework"]');
  await page.waitForTimeout(300);
  check('schema 5 phone: Homework from More opens it, and More is current', (await text(page, '#probe')).startsWith('homework')
    && (await page.$eval('.bb-more', (b) => b.classList.contains('is-current'))));
  await page.screenshot({ path: SHOTS + 'v5-phone.png' });
  await page.context().close();
  ({ page } = await open({ label: 'v5-tablet', rpc: v5, ctx: { viewport: { width: 700, height: 1000 }, hasTouch: true } }));
  const tablet5 = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => [a.textContent, a.getBoundingClientRect().height]),
    tabsFit: [...document.querySelectorAll('.tabs a')].every((a) => a.getBoundingClientRect().right <= document.querySelector('.tabs').getBoundingClientRect().right + 1),
  }));
  check('schema 5 tablet: nine top tabs (Homework after Food), each at least 44px, all on screen',
    same(tablet5.tabs.map((t) => t[0]), ['Today', 'Calendar', 'Tasks', 'Food', 'Homework', 'Projects', 'Directory', 'Family', 'Settings']) && tablet5.tabs.every((t) => t[1] >= 44)
    && tablet5.tabsFit && await noSideScroll(page), JSON.stringify(tablet5));
  await page.screenshot({ path: SHOTS + 'v5-tablet.png' });
  await page.setViewportSize({ width: 641, height: 1000 });
  await page.waitForTimeout(150);
  const narrow5 = await page.evaluate(() => [...document.querySelectorAll('.tabs a')].every((a) => {
    const r = a.getBoundingClientRect();
    return r.height >= 44 && r.right <= document.querySelector('.tabs').getBoundingClientRect().right + 1;
  }));
  check('schema 5 tablet at 641px: the tabs wrap onto a second line rather than scroll out of sight; no sideways scroll', narrow5 && await noSideScroll(page));
  await page.context().close();

  // schema 3: the five-cell bar and Event | Task, as on 2; the Food page (made for 4) isn't there
  ({ page } = await open({ label: 'v3-phone', ctx: phone, rpc: { hub_schema_version: () => 3 } }));
  const bar3 = await barOf(page);
  check('schema 3 phone: the bottom bar stays Today · Calendar · ＋ · Tasks · More', same(bar3.map((b) => b.tab || b.label || b.text), ['today', 'calendar', 'Add an event or task', 'tasks', 'More']),
    JSON.stringify(bar3.map((b) => b.tab || b.label || b.text)));
  await page.click('.bb-add');
  await page.waitForTimeout(150);
  const add3 = await page.evaluate(() => ({ choices: [...document.querySelectorAll('#sheet [data-add]')].map((b) => b.dataset.add),
    help: document.querySelector('#sheet .add-help').textContent, three: !!document.querySelector('#sheet .add-three') }));
  check('schema 3 Add: Event | Task and the help line, as pinned', same(add3.choices, ['event', 'task']) && !add3.three
    && add3.help === 'Piano, pickups, appointments → Event. Pills, filters, chores, calls → Task.', JSON.stringify(add3));
  await page.keyboard.press('Escape');
  await page.evaluate(() => HomeHub.core.openAdd('shopping'));
  await page.waitForTimeout(150);
  check('schema 3: openAdd(\'shopping\') says the page isn\'t there instead of failing quietly', /isn't available/.test(await text(page, '.toasts .toast-error'))
    && !(await page.evaluate(() => (window.__added || []).length)), await text(page, '.toasts'));
  await page.context().close();

  // Signing out forgets the Food page's saved list (homehub.shop.hub): the desktop Sign out, and a
  // sign-out that comes from elsewhere (another tab, an expired sign-in), once the page has closed.
  ({ page } = await open({ label: 'v4-sign-out', rpc: v4 }));
  const keys = ['homehub.shop.hub', 'homehub.shop.day', 'homehub.directory.kind'];
  await page.evaluate((ks) => ks.forEach((k) => localStorage.setItem(k, '{"v":1,"owner":"p-alex"}')), keys);
  await page.click('.topbar [data-shell="sign-out"]');
  await page.waitForTimeout(600);
  let left = await page.evaluate((ks) => ks.map((k) => localStorage.getItem(k) !== null), keys);
  check('Sign out (desktop): homehub.shop.hub is removed; My day\'s list and other settings stay', same(left, [false, true, true])
    && (await text(page, 'body')).includes('Email me a sign-in code'), JSON.stringify(left));
  await page.context().close();
  ({ page } = await open({ label: 'v4-signed-out-elsewhere', rpc: v4 }));
  await page.evaluate(() => localStorage.setItem('homehub.shop.hub', '{"v":1,"owner":"p-alex"}'));
  await page.evaluate(() => HomeHub.core.sb.auth.signOut());
  await page.waitForTimeout(600);
  check('a sign-out from elsewhere also removes homehub.shop.hub once the page has closed', (await page.evaluate(() => localStorage.getItem('homehub.shop.hub'))) === null
    && (await text(page, 'body')).includes('Email me a sign-in code'));
  await page.context().close();

  // =====================================================================
  // 9. Toasts: the old toast(msg), and "Done · Undo"
  // =====================================================================
  ({ page, db } = await open({ label: 'toast', ctx: phone }));
  await page.evaluate(() => HomeHub.core.toast('Saved'));
  check('toast(msg) still shows a plain message', (await text(page, '.toasts .toast')) === 'Saved' && !(await page.$('.toast-action')));
  await page.waitForTimeout(2300);
  check('toast(msg) goes after 2 seconds', !(await page.$('.toasts .toast')));
  await page.evaluate(() => {
    window.__undone = 0;
    window.__handle = HomeHub.core.toast('Done', { action: { label: 'Undo', onClick: () => { window.__undone += 1; } } });
  });
  const t1 = await page.evaluate(() => {
    const t = document.querySelector('.toasts .toast-action');
    const b = t.querySelector('button');
    const barRect = document.querySelector('.bottombar').getBoundingClientRect();
    return { text: t.querySelector('span').textContent, button: b.textContent, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width,
      bottom: t.getBoundingClientRect().bottom, barTop: barRect.top, live: document.querySelector('.toasts').getAttribute('aria-live'), handle: typeof window.__handle.close };
  });
  check('toast with an action: "Done · Undo" with a 44px button', t1.text === 'Done' && t1.button === 'Undo' && t1.h >= 44 && t1.w >= 44 && t1.handle === 'function', JSON.stringify(t1));
  check('toast sits above the bottom bar on phones and is announced', t1.bottom <= t1.barTop && t1.live === 'polite', JSON.stringify(t1));
  await page.screenshot({ path: SHOTS + 'v2-phone-toast.png' });
  await page.waitForTimeout(2500);
  check('action toast is still there after 2.5 seconds', !!(await page.$('.toast-action')));
  await page.click('.toast-action button');
  await page.waitForTimeout(100);
  check('Undo runs the action once and closes the toast', (await page.evaluate(() => window.__undone)) === 1 && !(await page.$('.toast-action')));
  await page.evaluate(() => {
    HomeHub.core.toast('First', { action: { label: 'Undo', onClick() {} } });
    HomeHub.core.toast('Second', { action: { label: 'Undo', onClick() {} } });
  });
  const stack = await page.$$eval('.toasts .toast-action span', (s) => s.map((x) => x.textContent));
  check('a newer action toast replaces the older one', same(stack, ['Second']), JSON.stringify(stack));
  await page.waitForTimeout(6300);
  check('action toast goes after 6 seconds', !(await page.$('.toast-action')));
  await page.evaluate(() => HomeHub.core.toast('Done', { ms: 300, action: { label: 'Undo', onClick() { throw Object.assign(new Error('nope'), { code: '42501' }); } } }));
  await page.click('.toast-action button');
  await page.waitForTimeout(150);
  check('an Undo that fails shows a friendly error toast', (await text(page, '.toasts .toast-error')) === "You don't have permission to do that.", await text(page, '.toasts'));
  await page.evaluate(() => HomeHub.core.toast('Done', { ms: 300, action: { label: 'Undo', onClick() {} } }));
  await page.waitForTimeout(500);
  check('{ ms } sets how long a toast stays', !(await page.$('.toast-action')));
  await page.evaluate(() => HomeHub.core.toast('A much longer message that a page might show after saving several things at once, to see it wraps', { action: { label: 'Undo', onClick() {} } }));
  check('a long toast fits a phone without sideways scroll', await noSideScroll(page));
  // An Undo is for the page it was shown on: going to another page takes it away (a redraw doesn't).
  await page.evaluate(() => { window.__undone = 0; HomeHub.core.toast('Done: Trash out', { action: { label: 'Undo', onClick() { window.__undone += 1; } } }); });
  await page.evaluate(() => HomeHub.core.route());
  await page.waitForTimeout(300);
  check('navigation: the same page drawn again keeps its Undo toast', !!(await page.$('.toast-action')));
  await page.evaluate(() => HomeHub.core.toast('Saved'));
  await go(page, '#/directory');
  check('navigation: going to another page takes the Undo toast away (a plain message stays)', !(await page.$('.toast-action')) && (await text(page, '.toasts')).includes('Saved')
    && (await page.evaluate(() => window.__undone)) === 0, await text(page, '.toasts'));
  await page.evaluate(() => HomeHub.core.toast('Done: Trash out', { action: { label: 'Undo', onClick() {} } }));
  await page.evaluate(() => history.back());
  await page.waitForTimeout(400);
  check('navigation: Back takes it away too', !(await page.$('.toast-action')));
  await page.context().close();

  // =====================================================================
  // 10. whoPicker: first tap = in charge, more taps = with, tap again to remove
  // =====================================================================
  ({ page, db } = await open({ label: 'who', ctx: phone }));
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'who';
    document.querySelector('#main').prepend(box);
    window.__who = [];
    window.__picker = HomeHub.core.v2.ui.whoPicker(box, { onChange: (v) => window.__who.push(v) });
  });
  const chips = () => page.$$eval('#who .pchip', (cs) => cs.map((c) => ({ id: c.dataset.person, name: c.querySelector('.pchip-name').textContent,
    pressed: c.getAttribute('aria-pressed'), ring: c.classList.contains('ring'), tag: !!c.querySelector('.pchip-tag'), h: c.getBoundingClientRect().height })));
  const pick = async (id) => { await page.click(`#who [data-person="${id}"]`); await page.waitForTimeout(50); return page.evaluate(() => window.__picker.value()); };
  let cs = await chips();
  check('whoPicker: active people as chips, first names, nobody chosen', same(cs.map((c) => c.name), ['Alex', 'Sam', 'Jordan', 'Taylor']) && cs.every((c) => c.pressed === 'false' && !c.ring), JSON.stringify(cs));
  check('whoPicker: chips are at least 44px tall', cs.every((c) => c.h >= 44), cs.map((c) => c.h).join(','));
  let v = await pick('p-jordan');
  cs = await chips();
  check('whoPicker: the first tap puts that person in charge (ring)', same(v, { responsibleId: 'p-jordan', participantIds: [] })
    && cs.find((c) => c.id === 'p-jordan').ring && cs.find((c) => c.id === 'p-jordan').tag && cs.find((c) => c.id === 'p-jordan').pressed === 'true', JSON.stringify(v));
  v = await pick('p-alex');
  check('whoPicker: the next tap adds someone "with" them', same(v, { responsibleId: 'p-jordan', participantIds: ['p-alex'] })
    && (await chips()).find((c) => c.id === 'p-alex').pressed === 'true' && !(await chips()).find((c) => c.id === 'p-alex').ring, JSON.stringify(v));
  v = await pick('p-taylor');
  check('whoPicker: more taps add more people', same(v, { responsibleId: 'p-jordan', participantIds: ['p-alex', 'p-taylor'] }), JSON.stringify(v));
  v = await pick('p-alex');
  check('whoPicker: tapping a "with" person again removes them', same(v, { responsibleId: 'p-jordan', participantIds: ['p-taylor'] }) && (await chips()).find((c) => c.id === 'p-alex').pressed === 'false', JSON.stringify(v));
  v = await pick('p-jordan');
  check('whoPicker: tapping the person in charge again removes them', same(v, { responsibleId: null, participantIds: ['p-taylor'] }) && !(await chips()).some((c) => c.ring), JSON.stringify(v));
  check('whoPicker: the hint says who is chosen', (await text(page, '#who .who-hint')).startsWith('Nobody in charge · with Taylor'), await text(page, '#who .who-hint'));
  v = await pick('p-sam');
  check('whoPicker: with nobody in charge, the next tap puts that person in charge', same(v, { responsibleId: 'p-sam', participantIds: ['p-taylor'] }), JSON.stringify(v));
  const changes = await page.evaluate(() => window.__who);
  check('whoPicker: onChange gets { responsibleId, participantIds } after every tap', changes.length === 6 && same(changes[5], v), JSON.stringify(changes.slice(-2)));
  check('whoPicker: fits a phone without sideways scroll', await noSideScroll(page));
  await page.screenshot({ path: SHOTS + 'v2-phone-who.png' });
  const preset = await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'who2';
    document.querySelector('#main').prepend(box);
    const p = HomeHub.core.v2.ui.whoPicker(box, { responsibleId: 'p-sam', participantIds: ['p-sam', 'p-morgan', 'p-jordan'] });
    const shown = [...box.querySelectorAll('.pchip')].map((c) => [c.dataset.person, c.classList.contains('ring'), c.getAttribute('aria-pressed')]);
    // A second picker on the same box replaces the first: one tap is one change.
    let calls = 0;
    const again = HomeHub.core.v2.ui.whoPicker(box, { responsibleId: 'p-sam', onChange: () => { calls += 1; } });
    box.querySelector('[data-person="p-alex"]').click();
    const after = again.value();
    p.set({ responsibleId: 'p-alex', participantIds: [] });
    return { start: p.value(), shown, calls, after };
  });
  check('whoPicker: starts from responsibleId / participantIds (the person in charge is not also "with")',
    same(preset.shown.find((s) => s[0] === 'p-sam'), ['p-sam', true, 'true']) && same(preset.shown.find((s) => s[0] === 'p-jordan'), ['p-jordan', false, 'true']), JSON.stringify(preset.shown));
  check('whoPicker: an inactive person shows only while chosen', preset.shown.some((s) => s[0] === 'p-morgan'), JSON.stringify(preset.shown));
  check('whoPicker: a second picker on the same box replaces the first', preset.calls === 1 && same(preset.after, { responsibleId: 'p-sam', participantIds: ['p-alex'] }), JSON.stringify(preset));
  check('whoPicker: set() replaces the choice', same(preset.start, { responsibleId: 'p-alex', participantIds: [] }), JSON.stringify(preset.start));
  const dots = await page.evaluate(() => {
    const { personDot, personChip, sectionHeading } = HomeHub.core.v2.ui;
    const v2 = HomeHub.core.v2;
    const d = document.createElement('div');
    d.innerHTML = personDot(v2.person('p-taylor')) + personDot(v2.person('p-alex'), { ring: true }) + personChip(v2.person('p-sam'), { selected: true });
    const h = document.createElement('div');
    h.innerHTML = sectionHeading('Late <b>now</b>', 3);
    return {
      taylorInk: d.children[0].getAttribute('style'), alexRing: d.children[1].classList.contains('ring'), alexLabel: d.children[1].textContent,
      chipPressed: d.children[2].getAttribute('aria-pressed'), none: personDot(null), heading: h.textContent, headingBold: !!h.querySelector('b'),
    };
  });
  check('personDot: initial on the person colour, readable ink, ring for in charge', /--pc:#fde047;--pi:#1f1b16/.test(dots.taylorInk) && dots.alexRing && dots.alexLabel === 'AAlex Example, in charge' && dots.none === '', JSON.stringify(dots));
  check('personChip: selected chips are pressed', dots.chipPressed === 'true');
  // The initials are often the only visible "who" on a row: they must read on every colour the Family
  // page offers (people.js PALETTE) and on a light one (WCAG AA, 4.5:1 for their 12-13px bold text).
  const inks = await page.evaluate(() => {
    const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    return ['#9333ea', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#db2777', '#b91c1c', '#92622f', '#64748b', '#fde047'].map((c) => {
      const d = document.createElement('div');
      d.innerHTML = HomeHub.core.v2.ui.personDot({ id: 'p-x', name: 'Zed Example', color: c });
      const ink = /--pi:(#[0-9a-fA-F]{6})/.exec(d.firstElementChild.getAttribute('style'))[1];
      return [c, ink, Math.round(ratio(c, ink) * 100) / 100];
    });
  });
  check('personDot: the initial reads on every palette colour (at least 4.5:1)', inks.every(([, , r]) => r >= 4.5), JSON.stringify(inks.filter(([, , r]) => r < 4.5)));
  check('sectionHeading: escaped text and a count', dots.heading === 'Late <b>now</b>3' && !dots.headingBold, dots.heading);
  await page.context().close();

  // =====================================================================
  // 11. itemRow: time column, checkbox, who dots, tap-to-call, statuses
  // =====================================================================
  ({ page, db } = await open({ label: 'rows', ctx: phone }));
  const rows = await page.evaluate(() => {
    const ui = HomeHub.core.v2.ui;
    const base = {
      kind: 'task', item_id: null, occurrence: '2026-11-01', title: '', day: '2026-11-01', end_day: '2026-11-01', all_day: true,
      start_at: null, end_at: null, local_start: null, local_end: null, responsible_id: null, participant_ids: [], status: 'open',
      category: 'other', project_id: null, project_name: null, contractor_id: null, contractor_name: null, contractor_phone: null,
      location: null, notes: null, private: false, repeating: false, changed: false, lead_days: 0, milestone: false,
    };
    const items = {
      timedTask: { item_id: 't1', title: 'Heartworm pill', all_day: false, local_start: '16:00:00', start_at: '2026-11-01T21:00:00+00:00', responsible_id: 'p-jordan', repeating: true },
      anyTime: { item_id: 't2', title: 'Call the plumber' },
      done: { item_id: 't3', title: 'Trash out', status: 'done' },
      late: { item_id: 't4', title: 'Furnace filter', status: 'late', day: '2026-10-31', occurrence: '2026-10-31', end_day: '2026-10-31' },
      skipped: { item_id: 't5', title: 'Water plants', status: 'skipped' },
      cancelled: { kind: 'event', item_id: 'e1', title: 'Piano', status: 'cancelled', all_day: false, local_start: '16:00:00', local_end: '17:00:00', repeating: true },
      event: { kind: 'event', item_id: 'e2', title: 'Electrician visit', all_day: false, local_start: '16:00:00', local_end: '17:00:00',
        start_at: '2026-11-01T21:00:00+00:00', end_at: '2026-11-01T22:00:00+00:00', responsible_id: 'p-sam', participant_ids: ['p-jordan', 'p-taylor'],
        contractor_id: 'c-pat', contractor_name: 'Pat Lee', contractor_phone: '(201) 555-0100', location: 'Kitchen' },
      instant: { kind: 'event', item_id: 'e3', title: 'Dentist', all_day: false, start_at: '2026-11-01T14:00:00+00:00', end_at: '2026-11-01T15:00:00+00:00' },
      project: { kind: 'project', item_id: 'p-kitchen', title: 'Tile backsplash', day: '2026-10-27', end_day: '2026-10-30', project_id: 'p-kitchen', project_name: 'Kitchen Renovation', milestone: false },
      // agenda() gives a timed event that ends after midnight the next day as its end_day.
      pastMidnight: { kind: 'event', item_id: 'e4', title: 'Movie night', all_day: false, day: '2026-10-31', occurrence: '2026-10-31', end_day: '2026-11-01',
        local_start: '22:00:00', local_end: '00:30:00', start_at: '2026-11-01T02:00:00+00:00', end_at: '2026-11-01T04:30:00+00:00' },
      xss: { item_id: 't9', title: '<img src=x onerror="window.__xss=1">Sneaky' },
      // agenda() rows: no end time entered (end_at is start + 1 hour), and a skipped day (it has a change row).
      noEnd: { kind: 'event', item_id: 'e5', title: 'School pickup', all_day: false, local_start: '15:15:00', local_end: null,
        start_at: '2026-11-01T20:15:00+00:00', end_at: '2026-11-01T21:15:00+00:00' },
      skippedDay: { kind: 'event', item_id: 'e6', title: 'Swim lesson', status: 'cancelled', changed: true, all_day: false, local_start: '10:00:00', local_end: '11:00:00', repeating: true },
    };
    window.__opened = [];
    window.__toggled = [];
    const box = document.createElement('div');
    box.className = 'irows';
    box.id = 'rows';
    document.querySelector('#main').prepend(box);
    const out = {};
    Object.entries(items).forEach(([key, o]) => {
      const item = Object.assign({}, base, o);
      const row = ui.itemRow(item, {
        checkbox: true, showWho: true,
        onOpen: (it) => window.__opened.push(it.item_id),
        onToggle: (it) => { window.__toggled.push(it.item_id); if (it.item_id === 't2') return Promise.reject(new Error('Could not save')); return Promise.resolve(); },
      });
      row.dataset.key = key;
      box.appendChild(row);
      const tick = row.querySelector('.irow-check');
      const title = row.querySelector('.irow-title');
      out[key] = {
        el: row instanceof HTMLElement, cls: row.className, time: [...row.querySelectorAll('.irow-time > *')].map((x) => x.textContent),
        check: tick ? { role: tick.getAttribute('role'), checked: tick.getAttribute('aria-checked'), disabled: tick.disabled } : null,
        title: title.textContent, strike: getComputedStyle(title).textDecorationLine, badges: [...row.querySelectorAll('.badge')].map((b) => b.textContent),
        sub: (row.querySelector('.irow-sub') || {}).textContent || '', dots: [...row.querySelectorAll('.pdot')].map((d) => [d.querySelector('[aria-hidden]').textContent, d.classList.contains('ring')]),
        tel: (row.querySelector('.irow-call') || {}).href || null, timeColor: getComputedStyle(row.querySelector('.irow-time span')).color, imgs: row.querySelectorAll('img').length,
        dataset: Object.assign({}, row.dataset),
      };
    });
    out.noBox = !ui.itemRow(Object.assign({}, base, items.anyTime), {}).querySelector('.irow-check');
    out.danger = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    return out;
  });
  const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  check('itemRow: returns an element with the item kind, id, occurrence and status', rows.event.el && same(rows.late.dataset, { kind: 'task', id: 't4', occurrence: '2026-10-31', status: 'late', key: 'late' }), JSON.stringify(rows.late.dataset));
  check('itemRow: open task with a time has the time and a checkbox', same(rows.timedTask.time, ['4:00pm']) && same(rows.timedTask.check, { role: 'checkbox', checked: 'false', disabled: false }), JSON.stringify(rows.timedTask));
  check('itemRow: a task without a time says "Any time"', same(rows.anyTime.time, ['Any time']) && !!rows.anyTime.check);
  check('itemRow: a done task is ticked and struck through', rows.done.check && rows.done.check.checked === 'true' && rows.done.check.disabled && rows.done.strike.includes('line-through'), JSON.stringify(rows.done));
  check('itemRow: a late task shows its day in red, a Late badge and a checkbox', same(rows.late.time, ['Yesterday']) && rows.late.badges.includes('Late') && rows.late.check && rows.late.check.checked === 'false'
    && rows.late.timeColor === rgb(rows.danger), JSON.stringify([rows.late.time, rows.late.timeColor, rows.danger]));
  check('itemRow: a skipped task is marked, with no checkbox', rows.skipped.badges.includes('Skipped') && !rows.skipped.check && rows.skipped.cls.includes('st-skipped'), JSON.stringify(rows.skipped));
  check('itemRow: a cancelled (skipped) day is struck through, with no checkbox', rows.cancelled.badges.includes('Skipped') && !rows.cancelled.check && rows.cancelled.strike.includes('line-through'), JSON.stringify(rows.cancelled));
  check('itemRow: a skipped day says just "Skipped" (as the Skip button and toast do), not also "Changed"', same(rows.skippedDay.badges, ['Skipped']), JSON.stringify(rows.skippedDay.badges));
  check('itemRow: an event without an end time shows only its start', same(rows.noEnd.time, ['3:15pm']), JSON.stringify(rows.noEnd.time));
  const said = await page.locator('#rows [data-key="event"] .irow-time').ariaSnapshot();
  check('itemRow: a screen reader hears a range as "4:00pm to 5:00pm"', /4:00pm to 5:00pm/.test(said.replace(/\s+/g, ' ')), said);
  check('itemRow: events never get a checkbox; start and end times shown', !rows.event.check && same(rows.event.time, ['4:00pm', '5:00pm']), JSON.stringify(rows.event.time));
  check('itemRow: who dots, in charge first with a ring', same(rows.event.dots, [['S', true], ['J', false], ['T', false]]) && same(rows.timedTask.dots, [['J', true]]), JSON.stringify(rows.event.dots));
  check('itemRow: a linked contractor gets tap-to-call', rows.event.tel === 'tel:2015550100' && rows.event.sub.includes('Kitchen') && rows.event.sub.includes('Pat Lee') && !rows.anyTime.tel, JSON.stringify([rows.event.tel, rows.event.sub]));
  check('itemRow: a time from start_at is shown in household time', same(rows.instant.time, ['9:00am', '10:00am']), JSON.stringify(rows.instant.time));
  check('itemRow: a timed event that ends after midnight keeps its times (only all-day items show dates)', same(rows.pastMidnight.time, ['10:00pm', '12:30am']), JSON.stringify(rows.pastMidnight));
  check('itemRow: a multi-day project task shows its dates and project', same(rows.project.time, ['Oct 27', '– Oct 30']) && rows.project.sub.includes('Kitchen Renovation') && !rows.project.check, JSON.stringify(rows.project));
  check('itemRow: titles are escaped', rows.xss.imgs === 0 && rows.xss.title.startsWith('<img src=x') && !(await page.evaluate(() => window.__xss)), rows.xss.title);
  check('itemRow: no checkbox unless asked', rows.noBox);
  await page.screenshot({ path: SHOTS + 'v2-phone-rows.png' });
  check('itemRow: rows fit a phone without sideways scroll', await noSideScroll(page));
  const targets = await page.evaluate(() => [...document.querySelectorAll('#rows .irow-check, #rows .irow-call, #rows .irow-main')].map((e) => [e.className, e.getBoundingClientRect().width, e.getBoundingClientRect().height]));
  check('itemRow: checkbox, call and title are 44px tap targets', targets.every((t) => t[2] >= 44 && (t[0] === 'irow-main' || t[1] >= 44)), JSON.stringify(targets.filter((t) => t[2] < 44 || (t[0] !== 'irow-main' && t[1] < 44))));
  await page.click('#rows [data-key="event"] .irow-main');
  check('itemRow: tapping the title calls onOpen with the item', same(await page.evaluate(() => window.__opened), ['e2']));
  await page.click('#rows [data-key="timedTask"] .irow-check');
  await page.waitForTimeout(100);
  const ticked = await page.$eval('#rows [data-key="timedTask"]', (r) => ({ checked: r.querySelector('.irow-check').getAttribute('aria-checked'), disabled: r.querySelector('.irow-check').disabled, cls: r.className }));
  check('itemRow: ticking calls onToggle and stays ticked when it succeeds', ticked.checked === 'true' && ticked.disabled && ticked.cls.includes('is-ticked') && same(await page.evaluate(() => window.__toggled), ['t1']), JSON.stringify(ticked));
  await page.click('#rows [data-key="anyTime"] .irow-check');
  await page.waitForTimeout(150);
  const failed = await page.$eval('#rows [data-key="anyTime"]', (r) => ({ checked: r.querySelector('.irow-check').getAttribute('aria-checked'), disabled: r.querySelector('.irow-check').disabled, cls: r.className }));
  check('itemRow: when onToggle fails the box unticks and the error shows', failed.checked === 'false' && !failed.disabled && !failed.cls.includes('is-ticked') && (await text(page, '.toasts .toast-error')) === 'Could not save', JSON.stringify(failed));
  await page.click('#rows [data-key="done"] .irow-check', { force: true }).catch(() => {});
  check('itemRow: a done task\'s box does nothing (no onUntick)', same(await page.evaluate(() => window.__toggled), ['t1', 't2']));
  // With onUntick, a ticked box asks "Mark … as not done?" and then calls it; a failure ticks it again.
  await page.evaluate(() => {
    const ui = HomeHub.core.v2.ui;
    window.__unticked = [];
    const base = { kind: 'task', occurrence: '2026-11-01', day: '2026-11-01', end_day: '2026-11-01', all_day: true, status: 'done', participant_ids: [] };
    [['ok', 'Trash out'], ['bad', 'Feed the fish']].forEach(([key, title]) => {
      const row = ui.itemRow(Object.assign({ item_id: key, title }, base), { checkbox: true,
        onUntick: (it) => { window.__unticked.push(it.item_id); return it.item_id === 'bad' ? Promise.reject(new Error('Could not undo')) : Promise.resolve(); } });
      row.dataset.key = `untick-${key}`;
      document.querySelector('#rows').appendChild(row);
    });
  });
  const box = (key) => page.$eval(`#rows [data-key="untick-${key}"] .irow-check`, (b) => ({ checked: b.getAttribute('aria-checked'), disabled: b.disabled }));
  check('itemRow: with onUntick a ticked box can be tapped', same(await box('ok'), { checked: 'true', disabled: false }));
  db.confirm = false;
  await page.click('#rows [data-key="untick-ok"] .irow-check');
  await page.waitForTimeout(100);
  check('itemRow: a tap asks "Mark … as not done?"; No does nothing', same(db.dialogs.slice(-1), ['Mark "Trash out" as not done?']) && same(await page.evaluate(() => window.__unticked), [])
    && same(await box('ok'), { checked: 'true', disabled: false }), JSON.stringify(db.dialogs));
  db.confirm = true;
  await page.click('#rows [data-key="untick-ok"] .irow-check');
  await page.waitForTimeout(100);
  check('itemRow: Yes calls onUntick and the box unticks', same(await page.evaluate(() => window.__unticked), ['ok']) && (await box('ok')).checked === 'false');
  await page.click('#rows [data-key="untick-bad"] .irow-check');
  await page.waitForTimeout(150);
  check('itemRow: when onUntick fails the box is ticked again and the error shows', same(await box('bad'), { checked: 'true', disabled: false }) && (await text(page, '.toasts')).includes('Could not undo'));
  await page.context().close();

  // dark mode look (screenshots only)
  ({ page } = await open({ label: 'dark', ctx: Object.assign({ colorScheme: 'dark' }, phone) }));
  await page.evaluate(() => {
    const ui = HomeHub.core.v2.ui;
    const box = document.createElement('div');
    box.className = 'irows';
    document.querySelector('#main').prepend(box);
    const mk = (o) => Object.assign({ kind: 'task', item_id: 'x', occurrence: '2026-11-01', day: '2026-11-01', end_day: '2026-11-01', all_day: true, status: 'open', participant_ids: [] }, o);
    [mk({ title: 'Heartworm pill', responsible_id: 'p-jordan' }), mk({ title: 'Trash out', status: 'done' }), mk({ title: 'Furnace filter', status: 'late', day: '2026-10-29', end_day: '2026-10-29' }),
      mk({ kind: 'event', title: 'Piano', all_day: false, local_start: '16:00:00', local_end: '17:00:00', responsible_id: 'p-taylor', participant_ids: ['p-jordan'], contractor_name: 'Pat Lee', contractor_phone: '(201) 555-0100' })]
      .forEach((it) => box.appendChild(ui.itemRow(it, { checkbox: true, showWho: true, onOpen() {} })));
    box.insertAdjacentHTML('beforebegin', ui.sectionHeading('Today', 4));
    const who = document.createElement('div');
    document.querySelector('#main').prepend(who);
    ui.whoPicker(who, { responsibleId: 'p-alex', participantIds: ['p-jordan'] });
    HomeHub.core.toast('Done', { action: { label: 'Undo', onClick() {} } });
  });
  await page.screenshot({ path: SHOTS + 'v2-phone-dark.png' });
  await page.click('.bb-more');
  await page.waitForTimeout(150);
  await page.screenshot({ path: SHOTS + 'v2-phone-dark-more.png' });
  await page.context().close();

  // a tablet (touch, wider than 640px): top tabs, 44px targets, nothing pushed off the side
  ({ page } = await open({ label: 'tablet', ctx: { viewport: { width: 700, height: 1000 }, hasTouch: true } }));
  const tablet = await page.evaluate(() => ({
    bar: getComputedStyle(document.querySelector('.bottombar')).display,
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => a.getBoundingClientRect().height),
    tabsFit: [...document.querySelectorAll('.tabs a')].every((a) => a.getBoundingClientRect().right <= document.querySelector('.tabs').getBoundingClientRect().right + 1),
    end: [...document.querySelectorAll('.topbar-end .btn')].map((b) => { const r = b.getBoundingClientRect(); return [r.height, r.right]; }),
  }));
  check('tablet: every top tab (at least 44px) and Add and Sign out on screen, no bottom bar', tablet.bar === 'none' && tablet.tabs.length === 7 && tablet.tabs.every((h) => h >= 44) && tablet.tabsFit
    && tablet.end.length === 2 && tablet.end.every(([h, right]) => h >= 44 && right <= 700) && await noSideScroll(page), JSON.stringify(tablet));
  await page.screenshot({ path: SHOTS + 'v2-tablet.png' });
  await page.context().close();

  // =====================================================================
  // 12. Sign-in edge cases
  // =====================================================================
  db = v2Db();
  db.whoamiNoPerson = true;
  ({ page } = await open({ label: 'me-by-email', db, email: 'sam@example.com' }));
  check('mePerson: found by email when whoami has no person', (await page.evaluate(() => HomeHub.core.v2.mePerson && HomeHub.core.v2.mePerson.id)) === 'p-sam');
  await page.context().close();
  db = v2Db();
  db.people = db.people.filter((p) => p.id !== 'p-sam');
  ({ page } = await open({ label: 'me-none', db, email: 'sam@example.com' }));
  check('mePerson: null for a member without a person row; the page still shows', (await page.evaluate(() => HomeHub.core.v2.mePerson)) === null && (await text(page, '#probe')).startsWith('today'));
  await page.context().close();
  db = v2Db();
  db.markFail = true;
  ({ page } = await open({ label: 'mark-fail', db, allowConsole: /status of 500/ }));
  check('mark_signed_in failing does not get in the way', db.signedIn.length === 1 && (await text(page, '#probe')).startsWith('today'));
  await page.context().close();
  db = v2Db();
  delete db.people;
  ({ page } = await open({ label: 'people-fail', db, allowConsole: /status of 404/ }));
  check('people failing to load is reported, not ignored', (await text(page, 'body')).includes('Something went wrong') && !(await page.$('.bottombar')), (await text(page, 'body')).slice(0, 120));
  await page.context().close();

  // =====================================================================
  // 13. task_dates: sent with every schedule save in v2
  // =====================================================================
  ({ page, db } = await open({ label: 'task-dates' }));
  const saved = await page.evaluate(async () => {
    const core = HomeHub.core;
    const p = (await core.api.projects()).find((x) => x.id === 'p-kitchen');
    const next = core.clone(p.schedule);
    next.phases[0].tasks[0].status = 'done';
    const row = await core.api.updateProject(p.id, { schedule: next }, p.updated_at);
    const shared = await core.api.updateProject(p.id, { sharing_enabled: true }, row.updated_at);
    const created = await core.api.createProject({ name: 'Garage shelves', status: 'idea', summary: null, schedule: { project: { start: '2026-11-16', holidays: [] }, trades: {}, phases: [] } });
    const model = core.G.buildModel(next);
    return { ok: !!row && !!shared && !!created, tasks: model.items.length };
  });
  const patches = db.projectWrites.filter((w) => w.method === 'PATCH');
  const schedPatch = patches[0];
  const td = schedPatch && schedPatch.body.task_dates;
  check('v2 save: a schedule write also sends task_dates and task_dates_at', saved.ok && schedPatch && Array.isArray(td) && typeof schedPatch.body.task_dates_at === 'string'
    && Math.abs(Date.parse(schedPatch.body.task_dates_at) - Date.now()) < 60000 && /T.*Z$/.test(schedPatch.body.task_dates_at), JSON.stringify(schedPatch && Object.keys(schedPatch.body)));
  check('v2 save: one entry per Gantt task, with exactly the keys the database reads', td && td.length === saved.tasks && td.every((x) => same(Object.keys(x), ['id', 'name', 'trade', 'trade_name', 'start', 'end', 'days', 'status', 'milestone'])), td && JSON.stringify(td[0]));
  check('v2 save: entries carry the computed dates, trade name, status and length', td && same(td[0], { id: 'design', name: 'Design consult & final layout', trade: 'decorator', trade_name: 'Decorator & selections', start: '2026-11-02', end: '2026-11-04', days: 3, status: 'done', milestone: false }), td && JSON.stringify(td[0]));
  check('v2 save: ISO dates, milestones with 0 days, weeks counted as 7 days', td && td.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.start) && /^\d{4}-\d{2}-\d{2}$/.test(x.end) && x.end >= x.start)
    && td.some((x) => x.milestone && x.days === 0 && x.start === x.end) && td.every((x) => x.milestone || x.days > 0), td && JSON.stringify(td.filter((x) => x.milestone)));
  check('v2 save: the saved row has the new task_dates', same(db.projects.find((p) => p.id === 'p-kitchen').task_dates, td));
  check('v2 save: a write without the schedule leaves task_dates alone', patches[1] && same(Object.keys(patches[1].body), ['sharing_enabled']), patches[1] && JSON.stringify(patches[1].body));
  const post = db.projectWrites.find((w) => w.method === 'POST');
  check('v2 create: a new project is saved with its task_dates', post && same(post.body.task_dates, []) && typeof post.body.task_dates_at === 'string', post && JSON.stringify(post.body).slice(0, 160));
  const callerDates = await page.evaluate(async () => {
    const core = HomeHub.core;
    const p = (await core.api.projects()).find((x) => x.id === 'p-pool');
    await core.api.updateProject(p.id, { schedule: p.schedule, task_dates: [{ id: 'given' }], task_dates_at: '2026-11-01T12:00:00.000Z' }, p.updated_at);
    return true;
  });
  const lastPatch = db.projectWrites.filter((w) => w.method === 'PATCH').pop();
  check('v2 save: task_dates a caller computed are kept', callerDates && same(lastPatch.body.task_dates, [{ id: 'given' }]), JSON.stringify(lastPatch.body.task_dates));
  await page.context().close();

  // =====================================================================
  // 14. Backfill: projects whose task_dates the database marked stale (null)
  // =====================================================================
  db = v2Db();
  const sprinkler = db.projects.find((p) => p.id === 'p-sprinkler');
  sprinkler.task_dates = null;
  const oldStamp = sprinkler.updated_at;
  ({ page } = await open({ label: 'backfill', db, path: '/#/projects' }));
  let fills = db.projectWrites.filter((w) => w.method === 'PATCH');
  check('backfill: one quiet save, only for the stale project', fills.length === 1 && /id=eq\.p-sprinkler/.test(fills[0].url), fills.map((w) => w.url).join(' | '));
  check('backfill: guarded by updated_at, so it never overwrites a newer change', fills[0] && fills[0].url.includes(`updated_at=eq.${oldStamp}`), fills[0] && fills[0].url);
  check('backfill: sends only task_dates and task_dates_at', fills[0] && same(Object.keys(fills[0].body), ['task_dates', 'task_dates_at']), fills[0] && JSON.stringify(Object.keys(fills[0].body)));
  check('backfill: the dates come from the schedule', fills[0] && same(fills[0].body.task_dates, [{ id: 'blowout', name: 'Blow out sprinkler lines', trade: 'irrigation', trade_name: 'Irrigation', start: '2026-11-09', end: '2026-11-09', days: 1, status: null, milestone: false }]), fills[0] && JSON.stringify(fills[0].body.task_dates));
  const listed = await page.evaluate(() => window.__projects.find((p) => p.id === 'p-sprinkler'));
  check('backfill: the page gets the saved row (new dates and updated_at)', Array.isArray(listed.task_dates) && listed.task_dates.length === 1 && listed.updated_at === sprinkler.updated_at && listed.updated_at !== oldStamp, JSON.stringify([listed.updated_at, sprinkler.updated_at]));
  check('backfill: the page shows normally', (await text(page, '#probe')) === 'projects 3');
  const editAfter = await page.evaluate(async () => {
    const p = window.__projects.find((x) => x.id === 'p-sprinkler');
    try { await HomeHub.core.api.updateProject(p.id, { name: 'Sprinkler shut-off' }, p.updated_at); return 'saved'; } catch (e) { return e.message; }
  });
  check('backfill: editing right after does not look like someone else\'s change', editAfter === 'saved', editAfter);
  const single = await page.evaluate(async () => { const p = await HomeHub.core.api.project('p-sprinkler'); return Array.isArray(p.task_dates); });
  check('backfill: nothing more to fill once dates are fresh', single && db.projectWrites.filter((w) => w.method === 'PATCH').length === 2);
  await page.context().close();

  // project(id) fills in too; someone else's change in between wins; failures are quiet
  db = v2Db();
  db.projects.forEach((p) => { p.task_dates = null; });
  db.projects.find((p) => p.id === 'p-pool').schedule.phases = [{ name: 'Loop', tasks: [{ id: 'a', name: 'A', days: 1, after: ['b'] }, { id: 'b', name: 'B', days: 1, after: ['a'] }] }];
  db.beforePatch = () => { db.projects.find((p) => p.id === 'p-sprinkler').updated_at = '2026-10-24T18:00:00.000000+00:00'; };
  ({ page } = await open({ label: 'backfill-quiet', db, path: '/#/projects', allowConsole: /status of 500/ }));
  fills = db.projectWrites.filter((w) => w.method === 'PATCH');
  check('backfill: a schedule the engine can\'t read is skipped quietly', !fills.some((w) => /p-pool/.test(w.url)) && db.projects.find((p) => p.id === 'p-pool').task_dates === null, fills.map((w) => w.url).join(' | '));
  check('backfill: a project changed in between keeps its newer version (no dates written)', db.projects.find((p) => p.id === 'p-sprinkler').task_dates === null);
  check('backfill: those cases show no error', (await text(page, '#probe')) === 'projects 3' && !(await page.$('.banner-error')) && !(await page.$('.toast')));
  db.beforePatch = null;
  db.failPatch = true;
  const viaOne = await page.evaluate(async () => { const p = await HomeHub.core.api.project('p-sprinkler'); return p && p.task_dates; });
  check('backfill: a failed save is ignored and the row comes back as it was', viaOne === null && db.projectWrites.some((w) => w.method === 'PATCH' && /p-sprinkler/.test(w.url)));
  await page.context().close();

  // =====================================================================
  // 15. v1 mode stays v1: no task_dates, no backfill, no v2 calls, v1 shell
  // =====================================================================
  db = makeDb();
  db.projects.find((p) => p.id === 'p-sprinkler').task_dates = null;
  ({ page, log } = await open({ label: 'v1', v1: true, db }));
  check('v1: schema version 1 with the v1 tabs', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 1
    && same(await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent)), ['Home', 'Projects', 'Contractors', 'Family']));
  check('v1: no bottom bar, no Add or Sign out in the top bar', !(await page.$('.bottombar')) && !(await page.$('.topbar-end')) && !(await page.evaluate(() => document.body.classList.contains('has-bottombar'))));
  check('v1: no people, household, clock or mark_signed_in requests', !log.some((l) => /people|household|rpc\/clock|mark_signed_in/.test(l)), log.filter((l) => /people|household|clock|mark_signed/.test(l)).join(' | '));
  check('v1: no backfill on load', !db.projectWrites.some((w) => w.method === 'PATCH'));
  await page.evaluate(async () => {
    const core = HomeHub.core;
    const p = (await core.api.projects()).find((x) => x.id === 'p-kitchen');
    const next = core.clone(p.schedule);
    next.phases[0].tasks[0].status = 'done';
    await core.api.updateProject(p.id, { schedule: next }, p.updated_at);
    await core.api.createProject({ name: 'Garage shelves', status: 'idea', summary: null, schedule: { project: { start: '2026-11-16', holidays: [] }, trades: {}, phases: [] } });
  });
  const v1Writes = db.projectWrites;
  check('v1: a schedule save sends no task_dates', v1Writes.some((w) => w.method === 'PATCH' && w.body.schedule) && v1Writes.every((w) => !('task_dates' in w.body) && !('task_dates_at' in w.body)), JSON.stringify(v1Writes.map((w) => Object.keys(w.body))));
  await page.evaluate(() => HomeHub.core.toast('Saved'));
  check('v1: toast(msg) works', (await text(page, '.toast')) === 'Saved');
  await page.context().close();
  ({ page } = await open({ label: 'v1-phone', v1: true, ctx: phone }));
  check('v1 phone: the top tabs stay, no bottom bar', await page.isVisible('.topbar .tabs') && !(await page.$('.bottombar')) && await noSideScroll(page));
  await page.context().close();

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
  await server.close();
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
})().catch((err) => {
  // A step that throws (e.g. a selector that never appears) stops the run: report what ran, then fail.
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
