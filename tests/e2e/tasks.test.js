// Browser tests for the v2 Tasks page (assets/modules/tasks.js): the filters (Me, Everyone, a
// person, Repeating, Project), the groups (Late, Today, Coming up, No date, Paused, Done), one-tap
// ticking with Undo, the row menu (another day, skip, edit, pause, delete), the starter list with
// staggered dates, the task form and openTaskForm for the Add sheet.
//
// The fake RPCs answer with the shapes in supabase/migrations/0002_home_hub_v2.sql (complete_task,
// skip_task: the task_log id; undo_task: the task id; clock: one object) and change db.tasks and
// db.task_log the way the database does, so the page reads its own changes back. Writes to the tasks
// table get the table's defaults and its check constraints (a row that breaks one is refused with
// 23514, as Postgres would), so every row the page sends must fit the table. The other v2 pages are
// small stubs served in place of their files, so this file tests Tasks alone. The browser runs in
// Pacific/Honolulu with its clock on another day (January) from the household's (America/New_York,
// Sunday Oct 25 from clock()), so anything using the device's date shows the wrong day.
// Run alone with: node tests/e2e/tasks.test.js
const { chromium } = require('playwright');
const { randomUUID, createHash } = require('crypto');
const { makeDb, install, signIn, SUPA } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const uuid = () => randomUUID();

