// The family's key flows against the REAL database (tests/realdb/run.sh): the real schema, migrations,
// row-level security and functions, through a PostgREST/Auth stand-in (server.js). Every write is
// checked in the tables themselves, as the database keeps them. The database has every migration, so
// it is on schema 4: v1.2's Food page, Taylor's list on her My day and dinners are here too.
//
// The household (seed_v1.sql, the migration's own seeding, seed_v2.sql): Alex and Morgan (parents,
// admins), Sam (adult, member), Jordan (kid), Taylor (helper, Spanish); Pat Lee and Maria Gomez
// (contractors), Rivera Music, Example Water Co (an account with an account number); the kitchen
// project (shared, schedule from Mon Oct 26) and the pool project. The household's clock starts on
// Tue 2026-10-27 at 09:00 in New York; the browsers run in Los Angeles.
const { setup } = require('./lib');

const TODAY = '2026-10-27';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What My day may call: the anon token functions (v1.2 adds the shopping list's three).
const MY_DAY_FNS = /^\/rest\/v1\/rpc\/(get_person_day|complete_by_token|undo_by_token|confirm_digest|stop_digest|get_list_by_token|add_to_list_by_token|buy_item_by_token)$/;

(async () => {
  const h = await setup('flows');
  const { check, flow, sql, open, settle, go, tc, texts, lastToast, titles, until, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql("select id, name from people")) P[r.name.split(' ')[0].toLowerCase()] = r.id;
  const chip = (id) => `.today-chips .pchip[data-person="${id}"]`;
  const dayTitles = (page) => titles(page, '[data-list="day"]');
  // API requests that failed since the last mark, as "METHOD path → status code message".
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code} ${r.error.message || r.error.msg}` : ''}`);

  // ===================================================================
  // Sign in with a code
  // ===================================================================
  await flow('sign-in', async () => {
    await h.mark();
    const { page, context } = await open({ path: '/', label: 'sign-in' });
    await page.fill('#loginForm input[name="email"]', 'stranger@example.com');
    await page.click('#loginForm button');
    await until(async () => !!(await tc(page, '#loginMsg')));
    // The hook refuses anyone without a sign-in (someone on the Family page without "Can sign in" too),
    // so the page says what to ask for.
    check('sign-in: an email without a sign-in is refused by the signup hook, in plain words (ask for "Can sign in")',
      /can't sign in yet/.test(await tc(page, '#loginMsg')) && /'Can sign in'/.test(await tc(page, '#loginMsg')), await tc(page, '#loginMsg'));
    await page.fill('#loginForm input[name="email"]', 'Alex@Example.com');
    await page.click('#loginForm button');
    await page.waitForSelector('#codeForm:not([hidden])', { timeout: 5000 });
    await page.fill('#codeForm input[name="code"]', '123 456');
    await page.click('#codeForm button[type="submit"]');
    await page.waitForSelector('.today-head', { timeout: 10000 });
    await settle(page, 600);
    check('sign-in: the code signs Alex in and the v2 Today page shows (schema version 4 from the real database: migration 0004)',
      (await page.evaluate(() => HomeHub.core.schemaVersion)) === 4 && /Good morning, Alex/.test(await tc(page, '#main h1')), await tc(page, '#main h1'));
    check('sign-in: Today shows the household\'s date (Tuesday, October 27)', /Tuesday, October 27/.test(await tc(page, '.today-head .eyebrow')), await tc(page, '.today-head .eyebrow'));
    const alex = await one(`select email_verified_at is not null as ok, (select token from people_confirm c where c.person_id = p.id) as secret from people p where email = 'alex@example.com'`);
    const again = alex.secret ? await h.api('/rest/v1/rpc/confirm_digest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_confirm: alex.secret }) }) : null;
    check('sign-in: mark_signed_in confirmed Alex\'s address and kept his confirmation secret (an earlier email\'s button still says "confirmed")',
      alex.ok === 't' && !!again && again.status === 200 && again.body === true, { alex, again });
    const bad = (await failures()).filter((f) => !/\/auth\/v1\/otp\S* → 403/.test(f));
    check('sign-in: no API request failed (other than the stranger\'s code)', !bad.length, bad);
    await shot(page, 'today-signed-in');
    await context.close();
  });

  // ===================================================================
  // Today, for each person chip
  // ===================================================================
  await flow('today chips', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/', label: 'today' });
    const seen = {};
    for (const [name, id] of Object.entries(P)) {
      if (name === 'alex') continue;
      await page.click(chip(id));
      await settle(page, 150);
      seen[name] = await tc(page, '.today-sec .sec-head span');
    }
    await page.click('.today-chips [data-view="all"]');
    await settle(page, 150);
    seen.everyone = await tc(page, '.today-sec .sec-head span');
    await page.click('.today-chips [data-view="me"]');
    await settle(page, 150);
    seen.me = await tc(page, '.today-sec .sec-head span');
    check('today: every person chip, Everyone and Me show their day', same(Object.keys(seen).sort(), ['everyone', 'jordan', 'me', 'morgan', 'sam', 'taylor'])
      && seen.jordan === 'Jordan\'s day' && seen.me === 'Your day' && seen.everyone === 'Everyone today', seen);
    const projLine = await tc(page, '.today-projects');
    // Design consult started Mon Oct 26, so on Tue Oct 27 it is in progress: the line counts it (or names it).
    check('today: the kitchen project\'s line (task dates filled in from the stale v1 ones)', /Kitchen Renovation:.*(Design consult|1 in progress)/.test(projLine), projLine);
    const kitchen = await one("select task_dates is not null as dated, task_dates_at is not null as at from projects where name = 'Kitchen Renovation'");
    check('today: the backfill wrote task_dates and task_dates_at to the real row', kitchen.dated === 't' && kitchen.at === 't', kitchen);
    const f = await failures();
    check('today: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Piano every Tuesday at 4pm: Taylor (helper) in charge, Jordan (kid) with her
  // ===================================================================
  let piano = null;
  await flow('piano', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', phone: true, path: '/', label: 'piano' });
    await page.click('.bb-add');
    await page.waitForTimeout(200);
    await page.click('#sheet [data-add="event"]');
    await page.waitForSelector('.cal-form');
    await page.fill('.cal-form [name="title"]', 'Piano');
    await page.fill('.cal-form [name="start_time"]', '16:00');
    await page.click(`.cal-form [data-ref="who"] .pchip[data-person="${P.taylor}"]`);
    await page.click(`.cal-form [data-ref="who"] .pchip[data-person="${P.jordan}"]`);
    await page.click('.cal-form [data-preset="weekly"]');
    await page.click('.cal-form .cal-more summary');
    await page.fill('.cal-form [name="end_time"]', '17:00');
    await page.fill('.cal-form [name="location"]', 'Music school');
    await page.click('.cal-form [type="submit"]');
    await settle(page, 600);
    piano = await one("select id, start_date, start_time, end_time, repeat, repeat_every, repeat_weekdays, responsible_id, participant_ids, location, created_by from events where title = 'Piano'");
    check('piano: saved in events as the database keeps it (weekly on Tuesdays, 16:00–17:00, Taylor with Jordan, created_by Alex)', !!piano && same(
      [piano.start_date, piano.start_time, piano.end_time, piano.repeat, piano.repeat_every, piano.repeat_weekdays, piano.responsible_id, piano.participant_ids, piano.created_by],
      [TODAY, '16:00:00', '17:00:00', 'weekly', '1', '{2}', P.taylor, `{${P.jordan}}`, 'alex@example.com']), piano);
    check('piano: "Added Piano · Tue Oct 27"', (await lastToast(page)) === 'Added Piano · Tue Oct 27', await lastToast(page));
    await page.click(chip(P.taylor));
    await settle(page, 150);
    const taylorDay = await dayTitles(page);
    await page.click(chip(P.jordan));
    await settle(page, 150);
    const jordanDay = await dayTitles(page);
    check('piano: on Today for Taylor and for Jordan', taylorDay.includes('Piano') && jordanDay.includes('Piano'), `${taylorDay} / ${jordanDay}`);
    const row = await page.$eval('[data-list="day"] .irow', (r) => ({ time: r.querySelector('.irow-time').innerText.replace(/\s+/g, ' '), who: [...r.querySelectorAll('.irow-who .pdot')].map((d) => d.title) }));
    check('piano: the row reads 4:00pm–5:00pm, Taylor in charge and Jordan (from the real agenda times, on a Los Angeles phone)',
      same(row, { time: '4:00pm 5:00pm', who: ['Taylor Example, in charge', 'Jordan Example'] }), row);
    await page.click('.today-chips [data-view="me"]');
    await settle(page, 200);
    const wa = await page.getAttribute(`[data-send="${P.taylor}"] [data-via="whatsapp"]`, 'href').catch(() => null);
    const text = wa ? decodeURIComponent(wa.split('?text=')[1]) : null;
    const dbText = (await one(`select public.day_text('${P.taylor}', '${TODAY}') as t`)).t;
    check('piano: "Send Taylor their day" carries the real day_text, which has Piano at 4:00pm (in Spanish: 16:00)', !!text && text === dbText && /16:00 Piano/.test(text), text);

    // The Calendar: this week (Mon Oct 26–Sun Nov 1, the week the clocks go back), and next week.
    await page.click('.bottombar a[data-tab="calendar"]');
    await settle(page);
    const week = await titles(page, `[data-list="${TODAY}"]`);
    const agendaCall = (await h.requests()).filter((r) => r.path === '/rest/v1/rpc/agenda').slice(-1)[0];
    check('piano: the Calendar week has Piano on Tuesday, read with agenda(Mon Oct 26, Sun Nov 1)', week.includes('Piano')
      && agendaCall && same(JSON.parse(agendaCall.body), { p_from: '2026-10-26', p_to: '2026-11-01' }), `${week} ${agendaCall && agendaCall.body}`);
    await go(page, '#/calendar/2026-11-03');
    const next = await page.$$eval('[data-list="2026-11-03"] .irow', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
    check('piano: after the clocks go back, Tue Nov 3 still shows 4:00pm', next.some((t) => /4:00pm/.test(t) && /Piano/.test(t)), next);
    const f = await failures();
    check('piano: no API request failed', !f.length, f);
    await context.close();
  });

  // Change one day (Nov 3: 5–6pm) and skip one day (Nov 10).
  await flow('piano change and skip', async () => {
    if (!piano) throw new Error('no Piano event');
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/calendar/event/${piano.id}/2026-11-03`, label: 'piano-change' });
    await page.waitForSelector('#detail [data-ev="change"]', { timeout: 5000 });
    await page.click('#detail [data-ev="change"]');
    await page.waitForSelector('#formDialog .cal-form');
    await page.fill('#formDialog [name="start_time"]', '17:00');
    await page.fill('#formDialog [name="end_time"]', '18:00');
    await page.click('#formDialog [type="submit"]');
    await settle(page, 500);
    const ch = await one(`select on_date, cancelled, start_time, end_time, responsible_id, participant_ids from event_changes where event_id = '${piano.id}' and on_date = '2026-11-03'`);
    check('piano: Change this day wrote one event_changes row (17:00–18:00, same people)', !!ch && same([ch.cancelled, ch.start_time, ch.end_time, ch.responsible_id, ch.participant_ids], ['f', '17:00:00', '18:00:00', null, null]), ch);
    const occ = await one(`select local_start, changed, status from agenda('2026-11-03', '2026-11-03') where item_id = '${piano.id}'`);
    check('piano: the real agenda has Nov 3 at 17:00, changed', !!occ && occ.local_start === '17:00:00' && occ.changed === 't', occ);
    await go(page, `#/calendar/event/${piano.id}/2026-11-10`);
    await page.waitForSelector('#detail [data-ev="skip"]', { timeout: 5000 });
    await page.click('#detail [data-ev="skip"]');
    await settle(page, 500);
    const sk = await one(`select cancelled from event_changes where event_id = '${piano.id}' and on_date = '2026-11-10'`);
    const occ2 = await one(`select status from agenda('2026-11-10', '2026-11-10') where item_id = '${piano.id}'`);
    check('piano: Skip this day cancels Nov 10 (event_changes, and the agenda says cancelled)', sk && sk.cancelled === 't' && occ2 && occ2.status === 'cancelled', { sk, occ2 });
    check('piano: "Skipped Piano on Tue Nov 10" with Undo', /^Skipped Piano on Tue Nov 10/.test(await lastToast(page)), await lastToast(page));
    await page.click('.toasts .toast-action .toast-btn');
    await settle(page, 500);
    const back = await one(`select count(*) as n from event_changes where event_id = '${piano.id}' and on_date = '2026-11-10'`);
    check('piano: Undo puts Nov 10 back (the change row is gone)', back.n === '0', back);
    await go(page, `#/calendar/event/${piano.id}/2026-11-10`);
    await page.waitForSelector('#detail [data-ev="skip"]', { timeout: 5000 });
    await page.click('#detail [data-ev="skip"]');
    await settle(page, 500);
    const f = await failures();
    check('piano change/skip: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Heartworm pill on set dates, monthly, for Taylor: tick on Today, Undo; tick on Tasks, Undo;
  // Done on another day; Skip
  // ===================================================================
  let pill = null;
  const pillRow = () => one("select id, due_date, anchor_date, last_done, repeat_mode, every_count, every_unit, responsible_id, category, active from tasks where title = 'Heartworm pill'");
  const logRows = async (id) => sql(`select status, occurrence, done_on, done_by from task_log where task_id = '${id}' order by seq`);
  await flow('heartworm', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', phone: true, path: '/', label: 'heartworm' });
    await page.click('.bb-add');
    await page.waitForTimeout(200);
    await page.click('#sheet [data-add="task"]');
    await page.waitForSelector('.tasks-form');
    await page.fill('.tasks-form [name="title"]', 'Heartworm pill');
    await page.click(`.tasks-form [data-ref="who"] .pchip[data-person="${P.taylor}"]`);
    await page.click('.tasks-form [data-mode="schedule"]');
    await page.click('.tasks-form [data-when="today"]');
    await page.fill('.tasks-form [name="every_count"]', '1');
    await page.selectOption('.tasks-form [name="every_unit"]', 'month');
    await page.click('.tasks-form .tasks-more summary');
    await page.selectOption('.tasks-form [name="category"]', 'pets');
    await page.click('.tasks-form [type="submit"]');
    await settle(page, 600);
    pill = await pillRow();
    check('heartworm: saved on set dates, every 1 month, due and anchored today, Taylor, pets', !!pill && same(
      [pill.repeat_mode, pill.every_count, pill.every_unit, pill.due_date, pill.anchor_date, pill.responsible_id, pill.category],
      ['schedule', '1', 'month', TODAY, TODAY, P.taylor, 'pets']), pill);

    // Tick on Today, then Undo.
    await page.click('.bottombar a[data-tab="today"]');
    await settle(page);
    await page.click(chip(P.taylor));
    await settle(page, 150);
    await page.locator('[data-list="day"] .irow', { hasText: 'Heartworm pill' }).locator('.irow-check').click();
    await until(async () => /^Done: Heartworm pill/.test(await lastToast(page)));
    let t = await pillRow();
    let log = await logRows(pill.id);
    check('heartworm: ticked on Today: due Nov 27, last done today, a "done" log row by Alex', t.due_date === '2026-11-27' && t.last_done === TODAY
      && same(log, [{ status: 'done', occurrence: TODAY, done_on: TODAY, done_by: 'alex@example.com' }]), { t, log });
    await settle(page, 300);
    const rowClass = await page.locator('[data-list="day"] .irow', { hasText: 'Heartworm pill' }).getAttribute('class').catch(() => 'missing');
    check('heartworm: after the tick, Today shows it done (from the real agenda\'s task_log row)', /st-done/.test(rowClass), rowClass);
    await page.click('.toasts .toast-action .toast-btn');
    await until(async () => (await pillRow()).due_date === TODAY);
    t = await pillRow();
    log = await logRows(pill.id);
    check('heartworm: Undo on Today puts it back (due today, never done, no log)', t.due_date === TODAY && t.last_done === null && !log.length, { t, log });

    // Tick on Tasks, then Undo.
    await go(page, '#/tasks/everyone');
    await page.locator('.tasks-body .irow', { hasText: 'Heartworm pill' }).first().locator('.irow-check').click();
    await until(async () => /^Done: Heartworm pill/.test(await lastToast(page)));
    t = await pillRow();
    check('heartworm: ticked on Tasks: due Nov 27; the toast says "next Nov 27"', t.due_date === '2026-11-27' && /next Nov 27/.test(await lastToast(page)), `${t.due_date} ${await lastToast(page)}`);
    await page.click('.toasts .toast-action .toast-btn');
    await until(async () => (await pillRow()).due_date === TODAY);
    t = await pillRow();
    check('heartworm: Undo on Tasks puts it back', t.due_date === TODAY && t.last_done === null, t);

    // Done on another day (yesterday, Oct 26).
    await go(page, `#/tasks/${pill.id}`);
    await page.waitForSelector('#detail [data-act="another"]', { timeout: 5000 });
    await page.click('#detail [data-act="another"]');
    await page.fill('#detail [name="done_on"]', '2026-10-26');
    await page.click('#detail [data-act="done-on"]');
    await until(async () => /^Done on Oct 26/.test(await lastToast(page)));
    t = await pillRow();
    log = await logRows(pill.id);
    check('heartworm: Done on another day (Oct 26): last done Oct 26, next due Nov 27 (on set dates), logged for Oct 27',
      t.last_done === '2026-10-26' && t.due_date === '2026-11-27' && log.length === 1 && log[0].done_on === '2026-10-26' && log[0].occurrence === TODAY, { t, log, toast: await lastToast(page) });
    await page.click('.toasts .toast-action .toast-btn');
    await until(async () => (await pillRow()).due_date === TODAY);

    // Skip this time.
    await go(page, `#/tasks/${pill.id}`);
    await page.waitForSelector('#detail [data-act="skip"]', { timeout: 5000 });
    await page.click('#detail [data-act="skip"]');
    await until(async () => /^Skipped: Heartworm pill/.test(await lastToast(page)));
    t = await pillRow();
    log = await logRows(pill.id);
    check('heartworm: Skip this time: due Nov 27, not marked done, a "skipped" log row', t.due_date === '2026-11-27' && t.last_done === null
      && log.length === 1 && log[0].status === 'skipped' && log[0].occurrence === TODAY, { t, log });
    await settle(page, 300);
    const done = await page.$$eval('.tasks-body .irow', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')).filter((x) => /Heartworm/.test(x)));
    check('heartworm: the Tasks page lists the skip under Done', done.some((x) => /Skipped/.test(x)), done);
    // Put it back to due today for My day later.
    await page.click('.toasts .toast-action .toast-btn').catch(() => {});
    await until(async () => (await pillRow()).due_date === TODAY);
    const f = await failures();
    check('heartworm: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // The starter list: staggered first dates, to the household's pet and house owners
  // ===================================================================
  await flow('starter list', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/tasks/repeating', label: 'starter' });
    await page.click('[data-act="starter"]');
    await page.waitForSelector('.tasks-starter');
    const owners = await texts(page, '.tasks-starter .tasks-hint');
    check('starter: Sam will be in charge of the house jobs and Taylor of the pets (Settings\' owners)', /^Sam will be in charge/.test(owners[0] || '') && /^Taylor will be in charge/.test(owners[1] || ''), owners);
    await page.click('.tasks-starter [data-act="all"]');
    await page.click('.tasks-starter [type="submit"]');
    await settle(page, 800);
    const rows = await sql(`select title, category, responsible_id, due_date, repeat_mode, every_count, every_unit, lead_days, anchor_date
      from tasks where created_at > now() - interval '1 hour' and title <> 'Heartworm pill' order by due_date, title`);
    const wrongOwner = rows.filter((r) => r.responsible_id !== (r.category === 'pets' ? P.taylor : P.sam));
    const perDay = {};
    rows.forEach((r) => { perDay[r.due_date] = (perDay[r.due_date] || 0) + 1; });
    const crowded = Object.entries(perDay).filter(([, n]) => n > 2);
    check('starter: every starter task was added (the rest of the list, 19 or 20)', rows.length >= 19, rows.length);
    check('starter: pets go to Taylor, home to Sam', !wrongOwner.length, wrongOwner.map((r) => r.title));
    check('starter: first dates start tomorrow at the earliest, at most 2 a day', rows.every((r) => r.due_date > TODAY) && !crowded.length, { crowded, first: rows[0] && rows[0].due_date });
    check('starter: each anchored on its first date', rows.every((r) => r.anchor_date === r.due_date), rows.filter((r) => r.anchor_date !== r.due_date).map((r) => r.title));
    check('starter: "Added N repeating tasks" with Undo', /^Added \d+ repeating tasks/.test(await lastToast(page)), await lastToast(page));
    const f = await failures();
    check('starter: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Directory: account numbers for admins only
  // ===================================================================
  const WATER = 'c0000000-0000-4000-8000-000000000004';
  await flow('directory', async () => {
    await h.mark();
    let { page, context } = await open({ email: 'alex@example.com', path: '/#/directory', label: 'directory-admin' });
    const card = `.dir-card[data-id="${WATER}"]`;
    check('directory admin: the water account\'s number is masked to its last 4', (await tc(page, `${card} .dir-acct-num`)) === '•••• 9876', await tc(page, `${card} .dir-acct-num`));
    await page.click(`${card} [data-show]`);
    check('directory admin: Show reveals it (read from contractor_secrets as an admin)', (await tc(page, `${card} .dir-acct-num`)) === '5555 0101 9876', await tc(page, `${card} .dir-acct-num`));
    await page.click('.dir-add');
    await page.waitForTimeout(300);
    await page.selectOption('#formDialog [name="kind"]', 'account');
    const acct = { name: 'Example Power & Light', category: 'Electric', phone: '(201) 555-0110', contract_end: '2026-11-15', account_number: '5555 0101 2468', account_name: 'Alex Example' };
    for (const [k, v] of Object.entries(acct)) await page.fill(`#formDialog [name="${k}"]`, v);
    await page.click('#formDialog [type="submit"]');
    await settle(page, 600);
    const power = await one(`select c.id, c.kind, c.contract_end, c.updated_by as created_by, s.account_number, s.account_name, s.updated_by from contractors c left join contractor_secrets s on s.contractor_id = c.id where c.name = '${acct.name}'`);
    check('directory admin: a new account and its number saved (contractors + contractor_secrets, stamped by Alex)', !!power && same(
      [power.kind, power.contract_end, power.account_number, power.account_name, power.updated_by, power.created_by], ['account', '2026-11-15', acct.account_number, acct.account_name, 'alex@example.com', 'alex@example.com']), power);
    let f = await failures();
    check('directory admin: no API request failed', !f.length, f);
    await context.close();

    await h.mark();
    ({ page, context } = await open({ email: 'sam@example.com', path: '/#/directory', label: 'directory-member' }));
    const reqs = await h.requests();
    check('directory member: the page never asks for contractor_secrets, and no number is in the page', !reqs.some((r) => /contractor_secrets/.test(r.path))
      && !(await page.content()).includes('9876') && !(await page.$(`${card} .dir-account`)), reqs.filter((r) => /secrets/.test(r.path)).map((r) => r.path));
    const direct = await h.api('/rest/v1/contractor_secrets?select=*', { headers: { authorization: `Bearer ${(await h.sessionFor('sam@example.com')).access_token}` } });
    check('directory member: reading contractor_secrets directly gives nothing (row-level security)', direct.status === 200 && same(direct.body, []), direct);
    await page.click(`${card} [data-edit]`);
    await page.waitForTimeout(300);
    await page.fill('#formDialog [name="phone"]', '(201) 555-0199');
    await page.click('#formDialog [type="submit"]');
    await settle(page, 500);
    const err = await tc(page, '#formDialog .form-error');
    const water = await one(`select phone from contractors where id = '${WATER}'`);
    check('directory member: changing an entry with account details is refused in plain words, and nothing changes', /Only an admin can change/.test(err) && water.phone === '(201) 555-0160', { err, water });
    await page.click('#formDialog [data-close]').catch(() => {});
    f = await failures();
    const refused = f.filter((x) => x.startsWith(`PATCH /rest/v1/contractors?id=eq.${WATER}`) && / → 403 42501 Only an admin can change Example Water Co/.test(x));
    check('directory member: the change was refused by the database (403, private.contractors_guard) and no other API request failed',
      refused.length === 1 && f.length === 1, f);
    await context.close();
  });

  // ===================================================================
  // Family: add a helper and a kid, no sign-in for a kid, a new My day link, remove
  // ===================================================================
  await flow('family', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/people', label: 'family' });
    await page.click('[data-act="add"]');
    await page.waitForTimeout(300);
    await page.fill('#formDialog input[name="name"]', 'Robin Example');
    await page.click('#formDialog label:has(> input[name="role"][value="helper"])');
    await page.fill('#formDialog input[name="phone"]', '(201) 555-0107');
    await page.click('#formDialog [type="submit"]');
    await settle(page, 500);
    const robin = await one("select id, role, phone, day_token, email, sort_order from people where name = 'Robin Example'");
    const robinLogin = await one("select count(*) as n from members where name like 'Robin%'");
    check('family: added Robin, a helper, with her phone and no sign-in', !!robin && robin.role === 'helper' && robin.phone === '(201) 555-0107' && robinLogin.n === '0', robin);
    check('family: "Added Robin Example" and her card shows', (await lastToast(page)) === 'Added Robin Example' && !!(robin && await page.$(`.ppl-card[data-id="${robin.id}"]`)), await lastToast(page));

    await page.click('[data-act="add"]');
    await page.waitForTimeout(300);
    await page.fill('#formDialog input[name="name"]', 'Casey Example');
    await page.click('#formDialog label:has(> input[name="role"][value="kid"])');
    const signinHidden = await page.$eval('#formDialog [data-ref="signin"]', (e) => e.hidden);
    await page.click('#formDialog [type="submit"]');
    await settle(page, 500);
    const casey = await one("select id, role from people where name = 'Casey Example'");
    check('family: added Casey, a kid; the form doesn\'t offer sign-in for a kid', !!casey && casey.role === 'kid' && signinHidden, { casey, signinHidden });
    const alexToken = (await h.sessionFor('alex@example.com')).access_token;
    const forced = await h.api('/rest/v1/rpc/save_person', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alexToken}` },
      body: JSON.stringify({ p: { id: casey.id, email: 'casey@example.com' }, p_can_sign_in: true }) });
    const caseyLogin = await one("select count(*) as n from members where email = 'casey@example.com'");
    check('family: the database refuses sign-in for a kid even when asked directly (22023, 400)', forced.status === 400 && forced.body.code === '22023' && caseyLogin.n === '0', forced);

    // A new My day link for Robin: the old one stops at once.
    await page.click(`[data-rotate="${robin.id}"]`);
    await settle(page, 500);
    const robin2 = await one(`select day_token from people where id = '${robin.id}'`);
    const old = await h.api('/rest/v1/rpc/get_person_day', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_token: robin.day_token }) });
    const fresh = await h.api('/rest/v1/rpc/get_person_day', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_token: robin2.day_token }) });
    check('family: New link replaces Robin\'s token; the old link shows nothing, the new one her day', robin2.day_token !== robin.day_token && old.status === 200 && old.body === null
      && fresh.status === 200 && fresh.body && fresh.body.person.name === 'Robin Example', { old: old.body, fresh: fresh.status });
    await page.click(`.ppl-card[data-id="${robin.id}"] [data-copy]`);
    await page.waitForTimeout(300);
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check('family: Copy gives the new link', copied === `${h.base}/day.html?t=${robin2.day_token}`, copied);

    // Remove Robin.
    await page.click(`[data-edit="${robin.id}"]`);
    await page.waitForTimeout(300);
    await page.click('#formDialog [data-act="remove"]');
    await settle(page, 500);
    const gone = await one(`select count(*) as n from people where id = '${robin.id}'`);
    check('family: Remove takes Robin off the list', gone.n === '0' && (await lastToast(page)) === 'Removed Robin Example', await lastToast(page));

    // Taylor gets an email address and the morning email (for the confirmation link below).
    await page.click(`[data-edit="${P.taylor}"]`);
    await page.waitForTimeout(300);
    await page.fill('#formDialog input[name="email"]', 'taylor@example.com');
    await page.click('#formDialog label:has(> input[name="digest"][value="today"])');
    await page.click('#formDialog [type="submit"]');
    await settle(page, 500);
    const tay = await one(`select email, digest_enabled, email_verified_at, (select count(*) from people_confirm c where c.person_id = p.id) as secrets from people p where id = '${P.taylor}'`);
    check('family: Taylor has an email and the morning email on, unconfirmed, with a confirmation secret', tay.email === 'taylor@example.com' && tay.digest_enabled === 't'
      && tay.email_verified_at === null && tay.secrets === '1', tay);
    const f = await failures();
    check('family: no API request failed (other than the forced kid sign-in)', !f.filter((x) => !/save_person → 400/.test(x)).length, f);
    await context.close();
  });

  // ===================================================================
  // Settings: days off and the time zone
  // ===================================================================
  await flow('settings', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'settings' });
    await page.fill('[data-ref="dayoffForm"] input[name="from"]', '2026-12-21');
    await page.fill('[data-ref="dayoffForm"] input[name="to"]', '2026-12-31');
    await page.click('[data-ref="dayoffForm"] [type="submit"]');
    await settle(page, 500);
    const hh = await one("select days_off::text as d, cardinality(days_off) as n, updated_by from household");
    check('settings: Dec 21–31 saved as 11 days off, by Alex', hh.n === '11' && /2026-12-21/.test(hh.d) && /2026-12-31/.test(hh.d) && hh.updated_by === 'alex@example.com', hh);
    check('settings: listed as one run', (await texts(page, '[data-ref="daysoff"] .set-dayoff-label')).includes('Mon Dec 21 – Thu Dec 31 (11 days)'), await texts(page, '[data-ref="daysoff"] .set-dayoff-label'));
    await page.selectOption('.set-form select[name="tz"]', 'America/Chicago');
    await page.click('.set-form [type="submit"]');
    await settle(page, 600);
    const tz = await one('select tz from household');
    const clockNow = await page.evaluate(() => HomeHub.core.v2.clock);
    check('settings: the time zone is Chicago, and the hub\'s clock follows (an hour behind New York)', tz.tz === 'America/Chicago' && clockNow && clockNow.tz === 'America/Chicago' && /^08:/.test(clockNow.local_time), { tz, clockNow });
    await page.selectOption('.set-form select[name="tz"]', 'America/New_York');
    await page.click('.set-form [type="submit"]');
    await settle(page, 600);
    check('settings: and back to New York (a second save in a row works: the saved row\'s updated_at is used)', (await one('select tz from household')).tz === 'America/New_York', await tc(page, '.set-form .form-error'));
    const f = await failures();
    const notDeployed = f.filter((x) => !/functions\/v1\/hub-jobs → 404/.test(x));
    check('settings: no API request failed (hub-jobs isn\'t deployed: 404)', !notDeployed.length, f);
    await context.close();
  });

  // ===================================================================
  // Projects: edit a schedule task (task_dates written, not stale), owner, the Tasks card, Put on the schedule
  // ===================================================================
  const KITCHEN = 'a0000000-0000-4000-8000-000000000001';
  await flow('projects', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/projects/${KITCHEN}`, label: 'projects' });
    const before = await one(`select task_dates_at, (select x from jsonb_array_elements(task_dates) x where x->>'id' = 'design')::text as design from projects where id = '${KITCHEN}'`);
    await page.click('.g-label[data-id="design"]');
    await page.waitForTimeout(300);
    await page.click('[data-task-act="edit"]');
    await page.waitForTimeout(300);
    await page.fill('#formDialog input[name="amount"]', '5');
    await page.click('#formDialog [type="submit"]');
    await settle(page, 600);
    const after = await one(`select task_dates_at, schedule #> '{phases,0,tasks,0,days}' as days, (select x from jsonb_array_elements(task_dates) x where x->>'id' = 'design')::text as design from projects where id = '${KITCHEN}'`);
    const design = after.design ? JSON.parse(after.design) : null;
    check('projects: editing a task (3 → 5 working days) writes the schedule and fresh task_dates (Oct 26–30), with a new task_dates_at',
      after.days === '5' && design && design.days === 5 && design.start === '2026-10-26' && design.end === '2026-10-30' && after.task_dates_at !== before.task_dates_at, { before, after });
    await page.click('[data-ref="head"] [data-act="settings"]');
    await page.waitForTimeout(300);
    await page.selectOption('#formDialog select[name="owner_id"]', P.morgan);
    await page.click('#formDialog [type="submit"]');
    await settle(page, 600);
    const owner = await one(`select owner_id, task_dates is not null as dated from projects where id = '${KITCHEN}'`);
    check('projects: the owner is Morgan, and the dates are still fresh', owner.owner_id === P.morgan && owner.dated === 't', owner);
    await page.click('.ptasks [data-act="ptask-add"]');
    await page.waitForTimeout(400);
    await page.fill('#formDialog input[name="title"]', 'Order cabinet pulls');
    await page.click('#formDialog [type="submit"]');
    await settle(page, 600);
    const pulls = await one("select id, project_id from tasks where title = 'Order cabinet pulls'");
    check('projects: + Task on the Tasks card adds a task on the project', !!pulls && pulls.project_id === KITCHEN && (await titles(page, '.ptasks')).includes('Order cabinet pulls'), pulls);
    await page.locator('.ptasks .ptask', { hasText: 'Order cabinet pulls' }).first().locator('.ptask-sched').click();
    await page.waitForTimeout(400);
    await page.click('#formDialog [type="submit"]');
    await settle(page, 800);
    const sched = await one(`select (select count(*) from jsonb_array_elements(task_dates) x where x->>'name' = 'Order cabinet pulls') as dated,
      (select count(*) from jsonb_array_elements(schedule->'phases') ph, jsonb_array_elements(ph->'tasks') t where t->>'name' = 'Order cabinet pulls') as on_schedule,
      (select count(*) from tasks where title = 'Order cabinet pulls') as rows from projects where id = '${KITCHEN}'`);
    check('projects: Put on the schedule: on the schedule, in task_dates, and the task row is gone', same(sched, { dated: '1', on_schedule: '1', rows: '0' }), sched);
    const f = await failures();
    check('projects: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // My day (signed out): Taylor's real link; tick and Undo; confirm and stop the morning email
  // ===================================================================
  await flow('my day', async () => {
    await h.mark();
    const taylor = await one(`select day_token, (select token from people_confirm c where c.person_id = p.id) as confirm from people p where id = '${P.taylor}'`);
    let { page, context } = await open({ phone: true, path: `/day.html?t=${taylor.day_token}`, label: 'my-day' });
    await page.waitForSelector('.day-head', { timeout: 8000 });
    await settle(page, 300);
    const today = await titles(page, 'section[aria-labelledby="day-today"]');
    check('my day: Taylor\'s today has Piano and the heartworm pill', today.includes('Piano') && today.includes('Heartworm pill'), today);
    const pianoRow = await page.$eval('section[aria-labelledby="day-today"] .irow', (r) => r.innerText.replace(/\s+/g, ' ')).catch(() => '');
    check('my day: in Spanish, Piano at 16:00', /16:00/.test(pianoRow), pianoRow);
    const myPill = page.locator('section[aria-labelledby="day-today"] .irow', { hasText: 'Heartworm pill' });
    await myPill.locator('.day-check').click();
    await until(async () => (await pillRow()).due_date === '2026-11-27');
    const log = await sql(`select done_by from task_log where task_id = '${pill.id}' order by seq desc limit 1`);
    check('my day: tick moves the pill to Nov 27, logged as "Taylor Example (My day)"', (await pillRow()).due_date === '2026-11-27' && log[0] && log[0].done_by === 'Taylor Example (My day)', log);
    await page.waitForSelector('.toast-action .toast-btn:not(.toast-x)', { timeout: 4000 });
    await page.click('.toast-action .toast-btn:not(.toast-x)');
    await until(async () => (await pillRow()).due_date === TODAY);
    check('my day: Undo (undo_by_token) puts it back', (await pillRow()).due_date === TODAY && !(await sql(`select 1 from task_log where task_id = '${pill.id}' and done_by like '%(My day)'`)).length);
    await context.close();

    // A My day link can't confirm anything: confirm_digest takes only the confirmation secret.
    const withToken = await h.api('/rest/v1/rpc/confirm_digest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_confirm: taylor.day_token }) });
    check('my day: a My day token in place of the confirmation secret confirms nothing', withToken.status === 200 && withToken.body === false
      && (await one(`select email_verified_at from people where id = '${P.taylor}'`)).email_verified_at === null, withToken);
    // The confirmation email's link: the secret alone (no t=), so the page asks the question and loads nobody's day.
    const confirmMark = (await h.requests(true)).length;
    ({ page, context } = await open({ phone: true, path: `/day.html?c=${taylor.confirm}#confirm`, label: 'my-day-confirm' }));
    await page.waitForSelector('[data-act="confirm"]', { timeout: 8000 });
    check('my day: the confirmation link (secret only) shows just the question, not Taylor\'s day', !(await page.$('section[aria-labelledby="day-today"]'))
      && !(await page.content()).includes('Heartworm pill'));
    await page.click('[data-act="confirm"]');
    await until(async () => (await one(`select email_verified_at from people where id = '${P.taylor}'`)).email_verified_at !== null);
    const conf = await one(`select email_verified_at, (select count(*) from people_confirm c where c.person_id = p.id) as secrets from people p where id = '${P.taylor}'`);
    const confirmCalls = (await h.requests(true)).slice(confirmMark).filter((r) => /^\/rest\/v1\//.test(r.path));
    check('my day: its button confirms the address with confirm_digest(p_confirm) alone, and the secret is kept (a second tap says "confirmed")',
      conf.email_verified_at !== null && conf.secrets === '1' && confirmCalls.length === 1 && confirmCalls[0].path === '/rest/v1/rpc/confirm_digest'
      && same(JSON.parse(confirmCalls[0].body), { p_confirm: taylor.confirm }), { conf, calls: confirmCalls.map((r) => `${r.path} ${r.body}`) });
    await context.close();

    ({ page, context } = await open({ phone: true, path: `/day.html?t=${taylor.day_token}#stop`, label: 'my-day-stop' }));
    await page.waitForSelector('[data-act="stop"]', { timeout: 8000 });
    await page.click('[data-act="stop"]');
    await until(async () => (await one(`select digest_enabled from people where id = '${P.taylor}'`)).digest_enabled === 'f');
    check('my day: the stop link\'s button turns the morning email off', (await one(`select digest_enabled from people where id = '${P.taylor}'`)).digest_enabled === 'f');
    const reqs = await h.requests();
    check('my day: only the token functions are called, signed out', reqs.every((r) => r.role === 'anon' && MY_DAY_FNS.test(r.path)),
      reqs.filter((r) => r.role !== 'anon' || !/token|person_day|digest/.test(r.path)).map((r) => `${r.role} ${r.path}`));
    const f = await failures();
    check('my day: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Food (v1.2, schema 4): Alex and Sam on the shopping list in two browsers; Taylor's list on her
  // My day, in Spanish, with bad signal; tonight's dinner on Today, in "Send Jordan his day" and on
  // My day (docs/v1.2-kitchen.md §6–§8)
  // ===================================================================
  const line = (key) => one(`select id, name, note, aisle, private, added_at, added_by, bought_at, bought_by, updated_by from shopping_items
    where name_key = '${key}' and not private`);
  const foodNames = (page, part) => page.$$eval(`[data-part="${part}"] .food-row .food-name`, (es) => es.map((e) => e.textContent));
  const foodRow = (page, part, name) => page.locator(`[data-part="${part}"] .food-row`, { has: page.locator('.food-name', { hasText: new RegExp(`^${name}$`) }) });
  const addOnFood = async (page, text) => {
    await page.fill('.food-add input[name="what"]', text);
    await page.press('.food-add input[name="what"]', 'Enter');
  };
  const changedOf = (r) => { const m = /"changed":\s*(true|false)/.exec(r.response || ''); return m ? m[1] === 'true' : null; };
  const myDayUse = () => one(`select changes, ticks from my_day_use where person_id = '${P.taylor}' and day = '${TODAY}'`);

  await flow('food list', async () => {
    await h.mark();
    const alex = await open({ email: 'alex@example.com', path: '/#/food', label: 'food-alex' });
    const sam = await open({ email: 'sam@example.com', phone: true, path: '/#/food', label: 'food-sam' });
    for (const x of [alex, sam]) await until(async () => !!(await x.page.$('[data-part="buy"]')));
    check('food: on schema 4 the Food page opens on the real database (a tab, and a cell in the phone\'s bottom bar), with nothing to buy yet',
      (await tc(alex.page, '#main h1')) === 'Food' && !!(await alex.page.$('.tabs a[data-tab="food"]')) && !!(await sam.page.$('.bottombar a[data-tab="food"]'))
      && /Nothing to buy/.test(await tc(sam.page, '[data-part="buy"]')), await tc(alex.page, '#main'));

    // Alex adds Milk; Sam's page shows it once its clock moves 10 seconds (the poll).
    await addOnFood(alex.page, 'Milk');
    await until(async () => !!(await line('milk')));
    const milk = await line('milk');
    check('food: Alex adds "Milk" (add_to_list): one line, in Dairy & eggs, added by Alex, stamped with his email',
      !!milk && milk.name === 'Milk' && milk.aisle === 'dairy' && milk.added_by === P.alex && milk.bought_at === null && milk.updated_by === 'alex@example.com', milk);
    await until(async () => (await foodNames(alex.page, 'buy')).includes('Milk'));
    await sam.page.clock.fastForward(10000);
    check('food: Sam\'s page shows Milk once its clock moves 10 seconds (shopping_list, read every 10 seconds)',
      await until(async () => (await foodNames(sam.page, 'buy')).includes('Milk'), 4000), await foodNames(sam.page, 'buy'));

    // Both tap it.
    await Promise.all([alex, sam].map((x) => foodRow(x.page, 'buy', 'Milk').locator('.food-tick').click()));
    await until(async () => (await h.requests()).filter((r) => r.path === '/rest/v1/rpc/buy_item' && r.status).length === 2);
    const bought = await line('milk');
    const buys = (await h.requests()).filter((r) => r.path === '/rest/v1/rpc/buy_item');
    check('food: both tap Milk: both calls answer 200, one buys it (whoever was first), the other finds it already bought (changed: false)',
      !!bought.bought_at && [P.alex, P.sam].includes(bought.bought_by) && buys.length === 2 && buys.every((r) => r.status === 200)
      && same(buys.map(changedOf).sort(), [false, true]), { bought, buys: buys.map((r) => [r.email, r.status, changedOf(r)]) });
    const toasts = [await lastToast(alex.page), await lastToast(sam.page)];
    check('food: ... and neither phone says "Changed on another phone" (Milk is bought, as both wanted)', toasts.every((x) => !/Changed on another phone/.test(x)), toasts);
    check('food: three seconds after the tap, Milk is under Just bought on both phones', await until(async () => {
      for (const x of [alex, sam]) if (!(await foodNames(x.page, 'bought')).includes('Milk') || (await foodNames(x.page, 'buy')).includes('Milk')) return false;
      return true;
    }, 8000), [await foodNames(alex.page, 'bought'), await foodNames(sam.page, 'bought')]);

    // Sam adds "milk": the bought line comes back, once.
    await addOnFood(sam.page, 'milk');
    await until(async () => (await line('milk')).bought_at === null);
    await until(async () => /Back on the list/.test(await lastToast(sam.page)), 3000);
    const back = await sql("select name, bought_at, bought_by, added_by from shopping_items where name_key = 'milk'");
    check('food: Sam adds "milk": the bought line comes back on the list ("Back on the list"), still one line called Milk, now added by Sam',
      back.length === 1 && same(back[0], { name: 'Milk', bought_at: null, bought_by: null, added_by: P.sam }) && /Back on the list/.test(await lastToast(sam.page)),
      { back, toast: await lastToast(sam.page) });
    check('food: ... and Sam\'s list has it once, to buy', await until(async () => same(await foodNames(sam.page, 'buy'), ['Milk']), 5000), await foodNames(sam.page, 'buy'));

    // Buy again: coffee, bought three days ago (its bought_at has microseconds), back on the list with
    // one tap. Its seen is bought_at as the table read gave it (PostgREST's text), which has to cast back
    // to the very same instant for buy_item to change the row.
    await sql(`insert into shopping_items (name, aisle, added_by, added_at, bought_at, bought_by)
               values ('Coffee', 'pantry', '${P.sam}', private.now() - interval '10 days', private.now() - interval '3 days' + interval '0.123457 seconds', '${P.sam}')`);
    const was = (await one("select to_json(bought_at) #>> '{}' as t from shopping_items where name_key = 'coffee'")).t;
    await go(alex.page, '#/food');
    await until(async () => !!(await alex.page.$('[data-act="buy-again"]')));
    const againLabel = await tc(alex.page, '[data-act="buy-again"]');
    await alex.page.click('[data-act="buy-again"]');
    await foodRow(alex.page, 'again', 'Coffee').locator('[data-act="again"]').click();
    await until(async () => (await line('coffee')).bought_at === null);
    const coffee = await line('coffee');
    const put = (await h.requests()).filter((r) => r.path === '/rest/v1/rpc/buy_item').slice(-1)[0];
    const seenSent = put ? JSON.parse(put.body).p_seen : null;
    check('food: Buy again (1) lists Coffee, bought three days ago; one tap puts it back on the list (added by Alex now), with its bought_at as the table read gave it, microseconds and all',
      /^Buy again \(1\)/.test(againLabel) && coffee.bought_at === null && coffee.added_by === P.alex && !!put && changedOf(put) === true && seenSent === was && /\.\d{6}\+00:00$/.test(was),
      { againLabel, coffee, seenSent, was });
    const f = await failures();
    check('food list: no API request failed', !f.length, f);
    await alex.context.close();
    await sam.context.close();
  });

  await flow('food my day list', async () => {
    const token = (await one(`select day_token from people where id = '${P.taylor}'`)).day_token;
    await h.mark();
    const t = await open({ phone: true, path: `/day.html?t=${token}`, label: 'list-taylor' });
    await t.page.waitForSelector('.day-head', { timeout: 8000 });
    await settle(t.page, 300);
    const btn = await tc(t.page, '.day-list-btn');
    check('my day list: Taylor\'s day has the "Lista de compras · 2 ›" button (a helper, the switch on, and the family has a list)', btn === 'Lista de compras · 2 ›', btn);
    await t.page.click('.day-list-btn');
    await t.page.waitForSelector('.list-head h1');
    await until(async () => (await texts(t.page, '.list-sec .lrow-name')).length > 0);
    const view = { lang: await t.page.evaluate(() => document.documentElement.lang), h1: await tc(t.page, '.list-head h1'),
      aisles: await texts(t.page, '.list-sec .list-aisle'), rows: await texts(t.page, '.list-sec .lrow-name') };
    check('my day list: #list in Spanish: "Lista de compras", the aisles in store order ("Despensa", then "Lácteos y huevos"), and "Milk · leche" (the word list\'s Spanish word after the name)',
      same(view, { lang: 'es', h1: 'Lista de compras', aisles: ['Despensa', 'Lácteos y huevos'], rows: ['Coffee · café', 'Milk · leche'] }), view);

    // "Leche" while Milk is to buy: that line.
    await t.page.fill('.list-input', 'Leche');
    await t.page.press('.list-input', 'Enter');
    await until(async () => /Ya está en la lista/.test(await lastToast(t.page)));
    const lines = await sql("select name from shopping_items where name_key in ('milk', 'leche')");
    check('my day list: she adds "Leche" while Milk is to buy: "Ya está en la lista como Milk", and still one line',
      (await lastToast(t.page)) === 'Ya está en la lista como Milk' && same(lines, [{ name: 'Milk' }]), { toast: await lastToast(t.page), lines });

    // Tick it, then Deshacer.
    await t.page.locator('.lrow', { hasText: 'Milk' }).click();
    await until(async () => (await line('milk')).bought_at !== null);
    await settle(t.page, 200);
    const tm = await line('milk');
    check('my day list: a tap ticks it (buy_item_by_token): bought by Taylor, "Taylor Example (My day)", and "Comprado: Milk" with Deshacer',
      tm.bought_by === P.taylor && tm.updated_by === 'Taylor Example (My day)' && /^Comprado: Milk/.test(await lastToast(t.page)) && /Deshacer/.test(await lastToast(t.page)),
      { tm, toast: await lastToast(t.page) });
    await t.page.click('.toast-action .toast-btn:not(.toast-x)');
    await until(async () => (await line('milk')).bought_at === null);
    const um = await line('milk');
    check('my day list: Deshacer puts it back (her own tick, within 15 minutes): to buy, still added by Sam', um.bought_at === null && um.bought_by === null && um.added_by === P.sam, um);
    let use = await myDayUse();
    check('my day list: my_day_use counts the tick and the Undo (2 ticks), not the add that changed nothing', !!use && same(use, { changes: '0', ticks: '2' }), use);

    // Her own adds.
    for (const x of ['Cebollas', 'Tortillas', 'Huevos']) {
      await t.page.fill('.list-input', x);
      await t.page.press('.list-input', 'Enter');
    }
    await until(async () => (await sql(`select 1 from shopping_items where name_key in ('cebollas', 'tortillas', 'huevos') and added_by = '${P.taylor}'`)).length === 3);
    const hers = await sql("select name, private, added_by, updated_by from shopping_items where name_key in ('cebollas', 'tortillas', 'huevos') order by name");
    use = await myDayUse();
    check('my day list: her three adds are three unlocked lines, added by her, "Taylor Example (My day)", each counted as a change',
      hers.length === 3 && hers.every((x) => x.private === 'f' && x.added_by === P.taylor && x.updated_by === 'Taylor Example (My day)') && same(use, { changes: '3', ticks: '2' }), { hers, use });
    await until(async () => (await t.page.$$('.lrow[data-key^="buy|"]')).length === 5, 6000);

    // No signal: two ticks wait on the phone, then arrive once.
    const cebollas = await line('cebollas');
    const tortillas = await line('tortillas');
    const sentBefore = (await h.requests()).length;
    await t.context.setOffline(true);
    for (const x of ['Cebollas', 'Tortillas']) await t.page.locator('.lrow', { hasText: x }).click();
    const marked = await until(async () => (await t.page.$$('.lrow-unsent')).length === 2, 10000);
    const waiting = await sql("select name, bought_at from shopping_items where name_key in ('cebollas', 'tortillas') order by name");
    check('my day list: with no signal, both ticks show at once, marked "⟳ sin enviar", and nothing reaches the database',
      marked && same(await texts(t.page, '.lrow-unsent'), ['⟳ sin enviar', '⟳ sin enviar']) && waiting.every((x) => x.bought_at === null)
      && (await t.page.$$eval('.lrow[aria-checked="true"]', (rs) => rs.length)) === 2, { marked, waiting, unsent: await texts(t.page, '.lrow-unsent') });
    await t.context.setOffline(false);
    const arrived = await until(async () => (await sql(`select 1 from shopping_items where name_key in ('cebollas', 'tortillas') and bought_by = '${P.taylor}'`)).length === 2, 20000);
    await settle(t.page, 500);
    const calls = (await h.requests()).slice(sentBefore).filter((r) => r.path === '/rest/v1/rpc/buy_item_by_token');
    const per = (it) => calls.filter((r) => JSON.parse(r.body).p_item === it.id);
    use = await myDayUse();
    check('my day list: back online, the two ticks arrive once each (one call each, changed: true) and are counted once',
      arrived && per(cebollas).length === 1 && per(tortillas).length === 1 && calls.every((r) => r.status === 200 && changedOf(r) === true)
      && same(use, { changes: '3', ticks: '4' }), { arrived, calls: calls.map((r) => [JSON.parse(r.body).p_item, r.status, changedOf(r)]), use });
    check('my day list: ... and the "sin enviar" marks are gone', await until(async () => !(await t.page.$('.lrow-unsent')), 6000));

    // A tick that waited with no signal while Alex bought Huevos and put it back on the list: it
    // was made on the line as she saw it, so it doesn't buy the new need.
    const huevos0 = await line('huevos');
    await t.context.setOffline(true);
    await t.page.locator('.lrow', { hasText: 'Huevos' }).click();
    await until(async () => (await t.page.$$('.lrow-unsent')).length === 1, 10000);
    const a = await open({ email: 'alex@example.com', path: '/#/food', label: 'list-alex' });
    await until(async () => (await foodNames(a.page, 'buy')).includes('Huevos'));
    await foodRow(a.page, 'buy', 'Huevos').locator('.food-tick').click();
    await until(async () => (await line('huevos')).bought_by === P.alex);
    await addOnFood(a.page, 'huevos');
    await until(async () => (await line('huevos')).bought_at === null);
    // The database has the line before Alex's page has the answer and its toast: wait for that too.
    await until(async () => /Back on the list/.test(await lastToast(a.page)), 3000);
    const huevos1 = await line('huevos');
    check('my day list: meanwhile Alex buys Huevos on Food and puts it back on the list ("Back on the list"): to buy, added by Alex, a new added_at',
      huevos1.added_by === P.alex && huevos1.added_at !== huevos0.added_at && /Back on the list/.test(await lastToast(a.page)), { huevos0, huevos1 });
    use = await myDayUse();
    await t.context.setOffline(false);
    const said = await until(async () => /Cambiado en otro teléfono/.test(await lastToast(t.page)), 20000);
    const huevos2 = await line('huevos');
    const use2 = await myDayUse();
    check('my day list: her tick then goes with the line as she saw it: nothing changes (still to buy, Alex\'s), it isn\'t counted, and she sees "Cambiado en otro teléfono"',
      said && huevos2.bought_at === null && huevos2.added_by === P.alex && huevos2.added_at === huevos1.added_at && same(use2, use), { huevos2, use, use2, toast: await lastToast(t.page) });
    check('my day list: ... and her list shows Huevos to buy again, unticked', await until(async () => {
      const el = await t.page.$(`.lrow[data-key="buy|${huevos2.id}"]`);
      return !!el && (await el.getAttribute('aria-checked')) === 'false' && !(await t.page.$('.lrow-unsent'));
    }, 8000), await texts(t.page, '.list-sec .lrow'));
    await shot(t.page, 'mylist-realdb');
    const reqs = await h.requests();
    // (Alex's sign-in, by the harness, is anon too: only the API's tables and functions count here.)
    const mine = reqs.filter((r) => r.role === 'anon' && r.path.startsWith('/rest/v1/'));
    check('my day list: her page called only the token functions, signed out', mine.length > 0 && mine.every((r) => MY_DAY_FNS.test(r.path))
      && mine.some((r) => r.path === '/rest/v1/rpc/get_list_by_token'), [...new Set(mine.map((r) => r.path))]);
    const f = await failures();
    check('my day list: no API request failed', !f.length, f);
    await a.context.close();
    await t.context.close();
  });

  await flow('food dinner', async () => {
    await h.mark();
    const a = await open({ email: 'alex@example.com', path: `/#/food/${TODAY}`, label: 'dinner-alex' });
    await a.page.waitForSelector('#formDialog .food-dinner', { timeout: 8000 });
    await a.page.fill('#formDialog input[name="title"]', 'Tacos');
    await a.page.click(`#formDialog [data-ref="cooks"] .pchip[data-person="${P.sam}"]`);
    await a.page.click('#formDialog .food-more summary');
    await a.page.fill('#formDialog textarea[name="note"]', 'Chicken is in the freezer');
    await a.page.fill('#formDialog input[name="link"]', 'cooking.example.com/tacos');
    await a.page.click('#formDialog [type="submit"]');
    await until(async () => !!(await one(`select id from meals where day = '${TODAY}'`)));
    // The database has the row before the page has the answer and its toast: wait for that too.
    await until(async () => (await lastToast(a.page)) === 'Dinner tonight: Tacos', 3000);
    const meal = await one(`select slot, kind, title, cook_id, note, link, private, created_by, updated_by from meals where day = '${TODAY}'`);
    // The row is in the table before the page has the answer, so the toast is waited for, not read at once.
    const savedToast = await until(async () => (await lastToast(a.page)) === 'Dinner tonight: Tacos');
    check('dinner: tonight\'s Tacos, Sam cooking, saved from Food (an upsert on day and slot, with the real grants), stamped by Alex',
      same(meal, { slot: 'dinner', kind: 'cook', title: 'Tacos', cook_id: P.sam, note: 'Chicken is in the freezer', link: 'https://cooking.example.com/tacos',
        private: 'f', created_by: 'alex@example.com', updated_by: 'alex@example.com' }) && savedToast, { meal, toast: await lastToast(a.page) });

    // Today, and "Send Jordan his day".
    await go(a.page, '#/');
    const dinnerLine = await tc(a.page, '.today-dinner-line');
    check('dinner: Today says "Dinner: Tacos · Sam cooks", with the note, and opens tonight on Food', dinnerLine === 'Dinner: Tacos · Sam cooks'
      && (await tc(a.page, '.today-dinner-note')) === 'Chicken is in the freezer' && (await a.page.getAttribute('.today-dinner', 'href')) === `#/food/${TODAY}`, dinnerLine);
    const sendText = async (id) => {
      await go(a.page, '#/');
      await a.page.click('.today-chips [data-view="me"]');
      await settle(a.page, 200);
      const wa = await a.page.getAttribute(`[data-send="${id}"] [data-via="whatsapp"]`, 'href').catch(() => null);
      return wa ? decodeURIComponent(wa.split('?text=')[1]) : null;
    };
    let jText = await sendText(P.jordan);
    check('dinner: "Send Jordan his day" has no dinner line while Sam cooks (the text is the real day_text)', !!jText && !/Dinner/.test(jText)
      && jText === (await one(`select public.day_text('${P.jordan}', '${TODAY}') as t`)).t, jText);

    // Taylor's and Jordan's My day.
    const tokens = Object.fromEntries((await sql(`select id, day_token from people where id in ('${P.taylor}', '${P.jordan}')`)).map((r) => [r.id, r.day_token]));
    const mealRow = async (page) => page.$$eval('section[aria-labelledby="day-today"] .irow', (rs) => {
      const last = rs[rs.length - 1];
      return last && last.classList.contains('k-meal') ? last.innerText.replace(/\s+/g, ' ').trim() : '';
    });
    const tay = await open({ phone: true, path: `/day.html?t=${tokens[P.taylor]}`, label: 'dinner-taylor' });
    await tay.page.waitForSelector('.day-head', { timeout: 8000 });
    const tMeal = await mealRow(tay.page);
    check('dinner: Taylor\'s My day ends today with "Cena · Tacos · Cocina Sam", with no note or recipe (she isn\'t on it)',
      tMeal === 'Cena Tacos Cocina Sam' && !(await tay.page.$('.meal-note, .meal-recipe')) && !!(await tay.page.$('.day-list-btn')), tMeal);
    await tay.context.close();
    await h.mark();
    let jor = await open({ phone: true, path: `/day.html?t=${tokens[P.jordan]}`, label: 'dinner-jordan' });
    await jor.page.waitForSelector('.day-head', { timeout: 8000 });
    await settle(jor.page, 500);
    const jMeal = await mealRow(jor.page);
    const jReqs = (await h.requests()).filter((r) => r.role === 'anon');
    check('dinner: Jordan\'s My day (a kid) shows the dinner, "Dinner · Tacos · Sam cooks", and no shopping list button',
      jMeal === 'Dinner Tacos Sam cooks' && !(await jor.page.$('.day-list-btn')), jMeal);
    check('dinner: ... and his page never asks for the list (get_person_day only)', jReqs.length > 0 && jReqs.every((r) => r.path === '/rest/v1/rpc/get_person_day'), jReqs.map((r) => r.path));
    await jor.context.close();

    // Leftovers, with Jordan on dinner: now it's in his text, and his My day has the note.
    await go(a.page, `#/food/${TODAY}`);
    await a.page.waitForSelector('#formDialog .food-dinner', { timeout: 8000 });
    await a.page.click('#formDialog [data-kind="leftovers"]');
    await a.page.click(`#formDialog [data-ref="cooks"] .pchip[data-person="${P.jordan}"]`);
    await a.page.click('#formDialog [type="submit"]');
    await until(async () => (await one(`select kind from meals where day = '${TODAY}'`)).kind === 'leftovers');
    const left = await one(`select kind, title, cook_id, note, link, (select count(*) from meals) as n from meals where day = '${TODAY}'`);
    check('dinner: changed to Leftovers with Jordan on dinner: the same row, no title or link, the note kept',
      same(left, { kind: 'leftovers', title: null, cook_id: P.jordan, note: 'Chicken is in the freezer', link: null, n: '1' }), left);
    jText = await sendText(P.jordan);
    check('dinner: now "Send Jordan his day" has "Dinner: Leftovers · You\'re on dinner" (never the note)', !!jText && /\nDinner: Leftovers · You're on dinner(\n|$)/.test(jText)
      && !/freezer/.test(jText) && jText === (await one(`select public.day_text('${P.jordan}', '${TODAY}') as t`)).t, jText);
    jor = await open({ phone: true, path: `/day.html?t=${tokens[P.jordan]}`, label: 'dinner-jordan-on' });
    await jor.page.waitForSelector('.day-head', { timeout: 8000 });
    const jMeal2 = await mealRow(jor.page);
    check('dinner: Jordan\'s My day: "Dinner · Leftovers · You\'re on dinner", with the note (he\'s on it), and no recipe link (leftovers have none)',
      jMeal2 === 'Dinner Leftovers You\'re on dinner Chicken is in the freezer' && (await tc(jor.page, '.k-meal .meal-note')) === 'Chicken is in the freezer'
      && !(await jor.page.$('.meal-recipe')), jMeal2);
    await jor.context.close();
    const f = await failures();
    check('dinner: no API request failed', !f.length, f);
    await a.context.close();
  });

  // A locked dinner's prep reminder (docs/v1.2-kitchen.md §5): Food's button opens the real task form
  // with Private ticked, and the task it saves is private, so "Prep: <title>" stays off My day, the
  // texts and the email subject as the dinner's title does. The flow removes what it made.
  await flow('food prep', async () => {
    await h.mark();
    const DAY = '2026-10-28';
    let a = null;
    try {
      a = await open({ email: 'alex@example.com', path: `/#/food/${DAY}`, label: 'prep-alex' });
      await a.page.waitForSelector('#formDialog .food-dinner', { timeout: 8000 });
      await a.page.fill('#formDialog input[name="title"]', 'Birthday cake');
      await a.page.click(`#formDialog [data-ref="cooks"] .pchip[data-person="${P.sam}"]`);
      await a.page.click('#formDialog .food-more summary');
      await a.page.check('#formDialog input[name="private"]');
      await a.page.click('#formDialog [type="submit"]');
      await until(async () => !!(await one(`select id from meals where day = '${DAY}'`)));
      const meal = await one(`select kind, title, cook_id, private from meals where day = '${DAY}'`);
      check('prep: Wednesday\'s "Birthday cake" saved locked, Sam cooking', same(meal, { kind: 'cook', title: 'Birthday cake', cook_id: P.sam, private: 't' }), meal);

      await go(a.page, `#/food/${DAY}`);
      await a.page.waitForSelector('#formDialog [data-act="prep"]', { timeout: 8000 });
      await a.page.click('#formDialog [data-act="prep"]');
      await a.page.waitForSelector('.tasks-form', { timeout: 8000 });
      await settle(a.page, 200);
      const form = await a.page.evaluate(() => {
        const f = document.querySelector('.tasks-form');
        return { h: f.querySelector('h3').textContent, title: f.elements.title.value, date: f.elements.when_date.value, category: f.elements.category.value,
          more: f.querySelector('.tasks-more').open, private: f.elements.private.checked };
      });
      check('prep: "Add a prep reminder…" on the locked dinner opens the real task form: "Prep: Birthday cake", due today, family, More open, Private ticked',
        same(form, { h: 'New task', title: 'Prep: Birthday cake', date: TODAY, category: 'family', more: true, private: true }), form);
      await a.page.click('.tasks-form [type="submit"]');
      await until(async () => !!(await one("select id from tasks where title = 'Prep: Birthday cake'")));
      const task = await one("select id, private, responsible_id, due_date, category, created_by from tasks where title = 'Prep: Birthday cake'");
      const { id: taskId, ...saved } = task || {};
      check('prep: the task saved is private, Sam in charge, due today, family, made by Alex',
        same(saved, { private: 't', responsible_id: P.sam, due_date: TODAY, category: 'family', created_by: 'alex@example.com' }), task);
      const toastsNow = () => texts(a.page, '.toasts .toast, body > .toast');
      check('prep: ... and Food comes back with "Prep reminder added"', await until(async () => (await a.page.evaluate(() => location.hash)) === '#/food'
        && (await toastsNow()).includes('Prep reminder added')), await toastsNow());

      // Sam is in charge: his My day, his text and his email subject say "Private item", never the title.
      const tok = (await one(`select day_token from people where id = '${P.sam}'`)).day_token;
      const onMyDay = await one(`select i->>'title' as title from jsonb_array_elements(public.get_person_day('${tok}')->'days'->0->'items') i where i->>'item_id' = '${taskId}'`);
      check('prep: on Sam\'s My day the task reads "Private item"', !!onMyDay && onMyDay.title === 'Private item', onMyDay);
      const text = (await one(`select public.day_text('${P.sam}', '${TODAY}') as t`)).t || '';
      check('prep: Sam\'s day text has "Private item", not the title', /Private item/.test(text) && !/Birthday cake/.test(text), text);
      const mail = await one(`select public.digest_for('${P.sam}', '${TODAY}') as d`);
      const subject = mail && mail.d ? JSON.parse(mail.d).subject : null;
      check('prep: Sam\'s morning email subject never has the title', typeof subject === 'string' && !/Birthday cake/.test(subject), subject);
      const f = await failures();
      check('prep: no API request failed', !f.length, f);
    } finally {
      if (a) await a.context.close();
      await sql("delete from tasks where title = 'Prep: Birthday cake'");
      await sql(`delete from meals where day = '${DAY}'`);
    }
  });

  // ===================================================================
  // Less-travelled paths: one-offs, deletes with Undo, overnight and multi-day events, weekday and
  // after-done tasks, late items, the contract heads-up, "I'll do it", a member's view
  // ===================================================================
  await flow('extras', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/tasks/everyone', label: 'extras' });
    const addTask = async (fill) => {
      await go(page, '#/tasks/everyone');
      await page.click('.tasks-add');
      await page.waitForSelector('.tasks-form');
      await fill();
      await page.click('.tasks-form [type="submit"]');
      await settle(page, 600);
    };

    // Trash out every week on Monday and Thursday, for Jordan (next due Thu Oct 29).
    await addTask(async () => {
      await page.fill('.tasks-form [name="title"]', 'Trash out');
      await page.click(`.tasks-form [data-ref="who"] .pchip[data-person="${P.jordan}"]`);
      await page.click('.tasks-form [data-mode="schedule"]');
      await page.fill('.tasks-form [name="when_date"]', '2026-10-29');
      await page.fill('.tasks-form [name="every_count"]', '1');
      await page.selectOption('.tasks-form [name="every_unit"]', 'week');
      await page.click('.tasks-form [data-wd="1"]');
    });
    const trash = await one("select id, due_date, repeat_weekdays, anchor_date, every_unit from tasks where title = 'Trash out'");
    check('extras: a weekly task on Mon and Thu saves with weekdays {1,4}, due Thu Oct 29', !!trash && trash.repeat_weekdays === '{1,4}' && trash.due_date === '2026-10-29', trash);
    const next = await one(`select private.series_after(t, t.due_date) as d from tasks t where id = '${trash.id}'`);
    check('extras: after Thu Oct 29 it comes round on Mon Nov 2', next.d === '2026-11-02', next);

    // The furnace filter, 60 days after it was last done (Oct 1): due Nov 30.
    await addTask(async () => {
      await page.fill('.tasks-form [name="title"]', 'Furnace filter');
      await page.click('.tasks-form [data-mode="after_done"]');
      await page.fill('.tasks-form [name="when_date"]', '2026-10-01');
      await page.fill('.tasks-form [name="every_count"]', '60');
      await page.selectOption('.tasks-form [name="every_unit"]', 'day');
    });
    const filt = await one("select id, due_date, last_done, anchor_date, repeat_mode from tasks where title = 'Furnace filter'");
    check('extras: an after-done task last done Oct 1, every 60 days, is due Nov 30', !!filt && filt.due_date === '2026-11-30' && filt.last_done === '2026-10-01' && filt.repeat_mode === 'after_done', filt);

    // A one-off with a time, today, for Sam: tick, then Undo.
    await addTask(async () => {
      await page.fill('.tasks-form [name="title"]', 'Call the plumber');
      await page.click(`.tasks-form [data-ref="who"] .pchip[data-person="${P.sam}"]`);
      await page.click('.tasks-form [data-when="today"]');
      await page.fill('.tasks-form [name="due_time"]', '14:30');
    });
    const plumber = await one("select id, due_date, due_time from tasks where title = 'Call the plumber'");
    check('extras: a one-off at 2:30pm today saves with due_time 14:30', !!plumber && plumber.due_date === TODAY && plumber.due_time === '14:30:00', plumber);
    await go(page, '#/');
    await page.click(chip(P.sam));
    await settle(page, 150);
    const samRow = await page.locator('[data-list="day"] .irow', { hasText: 'Call the plumber' }).innerText().catch(() => '');
    check('extras: on Sam\'s Today at 2:30pm', /2:30pm/.test(samRow), samRow);
    await page.locator('[data-list="day"] .irow', { hasText: 'Call the plumber' }).locator('.irow-check').click();
    await until(async () => (await one(`select done_at from tasks where id = '${plumber.id}'`)).done_at !== null);
    const done1 = await one(`select done_at is not null as done, done_by from tasks where id = '${plumber.id}'`);
    check('extras: ticking a one-off sets done_at and done_by (Alex)', done1.done === 't' && done1.done_by === 'alex@example.com', done1);
    await page.click('.toasts .toast-action .toast-btn');
    await until(async () => (await one(`select done_at from tasks where id = '${plumber.id}'`)).done_at === null);
    const undone1 = await one(`select done_at, done_by, (select count(*) from task_log l where l.task_id = t.id) as logs from tasks t where id = '${plumber.id}'`);
    check('extras: Undo of a one-off clears done_at and done_by, and its log row', undone1.done_at === null && undone1.done_by === null && undone1.logs === '0', undone1);

    // Delete a repeating task, then Undo: the row comes back as it was.
    const trashBefore = await one(`select row_to_json(t)::text as j from tasks t where id = '${trash.id}'`);
    await go(page, `#/tasks/${trash.id}`);
    await page.waitForSelector('#detail [data-act="delete"]', { timeout: 5000 });
    await page.click('#detail [data-act="delete"]');
    await until(async () => (await one(`select count(*) as n from tasks where id = '${trash.id}'`)).n === '0');
    await page.waitForSelector('.toasts .toast-action .toast-btn', { timeout: 4000 });
    await page.click('.toasts .toast-action .toast-btn');
    await until(async () => (await one(`select count(*) as n from tasks where id = '${trash.id}'`)).n === '1');
    const trashAfter = await one(`select row_to_json(t)::text as j from tasks t where id = '${trash.id}'`);
    const diff = (a, b) => { const x = JSON.parse(a); const y = JSON.parse(b); return Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])); };
    check('extras: Delete then Undo puts the task back as it was (same id and settings)', !!trashAfter && diff(trashBefore.j, trashAfter.j).every((k) => ['updated_at', 'created_at'].includes(k)),
      trashAfter ? diff(trashBefore.j, trashAfter.j) : 'not back');

    // An overnight event (Fri 8pm to Sat 10am) and a multi-day all-day event (Thu–Sun).
    const addEvent = async (fill) => {
      await go(page, '#/calendar');
      await page.click('.cal-head [data-act="add"]');
      await page.waitForSelector('.cal-form');
      await fill();
      await page.click('.cal-form [type="submit"]');
      await settle(page, 600);
    };
    await addEvent(async () => {
      await page.fill('.cal-form [name="title"]', 'Sleepover');
      await page.fill('.cal-form [name="start_date"]', '2026-10-30');
      await page.fill('.cal-form [name="start_time"]', '20:00');
      await page.click(`.cal-form [data-ref="who"] .pchip[data-person="${P.jordan}"]`);
      await page.click('.cal-form .cal-more summary');
      await page.fill('.cal-form [name="end_time"]', '10:00');
      await page.check('.cal-form [name="ends_next_day"]');
    });
    const sleep = await one("select id, ends_next_day, end_time from events where title = 'Sleepover'");
    const sleepOcc = await one(`select day, end_day, start_at, end_at from agenda('2026-10-30', '2026-10-31') where item_id = '${sleep && sleep.id}'`);
    check('extras: an overnight event saves (ends the next day) and the agenda ends it Sat Oct 31 at 10am', !!sleep && sleep.ends_next_day === 't' && sleepOcc
      && sleepOcc.end_day === '2026-10-31' && sleepOcc.end_at === '2026-10-31 14:00:00+00', { sleep, sleepOcc });
    await addEvent(async () => {
      await page.fill('.cal-form [name="title"]', 'Grandma visiting');
      await page.fill('.cal-form [name="start_date"]', '2026-10-29');
      await page.check('.cal-form [name="all_day"]');
      await page.fill('.cal-form [name="end_date"]', '2026-11-01');
    });
    const gran = await one("select id, start_date, end_date, start_time from events where title = 'Grandma visiting'");
    check('extras: a Thu–Sun all-day event saves with end_date Nov 1', !!gran && gran.end_date === '2026-11-01' && gran.start_time === null, gran);
    await go(page, '#/calendar/2026-10-31');
    await page.click('[data-view="week"]');
    await settle(page, 300);
    const bars = await page.$$eval('.cal-bar', (bs) => bs.map((b) => (b.getAttribute('aria-label') || b.textContent).replace(/\s+/g, ' ').trim()));
    check('extras: the Calendar week shows Grandma visiting as a bar, Oct 29–Nov 1', bars.some((b) => /Grandma visiting/.test(b) && /Oct 29/.test(b)), bars);

    // Delete Piano (every day it repeats), then Undo: the event and its one-day changes come back.
    const changesBefore = await one(`select count(*) as n from event_changes where event_id = '${piano.id}'`);
    await go(page, `#/calendar/event/${piano.id}/${TODAY}`);
    await page.waitForSelector('#detail [data-ev="delete"]', { timeout: 5000 });
    await page.click('#detail [data-ev="delete"]');
    await until(async () => (await one(`select count(*) as n from events where id = '${piano.id}'`)).n === '0');
    await page.waitForSelector('.toasts .toast-action .toast-btn', { timeout: 4000 });
    await page.click('.toasts .toast-action .toast-btn');
    await until(async () => (await one(`select count(*) as n from events where id = '${piano.id}'`)).n === '1', 6000);
    await settle(page, 400);
    const back = await one(`select (select count(*) from events where id = '${piano.id}') as ev, (select count(*) from event_changes where event_id = '${piano.id}') as ch`);
    check('extras: Delete Piano then Undo brings back the event and its one-day changes', back.ev === '1' && back.ch === changesBefore.n, { back, changesBefore });

    // Edit all days: Piano moves to 4:30pm; Nov 3's own change (5pm) stays.
    await go(page, `#/calendar/event/${piano.id}/${TODAY}`);
    await page.waitForSelector('#detail [data-ev="edit"]', { timeout: 5000 });
    await page.click('#detail [data-ev="edit"]');
    await page.waitForSelector('#formDialog .cal-form');
    await page.fill('#formDialog [name="start_time"]', '16:30');
    await page.fill('#formDialog [name="end_time"]', '17:30');
    await page.click('#formDialog [type="submit"]');
    await settle(page, 600);
    const moved = await sql(`select occurrence, local_start from agenda('${TODAY}', '2026-11-03') where item_id = '${piano.id}' order by occurrence`);
    check('extras: Edit all days moves Piano to 16:30; Nov 3 keeps its own 17:00', same(moved.map((r) => [r.occurrence, r.local_start]), [[TODAY, '16:30:00'], ['2026-11-03', '17:00:00']]), moved);

    // A late one-off for Taylor (due Oct 20) and an unassigned task today ("I'll do it").
    await sql(`insert into tasks (title, responsible_id, due_date) values ('Return library books', '${P.taylor}', '2026-10-20');
               insert into tasks (title, due_date) values ('Buy birthday card', '${TODAY}')`);
    await go(page, '#/');
    await page.click('.today-chips [data-view="all"]');
    await settle(page, 200);
    const lateRows = await titles(page, '[data-list="late"]');
    check('extras: Today\'s Late has the overdue library books (from the real late_items)', lateRows.includes('Return library books'), lateRows);
    const heads = await page.$$eval('[data-list="heads"] .irow', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
    check('extras: Heads-up has the power contract ending Nov 15 (from the real heads_up)', heads.some((x) => /Contract ends/.test(x) && /Nov 15/.test(x)), heads);
    const take = page.locator('[data-list="nobody"] .irow', { hasText: 'Buy birthday card' }).locator('.today-take');
    await take.click();
    await until(async () => (await one("select responsible_id from tasks where title = 'Buy birthday card'")).responsible_id === P.alex);
    check('extras: "I\'ll do it" puts Alex in charge of the birthday card', (await one("select responsible_id from tasks where title = 'Buy birthday card'")).responsible_id === P.alex);

    // The calendar's month view reads 42 days.
    await go(page, '#/calendar');
    await page.click('[data-view="month"]');
    await settle(page, 400);
    const monthCall = (await h.requests()).filter((r) => r.path === '/rest/v1/rpc/agenda').slice(-1)[0];
    check('extras: the month view reads agenda for Mon Sep 28 – Sun Nov 8', monthCall && same(JSON.parse(monthCall.body), { p_from: '2026-09-28', p_to: '2026-11-08' }), monthCall && monthCall.body);
    const f = await failures();
    check('extras: no API request failed', !f.length, f);
    await context.close();
  });

  // A member (Sam): his own day, a tick, Settings read-only, no Family changes.
  await flow('member', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'sam@example.com', path: '/', label: 'member' });
    check('member: Sam signs in to his Today', /Good morning, Sam/.test(await tc(page, '#main h1')), await tc(page, '#main h1'));
    await go(page, '#/settings');
    check('member: Settings is read-only', !(await page.$('.set-form')) && !(await page.$('[data-ref="dayoffForm"]')));
    await go(page, '#/people');
    check('member: Family has no Add person or Edit', !(await page.$('[data-act="add"]')) && !(await page.$('[data-edit]')));
    const token = (await h.sessionFor('sam@example.com')).access_token;
    const hh = await h.api('/rest/v1/household?id=eq.true', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, prefer: 'return=representation' }, body: JSON.stringify({ tz: 'America/Denver' }) });
    check('member: a direct household write changes nothing (row-level security: admins only)', hh.status === 200 && same(hh.body, []) && (await one('select tz from household')).tz === 'America/New_York', hh);
    const f = await failures();
    check('member: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // More: new and copied projects, sharing, the public share page, directory deletes with links,
  // a stale screen, "Which one is you?", a removed member
  // ===================================================================
  await flow('more', async () => {
    await h.mark();
    let { page, context } = await open({ email: 'alex@example.com', path: '/#/projects', label: 'more' });
    await page.click('[data-act="new-project"] >> nth=0');
    await page.waitForTimeout(300);
    await page.fill('#formDialog input[name=name]', 'Primary bathroom');
    await page.selectOption('#formDialog select[name=template]', KITCHEN);
    await page.click('#formDialog [type=submit]');
    await settle(page, 800);
    const bath = await one("select id, task_dates is not null as dated, task_dates_at is not null as at, jsonb_array_length(task_dates) as n, on_calendar, owner_id from projects where name = 'Primary bathroom'");
    check('more: a copied project is created with its task dates (fresh, not stale)', !!bath && bath.dated === 't' && bath.at === 't' && Number(bath.n) > 30, bath);
    // Share on, then a new link: the public page shows the schedule without private notes or phones.
    await go(page, `#/projects/${KITCHEN}`);
    const k0 = await one(`select share_token, sharing_enabled from projects where id = '${KITCHEN}'`);
    await page.click('[data-act=share]');
    await page.waitForTimeout(300);
    await page.click('[data-share=rotate]').catch(() => {});
    await settle(page, 600);
    const k1 = await one(`select share_token, sharing_enabled from projects where id = '${KITCHEN}'`);
    check('more: Share → Get a new link replaces the share token', k1.share_token !== k0.share_token && k1.sharing_enabled === 't', { k0, k1 });
    await page.keyboard.press('Escape');
    const pub = await open({ path: `/share.html?p=${k1.share_token}`, label: 'share-page' });
    await pub.page.waitForTimeout(800);
    const pubText = await tc(pub.page, 'body');
    check('more: the public share page (signed out, get_shared_project) shows the kitchen schedule, no phones or gate code',
      /Kitchen Renovation/.test(pubText) && /Install cabinets/.test(pubText) && !/555-01/.test(pubText) && !/4821/.test(pubText), pubText.slice(0, 200));
    const oldPub = await h.api('/rest/v1/rpc/get_shared_project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ share: k0.share_token }) });
    check('more: the old share link answers nothing', oldPub.status === 200 && oldPub.body === null, oldPub);
    await pub.context.close();

    // Delete the copied project: its tasks go with it.
    await sql(`insert into tasks (title, project_id) values ('Pick bathroom tile', '${bath.id}')`);
    await go(page, `#/projects/${bath.id}`);
    await page.click('[data-ref="head"] [data-act="settings"]');
    await page.waitForTimeout(300);
    await page.click('#formDialog [data-extra="0"]');
    await settle(page, 600);
    const gone = await one(`select (select count(*) from projects where id = '${bath.id}') as p, (select count(*) from tasks where title = 'Pick bathroom tile') as t`);
    check('more: deleting a project removes it and its tasks', gone.p === '0' && gone.t === '0', gone);

    // Directory (v2, admin): delete Rivera Music, which an event links to.
    await sql(`update events set contractor_id = 'c0000000-0000-4000-8000-000000000003' where title = 'Piano'`);
    await go(page, '#/directory');
    await page.click('.dir-card[data-id="c0000000-0000-4000-8000-000000000003"] [data-edit]');
    await page.waitForTimeout(300);
    await page.click('#formDialog [data-act="delete"]');
    await settle(page, 600);
    const rivera = await one(`select (select count(*) from contractors where id = 'c0000000-0000-4000-8000-000000000003') as c, (select contractor_id from events where title = 'Piano') as link`);
    check('more: deleting a directory entry an event links to removes it, and the event keeps going without the contact', rivera.c === '0' && rivera.link === null, rivera);
    const f = await failures();
    check('more: no API request failed', !f.length, f);
    await context.close();

    // A stale screen: Today open on two phones; one ticks the pill, then the other.
    const a = await open({ email: 'alex@example.com', path: '/', label: 'stale-a' });
    const b = await open({ email: 'morgan@example.com', path: '/', label: 'stale-b' });
    for (const x of [a, b]) { await x.page.click(chip(P.taylor)); await settle(x.page, 200); }
    await a.page.locator('[data-list="day"] .irow', { hasText: 'Heartworm pill' }).locator('.irow-check').click();
    await until(async () => (await pillRow()).due_date === '2026-11-27');
    await h.mark();
    await b.page.locator('[data-list="day"] .irow', { hasText: 'Heartworm pill' }).locator('.irow-check').click();
    await until(async () => /already ticked/.test(await lastToast(b.page)));
    const st = await failures();
    check('more: the second phone\'s tick gets "already completed" from the database and says someone already ticked it',
      /Someone already ticked that off/.test(await lastToast(b.page)) && (await pillRow()).due_date === '2026-11-27' && st.length === 1 && /complete_task → 400 P0001/.test(st[0]), { toast: await lastToast(b.page), st });
    await a.page.click('.toasts .toast-action .toast-btn').catch(() => {});
    await until(async () => (await pillRow()).due_date === TODAY);
    await a.context.close();
    await b.context.close();

    // "Which one is you?": a sign-in from the old Family page (no person row) and a parent with no email.
    await sql(`insert into members (email, name, role) values ('riley@example.com', 'Riley', 'admin');
               insert into people (name, role, sort_order) values ('Riley Example', 'parent', 9)`);
    ({ page, context } = await open({ email: 'riley@example.com', path: '/', label: 'riley' }));
    const riley = await one("select id from people where name = 'Riley Example'");
    check('more: Today asks a sign-in with no person row "Which one is you?"', /Which one is you\?/.test(await tc(page, '.today-who')), await tc(page, '.today-who'));
    await page.click(`.today-who .pchip[data-person="${riley.id}"]`);
    await page.click('[data-act="link-me"]');
    await settle(page, 600);
    const r2 = await one(`select email, email_verified_at is not null as confirmed, (select role from members where email = 'riley@example.com') as login from people where id = '${riley.id}'`);
    check('more: "That\'s me" gives Riley\'s person the sign-in email, confirmed, and keeps the admin sign-in', r2.email === 'riley@example.com' && r2.confirmed === 't' && r2.login === 'admin', r2);
    check('more: and Today now shows Riley\'s own day', /Good morning, Riley/.test(await tc(page, '#main h1')) && !(await page.$('.today-who')), await tc(page, '#main h1'));
    await context.close();

    // A removed member who still has a login: signing in says "Not on the list yet".
    const morganId = P.morgan;
    await sql(`delete from members where email = 'morgan@example.com'`);
    ({ page, context } = await open({ email: 'morgan@example.com', path: '/', label: 'removed' }));
    check('more: a removed member\'s sign-in shows "Not on the list yet"', /Not on the list yet/.test(await tc(page, 'body')), (await tc(page, 'body')).slice(0, 120));
    await context.close();
    await sql(`insert into members (email, name, role) values ('morgan@example.com', 'Morgan Example', 'admin')`);
    void morganId;
  });

  // ===================================================================
  // v1 mode: the live v1 site (b980d4c, main before v2) on the v2 database, and the core/module split (bcf296a)
  // ===================================================================
  await flow('v1', async () => {
    if (!process.env.REALDB_V1_ROOT) { console.log('SKIP  v1: the live v1 site (git commit b980d4c) isn\'t in this clone'); return; }
    await h.mark();
    let { page, context } = await open({ email: 'alex@example.com', path: '/v1/', label: 'v1-alex' });
    const tabs = await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent.trim()));
    check('v1: the live v1 site signs in on the v2 database and shows its pages', same(tabs, ['Home', 'Projects', 'Contractors', 'Family']) && /Good (morning|afternoon|evening), Alex/.test(await tc(page, '#main')), tabs);
    await go(page, `#/projects/${KITCHEN}`);
    await page.click('.g-label[data-id="design"]');
    await page.waitForTimeout(300);
    await page.click('[data-task-act="done"]');
    await settle(page, 600);
    const k = await one(`select schedule #>> '{phases,0,tasks,0,status}' as status, task_dates is null as stale from projects where id = '${KITCHEN}'`);
    check('v1: a schedule change from the v1 site saves, and the database marks the task dates stale', k.status === 'done' && k.stale === 't', k);
    await go(page, '#/contractors');
    const listed = await page.$$eval('.ccard h3, .ccard strong, .ccard .name', (es) => es.map((e) => e.textContent.trim()));
    check('v1: the v1 Contractors page lists the whole directory (accounts too)', (await tc(page, '#main')).includes('Example Water Co'), listed);
    await page.click('[data-act=new-contractor] >> nth=0');
    await page.fill('#formDialog input[name=name]', 'Dana Brooks');
    await page.fill('#formDialog input[name=company]', 'Brooks Plumbing');
    await page.fill('#formDialog input[name=phone]', '(201) 555-0108');
    await page.click('#formDialog [type=submit]');
    await settle(page, 500);
    const dana = await one("select kind, updated_by from contractors where name = 'Dana Brooks'");
    check('v1: adding a contractor from the v1 site gives a v2 directory entry (kind contractor, stamped)', dana && dana.kind === 'contractor' && dana.updated_by === 'alex@example.com', dana);
    let f = await failures();
    check('v1: no API request failed on the v1 site (other than hub_schema_version, which it doesn\'t ask for)', !f.length, f);
    await context.close();

    // The v2 client reads the projects again: the stale dates are filled in.
    ({ page, context } = await open({ email: 'alex@example.com', path: '/', label: 'v2-after-v1' }));
    const k2 = await one(`select task_dates is not null as dated, (select x->>'status' from jsonb_array_elements(task_dates) x where x->>'id' = 'design') as status from projects where id = '${KITCHEN}'`);
    check('v1: the v2 site fills the stale dates back in on its next read (with the v1 site\'s change)', k2.dated === 't' && k2.status === 'done', k2);
    await context.close();

    // A member on a v1 page deletes a contractor that has account details (an admin added private notes).
    await sql(`insert into contractor_secrets (contractor_id, secret_notes) values ('c0000000-0000-4000-8000-000000000001', 'Gate code 4821')`);
    await h.mark();
    ({ page, context } = await open({ email: 'sam@example.com', path: '/v1/#/contractors', label: 'v1-sam' }));
    await page.click('.ccard:has-text("Pat Lee") [data-edit]');
    await page.waitForTimeout(300);
    await page.click('#formDialog [data-extra="0"]');
    await settle(page, 800);
    const pat = await one(`select count(*) as n from contractors where id = 'c0000000-0000-4000-8000-000000000001'`);
    const link = await one(`select schedule #>> '{trades,electrician,contractor_id}' as cid, schedule #>> '{trades,electrician,who}' as who from projects where id = '${KITCHEN}'`);
    const toastText = await lastToast(page);
    const formErr = await tc(page, '#formDialog .form-error');
    // The live v1 page turns each project link into plain text ("Pat Lee, Lee Electric") before it deletes
    // (b980d4c's unlinkContractor), and that code can't change. The database refuses the delete itself
    // (private.contractors_guard), so the entry stays and every project still names who does the work;
    // only the link to the entry becomes plain text. (Only a page loaded before the migration can do this.)
    check('v1 member: deleting an entry with account details from a v1 page is refused: the entry stays, the project still names the contractor, and the page shows an error',
      pat.n === '1' && link.who === 'Pat Lee, Lee Electric' && !!(formErr || toastText), { contractorStillThere: pat.n === '1', projectLink: link, toast: toastText, formErr });
    await context.close();

    // The core/module split (PR A) on a v2 database: no page is made for version 2.
    if (process.env.REALDB_V1A_ROOT) {
      ({ page, context } = await open({ email: 'alex@example.com', path: '/v1a/', label: 'v1a' }));
      check('v1a: PR A alone on a v2 database says the copy doesn\'t match the database (it has no v2 pages)', /doesn't match the database/.test(await tc(page, '#main')), await tc(page, '#main'));
      await context.close();
    }
  });

  // Probes: "I'll do it" on an inactive person's task; deactivating an adult who can sign in; a member
  // editing an entry with account details from a v1 page.
  await flow('probes', async () => {
    await h.mark();
    // Casey (a kid) is taken off the lists for now; her task today is nobody's, as Today and the email say.
    await sql(`insert into tasks (title, responsible_id, due_date) values ('Feed the fish', (select id from people where name = 'Casey Example'), '${TODAY}');
               update people set active = false where name = 'Casey Example'`);
    let { page, context } = await open({ email: 'alex@example.com', path: '/', label: 'probes' });
    const nobody = await titles(page, '[data-list="nobody"]');
    check('probes: an inactive kid\'s task shows under "Nobody\'s on it"', nobody.includes('Feed the fish'), nobody);
    await page.locator('[data-list="nobody"] .irow', { hasText: 'Feed the fish' }).locator('.today-take').click();
    await settle(page, 600);
    const fish = await one("select responsible_id from tasks where title = 'Feed the fish'");
    check('probes: "I\'ll do it" on it puts Alex in charge', fish.responsible_id === P.alex, { fish, toast: await lastToast(page), nobody: await titles(page, '[data-list="nobody"]') });
    await context.close();

    // A weekly school pickup nobody is on: "I'll do it" on today's.
    await sql(`insert into events (title, start_date, start_time, repeat) values ('School pickup', '${TODAY}', '15:00', 'weekly')`);
    ({ page, context } = await open({ email: 'alex@example.com', path: '/', label: 'probes-take-event' }));
    await page.locator('[data-list="nobody"] .irow', { hasText: 'School pickup' }).locator('.today-take').click();
    await settle(page, 600);
    const pickup = await sql(`select occurrence, responsible_id from agenda('${TODAY}', '2026-11-10') where title = 'School pickup' order by occurrence`);
    const toastTake = await lastToast(page);
    check('probes: "I\'ll do it" on today\'s school pickup (weekly) puts Alex on today\'s only, or says it\'s every week',
      pickup.filter((r) => r.responsible_id === P.alex).length === 1 || /every/i.test(toastTake), { toast: toastTake, alexOn: pickup.filter((r) => r.responsible_id === P.alex).map((r) => r.occurrence) });
    await context.close();

    // Sam (a member) edits an entry with account details from a v1 page. (Before Sam is taken off the lists below.)
    if (process.env.REALDB_V1_ROOT) {
      ({ page, context } = await open({ email: 'sam@example.com', path: '/v1/#/contractors', label: 'probes-v1-edit' }));
      await page.click('.ccard:has-text("Example Water Co") [data-edit]');
      await page.waitForTimeout(300);
      await page.fill('#formDialog input[name=phone]', '(201) 555-0199');
      await page.click('#formDialog [type=submit]');
      await settle(page, 600);
      const v1err = await tc(page, '#formDialog .form-error');
      const water = await one(`select phone from contractors where id = '${WATER}'`);
      // The live v1 page shows its own words for every permission error (42501): "You don't have
      // permission to do that." It can't show the database's reason without a change to the error code.
      check('probes: v1 member editing an entry with account details is refused, nothing changes, and the page says it isn\'t allowed',
        water.phone === '(201) 555-0160' && /admin|permission/i.test(v1err), { v1err, water });
      await context.close();
    }

    // Untick Active for Sam (an adult who can sign in), then Save.
    ({ page, context } = await open({ email: 'alex@example.com', path: '/#/people', label: 'probes-deactivate' }));
    await page.click(`[data-edit="${P.sam}"]`);
    await page.waitForTimeout(300);
    await page.uncheck('#formDialog input[name="active"]');
    await page.click('#formDialog [type="submit"]');
    await settle(page, 600);
    const err = await tc(page, '#formDialog .form-error');
    const sam = await one(`select active from people where id = '${P.sam}'`);
    check('probes: taking an adult who signs in off the lists (untick Active, Save) works or says what to do', sam.active === 'f' || /sign in/i.test(err) && /untick/i.test(err), { active: sam.active, err });
    await context.close();

  });

  // Screenshots of every page with the real data, at phone and desktop sizes (tests/e2e/shots/realdb-*.png).
  await flow('screens', async () => {
    for (const phone of [true, false]) {
      const { page, context } = await open({ email: 'alex@example.com', phone, path: '/', label: `screens-${phone ? 'phone' : 'desktop'}` });
      for (const [name, hash] of [['today', '#/'], ['calendar', '#/calendar'], ['tasks', '#/tasks/everyone'], ['food', '#/food'], ['projects', `#/projects/${KITCHEN}`],
        ['directory', '#/directory'], ['family', '#/people'], ['settings', '#/settings']]) {
        await go(page, hash);
        await settle(page, 400);
        await shot(page, `${name}-${phone ? 'phone' : 'desktop'}`);
      }
      await context.close();
    }
    const tok = (await one(`select day_token from people where id = '${P.taylor}'`)).day_token;
    const md = await open({ phone: true, path: `/day.html?t=${tok}`, label: 'screens-myday' });
    await settle(md.page, 600);
    await shot(md.page, 'myday-phone');
    await md.page.click('.day-list-btn').catch(() => {});
    await settle(md.page, 600);
    await shot(md.page, 'mylist-phone');
    await md.context.close();
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  flows stopped: ${e && e.stack}`); process.exit(1); });
