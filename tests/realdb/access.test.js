// What the API gives someone signed out (anon) and someone signed in who isn't on the family list,
// through the PostgREST stand-in on the real database: every public table and every public function.
// Signed out, only get_shared_project and the five My day token functions may answer; a stranger
// gets nothing from any table, and from the functions only the harmless HARMLESS ones. Run through tests/realdb/run.sh.
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

  await h.finish();
})().catch((e) => { console.log(`FAIL  access stopped: ${e && e.stack}`); process.exit(1); });
