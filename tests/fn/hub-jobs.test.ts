// Unit tests for supabase/functions/hub-jobs (handler.ts, render.ts) with a fake database, Resend and clock.
// The RPC fakes return the shapes the SQL API returns (digest_for's JSON below is real output of
// digest_for on the tests/db fixture household, with fixed ids).
// Run alone with: node --experimental-strip-types tests/fn/hub-jobs.test.ts
import { handle, sameSecret, serviceKey, BATCH, KEEP_RUNS_DAYS, SEND_GAP_MS } from '../../supabase/functions/hub-jobs/handler.ts';
import { renderDigest, renderConfirm, phoneDigits, siteBase, oneLine, esc } from '../../supabase/functions/hub-jobs/render.ts';
import { readFileSync, readdirSync } from 'node:fs';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`);

// ---------------------------------------------------------------------
// Fixtures (fictional)
// ---------------------------------------------------------------------
const SECRET = '9f1c2e7a4b6d8e0f1a3c5e7b9d2f4a6c8e0b'; // 36 characters
const SITE = 'https://family.example/hub/';
const ALEX = 'aaaaaaaa-0000-4000-8000-000000000001';
const SAM = 'aaaaaaaa-0000-4000-8000-000000000002';
const TAYLOR = 'aaaaaaaa-0000-4000-8000-000000000003';
const MORGAN = 'aaaaaaaa-0000-4000-8000-000000000004';
const ROBIN = 'aaaaaaaa-0000-4000-8000-000000000005';
const TOKEN = { alex: '50e0ca21719596eba0cb4e56ba627011', sam: 'e30ca6f8dca39d69a0e6d8f972624d7c', morgan: '02b1b267138b2534efe7b7b9ea5af359' };
const CONFIRM_MORGAN = '1301bac5556966eacfafbef1224e8bb1';
const DAY = '2026-11-09';
const NOW = Date.parse('2026-11-09T11:30:00Z'); // 6:30am in New York

const labelsEn = {
  late: 'Late', inbox: null, today: 'Today', nobody: "Nobody's on it", heads_up: 'Heads-up', projects: 'Projects',
  tomorrow: 'Tomorrow', late_more: null, send_text: 'Text', their_day: 'Their day', nobody_more: null,
  open_my_day: 'Open my day', stop_emails: 'Stop these emails', send_whatsapp: 'WhatsApp', nothing_planned: 'Nothing planned',
};
const item = (kind: string, time: string | null, title: string, detail: string | null = null, status = 'open', occurrence = DAY, phone: string | null = null) =>
  ({ kind, time, title, detail, status, item_id: 'bbbbbbbb-0000-4000-8000-' + String(title.length).padStart(12, '0'), occurrence, contractor_phone: phone });

const TAYLOR_TEXT = 'Taylor · Mon Nov 9\n3:00pm Pick up Taylor · Morgan\n4:00pm Piano · Morgan · Rivera Music 555-0150\n☐ Trash\nLate:\n☐ Feed fish (Nov 5)';
const alexDigest = () => ({
  late: [item('task', null, 'Renew passport', 'due Nov 1', 'late', '2026-11-01'), item('task', null, 'Return library books', 'due Nov 2', 'late', '2026-11-02'),
    item('task', null, 'Call bank', 'due Nov 3', 'late', '2026-11-03')],
  empty: false,
  today: [item('event', '8:00am', 'Drop off dogs'), item('event', '10:00am', 'Team call'), item('task', null, 'Pay water bill')],
  labels: { ...labelsEn, inbox: 'Inbox: 2 tasks with no date', late_more: 'and 1 more' },
  nobody: [item('event', 'All day', 'Recital'), item('task', null, 'Book flights'), item('task', null, 'Clean gutters', 'due Nov 6', 'late', '2026-11-06')],
  people: [
    { name: 'Taylor', role: 'kid', text: TAYLOR_TEXT, count: 3, phone: '(201) 555-0103', language: 'en', person_id: TAYLOR },
    { name: 'Morgan', role: 'helper', text: 'Morgan · lun 9 nov\n15:00 Pick up Taylor · con Taylor\n16:00 Piano · con Taylor · Rivera Music 555-0150\n☐ Asunto privado', count: 3, phone: '555-0104', language: 'es', person_id: MORGAN },
    { name: 'Robin', role: 'kid', text: 'Robin · Mon Nov 9\nNothing planned', count: 0, phone: null, language: 'en', person_id: ROBIN },
  ],
  subject: 'Mon Nov 9: 8:00am Drop off dogs · 10:00am Team call · +1',
  heads_up: [item('event', 'Tomorrow 7:30am', 'Early meeting', null, 'open', '2026-11-10'), item('task', null, 'Vet visit', 'due Nov 12', 'open', '2026-11-12'),
    item('contract', null, 'City Water', 'contract ends Nov 30', 'open', '2026-11-30', '555-0160')],
  projects: [{ name: 'Kitchen', text: 'Kitchen: Inspection; Wire starts (Pat Lee 555-0100)', project_id: 'cccccccc-0000-4000-8000-000000000001',
    items: [{ title: 'Inspection', milestone: true, contractor_name: null, contractor_phone: null }, { title: 'Wire', milestone: false, contractor_name: 'Pat Lee', contractor_phone: '555-0100' }] }],
  late_more: 1,
  recipient: { id: ALEX, name: 'Alex', role: 'parent', email: 'alex@example.com', language: 'en', day_token: TOKEN.alex },
  date_label: 'Mon Nov 9',
  local_date: DAY,
  inbox_count: 2,
  nobody_more: 0,
});
const samDigest = () => ({
  late: [], empty: false, today: [item('event', '9:00am', 'Dentist')], labels: { ...labelsEn }, nobody: [], people: [],
  subject: 'Mon Nov 9: 9:00am Dentist', heads_up: [], projects: [], late_more: 0,
  recipient: { id: SAM, name: 'Sam', role: 'adult', email: 'sam@example.com', language: 'en', day_token: TOKEN.sam },
  date_label: 'Mon Nov 9', local_date: DAY, inbox_count: null, nobody_more: 0,
});
const morganDigest = () => ({
  late: [], empty: false,
  today: [item('event', '15:00', 'Pick up Taylor', 'con Taylor'), item('event', '16:00', 'Piano', 'con Taylor · Rivera Music', 'open', DAY, '555-0150'),
    item('task', null, 'Asunto privado')],
  labels: { late: 'Atrasado', inbox: null, today: 'Hoy', nobody: 'Sin responsable', heads_up: 'Atención', projects: 'Proyectos', tomorrow: 'Mañana',
    late_more: null, send_text: 'Mensaje', their_day: 'Su día', nobody_more: null, open_my_day: 'Abrir mi día', stop_emails: 'No enviar más correos',
    send_whatsapp: 'WhatsApp', nothing_planned: 'Nada planeado' },
  nobody: [], people: [], subject: 'lun 9 nov: 15:00 Pick up Taylor · 16:00 Piano · +1', heads_up: [], projects: [], late_more: 0,
  recipient: { id: MORGAN, name: 'Morgan', role: 'helper', email: 'morgan@example.com', language: 'es', day_token: TOKEN.morgan },
  date_label: 'lun 9 nov', local_date: DAY, inbox_count: null, nobody_more: 0,
});
const emptyMorgan = () => ({ ...morganDigest(), today: [], empty: true, subject: 'lun 9 nov: Nada planeado' });

const peopleRows = () => [
  { id: ALEX, name: 'Alex', role: 'parent', email: 'alex@example.com', email_verified_at: '2026-11-01T00:00:00+00:00', language: 'en', day_token: TOKEN.alex, active: true, digest_enabled: true, digest_day: 'today', sort_order: 0 },
  { id: SAM, name: 'Sam', role: 'adult', email: 'sam@example.com', email_verified_at: '2026-11-01T00:00:00+00:00', language: 'en', day_token: TOKEN.sam, active: true, digest_enabled: true, digest_day: 'tomorrow', sort_order: 1 },
  { id: TAYLOR, name: 'Taylor', role: 'kid', email: null, email_verified_at: null, language: 'en', day_token: 'c7001058125646228717857469661650', active: true, digest_enabled: false, digest_day: 'today', sort_order: 3 },
  { id: MORGAN, name: 'Morgan', role: 'helper', email: 'morgan@example.com', email_verified_at: null, language: 'es', day_token: TOKEN.morgan, active: true, digest_enabled: true, digest_day: 'today', sort_order: 4 },
];

// ---------------------------------------------------------------------
// A fake supabase-js: rpc() and chained table queries over in-memory rows.
// ---------------------------------------------------------------------
type Call = { who: string; fn: string; args: any };
function fakeDb(who: string, st: any) {
  return {
    rpc: async (fn: string, args?: any) => {
      st.calls.push({ who, fn, args });
      if (st.failRpc[fn]) return { data: null, error: { message: st.failRpc[fn] } };
      const h = st.rpc[fn];
      if (!h) return { data: null, error: { message: `Could not find the function public.${fn}` } };
      return { data: await h(args, who), error: null };
    },
    from: (table: string) => {
      const q: any = { table, who, op: 'select', row: null, filters: [] as any[], orders: [] as any[], limit: null, mode: 'many', returning: false };
      const api: any = {
        select() { if (q.op === 'select') q.cols = arguments[0]; else q.returning = true; return api; },
        insert(row: any) { q.op = 'insert'; q.row = row; return api; },
        update(row: any) { q.op = 'update'; q.row = row; return api; },
        delete() { q.op = 'delete'; return api; },
        eq(c: string, v: any) { q.filters.push([c, 'eq', v]); return api; },
        gt(c: string, v: any) { q.filters.push([c, 'gt', v]); return api; },
        lt(c: string, v: any) { q.filters.push([c, 'lt', v]); return api; },
        gte(c: string, v: any) { q.filters.push([c, 'gte', v]); return api; },
        order(c: string, o?: any) { q.orders.push([c, o?.ascending !== false]); return api; },
        limit(n: number) { q.limit = n; return api; },
        single() { q.mode = 'single'; return api; },
        maybeSingle() { q.mode = 'maybe'; return api; },
        then(ok: any, bad: any) { return run().then(ok, bad); },
      };
      const match = (r: any) => q.filters.every(([c, op, v]: any) => (op === 'eq' ? r[c] === v : op === 'gt' ? r[c] > v : op === 'gte' ? r[c] >= v : r[c] < v));
      async function run() {
        st.ops.push(q);
        if (st.failTable[`${table}.${q.op}`]) return { data: null, error: { message: st.failTable[`${table}.${q.op}`] } };
        const rows = (st.tables[table] ||= []);
        let data: any[];
        if (q.op === 'insert') { const r = { id: `run-${rows.length + 1}`, ...q.row }; rows.push(r); data = [r]; }
        else {
          data = rows.filter(match);
          if (q.op === 'update') data.forEach((r) => Object.assign(r, q.row));
          if (q.op === 'delete') st.tables[table] = rows.filter((r: any) => !data.includes(r));
          if (q.op === 'select') {
            for (const [c, asc] of [...q.orders].reverse()) data.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
            if (q.limit != null) data = data.slice(0, q.limit);
            data = data.map((r) => ({ ...r }));
          }
        }
        if (q.mode === 'single') return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
        if (q.mode === 'maybe') return { data: data[0] ?? null, error: null };
        return { data: q.op === 'select' || q.returning ? data : null, error: null };
      }
      return api;
    },
  };
}

type Opts = {
  env?: Record<string, string | undefined>;
  due?: { person_id: string; local_date: string; kind: string }[];
  digests?: Record<string, any>;
  budget?: number[];
  claims?: Record<string, string | null>;
  resend?: (n: number) => { status: number; body: string; headers?: Record<string, string> } | Error;
  idempotent?: boolean;   // Resend with its documented Idempotency-Key rules (see idempotentResend)
  failRpc?: Record<string, string>;
  failTable?: Record<string, string>;
  me?: any;
  tables?: Record<string, any[]>;
  today?: string;
  now?: number;
};
function setup(o: Opts = {}) {
  const env: Record<string, string | undefined> = {
    HUB_CRON_SECRET: SECRET, SITE_URL: SITE, RESEND_API_KEY: 're_test', EMAIL_FROM: 'home@family.example',
    SUPABASE_URL: 'https://project.example', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}', HEALTHCHECK_URL: 'https://health.example/ping/abc',
    ...o.env,
  };
  const due = o.due ?? [
    { kind: 'confirm', person_id: MORGAN, local_date: DAY },
    { kind: 'digest', person_id: ALEX, local_date: DAY },
    { kind: 'digest', person_id: SAM, local_date: DAY },
  ];
  const digests: Record<string, any> = o.digests ?? { [ALEX]: alexDigest(), [SAM]: samDigest(), [MORGAN]: morganDigest() };
  const budget = o.budget ? [...o.budget] : null;
  let claimN = 0;
  const st: any = {
    calls: [] as Call[], ops: [] as any[], failRpc: o.failRpc ?? {}, failTable: o.failTable ?? {},
    tables: {
      people: peopleRows(),
      people_confirm: [{ person_id: MORGAN, token: CONFIRM_MORGAN, created_at: '2026-11-08T12:00:00+00:00' }],
      // Who can sign in (v1's members table): Alex (admin) and Sam (member). Morgan and Taylor can't.
      members: [{ email: 'alex@example.com', name: 'Alex Example', role: 'admin' }, { email: 'sam@example.com', name: 'Sam Example', role: 'member' }],
      job_runs: [],
      notification_log: [],
      ...o.tables,
    },
    rpc: {
      roll_missed_tasks: () => 2,
      digest_due: (a: any) => due.slice(0, a?.p_limit ?? 50),
      email_budget_left: () => (budget ? (budget.length > 1 ? budget.shift() : budget[0]) : 60),
      claim_notification: (a: any) => {
        const key = `${a.p_kind}-${a.p_person}`;
        if (o.claims && key in o.claims) return o.claims[key];
        return `dddddddd-0000-4000-8000-${String(++claimN).padStart(12, '0')}`;
      },
      finish_notification: () => null,
      digest_for: (a: any) => digests[a.p_person] ?? null,
      today_local: () => o.today ?? DAY,
      whoami: () => ('me' in o ? o.me : { email: 'alex@example.com', name: 'Alex Example', role: 'admin', created_at: '2026-01-01T00:00:00+00:00',
        person: { id: ALEX, name: 'Alex', role: 'parent', language: 'en', color: '#9333ea' } }),
    },
  };
  const resendCalls: { url: string; init: any; body: any }[] = [];
  const pings: { url: string; init: any }[] = [];
  const failPings: { url: string; init: any }[] = [];
  const resendState = { keys: new Map<string, { body: string; reply: { status: number; body: string } }>(), delivered: [] as any[], loseReply: 0 };
  const other: string[] = [];
  const sleeps: number[] = [];
  const deps = {
    env: (k: string) => env[k],
    now: () => o.now ?? NOW,
    sleep: async (ms: number) => { sleeps.push(ms); },
    fetch: (async (url: string, init: any) => {
      if (url === 'https://api.resend.com/emails') {
        resendCalls.push({ url, init, body: JSON.parse(init.body) });
        const r = o.idempotent ? idempotentResend(resendState, init) : o.resend ? o.resend(resendCalls.length) : { status: 200, body: `{"id":"email-${resendCalls.length}"}` };
        if (r instanceof Error) throw r;
        return new Response(r.body, { status: r.status, headers: r.headers });
      }
      if (url === env.HEALTHCHECK_URL) { pings.push({ url, init }); return new Response('OK'); }
      if (env.HEALTHCHECK_URL && url === `${env.HEALTHCHECK_URL}/fail`) { failPings.push({ url, init }); return new Response('OK'); }
      other.push(url);
      return new Response('unexpected', { status: 500 });
    }) as any,
    service: () => fakeDb('service', st),
    user: (auth: string) => fakeDb(`user:${auth}`, st),
  };
  const rpcs = (fn: string) => st.calls.filter((c: Call) => c.fn === fn);
  const finishes = () => rpcs('finish_notification').map((c: Call) => c.args);
  return { deps, st, env, resendCalls, pings, failPings, resendState, other, sleeps, rpcs, finishes, runs: () => st.tables.job_runs };
}

// Resend's documented Idempotency-Key rules (resend.com/docs/dashboard/emails/idempotency-keys):
// a key is kept for 24 hours; the same key with the same payload answers the first reply without
// sending again; the same key with a different payload answers 409 invalid_idempotent_request.
// st.loseReply > 0: Resend sends the email, but the reply never arrives (the request times out).
function idempotentResend(st: any, init: any): { status: number; body: string } | Error {
  const key = init.headers['Idempotency-Key'];
  const seen = st.keys.get(key);
  if (seen) {
    if (seen.body === init.body) return seen.reply;
    return { status: 409, body: '{"statusCode":409,"name":"invalid_idempotent_request","message":"Same idempotency key used with a different request payload."}' };
  }
  const reply = { status: 200, body: `{"id":"email-${st.delivered.length + 1}"}` };
  st.keys.set(key, { body: init.body, reply });
  st.delivered.push(JSON.parse(init.body));
  if (st.loseReply > 0) { st.loseReply--; return new Error('The signal has been aborted'); }
  return reply;
}

const cron = (body: unknown = { action: 'digest' }, secret: string | null = SECRET, extra: Record<string, string> = {}) =>
  new Request('https://project.example/functions/v1/hub-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret == null ? {} : { 'x-hub-cron': secret }), ...extra },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const asUser = (body: unknown, auth: string | null = 'Bearer admin-jwt', extra: Record<string, string> = {}) =>
  new Request('https://project.example/functions/v1/hub-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}), ...extra },
    body: JSON.stringify(body),
  });

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => unescape(m[1]));
const detailOf = (s: ReturnType<typeof setup>) => JSON.parse(s.runs()[0]?.detail || '{}');

(async () => {
  // -------------------------------------------------------------------
  // Who may call what
  // -------------------------------------------------------------------
  let s = setup();
  let res = await handle(cron({ action: 'digest' }, null), s.deps);
  check('digest without x-hub-cron → 401, nothing touched', res.status === 401 && s.st.calls.length === 0 && s.st.ops.length === 0 && s.resendCalls.length === 0, `status ${res.status}`);

  s = setup();
  res = await handle(new Request('https://project.example/functions/v1/hub-jobs', { method: 'POST' }), s.deps);
  check('bare POST (no body, no header) → 401 (the smoke check)', res.status === 401 && s.st.calls.length === 0, `status ${res.status}`);
  check('... with the function\'s own body {"error":"Not allowed."} (the gateway\'s 401, when verify_jwt is on, has a different one)',
    JSON.stringify(await res.json()) === '{"error":"Not allowed."}');

  s = setup();
  res = await handle(cron({ action: 'digest' }, SECRET.slice(0, -1) + (SECRET.endsWith('0') ? '1' : '0')), s.deps);
  check('wrong x-hub-cron (same length) → 401', res.status === 401 && s.st.calls.length === 0, `status ${res.status}`);
  res = await handle(cron({ action: 'digest' }, SECRET + 'x'), s.deps);
  const r2 = res.status;
  res = await handle(cron({ action: 'digest' }, SECRET.slice(0, 20)), s.deps);
  check('wrong x-hub-cron (longer, shorter) → 401', r2 === 401 && res.status === 401 && s.st.calls.length === 0, `${r2} ${res.status}`);

  s = setup({ env: { HUB_CRON_SECRET: undefined } });
  res = await handle(cron({ action: 'digest' }, SECRET), s.deps);
  check('HUB_CRON_SECRET missing → 503', res.status === 503 && (await res.json()).error.includes('HUB_CRON_SECRET') && s.st.calls.length === 0, `status ${res.status}`);
  s = setup({ env: { HUB_CRON_SECRET: 'short-secret-31-characters-long' } });
  res = await handle(cron({ action: 'digest' }, 'short-secret-31-characters-long'), s.deps);
  check('HUB_CRON_SECRET under 32 characters → 503 even when the header matches', res.status === 503 && s.st.calls.length === 0 && s.resendCalls.length === 0, `status ${res.status}`);
  s = setup({ env: { HUB_CRON_SECRET: '                                        ' } });
  res = await handle(cron({ action: 'digest' }, '                                        '), s.deps);
  check('a blank HUB_CRON_SECRET → 503', res.status === 503, `status ${res.status}`);

  s = setup();
  res = await handle(cron({ action: 'digest' }, null, { Authorization: 'Bearer admin-jwt' }), s.deps);
  check('a signed-in admin cannot run the digest without the cron secret → 401', res.status === 401 && s.st.calls.length === 0, `status ${res.status}`);

  s = setup();
  res = await handle(asUser({ action: 'preview' }, null), s.deps);
  check('preview without sign-in → 401', res.status === 401 && s.st.calls.length === 0, `status ${res.status}`);
  res = await handle(asUser({ action: 'preview' }, null, { 'x-hub-cron': SECRET }), s.deps);
  check('the cron secret does not open preview → 401', res.status === 401 && s.st.calls.length === 0, `status ${res.status}`);

  s = setup({ me: { email: 'sam@example.com', name: 'Sam Example', role: 'member', created_at: '2026-01-01T00:00:00+00:00', person: null } });
  res = await handle(asUser({ action: 'preview' }, 'Bearer member-jwt'), s.deps);
  check('preview as a non-admin member → 403, nothing rendered', res.status === 403 && s.rpcs('digest_for').length === 0, `status ${res.status}`);
  check('whoami is asked with the caller\'s own sign-in', s.rpcs('whoami')[0]?.who === 'user:Bearer member-jwt');
  res = await handle(asUser({ action: 'status' }, 'Bearer member-jwt'), s.deps);
  check('status as a non-admin member → 403', res.status === 403 && s.st.ops.length === 0, `status ${res.status}`);

  s = setup({ me: null });
  res = await handle(asUser({ action: 'preview' }, 'Bearer stranger-jwt'), s.deps);
  check('preview when whoami is null (not a member) → 403', res.status === 403 && s.rpcs('digest_for').length === 0, `status ${res.status}`);
  s = setup({ failRpc: { whoami: 'JWT expired' } });
  res = await handle(asUser({ action: 'status' }), s.deps);
  check('status when whoami fails → 403', res.status === 403, `status ${res.status}`);

  s = setup();
  res = await handle(new Request('https://project.example/functions/v1/hub-jobs', { method: 'GET' }), s.deps);
  check('GET → 405', res.status === 405);
  res = await handle(new Request('https://project.example/functions/v1/hub-jobs', { method: 'OPTIONS' }), s.deps);
  check('CORS preflight answered', res.status === 200 && res.headers.get('Access-Control-Allow-Origin') === '*');
  res = await handle(asUser({ action: 'send-everything' }), s.deps);
  check('unknown action → 400', res.status === 400 && s.st.calls.length === 0, `status ${res.status}`);

  check('sameSecret: equal / different / different length / empty',
    sameSecret(SECRET, SECRET) && !sameSecret(SECRET, SECRET.replace(/.$/, 'z')) && !sameSecret(SECRET + 'a', SECRET) && !sameSecret('', SECRET));
  check('service key from SUPABASE_SECRET_KEYS, else SUPABASE_SERVICE_ROLE_KEY',
    serviceKey((k) => ({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_a"}', SUPABASE_SERVICE_ROLE_KEY: 'legacy' } as any)[k]) === 'sb_secret_a'
    && serviceKey((k) => ({ SUPABASE_SECRET_KEYS: 'not json', SUPABASE_SERVICE_ROLE_KEY: 'legacy' } as any)[k]) === 'legacy'
    && serviceKey(() => undefined) === null);

  // -------------------------------------------------------------------
  // A normal run: a confirmation, a parent's digest, an adult's digest
  // -------------------------------------------------------------------
  s = setup();
  res = await handle(cron({ action: 'digest', date: '2020-01-01', person_id: ALEX }), s.deps);
  let out = await res.json();
  check('digest run → 200 with counts', res.status === 200 && out.ok === true && out.sent === 3 && out.due === 3 && out.failed === 0, JSON.stringify(out));
  const order = s.st.calls.map((c: Call) => c.fn);
  check('roll_missed_tasks runs first, then digest_due', order[0] === 'roll_missed_tasks' && order[1] === 'digest_due', order.slice(0, 3).join(','));
  check(`digest_due asks for ${BATCH} at most`, s.rpcs('digest_due')[0].args.p_limit === 20);
  check('the body\'s other fields are ignored (no date or person override)',
    s.rpcs('digest_for').every((c: Call) => c.args.p_local_date === DAY) && s.rpcs('digest_for').length === 2);
  const alexSeq = order.slice(order.indexOf('claim_notification', order.indexOf('finish_notification')) - 1, order.indexOf('claim_notification', order.indexOf('finish_notification')) + 3);
  check('each email: budget, claim, digest_for, finish', alexSeq.join(',') === 'email_budget_left,claim_notification,digest_for,finish_notification', alexSeq.join(','));
  check('every job call uses the service-role client', s.st.calls.every((c: Call) => c.who === 'service'));
  check('claims carry person, date and kind', JSON.stringify(s.rpcs('claim_notification')[1].args) === JSON.stringify({ p_person: ALEX, p_local_date: DAY, p_kind: 'digest' }));
  check('three emails go to Resend', s.resendCalls.length === 3 && s.resendCalls.every((c) => c.init.method === 'POST' && c.init.headers.Authorization === 'Bearer re_test'));
  const keys = s.resendCalls.map((c) => c.init.headers['Idempotency-Key']);
  check('Idempotency-Key is <kind>-<person>-<local_date> (a confirmation adds its secret\'s fingerprint)',
    new RegExp(`^confirm-${MORGAN}-${DAY}-[0-9a-f]{16}$`).test(keys[0]) && keys[1] === `digest-${ALEX}-${DAY}` && keys[2] === `digest-${SAM}-${DAY}`, keys.join(' | '));
  check('the confirmation key never carries the secret itself', !keys[0].includes(CONFIRM_MORGAN), keys[0]);
  const alexMail = s.resendCalls[1].body;
  check('from is "Home Hub" <EMAIL_FROM>', alexMail.from === '"Home Hub" <home@family.example>', alexMail.from);
  check('to is the recipient; subject is digest_for.subject', alexMail.to.length === 1 && alexMail.to[0] === 'alex@example.com' && alexMail.subject === 'Mon Nov 9: 8:00am Drop off dogs · 10:00am Team call · +1', alexMail.subject);
  check('html and text parts are both sent', /^<!doctype html>/.test(alexMail.html) && alexMail.text.includes('8:00am  Drop off dogs') && !/<[a-z]/i.test(alexMail.text));
  const fins = s.finishes();
  check('finish_notification: sent, with the claim id and Resend\'s id',
    fins.length === 3 && fins.every((f: any) => f.p_status === 'sent') && fins[1].p_id === 'dddddddd-0000-4000-8000-000000000002' && fins[1].p_detail === 'Resend email-2', JSON.stringify(fins[1]));
  const run = s.runs()[0];
  check('job_runs: one row, action digest, started and finished, ok, sent 3',
    s.runs().length === 1 && run.action === 'digest' && run.started_at === new Date(NOW).toISOString() && run.finished_at === new Date(NOW).toISOString() && run.ok === true && run.sent === 3, JSON.stringify(run));
  const det = detailOf(s);
  check('job_runs.detail holds the counts', det.due === 3 && det.sent === 3 && det.skipped === 0 && det.failed === 0 && det.busy === 0 && det.rolled === 2 && det.stop === null, run.detail);
  check('health check pinged once (GET) after a clean run', s.pings.length === 1 && s.pings[0].init.method === 'GET' && s.failPings.length === 0);
  check('no other outside calls', s.other.length === 0, s.other.join(','));

  s = setup({ env: { EMAIL_FROM_NAME: 'Lee "Family" <x@evil.example>\r\nBcc: v@x.co' } });
  await handle(cron(), s.deps);
  const evilFrom = s.resendCalls[0]?.body.from || '';
  check('EMAIL_FROM_NAME cannot inject addresses into From', /^"[^"<>,@\r\n]+" <home@family\.example>$/.test(evilFrom), evilFrom);

  s = setup({ due: [], tables: { job_runs: [
    { id: 'old', action: 'digest', started_at: new Date(NOW - (KEEP_RUNS_DAYS + 1) * 86400000).toISOString(), finished_at: null, ok: true, sent: 0, detail: null },
    { id: 'recent', action: 'digest', started_at: new Date(NOW - 86400000).toISOString(), finished_at: null, ok: true, sent: 0, detail: null }] } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('nothing due → 200, a job_runs row with sent 0, health ping', res.status === 200 && out.due === 0 && s.runs().some((r: any) => r.sent === 0 && r.ok === true && r.finished_at) && s.pings.length === 1 && s.failPings.length === 0);
  check(`job_runs older than ${KEEP_RUNS_DAYS} days are removed`, !s.runs().some((r: any) => r.id === 'old') && s.runs().some((r: any) => r.id === 'recent'));

  // -------------------------------------------------------------------
  // The confirmation email
  // -------------------------------------------------------------------
  s = setup();
  await handle(cron(), s.deps);
  const conf = s.resendCalls[0].body;
  const confLink = `${SITE}day.html?c=${CONFIRM_MORGAN}#confirm`;
  check('confirmation link: SITE_URL + day.html?c=<confirmation secret>#confirm, and nothing else',
    hrefs(conf.html).length === 1 && hrefs(conf.html)[0] === confLink && conf.text.includes(confLink), hrefs(conf.html).join(' '));
  check('the confirmation email never carries the My day link (a mistyped address gets nothing but the chance to confirm)',
    !conf.html.includes(TOKEN.morgan) && !conf.text.includes(TOKEN.morgan) && !conf.html.includes('?t=') && !conf.text.includes('?t='));
  check('confirmation email is in the person\'s language', conf.subject === 'Confirma tu correo de la mañana de Home Hub' && conf.html.includes('lang="es"') && conf.html.includes('Hola, Morgan'), conf.subject);
  check('confirmation email goes to the address on the family list', conf.to[0] === 'morgan@example.com');
  check('the confirmation secret is read with the service-role client',
    s.st.ops.some((q: any) => q.table === 'people_confirm' && q.who === 'service' && q.filters.some((f: any) => f[0] === 'person_id' && f[2] === MORGAN)));
  const en = renderConfirm({ name: 'Sam', language: 'en' }, `${SITE}day.html?c=${CONFIRM_MORGAN}#confirm`);
  check('English confirmation email', en.subject === 'Confirm your morning email from Home Hub' && en.html.includes('Yes, send me the morning email') && en.text.includes('Hi Sam,'));

  s = setup({ due: [{ kind: 'confirm', person_id: MORGAN, local_date: DAY }], tables: { people_confirm: [] } });
  await handle(cron(), s.deps);
  check('no confirmation secret (already confirmed by signing in) → skipped, nothing sent',
    s.resendCalls.length === 0 && s.finishes()[0]?.p_status === 'skipped', JSON.stringify(s.finishes()));
  const verified = peopleRows().map((p) => (p.id === MORGAN ? { ...p, email_verified_at: '2026-11-09T11:00:00+00:00' } : p));
  s = setup({ due: [{ kind: 'confirm', person_id: MORGAN, local_date: DAY }], tables: { people: verified } });
  await handle(cron(), s.deps);
  check('address confirmed meanwhile → skipped', s.resendCalls.length === 0 && s.finishes()[0]?.p_status === 'skipped');

  // SEC-2: one confirmation email and at most one reminder per address, then nothing.
  const confirmRow = (local_date: string, status: string, created_at: string) =>
    ({ id: `n-${local_date}-${status}`, person_id: MORGAN, local_date, kind: 'confirm', channel: 'email', status, attempts: 1, created_at });
  const onlyConfirm = [{ kind: 'confirm', person_id: MORGAN, local_date: DAY }];
  const secretSince = (created_at: string) => [{ person_id: MORGAN, token: CONFIRM_MORGAN, created_at }];
  s = setup({ due: onlyConfirm, tables: { people_confirm: secretSince('2026-11-05T15:00:00+00:00'), notification_log: [confirmRow('2026-11-06', 'sent', '2026-11-06T11:30:00+00:00')] } });
  await handle(cron(), s.deps);
  check('a confirmation for an address the hub already sent one to is a reminder (says so; the last one)',
    s.resendCalls.length === 1 && /^Recordatorio/.test(s.resendCalls[0].body.subject) && s.finishes()[0]?.p_status === 'sent', s.resendCalls[0]?.body.subject);
  check('... with the same link (the same secret)', hrefs(s.resendCalls[0]?.body.html || '')[0] === `${SITE}day.html?c=${CONFIRM_MORGAN}#confirm`);
  const countQ = s.st.ops.find((q: any) => q.table === 'notification_log' && q.op === 'select');
  const hasF = (q: any, c: string, op: string, v: string) => q.filters.some((f: any) => f[0] === c && f[1] === op && f[2] === v);
  check('... counted with the service-role client: that person\'s sent confirmations since this address\'s secret was made',
    !!countQ && countQ.who === 'service' && hasF(countQ, 'person_id', 'eq', MORGAN) && hasF(countQ, 'kind', 'eq', 'confirm') && hasF(countQ, 'status', 'eq', 'sent')
    && hasF(countQ, 'created_at', 'gte', '2026-11-05T15:00:00+00:00'), JSON.stringify(countQ?.filters));
  s = setup({ due: onlyConfirm, tables: { notification_log: [
    confirmRow('2026-11-02', 'sent', '2026-11-08T12:30:00+00:00'), confirmRow('2026-11-05', 'sent', '2026-11-08T12:40:00+00:00')] } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('two confirmation emails already sent to this address → no third: skipped, nothing sent, the run is ok',
    s.resendCalls.length === 0 && s.finishes()[0]?.p_status === 'skipped' && /twice|2/.test(s.finishes()[0]?.p_detail || '') && out.ok === true, JSON.stringify(s.finishes()));
  s = setup({ due: onlyConfirm, tables: { notification_log: [
    confirmRow('2026-11-02', 'sent', '2026-11-02T11:30:00+00:00'), confirmRow('2026-11-05', 'sent', '2026-11-05T11:30:00+00:00'),
    confirmRow('2026-11-07', 'failed', '2026-11-08T12:30:00+00:00')] } });
  await handle(cron(), s.deps);
  check('emails sent to an earlier address (before its secret was made) and failed ones don\'t count: a new address gets its first email',
    s.resendCalls.length === 1 && /^Confirma tu correo/.test(s.resendCalls[0].body.subject), s.resendCalls[0]?.body.subject);
  const enReminder = renderConfirm({ name: 'Sam', language: 'en' }, `${SITE}day.html?c=${CONFIRM_MORGAN}#confirm`, { reminder: true });
  check('English reminder: says it is the only reminder and that nothing more comes unless the address changes',
    /^Reminder: /.test(enReminder.subject) && /only reminder/i.test(enReminder.text) && /won't email this address again/i.test(enReminder.text), enReminder.text);
  check('the first confirmation says at most one reminder follows', /one reminder/i.test(en.text) && !/^Reminder/.test(en.subject), en.text);
  s = setup({ due: onlyConfirm, failTable: { 'notification_log.select': 'permission denied for table notification_log' } });
  await handle(cron(), s.deps);
  check('if the earlier confirmations can\'t be counted → failed (tried again later), nothing sent',
    s.resendCalls.length === 0 && s.finishes()[0]?.p_status === 'failed' && s.finishes()[0]?.p_detail.includes('notification_log'), JSON.stringify(s.finishes()));

  // OPS-1: the address is fixed the same day. The confirmation key changes with the secret, so Resend
  // (which keeps a key for 24 hours and refuses it with a different payload) sends to the new address.
  s = setup({ due: onlyConfirm, idempotent: true });
  await handle(cron(), s.deps);
  const typoKey = s.resendCalls[0]?.init.headers['Idempotency-Key'];
  const morganRow = s.st.tables.people.find((p: any) => p.id === MORGAN);
  morganRow.email = 'morgan@example.org';                                   // the admin fixes the address:
  s.st.tables.people_confirm[0] = { person_id: MORGAN, token: 'a7c3e9f1b2d4c6e8a0b1c2d3e4f5a6b7', created_at: '2026-11-09T11:40:00+00:00' };
  s.st.tables.notification_log = [];                                        // people_confirm_sync's new secret, old rows gone
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('address fixed the same day: the corrected address gets its confirmation on the next run',
    s.resendState.delivered.map((m: any) => m.to[0]).join(',') === 'morgan@example.com,morgan@example.org' && s.finishes()[1]?.p_status === 'sent' && out.failed === 0,
    `${s.resendState.delivered.map((m: any) => m.to[0]).join(',')} ${JSON.stringify(s.finishes())}`);
  check('... under a new key, with the new secret in the link',
    s.resendCalls[1]?.init.headers['Idempotency-Key'] !== typoKey && hrefs(s.resendCalls[1]?.body.html || '')[0] === `${SITE}day.html?c=a7c3e9f1b2d4c6e8a0b1c2d3e4f5a6b7#confirm`);
  s = setup({ due: onlyConfirm, idempotent: true });
  s.resendState.loseReply = 1;
  await handle(cron(), s.deps);
  await handle(cron(), s.deps);
  check('a retry of the same confirmation (reply lost) reuses its key and payload: one email, recorded as sent',
    s.resendState.delivered.length === 1 && s.resendCalls.length === 2 && s.resendCalls[0].init.headers['Idempotency-Key'] === s.resendCalls[1].init.headers['Idempotency-Key']
    && s.finishes()[0]?.p_status === 'failed' && s.finishes()[1]?.p_status === 'sent', JSON.stringify(s.finishes()));

  // OPS-4: the reply to a digest was lost, but Resend sent it; before the retry, something in it changed
  // (a task ticked on My day), so the retry has the same key and a different payload: Resend says 409.
  s = setup({ due: [{ kind: 'digest', person_id: ALEX, local_date: DAY }], idempotent: true });
  s.resendState.loseReply = 1;
  await handle(cron(), s.deps);
  s.st.rpc.digest_for = (a: any) => (a.p_person === ALEX ? { ...alexDigest(), today: alexDigest().today.slice(0, 2), subject: 'Mon Nov 9: 8:00am Drop off dogs · 10:00am Team call' } : null);
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('a digest Resend already sent (409 invalid_idempotent_request on the retry) → recorded as sent, not failed',
    s.resendState.delivered.length === 1 && s.finishes()[1]?.p_status === 'sent' && /earlier/i.test(s.finishes()[1]?.p_detail || '') && out.failed === 0 && out.sent === 1 && s.failPings.length === 1 && s.pings.length === 1,
    JSON.stringify(s.finishes()));
  s = setup({ due: [{ kind: 'digest', person_id: ALEX, local_date: DAY }], resend: () => ({ status: 409, body: '{"statusCode":409,"name":"concurrent_idempotent_requests","message":"Same idempotency key used while original request is still in progress."}' }) });
  await handle(cron(), s.deps);
  check('409 concurrent_idempotent_requests (the first is still in flight) → failed, so it is tried again',
    s.finishes()[0]?.p_status === 'failed' && s.finishes()[0]?.p_detail.includes('409'), JSON.stringify(s.finishes()));

  // -------------------------------------------------------------------
  // Budget, claims, empty days
  // -------------------------------------------------------------------
  s = setup({ budget: [5, 0] });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('budget used up → stops: one email sent, no more claims', s.resendCalls.length === 1 && s.rpcs('claim_notification').length === 1 && s.rpcs('email_budget_left').length === 2, `claims ${s.rpcs('claim_notification').length}`);
  check('budget stop is recorded in the response and job_runs', out.stop === 'budget' && detailOf(s).stop === 'budget' && s.runs()[0].ok === false, JSON.stringify(out));
  check('budget stop: the health check hears it failed (/fail), not that all is well', s.pings.length === 0 && s.failPings.length === 1 && s.failPings[0].init.method === 'GET');
  s = setup({ budget: [0] });
  await handle(cron(), s.deps);
  check('no budget at all → nothing claimed or sent', s.rpcs('claim_notification').length === 0 && s.resendCalls.length === 0);

  s = setup({ claims: { [`digest-${ALEX}`]: null } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('claim returns null → skipped: no digest_for, no send, no finish for that one',
    !s.rpcs('digest_for').some((c: Call) => c.args.p_person === ALEX) && !s.resendCalls.some((c) => c.body.to[0] === 'alex@example.com')
    && s.finishes().length === 2 && out.busy === 1 && out.sent === 2, JSON.stringify(out));

  s = setup({ due: [{ kind: 'digest', person_id: MORGAN, local_date: DAY }], digests: { [MORGAN]: emptyMorgan() } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('non-parent with nothing today → finished as skipped, nothing sent',
    s.resendCalls.length === 0 && s.finishes()[0]?.p_status === 'skipped' && out.skipped === 1 && out.ok === true, JSON.stringify(s.finishes()));

  s = setup({ due: [{ kind: 'digest', person_id: ROBIN, local_date: DAY }], digests: {} });
  await handle(cron(), s.deps);
  check('digest_for null (no longer on the list) → skipped', s.resendCalls.length === 0 && s.finishes()[0]?.p_status === 'skipped');

  // -------------------------------------------------------------------
  // Resend failures
  // -------------------------------------------------------------------
  s = setup({ resend: (n) => (n === 2 ? { status: 422, body: '{"statusCode":422,"name":"validation_error","message":"The family.example domain is not verified."}' } : { status: 200, body: `{"id":"email-${n}"}` }) });
  res = await handle(cron(), s.deps);
  out = await res.json();
  const failFin = s.finishes()[1];
  check('Resend failure → finished as failed with Resend\'s reason', failFin?.p_status === 'failed' && failFin.p_detail.includes('422') && failFin.p_detail.includes('domain is not verified'), JSON.stringify(failFin));
  check('... the other emails still go', s.resendCalls.length === 3 && s.finishes()[2].p_status === 'sent');
  check('... the run is marked not ok, with the failure count', out.failed === 1 && out.sent === 2 && s.runs()[0].ok === false && detailOf(s).failed === 1, JSON.stringify(out));
  check('... and tells the health check it failed (/fail), so an email that stops is noticed', s.pings.length === 0 && s.failPings.length === 1);

  s = setup();
  await handle(cron(), s.deps);
  check(`sends are spaced out (${SEND_GAP_MS}ms) for Resend's rate limit`, s.sleeps.length === 2 && s.sleeps.every((ms) => ms === SEND_GAP_MS), JSON.stringify(s.sleeps));
  s = setup({ resend: (n) => (n === 2 ? { status: 429, body: '{"name":"rate_limit_exceeded"}', headers: { 'retry-after': '2' } } : { status: 200, body: `{"id":"email-${n}"}` }) });
  await handle(cron(), s.deps);
  check('429 → waits as Resend asks and tries once more, with the same key',
    s.resendCalls.length === 4 && s.resendCalls[1].init.headers['Idempotency-Key'] === s.resendCalls[2].init.headers['Idempotency-Key']
    && s.sleeps.includes(2000) && s.finishes().every((f: any) => f.p_status === 'sent'), JSON.stringify(s.sleeps));
  s = setup({ resend: () => ({ status: 429, body: '{"name":"rate_limit_exceeded","message":"Too many requests"}' }) });
  await handle(cron(), s.deps);
  check('429 twice → failed with the reason', s.resendCalls.length === 6 && s.finishes().every((f: any) => f.p_status === 'failed' && f.p_detail.includes('429')));

  s = setup({ resend: () => ({ status: 500, body: 'x'.repeat(5000) }) });
  await handle(cron(), s.deps);
  check('a long Resend reply is truncated', s.finishes().every((f: any) => f.p_status === 'failed' && f.p_detail.length <= 300), String(s.finishes()[0]?.p_detail.length));
  s = setup({ resend: () => new Error('connection reset') });
  await handle(cron(), s.deps);
  check('network error → failed with the reason', s.finishes().every((f: any) => f.p_status === 'failed' && f.p_detail.includes('connection reset')));

  s = setup({ failRpc: { digest_for: 'division by zero' } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('digest_for error → that email failed, the run goes on', s.finishes()[1].p_status === 'failed' && s.finishes()[1].p_detail.includes('division by zero') && s.resendCalls.length === 1 && res.status === 200);

  // -------------------------------------------------------------------
  // Unhandled errors and configuration
  // -------------------------------------------------------------------
  s = setup({ failRpc: { digest_due: 'permission denied for function digest_due' } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('digest_due error → 500, run recorded as failed', res.status === 500 && s.runs()[0].ok === false && detailOf(s).stop === 'error' && detailOf(s).error.includes('digest_due'), JSON.stringify(out));
  check('... no "all is well" ping after an unhandled error; /fail instead', s.pings.length === 0 && s.failPings.length === 1);

  s = setup({ failRpc: { claim_notification: 'deadlock detected' } });
  res = await handle(cron(), s.deps);
  check('claim error → 500, nothing sent, no health ping (only /fail)', res.status === 500 && s.resendCalls.length === 0 && s.pings.length === 0 && s.failPings.length === 1);

  s = setup({ failRpc: { finish_notification: 'connection lost' } });
  res = await handle(cron(), s.deps);
  check('finish error → run stops (500), no health ping (only /fail)', res.status === 500 && s.resendCalls.length === 1 && s.pings.length === 0 && s.failPings.length === 1);

  s = setup({ failRpc: { roll_missed_tasks: 'lock timeout' } });
  res = await handle(cron(), s.deps);
  check('roll_missed_tasks error → the emails still go, but the run is not ok and not pinged',
    s.resendCalls.length === 3 && res.status === 500 && s.runs()[0].ok === false && detailOf(s).roll_error === 'lock timeout' && s.pings.length === 0 && s.failPings.length === 1);

  s = setup({ failTable: { 'job_runs.insert': 'permission denied for table job_runs' } });
  res = await handle(cron(), s.deps);
  check('job_runs cannot be written → 500, nothing claimed or sent, no "all is well" ping (/fail instead)', res.status === 500 && s.rpcs('claim_notification').length === 0 && s.resendCalls.length === 0 && s.pings.length === 0 && s.failPings.length === 1);

  s = setup({ env: { HEALTHCHECK_URL: undefined } });
  await handle(cron(), s.deps);
  check('no HEALTHCHECK_URL → no ping', s.pings.length === 0 && s.failPings.length === 0 && s.other.length === 0 && s.resendCalls.length === 3);

  s = setup({ env: { SITE_URL: undefined } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('missing SITE_URL → 500 naming SITE_URL', res.status === 500 && out.error.includes('SITE_URL'), JSON.stringify(out));
  check('... nothing claimed or sent', s.rpcs('claim_notification').length === 0 && s.resendCalls.length === 0 && s.rpcs('digest_due').length === 0);
  check('... job_runs records the reason, no "all is well" ping (/fail instead)', s.runs()[0].ok === false && detailOf(s).stop === 'config' && detailOf(s).error.includes('SITE_URL') && s.pings.length === 0 && s.failPings.length === 1);
  s = setup({ env: { SITE_URL: 'javascript:alert(1)//' } });
  res = await handle(cron(), s.deps);
  check('SITE_URL that isn\'t http(s) → same failure', res.status === 500 && s.resendCalls.length === 0);
  s = setup({ env: { RESEND_API_KEY: undefined } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('missing Resend secrets → the run fails clearly', res.status === 500 && out.error.includes('RESEND_API_KEY') && s.resendCalls.length === 0);
  s = setup({ env: { SUPABASE_SECRET_KEYS: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined } });
  res = await handle(cron(), s.deps);
  check('no service-role key → 503', res.status === 503 && s.st.calls.length === 0);

  // -------------------------------------------------------------------
  // Rendering the digest
  // -------------------------------------------------------------------
  const alexMailR = renderDigest(alexDigest() as any, SITE, { canSignIn: true });
  const myDay = `${SITE}day.html?t=${TOKEN.alex}`;
  const hubToday = `${SITE}#/today`;
  const hubSettings = `${SITE}#/settings`;
  const hubFamily = `${SITE}#/family`;
  const taylorWa = `https://wa.me/12015550103?text=${encodeURIComponent(TAYLOR_TEXT)}`;
  const taylorSms = `sms:+12015550103?&body=${encodeURIComponent(TAYLOR_TEXT)}`;
  const links = hrefs(alexMailR.html);
  check('someone who can sign in: the button opens the hub (Today), not a My day link',
    links.includes(hubToday) && alexMailR.text.includes(`Open Home Hub: ${hubToday}`) && alexMailR.html.includes('>Open Home Hub<'), links.join(' '));
  check('someone who can sign in: no My day or #stop link anywhere, so a forwarded email hands out no access',
    !links.some((l) => l.includes('day.html')) && !alexMailR.html.includes(TOKEN.alex) && !alexMailR.text.includes(TOKEN.alex) && !alexMailR.text.includes('day.html'), links.join(' '));
  check('a parent who can sign in (an admin): "Stop these emails" opens the Family page, where their morning email is set (behind sign-in)',
    links.includes(hubFamily) && alexMailR.text.includes(`Stop these emails: ${hubFamily}`) && !links.includes(hubSettings), links.join(' '));
  const samMailR = renderDigest(samDigest() as any, SITE, { canSignIn: true });
  check('an adult who can sign in (a member): "Stop these emails" opens Settings, whose Morning email card says to ask an admin',
    hrefs(samMailR.html).includes(hubSettings) && !hrefs(samMailR.html).includes(hubFamily) && !samMailR.html.includes('day.html'), hrefs(samMailR.html).join(' '));
  const noLogin = renderDigest(alexDigest() as any, SITE, { canSignIn: false });
  check('a parent who can\'t sign in keeps the My day button and its #stop link (and gets no hub link)',
    hrefs(noLogin.html).includes(myDay) && hrefs(noLogin.html).includes(`${myDay}#stop`) && noLogin.text.includes(`Open my day: ${myDay}`)
    && !hrefs(noLogin.html).includes(SITE) && !hrefs(noLogin.html).includes(hubToday), hrefs(noLogin.html).join(' '));
  check('without being told, parents and adults are taken to be able to sign in (never a My day link)',
    !renderDigest(alexDigest() as any, SITE).html.includes('day.html') && !renderDigest(samDigest() as any, SITE).html.includes('day.html')
    && renderDigest(morganDigest() as any, SITE).html.includes(`day.html?t=${TOKEN.morgan}`));
  check('WhatsApp link from the phone digits (10 digits → 1 prefix) with day_text', links.includes(taylorWa), links.filter((l) => l.includes('wa.me')).join(' '));
  check('Text link: sms:+<digits>?&body=<day_text>', links.includes(taylorSms));
  check('in the HTML the & in sms links is escaped', alexMailR.html.includes('sms:+12015550103?&amp;body='));
  check('a 7-digit phone keeps its digits (555-0104 → 5550104)', links.some((l) => l.startsWith('https://wa.me/5550104?text=')) && links.some((l) => l.startsWith('sms:+5550104?&body=')));
  check('no phone → no buttons for that person', !links.some((l) => l.includes(encodeURIComponent('Robin · Mon Nov 9'))));
  const allowed = (l: string) => l === hubToday || l === hubFamily || /^https:\/\/wa\.me\/\d+\?text=[^\s"<>]*$/.test(l) || /^sms:\+\d+\?&body=[^\s"<>]*$/.test(l);
  check('every link in the digest is one the hub built', links.length === 6 && links.every(allowed), links.filter((l) => !allowed(l)).join(' ') || String(links.length));
  check('sections: late (+"and 1 more"), heads-up, their day, nobody, projects, inbox',
    ['Late', 'and 1 more', 'Heads-up', 'Tomorrow 7:30am', 'contract ends Nov 30 · 555-0160', 'Their day', 'Nobody&#39;s on it', 'Clean gutters', 'Projects',
      'Kitchen: Inspection; Wire starts (Pat Lee 555-0100)', 'Inbox: 2 tasks with no date']
      .every((x) => alexMailR.html.replace(/<span style="white-space:nowrap;">([^<]*)<\/span>/g, '$1').includes(x)));
  check('plain text has the same content', ['Today · Mon Nov 9', '8:00am  Drop off dogs', '☐ Pay water bill', 'Late\n☐ Renew passport · due Nov 1', 'and 1 more',
    TAYLOR_TEXT, "Nobody's on it", 'Kitchen: Inspection; Wire starts (Pat Lee 555-0100)', 'Inbox: 2 tasks with no date'].every((x) => alexMailR.text.includes(x)), alexMailR.text);
  check('compact, mobile-friendly HTML (max-width 560px, viewport, inline styles, under 40 KB)',
    alexMailR.html.includes('max-width:560px') && alexMailR.html.includes('name="viewport"') && alexMailR.html.length < 40000, String(alexMailR.html.length));
  check('dark mode for mail apps that support it', alexMailR.html.includes('prefers-color-scheme: dark') && alexMailR.html.includes('name="color-scheme"'));
  check('tap targets: buttons are at least 44px tall (20px line + 2×12px padding)', /line-height:20px;padding:12px 18px/.test(alexMailR.html) && /line-height:20px;padding:11px 16px;[^"]*border:1px|border:1px[^"]*line-height:20px;padding:11px 16px/.test(alexMailR.html));

  check('phone numbers stay on one line (in details, day_text and project lines)',
    ['555-0160', '555-0150', '555-0100'].every((n) => alexMailR.html.includes(`<span style="white-space:nowrap;">${n}</span>`)));
  check('titles line up: times sit in a fixed-width column', (alexMailR.html.match(/width="84"/g) || []).length === 12);

  const es = renderDigest(morganDigest() as any, SITE);
  check('Spanish labels come from digest_for.labels', es.html.includes('Hoy · lun 9 nov') && es.html.includes('Abrir mi día') && es.html.includes('No enviar más correos')
    && !es.html.includes('Open my day') && es.html.includes('lang="es"') && es.text.startsWith('Hoy · lun 9 nov'));
  check('kids and helpers get no hub link (they can\'t sign in)', !hrefs(es.html).includes(SITE) && hrefs(es.html).length === 2);
  const sneaky = { ...morganDigest(), people: alexDigest().people, nobody: alexDigest().nobody, projects: alexDigest().projects, inbox_count: 4 };
  const sneakyR = renderDigest(sneaky as any, SITE);
  check('non-parents never get the parents\' sections', !sneakyR.html.includes('wa.me') && !sneakyR.html.includes('Kitchen') && !sneakyR.html.includes('Recital'));
  const empty = renderDigest({ ...samDigest(), today: [] } as any, SITE);
  check('an empty Today says "Nothing planned"', empty.html.includes('Nothing planned') && empty.text.includes('Nothing planned'));

  // Escaping: nothing from the data becomes markup or a link.
  const evil = alexDigest();
  evil.today[0].title = '<script>alert(1)</script> see https://evil.example/x?a=1&b=2';
  evil.today[1].detail = '"Bob" & <b>Co</b> www.evil.example';
  evil.people[0].text = 'Taylor <img src=x onerror=alert(1)>\nhttps://evil.example/day';
  evil.projects[0].text = 'Kitchen: <a href="https://evil.example">tile</a>';
  evil.subject = 'Mon Nov 9: hi\r\nBcc: victim@example.com';
  evil.date_label = '<i>Mon</i>';
  evil.recipient.day_token = 'not-a-token"><a href="https://evil.example';
  const ev = renderDigest(evil as any, SITE, { canSignIn: false });
  check('a title with <script> is escaped', !ev.html.includes('<script>alert') && ev.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  check('... and its URL is plain text, not a link', ev.html.includes('see https://evil.example/x?a=1&amp;b=2') && !hrefs(ev.html).some((l) => /^[a-z]+:\/*[^/?#]*evil/i.test(l)));
  check('no markup from details, day_text or project lines', !/<(img|b>|i>|a href="https:\/\/evil)/.test(ev.html) && ev.html.includes('&quot;Bob&quot; &amp; &lt;b&gt;Co&lt;/b&gt;'));
  check('a bad day_token gives no My day link (and breaks nothing)', !hrefs(ev.html).some((l) => l.includes('day.html')) && !ev.html.includes('not-a-token'));
  check('subject is one line', ev.subject === 'Mon Nov 9: hi Bcc: victim@example.com', JSON.stringify(ev.subject));
  check('the WhatsApp text is URL-encoded, so it can\'t break out of the link',
    hrefs(ev.html).filter((l) => l.startsWith('https://wa.me/')).every((l) => /^https:\/\/wa\.me\/\d+\?text=[A-Za-z0-9%\-_.!~*'()]*$/.test(l)));
  // Google Calendar (v1.1, docs/v1.1-google-calendar.md §5.6): digest_for's calendar block, parents only.
  const calBlock = {
    warning: "Google Calendar isn't up to date (last synced Mon 6:05am). See Settings.",
    items_failed: "1 item couldn't be copied to Google. See Settings.",
    put_back: ['Piano, Thu Nov 5: deleted in Google and put back. To cancel one day, use Skip this day in Home Hub.', 'Dentist, Fri Nov 6: changed in Google and put back.'],
  };
  const withCal = renderDigest({ ...alexDigest(), calendar: calBlock } as any, SITE, { canSignIn: true });
  const firstToday = withCal.html.indexOf('Drop off dogs', withCal.html.indexOf('</h1>'));   // (the <title> has the subject)
  check('the parents\' Google Calendar lines show under the heading, before Today\'s items (HTML and text)',
    [calBlock.warning, calBlock.items_failed, ...calBlock.put_back].every((l) => { const at = withCal.html.indexOf(esc(l)); return at > withCal.html.indexOf('</h1>') && at < firstToday; })
    && withCal.text.startsWith(`Today · Mon Nov 9\n${calBlock.warning}\n${calBlock.items_failed}\n${calBlock.put_back[0]}\n${calBlock.put_back[1]}\n\n8:00am  Drop off dogs`), withCal.text.slice(0, 400));
  check('... the warnings in the warning colour, the put-back lines muted',
    withCal.html.includes(`<div class="hh-warn" style="color:#8a5a00;font-size:13px;margin:2px 0;">${esc(calBlock.warning)}</div>`)
    && withCal.html.includes(`class="hh-muted" style="color:#6f675c;font-size:13px;margin:2px 0;">${esc(calBlock.put_back[1])}</div>`));
  check('... no calendar block (null, or not set up) → no lines', renderDigest({ ...alexDigest(), calendar: null } as any, SITE).text === renderDigest(alexDigest() as any, SITE).text
    && !renderDigest(alexDigest() as any, SITE).html.includes('hh-warn" style="color:#8a5a00;font-size:13px'));
  const partCal = renderDigest({ ...alexDigest(), calendar: { warning: null, items_failed: null, put_back: [calBlock.put_back[0]] } } as any, SITE);
  check('... only the lines it has (a put-back line alone)', partCal.text.includes(calBlock.put_back[0]) && !partCal.text.includes('up to date') && !partCal.text.includes('copied'), partCal.text.slice(0, 200));
  const manyCal = renderDigest({ ...alexDigest(), calendar: { warning: null, items_failed: null, put_back: ['a1', 'a2', 'a3', 'a4', 'a5'] } } as any, SITE);
  check('... at most 3 put-back lines', manyCal.text.includes('a3') && !manyCal.text.includes('a4'));
  const kidCal = renderDigest({ ...morganDigest(), calendar: calBlock } as any, SITE);
  check('... never for anyone but a parent (even if the block were there)', !kidCal.html.includes('up to date') && !kidCal.text.includes('put back'));
  // A hostile title typed into Google: as an item of Today, in the subject and in a put-back line.
  const hostile = '<img src=x onerror=alert(1)>';
  const gDigest = { ...alexDigest(), today: [{ ...item('google', 'All day', hostile), detail: '<b>Field 3</b>' }, ...alexDigest().today],
    subject: `Mon Nov 9: ${hostile} · 8:00am Drop off dogs`, calendar: { warning: null, items_failed: null, put_back: [`${hostile}, Thu Nov 5: deleted in Google and put back.`] } };
  const gMail = renderDigest(gDigest as any, SITE, { canSignIn: true });
  check('a Google title like <img src=x onerror=…> is escaped in the body (item, put-back line) and the HTML title',
    !/<img|<b>/.test(gMail.html) && (gMail.html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length === 3 && gMail.html.includes('<title>Mon Nov 9: &lt;img src=x'), (gMail.html.match(/&lt;img/g) || []).length);
  check('... the subject stays one line of plain text (it isn\'t HTML), and the text part has it as text',
    gMail.subject === `Mon Nov 9: ${hostile} · 8:00am Drop off dogs` && gMail.text.includes(`All day  ${hostile} · <b>Field 3</b>`), gMail.subject);
  const SEP = String.fromCharCode(0x2028, 0x2029);   // the Unicode line and paragraph separators, never written out here
  const sepTitle = renderDigest({ ...gDigest, subject: `Mon Nov 9: a${SEP[0]}b\r\nBcc: x@example.com`, calendar: { warning: `w${SEP[1]}x\ny`, items_failed: null, put_back: [] } } as any, SITE);
  check('... line breaks and separators can\'t split the subject or a calendar line', sepTitle.subject === 'Mon Nov 9: a b Bcc: x@example.com' && sepTitle.text.includes('\nw x y\n'), JSON.stringify(sepTitle.subject));
  // A dinner (v1.2, docs/v1.2-kitchen.md §9): digest_for's wrapper adds a 'meal' row at the end of Today
  // (the slot's word as its time, who's on it as its detail) and, on a quiet day, names it in the
  // subject. render.ts draws it as any row and escapes it like any title: hub-jobs needs no change.
  const mealRow = (time: string, title: string, detail: string | null) =>
    ({ ...item('meal', time, title, detail), item_id: 'eeeeeeee-0000-4000-8000-000000000001' });
  const mealEn = renderDigest({ ...alexDigest(), today: [...alexDigest().today, mealRow('Dinner', hostile, 'Sam cooks')] } as any, SITE, { canSignIn: true });
  check('a dinner titled <img src=x onerror=…> at the end of Today: escaped in the HTML, in the time column as "Dinner", after the other rows',
    !/<img/.test(mealEn.html) && (mealEn.html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length === 1
    && mealEn.html.indexOf('&lt;img src=x') > mealEn.html.indexOf('Pay water bill') && />Dinner<\/td>/.test(mealEn.html) && (mealEn.html.match(/width="84"/g) || []).length === 13, (mealEn.html.match(/&lt;img/g) || []).length);
  check('... and in the text part as text, the last row of Today: "Dinner  <img …> · Sam cooks"',
    mealEn.text.includes(`☐ Pay water bill\nDinner  ${hostile} · Sam cooks\n\nLate`), mealEn.text.slice(0, 200));
  const mealEs = renderDigest({ ...morganDigest(), today: [...morganDigest().today, mealRow('Cena', hostile, 'Cocinas tú · <b>350°</b> 20 min')] } as any, SITE);
  check('... in Spanish: "Cena", the title and the note (the cook\'s) escaped in the HTML, as text in the text part',
    !/<img|<b>/.test(mealEs.html) && />Cena<\/td>/.test(mealEs.html) && mealEs.html.includes('&lt;img src=x onerror=alert(1)&gt;')
    && mealEs.html.includes('Cocinas tú · &lt;b&gt;350°&lt;/b&gt; 20 min') && mealEs.text.includes(`☐ Asunto privado\nCena  ${hostile} · Cocinas tú · <b>350°</b> 20 min\n`),
    mealEs.text.slice(0, 300));
  const quiet = renderDigest({ ...samDigest(), today: [mealRow('Dinner', hostile, 'You cook')], subject: `Mon Nov 9: Dinner: ${hostile} · You cook` } as any, SITE, { canSignIn: true });
  check('... and on a quiet day the dinner is the subject: plain text on one line, escaped in the HTML <title>; no "Nothing planned"',
    quiet.subject === `Mon Nov 9: Dinner: ${hostile} · You cook` && quiet.html.includes('<title>Mon Nov 9: Dinner: &lt;img src=x onerror=alert(1)&gt; · You cook</title>')
    && !/<img/.test(quiet.html) && !quiet.text.includes('Nothing planned') && quiet.text.includes(`Dinner  ${hostile} · You cook`), quiet.subject);
  const quietEs = renderDigest({ ...emptyMorgan(), today: [mealRow('Cena', 'Asunto privado', 'Cocina Sam')], empty: false, subject: 'lun 9 nov: Cena: Asunto privado' } as any, SITE);
  check('... a locked dinner\'s subject in Spanish ("lun 9 nov: Cena: Asunto privado"), and its row for a helper who isn\'t on it',
    quietEs.subject === 'lun 9 nov: Cena: Asunto privado' && quietEs.text.startsWith('Hoy · lun 9 nov\n\nCena  Asunto privado · Cocina Sam\n'), quietEs.text.slice(0, 120));
  const evC = renderConfirm({ name: '<b>Mo</b>', language: 'en' }, `${SITE}day.html?c=${CONFIRM_MORGAN}#confirm`);
  check('confirmation email escapes the name', evC.html.includes('Hi &lt;b&gt;Mo&lt;/b&gt;,') && !evC.html.includes('<b>Mo'));

  check('phone digits: (201) 555-0103 → 12015550103; +1 201 555 0104 → 12015550104; none → ""',
    phoneDigits('(201) 555-0103') === '12015550103' && phoneDigits('+1 201 555 0104') === '12015550104' && phoneDigits(null) === '');
  check('SITE_URL: trailing slash added, query and fragment dropped, non-http refused',
    siteBase('https://family.example/hub') === SITE && siteBase('https://family.example/hub/?x=1#y') === SITE && siteBase('javascript:alert(1)') === null && siteBase('') === null);

  // SEC-4 through the handler: who can sign in comes from the members table (service role).
  s = setup();
  await handle(cron(), s.deps);
  const sent = Object.fromEntries(s.resendCalls.map((c) => [c.body.to[0], c.body]));
  check('sent digests: Alex (admin) and Sam (member) get hub links, never their My day link',
    [sent['alex@example.com'], sent['sam@example.com']].every((m) => m && !m.html.includes('day.html') && !m.text.includes('day.html') && hrefs(m.html).includes(`${SITE}#/today`)),
    Object.keys(sent).join(','));
  s = setup({ tables: { members: [{ email: 'Sam@Example.com', name: 'Sam Example', role: 'member' }] } });
  await handle(cron(), s.deps);
  const alexNoLogin = s.resendCalls.find((c) => c.body.to[0] === 'alex@example.com')?.body;
  const samCase = s.resendCalls.find((c) => c.body.to[0] === 'sam@example.com')?.body;
  check('a parent with no sign-in (no members row) still gets the My day button and #stop',
    !!alexNoLogin && hrefs(alexNoLogin.html).includes(`${SITE}day.html?t=${TOKEN.alex}`) && hrefs(alexNoLogin.html).includes(`${SITE}day.html?t=${TOKEN.alex}#stop`));
  check('members are matched without regard to case', !!samCase && !samCase.html.includes('day.html'));
  s = setup({ failTable: { 'members.select': 'permission denied for table members' } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('members can\'t be read → those digests fail (tried again later); nothing goes out with the wrong links',
    !s.resendCalls.some((c) => c.body.to[0] === 'alex@example.com') && s.finishes()[1]?.p_status === 'failed' && s.finishes()[1]?.p_detail.includes('members'), JSON.stringify(s.finishes()));

  // -------------------------------------------------------------------
  // preview
  // -------------------------------------------------------------------
  s = setup();
  res = await handle(asUser({ action: 'preview', date: '2026-11-10' }), s.deps);
  out = await res.json();
  check('preview (admin) → 200 with one email per person who gets the morning email',
    res.status === 200 && out.emails.length === 3 && out.emails.map((e: any) => e.name).join(',') === 'Alex,Sam,Morgan', JSON.stringify(out).slice(0, 300));
  check('preview renders subject, html and text', out.emails[0].subject === alexDigest().subject && out.emails[0].html.includes('Drop off dogs') && out.emails[0].text.includes('Drop off dogs'));
  check('preview uses the date asked for', s.rpcs('digest_for').every((c: Call) => c.args.p_local_date === '2026-11-10'));
  check('preview sends nothing and logs nothing', s.resendCalls.length === 0 && s.pings.length === 0 && s.rpcs('claim_notification').length === 0
    && s.rpcs('finish_notification').length === 0 && s.runs().length === 0 && !s.st.ops.some((q: any) => q.op !== 'select'));
  check('preview says who would get it (Morgan is unconfirmed)', out.emails[0].would_send === true && out.emails[2].would_send === false && out.emails[2].reason === 'unconfirmed');
  check('preview shows the links each person would get (hub for Alex; My day for Morgan, who can\'t sign in)',
    !out.emails[0].html.includes('day.html') && hrefs(out.emails[0].html).includes(`${SITE}#/today`) && hrefs(out.emails[2].html).includes(`${SITE}day.html?t=${TOKEN.morgan}`));

  s = setup();
  res = await handle(asUser({ action: 'preview' }), s.deps);
  out = await res.json();
  const dates = Object.fromEntries(s.rpcs('digest_for').map((c: Call) => [c.args.p_person, c.args.p_local_date]));
  check('preview without a date: the household\'s today (an evening person\'s is tomorrow)', out.date === DAY && dates[ALEX] === DAY && dates[SAM] === '2026-11-10', JSON.stringify(dates));
  s = setup();
  res = await handle(asUser({ action: 'preview', person_id: TAYLOR, date: DAY }), s.deps);
  out = await res.json();
  check('preview for one person (even with the email off)', res.status === 200 && out.emails.length <= 1 && s.rpcs('digest_for').length === 1 && s.rpcs('digest_for')[0].args.p_person === TAYLOR);
  res = await handle(asUser({ action: 'preview', date: '2026-02-30' }), s.deps);
  let badDate = res.status;
  res = await handle(asUser({ action: 'preview', date: '2026-13-01' }), s.deps);
  badDate = res.status === 400 ? badDate : res.status;
  res = await handle(asUser({ action: 'preview', person_id: "1' or 1=1" }), s.deps);
  check('preview rejects a bad date or person id → 400', badDate === 400 && res.status === 400);
  s = setup({ env: { SITE_URL: undefined } });
  res = await handle(asUser({ action: 'preview' }), s.deps);
  check('preview without SITE_URL → 503 naming SITE_URL', res.status === 503 && (await res.json()).error.includes('SITE_URL'));

  // -------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------
  const runRow = (minsAgo: number, sent: number, ok: boolean, detail: object) => ({
    id: `r${minsAgo}`, action: 'digest', started_at: new Date(NOW - minsAgo * 60000).toISOString(), finished_at: new Date(NOW - minsAgo * 60000 + 2000).toISOString(),
    ok, sent, detail: JSON.stringify(detail),
  });
  s = setup({ tables: {
    job_runs: [runRow(15, 0, true, { due: 0, sent: 0, skipped: 0, failed: 0, busy: 0, stop: null }),
      runRow(60, 3, false, { due: 4, sent: 3, skipped: 0, failed: 1, busy: 0, stop: null, error: null }),
      ...Array.from({ length: 12 }, (_, i) => runRow(75 + i * 15, 0, true, { due: 0 }))],
    notification_log: [
      { person_id: ALEX, local_date: DAY, kind: 'digest', status: 'sent', detail: 'Resend email-1' },
      { person_id: SAM, local_date: DAY, kind: 'digest', status: 'failed', detail: 'Resend 422: The family.example domain is not verified.' },
      { person_id: MORGAN, local_date: DAY, kind: 'confirm', status: 'sent', detail: null },
      { person_id: ALEX, local_date: '2026-11-08', kind: 'digest', status: 'sent', detail: null },
    ],
  } });
  res = await handle(asUser({ action: 'status' }), s.deps);
  out = await res.json();
  const body = JSON.stringify(out);
  check('status (admin) → the last 10 runs, newest first, with fixed messages',
    res.status === 200 && out.runs.length === 10 && out.runs[0].message === 'Nothing was due.' && out.runs[1].message.startsWith('Some emails failed') && out.runs[1].failed === 1, body.slice(0, 300));
  check('status: last run and last run that sent', out.last_run.sent === 0 && out.last_sent.sent === 3 && out.last_sent.started_at === new Date(NOW - 3600000).toISOString());
  check('status: today\'s emails as counts', out.today === DAY && out.today_counts.digest.sent === 1 && out.today_counts.digest.failed === 1 && out.today_counts.confirm.sent === 1, JSON.stringify(out.today_counts));
  check('status: "1 email failed today."', out.messages.includes('1 email failed today.'), JSON.stringify(out.messages));
  check('status never shows addresses, names or Resend\'s replies', !/example\.com|Alex|Sam|Morgan|domain is not verified|Resend email-1|"detail"/.test(body), body.slice(0, 200));
  check('status reads the logs with the caller\'s own sign-in (row-level security applies)',
    s.st.ops.filter((q: any) => q.table === 'job_runs' || q.table === 'notification_log').every((q: any) => q.who === 'user:Bearer admin-jwt'));
  s = setup();
  res = await handle(asUser({ action: 'status' }), s.deps);
  out = await res.json();
  check('status when it has never run', out.last_run === null && out.messages[0].includes('never run'), JSON.stringify(out.messages));
  check('... and points at net._http_response for 401s (hub-jobs deployed with JWT checks on)',
    /net\._http_response/.test(out.messages[0]) && /401/.test(out.messages[0]) && /--no-verify-jwt|verify_jwt/.test(out.messages[0]), out.messages[0]);
  s = setup({ tables: { job_runs: [runRow(180, 2, true, { due: 2, sent: 2 })] } });
  res = await handle(asUser({ action: 'status' }), s.deps);
  out = await res.json();
  check('status flags a cron job that stopped running', out.messages.some((m: string) => m.includes('more than an hour ago')), JSON.stringify(out.messages));
  check('... and points at net._http_response for 401s as well as the cron job',
    out.messages.some((m: string) => m.includes('more than an hour ago') && /net\._http_response/.test(m) && /401/.test(m)), JSON.stringify(out.messages));

  // OPS-5: verify_jwt is pinned in the repository, so a redeploy can't turn the gateway's JWT check back on.
  const toml = (() => { try { return readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8'); } catch { return ''; } })();
  const section = (name: string) => (toml.split(/^\[/m).find((b) => b.startsWith(`functions.${name}]`)) || '');
  check('supabase/config.toml pins verify_jwt = false for hub-jobs and send-email',
    /^verify_jwt\s*=\s*false\s*$/m.test(section('hub-jobs')) && /^verify_jwt\s*=\s*false\s*$/m.test(section('send-email')), toml.slice(0, 200) || 'no supabase/config.toml');
  check('supabase/config.toml has a project_id (the CLI needs one) that is not a real project ref',
    /^project_id\s*=\s*"[a-z0-9-]+"\s*$/m.test(toml) && !/^project_id\s*=\s*"[a-z]{20}"\s*$/m.test(toml));
  // A \u2028 or \u2029 escape in the source reached Supabase's bundler as a real line break (deployed
  // through the Supabase MCP), which ends a regular expression: the deploy failed. oneLine leaves them to \s.
  const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
  check('oneLine: control characters and the Unicode line and paragraph separators become single spaces',
    oneLine(`a${SEPARATORS[0]}b${SEPARATORS[1]}c\u0001\n d\t\r\ne`) === 'a b c d e' && oneLine(` x${SEPARATORS} `) === 'x',
    JSON.stringify(oneLine(`a${SEPARATORS[0]}b${SEPARATORS[1]}c\u0001\n d\t\r\ne`)));
  // Every file of the function (v1.1 added util.ts, google.ts and calendar.ts), not only the first three.
  const fnFiles = readdirSync(new URL('../../supabase/functions/hub-jobs/', import.meta.url)).filter((f) => f.endsWith('.ts'));
  const sources = fnFiles.map((f) => readFileSync(new URL(`../../supabase/functions/hub-jobs/${f}`, import.meta.url), 'utf8'));
  check('hub-jobs source has no \\u2028 or \\u2029 escapes, nor the raw characters (they break the deploy)',
    ['index.ts', 'handler.ts', 'render.ts', 'util.ts', 'google.ts', 'calendar.ts'].every((f) => fnFiles.includes(f))
    && sources.every((src) => !/\\u202[89]|\\u\{202[89]\}/.test(src) && !src.includes(SEPARATORS[0]) && !src.includes(SEPARATORS[1])), fnFiles.join(','));
  s = setup({ tables: { job_runs: [runRow(5, 0, false, { stop: 'config', error: 'SITE_URL is not set' })] } });
  res = await handle(asUser({ action: 'status' }), s.deps);
  out = await res.json();
  check('status explains a failed run with a fixed message', out.messages.some((m: string) => m.startsWith('Last run: Not set up')) && !JSON.stringify(out).includes('SITE_URL is not set'), JSON.stringify(out.messages));

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
