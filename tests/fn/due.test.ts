// Unit tests for Due tomorrow (docs/v1.3-homework.md §29): supabase/functions/hub-jobs/due.ts (the email) and its parts
// of handler.ts (the run sends it; due_preview shows it), with a fake database, Resend and clock. The lists below have
// the shape public.due_list returns (tests/db/due_tomorrow.test.sql checks the SQL); everyone in them is made up.
// Run alone with: node --experimental-strip-types tests/fn/due.test.ts
import { handle } from '../../supabase/functions/hub-jobs/handler.ts';
import { renderDue } from '../../supabase/functions/hub-jobs/due.ts';
import type { DueList } from '../../supabase/functions/hub-jobs/due.ts';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`);

const SECRET = '9f1c2e7a4b6d8e0f1a3c5e7b9d2f4a6c8e0b';
const ALEX = 'aaaaaaaa-0000-4000-8000-000000000001';
const SAM = 'aaaaaaaa-0000-4000-8000-000000000002';
const JORDAN = 'aaaaaaaa-0000-4000-8000-000000000003';
const TAYLOR = 'aaaaaaaa-0000-4000-8000-000000000004';
const DAY = '2026-11-13';

const list = (lang = 'en'): DueList => ({
  day: DAY, tomorrow: '2026-11-14', tomorrow_label: lang === 'es' ? 'sáb 14 nov' : 'Sat Nov 14',
  coming_to: '2026-11-17', coming_to_label: lang === 'es' ? 'mar 17 nov' : 'Tue Nov 17',
  kids: [{
    id: JORDAN, name: 'Jordan',
    tomorrow: [{ title: 'Verbs worksheet', subject: 'Spanish', due: '2026-11-14', due_label: 'Sat Nov 14', done: true },
               { title: 'Volcano <b>poster</b>', subject: 'Science', due: '2026-11-14', due_label: 'Sat Nov 14' }],
    late: [{ title: 'Lab report', subject: 'Science', due: '2026-11-05', due_label: 'Thu Nov 5', missing: true },
           { title: 'Map quiz', subject: 'History', due: '2026-11-13', due_label: 'Fri Nov 13' }],
    coming: [{ title: 'Math topics', subject: 'Math', due: '2026-11-16', due_label: 'Mon Nov 16', count: { goal: 7, done: 5 } }],
  }],
});
const empty = (): DueList => ({ ...list(), kids: [{ id: JORDAN, name: 'Jordan', tomorrow: [], late: [], coming: [] }] });

// ---------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------
{
  const e = renderDue(list(), { language: 'en' });
  check('subject: tomorrow\'s day and how many are still to do, per kid (the done one not counted)', e.subject === 'Due tomorrow (Sat Nov 14): 1 for Jordan', e.subject);
  check('three sections in order: tomorrow, not marked done yet, coming up', /Due tomorrow, Sat Nov 14[\s\S]*Not marked done yet[\s\S]*Coming up, to Tue Nov 17/.test(e.html));
  check('a done item is ticked and struck through', /✓<\/span><span style="text-decoration:line-through;">Verbs worksheet<\/span><span[^>]*> · Spanish · done/.test(e.html), e.html.slice(0, 0));
  check('an open one has a box and its class', /☐<\/span><span style="font-weight:bold;">Volcano &lt;b&gt;poster&lt;\/b&gt;<\/span><span[^>]*> · Science<\/span>/.test(e.html));
  check('titles are escaped, never markup', !e.html.includes('<b>poster</b>'));
  check('late items show Missing and their due date', e.html.includes('Lab report</span><span style="color:#9a3412;"> · Science · Missing · due Thu Nov 5'));
  check('a count shows how far it has got', e.html.includes('Math topics</span><span style="color:#5f574c;"> · Math · 5 of 7 · due Mon Nov 16'));
  check('no links of any kind', !/href=|<a\b|src=/i.test(e.html));
  check('one kid: no name heading', !e.html.includes('<h2'));
  check('the text part has the same lists', e.text.includes('Due tomorrow, Sat Nov 14\n[x] Verbs worksheet · Spanish · done\n[ ] Volcano <b>poster</b> · Science')
    && e.text.includes('[ ] Lab report · Science · Missing · due Thu Nov 5') && e.text.includes('[ ] Math topics · Math · 5 of 7 · due Mon Nov 16'), e.text);
  const n = renderDue(empty(), { language: 'en' });
  check('nothing due: it says so, in the subject and the body, and still goes', n.subject === 'Nothing due tomorrow (Sat Nov 14)' && n.html.includes('Nothing due tomorrow.')
    && !n.html.includes('Not marked done yet') && !n.html.includes('Coming up'));
  const all = renderDue({ ...list(), kids: [{ ...list().kids[0], tomorrow: [list().kids[0].tomorrow[0]] }] }, { language: 'en' });
  check('everything due tomorrow already done: "Nothing due" in the subject, the done one still listed', all.subject === 'Nothing due tomorrow (Sat Nov 14)' && all.html.includes('Verbs worksheet'));
  const es = renderDue(list('es'), { language: 'es' });
  check('in Spanish: the fixed words and the days', es.subject === 'Para mañana (sáb 14 nov): 1 de Jordan' && es.html.includes('Sin marcar como hecho')
    && es.html.includes('Falta') && es.html.includes('Próximamente, hasta el mar 17 nov') && es.html.includes('5 de 7'));
  const two = renderDue({ ...list(), kids: [list().kids[0], { id: TAYLOR, name: 'Taylor', tomorrow: [{ title: 'Spelling', due: '2026-11-14', due_label: 'Sat Nov 14' }], late: [], coming: [] }] }, { language: 'en' });
  check('two kids: a heading each, and both in the subject', two.subject === 'Due tomorrow (Sat Nov 14): 1 for Jordan, 1 for Taylor' && two.html.includes('>Jordan</h2>') && two.html.includes('>Taylor</h2>'));
  const none = renderDue({ ...list(), kids: [] }, { language: 'en' });
  check('nobody with homework on: says so', none.html.includes('Nobody has homework turned on.'));
}

// ---------------------------------------------------------------------
// The run and the preview, with a fake database
// ---------------------------------------------------------------------
function fakeDb(who: string, st: any) {
  return {
    rpc: async (fn: string, args?: any) => {
      st.calls.push({ who, fn, args });
      if (st.failRpc[fn]) return { data: null, error: st.failRpc[fn] };
      const h = st.rpc[fn];
      if (!h) return { data: null, error: { message: `Could not find the function public.${fn}`, code: 'PGRST202' } };
      return { data: await h(args, who), error: null };
    },
    from: (table: string) => {
      const q: any = { table, op: 'select', row: null, filters: [] as any[], mode: 'many' };
      const api: any = {
        select() { if (q.op !== 'select') q.returning = true; return api; },
        insert(row: any) { q.op = 'insert'; q.row = row; return api; },
        update(row: any) { q.op = 'update'; q.row = row; return api; },
        delete() { q.op = 'delete'; return api; },
        eq(c: string, v: any) { q.filters.push([c, 'eq', v]); return api; },
        lt(c: string, v: any) { q.filters.push([c, 'lt', v]); return api; },
        gt(c: string, v: any) { q.filters.push([c, 'gt', v]); return api; },
        gte(c: string, v: any) { q.filters.push([c, 'gte', v]); return api; },
        order() { return api; }, limit() { return api; },
        single() { q.mode = 'single'; return api; },
        maybeSingle() { q.mode = 'maybe'; return api; },
        then(ok: any, bad: any) { return run().then(ok, bad); },
      };
      async function run() {
        st.ops.push({ table, op: q.op, row: q.row, who });
        const rows = (st.tables[table] ||= []);
        let data: any[];
        if (q.op === 'insert') { const r = { id: `run-${rows.length + 1}`, ...q.row }; rows.push(r); data = [r]; }
        else {
          data = rows.filter((r: any) => q.filters.every(([c, op, v]: any) => (op === 'eq' ? r[c] === v : op === 'lt' ? r[c] < v : op === 'gt' ? r[c] > v : r[c] >= v)));
          if (q.op === 'update') data.forEach((r) => Object.assign(r, q.row));
          if (q.op === 'delete') st.tables[table] = rows.filter((r: any) => !data.includes(r));
        }
        if (q.mode === 'single') return { data: data[0] ?? null, error: data.length === 1 ? null : { message: 'not one row' } };
        if (q.mode === 'maybe') return { data: data[0] ?? null, error: null };
        return { data: q.op === 'select' || q.returning ? data : null, error: null };
      }
      return api;
    },
  };
}
type Opts = { schema?: number; dueDue?: any[] | null; people?: any[]; budget?: number; failRpc?: Record<string, any>; me?: any; listFor?: (a: any) => any };
function setup(o: Opts = {}) {
  const st: any = {
    calls: [] as any[], ops: [] as any[], failRpc: o.failRpc ?? {},
    tables: {
      job_runs: [], notification_log: [], members: [{ email: 'alex@example.com' }],
      household: [{ id: true, weekly_at: null, weekly_to: [], weekly_sheets: [], due_at: '17:30:00', due_to: [ALEX, SAM, JORDAN] }],
      people: o.people ?? [
        { id: ALEX, name: 'Alex', email: 'alex@example.com', language: 'en', active: true, email_verified_at: '2026-10-01T00:00:00Z' },
        { id: SAM, name: 'Sam', email: 'sam@example.com', language: 'es', active: true, email_verified_at: '2026-10-01T00:00:00Z' },
        { id: JORDAN, name: 'Jordan', email: 'jordan@example.com', language: 'en', active: true, email_verified_at: null },
      ],
    },
    rpc: {
      roll_missed_tasks: () => 0,
      hub_schema_version: () => o.schema ?? 29,
      digest_due: () => [],
      weekly_due: () => [],
      email_budget_left: () => o.budget ?? 60,
      claim_notification: (a: any) => `claim-${a.p_kind}-${a.p_person}`,
      finish_notification: () => null,
      today_local: () => DAY,
      whoami: () => ('me' in o ? o.me : { email: 'alex@example.com', role: 'admin', person: { id: ALEX, language: 'en' } }),
      due_list: (a: any) => (o.listFor ? o.listFor(a) : list(a.p_lang)),
    } as Record<string, any>,
  };
  if (o.dueDue !== null) st.rpc.due_due = () => o.dueDue ?? [{ person_id: ALEX, local_date: DAY, kind: 'due' }, { person_id: SAM, local_date: DAY, kind: 'due' }];
  const sent: any[] = [];
  const deps = {
    env: (k: string) => ({ HUB_CRON_SECRET: SECRET, SITE_URL: 'https://family.example/hub/', RESEND_API_KEY: 're_test', EMAIL_FROM: 'home@family.example',
                           SUPABASE_URL: 'https://project.example', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}' } as Record<string, string>)[k],
    now: () => Date.parse('2026-11-13T22:30:00Z'),
    sleep: async () => {},
    fetch: (async (url: string, init: any) => {
      if (url === 'https://api.resend.com/emails') { sent.push({ body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] }); return new Response(`{"id":"email-${sent.length}"}`); }
      return new Response('unexpected', { status: 500 });
    }) as any,
    service: () => fakeDb('service', st),
    user: (auth: string) => fakeDb(`user:${auth}`, st),
  };
  const rpcs = (fn: string) => st.calls.filter((c: any) => c.fn === fn);
  return { deps, st, sent, rpcs };
}
const cron = () => new Request('https://project.example/functions/v1/hub-jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-cron': SECRET }, body: '{"action":"digest"}' });
const asUser = (body: unknown, auth: string | null = 'Bearer admin-jwt') => new Request('https://project.example/functions/v1/hub-jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });

(async () => {
  let s = setup();
  let res = await handle(cron(), s.deps);
  let out = await res.json();
  check('the run sends Due tomorrow to each person due_due names', res.status === 200 && out.ok === true && out.sent === 2 && s.sent.length === 2, JSON.stringify(out));
  check('... claimed as kind due for the day', JSON.stringify(s.rpcs('claim_notification').map((c: any) => c.args))
    === JSON.stringify([{ p_person: ALEX, p_local_date: DAY, p_kind: 'due' }, { p_person: SAM, p_local_date: DAY, p_kind: 'due' }]));
  check('... the lists read for that day in each recipient\'s language', JSON.stringify(s.rpcs('due_list').map((c: any) => c.args))
    === JSON.stringify([{ p_day: DAY, p_lang: 'en' }, { p_day: DAY, p_lang: 'es' }]));
  check('... to each address, with a key for that person and day (no second email on a retry)',
    s.sent[0].body.to[0] === 'alex@example.com' && s.sent[1].body.to[0] === 'sam@example.com'
    && s.sent[0].key === `due-${ALEX}-${DAY}` && s.sent[1].key === `due-${SAM}-${DAY}`);
  check('... in each recipient\'s language', s.sent[0].body.subject === 'Due tomorrow (Sat Nov 14): 1 for Jordan' && s.sent[1].body.subject === 'Para mañana (sáb 14 nov): 1 de Jordan');
  check('... after the morning emails and the Sunday sheets, in the same run', s.st.tables.job_runs.length === 1
    && s.st.calls.findIndex((c: any) => c.fn === 'weekly_due') < s.st.calls.findIndex((c: any) => c.fn === 'due_due'));
  s = setup({ dueDue: [{ person_id: JORDAN, local_date: DAY, kind: 'due' }] });
  await handle(cron(), s.deps);
  check('an address not confirmed (by the time it sends): skipped, nothing sent', s.sent.length === 0
    && s.rpcs('finish_notification')[0]?.args.p_status === 'skipped' && s.rpcs('finish_notification')[0]?.args.p_detail === 'The address isn\'t confirmed.');
  s = setup({ listFor: () => empty() });
  await handle(cron(), s.deps);
  check('nothing due: it still goes ("Nothing due tomorrow")', s.sent.length === 2 && s.sent[0].body.subject === 'Nothing due tomorrow (Sat Nov 14)');
  s = setup({ failRpc: { due_list: { message: 'boom' } } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('lists that can\'t be read: that email failed (the run says so), nothing sent', s.sent.length === 0 && out.failed === 2 && out.ok === false
    && s.rpcs('finish_notification')[0]?.args.p_detail === 'due_list: boom');
  s = setup({ budget: 0 });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('no email budget left: stops before claiming', s.sent.length === 0 && out.stop === 'budget' && s.rpcs('claim_notification').length === 0);
  s = setup({ schema: 28 });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('on schema 28: due_due isn\'t asked for at all, and the run is as it was', res.status === 200 && out.ok === true && s.sent.length === 0 && s.rpcs('due_due').length === 0);
  s = setup({ dueDue: null });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('due_due missing (schema says 29, the function isn\'t there yet): the run as it was', res.status === 200 && out.ok === true && s.sent.length === 0);
  s = setup({ failRpc: { due_due: { message: 'permission denied for function due_due', code: '42501' } } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('due_due failing for another reason stops the run as an error', res.status === 500 && out.stop === 'error' && String(out.error).startsWith('due_due:'));

  // due_preview: admins only, nothing sent or logged.
  s = setup();
  res = await handle(asUser({ action: 'due_preview' }, null), s.deps);
  check('due_preview without a sign-in → 401', res.status === 401);
  s = setup({ me: { email: 'sam@example.com', role: 'member', person: { id: SAM } } });
  res = await handle(asUser({ action: 'due_preview' }), s.deps);
  check('due_preview for a member who isn\'t an admin → 403', res.status === 403 && s.rpcs('due_list').length === 0);
  s = setup();
  res = await handle(asUser({ action: 'due_preview' }), s.deps);
  out = await res.json();
  check('due_preview: this evening\'s email in the admin\'s language, and who it goes to (and who wouldn\'t)', res.status === 200 && out.day === DAY
    && out.subject === 'Due tomorrow (Sat Nov 14): 1 for Jordan' && out.html.includes('Volcano') && out.at === '17:30:00'
    && JSON.stringify(out.to.map((t: any) => [t.name, t.would_send, t.reason])) === JSON.stringify([['Alex', true, null], ['Sam', true, null], ['Jordan', false, 'unconfirmed']]),
    JSON.stringify(out).slice(0, 300));
  check('... nothing sent or logged', s.sent.length === 0 && s.rpcs('claim_notification').length === 0 && s.st.tables.notification_log.length === 0);
  s = setup({ failRpc: { due_list: { message: 'Could not find the function public.due_list', code: 'PGRST202' } } });
  res = await handle(asUser({ action: 'due_preview' }), s.deps);
  out = await res.json();
  check('due_preview before migration 0029 → 503 no_schema', res.status === 503 && out.stop === 'no_schema');

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
