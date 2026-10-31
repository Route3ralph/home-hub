// Browser tests for the tutor link (day.html?h=<token>, docs/v1.3-homework.md §9.5, §13.1 item 1): the third
// mode of day.html, which loads nobody's day and hands over to plan.js's tutor view (HomePlan.tutor) with an
// api of the four tutor functions only: tutor_view_by_token(p_token, p_assignment, p_part),
// tutor_assignment_by_token(p_token, p_fields), tutor_plan_by_token(p_token, p_assignment, p_steps, p_rev,
// p_give) and tutor_step_by_token(p_token, p_step, p_action, p_text), answered by mock.js's homeworkTokenRpc with the
// migration's rules and shapes. What is checked: only those calls are made (no get_person_day, no other
// function, no sign-in), with their argument names; the title and language from the link; the fixed order
// and the first coaching line; nothing of the family on the page (no other person's name, no surname, no
// points, rewards or asks, no busy titles, no email address) and nothing live (no block running now, no
// "alone"); Looks done with a note (and its Undo), Not yet needing a note, Answer; a new assignment planned from a
// starter plan and given to Jordan, which then shows on his My day; read again on focus and coming back into
// view; the screens for a link that no longer works (unknown, off, ended, malformed: no call) and for a
// database without 0005 ("This link doesn't work yet."); Pat's token opens no My day; from 0006, an assignment made from
// school marked so, with the school's marks (moved, gone), and nothing of his New from school; Spanish; 390px wide;
// nothing kept on the device. From 0007 (docs/v1.3-homework.md §20.6), the Coach section, only for a link whose coach
// view a parent turned on: read with coach_view_by_token (and nothing else new), after the fixed sections, on the
// list only; his points by kind this week and last, the last 30 days' lines, his rewards and asks, his focus
// sessions, his own calendar (next 14 days, last 7) and his daily tasks, private ones as "Private item", nothing of
// the family; a note for the family (coach_note_by_token with the page's key, checked first, kept while typing
// through a refresh, the button off while it is sent); gone at once when the parents turn it off; points off;
// before 0007 nothing is asked; Spanish; 390px.
// The browser runs in Pacific/Kiritimati with its clock a day ahead of the household's, as in day.test.js.
// Run alone with: node tests/e2e/tutor.test.js
const fs = require('fs');
const { chromium } = require('playwright');
const { makeDb, install, withHomeworkTokens, homeworkTokenRpc: homeworkRpc, tkKidRow: hwKidRow, tkLinkRow: tutorLinkRow, tkAssignmentRow: assignmentRow,
  tkStepRow: stepRow, tkSessionRow: sessionRow, tkRewardRow: rewardRow, tkLedgerRow: ledgerRow, withSchool, schoolFeedRow, schoolItemRow, withCoach } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---- The household (made up): Alex and Morgan the parents, Sam, Taylor the helper, Jordan the kid; Pat Lee's
