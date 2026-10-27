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
// reads "Private item", without place or details, so Make private shows in the next read (a dinner keeps
// its title: a locked one is "Dinner: Private item" already).
function calendarPreview(db, b, email) {
  (db.previewCalls = db.previewCalls || []).push(b);
  const m = db.members.find((x) => x.email === email);
  if (!m || m.role !== 'admin') return { __status: 403, body: { code: '42501', message: 'Only an admin can see what goes on a calendar.', details: null, hint: null } };
  const c = (db.calendars || []).find((x) => x.id === b.p_calendar);
  const rows = (db.previewRows || {})[b.p_calendar] || (c && (db.previewRows || {})[c.google_id]) || [];
  return rows.map((r) => {
    const src = r.item_kind === 'event' ? (db.events || []).find((x) => x.id === r.item_id) : r.item_kind === 'task' ? (db.tasks || []).find((x) => x.id === r.item_id) : null;
    const priv = !!(r.private || (src && src.private));
    // A locked dinner (schema 4) is already "Dinner: Private item" in what the wall gets, as the real one says.
    return { day: r.day, title: priv && r.item_kind !== 'meal' ? 'Private item' : r.title, private: priv, item_kind: r.item_kind, item_id: r.item_id,
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

// ---- Schema 4 (supabase/migrations/0004_meals_and_shopping.sql, docs/v1.2-kitchen.md §3–§4): dinners
// and the shopping list. withFood(db, { now, helperList, mealsOnWall }) adds the two tables, as a
// database with 0004 has them (makeDb() leaves them out, so on schema 2 or 3 a stray read answers 404
// and a stray call of a list function 404 PGRST202, as live), the household's meals_on_wall and
// helper_list, and my_day_use (the My day caps), and 0003's calendar tables when the database doesn't
// have them yet (withCalendars). Use it only for a schema-4 database.
//   meals           members read, plan, change and clear (insert and update only the page's columns,
//                   upsert on (day, slot)), with the table's checks and its tidy trigger
//   shopping_items  members read, change name / note / aisle / private, and forget (delete); no insert
//                   (adds go through add_to_list); a rename or lock clash is 23505
//   household       admins change it (members get no rows back, as row-level security answers)
// foodRpc has the functions, with the migration's shapes and rules (§3.4, §4.1, §4.2): shopping_list,
// add_to_list, buy_item (signed in), and get_list_by_token, add_to_list_by_token, buy_item_by_token
// (My day: mock.js answers RPCs for members only, so a My day test routes these itself, as day.test.js
// does for the other token functions). personDayFood(db, person, answer) adds get_person_day's meals
// and list keys to an answer. Times: db.foodNow (ms; from opts.now, else db.clock's household date and
// time, else Tue 2026-10-27 09:42 in New York) is "now"; every write is stamped a little after it, with
// microseconds, as Postgres keeps them (to_jsonb writes them as text: a page that turns seen into a
// Date loses them, and its ticks no longer match). Move the clock with db.foodNow += 16 * 60e3.
const FOOD_TABLES = ['meals', 'shopping_items'];
const AISLE_KEYS = ['produce', 'bakery', 'pantry', 'drinks', 'household', 'personal', 'meat', 'dairy', 'frozen', 'other'];
const MEAL_COLUMNS = ['day', 'slot', 'kind', 'title', 'cook_id', 'note', 'link', 'private'];
const ITEM_COLUMNS = ['name', 'note', 'aisle', 'private'];
const SLOTS = ['breakfast', 'lunch', 'dinner'];
// A small stand-in for private.food_words(): English / Spanish pairs and their aisle.
const FOOD_WORDS = [
  ['milk', 'leche', 'dairy'], ['eggs', 'huevos', 'dairy'], ['butter', 'mantequilla', 'dairy'], ['cheese', 'queso', 'dairy'], ['yogurt', 'yogur', 'dairy'],
  ['apples', 'manzanas', 'produce'], ['bananas', 'plátanos', 'produce'], ['onions', 'cebollas', 'produce'], ['tomatoes', 'tomates', 'produce'],
  ['potatoes', 'papas', 'produce'], ['lemons', 'limones', 'produce'], ['cilantro', 'cilantro', 'produce'], ['lettuce', 'lechuga', 'produce'],
  ['tortillas', 'tortillas', 'bakery'], ['bagels', 'bagels', 'bakery'], ['rice', 'arroz', 'pantry'], ['beans', 'frijoles', 'pantry'], ['flour', 'harina', 'pantry'],
  ['sugar', 'azúcar', 'pantry'], ['coffee', 'café', 'drinks'], ['juice', 'jugo', 'drinks'], ['water', 'agua', 'drinks'],
  ['chicken', 'pollo', 'meat'], ['beef', 'carne de res', 'meat'], ['fish', 'pescado', 'meat'],
  ['detergent', 'detergente', 'household'], ['soap', 'jabón', 'household'], ['paper towels', 'toallas de papel', 'household'],
  ['shampoo', 'champú', 'personal'], ['toothpaste', 'pasta de dientes', 'personal'], ['ice cream', 'helado', 'frozen'],
];
const FOOD_SAY = {
  en: { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', leftovers: 'Leftovers', out: 'Eating out', takeout: 'Takeout', fend: 'Fend for yourself',
    cooks: '{name} cooks', you_cook: 'You cook', on_dinner: "{name}'s on dinner", you_on_dinner: "You're on dinner", private_item: 'Private item' },
  es: { breakfast: 'Desayuno', lunch: 'Almuerzo', dinner: 'Cena', leftovers: 'Sobras', out: 'Comemos fuera', takeout: 'Comida para llevar', fend: 'Cada uno se arregla',
    cooks: 'Cocina {name}', you_cook: 'Cocinas tú', on_dinner: '{name} se encarga de la cena', you_on_dinner: 'Te encargas tú', private_item: 'Asunto privado' },
};
const foodWord = (key, lang, name) => String(FOOD_SAY[lang === 'es' ? 'es' : 'en'][key] || key).replace('{name}', name || '');
// The amount in front of a name (§4.1, step 1), the database's regular expression written for JavaScript.
const FOOD_AMOUNT = /^([0-9]{1,3})(?:\s*x)?\s+(?:(lbs?|oz|kg|g|dozen|packs?|bags?|cans?|bottles?|box(?:es)?|jars?|gallons?|bunch(?:es)?|libras?|kilos?|docenas?|paquetes?|bolsas?|latas?|botellas?|cajas?)\s+(?:(?:of|de)\s+)?)?(\p{L}.{2,})$/iu;

// private.clean_text(p_text, p_max)
function cleanText(text, max) {
  if (text == null) return null;
  const s = String(text)
    .replace(/[\u0001-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
    .trim();
  return Array.from(s).slice(0, Math.max(max, 0)).join('').trimEnd();
}
const plain = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const wordsOf = (s) => plain(s).split(/[^a-z0-9ñ]+/).filter(Boolean);
// private.guess_aisle: the whole name, then each word from the last, with a trailing s or es also tried.
function guessAisle(name) {
  const known = new Map();
  FOOD_WORDS.forEach(([en, es, aisle]) => { known.set(plain(en), aisle); known.set(plain(es), aisle); });
  const whole = plain(name).trim();
  if (known.has(whole)) return known.get(whole);
  for (const w of wordsOf(name).reverse()) {
    for (const x of [w, `${w}s`, `${w}es`, w.replace(/e?s$/, '')]) if (known.has(x)) return known.get(x);
  }
  return 'other';
}
// private.food_other(p_name, p_lang): the same thing in p_lang, when the whole name is a word in the other one.
function foodOther(name, lang) {
  const n = plain(cleanText(name, 60));
  const pair = FOOD_WORDS.find(([en, es]) => plain(lang === 'es' ? en : es) === n);
  if (!pair) return null;
  const word = lang === 'es' ? pair[1] : pair[0];
  return plain(word) === n ? null : word;
}

// Instants with microseconds, as Postgres writes a timestamptz ('2026-10-27T13:42:00.001001+00:00').
function micros(s) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(String(s == null ? '' : s).replace(' ', 'T'));
  if (!m) return null;
  const tz = m[3] === 'Z' ? 'Z' : m[3].length === 3 ? `${m[3]}:00` : m[3].replace(/^([+-]\d\d)(\d\d)$/, '$1:$2');
  return Date.parse(`${m[1]}${tz}`) * 1000 + Number((m[2] || '').padEnd(6, '0'));
}
const fromMicros = (us) => `${new Date(Math.floor(us / 1000)).toISOString().slice(0, 19)}.${String(us % 1000000).padStart(6, '0')}+00:00`;
const sameInstant = (a, b) => a != null && b != null && micros(a) !== null && micros(a) === micros(b);
function foodStamp(db) {
  db.foodTick = (db.foodTick || 0) + 1;
  return fromMicros(db.foodNow * 1000 + db.foodTick * 1001);
}
const foodTz = (db) => ((db.household && db.household[0]) || {}).tz || 'America/New_York';
function localOf(ms, tz) {
  const o = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour === '24' ? '00' : o.hour}:${o.minute}` };
}
// The instant of a wall-clock date and time ('09:15:00') in a zone.
function instantOf(date, time, tz) {
  const [h, m, sec] = String(time || '00:00:00').split(':').map((x) => Number(x) || 0);
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const l = localOf(t, tz);
    t += guess - Date.parse(`${l.date}T${l.time}:00Z`);
  }
  return t + sec * 1000;
}

function withFood(db, opts) {
  const o = opts || {};
  const hh = (db.household && db.household[0]) || null;
  if (hh) Object.assign(hh, { meals_on_wall: o.mealsOnWall === undefined ? true : o.mealsOnWall, helper_list: o.helperList || 'add' });
  const tz = foodTz(db);
  db.foodNow = o.now ? Date.parse(o.now)
    : db.clock && db.clock.local_date ? instantOf(db.clock.local_date, db.clock.local_time || '09:00:00', tz)
      : Date.parse('2026-10-27T13:42:00Z');
  // A schema-4 database has 0003's tables too (the Food page asks whether there is a Family calendar).
  if (!db.calendars) withCalendars(db);
  return Object.assign(db, { meals: [], shopping_items: [], my_day_use: [] });
}
// A meals row and a shopping_items row with the tables' defaults.
const mealRow = (o) => Object.assign({
  id: uuid(), day: null, slot: 'dinner', kind: 'cook', title: null, cook_id: null, note: null, link: null, private: false,
  created_at: now(), created_by: null, updated_at: now(), updated_by: null,
}, o);
const shopItem = (o) => {
  const r = Object.assign({
    id: uuid(), name: '', note: null, aisle: 'other', private: false, added_at: now(), added_by: null, bought_at: null, bought_by: null,
    updated_at: now(), updated_by: null,
  }, o);
  r.name_key = String(r.name).toLowerCase();
  return r;
};

class Raise extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const FOOD_STATUS = { 42501: 403, 22023: 400, P0001: 400, 54000: 413, 23505: 409, 23514: 400, 23503: 409, PGRST202: 404 };
const raised = (e, anon) => ({ __status: e.code === '42501' && anon ? 401 : FOOD_STATUS[e.code] || 400, body: { code: e.code, message: e.message, details: null, hint: null } });
const tableErr = (e) => { const r = raised(e); return { status: r.__status, body: r.body }; };
const foodCheck = (table, name) => new Raise('23514', `new row for relation "${table}" violates check constraint "${name}"`);

// meals: the table's checks (after its tidy trigger), on one row.
function mealProblem(r, others, people) {
  if (!r.day || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) return new Raise('22007', `invalid input syntax for type date: "${r.day}"`);
  if (!SLOTS.includes(r.slot)) return foodCheck('meals', 'meals_slot_check');
  if (!['cook', 'leftovers', 'out', 'takeout', 'fend'].includes(r.kind)) return foodCheck('meals', 'meals_kind_check');
  if (r.link != null && !/^https:\/\/[!#-;=?-~]{4,500}$/.test(r.link)) return foodCheck('meals', 'meals_link_check');
  if ((r.kind === 'cook') !== (r.title != null)) return foodCheck('meals', 'meals_check');
  if (r.kind !== 'cook' && r.link != null) return foodCheck('meals', 'meals_check1');
  if (['out', 'fend'].includes(r.kind) && r.cook_id != null) return foodCheck('meals', 'meals_check2');
  if (r.cook_id != null && !people.some((p) => p.id === r.cook_id)) {
    return new Raise('23503', 'insert or update on table "meals" violates foreign key constraint "meals_cook_id_fkey"');
  }
  if (others.some((x) => x.day === r.day && x.slot === r.slot)) return new Raise('23505', 'duplicate key value violates unique constraint "meals_day_slot_key"');
  return null;
}
// meals_tidy: title and note cleaned to one line of at most 80 and 300 characters; '' becomes null.
function tidyMeal(r) {
  const t = Object.assign({}, r);
  if ('title' in t) t.title = cleanText(t.title, 80) || null;
  if ('note' in t) t.note = cleanText(t.note, 300) || null;
  return t;
}
// shopping_items: checks and the unique (name_key, private) index, on one row.
function itemProblem(r, others) {
  if (!(r.name.length >= 1 && Array.from(r.name).length <= 60)) return foodCheck('shopping_items', 'shopping_items_name_check');
  if (!AISLE_KEYS.includes(r.aisle)) return foodCheck('shopping_items', 'shopping_items_aisle_check');
  if (others.some((x) => x.name_key === r.name_key && !!x.private === !!r.private)) {
    return new Raise('23505', 'duplicate key value violates unique constraint "shopping_items_name_key"');
  }
  return null;
}

// The food tables' row-level security, grants, checks and triggers. Returns { status, body, rows } or null.
function foodTables(db, table, method, body, member, rows, req) {
  if (table === 'household' && db.shopping_items && method === 'PATCH') {
    if (member.role !== 'admin') return { status: 200, rows: [] };
    if ('helper_list' in (body || {}) && !['off', 'see', 'add'].includes(body.helper_list)) return tableErr(foodCheck('household', 'household_helper_list_check'));
    return null;
  }
  if (!FOOD_TABLES.includes(table) || !db[table]) return null;
  const denied = tableErr(new Raise('42501', `permission denied for table ${table}`));
  const email = member.email;
  try {
    if (method === 'GET') return { rows };
    if (method === 'DELETE') {
      const gone = new Set(rows.map((r) => r.id));
      db[table].splice(0, db[table].length, ...db[table].filter((r) => !gone.has(r.id)));
      return { status: 204, rows };
    }
    if (table === 'shopping_items') {
      if (method !== 'PATCH' || Object.keys(body || {}).some((k) => !ITEM_COLUMNS.includes(k))) return denied;
      const patch = Object.assign({}, body);
      if ('name' in patch) patch.name = cleanText(patch.name, 60) || '';
      if ('note' in patch) patch.note = cleanText(patch.note, 80) || null;
      const next = rows.map((r) => {
        const n = Object.assign({}, r, patch, { updated_at: foodStamp(db), updated_by: email });
        n.name_key = n.name.toLowerCase();
        return n;
      });
      for (const n of next) {
        const bad = itemProblem(n, db.shopping_items.filter((x) => x.id !== n.id));
        if (bad) throw bad;
      }
      rows.forEach((r, i) => Object.assign(r, next[i]));
      return { status: 200, rows };
    }
    // meals
    const people = db.people || [];
    if (method === 'POST') {
      const items = Array.isArray(body) ? body : [body];
      if (items.some((r) => Object.keys(r).some((k) => !MEAL_COLUMNS.includes(k)))) return denied;
      const upsert = /resolution=merge-duplicates/.test(req.prefer || '');
      const made = [];
      for (const r of items) {
        const t = tidyMeal(r);
        const old = upsert ? db.meals.find((x) => x.day === (t.day || null) && x.slot === (t.slot || 'dinner')) : null;
        const row = old
          ? Object.assign({}, old, t, { updated_at: foodStamp(db), updated_by: email })
          : mealRow(Object.assign({}, t, { created_at: foodStamp(db), created_by: email, updated_at: foodStamp(db), updated_by: email }));
        const bad = mealProblem(row, db.meals.filter((x) => x !== old).concat(made), people);
        if (bad) throw bad;
        if (old) Object.assign(old, row);
        made.push(old || row);
      }
      made.forEach((r) => { if (!db.meals.includes(r)) db.meals.push(r); });
      return { status: 201, rows: made };
    }
    if (method === 'PATCH') {
      if (Object.keys(body || {}).some((k) => !MEAL_COLUMNS.includes(k))) return denied;
      const next = rows.map((r) => Object.assign({}, r, tidyMeal(body), { updated_at: foodStamp(db), updated_by: email }));
      for (const n of next) {
        const bad = mealProblem(n, db.meals.filter((x) => x.id !== n.id), people);
        if (bad) throw bad;
      }
      rows.forEach((r, i) => Object.assign(r, next[i]));
      return { status: 200, rows };
    }
    return denied;
  } catch (e) {
    if (e instanceof Raise) return tableErr(e);
    throw e;
  }
}

// ---- The functions (§3.4)
const nowLocal = (db) => localOf(db.foodNow, foodTz(db));
const asOf = (db) => { const l = nowLocal(db); return `${l.date}T${l.time}`; };
const byNameKey = (a, b) => (a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byBought = (a, b) => (micros(b.bought_at) - micros(a.bought_at)) || byNameKey(a, b);
const boughtToday = (db, r) => r.bought_at != null && localOf(micros(r.bought_at) / 1000, foodTz(db)).date === nowLocal(db).date;
const within = (db, at, ms) => at != null && db.foodNow * 1000 - micros(at) < ms * 1000;
const UNDO_US = 15 * 60e3;
const activePerson = (db, id) => (db.people || []).find((p) => p.id === id && p.active !== false) || null;
const byTokenFood = (db, token) => (/^[0-9a-f]{32}$/.test(String(token || '')) && (db.people || []).find((p) => p.day_token === token && p.active !== false)) || null;
const shopWho = (db, email) => (db.people || []).find((p) => p.active !== false && p.email && p.email.toLowerCase() === String(email || '').toLowerCase()) || null;
const helperList = (db) => ((db.household && db.household[0]) || {}).helper_list || 'add';
const withOtherWord = (o, name, lang) => { const w = foodOther(name, lang); if (w) o.other = w; return o; };

// shopping_list(): what to buy, and today's buys (§3.4).
function shoppingList(db, email) {
  const lang = (shopWho(db, email) || {}).language === 'es' ? 'es' : 'en';
  const items = db.shopping_items;
  return {
    as_of: asOf(db),
    to_buy: items.filter((r) => r.bought_at == null).sort(byNameKey).map((r) => withOtherWord({
      id: r.id, name: r.name, note: r.note, aisle: r.aisle, private: r.private, added_by: r.added_by, seen: r.added_at }, r.name, lang)),
    bought: items.filter((r) => boughtToday(db, r)).sort(byBought).map((r) => ({
      id: r.id, name: r.name, note: r.note, aisle: r.aisle, private: r.private, bought_by: r.bought_by, seen: r.bought_at })),
  };
}

// private.list_for_helper(p_person): My day's list. Nothing locked, no people.
function listForHelper(db, me) {
  const lang = me.language === 'es' ? 'es' : 'en';
  const canAdd = helperList(db) === 'add';
  const open = db.shopping_items.filter((r) => !r.private);
  const mineNow = (r) => r.bought_by === me.id && within(db, r.bought_at, UNDO_US);
  const out = {
    language: lang,
    as_of: asOf(db),
    can_add: canAdd,
    items: open.filter((r) => r.bought_at == null).sort(byNameKey).map((r) => withOtherWord({ id: r.id, name: r.name, note: r.note, aisle: r.aisle, seen: r.added_at }, r.name, lang)),
    bought: open.filter((r) => r.bought_at != null && (boughtToday(db, r) || mineNow(r))).sort(byBought)
      .map((r) => ({ id: r.id, name: r.name, note: r.note, aisle: r.aisle, seen: r.bought_at, undo: mineNow(r) })),
  };
  if (canAdd) {
    // With the aisle, as the migration has it, so Comprar otra vez can group them.
    out.suggest = open.filter((r) => r.bought_at != null && within(db, r.bought_at, 30 * 864e5)).sort(byBought).slice(0, 60)
      .map((r) => withOtherWord({ name: r.name, aisle: r.aisle }, r.name, lang));
  }
  return out;
}

// private.count_my_day(p_person, p_what): one more change or tick for her today; past 30 / 100, refused.
function countMyDay(db, person, what) {
  const day = nowLocal(db).date;
  let row = db.my_day_use.find((r) => r.person_id === person && r.day === day);
  if (!row) db.my_day_use.push(row = { person_id: person, day, changes: 0, ticks: 0 });
  if (what === 'changes' && row.changes >= 30) throw new Raise('P0001', 'Too many changes from My day today.');
  if (what === 'ticks' && row.ticks >= 100) throw new Raise('P0001', 'Too many ticks from My day today.');
  row[what]++;
}

// private.list_add(p_name, p_private, p_by, p_my_day) (§4.1).
function listAdd(db, pName, pPrivate, by, myDay, stamp) {
  const s = cleanText(Array.from(String(pName)).slice(0, 200).join(''), 100);
  const m = FOOD_AMOUNT.exec(s);
  let name = s;
  let note = null;
  if (m) { name = m[3]; note = m[2] ? `${m[1]} ${m[2]}` : m[1]; }
  else if (s.includes(':')) { name = s.slice(0, s.indexOf(':')); note = s.slice(s.indexOf(':') + 1); }
  name = cleanText(name, 60);
  note = cleanText(note, 80) || null;
  if (!name) throw new Raise('22023', 'Type what to buy.');
  const priv = !myDay && !!pPrivate;
  const items = db.shopping_items;
  const find = (key, lock, open) => items.find((r) => r.name_key === key && !!r.private === lock && (!open || r.bought_at == null));
  // Where it may look: My day, only unlocked lines; signed in, this lock first, then the other.
  const look = (key, open) => (myDay ? find(key, false, open) : find(key, priv, open) || find(key, !priv, open));
  const key = name.toLowerCase();
  let line = look(key, false);
  if (!line) {
    const twin = foodOther(name, 'en') || foodOther(name, 'es');
    if (twin) line = look(twin.toLowerCase(), true);
  }
  const lockChange = !!line && priv && !line.private;
  // The note a line to buy will have: one already in its note (the whole note, or a run of its " · "
  // parts) isn't joined again; otherwise it joins after " · ", at most 80 characters.
  const hasNote = !note || (line && line.note != null && ` · ${line.note} · `.includes(` · ${note} · `));
  const newNote = !line || line.bought_at != null ? note : hasNote ? line.note : cleanText(line.note ? `${line.note} · ${note}` : note, 80);
  if (line && line.bought_at == null && !lockChange && newNote === line.note) return { result: 'already', item_id: line.id, name: line.name };
  if (myDay) countMyDay(db, by, 'changes');
  const toBuy = items.filter((r) => r.bought_at == null).length;
  const full = () => { if (toBuy >= (myDay ? 150 : 200)) throw new Raise('54000', 'The list is full.'); };
  let result;
  if (!line) {
    full();
    line = { id: uuid(), name, name_key: key, note, aisle: guessAisle(name), private: priv, added_at: stamp, added_by: by, bought_at: null, bought_by: null };
    items.push(line);
    result = 'added';
  } else if (line.bought_at == null) {
    line.note = newNote;
    result = 'already';
  } else {
    full();
    Object.assign(line, { bought_at: null, bought_by: null, note, added_at: stamp, added_by: by });
    result = 'back';
  }
  if (priv) line.private = true;
  return { result, item_id: line.id, name: line.name };
}

// private.list_buy(p_item, p_bought, p_seen, p_by, p_my_day) (§4.2). True when something changed.
function listBuy(db, item, bought, seen, by, myDay, stamp) {
  if (bought == null) throw new Raise('22023', 'Choose bought or not.');
  if (seen == null) throw new Raise('22023', 'Reload the list to see it as it is now.');
  const row = db.shopping_items.find((r) => r.id === item && !(myDay && r.private));
  if (!row) return false;
  if (bought) {
    if (row.bought_at != null || !sameInstant(row.added_at, seen)) return false;
    if (myDay) countMyDay(db, by, 'ticks');
    Object.assign(row, { bought_at: stamp, bought_by: by });
    return true;
  }
  if (row.bought_at == null || !sameInstant(row.bought_at, seen)) return false;
  const recent = within(db, row.bought_at, UNDO_US);
  if (myDay && !(row.bought_by === by && recent)) throw new Raise('42501', 'Only your own tick can be undone, for 15 minutes.');
  if (myDay) countMyDay(db, by, 'ticks');
  // Every un-tick gives the line a new seen (added_at); an Undo (within 15 minutes) keeps added_by.
  Object.assign(row, { bought_at: null, bought_by: null, added_at: stamp });
  if (!recent) row.added_by = by;
  return true;
}

// PostgREST finds a function by the names of the arguments sent: every one must be known and every
// one without a default sent, or it answers 404 PGRST202.
function foodCall(name, args, defaults, run) {
  return (db, b, email) => {
    const sent = Object.keys(b || {});
    if (!db.shopping_items || sent.some((k) => !args.includes(k) && !defaults.includes(k)) || args.some((k) => !sent.includes(k))) {
      return { __status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${name}(${sent.sort().join(', ')}) in the schema cache`, details: null, hint: null } };
    }
    const anon = name.endsWith('_by_token');
    const saved = JSON.stringify({ items: db.shopping_items, use: db.my_day_use });
    try {
      return run(db, b, email);
    } catch (e) {
      if (!(e instanceof Raise)) throw e;
      // The call is one transaction: whatever it changed is undone.
      const back = JSON.parse(saved);
      db.shopping_items.splice(0, db.shopping_items.length, ...back.items);
      db.my_day_use.splice(0, db.my_day_use.length, ...back.use);
      return raised(e, anon);
    }
  };
}
const MEMBERS_ONLY = 'Only the family can change the shopping list.';
const NOT_ON_MY_DAY = "The shopping list isn't on your My day.";
// A write stamps updated_at / updated_by as the triggers do: the email signed in, or "<name> (My day)".
function stampChanged(db, before, by) {
  const was = new Map(JSON.parse(before).map((r) => [r.id, JSON.stringify(r)]));
  const at = foodStamp(db);
  db.shopping_items.forEach((r) => { if (was.get(r.id) !== JSON.stringify(r)) Object.assign(r, { updated_at: at, updated_by: by }); });
}
const foodRpc = {
  shopping_list: foodCall('shopping_list', [], [], (db, b, email) => shoppingList(db, email)),
  add_to_list: foodCall('add_to_list', ['p_name'], ['p_private'], (db, b, email) => {
    if (!db.members.some((m) => m.email === email)) throw new Raise('42501', MEMBERS_ONLY);
    const before = JSON.stringify(db.shopping_items);
    const r = listAdd(db, b.p_name, b.p_private, (shopWho(db, email) || {}).id || null, false, foodStamp(db));
    stampChanged(db, before, email);
    return Object.assign(r, shoppingList(db, email));
  }),
  buy_item: foodCall('buy_item', ['p_item', 'p_bought', 'p_seen'], [], (db, b, email) => {
    if (!db.members.some((m) => m.email === email)) throw new Raise('42501', MEMBERS_ONLY);
    const before = JSON.stringify(db.shopping_items);
    const changed = listBuy(db, b.p_item, b.p_bought, b.p_seen, (shopWho(db, email) || {}).id || null, false, foodStamp(db));
    stampChanged(db, before, email);
    return Object.assign({ changed }, shoppingList(db, email));
  }),
  get_list_by_token: foodCall('get_list_by_token', ['p_token'], [], (db, b) => {
    const me = byTokenFood(db, b.p_token);
    if (!me || me.role !== 'helper' || helperList(db) === 'off') return null;
    return listForHelper(db, me);
  }),
  add_to_list_by_token: foodCall('add_to_list_by_token', ['p_token', 'p_name'], [], (db, b) => {
    const me = byTokenFood(db, b.p_token);
    if (!me) return null;
    if (me.role !== 'helper' || helperList(db) === 'off') throw new Raise('42501', NOT_ON_MY_DAY);
    if (helperList(db) === 'see') throw new Raise('42501', "You can't add to the list from My day.");
    if (b.p_name == null) throw new Raise('22023', 'Type what to buy.');
    if (Array.from(String(b.p_name)).length > 200) throw new Raise('22023', "That's too long to add.");
    const before = JSON.stringify(db.shopping_items);
    const r = listAdd(db, b.p_name, false, me.id, true, foodStamp(db));
    stampChanged(db, before, `${me.name} (My day)`);
    return Object.assign(r, listForHelper(db, me));
  }),
  buy_item_by_token: foodCall('buy_item_by_token', ['p_token', 'p_item', 'p_bought', 'p_seen'], [], (db, b) => {
    const me = byTokenFood(db, b.p_token);
    if (!me) return null;
    if (me.role !== 'helper' || helperList(db) === 'off') throw new Raise('42501', NOT_ON_MY_DAY);
    const before = JSON.stringify(db.shopping_items);
    const changed = listBuy(db, b.p_item, b.p_bought, b.p_seen, me.id, true, foodStamp(db));
    stampChanged(db, before, `${me.name} (My day)`);
    return Object.assign({ changed }, listForHelper(db, me));
  }),
};

