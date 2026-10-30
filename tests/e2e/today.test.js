// Browser tests for the v2 Today page (assets/modules/today.js): person chips, one person's day,
// ticking tasks off with Undo, Late, Heads-up, "Nobody's on it", "Send <name> their day" (with Share
// where the browser has Web Share), the project lines, the first-run checklist and "Which one is you?". On schema 3 (migration 0003): events
// read from Google Calendar (google_items) in each person's day and under Everyone, in time order, never
// in Late, Heads-up or Nobody's on it; the line when they can't be loaded; the one-time notice after the
// first Start copying (docs/v1.1-google-calendar.md §5.4). On schema 4 (migration 0004): tonight's
// dinner in one line under the person chips, the same under every chip, to that day on the Food page;
// "What's for dinner? ›" only after a dinner in the last 14 days; nothing when the read fails; and no
// meals request at all below schema 4 (docs/v1.2-kitchen.md §6.2).
//
// The fake RPCs answer with the shapes in supabase/migrations/0002_home_hub_v2.sql (agenda_item rows
// with all 27 columns, day_text as text, complete_task / undo_task as uuids, save_person as a people
// row, clock as one object). The other v2 pages are small stubs served in place of their files, so
// this file tests Today alone. The browser runs in Pacific/Honolulu with its clock on a different
// day and hour from the household's (America/New_York, from clock()), so anything using the device's
// date or time shows the wrong day or greeting.
// Run alone with: node tests/e2e/today.test.js
const { chromium } = require('playwright');
const { randomUUID, createHash } = require('crypto');
const { makeDb, install, signIn, SUPA, withCalendars, calendarRow, googleEventRow, calendarRpc, withFood, mealRow, stubShare } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const uuid = () => randomUUID();

// ---- Fixtures (fictional people, 555-01xx numbers, example.com)
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-10-25';   // the household's date (a Sunday); the device is on Mon Oct 26, evening
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

// One agenda_item row (agenda(), late_items(), heads_up()), every column in the type's order.
const AGENDA_COLS = ['kind', 'item_id', 'occurrence', 'title', 'day', 'end_day', 'all_day', 'start_at', 'end_at', 'local_start', 'local_end',
  'responsible_id', 'participant_ids', 'status', 'category', 'project_id', 'project_name', 'contractor_id', 'contractor_name', 'contractor_phone',
  'location', 'notes', 'private', 'repeating', 'changed', 'lead_days', 'milestone'];
function row(o) {
  const day = o.day || TODAY;
  const r = {
    kind: 'task', item_id: uuid(), occurrence: day, title: '', day, end_day: day, all_day: true, start_at: null, end_at: null,
    local_start: null, local_end: null, responsible_id: null, participant_ids: [], status: 'open',
    category: o.kind === 'task' || !o.kind ? 'home' : null, project_id: null, project_name: null,
    contractor_id: null, contractor_name: null, contractor_phone: null, location: null, notes: null,
    private: false, repeating: false, changed: false, lead_days: o.kind === 'task' || !o.kind ? 0 : null, milestone: false,
  };
  Object.assign(r, o);
  return Object.fromEntries(AGENDA_COLS.map((k) => [k, r[k]]));
}
// 'HH:MM' on the household's date as an instant (Oct 25 2026 is EDT, UTC-4).
const at = (hm, day = TODAY) => { const [h, m] = hm.split(':').map(Number); return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8), h + 4, m)).toISOString().replace('.000Z', '+00:00'); };
const timedEvent = (o, from, to) => row(Object.assign({ kind: 'event', all_day: false, start_at: at(from), end_at: at(to), local_start: `${from}:00`, local_end: `${to}:00` }, o));
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const PAT = { contractor_id: 'c-pat', contractor_name: 'Pat Lee', contractor_phone: '(201) 555-0100' };

