// Browser tests for the family board (board.html?b=<code>, docs/v2-design.md §25), the public page for a screen on the
// wall: what it loads (config.js, supabase-js and board.js only, no hub, noindex and no-referrer), the date and clock from
// the server in the household's zone (the device is in Kiritimati on another day), the Family column and a column per
// person, private items, late tasks, meals, a kid's routine, ticking with Undo, a refused tick, English | Español kept on
// the screen, the minute's refresh, a refresh that fails, the day changing at midnight, night, a hostile title shown as
// text, links that don't work, and a phone's width.
//
// The fake RPCs answer with the shapes in supabase/migrations/0020_family_board.sql (board_by_token,
// board_tick_by_token, board_undo_by_token, board_routine_by_token). Everything is made up.
// Run alone with: node tests/e2e/board.test.js
const { chromium } = require('playwright');
const { makeDb, install } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };

const TOKEN = 'b0a2d000b0a2d000b0a2d000b0a2d000';
const TODAY = '2026-11-03';                                // a Tuesday in New York
const SERVER_NOW = Date.parse('2026-11-03T12:05:00Z');      // 7:05am in New York
const DEVICE_NOW = new Date('2026-11-05T01:00:00Z');        // the device: already Nov 5 in Kiritimati, 3pm
const P = { alex: 'p-alex', sam: 'p-sam', taylor: 'p-taylor', morgan: 'p-morgan' };
const PRIVATE = { en: 'Private item', es: 'Asunto privado' };
const MEAL = { en: { lunch: 'Lunch', dinner: 'Dinner' }, es: { lunch: 'Almuerzo', dinner: 'Cena' } };

function boardDb() {
  const db = makeDb();
  Object.assign(db, {
    token: TOKEN, today: TODAY, now: SERVER_NOW, tz: 'America/New_York', calls: [], logs: [], ticks: new Set(),
    people: [
      { id: P.alex, name: 'Alex', color: '#2563eb', role: 'parent' },
      { id: P.sam, name: 'Sam', color: '#db2777', role: 'adult' },
      { id: P.taylor, name: 'Taylor', color: '#16a34a', role: 'kid' },
      { id: P.morgan, name: 'Morgan', color: '#ca8a04', role: 'helper' },
    ],
    items: [
      { col: 'family', kind: 'event', item_id: 'e-dinner', title: 'Dinner at Grandma\'s', time: '18:00' },
      { col: 'family', kind: 'task', item_id: 't-plants', title: 'Water plants', status: 'open' },
      { col: P.alex, kind: 'event', item_id: 'e-doc', title: 'Doctor', time: '10:00', private: true },
      { col: P.taylor, kind: 'google', item_id: 'g-1', title: '<img src=x onerror="window.pwned=1">Team photo', time: '08:00' },
      { col: P.taylor, kind: 'event', item_id: 'e-piano', title: 'Piano', time: '15:00' },
      { col: P.taylor, kind: 'task', item_id: 't-trash', title: 'Take out trash', status: 'open' },
      { col: P.morgan, kind: 'task', item_id: 't-cat', title: 'Feed the cat', status: 'open' },
    ],
    late: [{ col: P.taylor, kind: 'task', item_id: 't-books', occurrence: '2026-11-01', title: 'Return library books', due: { en: 'Nov 1', es: '1 nov' } }],
    routine: { [P.taylor]: [
      { id: 's-m', title: 'Morning', note: 'At home', items: [{ id: 'i-bed', title: 'Make bed' }, { id: 'i-out', title: 'Out of the house', tag: '30 min early' }] },
      { id: 's-b', title: 'Before bed', note: null, items: [{ id: 'i-bag', title: 'Bag packed', part: 'Pack up' }, { id: 'i-lights', title: 'Lights out', part: 'Wind down' }] },
    ] },
    meals: [{ slot: 'lunch', title: 'Surprise', cook: 'Sam', private: true }, { slot: 'dinner', title: 'Tacos', cook: 'Sam' }],
  });
  return db;
}

