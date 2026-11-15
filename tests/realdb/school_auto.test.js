// Adding school items automatically (migration 0030, docs/v1.3-homework.md §30) against the REAL database
// (tests/realdb/run.sh):
//   Thu Nov 5, 3:00pm  Jordan's Assignments link is checked (due dates: each item's last day). Waiting in New from
//                      school: a worksheet that was due Monday, a grammar quiz due tomorrow, a reading log due Monday,
//                      and this week's practice topics (last week's were hidden). Alex opens Homework: the link says
//                      new ones wait, with Add automatically. He taps it (the real set_school_auto_add): the quiz and
//                      the log are added at once and the toast says 2; this week's practice topics are hidden instead;
//                      the past worksheet waits.
//   The next read       A new item comes in (the real private.school_apply, as each hourly read calls it): it goes on
//                      Jordan's homework by itself, by "school (added automatically)", and his My day lists it.
//   Off                 Stop adding automatically: the next new item waits in New from school.
// Everything is made up: the school's host is academy.school.example.
const { setup } = require('./lib');

const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;

(async () => {
  const h = await setup('school_auto');
  const { check, flow, sql, open, tc, until, lastToast } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };
  const AUTO = '[data-row="school"] .hw-feed[data-feed="assignments"] [data-act="school-auto"]';
  const LINE = '[data-row="school"] .hw-feed[data-feed="assignments"] .hw-feed-auto';
  const fromSchool = async () => (await sql(`select title, created_by from assignments where kid_id = '${P.jordan.id}' and added_by = 'school' order by due_date, title`))
    .map((r) => `${r.title} (${r.created_by})`);
  const item = (title, subject, due, hidden) => `insert into school_items (feed_id, key, has_uid, title, subject, first_day, last_day, due_date, hidden, first_seen_at, last_seen_at)
    select id, md5('${title} ${due}'), false, '${title}', '${subject}', '${due}', '${due}', '${due}', ${hidden ? 'true' : 'false'}, now(), now() from school_feeds where kind = 'assignments'`;

  await h.setClock(at('2026-11-05', '15:00'));
  await sql("create or replace function private.school_host_suffix() returns text language sql immutable set search_path = '' as $$ select '.school.example' $$");
  await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
  const added = await rpcAs('alex@example.com', 'set_school_feed', { p_kid: P.jordan.id, p_kind: 'assignments', p_url: 'webcal://academy.school.example/podium/feed/iCal.aspx?z=AUTO0123' });
  check('the setup: Alex adds the Assignments link (the real set_school_feed)', added.status === 200, added.body);
  await sql("update school_feeds set checked = true, date_rule = 'end', date_shift = 0, last_ok_at = now(), last_try_at = now(), last_count = 5");
  for (const q of [item('Practice topics', 'Math', '2026-10-30', true), item('Old worksheet', 'Math', '2026-11-02'), item('Grammar quiz', 'Spanish', '2026-11-06'),
    item('Reading log', 'English', '2026-11-09'), item('Practice topics', 'Math', '2026-11-06')]) await sql(q);

  await flow('alex turns it on', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'auto-alex' });
    await page.waitForSelector(AUTO, { timeout: 8000 });
    check('the Assignments link: Add automatically, and "New ones wait in New from school until you add them."',
      (await tc(page, AUTO)) === 'Add automatically' && (await tc(page, LINE)) === 'New ones wait in New from school until you add them.', await tc(page, LINE));
    await page.click(AUTO);
    await until(async () => /^Adding automatically/.test((await lastToast(page)) || ''));
    check('on (the real set_school_auto_add): "2 assignments added to Jordan\'s homework now."',
      (await lastToast(page)) === 'Adding automatically. 2 assignments added to Jordan\'s homework now.', await lastToast(page));
    check('... the grammar quiz and the reading log, as Alex (who turned it on)',
      JSON.stringify(await fromSchool()) === JSON.stringify(['Grammar quiz (alex@example.com)', 'Reading log (alex@example.com)']), await fromSchool());
    const left = await sql("select title, due_date::text as d, hidden from school_items where made_at is null order by due_date");
    check('... this week\'s practice topics hidden (hidden last week too), the past worksheet left waiting',
      JSON.stringify(left.map((r) => `${r.title} ${r.d} ${r.hidden}`)) === JSON.stringify(['Practice topics 2026-10-30 t', 'Old worksheet 2026-11-02 f', 'Practice topics 2026-11-06 t']),
      left);
    await until(async () => (await tc(page, AUTO)) === 'Stop adding automatically');
    check('... the button reads Stop adding automatically, and the line says what it does',
      (await tc(page, LINE)) === 'Adding automatically: new ones due in the next 30 days go on Jordan\'s homework within the hour, except ones you hid before or added yourself.',
      await tc(page, LINE));
    check('alex: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('the next read', async () => {
    await sql(item('Map of Asia', 'Geography', '2026-11-10'));
    const feed = await one("select id from school_feeds where kind = 'assignments'");
    await sql(`select private.school_apply('${feed.id}')`);
    check('a new item, at the next read (the real school_apply): on his homework by "school (added automatically)"',
      (await fromSchool()).includes('Map of Asia (school (added automatically))'), await fromSchool());
    const view = (await h.api('/rest/v1/rpc/homework_by_token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_token: P.jordan.day_token }) })).body;
    check('... and Jordan\'s My day lists it (the real homework_by_token)', JSON.stringify(view || {}).includes('Map of Asia'), Object.keys(view || {}));
  });

  await flow('alex turns it off', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'auto-off' });
    await page.waitForSelector(AUTO, { timeout: 8000 });
    await page.click(AUTO);
    await until(async () => (await lastToast(page)) === 'Stopped adding automatically: new ones wait in New from school.');
    check('off: the toast says new ones wait', (await lastToast(page)) === 'Stopped adding automatically: new ones wait in New from school.', await lastToast(page));
    await sql(item('Poster', 'Art', '2026-11-11'));
    const feed = await one("select id from school_feeds where kind = 'assignments'");
    await sql(`select private.school_apply('${feed.id}')`);
    check('... the next new item waits in New from school', !(await fromSchool()).some((t) => t.startsWith('Poster'))
      && !!(await one("select 1 from school_items where title = 'Poster' and made_at is null and not hidden")), await fromSchool());
    check('off: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  school_auto stopped: ${e && e.stack}`); process.exit(1); });