function todayDb() {
  const db = makeDb();
  db.people = [
    person(ID.morgan, 'Morgan Example', 'kid', '#9333ea', 5, { active: false, phone: '(201) 555-0105' }),
    person(ID.taylor, 'Taylor Example', 'helper', '#ca8a04', 4, { phone: '(201) 555-0104' }),
    person(ID.alex, 'Alex Example', 'parent', '#2563eb', 1, { email: 'alex@example.com', email_verified_at: T }),
    person(ID.jordan, 'Jordan Example', 'kid', '#16a34a', 3),
    person(ID.sam, 'Sam Example', 'adult', '#db2777', 2, { email: 'sam@example.com', phone: '(201) 555-0103' }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: null, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '07:45:00', tz: 'America/New_York' };
  db.projects.forEach((p) => Object.assign(p, { task_dates: [], task_dates_at: T, on_calendar: true, owner_id: null }));
  db.contractors.push({ id: 'c-acme', name: 'Acme Internet', company: null, trade: null, phone: '(201) 555-0102', email: null, website: null, notes: null, kind: 'account', category: 'Internet', address: null, contract_end: '2026-11-10', created_at: T, updated_at: T });

  const plants = uuid();
  const bookClub = uuid();
  db.agenda = [
    row({ kind: 'event', title: 'Grandma visiting', day: '2026-10-24', occurrence: '2026-10-24', end_day: '2026-10-27', participant_ids: [ID.alex, ID.sam] }),
    timedEvent({ title: 'School run', responsible_id: ID.alex, participant_ids: [ID.jordan], repeating: true, location: 'Maple School' }, '08:00', '08:30'),
    timedEvent({ title: 'Swim lesson', responsible_id: ID.jordan, status: 'cancelled', repeating: true, changed: true }, '10:00', '11:00'),
    timedEvent({ title: 'Piano', responsible_id: ID.taylor, participant_ids: [ID.jordan], repeating: true }, '16:00', '17:00'),
    timedEvent({ title: 'Book club', item_id: bookClub }, '19:30', '21:00'),
    row(Object.assign({ title: 'Call the plumber', all_day: false, start_at: at('09:00'), local_start: '09:00:00', responsible_id: ID.alex }, PAT)),
    row({ title: 'Take out recycling', responsible_id: ID.jordan, repeating: true }),
    row({ title: 'Heartworm pill', responsible_id: ID.alex, status: 'done', repeating: true, category: 'pets' }),
    row({ title: 'Water the plants', item_id: plants }),
    row(Object.assign({ kind: 'project', item_id: 'p-kitchen', title: 'Rough-in plumbing', end_day: '2026-10-27', status: 'open', project_id: 'p-kitchen', project_name: 'Kitchen Renovation' }, PAT)),
    row({ kind: 'project', item_id: 'p-kitchen', title: 'Cabinet install', day: '2026-10-20', occurrence: '2026-10-20', end_day: '2026-10-30', project_id: 'p-kitchen', project_name: 'Kitchen Renovation' }),
    row({ kind: 'project', item_id: 'p-kitchen', title: 'Demolition', day: '2026-10-19', occurrence: '2026-10-19', end_day: '2026-10-26', status: 'done', project_id: 'p-kitchen', project_name: 'Kitchen Renovation' }),
    row({ kind: 'project', item_id: 'p-sprinkler', title: 'Blow out sprinkler lines', project_id: 'p-sprinkler', project_name: 'Sprinkler winterization' }),
  ];
  const late = (title, day, extra) => row(Object.assign({ title, day, occurrence: day, status: 'late' }, extra));
  db.late = [
    late('Change furnace filter', '2026-10-20', { responsible_id: ID.alex, repeating: true }),
    late('Clean the gutters', '2026-10-21'),
    late('Return library books', '2026-10-22', { responsible_id: ID.alex }),
    late('Renew passport', '2026-10-23', { responsible_id: ID.alex }),
    late('Fix the side gate', '2026-10-24', { responsible_id: ID.alex }),
    late('Feed the fish', '2026-10-24', { responsible_id: ID.jordan }),
  ];
  db.heads = [
    row({ title: 'Buy dog food', day: '2026-10-27', occurrence: '2026-10-27', responsible_id: ID.alex, lead_days: 3, category: 'pets' }),
    row({ title: 'Dentist forms', day: '2026-10-28', occurrence: '2026-10-28', responsible_id: ID.sam, lead_days: 5, category: 'health' }),
    row({ kind: 'contract', item_id: 'c-acme', title: 'Acme Internet', day: '2026-11-10', occurrence: '2026-11-10', end_day: '2026-11-10', category: 'Internet', contractor_id: 'c-acme', contractor_name: 'Acme Internet', contractor_phone: '(201) 555-0102' }),
  ];
  // The rows behind the two unassigned items ("I'll do it" writes these), plus what the checklist reads.
  db.tasks = [
    { id: plants, title: 'Water the plants', responsible_id: null, repeat_mode: 'none', due_date: TODAY },
    { id: uuid(), title: 'Furnace filter', responsible_id: ID.alex, repeat_mode: 'after_done', due_date: '2026-10-20' },
  ];
  db.events = [{ id: bookClub, title: 'Book club', responsible_id: null, participant_ids: [], repeat: 'none', start_date: TODAY }];
  // One-day changes to repeating events ("I'll do it" on one day writes these) and the task log
  // (unticking a done task finds its entry here).
  db.event_changes = [];
  db.task_log = [];
  db.logs = {};
  return db;
}

// RPC fakes with the migration's shapes.
const rows = (db) => db.agenda.concat(db.late, db.heads);
// agenda() reads the tables, so a write to tasks.responsible_id or events.responsible_id shows up,
// and so does that day's event_changes row for a repeating event (its person in charge wins).
const withTables = (db, it) => {
  const t = it.kind === 'task' ? (db.tasks || []).find((x) => x.id === it.item_id) : it.kind === 'event' ? (db.events || []).find((x) => x.id === it.item_id) : null;
  if (!t) return it;
  const c = it.kind === 'event' && t.repeat === 'weekly' ? (db.event_changes || []).find((x) => x.event_id === it.item_id && x.on_date === it.occurrence) : null;
  return Object.assign({}, it, { responsible_id: (c && c.responsible_id) || t.responsible_id, changed: !!c || it.changed });
};
const fail = (status, code, message, hint) => ({ __status: status, body: { code, message, details: null, hint: hint || null } });
const todayRpc = (extra) => Object.assign({
  hub_schema_version: () => 2,
  clock: (db) => Object.assign({}, db.clock),
  mark_signed_in: (db, body, email) => { (db.signedIn = db.signedIn || []).push(email); return null; },
  agenda: (db, b) => {
    if (db.agendaFail) return fail(500, 'XX000', 'Database restarting');
    if (!b.p_from || !b.p_to || b.p_to < b.p_from) return fail(400, '22023', 'agenda() needs a range of 1 to 62 days.');
    return db.agenda.filter((it) => it.day <= b.p_to && it.end_day >= b.p_from).map((it) => withTables(db, it));
  },
  late_items: (db) => db.late.map((it) => withTables(db, it)),
  // Tasks inside their lead time (due − lead_days ≤ day < due); contracts ending within 30 days.
  heads_up: (db, b) => db.heads.filter((it) => (it.kind === 'contract'
    ? it.day >= b.p_day && it.day <= addDays(b.p_day, 30)
    : addDays(it.day, -it.lead_days) <= b.p_day && b.p_day < it.day)),
  day_text: (db, b) => {
    const p = db.people.find((x) => x.id === b.p_person);
    if (!p || !b.p_day) return null;
    return `${p.name} · Sun Oct 25\n4:00pm Piano · with Jordan Example\n☐ Wipe the counters`;
  },
  complete_task: (db, b) => {
    if (db.completeFail) return fail(500, 'XX000', 'Database restarting');
    const it = rows(db).find((x) => x.kind === 'task' && x.item_id === b.p_id);
    if (!it) return fail(404, 'P0002', 'That task no longer exists.');
    if (it.status === 'done' || db.alreadyDone === b.p_id) return fail(400, 'P0001', 'already done', 'Someone already ticked this off.');
    if (it.repeating && b.p_occurrence && b.p_occurrence !== it.occurrence) return fail(400, 'P0001', 'already completed', 'This date was already ticked off or skipped.');
    const logId = uuid();
    db.logs[logId] = { taskId: b.p_id, lists: { agenda: db.agenda.slice(), late: db.late.slice() }, status: it.status };
    if (db.late.includes(it)) db.late = db.late.filter((x) => x !== it);
    else it.status = 'done';
    return logId;
  },
  undo_task: (db, b) => {
    const l = db.logs[b.p_log_id];
    if (!l) return fail(404, 'P0002', "There's nothing to undo.");
    db.agenda = l.lists.agenda;
    db.late = l.lists.late;
    const it = rows(db).find((x) => x.item_id === l.taskId);
    if (it) it.status = l.status;
    delete db.logs[b.p_log_id];
    return l.taskId;
  },
  save_person: (db, b) => {
    if (db.saveFail) return fail(403, '42501', 'Only an admin can change the family list.');
    const p = db.people.find((x) => x.id === b.p.id);
    if (!p) return fail(404, 'P0002', 'That person is no longer on the family list.');
    Object.assign(p, { email: b.p.email.toLowerCase(), email_verified_at: null, updated_at: '2026-10-25T11:50:00.000000+00:00' });
    return Object.assign({}, p);
  },
}, extra);

// ---- Stub v2 pages: same register() contract as the real ones
const STUBS = {
  calendar: { nav: { label: 'Calendar', order: 20, primary: true }, provides: 'openEventForm' },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true }, provides: 'openTaskForm' },
  directory: { nav: { label: 'Directory', order: 50 } },
  people: { nav: { label: 'Family', order: 60 } },
  settings: { nav: { label: 'Settings', order: 70 } },
  food: { nav: { label: 'Food', order: 35, primary: true }, min: 4 },   // schema 4 only, as the real one
};
const stubModule = (name, s) => `;(function () {
  var provides = {};
  ${s.provides ? `provides[${JSON.stringify(s.provides)}] = function (defaults) {
    (window.__added = window.__added || []).push({ page: ${JSON.stringify(name)}, defaults: defaults });
  };` : ''}
  HomeHub.register({
    name: ${JSON.stringify(name)}, schema: { min: ${s.min || 2}, max: 99 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return parts[0] === ${JSON.stringify(name)} ? { day: parts[1] || null } : null; },
    render: function (main, ctx) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1><p id="stubDay">' + (ctx.params.day || '') + '</p>'; },
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
    const db = opts.db || todayDb();
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 }, timezoneId: 'Pacific/Honolulu' }, opts.ctx));
    await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    // The device's clock: Wednesday Jan 14, 7pm in Honolulu. The household's date and time come from
    // clock(): Sunday Oct 25, 7:45am. (Earlier than the real time, so the signed-in session hasn't expired.)
    await page.clock.setFixedTime(new Date('2026-01-15T05:00:00Z'));
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (opts.v1 && /status of 404/.test(m.text()) && /hub_schema_version$/.test(m.location().url || '')) return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => {
      (db.dialogs = db.dialogs || []).push(d.message());
      return db.confirm === false ? d.dismiss() : d.accept();
    });
    await install(page, db, log, { rpc: opts.v1 ? {} : todayRpc(opts.rpc) });
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
    // Record writes to tasks, events, event_changes and projects, then let the mock answer. A second
    // event_changes row for the same event and day is refused like the primary key refuses it.
    db.writes = [];
    await page.route((url) => url.host === 'test.supabase.co' && /^\/rest\/v1\/(tasks|events|event_changes|projects)$/.test(url.pathname), (route) => {
      const req = route.request();
      if (['PATCH', 'POST', 'DELETE'].includes(req.method())) db.writes.push({ method: req.method(), url: decodeURIComponent(req.url()), body: JSON.parse(req.postData() || 'null') });
      if (req.method() === 'POST' && /\/event_changes$/.test(new URL(req.url()).pathname)) {
        const body = JSON.parse(req.postData() || 'null');
        const rowsIn = Array.isArray(body) ? body : [body];
        if (rowsIn.some((r) => db.event_changes.some((c) => c.event_id === r.event_id && c.on_date === r.on_date))) {
          return route.fulfill({ status: 409, headers: { ...CORS, 'content-type': 'application/json' },
            body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "event_changes_pkey"', details: null, hint: null }) });
        }
      }
      return route.fallback();
    });
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule(name, s) }));
    }
    // Web Share: this Chromium has none; opts.share gives the page stubShare's fake.
    if (opts.share) await stubShare(page);
    await page.goto(BASE + (opts.path || '/'));
    await page.waitForTimeout(opts.wait || 700);
    return { page, db, log, context };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.innerText.trim()));
  // A row's title without the screen-reader ", repeats".
  const titles = (page, list) => page.$$eval(`[data-list="${list}"] .irow-title`, (es) => es.map((e) => e.firstChild.textContent));
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(400); };
  const calls = (db, name) => (db.rpcCalls || []).filter((c) => c.name === name);
  const chipLabels = (page) => texts(page, '.today-chips .pchip-name');
  const pressed = (page) => page.$$eval('.today-chips .pchip[aria-pressed="true"] .pchip-name', (es) => es.map((e) => e.textContent));
  const chip = (page, label) => page.locator('.today-chips .pchip', { hasText: label }).first();
  const rowFor = (page, list, title) => page.locator(`[data-list="${list}"] .irow`, { hasText: title }).first();
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const lastToast = async (page) => (await texts(page, '.toasts .toast')).slice(-1)[0] || '';
  // "Projects today": [the line, the jobs starting today under it (or null), its link, its call links] for each project.
  const projectLines = (page) => page.$$eval('.today-projects li', (lis) => lis.map((li) => [
    li.querySelector('.today-proj-line').textContent.replace(/\s+/g, ' ').trim(),
    li.querySelector('.today-proj-jobs') ? li.querySelector('.today-proj-jobs').textContent.trim() : null,
    li.querySelector('.today-proj').getAttribute('href'),
    [...li.querySelectorAll('.today-call')].map((a) => a.getAttribute('href')),
  ]));

  // =====================================================================
  // 0. The fixtures have the agenda_item shape (all 27 columns, in order)
  // =====================================================================
  const fx = todayDb();
  check('fixtures: every agenda, late and heads-up row has exactly the agenda_item columns', rows(fx).every((r) => same(Object.keys(r), AGENDA_COLS)));

  // =====================================================================
  // 1. Registration, the head, the chips (desktop, Alex: a parent and admin)
  // =====================================================================
  let { page, db, log } = await open({ label: 'desktop' });
  check('schema 2: no google_items call, no calendars read, no notice', !calls(db, 'google_items').length && !log.some((l) => /\/rest\/v1\/calendars/.test(l))
    && !(await page.$('.today-gnotice, .today-gfail')));
  const reg = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]),
    bar: [...document.querySelectorAll('.bottombar a')].map((a) => a.textContent.trim()),
    version: HomeHub.core.schemaVersion,
  }));
  check('register: Today is the first tab, at "#/", and current', same(reg.tabs[0], ['Today', '#/', 'page']), JSON.stringify(reg.tabs));
  check('register: Today is in the phone bottom bar (primary)', reg.bar[0] === 'Today', reg.bar.join(','));
  check('head: the household\'s date, not the device\'s', (await tc(page, '.today-head .eyebrow')) === 'Sunday, October 25', await tc(page, '.today-head .eyebrow'));
  check('head: greeting from the household\'s clock and the person\'s first name', (await text(page, '.today-head h1')) === 'Good morning, Alex', await text(page, '.today-head h1'));
  check('chips: Me, each other active person in order, then Everyone (no inactive Morgan)', same(await chipLabels(page), ['Me', 'Sam', 'Jordan', 'Taylor', 'Everyone']), (await chipLabels(page)).join(','));
  check('chips: Me is chosen by default', same(await pressed(page), ['Me']), (await pressed(page)).join(','));
  const sizes = await page.$$eval('.today-chips .pchip, .irow-check, .today-take, .today-send .btn, .today-proj, .today-call, .today-more, .today-steps .btn, .today-hide', (es) => es.map((e) => { const r = e.getBoundingClientRect(); return [e.className, Math.round(r.width), Math.round(r.height)]; }));
  check('targets: chips, tick boxes and every button or link are at least 44px tall', sizes.length > 10 && sizes.every(([, w, h]) => h >= 44 && w >= 44), JSON.stringify(sizes.filter(([, w, h]) => h < 44 || w < 44)));
  check('reads: agenda for today only, heads_up for today, late_items', same(calls(db, 'agenda')[0].body, { p_from: TODAY, p_to: TODAY })
    && same(calls(db, 'heads_up')[0].body, { p_day: TODAY }) && calls(db, 'late_items').length === 1);

  // =====================================================================
  // 2. My day: events (all-day, then by time), then tasks; only mine; no cancelled or project rows
  // =====================================================================
  check('day: my events in time order, then my tasks (done last)', same(await titles(page, 'day'), ['Grandma visiting', 'School run', 'Call the plumber', 'Heartworm pill']), (await titles(page, 'day')).join(','));
  check('day: heading and count', (await tc(page, '.today-sec[aria-label="Your day"] .sec-head')) === 'Your day4', await tc(page, '.today-sec[aria-label="Your day"] .sec-head'));
  check('day: times in the household zone (8:00am, a multi-day span, 9:00am)', same(await texts(page, '[data-list="day"] .irow-time'), ['Oct 24\n– Oct 27', '8:00am\n8:30am', '9:00am', 'Any time']), JSON.stringify(await texts(page, '[data-list="day"] .irow-time')));
  const plumber = rowFor(page, 'day', 'Call the plumber');
  check('day: an open task has an unticked box; a done one is ticked (a tap asks to mark it not done, section 6c)',
    (await plumber.locator('.irow-check').getAttribute('aria-checked')) === 'false'
    && (await rowFor(page, 'day', 'Heartworm pill').locator('.irow-check').getAttribute('aria-checked')) === 'true'
    && !(await rowFor(page, 'day', 'Heartworm pill').locator('.irow-check').isDisabled()));
  check('day: events have no tick box; who dots show who\'s on it', (await rowFor(page, 'day', 'School run').locator('.irow-check').count()) === 0
    && (await rowFor(page, 'day', 'School run').locator('.irow-who .pdot').count()) === 2);
  check('day: a contractor\'s phone is tap-to-call', (await plumber.locator('.irow-call').getAttribute('href')) === 'tel:2015550100');

  // =====================================================================
  // 3. Late (3 + "N more"), Heads-up, Nobody's on it, Send their day, projects, checklist
  // =====================================================================
  check('late: mine, at most 3, with the total in the heading', same(await titles(page, 'late'), ['Change furnace filter', 'Return library books', 'Renew passport'])
    && (await text(page, '.today-sec[aria-label="Late"] .sec-count')) === '4', (await titles(page, 'late')).join(','));
  check('late: "1 more late task" links to Tasks', (await text(page, '.today-sec[aria-label="Late"] .today-more')) === '1 more late task on the Tasks page'
    && (await page.getAttribute('.today-sec[aria-label="Late"] .today-more', 'href')) === '#/tasks');
  check('late: rows show their day in red style and keep a tick box', (await rowFor(page, 'late', 'Renew passport').locator('.irow-time').innerText()).startsWith('Fri Oct 23')
    && (await rowFor(page, 'late', 'Renew passport').locator('.irow-check').count()) === 1);
  check('heads-up: my lead-time task and the contract ending (not Sam\'s)', same(await titles(page, 'heads'), ['Buy dog food', 'Contract ends']), (await titles(page, 'heads')).join(','));
  check('heads-up: shows the day, and the directory entry with its phone', (await rowFor(page, 'heads', 'Buy dog food').locator('.irow-time').innerText()) === 'Tue Oct 27'
    && /Acme Internet/.test(await rowFor(page, 'heads', 'Contract ends').innerText())
    && (await rowFor(page, 'heads', 'Contract ends').locator('.irow-call').getAttribute('href')) === 'tel:2015550102');
  check('nobody: unassigned items today, then unassigned late ones, each with "I\'ll do it"', same(await titles(page, 'nobody'), ['Book club', 'Water the plants', 'Clean the gutters'])
    && (await page.locator('[data-list="nobody"] .today-take').count()) === 3, (await titles(page, 'nobody')).join(','));
  const send = await page.$$eval('.today-send li', (lis) => lis.map((li) => ({
    who: li.querySelector('.today-send-who').innerText.trim(),
    wa: (li.querySelector('[data-via="whatsapp"]') || {}).href, sms: (li.querySelector('[data-via="sms"]') || {}).href,
    target: (li.querySelector('[data-via="whatsapp"]') || {}).target,
  })));
  const msg = 'Taylor Example · Sun Oct 25\n4:00pm Piano · with Jordan Example\n☐ Wipe the counters';
  check('send: only kids and helpers with a phone (Taylor; not Jordan without one, inactive Morgan or adult Sam)', send.length === 1 && /Send Taylor their day/.test(send[0].who), JSON.stringify(send.map((s) => s.who)));
  check('send: WhatsApp and Text carry day_text for that person and today', send[0].wa === `https://wa.me/12015550104?text=${encodeURIComponent(msg)}`
    && send[0].sms === `sms:+12015550104?&body=${encodeURIComponent(msg)}` && send[0].target === '_blank'
    && same(calls(db, 'day_text').map((c) => c.body), [{ p_person: ID.taylor, p_day: TODAY }]), JSON.stringify(send[0]).slice(0, 200));
  await page.click('.today-preview summary');
  check('send: the message can be previewed', (await text(page, '.today-preview pre')) === msg);
  check('send: no Share without Web Share (navigator.share, which many desktop browsers lack)', !(await page.$('.today-send [data-share]'))
    && same(await page.$$eval('.today-send-btns > *', (es) => es.map((e) => e.textContent)), ['WhatsApp', 'Text']));
  const proj = await projectLines(page);
  check('projects: one line per active project with work today (not done tasks, not an idea project): counts, then the job starting today',
    same(proj, [['Kitchen Renovation: 1 starting today · 1 in progress', 'Rough-in plumbing', '#/projects/p-kitchen', ['tel:2015550100']]]), JSON.stringify(proj));
  const steps = await page.$$eval('.today-steps li', (lis) => lis.map((li) => [li.querySelector('b').textContent, li.classList.contains('is-done')]));
  check('checklist: steps in order, done ones detected from the data', same(steps, [['Add the people in your home', true], ["Turn on someone's morning email", false],
    ['Add the weekly routine', false], ['Add a directory entry', true], ['Add starter tasks', true]]) && (await text(page, '.today-setup .sec-count')) === '3 of 5', JSON.stringify(steps));
  await page.click('.today-steps [data-act="add-event"]');
  await page.waitForTimeout(200);
  check('checklist: "Add event" opens the Calendar page\'s event form', same(await page.evaluate(() => window.__added.map((a) => a.page)), ['calendar']));
  check('layout: the household side column sits beside the day on a wide screen', await page.evaluate(() => {
    const a = document.querySelector('.today-col').getBoundingClientRect(); const b = document.querySelector('.today-side').getBoundingClientRect();
    return b.left >= a.right && Math.abs(b.top - a.top) < 2;
  }));
  await page.screenshot({ path: SHOTS + 'today-desktop.png', fullPage: true });
  const addButtons = await page.$$eval('button', (bs) => bs.filter((b) => b.offsetParent && /^\W*Add$/.test(b.textContent.trim())).map((b) => b.closest('.topbar') ? 'topbar' : b.closest('#main') ? 'page' : 'other'));
  check('Add: one Add button on a wide screen (the top bar\'s), not a second one on the page', same(addButtons, ['topbar']), JSON.stringify(addButtons));
  await page.click('.topbar [data-shell="add"]');
  await page.waitForTimeout(200);
  check('Add: the Add button opens the Add sheet (Event | Task)', await page.isVisible('dialog#sheet[open] [data-add="event"]') && await page.isVisible('dialog#sheet[open] [data-add="task"]'));
  await page.keyboard.press('Escape');

  // =====================================================================
  // 4. Other people's days, and Everyone
  // =====================================================================
  await chip(page, 'Jordan').click();
  await page.waitForTimeout(100);
  check('Jordan: their chip is chosen', same(await pressed(page), ['Jordan']));
  check('Jordan: their events (in charge or with), then their tasks; no cancelled swim lesson', same(await titles(page, 'day'), ['School run', 'Piano', 'Take out recycling']), (await titles(page, 'day')).join(','));
  check('Jordan: heading, their late task, and no household sections', (await tc(page, '.today-sec[aria-label="Jordan\'s day"] .sec-head span')) === "Jordan's day"
    && same(await titles(page, 'late'), ['Feed the fish']) && !(await page.$('[data-list="heads"]')) && !(await page.$('[data-list="nobody"]'))
    && !(await page.$('.today-projects')) && !(await page.$('.today-setup')) && !(await page.$('.today-send')));
  check('Jordan: switching chips reads nothing again', calls(db, 'agenda').length === 1);
  await chip(page, 'Taylor').click();
  await page.waitForTimeout(100);
  check('Taylor: their day, and only "Send Taylor their day"', same(await titles(page, 'day'), ['Piano'])
    && same(await page.$$eval('.today-send-who b', (bs) => bs.map((b) => b.textContent)), ['Send Taylor their day']));
  await chip(page, 'Sam').click();
  await page.waitForTimeout(100);
  check('Sam: their all-day visit and their heads-up task (no contract in a person\'s view)', same(await titles(page, 'day'), ['Grandma visiting']) && same(await titles(page, 'heads'), ['Dentist forms']));
  await chip(page, 'Everyone').click();
  await page.waitForTimeout(100);
  check('Everyone: every event and task except cancelled and the unassigned ones (they\'re under "Nobody\'s on it")',
    same(await titles(page, 'day'), ['Grandma visiting', 'School run', 'Piano', 'Call the plumber', 'Take out recycling', 'Heartworm pill']), (await titles(page, 'day')).join(','));
  check('Everyone: late from everyone, but not the unassigned one', (await text(page, '.today-sec[aria-label="Late"] .sec-count')) === '5'
    && same(await titles(page, 'nobody'), ['Book club', 'Water the plants', 'Clean the gutters']));
  check('Everyone: all heads-up items and all household sections', same(await titles(page, 'heads'), ['Buy dog food', 'Dentist forms', 'Contract ends']) && !!(await page.$('.today-projects')) && !!(await page.$('.today-setup')));
  await go(page, '#/tasks');
  await go(page, '#/today');
  check('route: "#/today" is Today too, and it remembers the chosen chip', (await page.isVisible('.today-head')) && same(await pressed(page), ['Everyone']));
  await chip(page, 'Me').click();
  await page.waitForTimeout(100);

  // =====================================================================
  // 5. Tick a task off: complete_task, "Done · Undo", undo_task
  // =====================================================================
  const plumberId = db.agenda.find((x) => x.title === 'Call the plumber').item_id;
  const reads0 = calls(db, 'agenda').length;
  await rowFor(page, 'day', 'Call the plumber').locator('.irow-check').click();
  await page.waitForTimeout(500);
  check('tick: complete_task with the task and the occurrence on screen', same(calls(db, 'complete_task').slice(-1)[0].body, { p_id: plumberId, p_occurrence: TODAY }));
  check('tick: a 6-second "Done · Undo" toast', (await text(page, '.toast-action span')) === 'Done: Call the plumber' && (await text(page, '.toast-action button')) === 'Undo');
  check('tick: the list is read again and the task shows done', calls(db, 'agenda').length === reads0 + 1
    && (await rowFor(page, 'day', 'Call the plumber').getAttribute('class')).includes('st-done')
    && (await rowFor(page, 'day', 'Call the plumber').locator('.irow-check').getAttribute('aria-checked')) === 'true');
  const logId = Object.keys(db.logs)[0];
  await page.click('.toast-action button');
  await page.waitForTimeout(500);
  check('undo: undo_task with the log id complete_task returned', same(calls(db, 'undo_task').slice(-1)[0].body, { p_log_id: logId }));
  check('undo: says so, and the task is open again', (await lastToast(page)) === 'Not done: Call the plumber'
    && (await rowFor(page, 'day', 'Call the plumber').locator('.irow-check').getAttribute('aria-checked')) === 'false');
  // A late repeating task: the occurrence is its due date, and it leaves the Late list.
  await rowFor(page, 'late', 'Change furnace filter').locator('.irow-check').click();
  await page.waitForTimeout(500);
  check('tick (late): sends the late due date as the occurrence and the task leaves Late', same(calls(db, 'complete_task').slice(-1)[0].body.p_occurrence, '2026-10-20')
    && same(await titles(page, 'late'), ['Return library books', 'Renew passport', 'Fix the side gate']) && !(await page.$('.today-sec[aria-label="Late"] .today-more')), (await titles(page, 'late')).join(','));
  await page.waitForTimeout(6300);
  check('tick: the Undo toast goes after 6 seconds', !(await page.$('.toast-action')));
  await page.screenshot({ path: SHOTS + 'today-desktop-ticked.png' });
  await page.context().close();

  // Ticked elsewhere first, and a save that fails.
  ({ page, db } = await open({ label: 'tick-errors', allowConsole: /status of (400|500)/ }));
  db.alreadyDone = db.agenda.find((x) => x.title === 'Call the plumber').item_id;
  const before = calls(db, 'agenda').length;
  await rowFor(page, 'day', 'Call the plumber').locator('.irow-check').click();
  await page.waitForTimeout(500);
  check('already done: a plain message, not an error, and the list is read again', (await lastToast(page)) === 'Someone already ticked that off. This is the latest.'
    && !(await page.$('.toast-error')) && calls(db, 'agenda').length === before + 1);
  db.alreadyDone = null;
  db.completeFail = true;
  await page.evaluate(() => document.querySelectorAll('.toasts .toast').forEach((t) => t.remove()));
  await rowFor(page, 'late', 'Return library books').locator('.irow-check').click();
  await page.waitForTimeout(500);
  const box = rowFor(page, 'late', 'Return library books').locator('.irow-check');
  check('save fails: the box unticks and the error shows', (await box.getAttribute('aria-checked')) === 'false' && !(await box.isDisabled())
    && (await text(page, '.toasts .toast-error')) === 'Database restarting', await text(page, '.toasts'));
  await page.context().close();

  // =====================================================================
  // 6. "I'll do it" on something nobody is on, with Undo; someone else got there first
  // =====================================================================
  ({ page, db } = await open({ label: 'take' }));
  const plantsId = db.tasks[0].id;
  await rowFor(page, 'nobody', 'Water the plants').locator('.today-take').click();
  await page.waitForTimeout(500);
  const takeWrite = db.writes.find((w) => w.method === 'PATCH' && /\/tasks\?/.test(w.url));
  check('take: sets me in charge, only if still nobody\'s', !!takeWrite && same(takeWrite.body, { responsible_id: ID.alex })
    && takeWrite.url.includes(`id=eq.${plantsId}`) && takeWrite.url.includes('responsible_id=is.null'), takeWrite && takeWrite.url);
  check('take: toast with Undo; it moves from "Nobody\'s on it" to my day', (await text(page, '.toast-action span')) === "You're on it: Water the plants"
    && (await titles(page, 'day')).includes('Water the plants') && !(await titles(page, 'nobody')).includes('Water the plants'));
  await page.click('.toast-action button');
  await page.waitForTimeout(500);
  const undoWrite = db.writes.filter((w) => w.method === 'PATCH' && /\/tasks\?/.test(w.url)).slice(-1)[0];
  check('take undo: puts it back to nobody (only if it\'s still mine)', same(undoWrite.body, { responsible_id: null }) && undoWrite.url.includes(`responsible_id=eq.${ID.alex}`)
    && (await titles(page, 'nobody')).includes('Water the plants') && (await lastToast(page)) === "Nobody's on it again: Water the plants");
  db.events[0].responsible_id = ID.sam;   // Sam took the book club on another phone; this screen is stale
  await rowFor(page, 'nobody', 'Book club').locator('.today-take').click();
  await page.waitForTimeout(500);
  const evWrite = db.writes.find((w) => /\/events\?/.test(w.url));
  check('take (event): writes the event, finds it taken, says so and shows the latest', !!evWrite && evWrite.url.includes('responsible_id=is.null')
    && (await lastToast(page)) === 'Someone else just took that one. This is the latest.' && !(await titles(page, 'nobody')).includes('Book club')
    && db.events[0].responsible_id === ID.sam);
  // Hide the checklist: gone now and after a reload, and no more setup reads.
  await page.click('[data-act="hide-setup"]');
  await page.waitForTimeout(200);
  check('checklist: "Hide this list" hides it, with a message', !(await page.$('.today-setup')) && (await lastToast(page)) === 'Checklist hidden on this device.');
  await page.context().close();

  // =====================================================================
  // 6b. "I'll do it" when the person in charge is off the lists (inactive Morgan), and on one day
  //     of a repeating event (that day's event_changes row, not the whole series)
  // =====================================================================
  db = todayDb();
  const fishId = uuid(); const vetId = uuid(); const pickupId = uuid(); const swimId = uuid();
  db.agenda.push(row({ title: 'Feed the fish', item_id: fishId, responsible_id: ID.morgan }));
  db.agenda.push(timedEvent({ title: 'Vet visit', item_id: vetId, responsible_id: ID.morgan }, '11:00', '12:00'));
  db.agenda.push(timedEvent({ title: 'School pickup', item_id: pickupId, repeating: true }, '15:00', '15:30'));
  db.agenda.push(timedEvent({ title: 'Swim club', item_id: swimId, repeating: true, participant_ids: [ID.morgan] }, '17:00', '18:00'));
  db.tasks.push({ id: fishId, title: 'Feed the fish', responsible_id: ID.morgan, repeat_mode: 'none', due_date: TODAY });
  db.events.push({ id: vetId, title: 'Vet visit', responsible_id: ID.morgan, participant_ids: [], repeat: 'none', start_date: TODAY });
  db.events.push({ id: pickupId, title: 'School pickup', responsible_id: null, participant_ids: [], repeat: 'weekly', start_date: '2026-09-01' });
  db.events.push({ id: swimId, title: 'Swim club', responsible_id: null, participant_ids: [ID.morgan], repeat: 'weekly', start_date: '2026-09-01' });
  // Today's swim club was changed earlier: Morgan in charge that day (since taken off the lists).
  db.event_changes.push({ event_id: swimId, on_date: TODAY, cancelled: false, start_time: null, end_time: null, responsible_id: ID.morgan, participant_ids: null, note: null });
  ({ page, db } = await open({ label: 'take-inactive', db, allowConsole: /status of 409/ }));
  const nobodyNow = await titles(page, 'nobody');
  check('take (inactive): items whose person in charge is off the lists are under "Nobody\'s on it"', ['Feed the fish', 'Vet visit', 'School pickup', 'Swim club'].every((t) => nobodyNow.includes(t)), nobodyNow.join(','));
  const writesOf = (re) => db.writes.filter((w) => re.test(w.url));
  await rowFor(page, 'nobody', 'Feed the fish').locator('.today-take').click();
  await page.waitForTimeout(500);
  let w = writesOf(/\/tasks\?/).slice(-1)[0];
  check('take (inactive task): matches the person in charge the screen showed, and puts me in charge', !!w && same(w.body, { responsible_id: ID.alex })
    && w.url.includes(`id=eq.${fishId}`) && w.url.includes(`responsible_id=eq.${ID.morgan}`) && db.tasks.find((t) => t.id === fishId).responsible_id === ID.alex
    && (await text(page, '.toast-action span')) === "You're on it: Feed the fish" && !(await titles(page, 'nobody')).includes('Feed the fish') && (await titles(page, 'day')).includes('Feed the fish'),
  JSON.stringify({ w, toast: await lastToast(page) }));
  await page.click('.toast-action button');
  await page.waitForTimeout(500);
  w = writesOf(/\/tasks\?/).slice(-1)[0];
  check('take (inactive task) undo: puts back the person who was in charge, only if it\'s still mine', same(w.body, { responsible_id: ID.morgan }) && w.url.includes(`responsible_id=eq.${ID.alex}`)
    && db.tasks.find((t) => t.id === fishId).responsible_id === ID.morgan && (await titles(page, 'nobody')).includes('Feed the fish'), JSON.stringify(w));
  await rowFor(page, 'nobody', 'Vet visit').locator('.today-take').click();
  await page.waitForTimeout(500);
  w = writesOf(/\/events\?/).slice(-1)[0];
  check('take (inactive one-off event): the same for the event', !!w && same(w.body, { responsible_id: ID.alex }) && w.url.includes(`responsible_id=eq.${ID.morgan}`)
    && db.events.find((e) => e.id === vetId).responsible_id === ID.alex && !(await titles(page, 'nobody')).includes('Vet visit'), JSON.stringify(w));

  const seriesWrites = () => db.writes.filter((x) => /\/events\?/.test(x.url) && x.url.includes(pickupId));
  await rowFor(page, 'nobody', 'School pickup').locator('.today-take').click();
  await page.waitForTimeout(500);
  w = writesOf(/\/event_changes/).slice(-1)[0];
  check('take (repeating event): adds a change for that day only (the series is untouched)', !!w && w.method === 'POST'
    && same(w.body, { event_id: pickupId, on_date: TODAY, cancelled: false, responsible_id: ID.alex }) && !seriesWrites().length
    && db.events.find((e) => e.id === pickupId).responsible_id === null && db.event_changes.some((c) => c.event_id === pickupId && c.on_date === TODAY && c.responsible_id === ID.alex),
  JSON.stringify(w));
  check('take (repeating event): the toast says it\'s today only; it moves to my day', (await text(page, '.toast-action span')) === "You're on it today only: School pickup"
    && !(await titles(page, 'nobody')).includes('School pickup') && (await titles(page, 'day')).includes('School pickup'), await lastToast(page));
  await page.click('.toast-action button');
  await page.waitForTimeout(500);
  w = writesOf(/\/event_changes/).slice(-1)[0];
  check('take (repeating event) undo: drops that day\'s change (only if it\'s still mine)', !!w && w.method === 'DELETE' && w.url.includes(`event_id=eq.${pickupId}`)
    && w.url.includes(`on_date=eq.${TODAY}`) && w.url.includes(`responsible_id=eq.${ID.alex}`) && !db.event_changes.some((c) => c.event_id === pickupId)
    && (await titles(page, 'nobody')).includes('School pickup') && (await lastToast(page)) === "Nobody's on it again: School pickup", JSON.stringify(w));
  // Sam took today's pickup on another phone; this screen still shows it as nobody's.
  db.event_changes.push({ event_id: pickupId, on_date: TODAY, cancelled: false, start_time: null, end_time: null, responsible_id: ID.sam, participant_ids: null, note: null });
  await rowFor(page, 'nobody', 'School pickup').locator('.today-take').click();
  await page.waitForTimeout(500);
  check('take (repeating event): someone else changed that day first: says so, shows the latest, keeps theirs', (await lastToast(page)) === 'Someone else just took that one. This is the latest.'
    && !(await titles(page, 'nobody')).includes('School pickup') && db.event_changes.find((c) => c.event_id === pickupId).responsible_id === ID.sam && !(await page.$('.toast-error')));
  // A day that already has a change (Morgan in charge that day): the change row is updated, guarded.
  await rowFor(page, 'nobody', 'Swim club').locator('.today-take').click();
  await page.waitForTimeout(500);
  w = writesOf(/\/event_changes/).slice(-1)[0];
  check('take (a changed day): updates that day\'s change, matching who it had', !!w && w.method === 'PATCH' && same(w.body, { responsible_id: ID.alex })
    && w.url.includes(`event_id=eq.${swimId}`) && w.url.includes(`on_date=eq.${TODAY}`) && w.url.includes(`responsible_id=eq.${ID.morgan}`)
    && db.event_changes.find((c) => c.event_id === swimId).responsible_id === ID.alex && !db.writes.some((x) => /\/events\?/.test(x.url) && x.url.includes(swimId)), JSON.stringify(w));
  await page.click('.toast-action button');
  await page.waitForTimeout(500);
  w = writesOf(/\/event_changes/).slice(-1)[0];
  check('take (a changed day) undo: puts that day\'s person back', !!w && w.method === 'PATCH' && same(w.body, { responsible_id: ID.morgan }) && w.url.includes(`responsible_id=eq.${ID.alex}`)
    && db.event_changes.find((c) => c.event_id === swimId).responsible_id === ID.morgan && (await titles(page, 'nobody')).includes('Swim club'), JSON.stringify(w));
  await page.context().close();

  // =====================================================================
  // 6c. A ticked task: a tap on its box asks, then marks it not done; its title opens its Done entry
  // =====================================================================
  db = todayDb();
  const hw = db.agenda.find((x) => x.title === 'Heartworm pill');
  db.task_log.push({ id: 'log-old', task_id: hw.item_id, occurrence: '2026-09-25', status: 'done', created_at: '2026-09-25T12:00:00.000000+00:00' });
  db.task_log.push({ id: 'log-hw', task_id: hw.item_id, occurrence: TODAY, status: 'done', created_at: '2026-10-25T11:30:00.000000+00:00' });
  db.logs['log-hw'] = { taskId: hw.item_id, lists: { agenda: db.agenda.slice(), late: db.late.slice() }, status: 'open' };
  ({ page, db, log } = await open({ label: 'untick', db }));
  db.confirm = false;
  await rowFor(page, 'day', 'Heartworm pill').locator('.irow-check').click();
  await page.waitForTimeout(400);
  check('untick: a tap on a ticked box asks first; No changes nothing', same(db.dialogs, ['Mark "Heartworm pill" as not done?']) && !calls(db, 'undo_task').length
    && (await rowFor(page, 'day', 'Heartworm pill').locator('.irow-check').getAttribute('aria-checked')) === 'true', JSON.stringify(db.dialogs));
  db.confirm = true;
  await rowFor(page, 'day', 'Heartworm pill').locator('.irow-check').click();
  await page.waitForTimeout(600);
  check('untick: finds that day\'s entry in the task log and undoes it', same(calls(db, 'undo_task').map((c) => c.body), [{ p_log_id: 'log-hw' }])
    && log.some((l) => l.startsWith('GET /rest/v1/task_log?') && l.includes(`task_id=eq.${hw.item_id}`) && l.includes(`occurrence=eq.${TODAY}`)), log.filter((l) => /task_log/.test(l)).join(' | '));
  check('untick: says so and the task is open again', (await lastToast(page)) === 'Not done: Heartworm pill'
    && (await rowFor(page, 'day', 'Heartworm pill').locator('.irow-check').getAttribute('aria-checked')) === 'false', await lastToast(page));
  await page.context().close();
  ({ page, db } = await open({ label: 'open-done' }));
  const plumbingDone = db.agenda.find((x) => x.title === 'Heartworm pill').item_id;
  await rowFor(page, 'day', 'Heartworm pill').locator('.irow-main').click();
  await page.waitForTimeout(300);
  check('open a done task: its Done entry on the Tasks page (where "Not done after all" is)', (await page.evaluate(() => location.hash)) === `#/tasks/${plumbingDone}/done`, await page.evaluate(() => location.hash));
  await page.context().close();

  // =====================================================================
  // 6d. Send their day with Share, on a phone with Web Share: beside WhatsApp, the same message
  // =====================================================================
  ({ page, db } = await open({ label: 'share', share: true, ctx: phone }));
  const shares = () => page.evaluate(() => window.__shares);
  const btns = await page.$$eval('.today-send-btns > *', (es) => es.map((e) => [e.textContent, e.tagName, e.getAttribute('aria-label')]));
  check('share: WhatsApp, Share, Text; Share labelled like its neighbours', same(btns, [['WhatsApp', 'A', 'Send Taylor their day by WhatsApp'], ['Share', 'BUTTON', 'Share Taylor\'s day with another app'],
    ['Text', 'A', 'Send Taylor their day by text']]), JSON.stringify(btns));
  await page.click('.today-send [data-share]');
  await page.waitForTimeout(300);
  let got = await shares();
  const waDay = decodeURIComponent((await page.getAttribute('.today-send [data-via="whatsapp"]', 'href')).split('?text=')[1]);
  check('share: the share sheet gets exactly the WhatsApp message (day_text), from the tap', got.length === 1 && same(got[0].data, { text: msg }) && waDay === msg
    && got[0].event === 'click', JSON.stringify(got));
  check('share: no toast when it went through', (await texts(page, '.toasts .toast')).length === 0);
  await page.evaluate(() => { window.__shareAnswer = 'AbortError'; });
  await page.click('.today-send [data-share]');
  await page.waitForTimeout(300);
  check('share: closing the share sheet (AbortError) shows nothing', (await shares()).length === 2 && (await texts(page, '.toasts .toast')).length === 0, JSON.stringify(await texts(page, '.toasts .toast')));
  await page.evaluate(() => { window.__shareAnswer = 'NotAllowedError'; });
  await page.click('.today-send [data-share]');
  await page.waitForTimeout(300);
  check('share: another error says so in a red toast', (await shares()).length === 3 && (await lastToast(page)) === 'Couldn\'t open the share menu. Try again, or use WhatsApp or Text.'
    && (await page.$$('.toasts .toast-error')).length === 1, await lastToast(page));
  const shareBox = await page.$eval('.today-send [data-share]', (b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
  check('share: a 44px target; no sideways scroll', shareBox[0] >= 44 && shareBox[1] >= 44 && await noSideScroll(page), JSON.stringify(shareBox));
  await page.screenshot({ path: SHOTS + 'today-share-phone.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 7. Phone (390px) and dark mode
  // =====================================================================
  ({ page, db } = await open({ label: 'phone', ctx: phone }));
  check('phone: no sideways scroll', await noSideScroll(page));
  check('phone: the big Add is hidden (the bottom bar has ＋), Today is current in the bar', !(await page.isVisible('.today-head [data-act="add"]'))
    && (await page.getAttribute('.bottombar a[data-tab="today"]', 'aria-current')) === 'page');
  const chipRow = await page.$eval('.today-chips', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX, h: Math.min(...[...e.querySelectorAll('.pchip')].map((c) => c.getBoundingClientRect().height)) }));
  check('phone: the chips scroll sideways inside their own row, each 44px tall', chipRow.ox === 'auto' && chipRow.h >= 44, JSON.stringify(chipRow));
  const phoneSizes = await page.$$eval('.irow-check, .today-take, .today-send .btn, .today-proj, .today-call, .today-more, .today-steps .btn, .today-hide, .today-preview summary', (es) => es.map((e) => { const r = e.getBoundingClientRect(); return [e.className, Math.round(r.width), Math.round(r.height)]; }));
  check('phone: every tap target is at least 44px', phoneSizes.every(([, w, h]) => h >= 44 && w >= 44), JSON.stringify(phoneSizes.filter(([, w, h]) => h < 44 || w < 44)));
  check('phone: one column, sections inside the screen', await page.evaluate(() => [...document.querySelectorAll('.today-card')].every((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })));
  await page.screenshot({ path: SHOTS + 'today-phone.png', fullPage: true });
  // Tap a chip without letting the test scroll it into view first, as a thumb does.
  const scrolled = await page.$eval('.today-chips', (e) => { e.scrollLeft = 60; return e.scrollLeft; });
  await page.$$eval('.today-chips .pchip', (bs) => bs.find((b) => b.textContent.includes('Taylor')).click());
  await page.waitForTimeout(150);
  const after = await page.$eval('.today-chips', (e) => e.scrollLeft);
  check('phone: choosing a chip keeps the chip row where it was scrolled, and the page still fits', same(await pressed(page), ['Taylor']) && scrolled > 0 && after === scrolled && await noSideScroll(page), `${scrolled} → ${after}`);
  await page.context().close();
  ({ page } = await open({ label: 'dark', ctx: Object.assign({ colorScheme: 'dark' }, phone) }));
  const dark = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(document.querySelector('.today-card')).backgroundColor }));
  check('dark: the page and cards use the dark colours', dark.bg === 'rgb(18, 17, 16)' && dark.card === 'rgb(27, 25, 23)', JSON.stringify(dark));
  await page.screenshot({ path: SHOTS + 'today-phone-dark.png', fullPage: true });
  await page.context().close();
  ({ page } = await open({ label: 'dark-desktop', ctx: { colorScheme: 'dark' } }));
  await page.screenshot({ path: SHOTS + 'today-desktop-dark.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 8. "Which one is you?" (an admin without a person row), and a member without one
  // =====================================================================
  db = todayDb();
  db.people.find((p) => p.id === ID.alex).email = null;
  ({ page, log } = await open({ label: 'link', db, allowConsole: /status of 403/ }));
  check('no person row: Everyone is chosen and there is no Me chip', same(await pressed(page), ['Everyone']) && !(await chipLabels(page)).includes('Me'));
  check('no person row: "Which one is you?" offers parents without an email', (await text(page, '.today-who h2')) === 'Which one is you?'
    && same(await texts(page, '.today-who .pchip-name'), ['Alex']) && await page.isDisabled('[data-act="link-me"]'));
  check('no person row: greeting falls back to the sign-in name', (await text(page, '.today-head h1')) === 'Good morning, Alex');
  await page.click('.today-who .pchip');
  await page.waitForTimeout(100);
  check('link: choosing a name enables "That\'s me"', (await page.getAttribute('.today-who .pchip', 'aria-pressed')) === 'true' && !(await page.isDisabled('[data-act="link-me"]')));
  db.saveFail = true;
  await page.click('[data-act="link-me"]');
  await page.waitForTimeout(400);
  check('link fails: the error shows and the button works again', (await text(page, '.toasts .toast-error')) === "You don't have permission to do that." && !(await page.isDisabled('[data-act="link-me"]')));
  db.saveFail = false;
  const peopleReads = log.filter((l) => /\/rest\/v1\/people\?/.test(l)).length;
  db.signedIn = [];
  await page.click('[data-act="link-me"]');
  await page.waitForTimeout(600);
  check('link: save_person gives that parent my sign-in email (and keeps sign-in on)', same(calls(db, 'save_person').slice(-1)[0].body, { p: { id: ID.alex, email: 'alex@example.com' }, p_can_sign_in: true }));
  check('link: counts the email as confirmed and reloads the people', db.signedIn.length === 1 && log.filter((l) => /\/rest\/v1\/people\?/.test(l)).length === peopleReads + 1, `${db.signedIn.length} ${peopleReads} ${log.filter((l) => /people/.test(l)).join(' | ')}`);
  check('link: Me appears and is chosen, the question goes, and a message says so', same(await pressed(page), ['Me']) && !(await page.$('.today-who'))
    && (await lastToast(page)) === 'Thanks, Alex. Today now shows your day.' && same(await titles(page, 'day'), ['Grandma visiting', 'School run', 'Call the plumber', 'Heartworm pill']));
  await page.context().close();

  db = todayDb();
  db.people.find((p) => p.id === ID.sam).email = null;
  ({ page } = await open({ label: 'member', db, email: 'sam@example.com' }));
  check('member without a person row: a note to ask an admin, no picker, Everyone chosen', /Ask an admin/.test(await text(page, '.today-who')) && !(await page.$('[data-act="link-me"]')) && same(await pressed(page), ['Everyone']));
  check('member (not a parent): no "Nobody\'s on it", and unassigned items stay in the list', !(await page.$('[data-list="nobody"]')) && (await titles(page, 'day')).includes('Water the plants'));
  await page.context().close();
  ({ page } = await open({ label: 'adult', email: 'sam@example.com' }));
  check('adult with a person row: their own day, no "Nobody\'s on it"', same(await pressed(page), ['Me']) && same(await titles(page, 'day'), ['Grandma visiting']) && !(await page.$('[data-list="nobody"]'))
    && (await text(page, '.today-head h1')) === 'Good morning, Sam');
  await page.context().close();

  // =====================================================================
  // 9. Checklist done; stale project dates; a failed read; empty day
  // =====================================================================
  db = todayDb();
  db.people.find((p) => p.id === ID.alex).digest_enabled = true;
  db.events.push({ id: uuid(), title: 'Piano', responsible_id: ID.taylor, participant_ids: [ID.jordan], repeat: 'weekly', start_date: '2026-09-01' });
  ({ page, db, log } = await open({ label: 'setup-done', db }));
  check('checklist: gone once every step is done, and this device stops checking', !(await page.$('.today-setup'))
    && (await page.evaluate(() => localStorage.getItem('homehub.today.setup'))) === 'done');
  const reads = log.length;
  await go(page, '#/tasks');
  await go(page, '#/');
  check('checklist: no more setup reads after that', !log.slice(reads).some((l) => /\/rest\/v1\/(events|tasks|contractors)\?/.test(l)), log.slice(reads).join(' | '));
  await page.context().close();

  db = todayDb();
  db.projects.find((p) => p.id === 'p-kitchen').task_dates = null;
  ({ page, db } = await open({ label: 'stale', db }));
  const fill = db.writes.find((w) => w.method === 'PATCH' && /\/projects\?/.test(w.url));
  check('stale project dates: filled in (with task_dates_at), then the agenda is read again', !!fill && Array.isArray(fill.body.task_dates) && !!fill.body.task_dates_at
    && calls(db, 'agenda').length === 2 && (await page.$$('.today-projects li')).length === 1, JSON.stringify((db.writes || []).map((w) => w.url)));
  await page.context().close();

  db = todayDb();
  db.agendaFail = true;
  // (The core logs the error too.)
  ({ page } = await open({ label: 'agenda-fails', db, allowConsole: /status of 500|Database restarting/ }));
  check('a failed read shows the error on the page', (await text(page, '#main .banner-error')) === 'Database restarting', await text(page, '#main'));
  await page.context().close();

  db = todayDb();
  db.agenda = db.agenda.filter((x) => x.kind === 'project');
  db.late = [];
  db.heads = [];
  ({ page } = await open({ label: 'empty', db }));
  check('empty day: a friendly line, and no empty Late or Heads-up sections', /^Nothing for you today\./.test(await text(page, '.today-empty'))
    && !(await page.$('[data-list="late"]')) && !(await page.$('[data-list="heads"]')));
  await chip(page, 'Jordan').click();
  await page.waitForTimeout(100);
  check('empty day (someone else): names them', /^Nothing for Jordan today\./.test(await text(page, '.today-empty')));
  await page.context().close();

  // =====================================================================
  // 9b. Projects today when long jobs overlap (weeks of "on order"): still one short line per project
  // =====================================================================
  db = todayDb();
  const job = (title, day, end, extra) => row(Object.assign({ kind: 'project', item_id: 'p-kitchen', title, day, occurrence: day, end_day: end,
    responsible_id: ID.alex, project_id: 'p-kitchen', project_name: 'Kitchen Renovation' }, extra));
  db.agenda = db.agenda.filter((x) => x.kind !== 'project').concat([
    job('Cabinets on order (≈6 weeks)', '2026-10-12', '2026-11-20'),
    job('Appliances on order (≈4 weeks)', '2026-10-20', '2026-11-13'),
    job('Countertop template & install', TODAY, '2026-10-30'),
    job('Electrical inspection', TODAY, TODAY, PAT),
  ]);
  ({ page } = await open({ label: 'overlap-phone', db, ctx: phone }));
  let overlap = await projectLines(page);
  const projBox = await page.$eval('.today-projects li', (li) => Math.round(li.getBoundingClientRect().height));
  check('projects (3 long overlapping jobs + a one-day job): one compact line, "2 starting today · 2 in progress", the two starting jobs named',
    same(overlap, [['Kitchen Renovation: 2 starting today · 2 in progress', 'Countertop template & install · Electrical inspection', '#/projects/p-kitchen', ['tel:2015550100']]]),
    JSON.stringify(overlap));
  check('projects: no run-on list (no "until", no ";", the jobs in progress are counted, not listed) and short on a phone',
    !/until|;|Cabinets|Appliances/.test(await text(page, '.today-projects')) && projBox <= 140 && await noSideScroll(page), `${projBox}px: ${await text(page, '.today-projects')}`);
  check('projects: the line is a link to the project, at least 44px tall', (await page.$eval('.today-proj', (a) => a.getBoundingClientRect().height)) >= 44);
  await page.locator('.today-sec[aria-label="Projects today"]').screenshot({ path: SHOTS + 'today-projects-phone.png' });
  // More starting today than fit: two named, then "+N more"; a second project with work under way only.
  db.agenda.push(job('Tile delivery', TODAY, TODAY), job('Dumpster swap', TODAY, TODAY),
    row({ kind: 'project', item_id: 'p-pool', title: 'Pump on order', day: '2026-10-20', occurrence: '2026-10-20', end_day: '2026-11-10', project_id: 'p-pool', project_name: 'Pool repairs' }));
  await go(page, '#/tasks');
  await go(page, '#/');
  overlap = await projectLines(page);
  check('projects: more than two starting today reads "+2 more"; a project with only work under way reads "1 in progress", one line each',
    same(overlap, [
      ['Kitchen Renovation: 4 starting today · 2 in progress', 'Countertop template & install · Electrical inspection · +2 more', '#/projects/p-kitchen', ['tel:2015550100']],
      ['Pool repairs: 1 in progress', null, '#/projects/p-pool', []],
    ]) && (await text(page, '.today-sec[aria-label="Projects today"] .sec-count')) === '2', JSON.stringify(overlap));
  await page.context().close();

  // =====================================================================
  // 9c. One person's day lists the project jobs they're on that start today (as their morning email
  //     does): not jobs already under way, done ones, or jobs in an idea / on-hold / done project.
  //     Everyone's day leaves jobs to "Projects today".
  // =====================================================================
  db = todayDb();
  db.agenda = db.agenda.filter((x) => x.kind !== 'project').concat([
    job('Cabinets on order (≈6 weeks)', '2026-10-12', '2026-11-20'),
    job('Countertop template & install', TODAY, '2026-10-30'),
    job('Electrical inspection', TODAY, TODAY, PAT),
    job('Haul away the old cabinets', TODAY, TODAY, { status: 'done' }),
    job('Blow out sprinkler lines', TODAY, TODAY, { item_id: 'p-sprinkler', project_id: 'p-sprinkler', project_name: 'Sprinkler winterization' }),
    job('Tile delivery', TODAY, TODAY, { responsible_id: ID.sam }),
  ]);
  ({ page } = await open({ label: 'jobs-in-day', db }));
  const myDay = await titles(page, 'day');
  check('your day: the jobs you\'re on that start today, after the events and before the tasks; not one under way, a done one, an idea project\'s or someone else\'s',
    same(myDay, ['Grandma visiting', 'School run', 'Countertop template & install', 'Electrical inspection', 'Call the plumber', 'Heartworm pill']), JSON.stringify(myDay));
  check('your day: the count includes them, and there is no "Nothing for you today"',
    (await tc(page, '.today-sec[aria-label="Your day"] .sec-head')) === 'Your day6' && !(await page.$('.today-empty')), await tc(page, '.today-sec[aria-label="Your day"] .sec-head'));
  const jobRow = page.locator('[data-list="day"] .irow', { hasText: 'Electrical inspection' });
  check('your day: a job row names its project and contractor, has a call link and no checkbox',
    /Kitchen Renovation · Pat Lee/.test(await jobRow.innerText()) && (await jobRow.locator('.irow-call').count()) === 1 && (await jobRow.locator('.irow-check').count()) === 0,
    await jobRow.innerText());
  await jobRow.locator('.irow-main').click();
  await page.waitForTimeout(200);
  check('your day: tapping a job opens its project', (await page.evaluate(() => location.hash)) === '#/projects/p-kitchen', await page.evaluate(() => location.hash));
  await go(page, '#/');
  await chip(page, 'Sam').click();
  await page.waitForTimeout(100);
  check('someone else\'s day: their job starting today', (await titles(page, 'day')).includes('Tile delivery') && !(await titles(page, 'day')).includes('Electrical inspection'),
    JSON.stringify(await titles(page, 'day')));
  await page.locator('.today-chips [data-view="all"]').click();
  await page.waitForTimeout(100);
  const allDay = await titles(page, 'day');
  check('everyone\'s day: no job rows (they\'re in "Projects today")', !allDay.some((t) => /Countertop|Electrical|Tile delivery/.test(t))
    && (await page.$('.today-sec[aria-label="Projects today"]')) !== null, JSON.stringify(allDay));
  await page.context().close();

  // Left open overnight: looked at again, it moves on to the household's new day.
  ({ page, db, log } = await open({ label: 'left-open' }));
  const shown = () => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.setFixedTime(new Date('2026-01-15T05:03:00Z'));
  await shown();
  await page.waitForTimeout(400);
  check('left open: back within 5 minutes, nothing is read again', calls(db, 'agenda').length === 1);
  db.clock = { local_date: '2026-10-26', local_time: '06:10:00', tz: 'America/New_York' };
  db.agenda.push(row({ title: 'Bake sale', day: '2026-10-26', responsible_id: ID.alex }));
  await page.clock.setFixedTime(new Date('2026-01-15T05:10:00Z'));
  await shown();
  await page.waitForTimeout(600);
  check('left open: after 5 minutes away, the household\'s clock and the new day are read', same(calls(db, 'agenda').slice(-1)[0].body, { p_from: '2026-10-26', p_to: '2026-10-26' })
    && (await tc(page, '.today-head .eyebrow')) === 'Monday, October 26' && same(await titles(page, 'day'), ['Grandma visiting', 'Bake sale']), await tc(page, '.today-head .eyebrow'));
  await page.context().close();

  // =====================================================================
  // 9d. Schema 3: Google Calendar events in the day, and the one-time notice
  // =====================================================================
  const gRpc = Object.assign({ hub_schema_version: () => 3 }, calendarRpc);
  // Jordan's and Alex's Hub calendars and the family account's main calendar (Family, read only).
  // approved: when the first calendar's Start copying was pressed (null: never).
  function googleTodayDb(approved) {
    const g = withCalendars(todayDb(), { auth: 'service_account' });
    const jc = calendarRow({ google_id: 'jordan0123@group.calendar.google.com', kind: 'person', person_id: ID.jordan, label: 'Jordan', status: 'ok', google_name: 'Hub – Jordan',
      copy_approved_at: approved === undefined ? '2026-10-20T13:00:00+00:00' : approved });
    const ac = calendarRow({ google_id: 'alex0456@group.calendar.google.com', kind: 'person', person_id: ID.alex, label: 'Alex', status: 'ok', google_name: 'Hub – Alex' });
    const fc = calendarRow({ google_id: 'family@example.com', kind: 'family', label: 'Family account', writes: false, status: 'ok' });
    g.calendars.push(jc, ac, fc);
    const ge = (c, o) => googleEventRow(Object.assign({ calendar_id: c.id, google_calendar: c.google_id, start_day: TODAY, end_day: TODAY }, o));
    const timed = (from, to) => ({ all_day: false, start_at: at(from), end_at: at(to) });
    g.google_events.push(
      ge(jc, Object.assign({ title: 'Swim meet', location: 'Maple Pool' }, timed('09:30', '10:30'))),
      ge(jc, Object.assign({ title: '', private: true }, timed('12:00', '13:00'))),
      ge(ac, Object.assign({ title: 'Alex dentist' }, timed('07:00', '07:30'))),
      ge(fc, { title: 'Farmers market' }),
      ge(fc, { title: 'Tomorrow\'s fair', start_day: addDays(TODAY, 1), end_day: addDays(TODAY, 1) }),
    );
    return g;
  }
  ({ page, db, log } = await open({ label: 'google', db: googleTodayDb(), rpc: gRpc }));
  check('schema 3: no meals request and no dinner line (the tables come with schema 4)', !log.some((l) => /\/rest\/v1\/meals/.test(l)) && !(await page.$('.today-dinner')));
  check('schema 3: google_items for today only', same(calls(db, 'google_items').map((c) => c.body), [{ p_from: TODAY, p_to: TODAY }]), JSON.stringify(calls(db, 'google_items')));
  check('your day: your Google events and Family\'s, in time order with the rest (all-day first, then by time, then tasks)',
    same(await titles(page, 'day'), ['Farmers market', 'Grandma visiting', 'Alex dentist', 'School run', 'Call the plumber', 'Heartworm pill']), (await titles(page, 'day')).join(','));
  const gRow = (title) => page.$$eval('[data-list="day"] .irow', (rs, t) => {
    const r = rs.find((x) => x.querySelector('.irow-title').firstChild.textContent === t);
    return r ? { cls: r.className, box: !!r.querySelector('.irow-check'), who: r.querySelectorAll('.irow-who .pdot').length, sub: (r.querySelector('.irow-sub') || {}).textContent || '',
      time: r.querySelector('.irow-time').innerText.replace(/\s+/g, ' '), pc: r.style.getPropertyValue('--pc') } : null;
  }, title);
  const dentist = await gRow('Alex dentist');
  check('a Google row: k-google, no tick box, no who dots, "Google", its times, the person\'s colour', /k-google/.test(dentist.cls) && !dentist.box && !dentist.who
    && dentist.sub === 'Google' && dentist.time === '7:00am 7:30am' && dentist.pc === '#2563eb', JSON.stringify(dentist));
  await chip(page, 'Jordan').click();
  await page.waitForTimeout(100);
  check('Jordan\'s day (a kid): his Google events (a private one as "Private item"), not Alex\'s, nor a calendar to read without Show to kids (as on his My day)',
    same(await titles(page, 'day'), ['School run', 'Swim meet', 'Private item', 'Piano', 'Take out recycling']), (await titles(page, 'day')).join(','));
  await page.context().close();
  // Kids and helpers see on Today what reaches their own My day and texts: a kid, Hub – Family's and
  // a calendar to read marked Show to kids; a helper, no Family calendar at all.
  const kidsDb = googleTodayDb();
  const hf = calendarRow({ google_id: 'family0654@group.calendar.google.com', kind: 'family', label: 'Family', status: 'ok', google_name: 'Hub – Family' });
  const sc = calendarRow({ google_id: 'school0111@group.calendar.google.com', kind: 'family', label: 'School', writes: false, for_kids: true, status: 'ok', google_name: 'Maple School' });
  kidsDb.calendars.push(hf, sc);
  kidsDb.google_events.push(
    googleEventRow({ calendar_id: hf.id, google_calendar: hf.google_id, start_day: TODAY, end_day: TODAY, title: 'Picnic' }),
    googleEventRow({ calendar_id: sc.id, google_calendar: sc.google_id, start_day: TODAY, end_day: TODAY, title: 'School holiday' }));
  ({ page, db } = await open({ label: 'google-kids', db: kidsDb, rpc: gRpc }));
  const familyRows = async () => (await titles(page, 'day')).filter((t) => ['Farmers market', 'Picnic', 'School holiday'].includes(t)).sort();
  check('your day (a parent): every Family calendar\'s events', same(await familyRows(), ['Farmers market', 'Picnic', 'School holiday']), JSON.stringify(await familyRows()));
  await chip(page, 'Jordan').click();
  await page.waitForTimeout(100);
  check('Jordan\'s day (a kid): Hub – Family\'s and Show to kids\' events, not the family account\'s main calendar', same(await familyRows(), ['Picnic', 'School holiday']),
    JSON.stringify(await familyRows()));
  await chip(page, 'Taylor').click();
  await page.waitForTimeout(100);
  check('Taylor\'s day (the helper): no Family calendar\'s events', same(await familyRows(), []), JSON.stringify(await familyRows()));
  await page.context().close();
  ({ page, db } = await open({ label: 'google', db: googleTodayDb(), rpc: gRpc }));
  await chip(page, 'Everyone').click();
  await page.waitForTimeout(100);
  const everyone = await titles(page, 'day');
  check('Everyone: every Google event of today (not tomorrow\'s)', ['Farmers market', 'Alex dentist', 'Swim meet', 'Private item'].every((t) => everyone.includes(t)) && !everyone.includes('Tomorrow\'s fair'), everyone.join(','));
  check('never in Late, Heads-up or Nobody\'s on it', !(await page.$$eval('[data-list="late"] .irow, [data-list="heads"] .irow, [data-list="nobody"] .irow', (rs) => rs.some((r) => r.classList.contains('k-google')))));
  check('the notice: once, after the first Start copying, with a close button', (await tc(page, '.today-gnotice p')) === 'Home Hub now copies the calendar to Google and the kitchen wall. Mark anything that shouldn\'t be seen there Private.'
    && (await page.getAttribute('.today-gnotice-x', 'aria-label')) === 'Close this notice', await tc(page, '.today-gnotice'));
  await page.screenshot({ path: SHOTS + 'today-google-desktop-light.png', fullPage: true });
  await page.click('.today-gnotice-x');
  await page.waitForTimeout(100);
  check('the notice: closes, and this browser remembers', !(await page.$('.today-gnotice')) && (await page.evaluate(() => localStorage.getItem('homehub.today.googleNotice'))) === 'closed');
  await chip(page, 'Jordan').click();
  await page.waitForTimeout(100);
  check('the notice: stays closed when the page redraws', !(await page.$('.today-gnotice')));
  await page.reload();
  await page.waitForTimeout(800);
  check('the notice: stays closed after a reload (no calendars read for it)', !(await page.$('.today-gnotice')) && !!(await page.$('[data-list="day"]')));
  await page.click('[data-list="day"] .irow.k-google .irow-main');
  await page.waitForTimeout(300);
  check('a tap on a Google event opens today on the Calendar', (await page.evaluate(() => location.hash)) === `#/calendar/${TODAY}`, await page.evaluate(() => location.hash));
  await page.context().close();
  for (const [what, approved] of [['more than 14 days after Start copying', '2026-10-05T13:00:00+00:00'], ['no calendar approved yet', null]]) {
    ({ page } = await open({ label: `google-${approved ? 'old' : 'none'}`, db: googleTodayDb(approved), rpc: gRpc }));
    check(`no notice ${what}`, !(await page.$('.today-gnotice')) && !!(await page.$('[data-list="day"] .irow.k-google')));
    await page.context().close();
  }
  const failing = googleTodayDb();
  failing.googleFail = true;
  ({ page } = await open({ label: 'google-fail', db: failing, rpc: gRpc, allowConsole: /status of 500/ }));
  check('google_items fails: the day still shows, with one line saying so', (await tc(page, '.today-gfail')) === 'Google events couldn\'t be loaded.'
    && same(await titles(page, 'day'), ['Grandma visiting', 'School run', 'Call the plumber', 'Heartworm pill']), await tc(page, '.today-gfail'));
  await page.context().close();
  for (const scheme of ['light', 'dark']) {
    ({ page } = await open({ label: `google-phone-${scheme}`, db: googleTodayDb(), rpc: gRpc, ctx: Object.assign({ colorScheme: scheme }, phone) }));
    const x = await page.$eval('.today-gnotice-x', (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    check(`phone (${scheme}): the notice fits, its close button is 44px; no sideways scroll`, x[0] >= 44 && x[1] >= 44 && await noSideScroll(page)
      && await page.$eval('.today-gnotice', (e) => e.getBoundingClientRect().right <= window.innerWidth), JSON.stringify(x));
    const ring = await page.$eval('[data-list="day"] .irow.k-google .irow-title', (t) => getComputedStyle(t, '::before').borderTopStyle);
    check(`phone (${scheme}): Google rows have the outlined dot`, ring === 'solid', ring);
    await page.screenshot({ path: SHOTS + `today-google-phone-${scheme}.png`, fullPage: true });
    await page.context().close();
  }
  ({ page } = await open({ label: 'google-desktop-dark', db: googleTodayDb(), rpc: gRpc, ctx: { colorScheme: 'dark', viewport: { width: 1280, height: 900 } } }));
  check('1280px (dark): no sideways scroll', await noSideScroll(page));
  await page.screenshot({ path: SHOTS + 'today-google-desktop-dark.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 9e. Schema 4 (v1.2): tonight's dinner
  // =====================================================================
  const fRpc = Object.assign({ hub_schema_version: () => 4 }, calendarRpc);
  const dinnerDb = (...meals) => {
    const d = withFood(todayDb());
    meals.forEach((m) => d.meals.push(mealRow(Object.assign({ day: TODAY }, m))));
    return d;
  };
  const dinnerLine = (page) => page.$eval('.today-dinner', (a) => ({ text: a.querySelector('.today-dinner-line') ? a.querySelector('.today-dinner-line').textContent.replace(/\s+/g, ' ').trim() : a.textContent.trim(),
    note: (a.querySelector('.today-dinner-note') || {}).textContent || null, href: a.getAttribute('href'), lock: !!a.querySelector('.today-dinner-lock'), quiet: a.classList.contains('is-quiet'),
    under: a.previousElementSibling && a.previousElementSibling.classList.contains('today-chips') })).catch(() => null);
  ({ page, db, log } = await open({ label: 'dinner', rpc: fRpc, db: dinnerDb({ title: 'Tacos', cook_id: ID.sam, note: 'Chicken is in the freezer', link: 'https://cooking.example.com/tacos' }) }));
  let dl = await dinnerLine(page);
  check('schema 4: one line under the person chips, "Dinner: Tacos · Sam cooks", the note under it, to today on the Food page',
    same(dl, { text: 'Dinner: Tacos · Sam cooks', note: 'Chicken is in the freezer', href: `#/food/${TODAY}`, lock: false, quiet: false, under: true }), JSON.stringify(dl));
  check('schema 4: meals read once, 14 days before to today, the columns the line needs', same(log.filter((l) => /\/rest\/v1\/meals/.test(l)).map(decodeURIComponent),
    [`GET /rest/v1/meals?select=day,slot,kind,title,cook_id,note,private&day=gte.${addDays(TODAY, -14)}&day=lte.${TODAY}`]), JSON.stringify(log.filter((l) => /meals/.test(l))));
  await chip(page, 'Jordan').click();
  await page.waitForTimeout(100);
  check('the same line under every chip', same(await dinnerLine(page), dl));
  await page.click('.today-dinner');
  await page.waitForTimeout(300);
  check('a tap opens today\'s dinner on the Food page', (await page.evaluate(() => location.hash)) === `#/food/${TODAY}` && (await text(page, '#stubDay')) === TODAY);
  await page.context().close();
  ({ page } = await open({ label: 'dinner-sam', email: 'sam@example.com', rpc: fRpc, db: dinnerDb({ title: 'Tacos', cook_id: ID.sam }) }));
  dl = await dinnerLine(page);
  check('the cook sees "You cook"', dl && dl.text === 'Dinner: Tacos · You cook', JSON.stringify(dl));
  await page.context().close();
  ({ page } = await open({ label: 'dinner-leftovers', rpc: fRpc, db: dinnerDb({ kind: 'leftovers', title: null, cook_id: ID.taylor, private: true }) }));
  dl = await dinnerLine(page);
  check('leftovers: "Dinner: Leftovers · Taylor\'s on dinner", with a lock when it is locked', dl && dl.text === 'Dinner: Leftovers, locked · Taylor\'s on dinner' && dl.lock, JSON.stringify(dl));
  await page.context().close();
  ({ page } = await open({ label: 'dinner-quiet', rpc: fRpc, db: dinnerDb({ day: addDays(TODAY, -3), title: 'Soup' }, { day: addDays(TODAY, 1), title: 'Pizza' }) }));
  dl = await dinnerLine(page);
  check('no dinner tonight, one 3 days ago: a quiet "What\'s for dinner? ›" to the Food page', dl && dl.text === 'What\'s for dinner? ›' && dl.quiet && dl.href === `#/food/${TODAY}`, JSON.stringify(dl));
  await page.context().close();
  const old = dinnerDb();
  old.meals.push(mealRow({ day: addDays(TODAY, -15), title: 'Soup' }), mealRow({ day: addDays(TODAY, 2), title: 'Pizza' }));
  ({ page } = await open({ label: 'dinner-none', rpc: fRpc, db: old }));
  check('none tonight and none in the 14 days before: no prompt at all', !(await page.$('.today-dinner')) && (await titles(page, 'day')).length > 0);
  await page.context().close();
  ({ page, db } = await open({ label: 'dinner-fail', rpc: fRpc, db: dinnerDb({ title: 'Tacos' }), allowConsole: /status of 500/, path: '/#/tasks' }));
  await page.route('**/rest/v1/meals*', (route) => route.fulfill({ status: 500, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'XX000', message: 'Database restarting' }) }));
  await go(page, '#/');
  await page.waitForTimeout(300);
  check('the read fails: no line, and the day draws as usual', !(await page.$('.today-dinner')) && same(await titles(page, 'day'), ['Grandma visiting', 'School run', 'Call the plumber', 'Heartworm pill']),
    JSON.stringify(await titles(page, 'day')));
  await page.context().close();
  for (const scheme of ['light', 'dark']) {
    ({ page } = await open({ label: `dinner-phone-${scheme}`, rpc: fRpc, db: dinnerDb({ title: 'Tacos', cook_id: ID.sam, note: 'Chicken is in the freezer' }), ctx: Object.assign({ colorScheme: scheme }, phone) }));
    const box = await page.$eval('.today-dinner', (a) => { const r = a.getBoundingClientRect(); return [Math.round(r.height), r.right <= window.innerWidth]; });
    check(`schema 4 phone (${scheme}): the dinner line is a 44px+ target that fits; no sideways scroll`, box[0] >= 44 && box[1] && await noSideScroll(page), JSON.stringify(box));
    await page.screenshot({ path: SHOTS + `today-dinner-phone-${scheme}.png` });
    await page.context().close();
  }
  ({ page } = await open({ label: 'dinner-desktop', rpc: fRpc, db: dinnerDb({ title: 'Tacos', cook_id: ID.sam }), ctx: { viewport: { width: 1280, height: 900 } } }));
  await page.screenshot({ path: SHOTS + 'today-dinner-desktop.png' });
  await page.context().close();

  // =====================================================================
  // 10. v1 mode: no Today page, no v2 reads
  // =====================================================================
  ({ page, log } = await open({ label: 'v1', v1: true, db: makeDb() }));
  check('v1: the v1 tabs, no Today, no agenda reads', same(await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent)), ['Home', 'Projects', 'Contractors', 'Family'])
    && !(await page.$('.today-head')) && !log.some((l) => /rpc\/(agenda|late_items|heads_up|day_text)/.test(l)));
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