// The board as board_by_token answers it (private.board_view).
const timeLabel = (hm, lang) => {
  if (!hm) return null;
  const h = Number(hm.slice(0, 2));
  return lang === 'es' ? `${h}:${hm.slice(3)}` : `${h % 12 || 12}:${hm.slice(3)}${h < 12 ? 'am' : 'pm'}`;
};
const order = (x) => (x.time ? 0 : x.kind === 'task' ? 3 : 1);
function boardOf(db, lang) {
  const l = lang === 'es' ? 'es' : 'en';
  const item = (x) => Object.assign({ kind: x.kind, item_id: x.item_id, occurrence: x.occurrence || db.today, title: x.private ? PRIVATE[l] : x.title,
    all_day: !x.time, time_label: timeLabel(x.time, l), status: x.status || 'open', private: !!x.private });
  const items = (col) => db.items.filter((x) => x.col === col)
    .sort((a, b) => order(a) - order(b) || String(a.time || '').localeCompare(String(b.time || '')) || a.title.localeCompare(b.title)).map(item);
  const late = (col) => db.late.filter((x) => x.col === col).map((x) => Object.assign(item(Object.assign({}, x, { status: 'late' })), { due_label: x.due[l] }));
  const routine = (id) => {
    const parts = db.routine[id];
    if (!parts) return {};
    return { routine: { sections: parts.map((s) => ({ id: s.id, title: s.title, note: s.note, done: s.items.filter((i) => db.ticks.has(i.id)).length, total: s.items.length,
      items: s.items.map((i) => ({ id: i.id, title: i.title, tag: i.tag || null, part: i.part || null, done: db.ticks.has(i.id) })) })) } };
  };
  return {
    today: db.today, now: db.now, tz: db.tz, lang: l,
    people: db.people.map((p) => Object.assign({ id: p.id, name: p.name, color: p.color, role: p.role, items: items(p.id), late: late(p.id) }, routine(p.id))),
    family: { items: items('family'), late: late('family') },
    meals: db.meals.map((m) => ({ slot: m.slot, label: MEAL[l][m.slot], title: m.private ? PRIVATE[l] : m.title, cook: m.private ? null : m.cook })),
  };
}
const fail = (status, code, message) => ({ __status: status, body: { code, message, details: null, hint: null } });
const FAKES = {
  board_by_token: (db, b) => (b.p_token === db.token ? boardOf(db, b.p_lang) : null),
  board_tick_by_token: (db, b) => {
    if (b.p_token !== db.token) return null;
    if (db.tickError) { const e = db.tickError; db.tickError = null; return fail(...e); }
    const x = db.items.concat(db.late).find((i) => i.item_id === b.p_task_id && i.kind === 'task');
    if (!x) return fail(403, '42501', 'That isn\'t on the board.');
    if (x.status === 'done') return fail(400, 'P0001', 'already done');
    if (db.late.includes(x)) db.late = db.late.filter((i) => i !== x);
    else x.status = 'done';
    const log = { id: `a0000000-0000-4000-8000-00000000000${db.logs.length + 1}`, x };
    db.logs.push(log);
    return Object.assign(boardOf(db, b.p_lang), { log_id: log.id });
  },
  board_undo_by_token: (db, b) => {
    if (b.p_token !== db.token) return null;
    const log = db.logs.find((g) => g.id === b.p_log_id);
    if (!log) return fail(404, 'P0002', 'There\'s nothing to undo.');
    log.x.status = 'open';
    db.logs = db.logs.filter((g) => g !== log);
    return boardOf(db, b.p_lang);
  },
  board_routine_by_token: (db, b) => {
    if (b.p_token !== db.token) return null;
    if (b.p_done) db.ticks.add(b.p_item); else db.ticks.delete(b.p_item);
    return boardOf(db, b.p_lang);
  },
};

// The board's functions, for a signed-out caller. Every call is recorded in db.calls with its body and Authorization
// header; db.offline drops the connection.
async function boardRpcs(page, db) {
  await page.route((url) => url.host === 'test.supabase.co' && url.pathname.startsWith('/rest/v1/rpc/'), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.slice('/rest/v1/rpc/'.length);
    if (!FAKES[name]) return route.fallback();
    if (db.offline) return route.abort('internetdisconnected');
    const body = JSON.parse(req.postData() || '{}');
    db.calls.push({ name, body, auth: req.headers()['authorization'] || '' });
    const out = FAKES[name](db, body);
    const reply = (status, payload) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return out && out.__status ? reply(out.__status, out.body) : reply(200, out === undefined ? null : out);
  });
}

