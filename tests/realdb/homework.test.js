// Homework (v1.3, docs/v1.3-homework.md, migration 0005) against the REAL database (tests/realdb/run.sh):
// the pages in Chromium on the real schema, row-level security and functions, through the PostgREST
// stand-in, with every write checked in the tables themselves. The flows run in order and build on
// each other, and they move the household's clock across days (so they have their own copy of the
// database, not flows.test.js's, whose flows stay on Tue Oct 27):
//   Mon Nov 2, 9:00am  Alex turns homework on for Jordan on the Homework page, sets his homework time
//                      (Mon–Thu 4:30–5:15), three rewards, a spelling sheet due Wed, and Pat's link;
//                      the morning email and Jordan's text carry the homework-time event and nothing else.
//   Mon Nov 2, 9:05am  Pat's link (signed out) adds the science project, plans it from the essay starter
//                      plan (placed by the database in his homework time, around Tuesday's piano) and
//                      gives it to him; the page shows nothing of the family and calls only its four functions.
//   Mon Nov 2, 4:31pm  Jordan's My day: the card, one tap on Start, the ring; the server's clock moves 20
//                      minutes, Step done: +4 and +5 on time. A second block the phone counts as 20
//                      minutes but the server saw 7 of: +1. Quick on the spelling sheet, + Homework for
//                      his own worksheet, both ticked.
//   Wed Nov 4, 4:35pm  He ticks the outline milestone, asks Pat a question, and Re-plans the steps left
//                      from Monday (Thursday's milestone, which they now can't reach, is to talk about
//                      with Pat). Pat sends the milestone back with Not yet and a note (he sees it),
//                      he ticks it again, Pat answers and checks it: +20. He asks for a reward; Sam can't
//                      decide it; Alex taps Yes on Today, with the balance and this week's points beside it.
//   Then Pat's link Off and On again, New link, past its end date, and homework off: the link stops
//   at once each time, and Jordan's card goes. Last, homework on again with 1,200 more ledger rows (the
//   stand-in cuts a read at 1,000, as Supabase's API does) and an ask: Today and the Homework page show
//   the balance his view has, 1215.
// Pat Lee is also the made-up electrician contractor in seed_v1.sql: the tutor is only ever looked for
// inside the tutor link's row and Pat's page. Screenshots: tests/e2e/shots/realdb-homework-*.png.
const { setup, HOMEWORK_CALLS } = require('./lib');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TUTOR_FNS = /^\/rest\/v1\/rpc\/(tutor_view_by_token|tutor_assignment_by_token|tutor_plan_by_token|tutor_step_by_token)$/;
const MON = '2026-11-02';
const WED = '2026-11-04';
// New York is on standard time from Nov 1: 4:31pm is 21:31 UTC.
const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;
const LINK_LABEL = 'Pat Lee, tutor';
const PAT_WHO = 'Pat Lee, tutor (tutor link)';

