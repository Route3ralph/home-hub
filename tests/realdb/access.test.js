// What the API gives someone signed out (anon) and someone signed in who isn't on the family list,
// through the PostgREST stand-in on the real database: every public table and every public function.
// Signed out, only get_shared_project and the five My day token functions may answer; a stranger
// gets nothing from any table, and from the functions only the harmless HARMLESS ones. The Google
// Calendar tables and functions (migration 0003) are checked again with a row in each table: anon
// reaches none of them. Run through tests/realdb/run.sh.
const { setup } = require('./lib');

const TOKEN_FNS = ['get_person_day', 'complete_by_token', 'undo_by_token', 'confirm_digest', 'stop_digest', 'get_shared_project'];
// What any signed-in account may learn, by design: its own email, the household's date, clock and
// time zone, and the schema version (sign-up is limited to the family list by the auth hook).
const HARMLESS = ['current_email', 'clock', 'today_local', 'hub_schema_version'];

(async () => {
  const h = await setup('access', { hubJobs: false });
  const { check, flow, sql } = h;

  await flow('access', async () => {
    const tables = (await sql("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v', 'p') order by 1")).map((r) => r.relname);
    const fns = (await sql("select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' order by 1")).map((r) => r.proname);
    const stranger = (await h.sessionFor('casey@example.com').catch(() => null));
    // Casey isn't on the family list, so the signup hook refuses her: give her a login the way a removed
    // member would still have one (she was on the list once).
    let strangerToken = stranger && stranger.access_token;
    if (!strangerToken) {
      await sql("insert into members (email, name) values ('casey@example.com', 'Casey')");
      strangerToken = (await h.sessionFor('casey@example.com')).access_token;
      await sql("delete from members where email = 'casey@example.com'");
    }
    for (const [who, auth] of [['signed out', null], ['stranger', strangerToken]]) {
      const headers = auth ? { authorization: `Bearer ${auth}` } : {};
      const leaks = [];
      for (const t of tables) {
        const r = await h.api(`/rest/v1/${t}?select=*`, { headers });
        if (r.status === 200 && Array.isArray(r.body) && r.body.length) leaks.push(`${t}: ${r.body.length} rows`);
      }
      check(`access ${who}: no table gives any rows`, !leaks.length, leaks);
      const answered = [];
      for (const f of fns) {
        const r = await h.api(`/rest/v1/rpc/${f}`, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: '{}' });
        // 401/403 (no permission) or 404 (needs arguments it wasn't given) are fine; an answer isn't,
        // unless it's one of the public functions answering "nothing" for no token.
        const nothing = r.body === null || r.body === false || (Array.isArray(r.body) && !r.body.length) || r.status === 204;
        if (r.status < 300 && !nothing && !(auth && HARMLESS.includes(f))) answered.push(`${f} → ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
      }
      check(`access ${who}: no function answers with data`, !answered.length, answered);
    }
  });

  // Google Calendar (migration 0003): with a row in each of its four tables, anon is refused every one
  // of them and every new function, called with the arguments each takes (so the refusal is the
  // permission, not a missing argument); a stranger sees no rows and may run none of the job
  // functions; a member who isn't an admin can't read calendar_links or run a job function either.
  await flow('google calendar', async () => {
    const jordan = (await sql("select id from people where name like 'Jordan%'"))[0].id;
    const gcal = 'jordan0123@group.calendar.google.com';
    const base = `hh${'0'.repeat(31)}1`;
    await sql(`
      insert into calendars (id, google_id, kind, person_id, label, status, google_name, access_role)
      values ('d0000000-0000-4000-8000-000000000001', '${gcal}', 'person', '${jordan}', 'Jordan', 'ok', 'Hub – Jordan', 'writer');
      insert into calendar_links (google_calendar, base_id, event_id, calendar_id, item_kind, day, end_day, title, status, synced_at)
      values ('${gcal}', '${base}', '${base}', 'd0000000-0000-4000-8000-000000000001', 'event', '2026-10-27', '2026-10-27', 'Piano', 'ok', now());
      insert into google_events (calendar_id, google_calendar, event_id, title, all_day, start_day, end_day, read_at)
      values ('d0000000-0000-4000-8000-000000000001', '${gcal}', 'g0001', 'Dentist', true, '2026-10-27', '2026-10-27', now());`);
    const before = await sql('select running_since, run_id, auth, last_run_at from calendar_sync');
    const TABLES = ['calendars', 'calendar_links', 'google_events', 'calendar_sync'];
    const run = '00000000-0000-4000-8000-000000000009';
    const plan = { op: 'insert', calendar_id: 'd0000000-0000-4000-8000-000000000001', google_calendar: gcal, base_id: base, event_id: base, ok: true };
    const FNS = {
      google_items: { p_from: '2026-10-27', p_to: '2026-10-28' },
      calendar_preview: { p_calendar: 'd0000000-0000-4000-8000-000000000001' },
      calendar_begin: {},
      calendar_signed_in: { p_run: run, p_auth: 'service_account', p_account: 'someone@example.com', p_key_id: 'k' },
      calendar_read_due: { p_force: true, p_limit: 10 },
      calendar_store_events: { p_calendar: 'd0000000-0000-4000-8000-000000000001', p_google_id: gcal, p_from: '2026-10-26', p_to: '2026-12-26', p_name: 'Hub – Jordan',
        p_access: 'writer', p_complete: true, p_events: [], p_seen: [] },
      calendar_mark: { p_calendar: 'd0000000-0000-4000-8000-000000000001', p_google_id: gcal, p_status: 'no_access', p_detail: 'x' },
      calendar_plan: { p_site: null, p_limit: 60 },
      calendar_record: { p_results: [plan] },
      calendar_finish: { p_run: run, p_result: {}, p_stop: 'auth', p_error: 'x' },
    };
    const fnsNow = (await sql("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'calendar%' or p.proname = 'google_items') order by 1")).map((r) => r.proname);
    check('google calendar: the new public functions are the ones this test calls', JSON.stringify(fnsNow) === JSON.stringify(Object.keys(FNS).sort()), fnsNow);

    const member = (await h.sessionFor('sam@example.com')).access_token;
    let stranger = (await h.sessionFor('casey@example.com').catch(() => null));
    stranger = stranger && stranger.access_token;
    if (!stranger) {
      await sql("insert into members (email, name) values ('casey@example.com', 'Casey')");
      stranger = (await h.sessionFor('casey@example.com')).access_token;
      await sql("delete from members where email = 'casey@example.com'");
    }
    const ask = (p, auth, body) => h.api(p, body === undefined ? { headers: auth ? { authorization: `Bearer ${auth}` } : {} }
      : { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth ? { authorization: `Bearer ${auth}` } : {}), body: JSON.stringify(body) });
    const rows = (r) => (r.status === 200 && Array.isArray(r.body) ? r.body.length : null);

    // Signed out: refused (401), not an empty answer.
    const anonTables = [];
    for (const t of TABLES) anonTables.push([t, (await ask(`/rest/v1/${t}?select=*`, null)).status]);
    check('google calendar, signed out: every new table is refused (401)', anonTables.every(([, s]) => s === 401), anonTables);
    const anonFns = [];
    for (const [f, args] of Object.entries(FNS)) anonFns.push([f, (await ask(`/rest/v1/rpc/${f}`, null, args)).status]);
    check('google calendar, signed out: every new function is refused (401)', anonFns.every(([, s]) => s === 401), anonFns);

    // A stranger: no rows anywhere; google_items answers nothing; the rest are refused.
    const strangerTables = [];
    for (const t of TABLES) strangerTables.push([t, rows(await ask(`/rest/v1/${t}?select=*`, stranger))]);
    check('google calendar, a stranger: no rows in any new table', strangerTables.every(([, n]) => n === 0), strangerTables);
    const strangerFns = [];
    for (const [f, args] of Object.entries(FNS)) {
      const r = await ask(`/rest/v1/rpc/${f}`, stranger, args);
      strangerFns.push([f, r.status, f === 'google_items' ? rows(r) : null]);
    }
    check('google calendar, a stranger: google_items gives nothing; calendar_preview and the job functions are refused (403)',
      strangerFns.every(([f, s, n]) => (f === 'google_items' ? s === 200 && n === 0 : s === 403)), strangerFns);

    // A member who isn't an admin (Sam): the calendars and Google events, but not what was copied
    // to Google (admins only), and no job function or preview.
    const memberTables = {};
    for (const t of TABLES) memberTables[t] = rows(await ask(`/rest/v1/${t}?select=*`, member));
    check('google calendar, a member: reads calendars, google_events and calendar_sync, not calendar_links (admins only)',
      memberTables.calendars === 1 && memberTables.google_events === 1 && memberTables.calendar_sync === 1 && memberTables.calendar_links === 0, memberTables);
    const memberFns = [];
    for (const f of Object.keys(FNS).filter((x) => x !== 'google_items')) memberFns.push([f, (await ask(`/rest/v1/rpc/${f}`, member, FNS[f])).status]);
    check('google calendar, a member: calendar_preview and the job functions are refused (403)', memberFns.every(([, s]) => s === 403), memberFns);
    const write = await ask('/rest/v1/calendars?id=eq.d0000000-0000-4000-8000-000000000001', member, undefined);
    const patch = await h.api('/rest/v1/calendars?id=eq.d0000000-0000-4000-8000-000000000001', { method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${member}`, prefer: 'return=representation' }, body: JSON.stringify({ label: 'Mine' }) });
    check('google calendar, a member: can\'t change a calendar (admins only)', rows(write) === 1 && (patch.status >= 400 || rows(patch) === 0)
      && (await sql("select label from calendars"))[0].label === 'Jordan', patch);

    const after = await sql('select running_since, run_id, auth, last_run_at from calendar_sync');
    const left = await sql("select (select count(*) from calendars) as c, (select count(*) from calendar_links) as l, (select count(*) from google_events) as g, (select status from calendars) as s");
    check('google calendar: nothing was changed (the job\'s lease, the calendar, its link and its Google events are as they were)',
      JSON.stringify(after) === JSON.stringify(before) && JSON.stringify(left) === JSON.stringify([{ c: '1', l: '1', g: '1', s: 'ok' }]), { before, after, left });
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  access stopped: ${e && e.stack}`); process.exit(1); });
