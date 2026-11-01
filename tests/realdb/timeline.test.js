// The timelines (docs/v1.3-homework.md §21, no migration) against the REAL database (tests/realdb/run.sh): a
// two-week assignment with two milestones, given, drawn from the real answers. Its own copy of the database, on
// Mon Nov 2 at 9:00am in New York (after the clocks went back).
//   setup    Alex (through the API, as the page does it) turns homework on for Jordan, sets his homework time (Mon–Thu
//            4:30–5:15), adds the essay due Mon Nov 16 and saves its plan of eight steps with their days (two
//            milestones: Outline on Wed Nov 4, Full draft on Wed Nov 11; the turn-in on the due date) and gives it
//            (save_homework_plan); the database keeps every day; Jordan ticks the first step (step_by_token).
//   parents  Alex's Homework page: Next 3 weeks between Assignments and lessons and This week, the essay's row from
//            the rows the page reads (its bar from today to the due date, 1 of 8 done, the two milestones as diamonds
//            on their days, the due date a flag, its label for screen readers), a link to its page; there, its chart
//            above the plan editor (Mon Nov 2 to Mon Nov 16, a row per phase, the done step filled, Fri–Sun without
//            homework time shaded from homework_week's real rows); a phone with no sideways scroll; no request fails.
//   jordan   his My day (homework_by_token's real answer): under Tonight, "Your path" with the essay's path (its name a
//            link to #plan/<id>; "Next flag: Outline · Wed (2 days)", 14 dots from Today, flags on the two milestones'
//            days, "… due Mon Nov 16"; no points, as his view carries none); #plan/<id> with the path at the top; a phone
//            (dark) with no sideways scroll; no request fails.
//   pat      Pat's link (tutor_view_by_token's real answers; the link made by Alex with save_tutor_link in setup): Next 3
//            weeks at the top of Assignments (the essay's bar from today, as Pat's list has no step days, 1 of 8 done, its
//            next milestone a diamond, the due date a flag, a link to #a/<id>); there, the chart above the editor from the
//            assignment's real steps and Pat's week (Fri–Sun shaded); a phone with no sideways scroll; no request fails.
// Screenshots: tests/e2e/shots/realdb-timeline-*.png (and TIMELINE_SHOTS, when set).
const fs = require('fs');
const { setup } = require('./lib');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MON = '2026-11-02';
const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;   // New York, standard time
const TITLE = 'Essay: a river\'s journey';
// The essay's plan: [kind, title, minutes, day].
const PLAN = [
  ['start', 'Copy the requirements into your notes', 10, '2026-11-02'],
  ['step', 'Find 3 sources', 20, '2026-11-03'],
  ['milestone', 'Outline', 20, '2026-11-04'],
  ['step', 'Draft the first half', 20, '2026-11-09'],
  ['step', 'Draft the second half', 20, '2026-11-10'],
  ['milestone', 'Full draft', 20, '2026-11-11'],
  ['check', 'Check it against the instructions', 15, '2026-11-12'],
  ['turn_in', 'Turn it in', 5, '2026-11-16'],
];

