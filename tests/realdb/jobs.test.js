// The morning email against the REAL database (tests/realdb/run.sh): the real hub-jobs handler
// (supabase/functions/hub-jobs/handler.ts) runs as the Edge Function would, as service_role on this
// database (digest_due, claim_notification, digest_for, finish_notification, roll_missed_tasks,
// people_confirm), with only Resend faked; the Settings page asks it for status and a preview.
// Then Google Calendar (docs/v1.1-google-calendar.md, migration 0003), against the fake Google in
// lib.js: an admin sets calendars in Settings, Tests them, approves what they copy and presses Sync
// now; what Google then holds; a second run that writes nothing; an edit in the hub that is one
// update; events typed into Google that reach the Calendar page, day_text, the email and My day;
// and events changed or deleted in Google that are put back, and listed in Settings.
// Same household as flows.test.js; its own copy of the database. The clock starts on Tue Oct 27 at
// 09:00 in New York, inside the 6:30 morning email's 3-hour window.
const { setup } = require('./lib');

const TODAY = '2026-10-27';
const SA = 'home-hub-sync@home-hub-example.iam.gserviceaccount.com';   // lib.js's service account
const GID = (s) => `${s}@group.calendar.google.com`;
const CAL = { taylor: GID('taylor0123'), jordan: GID('jordan0123'), family: GID('family0123'), main: 'family@example.com' };

