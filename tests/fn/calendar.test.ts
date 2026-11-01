// Unit tests for hub-jobs' Google Calendar actions (supabase/functions/hub-jobs/calendar.ts, google.ts),
// through handle() as the Edge Function runs them: a fake Google behind the injected fetch (its token
// endpoint checks the signed request with the public half of a key pair made here), a fake database
// answering the calendar_* functions with the shapes migration 0003 returns (and 0010's sort_by_guest from calendar_read_due,
// for the wall's own calendar sorted by Hearth person), and a fake clock.
// Everything is fictional: the test household (Alex, Morgan, Taylor, Jordan), example.com addresses,
// made-up calendar ids and a key that exists only while the test runs.
// Run alone with: node --experimental-strip-types tests/fn/calendar.test.ts
import { handle } from '../../supabase/functions/hub-jobs/handler.ts';
import { resetTokenCache, contentHash, readServiceAccount, KEY_BAD, KEY_REFUSED, API_OFF, NO_SCOPE, SCOPE, TOKEN_URI } from '../../supabase/functions/hub-jobs/google.ts';
import { HEARTH_TAG, READ_BUDGET_MS, READ_FIELDS, READ_FIELDS_GUESTS, RECORD_BATCH, RUN_BUDGET_MS, hearthTags, verdict } from '../../supabase/functions/hub-jobs/calendar.ts';
import { readFileSync, readdirSync } from 'node:fs';

const results: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' && !ok ? `  (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`);

// ---------------------------------------------------------------------
// Fixtures (fictional)
// ---------------------------------------------------------------------
const SECRET = '9f1c2e7a4b6d8e0f1a3c5e7b9d2f4a6c8e0b'; // the cron secret, 36 characters
const ACCOUNT = 'home-hub-sync@home-hub-example.iam.gserviceaccount.com';
const KEY_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const TZ = 'America/New_York';
const NOW = Date.parse('2026-11-02T14:00:00Z');   // Mon Nov 2, 9:00am in New York
const RUN = 'eeeeeeee-0000-4000-8000-000000000001';
const ITEM = 'bbbbbbbb-0000-4000-8000-000000000001';
const CAL = {   // calendars rows: id, Google ID
  taylor: { id: 'cccccccc-0000-4000-8000-000000000001', google: 'hub-taylor-0f1e2d3c@group.calendar.google.com' },
  jordan: { id: 'cccccccc-0000-4000-8000-000000000002', google: 'hub-jordan-4b5a6978@group.calendar.google.com' },
  family: { id: 'cccccccc-0000-4000-8000-000000000003', google: 'hub-family-9a8b7c6d@group.calendar.google.com' },
  main: { id: 'cccccccc-0000-4000-8000-000000000004', google: 'family@example.com' },
  holidays: { id: 'cccccccc-0000-4000-8000-000000000005', google: 'en.example#holiday@group.v.calendar.google.com' },
  hearth: { id: 'cccccccc-0000-4000-8000-000000000006', google: 'hearth-5e6f7a8b@group.calendar.google.com' },   // the wall's own (Hearth Calendar)
};
const MARKER = 'MARKER-7f3a9c';

// A key pair made for this test only; the private half becomes a service-account key file.
const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pem = async (k: CryptoKey) => {
  const b = Buffer.from(await crypto.subtle.exportKey('pkcs8', k)).toString('base64');
  return `-----BEGIN PRIVATE KEY-----\n${b.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
};
const PEM = await pem(pair.privateKey);
const PEM2 = await pem(other.privateKey);
const keyFile = (o: Record<string, unknown> = {}) => JSON.stringify({
  type: 'service_account', project_id: 'home-hub-example', private_key_id: KEY_ID, private_key: PEM, client_email: ACCOUNT,
  client_id: '000000000000000000001', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: TOKEN_URI, ...o,
}, null, 2);
const KEY = keyFile();
const publicKeys = [pair.publicKey, other.publicKey];

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
// The same instant written the way Google writes times in a read with timeZone=America/New_York
// (EST after Nov 1): "2026-11-03T16:00:00-05:00" for "2026-11-03T21:00:00Z".
const asLocal = (iso: string) => `${new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 19)}-05:00`;

// ---------------------------------------------------------------------
// A fake Google: the token endpoint and the Calendar API, keeping what was written.
// ---------------------------------------------------------------------
type GCall = { method: string; host: string; path: string; cal: string | null; event: string | null; query: URLSearchParams; body: any; auth: string; at: number };
type GCal = { summary: string; role: string; events: Map<string, any>; deleted: Map<string, any>; elsewhere: Set<string> };
// hang: the call never answers; the clock moves on by the call's own timeout (as AbortSignal.timeout was
// asked for it), and it ends with a TimeoutError.
type Scripted = { when: (c: GCall) => boolean; status?: number; body?: unknown; error?: Error; times?: number; hang?: boolean };
// The timeout each call asked for (AbortSignal.timeout), so a hanging call costs the fake clock what it
// would cost a real one.
const timeouts: number[] = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => { timeouts.push(ms); return realTimeout(ms); };
const gErr = (status: number, reason: string | null, msg: string, extra: Record<string, unknown> = {}) => ({
  error: { code: status, message: msg, ...(reason ? { errors: [{ domain: 'global', reason, message: msg }] } : {}), ...extra },
});

function fakeGoogle(clock: { t: number }) {
  const G = {
    cals: new Map<string, GCal>(),
    calls: [] as GCall[],
    tokenReqs: [] as { header: any; claims: any; valid: boolean; form: URLSearchParams; at: number }[],
    issued: new Set<string>(),
    tokenAnswer: null as null | { status: number; body: unknown },
    script: [] as Scripted[],
    pageSize: 2500,
    latency: 0,           // ms the clock moves during each Calendar API call
    seq: 0,
    other: [] as string[],
  };
  const cal = (id: string, summary: string, role = 'writer') => {
    const c: GCal = { summary, role, events: new Map(), deleted: new Map(), elsewhere: new Set() };
    G.cals.set(id, c);
    return c;
  };
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  // What Google sends back for an event: its own fields, visibility left out when it's the default.
  const answer = (ev: any, local: boolean) => {
    const out: any = { kind: 'calendar#event', etag: `"${ev.updated}"`, ...ev, reminders: { useDefault: true } };
    if (out.visibility === 'default') delete out.visibility;
    if (local) {
      for (const k of ['start', 'end']) if (out[k]?.dateTime) out[k] = { dateTime: asLocal(out[k].dateTime), timeZone: TZ };
    }
    return out;
  };
  const stamp = (ev: any, calId: string) => ({
    ...ev, updated: new Date(clock.t + ++G.seq).toISOString(), organizer: { email: calId, self: true }, creator: { email: ACCOUNT },
  });

  const fetch = async (input: string | URL, init: any = {}) => {
    const url = new URL(String(input));
    if (url.href === TOKEN_URI) {
      const form = new URLSearchParams(String(init.body));
      const jwt = form.get('assertion') || '';
      const [h, c, s] = jwt.split('.');
      let valid = false;
      for (const k of publicKeys) {
        if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, Buffer.from(s || '', 'base64url'), new TextEncoder().encode(`${h}.${c}`))) valid = true;
      }
      let header = null;
      let claims = null;
      try { header = b64json(h); claims = b64json(c); } catch { /* not a JWT */ }
      G.tokenReqs.push({ header, claims, valid, form, at: clock.t });
      if (G.tokenAnswer) return reply(G.tokenAnswer.status, G.tokenAnswer.body);
      if (!valid || form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return reply(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      const token = `ya29.fake-${G.tokenReqs.length}`;
      G.issued.add(token);
      return reply(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (url.origin !== 'https://www.googleapis.com' || !m) { G.other.push(url.href); return reply(500, {}); }
    const call: GCall = {
      method: init.method || 'GET', host: url.host, path: url.pathname, cal: decodeURIComponent(m[1]), event: m[2] ? decodeURIComponent(m[2]) : null,
      query: url.searchParams, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization || '', at: clock.t,
    };
    G.calls.push(call);
    clock.t += G.latency;
    const s = G.script.find((x) => (x.times ?? 1) > 0 && x.when(call));
    if (s) {
      s.times = (s.times ?? 1) - 1;
      if (s.hang) {
        clock.t += timeouts[timeouts.length - 1] ?? 15000;
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      if (s.error) throw s.error;
      return reply(s.status!, s.body);
    }
    if (!G.issued.has(call.auth.replace(/^Bearer /, ''))) return reply(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    const c = G.cals.get(call.cal!);
    if (!c || c.role === 'none') return reply(404, gErr(404, 'notFound', 'Not Found'));
    const ev = call.event;
    if (call.method === 'GET' && !ev) {
      const items = [...c.events.values()].map((e) => answer(e, true))
        .sort((a, b) => String(a.start?.dateTime ? Date.parse(a.start.dateTime) : a.start?.date).localeCompare(String(b.start?.dateTime ? Date.parse(b.start.dateTime) : b.start?.date)));
      const max = Math.min(Number(call.query.get('maxResults') || 250), G.pageSize);
      const from = Number((call.query.get('pageToken') || 'p0').slice(1));
      const page = items.slice(from, from + max);
      return reply(200, {
        kind: 'calendar#events', summary: c.summary, accessRole: c.role, timeZone: TZ, items: page,
        ...(from + max < items.length ? { nextPageToken: `p${from + max}` } : {}),
      });
    }
    if (call.method === 'GET') {
      const e = c.events.get(ev!);
      return e ? reply(200, answer(e, true)) : reply(404, gErr(404, 'notFound', 'Not Found'));
    }
    if (!['writer', 'owner'].includes(c.role)) return reply(403, gErr(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.'));
    if (call.method === 'POST') {
      const id = call.body?.id;
      if (c.events.has(id) || c.deleted.has(id) || c.elsewhere.has(id)) return reply(409, gErr(409, 'duplicate', 'The requested identifier already exists.'));
      const e = stamp(call.body, call.cal!);
      c.events.set(id, e);
      return reply(200, answer(e, false));
    }
    if (call.method === 'PUT') {
      if (!c.events.has(ev!) && !c.deleted.has(ev!)) return reply(404, gErr(404, 'notFound', 'Not Found'));
      c.deleted.delete(ev!);
      const e = stamp({ ...call.body, id: ev }, call.cal!);
      c.events.set(ev!, e);
      return reply(200, answer(e, false));
    }
    if (call.method === 'DELETE') {
      if (c.deleted.has(ev!)) return reply(410, gErr(410, 'deleted', 'Resource has been deleted'));
      const e = c.events.get(ev!);
      if (!e) return reply(404, gErr(404, 'notFound', 'Not Found'));
      c.events.delete(ev!);
      c.deleted.set(ev!, e);
      return new Response(null, { status: 204 });
    }
    return reply(400, gErr(400, 'badRequest', 'Bad Request'));
  };
  return { G, cal, fetch };
}

// ---------------------------------------------------------------------
// A fake database: the calendar_* functions, whoami and the calendars table.
// ---------------------------------------------------------------------
type DbCall = { who: string; fn: string; args: any };
type Opts = {
  env?: Record<string, string | undefined>;
  begin?: unknown;
  due?: any[];
  plan?: any[];
  calendars?: any[];
  me?: unknown;
  failRpc?: Record<string, string>;
  noSchema?: boolean;
};

let seqId = 0;
const hhId = (n: number) => `hh${n.toString(16).padStart(32, '0')}`;
function planRow(op: 'insert' | 'update' | 'delete', c: { id: string | null; google: string }, o: { day?: string; timed?: boolean; private?: boolean; title?: string; event_id?: string; location?: string } = {}) {
  const n = ++seqId;
  const base = hhId(n);
  const day = o.day ?? '2026-11-03';
  const title = o.title ?? `Piano ${n}`;
  const body = op === 'delete' ? null : {
    id: o.event_id ?? base, status: 'confirmed', summary: o.private ? '☐ Private item' : title,
    ...(o.location ? { location: o.location } : {}),
    description: 'Made by Home Hub: changes made here are undone. Change it in Home Hub.',
    start: o.timed ? { dateTime: `${day}T21:00:00Z`, timeZone: TZ } : { date: day },
    end: o.timed ? { dateTime: `${day}T22:00:00Z`, timeZone: TZ } : { date: nextDay(day) },
    transparency: o.timed ? 'opaque' : 'transparent', visibility: o.private ? 'private' : 'default',
    extendedProperties: { private: { homehub: '1', homehub_base: base, homehub_kind: 'event', homehub_item: ITEM, homehub_occurrence: day } },
  };
  return {
    op, calendar_id: c.id, google_calendar: c.google, base_id: base, event_id: o.event_id ?? base, gen: 0, item_kind: 'event', item_id: ITEM,
    job_id: null, occurrence: day, part: '', day, end_day: day, title, body, hash: body ? `hash-${n}` : null, pending: 0, hiding: 0,
  };
}
const dueRow = (c: { id: string; google: string }, writes = true) => ({
  calendar_id: c.id, google_id: c.google, writes, w_from: '2026-11-01', w_to: '2027-01-01',
  time_min: '2026-11-01T04:00:00+00:00', time_max: '2027-01-02T05:00:00+00:00', tz: TZ,
});
const calRow = (c: { id: string; google: string }, o: Record<string, unknown> = {}) => ({
  id: c.id, google_id: c.google, writes: true, status: 'ok', checked_at: new Date(NOW - 2 * 60000).toISOString(), ...o,
});

function setup(o: Opts = {}) {
  resetTokenCache();
  const clock = { t: NOW };
  const env: Record<string, string | undefined> = {
    HUB_CRON_SECRET: SECRET, SITE_URL: 'https://family.example/hub', SUPABASE_URL: 'https://project.example',
    SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}', GOOGLE_SA_JSON: KEY, ...o.env,
  };
  const st = {
    calls: [] as DbCall[],
    tables: [] as { who: string; table: string; filters: any[] }[],
    plan: o.plan ?? [],
    due: o.due ?? [],
    calendars: o.calendars ?? [],
  };
  const fn: Record<string, (a: any) => unknown> = {
    whoami: () => ('me' in o ? o.me : { email: 'alex@example.com', name: 'Alex Example', role: 'admin', person: { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Alex', role: 'parent' } }),
    calendar_begin: () => o.begin ?? { go: true, stop: null, run_id: RUN },
    calendar_signed_in: () => null,
    calendar_read_due: (a) => st.due.slice(0, a?.p_limit ?? 10),
    calendar_store_events: (a) => ({ kept: a.p_events.length, skipped: 0, seen: a.p_seen.length, repaired: 0, adopted: 0 }),
    calendar_mark: () => null,
    calendar_plan: (a) => {
      // As migration 0003 counts it: deletes, and updates that make an item private.
      const hiding = st.plan.filter((r: any) => r.op === 'delete' || (r.op === 'update' && r.body?.visibility === 'private')).length;
      return st.plan.slice(0, a?.p_limit ?? 60).map((r: any) => ({ ...r, pending: st.plan.length, hiding }));
    },
    calendar_record: () => null,
    calendar_finish: () => null,
  };
  const db = (who: string) => ({
    rpc: async (name: string, args?: any) => {
      st.calls.push({ who, fn: name, args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)) });
      if (o.failRpc?.[name]) return { data: null, error: { message: o.failRpc[name] } };
      if (o.noSchema && name.startsWith('calendar_')) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} without parameters in the schema cache` } };
      const h = fn[name];
      if (!h) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
      return { data: await h(args), error: null };
    },
    from: (table: string) => {
      const q = { who, table, filters: [] as any[], single: false };
      const api: any = {
        select: () => api,
        eq: (c: string, v: unknown) => { q.filters.push([c, v]); return api; },
        maybeSingle: () => { q.single = true; return api; },
        then: (ok: any, bad: any) => Promise.resolve().then(() => {
          st.tables.push(q);
          if (o.noSchema) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
          const rows = (table === 'calendars' ? st.calendars : []).filter((r: any) => q.filters.every(([c, v]) => r[c] === v)).map((r: any) => ({ ...r }));
          return q.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
        }).then(ok, bad),
      };
      return api;
    },
  });
  const google = fakeGoogle(clock);
  const sleeps: number[] = [];
  const deps = {
    env: (k: string) => env[k],
    now: () => clock.t,
    sleep: async (ms: number) => { sleeps.push(ms); clock.t += ms; },
    fetch: google.fetch as any,
    service: () => db('service'),
    user: (auth: string) => db(`user:${auth}`),
  };
  const rpcs = (name: string) => st.calls.filter((c) => c.fn === name);
  const finish = () => rpcs('calendar_finish')[0]?.args;
  const recorded = () => rpcs('calendar_record').flatMap((c) => c.args.p_results);
  return { deps, st, env, clock, G: google.G, cal: google.cal, sleeps, rpcs, finish, recorded };
}

