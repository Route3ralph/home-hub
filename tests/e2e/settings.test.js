// Browser tests for the v2 Settings page (assets/modules/settings.js): the household (time zone from
// the migration's list with friendly names, the usual morning-email time, who new pet and house tasks
// go to), days off (single days and ranges, sorted and grouped, remove, past ones tucked away), the
// morning email's status from hub-jobs ("Last run …, N sent", or "Not set up yet" on any failure),
// "Preview my morning email" (subject and text), the Home Screen steps, Sign out, members seeing it
// read-only, phones (390px), dark mode and v1 mode. Google Calendar & Hearth: on schema 2 it waits for the
// database update; on schema 3 (migration 0003) the whole card (docs/v1.1-google-calendar.md §6.5): the
// status line, Sync now, each column's calendar with Set (the Calendar ID or its embed address), Test,
// the preview with Make private and Start copying, the name question and Disconnect; Calendars to read
// with Show to kids; problems, put back, stale projects, Not on Google and the inactive-person note; a
// member's read-only view; hub-jobs from before v1.1 ("Waiting for the hub-jobs update").
//
// The database is mock.js plus fakes that follow supabase/migrations/0002_home_hub_v2.sql: household
// changes only for admins (anyone else's update changes no rows, as RLS does), clock →
// { local_date, local_time, tz }, whoami → the members row plus person. hub-jobs answers with the
// shapes supabase/functions/hub-jobs/handler.ts returns for status and preview. The other v2 pages are
// small stubs, so this file tests Settings alone. The browser runs in Pacific/Honolulu with its clock
// on another day; the household is in America/New_York.
// Run alone with: node tests/e2e/settings.test.js
const { chromium } = require('playwright');
const { createHash } = require('crypto');
const { makeDb, install, signIn, withCalendars, calendarRow, linkRow, calendarRpc, withFood } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const JSONH = { ...CORS, 'content-type': 'application/json' };

// ---- Fixtures (fictional people, 555-01xx numbers, example.com)
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-10-25';
const ID = {
  alex: '0f1e0000-0000-4000-8000-000000000001', sam: '0f1e0000-0000-4000-8000-000000000002',
  jordan: '0f1e0000-0000-4000-8000-000000000003', morgan: '0f1e0000-0000-4000-8000-000000000004',
};
const person = (id, name, role, color, sort, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color, language: 'en',
  day_token: createHash('md5').update(id).digest('hex'), digest_enabled: false, digest_time: null,
  digest_day: 'today', digest_scope: 'mine', sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);

