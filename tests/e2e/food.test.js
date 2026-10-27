// Browser tests for the Food page (assets/modules/food.js; docs/v1.2-kitchen.md §5, §6.1, §8, §13):
// the heading; this week's dinners (one card a day, today first, folded to "Plan dinners ›" when the
// family doesn't plan) and the dinner dialog (suggestions from past dinners, the quick kinds, who
// cooks or who's on dinner, the note, the recipe link shown as its host, the lock, Save as an upsert on
// (day, slot), Clear this day, and Add a prep reminder… only on a saved dinner); the shopping list
// (the add box: Enter keeps focus, "2 milk", the toasts, the lock, suggestions; aisles in store order
// and the Aisle? chips; tap = bought, struck through where it is and moved 3 seconds after the last
// tap; Undo; Just bought; Buy again, folded and remembered; Edit, Forget, a rename clash and Merge); a
// hostile name and title as text; the 10-second poll on page.clock (a change made elsewhere, held
// while tapping, no redraw when nothing changed, none while hidden); the outbox (no connection, the
// banner, a reload keeps the queue and it goes once; "Changed on another phone"; a 503 retried, a
// 42501 dropped; a line added again offline and ticked; an Undo of a tick that found Sam's purchase;
// an add answered after leaving Food isn't sent again); the saved list when the reads fail, dropped for someone else; the parents' two
// switches (read-only for members); Send Taylor the list; the Add sheet's Shopping; the dinner read
// failing on its own; phones and desktops, light and dark.
//
// mock.js has the tables and functions (withFood, foodRpc) with the migration's rules and shapes. The
// other v2 pages are small stubs, so this file tests Food alone; the Tasks stub records what the prep
// reminder asks its task form for. The household's clock is Tue Oct 27 2026, 9:42am in New York; the
// device's clock is elsewhere (Jan 15, in Los Angeles), so anything using the device's date shows the
// wrong day.
// Run alone with: node tests/e2e/food.test.js
const { chromium } = require('playwright');
const { createHash } = require('crypto');
const { makeDb, install, signIn, SUPA, withFood, mealRow, shopItem, foodRpc, calendarRow } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Fixtures (fictional people, 555-01xx numbers, example.com)
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-10-27';   // a Tuesday; the household's clock says 9:42am in New York
const DEVICE = new Date('2026-01-15T05:00:00Z');
const ID = {
  alex: 'f00d0000-0000-4000-8000-000000000001', sam: 'f00d0000-0000-4000-8000-000000000002',
  jordan: 'f00d0000-0000-4000-8000-000000000003', taylor: 'f00d0000-0000-4000-8000-000000000004',
  morgan: 'f00d0000-0000-4000-8000-000000000005',
};
const token = (id) => createHash('md5').update(id).digest('hex');
const person = (id, name, role, color, sort, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color, language: 'en',
  day_token: token(id), digest_enabled: false, digest_time: null, digest_day: 'today', digest_scope: 'mine',
  sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// An instant on a household day ('HH:MM' New York, daylight time until Nov 1), with microseconds as Postgres writes them.
const at = (day, hm, us = '123456') => {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8), h + 4, m));
  return `${d.toISOString().slice(0, 19)}.${us}+00:00`;
};
const RECIPE = 'https://cooking.example.com/tacos';

function foodDb(opts) {
  const db = makeDb();
  db.people = [
    person(ID.alex, 'Alex Example', 'parent', '#2563eb', 1, { email: 'alex@example.com', email_verified_at: T }),
    person(ID.morgan, 'Morgan Example', 'parent', '#9333ea', 2),
    person(ID.sam, 'Sam Example', 'adult', '#db2777', 3, { email: 'sam@example.com' }),
    person(ID.jordan, 'Jordan Example', 'kid', '#16a34a', 4),
    person(ID.taylor, 'Taylor Example', 'helper', '#ca8a04', 5, { phone: '(201) 555-0104', language: 'es' }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: null, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '09:42:00', tz: 'America/New_York' };
  return withFood(db, opts);
}
// Past dinners (the dialog's suggestions): Tacos three times (the latest with RECIPE), Lasagna twice, Soup once.
function pastDinners(db) {
  [[-7, 'Tacos', RECIPE], [-14, 'Tacos', null], [-21, 'tacos', 'https://old.example.com/tacos'], [-3, 'Lasagna', null], [-10, 'Lasagna', null], [-5, 'Soup', null]]
    .forEach(([n, title, link]) => db.meals.push(mealRow({ day: addDays(TODAY, n), title, link })));
  return db;
}
// A list in every state: to buy across the aisles, bought today, and bought in the last 60 days (Buy again).
function stockList(db) {
  const to = (name, aisle, by, extra) => db.shopping_items.push(shopItem(Object.assign({ name, aisle, added_at: at(addDays(TODAY, -1), '18:00'), added_by: by }, extra)));
  to('Milk', 'dairy', ID.alex);
  to('Bananas', 'produce', ID.sam);
  to('Tortillas', 'bakery', ID.alex, { note: '2 packs' });
  to('Rice', 'pantry', null);
  to('Frijoles', 'pantry', ID.taylor);   // typed on Taylor's My day: Alex reads it as "Frijoles · beans"
  to('Coffee', 'drinks', ID.sam);
  to('Detergent', 'household', ID.alex);
  to('Shampoo', 'personal', ID.taylor);
  to('Chicken', 'meat', ID.alex, { note: '2 lb' });
  to('Ice cream', 'frozen', ID.sam);
  to('Batteries', 'other', ID.alex);
  to('Light bulbs', 'other', ID.sam);
  to('Pregnancy test', 'other', ID.alex, { private: true });
  const bought = (name, aisle, day, hm, by) => db.shopping_items.push(shopItem({ name, aisle, added_at: at(addDays(day, -2), '10:00'), bought_at: at(day, hm), bought_by: by }));
  bought('Eggs', 'dairy', TODAY, '08:15', ID.taylor);
  bought('Apples', 'produce', TODAY, '09:05', ID.alex);
  bought('Butter', 'dairy', addDays(TODAY, -3), '17:00', ID.sam);
  bought('Onions', 'produce', addDays(TODAY, -10), '17:00', ID.alex);
  bought('Paper towels', 'household', addDays(TODAY, -20), '12:00', ID.taylor);
  bought('Cereal', 'pantry', addDays(TODAY, -70), '12:00', ID.alex);   // older than 60 days: not in Buy again
  return db;
}
const item = (db, name) => db.shopping_items.find((r) => r.name === name);

// ---- Stub pages: the same register() contract as the real ones
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true }, provides: 'openEventForm' },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true }, provides: 'openTaskForm' },
  directory: { nav: { label: 'Directory', order: 50 } },
  people: { nav: { label: 'Family', order: 60 } },
  settings: { nav: { label: 'Settings', order: 70 } },
};
const stubModule = (name, s) => `;(function () {
  var provides = {};
  ${s.provides ? `provides[${JSON.stringify(s.provides)}] = function (defaults) {
    (window.__added = window.__added || []).push({ page: ${JSON.stringify(name)}, defaults: defaults });
  };` : ''}
  HomeHub.register({
    name: ${JSON.stringify(name)}, schema: { min: 2, max: 99 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return parts[0] === ${JSON.stringify(name)}${s.root ? ' || !parts.length' : ''} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1>'; },
    provides: provides,
  });
})();`;

