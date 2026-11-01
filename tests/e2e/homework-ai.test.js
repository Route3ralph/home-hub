// Browser tests for the AI planner's parts of the pages (PR B; docs/v1.3-homework.md §6, §9.2, §9.4, §9.5, §14): on the
// Homework page (assets/modules/homework.js and plan.js's editor, a parent signed in) and on Pat's link (day.html?h=,
// plan.js's tutor view). mock.js answers hub-jobs' homework_ai (aiJob: who, the switch, the caps, a run that finishes at the
// page's next request), homework_ai_preview and homework_ai_draft, and Pat's view's ai and preview, from the same rows.
// What is checked, parents: the switches card's AI row (its line about what is sent and kept, Test the AI planner and its
// answer, Words never to send, the switch drawn only after a Working test and refused with no never-send word, this
// month's runs and cost, a link's Can ask the AI); an assignment: What Claude will see open the first time with the
// database's message, folded after a send, open again when the teacher's text changes; Send to Claude under it, with
// exactly { action, kind, assignment_id, request, answers, key }; "Thinking about a plan…" while the run is open and a
// read every 5 seconds; the draft labelled "Suggested by AI (Claude). Check it with Jordan.", its steps, summary, question,
// optional stretch question and note; Use this plan (into the editor, each step marked AI until a person changes it; Save
// keeps source 'ai' and copies the stretch question; a person's step the server put back, with its id, stays typed); Ask again with a chip, a note and his answer (a revise, shown in the
// preview first); Undo and Dismiss (saved in the database, so a reload doesn't bring them back); each stop's words with
// the starter plans still there; a given plan's draft as "Suggested changes"; Sam sees no AI part; nothing before the AI
// is on. The PR B review: a preview that changed after it was drawn is shown again, not sent (on the page, and when
// hub-jobs finds it changed); Ask again waits for the preview while typing; a renamed locked step opens the fold; Use this
// plan keeps a person's step (its id, its own words) when the draft's ids moved and its copy was scrubbed; the switch
// while the AI is on; a dead run in the list; Test's words for a cap, the month and a refusal; a 503 isn't "offline". Pat's link: the same editor with the link's token in the body of hub-jobs' call (never a sign-in), the server's
// preview with his request and answers added, the p_part 'ai' poll, Use this plan and Give Jordan this plan, Dismiss through
// tutor_assignment_by_token's ai, "AI draft ready" under Plans to look at, Spanish words, no AI part while the switch or
// the link's Can ask the AI is off, and only the tutor functions and hub-jobs called. Jordan's My day: a plan made with a
// draft says "Plan by Pat, with AI help", and his link never calls hub-jobs. With the coach view too (0007, schema 7): the
// parents' row for Pat's link has Can ask the AI and Coach view, each saved on its own without changing the other; on
// Pat's link the list has both the AI's "AI draft ready" and the Coach section, the assignment Send to Claude (the AI's
// reads ask for no coach view), and the Coach section is back, read again, on the list.
// Everything is made up: the household, the school's name (North Field School), the teacher, example.com, 555-01xx.
// Run alone with: node tests/e2e/homework-ai.test.js
const fs = require('fs');
const { chromium } = require('playwright');
const { createHash } = require('crypto');
const { makeDb, install, signIn, SUPA, withHomework, homeworkRpc, foodRpc, hwKidRow, tutorLinkRow, assignmentRow, stepRow,
  withHomeworkTokens, homeworkTokenRpc, personDayHomework, tkKidRow, tkLinkRow, tkAssignmentRow, tkStepRow,
  withSchool, schoolRpc, withCoach, coachRpc } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 400)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// FNV-1a over code points (8 hex): the seal hub-jobs checks, of the preview without its request and answers.
const fnv = (t) => { let h = 0x811c9dc5; for (const ch of String(t)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };

// ---- The household (made up): Alex the parent, Sam, Jordan the kid, Taylor the helper; Pat Lee's link.
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-11-05';
const DEVICE = new Date('2026-01-15T05:00:00Z');
const ID = { alex: 'f00d0000-0000-4000-8000-000000000011', sam: 'f00d0000-0000-4000-8000-000000000012', jordan: 'f00d0000-0000-4000-8000-000000000013',
  taylor: 'f00d0000-0000-4000-8000-000000000014', morgan: 'f00d0000-0000-4000-8000-000000000015' };
const SCI = 'a5c10000-0000-4000-8000-000000000001';
const HIST = 'a5c10000-0000-4000-8000-000000000004';
const LINK = 'a1110000-0000-4000-8000-000000000001';
const PAT_TOKEN = 'ab'.repeat(16);
const TEXT = 'Make a poster about one river for North Field School.\nAsk Ms. Rivera or Pat if you are stuck: teacher@example.com, (201) 555-0100.\n<b>Two sources</b> at least.';
const token = (id) => createHash('md5').update(id).digest('hex');
const person = (id, name, role, sort, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color: '#2563eb', language: 'en', day_token: token(id), digest_enabled: false,
  digest_time: null, digest_day: 'today', digest_scope: 'mine', sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);
const at = (day, hm) => {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8), h + (day >= '2026-11-01' ? 5 : 4), m));
  return `${d.toISOString().slice(0, 19)}.123456+00:00`;
};
const ev = (o) => Object.assign({
  id: crypto.randomUUID(), title: 'Homework', notes: null, location: null, start_date: '2026-10-05', end_date: null, start_time: '16:30:00', end_time: '17:15:00',
  ends_next_day: false, responsible_id: ID.jordan, participant_ids: [], contractor_id: null, private: false, repeat: 'weekly', repeat_every: 1,
  repeat_weekdays: [1, 2, 3, 4], repeat_until: null, skip_days_off: true, created_by: 'alex@example.com', updated_by: 'alex@example.com', created_at: T, updated_at: T,
}, o);

// Jordan with homework on and homework time, Pat's link, the science poster with no plan yet (the teacher's text with the
// school's name, a teacher, Pat, an email, a phone and a tag in it), and a history timeline already given.
function parentsDb(o) {
  const opts = o || {};
  const db = makeDb();
  db.members.push({ email: 'morgan@example.com', name: 'Morgan Example', role: 'admin', created_at: T });
  db.people = [
    person(ID.alex, 'Alex Example', 'parent', 1, { email: 'alex@example.com', email_verified_at: T }),
    person(ID.morgan, 'Morgan Example', 'parent', 2, { email: 'morgan@example.com' }),
    person(ID.sam, 'Sam Example', 'adult', 3, { email: 'sam@example.com' }),
    person(ID.jordan, 'Jordan Example', 'kid', 4),
    person(ID.taylor, 'Taylor Example', 'helper', 5, { language: 'es' }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '15:10:00', tz: 'America/New_York' };
  withHomework(db);
  Object.assign(db.household[0], { homework_ai: !!opts.on, homework_never_send: opts.on ? ['North Field School'] : [] });
  db.homework_kids.push(hwKidRow({ kid_id: ID.jordan, focus_minutes: 20, updated_at: T }));
  const hw = ev({});
  db.events.push(hw);
  db.homework_times.push({ event_id: hw.id, kid_id: ID.jordan });
  db.tutor_links.push(tutorLinkRow({ id: LINK, kid_id: ID.jordan, token: PAT_TOKEN, expires_on: '2027-04-30', can_ai: opts.canAi !== false }));
  db.assignments.push(assignmentRow({ id: SCI, kid_id: ID.jordan, title: 'Science project: river poster', subject: 'Science', due_date: '2026-11-13', details: TEXT,
    created_by: 'alex@example.com', created_at: T }));
  const hist = assignmentRow({ id: HIST, kid_id: ID.jordan, title: 'History timeline', subject: 'History', due_date: '2026-11-12', created_by: 'alex@example.com',
    given_at: at('2026-11-02', '17:00'), given_by: 'alex@example.com', plan_rev: 2, created_at: T });
  db.assignments.push(hist);
  db.homework_steps.push(
    stepRow({ assignment_id: HIST, pos: 1, kind: 'start', title: 'List the dates you need', done_looks_like: 'a list of dates', minutes: 10, day: '2026-11-09', source: 'template' }),
    stepRow({ assignment_id: HIST, pos: 2, kind: 'step', title: 'Draw the timeline', done_looks_like: 'the line drawn', minutes: 20, day: '2026-11-10', source: 'typed' }),
    stepRow({ assignment_id: HIST, pos: 3, kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: '2026-11-12', source: 'template' }));
  if (opts.tested) {
    db.ai_runs.push({ id: crypto.randomUUID(), kid_id: null, assignment_id: null, link_id: null, kind: 'test', asked_by: 'alex@example.com', key: crypto.randomUUID(),
      status: 'ready', stop: null, model: 'claude-opus-5-5', started_at: at('2026-11-04', '20:00'), lease_until: at('2026-11-04', '20:06'), finished_at: at('2026-11-04', '20:00'),
      input_tokens: 2600, cache_read_tokens: 0, cache_write_tokens: 1600, output_tokens: 2200, cents: 3.1 });
  }
  return db;
}

const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true }, provides: 'openEventForm' },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true } },
  food: { nav: { label: 'Food', order: 35, primary: true }, min: 4 },
  directory: { nav: { label: 'Directory', order: 50 } },
  people: { nav: { label: 'Family', order: 60 } },
  settings: { nav: { label: 'Settings', order: 70 } },
};
const stubModule = (name, s) => `;(function () {
  var provides = {};
  ${s.provides ? `provides[${JSON.stringify(s.provides)}] = function () {};` : ''}
  HomeHub.register({ name: ${JSON.stringify(name)}, schema: { min: ${s.min || 2}, max: 99 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return parts[0] === ${JSON.stringify(name)}${s.root ? ' || !parts.length' : ''} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1>'; }, provides: provides });
})();`;
const RPC = Object.assign({ hub_schema_version: () => 5, clock: (db) => Object.assign({}, db.clock), mark_signed_in: () => null }, foodRpc, homeworkRpc);
const emailOf = (req) => {
  const tok = (req.headers()['authorization'] || '').replace(/^Bearer\s+/i, '');
  try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email || null; } catch (e) { return null; }
};