function settingsDb() {
  const db = makeDb(); // members: Alex (admin), Sam (member)
  db.people = [
    person(ID.alex, 'Alex Example', 'parent', '#2563eb', 0, { email: 'alex@example.com', email_verified_at: T, digest_enabled: true }),
    person(ID.sam, 'Sam Example', 'adult', '#db2777', 1, { email: 'sam@example.com' }),
    person(ID.jordan, 'Jordan Example', 'kid', '#16a34a', 2),
    person(ID.morgan, 'Morgan Example', 'adult', '#0891b2', 3, { active: false }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: ['2026-11-27', '2026-10-12', '2026-12-24', '2026-11-26'],
    pets_owner_id: ID.sam, house_owner_id: null, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '09:00:00', tz: 'America/New_York' };
  db.confirms = [];
  db.hhWrites = [];
  db.fnCalls = [];
  db.fn = { status: 'ok', preview: 'ok' };
  // Repeating events: the school run (weekdays) and swim (Thursdays) don't skip days off yet; piano
  // (Tuesdays) never falls on one; Saturday soccer already skips them; a club that ended in September.
  const ev = (id, title, weekdays, extra) => Object.assign({ id, title, start_date: '2026-09-01', start_time: '07:20:00', repeat: 'weekly', repeat_every: 1,
    repeat_weekdays: weekdays, repeat_until: null, skip_days_off: false, responsible_id: null, participant_ids: [] }, extra);
  db.events = [
    ev('ev-bus', 'Walk Taylor to the bus', [1, 2, 3, 4, 5]),
    ev('ev-swim', 'Swim club', [4], { repeat_every: 2, start_date: '2026-11-12', repeat_until: '2026-12-01' }),
    ev('ev-piano', 'Piano', [2]),
    ev('ev-soccer', 'Soccer', [6], { skip_days_off: true }),
    ev('ev-chess', 'Chess club', [4], { repeat_until: '2026-09-30' }),
    { id: 'ev-dentist', title: 'Dentist', start_date: '2026-11-26', start_time: '09:00:00', repeat: 'none', repeat_every: 1, repeat_weekdays: [], repeat_until: null, skip_days_off: false },
  ];
  return db;
}

// hub-jobs replies, in handler.ts's shapes.
const STATUS_OK = {
  today: TODAY,
  last_run: { action: 'digest', started_at: '2026-10-25T10:30:04.512+00:00', finished_at: '2026-10-25T10:30:09.1+00:00', ok: true, due: 5, sent: 4, skipped: 1, failed: 0, message: 'Emails went out.' },
  last_sent: { started_at: '2026-10-25T10:30:04.512+00:00', sent: 4 },
  runs: [],
  today_counts: { digest: { sent: 4, failed: 0, skipped: 1, sending: 0 }, confirm: { sent: 1, failed: 0, skipped: 0, sending: 0 } },
  messages: [],
};
const STATUS_WARN = {
  today: TODAY,
  last_run: { action: 'digest', started_at: '2026-10-25T10:45:00+00:00', finished_at: '2026-10-25T10:45:02+00:00', ok: false, due: 1, sent: 0, skipped: 0, failed: 1, message: 'Some emails failed. Resend\'s reason is in notification_log.' },
  last_sent: { started_at: '2026-10-24T10:30:00+00:00', sent: 3 },
  runs: [],
  today_counts: { digest: { sent: 0, failed: 1, skipped: 0, sending: 0 }, confirm: { sent: 0, failed: 0, skipped: 0, sending: 0 } },
  messages: ['The last run was more than an hour ago. Check the hub-digest cron job.', 'Last run: Some emails failed. Resend\'s reason is in notification_log.', '<b>1 email failed today.</b>'],
};
const STATUS_NEVER = { today: TODAY, last_run: null, last_sent: null, runs: [], today_counts: { digest: { sent: 0, failed: 0, skipped: 0, sending: 0 }, confirm: { sent: 0, failed: 0, skipped: 0, sending: 0 } },
  messages: ['The morning email has never run. Schedule it with supabase/cron.sql.'] };
const PREVIEW_TEXT = 'Good morning, Alex\n\nTODAY\n8:00am  Drop off dogs\n3:00pm  Pick up Jordan <b>(not bold)</b>\n\nOpen your day: https://hub.example/day.html?t=…';
const previewOf = (o) => ({ date: TODAY, emails: [Object.assign({ person_id: ID.alex, name: 'Alex Example', role: 'parent', email: 'alex@example.com', local_date: TODAY,
  would_send: true, reason: null, subject: 'Sun Oct 25: 8:00am Drop off dogs · 3:00pm Pick up Jordan', html: '<p>Good morning</p>', text: PREVIEW_TEXT }, o)] });

const v2Rpc = {
  hub_schema_version: () => 2,
  clock: (db) => Object.assign({}, db.clock),
  mark_signed_in: () => null,
};

// ---- Schema 3: Google Calendar (fictional calendar IDs and service account; mock.js has the tables,
// google_items / calendar_preview and hub-jobs' calendar and calendar_test answers).
const v3Rpc = Object.assign({ hub_schema_version: () => 3 }, calendarRpc);
const ACCOUNT = 'home-hub-sync@home-hub-example.iam.gserviceaccount.com';
const GID = (name) => `${name}@group.calendar.google.com`;
// 'HH:MM' on a household day (New York is on daylight time until Nov 1) as an instant.
const at = (hm, day = TODAY) => new Date(`${day}T${hm}:00-04:00`).toISOString();
const NAME_RULE = "This calendar isn't named 'Hub …'. The hub writes only to calendars whose name starts with Hub. If it is the right one, rename it in Google.";
function googleDb(sync) {
  const db = withCalendars(settingsDb(), sync);
  db.tasks = [{ id: 'tk-pill', title: 'Heartworm pill', private: false }];
  // What calendar_desired would copy to Jordan's calendar from yesterday to 60 days ahead (calendar_preview).
  db.previewRows = { [GID('jordan0123')]: [
    { day: '2026-10-25', title: '☐ 2 late: Take out recycling, Private item', private: false, item_kind: 'late', item_id: null },
    { day: '2026-10-27', title: 'Piano (with Jordan)', private: false, item_kind: 'event', item_id: 'ev-piano', place: 'Rivera Music, 12 Elm St', details: 'Rivera Music 555-0150' },
    { day: '2026-10-27', title: '☐ Heartworm pill', private: false, item_kind: 'task', item_id: 'tk-pill' },
    { day: '2026-10-29', title: 'Dentist', private: true, item_kind: 'event', item_id: 'ev-dentist' },
    { day: '2026-11-02', title: 'Kitchen: Paint starts', private: false, item_kind: 'project', item_id: 'p-kitchen', details: 'Pat Lee (201) 555-0100' },
    { day: '2026-12-18', title: 'Trip', private: false, item_kind: 'event', item_id: 'ev-trip' },
  ] };
  return db;
}
// A household that has been set up for a while: signed in, copying, some calendars in trouble.
function richDb() {
  const db = googleDb({ auth: 'service_account', account: ACCOUNT, key_id: '0123456789abcdefa1b2c3', last_run_at: at('08:57'), last_ok_at: at('08:57'),
    last_result: { read: 3, stored: 12, inserted: 60, pending: 214, hiding: 3, stop: null }, window_from: '2026-10-24', window_to: '2026-12-24' });
  const C = {
    alex: calendarRow({ google_id: GID('alex0456'), kind: 'person', person_id: ID.alex, label: 'Alex', status: 'ok', google_name: 'Hub – Alex', access_role: 'writer' }),
    sam: calendarRow({ google_id: GID('sam0789'), kind: 'person', person_id: ID.sam, label: 'Sam' }),
    jordan: calendarRow({ google_id: GID('jordan0123'), kind: 'person', person_id: ID.jordan, label: 'Jordan', status: 'ok', google_name: 'Hub – Jordan', access_role: 'writer',
      copy_approved_at: at('08:00', '2026-10-20') }),
    family: calendarRow({ google_id: GID('family0654'), kind: 'family', label: 'Family', status: 'no_access', google_name: 'Hub – Family', access_role: 'reader',
      status_detail: `Share it with ${ACCOUNT} and choose Make changes and see event details.` }),
    morgan: calendarRow({ google_id: GID('morgan0321'), kind: 'person', person_id: ID.morgan, label: 'Morgan', status: 'ok', google_name: 'Hub – Morgan', access_role: 'writer',
      copy_approved_at: at('08:00', '2026-10-20') }),
    pets: calendarRow({ google_id: GID('pets0987'), kind: 'pets', label: 'Dogs', status: 'error', google_name: 'Dog walks', access_role: 'writer', status_detail: NAME_RULE }),
    main: calendarRow({ google_id: 'family@example.com', kind: 'family', label: 'Family account', writes: false, status: 'ok', google_name: 'family@example.com', access_role: 'reader' }),
    school: calendarRow({ google_id: GID('school0111'), kind: 'person', person_id: ID.jordan, label: 'School', writes: false, status: 'ok', google_name: 'Maple School', access_role: 'reader' }),
  };
  db.calendars.push(...Object.values(C));
  const J = { google_calendar: C.jordan.google_id, calendar_id: C.jordan.id };
  db.calendar_links.push(
    linkRow(Object.assign({ title: 'Piano', day: '2026-11-03', end_day: '2026-11-03', status: 'error', error: 'Google said 400 badRequest: Bad Request', next_try_at: at('09:40'), failing_since: at('08:40') }, J)),
    linkRow({ google_calendar: GID('gone0000'), calendar_id: null, title: 'Soccer', day: '2026-10-26', end_day: '2026-10-26', status: 'error',
      error: `Home Hub can't change this calendar. In Google Calendar, share it with ${ACCOUNT} and choose Make changes and see event details.`,
      next_try_at: at('08:00', '2026-10-26'), failing_since: at('07:00') }),
    linkRow(Object.assign({ title: 'Dentist', day: '2026-11-04', end_day: '2026-11-04', status: 'error', error: 'Google keeps changing this event', next_try_at: at('06:00', '2026-10-27'),
      failing_since: at('06:00'), repairs: 4, repair_kind: 'edited' }, J)),
    linkRow(Object.assign({ title: 'Piano', day: '2026-11-05', end_day: '2026-11-05', synced_at: at('08:30'), repaired_at: at('08:12'), repair_kind: 'deleted', repairs: 1 }, J)),
    linkRow(Object.assign({ title: 'Swim', day: '2026-10-28', end_day: '2026-10-28', synced_at: at('08:30'), repaired_at: at('07:05'), repair_kind: 'edited', repairs: 1 }, J)),
    linkRow(Object.assign({ title: 'Piano', day: '2026-10-27', end_day: '2026-10-27', synced_at: at('08:30') }, J)),
    linkRow(Object.assign({ title: 'Trip', day: '2026-10-22', end_day: '2026-10-30', synced_at: at('08:30') }, J)),
    linkRow(Object.assign({ title: 'Old event', day: '2026-10-01', end_day: '2026-10-01', synced_at: at('08:30', '2026-10-01') }, J)),
    linkRow(Object.assign({ title: 'New event', day: '2026-11-01', end_day: '2026-11-01', status: 'pending', synced_at: null }, J)),
  );
  // The kitchen is on the calendar with stale dates; the pool's are fine; the sprinkler job is only an idea.
  db.projects.forEach((p) => Object.assign(p, { on_calendar: true, task_dates: p.id === 'p-pool' ? [] : null }));
  db.cal = C;
  return db;
}

// ---- Stub v2 pages (the other builders' pages): same register() contract as the real ones
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true } },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true } },
  directory: { nav: { label: 'Directory', order: 50 } },
};
const stubModule = (name, s) => `;(function () {
  HomeHub.register({
    name: ${JSON.stringify(name)}, schema: { min: 2, max: 99 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return (${!!s.root} && !parts.length) || parts[0] === ${JSON.stringify(name)} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1>'; },
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
    const db = opts.db || settingsDb();
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 }, timezoneId: 'Pacific/Honolulu' }, opts.ctx));
    await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-01-15T05:00:00Z'));
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (opts.v1 && /status of 404/.test(m.text()) && /hub_schema_version$/.test(m.location().url || '')) return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => {
      db.confirms.push([d.type(), d.message()]);
      return db.confirm === false ? d.dismiss() : d.accept();
    });
    if (opts.clipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await install(page, db, log, { rpc: opts.v1 ? {} : Object.assign({}, v2Rpc, opts.rpc) });
    if (!opts.v1) {
      // whoami in v2 also says which person row is the caller's.
      await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/rpc/whoami', (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const m = db.members.find((x) => x.email === emailOf(req));
        const p = m && db.people.find((x) => x.email === m.email);
        const out = m ? Object.assign({}, m, { person: p ? { id: p.id, name: p.name, role: p.role, language: p.language, color: p.color } : null }) : null;
        return route.fulfill({ status: 200, headers: JSONH, body: JSON.stringify(out) });
      });
      // household: admins change it ("Admins change the household"); anyone else's update changes nothing.
      await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/household', (route) => {
        const req = route.request();
        if (req.method() !== 'PATCH') return route.fallback();
        const url = new URL(req.url());
        const email = emailOf(req);
        db.hhWrites.push({ url: decodeURIComponent(url.search), email, body: JSON.parse(req.postData() || 'null') });
        if (db.hhFail) return route.fulfill({ status: 500, headers: JSONH, body: JSON.stringify({ code: 'XX000', message: 'Database restarting' }) });
        if ((db.members.find((m) => m.email === email) || {}).role !== 'admin') return route.fulfill({ status: 200, headers: JSONH, body: '[]' });
        return route.fallback();
      });
      // Writes to calendars (Set, Start copying, Show to kids, Disconnect) and tasks (Make private).
      await page.route((url) => url.host === 'test.supabase.co' && /^\/rest\/v1\/(calendars|tasks)$/.test(url.pathname), (route) => {
        const req = route.request();
        if (['POST', 'PATCH', 'DELETE'].includes(req.method())) {
          (db.calWrites = db.calWrites || []).push({ table: new URL(req.url()).pathname.slice(9), method: req.method(), url: decodeURIComponent(new URL(req.url()).search), body: JSON.parse(req.postData() || 'null') });
        }
        return route.fallback();
      });
      await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/events', (route) => {
        const req = route.request();
        if (req.method() === 'PATCH') (db.writesEvents = db.writesEvents || []).push({ url: decodeURIComponent(req.url()), body: JSON.parse(req.postData() || 'null') });
        return route.fallback();
      });
      // hub-jobs: status and preview, or a failure of the kind a test asks for.
      await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/functions/v1/hub-jobs', (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const body = JSON.parse(req.postData() || '{}');
        db.fnCalls.push({ body, email: emailOf(req), auth: !!req.headers()['authorization'] });
        // Google Calendar's actions: mock.js answers them (calendarJob), from the schema-3 tables.
        if (body.action === 'calendar' || body.action === 'calendar_test') return route.fallback();
        const mode = db.fn[body.action];
        if (mode === 'offline') return route.abort('internetdisconnected');
        if (mode === '404') return route.fulfill({ status: 404, headers: JSONH, body: JSON.stringify({ code: 'NOT_FOUND', message: 'Requested function was not found' }) });
        if (mode === '404-person') return route.fulfill({ status: 404, headers: JSONH, body: JSON.stringify({ error: 'No active person with that id.' }) });
        if (mode === '503') return route.fulfill({ status: 503, headers: JSONH, body: JSON.stringify({ error: 'SITE_URL is not set in the function\'s secrets, so the email links can\'t be made.' }) });
        if (mode === 'text') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/plain' }, body: 'ok' });
        if (body.action === 'status') return route.fulfill({ status: 200, headers: JSONH, body: JSON.stringify(db.statusBody || STATUS_OK) });
        if (body.action === 'preview') return route.fulfill({ status: 200, headers: JSONH, body: JSON.stringify(db.previewBody || previewOf({})) });
        return route.fulfill({ status: 400, headers: JSONH, body: JSON.stringify({ error: 'Unknown action. Use digest, preview or status.' }) });
      });
    }
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule(name, s) }));
    }
    await page.goto(BASE + (opts.path || '/#/settings'));
    await page.waitForTimeout(opts.wait || 800);
    return { page, db, log, context };
  }

  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(600); };
  const lastToast = async (page) => (await texts(page, '.toasts .toast')).slice(-1)[0] || '';
  const errorOf = (page, sel) => page.$eval(sel, (e) => (e.hidden ? '' : e.textContent)).catch(() => '');
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const daysOff = (page) => texts(page, '[data-ref="daysoff"] > .set-dayoffs .set-dayoff-label');
  const addDays = async (page, from, to) => {
    await page.fill('[data-ref="dayoffForm"] input[name="from"]', from);
    await page.fill('[data-ref="dayoffForm"] input[name="to"]', to || '');
    await page.click('[data-ref="dayoffForm"] [type="submit"]');
    await page.waitForTimeout(500);
  };
  const status = async (page) => (await texts(page, '[data-ref="status"] > p')).join(' | ');

  // =====================================================================
  // 1. Household (desktop, Alex: an admin)
  // =====================================================================
  // This part makes the database and hub-jobs fail on purpose (500s, 503s, 404s); Chrome logs each one.
  let { page, db, log } = await open({ label: 'desktop', allowConsole: /status of (404|500|503)|ERR_INTERNET_DISCONNECTED/ });
  const reg = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]),
    bar: [...document.querySelectorAll('.bottombar a')].map((a) => a.textContent.trim()),
  }));
  check('register: a Settings tab at "#/settings", current, last', same(reg.tabs[reg.tabs.length - 1], ['Settings', '#/settings', 'page']), JSON.stringify(reg.tabs));
  check('register: Settings is not in the phone bottom bar (it goes in More)', !reg.bar.includes('Settings'), reg.bar.join(','));
  check('head: Settings, for the whole household', (await tc(page, '.set-head h1')) === 'Settings' && (await tc(page, '.set-head .meta')) === 'For the whole household.');
  check('the page read the household afresh (v2.refresh)', log.filter((l) => l.startsWith('GET /rest/v1/household')).length >= 2);
  const zones = await page.$$eval('select[name="tz"] option', (os) => os.map((o) => [o.value, o.textContent, o.selected]));
  check('time zone: the migration\'s seven US zones with friendly names; the household\'s chosen', same(zones, [
    ['America/New_York', 'Eastern time (New York)', true], ['America/Chicago', 'Central time (Chicago)', false], ['America/Denver', 'Mountain time (Denver)', false],
    ['America/Phoenix', 'Arizona (Phoenix, no daylight saving)', false], ['America/Los_Angeles', 'Pacific time (Los Angeles)', false],
    ['America/Anchorage', 'Alaska (Anchorage)', false], ['Pacific/Honolulu', 'Hawaii (Honolulu)', false]]), JSON.stringify(zones));
  check('morning email time: the household\'s, as HH:MM', (await page.inputValue('input[name="digest_time"]')) === '06:30');
  const owners = await page.$$eval('select[name="pets_owner_id"] option', (os) => os.map((o) => [o.value, o.textContent, o.selected]));
  check('owners: Nobody, then the active people; pet tasks → Sam', same(owners, [['', 'Nobody (choose each time)', false], [ID.alex, 'Alex Example', false],
    [ID.sam, 'Sam Example', true], [ID.jordan, 'Jordan Example', false]]) && (await page.inputValue('select[name="house_owner_id"]')) === '', JSON.stringify(owners));

  await page.selectOption('select[name="tz"]', 'America/Chicago');
  await page.fill('input[name="digest_time"]', '07:00');
  await page.selectOption('select[name="house_owner_id"]', ID.alex);
  const hhReads = log.filter((l) => l.startsWith('GET /rest/v1/household')).length;
  await page.click('.set-form [type="submit"]');
  await page.waitForTimeout(600);
  check('save: one update of the household row, guarded by updated_at, with exactly these fields', db.hhWrites.length === 1
    && db.hhWrites[0].url === `?id=eq.true&updated_at=eq.${T}&select=*`
    && same(db.hhWrites[0].body, { tz: 'America/Chicago', digest_time: '07:00', pets_owner_id: ID.sam, house_owner_id: ID.alex }), JSON.stringify(db.hhWrites));
  check('save: says so; the hub reloads the household and uses the new zone', (await lastToast(page)) === 'Settings saved'
    && log.filter((l) => l.startsWith('GET /rest/v1/household')).length > hhReads
    && await page.evaluate(() => HomeHub.core.v2.household.tz === 'America/Chicago' && HomeHub.core.v2.fmt.time('2026-10-25T10:30:00Z') === '5:30am'), await lastToast(page));
  check('save: a new time zone reads the status again, so its times follow', db.fnCalls.filter((c) => c.body.action === 'status').length === 2
    && /^Last run today at 5:30am, 4 sent/.test(await tc(page, '[data-ref="status"]')), await tc(page, '[data-ref="status"]'));
  check('save: the form shows the saved values', (await page.inputValue('select[name="tz"]')) === 'America/Chicago' && (await page.inputValue('input[name="digest_time"]')) === '07:00'
    && (await page.inputValue('select[name="house_owner_id"]')) === ID.alex);
  // Someone else saves in between: nothing is overwritten.
  db.household[0].updated_at = '2026-10-25T14:00:00.000000+00:00';
  await page.fill('input[name="digest_time"]', '06:45');
  await page.click('.set-form [type="submit"]');
  await page.waitForTimeout(500);
  check('save: a change made elsewhere since this page read it is not overwritten; the form says why', db.household[0].digest_time === '07:00'
    && /someone else changed them a moment ago/.test(await errorOf(page, '.set-form .form-error')), await errorOf(page, '.set-form .form-error'));
  await page.fill('input[name="digest_time"]', '');
  await page.click('.set-form [type="submit"]');
  await page.waitForTimeout(300);
  check('save: no time → asks for one, nothing sent', /Pick a time for the morning email/.test(await errorOf(page, '.set-form .form-error')) && db.hhWrites.length === 2);

  // =====================================================================
  // 2. Days off
  // =====================================================================
  await go(page, '#/people');
  await go(page, '#/settings');
  check('days off: coming ones sorted, runs of days grouped; past ones tucked away', same(await daysOff(page), ['Thu Nov 26 – Fri Nov 27 (2 days)', 'Thu Dec 24'])
    && (await tc(page, '.set-past summary')) === '1 past day off' && same(await texts(page, '.set-past .set-dayoff-label'), ['Mon Oct 12']), JSON.stringify(await daysOff(page)));
  // Repeating events that would still happen on those days, each with a one-tap fix.
  const stillOn = () => page.$$eval('[data-ref="stillOn"] li', (lis) => lis.map((li) => [li.querySelector('b').textContent, li.querySelector('small').textContent,
    (li.querySelector('button') || {}).textContent, (li.querySelector('button') || { getAttribute: () => null }).getAttribute('aria-label')]));
  check('days off: lists the repeating events that still happen on them (not ones that skip them, never fall on them, or have ended)', same(await stillOn(page), [
    ['Swim club', 'Thu Nov 26', 'Skip on days off', 'Skip Swim club on days off'],
    ['Walk Taylor to the bus', 'Thu Nov 26, Fri Nov 27, Thu Dec 24', 'Skip on days off', 'Skip Walk Taylor to the bus on days off']])
    && /still happen on days off/.test(await tc(page, '[data-ref="stillOn"] .set-help')), JSON.stringify(await stillOn(page)));
  const evWrites = () => db.writesEvents || [];
  await page.click('[data-ref="stillOn"] [data-skip-off="ev-bus"]');
  await page.waitForTimeout(500);
  check('days off: "Skip on days off" sets the event to skip them, says so, and it leaves the list', db.events.find((e) => e.id === 'ev-bus').skip_days_off === true
    && (await lastToast(page)).startsWith("Walk Taylor to the bus won't happen on days off") && same((await stillOn(page)).map((r) => r[0]), ['Swim club'])
    && evWrites().some((w) => w.url.includes('id=eq.ev-bus') && same(w.body, { skip_days_off: true })), JSON.stringify(evWrites()));
  await page.click('.toast-action button');
  await page.waitForTimeout(500);
  check('days off: Undo puts it back on days off', db.events.find((e) => e.id === 'ev-bus').skip_days_off === false && (await stillOn(page)).length === 2, JSON.stringify(await stillOn(page)));
  const writes0 = db.hhWrites.length;
  await addDays(page, '2026-11-11');
  check('days off: one day → the sorted list is saved; says so; the form clears', same(db.hhWrites.slice(-1)[0].body, { days_off: ['2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-24'] })
    && (await lastToast(page)) === 'Wed Nov 11 is now a day off' && same(await daysOff(page), ['Wed Nov 11', 'Thu Nov 26 – Fri Nov 27 (2 days)', 'Thu Dec 24'])
    && (await page.inputValue('[data-ref="dayoffForm"] input[name="from"]')) === '', JSON.stringify(db.hhWrites.slice(-1)[0]));
  await addDays(page, '2026-12-21', '2026-12-31');
  check('days off: a range adds the days not already off, and joins up with them', db.hhWrites.slice(-1)[0].body.days_off.length === 15
    && (await lastToast(page)) === 'Added 10 days off (Dec 21–31)' && same(await daysOff(page), ['Wed Nov 11', 'Thu Nov 26 – Fri Nov 27 (2 days)', 'Mon Dec 21 – Thu Dec 31 (11 days)']), JSON.stringify(await daysOff(page)));
  await addDays(page, '2027-02-15');
  check('days off: next year\'s show their year', (await daysOff(page)).slice(-1)[0] === 'Mon Feb 15, 2027');
  const writes1 = db.hhWrites.length;
  await addDays(page, '2026-12-05', '2026-12-01');
  const e1 = await errorOf(page, '[data-ref="dayoffError"]');
  await addDays(page, '2026-11-26');
  const e2 = await errorOf(page, '[data-ref="dayoffError"]');
  await addDays(page, '2027-01-01', '2027-08-01');
  const e3 = await errorOf(page, '[data-ref="dayoffError"]');
  await addDays(page, '');
  const e4 = await errorOf(page, '[data-ref="dayoffError"]');
  check('days off: backwards, already off, too long, or no date → a reason, nothing saved', db.hhWrites.length === writes1 && /comes before the first/.test(e1)
    && e2 === 'Thu Nov 26 is already a day off.' && /more than 120 days/.test(e3) && e4 === 'Pick the first day off.', [e1, e2, e3, e4].join(' | '));
  await page.click('[data-remove="2026-11-26"]');
  await page.waitForTimeout(500);
  check('days off: Remove takes off the whole run; says so', !db.hhWrites.slice(-1)[0].body.days_off.some((d) => d === '2026-11-26' || d === '2026-11-27')
    && (await lastToast(page)) === 'Removed 2 days off' && !(await daysOff(page)).some((d) => /Nov 26/.test(d)) && !(await errorOf(page, '[data-ref="dayoffError"]')), await lastToast(page));
  await page.click('.set-past summary');
  await page.click('.set-past [data-remove="2026-10-12"]');
  await page.waitForTimeout(500);
  check('days off: a past day can go too', !db.hhWrites.slice(-1)[0].body.days_off.includes('2026-10-12') && !(await page.$('.set-past'))
    && (await lastToast(page)) === 'Mon Oct 12 is no longer a day off', await lastToast(page));
  db.hhFail = true;
  const before = await daysOff(page);
  await page.click('[data-remove="2026-11-11"]');
  await page.waitForTimeout(500);
  check('days off: a failed save says why and changes nothing on the page', (await errorOf(page, '[data-ref="dayoffError"]')) === 'Database restarting' && same(await daysOff(page), before)
    && !(await page.isDisabled('[data-remove="2026-11-11"]')));
  db.hhFail = false;
  check('days off: every write went through the same guarded update', db.hhWrites.slice(writes0).every((w) => /^\?id=eq\.true&updated_at=eq\./.test(w.url)));

  // =====================================================================
  // 3. Morning email: status and preview
  // =====================================================================
  // Back in New York (section 1 moved the household to Chicago); the device is still in Honolulu.
  db.household[0].tz = 'America/New_York';
  db.statusBody = STATUS_OK;
  await go(page, '#/people');
  await go(page, '#/settings');
  const st = db.fnCalls.filter((c) => c.body.action === 'status');
  check('status: hub-jobs { action: "status" } with Alex\'s sign-in', st.length >= 2 && same(st.slice(-1)[0], { body: { action: 'status' }, email: 'alex@example.com', auth: true }), JSON.stringify(st.slice(-1)));
  check('status: "Last run today at 6:30am, 4 sent" (the household\'s zone, not the device\'s), what happened, today\'s counts',
    (await status(page)) === 'Last run today at 6:30am, 4 sent | Emails went out. | Today: 4 morning emails sent, 1 confirmation.', await status(page));
  db.statusBody = STATUS_WARN;
  await go(page, '#/people');
  await go(page, '#/settings');
  check('status: failures and warnings show (as text)', (await status(page)) === 'Last run today at 6:45am, 0 sent1 failed | Some emails failed. Resend\'s reason is in notification_log. | '
    + 'Emails last went out yesterday at 6:30am (3 emails). | Today: 0 morning emails sent.'
    && same(await texts(page, '.set-messages li'), STATUS_WARN.messages) && !(await page.$('.set-messages li b')), await status(page));
  db.statusBody = STATUS_NEVER;
  await go(page, '#/people');
  await go(page, '#/settings');
  check('status: never run yet', /^Hasn't run yet/.test(await status(page)) && /never run/.test(await tc(page, '.set-messages')), await status(page));
  for (const [mode, why] of [['404', ''], ['503', 'SITE_URL is not set in the function\'s secrets, so the email links can\'t be made.'], ['offline', ''], ['text', '']]) {
    db.fn.status = mode;
    await go(page, '#/people');
    await go(page, '#/settings');
    const shown = await page.evaluate(() => ({ head: document.querySelector('[data-ref="status"] .set-status').textContent,
      why: (document.querySelector('[data-ref="status"] .set-why') || {}).hidden === false ? document.querySelector('[data-ref="status"] .set-why').textContent : '' }));
    check(`status (${mode}): "Not set up yet", and the page still works`, shown.head === 'Not set up yet' && shown.why === why && (await tc(page, '.set-head h1')) === 'Settings'
      && !!(await page.$('.set-form')), JSON.stringify(shown));
    check(`status (${mode}): says it in plain words (no "hub-jobs function")`, (await tc(page, '[data-ref="status"] .set-help'))
      === 'The morning email isn\'t switched on yet. Whoever set up the Home Hub needs to finish one last step (see the README).', await tc(page, '[data-ref="status"] .set-help'));
  }
  db.fn.status = 'ok';
  db.statusBody = STATUS_OK;

  await page.click('[data-act="preview"]');
  await page.waitForTimeout(600);
  const pv = db.fnCalls.filter((c) => c.body.action === 'preview');
  const dlg = await page.evaluate(() => {
    const d = document.getElementById('formDialog');
    const r = (n) => d.querySelector(`[data-ref="${n}"]`);
    return { open: d.open, title: d.querySelector('h3').textContent, for: r('for').textContent, why: r('why').hidden, subject: r('subject').textContent, text: r('text').textContent, b: !!r('text').querySelector('b') };
  });
  check('preview: hub-jobs { action: "preview", person_id: my person }', same(pv.map((c) => c.body), [{ action: 'preview', person_id: ID.alex }]), JSON.stringify(pv));
  check('preview: a dialog with who and when, the subject and the text version (as text)', same(dlg, { open: true, title: 'Your morning email', for: 'For Sunday, October 25 · to alex@example.com',
    why: true, subject: 'Sun Oct 25: 8:00am Drop off dogs · 3:00pm Pick up Jordan', text: PREVIEW_TEXT, b: false }), JSON.stringify(dlg));
  check('preview: the button is back', (await tc(page, '[data-act="preview"]')) === 'Preview my morning email' && !(await page.isDisabled('[data-act="preview"]')));
  await page.screenshot({ path: SHOTS + 'settings-preview.png' });
  await page.click('#formDialog .form-actions [data-close]');
  db.previewBody = previewOf({ would_send: false, reason: 'unconfirmed', local_date: '2026-10-26', subject: 'Mon Oct 26: nothing yet' });
  await page.click('[data-act="preview"]');
  await page.waitForTimeout(600);
  check('preview: says when it wouldn\'t be sent, and why', (await errorOf(page, '#formDialog [data-ref="why"]')) === 'Your address isn\'t confirmed yet, so this wouldn\'t be sent until it is.'
    && (await tc(page, '#formDialog [data-ref="for"]')) === 'For Monday, October 26 · to alex@example.com');
  await page.click('#formDialog .d-close');
  db.previewBody = { date: TODAY, emails: [] };
  await page.click('[data-act="preview"]');
  await page.waitForTimeout(600);
  check('preview: nothing to preview says so', (await tc(page, '#formDialog [data-ref="for"]')) === 'There\'s no email to preview for you yet.' && !(await page.isVisible('#formDialog [data-ref="text"]')));
  await page.click('#formDialog .d-close');
  db.previewBody = null;
  db.fn.preview = '503';
  await page.click('[data-act="preview"]');
  await page.waitForTimeout(600);
  check('preview: the function\'s reason shows when it can\'t make one', (await lastToast(page)) === 'SITE_URL is not set in the function\'s secrets, so the email links can\'t be made.'
    && !(await page.evaluate(() => document.getElementById('formDialog').open)), await lastToast(page));
  db.fn.preview = '404';
  await page.click('[data-act="preview"]');
  await page.waitForTimeout(600);
  check('preview: not deployed → "isn\'t set up yet"', (await lastToast(page)) === 'Couldn\'t make a preview: the morning email isn\'t set up yet.', await lastToast(page));
  db.fn.preview = '404-person';
  await page.click('[data-act="preview"]');
  await page.waitForTimeout(600);
  check('preview: a 404 with the function\'s own reason shows that reason', (await lastToast(page)) === 'No active person with that id.', await lastToast(page));
  db.fn.preview = 'ok';

  // =====================================================================
  // 4. Google Calendar & Hearth, the Home Screen, Sign out
  // =====================================================================
  // Changed on purpose in v1.1: on schema 2 the card waits for the database update (migration 0003),
  // where it said "Not connected yet — coming next" (docs/v1.1-google-calendar.md §6.5).
  check('Google Calendar & Hearth (schema 2): one row, waiting for the database update, no fields', (await tc(page, '[data-ref="calendar"]')) === 'Waiting for the database update'
    && (await page.$$('[data-ref="calendar"] input, [data-ref="calendar"] select, [data-ref="calendar"] button')).length === 0
    && !(db.rpcCalls || []).some((c) => /^(google_items|calendar_)/.test(c.name)) && !log.some((l) => /\/rest\/v1\/(calendars|calendar_sync|calendar_links|google_events)/.test(l)),
    await tc(page, '[data-ref="calendar"]'));
  const steps = await texts(page, '.set-steps li');
  check('Home Screen: the iPhone and Android steps', (await tc(page, '#setApp')) === 'Add Home Hub to your Home Screen'
    && steps[0] === 'iPhone: in Safari, tap Share (the square with an arrow), then Add to Home Screen. Open it from there and sign in again: the Home Screen app keeps its own sign-in.'
    && steps[1] === 'Android: in Chrome, tap the ⋮ menu, then Install app (or Add to Home screen).' && !(await page.isVisible('[data-ref="standalone"]')), JSON.stringify(steps));
  check('signed in as Alex', (await tc(page, '[data-ref="who"]')) === 'Alex Example (alex@example.com)');
  await page.screenshot({ path: SHOTS + 'settings-desktop.png', fullPage: true });
  await page.click('[data-act="sign-out"]');
  await page.waitForTimeout(600);
  check('Sign out: signs out and shows the sign-in screen', log.some((l) => l.startsWith('POST /auth/v1/logout')) && await page.isVisible('#loginForm'));
  check('no XSS', await page.evaluate(() => !window.__xss));
  await page.context().close();

  // =====================================================================
  // 5. A member (Sam) reads the settings; nothing to change, no hub-jobs calls
  // =====================================================================
  ({ page, db } = await open({ label: 'member', email: 'sam@example.com' }));
  const dl = await page.$$eval('.set-dl dt, .set-dl dd', (es) => es.map((e) => e.textContent));
  check('member: the household as text, with friendly names', same(dl, ['Time zone', 'Eastern time (New York)', 'Morning email time', '6:30am', 'New pet tasks go to', 'Sam Example',
    'New house tasks go to', 'Nobody (choose each time)']), JSON.stringify(dl));
  check('member: no forms, no Remove, no preview; says only admins can change these', !(await page.$('.set-form')) && !(await page.$('[data-ref="dayoffForm"]')) && !(await page.$('[data-remove]'))
    && !(await page.$('[data-act="preview"]')) && (await tc(page, '.set-head .meta')) === 'Only admins (parents who sign in) can change these.');
  check('member: days off listed; hub-jobs never asked', same(await daysOff(page), ['Thu Nov 26 – Fri Nov 27 (2 days)', 'Thu Dec 24']) && db.fnCalls.length === 0
    && /Ask an admin/.test(await tc(page, 'section[aria-labelledby="setEmail"] .set-body')));
  // Even if a member's browser sent an update, the database changes no rows: the page would say so.
  const refused = await page.evaluate(async () => {
    const { data } = await HomeHub.core.sb.from('household').update({ tz: 'Pacific/Honolulu' }).eq('id', true).select();
    return data;
  });
  check('member: the household fake refuses a member\'s update (no rows), as RLS does', same(refused, []) && db.household[0].tz === 'America/New_York');
  await page.context().close();

  // =====================================================================
  // 6. Phones (390px): no sideways scroll, 44px targets; light and dark
  // =====================================================================
  for (const scheme of ['light', 'dark']) {
    ({ page, db } = await open({ label: `phone-${scheme}`, ctx: Object.assign({ colorScheme: scheme }, phone) }));
    await page.click('.set-past summary');
    check(`phone (${scheme}): no sideways scroll`, await noSideScroll(page));
    const sizes = await page.$$eval('main .btn, main select, main input, .set-past summary', (es) => es.filter((e) => e.offsetParent).map((e) => {
      const r = e.getBoundingClientRect(); return [e.name || e.className, e.textContent.trim().slice(0, 20), Math.round(r.width), Math.round(r.height)];
    }));
    check(`phone (${scheme}): every button, field and toggle is at least 44px`, sizes.length > 12 && sizes.every(([, , w, h]) => w >= 44 && h >= 44), JSON.stringify(sizes.filter(([, , w, h]) => w < 44 || h < 44)));
    check(`phone (${scheme}): cards fit the screen`, await page.$$eval('.set-card', (cs) => cs.every((c) => c.getBoundingClientRect().right <= window.innerWidth)));
    const colors = await page.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(document.querySelector('.set-card')).backgroundColor,
      input: getComputedStyle(document.querySelector('.set-form input[type="time"]')).backgroundColor }));
    const want = scheme === 'dark' ? { body: 'rgb(18, 17, 16)', card: 'rgb(27, 25, 23)', input: 'rgb(27, 25, 23)' } : { body: 'rgb(246, 244, 240)', card: 'rgb(255, 255, 255)', input: 'rgb(255, 255, 255)' };
    check(`phone (${scheme}): page, cards and fields use the theme's colours`, same(colors, want), JSON.stringify(colors));
    await page.screenshot({ path: SHOTS + `settings-phone-${scheme}.png`, fullPage: true });
    await page.click('[data-act="preview"]');
    await page.waitForTimeout(500);
    const dlgFit = await page.evaluate(() => {
      const d = document.getElementById('formDialog');
      const small = [...d.querySelectorAll('button')].filter((e) => e.offsetParent).map((e) => [e.className, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])
        .filter(([, w, h]) => w < 44 || h < 44);
      return { fits: d.scrollWidth <= d.clientWidth && d.getBoundingClientRect().right <= window.innerWidth, small };
    });
    check(`phone (${scheme}): the preview fits the screen; its buttons are 44px`, dlgFit.fits && !dlgFit.small.length, JSON.stringify(dlgFit));
    await page.screenshot({ path: SHOTS + `settings-preview-phone-${scheme}.png` });
    await page.context().close();
  }

  // =====================================================================
  // 6b. Google Calendar & Hearth on schema 3 (migration 0003)
  // =====================================================================
  // The card's rows: label, chip, the name to make in Google, the lines under it, the last Test, the buttons.
  const gRows = (page, list) => page.$$eval(`[data-ref="${list}"] > .set-gcal`, (lis) => lis.map((li) => ({
    label: (() => { const l = li.querySelector('.set-gcal-label').cloneNode(true); l.querySelectorAll('.pdot').forEach((x) => x.remove()); return l.textContent.replace(/\s+/g, ' ').trim(); })(),
    chip: li.querySelector('.set-chip').textContent,
    name: (li.querySelector('.set-gname b') || {}).textContent || null,
    lines: [...li.querySelectorAll('.set-gmeta, .set-gdetail, .set-gq')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
    test: li.querySelector('.set-gtest p') ? li.querySelector('.set-gtest p').textContent.replace(/\s+/g, ' ').trim() : null,
    buttons: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()),
    kids: li.querySelector('[data-gkids]') ? li.querySelector('[data-gkids]').checked : null,
  })));
  const gStatus = (page) => texts(page, '[data-ref="gstatus"] > p');
  const gList = (page, ref) => texts(page, `[data-ref="${ref}"] li`);
  const writes = (db, table, method) => (db.calWrites || []).filter((w) => w.table === table && (!method || w.method === method));
  const jobs = (db, action) => (db.jobCalls || []).filter((c) => c.body.action === action);
  const dlgText = (page, sel) => page.$eval(`#formDialog ${sel}`, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const submitDialog = async (page) => { await page.click('#formDialog [type="submit"]'); await page.waitForTimeout(600); };
  // hub-jobs' 400, 404, 500 and 503 on purpose, and the unique Calendar ID's 409.
  const allowed = /status of (400|404|409|500|503)/;

  // ---------- A household just updated to schema 3: nothing set up yet (Alex, an admin)
  ({ page, db, log } = await open({ label: 'google-new', db: googleDb(), rpc: v3Rpc, clipboard: true, allowConsole: allowed }));
  check('schema 3: the card loads calendars and calendar_sync, and (admins) calendar_links', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 3
    && ['calendars', 'calendar_sync', 'calendar_links'].every((t) => log.some((l) => l.startsWith(`GET /rest/v1/${t}?`))), log.filter((l) => /calendar/.test(l)).join(' | '));
  check('not set up: says to add the Google key, then press Sync now; hasn\'t synced', same(await gStatus(page),
    ['Not set up: add the Google key to Supabase (README → Google Calendar and Hearth). Added it? Press Sync now.', 'Hasn\'t synced yet']), JSON.stringify(await gStatus(page)));
  let cols = await gRows(page, 'gcolumns');
  check('calendars: one row per active person, then Family (not Morgan, who is off the list), each not connected, with the name to make in Google',
    same(cols.map((r) => [r.label, r.chip, r.name, r.buttons]), [['Alex', 'Not connected', 'Hub – Alex', ['Copy', 'Set']], ['Sam', 'Not connected', 'Hub – Sam', ['Copy', 'Set']],
      ['Jordan', 'Not connected', 'Hub – Jordan', ['Copy', 'Set']], ['Family', 'Not connected', 'Hub – Family', ['Copy', 'Set']]]), JSON.stringify(cols));
  const opt = await gRows(page, 'goptional');
  check('calendars: Pets and House under "Optional: only if pet or house tasks are often left with nobody in charge"',
    same(opt.map((r) => [r.label, r.chip, r.name]), [['Pets', 'Not connected', 'Hub – Pets'], ['House', 'Not connected', 'Hub – House']])
    && (await tc(page, '.set-gopt')) === 'Optional: only if pet or house tasks are often left with nobody in charge', JSON.stringify(opt));
  let reads = await gRows(page, 'greads');
  check('calendars to read: first the family account\'s main calendar (Set), and the help on who sees them', same(reads.map((r) => [r.label, r.chip, r.buttons]),
    [["Family account's main calendar", 'Not connected', ['Set']]]) && (await texts(page, '[data-ref="calendar"] .set-help')).includes(
    'Their events show on the Calendar and Today pages and in grown-ups\' morning emails. A Family one\'s reach kids\' My day only with Show to kids, '
    + 'and never a helper\'s. One you give to a person reaches that person\'s My day, texts and morning email, kids and helpers included.'), JSON.stringify(reads));
  check('Not on Google: every active person without a Hub calendar', (await tc(page, '[data-ref="gmissing"]')) === 'No Hub calendar, so their items aren\'t copied to Google or the wall: Alex, Sam, Jordan.',
    await tc(page, '[data-ref="gmissing"]'));
  const hearth = await texts(page, '.set-hearth li');
  check('Hearth: the short note (a profile that stays, Resync, view-only and no alerts, the wall is public, notifications off)', hearth.length === 5
    && /profile that will stay/.test(hearth[0]) && /Resync/.test(hearth[1]) && /view-only/.test(hearth[2]) && /morning email does/.test(hearth[2])
    && /helper and visitors/.test(hearth[3]) && /Private/.test(hearth[3]) && /notifications turned off/.test(hearth[4]), JSON.stringify(hearth));
  check('Hearth: a change reaches the wall from yesterday onward; past days only come off with Private or Delete', /for yesterday onward/.test(hearth[1])
    && /from yesterday onward the change reaches the wall within 5 minutes/.test(hearth[3]) && /only Private or Delete takes a past item off/.test(hearth[3]), JSON.stringify(hearth));
  check('no problem, put-back or stale-project lists when there are none', !(await page.$('[data-ref="gproblems"], [data-ref="grepairs"], [data-ref="gstale"]')));
  await page.click('[data-ref="gcolumns"] [data-copy="Hub – Jordan"]');
  await page.waitForTimeout(300);
  check('Copy: puts "Hub – Jordan" on the clipboard, and says so', (await lastToast(page)) === 'Copied: Hub – Jordan'
    && (await page.evaluate(() => navigator.clipboard.readText())) === 'Hub – Jordan', await lastToast(page));

  // Sync now, from a hub-jobs from before v1.1 (400 Unknown action), one not deployed (404), and a
  // database without 0003 (503 no_schema): "Waiting for the hub-jobs update", never an error.
  for (const [mode, what] of [['old', '400'], ['missing', '404'], ['no_schema', '503 no_schema']]) {
    db.jobMode = { calendar: mode };
    await page.click('[data-act="gsync"]');
    await page.waitForTimeout(600);
    const note = await page.$eval('[data-ref="gsync"]', (e) => [e.textContent, e.className]).catch(() => ['', '']);
    check(`Sync now: hub-jobs answers ${what} → "Waiting for the hub-jobs update", not an error`, note[0] === 'Waiting for the hub-jobs update' && /is-wait/.test(note[1])
      && (await page.isEnabled('[data-act="gsync"]')), JSON.stringify(note));
  }
  db.jobMode = {};
  await page.click('[data-act="gsync"]');
  await page.waitForTimeout(600);
  const syncCall = db.fnCalls.filter((c) => c.body.action === 'calendar').slice(-1)[0];
  check('Sync now: hub-jobs { action: "calendar" } with Alex\'s sign-in; says what it did', same(syncCall, { body: { action: 'calendar' }, email: 'alex@example.com', auth: true })
    && (await tc(page, '[data-ref="gsync"]')) === 'Synced: 3 added, 1 changed in Google. 2 calendars read.', `${JSON.stringify(syncCall)} ${await tc(page, '[data-ref="gsync"]')}`);

  // Set Jordan's calendar: a bad ID and a main calendar are refused, with the reason; then the real one.
  await page.click(`[data-gset="person:${ID.jordan}"]`);
  await page.waitForTimeout(300);
  check('Set: a form for the Calendar ID, titled with the name to make in Google', (await dlgText(page, 'h3')) === 'Hub – Jordan' && !!(await page.$('#formDialog input[name="google_id"]'))
    && !(await page.$('#formDialog input[name="label"]')) && /Integrate calendar/.test(await dlgText(page, '.meta')));
  await page.fill('#formDialog input[name="google_id"]', 'hello there');
  await submitDialog(page);
  const bad1 = await errorOf(page, '#formDialog .form-error');
  await page.fill('#formDialog input[name="google_id"]', 'jordan@example.com');
  await submitDialog(page);
  const bad2 = await errorOf(page, '#formDialog .form-error');
  check('Set: not a Calendar ID → says where to find it; nothing saved', /isn't a Calendar ID/.test(bad1) && /Integrate calendar/.test(bad1) && !writes(db, 'calendars').length, bad1);
  check('Set: someone\'s main calendar is refused for a calendar the hub writes, and says why', /someone's main calendar/.test(bad2) && /@group\.calendar\.google\.com/.test(bad2)
    && /make "Hub – Jordan" in Google Calendar/.test(bad2) && !writes(db, 'calendars').length, bad2);
  await page.fill('#formDialog input[name="google_id"]', '  JORDAN0123@Group.Calendar.Google.com ');
  await submitDialog(page);
  await page.waitForTimeout(400);
  const jordanCal = db.calendars.find((c) => c.person_id === ID.jordan);
  check('Set: saves the row (insert, only the columns admins may set; the ID lowercased, the label the first name)', same(writes(db, 'calendars', 'POST').map((w) => w.body),
    [{ google_id: GID('jordan0123'), kind: 'person', person_id: ID.jordan, label: 'Jordan', writes: true, for_kids: false }]) && !!jordanCal, JSON.stringify(writes(db, 'calendars')));
  check('Set: then Test (hub-jobs calendar_test with the new row\'s id, Alex\'s sign-in)', jordanCal && same(jobs(db, 'calendar_test').map((c) => [c.body, c.email]),
    [[{ action: 'calendar_test', calendar_id: jordanCal.id }, 'alex@example.com']]), JSON.stringify(jobs(db, 'calendar_test')));
  check('Set: Test\'s result, and what it did', (await dlgText(page, '[data-ref="test"] .set-gtest p')) === 'Test: Home Hub can write to this calendar.'
    && same(await texts(page, '#formDialog .set-gsteps li'), ['Read the calendar: done', 'Add a test event: done', 'Delete it: done', 'Bring it back: done', 'Read it back: done',
      'Same as what was written: done', 'Delete it again: done']), await dlgText(page, '[data-ref="test"]'));
  const pvRows = () => page.$$eval('#formDialog [data-ref="pv"] > li', (lis) => lis.map((li) => [li.className, li.querySelector('.set-pv-title') ? li.querySelector('.set-pv-title').textContent : li.textContent,
    !!li.querySelector('.badge'), !!li.querySelector('[data-gprivate]')]));
  check('preview: calendar_preview(p_calendar): everything Start copying puts on the wall (to 60 days ahead), by day; Make private on events and tasks only', same(db.previewCalls.slice(-1), [{ p_calendar: jordanCal.id }])
    && same(await pvRows(), [['set-pv-day', 'Sun Oct 25', false, false], ['set-pv-row', '☐ 2 late: Take out recycling, Private item', false, false],
      ['set-pv-day', 'Tue Oct 27', false, false], ['set-pv-row', 'Piano (with Jordan)', false, true], ['set-pv-row', '☐ Heartworm pill', false, true],
      ['set-pv-day', 'Thu Oct 29', false, false], ['set-pv-row', 'Private item', true, false], ['set-pv-day', 'Mon Nov 2', false, false], ['set-pv-row', 'Kitchen: Paint starts', false, false],
      ['set-pv-day', 'Fri Dec 18', false, false], ['set-pv-row', 'Trip', false, true]]),
    JSON.stringify(await pvRows()));
  check('preview: says how far ahead it copies', (await dlgText(page, '#gpvTitle')) === 'What it copies: yesterday to 60 days ahead'
    && /everything Start copying puts on it/.test(await dlgText(page, '.set-gpv .set-help')), await dlgText(page, '#gpvTitle'));
  check('preview: the place and the directory entry\'s name and number, as they go on the wall', same(await texts(page, '#formDialog .set-pv-meta'),
    ['Rivera Music, 12 Elm St · Rivera Music 555-0150', 'Pat Lee (201) 555-0100']), JSON.stringify(await texts(page, '#formDialog .set-pv-meta')));
  check('preview: Make private says it changes the item itself, for kids and helpers too, and every repeat', /Make private changes the item itself, on every day it repeats: kids and helpers then see only "Private item" for it on My day, in texts and in emails, even when it is their own\./
    .test(await dlgText(page, '.set-pv-note')), await dlgText(page, '.set-pv-note'));
  check('preview: where a late line or a project job can be kept off instead', same(await texts(page, '#formDialog .set-pv-hint'),
    ['To hide a task on this line, make the task private on the Tasks page.', 'To keep a project\'s jobs off the wall, untick "Show in Home Hub calendar" on the project.']),
    JSON.stringify(await texts(page, '#formDialog .set-pv-hint')));
  check('preview: Start copying (the main button: Test passed), and Not now', same(await texts(page, '#formDialog .form-actions button'), ['Not now', 'Start copying'])
    && (await page.$eval('#formDialog [data-gstart]', (b) => b.classList.contains('btn-primary'))) && (await dlgText(page, '[data-ref="test"] .set-gmeta')) === 'In Google: Hub – Jordan'
    && (await dlgText(page, '[data-ref="ask"]')) === '');
  await page.screenshot({ path: SHOTS + 'settings-google-preview.png' });
  await page.click('#formDialog [data-gprivate="event|ev-piano"]');
  await page.waitForTimeout(500);
  check('Make private: sets that event\'s private, and the preview shows it as "Private item"', same((db.writesEvents || []).slice(-1).map((w) => [/id=eq\.ev-piano/.test(w.url), w.body]), [[true, { private: true }]])
    && same((await pvRows()).filter((r) => r[0] === 'set-pv-row').map((r) => r[1]), ['☐ 2 late: Take out recycling, Private item', 'Private item', '☐ Heartworm pill', 'Private item', 'Kitchen: Paint starts', 'Trip']),
    JSON.stringify(await pvRows()));
  await page.click('#formDialog [data-gprivate="task|tk-pill"]');
  await page.waitForTimeout(500);
  check('Make private: a task too', same(writes(db, 'tasks', 'PATCH').map((w) => [w.url, w.body]), [['?id=eq.tk-pill&select=id', { private: true }]]) && db.tasks[0].private === true);
  await page.click('#formDialog [data-gstart]');
  await page.waitForTimeout(600);
  const approve = writes(db, 'calendars', 'PATCH').slice(-1)[0] || {};
  check('Start copying: sets copy_approved_at on that row only; the dialog closes and says when copying starts', approve.url === `?id=eq.${jordanCal.id}&select=id`
    && same(Object.keys(approve.body || {}), ['copy_approved_at']) && !isNaN(Date.parse(approve.body.copy_approved_at))
    && !(await page.evaluate(() => document.getElementById('formDialog').open)) && (await lastToast(page)) === 'Copying to Hub – Jordan starts within 5 minutes', JSON.stringify(approve));
  cols = await gRows(page, 'gcolumns');
  check('Jordan\'s row: Connected, its Google name, the last Test, and Set, Test, Preview, Disconnect', same(cols[2], { label: 'Jordan', chip: 'Connected', name: 'Hub – Jordan',
    lines: ['In Google: Hub – Jordan'], test: 'Test: Home Hub can write to this calendar.', buttons: ['Copy', 'Set', 'Test', 'Preview', 'Disconnect'], kids: null }), JSON.stringify(cols[2]));
  check('Not on Google: Jordan has left the list', (await tc(page, '[data-ref="gmissing"]')) === 'No Hub calendar, so their items aren\'t copied to Google or the wall: Alex, Sam.');

  // Alex's: the embed address Google gives (the whole <iframe>) is taken apart. It is the ID of a
  // calendar Google calls "Hub – Jordan": the dialog says so, and asks.
  db.testReplies = { [GID('alex0456')]: { name: 'Hub – Jordan' } };
  await page.click(`[data-gset="person:${ID.alex}"]`);
  await page.fill('#formDialog input[name="google_id"]', '<iframe src="https://calendar.google.com/calendar/embed?src=alex0456%40group.calendar.google.com&amp;ctz=America%2FNew_York" style="border: 0" width="800" height="600" frameborder="0" scrolling="no"></iframe>');
  await submitDialog(page);
  await page.waitForTimeout(400);
  check('Set: a pasted embed address gives the Calendar ID', same(writes(db, 'calendars', 'POST').slice(-1)[0].body.google_id, GID('alex0456')));
  check('Set: after Test the dialog shows the calendar\'s name in Google, and asks whose it is when it isn\'t Alex\'s (above the buttons)',
    (await dlgText(page, '[data-ref="test"] .set-gmeta')) === 'In Google: Hub – Jordan'
    && (await dlgText(page, '[data-ref="ask"] .set-gq')) === 'This calendar is called \'Hub – Jordan\'. Is that Alex\'s? If not, press Not now and Set the right Calendar ID.',
    `${await dlgText(page, '[data-ref="test"]')} | ${await dlgText(page, '[data-ref="ask"]')}`);
  check('... and Start copying is no longer the main button', !(await page.$eval('#formDialog [data-gstart]', (b) => b.classList.contains('btn-primary'))));
  db.testReplies = {};
  await page.click('#formDialog .form-actions [data-close]');
  await page.waitForTimeout(300);
  cols = await gRows(page, 'gcolumns');
  check('Not now: Alex\'s calendar waits for Start copying; nothing approved', cols[0].chip === 'Waiting: press Preview, then Start copying' && !db.calendars.find((c) => c.person_id === ID.alex).copy_approved_at, JSON.stringify(cols[0]));

  // Test: what Google said, on the row.
  const alexCal = db.calendars.find((c) => c.person_id === ID.alex);
  db.testReplies = { [GID('alex0456')]: { ok: false, status: 'no_access', message: `Home Hub can't change this calendar. In Google Calendar, share it with ${ACCOUNT} and choose Make changes and see event details.`,
    name: 'Hub – Alex', role: 'reader', steps: [{ step: 'list', ok: true, http: 200 }] } };
  await page.click(`[data-gtest="${alexCal.id}"]`);
  await page.waitForTimeout(600);
  cols = await gRows(page, 'gcolumns');
  check('Test: shared read-only → "Can\'t reach it", with what to share', cols[0].chip === 'Can\'t reach it'
    && same(cols[0].lines, ['In Google: Hub – Alex', `Home Hub can't change this calendar. In Google Calendar, share it with ${ACCOUNT} and choose Make changes and see event details.`])
    && cols[0].test === `Test: Home Hub can't change this calendar. In Google Calendar, share it with ${ACCOUNT} and choose Make changes and see event details.`, JSON.stringify(cols[0]));
  db.testReplies = { [GID('alex0456')]: { ok: false, status: 'error', message: NAME_RULE, name: 'Work', role: 'writer', steps: [{ step: 'list', ok: true, http: 200 }] } };
  await page.click(`[data-gtest="${alexCal.id}"]`);
  await page.waitForTimeout(600);
  cols = await gRows(page, 'gcolumns');
  check('Test: not named "Hub …" → "Problem", why, and the name question', cols[0].chip === 'Problem'
    && same(cols[0].lines, ['In Google: Work', NAME_RULE, 'This calendar is called \'Work\'. Is that Alex\'s?']), JSON.stringify(cols[0]));
  for (const [mode, what] of [['old', '400'], ['missing', '404'], ['no_schema', '503 no_schema']]) {
    db.jobMode = { calendar_test: mode };
    await page.click(`[data-gtest="${alexCal.id}"]`);
    await page.waitForTimeout(600);
    cols = await gRows(page, 'gcolumns');
    check(`Test: hub-jobs answers ${what} → "Waiting for the hub-jobs update"`, cols[0].test === 'Test: Waiting for the hub-jobs update'
      && (await page.$eval('[data-ref="gcolumns"] > .set-gcal .set-gtest', (e) => e.className)) === 'set-gtest is-wait', JSON.stringify(cols[0]));
  }
  db.jobMode = {};
  db.testReplies = {};

  // Disconnect asks first.
  db.confirm = false;
  await page.click(`[data-gdrop="${alexCal.id}"]`);
  await page.waitForTimeout(300);
  check('Disconnect: asks first ("…taken off that calendar within a few minutes"); No changes nothing', db.confirms.slice(-1)[0][1] === 'Disconnect Hub – Alex? The hub\'s events are taken off that calendar within a few minutes.'
    && !writes(db, 'calendars', 'DELETE').length && db.calendars.some((c) => c.id === alexCal.id), JSON.stringify(db.confirms.slice(-1)));
  db.confirm = true;
  await page.click(`[data-gdrop="${alexCal.id}"]`);
  await page.waitForTimeout(600);
  cols = await gRows(page, 'gcolumns');
  check('Disconnect: deletes the row; Alex is not connected again', same(writes(db, 'calendars', 'DELETE').map((w) => w.url), [`?id=eq.${alexCal.id}`])
    && cols[0].chip === 'Not connected' && (await lastToast(page)) === 'Disconnected Hub – Alex', JSON.stringify(cols[0]));

  // Pets, with its title prefix.
  await page.click('[data-gset="pets"]');
  check('Set (Pets): the title prefix, "Pets" to start with', (await page.inputValue('#formDialog input[name="label"]')) === 'Pets');
  await page.fill('#formDialog input[name="google_id"]', GID('pets0987'));
  await page.fill('#formDialog input[name="label"]', ' Dogs ');
  await submitDialog(page);
  await page.click('#formDialog .form-actions [data-close]');
  await page.waitForTimeout(300);
  check('Set (Pets): saved with its prefix; the row says what titles start with', same(writes(db, 'calendars', 'POST').slice(-1)[0].body,
    { google_id: GID('pets0987'), kind: 'pets', person_id: null, label: 'Dogs', writes: true, for_kids: false })
    && (await gRows(page, 'goptional'))[0].label === 'Pets titles start "Dogs:"', JSON.stringify(await gRows(page, 'goptional')));

  // The family account's main calendar: read only, its own address; then Show to kids.
  await page.click('[data-gset="main"]');
  await page.fill('#formDialog input[name="google_id"]', GID('holidays0001'));
  await submitDialog(page);
  const bad3 = await errorOf(page, '#formDialog .form-error');
  check('Set (main calendar): a calendar made in Google is refused here, and says where it goes', /family account's own address/.test(bad3) && /Add a calendar to read/.test(bad3), bad3);
  await page.fill('#formDialog input[name="google_id"]', 'Family@Example.com');
  await submitDialog(page);
  await page.waitForTimeout(300);
  check('Set (main calendar): a Family calendar the hub only reads, labelled "Family account"', same(writes(db, 'calendars', 'POST').slice(-1)[0].body,
    { google_id: 'family@example.com', kind: 'family', person_id: null, label: 'Family account', writes: false, for_kids: false }));
  check('Set (main calendar): Test reads it; no preview or Start copying for a calendar the hub only reads', (await dlgText(page, 'h3')) === "Family account's main calendar"
    && (await dlgText(page, '[data-ref="test"] .set-gtest p')) === 'Test: Home Hub can read this calendar.' && !(await page.$('#formDialog [data-ref="pv"]'))
    && same(await texts(page, '#formDialog .form-actions button'), ['Done']));
  await page.click('#formDialog .form-actions [data-close]');
  await page.waitForTimeout(300);
  reads = await gRows(page, 'greads');
  check('the main calendar: Connected, Show to kids off, Set, Test, Disconnect', reads[0].chip === 'Connected' && reads[0].kids === false
    && same(reads[0].buttons, ['Set', 'Test', 'Disconnect']), JSON.stringify(reads[0]));
  await page.click('[data-ref="greads"] [data-gkids]');
  await page.waitForTimeout(500);
  const mainCal = db.calendars.find((c) => c.google_id === 'family@example.com');
  check('Show to kids: saves for_kids on that calendar', same(writes(db, 'calendars', 'PATCH').slice(-1).map((w) => [w.url, w.body]), [[`?id=eq.${mainCal.id}&select=id`, { for_kids: true }]])
    && (await gRows(page, 'greads'))[0].kids === true && (await lastToast(page)) === 'Kids now see its events on My day', await lastToast(page));

  // Add a calendar to read: Family with Show to kids; a person's (no Show to kids); one already set up.
  await page.click('[data-act="gadd"]');
  check('Add: for Family, the help says kids see it only with Show to kids, never a helper', (await dlgText(page, '[data-ref="whose-help"]'))
    === 'They reach kids\' My day only with Show to kids, and never a helper\'s.', await dlgText(page, '[data-ref="whose-help"]'));
  await page.selectOption('#formDialog select[name="whose"]', ID.jordan);
  check('Add: for a person, it says it reaches that person\'s My day, texts and email', (await dlgText(page, '[data-ref="whose-help"]'))
    === 'They also reach Jordan\'s My day, texts and morning email.', await dlgText(page, '[data-ref="whose-help"]'));
  await page.selectOption('#formDialog select[name="whose"]', 'family');
  check('Add a calendar to read: ID, a name, whose (Family or a person), Show to kids for Family', same(await page.$$eval('#formDialog select[name="whose"] option', (os) => os.map((o) => o.textContent)),
    ['Family', 'Alex Example', 'Sam Example', 'Jordan Example']) && await page.isVisible('#formDialog [data-ref="kids"]'));
  await page.fill('#formDialog input[name="google_id"]', 'en.usa#holiday@group.v.calendar.google.com');
  await page.fill('#formDialog input[name="label"]', 'Holidays');
  await page.check('#formDialog input[name="for_kids"]');
  await submitDialog(page);
  check('Add: a holiday calendar (with "#") for Family, shown to kids', same(writes(db, 'calendars', 'POST').slice(-1)[0].body,
    { google_id: 'en.usa#holiday@group.v.calendar.google.com', kind: 'family', person_id: null, label: 'Holidays', writes: false, for_kids: true }));
  await page.click('#formDialog .form-actions [data-close]');
  await page.click('[data-act="gadd"]');
  await page.selectOption('#formDialog select[name="whose"]', ID.sam);
  check('Add: no Show to kids for a person\'s calendar', !(await page.isVisible('#formDialog [data-ref="kids"]')));
  await page.fill('#formDialog input[name="google_id"]', 'sam.work@example.com');
  await page.fill('#formDialog input[name="label"]', 'Sam work');
  await submitDialog(page);
  check('Add: Sam\'s own calendar to read', same(writes(db, 'calendars', 'POST').slice(-1)[0].body,
    { google_id: 'sam.work@example.com', kind: 'person', person_id: ID.sam, label: 'Sam work', writes: false, for_kids: false }));
  await page.click('#formDialog .form-actions [data-close]');
  await page.click('[data-act="gadd"]');
  await page.fill('#formDialog input[name="google_id"]', 'family@example.com');
  await page.fill('#formDialog input[name="label"]', 'Again');
  const posts = writes(db, 'calendars', 'POST').length;
  await submitDialog(page);
  check('Add: a calendar already set up says so (the unique Calendar ID)', (await errorOf(page, '#formDialog .form-error')) === 'That calendar is set up here already, on another row.'
    && db.calendars.filter((c) => c.google_id === 'family@example.com').length === 1 && writes(db, 'calendars', 'POST').length === posts + 1, await errorOf(page, '#formDialog .form-error'));
  await page.click('#formDialog .form-actions [data-close]');
  reads = await gRows(page, 'greads');
  check('calendars to read: the main one, then the others with whose they are', same(reads.map((r) => [r.label, r.chip]),
    [["Family account's main calendar", 'Connected'], ['Holidays Family', 'Connected'], ['Sam work Sam Example', 'Connected']]), JSON.stringify(reads));
  // Sam's: Test fails (not shared yet). Start copying is still offered, but not as the main button,
  // and approving says copying waits until Home Hub can reach the calendar.
  db.testReplies = { [GID('sam0789')]: { ok: false, status: 'no_access', name: 'Hub – Sam', role: 'reader', steps: [{ step: 'list', ok: true, http: 200 }],
    message: `Home Hub can't change this calendar. In Google Calendar, share it with ${ACCOUNT} and choose Make changes and see event details.` } };
  await page.click(`[data-gset="person:${ID.sam}"]`);
  await page.fill('#formDialog input[name="google_id"]', GID('sam0789'));
  await submitDialog(page);
  await page.waitForTimeout(400);
  check('Test failed: Start copying is not the main button', (await dlgText(page, '[data-ref="test"] .set-gtest p')).startsWith('Test: Home Hub can\'t change this calendar')
    && !(await page.$eval('#formDialog [data-gstart]', (b) => b.classList.contains('btn-primary'))), await dlgText(page, '[data-ref="test"]'));
  await page.click('#formDialog [data-gstart]');
  await page.waitForTimeout(500);
  check('... and approving says copying starts once Home Hub can reach it', (await lastToast(page)) === 'Approved: copying to Hub – Sam starts once Home Hub can reach it (see its row)',
    await lastToast(page));
  db.testReplies = {};
  await page.screenshot({ path: SHOTS + 'settings-google-setup.png', fullPage: true });
  check('no XSS', await page.evaluate(() => !window.__xss));
  await page.context().close();

  // ---------- Set up a while: signed in, copying, some calendars in trouble, problems and repairs
  ({ page, db, log } = await open({ label: 'google-rich', db: richDb(), rpc: v3Rpc, allowConsole: allowed }));
  check('signed in: the service account with Copy, the key\'s last 6 characters, what to share; last synced, events on Google; hiding and copying',
    same(await gStatus(page), [`Signed in as ${ACCOUNT} Copy · key …a1b2c3: share each Hub calendar with this address (Make changes and see event details)`,
      'Last synced 3 minutes ago · 4 events', 'Hiding 3 items in Google…', 'Copying 211 items to Google…']), JSON.stringify(await gStatus(page)));
  cols = await gRows(page, 'gcolumns');
  check('rows: Waiting for Start copying, Not checked yet, Connected, Can\'t reach it (with what to share); Morgan (off the list) after Family',
    same(cols.map((r) => [r.label, r.chip, r.lines]), [['Alex', 'Waiting: press Preview, then Start copying', ['In Google: Hub – Alex']], ['Sam', 'Not checked yet', []],
      ['Jordan', 'Connected', ['In Google: Hub – Jordan']], ['Family', 'Can\'t reach it', ['In Google: Hub – Family', `Share it with ${ACCOUNT} and choose Make changes and see event details.`]],
      ['Morgan off the family list', 'Connected', ['In Google: Hub – Morgan']]]), JSON.stringify(cols));
  check('Pets: a Problem (not named Hub…), with its prefix', same((await gRows(page, 'goptional')).map((r) => [r.label, r.chip, r.lines]),
    [['Pets titles start "Dogs:"', 'Problem', ['In Google: Dog walks', NAME_RULE, ]], ['House', 'Not connected', []]]), JSON.stringify(await gRows(page, 'goptional')));
  reads = await gRows(page, 'greads');
  check('calendars to read: the main one and Jordan\'s school calendar (Test, Disconnect)', same(reads.map((r) => [r.label, r.chip, r.buttons]),
    [["Family account's main calendar", 'Connected', ['Set', 'Test', 'Disconnect']], ['School Jordan Example', 'Connected', ['Test', 'Disconnect']]]), JSON.stringify(reads));
  check('Problems: the 5 latest failures, newest first: what, which day, which calendar, what went wrong (as stored, said once), when it tries again', same(await gList(page, 'gproblems'), [
    'Piano, Tue Nov 3, on Jordan\'s calendar: Google said 400 badRequest: Bad Request. Trying again at 9:40am.',
    'Soccer, Mon Oct 26, on a calendar that was disconnected: Home Hub can\'t change this calendar. In Google Calendar, share it with ' + ACCOUNT + ' and choose Make changes and see event details. Trying again on Mon Oct 26 at 8:00am.',
    'Dentist, Wed Nov 4, on Jordan\'s calendar: someone keeps changing it in Google; change it in the hub instead (to skip one day, use Skip this day). Trying again on Tue Oct 27 at 6:00am.']),
    JSON.stringify(await gList(page, 'gproblems')));
  check('Changed in Google and put back: newest first', same(await gList(page, 'grepairs'), [
    'Piano, Thu Nov 5, Jordan\'s calendar: deleted in Google, put back 8:12am.', 'Swim, Wed Oct 28, Jordan\'s calendar: changed in Google, put back 7:05am.']), JSON.stringify(await gList(page, 'grepairs')));
  check('Projects with stale dates: on the calendar and under way, with a link to the project', same(await gList(page, 'gstale'), ['Kitchen Renovation\'s dates are out of date: open it in Projects.'])
    && (await page.getAttribute('[data-ref="gstale"] a', 'href')) === '#/projects/p-kitchen', JSON.stringify(await gList(page, 'gstale')));
  check('Not on Google: nobody missing; the note for Morgan, who is off the list but still has a calendar', same(await texts(page, '[data-ref="gmissing"] p'),
    ['Morgan is off the family list, so the hub copies nothing to \'Hub – Morgan\'. If Morgan has left: in Google, stop sharing \'Hub – Morgan\' with Morgan\'s own account, then Disconnect it here.']),
    JSON.stringify(await texts(page, '[data-ref="gmissing"] p')));
  check('the problem lists read calendar_links: errors (5 newest) and repairs (5 newest)', log.some((l) => /calendar_links\?select=.*status=eq\.error.*order=failing_since\.desc.*limit=5/.test(decodeURIComponent(l)))
    && log.some((l) => /calendar_links\?select=.*repaired_at=not\.is\.null.*order=repaired_at\.desc.*limit=5/.test(decodeURIComponent(l))), log.filter((l) => /calendar_links/.test(l)).map(decodeURIComponent).join(' | '));
  db.confirm = false;
  await page.click(`[data-gdrop="${db.cal.family.id}"]`);
  await page.waitForTimeout(300);
  check('Disconnect a calendar Home Hub can\'t reach: says the events it put there stay, and how to take them off; No changes nothing',
    (db.confirms.slice(-1)[0] || [])[1] === 'Disconnect Hub – Family? Home Hub can\'t reach that calendar now, so the events it put there stay on it, and on the wall. '
      + 'To take them off, delete that calendar in Google Calendar (or share it with the hub again, wait for it to connect, and then Disconnect).'
    && db.calendars.some((c) => c.id === db.cal.family.id), JSON.stringify(db.confirms.slice(-1)));
  db.confirm = true;
  await page.screenshot({ path: SHOTS + 'settings-google-desktop.png', fullPage: true });
  // Preview from the row: what it would copy, with Start copying; no Test.
  await page.click(`[data-gpreview="${db.cal.alex.id}"]`);
  await page.waitForTimeout(400);
  check('Preview: the dialog without a Test; nothing to copy yet; Start copying', (await dlgText(page, '[data-ref="test"]')) === '' && (await dlgText(page, '[data-ref="pv"]')) === 'Nothing to copy from yesterday to 60 days ahead.'
    && same(await texts(page, '#formDialog .form-actions button'), ['Not now', 'Start copying']) && !jobs(db, 'calendar_test').length);
  await page.click('#formDialog .form-actions [data-close]');
  // Sync now when it can't run, and when it fails.
  db.syncReply = { ok: false, stop: 'busy' };
  await page.click('[data-act="gsync"]');
  await page.waitForTimeout(500);
  check('Sync now while a run is going: says to try again in a minute', (await tc(page, '[data-ref="gsync"]')) === 'A sync is running already. Try again in a minute.');
  db.syncReply = { __status: 500, body: { ok: false, stop: 'auth', error: 'Google refused the key. Make a new key (README, step A.4) and replace GOOGLE_SA_JSON in Supabase.' } };
  await page.click('[data-act="gsync"]');
  await page.waitForTimeout(500);
  check('Sync now that fails: hub-jobs\' reason, in red', (await tc(page, '[data-ref="gsync"]')) === 'Google refused the key. Make a new key (README, step A.4) and replace GOOGLE_SA_JSON in Supabase.'
    && /is-bad/.test(await page.getAttribute('[data-ref="gsync"]', 'class')));
  db.syncReply = { ok: true, read: 7, stored: 40, inserted: 0, updated: 0, deleted: 2, failed: 1, pending: 0, hiding: 0, stop: 'time' };
  await page.click('[data-act="gsync"]');
  await page.waitForTimeout(500);
  check('Sync now: deletes, a failed item and a run cut short by time', (await tc(page, '[data-ref="gsync"]'))
    === 'Synced: 2 taken off in Google. 7 calendars read. 1 item couldn\'t be copied (see Problems). The rest goes in the next run, within 5 minutes.', await tc(page, '[data-ref="gsync"]'));
  db.syncReply = null;
  await page.context().close();

  // The red lines, paused, and a job that has stopped running.
  const variants = [
    ['auth', { auth: null, account: null, key_id: null, last_stop: 'auth', last_error: 'Google refused the key. Make a new key (README, step A.4) and replace GOOGLE_SA_JSON in Supabase.' },
      'Google refused the key. Make a new key (README, step A.4) and replace GOOGLE_SA_JSON in Supabase.'],
    ['config', { auth: null, account: null, key_id: null, last_stop: 'config', last_error: 'GOOGLE_SA_JSON isn\'t a service-account key: paste the whole downloaded file' },
      'GOOGLE_SA_JSON isn\'t a service-account key: paste the whole downloaded file. Fix it, then press Sync now.'],
  ];
  for (const [what, sync, line] of variants) {
    const vdb = richDb();
    Object.assign(vdb.calendar_sync[0], sync);
    ({ page } = await open({ label: `google-${what}`, db: vdb, rpc: v3Rpc }));
    check(`the last run stopped (${what}): its message and the fix, in red, first`, (await tc(page, '[data-ref="gstatus"] .set-gstop')) === line
      && (await gStatus(page))[0] === line && !(await gStatus(page)).some((l) => /^Signed in/.test(l)), JSON.stringify(await gStatus(page)));
    await page.context().close();
  }
  let vdb = richDb();
  Object.assign(vdb.calendar_sync[0], { paused_until: at('09:40') });
  ({ page } = await open({ label: 'google-paused', db: vdb, rpc: v3Rpc }));
  check('paused by Google: until when, instead of copying', same((await gStatus(page)).slice(2), ['Paused by Google until 9:40am']), JSON.stringify(await gStatus(page)));
  await page.context().close();
  vdb = richDb();
  Object.assign(vdb.calendar_sync[0], { last_run_at: at('07:00'), last_ok_at: at('07:00'), last_result: {} });
  ({ page } = await open({ label: 'google-stale', db: vdb, rpc: v3Rpc }));
  check('the job hasn\'t run for over 30 minutes: says cron.sql may need running again', (await gStatus(page)).includes('Last synced today at 7:00am · 4 events')
    && (await tc(page, '.set-gwarn')) === 'Last synced more than 30 minutes ago. The calendar job may not be scheduled: run supabase/cron.sql again (README).', JSON.stringify(await gStatus(page)));
  await page.context().close();

  // ---------- A member (Sam): the same card, read-only
  ({ page, db, log } = await open({ label: 'google-member', email: 'sam@example.com', db: richDb(), rpc: v3Rpc }));
  check('member: the status and the last sync, without Copy or the count', same(await gStatus(page), [`Signed in as ${ACCOUNT} · key …a1b2c3`, 'Last synced 3 minutes ago',
    'Hiding 3 items in Google…', 'Copying 211 items to Google…']), JSON.stringify(await gStatus(page)));
  cols = await gRows(page, 'gcolumns');
  check('member: which calendars are connected, no buttons', same(cols.map((r) => [r.label, r.chip, r.buttons.length, r.name]), [['Alex', 'Waiting: press Preview, then Start copying', 0, null],
    ['Sam', 'Not checked yet', 0, null], ['Jordan', 'Connected', 0, null], ['Family', 'Can\'t reach it', 0, null], ['Morgan off the family list', 'Connected', 0, null]]), JSON.stringify(cols));
  check('member: no buttons, fields, problems, put back, stale projects or Not on Google; calendar_links never asked',
    !(await page.$$('[data-ref="calendar"] button, [data-ref="calendar"] input, [data-ref="calendar"] select')).length
    && !(await page.$('[data-ref="gproblems"], [data-ref="grepairs"], [data-ref="gstale"], [data-ref="gmissing"]')) && !log.some((l) => /calendar_links/.test(l))
    && same(await texts(page, '.set-hearth li').then((x) => x.length), 5));
  await page.context().close();

  // ---------- Schema 4 (v1.2): dinners on Hub – Family come from the Food page (docs/v1.2-kitchen.md §6.3)
  const mealDb = withFood(richDb());
  Object.assign(mealDb.cal.family, { status: 'ok', access_role: 'writer', status_detail: null });
  mealDb.previewRows = { [mealDb.cal.family.google_id]: [
    { day: '2026-10-25', title: 'Dinner: Tacos (Sam)', private: false, item_kind: 'meal', item_id: 'meal-tacos', details: 'Sam cooks' },
    { day: '2026-10-26', title: 'Dinner: Private item', private: true, item_kind: 'meal', item_id: 'meal-surprise' },
    { day: '2026-10-26', title: 'Book club', private: false, item_kind: 'event', item_id: 'ev-book' },
  ] };
  ({ page } = await open({ label: 'google-meals', db: mealDb, rpc: Object.assign({}, v3Rpc, { hub_schema_version: () => 4 }) }));
  await page.click(`[data-gpreview="${mealDb.cal.family.id}"]`);
  await page.waitForTimeout(400);
  const MEAL_HINT = 'Dinners come from the Food page. Lock a dinner there to keep its title off the wall, or turn off \'Dinners on the kitchen wall\'.';
  const mealRows = await page.$$eval('#formDialog [data-ref="pv"] > li.set-pv-row', (lis) => lis.map((li) => [li.querySelector('.set-pv-title').textContent,
    (li.querySelector('.set-pv-hint') || {}).textContent || null, !!li.querySelector('[data-gprivate]'), !!li.querySelector('.badge')]));
  check('schema 4: a dinner in the preview has no Make private, and says it comes from the Food page (locked or not); an event keeps Make private',
    same(mealRows, [['Dinner: Tacos (Sam)', MEAL_HINT, false, false], ['Dinner: Private item', MEAL_HINT, false, true], ['Book club', null, true, false]]), JSON.stringify(mealRows));
  await page.screenshot({ path: SHOTS + 'settings-google-preview-meals.png' });
  await page.context().close();

  // ---------- Phones and desktops, light and dark
  for (const scheme of ['light', 'dark']) {
    ({ page, db } = await open({ label: `google-phone-${scheme}`, db: richDb(), rpc: v3Rpc, ctx: Object.assign({ colorScheme: scheme }, phone) }));
    check(`google (phone, ${scheme}): no sideways scroll`, await noSideScroll(page));
    const small = await page.$$eval('[data-ref="calendar"] .btn, [data-ref="calendar"] .set-gkids, [data-ref="calendar"] summary, [data-ref="calendar"] a',
      (es) => es.filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return [e.textContent.trim().slice(0, 24), Math.round(r.width), Math.round(r.height)]; })
        .filter(([, w, h]) => w < 44 || h < 44));
    check(`google (phone, ${scheme}): every button, switch and link is at least 44px`, !small.length, JSON.stringify(small));
    check(`google (phone, ${scheme}): the card fits the screen`, await page.$eval('section[aria-labelledby="setCalendar"]', (c) => c.getBoundingClientRect().right <= window.innerWidth));
    const stale = await page.$eval('[data-ref="gstale"] a', (a) => ({ display: getComputedStyle(a).display, lines: Math.round(a.getBoundingClientRect().height / parseFloat(getComputedStyle(a).lineHeight || '20')),
      top: Math.round(a.getBoundingClientRect().top - a.parentElement.getBoundingClientRect().top) }));
    check(`google (phone, ${scheme}): a stale project's link is a block, so the bullet sits on its first line when it wraps`, stale.display === 'block' && stale.top === 0, JSON.stringify(stale));
    await page.$eval('section[aria-labelledby="setCalendar"]', (c) => c.scrollIntoView());
    await page.screenshot({ path: SHOTS + `settings-google-phone-${scheme}.png`, fullPage: true });
    await page.click(`[data-gtest="${db.cal.jordan.id}"]`);
    await page.waitForTimeout(500);
    await page.click(`[data-gpreview="${db.cal.jordan.id}"]`);
    await page.waitForTimeout(500);
    const fit = await page.evaluate(() => {
      const d = document.getElementById('formDialog');
      const small = [...d.querySelectorAll('button')].filter((e) => e.offsetParent).map((e) => [e.textContent.trim().slice(0, 20), Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])
        .filter(([, w, h]) => w < 44 || h < 44);
      return { open: d.open, fits: d.scrollWidth <= d.clientWidth && d.getBoundingClientRect().right <= window.innerWidth, small };
    });
    check(`google (phone, ${scheme}): the preview fits, with 44px buttons`, fit.open && fit.fits && !fit.small.length, JSON.stringify(fit));
    await page.screenshot({ path: SHOTS + `settings-google-preview-phone-${scheme}.png` });
    await page.context().close();
    ({ page } = await open({ label: `google-desktop-${scheme}`, db: richDb(), rpc: v3Rpc, ctx: { colorScheme: scheme, viewport: { width: 1280, height: 900 } } }));
    check(`google (1280px, ${scheme}): no sideways scroll`, await noSideScroll(page));
    const chip = await page.$eval('[data-ref="gcolumns"] .set-chip.is-ok', (e) => getComputedStyle(e).backgroundColor);
    check(`google (1280px, ${scheme}): the Connected chip uses the theme's colour`, chip === (scheme === 'dark' ? 'rgb(29, 46, 40)' : 'rgb(226, 238, 233)'), chip);
    await page.screenshot({ path: SHOTS + `settings-google-desktop-${scheme}.png`, fullPage: true });
    await page.context().close();
  }

  // =====================================================================
  // 7. v1 mode: no Settings page
  // =====================================================================
  ({ page } = await open({ label: 'v1', v1: true, path: '/#/settings' }));
  const v1tabs = await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent));
  check('v1: no Settings tab; #/settings shows the v1 Home page', same(v1tabs, ['Home', 'Projects', 'Contractors', 'Family']) && !(await page.$('.set-head')), v1tabs.join(','));
  await page.context().close();

  await browser.close();
  await server.close();
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