const RPC = Object.assign({
  hub_schema_version: () => 4,
  clock: (db) => Object.assign({}, db.clock),
  mark_signed_in: () => null,
}, foodRpc);

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

  // A signed-in page on #/food (or opts.path). opts.context: an existing browser context (signed in
  // already). Expected console errors: requests the test makes fail on purpose (opts.allowConsole).
  async function open(opts = {}) {
    const db = opts.db || foodDb();
    const context = opts.context || await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles' }, opts.ctx));
    if (!opts.context) await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    await page.clock.install({ time: DEVICE });
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text())) return;   // a request the test cut off
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => {
      (db.dialogs = db.dialogs || []).push(d.message());
      return db.confirm === false ? d.dismiss() : d.accept();
    });
    const log = [];
    await install(page, db, log, { rpc: RPC });
    if (opts.before) await opts.before(page);
    // whoami() in v2 adds the caller's person.
    await page.route(`${SUPA}/rest/v1/rpc/whoami`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const m = db.members.find((x) => x.email === emailOf(req));
      const p = m && db.people.find((x) => x.email === m.email);
      const body = m ? Object.assign({}, m, { person: p ? { id: p.id, name: p.name, role: p.role, language: p.language, color: p.color } : null }) : null;
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    });
    // Writes to the food tables and the household, then the mock answers.
    db.writes = db.writes || [];
    await page.route((url) => url.host === 'test.supabase.co' && /^\/rest\/v1\/(meals|shopping_items|household)$/.test(url.pathname), (route) => {
      const req = route.request();
      if (['PATCH', 'POST', 'DELETE'].includes(req.method())) {
        const url = new URL(req.url());
        db.writes.push({ table: url.pathname.split('/').pop(), method: req.method(), query: decodeURIComponent(url.search), body: JSON.parse(req.postData() || 'null'),
          prefer: req.headers()['prefer'] || '' });
      }
      return route.fallback();
    });
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: stubModule(name, s) }));
    }
    await page.goto(BASE + (opts.path || '/#/food'));
    await until(page, () => !!document.querySelector('.food-list .food-part, .food-list .food-fail'), 6000);
    await sleep(opts.wait || 150);
    return { page, db, log, context };
  }

  // Wait (in real time, from Node, so a paused page clock doesn't matter) until fn() is true in the page.
  async function until(page, fn, ms = 4000, arg) {
    const end = Date.now() + ms;
    for (;;) {
      if (await page.evaluate(fn, arg).catch(() => false)) return true;
      if (Date.now() > end) return false;
      await sleep(40);
    }
  }
  // Pause the page's clock where it is now, so timers fire only through tick().
  const pause = async (page) => { const now = await page.evaluate(() => Date.now()); await page.clock.pauseAt(new Date(now + 50)); };
  const tick = async (page, ms) => { await page.clock.runFor(ms); await sleep(120); };
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.innerText.trim()));
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const toasts = (page) => page.$$eval('.toasts .toast', (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const lastToast = async (page) => (await toasts(page)).slice(-1)[0] || '';
  const calls = (db, name) => (db.rpcCalls || []).filter((c) => c.name === name);
  const writes = (db, table, method) => (db.writes || []).filter((w) => w.table === table && (!method || w.method === method));
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const cards = (page) => page.$$eval('.food-day', (bs) => bs.map((b) => [...b.querySelectorAll('.food-day-label, .food-day-title, .food-day-cook')].map((e) => e.textContent.trim()).join(' · ')));
  // The To buy rows: [aisle, name (and other word), note, locked?, checked?] in screen order.
  const toBuy = (page) => page.$$eval('[data-part="buy"] .food-row', (rows) => rows.map((r) => [
    r.closest('.food-group').querySelector('.food-aisle').textContent,
    (r.querySelector('.food-name').textContent + ((r.querySelector('.food-other') || {}).textContent || '')).replace(/\s+/g, ' ').trim(),
    (r.querySelector('.food-note') || {}).textContent || null, !!r.querySelector('.food-lockmark'),
    (r.querySelector('.food-tick') || { getAttribute: () => null }).getAttribute('aria-checked') === 'true']));
  const names = (page, part) => page.$$eval(`[data-part="${part}"] .food-row .food-name`, (es) => es.map((e) => e.textContent));
  const row = (page, part, name) => page.locator(`[data-part="${part}"] .food-row`, { has: page.locator('.food-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
  const addItem = async (page, value) => { await page.fill('.food-add input[name="what"]', value); await page.press('.food-add input[name="what"]', 'Enter'); };
  const dlg = (page, sel) => text(page, `#formDialog ${sel}`);

  // =====================================================================
  // 1. The heading; a family that doesn't plan dinners: one line, the list first
  // =====================================================================
  let { page, db, log } = await open({ label: 'empty' });
  check('heading: "Food", with "Dinners and the shopping list"', (await text(page, '#main h1')) === 'Food' && (await text(page, '.food-head .meta')) === 'Dinners and the shopping list');
  check('the Food tab is current', (await page.getAttribute('.tabs a[data-tab="food"]', 'aria-current')) === 'page');
  check('no dinner in the last 14 days or the next 7: the row folds to "Plan dinners ›"', (await tc(page, '[data-ref="week"]')) === 'Plan dinners ›' && !(await page.$('.food-day')));
  check('an empty list says "Nothing to buy."; no Just bought, no Buy again', (await tc(page, '[data-part="buy"] .food-empty')) === 'Nothing to buy.'
    && !(await page.$('[data-part="bought"]')) && !(await page.$('[data-part="again"]')));
  const reads = log.filter((l) => /^GET \/rest\/v1\/(meals|shopping_items|calendars)\?/.test(l));
  check('reads: dinners 14 days before to 6 after, and 180 days of cooked ones; the lines; the Family calendar; shopping_list()',
    reads.some((l) => /^GET \/rest\/v1\/meals\?/.test(l) && l.includes('slot=eq.dinner') && l.includes(`day=gte.${addDays(TODAY, -14)}`) && l.includes(`day=lte.${addDays(TODAY, 6)}`))
    && reads.some((l) => /^GET \/rest\/v1\/meals\?/.test(l) && l.includes('kind=eq.cook') && l.includes(`day=gte.${addDays(TODAY, -180)}`) && l.includes(`day=lte.${TODAY}`))
    && reads.some((l) => l.startsWith('GET /rest/v1/shopping_items?select=id%2Cname%2Cnote%2Caisle%2Cprivate%2Cadded_at%2Cbought_at'))
    && reads.some((l) => /^GET \/rest\/v1\/calendars\?/.test(l) && l.includes('kind=eq.family') && l.includes('writes=eq.true'))
    && calls(db, 'shopping_list').length === 1 && same(calls(db, 'shopping_list')[0].body, {}), JSON.stringify(reads));
  await page.click('.food-plan');
  await sleep(100);
  check('"Plan dinners ›" opens the week: 7 cards, today first, an empty day "—"', same(await cards(page), ['Today · —', 'Wed · —', 'Thu · —', 'Fri · —', 'Sat · —', 'Sun · —', 'Mon · —']), JSON.stringify(await cards(page)));
  await page.context().close();

  // =====================================================================
  // 2. The dinner dialog
  // =====================================================================
  ({ page, db } = await open({ label: 'dinner', db: pastDinners(foodDb()) }));
  check('dinners planned in the last 14 days: the week shows, no fold', (await page.$$('.food-day')).length === 7 && !(await page.$('.food-plan')));
  await page.click('.food-day[data-day="2026-10-27"]');
  await sleep(150);
  check('a card opens "Dinner · Today": what\'s for dinner, the suggestions (8 most frequent of 180 days), the quick kinds, who cooks',
    (await dlg(page, 'h3')) === 'Dinner · Today' && same(await texts(page, '#formDialog .food-sugg .food-chip'), ['Tacos', 'Lasagna', 'Soup'])
    && same(await texts(page, '#formDialog .food-kinds .food-chip'), ['Leftovers', 'Eating out', 'Takeout', 'Fend for yourself'])
    && (await dlg(page, '[data-ref="cooklabel"]')) === 'Who cooks?' && same(await texts(page, '#formDialog [data-ref="cooks"] .pchip-name'), ['Alex', 'Morgan', 'Sam', 'Jordan', 'Taylor']),
    JSON.stringify([await dlg(page, 'h3'), await texts(page, '#formDialog .food-sugg .food-chip')]));
  check('an unsaved dinner has no prep reminder and no Clear', !(await page.$('#formDialog [data-act="prep"]')) && !(await page.$('#formDialog [data-act="clear"]')));
  await page.click('#formDialog .food-sugg .food-chip:has-text("Tacos")');
  check('picking a suggestion fills the title and its latest recipe link, and opens More', (await page.inputValue('#formDialog input[name="title"]')) === 'Tacos'
    && (await page.inputValue('#formDialog input[name="link"]')) === RECIPE && (await page.$eval('#formDialog .food-more', (d) => d.open)));
  await page.click('#formDialog [data-ref="cooks"] .pchip:has-text("Sam")');
  await page.fill('#formDialog textarea[name="note"]', 'Chicken is in the freezer');
  await page.click('#formDialog button[type="submit"]');
  await sleep(300);
  let w = writes(db, 'meals', 'POST').slice(-1)[0] || {};
  check('Save upserts on (day, slot): day, slot dinner, kind, title, cook, note, link, private', same(w.body, { day: TODAY, slot: 'dinner', kind: 'cook', title: 'Tacos', cook_id: ID.sam,
    note: 'Chicken is in the freezer', link: RECIPE, private: false }) && /on_conflict=day,slot/.test(w.query) && /resolution=merge-duplicates/.test(w.prefer), JSON.stringify(w));
  check('the card: "Today · Tacos · Sam"; the dialog closed with a toast', (await cards(page))[0] === 'Today · Tacos · Sam' && !(await page.evaluate(() => document.getElementById('formDialog').open))
    && (await lastToast(page)) === 'Dinner tonight: Tacos', JSON.stringify([(await cards(page))[0], await lastToast(page)]));
  // Leftovers on Wednesday: "Who's on dinner?", no link.
  await page.click('.food-day[data-day="2026-10-28"]');
  await sleep(100);
  await page.fill('#formDialog input[name="title"]', 'Something');
  await page.click('#formDialog [data-kind="leftovers"]');
  check('Leftovers: the title clears, the chips read "Who\'s on dinner?", no recipe link', (await page.inputValue('#formDialog input[name="title"]')) === ''
    && (await dlg(page, '[data-ref="cooklabel"]')) === 'Who\'s on dinner?' && (await page.$eval('#formDialog [data-ref="linkfield"]', (e) => e.hidden))
    && (await page.getAttribute('#formDialog [data-kind="leftovers"]', 'aria-pressed')) === 'true');
  await page.click('#formDialog [data-ref="cooks"] .pchip:has-text("Taylor")');
  await page.click('#formDialog button[type="submit"]');
  await sleep(300);
  w = writes(db, 'meals', 'POST').slice(-1)[0] || {};
  check('Leftovers saved with who\'s on dinner, no title, no link', same(w.body, { day: '2026-10-28', slot: 'dinner', kind: 'leftovers', title: null, cook_id: ID.taylor, note: null, link: null, private: false })
    && (await cards(page))[1] === 'Wed · Leftovers · Taylor', JSON.stringify([w.body, (await cards(page))[1]]));
  // Eating out on Thursday: nobody on it.
  await page.click('.food-day[data-day="2026-10-29"]');
  await sleep(100);
  await page.click('#formDialog [data-ref="cooks"] .pchip:has-text("Alex")');
  await page.click('#formDialog [data-kind="out"]');
  check('Eating out hides who cooks', await page.$eval('#formDialog [data-ref="cookset"]', (e) => e.hidden));
  await page.click('#formDialog button[type="submit"]');
  await sleep(300);
  w = writes(db, 'meals', 'POST').slice(-1)[0] || {};
  check('Eating out saved with nobody on it', w.body && w.body.kind === 'out' && w.body.cook_id === null && (await cards(page))[2] === 'Thu · Eating out', JSON.stringify([w.body, (await cards(page))[2]]));
  // The recipe link: https only, saved as new URL(typed).href, shown as its host.
  await page.click('.food-day[data-day="2026-10-30"]');
  await sleep(100);
  await page.fill('#formDialog input[name="title"]', '<img src=x onerror="window.__pwned=1">');
  await page.click('#formDialog .food-more summary');
  await page.fill('#formDialog input[name="link"]', 'http://cooking.example.com/soup');
  await page.click('#formDialog button[type="submit"]');
  await sleep(200);
  check('a recipe link that isn\'t https is refused, and says so', /https:\/\//.test(await dlg(page, '.form-error')) && writes(db, 'meals', 'POST').length === 3, await dlg(page, '.form-error'));
  await page.fill('#formDialog input[name="link"]', 'cooking.example.com/soup recipe');
  await page.check('#formDialog input[name="private"]');
  await page.click('#formDialog button[type="submit"]');
  await sleep(300);
  w = writes(db, 'meals', 'POST').slice(-1)[0] || {};
  check('a link typed without https:// is saved as new URL(typed).href (spaces percent-encoded); the lock is saved',
    w.body && w.body.link === 'https://cooking.example.com/soup%20recipe' && w.body.private === true, JSON.stringify(w.body));
  check('a hostile title shows as text, with the lock on its card', (await cards(page))[3] === 'Fri · <img src=x onerror="window.__pwned=1">'
    && !!(await page.$('.food-day[data-day="2026-10-30"] .food-lockmark')) && !(await page.evaluate(() => window.__pwned)), (await cards(page))[3]);
  await page.click('.food-day[data-day="2026-10-27"]');
  await sleep(100);
  check('a saved link shows as its host name, opening in a new tab without a referrer', (await dlg(page, '[data-ref="linkhost"]')) === 'Opens cooking.example.com'
    && (await page.getAttribute('#formDialog [data-ref="linkhost"] a', 'href')) === RECIPE && (await page.getAttribute('#formDialog [data-ref="linkhost"] a', 'rel')) === 'noopener noreferrer'
    && (await page.getAttribute('#formDialog [data-ref="linkhost"] a', 'target')) === '_blank');
  check('a saved dinner: More open (it has a note and link), Clear this day and Add a prep reminder…', (await page.$eval('#formDialog .food-more', (d) => d.open))
    && !!(await page.$('#formDialog [data-act="clear"]')) && (await dlg(page, '[data-act="prep"]')) === 'Add a prep reminder…'
    && /stays put if the dinner moves/.test(await dlg(page, '.food-prep small')));
  await page.click('#formDialog [data-act="prep"]');
  await sleep(150);
  let prep = await page.evaluate(() => (window.__added || []).map((a) => Object.assign({ page: a.page }, a.defaults, { onSaved: typeof a.defaults.onSaved })));
  check('prep reminder for tonight\'s dinner: the task form with "Prep: Tacos", due today (not yesterday), the cook in charge, family, not private (the dinner isn\'t locked)',
    same(prep, [{ page: 'tasks', title: 'Prep: Tacos', date: TODAY, responsible_id: ID.sam, category: 'family', private: false, onSaved: 'function' }]), JSON.stringify(prep));
  await page.evaluate(() => { location.hash = '#/food/2026-10-27'; });
  await sleep(300);
  await page.evaluate(() => window.__added[0].defaults.onSaved({ id: 'task-1' }));
  await sleep(400);
  check('saving the task comes back to Food with "Prep reminder added"', (await page.evaluate(() => location.hash)) === '#/food' && (await text(page, '#main h1')) === 'Food'
    && (await toasts(page)).includes('Prep reminder added'), JSON.stringify([await page.evaluate(() => location.hash), await toasts(page)]));
  await page.click('.food-day[data-day="2026-10-30"]');
  await sleep(100);
  await page.click('#formDialog [data-act="prep"]');
  await sleep(100);
  prep = await page.evaluate(() => window.__added.slice(-1)[0].defaults);
  // A task that isn't private goes to the wall as "☐ <title>", to the person in charge's My day and into
  // email subjects, so a locked dinner's prep reminder is a private task: the grown-ups who sign in
  // still see "Prep: <title>" in the form and on Tasks; everywhere else it reads "Private item".
  check('prep reminder for Friday\'s locked dinner: due Thursday, nobody in charge, and a private task (the title stays the grown-ups\')', prep.date === '2026-10-29'
    && prep.title === 'Prep: <img src=x onerror="window.__pwned=1">' && prep.responsible_id === null && prep.private === true, JSON.stringify(prep));
  await page.evaluate(() => document.getElementById('formDialog').close());
  // The lock ticked in the dialog but not saved yet: the prep reminder is private too (the saved
  // dinner isn't locked yet, but that is what was asked for). Unticked, it isn't.
  await page.click('.food-day[data-day="2026-10-28"]');
  await sleep(100);
  await page.click('#formDialog [data-act="prep"]');
  await sleep(100);
  prep = await page.evaluate(() => window.__added.slice(-1)[0].defaults);
  check('prep reminder for Wednesday\'s Leftovers (not locked): "Prep: Leftovers", Taylor in charge, not private', prep.title === 'Prep: Leftovers'
    && prep.responsible_id === ID.taylor && prep.private === false, JSON.stringify(prep));
  await page.evaluate(() => document.getElementById('formDialog').close());
  await page.click('.food-day[data-day="2026-10-28"]');
  await sleep(100);
  check('Wednesday\'s dialog: More closed, the lock off', !(await page.$eval('#formDialog .food-more', (d) => d.open)) && !(await page.isChecked('#formDialog input[name="private"]')));
  await page.click('#formDialog .food-more summary');
  await page.check('#formDialog input[name="private"]');
  await page.click('#formDialog [data-act="prep"]');
  await sleep(100);
  prep = await page.evaluate(() => window.__added.slice(-1)[0].defaults);
  check('prep reminder with the lock ticked but not saved: a private task', prep.title === 'Prep: Leftovers' && prep.private === true, JSON.stringify(prep));
  await page.evaluate(() => document.getElementById('formDialog').close());
  check('... and the dinner itself is unchanged until Save (no write)', !db.meals.find((m) => m.day === '2026-10-28').private, JSON.stringify(db.meals.find((m) => m.day === '2026-10-28')));
  // Clear this day.
  await page.click('.food-day[data-day="2026-10-29"]');
  await sleep(100);
  await page.click('#formDialog [data-act="clear"]');
  await sleep(300);
  const del = writes(db, 'meals', 'DELETE').slice(-1)[0] || {};
  check('Clear this day deletes that day\'s dinner row', /day=eq\.2026-10-29/.test(del.query) && /slot=eq\.dinner/.test(del.query) && !db.meals.some((m) => m.day === '2026-10-29')
    && (await cards(page))[2] === 'Thu · —', JSON.stringify([del, (await cards(page))[2]]));
  // A cooked dinner needs a title.
  await page.click('.food-day[data-day="2026-10-31"]');
  await sleep(100);
  await page.click('#formDialog button[type="submit"]');
  await sleep(150);
  check('Save without a title or a quick kind says what\'s missing', /Type what's for dinner/.test(await dlg(page, '.form-error')));
  await page.evaluate(() => document.getElementById('formDialog').close());
  await page.context().close();

  // #/food/<date> opens that day's dialog; closing it leaves #/food.
  ({ page, db } = await open({ label: 'dinner-link', db: pastDinners(foodDb()), path: '/#/food/2026-11-03' }));
  await until(page, () => document.getElementById('formDialog').open);
  check('#/food/<date> opens that day\'s dinner', (await dlg(page, 'h3')) === 'Dinner · Tue Nov 3');
  await page.click('#formDialog [data-close].d-close');
  await sleep(100);
  check('closing it leaves #/food (a reload doesn\'t open it again)', (await page.evaluate(() => location.hash)) === '#/food');
  await page.context().close();

  // =====================================================================
  // 3. The shopping list: adding
  // =====================================================================
  db = stockList(foodDb());
  ({ page } = await open({ label: 'list', db }));
  check('To buy (N): aisles in store order (cold things last), A–Z inside each; name, note, lock, the adder\'s dot', same(await toBuy(page), [
    ['Produce', 'Bananas', null, false, false], ['Bakery', 'Tortillas', '2 packs', false, false], ['Pantry', 'Frijoles · beans', null, false, false], ['Pantry', 'Rice', null, false, false],
    ['Drinks', 'Coffee', null, false, false],
    ['Household', 'Detergent', null, false, false], ['Personal care', 'Shampoo', null, false, false], ['Meat & fish', 'Chicken', '2 lb', false, false],
    ['Dairy & eggs', 'Milk', null, false, false], ['Frozen', 'Ice cream', null, false, false],
    ['Other', 'Batteries', null, false, false], ['Other', 'Light bulbs', null, false, false], ['Other', 'Pregnancy test', null, true, false]])
    && same(await page.$$eval('[data-part="buy"] .sec-head span', (es) => es.map((e) => e.textContent)), ['To buy', '13'])
    && (await row(page, 'buy', 'Milk').locator('.pdot').getAttribute('title')) === 'Alex Example' && !(await row(page, 'buy', 'Rice').locator('.pdot').count()),
    JSON.stringify([await toBuy(page), await tc(page, '[data-part="buy"] .sec-head'), await row(page, 'buy', 'Milk').locator('.pdot').getAttribute('title')]));
  check('Just bought: today\'s, newest first, greyed and ticked, with who bought it', same(await names(page, 'bought'), ['Apples', 'Eggs'])
    && (await row(page, 'bought', 'Eggs').locator('.pdot').getAttribute('title')) === 'Taylor Example'
    && (await row(page, 'bought', 'Eggs').locator('.food-tick').getAttribute('aria-checked')) === 'true', JSON.stringify(await names(page, 'bought')));
  check('Buy again (N) ›: folded by default; bought in the 60 days before today and not on the list', (await tc(page, '.food-again-toggle')) === 'Buy again (3) ›'
    && (await page.getAttribute('.food-again-toggle', 'aria-expanded')) === 'false' && (await page.$eval('#foodAgain', (e) => e.hidden)));
  check('the Aisle? chip only on rows under Other', same(await page.$$eval('.food-aisle-q', (bs) => bs.map((b) => b.closest('.food-row').querySelector('.food-name').textContent)),
    ['Batteries', 'Light bulbs', 'Pregnancy test']));
  const input = '.food-add input[name="what"]';
  check('the add box: 16px text, maxlength 100, "Add to the list…"', (await page.$eval(input, (i) => [getComputedStyle(i).fontSize, i.maxLength, i.placeholder]).then((x) => same(x, ['16px', 100, 'Add to the list…']))));
  await addItem(page, '2 lb ground beef');
  await sleep(250);
  const beef = item(db, 'ground beef');
  check('Enter adds: "2 lb ground beef" is ground beef, note "2 lb"; the box clears and keeps focus', !!beef && beef.note === '2 lb' && beef.added_by === ID.alex
    && (await page.inputValue(input)) === '' && (await page.evaluate(() => document.activeElement && document.activeElement.name === 'what')), JSON.stringify(beef));
  await addItem(page, 'Cereal bars');
  await sleep(250);
  check('several items one after another, each a row (an added one: no toast)', !!item(db, 'Cereal bars') && (await names(page, 'buy')).includes('ground beef')
    && (await names(page, 'buy')).includes('Cereal bars') && !(await toasts(page)).some((t) => /Already|Back/.test(t)), JSON.stringify(await names(page, 'buy')));
  await addItem(page, '2 milk');
  await sleep(250);
  check('"2 milk" while Milk is to buy: "Already on the list", one line, the amount in its note', (await lastToast(page)) === 'Already on the list'
    && db.shopping_items.filter((r) => r.name_key === 'milk').length === 1 && item(db, 'Milk').note === '2'
    && (await row(page, 'buy', 'Milk').locator('.food-note').textContent()) === '2', JSON.stringify([await lastToast(page), item(db, 'Milk').note]));
  await addItem(page, ' MILK ');
  await sleep(250);
  check('" MILK " → "Already on the list", nothing changes', (await lastToast(page)) === 'Already on the list' && item(db, 'Milk').note === '2', await lastToast(page));
  await addItem(page, 'Milk: 2 gallons');
  await sleep(250);
  check('"Milk: 2 gallons": the note joins the line after " · "', item(db, 'Milk').note === '2 · 2 gallons' && (await row(page, 'buy', 'Milk').locator('.food-note').textContent()) === '2 · 2 gallons');
  await addItem(page, 'Tortillas: 2');
  await sleep(250);
  check('"Tortillas: 2" while its note is "2 packs": "2" is in it but isn\'t one of its " · " parts, so it joins ("2 packs · 2"), as the database does',
    item(db, 'Tortillas').note === '2 packs · 2' && (await row(page, 'buy', 'Tortillas').locator('.food-note').textContent()) === '2 packs · 2', JSON.stringify(item(db, 'Tortillas')));
  const tortillaAdds = calls(db, 'add_to_list').length;
  await addItem(page, 'Tortillas: 2 packs · 2');
  await sleep(250);
  check('… a note with " · " in it that is already its note (typed again, or sent again) changes nothing: "Already on the list"',
    item(db, 'Tortillas').note === '2 packs · 2' && calls(db, 'add_to_list').length === tortillaAdds + 1 && (await lastToast(page)) === 'Already on the list',
    JSON.stringify([item(db, 'Tortillas').note, await lastToast(page)]));
  await addItem(page, 'Leche');
  await sleep(250);
  check('"Leche" while Milk is to buy → "Already on the list as Milk"', (await lastToast(page)) === 'Already on the list as Milk' && !item(db, 'Leche'), await lastToast(page));
  await addItem(page, 'butter');
  await sleep(250);
  check('a line bought before → "Back on the list"; the same row, its aisle kept', (await lastToast(page)) === 'Back on the list' && item(db, 'Butter').bought_at === null
    && (await toBuy(page)).some((r) => r[0] === 'Dairy & eggs' && r[1] === 'Butter'), await lastToast(page));
  await page.click('.food-lock');
  check('the lock: pressed, and says what it means', (await page.getAttribute('.food-lock', 'aria-pressed')) === 'true'
    && (await text(page, '.food-lock-hint')) === 'Locked: not on Taylor\'s My day. Every grown-up who signs in still sees it.', await text(page, '.food-lock-hint'));
  await addItem(page, 'Allergy pills');
  await sleep(250);
  check('the lock makes the next add private, then turns off', item(db, 'Allergy pills') && item(db, 'Allergy pills').private === true
    && (await page.getAttribute('.food-lock', 'aria-pressed')) === 'false' && (await row(page, 'buy', 'Allergy pills').locator('.food-lockmark').count()) === 1);
  // Suggestions while typing: [name, other word, "on the list"?, locked?].
  const sugs = () => page.$$eval('.food-suggest:not([hidden]) .food-sug', (bs) => bs.map((b) => [b.querySelector('.food-name').textContent,
    ((b.querySelector('.food-other') || {}).textContent || '').replace(/^ · /, ''), !!b.querySelector('.food-onlist'), !!b.querySelector('.food-lockmark')]));
  await page.fill(input, 'ap');
  await sleep(100);
  check('typing suggests the household\'s own lines, names starting with it first (bought ones too)',
    same(await sugs(), [['Apples', '', false, false], ['Paper towels', '', false, false]]), JSON.stringify(await sugs()));
  await page.fill(input, 'ban');
  await sleep(100);
  check('one to buy says "on the list"', same(await sugs(), [['Bananas', '', true, false]]), JSON.stringify(await sugs()));
  await page.fill(input, 'bea');
  await sleep(100);
  check('a line to buy is also found by its other word ("Frijoles · beans")', same(await sugs(), [['Frijoles', 'beans', true, false]]), JSON.stringify(await sugs()));
  await page.fill(input, 'preg');
  await sleep(100);
  check('a locked line shows its lock', (await page.$$('.food-suggest .food-lockmark')).length === 1);
  await page.click('.food-suggest .food-sug');
  await sleep(250);
  check('picking a locked one adds it with the lock on: the locked line, "Already on the list"', (await lastToast(page)) === 'Already on the list'
    && calls(db, 'add_to_list').slice(-1)[0].body.p_private === true && db.shopping_items.filter((r) => r.name_key === 'pregnancy test').length === 1, JSON.stringify(calls(db, 'add_to_list').slice(-1)));
  // A hostile name, as text.
  await addItem(page, '<img src=x onerror="window.__pwned=1">');
  await sleep(250);
  check('a hostile name shows as text', (await names(page, 'buy')).includes('<img src=x onerror="window.__pwned=1">') && !(await page.evaluate(() => window.__pwned)));
  await page.context().close();

  // =====================================================================
  // 4. Tap = bought, in place; Undo; Just bought; Buy again; Aisle?
  // =====================================================================
  db = stockList(foodDb());
  ({ page } = await open({ label: 'ticks', db }));
  await pause(page);
  const order0 = await names(page, 'buy');
  await row(page, 'buy', 'Detergent').locator('.food-tick').click();
  await row(page, 'buy', 'Shampoo').locator('.food-tick').click();
  await sleep(300);
  check('two adjacent rows tapped quickly: both ticked, struck through where they are, and they are the right ones',
    same(await names(page, 'buy'), order0) && (await row(page, 'buy', 'Detergent').locator('.food-tick').getAttribute('aria-checked')) === 'true'
    && (await row(page, 'buy', 'Shampoo').locator('.food-tick').getAttribute('aria-checked')) === 'true'
    && (await row(page, 'buy', 'Coffee').locator('.food-tick').getAttribute('aria-checked')) === 'false'
    && item(db, 'Detergent').bought_by === ID.alex && item(db, 'Shampoo').bought_by === ID.alex && !item(db, 'Coffee').bought_at
    && (await row(page, 'buy', 'Shampoo').locator('.food-name').evaluate((e) => getComputedStyle(e).textDecorationLine)) === 'line-through',
    JSON.stringify([await names(page, 'buy'), item(db, 'Detergent').bought_by]));
  const buys = calls(db, 'buy_item');
  check('each tick is buy_item(p_item, true, p_seen) with the line as the phone saw it (microseconds kept)', buys.length === 2
    && same(buys[0].body, { p_item: item(db, 'Detergent').id, p_bought: true, p_seen: item(db, 'Detergent').added_at }), JSON.stringify(buys.map((c) => c.body)));
  check('the toast: "Bought: Shampoo" with Undo', same(await page.$$eval('.toasts .toast-action', (ts) => ts.map((t) => [t.querySelector('span').textContent, t.querySelector('button').textContent])), [['Bought: Shampoo', 'Undo']]));
  await tick(page, 2500);
  check('still in place 2.5 seconds after the last tap', same(await names(page, 'buy'), order0));
  await tick(page, 700);
  check('3 seconds after the last tap they move to Just bought', !(await names(page, 'buy')).includes('Detergent') && same((await names(page, 'bought')).slice(0, 2).sort(), ['Detergent', 'Shampoo']),
    JSON.stringify([await names(page, 'buy'), await names(page, 'bought')]));
  await page.click('.toasts .toast-action button');
  await sleep(300);
  const undo = calls(db, 'buy_item').slice(-1)[0];
  check('Undo: buy_item(p_item, false, p_seen) with the seen of the reply\'s bought row; Shampoo is to buy again', undo && same(undo.body, { p_item: item(db, 'Shampoo').id, p_bought: false,
    p_seen: undo.body.p_seen }) && /\.\d{6}\+00:00$/.test(undo.body.p_seen) && item(db, 'Shampoo').bought_at === null && (await names(page, 'buy')).includes('Shampoo'),
  JSON.stringify(undo && undo.body));
  await row(page, 'bought', 'Eggs').locator('.food-tick').click();
  await sleep(300);
  check('a Just bought row tapped: unticked in place, back on the list (buy_item false with its bought_at)', (await row(page, 'bought', 'Eggs').locator('.food-tick').getAttribute('aria-checked')) === 'false'
    && item(db, 'Eggs').bought_at === null && calls(db, 'buy_item').slice(-1)[0].body.p_bought === false && (await lastToast(page)) === 'Back on the list: Eggs');
  await tick(page, 3100);
  check('…and moves to To buy 3 seconds later', (await names(page, 'buy')).includes('Eggs') && !(await names(page, 'bought')).includes('Eggs'));
  // Buy again: open, remembered, one tap.
  await page.click('.food-again-toggle');
  check('Buy again opens: by aisle, A–Z; older than 60 days left out', same(await names(page, 'again'), ['Onions', 'Paper towels', 'Butter']) && (await page.getAttribute('.food-again-toggle', 'aria-expanded')) === 'true'
    && (await page.evaluate(() => localStorage.getItem('homehub.food.buyAgain'))) === 'open', JSON.stringify(await names(page, 'again')));
  await row(page, 'again', 'Onions').locator('.food-tick').click();
  await sleep(300);
  const back = calls(db, 'buy_item').slice(-1)[0];
  check('one tap puts it back on the list: buy_item(p_item, false, <its bought_at>)', same(back.body, { p_item: item(db, 'Onions').id, p_bought: false, p_seen: at(addDays(TODAY, -10), '17:00') })
    && item(db, 'Onions').bought_at === null && item(db, 'Onions').added_by === ID.alex && (await lastToast(page)) === 'Back on the list: Onions', JSON.stringify(back.body));
  await tick(page, 3100);
  check('…it leaves Buy again for To buy (Produce)', !(await names(page, 'again')).includes('Onions') && (await toBuy(page)).some((r) => r[0] === 'Produce' && r[1] === 'Onions'));
  // The Aisle? chip: ten aisles in place, the choice saved on the row.
  await row(page, 'buy', 'Batteries').locator('.food-aisle-q').click();
  check('Aisle? opens the ten aisles under the row', same(await texts(page, '.food-aisle-pick .food-chip'), ['Produce', 'Bakery', 'Pantry', 'Drinks', 'Household', 'Personal care', 'Meat & fish', 'Dairy & eggs', 'Frozen', 'Other'])
    && (await row(page, 'buy', 'Batteries').locator('.food-aisle-q').getAttribute('aria-expanded')) === 'true');
  await page.click('.food-aisle-pick .food-chip:has-text("Household")');
  await sleep(300);
  await tick(page, 3100);
  const patch = writes(db, 'shopping_items', 'PATCH').slice(-1)[0] || {};
  check('choosing one saves it on the line (PATCH aisle) and the row moves to Household', same(patch.body, { aisle: 'household' }) && item(db, 'Batteries').aisle === 'household'
    && (await toBuy(page)).some((r) => r[0] === 'Household' && r[1] === 'Batteries'), JSON.stringify([patch, await toBuy(page)]));
  // Undo after the tick was answered, when the tick found the line already bought by Sam (on his phone,
  // before this one read the list again): not this phone's purchase, so nothing is sent.
  await page.evaluate(() => document.querySelectorAll('.toasts .toast').forEach((t) => t.remove()));
  const iceBefore = calls(db, 'buy_item').length;
  Object.assign(item(db, 'Ice cream'), { bought_at: at(TODAY, '09:40', '000555'), bought_by: ID.sam });
  await row(page, 'buy', 'Ice cream').locator('.food-tick').click();
  await sleep(300);
  await page.click('.toasts .toast-action button');
  await sleep(300);
  check('Undo after a tick that found the line already bought by someone else: nothing is sent, "Changed on another phone", and Sam\'s purchase stays',
    calls(db, 'buy_item').length === iceBefore + 1 && (await toasts(page)).includes('Changed on another phone') && item(db, 'Ice cream').bought_by === ID.sam
    && item(db, 'Ice cream').bought_at === at(TODAY, '09:40', '000555'), JSON.stringify([calls(db, 'buy_item').slice(iceBefore).map((c) => c.body), await toasts(page)]));
  await tick(page, 3100);
  check('…and the list shows it as it is: under Just bought, with Sam\'s dot', (await names(page, 'bought')).includes('Ice cream') && !(await names(page, 'buy')).includes('Ice cream'));
  // One row tapped three times inside the hold, each tap answered before the next. Every un-tick gives
  // the line a new seen (§4.2), so a tap on a row already changed here goes by id, with the seen the
  // list has now, never the one it was drawn with: no "Changed on another phone", and it ends as tapped.
  await page.evaluate(() => document.querySelectorAll('.toasts .toast').forEach((t) => t.remove()));
  const coffee0 = calls(db, 'buy_item').length;
  const coffeeSeen0 = item(db, 'Coffee').added_at;
  const tapAnswered = async (part, name) => {
    const n = calls(db, 'buy_item').length;
    await row(page, part, name).locator('.food-tick').click();
    for (let i = 0; i < 50 && calls(db, 'buy_item').length === n; i++) await sleep(40);   // sent and answered
    await sleep(250);
  };
  await tapAnswered('buy', 'Coffee');      // tick
  const coffeeBought = item(db, 'Coffee').bought_at;
  await tapAnswered('buy', 'Coffee');      // untick (an Undo: a new seen)
  const coffeeSeen1 = item(db, 'Coffee').added_at;
  await tapAnswered('buy', 'Coffee');      // tick again
  const coffeeCalls = calls(db, 'buy_item').slice(coffee0).map((c) => c.body);
  check('To buy: tick, untick, tick on one row before it moves: each sent with the row\'s seen at that moment (the last one the Undo\'s new seen); bought, nothing else said',
    coffeeCalls.length === 3 && same(coffeeCalls.map((b) => [b.p_bought, b.p_seen]), [[true, coffeeSeen0], [false, coffeeBought], [true, coffeeSeen1]]) && coffeeSeen1 !== coffeeSeen0
    && item(db, 'Coffee').bought_by === ID.alex && !(await toasts(page)).includes('Changed on another phone')
    && (await row(page, 'buy', 'Coffee').locator('.food-tick').getAttribute('aria-checked')) === 'true', JSON.stringify([coffeeCalls, coffeeSeen0, coffeeSeen1, await toasts(page)]));
  await page.evaluate(() => document.querySelectorAll('.toasts .toast').forEach((t) => t.remove()));
  const applesTaps0 = calls(db, 'buy_item').length;
  await tapAnswered('bought', 'Apples');   // back on the list
  await tapAnswered('bought', 'Apples');   // bought again
  const applesRebought = item(db, 'Apples').bought_at;
  await tapAnswered('bought', 'Apples');   // back on the list again
  const applesTaps = calls(db, 'buy_item').slice(applesTaps0).map((c) => c.body);
  check('Just bought: untick, tick, untick on one row before it moves: the last goes with the new purchase\'s seen; to buy, nothing else said',
    applesTaps.length === 3 && same(applesTaps.map((b) => b.p_bought), [false, true, false]) && applesTaps[2].p_seen === applesRebought
    && item(db, 'Apples').bought_at === null && !(await toasts(page)).includes('Changed on another phone')
    && (await row(page, 'bought', 'Apples').locator('.food-tick').getAttribute('aria-checked')) === 'false', JSON.stringify([applesTaps, applesRebought, await toasts(page)]));
  await tick(page, 3100);
  check('…3 seconds later: Coffee under Just bought, Apples to buy', (await names(page, 'bought')).includes('Coffee') && (await names(page, 'buy')).includes('Apples')
    && !(await names(page, 'buy')).includes('Coffee') && !(await names(page, 'bought')).includes('Apples'));
  await page.clock.resume();
  await page.reload();
  await until(page, () => !!document.querySelector('[data-part="buy"]'), 6000);
  check('Buy again stays open after a reload (remembered on this device)', (await page.getAttribute('.food-again-toggle', 'aria-expanded')) === 'true' && !(await page.$eval('#foodAgain', (e) => e.hidden)));
  await page.context().close();

  // =====================================================================
  // 5. Edit, Forget, a rename clash and Merge
  // =====================================================================
  db = stockList(foodDb());
  ({ page } = await open({ label: 'edit', db, allowConsole: /status of 409/ }));
  await row(page, 'buy', 'Light bulbs').locator('.food-menu').click();
  await sleep(100);
  check('⋯ opens Edit: the ten aisle chips, name, note, the lock in words, Forget', (await dlg(page, 'h3')) === 'Light bulbs' && (await page.$$('#formDialog [data-aisle]')).length === 10
    && (await page.getAttribute('#formDialog [data-aisle="other"]', 'aria-pressed')) === 'true' && (await page.inputValue('#formDialog input[name="name"]')) === 'Light bulbs'
    && (await dlg(page, '.food-help')) === 'Locked: not on Taylor\'s My day. Every grown-up who signs in still sees it.' && !!(await page.$('#formDialog [data-act="forget"]')));
  await page.click('#formDialog [data-aisle="household"]');
  await page.fill('#formDialog input[name="note"]', '60W');
  await page.click('#formDialog button[type="submit"]');
  await sleep(300);
  check('Save updates the line (name, note, aisle, lock)', same(writes(db, 'shopping_items', 'PATCH').slice(-1)[0].body, { name: 'Light bulbs', note: '60W', aisle: 'household', private: false })
    && item(db, 'Light bulbs').aisle === 'household' && (await lastToast(page)) === 'Saved Light bulbs');
  await sleep(3200);
  await row(page, 'buy', 'Batteries').locator('.food-menu').click();
  await sleep(100);
  await page.fill('#formDialog input[name="name"]', 'milk');
  await page.fill('#formDialog input[name="note"]', 'AA');
  await page.click('#formDialog button[type="submit"]');
  await sleep(300);
  check('a rename that clashes: "There\'s already a line called Milk." and Merge', (await dlg(page, '.form-error')) === 'There\'s already a line called Milk.'
    && (await dlg(page, '[data-act="merge"]')) === 'Merge' && !!item(db, 'Batteries'), await dlg(page, '.form-error'));
  await page.click('#formDialog [data-act="merge"]');
  await sleep(400);
  check('Merge: forgets this line, then adds "Milk: AA" (the note joins Milk)', !item(db, 'Batteries') && item(db, 'Milk').note === 'AA'
    && calls(db, 'add_to_list').slice(-1)[0].body.p_name === 'Milk: AA' && (await lastToast(page)) === 'Merged into Milk', JSON.stringify([item(db, 'Milk'), calls(db, 'add_to_list').slice(-1)]));
  await sleep(3200);
  db.confirm = false;
  await row(page, 'buy', 'Rice').locator('.food-menu').click();
  await sleep(100);
  await page.click('#formDialog [data-act="forget"]');
  await sleep(200);
  check('Forget asks first ("Forget Rice? It won\'t be suggested again."); No keeps it', db.dialogs.slice(-1)[0] === 'Forget Rice? It won\'t be suggested again.' && !!item(db, 'Rice'), JSON.stringify(db.dialogs));
  db.confirm = true;
  await page.click('#formDialog [data-act="forget"]');
  await sleep(400);
  check('Forget: Yes deletes the row', !item(db, 'Rice') && writes(db, 'shopping_items', 'DELETE').some((w) => w.query.includes('id=eq.')) && (await lastToast(page)) === 'Forgot Rice');
  await sleep(3200);
  check('…and it is gone from the list', !(await names(page, 'buy')).includes('Rice'));
  await page.context().close();

  // =====================================================================
  // 6. The poll (page.clock): a change made elsewhere, held while tapping, no redraw when unchanged, none while hidden
  // =====================================================================
  db = stockList(foodDb());
  ({ page } = await open({ label: 'poll', db }));
  await pause(page);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));   // read now, so the next read is 10 seconds from here
  await sleep(400);
  let n0 = calls(db, 'shopping_list').length;
  db.shopping_items.push(shopItem({ name: 'Yogurt', aisle: 'dairy', added_at: at(TODAY, '09:40'), added_by: ID.sam }));
  await tick(page, 9800);
  check('nothing read again before 10 seconds', calls(db, 'shopping_list').length === n0 && !(await names(page, 'buy')).includes('Yogurt'));
  await tick(page, 300);
  check('a line added on another phone shows within 10 seconds', calls(db, 'shopping_list').length === n0 + 1 && (await names(page, 'buy')).includes('Yogurt'));
  await page.$eval('[data-part="buy"] .food-row', (r) => { r.dataset.mark = 'kept'; });
  await tick(page, 10100);
  check('no redraw when the answer is the same (as_of aside)', calls(db, 'shopping_list').length === n0 + 2 && (await page.$('[data-part="buy"] .food-row[data-mark="kept"]')) !== null);
  // Held while tapping: a change arrives 1 second after a tap; it shows 3 seconds after the tap.
  await tick(page, 9000);
  item(db, 'Yogurt').bought_at = at(TODAY, '09:41');
  item(db, 'Yogurt').bought_by = ID.sam;
  await row(page, 'buy', 'Coffee').locator('.food-tick').click();
  await sleep(250);
  await tick(page, 1100);
  check('a change from another phone waits while a finger is on the list', (await names(page, 'buy')).includes('Yogurt') && (await names(page, 'buy')).includes('Coffee'));
  await tick(page, 2100);
  check('…and shows 3 seconds after the last tap', !(await names(page, 'buy')).includes('Yogurt') && !(await names(page, 'buy')).includes('Coffee') && (await names(page, 'bought')).includes('Yogurt'));
  // Hidden: no reads; visible again: one at once.
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  n0 = calls(db, 'shopping_list').length;
  await tick(page, 35000);
  check('none while the page is hidden', calls(db, 'shopping_list').length === n0, calls(db, 'shopping_list').length - n0);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(300);
  check('visible again: read at once', calls(db, 'shopping_list').length === n0 + 1);
  await page.context().close();

  // =====================================================================
  // 7. The outbox: no connection, the banner, a reload keeps the queue; changed elsewhere; 503; 42501
  // =====================================================================
  db = stockList(foodDb());
  let ctx;
  ({ page, context: ctx } = await open({ label: 'outbox', db, allowConsole: /status of (503|403)/ }));
  await page.route('**/rest/v1/rpc/buy_item', (route) => route.abort('internetdisconnected'));
  await pause(page);
  await row(page, 'buy', 'Coffee').locator('.food-tick').click();
  await sleep(300);
  await tick(page, 3100);
  check('no connection: the tick shows (Just bought), marked "Not sent yet"', (await names(page, 'bought')).includes('Coffee')
    && (await row(page, 'bought', 'Coffee').locator('.food-unsent').textContent()) === 'Not sent yet' && !item(db, 'Coffee').bought_at);
  check('no banner before 15 seconds', !(await page.$('.food-unsent-banner')));
  await tick(page, 12500);
  check('after 15 seconds the banner says how many are waiting', (await text(page, '.food-unsent-banner')) === '1 change not sent yet. They\'ll go when there\'s signal; keep this page open.', await text(page, '.food-unsent-banner'));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('homehub.shop.hub')));
  check('the queue and the list are saved on this device for Alex', saved && saved.owner === ID.alex && same(saved.queue.map((x) => [x.op, x.item]), [['buy', item(db, 'Coffee').id]]) && !!saved.snap,
    JSON.stringify(saved && saved.queue));
  await page.clock.resume();
  await page.reload();
  await until(page, () => !!document.querySelector('[data-part="bought"]'), 6000);
  await sleep(300);
  check('after a reload the waiting tick is still there, "Not sent yet"', (await names(page, 'bought')).includes('Coffee') && !item(db, 'Coffee').bought_at
    && (await row(page, 'bought', 'Coffee').locator('.food-unsent').count()) === 1);
  await page.unroute('**/rest/v1/rpc/buy_item');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(page, () => !document.querySelector('.food-unsent'), 6000);
  check('back online: it is sent once, and Coffee is bought by Alex', calls(db, 'buy_item').length === 1 && item(db, 'Coffee').bought_by === ID.alex
    && !(await page.$('.food-unsent-banner')), JSON.stringify(calls(db, 'buy_item').map((c) => c.body)));
  // A tick that waited while someone else bought and put back the same line: changed: false.
  await page.route('**/rest/v1/rpc/buy_item', (route) => route.abort('internetdisconnected'));
  await row(page, 'buy', 'Bananas').locator('.food-tick').click();
  await sleep(300);
  Object.assign(item(db, 'Bananas'), { added_at: at(TODAY, '09:41', '000777'), added_by: ID.sam });   // Sam bought them and put them back
  await page.unroute('**/rest/v1/rpc/buy_item');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(page, () => [...document.querySelectorAll('.toasts .toast')].some((t) => t.textContent === 'Changed on another phone'), 6000);
  check('a tick queued before someone else\'s put-back answers changed: false: "Changed on another phone", and the new need isn\'t bought',
    (await toasts(page)).includes('Changed on another phone') && !item(db, 'Bananas').bought_at, JSON.stringify(await toasts(page)));
  await sleep(3200);
  check('…and the list shows Bananas to buy, as it is now', (await names(page, 'buy')).includes('Bananas'));
  // A line bought today, added again with no connection (it comes back to To buy, "Not sent yet") and
  // ticked before the add is answered: the tick waits for the add and takes the line's new seen from it.
  await page.evaluate(() => document.querySelectorAll('.toasts .toast').forEach((t) => t.remove()));
  await page.route('**/rest/v1/rpc/add_to_list', (route) => route.abort('internetdisconnected'));
  const applesBought = item(db, 'Apples').bought_at;
  await addItem(page, 'Apples');
  check('no connection: a line bought today, added again, is back under To buy at once, "Not sent yet", with a box',
    await until(page, () => [...document.querySelectorAll('[data-part="buy"] .food-row')].some((r) => r.querySelector('.food-name').textContent === 'Apples'
      && !!r.querySelector('.food-unsent') && !!r.querySelector('.food-tick[role="checkbox"]'))), JSON.stringify(await names(page, 'buy')));
  await row(page, 'buy', 'Apples').locator('.food-tick').click();
  await sleep(300);
  const buysBefore = calls(db, 'buy_item').length;
  await page.unroute('**/rest/v1/rpc/add_to_list');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(page, () => !document.querySelector('.food-unsent'), 6000);
  await sleep(300);
  const applesBuy = calls(db, 'buy_item').slice(buysBefore);
  check('back online: the add brings it back, then the tick goes with its new added_at: Apples bought by Alex again, no "Changed on another phone"',
    applesBuy.length === 1 && same(applesBuy[0].body, { p_item: item(db, 'Apples').id, p_bought: true, p_seen: item(db, 'Apples').added_at })
    && item(db, 'Apples').bought_by === ID.alex && item(db, 'Apples').bought_at !== applesBought && !!item(db, 'Apples').bought_at
    && !(await toasts(page)).includes('Changed on another phone'), JSON.stringify([applesBuy.map((c) => c.body), item(db, 'Apples'), await toasts(page)]));
  // A 503 is retried; a 42501 is dropped, with the database's words.
  let first503 = true;
  await page.route('**/rest/v1/rpc/buy_item', (route) => {
    if (route.request().method() === 'OPTIONS' || !first503) return route.fallback();
    first503 = false;
    return route.fulfill({ status: 503, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Service Unavailable' }) });
  });
  const before503 = calls(db, 'buy_item').length;
  await row(page, 'buy', 'Rice').locator('.food-tick').click();
  await until(page, () => false, 2600);
  check('a 503 is kept and sent again (after 2 seconds)', !first503 && calls(db, 'buy_item').length === before503 + 1 && !!item(db, 'Rice').bought_at);
  await page.unroute('**/rest/v1/rpc/buy_item');
  await page.route('**/rest/v1/rpc/add_to_list', (route) => (route.request().method() === 'OPTIONS' ? route.fallback()
    : route.fulfill({ status: 403, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: '42501', message: 'Only the family can change the shopping list.', details: null, hint: null }) })));
  await addItem(page, 'Cereal bars');
  await sleep(500);
  check('a 42501 is dropped with one toast in the database\'s words; nothing waits', (await toasts(page)).includes('Only the family can change the shopping list.')
    && !(await names(page, 'buy')).includes('Cereal bars') && (await page.evaluate(() => JSON.parse(localStorage.getItem('homehub.shop.hub')).queue.length)) === 0, JSON.stringify(await toasts(page)));
  await page.unroute('**/rest/v1/rpc/add_to_list');
  await page.close();

  // =====================================================================
  // 7b. Leaving Food while an add is on its way: its answer still comes, and it is never sent again
  // =====================================================================
  {
    const dbL = stockList(foodDb());
    const { page: pg } = await open({ label: 'late answer', db: dbL });
    let held = null;   // the next add_to_list waits until held.go()
    const holdNext = () => { let go; held = { caught: false, wait: new Promise((r) => { go = r; }) }; held.go = go; };
    await pg.route('**/rest/v1/rpc/add_to_list', async (route) => {
      if (route.request().method() !== 'OPTIONS' && held && !held.caught) { held.caught = true; await held.wait; }
      return route.fallback();
    });
    const saved = () => pg.evaluate(() => JSON.parse(localStorage.getItem('homehub.shop.hub') || 'null'));
    const toTab = async (hash, ready) => { await pg.evaluate((h) => { location.hash = h; }, hash); await until(pg, ready, 6000); };
    const onToday = () => !!document.querySelector('#stub') && document.querySelector('#stub').textContent === 'Today';
    const onFood = () => !!document.querySelector('.food-list .food-part');
    const caught = async () => { for (let i = 0; i < 100 && !held.caught; i++) await sleep(40); return held.caught; };
    // Alex adds Yogurt and taps Today before the answer; the answer comes to the closed page.
    holdNext();
    await addItem(pg, 'Yogurt');
    await caught();
    await toTab('#/', onToday);
    held.go();
    await sleep(500);
    const queueAfter = (await saved()).queue;
    Object.assign(item(dbL, 'Yogurt'), { bought_at: at(TODAY, '09:41', '000321'), bought_by: ID.sam });   // then Sam buys it
    await toTab('#/food', onFood);
    await sleep(800);
    check('an add answered after Food was left comes off the saved queue; opening Food again doesn\'t send it again (Yogurt stays bought by Sam)',
      same(queueAfter, []) && calls(dbL, 'add_to_list').length === 1 && item(dbL, 'Yogurt').bought_by === ID.sam
      && !(await toasts(pg)).includes('Back on the list') && (await names(pg, 'bought')).includes('Yogurt'), JSON.stringify([queueAfter, calls(dbL, 'add_to_list').map((c) => c.body), await toasts(pg)]));
    // Alex adds Granola, taps Today and comes back to Food before the answer: Food takes that answer.
    holdNext();
    await addItem(pg, 'Granola');
    await caught();
    await toTab('#/', onToday);
    await toTab('#/food', onFood);
    await sleep(500);
    held.go();
    await sleep(800);
    check('…and Food opened again before the answer waits for it rather than sending the add a second time: Granola is on the list once',
      calls(dbL, 'add_to_list').length === 2 && dbL.shopping_items.filter((r) => r.name === 'Granola').length === 1 && (await names(pg, 'buy')).includes('Granola')
      && same((await saved()).queue, []), JSON.stringify([calls(dbL, 'add_to_list').map((c) => c.body), (await saved()).queue]));
    await pg.context().close();
  }
  // A member with no person (Sam's email isn't on his person): there is no bought_by to tell whose a
  // purchase is, so an Undo after the tick's answer undoes it, as it always did.
  {
    const dbN = stockList(foodDb());
    dbN.people.find((p) => p.id === ID.sam).email = null;
    const { page: pg } = await open({ label: 'no person', db: dbN, email: 'sam@example.com' });
    await row(pg, 'buy', 'Coffee').locator('.food-tick').click();
    await until(pg, () => false, 400);
    await pg.click('.toasts .toast-action button');
    await until(pg, () => false, 400);
    const ticks = calls(dbN, 'buy_item').map((c) => c.body);
    check('a member with no person: an Undo after the tick\'s answer still undoes it (nothing to compare a purchase with)',
      ticks.length === 2 && ticks[0].p_bought === true && ticks[1].p_bought === false && item(dbN, 'Coffee').bought_at === null
      && !(await toasts(pg)).includes('Changed on another phone'), JSON.stringify([ticks, await toasts(pg)]));
    await pg.context().close();
  }

  // =====================================================================
  // 8. The saved list when the reads fail; dropped for someone else and at sign-out
  // =====================================================================
  ({ page } = await open({ label: 'saved', db, context: ctx, allowConsole: /status of 500/ }));
  await page.route('**/rest/v1/rpc/shopping_list', (route) => route.abort('internetdisconnected'));
  await page.route('**/rest/v1/shopping_items*', (route) => (route.request().method() === 'GET' ? route.abort('internetdisconnected') : route.fallback()));
  await page.reload();
  await until(page, () => !!document.querySelector('.food-offline'), 6000);
  check('the reads fail: the saved list, under "No connection: this is the list from 9:42am."', (await tc(page, '.food-offline')) === 'No connection: this is the list from 9:42am. Try again'
    && (await names(page, 'buy')).includes('Milk') && !!(await page.$('.food-plan')), await tc(page, '.food-offline'));
  db.clock = { local_date: '2026-10-28', local_time: '07:00:00', tz: 'America/New_York' };
  await page.reload();
  await until(page, () => !!document.querySelector('.food-offline'), 6000);
  check('…with the day when it isn\'t today (the database\'s as_of, never the phone\'s clock)', (await tc(page, '.food-offline')) === 'No connection: this is the list from Tue 9:42am. Try again',
    await tc(page, '.food-offline'));
  db.clock = { local_date: TODAY, local_time: '09:42:00', tz: 'America/New_York' };
  await page.close();
  // Sam signs in on the same browser: Alex's saved list is dropped unread.
  await signIn(ctx, 'sam@example.com');
  ({ page } = await open({ label: 'saved-sam', db, context: ctx, before: (p) => p.route('**/rest/v1/rpc/shopping_list', (route) => route.abort('internetdisconnected')) }));
  await until(page, () => !!document.querySelector('.food-fail, .food-offline'), 6000);
  check('another person signed in: the saved list isn\'t shown, and is removed', !!(await page.$('.food-list .food-fail')) && !(await page.$('.food-offline'))
    && (await page.evaluate(() => localStorage.getItem('homehub.shop.hub'))) === null, await tc(page, '.food-list'));
  await page.unroute('**/rest/v1/rpc/shopping_list');
  await page.reload();
  await until(page, () => !!document.querySelector('[data-part="buy"]'), 6000);
  check('Sam\'s own list is saved for Sam', (await page.evaluate(() => JSON.parse(localStorage.getItem('homehub.shop.hub')).owner)) === ID.sam);
  await page.click('[data-shell="sign-out"]');
  await sleep(500);
  check('signing out removes the saved list', (await page.evaluate(() => localStorage.getItem('homehub.shop.hub'))) === null);
  await ctx.close();

  // =====================================================================
  // 9. The parents' switches; Send Taylor the list
  // =====================================================================
  db = stockList(foodDb());
  ({ page } = await open({ label: 'switches', db }));
  const segs = () => page.$$eval('.food-seg-btn', (bs) => bs.map((b) => [b.textContent, b.getAttribute('aria-checked'), b.disabled]));
  check('"Shopping list on Taylor\'s My day: Off · See and tick · See, tick and add" (all three by default)', (await text(page, '.food-set-title')) === 'Shopping list on Taylor\'s My day'
    && same(await segs(), [['Off', 'false', false], ['See and tick', 'false', false], ['See, tick and add', 'true', false]]), JSON.stringify(await segs()));
  check('"Dinners on the kitchen wall (Hub – Family)", on, with "Needs Google Calendar & Hearth with a Family calendar" when there isn\'t one',
    (await text(page, '.food-switch')) === 'Dinners on the kitchen wall (Hub – Family)' && (await page.isChecked('[data-act="wall"]'))
    && (await text(page, '.food-set-hint')) === 'Needs Google Calendar & Hearth with a Family calendar');
  const sendA = await page.$$eval('[data-ref="send"] li', (lis) => lis.map((li) => [li.querySelector('b').textContent, ...[...li.querySelectorAll('a')].map((a) => a.getAttribute('href'))]));
  const link = `${BASE}/day.html?t=${token(ID.taylor)}#list`;
  check('Send Taylor the list: WhatsApp and Text with her My day link to #list, in her language', sendA.length === 1 && sendA[0][0] === 'Send Taylor the list'
    && sendA[0][1].startsWith('https://wa.me/12015550104?text=') && decodeURIComponent(sendA[0][1].split('text=')[1]).includes(link)
    && /^Hola Taylor/.test(decodeURIComponent(sendA[0][1].split('text=')[1])) && sendA[0][2].startsWith('sms:+12015550104?&body=') && decodeURIComponent(sendA[0][2].split('body=')[1]).includes(link),
  JSON.stringify(sendA));
  await page.click('.food-seg-btn[data-value="see"]');
  await sleep(400);
  let hw = writes(db, 'household', 'PATCH').slice(-1)[0] || {};
  check('a parent sets See and tick: saved with the household\'s updated_at check', same(hw.body, { helper_list: 'see' }) && /updated_at=eq\./.test(hw.query) && db.household[0].helper_list === 'see'
    && (await page.getAttribute('.food-seg-btn[data-value="see"]', 'aria-checked')) === 'true' && (await lastToast(page)) === 'Saved', JSON.stringify(hw));
  await page.click('.food-seg-btn[data-value="off"]');
  await sleep(400);
  check('Off: "Send Taylor the list" goes', db.household[0].helper_list === 'off' && !(await page.$('[data-ref="send"] li')));
  await page.uncheck('[data-act="wall"]');
  await sleep(400);
  hw = writes(db, 'household', 'PATCH').slice(-1)[0] || {};
  check('the wall switch saves meals_on_wall', same(hw.body, { meals_on_wall: false }) && db.household[0].meals_on_wall === false);
  db.household[0].updated_at = '2026-10-27T13:00:00.000000+00:00';   // another parent changed the settings meanwhile
  await page.click('.food-seg-btn[data-value="add"]');
  await sleep(400);
  check('a save that lost the race to another parent says so; nothing changes', db.household[0].helper_list === 'off' && /someone else changed the settings/.test(await lastToast(page)), await lastToast(page));
  db.calendars.push(calendarRow({ google_id: 'family0123@group.calendar.google.com', kind: 'family', label: 'Family', writes: true }));
  await page.reload();
  await until(page, () => !!document.querySelector('.food-set'), 6000);
  await sleep(200);
  check('with a Family calendar, no hint', !(await page.$('.food-set-hint')));
  await page.context().close();
  ({ page } = await open({ label: 'switches-sam', db, email: 'sam@example.com' }));
  check('members see the switches read-only', same((await segs()).map((s) => s[2]), [true, true, true]) && (await page.$eval('[data-act="wall"]', (i) => i.disabled))
    && (await text(page, '.food-set-note')) === 'Only parents can change these.');
  await page.context().close();

  // =====================================================================
  // 10. The Add sheet's Shopping (openListAdd): two items in a row
  // =====================================================================
  db = stockList(foodDb());
  ({ page } = await open({ label: 'add-sheet', db, path: '/#/' }));
  await page.click('.topbar-end [data-shell="add"]');
  await page.click('#sheet [data-add="shopping"]');
  await sleep(150);
  check('Add → Shopping: a one-field dialog', (await dlg(page, 'h3')) === 'Add to the shopping list' && (await page.evaluate(() => document.activeElement && document.activeElement.name)) === 'what');
  await page.fill('#formDialog input[name="what"]', '3 cans of black beans');
  await page.press('#formDialog input[name="what"]', 'Enter');
  await sleep(300);
  check('Enter adds it (add_to_list), says so, clears the box and stays open', (await dlg(page, '.food-said')) === 'Added: black beans' && (await page.inputValue('#formDialog input[name="what"]')) === ''
    && (await page.evaluate(() => document.getElementById('formDialog').open)) && same(calls(db, 'add_to_list').map((c) => c.body), [{ p_name: '3 cans of black beans', p_private: false }])
    && item(db, 'black beans').note === '3 cans', await dlg(page, '.food-said'));
  await page.fill('#formDialog input[name="what"]', 'leche');
  await page.press('#formDialog input[name="what"]', 'Enter');
  await sleep(300);
  check('a second item in a row: "Already on the list as Milk"', (await dlg(page, '.food-said')) === 'Already on the list as Milk' && calls(db, 'add_to_list').length === 2, await dlg(page, '.food-said'));
  await page.fill('#formDialog input[name="what"]', 'eggs');
  await page.press('#formDialog input[name="what"]', 'Enter');
  await sleep(300);
  check('…and one bought today: "Back on the list: Eggs"', (await dlg(page, '.food-said')) === 'Back on the list: Eggs' && item(db, 'Eggs').bought_at === null, await dlg(page, '.food-said'));
  await page.click('#formDialog [data-close].btn');
  await page.evaluate(() => { location.hash = '#/food'; });
  await until(page, () => !!document.querySelector('[data-part="buy"]'), 4000);
  check('the Food page has them', (await names(page, 'buy')).includes('black beans') && (await names(page, 'buy')).includes('Eggs'));
  await page.context().close();

  // =====================================================================
  // 11. The dinner read fails on its own; the list draws as usual
  // =====================================================================
  db = stockList(foodDb());
  ({ page } = await open({ label: 'meals-fail', db, allowConsole: /status of 500/ }));
  await page.route('**/rest/v1/meals*', (route) => (route.request().method() === 'GET'
    ? route.fulfill({ status: 500, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'XX000', message: 'Database restarting' }) }) : route.fallback()));
  await page.reload();
  await until(page, () => !!document.querySelector('.food-week-sec .food-fail'), 6000);
  check('dinners can\'t be read: one line says so; the list is there', (await tc(page, '.food-week-sec .food-fail')) === 'Dinners couldn\'t be loaded. Try again' && (await names(page, 'buy')).length === 13);
  await page.context().close();

  // =====================================================================
  // 12. Phones and desktops, light and dark
  // =====================================================================
  const showDb = () => {
    const d = stockList(pastDinners(foodDb()));
    d.meals.push(mealRow({ day: TODAY, title: 'Tacos', cook_id: ID.sam, note: 'Chicken is in the freezer', link: RECIPE }));
    d.meals.push(mealRow({ day: addDays(TODAY, 1), kind: 'leftovers', title: null, cook_id: ID.taylor }));
    d.meals.push(mealRow({ day: addDays(TODAY, 3), kind: 'out', title: null }));
    d.meals.push(mealRow({ day: addDays(TODAY, 4), title: 'Birthday dinner', cook_id: ID.alex, private: true }));
    d.meals.push(mealRow({ day: addDays(TODAY, 5), title: 'Lasagna', cook_id: ID.morgan }));
    return d;
  };
  for (const [size, ctxOpts] of [['phone', phone], ['desktop', { viewport: { width: 1280, height: 900 } }]]) {
    for (const scheme of ['light', 'dark']) {
      ({ page } = await open({ label: `shot-${size}-${scheme}`, db: showDb(), ctx: Object.assign({ colorScheme: scheme }, ctxOpts) }));
      await page.click('.food-again-toggle');
      await sleep(100);
      check(`${size} (${scheme}): no sideways scroll`, await noSideScroll(page));
      if (size === 'phone') {
        const small = await page.$$eval('.food-tick, .food-menu, .food-lock, .food-add-btn, .food-aisle-q, .food-day, .food-seg-btn, .food-again-toggle, [data-ref="send"] .btn',
          (els) => els.filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return [e.className, Math.round(r.width), Math.round(r.height)]; })
            .filter(([, wd, ht]) => wd < 44 || ht < 44));
        check(`phone (${scheme}): every tap target is at least 44px`, !small.length, JSON.stringify(small.slice(0, 4)));
        const week = await page.$eval('.food-week', (e) => [e.scrollWidth > e.clientWidth, e.getBoundingClientRect().right <= window.innerWidth + 1]);
        check(`phone (${scheme}): the week row scrolls sideways inside itself`, week[0] && week[1], JSON.stringify(week));
      } else {
        const fit = await page.$eval('.food-week', (e) => e.scrollWidth <= e.clientWidth + 1);
        check(`desktop (${scheme}): all 7 dinners fit`, fit);
      }
      await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: SHOTS + `food-${size}-${scheme}.png`, fullPage: true });
      if (scheme === 'light') {
        await page.click('.food-day[data-day="2026-10-27"]');
        await sleep(150);
        await page.screenshot({ path: SHOTS + `food-${size}-dinner.png` });
        await page.evaluate(() => document.getElementById('formDialog').close());
        await row(page, 'buy', 'Milk').locator('.food-menu').click();
        await sleep(100);
        await page.screenshot({ path: SHOTS + `food-${size}-edit.png` });
      }
      await page.context().close();
    }
  }

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
