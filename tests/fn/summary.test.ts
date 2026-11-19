// Unit tests for the Sunday summary (docs/v1.3-homework.md §35): supabase/functions/hub-jobs/summary.ts (the email) and
// its parts of handler.ts (the run sends it; summary_preview shows it), with a fake database, Resend and clock. The
// summaries below have the shape public.tutor_summary returns (tests/db/tutor_summary.test.sql checks the SQL); everyone
// in them is made up.
// Run alone with: node --experimental-strip-types tests/fn/summary.test.ts
import { handle } from '../../supabase/functions/hub-jobs/handler.ts';
import { renderSummary } from '../../supabase/functions/hub-jobs/summary.ts';
import type { Summary } from '../../supabase/functions/hub-jobs/summary.ts';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`);

const SECRET = '9f1c2e7a4b6d8e0f1a3c5e7b9d2f4a6c8e0b';
const ALEX = 'aaaaaaaa-0000-4000-8000-000000000001';
const LINK = 'bbbbbbbb-0000-4000-8000-000000000001';
const LINK2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const WEEK = '2026-11-09';

const summary = (lang = 'en', to = 'pat@example.com'): Summary => ({
  to, language: lang, label: 'Pat Lee, tutor', kid: 'Jordan <b>',
  week: {
    this: { from: '2026-11-09', to: '2026-11-15', assigned: 12, done: 10, on_time: 8, reminders: 3, started: 9, started_unprompted: 6,
            avg_minutes_to_start: 14, avg_minutes_to_finish: 22, points: 85 },
    last: { from: '2026-11-02', to: '2026-11-08', assigned: 11, done: 7, on_time: 5, reminders: 9, started: 2, started_unprompted: 0,
            avg_minutes_to_start: null, avg_minutes_to_finish: null, points: 40 },
  },
});

// ---------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------
{
  const e = renderSummary(summary());
  check('subject: the kid, done of due, and starts with no reminder', e.subject === "Jordan <b>'s week: 10 of 12 tasks done, 6 started with no reminder", e.subject);
  check('greets the tutor by first name', e.html.includes('Hi Pat,') && e.text.startsWith('Hi Pat,'));
  check('a row each, this week then last week', /Tasks due<\/th><td[^>]*>12<\/td><td[^>]*>11<\/td>/.test(e.html)
    && /Started with no reminder<\/th><td[^>]*>6<\/td><td[^>]*>0<\/td>/.test(e.html) && /Points earned<\/th><td[^>]*>85<\/td><td[^>]*>40<\/td>/.test(e.html));
  check('minutes as "14 min", and a dash when there is none', /From the task&#39;s time to Start<\/th><td[^>]*>14 min<\/td><td[^>]*>—<\/td>/.test(e.html)
    || /From the task's time to Start<\/th><td[^>]*>14 min<\/td><td[^>]*>—<\/td>/.test(e.html), e.html.slice(e.html.indexOf('From the task'), e.html.indexOf('From the task') + 160));
  check('names are escaped, never markup', !e.html.includes('Jordan <b>') && e.html.includes('Jordan &lt;b&gt;'));
  check('no links of any kind (never the tutor link)', !/href=|<a\b|src=|https?:|day\.html/i.test(e.html) && !/https?:|day\.html/.test(e.text));
  check('the text part has the same rows', e.text.includes('Tasks due') && /Done on time\s+8 \| 5/.test(e.text) && /From Start to done\s+22 min \| —/.test(e.text), e.text);
  const es = renderSummary(summary('es'));
  check('in Spanish: the link\'s language', es.subject === 'La semana de Jordan <b>: 10 de 12 tareas hechas, 6 empezadas sin recordatorio'
    && es.html.includes('Hola, Pat:') && es.html.includes('Esta semana') && es.html.includes('Empezadas sin recordatorio'));
  const bare = renderSummary({ to: 'x@example.com', language: 'en', label: 'Riley', kid: 'Sam', week: { this: {}, last: {} } } as Summary);
  check('missing numbers read 0 and —, never "undefined"', bare.subject === "Sam's week: 0 of 0 tasks done, 0 started with no reminder"
    && !bare.html.includes('undefined') && !bare.text.includes('NaN'));
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
type Opts = { schema?: number; summaryDue?: any[] | null; budget?: number; failRpc?: Record<string, any>; me?: any; sumFor?: (a: any) => any };
function setup(o: Opts = {}) {
  const st: any = {
    calls: [] as any[], ops: [] as any[], failRpc: o.failRpc ?? {},
    tables: { job_runs: [], notification_log: [], members: [{ email: 'alex@example.com' }], people: [] },
    rpc: {
      roll_missed_tasks: () => 0,
      hub_schema_version: () => o.schema ?? 35,
      digest_due: () => [], weekly_due: () => [], due_due: () => [],
      email_budget_left: () => o.budget ?? 60,
      summary_claim: (a: any) => `claim-${a.p_link}`,
      summary_finish: () => null,
      whoami: () => ('me' in o ? o.me : { email: 'alex@example.com', role: 'admin', person: { id: ALEX, language: 'en' } }),
      tutor_summary: (a: any) => (o.sumFor ? o.sumFor(a) : summary(a.p_link === LINK2 ? 'es' : 'en', a.p_link === LINK2 ? 'riley@example.com' : 'pat@example.com')),
    } as Record<string, any>,
  };
  if (o.summaryDue !== null) st.rpc.summary_due = () => o.summaryDue ?? [{ link_id: LINK, week: WEEK }, { link_id: LINK2, week: WEEK }];
  const sent: any[] = [];
  const deps = {
    env: (k: string) => ({ HUB_CRON_SECRET: SECRET, SITE_URL: 'https://family.example/hub/', RESEND_API_KEY: 're_test', EMAIL_FROM: 'home@family.example',
                           SUPABASE_URL: 'https://project.example', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}' } as Record<string, string>)[k],
    now: () => Date.parse('2026-11-15T22:30:00Z'),
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
  check('the run sends a summary to each link summary_due names', res.status === 200 && out.ok === true && out.sent === 2 && s.sent.length === 2, JSON.stringify(out));
  check('... to the link\'s address, in the link\'s language', s.sent[0].body.to[0] === 'pat@example.com' && s.sent[0].body.subject.startsWith("Jordan <b>'s week")
    && s.sent[1].body.to[0] === 'riley@example.com' && s.sent[1].body.subject.startsWith('La semana de'));
  check('... one idempotency key per link and week', s.sent[0].key === `summary-${LINK}-${WEEK}` && s.sent[1].key === `summary-${LINK2}-${WEEK}`);
  check('... each claimed, then finished as sent with Resend\'s id', s.rpcs('summary_claim').length === 2
    && JSON.stringify(s.rpcs('summary_finish').map((c: any) => [c.args.p_id, c.args.p_status, c.args.p_detail]))
       === JSON.stringify([[`claim-${LINK}`, 'sent', 'Resend email-1'], [`claim-${LINK2}`, 'sent', 'Resend email-2']]));
  check('... after Due tomorrow', s.st.calls.findIndex((c: any) => c.fn === 'due_due') < s.st.calls.findIndex((c: any) => c.fn === 'summary_due'));
  check('... and never through notification_log', s.rpcs('claim_notification').length === 0);

  s = setup({ sumFor: (a: any) => (a.p_link === LINK ? null : summary('es', 'riley@example.com')) });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('a link that no longer gets one (tutor_summary null): skipped, the other still sent', out.sent === 1 && out.skipped === 1 && s.sent.length === 1
    && s.rpcs('summary_finish')[0].args.p_status === 'skipped');
  s = setup();
  s.st.rpc.summary_claim = (a: any) => (a.p_link === LINK ? null : `claim-${a.p_link}`);
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('a claim refused (in flight elsewhere, or sent): busy, not sent', out.busy === 1 && out.sent === 1 && s.sent.length === 1);
  s = setup({ budget: 0 });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('no email budget left: stops before claiming', s.sent.length === 0 && out.stop === 'budget' && s.rpcs('summary_claim').length === 0);
  s = setup({ schema: 34 });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('on schema 34: summary_due isn\'t asked for at all, and the run is as it was', res.status === 200 && out.ok === true && s.sent.length === 0 && s.rpcs('summary_due').length === 0);
  s = setup({ summaryDue: null });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('summary_due missing (schema says 35, the function isn\'t there yet): the run as it was', res.status === 200 && out.ok === true && s.sent.length === 0);
  s = setup({ failRpc: { summary_due: { message: 'permission denied for function summary_due', code: '42501' } } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('summary_due failing for another reason stops the run as an error', res.status === 500 && out.stop === 'error' && String(out.error).startsWith('summary_due:'));

  // summary_preview: admins only, nothing sent or logged.
  s = setup();
  res = await handle(asUser({ action: 'summary_preview', link: LINK }, null), s.deps);
  check('summary_preview without a sign-in → 401', res.status === 401);
  s = setup({ me: { email: 'sam@example.com', role: 'member', person: { id: 'x' } } });
  res = await handle(asUser({ action: 'summary_preview', link: LINK }), s.deps);
  check('summary_preview for a member who isn\'t an admin → 403', res.status === 403 && s.rpcs('tutor_summary').length === 0);
  s = setup();
  res = await handle(asUser({ action: 'summary_preview', link: 'nope' }), s.deps);
  check('summary_preview without a link id → 400', res.status === 400);
  s = setup();
  res = await handle(asUser({ action: 'summary_preview', link: LINK }), s.deps);
  out = await res.json();
  check('summary_preview: the email as it would go now, and to whom', res.status === 200 && out.to === 'pat@example.com'
    && out.subject.startsWith("Jordan <b>'s week") && out.html.includes('Tasks due') && typeof out.text === 'string', JSON.stringify(out).slice(0, 200));
  check('... nothing sent or logged', s.sent.length === 0 && s.rpcs('summary_claim').length === 0);
  s = setup({ sumFor: () => null });
  res = await handle(asUser({ action: 'summary_preview', link: LINK }), s.deps);
  out = await res.json();
  check('summary_preview for a link that gets none → 409, saying why', res.status === 409 && /coach view on and an address/.test(out.error));
  s = setup({ failRpc: { tutor_summary: { message: 'Could not find the function public.tutor_summary', code: 'PGRST202' } } });
  res = await handle(asUser({ action: 'summary_preview', link: LINK }), s.deps);
  out = await res.json();
  check('summary_preview before migration 0035 → 503 no_schema', res.status === 503 && out.stop === 'no_schema');

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
