// Shared pieces for the real-database browser tests (tests/realdb/*.test.js).
//   const h = await setup('flows');      // its own copy of the template database, its own server, Chromium
//   const { page } = await h.open({ email: 'alex@example.com', phone: true, path: '/#/' });
//   await h.sql("select due_date from tasks where title = 'Heartworm pill'")  → [{ due_date: '2026-10-27' }]
//   h.check(name, ok, detail); … await h.finish();   // prints the PASS/FAIL lines, closes everything
// Signing in goes through the server's real /auth/v1/otp and /auth/v1/verify (code 123456); the session
// is then put where supabase-js keeps it. The browser's clock starts at the household's pinned "now".
const fs = require('fs');
const path = require('path');
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
  const template = opts.v1 ? env('REALDB_V1_TEMPLATE') : env('REALDB_TEMPLATE');
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
  };
  let server;
  const functions = {};
  if (opts.hubJobs !== false && !opts.v1) {
    const { handle } = await import(path.join(REPO, 'supabase/functions/hub-jobs/handler.ts'));
    const sb = supabaseJs();
    const auth = { persistSession: false, autoRefreshToken: false };
    functions['hub-jobs'] = (req) => handle(req, {
      env: (n) => (n === 'SUPABASE_URL' ? server.base : fnEnv[n]),
      fetch: async (url, init) => {
        if (String(url).startsWith('https://api.resend.com/')) {
          sent.push(Object.assign(JSON.parse(init.body), { idempotencyKey: init.headers['Idempotency-Key'] }));
          return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('ok', { status: 200 });
      },
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
    process.exitCode = failedN ? 1 : 0;
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  // Run the morning email now, as pg_cron would.
  const runDigest = () => api('/functions/v1/hub-jobs', { method: 'POST', headers: { 'x-hub-cron': CRON_SECRET, 'content-type': 'application/json' }, body: '{}' });
  return { base, browser, server, sent, runDigest, api, sql, clockNow, setClock, requests, mark, failed, sessionFor, open, settle, go, tc, texts, lastToast, titles, until, shot, check, flow, finish, errors };
}

module.exports = { setup };
