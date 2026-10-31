// Shared pieces for the real-database browser tests (tests/realdb/*.test.js).
//   const h = await setup('flows');      // its own copy of the template database, its own server, Chromium
//   const { page } = await h.open({ email: 'alex@example.com', phone: true, path: '/#/' });
//   await h.sql("select due_date from tasks where title = 'Heartworm pill'")  → [{ due_date: '2026-10-27' }]
//   h.check(name, ok, detail); … await h.finish();   // prints the PASS/FAIL lines, closes everything
//   await h.migrate('supabase/migrations/0005_homework.sql')   // as the owner applies it (setup(name, { v4: true }))
// Signing in goes through the server's real /auth/v1/otp and /auth/v1/verify (code 123456); the session
// is then put where supabase-js keeps it. The browser's clock starts at the household's pinned "now".
// hub-jobs' Google calls (the calendar job, Test) reach a fake Google (fakeGoogle below): h.google. Its school
// reads (0006) reach a fake school site on *.school.example (fakeSchool below): h.school; school.ts's SCHOOL_HOST
// suffix is set to that made-up one here, and a test sets the database's private.school_host_suffix() to match.
// Its AI planner's calls (v1.3 PR B, homework_ai) reach a fake Anthropic (fakeAnthropic below): h.anthropic, with a
// made-up ANTHROPIC_API_KEY (h.AI_KEY; h.fnEnv is the function's environment, for a test that takes the key away); the
// work the handler hands deps.background is collected, and h.aiDone() waits for it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { connect, ident } = require('./pg');
const { start } = require('./server');

