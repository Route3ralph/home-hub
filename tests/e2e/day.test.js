// Browser tests for My day (day.html?t=<token>), the public page for kids and helpers: what it loads
// (config.js and supabase-js only, no hub, no manifest, noindex and no-referrer), today / late / tomorrow
// in English and Spanish, ticking off with Undo, refreshes, links that don't work, the #confirm and #stop
// questions (nothing changes on load), the "Add to Home Screen" hint, phone width and dark mode; and (schema 3)
// a Google Calendar event (kind 'google'): no box to tick, an outlined dot, a hostile title shown as text.
//
// The fake RPCs answer with the shapes in supabase/migrations/0002_home_hub_v2.sql:
//   get_person_day(p_token) → { person: { name, language, digest_enabled, email_confirmed }, today,
//     days: [{ day, items }, { day, items }], late } or null; items have kind, item_id, occurrence, day,
//     end_day, title, all_day, start_time / end_time ('HH:MM'), time_label, location, contractor_name,
//     contractor_phone, note, who, status, mine (who: the other people on it, by first name, from the
//     person's side: "with Jordan" for the one in charge, "Pat" for someone along; null on a private item)
//   complete_by_token(p_token, p_task_id, p_occurrence) → uuid | null; undo_by_token(p_token, p_log_id) → uuid | null
//   confirm_digest(p_confirm) → boolean (the confirmation secret is the whole key); stop_digest(p_token) → boolean
// The confirmation email links to day.html?c=<secret>#confirm, with no My day token.
// v1.2 (docs/v1.2-kitchen.md §7, §8, §13), on a database with mock.js's withFood: get_person_day's
// days[i].meals and list keys (personDayFood), and the list's token functions (foodRpc, the
// migration's rules and shapes): get_list_by_token(p_token) → { language, as_of, can_add, items,
// bought, suggest? } or null; add_to_list_by_token(p_token, p_name) → { result, item_id, name } and
// the list; buy_item_by_token(p_token, p_item, p_bought, p_seen) → { changed, seen } and the list. Meal rows
// in English and Spanish; the list button only with `list`, and no list request without it; the list
// read and saved in the background after the day's own request; #list in Spanish at 390px (ticks in
// place, the Undo toast (Deshacer unticks the row where it is, under Comprado hoy too), Comprado hoy, Add again, the add box and its suggestions, Comprar otra vez,
// every new error word); the 10-second read only on #list; the outbox (not sent yet, the banner, a
// reload, retries, "changed on another phone", a line added again offline and ticked before the add is
// answered, Deshacer of a tick that found Alex's purchase, Deshacer of a tick waiting for "¿Añadir otra vez?"
// after a read past midnight); the saved list when Supabase gets no answer at the
// start; a null answer clearing what was saved.
// mock.js answers RPCs for signed-in members only, so the token functions (called signed out) are
// answered by a route added here; everything else (config.js, supabase-js) comes from mock.js.
// The browser runs in Pacific/Kiritimati (UTC+14) with its clock set so the device's date is a day
// ahead of the household's: anything using the device's date or zone shows the wrong day.
// Run alone with: node tests/e2e/day.test.js
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { makeDb, install, signIn, SUPA, withFood, foodRpc, personDayFood, shopItem, mealRow } = require('./mock');
const { serve, ROOT } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A list change's body as sent, its key checked and set aside: every change carries its own key
// (p_key, a version 4 uuid), sent with every try; a missing or malformed one stays in, so a comparison fails.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyed = (body) => {
  const rest = Object.assign({}, body);
  const key = rest.p_key;
  delete rest.p_key;
  return UUID.test(key) ? rest : Object.assign(rest, { p_key: key === undefined ? 'missing' : key });
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };

// ---- Fixtures (fictional people only)
const TAYLOR = '0123456789abcdef0123456789abcdef';   // helper, English
const JORDAN = 'fedcba9876543210fedcba9876543210';   // kid, Spanish
const MORGAN = '00112233445566778899aabbccddeeff';   // kid, nothing planned, email confirmed, morning email off
const UNKNOWN = 'ffffffffffffffffffffffffffffffff';
const CONFIRM = 'c0ffee00c0ffee00c0ffee00c0ffee00';  // the code in Taylor's confirmation email
const ID = {
  walk: '11111111-1111-4111-8111-111111111111',
  feed: '22222222-2222-4222-8222-222222222222',
  recycle: '33333333-3333-4333-8333-333333333333',
  sweep: '44444444-4444-4444-8444-444444444444',
  gutters: '55555555-5555-4555-8555-555555555555',
  bed: '66666666-6666-4666-8666-666666666666',
  furnace: '77777777-7777-4777-8777-777777777777',
  piano: '88888888-8888-4888-8888-888888888888',
  holiday: '99999999-9999-4999-8999-999999999999',
  dentist: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  camping: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  jpiano: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const TODAY = '2026-10-25';      // a Sunday, in the household (America/New_York)
const TOMORROW = '2026-10-26';
const DEVICE_NOW = new Date('2026-10-25T14:00:00Z');   // 10:00 in New York; already Oct 26 in Kiritimati

// One My day item, exactly the keys private.my_day_item builds.
const item = (o) => {
  const it = Object.assign({
    kind: 'event', item_id: null, occurrence: TODAY, day: TODAY, end_day: null, title: '', all_day: false,
    start_time: null, end_time: null, time_label: null, location: null, contractor_name: null, contractor_phone: null,
    note: null, who: null, status: 'open', mine: false,
  }, o);
  if (!('end_day' in o)) it.end_day = it.day;
  return it;
};
const task = (o) => item(Object.assign({ kind: 'task', all_day: true, mine: true }, o));

function dayDb() {
  const db = makeDb();
  db.calls = [];
  db.logs = [];
  db.my = {
    [TAYLOR]: {
      person: { name: 'Taylor Example', language: 'en', digest_enabled: true, email_confirmed: false },
      days: [
        [
          task({ item_id: ID.walk, title: 'Walk the dogs', all_day: false, start_time: '08:00', time_label: '8:00am' }),
          item({ item_id: ID.furnace, title: 'Furnace check', start_time: '10:30', end_time: '11:30', time_label: '10:30am', contractor_name: 'Pat Lee', contractor_phone: '(201) 555-0100' }),
          item({ item_id: ID.piano, title: 'Piano pickup', start_time: '16:00', end_time: '17:00', time_label: '4:00pm', location: 'Music school' }),
          item({ item_id: ID.holiday, title: 'School holiday', all_day: true }),
          task({ item_id: ID.feed, title: '<b>Feed</b> & water the cat' }),
          task({ item_id: ID.recycle, title: 'Take out recycling', status: 'done' }),
          task({ item_id: ID.sweep, title: 'Sweep the porch', status: 'skipped' }),
        ],
        [
          item({ item_id: ID.dentist, occurrence: TOMORROW, day: TOMORROW, title: 'Dentist', start_time: '09:00', end_time: '10:00', time_label: '9:00am', location: 'Example Dental', who: 'with Jordan' }),
          item({ item_id: ID.camping, occurrence: TOMORROW, day: TOMORROW, end_day: '2026-10-28', title: 'Camping trip', all_day: true }),
        ],
      ],
      late: [task({ item_id: ID.gutters, occurrence: '2026-10-23', day: '2026-10-23', title: 'Clean the gutters', status: 'late' })],
    },
    [JORDAN]: {
      person: { name: 'Jordan Example', language: 'es', digest_enabled: true, email_confirmed: false },
      days: [
        [
          item({ item_id: ID.jpiano, title: 'Piano', start_time: '16:00', end_time: '17:00', time_label: '16:00', location: 'Escuela de música', who: 'Taylor' }),
          task({ item_id: ID.bed, title: 'Tender la cama' }),
        ],
        [],
      ],
      late: [],
    },
    [MORGAN]: {
      person: { name: 'Morgan Example', language: 'en', digest_enabled: false, email_confirmed: true },
      days: [[], []],
      late: [],
    },
  };
  db.confirmCodes = { [CONFIRM]: TAYLOR };   // the secret in Taylor's confirmation email
  return db;
}

// ---- v1.2: meals and the shopping list. The household's now is Sunday Oct 25, 10:00 in New York.
const P = { alex: 'p-alex', sam: 'p-sam', taylor: 'p-taylor', jordan: 'p-jordan', morgan: 'p-morgan' };
const FOOD_NOW = '2026-10-25T14:00:00Z';
const RECIPE = 'https://cooking.example.com/tacos?serves=4';
// The same people as db.my, as rows: Taylor is the helper (in Spanish unless lang says otherwise).
function foodDb(o) {
  const opts = o || {};
  const lang = opts.lang || 'es';
  const db = dayDb();
  db.my[TAYLOR].person.language = lang;
  db.household = [{ id: true, tz: 'America/New_York' }];
  db.people = [
    { id: P.alex, name: 'Alex Example', role: 'admin', language: 'en', email: 'alex@example.com', day_token: null, active: true },
    { id: P.sam, name: 'Sam Example', role: 'adult', language: 'en', email: 'sam@example.com', day_token: null, active: true },
    { id: P.taylor, name: 'Taylor Example', role: 'helper', language: lang, email: null, day_token: TAYLOR, active: true },
    { id: P.jordan, name: 'Jordan Example', role: 'kid', language: 'es', email: null, day_token: JORDAN, active: true },
    { id: P.morgan, name: 'Morgan Example', role: 'kid', language: 'en', email: null, day_token: MORGAN, active: true },
  ];
  return withFood(db, { now: FOOD_NOW, helperList: opts.helperList || 'add' });
}
// The list: four unlocked lines to buy, one locked; Huevos bought this morning by Alex (Comprado hoy);
// Arroz and Jabón bought lately (Comprar otra vez); Bagels bought too long ago; a locked bought line.
// Times keep their microseconds, as Postgres writes them.
function withList(db) {
  db.shopping_items.push(
    shopItem({ name: 'Cebollas', note: '3', aisle: 'produce', added_at: '2026-10-24T22:15:03.123456+00:00', added_by: P.alex }),
    shopItem({ name: 'Cilantro', aisle: 'produce', added_at: '2026-10-24T22:15:04.000001+00:00', added_by: P.alex }),
    shopItem({ name: 'Tortillas', aisle: 'bakery', added_at: '2026-10-24T22:16:00.500000+00:00', added_by: P.sam }),
    shopItem({ name: 'Milk', note: '2', aisle: 'dairy', added_at: '2026-10-25T12:01:02.654321+00:00', added_by: P.alex }),
    shopItem({ name: 'Pregnancy test', aisle: 'personal', private: true, added_at: '2026-10-25T12:30:00.000000+00:00', added_by: P.alex }),
    shopItem({ name: 'Huevos', aisle: 'dairy', added_at: '2026-10-23T12:00:00.000000+00:00', added_by: P.alex, bought_at: '2026-10-25T13:30:00.111111+00:00', bought_by: P.alex }),
    shopItem({ name: 'Arroz', aisle: 'pantry', added_at: '2026-10-20T12:00:00.000000+00:00', added_by: P.alex, bought_at: '2026-10-24T15:00:00.222222+00:00', bought_by: P.alex }),
    shopItem({ name: 'Jabón', aisle: 'household', added_at: '2026-10-18T12:00:00.000000+00:00', added_by: P.sam, bought_at: '2026-10-20T15:00:00.333333+00:00', bought_by: P.sam }),
    shopItem({ name: 'Bagels', aisle: 'bakery', added_at: '2026-08-30T12:00:00.000000+00:00', added_by: P.sam, bought_at: '2026-09-01T15:00:00.000000+00:00', bought_by: P.sam }),
    shopItem({ name: 'Vitamins', aisle: 'personal', private: true, added_at: '2026-10-24T12:00:00.000000+00:00', added_by: P.alex, bought_at: '2026-10-25T13:00:00.000000+00:00', bought_by: P.alex }),
  );
  return db;
}
const itemOf = (db, name) => db.shopping_items.find((r) => r.name === name);
const hashOf = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const clone = (o) => JSON.parse(JSON.stringify(o));
const fail = (status, code, message, hint) => ({ __status: status, body: { code, message, details: null, hint: hint || null } });
// v1.2's list writes, through foodRpc; db.listError refuses the next one with [status, code, message].
const listWrite = (name) => (db, b) => {
  if (db.listError) { const e = db.listError; db.listError = null; return fail(...e); }
  return foodRpc[name](db, b);
};
const findTask = (who, id) => {
  for (const [w, list] of [['today', who.days[0]], ['tomorrow', who.days[1]], ['late', who.late]]) {
    const i = list.findIndex((x) => x.kind === 'task' && x.item_id === id);
    if (i >= 0) return { where: w, list, i, it: list[i] };
  }
  return null;
};

const FAKES = {
  // With withFood (schema 4): plus each day's meals and, for a helper with the list on, list.
  get_person_day: (db, b) => {
    const who = db.my[b.p_token];
    if (!who) return null;
    const out = clone({ person: who.person, today: TODAY, days: [{ day: TODAY, items: who.days[0] }, { day: TOMORROW, items: who.days[1] }], late: who.late });
    const person = db.shopping_items && (db.people || []).find((p) => p.day_token === b.p_token);
    return person ? personDayFood(db, person, out) : out;
  },
  get_list_by_token: (db, b) => foodRpc.get_list_by_token(db, b),
  add_to_list_by_token: listWrite('add_to_list_by_token'),
  buy_item_by_token: listWrite('buy_item_by_token'),
  complete_by_token: (db, b) => {
    const who = db.my[b.p_token];
    if (!who) return null;
    const f = findTask(who, b.p_task_id);
    if (!f) return fail(403, '42501', "That task isn't on your list.");
    if (db.completeError) return fail(...db.completeError);
    if (db.someoneElseTicked) { f.it.status = 'done'; return fail(400, 'P0001', 'already completed', 'This date was already ticked off or skipped.'); }
    if (f.it.status !== 'open' && f.it.status !== 'late') return fail(400, 'P0001', 'already completed');
    if (b.p_occurrence !== f.it.occurrence) return fail(400, 'P0001', 'already completed');
    const id = crypto.randomUUID();
    db.logs.push({ id, token: b.p_token, task: b.p_task_id, before: clone(f.it), where: f.where, at: f.i });
    // A late task is no longer late once done; a task due today shows as done.
    if (f.where === 'late') f.list.splice(f.i, 1);
    else f.it.status = 'done';
    return id;
  },
  undo_by_token: (db, b) => {
    const who = db.my[b.p_token];
    if (!who) return null;
    if (db.undoError) return fail(...db.undoError);
    const log = db.logs.find((l) => l.id === b.p_log_id && l.token === b.p_token);
    if (!log) return fail(404, 'P0002', "There's nothing to undo.");
    db.logs = db.logs.filter((l) => l !== log);
    if (log.where === 'late') who.late.splice(log.at, 0, log.before);
    else findTask(who, log.task).it.status = log.before.status;
    return log.task;
  },
  // confirm_digest(p_confirm): the secret alone. Any other argument (a p_token) names a function that
  // doesn't exist, which PostgREST answers with 404 PGRST202.
  confirm_digest: (db, b) => {
    if (JSON.stringify(Object.keys(b)) !== '["p_confirm"]') {
      return fail(404, 'PGRST202', 'Could not find the function public.confirm_digest(' + Object.keys(b).sort().join(', ') + ') in the schema cache');
    }
    const token = (db.confirmCodes || {})[b.p_confirm];
    const who = token && db.my[token];
    if (!who) return false;
    who.person.email_confirmed = true;
    return true;
  },
  stop_digest: (db, b) => {
    const who = db.my[b.p_token];
    if (!who) return false;
    who.person.digest_enabled = false;
    return true;
  },
};

// The token functions, answered for signed-out callers (mock.js wants a member). Every call is
// recorded in db.calls with its body, Authorization header, and when it came and was answered (ms);
// db.offline drops the connection; db.slow[name] answers that function after so many ms;
// db.status[name] answers it with that HTTP status and no database code (a 503 from the gateway).
async function tokenRpcs(page, db) {
  await page.route((url) => url.host === 'test.supabase.co' && url.pathname.startsWith('/rest/v1/rpc/'), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.slice('/rest/v1/rpc/'.length);
    if (!FAKES[name]) return route.fallback();
    if (db.offline) return route.abort('internetdisconnected');
    const body = JSON.parse(req.postData() || '{}');
    const call = { name, body, method: req.method(), auth: req.headers()['authorization'] || '', at: Date.now(), done: null };
    db.calls.push(call);
    const reply = (status, payload) => { call.done = Date.now(); return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(payload) }); };
    if (db.slow && db.slow[name]) await new Promise((r) => setTimeout(r, db.slow[name]));
    if (db.status && db.status[name]) return reply(db.status[name], { message: 'Service Unavailable' });
    const out = FAKES[name](db, body);
    return out && out.__status ? reply(out.__status, out.body) : reply(200, out === undefined ? null : out);
  });
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  const phone = (ua) => ({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: ua || IPHONE });

  async function open(opts) {
    const db = opts.db || dayDb();
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: 'Pacific/Kiritimati' }, opts.ctx));
    if (opts.signedIn) await signIn(context, 'alex@example.com');
    if (opts.init) await context.addInitScript(opts.init);
    const page = await context.newPage();
    await page.clock.install({ time: DEVICE_NOW });
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await install(page, db, [], { rpc: FAKES });
    await tokenRpcs(page, db);
    await page.goto(BASE + opts.path);
    await page.waitForSelector('.day-head', { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 5000 });
    await page.waitForTimeout(100);
    return { page, db, context, requests };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.trim()));
  const calls = (db, name) => db.calls.filter((c) => c.name === name);
  const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const size = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  const rowsOf = (page, which) => page.$$eval(`section[aria-labelledby="day-${which}"] .irow`, (rs) => rs.map((r) => {
    const box = r.querySelector('.day-check');
    const call = r.querySelector('.irow-call');
    const small = r.querySelector('.irow-time small');
    return {
      title: r.querySelector('.irow-title').textContent,
      top: r.querySelector('.irow-time span').textContent,
      sub: small ? small.textContent : '',
      details: (r.querySelector('.irow-sub') || { textContent: '' }).textContent,
      box: box ? { checked: box.getAttribute('aria-checked'), disabled: box.disabled, label: box.getAttribute('aria-label') } : null,
      call: call ? { href: call.getAttribute('href'), label: call.getAttribute('aria-label') } : null,
      cls: r.className,
    };
  }));
  const rowByTitle = (page, title) => page.locator('.irow').filter({ has: page.locator('.irow-title', { hasText: title }) });

  // =====================================================================
  // 1. What day.html loads: no hub, no manifest, no sign-in; noindex and no-referrer
  // =====================================================================
  let { page, db, requests } = await open({ label: 'en', path: `/day.html?t=${TAYLOR}`, signedIn: true });
  const head = await page.evaluate(() => ({
    scripts: [...document.querySelectorAll('script[src]')].map((s) => ({ src: s.getAttribute('src'), async: s.async || s.defer })),
    inline: document.querySelectorAll('script:not([src])').length,
    styles: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')),
    manifest: !!document.querySelector('link[rel=manifest]'),
    robots: (document.querySelector('meta[name=robots]') || {}).content,
    referrer: (document.querySelector('meta[name=referrer]') || {}).content,
    hub: typeof window.HomeHub, gantt: typeof window.HomeGantt,
  }));
  const indexCdn = (fs.readFileSync(`${ROOT}/index.html`, 'utf8').match(/https:\/\/cdn\.jsdelivr\.net\/[^"?]*supabase\.js/) || [])[0];
  const order = head.scripts.map((s) => s.src.replace(/\?.*$/, ''));
  // shoplist.js (v1.2: the shopping list's aisles and outbox) and plan.js (v1.3: homework's editor and timer, added on
  // purpose), neither with database calls of its own, come before day.js.
  check('day.html: config.js, then supabase-js (the same pinned URL as index.html), then assets/shoplist.js, assets/plan.js and assets/day.js',
    same(order, ['config.js', indexCdn, 'assets/shoplist.js', 'assets/plan.js', 'assets/day.js']) && /@2\.\d+\.\d+\//.test(indexCdn || ''), order.join(', '));
  check('day.html: no async scripts, no inline script', head.scripts.every((s) => !s.async) && head.inline === 0);
  check('day.html: styles.css, css/day.css, then css/plan.css (v1.3)', same(head.styles.map((h) => h.replace(/\?.*$/, '')), ['assets/styles.css', 'assets/css/day.css', 'assets/css/plan.css']),
    head.styles.join(', '));
  check('day.html: robots noindex,nofollow and referrer no-referrer', /noindex/.test(head.robots || '') && /nofollow/.test(head.robots || '') && head.referrer === 'no-referrer', JSON.stringify(head));
  check('day.html: no manifest link (the hub\'s manifest would install the hub)', !head.manifest);
  check('day.html: the hub and the Gantt engine are not loaded', head.hub === 'undefined' && head.gantt === 'undefined'
    && !requests.some((u) => /hub\.js|gantt\.js|manifest\.webmanifest|assets\/modules\//.test(u)), requests.filter((u) => /assets/.test(u)).join(' | '));
  const fetched = await page.evaluate(async (urls) => Promise.all(urls.map(async (u) => (await fetch(new URL(u, location.href))).status)), head.styles.concat(['assets/shoplist.js', 'assets/plan.js', 'assets/day.js']));
  check('day.html: its stylesheets and scripts exist', fetched.every((s) => s === 200), fetched.join(','));
  check('no sign-in: no Auth requests', !requests.some((u) => u.includes('/auth/v1/')), requests.filter((u) => u.includes('/auth/')).join(' | '));
  const gpd = calls(db, 'get_person_day');
  check('get_person_day is called once, with { p_token } only', gpd.length === 1 && same(gpd[0].body, { p_token: TAYLOR }), JSON.stringify(gpd.map((c) => c.body)));
  check('no sign-in: a hub sign-in in this browser is not used (no user token sent)', gpd.length && !/^Bearer eyJ/.test(gpd[0].auth), gpd[0] && gpd[0].auth.slice(0, 30));
  check('loading changes nothing: no tick, undo, confirm or stop calls', db.calls.every((c) => c.name === 'get_person_day'), db.calls.map((c) => c.name).join(','));

  // =====================================================================
  // 2. English: header, Today, Late, Tomorrow
  // =====================================================================
  check('header: the person\'s first name and the household\'s date (not the device\'s)',
    (await text(page, '.day-head h1')) === 'Hi, Taylor' && (await text(page, '.day-head .meta')) === 'Sunday, October 25'
    && (await page.evaluate(() => new Date().getDate())) === 26, `${await text(page, '.day-head h1')} / ${await text(page, '.day-head .meta')}`);
  check('page language and title follow the person', (await page.evaluate(() => document.documentElement.lang)) === 'en' && (await page.title()) === 'Taylor · My day', await page.title());
  check('sections: Today, Late, Tomorrow in that order, with their dates',
    same(await texts(page, '.day-sec .sec-head > span:first-child'), ['Today', 'Late', 'Tomorrow']) && same(await texts(page, '.day-sec .day-date'), ['Sun Oct 25', 'Mon Oct 26']),
    (await texts(page, '.day-sec .sec-head')).join(' | '));
  let today = await rowsOf(page, 'today');
  check('today: items in the database\'s order', same(today.map((r) => r.title),
    ['Walk the dogs', 'Furnace check', 'Piano pickup', 'School holiday', '<b>Feed</b> & water the cat', 'Take out recycling', 'Sweep the porch']), today.map((r) => r.title).join(' | '));
  check('today: times from the database (start, and end under it for events), All day, Any time',
    same(today.map((r) => [r.top, r.sub]), [['8:00am', ''], ['10:30am', '11:30am'], ['4:00pm', '5:00pm'], ['All day', ''], ['Any time', ''], ['Any time', ''], ['Any time', '']]),
    JSON.stringify(today.map((r) => [r.top, r.sub])));
  check('titles are shown as typed, never as HTML', today[4].title === '<b>Feed</b> & water the cat' && !(await page.$('.irow-title b')));
  check('a big checkbox on their own open tasks only (not on events, done or skipped items)',
    same(today.map((r) => (r.box ? (r.box.disabled ? 'ticked' : 'box') : '-')), ['box', '-', '-', '-', 'box', 'ticked', '-']) && today[0].box.label === 'Done: Walk the dogs' && today[0].box.checked === 'false',
    JSON.stringify(today.map((r) => r.box)));
  check('done tasks are ticked and struck through; skipped ones say so', /st-done/.test(today[5].cls) && today[5].box.checked === 'true' && /st-skipped/.test(today[6].cls) && today[6].details === 'Skipped');
  check('tap to call the linked contact', today[1].call && today[1].call.href === 'tel:2015550100' && today[1].call.label === 'Call Pat Lee (201) 555-0100' && today[1].details === 'Pat Lee', JSON.stringify(today[1]));
  check('the place shows under the title', today[2].details === 'Music school' && !today[2].call);
  const late = await rowsOf(page, 'late');
  check('late: their late task with its due day and a box', late.length === 1 && late[0].title === 'Clean the gutters' && late[0].top === 'Fri Oct 23' && late[0].box && !late[0].box.disabled, JSON.stringify(late));
  const tomorrow = await rowsOf(page, 'tomorrow');
  check('tomorrow: timed event, and a trip over several days as its dates',
    same(tomorrow.map((r) => [r.title, r.top, r.sub]), [['Dentist', '9:00am', '10:00am'], ['Camping trip', 'Oct 26', '– Oct 28']]), JSON.stringify(tomorrow));
  check('who else is on it shows on the second line, before the place ("with Jordan · Example Dental")',
    tomorrow[0].details === 'with Jordan · Example Dental' && tomorrow[1].details === '', JSON.stringify(tomorrow.map((r) => r.details)));
  check('no "Add to Home Screen" hint on a computer', !(await page.$('.day-hint')));
  check('footer: the page is just for them', (await text(page, '.footer')) === "This page is just for you. Please don't share the link.");
  check('nothing else: no sign-in, notes or other pages', !(await page.$('input, textarea, nav, form')));
  await page.screenshot({ path: SHOTS + 'day-desktop.png', fullPage: true });

  // =====================================================================
  // 3. Tick off, Undo
  // =====================================================================
  let loads = calls(db, 'get_person_day').length;
  await rowByTitle(page, 'Walk the dogs').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  const done = calls(db, 'complete_by_token');
  check('tick: complete_by_token with the token, the task and the date shown',
    done.length === 1 && same(done[0].body, { p_token: TAYLOR, p_task_id: ID.walk, p_occurrence: TODAY }), JSON.stringify(done.map((c) => c.body)));
  check('tick: a "Done" toast with Undo and a close button',
    (await text(page, '.toast-action span')) === 'Done: Walk the dogs' && same(await texts(page, '.toast-action button'), ['Undo', '×']), await text(page, '.toast-action'));
  check('tick: the list reloads and shows it done',
    await until(async () => calls(db, 'get_person_day').length === loads + 1 && /st-done/.test((await rowsOf(page, 'today'))[0].cls)),
    JSON.stringify((await rowsOf(page, 'today'))[0]));
  today = await rowsOf(page, 'today');
  check('tick: the box stays ticked and can\'t be tapped again', today[0].box && today[0].box.checked === 'true' && today[0].box.disabled);
  const logId = db.logs[0] && db.logs[0].id;
  loads = calls(db, 'get_person_day').length;
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await until(async () => calls(db, 'undo_by_token').length === 1);
  const undone = calls(db, 'undo_by_token');
  check('Undo: undo_by_token with the token and the log id from the tick', undone.length === 1 && same(undone[0].body, { p_token: TAYLOR, p_log_id: logId }), JSON.stringify(undone.map((c) => c.body)));
  check('Undo: says so, and the task is open again',
    await until(async () => (await text(page, '.toast')) === "Undone. It's back on your list." && !(await page.$('.toast-action'))
      && calls(db, 'get_person_day').length === loads + 1 && /st-open/.test((await rowsOf(page, 'today'))[0].cls) && !(await rowsOf(page, 'today'))[0].box.disabled),
    await text(page, '.toasts'));

  await rowByTitle(page, 'Clean the gutters').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  const lateTick = calls(db, 'complete_by_token').slice(-1)[0];
  check('tick a late task: its own due date is sent', lateTick && same(lateTick.body, { p_token: TAYLOR, p_task_id: ID.gutters, p_occurrence: '2026-10-23' }), JSON.stringify(lateTick && lateTick.body));
  check('tick a late task: the Late section goes away', await until(async () => !(await page.$('section[aria-labelledby="day-late"]'))));
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await until(async () => calls(db, 'complete_by_token').length === 3);
  await page.waitForTimeout(200);
  check('a second tick replaces the first one\'s Undo toast', (await page.$$('.toast-action')).length === 1 && (await text(page, '.toast-action span')) === 'Done: <b>Feed</b> & water the cat');
  await page.click('.toast-action .toast-x');
  check('the close button closes the Undo toast', !(await page.$('.toast-action')));
  await page.context().close();

  // =====================================================================
  // 4. Errors when ticking and undoing
  // =====================================================================
  ({ page, db } = await open({ label: 'tick-errors', path: `/day.html?t=${TAYLOR}`, allowConsole: /status of (400|403|404)|ERR_INTERNET_DISCONNECTED/ }));
  db.someoneElseTicked = true;
  loads = calls(db, 'get_person_day').length;
  await rowByTitle(page, 'Walk the dogs').locator('.day-check').click();
  await page.waitForSelector('.toast-error');
  check('already ticked (another phone): says so and shows the list as it is now',
    (await text(page, '.toast-error')) === 'That was already ticked off. The list is up to date now.'
    && await until(async () => calls(db, 'get_person_day').length === loads + 1 && /st-done/.test((await rowsOf(page, 'today'))[0].cls)), await text(page, '.toast-error'));
  db.someoneElseTicked = false;
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  db.completeError = [403, '42501', "That task isn't on your list."];
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await page.waitForSelector('.toast-error');
  let feed = (await rowsOf(page, 'today'))[4];
  check('not theirs any more: says so and unticks the box', (await text(page, '.toast-error')) === "That task isn't on your list any more."
    && feed.box.checked === 'false' && !feed.box.disabled && !/is-ticked/.test(feed.cls), JSON.stringify(feed));
  db.completeError = [400, '22023', 'This task is paused. Turn it back on before ticking it off.'];
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await page.waitForSelector('.toast-error');
  check('paused task: says so', (await text(page, '.toast-error')) === "That task is paused, so it can't be ticked off right now.");
  db.completeError = null;
  db.offline = true;
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await page.waitForSelector('.toast-error');
  feed = (await rowsOf(page, 'today'))[4];
  check('no connection: says so and unticks the box', (await text(page, '.toast-error')) === "Can't reach Home Hub. Check your internet connection and try again." && feed.box.checked === 'false' && !feed.box.disabled);
  db.offline = false;
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  db.undoError = [400, '22023', "That was more than 15 minutes ago, so it can't be undone here."];
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await page.waitForSelector('.toast-error');
  check('Undo refused (too late): says so in plain words', (await text(page, '.toast-error')) === "That can't be undone here any more. Ask the family to fix it.", await text(page, '.toast-error'));
  await page.context().close();

  // The Undo toast stays for the 15 minutes undo_by_token allows, then goes.
  ({ page, db } = await open({ label: 'undo-15', path: `/day.html?t=${TAYLOR}` }));
  await rowByTitle(page, 'Walk the dogs').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  await page.clock.fastForward('14:00');
  check('Undo toast: still there after 14 minutes', !!(await page.$('.toast-action')));
  await page.clock.fastForward('01:05');
  check('Undo toast: gone after 15 minutes', await until(async () => !(await page.$('.toast-action'))));
  await page.context().close();

  // =====================================================================
  // 5. Refreshes: focus, coming back into view, every 5 minutes; a failed one keeps the list
  // =====================================================================
  ({ page, db } = await open({ label: 'refresh', path: `/day.html?t=${TAYLOR}`, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
  loads = calls(db, 'get_person_day').length;
  await page.waitForTimeout(1100);
  db.my[TAYLOR].days[0].push(task({ item_id: crypto.randomUUID(), title: 'Bring in the mail' }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check('focus: loads again and shows what changed',
    await until(async () => calls(db, 'get_person_day').length === loads + 1 && (await rowsOf(page, 'today')).some((r) => r.title === 'Bring in the mail')));
  await page.waitForTimeout(1100);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  check('coming back into view: loads again', await until(async () => calls(db, 'get_person_day').length === loads + 2));
  await page.clock.fastForward('05:00');
  check('every 5 minutes: loads again', await until(async () => calls(db, 'get_person_day').length === loads + 3), calls(db, 'get_person_day').length - loads);
  db.offline = true;
  await page.clock.fastForward('05:00');
  check('a failed refresh keeps the list and says so',
    await until(async () => (await text(page, '.day-notice')) === "Couldn't refresh just now. Check your internet connection.") && (await rowsOf(page, 'today')).length === 8,
    await text(page, '.day-notice'));
  db.offline = false;
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check('the next refresh clears the notice', await until(async () => !(await page.$('.day-notice'))));
  await page.context().close();

  // =====================================================================
  // 6. Spanish, and a day with nothing planned
  // =====================================================================
  ({ page, db } = await open({ label: 'es', path: `/day.html?t=${JORDAN}` }));
  check('es: header in Spanish', (await text(page, '.day-head h1')) === 'Hola, Jordan' && (await text(page, '.day-head .meta')) === 'Domingo, 25 de octubre' && (await text(page, '.day-head .eyebrow')).toLowerCase() === 'mi día',
    `${await text(page, '.day-head h1')} / ${await text(page, '.day-head .meta')}`);
  check('es: sections Hoy and Mañana with Spanish dates, no Late section',
    same(await texts(page, '.day-sec .sec-head > span:first-child'), ['Hoy', 'Mañana']) && same(await texts(page, '.day-sec .day-date'), ['dom 25 oct', 'lun 26 oct']),
    (await texts(page, '.day-sec .sec-head')).join(' | '));
  const es = await rowsOf(page, 'today');
  check('es: times as the database writes them (24-hour), Sin hora, titles as typed',
    same(es.map((r) => [r.title, r.top, r.sub]), [['Piano', '16:00', '17:00'], ['Tender la cama', 'Sin hora', '']]) && es[1].box.label === 'Hecho: Tender la cama', JSON.stringify(es));
  check('es: empty tomorrow', (await text(page, 'section[aria-labelledby="day-tomorrow"] .empty-line')) === 'Nada planeado para mañana.');
  check('es: a kid sees who takes them ("Taylor · Escuela de música")', es[0].details === 'Taylor · Escuela de música', es[0].details);
  check('es: page language, title and footer', (await page.evaluate(() => document.documentElement.lang)) === 'es' && (await page.title()) === 'Jordan · Mi día'
    && (await text(page, '.footer')) === 'Esta página es solo para ti. Por favor, no compartas el enlace.');
  await rowByTitle(page, 'Tender la cama').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  check('es: tick toast and Undo in Spanish', (await text(page, '.toast-action span')) === 'Hecho: Tender la cama' && (await texts(page, '.toast-action button'))[0] === 'Deshacer'
    && same(calls(db, 'complete_by_token')[0].body, { p_token: JORDAN, p_task_id: ID.bed, p_occurrence: TODAY }));
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  check('es: Undo result in Spanish', await until(async () => (await text(page, '.toast')) === 'Deshecho. Vuelve a estar en tu lista.'));
  await page.screenshot({ path: SHOTS + 'day-es.png', fullPage: true });
  await page.context().close();

  ({ page } = await open({ label: 'empty', path: `/day.html?t=${MORGAN}` }));
  check('nothing planned: both empty states, no Late section',
    same(await texts(page, '.day-sec .empty-line'), ['Nothing planned for today.', 'Nothing planned for tomorrow.']) && !(await page.$('section[aria-labelledby="day-late"]')) && !(await page.$('.irow')));
  await page.context().close();

  // =====================================================================
  // 7. Links that don't work
  // =====================================================================
  ({ page, db } = await open({ label: 'unknown', path: `/day.html?t=${UNKNOWN}` }));
  check('unknown or expired link: "Ask the family for a new link", in both languages',
    (await text(page, '.day-problem p:first-child')) === "This link isn't working. Ask the family for a new link."
    && (await text(page, '.day-problem .day-alt')) === 'Este enlace no funciona. Pide a la familia un enlace nuevo.'
    && !(await page.$('.day-sec')) && same(calls(db, 'get_person_day').map((c) => c.body), [{ p_token: UNKNOWN }]), await text(page, '.day-problem'));
  await page.context().close();
  ({ page, db } = await open({ label: 'malformed', path: '/day.html?t=not-a-real-code' }));
  check('a malformed link: the same message, without asking the database',
    /Ask the family for a new link/.test(await text(page, '.day-problem')) && db.calls.length === 0);
  await page.context().close();
  ({ page, db } = await open({ label: 'no-token', path: '/day.html' }));
  check('no code in the link: says so', (await text(page, '.day-problem p:first-child')) === 'This link is missing its code. Ask the family for a new link.' && db.calls.length === 0);
  await page.context().close();
  ({ page } = await open({ label: 'unknown-es', path: `/day.html?t=${UNKNOWN}`, ctx: { locale: 'es-MX' } }));
  check('unknown link on a Spanish phone: Spanish first', (await text(page, '.day-problem p:first-child')) === 'Este enlace no funciona. Pide a la familia un enlace nuevo.'
    && (await page.$eval('.day-problem p:first-child', (e) => e.lang)) === 'es');
  await page.context().close();
  db = dayDb();
  db.offline = true;
  ({ page } = await open({ label: 'offline', db, path: `/day.html?t=${TAYLOR}`, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
  check('no connection on the first load: says so, with Try again',
    /Can't reach Home Hub/.test(await text(page, '.day-problem')) && !!(await page.$('[data-act="retry"]')), await text(page, '.day-problem'));
  db.offline = false;
  await page.click('[data-act="retry"]');
  check('Try again: the day shows', await until(async () => (await rowsOf(page, 'today')).length === 7));
  await page.context().close();

  // =====================================================================
  // 8. #confirm and #stop: a question and a button; nothing changes on load
  // =====================================================================
  ({ page, db } = await open({ label: 'confirm', path: `/day.html?t=${TAYLOR}&c=${CONFIRM}#confirm` }));
  await page.waitForTimeout(800);
  check('#confirm: asks "Send me the morning email?" with a button', (await text(page, '.day-panel h2')) === 'Send me the morning email?'
    && (await text(page, '[data-act="confirm"]')) === 'Yes, send me the morning email' && !(await page.$('.day-sec')));
  check('#confirm: nothing is confirmed on load (email scanners open links)', calls(db, 'confirm_digest').length === 0 && calls(db, 'stop_digest').length === 0
    && db.my[TAYLOR].person.email_confirmed === false, db.calls.map((c) => c.name).join(','));
  await page.click('[data-act="confirm"]');
  check('#confirm (an older email\'s link, with t= too): the button sends confirm_digest with the code only', await until(async () => calls(db, 'confirm_digest').length === 1)
    && same(calls(db, 'confirm_digest')[0].body, { p_confirm: CONFIRM }), JSON.stringify(calls(db, 'confirm_digest').map((c) => c.body)));
  check('#confirm: says it worked, and the button is gone', await until(async () => (await text(page, '.day-result')) === "You're all set. Your morning email starts with the next one.") && !(await page.$('[data-act="confirm"]')));
  check('#confirm: the code and the hash leave the address', await page.evaluate((t) => location.search === `?t=${t}` && location.hash === '', TAYLOR), await page.evaluate(() => location.href));
  await page.click('.day-link');
  check('#confirm: "See my day" opens the day', await until(async () => (await rowsOf(page, 'today')).length === 7));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-es', path: `/day.html?t=${JORDAN}&c=${'1'.repeat(32)}#confirm` }));
  check('#confirm in Spanish', (await text(page, '.day-panel h2')) === '¿Quieres recibir el correo de la mañana?' && (await text(page, '[data-act="confirm"]')) === 'Sí, quiero el correo de la mañana');
  await page.click('[data-act="confirm"]');
  check('#confirm with a code that doesn\'t match: says what to do', await until(async () => /el correo más reciente de Home Hub/.test(await text(page, '.day-result')))
    && db.my[JORDAN].person.email_confirmed === false && !(await page.$('[data-act="confirm"]')), await text(page, '.day-result'));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-nocode', path: `/day.html?t=${TAYLOR}#confirm` }));
  check('#confirm without the code: says the link is incomplete, no button', /This link is incomplete/.test(await text(page, '.day-panel')) && !(await page.$('[data-act="confirm"]')) && calls(db, 'confirm_digest').length === 0);
  await page.context().close();
  ({ page, db } = await open({ label: 'confirm-already', path: `/day.html?t=${MORGAN}&c=${CONFIRM}#confirm` }));
  check('#confirm when already confirmed: says so, no button', (await text(page, '.day-panel .day-ok')) === 'Your email address is already confirmed.' && !(await page.$('[data-act="confirm"]')));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-offline', path: `/day.html?t=${TAYLOR}&c=${CONFIRM}#confirm`, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
  db.offline = true;
  await page.click('[data-act="confirm"]');
  check('#confirm with no connection: says so, and the button works again', await until(async () => /Can't reach Home Hub/.test(await text(page, '.day-result')))
    && !(await page.$eval('[data-act="confirm"]', (b) => b.disabled)) && (await text(page, '[data-act="confirm"]')) === 'Yes, send me the morning email');
  await page.context().close();

  // ---- The confirmation email's link: day.html?c=<secret>#confirm, with no My day token. The page
  // shows only the question: it knows nobody's day, and loads none.
  ({ page, db } = await open({ label: 'confirm-code-only', path: `/day.html?c=${CONFIRM}#confirm` }));
  await page.waitForTimeout(800);
  check('?c= only: asks "Send me the morning email?" with a button, and shows no day',
    (await text(page, '.day-panel h2')) === 'Send me the morning email?' && (await text(page, '[data-act="confirm"]')) === 'Yes, send me the morning email'
    && !(await page.$('.day-sec')) && !(await page.$('.day-problem')), await text(page, 'main'));
  check('?c= only: no My day is loaded (no get_person_day), nothing confirmed on load', db.calls.length === 0 && db.my[TAYLOR].person.email_confirmed === false, db.calls.map((c) => c.name).join(','));
  check('?c= only: no name, no My day link and no "See my day" (the page doesn\'t know whose it is)',
    !/Taylor/.test(await text(page, 'main')) && !(await page.$('.day-link')) && !(await page.$('a[href*="t="]')), await text(page, 'main'));
  check('?c= only: the page\'s title', (await page.title()) === 'Morning email · Home Hub', await page.title());
  await page.click('[data-act="confirm"]');
  check('?c= only: the button sends confirm_digest({ p_confirm }) and says it worked',
    await until(async () => (await text(page, '.day-result')) === "You're all set. Your morning email starts with the next one.")
    && same(calls(db, 'confirm_digest').map((c) => c.body), [{ p_confirm: CONFIRM }]) && db.my[TAYLOR].person.email_confirmed === true && !(await page.$('[data-act="confirm"]')),
    JSON.stringify(calls(db, 'confirm_digest').map((c) => c.body)));
  check('?c= only: still no other call (no day loaded afterwards)', db.calls.every((c) => c.name === 'confirm_digest'), db.calls.map((c) => c.name).join(','));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-nohash', path: `/day.html?c=${CONFIRM}` }));
  check('?c= without #confirm: the same question (the code means confirm)', (await text(page, '.day-panel h2')) === 'Send me the morning email?' && db.calls.length === 0);
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-wrong', path: `/day.html?c=${'2'.repeat(32)}#confirm` }));
  await page.click('[data-act="confirm"]');
  check('?c= only, a code that doesn\'t match (replaced since): says what to do',
    await until(async () => /open the newest email from Home Hub/.test(await text(page, '.day-result'))) && !(await page.$('[data-act="confirm"]')), await text(page, '.day-result'));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-bad', path: '/day.html?c=not-a-code#confirm' }));
  check('?c= only, a malformed code: "This link is incomplete", no button, nothing asked',
    /This link is incomplete/.test(await text(page, '.day-panel')) && !(await page.$('[data-act="confirm"]')) && db.calls.length === 0, await text(page, 'main'));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-es', path: `/day.html?c=${CONFIRM}#confirm`, ctx: { locale: 'es-MX' } }));
  check('?c= only on a Spanish phone: in Spanish, with a switch to English',
    (await text(page, '.day-panel h2')) === '¿Quieres recibir el correo de la mañana?' && (await page.evaluate(() => document.documentElement.lang)) === 'es'
    && (await text(page, '[data-act="lang"]')) === 'In English', await text(page, 'main'));
  await page.click('[data-act="lang"]');
  check('... the switch shows it in English (and offers Spanish back)', (await text(page, '.day-panel h2')) === 'Send me the morning email?'
    && (await page.evaluate(() => document.documentElement.lang)) === 'en' && (await text(page, '[data-act="lang"]')) === 'En español', await text(page, 'main'));
  await page.click('[data-act="lang"]');
  await page.click('[data-act="confirm"]');
  check('... and confirming answers in the language shown', await until(async () => (await text(page, '.day-result')) === 'Listo. El correo de la mañana empieza con el próximo.'), await text(page, '.day-result'));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-offline', path: `/day.html?c=${CONFIRM}#confirm`, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
  db.offline = true;
  await page.click('[data-act="confirm"]');
  check('?c= only with no connection: says so, and the button works again', await until(async () => /Can't reach Home Hub/.test(await text(page, '.day-result')))
    && !(await page.$eval('[data-act="confirm"]', (b) => b.disabled)));
  db.offline = false;
  await page.click('[data-act="confirm"]');
  check('... and the second try confirms', await until(async () => /You're all set/.test(await text(page, '.day-result'))) && db.my[TAYLOR].person.email_confirmed === true);
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-phone', path: `/day.html?c=${CONFIRM}#confirm`, ctx: phone() }));
  const yesOnly = await size(page, '[data-act="confirm"]');
  const langBtn = await size(page, '[data-act="lang"]');
  check('?c= only on a phone: fits, full-width button, 44px targets, no Home Screen hint',
    await noSideScroll(page) && yesOnly.h >= 44 && yesOnly.w >= 300 && langBtn.h >= 44 && !(await page.$('.day-hint')), JSON.stringify({ yesOnly, langBtn }));
  await page.screenshot({ path: SHOTS + 'day-phone-confirm-code.png' });
  await page.context().close();

  ({ page, db } = await open({ label: 'stop', path: `/day.html?t=${TAYLOR}#stop` }));
  await page.waitForTimeout(800);
  check('#stop: asks "Stop the morning email?" with a button', (await text(page, '.day-panel h2')) === 'Stop the morning email?' && (await text(page, '[data-act="stop"]')) === 'Stop the morning email');
  check('#stop: nothing is stopped on load', calls(db, 'stop_digest').length === 0 && calls(db, 'confirm_digest').length === 0 && db.my[TAYLOR].person.digest_enabled === true);
  await page.click('[data-act="stop"]');
  check('#stop: the button sends stop_digest(token)', await until(async () => calls(db, 'stop_digest').length === 1) && same(calls(db, 'stop_digest')[0].body, { p_token: TAYLOR }));
  check('#stop: says it worked', await until(async () => (await text(page, '.day-result')) === "Stopped. You won't get the morning email any more. Ask the family if you want it back.")
    && db.my[TAYLOR].person.digest_enabled === false && await page.evaluate(() => location.hash === ''));
  await page.context().close();
  ({ page, db } = await open({ label: 'stop-off', path: `/day.html?t=${MORGAN}#stop` }));
  check('#stop when it\'s already off: says so, no button', (await text(page, '.day-panel .day-ok')) === 'The morning email is already off.' && !(await page.$('[data-act="stop"]')));
  await page.context().close();
  ({ page, db } = await open({ label: 'stop-unknown', path: `/day.html?t=${UNKNOWN}#stop` }));
  check('#stop with a link that doesn\'t work: the new-link message, nothing sent', /Ask the family for a new link/.test(await text(page, '.day-problem')) && calls(db, 'stop_digest').length === 0);
  await page.context().close();

  // =====================================================================
  // 8b. Google Calendar events (kind 'google', from migration 0003's person_items): never a box to tick
  // =====================================================================
  db = dayDb();
  db.my[TAYLOR].days[0].push(
    item({ kind: 'google', item_id: crypto.randomUUID(), title: '<img src=x onerror="window.__xss=1">Swim meet', start_time: '11:00', end_time: '12:00', time_label: '11:00am',
      location: 'javascript:alert(1)' }),
    item({ kind: 'google', item_id: crypto.randomUUID(), title: 'Private item', all_day: true }),
  );
  ({ page } = await open({ label: 'google', db, path: `/day.html?t=${TAYLOR}` }));
  const google = (await rowsOf(page, 'today')).filter((r) => /k-google/.test(r.cls));
  check('a Google event: no box to tick, its time and place', same(google.map((r) => [r.title, r.top, r.sub, r.details, r.box]), [
    ['<img src=x onerror="window.__xss=1">Swim meet', '11:00am', '12:00pm', 'javascript:alert(1)', null], ['Private item', 'All day', '', '', null]]), JSON.stringify(google));
  check('a Google event: the hostile title and place are text (no image, no link), nothing runs', !(await page.$('.irow img, .irow-sub a')) && await page.evaluate(() => !window.__xss));
  const dot = await page.$eval('.irow.k-google .irow-title', (t) => { const b = getComputedStyle(t, '::before'); return [b.borderTopStyle, b.borderRadius, b.backgroundColor]; });
  check('a Google event: an outlined dot before its title (day.css)', dot[0] === 'solid' && dot[1] === '50%' && dot[2] === 'rgba(0, 0, 0, 0)', JSON.stringify(dot));
  await page.screenshot({ path: SHOTS + 'day-google.png', fullPage: true });
  await page.context().close();
  ({ page } = await open({ label: 'google-phone', db, path: `/day.html?t=${TAYLOR}`, ctx: Object.assign(phone(), { colorScheme: 'dark' }) }));
  check('a Google event (phone, dark): no sideways scroll; still no box', await noSideScroll(page) && !(await page.$('.irow.k-google .day-check')));
  await page.screenshot({ path: SHOTS + 'day-google-phone-dark.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 9. Phones: 390px wide, 44px targets, the "Add to Home Screen" hint, dark mode
  // =====================================================================
  db = dayDb();
  db.my[TAYLOR].days[0].push(task({ item_id: crypto.randomUUID(), title: 'Pick up the replacement furnace filters from the hardware store before it closes tonight', all_day: false, start_time: '17:30', time_label: '5:30pm' }));
  db.my[TAYLOR].days[0].push(task({ item_id: crypto.randomUUID(), title: 'Supercalifragilisticexpialidociouslylongwordwithoutanyspaces' }));
  ({ page } = await open({ label: 'phone', db, path: `/day.html?t=${TAYLOR}`, ctx: phone() }));
  check('phone: no sideways scroll', await noSideScroll(page), await page.evaluate(() => document.documentElement.scrollWidth));
  const box = await size(page, '.day-check');
  const call = await size(page, '.irow-call');
  check('phone: checkboxes and call buttons are at least 44px', box.w >= 44 && box.h >= 44 && call.w >= 44 && call.h >= 44, JSON.stringify({ box, call }));
  check('phone (iPhone): the "Add to Home Screen" hint', /tap the Share button, then "Add to Home Screen"/.test(await text(page, '.day-hint')), await text(page, '.day-hint'));
  const x = await size(page, '.day-hint-x');
  check('phone: the hint\'s close button is at least 44px', x.w >= 44 && x.h >= 44, JSON.stringify(x));
  await page.screenshot({ path: SHOTS + 'day-phone.png', fullPage: true });
  await rowByTitle(page, 'Walk the dogs').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  const undoBtn = await size(page, '.toast-action .toast-btn');
  check('phone: the Undo toast fits, with 44px buttons', undoBtn.h >= 44 && undoBtn.w >= 44 && await noSideScroll(page)
    && await page.$eval('.toasts', (e) => e.getBoundingClientRect().right <= window.innerWidth), JSON.stringify(undoBtn));
  await page.screenshot({ path: SHOTS + 'day-phone-undo.png' });
  await page.click('.day-hint-x');
  check('hint: closes', !(await page.$('.day-hint')));
  await page.reload();
  await page.waitForSelector('.day-sec');
  check('hint: stays closed on this phone', !(await page.$('.day-hint')));
  await page.context().close();

  ({ page } = await open({ label: 'android', path: `/day.html?t=${TAYLOR}`, ctx: phone(ANDROID) }));
  check('phone (Android): the hint names the ⋮ menu and "Add to Home screen"', /tap the ⋮ menu, then "Add to Home screen"/.test(await text(page, '.day-hint')), await text(page, '.day-hint'));
  await page.context().close();

  ({ page } = await open({ label: 'android-es', path: `/day.html?t=${JORDAN}`, ctx: phone(ANDROID) }));
  check('phone in Spanish: the hint in Spanish', /Agregar a la pantalla principal/.test(await text(page, '.day-hint')));
  await page.context().close();

  // Storage that throws (some private modes): the page still works and the hint still closes.
  ({ page } = await open({ label: 'no-storage', path: `/day.html?t=${TAYLOR}`, ctx: phone(),
    init: () => { const no = () => { throw new Error('storage disabled'); }; Storage.prototype.getItem = no; Storage.prototype.setItem = no; } }));
  check('no storage: the page and the hint still show', (await rowsOf(page, 'today')).length === 7 && !!(await page.$('.day-hint')));
  await page.click('.day-hint-x');
  check('no storage: the hint still closes', !(await page.$('.day-hint')));
  await page.context().close();

  ({ page } = await open({ label: 'phone-confirm', path: `/day.html?t=${TAYLOR}&c=${CONFIRM}#confirm`, ctx: phone() }));
  const yes = await size(page, '[data-act="confirm"]');
  const see = await size(page, '.day-link');
  check('phone #confirm: fits, with a full-width button and 44px targets', await noSideScroll(page) && yes.h >= 44 && yes.w >= 300 && see.h >= 44 && !(await page.$('.day-hint')), JSON.stringify({ yes, see }));
  await page.screenshot({ path: SHOTS + 'day-phone-confirm.png' });
  await page.context().close();

  ({ page } = await open({ label: 'dark', path: `/day.html?t=${TAYLOR}`, ctx: Object.assign(phone(), { colorScheme: 'dark' }) }));
  const colors = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    list: getComputedStyle(document.querySelector('.day-list')).backgroundColor,
    text: getComputedStyle(document.querySelector('.irow-title')).color,
  }));
  check('dark mode: the dark colour tokens', colors.body === 'rgb(18, 17, 16)' && colors.list === 'rgb(27, 25, 23)' && colors.text === 'rgb(243, 239, 233)', JSON.stringify(colors));
  await page.screenshot({ path: SHOTS + 'day-phone-dark.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 10. Meals (v1.2): each day's last rows, in English and Spanish, with no box; the note and the
  //     recipe link only for the person on it; a locked meal's title only for them
  // =====================================================================
  const mealDb = () => {
    const d = foodDb();
    d.meals.push(
      mealRow({ day: TODAY, kind: 'cook', title: 'Tacos', cook_id: P.taylor, note: '<b>350°</b> for 20 min', link: RECIPE, private: true }),
      mealRow({ day: TOMORROW, kind: 'leftovers', cook_id: P.taylor }),
    );
    return d;
  };
  const mealsOf = (pg, which) => pg.$$eval(`section[aria-labelledby="day-${which}"] .irow`, (rs) => rs.map((r) => ({
    meal: r.classList.contains('k-meal'), title: r.querySelector('.irow-title').textContent, top: r.querySelector('.irow-time span').textContent,
    sub: (r.querySelector('.irow-sub') || { textContent: '' }).textContent, box: !!r.querySelector('.day-check, .irow-box'),
    note: (r.querySelector('.meal-note') || { textContent: null }).textContent,
    link: r.querySelector('.meal-recipe') ? { href: r.querySelector('.meal-recipe').getAttribute('href'), target: r.querySelector('.meal-recipe').target,
      rel: r.querySelector('.meal-recipe').rel, text: r.querySelector('.meal-recipe').textContent } : null,
  })));
  db = mealDb();
  ({ page } = await open({ label: 'meals-es', db, path: `/day.html?t=${TAYLOR}`, ctx: phone() }));
  let meals = await mealsOf(page, 'today');
  const tacos = meals[meals.length - 1];
  check('meals (es): the day\'s last row, "Cena", the title she is on even when locked, "Cocinas tú", no box',
    meals.length === 8 && meals.slice(0, 7).every((r) => !r.meal) && tacos.meal && tacos.top === 'Cena' && tacos.title === 'Tacos' && tacos.sub === 'Cocinas tú' && !tacos.box,
    JSON.stringify(tacos));
  check('meals (es): the note for the person on it, as text', tacos.note === '<b>350°</b> for 20 min' && !(await page.$('.k-meal b')), JSON.stringify(tacos.note));
  check('meals (es): a Receta link for the person on it: its host shown, a new tab, no opener, no referrer',
    !!tacos.link && tacos.link.href === RECIPE && tacos.link.target === '_blank' && tacos.link.rel === 'noopener noreferrer' && tacos.link.text === 'Receta · cooking.example.com',
    JSON.stringify(tacos.link));
  meals = await mealsOf(page, 'tomorrow');
  check('meals (es): leftovers she is on: "Sobras", "Te encargas tú", nothing else',
    meals.length === 3 && same(meals[2], { meal: true, title: 'Sobras', top: 'Cena', sub: 'Te encargas tú', box: false, note: null, link: null }), JSON.stringify(meals[2]));
  check('meals (es): no list, so no list button and no list request', !(await page.$('.day-list-btn')) && calls(db, 'get_list_by_token').length === 0);
  check('meals (phone): no sideways scroll; the recipe link is a 44px target', await noSideScroll(page) && (await size(page, '.meal-recipe')).h >= 44);
  await page.screenshot({ path: SHOTS + 'day-meals-es.png', fullPage: true });
  await page.context().close();

  ({ page, db } = await open({ label: 'meals-en', db: mealDb(), path: `/day.html?t=${MORGAN}` }));
  meals = await mealsOf(page, 'today');
  check('meals (en, a kid not on it): "Dinner", "Private item" for a locked one, "Taylor cooks", no note, no link, no box',
    same(meals, [{ meal: true, title: 'Private item', top: 'Dinner', sub: 'Taylor cooks', box: false, note: null, link: null }]), JSON.stringify(meals));
  check('meals (en): a day with only a meal has no "Nothing planned" line',
    !(await page.$('section[aria-labelledby="day-today"] .empty-line')) && same(await mealsOf(page, 'tomorrow'), [{ meal: true, title: 'Leftovers', top: 'Dinner', sub: "Taylor's on dinner", box: false, note: null, link: null }]),
    await text(page, 'section[aria-labelledby="day-today"]'));
  const mealLook = await page.$eval('.irow.k-meal .irow-title', (e) => getComputedStyle(e).fontWeight);
  check('meals (en): a muted look (day.css)', Number(mealLook) < 600, mealLook);
  await page.context().close();
  ({ page, db } = await open({ label: 'meals-kid-es', db: mealDb(), path: `/day.html?t=${JORDAN}` }));
  meals = await mealsOf(page, 'today');
  check('meals (es, a kid not on it): "Asunto privado", "Cocina Taylor", after his items',
    same(meals.map((r) => [r.meal, r.title, r.sub]).slice(-1), [[true, 'Asunto privado', 'Cocina Taylor']]) && meals.length === 3 && meals[2].link === null && meals[2].note === null, JSON.stringify(meals));
  await page.context().close();

  // =====================================================================
  // 11. The list's button and the background read (v1.2): only with get_person_day's list
  // =====================================================================
  db = withList(foodDb());
  db.slow = { get_person_day: 400 };
  ({ page, db } = await open({ label: 'list-button', db, path: `/day.html?t=${TAYLOR}` }));
  check('the list button: under the greeting, "Lista de compras · 4 ›" (her language; unlocked lines only)',
    (await text(page, '.day-head + .day-shop .day-list-btn')) === 'Lista de compras · 4 ›' && (await page.getAttribute('.day-list-btn', 'href')) === '#list',
    await text(page, '.day-shop'));
  check('background read: get_list_by_token({ p_token }) once, after get_person_day was answered (never at the same time)',
    await until(() => calls(db, 'get_list_by_token').length === 1) && same(db.calls.map((c) => c.name), ['get_person_day', 'get_list_by_token'])
    && same(calls(db, 'get_list_by_token')[0].body, { p_token: TAYLOR }) && calls(db, 'get_list_by_token')[0].at >= calls(db, 'get_person_day')[0].done,
    JSON.stringify(db.calls.map((c) => [c.name, c.at, c.done])));
  let saved = null;
  await until(async () => { saved = await page.evaluate(() => localStorage.getItem('homehub.shop.day')); return !!saved && /Cebollas/.test(saved); });
  check('background read: the list is saved on the phone under the token\'s hash, never the token, with nothing locked',
    !!saved && JSON.parse(saved).owner === hashOf(TAYLOR) && !saved.includes(TAYLOR) && !/Pregnancy|Vitamins/.test(saved)
    && same(JSON.parse(saved).snap.items.map((r) => r.name), ['Cebollas', 'Cilantro', 'Milk', 'Tortillas']), String(saved).slice(0, 200));
  db.slow = null;
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(() => calls(db, 'get_person_day').length === 2);
  await page.waitForTimeout(300);
  check('a refresh with the same count: no new list read', calls(db, 'get_list_by_token').length === 1, db.calls.map((c) => c.name).join(','));
  foodRpc.add_to_list(db, { p_name: 'Plátanos' }, 'alex@example.com');
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check('a refresh with a different count: the list is read again, and the button says so',
    await until(async () => calls(db, 'get_list_by_token').length === 2 && (await text(page, '.day-list-btn')) === 'Lista de compras · 5 ›'), await text(page, '.day-list-btn'));
  await page.click('.day-list-btn');
  check('the button opens #list', await until(async () => (await text(page, '.list-head h1')) === 'Lista de compras') && await page.evaluate(() => location.hash === '#list'));
  await page.click('.list-back');
  check('‹ Mi día goes back to the day', await until(async () => !!(await page.$('section[aria-labelledby="day-today"]')) && await page.evaluate(() => location.hash === '')));
  await page.context().close();

  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-kid', db, path: `/day.html?t=${JORDAN}#list` }));
  await page.waitForTimeout(300);
  check('a kid: no list button, no list request, and #list shows the day',
    !(await page.$('.day-list-btn, .list-head')) && !!(await page.$('.day-sec')) && db.calls.every((c) => c.name === 'get_person_day'), db.calls.map((c) => c.name).join(','));
  await page.context().close();

  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-off', db, path: `/day.html?t=${TAYLOR}` }));
  await until(async () => /Cebollas/.test(await page.evaluate(() => localStorage.getItem('homehub.shop.day') || '')));
  db.household[0].helper_list = 'off';
  await page.reload();
  await page.waitForSelector('.day-sec');
  await page.waitForTimeout(300);
  check('the switch Off: no button, no list request, and the list saved for this link is removed',
    !(await page.$('.day-list-btn')) && calls(db, 'get_list_by_token').length === 1 && (await page.evaluate(() => localStorage.getItem('homehub.shop.day'))) === null,
    db.calls.map((c) => c.name).join(','));
  await page.context().close();

  // =====================================================================
  // 12. #list in Spanish at 390px: aisles, big rows, ticks in place, Undo, Comprado hoy, add
  // =====================================================================
  const LIST_ERRORS = /status of (400|401|403|404|409|413|503)|ERR_INTERNET_DISCONNECTED/;
  const listView = (pg) => pg.evaluate(() => {
    const rowsIn = (el) => (el ? [...el.querySelectorAll('.lrow')].map((r) => ({
      name: (r.querySelector('.lrow-name') || {}).textContent, note: (r.querySelector('.lrow-note') || { textContent: '' }).textContent,
      checked: r.getAttribute('aria-checked'), unsent: (r.querySelector('.lrow-unsent') || { textContent: '' }).textContent,
    })) : []);
    const sec = document.querySelector('section.list-sec:not(.list-bought)');
    return {
      aisles: sec ? [...sec.querySelectorAll('h3')].map((h) => h.textContent) : [],
      toBuy: rowsIn(sec),
      boughtHead: (document.querySelector('.list-bought h2') || { textContent: '' }).textContent,
      bought: rowsIn(document.querySelector('.list-bought')),
      empty: (document.querySelector('.list-empty') || { textContent: '' }).textContent,
    };
  });
  const names = (rs) => rs.map((r) => r.name);
  const lrow = (pg, name) => pg.locator('.lrow', { has: pg.locator('.lrow-name', { hasText: new RegExp(`^${name}`) }) });
  const toasts = (pg) => pg.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
  const typeAdd = async (pg, s) => { await pg.fill('.list-input', s); await pg.press('.list-input', 'Enter'); };

  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-es', db, path: `/day.html?t=${TAYLOR}#list`, ctx: phone(), allowConsole: LIST_ERRORS }));
  let lv = await listView(page);
  check('#list (es): heading, back link, page language and title', (await text(page, '.list-head h1')) === 'Lista de compras' && (await text(page, '.list-back')) === '‹ Mi día'
    && (await page.evaluate(() => document.documentElement.lang)) === 'es' && (await page.title()) === 'Lista de compras · Mi día', await page.title());
  check('#list: opened from the link, it reads the list after the day (one request at a time)',
    same(db.calls.map((c) => c.name).slice(0, 2), ['get_person_day', 'get_list_by_token']) && calls(db, 'get_list_by_token').every((c) => same(c.body, { p_token: TAYLOR })),
    db.calls.map((c) => c.name).join(','));
  check('#list: aisle headings in Spanish, in store order, as h3', same(lv.aisles, ['Frutas y verduras', 'Panadería', 'Lácteos y huevos'])
    && (await page.$$eval('section.list-sec:not(.list-bought) .list-aisle', (hs) => hs.every((h) => h.tagName === 'H3'))), JSON.stringify(lv.aisles));
  check('#list: rows A–Z in each aisle, "Milk · leche" (the word in her language), the note small', same(names(lv.toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche'])
    && same(lv.toBuy.map((r) => r.note), ['3', '', '', '2']), JSON.stringify(lv.toBuy));
  const rowLook = await page.$$eval('section.list-sec:not(.list-bought) .lrow', (rs) => rs.map((r) => ({
    tag: r.tagName, role: r.getAttribute('role'), checked: r.getAttribute('aria-checked'), h: r.getBoundingClientRect().height, w: r.getBoundingClientRect().width,
    font: getComputedStyle(r.querySelector('.lrow-name')).fontSize })));
  check('#list: the whole row is the checkbox (role checkbox, aria-checked), at least 56px tall, 18px text',
    rowLook.every((r) => r.tag === 'BUTTON' && r.role === 'checkbox' && r.checked === 'false' && r.h >= 56 && r.w >= 300 && r.font === '18px'), JSON.stringify(rowLook[0]));
  check('#list: Comprado hoy (1): this morning\'s Huevos, ticked; nothing locked, no family names, no ids of people',
    lv.boughtHead === 'Comprado hoy (1)' && same(names(lv.bought), ['Huevos']) && lv.bought[0].checked === 'true'
    && !/Pregnancy|Vitamins|Alex|Sam |p-alex|p-sam/.test(await page.evaluate(() => document.body.innerHTML)), JSON.stringify(lv.bought));
  const addBox = await page.$eval('.list-input', (i) => ({ ph: i.placeholder, max: i.maxLength, font: getComputedStyle(i).fontSize, h: i.getBoundingClientRect().height }));
  check('#list: the add box (she can add): "Añadir algo…", at most 100 characters, 16px text, and "Añadir"',
    same(addBox, { ph: 'Añadir algo…', max: 100, font: '16px', h: addBox.h }) && addBox.h >= 44 && (await text(page, '.list-add-btn')) === 'Añadir', JSON.stringify(addBox));
  check('#list: Comprar otra vez (3) ›, folded away under the add box', (await text(page, '.list-again summary')) === 'Comprar otra vez (3) ›'
    && !(await page.$eval('.list-again', (d) => d.open)) && (await page.$eval('.list-add', (f) => !!(f.nextElementSibling && f.nextElementSibling.querySelector('.list-again')))));
  check('#list (phone): no sideways scroll', await noSideScroll(page));
  await page.screenshot({ path: SHOTS + 'day-list-es.png', fullPage: true });
  // From here the page's clock moves only when the test says, so "3 seconds after the last tap" is exact.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));

  // ---- Tick: where it is, then Comprado hoy 3 seconds after the last tap
  await lrow(page, 'Cebollas').click();
  lv = await listView(page);
  check('tick: the row is checked and struck through where it is', same(names(lv.toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']) && lv.toBuy[0].checked === 'true'
    && (await page.$eval('.lrow[aria-checked="true"] .lrow-name', (e) => getComputedStyle(e).textDecorationLine)) === 'line-through', JSON.stringify(lv.toBuy));
  check('tick: "Comprado: Cebollas" with Deshacer and ×', (await text(page, '.toast-action span')) === 'Comprado: Cebollas' && same(await texts(page, '.toast-action button'), ['Deshacer', '×']));
  await until(() => calls(db, 'buy_item_by_token').length === 1);
  check('tick: buy_item_by_token with the token, the line, true and the seen it was shown with (microseconds kept)',
    same(keyed(calls(db, 'buy_item_by_token')[0].body), { p_token: TAYLOR, p_item: itemOf(db, 'Cebollas').id, p_bought: true, p_seen: '2026-10-24T22:15:03.123456+00:00' }),
    JSON.stringify(calls(db, 'buy_item_by_token')[0].body));
  await lrow(page, 'Cilantro').click();
  lv = await listView(page);
  check('a quick second tap: the next row is ticked too, and nothing has moved', same(names(lv.toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche'])
    && same(lv.toBuy.map((r) => r.checked), ['true', 'true', 'false', 'false']), JSON.stringify(lv.toBuy));
  check('the next tick\'s toast replaces the first one', (await page.$$('.toast-action')).length === 1 && (await text(page, '.toast-action span')) === 'Comprado: Cilantro');
  await page.clock.runFor(2000);
  check('2 seconds after the last tap: still in place', same(names((await listView(page)).toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']));
  await page.clock.runFor(2000);
  lv = await listView(page);
  check('3 seconds after the last tap: both under Comprado hoy, the latest first, and the right ones',
    same(names(lv.toBuy), ['Tortillas', 'Milk · leche']) && same(names(lv.bought), ['Cilantro', 'Cebollas', 'Huevos']) && lv.boughtHead === 'Comprado hoy (3)'
    && itemOf(db, 'Cebollas').bought_by === P.taylor && itemOf(db, 'Cilantro').bought_by === P.taylor && itemOf(db, 'Tortillas').bought_at === null, JSON.stringify(lv));
  check('tick: the toast stays for the 15 minutes Undo works', await page.$eval('.toast-action', () => true).catch(() => false));

  // ---- Deshacer: buy_item_by_token(false) with the seen of her tick
  const cilantroBought = itemOf(db, 'Cilantro').bought_at;
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await until(() => calls(db, 'buy_item_by_token').length === 3);
  check('Deshacer: buy_item_by_token with false and the seen of her tick (from the reply)',
    same(keyed(calls(db, 'buy_item_by_token')[2].body), { p_token: TAYLOR, p_item: itemOf(db, 'Cilantro').id, p_bought: false, p_seen: cilantroBought }), JSON.stringify(calls(db, 'buy_item_by_token')[2].body));
  check('Deshacer: "Deshecho…", and Cilantro is back to buy', await until(async () => (await text(page, '.toast')) === 'Deshecho. Vuelve a estar en tu lista.'
    && same(names((await listView(page)).toBuy), ['Cilantro', 'Tortillas', 'Milk · leche'])), JSON.stringify(await listView(page)));
  await toasts(page);

  // ---- Comprado hoy: her own tick unticks at once; an older one offers "¿Añadir otra vez?"
  const cebollasBought = itemOf(db, 'Cebollas').bought_at;
  await lrow(page, 'Cebollas').click();
  check('tapping her own tick under Comprado hoy: unticked at once, no question, the undone toast',
    (await lrow(page, 'Cebollas').getAttribute('aria-checked')) === 'false' && (await text(page, '.toast')) === 'Deshecho. Vuelve a estar en tu lista.' && !(await page.$('.toast-action')));
  await until(() => calls(db, 'buy_item_by_token').length === 4);
  check('... with buy_item_by_token(false) and its seen', same(keyed(calls(db, 'buy_item_by_token')[3].body), { p_token: TAYLOR, p_item: itemOf(db, 'Cebollas').id, p_bought: false, p_seen: cebollasBought }));
  await page.clock.runFor(3000);
  check('... and it is back to buy once the finger is off the list', same(names((await listView(page)).toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']));
  await toasts(page);
  // ---- One row tapped three times before it moves, each tap answered before the next. Every un-tick
  // gives the line a new seen (§4.2), so a tap on a row already changed here goes by id, with the seen
  // the list has now: no "Cambiado en otro teléfono", and the row ends as tapped.
  const tapAnswered = async (name) => {
    const n = calls(db, 'buy_item_by_token').length;
    await lrow(page, name).click();
    await until(() => calls(db, 'buy_item_by_token').length > n);
    await page.waitForTimeout(250);   // its answer taken
  };
  const tortSeen0 = itemOf(db, 'Tortillas').added_at;
  let taps0 = calls(db, 'buy_item_by_token').length;
  await tapAnswered('Tortillas');   // tick
  const tortBought = itemOf(db, 'Tortillas').bought_at;
  await tapAnswered('Tortillas');   // take it back (an Undo: a new seen)
  const tortSeen1 = itemOf(db, 'Tortillas').added_at;
  await tapAnswered('Tortillas');   // tick again
  let tortCalls = calls(db, 'buy_item_by_token').slice(taps0).map((c) => [c.body.p_bought, c.body.p_seen]);
  check('to buy: tick, take back, tick on one row before it moves: each with the row\'s seen at that moment (the last the new seen of her Undo); bought, nothing else said',
    same(tortCalls, [[true, tortSeen0], [false, tortBought], [true, tortSeen1]]) && tortSeen1 !== tortSeen0 && itemOf(db, 'Tortillas').bought_by === P.taylor
    && (await lrow(page, 'Tortillas').getAttribute('aria-checked')) === 'true' && !(await texts(page, '.toast')).some((x) => x.includes('Cambiado')),
    JSON.stringify([tortCalls, tortSeen0, tortSeen1, await texts(page, '.toast')]));
  await page.clock.runFor(3000);
  await toasts(page);
  taps0 = calls(db, 'buy_item_by_token').length;
  await tapAnswered('Tortillas');   // her tick under Comprado hoy: taken back
  await tapAnswered('Tortillas');   // ticked again
  const tortBought2 = itemOf(db, 'Tortillas').bought_at;
  await tapAnswered('Tortillas');   // taken back again
  tortCalls = calls(db, 'buy_item_by_token').slice(taps0).map((c) => [c.body.p_bought, c.body.p_seen]);
  check('Comprado hoy: take back, tick, take back on her own tick before it moves: the last with the new tick\'s seen; to buy, nothing else said',
    tortCalls.length === 3 && same(tortCalls.map((c) => c[0]), [false, true, false]) && tortCalls[2][1] === tortBought2 && itemOf(db, 'Tortillas').bought_at === null
    && (await lrow(page, 'Tortillas').getAttribute('aria-checked')) === 'false' && !(await texts(page, '.toast')).some((x) => x.includes('Cambiado')),
    JSON.stringify([tortCalls, tortBought2, await texts(page, '.toast')]));
  await page.clock.runFor(3000);
  check('... and 3 seconds later Tortillas is to buy', same(names((await listView(page)).toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']), JSON.stringify(await listView(page)));
  await toasts(page);
  const before = db.calls.length;
  await lrow(page, 'Huevos').click();
  check('a bought line she can\'t undo (Alex\'s): "¿Añadir otra vez?", nothing sent yet',
    (await text(page, '.toast-action span')) === 'Huevos' && (await texts(page, '.toast-action button'))[0] === '¿Añadir otra vez?' && db.calls.length === before);
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await until(() => calls(db, 'add_to_list_by_token').length === 1);
  check('"¿Añadir otra vez?" adds it again by name', same(keyed(calls(db, 'add_to_list_by_token')[0].body), { p_token: TAYLOR, p_name: 'Huevos' }));
  // The answer's toast lasts 3 seconds of the page's clock, so look for it before running the clock on.
  const backToast = await until(async () => (await text(page, '.toast')) === 'Otra vez en la lista');
  const backToastText = await text(page, '.toasts');
  await page.clock.runFor(3000);   // the tap on Huevos was a tap on the list: it moves 3 seconds later
  check('... "Otra vez en la lista", and Huevos is to buy', backToast && await until(async () => names((await listView(page)).toBuy).includes('Huevos')),
    `${backToastText} ${JSON.stringify((await listView(page)).toBuy)}`);
  await toasts(page);

  // ---- The add box: Enter, the reply's words, the box keeps the focus
  await typeAdd(page, 'Leche');
  await until(() => calls(db, 'add_to_list_by_token').length === 2);
  check('add: add_to_list_by_token with the text as typed', same(keyed(calls(db, 'add_to_list_by_token')[1].body), { p_token: TAYLOR, p_name: 'Leche' }));
  check('add "Leche" while Milk is to buy: "Ya está en la lista como Milk"', await until(async () => (await text(page, '.toast')) === 'Ya está en la lista como Milk'), await text(page, '.toasts'));
  check('add: the box is empty and keeps the focus', (await page.$eval('.list-input', (i) => i.value)) === '' && await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('list-input')));
  await toasts(page);
  await typeAdd(page, 'milk');
  check('add "milk": "Ya está en la lista"', await until(async () => (await text(page, '.toast')) === 'Ya está en la lista'), await text(page, '.toasts'));
  await toasts(page);
  await typeAdd(page, '2 tomates');
  check('add "2 tomates": a new line under its aisle, its amount as the note, no toast',
    await until(async () => (await listView(page)).toBuy.some((r) => r.name === 'tomates' && r.note === '2')) && !(await page.$('.toast')), JSON.stringify((await listView(page)).toBuy));

  // ---- Comprar otra vez: by aisle; one tap adds it by name
  await page.click('.list-again summary');
  const again = await page.$$eval('.list-again .list-aisle', (hs) => hs.map((h) => [h.textContent, [...h.nextElementSibling.querySelectorAll('.list-chip')].map((c) => c.textContent)]));
  check('Comprar otra vez: lately bought names by aisle (none locked, none older than 30 days)', same(again, [['Despensa', ['Arroz']], ['Limpieza y hogar', ['Jabón']]]), JSON.stringify(again));
  await page.click('.list-chip[data-key="again|Arroz"]');
  await until(() => calls(db, 'add_to_list_by_token').length === 5);
  check('Comprar otra vez: a tap adds it by name, "Otra vez en la lista"', same(keyed(calls(db, 'add_to_list_by_token')[4].body), { p_token: TAYLOR, p_name: 'Arroz' })
    && await until(async () => (await text(page, '.toast')) === 'Otra vez en la lista'));
  await page.clock.runFor(3000);
  check('Comprar otra vez: stays open, now without Arroz', await until(async () => (await page.$eval('.list-again', (d) => d.open)) && (await text(page, '.list-again summary')) === 'Comprar otra vez (1) ›'));
  await toasts(page);

  // ---- Suggestions as she types (from suggest, in either language), with the amount kept
  await page.fill('.list-input', '2 jab');
  check('suggestions: "2 jab" suggests Jabón', same(await texts(page, '.list-suggest .list-sug'), ['Jabón']), JSON.stringify(await texts(page, '.list-suggest .list-sug')));
  await page.click('.list-sug');
  await until(() => calls(db, 'add_to_list_by_token').length === 6);
  check('suggestions: picking one adds it with the amount typed', same(keyed(calls(db, 'add_to_list_by_token')[5].body), { p_token: TAYLOR, p_name: 'Jabón: 2' })
    && (await page.$eval('.list-input', (i) => i.value)) === '' && await page.$eval('.list-suggest', (e) => e.hidden));
  await page.fill('.list-input', 'zz');
  check('suggestions: none for a name she hasn\'t bought', await page.$eval('.list-suggest', (e) => e.hidden));
  await page.fill('.list-input', '');
  await toasts(page);
  await page.screenshot({ path: SHOTS + 'day-list-es-after.png', fullPage: true });

  // ---- Each new error word in Spanish (not "Esa tarea ya no está en tu lista")
  const refusals = [
    ['an add', [400, '22023', 'Type what to buy.'], 'Escribe qué comprar.'],
    ['an add', [413, '54000', 'The list is full.'], 'La lista está llena.'],
    ['an add', [401, '42501', "The shopping list isn't on your My day."], 'La lista de compras no está en tu Mi día.'],
    ['an add', [401, '42501', "You can't add to the list from My day."], 'La lista de compras no está en tu Mi día.'],
    ['a tick', [401, '42501', 'Only your own tick can be undone, for 15 minutes.'], 'Eso ya no se puede deshacer aquí. Pide a la familia que lo corrija.'],
  ];
  for (const [what, err, words] of refusals) {
    db.listError = err;
    if (what === 'an add') await typeAdd(page, 'Pan dulce');
    else await lrow(page, 'Tortillas').click();
    const shown = await page.waitForSelector('.toast-error', { timeout: 3000 }).then(() => text(page, '.toast-error')).catch(() => '');
    check(`refused (${err[2]}): "${words}"`, shown === words, shown);
    await toasts(page);
    await page.clock.runFor(3000);
  }
  check('a refused change is dropped: no "Pan dulce", Tortillas still to buy', await until(async () => {
    const v = await listView(page);
    return !names(v.toBuy).includes('Pan dulce') && v.toBuy.some((r) => r.name === 'Tortillas' && r.checked === 'false');
  }), JSON.stringify(await listView(page)));
  // The day's caps, as private.count_my_day keeps them: 30 changes and 100 ticks already today.
  const use = db.my_day_use.find((r) => r.person_id === P.taylor && r.day === TODAY);
  if (use) Object.assign(use, { changes: 30, ticks: 100 });
  else db.my_day_use.push({ person_id: P.taylor, day: TODAY, changes: 30, ticks: 100 });
  await typeAdd(page, 'Pan dulce');
  check('the day\'s cap on changes: "Es mucho para un día…"', await page.waitForSelector('.toast-error', { timeout: 3000 }).then(() => text(page, '.toast-error')).catch(() => '')
    .then((s) => s === 'Es mucho para un día. Pide a la familia que añada el resto.'), await text(page, '.toasts'));
  await toasts(page);
  await lrow(page, 'Tortillas').click();
  check('the day\'s cap on ticks: the same words', await page.waitForSelector('.toast-error', { timeout: 3000 }).then(() => text(page, '.toast-error')).catch(() => '')
    .then((s) => s === 'Es mucho para un día. Pide a la familia que añada el resto.'), await text(page, '.toasts'));
  await page.context().close();

  // ---- Deshacer after the row has moved to Comprado hoy, while a tap on the list holds it there: the row
  // is unticked where it is, and a tap on it goes by id, never with the bought_at it was drawn with (the
  // Undo replaced it). Ticked again, then taken back before that answer comes: each with the line's seen
  // at that moment, and Cilantro ends as last tapped, with no "Cambiado en otro teléfono".
  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-undo-moved', db, path: `/day.html?t=${TAYLOR}#list`, ctx: phone(), allowConsole: LIST_ERRORS }));
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  await lrow(page, 'Cebollas').click();
  await lrow(page, 'Cilantro').click();
  await until(() => calls(db, 'buy_item_by_token').length === 2);
  await page.clock.runFor(3100);                                       // both under Comprado hoy
  const movedDay = names((await listView(page)).bought).includes('Cilantro');
  const cilBought = itemOf(db, 'Cilantro').bought_at;
  await lrow(page, 'Cebollas').click();                                // she takes back Cebollas: the list holds
  await until(() => calls(db, 'buy_item_by_token').length === 3);
  await page.click('.toast-action .toast-btn:not(.toast-x)');          // Deshacer on "Comprado: Cilantro"
  await until(() => calls(db, 'buy_item_by_token').length === 4 && itemOf(db, 'Cilantro').bought_at === null);
  await page.waitForTimeout(250);
  const afterDeshacer = await lrow(page, 'Cilantro').getAttribute('aria-checked');
  const cilSeen = itemOf(db, 'Cilantro').added_at;
  const said = [];
  const c0 = calls(db, 'buy_item_by_token').length;
  db.slow = { buy_item_by_token: 1500 };
  await lrow(page, 'Cilantro').click();                                // ticked again
  said.push(...await texts(page, '.toast'));
  await page.waitForTimeout(300);
  await lrow(page, 'Cilantro').click();                                // and taken back, before that answer
  said.push(...await texts(page, '.toast'));
  const shownDay = await lrow(page, 'Cilantro').getAttribute('aria-checked');
  await until(() => calls(db, 'buy_item_by_token').length === c0 + 2 && itemOf(db, 'Cilantro').bought_at === null, 8000);
  await page.waitForTimeout(400);
  said.push(...await texts(page, '.toast'));
  db.slow = null;
  const cilCalls = calls(db, 'buy_item_by_token').slice(c0).map((c) => [c.body.p_bought, c.body.p_seen]);
  check('Deshacer after the row moved to Comprado hoy (the list held): unticked where it is; tapped again it goes by id with the new seen, and tick then take back end as tapped, with no "Cambiado"',
    movedDay && afterDeshacer === 'false' && cilCalls.length === 2 && same(cilCalls[0], [true, cilSeen]) && cilCalls[1][0] === false && cilCalls[1][1] !== cilBought
    && shownDay === 'false' && itemOf(db, 'Cilantro').bought_at === null && !said.some((x) => x.includes('Cambiado')),
    JSON.stringify([movedDay, afterDeshacer, cilCalls, cilBought, cilSeen, shownDay, said]));
  await page.context().close();

  // ---- See and tick: no add box, no Comprar otra vez, an old tick does nothing
  db = withList(foodDb({ helperList: 'see' }));
  ({ page, db } = await open({ label: 'list-see', db, path: `/day.html?t=${TAYLOR}#list`, ctx: phone() }));
  check('See and tick: no add box and no Comprar otra vez', await page.$eval('.list-add', (f) => f.hidden) && !(await page.$('.list-again')) && (await listView(page)).toBuy.length === 4);
  await lrow(page, 'Huevos').click({ force: true });   // aria-disabled: Playwright would wait for it to be enabled
  await page.waitForTimeout(300);
  check('See and tick: tapping a bought line she can\'t undo does nothing', !(await page.$('.toast')) && db.calls.every((c) => c.name !== 'add_to_list_by_token' && c.name !== 'buy_item_by_token')
    && (await lrow(page, 'Huevos').getAttribute('aria-disabled')) === 'true');
  await page.context().close();

  // ---- Empty, English, dark
  db = foodDb({ lang: 'en' });
  db.shopping_items.push(shopItem({ name: 'Huevos', aisle: 'dairy', added_at: '2026-10-23T12:00:00.000000+00:00', bought_at: '2026-10-25T13:30:00.111111+00:00', bought_by: P.alex }));
  ({ page, db } = await open({ label: 'list-en-empty', db, path: `/day.html?t=${TAYLOR}#list`, ctx: Object.assign(phone(), { colorScheme: 'dark' }) }));
  check('#list (en): "Shopping list", "‹ My day", "Nothing to buy", "Bought today (1)", "Add something…"',
    (await text(page, '.list-head h1')) === 'Shopping list' && (await text(page, '.list-back')) === '‹ My day' && (await listView(page)).empty === 'Nothing to buy'
    && (await listView(page)).boughtHead === 'Bought today (1)' && (await page.getAttribute('.list-input', 'placeholder')) === 'Add something…');
  check('#list (phone, dark): no sideways scroll; the rows on the dark surface', await noSideScroll(page)
    && (await page.$eval('.list-rows', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(27, 25, 23)');
  await page.screenshot({ path: SHOTS + 'day-list-en-dark.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 13. Reading the list again: every 10 seconds, only on #list, only while visible; a change waits
  //     for the finger; no redraw when nothing changed
  // =====================================================================
  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-poll', db, path: `/day.html?t=${TAYLOR}`, allowConsole: LIST_ERRORS }));
  await until(() => calls(db, 'get_list_by_token').length === 1);
  const pageNow = () => page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date((await pageNow()) + 1000));
  const reads = () => calls(db, 'get_list_by_token').length;
  const settle = async (n) => { await until(() => reads() === n); await page.waitForTimeout(150); };
  await page.clock.runFor(30000);
  await page.waitForTimeout(200);
  check('the day view: no 10-second read', reads() === 1, reads());
  await page.click('.day-list-btn');
  await settle(2);
  check('#list: read at once on opening', reads() === 2);
  await page.clock.runFor(10000);
  await settle(3);
  check('#list: read again after 10 seconds', reads() === 3, reads());
  await page.$eval('section.list-sec .lrow', (r) => { r.dataset.mark = 'same'; });
  await page.clock.runFor(10000);
  await settle(4);
  check('no redraw when the answer is the same (as_of aside)', (await page.$eval('section.list-sec .lrow', (r) => r.dataset.mark || '')) === 'same');
  foodRpc.add_to_list(db, { p_name: 'Plátanos' }, 'alex@example.com');
  db.foodNow += 60e3;
  await page.clock.runFor(10000);
  await settle(5);
  check('a line added on another phone shows within 10 seconds', await until(async () => names((await listView(page)).toBuy).includes('Plátanos')), JSON.stringify(names((await listView(page)).toBuy)));
  // A tap just before a read: the read's change waits until 3 seconds after the tap.
  await page.clock.runFor(9500);
  await lrow(page, 'Tortillas').click();
  await until(() => calls(db, 'buy_item_by_token').length === 1);
  await page.waitForTimeout(200);   // its answer is in
  foodRpc.add_to_list(db, { p_name: 'Café' }, 'alex@example.com');
  await page.clock.runFor(600);
  await settle(6);
  lv = await listView(page);
  check('held: a read right after a tap moves nothing (no new line, the tick still in place)', !names(lv.toBuy).includes('Café') && lv.toBuy.some((r) => r.name === 'Tortillas' && r.checked === 'true'), JSON.stringify(names(lv.toBuy)));
  await page.clock.runFor(3000);
  lv = await listView(page);
  check('... and 3 seconds after the tap the list moves', names(lv.toBuy).includes('Café') && names(lv.bought).includes('Tortillas'), JSON.stringify(lv));
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenAt = reads();
  await page.clock.runFor(60000);
  await page.waitForTimeout(200);
  check('hidden: no reads', reads() === hiddenAt, reads() - hiddenAt);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  check('visible again: read at once', await until(() => reads() === hiddenAt + 1), reads() - hiddenAt);
  await page.click('.list-back');
  await page.waitForSelector('.day-sec');
  const dayAt = reads();
  await page.clock.runFor(60000);
  await page.waitForTimeout(200);
  check('back on the day view: the 10-second read stops', reads() === dayAt, reads() - dayAt);
  await page.context().close();

  // =====================================================================
  // 14. The outbox: no answer, "sin enviar", the banner, a reload, sent once; a 503 retried;
  //     a tick that waited while the line was bought and added again; a null answer
  // =====================================================================
  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-outbox', db, path: `/day.html?t=${TAYLOR}#list`, ctx: phone(), allowConsole: LIST_ERRORS }));
  const tortillasSeen = itemOf(db, 'Tortillas').added_at;
  db.offline = true;
  await lrow(page, 'Tortillas').click();
  await page.clock.fastForward('00:03');
  lv = await listView(page);
  check('no answer: the tick shows, under Comprado hoy, marked "⟳ sin enviar"', await until(async () => {
    lv = await listView(page);
    return lv.bought.some((r) => r.name === 'Tortillas' && r.unsent === '⟳ sin enviar');
  }), JSON.stringify(lv.bought));
  check('no answer: no banner before 15 seconds', !(await page.$('.list-unsent')));
  await page.clock.fastForward('00:15');
  check('after 15 seconds: "1 cambios sin enviar…"', await until(async () => (await text(page, '.list-unsent')) === '1 cambios sin enviar. Se enviarán cuando haya señal; no cierres esta página.'),
    await text(page, '.list-banners'));
  check('nothing reached the database', calls(db, 'buy_item_by_token').length === 0);
  await page.reload();
  await page.waitForSelector('.list-head');
  await page.waitForFunction(() => !document.querySelector('.loading'));
  lv = await listView(page);
  check('a reload with no answer: the saved list, "Sin conexión" with its day (the day itself didn\'t load), the tick still waiting',
    (await text(page, '.list-offline p')) === 'Sin conexión: esta es la lista de las dom 10:00.' && lv.bought.some((r) => r.name === 'Tortillas' && r.unsent === '⟳ sin enviar')
    && !names(lv.toBuy).includes('Tortillas') && (await text(page, '.list-offline .btn')) === 'Intentar de nuevo', `${await text(page, '.list-banners')} ${JSON.stringify(lv.bought)}`);
  db.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  check('back online: the tick is sent once, with the seen it was shown with', await until(() => calls(db, 'buy_item_by_token').length === 1)
    && same(keyed(calls(db, 'buy_item_by_token')[0].body), { p_token: TAYLOR, p_item: itemOf(db, 'Tortillas').id, p_bought: true, p_seen: tortillasSeen }) && itemOf(db, 'Tortillas').bought_by === P.taylor);
  check('back online: the banners and the marks go', await until(async () => !(await page.$('.list-offline, .list-unsent, .lrow-unsent'))), await text(page, '.list-banners'));
  await page.waitForTimeout(500);
  check('... and nothing is sent twice', calls(db, 'buy_item_by_token').length === 1);
  await toasts(page);

  // A 503 is kept and sent again; a tick that waited while Alex bought the line and put it back
  // doesn't buy the new need: "Cambiado en otro teléfono".
  db.status = { buy_item_by_token: 503 };
  await lrow(page, 'Cebollas').click();
  await until(() => calls(db, 'buy_item_by_token').length === 2);
  db.status = null;
  await page.clock.fastForward('00:03');
  check('a 503 is sent again (2 seconds later)', await until(() => calls(db, 'buy_item_by_token').length === 3) && same(calls(db, 'buy_item_by_token')[2].body, calls(db, 'buy_item_by_token')[1].body)
    && itemOf(db, 'Cebollas').bought_by === P.taylor);
  await toasts(page);
  db.offline = true;
  const milkSeen = itemOf(db, 'Milk').added_at;
  await lrow(page, 'Milk').click();
  await page.clock.fastForward('00:03');
  foodRpc.buy_item(db, { p_item: itemOf(db, 'Milk').id, p_bought: true, p_seen: milkSeen }, 'alex@example.com');
  db.foodNow += 20 * 60e3;
  foodRpc.add_to_list(db, { p_name: 'Milk' }, 'alex@example.com');
  db.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  check('a tick that waited while the line was bought and added again: "Cambiado en otro teléfono", and the new need stays to buy',
    await until(async () => (await texts(page, '.toast')).includes('Cambiado en otro teléfono')) && itemOf(db, 'Milk').bought_at === null
    && same(calls(db, 'buy_item_by_token').slice(-1)[0].body.p_seen, milkSeen) && await until(async () => names((await listView(page)).toBuy).includes('Milk · leche')),
    `${await text(page, '.toasts')} ${JSON.stringify(itemOf(db, 'Milk'))}`);

  // Huevos, bought this morning by Alex: "¿Añadir otra vez?" with no signal brings it back, and she
  // ticks it before the add is answered. The tick waits for the add and takes the line's new seen from
  // its answer, so it buys the line; nobody else changed it, so no "Cambiado en otro teléfono".
  await toasts(page);
  db.offline = true;
  await lrow(page, 'Huevos').click();
  await page.click('.toast-action .toast-btn:not(.toast-x)');   // ¿Añadir otra vez?
  await page.clock.fastForward('00:03');
  check('no signal, "¿Añadir otra vez?" on a line bought this morning: it is to buy again at once, with a box, "⟳ sin enviar"',
    await until(async () => (await listView(page)).toBuy.some((r) => r.name === 'Huevos' && r.unsent === '⟳ sin enviar' && r.checked === 'false')),
    JSON.stringify((await listView(page)).toBuy));
  await lrow(page, 'Huevos').click();   // she picks it up
  db.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => itemOf(db, 'Huevos').bought_by === P.taylor);
  await page.waitForTimeout(400);
  check('back online: the add, then her tick with the line\'s new seen from the add\'s answer: Huevos bought by Taylor, no "Cambiado en otro teléfono"',
    itemOf(db, 'Huevos').bought_by === P.taylor && same(keyed(calls(db, 'buy_item_by_token').slice(-1)[0].body), { p_token: TAYLOR, p_item: itemOf(db, 'Huevos').id, p_bought: true, p_seen: itemOf(db, 'Huevos').added_at })
    && itemOf(db, 'Huevos').added_at !== '2026-10-23T12:00:00.000000+00:00' && same(calls(db, 'add_to_list_by_token').map((c) => c.body.p_name), ['Huevos'])
    && !(await texts(page, '.toast')).includes('Cambiado en otro teléfono'), `${await text(page, '.toasts')} ${JSON.stringify(itemOf(db, 'Huevos'))}`);

  // Yogur, bought this morning by Alex: "¿Añadir otra vez?" with no signal brings it back and she ticks
  // it (the tick waits for the add). The add still gets no answer when a read past the household's
  // midnight does (Alex's purchase is yesterday's now, so the list no longer has the line): the waiting
  // add is drawn as a new row. Deshacer takes her tick back (it never left the phone): "Deshecho…", not
  // "Cambiado en otro teléfono"; then the add goes, and nothing is bought.
  await toasts(page);
  db.shopping_items.push(shopItem({ name: 'Yogur', aisle: 'dairy', added_at: '2026-10-23T12:00:00.000000+00:00', added_by: P.alex, bought_at: '2026-10-25T13:31:00.111111+00:00', bought_by: P.alex }));
  await page.clock.fastForward('00:11');
  await until(async () => names((await listView(page)).bought).includes('Yogur'));
  db.offline = true;
  await lrow(page, 'Yogur').click();
  await page.click('.toast-action .toast-btn:not(.toast-x)');   // ¿Añadir otra vez?
  await page.clock.fastForward('00:03');
  await until(async () => (await listView(page)).toBuy.some((r) => r.name === 'Yogur' && r.checked === 'false' && r.unsent === '⟳ sin enviar'));
  await toasts(page);
  await lrow(page, 'Yogur').click();   // she picks it up: the tick waits for the add
  itemOf(db, 'Yogur').bought_at = '2026-10-24T13:31:00.111111+00:00';   // past midnight: yesterday's purchase
  db.offline = false;
  db.status = { add_to_list_by_token: 503 };   // the add still gets no answer; the read does
  const readsDone = () => calls(db, 'get_list_by_token').filter((c) => c.done).length;
  const reads0 = readsDone();
  for (let i = 0; i < 8 && readsDone() === reads0; i++) { await page.clock.fastForward('00:10'); await page.waitForTimeout(200); }
  await page.waitForTimeout(300);
  const yogurDrawn = (await listView(page)).toBuy.filter((r) => r.name === 'Yogur').map((r) => r.checked);
  await page.click('.toast-action .toast-btn:not(.toast-x)');   // Deshacer
  await page.waitForTimeout(300);
  const yogurToasts = await texts(page, '.toast');
  check('Deshacer of a tick waiting for "¿Añadir otra vez?", after a read past midnight drew that add as a new row: "Deshecho…", not "Cambiado en otro teléfono"',
    readsDone() > reads0 && yogurDrawn.length === 1 && yogurToasts.includes('Deshecho. Vuelve a estar en tu lista.') && !yogurToasts.includes('Cambiado en otro teléfono'),
    JSON.stringify([yogurDrawn, yogurToasts]));
  db.status = null;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => itemOf(db, 'Yogur').bought_at === null);
  await page.waitForTimeout(400);
  check('... then the add goes, and nothing is bought', itemOf(db, 'Yogur').bought_at === null && calls(db, 'buy_item_by_token').every((c) => c.body.p_item !== itemOf(db, 'Yogur').id),
    JSON.stringify(itemOf(db, 'Yogur')));

  // Cilantro: Alex buys it on his phone before hers reads the list again; her tick finds it already
  // bought ("no change"). It isn't hers to undo: Deshacer, or tapping the row again, sends nothing and
  // says "Cambiado en otro teléfono"; Alex's purchase stays.
  await toasts(page);
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));   // the row stays where it is while the test taps
  foodRpc.buy_item(db, { p_item: itemOf(db, 'Cilantro').id, p_bought: true, p_seen: itemOf(db, 'Cilantro').added_at }, 'alex@example.com');
  const alexBought = itemOf(db, 'Cilantro').bought_at;
  const ticks0 = calls(db, 'buy_item_by_token').length;
  await lrow(page, 'Cilantro').click();
  await until(() => calls(db, 'buy_item_by_token').length === ticks0 + 1 && !!calls(db, 'buy_item_by_token')[ticks0].done);
  await page.waitForTimeout(300);
  await page.click('.toast-action .toast-btn:not(.toast-x)');   // Deshacer
  check('Deshacer after her tick found the line already bought by Alex: nothing is sent, "Cambiado en otro teléfono", and his purchase stays',
    await until(async () => (await texts(page, '.toast')).includes('Cambiado en otro teléfono')) && calls(db, 'buy_item_by_token').length === ticks0 + 1
    && itemOf(db, 'Cilantro').bought_at === alexBought && itemOf(db, 'Cilantro').bought_by === P.alex, `${await text(page, '.toasts')} ${JSON.stringify(calls(db, 'buy_item_by_token').slice(ticks0).map((c) => c.body))}`);
  await toasts(page);
  await lrow(page, 'Cilantro').click();   // the row, still ticked where it is: take it back
  check('… and so does tapping the ticked row again: it stays ticked, nothing is sent',
    await until(async () => (await texts(page, '.toast')).includes('Cambiado en otro teléfono')) && (await lrow(page, 'Cilantro').getAttribute('aria-checked')) === 'true'
    && calls(db, 'buy_item_by_token').length === ticks0 + 1 && itemOf(db, 'Cilantro').bought_by === P.alex, `${await text(page, '.toasts')}`);
  await page.clock.resume();

  // A null answer: the link was replaced. The saved list goes, and the link's screen shows.
  delete db.my[TAYLOR];
  db.people.find((p) => p.id === P.taylor).day_token = 'abcabcabcabcabcabcabcabcabcabcab';
  await page.clock.fastForward('00:10');
  check('a null answer: "Este enlace no funciona…", and the list saved for the link is removed',
    await until(async () => /Este enlace no funciona/.test(await text(page, '.day-problem'))) && (await page.evaluate(() => localStorage.getItem('homehub.shop.day'))) === null,
    await text(page, 'main'));
  await page.context().close();

  // =====================================================================
  // 15. No answer at the start, with a list saved at home: the problem screen opens it, in Spanish,
  //     under "Sin conexión"; ticks there wait and go when there is an answer
  // =====================================================================
  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-saved', db, path: `/day.html?t=${TAYLOR}`, ctx: phone(), allowConsole: LIST_ERRORS }));
  await until(async () => /Cebollas/.test(await page.evaluate(() => localStorage.getItem('homehub.shop.day') || '')));
  db.offline = true;
  await page.reload();
  await page.waitForSelector('.day-problem');
  check('no answer at the start, a list saved: the problem (in her saved language first) with Intentar de nuevo and a Lista de compras button',
    /No se puede conectar con Home Hub/.test(await text(page, '.day-problem p:first-child')) && same(await texts(page, '.day-actions .btn'), ['Intentar de nuevo', 'Lista de compras']),
    `${await text(page, '.day-problem')} | ${await texts(page, '.day-actions .btn')}`);
  await page.click('.day-list-btn');
  await page.waitForSelector('.list-head');
  lv = await listView(page);
  check('... it opens the saved list in Spanish, under "Sin conexión: esta es la lista de las dom 10:00."',
    (await text(page, '.list-offline p')) === 'Sin conexión: esta es la lista de las dom 10:00.' && (await text(page, '.list-head h1')) === 'Lista de compras'
    && same(names(lv.toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']) && same(lv.aisles, ['Frutas y verduras', 'Panadería', 'Lácteos y huevos']), JSON.stringify(lv));
  await page.screenshot({ path: SHOTS + 'day-list-offline.png', fullPage: true });
  // The clock moves only when the test says, so no retry goes before Intentar de nuevo is pressed.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  await lrow(page, 'Cilantro').click();
  await page.clock.runFor(3000);
  check('a tick there waits on the phone', await until(async () => (await listView(page)).bought.some((r) => r.name === 'Cilantro' && r.unsent === '⟳ sin enviar')) && calls(db, 'buy_item_by_token').length === 0);
  await typeAdd(page, 'Limones');
  const waiting = await page.$$eval('.lrow.is-new', (rs) => rs.map((r) => [r.tagName, r.querySelector('.lrow-name').textContent, !!r.querySelector('.irow-box'), (r.querySelector('.lrow-unsent') || {}).textContent]));
  check('an add that waits: a row with no box (it has no id yet), marked "⟳ sin enviar"', same(waiting, [['DIV', 'Limones', false, '⟳ sin enviar']]), JSON.stringify(waiting));
  db.offline = false;
  await page.click('.list-offline .btn');
  check('Intentar de nuevo: the tick and the add are sent, in order, and the list is read again',
    await until(() => calls(db, 'buy_item_by_token').length === 1 && itemOf(db, 'Cilantro').bought_by === P.taylor && calls(db, 'add_to_list_by_token').length === 1)
    && same(db.calls.filter((c) => /^(buy_item|add_to)/.test(c.name)).map((c) => c.name), ['buy_item_by_token', 'add_to_list_by_token'])
    && await until(async () => !(await page.$('.list-offline, .lrow-unsent, .lrow.is-new')) && (await listView(page)).toBuy.some((r) => r.name === 'Limones')), await text(page, '.list-banners'));
  await page.click('.list-back');
  check('‹ Mi día: the day loads now', await until(async () => (await text(page, '.day-head h1')) === 'Hola, Taylor' && !!(await page.$('.day-list-btn'))), await text(page, 'main'));
  check('the list stays saved for this link', /Limones/.test(await page.evaluate(() => localStorage.getItem('homehub.shop.day') || '')));
  await page.goto(`${BASE}/day.html?t=${JORDAN}`);
  await page.waitForSelector('.day-sec');
  check('another link on the same phone: the list saved for Taylor\'s link is removed unread', (await page.evaluate(() => localStorage.getItem('homehub.shop.day'))) === null);
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