(async () => {
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];

  async function open(opts) {
    const db = opts.db || boardDb();
    const context = await browser.newContext(Object.assign({ viewport: { width: 1600, height: 900 }, timezoneId: 'Pacific/Kiritimati' }, opts.ctx));
    const page = await context.newPage();
    await page.clock.install({ time: opts.device || DEVICE_NOW });
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    if (opts.init) await context.addInitScript(opts.init);
    await install(page, db, [], { rpc: {} });
    await boardRpcs(page, db);
    await page.goto(BASE + (opts.path || `/board.html?b=${TOKEN}`));
    await page.waitForFunction(() => !document.querySelector('#app > .loading'), null, { timeout: 5000 });
    await page.waitForTimeout(100);
    return { page, db, context, requests };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const calls = (db, name) => db.calls.filter((c) => c.name === name);
  const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); }
  };
  const col = (who) => (who === 'family' ? '.bd-col[data-col="family"]' : `.bd-col[data-person="${who}"]`);

  try {
    // ---- What it loads, the date and clock, the columns
    {
      // A refused tick (400) and the offline read are logged by Chrome as failed loads: expected here.
      const { page, db, context, requests } = await open({ label: 'board', allowConsole: /Failed to load resource/ });
      const scripts = await page.$$eval('script[src]', (es) => es.map((e) => e.getAttribute('src').replace(/\?.*$/, '')));
      check('board.html loads config.js, supabase-js and board.js only (no hub, no My day)',
        same(scripts, ['config.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js', 'assets/board.js'])
        && !requests.some((u) => /assets\/(hub|day|plan|shoplist)\.js|manifest/.test(u)), scripts);
      check('... noindex, nofollow and no-referrer; the title "Family board"',
        await page.$eval('meta[name="robots"]', (e) => e.content) === 'noindex, nofollow' && await page.$eval('meta[name="referrer"]', (e) => e.content) === 'no-referrer'
        && await page.title() === 'Family board');
      const reads = calls(db, 'board_by_token');
      check('board_by_token once, with { p_token, p_lang: "en" }, signed out (the publishable key only)',
        reads.length === 1 && same(reads[0].body, { p_token: TOKEN, p_lang: 'en' }) && !/eyJ/.test(reads[0].auth.replace('Bearer sb_publishable_test', '')), JSON.stringify(reads));
      check('the date is the household\'s ("Tuesday, November 3"), not the device\'s (Nov 5 in Kiritimati)', await text(page, '.bd-date') === 'Tuesday, November 3', await text(page, '.bd-date'));
      check('... and the clock the server\'s, in New York: 7:05am', await text(page, '.bd-clock') === '7:05am', await text(page, '.bd-clock'));
      check('columns: Family first, then each person in order', same(await texts(page, '.bd-name'), ['Family', 'Alex', 'Sam', 'Taylor', 'Morgan']), await texts(page, '.bd-name'));
      check('... each with their colour', await page.$eval(col(P.taylor), (e) => e.style.getPropertyValue('--who').trim()) === '#16a34a');
      check('Family: dinner at Grandma\'s at 6:00pm and the plants to tick', same(await texts(page, `${col('family')} .bd-item`), ['6:00pm Dinner at Grandma\'s', 'Water plants']),
        await texts(page, `${col('family')} .bd-item`));
      check('Taylor: the photo, piano, his trash to tick, and his late books with their due date',
        same(await texts(page, `${col(P.taylor)} .bd-items .bd-item`), ['8:00am <img src=x onerror="window.pwned=1">Team photo', '3:00pm Piano', 'Take out trash', 'Return library books Due Nov 1']),
        await texts(page, `${col(P.taylor)} .bd-items .bd-item`));
      check('... a hostile title shown as text: no image, nothing run', !(await page.$(`${col(P.taylor)} img`)) && !(await page.evaluate(() => window.pwned)));
      check('... "Late" over the late books', await text(page, `${col(P.taylor)} .bd-late-head`) === 'Late');
      check('Alex: his private visit as "Private item", in italics', await text(page, `${col(P.alex)} .bd-item`) === '10:00am Private item'
        && await page.$eval(`${col(P.alex)} .bd-title`, (e) => getComputedStyle(e).fontStyle) === 'italic');
      check('Sam: "Nothing today"', await text(page, `${col(P.sam)} .bd-empty`) === 'Nothing today');
      check('meals: "Lunch: Private item" without who, then "Dinner: Tacos (Sam)"', same(await texts(page, '.bd-meal'), ['Lunch: Private item', 'Dinner: Tacos (Sam)']), await texts(page, '.bd-meal'));
      check('an event is a row with no box; a task a big box to tick (34px, the row at least 52px tall)',
        !(await page.$(`${col(P.taylor)} [data-act="tick"][data-task="e-piano"]`))
        && await page.$eval(`${col(P.taylor)} [data-task="t-trash"]`, (e) => e.getBoundingClientRect().height >= 52 && e.querySelector('.bd-box').getBoundingClientRect().width === 34));
      check('the wall\'s width: the five columns side by side, nothing wider than the page',
        await page.evaluate(() => { const c = [...document.querySelectorAll('.bd-col')].map((e) => e.getBoundingClientRect().top); return new Set(c).size === 1 && document.documentElement.scrollWidth <= innerWidth; }));
      check('day: not dark', !(await page.evaluate(() => document.body.classList.contains('night'))));
      await page.screenshot({ path: SHOTS + 'board-wall.png' });

      // ---- The routine
      check('Taylor\'s routine: "Routine 0 of 4", Morning open and Before bed folded',
        await text(page, `${col(P.taylor)} .bd-rt .bd-sub`) === 'Routine0 of 4'
        && same(await page.$$eval(`${col(P.taylor)} .bd-sec`, (es) => es.map((e) => e.open)), [true, false]), await text(page, `${col(P.taylor)} .bd-rt .bd-sub`));
      check('... its items with their tag; the groups under Before bed', same(await texts(page, `${col(P.taylor)} .bd-sec[open] .bd-rt-item`), ['Make bed', 'Out of the house 30 min early'])
        && same(await texts(page, `${col(P.taylor)} .bd-part`), ['Pack up', 'Wind down']));
      await page.click(`${col(P.taylor)} [data-item="i-bed"]`);
      await until(async () => calls(db, 'board_routine_by_token').length === 1 && (await text(page, `${col(P.taylor)} .bd-rt .bd-count`)) === '1 of 4');
      check('a routine tick: board_routine_by_token with { p_token, p_item, p_done: true, p_lang }, "1 of 4"',
        same(calls(db, 'board_routine_by_token')[0].body, { p_token: TOKEN, p_item: 'i-bed', p_done: true, p_lang: 'en' }) && await text(page, `${col(P.taylor)} .bd-rt .bd-count`) === '1 of 4');
      await page.click(`${col(P.taylor)} [data-item="i-out"]`);
      await until(async () => (await text(page, '.toasts .toast')) === 'Morning done!');
      check('Morning\'s last item: "Morning done!", Morning folds and Before bed opens',
        await text(page, '.toasts .toast') === 'Morning done!' && same(await page.$$eval(`${col(P.taylor)} .bd-sec`, (es) => es.map((e) => e.open)), [false, true])
        && /✓ 2 of 2/.test(await text(page, `${col(P.taylor)} .bd-sec:first-of-type .bd-sec-count`)), await text(page, '.toasts .toast'));
      // A section opened by hand stays open over the minute's refresh.
      await page.click(`${col(P.taylor)} .bd-sec:first-of-type summary`);
      await page.clock.runFor(61 * 1000);
      await until(async () => calls(db, 'board_by_token').length === 2);
      check('the minute\'s refresh reads the board again; a section opened by hand stays open',
        calls(db, 'board_by_token').length === 2 && same(await page.$$eval(`${col(P.taylor)} .bd-sec`, (es) => es.map((e) => e.open)), [true, true]));
      await page.click(`${col(P.taylor)} [data-item="i-out"]`);
      await until(async () => (await text(page, `${col(P.taylor)} .bd-rt .bd-count`)) === '1 of 4');
      check('untick: board_routine_by_token with p_done false, back to "1 of 4"', calls(db, 'board_routine_by_token').slice(-1)[0].body.p_done === false);

      // ---- Ticking a chore, and Undo
      await page.click(`${col(P.taylor)} [data-task="t-trash"]`);
      await until(async () => calls(db, 'board_tick_by_token').length === 1 && /Done: Take out trash/.test(await text(page, '.toasts')));
      check('a chore ticked: board_tick_by_token with { p_token, p_task_id, p_occurrence, p_lang }',
        same(calls(db, 'board_tick_by_token')[0].body, { p_token: TOKEN, p_task_id: 't-trash', p_occurrence: TODAY, p_lang: 'en' }));
      check('... shown done (crossed out, its box ticked), with "Done: Take out trash" and Undo in a toast',
        await page.$eval(`${col(P.taylor)} .bd-items .bd-check.is-done`, (e) => e.getAttribute('aria-checked') === 'true' && /Take out trash/.test(e.textContent)
          && getComputedStyle(e.querySelector('.bd-title')).textDecorationLine === 'line-through')
        && /Undo/.test(await text(page, '.toasts .toast-action')));
      await page.click('.toasts .toast-action .toast-btn:not(.toast-x)');
      await until(async () => calls(db, 'board_undo_by_token').length === 1 && !!(await page.$(`${col(P.taylor)} [data-task="t-trash"]`)));
      check('Undo: board_undo_by_token with the entry, the trash back to tick, "Undone."',
        same(calls(db, 'board_undo_by_token')[0].body, { p_token: TOKEN, p_log_id: 'a0000000-0000-4000-8000-000000000001', p_lang: 'en' })
        && !!(await page.$(`${col(P.taylor)} [data-task="t-trash"]`)) && await until(async () => /Undone/.test(await text(page, '.toasts'))));
      // The late books: off the late list.
      await page.click(`${col(P.taylor)} [data-task="t-books"]`);
      await until(async () => !(await page.$(`${col(P.taylor)} .bd-late-head`)));
      check('the late books ticked (with their own date): off the board, no "Late" any more',
        calls(db, 'board_tick_by_token').slice(-1)[0].body.p_occurrence === '2026-11-01' && !(await page.$(`${col(P.taylor)} .bd-late-head`)));
      // Someone else ticked the cat on their phone: "already done", and the board reads again.
      db.items.find((i) => i.item_id === 't-cat').status = 'done';
      const before = calls(db, 'board_by_token').length;
      await page.click(`${col(P.morgan)} [data-task="t-cat"]`);
      await until(async () => /already ticked off/.test(await text(page, '.toast-error')) && calls(db, 'board_by_token').length > before);
      check('a chore ticked elsewhere first: "That was already ticked off…", and the board reads again, the cat shown done',
        /already ticked off/.test(await text(page, '.toast-error')) && await page.$eval(`${col(P.morgan)} .bd-check`, (e) => e.getAttribute('aria-checked') === 'true'));

      // ---- A refresh that fails keeps the board and says so
      db.offline = true;
      await page.clock.runFor(61 * 1000);
      await until(async () => /Can't reach Home Hub/.test(await text(page, '.bd-notice')));
      check('offline: the board stays, with "Can\'t reach Home Hub. This is the board from 7:08am."',
        /Can't reach Home Hub\. This is the board from 7:0\dam\./.test(await text(page, '.bd-notice')) && (await texts(page, '.bd-name')).length === 5, await text(page, '.bd-notice'));
      db.offline = false;
      await page.clock.runFor(61 * 1000);
      await until(async () => !(await page.$('.bd-notice')));
      check('... back online: the notice goes', !(await page.$('.bd-notice')));

      // ---- English | Español, kept on this screen
      await page.click('[data-act="lang"]');
      await until(async () => (await text(page, '.bd-name')) === 'Familia');
      check('Español: board_by_token with p_lang "es"; "Familia", "Asunto privado", 24-hour times, "Cena", the date in Spanish',
        calls(db, 'board_by_token').slice(-1)[0].body.p_lang === 'es' && await text(page, `${col(P.alex)} .bd-item`) === '10:00 Asunto privado'
        && same(await texts(page, '.bd-meal'), ['Almuerzo: Asunto privado', 'Cena: Tacos (Sam)']) && await text(page, '.bd-date') === 'martes, 3 de noviembre'
        && await text(page, '[data-act="lang"]') === 'English' && await page.evaluate(() => document.documentElement.lang) === 'es', await text(page, '.bd-date'));
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('#app > .loading'), null, { timeout: 5000 });
      check('... kept after a reload (this screen\'s choice)', await text(page, '.bd-name') === 'Familia' && calls(db, 'board_by_token').slice(-1)[0].body.p_lang === 'es');
      await context.close();
    }

    // ---- Midnight: a new day reads the board again; night is dark
    {
      const db = boardDb();
      db.now = Date.parse('2026-11-04T04:59:40Z');   // 11:59:40pm in New York, Nov 3
      const { page, context } = await open({ label: 'board-midnight', db });
      check('at night (11:59pm) the board is dark, whatever the device says', await page.evaluate(() => document.body.classList.contains('night'))
        && await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(18, 17, 16)');
      await page.screenshot({ path: SHOTS + 'board-night.png' });
      const n = calls(db, 'board_by_token').length;
      db.today = '2026-11-04';
      db.now = Date.parse('2026-11-04T05:00:30Z');
      await page.clock.runFor(31 * 1000);
      await until(async () => calls(db, 'board_by_token').length > n && (await text(page, '.bd-date')) === 'Wednesday, November 4');
      check('past midnight in New York the board reads again: "Wednesday, November 4"', await text(page, '.bd-date') === 'Wednesday, November 4', await text(page, '.bd-date'));
      await context.close();
    }

    // ---- Links that don't work
    {
      const { page, db, context } = await open({ label: 'board-gone', path: `/board.html?b=${'f'.repeat(32)}` });
      check('an unknown link: "This board link isn\'t working. Ask a parent for the new one…"', /This board link isn't working\. Ask a parent for the new one/.test(await text(page, '.bd-problem')),
        await text(page, '.bd-problem'));
      check('... and nothing else is asked', db.calls.length === 1);
      await context.close();
    }
    {
      const { page, db, context } = await open({ label: 'board-none', path: '/board.html' });
      check('no code: "This link is missing its code…", and nothing is asked', /missing its code/.test(await text(page, '.bd-problem')) && db.calls.length === 0);
      await context.close();
    }
    {
      const { page, db, context } = await open({ label: 'board-bad', path: '/board.html?b=not-a-code' });
      check('a code that isn\'t one: "isn\'t working", and nothing is asked', /isn't working/.test(await text(page, '.bd-problem')) && db.calls.length === 0);
      await context.close();
    }
    {
      // The link turned off while the board is on the wall: the next read says so.
      const { page, db, context } = await open({ label: 'board-off' });
      db.token = 'c'.repeat(32);
      await page.clock.runFor(61 * 1000);
      await until(async () => /isn't working/.test(await text(page, '.bd-problem')));
      check('the link turned off (or replaced) while on the wall: the next read says it isn\'t working', /isn't working/.test(await text(page, '.bd-problem')));
      await context.close();
    }

    // ---- A phone: one column, nothing wider than the screen
    {
      const { page, context } = await open({ label: 'board-phone', ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
      check('on a phone: one column under the other, nothing wider than the screen',
        await page.evaluate(() => { const c = [...document.querySelectorAll('.bd-col')].map((e) => e.getBoundingClientRect().left); return new Set(c).size === 1 && document.documentElement.scrollWidth <= innerWidth; }));
      await page.screenshot({ path: SHOTS + 'board-phone.png', fullPage: true });
      await context.close();
    }

    check('no page errors or console errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    check(`board tests stopped: ${String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ')}`, false);
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  results.forEach((r) => console.log(r));
  console.log(`== board: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
