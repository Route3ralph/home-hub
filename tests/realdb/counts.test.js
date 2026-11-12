// A count on an assignment (migration 0026, docs/v1.3-homework.md §27) against the REAL database (tests/realdb/run.sh):
//   Thu Nov 12, 5:00pm  Alex opens Jordan's "ALEKS topics" on the Homework page: Count… 3, then +1: "1 of 3 done" (the
//                       real column grant and policies).
//   Thu Nov 12, 5:10pm  Jordan's My day: "1 of 3 done" under Due soon; +1 twice (the real count_by_token, from the count
//                       his screen showed): "All 3 done!", and the assignment is done (the real trigger); −1 opens it again.
//   Then Alex's page: +1 from the count it showed before Jordan's taps changes nothing, and says so; the list says "2 of 3".
// Everything is made up. Screenshots: tests/e2e/shots/realdb-counts-*.png.
const { setup } = require('./lib');

const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;

(async () => {
  const h = await setup('counts');
  const { check, flow, sql, open, tc, until, lastToast, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };
  // "3 1 open": the count, how many done, the status (as text: the helper answers numbers as text).
  const row = async () => (await one(`select count_goal || ' ' || count_done || ' ' || status as s from assignments where title = 'ALEKS topics'`)).s;

  await h.setClock(at('2026-11-12', '17:00'));
  await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
  await sql(`insert into assignments (kid_id, title, subject, due_date, created_by) values ('${P.jordan.id}', 'ALEKS topics', 'Math', '2026-11-16', 'alex@example.com')`);
  const id = (await one(`select id from assignments where title = 'ALEKS topics'`)).id;
  let alex;

  await flow('alex sets the count', async () => {
    await h.mark();
    alex = await open({ email: 'alex@example.com', path: `/#/homework/${id}`, label: 'counts-alex' });
    const { page } = alex;
    await page.waitForSelector('[data-act="set-count"]', { timeout: 8000 });
    await page.evaluate(() => { window.prompt = () => '3'; });   // the page's "How many to do?" (lib.js accepts dialogs with their default)
    await page.click('[data-act="set-count"]');
    await until(async () => (await row()) === '3 0 open');
    check('Count… 3: the real update (column grant, policies): 0 of 3, open', (await row()) === '3 0 open', await row());
    await page.waitForSelector('[data-act="count-plus"]', { timeout: 5000 });
    await page.click('[data-act="count-plus"]');
    await until(async () => (await row()) === '3 1 open');
    check('+1: 1 of 3, and the page says so', (await row()) === '3 1 open' && await until(async () => (await tc(page, '.hw-count-big')) === '1 of 3 done'), await tc(page, '.hw-count-big'));
    check('alex: no API request failed', !(await failures()).length, await failures());
  });

  await flow('jordan counts on his My day', async () => {
    await h.setClock(at('2026-11-12', '17:10'));
    await h.mark();
    const { page, context } = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}#homework`, label: 'counts-jordan' });
    const sel = `.hw-due .hw-count[data-asg="${id}"]`;
    await page.waitForSelector(sel, { timeout: 8000 });
    check('his view (the real homework_by_token): "1 of 3 done" under Due soon, with −1 and +1', (await tc(page, `${sel} .hw-count-num`)) === '1 of 3 done'
      && !!(await page.$(`${sel} .hw-count-plus`)) && !!(await page.$(`${sel} .hw-count-minus`)), await tc(page, sel));
    await page.click(`${sel} .hw-count-plus`);
    await until(async () => (await tc(page, `${sel} .hw-count-num`)) === '2 of 3 done');
    await page.click(`${sel} .hw-count-plus`);
    await until(async () => (await tc(page, `${sel} .hw-count-num`)) === 'All 3 done!');
    check('+1 twice (the real count_by_token): "All 3 done!", and the assignment is done (the real trigger)', (await tc(page, `${sel} .hw-count-num`)) === 'All 3 done!'
      && (await row()) === '3 3 done', await row());
    check('... written as "Jordan (My day)", done_at stamped', !!(await one(`select 1 from assignments where id = '${id}' and updated_by = 'Jordan (My day)' and done_at is not null`)));
    await shot(page, 'counts-jordan');
    await page.click(`${sel} .hw-count-minus`);
    await until(async () => (await row()) === '3 2 open');
    check('−1: 2 of 3, open again', (await row()) === '3 2 open', await row());
    check('jordan: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('alex, behind his taps', async () => {
    await h.mark();
    const { page, context } = alex;
    await page.click('[data-act="count-plus"]');   // the page still shows 1 of 3
    await until(async () => /count changed meanwhile/.test(await lastToast(page) || ''));
    check('+1 from the old count: "the count changed meanwhile", nothing changed', /the count changed meanwhile/.test(await lastToast(page)) && (await row()) === '3 2 open', await lastToast(page));
    await page.evaluate(() => { location.hash = '#/homework'; });
    await until(async () => /2 of 3/.test(await tc(page, '.hw-arow .hw-count')));
    check('the list: "2 of 3" on the row', (await tc(page, '.hw-arow .hw-count')) === '2 of 3', await tc(page, '.hw-arow .hw-count'));
    await context.close();
  });

  await h.finish();
})();