(async () => {
  const h = await setup('jobs');
  const { check, flow, sql, open, settle, tc, texts, until, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || r.error.error || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args || {}) });
  };

  // The household's morning email settings, the way the Family page saves them (save_person as Alex),
  // and the day's items.
  await flow('setup', async () => {
    const saves = [
      [{ id: P.alex.id, digest_enabled: true, digest_day: 'today', digest_scope: 'mine' }, true],
      [{ id: P.morgan.id, digest_enabled: true, digest_day: 'today' }, true],
      [{ id: P.sam.id, digest_enabled: true, digest_day: 'tomorrow' }, true],
      [{ id: P.taylor.id, email: 'taylor@example.com', digest_enabled: true, digest_day: 'today' }, false],
    ];
    for (const [p, signIn] of saves) {
      const r = await rpcAs('alex@example.com', 'save_person', { p, p_can_sign_in: signIn });
      if (r.status !== 200) throw new Error(`save_person ${JSON.stringify(p)}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    // Alex and Sam have signed in (that confirms their addresses); Taylor confirms from her email's link.
    await rpcAs('alex@example.com', 'mark_signed_in');
    await rpcAs('sam@example.com', 'mark_signed_in');
    const c = await one(`select token from people_confirm where person_id = '${P.taylor.id}'`);
    const conf = await h.api('/rest/v1/rpc/confirm_digest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_confirm: c.token }) });
    check('setup: Taylor confirms her address with the confirmation secret alone (signed out)', conf.status === 200 && conf.body === true, conf);
    await sql(`
      insert into events (title, start_date, start_time, end_time, responsible_id, participant_ids, repeat, location)
      values ('Piano', '${TODAY}', '16:00', '17:00', '${P.taylor.id}', '{${P.jordan.id}}', 'weekly', 'Music school');
      insert into tasks (title, category, responsible_id, due_date, repeat_mode, every_count, every_unit)
      values ('Heartworm pill', 'pets', '${P.taylor.id}', '${TODAY}', 'schedule', 1, 'month');
      insert into tasks (title, responsible_id, due_date) values ('Return library books', '${P.taylor.id}', '2026-10-20');
      insert into tasks (title, due_date) values ('Buy birthday card', '${TODAY}');
      insert into tasks (title, responsible_id, due_date, due_time) values ('Take the car in', '${P.sam.id}', '2026-10-28', '08:15');
      insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit)
      values ('Water the plants', '${P.alex.id}', '2026-10-13', 'schedule', 1, 'week');
      update projects set owner_id = '${P.morgan.id}' where name = 'Kitchen Renovation';`);
  });

  // ===================================================================
  // The 6:30 run (the clock is at 9:00, inside the window)
  // ===================================================================
  await flow('morning run', async () => {
    await h.mark();
    const r = await h.runDigest();
    check('morning run: hub-jobs answers 200 ok on the real database', r.status === 200 && r.body.ok === true, r.body);
    const to = h.sent.map((e) => `${e.to[0]} ${e.idempotencyKey.split('-')[0]}`).sort();
    check('morning run: digests for Alex and Taylor, a confirmation for Morgan; Sam (evening) waits', JSON.stringify(to) === JSON.stringify(['alex@example.com digest', 'morgan@example.com confirm', 'taylor@example.com digest']), to);
    const taylor = h.sent.find((e) => e.to[0] === 'taylor@example.com');
    check('morning run: Taylor\'s email is in Spanish, with Piano at 16:00 and the late library books', !!taylor && /^mar 27 oct: 16:00 Piano/.test(taylor.subject) && /Return library books/.test(taylor.text) && /Atrasado/.test(taylor.text), taylor && taylor.subject);
    const alex = h.sent.find((e) => e.to[0] === 'alex@example.com');
    check('morning run: Alex\'s email has Taylor\'s and Jordan\'s day and "Nobody\'s on it" (the birthday card)',
      !!alex && /^Taylor · /m.test(alex.text) && /^Jordan · /m.test(alex.text) && /Buy birthday card/.test(alex.text), alex && alex.text.slice(0, 600));
    // People by first name, as day_text writes them: Taylor's block is her own day_text, in Spanish.
    check('morning run: the blocks name people by first name ("Piano · con Jordan" for Taylor, "Piano · Taylor" for Jordan)',
      !!alex && /16:00 Piano · con Jordan/.test(alex.text) && /4:00pm Piano · Taylor\b/.test(alex.text) && !/(Taylor|Jordan) Example/.test(alex.text), alex && alex.text.slice(0, 600));
    // Morgan's confirmation email: its button opens day.html with the confirmation secret alone. No My day
    // token anywhere in it, so an email that goes to a mistyped address gives nothing away.
    const morgan = h.sent.find((e) => e.to[0] === 'morgan@example.com');
    const mc = await one(`select c.token, p.day_token from people p join people_confirm c on c.person_id = p.id where p.id = '${P.morgan.id}'`);
    const links = morgan ? [...new Set(`${morgan.html}\n${morgan.text}`.match(/https?:\/\/[^\s"'<>)]+/g) || [])] : [];
    check('morning run: Morgan\'s confirmation email links to day.html?c=<her secret>#confirm, and carries no My day token',
      !!morgan && links.includes(`https://family.example/hub/day.html?c=${mc.token}#confirm`) && !links.some((l) => /[?&]t=/.test(l))
      && !`${morgan.html}${morgan.text}${morgan.subject}`.includes(mc.day_token), links);
    check('morning run: Morgan gets the kitchen project\'s line (she owns it); Alex doesn\'t', !(alex && /Kitchen Renovation/.test(alex.text)), alex && alex.text);
    const log = await sql("select p.name, n.kind, n.status, n.local_date from notification_log n join people p on p.id = n.person_id order by p.name");
    check('morning run: notification_log has the three, sent, for today', log.length === 3 && log.every((x) => x.status === 'sent' && x.local_date === TODAY), log);
    const runs = await sql('select ok, sent, detail from job_runs');
    check('morning run: one job_runs row, ok, 3 sent', runs.length === 1 && runs[0].ok === 't' && runs[0].sent === '3', runs);
    const water = await one("select due_date, (select count(*) from task_log l where l.task_id = t.id and l.status = 'missed') as missed from tasks t where title = 'Water the plants'");
    check('morning run: roll_missed_tasks moved the weekly plants (due Oct 13) to Oct 27 and logged the misses', water.due_date === TODAY && water.missed === '1', water);
    const again = await h.runDigest();
    check('morning run: running again sends nothing (the claims hold)', again.status === 200 && h.sent.length === 3 && again.body.busy === 0 && again.body.due === 0, again.body);
    const f = await failures();
    check('morning run: no API request failed', !f.length, f);
  });

  // ===================================================================
  // Settings: the status and a preview, from the page
  // ===================================================================
  await flow('settings status', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'settings-jobs' });
    await until(async () => (await tc(page, '[data-ref="status"]')) !== '');
    await settle(page, 300);
    const status = await tc(page, '[data-ref="status"]');
    check('settings: the morning email\'s status comes from the real hub-jobs (last run, sent today)', /3/.test(status) && !/Not set up/.test(status), status);
    await page.click('[data-act="preview"]');
    await settle(page, 800);
    const preview = await page.evaluate(() => {
      const d = document.getElementById('formDialog');
      const f = d && d.querySelector('iframe');
      return { open: d && d.open, text: d ? d.innerText.replace(/\s+/g, ' ').slice(0, 500) : '', frame: f ? (f.srcdoc || '').slice(0, 200) : '' };
    });
    check('settings: Preview my morning email shows Alex\'s email', preview.open && /Tue Oct 27/.test(preview.text + preview.frame), preview);
    const f = await failures();
    check('settings: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // The evening run: Sam's "tomorrow" email at 7pm
  // ===================================================================
  await flow('evening run', async () => {
    await h.mark();
    await h.setClock('2026-10-27T23:05:00Z');   // 7:05pm in New York
    const before = h.sent.length;
    const r = await h.runDigest();
    const sam = h.sent.slice(before).find((e) => e.to[0] === 'sam@example.com');
    check('evening run: Sam gets tomorrow\'s plan (Wed Oct 28) at 7pm, with the car at 8:15am', r.status === 200 && !!sam && /^Wed Oct 28: 8:15am Take the car in/.test(sam.subject), { body: r.body, subject: sam && sam.subject });
    check('evening run: nobody else gets a second email', h.sent.length - before === 1, h.sent.slice(before).map((e) => e.to[0]));
    const f = await failures();
    check('evening run: no API request failed', !f.length, f);
  });

  // ===================================================================
  // Google Calendar: Settings sets three Hub calendars and the family account's main calendar,
  // Tests each, approves what they copy (one item made private from the preview), and Syncs now
  // ===================================================================
  // The family Gmail's calendars, as the owner makes them (setup step D): shared with the service
  // account with "Make changes and see event details"; the main calendar with "See event details".
  const G = h.google;
  G.add(CAL.taylor, { summary: 'Hub – Taylor' });
  G.add(CAL.jordan, { summary: 'Hub – Jordan' });
  G.add(CAL.family, { summary: 'Hub – Family' });
  G.add(CAL.main, { summary: 'family@example.com', role: 'reader' });
  const hubEvents = (cal) => G.events(cal).filter((e) => e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.homehub === '1');
  const props = (e) => (e.extendedProperties && e.extendedProperties.private) || {};
  const findEv = (cal, item, occ) => hubEvents(cal).find((e) => props(e).homehub_item === item && (!occ || props(e).homehub_occurrence === occ)) || null;
  const lastRun = async () => JSON.parse((await one('select last_result::text as r from calendar_sync')).r || '{}');
  const later = async (min) => h.setClock(new Date(Date.parse(await h.clockNow()) + min * 60000).toISOString());
  const ids = {};

  await flow('calendar set up', async () => {
    await sql(`
      insert into events (title, start_date, start_time, end_time, responsible_id, location)
      values ('Soccer practice', '2026-10-29', '16:00', '17:00', '${P.jordan.id}', 'Field 3');
      insert into events (title, start_date, start_time, end_time, responsible_id, location, private)
      values ('Orthodontist', '2026-10-30', '15:00', '16:00', '${P.jordan.id}', 'Smile Clinic', true);
      insert into events (title, start_date, start_time, end_time, responsible_id) values ('Haircut', '2026-11-02', '17:00', '17:30', '${P.jordan.id}');`);
    for (const t of ['Piano', 'Soccer practice', 'Orthodontist', 'Haircut']) ids[t] = (await one(`select id from events where title = '${t}'`)).id;
    for (const t of ['Heartworm pill', 'Buy birthday card', 'Return library books']) ids[t] = (await one(`select id from tasks where title = '${t}'`)).id;
    // The first visit to Today fills in the kitchen project's task dates (from its v1 schedule), so its
    // jobs go to Google too (Morgan owns it but has no calendar, and there is no House: Family).
    const first = await open({ email: 'alex@example.com', path: '/', label: 'calendar-today' });
    await first.context.close();
    ids.kitchen = (await one("select id from projects where name = 'Kitchen Renovation' and task_dates is not null")).id;
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'calendar-setup' });
    await page.waitForSelector('[data-ref="gcolumns"]', { timeout: 10000 });
    check('calendar setup: before any run, the card says the Google key isn\'t set up yet', /^Not set up: add the Google key to Supabase/.test(await tc(page, '[data-ref="gstatus"]')),
      await tc(page, '[data-ref="gstatus"]'));

    // Set → paste the Calendar ID → Save: the row is saved, Test runs, and (for a calendar the hub
    // writes) everything Start copying would put on it is listed (yesterday to 60 days ahead).
    const set = async (slot, id) => {
      await page.click(`[data-gset="${slot}"]`);
      await page.waitForSelector('#formDialog input[name="google_id"]');
      await page.fill('#formDialog input[name="google_id"]', id);
      await page.click('#formDialog [type="submit"]');
      await page.waitForSelector('#formDialog [data-ref="test"] .set-gtest', { timeout: 20000 });
      await until(async () => !(await texts(page, '#formDialog [data-ref="pv"] li')).includes('Loading…'), 10000);
      return {
        test: await tc(page, '#formDialog [data-ref="test"] .set-gtest p'),
        steps: await texts(page, '#formDialog .set-gsteps li'),
        preview: await texts(page, '#formDialog [data-ref="pv"] .set-pv-title'),
      };
    };
    const start = async () => {
      await page.click('#formDialog [data-gstart]');
      await until(async () => !(await page.evaluate(() => document.getElementById('formDialog').open)));
      await settle(page, 300);
    };
    const ALL_DONE = ['Read the calendar: done', 'Add a test event: done', 'Delete it: done', 'Bring it back: done', 'Read it back: done', 'Same as what was written: done', 'Delete it again: done'];

    // Taylor's first: its Test is gate 2.
    const n0 = G.requests.length;
    const t = await set(`person:${P.taylor.id}`, CAL.taylor.toUpperCase());
    check('calendar setup: Taylor\'s Test adds, deletes, brings back, reads and deletes a test event in Google, every step done',
      t.test === 'Test: Home Hub can write to this calendar.' && JSON.stringify(t.steps) === JSON.stringify(ALL_DONE), t);
    const testCalls = G.requests.slice(n0).map((r) => `${r.method} ${r.event ? 'event' : 'events'} ${r.status}`);
    check('calendar setup: Test\'s calls to Google: list one, POST, DELETE, PUT (it comes back), GET, DELETE', JSON.stringify(testCalls)
      === JSON.stringify(['GET events 200', 'POST events 200', 'DELETE event 204', 'PUT event 200', 'GET event 200', 'DELETE event 204']), testCalls);
    check('calendar setup: Test leaves nothing in Google (its event is on 2001-01-01, deleted again)', !G.events(CAL.taylor).length
      && G.all(CAL.taylor).every((e) => /^hhtest[0-9a-f]{16}$/.test(e.id) && e.start.date === '2001-01-01'), G.all(CAL.taylor));
    check('calendar setup: Taylor\'s preview lists what Start copying puts on the wall, as it will show it (in Spanish)', t.preview.includes('Piano (con Jordan)')
      && t.preview.includes('☐ Mascotas: Heartworm pill') && t.preview.some((x) => /Return library books/.test(x)), t.preview);
    check('calendar setup: ... the whole window Start copying covers, not just the next 14 days (Piano every Tuesday, well into December)',
      t.preview.filter((x) => x === 'Piano (con Jordan)').length >= 5, t.preview);
    await start();
    check('calendar setup: Start copying says when copying starts', /^Copying to Hub – Taylor starts within 5 minutes/.test(await h.lastToast(page)), await h.lastToast(page));

    const j = await set(`person:${P.jordan.id}`, CAL.jordan);
    check('calendar setup: Jordan\'s Test passes; the preview has Piano with who\'s in charge, Soccer, and the private Orthodontist as "Private item"',
      j.test === 'Test: Home Hub can write to this calendar.' && ['Piano (Taylor)', 'Soccer practice', 'Private item', 'Haircut'].every((x) => j.preview.includes(x)) && !j.preview.includes('Orthodontist'), j);
    await page.click(`#formDialog [data-gprivate="event|${ids.Haircut}"]`);
    await until(async () => !(await texts(page, '#formDialog [data-ref="pv"] .set-pv-title')).includes('Haircut'));
    const hair = await one(`select private from events where id = '${ids.Haircut}'`);
    check('calendar setup: Make private in the preview sets the event\'s private, and the preview shows it as "Private item"', hair.private === 't'
      && !(await texts(page, '#formDialog [data-ref="pv"] .set-pv-title')).includes('Haircut'), hair);
    await start();

    const fam = await set('family', `  ${CAL.family} `);
    check('calendar setup: Family\'s Test passes; its preview has the task nobody is on', fam.test === 'Test: Home Hub can write to this calendar.' && fam.preview.includes('☐ Buy birthday card'), fam);
    await start();

    const m = await set('main', 'Family@Example.com');
    check('calendar setup: the family account\'s main calendar (read only): Test only reads it, and there is nothing to approve',
      m.test === 'Test: Home Hub can read this calendar.' && !(await page.$('#formDialog [data-gstart]')) && !(await page.$('#formDialog [data-ref="pv"]')), m);
    await page.click('#formDialog .form-actions [data-close]');
    await settle(page, 300);

    const cals = await sql('select google_id, kind, writes, status, google_name, access_role, copy_approved_at is not null as approved from calendars order by google_id');
    check('calendar setup: four calendars rows, every one ok after its Test; the three Hub calendars approved', JSON.stringify(cals.map((c) => [c.google_id, c.kind, c.writes, c.status, c.google_name, c.access_role, c.approved]))
      === JSON.stringify([[CAL.family, 'family', 't', 'ok', 'Hub – Family', 'writer', 't'], ['family@example.com', 'family', 'f', 'ok', 'family@example.com', 'reader', 'f'],
        [CAL.jordan, 'person', 't', 'ok', 'Hub – Jordan', 'writer', 't'], [CAL.taylor, 'person', 't', 'ok', 'Hub – Taylor', 'writer', 't']]), cals);
    check('calendar setup: Not on Google lists the people without a Hub calendar', /Alex, Morgan, Sam/.test(await tc(page, '[data-ref="gmissing"]')), await tc(page, '[data-ref="gmissing"]'));

    // Sync now: reads every calendar, and copies what calendar_plan says (60 at most in one run).
    const n1 = G.requests.length;
    await page.click('[data-act="gsync"]');
    await page.waitForSelector('[data-ref="gsync"]', { timeout: 30000 });
    const note = await tc(page, '[data-ref="gsync"]');
    const r1 = await lastRun();
    check('calendar setup: Sync now reads the four calendars and copies to Google; the page says what it did', /^Synced: \d+ added in Google\. 4 calendars read\./.test(note)
      && r1.read === 4 && r1.inserted > 20 && r1.failed === 0 && r1.repaired === 0 && r1.stop === null, { note, r1 });
    const reads = G.requests.slice(n1).filter((r) => r.method === 'GET');
    check('calendar setup: each read asks for ordinary events, single days, the household\'s zone and the fields it keeps (no email, no description)',
      reads.length === 4 && reads.every((r) => r.query.eventTypes === 'default' && r.query.singleEvents === 'true' && r.query.timeZone === 'America/New_York'
        && r.query.timeMin === '2026-10-26T04:00:00.000Z' && r.query.timeMax === '2026-12-27T05:00:00.000Z' && /^accessRole,summary,nextPageToken,items\(/.test(r.query.fields)
        && !/description|email/.test(r.query.fields)), reads.map((r) => r.query));
    const status = await tc(page, '[data-ref="gstatus"]');
    check('calendar setup: the card now says who the hub signs in as, with the key id\'s last 6 characters, and when it last synced',
      status.includes(`Signed in as ${SA}`) && /key …a1b2c3/.test(status) && /Last synced just now/.test(status), status);
    await shot(page, 'settings-google');
    // The rest of the first copy, as pg_cron's runs would do it.
    for (let i = 0; i < 10 && ((await lastRun()).pending || 0) > 0; i++) await h.runCalendar();
    const f = await failures();
    check('calendar setup: no API request failed', !f.length, f);
    await context.close();
  });

  await flow('calendar copied', async () => {
    const links = await sql('select google_calendar, event_id, status, item_kind, hash is not null as hashed from calendar_links order by google_calendar, day, event_id');
    const inGoogle = [CAL.taylor, CAL.jordan, CAL.family].flatMap((c) => hubEvents(c).map((e) => `${c} ${e.id}`)).sort();
    check('calendar copied: calendar_links has one ok row for each event the hub has in Google, and Google has nothing else of the hub\'s',
      links.length > 20 && links.every((l) => l.status === 'ok' && l.hashed === 't') && JSON.stringify(links.map((l) => `${l.google_calendar} ${l.event_id}`).sort()) === JSON.stringify(inGoogle),
      { links: links.length, google: inGoogle.length });
    check('calendar copied: nothing on the family account\'s main calendar (read only), and Test\'s events are gone', !G.writes().some((r) => r.calendar === CAL.main)
      && [CAL.taylor, CAL.jordan, CAL.family].every((c) => !G.events(c).some((e) => /^hhtest/.test(e.id))));
    check('calendar copied: every event the hub sent has its own id, no attendees, reminders or colour, and sendUpdates=none',
      G.writes().filter((r) => r.method === 'POST' && /^hh[0-9a-f]{32}$/.test(r.body.id)).every((r) => r.query.sendUpdates === 'none' && !('attendees' in r.body)
        && !('reminders' in r.body) && !('colorId' in r.body) && r.body.status === 'confirmed' && props(r.body).homehub === '1' && props(r.body).homehub_base === r.body.id));

    const tp = findEv(CAL.taylor, ids.Piano, TODAY);
    check('calendar copied: Taylor\'s Piano today: "Piano (con Jordan)", 4–5pm New York as instants, its place, the first line in Spanish and no link (a helper\'s calendar)',
      !!tp && tp.summary === 'Piano (con Jordan)' && tp.location === 'Music school' && Date.parse(tp.start.dateTime) === Date.parse('2026-10-27T20:00:00Z')
      && Date.parse(tp.end.dateTime) === Date.parse('2026-10-27T21:00:00Z') && tp.start.timeZone === 'America/New_York' && /^Hecho por Home Hub/.test(tp.description)
      && !/http|Home Hub:/.test(tp.description.split('\n').slice(1).join(' ')) && !/https?:/.test(tp.description) && tp.transparency === 'opaque', tp);
    const tp2 = findEv(CAL.taylor, ids.Piano, '2026-11-03');
    check('calendar copied: after the clocks go back, Piano on Nov 3 is still 4pm (21:00Z)', !!tp2 && Date.parse(tp2.start.dateTime) === Date.parse('2026-11-03T21:00:00Z'), tp2 && tp2.start);
    const jp = findEv(CAL.jordan, ids.Piano, TODAY);
    check('calendar copied: Jordan\'s copy of Piano names who\'s in charge, in English, with no link (a kid\'s calendar)',
      !!jp && jp.summary === 'Piano (Taylor)' && /^Made by Home Hub: changes made here are undone\. Change it in Home Hub\./.test(jp.description) && !/https?:/.test(jp.description), jp);
    const pill = findEv(CAL.taylor, ids['Heartworm pill'], TODAY);
    check('calendar copied: Taylor\'s pet task: "☐ Mascotas: Heartworm pill", all day today (end is the next day), not busy',
      !!pill && pill.summary === '☐ Mascotas: Heartworm pill' && pill.start.date === TODAY && pill.end.date === '2026-10-28' && pill.transparency === 'transparent', pill);
    const late = hubEvents(CAL.taylor).find((e) => props(e).homehub_kind === 'late');
    check('calendar copied: Taylor\'s late task is one all-day line on today', !!late && late.start.date === TODAY && /Return library books/.test(late.summary) && !props(late).homehub_item, late);
    const card = findEv(CAL.family, ids['Buy birthday card'], TODAY);
    check('calendar copied: the task nobody is on goes on Family, with the link to that day in the hub',
      !!card && card.summary === '☐ Buy birthday card' && card.description.includes('Open in Home Hub: https://family.example/hub/#/calendar/2026-10-27'), card);
    const jobs = hubEvents(CAL.family).filter((e) => props(e).homehub_kind === 'project');
    const keys = jobs.map((e) => `${props(e).homehub_job}|${props(e).homehub_part || ''}`);
    check('calendar copied: the kitchen project\'s jobs are all-day events on Family ("Kitchen Renovation: …"), one per job (or its start and finish), keyed by the job',
      jobs.length > 0 && jobs.every((e) => props(e).homehub_item === ids.kitchen && !!props(e).homehub_job && /^Kitchen Renovation: /.test(e.summary) && !!e.start.date)
        && new Set(keys).size === keys.length && jobs.every((e) => !props(e).homehub_part || / (starts|finishes)$/.test(e.summary)), jobs.map((e) => [e.summary, e.start.date, props(e).homehub_job, props(e).homehub_part]));
    const ortho = findEv(CAL.jordan, ids.Orthodontist);
    const hairEv = findEv(CAL.jordan, ids.Haircut);
    check('calendar copied: private items are "Private item", visibility private, with no place and only the first line of the description',
      !!ortho && !!hairEv && [ortho, hairEv].every((e) => e.summary === 'Private item' && e.visibility === 'private' && !e.location && !e.description.includes('\n')), [ortho, hairEv]);
    check('calendar copied: nothing for people without a calendar (Sam\'s car, Alex\'s plants)',
      ![CAL.taylor, CAL.jordan, CAL.family].some((c) => hubEvents(c).some((e) => /Take the car in|Water the plants/.test(e.summary))));
    const all = [CAL.taylor, CAL.jordan, CAL.family].flatMap((c) => hubEvents(c));
    check('calendar copied: no description has a phone number, an email, a My day or confirmation link, or notes',
      all.every((e) => !/@|day\.html|[?&](t|c)=|555-01(02|03|04|05|06)/.test(e.description)), all.map((e) => e.description).filter((d) => /@|day\.html/.test(d)));

    const n = G.requests.length;
    const again = await h.runCalendar();
    check('calendar copied: a second run writes nothing (nothing to read yet, nothing changed)', again.status === 200 && again.body.ok === true && again.body.inserted === 0
      && again.body.updated === 0 && again.body.deleted === 0 && again.body.read === 0 && !G.writes(n).length, again.body);
  });

  // ===================================================================
  // One edit on the Calendar page is one update in Google
  // ===================================================================
  await flow('calendar edit', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/calendar/event/${ids['Soccer practice']}/2026-10-29`, label: 'calendar-edit' });
    await page.waitForSelector('#detail [data-ev="edit"]', { timeout: 5000 });
    await page.click('#detail [data-ev="edit"]');
    await page.waitForSelector('#formDialog .cal-form');
    await page.fill('#formDialog .cal-form [name="title"]', 'Soccer training');
    await page.click('#formDialog [type="submit"]');
    await settle(page, 500);
    check('calendar edit: the title is saved', (await one(`select title from events where id = '${ids['Soccer practice']}'`)).title === 'Soccer training');
    const n = G.requests.length;
    const r = await h.runCalendar();
    const w = G.writes(n);
    check('calendar edit: the next run makes one update in Google (a PUT of that event on Jordan\'s calendar), and nothing else',
      r.status === 200 && r.body.updated === 1 && r.body.inserted === 0 && r.body.deleted === 0 && w.length === 1 && w[0].method === 'PUT' && w[0].calendar === CAL.jordan
        && w[0].body.summary === 'Soccer training' && findEv(CAL.jordan, ids['Soccer practice']).summary === 'Soccer training', { body: r.body, w });
    // Deleting an event in the hub takes it off Google.
    const hair = findEv(CAL.jordan, ids.Haircut);
    await h.go(page, `#/calendar/event/${ids.Haircut}/2026-11-02`);
    await page.waitForSelector('#detail [data-ev="delete"]', { timeout: 5000 });
    await page.click('#detail [data-ev="delete"]');
    await settle(page, 500);
    const n2 = G.requests.length;
    const r2 = await h.runCalendar();
    const w2 = G.writes(n2);
    check('calendar edit: an event deleted in the hub is one DELETE in Google, and its link row goes', !(await one(`select id from events where id = '${ids.Haircut}'`))
      && r2.body.deleted === 1 && r2.body.inserted === 0 && r2.body.updated === 0 && w2.length === 1 && w2[0].method === 'DELETE' && w2[0].event === hair.id && w2[0].status === 204
      && !findEv(CAL.jordan, ids.Haircut) && !(await one(`select base_id from calendar_links where item_id = '${ids.Haircut}'`)), { body: r2.body, w2 });
    const f = await failures();
    check('calendar edit: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Events typed into Google: on the Calendar page, in day_text, in the email and on My day, each
  // only for the people whose calendar they are on
  // ===================================================================
  await flow('google typed in', async () => {
    G.typeIn(CAL.jordan, { summary: 'Dentist checkup', location: 'Elm Dental', start: { dateTime: '2026-10-27T21:30:00Z' }, end: { dateTime: '2026-10-27T22:00:00Z' } });
    G.typeIn(CAL.taylor, { summary: 'Recoger a Jordan', start: { dateTime: '2026-10-27T22:00:00Z' }, end: { dateTime: '2026-10-27T22:15:00Z' } });
    // An invitation nobody accepted, and a private event, on Taylor's calendar.
    G.typeIn(CAL.taylor, { summary: 'Party invite', organizer: { self: false }, attendees: [{ self: true, responseStatus: 'needsAction' }], start: { date: TODAY }, end: { date: '2026-10-28' } });
    G.typeIn(CAL.taylor, { summary: 'Doctor', visibility: 'private', location: 'Clinic', start: { date: TODAY }, end: { date: '2026-10-28' } });
    // Reads are 15 minutes apart, and the hub's clock doesn't move by itself: move it.
    await later(15);
    await h.mark();
    const r = await h.runCalendar();
    check('google typed in: the next run reads the four calendars; nothing of the hub\'s looks changed (the content hash of a read matches the write\'s)',
      r.status === 200 && r.body.read === 4 && r.body.repaired === 0 && r.body.adopted === 0 && r.body.inserted === 0 && r.body.updated === 0 && r.body.deleted === 0, r.body);
    const ge = await sql('select title, private, location from google_events order by title');
    check('google typed in: the cache has the three events the calendars made (the invitation is left out; the private one has no title or place)',
      JSON.stringify(ge.map((e) => [e.title, e.private, e.location])) === JSON.stringify([['', 't', null], ['Dentist checkup', 'f', 'Elm Dental'], ['Recoger a Jordan', 'f', null]]), ge);

    // The Calendar page (Alex, on a phone: the week).
    const { page, context } = await open({ email: 'alex@example.com', phone: true, path: '/#/calendar', label: 'google-calendar' });
    await until(async () => (await page.$$('.irow.k-google')).length > 0);
    const rows = await page.$$eval(`[data-list="${TODAY}"] .irow.k-google`, (rs) => rs.map((x) => [x.querySelector('.irow-title').firstChild.textContent.trim(), !!x.querySelector('.irow-check')]));
    check('google typed in: the Calendar page shows them on today, read only (no box), the private one as "Private item"', JSON.stringify(rows.map((x) => x[0]).sort())
      === JSON.stringify(['Dentist checkup', 'Private item', 'Recoger a Jordan']) && rows.every((x) => !x[1]), rows);
    await shot(page, 'calendar-google');
    await context.close();

    // Today (Sam, a member): the one-time notice, and the dentist in Jordan's day, read only.
    const t = await open({ email: 'sam@example.com', path: '/', label: 'google-today' });
    await t.page.click(`.today-chips .pchip[data-person="${P.jordan.id}"]`);
    await settle(t.page, 300);
    const jRows = await t.page.$$eval('[data-list="day"] .irow.k-google', (rs) => rs.map((x) => [x.querySelector('.irow-title').firstChild.textContent.trim(), !!x.querySelector('.irow-check')]));
    check('google typed in: Today shows members the one-time notice, and the dentist in Jordan\'s day with no box',
      /now copies the calendar to Google and the kitchen wall/.test(await tc(t.page, '.today-gnotice')) && JSON.stringify(jRows) === JSON.stringify([['Dentist checkup', false]]), jRows);
    await t.context.close();

    const jText = (await one(`select public.day_text('${P.jordan.id}', '${TODAY}') as t`)).t;
    const tText = (await one(`select public.day_text('${P.taylor.id}', '${TODAY}') as t`)).t;
    check('google typed in: Jordan\'s day_text has the dentist from his calendar; Taylor\'s doesn\'t', /Dentist checkup/.test(jText) && !/Dentist checkup/.test(tText) && /Recoger a Jordan/.test(tText), { jText, tText });
    const pv = await h.hubJobsAs('alex@example.com', { action: 'preview', person_id: P.alex.id });
    const mail = pv.body && pv.body.emails && pv.body.emails[0];
    check('google typed in: Alex\'s email preview has the dentist in Jordan\'s block', pv.status === 200 && !!mail && /Jordan · [\s\S]*Dentist checkup/.test(mail.text), mail && mail.text.slice(0, 800));
    const day = async (who) => h.api('/rest/v1/rpc/get_person_day', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_token: P[who].day_token }) });
    const td = await day('taylor');
    const jd = await day('jordan');
    const tds = JSON.stringify(td.body);
    check('google typed in: Taylor\'s My day has the event on her calendar, not Jordan\'s dentist, nor the invitation', td.status === 200 && /Recoger a Jordan/.test(tds)
      && !/Dentist checkup|Party invite/.test(tds), tds.slice(0, 600));
    check('google typed in: Jordan\'s My day has his dentist, with no box', jd.status === 200 && /Dentist checkup/.test(JSON.stringify(jd.body)), JSON.stringify(jd.body).slice(0, 600));
    const my = await open({ path: `/day.html?t=${P.taylor.day_token}`, label: 'google-my-day' });
    await until(async () => /Recoger a Jordan/.test(await tc(my.page, 'body')));
    const body = await tc(my.page, 'body');
    check('google typed in: Taylor\'s My day page shows it, and not the others', /Recoger a Jordan/.test(body) && !/Dentist checkup|Party invite/.test(body), body.slice(0, 400));
    await my.context.close();
    const f = await failures();
    check('google typed in: no API request failed', !f.length, f);
  });

  // ===================================================================
  // Changed or deleted in Google: put back by the next run, and listed in Settings and the email
  // ===================================================================
  await flow('google put back', async () => {
    const gone = findEv(CAL.jordan, ids.Piano, '2026-11-03');
    const soccer = findEv(CAL.jordan, ids['Soccer practice']);
    const colour = findEv(CAL.jordan, ids.Piano, '2026-11-10');
    G.remove(CAL.jordan, gone.id);
    G.edit(CAL.jordan, soccer.id, { summary: 'Soccer (moved)' });
    G.edit(CAL.jordan, colour.id, { colorId: '5' });   // a colour only: not a change the hub puts back
    await later(15);
    await h.mark();
    const n = G.requests.length;
    const r = await h.runCalendar();
    const w = G.writes(n);
    check('google put back: the next run finds the deleted and the edited event, and puts both back (two PUTs); the colour stays',
      r.status === 200 && r.body.repaired === 2 && r.body.updated === 2 && w.length === 2 && w.every((x) => x.method === 'PUT' && x.calendar === CAL.jordan)
        && JSON.stringify(w.map((x) => x.event).sort()) === JSON.stringify([gone.id, soccer.id].sort()), { body: r.body, w: w.map((x) => [x.method, x.event]) });
    const back = G.all(CAL.jordan).find((e) => e.id === gone.id);
    check('google put back: the deleted one is back (status confirmed, same id), and the edited one has the hub\'s title again',
      back.status === 'confirmed' && back.summary === 'Piano (Taylor)' && findEv(CAL.jordan, ids['Soccer practice']).summary === 'Soccer training', back);
    const rep = await sql("select title, repair_kind, repairs from calendar_links where repaired_at is not null order by title");
    check('google put back: calendar_links records the two repairs', JSON.stringify(rep.map((x) => [x.title, x.repair_kind, x.repairs]))
      === JSON.stringify([['Piano (Taylor)', 'deleted', '1'], ['Soccer training', 'edited', '1']]), rep);
    const again = await h.runCalendar();
    check('google put back: the run after that writes nothing', again.status === 200 && again.body.inserted === 0 && again.body.updated === 0 && again.body.deleted === 0, again.body);

    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'google-put-back' });
    await page.waitForSelector('[data-ref="grepairs"]', { timeout: 10000 });
    const listed = await texts(page, '[data-ref="grepairs"] li');
    check('google put back: Settings lists them under "Changed in Google and put back"', listed.length === 2
      && listed.some((x) => /^Piano \(Taylor\), Tue Nov 3, Jordan's calendar: deleted in Google, put back /.test(x))
      && listed.some((x) => /^Soccer training, Thu Oct 29, Jordan's calendar: changed in Google, put back /.test(x)), listed);
    check('google put back: no problems listed', !(await page.$('[data-ref="gproblems"]')));
    await context.close();
    const pv = await h.hubJobsAs('alex@example.com', { action: 'preview', person_id: P.alex.id });
    const mail = pv.body && pv.body.emails && pv.body.emails[0];
    check('google put back: Alex\'s next email says what was put back', !!mail && /deleted in Google and put back/.test(mail.text), mail && mail.text.slice(0, 800));
    const f = await failures();
    check('google put back: no API request failed', !f.length, f);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  jobs stopped: ${e && e.stack}`); process.exit(1); });
