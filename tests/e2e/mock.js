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

// ---- Schema 3 (supabase/migrations/0003_google_calendar.sql): Google Calendar.
// withCalendars(db) adds the four tables, as a database with 0003 has them. makeDb() leaves them out,
// so on schema 2 a stray read of them answers 404, as it would in production.
//   calendars       members read; admins write the setting columns only (the migration's column
//                   grants), with its checks, its unique Google ID, one writing calendar per column, and
//                   its trigger (Google ID lowercased, label trimmed, a new Google ID or a switch between
//                   writing and reading starts the calendar again). Deleting one deletes its Google
//                   events and leaves its links without a calendar, as the foreign keys do.
//   calendar_links  admins read (members get no rows); google_events, calendar_sync: members read.
//                   Nobody signed in writes those three (hub-jobs does, as service_role).
const CAL_TABLES = ['calendars', 'calendar_links', 'google_events', 'calendar_sync'];
const CAL_INSERT = ['google_id', 'kind', 'person_id', 'label', 'writes', 'for_kids'];
const CAL_UPDATE = CAL_INSERT.concat(['copy_approved_at']);
function withCalendars(db, sync) {
  return Object.assign(db, {
    calendars: [], calendar_links: [], google_events: [],
    calendar_sync: [Object.assign({ id: true, auth: null, account: null, key_id: null, running_since: null, run_id: null, last_run_at: null, last_ok_at: null,
      last_stop: null, last_error: null, last_result: {}, window_from: null, window_to: null, paused_until: null, pause_step: 0 }, sync)],
  });
}
// A calendars row with the table's defaults.
const calendarRow = (o) => Object.assign({
  id: uuid(), google_id: null, kind: 'person', person_id: null, label: '', writes: true, for_kids: false, copy_approved_at: null,
  google_name: null, access_role: null, status: 'new', status_detail: null, checked_at: null, read_at: null,
  created_at: now(), updated_at: now(), updated_by: null,
}, o);
// A calendar_links row (what hub-jobs wrote to Google) and a google_events row (an event read from Google).
const linkRow = (o) => Object.assign({
  google_calendar: null, base_id: `hh${crypto.randomBytes(16).toString('hex')}`, event_id: null, gen: 0, calendar_id: null, item_kind: 'event', item_id: null,
  job_id: null, occurrence: null, part: '', day: null, end_day: null, title: '', hash: null, tried_hash: null, google_hash: null, google_updated: null,
  repairs: 0, repaired_at: null, repair_kind: null, status: 'ok', attempts: 0, next_try_at: null, failing_since: null, error: null, synced_at: null, created_at: now(),
}, o);
const googleEventRow = (o) => Object.assign({
  calendar_id: null, google_calendar: null, event_id: crypto.randomBytes(8).toString('hex'), title: '', location: null, all_day: true,
  start_day: null, end_day: null, start_at: null, end_at: null, private: false, repeating: false, google_updated: null, read_at: now(),
}, o);