const cron = (body: unknown = { action: 'calendar' }, secret: string | null = SECRET, extra: Record<string, string> = {}) =>
  new Request('https://project.example/functions/v1/hub-jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret == null ? {} : { 'x-hub-cron': secret }), ...extra }, body: JSON.stringify(body),
  });
const asUser = (body: unknown, auth: string | null = 'Bearer admin-jwt') =>
  new Request('https://project.example/functions/v1/hub-jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body),
  });
const run = async (s: ReturnType<typeof setup>, req: Request = cron()) => {
  const res = await handle(req, s.deps as any);
  return { status: res.status, body: await res.json() };
};
const calendarCalls = (s: ReturnType<typeof setup>) => s.G.calls.filter((c) => c.method !== 'GET' || c.event !== null || c.query.get('maxResults') !== '1');

(async () => {
  // -------------------------------------------------------------------
  // The key and the signed request (§6.1)
  // -------------------------------------------------------------------
  let s = setup({ due: [dueRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  let r = await run(s);
  const tr = s.G.tokenReqs[0];
  check('a run signs in once: one token request', r.status === 200 && s.G.tokenReqs.length === 1, r);
  check('JWT header is {"alg":"RS256","typ":"JWT"}', tr?.header?.alg === 'RS256' && tr?.header?.typ === 'JWT' && Object.keys(tr.header).length === 2, tr?.header);
  check('JWT claims: iss the service account, scope calendar.events, aud the token URI',
    tr?.claims?.iss === ACCOUNT && tr.claims.scope === SCOPE && SCOPE === 'https://www.googleapis.com/auth/calendar.events' && tr.claims.aud === TOKEN_URI, tr?.claims);
  check('JWT iat is now, and exp − iat ≤ 3600', tr?.claims?.iat === Math.floor(NOW / 1000) && tr.claims.exp - tr.claims.iat <= 3600 && tr.claims.exp > tr.claims.iat, tr?.claims);
  check('the signature verifies with the public key', tr?.valid === true);
  check('POSTed as a form: grant_type jwt-bearer and the assertion, nothing else',
    tr?.form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && [...tr.form.keys()].sort().join() === 'assertion,grant_type', [...(tr?.form.keys() ?? [])]);
  check('calendar_signed_in records the account and the key id for this run',
    JSON.stringify(s.rpcs('calendar_signed_in')[0]?.args) === JSON.stringify({ p_run: RUN, p_auth: 'service_account', p_account: ACCOUNT, p_key_id: KEY_ID }), s.rpcs('calendar_signed_in')[0]?.args);
  check('the Calendar API gets the token as a Bearer header', s.G.calls.length > 0 && s.G.calls.every((c) => c.auth === 'Bearer ya29.fake-1'));

  const variants: [string, string][] = [
    ['a \\n written as two characters', keyFile({ private_key: PEM.replace(/\n/g, '\\n') }).replace(/\\\\n/g, '\\n')],
    ['the whole file in base64', Buffer.from(KEY).toString('base64')],
    ['spaces and line breaks around it', `\n   ${KEY}  \n\n`],
    ['base64 with spaces around it', `  ${Buffer.from(KEY).toString('base64')}\n`],
    ['no token_uri (the default)', JSON.stringify({ ...JSON.parse(KEY), token_uri: undefined })],
  ];
  for (const [what, raw] of variants) {
    s = setup({ env: { GOOGLE_SA_JSON: raw } });
    r = await run(s);
    check(`the key is accepted with ${what}`, r.status === 200 && r.body.stop === null && s.G.tokenReqs[0]?.valid === true, r.body);
  }
  const literal = keyFile({ private_key: PEM.replace(/\n/g, '\\n') });
  check('(the two-character \\n case really has backslash-n in the PEM)', JSON.parse(literal).private_key.includes('\\n') && !JSON.parse(literal).private_key.includes('\n'));
  s = setup({ env: { GOOGLE_SA_JSON: literal } });
  r = await run(s);
  check('... and a key whose PEM is all on one line with literal \\n signs in', r.body.stop === null && s.G.tokenReqs[0]?.valid === true, r.body);

  const bad: [string, string][] = [
    ['not JSON', 'this is not a key'],
    ['an empty object', '{}'],
    ['no private key', JSON.stringify({ ...JSON.parse(KEY), private_key: undefined })],
    ['a private key that isn\'t PEM', JSON.stringify({ ...JSON.parse(KEY), private_key: 'abc' })],
    ['a PEM that isn\'t a key', JSON.stringify({ ...JSON.parse(KEY), private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' })],
    ['no client_email', JSON.stringify({ ...JSON.parse(KEY), client_email: undefined })],
    ['a token_uri that isn\'t Google\'s', JSON.stringify({ ...JSON.parse(KEY), token_uri: 'https://collect.example/token' })],
    ['a JSON array', '[1,2,3]'],
  ];
  for (const [what, raw] of bad) {
    s = setup({ env: { GOOGLE_SA_JSON: raw } });
    r = await run(s);
    check(`a bad key (${what}) → 500, stop config with the fixed message, Google never called`,
      r.status === 500 && r.body.stop === 'config' && r.body.error === KEY_BAD && s.finish()?.p_stop === 'config' && s.finish()?.p_error === KEY_BAD
      && s.G.tokenReqs.length === 0 && s.G.calls.length === 0 && !s.rpcs('calendar_signed_in').length, { status: r.status, body: r.body, tokens: s.G.tokenReqs.length });
  }

  // A malformed secret holding a marker string: the marker is in no answer, RPC argument or console line.
  const consoleLines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => { consoleLines.push(a.map(String).join(' ')); };
  const leaks: string[] = [];
  try {
    for (const raw of [
      `{"client_email": "${MARKER}@example.com", "private_key": "-----BEGIN PRIVATE KEY-----\\n${MARKER}`,
      JSON.stringify({ ...JSON.parse(KEY), private_key: `-----BEGIN PRIVATE KEY-----\n${MARKER}\n-----END PRIVATE KEY-----\n` }),
      `${MARKER} ${MARKER}`,
      Buffer.from(`{"private_key": "${MARKER}"`).toString('base64'),
    ]) {
      s = setup({ env: { GOOGLE_SA_JSON: raw }, calendars: [calRow(CAL.taylor)] });
      const a = await run(s);
      const b = await run(s, asUser({ action: 'calendar_test', calendar_id: CAL.taylor.id }));
      const seen = JSON.stringify([a, b, s.st.calls]);
      if (seen.includes(MARKER) || a.body.stop !== 'config' || b.body.stop !== 'config') leaks.push(seen.slice(0, 200));
    }
  } finally {
    Object.assign(console, saved);
  }
  check('a malformed secret with a marker in it: config every time, and the marker is in no answer or RPC argument', leaks.length === 0, leaks.join(' | '));
  check('... nor on the console (nothing is logged at all)', consoleLines.length === 0, consoleLines.join(' | '));
  check('readServiceAccount keeps the key id only when it looks like one',
    'key' in readServiceAccount(keyFile({ private_key_id: `${MARKER}"<x>` })) && (readServiceAccount(keyFile({ private_key_id: `${MARKER}"<x>` })) as any).key.private_key_id === null);

  // Google refuses the key.
  s = setup({ due: [dueRow(CAL.taylor)] });
  s.G.tokenAnswer = { status: 400, body: { error: 'invalid_grant', error_description: `Invalid JWT: account ${MARKER} not found` } };
  r = await run(s);
  check('Google refuses the key → 500, stop auth with the fixed message (never Google\'s words)',
    r.status === 500 && r.body.stop === 'auth' && r.body.error === KEY_REFUSED && s.finish()?.p_stop === 'auth' && !JSON.stringify([r, s.st.calls]).includes(MARKER), r.body);
  check('... nothing read or written, and not "signed in"', s.G.calls.length === 0 && !s.rpcs('calendar_signed_in').length && !s.rpcs('calendar_read_due').length);
  s = setup();
  s.G.tokenAnswer = { status: 503, body: {} };
  r = await run(s);
  check('the sign-in doesn\'t answer (5xx twice) → stop error, tried once more after a second', r.status === 500 && r.body.stop === 'error' && s.G.tokenReqs.length === 2 && s.sleeps.includes(1000), r.body);

  // -------------------------------------------------------------------
  // Tokens (§6.1): cached until 5 minutes before they run out, keyed by the credential
  // -------------------------------------------------------------------
  s = setup();
  await run(s);
  await run(s);
  check('a warm function reuses the token: two runs, one token request', s.G.tokenReqs.length === 1, s.G.tokenReqs.length);
  s.clock.t = NOW + (3599 - 300) * 1000 - 1000;
  await run(s);
  check('... still within its life less 5 minutes: no new token', s.G.tokenReqs.length === 1, s.G.tokenReqs.length);
  s.clock.t = NOW + (3599 - 300) * 1000 + 1000;
  await run(s);
  check('... 5 minutes before it runs out: a new token', s.G.tokenReqs.length === 2, s.G.tokenReqs.length);
  s.env.GOOGLE_SA_JSON = keyFile({ private_key: PEM2, private_key_id: 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5' });
  await run(s);
  check('a changed secret never gets the old token', s.G.tokenReqs.length === 3 && s.G.tokenReqs[2].valid, s.G.tokenReqs.length);
  await run(s);
  check('... and its own token is then reused', s.G.tokenReqs.length === 3, s.G.tokenReqs.length);
  resetTokenCache();
  await run(s);
  check('resetTokenCache() forgets it', s.G.tokenReqs.length === 4, s.G.tokenReqs.length);

  // -------------------------------------------------------------------
  // Who may ask (§3.4 step 1)
  // -------------------------------------------------------------------
  s = setup();
  r = await run(s, cron({ action: 'calendar' }, null));
  check('calendar without x-hub-cron or a sign-in → 401 {"error":"Not allowed."} (the smoke check), nothing touched',
    r.status === 401 && JSON.stringify(r.body) === '{"error":"Not allowed."}' && s.st.calls.length === 0 && s.G.tokenReqs.length === 0, r);
  r = await run(s, cron({ action: 'calendar' }, SECRET.slice(0, -1) + 'x'));
  const wrongLen = await run(s, cron({ action: 'calendar' }, SECRET + 'x'));
  check('a wrong x-hub-cron (same length, longer) → 401', r.status === 401 && wrongLen.status === 401 && s.st.calls.length === 0, `${r.status} ${wrongLen.status}`);
  s = setup({ env: { HUB_CRON_SECRET: 'short-secret-31-characters-long' } });
  r = await run(s, cron({ action: 'calendar' }, 'short-secret-31-characters-long'));
  check('HUB_CRON_SECRET under 32 characters → 503, nothing touched', r.status === 503 && s.st.calls.length === 0, r);
  s = setup({ due: [dueRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  r = await run(s);
  check('pg_cron (x-hub-cron) → a run; reads only what is due (p_force false)',
    r.status === 200 && JSON.stringify(s.rpcs('calendar_read_due')[0]?.args) === JSON.stringify({ p_force: false, p_limit: 10 }), s.rpcs('calendar_read_due')[0]?.args);
  s = setup({ due: [dueRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  r = await run(s, asUser({ action: 'calendar' }));
  check('a signed-in admin → Sync now: a run that forces reads (p_force true)',
    r.status === 200 && s.rpcs('calendar_read_due')[0]?.args.p_force === true && s.rpcs('whoami')[0]?.who === 'user:Bearer admin-jwt', s.rpcs('calendar_read_due')[0]?.args);
  s = setup({ me: { email: 'sam@example.com', name: 'Sam Example', role: 'member', person: null } });
  r = await run(s, asUser({ action: 'calendar' }, 'Bearer member-jwt'));
  const r2 = await run(s, asUser({ action: 'calendar_test', calendar_id: CAL.taylor.id }, 'Bearer member-jwt'));
  check('a member gets 403 for Sync now and Test, and nothing runs',
    r.status === 403 && r2.status === 403 && !s.st.calls.some((c) => c.fn.startsWith('calendar_')) && s.G.tokenReqs.length === 0, `${r.status} ${r2.status}`);
  s = setup({ me: null });
  r = await run(s, asUser({ action: 'calendar' }, 'Bearer stranger-jwt'));
  check('a signed-in stranger (whoami null) → 403', r.status === 403 && !s.rpcs('calendar_begin').length, r);
  s = setup({ calendars: [calRow(CAL.taylor)] });
  r = await run(s, cron({ action: 'calendar_test', calendar_id: CAL.taylor.id }));
  check('the cron secret does not open calendar_test → 401', r.status === 401 && s.st.calls.length === 0, r);
  s = setup({ env: { SUPABASE_SECRET_KEYS: undefined } });
  r = await run(s);
  check('no service-role key → 503, nothing runs', r.status === 503 && s.st.calls.length === 0, r);
  s = setup({ plan: [planRow('insert', CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  r = await run(s, cron({ action: 'calendar', p_force: true, calendar_id: CAL.jordan.id, google_calendar: 'someone@example.com' }));
  check('the body is ignored except for action: nothing in it reaches the database or Google',
    r.status === 200 && s.rpcs('calendar_read_due')[0]?.args.p_force === false && !JSON.stringify(s.st.calls).includes('someone@example.com')
    && s.G.calls.every((c) => c.cal === CAL.taylor.google), s.rpcs('calendar_read_due')[0]?.args);

  // -------------------------------------------------------------------
  // Stops (§3.4)
  // -------------------------------------------------------------------
  s = setup({ env: { GOOGLE_SA_JSON: undefined }, due: [dueRow(CAL.taylor)], plan: [planRow('insert', CAL.taylor)] });
  r = await run(s);
  check('GOOGLE_SA_JSON not set → 200 {stop: not_set_up}; Google is never called',
    r.status === 200 && r.body.stop === 'not_set_up' && s.G.tokenReqs.length === 0 && s.G.calls.length === 0 && s.G.other.length === 0, r.body);
  check('... calendar_finish records not_set_up (which forgets the account), nothing read or planned',
    s.finish()?.p_stop === 'not_set_up' && s.finish()?.p_run === RUN && !s.rpcs('calendar_read_due').length && !s.rpcs('calendar_plan').length, s.finish());
  s = setup({ env: { GOOGLE_SA_JSON: '   ' } });
  r = await run(s);
  check('a blank GOOGLE_SA_JSON is not set up either', r.body.stop === 'not_set_up' && s.G.tokenReqs.length === 0, r.body);
  s = setup({ begin: { go: false, stop: 'busy', run_id: null } });
  r = await run(s);
  check('another run holds the lease → 200 {stop: busy}; nothing else happens (no finish: the lease isn\'t ours)',
    r.status === 200 && r.body.stop === 'busy' && s.st.calls.length === 1 && s.G.tokenReqs.length === 0, r);
  s = setup({ begin: { go: false, stop: 'paused', run_id: null } });
  r = await run(s);
  check('Google\'s pause → 200 {stop: paused}; nothing else happens', r.status === 200 && r.body.stop === 'paused' && s.st.calls.length === 1 && s.G.tokenReqs.length === 0, r);
  s = setup({ noSchema: true });
  r = await run(s);
  const t503 = await run(s, asUser({ action: 'calendar_test', calendar_id: CAL.taylor.id }));
  check('no migration 0003 → 503 {stop: no_schema} for calendar and calendar_test; Google never called',
    r.status === 503 && r.body.stop === 'no_schema' && t503.status === 503 && t503.body.stop === 'no_schema' && s.G.tokenReqs.length === 0, `${JSON.stringify(r)} ${JSON.stringify(t503)}`);
  s = setup({ failRpc: { calendar_begin: 'permission denied for function calendar_begin' } });
  r = await run(s);
  check('calendar_begin fails otherwise → 500 stop error, with a fixed message', r.status === 500 && r.body.stop === 'error'
    && r.body.error === 'The run stopped with a database error (calendar_begin).', r);
  s = setup({ failRpc: { calendar_plan: `canceling statement due to statement timeout ${MARKER}` }, plan: [planRow('insert', CAL.taylor)] });
  r = await run(s);
  check('a database error mid-run → 500 stop error, recorded with calendar_finish as a fixed message naming the step',
    r.status === 500 && r.body.stop === 'error' && s.finish()?.p_stop === 'error' && s.finish()?.p_error === 'The run stopped with a database error (calendar_plan).'
    && r.body.error === s.finish()?.p_error, s.finish());
  check('... the database\'s own words reach neither calendar_sync.last_error (members read it) nor pg_net\'s log', !JSON.stringify([r, s.finish()]).includes(MARKER));
  for (const step of ['calendar_signed_in', 'calendar_read_due', 'calendar_store_events', 'calendar_record']) {
    s = setup({ failRpc: { [step]: `boom ${MARKER}` }, due: [dueRow(CAL.taylor)], plan: [planRow('insert', CAL.taylor)] });
    s.cal(CAL.taylor.google, 'Hub – Taylor');
    r = await run(s);
    check(`a database error in ${step} → stop error with "(${step})", no Google call after it`,
      r.status === 500 && s.finish()?.p_error === `The run stopped with a database error (${step}).` && !JSON.stringify(r).includes(MARKER)
      && (step !== 'calendar_signed_in' || s.G.calls.length === 0) && (step !== 'calendar_read_due' || s.G.calls.length === 0), { body: r.body, calls: s.G.calls.length });
  }
  s = setup({ failRpc: { calendar_finish: 'connection lost' } });
  r = await run(s);
  check('calendar_finish fails → 500', r.status === 500 && r.body.error === 'The run stopped with a database error (calendar_finish).', r);

  // The reads' 20 seconds, checked before every page: a calendar whose pages each take 11 seconds.
  s = setup({ due: [dueRow(CAL.taylor), dueRow(CAL.jordan)], plan: [planRow('insert', CAL.taylor)] });
  const slowCal = s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.cal(CAL.jordan.google, 'Hub – Jordan');
  for (let i = 0; i < 9; i++) slowCal.events.set(`g${i}`, { id: `g${i}`, status: 'confirmed', summary: `Practice ${i}`, start: { date: `2026-11-1${i}` }, end: { date: `2026-11-1${i + 1}` }, organizer: { self: true }, updated: '2026-10-01T00:00:00Z' });
  s.G.pageSize = 2;
  s.G.latency = 11000;
  r = await run(s);
  const gets = s.G.calls.filter((c) => c.method === 'GET');
  check(`${READ_BUDGET_MS / 1000} seconds for reads: no page starts after them (11 s pages: 2 of 5), and no call at all starts after 30 s`,
    gets.length === 2 && gets.every((c) => c.at < NOW + READ_BUDGET_MS) && s.G.calls.every((c) => c.at < NOW + RUN_BUDGET_MS), s.G.calls.map((c) => `${c.method}@${c.at - NOW}`));
  check('... what was read is stored as a cut-off read (p_complete false); the next calendar waits',
    s.rpcs('calendar_store_events').length === 1 && s.rpcs('calendar_store_events')[0].args.p_complete === false && s.rpcs('calendar_store_events')[0].args.p_events.length === 4, s.rpcs('calendar_store_events').map((c) => c.args.p_complete));
  check('... the writes still get the rest of the run: the insert is done, and the run isn\'t stopped',
    r.status === 200 && r.body.stop === null && r.body.ok === true && r.body.inserted === 1 && s.G.calls.at(-1)?.method === 'POST' && s.finish()?.p_stop === null && s.finish()?.p_result.pending === 0, r.body);

  // A calendar whose list call hangs costs one timeout (it isn't tried again), never the writes.
  timeouts.length = 0;
  const hidePriv = planRow('update', CAL.taylor, { private: true });
  s = setup({ due: [dueRow(CAL.jordan), dueRow(CAL.family), dueRow(CAL.taylor)], plan: [hidePriv], calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.jordan.google, 'Hub – Jordan');
  s.cal(CAL.family.google, 'Hub – Family');
  s.cal(CAL.taylor.google, 'Hub – Taylor').events.set(hidePriv.event_id, { id: hidePriv.event_id, summary: 'Piano' });
  s.G.script.push({ when: (c) => c.method === 'GET' && (c.cal === CAL.jordan.google || c.cal === CAL.family.google), hang: true, times: 4 });
  r = await run(s);
  const listCalls = (cal: string) => s.G.calls.filter((c) => c.method === 'GET' && c.cal === cal).length;
  check('a list call that hangs is not tried again: one call for each of two hanging calendars',
    listCalls(CAL.jordan.google) === 1 && listCalls(CAL.family.google) === 1, { jordan: listCalls(CAL.jordan.google), family: listCalls(CAL.family.google) });
  check(`... the second one's timeout is cut to what is left of the reads' ${READ_BUDGET_MS / 1000} seconds, so the reads end on time`,
    timeouts.some((ms) => ms < 15000) && timeouts.every((ms) => ms <= 15000) && s.G.calls.filter((c) => c.method === 'GET').every((c) => c.at < NOW + READ_BUDGET_MS)
    && s.clock.t - NOW < RUN_BUDGET_MS, { timeouts, calls: s.G.calls.map((c) => `${c.method}@${c.at - NOW}`) });
  check('... and the write that makes an item private still goes through in the same run (nothing left to hide)',
    r.status === 200 && r.body.stop === null && r.body.updated === 1 && s.finish()?.p_result.hiding === 0 && s.finish()?.p_result.pending === 0
    && s.G.calls.some((c) => c.method === 'PUT' && c.event === hidePriv.event_id && c.at < NOW + RUN_BUDGET_MS), { body: r.body, calls: s.G.calls.map((c) => `${c.method}@${c.at - NOW}`) });
  check('... nothing is stored for a calendar whose read timed out, and its status is left alone',
    !s.rpcs('calendar_store_events').some((c) => c.args.p_calendar === CAL.jordan.id || c.args.p_calendar === CAL.family.id) && !s.rpcs('calendar_mark').length,
    s.rpcs('calendar_store_events').map((c) => c.args.p_calendar));

  // ... and before every op: writes that take 7 seconds each.
  s = setup({ plan: Array.from({ length: 10 }, (_, i) => planRow('insert', CAL.taylor, { day: `2026-11-1${i}` })) });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.latency = 7000;
  r = await run(s);
  check('30 seconds: ops stop at the budget (7 s each: 5 of 10), none starts after it',
    s.G.calls.length === 5 && s.G.calls.every((c) => c.at < NOW + RUN_BUDGET_MS) && r.body.stop === 'time' && r.body.inserted === 5, s.G.calls.map((c) => c.at - NOW));
  check('... the 5 done are recorded; the rest stay pending for the next run',
    s.recorded().length === 5 && s.recorded().every((x: any) => x.ok === true) && s.finish()?.p_result.pending === 5, s.finish()?.p_result);
  s = setup({ plan: [planRow('insert', CAL.taylor, { event_id: hhId(9000) })] });
  const late409 = s.cal(CAL.taylor.google, 'Hub – Taylor');
  late409.deleted.set(hhId(9000), { id: hhId(9000) });
  s.G.latency = 29900;
  r = await run(s);
  check('an op whose second call would start after 30 s stops there, unrecorded (409, then no PUT)',
    s.G.calls.length === 1 && s.G.calls[0].method === 'POST' && s.recorded().length === 0 && r.body.stop === 'time', s.G.calls.map((c) => c.method));

  // -------------------------------------------------------------------
  // Read (§5.1)
  // -------------------------------------------------------------------
  s = setup({ due: [dueRow(CAL.jordan)] });
  const jordan = s.cal(CAL.jordan.google, 'Hub – Jordan');
  const hubId = hhId(77);
  jordan.events.set('typed1', {
    id: 'typed1', status: 'confirmed', summary: 'Soccer practice', location: 'Field 3, 12 Elm St', start: { dateTime: '2026-11-04T21:30:00Z' }, end: { dateTime: '2026-11-04T23:00:00Z' },
    organizer: { email: 'jordan.parent@example.com', self: true }, creator: { email: 'morgan@example.com' }, updated: '2026-11-01T10:00:00.000Z', description: 'Bring cleats and 555-0177',
    attendees: [{ email: 'coach@example.com', responseStatus: 'accepted' }],
  });
  jordan.events.set('invite1', {
    id: 'invite1', status: 'confirmed', summary: 'Team dinner', start: { date: '2026-11-06' }, end: { date: '2026-11-07' }, visibility: 'private',
    organizer: { email: 'coach@example.com' }, attendees: [{ email: 'coach@example.com', organizer: true, responseStatus: 'accepted' }, { email: CAL.jordan.google, self: true, responseStatus: 'needsAction' }],
    recurringEventId: 'series9', updated: '2026-11-01T11:00:00.000Z', extendedProperties: { private: { note: 'x' } },
  });
  jordan.events.set(hubId, { id: hubId, status: 'confirmed', summary: 'Piano', start: { date: '2026-11-03' }, end: { date: '2026-11-04' }, organizer: { self: true }, updated: '2026-11-01T12:00:00.000Z', extendedProperties: { private: { homehub: '1', homehub_base: hubId } } });
  jordan.events.set('copyOfHub', { id: 'copyOfHub', status: 'confirmed', summary: 'Piano (copy)', start: { date: '2026-11-05' }, end: { date: '2026-11-06' }, organizer: { self: true }, updated: '2026-11-01T12:00:00.000Z', extendedProperties: { private: { homehub: '1', homehub_base: hubId } } });
  r = await run(s);
  const list = s.G.calls.find((c) => c.method === 'GET' && c.cal === CAL.jordan.google);
  const qp = list?.query;
  check('the read asks for single events in start order, without deleted ones, 2500 a page, regular events only',
    qp?.get('singleEvents') === 'true' && qp.get('orderBy') === 'startTime' && qp.get('showDeleted') === 'false' && qp.get('maxResults') === '2500' && qp.get('eventTypes') === 'default', qp?.toString());
  check('... from timeMin to timeMax (calendar_read_due\'s, as RFC 3339) in the household\'s zone',
    qp?.get('timeMin') === '2026-11-01T04:00:00.000Z' && qp.get('timeMax') === '2027-01-02T05:00:00.000Z' && qp.get('timeZone') === TZ, qp?.toString());
  check('... with exactly the fields list (no email address, no description)',
    qp?.get('fields') === 'accessRole,summary,nextPageToken,items(id,status,summary,location,start,end,visibility,recurringEventId,updated,organizer/self,attendees(self,responseStatus),extendedProperties/private)'
    && qp.get('fields') === READ_FIELDS && !/email|description/.test(qp.get('fields')!), qp?.get('fields'));
  const store = s.rpcs('calendar_store_events')[0]?.args;
  check('calendar_store_events gets the calendar, its Google ID, the window, Google\'s name and access role, complete',
    store?.p_calendar === CAL.jordan.id && store.p_google_id === CAL.jordan.google && store.p_from === '2026-11-01' && store.p_to === '2027-01-01'
    && store.p_name === 'Hub – Jordan' && store.p_access === 'writer' && store.p_complete === true, store && { ...store, p_events: undefined, p_seen: undefined });
  check('hub events (homehub and an hh id) are sent as seen; a homehub event with another id (a Duplicate) as an ordinary one',
    store?.p_seen.map((e: any) => e.id).join() === hubId && store.p_events.map((e: any) => e.id).sort().join() === 'copyOfHub,invite1,typed1', store && [store.p_seen.map((e: any) => e.id), store.p_events.map((e: any) => e.id)]);
  const typed = store?.p_events.find((e: any) => e.id === 'typed1');
  check('each event is mapped to {id, status, title, location, start, end, visibility, recurring, updated, organizer_self, response, props, hash}',
    !!typed && Object.keys(typed).sort().join() === 'end,hash,id,location,organizer_self,props,recurring,response,start,status,title,updated,visibility'
    && typed.title === 'Soccer practice' && typed.location === 'Field 3, 12 Elm St' && typed.start.dateTime === asLocal('2026-11-04T21:30:00Z') && typed.organizer_self === true
    && typed.recurring === false && typed.visibility === 'default' && typed.props === null && /^[0-9a-f]{64}$/.test(typed.hash), typed);
  const invite = store?.p_events.find((e: any) => e.id === 'invite1');
  check('... the calendar\'s own attendee answer, whether it repeats, its visibility and private properties',
    invite?.response === 'needsAction' && invite.organizer_self === false && invite.recurring === true && invite.visibility === 'private' && invite.props?.note === 'x' && invite.start.date === '2026-11-06', invite);
  const sent = JSON.stringify(s.rpcs('calendar_store_events'));
  check('no email address, description or attendee list goes to the database', !/@example\.com|Bring cleats|555-0177|coach/.test(sent), sent.slice(0, 300));
  check('the counts come back in the run\'s result', r.body.read === 1 && r.body.stored === 3 && s.finish()?.p_result.read === 1, r.body);

  // -------------------------------------------------------------------
  // Hearth people (docs/v1.1-google-calendar.md §11.3): a sorted calendar's guests, and only its Hearth tags
  // -------------------------------------------------------------------
  const sortedRow = (c: { id: string; google: string }) => ({ ...dueRow(c, false), sort_by_guest: true });
  const consoleHearth: string[] = [];
  const savedHearth = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(savedHearth) as (keyof typeof savedHearth)[]) console[k] = (...a: unknown[]) => { consoleHearth.push(a.map(String).join(' ')); };
  try {
    s = setup({ due: [sortedRow(CAL.hearth), { ...dueRow(CAL.main, false), sort_by_guest: false }, dueRow(CAL.jordan)] });
    const wall = s.cal(CAL.hearth.google, 'Hearth Calendar', 'reader');
    const guest = (email: unknown, o: Record<string, unknown> = {}) => ({ email, responseStatus: 'needsAction', ...o });
    wall.events.set('piano1', {
      id: 'piano1', status: 'confirmed', summary: 'Piano', start: { dateTime: '2026-11-04T21:30:00Z' }, end: { dateTime: '2026-11-04T22:15:00Z' },
      organizer: { email: CAL.hearth.google, self: true }, updated: '2026-11-01T10:00:00.000Z',
      attendees: [guest(' Jordan@Team-Example-0000 '), guest(CAL.hearth.google, { self: true, responseStatus: 'accepted' }), guest('morgan@example.com', { responseStatus: 'accepted' })],
    });
    wall.events.set('vet1', {
      id: 'vet1', status: 'confirmed', summary: 'Vet', start: { dateTime: '2026-11-05T21:30:00Z' }, end: { dateTime: '2026-11-05T22:00:00Z' },
      organizer: { email: CAL.hearth.google, self: true }, updated: '2026-11-01T10:00:00.000Z',
      attendees: [guest('taylor@team-example-0000'), guest('dogs@team-example-0000'), guest('taylor@team-example-0000'), guest('jordan@team-example-0000.com'),
        guest('sam@team.example'), guest(123), guest(null), { responseStatus: 'accepted' }, guest('pat lee@team-example-0000'), guest(`${MARKER}@team-example-0000`.toLowerCase())],
    });
    wall.events.set('movie1', { id: 'movie1', status: 'confirmed', summary: 'Movie', start: { date: '2026-11-06' }, end: { date: '2026-11-07' }, organizer: { email: CAL.hearth.google, self: true } });
    // A private event as Google shows it to a reader (See event details): no title, place or guests.
    wall.events.set('private1', { id: 'private1', status: 'confirmed', visibility: 'private', start: { dateTime: '2026-11-06T21:00:00Z' }, end: { dateTime: '2026-11-06T21:30:00Z' },
      organizer: { email: CAL.hearth.google, self: true } });
    const wallHub = hhId(78);
    wall.events.set(wallHub, { id: wallHub, status: 'confirmed', summary: 'Hub thing', start: { date: '2026-11-03' }, end: { date: '2026-11-04' }, organizer: { self: true },
      attendees: [guest('jordan@team-example-0000')], extendedProperties: { private: { homehub: '1', homehub_base: wallHub } } });
    const main = s.cal(CAL.main.google, 'Family', 'reader');
    main.events.set('club1', { id: 'club1', status: 'confirmed', summary: 'Book club', start: { date: '2026-11-04' }, end: { date: '2026-11-05' }, organizer: { self: true },
      attendees: [guest('jordan@team-example-0000'), guest('morgan@example.com')] });
    const jordanCal = s.cal(CAL.jordan.google, 'Hub – Jordan');
    jordanCal.events.set('soccer1', { id: 'soccer1', status: 'confirmed', summary: 'Soccer', start: { date: '2026-11-04' }, end: { date: '2026-11-05' }, organizer: { self: true },
      attendees: [guest('jordan@team-example-0000')] });
    r = await run(s);
    const listOf = (c: string) => s.G.calls.find((x) => x.method === 'GET' && x.cal === c && x.event === null)?.query;
    check('a sorted calendar (sort_by_guest true) is read with READ_FIELDS_GUESTS: READ_FIELDS with attendees(email,self,responseStatus)',
      listOf(CAL.hearth.google)?.get('fields') === READ_FIELDS.replace('attendees(self,responseStatus)', 'attendees(email,self,responseStatus)')
      && READ_FIELDS_GUESTS === READ_FIELDS.replace('attendees(self,responseStatus)', 'attendees(email,self,responseStatus)') && READ_FIELDS_GUESTS !== READ_FIELDS,
      listOf(CAL.hearth.google)?.get('fields'));
    check('... without maxAttendees (with it Google answers a longer guest list with only the calendar\'s own entry)',
      !!listOf(CAL.hearth.google) && !listOf(CAL.hearth.google)!.has('maxAttendees') && s.G.calls.every((x) => !x.query.has('maxAttendees')), listOf(CAL.hearth.google)?.toString());
    check('a calendar with sort_by_guest false is read with READ_FIELDS: no address asked for', listOf(CAL.main.google)?.get('fields') === READ_FIELDS, listOf(CAL.main.google)?.get('fields'));
    check('... and a schema-9 row (no sort_by_guest key) too', listOf(CAL.jordan.google)?.get('fields') === READ_FIELDS, listOf(CAL.jordan.google)?.get('fields'));
    const stores = Object.fromEntries(s.rpcs('calendar_store_events').map((c) => [c.args.p_calendar, c.args]));
    const hearthStore = stores[CAL.hearth.id];
    const byId = (list: any[], id: string) => list.find((e: any) => e.id === id);
    check('a sorted calendar\'s read: a guests key on every item of p_events',
      !!hearthStore && hearthStore.p_events.length === 4 && hearthStore.p_events.every((e: any) => Array.isArray(e.guests)), hearthStore?.p_events);
    check('... each its Hearth tags: trimmed, lowercased; the calendar\'s own entry and a real-looking address dropped',
      JSON.stringify(byId(hearthStore?.p_events ?? [], 'piano1')?.guests) === '["jordan@team-example-0000"]', byId(hearthStore?.p_events ?? [], 'piano1'));
    check('... duplicates once, sorted; a dot after the @, another shape, a non-string, a missing email and a space dropped',
      JSON.stringify(byId(hearthStore?.p_events ?? [], 'vet1')?.guests) === `["dogs@team-example-0000","${MARKER.toLowerCase()}@team-example-0000","taylor@team-example-0000"]`,
      byId(hearthStore?.p_events ?? [], 'vet1'));
    check('... [] for an event with no guest list, and for a private one as Google sends it to a reader',
      JSON.stringify(byId(hearthStore?.p_events ?? [], 'movie1')?.guests) === '[]' && JSON.stringify(byId(hearthStore?.p_events ?? [], 'private1')?.guests) === '[]');
    check('... the other keys as for any calendar', Object.keys(byId(hearthStore?.p_events ?? [], 'piano1') ?? {}).sort().join()
      === 'end,guests,hash,id,location,organizer_self,props,recurring,response,start,status,title,updated,visibility');
    check('... no guests key on its p_seen (the hub\'s own)', hearthStore?.p_seen.length === 1 && hearthStore.p_seen.every((e: any) => !('guests' in e)), hearthStore?.p_seen);
    check('no guests key on any item of a calendar that isn\'t sorted (sort_by_guest false, or a schema-9 row)',
      [stores[CAL.main.id], stores[CAL.jordan.id]].every((a) => !!a && a.p_events.length === 1 && [...a.p_events, ...a.p_seen].every((e: any) => !('guests' in e))),
      [stores[CAL.main.id]?.p_events, stores[CAL.jordan.id]?.p_events]);
    const allArgs = JSON.stringify(s.st.calls);
    check('a real-looking address on an event (morgan@example.com) is in no RPC argument, nor any address that isn\'t a tag',
      !/morgan|team\.example|team-example-0000\.com|pat lee/i.test(allArgs) && !allArgs.includes(`"${CAL.hearth.google}"]`), allArgs.slice(0, 300));
    check('... nor in the run\'s answer', !/@example\.com|team-example/.test(JSON.stringify(r.body)) && r.body.read === 3 && r.body.stop === null, r.body);
  } finally {
    Object.assign(console, savedHearth);
  }
  check('... and nothing goes to the console', consoleHearth.length === 0, consoleHearth.join(' | '));

  // hearthTags on its own: the pattern of private.hearth_tag(p_email), the first 100 entries, 16 at most.
  check('HEARTH_TAG is private.hearth_tag\'s pattern', HEARTH_TAG.source === '^[a-z0-9._+-]{1,64}@team-[a-z0-9-]{1,120}$' && HEARTH_TAG.flags === '', HEARTH_TAG.source);
  check('hearthTags: not a list → []', JSON.stringify([hearthTags(undefined), hearthTags(null), hearthTags('jordan@team-example-0000'), hearthTags({ email: 'x' })]) === '[[],[],[],[]]');
  check('hearthTags: trimmed and lowercased, kept exactly so, or dropped', JSON.stringify(hearthTags([{ email: '\tSAM@TEAM-EXAMPLE-0000\n' }, { email: 'Sam@Team-Example-0001' }]))
    === '["sam@team-example-0000","sam@team-example-0001"]');
  check('hearthTags: the calendar\'s own entry (self true) is skipped, even when it is shaped like a tag',
    JSON.stringify(hearthTags([{ email: 'jordan@team-example-0000', self: true }, { email: 'sam@team-example-0000', self: false }])) === '["sam@team-example-0000"]');
  check('hearthTags: a dot after the @, a domain that isn\'t team-…, too long a profile, an empty or non-string email are dropped',
    JSON.stringify(hearthTags([{ email: 'jordan@team-example-0000.com' }, { email: 'jordan@example.com' }, { email: `${'a'.repeat(65)}@team-example-0000` },
      { email: '' }, { email: 42 }, { email: ['jordan@team-example-0000'] }, null, 'jordan@team-example-0000', { email: 'jordan@team-' }, { email: `a@team-${'b'.repeat(121)}` }])) === '[]');
  const tags101 = Array.from({ length: 101 }, (_, i) => ({ email: i === 100 ? 'aaa@team-example-0000' : `x${String(i).padStart(3, '0')}@team-example-0000` }));
  check('hearthTags: only the first 100 entries are read', !hearthTags(tags101).includes('aaa@team-example-0000'));
  const tags20 = Array.from({ length: 20 }, (_, i) => ({ email: `kid${String(20 - i).padStart(2, '0')}@team-example-0000` }));
  check('hearthTags: duplicates once, sorted, the first 16', JSON.stringify(hearthTags([...tags20, ...tags20]))
    === JSON.stringify(Array.from({ length: 16 }, (_, i) => `kid${String(i + 1).padStart(2, '0')}@team-example-0000`)), hearthTags(tags20));

  // Pages, and more than 4 pages.
  s = setup({ due: [dueRow(CAL.taylor)] });
  const paged = s.cal(CAL.taylor.google, 'Hub – Taylor');
  for (let i = 0; i < 5; i++) paged.events.set(`p${i}`, { id: `p${i}`, status: 'confirmed', summary: `Swim ${i}`, start: { date: `2026-11-0${i + 3}` }, end: { date: `2026-11-0${i + 4}` }, organizer: { self: true } });
  s.G.pageSize = 2;
  await run(s);
  const pageCalls = s.G.calls.filter((c) => c.method === 'GET');
  check('pages are followed with nextPageToken (5 events, 2 a page: 3 pages), one store with all of them, complete',
    pageCalls.length === 3 && pageCalls[1].query.get('pageToken') === 'p2' && pageCalls[2].query.get('pageToken') === 'p4'
    && s.rpcs('calendar_store_events').length === 1 && s.rpcs('calendar_store_events')[0].args.p_events.length === 5 && s.rpcs('calendar_store_events')[0].args.p_complete === true,
    pageCalls.map((c) => c.query.get('pageToken')));
  s = setup({ due: [dueRow(CAL.taylor)] });
  const many = s.cal(CAL.taylor.google, 'Hub – Taylor');
  for (let i = 0; i < 9; i++) many.events.set(`m${i}`, { id: `m${i}`, status: 'confirmed', summary: `Swim ${i}`, start: { date: `2026-11-1${i}` }, end: { date: `2026-11-1${i}` }, organizer: { self: true } });
  s.G.pageSize = 2;
  await run(s);
  check('more than 4 pages: 4 are read and stored with p_complete false',
    s.G.calls.filter((c) => c.method === 'GET').length === 4 && s.rpcs('calendar_store_events')[0]?.args.p_complete === false && s.rpcs('calendar_store_events')[0]?.args.p_events.length === 8,
    s.rpcs('calendar_store_events')[0]?.args.p_complete);

  // A failed page stores nothing, and a glitch never changes the calendar's status.
  s = setup({ due: [dueRow(CAL.taylor), dueRow(CAL.jordan)] });
  const flaky = s.cal(CAL.taylor.google, 'Hub – Taylor');
  for (let i = 0; i < 5; i++) flaky.events.set(`f${i}`, { id: `f${i}`, status: 'confirmed', summary: `Swim ${i}`, start: { date: `2026-11-0${i + 3}` }, end: { date: `2026-11-0${i + 4}` }, organizer: { self: true } });
  s.cal(CAL.jordan.google, 'Hub – Jordan');
  s.G.pageSize = 2;
  s.G.script.push({ when: (c) => c.cal === CAL.taylor.google && c.query.get('pageToken') === 'p2', status: 503, body: gErr(503, 'backendError', 'Backend Error'), times: 2 });
  r = await run(s);
  check('a page that fails (5xx, then 5xx again a second later) → nothing stored for that calendar, no status change',
    !s.rpcs('calendar_store_events').some((c) => c.args.p_calendar === CAL.taylor.id) && !s.rpcs('calendar_mark').length && s.sleeps.includes(1000), s.rpcs('calendar_store_events').map((c) => c.args.p_calendar));
  check('... the next calendar is still read and stored, and the run is ok',
    s.rpcs('calendar_store_events').some((c) => c.args.p_calendar === CAL.jordan.id) && r.body.stop === null && r.status === 200, r.body);
  s = setup({ due: [dueRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: (c) => c.method === 'GET', error: new TypeError('fetch failed'), times: 1 });
  r = await run(s);
  check('a network error is tried once more after a second, then the read goes on', s.rpcs('calendar_store_events').length === 1 && s.sleeps.includes(1000), s.sleeps);

  // A read Google refuses: the calendar can't be reached.
  s = setup({ due: [dueRow(CAL.taylor), dueRow(CAL.main, false), dueRow(CAL.holidays, false)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor', 'none');
  s.cal(CAL.main.google, 'Family', 'freeBusyReader');
  s.cal(CAL.holidays.google, 'Holidays', 'reader');
  s.G.script.push({ when: (c) => c.cal === CAL.main.google, status: 403, body: gErr(403, 'forbidden', 'Forbidden') });
  r = await run(s);
  const marks = s.rpcs('calendar_mark').map((c) => c.args);
  check('a read that gets 404 → calendar_mark no_access: "No calendar with this ID, or it isn\'t shared with <account>."',
    marks.some((m) => m.p_calendar === CAL.taylor.id && m.p_google_id === CAL.taylor.google && m.p_status === 'no_access' && m.p_detail === `No calendar with this ID, or it isn't shared with ${ACCOUNT}.`), marks);
  check('a read that gets 403 forbidden on a calendar the hub only reads → no_access, share it with See event details',
    marks.some((m) => m.p_calendar === CAL.main.id && m.p_status === 'no_access' && m.p_detail === `Home Hub can't read this calendar. In Google Calendar, share it with ${ACCOUNT} and choose See event details.`), marks);
  const hol = s.G.calls.find((c) => c.cal === CAL.holidays.google);
  check('calendar ids are URL-encoded (a holiday calendar\'s #, the @)',
    !!hol && hol.path === `/calendar/v3/calendars/${encodeURIComponent(CAL.holidays.google)}/events` && hol.path.includes('%23') && hol.path.includes('%40'), hol?.path);
  s = setup({ due: [dueRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: () => true, status: 403, body: gErr(403, 'cannotReadThis', `Something about ${MARKER}`) });
  await run(s);
  check('a read refused for another reason → error, with a fixed message and Google\'s reason (never its message: members can read it)',
    s.rpcs('calendar_mark')[0]?.args.p_status === 'error' && s.rpcs('calendar_mark')[0]?.args.p_detail === 'Google refused to use this calendar (403 cannotReadThis).'
    && !s.rpcs('calendar_store_events').length, s.rpcs('calendar_mark')[0]?.args);
  s = setup({ due: [dueRow(CAL.taylor), dueRow(CAL.holidays, false)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor', 'none');
  s.cal(CAL.holidays.google, 'Holidays', 'reader');
  r = await run(s);
  check('... and the readable one is stored', s.rpcs('calendar_store_events').length === 1 && s.rpcs('calendar_store_events')[0].args.p_calendar === CAL.holidays.id && r.body.stop === null);

  // The content hash: the same for a write's answer and a read of the same event.
  s = setup({ plan: [planRow('insert', CAL.taylor, { timed: true, location: 'Rivera Music, 12 Elm St' })] });
  const hashCal = s.cal(CAL.taylor.google, 'Hub – Taylor');
  await run(s);
  const writtenHash = s.recorded()[0]?.google_hash;
  s.st.plan = [];
  s.st.due = [dueRow(CAL.taylor)];
  await run(s);
  const readBack = s.rpcs('calendar_store_events')[0]?.args.p_seen[0];
  check('the content hash of a write\'s answer and of a read of the same event agree (times as instants, default visibility left out)',
    !!writtenHash && readBack?.hash === writtenHash && readBack.start.dateTime.endsWith('-05:00'), { writtenHash, readBack });
  const e0 = [...hashCal.events.values()][0];
  const h1 = await contentHash({ ...e0, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] }, colorId: '5', updated: '2027-01-01T00:00:00Z' });
  const h2 = await contentHash({ ...e0, summary: 'Piano (moved)' });
  check('... reminders, colour and "updated" don\'t change it; the title does', h1 === writtenHash && h2 !== writtenHash);
  check('... all-day dates count as written; a missing status or visibility as Google\'s default',
    (await contentHash({ summary: 'x', start: { date: '2026-11-03' }, end: { date: '2026-11-04' } })) === (await contentHash({ summary: 'x', start: { date: '2026-11-03' }, end: { date: '2026-11-04' }, visibility: 'default', status: 'confirmed' }))
    && (await contentHash({ summary: 'x', start: { date: '2026-11-03' } })) !== (await contentHash({ summary: 'x', start: { date: '2026-11-04' } })));

  // -------------------------------------------------------------------
  // Write (§3.3, §3.5)
  // -------------------------------------------------------------------
  const ins = planRow('insert', CAL.taylor, { timed: true, title: 'Piano (con Jordan)' });
  s = setup({ plan: [ins] });
  const tcal = s.cal(CAL.taylor.google, 'Hub – Taylor');
  r = await run(s);
  const post = s.G.calls[0];
  check('insert: POST …/events with the plan\'s body as it is, sendUpdates=none',
    post?.method === 'POST' && post.path === `/calendar/v3/calendars/${encodeURIComponent(CAL.taylor.google)}/events` && JSON.stringify(post.body) === JSON.stringify(ins.body)
    && post.query.get('sendUpdates') === 'none', post && { m: post.method, p: post.path, q: post.query.toString() });
  const rec = s.recorded()[0];
  check('... recorded: the plan row as it came, with ok, google_hash and google_updated (Google\'s, RFC 3339)',
    !!rec && rec.ok === true && rec.gone === false && rec.clash === false && rec.forget === false && rec.http === 200 && rec.error === null
    && rec.google_updated === tcal.events.get(ins.event_id).updated && /^[0-9a-f]{64}$/.test(rec.google_hash)
    && Object.keys(ins).filter((k) => k !== 'pending' && k !== 'hiding').every((k) => JSON.stringify(rec[k]) === JSON.stringify((ins as any)[k])), rec);
  check('... the plan is asked with siteBase(SITE_URL) and 60 at most', JSON.stringify(s.rpcs('calendar_plan')[0]?.args) === JSON.stringify({ p_site: 'https://family.example/hub/', p_limit: 60 }), s.rpcs('calendar_plan')[0]?.args);
  check('... counted: inserted 1, pending 0', r.body.inserted === 1 && r.body.pending === 0 && r.body.failed === 0 && s.finish()?.p_result.inserted === 1, r.body);
  s = setup({ env: { SITE_URL: undefined }, plan: [planRow('insert', CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  r = await run(s);
  check('without SITE_URL the plan gets p_site null (events have no link) and nothing stops', s.rpcs('calendar_plan')[0]?.args.p_site === null && r.body.stop === null && r.body.inserted === 1, r.body);

  // A dinner (v1.2, docs/v1.2-kitchen.md §10): migration 0004's plan rows of item_kind 'meal', all day on
  // Hub – Family. hub-jobs has nothing of its own for them: the body goes to Google as it is, and the
  // row comes back to calendar_record unchanged, through an insert, an update (locked) and a delete.
  const mealPlan = (op: 'insert' | 'update' | 'delete', base: any = null) => {
    const r: any = base ? { ...base, op } : planRow('insert', CAL.family, { title: 'Dinner: Tacos (Sam)', day: '2026-11-03' });
    r.op = op;
    r.item_kind = 'meal';
    if (op === 'delete') return { ...r, body: null, hash: null };
    const locked = op === 'update';
    r.title = locked ? 'Dinner: Private item' : 'Dinner: Tacos (Sam)';
    r.body = {
      ...r.body, summary: r.title, visibility: locked ? 'private' : 'default',
      description: locked ? 'Made by Home Hub: changes made here are undone. Change it in Home Hub.\nOpen in Home Hub: https://family.example/hub/#/food'
        : 'Made by Home Hub: changes made here are undone. Change it in Home Hub.\nSam cooks\nOpen in Home Hub: https://family.example/hub/#/food',
      extendedProperties: { private: { ...r.body.extendedProperties.private, homehub_kind: 'meal' } },
    };
    r.hash = `hash-meal-${op}`;
    return r;
  };
  const sameRow = (rec: any, row: any) => !!rec && Object.keys(row).filter((k) => k !== 'pending' && k !== 'hiding').every((k) => JSON.stringify(rec[k]) === JSON.stringify(row[k]));
  const mIns = mealPlan('insert');
  s = setup({ plan: [mIns] });
  const fam = s.cal(CAL.family.google, 'Hub – Family');
  r = await run(s);
  const mPost = s.G.calls.find((c) => c.method === 'POST');
  check('a dinner (item_kind meal): POSTed to Hub – Family with the plan\'s body as it is (all day, not busy)',
    r.status === 200 && r.body.inserted === 1 && mPost?.cal === CAL.family.google && JSON.stringify(mPost.body) === JSON.stringify(mIns.body)
    && mIns.body.start.date === '2026-11-03' && mIns.body.end.date === '2026-11-04' && mIns.body.transparency === 'transparent', { body: r.body, post: mPost?.body });
  check('... recorded as it came: item_kind meal, the meal\'s id and day, ok, with Google\'s hash', sameRow(s.recorded()[0], mIns) && s.recorded()[0].ok === true
    && s.recorded()[0].item_kind === 'meal' && /^[0-9a-f]{64}$/.test(s.recorded()[0].google_hash), s.recorded()[0]);
  const mUpd = mealPlan('update', mIns);
  s.st.plan = [mUpd];
  r = await run(s);
  const mPut = s.G.calls.filter((c) => c.method === 'PUT');
  const rUpd = s.recorded().find((x: any) => x.op === 'update');
  check('... locked: one PUT of the same event ("Dinner: Private item", visibility private), recorded unchanged',
    r.body.updated === 1 && mPut.length === 1 && mPut[0].event === mIns.event_id && JSON.stringify(mPut[0].body) === JSON.stringify(mUpd.body)
    && fam.events.get(mIns.event_id)?.summary === 'Dinner: Private item' && sameRow(rUpd, mUpd) && rUpd.ok === true, { body: r.body, rec: rUpd });
  const mDel = mealPlan('delete', mIns);
  s.st.plan = [mDel];
  r = await run(s);
  const mDelete = s.G.calls.filter((c) => c.method === 'DELETE');
  const rDel = s.recorded().find((x: any) => x.op === 'delete');
  check('... cleared: one DELETE of it, recorded unchanged (ok)', r.body.deleted === 1 && mDelete.length === 1 && mDelete[0].event === mIns.event_id
    && !fam.events.has(mIns.event_id) && sameRow(rDel, mDel) && rDel.ok === true, { body: r.body, rec: rDel });

  // 409 → PUT; 409 then PUT 404 → clash.
  const re409 = planRow('insert', CAL.taylor);
  const clash = planRow('insert', CAL.taylor);
  s = setup({ plan: [re409, clash] });
  const c409 = s.cal(CAL.taylor.google, 'Hub – Taylor');
  c409.deleted.set(re409.event_id, { id: re409.event_id });   // deleted in Google: Google keeps the id
  c409.elsewhere.add(clash.event_id);                         // moved to another calendar in Google
  r = await run(s);
  const seq = s.G.calls.map((c) => `${c.method} ${c.event ?? ''}`.trim());
  check('insert that gets 409 (the id exists) → PUT …/events/{id}, which brings it back',
    seq.slice(0, 2).join() === `POST,PUT ${re409.event_id}` && s.recorded()[0]?.ok === true && c409.events.get(re409.event_id)?.status === 'confirmed', seq);
  check('insert that gets 409 and then PUT 404 → clash (the next run inserts with a new id)',
    seq.slice(2).join() === `POST,PUT ${clash.event_id}` && s.recorded()[1]?.clash === true && s.recorded()[1]?.ok === false && r.body.failed === 0, s.recorded()[1]);

  // update 404 → POST, on a calendar that is reachable (no probe).
  const upd = planRow('update', CAL.taylor);
  const updClash = planRow('update', CAL.taylor);
  s = setup({ plan: [upd, updClash], calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor').elsewhere.add(updClash.event_id);
  r = await run(s);
  const useq = s.G.calls.map((c) => `${c.method} ${c.event ?? ''}`.trim());
  check('update that gets 404 on a reachable calendar (ok, checked 2 minutes ago) → POST, no probe',
    useq.slice(0, 2).join() === `PUT ${upd.event_id},POST` && s.recorded()[0]?.ok === true && r.body.updated === 1, useq);
  check('... and if that POST gets 409 → clash (2 calls)', useq.slice(2).join() === `PUT ${updClash.event_id},POST` && s.recorded()[1]?.clash === true, useq);
  check('... "reachable" is read from calendars with the service-role client', s.st.tables.length === 1 && s.st.tables[0].who === 'service' && s.st.tables[0].table === 'calendars');

  // delete 404/410 → gone only when the calendar is reachable; else the probe.
  const delGone = planRow('delete', CAL.taylor);
  const delDeleted = planRow('delete', CAL.taylor);
  s = setup({ plan: [delGone, delDeleted], calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor').deleted.set(delDeleted.event_id, { id: delDeleted.event_id });
  r = await run(s);
  check('delete that gets 404 or 410 on a reachable calendar → gone, no probe',
    s.G.calls.length === 2 && s.G.calls.every((c) => c.method === 'DELETE') && s.recorded().every((x: any) => x.gone === true && x.ok === false) && r.body.deleted === 2, s.recorded());
  const delProbe = planRow('delete', CAL.jordan);
  const delProbe2 = planRow('delete', CAL.jordan);
  s = setup({ plan: [delProbe, delProbe2], calendars: [calRow(CAL.jordan, { checked_at: new Date(NOW - 3600000).toISOString() })] });
  s.cal(CAL.jordan.google, 'Hub – Jordan');
  r = await run(s);
  const pseq = s.G.calls.map((c) => `${c.method}${c.query.get('maxResults') ? ` max=${c.query.get('maxResults')} fields=${c.query.get('fields')}` : ''}`);
  check('delete 404 on a calendar checked an hour ago → the probe (GET …/events?maxResults=1&fields=accessRole) → 200 → gone',
    pseq.join() === 'DELETE,GET max=1 fields=accessRole,DELETE' && s.recorded().every((x: any) => x.gone === true), pseq);
  const gone = planRow('delete', { id: null, google: CAL.family.google });
  const gone2 = planRow('delete', { id: null, google: CAL.family.google });
  const other = planRow('insert', CAL.taylor);
  s = setup({ plan: [gone, gone2, other], calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.cal(CAL.family.google, 'Hub – Family', 'none');
  r = await run(s);
  const fseq = s.G.calls.map((c) => `${c.method} ${c.cal === CAL.family.google ? 'family' : 'taylor'}`);
  check('delete 404 and the probe 404 too → the calendar can\'t be reached: the link stays in error (forget set), not gone',
    fseq.slice(0, 2).join() === 'DELETE family,GET family' && s.recorded()[0]?.gone === false && s.recorded()[0]?.ok === false && s.recorded()[0]?.forget === true
    && s.recorded()[0]?.error === `No calendar with this ID, or it isn't shared with ${ACCOUNT}.`, s.recorded()[0]);
  check('... a leftover\'s other deletes are still tried, without probing again, so each is forgotten in this run; other calendars go on',
    fseq.join() === 'DELETE family,GET family,DELETE family,POST taylor' && s.recorded().length === 3 && s.recorded()[1].forget === true
    && s.recorded()[2].base_id === other.base_id && r.body.stop === null, fseq);
  check('... a gone mapping (no calendars row) is not marked: there is no row to mark', !s.rpcs('calendar_mark').length, s.rpcs('calendar_mark'));
  s = setup({ plan: [planRow('delete', CAL.jordan)], calendars: [calRow(CAL.jordan, { checked_at: null, status: 'new' })] });
  s.cal(CAL.jordan.google, 'Hub – Jordan', 'none');
  await run(s);
  check('... and a mapped calendar the probe can\'t reach is marked no_access',
    s.rpcs('calendar_mark')[0]?.args.p_status === 'no_access' && s.rpcs('calendar_mark')[0]?.args.p_calendar === CAL.jordan.id && s.rpcs('calendar_mark')[0]?.args.p_google_id === CAL.jordan.google, s.rpcs('calendar_mark'));

  // Every 403 reason (§3.5).
  const reasons: [string, number, any, string][] = [
    ['429', 429, { error: { code: 429, message: 'Rate Limit Exceeded', status: 'RESOURCE_EXHAUSTED' } }, 'slow_down'],
    ['403 rateLimitExceeded', 403, gErr(403, 'rateLimitExceeded', 'Rate Limit Exceeded'), 'slow_down'],
    ['403 userRateLimitExceeded', 403, gErr(403, 'userRateLimitExceeded', 'User Rate Limit Exceeded'), 'slow_down'],
    ['403 quotaExceeded', 403, gErr(403, 'quotaExceeded', 'Calendar usage limits exceeded.'), 'slow_down'],
    ['403 dailyLimitExceeded', 403, gErr(403, 'dailyLimitExceeded', 'Daily Limit Exceeded'), 'slow_down'],
    ['403 accessNotConfigured', 403, gErr(403, 'accessNotConfigured', 'Access Not Configured.'), 'config:api'],
    ['403 SERVICE_DISABLED', 403, { error: { code: 403, message: 'Google Calendar API has not been used in project 000000000000 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }] } }, 'config:api'],
    ['403 insufficientPermissions', 403, gErr(403, 'insufficientPermissions', 'Insufficient Permission: Request had insufficient authentication scopes.'), 'config:scope'],
    ['403 ACCESS_TOKEN_SCOPE_INSUFFICIENT', 403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 'config:scope'],
    ['403 requiredAccessLevel', 403, gErr(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.'), 'no_access'],
    ['403 forbidden', 403, gErr(403, 'forbidden', 'Forbidden'), 'no_access'],
    ['403 another reason', 403, gErr(403, 'cannotChangeOrganizer', 'The organizer cannot be changed.'), 'link'],
  ];
  for (const [what, status, body, want] of reasons) {
    const first = planRow('update', CAL.taylor);
    const second = planRow('update', CAL.taylor);
    const elsewhere = planRow('insert', CAL.jordan);
    s = setup({ plan: [first, second, elsewhere], calendars: [calRow(CAL.taylor), calRow(CAL.jordan)] });
    // For the access refusals, the calendar is shared only to see events: the probe (accessRole) says so.
    s.cal(CAL.taylor.google, 'Hub – Taylor', want === 'no_access' ? 'reader' : 'writer').events.set(second.event_id, { id: second.event_id });
    s.cal(CAL.jordan.google, 'Hub – Jordan');
    s.G.script.push({ when: (c) => c.event === first.event_id, status, body });
    r = await run(s);
    const fin = s.finish();
    if (want === 'slow_down') {
      check(`${what} → stop slow_down (200): the run ends, nothing more is called, the op isn't recorded`,
        r.status === 200 && r.body.stop === 'slow_down' && fin?.p_stop === 'slow_down' && s.G.calls.length === 1 && s.recorded().length === 0, { status: r.status, body: r.body, calls: s.G.calls.length });
    } else if (want.startsWith('config')) {
      const msg = want === 'config:api' ? API_OFF : NO_SCOPE;
      check(`${what} → stop config (500) with "${msg.slice(0, 40)}…"`,
        r.status === 500 && r.body.stop === 'config' && fin?.p_stop === 'config' && fin?.p_error === msg && s.G.calls.length === 1 && s.recorded().length === 0, { status: r.status, body: r.body });
    } else if (want === 'no_access') {
      check(`${what} on a calendar shared only to see events → the probe confirms it: no_access (Make changes and see event details), its other ops wait; other calendars go on`,
        r.status === 200 && r.body.stop === null && s.rpcs('calendar_mark')[0]?.args.p_status === 'no_access' && s.rpcs('calendar_mark')[0]?.args.p_calendar === CAL.taylor.id
        && s.rpcs('calendar_mark')[0]?.args.p_detail === `Home Hub can't change this calendar. In Google Calendar, share it with ${ACCOUNT} and choose Make changes and see event details.`
        && s.G.calls.map((c) => c.method).join() === 'PUT,GET,POST' && s.recorded().length === 2 && s.recorded()[0].ok === false && s.recorded()[0].forget === true
        && s.recorded()[0].http === 403 && s.recorded()[1].ok === true, { calls: s.G.calls.map((c) => c.method), rec: s.recorded() });
    } else {
      check(`${what} → a link error with Google's reason; the run goes on`,
        r.body.stop === null && s.recorded()[0]?.ok === false && s.recorded()[0]?.forget === false && /cannotChangeOrganizer/.test(s.recorded()[0]?.error)
        && s.recorded().length === 3 && !s.rpcs('calendar_mark').length && r.body.failed === 1, s.recorded()[0]);
    }
  }

  // A 403 on one event of a calendar the hub can write (the probe says writer): that event's own
  // refusal, a link error with backoff. The calendar isn't marked, and its other ops go on.
  for (const [what, body] of [['requiredAccessLevel', gErr(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.')], ['forbidden', gErr(403, 'forbidden', 'Forbidden')]] as const) {
    const first = planRow('update', CAL.taylor);
    const second = planRow('update', CAL.taylor);
    s = setup({ plan: [first, second], calendars: [calRow(CAL.taylor)] });
    s.cal(CAL.taylor.google, 'Hub – Taylor').events.set(second.event_id, { id: second.event_id });
    s.G.script.push({ when: (c) => c.event === first.event_id, status: 403, body });
    r = await run(s);
    check(`403 ${what} on one event, while the probe says the hub is a writer there → a link error, the calendar isn't marked, its other ops go on`,
      s.G.calls.map((c) => c.method).join() === 'PUT,GET,PUT' && !s.rpcs('calendar_mark').length && s.recorded()[0]?.ok === false && s.recorded()[0]?.forget === false
      && /403/.test(s.recorded()[0]?.error) && s.recorded()[1]?.ok === true && r.body.failed === 1, { calls: s.G.calls.map((c) => c.method), rec: s.recorded()[0] });
  }
  s = setup({ plan: [planRow('update', CAL.taylor)], calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor', 'writerWithoutPrivateAccess');
  s.G.script.push({ when: (c) => c.method === 'PUT', status: 403, body: gErr(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.') });
  r = await run(s);
  check('403 on a calendar the probe finds shared with "Make changes (see private events as free/busy)" → no_access, naming the right option',
    s.rpcs('calendar_mark')[0]?.args.p_status === 'no_access'
    && s.rpcs('calendar_mark')[0]?.args.p_detail === `Shared with 'Make changes (see private events as free/busy)': Home Hub can't change its private items there. Share it with ${ACCOUNT} and choose Make changes and see event details.`,
    s.rpcs('calendar_mark'));

  // Someone moved the hub's event to another calendar in Google: the copy left here belongs to that
  // calendar, so Google refuses to change it (403 forbiddenForNonOrganizer). A new id next time.
  const movedIns = planRow('insert', CAL.taylor);
  const movedUpd = planRow('update', CAL.taylor);
  const movedFb = planRow('insert', CAL.taylor);
  s = setup({ plan: [movedIns, movedUpd, movedFb], calendars: [calRow(CAL.taylor)] });
  const movedCal = s.cal(CAL.taylor.google, 'Hub – Taylor');
  movedCal.elsewhere.add(movedIns.event_id);
  movedCal.elsewhere.add(movedFb.event_id);
  const nonOrg = gErr(403, 'forbiddenForNonOrganizer', 'Shared properties can only be changed by the organizer of the event.');
  s.G.script.push({ when: (c) => c.method === 'PUT' && c.event === movedIns.event_id, status: 403, body: nonOrg });
  s.G.script.push({ when: (c) => c.method === 'PUT' && c.event === movedUpd.event_id, status: 403, body: nonOrg });
  s.G.script.push({ when: (c) => c.method === 'PUT' && c.event === movedFb.event_id, status: 403, body: gErr(403, 'forbidden', 'Forbidden') });
  r = await run(s);
  const mseq = s.G.calls.map((c) => `${c.method}${c.event ? ` ${c.event === movedIns.event_id ? 'ins' : c.event === movedUpd.event_id ? 'upd' : 'fb'}` : ''}`);
  check('insert that gets 409, then PUT 403 forbiddenForNonOrganizer (moved in Google) → clash: a new id next time',
    mseq.slice(0, 2).join() === 'POST,PUT ins' && s.recorded()[0]?.clash === true && s.recorded()[0]?.ok === false, { mseq, rec: s.recorded()[0] });
  check('update that gets 403 forbiddenForNonOrganizer → clash, no probe and no mark',
    mseq[2] === 'PUT upd' && s.recorded()[1]?.clash === true && !s.rpcs('calendar_mark').length, { mseq, rec: s.recorded()[1] });
  check('insert that gets 409, then PUT 403 forbidden → clash too (the POST\'s 409 already says the hub may write here); the run goes on',
    mseq.slice(3).join() === 'POST,PUT fb' && s.recorded()[2]?.clash === true && r.body.failed === 0 && r.body.stop === null && !s.rpcs('calendar_mark').length, { mseq, rec: s.recorded()[2] });

  // A calendar switched from writing to read-only, and shared only to read now: the hub's leftover
  // events there can't be deleted. Each is forgotten in this run; the calendar isn't marked.
  const left1 = planRow('delete', CAL.family);
  const left2 = planRow('delete', CAL.family);
  s = setup({ plan: [left1, left2], calendars: [calRow(CAL.family, { writes: false })] });
  const ro = s.cal(CAL.family.google, 'Family', 'reader');
  ro.events.set(left1.event_id, { id: left1.event_id });
  ro.events.set(left2.event_id, { id: left2.event_id });
  r = await run(s);
  check('a calendar now only read: each leftover delete gets 403, the probe (once) says reader, and both are forgotten in this run',
    s.G.calls.map((c) => c.method).join() === 'DELETE,GET,DELETE' && s.recorded().length === 2 && s.recorded().every((x: any) => x.forget === true && x.ok === false), { calls: s.G.calls.map((c) => c.method), rec: s.recorded() });
  check('... and the calendar it reads isn\'t marked "can\'t reach it" (its cached events stay)', !s.rpcs('calendar_mark').length, s.rpcs('calendar_mark'));

  // 401: a new token once, then try again; else auth.
  const a401 = planRow('update', CAL.taylor);
  s = setup({ plan: [a401, planRow('insert', CAL.taylor)], calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor').events.set(a401.event_id, { id: a401.event_id });
  s.G.script.push({ when: (c) => c.event === a401.event_id, status: 401, body: { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } } });
  r = await run(s);
  check('401 → one new token and the call again: it goes through', s.G.tokenReqs.length === 2 && s.recorded().every((x: any) => x.ok) && r.body.stop === null
    && s.G.calls.slice(1).every((c) => c.auth === 'Bearer ya29.fake-2'), { tokens: s.G.tokenReqs.length, rec: s.recorded().map((x: any) => x.ok) });
  s = setup({ plan: [planRow('insert', CAL.taylor), planRow('insert', CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: () => true, status: 401, body: { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } }, times: 5 });
  r = await run(s);
  check('401 again after the new token → stop auth (500), Google refused', r.status === 500 && r.body.stop === 'auth' && s.finish()?.p_stop === 'auth' && s.G.tokenReqs.length === 2 && s.G.calls.length === 2, r.body);

  // 5xx and timeouts: retried once after a second, then a link error; the calendar's status stays.
  const u5 = planRow('update', CAL.taylor);
  const u5b = planRow('update', CAL.taylor);
  s = setup({ plan: [u5, u5b], calendars: [calRow(CAL.taylor)] });
  const c5 = s.cal(CAL.taylor.google, 'Hub – Taylor');
  c5.events.set(u5.event_id, { id: u5.event_id });
  c5.events.set(u5b.event_id, { id: u5b.event_id });
  s.G.script.push({ when: (c) => c.event === u5.event_id, status: 503, body: gErr(503, 'backendError', 'Backend Error'), times: 1 });
  s.G.script.push({ when: (c) => c.event === u5b.event_id, status: 500, body: gErr(500, 'backendError', 'Backend Error'), times: 2 });
  r = await run(s);
  check('a 5xx is tried once more after a second; the second try goes through', s.recorded()[0]?.ok === true && s.sleeps.filter((x) => x === 1000).length === 2, s.sleeps);
  check('a 5xx twice → a link error (with Google\'s status); calendars.status is left alone; the run goes on',
    s.recorded()[1]?.ok === false && /500/.test(s.recorded()[1]?.error) && s.recorded()[1]?.http === 500 && !s.rpcs('calendar_mark').length && r.body.stop === null && r.body.failed === 1, s.recorded()[1]);
  s = setup({ plan: [planRow('insert', CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: () => true, error: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), times: 2 });
  r = await run(s);
  check('a timeout twice → a link error saying Google didn\'t answer, http null', s.recorded()[0]?.ok === false && s.recorded()[0]?.http === null && /didn't answer/.test(s.recorded()[0]?.error) && r.body.stop === null, s.recorded()[0]);

  // 400: a link error with Google's message (a bug on our side); token-shaped text removed.
  s = setup({ plan: [planRow('insert', CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: () => true, status: 400, body: gErr(400, 'invalid', `Invalid start time. ya29.a0AfH6SMexampletoken and eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl ${'x'.repeat(400)}\nsecond line`) });
  r = await run(s);
  const e400 = s.recorded()[0]?.error || '';
  check('400 → a link error with Google\'s message, one line of at most 300 characters, no token-shaped text',
    /^Google said 400 invalid: Invalid start time\./.test(e400) && e400.length <= 300 && !/ya29\.|eyJ|\n/.test(e400) && r.body.failed === 1, e400);

  // Records in batches of 20; calls 250 ms apart; ids URL-encoded; every RPC through deps.service().
  const big = Array.from({ length: 45 }, (_, i) => planRow('insert', i % 2 ? CAL.taylor : CAL.jordan, { day: `2026-11-${String(3 + (i % 20)).padStart(2, '0')}` }));
  s = setup({ plan: big, due: [dueRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.cal(CAL.jordan.google, 'Hub – Jordan');
  r = await run(s);
  const batches = s.rpcs('calendar_record').map((c) => c.args.p_results.length);
  check(`results are recorded in batches of ${RECORD_BATCH} (45 → 20, 20, 5)`, batches.join() === '20,20,5' && s.recorded().length === 45 && r.body.inserted === 45, batches);
  const gaps = s.G.calls.slice(1).map((c, i) => c.at - s.G.calls[i].at);
  check('Google calls are at least 250 ms apart', gaps.length === 45 && gaps.every((g) => g >= 250), gaps.slice(0, 5));
  const evPath = s.G.calls.find((c) => c.method === 'POST')!.path;
  check('event paths are URL-encoded', evPath === `/calendar/v3/calendars/${encodeURIComponent(CAL.jordan.google)}/events` && evPath.includes('%40'), evPath);
  const allCalendarRpcs = s.st.calls.filter((c) => c.fn.startsWith('calendar_'));
  check('every calendar_* RPC goes through deps.service()', allCalendarRpcs.length >= 5 && allCalendarRpcs.every((c) => c.who === 'service'), allCalendarRpcs.map((c) => `${c.fn}:${c.who}`));
  check('the run\'s result: read, stored, skipped, repaired, adopted, inserted, updated, deleted, failed, pending, hiding',
    Object.keys(s.finish()?.p_result || {}).sort().join() === 'adopted,deleted,failed,hiding,inserted,pending,read,repaired,skipped,stored,updated'
    && s.finish()?.p_result.pending === 0 && s.finish()?.p_run === RUN && s.finish()?.p_stop === null && s.finish()?.p_error === null, s.finish());
  const putEv = planRow('update', CAL.taylor, { event_id: 'hh00000000000000000000000000000abc' });
  s = setup({ plan: [putEv], calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor').events.set(putEv.event_id, { id: putEv.event_id });
  await run(s);
  check('PUT goes to …/events/{event_id}, URL-encoded', s.G.calls[0]?.path === `/calendar/v3/calendars/${encodeURIComponent(CAL.taylor.google)}/events/${putEv.event_id}` && s.G.calls[0]?.query.get('sendUpdates') === 'none', s.G.calls[0]?.path);

  // Privacy first: pending and hiding.
  const hide1 = planRow('update', CAL.taylor, { private: true });
  const hide2 = planRow('delete', CAL.taylor);
  s = setup({ plan: [hide1, hide2, planRow('insert', CAL.taylor), planRow('insert', CAL.taylor)], calendars: [calRow(CAL.taylor)] });
  const hc = s.cal(CAL.taylor.google, 'Hub – Taylor');
  hc.events.set(hide1.event_id, { id: hide1.event_id });
  hc.events.set(hide2.event_id, { id: hide2.event_id });
  s.G.script.push({ when: (c) => c.method === 'POST', status: 429, body: { error: { code: 429, message: 'Rate Limit Exceeded' } } });
  r = await run(s);
  check('pending and hiding count what is left: a private update and a delete done, then Google says slow down',
    r.body.stop === 'slow_down' && s.finish()?.p_result.pending === 2 && s.finish()?.p_result.hiding === 0 && r.body.updated === 1 && r.body.deleted === 1
    && hc.events.get(hide1.event_id)?.visibility === 'private', s.finish()?.p_result);
  check('... what Google answered before it said slow down is recorded', s.recorded().length === 2 && s.recorded().every((x: any) => x.ok), s.recorded().length);

  // "Hiding" counts what calendar_plan counts: deletes and updates that make an item private, never an insert.
  const failDel = planRow('delete', CAL.taylor);
  const privIns = planRow('insert', CAL.taylor, { private: true });
  s = setup({ plan: [failDel, privIns], calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor').events.set(failDel.event_id, { id: failDel.event_id });
  s.G.script.push({ when: (c) => c.method === 'DELETE', status: 500, body: gErr(500, 'backendError', 'Backend Error'), times: 2 });
  r = await run(s);
  check('a failed delete, then a private insert done: still hiding 1 (the delete), pending 1',
    s.finish()?.p_result.hiding === 1 && s.finish()?.p_result.pending === 1 && r.body.inserted === 1 && r.body.failed === 1, s.finish()?.p_result);

  // -------------------------------------------------------------------
  // calendar_test (§6.5)
  // -------------------------------------------------------------------
  const test = (calendarId: string = CAL.taylor.id) => asUser({ action: 'calendar_test', calendar_id: calendarId });
  s = setup({ calendars: [calRow(CAL.taylor, { status: 'new' })] });
  const tc = s.cal(CAL.taylor.google, 'Hub – Taylor');
  r = await run(s, test());
  const tseq = s.G.calls.map((c) => `${c.method}${c.event ? ' id' : ''}`);
  check('Test on a writing calendar: list first (maxResults=1, fields=summary,accessRole)',
    s.G.calls[0]?.method === 'GET' && s.G.calls[0].event === null && s.G.calls[0].query.get('maxResults') === '1' && s.G.calls[0].query.get('fields') === 'summary,accessRole', s.G.calls[0]?.query.toString());
  check('... then add, delete, PUT back, read and delete again (gate 2)', tseq.join() === 'GET,POST,DELETE id,PUT id,GET id,DELETE id', tseq);
  const testId = s.G.calls[1]?.body?.id;
  check('... with id hhtest + 16 random hex characters, all-day on 2001-01-01, nothing left behind',
    /^hhtest[0-9a-f]{16}$/.test(testId) && s.G.calls[1].body.start.date === '2001-01-01' && s.G.calls[1].body.end.date === '2001-01-02'
    && s.G.calls.slice(2).every((c) => c.event === testId) && tc.events.size === 0 && s.G.calls[3].body.status === 'confirmed', s.G.calls[1]?.body);
  check('... answers { ok, status, message, name, role, steps }, each step with its result',
    r.status === 200 && r.body.ok === true && r.body.status === 'ok' && r.body.message === 'Home Hub can write to this calendar.' && r.body.name === 'Hub – Taylor' && r.body.role === 'writer'
    && r.body.steps.map((x: any) => `${x.step}:${x.ok}:${x.http}`).join() === 'list:true:200,insert:true:200,delete:true:204,restore:true:200,read:true:200,compare:true:null,cleanup:true:204', r.body);
  check('... recorded with calendar_mark: ok, with the Google name and role, through the service-role client',
    JSON.stringify(s.rpcs('calendar_mark')[0]?.args) === JSON.stringify({ p_calendar: CAL.taylor.id, p_google_id: CAL.taylor.google, p_status: 'ok', p_detail: null, p_name: 'Hub – Taylor', p_access: 'writer' })
    && s.rpcs('calendar_mark')[0]?.who === 'service' && s.st.tables[0]?.who === 'service', s.rpcs('calendar_mark')[0]);
  check('... Test takes no lease and writes no run', !s.rpcs('calendar_begin').length && !s.rpcs('calendar_finish').length && !s.rpcs('calendar_signed_in').length);
  check('... and asks Google for no guest (no attendees or email in any fields)', s.G.calls.length > 0 && s.G.calls.every((c) => !/attendees|email/.test(c.query.get('fields') ?? '')),
    s.G.calls.map((c) => c.query.get('fields')));

  const refusals: [string, string, string, string, string][] = [
    ['a name that doesn\'t start with "Hub"', 'Taylor', 'writer', 'error', "This calendar isn't named 'Hub …'. The hub writes only to calendars whose name starts with Hub. If it is the right one, rename it in Google."],
    ['role reader', 'Hub – Taylor', 'reader', 'no_access', `Home Hub can't change this calendar. In Google Calendar, share it with ${ACCOUNT} and choose Make changes and see event details.`],
    ['the service account as owner', 'Hub – Taylor', 'owner', 'error', 'Share it with Make changes and see event details, not Make changes and manage sharing.'],
    ['role writerWithoutPrivateAccess ("Make changes (see private events as free/busy)", the wrong option)', 'Hub – Taylor', 'writerWithoutPrivateAccess', 'no_access',
      `Shared with 'Make changes (see private events as free/busy)': Home Hub can't change its private items there. Share it with ${ACCOUNT} and choose Make changes and see event details.`],
  ];
  for (const [what, name, role, status, msg] of refusals) {
    s = setup({ calendars: [calRow(CAL.taylor)] });
    s.cal(CAL.taylor.google, name, role);
    r = await run(s, test());
    check(`Test with ${what}: list only, nothing inserted; ${status} with the message`,
      s.G.calls.length === 1 && r.body.ok === false && r.body.status === status && r.body.message === msg && r.body.name === name && r.body.role === role
      && s.rpcs('calendar_mark')[0]?.args.p_status === status && s.rpcs('calendar_mark')[0]?.args.p_detail === msg, { calls: s.G.calls.length, body: r.body });
  }
  check('the JS rules agree with the database\'s (private.calendar_status): "  hub" any case, reader for read-only, freeBusyReader refused',
    verdict(true, '  hub – Taylor', 'writer', ACCOUNT).status === 'ok' && verdict(true, 'HUB-x', 'writer', ACCOUNT).status === 'ok' && verdict(true, 'My Hub', 'writer', ACCOUNT).status === 'error'
    && verdict(false, 'Anything', 'reader', ACCOUNT).status === 'ok' && verdict(false, 'Anything', 'freeBusyReader', ACCOUNT).status === 'no_access' && verdict(true, 'Hub', 'freeBusyReader', ACCOUNT).status === 'no_access'
    && verdict(false, 'Anything', 'writerWithoutPrivateAccess', ACCOUNT).status === 'ok' && verdict(true, 'Hub', 'writerWithoutPrivateAccess', ACCOUNT).status === 'no_access');

  s = setup({ calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: (c) => c.method === 'POST', status: 403, body: gErr(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.') });
  r = await run(s, test());
  check('Test: listed with the writer role, yet the insert gets 403 → gate 2 has failed: "Shared correctly, but Google won\'t let Home Hub add an event to it: tell Claude."',
    r.body.ok === false && r.body.status === 'no_access' && r.body.message === "Shared correctly, but Google won't let Home Hub add an event to it: tell Claude."
    && s.rpcs('calendar_mark')[0]?.args.p_status === 'no_access', r.body);
  s = setup({ calendars: [calRow(CAL.main, { writes: false })] });
  s.cal(CAL.main.google, 'Family', 'writerWithoutPrivateAccess');
  r = await run(s, test(CAL.main.id));
  check('Test on a calendar the hub only reads, shared with "Make changes (see private events as free/busy)": it can read it, ok',
    r.body.ok === true && r.body.status === 'ok' && s.rpcs('calendar_mark')[0]?.args.p_access === 'writerWithoutPrivateAccess', r.body);
  s = setup({ due: [dueRow(CAL.main, false)] });
  s.cal(CAL.main.google, 'Family', 'writerWithoutPrivateAccess');
  await run(s);
  check('... a read of it is stored with that access role (the database\'s rules say ok), nothing marked',
    s.rpcs('calendar_store_events')[0]?.args.p_access === 'writerWithoutPrivateAccess' && !s.rpcs('calendar_mark').length, s.rpcs('calendar_store_events')[0]?.args.p_access);
  s = setup({ calendars: [calRow(CAL.main, { writes: false })] });
  s.cal(CAL.main.google, 'Family', 'reader');
  r = await run(s, test(CAL.main.id));
  check('Test on a calendar the hub only reads: list only; ok', s.G.calls.length === 1 && r.body.ok === true && r.body.status === 'ok' && r.body.message === 'Home Hub can read this calendar.'
    && s.rpcs('calendar_mark')[0]?.args.p_status === 'ok' && s.rpcs('calendar_mark')[0]?.args.p_access === 'reader', r.body);

  s = setup({ calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: () => true, status: 403, body: gErr(403, 'forbidden', 'Forbidden') });
  r = await run(s, test());
  check('Test: 403 → "Home Hub can\'t change this calendar. In Google Calendar, share it with <account> and choose Make changes and see event details."',
    r.body.ok === false && r.body.status === 'no_access' && r.body.message === `Home Hub can't change this calendar. In Google Calendar, share it with ${ACCOUNT} and choose Make changes and see event details.`
    && s.rpcs('calendar_mark')[0]?.args.p_status === 'no_access' && s.G.calls.length === 1, r.body);
  s = setup({ calendars: [calRow(CAL.taylor)] });
  r = await run(s, test());
  check('Test: 404 → "No calendar with this ID, or it isn\'t shared with <account>."',
    r.body.ok === false && r.body.status === 'no_access' && r.body.message === `No calendar with this ID, or it isn't shared with ${ACCOUNT}.` && s.G.calls.length === 1, r.body);
  s = setup({ calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: (c) => c.method === 'PUT', status: 404, body: gErr(404, 'notFound', 'Not Found') });
  r = await run(s, test());
  check('Test: the PUT doesn\'t bring the event back → "Google answered differently than expected: tell Claude."; the calendar stays ok',
    r.body.ok === false && r.body.status === 'ok' && r.body.message === 'Google answered differently than expected: tell Claude.' && r.body.steps.find((x: any) => x.step === 'restore')?.ok === false
    && !r.body.steps.some((x: any) => x.step === 'cleanup') && s.rpcs('calendar_mark')[0]?.args.p_status === 'ok', r.body);
  s = setup({ calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: (c) => c.method === 'GET' && c.event !== null, status: 200, body: { id: 'x', status: 'confirmed', summary: 'Something else', start: { date: '2001-01-01' }, end: { date: '2001-01-02' } } });
  r = await run(s, test());
  check('Test: the hashes differ → the same message; the event is still deleted',
    r.body.ok === false && r.body.message === 'Google answered differently than expected: tell Claude.' && r.body.steps.find((x: any) => x.step === 'compare')?.ok === false
    && r.body.steps.at(-1)?.step === 'cleanup' && s.G.calls.at(-1)?.method === 'DELETE', r.body.steps);
  s = setup({ calendars: [calRow(CAL.taylor, { status: 'error' })] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: () => true, status: 503, body: {}, times: 2 });
  r = await run(s, test());
  check('Test: Google doesn\'t answer → says so, and the calendar\'s status is left as it was', r.body.ok === false && r.body.status === 'error' && /didn't answer/.test(r.body.message) && !s.rpcs('calendar_mark').length, r.body);
  s = setup({ calendars: [calRow(CAL.taylor)] });
  s.cal(CAL.taylor.google, 'Hub – Taylor');
  s.G.script.push({ when: () => true, status: 403, body: gErr(403, 'accessNotConfigured', 'Access Not Configured.') });
  r = await run(s, test());
  check('Test: the API isn\'t turned on → stop config with its fixed message, nothing marked', r.body.ok === false && r.body.stop === 'config' && r.body.message === API_OFF && !s.rpcs('calendar_mark').length, r.body);
  s = setup({ env: { GOOGLE_SA_JSON: undefined }, calendars: [calRow(CAL.taylor)] });
  r = await run(s, test());
  check('Test without the key → {ok: false, stop: not_set_up}, Google never called', r.status === 200 && r.body.ok === false && r.body.stop === 'not_set_up' && s.G.tokenReqs.length === 0, r.body);
  s = setup({ calendars: [calRow(CAL.taylor)] });
  r = await run(s, asUser({ action: 'calendar_test', calendar_id: "1' or 1=1" }));
  const r404 = await run(s, test('cccccccc-0000-4000-8000-0000000000ff'));
  const rNone = await run(s, asUser({ action: 'calendar_test' }));
  check('Test: calendar_id must be a uuid naming an existing calendar, else 400', r.status === 400 && r404.status === 400 && rNone.status === 400 && s.G.tokenReqs.length === 0, `${r.status} ${r404.status} ${rNone.status}`);

  // -------------------------------------------------------------------
  // The source (§3.5, §6.1, §8.2)
  // -------------------------------------------------------------------
  const dir = new URL('../../supabase/functions/hub-jobs/', import.meta.url);
  const src = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]));
  const code = (f: string) => src[f].replace(/\/\/.*$/gm, '');
  // v1.3's school feed (migration 0006) adds school.ts and ical.ts on purpose (docs/v1.3-homework.md §12), and its AI
  // planner (PR B) homework.ts (§2.2).
  check('the hub-jobs files are index, handler, render, util, google, calendar, school, ical and homework',
    Object.keys(src).sort().join() === 'calendar.ts,google.ts,handler.ts,homework.ts,ical.ts,index.ts,render.ts,school.ts,util.ts', Object.keys(src));
  check('the Google helper is gcal(…); nothing calls call(\'…\') (the contract check would read it as a database function)',
    /\bgcal\(/.test(code('google.ts')) && /\bgcal\(/.test(code('calendar.ts')) && Object.keys(src).every((f) => !/(^|[^\w.])call\s*\(\s*['"`]/.test(code(f))));
  check('GOOGLE_SA_JSON is read with a literal deps.env(\'GOOGLE_SA_JSON\'), and no other Google secret is read',
    /deps\.env\('GOOGLE_SA_JSON'\)/.test(code('calendar.ts')) && !Object.values(src).some((x) => /GOOGLE_OAUTH_/.test(x)));
  check('google.ts imports nothing from outside the function', [...code('google.ts').matchAll(/^import .* from '([^']+)'/gm)].every((m) => m[1].startsWith('./')));
  check('handler.ts and calendar.ts don\'t import each other', !/from '\.\/handler\.ts'/.test(src['calendar.ts']) && !/from '\.\/calendar\.ts'/.test(src['util.ts'] + src['google.ts']));
  // The AI planner logs one fixed code and its counts per run, and "finish failed" (docs/v1.3-homework.md §6.2, §6.5,
  // §14); tests/fn/homework-ai.test.ts checks that those are its only console lines. Every other file writes nothing.
  check('nothing is written to the console (but homework.ts\'s fixed codes)', Object.keys(src).filter((f) => f !== 'homework.ts').every((f) => !/\bconsole\./.test(code(f))));
  check('every Google call has a timeout of at most 15 seconds (cut to what is left of a read\'s deadline)',
    /signal: AbortSignal\.timeout\(ms\)/.test(code('google.ts')) && /until == null \? CALL_TIMEOUT_MS : Math\.max\(1, Math\.min\(CALL_TIMEOUT_MS,/.test(code('google.ts'))
    && /CALL_TIMEOUT_MS = 15000/.test(code('google.ts')));

  console.log(results.join('\n'));
  console.log(`\n${results.filter((x) => x.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((x) => x.startsWith('FAIL'))) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
