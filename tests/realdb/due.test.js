// Due tomorrow (migration 0029, docs/v1.3-homework.md §29) against the REAL database (tests/realdb/run.sh):
//   Fri Nov 13, 5:00pm  Alex opens Settings → Due tomorrow: turns it on at 5:30pm, sent to Alex; the household row
//                       holds exactly that (the real trigger checks it). Preview tonight's: the real hub-jobs
//                       (due_preview) and the real due_list, in a new window: Jordan's lists for Saturday.
//   Fri Nov 13, 5:29pm  The morning email's run sends no Due tomorrow email yet; at 5:30pm it sends one, to Alex; the
//                       next run sends no second one.
// Everything is made up. Screenshots: tests/e2e/shots/realdb-due-*.png.
const { setup } = require('./lib');

// New York is on standard time from Nov 1: 5:00pm is 22:00 UTC.
const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const h = await setup('due');
  const { check, flow, sql, open, tc, lastToast, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };

  await h.setClock(at('2026-11-13', '17:00'));
  await sql(`update people set email_verified_at = now() where email = 'alex@example.com'`);
  await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
  await sql(`insert into assignments (kid_id, title, subject, due_date, status, done_at, school_mark, count_goal, count_done) values
             ('${P.jordan.id}', 'Volcano poster', 'Science', '2026-11-14', 'open', null, null, null, 0),
             ('${P.jordan.id}', 'Verbs worksheet', 'Spanish', '2026-11-14', 'done', now(), null, null, 0),
             ('${P.jordan.id}', 'Map quiz', 'History', '2026-11-13', 'open', null, null, null, 0),
             ('${P.jordan.id}', 'Lab report', 'Science', '2026-11-05', 'open', null, 'missing', null, 0),
             ('${P.jordan.id}', 'Math topics', 'Math', '2026-11-16', 'open', null, null, 7, 5)`);

  await flow('alex turns it on', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'due-alex' });
    await page.waitForSelector('.set-due input[name="on"]', { timeout: 8000 });
    check('Settings: the Due tomorrow card, off, 5:30pm suggested', (await tc(page, '#setDue')) === 'Due tomorrow' && !(await page.isChecked('.set-due input[name="on"]'))
      && (await page.inputValue('.set-due input[name="at"]')) === '17:30');
    await page.check('.set-due input[name="on"]');
    await page.check(`.set-due input[name="to"][value="${P.alex.id}"]`);
    await page.click('.set-due [type="submit"]');
    await page.waitForTimeout(800);
    const row = await one('select due_at::text as at, array_to_json(due_to)::text as due_to from household');
    check('Save: the household row holds the time and Alex', !!row && row.at === '17:30:00' && same(JSON.parse(row.due_to), [P.alex.id]), JSON.stringify(row));
    check('... and says so', (await lastToast(page)) === 'Due tomorrow on: every evening at 5:30pm', await lastToast(page));
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('.set-due [data-due="preview"]')]);
    await popup.waitForSelector('h1', { timeout: 8000 });
    const body = (await popup.textContent('body')).replace(/\s+/g, ' ');
    check('Preview tonight\'s: the real due_list through the real hub-jobs: Saturday\'s, the late ones, Monday\'s with its count',
      (await popup.textContent('h1')) === 'Due tomorrow (Sat Nov 14): 1 for Jordan'
      && /Due tomorrow, Sat Nov 14 ?✓ ?Verbs worksheet · Spanish · done ?☐ ?Volcano poster · Science/.test(body)
      && /Not marked done yet ?☐ ?Lab report · Science · Missing · due Thu Nov 5 ?☐ ?Map quiz · History · due Fri Nov 13/.test(body)
      && /Coming up, to Tue Nov 17 ?☐ ?Math topics · Math · 5 of 7 · due Mon Nov 16/.test(body), body.slice(0, 600));
    await shot(popup, 'due-preview');
    await popup.close();
    check('alex: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('the evening run', async () => {
    const dueMail = () => h.sent.filter((m) => /^Due tomorrow|^Nothing due/.test(m.subject));
    await h.setClock(at('2026-11-13', '17:29'));
    let res = await h.runDigest();
    check('5:29pm: the run sends no Due tomorrow email yet', res.status === 200 && !dueMail().length && !(await one(`select 1 from notification_log where kind = 'due'`)), JSON.stringify(res.body));
    await h.setClock(at('2026-11-13', '17:30'));
    res = await h.runDigest();
    const mail = dueMail();
    check('5:30pm: one email, to Alex, keyed to him and the day', res.status === 200 && mail.length === 1 && same(mail[0].to, ['alex@example.com'])
      && mail[0].subject === 'Due tomorrow (Sat Nov 14): 1 for Jordan' && mail[0].idempotencyKey === `due-${P.alex.id}-2026-11-13`, JSON.stringify(mail.map((m) => m.subject)));
    const log = await sql(`select person_id, local_date::text as d, status from notification_log where kind = 'due'`);
    check('... logged once, as sent, for Fri Nov 13', log.length === 1 && log[0].person_id === P.alex.id && log[0].d === '2026-11-13' && log[0].status === 'sent', JSON.stringify(log));
    res = await h.runDigest();
    check('the next run sends no second one', dueMail().length === 1);
  });

  await h.finish();
})();
