// The morning email against the REAL database (tests/realdb/run.sh): the real hub-jobs handler
// (supabase/functions/hub-jobs/handler.ts) runs as the Edge Function would, as service_role on this
// database (digest_due, claim_notification, digest_for, finish_notification, roll_missed_tasks,
// people_confirm), with only Resend faked; the Settings page asks it for status and a preview.
// Then Google Calendar (docs/v1.1-google-calendar.md, migration 0003), against the fake Google in
// lib.js: an admin sets calendars in Settings, Tests them, approves what they copy and presses Sync
// now; what Google then holds; a second run that writes nothing; an edit in the hub that is one
// update; events typed into Google that reach the Calendar page, day_text, the email and My day;
// and events changed or deleted in Google that are put back, and listed in Settings.
// Then v1.2 (docs/v1.2-kitchen.md, migration 0004): a dinner set on Food on the wall, in the email,
// locked, and kept once its day is history; and, on a second copy of the database as it is live
// (schema 3), 0004 applied after hub-jobs has run there. Then 0010 (docs/v1.1-google-calendar.md §11): the wall's own
// calendar sorted by Hearth person, end to end: added and switched on in Settings, Sync now, the tags stored and listed,
// matched, and each event where its tags send it (My day, busy time, the email, Today).
// Same household as flows.test.js; its own copy of the database. The clock starts on Tue Oct 27 at
// 09:00 in New York, inside the 6:30 morning email's 3-hour window.
const { setup } = require('./lib');

