// The school feed (migration 0006, docs/v1.3-homework.md §11, §12, §16.4) against the REAL database: the site and
// hub-jobs go live before 0006 is applied, so they are checked first on the database as it is live before it (the v5
// template: schema.sql, the v1 household, migrations 0002 to 0005, the v2 household), then the owner pastes 0006
// while the hub runs, and the flows go on on the real 0006 with the real hub-jobs handler reading a fake school site
// (lib.js's fakeSchool on academy.school.example, a made-up host; the database's host suffix is set to match):
//   schema 5           Homework on for Jordan. The Homework page and his My day work and never ask for a school table
//                      or function; hub-jobs' school action answers 503 {stop: 'no_schema'}.
//   0006 on a hub      Applied in one go: every My day answer and his homework view exactly as before; a second paste
//                      is refused.
//   School links       Alex pastes the Assignments link (webcal://): the database keeps it where no API role reads it;
//                      the page shows only the host and its last 4 characters. Check now: hub-jobs reads the fake
//                      site (Blackbaud's all-day forms, a description, the class in the title); the status card; Looks right.
//   New from school    Jordan's card and list; Quick on the one due Wednesday (one step, placed and given), Plan with Pat
//                      on the lab report (an assignment from school with no plan and the teacher's text), Hide on the
//                      quiz; Alex shows it again.
//   The school changes Two more reads: the planned one's date moved is marked, never moved; the lab report gone from
//                      the site is marked, never deleted; both on the parents' page and Jordan's Due soon.
// Run through tests/realdb/run.sh (its own copy of the v5 template database).
const { setup, SCHOOL_CALLS } = require('./lib');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MON = '2026-11-02';
const SECRET = 'SECRETZ7q0123';
const LINK = `academy.school.example/podium/feed/iCal.aspx?z=${SECRET}`;
// The feed as Blackbaud writes it, with made-up classes: VALUE=DATE days, a midnight-to-midnight "all-day" item, a
// description, the class before the first ": ".
const ics = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//School calendar//EN', 'X-WR-CALNAME:Jordan Example: Assignments',
  ...events.flatMap((e) => ['BEGIN:VEVENT', `UID:${e.uid}@academy.school.example`, ...e.lines, `SUMMARY:${e.summary}`, ...(e.description ? [`DESCRIPTION:${e.description}`] : []), 'END:VEVENT']),
  'END:VCALENDAR', ''].join('\r\n');
const CH5 = { uid: 'asg-1001', summary: 'History - 7 (B): Read chapter 5', lines: ['DTSTART;VALUE=DATE:20261104', 'DTEND;VALUE=DATE:20261105'] };
const LAB = { uid: 'asg-1002', summary: 'Biology - 7 (A): Lab report', lines: ['DTSTART:20261120T000000', 'DTEND:20261120T000000'],
  description: 'Write up the bean plant lab: hypothesis\\, method\\, results.' };
const QUIZ = { uid: 'asg-1003', summary: 'Geography - 7: Map quiz', lines: ['DTSTART;VALUE=DATE:20261109', 'DTEND;VALUE=DATE:20261110'] };
const ESSAY = { uid: 'asg-1004', summary: 'English - 7: Essay outline', lines: ['DTSTART;VALUE=DATE:20261112', 'DTEND;VALUE=DATE:20261113'] };

