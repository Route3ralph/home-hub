// Browser tests for assets/plan.js (window.HomePlan), homework's shared pieces (docs/v1.3-homework.md
// §2.1, §4, §5, §7.2, §9.4, §9.5, §9.7): the words in English and Spanish (every key in both, with the
// same placeholders; "Pat" from the tutor link, and the words for a kid with none), escaping and cleaning
// of what people type, the household's dates, placement (§5.4: the buffer, the first day, room, the order,
// a given day kept or moved, "doesn't fit" with the minutes over, the turn-in on the due date, done steps
// and the past left alone, the 8-week horizon, no homework time), homework time left, the starter plans
// (every step of every plan in both languages against plan_check's rules and his first length), the two
// bars, the week strip, the timelines (the overview of open assignments, an assignment's chart by phase,
// his path of days with the next flag: columns and clipping, overdue, milestones known or only the next,
// behind steps, folding past 14 days, escaping, Spanish, the Nov 1 clock change, and drawn at 390px and
// 1280px, light and dark), pace, the timer counted from the server's clock with the device's clock a day
// off, the ring, the end screen's points line, what an answer means and the database's messages in his
// words. Then the plan editor (each role's rules: a parent's or Pat's whole plan, Jordan's plain steps,
// starter plans, Save, Give, Place again, Re-plan, a stale save, a link that no longer works) and Pat's
// link (only its api, the fixed order, Looks done and Not yet with notes, answers, a new lesson, an
// assignment's plan, no points or family names, nothing live), each with a fake api in the page.
// Everything runs in day.html (day.js and supabase-js stubbed out; plan.js and plan.css added by the
// test, since the pages load them only once they are wired in), at Pacific/Kiritimati with the device's
// date a day ahead of the household's, so nothing can lean on the device's clock or zone.
// Run alone with: node tests/e2e/plan.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');
const { serve, ROOT } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TOKEN = '0123456789abcdef0123456789abcdef';
// The household's Monday Nov 2 2026, 4:31pm in New York, as the server says; the device thinks it's a day later.
const SERVER_NOW = '2026-11-02T21:31:04.512Z';
const DEVICE = new Date('2026-11-03T21:31:04.512Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOSTILE = '<img src=x onerror="window.__xss=1">';

// The week the examples use (§2.5): homework time Mon–Thu 4:30–5:15 and Sun 5:00–5:45, piano on Tuesday,
// 25 minutes of another assignment on Thursday.
const W = (day, starts, ends, free, planned, busy) => ({ day, window: starts ? { starts, ends } : null, busy: busy || [], free, planned });
const WEEK = [
  W('2026-11-02', '16:30', '17:15', 45, 0), W('2026-11-03', '16:30', '17:15', 30, 0, [{ starts: '17:00', ends: '18:00', title: 'Piano' }]),
  W('2026-11-04', '16:30', '17:15', 45, 0), W('2026-11-05', '16:30', '17:15', 45, 25), W('2026-11-06', null, null, 0, 0),
  W('2026-11-07', null, null, 0, 0), W('2026-11-08', '17:00', '17:45', 45, 0), W('2026-11-09', '16:30', '17:15', 45, 0),
  W('2026-11-10', '16:30', '17:15', 30, 0, [{ starts: '17:00', ends: '18:00', title: 'Piano' }]), W('2026-11-11', '16:30', '17:15', 45, 0),
  W('2026-11-12', '16:30', '17:15', 45, 0), W('2026-11-13', null, null, 0, 0), W('2026-11-14', null, null, 0, 0), W('2026-11-15', '17:00', '17:45', 45, 0),
];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];

  // plan.js touches nothing of the page when it loads: it runs with only a window object (so mock.js can
  // use its placement rule in Node too).
  let nodePlan = null;
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'assets/plan.js'), 'utf8'), sandbox);
    nodePlan = sandbox.window.HomePlan || null;
  } catch (err) { nodePlan = null; errors.push(`node load: ${err.message}`); }
  check('plan.js loads with nothing but a window object (no DOM, clock or storage when it loads)', !!nodePlan && typeof nodePlan.place === 'function');
  // No calls, storage or listeners of its own (each page hands it an api, and its listeners are on the element
  // it is given), and every invisible character in its source written as an escape.
  const planSrc = fs.readFileSync(path.join(ROOT, 'assets/plan.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'assets/css/plan.css'), 'utf8');
  const code = planSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const reaches = ['fetch(', '.rpc(', 'supabase', 'functions.invoke', 'localStorage', 'sessionStorage', 'indexedDB', 'window.addEventListener', 'document.addEventListener',
    'XMLHttpRequest', 'navigator.sendBeacon'].filter((x) => code.includes(x));
  check('plan.js makes no database or network calls, keeps nothing on the device, and listens only on the element it is given', !reaches.length, reaches.join(', '));
  const invisible = (s) => [...s].filter((ch) => /[\p{Cf}\p{Zl}\p{Zp}]|[^\S \n]/u.test(ch) && ch !== '\t').map((ch) => `U+${ch.codePointAt(0).toString(16)}`);
  check('plan.js and plan.css: no invisible characters in the source (U+2028, bidi, zero-width, no-break spaces are escapes)',
    !invisible(planSrc).length && !invisible(cssSrc).length, [...invisible(planSrc), ...invisible(cssSrc)].join(' '));

  async function openPage(ctx) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.route('**/config.js*', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.HOME_HUB_CONFIG = {};' }));
    await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.route('**/assets/day.js*', (r) => r.fulfill({ contentType: 'application/javascript', body: '// not under test' }));
    await page.clock.install({ time: DEVICE });
    await page.goto(`${BASE}/day.html?h=${TOKEN}`);
    await page.addScriptTag({ url: `${BASE}/assets/plan.js` });
    await page.addStyleTag({ url: `${BASE}/assets/css/plan.css` });
    await page.evaluate(() => { document.getElementById('app').innerHTML = ''; });
    return page;
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Pacific/Kiritimati', locale: 'en-US' });
  const page = await openPage(context);
  await page.clock.pauseAt(new Date(DEVICE.getTime() + 1000));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  // =====================================================================
  // 1. The global, the words, escaping and cleaning
  // =====================================================================
  const basics = await ev(() => {
    const P = window.HomePlan;
    if (!P) return { loaded: 'undefined' };
    const keysEn = Object.keys(P.WORDS.en).sort();
    const keysEs = Object.keys(P.WORDS.es).sort();
    const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
    return {
      loaded: typeof P, frozen: Object.isFrozen(P),
      names: Object.keys(P).sort(),
      constants: [P.LENGTHS, P.KINDS, P.PLAIN, P.HORIZON, P.LIMITS.steps, P.LIMITS.milestones, P.LIMITS.title, P.LIMITS.minutes, P.LIMITS.dll],
      onlyEn: keysEn.filter((k) => !P.WORDS.es[k]), onlyEs: keysEs.filter((k) => !P.WORDS.en[k]),
      holesDiffer: keysEn.filter((k) => P.WORDS.es[k] && holes(P.WORDS.en[k]) !== holes(P.WORDS.es[k])),
      empty: keysEn.filter((k) => !String(P.WORDS.en[k]).trim() || !String(P.WORDS.es[k] || '').trim()),
      sample: [
        P.t('start_n', { n: 20 }, 'en'), P.t('start_n', { n: 20 }, 'es'), P.t('homework', null, 'es'), P.t('tonight', null, 'es'),
        P.t('ask_tutor', { tutor: 'Pat' }, 'en'), P.t('ask_tutor', { tutor: null }, 'en'), P.t('ask_tutor', { tutor: null }, 'es'),
        P.t('waiting_check', { n: 20, tutor: 'Pat' }, 'en'), P.t('waiting_check', { n: 20, tutor: 'Pat' }, 'es'),
        P.t('from_day', { day: 'el lun' }, 'es'), P.t('from_day', { day: 'hoy' }, 'es'), P.t('nonsense_key', null, 'en'),
        P.t('who_sees', { tutor: 'Pat' }, 'es'), P.t('link_gone', null, 'es'), P.t('turn_in', null, 'es'),
      ],
      esc: P.esc(`<b>"Sam" & 'Alex'</b>`),
      clean: [P.clean('  two\u0007 lines\u2028and\u200b\u202e bidi\u00a0 ', 100), P.clean('abcdef', 3), P.clean(null, 5)],
      block: [P.cleanBlock('Line one\r\n\r\n\r\n\tLine\u202e two  \n\n\nLast\u200b', 4000), P.cleanBlock('a\n'.repeat(70), 4000).split('\n').length, P.cleanBlock('xyz', 2)],
      id: [P.newId(), P.newId()],
    };
  });
  check('plan.js loads in day.html as window.HomePlan, frozen', basics.loaded === 'object' && basics.frozen);
  const API = ['HORIZON', 'KINDS', 'LENGTHS', 'LIMITS', 'PLAIN', 'STARTERS', 'WORDS', 'addDays', 'answer', 'audioAt', 'bars', 'check', 'clean',
    // PR B adds hashText and previewMark (the AI preview's "last sent" mark); its review previewSeal (the seal hub-jobs
    // checks) and aiFailure (a failed hub-jobs call as a stop).
    'cleanBlock', 'daysBetween', 'editor', 'ended', 'esc', 'estimate', 'firstDay', 'fmt', 'focused', 'friendly', 'fromRows', 'goalBar', 'guess', 'hashText', 'homeworkDays',
    'horizon', 'isoWeekday', 'lastWorkDay', 'left', 'ms', 'newId', 'onTimeLine', 'pace', 'place', 'pointsLine', 'previewMark', 'previewSeal', 'aiFailure', 'ring', 'spare', 'starter',
    't', 'timeLeft', 'timer', 'tutor', 'week', 'weekday', 'workLeft',
    // The timelines: the overview of open assignments, an assignment's chart, and Jordan's path.
    'overview', 'chart', 'path'];
  check('the documented API, and nothing else', same(basics.names, API.slice().sort()), JSON.stringify(basics.names));
  check('constants: lengths 10/15/20/25, the five kinds, the plain ones, 56 days, plan_check\'s limits',
    same(basics.constants, [[10, 15, 20, 25], ['start', 'step', 'milestone', 'check', 'turn_in'], ['start', 'step', 'check'], 56, 20, 4, [3, 80], [5, 60], 160]),
    JSON.stringify(basics.constants));
  check('every word in English and in Spanish, none empty', !basics.onlyEn.length && !basics.onlyEs.length && !basics.empty.length,
    JSON.stringify([basics.onlyEn, basics.onlyEs, basics.empty]));
  check('the same placeholders in both languages', !basics.holesDiffer.length, JSON.stringify(basics.holesDiffer));
  check('t(): placeholders filled; "Pat" from the tutor link, and the no-tutor words; "de el" → "del"; an unknown key stays a key',
    same(basics.sample, ['Start · 20 min', 'Empezar · 20 min', 'Tarea', 'Esta tarde', 'Ask Pat', 'Ask for help', 'Pedir ayuda',
      '+20 when Pat checks it', '+20 cuando Pat lo revise', 'del lun', 'de hoy', 'nonsense_key',
      'Pat y los adultos de tu familia ven tu plan y tus notas. Los adultos ven tus puntos.',
      'Este enlace ya no funciona. Pide uno nuevo a la familia.', 'Entregarlo']), JSON.stringify(basics.sample));
  check('esc(): & < > " \' escaped', basics.esc === '&lt;b&gt;&quot;Sam&quot; &amp; &#39;Alex&#39;&lt;/b&gt;', basics.esc);
  check('clean(): as private.clean_text (one line, no control, bidi or zero-width characters, cut to its length)',
    same(basics.clean, ['two lines and bidi', 'abc', '']), JSON.stringify(basics.clean));
  check('cleanBlock(): as private.clean_block (line breaks kept, never two blank lines in a row, at most 60 lines, cut to its length)',
    same(basics.block, ['Line one\n\nLine two\n\nLast', 60, 'xy']), JSON.stringify(basics.block));
  check('newId(): random version 4 uuids', basics.id.every((x) => UUID.test(x)) && basics.id[0] !== basics.id[1], JSON.stringify(basics.id));

  // =====================================================================
  // 2. Dates and formats: the household's dates, never the device's
  // =====================================================================
  const dates = await ev(() => {
    const P = window.HomePlan;
    const f = P.fmt;
    return {
      arith: [P.addDays('2026-10-31', 2), P.addDays('2026-11-01', -1), P.daysBetween('2026-11-02', '2026-11-13'), P.daysBetween('2026-11-13', '2026-11-02'),
        P.weekday('2026-11-01'), P.weekday('2026-11-02'), P.isoWeekday('2026-11-01'), P.isoWeekday('2026-11-02'), P.addDays('nope', 1)],
      en: [f.day('2026-11-13', 'en'), f.short('2027-04-30', 'en'), f.weekday('2026-11-04', 'en'), f.time('16:30', 'en'), f.time('09:05', 'en'), f.time('00:15', 'en'), f.time('12:00', 'en'),
        f.duration(45, 'en'), f.duration(60, 'en'), f.duration(100, 'en'), f.duration(195, 'en'), f.duration(65, 'en'), f.duration(0, 'en')],
      es: [f.day('2026-11-13', 'es'), f.short('2027-04-30', 'es'), f.weekday('2026-11-04', 'es'), f.weekday('2026-11-07', 'es'), f.time('16:30', 'es'), f.time('09:05', 'es'), f.duration(100, 'es')],
      rel: ['2026-11-02', '2026-11-03', '2026-11-01', '2026-11-04', '2026-10-28', '2026-11-08', '2026-11-09', '2026-10-26'].map((d) => f.rel(d, '2026-11-02', 'en')),
      relEs: ['2026-11-02', '2026-11-03', '2026-11-01', '2026-11-04', '2026-11-13'].map((d) => f.rel(d, '2026-11-02', 'es')),
    };
  });
  check('addDays, daysBetween, weekday (0 = Sunday) and isoWeekday (1 = Monday, 7 = Sunday) in whole days, across the Nov 1 clock change',
    same(dates.arith, ['2026-11-02', '2026-10-31', 11, -11, 0, 1, 7, 1, null]), JSON.stringify(dates.arith));
  check('fmt in English: Fri Nov 13, Apr 30, Wed, 4:30pm, 9:05am, 12:15am, 12:00pm, 45 min, 1 h, 1 h 40, 3 h 15, 1 h 05, 0 min',
    same(dates.en, ['Fri Nov 13', 'Apr 30', 'Wed', '4:30pm', '9:05am', '12:15am', '12:00pm', '45 min', '1 h', '1 h 40', '3 h 15', '1 h 05', '0 min']), JSON.stringify(dates.en));
  check('fmt in Spanish: vie 13 nov, 30 abr, mié, sáb, 16:30, 9:05, 1 h 40',
    same(dates.es, ['vie 13 nov', '30 abr', 'mié', 'sáb', '16:30', '9:05', '1 h 40']), JSON.stringify(dates.es));
  check('fmt.rel: today, tomorrow, yesterday, a weekday within 6 days, else the date',
    same(dates.rel, ['today', 'tomorrow', 'yesterday', 'Wed', 'Wed', 'Sun', 'Mon Nov 9', 'Mon Oct 26']), JSON.stringify(dates.rel));
  check('fmt.rel in Spanish, with the article a sentence needs', same(dates.relEs, ['hoy', 'mañana', 'ayer', 'el mié', 'el vie 13 nov']), JSON.stringify(dates.relEs));

  // =====================================================================
  // 3. Placement (§5.4), homework time left, work left, days spare
  // =====================================================================
  const placed = await ev((WEEK) => {
    const P = window.HomePlan;
    const days = (r) => r.steps.map((s) => s.day);
    const essay = P.starter('essay', { lang: 'en', length: 20 });
    const base = { today: '2026-11-02', due: '2026-11-13', kind: 'assignment', asOf: '2026-11-02T16:31', days: WEEK };
    const r1 = P.place(essay, base);
    const r2 = P.place(essay, Object.assign({}, base, { asOf: '2026-11-02T17:20' }));
    const r3 = P.place(essay, Object.assign({}, base, { due: '2026-11-04' }));
    const given = [
      { kind: 'step', title: 'Kept on Thursday', minutes: 20, day: '2026-11-05' },
      { kind: 'step', title: 'Asked for Tuesday, after Thursday', minutes: 20, day: '2026-11-03' },
      { kind: 'step', title: 'In the past', minutes: 10, day: '2026-10-30' },
      { kind: 'step', title: 'Done already', minutes: 25, day: '2026-10-29', done: true },
      { kind: 'step', title: 'Too big for Thursday', minutes: 25, day: '2026-11-05' },
      { kind: 'turn_in', title: 'Turn it in', minutes: 5 },
    ];
    const r4 = P.place(given, base);
    const far = P.place(P.starter('short', { lang: 'en', length: 20 }), Object.assign({}, base, { due: '2027-02-01' }));
    const none = P.place(essay, Object.assign({}, base, { days: [] }));
    const off = P.place(essay, Object.assign({}, base, { days: WEEK.map((d) => Object.assign({}, d, { window: null, free: 0 })) }));
    const lesson = P.place([{ kind: 'step', title: 'Practice', minutes: 20 }, { kind: 'milestone', title: 'Practice', minutes: 20 }],
      Object.assign({}, base, { kind: 'lesson', due: '2026-11-03', asOf: '2026-11-02T17:30' }));
    return {
      last: [P.lastWorkDay('2026-11-08', '2026-11-02', 'assignment'), P.lastWorkDay('2026-11-09', '2026-11-02', 'assignment'), P.lastWorkDay('2026-11-13', '2026-11-02', 'assignment'),
        P.lastWorkDay('2026-11-13', '2026-11-02', 'lesson'), P.lastWorkDay('2026-11-03', '2026-11-02', 'assignment')],
      ended: [P.ended('2026-11-02', '2026-11-02T16:31', { starts: '16:30', ends: '17:15' }), P.ended('2026-11-02', '2026-11-02T17:15', { starts: '16:30', ends: '17:15' }),
        P.ended('2026-11-02', '2026-11-02T23:59', null), P.ended('2026-11-02', '2026-11-01T23:59', { starts: '16:30', ends: '17:15' })],
      first: [P.firstDay('2026-11-02', false), P.firstDay('2026-11-02', true)],
      horizon: P.horizon('2026-11-02'),
      r1: [days(r1), r1.fits, r1.over, r1.horizon, r1.no_time, r1.steps.length, r1.steps[0].title, essay[0].day],
      r2: days(r2).slice(0, 3),
      r3: [days(r3), r3.fits, r3.over],
      r4: [days(r4), r4.fits, r4.over],
      far: [days(far), far.horizon, far.fits],
      none: [none.no_time, none.fits, days(none).every((d) => d == null)],
      off: [off.no_time],
      lesson: [days(lesson), lesson.fits],
      hw: [P.homeworkDays(WEEK, '2026-11-02', '2026-11-08'), P.homeworkDays(WEEK.slice(0, 7), '2026-11-14', '2026-11-20')],
      left: [P.timeLeft(WEEK, base), P.timeLeft(WEEK, Object.assign({}, base, { own: [{ minutes: 25, day: '2026-11-05' }, { minutes: 10, day: '2026-11-05', done: true }] })),
        P.timeLeft([], base), P.timeLeft(WEEK, Object.assign({}, base, { due: '2027-03-01' })).horizon],
      work: [P.workLeft(essay), P.workLeft([{ minutes: 20, done: true }, { minutes: 15 }]), P.workLeft([])],
      spare: [P.spare(r1.steps, '2026-11-13'), P.spare([{ kind: 'check', minutes: 20, day: '2026-11-11' }, { kind: 'turn_in', minutes: 5, day: '2026-11-13' }], '2026-11-13'),
        P.spare([{ kind: 'step', minutes: 20 }], '2026-11-13'), P.spare([], '2026-11-13')],
    };
  }, WEEK);
  check('lastWorkDay: the day before the due date; two days before when it is 7 or more days away; a lesson\'s do-by day itself',
    same(placed.last, ['2026-11-07', '2026-11-07', '2026-11-11', '2026-11-13', '2026-11-02']), JSON.stringify(placed.last));
  check('ended / firstDay: today until today\'s homework time is over, then tomorrow', same(placed.ended, [false, true, false, false]) && same(placed.first, ['2026-11-02', '2026-11-03']),
    JSON.stringify([placed.ended, placed.first]));
  check('horizon: the 56th day from today', placed.horizon === '2026-12-27', placed.horizon);
  check('place: in order on the first day with room, the turn-in on the due date, fits (§2.5\'s week, after Thursday\'s 25 planned minutes)',
    same(placed.r1, [['2026-11-02', '2026-11-02', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-04', '2026-11-05', '2026-11-08', '2026-11-13'], true, 0, null, false, 9,
      'Copy the requirements into your notes', null]), JSON.stringify(placed.r1));
  check('place: once today\'s homework time is over, from tomorrow', same(placed.r2, ['2026-11-03', '2026-11-03', '2026-11-04']), JSON.stringify(placed.r2));
  check('place: work that doesn\'t fit goes on the day with the most room left, with fits false and the minutes over',
    same(placed.r3, [['2026-11-02', '2026-11-02', '2026-11-02', '2026-11-03', '2026-11-03', '2026-11-03', '2026-11-03', '2026-11-03', '2026-11-04'], false, 70]), JSON.stringify(placed.r3));
  check('place: a given day is kept when in range, in order and with room; else moved on; nothing in the past; done steps stay',
    same(placed.r4, [['2026-11-05', '2026-11-08', '2026-11-08', '2026-10-29', '2026-11-09', '2026-11-13'], true, 0]), JSON.stringify(placed.r4));
  check('place: a due date past the horizon is planned inside it, and the answer names the horizon', same(placed.far, [['2026-11-02', '2027-02-01'], '2026-12-27', true]), JSON.stringify(placed.far));
  check('place: no homework time at all answers no_time and places nothing', same(placed.none, [true, false, true]) && same(placed.off, [true]), JSON.stringify([placed.none, placed.off]));
  check('place: a lesson works up to its do-by day', same(placed.lesson, [['2026-11-03', '2026-11-03'], false]), JSON.stringify(placed.lesson));
  check('homeworkDays: the days with homework time, and past the week the page has, by its weekdays',
    same(placed.hw, [['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-08'], ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']]), JSON.stringify(placed.hw));
  check('timeLeft: room from the first day to the last work day after other assignments\' steps (its own given back), no_time, the horizon',
    same(placed.left, [{ minutes: 305, horizon: null, no_time: false }, { minutes: 330, horizon: null, no_time: false }, { minutes: 0, horizon: null, no_time: true }, '2026-12-27']),
    JSON.stringify(placed.left));
  check('workLeft: the minutes of steps not done', same(placed.work, [145, 15, 0]), JSON.stringify(placed.work));
  check('spare: whole days between the last work step and the due date; null while a step has no day', same(placed.spare, [4, 1, null, null]), JSON.stringify(placed.spare));
  if (nodePlan) {
    const fromNode = nodePlan.place(nodePlan.starter('essay', { lang: 'en', length: 20 }), { today: '2026-11-02', due: '2026-11-13', kind: 'assignment', asOf: '2026-11-02T16:31', days: WEEK });
    check('place in Node (for mock.js) answers as in the browser', same(fromNode.steps.map((s) => s.day), placed.r1[0]), JSON.stringify(fromNode.steps.map((s) => s.day)));
  }

  // =====================================================================
  // 4. Starter plans (§4.6) and the plan's rules (§4.2)
  // =====================================================================
  const starters = await ev((WEEK) => {
    const P = window.HomePlan;
    const out = { problems: [], counts: {}, kinds: {}, titles: {} };
    for (const lang of ['en', 'es']) {
      for (const key of P.STARTERS) {
        for (const length of P.LENGTHS) {
          const steps = P.starter(key, { lang, length, parts: 3, today: '2026-11-02', due: '2026-11-13', asOf: '2026-11-02T16:31', week: WEEK });
          const problem = P.check(steps, { due: '2026-11-13', today: '2026-11-02' });
          if (problem) out.problems.push(`${lang}/${key}/${length}: ${JSON.stringify(problem)}`);
          steps.forEach((s, i) => {
            if (!s.done_looks_like || !String(s.done_looks_like).trim()) out.problems.push(`${lang}/${key}/${i}: no "done looks like"`);
            if (s.kind === 'turn_in' ? s.minutes !== 5 : s.minutes > length) out.problems.push(`${lang}/${key}/${i}: ${s.minutes} minutes for a length of ${length}`);
            if (s.source !== 'template') out.problems.push(`${lang}/${key}/${i}: source ${s.source}`);
            if (key !== 'practice' && s.day != null) out.problems.push(`${lang}/${key}/${i}: a day`);
            if (!/^\p{Lu}/u.test(s.title) || s.title.trim().split(/\s+/).length < 1) out.problems.push(`${lang}/${key}/${i}: title "${s.title}"`);
          });
          if (length === 20) { out.counts[`${lang}/${key}`] = steps.length; out.kinds[`${lang}/${key}`] = steps.map((s) => s.kind).join(','); }
          if (length === 25) out.titles[`${lang}/${key}`] = steps.map((s) => `${s.title} (${s.minutes}; ${s.done_looks_like})`);
        }
      }
    }
    const practice = P.starter('practice', { lang: 'en', length: 15, today: '2026-11-02', due: '2026-11-06', asOf: '2026-11-02T16:31', week: WEEK });
    const practiceLate = P.starter('practice', { lang: 'en', length: 15, today: '2026-11-02', due: '2026-11-06', asOf: '2026-11-02T17:31', week: WEEK });
    const practiceNone = P.starter('practice', { lang: 'es', length: 20, today: '2026-11-02', due: '2026-11-06', week: [] });
    const reading = [1, 10, 11, 0, null].map((parts) => P.starter('reading', { lang: 'en', length: 20, parts }).length);
    const bad = (steps, o) => { const r = P.check(steps, Object.assign({ due: '2026-11-13', today: '2026-11-02' }, o)); return r && `${r.key}@${r.i}`; };
    const st = (o) => Object.assign({ kind: 'step', title: 'Write the intro', minutes: 20, day: '2026-11-03' }, o);
    const many = Array.from({ length: 21 }, () => st());
    return {
      out, practice: practice.map((s) => [s.day, s.kind, s.minutes, s.title]), practiceLate: practiceLate.map((s) => s.day),
      practiceNone: practiceNone.map((s) => [s.day, s.kind, s.title]), reading,
      guess: [P.guess('Unit 3 test', 'assignment'), P.guess('Vocabulary quiz', 'assignment'), P.guess('Science project: river poster', 'assignment'),
        P.guess('Persuasive essay', 'assignment'), P.guess('Read chapter 4 and answer the questions', 'lesson'), P.guess('Fractions practice', 'lesson'),
        P.guess('Worksheet 5.1', 'assignment'), P.guess('Get ready for the field trip', 'assignment'), P.guess('Examen de la unidad 2', 'assignment'),
        P.guess('Proyecto de ciencias', 'assignment'), P.guess('Lectura: capítulo 3', 'assignment'), P.guess(null, null)],
      rules: [bad(many), bad([st({ kind: 'milestone' }), st({ kind: 'milestone' }), st({ kind: 'milestone' }), st({ kind: 'milestone' }), st({ kind: 'milestone' })]),
        bad([st({ kind: 'turn_in', minutes: 5 }), st({ kind: 'turn_in', minutes: 5 })]), bad([st({ kind: 'turn_in', minutes: 5 }), st()]),
        bad([st(), st({ minutes: 4 })]), bad([st({ minutes: 61 })]), bad([st({ minutes: 12.5 })]), bad([st({ title: 'Go' })]), bad([st({ title: 'x'.repeat(81) })]),
        bad([st({ done_looks_like: 'y'.repeat(161) })]), bad([st({ day: '2026-11-14' })]), bad([st({ day: '2026-11-13' })]),
        bad([st({ day: '2026-11-01' })]), bad([st({ id: 'a', day: '2026-11-01' })], { orig: { a: '2026-11-01' } }), bad([st({ id: 'a' }), st({ id: 'a' })]),
        bad([st({ kind: 'nonsense' })]), bad([st({ done: true, minutes: 2, title: 'x' })]), bad([st({ kind: 'turn_in', minutes: 5, day: '2026-11-13' })]),
        bad([st({ day: null })]), bad([])],
      // The due date as the database has it: a lesson's do-by day is a work day; a step kept on the due date
      // (not moved there) stands; a due date today or past takes steps up to today.
      dueRules: [bad([st({ day: '2026-11-13' })], { kind: 'lesson' }), bad([st({ day: '2026-11-14' })], { kind: 'lesson' }),
        bad([st({ id: 'a', day: '2026-11-13' })], { orig: { a: '2026-11-13' } }), bad([st({ id: 'a', day: '2026-11-13' })], { orig: { a: '2026-11-12' } }),
        bad([st({ day: '2026-11-02' })], { due: '2026-11-02' }), bad([st({ day: '2026-11-02' })], { due: '2026-10-30' }), bad([st({ day: '2026-11-03' })], { due: '2026-10-30' })],
      practiceThu: ((steps) => [steps[steps.length - 1].day, bad(steps, { due: '2026-11-05', kind: 'lesson' }), bad(steps, { due: '2026-11-05', kind: 'assignment' })])(
        P.starter('practice', { lang: 'en', length: 15, today: '2026-11-02', due: '2026-11-05', asOf: '2026-11-02T16:31', week: WEEK })),
      // With the kind: an assignment's blocks end at its last work day (never its due date), a lesson's on its do-by day.
      practiceKind: [['2026-11-05', 'assignment'], ['2026-11-12', 'assignment'], ['2026-11-05', 'lesson']].map(([due, kind]) => ((steps) => [steps.map((x) => x.day).join(' '),
        steps[steps.length - 1].kind, bad(steps, { due, kind })])(P.starter('practice', { lang: 'en', length: 15, today: '2026-11-02', due, kind, asOf: '2026-11-02T16:31', week: WEEK }))),
    };
  }, WEEK);
  check('every starter plan, in both languages and at every length, passes plan_check\'s rules: a "done looks like" on every step, minutes cut to his first length (the turn-in stays 5), source template, no days but Practice\'s',
    !starters.out.problems.length, starters.out.problems.slice(0, 6).join(' | '));
  check('the starter plans\' shapes (§4.6): Essay 9 steps, Test 6, Reading start + parts + check, Practice one block a day, Short 2',
    same(starters.out.kinds, {
      'en/essay': 'start,step,step,milestone,step,step,milestone,check,turn_in', 'en/test': 'start,step,step,milestone,check,turn_in', 'en/reading': 'start,step,step,step,check',
      'en/practice': 'step,step,step,step,step,step,step,step,milestone', 'en/short': 'step,turn_in',
      'es/essay': 'start,step,step,milestone,step,step,milestone,check,turn_in', 'es/test': 'start,step,step,milestone,check,turn_in', 'es/reading': 'start,step,step,step,check',
      'es/practice': 'step,step,step,step,step,step,step,step,milestone', 'es/short': 'step,turn_in' }), JSON.stringify(starters.out.kinds));
  check('Essay or project, in English, as §4.6 lists it', same(starters.out.titles['en/essay'], [
    'Copy the requirements into your notes (10; the requirements in your notes)', 'List what\'s unclear and ask (10; a list of questions, sent)',
    'Gather materials or sources (20; what you\'ll use, saved in one place)', 'Plan it: an outline or a sketch (25; an outline or sketch you can show)',
    'Draft the first half (25; the first half written, rough is fine)', 'Draft the second half (25; the second half written, rough is fine)',
    'Finish a full draft (25; a whole draft, start to end)', 'Check it against the instructions (20; each requirement ticked off)', 'Turn it in (5; handed in)']),
    JSON.stringify(starters.out.titles['en/essay']));
  check('Test, Reading and Short, in English, as §4.6 lists them', same([starters.out.titles['en/test'], starters.out.titles['en/reading'], starters.out.titles['en/short']], [[
    'List what the test covers (10; a list of topics)', 'Make a study list (20; the topics in order, hardest first)', 'Practice the first half of the topics (25; practice questions done and checked)',
    'Practice the second half (25; practice questions done and checked)', 'Quiz yourself (20; a self-quiz with the misses marked)', 'Pack what you need (5; bag packed)'], [
    'Note the pages and the due date (5; pages and date in your notes)', 'Read part 1 (20; that part read)', 'Read part 2 (20; that part read)', 'Read part 3 (20; that part read)',
    'Write 3 things to remember (10; 3 lines in your notes)'], ['Do it (20; done and in your bag)', 'Turn it in (5; handed in)']]),
    JSON.stringify([starters.out.titles['en/test'], starters.out.titles['en/reading'], starters.out.titles['en/short']]));
  check('the Spanish starter plans end with "Entregarlo" (the database\'s word for the turn-in)', starters.out.titles['es/essay'][8] === 'Entregarlo (5; entregado)'
    && starters.out.titles['es/short'][1] === 'Entregarlo (5; entregado)', JSON.stringify(starters.out.titles['es/essay']));
  check('Practice: one block a day on his homework days up to the do-by day, at his first length, the last a milestone',
    same(starters.practice, [['2026-11-02', 'step', 15, 'Do practice session 1'], ['2026-11-03', 'step', 15, 'Do practice session 2'], ['2026-11-04', 'step', 15, 'Do practice session 3'],
      ['2026-11-05', 'milestone', 15, 'Do practice session 4']]) && same(starters.practiceLate, ['2026-11-03', '2026-11-04', '2026-11-05']), JSON.stringify([starters.practice, starters.practiceLate]));
  check('Practice with no homework time known: one milestone block, placed by the database', same(starters.practiceNone, [[null, 'milestone', 'Haz la sesión de práctica 1']]), JSON.stringify(starters.practiceNone));
  check('Reading: one block per part typed, 1 to 10 (2 when none is typed)', same(starters.reading, [3, 12, 12, 4, 4]), JSON.stringify(starters.reading));
  check('guess: the starter plan from the title (test, quiz; essay, project; read; a lesson\'s practice; else Short), in English and Spanish',
    same(starters.guess, ['test', 'test', 'essay', 'essay', 'reading', 'practice', 'short', 'short', 'test', 'essay', 'reading', 'short']), JSON.stringify(starters.guess));
  check('check(): 21 steps, 5 milestones, two turn-ins, a turn-in not last, 4 and 61 and 12.5 minutes, a 2- and an 81-character title, a 161-character "done looks like", a day after the due date, a plain step on it, a new or moved step in the past (a kept past day is fine), one id twice, an unknown kind; done steps as they are; a turn-in on the due date, no day, and no steps are fine',
    same(starters.rules, ['too_many_steps@20', 'too_many_milestones@4', 'one_turn_in@1', 'turn_in_last@0', 'minutes_range@1', 'minutes_range@0', 'minutes_range@0', 'title_len@0', 'title_len@0',
      'dll_len@0', 'after_due@0', 'due_day@0', 'in_past@0', null, 'same_id@1', 'bad_kind@0', null, null, null, null]), JSON.stringify(starters.rules));
  check('check() and the due date, as plan_check and plan_save have it: a lesson\'s plain step on its do-by day is fine (not after it); a step kept on an assignment\'s due date stands, one moved there doesn\'t; due today or past, steps go up to today',
    same(starters.dueRules, [null, 'after_due@0', null, 'due_day@0', null, null, 'after_due@0']), JSON.stringify(starters.dueRules));
  check('Practice for a lesson whose do-by day is a homework day (Thu): its last block on Thu passes check() as a lesson (an assignment due Thu couldn\'t have it)',
    same(starters.practiceThu, ['2026-11-05', null, 'due_day@3']), JSON.stringify(starters.practiceThu));
  check('Practice with the kind: an assignment\'s last block on its last work day (Wed for due Thu; Tue for due Thu next week, two days before), never its due date; a lesson\'s on Thu',
    same(starters.practiceKind, [['2026-11-02 2026-11-03 2026-11-04', 'milestone', null], ['2026-11-02 2026-11-03 2026-11-04 2026-11-05 2026-11-08 2026-11-09 2026-11-10', 'milestone', null],
      ['2026-11-02 2026-11-03 2026-11-04 2026-11-05', 'milestone', null]]), JSON.stringify(starters.practiceKind));

  // =====================================================================
  // 5. The two bars, the week strip, pace and focused minutes
  // =====================================================================
  const drawn = await ev(() => {
    const P = window.HomePlan;
    const box = document.createElement('div');
    document.body.appendChild(box);
    const read = (html) => {
      box.innerHTML = html;
      const fills = Array.from(box.querySelectorAll('.plan-bar-fill')).map((x) => x.style.width);
      return { text: box.textContent.replace(/\s+/g, ' ').trim(), fills, over: !!box.querySelector('.is-over'), bars: box.querySelectorAll('.plan-bar').length };
    };
    const weekText = (html) => { box.innerHTML = html; return Array.from(box.querySelectorAll('.plan-wday')).map((li) => li.textContent.replace(/\s+/g, ' ').trim()); };
    const W = (day, starts, ends, free, planned, busy) => ({ day, window: starts ? { starts, ends } : null, busy: busy || [], free, planned });
    const days = [W('2026-11-02', '16:30', '17:15', 45, 0), W('2026-11-03', '16:30', '17:15', 30, 0, [{ starts: '17:00', ends: '18:00', title: '<b>Piano</b>' }]),
      W('2026-11-04', '16:30', '17:15', 45, 30), W('2026-11-05', '16:30', '17:15', 25, 45), W('2026-11-08', '17:00', '17:45', 45, 0)];
    const out = {
      fits: read(P.bars(100, 195, { lang: 'en' })),
      over: read(P.bars(200, 120, { lang: 'en' })),
      none: read(P.bars(60, 0, { lang: 'en', no_time: true })),
      horizon: read(P.bars(60, 900, { lang: 'es', horizon: '2026-12-27' })),
      zero: read(P.bars(0, 0, { lang: 'en' })),
      weekEn: weekText(P.week(days, { today: '2026-11-02', lang: 'en', titles: true })),
      weekPat: weekText(P.week(days, { today: '2026-11-02', lang: 'en' })),
      weekEs: weekText(P.week(days, { today: '2026-11-02', lang: 'es', count: 3 })),
      busyHtml: (box.innerHTML = P.week(days, { today: '2026-11-02', lang: 'en', titles: true }), box.querySelector('b') === null),
      segs: (box.innerHTML = P.week(days, { today: '2026-11-02', lang: 'en' }), Array.from(box.querySelectorAll('.plan-wday-busy-seg')).map((s) => [s.style.left, s.style.width])),
      pace: [P.pace(1.3, 'en'), P.pace(1.3, 'es'), P.pace(1, 'en'), P.pace(null, 'en')],
      focused: [P.focused({ focused: 100, last_week: 75 }, 'en'), P.focused({ focused: 45, last_week: 0 }, 'es'), P.focused(null, 'en')],
    };
    box.remove();
    return out;
  });
  check('bars: Work left and Homework time left, each to scale against the longer (1 h 40 of 3 h 15)',
    drawn.fits.bars === 2 && same(drawn.fits.fills, ['51.3%', '100%']) && !drawn.fits.over && /Work left.*1 h 40.*Homework time left.*3 h 15/.test(drawn.fits.text)
    && !/Doesn't fit/.test(drawn.fits.text), JSON.stringify(drawn.fits));
  check('bars: longer work than time says "Doesn\'t fit: add homework time, drop a step or talk to the teacher."',
    drawn.over.over && same(drawn.over.fills, ['100%', '60%']) && drawn.over.text.includes("Doesn't fit: add homework time, drop a step or talk to the teacher."), JSON.stringify(drawn.over));
  check('bars: no homework time says so, with no time bar', drawn.none.bars === 1 && drawn.none.text.includes('No homework time set'), JSON.stringify(drawn.none));
  check('bars: "next 8 weeks" when the horizon cuts in, in Spanish', /Trabajo pendiente.*1 h.*Tiempo de tarea que queda.*15 h.*próximas 8 semanas/.test(drawn.horizon.text), drawn.horizon.text);
  check('bars: nothing left draws empty bars and no warning', same(drawn.zero.fills, ['0%', '0%']) && !drawn.zero.over, JSON.stringify(drawn.zero));
  check('week strip: seven days, today first: "45 free", "30 free · Piano 5:00pm", "45 free · 30 planned", "20 min over", "—" without homework time',
    same(drawn.weekEn, ['Mon 45 free', 'Tue 30 free <b>Piano</b> 5:00pm', 'Wed 45 free · 30 planned', 'Thu 20 min over', 'Fri —', 'Sat —', 'Sun 45 free']), JSON.stringify(drawn.weekEn));
  check('week strip on Pat\'s link: "Busy", never a title', same(drawn.weekPat[1], 'Tue 30 free Busy 5:00pm') && !drawn.weekPat.join(' ').includes('Piano'), JSON.stringify(drawn.weekPat));
  check('week strip in Spanish, with count', same(drawn.weekEs, ['lun 45 libres', 'mar 30 libres Ocupado 17:00', 'mié 45 libres · 30 planeados']), JSON.stringify(drawn.weekEs));
  check('week strip: a busy title is drawn as text', drawn.busyHtml);
  check('week strip: the busy block where it falls in the window (5:00 of 4:30–5:15: from 67%, to its end)', same(drawn.segs, [['66.7%', '33.3%']]), JSON.stringify(drawn.segs));
  check('pace: "Steps take about 1.3× the planned time", in Spanish with a decimal comma; nothing without a pace',
    same(drawn.pace, ['Steps take about 1.3× the planned time', 'Los pasos llevan unas 1,3 veces el tiempo previsto', 'Steps take about 1.0× the planned time', '']), JSON.stringify(drawn.pace));
  check('focused: this week against his own last week', same(drawn.focused, ['1 h 40 focused this week (last week 1 h 15)', '45 min de concentración esta semana (la semana pasada 0 min)', '']),
    JSON.stringify(drawn.focused));

  // =====================================================================
  // 5b. The timelines: the overview of open assignments, an assignment's chart, and Jordan's path
  // =====================================================================
  // Monday Nov 2 is today. The essay runs two weeks with two milestones (one earlier step not done, so
  // behind); the poster runs past the 3 weeks; the worksheet is overdue; the reading log comes from Pat's
  // list (counts and next_milestone only, no step days); the lesson has no plan yet; done and dropped ones
  // aren't drawn.
  const tlStep = (id, kind, title, minutes, day, done) => ({ id, kind, title, done_looks_like: null, minutes, day, done: !!done, checked: false });
  const ESSAY = { id: 'A1', kind: 'assignment', title: 'Essay', subject: 'English', due_date: '2026-11-13', status: 'open', state: 'given',
    next_milestone: { title: 'Outline', day: '2026-11-05' },
    steps: [tlStep('s0', 'start', 'Copy the requirements', 10, '2026-10-29', true), tlStep('s1', 'step', "List what's unclear", 10, '2026-10-30'),
      tlStep('s2', 'step', 'Gather sources', 20, '2026-11-02', true), tlStep('s3', 'milestone', 'Outline', 25, '2026-11-05'),
      tlStep('s4', 'step', 'Draft the first half', 25, '2026-11-08'), tlStep('s5', 'step', 'Draft the second half', 25, '2026-11-08'),
      tlStep('s6', 'milestone', 'Full draft', 25, '2026-11-10'), tlStep('s7', 'check', 'Check it against the instructions', 20, '2026-11-11'),
      tlStep('s8', 'turn_in', 'Turn it in', 5, '2026-11-13')] };
  const POSTER = { id: 'A2', kind: 'assignment', title: 'River poster', subject: 'Science', due_date: '2026-11-30', status: 'open', state: 'given',
    steps: [tlStep('p0', 'start', 'Pick the river', 10, '2026-11-09', true), tlStep('p1', 'milestone', 'Sketch', 20, '2026-11-12', true),
      tlStep('p2', 'step', 'Paint it', 25, '2026-11-19'), tlStep('p3', 'milestone', 'Poster painted', 25, '2026-11-25'), tlStep('p4', 'turn_in', 'Turn it in', 5, '2026-11-30')] };
  const WORKSHEET = { id: 'A3', kind: 'assignment', title: 'Worksheet 4.2', subject: 'Math', due_date: '2026-10-30', status: 'open', state: 'given',
    steps: [tlStep('w0', 'step', 'Do it', 20, '2026-10-29'), tlStep('w1', 'turn_in', 'Turn it in', 5, '2026-10-30')] };
  const READING = { id: 'A4', kind: 'assignment', title: 'Reading log', subject: 'English', due_date: '2026-11-06', status: 'open', state: 'given',
    steps: 4, steps_done: 1, next_milestone: { title: 'Half the book', day: '2026-11-04' } };
  const LESSON = { id: 'A5', kind: 'lesson', title: 'Fractions practice', subject: 'Math', due_date: '2026-11-06', status: 'open', state: 'none', steps: [] };
  const DONE = { id: 'A6', kind: 'assignment', title: 'Done one', subject: 'Math', due_date: '2026-11-04', status: 'done', steps: [] };
  const DROPPED = { id: 'A7', kind: 'assignment', title: 'Dropped one', subject: 'Math', due_date: '2026-11-04', status: 'dropped', steps: [] };
  const TL = { ESSAY, POSTER, WORKSHEET, READING, LESSON, DONE, DROPPED, HOSTILE, WEEK, today: '2026-11-02' };
  const tl = await ev((TL) => {
    const P = window.HomePlan;
    if (typeof P.overview !== 'function' || typeof P.chart !== 'function' || typeof P.path !== 'function') return { missing: true };
    const { ESSAY, POSTER, WORKSHEET, READING, LESSON, DONE, DROPPED, HOSTILE, WEEK, today } = TL;
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const box = document.createElement('div');
    document.body.appendChild(box);
    const txt = (el, sel) => { const x = sel ? el.querySelector(sel) : el; return x ? x.textContent.replace(/\s+/g, ' ').trim() : null; };
    const col = (el) => (el ? el.style.gridColumn || null : null);
    const head = () => Array.from(box.querySelectorAll('.plan-tl-hday')).map((d) => ({
      l: txt(d, '.plan-tl-letter'), d: txt(d, '.plan-tl-date'), m: txt(d, '.plan-tl-month'),
      today: d.classList.contains('is-today'), mon: d.classList.contains('is-mon'), off: d.classList.contains('is-off'), due: d.classList.contains('is-due') }));
    const idx = (h, k) => h.map((x, i) => (x[k] ? i : -1)).filter((i) => i >= 0);
    const readOverview = (html) => {
      box.innerHTML = html;
      const root = box.firstElementChild;
      if (!root) return null;
      const h = head();
      return {
        root: root.className, group: root.getAttribute('role'), label: root.getAttribute('aria-label'),
        letters: h.map((x) => x.l).join(''), dates: h.map((x) => Number(x.d)), months: h.map((x) => x.m || ''), today: idx(h, 'today'), mon: idx(h, 'mon'),
        rows: Array.from(box.querySelectorAll('.plan-tl-row')).map((r) => {
          const a = r.querySelector('a.plan-tl-name');
          return {
            id: r.dataset.id, late: r.classList.contains('is-late'), href: a ? a.getAttribute('href') : null,
            title: txt(r, '.plan-tl-title'), sub: txt(r, '.plan-tl-sub'), sr: txt(r, '.sr-only'),
            bar: col(r.querySelector('.plan-tl-bar')), fill: r.querySelector('.plan-tl-fill') ? r.querySelector('.plan-tl-fill').style.width : null,
            ms: Array.from(r.querySelectorAll('.plan-tl-ms')).map((m) => [col(m), m.classList.contains('is-done'), m.classList.contains('is-behind')]),
            due: col(r.querySelector('.plan-tl-due')), arrow: !!r.querySelector('.plan-tl-arrow'),
            todayCell: col(r.querySelector('.plan-tl-cell.is-today')),
          };
        }),
        img: !!box.querySelector('img'), hidden: Array.from(box.querySelectorAll('.plan-tl-track')).every((x) => x.getAttribute('aria-hidden') === 'true'),
      };
    };
    const readChart = (html) => {
      box.innerHTML = html;
      const root = box.firstElementChild;
      if (!root) return null;
      const h = head();
      return {
        root: root.className, label: root.getAttribute('aria-label'), count: h.length,
        letters: h.map((x) => x.l).join(''), dates: h.map((x) => Number(x.d)), today: idx(h, 'today'), mon: idx(h, 'mon'), off: idx(h, 'off'), due: idx(h, 'due'),
        rows: Array.from(box.querySelectorAll('.plan-tl-row')).map((r) => ({
          title: txt(r, '.plan-tl-title'), sub: txt(r, '.plan-tl-sub'), done: !!r.querySelector('.plan-tl-title .is-done'),
          todayCell: col(r.querySelector('.plan-tl-cell.is-today')),
          off: Array.from(r.querySelectorAll('.plan-tl-cell.is-off')).map(col),
          steps: Array.from(r.querySelectorAll('.plan-tl-step')).map((s) => [col(s.closest('.plan-tl-slot')), txt(s, '.plan-tl-min'),
            (/\bk-(\w+)/.exec(s.className) || [])[1], s.classList.contains('is-done'), s.classList.contains('is-behind'), txt(s, '.sr-only')]),
        })),
        tips: Array.from(box.querySelectorAll('.plan-tl-step')).map((s) => s.getAttribute('title')),
        arrow: !!box.querySelector('.plan-tl-arrow'), foot: txt(box, '.plan-tl-foot'), img: !!box.querySelector('img'),
      };
    };
    const readPath = (html) => {
      box.innerHTML = html;
      const root = box.firstElementChild;
      if (!root) return null;
      const days = Array.from(box.querySelectorAll('.plan-path-day'));
      return {
        line: txt(box, '.plan-path-line'), names: days.map((d) => txt(d, '.plan-path-name')),
        today: idx(days.map((d) => ({ x: d.classList.contains('is-today') })), 'x'), due: idx(days.map((d) => ({ x: d.classList.contains('is-due') })), 'x'),
        flags: days.map((d, i) => (d.querySelector('.plan-path-flag') ? i : -1)).filter((i) => i >= 0),
        flagsDone: days.map((d, i) => (d.querySelector('.plan-path-flag.is-done') ? i : -1)).filter((i) => i >= 0),
        earlier: days.map((d, i) => (d.querySelector('.plan-path-flag.is-earlier') ? i : -1)).filter((i) => i >= 0),
        work: days.map((d, i) => (d.classList.contains('has-work') ? i : -1)).filter((i) => i >= 0),
        fold: txt(box, '.plan-path-fold'), won: box.querySelectorAll('.plan-path-won .plan-path-flag').length, sr: txt(box, '.sr-only'),
        hidden: (box.querySelector('.plan-path-days') || {}).getAttribute ? box.querySelector('.plan-path-days').getAttribute('aria-hidden') : null,
        img: !!box.querySelector('img'),
      };
    };
    const link = (id) => (id === 'A4' ? null : `#/homework/${id}`);
    const all = [ESSAY, POSTER, WORKSHEET, READING, LESSON, DONE, DROPPED];
    const ms = (steps, day, extra) => steps.filter((s) => s.id !== 's6').map((s) => (s.id === 's3' ? Object.assign({}, s, { day }, extra || {}) : s));
    const kid = (steps, more) => Object.assign(clone(ESSAY), { steps }, more || {});
    const hostile = { id: 'A8', kind: 'assignment', title: HOSTILE, subject: HOSTILE, due_date: '2026-11-06', status: 'open', state: 'given',
      steps: [tlStep('h0', 'step', HOSTILE, 20, '2026-11-03'), tlStep('h1', 'milestone', HOSTILE, 20, '2026-11-04'), tlStep('h2', 'turn_in', 'Turn it in', 5, '2026-11-06')] };
    function tlStep(id, kind, title, minutes, day, done) { return { id, kind, title, done_looks_like: null, minutes, day, done: !!done, checked: false }; }
    const clock = { id: 'C1', kind: 'assignment', title: 'Clock', subject: 'Math', due_date: '2026-11-03', status: 'open', state: 'given',
      steps: [tlStep('c1', 'step', 'Before the change', 10, '2026-10-31'), tlStep('c2', 'milestone', 'On the change', 10, '2026-11-01'), tlStep('c3', 'turn_in', 'Turn it in', 5, '2026-11-03')] };
    const long = { id: 'L1', kind: 'assignment', title: 'Long project', subject: 'Science', due_date: '2027-02-26', status: 'open', state: 'given',
      steps: [tlStep('l1', 'step', 'Begin', 20, '2026-11-02'), tlStep('l2', 'milestone', 'Half', 20, '2026-12-20'), tlStep('l3', 'turn_in', 'Turn it in', 5, '2027-02-26')] };
    const out = {
      ov: readOverview(P.overview(all, { today, lang: 'en', link })),
      ovDefault: readOverview(P.overview([ESSAY], { today, lang: 'en' })),
      ovEs: readOverview(P.overview([ESSAY, WORKSHEET], { today, lang: 'es', link })),
      ovNone: [P.overview([], { today, lang: 'en' }), P.overview([DONE, DROPPED], { today, lang: 'en' }), P.overview(null, { today })],
      ovHostile: readOverview(P.overview([hostile], { today, lang: 'en', link })),
      ovClock: readOverview(P.overview([clock], { today: '2026-10-30', days: 7, lang: 'en' })),
      chart: readChart(P.chart(ESSAY, { today, lang: 'en', week: WEEK })),
      chartNoWeek: readChart(P.chart(ESSAY, { today, lang: 'en' })),
      chartEs: readChart(P.chart(ESSAY, { today, lang: 'es', week: WEEK })),
      chartShort: readChart(P.chart({ id: 'Q', kind: 'assignment', title: 'Short', due_date: '2026-11-04', status: 'open',
        steps: [tlStep('q1', 'step', 'Do it', 20, '2026-11-03'), tlStep('q2', 'turn_in', 'Turn it in', 5, '2026-11-04')] }, { today, lang: 'en' })),
      chartPractice: readChart(P.chart({ id: 'R', kind: 'lesson', title: 'Practice', due_date: '2026-11-04', status: 'open',
        steps: [tlStep('r1', 'step', 'Practice 1', 20, '2026-11-02', true), tlStep('r2', 'step', 'Practice 2', 20, '2026-11-03'), tlStep('r3', 'milestone', 'Practice 3', 20, '2026-11-04', true)] }, { today, lang: 'en' })),
      chartNot: [
        P.chart({ id: 'Q', due_date: '2026-11-04', status: 'open', steps: [tlStep('q1', 'step', 'Quick one', 15, '2026-11-02')] }, { today }),
        P.chart({ id: 'Q', due_date: '2026-11-04', status: 'open', steps: [tlStep('q1', 'step', 'Do it', 15, null), tlStep('q2', 'turn_in', 'Turn it in', 5, null)] }, { today }),
        P.chart({ id: 'Q', due_date: '2026-11-04', status: 'open', steps: [] }, { today }), P.chart(null, { today }),
      ],
      chartHostile: readChart(P.chart(hostile, { today, lang: 'en' })),
      chartClock: readChart(P.chart(clock, { today: '2026-10-30', lang: 'en' })),
      chartLong: readChart(P.chart(long, { today, lang: 'en' })),
      path: readPath(P.path(ESSAY, { today, lang: 'en', points: 20 })),
      pathNoPoints: readPath(P.path(ESSAY, { today, lang: 'en' })),
      pathZero: readPath(P.path(ESSAY, { today, lang: 'en', points: 0 })),
      pathWhen: [ms(ESSAY.steps, '2026-11-02'), ms(ESSAY.steps, '2026-11-03'), ms(ESSAY.steps, '2026-11-11')]
        .map((steps) => readPath(P.path(kid(steps), { today, lang: 'en' })).line),
      pathEarlier: readPath(P.path(kid(ms(ESSAY.steps, '2026-10-30')), { today, lang: 'en', points: 20 })),
      pathAll: readPath(P.path(kid(ESSAY.steps.map((s) => (s.kind === 'milestone' ? Object.assign({}, s, { done: true }) : s))), { today, lang: 'en', points: 20 })),
      pathWon: readPath(P.path(kid(ms(ESSAY.steps, '2026-10-30', { done: true })), { today, lang: 'en' })),
      pathNoMs: readPath(P.path(kid([tlStep('n1', 'step', 'Read', 20, '2026-11-03'), tlStep('n2', 'step', 'Read more', 20, '2026-11-05'), tlStep('n3', 'turn_in', 'Turn it in', 5, '2026-11-09')],
        { due_date: '2026-11-09' }), { today, lang: 'en' })),
      pathSoon: readPath(P.path(kid([tlStep('n1', 'step', 'Read', 20, '2026-11-03'), tlStep('n3', 'turn_in', 'Turn it in', 5, '2026-11-06')], { due_date: '2026-11-06' }), { today, lang: 'en' })),
      pathFold: readPath(P.path(kid([tlStep('f1', 'step', 'Sketch', 20, '2026-11-03'), tlStep('f2', 'milestone', 'Paint done', 25, '2026-11-20'), tlStep('f3', 'turn_in', 'Turn it in', 5, '2026-11-27')],
        { due_date: '2026-11-27' }), { today, lang: 'en' })),
      path14: readPath(P.path(kid([tlStep('f1', 'step', 'Sketch', 20, '2026-11-03'), tlStep('f3', 'turn_in', 'Turn it in', 5, '2026-11-15')], { due_date: '2026-11-15' }), { today, lang: 'en' })),
      pathNot: [P.path(kid([]), { today, lang: 'en' }), P.path(Object.assign(clone(ESSAY), { status: 'done' }), { today, lang: 'en' }),
        P.path(Object.assign(clone(ESSAY), { due_date: '2026-11-01' }), { today, lang: 'en' }), P.path(null, { today })],
      pathHostile: readPath(P.path(hostile, { today, lang: 'en', points: 20 })),
      pathEs: readPath(P.path(ESSAY, { today, lang: 'es', points: 20 })),
      pathEsMore: [readPath(P.path(kid(ms(ESSAY.steps, '2026-11-03')), { today, lang: 'es' })).line, readPath(P.path(kid(ms(ESSAY.steps, '2026-10-30')), { today, lang: 'es' })).line,
        readPath(P.path(kid(ms(ESSAY.steps, '2026-11-11')), { today, lang: 'es' })).line,
        readPath(P.path(kid(ESSAY.steps.map((s) => (s.kind === 'milestone' ? Object.assign({}, s, { done: true }) : s))), { today, lang: 'es' })).line,
        readPath(P.path(kid([tlStep('f1', 'step', 'Sketch', 20, '2026-11-03'), tlStep('f3', 'turn_in', 'Turn it in', 5, '2026-11-27')], { due_date: '2026-11-27' }), { today, lang: 'es' })).fold],
      pathClock: readPath(P.path(kid([tlStep('c2', 'milestone', 'On Monday', 10, '2026-11-02'), tlStep('c3', 'turn_in', 'Turn it in', 5, '2026-11-04')], { due_date: '2026-11-04' }),
        { today: '2026-10-31', lang: 'en' })),
    };
    box.remove();
    return out;
  }, TL);
  if (tl.missing) check('overview, chart and path are drawn by plan.js', false, 'HomePlan.overview, chart or path is missing');
  else {
    const ov = tl.ov;
    const row = (id) => ov.rows.find((r) => r.id === id) || {};
    check('overview: one row per open assignment, by due date (done and dropped left out)', same(ov.rows.map((r) => r.id), ['A3', 'A4', 'A5', 'A1', 'A2']), JSON.stringify(ov.rows.map((r) => r.id)));
    check('overview: a header of 21 days from today, weekday letter and date, today marked, each week from its Monday, the month on the first day',
      ov.letters === 'MTWTFSSMTWTFSSMTWTFSS' && same(ov.dates, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) && same(ov.today, [0])
      && same(ov.mon, [0, 7, 14]) && ov.months[0] === 'Nov' && ov.months.slice(1).every((m) => !m), JSON.stringify([ov.letters, ov.dates, ov.today, ov.mon, ov.months]));
    check('overview: o.days defaults to 21', tl.ovDefault.dates.length === 21, tl.ovDefault.dates.length);
    check('overview: a group with its label; each track is hidden from screen readers (the row\'s label says it all)',
      ov.group === 'group' && ov.label === 'Open assignments, Mon Nov 2 to Sun Nov 22' && ov.hidden && /plan-tl-overview/.test(ov.root), JSON.stringify([ov.group, ov.label, ov.hidden, ov.root]));
    check('overview: a bar from the first step day, clipped to today when that is earlier, to the due date, with the done share filled (2 of 9)',
      row('A1').bar === '1 / 13' && row('A1').fill === '22.2%' && row('A1').due === '12' && !row('A1').arrow && !row('A1').late, JSON.stringify(row('A1')));
    check('overview: milestones as diamonds on their known days, not done (Outline Thu, Full draft Tue)',
      same(row('A1').ms, [['4', false, false], ['9', false, false]]), JSON.stringify(row('A1').ms));
    check('overview: the row\'s label for screen readers ("Essay · steps from Mon Nov 2 · milestone … · due Fri Nov 13 · 2 of 9 steps done")',
      row('A1').sr === 'Essay · steps from Mon Nov 2 · milestone Outline Thu Nov 5 · milestone Full draft Tue Nov 10 · due Fri Nov 13 · 2 of 9 steps done', row('A1').sr);
    check('overview: the visible name and its line (class · n of m · due day)', row('A1').title === 'Essay' && row('A1').sub === 'English · 2 of 9 · due Fri Nov 13', JSON.stringify(row('A1')));
    check('overview: a plan starting later starts its bar there; a due date past the 3 weeks runs to the edge with an arrow and "due <day>"; a done milestone filled, one past the range left out',
      row('A2').bar === '8 / 22' && row('A2').arrow && !row('A2').due && same(row('A2').ms, [['11', true, false]]) && row('A2').fill === '40%'
      && /due Mon Nov 30/.test(row('A2').sub) && row('A2').sr === 'River poster · steps from Mon Nov 9 · milestone Sketch done · milestone Poster painted Wed Nov 25 · due Mon Nov 30 · 2 of 5 steps done',
      JSON.stringify(row('A2')));
    check('overview: an overdue open one is marked late, its bar on today only',
      row('A3').late && row('A3').bar === '1 / 2' && row('A3').fill === '0%' && /late/.test(row('A3').sub) && row('A3').sr === 'Worksheet 4.2 · late · due Fri Oct 30 · 0 of 2 steps done',
      JSON.stringify(row('A3')));
    check('overview: Pat\'s list (counts, no step days): a bar from today, the share from steps_done, only next_milestone',
      row('A4').bar === '1 / 6' && row('A4').fill === '25%' && same(row('A4').ms, [['3', false, false]]) && row('A4').due === '5'
      && row('A4').sr === 'Reading log · milestone Half the book Wed Nov 4 · due Fri Nov 6 · 1 of 4 steps done', JSON.stringify(row('A4')));
    check('overview: no plan yet: a bar from today to the do-by day, nothing filled, "no plan yet"',
      row('A5').bar === '1 / 6' && row('A5').fill === null && !row('A5').ms.length && row('A5').sr === 'Fractions practice · no plan yet · do by Fri Nov 6', JSON.stringify(row('A5')));
    check('overview: each row links to the assignment when o.link gives an href (and not when it gives none)',
      same(ov.rows.map((r) => r.href), ['#/homework/A3', null, '#/homework/A5', '#/homework/A1', '#/homework/A2']), JSON.stringify(ov.rows.map((r) => r.href)));
    check('overview: today\'s column marked on every row', ov.rows.every((r) => r.todayCell === '1'), JSON.stringify(ov.rows.map((r) => r.todayCell)));
    check('overview: nothing drawn (an empty string) with no open assignment', same(tl.ovNone, ['', '', '']), JSON.stringify(tl.ovNone));
    check('overview: a hostile title and class are drawn as text', !tl.ovHostile.img && tl.ovHostile.rows[0].title === HOSTILE && tl.ovHostile.rows[0].sr.startsWith(`${HOSTILE} · steps from Tue Nov 3`)
      && tl.ovHostile.rows[0].sub.startsWith(HOSTILE), JSON.stringify(tl.ovHostile.rows[0]));
    check('overview in Spanish: L M X J V S D, "pasos desde el lun 2 nov", "hito … el jue 5 nov", "para el vie 13 nov", "con retraso"',
      tl.ovEs.letters === 'LMXJVSDLMXJVSDLMXJVSD' && tl.ovEs.rows[1].sr === 'Essay · pasos desde el lun 2 nov · hito Outline el jue 5 nov · hito Full draft el mar 10 nov · para el vie 13 nov · 2 de 9 pasos hechos'
      && tl.ovEs.rows[0].sr === 'Worksheet 4.2 · con retraso · para el vie 30 oct · 0 de 2 pasos hechos' && tl.ovEs.label === 'Trabajos abiertos, del lun 2 nov al dom 22 nov',
      JSON.stringify([tl.ovEs.letters, tl.ovEs.rows.map((r) => r.sr), tl.ovEs.label]));
    check('overview across the Nov 1 clock change: whole days (Fri Oct 30 + 7 days: Oct, Nov on the 1st, Monday the 2nd starts a week)',
      tl.ovClock.letters === 'FSSMTWT' && same(tl.ovClock.dates, [30, 31, 1, 2, 3, 4, 5]) && same(tl.ovClock.mon, [3]) && same(tl.ovClock.months, ['Oct', '', 'Nov', '', '', '', ''])
      && tl.ovClock.rows[0].bar === '2 / 6' && same(tl.ovClock.rows[0].ms, [['3', false, false]]) && tl.ovClock.rows[0].due === '5', JSON.stringify(tl.ovClock));

    const ch = tl.chart;
    check('chart: days from the first step\'s day to the due date (Thu Oct 29 to Fri Nov 13), today marked, weeks from Monday, the due day flagged',
      ch.count === 16 && ch.letters === 'TFSSMTWTFSSMTWTF' && same(ch.dates, [29, 30, 31, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) && same(ch.today, [4]) && same(ch.mon, [4, 11])
      && same(ch.due, [15]) && ch.label === 'Plan by day, Thu Oct 29 to Fri Nov 13' && /plan-tl-chart/.test(ch.root), JSON.stringify([ch.count, ch.letters, ch.dates, ch.today, ch.mon, ch.due, ch.label]));
    check('chart: rows are phases, each the steps up to and including a milestone, then the check and turn-in',
      same(ch.rows.map((r) => [r.title, r.sub]), [['Outline', '4 steps · 1 h 05'], ['Full draft', '3 steps · 1 h 15'], ['Check and turn in', '2 steps · 25 min']]),
      JSON.stringify(ch.rows.map((r) => [r.title, r.sub])));
    check('chart: each step a block on its day with its minutes; done filled; an earlier one not done marked behind ("from earlier"); two on one day stacked',
      same(ch.rows[0].steps.map((s) => s.slice(0, 5)), [['1', '10', 'start', true, false], ['2', '10', 'step', false, true], ['5', '20', 'step', true, false], ['8', '25', 'milestone', false, false]])
      && same(ch.rows[1].steps.map((s) => s.slice(0, 5)), [['11', '25', 'step', false, false], ['11', '25', 'step', false, false], ['13', '25', 'milestone', false, false]])
      && same(ch.rows[2].steps.map((s) => s.slice(0, 5)), [['14', '20', 'check', false, false], ['16', '5', 'turn_in', false, false]]),
      JSON.stringify(ch.rows.map((r) => r.steps.map((s) => s.slice(0, 5)))));
    check('chart: each block says itself to screen readers (title · kind · day · minutes · done / from earlier)',
      same([ch.rows[0].steps[0][5], ch.rows[0].steps[1][5], ch.rows[0].steps[3][5], ch.rows[2].steps[1][5]],
        ['Copy the requirements · start · Thu Oct 29 · 10 min · done', "List what's unclear · Fri Oct 30 · 10 min · from earlier", 'Outline · milestone · Thu Nov 5 · 25 min',
          'Turn it in · turn in · Fri Nov 13 · 5 min']), JSON.stringify(ch.rows.map((r) => r.steps.map((s) => s[5]))));
    check('chart: today\'s line on every row', ch.rows.every((r) => r.todayCell === '5'), JSON.stringify(ch.rows.map((r) => r.todayCell)));
    check('chart: days without homework time shaded where the page knows the week (Fri, Sat; Fri the 13th), on the header and every row',
      same(ch.off, [1, 2, 8, 9, 15]) && ch.rows.every((r) => same(r.off, ['2', '3', '9', '10', '16'])), JSON.stringify([ch.off, ch.rows.map((r) => r.off)]));
    check('chart: nothing shaded without the week', same(tl.chartNoWeek.off, []) && tl.chartNoWeek.rows.every((r) => !r.off.length), JSON.stringify(tl.chartNoWeek.off));
    check('chart: a plan without milestones is one row ("The plan"), from today', same(tl.chartShort.rows.map((r) => r.title), ['The plan']) && same(tl.chartShort.dates, [2, 3, 4])
      && same(tl.chartShort.today, [0]), JSON.stringify(tl.chartShort));
    check('chart: a plan that ends on its milestone has no last row; a done milestone\'s diamond filled',
      same(tl.chartPractice.rows.map((r) => r.title), ['Practice 3']) && tl.chartPractice.rows[0].done, JSON.stringify(tl.chartPractice.rows));
    check('chart: not drawn for a plan on fewer than 2 distinct days, without days, or without steps', same(tl.chartNot, ['', '', '', '']), JSON.stringify(tl.chartNot));
    check('chart: a hostile step title is drawn as text (the tip and the block)', !tl.chartHostile.img && tl.chartHostile.tips[0] === `${HOSTILE} · 20 min`
      && tl.chartHostile.rows[0].title === HOSTILE, JSON.stringify(tl.chartHostile.tips));
    check('chart in Spanish: "Revisar y entregar", "pasos", "de antes", "hecho", L M X J V S D',
      tl.chartEs.rows[2].title === 'Revisar y entregar' && tl.chartEs.rows[2].sub === '2 pasos · 25 min' && tl.chartEs.letters === 'JVSDLMXJVSDLMXJV'
      && tl.chartEs.rows[0].steps[1][5] === "List what's unclear · vie 30 oct · 10 min · de antes" && tl.chartEs.rows[0].steps[0][5] === 'Copy the requirements · inicio · jue 29 oct · 10 min · hecho'
      && tl.chartEs.label === 'Plan por días, del jue 29 oct al vie 13 nov', JSON.stringify([tl.chartEs.rows.map((r) => [r.title, r.sub]), tl.chartEs.rows[0].steps.map((s) => s[5]), tl.chartEs.label]));
    check('chart across the Nov 1 clock change: one column a day (Fri Oct 30 to Tue Nov 3)',
      same(tl.chartClock.dates, [30, 31, 1, 2, 3]) && same(tl.chartClock.rows.map((r) => r.steps.map((s) => s[0])), [['2', '3'], ['5']]) && same(tl.chartClock.mon, [3]),
      JSON.stringify(tl.chartClock));
    check('chart: at most 63 days; a due date past them is an arrow and "due <day>"', tl.chartLong.count === 63 && tl.chartLong.arrow && tl.chartLong.foot === 'due Fri Feb 26 →',
      JSON.stringify([tl.chartLong.count, tl.chartLong.arrow, tl.chartLong.foot]));

    const pa = tl.path;
    check('path: one line on top, the next flag, its day in plain words and the points at his tick ("Next flag: Outline · Thu (3 days) · +20 points now")',
      pa.line === 'Next flag: Outline · Thu (3 days) · +20 points now', pa.line);
    check('path: no points when his view gives none (or 0)', tl.pathNoPoints.line === 'Next flag: Outline · Thu (3 days)' && tl.pathZero.line === 'Next flag: Outline · Thu (3 days)',
      JSON.stringify([tl.pathNoPoints.line, tl.pathZero.line]));
    check('path: a dot a day from today to the due date, "Today" first, flags on the milestones\' days, the due date at the end, days with work marked',
      same(pa.names, ['Today', 'T', 'W', 'T', 'F', 'S', 'S', 'M', 'T', 'W', 'T', 'F']) && same(pa.today, [0]) && same(pa.flags, [3, 8]) && same(pa.flagsDone, [])
      && same(pa.due, [11]) && same(pa.work, [3, 6, 8, 9, 11]) && pa.fold === null && pa.won === 0 && pa.hidden === 'true',
      JSON.stringify(pa));
    check('path: said to screen readers in one line', pa.sr === 'From today to Fri Nov 13 · flag Outline Thu Nov 5 · flag Full draft Tue Nov 10', pa.sr);
    check('path: the next flag today, tomorrow, in 9 days', same(tl.pathWhen, ['Next flag: Outline · today', 'Next flag: Outline · tomorrow', 'Next flag: Outline · in 9 days']),
      JSON.stringify(tl.pathWhen));
    check('path: a flag not done whose day has passed is today\'s, "from Fri"', tl.pathEarlier.line === 'Next flag: Outline · from Fri · +20 points now'
      && same(tl.pathEarlier.earlier, [0]) && same(tl.pathEarlier.flags, [0]), JSON.stringify(tl.pathEarlier));
    check('path: every flag done: a short cheer and the due date; done flags filled', tl.pathAll.line === 'Every flag done! Due Fri Nov 13 (11 days)'
      && same(tl.pathAll.flagsDone, [3, 8]), JSON.stringify(tl.pathAll));
    check('path: flags already won before today counted at the start', tl.pathWon.won === 1 && /1 flag done/.test(tl.pathWon.sr) && tl.pathWon.line === 'Every flag done! Due Fri Nov 13 (11 days)',
      JSON.stringify(tl.pathWon));
    check('path: a plan without milestones says when it is due ("Due Mon Nov 9 (7 days)", "Due Fri (4 days)")',
      tl.pathNoMs.line === 'Due Mon Nov 9 (7 days)' && !tl.pathNoMs.flags.length && tl.pathSoon.line === 'Due Fri (4 days)', JSON.stringify([tl.pathNoMs.line, tl.pathSoon.line]));
    check('path: at most 14 dots, the rest folded into "… due <day>" (and a flag past them only in the line)',
      tl.pathFold.names.length === 14 && tl.pathFold.fold === '… due Fri Nov 27' && !tl.pathFold.flags.length && same(tl.pathFold.due, [])
      && tl.pathFold.line === 'Next flag: Paint done · in 18 days', JSON.stringify(tl.pathFold));
    check('path: exactly 14 days is 14 dots, the due date last, nothing folded', tl.path14.names.length === 14 && same(tl.path14.due, [13]) && tl.path14.fold === null, JSON.stringify(tl.path14));
    check('path: nothing drawn without a plan, once done, past its due date (his screen never says late) or without an assignment', same(tl.pathNot, ['', '', '', '']), JSON.stringify(tl.pathNot));
    check('path: a hostile title is drawn as text', !tl.pathHostile.img && tl.pathHostile.line === `Next flag: ${HOSTILE} · Wed (2 days) · +20 points now`, tl.pathHostile.line);
    check('path in Spanish: "Siguiente bandera", "el jue (3 días)", "+20 puntos ahora", "Hoy"',
      tl.pathEs.line === 'Siguiente bandera: Outline · el jue (3 días) · +20 puntos ahora' && same(tl.pathEs.names, ['Hoy', 'M', 'X', 'J', 'V', 'S', 'D', 'L', 'M', 'X', 'J', 'V'])
      && tl.pathEs.sr === 'De hoy al vie 13 nov · bandera Outline el jue 5 nov · bandera Full draft el mar 10 nov', JSON.stringify([tl.pathEs.line, tl.pathEs.names, tl.pathEs.sr]));
    check('path in Spanish: mañana, "del vie", "en 9 días", the cheer, the fold',
      same(tl.pathEsMore, ['Siguiente bandera: Outline · mañana', 'Siguiente bandera: Outline · del vie', 'Siguiente bandera: Outline · en 9 días',
        '¡Todas las banderas hechas! Se entrega el vie 13 nov (11 días)', '… para el vie 27 nov']), JSON.stringify(tl.pathEsMore));
    check('path across the Nov 1 clock change: Sat Oct 31 to Wed Nov 4, a dot a day, "Mon (2 days)"',
      same(tl.pathClock.names, ['Today', 'S', 'M', 'T', 'W']) && same(tl.pathClock.flags, [2]) && same(tl.pathClock.due, [4]) && tl.pathClock.line === 'Next flag: On Monday · Mon (2 days)',
      JSON.stringify(tl.pathClock));
  }

  // The three drawn on a page: at 390px nothing scrolls the page sideways (the chart may scroll in its own box,
  // the overview and the path fit); at 1280px the overview's names sit beside their bars. Light and dark.
  const TL_SHOTS = '/tmp/claude-0/-home-user/0c72d120-ee3f-5c98-8b8c-29d68f9daf64/scratchpad/timeline-shots/';
  fs.mkdirSync(TL_SHOTS, { recursive: true });
  const drawTimelines = (lang) => ev(({ TL, lang }) => {
    const P = window.HomePlan;
    if (typeof P.overview !== 'function') return false;
    const { ESSAY, POSTER, WORKSHEET, READING, LESSON, WEEK, today } = TL;
    document.getElementById('app').innerHTML = `<section class="tl-demo"><h2>${P.esc(P.t('tl_next_weeks', { n: 3 }, lang))}</h2>`
      + `${P.overview([ESSAY, POSTER, WORKSHEET, READING, LESSON], { today, lang, link: (id) => `#a/${id}` })}</section>`
      + `<section class="tl-demo"><h2>${P.esc(ESSAY.title)}</h2>${P.chart(ESSAY, { today, lang, week: WEEK })}</section>`
      + `<section class="tl-demo"><h2>My day</h2>${P.path(ESSAY, { today, lang, points: 20 })}${P.path(POSTER, { today, lang })}</section>`;
    return true;
  }, { TL, lang });
  const layout = () => ev(() => {
    const r = (sel) => { const x = document.querySelector(sel); return x ? x.getBoundingClientRect() : null; };
    const ovScroll = document.querySelector('.plan-tl-overview .plan-tl-scroll');
    const path = document.querySelector('.plan-path');
    const name = r('.plan-tl-overview .plan-tl-row .plan-tl-name');
    const track = r('.plan-tl-overview .plan-tl-row .plan-tl-track');
    return { page: document.documentElement.scrollWidth, width: window.innerWidth, ovFits: ovScroll ? ovScroll.scrollWidth <= ovScroll.clientWidth + 1 : false,
      pathFits: path ? path.scrollWidth <= path.clientWidth + 1 : false, side: name && track ? name.right <= track.left + 1 && Math.abs(name.top - track.top) < 40 : null,
      stacked: name && track ? name.bottom <= track.top + 1 : null };
  });
  if (await drawTimelines('en')) {
    await page.setViewportSize({ width: 390, height: 844 });
    let lay = await layout();
    check('timelines at 390px: nothing scrolls the page sideways; the overview and the path fit; each name over its bar',
      lay.page <= 390 && lay.ovFits && lay.pathFits && lay.stacked, JSON.stringify(lay));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: `${TL_SHOTS}plan-timelines-390-light.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: `${TL_SHOTS}plan-timelines-390-dark.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    lay = await layout();
    check('timelines at 1280px: nothing scrolls the page sideways; the overview\'s names beside their bars', lay.page <= 1280 && lay.ovFits && lay.pathFits && lay.side, JSON.stringify(lay));
    await page.screenshot({ path: `${TL_SHOTS}plan-timelines-1280-dark.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: `${TL_SHOTS}plan-timelines-1280-light.png`, fullPage: true });
    await drawTimelines('es');
    await page.setViewportSize({ width: 390, height: 844 });
    lay = await layout();
    check('timelines in Spanish at 390px: nothing scrolls the page sideways', lay.page <= 390 && lay.ovFits && lay.pathFits, JSON.stringify(lay));
    await page.screenshot({ path: `${TL_SHOTS}plan-timelines-390-es-light.png`, fullPage: true });
    await ev(() => { document.getElementById('app').innerHTML = ''; });
  } else check('timelines drawn on a page', false, 'HomePlan.overview is missing');

  // =====================================================================
  // 6. The timer, from the server's clock (§7.2), with the device's clock a day off
  // =====================================================================
  const t0 = await ev((SERVER_NOW) => {
    const P = window.HomePlan;
    const session = { id: 'b1', minutes: 20, started_at: '2026-11-02T21:31:04.512+00:00', ends_at: '2026-11-02T21:51:04.512345+00:00' };
    window.__tm = P.timer({ ends_at: session.ends_at, started_at: session.started_at, server_now: SERVER_NOW }, performance.now());
    window.__card = P.timer({ ends_in_s: 754, minutes: 20 }, performance.now());
    window.__late = P.timer({ ends_at: '2026-11-02T21:20:00Z', server_now: SERVER_NOW, minutes: 20 }, performance.now());
    return {
      device: new Date().toISOString(), ms: [P.ms('2026-11-02T21:31:04.512Z'), P.ms('2026-11-02T16:31:04.512345-05:00'), P.ms('2026-11-02 21:31:04+00'), P.ms('nonsense')],
      left: P.left(window.__tm, performance.now()), card: P.left(window.__card, performance.now()), late: P.left(window.__late, performance.now()),
      audio: P.audioAt(window.__tm, performance.now(), 3.5),
      ring: [P.ring(1), P.ring(0.25), P.ring(0)],
    };
  }, SERVER_NOW);
  check('the device\'s clock is a day ahead of the household\'s', t0.device.startsWith('2026-11-03'), t0.device);
  check('ms(): timestamps from the database (Z, an offset, microseconds, a space and a short offset); NaN otherwise',
    t0.ms[0] === Date.UTC(2026, 10, 2, 21, 31, 4, 512) && t0.ms[1] === t0.ms[0] && t0.ms[2] === Date.UTC(2026, 10, 2, 21, 31, 4) && Number.isNaN(t0.ms[3]), JSON.stringify(t0.ms));
  check('timer: 20 minutes left at Start, from ends_at − server_now, whatever the device\'s clock says',
    t0.left.minutes === 20 && t0.left.seconds === 1200 && t0.left.fraction === 1 && !t0.left.done, JSON.stringify(t0.left));
  check('timer from the card\'s ends_in_s: 754 s left of 20 minutes', t0.card.seconds === 754 && t0.card.minutes === 13 && Math.abs(t0.card.fraction - 754 / 1200) < 1e-9, JSON.stringify(t0.card));
  check('timer: a block that ended before the answer is done at once', t0.late.done && t0.late.ms === 0 && t0.late.fraction === 0, JSON.stringify(t0.late));
  check('audioAt: the chime goes on the audio clock at Start, 1200 s ahead', Math.abs(t0.audio - 1203.5) < 1e-6, String(t0.audio));
  await page.clock.runFor(5 * 60 * 1000);
  const t5 = await ev(() => ({ left: window.HomePlan.left(window.__tm, performance.now()), date: new Date().toISOString() }));
  check('timer: 5 minutes later (the page\'s clock), 15 minutes left, three quarters of the ring', t5.left.minutes === 15 && Math.abs(t5.left.fraction - 0.75) < 1e-9, JSON.stringify(t5));
  // The device's clock jumps a day back (someone fixes it): the timer doesn't move.
  await page.clock.setSystemTime(new Date('2026-11-02T21:36:05Z'));
  const tFix = await ev(() => window.HomePlan.left(window.__tm, performance.now()));
  check('timer: a change of the device\'s clock moves nothing', tFix.minutes === 15, JSON.stringify(tFix));
  await page.clock.runFor(16 * 60 * 1000);
  const tEnd = await ev(() => window.HomePlan.left(window.__tm, performance.now()));
  check('timer: at the end, done, nothing left', tEnd.done && tEnd.ms === 0 && tEnd.fraction === 0, JSON.stringify(tEnd));
  const ringCheck = (svg) => {
    const m = /stroke-dasharray="([\d.]+)"[^>]*stroke-dashoffset="([\d.]+)"/.exec(svg);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  check('ring: a full ring at the start, a quarter left, empty and solid at the end',
    same(ringCheck(t0.ring[0]), [282.74, 0]) && same(ringCheck(t0.ring[1]), [282.74, 212.06]) && /is-done/.test(t0.ring[2]) && /<svg/.test(t0.ring[0]), JSON.stringify(t0.ring.map(ringCheck)));

  const focusWords = await ev(() => {
    const P = window.HomePlan;
    return [P.pointsLine({ seen: 12, focus: 12, on_time: 0 }, 'en'), P.pointsLine({ seen: 20, focus: 20, on_time: 10 }, 'en'), P.pointsLine({ seen: 0, focus: 0, on_time: 0 }, 'en'),
      P.pointsLine({ seen: 20, focus: 0, on_time: 0, capped: true }, 'en'), P.pointsLine({ seen: 20, focus: 2, on_time: 0, capped: true }, 'en'),
      P.pointsLine({ seen: 25, focus: 0, on_time: 0 }, 'en'), P.pointsLine({ seen: 12, focus: 12, on_time: 10 }, 'es'), P.pointsLine({ seen: 0 }, 'es'),
      P.pointsLine({ seen: 3, focus: 3, on_time: 0 }, 'en'),
      P.onTimeLine({ from: '16:00', until: '16:40', done: false }, 'en'), P.onTimeLine({ from: '16:00', until: '16:40', done: false, points: 8 }, 'es'),
      P.onTimeLine({ from: '16:00', until: '16:40', done: true }, 'en'), P.onTimeLine(null, 'en')];
  });
  // The owner changed the rule: a point per minute the server saw (it was 1 per 5 minutes, so under 5 minutes paid
  // nothing); a block under a minute still pays nothing; the on-time default is +10.
  check('pointsLine: what the server saw ("+12 · 12 minutes", "+20 · 20 minutes · +10 on time", "+3 · 3 minutes"), under a minute, the daily limit; his own block; Spanish',
    same(focusWords.slice(0, 9), ['+12 · 12 minutes', '+20 · 20 minutes · +10 on time', 'Under a minute: no points this time.', "Today's limit reached.",
      "+2 · 20 minutes · Today's limit reached.", '25 minutes', '+12 · 12 minutos · +10 a tiempo', 'Menos de un minuto: esta vez sin puntos.', '+3 · 3 minutes']),
    JSON.stringify(focusWords.slice(0, 9)));
  check('onTimeLine: "start by 4:40pm for +10" until the on-time start is done', same(focusWords.slice(9), ['start by 4:40pm for +10', 'empieza antes de las 16:40 para +8', '', '']),
    JSON.stringify(focusWords.slice(9)));
  // His timer's live count (the owner's "points ticking up during the block"): an estimate a point a minute from
  // the server's start, the on-time points once 5 minutes are seen, never past the block's length or what is left of
  // the day's cap (so never more than the end pays).
  const est = await ev(() => {
    const P = window.HomePlan;
    const e = { per_minute: 1, on_time: 10, room: 60 };
    return [P.estimate(e, 59, 20), P.estimate(e, 60, 20), P.estimate(e, 4 * 60 + 59, 20), P.estimate(e, 5 * 60, 20), P.estimate(e, 30 * 60, 20),
      P.estimate({ per_minute: 1, on_time: 0, room: 7 }, 12 * 60, 20), P.estimate({ per_minute: 2, on_time: 0, room: 60 }, 3 * 60, 10), P.estimate(null, 600, 20),
      P.estimate({ per_minute: 1, on_time: 10, room: 0 }, 600, 20)];
  });
  check("estimate: 0 under a minute, 1 at a minute, 4 at 4:59, 15 at 5 minutes (with the on-time 10), 30 past the end of a 20-minute block, the cap's room (7), the parents' 2 a minute, nothing for his own block or a full day",
    same(est, [0, 1, 4, 15, 30, 7, 6, 0, 0]), JSON.stringify(est));
  // The next-reward bar (§8.5): "N points to <reward>" toward the cheapest he can't afford yet, "You can get <reward> now!" when he can.
  const goal = await ev(() => {
    const P = window.HomePlan;
    const txt = (html) => { const d = document.createElement('div'); d.innerHTML = html; return [...d.querySelectorAll('p')].map((p) => p.textContent).concat(
      d.querySelector('.plan-goal-fill') ? [d.querySelector('.plan-goal-fill').style.width] : []); };
    return [
      txt(P.goalBar({ next: { title: 'Choose Friday\'s dinner', cost: 200, need: 6 }, now: null }, { lang: 'en' })),
      txt(P.goalBar({ next: { title: 'A new book', cost: 500, need: 1 }, now: null }, { lang: 'en' })),
      txt(P.goalBar({ next: { title: 'A new book', cost: 500, need: 300 }, now: { title: '15 minutes of extra game time', cost: 15, instant: true } }, { lang: 'en' })),
      txt(P.goalBar({ next: null, now: { title: 'A new book', cost: 500, instant: false } }, { lang: 'en' })),
      txt(P.goalBar({ next: { title: 'Choose Friday\'s dinner', cost: 200, need: 6 }, now: null }, { lang: 'en', extra: 4 })),
      txt(P.goalBar({ next: { title: 'Choose Friday\'s dinner', cost: 200, need: 6 }, now: null }, { lang: 'en', extra: 9 })),
      txt(P.goalBar({ next: { title: 'Elegir la cena del viernes', cost: 200, need: 6 }, now: { title: 'Un libro', cost: 50, instant: false } }, { lang: 'es' })),
      P.goalBar(null, { lang: 'en' }), P.goalBar({ next: null, now: null }, { lang: 'en' }),
      txt(P.goalBar({ next: { title: '<b>x</b>', cost: 10, need: 5 }, now: null }, { lang: 'en' })),
    ];
  });
  check(`goalBar: "6 points to …" with a bar of his free points (97%), "1 point to …", "You can get … now!" with the way to the next, the timer's points moving it on, "… when this block ends!", Spanish, nothing without a goal, a title as text`,
    same(goal, [["6 points to Choose Friday's dinner", '97%'], ['1 point to A new book', '99.8%'],
      ['You can get 15 minutes of extra game time now!', '300 points to A new book', '40%'], ['You can get A new book now!', '100%'],
      ["2 points to Choose Friday's dinner", '99%'], ["Choose Friday's dinner when this block ends!", '100%'],
      ['¡Ya puedes conseguir Un libro!', '6 puntos para Elegir la cena del viernes', '97%'], '', '', ['5 points to <b>x</b>', '50%']]), JSON.stringify(goal));

  // =====================================================================
  // 7. What an answer means, and the database's messages in his words
  // =====================================================================
  const said = await ev(() => {
    const P = window.HomePlan;
    const e = (message, code) => ({ message, code: code || 'P0001' });
    return {
      answer: [P.answer({ data: { a: 1 }, error: null, status: 200 }), P.answer({ data: null, error: null, status: 200 }), P.answer({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 }),
        P.answer({ data: null, error: { code: '42501', message: 'x' }, status: 403 }), P.answer({ data: null, error: { code: '22023', message: 'x' }, status: 400 }),
        P.answer({ data: null, error: { message: 'Failed to fetch', code: '' }, status: 0 }), P.answer({ data: null, error: { message: 'x', code: '' }, status: 503 }),
        P.answer(null)],
      en: [P.friendly(e("That step isn't on your plan.", '42501'), 'en'), P.friendly(e('Finish the block you started first.'), 'en'), P.friendly(e('This plan was changed since you opened it.'), 'en'),
        P.friendly(e('Plan this one with Pat.', '42501'), 'en', 'Pat'), P.friendly(e("That's too long.", '22023'), 'en'), P.friendly({ message: 'TypeError: Failed to fetch' }, 'en'),
        P.friendly(e('Something else entirely.', 'XX000'), 'en'), P.friendly(e("That assignment isn't on this link.", '42501'), 'en'), P.friendly(e("Say what's missing.", '22023'), 'en'),
        P.friendly(e("That step isn't on this link.", '42501'), 'en'), P.friendly(e('This assignment is done or dropped. Open it again first.'), 'en')],
      es: [P.friendly(e("That step isn't on your plan.", '42501'), 'es'), P.friendly(e('Choose 10, 15, 20 or 25 minutes.', '22023'), 'es'), P.friendly(e('Set a homework time first.', '22023'), 'es'),
        P.friendly(e('No homework day before it\'s due has room. Re-plan, make it smaller, or ask Pat.'), 'es', 'Pat'), P.friendly(e('Something else entirely.', 'XX000'), 'es'),
        P.friendly(e('Not enough points yet.', '42501'), 'es'), P.friendly(e('Points are off.', '42501'), 'es'), P.friendly(e("That's a lot for one day."), 'es'),
        P.friendly(e("That step isn't on this link.", '42501'), 'es'), P.friendly(e("That plan isn't on your list.", '42501'), 'es'),
        P.friendly(e('This assignment is done or dropped. Open it again first.'), 'es'), P.friendly(e('That plan is too long.', '22023'), 'es'),
        P.friendly(e("That's too long.", '22023'), 'es')],
    };
  });
  check('answer(): ok, gone (a token function\'s null), not_yet (PGRST202: before 0005), refused, retry (no answer, 5xx)',
    same(said.answer, ['ok', 'gone', 'not_yet', 'refused', 'refused', 'retry', 'retry', 'retry']), JSON.stringify(said.answer));
  check('friendly() in English: the database\'s homework messages in plain words; "Pat" from the link; anything else as it came',
    same(said.en, ["That step isn't on your plan.", 'Finish the block you started first.', 'This plan was changed since you opened it.', 'Plan this one with Pat.', "That's too long.",
      "Can't reach Home Hub. Check your internet connection and try again.", 'Something else entirely.', "That assignment isn't on this link.", "Say what's missing.",
      "That step isn't on this link.", 'This assignment is done or dropped. Open it again first.']), JSON.stringify(said.en));
  check('friendly() in Spanish: every homework message has its words; anything else is a general line',
    same(said.es, ['Ese paso no está en tu plan.', 'Elige 10, 15, 20 o 25 minutos.', 'Primero hay que poner un tiempo de tarea.',
      'No queda ningún día de tarea con sitio antes de la entrega. Vuelve a planear, hazlo más pequeño o pregunta a Pat.', 'Algo salió mal. Inténtalo de nuevo.',
      'Todavía no tienes puntos suficientes.', 'Los puntos están desactivados.', 'Es mucho para un día. Sigue mañana.',
      'Ese paso no está en este enlace.', 'Ese plan no está en tu lista.', 'Este trabajo está terminado o descartado. Vuelve a abrirlo primero.',
      'Ese plan es demasiado largo.', 'Es demasiado largo.']), JSON.stringify(said.es));
  // 0005's Uncheck once the milestone's points were traded (Pat's link, as a Void) and the token writers' last
  // guard: in plain words in English, in Spanish in Spanish (never "Algo salió mal").
  const spent = await ev(() => {
    const P = window.HomePlan;
    const e = (message, code) => ({ message, code });
    return [P.friendly(e('Those points are already spent.', 'P0001'), 'en'), P.friendly(e("That can't be saved.", '22023'), 'en'),
      P.friendly(e('Those points are already spent.', 'P0001'), 'es'), P.friendly(e("That can't be saved.", '22023'), 'es')];
  });
  check('friendly(): "Those points are already spent." and "That can\'t be saved." in English and Spanish',
    same(spent, ['Those points are already spent.', "That can't be saved.", 'Esos puntos ya se gastaron.', 'Eso no se puede guardar.']), JSON.stringify(spent));

  // =====================================================================
  // 8. The plan editor (§9.4): a parent's whole plan, with a fake api in the page
  // =====================================================================
  await ev(({ WEEK, SERVER_NOW }) => {
    const P = window.HomePlan;
    const clone = (x) => JSON.parse(JSON.stringify(x));
    window.WEEK = WEEK;
    // A stand-in for plan_save: ids for new steps, done steps kept whatever the list says, steps without
    // a day placed, plan_rev bumped, the first give recorded; a stale rev refused (and Jordan's step added
    // meanwhile, as if from his My day).
    window.fakeServer = (a0, o) => {
      const f = { calls: [], mode: 'ok', a: clone(a0), n: 0 };
      const apply = (steps, give) => {
        const old = new Map(f.a.steps.map((s) => [s.id, s]));
        let next = steps.map((s) => {
          const prev = s.id && old.get(s.id);
          if (prev && prev.done) return prev;
          return Object.assign({ done: false, checked: false, moved_from: null }, s, { id: s.id || `new-${++f.n}` });
        });
        f.a.steps.filter((s) => s.done && !next.some((x) => x.id === s.id)).forEach((s) => next.unshift(s));
        const placed = P.place(next, { today: '2026-11-02', due: f.a.due_date, kind: f.a.kind, asOf: '2026-11-02T16:31', days: o.week });
        next = next.map((s, i) => (s.day ? s : Object.assign({}, s, { day: placed.steps[i].day })));
        f.a.steps = next;
        f.a.plan_rev += 1;
        if (give && !f.a.given_at) Object.assign(f.a, { given_at: '2026-11-02T21:40:00.123456+00:00', given_by: o.who, given_by_name: o.who === 'family' ? 'alex@example.com' : null });
      };
      f.api = {
        async save(p) {
          f.calls.push(['save', clone(p)]);
          if (f.mode === 'gone') return { gone: true };
          if (f.mode === 'refuse') { f.mode = 'ok'; return { error: { code: '22023', message: "That's too long." } }; }
          if (f.mode === 'conflict' || p.rev !== f.a.plan_rev) {
            f.mode = 'ok';
            f.a.plan_rev += 1;
            f.a.steps.splice(f.a.steps.length - 1, 0, { id: 'kid-1', kind: 'step', title: 'Write one sentence', minutes: 10, day: '2026-11-03', source: 'typed', done: false });
            return { error: { code: 'P0001', message: 'This plan was changed since you opened it.' } };
          }
          apply(p.steps, p.give);
          return { assignment: clone(f.a) };
        },
        async reload() { f.calls.push(['reload']); return { assignment: clone(f.a) }; },
        async replan() {
          f.calls.push(['replan']);
          f.a.steps = f.a.steps.map((s) => (!s.done && P.PLAIN.includes(s.kind) ? Object.assign({}, s, { day: null }) : s));
          apply(f.a.steps, false);
          return { assignment: clone(f.a) };
        },
      };
      return f;
    };
    // An element's text with a space at every element's edge (textContent runs spans together; innerText
    // takes CSS's uppercase), whitespace collapsed.
    window.txt = (root) => {
      const out = [];
      const walk = (n) => {
        if (n.nodeType === 3) out.push(n.nodeValue);
        else if (n.nodeType === 1 && !n.matches('script, style')) { out.push(' '); n.childNodes.forEach(walk); out.push(' '); }
      };
      walk(root);
      return out.join('').replace(/\s+/g, ' ').trim();
    };
    window.mountEditor = (id, role, a, extra) => {
      const box = document.createElement('div');
      box.id = id;
      document.getElementById('app').appendChild(box);
      const f = window.fakeServer(a, { week: WEEK, who: role === 'kid' ? 'kid' : role });
      const out = { f, toasts: [], gone: 0, saved: 0 };
      out.ed = P.editor(box, Object.assign({
        role, lang: 'en', today: '2026-11-02', asOf: '2026-11-02T16:31', serverNow: SERVER_NOW, length: 20, kid: 'Jordan', tutor: 'Pat', week: WEEK,
        api: f.api, toast: (text) => out.toasts.push(text), onGone: () => { out.gone += 1; }, onSaved: () => { out.saved += 1; },
      }, extra));
      out.ed.set(a);
      window[id] = out;
      return true;
    };
  }, { WEEK, SERVER_NOW });

  const A = { id: 'a-1', kind: 'assignment', title: 'Science project: river poster', subject: 'Science', due_date: '2026-11-13', details: `Make a poster.\n${HOSTILE}`,
    status: 'open', plan_rev: 0, given_at: null, given_by: null, time_left: 305, horizon: null, no_time: false, steps: [] };
  await ev(({ A }) => window.mountEditor('edf', 'family', A), { A });
  const ED = '#edf';
  const edText = () => page.$eval(ED, (b) => window.txt(b));
  const calls = () => ev(() => window.edf.f.calls);
  const settle = () => ev(async () => { for (let i = 0; i < 50; i++) await null; });
  const waitFor = async (sel) => {
    for (let i = 0; i < 60; i++) {
      if (await page.$(sel)) return true;
      await settle();
    }
    return false;
  };
  const rows = () => page.$$eval(`${ED} .plan-step`, (els) => els.map((li) => ({
    title: li.querySelector('.plan-step-title').textContent, day: (li.querySelector('select[name="day"]') || {}).value || null,
    cls: li.className, more: !!li.querySelector('[data-act="more"]'), lock: !!li.querySelector('.plan-lock') })));

  let text = await edText();
  check('editor: the title, "due Fri Nov 13 (11 days)", the empty plan', text.includes('Science project: river poster') && text.includes('due Fri Nov 13 (11 days)')
    && text.includes('No steps yet. Start from a starter plan, or add a step.'), text);
  const details = await page.$eval(`${ED} .plan-text`, (d) => ({ open: d.open, body: d.querySelector('.plan-text-body').textContent, img: !!d.querySelector('img') }));
  check('editor: the teacher\'s text folded, its lines kept, drawn as text', !details.open && details.body === `Make a poster.\n${HOSTILE}` && !details.img, JSON.stringify(details));
  check('editor: no AI part without opts.ai (no Send to Claude, no "What Claude will see")', !/Claude|AI/.test(text), text);

  await page.click(`${ED} [data-act="starter"]`);
  const chips = await page.$$eval(`${ED} [data-starter]`, (els) => els.map((b) => [b.dataset.starter, b.classList.contains('is-guess'), b.textContent]));
  check('starter plans: five, one tap each, the guess from the title marked (a project → Essay or project)',
    same(chips, [['essay', true, 'Essay or project'], ['test', false, 'Test'], ['reading', false, 'Reading'], ['practice', false, 'Practice'], ['short', false, 'Short']]), JSON.stringify(chips));
  await page.click(`${ED} [data-starter="essay"]`);
  await settle();
  let c = await calls();
  const first = c[0] && c[0][1];
  check('a starter plan is saved at once, without days, so the database places it: 9 steps, source template, minutes cut to his first length (20), rev 0, not given',
    c.length === 1 && first.steps.length === 9 && first.steps.every((s) => s.day === null && s.source === 'template' && !s.id && s.minutes <= 20 && s.done_looks_like)
    && first.rev === 0 && first.give === false && first.steps[8].kind === 'turn_in' && first.steps[8].minutes === 5, JSON.stringify(first).slice(0, 300));
  let r = await rows();
  check('the placed plan is drawn: 9 steps on the days the database gave', same(r.map((x) => x.day),
    ['2026-11-02', '2026-11-02', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-04', '2026-11-05', '2026-11-08', '2026-11-13']), JSON.stringify(r.map((x) => x.day)));
  text = await edText();
  check('the bars under the plan: Work left 2 h 25, Homework time left 5 h 05, "Fits · 4 days spare"',
    /Work left 2 h 25 Homework time left 5 h 05/.test(text) && text.includes('Fits · 4 days spare'), text);
  let btn = await page.$$eval(`${ED} .plan-actions button`, (els) => els.map((b) => [b.dataset.act, b.disabled, b.textContent]));
  check('Save is off until something changes; Give Jordan this plan is there', same(btn, [['save', true, 'Save'], ['give', false, 'Give Jordan this plan']]), JSON.stringify(btn));
  check('Saved toast and onSaved', same(await ev(() => [window.edf.toasts, window.edf.saved]), [['Saved'], 1]));

  // Rename a step through ⋯: it becomes 'typed'; the others stay 'template'.
  await page.click(`${ED} .plan-step[data-i="1"] [data-act="more"]`);
  const editKeys = await page.$$eval(`${ED} .plan-step-edit [name]`, (els) => els.map((x) => x.name));
  check('⋯: title, done looks like, minutes, kind; move up, move down, delete', same(editKeys, ['title', 'dll', 'minutes', 'kind'])
    && same(await page.$$eval(`${ED} .plan-step-edit button`, (els) => els.map((b) => b.dataset.act)), ['up', 'down', 'delete', 'close']), JSON.stringify(editKeys));
  await page.fill(`${ED} .plan-step-edit [name="title"]`, 'Find 2 sources and save their links');
  check('typing a title shows it in the row at once', (await rows())[1].title === 'Find 2 sources and save their links');
  await page.click(`${ED} .plan-step-edit [data-act="close"]`);
  await page.click(`${ED} [data-act="save"]`);
  await settle();
  c = await calls();
  check('Save sends the whole plan with ids and rev 1; the renamed step is "typed", the rest keep "template"',
    c.length === 2 && c[1][1].rev === 1 && c[1][1].steps.every((s) => s.id) && c[1][1].steps[1].title === 'Find 2 sources and save their links'
    && c[1][1].steps[1].source === 'typed' && c[1][1].steps.filter((s) => s.source === 'typed').length === 1, JSON.stringify(c[1] && c[1][1].steps.map((s) => s.source)));

  // A milestone on, a move, a delete.
  await page.click(`${ED} .plan-step[data-i="2"] [data-act="more"]`);
  await page.selectOption(`${ED} .plan-step-edit [name="kind"]`, 'milestone');
  r = await rows();
  check('kind → milestone: the row is a milestone at once (◆)', /k-milestone/.test(r[2].cls), r[2].cls);
  await page.click(`${ED} .plan-step[data-i="4"] [data-act="more"]`);
  await page.click(`${ED} .plan-step-edit [data-act="down"]`);
  check('Move down: the step changes places, and its ⋯ stays open', (await rows())[5].title === 'Draft the first half'
    && await page.$eval(`${ED} .plan-step-edit`, (x) => x.getAttribute('data-i')) === '5');
  await page.click(`${ED} .plan-step-edit [data-act="delete"]`);
  await page.click(`${ED} [data-act="save"]`);
  await settle();
  c = await calls();
  check('Save: the milestone, the new order, the deleted step gone (8 steps)', c.length === 3 && c[2][1].steps.length === 8 && c[2][1].steps[2].kind === 'milestone'
    && c[2][1].steps[4].title === 'Draft the second half' && !c[2][1].steps.some((s) => s.title === 'Draft the first half'), JSON.stringify(c[2] && c[2][1].steps.map((s) => s.title)));

  // The plan's rules are checked before anything is sent.
  await page.click(`${ED} .plan-step[data-i="0"] [data-act="more"]`);
  await page.fill(`${ED} .plan-step-edit [name="title"]`, 'Go');
  await page.click(`${ED} [data-act="save"]`);
  await settle();
  const msg = await page.$eval(`${ED} .plan-msg`, (p) => [p.textContent, p.classList.contains('is-error'), p.getAttribute('role')]);
  check('a 2-character title: "Step 1: Give it a title of 3 to 80 characters." and nothing sent', same(msg, ['Step 1: Give it a title of 3 to 80 characters.', true, 'alert'])
    && (await calls()).length === 3, JSON.stringify(msg));
  await page.fill(`${ED} .plan-step-edit [name="title"]`, 'Copy the requirements into your notes');
  await page.click(`${ED} .plan-step-edit [data-act="close"]`);

  // The day picker: homework days first, the others marked; only the turn-in may have the due date.
  const picker = await page.$$eval(`${ED} .plan-step`, (els) => els.map((li) => {
    const sel = li.querySelector('select[name="day"]');
    return sel ? { groups: Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label), first: (sel.querySelector('optgroup + optgroup option') || {}).textContent,
      last: sel.options[sel.options.length - 1].value, hasDue: Array.from(sel.options).some((x) => x.value === '2026-11-13'), firstValue: sel.options[0].value } : null;
  }));
  check('day picker: homework days first, then the others marked "not a homework day"', same(picker[1].groups, ['Homework days', 'Other days'])
    && picker[1].first === 'Fri Nov 6 · not a homework day' && picker[1].firstValue === '2026-11-02', JSON.stringify(picker[1]));
  check('day picker: a step up to the day before the due date; the turn-in up to the due date itself', !picker[1].hasDue && picker[7].hasDue, JSON.stringify([picker[1], picker[7]]));
  await page.selectOption(`${ED} .plan-step[data-i="1"] select[name="day"]`, '2026-11-09');
  await page.click(`${ED} [data-act="save"]`);
  await settle();
  c = await calls();
  check('a step moved to Mon Nov 9 is saved with that day, and "typed"', c.length === 4 && c[3][1].steps[1].day === '2026-11-09' && c[3][1].steps[1].source === 'typed', JSON.stringify(c[3] && c[3][1].steps[1]));

  // Place again: every step not done goes without its day.
  await page.click(`${ED} [data-act="place"]`);
  await settle();
  c = await calls();
  check('Place again sends the steps not done without days', c.length === 5 && c[4][1].steps.every((s) => s.day === null) && c[4][1].give === false, JSON.stringify(c[4] && c[4][1].steps.map((s) => s.day)));

  await page.click(`${ED} [data-act="give"]`);
  await settle();
  c = await calls();
  text = await edText();
  check('Give Jordan this plan: give true, then "On Jordan\'s My day since today · by alex@example.com" and no Give button',
    c.length === 6 && c[5][1].give === true && text.includes("On Jordan's My day since today · by alex@example.com") && !(await page.$(`${ED} [data-act="give"]`)), text.slice(-120));
  check('a given plan: "Given to Jordan"', (await ev(() => window.edf.toasts)).includes('Given to Jordan'));

  // A save made on an old copy: reloaded, with "Changed since you opened it: here it is now."
  await ev(() => { window.edf.f.mode = 'conflict'; });
  await page.click(`${ED} .plan-step[data-i="0"] [data-act="more"]`);
  await page.selectOption(`${ED} .plan-step-edit [name="minutes"]`, '15');
  await page.click(`${ED} [data-act="save"]`);
  await settle();
  c = await calls();
  text = await edText();
  check('a stale save reloads the plan and says so (the step Jordan added meanwhile is there)', c[c.length - 1][0] === 'reload' && text.includes('Changed since you opened it: here it is now.')
    && text.includes('Write one sentence'), text.slice(0, 200));
  await ev(() => { window.edf.f.mode = 'refuse'; });
  await page.click(`${ED} .plan-step[data-i="0"] [data-act="more"]`);
  await page.selectOption(`${ED} .plan-step-edit [name="minutes"]`, '10');
  await page.click(`${ED} [data-act="save"]`);
  await settle();
  check('a refusal is said in the reader\'s words, and the change stays to fix', await page.$eval(`${ED} .plan-msg`, (p) => p.textContent) === "That's too long."
    && !(await page.$eval(`${ED} [data-act="save"]`, (b) => b.disabled)));
  await ev(() => { window.edf.f.mode = 'gone'; });
  await page.click(`${ED} [data-act="save"]`);
  await settle();
  check('a link that no longer works calls onGone', await ev(() => window.edf.gone) === 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.$eval(ED, (x) => x.scrollIntoView());
  await page.screenshot({ path: `${SHOTS}plan-editor-390.png`, fullPage: true });

  // Hostile text, done steps, doesn't fit, Spanish.
  await ev(({ HOSTILE }) => {
    window.edf.ed.set({ id: 'a-9', kind: 'assignment', title: HOSTILE, due_date: '2026-11-13', status: 'open', plan_rev: 3, time_left: 30, steps: [
      { id: 'h1', kind: 'start', title: HOSTILE, done_looks_like: HOSTILE, minutes: 10, day: '2026-11-01', done: true, source: 'typed' },
      { id: 'h2', kind: 'step', title: 'Draft the second half', minutes: 60, day: '2026-11-02', source: 'typed' },
      { id: 'h3', kind: 'step', title: 'Left from Friday', minutes: 20, day: '2026-10-30', source: 'typed', moved_from: '2026-10-29' }] });
  }, { HOSTILE });
  text = await edText();
  const hostile = await page.$eval(ED, (b) => ({ img: b.querySelectorAll('img').length, xss: window.__xss === undefined, title: b.querySelector('.plan-ed-title').textContent,
    doneMore: !!b.querySelector('.plan-step[data-i="0"] [data-act="more"]'), doneSel: !!b.querySelector('.plan-step[data-i="0"] select'),
    pastFirst: (b.querySelector('.plan-step[data-i="2"] select[name="day"] option') || {}).textContent }));
  check('typed text is drawn as text everywhere (titles, "done looks like", the teacher\'s text)', hostile.img === 0 && hostile.xss && hostile.title === HOSTILE, JSON.stringify(hostile));
  check('a done step is read-only: no ⋯ and no day picker', !hostile.doneMore && !hostile.doneSel, JSON.stringify(hostile));
  check('a step whose day has passed keeps it, "from Fri", and "moved from Thu"', hostile.pastFirst === 'Fri Oct 30 · from Fri' && text.includes('moved from Thu'), JSON.stringify([hostile.pastFirst, text]));
  check('more work than time: "Doesn\'t fit: add homework time, drop a step or talk to the teacher."', text.includes("Doesn't fit: add homework time, drop a step or talk to the teacher.")
    && !text.includes('Fits'), text.slice(-200));
  await ev(() => window.edf.ed.set(Object.assign({}, window.edf.ed.get(), { title: 'Proyecto de ciencias' }), { lang: 'es' }));
  text = await edText();
  check('the editor in Spanish', ['Empezar con un plan base', 'Añadir un paso', 'Colocar de nuevo', 'Guardar', 'Darle este plan a Jordan', 'para el vie 13 nov (11 días)', 'Trabajo pendiente',
    'No cabe: añade tiempo de tarea, quita un paso o habla con el profesor.', 'de el vie'].every((x, i) => (i === 8 ? !text.includes(x) : text.includes(x))), text);

  // A lesson whose do-by day is a homework day (Thu): Practice puts its last block on Thu, and the editor saves it
  // (the database's last work day for a lesson is its do-by day).
  const LT = { id: 'a-8', kind: 'lesson', title: 'Fractions practice', subject: 'Math', due_date: '2026-11-05', status: 'open', plan_rev: 0, given_at: null, given_by: null,
    time_left: 120, horizon: null, no_time: false, steps: [] };
  await ev(({ LT }) => window.mountEditor('edl', 'family', LT), { LT });
  await page.click('#edl [data-act="starter"]');
  await page.click('#edl [data-starter="practice"]');
  await settle();
  const lc = await ev(() => window.edl.f.calls);
  const lmsg = await page.$eval('#edl', (b) => (b.querySelector('.plan-msg') || {}).textContent || '');
  check('editor: Practice for a lesson due Thu saves at once, its last block (the milestone) on Thu, with no "Only the turn-in goes on the due date."',
    lc.length === 1 && same(lc[0][1].steps.map((s) => [s.day, s.kind]), [['2026-11-02', 'step'], ['2026-11-03', 'step'], ['2026-11-04', 'step'], ['2026-11-05', 'milestone']])
    && !/due date/.test(lmsg), JSON.stringify([lc, lmsg]));
  const lessonDays = await page.$eval('#edl .plan-step[data-i="0"] select[name="day"]', (sel) => Array.from(sel.options).map((x) => x.value).filter(Boolean)).catch(() => []);
  check('a lesson\'s day picker: plain steps up to its do-by day (Thu), a work day', lessonDays.includes('2026-11-05') && !lessonDays.includes('2026-11-06'), JSON.stringify(lessonDays));
  await ev(() => { window.edl.ed.stop(); document.getElementById('edl').remove(); });
  // An assignment due Thu: Practice ends on Wed, its last work day (only the turn-in goes on the due date), and
  // the editor saves it at once, with no "Only the turn-in goes on the due date.".
  const AT = Object.assign({}, LT, { id: 'a-9', kind: 'assignment', title: 'Spelling practice' });
  await ev(({ AT }) => window.mountEditor('eda', 'family', AT), { AT });
  await page.click('#eda [data-act="starter"]');
  await page.click('#eda [data-starter="practice"]');
  await settle();
  const ac = await ev(() => window.eda.f.calls);
  const amsg = await page.$eval('#eda', (b) => (b.querySelector('.plan-msg') || {}).textContent || '');
  const asgDays = await page.$eval('#eda .plan-step[data-i="0"] select[name="day"]', (sel) => Array.from(sel.options).map((x) => x.value).filter(Boolean)).catch(() => []);
  check('editor: Practice for an assignment due Thu saves at once, its last block (the milestone) on Wed; its day picker stops before the due date',
    ac.length === 1 && same(ac[0][1].steps.map((x) => [x.day, x.kind]), [['2026-11-02', 'step'], ['2026-11-03', 'step'], ['2026-11-04', 'milestone']])
    && !/due date/.test(amsg) && asgDays.includes('2026-11-04') && !asgDays.includes('2026-11-05'), JSON.stringify([ac, amsg, asgDays]));
  await ev(() => { window.eda.ed.stop(); document.getElementById('eda').remove(); });

  // =====================================================================
  // 9. The editor with Jordan's rules (#plan/<id>)
  // =====================================================================
  const K = { id: 'a-2', kind: 'assignment', title: 'Spanish vocabulary project', due_date: '2026-11-13', status: 'open', plan_rev: 4, given_at: '2026-11-01T22:00:00Z', given_by: 'tutor',
    time_left: 305, steps: [
      { id: 'k1', kind: 'start', title: 'Copy the word list', minutes: 10, day: '2026-11-01', done: true, source: 'template' },
      { id: 'k2', kind: 'step', title: 'Make 10 flash cards', minutes: 20, day: '2026-11-02', source: 'template' },
      { id: 'k3', kind: 'milestone', title: 'All 30 cards made', minutes: 20, day: '2026-11-04', source: 'typed' },
      { id: 'k4', kind: 'step', title: 'Quiz yourself on the cards', minutes: 15, day: '2026-11-05', source: 'typed' },
      { id: 'k5', kind: 'turn_in', title: 'Turn it in', minutes: 5, day: '2026-11-13', source: 'template' }] };
  await ev(({ K }) => window.mountEditor('edk', 'kid', K), { K });
  const KD = '#edk';
  const krows = await page.$$eval(`${KD} .plan-step`, (els) => els.map((li) => [li.dataset.id, !!li.querySelector('select[name="day"]'), !!li.querySelector('[data-act="more"]'), !!li.querySelector('.plan-lock')]));
  check('Jordan: plain steps not done have a day and ⋯; a done step, the milestone and the turn-in don\'t, and the last two carry a lock',
    same(krows, [['k1', false, false, false], ['k2', true, true, false], ['k3', false, false, true], ['k4', true, true, false], ['k5', false, false, true]]), JSON.stringify(krows));
  const ktext = await page.$eval(KD, (b) => window.txt(b));
  const ktools = await page.$$eval(`${KD} [data-act]`, (els) => Array.from(new Set(els.map((b) => b.dataset.act))));
  check('Jordan: "Milestones are checkpoints you set with Pat. Change them together."; Add a step and Re-plan; no starter plans, Place again or Give; no "given" line',
    ktext.includes('Milestones are checkpoints you set with Pat. Change them together.') && same(ktools, ['add', 'replan', 'more', 'save']) && !ktext.includes("Jordan's My day"), JSON.stringify([ktools, ktext]));
  await page.click(`${KD} .plan-step[data-i="3"] [data-act="more"]`);
  const kedit = await page.$$eval(`${KD} .plan-step-edit [name]`, (els) => els.map((x) => x.name));
  const kdown = await page.$eval(`${KD} .plan-step-edit [data-act="down"]`, (b) => b.disabled);
  check('Jordan\'s ⋯: no kind; a step can\'t go below the turn-in', same(kedit, ['title', 'dll', 'minutes']) && kdown, JSON.stringify([kedit, kdown]));
  await page.click(`${KD} .plan-step-edit [data-act="close"]`);
  await page.selectOption(`${KD} .plan-step[data-i="1"] select[name="day"]`, '2026-11-03');
  check('Re-plan waits while a change isn\'t saved', await page.$eval(`${KD} [data-act="replan"]`, (b) => b.disabled));
  await page.click(`${KD} [data-act="save"]`);
  await settle();
  const kc = await ev(() => window.edk.f.calls);
  check('Jordan\'s save: the whole plan (the milestone and turn-in as they were), his moved step "typed", rev 4',
    kc.length === 1 && kc[0][1].rev === 4 && kc[0][1].steps.length === 5 && kc[0][1].steps[1].day === '2026-11-03' && kc[0][1].steps[1].source === 'typed'
    && kc[0][1].steps[2].kind === 'milestone' && kc[0][1].steps[2].day === '2026-11-04' && kc[0][1].steps[2].source === 'typed' && kc[0][1].give === false, JSON.stringify(kc[0] && kc[0][1]));
  await page.click(`${KD} [data-act="replan"]`);
  await settle();
  check('Re-plan asks the database to place his plain steps again', same((await ev(() => window.edk.f.calls)).map((x) => x[0]), ['save', 'replan'])
    && (await ev(() => window.edk.toasts)).includes('Planned again from today'));
  await ev(() => window.edk.ed.set(window.edk.ed.get(), { tutor: null }));
  check('with no tutor link: "…checkpoints you set with your parents…"', (await page.$eval(KD, (b) => b.textContent)).includes('Milestones are checkpoints you set with your parents. Change them together.'));
  await ev(() => { window.edf.ed.stop(); window.edk.ed.stop(); document.getElementById('app').innerHTML = ''; });

  // =====================================================================
  // 10. Pat's link (§9.5), with a fake api in the page
  // =====================================================================
  const A1 = '11111111-1111-4111-8111-111111111111';
  const A2 = '22222222-2222-4222-8222-222222222222';
  const A3 = '33333333-3333-4333-8333-333333333333';
  const A4 = '44444444-4444-4444-8444-444444444444';
  const requests = [];
  page.on('request', (q) => { if (!q.url().startsWith(BASE)) requests.push(q.url()); });
  await ev(({ WEEK, SERVER_NOW, HOSTILE, A1, A2, A3, A4 }) => {
    const P = window.HomePlan;
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const steps9 = P.place(P.starter('essay', { lang: 'en', length: 20 }), { today: '2026-11-02', due: '2026-11-13', kind: 'assignment', asOf: '2026-11-02T16:31', days: WEEK })
      .steps.map((s, i) => Object.assign(s, { id: `s${i + 1}`, done: i < 4, source: 'template' }));
    const f = { calls: [], mode: 'ok', capped: false, n: 0 };
    f.view = {
      language: 'en', as_of: '2026-11-02T16:31', today: '2026-11-02', server_now: SERVER_NOW, tutor: 'Pat Lee, tutor', kid: 'Jordan', ends_on: '2027-04-30', ai: null,
      to_check: [{ step_id: 's4', assignment: 'Science project', title: 'Outline with 3 main ideas', done_looks_like: 'an outline with 3 ideas', day: '2026-11-04', done_day: '2026-10-28' }],
      to_talk_about: [{ assignment_id: A1, title: 'Science project', milestone: 'Full draft', planned_day: '2026-10-29' }],
      questions: [{ step_id: 'q1', assignment: 'Worksheet 4.2', title: 'Do it', question: `What does 'simplify fully' mean here? ${HOSTILE}`, question_at: '2026-11-02T20:00:00Z', answer: null }],
      plans: [{ assignment_id: A3, title: 'Fractions practice', state: 'none', ai_state: null }],
      assignments: [
        { id: A1, kind: 'assignment', title: 'Science project: river poster', subject: 'Science', due_date: '2026-11-13', status: 'open', state: 'given', added_by: 'family', given_by: 'tutor',
          minutes_left: 100, time_left: 195, horizon: null, no_time: false, steps_done: 4, steps: 9, next_milestone: { title: 'Full draft', day: '2026-11-06' } },
        { id: A2, kind: 'assignment', title: 'Worksheet 5.1', subject: 'Math', due_date: '2026-11-04', status: 'open', state: 'given', added_by: 'kid', given_by: 'kid',
          minutes_left: 15, time_left: 75, horizon: null, no_time: false, steps_done: 0, steps: 1, next_milestone: null },
        { id: A3, kind: 'lesson', title: 'Fractions practice', subject: 'Math', due_date: '2026-11-06', status: 'open', state: 'none', added_by: 'tutor', given_by: null,
          minutes_left: 0, time_left: 165, horizon: null, no_time: false, steps_done: 0, steps: 0, next_milestone: null },
        { id: A4, kind: 'assignment', title: HOSTILE, subject: null, due_date: '2026-10-30', status: 'done', state: 'given', added_by: 'family', given_by: 'family',
          minutes_left: 0, time_left: 0, horizon: null, no_time: false, steps_done: 2, steps: 2, next_milestone: null }],
      week: WEEK,
      record: [{ day: '2026-11-02', focused: 20, sessions: [{ minutes: 20, with_tutor: false, result: 'done', step: 'Find 2 sources', note: 'found 2 sources' }] },
        { day: '2026-10-27', focused: 25, sessions: [{ minutes: 25, with_tutor: true, result: 'more', step: 'Draft the first half', note: null }] },
        { day: '2026-10-26', focused: 0, sessions: [] }],
      pace: { ratio: 1.3, steps: 9 },
    };
    f.details = {
      [A1]: { id: A1, kind: 'assignment', title: 'Science project: river poster', subject: 'Science', due_date: '2026-11-13', details: 'Make a poster about a river.', stretch: null, status: 'open',
        plan_rev: 6, given_at: '2026-11-01T23:00:00Z', given_by: 'tutor', steps: steps9, ai: null, preview: null, fits: true, over: 0, horizon: null },
      [A3]: { id: A3, kind: 'lesson', title: 'Fractions practice', subject: 'Math', due_date: '2026-11-06', details: null, stretch: null, status: 'open',
        plan_rev: 0, given_at: null, given_by: null, steps: [], ai: null, preview: null, fits: false, over: 0, horizon: null },
    };
    const ok = (data) => ({ data: clone(data), error: null, status: 200 });
    const viewWith = (id) => Object.assign(clone(f.view), id ? { assignment: f.details[id] ? clone(f.details[id]) : null } : {});
    f.api = {
      async view(id, part) {
        f.calls.push(['view', id, part]);
        if (f.mode === 'gone') return { data: null, error: null, status: 200 };
        if (f.mode === 'old') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.tutor_view_by_token' }, status: 404 };
        if (f.mode === 'down') return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 };
        return ok(viewWith(id));
      },
      async assignment(fields) {
        f.calls.push(['assignment', clone(fields)]);
        const known = f.details[fields.id];
        if (known) Object.assign(known, fields);
        else {
          f.details[fields.id] = Object.assign({ details: null, stretch: null, status: 'open', plan_rev: 0, given_at: null, given_by: null, steps: [], ai: null, preview: null, fits: false, over: 0, horizon: null }, fields);
          f.view.assignments.push({ id: fields.id, kind: fields.kind, title: fields.title, subject: fields.subject, due_date: fields.due_date, status: 'open', state: 'none',
            added_by: 'tutor', given_by: null, minutes_left: 0, time_left: 165, horizon: null, no_time: false, steps_done: 0, steps: 0, next_milestone: null });
        }
        return ok(viewWith(null));
      },
      async plan(id, steps, rev, give) {
        f.calls.push(['plan', id, clone(steps), rev, give]);
        const a = f.details[id];
        if (rev !== a.plan_rev) return { data: null, error: { code: 'P0001', message: 'This plan was changed since you opened it.' }, status: 400 };
        const placed = P.place(steps, { today: '2026-11-02', due: a.due_date, kind: a.kind, asOf: '2026-11-02T16:31', days: WEEK });
        a.steps = steps.map((s, i) => Object.assign({ done: false }, s, { id: s.id || `t${++f.n}`, day: s.day || placed.steps[i].day }));
        a.plan_rev += 1;
        if (give && !a.given_at) Object.assign(a, { given_at: '2026-11-02T21:40:00Z', given_by: 'tutor' });
        const e = f.view.assignments.find((x) => x.id === id);
        Object.assign(e, { state: a.given_at ? 'given' : 'planning', steps: a.steps.length, minutes_left: P.workLeft(a.steps) });
        return ok(viewWith(id));
      },
      async step(id, action, textIn) {
        f.calls.push(['step', id, action, textIn]);
        if (action === 'not_yet' && !textIn) return { data: null, error: { code: '22023', message: "Say what's missing." }, status: 400 };
        const capped = f.capped;
        if (action === 'check' || action === 'not_yet') f.view.to_check = f.view.to_check.filter((x) => x.step_id !== id);
        if (action === 'uncheck') f.view.to_check.push({ step_id: id, assignment: 'Science project', title: 'Outline with 3 main ideas', done_looks_like: null, day: '2026-11-04', done_day: '2026-10-28' });
        if (action === 'answer') f.view.questions.forEach((q) => { if (q.step_id === id) q.answer = textIn; });
        return ok(Object.assign(viewWith(null), action === 'check' ? { used_up: capped } : {}));
      },
    };
    window.pat = f;
    window.patToasts = [];
    window.patGone = 0;
    const box = document.createElement('div');
    box.id = 'pat';
    document.getElementById('app').appendChild(box);
    window.ctl = P.tutor(box, {
      api: f.api, lang: 'en', onGone: () => { window.patGone += 1; },
      toast: (msgText, x) => { window.patToasts.push(msgText); window.patAction = x && x.action ? x.action : null; },
    });
    window.addEventListener('hashchange', () => window.ctl.show(location.hash));
    return window.ctl.show(location.hash);
  }, { WEEK, SERVER_NOW, HOSTILE, A1, A2, A3, A4 });
  await settle();
  const PAT = '#pat';
  const patText = () => page.$eval(PAT, (b) => window.txt(b));
  const patCalls = () => ev(() => window.pat.calls);
  text = await patText();
  check('Pat\'s link: "Homework · Jordan", "Hi Pat Lee, tutor · Link ends Apr 30", and the first coaching line',
    text.startsWith("Homework · Jordan Hi Pat Lee, tutor · Link ends Apr 30 Start with what he did. Ask what's next and when he'll start it."), text.slice(0, 160));
  const order = await page.$$eval(`${PAT} [data-sec]`, (els) => els.map((s) => s.dataset.sec));
  check('the fixed order: To check, To talk about, Questions, Plans to look at, Assignments, His week, Last 14 days',
    same(order, ['check', 'talk', 'questions', 'plans', 'assignments', 'week', 'record']), JSON.stringify(order));
  check('To check: "◆ Outline with 3 main ideas", "Science project · ticked Wed", what done looks like, Looks done and Not yet',
    text.includes('Outline with 3 main ideas Science project · ticked Wed Done looks like: an outline with 3 ideas Looks done Not yet'), text);
  check('To talk about: "Full draft" was planned for Thu, and the question to ask', text.includes('"Full draft" was planned for Thu · Ask what got in the way, then pick a new day together.'), text);
  check('the assignments: "4 of 9 · Full draft Fri", "added by Jordan", "lesson · do by Fri", "No plan yet ›"; the bars on a given plan; done ones folded',
    text.includes('Science · Science project: river poster due Fri Nov 13 4 of 9 · Full draft Fri Work left 1 h 40 Homework time left 3 h 15')
    && text.includes('Math · Worksheet 5.1 due Wed · added by Jordan 0 of 1') && text.includes('Math · Fractions practice lesson · do by Fri No plan yet ›')
    && await page.$eval(`${PAT} .plan-done`, (d) => !d.open), text);
  check('His week (Busy, never a title) and the last 14 days ("with you", his note) and his pace',
    text.includes('Tue 30 free Busy 5:00pm') && text.includes('Today · 20 min · Step done · Find 2 sources · found 2 sources')
    && text.includes('Tue · 25 min · with you · More to do · Draft the first half') && text.includes('Steps take about 1.3× the planned time'), text);
  const hidden = await page.$eval(PAT, (b) => ({ img: b.querySelectorAll('img').length, xss: window.__xss === undefined }));
  check('Pat\'s link draws typed text as text', hidden.img === 0 && hidden.xss, JSON.stringify(hidden));
  check('no points, rewards, asks, family names, events by name, and nothing live (no "alone", no "focusing")',
    !/point|reward|ask for|alone|focusing|Alex|Morgan|Sam\b|Taylor|Piano|★/i.test(text), (text.match(/point|reward|alone|focusing|Alex|Morgan|Sam\b|Taylor|Piano/ig) || []).join(','));
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow390 = await ev(() => document.documentElement.scrollWidth);
  check('Pat\'s link at 390px: nothing scrolls sideways', overflow390 <= 390, String(overflow390));
  await page.screenshot({ path: `${SHOTS}plan-tutor-390.png`, fullPage: true });

  // Not yet needs a note; Looks done takes an optional one, with Undo.
  await page.click(`${PAT} [data-act="not-yet"]`);
  await page.click(`${PAT} .plan-note [type="submit"]`);
  check('Not yet with no note: "Say what\'s missing." and nothing sent', await page.$eval(`${PAT} .plan-note .form-error`, (p) => !p.hidden && p.textContent) === "Say what's missing."
    && !(await patCalls()).some((x) => x[0] === 'step'));
  await page.fill(`${PAT} .plan-note [name="text"]`, 'Add a source for the second idea.');
  await page.click(`${PAT} .plan-note [type="submit"]`);
  await settle();
  check('Not yet with a note: tutor_step_by_token(not_yet, the note); "Sent back with your note"', same((await patCalls()).filter((x) => x[0] === 'step'), [['step', 's4', 'not_yet', 'Add a source for the second idea.']])
    && (await ev(() => window.patToasts)).includes('Sent back with your note'));
  await ev(() => window.pat.api.step('s4', 'uncheck', null));
  await ev(() => window.ctl.refresh());
  await settle();
  await page.click(`${PAT} [data-act="looks-done"]`);
  const goodLabel = await page.$eval(`${PAT} .plan-note label span`, (s) => s.textContent);
  await page.click(`${PAT} .plan-note [type="submit"]`);
  await settle();
  let steps = (await patCalls()).filter((x) => x[0] === 'step');
  check('Looks done with no note: tutor_step_by_token(check, null), "Checked: …" with Undo', goodLabel === "Say what's good about it (optional)"
    && same(steps[steps.length - 1], ['step', 's4', 'check', null]) && (await ev(() => window.patToasts)).includes('Checked: Outline with 3 main ideas'), JSON.stringify([goodLabel, steps]));
  await ev(() => window.patAction.onClick());
  await settle();
  steps = (await patCalls()).filter((x) => x[0] === 'step');
  check('Undo takes the check back (uncheck)', same(steps[steps.length - 1], ['step', 's4', 'uncheck', null]) && (await patText()).includes('Outline with 3 main ideas'), JSON.stringify(steps));
  await ev(() => { window.pat.capped = true; });
  await page.click(`${PAT} [data-act="looks-done"]`);
  await page.fill(`${PAT} .plan-note [name="text"]`, 'Clear outline. The third point is the strongest.');
  await page.click(`${PAT} .plan-note [type="submit"]`);
  await settle();
  steps = (await patCalls()).filter((x) => x[0] === 'step');
  check('Looks done with a note; past the week\'s cap: "This week\'s milestone points are used up."', same(steps[steps.length - 1], ['step', 's4', 'check', 'Clear outline. The third point is the strongest.'])
    && (await ev(() => window.patToasts)).includes("This week's milestone points are used up."), JSON.stringify(steps[steps.length - 1]));

  await page.click(`${PAT} [data-act="answer"]`);
  await page.fill(`${PAT} .plan-note [name="text"]`, 'Yes, a short title at the top.');
  await page.click(`${PAT} .plan-note [type="submit"]`);
  await settle();
  text = await patText();
  steps = (await patCalls()).filter((x) => x[0] === 'step');
  check('Answer: tutor_step_by_token(answer, the text), then "Answer: …" and Change', same(steps[steps.length - 1], ['step', 'q1', 'answer', 'Yes, a short title at the top.'])
    && text.includes('Answer: Yes, a short title at the top. Change'), text);

  // + Lesson: the add form, a new id, then the assignment's own screen and its plan.
  await page.click(`${PAT} a[href="#new/lesson"]`);
  await waitFor(`${PAT} .plan-afields`);
  text = await patText();
  const form = await page.$eval(`${PAT} .plan-afields`, (f) => ({ lesson: f.classList.contains('is-lesson'), kind: f.querySelector('[name="kind"]:checked').value, status: !!f.querySelector('[name="status"]'),
    min: f.querySelector('[name="due_date"]').min, shown: Array.from(f.querySelectorAll('.field > span')).filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.textContent) }));
  check('+ Lesson: a lesson form ("Do by", "Instructions for Jordan", the Live Text hint), from today, no status yet',
    form.lesson && form.kind === 'lesson' && !form.status && form.min === '2026-11-02' && form.shown.includes('Do by') && form.shown.includes('Instructions for Jordan')
    && !form.shown.includes('Due') && text.includes("To use a photo of the sheet, copy its text with your phone's Live Text and paste it here. Photos aren't sent anywhere."), JSON.stringify(form));
  await page.click(`${PAT} .plan-afields [type="submit"]`);
  check('no title: "Give it a title." and nothing sent', await page.$eval(`${PAT} .plan-afields .form-error`, (p) => p.textContent) === 'Give it a title.'
    && !(await patCalls()).some((x) => x[0] === 'assignment'));
  await page.fill(`${PAT} .plan-afields [name="title"]`, '  Fractions   review ');
  await page.fill(`${PAT} .plan-afields [name="subject"]`, 'Math');
  await page.fill(`${PAT} .plan-afields [name="due_date"]`, '2026-11-06');
  await page.fill(`${PAT} .plan-afields [name="details"]`, 'Page 41:\n\n\n\nodd numbers only.');
  await page.click(`${PAT} .plan-afields [type="submit"]`);
  await waitFor(`${PAT} .plan-editor[data-role="tutor"]`);
  const added = (await patCalls()).find((x) => x[0] === 'assignment');
  const newId = added && added[1].id;
  check('the lesson is added with a new id from the page, its text cleaned (lines kept)', !!added && UUID.test(newId) && same(Object.assign({}, added[1], { id: 'x' }),
    { id: 'x', kind: 'lesson', title: 'Fractions review', subject: 'Math', due_date: '2026-11-06', details: 'Page 41:\n\nodd numbers only.', stretch: null }), JSON.stringify(added));
  check('then its own screen opens (#a/<id>)', await ev(() => location.hash) === `#a/${newId}` && !!(await page.$(`${PAT} .plan-editor[data-role="tutor"]`)), await ev(() => location.hash));
  await page.click(`${PAT} [data-act="starter"]`);
  check('a lesson\'s guess is Practice', await page.$eval(`${PAT} .plan-chip.is-guess`, (b) => b.dataset.starter) === 'practice');
  await page.click(`${PAT} [data-starter="practice"]`);
  await settle();
  const planned = (await patCalls()).filter((x) => x[0] === 'plan');
  check('Practice: one block a day on his homework days up to Fri (Mon–Thu), the last a milestone, through tutor_plan_by_token at rev 0',
    planned.length === 1 && planned[0][1] === newId && planned[0][3] === 0 && planned[0][4] === false
    && same(planned[0][2].map((s) => [s.day, s.kind]), [['2026-11-02', 'step'], ['2026-11-03', 'step'], ['2026-11-04', 'step'], ['2026-11-05', 'milestone']]), JSON.stringify(planned));
  await page.click(`${PAT} [data-act="give"]`);
  await settle();
  text = await patText();
  check('Give Jordan this plan, from Pat: "On Jordan\'s My day since today · by you"', (await patCalls()).filter((x) => x[0] === 'plan')[1][4] === true
    && text.includes("On Jordan's My day since today · by you"), text.slice(-200));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${SHOTS}plan-tutor-assignment-1280.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}plan-tutor-assignment-1280-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  // Mark it done from the form.
  await page.selectOption(`${PAT} .plan-afields [name="status"]`, 'done');
  await page.click(`${PAT} .plan-afields [type="submit"]`);
  await settle();
  const edits = (await patCalls()).filter((x) => x[0] === 'assignment');
  check('the form saves the fields with the status (never a delete)', edits.length === 2 && edits[1][1].id === newId && edits[1][1].status === 'done' && edits[1][1].title === 'Fractions review',
    JSON.stringify(edits[1]));

  // Back to the list; the assignment Pat opens has its teacher's text in the form, not twice.
  await page.click(`${PAT} a.back`);
  await waitFor(`${PAT} [data-sec="assignments"]`);
  await page.click(`${PAT} a[href="#a/${A1}"]`);
  await waitFor(`${PAT} .plan-step`);
  const a1 = await page.$eval(PAT, (b) => ({ details: b.querySelector('[name="details"]').value, fold: !!b.querySelector('.plan-text'), rows: b.querySelectorAll('.plan-step').length,
    given: (b.querySelector('.plan-given') || {}).textContent, title: b.querySelector('h1').textContent }));
  check('an assignment: the teacher\'s text in its form (no second copy in the editor), its 9 steps, "since yesterday · by you"',
    a1.details === 'Make a poster about a river.' && !a1.fold && a1.rows === 9 && a1.given === "On Jordan's My day since yesterday · by you" && a1.title === 'Science project: river poster', JSON.stringify(a1));
  await page.setViewportSize({ width: 390, height: 844 });
  check('an assignment at 390px: nothing scrolls sideways', await ev(() => document.documentElement.scrollWidth) <= 390);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}plan-tutor-assignment-390-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.click(`${PAT} a.back`);
  await waitFor(`${PAT} [data-sec="assignments"]`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${SHOTS}plan-tutor-1280.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}plan-tutor-1280-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  check('Pat\'s page asked nothing of the network: every read and write went through its api', !requests.length, requests.join(' '));
  const viewCalls = (await patCalls()).filter((x) => x[0] === 'view');
  check('reads are tutor_view_by_token(p_assignment, \'all\'): the list with null, an assignment with its id', viewCalls.every((x) => x[2] === 'all')
    && viewCalls.some((x) => x[1] === null) && viewCalls.some((x) => x[1] === A1), JSON.stringify(viewCalls.slice(0, 4)));

  // A link that no longer works, one the database doesn't know yet, no connection, Spanish.
  await ev(() => { window.pat.mode = 'gone'; return window.ctl.refresh(); });
  await settle();
  check('a null answer: "This link no longer works. Ask the family for a new one." and onGone',
    (await patText()) === 'This link no longer works. Ask the family for a new one.' && await ev(() => window.patGone) === 1, await patText());
  await ev(({ A3 }) => {
    const box = document.getElementById('pat');
    window.ctl.stop();
    window.pat.mode = 'old';
    window.ctl = window.HomePlan.tutor(box, { api: window.pat.api, lang: 'es', toast: () => {} });
    return window.ctl.show('');
  }, { A3 });
  await settle();
  check('before 0005 (PGRST202): "This link doesn\'t work yet." in the page\'s language', (await patText()) === 'Este enlace todavía no funciona.', await patText());
  await ev(() => { window.pat.mode = 'down'; return window.ctl.show(''); });
  await settle();
  check('no connection: the words and Try again', (await patText()) === 'No se puede conectar con Home Hub. Revisa tu conexión a internet e inténtalo de nuevo. Intentar de nuevo', await patText());
  await ev(() => {
    Object.assign(window.pat, { mode: 'ok', capped: false });
    window.pat.view.language = 'es';
    window.pat.view.to_check = [{ step_id: 's4', assignment: 'Science project', title: 'Outline with 3 main ideas', done_looks_like: null, day: '2026-11-04', done_day: '2026-10-28' }];
  });
  await page.click(`${PAT} [data-act="retry"]`);
  await settle();
  text = await patText();
  check('Try again, and the link in Spanish (its language)', ['Tarea · Jordan', 'Hola, Pat Lee, tutor · El enlace vence el 30 abr', 'Empieza por lo que hizo.', 'Por revisar', 'Para hablar',
    'Preguntas', 'Trabajos', 'Su semana', 'Últimos 14 días', 'Se ve terminado', 'Todavía no', '+ Lección', 'Los pasos llevan unas 1,3 veces el tiempo previsto', 'para el vie 13 nov',
    'mar 30 libres Ocupado 17:00'].every((x) => text.toLowerCase().includes(x.toLowerCase())), text);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}plan-tutor-390-es-dark.png`, fullPage: true });
  await ev(() => window.ctl.stop());

  await context.close();
  await browser.close();
  await server.close();
  if (errors.length) check('no page errors', false, errors.join(' | '));
  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`\nCRASH: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
