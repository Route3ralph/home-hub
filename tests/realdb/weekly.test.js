// The Sunday sheets (migration 0025, docs/v2-design.md §31) against the REAL database (tests/realdb/run.sh):
//   Sun Nov 8, 3:00pm  Alex opens Settings → Sunday sheets: turns them on at 4:00pm with the Family week (English),
//                      Jordan's (English) and Taylor's (Spanish), sent to Alex; the household row holds exactly that
//                      (the real trigger checks it). Open next week to print: the real hub-jobs (weekly_preview) and
//                      the real weekly_sheet, in a new window: the three sheets for Nov 9-15.
//   Sun Nov 8, 3:59pm  The morning email's run sends no Sunday email yet; at 4:00pm it sends one, to Alex, with the
//                      three sheets; the next run sends no second one.
// Everything is made up. Screenshots: tests/e2e/shots/realdb-weekly-*.png.
const { setup } = require('./lib');

// New York is on standard time from Nov 1: 3:00pm is 20:00 UTC.
const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const h = await setup('weekly');
  const { check, flow, sql, open, tc, texts, lastToast, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };

  await h.setClock(at('2026-11-08', '15:00'));
  // Alex's address is confirmed; Jordan has homework on, a routine and a plan given to him; Taylor drives him on Monday.
  await sql(`update people set email_verified_at = now() where email = 'alex@example.com'`);
  await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
  await rpcAs('alex@example.com', 'save_routine', { p_kid: P.jordan.id, p_points: 0, p_sections: [
    { title: 'Morning', items: [{ title: 'Make bed' }, { title: 'Pack your bag', school_days: true }] }] });
  await sql(`insert into events (title, start_date, start_time, end_time, responsible_id, participant_ids, location, bring)
             values ('Take Jordan to school', '2026-11-09', '07:20', '07:40', '${P.taylor.id}', array['${P.jordan.id}'::uuid], 'Example School', 'Lunch box')`);
  await sql(`insert into assignments (kid_id, title, subject, due_date, given_at, given_by)
             values ('${P.jordan.id}', 'Chapter 3 test', 'Math', '2026-11-11', now(), 'alex@example.com')`);
  await sql(`insert into homework_steps (assignment_id, pos, kind, title, minutes, day)
             select id, 1, 'step', 'Solve 5 equations', 20, '2026-11-10' from assignments where title = 'Chapter 3 test'`);
  await sql(`insert into shopping_items (name, added_by) values ('Milk', '${P.alex.id}')`);

  await flow('alex turns them on', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'weekly-alex' });
    await page.waitForSelector('.set-weekly input[name="on"]', { timeout: 8000 });
    check('Settings: the Sunday sheets card, off', (await tc(page, '#setWeekly')) === 'Sunday sheets' && !(await page.isChecked('.set-weekly input[name="on"]')));
    await page.check('.set-weekly input[name="on"]');
    await page.fill('.set-weekly input[name="at"]', '16:00');
    await page.check('.set-weekly input[name="sheet"][value="family"]');
    await page.check(`.set-weekly input[name="sheet"][value="${P.taylor.id}"]`);
    await page.check(`.set-weekly input[name="sheet"][value="${P.jordan.id}"]`);
    check('... Taylor\'s sheet in Spanish to start (her language)', (await page.inputValue(`.set-weekly select[name="lang:${P.taylor.id}"]`)) === 'es');
    await page.check(`.set-weekly input[name="to"][value="${P.alex.id}"]`);
    await page.click('.set-weekly [type="submit"]');
    await page.waitForTimeout(800);
    const row = await one('select weekly_at::text as at, array_to_json(weekly_to)::text as weekly_to, weekly_sheets::text as weekly_sheets from household');
    check('Save: the household row holds the time, the sheets in the family list\'s order with their languages, and Alex', !!row && row.at === '16:00:00'
      && same(JSON.parse(row.weekly_to), [P.alex.id])
      && same(JSON.parse(row.weekly_sheets), [{ who: 'family', lang: 'en' }, { who: P.jordan.id, lang: 'en' }, { who: P.taylor.id, lang: 'es' }]), JSON.stringify(row));
    check('... and says so', (await lastToast(page)) === 'Sunday sheets on: 3 sheets on Sundays at 4:00pm', await lastToast(page));
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('.set-weekly [data-weekly="next"]')]);
    await popup.waitForSelector('.hh-sheet', { timeout: 8000 });
    const heads = await popup.$$eval('.hh-sheet h1', (es) => es.map((e) => e.textContent));
    check('Open next week to print: the three sheets from the real weekly_sheet, in their languages', same(heads, ['Family week', 'Jordan\'s week', 'Semana de Taylor']), JSON.stringify(heads));
    const body = (await popup.textContent('body')).replace(/\s+/g, ' ');
    check('... for Nov 9-15: Taylor\'s Monday run in Spanish with Bring, Jordan\'s step and test, his routine, Taylor\'s list',
      body.includes('Week of Nov 9 – Nov 15') && body.includes('7:20–7:40 Take Jordan to school') && body.includes('Llevar: Lunch box')
      && body.includes('Chapter 3 test: Solve 5 equations (20 min)') && body.includes('due Wed Nov 11') && body.includes('Pack your bag') && body.includes('Lista de compras') && body.includes('Milk'),
      body.slice(0, 600));
    await shot(popup, 'weekly-print');
    await popup.close();
    check('alex: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('the Sunday run', async () => {
    await h.setClock(at('2026-11-08', '15:59'));
    const before = h.sent.length;
    let res = await h.runDigest();
    check('3:59pm: the run sends no Sunday email yet', res.status === 200 && h.sent.length === before && !(await one(`select 1 from notification_log where kind = 'weekly'`)), JSON.stringify(res.body));
    await h.setClock(at('2026-11-08', '16:00'));
    res = await h.runDigest();
    const mail = h.sent.slice(before);
    check('4:00pm: one Sunday email, to Alex, with the three sheets', res.status === 200 && mail.length === 1 && same(mail[0].to, ['alex@example.com'])
      && mail[0].subject === 'Week of Nov 9 – Nov 15: Family, Jordan, Taylor' && (mail[0].html.match(/class="hh-sheet"/g) || []).length === 3
      && mail[0].idempotencyKey === `weekly-${P.alex.id}-2026-11-09`, JSON.stringify(mail.map((m) => m.subject)));
    const log = await sql(`select person_id, local_date::text as d, status from notification_log where kind = 'weekly'`);
    check('... logged once, as sent, for the week starting Monday Nov 9', log.length === 1 && log[0].person_id === P.alex.id && log[0].d === '2026-11-09' && log[0].status === 'sent', JSON.stringify(log));
    res = await h.runDigest();
    check('the next run sends no second one', h.sent.length === before + 1);
  });

  await h.finish();
})();
