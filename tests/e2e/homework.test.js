// Browser tests for the Homework page (assets/modules/homework.js; docs/v1.3-homework.md §9.1, §9.2,
// §4, §5, §8, §14), without the AI parts (PR B): the heading and the kid line; the first visit
// (homework on for a kid, his homework time prefilled Mon–Thu 4:30–5:15, three rewards in three
// sizes); To approve (his ask with his balance and this week's sources: Yes, Not now with a word; a
// suggestion priced); To check (Looks done with a note and its Undo, Not yet needing a note); To talk
// about; Questions and notes (Answer; the answers and coach's notes of the last 7 days with who gave
// them, qa_log too); Assignments and lessons (+ Assignment and + Lesson with the Live Text hint, "added
// by Jordan", Quick, No plan yet, the bars, Done (30 days)); an assignment (its fields, the teacher's
// text with its lines, a starter plan placed by the database with every step's "done looks like" and
// no step longer than his first length, the editor: edit, milestone on and off, move, delete, Place
// again, Doesn't fit; Give Jordan this plan; a stale save reloads; a moved due date places the steps
// after it again; Mark done, Drop); This week (the strip with busy titles, focused minutes, pace, his
// blocks); Points and rewards (Give points, Void, a reward added); the switches (homework on, points
// and their values with both caps, homework time, Pat's link: Copy · WhatsApp · Text · New link · Off
// · Extend; Erase asks for ERASE); Sam sees everything with no buttons; a hostile title and text drawn
// as text; nothing about the AI; phones and desktops, light and dark. Also: a ledger past the API's 1,000
// rows read page by page; Not now's word at most 120; a Yes on an ask answered elsewhere says so; a
// moved due date placed again from the plan as it is now (Jordan's changes kept, a change during the
// save refused once and read again, a step ticked early sent without a day); a focus read never wipes
// what is being typed in the rewards, link and points-values forms, nor the homework time's day chips.
// From 0006 (schema 6; docs/v1.3-homework.md §11, §12), the School links row of the switches: the three feeds
// (Assignments, Schedule, Games/Practices) with their status (last read, items, the last error in words), Add link,
// Replace and Remove, the plain how-to-copy steps; the link checked before it is sent (webcal:// sent as https://),
// a refusal said in the form; the link never shown back, kept in the page, stored or logged; "from school" on an
// assignment; no row and no request on schema 5 or for Sam; a failed status read; a phone.
// From 0007 (schema 7; docs/v1.3-homework.md §20.5), on each tutor link the coach view's switch (off by default, with
// what it shows in plain words; set_tutor_coach) and the coach's notes for the parents (coach_notes, read only on 7 and
// only by the parents; Done with coach_note_done, the done ones of the last 30 days folded); none of it on schema 6 or
// for Sam; a phone.
//
// mock.js has the tables and the signed-in functions (withHomework, homeworkRpc) with the migration's
// rules and shapes. The other v2 pages are small stubs. The household's clock is Thu Nov 5 2026,
// 3:10pm in New York; the device's is elsewhere (Jan 15, in Los Angeles), so anything using the
// device's date shows the wrong day. "Pat Lee" is also the made-up electrician in makeDb(): the tutor
// is only ever looked for inside the tutor link's row and the lines that name the link.
// Run alone with: node tests/e2e/homework.test.js
const { chromium } = require('playwright');
const { createHash } = require('crypto');
const { makeDb, install, signIn, SUPA, withHomework, homeworkRpc, foodRpc, hwKidRow, tutorLinkRow, assignmentRow, stepRow, sessionRow,
  rewardRow, askRow, ledgerRow, withSchool, schoolRpc, schoolFeedRow, schoolItemRow, schoolUrlOf, withCoach, coachRpc, coachNoteRow } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---- Fixtures (fictional people, 555-01xx numbers, example.com)
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-11-05';   // a Thursday; the household's clock says 3:10pm in New York
const DEVICE = new Date('2026-01-15T05:00:00Z');
const ID = {
  alex: 'f00d0000-0000-4000-8000-000000000011', sam: 'f00d0000-0000-4000-8000-000000000012',
  jordan: 'f00d0000-0000-4000-8000-000000000013', taylor: 'f00d0000-0000-4000-8000-000000000014',
  morgan: 'f00d0000-0000-4000-8000-000000000015',
};
const token = (id) => createHash('md5').update(id).digest('hex');
const person = (id, name, role, color, sort, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color, language: 'en',
  day_token: token(id), digest_enabled: false, digest_time: null, digest_day: 'today', digest_scope: 'mine',
  sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// An instant on a household day ('HH:MM' in New York: daylight time until Nov 1, standard after), as Postgres writes it.
const at = (day, hm) => {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8), h + (day >= '2026-11-01' ? 5 : 4), m));
  return `${d.toISOString().slice(0, 19)}.123456+00:00`;
};
const PAT = 'Pat Lee, tutor (tutor link)';
const KID = 'Jordan Example (My day)';

