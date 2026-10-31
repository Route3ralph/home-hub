// The site as it is now, on the database as it is live before v1.3 (schema.sql, the v1 household,
// migrations 0002 to 0004, then the v2 household): the site goes live before migration 0005 is
// applied (docs/v1.3-homework.md §16.1 step 1), so on schema 4 nothing changes for the family. The
// pages make no failing request, show no Homework tab (not on a desktop, not in the phone's More
// sheet) and no homework line on Today, and never ask for a homework table or function; My day (a
// kid's link, at #homework too, and the helper's list) works as before, with no card and no homework
// request; a tutor link says "This link doesn't work yet." (PostgREST's 404 for a function it doesn't
// know). Then the owner pastes 0005 while the hub runs (step 3): every My day answer, every day_text
// and the morning email come out exactly as before (homework is on for nobody yet), and on the next
// load the site shows Homework under More and on the desktop tabs, with nothing failing.
// Run through tests/realdb/run.sh (its own copy of the v4 template database).
const { setup, HOMEWORK_CALLS, SCHOOL_CALLS } = require('./lib');

const TODAY = '2026-10-27';
const TOKEN_FNS = /^\/rest\/v1\/rpc\/(get_person_day|complete_by_token|undo_by_token|confirm_digest|stop_digest|get_list_by_token|add_to_list_by_token|buy_item_by_token)$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const h = await setup('v4db', { v4: true });
  const { check, flow, sql, open, go, tc, titles, until } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || r.error.error || ''}` : ''}`);
  const anonRpc = (name, args) => h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const PAT = 'abcdef0123456789abcdef0123456789';   // a tutor link's shape (no such link: there is no table for it yet)

  await flow('schema 4', async () => {
    const v = await one('select public.hub_schema_version() as v');
    check('v4 db: the database is schema 4 (migration 0004, no 0005)', v.v === '4' && !!(await one("select to_regclass('public.meals') as t")).t
      && !(await one("select to_regclass('public.homework_kids') as t")).t, v);
    await sql(`insert into tasks (title, responsible_id, due_date) values ('Trash out', '${P.jordan.id}', '${TODAY}');
               insert into events (title, start_date, start_time, end_time, responsible_id, participant_ids)
               values ('Piano', '${TODAY}', '16:00', '17:00', '${P.taylor.id}', '{${P.jordan.id}}');
               insert into shopping_items (name, aisle, added_by) values ('Milk', 'dairy', '${P.alex.id}');
               update household set helper_list = 'add'`);
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', phone: true, path: '/', label: 'v4db-alex' });
    const bar = await page.$$eval('.bottombar a[data-tab]', (as) => as.map((a) => a.dataset.tab));
    check('v4 db: the new site runs its pages on schema 4; the bottom bar has Food and no Homework',
      (await page.evaluate(() => HomeHub.core.schemaVersion)) === 4 && /Good morning, Alex/.test(await tc(page, '#main h1')) && bar.includes('food') && !bar.includes('homework'), { bar });
    check('v4 db: Today has no homework lines', !(await page.$('.today-hw')));
    await page.click('.bb-more');
    await page.waitForSelector('#sheet .sheet-list a');
    const more = await page.$$eval('#sheet .sheet-list a', (as) => as.map((a) => a.dataset.tab));
    check('v4 db: the More sheet has no Homework', more.length > 0 && !more.includes('homework'), more);
    await page.keyboard.press('Escape');
    for (const hash of ['#/calendar', '#/tasks/everyone', '#/food', '#/people', '#/settings', '#/homework', `#/homework/${P.jordan.id}`, '#/']) await go(page, hash);
    check('v4 db: #/homework isn\'t a page on schema 4 (no Homework heading)', !/^Homework/.test(await tc(page, '#main h1')), await tc(page, '#main h1'));
    await context.close();

    const desk = await open({ email: 'sam@example.com', path: '/', label: 'v4db-sam' });
    const tabs = await desk.page.$$eval('.tabs a', (as) => as.map((a) => a.textContent.trim()));
    check('v4 db: the desktop tabs have Food and no Homework', tabs.includes('Food') && !tabs.includes('Homework'), tabs);
    await desk.context.close();

    const reqs = await h.requests();
    const hw = reqs.filter((r) => (HOMEWORK_CALLS.test(r.path) || SCHOOL_CALLS.test(r.path)));
    check('v4 db: no homework table or function request from any page', !hw.length, hw.map((r) => r.path));
    check('v4 db: the pages read the agenda and the dinners as before', reqs.some((r) => r.path === '/rest/v1/rpc/agenda') && reqs.some((r) => r.path === '/rest/v1/meals'),
      [...new Set(reqs.map((r) => r.path))]);
    const f = await failures();
    check('v4 db: no API request failed', !f.length, f);
  });

  await flow('my day on schema 4', async () => {
    await h.mark();
    for (const [who, hash] of [['jordan', ''], ['jordan', '#homework'], ['jordan', '#points'], ['taylor', '#list']]) {
      const { page, context } = await open({ phone: true, path: `/day.html?t=${P[who].day_token}${hash}`, label: `v4db-${who}${hash}` });
      await page.waitForSelector('.day-head, .list-head', { timeout: 8000 });
      if (who === 'taylor') {
        await until(async () => (await page.$$('.list-sec .lrow')).length > 0);
        check('v4 db: Taylor\'s list on her My day (#list) works as before', (await tc(page, '.list-head h1')) === 'Lista de compras'
          && (await page.$$eval('.list-sec .lrow-name', (es) => es.map((e) => e.textContent))).some((x) => /^Milk/.test(x)), await tc(page, '#app'));
      } else {
        await until(async () => (await titles(page, 'section[aria-labelledby="day-today"]')).length > 0);
        const today = await titles(page, 'section[aria-labelledby="day-today"]');
        check(`v4 db: Jordan's My day${hash ? ` at ${hash}` : ''} shows his day as before (Piano and Trash out), with no homework card`,
          today.includes('Piano') && today.includes('Trash out') && !(await page.$('.hw-card')) && !(await page.$('.hw-now-card, .hw-balance-big')), today);
      }
      await context.close();
    }
    const reqs = await h.requests();
    check('v4 db: My day calls the token functions only (signed out), and no homework function', reqs.length > 0
      && reqs.every((r) => r.role === 'anon' && TOKEN_FNS.test(r.path)) && !reqs.some((r) => (HOMEWORK_CALLS.test(r.path) || SCHOOL_CALLS.test(r.path))), reqs.map((r) => `${r.role} ${r.path}`));
    const day = await anonRpc('get_person_day', { p_token: P.jordan.day_token });
    check('v4 db: get_person_day has no homework key', day.status === 200 && !!day.body && !('homework' in day.body), JSON.stringify(day.body).slice(0, 200));
    const f = await failures();
    check('v4 db: no My day request failed', !f.length, f);

    // A tutor link before 0005: PostgREST doesn't know tutor_view_by_token (404 PGRST202), and the page says so.
    await h.mark();
    const pat = await open({ phone: true, path: `/day.html?h=${PAT}`, label: 'v4db-tutor' });
    check('v4 db: a tutor link says "This link doesn\'t work yet."', await until(async () => (await tc(pat.page, '.day-problem')) === 'This link doesn\'t work yet.'),
      await tc(pat.page, '#app'));
    const tr = await h.requests();
    check('v4 db: ... after one call, tutor_view_by_token, answered 404 PGRST202 (signed out)', tr.length === 1 && tr[0].path === '/rest/v1/rpc/tutor_view_by_token'
      && tr[0].role === 'anon' && tr[0].status === 404 && tr[0].error && tr[0].error.code === 'PGRST202', tr.map((r) => `${r.role} ${r.path} ${r.status}`));
    await pat.context.close();
  });

  // The owner pastes 0005 while the hub runs (§16.1 step 3): nothing anyone gets changes until a
  // parent turns homework on; the next load shows the Homework page.
  await flow('0005 on a running hub', async () => {
    const people = await sql('select id, name, day_token from people where active order by name');
    const capture = async () => {
      await h.setClock(`${TODAY}T13:30:00Z`);
      const out = { days: {}, texts: {}, mail: null };
      for (const p of people) {
        if (p.day_token) out.days[p.name] = (await anonRpc('get_person_day', { p_token: p.day_token })).body;
        out.texts[p.name] = (await one(`select public.day_text('${p.id}', '${TODAY}') as t`)).t;
      }
      const pv = await h.hubJobsAs('alex@example.com', { action: 'preview', person_id: P.alex.id });
      out.mail = pv.status === 200 ? pv.body : { status: pv.status, body: pv.body };
      return out;
    };
    const before = await capture();
    check('v4 db: before 0005, every My day answer, day_text and Alex\'s email preview answer',
      Object.keys(before.days).length >= 2 && Object.values(before.days).every((d) => !!d && !!d.person) && !!before.mail && Array.isArray(before.mail.emails)
      && before.mail.emails.length === 1, { days: Object.keys(before.days), mail: before.mail });
    const m = await h.migrate('supabase/migrations/0005_homework.sql');
    const v = await one('select public.hub_schema_version() as v');
    check('v4 db: 0005 applies in one go, in its own session, and the schema version is 5', !m.error && v.v === '5' && !!(await one("select to_regclass('public.homework_kids') as t")).t,
      m.error || v);
    const after = await capture();
    for (const k of ['days', 'texts', 'mail']) {
      check(`v4 db: after 0005, with homework on for nobody, ${{ days: 'every My day answer (get_person_day)', texts: 'every day_text', mail: 'Alex\'s morning email' }[k]} is exactly as before`,
        same(after[k], before[k]), { before: JSON.stringify(before[k]).slice(0, 200), after: JSON.stringify(after[k]).slice(0, 200) });
    }

    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/', label: 'v4db-after' });
    const tabs = await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent.trim()));
    check('v4 db: on the next load the site is on schema 5, with Homework between Food and Projects',
      (await page.evaluate(() => HomeHub.core.schemaVersion)) === 5 && tabs.indexOf('Homework') === tabs.indexOf('Food') + 1 && tabs.indexOf('Projects') === tabs.indexOf('Homework') + 1, tabs);
    check('v4 db: Today has no homework lines (nothing is waiting)', !(await page.$('.today-hw')));
    await go(page, '#/homework');
    await until(async () => !!(await page.$('.hw-setup')));
    check('v4 db: the Homework page opens on its first visit: "Turn on homework for Jordan"', (await tc(page, '#main h1')) === 'Homework'
      && same(await page.$$eval('.hw-setup [data-act="turn-on"]', (bs) => bs.map((b) => b.textContent.trim())), ['Turn on homework for Jordan']), await tc(page, '#main'));
    await context.close();
    const jordan = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}`, label: 'v4db-jordan-after' });
    await jordan.page.waitForSelector('.day-head', { timeout: 8000 });
    check('v4 db: Jordan\'s My day has no card while his homework is off', !(await jordan.page.$('.hw-card')));
    await jordan.context.close();
    const pat = await open({ phone: true, path: `/day.html?h=${PAT}`, label: 'v4db-tutor-after' });
    check('v4 db: an unknown tutor link now says "This link no longer works…"', await until(async () => /^This link no longer works/.test(await tc(pat.page, '.day-problem'))),
      await tc(pat.page, '#app'));
    await pat.context.close();
    const reqs = await h.requests();
    check('v4 db: My day made no homework request for Jordan (only get_person_day)', reqs.filter((r) => r.role === 'anon' && r.path !== '/rest/v1/rpc/tutor_view_by_token' && /^\/rest\//.test(r.path))
      .every((r) => r.path === '/rest/v1/rpc/get_person_day'), reqs.map((r) => `${r.role} ${r.path}`));
    const f = await failures();
    check('v4 db: no API request failed after 0005', !f.length, f);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  v4db stopped: ${e && e.stack}`); process.exit(1); });
