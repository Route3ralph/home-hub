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
// mock.js answers RPCs for signed-in members only, so the token functions (called signed out) are
// answered by a route added here; everything else (config.js, supabase-js) comes from mock.js.
// The browser runs in Pacific/Kiritimati (UTC+14) with its clock set so the device's date is a day
// ahead of the household's: anything using the device's date or zone shows the wrong day.
// Run alone with: node tests/e2e/day.test.js
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { makeDb, install, signIn, SUPA } = require('./mock');
const { serve, ROOT } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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

const clone = (o) => JSON.parse(JSON.stringify(o));
const fail = (status, code, message, hint) => ({ __status: status, body: { code, message, details: null, hint: hint || null } });
const findTask = (who, id) => {
  for (const [w, list] of [['today', who.days[0]], ['tomorrow', who.days[1]], ['late', who.late]]) {
    const i = list.findIndex((x) => x.kind === 'task' && x.item_id === id);
    if (i >= 0) return { where: w, list, i, it: list[i] };
  }
  return null;
};

const FAKES = {
  get_person_day: (db, b) => {
    const who = db.my[b.p_token];
    if (!who) return null;
    return clone({ person: who.person, today: TODAY, days: [{ day: TODAY, items: who.days[0] }, { day: TOMORROW, items: who.days[1] }], late: who.late });
  },
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
// recorded in db.calls with its body and Authorization header; db.offline drops the connection.
async function tokenRpcs(page, db) {
  await page.route((url) => url.host === 'test.supabase.co' && url.pathname.startsWith('/rest/v1/rpc/'), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.slice('/rest/v1/rpc/'.length);
    if (!FAKES[name]) return route.fallback();
    if (db.offline) return route.abort('internetdisconnected');
    const body = JSON.parse(req.postData() || '{}');
    db.calls.push({ name, body, method: req.method(), auth: req.headers()['authorization'] || '' });
    const out = FAKES[name](db, body);
    const reply = (status, payload) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
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
  // shoplist.js (v1.2: the shopping list's aisles and outbox, no database calls of its own) comes before day.js.
  check('day.html: config.js, then supabase-js (the same pinned URL as index.html), then assets/shoplist.js and assets/day.js',
    same(order, ['config.js', indexCdn, 'assets/shoplist.js', 'assets/day.js']) && /@2\.\d+\.\d+\//.test(indexCdn || ''), order.join(', '));
  check('day.html: no async scripts, no inline script', head.scripts.every((s) => !s.async) && head.inline === 0);
  check('day.html: styles.css then css/day.css', same(head.styles.map((h) => h.replace(/\?.*$/, '')), ['assets/styles.css', 'assets/css/day.css']), head.styles.join(', '));
  check('day.html: robots noindex,nofollow and referrer no-referrer', /noindex/.test(head.robots || '') && /nofollow/.test(head.robots || '') && head.referrer === 'no-referrer', JSON.stringify(head));
  check('day.html: no manifest link (the hub\'s manifest would install the hub)', !head.manifest);
  check('day.html: the hub and the Gantt engine are not loaded', head.hub === 'undefined' && head.gantt === 'undefined'
    && !requests.some((u) => /hub\.js|gantt\.js|manifest\.webmanifest|assets\/modules\//.test(u)), requests.filter((u) => /assets/.test(u)).join(' | '));
  const fetched = await page.evaluate(async (urls) => Promise.all(urls.map(async (u) => (await fetch(new URL(u, location.href))).status)), head.styles.concat(['assets/shoplist.js', 'assets/day.js']));
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