const pgErr = (status, code, message) => ({ status, body: { code, message, details: null, hint: null } });
const CHECK = (name) => pgErr(400, '23514', `new row for relation "calendars" violates check constraint "${name}"`);
// The migration's checks and unique indexes on one calendars row (others: the rest of the table).
function calendarProblem(row, others) {
  if (!/^[a-z0-9._+#-]{1,200}@[a-z0-9.-]+\.[a-z]{2,}$/.test(row.google_id || '')) return CHECK('calendars_google_id_check');
  if (!['person', 'pets', 'house', 'family'].includes(row.kind)) return CHECK('calendars_kind_check');
  if (!(String(row.label || '').length >= 1 && String(row.label).length <= 40)) return CHECK('calendars_label_check');
  if ((row.kind === 'person') !== (row.person_id != null)) return CHECK('calendars_check');
  if (row.writes && !/^[a-z0-9._-]+@group\.calendar\.google\.com$/.test(row.google_id)) return CHECK('calendars_check1');
  if (row.for_kids && !(row.kind === 'family' && !row.writes)) return CHECK('calendars_check2');
  if (others.some((o) => o.google_id === row.google_id)) return pgErr(409, '23505', 'duplicate key value violates unique constraint "calendars_google_id_key"');
  if (row.writes && others.some((o) => o.writes && o.kind === row.kind && (o.person_id || null) === (row.person_id || null))) {
    return pgErr(409, '23505', 'duplicate key value violates unique constraint "calendars_one_writer"');
  }
  return null;
}
const tidyCalendar = (r) => {
  const t = Object.assign({}, r);
  if ('label' in t && t.label != null) t.label = String(t.label).trim();
  if ('google_id' in t && t.google_id != null) t.google_id = String(t.google_id).trim().toLowerCase();
  return t;
};

// The calendar tables' row-level security and grants. Returns { status, body, rows } or null (not one of them).
function calendarTables(db, table, method, body, member, rows) {
  if (!CAL_TABLES.includes(table) || !db[table]) return null;
  const denied = pgErr(403, '42501', `permission denied for table ${table}`);
  const admin = member.role === 'admin';
  if (method === 'GET') return { rows: table === 'calendar_links' && !admin ? [] : rows };
  if (table !== 'calendars') return denied;
  if (method === 'POST') {
    const items = Array.isArray(body) ? body : [body];
    if (items.some((r) => Object.keys(r).some((k) => !CAL_INSERT.includes(k)))) return denied;
    if (!admin) return pgErr(403, '42501', 'new row violates row-level security policy for table "calendars"');
    const made = [];
    for (const r of items) {
      const row = calendarRow(tidyCalendar(r));
      const bad = calendarProblem(row, db.calendars.concat(made));
      if (bad) return bad;
      made.push(row);
    }
    db.calendars.push(...made);
    return { status: 201, rows: made };
  }
  if (method === 'PATCH') {
    if (Object.keys(body || {}).some((k) => !CAL_UPDATE.includes(k))) return denied;
    if (!admin) return { status: 200, rows: [] };
    const patch = tidyCalendar(body);
    const next = rows.map((r) => {
      const n = Object.assign({}, r, patch, { updated_at: now() });
      if (n.google_id !== r.google_id || n.writes !== r.writes) {
        Object.assign(n, { status: 'new', status_detail: null, access_role: null, checked_at: null, read_at: null, copy_approved_at: null });
        if (n.google_id !== r.google_id) n.google_name = null;
      }
      return n;
    });
    for (const n of next) {
      const bad = calendarProblem(n, db.calendars.filter((o) => o.id !== n.id));
      if (bad) return bad;
    }
    rows.forEach((r, i) => Object.assign(r, next[i]));
    return { status: 200, rows };
  }
  if (method === 'DELETE') {
    if (!admin) return { status: 204, rows: [] };
    const gone = new Set(rows.map((r) => r.id));
    db.calendars.splice(0, db.calendars.length, ...db.calendars.filter((r) => !gone.has(r.id)));
    db.google_events.splice(0, db.google_events.length, ...db.google_events.filter((g) => !gone.has(g.calendar_id)));
    db.calendar_links.forEach((l) => { if (gone.has(l.calendar_id)) l.calendar_id = null; });
    return { status: 204, rows };
  }
  return denied;
}

// The household's wall-clock time of an instant, 'HH:MM:SS'.
function wallTime(instant, tz) {
  const o = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(instant)).forEach((p) => { o[p.type] = p.value; });
  return `${o.hour === '24' ? '00' : o.hour}:${o.minute}:${o.second}`;
}
const md5uuid = (s) => crypto.createHash('md5').update(s).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

// google_items(p_from, p_to), as the migration builds its agenda_item rows (§5.3): Google events
// overlapping the range, read from their calendar's current Google ID. db.googleFail makes it fail.
function googleItems(db, b) {
  (db.googleCalls = db.googleCalls || []).push([b.p_from, b.p_to]);
  if (db.googleFail) return { __status: 500, body: { code: 'XX000', message: 'Database restarting', details: null, hint: null } };
  const days = (x) => Date.parse(`${x}T00:00:00Z`) / 864e5;
  if (!b.p_from || !b.p_to || b.p_to < b.p_from || days(b.p_to) - days(b.p_from) > 61) {
    return { __status: 400, body: { code: '22023', message: 'google_items() needs a range of 1 to 62 days.', details: null, hint: null } };
  }
  const hh = (db.household && db.household[0]) || {};
  const tz = hh.tz || 'America/New_York';
  const out = db.google_events.filter((g) => g.start_day <= b.p_to && g.end_day >= b.p_from).map((g) => {
    const c = db.calendars.find((x) => x.id === g.calendar_id && x.google_id === g.google_calendar);
    if (!c) return null;
    return {
      kind: 'google', item_id: md5uuid(`${g.calendar_id}/${g.event_id}`), occurrence: g.start_day, title: g.title, day: g.start_day, end_day: g.end_day,
      all_day: g.all_day, start_at: g.start_at, end_at: g.end_at, local_start: g.start_at ? wallTime(g.start_at, tz) : null, local_end: g.end_at ? wallTime(g.end_at, tz) : null,
      responsible_id: c.kind === 'person' ? c.person_id : c.kind === 'pets' ? hh.pets_owner_id || null : c.kind === 'house' ? hh.house_owner_id || null : null,
      participant_ids: [], status: 'open', category: { family: 'family', pets: 'pets', house: 'home' }[c.kind] || null,
      project_id: null, project_name: null, contractor_id: null, contractor_name: null, contractor_phone: null,
      location: g.location, notes: `From Google Calendar · ${c.google_name || c.label}`,
      private: g.private, repeating: g.repeating, changed: false, lead_days: null, milestone: false, day_note: null,
    };
  }).filter(Boolean);
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return out.sort((x, y) => cmp(x.day, y.day) || (x.local_start == null) - (y.local_start == null) || cmp(x.local_start || '', y.local_start || '')
    || cmp(x.title, y.title) || cmp(x.item_id, y.item_id));
}

// calendar_preview(p_calendar): admins only. The rows come from db.previewRows[calendar id or its
// Google ID] (what calendar_desired would give for the job's window, yesterday to 60 days ahead:
// { day, title, private, item_kind, item_id, place, details }); an event or task that is private now
// reads "Private item", without place or details, so Make private shows in the next read.
function calendarPreview(db, b, email) {
  (db.previewCalls = db.previewCalls || []).push(b);
  const m = db.members.find((x) => x.email === email);
  if (!m || m.role !== 'admin') return { __status: 403, body: { code: '42501', message: 'Only an admin can see what goes on a calendar.', details: null, hint: null } };
  const c = (db.calendars || []).find((x) => x.id === b.p_calendar);
  const rows = (db.previewRows || {})[b.p_calendar] || (c && (db.previewRows || {})[c.google_id]) || [];
  return rows.map((r) => {
    const src = r.item_kind === 'event' ? (db.events || []).find((x) => x.id === r.item_id) : r.item_kind === 'task' ? (db.tasks || []).find((x) => x.id === r.item_id) : null;
    const priv = !!(r.private || (src && src.private));
    return { day: r.day, title: priv ? 'Private item' : r.title, private: priv, item_kind: r.item_kind, item_id: r.item_id,
      place: priv ? null : r.place || null, details: priv ? null : r.details || null };
  });
}
const calendarRpc = { google_items: googleItems, calendar_preview: calendarPreview };

// hub-jobs { action: 'calendar' } (Sync now) and { action: 'calendar_test', calendar_id }, in the
// shapes the build contract gives (docs/v1.1-google-calendar.md §3.4, §6.5), for a signed-in admin.
// db.jobMode[action]: 'old' (a hub-jobs from before v1.1: 400 Unknown action), 'missing' (not
// deployed: 404) or 'no_schema' (503). db.testReplies[google_id] overrides a Test's answer (it is
// recorded on the calendar, as calendar_mark does); db.syncReply is Sync now's ({ __status, body } for
// a failure).
const TEST_STEPS = [
  { step: 'list', ok: true, http: 200 }, { step: 'insert', ok: true, http: 200 }, { step: 'delete', ok: true, http: 204 },
  { step: 'restore', ok: true, http: 200 }, { step: 'read', ok: true, http: 200 }, { step: 'compare', ok: true, http: null }, { step: 'cleanup', ok: true, http: 204 },
];
function calendarJob(db, body, email) {
  (db.jobCalls = db.jobCalls || []).push({ body, email });
  const mode = (db.jobMode || {})[body.action];
  if (mode === 'old') return { status: 400, body: { error: 'Unknown action. Use digest, preview or status.' } };
  if (mode === 'missing') return { status: 404, body: { code: 'NOT_FOUND', message: 'Requested function was not found' } };
  if (mode === 'no_schema') return { status: 503, body: { stop: 'no_schema', error: 'Google Calendar (migration 0003) isn\'t installed.' } };
  const m = db.members.find((x) => x.email === email);
  if (!m) return { status: 401, body: { error: 'Sign in first.' } };
  if (m.role !== 'admin') return { status: 403, body: { error: 'Only family admins can do this.' } };
  if (body.action === 'calendar_test') {
    const c = db.calendars.find((x) => x.id === body.calendar_id);
    if (!c) return { status: 400, body: { error: 'calendar_id must name a calendar.' } };
    const r = Object.assign({ ok: true, status: 'ok', message: c.writes ? 'Home Hub can write to this calendar.' : 'Home Hub can read this calendar.',
      name: c.writes ? `Hub – ${c.label}` : c.label, role: c.writes ? 'writer' : 'reader',
      steps: c.writes ? TEST_STEPS : TEST_STEPS.slice(0, 1) }, (db.testReplies || {})[c.google_id]);
    if (r.__status) return { status: r.__status, body: r.body };
    Object.assign(c, { status: r.status, status_detail: r.ok ? null : r.message, google_name: r.name || c.google_name, access_role: r.role || c.access_role, checked_at: now() });
    return { status: 200, body: r };
  }
  const r = db.syncReply || { read: 2, stored: 5, skipped: 0, repaired: 0, inserted: 3, updated: 1, deleted: 0, failed: 0, pending: 0, hiding: 0, stop: null };
  if (r.__status) return { status: r.__status, body: r.body };
  return { status: 200, body: r };
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
      if (db.calendars && path === '/functions/v1/hub-jobs' && body && (body.action === 'calendar' || body.action === 'calendar_test')) {
        const r = calendarJob(db, body, emailFrom(req));
        return reply(r.status, r.body);
      }
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
    // Schema 3's calendar tables: their own row-level security and grants (calendarTables above).
    const cal = calendarTables(db, table, method, body, member, db[table].filter(match));
    if (cal && cal.body) return reply(cal.status, cal.body);
    if (cal && method === 'DELETE') return route.fulfill({ status: 204, headers: CORS });
    if (cal && method !== 'GET') return out(cal.rows, cal.status);
    if (method === 'GET') {
      let rows = cal ? cal.rows : db[table].filter(match);
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

module.exports = { makeDb, install, signIn, expectedConsoleError, SUPA, withCalendars, calendarRow, linkRow, googleEventRow, calendarRpc, md5uuid };