// get_person_day's v1.2 keys (§3.4), added to an answer for `person` (a people row): each day's meals
// (left out on a day without one) and, for a helper with the list on and a list started, list.
function personDayFood(db, person, answer) {
  const lang = person.language === 'es' ? 'es' : 'en';
  const shortName = (p) => {
    const first = String(p.name).split(' ')[0];
    return (db.people || []).some((o) => o.id !== p.id && o.active !== false && String(o.name).split(' ')[0] === first) ? p.name : first;
  };
  (answer.days || []).forEach((d) => {
    const meals = (db.meals || []).filter((m) => m.day === d.day).sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot)).map((m) => {
      const cook = m.cook_id ? activePerson(db, m.cook_id) : null;
      const mine = !!cook && cook.id === person.id;
      const kindWord = m.kind === 'cook' ? m.title : foodWord(m.kind, lang);
      let cookWord = null;
      if (cook && m.kind === 'cook') cookWord = mine ? foodWord('you_cook', lang) : foodWord('cooks', lang, shortName(cook));
      else if (cook && ['leftovers', 'takeout'].includes(m.kind)) cookWord = mine ? foodWord('you_on_dinner', lang) : foodWord('on_dinner', lang, shortName(cook));
      const row = { slot: m.slot, label: foodWord(m.slot, lang), title: m.private && !mine ? foodWord('private_item', lang) : kindWord,
        cook: cook ? shortName(cook) : null, cook_word: cookWord, mine };
      if (mine && m.note) row.note = m.note;
      if (mine && m.link) row.link = m.link;
      return row;
    });
    if (meals.length) d.meals = meals;
  });
  if (person.role === 'helper' && helperList(db) !== 'off' && (db.shopping_items || []).length) {
    answer.list = { to_buy: db.shopping_items.filter((r) => !r.private && r.bought_at == null).length };
  }
  return answer;
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
    // Schema 3's calendar tables and schema 4's food tables: their own row-level security and grants
    // (calendarTables and foodTables above).
    const cal = calendarTables(db, table, method, body, member, db[table].filter(match))
      || foodTables(db, table, method, body, member, db[table].filter(match), { prefer: req.headers()['prefer'] || '' });
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

module.exports = { makeDb, install, signIn, expectedConsoleError, SUPA, withCalendars, calendarRow, linkRow, googleEventRow, calendarRpc, md5uuid,
  withFood, mealRow, shopItem, foodRpc, personDayFood, foodStamp };