// link. The household's Mon Nov 2 2026, 4:31pm in New York; the phone a day ahead, in Kiritimati.
const NOW = '2026-11-02T21:31:04.512Z';
const DEVICE = new Date('2026-11-03T22:07:00Z');
const TODAY = '2026-11-02';
const PAT = 'abcdef0123456789abcdef0123456789';
const JORDAN_DAY = 'fedcba9876543210fedcba9876543210';
const hid = (n) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const I = { link: hid(1), sci: hid(10), s0: hid(11), s1: hid(12), s2: hid(13), s3: hid(14), s6: hid(15), math: hid(20), m1: hid(21), frac: hid(30), live: hid(40) };
const P = { alex: 'p-alex', sam: 'p-sam', taylor: 'p-taylor', jordan: 'p-jordan', morgan: 'p-morgan' };
const at = (iso) => `${iso}.000000+00:00`;
function tutorDb(o) {
  const opts = o || {};
  const db = makeDb();
  db.calls = [];
  db.household = [{ id: true, tz: 'America/New_York' }];
  db.people = [
    { id: P.alex, name: 'Alex Example', role: 'admin', language: 'en', email: 'alex@example.com', day_token: null, active: true },
    { id: P.sam, name: 'Sam Example', role: 'adult', language: 'en', email: 'sam@example.com', day_token: null, active: true },
    { id: P.taylor, name: 'Taylor Example', role: 'helper', language: 'es', email: null, day_token: '0123456789abcdef0123456789abcdef', active: true },
    { id: P.jordan, name: 'Jordan Example', role: 'kid', language: 'en', email: null, day_token: JORDAN_DAY, active: true },
    { id: P.morgan, name: 'Morgan Example', role: 'admin', language: 'en', email: 'morgan@example.com', day_token: null, active: true },
  ];
  withHomeworkTokens(db, { now: NOW });
  db.homework_kids.push(hwKidRow({ kid_id: P.jordan, cue: "When I've had my snack, I open my notes doc." }));
  db.hwTimes[P.jordan] = [{ weekdays: [1, 2, 3, 4], starts: '16:30', ends: '17:15' }, { weekdays: [7], starts: '17:00', ends: '17:45' }];
  db.hwBusy[P.jordan] = { '2026-11-03': [{ starts: '17:00', ends: '18:00', title: 'Piano with Morgan' }] };
  db.tutor_links.push(tutorLinkRow({ id: I.link, kid_id: P.jordan, token: PAT, language: opts.lang || 'en', expires_on: '2027-04-30' }));
  const tut = 'Pat Lee, tutor (tutor link)';
  db.assignments.push(
    assignmentRow({ id: I.sci, kid_id: P.jordan, title: 'Science project: river poster', subject: 'Science', due_date: '2026-11-13', added_by: 'tutor',
      details: 'Make a poster about one river.\nTwo sources at least.', given_at: at('2026-10-26T22:00:00'), given_by: 'morgan@example.com', plan_rev: 3,
      created_at: at('2026-10-25T15:00:00') }),
    assignmentRow({ id: I.math, kid_id: P.jordan, title: 'Worksheet 4.2', subject: 'Math', due_date: '2026-11-03', given_at: at('2026-11-01T15:00:00'),
      given_by: 'alex@example.com', plan_rev: 2, created_at: at('2026-11-01T14:00:00') }),
    assignmentRow({ id: I.frac, kid_id: P.jordan, kind: 'lesson', title: 'Fractions practice', subject: 'Math', due_date: '2026-11-06', added_by: 'family',
      created_at: at('2026-11-01T16:00:00') }),
  );
  db.homework_steps.push(
    stepRow({ id: I.s0, assignment_id: I.sci, pos: 1, kind: 'start', title: 'Copy the requirements into your notes', minutes: 10, day: '2026-10-30',
      done_at: at('2026-10-30T21:00:00'), done_by: 'Jordan (My day)' }),
    stepRow({ id: I.s1, assignment_id: I.sci, pos: 2, kind: 'milestone', title: 'Outline with 3 main points', done_looks_like: 'an outline you can show',
      minutes: 25, day: '2026-11-01', done_at: at('2026-11-01T22:00:00'), done_by: 'Jordan (My day)' }),
    stepRow({ id: I.s2, assignment_id: I.sci, pos: 3, kind: 'step', title: 'Find 2 sources and save their links', minutes: 20, day: TODAY,
      question: 'Does the poster need a title?', question_at: at('2026-11-02T20:00:00') }),
    stepRow({ id: I.s3, assignment_id: I.sci, pos: 4, kind: 'milestone', title: 'Full draft', minutes: 25, day: '2026-10-31' }),
    stepRow({ id: I.s6, assignment_id: I.sci, pos: 5, kind: 'turn_in', title: 'Turn it in', minutes: 5, day: '2026-11-13' }),
    stepRow({ id: I.m1, assignment_id: I.math, pos: 1, kind: 'step', title: 'Do worksheet 4.2', minutes: 15, day: TODAY }),
    // A plan not given yet: "Plans to look at".
    stepRow({ assignment_id: I.frac, pos: 1, kind: 'step', title: 'Do practice session 1', minutes: 20, day: '2026-11-05', source: 'template' }),
  );
  db.rewards.push(rewardRow({ kid_id: P.jordan, title: "Choose Friday's dinner", cost: 60 }));
  db.reward_asks.push({ id: hid(50), kid_id: P.jordan, reward_id: null, title: "Choose Friday's dinner", cost: 60, status: 'waiting', asked_at: at('2026-11-02T20:00:00'), decided_at: null, decided_by: null, note: null });
  db.points_ledger.push(ledgerRow({ kid_id: P.jordan, at: at('2026-10-26T23:00:00'), day: '2026-10-26', kind: 'given', delta: 118, note: 'Great session', who: 'alex@example.com' }));
  // Finished blocks: one with Pat, one with a parent (Pat sees neither "alone" nor "with a parent").
  db.focus_sessions.push(
    sessionRow({ kid_id: P.jordan, assignment_id: I.sci, step_id: I.s0, minutes: 20, with_whom: 'tutor', started_at: at('2026-10-30T21:00:00'),
      ends_at: at('2026-10-30T21:20:00'), ended_at: at('2026-10-30T21:21:00'), result: 'done', seen_minutes: 20, points: 4, note: 'found 2 sources' }),
    sessionRow({ kid_id: P.jordan, assignment_id: I.sci, step_id: I.s1, minutes: 25, with_whom: 'parent', started_at: at('2026-11-01T21:30:00'),
      ends_at: at('2026-11-01T21:55:00'), ended_at: at('2026-11-01T21:56:00'), result: 'more', seen_minutes: 25, points: 5, note: null }),
  );
  if (opts.running) {
    db.focus_sessions.push(sessionRow({ id: I.live, kid_id: P.jordan, assignment_id: I.math, step_id: I.m1, minutes: 20, with_whom: 'alone',
      started_at: at('2026-11-02T21:25:00'), ends_at: at('2026-11-02T21:45:00') }));
  }
  return db;
}