function baseDb() {
  const db = makeDb();
  db.people = [
    person(ID.alex, 'Alex Example', 'parent', '#2563eb', 1, { email: 'alex@example.com', email_verified_at: T }),
    person(ID.morgan, 'Morgan Example', 'parent', '#9333ea', 2),
    person(ID.sam, 'Sam Example', 'adult', '#db2777', 3, { email: 'sam@example.com' }),
    person(ID.jordan, 'Jordan Example', 'kid', '#16a34a', 4),
    person(ID.taylor, 'Taylor Example', 'helper', '#ca8a04', 5, { phone: '(201) 555-0104', language: 'es' }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: null, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '15:10:00', tz: 'America/New_York' };
  return withHomework(db);
}
const ev = (o) => Object.assign({
  id: crypto.randomUUID(), title: '', notes: null, location: null, start_date: '2026-10-05', end_date: null, start_time: null, end_time: null, ends_next_day: false,
  responsible_id: null, participant_ids: [], contractor_id: null, private: false, repeat: 'weekly', repeat_every: 1, repeat_weekdays: [],
  repeat_until: null, skip_days_off: true, created_by: 'alex@example.com', updated_by: 'alex@example.com', created_at: T, updated_at: T,
}, o);

// Jordan with homework on, his homework time (Mon–Thu 4:30–5:15, Sun 5:00–5:45), piano on Tuesdays at
// 5:00 (busy), Pat's link, four assignments and a lesson in every state, rewards and a suggestion, his
// ask, a week of points (balance 118: this week +31 focus and on time, +20 milestones checked by Pat)
// and his blocks (pace 1.2 over the five done steps that had blocks once the outline is sent back).
function fullDb() {
  const db = baseDb();
  db.homework_kids.push(hwKidRow({ kid_id: ID.jordan, updated_at: T }));
  const hw1 = ev({ title: 'Homework', start_time: '16:30:00', end_time: '17:15:00', responsible_id: ID.jordan, repeat_weekdays: [1, 2, 3, 4] });
  const hw2 = ev({ title: 'Homework', start_date: '2026-10-04', start_time: '17:00:00', end_time: '17:45:00', responsible_id: ID.jordan, repeat_weekdays: [7] });
  const piano = ev({ title: 'Piano', start_date: '2026-10-06', start_time: '17:00:00', end_time: '17:45:00', responsible_id: ID.jordan, repeat_weekdays: [2] });
  db.events.push(hw1, hw2, piano);
  db.homework_times.push({ event_id: hw1.id, kid_id: ID.jordan }, { event_id: hw2.id, kid_id: ID.jordan });
  db.tutor_links.push(tutorLinkRow({ id: 'a1110000-0000-4000-8000-000000000001', kid_id: ID.jordan, token: 'ab'.repeat(16), expires_on: '2027-04-30',
    last_used_at: at('2026-11-01', '16:05') }));
  const A = (o) => { const a = assignmentRow(Object.assign({ kid_id: ID.jordan, created_by: 'alex@example.com' }, o)); db.assignments.push(a); return a; };
  const S = (a, pos, o) => { const s = stepRow(Object.assign({ assignment_id: a.id, pos, source: 'template' }, o)); db.homework_steps.push(s); return s; };
  const sci = A({ id: 'a5c10000-0000-4000-8000-000000000001', title: 'Science project: river poster', subject: 'Science', due_date: '2026-11-13',
    details: 'Make a poster about a river.\nShow its source, its mouth and one animal that lives in it.\n\nInclude 2 sources.',
    stretch: 'Which part of the river would you most like to show in detail?', given_at: at('2026-11-01', '18:00'), given_by: PAT, plan_rev: 7, added_by: 'tutor' });
  const s1 = S(sci, 1, { kind: 'start', title: 'Copy the requirements into your notes', done_looks_like: 'the requirements in your notes', minutes: 10, day: '2026-11-02', done_at: at('2026-11-02', '16:42'), done_by: KID });
  const s2 = S(sci, 2, { title: 'Find 2 sources and save their links', done_looks_like: '2 links in your notes', minutes: 20, day: '2026-11-03', done_at: at('2026-11-03', '16:58'), done_by: KID });
  const s3 = S(sci, 3, { kind: 'milestone', title: 'Outline with 3 main points', done_looks_like: 'an outline you can show', minutes: 20, day: '2026-11-04', done_at: at('2026-11-04', '16:52'), done_by: KID });
  S(sci, 4, { kind: 'milestone', title: 'Full draft', done_looks_like: 'a whole draft', minutes: 20, day: '2026-11-02' });
  S(sci, 5, { title: 'Draft the first half', done_looks_like: 'the first half written', minutes: 20, day: TODAY, question: 'Does the poster need a title?', question_at: at('2026-11-04', '18:10') });
  S(sci, 6, { title: 'Draft the second half', done_looks_like: 'the second half written', minutes: 20, day: '2026-11-09' });
  S(sci, 7, { kind: 'check', title: 'Check it against the instructions', done_looks_like: 'each requirement ticked off', minutes: 20, day: '2026-11-10' });
  S(sci, 8, { kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: '2026-11-13' });
  const math = A({ id: 'a5c10000-0000-4000-8000-000000000002', title: 'Worksheet 5.1', subject: 'Math', due_date: '2026-11-06', added_by: 'kid', created_by: KID,
    given_at: at('2026-11-04', '16:20'), given_by: KID, plan_rev: 1 });
  S(math, 1, { title: 'Worksheet 5.1', minutes: 15, day: TODAY, source: 'typed' });
  A({ id: 'a5c10000-0000-4000-8000-000000000003', kind: 'lesson', title: 'Fractions practice', subject: 'Math', due_date: '2026-11-09' });
  const hist = A({ id: 'a5c10000-0000-4000-8000-000000000004', title: 'History timeline', subject: 'History', due_date: '2026-11-11',
    given_at: at('2026-10-30', '17:00'), given_by: 'alex@example.com', plan_rev: 4 });
  S(hist, 1, { kind: 'milestone', title: 'Timeline sketch', minutes: 20, day: '2026-11-03', done_at: at('2026-11-03', '16:40'), done_by: KID,
    checked_at: at('2026-11-03', '18:00'), checked_by: PAT, coach_note: 'Clear sketch. The dates are easy to follow.', coach_note_by: 'tutor', coach_note_at: at('2026-11-03', '18:00') });
  S(hist, 2, { title: 'Read chapter 2', minutes: 20, day: '2026-11-10', question: 'Which pages?', question_at: at('2026-11-02', '17:00'), answer: 'Pages 40 to 52.',
    answer_by: PAT, answer_at: at('2026-11-02', '18:10'),
    qa_log: [{ question: 'Is it due Friday?', asked_at: at('2026-10-30', '16:00'), answer: 'No, next Wednesday.', answered_at: at('2026-10-30', '19:00'), answered_by: 'alex@example.com', by: 'family' }] });
  S(hist, 3, { title: 'Write the captions', minutes: 20, day: '2026-11-10', question: 'Short or long captions?', question_at: at('2026-10-24', '17:00'), answer: 'Short ones.',
    answer_by: PAT, answer_at: at('2026-10-25', '18:00') });   // answered 11 days ago: not under Questions and notes
  S(hist, 4, { kind: 'turn_in', title: 'Turn it in', minutes: 5, day: '2026-11-11' });
  const spell = A({ id: 'a5c10000-0000-4000-8000-000000000005', title: 'Spelling list', subject: 'English', due_date: '2026-10-29', status: 'done', done_at: at('2026-10-28', '17:30'),
    given_at: at('2026-10-25', '17:00'), given_by: 'alex@example.com', plan_rev: 3 });
  const w1 = S(spell, 1, { title: 'Learn words 1 to 10', minutes: 20, day: '2026-10-26', done_at: at('2026-10-27', '17:00'), done_by: KID });
  const w2 = S(spell, 2, { title: 'Learn words 11 to 20', minutes: 20, day: '2026-10-28', done_at: at('2026-10-28', '17:30'), done_by: KID });
  const w3 = S(spell, 3, { title: 'Practice the spelling test', minutes: 20, day: '2026-10-28', done_at: at('2026-10-28', '17:50'), done_by: KID });
  A({ title: 'Book report', subject: 'English', due_date: '2026-09-25', status: 'done', done_at: at('2026-09-24', '17:00') });   // over 30 days: not shown
  // Rewards: three sizes and a bigger one, and his suggestion.
  const R = (o) => { const r = rewardRow(Object.assign({ kid_id: ID.jordan }, o)); db.rewards.push(r); return r; };
  R({ title: '15 minutes of extra game time', cost: 15, sort_order: 1 });
  R({ title: 'Choose Friday\'s dinner', cost: 60, sort_order: 2 });
  const movie = R({ title: 'Pick the movie', cost: 100, sort_order: 3 });
  R({ title: 'A new book', cost: 150, sort_order: 4 });
  R({ id: 'eeee0000-0000-4000-8000-000000000001', title: 'Skip one chore', cost: null, active: false, suggested: true, sort_order: 5 });
  db.reward_asks.push(askRow({ id: 'a5c00000-0000-4000-8000-000000000001', kid_id: ID.jordan, reward_id: movie.id, title: 'Pick the movie', cost: 100, asked_at: at('2026-11-04', '19:00') }));
  // Points: 67 before this week; this week +31 focus and on time, +20 for Timeline sketch (Pat).
  const L = (day, kind, delta, o) => db.points_ledger.push(ledgerRow(Object.assign({ kid_id: ID.jordan, at: at(day, '17:00'), day, kind, delta }, o)));
  L('2026-10-20', 'given', 60, { id: 'eeee0000-0000-4000-8000-000000000010', note: 'Starting points', who: 'alex@example.com' });
  L('2026-10-27', 'focus', 4, { note: 'Learn words 1 to 10' });
  L('2026-10-28', 'focus', 3, { note: 'Learn words 11 to 20' });
  L('2026-11-02', 'focus', 2, { note: 'Copy the requirements into your notes' });
  L('2026-11-02', 'on_time', 5);
  L('2026-11-02', 'focus', 4, { note: 'Find 2 sources and save their links' });
  L('2026-11-03', 'focus', 4, { note: 'Find 2 sources and save their links' });
  L('2026-11-03', 'on_time', 5);
  L('2026-11-03', 'milestone', 20, { note: 'Timeline sketch', who: PAT });
  L('2026-11-04', 'focus', 4, { id: 'eeee0000-0000-4000-8000-000000000011', note: 'Outline with 3 main points' });
  L('2026-11-04', 'on_time', 5);
  L(TODAY, 'focus', 2, { at: at(TODAY, '15:05'), note: 'Worksheet 5.1' });
  // Blocks: this week 10 + 20 + 20 + 20 + 9 minutes; last week 20 + 10 + 24 + 20.
  const B = (day, hm, minutes, o) => db.focus_sessions.push(sessionRow(Object.assign({ kid_id: ID.jordan, minutes, started_at: at(day, hm), ended_at: at(day, hm),
    result: 'done', seen_minutes: minutes }, o)));
  B('2026-10-26', '16:30', 20, { assignment_id: spell.id, step_id: w1.id, result: 'more' });
  B('2026-10-27', '16:30', 10, { assignment_id: spell.id, step_id: w1.id });
  B('2026-10-28', '16:30', 25, { assignment_id: spell.id, step_id: w2.id, seen_minutes: 24 });
  B('2026-10-28', '17:00', 20, { assignment_id: spell.id, step_id: w3.id });
  B('2026-11-02', '16:31', 10, { assignment_id: sci.id, step_id: s1.id, on_time: true });
  B('2026-11-02', '16:45', 20, { assignment_id: sci.id, step_id: s2.id, result: 'more', note: 'found 2 sources' });
  B('2026-11-03', '16:35', 20, { assignment_id: sci.id, step_id: s2.id, with_whom: 'tutor' });
  B('2026-11-04', '16:32', 20, { assignment_id: sci.id, step_id: s3.id });
  B(TODAY, '15:00', 10, { assignment_id: math.id, result: 'stopped', seen_minutes: 9 });
  return db;
}

// ---- Stub pages: the same register() contract as the real ones (the Calendar's records openEventForm)
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true }, provides: 'openEventForm' },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true }, provides: 'openTaskForm' },
  food: { nav: { label: 'Food', order: 35, primary: true }, min: 4 },
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
    name: ${JSON.stringify(name)}, schema: { min: ${s.min || 2}, max: 99 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return parts[0] === ${JSON.stringify(name)}${s.root ? ' || !parts.length' : ''} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1>'; },
    provides: provides,
  });
})();`;

const RPC = Object.assign({
  hub_schema_version: () => 5,
  clock: (db) => Object.assign({}, db.clock),
  mark_signed_in: () => null,
}, foodRpc, homeworkRpc);

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

  // A signed-in page on #/homework (or opts.path).
  async function open(opts = {}) {
    const db = opts.db || fullDb();
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles' }, opts.ctx));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    await page.clock.install({ time: DEVICE });
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => {
      (db.dialogs = db.dialogs || []).push(d.message());
      return db.confirm === false ? d.dismiss() : d.accept();
    });
    const log = [];
    await install(page, db, log, { rpc: opts.rpc || RPC });
    await page.route(`${SUPA}/rest/v1/rpc/whoami`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const m = db.members.find((x) => x.email === emailOf(req));
      const p = m && db.people.find((x) => x.email === m.email);
      const body = m ? Object.assign({}, m, { person: p ? { id: p.id, name: p.name, role: p.role, language: p.language, color: p.color } : null }) : null;
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    });
    // Writes to the homework tables, then the mock answers.
    db.writes = [];
    await page.route((url) => url.host === 'test.supabase.co' && /^\/rest\/v1\/(homework_kids|homework_times|assignments|rewards|tutor_links|homework_steps)$/.test(url.pathname), (route) => {
      const req = route.request();
      if (['PATCH', 'POST', 'DELETE'].includes(req.method())) {
        const url = new URL(req.url());
        db.writes.push({ table: url.pathname.split('/').pop(), method: req.method(), query: decodeURIComponent(url.search), body: JSON.parse(req.postData() || 'null') });
      }
      return route.fallback();
    });
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: stubModule(name, s) }));
    }
    await page.goto(BASE + (opts.path || '/#/homework'));
    await until(page, () => !!document.querySelector('.hw-head, .hw-a'), 6000);
    await until(page, () => !document.querySelector('#main .loading'), 4000);
    await sleep(opts.wait || 200);
    return { page, db, log, context };
  }

  // Wait (in real time, from Node, so a paused page clock doesn't matter) until fn() is true in the page.
  async function until(page, fn, ms = 4000, arg) {
    const end = Date.now() + ms;
    for (;;) {
      if (await page.evaluate(fn, arg).catch(() => false)) return true;
      if (Date.now() > end) return false;
      await sleep(40);
    }
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const toasts = (page) => page.$$eval('.toasts .toast', (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const lastToast = async (page) => (await toasts(page)).slice(-1)[0] || '';
  const calls = (db, name) => (db.rpcCalls || []).filter((c) => c.name === name);
  const lastCall = (db, name) => calls(db, name).slice(-1)[0] || {};
  const writes = (db, table, method) => (db.writes || []).filter((w) => w.table === table && (!method || w.method === method));
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const secs = (page) => page.$$eval('#main section.hw-sec', (ss) => ss.map((s) => s.dataset.sec));
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await until(page, () => !document.querySelector('#main .loading')); await sleep(250); };
  const settle = (page) => until(page, () => !document.querySelector('#main [aria-busy="true"]')).then(() => sleep(250));
  const dialogOpen = (page) => page.evaluate(() => document.getElementById('formDialog').open);
  const ED = '[data-ref="editor"]';
  const SCI = 'a5c10000-0000-4000-8000-000000000001';

  // =====================================================================
  // 1. The first visit: homework on, homework time, three rewards
  // =====================================================================
  let { page, db, log } = await open({ label: 'first', db: baseDb() });
  check('heading: "Homework", with "Plans, focus sessions and points"', (await text(page, '#main h1')) === 'Homework' && (await text(page, '.hw-head .meta')) === 'Plans, focus sessions and points');
  check('the Homework tab is current (a tab between Food and Projects on a desktop)', (await page.getAttribute('.tabs a[data-tab="homework"]', 'aria-current')) === 'page'
    && same(await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent)), ['Today', 'Calendar', 'Tasks', 'Food', 'Homework', 'Projects', 'Directory', 'Family', 'Settings']),
    JSON.stringify(await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent))));
  check('nobody has homework yet: one button per kid on the list (not Taylor, a helper)', same(await texts(page, '.hw-setup [data-act="turn-on"]'), ['Turn on homework for Jordan']), JSON.stringify(await texts(page, '.hw-setup button')));
  check('first visit: no sections yet, and no week read', !(await secs(page)).length && !calls(db, 'homework_week').length, JSON.stringify(await secs(page)));
  await page.click('[data-act="turn-on"]');
  await settle(page);
  check('Turn on: save_homework_kid with Jordan and on', same(lastCall(db, 'save_homework_kid').body, { p_kid: ID.jordan, p_active: true }) && db.homework_kids.length === 1);
  const timeForm = await page.$eval('.hw-setup form[data-form="time"]', (f) => ({ days: [...f.querySelectorAll('[data-wd]')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    from: f.elements.from.value, to: f.elements.to.value })).catch(() => null);
  check('then his homework time, prefilled Mon–Thu 4:30–5:15', !!timeForm && same(timeForm.days.map((d) => d[1] === 'true'), [true, true, true, true, false, false, false])
    && same(timeForm.days.map((d) => d[0]), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) && timeForm.from === '16:30' && timeForm.to === '17:15', JSON.stringify(timeForm));
  // A window focus (back from checking the school's timetable) after only the day chips were tapped: no
  // read, the chips stay as tapped (a chip tap is no input event, so it marks the form as being typed in).
  const chipReads = log.length;
  await page.click('.hw-setup form[data-form="time"] [data-wd="1"]');
  await page.click('.hw-setup form[data-form="time"] [data-wd="5"]');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(400);
  const chipsNow = await page.$$eval('.hw-setup form[data-form="time"] [data-wd]', (bs) => bs.map((b) => b.getAttribute('aria-pressed') === 'true')).catch(() => []);
  check('a window focus after the day chips are tapped: no read, the chips stay (Tue–Fri)', same(chipsNow, [false, true, true, true, true, false, false])
    && !log.slice(chipReads).some((l) => /^GET \/rest\/v1\/homework_kids/.test(l)), JSON.stringify([chipsNow, log.slice(chipReads)]));
  for (let d = 1; d <= 7; d++) {   // back to Mon–Thu, from whatever the chips show
    const sel = `.hw-setup form[data-form="time"] [data-wd="${d}"]`;
    if (((await page.getAttribute(sel, 'aria-pressed')) === 'true') !== (d <= 4)) await page.click(sel);
  }
  await page.click('.hw-setup form[data-form="time"] [data-wd="4"]');
  await page.click('.hw-setup form[data-form="time"] [data-wd="4"]');
  await page.click('.hw-setup form[data-form="time"] button[type="submit"]');
  await settle(page);
  check('Add: add_homework_time with ISO weekdays 1–4 (Monday is 1), 16:30 and 17:15', same(lastCall(db, 'add_homework_time').body, { p_kid: ID.jordan, p_weekdays: [1, 2, 3, 4], p_start: '16:30', p_end: '17:15' })
    && db.events.length === 1 && db.homework_times.length === 1, JSON.stringify(lastCall(db, 'add_homework_time').body));
  const rw = await page.$$eval('.hw-setup form[data-form="rewards"] .hw-rw', (rs) => rs.map((r) => [r.querySelector('[name="title"]').placeholder, r.querySelector('[name="cost"]').value])).catch(() => []);
  // The owner changed the sizes: an instant one he gets after one block (about 15), one a week (about 200), a bigger one (about 500).
  const rwInstant = await page.$$eval('.hw-setup form[data-form="rewards"] .hw-rw [name="instant"]', (is) => is.map((i) => i.checked)).catch(() => []);
  check('then "Add 3 rewards" in three sizes (about 15, instant; 200; 500)', same(rw.map((r) => r[1]), ['15', '200', '500']) && rw.every((r) => r[0].length > 3)
    && same(rwInstant, [true, false, false]), JSON.stringify([rw, rwInstant]));
  const titles = ['15 minutes of extra game time', 'Choose Friday\'s dinner', 'A new book'];
  for (let i = 0; i < 3; i++) await page.fill(`.hw-setup form[data-form="rewards"] .hw-rw:nth-child(${i + 1}) [name="title"]`, titles[i]);
  // A window focus (back from asking Jordan what he'd like) while they are being typed: no read, nothing lost.
  const typedReads = log.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(400);
  const kept = await page.$$eval('.hw-setup form[data-form="rewards"] [name="title"]', (is) => is.map((i) => i.value)).catch(() => []);
  check('a window focus while the rewards are typed: no read, the titles stay', same(kept, titles) && !log.slice(typedReads).some((l) => /^GET \/rest\/v1\/homework_kids/.test(l)),
    JSON.stringify([kept, log.slice(typedReads)]));
  await page.click('.hw-setup form[data-form="rewards"] button[type="submit"]');
  await settle(page);
  const rpost = writes(db, 'rewards', 'POST')[0] || {};
  check('Add rewards: one insert of three, his, priced, on, the first instant, in order',
    same(rpost.body, titles.map((title, i) => ({ kid_id: ID.jordan, title, cost: [15, 200, 500][i], active: true, instant: i === 0, sort_order: i + 1 }))), JSON.stringify(rpost.body));
  check('the setup is done: no setup card; the kid line names his homework time', !(await page.$('.hw-setup'))
    && (await tc(page, '.hw-kidline')) === 'Jordan · 0 points · Homework time Mon–Thu 4:30–5:15pm ›', await tc(page, '.hw-kidline'));
  check('now the sections: Assignments and lessons, This week, Points and rewards, Switches', same(await secs(page), ['assignments', 'week', 'points', 'switches']), JSON.stringify(await secs(page)));
  check('the week is read for 56 days from today (homework_week)', same(lastCall(db, 'homework_week').body, { p_kid: ID.jordan, p_from: TODAY, p_days: 56 }), JSON.stringify(lastCall(db, 'homework_week').body));
  await page.context().close();
  // Sam on the first visit: nothing to tap.
  ({ page, db } = await open({ label: 'first-sam', db: baseDb(), email: 'sam@example.com' }));
  check('Sam on the first visit: "Homework isn\'t on for anyone yet. A parent turns it on here." and no buttons',
    (await tc(page, '.hw-setup')) === 'Homework isn\'t on for anyone yet. A parent turns it on here.' && !(await page.$('#main .hw-setup button')), await tc(page, '.hw-setup'));
  await page.context().close();

  // =====================================================================
  // 2. The page: the kid line and the sections in order
  // =====================================================================
  ({ page, db, log } = await open({ label: 'full' }));
  check('the kid line: "Jordan · 118 points · Homework time Mon–Thu 4:30–5:15pm, Sun 5:00–5:45pm ›"',
    (await tc(page, '.hw-kidline')) === 'Jordan · 118 points · Homework time Mon–Thu 4:30–5:15pm, Sun 5:00–5:45pm ›', await tc(page, '.hw-kidline'));
  check('one kid: no kid picker', !(await page.$('select[name="kid"]')));
  check('the sections in order: To approve · To check · To talk about · Questions and notes · Assignments and lessons · This week · Points and rewards · Switches',
    same(await secs(page), ['approve', 'check', 'talk', 'qa', 'assignments', 'week', 'points', 'switches']), JSON.stringify(await secs(page)));
  const heads = await page.$$eval('#main section.hw-sec > .sec-head > span:first-child', (es) => es.map((e) => e.textContent));
  check('section headings', same(heads, ['To approve', 'To check', 'To talk about', 'Questions and notes', 'Assignments and lessons', 'This week', 'Points and rewards', 'Switches']),
    JSON.stringify(heads));
  const reads = log.filter((l) => /^GET \/rest\/v1\//.test(l)).map((l) => decodeURIComponent(l.split('?')[0].replace('GET /rest/v1/', '')));
  check('reads: the homework tables and the events of his homework time (no AI runs, no household)', ['homework_kids', 'homework_times', 'tutor_links', 'assignments',
    'homework_steps', 'focus_sessions', 'points_ledger', 'rewards', 'reward_asks', 'events'].every((t) => reads.includes(t)) && !reads.includes('ai_runs'), JSON.stringify(reads));

  // ---------- To approve
  check('To approve: "Pick the movie · 100 · asked yesterday · balance 118 (this week: +31 focus and on time, +20 milestones checked by Pat)"',
    (await tc(page, '.hw-ask .hw-ask-line')) === 'Pick the movie · 100 · asked yesterday · balance 118 (this week: +31 focus and on time, +20 milestones checked by Pat)',
    await tc(page, '.hw-ask .hw-ask-line'));
  check('his suggestion: "Suggested by Jordan: "Skip one chore"" with Price it', (await tc(page, '.hw-sugg .hw-sugg-line')) === 'Suggested by Jordan: “Skip one chore”'
    && !!(await page.$('.hw-sugg [data-act="price"]')), await tc(page, '.hw-sugg'));
  // Not now's word is at most 120 characters, as decide_reward and reward_asks.note allow (a note on a step may be 160).
  await page.click('.hw-ask [data-act="not-now"]');
  check('Not now: the word box takes at most 120 characters, as decide_reward does', (await page.getAttribute('.hw-ask form.hw-note [name="text"]', 'maxlength')) === '120',
    await page.getAttribute('.hw-ask form.hw-note [name="text"]', 'maxlength'));
  await page.$eval('.hw-ask form.hw-note [name="text"]', (e) => { e.value = 'A'.repeat(121); });
  await page.click('.hw-ask form.hw-note button[type="submit"]');
  await sleep(150);
  check('... and a 121-character word says "That\'s too long." under the box, with no call; the ask still waits', !calls(db, 'decide_reward').length
    && (await tc(page, '.hw-ask form.hw-note .form-error')) === 'That\'s too long.' && db.reward_asks[0].status === 'waiting',
    JSON.stringify([calls(db, 'decide_reward').length, await tc(page, '.hw-ask form.hw-note .form-error'), await lastToast(page)]));
  await page.click('.hw-ask form.hw-note [data-act="cancel-note"]');
  await page.click('.hw-ask [data-act="not-now"]');
  await page.fill('.hw-ask form.hw-note [name="text"]', 'Not on a school night');
  await page.click('.hw-ask form.hw-note button[type="submit"]');
  await settle(page);
  check('Not now with a word: decide_reward(ask, false, the word)', same(lastCall(db, 'decide_reward').body, { p_ask: 'a5c00000-0000-4000-8000-000000000001', p_approve: false, p_note: 'Not on a school night' })
    && db.reward_asks[0].status === 'declined' && !(await page.$('.hw-ask')), JSON.stringify(lastCall(db, 'decide_reward').body));
  db.reward_asks[0].status = 'waiting';
  db.reward_asks[0].note = null;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(page, () => !!document.querySelector('.hw-ask'));
  // Morgan answers Not now on her phone; this page still shows the ask. Yes here: the database keeps her
  // answer (as it is, no error), and the toast says so, not "Yes".
  Object.assign(db.reward_asks[0], { status: 'declined', decided_at: at(TODAY, '15:09'), decided_by: 'morgan@example.com' });
  await page.click('.hw-ask [data-act="yes"]');
  await settle(page);
  check('Yes on an ask already answered Not now elsewhere: "Already answered Not now: Pick the movie", no trade, the ask goes',
    (await lastToast(page)) === 'Already answered Not now: Pick the movie' && !db.points_ledger.some((l) => l.kind === 'trade') && !(await page.$('.hw-ask')),
    JSON.stringify([await toasts(page), db.reward_asks[0].status]));
  Object.assign(db.reward_asks[0], { status: 'waiting', decided_at: null, decided_by: null });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(page, () => !!document.querySelector('.hw-ask'));
  // Morgan said Yes on her phone; Not now here keeps her Yes (no decline, no second trade), and says so.
  // He cancelled it while this page still showed it: Yes or Not now says so and writes nothing.
  for (const [status, act, by, want] of [
    ['approved', 'not-now', 'morgan@example.com', 'Already approved: Pick the movie'],
    ['cancelled', 'yes', null, 'Jordan cancelled that ask: Pick the movie'],
    ['cancelled', 'not-now', null, 'Jordan cancelled that ask: Pick the movie'],
  ]) {
    Object.assign(db.reward_asks[0], { status, decided_at: at(TODAY, '15:09'), decided_by: by });
    const rows = db.points_ledger.length;
    await page.click(`.hw-ask [data-act="${act}"]`);
    if (act === 'not-now') await page.click('.hw-ask form.hw-note button[type="submit"]');
    await settle(page);
    check(`${act === 'yes' ? 'Yes' : 'Not now'} on an ask already ${status} elsewhere: "${want}", nothing written, the ask goes`,
      (await lastToast(page)) === want && db.points_ledger.length === rows && db.reward_asks[0].status === status && !(await page.$('.hw-ask')),
      JSON.stringify([await toasts(page), db.points_ledger.length - rows, db.reward_asks[0].status]));
    Object.assign(db.reward_asks[0], { status: 'waiting', decided_at: null, decided_by: null });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(page, () => !!document.querySelector('.hw-ask'));
  }
  await page.click('.hw-ask [data-act="yes"]');
  await settle(page);
  check('Yes: decide_reward(ask, true); the trade comes off his balance', same(lastCall(db, 'decide_reward').body, { p_ask: 'a5c00000-0000-4000-8000-000000000001', p_approve: true })
    && db.points_ledger.some((l) => l.kind === 'trade' && l.delta === -100) && (await tc(page, '.hw-kidline')).startsWith('Jordan · 18 points'), await tc(page, '.hw-kidline'));
  check('Yes: a toast says so', /Pick the movie/.test(await lastToast(page)), await lastToast(page));
  await page.click('.hw-sugg [data-act="price"]');
  await page.fill('.hw-sugg form.hw-price [name="cost"]', '40');
  await page.click('.hw-sugg form.hw-price button[type="submit"]');
  await settle(page);
  const priced = writes(db, 'rewards', 'PATCH').slice(-1)[0] || {};
  check('Price it: the suggestion gets its price and is on', same(priced.body, { cost: 40, active: true }) && /id=eq\.eeee0000-0000-4000-8000-000000000001/.test(priced.query)
    && !(await page.$('.hw-sugg')), JSON.stringify(priced));

  // ---------- To check
  check('To check: "◆ Outline with 3 main points · Science project: river poster · ticked yesterday"', (await tc(page, '.hw-check .hw-check-line')) === 'Outline with 3 main points · Science project: river poster · ticked yesterday',
    await tc(page, '.hw-check'));
  await page.click('.hw-check [data-act="not-yet"]');
  await page.click('.hw-check form.hw-note button[type="submit"]');
  await sleep(150);
  check('Not yet needs a note: "Say what\'s missing." and no call', (await tc(page, '.hw-check form.hw-note .form-error')) === 'Say what\'s missing.' && !calls(db, 'homework_step').length,
    await tc(page, '.hw-check form.hw-note .form-error'));
  await page.click('.hw-check form.hw-note [data-act="cancel-note"]');
  await page.click('.hw-check [data-act="looks-done"]');
  await page.fill('.hw-check form.hw-note [name="text"]', 'Clear outline. The third point is the strongest.');
  await page.click('.hw-check form.hw-note button[type="submit"]');
  await settle(page);
  check('Looks done with a note: homework_step(check, the note); +20 paid', same(lastCall(db, 'homework_step').body, { p_step: db.homework_steps[2].id, p_action: 'check', p_text: 'Clear outline. The third point is the strongest.' })
    && db.points_ledger.some((l) => l.kind === 'milestone' && l.note === 'Outline with 3 main points' && l.delta === 20) && !(await page.$('.hw-check')), JSON.stringify(lastCall(db, 'homework_step').body));
  check('Looks done: "Checked: Outline with 3 main points" with Undo', (await lastToast(page)) === 'Checked: Outline with 3 main pointsUndo', await lastToast(page));
  await page.click('.toast-action .toast-btn');
  await settle(page);
  check('Undo: homework_step(uncheck); it is back under To check, the points gone', lastCall(db, 'homework_step').body.p_action === 'uncheck' && !!(await page.$('.hw-check'))
    && !db.points_ledger.some((l) => l.kind === 'milestone' && l.note === 'Outline with 3 main points'), JSON.stringify(lastCall(db, 'homework_step').body));
  await page.click('.hw-check [data-act="not-yet"]');
  await page.fill('.hw-check form.hw-note [name="text"]', 'Add a source for the second point.');
  await page.click('.hw-check form.hw-note button[type="submit"]');
  await settle(page);
  check('Not yet with a note: homework_step(not_yet, the note); unticked, nothing paid', same(lastCall(db, 'homework_step').body, { p_step: db.homework_steps[2].id, p_action: 'not_yet', p_text: 'Add a source for the second point.' })
    && !db.homework_steps[2].done_at && !(await page.$('.hw-check')), JSON.stringify(lastCall(db, 'homework_step').body));

  // ---------- To talk about
  check('To talk about: "Science project: river poster · “Full draft” was planned for Mon · Re-plan didn\'t reach it", to the assignment',
    (await tc(page, '.hw-talk')) === 'Science project: river poster · “Full draft” was planned for Mon · Re-plan didn\'t reach it ›' && (await page.getAttribute('.hw-talk', 'href')) === `#/homework/${SCI}`,
    await tc(page, '.hw-talk'));

  // ---------- Questions and notes
  const qa = await texts(page, '[data-sec="qa"] li');
  check('Questions and notes: the open question with Answer; Pat\'s answer and note, a parent\'s earlier answer (qa_log), the note sent back and the one before it, with who and when; nothing older than 7 days',
    same(qa.slice().sort(), [
      'Science project: river poster · “Does the poster need a title?” · asked yesterday 6:10pm Answer',
      'History timeline · Answered by Pat Lee, tutor · Mon 6:10pm: “Pages 40 to 52.” Clear',
      'History timeline · Pat\'s note on Timeline sketch · Tue 6:00pm: “Clear sketch. The dates are easy to follow.” Clear',
      'History timeline · Answered by you · Fri 7:00pm: “No, next Wednesday.” (earlier)',
      'Science project: river poster · Your note on Outline with 3 main points · today 3:10pm: “Add a source for the second point.” Clear',
      'Science project: river poster · A parent\'s note on Outline with 3 main points · today 3:10pm: “Clear outline. The third point is the strongest.” (earlier)',
    ].sort()) && qa[0].endsWith('Answer'), JSON.stringify(qa));
  await page.click('[data-sec="qa"] [data-act="answer"]');
  await page.fill('[data-sec="qa"] form.hw-note [name="text"]', 'Yes, a short title at the top.');
  await page.click('[data-sec="qa"] form.hw-note button[type="submit"]');
  await settle(page);
  check('Answer: homework_step(answer, the text); the answer shows by you', same(lastCall(db, 'homework_step').body, { p_step: db.homework_steps[4].id, p_action: 'answer', p_text: 'Yes, a short title at the top.' })
    && (await texts(page, '[data-sec="qa"] li')).some((l) => l.startsWith('Science project: river poster · Answered by you · today 3:10pm: “Yes, a short title at the top.”')),
    JSON.stringify(await texts(page, '[data-sec="qa"] li')));
  const pat = (await page.$$('[data-sec="qa"] li')).length;
  await page.click('[data-sec="qa"] li:has-text("Pages 40 to 52") [data-act="clear"]');
  await settle(page);
  const cleared = await texts(page, '[data-sec="qa"] li');
  check('Clear Pat\'s answer: homework_step(clear, answer); kept in qa_log and shown as cleared; the question is open again, to answer',
    same(lastCall(db, 'homework_step').body, { p_step: db.homework_steps.find((s) => s.title === 'Read chapter 2').id, p_action: 'clear', p_text: 'answer' })
    && cleared.includes('History timeline · Answered by Pat Lee, tutor · Mon 6:10pm: “Pages 40 to 52.” (cleared)')
    && cleared.includes('History timeline · “Which pages?” · asked Mon 5:00pm Answer') && cleared.length === pat + 1, JSON.stringify(cleared));

  // ---------- Assignments and lessons
  const arows = await texts(page, '[data-sec="assignments"] > .hw-arows > li .hw-arow');
  check('assignments by due date: given (n of m, given by), Quick (added by Jordan), a lesson with no plan, given by a parent',
    same(arows, [
      'Worksheet 5.1 Math · due tomorrow · added by Jordan Quick · 15 min',
      'Fractions practice Math · lesson · do by Mon No plan yet ›',
      'History timeline History · due Wed 1 of 4 · Given by you',
      'Science project: river poster Science · due Fri Nov 13 · added by Pat 2 of 8 · Given by Pat Lee, tutor',
    ]), JSON.stringify(arows));
  check('a given plan shows its two bars', (await page.$$('[data-sec="assignments"] > .hw-arows > li .plan-bars')).length === 3);
  check('Done (30 days) is folded, with the Spelling list and not the 41-day-old one', (await page.$eval('details.hw-done', (d) => !d.open)) && same(await page.$$eval('details.hw-done li .hw-arow-title', (es) => es.map((e) => e.textContent)), ['Spelling list']),
    JSON.stringify(await page.$$eval('details.hw-done li .hw-arow-title', (es) => es.map((e) => e.textContent))));

  // ---------- This week
  const week = await page.$$eval('[data-sec="week"] .plan-wday', (ds) => ds.map((d) => d.textContent.replace(/\s+/g, ' ').trim()));
  check('This week: seven days from today, with busy titles (Piano on Tuesday)', week.length === 7 && week[0].startsWith('Thu') && week[5].includes('Piano 5:00pm') && week[1].startsWith('Fri') && week[1].includes('—'),
    JSON.stringify(week));
  check('focused this week against last week, and the pace', (await tc(page, '[data-sec="week"] .hw-focused')) === '1 h 19 focused this week (last week 1 h 14) · Steps take about 1.2× the planned time',
    await tc(page, '[data-sec="week"] .hw-focused'));
  const blocks = await texts(page, '[data-sec="week"] .hw-blocks li');
  check('his blocks this week: day and time, length, with whom, result, his note',
    same(blocks.slice(0, 3), ['Today 3:00pm · 10 min · Stopped · Worksheet 5.1 ›', 'Yesterday 4:32pm · 20 min · Step done · Outline with 3 main points ›',
      'Tue 4:35pm · 20 min · with Pat · Step done · Find 2 sources and save their links ›'])
    && blocks.includes('Mon 4:45pm · 20 min · More to do · Find 2 sources and save their links · “found 2 sources” ›') && blocks.length === 5, JSON.stringify(blocks));

  // ---------- Points and rewards
  check('points: "18 · today +2 of 60 · milestones this week 20 of 160" (the owner\'s caps)', (await tc(page, '.hw-points-line')) === '18 · today +2 of 60 · milestones this week 20 of 160', await tc(page, '.hw-points-line'));
  check('the rewards in order, with the off one marked', same(await texts(page, '.hw-rewards li .hw-rw-line'), ['15 minutes of extra game time · 15', 'Choose Friday\'s dinner · 60', 'Skip one chore · 40', 'Pick the movie · 100', 'A new book · 150'])
    || same(await texts(page, '.hw-rewards li .hw-rw-line'), ['15 minutes of extra game time · 15', 'Choose Friday\'s dinner · 60', 'Pick the movie · 100', 'A new book · 150', 'Skip one chore · 40']),
    JSON.stringify(await texts(page, '.hw-rewards li .hw-rw-line')));
  const recent = await texts(page, '.hw-ledger li .hw-ledger-line');
  check('recent: the last 10 entries, newest first', recent.length === 10 && recent[0] === '−100 Pick the movie · today' && recent.includes('+2 Focus · Worksheet 5.1 · today'), JSON.stringify(recent));
  await page.click('[data-act="give"]');
  await page.fill('#formDialog form.hw-give [name="points"]', '10');
  await page.fill('#formDialog form.hw-give [name="note"]', 'Great session with Pat');
  await page.click('#formDialog form.hw-give button[type="submit"]');
  await settle(page);
  const gave = lastCall(db, 'give_points').body || {};
  check('Give points: give_points(kid, 10, the note, a new key)', gave.p_kid === ID.jordan && gave.p_points === 10 && gave.p_note === 'Great session with Pat' && UUID.test(gave.p_key || '')
    && !(await dialogOpen(page)) && (await tc(page, '.hw-points-line')).startsWith('28 ·'), JSON.stringify(gave));
  await page.click('.hw-ledger li:has-text("Outline with 3 main points") [data-act="void"]');
  await page.fill('#formDialog form.hw-void [name="note"]', 'Block left running while away');
  await page.click('#formDialog form.hw-void button[type="submit"]');
  await settle(page);
  check('Void: void_points(entry, the reason); −4 shown as "Void: …"', same(lastCall(db, 'void_points').body, { p_entry: 'eeee0000-0000-4000-8000-000000000011', p_note: 'Block left running while away' })
    && (await texts(page, '.hw-ledger li .hw-ledger-line'))[0] === '−4 Void: Block left running while away · today', JSON.stringify(await texts(page, '.hw-ledger li .hw-ledger-line')));
  await page.click('[data-act="add-reward"]');
  await page.fill('#formDialog form.hw-reward [name="title"]', 'Stay up 30 minutes later');
  await page.fill('#formDialog form.hw-reward [name="cost"]', '80');
  await page.click('#formDialog form.hw-reward button[type="submit"]');
  await settle(page);
  const radd = writes(db, 'rewards', 'POST').slice(-1)[0] || {};
  check('+ Reward: one insert, his, priced, on, not instant, last in order', same(radd.body, { kid_id: ID.jordan, title: 'Stay up 30 minutes later', cost: 80, active: true, instant: false, sort_order: 6 }), JSON.stringify(radd.body));
  // An instant reward (the owner's "immediate gratification"): he cashes it on the spot, no ask; the parents see it.
  await page.click('[data-act="add-reward"]');
  check('the reward dialog: "Instant: he gets it on the spot, no ask", with his limit a day', /Instant: he gets it on the spot, no ask \(you see it on Today; at most 2 a day\)/.test(await tc(page, '#formDialog form.hw-reward')),
    await tc(page, '#formDialog form.hw-reward'));
  await page.fill('#formDialog form.hw-reward [name="title"]', 'Ten minutes of music');
  await page.fill('#formDialog form.hw-reward [name="cost"]', '12');
  await page.check('#formDialog form.hw-reward [name="instant"]');
  await page.click('#formDialog form.hw-reward button[type="submit"]');
  await settle(page);
  const rinst = writes(db, 'rewards', 'POST').slice(-1)[0] || {};
  check('+ Reward, instant: one insert with instant on, and the list marks it', same(rinst.body, { kid_id: ID.jordan, title: 'Ten minutes of music', cost: 12, active: true, instant: true, sort_order: 7 })
    && (await texts(page, '.hw-rewards li .hw-rw-line')).includes('Ten minutes of music · 12 · instant'), JSON.stringify([rinst.body, await texts(page, '.hw-rewards li .hw-rw-line')]));
  // He cashed it in on his My day (decided by him at once): Recent says so, beside a milestone's first half. (Their
  // times are after the seeded 3:05pm block and apart from each other: rows at one time are ordered by their random ids.)
  const cashedAsk = 'a5c00000-0000-4000-8000-0000000000c1';
  db.reward_asks.push(askRow({ id: cashedAsk, kid_id: ID.jordan, title: 'Ten minutes of music', cost: 12, status: 'cashed', asked_at: at(TODAY, '15:07'),
    decided_at: at(TODAY, '15:07'), decided_by: 'Jordan (My day)' }));
  db.points_ledger.push(ledgerRow({ kid_id: ID.jordan, at: at(TODAY, '15:06'), day: TODAY, kind: 'milestone_done', delta: 20, note: 'Timeline draft', who: 'Jordan (My day)' }),
    ledgerRow({ kid_id: ID.jordan, at: at(TODAY, '15:07'), day: TODAY, kind: 'trade', delta: -12, ask_id: cashedAsk, note: 'Ten minutes of music', who: 'Jordan (My day)' }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await settle(page);
  check('Recent: "−12 Ten minutes of music (instant, cashed in by Jordan)" and "+20 Ticked: Timeline draft" (half a milestone, at his tick)',
    ((l) => { const i = l.indexOf('−12 Ten minutes of music (instant, cashed in by Jordan) · today'); return i >= 0 && l[i + 1] === '+20 Ticked: Timeline draft · today'; })(await texts(page, '.hw-ledger li .hw-ledger-line')),
    JSON.stringify(await texts(page, '.hw-ledger li .hw-ledger-line')));
  check('the points line counts both halves of milestones this week', /milestones this week 40 of 160/.test(await tc(page, '.hw-points-line')), await tc(page, '.hw-points-line'));

  // ---------- Switches
  const linkMeta = await tc(page, '.hw-link .hw-link-meta');
  check('Pat\'s link: its label, "English · Ends Apr 30 · Last used Sun 4:05pm"', (await tc(page, '.hw-link .hw-link-label')) === 'Pat Lee, tutor' && linkMeta === 'English · Ends Apr 30 · Last used Sun 4:05pm', linkMeta);
  const link = `${BASE}/day.html?h=${'ab'.repeat(16)}`;
  const msg = `Hi Pat, here is Jordan's homework page. It shows only his homework. Please open it on your own phone or computer:\n${link}`;
  check('WhatsApp and Text carry the message with the link', (await page.getAttribute('.hw-link a[data-via="whatsapp"]', 'href')) === `https://wa.me/?text=${encodeURIComponent(msg)}`
    && (await page.getAttribute('.hw-link a[data-via="sms"]', 'href')) === `sms:?&body=${encodeURIComponent(msg)}`, await page.getAttribute('.hw-link a[data-via="whatsapp"]', 'href'));
  await page.click('.hw-link [data-act="copy-link"]');
  await sleep(200);
  check('Copy: the link on the clipboard, and a toast', (await page.evaluate(() => navigator.clipboard.readText())) === link && /Copied/.test(await lastToast(page)), await lastToast(page));
  await page.click('.hw-link [data-act="extend"]');
  await settle(page);
  check('Extend 180 days: save_tutor_link with the end date 180 days later', same(lastCall(db, 'save_tutor_link').body, { p_link: 'a1110000-0000-4000-8000-000000000001', p_kid: ID.jordan,
    p_label: 'Pat Lee, tutor', p_language: 'en', p_expires_on: '2027-10-27', p_can_ai: true, p_active: true }), JSON.stringify(lastCall(db, 'save_tutor_link').body));
  await page.click('.hw-link [data-act="new-token"]');
  await settle(page);
  check('New link: asks first, then new_tutor_token; the old address stops', /stops working/.test((db.dialogs || []).slice(-1)[0] || '') && same(lastCall(db, 'new_tutor_token').body, { p_link: 'a1110000-0000-4000-8000-000000000001' })
    && db.tutor_links[0].token !== 'ab'.repeat(16) && (await page.getAttribute('.hw-link a[data-via="sms"]', 'href')).includes(db.tutor_links[0].token), (db.dialogs || []).slice(-1)[0]);
  await page.click('.hw-link [data-act="link-off"]');
  await settle(page);
  check('Off: save_tutor_link with p_active false; the row says Off', lastCall(db, 'save_tutor_link').body.p_active === false && /Off/.test(await tc(page, '.hw-link .hw-link-meta'))
    && !!(await page.$('.hw-link [data-act="link-on"]')), await tc(page, '.hw-link .hw-link-meta'));
  // A link that has ended (Oct 30) can still be turned off and renamed: its own end date is kept, and it stays ended.
  {
    const edb = fullDb();
    edb.tutor_links[0].expires_on = '2026-10-30';
    const e = await open({ label: 'ended link', db: edb });
    await e.page.click('.hw-link [data-act="link-off"]');
    await settle(e.page);
    check('an ended link: Off sends its own end date and the row says "Off · Ended Oct 30"', lastCall(e.db, 'save_tutor_link').body.p_expires_on === '2026-10-30'
      && e.db.tutor_links[0].active === false && /Off · Ended Oct 30/.test(await tc(e.page, '.hw-link .hw-link-meta')),
      `${await tc(e.page, '.hw-link .hw-link-meta')} ${JSON.stringify(await toasts(e.page))}`);
    await e.page.click('.hw-link [data-act="edit-link"]');
    await e.page.fill('form[data-form="link"] [name="label"]', 'Pat Lee, old tutor');
    await e.page.click('form[data-form="link"] button[type="submit"]');
    await settle(e.page);
    check('... and a new name is saved, still ending Oct 30', e.db.tutor_links[0].label === 'Pat Lee, old tutor' && e.db.tutor_links[0].expires_on === '2026-10-30'
      && e.db.tutor_links[0].active === false && (await tc(e.page, '.hw-link .hw-link-label')) === 'Pat Lee, old tutor', JSON.stringify(await toasts(e.page)));
    await e.context.close();
  }
  // A window focus while a new link's name and a points value are being typed: no read, both kept; after
  // Cancel, a focus reads again.
  let weekReads = calls(db, 'homework_week').length;
  await page.click('[data-act="add-link"]');
  await page.fill('form[data-form="link"] [name="label"]', 'Morgan Example, tutor');
  await page.fill('form[data-form="values"] [name="pts_on_time"]', '7');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(400);
  check('a window focus while a link\'s name and a points value are typed: no read, both kept', calls(db, 'homework_week').length === weekReads
    && (await page.inputValue('form[data-form="link"] [name="label"]').catch(() => '')) === 'Morgan Example, tutor'
    && (await page.inputValue('form[data-form="values"] [name="pts_on_time"]').catch(() => '')) === '7', `reads ${weekReads}->${calls(db, 'homework_week').length}`);
  await page.click('form[data-form="link"] [data-act="cancel-note"]');
  weekReads = calls(db, 'homework_week').length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await settle(page);
  check('... after Cancel, a window focus reads again', calls(db, 'homework_week').length === weekReads + 1 && (await page.inputValue('form[data-form="values"] [name="pts_on_time"]')) === '10',
    `reads ${weekReads}->${calls(db, 'homework_week').length}`);
  // Points values and both caps, saved with the updated_at check.
  await page.fill('form[data-form="values"] [name="pts_day_cap"]', '25');
  await page.fill('form[data-form="values"] [name="pts_milestone_week"]', '60');
  await page.click('form[data-form="values"] button[type="submit"]');
  await settle(page);
  const vals = writes(db, 'homework_kids', 'PATCH').slice(-1)[0] || {};
  check('points values: the daily cap and the weekly milestone cap saved, with the updated_at check (and the instant rewards a day)',
    same(vals.body, { pts_focus: 1, pts_on_time: 10, pts_milestone: 40, pts_day_cap: 25, pts_milestone_week: 60, instant_day: 2, focus_minutes: 10 })
    && /kid_id=eq\./.test(vals.query) && /updated_at=eq\./.test(vals.query) && db.homework_kids[0].pts_day_cap === 25, JSON.stringify(vals));
  check('the parents keep "of 25" in the points line', /today \+2 of 25 · milestones this week 40 of 60/.test(await tc(page, '.hw-points-line')), await tc(page, '.hw-points-line'));
  // Someone else changed it a moment ago: refused, said, and read again.
  db.homework_kids[0].updated_at = '2026-11-05T20:11:00.000000+00:00';
  await page.fill('form[data-form="values"] [name="pts_day_cap"]', '30');
  await page.click('form[data-form="values"] button[type="submit"]');
  await settle(page);
  check('a save on an old copy is refused and says so', db.homework_kids[0].pts_day_cap === 25 && /someone else changed/i.test(await lastToast(page)), await lastToast(page));
  // Homework time: Change opens the Calendar's own event form.
  await page.click('[data-act="change-time"]');
  await sleep(150);
  const added = await page.evaluate(() => window.__added || []);
  check('homework time: Change opens the Calendar\'s event form for that event', added.length === 1 && added[0].page === 'calendar' && added[0].defaults.id === db.homework_times[0].event_id, JSON.stringify(added));
  // Erase asks for ERASE.
  await page.click('[data-act="erase"]');
  await page.fill('#formDialog form.hw-erase [name="confirm"]', 'erase');
  await page.click('#formDialog form.hw-erase button[type="submit"]');
  await sleep(150);
  check('Erase: "erase" isn\'t ERASE: nothing called', !calls(db, 'erase_homework').length && (await tc(page, '#formDialog .form-error')) === 'Type ERASE to erase.', await tc(page, '#formDialog .form-error'));
  check('Erase says what it deletes and that the homework-time events stay', /assignments/.test(await tc(page, '#formDialog form.hw-erase')) && /stay on the calendar/.test(await tc(page, '#formDialog form.hw-erase')));
  await page.fill('#formDialog form.hw-erase [name="confirm"]', 'ERASE');
  await page.click('#formDialog form.hw-erase button[type="submit"]');
  await settle(page);
  check('Erase with ERASE: erase_homework(kid, ERASE); back to the first visit', same(lastCall(db, 'erase_homework').body, { p_kid: ID.jordan, p_confirm: 'ERASE' }) && !db.homework_kids.length
    && same(await texts(page, '.hw-setup [data-act="turn-on"]'), ['Turn on homework for Jordan']) && db.events.length === 3, JSON.stringify(lastCall(db, 'erase_homework').body));
  check('nothing on the page mentions the AI (that comes with PR B)', !/\bAI\b|Claude|Anthropic/.test(await text(page, 'body')));
  await page.context().close();

  // A ledger past the API's 1,000 rows (he never loses a row: about two school years of homework): 1,200
  // older +1s before this week's. The kid line, To approve and the points line count every row; Recent
  // is still the newest ten.
  {
    const long = fullDb();
    long.points_ledger.unshift(...Array.from({ length: 1200 }, (x, i) => { const day = addDays('2025-01-06', Math.floor(i / 4));
      return ledgerRow({ kid_id: ID.jordan, at: at(day, `1${6 + (i % 4)}:00`), day, kind: 'focus', delta: 1, note: 'Old block' }); }));
    ({ page, db, log } = await open({ label: 'long', db: long }));
    const pages = log.filter((l) => /^GET \/rest\/v1\/points_ledger\?/.test(l)).map(decodeURIComponent);
    check('1,212 ledger rows (past the API\'s 1,000): "Jordan · 1318 points", "balance 1318 (this week: +31 focus and on time, +20 milestones checked by Pat)", "1318 ·", Recent the newest',
      (await tc(page, '.hw-kidline')).startsWith('Jordan · 1318 points ·')
      && (await tc(page, '.hw-ask .hw-ask-line')) === 'Pick the movie · 100 · asked yesterday · balance 1318 (this week: +31 focus and on time, +20 milestones checked by Pat)'
      && (await tc(page, '.hw-points-line')).startsWith('1318 ·') && (await texts(page, '.hw-ledger li .hw-ledger-line'))[0] === '+2 Focus · Worksheet 5.1 · today',
      JSON.stringify([await tc(page, '.hw-kidline'), await tc(page, '.hw-ask .hw-ask-line'), await tc(page, '.hw-points-line'), (await texts(page, '.hw-ledger li .hw-ledger-line'))[0]]));
    check('... read a page at a time, oldest first, until an empty page', same(pages.map((l) => l.replace(/^GET \/rest\/v1\/points_ledger\?/, '')),
      [0, 1000, 1212].map((n) => `select=*&kid_id=eq.${ID.jordan}&order=at.asc,id.asc&offset=${n}&limit=1000`)), JSON.stringify(pages.map((l) => l.replace(/^.*\?/, ''))));
    await page.context().close();
  }

  // =====================================================================
  // 3. Homework off, points off
  // =====================================================================
  const off = fullDb();
  ({ page, db } = await open({ label: 'off', db: off }));
  await page.click('[data-row="kid"] input[data-act="kid-on"]');
  await settle(page);
  check('homework off: save_homework_kid(kid, false); his card goes, nothing deleted', same(lastCall(db, 'save_homework_kid').body, { p_kid: ID.jordan, p_active: false })
    && db.homework_kids[0].active === false && db.assignments.length === 6 && /Homework is off for Jordan/.test(await text(page, '#main')), await text(page, '.hw-kidline'));
  await page.click('[data-row="kid"] input[data-act="kid-on"]');
  await settle(page);
  await page.click('[data-row="points"] input[data-act="points-on"]');
  await settle(page);
  const pts = writes(db, 'homework_kids', 'PATCH').slice(-1)[0] || {};
  check('points off: points_on false (updated_at check); the points section says so, no Give points', same(pts.body, { points_on: false }) && /updated_at=eq\./.test(pts.query)
    && /Points are off for Jordan/.test(await tc(page, '[data-sec="points"]')) && !(await page.$('[data-act="give"]')), JSON.stringify(pts));
  await page.context().close();

  // =====================================================================
  // 4. Adding an assignment and a lesson; an assignment's page; the plan editor
  // =====================================================================
  // The stale save below is answered 400 (P0001), as PostgREST answers a raised error.
  ({ page, db } = await open({ label: 'add', allowConsole: /status of 400/ }));
  await page.click('[data-act="add-assignment"]');
  await sleep(150);
  check('+ Assignment: a form with the Live Text hint', (await tc(page, '#formDialog h3')) === 'New assignment'
    && (await tc(page, '#formDialog .hw-livetext')) === 'To use a photo of the sheet, copy its text with your phone\'s Live Text and paste it here. Photos aren\'t sent anywhere.');
  await page.click('#formDialog button[type="submit"]');
  await sleep(150);
  check('a title is needed', (await tc(page, '#formDialog .form-error')) === 'Give it a title.' && !writes(db, 'assignments', 'POST').length);
  await page.fill('#formDialog [name="title"]', 'Essay: a place I love');
  await page.fill('#formDialog [name="subject"]', 'English');
  await page.fill('#formDialog [name="due_date"]', '2026-11-20');
  await page.fill('#formDialog [name="details"]', 'Write 500 words.\nDescribe a place you love.\n\n\nUse three senses.');
  await page.click('#formDialog button[type="submit"]');
  await until(page, () => /^#\/homework\/[0-9a-f-]{36}$/.test(location.hash) && !!document.querySelector('.hw-a'));
  await settle(page);
  const apost = writes(db, 'assignments', 'POST')[0] || {};
  const newId = db.assignments.slice(-1)[0].id;
  check('Save: one insert for Jordan (kind, title, class, due date, the text with its lines; no stretch)', same(apost.body, { kid_id: ID.jordan, kind: 'assignment', title: 'Essay: a place I love',
    subject: 'English', due_date: '2026-11-20', details: 'Write 500 words.\nDescribe a place you love.\n\nUse three senses.', stretch: null }), JSON.stringify(apost.body));
  check('then its own page: #/homework/<id>, its title, "English · due Fri Nov 20 · Open"', (await page.evaluate(() => location.hash)) === `#/homework/${newId}`
    && (await text(page, '.hw-a h1')) === 'Essay: a place I love' && (await tc(page, '.hw-a .hw-a-meta')) === 'English · due Fri Nov 20 · Open', await tc(page, '.hw-a .hw-a-meta'));
  check('the teacher\'s text keeps its lines', (await page.inputValue('form.hw-afields [name="details"]')) === 'Write 500 words.\nDescribe a place you love.\n\nUse three senses.');
  check('no plan yet: the editor offers the starter plans', !!(await page.$(`${ED} .plan-editor`)) && (await tc(page, `${ED} .plan-empty`)).startsWith('No steps yet'));
  await page.click(`${ED} [data-act="starter"]`);
  check('the starter plan its title suggests is marked (an essay)', await page.$eval(`${ED} [data-starter="essay"]`, (b) => b.classList.contains('is-guess')));
  await page.click(`${ED} [data-starter="essay"]`);
  await settle(page);
  const sp = lastCall(db, 'save_homework_plan').body || {};
  check('a starter plan: save_homework_plan(rev 0, not given) with nine template steps, no days, each with a "done looks like" and no longer than his first length',
    sp.p_assignment === newId && sp.p_rev === 0 && sp.p_give === false && sp.p_steps.length === 9 && sp.p_steps.every((s) => s.day === null && s.source === 'template' && s.done_looks_like && s.minutes <= 20),
    JSON.stringify(sp).slice(0, 300));
  const placedDays = db.homework_steps.filter((s) => s.assignment_id === newId).map((s) => s.day);
  check('the database placed them: every step on a homework day, none on Friday or Saturday, the turn-in on the due date',
    placedDays.length === 9 && placedDays.every((d) => d >= TODAY) && placedDays[8] === '2026-11-20' && placedDays.slice(0, 8).every((d) => ![5, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())),
    JSON.stringify(placedDays));
  check('the editor shows them with their days, and fits', (await page.$$(`${ED} .plan-step`)).length === 9 && /Fits/.test(await tc(page, `${ED} .plan-ed-fit`)), await tc(page, `${ED} .plan-ed-fit`));
  // Edit a step: a new title.
  await page.click(`${ED} .plan-step[data-i="2"] [data-act="more"]`);
  await page.fill(`${ED} .plan-step-edit [name="title"]`, 'Find 2 photos of the place');
  await page.click(`${ED} [data-act="save"]`);
  await settle(page);
  let saved = lastCall(db, 'save_homework_plan').body;
  check('edit: the whole plan is saved, the changed step "typed", the rest as they were', saved.p_rev === 1 && saved.p_steps[2].title === 'Find 2 photos of the place' && saved.p_steps[2].source === 'typed'
    && saved.p_steps[0].source === 'template' && saved.p_steps.every((s) => UUID.test(s.id) || /^[0-9a-f-]{36}$/.test(s.id)), JSON.stringify(saved.p_steps[2]));
  // Milestone on and off.
  await page.click(`${ED} .plan-step[data-i="1"] [data-act="more"]`);
  await page.selectOption(`${ED} .plan-step-edit [name="kind"]`, 'milestone');
  await page.click(`${ED} [data-act="save"]`);
  await settle(page);
  check('milestone on: saved with kind milestone', lastCall(db, 'save_homework_plan').body.p_steps[1].kind === 'milestone' && db.homework_steps.find((s) => s.assignment_id === newId && s.pos === 2).kind === 'milestone');
  await page.click(`${ED} .plan-step[data-i="1"] [data-act="more"]`);
  await page.selectOption(`${ED} .plan-step-edit [name="kind"]`, 'step');
  await page.click(`${ED} [data-act="save"]`);
  await settle(page);
  check('milestone off: saved with kind step', lastCall(db, 'save_homework_plan').body.p_steps[1].kind === 'step');
  // Move and delete.
  const order0 = db.homework_steps.filter((s) => s.assignment_id === newId).sort((a, b) => a.pos - b.pos).map((s) => s.title);
  await page.click(`${ED} .plan-step[data-i="4"] [data-act="more"]`);
  await page.click(`${ED} .plan-step-edit [data-act="up"]`);
  await page.click(`${ED} .plan-step-edit [data-act="delete"]`);
  await page.click(`${ED} [data-act="save"]`);
  await settle(page);
  const order1 = db.homework_steps.filter((s) => s.assignment_id === newId).sort((a, b) => a.pos - b.pos).map((s) => s.title);
  check('move up, then delete: eight steps, that one gone', order1.length === 8 && !order1.includes(order0[4]) && order1[3] === order0[3], JSON.stringify(order1));
  // Place again: the steps not done without days.
  await page.click(`${ED} [data-act="place"]`);
  await settle(page);
  saved = lastCall(db, 'save_homework_plan').body;
  check('Place again: every step not done is sent without a day', saved.p_steps.every((s) => s.day === null), JSON.stringify(saved.p_steps.map((s) => s.day)));
  // Give Jordan this plan.
  await page.click(`${ED} [data-act="give"]`);
  await settle(page);
  check('Give Jordan this plan: p_give true; "On Jordan\'s My day since today · by you"', lastCall(db, 'save_homework_plan').body.p_give === true && !!db.assignments.find((a) => a.id === newId).given_at
    && (await tc(page, `${ED} .plan-given`)) === 'On Jordan\'s My day since today · by you', await tc(page, `${ED} .plan-given`));
  // A stale save: Pat changed the plan meanwhile.
  const a1 = db.assignments.find((a) => a.id === newId);
  db.homework_steps.push(stepRow({ assignment_id: newId, pos: 9, title: 'Read it aloud once', minutes: 10, day: '2026-11-17', source: 'typed' }));
  db.homework_steps.find((s) => s.assignment_id === newId && s.kind === 'turn_in').pos = 10;
  a1.plan_rev += 1;
  await page.click(`${ED} .plan-step[data-i="0"] [data-act="more"]`);
  await page.fill(`${ED} .plan-step-edit [name="title"]`, 'Copy the instructions into your notes');
  await page.click(`${ED} [data-act="save"]`);
  await settle(page);
  check('a save on an old copy: refused, read again, "Changed since you opened it: here it is now."', (await tc(page, `${ED} .plan-msg`)) === 'Changed since you opened it: here it is now.'
    && (await texts(page, `${ED} .plan-step .plan-step-title`)).includes('Read it aloud once') && !db.homework_steps.some((s) => s.title === 'Copy the instructions into your notes'),
    await tc(page, `${ED} .plan-msg`));
  // Doesn't fit: a long plan due tomorrow.
  await page.fill('form.hw-afields [name="due_date"]', '2026-11-06');
  await page.click('form.hw-afields button[type="submit"]');
  await settle(page);
  const ap = writes(db, 'assignments', 'PATCH').slice(-1)[0] || {};
  saved = lastCall(db, 'save_homework_plan').body;
  check('a moved due date: only the changed field is saved, then the steps now after the last work day are placed again',
    same(ap.body, { due_date: '2026-11-06' }) && saved.p_steps.filter((s) => s.day === null).length > 0 && /steps? moved: due date changed/.test((await toasts(page)).join(' | ')),
    JSON.stringify([ap.body, (await toasts(page)).join(' | ')]));
  check('Doesn\'t fit: the editor says so', /Doesn't fit: add homework time, drop a step or talk to the teacher\./.test(await tc(page, `${ED} .plan-ed-fit`)), await tc(page, `${ED} .plan-ed-fit`));
  // Mark done, then Drop and Delete on a lesson.
  await page.click('[data-act="mark-done"]');
  await settle(page);
  check('Mark done: status done', same(writes(db, 'assignments', 'PATCH').slice(-1)[0].body, { status: 'done' }) && db.assignments.find((a) => a.id === newId).status === 'done'
    && /Done/.test(await tc(page, '.hw-a .hw-a-meta')));
  await page.click('[data-act="reopen"]');
  await settle(page);
  check('Open again: status open', same(writes(db, 'assignments', 'PATCH').slice(-1)[0].body, { status: 'open' }) && db.assignments.find((a) => a.id === newId).status === 'open');
  await go(page, '#/homework');
  await page.click('[data-act="add-lesson"]');
  await sleep(150);
  check('+ Lesson: "New lesson", "Do by" and instructions', (await tc(page, '#formDialog h3')) === 'New lesson' && /Do by/.test(await tc(page, '#formDialog')) && /Instructions for Jordan/.test(await tc(page, '#formDialog')));
  await page.fill('#formDialog [name="title"]', 'Fractions practice 2');
  await page.fill('#formDialog [name="due_date"]', '2026-11-12');
  await page.click('#formDialog button[type="submit"]');
  await until(page, () => /^#\/homework\/[0-9a-f-]{36}$/.test(location.hash) && !!document.querySelector('.hw-a'));
  await settle(page);
  const lesson = db.assignments.slice(-1)[0];
  check('a lesson: kind lesson; its page says "do by"', lesson.kind === 'lesson' && /do by Thu Nov 12/.test(await tc(page, '.hw-a .hw-a-meta')), await tc(page, '.hw-a .hw-a-meta'));
  await page.click('[data-act="copy-week"]');
  await settle(page);
  const copy = writes(db, 'assignments', 'POST').slice(-1)[0] || {};
  check('Copy to next week: a copy seven days later', copy.body && copy.body.title === 'Fractions practice 2' && copy.body.due_date === '2026-11-19' && copy.body.kind === 'lesson', JSON.stringify(copy.body));
  await page.click('[data-act="drop"]');
  await settle(page);
  check('Drop: status dropped', same(writes(db, 'assignments', 'PATCH').slice(-1)[0].body, { status: 'dropped' }));
  await page.click('[data-act="delete-assignment"]');
  await until(page, () => location.hash === '#/homework');
  await settle(page);
  check('Delete: asks first, then deletes it, back to the list', writes(db, 'assignments', 'DELETE').length === 1 && !db.assignments.some((a) => a.id === lesson.id) && /Delete/.test((db.dialogs || []).slice(-1)[0] || ''));
  await page.context().close();

  // The Science project's page: its steps, questions and notes, and its blocks.
  ({ page, db } = await open({ label: 'sci', path: `/#/homework/${SCI}` }));
  check('an assignment: "Science · due Fri Nov 13 · added by Pat · Open"', (await tc(page, '.hw-a .hw-a-meta')) === 'Science · due Fri Nov 13 · added by Pat · Open', await tc(page, '.hw-a .hw-a-meta'));
  check('its stretch question, in its field', (await page.inputValue('form.hw-afields [name="stretch"]')) === 'Which part of the river would you most like to show in detail?');
  check('the editor: given by Pat Lee, tutor (the link\'s label)', /On Jordan's My day since Sun · by Pat Lee, tutor/.test(await tc(page, `${ED} .plan-given`)), await tc(page, `${ED} .plan-given`));
  check('its questions and notes, step by step', same(await texts(page, '.hw-a-qa li'), ['Draft the first half Jordan asked: “Does the poster need a title?” Answer']), JSON.stringify(await texts(page, '.hw-a-qa li')));
  await page.click('.hw-a-qa [data-act="answer"]');
  check('Answer on the assignment: the answer box opens, focused', await page.evaluate(() => document.activeElement && document.activeElement.matches('.hw-a-qa form.hw-note [name="text"]')));
  await page.fill('.hw-a-qa form.hw-note [name="text"]', 'Yes, at the top.');
  await page.click('.hw-a-qa form.hw-note button[type="submit"]');
  await settle(page);
  check('Answer on the assignment: homework_step(answer); shown under the step, by you', same(lastCall(db, 'homework_step').body, { p_step: db.homework_steps[4].id, p_action: 'answer', p_text: 'Yes, at the top.' })
    && /You · Thu Nov 5 3:10pm: “Yes, at the top.”/.test(await tc(page, '.hw-a-qa')) && !(await page.$('.hw-a-qa [data-act="answer"]')), await tc(page, '.hw-a-qa'));
  const ablocks = await texts(page, '.hw-a-blocks li');
  check('its blocks: day, length, with whom, result, his note', ablocks.length === 4 && ablocks.includes('Tue Nov 3 4:35pm · 20 min · with Pat · Step done · Find 2 sources and save their links'), JSON.stringify(ablocks));
  check('the page shows no AI part', !/\bAI\b|Claude|Anthropic/.test(await text(page, 'body')));
  await page.context().close();

  // A moved due date places again from the plan as it is now, not the page's copy: while the date is
  // being typed, Jordan makes a step smaller and moves one with Not today on his phone (plan_rev 7 → 9).
  // His new step and his move are kept; only the steps the new date leaves behind are placed again.
  ({ page, db } = await open({ label: 'sci-due', path: `/#/homework/${SCI}` }));
  {
    const sci = db.assignments.find((a) => a.id === SCI);
    const mine = () => db.homework_steps.filter((s) => s.assignment_id === SCI).sort((a, b) => a.pos - b.pos);
    await page.fill('form.hw-afields [name="due_date"]', '2026-11-12');
    const first = mine().find((s) => s.title === 'Draft the first half');
    mine().filter((s) => s.pos >= first.pos).forEach((s) => { s.pos += 1; });
    db.homework_steps.push(stepRow({ assignment_id: SCI, pos: first.pos - 1, title: 'Write the first sentence', minutes: 10, day: TODAY, source: 'typed', updated_by: KID }));
    Object.assign(mine().find((s) => s.title === 'Draft the second half'), { day: '2026-11-10', moved_from: '2026-11-09' });
    sci.plan_rev += 2;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));   // held back: the fields are being edited
    await page.click('form.hw-afields button[type="submit"]');
    await settle(page);
    const sent = lastCall(db, 'save_homework_plan').body || {};
    const after = mine();
    check('a moved due date after Jordan changed the plan: sent with plan_rev 9 and his new step; his step and his Not today kept; only the turn-in placed again',
      sent.p_rev === 9 && (sent.p_steps || []).some((x) => x.title === 'Write the first sentence') && after.some((x) => x.title === 'Write the first sentence')
      && after.find((x) => x.title === 'Draft the second half').day === '2026-11-10' && after.find((x) => x.kind === 'turn_in').day === '2026-11-12'
      && /1 step moved: due date changed/.test((await toasts(page)).join(' | ')),
      JSON.stringify([sent.p_rev, (await toasts(page)).join(' | '), after.map((x) => `${x.title}@${x.day}`)]));
  }
  await page.context().close();
  // ... and a change made between that read and the save (plan_rev moves on once more) is refused once,
  // read again and kept: never undone.
  ({ page, db } = await open({ label: 'sci-race', path: `/#/homework/${SCI}`, allowConsole: /status of 400/ }));
  {
    const sci = db.assignments.find((a) => a.id === SCI);
    let raced = false;
    await page.route('**/rest/v1/rpc/save_homework_plan', async (route) => {
      if (route.request().method() === 'POST' && !raced) {
        raced = true;
        const last = db.homework_steps.filter((s) => s.assignment_id === SCI).sort((a, b) => a.pos - b.pos).slice(-1)[0];
        last.pos += 1;
        db.homework_steps.push(stepRow({ assignment_id: SCI, pos: last.pos - 1, title: 'Read it aloud once', minutes: 10, day: '2026-11-09', source: 'typed', updated_by: PAT }));
        sci.plan_rev += 1;
      }
      return route.fallback();
    });
    await page.fill('form.hw-afields [name="due_date"]', '2026-11-12');
    await page.click('form.hw-afields button[type="submit"]');
    await settle(page);
    const saves = calls(db, 'save_homework_plan');
    check('a change landing during the save: refused once (plan_rev), read again, saved with it kept',
      saves.length === 2 && saves[1].body.p_rev === 8 && saves[1].body.p_steps.some((x) => x.title === 'Read it aloud once')
      && db.homework_steps.some((x) => x.assignment_id === SCI && x.title === 'Read it aloud once')
      && db.homework_steps.find((x) => x.assignment_id === SCI && x.kind === 'turn_in').day === '2026-11-12' && /steps? moved: due date changed/.test((await toasts(page)).join(' | ')),
      JSON.stringify([saves.map((c) => c.body.p_rev), (await toasts(page)).join(' | ')]));
  }
  await page.context().close();
  // A step ticked early, then a due date moved before its day: the done step goes without a day (the
  // database keeps it as it is), so the plan can still be saved, from the fields and from the editor.
  {
    const d = fullDb();
    Object.assign(d.homework_steps.find((x) => x.title === 'Draft the second half'), { done_at: at(TODAY, '15:00'), done_by: KID });   // its day: Mon Nov 9
    ({ page, db } = await open({ label: 'early-tick', db: d, path: `/#/homework/${SCI}` }));
    const doneIds = new Set(db.homework_steps.filter((x) => x.assignment_id === SCI && x.done_at).map((x) => x.id));
    await page.fill('form.hw-afields [name="due_date"]', '2026-11-08');
    await page.click('form.hw-afields button[type="submit"]');
    await settle(page);
    const sent = (lastCall(db, 'save_homework_plan').body || {}).p_steps || [];
    const open2 = db.homework_steps.filter((x) => x.assignment_id === SCI && !x.done_at);
    check('a due date moved before a step ticked early: done steps sent without a day; "2 steps moved: due date changed"; nothing open after Sun Nov 8',
      sent.length === 8 && sent.filter((x) => doneIds.has(x.id)).every((x) => x.day === null) && (await toasts(page)).some((x) => x === '2 steps moved: due date changed')
      && open2.every((x) => x.day <= '2026-11-08') && db.homework_steps.find((x) => x.title === 'Draft the second half').day === '2026-11-09',
      JSON.stringify([(await toasts(page)).join(' | '), open2.map((x) => x.day)]));
    const before = calls(db, 'save_homework_plan').length;
    await page.click(`${ED} [data-act="place"]`);
    await settle(page);
    const placed = lastCall(db, 'save_homework_plan').body || {};
    check('... and the editor\'s Place again saves too, its done steps without a day', calls(db, 'save_homework_plan').length === before + 1 && !(await tc(page, `${ED} .plan-msg`))
      && (placed.p_steps || []).filter((x) => doneIds.has(x.id)).length === 4 && placed.p_steps.every((x) => x.day === null), await tc(page, `${ED} .plan-msg`));
    await page.context().close();
  }

  // =====================================================================
  // 5. Sam reads it all, with no buttons
  // =====================================================================
  ({ page, db, log } = await open({ label: 'sam', email: 'sam@example.com' }));
  check('Sam: the same sections, but no tutor links (they are the parents\' only)', same(await secs(page), ['approve', 'check', 'talk', 'qa', 'assignments', 'week', 'points', 'switches'])
    && !(await page.$('.hw-link')), JSON.stringify(await secs(page)));
  const samButtons = await page.$$eval('#main button:not([disabled]), #main input:not([disabled]), #main select:not([disabled])', (es) => es.map((e) => e.dataset.act || e.name || e.className));
  check('Sam: no button anywhere on the page (Done (30 days) is a fold, not a button)', samButtons.length === 0, JSON.stringify(samButtons));
  check('Sam: the switches say "Only parents can change these."', /Only parents can change these\./.test(await tc(page, '[data-sec="switches"]')));
  check('Sam: his ask, still with the balance', /balance 118/.test(await tc(page, '.hw-ask')));
  await go(page, `#/homework/${SCI}`);
  check('Sam on an assignment: the teacher\'s text as text, the steps listed, no editor and no fields', !(await page.$('.plan-editor')) && !(await page.$('form.hw-afields'))
    && (await page.$$('.hw-steps-ro li')).length === 8 && (await text(page, '.hw-a-text')).startsWith('Make a poster about a river.\nShow its source'), await text(page, '.hw-a-text'));
  await page.context().close();

  // =====================================================================
  // 6. A hostile title and text are drawn as text; two kids
  // =====================================================================
  const evil = fullDb();
  evil.people.push(person('f00d0000-0000-4000-8000-000000000016', 'Riley Example', 'kid', '#0891b2', 6));
  evil.homework_kids.push(hwKidRow({ kid_id: 'f00d0000-0000-4000-8000-000000000016' }));
  const bad = assignmentRow({ kid_id: ID.jordan, title: '<img src=x onerror="window.__pwned=1">', subject: '<b>Art</b>', due_date: '2026-11-10',
    details: '<script>window.__pwned=2</script>\n<a href="javascript:alert(1)">rubric</a>', stretch: '"><img src=x onerror=window.__pwned=3>' });
  evil.assignments.push(bad);
  evil.homework_steps.push(stepRow({ assignment_id: bad.id, title: '<i>step</i>', day: '2026-11-09', question: '<img src=y onerror=window.__pwned=4>', question_at: at(TODAY, '14:00') }));
  ({ page, db } = await open({ label: 'evil', db: evil }));
  check('a hostile title, class and question show as text', (await texts(page, '.hw-arow-title')).includes('<img src=x onerror="window.__pwned=1">')
    && (await tc(page, '[data-sec="qa"]')).includes('<img src=y onerror=window.__pwned=4>') && !(await page.evaluate(() => window.__pwned)));
  check('two kids: a kid picker, Jordan first', same(await page.$$eval('select[name="kid"] option', (os) => os.map((o) => o.textContent)), ['Jordan', 'Riley']));
  await go(page, `#/homework/${bad.id}`);
  check('a hostile teacher\'s text and stretch question stay text in their fields', (await page.inputValue('form.hw-afields [name="details"]')).startsWith('<script>')
    && !(await page.evaluate(() => window.__pwned)) && !(await page.$('.hw-a a[href^="javascript"]')));
  await go(page, '#/homework');
  await page.selectOption('select[name="kid"]', 'f00d0000-0000-4000-8000-000000000016');
  await settle(page);
  check('picking Riley shows his homework', (await tc(page, '.hw-kidline')).startsWith('Riley · 0 points · No homework time set'), await tc(page, '.hw-kidline'));
  await go(page, `#/homework/${SCI}`);
  check('Jordan\'s assignment opened while Riley is picked: it opens, as Jordan\'s', (await text(page, '.hw-a h1')) === 'Science project: river poster');
  await go(page, '#/homework');
  check('and the list is Jordan\'s again', (await tc(page, '.hw-kidline')).startsWith('Jordan ·') && (await page.inputValue('select[name="kid"]')) === ID.jordan);
  await page.context().close();

  // =====================================================================
  // 7. A failed read; an unknown assignment
  // =====================================================================
  const failing = fullDb();
  failing.hwFail = { homework_week: { __status: 500, body: { code: 'XX000', message: 'Database restarting', details: null, hint: null } } };
  ({ page, db } = await open({ label: 'fail', db: failing, allowConsole: /status of 500/ }));
  check('the week can\'t be read: the page still draws, This week says so', /couldn't be loaded/.test(await tc(page, '[data-sec="week"]')) && !!(await page.$('.hw-ask')), await tc(page, '[data-sec="week"]'));
  await go(page, '#/homework/a5c10000-0000-4000-8000-0000000000ff');
  check('an unknown assignment: says so, with the way back', /isn't on the list/.test(await tc(page, '.hw-a')) && !!(await page.$('.hw-a a.back')), await tc(page, '.hw-a'));
  await page.context().close();

  // =====================================================================
  // 8. Phones and desktops, light and dark
  // =====================================================================
  for (const [size, ctxOpts] of [['phone', phone], ['desktop', { viewport: { width: 1280, height: 900 } }]]) {
    for (const scheme of ['light', 'dark']) {
      ({ page } = await open({ label: `shot-${size}-${scheme}`, ctx: Object.assign({ colorScheme: scheme }, ctxOpts) }));
      check(`${size} (${scheme}): no sideways scroll`, await noSideScroll(page));
      if (size === 'phone') {
        const small = await page.$$eval('#main button, #main a.btn, #main .hw-arow, #main select, #main input[type="checkbox"]',
          (els) => els.filter((e) => e.offsetParent).map((e) => { const t = e.matches('input[type="checkbox"]') ? e.closest('label') : e; const r = t.getBoundingClientRect(); return [e.dataset.act || e.className, Math.round(r.width), Math.round(r.height)]; })
            .filter(([, wd, ht]) => wd < 44 || ht < 44));
        check(`phone (${scheme}): every tap target is at least 44px`, !small.length, JSON.stringify(small.slice(0, 5)));
        check(`phone (${scheme}): Homework is under More, not in the bottom bar`, !(await page.$('.bottombar a[data-tab="homework"]')));
      }
      await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: SHOTS + `homework-${size}-${scheme}.png`, fullPage: true });
      if (scheme === 'light') {
        await go(page, `#/homework/${SCI}`);
        check(`${size}: an assignment has no sideways scroll`, await noSideScroll(page));
        await page.screenshot({ path: SHOTS + `homework-${size}-assignment.png`, fullPage: true });
      }
      await page.context().close();
    }
  }

  // =====================================================================
  // 9. School links (schema 6, 0006; docs/v1.3-homework.md §11, §12.8)
  // =====================================================================
  // The made-up school's host is academy.school.example (the database's .myschoolapp.com, replaced in tests).
  const RPC6 = Object.assign({}, RPC, { hub_schema_version: () => 6 }, schoolRpc);
  const SECRET = 'SECRETMARKER7f3a';
  const LINK = (z) => `academy.school.example/podium/feed/iCal.aspx?z=${z}`;
  const FEED = (f) => `[data-row="school"] .hw-feed[data-feed="${f}"]`;
  const LAB = 'a5c10000-0000-4000-8000-000000000006';
  const schoolDb = () => {
    const d = withSchool(fullDb());
    d.assignments.push(assignmentRow({ id: LAB, kid_id: ID.jordan, added_by: 'school', title: 'Lab report', subject: 'Biology',
      due_date: '2026-11-20', created_by: 'Jordan Example (My day)', updated_by: 'Jordan Example (My day)' }));
    return d;
  };
  const pageKeeps = async (page) => page.evaluate(() => {
    const all = [document.documentElement.outerHTML, location.href, document.title, [...document.querySelectorAll('input, textarea')].map((i) => i.value).join(' ')];
    try { all.push(JSON.stringify(Object.assign({}, localStorage)), JSON.stringify(Object.assign({}, sessionStorage))); } catch (e) { all.push('storage?'); }
    return all.join('\n');
  });
  {
    // Schema 5: no row, no request.
    ({ page, db } = await open({ label: 'school-5', db: withSchool(fullDb()) }));
    check('schema 5: no School links row and no school_feed_status request', !(await page.$('[data-row="school"]')) && !calls(db, 'school_feed_status').length
      && !!(await page.$('[data-row="links"]')), JSON.stringify(calls(db, 'school_feed_status')));
    await page.context().close();
  }
  {
    // The refused links below come back as 400 (22023), which Chrome logs.
    ({ page, db } = await open({ label: 'school', db: schoolDb(), rpc: RPC6, allowConsole: /status of 400/ }));
    const said = [];
    page.on('console', (m) => said.push(m.text()));
    check('schema 6: school_feed_status read once, for Jordan', same(calls(db, 'school_feed_status').map((c) => c.body), [{ p_kid: ID.jordan }]),
      JSON.stringify(calls(db, 'school_feed_status').map((c) => c.body)));
    check('School links: a row of the switches, after the tutor links and before Erase', same(await page.$$eval('[data-sec="switches"] .hw-switch-row', (rs) => rs.map((r) => r.dataset.row)),
      ['kid', 'points', 'time', 'links', 'school', 'erase']), JSON.stringify(await page.$$eval('[data-sec="switches"] .hw-switch-row', (rs) => rs.map((r) => r.dataset.row))));
    check('School links: what it does, and that a link is never shown again', /Home Hub reads them every hour/.test(await tc(page, '[data-row="school"] .hw-switch-line'))
      && /never shown again/.test(await tc(page, '[data-row="school"] .hw-switch-line')), await tc(page, '[data-row="school"] .hw-switch-line'));
    check('the three links, each "Not added" with Add link: Assignments, Schedule, Games/Practices; no Check now, no date check',
      same(await texts(page, '[data-row="school"] .hw-feed .hw-feed-name'), ['Assignments', 'Schedule', 'Games/Practices'])
      && same(await texts(page, '[data-row="school"] .hw-feed .hw-feed-state'), ['Not added', 'Not added', 'Not added'])
      && same(await texts(page, '[data-row="school"] .hw-feed button'), ['Add link', 'Add link', 'Add link'])
      && !(await page.$('[data-act="school-now"]')) && !(await page.$('[data-ref="school-check"]')), await tc(page, '[data-row="school"]'));
    check('each link says what it becomes: his homework, marked from school; busy time',
      same(await texts(page, '[data-row="school"] .hw-feed .hw-feed-what'), ['Jordan\'s assignments, as homework marked "from school"', 'His classes, as busy time', 'Games and practices, as busy time']),
      JSON.stringify(await texts(page, '[data-row="school"] .hw-feed .hw-feed-what')));
    const how = await tc(page, '[data-row="school"] details.hw-school-how');
    check('How to copy a link: folded, the plain steps on a parent\'s own login (the feed button, WebCal Feed for External Calendar, Individual Filter Feeds, Copy Link Address), the 2 months and 12 months, up to an hour',
      !(await page.$eval('[data-row="school"] details.hw-school-how', (d) => d.open)) && (await tc(page, '[data-row="school"] details.hw-school-how summary')) === 'How to copy a link'
      && /your own parent login/.test(how) && /Jordan's Calendars/.test(how) && /WebCal Feed for External Calendar/.test(how) && /Individual Filter Feeds/.test(how)
      && /right-click Assignments and choose Copy Link Address/.test(how) && /Check now, and check the dates/.test(how) && /past 2 months and the next 12/.test(how)
      && /up to an hour/.test(how) && /anyone who has it can read/.test(how) && (await page.$$('[data-row="school"] details.hw-school-how ol li')).length === 5, how);
    check('"from school" on an assignment made from school', (await texts(page, '.hw-arows .hw-arow-sub')).includes('Biology · due Fri Nov 20 · from school'), JSON.stringify(await texts(page, '.hw-arows .hw-arow-sub')));

    // ---- Add link: the form, the checks before anything is sent, a refusal from the database
    await page.click('[data-row="school"] details.hw-school-how summary');
    await page.click(`${FEED('assignments')} [data-act="school-add"]`);
    check('the how-to, opened, stays open when Add link opens the box beside it', await page.$eval('[data-row="school"] details.hw-school-how', (d) => d.open).catch(() => false));
    const input = `${FEED('assignments')} form[data-form="school"] input[name="url"]`;
    const attrs = await page.$eval(input, (i) => ({ type: i.type, ac: i.getAttribute('autocomplete'), cap: i.getAttribute('autocapitalize'), sp: i.getAttribute('spellcheck'), max: i.maxLength,
      focus: document.activeElement === i, label: i.closest('label').querySelector('span').textContent })).catch(() => null);
    check('Add link: a box for the link (a url field, no autocomplete, no autocapitalize, no spellcheck, at most 500), focused',
      !!attrs && attrs.type === 'url' && attrs.ac === 'off' && attrs.cap === 'off' && attrs.sp === 'false' && attrs.max === 500 && attrs.focus && attrs.label === 'Paste the Assignments link', JSON.stringify(attrs));
    const formErr = `${FEED('assignments')} form[data-form="school"] .form-error`;
    await page.click(`${FEED('assignments')} form[data-form="school"] button[type="submit"]`);
    await sleep(150);
    check('an empty box: "Paste the link first." and nothing sent', (await tc(page, formErr)) === 'Paste the link first.' && !calls(db, 'set_school_feed').length, await tc(page, formErr));
    await page.fill(input, `http://${LINK(SECRET)}`);
    await page.click(`${FEED('assignments')} form[data-form="school"] button[type="submit"]`);
    await sleep(150);
    check('an http:// link: refused on the page, nothing sent', /^That isn't a calendar feed link/.test(await tc(page, formErr)) && !calls(db, 'set_school_feed').length, await tc(page, formErr));
    // A window focus while the link is in the box: no read, the box kept.
    const reads = calls(db, 'school_feed_status').length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(400);
    check('a window focus while a link is in the box: no read, the box kept', calls(db, 'school_feed_status').length === reads && (await page.inputValue(input).catch(() => '')) === `http://${LINK(SECRET)}`);
    await page.fill(input, `https://calendar.example.com/podium/feed/iCal.aspx?z=${SECRET}`);
    await page.click(`${FEED('assignments')} form[data-form="school"] button[type="submit"]`);
    await until(page, () => !document.querySelector('#main [aria-busy="true"]') && !!document.querySelector('[data-row="school"] form[data-form="school"] .form-error:not([hidden])'));
    check('a link on another host: the database refuses it in its own words, and the form says so (still open, nothing saved)',
      calls(db, 'set_school_feed').length === 1 && (await tc(page, formErr)) === "That isn't a school calendar link. Copy it from the calendar's feed button: it starts with webcal:// or https:// and has /podium/feed/iCal.aspx?z= in it."
      && !!(await page.$(input)) && !db.school_feeds.length, await tc(page, formErr));

    // ---- Saved: webcal:// sent as https://; never shown back
    await page.fill(input, `  webcal://${LINK(SECRET)}  `);
    await page.click(`${FEED('assignments')} form[data-form="school"] button[type="submit"]`);
    await settle(page);
    const feedA = () => db.school_feeds.find((f) => f.kind === 'assignments');
    check('Save: set_school_feed(kid, assignments, the link with webcal:// as https://, trimmed)', same(lastCall(db, 'set_school_feed').body,
      { p_kid: ID.jordan, p_kind: 'assignments', p_url: `https://${LINK(SECRET)}` }) && db.school_feeds.length === 1 && schoolUrlOf(db, feedA().id) === `https://${LINK(SECRET)}`,
    JSON.stringify(lastCall(db, 'set_school_feed').body));
    check('... "Assignments link saved. Home Hub reads it within the hour.", the status read again', (await lastToast(page)) === 'Assignments link saved. Home Hub reads it within the hour.'
      && calls(db, 'school_feed_status').length === reads + 1, await lastToast(page));
    check('... the link: "Added · first read within the hour", its host and last 4 characters ("academy.school.example …f3a" style), Replace, Pause and Remove; no box',
      (await tc(page, `${FEED('assignments')} .hw-feed-state`)) === 'Added · first read within the hour' && (await tc(page, `${FEED('assignments')} .hw-feed-link`)) === 'academy.school.example …7f3a'
      && same(await texts(page, `${FEED('assignments')} button`), ['Replace', 'Pause', 'Remove']) && !(await page.$(input)), await tc(page, FEED('assignments')));
    check('... Check now, and "Check the dates" waiting for the first read', !!(await page.$('[data-row="school"] [data-act="school-now"]'))
      && /Once the Assignments link is read, its next 5 items show here/.test(await tc(page, '[data-ref="school-check"]'))
      && /nothing from it reaches Jordan or Pat/.test(await tc(page, '[data-ref="school-check"]')) && !(await page.$('[data-ref="school-check"] button')), await tc(page, '[data-ref="school-check"]'));
    check('the link is never shown back: not in the page, its boxes, its address, its storage, a toast or the console', !(await pageKeeps(page)).includes(SECRET) && !(await pageKeeps(page)).includes('storage?')
      && !(await toasts(page)).some((x) => x.includes(SECRET)) && !said.some((x) => x.includes(SECRET)), said.filter((x) => x.includes(SECRET)).join(' | ') || 'in the page');

    // ---- Check now: hub-jobs' school action, as the parent; what it read
    db.schoolRead = (d, f) => {
      if (f.kind !== 'assignments' || d.school_items.length) return;
      const I = (o) => d.school_items.push(schoolItemRow(Object.assign({ feed_id: f.id }, o)));
      I({ id: '5c100000-0000-4000-8000-000000000001', title: 'Read chapter 5', subject: 'History', first_day: '2026-11-02', last_day: '2026-11-06', due_date: '2026-11-06' });
      I({ id: '5c100000-0000-4000-8000-000000000002', title: 'Lab report', subject: 'Biology', first_day: '2026-11-13', last_day: '2026-11-20', due_date: '2026-11-20' });
      I({ id: '5c100000-0000-4000-8000-000000000003', title: 'Map quiz', subject: 'Geography', first_day: '2026-11-09', last_day: '2026-11-09', due_date: '2026-11-09' });
    };
    await page.click('[data-row="school"] [data-act="school-now"]');
    await settle(page);
    const job = (db.functionCalls || []).filter((c) => c.path === '/functions/v1/hub-jobs');
    check('Check now: hub-jobs {action: school} as Alex, then the status read again', job.length === 1 && same(job[0].body, { action: 'school' }) && job[0].email === 'alex@example.com'
      && calls(db, 'school_feed_status').length === reads + 2, JSON.stringify(job));
    check('... "Checked 1 link · 3 items"; the link "Last read today 3:10pm · 3 items"', (await lastToast(page)) === 'Checked 1 link · 3 items'
      && (await tc(page, `${FEED('assignments')} .hw-feed-state`)) === 'Last read today 3:10pm · 3 items', `${await lastToast(page)} | ${await tc(page, `${FEED('assignments')} .hw-feed-state`)}`);

    // ---- The first-import check
    const chk = '[data-ref="school-check"]';
    check('Check the dates: the next items, soonest first, with Looks right, Use the first date and One day off; until then nothing for him',
      same(await texts(page, `${chk} .hw-school-items li`), ['History · Read chapter 5 · due Fri Nov 6', 'Geography · Map quiz · due Mon Nov 9', 'Biology · Lab report · due Fri Nov 20'])
      && same(await texts(page, `${chk} button`), ['Looks right', 'Use the first date', 'One day off']) && /Is this what Blackbaud shows\?/.test(await tc(page, chk))
      && !(await page.$('[data-keep="new"]')), await tc(page, chk));
    await page.click(`${chk} [data-act="school-off"]`);
    check('One day off: "Blackbaud shows each one:" A day earlier, A day later', same(await texts(page, `${chk} button`), ['Looks right', 'Use the first date', 'A day earlier', 'A day later'])
      && /Blackbaud shows each one:/.test(await tc(page, chk)) && !calls(db, 'check_school_feed').length, await tc(page, chk));
    await page.click(`${chk} button:text-is("A day earlier")`);
    await settle(page);
    check('A day earlier: check_school_feed(the link, end, -1); "Dates checked. Jordan\'s New from school shows them now."', same(lastCall(db, 'check_school_feed').body,
      { p_feed: feedA().id, p_date_rule: 'end', p_date_shift: -1 }) && (await lastToast(page)) === "Dates checked. Jordan's New from school shows them now."
      && !(await page.$(chk)) && feedA().checked, JSON.stringify(lastCall(db, 'check_school_feed').body));

    // ---- What is new for him: Add to homework, Hide; Show what he hid
    const nw = '[data-row="school"] details[data-keep="new"]';
    const folded = !(await page.$eval(nw, (d) => d.open));
    await page.click(`${nw} summary`);
    check('New from school for Jordan (3), folded: each item a day earlier now, with Add to homework and Hide', (await tc(page, `${nw} summary`)) === 'New from school for Jordan (3)'
      && folded && same(await texts(page, `${nw} .hw-school-row > span:first-child`), ['History · Read chapter 5 · due Thu Nov 5', 'Geography · Map quiz · due Sun Nov 8', 'Biology · Lab report · due Thu Nov 19'])
      && same(await texts(page, `${nw} .hw-school-row:first-child button`), ['Add to homework', 'Hide']), await tc(page, nw));
    await page.click(`${nw} [data-item="5c100000-0000-4000-8000-000000000003"][data-do="hide"]`);
    await settle(page);
    check('Hide: school_item_action(item, hide); "Hidden from Jordan\'s list: Map quiz"; the fold stays open', same(lastCall(db, 'school_item_action').body,
      { p_item: '5c100000-0000-4000-8000-000000000003', p_action: 'hide' }) && (await lastToast(page)) === "Hidden from Jordan's list: Map quiz"
      && (await page.$eval(nw, (d) => d.open)) && (await tc(page, `${nw} summary`)) === 'New from school for Jordan (2)', await lastToast(page));
    const hid = '[data-row="school"] details[data-keep="hidden"]';
    check('... Hidden from Jordan\'s list (1), with Show', (await tc(page, `${hid} summary`)) === "Hidden from Jordan's list (1)"
      && same(await page.$$eval(`${hid} button`, (bs) => bs.map((b) => b.textContent)), ['Show']));
    await page.click(`${hid} summary`);
    await page.click(`${hid} [data-do="show"]`);
    await settle(page);
    check('Show: school_item_action(item, show); "Back on Jordan\'s New from school: Map quiz"', same(lastCall(db, 'school_item_action').body,
      { p_item: '5c100000-0000-4000-8000-000000000003', p_action: 'show' }) && (await lastToast(page)) === "Back on Jordan's New from school: Map quiz" && !(await page.$(hid)));
    await page.click(`${nw} [data-item="5c100000-0000-4000-8000-000000000001"][data-do="add"]`);
    await settle(page);
    const made = db.assignments.find((a) => a.title === 'Read chapter 5');
    check('Add to homework: school_item_action(item, add); an assignment from school, due Thu Nov 5, by Alex; "On Jordan\'s homework: Read chapter 5"',
      same(lastCall(db, 'school_item_action').body, { p_item: '5c100000-0000-4000-8000-000000000001', p_action: 'add' }) && !!made && made.added_by === 'school'
      && made.due_date === '2026-11-05' && made.created_by === 'alex@example.com' && (await lastToast(page)) === "On Jordan's homework: Read chapter 5"
      && (await texts(page, '.hw-arows .hw-arow-sub')).some((x) => /^History · due today · from school/.test(x)), JSON.stringify(await texts(page, '.hw-arows .hw-arow-sub')));

    // ---- The school moves one, and takes another off its site: marked on the assignment, never moved or deleted
    const labItem = db.school_items.find((i) => i.id === '5c100000-0000-4000-8000-000000000002');
    Object.assign(labItem, { assignment_id: LAB, made_at: T, applied: { title: 'Lab report', subject: 'Biology', due_date: '2026-11-20', details: null }, due_date: '2026-11-23' });
    db.school_items.find((i) => i.assignment_id === made.id).gone_at = T;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await settle(page);
    check('moved and gone: "Lab report: the school moved its due date from Fri Nov 20 to Mon Nov 23…", "Read chapter 5 is no longer on the school site", each opening its assignment',
      same(await texts(page, '[data-row="school"] .hw-school-marks a'), ['Lab report: the school moved its due date from Fri Nov 20 to Mon Nov 23. Open it to place it again ›',
        'Read chapter 5 is no longer on the school site ›'])
      && same(await page.$$eval('[data-row="school"] .hw-school-marks a', (as) => as.map((a) => a.getAttribute('href'))), [`#/homework/${LAB}`, `#/homework/${made.id}`]),
    await tc(page, '[data-row="school"] .hw-school-marks'));
    check('... and on the assignments: "the school moved it to Mon Nov 23", "no longer on the school site"', (await texts(page, '.hw-arows .hw-arow-sub')).includes('Biology · due Fri Nov 20 · from school · the school moved it to Mon Nov 23')
      && (await texts(page, '.hw-arows .hw-arow-sub')).some((x) => /^History · due today · from school · no longer on the school site/.test(x)), JSON.stringify(await texts(page, '.hw-arows .hw-arow-sub')));

    // ---- What the hourly read left: each stop in words, stale, repeating events
    Object.assign(feedA(), { last_ok_at: at(TODAY, '10:23'), last_count: 23 });
    const stops = [
      ['sign_in', 'Blackbaud answered with a sign-in page: the link may have been replaced. Copy it again and use Replace.'],
      ['timeout', 'The school\'s site took too long to answer. Home Hub tries again within the hour.'],
      ['gone', 'Blackbaud doesn\'t know this link any more. Copy it again and use Replace.'],
      ['too_many', 'It holds more than Home Hub can use, so nothing was changed.'],
      ['empty', 'It came back empty (a new school year?), so nothing was changed.'],
      ['error', 'The last read didn\'t work. Home Hub tries again within the hour.'],
    ];
    for (const [code, words] of stops) {
      feedA().last_stop = code;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await settle(page);
      check(`the last read stopped with ${code}: "${words}", and the last good read still shown`, (await tc(page, `${FEED('assignments')} .hw-feed-error`)) === words
        && (await tc(page, `${FEED('assignments')} .hw-feed-state`)) === 'Last read today 10:23am · 23 items', await tc(page, FEED('assignments')));
    }
    Object.assign(feedA(), { last_ok_at: null, last_count: null, last_stop: 'unreachable' });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await settle(page);
    check('never read, and the first read failed: "Added · not read yet" and the stop in words', (await tc(page, `${FEED('assignments')} .hw-feed-state`)) === 'Added · not read yet'
      && (await tc(page, `${FEED('assignments')} .hw-feed-error`)) === 'The school\'s site couldn\'t be reached. Home Hub tries again within the hour.', await tc(page, FEED('assignments')));
    Object.assign(feedA(), { last_ok_at: at(TODAY, '11:23'), last_count: 1, last_stop: null, next_at: at(TODAY, '12:13'), last_repeats: 2 });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await settle(page);
    check('a link not read for over 2 hours past due: stale, "…Run supabase/cron.sql again (see the README)."; repeating events counted',
      (await tc(page, `${FEED('assignments')} .hw-feed-stale`)) === 'Not read for over 3 hours: the hourly read may have stopped. Run supabase/cron.sql again (see the README).'
      && (await tc(page, `${FEED('assignments')} .hw-feed-repeats`)) === '2 repeating events: Home Hub uses only the first date of each.', await tc(page, FEED('assignments')));
    Object.assign(feedA(), { next_at: at(TODAY, '15:00'), last_repeats: 0 });

    // ---- Pause and Resume
    await page.click(`${FEED('assignments')} [data-act="school-pause"]`);
    await settle(page);
    check('Pause: pause_school_feed(the link, true); "Paused · Last read today 11:23am · 1 item", with Resume', same(lastCall(db, 'pause_school_feed').body, { p_feed: feedA().id, p_paused: true })
      && (await tc(page, `${FEED('assignments')} .hw-feed-state`)) === 'Paused · Last read today 11:23am · 1 item'
      && same(await texts(page, `${FEED('assignments')} button`), ['Replace', 'Resume', 'Remove']) && /paused/.test(await lastToast(page)), await tc(page, FEED('assignments')));
    await page.click(`${FEED('assignments')} [data-act="school-resume"]`);
    await settle(page);
    check('Resume: pause_school_feed(the link, false)', same(lastCall(db, 'pause_school_feed').body, { p_feed: feedA().id, p_paused: false }) && !feedA().paused
      && (await lastToast(page)) === 'Assignments link resumed. Home Hub reads it within the hour.', await lastToast(page));

    // ---- Replace
    await page.click(`${FEED('assignments')} [data-act="school-replace"]`);
    check('Replace: an empty box, "Paste the new Assignments link"', (await page.inputValue(input).catch(() => 'none')) === ''
      && (await tc(page, `${FEED('assignments')} form[data-form="school"] label span`)) === 'Paste the new Assignments link', await tc(page, FEED('assignments')));
    await page.fill(input, `https://${LINK(`${SECRET}2`)}`);
    await page.click(`${FEED('assignments')} form[data-form="school"] button[type="submit"]`);
    await settle(page);
    check('Replace: set_school_feed with the new link; "Assignments link replaced. Home Hub reads it within the hour."; the same link row, its items kept',
      same(lastCall(db, 'set_school_feed').body, { p_kid: ID.jordan, p_kind: 'assignments', p_url: `https://${LINK(`${SECRET}2`)}` })
      && (await lastToast(page)) === 'Assignments link replaced. Home Hub reads it within the hour.' && db.school_feeds.length === 1 && db.school_items.length === 3
      && (await tc(page, `${FEED('assignments')} .hw-feed-link`)) === 'academy.school.example …f3a2' && !(await page.content()).includes(SECRET), await lastToast(page));
    // Cancel closes the box.
    await page.click(`${FEED('schedule')} [data-act="school-add"]`);
    await page.fill(`${FEED('schedule')} input[name="url"]`, `https://${LINK('X')}`);
    await page.click(`${FEED('schedule')} [data-act="cancel-note"]`);
    check('Cancel: the box goes, nothing sent', !(await page.$(`${FEED('schedule')} form`)) && calls(db, 'set_school_feed').length === 3);
    // Schedule: busy time.
    await page.click(`${FEED('schedule')} [data-act="school-add"]`);
    check('Add link on Schedule: "Paste the Schedule link"', (await tc(page, `${FEED('schedule')} form[data-form="school"] label span`)) === 'Paste the Schedule link');
    await page.fill(`${FEED('schedule')} input[name="url"]`, `https://${LINK('SCHEDULEZ')}`);
    await page.click(`${FEED('schedule')} form[data-form="school"] button[type="submit"]`);
    await settle(page);
    check('Schedule saved: set_school_feed with p_kind schedule; "Schedule link saved…"', lastCall(db, 'set_school_feed').body.p_kind === 'schedule'
      && (await lastToast(page)) === 'Schedule link saved. Home Hub reads it within the hour.' && (await tc(page, `${FEED('schedule')} .hw-feed-state`)) === 'Added · first read within the hour');

    // ---- Remove: asks first
    db.confirm = false;
    await page.click(`${FEED('assignments')} [data-act="school-remove"]`);
    await sleep(200);
    check('Remove asks first: "Remove the Assignments link? …"; No → nothing sent', (db.dialogs || []).slice(-1)[0] === 'Remove the Assignments link? Home Hub stops reading it. Assignments already on Jordan\'s homework stay; the rest of what it brought goes.'
      && calls(db, 'set_school_feed').length === 4, (db.dialogs || []).slice(-1)[0]);
    db.confirm = true;
    await page.click(`${FEED('assignments')} [data-act="school-remove"]`);
    await settle(page);
    check('Remove: set_school_feed(kid, assignments, null); "Assignments link removed"; Not added again, his assignments from school kept',
      same(lastCall(db, 'set_school_feed').body, { p_kid: ID.jordan, p_kind: 'assignments', p_url: null })
      && (await lastToast(page)) === 'Assignments link removed' && (await tc(page, `${FEED('assignments')} .hw-feed-state`)) === 'Not added'
      && db.school_feeds.filter((f) => !f.removed_at).map((f) => f.kind).join() === 'schedule' && !!db.assignments.find((a) => a.id === made.id) && !(await page.$('[data-keep="new"]')), await lastToast(page));
    const removed = db.school_feeds.find((f) => f.kind === 'assignments');
    check('... the link\'s row stays, marked removed, with only the items made assignments (so adding it again doesn\'t bring them back as new)',
      !!removed && !!removed.removed_at && !schoolUrlOf(db, removed.id) && db.school_items.filter((i) => i.feed_id === removed.id).length > 0
      && db.school_items.filter((i) => i.feed_id === removed.id).every((i) => !!i.made_at), db.school_items.filter((i) => i.feed_id === (removed || {}).id));
    check('nothing on the page or in the console ever carried a link', !(await page.content()).includes(SECRET) && !(await page.content()).includes('SCHEDULEZ')
      && !said.some((x) => x.includes(SECRET) || x.includes('SCHEDULEZ')));
    await page.context().close();
  }
  {
    // Check now when the hourly read holds the lease, and when every link was read a moment ago.
    const d = schoolDb();
    d.school_feeds.push(schoolFeedRow({ kid_id: ID.jordan, kind: 'games', host: 'academy.school.example', url_end: 'g4m3', last_try_at: at(TODAY, '15:09'),
      last_ok_at: at(TODAY, '15:09'), last_count: 4 }));
    ({ page, db } = await open({ label: 'school-now', db: d, rpc: RPC6 }));
    await page.click('[data-row="school"] [data-act="school-now"]');
    await settle(page);
    check('Check now with each link read in the last minute: "Nothing to read: each link was read in the last minute."', (await lastToast(page)) === 'Nothing to read: each link was read in the last minute.', await lastToast(page));
    db.schoolReply = { ok: false, stop: 'busy' };
    await page.click('[data-row="school"] [data-act="school-now"]');
    await settle(page);
    check('... while the hourly read runs: "The hourly read is running right now. Try again in a minute."', (await lastToast(page)) === 'The hourly read is running right now. Try again in a minute.', await lastToast(page));
    check('Games/Practices read: no date check (only the Assignments link has dates)', !(await page.$('[data-ref="school-check"]')) && (await tc(page, `${FEED('games')} .hw-feed-state`)) === 'Last read today 3:09pm · 4 items');
    await page.context().close();
  }
  {
    // Sam: no row and no request, on schema 6 (the database lets him read the status; the page shows School links to the parents, as the tutor links).
    ({ page, db } = await open({ label: 'school-sam', db: schoolDb(), rpc: RPC6, email: 'sam@example.com' }));
    check('Sam (schema 6): no School links row and no school_feed_status request', !(await page.$('[data-row="school"]')) && !calls(db, 'school_feed_status').length
      && !!(await page.$('[data-sec="switches"]')));
    await page.context().close();
  }
  {
    // A failed status read: the row says so, the rest of the page draws.
    const f = schoolDb();
    f.schoolFail = { school_feed_status: { __status: 500, body: { code: 'XX000', message: 'Database restarting', details: null, hint: null } } };
    ({ page, db } = await open({ label: 'school-fail', db: f, rpc: RPC6, allowConsole: /status of 500/ }));
    check('school_feed_status fails: "School links couldn\'t be loaded." with Try again; no links; the rest draws', /School links couldn't be loaded\./.test(await tc(page, '[data-row="school"]'))
      && !(await page.$('[data-row="school"] .hw-feed')) && !!(await page.$('[data-row="school"] [data-act="retry"]')) && !!(await page.$('.hw-ask')), await tc(page, '[data-row="school"]'));
    delete db.schoolFail;
    await page.click('[data-row="school"] [data-act="retry"]');
    await settle(page);
    check('... Try again reads it again', (await page.$$('[data-row="school"] .hw-feed')).length === 3);
    await page.context().close();
  }
  {
    // A phone: no sideways scroll, 44px targets in the row, the how-to and the date check open.
    const p = schoolDb();
    const fa = schoolFeedRow({ kid_id: ID.jordan, kind: 'assignments', url_end: 'a1b2', last_ok_at: at(TODAY, '10:23'), last_count: 23, last_stop: 'sign_in' });
    p.school_feeds.push(fa);
    p.school_items.push(schoolItemRow({ feed_id: fa.id, title: 'A very long assignment title from the school site that runs on and on', subject: 'English', due_date: '2026-11-12' }));
    ({ page } = await open({ label: 'school-phone', db: p, rpc: RPC6, ctx: phone }));
    await page.click('[data-row="school"] details.hw-school-how summary');
    await page.click('[data-ref="school-check"] [data-act="school-off"]');
    await page.click(`${FEED('schedule')} [data-act="school-add"]`);
    check('phone: School links with no sideways scroll', await noSideScroll(page));
    const small = await page.$$eval('[data-row="school"] button, [data-row="school"] summary, [data-row="school"] input',
      (els) => els.filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.act || e.tagName, Math.round(r.width), Math.round(r.height)]; })
        .filter(([, wd, ht]) => wd < 44 || ht < 44));
    check('phone: every tap target in School links is at least 44px', !small.length, JSON.stringify(small));
    await page.locator('[data-row="school"]').screenshot({ path: SHOTS + 'homework-phone-school.png' });
    await page.context().close();
  }

  // =====================================================================
  // 10. The coach view (schema 7, 0007; docs/v1.3-homework.md §20.5): each tutor link's switch, and the coach's notes
  // =====================================================================
  const RPC7 = Object.assign({}, RPC6, { hub_schema_version: () => 7 }, coachRpc);
  const LINK1 = 'a1110000-0000-4000-8000-000000000001';
  const N1 = 'c0ac0000-0000-4000-8000-000000000001';
  const N2 = 'c0ac0000-0000-4000-8000-000000000002';
  const N3 = 'c0ac0000-0000-4000-8000-000000000003';
  const coachDb = () => {
    const d = withCoach(withSchool(fullDb()));
    d.coach_notes.push(
      coachNoteRow({ id: N1, link_id: LINK1, note: 'Suggest lowering the on-time bonus.\nHe starts on time anyway.', created_at: at('2026-11-04', '18:30') }),
      coachNoteRow({ id: N2, link_id: LINK1, note: 'Great week of starts.', created_at: at('2026-10-30', '18:00'), done_at: at('2026-10-31', '09:00'), done_by: 'alex@example.com' }),
      coachNoteRow({ id: N3, link_id: LINK1, note: 'An old note.', created_at: at('2026-09-20', '18:00'), done_at: at('2026-09-21', '09:00'), done_by: 'alex@example.com' }),
    );
    return d;
  };
  const coachReads = (log) => log.filter((l) => /^GET \/rest\/v1\/coach_notes/.test(l));
  {
    // Schema 6: no switch, and coach_notes isn't asked for (it isn't there yet).
    ({ page, db, log } = await open({ label: 'coach-6', db: withSchool(fullDb()), rpc: RPC6 }));
    check('schema 6: no coach switch, no coach notes, and no coach_notes read', !(await page.$('[data-act="link-coach"]')) && !(await page.$('.hw-coach-notes'))
      && !coachReads(log).length && !!(await page.$('.hw-link')), JSON.stringify(coachReads(log)));
    await page.context().close();
  }
  {
    ({ page, db, log } = await open({ label: 'coach', db: coachDb(), rpc: RPC7 }));
    check('schema 7: coach_notes read once, for his links', coachReads(log).length === 1 && coachReads(log)[0].includes(LINK1), JSON.stringify(coachReads(log)));
    check('the switch: "Coach view" on the link, off', (await tc(page, '.hw-link .hw-link-coach .hw-switch')) === 'Coach view'
      && (await page.$eval('.hw-link [data-act="link-coach"]', (x) => x.checked === false)), await tc(page, '.hw-link .hw-link-coach'));
    check('... with exactly what it shows, in plain words', (await tc(page, '.hw-link .hw-link-coach .hw-switch-line'))
      === "Also shows Pat Jordan's points and rewards (this week's and last week's points, and the last 30 days), his focus sessions, his own calendar "
      + '(the next 14 days and the last 7) and his daily tasks, read-only, and lets Pat leave you a note here. Private items and health tasks show as '
      + '“Private item”. Never the rest of the family: no one '
      + "else's events, tasks or names, no dinners, shopping list or contacts.", await tc(page, '.hw-link .hw-link-coach .hw-switch-line'));
    check('the coach\'s notes under the link: the open one with Done, its lines kept', same(await texts(page, '.hw-coach-notes > ul > li .hw-coach-note'),
      ['Yesterday 6:30pm · “Suggest lowering the on-time bonus. He starts on time anyway.”'])
      && (await page.$$('.hw-coach-notes > ul > li [data-act="coach-done"]')).length === 1
      && (await tc(page, '.hw-coach-notes > .hw-coach-head')) === 'Notes from Pat Lee, tutor (1)', `${await tc(page, '.hw-coach-notes')}`);
    check('... the done one of the last 30 days folded under Earlier notes, the older one not at all', (await tc(page, '.hw-coach-notes details summary')) === 'Earlier notes (1)'
      && same(await page.$$eval('.hw-coach-notes details li', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim())), ['Fri 6:00pm · “Great week of starts.” · Done'])
      && !(await page.content()).includes('An old note.'), await tc(page, '.hw-coach-notes details'));
    await page.click('.hw-link [data-act="link-coach"]');
    await settle(page);
    check('turning it on: set_tutor_coach with the link and true; the switch on; a toast', same(lastCall(db, 'set_tutor_coach').body, { p_link: LINK1, p_coach: true })
      && db.tutor_links[0].coach === true && (await page.$eval('.hw-link [data-act="link-coach"]', (x) => x.checked))
      && (await lastToast(page)) === 'Coach view on for Pat Lee, tutor', `${JSON.stringify(lastCall(db, 'set_tutor_coach').body)} ${await lastToast(page)}`);
    await page.click('.hw-coach-notes [data-act="coach-done"]');
    await settle(page);
    check('Done: coach_note_done with the note; it moves under Earlier notes', same(lastCall(db, 'coach_note_done').body, { p_note: N1 })
      && !(await page.$('.hw-coach-notes > ul > li')) && (await tc(page, '.hw-coach-notes details summary')) === 'Earlier notes (2)', await tc(page, '.hw-coach-notes'));
    await page.click('.hw-link [data-act="link-coach"]');
    await settle(page);
    check('turning it off: set_tutor_coach with false; "Coach view off for Pat Lee, tutor"', same(lastCall(db, 'set_tutor_coach').body, { p_link: LINK1, p_coach: false })
      && db.tutor_links[0].coach === false && (await lastToast(page)) === 'Coach view off for Pat Lee, tutor', await lastToast(page));
    await page.context().close();
  }
  {
    // A phone: no sideways scroll, and the switch and Done are big enough to tap.
    ({ page, db } = await open({ label: 'coach-phone', db: coachDb(), rpc: RPC7, ctx: phone }));
    await page.click('.hw-coach-notes details summary');
    check('phone: the coach switch and notes with no sideways scroll', await noSideScroll(page));
    const small = await page.$$eval('.hw-link-coach .hw-switch, .hw-coach-notes button, .hw-coach-notes summary',
      (els) => els.filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.act || e.tagName, Math.round(r.width), Math.round(r.height)]; })
        .filter(([, wd, ht]) => ht < 44));
    check('phone: the switch, Done and the fold are at least 44px tall', !small.length, JSON.stringify(small));
    await page.locator('.hw-link').screenshot({ path: SHOTS + 'homework-phone-coach.png' });
    await page.context().close();
  }
  {
    // Sam: no links panel and no coach_notes read (the notes are the parents').
    ({ page, db, log } = await open({ label: 'coach-sam', db: coachDb(), rpc: RPC7, email: 'sam@example.com' }));
    check('Sam (schema 7): no coach switch, no notes and no coach_notes read', !(await page.$('[data-act="link-coach"]')) && !(await page.$('.hw-coach-notes'))
      && !coachReads(log).length && !!(await page.$('[data-sec="switches"]')), JSON.stringify(coachReads(log)));
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