(async () => {
  const h = await setup('homework');
  const { check, flow, sql, open, go, tc, texts, lastToast, until, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || ''}` : ''}`);
  const anonRpc = (name, args) => h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };
  const steps = (asg) => sql(`select id, pos, kind, title, minutes, day, moved_from, source, done_at, done_by, checked_at, checked_by, not_yet_at, coach_note,
    coach_note_by, question, answer, answer_by from homework_steps where assignment_id = '${asg}' order by pos`);
  const ledger = () => sql(`select kind, delta, day, who, note from points_ledger where kid_id = '${P.jordan.id}' order by at, kind`);
  const view = async () => (await anonRpc('homework_by_token', { p_token: P.jordan.day_token })).body;
  // Every name in the family (surnames too), every email and every person's id: none is on Pat's page.
  const people = await sql('select id, name, email from people');
  const familyIn = (text) => {
    const found = [];
    for (const p of people) {
      for (const part of p.name.split(' ')) if (part !== 'Jordan' && new RegExp(`\\b${part}\\b`).test(text)) found.push(part);
      if (text.includes(p.id)) found.push(`id of ${p.name}`);
    }
    if (/@/.test(text)) found.push('an @');
    return [...new Set(found)];
  };

  await h.setClock(at(MON, '09:00'));
  // Tuesday's piano, from 4:45 to 5:30 with Morgan: busy time inside his Tuesday homework time.
  await sql(`insert into events (title, start_date, start_time, end_time, responsible_id, participant_ids, repeat, repeat_weekdays)
             values ('Piano with Morgan', '2026-11-03', '16:45', '17:30', '${P.morgan.id}', '{${P.jordan.id}}', 'weekly', '{2}')`);
  let link = null;      // Pat's tutor link: { id, token }
  let sci = null;       // the science project's id
  let spelling = null;  // the spelling sheet's id (Alex's, no plan)
  let S = [];           // the science project's steps, by position (index 0 = pos 1)
  let reward = null;    // the 15-point reward

  // ===================================================================
  // Mon Nov 2, 9:00am: Alex sets homework up on the Homework page
  // ===================================================================
  await flow('parents set up', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'hw-alex-setup' });
    await page.waitForSelector('.hw-setup [data-act="turn-on"]', { timeout: 8000 });
    check('setup: on schema 5 the Homework page opens on its first visit, "Turn on homework for Jordan" (the one kid; not Taylor, a helper)',
      (await tc(page, '#main h1')) === 'Homework' && same(await texts(page, '.hw-setup [data-act="turn-on"]'), ['Turn on homework for Jordan']), await tc(page, '#main'));
    await page.click('.hw-setup [data-act="turn-on"]');
    await page.waitForSelector('.hw-setup form[data-form="time"]', { timeout: 5000 });
    const kid = await one(`select active, points_on, focus_minutes, created_by from homework_kids where kid_id = '${P.jordan.id}'`);
    check('setup: Turn on makes his homework_kids row (on, points on, 20 minutes first), by Alex', same(kid, { active: 't', points_on: 't', focus_minutes: '20', created_by: 'alex@example.com' }), kid);
    await page.click('.hw-setup form[data-form="time"] button[type="submit"]');
    await page.waitForSelector('.hw-setup form[data-form="rewards"]', { timeout: 5000 });
    const ev = await one(`select e.title, e.start_date, e.start_time, e.end_time, e.repeat, e.repeat_weekdays, e.responsible_id, e.skip_days_off, e.created_by
      from homework_times t join events e on e.id = t.event_id where t.kid_id = '${P.jordan.id}'`);
    check('setup: his homework time (prefilled Mon–Thu 4:30–5:15) is one weekly event in his name, from today, ISO weekdays 1–4, with days off skipped, and its homework_times link',
      !!ev && same([ev.title, ev.start_date, ev.start_time, ev.end_time, ev.repeat, ev.repeat_weekdays, ev.responsible_id, ev.skip_days_off, ev.created_by],
        ['Homework', MON, '16:30:00', '17:15:00', 'weekly', '{1,2,3,4}', P.jordan.id, 't', 'alex@example.com']), ev);
    const rewardTitles = ['15 minutes of extra game time', 'Choose Friday\'s dinner', 'A new book'];
    for (let i = 0; i < 3; i++) await page.fill(`.hw-setup form[data-form="rewards"] .hw-rw:nth-child(${i + 1}) [name="title"]`, rewardTitles[i]);
    await page.click('.hw-setup form[data-form="rewards"] button[type="submit"]');
    await until(async () => !(await page.$('.hw-setup')) && !!(await page.$('.hw-kidline')), 6000);
    const rw = await sql(`select title, cost, active, suggested, sort_order, created_by from rewards where kid_id = '${P.jordan.id}' order by sort_order`);
    check('setup: three rewards in three sizes (15, 60, 150), his, on, in order, by Alex (a direct insert, the column grants and row-level security allowing it)',
      same(rw.map((r) => [r.title, r.cost, r.active, r.suggested, r.sort_order, r.created_by]), rewardTitles.map((t, i) => [t, ['15', '60', '150'][i], 't', 'f', String(i + 1), 'alex@example.com'])), rw);
    reward = (await one(`select id from rewards where kid_id = '${P.jordan.id}' and cost = 15`)).id;
    check('setup: the kid line names his homework time', (await tc(page, '.hw-kidline')) === 'Jordan · 0 points · Homework time Mon–Thu 4:30–5:15pm ›', await tc(page, '.hw-kidline'));

    // A spelling sheet due Wednesday, with no plan (he'll make it one step with Quick).
    await page.click('[data-act="add-assignment"]');
    await page.waitForSelector('#formDialog form.hw-aform');
    await page.fill('#formDialog [name="title"]', 'Spelling words');
    await page.fill('#formDialog [name="subject"]', 'English');
    await page.fill('#formDialog [name="due_date"]', WED);
    await page.click('#formDialog button[type="submit"]');
    await until(async () => /^#\/homework\/[0-9a-f-]{36}$/.test(await page.evaluate(() => location.hash)) && !!(await page.$('.hw-a')), 6000);
    const sp = await one(`select id, kind, added_by, title, subject, due_date, status, given_at, created_by from assignments where title = 'Spelling words'`);
    spelling = sp && sp.id;
    check('setup: + Assignment saves "Spelling words" (English, due Wed) for Jordan, added by the family, not given, and opens it',
      !!sp && same([sp.kind, sp.added_by, sp.subject, sp.due_date, sp.status, sp.given_at, sp.created_by], ['assignment', 'family', 'English', WED, 'open', null, 'alex@example.com'])
      && (await page.evaluate(() => location.hash)) === `#/homework/${sp.id}`, sp);

    // Pat's link, from the switches card.
    await go(page, '#/homework');
    await page.click('[data-act="add-link"]');
    await page.waitForSelector('form[data-form="link"]');
    await page.fill('form[data-form="link"] [name="label"]', LINK_LABEL);
    await page.click('form[data-form="link"] button[type="submit"]');
    await until(async () => !!(await page.$('.hw-link a[data-via="sms"]')), 6000);
    link = await one(`select id, token, label, language, expires_on, can_ai, active, last_used_at, created_by from tutor_links where kid_id = '${P.jordan.id}'`);
    check('setup: + Tutor link makes Pat\'s link (save_tutor_link): his label, English, on, ending in 180 days (May 1), a 32-character token, never used',
      !!link && /^[0-9a-f]{32}$/.test(link.token) && same([link.label, link.language, link.expires_on, link.active, link.last_used_at, link.created_by],
        [LINK_LABEL, 'en', '2027-05-01', 't', null, 'alex@example.com']), link);
    const sms = await page.getAttribute('.hw-link a[data-via="sms"]', 'href');
    check('setup: Text carries the link to day.html?h=<token>', decodeURIComponent(sms || '').endsWith(`${h.base}/day.html?h=${link.token}`), sms);
    await shot(page, 'homework-setup');
    const reqs = await h.requests();
    check('setup: the page calls the homework functions it needs (save_homework_kid, add_homework_time, homework_week, save_tutor_link)',
      ['save_homework_kid', 'add_homework_time', 'homework_week', 'save_tutor_link'].every((f) => reqs.some((r) => r.path === `/rest/v1/rpc/${f}` && r.status < 300)),
      [...new Set(reqs.filter((r) => HOMEWORK_CALLS.test(r.path)).map((r) => r.path))]);
    const f = await failures();
    check('setup: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Mon Nov 2, 9:05am: Pat's link adds the science project, plans it and gives it to Jordan
  // ===================================================================
  await flow('pat plans', async () => {
    if (!link) throw new Error('no tutor link');
    await h.setClock(at(MON, '09:05'));
    await h.mark();
    const linkBefore = await one(`select updated_at from tutor_links where id = '${link.id}'`);
    const { page, context } = await open({ path: `/day.html?h=${link.token}`, label: 'hw-pat' });
    await page.waitForSelector('.plan-tutor .plan-head', { timeout: 8000 });
    check('pat: the link opens "Homework · Jordan", "Hi Pat Lee, tutor · Link ends May 1", signed out',
      (await tc(page, '.plan-head h1')) === 'Homework · Jordan' && (await tc(page, '.plan-head .meta')) === 'Hi Pat Lee, tutor · Link ends May 1', await tc(page, '.plan-head'));
    const used = await one(`select last_used_at, updated_at from tutor_links where id = '${link.id}'`);
    check('pat: the read noted last_used_at (to the minute) and didn\'t touch updated_at', !!used.last_used_at && /:00\+00$/.test(used.last_used_at) && used.updated_at === linkBefore.updated_at, used);
    await page.click('a[href="#new/assignment"]');
    await page.waitForSelector('.plan-afields');
    await page.fill('.plan-afields input[name="title"]', 'Science project: river poster');
    await page.fill('.plan-afields input[name="subject"]', 'Science');
    await page.fill('.plan-afields input[name="due_date"]', '2026-11-13');
    await page.fill('.plan-afields textarea[name="details"]', 'Make a poster about a river.\nShow its source, its mouth and one animal that lives in it.');
    await page.click('.plan-afields [type="submit"]');
    await page.waitForSelector('.plan-editor [data-act="starter"]', { timeout: 8000 });
    const a = await one(`select id, kind, added_by, subject, due_date, details, given_at, created_by from assignments where title = 'Science project: river poster'`);
    sci = a && a.id;
    check('pat: + Assignment (tutor_assignment_by_token) adds it for Jordan with the page\'s id: added by the tutor, the teacher\'s text with its line break, as "Pat Lee, tutor (tutor link)"',
      !!a && same([a.kind, a.added_by, a.subject, a.due_date, a.given_at, a.created_by], ['assignment', 'tutor', 'Science', '2026-11-13', null, PAT_WHO])
      && a.details === 'Make a poster about a river.\nShow its source, its mouth and one animal that lives in it.', a);
    await page.click('.plan-editor [data-act="starter"]');
    await page.click('.plan-editor [data-starter="essay"]');
    await until(async () => (await sql(`select 1 from homework_steps where assignment_id = '${sci}'`)).length === 9, 6000);
    S = await steps(sci);
    const free = { [MON]: 45, '2026-11-03': 15, [WED]: 45, '2026-11-05': 45, '2026-11-09': 45, '2026-11-10': 15, '2026-11-11': 45 };   // Tuesday: piano from 4:45
    const perDay = {};
    S.forEach((s) => { perDay[s.day] = (perDay[s.day] || 0) + Number(s.minutes); });
    check('pat: the essay starter plan is nine template steps, two milestones and the turn-in, none longer than his first length (20)',
      S.length === 9 && S.every((s) => s.source === 'template' && Number(s.minutes) <= 20) && S.filter((s) => s.kind === 'milestone').length === 2
      && S[8].kind === 'turn_in', S.map((s) => [s.kind, s.title, s.minutes]));
    check('pat: the database placed them in his homework time: in order, on Mon–Thu, from today to Wed Nov 11 (two days before the due date), no day over its free minutes (Tuesday: 15, after the piano), the turn-in on Fri Nov 13',
      S.slice(0, 8).every((s, i) => s.day >= MON && s.day <= '2026-11-11' && (i === 0 || s.day >= S[i - 1].day) && free[s.day] !== undefined)
      && Object.entries(perDay).every(([d, m]) => d === '2026-11-13' || m <= free[d]) && S[8].day === '2026-11-13' && S[0].day === MON, perDay);
    await page.waitForSelector('.plan-editor [data-act="give"]:not([disabled])');
    await page.click('.plan-editor [data-act="give"]');
    await until(async () => !!(await one(`select given_at from assignments where id = '${sci}'`)).given_at, 6000);
    const given = await one(`select given_at is not null as given, given_by, plan_rev from assignments where id = '${sci}'`);
    check('pat: Give Jordan this plan sets given_at and given_by "Pat Lee, tutor (tutor link)"', given.given === 't' && given.given_by === PAT_WHO && Number(given.plan_rev) >= 2, given);
    await shot(page, 'homework-pat-plan');
    await go(page, '#');
    await page.waitForSelector('.plan-sec[data-sec="assignments"]');
    const body = await page.evaluate(() => document.body.innerText);
    check('pat: the page shows nothing of the family: no other name or surname, no email, no person\'s id, no busy title (Piano)',
      !familyIn(body).length && !/Piano/.test(body), familyIn(body).concat(/Piano/.test(body) ? ['Piano'] : []));
    check('pat: ... and no points, rewards or asks', !/★|reward|game time|Friday's dinner|(?<!main )points?\b/i.test(body), body.slice(0, 300));
    check('pat: his week shows Tuesday\'s piano as "Busy", without its title', /Busy 4:45pm/.test(await tc(page, '.plan-sec[data-sec="week"]')), await tc(page, '.plan-sec[data-sec="week"]'));
    const reqs = await h.requests();
    check('pat: the page called only the four tutor functions, signed out (no table, no other function, no sign-in)', reqs.length > 0
      && reqs.every((r) => r.role === 'anon' && TUTOR_FNS.test(r.path)), [...new Set(reqs.map((r) => `${r.role} ${r.path}`))]);
    const f = await failures();
    check('pat: no API request failed', !f.length, f);
    await context.close();
    const v = await view();
    const asg = v && v.assignments.find((x) => x.id === sci);
    check('pat: ... and the plan is on Jordan\'s view (homework_by_token), given by "tutor" (never a name), with its nine steps and no teacher\'s text',
      !!asg && asg.state === 'given' && asg.given_by === 'tutor' && asg.added_by === 'tutor' && asg.steps.length === 9 && !JSON.stringify(v).includes('Make a poster'), asg);

    // Nothing of it is in the texts and the email: the homework-time event is, as any event.
    const text = (await one(`select public.day_text('${P.jordan.id}', '${MON}') as t`)).t;
    check('pat: Jordan\'s text for Monday has his homework time (4:30pm Homework) and nothing of the plan', /4:30pm Homework/.test(text)
      && !S.some((s) => text.includes(s.title)) && !/Science project/.test(text), text);
    const pv = await h.hubJobsAs('alex@example.com', { action: 'preview', person_id: P.alex.id, date: MON });
    const mail = pv.body && pv.body.emails && pv.body.emails[0];
    check('pat: the morning email (hub-jobs\' preview) reads no homework: no assignment, step, point or reward in it',
      pv.status === 200 && !!mail && !/Science project|Spelling words|Copy the requirements|extra game time|points/.test(`${mail.subject}\n${mail.text}\n${mail.html}`),
      mail ? mail.text.slice(0, 400) : pv.body);
  });

  // ===================================================================
  // Mon Nov 2, 4:31pm: Jordan's My day: the card, Start, the ring, points by the server's clock
  // ===================================================================
  await flow('jordan starts', async () => {
    if (!sci) throw new Error('no plan');
    await h.setClock(at(MON, '16:31'));
    await h.mark();
    const { page, context } = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}`, label: 'hw-jordan-mon' });
    await page.waitForSelector('.hw-card', { timeout: 8000 });
    const tonight = S.filter((s) => s.day === MON);
    const minutes = tonight.reduce((n, s) => n + Number(s.minutes), 0);
    check(`card: under the greeting, "Homework · 4:30pm · ${tonight.length} steps · ${minutes} min", Next is the plan's first step, and its own Start at his first length`,
      (await tc(page, '.hw-card-head')) === `Homework · 4:30pm · ${tonight.length} steps · ${minutes} min`
      && (await tc(page, '.hw-card-next')) === `Next: Science project: river poster · ${S[0].title}` && (await tc(page, '.hw-card [data-act="hw-card-start"]')) === 'Start · 20 min',
      await tc(page, '.hw-card'));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await until(async () => (await page.evaluate(() => location.hash)) === '#focus' && !!(await page.$('.hw-ring')), 6000);
    const b1 = await one(`select id, step_id, assignment_id, minutes, with_whom, on_time, started_at, ends_at - started_at as len, ended_at from focus_sessions where kid_id = '${P.jordan.id}'`);
    const hub = Date.parse(await h.clockNow());
    check('card: one tap on Start begins a 20-minute block on Next, alone, on time, started by the server\'s clock',
      !!b1 && same([b1.step_id, b1.assignment_id, b1.minutes, b1.with_whom, b1.on_time, b1.len, b1.ended_at], [S[0].id, sci, '20', 'alone', 't', '00:20:00', null])
      && Math.abs(Date.parse(b1.started_at) - hub) < 15000, b1);
    check('#focus: the step, "On time · +5 once 8 minutes are done", and 20 minutes on the ring', (await tc(page, '.hw-focus-title')) === S[0].title
      && (await tc(page, '.hw-ontime')) === 'On time · +5 once 8 minutes are done' && (await tc(page, '.hw-left')) === '20 min', await tc(page, '#app'));
    await shot(page, 'homework-focus');
    // The server's clock moves 20 minutes, and the phone's with it: the ring runs out.
    await h.setClock(new Date(Date.parse(b1.started_at) + 20 * 60000 + 5000).toISOString());
    await page.clock.fastForward('20:05');
    await page.waitForSelector('.hw-end [data-act="hw-end"][data-result="done"]', { timeout: 5000 });
    await page.click('.hw-end [data-act="hw-end"][data-result="done"]');
    await page.waitForSelector('.hw-points-line', { timeout: 5000 });
    const e1 = await one(`select result, seen_minutes, points, ended_at is not null as ended from focus_sessions where id = '${b1.id}'`);
    const s1 = (await steps(sci))[0];
    check('end: Step done ends the block (20 minutes seen by the server, 9 points) and ticks the step, as "Jordan … (My day)"',
      same(e1, { result: 'done', seen_minutes: '20', points: '9', ended: 't' }) && !!s1.done_at && /^Jordan( Example)? \(My day\)$/.test(s1.done_by), { e1, done_by: s1.done_by });
    let l = await ledger();
    check('end: the ledger has +4 focus and +5 on time, on Monday, from the server\'s clock', same(l.map((x) => [x.kind, x.delta, x.day]), [['focus', '4', MON], ['on_time', '5', MON]]), l);
    check('end: the screen shows the server\'s points: "+4 · 20 minutes · +5 on time" and ★ 9', (await tc(page, '.hw-points-line')) === '+4 · 20 minutes · +5 on time'
      && (await tc(page, '.hw-end-balance')) === '★ 9', await tc(page, '.hw-end'));

    // A second block: the phone's clock runs 20 minutes, but the server saw 7.
    await page.click('.hw-end-next [data-act="hw-next"]');
    await page.waitForSelector('.hw-now-card [data-act="hw-start"]', { timeout: 5000 });
    check('#homework: Now is the next step', (await tc(page, '.hw-now-title')) === S[1].title, await tc(page, '.hw-now-card'));
    await page.click('.hw-now-card [data-act="hw-start"]');
    await page.waitForSelector('.hw-ring', { timeout: 5000 });
    const b2 = await one(`select id, step_id, started_at, on_time from focus_sessions where kid_id = '${P.jordan.id}' and ended_at is null`);
    await h.setClock(new Date(Date.parse(b2.started_at) + 7 * 60000 + 10000).toISOString());
    await page.clock.fastForward('20:05');
    await page.waitForSelector('.hw-end [data-act="hw-end"][data-result="more"]', { timeout: 5000 });
    await page.click('.hw-end [data-act="hw-end"][data-result="more"]');
    await page.waitForSelector('.hw-points-line', { timeout: 5000 });
    const e2 = await one(`select result, seen_minutes, points from focus_sessions where id = '${b2.id}'`);
    l = await ledger();
    check('end: a block the phone counted to its end but the server saw 7 minutes of earns what the server saw: More to do, 7 minutes, +1, not on time (the day\'s second)',
      !!b2 && b2.step_id === S[1].id && b2.on_time === 'f' && same(e2, { result: 'more', seen_minutes: '7', points: '1' })
      && same(l.map((x) => [x.kind, x.delta]), [['focus', '4'], ['on_time', '5'], ['focus', '1']]) && (await tc(page, '.hw-points-line')) === '+1 · 7 minutes', { e2, line: await tc(page, '.hw-points-line') });
    const s2 = (await steps(sci))[1];
    check('end: More to do leaves the step open', s2.done_at === null);

    // Quick on the spelling sheet (due Wednesday, no plan): one plain step tonight, given at once.
    await go(page, '#homework');
    await page.waitForSelector(`.hw-noplan[data-asg="${spelling}"] [data-act="hw-quick"]`, { timeout: 5000 });
    await page.click(`.hw-noplan[data-asg="${spelling}"] [data-act="hw-quick"]`);
    await page.click(`.hw-noplan[data-asg="${spelling}"] [data-quick="15"]`);
    await until(async () => (await sql(`select 1 from homework_steps where assignment_id = '${spelling}'`)).length === 1, 5000);
    const q = await one(`select s.id, s.kind, s.title, s.minutes, s.day, s.source, a.given_by from homework_steps s join assignments a on a.id = s.assignment_id where a.id = '${spelling}'`);
    check('quick: one plain 15-minute step, titled as the assignment, tonight, and the plan is given at once by Jordan (My day)',
      !!q && same([q.kind, q.title, q.minutes, q.day], ['step', 'Spelling words', '15', MON]) && /\(My day\)$/.test(q.given_by || ''), q);
    check('quick: it is in Tonight', await until(async () => (await texts(page, '.hw-tonight .hw-step-title')).some((x) => /Spelling words/.test(x)), 4000),
      await texts(page, '.hw-tonight .hw-step-title'));
    // + Homework: his own worksheet, due tomorrow, 15 minutes: added by him, and it is Now.
    await page.click('[data-act="hw-add"]');
    await page.fill('.hw-add-form input[name="title"]', 'Worksheet 5.1');
    await page.fill('.hw-add-form input[name="subject"]', 'Math');
    await page.fill('.hw-add-form input[name="due"]', '2026-11-03');
    await page.click('.hw-add-form [type="submit"]');
    await until(async () => (await tc(page, '.hw-now-title')) === 'Worksheet 5.1', 5000);
    const ws = await one(`select a.id, a.added_by, a.subject, a.due_date, a.given_by, s.minutes, s.day from assignments a join homework_steps s on s.assignment_id = a.id where a.title = 'Worksheet 5.1'`);
    check('+ Homework: his own worksheet (Math, due tomorrow, 15 minutes) is added by him, one step tonight, and it is Now',
      !!ws && same([ws.added_by, ws.subject, ws.due_date, ws.minutes, ws.day], ['kid', 'Math', '2026-11-03', '15', MON]) && /\(My day\)$/.test(ws.given_by || ''), ws);
    // He ticks both.
    for (const id of [q.id, (await one(`select id from homework_steps where assignment_id = '${ws.id}'`)).id]) {
      await page.click(`.hw-tonight .hw-step[data-step="${id}"] .hw-box`);
      await until(async () => !!(await one(`select done_at from homework_steps where id = '${id}'`)).done_at, 4000);
    }
    const done = await sql(`select a.title, a.status, s.done_at is not null as done from assignments a join homework_steps s on s.assignment_id = a.id
      where a.id in ('${spelling}', '${ws.id}') order by a.title`);
    check('tick: both ticked (step_by_token), and as each was the last step, both assignments are done',
      same(done, [{ title: 'Spelling words', status: 'done', done: 't' }, { title: 'Worksheet 5.1', status: 'done', done: 't' }]), done);
    l = await ledger();
    check('tick: ticking plain steps, Quick and his own homework earn nothing', l.length === 3, l);
    await shot(page, 'homework-myday');
    const reqs = await h.requests();
    check('jordan: his My day called only token functions, signed out', reqs.length > 0 && reqs.every((r) => r.role === 'anon' && /_by_token$|\/get_person_day$/.test(r.path)),
      [...new Set(reqs.map((r) => `${r.role} ${r.path}`))]);
    const f = await failures();
    check('jordan: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Wed Nov 4, 4:35pm: a milestone, a question, Re-plan; Pat's Not yet, answer and check; a trade
  // ===================================================================
  await flow('milestone and replan', async () => {
    if (!S.length) throw new Error('no plan');
    await h.setClock(at(WED, '16:35'));
    S = await steps(sci);
    const ms = S.find((s) => s.kind === 'milestone');
    const later = S.find((s) => s.pos > ms.pos && s.kind === 'step' && !s.done_at);
    await h.mark();
    const { page, context } = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}#homework`, label: 'hw-jordan-wed' });
    await page.waitForSelector('.hw-now-card', { timeout: 8000 });
    // The milestone is tonight's (it is on Wednesday, or on Thursday after Tuesday's 15 minutes): make sure it is drawn.
    if (ms.day !== WED) throw new Error(`the milestone is on ${ms.day}, not Wednesday`);
    await page.click(`.hw-tonight .hw-step[data-step="${ms.id}"] .hw-box`);
    await until(async () => !!(await one(`select done_at from homework_steps where id = '${ms.id}'`)).done_at, 4000);
    // The row is written before the page has the answer, so wait for the toast drawn from it.
    const msToast = await until(async () => /\+20 when Pat checks it/.test(await lastToast(page)), 4000);
    const msLedger = await ledger();
    check('milestone: he ticks "Plan it: an outline or a sketch"; the toast says "+20 when Pat checks it" (nothing paid yet)',
      msToast && msLedger.length === 3, { toast: await lastToast(page), ledger: msLedger });
    // Ask Pat, from ⋯ on the next step.
    await page.click(`.hw-step[data-step="${later.id}"] [data-act="hw-more"]`);
    await page.click(`.hw-step[data-step="${later.id}"] .hw-menu [data-act="hw-ask"]`);
    await page.fill('.hw-sheet input[name="text"]', 'Does the poster need a title?');
    await page.click('.hw-sheet [data-act="hw-sheet-send"]');
    await until(async () => (await one(`select question from homework_steps where id = '${later.id}'`)).question === 'Does the poster need a title?', 4000);
    check('ask: his question is on the step (step_by_token ask)', (await one(`select question from homework_steps where id = '${later.id}'`)).question === 'Does the poster need a title?');
    // From earlier: Monday's two steps not done; Re-plan places them again from today.
    await page.click('.hw-earlier summary');
    const earlier = await texts(page, '.hw-earlier .hw-step-title');
    const before = await steps(sci);
    const rev0 = (await one(`select plan_rev from assignments where id = '${sci}'`)).plan_rev;
    await page.click('.hw-earlier [data-act="hw-replan-earlier"]');
    await until(async () => (await one(`select plan_rev from assignments where id = '${sci}'`)).plan_rev !== rev0, 5000);
    const after = await steps(sci);
    const plain = (s) => ['start', 'step', 'check'].includes(s.kind) && !s.done_at;
    check('replan: From earlier lists Monday\'s open steps; Re-plan (plan_by_token, p_steps null) puts every open plain step on today or later, in his homework days',
      earlier.length === 2 && after.filter(plain).every((s) => s.day >= WED && ['2026-11-04', '2026-11-05', '2026-11-09', '2026-11-10', '2026-11-11'].includes(s.day))
      && before.filter(plain).some((s) => s.day < WED), { earlier, before: before.map((s) => [s.title, s.day]), after: after.map((s) => [s.title, s.day]) });
    check('replan: the milestones and the turn-in keep their days, and done steps don\'t move',
      after.filter((s) => s.kind === 'milestone' || s.kind === 'turn_in' || s.done_at).every((s) => s.day === before.find((x) => x.id === s.id).day), after.map((s) => [s.kind, s.day]));
    check('replan: nothing is under From earlier any more', await until(async () => !(await page.$('.hw-earlier')), 4000));
    // Tonight is full after Monday's two steps, so a step before "Finish a full draft" (Thursday) lands
    // after it: the milestone keeps its day, and his screen and Pat's link say to talk about it.
    const draft = after.find((s) => s.kind === 'milestone' && s.pos > ms.pos);
    const reach = after.filter((s) => s.pos < draft.pos && !s.done_at && s.day > draft.day);
    const talk = (await anonRpc('tutor_view_by_token', { p_token: link.token, p_assignment: null, p_part: 'all' })).body.to_talk_about;
    check('replan: a step before "Finish a full draft" no longer fits by its Thursday, so his screen says "… Pick a new day with Pat ›", and Pat\'s link lists it under To talk about',
      reach.length > 0 && draft.day === before.find((s) => s.id === draft.id).day
      && await until(async () => /^Finish a full draft was planned for .+\. Pick a new day with Pat ›$/.test(await tc(page, '.hw-talk')), 4000)
      && same((talk || []).map((x) => [x.assignment_id, x.title, x.milestone, x.planned_day]), [[sci, 'Science project: river poster', 'Finish a full draft', draft.day]]),
      { talk, line: await tc(page, '.hw-talk') });
    await context.close();

    // Pat: Not yet with a note, from the link.
    const pat = await open({ path: `/day.html?h=${link.token}`, label: 'hw-pat-wed' });
    await pat.page.waitForSelector(`.plan-row[data-step="${ms.id}"] [data-act="not-yet"]`, { timeout: 8000 });
    await pat.page.click(`.plan-row[data-step="${ms.id}"] [data-act="not-yet"]`);
    await pat.page.fill('.plan-note input[name="text"]', 'Add a source for the second point.');
    await pat.page.click('.plan-note [type="submit"]');
    await until(async () => !!(await one(`select not_yet_at from homework_steps where id = '${ms.id}'`)).not_yet_at, 4000);
    const ny = (await steps(sci)).find((s) => s.id === ms.id);
    check('not yet: Pat\'s Not yet unticks the milestone with the note, by the tutor, and pays nothing',
      ny.done_at === null && ny.coach_note === 'Add a source for the second point.' && ny.coach_note_by === 'tutor' && (await ledger()).length === 3, ny);
    await pat.context.close();
    // Jordan sees it under the milestone, and ticks it again.
    const j = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}#homework`, label: 'hw-jordan-notyet' });
    await j.page.waitForSelector(`.hw-step[data-step="${ms.id}"]`, { timeout: 8000 });
    check('not yet: Jordan sees "Not yet: Add a source for the second point." under the milestone', (await tc(j.page, `.hw-step[data-step="${ms.id}"] .hw-note`)) === 'Not yet: Add a source for the second point.',
      await tc(j.page, `.hw-step[data-step="${ms.id}"]`));
    await j.page.click(`.hw-step[data-step="${ms.id}"] .hw-box`);
    await until(async () => !!(await one(`select done_at from homework_steps where id = '${ms.id}'`)).done_at, 4000);
    check('not yet: he ticks it again; the note goes', (await one(`select coach_note, not_yet_at from homework_steps where id = '${ms.id}'`)).not_yet_at === null);
    await j.context.close();

    // Pat answers his question and checks the milestone.
    await h.mark();
    const p2 = await open({ path: `/day.html?h=${link.token}`, label: 'hw-pat-check' });
    await p2.page.waitForSelector(`.plan-row[data-step="${later.id}"] [data-act="answer"]`, { timeout: 8000 });
    await p2.page.click(`.plan-row[data-step="${later.id}"] [data-act="answer"]`);
    await p2.page.fill('.plan-note input[name="text"]', 'Yes, a short title at the top.');
    await p2.page.click('.plan-note [type="submit"]');
    await until(async () => (await one(`select answer from homework_steps where id = '${later.id}'`)).answer === 'Yes, a short title at the top.', 4000);
    const ans = await one(`select answer, answer_by from homework_steps where id = '${later.id}'`);
    check('answer: Pat\'s answer is on the step, by "Pat Lee, tutor (tutor link)"', ans.answer_by === PAT_WHO, ans);
    await p2.page.waitForSelector(`.plan-row[data-step="${ms.id}"] [data-act="looks-done"]`, { timeout: 5000 });
    await p2.page.click(`.plan-row[data-step="${ms.id}"] [data-act="looks-done"]`);
    await p2.page.fill('.plan-note input[name="text"]', 'Clear outline. The third point is the strongest.');
    await p2.page.click('.plan-note [type="submit"]');
    await until(async () => !!(await one(`select checked_at from homework_steps where id = '${ms.id}'`)).checked_at, 4000);
    const ck = (await steps(sci)).find((s) => s.id === ms.id);
    const l = await ledger();
    check('check: Looks done checks the milestone with the note, by Pat\'s link, and pays +20 (milestone, today, "Pat Lee, tutor (tutor link)")',
      ck.checked_by === PAT_WHO && ck.coach_note === 'Clear outline. The third point is the strongest.' && ck.coach_note_by === 'tutor'
      && same(l.slice(-1).map((x) => [x.kind, x.delta, x.day, x.who]), [['milestone', '20', WED, PAT_WHO]]), { ck, l });
    const toasts = await texts(p2.page, '.toasts');
    check('check: Pat\'s page names no points', toasts.length > 0 && !toasts.some((x) => /\+\d|point/i.test(x.replace('3 main points', ''))), toasts);
    const reqs = await h.requests();
    check('pat: every call from the link was one of its four functions, signed out', reqs.length > 0 && reqs.every((r) => r.role === 'anon' && TUTOR_FNS.test(r.path)),
      [...new Set(reqs.map((r) => `${r.role} ${r.path}`))]);
    await p2.context.close();
    const v = await view();
    const vs = v.assignments.find((x) => x.id === sci).steps;
    check('his view: the milestone checked with Pat\'s words (coach by "tutor"), and Pat\'s answer under his question, with no name',
      same(vs.find((x) => x.id === ms.id).coach, { by: 'tutor', text: 'Clear outline. The third point is the strongest.' }) && vs.find((x) => x.id === ms.id).checked === true
      && vs.find((x) => x.id === later.id).answer === 'Yes, a short title at the top.' && !/Pat Lee|@/.test(JSON.stringify(v)), vs.find((x) => x.id === ms.id));
    const f = await failures();
    check('milestone and replan: no API request failed', !f.length, f);
  });

  await flow('trade', async () => {
    if (!reward) throw new Error('no reward');
    await h.mark();
    const j = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}#points`, label: 'hw-jordan-points' });
    await j.page.waitForSelector('.hw-balance-big', { timeout: 8000 });
    check('#points: his balance is the server\'s, ★ 30 (4 + 5 + 1 + 20)', (await tc(j.page, '.hw-balance-big')) === '★ 30', await tc(j.page, '.hw-balance-big'));
    await j.page.click(`.hw-reward[data-reward="${reward}"] [data-act="hw-ask-reward"]`);
    await until(async () => !!(await one(`select id from reward_asks where kid_id = '${P.jordan.id}'`)), 4000);
    const ask = await one(`select id, title, cost, status, reward_id from reward_asks where kid_id = '${P.jordan.id}'`);
    check('ask: reward_by_token ask holds 15 points for "15 minutes of extra game time", waiting; "Tell a parent you asked."',
      same([ask.title, ask.cost, ask.status, ask.reward_id], ['15 minutes of extra game time', '15', 'waiting', reward])
      && await until(async () => /Tell a parent you asked\./.test(await tc(j.page, '.hw-asks')), 4000), await tc(j.page, '.hw-asks'));
    await shot(j.page, 'homework-points');
    await j.context.close();

    // Sam (a member): no Yes anywhere, and the database refuses him.
    const sam = await open({ email: 'sam@example.com', path: '/', label: 'hw-sam' });
    check('sam: Today has no homework lines for Sam', !(await sam.page.$('.today-hw')));
    await go(sam.page, '#/homework');
    await until(async () => !!(await sam.page.$('.hw-ask')), 5000);
    check('sam: the Homework page shows the ask read-only (no Yes, no Give points, no + Assignment)', !!(await sam.page.$('.hw-ask'))
      && !(await sam.page.$('#main [data-act="yes"], #main [data-act="give"], #main [data-act="add-assignment"], #main [data-act="looks-done"]')), await tc(sam.page, '[data-sec="approve"]'));
    await sam.context.close();
    const refused = await rpcAs('sam@example.com', 'decide_reward', { p_ask: ask.id, p_approve: true });
    check('sam: decide_reward as Sam is refused (403, "Only a parent can change homework.") and the ask still waits',
      refused.status === 403 && refused.body.message === 'Only a parent can change homework.' && (await one(`select status from reward_asks where id = '${ask.id}'`)).status === 'waiting', refused);

    // Alex: Yes on Today, with the balance and this week's points beside it.
    const a = await open({ email: 'alex@example.com', phone: true, path: '/', label: 'hw-alex-today' });
    await a.page.waitForSelector(`.today-hw-ask[data-ask="${ask.id}"]`, { timeout: 8000 });
    const line = await tc(a.page, `.today-hw-ask[data-ask="${ask.id}"]`);
    check('today: "Jordan asks: 15 minutes of extra game time · 15 · balance 30 (this week: +10 focus and on time, +20 milestones checked by Pat)" with Yes and Not now',
      line === 'Jordan asks: 15 minutes of extra game time · 15 · balance 30 (this week: +10 focus and on time, +20 milestones checked by Pat) Yes Not now', line);
    await shot(a.page, 'homework-today');
    await a.page.click(`.today-hw-ask[data-ask="${ask.id}"] [data-act="hw-yes"]`);
    await until(async () => (await one(`select status from reward_asks where id = '${ask.id}'`)).status === 'approved', 4000);
    const dec = await one(`select status, decided_by, decided_at is not null as at from reward_asks where id = '${ask.id}'`);
    const l = await ledger();
    check('today: Yes (decide_reward) approves it, by Alex, and writes the trade, −15', same(dec, { status: 'approved', decided_by: 'alex@example.com', at: 't' })
      && same(l.slice(-1).map((x) => [x.kind, x.delta, x.who]), [['trade', '-15', 'alex@example.com']]), { dec, l });
    check('today: the line goes', await until(async () => !(await a.page.$(`.today-hw-ask[data-ask="${ask.id}"]`)), 4000));
    await a.context.close();
    const v = await view();
    check('his view: balance 15, nothing held, the ask approved', v.points.balance === 15 && v.points.held === 0 && v.asks.some((x) => x.id === ask.id && x.status === 'approved'), v.points);
    const f = await failures();
    check('trade: no API request failed (but Sam\'s refusal)', same(f, [`POST /rest/v1/rpc/decide_reward → 403 42501 Only a parent can change homework.`]), f);
  });

  // The Homework page, as the parents see it now: Pat's answer and note, his blocks and points.
  await flow('parents see', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'morgan@example.com', path: '/#/homework', label: 'hw-morgan' });
    await page.waitForSelector('.hw-kidline', { timeout: 8000 });
    check('parents: the kid line has his balance', /^Jordan · 15 points/.test(await tc(page, '.hw-kidline')), await tc(page, '.hw-kidline'));
    const qa = await texts(page, '[data-sec="qa"] li');
    check('parents: Questions and notes show Pat\'s answer and Pat\'s note to Jordan, with who gave them',
      qa.some((x) => /Answered by Pat Lee, tutor .*“Yes, a short title at the top\.”/.test(x)) && qa.some((x) => /Pat's note on .*“Clear outline\. The third point is the strongest\.”/.test(x)), qa);
    const blocks = await texts(page, '[data-sec="week"] .hw-blocks li');
    check('parents: his two blocks this week, with the step and the result', blocks.length === 2 && blocks.some((x) => /20 min · Step done/.test(x)) && blocks.some((x) => /More to do/.test(x)), blocks);
    await shot(page, 'homework-page');
    const f = await failures();
    check('parents see: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Pat's link: Off, On, New link, past its end date; homework off
  // ===================================================================
  await flow('link stops', async () => {
    if (!link) throw new Error('no tutor link');
    const patSays = async (token, label) => {
      const p = await open({ path: `/day.html?h=${token}`, label });
      await until(async () => !!(await p.page.$('.plan-head, .day-problem')), 6000);
      const words = await tc(p.page, '.day-problem');
      await p.context.close();
      return words;
    };
    const GONE = 'This link no longer works. Ask the family for a new one.';
    const viewOf = async (token) => (await anonRpc('tutor_view_by_token', { p_token: token, p_assignment: null, p_part: 'all' })).body;
    await h.mark();
    const a = await open({ email: 'alex@example.com', path: '/#/homework', label: 'hw-alex-link' });
    await a.page.waitForSelector('.hw-link [data-act="link-off"]', { timeout: 8000 });
    await a.page.click('.hw-link [data-act="link-off"]');
    await until(async () => (await one(`select active from tutor_links where id = '${link.id}'`)).active === 'f', 4000);
    check('link: Off stops it at once (tutor_view_by_token answers null; the page says it no longer works)', (await viewOf(link.token)) === null
      && (await patSays(link.token, 'hw-pat-off')) === GONE);
    await a.page.click('.hw-link [data-act="link-on"]');
    await until(async () => (await one(`select active from tutor_links where id = '${link.id}'`)).active === 't', 4000);
    check('link: On again, it works', !!(await viewOf(link.token)) && (await patSays(link.token, 'hw-pat-on')) === '');
    await a.page.click('.hw-link [data-act="new-token"]');
    await until(async () => (await one(`select token from tutor_links where id = '${link.id}'`)).token !== link.token, 4000);
    const fresh = (await one(`select token from tutor_links where id = '${link.id}'`)).token;
    check('link: New link: the old address stops, the new one works', (await viewOf(link.token)) === null && !!(await viewOf(fresh))
      && (await patSays(link.token, 'hw-pat-old')) === GONE, fresh);
    await sql(`update tutor_links set expires_on = public.today_local() - 1 where id = '${link.id}'`);
    check('link: past its end date, it stops', (await viewOf(fresh)) === null && (await patSays(fresh, 'hw-pat-ended')) === GONE);
    await sql(`update tutor_links set expires_on = public.today_local() + 30 where id = '${link.id}'`);
    // Homework off: his card goes, and Pat's link stops; nothing is deleted.
    await go(a.page, '#/homework');
    await a.page.click('[data-row="kid"] input[data-act="kid-on"]');
    await until(async () => (await one(`select active from homework_kids where kid_id = '${P.jordan.id}'`)).active === 'f', 4000);
    const day = (await anonRpc('get_person_day', { p_token: P.jordan.day_token })).body;
    const j = await open({ phone: true, path: `/day.html?t=${P.jordan.day_token}`, label: 'hw-jordan-off' });
    await j.page.waitForSelector('.day-head', { timeout: 8000 });
    check('homework off: no card on his My day (get_person_day has no homework key), his homework functions answer null, Pat\'s link stops; nothing deleted',
      !!day && !('homework' in day) && !(await j.page.$('.hw-card')) && (await view()) === null && (await viewOf(fresh)) === null
      && (await one(`select count(*) as n from homework_steps`)).n === '11', day && Object.keys(day));
    await j.context.close();
    await a.context.close();
    const f = await failures();
    check('link stops: no API request failed (a link that stops answers null, not an error)', !f.length, f);
  });

  // A ledger past the API's 1,000 rows (the stand-in cuts a read at 1,000, as Supabase does): 1,200 points
  // given last school year, then an ask. Today and the Homework page add up every row, as his view does.
  await flow('a long ledger', async () => {
    await h.mark();
    await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
    await sql(`insert into points_ledger (kid_id, at, day, kind, delta, note, who)
      select '${P.jordan.id}', timestamptz '2025-09-08 21:00:00+00' + i * interval '5 hours', (timestamptz '2025-09-08 21:00:00+00' + i * interval '5 hours')::date,
             'given', 1, 'Old points', 'alex@example.com'
      from generate_series(1, 1200) i`);
    const rid = (await one(`select id from rewards where kid_id = '${P.jordan.id}' and cost = 60`)).id;
    const asked = await anonRpc('reward_by_token', { p_token: P.jordan.day_token, p_action: 'ask', p_reward: rid, p_key: '00000000-0000-4000-8000-00000000a5c1' });
    const pts = ((await view()) || {}).points || {};
    const rows = Number((await one(`select count(*) as n from points_ledger where kid_id = '${P.jordan.id}'`)).n);
    check('a long ledger: more than 1,000 rows, his view\'s balance 1215, the ask waiting', rows > 1000 && pts.balance === 1215 && asked.status === 200, { rows, pts, asked: asked.status });
    const a = await open({ email: 'alex@example.com', path: '/', label: 'hw-alex-long' });
    await a.page.waitForSelector('.today-hw-ask', { timeout: 8000 });
    const line = await tc(a.page, '.today-hw-ask');
    check('a long ledger, Today: "Jordan asks: Choose Friday\'s dinner · 60 · balance 1215 (this week: …)", every row counted', /^Jordan asks: Choose Friday's dinner · 60 · balance 1215 \(this week: /.test(line), line);
    await go(a.page, '#/homework');
    await a.page.waitForSelector('.hw-ask', { timeout: 8000 });
    check('a long ledger, the Homework page: "Jordan · 1215 points" and the ask with "balance 1215"', /^Jordan · 1215 points/.test(await tc(a.page, '.hw-kidline'))
      && / · balance 1215 \(/.test(await tc(a.page, '.hw-ask .hw-ask-line')), [await tc(a.page, '.hw-kidline'), await tc(a.page, '.hw-ask .hw-ask-line')]);
    await a.context.close();
    const f = await failures();
    check('a long ledger: no API request failed', !f.length, f);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  homework stopped: ${e && e.stack}`); process.exit(1); });