(async () => {
  const h = await setup('timeline');
  const { check, flow, sql, open, go, tc, until, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || ''}` : ''}`);
  const as = async (email, p, body, headers) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', authorization: `Bearer ${token}` }, headers), body: JSON.stringify(body) });
  };
  const anonRpc = (name, args) => h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const TL_SHOTS = process.env.TIMELINE_SHOTS ? `${process.env.TIMELINE_SHOTS.replace(/\/+$/, '')}/` : null;
  if (TL_SHOTS) fs.mkdirSync(TL_SHOTS, { recursive: true });
  // What the page drew in a timeline (sel): its head of days and its rows (as tests/e2e/homework.test.js reads them).
  const readTl = (page, sel) => page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const txt = (el, s) => { const x = el && (s ? el.querySelector(s) : el); return x ? x.textContent.replace(/\s+/g, ' ').trim() : null; };
    const col = (el) => (el ? el.style.gridColumn || null : null);
    const flags = (el) => ['is-done', 'is-behind', 'is-late', 'is-past'].filter((c) => el.classList.contains(c)).map((c) => ` ${c.slice(3)}`).join('');
    const head = Array.from(root.querySelectorAll('.plan-tl-hday'));
    const idx = (cls) => head.map((d, i) => (d.classList.contains(cls) ? i : -1)).filter((i) => i >= 0);
    return {
      label: root.getAttribute('aria-label'), days: head.length, today: idx('is-today'), mon: idx('is-mon'), off: idx('is-off'), due: idx('is-due'),
      rows: Array.from(root.querySelectorAll('.plan-tl-row')).map((r) => {
        const a = r.querySelector('a.plan-tl-name');
        const bar = r.querySelector('.plan-tl-bar');
        const fill = r.querySelector('.plan-tl-fill');
        return {
          id: r.dataset.id || null, href: a ? a.getAttribute('href') : null, title: txt(r, '.plan-tl-title'), sub: txt(r, '.plan-tl-sub'),
          sr: txt(r, '.plan-tl-name > .sr-only'), bar: bar ? `${col(bar)}${flags(bar)}` : null, fill: fill ? fill.style.width : null,
          ms: Array.from(r.querySelectorAll('.plan-tl-ms')).map((m) => `${col(m)}${flags(m)}`), due: col(r.querySelector('.plan-tl-due')),
          steps: Array.from(r.querySelectorAll('.plan-tl-step')).map((x) => `${col(x.closest('.plan-tl-slot'))}:${txt(x, '.plan-tl-min')}${flags(x)}`),
        };
      }),
    };
  }, sel);
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  await h.setClock(at(MON, '09:00'));
  let essay = null;   // the essay's id
  let pat = null;     // Pat's link's token
  await flow('setup', async () => {
    const on = await as('alex@example.com', '/rest/v1/rpc/save_homework_kid', { p_kid: P.jordan.id, p_active: true });
    const time = await as('alex@example.com', '/rest/v1/rpc/add_homework_time', { p_kid: P.jordan.id, p_weekdays: [1, 2, 3, 4], p_start: '16:30', p_end: '17:15' });
    const made = await as('alex@example.com', '/rest/v1/assignments', { kid_id: P.jordan.id, kind: 'assignment', title: TITLE, subject: 'English', due_date: '2026-11-16',
      details: 'Write about one river from its source to the sea.' }, { prefer: 'return=representation' });
    essay = made.body && made.body[0] && made.body[0].id;
    const saved = await as('alex@example.com', '/rest/v1/rpc/save_homework_plan', { p_assignment: essay, p_rev: 0, p_give: true,
      p_steps: PLAN.map(([kind, title, minutes, day]) => ({ kind, title, done_looks_like: null, minutes, day, source: 'typed' })) });
    const steps = await sql(`select id, kind, title, minutes, day from homework_steps where assignment_id = '${essay}' order by pos`);
    const a = await one(`select given_at is not null as given, given_by, status from assignments where id = '${essay}'`);
    check('setup: homework on, his homework time, the essay (due Mon Nov 16) and its plan of eight steps saved and given by Alex, every day kept by the database',
      [200, 204].includes(on.status) && time.status === 200 && made.status === 201 && saved.status === 200 && !!a && a.given === 't' && a.given_by === 'alex@example.com'
      && same(steps.map((s) => [s.kind, s.title, Number(s.minutes), s.day]), PLAN), [on.status, time.status, made.status, saved.status, saved.body && saved.body.message, a, steps.map((s) => s.day)]);
    const tick = await anonRpc('step_by_token', { p_token: P.jordan.day_token, p_step: steps[0] && steps[0].id, p_action: 'done', p_key: '9e1c0000-0000-4000-8000-000000000001' });
    check('setup: Jordan ticks the first step on his My day (step_by_token)', tick.status === 200 && !!(await one(`select done_at from homework_steps where id = '${steps[0] && steps[0].id}'`)).done_at,
      [tick.status, tick.body && tick.body.message]);
    const link = await as('alex@example.com', '/rest/v1/rpc/save_tutor_link', { p_link: null, p_kid: P.jordan.id, p_label: 'Pat Lee, tutor', p_language: 'en',
      p_expires_on: null, p_can_ai: false, p_active: true });
    pat = link.status === 200 ? (await one(`select token from tutor_links where id = '${link.body}'`) || {}).token : null;
    check('setup: Alex makes Pat\'s link (save_tutor_link)', /^[0-9a-f]{32}$/.test(pat || ''), [link.status, link.body]);
  });

  await flow('parents', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'timeline-alex' });
    await page.waitForSelector('[data-sec="timeline"] .plan-tl-overview', { timeout: 8000 });
    const secs = await page.$$eval('#main section.hw-sec', (ss) => ss.map((s) => s.dataset.sec));
    check('parents: Next 3 weeks between Assignments and lessons and This week', secs.indexOf('timeline') === secs.indexOf('assignments') + 1 && secs.indexOf('week') === secs.indexOf('timeline') + 1
      && (await tc(page, '[data-sec="timeline"] > .sec-head')) === 'Next 3 weeks', secs);
    const ov = await readTl(page, '[data-sec="timeline"] .plan-tl-overview');
    const row = ov ? ov.rows[0] || {} : {};
    check('parents: the overview, 21 days from today ("Open assignments, Mon Nov 2 to Sun Nov 22"), today first, each week from its Monday',
      !!ov && ov.label === 'Open assignments, Mon Nov 2 to Sun Nov 22' && ov.days === 21 && same(ov.today, [0]) && same(ov.mon, [0, 7, 14]), ov && [ov.label, ov.days, ov.today, ov.mon]);
    check('parents: the essay\'s row from the real rows: from today to Mon Nov 16, 1 of 8 done filled, Outline and Full draft as diamonds on their days, the due date a flag, a link to its page',
      !!ov && ov.rows.length === 1 && row.title === TITLE && row.href === `#/homework/${essay}` && row.bar === '1 / 16' && row.fill === '12.5%' && same(row.ms, ['3', '10'])
      && row.due === '15' && row.sub === 'English · 1 of 8 · due Mon Nov 16', JSON.stringify(row));
    check('parents: its label for screen readers', row.sr === 'Essay: a river\'s journey · steps from Mon Nov 2 · milestone Outline Wed Nov 4 · milestone Full draft Wed Nov 11 · due Mon Nov 16 · 1 of 8 steps done',
      row.sr);
    await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
    await shot(page, 'timeline-parents-list');
    if (TL_SHOTS) await page.locator('[data-sec="timeline"]').screenshot({ path: `${TL_SHOTS}realdb-next-3-weeks-1280.png` });
    // Its link opens the essay, with its chart above the editor.
    await page.click(`[data-sec="timeline"] .plan-tl-row[data-id="${essay}"] a.plan-tl-name`);
    await until(async () => (await page.evaluate(() => location.hash)) === `#/homework/${essay}` && !!(await page.$('.hw-a [data-ref="chart"] .plan-tl-chart')), 6000);
    const ch = await readTl(page, '.hw-a [data-ref="chart"] .plan-tl-chart');
    check('parents: the row\'s link opens the essay, its chart above the plan editor', !!ch
      && await page.evaluate(() => !!(document.querySelector('[data-ref="chart"]').compareDocumentPosition(document.querySelector('[data-ref="editor"] .plan-editor')) & Node.DOCUMENT_POSITION_FOLLOWING)));
    check('parents: the chart, Mon Nov 2 to Mon Nov 16 (15 days), today first, Fri–Sun without homework time shaded (homework_week\'s rows), the due day marked',
      !!ch && ch.label === 'Plan by day, Mon Nov 2 to Mon Nov 16' && ch.days === 15 && same(ch.today, [0]) && same(ch.mon, [0, 7, 14]) && same(ch.off, [4, 5, 6, 11, 12, 13])
      && same(ch.due, [14]), ch && [ch.label, ch.days, ch.today, ch.mon, ch.off, ch.due]);
    check('parents: a row per phase (Outline, Full draft, Check and turn in), each step a block on its day with its minutes, the ticked one filled',
      !!ch && same(ch.rows.map((r) => [r.title, r.sub, r.steps]), [['Outline', '3 steps · 50 min', ['1:10 done', '2:20', '3:20']],
        ['Full draft', '3 steps · 1 h', ['8:20', '9:20', '10:20']], ['Check and turn in', '2 steps · 20 min', ['11:15', '15:5']]]), JSON.stringify(ch && ch.rows.map((r) => [r.title, r.sub, r.steps])));
    await shot(page, 'timeline-parents-assignment');
    if (TL_SHOTS) await page.locator('.hw-a [data-ref="chart"]').screenshot({ path: `${TL_SHOTS}realdb-chart-1280.png` });
    check('parents: no request failed', !(await failures()).length, await failures());
    await context.close();
    // A phone: both with no sideways page scroll.
    const ph = await open({ email: 'alex@example.com', phone: true, dark: true, path: '/#/homework', label: 'timeline-alex-phone' });
    await ph.page.waitForSelector('[data-sec="timeline"] .plan-tl-overview', { timeout: 8000 });
    const listFits = await noSideScroll(ph.page);
    if (TL_SHOTS) await ph.page.locator('[data-sec="timeline"]').screenshot({ path: `${TL_SHOTS}realdb-next-3-weeks-390-dark.png` });
    await go(ph.page, `#/homework/${essay}`);
    await ph.page.waitForSelector('.hw-a [data-ref="chart"] .plan-tl-chart', { timeout: 8000 });
    check('parents: on a phone (dark), Next 3 weeks and the chart with no sideways page scroll', listFits && await noSideScroll(ph.page));
    await shot(ph.page, 'timeline-parents-phone');
    if (TL_SHOTS) await ph.page.locator('.hw-a [data-ref="chart"]').screenshot({ path: `${TL_SHOTS}realdb-chart-390-dark.png` });
    await ph.context.close();
  });

  // What My day drew: each path with its link, its line, its day names and which days have a flag.
  const readPaths = (page, sel) => page.$$eval(sel, (ps) => ps.map((p) => {
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const a = p.querySelector('a.hw-path-title');
    const days = Array.from(p.querySelectorAll('.plan-path-day'));
    return { id: p.dataset.asg || null, href: a ? a.getAttribute('href') : null, title: txt(a), line: txt(p.querySelector('.plan-path-line')),
      names: days.map((x) => txt(x.querySelector('.plan-path-name'))), flags: days.map((x, i) => (x.querySelector('.plan-path-flag') ? i : -1)).filter((i) => i >= 0),
      fold: txt(p.querySelector('.plan-path-fold')), pts: !!p.querySelector('.plan-path-pts') };
  }));

  await flow('jordan', async () => {
    await h.mark();
    const { page, context } = await open({ phone: true, dark: true, path: `/day.html?t=${P.jordan.day_token}#homework`, label: 'timeline-jordan' });
    await page.waitForSelector('.hw-paths .hw-path', { timeout: 8000 });
    check('jordan: "Your path" under Tonight (Tonight first), before Due soon', (await tc(page, '#hw-paths-h')) === 'Your path'
      && await page.evaluate(() => { const t = document.querySelector('.hw-tonight'); const p = document.querySelector('.hw-paths'); const d = document.querySelector('.hw-due');
        return !!(t && p && d && (t.compareDocumentPosition(p) & 4) && (p.compareDocumentPosition(d) & 4)); }));
    const paths = await readPaths(page, '.hw-paths .hw-path');
    const p = paths[0] || {};
    check('jordan: the essay\'s path from his real view: its name a link to its plan, "Next flag: Outline · Wed (2 days)", 14 dots from Today, flags on Wed and the next Wed, "… due Mon Nov 16"',
      paths.length === 1 && p.id === essay && p.href === `#plan/${essay}` && p.title === `${TITLE} ›` && p.line === 'Next flag: Outline · Wed (2 days)'
      && p.names.length === 14 && p.names[0] === 'Today' && same(p.flags, [2, 9]) && p.fold === '… due Mon Nov 16', JSON.stringify(paths));
    check('jordan: no points in the line (his view carries no milestone\'s value)', !!p.line && !p.pts && !/\+\d|points? now/i.test(p.line), p.line);
    check('jordan: on a phone (dark), #homework with no sideways page scroll', await noSideScroll(page));
    await shot(page, 'timeline-jordan-homework');
    if (TL_SHOTS) await page.locator('.hw-paths').screenshot({ path: `${TL_SHOTS}realdb-myday-path-390-dark.png` });
    await page.click(`.hw-path[data-asg="${essay}"] a.hw-path-title`);
    await until(async () => (await page.evaluate(() => location.hash)) === `#plan/${essay}` && !!(await page.$('.hw-plan .plan-editor')), 6000);
    const top = await readPaths(page, '.hw-plan-path');
    check('jordan: its link opens his plan, the path at the top', top.length === 1 && top[0].line === 'Next flag: Outline · Wed (2 days)' && top[0].names.length === 14
      && await page.evaluate(() => { const x = document.querySelector('.hw-plan-path .plan-path'); const e = document.querySelector('.hw-plan .plan-editor'); return !!(x && e && (x.compareDocumentPosition(e) & 4)); })
      && await noSideScroll(page), JSON.stringify(top));
    await shot(page, 'timeline-jordan-plan');
    if (TL_SHOTS) await page.screenshot({ path: `${TL_SHOTS}realdb-myday-plan-390-dark.png` });
    check('jordan: no request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('pat', async () => {
    await h.mark();
    const { page, context } = await open({ path: `/day.html?h=${pat}`, label: 'timeline-pat' });
    await page.waitForSelector('[data-sec="assignments"] .plan-tl-overview', { timeout: 8000 });
    check('pat: Next 3 weeks at the top of Assignments', (await tc(page, '[data-sec="assignments"] > .plan-tl-box > .plan-tl-h')) === 'Next 3 weeks'
      && await page.evaluate(() => document.querySelector('[data-sec="assignments"]').children[1].classList.contains('plan-tl-box')));
    const ov = await readTl(page, '[data-sec="assignments"] .plan-tl-overview');
    const row = ov ? ov.rows[0] || {} : {};
    check('pat: the overview from the link\'s real answer, 21 days from today, the essay\'s row: from today (no step days on Pat\'s list) to Mon Nov 16, 1 of 8 done, Outline a diamond on Wed, the due date a flag, a link to its screen',
      !!ov && ov.label === 'Open assignments, Mon Nov 2 to Sun Nov 22' && ov.days === 21 && ov.rows.length === 1 && row.href === `#a/${essay}` && row.bar === '1 / 16'
      && row.fill === '12.5%' && same(row.ms, ['3']) && row.due === '15' && row.sr === 'Essay: a river\'s journey · milestone Outline Wed Nov 4 · due Mon Nov 16 · 1 of 8 steps done',
      JSON.stringify(ov && [ov.label, ov.days, row]));
    if (TL_SHOTS) await page.locator('[data-sec="assignments"]').screenshot({ path: `${TL_SHOTS}realdb-tutor-next-3-weeks-1280.png` });
    await page.click(`[data-sec="assignments"] .plan-tl-row[data-id="${essay}"] a.plan-tl-name`);
    await until(async () => (await page.evaluate(() => location.hash)) === `#a/${essay}` && !!(await page.$('.plan-tutor-a [data-ref="chart"] .plan-tl-chart')), 6000);
    const ch = await readTl(page, '.plan-tutor-a [data-ref="chart"] .plan-tl-chart');
    check('pat: the row opens the essay; its chart above the editor, Mon Nov 2 to Mon Nov 16, Fri–Sun shaded from his week on the link, a row per phase from the real steps',
      !!ch && ch.label === 'Plan by day, Mon Nov 2 to Mon Nov 16' && ch.days === 15 && same(ch.today, [0]) && same(ch.off, [4, 5, 6, 11, 12, 13]) && same(ch.due, [14])
      && same(ch.rows.map((r) => [r.title, r.steps]), [['Outline', ['1:10 done', '2:20', '3:20']], ['Full draft', ['8:20', '9:20', '10:20']], ['Check and turn in', ['11:15', '15:5']]])
      && await page.evaluate(() => { const c = document.querySelector('.plan-tutor-a [data-ref="chart"]'); const e = document.querySelector('.plan-tutor-a [data-ref="editor"] .plan-editor');
        return !!(c && e && (c.compareDocumentPosition(e) & 4)); }), JSON.stringify(ch && [ch.label, ch.days, ch.off, ch.rows.map((r) => [r.title, r.steps])]));
    await shot(page, 'timeline-pat-assignment');
    if (TL_SHOTS) await page.locator('.plan-tutor-a [data-ref="chart"]').screenshot({ path: `${TL_SHOTS}realdb-tutor-chart-1280.png` });
    check('pat: no request failed', !(await failures()).length, await failures());
    await context.close();
    const ph = await open({ phone: true, path: `/day.html?h=${pat}`, label: 'timeline-pat-phone' });
    await ph.page.waitForSelector('[data-sec="assignments"] .plan-tl-overview', { timeout: 8000 });
    const listFits = await noSideScroll(ph.page);
    await ph.page.evaluate((id) => { location.hash = `#a/${id}`; }, essay);
    await until(async () => !!(await ph.page.$('.plan-tutor-a [data-ref="chart"] .plan-tl-chart')), 6000);
    check('pat: on a phone, Next 3 weeks and the chart with no sideways page scroll', listFits && await noSideScroll(ph.page));
    await shot(ph.page, 'timeline-pat-phone');
    await ph.context.close();
  });

  await h.finish();
})().catch((err) => {
  console.log(`FAIL  timeline: ${String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ')}`);
  process.exit(1);
});