const FAKES = Object.assign({}, homeworkRpc, {
  // Pat's token opens no My day: get_person_day looks up day tokens only.
  get_person_day: (db, b) => ((db.people || []).some((p) => p.day_token === b.p_token) ? { person: { name: 'x', language: 'en' }, today: TODAY, days: [], late: [] } : null),
});
async function tokenRpcs(page, db) {
  await page.route((url) => url.host === 'test.supabase.co' && url.pathname.startsWith('/rest/v1/rpc/'), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.slice('/rest/v1/rpc/'.length);
    const body = JSON.parse(req.postData() || '{}');
    db.calls.push({ name, body, auth: req.headers()['authorization'] || '' });
    if (!FAKES[name]) return route.fallback();
    if (db.offline) return route.abort('internetdisconnected');
    // The call reaches the database (it does what it does), but its answer is lost on the way back.
    if (db.loseAnswer === name) { db.loseAnswer = null; FAKES[name](db, body); return route.abort('connectionreset'); }
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

  async function open(opts) {
    const db = opts.db || tutorDb();
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: 'Pacific/Kiritimati' }, opts.ctx));
    const page = await context.newPage();
    await page.clock.install({ time: DEVICE });
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await install(page, db, [], { rpc: {} });
    await tokenRpcs(page, db);
    await page.goto(BASE + opts.path);
    await page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 5000 });
    await page.waitForTimeout(150);
    return { page, db, context, requests };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const calls = (db, name) => db.calls.filter((c) => c.name === name);
  const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const TUTOR_FNS = /^(tutor_view_by_token|tutor_assignment_by_token|tutor_plan_by_token|tutor_step_by_token)$/;

  // =====================================================================
  // 1. Pat's link: only the tutor functions, the title and language, the fixed order, the first line
  // =====================================================================
  let { page, db, requests } = await open({ label: 'pat', path: `/day.html?h=${PAT}`, db: tutorDb({ running: true }) });
  await page.waitForSelector('.plan-tutor');
  check('?h=: the list from tutor_view_by_token({ p_token, p_assignment: null, p_part: "all" })',
    same(calls(db, 'tutor_view_by_token').map((c) => c.body), [{ p_token: PAT, p_assignment: null, p_part: 'all' }]), JSON.stringify(db.calls.map((c) => [c.name, c.body])));
  check('?h=: no other function is called (no get_person_day, nothing of My day), no sign-in, no table read',
    db.calls.every((c) => TUTOR_FNS.test(c.name)) && !requests.some((u) => /\/auth\/v1\/|\/rest\/v1\/(?!rpc\/tutor_)/.test(u)),
    requests.filter((u) => /test\.supabase\.co/.test(u)).join(' | '));
  check('?h=: the link\'s token is never sent as a signed-in user', db.calls.every((c) => !/^Bearer eyJ/.test(c.auth)));
  check('?h=: the title and the page\'s language come from the link', (await page.title()) === 'Homework · Jordan' && (await page.evaluate(() => document.documentElement.lang)) === 'en', await page.title());
  check('?h=: "Homework · Jordan", "Hi Pat Lee, tutor · Link ends Apr 30", and the first coaching line',
    (await text(page, '.plan-head h1')) === 'Homework · Jordan' && (await text(page, '.plan-head .meta')) === 'Hi Pat Lee, tutor · Link ends Apr 30'
    && (await text(page, '.plan-coach')) === "Start with what he did. Ask what's next and when he'll start it.", await text(page, '.plan-head'));
  check('?h=: the fixed order: To check, To talk about, Questions, Plans to look at, Assignments, His week, Last 14 days',
    same(await page.$$eval('.plan-sec', (ss) => ss.map((s) => s.dataset.sec)), ['check', 'talk', 'questions', 'plans', 'assignments', 'week', 'record']),
    JSON.stringify(await page.$$eval('.plan-sec', (ss) => ss.map((s) => s.dataset.sec))));
  const body = await page.evaluate(() => document.body.innerText);
  check('?h=: nothing of the family: no other person\'s name, no surname, no email, no busy titles', !/Alex|Morgan|Sam\b|Taylor|Example|@|Piano/.test(body),
    (body.match(/Alex|Morgan|Sam\b|Taylor|Example|@|Piano/g) || []).join(','));
  const PTS = /★|reward|Friday's dinner|\b118\b|(?<!main )points?\b/gi;
  check('?h=: no points, rewards or asks', !PTS.test(body), (body.match(PTS) || []).join(','));
  check('?h=: nothing live while Jordan has a block running: no "now", no "alone", no running block in the record',
    !/focusing|alone|running|min left/i.test(body) && !/Do worksheet 4\.2 ·/.test(await text(page, '[data-sec="record"]')), await text(page, '[data-sec="record"]'));
  check('?h=: a block with Pat says "with you"; one with a parent says nothing of it',
    /with you/.test(await text(page, '[data-sec="record"]')) && !/parent/i.test(await text(page, '[data-sec="record"]')), await text(page, '[data-sec="record"]'));
  check('?h=: his week shows "Busy" blocks without titles', /Busy 5:00pm/.test(await text(page, '[data-sec="week"]')), await text(page, '[data-sec="week"]'));
  await page.screenshot({ path: SHOTS + 'tutor-list.png', fullPage: true });

  // ---- Looks done with a note, and its Undo; Not yet needs a note; Answer
  await page.click(`.plan-row[data-step="${I.s1}"] [data-act="looks-done"]`);
  await page.fill('.plan-note input[name="text"]', 'Clear outline. The third point is the strongest.');
  await page.click('.plan-note [type="submit"]');
  await until(() => calls(db, 'tutor_step_by_token').length === 1);
  check('Looks done: tutor_step_by_token check with the note', same(calls(db, 'tutor_step_by_token')[0].body,
    { p_token: PAT, p_step: I.s1, p_action: 'check', p_text: 'Clear outline. The third point is the strongest.' }), JSON.stringify(calls(db, 'tutor_step_by_token')[0].body));
  check('Looks done: the milestone leaves To check; a toast with Undo; no points named', await until(async () => !(await page.$(`.plan-row[data-step="${I.s1}"] [data-act="looks-done"]`)))
    && /^Checked: Outline with 3 main points/.test(await text(page, '.toast-action'))
    && !/\+\d|point/i.test((await text(page, '.toasts')).replace('3 main points', '')), await text(page, '.toasts'));
  check('…and the check paid Jordan\'s milestone points on the server', db.points_ledger.some((l) => l.step_id === I.s1 && l.kind === 'milestone' && l.delta === 20));
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await until(() => calls(db, 'tutor_step_by_token').length === 2);
  check('Undo: tutor_step_by_token uncheck', same(calls(db, 'tutor_step_by_token')[1].body, { p_token: PAT, p_step: I.s1, p_action: 'uncheck', p_text: null })
    && await until(() => !db.points_ledger.some((l) => l.step_id === I.s1 && l.kind === 'milestone')));
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
  await page.waitForSelector(`.plan-row[data-step="${I.s1}"] [data-act="not-yet"]`);
  await page.click(`.plan-row[data-step="${I.s1}"] [data-act="not-yet"]`);
  await page.click('.plan-note [type="submit"]');
  check('Not yet with no note: "Say what\'s missing." and no call', (await text(page, '.plan-note .form-error')) === "Say what's missing." && calls(db, 'tutor_step_by_token').length === 2);
  await page.fill('.plan-note input[name="text"]', 'Add a source for the second point.');
  await page.click('.plan-note [type="submit"]');
  await until(() => calls(db, 'tutor_step_by_token').length === 3);
  check('Not yet: tutor_step_by_token not_yet with the note; the milestone is unticked',
    same(calls(db, 'tutor_step_by_token')[2].body, { p_token: PAT, p_step: I.s1, p_action: 'not_yet', p_text: 'Add a source for the second point.' })
    && db.homework_steps.find((s) => s.id === I.s1).done_at === null);
  await page.click(`.plan-row[data-step="${I.s2}"] [data-act="answer"]`);
  await page.fill('.plan-note input[name="text"]', 'Yes, a short title at the top.');
  await page.click('.plan-note [type="submit"]');
  await until(() => calls(db, 'tutor_step_by_token').length === 4);
  check('Answer: tutor_step_by_token answer', same(calls(db, 'tutor_step_by_token')[3].body, { p_token: PAT, p_step: I.s2, p_action: 'answer', p_text: 'Yes, a short title at the top.' })
    && await until(async () => /Answer: Yes, a short title at the top\./.test(await text(page, '[data-sec="questions"]'))));

  // ---- Read again on focus and on coming back into view
  const views = calls(db, 'tutor_view_by_token').length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(() => calls(db, 'tutor_view_by_token').length === views + 1);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  check('read again on focus and on visibilitychange', await until(() => calls(db, 'tutor_view_by_token').length === views + 2), String(calls(db, 'tutor_view_by_token').length - views));

  // ---- A new assignment, planned from a starter plan and given to Jordan
  await page.click('a[href="#new/assignment"]');
  await page.waitForSelector('.plan-afields');
  await page.fill('.plan-afields input[name="title"]', 'Book report');
  await page.fill('.plan-afields input[name="subject"]', 'English');
  await page.fill('.plan-afields input[name="due_date"]', '2026-11-12');
  await page.click('.plan-afields [type="submit"]');
  await until(() => calls(db, 'tutor_assignment_by_token').length === 1);
  const fields = calls(db, 'tutor_assignment_by_token')[0].body;
  check('+ Assignment: tutor_assignment_by_token with the page\'s id and the fields', fields.p_token === PAT && UUID.test(fields.p_fields.id)
    && same(Object.assign({}, fields.p_fields, { id: 'id' }), { id: 'id', kind: 'assignment', title: 'Book report', subject: 'English', due_date: '2026-11-12', details: null, stretch: null }),
    JSON.stringify(fields));
  const lessonId = fields.p_fields.id;
  check('+ Assignment: opens it (#a/<id>), read with tutor_view_by_token(p_assignment)', await until(async () => (await page.evaluate(() => location.hash)) === `#a/${lessonId}`)
    && await until(() => calls(db, 'tutor_view_by_token').some((c) => c.body.p_assignment === lessonId && c.body.p_part === 'all')) && await until(async () => !!(await page.$('.plan-editor'))),
    `${await page.evaluate(() => location.hash)} ${JSON.stringify(calls(db, 'tutor_view_by_token').slice(-2).map((c) => c.body))}`);
  await page.click('.plan-editor [data-act="starter"]');
  await page.click('.plan-editor [data-starter="essay"]');
  await until(() => calls(db, 'tutor_plan_by_token').length === 1);
  const first = calls(db, 'tutor_plan_by_token')[0].body;
  check('a starter plan: tutor_plan_by_token with the steps, rev 0, not given', first.p_token === PAT && first.p_assignment === lessonId && first.p_rev === 0 && first.p_give === false
    && first.p_steps.length === 9 && first.p_steps.every((s) => s.source === 'template' && s.day === null), JSON.stringify(first));
  await page.waitForSelector('.plan-editor [data-act="give"]:not([disabled])');
  await page.click('.plan-editor [data-act="give"]');
  await until(() => calls(db, 'tutor_plan_by_token').length === 2);
  check('Give Jordan this plan: tutor_plan_by_token with p_give true', calls(db, 'tutor_plan_by_token')[1].body.p_give === true
    && /\(tutor link\)$/.test(db.assignments.find((a) => a.id === lessonId).given_by || ''), JSON.stringify(calls(db, 'tutor_plan_by_token')[1].body));
  const jv = homeworkRpc.homework_by_token(db, { p_token: JORDAN_DAY });
  check('…and the plan is on Jordan\'s My day, given by the tutor, placed in his homework time', jv.assignments.some((a) => a.id === lessonId && a.state === 'given' && a.given_by === 'tutor'
    && a.steps.length === 9 && a.steps.every((x) => x.day >= TODAY && x.day <= '2026-11-12')));
  await page.screenshot({ path: SHOTS + 'tutor-plan.png', fullPage: true });
  check('nothing is kept on the device (no storage)', await page.evaluate(() => { try { return localStorage.length === 0 && sessionStorage.length === 0; } catch (e) { return true; } }));
  check('every call was one of the four tutor functions', db.calls.every((c) => TUTOR_FNS.test(c.name)), [...new Set(db.calls.map((c) => c.name))].join(','));
  await page.context().close();

  // =====================================================================
  // 2. A link that doesn't work, a database without 0005, Pat's token on My day, Spanish, 390px
  // =====================================================================
  for (const [label, mut, words] of [
    ['unknown', (d) => { d.tutor_links[0].token = 'ffffffffffffffffffffffffffffffff'; }, 'This link no longer works. Ask the family for a new one.'],
    ['off', (d) => { d.tutor_links[0].active = false; }, 'This link no longer works. Ask the family for a new one.'],
    ['ended', (d) => { d.tutor_links[0].expires_on = '2026-11-01'; }, 'This link no longer works. Ask the family for a new one.'],
    ['homework off', (d) => { d.homework_kids[0].active = false; }, 'This link no longer works. Ask the family for a new one.'],
    ['before 0005', (d) => { delete d.homework_kids; }, "This link doesn't work yet."],
  ]) {
    const d = tutorDb();
    mut(d);
    ({ page, db } = await open({ label: `pat-${label}`, path: `/day.html?h=${PAT}`, db: d, allowConsole: /status of 404/ }));
    check(`a link ${label}: "${words}"`, await until(async () => (await text(page, '.day-problem')) === words), await text(page, 'main'));
    check(`a link ${label}: one read, nothing else`, db.calls.length === 1 && db.calls[0].name === 'tutor_view_by_token', db.calls.map((c) => c.name).join(','));
    await page.context().close();
  }
  ({ page, db } = await open({ label: 'pat-malformed', path: '/day.html?h=not-a-token' }));
  check('a malformed link: "This link no longer works…" with no call at all', (await text(page, '.day-problem')).startsWith('This link no longer works') && db.calls.length === 0, await text(page, 'main'));
  await page.context().close();
  ({ page, db } = await open({ label: 'pat-as-myday', path: `/day.html?t=${PAT}` }));
  check('Pat\'s token opens no My day ("This link isn\'t working…") and no homework', /This link isn't working/.test(await text(page, '.day-problem'))
    && same(db.calls.map((c) => c.name), ['get_person_day']), db.calls.map((c) => c.name).join(','));
  await page.context().close();

  // 0006 (schema 6, §12.4, §12.8): an assignment made from school says "from school" on Pat's link, in the list and on its
  // page, with the school's marks: the date the school moved it to, or that it is no longer on the school site.
  {
    const d = withSchool(tutorDb());
    const feed = schoolFeedRow({ kid_id: P.jordan, kind: 'assignments', checked: true });
    d.school_feeds.push(feed);
    d.assignments.push(
      assignmentRow({ id: hid(50), kid_id: P.jordan, added_by: 'school', title: 'Lab report', subject: 'Biology', due_date: '2026-11-20', created_by: 'Jordan (My day)',
        created_at: '2026-10-30T20:00:00.000000+00:00' }),
      assignmentRow({ id: hid(51), kid_id: P.jordan, added_by: 'school', title: 'Map quiz', subject: 'Geography', due_date: '2026-11-09', created_by: 'alex@example.com',
        created_at: '2026-10-30T20:00:00.000000+00:00' }),
    );
    d.school_items.push(
      schoolItemRow({ feed_id: feed.id, title: 'Lab report', subject: 'Biology', due_date: '2026-11-23', assignment_id: hid(50), made_at: '2026-10-30T20:00:00.000000+00:00',
        applied: { title: 'Lab report', subject: 'Biology', due_date: '2026-11-20', details: null } }),
      schoolItemRow({ feed_id: feed.id, title: 'Map quiz', subject: 'Geography', due_date: '2026-11-09', assignment_id: hid(51), made_at: '2026-10-30T20:00:00.000000+00:00',
        applied: { title: 'Map quiz', subject: 'Geography', due_date: '2026-11-09', details: null }, gone_at: '2026-11-01T20:00:00.000000+00:00' }),
      schoolItemRow({ feed_id: feed.id, title: 'Read chapter 5', subject: 'History', due_date: '2026-11-04' }),
    );
    ({ page, db } = await open({ label: 'pat-school', path: `/day.html?h=${PAT}`, db: d }));
    await page.waitForSelector('.plan-arows');
    const rows = await texts(page, '.plan-arow');
    check('Pat\'s link: "from school · the school moved it to Mon Nov 23" and "from school · no longer on the school site" on assignments made from school',
      rows.some((x) => /Lab report/.test(x) && /from school · the school moved it to Mon Nov 23/.test(x)) && rows.some((x) => /Map quiz/.test(x) && /from school · no longer on the school site/.test(x)),
      JSON.stringify(rows));
    check('... and nothing of his New from school (an item nobody made an assignment isn\'t on Pat\'s link)', !rows.some((x) => /Read chapter 5/.test(x)) && !(await page.content()).includes('Read chapter 5'));
    await page.click(`.plan-arow-link[href="#a/${hid(50)}"]`);
    await page.waitForSelector('.plan-tutor-a');
    check('... its page says it too: "from school · the school moved it to Mon Nov 23"', /from school · the school moved it to Mon Nov 23/.test(await text(page, '.plan-head .meta')), await text(page, '.plan-head .meta'));
    await page.context().close();
  }

  ({ page, db } = await open({ label: 'pat-es', path: `/day.html?h=${PAT}`, db: tutorDb({ lang: 'es' }),
    ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } }));
  await page.waitForSelector('.plan-tutor');
  check('Spanish link: "Tarea · Jordan", the page in Spanish, the coaching line', (await page.title()) === 'Tarea · Jordan' && (await page.evaluate(() => document.documentElement.lang)) === 'es'
    && (await text(page, '.plan-coach')) === 'Empieza por lo que hizo. Pregunta qué sigue y cuándo lo empezará.', `${await page.title()} ${await text(page, '.plan-coach')}`);
  check('Spanish link at 390px: no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: SHOTS + 'tutor-es-phone.png', fullPage: true });
  await page.context().close();


  // =====================================================================
  // 3. The coach view (schema 7, 0007; docs/v1.3-homework.md §20.6): a Coach section for a link a parent turned it on for
  // =====================================================================
  const COACH_FNS = /^(tutor_view_by_token|tutor_assignment_by_token|tutor_plan_by_token|tutor_step_by_token|coach_view_by_token|coach_note_by_token)$/;
  function coachDb(o) {
    const d = withCoach(tutorDb(o));
    d.tutor_links[0].coach = true;
    // His own calendar and his daily tasks, as agenda() and google_for() give them (that no one else's reach them is
    // the database's: tests/db/coach.test.sql).
    d.coachCal[P.jordan] = [
      { day: '2026-10-29', all_day: false, starts: '16:00', ends: '17:00', title: 'Soccer practice' },
      { day: '2026-11-03', all_day: false, starts: '17:00', ends: '17:45', title: 'Piano lesson' },
      { day: '2026-11-09', all_day: false, starts: '10:00', ends: '11:00', title: 'Doctor visit', private: true },
      { day: '2026-11-13', end_day: '2026-11-14', all_day: true, title: 'Science fair' },
    ];
    d.coachTasks[P.jordan] = [
      { day: TODAY, title: 'Feed the cat', status: 'open' },
      { day: '2026-11-01', title: 'Make bed', status: 'done' },
      { day: '2026-10-31', title: 'Make bed', status: 'missed' },
      { day: '2026-10-31', title: 'Diary', private: true, status: 'done' },
    ];
    d.points_ledger.push(
      ledgerRow({ kid_id: P.jordan, at: at('2026-11-02T21:21:00'), day: TODAY, kind: 'focus', delta: 20, note: 'Find 2 sources', who: 'Jordan (My day)' }),
      ledgerRow({ kid_id: P.jordan, at: at('2026-11-02T21:20:00'), day: TODAY, kind: 'on_time', delta: 10, note: 'Find 2 sources', who: 'Jordan (My day)' }),
      ledgerRow({ kid_id: P.jordan, at: at('2026-10-28T21:00:00'), day: '2026-10-28', kind: 'trade', delta: -60, note: 'Pick the movie', who: 'alex@example.com' }),
    );
    d.rewards.push(rewardRow({ kid_id: P.jordan, title: 'Extra game time', cost: 15, instant: true, sort_order: -1 }));
    return d;
  }
  const coachText = (page) => text(page, '[data-sec="coach"]');
  // A table's rows, each its cells' text joined by spaces.
  const cells = (page, sel) => page.$$eval(sel, (rs) => rs.map((r) => [...r.children].map((c) => c.textContent.trim()).join(' ')));
  {
    ({ page, db } = await open({ label: 'coach', path: `/day.html?h=${PAT}`, db: coachDb({ running: true }) }));
    await page.waitForSelector('[data-sec="coach"]');
    check('coach on: the list, then coach_view_by_token({ p_token }) once; nothing else new', same(db.calls.map((c) => c.name), ['tutor_view_by_token', 'coach_view_by_token'])
      && same(calls(db, 'coach_view_by_token')[0].body, { p_token: PAT }), JSON.stringify(db.calls.map((c) => [c.name, c.body])));
    check('coach on: a Coach section after the fixed ones', same(await page.$$eval('.plan-sec', (ss) => ss.map((x) => x.dataset.sec)),
      ['check', 'talk', 'questions', 'plans', 'assignments', 'week', 'record', 'coach']), JSON.stringify(await page.$$eval('.plan-sec', (ss) => ss.map((x) => x.dataset.sec))));
    check('Coach: its heading and what it is, in plain words', (await text(page, '[data-sec="coach"] h2')) === 'Coach'
      && (await text(page, '.coach-lead')) === "Jordan's family lets you see his points, rewards, focus sessions, his own calendar and his daily tasks. Read-only.",
      await text(page, '.coach-lead'));
    check('Coach: his balance, and this week\'s and last week\'s points by kind',
      (await text(page, '.coach-balance')) === '88 points'
      && same(await cells(page, '.coach-weeks tbody tr'), ['Focus +20 0', 'On time +10 0', 'Milestones 0 0', 'Given 0 +118', 'Voided 0 0', 'Trades 0 −60'])
      && same(await texts(page, '.coach-weeks thead th'), ['', 'This week', 'Last week']), JSON.stringify(await cells(page, '.coach-weeks tr')));
    check('Coach: the last 30 days\' lines, newest first, with no one\'s name', same(await texts(page, '.coach-lines li'),
      ['Today · +20 · Focus · Find 2 sources', 'Today · +10 · On time · Find 2 sources', 'Wed Oct 28 · −60 · Trade · Pick the movie', 'Mon Oct 26 · +118 · Given · Great session']),
      JSON.stringify(await texts(page, '.coach-lines li')));
    check('Coach: his rewards (cost, instant) and his asks and cash-ins', same(await texts(page, '.coach-rewards li'), ['Extra game time · 15 · instant', "Choose Friday's dinner · 60"])
      && same(await texts(page, '.coach-asks li'), ["Choose Friday's dinner · 60 · asked today · waiting"]), `${JSON.stringify(await texts(page, '.coach-rewards li'))} ${JSON.stringify(await texts(page, '.coach-asks li'))}`);
    check('Coach: his focus sessions (day, assignment, minutes chosen and seen, result, his note); never the block running now, nor with whom',
      same(await texts(page, '.coach-focus li'), ['Yesterday · Science project: river poster · 25 min chosen · 25 seen · More to do',
        'Fri Oct 30 · Science project: river poster · 20 min chosen · 20 seen · Step done · “found 2 sources”'])
      && !/Worksheet 4\.2|alone|with you|parent/i.test(await text(page, '.coach-focus')), JSON.stringify(await texts(page, '.coach-focus li')));
    check('Coach: his own calendar, the next 14 days and the last 7; a private one as "Private item"',
      same(await texts(page, '.coach-cal-next li'), ['Tomorrow · 5:00pm–5:45pm · Piano lesson', 'Mon Nov 9 · 10:00am–11:00am · Private item', 'Fri Nov 13 – Sat Nov 14 · All day · Science fair'])
      && same(await texts(page, '.coach-cal-last li'), ['Thu Oct 29 · 4:00pm–5:00pm · Soccer practice']), `${JSON.stringify(await texts(page, '.coach-cal-next li'))} ${JSON.stringify(await texts(page, '.coach-cal-last li'))}`);
    check('Coach: his daily tasks of today and the last 7 days, done or not', same(await texts(page, '.coach-tasks li'),
      ['Today · Not done yet · Feed the cat', 'Yesterday · Done · Make bed', 'Sat Oct 31 · Missed · Make bed', 'Sat Oct 31 · Done · Private item']), JSON.stringify(await texts(page, '.coach-tasks li')));
    const cbody = await page.evaluate(() => document.body.innerText);
    check('coach on: still nothing of the family: no other person\'s name, surname, email, private title', !/Alex|Morgan|Sam\b|Taylor|Example|@|Doctor visit|Diary/.test(cbody),
      (cbody.match(/Alex|Morgan|Sam\b|Taylor|Example|@|Doctor visit|Diary/g) || []).join(','));
    // A note for the family: checked first, then sent with the page's key.
    await page.click('.coach-note [type="submit"]');
    check('a note with nothing in it: "Write a note first." and no call', (await text(page, '.coach-note .form-error')) === 'Write a note first.' && !calls(db, 'coach_note_by_token').length);
    await page.fill('.coach-note textarea[name="note"]', 'Suggest lowering the on-time bonus.\nHe starts on time anyway.');
    // A refresh while a note is being typed keeps it.
    const cv = calls(db, 'coach_view_by_token').length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(() => calls(db, 'tutor_view_by_token').length >= 2);
    await page.waitForTimeout(200);
    check('a refresh while a note is typed: the list is read, the Coach section isn\'t drawn again, the note is kept',
      calls(db, 'coach_view_by_token').length === cv && (await page.inputValue('.coach-note textarea[name="note"]')) === 'Suggest lowering the on-time bonus.\nHe starts on time anyway.');
    db.hold = true;
    await page.route((url) => url.pathname.endsWith('/rpc/coach_note_by_token'), async (route) => { while (db.hold) await new Promise((r) => setTimeout(r, 30)); return route.fallback(); });
    await page.click('.coach-note [type="submit"]');
    await page.waitForTimeout(150);
    check('Send: the button is off while the note is on its way', await page.$eval('.coach-note [type="submit"]', (b) => b.disabled));
    db.hold = false;
    await until(() => calls(db, 'coach_note_by_token').length === 1);
    const sent = calls(db, 'coach_note_by_token')[0].body;
    check('Send: coach_note_by_token with the page\'s key and the note', sent.p_token === PAT && UUID.test(sent.p_key) && sent.p_note === 'Suggest lowering the on-time bonus.\nHe starts on time anyway.',
      JSON.stringify(sent));
    check('… "Sent to the family." and the note under Your notes; the box emptied', await until(async () => /Sent to the family\./.test(await text(page, '.toasts')))
      && await until(async () => same(await texts(page, '.coach-notes li'), ['Today · Suggest lowering the on-time bonus. He starts on time anyway.']))
      && (await page.inputValue('.coach-note textarea[name="note"]')) === '' && db.coach_notes.length === 1, JSON.stringify(await texts(page, '.coach-notes li')));
    // An assignment's screen has no Coach section and asks for none; back on the list it is read again.
    const before = calls(db, 'coach_view_by_token').length;
    await page.click(`.plan-arow-link[href="#a/${I.sci}"]`);
    await page.waitForSelector('.plan-tutor-a');
    await page.waitForTimeout(200);
    check('an assignment\'s screen: no Coach section, no coach read', !(await page.$('[data-sec="coach"]:not([hidden])')) && !(await page.isVisible('[data-sec="coach"]').catch(() => false))
      && calls(db, 'coach_view_by_token').length === before);
    await page.click('.plan-tutor-a .back');
    check('back on the list: the Coach section again, read afresh', await until(async () => page.isVisible('[data-sec="coach"]')) && calls(db, 'coach_view_by_token').length === before + 1);
    // The parents turn it off: on the next read the section goes, and nothing more is asked.
    db.tutor_links[0].coach = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    check('the parents turn it off: on the next read the Coach section goes', await until(async () => !(await page.isVisible('[data-sec="coach"]').catch(() => false))));
    const after = calls(db, 'coach_view_by_token').length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(300);
    check('... and no coach read after that', calls(db, 'coach_view_by_token').length === after && db.calls.every((c) => COACH_FNS.test(c.name)), [...new Set(db.calls.map((c) => c.name))].join(','));
    check('nothing is kept on the device, with the coach view either', await page.evaluate(() => { try { return localStorage.length === 0 && sessionStorage.length === 0; } catch (e) { return true; } }));
    await page.context().close();
  }
  {
    // His overdue tasks (Late on his My day) come first, "Late since …"; an ask from long ago that a parent decided
    // yesterday is among the asks (review findings 4 and 7).
    const d = coachDb();
    d.coachTasks[P.jordan].push({ day: '2026-10-22', title: 'Return library book', status: 'late' }, { day: '2026-10-25', title: 'Old form', private: true, status: 'late' });
    d.reward_asks.push({ id: hid(51), kid_id: P.jordan, reward_id: null, title: 'New bike helmet', cost: 500, status: 'approved',
      asked_at: at('2026-09-23T20:00:00'), decided_at: at('2026-11-01T22:00:00'), decided_by: 'alex@example.com', note: null });
    ({ page, db } = await open({ label: 'coach-late', path: `/day.html?h=${PAT}`, db: d }));
    await page.waitForSelector('[data-sec="coach"]');
    check('Coach: his overdue tasks first, oldest first, "Late since …" (a private one as "Private item"), then the last 7 days',
      (await text(page, '[data-part="tasks"] h3')) === 'His daily tasks (late ones, today and the last 7 days)' && same(await texts(page, '.coach-tasks li'), ['Late since Thu Oct 22 · Return library book', 'Late since Sun Oct 25 · Private item',
        'Today · Not done yet · Feed the cat', 'Yesterday · Done · Make bed', 'Sat Oct 31 · Missed · Make bed', 'Sat Oct 31 · Done · Private item'])
      && (await page.$$('.coach-tasks li.is-late')).length === 2, JSON.stringify(await texts(page, '.coach-tasks li')));
    check('Coach: an ask from 40 days ago that a parent said yes to yesterday, newest decision first', same(await texts(page, '.coach-asks li'),
      ["Choose Friday's dinner · 60 · asked today · waiting", 'New bike helmet · 500 · asked Wed Sep 23 · approved yesterday']), JSON.stringify(await texts(page, '.coach-asks li')));
    await page.context().close();
  }
  {
    // A note whose answer is lost ("Can't reach Home Hub"): sent again as it is, it finds the note it made (one note);
    // changed before it is sent again, it is a new note with a new key, so the corrected words reach the parents
    // (the first one, which did land, stays as a note of its own) (review finding 6).
    ({ page, db } = await open({ label: 'coach-lost', path: `/day.html?h=${PAT}`, db: coachDb(), allowConsole: /ERR_CONNECTION_RESET/ }));
    await page.waitForSelector('[data-sec="coach"]');
    await page.fill('.coach-note textarea[name="note"]', 'He starts on time most days.');
    db.loseAnswer = 'coach_note_by_token';
    await page.click('.coach-note [type="submit"]');
    check('an answer lost on the way: "Can\'t reach Home Hub…" and the note kept in the box', await until(async () => /Can't reach Home Hub/.test(await text(page, '.coach-note .form-error')))
      && (await page.inputValue('.coach-note textarea[name="note"]')) === 'He starts on time most days.' && db.coach_notes.length === 1, await text(page, '.coach-note .form-error'));
    await page.click('.coach-note [type="submit"]');
    await until(() => calls(db, 'coach_note_by_token').length === 2);
    const [s1, s2] = calls(db, 'coach_note_by_token').map((c) => c.body);
    check('... sent again as it is: the same key, one note, "Sent to the family."', s1.p_key === s2.p_key && await until(async () => /Sent to the family\./.test(await text(page, '.toasts')))
      && db.coach_notes.length === 1 && (await page.inputValue('.coach-note textarea[name="note"]')) === '', JSON.stringify([s1, s2, db.coach_notes.map((n) => n.note)]));
    db.hwNow += 60e3;   // a minute later
    await page.fill('.coach-note textarea[name="note"]', 'Suggest lowering the on-time bonus.');
    db.loseAnswer = 'coach_note_by_token';
    await page.click('.coach-note [type="submit"]');
    await until(async () => /Can't reach Home Hub/.test(await text(page, '.coach-note .form-error')));
    db.hwNow += 60e3;
    await page.fill('.coach-note textarea[name="note"]', 'Suggest lowering the on-time bonus to 5, not 10.');
    await page.click('.coach-note [type="submit"]');
    await until(() => calls(db, 'coach_note_by_token').length === 4);
    const [s3, s4] = calls(db, 'coach_note_by_token').slice(2).map((c) => c.body);
    check('... changed before it is sent again: a new key, so the parents get the corrected words too', s3.p_key !== s4.p_key && UUID.test(s4.p_key)
      && same(db.coach_notes.map((n) => n.note).sort(), ['He starts on time most days.', 'Suggest lowering the on-time bonus to 5, not 10.', 'Suggest lowering the on-time bonus.'])
      && await until(async () => same(await texts(page, '.coach-notes li'), ['Today · Suggest lowering the on-time bonus to 5, not 10.', 'Today · Suggest lowering the on-time bonus.',
        'Today · He starts on time most days.'])), JSON.stringify([s3, s4, db.coach_notes.map((n) => n.note), await texts(page, '.coach-notes li')]));
    await page.context().close();
  }
  {
    // Points off: the Coach section says so, and shows no rewards or asks.
    const d = coachDb();
    d.homework_kids[0].points_on = false;
    ({ page, db } = await open({ label: 'coach-points-off', path: `/day.html?h=${PAT}`, db: d }));
    await page.waitForSelector('[data-sec="coach"]');
    check('points off: "Points are off for Jordan." and no rewards or asks; the rest shows', /Points are off for Jordan\./.test(await coachText(page))
      && !(await page.$('.coach-rewards')) && !(await page.$('.coach-asks')) && (await texts(page, '.coach-tasks li')).length === 4, await coachText(page));
    await page.context().close();
  }
  {
    // A link with the coach view off, on schema 7: no coach call at all (the default tutorDb has no coach_notes: before 0007).
    ({ page, db } = await open({ label: 'coach-off-7', path: `/day.html?h=${PAT}`, db: withCoach(tutorDb()) }));
    await page.waitForSelector('.plan-tutor');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(300);
    check('schema 7, coach off: no Coach section and no coach call, even after a refresh', !(await page.$('[data-sec="coach"]:not([hidden])'))
      && db.calls.every((c) => TUTOR_FNS.test(c.name)), db.calls.map((c) => c.name).join(','));
    await page.context().close();
  }
  {
    // Spanish, on a phone.
    ({ page, db } = await open({ label: 'coach-es', path: `/day.html?h=${PAT}`, db: coachDb({ lang: 'es' }),
      ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } }));
    await page.waitForSelector('[data-sec="coach"]');
    check('Spanish: the Coach section in Spanish ("Coach", the plain words, "Asunto privado")', (await text(page, '[data-sec="coach"] h2')) === 'Coach'
      && (await text(page, '.coach-lead')) === 'La familia de Jordan te deja ver sus puntos, premios, sesiones de concentración, su propio calendario y sus tareas diarias. Solo lectura.'
      && /Asunto privado/.test(await coachText(page)) && /Esta semana/.test(await coachText(page)) && /Enviar a la familia/.test(await coachText(page)), await coachText(page));
    check('Spanish at 390px: no sideways scroll with the Coach section', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.locator('[data-sec="coach"]').screenshot({ path: SHOTS + 'tutor-coach-es-phone.png' });
    await page.context().close();
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
  await server.close();
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
