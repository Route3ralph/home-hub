// In-browser stand-in for Supabase (Auth + PostgREST) used by the Playwright tests.
// supabase-js itself is served from a vendored copy (vendor/supabase.js, the same 2.117.3 build
// index.html loads from jsDelivr), so the tests run offline.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPA = 'https://test.supabase.co';
const REPO = path.resolve(__dirname, '../..');
const SUPA_JS = fs.readFileSync(path.join(__dirname, 'vendor/supabase.js'));
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': '*',
};

let seq = 0;
const now = () => new Date(Date.UTC(2026, 9, 24, 16, 0, 0) + (seq++) * 1000).toISOString().replace('Z', '000+00:00');
const uuid = () => crypto.randomUUID();
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function jwtFor(email) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: `user-${email}`, email, role: 'authenticated', aud: 'authenticated', exp: 4102444800 })}.sig`;
}
function sessionFor(email) {
  return {
    access_token: jwtFor(email), refresh_token: 'refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: `user-${email}`, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
  };
}

function makeDb() {
  const kitchen = JSON.parse(fs.readFileSync(`${REPO}/supabase/kitchen-renovation.json`, 'utf8'));
  kitchen.trades.electrician.contractor_id = 'c-pat';
  kitchen.phases[0].tasks[0].private_notes = 'Side gate code 4821';
  const t = now();
  return {
    members: [
      { email: 'alex@example.com', name: 'Alex Example', role: 'admin', created_at: t },
      { email: 'sam@example.com', name: 'Sam Example', role: 'member', created_at: t },
    ],
    contractors: [
      { id: 'c-pat', name: 'Pat Lee', company: 'Lee Electric', trade: 'Electrician', phone: '(201) 555-0100', email: 'pat@leeelectric.example', website: 'leeelectric.example', notes: 'Licensed master electrician. Referred by the neighbors.', created_at: t, updated_at: t },
      { id: 'c-maria', name: 'Maria Gomez', company: 'Gomez Tile & Stone', trade: 'Tile', phone: '(201) 555-0101', email: null, website: null, notes: null, created_at: t, updated_at: t },
    ],
    projects: [
      { id: 'p-kitchen', name: 'Kitchen Renovation', status: 'active', summary: 'Cabinets, counters, tile, floors and paint.', schedule: kitchen, sharing_enabled: false, share_token: 'kitchentoken0123456789ab', created_at: t, updated_at: '2026-10-24T15:00:00.000000+00:00' },
      { id: 'p-pool', name: 'Pool repairs', status: 'planning', summary: 'New pump and plaster patch before summer.', schedule: { project: { start: '2027-03-01', holidays: [] }, trades: {}, phases: [] }, sharing_enabled: false, share_token: 'pooltoken0123456789abcde', created_at: t, updated_at: t },
      { id: 'p-sprinkler', name: 'Sprinkler winterization', status: 'idea', summary: null, schedule: { project: { start: '2026-11-09', holidays: [] }, trades: { irrigation: { name: 'Irrigation', who: 'TBD', color: '#16a34a' } }, phases: [{ name: 'Fall', tasks: [{ id: 'blowout', name: 'Blow out sprinkler lines', trade: 'irrigation', days: 1 }] }] }, sharing_enabled: false, share_token: 'sprinklertoken0123456789', created_at: t, updated_at: t },
    ],
  };
}

function emailFrom(req) {
  const auth = req.headers()['authorization'] || '';
  const tok = auth.replace(/^Bearer\s+/i, '');
  try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email || null; } catch (e) { return null; }
}

function sharedView(db, share) {
  const p = db.projects.find((x) => x.share_token === share && x.sharing_enabled);
  if (!p) return null;
  const s = JSON.parse(JSON.stringify(p.schedule));
  Object.values(s.trades || {}).forEach((t) => {
    const c = db.contractors.find((x) => x.id === t.contractor_id);
    delete t.contractor_id;
    if (c) t.who = [c.name, c.company].filter(Boolean).join(', ');
  });
  (s.phases || []).forEach((ph) => ph.tasks.forEach((tk) => delete tk.private_notes));
  return { name: p.name, updated_at: p.updated_at, schedule: s };
}

// PostgREST filter operators the app uses: eq, neq, gt, gte, lt, lte, is.null / is.true / is.false, in.(a,b), not.is.null
function matchFilter(value, spec) {
  let neg = false;
  if (spec.startsWith('not.')) { neg = true; spec = spec.slice(4); }
  const dot = spec.indexOf('.');
  const op = spec.slice(0, dot), arg = spec.slice(dot + 1);
  const cmp = (a, b) => (typeof a === 'number' ? a - Number(b) : String(a).localeCompare(String(b)));
  let ok;
  if (op === 'eq') ok = value != null && String(value) === arg;
  else if (op === 'neq') ok = value == null || String(value) !== arg;
  else if (op === 'is') ok = arg === 'null' ? value == null : String(value) === arg;
  else if (op === 'in') ok = arg.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')).includes(String(value));
  else if (op === 'gt') ok = value != null && cmp(value, arg) > 0;
  else if (op === 'gte') ok = value != null && cmp(value, arg) >= 0;
  else if (op === 'lt') ok = value != null && cmp(value, arg) < 0;
  else if (op === 'lte') ok = value != null && cmp(value, arg) <= 0;
  else if (op === 'cs') ok = Array.isArray(value) && arg.replace(/^\{|\}$/g, '').split(',').every((x) => value.map(String).includes(x));
  else throw new Error(`mock: unsupported filter ${spec}`);
  return neg ? !ok : ok;
}

async function install(page, db, log, opts = {}) {
  // The trailing * also matches a ?v=… cache-busting suffix.
  await page.route('**/config.js*', (route) => route.fulfill({ contentType: 'application/javascript',
    body: opts.noConfig ? "window.HOME_HUB_CONFIG = { supabaseUrl: '', supabaseKey: '' };" : `window.HOME_HUB_CONFIG = { supabaseUrl: '${SUPA}', supabaseKey: 'sb_publishable_test', emailSending: ${!!opts.emailSending} };` }));
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'application/javascript', body: SUPA_JS }));
  await page.route(`${SUPA}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const path = url.pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const reply = (status, payload) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: payload === undefined ? '' : JSON.stringify(payload) });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    log.push(`${method} ${path}${url.search}`);
    if (opts.offline) return route.abort('internetdisconnected');

    // ---- Auth
    if (path === '/auth/v1/otp') {
      if (opts.smtpDown) return reply(500, { code: 500, error_code: 'unexpected_failure', msg: 'Error sending magic link email' });
      if (!db.members.some((m) => m.email === String(body.email).toLowerCase())) {
        return reply(403, { code: 403, error_code: 'hook_error', msg: 'This email is not on the family list.' });
      }
      return reply(200, {});
    }
    if (path === '/auth/v1/verify' && method === 'POST') {
      (db.verifyCalls = db.verifyCalls || []).push(body);
      if (body.type === 'email' && body.token === '123456' && db.members.some((m) => m.email === body.email)) return reply(200, sessionFor(body.email));
      return reply(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
    }
    if (path === '/auth/v1/user') return reply(200, sessionFor(emailFrom(req)).user);
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204, headers: CORS });
    if (path === '/auth/v1/token') return reply(200, sessionFor('alex@example.com'));

    // ---- Edge functions
    if (path.startsWith('/functions/v1/')) {
      (db.functionCalls = db.functionCalls || []).push({ path, body, email: emailFrom(req) });
      return reply(opts.fnStatus || 200, opts.fnBody || { sent: 1 });
    }

    // ---- RPC
    const email = emailFrom(req);
    const member = db.members.find((m) => m.email === email);
    if (path === '/rest/v1/rpc/whoami') return reply(200, member || null);
    if (path === '/rest/v1/rpc/get_shared_project') return reply(200, sharedView(db, body.share));
    // Tests can plug in more RPCs: opts.rpc = { name: (db, body, email) => result | { status, body } }
    if (path.startsWith('/rest/v1/rpc/')) {
      const name = path.slice('/rest/v1/rpc/'.length);
      (db.rpcCalls = db.rpcCalls || []).push({ name, body, email });
      const fn = opts.rpc && opts.rpc[name];
      // No handler: 404, as PostgREST answers for a missing function. hub_schema_version has no handler
      // unless a test adds one, so by default the site runs in v1 mode, as it does on today's database.
      if (!fn) return reply(404, { code: 'PGRST202', message: `Could not find the function public.${name}` });
      if (!member) return reply(401, { code: '42501', message: 'permission denied' });
      try {
        const out = fn(db, body || {}, email);
        if (out && out.__status) return reply(out.__status, out.body);
        return reply(200, out === undefined ? null : out);
      } catch (e) { return reply(400, { message: e.message }); }
    }

    // ---- Tables (row-level security: members only)
    const table = path.replace('/rest/v1/', '');
    if (!db[table]) return reply(404, { message: 'not found' });
    if (!member) return method === 'GET' ? reply(200, []) : reply(403, { code: '42501', message: `new row violates row-level security policy for table "${table}"` });
    const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k));
    const match = (row) => filters.every(([k, v]) => matchFilter(row[k], v));
    const wantsObject = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
    const out = (rows, status = 200) => {
      if (!wantsObject) return reply(status, rows);
      if (rows.length !== 1) return reply(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
      return reply(status, rows[0]);
    };
    if (method === 'GET') {
      let rows = db[table].filter(match);
      const order = url.searchParams.get('order');
      if (order) {
        const keys = order.split(',').map((o) => { const [col, dir, nulls] = o.split('.'); return { col, desc: dir === 'desc', nullsFirst: nulls === 'nullsfirst' }; });
        rows = rows.slice().sort((a, b) => {
          for (const k of keys) {
            const x = a[k.col], y = b[k.col];
            if (x == null && y == null) continue;
            if (x == null) return k.nullsFirst ? -1 : 1;
            if (y == null) return k.nullsFirst ? 1 : -1;
            const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
            if (c) return k.desc ? -c : c;
          }
          return 0;
        });
      } else if (table === 'contractors') rows.sort((a, b) => a.name.localeCompare(b.name));
      const limit = url.searchParams.get('limit');
      if (limit) rows = rows.slice(0, Number(limit));
      return out(rows);
    }
    if (method === 'POST') {
      if (table === 'members' && member.role !== 'admin') return reply(403, { code: '42501', message: 'new row violates row-level security policy for table "members"' });
      const keyed = ['members', 'household', 'contractor_secrets'].includes(table);
      const items = (Array.isArray(body) ? body : [body]).map((r) => {
        const t = now();
        const base = keyed ? { created_at: t } : { id: uuid(), created_at: t, updated_at: t };
        if (table === 'projects') Object.assign(base, { sharing_enabled: false, share_token: crypto.randomBytes(12).toString('hex'), status: 'planning' });
        return Object.assign(base, r);
      });
      db[table].push(...items);
      return out(items, 201);
    }
    if (method === 'PATCH') {
      const rows = db[table].filter(match);
      rows.forEach((r) => Object.assign(r, body, table === 'members' ? {} : { updated_at: now() }));
      return out(rows);
    }
    if (method === 'DELETE') {
      const keep = db[table].filter((r) => !match(r) || (table === 'members' && r.email === email));
      db[table].splice(0, db[table].length, ...keep);
      return route.fulfill({ status: 204, headers: CORS });
    }
    return reply(405, {});
  });
}

// In v1 mode the hub asks for hub_schema_version() and gets a 404, because that database doesn't have
// it yet. Chrome logs the 404 as a console error; that one is expected, any other failed load is not.
const expectedConsoleError = (m) => /status of 404/.test(m.text()) && /\/rest\/v1\/rpc\/hub_schema_version$/.test(m.location().url || '');

async function signIn(context, email) {
  const session = JSON.stringify(sessionFor(email));
  await context.addInitScript((s) => { try { localStorage.setItem('sb-test-auth-token', s); } catch (e) {} }, session);
}

module.exports = { makeDb, install, signIn, expectedConsoleError, SUPA };