// ---- Pat's and Jordan's side: the token functions, answered by mock.js's homeworkTokenRpc.
const TNOW = '2026-11-02T21:31:04.512Z';
const TDEVICE = new Date('2026-11-03T22:07:00Z');
const PAT = 'abcdef0123456789abcdef0123456789';
const JORDAN = 'fedcba9876543210fedcba9876543210';
const hid = (n) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = { alex: 'p-alex', jordan: 'p-jordan', morgan: 'p-morgan' };
const tat = (iso) => `${iso}.000000+00:00`;
function tutorDb(o) {
  const opts = o || {};
  const db = makeDb();
  db.calls = [];
  db.household = [{ id: true, tz: 'America/New_York', homework_ai: opts.on !== false, homework_never_send: ['North Field School'] }];
  db.people = [
    { id: P.alex, name: 'Alex Example', role: 'admin', language: 'en', email: 'alex@example.com', day_token: null, active: true },
    { id: P.jordan, name: 'Jordan Example', role: 'kid', language: 'en', email: null, day_token: JORDAN, active: true },
    { id: P.morgan, name: 'Morgan Example', role: 'admin', language: 'en', email: 'morgan@example.com', day_token: null, active: true },
  ];
  withHomeworkTokens(db, { now: TNOW });
  db.homework_kids.push(tkKidRow({ kid_id: P.jordan, focus_minutes: 20 }));
  db.hwTimes[P.jordan] = [{ weekdays: [1, 2, 3, 4], starts: '16:30', ends: '17:15' }];
  db.tutor_links.push(tkLinkRow({ id: hid(1), kid_id: P.jordan, token: PAT, language: opts.lang || 'en', can_ai: opts.canAi !== false }));
  db.assignments.push(tkAssignmentRow({ id: hid(10), kid_id: P.jordan, title: 'Science project: river poster', subject: 'Science', due_date: '2026-11-13', added_by: 'tutor',
    details: TEXT, created_at: tat('2026-11-01T15:00:00') }));
  db.assignments.push(tkAssignmentRow({ id: hid(20), kid_id: P.jordan, kind: 'lesson', title: 'Fractions practice', subject: 'Math', due_date: '2026-11-06',
    created_at: tat('2026-11-01T16:00:00'), ai_state: 'ready', ai_at: tat('2026-11-02T20:00:00'),
    ai_draft: { steps: [{ ref: 'new', id: null, kind: 'start', title: 'List what is unclear', done_looks_like: 'a short list', minutes: 10, day: '2026-11-03', source: 'ai' },
      { ref: 'new', id: null, kind: 'milestone', title: 'Do practice set 1', done_looks_like: 'set 1 done', minutes: 20, day: '2026-11-04', source: 'ai' }],
    summary: 'Practice fractions.', questions: [], stretch: null, fits: true, over: 0, horizon: null, no_time: false, note_for_adult: null, model: 'claude-opus-5-5', at: tat('2026-11-02T20:00:00') } }));
  if (opts.given) {
    db.assignments.push(tkAssignmentRow({ id: hid(30), kid_id: P.jordan, title: 'Book report', subject: 'English', due_date: '2026-11-12', given_at: tat('2026-11-01T18:00:00'),
      given_by: 'Pat Lee, tutor (tutor link)', plan_rev: 2, created_at: tat('2026-11-01T17:00:00') }));
    db.homework_steps.push(tkStepRow({ id: hid(31), assignment_id: hid(30), pos: 1, kind: 'start', title: 'Pick the book', done_looks_like: 'a title in your notes', minutes: 10, day: '2026-11-02', source: 'ai' }),
      tkStepRow({ id: hid(32), assignment_id: hid(30), pos: 2, kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: '2026-11-12', source: 'template' }));
  }
  return db;
}
const FAKES = Object.assign({}, homeworkTokenRpc, {
  // Jordan's day (nothing on it but his homework card); Pat's token opens no day.
  get_person_day: (db, b) => {
    const p = (db.people || []).find((x) => x.day_token === b.p_token);
    if (!p) return null;
    const out = { person: { name: p.name, language: p.language, digest_enabled: false, email_confirmed: false }, today: '2026-11-02',
      days: [{ day: '2026-11-02', items: [] }, { day: '2026-11-03', items: [] }], late: [] };
    return personDayHomework(db, p, out);
  },
});
async function tokenRpcs(page, db) {
  await page.route((url) => url.host === 'test.supabase.co' && url.pathname.startsWith('/rest/v1/rpc/'), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.slice('/rest/v1/rpc/'.length);
    const body = JSON.parse(req.postData() || '{}');
    db.calls.push({ name, body, auth: req.headers()['authorization'] || '' });
    if (!FAKES[name]) return route.fallback();
    const out = FAKES[name](db, body);
    return route.fulfill({ status: out && out.__status ? out.__status : 200, headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify(out && out.__status ? out.body : out === undefined ? null : out) });
  });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];

  async function until(page, fn, ms = 4000, arg) {
    const end = Date.now() + ms;
    for (;;) {
      if (await page.evaluate(fn, arg).catch(() => false)) return true;
      if (Date.now() > end) return false;
      await sleep(40);
    }
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const toasts = (page) => page.$$eval('.toasts .toast', (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const calls = (db, name) => (db.rpcCalls || []).filter((c) => c.name === name);
  const aiCalls = (db) => (db.functionCalls || []).filter((c) => c.path === '/functions/v1/hub-jobs' && c.body && c.body.action === 'homework_ai');
  const settle = (page) => until(page, () => !document.querySelector('#main [aria-busy="true"], .plan-editor[aria-busy="true"]')).then(() => sleep(250));
  // A run is open on the page: "Thinking about a plan…" (or in Spanish), so its 5-second read is set.
  const thinking = (page) => until(page, () => /Thinking about a plan|Pensando un plan/.test((document.querySelector('.plan-ai-status') || {}).textContent || ''), 4000);

  // A parent's page (signed in as opts.email, Alex by default) on opts.path.
  async function open(opts = {}) {
    const db = opts.db || parentsDb();
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles' }, opts.ctx));
    await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    await page.clock.install({ time: DEVICE });
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !(opts.allowConsole && opts.allowConsole.test(m.text()))) errors.push(`${opts.label} console: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    const log = [];
    await install(page, db, log, { rpc: opts.rpc || RPC });
    await page.route(`${SUPA}/rest/v1/rpc/whoami`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const m = db.members.find((x) => x.email === emailOf(req));
      const p = m && db.people.find((x) => x.email === m.email);
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify(m ? Object.assign({}, m, { person: p ? { id: p.id, name: p.name, role: p.role, language: p.language, color: p.color } : null }) : null) });
    });
    db.writes = [];
    await page.route((url) => url.host === 'test.supabase.co' && /^\/rest\/v1\/(assignments|household|tutor_links)$/.test(url.pathname), (route) => {
      const req = route.request();
      if (['PATCH', 'POST', 'DELETE'].includes(req.method())) {
        const url = new URL(req.url());
        db.writes.push({ table: url.pathname.split('/').pop(), method: req.method(), body: JSON.parse(req.postData() || 'null') });
      }
      return route.fallback();
    });
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: stubModule(name, s) }));
    }
    await page.goto(BASE + (opts.path || '/#/homework'));
    await until(page, () => !!document.querySelector('.hw-head, .hw-a'), 6000);
    await until(page, () => !document.querySelector('#main .loading'), 4000);
    await sleep(300);
    return { page, db, log, context };
  }

  // =====================================================================
  // 1. The switches card while the AI is off and never tested
  // =====================================================================
  // The refused switch (no word never to send) is a 400 from the database: the browser logs that one.
  let { page, db, context } = await open({ label: 'off', allowConsole: /status of 400/ });
  const row = '[data-row="ai"]';
  const line = await text(page, `${row} .hw-switch-line`);
  check('the AI row: what is sent, to whom, and what is kept, in one line (§9.2)', /When on, the tutor and the parents can send an assignment \(its title, class, dates and text\), Jordan's free minutes per day/.test(line)
    && /with the names Home Hub knows taken out, to Anthropic \(Claude\) to draft a plan\. What Claude will see shows exactly what goes\. Anthropic doesn't train on it\. It may keep it up to 30 days, or up to 2 years if its safety checks flag it\. About 6 cents a plan; never more than the \$15 monthly limit\./.test(line), line);
  check('... "AI planner: off", Test the AI planner and Words never to send; no switch before a Working test',
    /AI planner: off/.test(await text(page, row)) && !!(await page.$(`${row} [data-act="ai-test"]`)) && !!(await page.$(`${row} form[data-form="never"]`))
    && !(await page.$(`${row} input[data-act="ai-on"]`)), await text(page, row));
  check('... Pat\'s link has "Can ask the AI" (on)', (await page.$eval(`[data-link="${LINK}"] input[data-act="link-ai"]`, (i) => i.checked).catch(() => null)) === true);
  await page.click(`[data-link="${LINK}"] input[data-act="link-ai"]`);
  await settle(page);
  const can = calls(db, 'save_tutor_link').slice(-1)[0];
  check('Can ask the AI off: save_tutor_link with p_can_ai false, the rest as it is', !!can && can.body.p_can_ai === false && can.body.p_link === LINK && can.body.p_active === true
    && db.tutor_links[0].can_ai === false, can && JSON.stringify(can.body));
  // The assignment: nothing of the AI while it is off.
  await page.evaluate((id) => { location.hash = `#/homework/${id}`; }, SCI);
  await until(page, () => !!document.querySelector('.plan-editor'));
  await sleep(300);
  check('an assignment while the AI is off: no Send to Claude, no preview, no AI words', !(await page.$('[data-act="ai-send"]')) && !(await page.$('.plan-ai-preview'))
    && !/Claude|AI/.test(await text(page, '.plan-editor')) && !calls(db, 'homework_ai_preview').length);
  // Test: a run, read until it ends, then "Working · claude-opus-5-5 · 18 s · about 5 cents"; the switch is drawn after it.
  await page.evaluate(() => { location.hash = '#/homework'; });
  await until(page, () => !!document.querySelector('[data-row="ai"]'));
  await page.click(`${row} [data-act="ai-test"]`);
  await until(page, () => /Working|Testing/.test(document.querySelector('[data-row="ai"]').textContent), 3000);
  await page.clock.runFor(3000);
  await until(page, () => /Working ·/.test(document.querySelector('[data-row="ai"]').textContent), 4000);
  const tc = aiCalls(db)[0];
  check('Test the AI planner: hub-jobs { action: homework_ai, kind: test, key } with the parent\'s sign-in', !!tc && same(Object.keys(tc.body).sort(), ['action', 'key', 'kind'])
    && tc.body.kind === 'test' && UUID.test(tc.body.key) && tc.email === 'alex@example.com', tc && JSON.stringify(tc));
  check('... "Working · claude-opus-5-5 · 18 s · about 5 cents"', /Working · claude-opus-5-5 · 18 s · about 5 cents/.test(await text(page, `${row} .hw-ai-test`)), await text(page, `${row} .hw-ai-test`));
  check('... and now the switch is drawn (off)', (await page.$eval(`${row} input[data-act="ai-on"]`, (i) => i.checked).catch(() => null)) === false);
  check('... the month line counts it: "AI planner this month: 1 run, about $0.05 (estimate) · 1 of 12 today"',
    /AI planner this month: 1 run, about \$0\.05 \(estimate\) · 1 of 12 today/.test(await text(page, `${row} .hw-ai-month`)), await text(page, `${row} .hw-ai-month`));
  // On with no word never to send: the database refuses it, with its words.
  await page.click(`${row} input[data-act="ai-on"]`);
  await until(page, () => document.querySelectorAll('.toasts .toast').length > 0, 3000);
  check('turning it on with no word never to send: refused ("Add the school\'s name to Words never to send first.")',
    (await toasts(page)).some((x) => /Add the school's name to Words never to send first\./.test(x)) && db.household[0].homework_ai === false, JSON.stringify(await toasts(page)));
  await page.fill(`${row} form[data-form="never"] input[name="word"]`, 'North Field School');
  await page.click(`${row} form[data-form="never"] button[type="submit"]`);
  await settle(page);
  const hw = db.writes.filter((x) => x.table === 'household');
  check('Words never to send: "North Field School" added (household.homework_never_send)', same(db.household[0].homework_never_send, ['North Field School'])
    && hw.some((x) => same(x.body, { homework_never_send: ['North Field School'] })) && /North Field School/.test(await text(page, `${row} .hw-never`)), JSON.stringify(hw));
  await page.fill(`${row} form[data-form="never"] input[name="word"]`, 'x');
  await page.click(`${row} form[data-form="never"] button[type="submit"]`);
  await sleep(300);
  check('... a word of 1 character is refused on the page ("2 to 40 characters")', /2 to 40 characters/.test(await text(page, `${row} form[data-form="never"] .form-error`)) && db.household[0].homework_never_send.length === 1);
  await page.click(`${row} input[data-act="ai-on"]`);
  await settle(page);
  check('... then on: household.homework_ai true, "AI planner: on"', db.household[0].homework_ai === true && /AI planner: on/.test(await text(page, row)), await text(page, row));
  await page.screenshot({ path: SHOTS + 'homework-ai-switches.png', fullPage: true });
  await context.close();

  // Test with no key: not_set_up, said on the card.
  ({ page, db, context } = await open({ label: 'not set up', db: Object.assign(parentsDb(), { aiMode: 'not_set_up' }) }));
  await page.click('[data-row="ai"] [data-act="ai-test"]');
  await until(page, () => /not set up/.test(document.querySelector('[data-row="ai"]').textContent), 3000);
  check('Test with no ANTHROPIC_API_KEY: "AI planner: not set up (README → Homework)"', /AI planner: not set up \(README → Homework\)/.test(await text(page, '[data-row="ai"]')), await text(page, '[data-row="ai"]'));
  await context.close();

  // =====================================================================
  // 2. An assignment with the AI on: the preview, Send to Claude, Thinking…, the draft, Use this plan
  // =====================================================================
  ({ page, db, context } = await open({ label: 'on', db: parentsDb({ on: true, tested: true }), path: `/#/homework/${SCI}` }));
  await until(page, () => !!document.querySelector('.plan-ai-preview'), 3000);
  const prev = calls(db, 'homework_ai_preview')[0];
  check('What Claude will see: homework_ai_preview(p_assignment, p_kind plan, no request, no answers)', !!prev
    && same(prev.body, { p_assignment: SCI, p_kind: 'plan', p_request: null, p_answers: null }), prev && JSON.stringify(prev.body));
  const pv = await text(page, '.plan-ai-preview .plan-ai-text');
  check('... open the first time, with the database\'s message as it is (names taken out, brackets replaced)', (await page.$eval('.plan-ai-preview', (d) => d.open)) === true
    && pv.includes('<assignment_title>Science project: river poster</assignment_title>') && /\[name\]/.test(pv) && /‹b›Two sources‹\/b›/.test(pv)
    && /\[email\]/.test(pv) && /\[phone\]/.test(pv) && !/North Field|Rivera|teacher@|555-0100/.test(pv), pv);
  const sendBox = await page.$eval('[data-act="ai-send"]', (b) => b.closest('.plan-editor') && b.compareDocumentPosition(document.querySelector('.plan-ai-preview')) & Node.DOCUMENT_POSITION_PRECEDING).catch(() => 0);
  check('Send to Claude is under the preview, beside the starter plans', !!sendBox && !!(await page.$('[data-act="starter"]')) && (await text(page, '[data-act="ai-send"]')) === 'Send to Claude');
  await page.click('[data-act="ai-send"]');
  await until(page, () => /Thinking about a plan/.test(document.querySelector('.plan-editor').textContent), 3000);
  const send = aiCalls(db)[0];
  const rawPv = await page.$eval('.plan-ai-preview .plan-ai-text', (e) => e.textContent);
  check('Send to Claude: hub-jobs { action, kind: plan, assignment_id, request: null, answers: null, key, shown } with the parent\'s sign-in', !!send
    && same(Object.keys(send.body).sort(), ['action', 'answers', 'assignment_id', 'key', 'kind', 'request', 'shown']) && send.body.kind === 'plan' && send.body.assignment_id === SCI
    && send.body.request === null && send.body.answers === null && UUID.test(send.body.key) && send.email === 'alex@example.com', send && JSON.stringify(send));
  check('... shown is the seal of the preview it showed (FNV-1a of its text: hub-jobs refuses a message that differs)', !!send && send.body.shown === fnv(rawPv), send && send.body.shown);
  check('... "Thinking about a plan… (usually under a minute)", and the editor stays usable', /Thinking about a plan… \(usually under a minute\)/.test(await text(page, '.plan-ai-status'))
    && !(await page.$eval('[data-act="starter"]', (b) => b.disabled)));
  const before = (db.rpcCalls || []).length;
  await page.clock.runFor(5000);
  await until(page, () => !!document.querySelector('.plan-ai-draft'), 6000);
  check('... read again after 5 seconds (one assignments row), and the draft shows', (await page.$('.plan-ai-draft')) !== null, (db.rpcCalls || []).length - before);
  check('the draft: "Draft · Suggested by AI (Claude). Check it with Jordan."', /Draft · Suggested by AI \(Claude\)\. Check it with Jordan\./.test(await text(page, '.plan-ai-label')), await text(page, '.plan-ai-label'));
  const dsteps = await texts(page, '.plan-ai-steps li');
  check('... its steps (day, title, minutes, kind)', dsteps.length === 5 && /Copy the requirements into your notes/.test(dsteps[0]) && /turn in/i.test(dsteps[4]), JSON.stringify(dsteps));
  check('... its summary, its question with a box for his answer, and the optional stretch question', /Make a poster about one river with two sources\./.test(await text(page, '.plan-ai-draft'))
    && /Did your teacher say which materials are allowed\?/.test(await text(page, '.plan-ai-q')) && !!(await page.$('.plan-ai-q input[name="ai-answer"]'))
    && /Optional: Which part of the river would you most like to show in detail\?/.test(await text(page, '.plan-ai-stretch')), await text(page, '.plan-ai-draft'));
  check('... Use this plan, Dismiss (no Undo: there is no earlier draft)', !!(await page.$('[data-act="ai-use"]')) && !!(await page.$('[data-act="ai-dismiss"]')) && !(await page.$('[data-act="ai-undo"]')));
  check('after a send, the preview is folded (what would be sent is what was sent)', (await page.$eval('.plan-ai-preview', (d) => d.open).catch(() => null)) === false);
  await page.screenshot({ path: SHOTS + 'homework-ai-draft.png', fullPage: true });
  await page.click('[data-act="ai-use"]');
  await sleep(300);
  const rows = await texts(page, '.plan-steps .plan-step');
  check('Use this plan: the draft\'s steps in the editor, nothing saved yet, each marked AI', rows.length === 5 && /Copy the requirements/.test(rows[0])
    && (await page.$$('.plan-steps .plan-step .plan-ai-mark')).length === 5 && !calls(db, 'save_homework_plan').length && !(await page.$eval('[data-act="save"]', (b) => b.disabled)), JSON.stringify(rows));
  // A person changes one step: its AI mark goes, and it is saved as typed (locked for the next revision).
  await page.click('.plan-steps .plan-step[data-i="1"] [data-act="more"]');
  await page.fill('.plan-step-edit input[name="title"]', 'Find 3 sources and save their titles');
  await page.click('.plan-step-edit [data-act="close"]');
  await sleep(200);
  check('... a step a person changed loses its AI mark', (await page.$$('.plan-steps .plan-step .plan-ai-mark')).length === 4);
  await page.click('[data-act="give"]');
  await settle(page);
  const sv = calls(db, 'save_homework_plan').slice(-1)[0];
  check('Give Jordan this plan: save_homework_plan with the draft\'s steps, source ai, the changed one typed, p_give true', !!sv && sv.body.p_give === true
    && same(sv.body.p_steps.map((x) => x.source), ['ai', 'typed', 'ai', 'ai', 'ai']) && sv.body.p_steps[1].title === 'Find 3 sources and save their titles', sv && JSON.stringify(sv.body.p_steps.map((x) => [x.source, x.title])));
  await sleep(400);
  const st = db.writes.filter((x) => x.table === 'assignments' && x.method === 'PATCH' && x.body && 'stretch' in x.body);
  check('... and copies the draft\'s stretch question to the assignment', st.length === 1 && st[0].body.stretch === 'Which part of the river would you most like to show in detail?'
    && db.assignments.find((a) => a.id === SCI).stretch === 'Which part of the river would you most like to show in detail?', JSON.stringify(st));
  // A given plan: the draft is "Suggested changes"; Ask again with a chip, a note and his answer.
  await page.reload();
  await until(page, () => !!document.querySelector('.plan-editor'), 4000);
  await until(page, () => !!document.querySelector('.plan-ai-draft'), 3000);
  check('a plan already given: the draft is "Suggested changes · Suggested by AI (Claude)…"', /Suggested changes · Suggested by AI \(Claude\)\. Check it with Jordan\./.test(await text(page, '.plan-ai-label')), await text(page, '.plan-ai-label'));
  await page.click('.plan-ai-ask [data-ai-chip="smaller"]');
  await page.fill('.plan-ai-ask input[name="ai-note"]', 'Nothing on Friday');
  await page.fill('.plan-ai-q input[name="ai-answer"]', 'Markers only');
  await page.clock.runFor(800);
  await until(page, () => /Smaller steps/.test((document.querySelector('.plan-ai-preview .plan-ai-text') || {}).textContent || ''), 3000);
  const lastPrev = calls(db, 'homework_ai_preview').slice(-1)[0];
  check('Ask again: the preview shows the request and his answer first (a revise), open again', !!lastPrev && lastPrev.body.p_kind === 'revise'
    && lastPrev.body.p_request === 'Smaller steps. Nothing on Friday' && same(lastPrev.body.p_answers, ['Markers only'])
    && (await page.$eval('.plan-ai-preview', (d) => d.open)) === true && /<request from="parent">Smaller steps\. Nothing on Friday<\/request>/.test(await text(page, '.plan-ai-text')),
  lastPrev && JSON.stringify(lastPrev.body));
  await page.click('[data-act="ai-again"]');
  await sleep(500);
  const again = aiCalls(db)[1];
  check('... hub-jobs { kind: revise, request, answers }', !!again && again.body.kind === 'revise' && again.body.request === 'Smaller steps. Nothing on Friday'
    && same(again.body.answers, ['Markers only']) && again.body.assignment_id === SCI, again && JSON.stringify(again.body));
  await thinking(page);   // the 5-second read is set once hub-jobs answered
  await page.clock.runFor(5000);
  await until(page, () => !!document.querySelector('[data-act="ai-undo"]'), 4000);
  check('a second draft: Undo puts the first back', !!(await page.$('[data-act="ai-undo"]')));
  await page.click('[data-act="ai-undo"]');
  await settle(page);
  check('Undo: homework_ai_draft(p_assignment, undo), saved in the database', same((calls(db, 'homework_ai_draft').slice(-1)[0] || {}).body, { p_assignment: SCI, p_action: 'undo' })
    && !db.assignments.find((a) => a.id === SCI).ai_prev);
  await page.click('[data-act="ai-dismiss"]');
  await settle(page);
  check('Dismiss: homework_ai_draft(p_assignment, dismiss); the draft goes', same((calls(db, 'homework_ai_draft').slice(-1)[0] || {}).body, { p_assignment: SCI, p_action: 'dismiss' })
    && !(await page.$('.plan-ai-draft')) && !db.assignments.find((a) => a.id === SCI).ai_draft);
  await page.reload();
  await until(page, () => !!document.querySelector('.plan-editor'), 4000);
  await sleep(400);
  check('... and a reload doesn\'t bring it back', !(await page.$('.plan-ai-draft')));
  await context.close();

  // The teacher's text changed after a send: the preview is open again.
  ({ page, db, context } = await open({ label: 'changed', db: parentsDb({ on: true, tested: true }), path: `/#/homework/${SCI}` }));
  await until(page, () => !!document.querySelector('.plan-ai-preview'), 3000);
  await page.click('[data-act="ai-send"]');
  await thinking(page);   // the 5-second read is set once hub-jobs answered
  await page.clock.runFor(5000);
  await until(page, () => !!document.querySelector('.plan-ai-draft'), 6000);
  check('folded after the send', (await page.$eval('.plan-ai-preview', (d) => d.open)) === false);
  await page.fill('.hw-afields textarea[name="details"]', `${TEXT}\nUse markers.`);
  await page.click('.hw-afields button[type="submit"]');
  await settle(page);
  await until(page, () => /Use markers/.test((document.querySelector('.plan-ai-text') || {}).textContent || ''), 3000);
  check('the teacher\'s text changed: the preview is open again, with the new text', (await page.$eval('.plan-ai-preview', (d) => d.open)) === true, await text(page, '.plan-ai-text'));
  await context.close();

  // A revision's draft carries a person's typed step back (the server restored it, with its id): Use keeps it typed, so
  // it stays locked the next time the AI is asked.
  {
    const hdb = parentsDb({ on: true, tested: true });
    const typed = hdb.homework_steps.find((x) => x.assignment_id === HIST && x.source === 'typed');
    const h = hdb.assignments.find((a) => a.id === HIST);
    Object.assign(h, { ai_state: 'ready', ai_at: at('2026-11-04', '20:00'), ai_draft: {
      steps: [
        { ref: 'new', id: null, kind: 'start', title: 'List the five dates you need', done_looks_like: 'five dates in your notes', minutes: 10, day: '2026-11-09', source: 'ai' },
        { ref: 's2', id: typed.id, kind: 'step', title: 'Draw the timeline', done_looks_like: 'the line drawn', minutes: 20, day: '2026-11-10', source: 'ai' },
        { ref: 'new', id: null, kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: '2026-11-12', source: 'ai' },
      ],
      summary: 'A timeline of five dates.', questions: [], stretch: null, fits: true, over: 0, horizon: null, no_time: false, note_for_adult: null,
      model: 'claude-opus-5-5', at: at('2026-11-04', '20:00') } });
    ({ page, db, context } = await open({ label: 'typed back', db: hdb, path: `/#/homework/${HIST}` }));
    await until(page, () => !!document.querySelector('[data-act="ai-use"]'), 4000);
    await page.click('[data-act="ai-use"]');
    await sleep(300);
    check('a revision\'s draft with a person\'s step in it: Use marks only the AI\'s own steps AI', (await page.$$('.plan-steps .plan-step .plan-ai-mark')).length === 2,
      await texts(page, '.plan-steps .plan-step'));
    await page.click('[data-act="save"]');
    await settle(page);
    const sv2 = calls(db, 'save_homework_plan').slice(-1)[0];
    check('... and saves that step typed, with its id (still locked for the next revision); the others ai', !!sv2
      && same(sv2.body.p_steps.map((x) => [x.id || null, x.source]), [[null, 'ai'], [typed.id, 'typed'], [null, 'ai']]), sv2 && JSON.stringify(sv2.body.p_steps));
    await context.close();
  }

  // =====================================================================
  // 2b. What goes is what was shown; a person's step comes back as they left it (the PR B review)
  // =====================================================================
  const rawText = (pg) => pg.$eval('.plan-ai-preview .plan-ai-text', (e) => e.textContent).catch(() => '');
  const seal = (t) => fnv(String(t).split('\n<request from="')[0].split('\n<answers>\n')[0]);
  const isOpen = (pg) => pg.$eval('.plan-ai-preview', (d) => d.open).catch(() => null);
  // The teacher's text changes in the database after the preview was drawn (the school feed's update, or Morgan on her
  // phone): the tap reads it again, shows it open, and sends nothing until the next tap.
  ({ page, db, context } = await open({ label: 'stale preview', db: parentsDb({ on: true, tested: true }), path: `/#/homework/${SCI}` }));
  await until(page, () => !!document.querySelector('.plan-ai-preview .plan-ai-text'), 3000);
  await sleep(200);
  db.assignments.find((a) => a.id === SCI).details = `${TEXT}\nWork with the group on Tuesday.`;
  await page.click('[data-act="ai-send"]');
  await until(page, () => /group on Tuesday/.test((document.querySelector('.plan-ai-text') || {}).textContent || ''), 3000);
  await sleep(200);
  check('the message changed after the preview was drawn: the tap shows the new one, open, and sends nothing',
    aiCalls(db).length === 0 && (await isOpen(page)) === true && /What Claude will see has changed\. Read it again above, then send\./.test(await text(page, '.plan-ai-status')),
    [aiCalls(db).length, await isOpen(page), await text(page, '.plan-ai-status')]);
  const shownNow = await rawText(page);
  await page.click('[data-act="ai-send"]');
  await thinking(page);
  const sentNow = aiCalls(db)[0];
  const runNow = db.ai_runs.find((r) => r.kind === 'plan');
  check('... the next tap sends it, sealed with what is shown now', !!sentNow && sentNow.body.shown === fnv(shownNow) && !!runNow && runNow.status === 'running'
    && /group on Tuesday/.test(runNow.message), sentNow && JSON.stringify(sentNow.body));
  await context.close();

  // It changes between the tap's read and hub-jobs: hub-jobs ends the run as changed and sends nothing; the page shows
  // the new message, open.
  ({ page, db, context } = await open({ label: 'changed at hub-jobs', db: parentsDb({ on: true, tested: true }), path: `/#/homework/${SCI}` }));
  await until(page, () => !!document.querySelector('.plan-ai-preview .plan-ai-text'), 3000);
  await sleep(200);
  await page.route(`${SUPA}/functions/v1/hub-jobs`, (route) => {
    if (route.request().method() === 'POST') db.assignments.find((a) => a.id === SCI).details = `${TEXT}\nBring the photos.`;
    return route.fallback();
  });
  await page.click('[data-act="ai-send"]');
  await until(page, () => /Bring the photos/.test((document.querySelector('.plan-ai-text') || {}).textContent || ''), 4000);
  await sleep(200);
  const changedRun = db.ai_runs.find((r) => r.kind === 'plan');
  check('changed between the tap and hub-jobs: the run ends as changed with nothing sent, and the page shows the new message, open',
    aiCalls(db).length === 1 && !!changedRun && changedRun.status === 'failed' && changedRun.stop === 'changed' && !(db.aiPending || []).length
    && (await isOpen(page)) === true && /What Claude will see has changed/.test(await text(page, '.plan-ai-status')) && !(await page.$('.plan-ai-draft')),
    [aiCalls(db).length, changedRun && changedRun.stop, await text(page, '.plan-ai-status')]);
  await context.close();

  // A note typed and Ask again tapped at once: Ask again waits until the preview shows the note.
  {
    const ndb = parentsDb({ on: true, tested: true });
    Object.assign(ndb.assignments.find((a) => a.id === SCI), { ai_state: 'ready', ai_at: at('2026-11-04', '20:00'), ai_draft: {
      steps: [{ ref: 'new', id: null, kind: 'start', title: 'List what is unclear', done_looks_like: 'a short list', minutes: 10, day: '2026-11-09', source: 'ai' },
        { ref: 'new', id: null, kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: '2026-11-13', source: 'ai' }],
      summary: 'A poster.', questions: [], stretch: null, fits: true, over: 0, horizon: null, no_time: false, note_for_adult: null, model: 'claude-opus-5-5', at: at('2026-11-04', '20:00') } });
    ({ page, db, context } = await open({ label: 'note at once', db: ndb, path: `/#/homework/${SCI}` }));
    await until(page, () => !!document.querySelector('.plan-ai-ask') && !!document.querySelector('.plan-ai-text'), 4000);
    await sleep(200);
    await page.fill('.plan-ai-ask input[name="ai-note"]', 'Work on Tuesday');
    const waiting = await page.$eval('[data-act="ai-again"]', (b) => b.disabled);
    await page.evaluate(() => document.querySelector('[data-act="ai-again"]').click());
    await sleep(200);
    check('a note typed and Ask again tapped at once: Ask again waits (disabled) for the preview with the note; nothing sent', waiting === true && aiCalls(db).length === 0,
      [waiting, aiCalls(db).length]);
    await page.clock.runFor(800);
    await until(page, () => /Work on Tuesday/.test((document.querySelector('.plan-ai-text') || {}).textContent || '') && !document.querySelector('[data-act="ai-again"]').disabled, 3000);
    const withNote = await rawText(page);
    await page.click('[data-act="ai-again"]');
    await thinking(page);
    const r = aiCalls(db)[0];
    check('... then it sends exactly what the preview shows (the note in it), sealed', !!r && r.body.request === 'Work on Tuesday'
      && /<request from="parent">Work on Tuesday<\/request>/.test(withNote) && r.body.shown === seal(withNote) && db.ai_runs.find((x) => x.kind === 'revise').message === withNote,
      r && [r.body.request, r.body.shown, seal(withNote)]);
    await context.close();
  }

  // A locked step renamed after a send (Jordan on My day: his renames are typed): What Claude will see opens again.
  ({ page, db, context } = await open({ label: 'renamed step', db: parentsDb({ on: true, tested: true }), path: `/#/homework/${HIST}` }));
  await until(page, () => !!document.querySelector('.plan-ai-preview .plan-ai-text'), 3000);
  await sleep(200);
  await page.click('[data-act="ai-send"]');
  await thinking(page);
  await page.clock.runFor(5000);
  await until(page, () => !!document.querySelector('.plan-ai-draft'), 6000);
  await sleep(300);
  const foldedAfter = await isOpen(page);
  db.homework_steps.find((x) => x.assignment_id === HIST && x.source === 'typed').title = 'Draw the timeline with the class photos';
  await page.reload();
  await until(page, () => /class photos/.test((document.querySelector('.plan-ai-text') || {}).textContent || ''), 4000);
  await sleep(200);
  check('a locked step renamed after a send: What Claude will see opens again (folded before the rename)', foldedAfter === false && (await isOpen(page)) === true,
    [foldedAfter, await isOpen(page)]);
  await context.close();

  // Use this plan when the database's step ids moved under the draft (Jordan ticked a step while it ran) and the draft
  // holds the scrubbed copy of a person's step: each person's step comes back with its own id and its own words.
  {
    const udb = parentsDb({ on: true, tested: true });
    const A = 'a5c10000-0000-4000-8000-000000000007';
    udb.assignments.push(assignmentRow({ id: A, kid_id: ID.jordan, title: 'River poster', subject: 'Science', due_date: '2026-11-13', created_by: 'alex@example.com',
      created_at: T, plan_rev: 1 }));
    const OWN = 'Ask Pat for the sheet <2 pages> at example.com/river';
    const st = [
      stepRow({ assignment_id: A, pos: 1, kind: 'start', title: 'Copy the requirements', done_looks_like: 'the list in your notes', minutes: 10, day: '2026-11-05', source: 'typed',
        done_at: at('2026-11-05', '14:40'), done_by: 'Jordan Example (My day)' }),
      stepRow({ assignment_id: A, pos: 2, kind: 'step', title: OWN, done_looks_like: 'the sheet in your folder', minutes: 15, day: '2026-11-09', source: 'typed' }),
      stepRow({ assignment_id: A, pos: 3, kind: 'step', title: 'Glue the pictures on', done_looks_like: 'pictures on the poster', minutes: 20, day: '2026-11-10', source: 'template' }),
      stepRow({ assignment_id: A, pos: 4, kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: '2026-11-13', source: 'typed' }),
    ];
    udb.homework_steps.push(...st);
    // As homework_ai_finish stored it: the refs numbered again after the tick point one step on (s1's copy has s2's id,
    // s2's copy s3's, s4's none), and the locked step's copy is the one the AI was sent.
    Object.assign(udb.assignments.find((a) => a.id === A), { ai_state: 'ready', ai_at: at('2026-11-05', '15:00'), ai_draft: {
      steps: [
        { ref: 's1', id: st[1].id, kind: 'start', title: 'Copy the requirements', done_looks_like: 'the list in your notes', minutes: 10, day: '2026-11-09', source: 'ai' },
        { ref: 's2', id: st[2].id, kind: 'step', title: 'Ask [name] for the sheet ‹2 pages› at [link]', done_looks_like: 'the sheet in your folder', minutes: 15, day: '2026-11-09', source: 'ai' },
        { ref: 'new', id: null, kind: 'step', title: 'Glue three pictures on', done_looks_like: 'three pictures on the poster', minutes: 20, day: '2026-11-10', source: 'ai' },
        { ref: 's4', id: null, kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: '2026-11-13', source: 'ai' },
      ],
      summary: 'A poster.', questions: [], stretch: null, fits: true, over: 0, horizon: null, no_time: false, note_for_adult: null, model: 'claude-opus-5-5', at: at('2026-11-05', '15:00') } });
    ({ page, db, context } = await open({ label: 'use moved ids', db: udb, path: `/#/homework/${A}` }));
    await until(page, () => !!document.querySelector('[data-act="ai-use"]'), 4000);
    await page.click('[data-act="ai-use"]');
    await sleep(300);
    const rowsNow = await texts(page, '.plan-steps .plan-step');
    check('Use this plan: a person\'s step shows in their own words, never the copy the AI was sent', rowsNow.some((x) => x.includes(OWN)) && !rowsNow.some((x) => /\[name\]|\[link\]|‹/.test(x)),
      JSON.stringify(rowsNow));
    await page.click('[data-act="save"]');
    await settle(page);
    const sv = calls(db, 'save_homework_plan').slice(-1)[0];
    check('... Save: the done step as it was, then each person\'s step with its own id, words and source; the AI\'s new step; no step written over another',
      !!sv && same(sv.body.p_steps.map((x) => [x.id || null, x.title, x.source]), [
        [st[0].id, 'Copy the requirements', 'typed'], [st[1].id, OWN, 'typed'], [null, 'Glue three pictures on', 'ai'], [st[3].id, 'Turn it in', 'typed']]),
      sv && JSON.stringify(sv.body.p_steps.map((x) => [x.id, x.title, x.source])));
    await context.close();
  }

  // A person's step renamed while the AI was asked (the draft's copy has the old words), and one added meanwhile (not in
  // the draft at all): Use this plan keeps both as the person left them, with no copy of the old words beside them.
  {
    const rdb = parentsDb({ on: true, tested: true });
    const A = 'a5c10000-0000-4000-8000-000000000008';
    rdb.assignments.push(assignmentRow({ id: A, kid_id: ID.jordan, title: 'Map project', subject: 'History', due_date: '2026-11-13', created_by: 'alex@example.com',
      created_at: T, plan_rev: 2 }));
    const st = [
      stepRow({ assignment_id: A, pos: 1, kind: 'start', title: 'List the countries on the map', done_looks_like: 'a list', minutes: 10, day: '2026-11-09', source: 'template' }),
      stepRow({ assignment_id: A, pos: 2, kind: 'step', title: 'Trace the coastline in pencil', done_looks_like: 'the coast traced', minutes: 20, day: '2026-11-09', source: 'typed' }),
      stepRow({ assignment_id: A, pos: 3, kind: 'step', title: 'Label the five rivers', done_looks_like: 'five labels', minutes: 15, day: '2026-11-10', source: 'typed' }),
      stepRow({ assignment_id: A, pos: 4, kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: '2026-11-13', source: 'template' }),
    ];
    rdb.homework_steps.push(...st);
    Object.assign(rdb.assignments.find((a) => a.id === A), { ai_state: 'ready', ai_at: at('2026-11-05', '15:00'), ai_draft: {
      steps: [
        { ref: 'new', id: null, kind: 'start', title: 'List what the map needs', done_looks_like: 'a short list', minutes: 10, day: '2026-11-09', source: 'ai' },
        { ref: 's2', id: st[1].id, kind: 'step', title: 'Trace the coast', done_looks_like: 'the coast traced', minutes: 20, day: '2026-11-09', source: 'ai' },
        { ref: 'new', id: null, kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: '2026-11-13', source: 'ai' },
      ],
      summary: 'A map.', questions: [], stretch: null, fits: true, over: 0, horizon: null, no_time: false, note_for_adult: null, model: 'claude-opus-5-5', at: at('2026-11-05', '15:00') } });
    ({ page, db, context } = await open({ label: 'use renamed and added', db: rdb, path: `/#/homework/${A}` }));
    await until(page, () => !!document.querySelector('[data-act="ai-use"]'), 4000);
    await page.click('[data-act="ai-use"]');
    await sleep(300);
    await page.click('[data-act="save"]');
    await settle(page);
    const sv = calls(db, 'save_homework_plan').slice(-1)[0];
    check('Use this plan: a step renamed while the AI was asked keeps its new words (its id named it), one added meanwhile stays, before the turn-in',
      !!sv && same(sv.body.p_steps.map((x) => [x.id || null, x.title, x.source]), [
        [null, 'List what the map needs', 'ai'], [st[1].id, 'Trace the coastline in pencil', 'typed'], [st[2].id, 'Label the five rivers', 'typed'], [null, 'Turn it in', 'ai']]),
      sv && JSON.stringify(sv.body.p_steps.map((x) => [x.id, x.title, x.source])));
    await context.close();
  }

  // The switch is there whenever the AI is on, so a parent can always turn it off: with no Test run kept (the 90-day
  // trim) and with the last Test failed.
  for (const [label, test] of [['no Test run kept', null], ['the last Test failed', 'busy_api']]) {
    const sdb = parentsDb({ on: true });
    if (test) {
      sdb.ai_runs.push({ id: crypto.randomUUID(), kid_id: null, assignment_id: null, link_id: null, kind: 'test', asked_by: 'alex@example.com', key: crypto.randomUUID(),
        status: 'failed', stop: test, model: null, started_at: at('2026-11-05', '12:00'), lease_until: at('2026-11-05', '12:06'), finished_at: at('2026-11-05', '12:00'),
        input_tokens: null, cache_read_tokens: null, cache_write_tokens: null, output_tokens: null, cents: null });
    }
    ({ page, db, context } = await open({ label: `switch: ${label}`, db: sdb }));
    const on = await page.$eval('[data-row="ai"] input[data-act="ai-on"]', (i) => i.checked).catch(() => null);
    if (on) {
      await page.click('[data-row="ai"] input[data-act="ai-on"]');
      await settle(page);
    }
    check(`the AI on, ${label}: its switch is there (on), and turns it off`, on === true && db.household[0].homework_ai === false, [on, db.household[0].homework_ai]);
    await context.close();
  }

  // The list reads a run whose worker died (still 'running', its lease long past) as the editor does: not drafting.
  {
    const ldb = parentsDb({ on: true, tested: true });
    ldb.assignments.find((a) => a.id === SCI).ai_state = 'running';
    ldb.ai_runs.push({ id: crypto.randomUUID(), kid_id: ID.jordan, assignment_id: SCI, link_id: null, kind: 'plan', asked_by: 'alex@example.com', key: crypto.randomUUID(),
      status: 'running', stop: null, model: null, started_at: at('2026-11-05', '13:00'), lease_until: at('2026-11-05', '13:06'), finished_at: null,
      input_tokens: null, cache_read_tokens: null, cache_write_tokens: null, output_tokens: null, cents: null });
    ({ page, db, context } = await open({ label: 'stale run', db: ldb }));
    const rowState = await text(page, `a.hw-arow[href="#/homework/${SCI}"] .hw-arow-state`);
    check('the list: a run whose lease ran out hours ago doesn\'t read "AI is drafting a plan…"', !!rowState && !/drafting/.test(rowState), rowState);
    await context.close();
  }

  // Test the AI planner's line for a cap, the month and a refusal with a category.
  {
    ({ page, db, context } = await open({ label: 'test cap', db: Object.assign(parentsDb(), { aiCap: 'cap' }) }));
    await page.click('[data-row="ai"] [data-act="ai-test"]');
    await until(page, () => !/Testing/.test(document.querySelector('[data-row="ai"] .hw-ai-test').textContent), 3000);
    check('Test with the day\'s runs used up: "Not run: AI help is used up for today (12 runs). Try again tomorrow."',
      /Not run: AI help is used up for today \(12 runs\)\. Try again tomorrow\./.test(await text(page, '[data-row="ai"] .hw-ai-test')), await text(page, '[data-row="ai"] .hw-ai-test'));
    await context.close();
    ({ page, db, context } = await open({ label: 'test month', db: Object.assign(parentsDb(), { aiCap: 'month' }) }));
    await page.click('[data-row="ai"] [data-act="ai-test"]');
    await until(page, () => !/Testing/.test(document.querySelector('[data-row="ai"] .hw-ai-test').textContent), 3000);
    check('... the month\'s: "Not run: AI help is used up for this month."', /Not run: AI help is used up for this month\./.test(await text(page, '[data-row="ai"] .hw-ai-test')),
      await text(page, '[data-row="ai"] .hw-ai-test'));
    await context.close();
    const rdb = parentsDb();
    rdb.ai_runs.push({ id: crypto.randomUUID(), kid_id: null, assignment_id: null, link_id: null, kind: 'test', asked_by: 'alex@example.com', key: crypto.randomUUID(),
      status: 'failed', stop: 'refusal_cyber', model: 'claude-opus-5-5', started_at: at('2026-11-05', '12:00'), lease_until: at('2026-11-05', '12:06'), finished_at: at('2026-11-05', '12:00'),
      input_tokens: 2600, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, cents: 0 });
    ({ page, db, context } = await open({ label: 'test refused', db: rdb }));
    check('... a refusal with a category: "Not working: the AI declined the test (cyber)."', /Not working: the AI declined the test \(cyber\)\./.test(await text(page, '[data-row="ai"] .hw-ai-test')),
      await text(page, '[data-row="ai"] .hw-ai-test'));
    await context.close();
  }

  // hub-jobs answering an error (here 503, 0005 not applied) is "Try again later", never "Can't reach Home Hub".
  ({ page, db, context } = await open({ label: 'hub-jobs 503', db: Object.assign(parentsDb({ on: true, tested: true }), { aiMode: 'no_schema' }), path: `/#/homework/${SCI}`,
    allowConsole: /status of 503/ }));
  await until(page, () => !!document.querySelector('.plan-ai-preview .plan-ai-text'), 3000);
  await sleep(200);
  await page.click('[data-act="ai-send"]');
  await until(page, () => !!(document.querySelector('.plan-ai-status') || {}).textContent, 3000);
  check('hub-jobs answers 503: "The AI couldn\'t make a plan just now. Try again later…", not a connection problem',
    /Try again later/.test(await text(page, '.plan-ai-status')) && !/Can't reach|internet/.test(await text(page, '.plan-ai-status')), await text(page, '.plan-ai-status'));
  await page.evaluate(() => { location.hash = '#/homework'; });
  await until(page, () => !!document.querySelector('[data-row="ai"]'));
  await page.click('[data-row="ai"] [data-act="ai-test"]');
  await until(page, () => !/Testing/.test(document.querySelector('[data-row="ai"] .hw-ai-test').textContent), 3000);
  check('... and Test says "Not working: try again later.", not "Couldn\'t reach Home Hub"', /Not working: try again later\./.test(await text(page, '[data-row="ai"] .hw-ai-test')),
    await text(page, '[data-row="ai"] .hw-ai-test'));
  await context.close();

  // =====================================================================
  // 3. Every failure leaves the starter plans, with its words
  // =====================================================================
  const STOPS = [
    ['not_set_up', { aiMode: 'not_set_up' }, /AI help isn't set up yet\. Start from a starter plan\./],
    ['cap', { aiCap: 'cap' }, /AI help is used up for today\. Start from a starter plan\./],
    ['month', { aiCap: 'month' }, /AI help is used up for this month\. Start from a starter plan\./],
    ['auth', { aiOutcome: () => ({ stop: 'auth' }) }, /AI help isn't working right now\./],
    ['spend_limit', { aiOutcome: () => ({ stop: 'spend_limit' }) }, /AI help is done for this month\./],
    ['billing', { aiOutcome: () => ({ stop: 'billing' }) }, /AI help is paused\./],
    ['busy_api', { aiOutcome: () => ({ stop: 'busy_api' }) }, /Try again later/],
    ['refusal_cyber', { aiOutcome: () => ({ stop: 'refusal_cyber' }) }, /The AI couldn't help with this one\./],
  ];
  for (const [stop, extra, words] of STOPS) {
    ({ page, db, context } = await open({ label: stop, db: Object.assign(parentsDb({ on: true, tested: true }), extra), path: `/#/homework/${SCI}` }));
    await until(page, () => !!document.querySelector('[data-act="ai-send"]'), 3000);
    await page.click('[data-act="ai-send"]');
    await sleep(300);
    await until(page, () => !!(document.querySelector('.plan-ai-status') || {}).textContent, 4000);
    await page.clock.runFor(5000);
    await until(page, () => !!document.querySelector('.plan-ai-status:not(:empty)') && !/Thinking/.test(document.querySelector('.plan-ai-status').textContent), 4000);
    const said = await text(page, '.plan-ai-status');
    check(`${stop}: "${String(words).slice(1, -1).replace(/\\/g, '')}", and Start from a starter plan is still there`, words.test(said) && !!(await page.$('[data-act="starter"]')), said);
    if (stop === 'auth') {
      await page.evaluate(() => { location.hash = '#/homework'; });
      await until(page, () => !!document.querySelector('[data-row="ai"]'));
      check('... and the switches card says "Anthropic refused the key. Make a new key and replace ANTHROPIC_API_KEY."',
        /Anthropic refused the key\. Make a new key and replace ANTHROPIC_API_KEY\./.test(await text(page, '[data-row="ai"]')), await text(page, '[data-row="ai"]'));
    }
    if (stop === 'refusal_cyber') {
      await page.evaluate(() => { location.hash = '#/homework'; });
      await until(page, () => !!document.querySelector('[data-row="ai"]'));
      check('... and the switches card names the category ("The AI declined the last one: cyber")', /The AI declined the last one: cyber/.test(await text(page, '[data-row="ai"]')), await text(page, '[data-row="ai"]'));
    }
    await context.close();
  }

  // Sam: no AI part at all.
  let samLog;
  ({ page, db, context, log: samLog } = await open({ label: 'sam', email: 'sam@example.com', db: parentsDb({ on: true, tested: true }), path: `/#/homework/${SCI}` }));
  await sleep(300);
  check('Sam: no preview, no Send to Claude, no AI call, and no read of the AI runs', !(await page.$('.plan-ai-preview')) && !(await page.$('[data-act="ai-send"]'))
    && !calls(db, 'homework_ai_preview').length && !samLog.some((l) => /^GET \/rest\/v1\/ai_runs/.test(l)), JSON.stringify(samLog.filter((l) => /ai_runs/.test(l))));
  await page.evaluate(() => { location.hash = '#/homework'; });
  await until(page, () => !!document.querySelector('.hw-head'));
  await sleep(300);
  check('... and no AI row on the switches card', !(await page.$('[data-row="ai"]')));
  await context.close();

  // A phone, and dark.
  ({ page, db, context } = await open({ label: 'phone', db: parentsDb({ on: true, tested: true }), path: `/#/homework/${SCI}`,
    ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' } }));
  await until(page, () => !!document.querySelector('[data-act="ai-send"]'), 3000);
  await page.click('[data-act="ai-send"]');
  await thinking(page);   // the 5-second read is set once hub-jobs answered
  await page.clock.runFor(5000);
  await until(page, () => !!document.querySelector('.plan-ai-draft'), 6000);
  check('390px wide: no sideways scroll with the draft open', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: SHOTS + 'homework-ai-phone-dark.png', fullPage: true });
  await context.close();

  // =====================================================================
  // 4. Pat's link
  // =====================================================================
  async function tutor(opts) {
    const tdb = opts.db || tutorDb();
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: 'Pacific/Kiritimati' }, opts.ctx));
    const p = await ctx.newPage();
    await p.clock.install({ time: TDEVICE });
    p.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${opts.label} console: ${m.text()}`); });
    const requests = [];
    p.on('request', (r) => requests.push(r.url()));
    await install(p, tdb, [], { rpc: {} });
    await tokenRpcs(p, tdb);
    await p.goto(BASE + opts.path);
    await p.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 5000 });
    await sleep(200);
    return { page: p, db: tdb, context: ctx, requests };
  }
  const tcalls = (tdb, name) => tdb.calls.filter((c) => c.name === name);
  let t = await tutor({ label: 'pat', path: `/day.html?h=${PAT}` });
  check('Pat\'s list: "Fractions practice · AI draft ready ›" under Plans to look at', /Fractions practice\s*AI draft ready ›/.test(await text(t.page, '[data-sec="plans"]')), await text(t.page, '[data-sec="plans"]'));
  await t.page.evaluate((id) => { location.hash = `#a/${id}`; }, hid(10));
  await until(t.page, () => !!document.querySelector('.plan-ai-preview'), 3000);
  const tpv = await text(t.page, '.plan-ai-text');
  check('Pat\'s assignment: What Claude will see, the view\'s preview as it is (open), Send to Claude', /\[name\]/.test(tpv) && !/North Field|Rivera|Pat\b/.test(tpv)
    && (await t.page.$eval('.plan-ai-preview', (d) => d.open)) === true && (await text(t.page, '[data-act="ai-send"]')) === 'Send to Claude', tpv);
  await t.page.click('[data-act="ai-send"]');
  await until(t.page, () => /Thinking about a plan/.test(document.querySelector('.plan-editor').textContent), 3000);
  const tsend = aiCalls(t.db)[0];
  check('Send to Claude from the link: hub-jobs with the token in the body, kind plan, and no sign-in', !!tsend && tsend.body.token === PAT && tsend.body.kind === 'plan'
    && tsend.body.assignment_id === hid(10) && UUID.test(tsend.body.key) && tsend.email === null, tsend && JSON.stringify(tsend));
  await t.page.clock.runFor(5000);
  await until(t.page, () => !!document.querySelector('.plan-ai-draft'), 6000);
  check('... read again with tutor_view_by_token(…, p_part \'ai\') every 5 seconds, then the draft', tcalls(t.db, 'tutor_view_by_token').some((c) => c.body.p_part === 'ai' && c.body.p_assignment === hid(10))
    && /Suggested by AI \(Claude\)\. Check it with Jordan\./.test(await text(t.page, '.plan-ai-label')), JSON.stringify(tcalls(t.db, 'tutor_view_by_token').map((c) => c.body.p_part)));
  await t.page.click('[data-act="ai-use"]');
  await sleep(200);
  await t.page.click('[data-act="give"]');
  await until(t.page, () => !document.querySelector('.plan-editor[aria-busy="true"]'), 3000);
  await sleep(400);
  const tp = tcalls(t.db, 'tutor_plan_by_token').slice(-1)[0];
  check('Use this plan, then Give Jordan this plan: tutor_plan_by_token with the draft\'s steps (source ai), p_give true', !!tp && tp.body.p_give === true
    && tp.body.p_steps.every((x) => x.source === 'ai') && tp.body.p_steps.length === 5, tp && JSON.stringify(tp.body));
  const tst = tcalls(t.db, 'tutor_assignment_by_token').filter((c) => c.body.p_fields && 'stretch' in c.body.p_fields);
  check('... and the stretch question copied with tutor_assignment_by_token({ id, stretch })', tst.length === 1 && same(Object.keys(tst[0].body.p_fields).sort(), ['id', 'stretch']), JSON.stringify(tst));
  check('only the tutor functions and hub-jobs were called from the link (no sign-in, no other table or function)',
    t.db.calls.every((c) => /^tutor_(view|assignment|plan|step)_by_token$/.test(c.name)) && !t.requests.some((u) => /\/auth\/v1\/|\/rest\/v1\/(?!rpc\/tutor_)|\/functions\/v1\/(?!hub-jobs)/.test(u)),
    [...new Set(t.db.calls.map((c) => c.name))].join(','));
  // Dismiss on the lesson's draft.
  await t.page.evaluate((id) => { location.hash = `#a/${id}`; }, hid(20));
  await until(t.page, () => !!document.querySelector('[data-act="ai-dismiss"]'), 3000);
  await t.page.click('[data-act="ai-dismiss"]');
  await until(t.page, () => !document.querySelector('.plan-ai-draft'), 3000);
  const dis = tcalls(t.db, 'tutor_assignment_by_token').filter((c) => c.body.p_fields && c.body.p_fields.ai).slice(-1)[0];
  check('Dismiss from the link: tutor_assignment_by_token({ id, ai: dismiss })', !!dis && same(dis.body.p_fields, { id: hid(20), ai: 'dismiss' }) && !t.db.assignments.find((a) => a.id === hid(20)).ai_draft,
    dis && JSON.stringify(dis.body));
  await t.context.close();

  // Ask again from the link: the request and answers shown in the preview, added to the view's message.
  t = await tutor({ label: 'pat again', path: `/day.html?h=${PAT}#a/${hid(20)}` });
  await until(t.page, () => !!document.querySelector('.plan-ai-ask'), 3000);
  await t.page.click('.plan-ai-ask [data-ai-chip="fewer"]');
  await t.page.clock.runFor(800);
  await until(t.page, () => /Fewer steps/.test((document.querySelector('.plan-ai-text') || {}).textContent || ''), 3000);
  check('Pat\'s Ask again: the request in the preview (‹request from="tutor"›)', /<request from="tutor">Fewer steps<\/request>/.test(await text(t.page, '.plan-ai-text')), await text(t.page, '.plan-ai-text'));
  await t.context.close();

  // The link's Send to Claude reads the view again first: the teacher's text changed since it was drawn → shown, open,
  // nothing sent; the next tap sends it, sealed.
  t = await tutor({ label: 'pat stale', path: `/day.html?h=${PAT}#a/${hid(10)}` });
  await until(t.page, () => !!document.querySelector('.plan-ai-preview .plan-ai-text'), 3000);
  await sleep(200);
  t.db.assignments.find((a) => a.id === hid(10)).details = `${TEXT}\nWork with the group on Tuesday.`;
  const reads0 = tcalls(t.db, 'tutor_view_by_token').length;
  await t.page.click('[data-act="ai-send"]');
  await until(t.page, () => /group on Tuesday/.test((document.querySelector('.plan-ai-text') || {}).textContent || ''), 3000);
  await sleep(200);
  check('Pat\'s link: Send to Claude reads the view again; changed since drawn → shown open, nothing sent', aiCalls(t.db).length === 0
    && tcalls(t.db, 'tutor_view_by_token').slice(reads0).some((c) => c.body.p_assignment === hid(10) && c.body.p_part === 'all')
    && (await t.page.$eval('.plan-ai-preview', (d) => d.open)) === true && /What Claude will see has changed/.test(await text(t.page, '.plan-ai-status')),
    [aiCalls(t.db).length, await text(t.page, '.plan-ai-status')]);
  const tShown = await t.page.$eval('.plan-ai-preview .plan-ai-text', (e) => e.textContent);
  await t.page.click('[data-act="ai-send"]');
  await until(t.page, () => /Thinking about a plan/.test(document.querySelector('.plan-editor').textContent), 3000);
  const tsend2 = aiCalls(t.db)[0];
  check('... the next tap sends it with the token, sealed with what is shown', !!tsend2 && tsend2.body.token === PAT && tsend2.body.shown === fnv(tShown), tsend2 && JSON.stringify(tsend2.body));
  await t.context.close();

  // The switch off, or the link may not ask: nothing of the AI on the link.
  for (const [label, o] of [['household switch off', { on: false }], ['link may not ask', { canAi: false }]]) {
    t = await tutor({ label, path: `/day.html?h=${PAT}#a/${hid(10)}`, db: tutorDb(o) });
    await sleep(300);
    check(`${label}: no preview and no Send to Claude on the link`, !(await t.page.$('.plan-ai-preview')) && !(await t.page.$('[data-act="ai-send"]')));
    await t.context.close();
  }
  // Spanish.
  t = await tutor({ label: 'pat es', path: `/day.html?h=${PAT}#a/${hid(10)}`, db: tutorDb({ lang: 'es' }) });
  await until(t.page, () => !!document.querySelector('.plan-ai-preview'), 3000);
  check('Spanish: "Lo que verá Claude", "Enviar a Claude"', /Lo que verá Claude/.test(await text(t.page, '.plan-ai-preview summary')) && (await text(t.page, '[data-act="ai-send"]')) === 'Enviar a Claude');
  await t.page.click('[data-act="ai-send"]');
  await thinking(t.page);   // the 5-second read is set once hub-jobs answered
  await t.page.clock.runFor(5000);
  await until(t.page, () => !!document.querySelector('.plan-ai-draft'), 6000);
  check('... "Sugerido por IA (Claude). Revísalo con Jordan."', /Sugerido por IA \(Claude\)\. Revísalo con Jordan\./.test(await text(t.page, '.plan-ai-label')), await text(t.page, '.plan-ai-label'));
  await t.context.close();

  // =====================================================================
  // 4b. With the coach view too (0007, schema 7): the AI planner and the coach view on one tutor link
  // =====================================================================
  {
    // The parents' page: the link's two switches, each its own write.
    const RPC7 = Object.assign({}, RPC, { hub_schema_version: () => 7 }, schoolRpc, coachRpc);
    ({ page, db, context } = await open({ label: 'coach and AI', db: withCoach(withSchool(parentsDb({ on: true, tested: true }))), rpc: RPC7 }));
    const boxes = () => page.$$eval(`li.hw-link[data-link="${LINK}"] input[type="checkbox"]`, (xs) => xs.map((x) => `${x.dataset.act}:${x.checked}`));
    check('schema 7: Pat\'s link has Can ask the AI (on), then Coach view (off)', same(await boxes(), ['link-ai:true', 'link-coach:false']), JSON.stringify(await boxes()));
    await page.click(`li.hw-link[data-link="${LINK}"] input[data-act="link-coach"]`);
    await settle(page);
    check('... Coach view on: set_tutor_coach only, and Can ask the AI stays on', calls(db, 'set_tutor_coach').length === 1 && !calls(db, 'save_tutor_link').length
      && db.tutor_links[0].coach === true && db.tutor_links[0].can_ai === true && same(await boxes(), ['link-ai:true', 'link-coach:true']), JSON.stringify(await boxes()));
    await page.click(`li.hw-link[data-link="${LINK}"] input[data-act="link-ai"]`);
    await settle(page);
    const sl = calls(db, 'save_tutor_link').slice(-1)[0];
    check('... Can ask the AI off: save_tutor_link with p_can_ai false, and the coach view stays on', !!sl && sl.body.p_can_ai === false && calls(db, 'set_tutor_coach').length === 1
      && db.tutor_links[0].coach === true && same(await boxes(), ['link-ai:false', 'link-coach:true']), JSON.stringify([sl && sl.body, await boxes()]));
    await context.close();

    // Pat's link with both on.
    const cdb = withCoach(tutorDb());
    cdb.tutor_links[0].coach = true;
    t = await tutor({ label: 'pat coach', path: `/day.html?h=${PAT}`, db: cdb });
    await until(t.page, () => !!document.querySelector('[data-sec="coach"] h2'), 4000);
    const secs = await t.page.$$eval('.plan-sec', (ss) => ss.map((x) => x.dataset.sec));
    check('Pat\'s link with the coach view and Can ask the AI on: "AI draft ready" under Plans to look at, and the Coach section last',
      /Fractions practice\s*AI draft ready ›/.test(await text(t.page, '[data-sec="plans"]')) && (await text(t.page, '[data-sec="coach"] h2')) === 'Coach' && secs[secs.length - 1] === 'coach',
      JSON.stringify(secs));
    await t.page.evaluate((id) => { location.hash = `#a/${id}`; }, hid(10));
    await until(t.page, () => !!document.querySelector('.plan-ai-preview'), 3000);
    check('... the assignment: What Claude will see and Send to Claude (the Coach section is the list\'s only)', !!(await t.page.$('[data-act="ai-send"]')) && !(await t.page.$('[data-sec="coach"]')));
    const cv0 = tcalls(t.db, 'coach_view_by_token').length;
    await t.page.click('[data-act="ai-send"]');
    await thinking(t.page);
    await t.page.clock.runFor(5000);
    await until(t.page, () => !!document.querySelector('.plan-ai-draft'), 6000);
    const cs = aiCalls(t.db)[0];
    check('... Send to Claude: hub-jobs with the link\'s token in the body and no sign-in, then the draft; the AI\'s reads ask for no coach view',
      !!cs && cs.body.token === PAT && cs.email === null && tcalls(t.db, 'tutor_view_by_token').some((c) => c.body.p_part === 'ai')
      && tcalls(t.db, 'coach_view_by_token').length === cv0, JSON.stringify([cs, cv0, tcalls(t.db, 'coach_view_by_token').length]));
    await t.page.click('[data-act="ai-use"]');
    await sleep(200);
    await t.page.click('[data-act="give"]');
    await until(t.page, () => !document.querySelector('.plan-editor[aria-busy="true"]'), 3000);
    await sleep(400);
    check('... Use this plan, then Give Jordan this plan: tutor_plan_by_token with p_give true', tcalls(t.db, 'tutor_plan_by_token').some((c) => c.body.p_give === true));
    await t.page.evaluate(() => { location.hash = ''; });
    await until(t.page, () => !!document.querySelector('[data-sec="coach"] h2'), 4000);
    check('... back on the list: the Coach section again, read again', tcalls(t.db, 'coach_view_by_token').length > cv0 && (await text(t.page, '[data-sec="coach"] h2')) === 'Coach',
      String(tcalls(t.db, 'coach_view_by_token').length));
    check('... and only the tutor functions, the coach view\'s two and hub-jobs were called from the link',
      t.db.calls.every((c) => /^(tutor_(view|assignment|plan|step)|coach_(view|note))_by_token$/.test(c.name))
      && !t.requests.some((u) => /\/auth\/v1\/|\/rest\/v1\/(?!rpc\/(tutor|coach)_)|\/functions\/v1\/(?!hub-jobs)/.test(u)), [...new Set(t.db.calls.map((c) => c.name))].join(','));
    await t.page.screenshot({ path: SHOTS + 'homework-ai-coach.png', fullPage: true });
    await t.context.close();
  }

  // =====================================================================
  // 5. Jordan's My day: "Plan by Pat, with AI help"; his link never calls hub-jobs
  // =====================================================================
  t = await tutor({ label: 'jordan', path: `/day.html?t=${JORDAN}#homework`, db: tutorDb({ given: true }) });
  await until(t.page, () => !!document.querySelector('.hw-asg'), 4000);
  check('his Due soon: "Plan by Pat, with AI help" on the plan made with a draft', /Book report[^]*Plan by Pat, with AI help/.test(await text(t.page, '.hw-asg[data-asg="' + hid(30) + '"]')),
    await text(t.page, '.hw-asg[data-asg="' + hid(30) + '"]'));
  check('his link never calls hub-jobs', !t.requests.some((u) => /\/functions\/v1\//.test(u)));
  await t.context.close();

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
  server.close();
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
})().catch((err) => { console.log(results.join('\n')); console.log(`FAIL  test run stopped early: ${err && err.stack}`); process.exit(1); });
