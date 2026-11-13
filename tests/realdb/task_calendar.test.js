// Tasks on the calendar (migration 0027, docs/v2-design.md §33) against the REAL database (tests/realdb/run.sh):
//   Fri Nov 13, 9:00am  Two tasks due Mon Nov 16, one ticked "Show on the calendar": Alex's Calendar shows that one
//                       only (the real column and the page's read), while agenda (Today, My day, the emails) still
//                       lists both, so nothing is forgotten.
//   Then Alex ticks the other on the Tasks page's form (the real update): the Calendar shows both.
// Everything is made up.
const { setup } = require('./lib');

const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;

(async () => {
  const h = await setup('task_calendar');
  const { check, flow, sql, open, until } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);

  await h.setClock(at('2026-11-13', '09:00'));
  await sql(`insert into tasks (title, due_date) values ('Call the plumber', '2026-11-16')`);
  await sql(`insert into tasks (title, due_date, on_calendar) values ('Dentist forms', '2026-11-16', true)`);

  await flow('only the ticked task is on the calendar', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/calendar/2026-11-16', label: 'task-cal-alex' });
    await page.waitForSelector('.cal-panel', { timeout: 8000 });
    await until(async () => (await page.textContent('.cal-panel') || '').includes('Dentist forms'));
    let panel = (await page.textContent('.cal-panel')) || '';
    check('the Calendar (real column, real read): Dentist forms (ticked) on Nov 16, Call the plumber not', panel.includes('Dentist forms') && !panel.includes('Call the plumber'), panel.slice(0, 300));
    const both = await one(`select string_agg(title, ', ' order by title) as t from agenda('2026-11-16', '2026-11-16') where kind = 'task'`);
    check('... agenda (Today, My day and the emails read it) still has both', both && both.t === 'Call the plumber, Dentist forms', JSON.stringify(both));
    const plumber = (await one(`select id from tasks where title = 'Call the plumber'`)).id;
    await page.evaluate((id) => HomeHub.core.use('tasks').openTaskForm({ id }), plumber);
    await page.waitForSelector('.tasks-form [name="on_calendar"]', { timeout: 5000 });
    check('the task form: Show on the calendar, not ticked', !(await page.isChecked('.tasks-form [name="on_calendar"]')));
    await page.check('.tasks-form [name="on_calendar"]');
    await page.click('.tasks-form [type="submit"]');
    await until(async () => !!(await one(`select 1 from tasks where title = 'Call the plumber' and on_calendar`)));
    check('ticked and saved (the real update): on_calendar true', !!(await one(`select 1 from tasks where title = 'Call the plumber' and on_calendar`)));
    await page.goto(`${h.base}/#/calendar/2026-11-16`);
    await page.waitForSelector('.cal-panel', { timeout: 8000 });
    await until(async () => (await page.textContent('.cal-panel') || '').includes('Call the plumber'));
    panel = (await page.textContent('.cal-panel')) || '';
    check('... the Calendar shows both now', panel.includes('Dentist forms') && panel.includes('Call the plumber'), panel.slice(0, 300));
    check('alex: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await h.finish();
})();
