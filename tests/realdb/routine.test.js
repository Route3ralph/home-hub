// The routine (v1.3, migration 0019, docs/v1.3-homework.md §24) against the REAL database (tests/realdb/run.sh):
//   Tue Nov 3, 7:00am  Alex writes Jordan's routine on the Homework page (Switches → Write the routine): two sections,
//                      a tag, a school-days item and two groups, 2 points a finished section; the tables hold it as
//                      written, and the row says "Today: 0 of 4".
//   Tue Nov 3, 7:05am  Jordan's My day (a phone): the card, Morning open and Before bed folded; he ticks both of
//                      Morning's items: the second pays +2 ("Morning done: +2 points"), Morning folds and Before bed
//                      opens; his card's balance says so; unticking keeps the points.
//   Sat Nov 7, 9:00am  His Saturday: Morning without the school-days item, nothing ticked (a new day).
//   Then Alex opens the editor again: each section reads back as written.
// Everything is made up. Screenshots: tests/e2e/shots/realdb-routine-*.png.
const { setup } = require('./lib');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// New York is on standard time from Nov 1: 7:00am is 12:00 UTC.
const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;

(async () => {
  const h = await setup('routine');
  const { check, flow, sql, open, tc, texts, lastToast, until, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };
  const items = () => sql(`select s.pos as spos, s.title as section, s.note, i.pos, i.title, i.tag, i.part, i.school_days from routine_items i
    join routine_sections s on s.id = i.section_id where s.kid_id = '${P.jordan.id}' order by s.pos, i.pos`);
  const MORNING = 'Make bed\nOut of the house (30 min early) *';
  const NIGHT = 'Pack up:\nBag packed\nWind down:\nLights out';

  await h.setClock(at('2026-11-03', '07:00'));
  await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });

  await flow('alex writes it', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'routine-alex' });
    await page.waitForSelector('[data-row="routine"] [data-act="routine-edit"]', { timeout: 8000 });
    check('Switches: "Routine", what it is, and Write the routine', (await tc(page, '[data-row="routine"] [data-act="routine-edit"]')) === 'Write the routine'
      && /^A checklist of Jordan's day on his My day/.test(await tc(page, '[data-row="routine"] .hw-switch-line')), await tc(page, '[data-row="routine"]'));
    await page.click('[data-act="routine-edit"]');
    await page.waitForSelector('form[data-form="routine"]', { timeout: 5000 });
    const F = 'form[data-form="routine"]';
    check('... the editor starts with one section, "Morning"', (await page.$eval(`${F} [name="rt_title_0"]`, (e) => e.value)) === 'Morning');
    await page.fill(`${F} [name="rt_note_0"]`, 'At home');
    await page.fill(`${F} [name="rt_items_0"]`, MORNING);
    await page.click(`${F} [data-act="routine-add"]`);
    await page.waitForSelector(`${F} [name="rt_title_1"]`, { timeout: 5000 });
    check('+ Section keeps what was typed above it', (await page.$eval(`${F} [name="rt_items_0"]`, (e) => e.value)) === MORNING);
    await page.fill(`${F} [name="rt_title_1"]`, 'Before bed');
    await page.fill(`${F} [name="rt_items_1"]`, NIGHT);
    await page.fill(`${F} [name="rt_points"]`, '2');
    await page.click(`${F} button[type="submit"]`);
    await until(async () => (await sql(`select 1 from routine_items`)).length === 4 && !(await page.$(F)), 6000);
    check('Save: the routine as written (sections in order, the note, the tag, the school-days item, the two groups)', same(await items(), [
      { spos: '1', section: 'Morning', note: 'At home', pos: '1', title: 'Make bed', tag: null, part: null, school_days: 'f' },
      { spos: '1', section: 'Morning', note: 'At home', pos: '2', title: 'Out of the house', tag: '30 min early', part: null, school_days: 't' },
      { spos: '2', section: 'Before bed', note: null, pos: '1', title: 'Bag packed', tag: null, part: 'Pack up', school_days: 'f' },
      { spos: '2', section: 'Before bed', note: null, pos: '2', title: 'Lights out', tag: null, part: 'Wind down', school_days: 'f' }]), await items());
    check('... 2 points a finished section; the toast; the row: "Today: 0 of 4 · Morning 0/2 · Before bed 0/2" and the points',
      (await one(`select routine_points from homework_kids where kid_id = '${P.jordan.id}'`)).routine_points === '2'
      && (await lastToast(page)) === 'Saved Jordan\'s routine'
      && (await tc(page, '[data-row="routine"] small.hw-switch-line')) === 'Today: 0 of 4 · Morning 0/2 · Before bed 0/2'
      && (await texts(page, '[data-row="routine"] p.hw-switch-line')).includes('Each section he finishes: +2 points, once a day.'),
      [await lastToast(page), await tc(page, '[data-row="routine"]')]);
    await shot(page, 'routine-alex');
    check('alex: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('jordan ticks', async () => {
    await h.setClock(at('2026-11-03', '07:05'));
    await h.mark();
    const { page, context } = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}`, label: 'routine-jordan' });
    await page.waitForSelector('.rt-card', { timeout: 8000 });
    const openParts = () => page.$$eval('.rt-sec', (es) => es.map((e) => [e.querySelector('.rt-title').textContent, e.open]));
    check('My day: "My routine · 0 of 4", the points line, Morning open and Before bed folded', (await tc(page, '#rt-h')) === 'My routine' && (await tc(page, '.rt-total')) === '0 of 4'
      && (await tc(page, '.rt-hint')) === 'Each section you finish: +2 points' && same(await openParts(), [['Morning', true], ['Before bed', false]]), await tc(page, '.rt-card'));
    check('... the routine sits above his homework card', await page.$eval('.rt-card', (e) => !!e.nextElementSibling && e.nextElementSibling.classList.contains('hw-card')));
    check('... Morning\'s items, with the tag', same(await texts(page, '.rt-sec[open] .rt-item'), ['Make bed', 'Out of the house30 min early']), await texts(page, '.rt-sec[open] .rt-item'));
    await page.click('.rt-sec[open] .rt-item:nth-of-type(1)');
    await until(async () => (await sql(`select 1 from routine_ticks`)).length === 1, 5000);
    await until(async () => (await tc(page, '.rt-total')) === '1 of 4', 5000);
    check('Make bed: ticked, "1 of 4", nothing paid', (await page.$eval('.rt-item', (e) => e.getAttribute('aria-checked'))) === 'true'
      && !(await one(`select 1 as x from points_ledger where kind = 'routine'`)));
    const before = Number((await one(`select coalesce(sum(delta), 0) as n from points_ledger where kid_id = '${P.jordan.id}'`)).n);
    await page.click('.rt-sec[open] .rt-item:nth-of-type(2)');
    await until(async () => (await lastToast(page)) === 'Morning done: +2 points', 5000);
    const led = await one(`select kind, delta, note, who from points_ledger where kind = 'routine'`);
    check('Out of the house: Morning finished, "+2 points" once (as his), Morning folds and Before bed opens',
      same(led, { kind: 'routine', delta: '2', note: 'Morning', who: 'Jordan (My day)' }) && same(await openParts(), [['Morning', false], ['Before bed', true]])
      && /✓ 2 of 2 · \+2/.test(await tc(page, '.rt-sec:first-of-type .rt-count')), [led, await openParts(), await tc(page, '.rt-sec:first-of-type .rt-count')]);
    check('... his balance up by 2', Number((await one(`select coalesce(sum(delta), 0) as n from points_ledger where kid_id = '${P.jordan.id}'`)).n) === before + 2);
    await shot(page, 'routine-jordan');
    // Untick: the points stay; the part he opens by hand stays open.
    await page.click('.rt-sec:first-of-type summary');
    await until(async () => same(await openParts(), [['Morning', true], ['Before bed', true]]), 5000);
    await page.click('.rt-sec:first-of-type .rt-item:nth-of-type(2)');
    await until(async () => (await tc(page, '.rt-total')) === '1 of 4', 5000);
    check('untick: "1 of 4", the points stay (one routine entry)', (await sql(`select 1 from points_ledger where kind = 'routine'`)).length === 1);
    check('jordan: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('his saturday', async () => {
    await h.setClock(at('2026-11-07', '09:00'));
    await h.mark();
    const { page, context } = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}`, label: 'routine-saturday' });
    await page.waitForSelector('.rt-card', { timeout: 8000 });
    check('Saturday: "0 of 3", Morning without the school-days item', (await tc(page, '.rt-total')) === '0 of 3' && same(await texts(page, '.rt-sec:first-of-type .rt-item'), ['Make bed']),
      [await tc(page, '.rt-total'), await texts(page, '.rt-sec:first-of-type .rt-item')]);
    await context.close();
  });

  await flow('alex reads it back', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'routine-alex-again' });
    await page.waitForSelector('[data-row="routine"] [data-act="routine-edit"]', { timeout: 8000 });
    check('Change the routine (it has one now)', (await tc(page, '[data-act="routine-edit"]')) === 'Change the routine');
    await page.click('[data-act="routine-edit"]');
    await page.waitForSelector('form[data-form="routine"]', { timeout: 5000 });
    const F = 'form[data-form="routine"]';
    const vals = await page.$$eval(`${F} textarea`, (es) => es.map((e) => e.value));
    check('the editor reads each section back as written', same(vals, [MORNING, NIGHT]), vals);
    await page.click(`${F} [data-act="routine-cancel"]`);
    check('Cancel: no form, nothing sent', !(await page.$(F)));
    check('alex again: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await h.finish();
})().catch((err) => {
  console.log(`FAIL  routine: ${String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ')}`);
  process.exit(1);
});
