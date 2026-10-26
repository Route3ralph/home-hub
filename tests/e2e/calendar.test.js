// Browser tests for the v2 Calendar page (assets/modules/calendar.js): the week agenda and month grid,
// the person filter, event details with one-day changes (change, skip, restore), the event form (also
// opened from the Add sheet), tasks ticked off on the calendar and project tasks as bars.
//
// The fake agenda() works the calendar out from the mock's tables the way the migration does
// (supabase/migrations/0002_home_hub_v2.sql) and answers with its agenda_item rows, column for column;
// complete_task / undo_task / clock / mark_signed_in answer with the migration's shapes too. So a write
// the page makes shows up in what it reads next. The other v2 pages are small stubs, so this file tests
// the calendar alone. The browser runs in Pacific/Honolulu while the household is in America/New_York:
// anything that used the device's time zone would show the wrong time or day.
// Run alone with: node tests/e2e/calendar.test.js
const { chromium } = require('playwright');
const { makeDb, install, signIn, SUPA } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };

// ---- Dates, as whole UTC days (like the page), and America/New_York instants for the fixtures' dates
const dnum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
const diso = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const addDays = (iso, n) => diso(dnum(iso) + n);
const isoDow = (iso) => ((dnum(iso) + 3) % 7 + 7) % 7 + 1;
const mondayOf = (iso) => addDays(iso, 1 - isoDow(iso));
const hms = (t) => (t == null || t === '' ? null : String(t).length === 5 ? `${t}:00` : String(t));
// New York is on daylight time until 2026-11-01 02:00, then standard time (no fixture is near 2am).
const instant = (day, time) => new Date(`${day}T${hms(time)}${day < '2026-11-01' ? '-04:00' : '-05:00'}`).toISOString().replace('.000Z', '+00:00');
const plusHour = (inst) => new Date(new Date(inst).getTime() + 3600e3).toISOString().replace('.000Z', '+00:00');

// ---- Fixtures (fictional people only)
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-10-27'; // a Tuesday
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = { alex: uid(101), sam: uid(102), jordan: uid(103), taylor: uid(104), morgan: uid(105) };
const E = { piano: uid(201), soccer: uid(202), electrician: uid(203), visit: uid(204), pickup: uid(205), movie: uid(206), bake: uid(207) };
const K = { filter: uid(301), pill: uid(302), plumber: uid(303), plants: uid(304) };
const COLORS = { alex: '#2563eb', sam: '#db2777', jordan: '#16a34a', taylor: '#ca8a04', morgan: '#9333ea' };