const TODAY = '2026-10-27';
const SA = 'home-hub-sync@home-hub-example.iam.gserviceaccount.com';   // lib.js's service account
const GID = (s) => `${s}@group.calendar.google.com`;
const CAL = { taylor: GID('taylor0123'), jordan: GID('jordan0123'), family: GID('family0123'), main: 'family@example.com' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

  // ===================================================================
  // v1.2 (migration 0004): tonight's dinner, set on Food, on the wall as one all-day event on Hub –
  // Family; locked, "Dinner: Private item"; in the email; and still there once its day is history
  // (docs/v1.2-kitchen.md §9, §10)
  // ===================================================================
  await flow('dinner on the wall', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/food/${TODAY}`, label: 'wall-dinner' });
    const dinner = async (fill) => {
      await page.waitForSelector('#formDialog .food-dinner', { timeout: 10000 });
      await fill();
      await page.click('#formDialog [type="submit"]');
      await until(async () => !(await page.evaluate(() => document.getElementById('formDialog').open)));
    };
    await dinner(async () => {
      await page.fill('#formDialog input[name="title"]', 'Tacos');
      await page.click(`#formDialog [data-ref="cooks"] .pchip[data-person="${P.sam.id}"]`);
      await page.click('#formDialog .food-more summary');
      await page.fill('#formDialog textarea[name="note"]', 'Chicken is in the freezer');
      await page.fill('#formDialog input[name="link"]', 'https://cooking.example.com/tacos');
    });
    const meal = await one(`select id, title, cook_id, private from meals where day = '${TODAY}' and slot = 'dinner'`);
    check('dinner on the wall: tonight\'s Tacos, Sam cooking, saved from Food', !!meal && meal.title === 'Tacos' && meal.cook_id === P.sam.id && meal.private === 'f', meal);
    const n = G.requests.length;
    const r = await h.runCalendar();
    const w = G.writes(n);
    const ev = findEv(CAL.family, meal.id, TODAY);
    check('dinner on the wall: the next run is one insert, on Hub – Family: "Dinner: Tacos (Sam)", all day (to the next day), not busy, visibility default',
      r.status === 200 && r.body.inserted === 1 && r.body.updated === 0 && r.body.deleted === 0 && w.length === 1 && w[0].method === 'POST' && w[0].calendar === CAL.family
      && !!ev && ev.summary === 'Dinner: Tacos (Sam)' && ev.start.date === TODAY && ev.end.date === '2026-10-28' && ev.transparency === 'transparent' && ev.visibility === 'default'
      && props(ev).homehub_kind === 'meal' && props(ev).homehub_occurrence === TODAY && /^hh[0-9a-f]{32}$/.test(ev.id), { body: r.body, w: w.map((x) => [x.method, x.calendar]), ev });
    check('dinner on the wall: its description: made by Home Hub, "Sam cooks", the link to Food; never the note or the recipe link',
      !!ev && /^Made by Home Hub/.test(ev.description) && ev.description.split('\n').includes('Sam cooks') && ev.description.includes('https://family.example/hub/#/food')
      && !/freezer|cooking\.example/.test(ev.description), ev && ev.description);
    check('dinner on the wall: on nobody else\'s calendar, and calendar_links keeps it as a \'meal\'', !findEv(CAL.taylor, meal.id) && !findEv(CAL.jordan, meal.id)
      && same(await sql(`select item_kind, occurrence, status from calendar_links where item_id = '${meal.id}'`), [{ item_kind: 'meal', occurrence: TODAY, status: 'ok' }]));

    // The email preview: the dinner ends Today; on Sam's quiet day it is the subject.
    const preview = async (who, date) => {
      const pv = await h.hubJobsAs('alex@example.com', Object.assign({ action: 'preview', person_id: P[who].id }, date ? { date } : {}));
      return pv.status === 200 && pv.body.emails ? pv.body.emails[0] : { error: pv.body };
    };
    // The text part: the heading (and a parent's Google Calendar lines), a blank line, then Today's rows.
    const lastTodayLine = (mail) => ((mail.text || '').split('\n\n')[1] || '').split('\n').slice(-1)[0];
    let alexMail = await preview('alex');
    let samMail = await preview('sam', TODAY);
    let taylorMail = await preview('taylor');
    check('dinner on the wall: Alex\'s email preview ends Today with "Dinner  Tacos · Sam cooks"', lastTodayLine(alexMail) === 'Dinner  Tacos · Sam cooks', alexMail.text || alexMail);
    check('dinner on the wall: Sam\'s (he cooks, nothing else today): the subject is the dinner, and his row has the note',
      samMail.subject === 'Tue Oct 27: Dinner: Tacos · You cook' && lastTodayLine(samMail) === 'Dinner  Tacos · You cook · Chicken is in the freezer' && samMail.would_send === true,
      [samMail.subject, samMail.text, samMail.would_send]);
    check('dinner on the wall: Taylor\'s, in Spanish: "Cena  Tacos · Cocina Sam" at the end of Hoy', lastTodayLine(taylorMail) === 'Cena  Tacos · Cocina Sam', taylorMail.text || taylorMail);

    // Locked on Food: one update, and the email subject and the helper's row say "Private item".
    await h.go(page, `#/food/${TODAY}`);
    await dinner(async () => { await page.check('#formDialog input[name="private"]'); });
    const n2 = G.requests.length;
    const r2 = await h.runCalendar();
    const w2 = G.writes(n2);
    const ev2 = findEv(CAL.family, meal.id, TODAY);
    check('dinner on the wall: locked on Food, the next run is one update of the same event: "Dinner: Private item", visibility private, no name, no "Sam cooks"',
      r2.status === 200 && r2.body.updated === 1 && r2.body.inserted === 0 && r2.body.deleted === 0 && w2.length === 1 && w2[0].method === 'PUT' && w2[0].event === ev.id
      && !!ev2 && ev2.summary === 'Dinner: Private item' && ev2.visibility === 'private' && !/Sam/.test(`${ev2.summary}\n${ev2.description}`), { body: r2.body, ev2 });
    alexMail = await preview('alex');
    samMail = await preview('sam', TODAY);
    taylorMail = await preview('taylor');
    check('dinner on the wall: locked, the email subject says "Dinner: Private item" even for the cook; Alex (a parent) and Sam still see the title in the row',
      samMail.subject === 'Tue Oct 27: Dinner: Private item' && lastTodayLine(samMail) === 'Dinner  Tacos · You cook · Chicken is in the freezer'
      && lastTodayLine(alexMail) === 'Dinner  Tacos · Sam cooks', [samMail.subject, lastTodayLine(samMail), lastTodayLine(alexMail)]);
    check('dinner on the wall: ... and Taylor (a helper, not on it) gets "Cena  Asunto privado · Cocina Sam"', lastTodayLine(taylorMail) === 'Cena  Asunto privado · Cocina Sam', taylorMail.text);

    // Unlocked again (one update back), then three days on: its day is before the window (from
    // yesterday), and the dinner stays on Google as history.
    await h.go(page, `#/food/${TODAY}`);
    await dinner(async () => { await page.uncheck('#formDialog input[name="private"]'); });
    const n3 = G.requests.length;
    const r3 = await h.runCalendar();
    check('dinner on the wall: unlocked, one update back to "Dinner: Tacos (Sam)"', r3.body.updated === 1 && G.writes(n3).length === 1
      && findEv(CAL.family, meal.id, TODAY).summary === 'Dinner: Tacos (Sam)', r3.body);
    await context.close();
    await h.setClock('2026-10-30T14:00:00Z');   // Fri Oct 30, 10am in New York: the window starts Thu Oct 29
    const n4 = G.requests.length;
    for (let i = 0; i < 10; i++) {
      const ri = await h.runCalendar();
      if (ri.status !== 200 || !((await lastRun()).pending > 0)) break;
    }
    const gone = G.writes(n4).filter((x) => x.event === ev.id);
    check('dinner on the wall: three days later the runs leave it alone: still on Hub – Family, its link kept',
      !gone.length && !!findEv(CAL.family, meal.id, TODAY) && !!(await one(`select 1 as kept from calendar_links where item_id = '${meal.id}'`)), { gone, run: await lastRun() });
    const f = await failures();
    check('dinner on the wall: no API request failed', !f.length, f);
  });

  // ===================================================================
  // 0010 (docs/v1.1-google-calendar.md §11): the wall's own calendar, sorted by Hearth person. Fri Oct 30 (the clock as
  // the dinner left it). Hearth Calendar, shared with See event details, has Jordan's piano lesson (jordan, and a real
  // address that must never be kept), a Family visit (familyanddogs), the vet (dogs and taylor), a movie with no Hearth
  // guest, a private event for Jordan (Google hides its guests from a reader) and tomorrow's tea (grandma). Alex adds it
  // under Calendars to read as Family, turns Sort by Hearth person on and presses Sync now: the tags are stored and
  // listed, each New, and everything is the grown-ups'. He matches jordan, taylor, familyanddogs and dogs (grandma stays
  // New): at once, with no new read, Jordan's lesson is on his My day and is busy time in his homework week, the visit
  // reaches him too, Taylor's My day has only the vet, and the movie and the private event stay with the grown-ups.
  // ===================================================================
  await flow('hearth sorted', async () => {
    const HEARTH = GID('hearth0000');
    const DAY = '2026-10-30';
    const TAG = (n) => `${n}@team-example-0000`;
    G.add(HEARTH, { summary: 'Hearth Calendar', role: 'reader' });
    const at = (hm) => new Date(`${DAY}T${hm}:00-04:00`).toISOString();   // New York is on daylight time until Nov 1
    const wall = (summary, from, to, guests, extra) => G.typeIn(HEARTH, Object.assign({ summary, start: { dateTime: at(from) }, end: { dateTime: at(to) },
      attendees: guests.map((g) => ({ email: g, responseStatus: 'accepted' })) }, extra));
    wall('Piano', '16:30', '17:15', [TAG('jordan'), 'morgan@example.com']);
    wall('Visit', '16:00', '16:30', [TAG('familyanddogs')]);
    wall('Vet', '13:00', '13:30', [TAG('dogs'), TAG('taylor')]);
    wall('Movie night', '19:00', '21:00', []);
    wall('Doctor', '12:00', '12:30', [TAG('jordan')], { visibility: 'private', location: 'Clinic' });
    G.typeIn(HEARTH, { summary: 'Tea', start: { date: '2026-10-31' }, end: { date: '2026-11-01' }, attendees: [{ email: TAG('grandma'), responseStatus: 'accepted' }] });
    await h.mark();
    const n0 = G.requests.length;

    // Settings: Add a calendar to read (Whose: Family), its Test, then the switch.
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'hearth-settings' });
    await page.waitForSelector('[data-act="gadd"]', { timeout: 10000 });
    await page.click('[data-act="gadd"]');
    await page.waitForSelector('#formDialog input[name="google_id"]');
    await page.fill('#formDialog input[name="google_id"]', HEARTH);
    await page.fill('#formDialog input[name="label"]', 'Hearth');
    await page.click('#formDialog [type="submit"]');
    await page.waitForSelector('#formDialog [data-ref="test"] .set-gtest', { timeout: 20000 });
    check('hearth: added as Family, its Test reads it', (await tc(page, '#formDialog [data-ref="test"] .set-gtest p')) === 'Test: Home Hub can read this calendar.', await tc(page, '#formDialog'));
    await page.click('#formDialog .form-actions [data-close]');
    await settle(page, 300);
    const cal = await one(`select id, kind, writes, for_kids, sort_by_guest from calendars where google_id = '${HEARTH}'`);
    check('hearth: one calendars row, read only, Family, not sorted yet', !!cal && cal.kind === 'family' && cal.writes === 'f' && cal.sort_by_guest === 'f', cal);
    const box = `[data-gsort="${cal.id}"]`;
    await page.waitForSelector(box);
    await page.click(box);
    await until(async () => /Sorting by Hearth person/.test(await h.lastToast(page)));
    const sorted = await one(`select sort_by_guest, for_kids, read_at from calendars where id = '${cal.id}'`);
    check('hearth: the switch saves sort_by_guest (an admin\'s update through the column grant); "Not read yet" under the row',
      sorted.sort_by_guest === 't' && sorted.for_kids === 'f' && sorted.read_at === null
      && /^Not read yet\. Press Sync now/.test(await tc(page, `[data-hearth="${cal.id}"] .set-help`)), { sorted, line: await tc(page, `[data-hearth="${cal.id}"]`) });

    // Sync now: hub-jobs reads it with the guests' addresses, and keeps only the Hearth tags.
    await page.click('[data-act="gsync"]');
    await page.waitForSelector(`[data-hearth="${cal.id}"] .set-hp-row`, { timeout: 30000 });
    const names = await texts(page, `[data-hearth="${cal.id}"] .set-hp-name`);
    const fresh = await texts(page, `[data-hearth="${cal.id}"] .set-hp-new`);
    check('hearth: after Sync now Settings lists the Hearth people the read found, each New, and the line at the top names them',
      same(names, ['dogs', 'familyanddogs', 'grandma', 'jordan', 'taylor']) && fresh.length === 5
      && (await tc(page, '[data-ref="htodo"]')) === 'Hearth people to match: dogs, familyanddogs, grandma, jordan, taylor. See Calendars to read.', { names, todo: await tc(page, '[data-ref="htodo"]') });
    const tags = await sql(`select name, tag, matched_to from hearth_tags where calendar_id = '${cal.id}' order by name`);
    const ge = await sql(`select title, private, location, guests::text as guests from google_events where calendar_id = '${cal.id}' order by start_day, start_at`);
    check('hearth: the tags are stored (never the real address), and each cached event carries its own; the private one none, and no title or place',
      same(tags.map((t) => [t.name, t.matched_to]), [['dogs', null], ['familyanddogs', null], ['grandma', null], ['jordan', null], ['taylor', null]])
      && same(ge.map((e) => [e.title, e.private, e.location, e.guests]), [['', 't', null, '{}'], ['Vet', 'f', null, `{${TAG('dogs')},${TAG('taylor')}}`],
        ['Visit', 'f', null, `{${TAG('familyanddogs')}}`], ['Piano', 'f', null, `{${TAG('jordan')}}`], ['Movie night', 'f', null, '{}'], ['Tea', 'f', null, `{${TAG('grandma')}}`]])
      && !JSON.stringify(await sql('select * from google_events')).includes('morgan@example.com'), { ge: ge.map((e) => [e.title, e.private, e.location, e.guests]), tags: tags.map((t) => t.name) });
    const asked = G.requests.slice(n0).filter((r) => r.method === 'GET' && !r.event && r.query.fields && /items\(/.test(r.query.fields));
    check('hearth: Google was asked for guest addresses only on that calendar', asked.some((r) => r.calendar === HEARTH && /attendees\(email,self,responseStatus\)/.test(r.query.fields))
      && asked.filter((r) => r.calendar !== HEARTH).every((r) => !/email/.test(r.query.fields)) && asked.filter((r) => r.calendar !== HEARTH).length > 0,
      asked.map((r) => [r.calendar, /email/.test(r.query.fields)]));

    // Before any match: everything is the grown-ups'. A person's Google items on Oct 30: on their My day (get_person_day,
    // signed out with their link, as day.html asks), and in their morning email (digest_for's Today).
    const day = async (who) => {
      const r = await h.api('/rest/v1/rpc/get_person_day', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_token: P[who].day_token }) });
      return ((r.body && r.body.days) || []).filter((d) => d.day === DAY).flatMap((d) => d.items || []).filter((x) => x.kind === 'google').map((x) => x.title);
    };
    const mail = async (who) => JSON.parse((await one(`select (public.digest_for('${P[who].id}', '${DAY}') -> 'today')::text as t`)).t || '[]').filter((x) => x.kind === 'google')
      .map((x) => (x.title === 'Private item' ? `Private item ${x.time}` : x.title)).sort();
    const busy = async () => {
      const r = await rpcAs('alex@example.com', 'homework_week', { p_kid: P.jordan.id, p_from: DAY, p_days: 1 });
      return ((r.body || [])[0] || {}).busy || [];
    };
    await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
    await rpcAs('alex@example.com', 'add_homework_time', { p_kid: P.jordan.id, p_weekdays: [5], p_start: '16:00', p_end: '17:30' });
    const busyNew = (await busy()).map((b) => `${b.starts}-${b.ends}`);
    const alexNew = await mail('alex');
    const jordanNew = await day('jordan');
    check('hearth: before any match, every wall event is the grown-ups\' (all in Alex\'s email; none on Jordan\'s My day or in his busy time)',
      ['Piano', 'Visit', 'Vet', 'Movie night'].every((x) => alexNew.includes(x)) && !jordanNew.length && !busyNew.includes('16:30-17:15'), { busyNew, alexNew, jordanNew });

    // Alex matches four of them; grandma stays New.
    const pick = async (name, value) => {
      const id = (await one(`select id from hearth_tags where calendar_id = '${cal.id}' and name = '${name}'`)).id;
      await page.selectOption(`[data-hpick="${id}"]`, value);
      await until(async () => (await h.lastToast(page)).startsWith(`${name}: `));
      return h.lastToast(page);
    };
    const toasts = [await pick('jordan', `person:${P.jordan.id}`), await pick('taylor', `person:${P.taylor.id}`), await pick('familyanddogs', 'family'), await pick('dogs', 'grown_ups')];
    check('hearth: each match through set_hearth_tag, with its toast; the line at the top names only grandma now', same(toasts, ['jordan: Jordan\'s from now on.', 'taylor: Taylor\'s from now on.',
      'familyanddogs: Family\'s from now on.', 'dogs: the grown-ups\' from now on.']) && (await tc(page, '[data-ref="htodo"]')) === 'Hearth person to match: grandma. See Calendars to read.',
      { toasts, todo: await tc(page, '[data-ref="htodo"]') });
    const matched = await sql(`select name, matched_to, person_id, matched_by from hearth_tags where calendar_id = '${cal.id}' order by name`);
    check('hearth: the matches are stored, by Alex', same(matched.map((m) => [m.name, m.matched_to, m.person_id, m.matched_by]), [['dogs', 'grown_ups', null, 'alex@example.com'],
      ['familyanddogs', 'family', null, 'alex@example.com'], ['grandma', null, null, null], ['jordan', 'person', P.jordan.id, 'alex@example.com'], ['taylor', 'person', P.taylor.id, 'alex@example.com']]), matched);
    await shot(page, 'settings-hearth');
    await context.close();

    // At once, with no new read.
    const n1 = G.requests.length;
    const jd = await day('jordan');
    const td = await day('taylor');
    check('hearth: Jordan\'s My day now has the Family visit and his lesson; not the vet, the movie or the private one', same(jd, ['Visit', 'Piano']), jd);
    check('hearth: Taylor\'s My day has only her own (the vet), not the Family visit, Jordan\'s lesson or the movie', same(td, ['Vet']), td);
    const busyNow = (await busy()).map((b) => `${b.starts}-${b.ends}`);
    check('hearth: the lesson and the visit are Jordan\'s busy time in his homework week (16:00–16:30, 16:30–17:15); the movie, the vet and the private one aren\'t',
      busyNow.includes('16:30-17:15') && busyNow.includes('16:00-16:30') && !busyNow.includes('19:00-21:00') && !busyNow.includes('13:00-13:30') && !busyNow.includes('12:00-12:30'), busyNow);
    const alexMail = await mail('alex');
    const jordanText = (await one(`select public.day_text('${P.jordan.id}', '${DAY}') as t`)).t;
    check('hearth: Alex\'s email has the visit, the vet, the movie and the private one (untagged, as Google sends it: the grown-ups\'), not Jordan\'s lesson',
      same(alexMail.filter((x) => !/^Private item/.test(x)), ['Movie night', 'Vet', 'Visit']) && alexMail.filter((x) => /^Private item/.test(x)).length === 1, alexMail);
    check('hearth: Jordan\'s text has his lesson and the visit, not the movie, the vet or the private wall event (at noon)', /Piano/.test(jordanText) && /Visit/.test(jordanText)
      && !/Movie night|Vet|12:00/.test(jordanText), jordanText);
    check('hearth: none of it needed a new read', !G.requests.slice(n1).length, G.requests.slice(n1).map((r) => [r.method, r.calendar]));

    // Today (Sam, a member): Jordan's day and Taylor's, as their My day has them.
    const t = await open({ email: 'sam@example.com', path: '/', label: 'hearth-today' });
    const gday = () => t.page.$$eval('[data-list="day"] .irow.k-google', (rs) => rs.map((r) => r.querySelector('.irow-title').firstChild.textContent.trim()));
    await t.page.click(`.today-chips .pchip[data-person="${P.jordan.id}"]`);
    await settle(t.page, 300);
    const tj = (await gday()).filter((x) => ['Piano', 'Visit', 'Vet', 'Movie night', 'Private item'].includes(x));
    await t.page.click(`.today-chips .pchip[data-person="${P.taylor.id}"]`);
    await settle(t.page, 300);
    const tt = (await gday()).filter((x) => ['Piano', 'Visit', 'Vet', 'Movie night', 'Private item'].includes(x));
    check('hearth: Today shows Jordan\'s day with the visit and his lesson, Taylor\'s with the vet, as My day', same(tj, ['Visit', 'Piano']) && same(tt, ['Vet']), { tj, tt });
    await t.context.close();
    const f = await failures();
    check('hearth: no API request failed', !f.length, f);

    // Sam (a member) can't turn the switch off.
    const samTok = (await h.sessionFor('sam@example.com')).access_token;
    const samPatch = await h.api(`/rest/v1/calendars?id=eq.${cal.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${samTok}`,
      prefer: 'return=representation' }, body: JSON.stringify({ sort_by_guest: false }) });
    check('hearth: Sam\'s sort_by_guest update changes nothing', (samPatch.status >= 400 || (Array.isArray(samPatch.body) && !samPatch.body.length))
      && (await one(`select sort_by_guest from calendars where id = '${cal.id}'`)).sort_by_guest === 't', samPatch);
  });

  await h.finish();

  // ===================================================================
  // Migration 0004 on a hub that is running (docs/v1.2-kitchen.md §15 step 3, §16.2): its own copy
  // of the database as it is live, on schema 3, with Hub – Family copying; the calendar job and the
  // email have run in the API's session; then the owner pastes 0004 in a session of its own. The
  // next calendar run and the next email go through the wrappers (renaming a function drops the plans
  // cached for it), the wall stays exactly as it was, and a dinner saved afterwards reaches it.
  // ===================================================================
  const h3 = await setup('jobs3', { v3: true });
  {
    const { check, flow, sql } = h3;
    const one = async (q) => (await sql(q))[0] || null;
    const G3 = h3.google;
    const P3 = {};
    for (const r of await sql('select id, name from people')) P3[r.name.split(' ')[0].toLowerCase()] = r.id;
    const alexToken = (await h3.sessionFor('alex@example.com')).access_token;
    const asAlex = (p, method, body, prefer) => h3.api(p, { method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alexToken}`, prefer: prefer || 'return=representation' }, body: JSON.stringify(body) });
    const failures = async () => (await h3.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || r.error.error || ''}` : ''}`);
    const lastRun = async () => JSON.parse((await one('select last_result::text as r from calendar_sync')).r || '{}');
    const wall = () => G3.all(CAL.family).map((e) => [e.id, e.etag, e.status]);

    await flow('0004 on a running hub', async () => {
      await h3.mark();
      check('0004 on a running hub: the database is on schema 3 (0002 and 0003, no 0004)', (await one('select public.hub_schema_version() as v')).v === '3'
        && !(await one("select to_regclass('public.meals') as t")).t);
      // Hub – Family, set up as Settings does it: saved, Tested, Start copying.
      G3.add(CAL.family, { summary: 'Hub – Family' });
      const made = await asAlex('/rest/v1/calendars', 'POST', { google_id: CAL.family, kind: 'family', label: 'Family' });
      const calId = made.body && made.body[0] && made.body[0].id;
      const test = await h3.hubJobsAs('alex@example.com', { action: 'calendar_test', calendar_id: calId });
      const approve = await asAlex(`/rest/v1/calendars?id=eq.${calId}`, 'PATCH', { copy_approved_at: await h3.clockNow() });
      await sql(`insert into tasks (title, due_date) values ('Buy birthday card', '${TODAY}'), ('Book the plumber', '2026-10-29')`);
      for (let i = 0; i < 10; i++) {
        const r = await h3.runCalendar();
        if (r.status !== 200 || !((await lastRun()).pending > 0)) break;
      }
      check('0004 on a running hub: on schema 3, Hub – Family is set up and the calendar job copies to it (the tasks nobody is on)',
        made.status === 201 && test.status === 200 && approve.status === 200 && ['☐ Buy birthday card', '☐ Book the plumber'].every((t) => G3.events(CAL.family).some((e) => e.summary === t)),
        { made: made.status, test: test.body, approve: approve.status, events: G3.events(CAL.family).map((e) => e.summary) });
      const pv1 = await h3.hubJobsAs('alex@example.com', { action: 'preview', person_id: P3.alex });
      check('0004 on a running hub: ... and the email preview works on schema 3 (digest_for has run in the API\'s session)', pv1.status === 200 && pv1.body.emails.length === 1, pv1.body);
      const before = wall();

      // The owner pastes 0004.
      const m = await h3.migrate('supabase/migrations/0004_meals_and_shopping.sql');
      const v = await one('select public.hub_schema_version() as v');
      check('0004 on a running hub: the migration applies in one go, in its own session, and the schema version is 4', !m.error && v.v === '4', m.error || v);

      // The next run, a quarter of an hour on so it reads Hub – Family too: through the new calendar_desired.
      await h3.setClock(new Date(Date.parse(await h3.clockNow()) + 15 * 60000).toISOString());
      const n = G3.requests.length;
      const r = await h3.runCalendar();
      check('0004 on a running hub: the next calendar run reads Hub – Family and writes nothing: every event on the wall is as 0003 left it',
        r.status === 200 && r.body.ok === true && r.body.read === 1 && r.body.inserted === 0 && r.body.updated === 0 && r.body.deleted === 0 && r.body.repaired === 0
        && !G3.writes(n).length && same(wall(), before), r.body);

      // A dinner, saved as the Food page saves it (an upsert on day and slot): the next run puts it on the wall.
      const saved = await asAlex('/rest/v1/meals?on_conflict=day,slot&select=id', 'POST',
        { day: TODAY, slot: 'dinner', kind: 'cook', title: 'Tacos', cook_id: P3.sam, note: null, link: null, private: false }, 'resolution=merge-duplicates,return=representation');
      const n2 = G3.requests.length;
      const r2 = await h3.runCalendar();
      const w2 = G3.writes(n2);
      check('0004 on a running hub: a dinner saved afterwards is one insert in the next run, "Dinner: Tacos (Sam)" on Hub – Family',
        saved.status === 201 && r2.status === 200 && r2.body.inserted === 1 && w2.length === 1 && w2[0].method === 'POST' && w2[0].calendar === CAL.family
        && w2[0].body.summary === 'Dinner: Tacos (Sam)' && w2[0].body.extendedProperties.private.homehub_kind === 'meal', { saved: saved.status, body: r2.body, w2: w2.map((x) => x.body && x.body.summary) });
      const pv2 = await h3.hubJobsAs('alex@example.com', { action: 'preview', person_id: P3.alex });
      const mail = pv2.body && pv2.body.emails && pv2.body.emails[0];
      check('0004 on a running hub: and the next email (through the digest_for wrapper) ends Today with it', pv2.status === 200 && !!mail
        && /\nDinner {2}Tacos · Sam cooks\n/.test(mail.text), mail ? mail.text.slice(0, 400) : pv2.body);
      const d = await h3.runDigest();
      check('0004 on a running hub: the morning email run answers 200 ok', d.status === 200 && d.body.ok === true, d.body);
      const f = await failures();
      check('0004 on a running hub: no API request failed', !f.length, f);
    });
    await h3.finish();
  }
})().catch((e) => { console.log(`FAIL  jobs stopped: ${e && e.stack}`); process.exit(1); });
