// What the API gives someone signed out (anon) and someone signed in who isn't on the family list,
// through the PostgREST stand-in on the real database: every public table and every public function.
// Signed out, only get_shared_project and the twenty token functions (TOKEN_FNS) may answer; a
// stranger gets nothing from any table, and from the functions only the harmless HARMLESS ones (and
// empty lists). The Google Calendar tables and functions (migration 0003), the dinners and the
// shopping list (migration 0004), and homework (migration 0005) are checked again with rows in their
// tables: anon reaches none of them, a My day link only what the token functions give it, and a tutor
// link only Jordan's homework, through its own four functions. Last, the stand-in's PostgREST logical
// filters (or=, and=, nested, not.or=) give the rows the SQL they stand for gives. Run through
// tests/realdb/run.sh.
const { setup, HOMEWORK_TABLES, HOMEWORK_FNS } = require('./lib');

// The only public functions anon may run: v1's get_shared_project, 0002's five My day functions,
// 0004's three for the helper's list, 0005's seven for Jordan's homework and four for the tutor link, and 0006's
// one for his New from school.
const TOKEN_FNS = ['get_person_day', 'complete_by_token', 'undo_by_token', 'confirm_digest', 'stop_digest', 'get_shared_project',
  'get_list_by_token', 'add_to_list_by_token', 'buy_item_by_token',
  'homework_by_token', 'step_by_token', 'plan_by_token', 'focus_by_token', 'reward_by_token', 'assignment_by_token', 'homework_prefs_by_token',
  'tutor_view_by_token', 'tutor_assignment_by_token', 'tutor_plan_by_token', 'tutor_step_by_token', 'school_item_by_token'];
// What any signed-in account may learn, by design: its own email, the household's date, clock and
// time zone, and the schema version (sign-up is limited to the family list by the auth hook).
const HARMLESS = ['current_email', 'clock', 'today_local', 'hub_schema_version'];
// shopping_list() answers someone who isn't on the family list with empty lists (row-level security
// decides, docs/v1.2-kitchen.md §3.4), and the household's date and time, as clock does.
const emptyLists = (b) => !!b && typeof b === 'object' && !Array.isArray(b)
  && Object.entries(b).every(([k, v]) => k === 'as_of' || (Array.isArray(v) && !v.length));

