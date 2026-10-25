// Browser tests for the v2 Settings page (assets/modules/settings.js): the household (time zone from
// the migration's list with friendly names, the usual morning-email time, who new pet and house tasks
// go to), days off (single days and ranges, sorted and grouped, remove, past ones tucked away), the
// morning email's status from hub-jobs ("Last run …, N sent", or "Not set up yet" on any failure),
// "Preview my morning email" (subject and text), Google Calendar & Hearth, the Home Screen steps,
// Sign out, members seeing it read-only, phones (390px), dark mode and v1 mode.
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
const { makeDb, install, signIn } = require('./mock');
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

// ---- Stub v2 pages (the other builders' pages): same register() contract as the real ones
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true } },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true } },
  directory: { nav: { label: 'Directory', order: 50 } },
};
const stubModule = (name, s) => `;(function () {
  HomeHub.register({
    name: ${JSON.stringify(name)}, schema: { min: 2, max: 2 }, nav: ${JSON.stringify(s.nav)},
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
    await install(page, db, log, { rpc: opts.v1 ? {} : v2Rpc });
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
  check('Google Calendar & Hearth: one row, not connected yet, no fields', (await tc(page, '[data-ref="calendar"]')) === 'Not connected yet — coming next'
    && (await page.$$('[data-ref="calendar"] input, [data-ref="calendar"] select, [data-ref="calendar"] button')).length === 0);
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