const person = (key, name, role, sort, extra) => Object.assign({
  id: P[key], name, role, email: null, email_verified_at: null, phone: null, color: COLORS[key], language: 'en',
  day_token: P[key].replace(/-/g, ''), digest_enabled: false, digest_time: null, digest_day: 'today', digest_scope: 'mine',
  sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);
const ev = (id, o) => Object.assign({
  id, title: '', notes: null, location: null, start_date: null, end_date: null, start_time: null, end_time: null, ends_next_day: false,
  responsible_id: null, participant_ids: [], contractor_id: null, private: false, repeat: 'none', repeat_every: 1, repeat_weekdays: [],
  repeat_until: null, skip_days_off: false, created_by: 'alex@example.com', updated_by: 'alex@example.com', created_at: T, updated_at: T,
}, o);
const task = (id, o) => Object.assign({
  id, title: '', notes: null, category: 'other', responsible_id: null, due_date: null, due_time: null, lead_days: 0, project_id: null,
  contractor_id: null, private: false, repeat_mode: 'none', every_count: null, every_unit: null, repeat_weekdays: [], anchor_date: null,
  last_done: null, active: true, done_at: null, done_by: null, created_by: null, updated_by: null, created_at: T, updated_at: T,
}, o);

function calDb() {
  const db = makeDb();
  db.people = [
    person('alex', 'Alex Example', 'parent', 1, { email: 'alex@example.com', email_verified_at: T }),
    person('sam', 'Sam Example', 'adult', 2, { email: 'sam@example.com' }),
    person('jordan', 'Jordan Example', 'kid', 3),
    person('taylor', 'Taylor Example', 'helper', 4, { phone: '(201) 555-0104' }),
    person('morgan', 'Morgan Example', 'kid', 5, { active: false }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: ['2026-10-30'], pets_owner_id: null, house_owner_id: null, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '09:15:00', tz: 'America/New_York' };
  db.events = [
    ev(E.piano, { title: 'Piano', start_date: '2026-09-01', start_time: '16:00:00', end_time: '17:00:00', responsible_id: P.taylor, participant_ids: [P.jordan],
      location: 'Music school', notes: 'Bring the green book', repeat: 'weekly', repeat_weekdays: [2] }),
    ev(E.soccer, { title: 'Soccer', start_date: '2026-10-19', start_time: '17:30:00', end_time: '18:30:00', responsible_id: P.sam, participant_ids: [P.jordan],
      repeat: 'weekly', repeat_every: 2, repeat_weekdays: [1, 3], repeat_until: '2026-12-17' }),
    ev(E.electrician, { title: 'Electrician visit', start_date: '2026-10-29', start_time: '08:00:00', end_time: '12:00:00', responsible_id: P.alex, contractor_id: 'c-pat' }),
    ev(E.visit, { title: 'Grandparents visit', start_date: '2026-10-28', end_date: '2026-10-31', responsible_id: P.sam }),
    ev(E.pickup, { title: 'School pickup', start_date: '2026-09-07', start_time: '15:00:00', responsible_id: P.alex, participant_ids: [P.jordan],
      repeat: 'weekly', repeat_weekdays: [1, 2, 3, 4, 5], skip_days_off: true }),
    ev(E.movie, { title: 'Movie night', start_date: '2026-10-31', start_time: '22:00:00', end_time: '00:30:00', ends_next_day: true, responsible_id: P.sam }),
    ev(E.bake, { title: '<img src=x onerror="window.__xss=1">Bake sale', start_date: '2026-11-01', private: true }),
  ];
  db.event_changes = [
    { event_id: E.pickup, on_date: '2026-10-28', cancelled: false, start_time: '14:00:00', end_time: null, responsible_id: P.sam, participant_ids: null, note: 'Early dismissal' },
  ];
  db.tasks = [
    task(K.filter, { title: 'Change furnace filter', category: 'home', responsible_id: P.alex, due_date: TODAY }),
    task(K.pill, { title: 'Heartworm pill', category: 'pets', responsible_id: P.jordan, due_date: '2026-10-26', repeat_mode: 'schedule', every_count: 1, every_unit: 'month', anchor_date: '2026-09-26' }),
    task(K.plumber, { title: 'Call plumber', responsible_id: P.sam, due_date: '2026-10-28', done_at: '2026-10-25T14:00:00+00:00', done_by: 'sam@example.com', contractor_id: 'c-maria' }),
    task(K.plants, { title: 'Water plants', responsible_id: P.jordan, due_date: '2026-10-29', due_time: '18:00:00' }),
  ];
  db.task_log = [];
  db.projects.forEach((p) => Object.assign(p, { task_dates: [], task_dates_at: T, on_calendar: true, owner_id: null }));
  const kitchen = db.projects.find((p) => p.id === 'p-kitchen');
  kitchen.schedule.trades.tile.contractor_id = 'c-maria';
  Object.assign(kitchen, { owner_id: P.alex, task_dates: [
    { id: 'tile', name: 'Tile backsplash', trade: 'tile', trade_name: 'Tile', start: '2026-10-27', end: '2026-10-30', days: 4, status: null, milestone: false },
    { id: 'final', name: 'Final inspection', trade: 'inspection', trade_name: 'Inspection', start: '2026-11-05', end: '2026-11-05', days: 0, status: null, milestone: true },
  ] });
  return db;
}

// ---- agenda(p_from, p_to): the migration's rules, its agenda_item columns in order
function inWeekly(d, start, weekdays, every) {
  return d >= start && weekdays.map(Number).includes(isoDow(d)) && ((dnum(mondayOf(d)) - dnum(mondayOf(start))) / 7) % every === 0;
}
const contractorOf = (db, id) => db.contractors.find((c) => c.id === id) || null;
function taskItem(db, t, day, status) {
  const k = contractorOf(db, t.contractor_id);
  const p = db.projects.find((x) => x.id === t.project_id);
  return {
    kind: 'task', item_id: t.id, occurrence: day, title: t.title, day, end_day: day, all_day: t.due_time == null,
    start_at: t.due_time ? instant(day, t.due_time) : null, end_at: null, local_start: hms(t.due_time), local_end: null,
    responsible_id: t.responsible_id, participant_ids: [], status, category: t.category, project_id: t.project_id, project_name: p ? p.name : null,
    contractor_id: t.contractor_id, contractor_name: k ? k.name : null, contractor_phone: k ? k.phone : null,
    location: null, notes: t.notes, private: !!t.private, repeating: t.repeat_mode !== 'none', changed: false, lead_days: t.lead_days, milestone: false,
  };
}
function agenda(db, body) {
  const from = body.p_from;
  const to = body.p_to;
  (db.agendaCalls = db.agendaCalls || []).push([from, to]);
  if (!from || !to || to < from || dnum(to) - dnum(from) > 61) return { __status: 400, body: { code: '22023', message: 'agenda() needs a range of 1 to 62 days.', details: null, hint: null } };
  const off = db.household[0].days_off;
  const rows = [];
  db.events.forEach((e) => {
    const days = [];
    if (e.repeat === 'none') { if (e.start_date <= to && (e.end_date || e.start_date) >= from) days.push(e.start_date); }
    else for (let d = e.start_date > from ? e.start_date : from; d <= to && (!e.repeat_until || d <= e.repeat_until); d = addDays(d, 1)) {
      if (inWeekly(d, e.start_date, e.repeat_weekdays, e.repeat_every)) days.push(d);
    }
    days.filter((d) => !(e.skip_days_off && off.includes(d))).forEach((day) => {
      const c = db.event_changes.find((x) => x.event_id === e.id && x.on_date === day);
      const moved = !!(c && (c.start_time || c.end_time));
      const st = hms(moved ? c.start_time || e.start_time : e.start_time);
      const et = hms(moved ? c.end_time : e.end_time);
      const next = moved ? !!(et && et <= st) : !!e.ends_next_day;
      const resp = (c && c.responsible_id) || e.responsible_id || null;
      const parts = (c && c.participant_ids) || e.participant_ids || [];
      const sAt = st ? instant(day, st) : null;
      const eAt = st ? (et ? instant(next ? addDays(day, 1) : day, et) : plusHour(sAt)) : null;
      const k = contractorOf(db, e.contractor_id);
      rows.push({
        kind: 'event', item_id: e.id, occurrence: day, title: e.title, day, end_day: e.end_date || (st && next ? addDays(day, 1) : day),
        all_day: !st, start_at: sAt, end_at: eAt, local_start: st, local_end: st ? et : null,
        responsible_id: resp, participant_ids: parts.filter((x) => x !== resp), status: c && c.cancelled ? 'cancelled' : 'open',
        category: null, project_id: null, project_name: null,
        contractor_id: e.contractor_id || null, contractor_name: k ? k.name : null, contractor_phone: k ? k.phone : null,
        location: e.location || null, notes: [c && c.note, e.notes].filter(Boolean).join('\n\n') || null,
        private: !!e.private, repeating: e.repeat !== 'none', changed: !!c, lead_days: null, milestone: false,
      });
    });
  });
  db.tasks.forEach((t) => {
    const doneOneOff = t.repeat_mode === 'none' && !!t.done_at;
    if (t.due_date && t.due_date >= from && t.due_date <= to && (doneOneOff || t.active)) rows.push(taskItem(db, t, t.due_date, doneOneOff ? 'done' : 'open'));
  });
  db.task_log.forEach((l) => {
    const t = db.tasks.find((x) => x.id === l.task_id);
    if (t && t.repeat_mode !== 'none' && ['done', 'skipped'].includes(l.status) && l.occurrence >= from && l.occurrence <= to) rows.push(taskItem(db, t, l.occurrence, l.status));
  });
  db.projects.filter((p) => p.on_calendar && p.task_dates).forEach((p) => p.task_dates.forEach((x) => {
    if (!(x.start <= to && x.end >= from)) return;
    const trade = (p.schedule.trades || {})[x.trade] || {};
    const k = contractorOf(db, trade.contractor_id);
    rows.push({
      kind: 'project', item_id: p.id, occurrence: x.start, title: x.name, day: x.start, end_day: x.end, all_day: true,
      start_at: null, end_at: null, local_start: null, local_end: null, responsible_id: p.owner_id, participant_ids: [],
      status: x.status === 'done' ? 'done' : 'open', category: null, project_id: p.id, project_name: p.name,
      contractor_id: k ? k.id : null, contractor_name: k ? k.name : null, contractor_phone: k ? k.phone : null,
      location: null, notes: null, private: false, repeating: false, changed: false, lead_days: null, milestone: !!x.milestone,
    });
  }));
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort((a, b) => cmp(a.day, b.day) || (a.local_start == null) - (b.local_start == null) || cmp(a.local_start || '', b.local_start || '')
    || cmp(a.kind, b.kind) || cmp(a.title, b.title));
}

// complete_task / undo_task: the migration's rules for what the page can hit (returns the log id / the task id).
let logSeq = 0;
const raise = (code, message, hint) => ({ __status: 400, body: { code, message, details: null, hint: hint || null } });
function completeTask(db, body, email) {
  const t = db.tasks.find((x) => x.id === body.p_id);
  if (!t) return raise('P0002', 'That task no longer exists.');
  if (t.id === K.plants) return raise('P0001', 'already done', 'Someone already ticked this off.'); // ticked on another phone a moment ago
  const id = uid(900 + (++logSeq));
  if (t.repeat_mode === 'none') {
    if (t.done_at) return raise('P0001', 'already done', 'Someone already ticked this off.');
    db.task_log.push({ id, task_id: t.id, occurrence: t.due_date, status: 'done', done_on: TODAY, done_by: email, prev_done_at: null });
    t.done_at = '2026-10-27T13:15:00+00:00';
  } else {
    if (body.p_occurrence && body.p_occurrence !== t.due_date) return raise('P0001', 'already completed', 'This date was already ticked off or skipped.');
    db.task_log.push({ id, task_id: t.id, occurrence: t.due_date, status: 'done', done_on: TODAY, done_by: email, prev_due: t.due_date, prev_last_done: t.last_done });
    t.last_done = TODAY;
    t.due_date = '2026-11-26';
  }
  return id;
}
function undoTask(db, body) {
  const l = db.task_log.find((x) => x.id === body.p_log_id);
  if (!l) return raise('P0002', "There's nothing to undo.");
  const t = db.tasks.find((x) => x.id === l.task_id);
  if (t.repeat_mode === 'none') t.done_at = l.prev_done_at; else { t.due_date = l.prev_due; t.last_done = l.prev_last_done; }
  db.task_log.splice(db.task_log.indexOf(l), 1);
  return t.id;
}

const calRpc = () => ({
  hub_schema_version: () => 2,
  clock: (db) => Object.assign({}, db.clock),
  mark_signed_in: () => null,
  agenda,
  complete_task: completeTask,
  undo_task: undoTask,
});

// ---- The other v2 pages: stubs with the same register() contract (Tasks offers its form to the Add sheet)
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true } },
  directory: { nav: { label: 'Directory', order: 50 } },
  people: { nav: { label: 'Family', order: 60 } },
  settings: { nav: { label: 'Settings', order: 70 } },
  projects: { nav: { label: 'Projects', order: 40 } }, // v2 mode only: the v1 page stays for the v1 check
};
const stubModule = (name, s) => `;(function () {
  HomeHub.register({
    name: ${JSON.stringify(name)}, schema: { min: 2, max: 99 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { if (${!!s.root} && !parts.length) return {}; return parts[0] === ${JSON.stringify(name)} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">' + ${JSON.stringify(s.nav.label)} + '</h1>'; },
    provides: ${name === 'tasks' ? '{ openTaskForm: function () {} }' : '{}'},
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
    const db = opts.db || calDb();
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 }, timezoneId: 'Pacific/Honolulu', colorScheme: opts.dark ? 'dark' : 'light' },
      opts.phone ? phone : {}));
    await signIn(context, 'alex@example.com');
    if (opts.brokenStorage) {
      // Storage that throws for the calendar's own keys (private browsing, blocked storage); sign-in still works.
      await context.addInitScript(() => {
        const get = Storage.prototype.getItem;
        const set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (k) { if (/^homehub\.calendar/.test(k)) throw new Error('storage blocked'); return get.call(this, k); };
        Storage.prototype.setItem = function (k, v) { if (/^homehub\.calendar/.test(k)) throw new Error('storage blocked'); return set.call(this, k, v); };
      });
    }
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (opts.v1 && /status of 404/.test(m.text()) && /hub_schema_version$/.test(m.location().url || '')) return;
      // A task someone else already ticked off: the fake answers 400, as PostgREST does for a raised error.
      if (opts.allow400 && /status of 400/.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => { (db.confirms = db.confirms || []).push(d.message()); d.accept(); });
    await install(page, db, log, { rpc: opts.v1 ? {} : calRpc() });
    // Record writes to events (and cascade a delete to its one-day changes, as the foreign key does).
    db.eventWrites = [];
    await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/events', async (route) => {
      const req = route.request();
      if (['POST', 'PATCH', 'DELETE'].includes(req.method())) {
        const url = decodeURIComponent(req.url()).replace(SUPA, '');
        db.eventWrites.push({ method: req.method(), url, body: JSON.parse(req.postData() || 'null') });
        const id = (url.match(/id=eq\.([^&]+)/) || [])[1];
        if (req.method() === 'DELETE' && id) db.event_changes.splice(0, db.event_changes.length, ...db.event_changes.filter((c) => c.event_id !== id));
      }
      return route.fallback();
    });
    // event_changes upserts (on_conflict=event_id,on_date, Prefer: resolution=merge-duplicates) merge like PostgREST.
    db.changeWrites = [];
    await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/event_changes', async (route) => {
      const req = route.request();
      if (!['POST', 'PATCH', 'DELETE'].includes(req.method())) return route.fallback();
      const url = new URL(req.url());
      const body = JSON.parse(req.postData() || 'null');
      db.changeWrites.push({ method: req.method(), url: decodeURIComponent(url.pathname + url.search), prefer: req.headers()['prefer'] || '', body });
      if (req.method() !== 'POST' || !url.searchParams.get('on_conflict')) return route.fallback();
      const rows = (Array.isArray(body) ? body : [body]).map((r) => {
        const hit = db.event_changes.find((x) => x.event_id === r.event_id && x.on_date === r.on_date);
        if (hit) return Object.assign(hit, r);
        const row = Object.assign({ cancelled: false, start_time: null, end_time: null, responsible_id: null, participant_ids: null, note: null }, r);
        db.event_changes.push(row);
        return row;
      });
      return route.fulfill({ status: 201, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(rows) });
    });
    if (!opts.v1) {
      await page.route(`${SUPA}/rest/v1/rpc/whoami`, (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const m = db.members.find((x) => x.email === emailOf(req));
        const p = m && db.people.find((x) => x.email === m.email);
        const body = m ? Object.assign({}, m, { person: p ? { id: p.id, name: p.name, role: p.role, language: p.language, color: p.color } : null }) : null;
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      });
    }
    for (const name of Object.keys(STUBS).filter((n) => !(opts.v1 && n === 'projects'))) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule(name, STUBS[name]) }));
    }
    await page.goto(BASE + (opts.path || '/#/calendar'));
    await page.waitForSelector(opts.v1 ? '.tabs a' : '#main .cal-head', { timeout: 8000 });
    await page.waitForTimeout(250);
    return { page, db, log, context };
  }
  const settle = (page, ms) => page.waitForTimeout(ms || 300);
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const lastAgenda = (db) => (db.agendaCalls || [])[db.agendaCalls.length - 1];
  // A list's item rows. Not the jobs listed under a project's "N jobs in progress" line: see underWay().
  const rows = (page, sel) => page.$$eval(`${sel} .irow`, (rs) => rs.filter((r) => !r.closest('.cal-ongoing')).map((r) => ({
    id: r.dataset.id, kind: r.dataset.kind, occ: r.dataset.occurrence, status: r.dataset.status,
    title: (() => { const t = r.querySelector('.irow-title').cloneNode(true); t.querySelectorAll('.irow-rep').forEach((x) => x.remove()); return t.textContent.trim(); })(),
    repeats: !!r.querySelector('.irow-rep'),
    time: r.querySelector('.irow-time').innerText.replace(/\s+/g, ' ').trim(),
    sub: ((r.querySelector('.irow-sub') || {}).textContent || '').trim(),
    who: [...r.querySelectorAll('.irow-who .pdot')].map((d) => d.title),
    call: (r.querySelector('.irow-call') || {}).href || null,
    check: (r.querySelector('.irow-check') || { getAttribute: () => null }).getAttribute('aria-checked'),
    pc: r.style.getPropertyValue('--pc'),
    span: r.classList.contains('cal-span'),
  })));
  const dayRows = (page, day) => rows(page, `[data-list="${day}"]`);
  // A day's own items, without the longer ones (trips, project work) that also show as bars.
  const ownRows = async (page, day) => (await dayRows(page, day)).filter((r) => !r.span);
  // A list's "Kitchen Renovation · 3 jobs in progress" lines: the project, the line, open or not, the jobs
  // it lists (title and dates), whether it comes after every item row, and its height.
  const underWay = (page, sel) => page.$$eval(`${sel} .cal-ongoing`, (ds) => ds.map((d) => ({
    project: d.dataset.project,
    line: d.querySelector('summary').textContent.replace(/\s+/g, ' ').trim(),
    open: d.open,
    // (textContent: a closed line's rows aren't rendered, so they have no innerText)
    jobs: [...d.querySelectorAll('.irow')].map((r) => `${r.querySelector('.irow-title').textContent.trim()} (${[...r.querySelector('.irow-time').children].map((x) => x.textContent.trim()).join(' ')})`),
    last: ![...d.parentElement.children].slice([...d.parentElement.children].indexOf(d)).some((x) => x.classList.contains('irow')),
    h: Math.round(d.querySelector('summary').getBoundingClientRect().height),
  })));
  const toastText = (page) => page.$$eval('.toasts .toast', (ts) => ts.map((t) => t.textContent.trim()).join(' | ')).catch(() => '');
  const smallTargets = (page, sel) => page.$$eval(sel, (els) => els.filter((e) => e.offsetParent !== null).map((e) => {
    const r = e.getBoundingClientRect();
    return { t: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((r) => r.w < 44 || r.h < 44));
  const clickRow = async (page, sel, title) => {
    const btns = await page.$$(`${sel} .irow .irow-main`);
    for (const b of btns) if ((await b.innerText()).includes(title)) { await b.click(); return true; }
    return false;
  };
  const dialogText = (page) => text(page, '#detail .d-inner');
  // The Who line as read: names and "in charge", without the dots' initials and hidden labels.
  const whoLine = (page) => page.$eval('#detail dd.cal-whos', (dd) => {
    const c = dd.cloneNode(true);
    c.querySelectorAll('.pdot').forEach((x) => x.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  }).catch(() => '');

  // =====================================================================
  // 1. v1 mode: the calendar stays hidden
  // =====================================================================
  let { page, db } = await open({ label: 'v1', v1: true, path: '/' });
  check('v1: no Calendar tab, the v1 tabs as before', same(await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent)), ['Home', 'Projects', 'Contractors', 'Family']));
  check('v1: use("calendar") is not available', /isn't available/.test(await page.evaluate(() => { try { HomeHub.core.use('calendar'); return 'available'; } catch (e) { return e.message; } })));
  check('v1: no agenda or v2 requests', !(db.rpcCalls || []).some((c) => c.name === 'agenda' || c.name === 'clock'));
  await page.context().close();

  // =====================================================================
  // 2. Desktop: the month grid by default
  // =====================================================================
  ({ page, db } = await open({ label: 'month' }));
  check('registered: Calendar tab second, after Today', same(await page.$$eval('.tabs a', (as) => as.map((a) => [a.textContent, a.getAttribute('href')]).slice(0, 3)),
    [['Today', '#/'], ['Calendar', '#/calendar'], ['Tasks', '#/tasks']]));
  check('registered: the tab is current, provides openEventForm', (await page.getAttribute('.tabs a[data-tab="calendar"]', 'aria-current')) === 'page'
    && await page.evaluate(() => typeof HomeHub.core.use('calendar').openEventForm === 'function'));
  check('desktop opens on the month: October 2026', (await text(page, '.cal-head h1')) === 'October 2026' && (await page.getAttribute('[data-view="month"]', 'aria-pressed')) === 'true');
  check('month: agenda() for the six weeks shown (Sep 28 to Nov 8)', same(lastAgenda(db), ['2026-09-28', '2026-11-08']), JSON.stringify(db.agendaCalls));
  check('month: 42 day cells, 6 weeks', (await page.$$eval('.cal-cell', (c) => c.length)) === 42 && (await page.$$eval('.cal-week', (w) => w.length)) === 6);
  const todayCell = await page.$eval('.cal-cell[data-day="2026-10-27"]', (c) => ({ cls: c.className, pressed: c.getAttribute('aria-pressed'), label: c.getAttribute('aria-label') }));
  check("month: today (the household's Oct 27, not the device's) is marked and chosen", /is-today/.test(todayCell.cls) && todayCell.pressed === 'true'
    && /^Tuesday, October 27, today: 4 items$/.test(todayCell.label) && /is-today/.test(await page.$eval('.cal-num[data-for="2026-10-27"]', (n) => n.className)), JSON.stringify(todayCell));
  const labels27 = await page.$$eval('.cal-items[data-for="2026-10-27"] .cal-lab', (ls) => ls.map((l) => [l.textContent, l.style.getPropertyValue('--pc')]));
  check('month: day labels with times, coloured by person in charge', same(labels27, [['3pm School pickup', COLORS.alex], ['4pm Piano', COLORS.taylor], ['Change furnace filter', COLORS.alex]]), JSON.stringify(labels27));
  const mbars = await page.$$eval('.cal-mbar', (bs) => bs.map((b) => [b.textContent, b.style.gridColumn, b.style.getPropertyValue('--pc')]));
  check('month: project task and multi-day event as bars across their days', mbars.some((b) => b[0] === 'Kitchen Renovation: Tile backsplash' && b[1] === '2 / 6' && b[2] === COLORS.alex)
    && mbars.some((b) => b[0] === 'Grandparents visit' && b[1] === '3 / 7' && b[2] === COLORS.sam), JSON.stringify(mbars));
  check('month: the milestone shows on its day', mbars.some((b) => b[0] === 'Kitchen Renovation: Final inspection' && b[1] === '4 / 5'));
  const offCell = await page.$eval('.cal-cell[data-day="2026-10-30"]', (c) => ({ cls: c.className, label: c.getAttribute('aria-label') }));
  const labels30 = await page.$$eval('.cal-items[data-for="2026-10-30"] .cal-lab', (ls) => ls.map((l) => l.textContent));
  check('month: a day off is marked, and "not on days off" events skip it', /is-off/.test(offCell.cls) && /day off/.test(offCell.label) && !labels30.some((l) => /pickup/.test(l)), JSON.stringify([offCell, labels30]));
  const soccerDays = await page.$$eval('.cal-items .cal-lab', (ls) => ls.filter((l) => /Soccer/.test(l.textContent)).map((l) => l.parentElement.dataset.for));
  check('month: every 2 weeks on Mon and Wed', same(soccerDays, ['2026-10-19', '2026-10-21', '2026-11-02', '2026-11-04']), soccerDays.join(','));
  const panel = await rows(page, '.cal-panel');
  check("month: the chosen day's agenda shows beside the grid, in time order", (await text(page, '#cal-panel-h')).replace(/\s+/g, ' ') === 'Today Tuesday, October 27'
    && same(panel.map((r) => r.title), ['School pickup', 'Piano', 'Tile backsplash', 'Change furnace filter']), JSON.stringify(panel.map((r) => r.title)));
  // School pickup has no end time: agenda() gives it the one-hour default end.
  check('month: times are in the household time zone (device is in Honolulu)', panel[1].time === '4:00pm 5:00pm' && panel[0].time === '3:00pm', JSON.stringify(panel.map((r) => r.time)));
  const calls = (db.agendaCalls || []).length;
  await page.click('.cal-cell[data-day="2026-10-29"]');
  await settle(page);
  const panel29 = await rows(page, '.cal-panel');
  // Oct 29 is in the middle of the tile work (Oct 27–30): it's in the project's "in progress" line, not a row.
  const panel29Lines = await underWay(page, '.cal-panel');
  check('month: tapping a day shows its agenda, no reload; project work under way is one line after the rows', (await text(page, '#cal-panel-h')).includes('Thursday, October 29') && db.agendaCalls.length === calls
    && same(panel29.map((r) => r.title), ['Electrician visit', 'School pickup', 'Water plants', 'Grandparents visit'])
    && same(panel29Lines.map((l) => [l.line, l.jobs, l.last]), [['Kitchen Renovation · 1 job in progress', ['Tile backsplash (Oct 27 – Oct 30)'], true]]), JSON.stringify([panel29.map((r) => r.title), panel29Lines]));
  check('month: the chosen day goes in the address', (await page.evaluate(() => location.hash)) === '#/calendar/2026-10-29'
    && (await page.getAttribute('.cal-cell[data-day="2026-10-29"]', 'aria-pressed')) === 'true' && (await page.getAttribute('.cal-cell[data-day="2026-10-27"]', 'aria-pressed')) === 'false');
  check('month: a directory contact has tap-to-call', panel29[0].call === 'tel:2015550100' && /Pat Lee/.test(panel29[0].sub), JSON.stringify(panel29[0]));
  check('month: inactive people get no filter chip', !(await page.$(`.cal-people [data-person="${P.morgan}"]`)) && (await page.$$eval('.cal-people .pchip', (c) => c.length)) === 5);
  check('month: buttons, chips and day cells are at least 44px', !(await smallTargets(page, '.cal-toolbar button, .cal-people button, .cal-cell, .cal-add, .cal-head .btn')).length, JSON.stringify(await smallTargets(page, '.cal-toolbar button, .cal-people button, .cal-cell, .cal-add, .cal-head .btn')));
  await page.screenshot({ path: SHOTS + 'calendar-month.png', fullPage: true });

  // Month navigation
  await page.click('[data-act="next"]');
  await page.waitForSelector('.cal-head h1:text("November 2026")');
  await settle(page);
  check('month: Next shows November (agenda Oct 26 to Dec 6)', (await page.evaluate(() => location.hash)) === '#/calendar/2026-11-01' && same(lastAgenda(db), ['2026-10-26', '2026-12-06']));
  await page.click('[data-act="prev"]');
  await page.waitForSelector('.cal-head h1:text("October 2026")');
  check("month: Prev back to this month chooses today", (await page.evaluate(() => location.hash)) === '#/calendar/2026-10-27' && (await page.getAttribute('.cal-cell[data-day="2026-10-27"]', 'aria-pressed')) === 'true');
  check('every agenda() call stays within 62 days', db.agendaCalls.every(([a, b]) => dnum(b) - dnum(a) <= 61), JSON.stringify(db.agendaCalls));

  // =====================================================================
  // 3. The person filter (remembered on this device)
  // =====================================================================
  await page.click(`.cal-people [data-person="${P.jordan}"]`);
  await settle(page);
  const jordanPanel = (await rows(page, '.cal-panel')).map((r) => r.title);
  check('filter: Jordan shows only items Jordan is in charge of or with', same(jordanPanel, ['School pickup', 'Piano']), jordanPanel.join(', '));
  check('filter: the chip is pressed, Everyone is not', (await page.getAttribute(`.cal-people [data-person="${P.jordan}"]`, 'aria-pressed')) === 'true'
    && (await page.getAttribute('[data-all]', 'aria-pressed')) === 'false');
  check('filter: the month grid follows it', !(await page.$$eval('.cal-items[data-for="2026-10-29"] .cal-lab', (ls) => ls.map((l) => l.textContent))).some((t) => /Electrician/.test(t))
    && (await page.$$eval('.cal-items[data-for="2026-10-29"] .cal-lab', (ls) => ls.map((l) => l.textContent))).some((t) => /Water plants/.test(t)));
  check('filter: remembered in localStorage', (await page.evaluate(() => localStorage.getItem('homehub.calendar.people'))) === JSON.stringify([P.jordan]));
  const barTitles = () => page.$$eval('.cal-mbar', (bs) => bs.map((b) => b.textContent));
  const jordanBars = await barTitles();
  await page.click(`.cal-people [data-person="${P.sam}"]`);
  await settle(page);
  check('filter: two people show both', !jordanBars.includes('Grandparents visit') && (await barTitles()).includes('Grandparents visit')
    && same((await rows(page, '.cal-panel')).map((r) => r.title), ['School pickup', 'Piano']), JSON.stringify(jordanBars));
  await page.reload();
  await page.waitForSelector('#main .cal-head');
  await settle(page);
  check('filter: still there after a reload', (await page.getAttribute(`.cal-people [data-person="${P.jordan}"]`, 'aria-pressed')) === 'true'
    && (await page.getAttribute(`.cal-people [data-person="${P.sam}"]`, 'aria-pressed')) === 'true');
  await page.click('[data-all]');
  await settle(page);
  check('filter: Everyone clears it', (await rows(page, '.cal-panel')).length === 4 && (await page.evaluate(() => localStorage.getItem('homehub.calendar.people'))) === '[]');

  // The view is remembered too.
  await page.click('[data-view="week"]');
  await page.waitForSelector('.cal-days');
  check('view: Week switches to the week agenda (agenda Oct 26 to Nov 1) and is remembered', same(lastAgenda(db), ['2026-10-26', '2026-11-01'])
    && (await page.evaluate(() => localStorage.getItem('homehub.calendar.view'))) === 'week');
  await page.reload();
  await page.waitForSelector('.cal-days');
  check('view: still the week after a reload', (await page.getAttribute('[data-view="week"]', 'aria-pressed')) === 'true');
  const wideBar = await page.$eval('.cal-bar.k-project', (b) => b.innerText.trim());
  check('week (desktop): a project bar shows the project and the task', wideBar === 'Kitchen Renovation: Tile backsplash', wideBar);
  await page.context().close();

  // Storage that throws: the page still works, it just doesn't remember.
  ({ page, db } = await open({ label: 'no-storage', brokenStorage: true }));
  await page.click(`.cal-people [data-person="${P.jordan}"]`);
  await settle(page);
  await page.click('[data-view="week"]');
  await page.waitForSelector('.cal-days');
  check('storage blocked: filter and view still work', (await page.getAttribute(`.cal-people [data-person="${P.jordan}"]`, 'aria-pressed')) === 'true'
    && !(await dayRows(page, '2026-10-29')).some((r) => /Electrician/.test(r.title)));
  await page.context().close();

  // =====================================================================
  // 4. Phone: the week agenda by default
  // =====================================================================
  ({ page, db } = await open({ label: 'week-phone', phone: true }));
  check('phone opens on the week: Oct 26–Nov 1', (await text(page, '.cal-head h1')) === 'Oct 26–Nov 1' && (await page.getAttribute('[data-view="week"]', 'aria-pressed')) === 'true', await text(page, '.cal-head h1'));
  check('week: agenda() for Monday to Sunday', same(lastAgenda(db), ['2026-10-26', '2026-11-01']));
  check('week: seven days, today marked', (await page.$$eval('.cal-day', (s) => s.length)) === 7
    && (await text(page, '#cal-h-2026-10-27')).replace(/\s+/g, ' ') === 'Today Tue Oct 27' && (await text(page, '#cal-h-2026-10-28')).replace(/\s+/g, ' ') === 'Tomorrow Wed Oct 28');
  check('phone: Calendar is current in the bottom bar', (await page.getAttribute('.bottombar a[data-tab="calendar"]', 'aria-current')) === 'page');
  const tue = await ownRows(page, '2026-10-27');
  check('week: repeating items carry the repeat mark', tue[0].repeats && tue[1].repeats && !tue[2].repeats);
  // School pickup has no end time: agenda() gives end_at = start + 1 hour, but nobody entered 4:00pm.
  check('week: Tuesday in time order with who and colour (an event without an end time shows its start only)', same(tue.map((r) => [r.title, r.time]), [['School pickup', '3:00pm'], ['Piano', '4:00pm 5:00pm'], ['Change furnace filter', 'Any time']])
    && tue[1].who.join('|') === 'Taylor Example, in charge|Jordan Example' && tue[1].pc === COLORS.taylor, JSON.stringify(tue));
  check('week: open tasks have a checkbox', tue[2].check === 'false' && tue[0].check === null);
  const wed = await ownRows(page, '2026-10-28');
  check('week: a changed day shows its new time, who and a Changed badge', wed[0].title === 'School pickup' && wed[0].time === '2:00pm' && /Changed/.test(wed[0].sub)
    && wed[0].who[0] === 'Sam Example, in charge', JSON.stringify(wed[0]));
  check('week: a done task is struck through with a ticked box', wed.some((r) => r.title === 'Call plumber' && r.status === 'done' && r.check === 'true'));
  const mon = await dayRows(page, '2026-10-26');
  check("week: an open task from an earlier day is late", mon.some((r) => r.title === 'Heartworm pill' && r.status === 'late' && /Late/.test(r.sub) && r.check === 'false'), JSON.stringify(mon));
  const fri = await dayRows(page, '2026-10-30');
  check('week: the day off is labelled and skips "not on days off" events', /Day off/.test(await text(page, '.cal-day:nth-of-type(5) .cal-day-head')) && !fri.some((r) => r.title === 'School pickup'), JSON.stringify(fri));
  const sat = await dayRows(page, '2026-10-31');
  check('week: an event past midnight keeps its times', sat.some((r) => r.title === 'Movie night' && r.time === '10:00pm 12:30am'), JSON.stringify(sat));
  const thu = await ownRows(page, '2026-10-29');
  check('week: tap-to-call for a directory contact', thu[0].title === 'Electrician visit' && thu[0].call === 'tel:2015550100' && thu[0].time === '8:00am 12:00pm', JSON.stringify(thu[0]));
  const sun = await dayRows(page, '2026-11-01');
  check('week: titles are text, never HTML', sun.some((r) => r.title === '<img src=x onerror="window.__xss=1">Bake sale')
    && !(await page.$('#main img')) && !(await page.evaluate(() => window.__xss)));
  const strip = await page.$$eval('.cal-bar', (bs) => bs.map((b) => [b.textContent, b.style.gridColumn]));
  check('week: project task and the visit as bars across the week', same(strip.map((s) => s[0]).sort(), ['Grandparents visit', 'Kitchen Renovation: Tile backsplash'])
    && strip.find((s) => /Tile/.test(s[0]))[1] === '2 / 6' && strip.find((s) => /visit/.test(s[0]))[1] === '3 / 7', JSON.stringify(strip));
  const phoneBar = await page.$eval('.cal-bar.k-project', (b) => ({ shown: b.innerText.trim(), label: b.getAttribute('aria-label') }));
  check('phone: a project bar shows just the task (room for it); its label still names the project', phoneBar.shown === 'Tile backsplash'
    && /^Kitchen Renovation: Tile backsplash, /.test(phoneBar.label), JSON.stringify(phoneBar));
  // The strip has scrolled away by the weekend on a phone, so each day's list has its longer items too.
  const visitDays = await Promise.all(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'].map(async (d) => (await dayRows(page, d))[0]));
  check('week: a multi-day event is at the top of each of its days, with its dates and who', visitDays.every((r) => r && r.title === 'Grandparents visit' && r.span
    && r.time === 'Oct 28 – Oct 31' && r.who[0] === 'Sam Example, in charge') && !(await dayRows(page, '2026-10-27')).some((r) => r.title === 'Grandparents visit'), JSON.stringify(visitDays));
  // Project work: a row on the day a job starts and the day it finishes, and one quiet line on the days between
  // (section 4b has a project with several long jobs at once).
  const tileDays = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
  const tileRows = await Promise.all(tileDays.map(async (d) => (await dayRows(page, d)).filter((r) => r.title === 'Tile backsplash' && r.span).map((r) => [r.time, r.sub])));
  const tileLines = await Promise.all(tileDays.map(async (d) => (await underWay(page, `[data-list="${d}"]`)).map((l) => l.line)));
  check('week: a project job is a row on the day it starts ("Starts", until Oct 30) and finishes, "1 job in progress" between',
    same(tileRows, [[['Starts', 'until Oct 30 · Kitchen Renovation · Maria Gomez']], [], [], [['Finishes', 'Kitchen Renovation · Maria Gomez']]])
    && same(tileLines, [[], ['Kitchen Renovation · 1 job in progress'], ['Kitchen Renovation · 1 job in progress'], []]),
    JSON.stringify([tileRows, tileLines]));
  check('phone: no sideways scroll at 390px', await noSideScroll(page));
  check('phone: tap targets are at least 44px', !(await smallTargets(page, '.cal-toolbar button, .cal-people button, .cal-add, .cal-bar, .irow-check, .irow-call')).length,
    JSON.stringify(await smallTargets(page, '.cal-toolbar button, .cal-people button, .cal-add, .cal-bar, .irow-check, .irow-call')));
  await page.screenshot({ path: SHOTS + 'calendar-week-phone.png', fullPage: true });

  // Week navigation
  await page.click('[data-act="next"]');
  await page.waitForSelector('.cal-head h1:text("Nov 2–8")');
  await settle(page);
  check('week: Next goes to Nov 2–8', (await page.evaluate(() => location.hash)) === '#/calendar/2026-11-02' && same(lastAgenda(db), ['2026-11-02', '2026-11-08']));
  check('week: soccer on Mon and Wed of its week', (await dayRows(page, '2026-11-02')).some((r) => r.title === 'Soccer') && (await dayRows(page, '2026-11-04')).some((r) => r.title === 'Soccer'));
  await page.click('[data-act="today"]');
  await page.waitForSelector('.cal-head h1:text("Oct 26–Nov 1")');
  check('week: Today comes back to this week', (await page.evaluate(() => location.hash)) === '#/calendar');

  // The project bar opens the project.
  await page.click('.cal-bar.k-project');
  await settle(page);
  check('week: tapping a project bar opens the project', (await page.evaluate(() => location.hash)) === '#/projects/p-kitchen');
  await page.goto(BASE + '/#/calendar');
  await page.waitForSelector('.cal-days');
  await settle(page);

  // =====================================================================
  // 5. Event details, and one-day changes for a repeating event
  // =====================================================================
  await clickRow(page, '[data-list="2026-10-27"]', 'Piano');
  await page.waitForSelector('#detail[open] #dTitle:text("Piano")');
  let details = await dialogText(page);
  check('details: when, repeat, who, place and notes', /Tuesday, October 27 · 4:00–5:00pm/.test(details) && /Repeats\s+Every Tue/.test(details)
    && (await whoLine(page)) === 'Taylor Example in charge with Jordan Example' && /Music school/.test(details) && /Bring the green book/.test(details), `${await whoLine(page)} / ${details}`);
  check('details: one-day actions for a repeating event, this day first', same(await page.$$eval('#detail [data-ev]', (b) => b.map((x) => x.textContent)), ['Change this day', 'Skip this day', 'Edit all days', 'Delete']));
  check('details: "Change this day" is the main button, not "Edit all days"', same(await page.$$eval('#detail .d-actions .btn-primary', (b) => b.map((x) => x.textContent)), ['Change this day']));
  check('details: the address names the event and day', (await page.evaluate(() => location.hash)) === `#/calendar/event/${E.piano}/2026-10-27`);
  check('details: buttons are 44px', !(await smallTargets(page, '#detail .d-actions .btn, #detail .d-close')).length, JSON.stringify(await smallTargets(page, '#detail .d-actions .btn, #detail .d-close')));
  check('details: no sideways scroll in the dialog', await page.$eval('#detail', (d) => d.scrollWidth <= d.clientWidth));
  await page.click('#detail .d-close');
  await settle(page);
  check('details: closing takes the event out of the address', (await page.evaluate(() => location.hash)) === '#/calendar/2026-10-26' || (await page.evaluate(() => location.hash)) === '#/calendar/2026-10-27',
    await page.evaluate(() => location.hash));

  // Skip this day, then Undo.
  await clickRow(page, '[data-list="2026-10-27"]', 'Piano');
  await page.waitForSelector('#detail[open] [data-ev="skip"]');
  await page.click('#detail [data-ev="skip"]');
  await settle(page, 500);
  let w = db.changeWrites[db.changeWrites.length - 1];
  check('skip: upserts event_changes (event, day) with cancelled', w && w.method === 'POST' && /on_conflict=event_id,on_date/.test(w.url) && /resolution=merge-duplicates/.test(w.prefer)
    && same(w.body, { event_id: E.piano, on_date: '2026-10-27', cancelled: true }), JSON.stringify(w));
  check('skip: the day shows struck through, marked "Skipped" (one word, as the button and toast say)', (await dayRows(page, '2026-10-27')).some((r) => r.title === 'Piano' && r.status === 'cancelled'
    && r.sub.startsWith('Skipped') && !/Cancelled|Changed/.test(r.sub)), JSON.stringify((await dayRows(page, '2026-10-27')).find((r) => r.title === 'Piano')));
  check('skip: a toast with Undo', /Skipped Piano on Tue Oct 27/.test(await toastText(page)) && !!(await page.$('.toast-btn')), await toastText(page));
  await page.click('.toast-btn');
  await settle(page, 500);
  w = db.changeWrites[db.changeWrites.length - 1];
  check('skip: Undo deletes the change again', w.method === 'DELETE' && w.url === `/rest/v1/event_changes?event_id=eq.${E.piano}&on_date=eq.2026-10-27`
    && (await dayRows(page, '2026-10-27')).some((r) => r.title === 'Piano' && r.status === 'open'), JSON.stringify(w));

  // Change this day: new time and who.
  await clickRow(page, '[data-list="2026-10-27"]', 'Piano');
  await page.waitForSelector('#detail[open] [data-ev="change"]');
  await page.click('#detail [data-ev="change"]');
  await page.waitForSelector('#formDialog[open] .cal-form');
  check('change: the form starts from that day', (await page.inputValue('#formDialog [name="start_time"]')) === '16:00' && (await page.inputValue('#formDialog [name="end_time"]')) === '17:00'
    && /Piano is usually 4:00–5:00pm, Taylor Example in charge, with Jordan Example/.test(await text(page, '#formDialog .cal-usual')), await text(page, '#formDialog .cal-usual'));
  await page.click('#formDialog [type="submit"]');
  await settle(page);
  check('change: nothing different, nothing written', /Nothing changed/.test(await toastText(page)) && !(await page.$('#formDialog[open]'))
    && !db.changeWrites.some((x) => x.method === 'POST' && x.body.start_time !== undefined), await toastText(page));
  await clickRow(page, '[data-list="2026-10-27"]', 'Piano');
  await page.waitForSelector('#detail[open] [data-ev="change"]');
  await page.click('#detail [data-ev="change"]');
  await page.waitForSelector('#formDialog[open] .cal-form');
  await page.fill('#formDialog [name="start_time"]', '17:00');
  await page.fill('#formDialog [name="end_time"]', '18:00');
  await page.click(`#formDialog [data-ref="who"] [data-person="${P.taylor}"]`); // Taylor off: nobody in charge
  await page.click('#formDialog [type="submit"]');
  await settle(page);
  check('change: someone has to be in charge on a changed day', /Someone has to be in charge/.test(await text(page, '#formDialog .form-error')), await text(page, '#formDialog .form-error'));
  await page.click(`#formDialog [data-ref="who"] [data-person="${P.sam}"]`); // Sam in charge
  await page.fill('#formDialog [name="note"]', 'Recital practice');
  await page.click('#formDialog [type="submit"]');
  await settle(page, 500);
  w = db.changeWrites[db.changeWrites.length - 1];
  check('change: upserts the day with its time, who and note', w.method === 'POST' && /on_conflict=event_id,on_date/.test(w.url) && same(w.body, {
    event_id: E.piano, on_date: '2026-10-27', cancelled: false, start_time: '17:00', end_time: '18:00', responsible_id: P.sam, participant_ids: [P.jordan], note: 'Recital practice',
  }), JSON.stringify(w && w.body));
  const changedRow = (await dayRows(page, '2026-10-27')).find((r) => r.title === 'Piano');
  check('change: the calendar shows the new time, Sam in charge, Changed', changedRow && changedRow.time === '5:00pm 6:00pm' && /Changed/.test(changedRow.sub)
    && changedRow.who[0] === 'Sam Example, in charge', JSON.stringify(changedRow));
  check('change: toast', /Changed Piano on Tue Oct 27/.test(await toastText(page)), await toastText(page));
  await clickRow(page, '[data-list="2026-10-27"]', 'Piano');
  await page.waitForSelector('#detail[open] [data-ev="restore"]');
  details = await dialogText(page);
  check('details: a changed day says so, with its note and Restore', /Changed this day/.test(details) && /This day: Recital practice/.test(details) && /5:00–6:00pm/.test(details), details);
  await page.click('#detail [data-ev="restore"]');
  await settle(page, 500);
  w = db.changeWrites[db.changeWrites.length - 1];
  check('restore: deletes the change, the day is back to normal', w.method === 'DELETE' && w.url === `/rest/v1/event_changes?event_id=eq.${E.piano}&on_date=eq.2026-10-27`
    && (await dayRows(page, '2026-10-27')).find((r) => r.title === 'Piano').time === '4:00pm 5:00pm' && /Piano is back to normal on Tue Oct 27/.test(await toastText(page)));
  await page.click('.toast-btn');
  await settle(page, 500);
  w = db.changeWrites[db.changeWrites.length - 1];
  check('restore: Undo puts the change back', w.method === 'POST' && w.body.note === 'Recital practice' && w.body.start_time === '17:00'
    && (await dayRows(page, '2026-10-27')).find((r) => r.title === 'Piano').time === '5:00pm 6:00pm', JSON.stringify(w.body));

  // A one-off event: Edit and Delete only, with tap-to-call.
  await clickRow(page, '[data-list="2026-10-29"]', 'Electrician visit');
  await page.waitForSelector('#detail[open] #dTitle:text("Electrician visit")');
  check('details: a one-off event has Edit and Delete only', same(await page.$$eval('#detail [data-ev]', (b) => b.map((x) => x.textContent)), ['Edit', 'Delete'])
    && same(await page.$$eval('#detail .d-actions .btn-primary', (b) => b.map((x) => x.textContent)), ['Edit']));
  check('details: contact with a 44px call button', (await page.getAttribute('#detail .cal-call', 'href')) === 'tel:2015550100' && /Pat Lee/.test(await dialogText(page))
    && !(await smallTargets(page, '#detail .cal-call')).length);
  // Delete, then Undo.
  await page.click('#detail [data-ev="delete"]');
  await settle(page, 500);
  check('delete: asks first', /Delete "Electrician visit"\?/.test((db.confirms || []).join('|')));
  w = db.eventWrites[db.eventWrites.length - 1];
  check('delete: deletes the event, and it leaves the calendar', w.method === 'DELETE' && w.url === `/rest/v1/events?id=eq.${E.electrician}`
    && !(await dayRows(page, '2026-10-29')).some((r) => r.title === 'Electrician visit') && /Deleted Electrician visit/.test(await toastText(page)));
  await page.click('.toast-btn');
  await settle(page, 500);
  w = db.eventWrites[db.eventWrites.length - 1];
  check('delete: Undo puts the same event back', w.method === 'POST' && w.body.id === E.electrician && w.body.title === 'Electrician visit'
    && (await dayRows(page, '2026-10-29')).some((r) => r.title === 'Electrician visit'));
  // Deleting a repeating event brings back its one-day changes on Undo.
  await clickRow(page, '[data-list="2026-10-28"]', 'School pickup');
  await page.waitForSelector('#detail[open] [data-ev="delete"]');
  await page.click('#detail [data-ev="delete"]');
  await settle(page, 500);
  check('delete: a repeating event asks about every day', /Delete "School pickup" on every day it repeats\?/.test(db.confirms.join('|')) && !db.events.some((e) => e.id === E.pickup)
    && !db.event_changes.some((c) => c.event_id === E.pickup));
  await page.click('.toast-btn');
  await settle(page, 600);
  check('delete: Undo restores the series and its changed day', db.events.some((e) => e.id === E.pickup) && db.event_changes.filter((c) => c.event_id === E.pickup).length === 1
    && (await dayRows(page, '2026-10-28')).some((r) => r.title === 'School pickup' && r.time === '2:00pm'));

  // Edit the whole series.
  await clickRow(page, '[data-list="2026-10-27"]', 'Piano');
  await page.waitForSelector('#detail[open] [data-ev="edit"]');
  await page.click('#detail [data-ev="edit"]');
  await page.waitForSelector('#formDialog[open] .cal-form');
  check('edit: the form is filled in from the series', (await page.inputValue('#formDialog [name="title"]')) === 'Piano' && (await page.inputValue('#formDialog [name="start_date"]')) === '2026-09-01'
    && (await page.inputValue('#formDialog [name="start_time"]')) === '16:00' && (await page.getAttribute('#formDialog [data-preset="weekly"]', 'aria-pressed')) === 'true'
    && (await text(page, '#formDialog [data-preset="weekly"]')) === 'Every Tue' && await page.$eval('#formDialog details.cal-more', (d) => d.open)
    && (await page.inputValue('#formDialog [name="location"]')) === 'Music school');
  await page.fill('#formDialog [name="title"]', 'Piano lesson');
  await page.click('#formDialog [type="submit"]');
  await settle(page, 500);
  w = db.eventWrites[db.eventWrites.length - 1];
  check('edit: saves the whole row to that event', w.method === 'PATCH' && /^\/rest\/v1\/events\?id=eq\./.test(w.url) && w.url.includes(E.piano) && same(w.body, {
    title: 'Piano lesson', start_date: '2026-09-01', end_date: null, start_time: '16:00', end_time: '17:00', ends_next_day: false,
    responsible_id: P.taylor, participant_ids: [P.jordan], contractor_id: null, location: 'Music school', notes: 'Bring the green book',
    private: false, skip_days_off: false, repeat: 'weekly', repeat_every: 1, repeat_weekdays: [2], repeat_until: null,
  }), JSON.stringify(w && w.body));
  check('edit: toast and the new title on the calendar', /Saved Piano lesson/.test(await toastText(page)) && (await dayRows(page, '2026-10-27')).some((r) => r.title === 'Piano lesson'));

  // Tasks on the calendar
  await page.click('[data-list="2026-10-27"] .irow[data-kind="task"] .irow-check');
  await settle(page, 500);
  let call = (db.rpcCalls || []).filter((c) => c.name === 'complete_task').pop();
  check('task: ticking it calls complete_task with the day shown', call && same(call.body, { p_id: K.filter, p_occurrence: '2026-10-27' }), JSON.stringify(call));
  check('task: done, with an Undo toast', (await dayRows(page, '2026-10-27')).some((r) => r.title === 'Change furnace filter' && r.status === 'done')
    && /Done: Change furnace filter/.test(await toastText(page)));
  await page.click('.toast-btn');
  await settle(page, 500);
  call = (db.rpcCalls || []).filter((c) => c.name === 'undo_task').pop();
  check('task: Undo calls undo_task with the log id', call && call.body.p_log_id === uid(901) && (await dayRows(page, '2026-10-27')).some((r) => r.title === 'Change furnace filter' && r.status === 'open')
    && /back on the list/.test(await toastText(page)), JSON.stringify(call));
  await page.click('[data-list="2026-10-26"] .irow[data-kind="task"] .irow-check');
  await settle(page, 500);
  call = (db.rpcCalls || []).filter((c) => c.name === 'complete_task').pop();
  check('task: a late repeating task is ticked for its own day', same(call.body, { p_id: K.pill, p_occurrence: '2026-10-26' })
    && (await dayRows(page, '2026-10-26')).some((r) => r.title === 'Heartworm pill' && r.status === 'done'));
  await page.context().close();

  ({ page, db } = await open({ label: 'already-done', phone: true, allow400: true }));
  await page.click('[data-list="2026-10-29"] .irow[data-kind="task"] .irow-check');
  await settle(page, 600);
  check('task: ticked elsewhere already: a clear message and the box unticks', /Someone already ticked this off/.test(await toastText(page))
    && (await dayRows(page, '2026-10-29')).find((r) => r.title === 'Water plants').check === 'false', await toastText(page));
  await clickRow(page, '[data-list="2026-10-27"]', 'Change furnace filter');
  await page.waitForSelector('#detail[open] #dTitle:text("Change furnace filter")');
  check('task details: due day, who, Mark done and a link to the task on Tasks', /Due\s+Tuesday, October 27/.test(await dialogText(page)) && (await whoLine(page)) === 'Alex Example in charge'
    && !!(await page.$('#detail [data-task="done"]')) && (await page.getAttribute('#detail .d-actions a.btn', 'href')) === `#/tasks/${K.filter}`);
  await page.click('#detail [data-task="done"]');
  await settle(page, 500);
  check('task details: Mark done ticks it off', !(await page.$('#detail[open]')) && (await dayRows(page, '2026-10-27')).some((r) => r.title === 'Change furnace filter' && r.status === 'done'));
  await page.context().close();

  // =====================================================================
  // 6. A link to an event opens its details over the calendar
  // =====================================================================
  ({ page, db } = await open({ label: 'deep-link', path: `/#/calendar/event/${E.soccer}/2026-11-02` }));
  await page.waitForSelector('#detail[open] #dTitle:text("Soccer")');
  details = await dialogText(page);
  check('link: the repeat summary for every 2 weeks with an end', /Every 2 weeks on Mon, Wed until Dec 17/.test(details) && /Monday, November 2 · 5:30–6:30pm/.test(details), details);
  check('link: the calendar behind it shows that day', (await text(page, '.cal-head h1')) === 'November 2026' && (await page.getAttribute('.cal-cell[data-day="2026-11-02"]', 'aria-pressed')) === 'true');
  await page.keyboard.press('Escape');
  await settle(page);
  check('link: closing goes back to the calendar address', (await page.evaluate(() => location.hash)) === '#/calendar/2026-11-02');
  await page.goto(BASE + `/#/calendar/event/${E.electrician}`);
  await page.waitForSelector('#detail[open] #dTitle:text("Electrician visit")');
  check('link: a one-off event without a day opens on its date', (await page.getAttribute('.cal-cell[data-day="2026-10-29"]', 'aria-pressed')) === 'true' && /Thursday, October 29 · 8:00am–12:00pm/.test(await dialogText(page)));
  await page.goto(BASE + `/#/calendar/event/${uid(999)}/2026-10-27`);
  await settle(page, 700);
  check('link: a deleted event says so and goes back to the calendar', /isn't on the calendar any more/.test(await toastText(page)) && !(await page.$('#detail[open]'))
    && (await page.evaluate(() => location.hash)) === '#/calendar/2026-10-27', await toastText(page));
  await page.context().close();

  // =====================================================================
  // 7. The event form: from the Add sheet, every part of it, and its checks
  // =====================================================================
  ({ page, db } = await open({ label: 'form' }));
  await page.click('.topbar-end [data-shell="add"]');
  await page.click('#sheet [data-add="event"]');
  await page.waitForSelector('#formDialog[open] .cal-form');
  check('form: the Add sheet opens it, today chosen', (await text(page, '#formDialog h3')) === 'New event' && (await page.inputValue('#formDialog [name="start_date"]')) === TODAY
    && (await page.getAttribute(`#formDialog [data-date="${TODAY}"]`, 'aria-pressed')) === 'true' && (await page.getAttribute('#formDialog [data-preset="none"]', 'aria-pressed')) === 'true');
  check('form: repeat buttons named from the date', same(await page.$$eval('#formDialog [data-preset]', (b) => b.map((x) => x.textContent)), ["Doesn't repeat", 'Every Tue', 'Every weekday (Mon–Fri)', 'Every day', 'Custom…']));
  const posts = () => db.eventWrites.filter((x) => x.method === 'POST').length;
  const submit = async () => { await page.click('#formDialog [type="submit"]'); await settle(page, 400); return text(page, '#formDialog .form-error'); };
  check('form check: a name', /Give the event a name/.test(await submit()));
  await page.fill('#formDialog [name="title"]', 'Library club');
  check('form check: a time or All day', /Pick a start time, or tick All day/.test(await submit()));
  await page.fill('#formDialog [name="start_time"]', '16:00');
  await page.click('#formDialog details.cal-more summary');
  await page.fill('#formDialog [name="end_time"]', '15:00');
  check('form check: the end before the start', /Ends the next day/.test(await submit()));
  await page.click(`#formDialog [data-date="${addDays(TODAY, 1)}"]`);
  check('form: Tomorrow moves the date and renames the repeat', (await page.inputValue('#formDialog [name="start_date"]')) === '2026-10-28'
    && (await text(page, '#formDialog [data-preset="weekly"]')) === 'Every Wed' && (await page.getAttribute(`#formDialog [data-date="${addDays(TODAY, 1)}"]`, 'aria-pressed')) === 'true');
  await page.fill('#formDialog [name="end_time"]', '17:00');
  await page.click(`#formDialog [data-ref="who"] [data-person="${P.jordan}"]`);
  await page.click(`#formDialog [data-ref="who"] [data-person="${P.taylor}"]`);
  check('form: who chips, first in charge, then with', /Jordan in charge · with Taylor/.test(await text(page, '#formDialog .who-hint')), await text(page, '#formDialog .who-hint'));
  check('form: "Not on days off" isn\'t offered for a one-off', !(await page.isVisible('#formDialog [name="skip_days_off"]')));
  await page.click('#formDialog [data-preset="weekly"]');
  check('form: Until shows for a repeat', await page.isVisible('#formDialog [name="repeat_until"]') && !(await page.isVisible('#formDialog [name="end_date"]')));
  const skipBox = await page.evaluate(() => {
    const box = document.querySelector('#formDialog [name="skip_days_off"]');
    return { inRepeats: !!box.closest('fieldset') && /Repeats/.test(box.closest('fieldset').querySelector('legend').textContent), inMore: !!box.closest('details'),
      label: box.closest('label').textContent.trim(), checked: box.checked, more: document.querySelector('#formDialog details.cal-more summary').textContent };
  });
  check('form: a repeat offers "Not on days off" right under Repeats (not hidden under More), unticked for a weekly one', skipBox.inRepeats && !skipBox.inMore
    && skipBox.label === 'Not on days off (school holidays)' && !skipBox.checked && /^More: end time, place, contact, notes$/.test(skipBox.more), JSON.stringify(skipBox));
  await page.fill('#formDialog [name="repeat_until"]', '2026-10-20');
  check('form check: the repeat ending before it starts', /can't end before the first date/.test(await submit()));
  await page.fill('#formDialog [name="repeat_until"]', '2026-12-16');
  await page.fill('#formDialog [name="location"]', 'Library');
  check('form: the directory list for the contact', same(await page.$$eval('#formDialog [name="contractor_id"] option', (o) => o.map((x) => x.textContent)), ['None', 'Maria Gomez (Gomez Tile & Stone)', 'Pat Lee (Lee Electric)']));
  await page.selectOption('#formDialog [name="contractor_id"]', 'c-maria');
  await page.fill('#formDialog [name="notes"]', 'Bring a library card');
  await page.check('#formDialog [name="private"]');
  await page.check('#formDialog [name="skip_days_off"]');
  check('form: none of the failed checks wrote anything', posts() === 0);
  await page.click('#formDialog [type="submit"]');
  await settle(page, 600);
  w = db.eventWrites.filter((x) => x.method === 'POST').pop();
  check('form: saves exactly the events row', w && same(w.body, {
    title: 'Library club', start_date: '2026-10-28', end_date: null, start_time: '16:00', end_time: '17:00', ends_next_day: false,
    responsible_id: P.jordan, participant_ids: [P.taylor], contractor_id: 'c-maria', location: 'Library', notes: 'Bring a library card',
    private: true, skip_days_off: true, repeat: 'weekly', repeat_every: 1, repeat_weekdays: [3], repeat_until: '2026-12-16',
  }), JSON.stringify(w && w.body));
  check('form: closes with a toast and the event is on the calendar', !(await page.$('#formDialog[open]')) && /Added Library club · Wed Oct 28/.test(await toastText(page))
    && (await page.$$eval('.cal-items[data-for="2026-10-28"] .cal-lab', (ls) => ls.map((l) => l.textContent))).includes('4pm Library club'));

  // Past midnight, all-day trips, every weekday, custom repeats.
  const fresh = async () => {
    await page.click('.cal-head [data-act="add"]');
    await page.waitForSelector('#formDialog[open] .cal-form');
  };
  await fresh();
  await page.fill('#formDialog [name="title"]', 'Night shift');
  await page.fill('#formDialog [name="start_time"]', '22:00');
  await page.click('#formDialog details.cal-more summary');
  await page.fill('#formDialog [name="end_time"]', '06:00');
  await page.check('#formDialog [name="ends_next_day"]');
  await page.click('#formDialog [type="submit"]');
  await settle(page, 500);
  w = db.eventWrites.filter((x) => x.method === 'POST').pop();
  check('form: an event past midnight', w.body.title === 'Night shift' && w.body.start_time === '22:00' && w.body.end_time === '06:00' && w.body.ends_next_day === true && w.body.start_date === TODAY
    && w.body.skip_days_off === false, JSON.stringify(w.body));

  await fresh();
  await page.fill('#formDialog [name="title"]', 'Beach trip');
  await page.check('#formDialog [name="all_day"]');
  check('form: All day hides the time and offers an end date', !(await page.isVisible('#formDialog [name="start_time"]')) && await page.isVisible('#formDialog [name="end_date"]'));
  await page.fill('#formDialog [name="end_date"]', '2026-10-20');
  check('form check: the end date before the start', /end date can't be before the start date/.test(await submit()));
  await page.fill('#formDialog [name="end_date"]', '2026-10-30');
  await page.click('#formDialog [type="submit"]');
  await settle(page, 500);
  w = db.eventWrites.filter((x) => x.method === 'POST').pop();
  check('form: a few days in a row, all day', w.body.title === 'Beach trip' && w.body.start_date === TODAY && w.body.end_date === '2026-10-30' && w.body.start_time === null
    && w.body.end_time === null && w.body.ends_next_day === false && w.body.repeat === 'none' && same(w.body.repeat_weekdays, []), JSON.stringify(w.body));
  check('form: it shows as a bar', (await page.$$eval('.cal-mbar', (bs) => bs.map((b) => b.textContent))).includes('Beach trip'));

  await fresh();
  await page.fill('#formDialog [name="title"]', 'Carpool');
  await page.fill('#formDialog [name="start_date"]', '2026-10-31');
  await page.fill('#formDialog [name="start_time"]', '07:30');
  await page.click('#formDialog [data-preset="weekdays"]');
  check('form: "Every weekday" ticks "Not on days off" (the school run)', await page.isChecked('#formDialog [name="skip_days_off"]') && await page.isVisible('#formDialog [name="skip_days_off"]'));
  check('form check: every weekday can\'t start on a Saturday', /has to start on a weekday/.test(await submit()));
  await page.fill('#formDialog [name="start_date"]', '2026-11-02');
  await page.click('#formDialog [type="submit"]');
  await settle(page, 500);
  w = db.eventWrites.filter((x) => x.method === 'POST').pop();
  check('form: every weekday, not on days off', w.body.title === 'Carpool' && w.body.repeat === 'weekly' && same(w.body.repeat_weekdays, [1, 2, 3, 4, 5]) && w.body.repeat_every === 1
    && w.body.skip_days_off === true, JSON.stringify(w.body));

  await fresh();
  await page.fill('#formDialog [name="title"]', 'Swim team');
  await page.fill('#formDialog [name="start_date"]', '2026-11-02');
  await page.fill('#formDialog [name="start_time"]', '18:00');
  await page.click('#formDialog [data-preset="custom"]');
  const wd = () => page.$$eval('#formDialog [data-wd]', (b) => b.map((x) => [x.textContent, x.getAttribute('aria-pressed'), x.getAttribute('aria-disabled')]));
  check("form: custom starts with the date's weekday, locked on", same((await wd())[0], ['Mo', 'true', 'true']) && (await wd()).slice(1).every((x) => x[1] === 'false'), JSON.stringify(await wd()));
  await page.click('#formDialog [data-wd="1"]', { force: true }); // the locked day: nothing happens
  await page.click('#formDialog [data-wd="3"]');
  await page.selectOption('#formDialog [name="repeat_every"]', '2');
  await page.fill('#formDialog [name="repeat_until"]', '2026-12-17');
  check('form: tapping the locked day does nothing; Wed added', same((await wd()).map((x) => x[1]), ['true', 'false', 'true', 'false', 'false', 'false', 'false']));
  await page.click('#formDialog [type="submit"]');
  await settle(page, 500);
  w = db.eventWrites.filter((x) => x.method === 'POST').pop();
  check('form: custom, every 2 weeks on Mon and Wed until Dec 17', w.body.title === 'Swim team' && w.body.repeat === 'weekly' && w.body.repeat_every === 2
    && same(w.body.repeat_weekdays, [1, 3]) && w.body.repeat_until === '2026-12-17', JSON.stringify(w.body));
  check('form: every row passed the events checks', db.eventWrites.filter((x) => x.method === 'POST').every(({ body: b }) =>
    (b.end_date === null || (b.end_date >= b.start_date && b.start_time === null && b.repeat === 'none'))
    && (b.end_time === null || b.start_time !== null) && (b.end_time === null || b.ends_next_day || b.end_time > b.start_time)
    && (b.repeat_until === null || b.repeat_until >= b.start_date) && (b.repeat === 'weekly' || b.repeat_weekdays.length === 0)
    && (b.responsible_id === null || !b.participant_ids.includes(b.responsible_id)) && b.repeat_every >= 1 && b.repeat_every <= 4));
  // From the Add sheet while the calendar shows another day: the form starts on that day.
  await page.click('.cal-cell[data-day="2026-11-04"]');
  await settle(page);
  await page.click('.topbar-end [data-shell="add"]');
  await page.click('#sheet [data-add="event"]');
  await page.waitForSelector('#formDialog[open] .cal-form');
  check('form: from the Add sheet it starts on the day chosen on the calendar', (await page.inputValue('#formDialog [name="start_date"]')) === '2026-11-04'
    && (await text(page, '#formDialog [data-preset="weekly"]')) === 'Every Wed');
  await page.keyboard.press('Escape');
  // Opened with defaults by another page (Today, say): the date and who come with it.
  await page.evaluate((p) => HomeHub.core.openAdd('event', { date: '2026-11-03', responsible_id: p }), P.sam);
  await page.waitForSelector('#formDialog[open] .cal-form');
  check('form: defaults from another page', (await page.inputValue('#formDialog [name="start_date"]')) === '2026-11-03' && /Sam in charge/.test(await text(page, '#formDialog .who-hint')));
  await page.keyboard.press('Escape');
  await page.context().close();

  // On a phone: the bottom bar's ＋, the form fits, 44px targets.
  ({ page, db } = await open({ label: 'form-phone', phone: true }));
  await page.click('.bottombar .bb-add');
  await page.click('#sheet [data-add="event"]');
  await page.waitForSelector('#formDialog[open] .cal-form');
  await page.click('#formDialog [data-preset="custom"]');
  await page.click('#formDialog details.cal-more summary');
  check('phone form: no sideways scroll in the dialog or the page', await page.$eval('#formDialog', (d) => d.scrollWidth <= d.clientWidth) && await noSideScroll(page));
  check('phone form: every button and field is at least 44px tall', !(await smallTargets(page, '#formDialog button, #formDialog input:not([type="checkbox"]), #formDialog select, #formDialog .cal-check, #formDialog summary')).length,
    JSON.stringify(await smallTargets(page, '#formDialog button, #formDialog input:not([type="checkbox"]), #formDialog select, #formDialog .cal-check, #formDialog summary')));
  const formType = await page.evaluate(() => [...document.querySelectorAll('#formDialog summary, #formDialog .cal-check, #formDialog legend, #formDialog .cal-chip')]
    .map((e) => { const c = getComputedStyle(e); return { t: e.textContent.trim().slice(0, 20), fs: parseFloat(c.fontSize) }; }).filter((x) => x.fs < 13));
  check('phone form: labels and buttons read at full size (13px or more)', !formType.length, JSON.stringify(formType));
  await page.screenshot({ path: SHOTS + 'calendar-form-phone.png', fullPage: false });
  for (const width of [375, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await settle(page, 200);
    const fit = await page.evaluate(() => {
      const form = document.querySelector('#formDialog form');
      const right = form.getBoundingClientRect().right;
      const days = [...form.querySelectorAll('[data-wd]')].map((b) => b.getBoundingClientRect());
      return { sw: form.scrollWidth, cw: form.clientWidth, lastRight: Math.round(days[days.length - 1].right), right: Math.round(right), minH: Math.min(...days.map((d) => d.height)) };
    });
    check(`phone form (${width}px): the custom weekdays fit (no sideways scroll), each still 44px tall`, fit.sw <= fit.cw && fit.lastRight <= fit.right && fit.minH >= 44
      && await page.$eval('#formDialog', (d) => d.scrollWidth <= d.clientWidth), JSON.stringify(fit));
    await page.screenshot({ path: SHOTS + `calendar-form-custom-${width}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await page.click('[data-view="month"]');
  await page.waitForSelector('.cal-month');
  await settle(page);
  check('phone month: dots instead of words, no sideways scroll', await noSideScroll(page)
    && await page.$eval('.cal-items[data-for="2026-10-27"] .cal-lab-t', (t) => getComputedStyle(t).display === 'none')
    && await page.$eval('.cal-items[data-for="2026-10-27"] .cal-dot', (t) => t.getBoundingClientRect().width >= 7));
  check('phone month: day cells are tap targets', !(await smallTargets(page, '.cal-cell')).length, JSON.stringify(await smallTargets(page, '.cal-cell')));
  await page.click('.cal-cell[data-day="2026-10-28"]');
  await settle(page, 600);
  check('phone month: tapping a day shows its agenda', (await text(page, '#cal-panel-h')).includes('Wednesday, October 28') && (await rows(page, '.cal-panel')).length >= 3);
  await page.screenshot({ path: SHOTS + 'calendar-month-phone.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 7b. A weekend away: the days it covers aren't "Nothing planned"; a done task can be unticked
  // =====================================================================
  db = calDb();
  db.events.push(ev(uid(208), { title: 'Trip to the lake', start_date: '2026-11-05', end_date: '2026-11-08', responsible_id: P.alex, participant_ids: [P.sam, P.jordan, P.taylor] }));
  db.task_log.push({ id: uid(950), task_id: K.plumber, occurrence: '2026-10-28', status: 'done', done_on: '2026-10-25', done_by: 'sam@example.com', prev_done_at: null, created_at: '2026-10-25T14:00:00+00:00' });
  ({ page, db } = await open({ label: 'weekend-away', phone: true, db, path: '/#/calendar/2026-11-02' }));
  const weekend = await Promise.all(['2026-11-07', '2026-11-08'].map(async (d) => ({ rows: (await dayRows(page, d)).map((r) => [r.title, r.time]), text: await text(page, `[data-list="${d}"]`) })));
  check('week: a day with only a trip lists the trip, not "Nothing planned"', weekend.every((d) => same(d.rows, [['Trip to the lake', 'Nov 5 – Nov 8']]) && !/Nothing planned/.test(d.text)), JSON.stringify(weekend));
  check('week: the trip still shows as one bar in the strip', same(await page.$$eval('.cal-bar', (bs) => bs.map((b) => b.textContent).filter((t) => /lake/.test(t))), ['Trip to the lake']));
  await page.goto(BASE + '/#/calendar/2026-10-28');
  await page.waitForSelector('.cal-days');
  await settle(page, 400);
  const plumberBox = page.locator('[data-list="2026-10-28"] .irow', { hasText: 'Call plumber' }).locator('.irow-check');
  await plumberBox.click();
  await settle(page, 600);
  const undone = (db.rpcCalls || []).filter((c) => c.name === 'undo_task').pop();
  check('task: a ticked box asks, then marks it not done (its log entry is undone)', /Mark "Call plumber" as not done\?/.test((db.confirms || []).join('|')) && undone && undone.body.p_log_id === uid(950)
    && !db.tasks.find((t) => t.id === K.plumber).done_at && (await dayRows(page, '2026-10-28')).some((r) => r.title === 'Call plumber' && r.status === 'open' && r.check === 'false')
    && /Call plumber is back on the list/.test(await toastText(page)), JSON.stringify({ undone, toast: await toastText(page) }));
  await page.context().close();
  db = calDb();
  ({ page, db } = await open({ label: 'done-details', db, path: '/#/calendar/2026-10-28' }));
  await clickRow(page, '.cal-panel', 'Call plumber');
  await page.waitForSelector('#detail[open]');
  check('task details (done): "Open in Tasks" goes to its Done entry, where "Not done after all" is', (await page.getAttribute('#detail .d-actions a.btn', 'href')) === `#/tasks/${K.plumber}/done`,
    await page.getAttribute('#detail .d-actions a.btn', 'href'));
  await page.context().close();

  // =====================================================================
  // 7c. A project with three long jobs at once and a one-day job, and a second project's long job:
  // each long job is a row only on the days it starts and finishes; between, one line per project
  // =====================================================================
  const busyDb = () => {
    const d = calDb();
    const job = (id, name, trade, start, end, extra) => Object.assign({ id, name, trade, trade_name: trade, start, end, days: dnum(end) - dnum(start) + 1, status: null, milestone: false }, extra);
    d.projects.find((p) => p.id === 'p-kitchen').task_dates = [
      job('cab', 'Cabinets on order (≈6 weeks)', 'cabinets', '2026-10-12', '2026-11-20'),
      job('demo', 'Demolition & haul-away', 'general', '2026-10-26', '2026-10-30'),
      job('elec', 'Electrical rough-in', 'electrician', '2026-10-27', '2026-11-01'),
      job('insp', 'Rough-in inspection', 'inspection', '2026-10-28', '2026-10-28'),
    ];
    d.projects.find((p) => p.id === 'p-pool').task_dates = [job('pump', 'Pump on order', 'pool', '2026-10-20', '2026-11-10')];
    return d;
  };
  const WEEK = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
  const JOBS = ['Cabinets on order (≈6 weeks)', 'Demolition & haul-away', 'Electrical rough-in', 'Rough-in inspection', 'Pump on order'];
  const weekParts = (page) => Promise.all(WEEK.map(async (d) => ({ rows: await dayRows(page, d), lines: await underWay(page, `[data-list="${d}"]`) })));
  ({ page, db } = await open({ label: 'busy-week', phone: true, db: busyDb() }));
  let busy = await weekParts(page);
  // Where each project job is a row: [day, what its time column says, its details line].
  const jobRows = Object.fromEntries(JOBS.map((t) => [t, busy.flatMap((b, i) => b.rows.filter((r) => r.title === t).map((r) => [WEEK[i].slice(5), r.time, r.sub]))]));
  check('busy week: each long job is a row only on its start day ("Starts", "until …") and finish day; the one-day job on its day; jobs spanning the week never',
    same(jobRows, {
      'Cabinets on order (≈6 weeks)': [],
      'Demolition & haul-away': [['10-26', 'Starts', 'until Oct 30 · Kitchen Renovation'], ['10-30', 'Finishes', 'Kitchen Renovation']],
      'Electrical rough-in': [['10-27', 'Starts', 'until Nov 1 · Kitchen Renovation · Pat Lee'], ['11-01', 'Finishes', 'Kitchen Renovation · Pat Lee']],
      'Rough-in inspection': [['10-28', 'All day', 'Kitchen Renovation']],
      'Pump on order': [],
    }), JSON.stringify(jobRows));
  const lineTexts = busy.map((b) => b.lines.map((l) => l.line));
  const kp = (n) => [`Kitchen Renovation · ${n} job${n === 1 ? '' : 's'} in progress`, 'Pool repairs · 1 job in progress'];
  check('busy week: every other day has one "N jobs in progress" line per project (by name), however many jobs overlap',
    same(lineTexts, [kp(1), kp(2), kp(3), kp(3), kp(2), kp(2), kp(1)]), JSON.stringify(lineTexts));
  check('busy week: the lines come after the day\'s rows, closed, each a 44px tap target', busy.every((b) => b.lines.every((l) => l.last && !l.open && l.h >= 44)),
    JSON.stringify(busy.map((b) => b.lines.map((l) => [l.last, l.open, l.h]))));
  check('busy week: events and tasks read as before, ahead of the project work', same(busy[1].rows.map((r) => r.title), ['School pickup', 'Piano', 'Electrical rough-in', 'Change furnace filter'])
    && same((await ownRows(page, '2026-10-27')).map((r) => r.title), ['School pickup', 'Piano', 'Change furnace filter'])
    && same(busy[3].rows.map((r) => r.title), ['Grandparents visit', 'Electrician visit', 'School pickup', 'Water plants']), JSON.stringify(busy.map((b) => b.rows.map((r) => r.title))));
  check('busy week: 5 project rows in the whole week (not 5 jobs × 7 days)', busy.flatMap((b) => b.rows).filter((r) => r.kind === 'project').length === 5);
  // The strip on a phone: a bar per job stacked six rows (four of them the kitchen's) above Monday. Now the
  // family's trip is on top, the kitchen's four jobs are one bar, and the pool's one job keeps its own bar.
  const stripOf = (page) => page.$$eval('.cal-strip .cal-bar', (bs) => bs.map((b) => ({
    text: b.innerText.replace(/\s+/g, ' ').trim(), label: b.getAttribute('aria-label'), col: b.style.gridColumn, row: b.style.gridRow,
    fits: b.scrollWidth <= b.clientWidth + 1, fold: b.classList.contains('cal-bar-fold') })));
  const stripRows = (page) => page.$eval('.cal-strip-grid', (g) => getComputedStyle(g).gridTemplateRows.split(' ').length - 1);
  const phoneStrip = await stripOf(page);
  check('busy week (phone): the strip has the trip on top, then one bar per project ("Kitchen Renovation · 4 jobs", Mon to Sun; the pool\'s one job as itself), 3 rows not 6',
    same(phoneStrip.map((b) => [b.text, b.col, b.row, b.fold]), [
      ['Grandparents visit', '3 / 7', '2', false],
      ['Kitchen Renovation · 4 jobs', '1 / 8', '3', true],
      ['Pump on order', '1 / 8', '4', false],
    ]) && phoneStrip[1].label === 'Kitchen Renovation: 4 jobs this week (Cabinets on order (≈6 weeks), Demolition & haul-away, Electrical rough-in, Rough-in inspection)'
      && phoneStrip.every((b) => b.fits) && (await stripRows(page)) === 3, JSON.stringify([phoneStrip, await stripRows(page)]));
  const phaseFits = await page.$$eval('.cal-list .irow-time.cal-phase', (ts) => ts.map((t) => [t.innerText.replace(/\s+/g, ' '), t.scrollWidth <= t.clientWidth + 1]));
  check('busy week: "Starts" and "Finishes" fit the time column on a phone', same(phaseFits.map((f) => f[0]), ['Starts', 'Starts', 'Finishes', 'Finishes'])
    && phaseFits.every((f) => f[1]), JSON.stringify(phaseFits));
  check('busy week (phone): no sideways scroll', await noSideScroll(page));
  await page.screenshot({ path: SHOTS + 'calendar-week-projects-phone.png', fullPage: true });

  // A tap opens a line: the jobs under way, with their dates, each opening the project.
  await page.click('[data-list="2026-10-28"] .cal-ongoing[data-project="p-kitchen"] > summary');
  await settle(page);
  let wedLines = await underWay(page, '[data-list="2026-10-28"]');
  const wedJobs = await page.$$eval('[data-list="2026-10-28"] .cal-ongoing[data-project="p-kitchen"] .irow', (rs) => rs.map((r) => [
    ((r.querySelector('.irow-sub') || {}).textContent || '').trim(), (r.querySelector('.irow-call') || {}).href || null, !!r.querySelector('.irow-check')]));
  check('busy week: a tap opens the line to list its jobs and their dates', wedLines[0].open && !wedLines[1].open
    && same(wedLines[0].jobs, ['Cabinets on order (≈6 weeks) (Oct 12 – Nov 20)', 'Demolition & haul-away (Oct 26 – Oct 30)', 'Electrical rough-in (Oct 27 – Nov 1)']), JSON.stringify(wedLines));
  check('busy week: the listed jobs keep their contact\'s call button, without the project name again, and no tick box', same(wedJobs, [['', null, false], ['', null, false], ['Pat Lee', 'tel:2015550100', false]]), JSON.stringify(wedJobs));
  check('busy week: the listed jobs are 44px tap targets', !(await smallTargets(page, '.cal-ongoing[open] .irow-main, .cal-ongoing[open] .irow-call')).length,
    JSON.stringify(await smallTargets(page, '.cal-ongoing[open] .irow-main, .cal-ongoing[open] .irow-call')));
  await page.screenshot({ path: SHOTS + 'calendar-week-projects-open-phone.png', fullPage: true });
  // It stays open when the page redraws (a person chosen); the filter applies to project work too.
  await page.click(`.cal-people [data-person="${P.alex}"]`);
  await settle(page);
  wedLines = await underWay(page, '[data-list="2026-10-28"]');
  check('busy week: an open line stays open across a redraw; the person filter applies (the pool job has no owner)', wedLines.length === 1 && wedLines[0].open
    && wedLines[0].line === 'Kitchen Renovation · 3 jobs in progress', JSON.stringify(wedLines));
  await page.click(`.cal-people [data-person="${P.alex}"]`);
  await page.click(`.cal-people [data-person="${P.jordan}"]`);
  await settle(page);
  busy = await weekParts(page);
  check('busy week: someone else\'s view has no project work at all', busy.every((b) => !b.lines.length && !b.rows.some((r) => r.kind === 'project')));
  await page.click('[data-all]');
  await settle(page);
  await page.click('[data-list="2026-10-28"] .cal-ongoing[data-project="p-kitchen"] .irow-main >> nth=0');
  await settle(page);
  check('busy week: a listed job opens its project', (await page.evaluate(() => location.hash)) === '#/projects/p-kitchen');
  // A job ticked off on the project still has its dates; the line counts it apart.
  db.projects.find((p) => p.id === 'p-kitchen').task_dates[1].status = 'done';
  await page.goto(BASE + '/#/calendar/2026-10-29');
  await page.waitForSelector('.cal-days');
  await settle(page);
  check('busy week: a done job is counted apart ("2 jobs in progress · 1 done")', (await underWay(page, '[data-list="2026-10-29"]'))[0].line === 'Kitchen Renovation · 2 jobs in progress · 1 done',
    JSON.stringify(await underWay(page, '[data-list="2026-10-29"]')));
  await page.goto(BASE + '/#/calendar');
  await page.waitForSelector('.cal-strip .cal-bar-fold');
  await settle(page);
  await page.click('.cal-strip .cal-bar-fold');
  await settle(page);
  check('busy week (phone): the project\'s one bar in the strip opens the project', (await page.evaluate(() => location.hash)) === '#/projects/p-kitchen');
  await page.context().close();

  // A wider screen has room for a bar per job: the strip keeps them, under the trip. Crossing the phone
  // width (a turn, a narrower window) redraws it.
  ({ page, db } = await open({ label: 'busy-week-desktop', db: busyDb(), path: '/#/calendar' }));
  await page.click('[data-view="week"]');
  await page.waitForSelector('.cal-days');
  await settle(page);
  let wideStrip = await stripOf(page);
  check('busy week (desktop): the strip still draws every job as a bar, below the trip', same(wideStrip.filter((b) => !/visit/.test(b.text)).map((b) => b.label.split(',')[0]).sort(),
    ['Kitchen Renovation: Cabinets on order (≈6 weeks)', 'Kitchen Renovation: Demolition & haul-away', 'Kitchen Renovation: Electrical rough-in', 'Kitchen Renovation: Rough-in inspection', 'Pool repairs: Pump on order'])
    && wideStrip[0].text === 'Grandparents visit' && wideStrip[0].row === '2' && wideStrip.slice(1).every((b) => Number(b.row) > 2 && !b.fold), JSON.stringify(wideStrip));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector('.cal-strip .cal-bar-fold');
  const turned = (await stripOf(page)).map((b) => b.text);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.waitForFunction(() => !document.querySelector('.cal-strip .cal-bar-fold'));
  wideStrip = await stripOf(page);
  check('busy week: narrowing the window to a phone\'s width folds the kitchen\'s bars, widening it unfolds them', same(turned, ['Grandparents visit', 'Kitchen Renovation · 4 jobs', 'Pump on order'])
    && wideStrip.length === 6, JSON.stringify([turned, wideStrip.map((b) => b.text)]));
  await page.context().close();

  // The month's day panel folds project work the same way (the grid keeps its bars).
  ({ page, db } = await open({ label: 'busy-month', db: busyDb(), path: '/#/calendar/2026-10-28' }));
  const busyPanel = await rows(page, '.cal-panel');
  const busyPanelLines = await underWay(page, '.cal-panel');
  check('busy month: the day panel lists the one-day job and folds the jobs under way into a line per project',
    same(busyPanel.map((r) => r.title), ['School pickup', 'Grandparents visit', 'Rough-in inspection', 'Call plumber'])
    && same(busyPanelLines.map((l) => [l.line, l.last]), [['Kitchen Renovation · 3 jobs in progress', true], ['Pool repairs · 1 job in progress', true]]),
    JSON.stringify([busyPanel.map((r) => r.title), busyPanelLines]));
  check('busy month: the grid still draws the jobs as bars', (await page.$$eval('.cal-mbar.k-project', (bs) => bs.length)) > 0);
  await page.click('.cal-cell[data-day="2026-10-30"]');
  await settle(page);
  check('busy month: another day: its finishing job is a row ("Finishes")', (await rows(page, '.cal-panel')).some((r) => r.title === 'Demolition & haul-away' && r.time === 'Finishes')
    && same((await underWay(page, '.cal-panel')).map((l) => l.line), kp(2)));
  // The panel is narrow: "Kitchen Renovation · 2 jobs in progress" wraps, but only at the "·" (it read "2 jobs in" / "progress").
  const nbParts = await page.$$eval('.cal-panel .cal-ongoing .cal-nb', (ns) => ns.map((n) => [n.textContent, n.getClientRects().length]));
  check('busy month: a line in the narrow panel wraps only at a "·" ("2 jobs in progress" stays on one line)', same(nbParts, [['2 jobs in progress', 1], ['1 job in progress', 1]]), JSON.stringify(nbParts));
  await page.screenshot({ path: SHOTS + 'calendar-month-projects.png', fullPage: true });
  await page.context().close();

  // Dark, on a phone, with a line open.
  ({ page, db } = await open({ label: 'busy-dark', phone: true, dark: true, db: busyDb() }));
  await page.click('[data-list="2026-10-28"] .cal-ongoing[data-project="p-kitchen"] > summary');
  await settle(page);
  check('busy week (dark): no sideways scroll; the line uses the theme\'s muted text', await noSideScroll(page)
    && (await page.$eval('.cal-ongoing > summary', (s) => getComputedStyle(s).color)) === 'rgb(165, 156, 144)');
  await page.screenshot({ path: SHOTS + 'calendar-week-projects-phone-dark.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 8. Dark mode uses the dark colours
  // =====================================================================
  for (const dark of [false, true]) {
    ({ page } = await open({ label: dark ? 'dark' : 'light', dark }));
    const c = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      month: getComputedStyle(document.querySelector('.cal-month')).backgroundColor,
      text: getComputedStyle(document.querySelector('.cal-head h1')).color,
    }));
    check(`${dark ? 'dark' : 'light'} mode: page and grid colours from the theme`, dark
      ? c.body === 'rgb(18, 17, 16)' && c.month === 'rgb(27, 25, 23)' && c.text === 'rgb(243, 239, 233)'
      : c.body === 'rgb(246, 244, 240)' && c.month === 'rgb(255, 255, 255)' && c.text === 'rgb(31, 27, 22)', JSON.stringify(c));
    if (dark) await page.screenshot({ path: SHOTS + 'calendar-month-dark.png', fullPage: true });
    await page.context().close();
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
