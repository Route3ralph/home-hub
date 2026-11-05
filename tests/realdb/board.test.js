// The family board (migration 0020, docs/v2-design.md §25) against the REAL database (tests/realdb/run.sh):
//   Tue Nov 3, 7:00am  Alex opens Settings → Family board → Make the board link; Copy link puts it on the clipboard.
//   Tue Nov 3, 7:05am  The board on the wall (no sign-in): the date, Family and each person's column, Sam's private
//                      dentist as "Private item", Jordan's routine and chore. The chore ticked (done by "Family board"),
//                      then Undo; a routine item ticked.
//   Then Alex makes a new link (the old one stops at once) and turns the board off.
// Everything is made up. Screenshots: tests/e2e/shots/realdb-board-*.png.
const { setup } = require('./lib');

// New York is on standard time from Nov 1: 7:00am is 12:00 UTC.
const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const h = await setup('board');
  const { check, flow, sql, open, tc, texts, lastToast, until, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };

  await h.setClock(at('2026-11-03', '07:00'));
  // Jordan has homework on and a routine; a chore of his today; Sam's private dentist visit.
  await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
  await rpcAs('alex@example.com', 'save_routine', { p_kid: P.jordan.id, p_points: 2, p_sections: [
    { title: 'Morning', note: 'At home', items: [{ title: 'Make bed' }, { title: 'Out of the house', tag: '30 min early', school_days: true }] }] });
  await sql(`insert into tasks (title, category, responsible_id, due_date) values ('Take out trash', 'home', '${P.jordan.id}', '2026-11-03')`);
  await sql(`insert into events (title, notes, start_date, start_time, end_time, responsible_id, private)
             values ('Dentist', 'Cleaning', '2026-11-03', '10:00', '10:30', '${P.sam.id}', true)`);

  let link = '';
  await flow('alex makes the link', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'board-alex' });
    await page.waitForSelector('[data-ref="board"] [data-board="new"]', { timeout: 8000 });
    check('Settings: the "Family board" card, what it is, and Make the board link',
      (await tc(page, '#setBoard')) === 'Family board' && /A screen the whole house can see/.test(await tc(page, '[data-ref="board"]'))
      && (await tc(page, '[data-board="new"]')) === 'Make the board link', await tc(page, '[data-ref="board"]'));
    await page.click('[data-board="new"]');
    await page.waitForSelector('[data-board="copy"]', { timeout: 5000 });
    link = await tc(page, '.set-board-url');
    const row = await one('select token, created_by from family_board');
    check('Make: one link, made by Alex, its code in the address (board.html?b=…)',
      !!row && /^[0-9a-f]{32}$/.test(row.token) && link.endsWith(`/board.html?b=${row.token}`) && row.created_by === 'alex@example.com', link);
    check('... the toast, and Copy link, Open the board, New link and Turn off', (await lastToast(page)) === 'Board link made'
      && same(await texts(page, '[data-ref="board"] .set-actions [data-board]'), ['Copy link', 'Open the board', 'New link', 'Turn off']));
    await page.click('[data-board="copy"]');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check('Copy link: the address on the clipboard', copied === link, copied);
    await shot(page, 'board-settings');
    check('alex: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('the board on the wall', async () => {
    await h.setClock(at('2026-11-03', '07:05'));
    await h.mark();
    const path = link.slice(link.indexOf('/board.html'));
    const { page, context } = await open({ path, label: 'board-wall' });
    await page.waitForSelector('.bd-cols', { timeout: 8000 });
    check('the board (no sign-in): the household\'s date and clock', (await tc(page, '.bd-date')) === 'Tuesday, November 3' && /^7:0\dam$/.test(await tc(page, '.bd-clock')),
      [await tc(page, '.bd-date'), await tc(page, '.bd-clock')]);
    check('... Family, then each person on the family list, by first name', same(await texts(page, '.bd-name'), ['Family', 'Alex', 'Morgan', 'Sam', 'Jordan', 'Taylor']),
      await texts(page, '.bd-name'));
    const col = (p) => `.bd-col[data-person="${p.id}"]`;
    check('Sam\'s dentist: "10:00am Private item", nothing of its title or notes on the page',
      same(await texts(page, `${col(P.sam)} .bd-item`), ['10:00am Private item']) && !/Dentist|Cleaning/.test(await tc(page, '#app')), await texts(page, `${col(P.sam)} .bd-item`));
    check('Jordan: his routine ("0 of 2", Morning open) and his trash to tick',
      (await tc(page, `${col(P.jordan)} .bd-rt .bd-count`)) === '0 of 2' && (await page.$eval(`${col(P.jordan)} .bd-sec`, (e) => e.open))
      && same(await texts(page, `${col(P.jordan)} .bd-items .bd-item`), ['Take out trash']));
    await page.click(`${col(P.jordan)} [data-act="tick"]`);
    await until(async () => (await sql(`select 1 from task_log l join tasks t on t.id = l.task_id where t.title = 'Take out trash' and l.done_by = 'Family board'`)).length === 1
      && /Done: Take out trash/.test(await lastToast(page)), 6000);
    check('the trash ticked on the board: done by "Family board", the toast with Undo',
      (await sql(`select 1 from task_log l join tasks t on t.id = l.task_id where l.done_by = 'Family board'`)).length === 1 && /Done: Take out trash/.test(await lastToast(page)));
    await page.click('.toasts .toast-action .toast-btn:not(.toast-x)');
    await until(async () => (await sql('select 1 from task_log')).length === 0 && !!(await page.$(`${col(P.jordan)} [data-act="tick"]`)), 6000);
    check('Undo: the entry gone and the trash back to tick', (await sql('select 1 from task_log')).length === 0 && !!(await page.$(`${col(P.jordan)} [data-act="tick"]`)));
    await page.click(`${col(P.jordan)} .bd-sec[open] [data-act="rt"]`);
    await until(async () => (await sql(`select 1 from routine_ticks where who = 'Family board'`)).length === 1 && (await tc(page, `${col(P.jordan)} .bd-rt .bd-count`)) === '1 of 2', 6000);
    check('a routine item ticked on the board: "Family board", "1 of 2"', (await tc(page, `${col(P.jordan)} .bd-rt .bd-count`)) === '1 of 2');
    await shot(page, 'board-wall');
    check('the board: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('a new link, then off', async () => {
    await h.mark();
    const old = link.slice(link.indexOf('/board.html'));
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'board-alex-again' });
    await page.waitForSelector('[data-board="new"]', { timeout: 8000 });
    await page.click('[data-board="new"]');
    await until(async () => (await tc(page, '.set-board-url')) !== link && /board\.html\?b=[0-9a-f]{32}$/.test(await tc(page, '.set-board-url')), 6000);
    const row = await one('select token from family_board');
    check('New link: a new code, the card shows it', (await tc(page, '.set-board-url')).endsWith(`/board.html?b=${row.token}`) && !link.endsWith(row.token));
    const wall = await open({ path: old, label: 'board-old-link' });
    await until(async () => /isn't working/.test(await tc(wall.page, '.bd-problem')), 6000);
    check('... the old link says it isn\'t working', /isn't working/.test(await tc(wall.page, '.bd-problem')), await tc(wall.page, '#app'));
    await wall.context.close();
    await page.click('[data-board="off"]');
    await until(async () => !!(await page.$('[data-board="new"]')) && !(await page.$('[data-board="copy"]')), 6000);
    check('Turn off: no link kept, the card offers Make the board link again', !(await one('select 1 as x from family_board')) && (await tc(page, '[data-board="new"]')) === 'Make the board link');
    check('alex again: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await h.finish();
})().catch((err) => {
  console.log(`FAIL  board: ${String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ')}`);
  process.exit(1);
});