// ---- Dates (whole UTC days, like the page)
const TODAY = '2026-10-25';   // the household's date (a Sunday); the device is on Jan 14, evening
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function addUnits(iso, n, unit) {
  if (unit === 'day') return addDays(iso, n);
  if (unit === 'week') return addDays(iso, 7 * n);
  const months = Number(iso.slice(5, 7)) - 1 + (unit === 'year' ? 12 * n : n);
  const y = Number(iso.slice(0, 4)) + Math.floor(months / 12);
  const m = ((months % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(Number(iso.slice(8, 10)), last)).padStart(2, '0')}`;
}
const isoWd = (iso) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
const monday = (iso) => addDays(iso, 1 - isoWd(iso));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
// private.series_after: the first series date strictly after `after`, counted from the anchor.
function seriesAfter(t, after) {
  const wds = t.repeat_weekdays || [];
  if (t.every_unit === 'week' && wds.length) {
    let d = after >= t.anchor_date ? addDays(after, 1) : t.anchor_date;
    for (let i = 0; i < 7 * t.every_count + 7; i++, d = addDays(d, 1)) {
      if (wds.includes(isoWd(d)) && (daysBetween(monday(t.anchor_date), monday(d)) / 7) % t.every_count === 0) return d;
    }
    return null;
  }
  if (after < t.anchor_date) return t.anchor_date;
  if (t.every_unit === 'day' || t.every_unit === 'week') {
    const step = t.every_count * (t.every_unit === 'week' ? 7 : 1);
    return addDays(t.anchor_date, (Math.floor(daysBetween(t.anchor_date, after) / step) + 1) * step);
  }
  const step = t.every_count * (t.every_unit === 'year' ? 12 : 1);
  const k = Math.floor(monthsBetween(t.anchor_date, after) / step);
  const at = addUnits(t.anchor_date, k * step, 'month');
  return at > after ? at : addUnits(t.anchor_date, (k + 1) * step, 'month');
}

// ---- Fixtures (fictional people, 555-01xx numbers, example.com)
const T = '2026-10-24T16:00:00.000000+00:00';
const ID = {
  alex: '0a1e0000-0000-4000-8000-000000000001', sam: '0a1e0000-0000-4000-8000-000000000002',
  jordan: '0a1e0000-0000-4000-8000-000000000003', taylor: '0a1e0000-0000-4000-8000-000000000004',
  morgan: '0a1e0000-0000-4000-8000-000000000005',
};
const person = (id, name, role, color, sort, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color, language: 'en',
  day_token: createHash('md5').update(id).digest('hex'), digest_enabled: false, digest_time: null,
  digest_day: 'today', digest_scope: 'mine', sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);

// Every column of public.tasks and public.task_log, in the table's order.
const TASK_COLS = ['id', 'title', 'notes', 'category', 'responsible_id', 'due_date', 'due_time', 'lead_days', 'project_id', 'contractor_id',
  'private', 'repeat_mode', 'every_count', 'every_unit', 'repeat_weekdays', 'anchor_date', 'last_done', 'active', 'done_at', 'done_by',
  'created_by', 'updated_by', 'created_at', 'updated_at'];
const LOG_COLS = ['id', 'task_id', 'occurrence', 'status', 'done_on', 'done_by', 'note', 'prev_due', 'prev_last_done', 'prev_done_at', 'created_at', 'seq'];
const TASK_DEFAULTS = {
  notes: null, category: 'other', responsible_id: null, due_date: null, due_time: null, lead_days: 0, project_id: null, contractor_id: null,
  private: false, repeat_mode: 'none', every_count: null, every_unit: null, repeat_weekdays: [], anchor_date: null, last_done: null,
  active: true, done_at: null, done_by: null, created_by: 'alex@example.com', updated_by: 'alex@example.com', created_at: T, updated_at: T,
};
const task = (o) => {
  const r = Object.assign({ id: uuid() }, TASK_DEFAULTS, o);
  if (r.repeat_mode !== 'none' && !r.anchor_date) r.anchor_date = r.due_date;
  return Object.fromEntries(TASK_COLS.map((k) => [k, r[k]]));
};
let logSeq = 100;
const logRow = (o) => Object.fromEntries(LOG_COLS.map((k) => [k, Object.assign({
  id: uuid(), note: null, done_on: null, done_by: null, prev_due: null, prev_last_done: null, prev_done_at: null, seq: logSeq++,
}, o)[k]]));

// public.tasks check constraints (and the column checks), on a whole row. null = it fits.
function tableCheck(r) {
  const rep = r.repeat_mode !== 'none';
  if (!String(r.title || '').trim()) return 'title';
  if (!['home', 'pets', 'vehicle', 'health', 'family', 'other'].includes(r.category)) return 'category';
  if (!['none', 'schedule', 'after_done'].includes(r.repeat_mode)) return 'repeat_mode';
  if (!(Number.isInteger(r.lead_days) && r.lead_days >= 0 && r.lead_days <= 90)) return 'lead_days';
  if (r.every_count != null && !(Number.isInteger(r.every_count) && r.every_count >= 1 && r.every_count <= 120)) return 'every_count';
  if (r.every_unit != null && !['day', 'week', 'month', 'year'].includes(r.every_unit)) return 'every_unit';
  if (!Array.isArray(r.repeat_weekdays) || !r.repeat_weekdays.every((w) => Number.isInteger(w) && w >= 1 && w <= 7)) return 'repeat_weekdays';
  if (!rep && !(r.every_count == null && r.every_unit == null && r.anchor_date == null && r.repeat_weekdays.length === 0)) return 'one-off with repeat settings';
  if (rep && !(r.every_count != null && r.every_unit != null && r.due_date != null && r.anchor_date != null)) return 'repeating without count, unit or date';
  if (r.repeat_weekdays.length && !(r.repeat_mode === 'schedule' && r.every_unit === 'week')) return 'weekdays without a weekly schedule';
  if (r.due_time != null && r.due_date == null) return 'time without date';
  if (r.done_at != null && r.repeat_mode !== 'none') return 'done_at on a repeating task';
  return null;
}
// private.tasks_defaults, simplified: weekdays only on a weekly schedule, sorted; a one-off has no
// repeat settings; a repeating task's anchor defaults to (or follows an edited) due date.
function tasksDefaults(row, old) {
  if (!(row.repeat_mode === 'schedule' && row.every_unit === 'week')) row.repeat_weekdays = [];
  row.repeat_weekdays = [...new Set((row.repeat_weekdays || []).map(Number))].sort((a, b) => a - b);
  if (row.repeat_mode === 'none') Object.assign(row, { every_count: null, every_unit: null, anchor_date: null });
  else if (old && !row.__move && row.anchor_date === old.anchor_date && (row.due_date !== old.due_date || row.every_count !== old.every_count
    || row.every_unit !== old.every_unit || row.repeat_mode !== old.repeat_mode || !same(row.repeat_weekdays, old.repeat_weekdays))) row.anchor_date = row.due_date;
  else if (!row.anchor_date) row.anchor_date = row.due_date;
  delete row.__move;
  return row;
}

function tasksDb() {
  const db = makeDb();
  db.people = [
    person(ID.morgan, 'Morgan Example', 'kid', '#9333ea', 5, { active: false }),
    person(ID.taylor, 'Taylor Example', 'helper', '#ca8a04', 4, { phone: '(201) 555-0104' }),
    person(ID.alex, 'Alex Example', 'parent', '#2563eb', 1, { email: 'alex@example.com', email_verified_at: T }),
    person(ID.jordan, 'Jordan Example', 'kid', '#16a34a', 3),
    person(ID.sam, 'Sam Example', 'adult', '#db2777', 2, { email: 'sam@example.com' }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: ID.sam, house_owner_id: ID.alex, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '07:45:00', tz: 'America/New_York' };
  db.projects.forEach((p) => Object.assign(p, { task_dates: [], task_dates_at: T, on_calendar: true, owner_id: null }));
  db.projects.find((p) => p.id === 'p-pool').status = 'done';
  const K = {};
  const add = (key, o) => { const t = task(o); K[key] = t; return t; };
  db.tasks = [
    add('plumber', { title: 'Call the plumber', responsible_id: ID.alex, due_date: TODAY, due_time: '09:00:00', contractor_id: 'c-pat', category: 'home' }),
    add('passport', { title: 'Renew passport', responsible_id: ID.alex, due_date: '2026-10-20', category: 'family' }),
    add('filter', { title: 'Change the furnace/AC filter', responsible_id: ID.alex, due_date: '2026-10-23', category: 'home', repeat_mode: 'after_done', every_count: 60, every_unit: 'day', last_done: '2026-08-24' }),
    add('heartworm', { title: 'Heartworm preventive', responsible_id: ID.sam, due_date: '2026-11-01', category: 'pets', repeat_mode: 'schedule', every_count: 1, every_unit: 'month', last_done: '2026-10-02' }),
    add('recycling', { title: 'Take out recycling', responsible_id: ID.jordan, due_date: '2026-10-26', category: 'family', repeat_mode: 'schedule', every_count: 1, every_unit: 'week', repeat_weekdays: [1, 4], anchor_date: '2026-10-05' }),
    add('present', { title: 'Buy birthday present', responsible_id: ID.alex, category: 'family', notes: 'Jordan wants a kite.' }),
    add('heater', { title: 'Flush the water heater', due_date: '2027-03-10', category: 'home', repeat_mode: 'after_done', every_count: 12, every_unit: 'month' }),
    add('fence', { title: 'Paint the fence', due_date: '2026-11-15', category: 'home' }),
    add('tiles', { title: 'Pick up tiles', responsible_id: ID.alex, due_date: '2026-10-28', project_id: 'p-kitchen', category: 'home', lead_days: 2 }),
    add('oil', { title: 'Oil change', responsible_id: ID.alex, due_date: '2026-12-01', category: 'vehicle', repeat_mode: 'schedule', every_count: 6, every_unit: 'month', active: false }),
    add('party', { title: 'Plan surprise party', responsible_id: ID.sam, due_date: '2026-10-30', private: true, category: 'family' }),
    add('books', { title: 'Return library books', responsible_id: ID.alex, due_date: '2026-10-24', category: 'family', done_at: '2026-10-24T14:00:00.000000+00:00', done_by: 'sam@example.com' }),
    add('old', { title: 'Clean out the shed', responsible_id: ID.alex, due_date: '2026-09-01', done_at: '2026-09-01T14:00:00.000000+00:00', done_by: 'alex@example.com' }),
  ];
  db.task_log = [
    logRow({ task_id: K.books.id, occurrence: '2026-10-24', status: 'done', done_on: '2026-10-24', done_by: 'sam@example.com', created_at: '2026-10-24T14:00:00.000000+00:00' }),
    logRow({ task_id: K.recycling.id, occurrence: '2026-10-19', status: 'skipped', done_by: 'alex@example.com', prev_due: '2026-10-19', created_at: '2026-10-19T12:00:00.000000+00:00' }),
    logRow({ task_id: K.recycling.id, occurrence: '2026-10-23', status: 'done', done_on: '2026-10-23', done_by: 'Jordan Example (My day)', prev_due: '2026-10-23', created_at: '2026-10-23T22:00:00.000000+00:00' }),
    logRow({ task_id: K.heartworm.id, occurrence: '2026-10-01', status: 'done', done_on: '2026-10-02', done_by: 'sam@example.com', prev_due: '2026-10-01', created_at: '2026-10-02T12:00:00.000000+00:00' }),
    logRow({ task_id: K.old.id, occurrence: '2026-09-01', status: 'done', done_on: '2026-09-01', done_by: 'alex@example.com', created_at: '2026-09-01T14:00:00.000000+00:00' }),
  ];
  db.K = K;
  return db;
}

// ---- RPC fakes with the migration's shapes and rules
const fail = (status, code, message, hint) => ({ __status: status, body: { code, message, details: null, hint: hint || null } });
let tick = 0;
const stampNow = () => `2026-10-25T15:${String(10 + (tick++ % 50)).padStart(2, '0')}:00.000000+00:00`;
const tasksRpc = (extra) => Object.assign({
  hub_schema_version: () => 2,
  clock: (db) => Object.assign({}, db.clock),
  mark_signed_in: () => null,
  // complete_task(p_id, p_occurrence, p_done_on, p_note) → task_log id
  complete_task: (db, b, email) => {
    if (db.completeFail) return fail(500, 'XX000', 'Database restarting');
    const t = db.tasks.find((x) => x.id === b.p_id);
    if (!t) return fail(404, 'P0002', 'That task no longer exists.');
    const today = db.clock.local_date;
    const doneOn = b.p_done_on || today;
    if (t.active === false) return fail(400, '22023', 'This task is paused. Turn it back on before ticking it off.');
    if (doneOn > today) return fail(400, '22023', "A task can't be done on a day that hasn't happened yet.");
    const id = uuid();
    if (t.repeat_mode === 'none') {
      if (t.done_at) return fail(400, 'P0001', 'already done', 'Someone already ticked this off.');
      const at = stampNow();
      db.task_log.push(logRow({ id, task_id: t.id, occurrence: t.due_date, status: 'done', done_on: doneOn, done_by: email, note: b.p_note || null, prev_done_at: t.done_at, created_at: at }));
      Object.assign(t, { done_at: at, done_by: email });
      return id;
    }
    if (b.p_occurrence && b.p_occurrence !== t.due_date) return fail(400, 'P0001', 'already completed', 'This date was already ticked off or skipped.');
    if (doneOn < addUnits(t.due_date, -1, 'year')) return fail(400, '22023', 'That date is more than a year before the task was due.');
    const next = t.repeat_mode === 'schedule' ? seriesAfter(t, doneOn > t.due_date ? doneOn : t.due_date) : addUnits(doneOn, t.every_count, t.every_unit);
    db.task_log.push(logRow({ id, task_id: t.id, occurrence: t.due_date, status: 'done', done_on: doneOn, done_by: email, note: b.p_note || null, prev_due: t.due_date, prev_last_done: t.last_done, created_at: stampNow() }));
    Object.assign(t, { due_date: next, last_done: doneOn });
    return id;
  },
  // skip_task(p_id, p_occurrence) → task_log id
  skip_task: (db, b, email) => {
    const t = db.tasks.find((x) => x.id === b.p_id);
    if (!t) return fail(404, 'P0002', 'That task no longer exists.');
    if (t.repeat_mode === 'none') return fail(400, '22023', 'Only repeating tasks can be skipped.');
    if (t.active === false) return fail(400, '22023', 'This task is paused. Turn it back on before skipping it.');
    if (b.p_occurrence && b.p_occurrence !== t.due_date) return fail(400, 'P0001', 'already completed', 'This date was already ticked off or skipped.');
    const today = db.clock.local_date;
    const from = t.due_date > today ? t.due_date : today;
    const next = t.repeat_mode === 'schedule' ? seriesAfter(t, from) : addUnits(from, t.every_count, t.every_unit);
    const id = uuid();
    db.task_log.push(logRow({ id, task_id: t.id, occurrence: t.due_date, status: 'skipped', done_by: email, prev_due: t.due_date, prev_last_done: t.last_done, created_at: stampNow() }));
    t.due_date = next;
    return id;
  },
  // undo_task(p_log_id) → task id: only the task's latest entry, within 7 days.
  undo_task: (db, b) => {
    const l = db.task_log.find((x) => x.id === b.p_log_id);
    if (!l) return fail(404, 'P0002', "There's nothing to undo.");
    if (db.task_log.some((x) => x.task_id === l.task_id && x.seq > l.seq)) return fail(400, '22023', 'Only the latest change to a task can be undone.');
    const t = db.tasks.find((x) => x.id === l.task_id);
    if (t.repeat_mode === 'none') Object.assign(t, { done_at: l.prev_done_at, done_by: null });
    else Object.assign(t, { due_date: l.prev_due, last_done: l.prev_last_done });
    db.task_log.splice(db.task_log.indexOf(l), 1);
    return t.id;
  },
}, extra);

// ---- Stub v2 pages: same register() contract as the real ones
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true }, provides: 'openEventForm' },
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
    name: ${JSON.stringify(name)}, schema: { min: 2, max: 2 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return ${s.root ? '!parts.length || ' : ''}parts[0] === ${JSON.stringify(name)} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1>'; },
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
    const db = opts.db || tasksDb();
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 }, timezoneId: 'Pacific/Honolulu' }, opts.ctx));
    await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    // The device's clock: Wednesday Jan 14, 7pm in Honolulu. The household's date comes from clock().
    await page.clock.setFixedTime(new Date('2026-01-15T05:00:00Z'));
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    // Steps that make the database refuse something on purpose set expect.failures while they run.
    const expect = { failures: false };
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (expect.failures && /status of (400|500)/.test(m.text())) return;
      if (opts.v1 && /status of 404/.test(m.text()) && /hub_schema_version$/.test(m.location().url || '')) return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => { (db.confirms = db.confirms || []).push(d.message()); return opts.decline ? d.dismiss() : d.accept(); });
    await install(page, db, log, { rpc: opts.v1 ? {} : tasksRpc(opts.rpc) });
    // whoami() in v2 adds the caller's person: { id, name, role, language, color } or null.
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
    // Writes to tasks: recorded as sent, then given the table's defaults and checks before the mock stores them.
    db.writes = [];
    db.refused = [];
    await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/tasks', (route) => {
      const req = route.request();
      const method = req.method();
      if (method !== 'PATCH' && method !== 'POST' && method !== 'DELETE') return route.fallback();
      const body = JSON.parse(req.postData() || 'null');
      db.writes.push({ method, url: decodeURIComponent(req.url()), body });
      if (method === 'DELETE') return route.fallback();
      const refuse = (why) => {
        db.refused.push(why);
        return route.fulfill({ status: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: '23514', message: `new row for relation "tasks" violates check constraint (${why})`, details: null, hint: null }) });
      };
      if (db.forceCheckFail) return refuse('forced by the test');
      if (method === 'POST') {
        const rows = (Array.isArray(body) ? body : [body]).map((r) => tasksDefaults(Object.assign({}, TASK_DEFAULTS, { id: uuid() }, r)));
        const bad = rows.map(tableCheck).find(Boolean);
        if (bad) return refuse(bad);
        return route.fallback({ postData: JSON.stringify(rows) });
      }
      const id = (new URL(req.url()).searchParams.get('id') || '').replace(/^eq\./, '');
      const old = db.tasks.find((x) => x.id === id);
      if (old) {
        const bad = tableCheck(tasksDefaults(Object.assign({}, old, body), old));
        if (bad) return refuse(bad);
        return route.fallback({ postData: JSON.stringify(tasksDefaults(Object.assign({}, old, body), old)) });
      }
      return route.fallback();
    });
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule(name, s) }));
    }
    await page.goto(BASE + (opts.path || '/#/tasks'));
    await page.waitForTimeout(opts.wait || 700);
    return { page, db, log, context, expect };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.innerText.trim()));
  const flat = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
  const headings = (page) => page.$$eval('.tasks-body .sec-head span:first-child', (es) => es.map((e) => e.textContent));
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  // A group's row titles, without the screen-reader ", repeats".
  const titles = (page, group) => page.$$eval(`[data-group="${group}"] .irow-title`, (es) => es.map((e) => e.firstChild.textContent));
  const groupsOn = (page) => page.$$eval('.tasks-body .tasks-sec', (es) => es.map((e) => e.dataset.group));
  const rowFor = (page, group, title) => page.locator(`[data-group="${group}"] .irow`, { hasText: title }).first();
  const calls = (db, name) => (db.rpcCalls || []).filter((c) => c.name === name);
  const chipLabels = (page) => texts(page, '.tasks-chips .pchip-name');
  const pressed = (page) => page.$$eval('.tasks-chips .pchip[aria-pressed="true"] .pchip-name', (es) => es.map((e) => e.textContent));
  const chip = (page, label) => page.locator('.tasks-chips .pchip', { hasText: label }).first();
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const toasts = (page) => texts(page, '.toasts .toast');
  const lastToast = async (page) => (await toasts(page)).slice(-1)[0] || '';
  const undoToast = async (page) => { await page.locator('.toasts .toast-btn').last().click(); await page.waitForTimeout(500); };
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(500); };
  const openMenu = async (page, group, title) => { await rowFor(page, group, title).locator('.tasks-menu').click(); await page.waitForTimeout(150); };
  const act = async (page, name) => { await page.locator(`#detail [data-act="${name}"]`).click(); await page.waitForTimeout(500); };
  const formOpen = (page) => page.evaluate(() => document.getElementById('formDialog').open);
  const detailOpen = (page) => page.evaluate(() => document.getElementById('detail').open);
  const lastWrite = (db, method) => db.writes.filter((w) => !method || w.method === method).slice(-1)[0] || null;

  // =====================================================================
  // 0. The fixtures have the tables' columns, and fit the tasks table's checks
  // =====================================================================
  const fx = tasksDb();
  check('fixtures: every tasks row has exactly the table\'s columns', fx.tasks.every((r) => same(Object.keys(r), TASK_COLS)));
  check('fixtures: every task_log row has exactly the table\'s columns', fx.task_log.every((r) => same(Object.keys(r), LOG_COLS)));
  check('fixtures: every tasks row fits the table\'s checks', fx.tasks.every((r) => !tableCheck(r)), fx.tasks.map(tableCheck).filter(Boolean).join(','));
  check('fake: series_after counts from the anchor (monthly, weekly on Mon+Thu, Jan 31 monthly)',
    seriesAfter(fx.K.heartworm, '2026-11-01') === '2026-12-01' && seriesAfter(fx.K.recycling, '2026-10-26') === '2026-10-29'
    && seriesAfter({ anchor_date: '2027-01-31', every_count: 1, every_unit: 'month', repeat_weekdays: [] }, '2027-01-31') === '2027-02-28');

  // =====================================================================
  // 1. Registration and the Me view (desktop, Alex: a parent)
  // =====================================================================
  let { page, db, log, expect } = await open({ label: 'desktop' });
  const reg = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]),
    bar: [...document.querySelectorAll('.bottombar a')].map((a) => a.textContent.trim()),
    provides: typeof HomeHub.core.use('tasks').openTaskForm,
  }));
  check('register: Tasks is the third tab, at "#/tasks", and current', same(reg.tabs[2], ['Tasks', '#/tasks', 'page']), JSON.stringify(reg.tabs));
  check('register: Tasks is in the phone bottom bar (primary)', reg.bar.includes('Tasks'), reg.bar.join(','));
  check('register: provides openTaskForm for the Add sheet', reg.provides === 'function');
  check('head: the household\'s date, not the device\'s', (await tc(page, '.tasks-head .eyebrow')) === 'Sunday, October 25', await tc(page, '.tasks-head .eyebrow'));
  check('chips: Me, Everyone, each other active person, Repeating, Project (no inactive Morgan)',
    same(await chipLabels(page), ['Me', 'Everyone', 'Sam', 'Jordan', 'Taylor', 'Repeating', 'Project']), (await chipLabels(page)).join(','));
  check('chips: Me is chosen by default', same(await pressed(page), ['Me']), (await pressed(page)).join(','));
  const reads = log.map((l) => decodeURIComponent(l));
  check('reads: open tasks (done_at is null), one-offs done since 14 days ago, and the done/skipped log since then',
    reads.includes('GET /rest/v1/tasks?select=*&done_at=is.null')
    && reads.includes('GET /rest/v1/tasks?select=*&done_at=not.is.null&done_at=gte.2026-10-11')
    && reads.includes('GET /rest/v1/task_log?select=*&status=in.(done,skipped)&created_at=gte.2026-10-11&order=created_at.desc'), reads.filter((l) => /tasks|task_log/.test(l)).join(' | '));

  check('me: groups in order (Late, Today, Coming up, No date, Paused, Done)', same(await groupsOn(page), ['late', 'today', 'coming', 'inbox', 'paused', 'done']), (await groupsOn(page)).join(','));
  check('me: Late has my overdue tasks, oldest first', same(await titles(page, 'late'), ['Renew passport', 'Change the furnace/AC filter']), (await titles(page, 'late')).join(','));
  check('me: Today, Coming up, No date and Paused hold only my tasks', same(await titles(page, 'today'), ['Call the plumber'])
    && same(await titles(page, 'coming'), ['Pick up tiles']) && same(await titles(page, 'inbox'), ['Buy birthday present']) && same(await titles(page, 'paused'), ['Oil change']));
  check('me: Done lists what was ticked off in the last 2 weeks (not the shed, done in September)', same(await titles(page, 'done'), ['Return library books']), (await titles(page, 'done')).join(','));
  check('me: the group headings carry counts', (await tc(page, '[data-group="late"] .sec-head')) === 'Late2' && (await tc(page, '[data-group="done"] .sec-head')) === 'Done in the last 2 weeks1');
  check('rows: late ones show their day (household dates), today\'s its time, the inbox "No date"',
    same(await texts(page, '[data-group="late"] .irow-time'), ['Tue Oct 20', 'Fri Oct 23']) && (await text(page, '[data-group="today"] .irow-time')) === '9:00am'
    && (await text(page, '[data-group="inbox"] .irow-time')) === 'No date' && (await text(page, '[data-group="coming"] .irow-time')) === 'Wed Oct 28',
    JSON.stringify([await texts(page, '[data-group="late"] .irow-time'), await text(page, '[data-group="today"] .irow-time')]));
  check('rows: a late one has the Late badge; a repeating one says how it repeats',
    /Late/.test(await rowFor(page, 'late', 'Renew passport').innerText()) && /Every 60 days after it's done/.test(await rowFor(page, 'late', 'furnace').innerText()));
  check('rows: the linked contact\'s phone is tap-to-call; the project is named', (await rowFor(page, 'today', 'plumber').locator('.irow-call').getAttribute('href')) === 'tel:2015550100'
    && /Kitchen Renovation/.test(await rowFor(page, 'coming', 'tiles').innerText()));
  check('rows: open ones have an unticked box; a paused one has none and a Paused badge',
    (await rowFor(page, 'today', 'plumber').locator('.irow-check').getAttribute('aria-checked')) === 'false'
    && (await rowFor(page, 'paused', 'Oil change').locator('.irow-check').count()) === 0 && /Paused/.test(await rowFor(page, 'paused', 'Oil change').innerText()));
  const books = rowFor(page, 'done', 'Return library books');
  check('done: ticked (a tap asks to mark it not done, section 6b), on the day it was done ("Yesterday", the household\'s), by whom',
    (await books.locator('.irow-check').getAttribute('aria-checked')) === 'true' && !(await books.locator('.irow-check').isDisabled())
    && (await books.locator('.irow-time').innerText()) === 'Yesterday' && /by Sam/.test(await books.innerText()), await books.innerText());
  check('me: no who dots on my own list', (await page.locator('.tasks-body .irow-who').count()) === 0);
  const sizes = await page.$$eval('.tasks-chips .pchip, .irow-check, .tasks-menu, .tasks-add, .irow-main, .irow-call', (es) => es.map((e) => { const r = e.getBoundingClientRect(); return [e.className, Math.round(r.width), Math.round(r.height)]; }));
  check('targets: chips, tick boxes, menus, Add and rows are at least 44px', sizes.length > 20 && sizes.every(([, w, h]) => h >= 44 && w >= 44), JSON.stringify(sizes.filter(([, w, h]) => h < 44 || w < 44)));
  await page.screenshot({ path: SHOTS + 'tasks-me.png', fullPage: true });

  // =====================================================================
  // 2. Everyone, a person, Coming up's "Show more", the address follows the filter
  // =====================================================================
  await chip(page, 'Everyone').click();
  await page.waitForTimeout(150);
  check('everyone: the address follows the chip (no reload)', (await page.evaluate(() => location.hash)) === '#/tasks/everyone' && same(await pressed(page), ['Everyone']));
  check('everyone: Coming up lists the next 4 weeks in date order', same(await titles(page, 'coming'), ['Take out recycling', 'Pick up tiles', 'Plan surprise party', 'Heartworm preventive', 'Paint the fence']),
    (await titles(page, 'coming')).join(','));
  check('everyone: "Tomorrow" for the next day; later ones wait behind "Show 1 more"', (await rowFor(page, 'coming', 'recycling').locator('.irow-time').innerText()) === 'Tomorrow'
    && (await text(page, '[data-act="later"]')) === 'Show 1 more, after Nov 22' && (await tc(page, '[data-group="coming"] .sec-count')) === '6');
  check('everyone: who dots show who\'s in charge; a private one says so', (await rowFor(page, 'coming', 'recycling').locator('.irow-who .pdot.ring').count()) === 1
    && /Private/.test(await rowFor(page, 'coming', 'surprise party').innerText()));
  await page.click('[data-act="later"]');
  await page.waitForTimeout(150);
  const heater = rowFor(page, 'coming', 'water heater');
  check('everyone: "Show more" adds the later ones; another year shows its year', (await titles(page, 'coming')).length === 6
    && (await heater.locator('.irow-time').innerText()) === 'Mar 10\n2027', await heater.locator('.irow-time').innerText());
  check('everyone: Done is newest first, with My day ticks and skips', same(await titles(page, 'done'), ['Return library books', 'Take out recycling', 'Take out recycling'])
    && /by Jordan on My day/.test(await page.locator('[data-group="done"] .irow').nth(1).innerText())
    && /Skipped/.test(await page.locator('[data-group="done"] .irow').nth(2).innerText()), (await texts(page, '[data-group="done"] .irow')).join(' | '));
  await chip(page, 'Sam').click();
  await page.waitForTimeout(150);
  check('person: only Sam\'s tasks, and the address names Sam', same(await titles(page, 'coming'), ['Plan surprise party', 'Heartworm preventive'])
    && (await page.evaluate(() => location.hash)) === `#/tasks/${ID.sam}` && same(await pressed(page), ['Sam']) && !(await page.$('[data-group="late"]')));
  await page.reload();
  await page.waitForTimeout(700);
  check('person: a reload keeps the filter', same(await pressed(page), ['Sam']) && same(await titles(page, 'coming'), ['Plan surprise party', 'Heartworm preventive']));
  await go(page, '#/');
  await go(page, '#/tasks');
  check('filter: kept while the app is open (back to Tasks shows Sam\'s)', same(await pressed(page), ['Sam']));
  await chip(page, 'Me').click();
  await page.waitForTimeout(150);

  // =====================================================================
  // 3. One tap: done with Undo; repeating ones move on; someone else got there first; errors
  // =====================================================================
  await rowFor(page, 'today', 'plumber').locator('.irow-check').click();
  await page.waitForTimeout(600);
  const plumberCall = calls(db, 'complete_task').slice(-1)[0];
  check('tick: complete_task with the task and the date on screen (done today)', same(plumberCall.body, { p_id: db.K.plumber.id, p_occurrence: TODAY, p_done_on: null }), JSON.stringify(plumberCall.body));
  check('tick: "Done · Undo" toast, and the task moves to Done', (await lastToast(page)) === 'Done: Call the plumber\nUndo' && !(await page.$('[data-group="today"]'))
    && (await titles(page, 'done'))[0] === 'Call the plumber', await lastToast(page));
  const plumberLog = db.task_log.slice(-1)[0].id;
  await undoToast(page);
  check('tick: Undo calls undo_task with the log id and puts it back', same(calls(db, 'undo_task').slice(-1)[0].body, { p_log_id: plumberLog })
    && (await lastToast(page)) === 'Not done: Call the plumber' && same(await titles(page, 'today'), ['Call the plumber']) && !db.K.plumber.done_at);

  await rowFor(page, 'late', 'furnace').locator('.irow-check').click();
  await page.waitForTimeout(600);
  check('tick (after done): next due is 60 days from today, and the toast says so', db.K.filter.due_date === '2026-12-24' && db.K.filter.last_done === TODAY
    && (await lastToast(page)) === 'Done: Change the furnace/AC filter · next Dec 24\nUndo' && same(await titles(page, 'late'), ['Renew passport']), `${db.K.filter.due_date} ${await lastToast(page)}`);
  await undoToast(page);
  check('tick (after done): Undo restores the due date and last done', db.K.filter.due_date === '2026-10-23' && db.K.filter.last_done === '2026-08-24');

  // Someone else ticked it off a moment ago: the screen is out of date.
  expect.failures = true;
  db.K.plumber.done_at = '2026-10-25T11:00:00.000000+00:00';
  await rowFor(page, 'today', 'plumber').locator('.irow-check').click();
  await page.waitForTimeout(600);
  check('tick: already done elsewhere → a plain note and the latest list, not an error', (await toasts(page)).some((t) => t === 'Someone already ticked that off. This is the latest.')
    && !(await page.$('[data-group="today"]')) && (await titles(page, 'done')).includes('Call the plumber'), (await toasts(page)).join(' | '));
  db.K.plumber.done_at = null;
  await go(page, '#/');
  await go(page, '#/tasks/me');
  db.completeFail = true;
  await rowFor(page, 'today', 'plumber').locator('.irow-check').click();
  await page.waitForTimeout(500);
  check('tick: a failed save unticks the box and shows why', (await rowFor(page, 'today', 'plumber').locator('.irow-check').getAttribute('aria-checked')) === 'false'
    && (await toasts(page)).includes('Database restarting'), (await toasts(page)).join(' | '));
  db.completeFail = false;
  expect.failures = false;
  await page.context().close();

  // =====================================================================
  // 4. The row menu: details, skip, another day, pause/resume, delete, undo from Done
  // =====================================================================
  ({ page, db, expect } = await open({ label: 'menu', path: '/#/tasks/everyone' }));
  await openMenu(page, 'coming', 'Heartworm');
  const det = await flat(page, '#detail .tasks-details dl');
  check('details: due, how it repeats, last done, who\'s in charge', /^Due Sunday, November 1 Repeats Every month on the 1st Last done Friday, October 2 In charge .*Sam Example$/.test(det), det);
  check('details: the actions for an open repeating task', same(await page.$$eval('#detail .tasks-actions [data-act]', (es) => es.map((e) => e.textContent)),
    ['Mark done', 'Done on another day', 'Skip this time', 'Edit', 'Pause', 'Delete']));
  const actSizes = await page.$$eval('#detail .tasks-actions .btn, #detail .d-close', (es) => es.map((e) => Math.round(e.getBoundingClientRect().height)));
  check('details: every action is at least 44px tall', actSizes.every((h) => h >= 44), actSizes.join(','));
  await act(page, 'skip');
  check('skip: skip_task with the date on screen; it moves to the next set date', same(calls(db, 'skip_task').slice(-1)[0].body, { p_id: db.K.heartworm.id, p_occurrence: '2026-11-01' })
    && db.K.heartworm.due_date === '2026-12-01' && !(await detailOpen(page)) && (await lastToast(page)) === 'Skipped: Heartworm preventive · next Dec 1\nUndo', await lastToast(page));
  await undoToast(page);
  check('skip: Undo puts the date back', db.K.heartworm.due_date === '2026-11-01' && (await lastToast(page)) === 'Heartworm preventive is due Sun Nov 1 again', await lastToast(page));

  await openMenu(page, 'late', 'Renew passport');
  check('details: a one-off has no Skip or Pause; its day picker stops at today', same(await page.$$eval('#detail .tasks-actions [data-act]', (es) => es.map((e) => e.textContent)),
    ['Mark done', 'Done on another day', 'Edit', 'Delete']) && (await page.getAttribute('#detail [name="done_on"]', 'max')) === TODAY);
  await act(page, 'another');
  await page.fill('#detail [name="done_on"]', '2026-10-27');
  await act(page, 'done-on');
  check('another day: a day still to come is refused before anything is sent', (await text(page, '#detail .form-error')) === "That day hasn't happened yet. Pick today or earlier."
    && !calls(db, 'complete_task').length);
  await page.fill('#detail [name="done_on"]', '2026-10-22');
  await act(page, 'done-on');
  check('another day: complete_task with that day; "Done on Oct 22" with Undo', same(calls(db, 'complete_task').slice(-1)[0].body, { p_id: db.K.passport.id, p_occurrence: '2026-10-20', p_done_on: '2026-10-22' })
    && (await lastToast(page)) === 'Done on Oct 22: Renew passport\nUndo' && (await rowFor(page, 'done', 'Renew passport').locator('.irow-time').innerText()) === 'Thu Oct 22', await lastToast(page));

  await openMenu(page, 'coming', 'recycling');
  await act(page, 'pause');
  check('pause: active = false; it moves to Paused without a box', same(lastWrite(db, 'PATCH').body, { active: false }) && db.K.recycling.active === false
    && (await lastToast(page)) === 'Paused: Take out recycling\nUndo' && (await titles(page, 'paused')).includes('Take out recycling')
    && (await rowFor(page, 'paused', 'recycling').locator('.irow-check').count()) === 0, await lastToast(page));
  await openMenu(page, 'paused', 'Oil change');
  check('details: a paused one offers Resume (no Mark done)', same(await page.$$eval('#detail .tasks-actions [data-act]', (es) => es.map((e) => e.textContent)), ['Edit', 'Resume', 'Delete']));
  await act(page, 'resume');
  check('resume: active = true; back in Coming up with its box', db.K.oil.active === true && (await lastToast(page)) === 'Back on: Oil change\nUndo'
    && !(await titles(page, 'paused')).includes('Oil change'));
  await undoToast(page);
  check('resume: Undo pauses it again', db.K.oil.active === false && (await lastToast(page)) === 'Paused again: Oil change');

  await openMenu(page, 'coming', 'Paint the fence');
  await act(page, 'delete');
  check('delete: asks first, then deletes; "Deleted" with Undo', /^Delete "Paint the fence"\?$/.test((db.confirms || []).slice(-1)[0] || '')
    && !db.tasks.some((x) => x.title === 'Paint the fence') && (await lastToast(page)) === 'Deleted Paint the fence\nUndo');
  await undoToast(page);
  const fence = db.tasks.find((x) => x.title === 'Paint the fence');
  check('delete: Undo puts the same row back', !!fence && fence.id === db.K.fence.id && fence.due_date === '2026-11-15' && (await lastToast(page)) === 'Paint the fence is back on the list');

  const booksLog = db.task_log.find((l) => l.task_id === db.K.books.id).id;
  await rowFor(page, 'done', 'Return library books').locator('.irow-main').click();
  await page.waitForTimeout(150);
  check('done details: when, by whom, and Undo', /Done Saturday, October 24 · Sam/.test(await flat(page, '#detail dl')) && (await text(page, '#detail [data-act="undo"]')) === 'Not done after all');
  await page.click('#detail [data-act="undo"]');
  await page.waitForTimeout(500);
  check('done undo: undo_task with that entry; the task is open again (late)', same(calls(db, 'undo_task').slice(-1)[0].body, { p_log_id: booksLog })
    && !db.K.books.done_at && (await titles(page, 'late')).includes('Return library books') && (await lastToast(page)) === 'Not done: Return library books', await lastToast(page));
  // A skip that isn't the task's latest entry can't be undone: the database says why.
  expect.failures = true;
  await page.locator('[data-group="done"] .irow', { hasText: 'Skipped' }).locator('.tasks-menu').click();
  await page.click('#detail [data-act="undo"]');
  await page.waitForTimeout(400);
  check('done undo: the database\'s reason shows in the dialog', (await text(page, '#detail .form-error')) === 'Only the latest change to a task can be undone.' && await detailOpen(page));
  expect.failures = false;
  await page.keyboard.press('Escape');
  check('writes: every row sent fits the tasks table', !db.refused.length, db.refused.join(','));
  await page.context().close();

  // =====================================================================
  // 5. Repeating: grouped by kind, cadence text, the starter list
  // =====================================================================
  ({ page, db } = await open({ label: 'repeating', path: '/#/tasks/repeating' }));
  const repHeads = await headings(page);
  check('repeating: grouped Home, Pets, Car, Family', same(repHeads, ['Home', 'Pets', 'Car', 'Family']), repHeads.join(','));
  const sub = async (title) => (await page.locator('.tasks-body .irow', { hasText: title }).first().locator('.tasks-sub').innerText()).trim();
  check('repeating: "Every 60 days after it\'s done" with when it was due', (await sub('furnace')) === 'Every 60 days after it\'s done · was due Oct 23', await sub('furnace'));
  check('repeating: the rule itself, with its day: "Every month on the 1st · next Nov 1"', (await sub('Heartworm')) === 'Every month on the 1st · next Nov 1', await sub('Heartworm'));
  check('repeating: weekly on set days, and another year\'s date', (await sub('recycling')) === 'Every Monday and Thursday · next Oct 26'
    && (await sub('water heater')) === 'Every 12 months after it\'s done · next Mar 10, 2027', `${await sub('recycling')} / ${await sub('water heater')}`);
  check('repeating: a paused one is marked', /Paused/.test(await page.locator('.tasks-body .irow', { hasText: 'Oil change' }).innerText()) && (await sub('Oil change')) === 'Every 6 months on the 1st · next Dec 1', await sub('Oil change'));
  await page.click('[data-act="starter"]');
  await page.waitForTimeout(200);
  const starter = await page.evaluate(() => ({
    legends: [...document.querySelectorAll('.tasks-starter legend')].map((l) => l.textContent),
    boxes: document.querySelectorAll('.tasks-starter input[name="pick"]').length,
    have: [...document.querySelectorAll('.tasks-starter .is-have b')].map((b) => b.textContent),
    owners: [...document.querySelectorAll('.tasks-starter .tasks-hint')].map((h) => h.textContent),
    submit: document.querySelector('.tasks-starter [type="submit"]').disabled,
  }));
  check('starter: Home and Pets, the ones already on the list shown as such', same(starter.legends, ['Home', 'Pets']) && starter.boxes === 17
    && same(starter.have, ['Change the furnace/AC filter', 'Flush the water heater', 'Heartworm preventive']), JSON.stringify(starter));
  check('starter: says who will be in charge (the house and pets owners from Settings)', /^Alex will be in charge/.test(starter.owners[0]) && /^Sam will be in charge/.test(starter.owners[1]) && starter.submit);
  check('starter: each says how it repeats', /Every 12 months after it's done, heads-up 21 days before/.test(await text(page, '.tasks-starter label:has(input[value="vet"])'))
    && /Every year, starting in October/.test(await text(page, '.tasks-starter label:has(input[value="heat-tuneup"])')), await text(page, '.tasks-starter label:has(input[value="heat-tuneup"])'));
  await page.click('.tasks-starter [data-act="all"]');
  check('starter: Tick all; the button counts them', (await text(page, '.tasks-starter [type="submit"]')) === 'Add 17 tasks' && (await text(page, '.tasks-starter [data-act="all"]')) === 'Untick all');
  const sizesS = await page.$$eval('.tasks-starter .tasks-pick, .tasks-starter .btn, .tasks-starter .d-close', (es) => es.map((e) => Math.round(e.getBoundingClientRect().height)));
  check('starter: rows and buttons are at least 44px tall', sizesS.every((h) => h >= 44), sizesS.join(','));
  await page.click('.tasks-starter [type="submit"]');
  await page.waitForTimeout(700);
  const added = lastWrite(db, 'POST').body;
  const byKey = (title) => added.find((r) => r.title === title) || {};
  const perDay = added.reduce((m, r) => m.set(r.due_date, (m.get(r.due_date) || 0) + 1), new Map());
  const plain = added.filter((r) => !/tune-up|gutters/.test(r.title));
  check('starter: one insert with the 17 ticked', Array.isArray(added) && added.length === 17 && !(await formOpen(page)));
  check('starter: every row fits the tasks table (repeat, count, unit, due date)', added.every((r) => !tableCheck(tasksDefaults(Object.assign({}, TASK_DEFAULTS, r))) && r.repeat_mode !== 'none' && r.every_count && r.every_unit && r.due_date) && !db.refused.length, db.refused.join(','));
  check('starter: never more than 2 on one day', Math.max(...perDay.values()) <= 2, JSON.stringify([...perDay]));
  check('starter: the rest spread over the 4 weeks from tomorrow', plain.length === 13 && plain.every((r) => r.due_date >= '2026-10-26' && r.due_date <= '2026-11-22')
    && plain.some((r) => r.due_date === '2026-10-26') && plain.some((r) => r.due_date >= '2026-11-19'), plain.map((r) => r.due_date).join(','));
  check('starter: seasonal ones start in their month', byKey('Heating tune-up (HVAC service)').due_date === '2026-10-26' && byKey('Cooling tune-up (HVAC service)').due_date === '2027-04-01'
    && byKey('Clean the gutters (spring)').due_date === '2027-04-01' && byKey('Clean the gutters (fall)').due_date === '2026-11-01',
    JSON.stringify(added.filter((r) => /tune-up|gutters/.test(r.title)).map((r) => [r.title, r.due_date])));
  check('starter: home ones to the house owner, pet ones to the pets owner', added.filter((r) => r.category === 'home').every((r) => r.responsible_id === ID.alex)
    && added.filter((r) => r.category === 'pets').every((r) => r.responsible_id === ID.sam));
  check('starter: how each repeats (vet: 12 months after done, 21 days heads-up; nails 4 weeks; GFCI monthly on set dates)',
    same([byKey('Vet wellness visit').repeat_mode, byKey('Vet wellness visit').every_count, byKey('Vet wellness visit').every_unit, byKey('Vet wellness visit').lead_days], ['after_done', 12, 'month', 21])
    && same([byKey('Pet nail trim').every_count, byKey('Pet nail trim').every_unit], [4, 'week']) && same([byKey('Test the GFCI outlets').repeat_mode, byKey('Test the GFCI outlets').every_unit], ['schedule', 'month']));
  check('starter: "Added 17 · first due tomorrow" with Undo, and they\'re on the page', (await lastToast(page)) === 'Added 17 repeating tasks · the first is due tomorrow\nUndo'
    && (await page.locator('.tasks-body .irow').count()) === 22, `${await lastToast(page)} ${await page.locator('.tasks-body .irow').count()}`);
  await undoToast(page);
  check('starter: Undo deletes exactly those', db.tasks.length === 13 && /^DELETE/.test(lastWrite(db, 'DELETE').method) && /id=in\./.test(lastWrite(db, 'DELETE').url)
    && (await lastToast(page)) === 'Took 17 starter tasks off the list', await lastToast(page));
  await page.context().close();

  // =====================================================================
  // 6. Project view, deep links
  // =====================================================================
  ({ page, db } = await open({ label: 'project', path: '/#/tasks/project' }));
  check('project: each project with its open tasks and a link to it', same(await headings(page), ['Kitchen Renovation'])
    && same(await page.$$eval('.tasks-body .irow-title', (es) => es.map((e) => e.firstChild.textContent)), ['Pick up tiles'])
    && (await page.getAttribute('.tasks-proj-head .tasks-link', 'href')) === '#/projects/p-kitchen' && same(await pressed(page), ['Project']));
  await go(page, '#/tasks/project/p-sprinkler');
  check('project: one project from the address; nothing on it says so, with a way back', /No open tasks on Sprinkler winterization\./.test(await text(page, '.tasks-empty'))
    && (await page.getAttribute('.tasks-body .tasks-link', 'href')) === '#/tasks/project');
  await go(page, `#/tasks/${db.K.tiles.id}`);
  check('deep link: #/tasks/<id> opens that task', await detailOpen(page) && (await text(page, '#dTitle')) === 'Pick up tiles' && /Heads-up 2 days before/.test(await flat(page, '#detail dl'))
    && /Project Kitchen Renovation/.test(await flat(page, '#detail dl')), await flat(page, '#detail dl'));
  await page.keyboard.press('Escape');
  await go(page, '#/tasks/0a1e0000-0000-4000-8000-0000000000ff');
  check('deep link: an unknown id says so and shows the list', (await toasts(page)).includes("That task isn't on the list any more. Here's the latest.") && !!(await page.$('.tasks-chips')));
  await page.context().close();

  // =====================================================================
  // 6b. How other repeats read; a done task's Done entry from its address; unticking from Done
  // =====================================================================
  db = tasksDb();
  const extra = (o) => db.tasks.push(Object.assign(task(o), { repeat_mode: 'schedule' }));
  extra({ title: 'Renew the car registration', due_date: '2026-11-01', anchor_date: '2025-11-01', category: 'vehicle', every_count: 1, every_unit: 'year' });
  extra({ title: 'Pay the rent', due_date: '2026-10-31', anchor_date: '2026-01-31', category: 'home', every_count: 1, every_unit: 'month' });
  extra({ title: 'Water the ferns', due_date: '2026-10-27', anchor_date: '2026-10-27', category: 'home', every_count: 3, every_unit: 'day' });
  extra({ title: 'Mow the lawn', due_date: '2026-10-31', anchor_date: '2026-10-17', category: 'home', every_count: 2, every_unit: 'week' });
  extra({ title: 'Walk the dog', due_date: '2026-10-26', anchor_date: '2026-10-05', category: 'pets', every_count: 1, every_unit: 'week', repeat_weekdays: [1, 2, 3, 4, 5] });
  ({ page, db } = await open({ label: 'rules', db, path: '/#/tasks/repeating' }));
  const rule = async (title) => (await page.locator('.tasks-body .irow', { hasText: title }).first().locator('.tasks-sub').innerText()).trim().split(' · ')[0];
  const rules = [];
  for (const t of ['car registration', 'rent', 'ferns', 'lawn', 'dog']) rules.push(await rule(t));
  check('repeating: every year on its date, every month on its day (or the last), every N days, every 2 weeks on its day, every weekday',
    same(rules, ['Every year on Nov 1', 'Every month on the 31st (or the month\'s last day)', 'Every 3 days', 'Every 2 weeks on Saturday', 'Every weekday']), JSON.stringify(rules));
  await page.context().close();

  ({ page, db } = await open({ label: 'done-link', path: '/#/tasks/repeating' }));
  await go(page, `#/tasks/${db.K.books.id}/done`);
  check('done link: #/tasks/<id>/done opens its Done entry with "Not done after all"', await detailOpen(page) && (await text(page, '#dTitle')) === 'Return library books'
    && (await text(page, '#detail [data-act="undo"]')) === 'Not done after all', await flat(page, '#detail'));
  check('done link: the list behind it is one that has it (not Repeating, where a one-off isn\'t)', same(await pressed(page), ['Me']) && (await titles(page, 'done')).includes('Return library books'),
    JSON.stringify(await pressed(page)));
  await page.keyboard.press('Escape');
  await go(page, `#/tasks/${db.K.books.id}`);
  check('done link: #/tasks/<id> for a task that\'s done opens its Done entry too', await detailOpen(page) && (await text(page, '#detail [data-act="undo"]')) === 'Not done after all'
    && !(await toasts(page)).some((t) => /isn't on the list/.test(t)));
  await page.keyboard.press('Escape');
  const booksEntry = db.task_log.find((l) => l.task_id === db.K.books.id).id;
  const box = rowFor(page, 'done', 'Return library books').locator('.irow-check');
  check('done list: the ticked box can be tapped', (await box.getAttribute('aria-checked')) === 'true' && !(await box.isDisabled()));
  await box.click();
  await page.waitForTimeout(600);
  check('done list: a tap asks, then undoes that entry; the task is open again', /Mark "Return library books" as not done\?/.test((db.confirms || []).join('|'))
    && same(calls(db, 'undo_task').slice(-1)[0].body, { p_log_id: booksEntry }) && !db.K.books.done_at && (await titles(page, 'late')).includes('Return library books')
    && (await lastToast(page)) === 'Not done: Return library books', await lastToast(page));
  await page.context().close();

  for (const width of [375, 360]) {
    ({ page, db } = await open({ label: `form-${width}`, ctx: Object.assign({}, phone, { viewport: { width, height: 800 } }), path: '/#/tasks/everyone' }));
    await page.click('.bottombar .bb-add').catch(() => {});
    await page.waitForTimeout(200);
    if (await page.isVisible('#sheet [data-add="task"]')) await page.click('#sheet [data-add="task"]');
    else await page.click('[data-act="add"]');
    await page.waitForTimeout(300);
    await page.click('.tasks-form [data-mode="schedule"]');
    await page.selectOption('.tasks-form [name="every_unit"]', 'week');
    const fit = await page.evaluate(() => {
      const form = document.querySelector('.tasks-form');
      const days = [...form.querySelectorAll('[data-wd]')].map((b) => b.getBoundingClientRect());
      return { sw: form.scrollWidth, cw: form.clientWidth, lastRight: Math.round(days[days.length - 1].right), right: Math.round(form.getBoundingClientRect().right), minH: Math.min(...days.map((d) => d.height)) };
    });
    check(`form (${width}px): the weekday buttons fit without sideways scroll, each 44px tall`, fit.sw <= fit.cw && fit.lastRight <= fit.right && fit.minH >= 44 && await noSideScroll(page), JSON.stringify(fit));
    await page.screenshot({ path: SHOTS + `tasks-form-weekdays-${width}.png` });
    await page.context().close();
  }

  // =====================================================================
  // 7. The task form
  // =====================================================================
  ({ page, db, expect } = await open({ label: 'form' }));
  await page.click('[data-act="add"]');
  await page.waitForTimeout(300);
  const fresh = await page.evaluate(() => {
    const f = document.querySelector('.tasks-form');
    return {
      title: f.querySelector('h3').textContent,
      legend: f.querySelector('[data-ref="when-label"]').textContent,
      when: [...f.querySelectorAll('[data-when]')].filter((b) => !b.hidden).map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`),
      time: f.querySelector('[data-show="time"]').hidden,
      every: f.querySelector('[data-show="every"]').hidden,
      ring: [...f.querySelectorAll('.pchip.ring .pchip-name')].map((e) => e.textContent),
      modes: [...f.querySelectorAll('[data-mode]')].map((b) => `${b.querySelector('b').textContent}:${b.getAttribute('aria-pressed')}`),
    };
  });
  check('form (new): When offers No date (chosen), Today, Tomorrow or a date; no time until there\'s a date',
    fresh.title === 'New task' && fresh.legend === 'When' && same(fresh.when, ['No date:true', 'Today:false', 'Tomorrow:false']) && fresh.time && fresh.every, JSON.stringify(fresh));
  check('form (new): on Me, I\'m in charge to start with; repeats: none', same(fresh.ring, ['Alex']) && same(fresh.modes, ["Doesn't repeat:true", 'On set dates:false', "A while after it's done:false"]));
  await page.click('.tasks-form [type="submit"]');
  check('form: a name is needed (nothing sent)', (await text(page, '.tasks-form .form-error')) === 'Give the task a name.' && !lastWrite(db, 'POST'));
  await page.fill('.tasks-form [name="title"]', 'Book the chimney sweep');
  await page.click('.tasks-form [data-when="tomorrow"]');
  check('form: a date shows the optional time', !(await page.$eval('.tasks-form [data-show="time"]', (e) => e.hidden)) && (await page.inputValue('.tasks-form [name="when_date"]')) === '2026-10-26');
  await page.fill('.tasks-form [name="due_time"]', '10:30');
  await page.click('.tasks-form .tasks-more summary');
  await page.selectOption('.tasks-form [name="contractor_id"]', 'c-maria');
  check('form: Put on project lists the projects still going (not done ones)', same(await page.$$eval('.tasks-form [name="project_id"] option', (os) => os.map((o) => o.textContent)), ['No project', 'Kitchen Renovation', 'Sprinkler winterization']));
  await page.selectOption('.tasks-form [name="project_id"]', 'p-kitchen');
  await page.fill('.tasks-form [name="lead_days"]', '3');
  await page.selectOption('.tasks-form [name="category"]', 'home');
  await page.fill('.tasks-form [name="notes"]', 'Ask about the cap <b>too</b>');
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(600);
  const sweep = lastWrite(db, 'POST').body;
  check('form (new one-off): the row sent', same(sweep, {
    title: 'Book the chimney sweep', category: 'home', responsible_id: ID.alex, lead_days: 3, project_id: 'p-kitchen', contractor_id: 'c-maria',
    notes: 'Ask about the cap <b>too</b>', private: false, repeat_mode: 'none', due_date: '2026-10-26', due_time: '10:30',
    every_count: null, every_unit: null, repeat_weekdays: [], anchor_date: null,
  }), JSON.stringify(sweep));
  check('form (new one-off): "Added … · due tomorrow"; it\'s on the list', (await lastToast(page)) === 'Added Book the chimney sweep · due tomorrow' && (await titles(page, 'coming')).includes('Book the chimney sweep') && !(await formOpen(page)));

  // On set dates, weekly: the due date's day is always in.
  await page.click('[data-act="add"]');
  await page.waitForTimeout(300);
  await page.fill('.tasks-form [name="title"]', 'Water the plants');
  await page.click('.tasks-form [data-mode="schedule"]');
  await page.fill('.tasks-form [name="every_count"]', '1');
  await page.selectOption('.tasks-form [name="every_unit"]', 'week');
  const sched = await page.evaluate(() => {
    const f = document.querySelector('.tasks-form');
    return {
      legend: f.querySelector('[data-ref="when-label"]').textContent,
      when: [...f.querySelectorAll('[data-when]')].filter((b) => !b.hidden).map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`),
      wdays: !f.querySelector('.tasks-wdays').hidden,
      sun: [f.querySelector('[data-wd="7"]').getAttribute('aria-pressed'), f.querySelector('[data-wd="7"]').getAttribute('aria-disabled')],
    };
  });
  check('form (set dates): "Next one is due", today to start with; weekdays, today\'s day always in', sched.legend === 'Next one is due' && same(sched.when, ['Today:true', 'Tomorrow:false'])
    && sched.wdays && same(sched.sun, ['true', 'true']), JSON.stringify(sched));
  await page.click('.tasks-form [data-wd="3"]');
  check('form (set dates): the hint says how it goes on', (await text(page, '.tasks-form [data-ref="due-hint"]')) === "After that: every Wednesday and Sunday, whether or not it's done on time.", await text(page, '.tasks-form [data-ref="due-hint"]'));
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(600);
  const plants = lastWrite(db, 'POST').body;
  check('form (set dates): repeat, count, unit, weekdays and due date sent', plants.repeat_mode === 'schedule' && plants.due_date === TODAY && plants.every_count === 1
    && plants.every_unit === 'week' && same(plants.repeat_weekdays, [3, 7]) && plants.due_time === null && !('anchor_date' in plants) && !db.refused.length, JSON.stringify(plants));

  // A while after it's done: "When was it last done?" works out the due date.
  await page.click('[data-act="add"]');
  await page.waitForTimeout(300);
  await page.fill('.tasks-form [name="title"]', 'Replace the toothbrush heads');
  await page.click('.tasks-form [data-mode="after_done"]');
  const after = await page.evaluate(() => {
    const f = document.querySelector('.tasks-form');
    return {
      legend: f.querySelector('[data-ref="when-label"]').textContent,
      when: [...f.querySelectorAll('[data-when]')].filter((b) => !b.hidden).map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`),
      time: f.querySelector('[data-show="time"]').hidden,
      year: f.querySelector('[name="every_unit"] option[value="year"]').disabled,
      max: f.querySelector('[name="when_date"]').max,
      hint: f.querySelector('[data-ref="due-hint"]').textContent,
    };
  });
  check('form (after done): "When was it last done?" with Not sure, Today, Yesterday; no time; no years; not after today', after.legend === 'When was it last done?'
    && same(after.when, ['Not sure:true', 'Today:false', 'Yesterday:false']) && after.time && after.year && after.max === TODAY, JSON.stringify(after));
  check('form (after done): not sure → due today', after.hint === "Not sure? Then it's due today. After that: every month after it's done.", after.hint);
  await page.fill('.tasks-form [name="every_count"]', '3');
  await page.fill('.tasks-form [name="when_date"]', '2026-09-01');
  check('form (after done): last done Sep 1, every 3 months → due Dec 1', (await text(page, '.tasks-form [data-ref="due-hint"]')) === 'So the next one is due Tuesday, December 1.', await text(page, '.tasks-form [data-ref="due-hint"]'));
  await page.fill('.tasks-form [name="when_date"]', '2026-05-01');
  check('form (after done): long ago → it says it\'s late', (await text(page, '.tasks-form [data-ref="due-hint"]')) === "So it's late: it was due Saturday, August 1.");
  await page.fill('.tasks-form [name="when_date"]', '2026-09-01');
  // Who: tap Sam (in charge), again (nobody), then Jordan.
  await page.locator('.tasks-form .pchip', { hasText: 'Sam' }).click();
  await page.locator('.tasks-form .pchip', { hasText: 'Sam' }).click();
  check('form: tapping the person in charge again leaves nobody', (await page.getAttribute('.tasks-form [data-nobody]', 'aria-pressed')) === 'true' && !(await page.$('.tasks-form .pchip.ring')));
  await page.locator('.tasks-form .pchip', { hasText: 'Jordan' }).click();
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(600);
  const brush = lastWrite(db, 'POST').body;
  check('form (after done): the row sent (due worked out, last done kept)', brush.repeat_mode === 'after_done' && brush.due_date === '2026-12-01' && brush.last_done === '2026-09-01'
    && brush.every_count === 3 && brush.every_unit === 'month' && brush.due_time === null && brush.responsible_id === ID.jordan && !db.refused.length, JSON.stringify(brush));
  check('form (after done): toast names the due date', (await lastToast(page)) === 'Added Replace the toothbrush heads · due Tue Dec 1', await lastToast(page));

  // A day still to come for "last done" is refused before anything is sent.
  await page.click('[data-act="add"]');
  await page.waitForTimeout(300);
  await page.fill('.tasks-form [name="title"]', 'Descale the kettle');
  await page.click('.tasks-form [data-mode="after_done"]');
  await page.evaluate(() => { const i = document.querySelector('.tasks-form [name="when_date"]'); i.value = '2026-10-30'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  const before = db.writes.length;
  await page.click('.tasks-form [type="submit"]');
  check('form (after done): a future "last done" is refused', /hasn't happened yet/.test(await text(page, '.tasks-form .form-error')) && db.writes.length === before);
  await page.fill('.tasks-form [name="every_count"]', '0');
  await page.click('.tasks-form [data-when="unsure"]');
  await page.click('.tasks-form [type="submit"]');
  check('form: how often must be 1 to 120', (await text(page, '.tasks-form .form-error')) === 'How often? Enter a whole number from 1 to 120.' && db.writes.length === before);
  await page.click('.tasks-form [data-close]');

  // Edit: a schedule task keeps its date (so its series keeps its anchor) unless the date changes.
  await go(page, '#/tasks/everyone');
  await openMenu(page, 'coming', 'Heartworm');
  await act(page, 'edit');
  await page.waitForTimeout(300);
  const edit = await page.evaluate(() => {
    const f = document.querySelector('.tasks-form');
    return {
      title: f.querySelector('h3').textContent, name: f.querySelector('[name="title"]').value,
      legend: f.querySelector('[data-ref="when-label"]').textContent, date: f.querySelector('[name="when_date"]').value,
      every: [f.querySelector('[name="every_count"]').value, f.querySelector('[name="every_unit"]').value],
      mode: f.querySelector('[data-mode][aria-pressed="true"]').dataset.mode,
      ring: [...f.querySelectorAll('.pchip.ring .pchip-name')].map((e) => e.textContent),
      category: f.querySelector('[name="category"]').value, del: !!f.querySelector('[data-act="delete"]'),
    };
  });
  check('form (edit): filled in from the task', same(edit, { title: 'Edit task', name: 'Heartworm preventive', legend: 'Next one is due', date: '2026-11-01', every: ['1', 'month'], mode: 'schedule', ring: ['Sam'], category: 'pets', del: true }), JSON.stringify(edit));
  await page.fill('.tasks-form [name="title"]', 'Heartworm pill');
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(600);
  const patch = lastWrite(db, 'PATCH');
  check('form (edit): PATCH that task with the same due date (no re-anchoring); "Saved"', patch.url.endsWith(`tasks?id=eq.${db.K.heartworm.id}&select=*`) && patch.body.due_date === '2026-11-01'
    && patch.body.title === 'Heartworm pill' && db.K.heartworm.anchor_date === '2026-11-01' && (await lastToast(page)) === 'Saved Heartworm pill', `${patch.url} ${await lastToast(page)}`);
  // An after-done task edited without touching "last done" keeps its due date and last done.
  await openMenu(page, 'late', 'furnace');
  await act(page, 'edit');
  await page.waitForTimeout(300);
  check('form (edit, after done): the next due date as it is', (await text(page, '.tasks-form [data-ref="due-hint"]')) === 'The next one is due Friday, October 23.'
    && (await page.inputValue('.tasks-form [name="when_date"]')) === '2026-08-24');
  await page.fill('.tasks-form [name="title"]', 'Change the furnace filter');
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(600);
  const fp = lastWrite(db, 'PATCH').body;
  check('form (edit, after done): due date unchanged, last done not sent', fp.due_date === '2026-10-23' && !('last_done' in fp) && db.K.filter.last_done === '2026-08-24', JSON.stringify(fp));
  // A one-off turned into "on set dates" from its own date.
  await openMenu(page, 'late', 'Renew passport');
  await act(page, 'edit');
  await page.waitForTimeout(300);
  await page.click('.tasks-form [data-mode="schedule"]');
  await page.fill('.tasks-form [name="every_count"]', '10');
  await page.selectOption('.tasks-form [name="every_unit"]', 'year');
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(600);
  check('form (edit): a one-off becomes repeating; the row fits the table', db.K.passport.repeat_mode === 'schedule' && db.K.passport.every_count === 10 && db.K.passport.every_unit === 'year'
    && db.K.passport.anchor_date === '2026-10-20' && !db.refused.length, JSON.stringify(db.refused));
  // The database refuses a row: the form says so in plain words and stays open.
  db.forceCheckFail = true;
  expect.failures = true;
  await page.click('[data-act="add"]');
  await page.waitForTimeout(300);
  await page.fill('.tasks-form [name="title"]', 'Something odd');
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(400);
  check('form: a refused row shows a plain reason; the form stays open', (await text(page, '.tasks-form .form-error')) === "The task couldn't be saved: its date and how it repeats don't fit together. Check them and try again." && await formOpen(page));
  db.forceCheckFail = false;
  expect.failures = false;
  await page.click('.tasks-form [data-close]');
  // Delete from the form.
  await openMenu(page, 'coming', 'Paint the fence');
  await act(page, 'edit');
  await page.waitForTimeout(300);
  await page.click('.tasks-form [data-act="delete"]');
  await page.waitForTimeout(500);
  check('form: Delete asks, deletes and closes', !db.tasks.some((x) => x.id === db.K.fence.id) && !(await formOpen(page)) && (await lastToast(page)) === 'Deleted Paint the fence\nUndo');
  // Escaping: a title with markup shows as text.
  db.tasks.push(task({ title: '<img src=x onerror="window.__xss=1">Fix the gate', due_date: TODAY, responsible_id: ID.alex }));
  await go(page, '#/');
  await go(page, '#/tasks/everyone');
  check('escaping: titles are text, never markup', (await page.locator('[data-group="today"] .irow-title', { hasText: 'Fix the gate' }).innerText()).startsWith('<img')
    && !(await page.evaluate(() => window.__xss)) && !(await page.$('.tasks-body img')));
  await page.context().close();

  // =====================================================================
  // 8. The Add sheet (from another page): openTaskForm with defaults, then that page again
  // =====================================================================
  ({ page, db } = await open({ label: 'add-sheet', path: '/#/' }));
  check('add sheet: Today is on screen', (await text(page, '#stub')) === 'Today');
  await page.click('.topbar-end [data-shell="add"]');
  await page.click('#sheet [data-add="task"]');
  await page.waitForTimeout(400);
  check('add sheet: Task opens the task form', await formOpen(page) && (await text(page, '.tasks-form h3')) === 'New task' && !(await page.evaluate(() => document.getElementById('sheet').open)));
  await page.click('.tasks-form [data-close]');
  await page.evaluate(() => HomeHub.core.openAdd('task', { date: '2026-10-27', title: 'Pick up Jordan\'s cleats', responsible_id: '0a1e0000-0000-4000-8000-000000000002' }));
  await page.waitForTimeout(400);
  check('add sheet: defaults fill the form (date, title, who)', (await page.inputValue('.tasks-form [name="when_date"]')) === '2026-10-27'
    && (await page.inputValue('.tasks-form [name="title"]')) === 'Pick up Jordan\'s cleats' && same(await texts(page, '.tasks-form .pchip.ring .pchip-name'), ['Sam']));
  check('add sheet: no private default: More closed, Private not ticked', !(await page.$eval('.tasks-form .tasks-more', (d) => d.open)) && !(await page.isChecked('.tasks-form [name="private"]')));
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(600);
  check('add sheet: saved from another page, which is drawn again', db.tasks.some((x) => x.title === 'Pick up Jordan\'s cleats' && x.due_date === '2026-10-27')
    && (await lastToast(page)) === 'Added Pick up Jordan\'s cleats · due Tue Oct 27' && (await text(page, '#stub')) === 'Today');
  check('add sheet: ... and saved not private', db.tasks.find((x) => x.title === 'Pick up Jordan\'s cleats').private === false);
  // A private default (Food's prep reminder for a locked dinner): Private ticked, with More open so it
  // shows; saved private, and handed to onSaved instead of drawing the page again.
  await page.evaluate((sam) => HomeHub.core.use('tasks').openTaskForm({ title: 'Prep: Surprise cake', date: '2026-10-27', responsible_id: sam, category: 'family',
    private: true, onSaved(row) { window.__prepSaved = row; } }), ID.sam);
  await page.waitForTimeout(400);
  check('openTaskForm({ private: true }): a new task with More open and Private ticked', await formOpen(page) && (await text(page, '.tasks-form h3')) === 'New task'
    && await page.$eval('.tasks-form .tasks-more', (d) => d.open) && await page.isChecked('.tasks-form [name="private"]')
    && (await page.inputValue('.tasks-form [name="title"]')) === 'Prep: Surprise cake' && (await page.inputValue('.tasks-form [name="category"]')) === 'family');
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(600);
  const privRow = lastWrite(db, 'POST').body;
  check('openTaskForm({ private: true }): the row sent is private, Sam in charge, family; onSaved gets the saved row',
    privRow && privRow.title === 'Prep: Surprise cake' && privRow.private === true && privRow.responsible_id === ID.sam && privRow.category === 'family' && privRow.due_date === '2026-10-27'
    && (await page.evaluate(() => window.__prepSaved && window.__prepSaved.private)) === true && !(await formOpen(page)), JSON.stringify(privRow));
  // Unticked before saving, it isn't private: the default is only where the form starts.
  await page.evaluate(() => HomeHub.core.use('tasks').openTaskForm({ title: 'Prep: Pizza night', private: true }));
  await page.waitForTimeout(400);
  await page.uncheck('.tasks-form [name="private"]');
  await page.click('.tasks-form [type="submit"]');
  await page.waitForTimeout(600);
  check('openTaskForm({ private: true }), unticked before saving: saved not private', lastWrite(db, 'POST').body.title === 'Prep: Pizza night' && lastWrite(db, 'POST').body.private === false,
    JSON.stringify(lastWrite(db, 'POST').body));
  // Editing a task follows the task's own flag, never the defaults.
  const cleats = db.tasks.find((x) => x.title === 'Pick up Jordan\'s cleats');
  await page.evaluate((id) => HomeHub.core.use('tasks').openTaskForm({ id, private: true }), cleats.id);
  await page.waitForTimeout(400);
  check('openTaskForm({ id, private: true }) edits the task as it is: Private not ticked', (await text(page, '.tasks-form h3')) === 'Edit task'
    && !(await page.isChecked('.tasks-form [name="private"]')));
  await page.click('.tasks-form [data-close]');
  await page.context().close();

  // =====================================================================
  // 9. Empty states
  // =====================================================================
  db = tasksDb();
  db.tasks = [];
  db.task_log = [];
  ({ page } = await open({ label: 'empty', db }));
  check('empty: a friendly line on Me', /^Nothing on your list\. Use Add task to add one\.$/.test(await text(page, '.tasks-empty')), await text(page, '.tasks-empty'));
  await chip(page, 'Repeating').click();
  await page.waitForTimeout(150);
  check('empty: Repeating points at the starter list', /^No repeating tasks yet\. The starter list/.test(await text(page, '.tasks-empty')) && !!(await page.$('[data-act="starter"]')));
  await page.context().close();

  // =====================================================================
  // 10. Phone (390px), light and dark: no sideways scroll, bottom bar, chips scroll inside
  // =====================================================================
  for (const scheme of ['light', 'dark']) {
    ({ page, db } = await open({ label: `phone-${scheme}`, ctx: Object.assign({ colorScheme: scheme }, phone), path: '/#/tasks/everyone' }));
    check(`phone ${scheme}: Tasks in the bottom bar and current`, (await page.getAttribute('.bottombar a[data-tab="tasks"]', 'aria-current')) === 'page');
    check(`phone ${scheme}: no sideways scroll on the list`, await noSideScroll(page));
    const chipsBox = await page.$eval('.tasks-chips', (e) => ({ scroll: e.scrollWidth > e.clientWidth, overflow: getComputedStyle(e).overflowX }));
    check(`phone ${scheme}: the chips scroll inside their row`, chipsBox.scroll && chipsBox.overflow === 'auto', JSON.stringify(chipsBox));
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(`phone ${scheme}: the page uses the ${scheme} colours`, scheme === 'dark' ? bg === 'rgb(18, 17, 16)' : bg === 'rgb(246, 244, 240)', bg);
    const ph = await page.$$eval('.tasks-chips .pchip, .irow-check, .tasks-menu, .irow-main', (es) => es.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    check(`phone ${scheme}: targets are at least 44px`, ph.every(([w, h]) => w >= 44 && h >= 44), JSON.stringify(ph.filter(([w, h]) => w < 44 || h < 44)));
    await page.screenshot({ path: SHOTS + `tasks-phone-${scheme}.png`, fullPage: true });
    await openMenu(page, 'coming', 'Heartworm');
    check(`phone ${scheme}: details fit`, await noSideScroll(page));
    await page.screenshot({ path: SHOTS + `tasks-details-phone-${scheme}.png` });
    await act(page, 'edit');
    await page.waitForTimeout(300);
    await page.click('.tasks-form .tasks-more summary');
    check(`phone ${scheme}: the form fits without sideways scroll`, await noSideScroll(page) && await page.$eval('.tasks-form', (f) => f.scrollWidth <= f.clientWidth));
    await page.screenshot({ path: SHOTS + `tasks-form-phone-${scheme}.png`, fullPage: true });
    await page.click('.tasks-form [data-close]');
    await chip(page, 'Repeating').click();
    await page.waitForTimeout(150);
    check(`phone ${scheme}: Repeating fits`, await noSideScroll(page));
    await page.screenshot({ path: SHOTS + `tasks-repeating-phone-${scheme}.png`, fullPage: true });
    await page.click('[data-act="starter"]');
    await page.waitForTimeout(200);
    check(`phone ${scheme}: the starter list fits`, await noSideScroll(page) && await page.$eval('.tasks-starter', (f) => f.scrollWidth <= f.clientWidth));
    await page.screenshot({ path: SHOTS + `tasks-starter-phone-${scheme}.png` });
    await page.context().close();
  }
  ({ page } = await open({ label: 'desktop-dark', ctx: { colorScheme: 'dark' }, path: '/#/tasks/everyone' }));
  await page.screenshot({ path: SHOTS + 'tasks-everyone-dark.png', fullPage: true });
  await page.click('[data-act="add"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + 'tasks-form-dark.png' });
  await page.context().close();

  // =====================================================================
  // 11. v1 mode: no Tasks page, no task reads
  // =====================================================================
  ({ page, log } = await open({ label: 'v1', v1: true, db: makeDb(), path: '/' }));
  check('v1: the v1 tabs, no Tasks, no task reads', same(await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent)), ['Home', 'Projects', 'Contractors', 'Family'])
    && !(await page.$('.tasks-head')) && !log.some((l) => /\/rest\/v1\/(tasks|task_log)/.test(l)));
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
