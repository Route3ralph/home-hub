// The morning email against the REAL database (tests/realdb/run.sh): the real hub-jobs handler
// (supabase/functions/hub-jobs/handler.ts) runs as the Edge Function would, as service_role on this
// database (digest_due, claim_notification, digest_for, finish_notification, roll_missed_tasks,
// people_confirm), with only Resend faked; the Settings page asks it for status and a preview.
// Same household as flows.test.js; its own copy of the database. The clock starts on Tue Oct 27 at
// 09:00 in New York, inside the 6:30 morning email's 3-hour window.
const { setup } = require('./lib');

const TODAY = '2026-10-27';

(async () => {
  const h = await setup('jobs');
  const { check, flow, sql, open, settle, tc, until } = h;
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

  await h.finish();
})().catch((e) => { console.log(`FAIL  jobs stopped: ${e && e.stack}`); process.exit(1); });
