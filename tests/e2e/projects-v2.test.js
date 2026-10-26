// Browser tests for the Projects pages with a v2 database (assets/modules/projects.js): the tab after
// Tasks, dates by the household's clock (not the device's), the owner and "Show in Home Hub calendar"
// in the settings, the Tasks card (tick off with Undo, + Task through the Tasks page's form, edit),
// "Put on the schedule" (a Gantt task through the schedule save, then the task row is deleted), the
// "Dates are being refreshed" note, the provides for Today, phones, dark mode, and v1 mode untouched.
//
// The fake RPCs answer with the shapes in supabase/migrations/0002_home_hub_v2.sql (clock: one object;
// complete_task: the task_log id; undo_task: the task id; mark_signed_in: null). Writes to projects
// are recorded and go through a stand-in for the projects_mark_dates_stale trigger (a schedule written
// without a new task_dates_at gets task_dates null), so a save that forgot them would show. The real
// Tasks page is loaded (its form is what + Task opens); the other v2 pages are small stubs served in
// place of their files. The browser runs in Pacific/Honolulu with its clock in January, while the
// household (America/New_York) is on Sunday Oct 25 from clock().
// Run alone with: node tests/e2e/projects-v2.test.js
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

const TODAY = '2026-10-25'; // the household's date (a Sunday); the device is on Jan 14, evening
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ---- Fixtures (fictional people, 555-01xx numbers, example.com)
const T = '2026-10-24T16:00:00.000000+00:00';
const ID = {
  alex: '0b1e0000-0000-4000-8000-000000000001', sam: '0b1e0000-0000-4000-8000-000000000002',
  jordan: '0b1e0000-0000-4000-8000-000000000003', taylor: '0b1e0000-0000-4000-8000-000000000004',
  morgan: '0b1e0000-0000-4000-8000-000000000005',
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
  notes: null, category: 'home', responsible_id: null, due_date: null, due_time: null, lead_days: 0, project_id: 'p-kitchen', contractor_id: null,
  private: false, repeat_mode: 'none', every_count: null, every_unit: null, repeat_weekdays: [], anchor_date: null, last_done: null,
  active: true, done_at: null, done_by: null, created_by: 'alex@example.com', updated_by: 'alex@example.com', created_at: T, updated_at: T,
};
const task = (o) => {
  const r = Object.assign({ id: uuid() }, TASK_DEFAULTS, o);
  if (r.repeat_mode !== 'none' && !r.anchor_date) r.anchor_date = r.due_date;
  return Object.fromEntries(TASK_COLS.map((k) => [k, r[k]]));
};
let logSeq = 100;

