// Take points (migration 0028, docs/v1.3-homework.md §28) against the REAL database (tests/realdb/run.sh):
//   Fri Nov 13, 5:00pm  Jordan has 30 points, 20 of them held for a reward he asked for. Alex opens Homework →
//                       Take points: the dialog says 10 are free; 11 is refused in the real function's words; 8 with
//                       a reason is taken (the real take_points).
//   Then Jordan's My day: "−8 Taken away · Phone at the dinner table" in his points, and ★ 22.
// Everything is made up.
const { setup } = require('./lib');

const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;

(async () => {
  const h = await setup('take_points');
  const { check, flow, sql, open, tc, until, lastToast } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).filter((r) => !(r.status === 400 && /take_points/.test(r.path)))
    .map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };
  const balance = async () => Number((await one(`select coalesce(sum(delta), 0) as b from points_ledger where kid_id = '${P.jordan.id}'`)).b);

  await h.setClock(at('2026-11-13', '17:00'));
  await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
  await sql(`update homework_kids set points_on = true where kid_id = '${P.jordan.id}'`);
  await sql(`insert into points_ledger (kid_id, at, day, kind, delta, note, who) values ('${P.jordan.id}', now(), '2026-11-12', 'given', 30, 'Great week', 'alex@example.com')`);
  await sql(`insert into reward_asks (kid_id, title, cost, status, asked_at) values ('${P.jordan.id}', 'Pick the movie', 20, 'waiting', now())`);

  await flow('alex takes points', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'take-alex' });
    await page.waitForSelector('[data-act="take"]', { timeout: 8000 });
    await page.click('[data-act="take"]');
    await page.waitForSelector('#formDialog form.hw-take', { timeout: 5000 });
    check('the dialog: "10 points are free to take" (30, 20 held)', (await tc(page, '#formDialog form.hw-take')).includes('10 points are free to take'), await tc(page, '#formDialog form.hw-take'));
    await page.fill('#formDialog form.hw-take [name="points"]', '11');
    await page.fill('#formDialog form.hw-take [name="note"]', 'Phone at the dinner table');
    await page.click('#formDialog form.hw-take button[type="submit"]');
    await until(async () => /free to take/.test(await tc(page, '#formDialog form.hw-take .form-error') || ''));
    check('11: refused in the real function\'s words, nothing taken', /Only 10 points are free to take/.test(await tc(page, '#formDialog form.hw-take .form-error')) && (await balance()) === 30,
      await tc(page, '#formDialog form.hw-take .form-error'));
    await page.fill('#formDialog form.hw-take [name="points"]', '8');
    await page.click('#formDialog form.hw-take button[type="submit"]');
    await until(async () => (await balance()) === 22);
    await until(async () => (await lastToast(page)) === '−8 for Jordan');
    check('8: taken (the real take_points): a \'taken\' row of −8 with the reason, by Alex', !!(await one(`select 1 from points_ledger where kind = 'taken' and delta = -8 and note = 'Phone at the dinner table' and who = 'alex@example.com'`))
      && (await balance()) === 22 && (await lastToast(page)) === '−8 for Jordan', await lastToast(page));
    check('alex: no API request failed (but the refused 11)', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('jordan sees it', async () => {
    await h.mark();
    const { page, context } = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}#points`, label: 'take-jordan' });
    await page.waitForSelector('.hw-balance-big', { timeout: 8000 });
    const lines = await page.$$eval('.hw-lines li', (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    check('his points (the real homework_by_token): "−8 Taken away · Phone at the dinner table · today"', lines.some((l) => /^−8 Taken away · Phone at the dinner table · /.test(l)), JSON.stringify(lines));
    check('... ★ 22', /22/.test(await tc(page, '.hw-balance-big')), await tc(page, '.hw-balance-big'));
    check('jordan: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await h.finish();
})();