(async () => {
  const h = await setup('school', { v5: true });
  const { check, flow, sql, open, go, tc, texts, lastToast, until, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || r.error.error || ''}` : ''}`);
  const anonRpc = (name, args) => h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };
  const ok = (r) => r.status >= 200 && r.status < 300;
  const toastIs = async (page, re) => until(async () => re.test(await lastToast(page)), 6000);
  const FEED = (k) => `[data-row="school"] .hw-feed[data-feed="${k}"]`;
  const item = (title) => one(`select i.id, i.title, i.subject, i.details, i.first_day, i.last_day, i.due_date, i.hidden, i.made_at, i.assignment_id, i.gone_at, i.missing
    from school_items i where i.title = '${title}'`);

  // Mon Nov 2, 4:00pm in New York (standard time from Nov 1): before his homework time (4:30–5:15).
  await h.setClock(`${MON}T21:00:00Z`);

  await flow('schema 5', async () => {
    const v = await one('select public.hub_schema_version() as v');
    check('v5 db: the database is schema 5 (migration 0005, no 0006)', v.v === '5' && !(await one("select to_regclass('public.school_feeds') as t")).t, v);
    const r1 = await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
    const r2 = await rpcAs('alex@example.com', 'add_homework_time', { p_kid: P.jordan.id, p_weekdays: [1, 2, 3, 4], p_start: '16:30', p_end: '17:15' });
    await sql(`insert into rewards (kid_id, title, cost, sort_order, created_by) values
      ('${P.jordan.id}', '15 minutes of extra game time', 15, 1, 'alex@example.com'), ('${P.jordan.id}', 'Choose Friday''s dinner', 60, 2, 'alex@example.com'),
      ('${P.jordan.id}', 'A new book', 150, 3, 'alex@example.com')`);
    check('v5 db: homework on for Jordan, with his homework time (Mon–Thu 4:30–5:15)', ok(r1) && ok(r2), { r1: r1.status, r2: r2.status });
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'school-v5-alex' });
    await until(async () => !!(await page.$('[data-sec="switches"]')), 8000);
    check('v5 db: the Homework page on schema 5 has its switches and no School links', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 5
      && !!(await page.$('[data-row="links"]')) && !(await page.$('[data-row="school"]')), await tc(page, '[data-sec="switches"]'));
    await context.close();
    const jordan = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}#homework`, label: 'school-v5-jordan' });
    await until(async () => !!(await jordan.page.$('.hw-tonight')), 8000);
    check('v5 db: his #homework on schema 5: no New from school', !!(await jordan.page.$('.hw-tonight')) && !(await jordan.page.$('.hw-school')));
    await jordan.context.close();
    const reqs = await h.requests();
    check('v5 db: no page asks for a school table or function', !reqs.some((r) => SCHOOL_CALLS.test(r.path)), reqs.filter((r) => SCHOOL_CALLS.test(r.path)).map((r) => r.path));
    const f = await failures();
    check('v5 db: no API request failed', !f.length, f);
    const job = await h.hubJobsAs('alex@example.com', { action: 'school' });
    check('v5 db: hub-jobs\' school action (Check now) before 0006 answers 503 {stop: no_schema}, and reads nothing', job.status === 503 && job.body && job.body.stop === 'no_schema'
      && !h.school.requests.length, job);
  });

  await flow('0006 on a running hub', async () => {
    const capture = async () => {
      const out = { days: {} };
      for (const p of await sql('select name, day_token from people where active and day_token is not null order by name')) {
        out.days[p.name] = (await anonRpc('get_person_day', { p_token: p.day_token })).body;
      }
      // server_now is the server's own clock at the answer (the timer's), not the household's pinned one: left out.
      out.homework = (await anonRpc('homework_by_token', { p_token: P.jordan.day_token })).body;
      if (out.homework) delete out.homework.server_now;
      return out;
    };
    const before = await capture();
    check('before 0006: every My day answers, and Jordan\'s homework view', Object.values(before.days).every((d) => !!d && !!d.person) && !!before.homework && !!before.homework.me
      && !!before.days['Jordan Example'].homework, Object.keys(before.days));
    const m = await h.migrate('supabase/migrations/0006_homework_school.sql');
    const v = await one('select public.hub_schema_version() as v');
    check('0006 applies in one go, in its own session, and the schema version is 6', !m.error && v.v === '6' && !!(await one("select to_regclass('public.school_feeds') as t")).t, m.error || v);
    const after = await capture();
    check('after 0006, with no school link: every My day answer (get_person_day) is exactly as before', same(after.days, before.days),
      { before: JSON.stringify(before.days).slice(0, 200), after: JSON.stringify(after.days).slice(0, 200) });
    check('... and his homework view (no from_school key, no school marks; its server_now aside) is exactly as before', same(after.homework, before.homework) && !('from_school' in after.homework),
      Object.keys(after.homework).filter((k) => !same(after.homework[k], before.homework[k])).map((k) => `${k}: ${JSON.stringify(before.homework[k]).slice(0, 150)} → ${JSON.stringify(after.homework[k]).slice(0, 150)}`));
    const again = await h.migrate('supabase/migrations/0006_homework_school.sql');
    check('a second paste of 0006 is refused ("already installed"), and nothing changes', !!again.error && /already installed/.test(again.error.message || again.error)
      && (await one('select public.hub_schema_version() as v')).v === '6', again.error);
    // The made-up school's host, in place of Blackbaud's (the database tests do the same).
    await sql("create or replace function private.school_host_suffix() returns text language sql immutable set search_path = '' as $$ select '.school.example' $$");
  });

  let feedId = null;
  await flow('school links', async () => {
    h.school.serve(SECRET, ics([CH5, LAB, QUIZ]));
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'school-alex' });
    await until(async () => !!(await page.$('[data-row="school"] .hw-feed')), 8000);
    check('School links on the next load: Assignments, Schedule and Games/Practices, each Not added', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 6
      && same(await texts(page, `${FEED('assignments')} .hw-feed-state, ${FEED('schedule')} .hw-feed-state, ${FEED('games')} .hw-feed-state`), ['Not added', 'Not added', 'Not added']),
      await tc(page, '[data-row="school"]'));
    await page.click(`${FEED('assignments')} [data-act="school-add"]`);
    await page.fill(`${FEED('assignments')} input[name="url"]`, `webcal://${LINK}`);
    await page.click(`${FEED('assignments')} form[data-form="school"] button[type="submit"]`);
    await toastIs(page, /^Assignments link saved/);
    const f = await one(`select f.id, f.kind, f.host, f.url_end, f.checked, f.next_at is not null as due, u.url from school_feeds f join private.school_feed_urls u on u.feed_id = f.id
      where f.kid_id = '${P.jordan.id}'`);
    feedId = f && f.id;
    check('Add link: set_school_feed keeps the link as https:// in private.school_feed_urls; school_feeds has only its host and last 4 characters, due at once',
      !!f && same([f.kind, f.host, f.url_end, f.checked, f.due, f.url], ['assignments', 'academy.school.example', '0123', 'f', 't', `https://${LINK}`]), f);
    check('... the page shows "academy.school.example …0123", never the link', (await tc(page, `${FEED('assignments')} .hw-feed-link`)) === 'academy.school.example …0123'
      && !(await page.content()).includes(SECRET), await tc(page, FEED('assignments')));
    const asMember = await rpcAs('alex@example.com', 'school_feed_status', { p_kid: P.jordan.id });
    check('... and school_feed_status, the status card, carries no address', ok(asMember) && !JSON.stringify(asMember.body).includes(SECRET) && asMember.body.feeds.length === 1, asMember.body);

    // Check now: the real hub-jobs, as Alex, reading the fake school site.
    await page.click('[data-row="school"] [data-act="school-now"]');
    await toastIs(page, /^Checked/);
    check('Check now: hub-jobs reads the link once, as https with redirects handled by hand: "Checked 1 link · 3 items"', (await lastToast(page)) === 'Checked 1 link · 3 items'
      && same(h.school.requests.map((r) => [r.url, r.redirect]), [[`https://${LINK}`, 'manual']]), { toast: await lastToast(page), requests: h.school.requests });
    const items = await sql(`select title, subject, first_day, last_day, due_date, details from school_items where feed_id = '${feedId}' order by due_date`);
    check('the items as the school wrote them: the class from the title, Blackbaud\'s all-day forms as one day, the description kept',
      same(items.map((i) => [i.title, i.subject, i.first_day, i.last_day, i.due_date]), [['Read chapter 5', 'History', '2026-11-04', '2026-11-04', '2026-11-04'],
        ['Map quiz', 'Geography', '2026-11-09', '2026-11-09', '2026-11-09'], ['Lab report', 'Biology', '2026-11-20', '2026-11-20', '2026-11-20']])
      && items[2].details === 'Write up the bean plant lab: hypothesis, method, results.' && !items[0].details, items);
    await until(async () => /Last read/.test(await tc(page, `${FEED('assignments')} .hw-feed-state`)));
    check('the status: "Last read today 4:00pm · 3 items"; Check the dates with the 3 items', (await tc(page, `${FEED('assignments')} .hw-feed-state`)) === 'Last read today 4:00pm · 3 items'
      && same(await texts(page, '[data-ref="school-check"] .hw-school-items li'), ['History · Read chapter 5 · due Wed Nov 4', 'Geography · Map quiz · due Mon Nov 9', 'Biology · Lab report · due Fri Nov 20']),
      await tc(page, '[data-row="school"]'));
    const unchecked = (await anonRpc('homework_by_token', { p_token: P.jordan.day_token })).body;
    check('until a parent answers the check, nothing from the link reaches Jordan (no from_school)', !!unchecked && !('from_school' in unchecked), Object.keys(unchecked || {}));
    await page.click('[data-ref="school-check"] [data-act="school-dates"][data-rule="end"][data-shift="0"]');
    await toastIs(page, /^Dates checked/);
    const fc = await one(`select checked, date_rule, date_shift from school_feeds where id = '${feedId}'`);
    check('Looks right: check_school_feed(the link, end, 0); the link checked', same(fc, { checked: 't', date_rule: 'end', date_shift: '0' }) && !(await page.$('[data-ref="school-check"]')), fc);
    await shot(page, 'school-links');
    const fl = await failures();
    check('school links: no API request failed', !fl.length, fl);
    await context.close();
  });

  await flow('new from school', async () => {
    await h.mark();
    const { page, context } = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}`, label: 'school-jordan' });
    await until(async () => !!(await page.$('.hw-card')), 8000);
    check('his card: "New from school: 3 ›"', (await tc(page, '.hw-card .hw-card-school')) === 'New from school: 3 ›', await tc(page, '.hw-card'));
    await page.click('.hw-card .hw-card-school');
    await until(async () => !!(await page.$('.hw-school')), 6000);
    const sch = (t) => `.hw-school .hw-school-item:has(.hw-school-line:text-matches("${t}"))`;
    // Quick is his first length: nobody set one here, so it is homework_kids.focus_minutes' default, 10 (the owner's
    // "10 minutes first", docs/v1.3-homework.md's build notes).
    const len = (await one(`select focus_minutes from homework_kids where kid_id = '${P.jordan.id}'`)).focus_minutes;
    check('his first length is the default, 10 minutes', len === '10', len);
    check('New from school (3): Quick (his first length) only on the one due Wednesday; Plan with Pat and Hide on each', (await tc(page, '#hw-school-h')) === 'New from school (3)'
      && same(await texts(page, `${sch('Read chapter 5')} button`), [`Quick · ${len} min`, 'Plan with your parents', 'Hide'])
      && same(await texts(page, `${sch('Lab report')} button`), ['Plan with your parents', 'Hide']) && !(await page.content()).includes('bean plant'), await tc(page, '.hw-school'));
    await page.click(`${sch('Read chapter 5')} [data-act="hw-school-quick"]`);
    await toastIs(page, /^Planned for/);
    const ch5 = await item('Read chapter 5');
    const a1 = ch5 && ch5.assignment_id ? await one(`select added_by, title, subject, due_date, given_by, created_by from assignments where id = '${ch5.assignment_id}'`) : null;
    const s1 = ch5 && ch5.assignment_id ? await sql(`select minutes, day from homework_steps where assignment_id = '${ch5.assignment_id}'`) : [];
    check('Quick: an assignment from school (History, due Wed), with one step of his first length placed today and given by him: "Planned for today: Read chapter 5"',
      !!a1 && same([a1.added_by, a1.title, a1.subject, a1.due_date, a1.created_by], ['school', 'Read chapter 5', 'History', '2026-11-04', 'Jordan (My day)'])
      && /\(My day\)$/.test(a1.given_by || '') && same(s1, [{ minutes: len, day: MON }]) && (await lastToast(page)) === 'Planned for today: Read chapter 5', { a1, s1, toast: await lastToast(page) });
    await page.click(`${sch('Lab report')} [data-act="hw-school-pat"]`);
    await toastIs(page, /^On your homework/);
    const lab = await item('Lab report');
    const a2 = lab && lab.assignment_id ? await one(`select added_by, due_date, details, given_at from assignments where id = '${lab.assignment_id}'`) : null;
    check('Plan with Pat: an assignment from school with no plan, due Fri Nov 20, the description as its teacher\'s text (never on his screen)',
      !!a2 && a2.added_by === 'school' && a2.due_date === '2026-11-20' && a2.details === 'Write up the bean plant lab: hypothesis, method, results.' && !a2.given_at
      && !(await one(`select 1 as x from homework_steps where assignment_id = '${lab.assignment_id}'`)) && !(await page.content()).includes('bean plant'), a2);
    await page.click(`${sch('Map quiz')} [data-act="hw-school-hide"]`);
    await toastIs(page, /^Hidden: Map quiz/);
    const quiz = await item('Map quiz');
    check('Hide: the quiz is hidden, and made no assignment; New from school is gone from #homework', quiz.hidden === 't' && !quiz.made_at
      && await until(async () => !(await page.$('.hw-school'))), quiz);
    await shot(page, 'school-jordan');
    const reqs = await h.requests();
    check('My day calls only token functions, signed out (school_item_by_token among them)', reqs.length > 0 && reqs.every((r) => r.role === 'anon')
      && reqs.filter((r) => r.path === '/rest/v1/rpc/school_item_by_token').length === 3, [...new Set(reqs.map((r) => `${r.role} ${r.path}`))]);
    const f = await failures();
    check('new from school: no API request failed', !f.length, f);
    await context.close();

    const alex = await open({ email: 'alex@example.com', path: '/#/homework', label: 'school-alex-show' });
    await until(async () => !!(await alex.page.$('[data-row="school"] details[data-keep="hidden"]')), 8000);
    await alex.page.click('[data-row="school"] details[data-keep="hidden"] summary');
    await alex.page.click('[data-row="school"] details[data-keep="hidden"] [data-do="show"]');
    await toastIs(alex.page, /^Back on Jordan's New from school: Map quiz/);
    check('Alex shows the quiz again (school_item_action show)', (await item('Map quiz')).hidden === 'f'
      && (await texts(alex.page, '.hw-arows .hw-arow-sub')).filter((x) => / · from school/.test(x)).length === 2, await texts(alex.page, '.hw-arows .hw-arow-sub'));
    await alex.context.close();
  });

  await flow('the school changes', async () => {
    // The chapter moves to Thursday; the lab report goes from the site; an essay outline comes. Each Check now reads
    // links not read in the last minute, so the clock moves 2 minutes before each.
    h.school.serve(SECRET, ics([Object.assign({}, CH5, { lines: ['DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261106'] }), QUIZ, ESSAY]));
    for (const t of ['21:02', '21:04']) {
      await h.setClock(`${MON}T${t}:00Z`);
      const r = await h.hubJobsAs('alex@example.com', { action: 'school' });
      check(`Check now at ${t}Z: one link read and stored`, r.status === 200 && r.body.read === 1 && r.body.stored === 1 && r.body.ok === true, r.body);
    }
    const ch5 = await item('Read chapter 5');
    const a1 = await one(`select due_date from assignments where id = '${ch5.assignment_id}'`);
    const lab = await item('Lab report');
    const a2 = await one(`select status, due_date from assignments where id = '${lab.assignment_id}'`);
    check('the planned chapter: the school\'s date moved to Thu Nov 5, the assignment\'s stays Wed Nov 4 (a person places it again)', ch5.due_date === '2026-11-05' && a1.due_date === '2026-11-04', { ch5, a1 });
    check('the lab report, absent from two good reads: marked no longer on the school site, never deleted', !!lab.gone_at && !!a2 && a2.status === 'open', { lab, a2 });
    const v = (await anonRpc('homework_by_token', { p_token: P.jordan.day_token })).body;
    const mark = (title) => ((v.assignments || []).find((a) => a.title === title) || {}).school;
    check('his view: the school marks {gone, moved_to} on each assignment made from school', same(mark('Read chapter 5'), { gone: false, moved_to: '2026-11-05' })
      && same(mark('Lab report'), { gone: true, moved_to: null }) && same((v.from_school || []).map((x) => x.title), ['Map quiz', 'Essay outline']), { marks: [mark('Read chapter 5'), mark('Lab report')], from: v.from_school });

    const alex = await open({ email: 'alex@example.com', path: '/#/homework', label: 'school-alex-marks' });
    await until(async () => !!(await alex.page.$('[data-row="school"] .hw-school-marks')), 8000);
    check('the parents\' page: the moved date and the one gone from the site, each opening its assignment', same(await texts(alex.page, '[data-row="school"] .hw-school-marks a'),
      ['Read chapter 5: the school moved its due date from Wed Nov 4 to Thu Nov 5. Open it to place it again ›', 'Lab report is no longer on the school site ›']),
      await tc(alex.page, '[data-row="school"]'));
    await shot(alex.page, 'school-marks');
    await alex.context.close();
    const jordan = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}#homework`, label: 'school-jordan-marks' });
    await until(async () => !!(await jordan.page.$('.hw-due')), 8000);
    const due = await texts(jordan.page, '.hw-due .hw-asg-line');
    check('his Due soon: "No longer on the school site" on the lab report', due.some((x) => /^Biology · Lab report · .*No longer on the school site/.test(x)), due);
    await jordan.context.close();
    const f = await failures();
    check('the school changes: no API request failed', !f.length, f);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  school stopped: ${e && e.stack}`); process.exit(1); });