function projDb() {
  const db = makeDb();
  db.people = [
    person(ID.morgan, 'Morgan Example', 'parent', '#9333ea', 5, { active: false }),
    person(ID.taylor, 'Taylor Example', 'helper', '#ca8a04', 4, { phone: '(201) 555-0104' }),
    person(ID.alex, 'Alex Example', 'parent', '#2563eb', 1, { email: 'alex@example.com', email_verified_at: T }),
    person(ID.jordan, 'Jordan Example', 'kid', '#16a34a', 3),
    person(ID.sam, 'Sam Example', 'parent', '#db2777', 2, { email: 'sam@example.com' }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: ID.alex, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '07:45:00', tz: 'America/New_York' };
  db.projects.forEach((p) => Object.assign(p, { task_dates: [], task_dates_at: T, on_calendar: true, owner_id: null }));
  // Updated just after midnight UTC: Oct 25 in New York, still Oct 24 on the Honolulu device.
  db.projects.find((p) => p.id === 'p-kitchen').updated_at = '2026-10-25T08:00:00.000000+00:00';
  // The sprinkler job was due Mon Oct 19: behind by the household's date, not yet started by the device's (January).
  db.projects.find((p) => p.id === 'p-sprinkler').schedule.project.start = '2026-10-19';
  db.projects.find((p) => p.id === 'p-pool').owner_id = ID.morgan;
  db.contractors.forEach((c) => { c.kind = 'contractor'; });
  db.contractors.find((c) => c.id === 'c-maria').kind = null; // a row from before v2 counts as a contractor
  db.contractors.push({ id: 'c-acme', name: 'Acme Internet', company: null, trade: null, phone: '(201) 555-0150', email: null, website: null, notes: null, kind: 'account', category: 'Internet', created_at: T, updated_at: T });
  db.contractors.push({ id: 'c-vet', name: 'Happy Paws Vet', company: null, trade: null, phone: '(201) 555-0151', email: null, website: null, notes: null, kind: 'service', category: 'Vet', created_at: T, updated_at: T });
  const K = {};
  const add = (key, o) => { const t = task(o); K[key] = t; return t; };
  db.tasks = [
    add('tile', { title: 'Order the backsplash tile', responsible_id: ID.alex, due_date: '2026-10-28', contractor_id: 'c-maria' }),
    add('permit', { title: 'Call the electrician about permits', responsible_id: ID.sam, due_date: '2026-10-22', contractor_id: 'c-pat' }),
    add('hardware', { title: 'Pick cabinet hardware', notes: 'Brushed brass, 96mm centers' }),
    add('water', { title: 'Water the new plants', responsible_id: ID.jordan, due_date: TODAY, due_time: '09:00:00', repeat_mode: 'schedule', every_count: 1, every_unit: 'week' }),
    add('photo', { title: 'Photograph the old kitchen', responsible_id: ID.alex, due_date: '2026-10-24', active: false }),
    add('done', { title: 'Measure the window', due_date: '2026-10-20', done_at: '2026-10-20T14:00:00.000000+00:00', done_by: 'alex@example.com' }),
    add('pool', { title: 'Clean the pool filter', project_id: 'p-pool', due_date: '2026-10-30' }),
    add('loose', { title: 'Buy birthday present', project_id: null }),
  ];
  db.task_log = [];
  db.K = K;
  return db;
}

// ---- RPC fakes with the migration's shapes and rules (only what this page calls)
const fail = (status, code, message, hint) => ({ __status: status, body: { code, message, details: null, hint: hint || null } });
const projRpc = (extra) => Object.assign({
  hub_schema_version: () => 2,
  clock: (db) => Object.assign({}, db.clock),
  mark_signed_in: () => null,
  // complete_task(p_id, p_occurrence, p_done_on, p_note) → task_log id
  complete_task: (db, b, email) => {
    if (db.completeFail) return fail(500, 'XX000', 'Database restarting');
    const t = db.tasks.find((x) => x.id === b.p_id);
    if (!t) return fail(404, 'P0002', 'That task no longer exists.');
    if (db.raceDone) { db.raceDone = false; return fail(400, 'P0001', t.repeat_mode === 'none' ? 'already done' : 'already completed', 'Someone already ticked this off.'); }
    if (t.active === false) return fail(400, '22023', 'This task is paused. Turn it back on before ticking it off.');
    const id = uuid();
    const doneOn = b.p_done_on || db.clock.local_date;
    if (t.repeat_mode === 'none') {
      if (t.done_at) return fail(400, 'P0001', 'already done', 'Someone already ticked this off.');
      const at = '2026-10-25T12:00:00.000000+00:00';
      db.task_log.push(Object.fromEntries(LOG_COLS.map((k) => [k, { id, task_id: t.id, occurrence: t.due_date, status: 'done', done_on: doneOn, done_by: email, note: null, prev_due: null, prev_last_done: null, prev_done_at: t.done_at, created_at: at, seq: logSeq++ }[k]])));
      Object.assign(t, { done_at: at, done_by: email });
      return id;
    }
    if (b.p_occurrence && b.p_occurrence !== t.due_date) return fail(400, 'P0001', 'already completed', 'This date was already ticked off or skipped.');
    // Weekly on set dates, no weekdays: the next date is a week on from the anchor's series.
    let next = t.anchor_date;
    while (next <= (doneOn > t.due_date ? doneOn : t.due_date)) next = addDays(next, 7 * t.every_count);
    db.task_log.push(Object.fromEntries(LOG_COLS.map((k) => [k, { id, task_id: t.id, occurrence: t.due_date, status: 'done', done_on: doneOn, done_by: email, note: null, prev_due: t.due_date, prev_last_done: t.last_done, prev_done_at: null, created_at: '2026-10-25T12:00:00.000000+00:00', seq: logSeq++ }[k]])));
    Object.assign(t, { due_date: next, last_done: doneOn });
    return id;
  },
  // undo_task(p_log_id) → task id: only the task's latest entry.
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

// ---- Stub v2 pages (Tasks is the real one): same register() contract as the real ones
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true }, provides: 'openEventForm' },
  directory: { nav: { label: 'Directory', order: 50 } },
  people: { nav: { label: 'Family', order: 60 } },
  settings: { nav: { label: 'Settings', order: 70 } },
};
const stubModule = (name, s) => `;(function () {
  var provides = {};
  ${s.provides ? `provides[${JSON.stringify(s.provides)}] = function () {};` : ''}
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
    const db = opts.db || projDb();
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 }, timezoneId: 'Pacific/Honolulu' }, opts.ctx));
    await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    // The device's clock: Wednesday Jan 14, 7pm in Honolulu, and running (each save's task_dates_at is
    // a new instant, as on a real device). The household's date comes from clock().
    await page.clock.install({ time: new Date('2026-01-15T05:00:00Z') });
    await page.clock.resume();
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    // Steps that make the database refuse something on purpose set expect.failures while they run.
    const expect = { failures: false };
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (expect.failures && /status of (400|409|500)/.test(m.text())) return;
      if (opts.v1 && /status of 404/.test(m.text()) && /hub_schema_version$/.test(m.location().url || '')) return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => d.accept());
    await install(page, db, log, { rpc: opts.v1 ? {} : projRpc(opts.rpc) });
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
    const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // Writes to projects: recorded as sent, then the stand-in for projects_mark_dates_stale, then the mock.
    db.projectWrites = [];
    await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/projects', (route) => {
      const req = route.request();
      if (req.method() !== 'PATCH') return route.fallback();
      const body = JSON.parse(req.postData() || 'null');
      const url = decodeURIComponent(req.url());
      db.projectWrites.push({ url, body });
      if (db.fkFail && 'owner_id' in body) return json(route, 409, { code: '23503', message: 'insert or update on table "projects" violates foreign key constraint "projects_owner_id_fkey"', details: null, hint: null });
      if (db.conflict && 'schedule' in body) return json(route, 200, []);
      // The core's quiet backfill (task_dates without a schedule): answer as if someone changed the project.
      if (db.backfillConflict && !('schedule' in body) && 'task_dates' in body) return json(route, 200, []);
      const id = (new URL(req.url()).searchParams.get('id') || '').replace(/^eq\./, '');
      const old = db.projects.find((p) => p.id === id);
      if (old && 'schedule' in body && JSON.stringify(body.schedule) !== JSON.stringify(old.schedule) && (body.task_dates_at === undefined || body.task_dates_at === old.task_dates_at)) {
        return route.fallback({ postData: JSON.stringify(Object.assign({}, body, { task_dates: null })) });
      }
      return route.fallback();
    });
    // Reads and deletes of tasks: recorded; a test can make one fail.
    db.taskDeletes = [];
    await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/tasks', (route) => {
      const req = route.request();
      if (req.method() === 'DELETE') {
        db.taskDeletes.push(decodeURIComponent(req.url()));
        if (db.deleteFail) return json(route, 500, { code: 'XX000', message: 'Database restarting', details: null, hint: null });
      }
      if (req.method() === 'GET' && db.readFail) { db.readFail--; return json(route, 500, { code: 'XX000', message: 'Database restarting', details: null, hint: null }); }
      return route.fallback();
    });
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule(name, s) }));
    }
    if (opts.v1) await page.route('**/assets/modules/tasks.js*', (route) => route.fulfill({ contentType: 'application/javascript', body: '// not under test' }));
    await page.goto(BASE + (opts.path || '/#/projects/p-kitchen'));
    await page.waitForTimeout(opts.wait || 900);
    return { page, db, log, context, expect };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.innerText.trim()));
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  // The card's row titles, without the screen-reader ", repeats".
  const titles = (page) => page.$$eval('.ptasks .irow-title', (es) => es.map((e) => e.firstChild.textContent));
  const rowFor = (page, title) => page.locator('.ptasks .ptask', { hasText: title }).first();
  const calls = (db, name) => (db.rpcCalls || []).filter((c) => c.name === name);
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const toasts = (page) => texts(page, '.toasts .toast');
  const lastToast = async (page) => (await toasts(page)).slice(-1)[0] || '';
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(600); };
  const formOpen = (page) => page.evaluate(() => document.getElementById('formDialog').open);
  const formError = (page) => text(page, '#formDialog .form-error');
  const schedWrites = (db) => db.projectWrites.filter((w) => 'schedule' in w.body);
  const kitchen = (db) => db.projects.find((p) => p.id === 'p-kitchen');
  const allTasks = (s) => (s.phases || []).flatMap((p) => p.tasks || []);
  const small = (page, sel) => page.$$eval(sel, (es) => es.filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return [e.className || e.tagName, e.textContent.trim().slice(0, 24), Math.round(r.width), Math.round(r.height)]; })
    .filter(([, , w, h]) => w < 44 || h < 44));

  // =====================================================================
  // 1. Registration: Projects is a v2 page too, after Tasks, in More on phones
  // =====================================================================
  let { page, db, log, expect } = await open({ label: 'desktop' });
  const reg = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]),
    bar: [...document.querySelectorAll('.bottombar a')].map((a) => a.textContent.trim()),
    provides: Object.keys(HomeHub.core.use('projects')).sort(),
    version: HomeHub.core.schemaVersion,
  }));
  check('register: v2 mode, Projects is the fourth tab (after Today, Calendar, Tasks), at "#/projects", current on a project page',
    reg.version === 2 && same(reg.tabs.map((t) => t[0]), ['Today', 'Calendar', 'Tasks', 'Projects', 'Directory', 'Family', 'Settings']) && same(reg.tabs[3], ['Projects', '#/projects', 'page']), JSON.stringify(reg.tabs));
  check('register: not in the phone bottom bar (it goes in More)', !reg.bar.includes('Projects'), reg.bar.join(','));
  check('register: still provides projectCard, emptyProjects and newProjectForm (for Today)', same(reg.provides, ['emptyProjects', 'newProjectForm', 'projectCard']), reg.provides.join(','));
  const css = await page.evaluate(() => {
    const l = document.querySelector('link[href*="assets/css/projects.css"]');
    const hub = document.querySelector('script[src*="assets/hub.js"]').getAttribute('src').split('?')[1];
    return { href: l && l.getAttribute('href'), hub, applied: getComputedStyle(document.querySelector('.ptasks-tools .btn')).minHeight };
  });
  check('styles: projects.css is on the page, with the same ?v= as the scripts, and applies', css.href === `assets/css/projects.css?${css.hub}` && css.applied === '44px', JSON.stringify(css));

  // =====================================================================
  // 2. The project page: household dates, the heading, the Tasks card
  // =====================================================================
  const stats = await text(page, '[data-ref="stats"]');
  check('schedule: "today" is the household\'s (work begins in 8 days, not 292 from the device\'s January)', /Work begins in 8 days/.test(stats), stats.replace(/\s+/g, ' ').slice(0, 160));
  check('head: "Updated" is the household\'s date (Oct 25 in New York; the device says Oct 24)', /Updated Oct 25, 2026/.test(await tc(page, '[data-ref="head"] .meta')), await tc(page, '[data-ref="head"] .meta'));
  check('head: the schedule button reads "+ Schedule task"; no owner line yet; no stale-dates note',
    (await tc(page, '[data-ref="head"] [data-act="add-task"]')) === '+ Schedule task' && !/Owner/.test(await tc(page, '[data-ref="head"] .meta')) && !(await page.$('.proj-stale')));
  const reads = log.map((l) => decodeURIComponent(l));
  check('tasks card: reads this project\'s open tasks (project_id, done_at is null)', reads.includes('GET /rest/v1/tasks?select=*&project_id=eq.p-kitchen&done_at=is.null'), reads.filter((l) => /tasks/.test(l)).join(' | '));
  check('tasks card: heading and count; only this project\'s open tasks, by due date (no date last)',
    (await tc(page, '.ptasks .card-head h2')) === 'Tasks' && (await tc(page, '.ptasks .sec-count')) === '5'
    && same(await titles(page), ['Call the electrician about permits', 'Photograph the old kitchen', 'Water the new plants', 'Order the backsplash tile', 'Pick cabinet hardware']), (await titles(page)).join(' | '));
  check('tasks card: days by the household\'s date (late one dated and badged; "Yesterday"; "Today" with its time; "No date")',
    same(await texts(page, '.ptasks .irow-time'), ['Thu Oct 22', 'Yesterday', 'Today\n9:00am', 'Wed Oct 28', 'No date']) && /Late/.test(await rowFor(page, 'electrician').innerText()),
    JSON.stringify(await texts(page, '.ptasks .irow-time')));
  check('tasks card: open ones have an unticked box; the paused one has none and a Paused badge',
    (await rowFor(page, 'backsplash').locator('.irow-check').getAttribute('aria-checked')) === 'false'
    && (await rowFor(page, 'Photograph').locator('.irow-check').count()) === 0 && /Paused/.test(await rowFor(page, 'Photograph').innerText()));
  check('tasks card: who dots (in charge ringed), the contact\'s phone is tap-to-call, repeating marked',
    (await rowFor(page, 'electrician').locator('.pdot.ring').getAttribute('title')) === 'Sam Example, in charge'
    && (await rowFor(page, 'electrician').locator('.irow-call').getAttribute('href')) === 'tel:2015550100'
    && (await rowFor(page, 'Water').locator('.irow-rep').count()) === 1);
  check('tasks card: every task has "Put on the schedule"; a link to the project on the Tasks page',
    (await page.locator('.ptasks .ptask-sched').count()) === 5 && (await page.getAttribute('.ptasks-tools a', 'href')) === '#/tasks/project/p-kitchen');
  check('targets: the card\'s buttons, boxes, rows and calls, and the page actions are at least 44px',
    !(await small(page, '.ptasks button, .ptasks a, .proj2 .page-actions .btn, .proj2 .back, .proj2 .segmented button, .proj2 .chip')).length,
    JSON.stringify(await small(page, '.ptasks button, .ptasks a, .proj2 .page-actions .btn, .proj2 .back, .proj2 .segmented button, .proj2 .chip')));
  await page.screenshot({ path: SHOTS + 'projects-v2-page.png', fullPage: true });

  // =====================================================================
  // 3. Tick off, with Undo; a repeating one moves on; a race; a failure
  // =====================================================================
  const tile = db.K.tile;
  await rowFor(page, 'backsplash').locator('.irow-check').click();
  await page.waitForTimeout(600);
  const done1 = calls(db, 'complete_task').slice(-1)[0];
  check('tick: complete_task with the task and the due date it showed', done1 && same(done1.body, { p_id: tile.id, p_occurrence: '2026-10-28' }), JSON.stringify(done1 && done1.body));
  check('tick: the one-off leaves the card; "Done" toast with Undo', !(await titles(page)).includes('Order the backsplash tile')
    && /^Done: Order the backsplash tile/.test(await lastToast(page)) && (await page.locator('.toasts .toast-btn').count()) === 1, await lastToast(page));
  await page.locator('.toasts .toast-btn').last().click();
  await page.waitForTimeout(600);
  const undo = calls(db, 'undo_task').slice(-1)[0];
  check('undo: undo_task with the log id complete_task returned; the task is back',
    undo && db.task_log.every((l) => l.id !== undo.body.p_log_id) && (await titles(page)).includes('Order the backsplash tile') && tile.done_at === null && /Not done: Order the backsplash tile/.test(await lastToast(page)), await lastToast(page));
  await rowFor(page, 'Water').locator('.irow-check').click();
  await page.waitForTimeout(600);
  const done2 = calls(db, 'complete_task').slice(-1)[0];
  check('tick: a repeating one is sent with its occurrence, moves to its next date (Sun Nov 1) and says so',
    same(done2.body, { p_id: db.K.water.id, p_occurrence: TODAY }) && (await rowFor(page, 'Water').locator('.irow-time').innerText()) === 'Sun Nov 1\n9:00am'
    && /Done: Water the new plants · next Nov 1/.test(await lastToast(page)), `${await rowFor(page, 'Water').locator('.irow-time').innerText()} / ${await lastToast(page)}`);
  db.raceDone = true;
  expect.failures = true;
  await rowFor(page, 'backsplash').locator('.irow-check').click();
  await page.waitForTimeout(600);
  check('tick: someone else got there first ("already done"): told so, the card reloads', /Someone already ticked that off/.test((await toasts(page)).join(' | ')), (await toasts(page)).join(' | '));
  db.completeFail = true;
  await rowFor(page, 'backsplash').locator('.irow-check').click();
  await page.waitForTimeout(600);
  check('tick: a database error unticks the box and says what went wrong', (await rowFor(page, 'backsplash').locator('.irow-check').getAttribute('aria-checked')) === 'false'
    && (await page.locator('.toasts .toast-error', { hasText: 'Database restarting' }).count()) === 1);
  db.completeFail = false;
  expect.failures = false;

  // =====================================================================
  // 4. + Task (the Tasks page's form, on this project) and editing one
  // =====================================================================
  await page.click('.ptasks [data-act="ptask-add"]');
  await page.waitForTimeout(500);
  check('+ Task: the Tasks page\'s form, with this project chosen', await formOpen(page) && (await tc(page, '#formDialog h3')) === 'New task'
    && (await page.$eval('#formDialog select[name="project_id"]', (s) => s.value)) === 'p-kitchen');
  await page.fill('#formDialog input[name="title"]', '<b>Ask</b> about "grout" & sealer');
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(700);
  const added = db.tasks.find((t) => t.title === '<b>Ask</b> about "grout" & sealer');
  check('+ Task: saved on this project; the form closes and the card shows it (as text, not markup)', added && added.project_id === 'p-kitchen' && !(await formOpen(page))
    && (await titles(page)).includes('<b>Ask</b> about "grout" & sealer') && (await page.locator('.ptasks .irow-title b').count()) === 0, JSON.stringify(added && added.project_id));
  await rowFor(page, 'cabinet hardware').locator('.irow-main').click();
  await page.waitForTimeout(500);
  check('tap a task: its edit form opens', await formOpen(page) && (await tc(page, '#formDialog h3')) === 'Edit task' && (await page.inputValue('#formDialog input[name="title"]')) === 'Pick cabinet hardware');
  await page.click('#formDialog [data-close]');

  // =====================================================================
  // 5. Put on the schedule
  // =====================================================================
  const permit = db.K.permit;
  await rowFor(page, 'electrician').locator('.ptask-sched').click();
  await page.waitForTimeout(300);
  const intro = await text(page, '#formDialog .meta');
  check('put on schedule: the form has the name, the trade linked to the task\'s contact (Electrician), 1 day, start blank for a late task',
    (await tc(page, '#formDialog h3')) === 'Put on the schedule' && (await page.inputValue('#formDialog input[name="name"]')) === 'Call the electrician about permits'
    && (await page.$eval('#formDialog select[name="trade"]', (s) => s.value)) === 'electrician' && (await page.inputValue('#formDialog input[name="days"]')) === '1'
    && (await page.inputValue('#formDialog input[name="start"]')) === '' && /end of "Closeout"/.test(intro) && /comes off the task list/.test(intro), intro);
  const tradeOptions = await page.$$eval('#formDialog select[name="trade"] option', (os) => os.map((o) => o.textContent));
  check('put on schedule: the trade choices are the project\'s trades, then "New trade…"', tradeOptions.length === Object.keys(kitchen(db).schedule.trades).length + 1 && tradeOptions.slice(-1)[0] === 'New trade…', tradeOptions.join(','));
  const before = schedWrites(db).length;
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(800);
  const w1 = schedWrites(db).slice(-1)[0];
  const lastPhase = (s) => s.phases[s.phases.length - 1];
  const put1 = w1 && lastPhase(w1.body.schedule).tasks.slice(-1)[0];
  check('put on schedule: one schedule save, with the new task at the end of the last phase (trade, 1 day)',
    schedWrites(db).length === before + 1 && same(put1, { id: 'call-the-electrician-about-per', name: 'Call the electrician about permits', trade: 'electrician', days: 1 }), JSON.stringify(put1));
  // The id is the name's slug, which the schedule keeps to 30 characters.
  const td = w1 && (w1.body.task_dates || []).find((x) => x.id === 'call-the-electrician-about-per');
  check('put on schedule: the save carries fresh task_dates (with the new task) and task_dates_at, against the version on screen',
    td && td.start && td.days === 1 && td.trade_name === 'Electrician' && !isNaN(Date.parse(w1.body.task_dates_at)) && /updated_at=eq\.2026-10-25T08:00:00/.test(w1.url)
    && Array.isArray(kitchen(db).task_dates), JSON.stringify(td));
  check('put on schedule: then the task row is deleted, and the card no longer lists it',
    db.taskDeletes.some((u) => u.includes(`id=eq.${permit.id}`)) && !db.tasks.some((t) => t.id === permit.id) && !(await titles(page)).includes('Call the electrician about permits'));
  check('put on schedule: the schedule shows it; the toast says so, with its dates', (await text(page, '#gv')).includes('Call the electrician about permits')
    && /^On the schedule: Call the electrician about permits · Mon, Nov 2$/.test(await lastToast(page)), await lastToast(page));

  // A new trade, 2 days, a start date, and the task's notes kept as family-only notes
  await rowFor(page, 'cabinet hardware').locator('.ptask-sched').click();
  await page.waitForTimeout(300);
  check('put on schedule: no linked contact → the first trade; "New trade" asks for a name only when picked',
    (await page.$eval('#formDialog select[name="trade"]', (s) => s.value)) === Object.keys(kitchen(db).schedule.trades)[0] && !(await page.isVisible('#formDialog input[name="newTrade"]')));
  await page.selectOption('#formDialog select[name="trade"]', '__new');
  await page.fill('#formDialog input[name="newTrade"]', 'Hardware run');
  await page.fill('#formDialog input[name="days"]', '2');
  await page.fill('#formDialog input[name="start"]', '2026-11-16');
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(800);
  const s2 = kitchen(db).schedule;
  const put2 = allTasks(s2).find((t) => t.id === 'pick-cabinet-hardware');
  check('put on schedule: a new trade (with a colour), 2 working days, the start date, notes kept as private notes',
    put2 && put2.trade === 'hardware-run' && s2.trades['hardware-run'] && s2.trades['hardware-run'].name === 'Hardware run' && /^#[0-9a-f]{6}$/.test(s2.trades['hardware-run'].color)
    && put2.days === 2 && put2.start === '2026-11-16' && put2.private_notes === 'Brushed brass, 96mm centers' && !put2.notes, JSON.stringify(put2));
  check('put on schedule: the second one is off the card too', !(await titles(page)).includes('Pick cabinet hardware'));

  // Someone else saved the project in between: the form says so and the task stays
  db.conflict = true;
  await rowFor(page, 'backsplash').locator('.ptask-sched').click();
  await page.waitForTimeout(300);
  check('put on schedule: a task due later starts on its due date', (await page.inputValue('#formDialog input[name="start"]')) === '2026-10-28');
  const deletesBefore = db.taskDeletes.length;
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(600);
  check('put on schedule: a project changed elsewhere → the form explains, nothing is deleted', await formOpen(page) && /Someone else changed this project/.test(await formError(page))
    && db.taskDeletes.length === deletesBefore && (await titles(page)).includes('Order the backsplash tile'), await formError(page));
  await page.click('#formDialog [data-close]');
  db.conflict = false;

  // The schedule save works but the delete fails: say so, keep the row
  db.deleteFail = true;
  expect.failures = true;
  await rowFor(page, 'backsplash').locator('.ptask-sched').click();
  await page.waitForTimeout(300);
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(800);
  check('put on schedule: if the task can\'t be deleted, the error says it is on the schedule but still on the list',
    !(await formOpen(page)) && (await page.locator('.toasts .toast-error', { hasText: 'is on the schedule, but couldn\'t come off the task list' }).count()) === 1
    && (await titles(page)).includes('Order the backsplash tile') && allTasks(kitchen(db).schedule).some((t) => t.id === 'order-the-backsplash-tile'), (await toasts(page)).join(' | '));
  db.deleteFail = false;
  expect.failures = false;

  // A repeating task: the form warns that the repeats end
  await rowFor(page, 'Water').locator('.ptask-sched').click();
  await page.waitForTimeout(300);
  check('put on schedule: a repeating task warns that its repeats end (and starts on its next due date)', /It repeats: putting it on the schedule ends the repeats/.test(await text(page, '#formDialog .meta'))
    && (await page.inputValue('#formDialog input[name="start"]')) === '2026-11-01');
  await page.click('#formDialog [data-close]');

  // =====================================================================
  // 6. Settings: owner and "Show in Home Hub calendar"
  // =====================================================================
  await page.click('[data-ref="head"] [data-act="settings"]');
  await page.waitForTimeout(300);
  const owners = await page.$$eval('#formDialog select[name="owner_id"] option', (os) => os.map((o) => [o.value, o.textContent]));
  check('settings: Owner lists "No owner: every parent", then the active parents (not kids, helpers or inactive parents)',
    same(owners, [['', 'No owner: every parent'], [ID.alex, 'Alex Example'], [ID.sam, 'Sam Example']]), JSON.stringify(owners));
  check('settings: "Show in Home Hub calendar" is ticked; the help says who gets the lines', await page.isChecked('#formDialog input[name="on_calendar"]')
    && /morning email/.test(await text(page, '#formDialog [data-field="owner_id"] small')));
  check('settings: its checkbox and buttons are at least 44px', !(await small(page, '#formDialog .check, #formDialog .form-actions .btn, #formDialog .d-close')).length, JSON.stringify(await small(page, '#formDialog .check, #formDialog .form-actions .btn, #formDialog .d-close')));
  await page.selectOption('#formDialog select[name="owner_id"]', ID.sam);
  await page.uncheck('#formDialog input[name="on_calendar"]');
  const sBefore = db.projectWrites.length;
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(600);
  const sw = db.projectWrites.slice(sBefore).find((w) => 'owner_id' in w.body);
  check('settings: saves owner_id and on_calendar with the schedule, task_dates and task_dates_at',
    sw && sw.body.owner_id === ID.sam && sw.body.on_calendar === false && sw.body.schedule && Array.isArray(sw.body.task_dates) && !!sw.body.task_dates_at
    && kitchen(db).owner_id === ID.sam && kitchen(db).on_calendar === false && Array.isArray(kitchen(db).task_dates), JSON.stringify(sw && Object.keys(sw.body)));
  check('settings: the heading shows the owner and "Not on the calendar"; "Settings saved"', /Owner: Sam Example/.test(await tc(page, '[data-ref="head"] .meta'))
    && (await texts(page, '[data-ref="head"] .pill')).includes('Not on the calendar') && /Settings saved/.test((await toasts(page)).join(' | ')));
  await page.click('[data-ref="head"] [data-act="settings"]');
  await page.waitForTimeout(300);
  check('settings: opened again, it shows the saved owner and the box unticked', (await page.$eval('#formDialog select[name="owner_id"]', (s) => s.value)) === ID.sam && !(await page.isChecked('#formDialog input[name="on_calendar"]')));
  await page.selectOption('#formDialog select[name="owner_id"]', '');
  await page.check('#formDialog input[name="on_calendar"]');
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(600);
  check('settings: no owner saves null; ticking the box saves true', kitchen(db).owner_id === null && kitchen(db).on_calendar === true && !/Owner/.test(await tc(page, '[data-ref="head"] .meta')));
  db.fkFail = true;
  expect.failures = true;
  await page.click('[data-ref="head"] [data-act="settings"]');
  await page.waitForTimeout(300);
  await page.selectOption('#formDialog select[name="owner_id"]', ID.alex);
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(600);
  check('settings: an owner removed in the meantime is explained in plain words', /That person was removed a moment ago/.test(await formError(page)), await formError(page));
  await page.click('#formDialog [data-close]');
  db.fkFail = false;
  expect.failures = false;

  // =====================================================================
  // 7. Other schedule saves still send task_dates; the trades form (directory link, linkable kinds)
  // =====================================================================
  await page.click('[data-ref="head"] [data-act="add-task"]');
  await page.waitForTimeout(300);
  await page.fill('#formDialog input[name="name"]', 'Touch-up paint');
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(600);
  check('+ Schedule task: the Gantt task form still works and its save carries task_dates', allTasks(kitchen(db).schedule).some((t) => t.name === 'Touch-up paint')
    && Array.isArray(schedWrites(db).slice(-1)[0].body.task_dates) && Array.isArray(kitchen(db).task_dates));
  check('every schedule save from the page sent fresh task_dates and task_dates_at (none left stale)',
    schedWrites(db).length >= 6 && schedWrites(db).every((w) => Array.isArray(w.body.task_dates) && !isNaN(Date.parse(w.body.task_dates_at))), schedWrites(db).length);
  await page.click('[data-ref="head"] [data-act="trades"]');
  await page.waitForTimeout(300);
  const linkable = await page.$$eval('#formDialog .trade-row:first-child select[name="contractor"] option', (os) => os.map((o) => o.textContent));
  check('trades: the directory link goes to #/directory; contractors and services can be linked, accounts can\'t',
    (await page.getAttribute('#formDialog .meta a', 'href')) === '#/directory' && linkable.some((l) => /Pat Lee/.test(l)) && linkable.some((l) => /Maria Gomez/.test(l))
    && linkable.some((l) => /Happy Paws/.test(l)) && !linkable.some((l) => /Acme/.test(l)), linkable.join(' | '));
  await page.screenshot({ path: SHOTS + 'projects-v2-trades.png' });
  await page.click('#formDialog [data-close]');
  // A schedule task's details: 44px actions
  await page.click('.segmented [data-view="list"]');
  await page.waitForTimeout(200);
  await page.locator('#gv .list .item').first().click();
  await page.waitForTimeout(300);
  check('schedule task details: the action buttons and the close button are at least 44px', !(await small(page, '#detail .d-actions .btn, #detail .d-close')).length, JSON.stringify(await small(page, '#detail .d-actions .btn, #detail .d-close')));
  await page.keyboard.press('Escape');
  await page.context().close();

  // =====================================================================
  // 8. The list, stale dates, an empty project, a failed read, an inactive owner
  // =====================================================================
  ({ page, db, expect } = await open({ label: 'list', path: '/#/projects' }));
  check('list: drawn inside .proj2, with every project', (await page.locator('.proj2 .pcard').count()) === 3);
  const sprinklerCard = await text(page, '.pcard[href="#/projects/p-sprinkler"]');
  check('list: cards use the household\'s date (the sprinkler job is 1 behind; by the device\'s January it hasn\'t started)', /1 behind/.test(sprinklerCard), sprinklerCard);
  await page.context().close();

  const staleDb = projDb();
  staleDb.projects.find((p) => p.id === 'p-sprinkler').task_dates = null;
  staleDb.backfillConflict = true;
  ({ page, db } = await open({ label: 'stale', db: staleDb, path: '/#/projects/p-sprinkler' }));
  check('stale dates: the core tried to fill them in; they\'re still null → a quiet note', db.projectWrites.some((w) => /p-sprinkler/.test(w.url) && 'task_dates' in w.body && !('schedule' in w.body))
    && /^Dates are being refreshed/.test(await text(page, '.proj-stale')) && (await page.getAttribute('.proj-stale', 'role')) === 'status', await text(page, '.proj-stale'));
  await page.click('[data-ref="head"] [data-act="settings"]');
  await page.waitForTimeout(300);
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(600);
  check('stale dates: the next schedule save sends them, and the note goes', Array.isArray(db.projects.find((p) => p.id === 'p-sprinkler').task_dates) && !(await page.$('.proj-stale')));
  await page.context().close();

  const brokenDb = projDb();
  Object.assign(brokenDb.projects.find((p) => p.id === 'p-sprinkler'), { task_dates: null });
  brokenDb.projects.find((p) => p.id === 'p-sprinkler').schedule.phases[0].tasks.push({ id: 'blowout', name: 'Twin', days: 1 });
  ({ page } = await open({ label: 'broken', db: brokenDb, path: '/#/projects/p-sprinkler' }));
  check('stale dates: a schedule that can\'t be drawn shows its own error, not the refresh note', !(await page.$('.proj-stale')) && /couldn't be drawn/.test(await text(page, '#gv')));
  await page.context().close();

  const failDb = projDb();
  failDb.readFail = 1;
  // The failed read logs a 500; that one is on purpose.
  ({ page, db } = await open({ label: 'readfail', db: failDb, path: '/#/projects/p-pool', allowConsole: /status of 500/ }));
  check('empty project: the schedule\'s empty state speaks of the schedule', /Nothing on the schedule yet/.test(await text(page, '#gv')) && (await tc(page, '#gv [data-act="add-task"]')) === '+ Add the first schedule task');
  check('tasks card: a failed read says so, with Try again', /Couldn't load this project's tasks/.test(await text(page, '.ptasks')) && (await page.locator('.ptasks [data-act="ptasks-retry"]').count()) === 1, await text(page, '.ptasks'));
  await page.click('.ptasks [data-act="ptasks-retry"]');
  await page.waitForTimeout(500);
  check('tasks card: Try again reads again and shows the project\'s task', same(await titles(page), ['Clean the pool filter']));
  await page.click('[data-ref="head"] [data-act="settings"]');
  await page.waitForTimeout(300);
  const poolOwners = await page.$$eval('#formDialog select[name="owner_id"] option', (os) => os.map((o) => o.textContent));
  check('settings: an inactive owner stays chosen, marked (inactive)', (await page.$eval('#formDialog select[name="owner_id"]', (s) => s.value)) === ID.morgan && poolOwners.includes('Morgan Example (inactive)'), poolOwners.join(','));
  await page.click('#formDialog [data-close]');
  // Done with the pool's only task: the empty card
  await page.locator('.ptasks .irow-check').click();
  await page.waitForTimeout(600);
  check('tasks card: no open tasks → a short note on what the card is for', /No tasks for this project/.test(await text(page, '.ptasks')) && !(await page.$('.ptasks .sec-count')));
  await page.context().close();

  // =====================================================================
  // 9. For Today: projectCard without a model, newProjectForm without the list loaded
  // =====================================================================
  ({ page, db } = await open({ label: 'provides', path: '/' }));
  const card = await page.evaluate(() => {
    const { projectCard } = HomeHub.core.use('projects');
    const div = document.createElement('div');
    div.innerHTML = projectCard({ id: 'p-x', name: 'Fence', status: 'active', summary: null, schedule: { project: { start: '2026-10-19', holidays: [] }, trades: {}, phases: [{ name: 'A', tasks: [{ id: 'a', name: 'Dig posts', days: 1 }] }] } });
    return div.textContent.replace(/\s+/g, ' ').trim();
  });
  check('provides: projectCard(p) alone works out the model by the household\'s date', /1 behind/.test(card), card);
  await page.evaluate(() => HomeHub.core.use('projects').newProjectForm());
  await page.waitForTimeout(500);
  const templates = await page.$$eval('#formDialog select[name="template"] option', (os) => os.map((o) => o.textContent));
  check('provides: newProjectForm reads the projects first ("Start from" lists them); the start is the household\'s next Monday',
    templates.some((t) => /Kitchen Renovation/.test(t)) && (await page.inputValue('#formDialog input[name="start"]')) === '2026-10-26', `${templates.join(',')} / ${await page.inputValue('#formDialog input[name="start"]')}`);
  await page.fill('#formDialog input[name="name"]', 'Garden shed');
  await page.click('#formDialog [type="submit"]');
  await page.waitForTimeout(800);
  const shed = db.projects.find((p) => p.name === 'Garden shed');
  check('provides: the new project is created (with task_dates) and opened', shed && Array.isArray(shed.task_dates) && !!shed.task_dates_at
    && (await page.evaluate(() => location.hash)) === `#/projects/${shed.id}` && (await text(page, '[data-ref="head"] h1')) === 'Garden shed');
  await page.context().close();

  // =====================================================================
  // 10. Phones (390px), light and dark
  // =====================================================================
  for (const scheme of ['light', 'dark']) {
    ({ page, db } = await open({ label: `phone-${scheme}`, ctx: Object.assign({ colorScheme: scheme }, phone) }));
    check(`phone ${scheme}: the project page has no sideways scroll`, await noSideScroll(page));
    const bg = await page.$eval('.ptasks', (e) => getComputedStyle(e).backgroundColor);
    check(`phone ${scheme}: the Tasks card uses the ${scheme} colours`, scheme === 'dark' ? bg === 'rgb(27, 25, 23)' : bg === 'rgb(255, 255, 255)', bg);
    const geo = await rowFor(page, 'backsplash').evaluate((w) => {
      const r = (s) => w.querySelector(s).getBoundingClientRect();
      return { title: Math.round(r('.irow-title').left), btn: Math.round(r('.ptask-sched').left), btnTop: Math.round(r('.ptask-sched').top), rowBottom: Math.round(r('.irow').bottom) };
    });
    check(`phone ${scheme}: "Put on the schedule" sits under the title, lined up with it`, Math.abs(geo.title - geo.btn) <= 6 && geo.btnTop >= geo.rowBottom - 6, JSON.stringify(geo));
    check(`phone ${scheme}: every target on the page is at least 44px`, !(await small(page, '.ptasks button, .ptasks a, .proj2 .page-actions .btn, .proj2 .back, .proj2 .segmented button, .proj2 .chip')).length,
      JSON.stringify(await small(page, '.ptasks button, .ptasks a, .proj2 .page-actions .btn, .proj2 .back, .proj2 .segmented button, .proj2 .chip')));
    await page.screenshot({ path: SHOTS + `projects-v2-phone-${scheme}.png`, fullPage: true });
    await rowFor(page, 'electrician').locator('.ptask-sched').click();
    await page.waitForTimeout(300);
    check(`phone ${scheme}: the "Put on the schedule" form fits`, await noSideScroll(page) && await page.$eval('#formDialog', (d) => d.scrollWidth <= d.clientWidth));
    await page.screenshot({ path: SHOTS + `projects-v2-put-phone-${scheme}.png` });
    await page.click('#formDialog [data-close]');
    await go(page, '#/projects');
    check(`phone ${scheme}: the list fits; Projects is under More (More is highlighted)`, await noSideScroll(page) && await page.$eval('.bb-more', (b) => b.classList.contains('is-current')));
    await page.screenshot({ path: SHOTS + `projects-v2-list-phone-${scheme}.png`, fullPage: true });
    await page.context().close();
  }

  // =====================================================================
  // 11. v1 mode: exactly the v1 Projects page
  // =====================================================================
  ({ page, log } = await open({ label: 'v1', v1: true, db: makeDb(), path: '/#/projects/p-kitchen' }));
  const v1 = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => a.textContent),
    proj2: !!document.querySelector('.proj2, .ptasks, .proj-stale'),
    // index.html links projects.css in both modes, like the other page stylesheets; in v1 none of its
    // rules may match anything on the page (every one hangs off a class only the v2 pages use).
    css: (() => {
      const l = document.querySelector('link[href*="assets/css/projects.css"]');
      if (!l || !l.sheet) return l ? 'not loaded' : false;
      // Style rules, and the style rules inside @media blocks (a style rule has a cssRules list too, for nesting).
      const rules = [...l.sheet.cssRules].flatMap((r) => (r.selectorText ? [r] : [...(r.cssRules || [])])).filter((r) => r.selectorText);
      const hits = rules.filter((r) => { try { return !!document.querySelector(r.selectorText.replace(/::?(before|after|placeholder)\b/g, '')); } catch (e) { return true; } });
      return hits.length ? hits.map((r) => r.selectorText).join(' | ') : rules.length ? false : 'no rules';
    })(),
    head: document.querySelector('[data-ref="head"] [data-act="add-task"]').textContent,
    version: HomeHub.core.schemaVersion,
  }));
  check('v1: the v1 tabs (Projects second), the v1 page: no Tasks card, no v2 classes, projects.css styles nothing, "+ Task"', v1.version === 1 && same(v1.tabs, ['Home', 'Projects', 'Contractors', 'Family'])
    && !v1.proj2 && v1.head === '+ Task' && !v1.css, JSON.stringify(v1));
  check('v1: no task reads, no v2 calls', !log.some((l) => /\/rest\/v1\/(tasks|task_log|people|household)|rpc\/(clock|complete_task)/.test(l)), log.filter((l) => /tasks|people|clock/.test(l)).join(' | '));
  await page.click('[data-ref="head"] [data-act="settings"]');
  await page.waitForTimeout(300);
  check('v1: the settings form has no Owner or calendar box', !(await page.$('#formDialog [name="owner_id"], #formDialog [name="on_calendar"]')) && !(await page.$('#formDialog .proj-form')));
  await page.click('#formDialog [data-close]');
  await page.click('[data-ref="head"] [data-act="trades"]');
  await page.waitForTimeout(300);
  check('v1: the trades form links #/contractors', (await page.getAttribute('#formDialog .meta a', 'href')) === '#/contractors');
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