(async () => {
  const h = await setup('access', { hubJobs: false });
  const { check, flow, sql } = h;

  await flow('access', async () => {
    const tables = (await sql("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v', 'p') order by 1")).map((r) => r.relname);
    const fns = (await sql("select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' order by 1")).map((r) => r.proname);
    const anonFns = (await sql(`select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute') order by 1`)).map((r) => r.proname);
    check(`access: anon may run exactly the ${TOKEN_FNS.length} token functions (and get_shared_project), nothing else`, JSON.stringify(anonFns) === JSON.stringify(TOKEN_FNS.slice().sort()),
      { extra: anonFns.filter((f) => !TOKEN_FNS.includes(f)), missing: TOKEN_FNS.filter((f) => !anonFns.includes(f)) });
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
        const nothing = r.body === null || r.body === false || (Array.isArray(r.body) && !r.body.length) || r.status === 204 || (!!auth && emptyLists(r.body));
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

  // Dinners and the shopping list (migration 0004), with rows in them: a locked dinner, a line to buy,
  // a locked line and one bought today. Signed out: refused, except the token functions, which answer
  // an unknown link with null, a kid's link with null or a refusal, and the helper's link with the
  // unlocked list only. A stranger: no rows, empty lists, the writers refuse. A member (Sam) reads
  // them all, locked ones too, but can't add a line, write bought_at or read my_day_use.
  await flow('food', async () => {
    const id = async (who) => (await sql(`select id, day_token from people where name like '${who}%'`))[0];
    const [alex, sam, jordan, taylor] = [await id('Alex'), await id('Sam'), await id('Jordan'), await id('Taylor')];
    await sql(`
      insert into meals (day, kind, title, cook_id, note, link) values ('2026-10-27', 'cook', 'Tacos', '${sam.id}', 'Chicken is in the freezer', 'https://cooking.example.com/tacos');
      insert into meals (day, kind, title, private) values ('2026-10-28', 'cook', 'Birthday cake', true);
      insert into shopping_items (name, aisle, added_by) values ('Milk', 'dairy', '${alex.id}');
      insert into shopping_items (name, aisle, private, added_by) values ('Pregnancy test', 'personal', true, '${alex.id}');
      insert into shopping_items (name, aisle, added_by, bought_at, bought_by) values ('Eggs', 'dairy', '${alex.id}', private.now(), '${alex.id}');
      insert into my_day_use (person_id, day, changes, ticks) values ('${taylor.id}', '2026-10-27', 1, 1);`);
    const before = await sql(`select (select count(*) from meals) as m, (select count(*) from shopping_items) as s, (select count(*) from my_day_use) as u,
      (select string_agg(name || ':' || coalesce(bought_at::text, '-') || ':' || added_at, ',' order by name) from shopping_items) as rows`);
    const TABLES = ['meals', 'shopping_items', 'my_day_use'];
    const milk = (await sql("select id, added_at from shopping_items where name = 'Milk'"))[0];
    const locked = (await sql("select id, added_at from shopping_items where private"))[0];
    // seen as shopping_list() writes it (to_jsonb of a timestamptz).
    const seen = async (row) => (await sql(`select to_jsonb(added_at) #>> '{}' as s from shopping_items where id = '${row.id}'`))[0].s;
    const FNS = {
      shopping_list: {},
      add_to_list: { p_name: 'Bread', p_private: false },
      buy_item: { p_item: milk.id, p_bought: true, p_seen: await seen(milk) },
    };
    const member = (await h.sessionFor('sam@example.com')).access_token;
    let stranger = (await h.sessionFor('casey@example.com').catch(() => null));
    stranger = stranger && stranger.access_token;
    if (!stranger) {
      await sql("insert into members (email, name) values ('casey@example.com', 'Casey')");
      stranger = (await h.sessionFor('casey@example.com')).access_token;
      await sql("delete from members where email = 'casey@example.com'");
    }
    const ask = (p, auth, body, method = 'POST') => h.api(p, body === undefined ? { headers: auth ? { authorization: `Bearer ${auth}` } : {} }
      : { method, headers: Object.assign({ 'content-type': 'application/json', prefer: 'return=representation' }, auth ? { authorization: `Bearer ${auth}` } : {}), body: JSON.stringify(body) });
    const rows = (r) => (r.status === 200 && Array.isArray(r.body) ? r.body.length : null);

    // Signed out.
    const anon = [];
    for (const t of TABLES) anon.push([t, (await ask(`/rest/v1/${t}?select=*`, null)).status]);
    for (const [f, args] of Object.entries(FNS)) anon.push([f, (await ask(`/rest/v1/rpc/${f}`, null, args)).status]);
    anon.push(['insert meals', (await ask('/rest/v1/meals', null, { day: '2026-10-29', kind: 'out' })).status]);
    check('food, signed out: the three tables, shopping_list, add_to_list and buy_item are refused (401)', anon.every(([, st]) => st === 401), anon);
    const tok = (t, f, args) => ask(`/rest/v1/rpc/${f}`, null, Object.assign({ p_token: t }, args));
    const unknown = '0123456789abcdef0123456789abcdef';
    const tokenArgs = { get_list_by_token: {}, add_to_list_by_token: { p_name: 'Bread' }, buy_item_by_token: { p_item: milk.id, p_bought: true, p_seen: await seen(milk) } };
    const nulls = [];
    for (const [f, args] of Object.entries(tokenArgs)) { const r = await tok(unknown, f, args); nulls.push([f, r.status, r.body]); }
    check('food, signed out: an unknown My day link gets null from the three list functions', nulls.every(([, st, b]) => st === 200 && b === null), nulls);
    const kid = [];
    for (const [f, args] of Object.entries(tokenArgs)) { const r = await tok(jordan.day_token, f, args); kid.push([f, r.status, r.body && (r.body.code || r.body)]); }
    check('food, signed out: Jordan\'s link (a kid) gets no list (null), and the writers refuse it (401, 42501)',
      kid[0][1] === 200 && kid[0][2] === null && kid.slice(1).every(([, st, c]) => st === 401 && c === '42501'), kid);
    const list = await tok(taylor.day_token, 'get_list_by_token', {});
    const text = JSON.stringify(list.body);
    check('food, signed out: Taylor\'s link (the helper) gets the unlocked list: Milk to buy, Eggs bought today, nothing locked, no people',
      list.status === 200 && !!list.body && list.body.items.map((x) => x.name).join() === 'Milk' && list.body.bought.map((x) => x.name).join() === 'Eggs'
      && !/Pregnancy/.test(text) && !text.includes(locked.id) && ![alex, sam, jordan, taylor].some((p) => text.includes(p.id)) && !/Alex|Sam|Taylor|Example/.test(text), text.slice(0, 300));
    const lockedTick = await tok(taylor.day_token, 'buy_item_by_token', { p_item: locked.id, p_bought: true, p_seen: await seen(locked) });
    check('food, signed out: a tick of the locked line\'s id through Taylor\'s link changes nothing (false, as an unknown id)',
      lockedTick.status === 200 && lockedTick.body && lockedTick.body.changed === false, lockedTick.body && lockedTick.body.changed);

    // A stranger (signed in, not on the family list).
    const sTables = [];
    for (const t of TABLES) { const r = await ask(`/rest/v1/${t}?select=*`, stranger); sTables.push([t, r.status, rows(r)]); }
    check('food, a stranger: no meals and no shopping_items rows; my_day_use refused (403: no privilege)',
      sTables[0][2] === 0 && sTables[1][2] === 0 && sTables[2][1] === 403, sTables);
    const sl = await ask('/rest/v1/rpc/shopping_list', stranger, {});
    const sw = [];
    for (const f of ['add_to_list', 'buy_item']) { const r = await ask(`/rest/v1/rpc/${f}`, stranger, FNS[f]); sw.push([f, r.status, r.body && r.body.code, r.body && r.body.message]); }
    check('food, a stranger: shopping_list() gives empty lists; add_to_list and buy_item refuse (403, 42501, "Only the family can change the shopping list.")',
      sl.status === 200 && emptyLists(sl.body) && sw.every(([, st, c, m]) => st === 403 && c === '42501' && m === 'Only the family can change the shopping list.'), { sl: sl.body, sw });

    // A member who isn't an admin (Sam).
    const mTables = {};
    for (const t of TABLES) { const r = await ask(`/rest/v1/${t}?select=*`, member); mTables[t] = [r.status, rows(r)]; }
    check('food, a member: reads both dinners and every line (the locked ones too); my_day_use refused (403)',
      mTables.meals[1] === 2 && mTables.shopping_items[1] === 3 && mTables.my_day_use[0] === 403, mTables);
    const ins = await ask('/rest/v1/shopping_items', member, { name: 'Bread' });
    const buy = await ask(`/rest/v1/shopping_items?id=eq.${milk.id}`, member, { bought_at: '2026-10-27T13:00:00Z' }, 'PATCH');
    const use = await ask('/rest/v1/my_day_use', member, { person_id: sam.id, day: '2026-10-27' });
    check('food, a member: can\'t insert a line (adds go through add_to_list), write bought_at, or write my_day_use (403)',
      [ins, buy, use].every((r) => r.status === 403), [ins, buy, use].map((r) => [r.status, r.body && r.body.code]));

    const after = await sql(`select (select count(*) from meals) as m, (select count(*) from shopping_items) as s, (select count(*) from my_day_use) as u,
      (select string_agg(name || ':' || coalesce(bought_at::text, '-') || ':' || added_at, ',' order by name) from shopping_items) as rows`);
    check('food: nothing was changed (the dinners, the lines and the counter are as they were)', JSON.stringify(after) === JSON.stringify(before), { before, after });
  });

  // Homework (migration 0005), with a row in every one of its eleven tables: Jordan's homework on,
  // his homework time (Mon–Thu 4:30–5:15) and Tuesday's "Piano with Morgan" over it, Pat's tutor link,
  // an assignment with the teacher's text and three steps (a milestone he ticked, a step with his
  // question, the turn-in), a finished block, a reward, his ask, his points, a day's count and an AI
  // run. Signed out, every table, every write and every signed-in or job function is refused (401);
  // Jordan's token gets his own view and Pat's link its own, neither with anyone else's name, an
  // email (Alex gave the plan and ticked its turn-in, so given_by and done_by hold Alex's), a token or
  // a person's id, and Pat's never points, rewards, asks, busy titles or a block;
  // Pat's token opens nothing else (every other anonymous function answers it with null, false or a
  // refusal), and Jordan's token opens no tutor function. A stranger gets no rows, an empty week and
  // refusals; Sam (a member) reads it all but the links, the AI runs and the counter, and every write
  // refuses him; even Alex can't write steps, blocks, asks, points, links, counts or AI runs directly,
  // nor the columns only the functions set. Nothing changes.
  await flow('homework', async () => {
    const id = async (who) => (await sql(`select id, day_token from people where name like '${who}%'`))[0];
    const [alex, morgan, sam, jordan, taylor] = [await id('Alex'), await id('Morgan'), await id('Sam'), await id('Jordan'), await id('Taylor')];
    const PAT = 'abcdef0123456789abcdef0123456789';
    const I = { time: 'e0000000-0000-4000-8000-000000000051', link: 'e0000000-0000-4000-8000-000000000052', asg: 'e0000000-0000-4000-8000-000000000053',
      s1: 'e0000000-0000-4000-8000-000000000054', s2: 'e0000000-0000-4000-8000-000000000055', s3: 'e0000000-0000-4000-8000-000000000056',
      block: 'e0000000-0000-4000-8000-000000000057', reward: 'e0000000-0000-4000-8000-000000000058', ask: 'e0000000-0000-4000-8000-000000000059',
      given: 'e0000000-0000-4000-8000-000000000060', fresh: 'e0000000-0000-4000-8000-000000000061' };
    await sql(`
      insert into homework_kids (kid_id, cue) values ('${jordan.id}', 'When I''ve had my snack, I open my notes doc.');
      insert into events (id, title, start_date, start_time, end_time, responsible_id, repeat, repeat_weekdays)
        values ('${I.time}', 'Homework', '2026-10-26', '16:30', '17:15', '${jordan.id}', 'weekly', '{1,2,3,4}');
      insert into homework_times (event_id, kid_id) values ('${I.time}', '${jordan.id}');
      insert into events (title, start_date, start_time, end_time, responsible_id, participant_ids, repeat, repeat_weekdays)
        values ('Piano with Morgan', '2026-10-27', '16:45', '17:30', '${morgan.id}', '{${jordan.id}}', 'weekly', '{2}');
      insert into tutor_links (id, kid_id, token, label, expires_on) values ('${I.link}', '${jordan.id}', '${PAT}', 'Pat Lee, tutor', '2027-04-25');
      insert into assignments (id, kid_id, title, subject, due_date, details, given_at, given_by, plan_rev)
        values ('${I.asg}', '${jordan.id}', 'Science project: river poster', 'Science', '2026-11-13', 'Make a poster about a river.' || chr(10) || 'Show its source and its mouth.',
                private.now(), 'alex@example.com', 1);
      insert into homework_steps (id, assignment_id, pos, kind, title, done_looks_like, minutes, day, done_at, done_by, question, question_at) values
        ('${I.s1}', '${I.asg}', 1, 'milestone', 'Outline with 3 main points', 'an outline you can show', 20, '2026-10-27', private.now(), 'Jordan Example (My day)', null, null),
        ('${I.s2}', '${I.asg}', 2, 'step', 'Find 2 sources and save their links', null, 20, '2026-10-28', null, null, 'Does the poster need a title?', private.now()),
        ('${I.s3}', '${I.asg}', 3, 'turn_in', 'Turn it in', 'handed in', 5, '2026-11-13', private.now(), 'alex@example.com', null, null);
      insert into focus_sessions (id, kid_id, assignment_id, step_id, minutes, started_at, ends_at, ended_at, result, seen_minutes, points)
        values ('${I.block}', '${jordan.id}', '${I.asg}', '${I.s1}', 20, private.now() - interval '1 hour', private.now() - interval '40 minutes',
                private.now() - interval '40 minutes', 'done', 20, 4);
      insert into rewards (id, kid_id, title, cost) values ('${I.reward}', '${jordan.id}', 'Choose Friday''s dinner', 60);
      insert into points_ledger (id, kid_id, at, day, kind, delta, note, who) values ('${I.given}', '${jordan.id}', private.now(), '2026-10-27', 'given', 118, 'Great session', 'alex@example.com');
      insert into reward_asks (id, kid_id, reward_id, title, cost, asked_at) values ('${I.ask}', '${jordan.id}', '${I.reward}', 'Choose Friday''s dinner', 60, private.now());
      insert into homework_use (actor_id, day, what, n) values ('${jordan.id}', '2026-10-27', 'writes', 1);
      insert into ai_runs (kid_id, assignment_id, kind, asked_by, key, status, stop, started_at, lease_until, finished_at)
        values ('${jordan.id}', '${I.asg}', 'plan', 'alex@example.com', gen_random_uuid(), 'failed', 'timeout', private.now(), private.now() + interval '2 minutes', private.now());`);
    // Everything but the link's last_used_at, which a read through the link sets on purpose.
    const snapshot = async () => {
      const out = {};
      for (const t of HOMEWORK_TABLES) {
        const cols = t === 'tutor_links' ? "to_jsonb(x) - 'last_used_at'" : 'to_jsonb(x)';
        out[t] = (await sql(`select coalesce(jsonb_agg(${cols} order by x::text), '[]')::text as j from public.${t} x`))[0].j;
      }
      out.other = (await sql(`select (select count(*) from task_log) as log, (select count(*) from shopping_items) as list,
        (select string_agg(name || ':' || digest_enabled, ',' order by name) from people) as people`))[0];
      return out;
    };
    const before = await snapshot();
    const member = (await h.sessionFor('sam@example.com')).access_token;
    const admin = (await h.sessionFor('alex@example.com')).access_token;
    let stranger = (await h.sessionFor('casey@example.com').catch(() => null));
    stranger = stranger && stranger.access_token;
    if (!stranger) {
      await sql("insert into members (email, name) values ('casey@example.com', 'Casey')");
      stranger = (await h.sessionFor('casey@example.com')).access_token;
      await sql("delete from members where email = 'casey@example.com'");
    }
    const ask = (p, auth, body, method = 'POST') => h.api(p, body === undefined ? { headers: auth ? { authorization: `Bearer ${auth}` } : {} }
      : { method, headers: Object.assign({ 'content-type': 'application/json', prefer: 'return=representation' }, auth ? { authorization: `Bearer ${auth}` } : {}), body: JSON.stringify(body) });
    const rows = (r) => (r.status === 200 && Array.isArray(r.body) ? r.body.length : null);
    const fn = (f, auth, args) => ask(`/rest/v1/rpc/${f}`, auth, args);
    // Everyone's names (surnames too), the household's emails and every person's id: none of these is in a link's answer.
    const people = await sql('select id, name, email from people');
    const leaks = (text, allow = []) => {
      const found = [];
      for (const p of people) {
        for (const part of p.name.split(' ')) if (!allow.includes(part) && new RegExp(`\\b${part}\\b`).test(text)) found.push(part);
        if (text.includes(p.id)) found.push(`id of ${p.name}`);
        if (p.email && text.includes(p.email)) found.push(p.email);
      }
      if (/@/.test(text)) found.push('an @');
      for (const t of [PAT, jordan.day_token, taylor.day_token]) if (text.includes(t)) found.push('a token');
      return [...new Set(found)];
    };
    // Each new public function, with arguments it takes, so a refusal is the permission and not a missing argument.
    const SIGNED_IN = {
      homework_week: { p_kid: jordan.id, p_from: '2026-10-27', p_days: 14 },
      save_homework_kid: { p_kid: jordan.id, p_active: false },
      add_homework_time: { p_kid: jordan.id, p_weekdays: [5], p_start: '16:00', p_end: '17:00' },
      save_homework_plan: { p_assignment: I.asg, p_steps: [], p_rev: 1, p_give: false },
      homework_step: { p_step: I.s1, p_action: 'check', p_text: 'Looks good.' },
      decide_reward: { p_ask: I.ask, p_approve: true, p_note: null },
      give_points: { p_kid: jordan.id, p_points: 50, p_note: 'For free', p_key: I.fresh },
      void_points: { p_entry: I.given, p_note: 'Gone' },
      save_tutor_link: { p_link: I.link, p_kid: jordan.id, p_label: 'Pat Lee, tutor', p_language: 'en', p_expires_on: '2027-04-25', p_can_ai: true, p_active: false },
      new_tutor_token: { p_link: I.link },
      homework_ai_preview: { p_assignment: I.asg, p_kind: 'plan', p_request: null, p_answers: null },
      homework_ai_draft: { p_assignment: I.asg, p_action: 'dismiss' },
      erase_homework: { p_kid: jordan.id, p_confirm: 'ERASE' },
    };
    const JOBS = {
      homework_ai_start: { p_token: PAT, p_email: null, p_assignment: I.asg, p_kind: 'plan', p_request: null, p_answers: null, p_key: I.fresh },
      homework_ai_finish: { p_run: I.fresh, p_stop: 'error', p_draft: null, p_usage: null, p_model: null },
    };
    const KID = (t) => ({
      homework_by_token: { p_token: t },
      step_by_token: { p_token: t, p_step: I.s2, p_action: 'done' },
      plan_by_token: { p_token: t, p_assignment: I.asg, p_steps: null, p_rev: 1 },
      focus_by_token: { p_token: t, p_action: 'start', p_session: I.fresh, p_minutes: 20, p_step: I.s2, p_with: 'alone' },
      reward_by_token: { p_token: t, p_action: 'ask', p_reward: I.reward, p_key: I.fresh },
      assignment_by_token: { p_token: t, p_action: 'add', p_assignment: I.fresh, p_title: 'Worksheet 5.1', p_subject: 'Math', p_due_date: '2026-10-28', p_minutes: 15 },
      homework_prefs_by_token: { p_token: t, p_cue: 'Snack first.', p_if_stuck: null, p_minutes: 25 },
    });
    const TUTOR = (t) => ({
      tutor_view_by_token: { p_token: t, p_assignment: null, p_part: 'all' },
      tutor_assignment_by_token: { p_token: t, p_fields: { id: I.fresh, kind: 'lesson', title: 'Fractions practice', due_date: '2026-11-06' } },
      tutor_plan_by_token: { p_token: t, p_assignment: I.asg, p_steps: [], p_rev: 1, p_give: false },
      tutor_step_by_token: { p_token: t, p_step: I.s1, p_action: 'check', p_text: 'Looks done.' },
    });
    check('homework: the test calls every new public function', JSON.stringify(Object.keys(Object.assign({}, SIGNED_IN, JOBS, KID(''), TUTOR(''))).sort())
      === JSON.stringify(HOMEWORK_FNS.slice().sort()));

    // Signed out: the tables, a direct write and every function a parent's page or hub-jobs calls are refused (401).
    const anon = [];
    for (const t of HOMEWORK_TABLES) anon.push([t, (await ask(`/rest/v1/${t}?select=*`, null)).status]);
    anon.push(['insert assignments', (await ask('/rest/v1/assignments', null, { kid_id: jordan.id, title: 'Mine', due_date: '2026-11-01' })).status]);
    anon.push(['insert points_ledger', (await ask('/rest/v1/points_ledger', null, { kid_id: jordan.id, at: '2026-10-27T13:00:00Z', day: '2026-10-27', kind: 'given', delta: 500, who: 'x' })).status]);
    anon.push(['update homework_kids', (await ask(`/rest/v1/homework_kids?kid_id=eq.${jordan.id}`, null, { points_on: false }, 'PATCH')).status]);
    for (const [f, args] of Object.entries(Object.assign({}, SIGNED_IN, JOBS))) anon.push([f, (await fn(f, null, args)).status]);
    check('homework, signed out: the eleven tables, direct writes, and the signed-in and job functions are all refused (401)', anon.every(([, st]) => st === 401), anon.filter(([, st]) => st !== 401));

    // Signed out with Jordan's My day link: his view, and nothing of anyone else.
    const kidView = await fn('homework_by_token', null, { p_token: jordan.day_token });
    const kv = JSON.stringify(kidView.body);
    check('homework, Jordan\'s link: homework_by_token gives his view (his first name, Pat as "Pat", his step and his ask)', kidView.status === 200 && !!kidView.body
      && kidView.body.me.first_name === 'Jordan' && kidView.body.me.tutor === 'Pat' && kv.includes('Find 2 sources and save their links') && kv.includes('Choose Friday'), kv.slice(0, 300));
    check('homework, Jordan\'s link: no teacher\'s text, no other name or surname, no email, no person\'s id and no token in his view',
      !kv.includes('Make a poster') && !leaks(kv, ['Jordan']).length, leaks(kv, ['Jordan']));
    const card = await fn('get_person_day', null, { p_token: jordan.day_token });
    check('homework, Jordan\'s link: get_person_day carries his card, with no teacher\'s text', card.status === 200 && !!card.body && !!card.body.homework
      && !JSON.stringify(card.body.homework).includes('Make a poster'), JSON.stringify(card.body && card.body.homework));
    const notTutor = [];
    for (const [f, args] of Object.entries(TUTOR(jordan.day_token))) { const r = await fn(f, null, args); notTutor.push([f, r.status, r.body]); }
    check('homework, Jordan\'s link: opens no tutor function (null from all four)', notTutor.every(([, st, b]) => st === 200 && b === null), notTutor);

    // Signed out with Pat's link: Jordan's homework, and nothing of the family.
    const list = await fn('tutor_view_by_token', null, { p_token: PAT, p_assignment: null, p_part: 'all' });
    const one = await fn('tutor_view_by_token', null, { p_token: PAT, p_assignment: I.asg, p_part: 'all' });
    const lt = JSON.stringify(list.body);
    const ot = JSON.stringify(one.body);
    check('homework, Pat\'s link: tutor_view_by_token gives Jordan\'s homework (the kid as "Jordan", the link\'s label, the assignment, its plan, his question)',
      list.status === 200 && !!list.body && list.body.kid === 'Jordan' && list.body.tutor === 'Pat Lee, tutor' && lt.includes('Science project: river poster')
      && one.status === 200 && !!one.body && !!one.body.assignment && one.body.assignment.steps.length === 3 && ot.includes('Does the poster need a title?')
      && one.body.assignment.details === 'Make a poster about a river.\nShow its source and its mouth.', lt.slice(0, 300));
    check('homework, Pat\'s link: no other name or surname, no email, no person\'s id and no token, in the list or the assignment',
      !leaks(lt, ['Jordan', 'Pat', 'Lee']).length && !leaks(ot, ['Jordan', 'Pat', 'Lee']).length, [leaks(lt, ['Jordan', 'Pat', 'Lee']), leaks(ot, ['Jordan', 'Pat', 'Lee'])]);
    const keysOf = (o, acc = new Set()) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.add(k); keysOf(v, acc); } return acc; };
    const tutorKeys = new Set([...keysOf(list.body), ...keysOf(one.body)]);
    check('homework, Pat\'s link: no points, rewards, asks, balance or running block anywhere in the answers, nor "alone"',
      !['points', 'rewards', 'asks', 'balance', 'held', 'recent', 'session', 'with', 'with_whom'].some((k) => tutorKeys.has(k)) && !/Choose Friday|\b118\b|alone/.test(lt + ot),
      [...tutorKeys].filter((k) => ['points', 'rewards', 'asks', 'balance', 'held', 'recent', 'session', 'with', 'with_whom'].includes(k)));
    const busy = (list.body.week || []).flatMap((d) => d.busy || []);
    check('homework, Pat\'s link: his week has Tuesday\'s busy block, with no title (no "Piano", no "Morgan")', busy.length > 0 && busy.every((b) => !('title' in b))
      && !/Piano/.test(lt + ot), busy);
    // Pat's token in every other anonymous function: nothing answers it, and nothing changes.
    const elsewhere = {
      get_person_day: { p_token: PAT }, complete_by_token: { p_token: PAT, p_task_id: I.fresh, p_occurrence: '2026-10-27' }, undo_by_token: { p_token: PAT, p_log_id: I.fresh },
      confirm_digest: { p_confirm: PAT }, stop_digest: { p_token: PAT }, get_shared_project: { share: PAT },
      get_list_by_token: { p_token: PAT }, add_to_list_by_token: { p_token: PAT, p_name: 'Bread' }, buy_item_by_token: { p_token: PAT, p_item: I.fresh, p_bought: true, p_seen: '2026-10-27T13:00:00Z' },
    };
    Object.assign(elsewhere, KID(PAT));
    const patElse = [];
    for (const [f, args] of Object.entries(elsewhere)) { const r = await fn(f, null, args); patElse.push([f, r.status, r.body]); }
    const nothing = ([, st, b]) => (st === 200 && (b === null || b === false)) || st === 204 || (st >= 400 && st < 500 && !!b && !!b.code);
    check('homework, Pat\'s link: its token opens nothing else (every other anonymous function answers null, false or a refusal)',
      Object.keys(elsewhere).length === 16 && patElse.every(nothing), patElse.filter((x) => !nothing(x)));
    const unknown = [];
    for (const [f, args] of Object.entries(Object.assign({}, KID('0123456789abcdef0123456789abcdef'), TUTOR('0123456789abcdef0123456789abcdef')))) {
      const r = await fn(f, null, args);
      unknown.push([f, r.status, r.body]);
    }
    check('homework: an unknown token gets null from the eleven new token functions', unknown.every(([, st, b]) => st === 200 && b === null), unknown.filter(([, st, b]) => st !== 200 || b !== null));

    // A stranger (signed in, not on the family list).
    const sTables = [];
    for (const t of HOMEWORK_TABLES) { const r = await ask(`/rest/v1/${t}?select=*`, stranger); sTables.push([t, r.status, rows(r)]); }
    check('homework, a stranger: no rows in any homework table; homework_use refused (403: no privilege)',
      sTables.every(([t, st, n]) => (t === 'homework_use' ? st === 403 : n === 0)), sTables);
    const sWeek = await fn('homework_week', stranger, SIGNED_IN.homework_week);
    check('homework, a stranger: homework_week answers 14 days with no homework time and nothing busy',
      sWeek.status === 200 && Array.isArray(sWeek.body) && sWeek.body.length === 14 && sWeek.body.every((d) => d.window === null && !(d.busy || []).length), JSON.stringify(sWeek.body).slice(0, 200));
    const sFns = [];
    for (const [f, args] of Object.entries(SIGNED_IN)) if (f !== 'homework_week') { const r = await fn(f, stranger, args); sFns.push([f, r.status, r.body && r.body.message]); }
    for (const [f, args] of Object.entries(JOBS)) { const r = await fn(f, stranger, args); sFns.push([f, r.status, r.body && r.body.code]); }
    check('homework, a stranger: every parent\'s function refuses ("Only a parent can change homework.", 403), and the job functions too',
      sFns.every(([f, st, m]) => st === 403 && (f in JOBS || m === 'Only a parent can change homework.')), sFns);

    // Sam (a member, not a parent).
    const mTables = {};
    for (const t of HOMEWORK_TABLES) { const r = await ask(`/rest/v1/${t}?select=*`, member); mTables[t] = r.status === 200 ? rows(r) : r.status; }
    check('homework, a member: reads Jordan\'s homework (settings, time, assignment, 3 steps, block, reward, ask, points), not the tutor link, the AI runs or the counter',
      JSON.stringify(mTables) === JSON.stringify({ homework_kids: 1, homework_times: 1, tutor_links: 0, assignments: 1, homework_steps: 3, focus_sessions: 1, rewards: 1,
        reward_asks: 1, points_ledger: 1, homework_use: 403, ai_runs: 0 }), mTables);
    const mWeek = await fn('homework_week', member, SIGNED_IN.homework_week);
    const tue = (mWeek.body || []).find((d) => d.day === '2026-10-27');
    check('homework, a member: homework_week has his homework time and the busy block with its title (members see events anyway)',
      mWeek.status === 200 && !!tue && !!tue.window && tue.window.starts === '16:30' && (tue.busy || []).some((b) => b.title === 'Piano with Morgan'), tue);
    const mw = [];
    mw.push(['insert assignments', (await ask('/rest/v1/assignments', member, { kid_id: jordan.id, title: 'Mine', due_date: '2026-11-01' })).status]);
    mw.push(['insert rewards', (await ask('/rest/v1/rewards', member, { kid_id: jordan.id, title: 'Mine', cost: 1 })).status]);
    mw.push(['insert homework_times', (await ask('/rest/v1/homework_times', member, { event_id: I.time, kid_id: jordan.id })).status]);
    const mPatch = await ask(`/rest/v1/homework_kids?kid_id=eq.${jordan.id}`, member, { points_on: false }, 'PATCH');
    const mDel = await ask(`/rest/v1/assignments?id=eq.${I.asg}`, member, {}, 'DELETE');
    const mFns = [];
    for (const [f, args] of Object.entries(SIGNED_IN)) if (f !== 'homework_week') { const r = await fn(f, member, args); mFns.push([f, r.status, r.body && r.body.message]); }
    check('homework, a member: every write refuses Sam (inserts 403; an update or a delete reaches no row; every parent\'s function says "Only a parent can change homework.")',
      mw.every(([, st]) => st === 403) && rows(mPatch) === 0 && rows(mDel) === 0
      && mFns.every(([, st, m]) => st === 403 && m === 'Only a parent can change homework.'), { mw, patch: mPatch.status, del: mDel.status, mFns: mFns.filter(([, st]) => st !== 403) });

    // Alex (a parent): reads the link and the AI runs; the tables only the functions write, and the
    // columns only the functions set, refuse even him.
    const aRead = [rows(await ask('/rest/v1/tutor_links?select=token', admin)), rows(await ask('/rest/v1/ai_runs?select=*', admin)), (await ask('/rest/v1/homework_use?select=*', admin)).status];
    check('homework, a parent: reads the tutor link and the AI runs; homework_use refused (403)', JSON.stringify(aRead) === JSON.stringify([1, 1, 403]), aRead);
    const aw = [];
    aw.push(['insert homework_steps', (await ask('/rest/v1/homework_steps', admin, { assignment_id: I.asg, pos: 4, title: 'Sneaked in', minutes: 10, day: '2026-10-28' })).status]);
    aw.push(['update homework_steps', (await ask(`/rest/v1/homework_steps?id=eq.${I.s1}`, admin, { checked_at: '2026-10-27T13:00:00Z', checked_by: 'x' }, 'PATCH')).status]);
    aw.push(['insert focus_sessions', (await ask('/rest/v1/focus_sessions', admin, { id: I.fresh, kid_id: jordan.id, minutes: 20, started_at: '2026-10-27T13:00:00Z', ends_at: '2026-10-27T13:20:00Z' })).status]);
    aw.push(['insert points_ledger', (await ask('/rest/v1/points_ledger', admin, { kid_id: jordan.id, at: '2026-10-27T13:00:00Z', day: '2026-10-27', kind: 'given', delta: 500, who: 'x' })).status]);
    aw.push(['insert reward_asks', (await ask('/rest/v1/reward_asks', admin, { kid_id: jordan.id, title: 'x', cost: 1, asked_at: '2026-10-27T13:00:00Z' })).status]);
    aw.push(['insert tutor_links', (await ask('/rest/v1/tutor_links', admin, { kid_id: jordan.id, label: 'Someone', expires_on: '2027-01-01' })).status]);
    aw.push(['update tutor_links', (await ask(`/rest/v1/tutor_links?id=eq.${I.link}`, admin, { active: false }, 'PATCH')).status]);
    aw.push(['insert ai_runs', (await ask('/rest/v1/ai_runs', admin, { kind: 'test', asked_by: 'x', key: I.fresh, started_at: '2026-10-27T13:00:00Z', lease_until: '2026-10-27T13:02:00Z' })).status]);
    aw.push(['insert homework_use', (await ask('/rest/v1/homework_use', admin, { actor_id: jordan.id, day: '2026-10-27', what: 'starts', n: 0 })).status]);
    aw.push(['insert homework_kids', (await ask('/rest/v1/homework_kids', admin, { kid_id: taylor.id })).status]);
    aw.push(['update homework_kids.cue', (await ask(`/rest/v1/homework_kids?kid_id=eq.${jordan.id}`, admin, { cue: 'Their words, not his' }, 'PATCH')).status]);
    aw.push(['update assignments.given_by', (await ask(`/rest/v1/assignments?id=eq.${I.asg}`, admin, { given_by: 'someone' }, 'PATCH')).status]);
    aw.push(['update assignments.plan_rev', (await ask(`/rest/v1/assignments?id=eq.${I.asg}`, admin, { plan_rev: 9 }, 'PATCH')).status]);
    aw.push(['update assignments.added_by', (await ask(`/rest/v1/assignments?id=eq.${I.asg}`, admin, { added_by: 'kid' }, 'PATCH')).status]);
    aw.push(['update rewards.suggested', (await ask(`/rest/v1/rewards?id=eq.${I.reward}`, admin, { suggested: true }, 'PATCH')).status]);
    check('homework, a parent: no direct write to steps, blocks, points, asks, links, AI runs or the counter, no new homework row, and no write to a column only the functions set (403 each)',
      aw.every(([, st]) => st === 403), aw.filter(([, st]) => st !== 403));

    const after = await snapshot();
    const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    check('homework: nothing was changed (every homework table, the task log, the list and the people)', !changed.length, changed.map((k) => [k, before[k], after[k]]));
  });

  // The stand-in's logical filters (PostgREST's or=, and=, nested and(…)/or(…), not.or=, a quoted in.(…)), which
  // Today's homework read uses: the same rows as the SQL they stand for, read as Alex.
  await flow('logical filters', async () => {
    const alex = (await h.sessionFor('alex@example.com')).access_token;
    const names = async (q) => {
      const r = await h.api(`/rest/v1/people?select=name${q}&order=name`, { headers: { authorization: `Bearer ${alex}` } });
      return [r.status, Array.isArray(r.body) ? r.body.map((x) => x.name) : r.body];
    };
    const want = async (w) => [200, (await sql(`select name from people where ${w} order by name`)).map((x) => x.name)];
    const got = [await names('&or=(role.eq.kid,and(role.eq.helper,language.eq.es))'), await names('&and=(role.neq.kid,or(email.is.null,phone.not.is.null))'),
      await names('&not.or=(role.eq.kid,role.eq.helper)'), await names('&or=(name.in.("Jordan Example","Taylor Example"),name.eq."Alex Example")')];
    const exp = [await want("role = 'kid' or (role = 'helper' and language = 'es')"), await want("role <> 'kid' and (email is null or phone is not null)"),
      await want("not (role = 'kid' or role = 'helper')"), await want("name in ('Jordan Example', 'Taylor Example', 'Alex Example')")];
    check('logical filters: or=, and=, nested, not.or= and quoted values give the rows the SQL gives (and some rows each)',
      JSON.stringify(got) === JSON.stringify(exp) && exp.every(([, n]) => n.length > 0), { got, exp });
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  access stopped: ${e && e.stack}`); process.exit(1); });