const vm = require('vm');
const REPO = path.resolve(__dirname, '../..');
const SUPA_JS = fs.readFileSync(path.join(__dirname, '../e2e/vendor/supabase.js'));
// The hub-jobs secrets for the plugged-in handler (fictional), and an unsigned service-role JWT.
const CRON_SECRET = 'realdb-cron-secret-0123456789abcdef0123';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SERVICE_KEY = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'supabase' })}.realdb`;
// ANTHROPIC_API_KEY for the AI planner (v1.3 §6): made up; only the fake Anthropic below ever sees it.
const AI_KEY = 'sk-ant-realdb-made-up-key-000000000000';
// GOOGLE_SA_JSON: a service-account key file made here, with a key pair that exists only in this run
// (the fake Google checks the signature with its public half). Fictional project and address.
const SA_ACCOUNT = 'home-hub-sync@home-hub-example.iam.gserviceaccount.com';
const SA_KEY_ID = 'realdb0000000000000000000000000000a1b2c3';
const SA_PAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const SA_JSON = JSON.stringify({
  type: 'service_account', project_id: 'home-hub-example', private_key_id: SA_KEY_ID, private_key: SA_PAIR.privateKey,
  client_email: SA_ACCOUNT, client_id: '100000000000000000001', token_uri: 'https://oauth2.googleapis.com/token',
});

// ---------------------------------------------------------------------
// A fake Google for hub-jobs (docs/v1.1-google-calendar.md §3.5, §5.1, §6.1): the token endpoint
// (oauth2.googleapis.com) and the Calendar API's events (www.googleapis.com/calendar/v3), keeping what
// was written, calendar by calendar. Like Google: a calendar the service account wasn't given answers
// 404 notFound, one shared read-only 403 requiredAccessLevel on writes; deleting an event keeps its id
// (status cancelled), so a POST with that id is 409 and a PUT brings it back; times come back in the
// event's (or the list's) time zone, and default values are left out. Only the token it gave out opens
// the API. Every call is in requests: { method, calendar, event, query, body, status }.
//   g.add(id, { summary, role })     a calendar ('writer', 'reader' or 'owner'; null: not shared)
//   g.typeIn(id, event)              an event typed into Google (by a person): → its id
//   g.edit(id, eventId, change)      changed in Google (by a person); g.remove(id, eventId): deleted there
//   g.share(id, role)                the calendar's sharing changed
//   g.events(id)                     the events that are there (not deleted), as stored; g.all(id) with the deleted
//   g.writes(since)                  the POST/PUT/DELETE calls since requests[since]; g.tokens(): tokens given out
// ---------------------------------------------------------------------
function zoneOffset(ms, tz) {   // minutes east of UTC
  const name = (new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(ms))
    .find((p) => p.type === 'timeZoneName') || {}).value || 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}
function inZone(ms, tz) {      // 2026-10-27T16:00:00-04:00
  const off = zoneOffset(ms, tz);
  const a = Math.abs(off);
  return `${new Date(ms + off * 60000).toISOString().slice(0, 19)}${off < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
const dayStart = (date, tz) => {
  const guess = Date.parse(`${date}T00:00:00Z`);
  return guess - zoneOffset(guess, tz) * 60000;
};

function fakeGoogle(nowIso) {
  const calendars = new Map();
  const requests = [];
  const tokens = new Set();
  let serial = 0;
  const now = () => new Date(Date.parse(nowIso())).toISOString();
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const problem = (code, reason, message) => ({ error: { errors: [{ domain: 'global', reason, message }], code, message } });
  const range = (ev, tz) => {
    const at = (t) => (!t ? null : t.date ? dayStart(t.date, tz) : Date.parse(t.dateTime));
    const s = at(ev.start);
    return [s, at(ev.end) ?? s];
  };
  // An event as Google answers it: times in the event's zone (or the list's), defaults left out.
  const show = (ev, tz) => {
    const when = (t) => (!t ? t : t.date ? { date: t.date } : { dateTime: inZone(Date.parse(t.dateTime), t.timeZone || tz), timeZone: t.timeZone || tz });
    const out = { kind: 'calendar#event', etag: `"${ev.etag}"`, id: ev.id, status: ev.status, created: ev.created, updated: ev.updated };
    for (const k of ['summary', 'description', 'location', 'colorId', 'recurringEventId', 'attendees', 'extendedProperties']) if (ev[k] !== undefined) out[k] = ev[k];
    out.organizer = ev.organizer || { self: true };
    out.start = when(ev.start);
    out.end = when(ev.end);
    if (ev.transparency && ev.transparency !== 'opaque') out.transparency = ev.transparency;
    if (ev.visibility && ev.visibility !== 'default') out.visibility = ev.visibility;
    out.reminders = { useDefault: true };
    out.eventType = 'default';
    return out;
  };
  const store = (cal, body, extra) => {
    const ev = Object.assign({}, JSON.parse(JSON.stringify(body)), extra, { updated: now(), etag: String(++serial) });
    ev.status = body.status || 'confirmed';
    cal.events.set(ev.id, ev);
    return ev;
  };
  // Top-level fields only ("summary,accessRole,items(id,…)" keeps summary, accessRole and items).
  const pick = (obj, fields) => {
    if (!fields) return obj;
    const keep = new Set(fields.replace(/\([^)]*\)/g, '').split(',').map((f) => f.split('/')[0].trim()));
    return Object.fromEntries(Object.entries(obj).filter(([k]) => keep.has(k)));
  };

  async function token(init) {
    const form = new URLSearchParams(String(init.body || ''));
    const jwt = form.get('assertion') || '';
    const [h, c, sig] = jwt.split('.');
    let ok = form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && !!sig;
    try {
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
      ok = ok && JSON.parse(Buffer.from(h, 'base64url').toString()).alg === 'RS256' && claims.iss === SA_ACCOUNT
        && claims.scope === 'https://www.googleapis.com/auth/calendar.events' && claims.aud === 'https://oauth2.googleapis.com/token'
        && claims.exp - claims.iat <= 3600 && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), SA_PAIR.publicKey, Buffer.from(sig, 'base64url'));
    } catch (e) { ok = false; }
    if (!ok) return reply(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    const t = `ya29.realdb-${++serial}`;
    tokens.add(t);
    return reply(200, { access_token: t, expires_in: 3599, token_type: 'Bearer' });
  }

  async function api(url, init) {
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    const method = (init.method || 'GET').toUpperCase();
    const entry = { method, calendar: m ? decodeURIComponent(m[1]) : null, event: m && m[2] ? decodeURIComponent(m[2]) : null,
      query: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(init.body) : null, status: 0 };
    requests.push(entry);
    const done = (status, body) => { entry.status = status; return reply(status, body); };
    const auth = String((init.headers || {}).Authorization || (init.headers || {}).authorization || '');
    if (!tokens.has(auth.replace(/^Bearer\s+/, ''))) return done(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    if (!m) return done(404, problem(404, 'notFound', 'Not Found'));
    const cal = calendars.get(entry.calendar);
    if (!cal || !cal.role) return done(404, problem(404, 'notFound', 'Not Found'));
    const tz = entry.query.timeZone || 'America/New_York';
    if (method === 'GET' && !entry.event) {
      const from = entry.query.timeMin ? Date.parse(entry.query.timeMin) : -Infinity;
      const to = entry.query.timeMax ? Date.parse(entry.query.timeMax) : Infinity;
      const all = [...cal.events.values()].filter((ev) => {
        if (ev.status === 'cancelled' && entry.query.showDeleted !== 'true') return false;
        const [s, e] = range(ev, tz);
        return e > from && s < to;
      }).sort((a, b) => range(a, tz)[0] - range(b, tz)[0] || (a.id < b.id ? -1 : 1));
      const skip = Number(entry.query.pageToken || 0);
      const max = Math.min(Number(entry.query.maxResults || 250), 2500);
      const out = { kind: 'calendar#events', summary: cal.summary, accessRole: cal.role, timeZone: tz, items: all.slice(skip, skip + max).map((ev) => show(ev, tz)) };
      if (skip + max < all.length) out.nextPageToken = String(skip + max);
      return done(200, pick(out, entry.query.fields));
    }
    const ev = entry.event ? cal.events.get(entry.event) : null;
    if (method === 'GET') return ev ? done(200, pick(show(ev, tz), entry.query.fields)) : done(404, problem(404, 'notFound', 'Not Found'));
    if (cal.role === 'reader') return done(403, problem(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.'));
    if (method === 'POST') {
      const id = entry.body && entry.body.id;
      if (id && cal.events.has(id)) return done(409, problem(409, 'duplicate', 'The requested identifier already exists.'));
      return done(200, show(store(cal, Object.assign({ id: id || `g${crypto.randomBytes(12).toString('hex')}` }, entry.body), { created: now() }), tz));
    }
    if (!ev) return done(404, problem(404, 'notFound', 'Not Found'));
    if (method === 'PUT') return done(200, show(store(cal, Object.assign({}, entry.body, { id: ev.id }), { created: ev.created }), tz));
    if (method === 'DELETE') {
      if (ev.status === 'cancelled') return done(410, problem(410, 'deleted', 'Resource has been deleted'));
      Object.assign(ev, { status: 'cancelled', updated: now(), etag: String(++serial) });
      return done(204);
    }
    return done(400, problem(400, 'badRequest', 'Bad Request'));
  }

  return {
    requests,
    tokens: () => tokens.size,
    handles: (url) => /^https:\/\/(oauth2\.googleapis\.com\/token|www\.googleapis\.com\/calendar\/v3\/)/.test(String(url)),
    fetch: (url, init = {}) => {
      const u = new URL(String(url));
      return u.hostname === 'oauth2.googleapis.com' ? token(init) : api(u, init);
    },
    add(id, o = {}) { calendars.set(id, { summary: o.summary || id, role: o.role === undefined ? 'writer' : o.role, events: new Map() }); },
    share(id, role) { calendars.get(id).role = role; },
    typeIn(id, ev) {
      const cal = calendars.get(id);
      const e = store(cal, Object.assign({ id: `g${crypto.randomBytes(12).toString('hex')}`, organizer: { self: true } }, ev), { created: now() });
      return e.id;
    },
    remove(id, eventId) {
      const ev = calendars.get(id).events.get(eventId);
      Object.assign(ev, { status: 'cancelled', updated: now(), etag: String(++serial) });
    },
    edit(id, eventId, change) { Object.assign(calendars.get(id).events.get(eventId), change, { updated: now(), etag: String(++serial) }); },
    events: (id) => [...((calendars.get(id) || { events: new Map() }).events.values())].filter((ev) => ev.status !== 'cancelled'),
    all: (id) => [...((calendars.get(id) || { events: new Map() }).events.values())],
    writes: (since = 0) => requests.slice(since).filter((r) => r.method !== 'GET'),
  };
}
// A fake school site for hub-jobs' school reads (0006, docs/v1.3-homework.md §11.3): any https host ending in
// .school.example. h.school.serve(z, text) sets what the link with that z answers (an iCal text, or
// { status, body, headers }); every request is in h.school.requests ({ url, redirect }). An unknown z answers 404.
function fakeSchool() {
  const feeds = new Map();
  const requests = [];
  return {
    requests,
    handles: (url) => { try { const u = new URL(String(url)); return u.protocol === 'https:' && u.hostname.endsWith('.school.example'); } catch (e) { return false; } },
    fetch: async (url, init = {}) => {
      const u = new URL(String(url));
      requests.push({ url: String(url), redirect: init.redirect || null });
      const r = feeds.get(u.searchParams.get('z'));
      if (r == null) return new Response('Not found', { status: 404 });
      if (typeof r === 'string') return new Response(r, { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' } });
      return new Response(r.body || '', { status: r.status || 200, headers: r.headers || {} });
    },
    serve(z, text) { feeds.set(z, text); },
  };
}
// A fake Anthropic for hub-jobs' homework_ai (docs/v1.3-homework.md §6.5): POST https://api.anthropic.com/v1/messages,
// made up, never the real one. Every request is in h.anthropic.requests ({ headers, body }, the body parsed). It answers
// a valid plan built from the user message's own fields (kind, session_minutes, due, the free_time days and, for a
// revise, current_plan: its locked steps sent back with their refs, the first one changed and the others left out, as
// a model might, for homework.ts to put back), or the next reply queued with h.anthropic.next({ status, body, headers })
// (a body object is sent as JSON), or a function of the request that gives one (it may be async, to change the database
// while the run is open). The usage is fixed: 2600 in (1600 of them a cache write), 2200 out.
function fakeAnthropic() {
  const requests = [];
  const queue = [];
  const tag = (m, n) => { const x = new RegExp(`<${n}(?: [^>]*)?>([^]*?)</${n}>`).exec(m); return x ? x[1].trim() : null; };
  function plan(message) {
    const kind = tag(message, 'kind');
    const session = Number(tag(message, 'session_minutes')) || 20;
    const due = ((tag(message, 'due') || '').match(/\d{4}-\d{2}-\d{2}/) || [null])[0];
    const days = (tag(message, 'free_time') || '').split('\n').map((l) => (l.match(/\d{4}-\d{2}-\d{2}/) || [null])[0]).filter(Boolean);
    const day = (i) => (days.length ? days[Math.min(i, days.length - 1)] : due);
    let current = [];
    try { current = JSON.parse(tag(message, 'current_plan') || 'null') || []; } catch (e) { current = []; }
    const locked = current.filter((x) => x && x.locked === true);
    const revise = current.length > 0;
    const steps = [
      { ref: 'new', kind: 'start', title: 'Copy the requirements into your notes', done_looks_like: 'the list of requirements in your notes', minutes: 5, day: day(0) },
      { ref: 'new', kind: 'step', title: revise ? 'Find one source and save its title' : 'Find 2 sources and save their titles',
        done_looks_like: revise ? 'one title in your notes' : '2 titles in your notes', minutes: Math.min(session, revise ? 10 : 20), day: day(0) },
    ];
    if (locked[0]) steps.push({ ref: locked[0].ref, kind: locked[0].kind, title: `${locked[0].title} (changed)`, done_looks_like: 'changed by the AI', minutes: 5, day: day(1) });
    steps.push({ ref: 'new', kind: 'milestone', title: 'Outline with 3 main points', done_looks_like: 'an outline you can show', minutes: Math.min(session, 20), day: day(1) },
      { ref: 'new', kind: 'check', title: 'Check it against the instructions', done_looks_like: 'every point of the sheet ticked', minutes: Math.min(session, 15), day: day(2) });
    if (kind !== 'lesson') steps.push({ ref: 'new', kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: due });
    return { summary: 'Make a poster about one river with two sources.', questions: revise ? [] : ['Did your teacher say which materials are allowed?'],
      steps, stretch: 'Which part of the river would you most like to show in detail?', fits: true, note_for_adult: '' };
  }
  const ok = (body) => ({
    id: `msg_realdb_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: JSON.stringify(plan(String(((body.messages || [])[0] || {}).content || ''))) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1000, cache_creation_input_tokens: 1600, cache_read_input_tokens: 0, output_tokens: 2200 },
  });
  return {
    requests,
    handles: (url) => String(url).startsWith('https://api.anthropic.com/'),
    fetch: async (url, init = {}) => {
      const req = { url: String(url), method: init.method || 'GET', headers: Object.assign({}, init.headers), body: JSON.parse(init.body || 'null') };
      requests.push(req);
      if (req.url !== 'https://api.anthropic.com/v1/messages' || req.method !== 'POST') return new Response('{"type":"error","error":{"type":"not_found_error","message":"Not found"}}', { status: 404 });
      let r = queue.shift();
      if (typeof r === 'function') r = await r(req);   // a reply may first do something while "Claude is thinking"
      if (!r) r = { status: 200, body: ok(req.body) };
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return new Response(text, { status: r.status || 200, headers: Object.assign({ 'content-type': 'application/json' }, r.headers || {}) });
    },
    next(r) { queue.push(r); },
    plan,
  };
}
// supabase-js 2.117.3 (the vendored browser build) in Node, for the Edge Function's clients.
let supabaseLib = null;
function supabaseJs() {
  if (!supabaseLib) {
    vm.runInThisContext(`${SUPA_JS.toString('utf8')}\n;globalThis.__realdbSupabase = supabase;`, { filename: 'supabase.js' });
    supabaseLib = globalThis.__realdbSupabase;
  }
  return supabaseLib;
}
const SHOTS = path.join(__dirname, '../e2e/shots/');

function env(name) {
  const v = process.env[name];
  if (!v) { console.log(`FAIL  realdb: ${name} isn't set (run tests/realdb/run.sh)`); process.exit(1); }
  return v;
}

async function setup(name, opts = {}) {
  const socket = env('REALDB_SOCKET');
  const port = env('REALDB_PORT');
  // The template: the full database (every migration), the v1 one (opts.v1), v2 without migration 0003
  // (opts.v2), v1.1 without migration 0004 (opts.v3), v1.2 without migration 0005 (opts.v4), or v1.3 without
  // migration 0006 (opts.v5).
  const template = opts.v1 ? env('REALDB_V1_TEMPLATE') : opts.v2 ? env('REALDB_V2_TEMPLATE') : opts.v3 ? env('REALDB_V3_TEMPLATE')
    : opts.v4 ? env('REALDB_V4_TEMPLATE') : opts.v5 ? env('REALDB_V5_TEMPLATE') : env('REALDB_TEMPLATE');
  const dbName = `rt_${name}`;
  const admin = await connect({ socketDir: socket, port, database: 'postgres' });
  await admin.query(`drop database if exists ${ident(dbName)}`);
  const made = await admin.query(`create database ${ident(dbName)} template ${ident(template)}`);
  await admin.close();
  if (made.error) { console.log(`FAIL  realdb: create ${dbName}  (${made.error.message})`); process.exit(1); }
  const roots = {};
  if (process.env.REALDB_V1_ROOT) roots['/v1/'] = process.env.REALDB_V1_ROOT;
  if (process.env.REALDB_V1A_ROOT) roots['/v1a/'] = process.env.REALDB_V1A_ROOT;
  // hub-jobs: the real handler (supabase/functions/hub-jobs/handler.ts), with supabase-js clients on this
  // server (the service role, or the caller's sign-in) and Resend faked: what it would send is in h.sent.
  const sent = [];
  const fnEnv = {
    HUB_CRON_SECRET: CRON_SECRET, SITE_URL: 'https://family.example/hub/', RESEND_API_KEY: 're_test_realdb', EMAIL_FROM: 'home@family.example',
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }), SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_realdb' }),
    GOOGLE_SA_JSON: SA_JSON, ANTHROPIC_API_KEY: AI_KEY,
  };
  let server;
  const functions = {};
  const google = fakeGoogle(() => server.hubNow());
  const school = fakeSchool();
  const anthropic = fakeAnthropic();
  // The AI planner's work (EdgeRuntime.waitUntil in index.ts): h.aiDone() waits for every run started so far.
  const background = [];
  if (opts.hubJobs !== false && !opts.v1) {
    const { handle } = await import(path.join(REPO, 'supabase/functions/hub-jobs/handler.ts'));
    // The made-up school's hosts (*.school.example), as the fn and db tests use, in place of *.myschoolapp.com.
    (await import(path.join(REPO, 'supabase/functions/hub-jobs/school.ts'))).SCHOOL_HOST.suffix = '.school.example';
    const sb = supabaseJs();
    const auth = { persistSession: false, autoRefreshToken: false };
    functions['hub-jobs'] = (req) => handle(req, {
      env: (n) => (n === 'SUPABASE_URL' ? server.base : fnEnv[n]),
      fetch: async (url, init) => {
        if (String(url).startsWith('https://api.resend.com/')) {
          sent.push(Object.assign(JSON.parse(init.body), { idempotencyKey: init.headers['Idempotency-Key'] }));
          return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (google.handles(url)) return google.fetch(url, init);
        if (school.handles(url)) return school.fetch(url, init);
        if (anthropic.handles(url)) return anthropic.fetch(url, init);
        return new Response('ok', { status: 200 });
      },
      background: (p) => { background.push(p); },
      service: () => sb.createClient(server.base, SERVICE_KEY, { auth }),
      user: (authorization) => sb.createClient(server.base, 'sb_publishable_realdb', { global: { headers: { Authorization: authorization } }, auth }),
      now: () => Date.parse(server.hubNow()),
      sleep: async () => {},
    });
  }
  server = await start({ socket, port, db: dbName, now: opts.now, roots, emailSending: opts.emailSending, functions });
  const browser = await chromium.launch();
  const results = [];
  const errors = [];
  const base = server.base;

  const api = async (p, init) => {
    const r = await fetch(base + p, init);
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const sql = async (query) => {
    const r = await api('/__test/sql', { method: 'POST', body: JSON.stringify({ sql: query }) });
    if (r.body.error) throw new Error(`sql: ${r.body.error.message} in ${query}`);
    return r.body.rows;
  };
  // A migration file run the way the owner runs it (its own session, as the SQL editor's), after which
  // the server reads the schema again, as Supabase's PostgREST does after DDL: → { error, notices }.
  const migrate = async (file) => (await api('/__test/migrate', { method: 'POST', body: JSON.stringify({ sql: fs.readFileSync(path.join(REPO, file), 'utf8') }) })).body;
  const clockNow = async () => (await api('/__test/clock')).body.now;
  const setClock = async (now) => (await api('/__test/clock', { method: 'POST', body: JSON.stringify({ now }) })).body.now;
  let seen = 0;
  // The API requests since the last mark (or all of them): { method, path, query, status, error, body, role, email }.
  const requests = async (all) => {
    const r = await api(`/__test/requests?after=${all ? 0 : seen}`);
    return r.body.requests;
  };
  const mark = async () => { seen = (await api('/__test/requests?after=0')).body.count; };
  const failed = async (all) => (await requests(all)).filter((r) => r.status >= 400);

  // A session for `email`, the way the site gets one: ask for a code, then type it.
  async function sessionFor(email) {
    const otp = await api('/auth/v1/otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, create_user: true }) });
    if (otp.status !== 200) throw new Error(`otp for ${email}: ${otp.status} ${JSON.stringify(otp.body)}`);
    const v = await api('/auth/v1/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, token: '123456', type: 'email' }) });
    if (v.status !== 200) throw new Error(`verify for ${email}: ${v.status} ${JSON.stringify(v.body)}`);
    return v.body;
  }

  const DESKTOP = { viewport: { width: 1280, height: 900 } };
  const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  // A browser context signed in as `email` (null: signed out), at a phone or desktop size, with the
  // device in `tz` (default America/Los_Angeles: not the household's zone), its clock at the household's "now".
  async function open(o = {}) {
    const context = await browser.newContext(Object.assign({ timezoneId: o.tz || 'America/Los_Angeles', colorScheme: o.dark ? 'dark' : 'light' }, o.phone ? PHONE : DESKTOP));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    if (o.email) {
      const session = JSON.stringify(await sessionFor(o.email));
      await context.addInitScript((s) => { try { localStorage.setItem('sb-127-auth-token', s); } catch (e) { /* */ } }, session);
    }
    const page = await context.newPage();
    await page.clock.install({ time: new Date(await clockNow()) });
    const label = o.label || o.email || 'signed out';
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const where = (m.location() || {}).url || '';
      // Failed loads are logged by Chrome; the request log says what they were.
      if (/Failed to load resource/.test(m.text()) && /\/(rest|functions|auth)\/v1\//.test(where)) return;
      errors.push(`${label} console: ${m.text()} ${where}`);
    });
    page.on('dialog', (d) => d.accept());
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'application/javascript', body: SUPA_JS }));
    if (o.path !== undefined) {
      await page.goto(base + o.path);
      await settle(page);
    }
    return { page, context };
  }

  async function settle(page, ms = 300) {
    await page.waitForFunction(() => !document.querySelector('#main > .loading, #app > .loading, #app > .page > .loading, #app > p.loading'), null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(ms);
  }
  const go = async (page, hash) => {
    await page.evaluate((h) => { if (location.hash === h) HomeHub.core.route(); else location.hash = h; }, hash);
    await settle(page);
  };
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const lastToast = async (page) => (await texts(page, '.toasts .toast, body > .toast')).slice(-1)[0] || '';
  const titles = (page, sel) => page.$$eval(`${sel} .irow-title`, (es) => es.map((e) => e.firstChild.textContent.trim()));
  const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, `realdb-${n}.png`), fullPage: true }).catch(() => {});
  const check = (n, ok, detail) => {
    const line = `${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && detail !== undefined ? `  (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`;
    results.push(line);
    console.log(line);
    return ok;
  };
  // Run one flow: a step that throws is a FAIL line, and the next flow still runs.
  const flow = async (n, fn) => {
    if (process.env.ONLY && !process.env.ONLY.split(',').includes(n)) return;
    try { await fn(); } catch (e) { check(`${n}: ran to the end`, false, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
  };
  async function finish() {
    if (errors.length) check('no page errors or console errors', false, errors.join(' || '));
    else check('no page errors or console errors', true);
    await browser.close();
    await server.close();
    const failedN = results.filter((r) => r.startsWith('FAIL')).length;
    console.log(`== ${name}: ${results.length - failedN} passed, ${failedN} failed`);
    // A file with two setups (jobs.test.js) fails if either did.
    process.exitCode = failedN || process.exitCode ? 1 : 0;
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  // Run the morning email now, as pg_cron would.
  const runDigest = () => api('/functions/v1/hub-jobs', { method: 'POST', headers: { 'x-hub-cron': CRON_SECRET, 'content-type': 'application/json' }, body: '{}' });
  // Run the calendar job now, as pg_cron would (supabase/cron.sql's hub-calendar).
  const runCalendar = () => api('/functions/v1/hub-jobs', { method: 'POST', headers: { 'x-hub-cron': CRON_SECRET, 'content-type': 'application/json' }, body: '{"action":"calendar"}' });
  // hub-jobs with someone's sign-in (Sync now, Test, preview, status), as the Settings page asks it.
  const hubJobsAs = async (email, body) => {
    const token = (await sessionFor(email)).access_token;
    return api('/functions/v1/hub-jobs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
  const aiDone = async () => { while (background.length) await Promise.all(background.splice(0)); };
  return { base, browser, server, sent, google, school, anthropic, fnEnv, aiDone, AI_KEY, runDigest, runCalendar, hubJobsAs, api, sql, migrate, clockNow, setClock, requests, mark, failed, sessionFor, open, settle, go, tc, texts, lastToast, titles, until, shot, check, flow, finish, errors };
}

// Homework (migration 0005, docs/v1.3-homework.md §3): its eleven tables and twenty-six public
// functions, as request paths. A site on a database before 0005 asks for none of them.
const HOMEWORK_TABLES = ['homework_kids', 'homework_times', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions', 'rewards', 'reward_asks',
  'points_ledger', 'homework_use', 'ai_runs'];
const HOMEWORK_FNS = ['homework_week', 'save_homework_kid', 'add_homework_time', 'save_homework_plan', 'homework_step', 'decide_reward', 'give_points', 'void_points',
  'save_tutor_link', 'new_tutor_token', 'homework_ai_preview', 'homework_ai_draft', 'erase_homework',
  'homework_by_token', 'step_by_token', 'plan_by_token', 'focus_by_token', 'reward_by_token', 'assignment_by_token', 'homework_prefs_by_token',
  'tutor_view_by_token', 'tutor_assignment_by_token', 'tutor_plan_by_token', 'tutor_step_by_token', 'homework_ai_start', 'homework_ai_finish'];
const HOMEWORK_CALLS = new RegExp(`^/rest/v1/(${HOMEWORK_TABLES.join('|')}|rpc/(${HOMEWORK_FNS.join('|')}))$`);
// The school feed (migration 0006, docs/v1.3-homework.md §12): its two tables and nine public functions, as request
// paths. A site on a database before 0006 asks for none of them.
const SCHOOL_TABLES = ['school_feeds', 'school_items'];
const SCHOOL_FNS = ['school_feed_status', 'set_school_feed', 'check_school_feed', 'pause_school_feed', 'school_item_action', 'school_item_by_token',
  'school_begin', 'school_store', 'school_finish'];
const SCHOOL_CALLS = new RegExp(`^/rest/v1/(${SCHOOL_TABLES.join('|')}|rpc/(${SCHOOL_FNS.join('|')}))$`);

module.exports = { setup, HOMEWORK_TABLES, HOMEWORK_FNS, HOMEWORK_CALLS, SCHOOL_TABLES, SCHOOL_FNS, SCHOOL_CALLS };
