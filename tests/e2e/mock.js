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
// foodRpc has the functions, with the migration's shapes and rules (§3.4, §4.1, §4.2, and §8's keys:
// a change sent again with its p_key gets the first answer, db.list_done): shopping_list,
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
  return Object.assign(db, { meals: [], shopping_items: [], my_day_use: [], list_done: [] });
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

// shopping_list(): what to buy, and today's buys and the reader's own ticks of the last 15 minutes (§3.4;
// for a member with no person, the ticks with no bought_by, as the database records theirs).
function shoppingList(db, email) {
  const who = shopWho(db, email) || {};
  const lang = who.language === 'es' ? 'es' : 'en';
  const member = (db.members || []).some((m) => m.email === email);
  const mineNow = (r) => member && (r.bought_by == null ? null : r.bought_by) === (who.id == null ? null : who.id) && within(db, r.bought_at, UNDO_US);
  const items = db.shopping_items;
  return {
    as_of: asOf(db),
    to_buy: items.filter((r) => r.bought_at == null).sort(byNameKey).map((r) => withOtherWord({
      id: r.id, name: r.name, note: r.note, aisle: r.aisle, private: r.private, added_by: r.added_by, seen: r.added_at }, r.name, lang)),
    bought: items.filter((r) => r.bought_at != null && (boughtToday(db, r) || mineNow(r))).sort(byBought).map((r) => ({
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

// list_add_once's answer: list_add's, with seen, the line's added_at once the add is done.
function addAnswer(db, name, priv, by, myDay) {
  const r = listAdd(db, name, priv, by, myDay, foodStamp(db));
  const row = db.shopping_items.find((x) => x.id === r.item_id);
  return Object.assign(r, { seen: row ? row.added_at : null });
}
// list_buy_once's answer: {changed, seen}, seen the one it gave the line when it changed it (a tick's
// bought_at, an un-tick's new added_at), else null.
function buyAnswer(db, item, bought, seen, by, myDay) {
  const changed = listBuy(db, item, bought, seen, by, myDay, foodStamp(db));
  const row = changed ? db.shopping_items.find((x) => x.id === item) : null;
  return { changed, seen: row ? (bought ? row.bought_at : row.added_at) : null };
}

// private.list_claim with list_add_once and list_buy_once (§8): a change sent with a key (p_key) is done
// once; a second try gets the first answer (seen and all) and changes nothing. A key is its sender's (who,
// and from My day or signed in) and that change's (ask: an add's name and lock, a tick's line and
// direction, whatever its seen); any other counts as no key.
function listOnce(db, key, by, myDay, ask, run) {
  if (key == null) return run();
  db.list_done = db.list_done || [];
  const d = db.list_done.find((x) => x.key === key);
  if (d) return d.by_id === by && d.my_day === myDay && d.ask === ask ? JSON.parse(JSON.stringify(d.answer)) : run();
  const answer = run();
  db.list_done.push({ key, by_id: by, my_day: myDay, ask, answer: JSON.parse(JSON.stringify(answer)), at: db.foodNow });
  return answer;
}
const addAsk = (name, priv, myDay) => `add ${!!priv && !myDay} ${String(name)}`;
const buyAsk = (item, bought) => `buy ${item} ${bought}`;

// PostgREST finds a function by the names of the arguments sent: every one must be known and every
// one without a default sent, or it answers 404 PGRST202.
function foodCall(name, args, defaults, run) {
  return (db, b, email) => {
    const sent = Object.keys(b || {});
    if (!db.shopping_items || sent.some((k) => !args.includes(k) && !defaults.includes(k)) || args.some((k) => !sent.includes(k))) {
      return { __status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${name}(${sent.sort().join(', ')}) in the schema cache`, details: null, hint: null } };
    }
    const anon = name.endsWith('_by_token');
    const saved = JSON.stringify({ items: db.shopping_items, use: db.my_day_use, done: db.list_done || [] });
    try {
      return run(db, b, email);
    } catch (e) {
      if (!(e instanceof Raise)) throw e;
      // The call is one transaction: whatever it changed is undone.
      const back = JSON.parse(saved);
      db.shopping_items.splice(0, db.shopping_items.length, ...back.items);
      db.my_day_use.splice(0, db.my_day_use.length, ...back.use);
      db.list_done = back.done;
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
  add_to_list: foodCall('add_to_list', ['p_name'], ['p_private', 'p_key'], (db, b, email) => {
    if (!db.members.some((m) => m.email === email)) throw new Raise('42501', MEMBERS_ONLY);
    const before = JSON.stringify(db.shopping_items);
    const by = (shopWho(db, email) || {}).id || null;
    const r = listOnce(db, b.p_key, by, false, addAsk(b.p_name, b.p_private, false), () => addAnswer(db, b.p_name, b.p_private, by, false));
    stampChanged(db, before, email);
    return Object.assign(r, shoppingList(db, email));
  }),
  buy_item: foodCall('buy_item', ['p_item', 'p_bought', 'p_seen'], ['p_key'], (db, b, email) => {
    if (!db.members.some((m) => m.email === email)) throw new Raise('42501', MEMBERS_ONLY);
    const before = JSON.stringify(db.shopping_items);
    const by = (shopWho(db, email) || {}).id || null;
    const r = listOnce(db, b.p_key, by, false, buyAsk(b.p_item, b.p_bought), () => buyAnswer(db, b.p_item, b.p_bought, b.p_seen, by, false));
    stampChanged(db, before, email);
    return Object.assign(r, shoppingList(db, email));
  }),
  get_list_by_token: foodCall('get_list_by_token', ['p_token'], [], (db, b) => {
    const me = byTokenFood(db, b.p_token);
    if (!me || me.role !== 'helper' || helperList(db) === 'off') return null;
    return listForHelper(db, me);
  }),
  add_to_list_by_token: foodCall('add_to_list_by_token', ['p_token', 'p_name'], ['p_key'], (db, b) => {
    const me = byTokenFood(db, b.p_token);
    if (!me) return null;
    if (me.role !== 'helper' || helperList(db) === 'off') throw new Raise('42501', NOT_ON_MY_DAY);
    if (helperList(db) === 'see') throw new Raise('42501', "You can't add to the list from My day.");
    if (b.p_name == null) throw new Raise('22023', 'Type what to buy.');
    if (Array.from(String(b.p_name)).length > 200) throw new Raise('22023', "That's too long to add.");
    const before = JSON.stringify(db.shopping_items);
    const r = listOnce(db, b.p_key, me.id, true, addAsk(b.p_name, false, true), () => addAnswer(db, b.p_name, false, me.id, true));
    stampChanged(db, before, `${me.name} (My day)`);
    return Object.assign(r, listForHelper(db, me));
  }),
  buy_item_by_token: foodCall('buy_item_by_token', ['p_token', 'p_item', 'p_bought', 'p_seen'], ['p_key'], (db, b) => {
    const me = byTokenFood(db, b.p_token);
    if (!me) return null;
    if (me.role !== 'helper' || helperList(db) === 'off') throw new Raise('42501', NOT_ON_MY_DAY);
    const before = JSON.stringify(db.shopping_items);
    const r = listOnce(db, b.p_key, me.id, true, buyAsk(b.p_item, b.p_bought), () => buyAnswer(db, b.p_item, b.p_bought, b.p_seen, me.id, true));
    stampChanged(db, before, `${me.name} (My day)`);
    return Object.assign(r, listForHelper(db, me));
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

// ---- Schema 5 (supabase/migrations/0005_homework.sql, docs/v1.3-homework.md §3): homework, the
// signed-in side. withHomework(db) adds the eleven tables, as a database with 0005 has them (makeDb()
// leaves them out, so on schema 4 and below a stray read answers 404 and a stray call of a homework
// function 404 PGRST202, as live), the household's three AI columns, db.events and db.event_changes
// when missing, and 0004's tables when the database doesn't have them yet (withFood). Use it only for
// a schema-5 database.
//   homework_kids   members read; admins change the settings columns only (the column grants), with
//                   the table's checks; rows come from save_homework_kid, and go with erase_homework
//   homework_times  members read; admins insert (event_id, kid_id) and delete
//   tutor_links     admins read (members get no rows); written by save_tutor_link and new_tutor_token
//   assignments     members read; admins insert, change and delete the page's columns, through the
//                   tidy trigger (title, class and stretch on one line, the teacher's text with its
//                   lines, '' as null, done_at and dropped_at from status) and the stamp (updated_at, updated_by)
//   rewards         members read; admins insert, change and delete (title, cost, active, sort_order)
//   homework_steps, focus_sessions, reward_asks, points_ledger: members read, nobody signed in writes;
//   ai_runs: admins read; homework_use: no privilege at all
// homeworkRpc has the signed-in functions (§3.5) with the migration's shapes and rules:
// homework_week, save_homework_kid, add_homework_time, save_homework_plan, homework_step,
// decide_reward, give_points, void_points, save_tutor_link, new_tutor_token, erase_homework. A call
// that raises changes nothing (one transaction). Busy time is the kid's other timed events (one-off or
// weekly, with event_changes), as private.free_minutes reads them from agenda; placement uses
// assets/plan.js's own rules (HomePlan.place, the same as private.place_steps), loaded here in a vm,
// so the fakes and the page agree. Times: db.foodNow (withFood) is "now"; move it to pass 15 minutes.
// My day's and the tutor link's functions are the day pages' own (day.test.js routes them).
const HW_TABLES = ['homework_kids', 'homework_times', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions', 'rewards',
  'reward_asks', 'points_ledger', 'homework_use', 'ai_runs'];
const HW_KID_UPDATE = ['active', 'points_on', 'focus_minutes', 'pts_focus', 'pts_on_time', 'pts_milestone', 'pts_day_cap', 'pts_milestone_week'];
const HW_ASSIGNMENT_INSERT = ['kid_id', 'kind', 'title', 'subject', 'due_date', 'details', 'stretch', 'status'];
const HW_REWARD_INSERT = ['kid_id', 'title', 'cost', 'active', 'sort_order'];
let homePlanCache = null;
// assets/plan.js (window.HomePlan) in a vm, for its placement and dates.
function homePlan() {
  if (!homePlanCache) {
    const ctx = { window: {}, crypto: crypto.webcrypto };
    require('vm').runInNewContext(fs.readFileSync(path.join(REPO, 'assets/plan.js'), 'utf8'), ctx);
    homePlanCache = ctx.window.HomePlan;
  }
  return homePlanCache;
}

function withHomework(db, opts) {
  if (!db.shopping_items) withFood(db, opts);
  const hh = (db.household && db.household[0]) || null;
  if (hh) Object.assign(hh, { homework_ai: false, homework_ai_month: 150, homework_never_send: [] });
  db.events = db.events || [];
  db.event_changes = db.event_changes || [];
  return Object.assign(db, { homework_kids: [], homework_times: [], tutor_links: [], assignments: [], homework_steps: [], focus_sessions: [],
    rewards: [], reward_asks: [], points_ledger: [], homework_use: [], ai_runs: [] });
}
// Rows with the tables' defaults.
const hwKidRow = (o) => Object.assign({
  kid_id: null, active: true, points_on: true, focus_minutes: 20, cue: null, if_stuck: null, pts_focus: 1, pts_on_time: 5, pts_milestone: 20,
  pts_day_cap: 20, pts_milestone_week: 80, created_at: now(), created_by: null, updated_at: now(), updated_by: null,
}, o);
const tutorLinkRow = (o) => Object.assign({
  id: uuid(), kid_id: null, token: crypto.randomBytes(16).toString('hex'), label: 'Pat Lee, tutor', language: 'en', active: true, expires_on: null,
  can_ai: true, last_used_at: null, created_at: now(), created_by: null, updated_at: now(), updated_by: null,
}, o);
const assignmentRow = (o) => Object.assign({
  id: uuid(), kid_id: null, kind: 'assignment', added_by: 'family', title: '', subject: null, due_date: null, details: null, stretch: null,
  status: 'open', done_at: null, dropped_at: null, given_at: null, given_by: null, plan_rev: 0, ai_state: null, ai_stop: null, ai_draft: null, ai_prev: null,
  ai_at: null, created_at: now(), created_by: null, updated_at: now(), updated_by: null,
}, o);
const stepRow = (o) => Object.assign({
  id: uuid(), assignment_id: null, pos: 1, kind: 'step', title: '', done_looks_like: null, minutes: 20, day: null, moved_from: null,
  source: 'typed', done_at: null, done_by: null, checked_at: null, checked_by: null, not_yet_at: null, coach_note: null, coach_note_by: null,
  coach_note_at: null, question: null, question_at: null, answer: null, answer_by: null, answer_at: null, qa_log: [], updated_at: now(),
  updated_by: null,
}, o);
const sessionRow = (o) => {
  const r = Object.assign({
    id: uuid(), kid_id: null, assignment_id: null, step_id: null, minutes: 20, with_whom: 'alone', started_at: null, ends_at: null, ended_at: null,
    result: null, seen_minutes: null, on_time: false, points: 0, note: null,
  }, o);
  if (!r.ends_at && r.started_at) r.ends_at = fromMicros(micros(r.started_at) + r.minutes * 60e6);
  return r;
};
const rewardRow = (o) => Object.assign({
  id: uuid(), kid_id: null, title: '', cost: null, active: true, suggested: false, sort_order: 0, created_at: now(), created_by: null,
  updated_at: now(), updated_by: null,
}, o);
const askRow = (o) => Object.assign({
  id: uuid(), kid_id: null, reward_id: null, title: '', cost: 0, status: 'waiting', asked_at: now(), decided_at: null, decided_by: null, note: null,
}, o);
const ledgerRow = (o) => Object.assign({
  id: uuid(), kid_id: null, at: now(), day: null, kind: 'focus', delta: 1, session_id: null, step_id: null, ask_id: null, void_of: null,
  note: null, who: 'Jordan Example (My day)',
}, o);

const hwToday = (db) => nowLocal(db).date;
const hwAsOf = (db) => asOf(db);
const hwAdmin = (db, email) => (db.members.find((m) => m.email === email) || {}).role === 'admin';
const PARENT_ONLY = 'Only a parent can change homework.';
const hwMinutes = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const hwClock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// An event's occurrence on a day, as agenda gives it: { start, end } ('HH:MM', end null without one),
// or null (not that day, cancelled, a day off it skips, or all day). One-day changes win.
function hwOccurrence(db, ev, day) {
  const HP = homePlan();
  if (!ev.start_time) return null;
  let on = false;
  if (ev.repeat === 'weekly') {
    const weeks = Math.floor(HP.daysBetween(HP.addDays(ev.start_date, 1 - HP.isoWeekday(ev.start_date)), day) / 7);
    on = day >= ev.start_date && (!ev.repeat_until || day <= ev.repeat_until) && (ev.repeat_weekdays || []).map(Number).includes(HP.isoWeekday(day))
      && weeks % (Number(ev.repeat_every) || 1) === 0;
    const off = ((db.household && db.household[0]) || {}).days_off || [];
    if (on && ev.skip_days_off && off.includes(day)) on = false;
  } else {
    on = ev.start_date === day;
  }
  if (!on) return null;
  const c = ev.repeat === 'weekly' ? (db.event_changes || []).find((x) => x.event_id === ev.id && x.on_date === day) : null;
  if (c && c.cancelled) return null;
  const start = String((c && c.start_time) || ev.start_time).slice(0, 5);
  const end = (c && c.end_time) || ev.end_time;
  return { start, end: end ? String(end).slice(0, 5) : null };
}

// Minutes of not-done steps on a day in the kid's open assignments (all but `except`).
const hwPlanned = (db, kid, day, except) => db.homework_steps.filter((s) => !s.done_at && s.day === day && db.assignments.some((a) =>
  a.id === s.assignment_id && a.kid_id === kid && a.status === 'open' && a.id !== except)).reduce((n, s) => n + s.minutes, 0);

// private.free_minutes(p_kid, p_from, p_to, p_except): the days with homework time, at most 56 from
// p_from: { day, starts, ends, window_minutes, free, planned, busy: [{ starts, ends, title }], first_free }.
function hwFree(db, kid, from, to, except) {
  const HP = homePlan();
  const last = HP.addDays(from, 55) < to ? HP.addDays(from, 55) : to;
  const times = new Set(db.homework_times.filter((h) => h.kid_id === kid).map((h) => h.event_id));
  const out = [];
  for (let d = from; d && d <= last; d = HP.addDays(d, 1)) {
    const wins = db.events.filter((e) => times.has(e.id)).map((e) => hwOccurrence(db, e, d)).filter((o) => o && o.end);
    if (!wins.length) continue;
    const inWin = new Set();
    wins.forEach((w) => { for (let m = hwMinutes(w.start); m < hwMinutes(w.end); m++) inWin.add(m); });
    const s = Math.min(...wins.map((w) => hwMinutes(w.start)));
    const e = Math.max(...wins.map((w) => hwMinutes(w.end)));
    const blocks = db.events.filter((ev) => !times.has(ev.id) && (ev.responsible_id === kid || (ev.participant_ids || []).includes(kid)))
      .map((ev) => {
        const o = hwOccurrence(db, ev, d);
        if (!o) return null;
        const bs = hwMinutes(o.start);
        const be = o.end ? hwMinutes(o.end) : bs + 60;
        return { title: ev.title, s: bs, e: be, starts: o.start, ends: hwClock(be) };
      })
      .filter((b) => b && [...inWin].some((m) => m >= b.s && m < b.e))
      .sort((x, y) => x.s - y.s || (x.title < y.title ? -1 : 1));
    const taken = new Set();
    blocks.forEach((b) => { const end = b.e + (b.e > s && b.e < e ? 15 : 0); for (let m = b.s; m < end; m++) taken.add(m); });
    const free = [...inWin].filter((m) => !taken.has(m)).sort((x, y) => x - y);
    out.push({ day: d, starts: hwClock(s), ends: hwClock(e), window_minutes: Math.min(inWin.size, 240), free: Math.min(free.length, 240),
      planned: hwPlanned(db, kid, d, except), busy: blocks.map((b) => ({ starts: b.starts, ends: b.ends, title: b.title })),
      first_free: free.length ? hwClock(free[0]) : null });
  }
  return out;
}

// The days placement uses (homework_week's rows from today, 56 days), with `except`'s own steps left out.
function hwDays(db, kid, except) {
  const today = hwToday(db);
  return hwFree(db, kid, today, homePlan().addDays(today, 55), except).map((f) => ({ day: f.day, window: { starts: f.starts, ends: f.ends },
    free: f.free, planned: f.planned }));
}

const hwBalance = (db, kid) => ({
  balance: db.points_ledger.filter((l) => l.kid_id === kid).reduce((n, l) => n + l.delta, 0),
  held: db.reward_asks.filter((x) => x.kid_id === kid && x.status === 'waiting').reduce((n, x) => n + x.cost, 0),
});

// private.award: one ledger row, with the daily cap (focus and on-time, on p_day) and the weekly
// milestone cap (p_day's Mon–Sun); nothing earned or given while points are off; each block, day's
// on-time start, milestone and void paid once. Answers the points written.
function hwAward(db, kid, kind, delta, day, o) {
  const HP = homePlan();
  const k = db.homework_kids.find((x) => x.kid_id === kid);
  const x = o || {};
  if (!k || (['focus', 'on_time', 'milestone', 'given'].includes(kind) && !k.points_on)) return 0;
  let d = delta;
  const mine = db.points_ledger.filter((l) => l.kid_id === kid);
  if (kind === 'focus' || kind === 'on_time') {
    const used = mine.filter((l) => l.day === day && (l.kind === 'focus' || l.kind === 'on_time')).reduce((n, l) => n + l.delta, 0);
    d = Math.min(d, Math.max(k.pts_day_cap - used, 0));
  }
  if (kind === 'milestone') {
    const mon = HP.addDays(day, 1 - HP.isoWeekday(day));
    const used = mine.filter((l) => l.kind === 'milestone' && l.day >= mon && l.day <= HP.addDays(mon, 6)).reduce((n, l) => n + l.delta, 0);
    d = Math.min(d, Math.max(k.pts_milestone_week - used, 0));
    if (mine.some((l) => l.kind === 'milestone' && l.step_id === x.step)) return 0;
  }
  if (kind === 'void' && mine.some((l) => l.kind === 'void' && l.void_of === x.voidOf)) return 0;
  if (!d) return 0;
  db.points_ledger.push(ledgerRow({ kid_id: kid, at: foodStamp(db), day, kind, delta: d, session_id: x.session || null, step_id: x.step || null,
    ask_id: x.ask || null, void_of: x.voidOf || null, note: x.note || null, who: x.who }));
  return d;
}

// private.plan_save, as the family saves (§4.4): the whole plan in order; steps with an id changed
// (a done one kept as it is), without one added, the plan's others deleted (never a done one); steps
// with a day keep it, the rest placed (HomePlan.place over hwDays); plan_rev + 1; given once.
function hwPlanSave(db, assignment, steps, give, rev, who) {
  const HP = homePlan();
  if (steps != null && JSON.stringify(steps).length > 20000) throw new Raise('22023', 'That plan is too long.');
  const a = db.assignments.find((x) => x.id === assignment);
  if (!a) throw new Raise('22023', 'That assignment is gone.');
  if (rev == null || rev !== a.plan_rev) throw new Raise('P0001', 'This plan was changed since you opened it.');
  if (a.status !== 'open') throw new Raise('P0001', 'This assignment is done or dropped. Open it again first.');
  if (!Array.isArray(steps)) throw new Raise('22023', 'Send the plan\'s steps.');
  const k = db.homework_kids.find((x) => x.kid_id === a.kid_id);
  const today = hwToday(db);
  const due = a.due_date > today ? a.due_date : today;
  if (steps.length > 20) throw new Raise('22023', 'At most 20 steps.');
  const old = db.homework_steps.filter((s) => s.assignment_id === a.id).sort((x, y) => x.pos - y.pos);
  const seen = new Set();
  const list = steps.map((e) => {
    if (!HP.KINDS.includes(e.kind)) throw new Raise('22023', 'A step is a start, a step, a milestone, a check or the turn-in.');
    const title = cleanText(e.title, 200);
    if (!title || Array.from(title).length < 3 || Array.from(title).length > 80) throw new Raise('22023', 'A step\'s title is 3 to 80 characters.');
    const dll = cleanText(e.done_looks_like, 400) || null;
    if (dll && Array.from(dll).length > 160) throw new Raise('22023', '"Done looks like" is at most 160 characters.');
    if (!Number.isInteger(e.minutes) || e.minutes < 5 || e.minutes > 60) throw new Raise('22023', 'A step is 5 to 60 minutes.');
    if (e.day && e.day > due) throw new Raise('22023', 'A step can\'t be after the due date.');
    if (e.id != null) {
      if (seen.has(e.id)) throw new Raise('22023', 'A step is in the plan twice.');
      seen.add(e.id);
    }
    return Object.assign({}, e, { title, done_looks_like: dll });
  });
  if (list.filter((e) => e.kind === 'milestone').length > 4) throw new Raise('22023', 'At most 4 milestones.');
  const ti = list.filter((e) => e.kind === 'turn_in').length;
  if (ti > 1) throw new Raise('22023', 'A plan has one turn-in.');
  if (ti === 1 && list[list.length - 1].kind !== 'turn_in') throw new Raise('22023', 'The turn-in is the last step.');
  const out = [];
  list.forEach((e) => {
    const o = e.id ? old.find((s) => s.id === e.id) : null;
    if (e.id && !o) throw new Raise('22023', 'That step isn\'t in this plan.');
    if (o && o.done_at) { out.push({ row: o, done: true }); return; }
    let source = e.source || 'typed';
    let minutes = e.minutes;
    let moved = !!e.day;
    if (o) {
      moved = !!e.day && e.day !== o.day;
      const changed = e.kind !== o.kind || e.title !== o.title || (e.done_looks_like || null) !== (o.done_looks_like || null) || e.minutes !== o.minutes || moved;
      source = changed ? 'typed' : o.source;
    } else if (source === 'template') {
      minutes = e.kind === 'turn_in' ? 5 : Math.min(e.minutes, Math.max(k.focus_minutes, 5));
    }
    if (moved && e.day < today) throw new Raise('22023', 'A step can\'t go in the past.');
    if (moved && e.kind !== 'turn_in' && a.kind === 'assignment' && a.due_date > today && e.day >= a.due_date) {
      throw new Raise('22023', 'Only the turn-in goes on the due date.');
    }
    out.push({ row: o, done: false, kind: e.kind, title: e.title, done_looks_like: e.done_looks_like, minutes, day: e.day || null, source });
  });
  // The plan's done steps missing from the list stay.
  old.filter((s) => s.done_at && !out.some((x) => x.row === s)).forEach((s) => out.push({ row: s, done: true }));
  if (out.length > 20) throw new Raise('22023', 'At most 20 steps.');
  // Placement: steps with a day keep it (their minutes take room); the others are placed.
  const days = hwDays(db, a.kid_id, a.id);
  out.filter((x) => !x.done && x.day).forEach((x) => { const d = days.find((r) => r.day === x.day); if (d) d.planned += x.minutes; });
  const open = out.filter((x) => !x.done && !x.day);
  let placed = { steps: [], fits: true, over: 0, horizon: null, no_time: !days.length };
  if (open.length) {
    placed = HP.place(open.map((x) => ({ kind: x.kind, minutes: x.minutes, day: null })), { today, due: a.due_date, kind: a.kind, asOf: hwAsOf(db), days });
    if (placed.no_time) throw new Raise('22023', 'Set a homework time first.');
    open.forEach((x, i) => { x.day = placed.steps[i].day; });
  }
  // Write: what is no longer in the plan goes (never a done step), then each step at its place.
  const keep = new Set(out.filter((x) => x.row).map((x) => x.row.id));
  const at = foodStamp(db);
  db.homework_steps = db.homework_steps.filter((s) => s.assignment_id !== a.id || s.done_at || keep.has(s.id));
  out.forEach((x, i) => {
    if (x.done) { x.row.pos = i + 1; return; }
    const fields = { pos: i + 1, kind: x.kind, title: x.title, done_looks_like: x.done_looks_like, minutes: x.minutes, day: x.day, source: x.source,
      updated_at: at, updated_by: who };
    if (x.row) Object.assign(x.row, fields);
    else db.homework_steps.push(stepRow(Object.assign({ assignment_id: a.id }, fields)));
  });
  a.plan_rev += 1;
  if (give && !a.given_at) Object.assign(a, { given_at: at, given_by: who });
  Object.assign(a, { updated_at: foodStamp(db), updated_by: who });
  const mine = db.homework_steps.filter((s) => s.assignment_id === a.id).sort((x, y) => x.pos - y.pos);
  const left = HP.workLeft(mine.map((s) => ({ minutes: s.minutes, done: !!s.done_at })));
  const time = HP.timeLeft(days.map((d) => Object.assign({}, d, { planned: hwPlanned(db, a.kid_id, d.day, a.id) })),
    { today, due: a.due_date, kind: a.kind, asOf: hwAsOf(db) });
  const over = Math.max(placed.over || 0, left - time.minutes, 0);
  return { plan: {
    assignment_id: a.id, plan_rev: a.plan_rev,
    steps: mine.map((s) => ({ id: s.id, pos: s.pos, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like, minutes: s.minutes, day: s.day,
      source: s.source, done: !!s.done_at })),
    fits: !time.no_time && over === 0, over, horizon: placed.horizon || time.horizon || null, minutes_left: left, time_left: time.minutes,
    no_time: !!time.no_time,
    talk: mine.filter((m) => m.kind === 'milestone' && !m.done_at && (m.day < today
      || mine.some((y) => !y.done_at && y.kind !== 'milestone' && y.pos < m.pos && y.day > m.day))).map((m) => ({ title: m.title, day: m.day })),
  } };
}

// private.step_act, for the family (§4.5): check, not_yet, uncheck, answer, clear, done, undo.
function hwStepAct(db, stepId, action, text, who) {
  const s = db.homework_steps.find((x) => x.id === stepId);
  const a = s && db.assignments.find((x) => x.id === s.assignment_id);
  if (!a) throw new Raise('42501', 'That step isn\'t on your plan.');
  const k = db.homework_kids.find((x) => x.kid_id === a.kid_id);
  const at = foodStamp(db);
  const add = [];
  const noteEntry = () => ({ note: s.coach_note, at: s.coach_note_at, by: s.coach_note_by });
  let changed = false;
  let out = {};
  if (action === 'done') {
    if (!s.done_at) {
      if (s.coach_note) add.push(noteEntry());
      Object.assign(s, { done_at: at, done_by: who, not_yet_at: null, coach_note: null, coach_note_by: null, coach_note_at: null });
      changed = true;
    }
  } else if (action === 'undo') {
    if (s.done_at) {
      if (s.checked_at) throw new Raise('42501', 'That milestone is checked: take the check back first.');
      Object.assign(s, { done_at: null, done_by: null });
      changed = true;
    }
  } else if (action === 'check') {
    if (s.kind !== 'milestone') throw new Raise('22023', 'Only a milestone is checked.');
    out = { paid: 0, used_up: false };
    if (!s.checked_at) {
      const t = cleanText(text, 160) || null;
      if (s.coach_note) add.push(noteEntry());
      Object.assign(s, { done_at: s.done_at || at, done_by: s.done_by || who, checked_at: at, checked_by: who, not_yet_at: null,
        coach_note: t, coach_note_by: t ? 'family' : null, coach_note_at: t ? at : null });
      const paid = hwAward(db, a.kid_id, 'milestone', k.pts_milestone, hwToday(db), { step: s.id, note: s.title, who });
      out = { paid, used_up: k.points_on && k.pts_milestone > 0 && paid < k.pts_milestone };
      changed = true;
    }
  } else if (action === 'not_yet') {
    if (s.kind !== 'milestone') throw new Raise('22023', 'Only a milestone is checked.');
    const t = cleanText(text, 160);
    if (!t) throw new Raise('22023', 'Say what\'s missing.');
    if (s.checked_at) throw new Raise('42501', 'That milestone is checked: take the check back first.');
    if (s.done_at) {
      if (s.coach_note) add.push(noteEntry());
      Object.assign(s, { done_at: null, done_by: null, not_yet_at: at, coach_note: t, coach_note_by: 'family', coach_note_at: at });
      changed = true;
    } else if (!(s.not_yet_at && s.coach_note === t)) {
      throw new Raise('22023', 'Not yet is for a ticked milestone.');
    }
  } else if (action === 'uncheck') {
    if (s.checked_at) {
      if (s.checked_by !== who || !within(db, s.checked_at, 15 * 60e3)) throw new Raise('42501', 'Only the one who checked it can take it back, for 15 minutes.');
      const paid = db.points_ledger.filter((l) => l.step_id === s.id && l.kind === 'milestone').map((l) => l.id);
      const net = db.points_ledger.filter((l) => paid.includes(l.id) || (l.kind === 'void' && paid.includes(l.void_of))).reduce((n, l) => n + l.delta, 0);
      const kid = db.assignments.find((x) => x.id === s.assignment_id).kid_id;
      if (hwBalance(db, kid).balance - net < 0) throw new Raise('P0001', 'Those points are already spent.');   // never below zero, as void_points
      db.points_ledger = db.points_ledger.filter((l) => !paid.includes(l.id) && !(l.kind === 'void' && paid.includes(l.void_of)));
      Object.assign(s, { checked_at: null, checked_by: null });
      changed = true;
    }
  } else if (action === 'answer') {
    const t = cleanText(text, 200);
    if (!t) throw new Raise('22023', 'Type the answer.');
    if (!s.question) throw new Raise('22023', 'There\'s no question to answer.');
    if (s.answer !== t) {
      if (s.answer) {
        if (s.answer_by !== who || !within(db, s.answer_at, 15 * 60e3)) throw new Raise('42501', 'Only your own answer can be changed, for 15 minutes.');
        add.push({ question: s.question, asked_at: s.question_at, answer: s.answer, answered_at: s.answer_at, answered_by: s.answer_by, by: 'family', replaced_at: at });
      }
      Object.assign(s, { answer: t, answer_by: who, answer_at: s.answer_at || at });
      changed = true;
    }
  } else if (action === 'clear') {
    const which = text || (s.answer ? 'answer' : 'note');
    if (!['answer', 'note'].includes(which)) throw new Raise('22023', 'Clear an answer or a note.');
    if (which === 'answer' && s.answer) {
      add.push({ question: s.question, asked_at: s.question_at, answer: s.answer, answered_at: s.answer_at, answered_by: s.answer_by,
        by: / \(tutor link\)$/.test(s.answer_by || '') ? 'tutor' : 'family', cleared_at: at, cleared_by: who });
      Object.assign(s, { answer: null, answer_by: null, answer_at: null });
      changed = true;
    } else if (which === 'note' && s.coach_note) {
      add.push(Object.assign(noteEntry(), { cleared_at: at, cleared_by: who }));
      Object.assign(s, { coach_note: null, coach_note_by: null, coach_note_at: null });
      changed = true;
    }
  } else {
    throw new Raise('22023', 'That isn\'t something you can do to a step.');
  }
  if (changed) {
    s.qa_log = (s.qa_log || []).concat(add).slice(-10);
    Object.assign(s, { updated_at: at, updated_by: who });
    a.plan_rev += 1;
    const rest = db.homework_steps.filter((x) => x.assignment_id === a.id && !x.done_at);
    if ((action === 'done' || action === 'check') && a.status === 'open' && (s.kind === 'turn_in' || !rest.length)) Object.assign(a, { status: 'done', done_at: at });
    else if ((action === 'undo' || action === 'not_yet') && a.status === 'done') Object.assign(a, { status: 'open', done_at: null });
    Object.assign(a, { updated_at: foodStamp(db), updated_by: who });
  }
  return Object.assign(out, { step_id: s.id });
}

// A homework function: PostgREST's argument matching (404 PGRST202 otherwise, and on a database
// without 0005); db.hwFail[name] answers instead (a failure); a raise undoes the whole call.
function hwCall(name, args, defaults, run) {
  return (db, b, email) => {
    const sent = Object.keys(b || {});
    if (!db.homework_kids || sent.some((k) => !args.includes(k) && !defaults.includes(k)) || args.some((k) => !sent.includes(k))) {
      return { __status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${name}(${sent.sort().join(', ')}) in the schema cache`, details: null, hint: null } };
    }
    if (db.hwFail && db.hwFail[name]) return db.hwFail[name];
    const keys = HW_TABLES.concat(['events']);
    const saved = JSON.stringify(keys.map((t) => db[t]));
    try {
      return run(db, b || {}, email);
    } catch (e) {
      if (!(e instanceof Raise)) throw e;
      JSON.parse(saved).forEach((rows, i) => { db[keys[i]] = rows; });
      return raised(e, false);
    }
  };
}
const parentOnly = (db, email) => { if (!hwAdmin(db, email)) throw new Raise('42501', PARENT_ONLY); };

const homeworkRpc = {
  homework_week: hwCall('homework_week', ['p_kid', 'p_from'], ['p_days'], (db, b) => {
    const HP = homePlan();
    const n = b.p_days == null ? 14 : b.p_days;
    if (!b.p_from || !Number.isInteger(n) || n < 1 || n > 56) throw new Raise('22023', 'Choose 1 to 56 days.');
    const to = HP.addDays(b.p_from, n - 1);
    const free = new Map(hwFree(db, b.p_kid, b.p_from, to, null).map((f) => [f.day, f]));
    const out = [];
    for (let d = b.p_from; d <= to; d = HP.addDays(d, 1)) {
      const f = free.get(d);
      const planned = hwPlanned(db, b.p_kid, d, null);
      out.push({ day: d, window: f ? { starts: f.starts, ends: f.ends } : null, busy: f ? f.busy : [], free: f ? f.free : 0, planned,
        over: Math.max(planned - (f ? f.free : 0), 0) });
    }
    return out;
  }),
  save_homework_kid: hwCall('save_homework_kid', ['p_kid', 'p_active'], [], (db, b, email) => {
    parentOnly(db, email);
    if (b.p_active == null) throw new Raise('22023', 'Choose on or off.');
    const p = (db.people || []).find((x) => x.id === b.p_kid);
    if (b.p_active && !(p && p.active !== false && p.role === 'kid')) throw new Raise('22023', 'Homework is for kids.');
    const k = db.homework_kids.find((x) => x.kid_id === b.p_kid);
    if (!k && !b.p_active) return null;
    if (!k) db.homework_kids.push(hwKidRow({ kid_id: b.p_kid, active: true, created_at: foodStamp(db), created_by: email, updated_at: foodStamp(db), updated_by: email }));
    else if (k.active !== b.p_active) {
      // 0006's trigger: homework back on makes his school links due now.
      if (b.p_active && db.school_feeds) db.school_feeds.filter((f) => f.kid_id === b.p_kid && !f.removed_at).forEach((f) => { f.next_at = scDueNow(db, f.next_at); });
      Object.assign(k, { active: b.p_active, updated_at: foodStamp(db), updated_by: email });
    }
    return null;
  }),
  add_homework_time: hwCall('add_homework_time', ['p_kid', 'p_weekdays', 'p_start', 'p_end'], [], (db, b, email) => {
    const HP = homePlan();
    parentOnly(db, email);
    if (!db.homework_kids.some((k) => k.kid_id === b.p_kid)) throw new Raise('22023', 'Turn on homework for this kid first.');
    const days = [...new Set((b.p_weekdays || []).filter((w) => w != null))].sort((x, y) => x - y);
    if (days.length < 1 || days.length > 7) throw new Raise('22023', 'Choose 1 to 7 days.');
    if (days.some((w) => !Number.isInteger(w) || w < 1 || w > 7)) throw new Raise('23514', 'new row for relation "events" violates check constraint "events_repeat_weekdays_check"');
    const s = hwMinutes(b.p_start);
    const e = hwMinutes(b.p_end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Raise('22023', 'Homework time ends after it starts.');
    if (e - s > 240) throw new Raise('22023', 'Homework time is at most 4 hours.');
    const today = hwToday(db);
    let start = today;
    for (let i = 0; i < 7; i++) { const d = HP.addDays(today, i); if (days.includes(HP.isoWeekday(d))) { start = d; break; } }
    const kid = (db.people || []).find((x) => x.id === b.p_kid) || {};
    const t = foodStamp(db);
    const ev = {
      id: uuid(), title: kid.language === 'es' ? 'Tarea' : 'Homework', notes: null, location: null, start_date: start, end_date: null,
      start_time: `${hwClock(s)}:00`, end_time: `${hwClock(e)}:00`, ends_next_day: false, responsible_id: b.p_kid, participant_ids: [], contractor_id: null,
      private: false, repeat: 'weekly', repeat_every: 1, repeat_weekdays: days, repeat_until: null, skip_days_off: true,
      created_by: email, updated_by: email, created_at: t, updated_at: t,
    };
    db.events.push(ev);
    db.homework_times.push({ event_id: ev.id, kid_id: b.p_kid });
    return ev.id;
  }),
  save_homework_plan: hwCall('save_homework_plan', ['p_assignment', 'p_steps', 'p_rev'], ['p_give'], (db, b, email) => {
    parentOnly(db, email);
    return hwPlanSave(db, b.p_assignment, b.p_steps, !!b.p_give, b.p_rev, email);
  }),
  homework_step: hwCall('homework_step', ['p_step', 'p_action'], ['p_text'], (db, b, email) => {
    parentOnly(db, email);
    if (b.p_text != null && Array.from(String(b.p_text)).length > (b.p_action === 'answer' ? 200 : 160)) throw new Raise('22023', 'That\'s too long.');
    if (!db.homework_steps.some((s) => s.id === b.p_step)) throw new Raise('22023', 'That step is gone.');
    return hwStepAct(db, b.p_step, b.p_action, b.p_text, email);
  }),
  decide_reward: hwCall('decide_reward', ['p_ask', 'p_approve'], ['p_note'], (db, b, email) => {
    parentOnly(db, email);
    if (b.p_note != null && Array.from(String(b.p_note)).length > 120) throw new Raise('22023', 'That\'s too long.');
    if (b.p_approve == null) throw new Raise('22023', 'Choose Yes or Not now.');
    const x = db.reward_asks.find((r) => r.id === b.p_ask);
    if (!x) throw new Raise('22023', 'That ask is gone.');
    if (x.status === 'waiting') {
      const bal = hwBalance(db, x.kid_id);
      if (b.p_approve) {
        if (bal.balance - (bal.held - x.cost) < x.cost) throw new Raise('42501', 'Not enough points yet.');
        hwAward(db, x.kid_id, 'trade', -x.cost, hwToday(db), { ask: x.id, note: x.title, who: email });
        Object.assign(x, { status: 'approved', decided_at: foodStamp(db), decided_by: email });
      } else {
        Object.assign(x, { status: 'declined', decided_at: foodStamp(db), decided_by: email, note: cleanText(b.p_note, 120) || null });
      }
    }
    return { ask: Object.assign({}, x), balance: hwBalance(db, x.kid_id).balance };
  }),
  give_points: hwCall('give_points', ['p_kid', 'p_points', 'p_note', 'p_key'], [], (db, b, email) => {
    parentOnly(db, email);
    if (!Number.isInteger(b.p_points) || b.p_points < 1 || b.p_points > 200) throw new Raise('22023', 'Give 1 to 200 points.');
    if (b.p_note != null && Array.from(String(b.p_note)).length > 120) throw new Raise('22023', 'That\'s too long.');
    const note = cleanText(b.p_note, 120);
    if (!note) throw new Raise('22023', 'Say what the points are for.');
    if (!b.p_key) throw new Raise('22023', 'Points need their id.');
    let l = db.points_ledger.find((x) => x.id === b.p_key);
    if (l && (l.kid_id !== b.p_kid || l.kind !== 'given')) throw new Raise('22023', 'That id is taken.');
    if (!l) {
      if (!db.homework_kids.some((k) => k.kid_id === b.p_kid && k.points_on)) throw new Raise('42501', 'Points are off.');
      l = ledgerRow({ id: b.p_key, kid_id: b.p_kid, at: foodStamp(db), day: hwToday(db), kind: 'given', delta: b.p_points, note, who: email });
      db.points_ledger.push(l);
    }
    return { entry: { id: l.id, delta: l.delta, note: l.note }, balance: hwBalance(db, b.p_kid).balance };
  }),
  void_points: hwCall('void_points', ['p_entry', 'p_note'], [], (db, b, email) => {
    parentOnly(db, email);
    if (b.p_note != null && Array.from(String(b.p_note)).length > 120) throw new Raise('22023', 'That\'s too long.');
    const note = cleanText(b.p_note, 120);
    if (!note) throw new Raise('22023', 'Say why.');
    const l = db.points_ledger.find((x) => x.id === b.p_entry);
    if (!l || !['focus', 'on_time', 'milestone', 'given'].includes(l.kind)) throw new Raise('22023', 'Only earned or given points can be voided.');
    if (!db.points_ledger.some((x) => x.kind === 'void' && x.void_of === l.id)) {
      if (hwBalance(db, l.kid_id).balance - l.delta < 0) throw new Raise('P0001', 'Those points are already spent.');
      hwAward(db, l.kid_id, 'void', -l.delta, hwToday(db), { voidOf: l.id, note, who: email });
    }
    const v = db.points_ledger.find((x) => x.kind === 'void' && x.void_of === l.id);
    return { entry: { id: v.id, delta: v.delta, note: v.note }, balance: hwBalance(db, l.kid_id).balance };
  }),
  save_tutor_link: hwCall('save_tutor_link', ['p_link', 'p_kid', 'p_label', 'p_language', 'p_expires_on', 'p_can_ai', 'p_active'], [], (db, b, email) => {
    const HP = homePlan();
    parentOnly(db, email);
    const today = hwToday(db);
    const label = cleanText(b.p_label, 200);
    const ends = b.p_expires_on || HP.addDays(today, 180);
    if (!label || Array.from(label).length > 60) throw new Raise('22023', 'A link\'s name is 1 to 60 characters.');
    if (!['en', 'es'].includes(b.p_language || 'en')) throw new Raise('22023', 'Choose English or Spanish.');
    const kept = b.p_link != null && db.tutor_links.some((x) => x.id === b.p_link && x.expires_on === ends);   // a change keeps its own end date, even past
    if ((ends < today || ends > HP.addDays(today, 400)) && !kept) throw new Raise('22023', 'A link ends from today to 400 days from now.');
    const t = foodStamp(db);
    if (b.p_link == null) {
      if (!db.homework_kids.some((k) => k.kid_id === b.p_kid)) throw new Raise('22023', 'Turn on homework for this kid first.');
      if (db.tutor_links.filter((l) => l.kid_id === b.p_kid).length >= 3) throw new Raise('22023', 'At most 3 tutor links.');
      const l = tutorLinkRow({ kid_id: b.p_kid, label, language: b.p_language || 'en', expires_on: ends, can_ai: b.p_can_ai == null ? true : b.p_can_ai,
        active: b.p_active == null ? true : b.p_active, created_at: t, created_by: email, updated_at: t, updated_by: email });
      db.tutor_links.push(l);
      return l.id;
    }
    const l = db.tutor_links.find((x) => x.id === b.p_link);
    if (!l) throw new Raise('22023', 'That link is gone.');
    Object.assign(l, { label, language: b.p_language || l.language, expires_on: ends, can_ai: b.p_can_ai == null ? l.can_ai : b.p_can_ai,
      active: b.p_active == null ? l.active : b.p_active, updated_at: t, updated_by: email });
    return l.id;
  }),
  new_tutor_token: hwCall('new_tutor_token', ['p_link'], [], (db, b, email) => {
    parentOnly(db, email);
    const l = db.tutor_links.find((x) => x.id === b.p_link);
    if (!l) throw new Raise('22023', 'That link is gone.');
    Object.assign(l, { token: crypto.randomBytes(16).toString('hex'), updated_at: foodStamp(db), updated_by: email });
    return null;
  }),
  erase_homework: hwCall('erase_homework', ['p_kid', 'p_confirm'], [], (db, b, email) => {
    parentOnly(db, email);
    if (b.p_confirm !== 'ERASE') throw new Raise('22023', 'Type ERASE to erase.');
    const kid = b.p_kid;
    const mine = new Set(db.assignments.filter((a) => a.kid_id === kid).map((a) => a.id));
    const links = new Set(db.tutor_links.filter((l) => l.kid_id === kid).map((l) => l.id));
    const counts = {
      assignments: mine.size, steps: db.homework_steps.filter((s) => mine.has(s.assignment_id)).length,
      sessions: db.focus_sessions.filter((x) => x.kid_id === kid).length, points: db.points_ledger.filter((x) => x.kid_id === kid).length,
      rewards: db.rewards.filter((x) => x.kid_id === kid).length, asks: db.reward_asks.filter((x) => x.kid_id === kid).length, links: links.size,
      ai_runs: db.ai_runs.filter((x) => x.kid_id === kid).length, times: db.homework_times.filter((x) => x.kid_id === kid).length,
    };
    db.homework_use = db.homework_use.filter((u) => u.actor_id !== kid && !links.has(u.actor_id));
    db.homework_steps = db.homework_steps.filter((s) => !mine.has(s.assignment_id));
    ['assignments', 'focus_sessions', 'points_ledger', 'rewards', 'reward_asks', 'tutor_links', 'ai_runs', 'homework_times', 'homework_kids']
      .forEach((t) => { db[t] = db[t].filter((x) => (x.kid_id) !== kid); });
    if (db.school_feeds) {   // 0006: school_feeds.kid_id → homework_kids on delete cascade, and its items with it
      const gone = new Set(db.school_feeds.filter((f) => f.kid_id === kid).map((f) => f.id));
      db.school_feeds = db.school_feeds.filter((f) => !gone.has(f.id));
      db.school_items = db.school_items.filter((i) => !gone.has(i.feed_id));
    }
    return counts;
  }),
};

// ---- Schema 6 (0006_homework_school.sql, docs/v1.3-homework.md §11, §12): the school's Blackbaud calendar links.
// withSchool(db, opts) is for a schema-6 database (after withHomework, or withHomeworkTokens on My day's side): it adds
// school_feeds and school_items, which members read (schoolFeedRow and schoolItemRow make rows; writes are the
// functions'), and keeps each link's address apart, in SCHOOL_URLS (a WeakMap no route reaches, as no API role can
// read private.school_feed_urls; schoolUrlOf(db, feedId) is the test's own look). db.schoolLastRun is school_sync's
// last_run_at, db.schoolSuffix the host suffix (.school.example here, for the database's .myschoolapp.com).
// schoolRpc fakes the parents' functions with the migration's rules, messages and shapes:
//   school_feed_status(p_kid)                       members; null for a kid without homework
//   set_school_feed(p_kid, p_kind, p_url)           Add link, Replace; null or '' is Remove → {id, kind, host, url_end} | null
//   check_school_feed(p_feed, p_date_rule, p_date_shift)   the first-import check → the status
//   pause_school_feed(p_feed, p_paused)             → null (void)
//   school_item_action(p_item, p_action)            'add' | 'hide' | 'show' → {assignment_id} and the status
// each change for parents only (42501 "Only a parent can change homework."). homeworkTokenRpc's school_item_by_token
// is Jordan's ('quick' through assignment_by_token's own Quick, 'with_tutor', 'hide'); his view's from_school and each
// assignment's school marks, Pat's marks and the card's from_school count come from the same rows. hub-jobs'
// { action: 'school' } (Check now) is schoolJob below: db.schoolJob = 'no_schema' | 'old' answers as those would,
// db.schoolReply replaces the answer, db.schoolRead(db, feed) is what a read brought (it may add items).
// Without withSchool every one answers 404 and the keys aren't there, as on schema 5.
const SCHOOL_KINDS = ['assignments', 'schedule', 'games'];
const SCHOOL_URLS = new WeakMap();
function withSchool(db, opts) {
  db.school_feeds = db.school_feeds || [];
  db.school_items = db.school_items || [];
  db.schoolSuffix = (opts && opts.suffix) || db.schoolSuffix || '.school.example';
  if (db.schoolLastRun === undefined) db.schoolLastRun = null;
  if (!SCHOOL_URLS.has(db)) SCHOOL_URLS.set(db, new Map());
  return db;
}
const schoolUrlOf = (db, feedId) => (SCHOOL_URLS.get(db) || new Map()).get(feedId) || null;
const schoolFeedRow = (o) => Object.assign({
  id: uuid(), kid_id: null, kind: 'assignments', host: 'academy.school.example', url_end: 'a1b2', date_rule: 'end', date_shift: 0, checked: false,
  paused: false, next_at: null, last_try_at: null, last_ok_at: null, last_count: null, last_repeats: null, last_stop: null, fails: 0,
  removed_at: null, created_at: now(), created_by: null, updated_at: now(), updated_by: null,
}, o);
const schoolItemRow = (o) => {
  const r = Object.assign({
    id: uuid(), feed_id: null, key: crypto.randomBytes(16).toString('hex'), has_uid: true, title: '', subject: null, details: null, first_day: null,
    last_day: null, due_date: null, starts_at: null, ends_at: null, assignment_id: null, made_at: null, applied: null, hidden: false,
    first_seen_at: now(), last_seen_at: now(), missing: 0, gone_at: null,
  }, o);
  if (r.due_date && !r.first_day) Object.assign(r, { first_day: r.due_date, last_day: r.due_date });
  return r;
};
const SCHOOL_BAD_LINK = "That isn't a school calendar link. Copy it from the calendar's feed button: it starts with webcal:// or https:// and has /podium/feed/iCal.aspx?z= in it.";
// private.school_url: the link as the hub keeps it, or null.
function schoolUrl(db, raw) {
  let v = raw == null ? null : String(raw).replace(/^ +| +$/g, '');
  if (v == null || v.length > 500 || /[\s\u0000-\u001f\u007f<>"\\]/.test(v)) return null;
  v = v.replace(/^webcal:\/\//i, 'https://');
  const m = /^https:\/\/([^/?#@:]+)(:443)?(\/[^?#]*)\?([^#]*)$/i.exec(v);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const suf = db.schoolSuffix;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || host.length <= suf.length || !host.endsWith(suf)
    || m[3].toLowerCase() !== '/podium/feed/ical.aspx' || !/(^|&)z=[^&]+/.test(m[4])) return null;
  return `https://${host}${m[3]}?${m[4]}`;
}
const scFeed = (db, id) => db.school_feeds.find((f) => f.id === id) || null;
const scByDue = (x, y) => (x.due_date < y.due_date ? -1 : x.due_date > y.due_date ? 1 : x.title < y.title ? -1 : x.title > y.title ? 1 : x.id < y.id ? -1 : 1);
const scItemsOf = (db, kid, pred) => db.school_items.filter((i) => { const f = scFeed(db, i.feed_id); return f && f.kid_id === kid && pred(i, f); });
// The school's marks on his assignments made from school: { id: {gone, moved_to} } (private.school_marks).
function scMarks(db, kid) {
  const out = {};
  scItemsOf(db, kid, (i) => !!i.assignment_id).forEach((i) => {
    const a = db.assignments.find((x) => x.id === i.assignment_id);
    if (!a) return;
    out[a.id] = { gone: i.gone_at != null, moved_to: i.due_date !== a.due_date && i.applied && a.due_date === i.applied.due_date ? i.due_date : null };
  });
  return out;
}
// His New from school (private.school_new), or null while he has no checked Assignments link.
function scNew(db, kid, today) {
  if (!db.school_feeds || !db.school_feeds.some((f) => f.kid_id === kid && f.kind === 'assignments' && f.checked)) return null;
  return scItemsOf(db, kid, (i, f) => f.kind === 'assignments' && f.checked && !i.made_at && !i.hidden && !i.gone_at
    && i.due_date >= today && i.due_date <= tkAdd(today, 30)).sort(scByDue).slice(0, 20)
    .map((i) => ({ id: i.id, title: i.title, subject: i.subject, due_date: i.due_date, quick: tkBetween(today, i.due_date) <= 3 }));
}
// The status card (school_feed_status). A removed link (its row kept only for the assignments made from it) isn't on it.
function scStatus(db, kid, nowMs, today) {
  const order = { assignments: 1, schedule: 2, games: 3 };
  const assignment = (i) => (i.assignment_id ? db.assignments.find((a) => a.id === i.assignment_id && a.status === 'open') : null);
  const pick = (i) => ({ id: i.id, title: i.title, subject: i.subject, due_date: i.due_date });
  const on = db.homework_kids.some((k) => k.kid_id === kid && k.active);
  return {
    kid_id: kid, last_run_at: db.schoolLastRun || null,
    feeds: db.school_feeds.filter((f) => f.kid_id === kid && !f.removed_at).sort((x, y) => order[x.kind] - order[y.kind]).map((f) => ({
      id: f.id, kind: f.kind, host: f.host, url_end: f.url_end, checked: f.checked, date_rule: f.date_rule, date_shift: f.date_shift, paused: f.paused,
      last_try_at: f.last_try_at, last_ok_at: f.last_ok_at, last_count: f.last_count, last_repeats: f.last_repeats, last_stop: f.last_stop, fails: f.fails,
      next_at: f.next_at, stale: !f.paused && on && f.next_at != null && tkMs(f.next_at) < nowMs - 2 * 3600e3 })),
    check: scItemsOf(db, kid, (i, f) => f.kind === 'assignments' && !f.checked && !f.removed_at && i.due_date != null && i.due_date >= today && !i.gone_at).sort(scByDue).slice(0, 5)
      .map((i) => ({ id: i.id, title: i.title, subject: i.subject, first_day: i.first_day, last_day: i.last_day, due_date: i.due_date })),
    new: scItemsOf(db, kid, (i, f) => f.kind === 'assignments' && f.checked && !f.removed_at && !i.made_at && !i.hidden && !i.gone_at && i.due_date >= today
      && i.due_date <= tkAdd(today, 30)).sort(scByDue).slice(0, 50).map(pick),
    hidden: scItemsOf(db, kid, (i, f) => f.kind === 'assignments' && !f.removed_at && !i.made_at && i.hidden && !i.gone_at && i.due_date >= today).sort(scByDue).map(pick),
    moved: scItemsOf(db, kid, (i) => { const a = assignment(i); return !!a && !i.gone_at && i.due_date !== a.due_date && !!i.applied && a.due_date === i.applied.due_date; })
      .map((i) => { const a = assignment(i); return { assignment_id: a.id, title: a.title, from: a.due_date, to: i.due_date, due_date: a.due_date }; })
      .sort(scByDue).map((x) => ({ assignment_id: x.assignment_id, title: x.title, from: x.from, to: x.to })),
    gone: scItemsOf(db, kid, (i) => !!assignment(i) && i.gone_at != null).map((i) => { const a = assignment(i); return { assignment_id: a.id, title: a.title, due_date: a.due_date }; })
      .sort((x, y) => scByDue(Object.assign({ id: x.assignment_id }, x), Object.assign({ id: y.assignment_id }, y))),
  };
}
// private.school_assignment: the item made an assignment from school (once; a second time answers the same one).
function scAssignment(db, item, who, stamp) {
  if (!item || item.due_date == null) throw new Raise('22023', "That item from school isn't there any more.");
  if (item.made_at) return item.assignment_id;
  const f = scFeed(db, item.feed_id);
  const a = assignmentRow({ kid_id: f.kid_id, kind: 'assignment', added_by: 'school', title: item.title, subject: item.subject, due_date: item.due_date,
    details: item.details, created_by: who, updated_by: who, created_at: stamp, updated_at: stamp });
  db.assignments.push(a);
  Object.assign(item, { assignment_id: a.id, made_at: stamp, hidden: false,
    applied: { title: a.title, subject: a.subject, due_date: a.due_date, details: a.details } });
  return a.id;
}
// private.school_apply: the school's changes reach the open assignments made from a link's items, a field at a time,
// never a field a person changed; a planned assignment's due date never moves by itself.
function scApply(db, feedId) {
  db.school_items.filter((i) => i.feed_id === feedId && !i.gone_at && i.due_date && i.assignment_id).forEach((i) => {
    const a = db.assignments.find((x) => x.id === i.assignment_id && x.status === 'open');
    if (!a) return;
    const ap = i.applied || {};
    const plan = db.homework_steps.some((s) => s.assignment_id === a.id);
    const next = {
      title: a.title === ap.title ? i.title : a.title, subject: a.subject === ap.subject ? i.subject : a.subject,
      due_date: a.due_date === ap.due_date && !plan ? i.due_date : a.due_date, details: a.details === ap.details ? i.details : a.details,
    };
    if (Object.keys(next).some((k) => next[k] !== a[k])) Object.assign(a, next, { updated_by: 'school link', updated_at: now() });
    i.applied = Object.fromEntries(Object.keys(next).map((k) => [k, next[k] === i[k] ? i[k] : ap[k]]));
  });
}
function scCall(name, args, defaults, run) {
  return (db, b, email) => {
    const sent = Object.keys(b || {});
    if (!db.school_feeds || !db.homework_kids || sent.some((k) => !args.includes(k) && !defaults.includes(k)) || args.some((k) => !sent.includes(k))) {
      return { __status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${name}(${sent.sort().join(', ')}) in the schema cache`, details: null, hint: null } };
    }
    if (db.schoolFail && db.schoolFail[name]) return db.schoolFail[name];
    const keys = ['school_feeds', 'school_items', 'assignments'];
    const saved = JSON.stringify(keys.map((t) => db[t]));
    const urls = new Map(SCHOOL_URLS.get(db));
    try {
      const out = run(db, b || {}, email);
      return out === undefined ? null : JSON.parse(JSON.stringify(out));
    } catch (e) {
      if (!(e instanceof Raise)) throw e;
      JSON.parse(saved).forEach((rows, i) => { db[keys[i]] = rows; });
      SCHOOL_URLS.set(db, urls);
      return raised(e, false);
    }
  };
}
const scNowMs = (db) => db.foodNow;
// A link that can be read again (Resume; homework back on, the homework_kids_school_due trigger): due now, or its later next_at.
const scDueNow = (db, nextAt) => (nextAt && tkMs(nextAt) > scNowMs(db) ? nextAt : fromMicros(scNowMs(db) * 1000));
const scStatusOf = (db, kid) => scStatus(db, kid, scNowMs(db), hwToday(db));
const schoolRpc = {
  school_feed_status: scCall('school_feed_status', ['p_kid'], [], (db, b, email) => {
    if (!db.members.some((m) => m.email === email) || !db.homework_kids.some((k) => k.kid_id === b.p_kid)) return null;
    return scStatusOf(db, b.p_kid);
  }),
  set_school_feed: scCall('set_school_feed', ['p_kid', 'p_kind', 'p_url'], [], (db, b, email) => {
    parentOnly(db, email);
    if (!SCHOOL_KINDS.includes(b.p_kind)) throw new Raise('22023', 'Choose assignments, schedule or games.');
    if (!db.homework_kids.some((k) => k.kid_id === b.p_kid)) throw new Raise('22023', 'Turn on homework for this kid first.');
    const old = db.school_feeds.find((f) => f.kid_id === b.p_kid && f.kind === b.p_kind) || null;
    if (b.p_url == null || !String(b.p_url).trim()) {
      // Remove: the address and every item nobody made an assignment go; while items made assignments remain, the row
      // stays for them, marked removed (not read, not on the card, its check answer taken back), else it goes too.
      if (old) {
        SCHOOL_URLS.get(db).delete(old.id);
        db.school_items = db.school_items.filter((i) => i.feed_id !== old.id || i.made_at);
        if (db.school_items.some((i) => i.feed_id === old.id)) {
          Object.assign(old, { removed_at: old.removed_at || fromMicros(scNowMs(db) * 1000), checked: false, paused: false, next_at: null, fails: 0,
            last_stop: null, updated_by: email, updated_at: now() });
        } else db.school_feeds = db.school_feeds.filter((f) => f !== old);
      }
      return null;
    }
    const url = schoolUrl(db, b.p_url);
    if (!url) throw new Raise('22023', SCHOOL_BAD_LINK);
    const at = fromMicros(scNowMs(db) * 1000);
    const host = url.slice(8).split('/')[0];
    let f = old;
    if (!f) {
      f = schoolFeedRow({ kid_id: b.p_kid, kind: b.p_kind, host, url_end: url.slice(-4), next_at: at, created_by: email, updated_by: email });
      db.school_feeds.push(f);
    } else Object.assign(f, { host, url_end: url.slice(-4), next_at: at, fails: 0, last_stop: null, removed_at: null, updated_by: email, updated_at: now() });
    SCHOOL_URLS.get(db).set(f.id, url);
    return { id: f.id, kind: f.kind, host: f.host, url_end: f.url_end };
  }),
  check_school_feed: scCall('check_school_feed', ['p_feed', 'p_date_rule', 'p_date_shift'], [], (db, b, email) => {
    parentOnly(db, email);
    const f = scFeed(db, b.p_feed);
    if (!f || f.removed_at) throw new Raise('22023', "That school link isn't there any more.");
    if (f.kind !== 'assignments') throw new Raise('22023', 'Only the Assignments link has dates to check.');
    if (!['start', 'end'].includes(b.p_date_rule) || ![-1, 0, 1].includes(b.p_date_shift)) {
      throw new Raise('22023', 'Choose the start or the end date, and a shift of -1, 0 or 1 day.');
    }
    Object.assign(f, { date_rule: b.p_date_rule, date_shift: b.p_date_shift, checked: true, updated_by: email, updated_at: now() });
    db.school_items.filter((i) => i.feed_id === f.id && i.first_day).forEach((i) => { i.due_date = tkAdd(b.p_date_rule === 'start' ? i.first_day : i.last_day, b.p_date_shift); });
    scApply(db, f.id);
    return scStatusOf(db, f.kid_id);
  }),
  pause_school_feed: scCall('pause_school_feed', ['p_feed', 'p_paused'], [], (db, b, email) => {
    parentOnly(db, email);
    if (typeof b.p_paused !== 'boolean') throw new Raise('22023', 'Choose on or off.');
    const f = scFeed(db, b.p_feed);
    if (!f || f.removed_at) throw new Raise('22023', "That school link isn't there any more.");
    // Resume: due now (unless a backoff has it later), so "stale" counts from then.
    if (f.paused && !b.p_paused) f.next_at = scDueNow(db, f.next_at);
    Object.assign(f, { paused: b.p_paused, updated_by: email, updated_at: now() });
    return null;
  }),
  school_item_action: scCall('school_item_action', ['p_item', 'p_action'], [], (db, b, email) => {
    parentOnly(db, email);
    if (!['add', 'hide', 'show'].includes(b.p_action)) throw new Raise('22023', 'Choose add, hide or show.');
    const i = db.school_items.find((x) => x.id === b.p_item);
    const f = i && scFeed(db, i.feed_id);
    if (!f || f.kind !== 'assignments') throw new Raise('22023', "That item from school isn't there any more.");
    let aid = null;
    if (b.p_action === 'add') aid = scAssignment(db, i, email, fromMicros(scNowMs(db) * 1000));
    else if (!i.made_at) i.hidden = b.p_action === 'hide';
    return Object.assign({ assignment_id: aid }, scStatusOf(db, f.kid_id));
  }),
};
// hub-jobs { action: 'school' }: Check now, for a signed-in admin (handler.ts's school; school.ts's runSchool reads every
// link not read in the last minute). Each read link gets what db.schoolRead(db, feed) does (it may add items), then a good
// read's status; the answer is { ok, read, stored, failed, skipped, items, stop }.
function schoolJob(db, email) {
  (db.jobCalls = db.jobCalls || []).push({ body: { action: 'school' }, email });
  if (db.schoolJob === 'old') return { status: 400, body: { error: 'Unknown action. Use digest, preview, status, calendar or calendar_test.' } };
  if (db.schoolJob === 'no_schema') return { status: 503, body: { ok: false, stop: 'no_schema', error: 'The school feed needs the database update (migration 0006_homework_school.sql).' } };
  const m = db.members.find((x) => x.email === email);
  if (!m) return { status: 401, body: { error: 'Not allowed.' } };
  if (m.role !== 'admin') return { status: 403, body: { error: 'Only family admins can do this.' } };
  if (db.schoolReply) return db.schoolReply.__status ? { status: db.schoolReply.__status, body: db.schoolReply.body } : { status: 200, body: db.schoolReply };
  const nowMs = scNowMs(db);
  const at = fromMicros(nowMs * 1000);
  const tally = { read: 0, stored: 0, failed: 0, skipped: 0, items: 0 };
  db.school_feeds.filter((f) => !f.paused && !f.removed_at && (!f.last_try_at || tkMs(f.last_try_at) < nowMs - 60e3)
    && db.homework_kids.some((k) => k.kid_id === f.kid_id && k.active)).forEach((f) => {
    tally.read++;
    if (db.schoolRead) db.schoolRead(db, f);
    const kept = db.school_items.filter((i) => i.feed_id === f.id).length;
    Object.assign(f, { last_try_at: at, last_ok_at: at, last_count: kept, last_stop: null, fails: 0, next_at: fromMicros((nowMs + 50 * 60e3) * 1000) });
    tally.stored++;
    tally.items += kept;
  });
  db.schoolLastRun = at;
  return { status: 200, body: Object.assign({ ok: true }, tally, { stop: null }) };
}

// The homework tables' row-level security, column grants, checks and triggers (§3.2). Returns
// { status, body, rows } or null (not one of them).
const hwCheck = (table, name) => new Raise('23514', `new row for relation "${table}" violates check constraint "${name}"`);
function tidyAssignment(r, old) {
  const HP = homePlan();
  const t = Object.assign({}, r);
  if ('title' in t) t.title = cleanText(t.title, 120) || '';
  if ('subject' in t) t.subject = cleanText(t.subject, 40) || null;
  if ('details' in t) t.details = t.details == null ? null : HP.cleanBlock(t.details, 4000) || null;
  if ('stretch' in t) t.stretch = cleanText(t.stretch, 160) || null;
  const status = 'status' in t ? t.status : old ? old.status : 'open';
  t.done_at = status !== 'done' ? null : old && old.status === 'done' ? old.done_at : null;
  t.dropped_at = status !== 'dropped' ? null : old && old.status === 'dropped' ? old.dropped_at : null;
  return t;
}
function assignmentProblem(r) {
  if (!['assignment', 'lesson'].includes(r.kind)) return hwCheck('assignments', 'assignments_kind_check');
  if (!r.title || Array.from(r.title).length > 120) return hwCheck('assignments', 'assignments_title_check');
  if (!r.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(r.due_date)) return new Raise('23502', 'null value in column "due_date" of relation "assignments" violates not-null constraint');
  if (!['open', 'done', 'dropped'].includes(r.status)) return hwCheck('assignments', 'assignments_status_check');
  return null;
}
function rewardProblem(r) {
  if (!r.title || Array.from(r.title).length > 60) return hwCheck('rewards', 'rewards_title_check');
  if (r.cost != null && !(Number.isInteger(r.cost) && r.cost >= 1 && r.cost <= 10000)) return hwCheck('rewards', 'rewards_cost_check');
  if (r.cost == null && r.active) return hwCheck('rewards', 'rewards_check');
  return null;
}
function hwKidProblem(r) {
  if (![10, 15, 20, 25].includes(r.focus_minutes)) return hwCheck('homework_kids', 'homework_kids_focus_minutes_check');
  const range = { pts_focus: [0, 5], pts_on_time: [0, 50], pts_milestone: [0, 100], pts_day_cap: [0, 300], pts_milestone_week: [0, 400] };
  const bad = Object.keys(range).find((k) => !(Number.isInteger(r[k]) && r[k] >= range[k][0] && r[k] <= range[k][1]));
  return bad ? hwCheck('homework_kids', `homework_kids_${bad}_check`) : null;
}
function homeworkTables(db, table, method, body, member, rows) {
  if (!HW_TABLES.includes(table) || !db[table]) return null;
  const denied = tableErr(new Raise('42501', `permission denied for table ${table}`));
  if (table === 'homework_use') return denied;
  const admin = member.role === 'admin';
  const email = member.email;
  const rls = tableErr(new Raise('42501', `new row violates row-level security policy for table "${table}"`));
  const items = Array.isArray(body) ? body : [body || {}];
  const only = (cols) => items.every((r) => Object.keys(r).every((k) => cols.includes(k)));
  const drop = (gone) => { db[table] = db[table].filter((r) => !gone.includes(r)); };
  try {
    if (method === 'GET') return { rows: ['tutor_links', 'ai_runs'].includes(table) && !admin ? [] : rows };
    if (table === 'homework_kids') {
      if (method !== 'PATCH' || !only(HW_KID_UPDATE)) return denied;
      if (!admin) return { status: 200, rows: [] };
      const next = rows.map((r) => Object.assign({}, r, body, { updated_at: foodStamp(db), updated_by: email }));
      next.forEach((n) => { const bad = hwKidProblem(n); if (bad) throw bad; });
      rows.forEach((r, i) => Object.assign(r, next[i]));
      return { status: 200, rows };
    }
    if (table === 'homework_times') {
      if (method === 'POST') {
        if (!only(['event_id', 'kid_id'])) return denied;
        if (!admin) return rls;
        const made = items.map((r) => ({ event_id: r.event_id, kid_id: r.kid_id }));
        db.homework_times.push(...made);
        return { status: 201, rows: made };
      }
      if (method === 'DELETE') {
        if (!admin) return { status: 204, rows: [] };
        drop(rows);
        return { status: 204, rows };
      }
      return denied;
    }
    if (table === 'assignments') {
      if (method === 'POST') {
        if (!only(HW_ASSIGNMENT_INSERT)) return denied;
        if (!admin) return rls;
        const made = items.map((r) => {
          const t = foodStamp(db);
          const row = assignmentRow(Object.assign(tidyAssignment(Object.assign({ kind: 'assignment', status: 'open' }, r)), { created_at: t, created_by: email, updated_at: t, updated_by: email }));
          if (row.status === 'done') row.done_at = t;
          if (row.status === 'dropped') row.dropped_at = t;
          const bad = assignmentProblem(row);
          if (bad) throw bad;
          return row;
        });
        db.assignments.push(...made);
        return { status: 201, rows: made };
      }
      if (method === 'PATCH') {
        if (!only(HW_ASSIGNMENT_INSERT.slice(1))) return denied;
        if (!admin) return { status: 200, rows: [] };
        const next = rows.map((r) => {
          const n = Object.assign({}, r, tidyAssignment(body, r), { updated_at: foodStamp(db), updated_by: email });
          if (n.status === 'done' && !n.done_at) n.done_at = n.updated_at;
          if (n.status === 'dropped' && !n.dropped_at) n.dropped_at = n.updated_at;
          const bad = assignmentProblem(n);
          if (bad) throw bad;
          return n;
        });
        rows.forEach((r, i) => Object.assign(r, next[i]));
        return { status: 200, rows };
      }
      if (method === 'DELETE') {
        if (!admin) return { status: 204, rows: [] };
        const ids = new Set(rows.map((r) => r.id));
        const steps = new Set(db.homework_steps.filter((s) => ids.has(s.assignment_id)).map((s) => s.id));
        db.homework_steps = db.homework_steps.filter((s) => !steps.has(s.id));
        db.focus_sessions.forEach((x) => { if (ids.has(x.assignment_id)) x.assignment_id = null; if (steps.has(x.step_id)) x.step_id = null; });
        db.points_ledger.forEach((x) => { if (steps.has(x.step_id)) x.step_id = null; });
        drop(rows);
        return { status: 204, rows };
      }
      return denied;
    }
    if (table === 'rewards') {
      if (method === 'POST') {
        if (!only(HW_REWARD_INSERT)) return denied;
        if (!admin) return rls;
        const made = items.map((r) => {
          const t = foodStamp(db);
          const row = rewardRow(Object.assign({}, r, { title: cleanText(r.title, 60) || '', created_at: t, created_by: email, updated_at: t, updated_by: email }));
          const bad = rewardProblem(row);
          if (bad) throw bad;
          return row;
        });
        db.rewards.push(...made);
        return { status: 201, rows: made };
      }
      if (method === 'PATCH') {
        if (!only(HW_REWARD_INSERT.slice(1))) return denied;
        if (!admin) return { status: 200, rows: [] };
        const next = rows.map((r) => {
          const n = Object.assign({}, r, body, { updated_at: foodStamp(db), updated_by: email });
          if ('title' in body) n.title = cleanText(n.title, 60) || '';
          const bad = rewardProblem(n);
          if (bad) throw bad;
          return n;
        });
        rows.forEach((r, i) => Object.assign(r, next[i]));
        return { status: 200, rows };
      }
      if (method === 'DELETE') {
        if (!admin) return { status: 204, rows: [] };
        const ids = new Set(rows.map((r) => r.id));
        db.reward_asks.forEach((x) => { if (ids.has(x.reward_id)) x.reward_id = null; });
        drop(rows);
        return { status: 204, rows };
      }
      return denied;
    }
    return denied;   // steps, blocks, asks, points, tutor links and AI runs: no write grant
  } catch (e) {
    if (e instanceof Raise) return tableErr(e);
    throw e;
  }
}

// PostgREST's or=(…) and and(…) filters: comma-separated conditions, each column.op.value or a nested and(…)/or(…).
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
function matchLogic(row, list, any) {
  const parts = splitTop(String(list).replace(/^\(/, '').replace(/\)$/, '')).map((p) => {
    const m = /^(and|or)\((.*)\)$/.exec(p);
    if (m) return matchLogic(row, `(${m[2]})`, m[1] === 'or');
    const dot = p.indexOf('.');
    return matchFilter(row[p.slice(0, dot)], p.slice(dot + 1));
  });
  return any ? parts.some(Boolean) : parts.every(Boolean);
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
      if (path === '/functions/v1/hub-jobs' && body && body.action === 'school' && (db.school_feeds || db.schoolJob)) {
        const r = db.school_feeds ? schoolJob(db, emailFrom(req)) : { status: 503, body: { ok: false, stop: 'no_schema' } };
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
    const match = (row) => filters.every(([k, v]) => (k === 'or' ? matchLogic(row, v, true) : k === 'and' ? matchLogic(row, v, false) : matchFilter(row[k], v)));
    const wantsObject = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
    const out = (rows, status = 200) => {
      if (!wantsObject) return reply(status, rows);
      if (rows.length !== 1) return reply(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
      return reply(status, rows[0]);
    };
    // Schema 3's calendar tables, schema 4's food tables and schema 5's homework tables: their own
    // row-level security and grants (calendarTables, foodTables and homeworkTables above).
    const cal = calendarTables(db, table, method, body, member, db[table].filter(match))
      || foodTables(db, table, method, body, member, db[table].filter(match), { prefer: req.headers()['prefer'] || '' })
      || homeworkTables(db, table, method, body, member, db[table].filter(match))
      // 0006: members read school_feeds and school_items; only the functions write them (no grant).
      || (['school_feeds', 'school_items'].includes(table) && method !== 'GET'
        ? { status: 403, body: { code: '42501', message: `permission denied for table ${table}`, details: null, hint: null } } : null);
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
      // limit and offset (supabase-js's .range()), and Supabase's API "Max rows" (1,000 unless changed;
      // db.maxRows here): an answer is cut to it with no error, as PostgREST's db-max-rows does.
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = url.searchParams.get('limit');
      rows = rows.slice(offset, offset + Math.min(limit ? Number(limit) : Infinity, db.maxRows || 1000));
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


// ---- Schema 5 (supabase/migrations/0005_homework.sql, docs/v1.3-homework.md §3.4, §3.5): homework, the
// token side. homeworkTokenRpc has the functions My day (Jordan's link) and the tutor link (Pat's) call signed
// out, with the migration's rules, messages and shapes: homework_by_token, step_by_token, plan_by_token,
// focus_by_token, reward_by_token, assignment_by_token, homework_prefs_by_token (private.homework_view_kid's
// view, merged into every writer's own keys), and tutor_view_by_token, tutor_assignment_by_token,
// tutor_plan_by_token, tutor_step_by_token (private.homework_view_tutor's). personDayHomework(db, person,
// answer) adds get_person_day's homework key (private.homework_card). mock.js answers RPCs for members only,
// so a test routes these itself, as day.test.js does for the other token functions.
// withHomeworkTokens(db, { now }) adds the tables a schema-5 database has, only those not there yet (the
// Homework page's fakes make the same ones), and:
//   db.hwNow    the server's clock (ms; private.now()); move it with db.hwNow += 20 * 60e3
//   db.hwTimes  { <kid id>: [{ weekdays: [1, 2, 3, 4] (ISO, as add_homework_time), starts: '16:30', ends: '17:15' }] }:
//               his homework time (the events homework_times links), each day's first start to last end
//   db.hwBusy   { <kid id>: { 'YYYY-MM-DD': [{ starts, ends, title }] } }: his timed items (private.person_items)
//   db.hwPace   { ratio, steps } or null: private.homework_pace's answer, set by the test
// Free minutes (§5.3), placement (§5.4, with the steps' fixed and done flags), points (§8.1: whole 5-minute
// units seen, the on-time window around the first free minute, the daily cap on the block's start day, the
// weekly milestone cap) and the caps on writes (150 and 20 starts a day for his link, 200 for the tutor's)
// follow the migration. A refusal undoes the whole call, as a transaction does.
// Its names start with tk (the token side), apart from the Homework page's signed-in fakes; its rows (tkKidRow,
// tkLinkRow, tkAssignmentRow, tkStepRow, tkSessionRow, tkRewardRow, tkLedgerRow) have the tables' defaults.
// Schema 6 (0006): with withSchool(db), his view carries from_school and each assignment made from school its school
// marks (tkWithSchool), as Pat's does, the card a from_school count, and school_item_by_token is his New from school.
const TK_TABLES = ['homework_kids', 'homework_times', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions', 'rewards',
  'reward_asks', 'points_ledger', 'homework_use', 'ai_runs'];
const TK_WRITES = ['homework_kids', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions', 'rewards', 'reward_asks',
  'points_ledger', 'homework_use'];
function withHomeworkTokens(db, opts) {
  const o = opts || {};
  TK_TABLES.forEach((t) => { if (!db[t]) db[t] = []; });
  if (!db.household) db.household = [{ id: true, tz: 'America/New_York' }];
  db.hwNow = o.now ? Date.parse(o.now) : db.hwNow || Date.parse('2026-11-02T21:31:04.512Z');
  db.hwTimes = db.hwTimes || {};
  db.hwBusy = db.hwBusy || {};
  if (db.hwPace === undefined) db.hwPace = null;
  return db;
}
// Rows with the tables' defaults.
const tkKidRow = (o) => Object.assign({
  kid_id: null, active: true, points_on: true, focus_minutes: 20, cue: null, if_stuck: null, pts_focus: 1, pts_on_time: 5,
  pts_milestone: 20, pts_day_cap: 20, pts_milestone_week: 80, created_at: now(), created_by: null, updated_at: now(), updated_by: null,
}, o);
const tkLinkRow = (o) => Object.assign({
  id: uuid(), kid_id: null, token: crypto.randomBytes(16).toString('hex'), label: 'Pat Lee, tutor', language: 'en', active: true,
  expires_on: '2027-04-30', can_ai: true, last_used_at: null, created_at: now(), created_by: null, updated_at: now(), updated_by: null,
}, o);
const tkAssignmentRow = (o) => Object.assign({
  id: uuid(), kid_id: null, kind: 'assignment', added_by: 'family', title: '', subject: null, due_date: null, details: null, stretch: null,
  status: 'open', done_at: null, dropped_at: null, given_at: null, given_by: null, plan_rev: 0, ai_state: null, ai_stop: null, ai_draft: null, ai_prev: null,
  ai_at: null, created_at: now(), created_by: null, updated_at: now(), updated_by: null,
}, o);
const tkStepRow = (o) => Object.assign({
  id: uuid(), assignment_id: null, pos: 1, kind: 'step', title: '', done_looks_like: null, minutes: 20, day: null, moved_from: null,
  source: 'typed', done_at: null, done_by: null, checked_at: null, checked_by: null, not_yet_at: null, coach_note: null,
  coach_note_by: null, coach_note_at: null, question: null, question_at: null, answer: null, answer_by: null, answer_at: null,
  qa_log: [], updated_at: now(), updated_by: null,
}, o);
const tkSessionRow = (o) => Object.assign({
  id: uuid(), kid_id: null, assignment_id: null, step_id: null, minutes: 20, with_whom: 'alone', started_at: null, ends_at: null,
  ended_at: null, result: null, seen_minutes: null, on_time: false, points: 0, note: null,
}, o);
const tkRewardRow = (o) => Object.assign({
  id: uuid(), kid_id: null, title: '', cost: null, active: true, suggested: false, sort_order: 0,
  created_at: now(), created_by: null, updated_at: now(), updated_by: null,
}, o);
const tkLedgerRow = (o) => Object.assign({
  id: uuid(), kid_id: null, at: now(), day: null, kind: 'given', delta: 0, session_id: null, step_id: null, ask_id: null, void_of: null,
  note: null, who: 'alex@example.com',
}, o);

// ---- Dates and the clock
const tkAdd = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const tkBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const tkIsoWeekday = (iso) => { const w = new Date(`${iso}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
const tkMonday = (iso) => tkAdd(iso, 1 - tkIsoWeekday(iso));
const tkMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const tkHHMM = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const tkStamp = (ms) => fromMicros(Math.round(ms) * 1000);
const tkMs = (ts) => (ts == null ? NaN : micros(ts) / 1000);
const tkLocal = (db, ms) => localOf(ms, foodTz(db));
const tkToday = (db) => tkLocal(db, db.hwNow).date;
const tkAsOf = (db) => { const l = tkLocal(db, db.hwNow); return `${l.date}T${l.time}`; };
const tkServerNow = (db) => new Date(db.hwNow).toISOString();
const tkDayOf = (db, ts) => tkLocal(db, tkMs(ts)).date;
const tkClean = (text, max) => { const s = cleanText(text, max); return s ? s : null; };
const tkLen = (s) => (s == null ? 0 : Array.from(String(s)).length);

// ---- Who calls
function tkShortName(db, p) {
  const first = String(p.name).split(' ')[0];
  return (db.people || []).some((x) => x.id !== p.id && x.active !== false && String(x.name).split(' ')[0] === first) ? p.name : first;
}
const tkKidOf = (db, id) => (db.homework_kids || []).find((k) => k.kid_id === id) || null;
// private.homework_kid_by_token: a kid's active My day link with homework on, else null.
function tkKidByToken(db, token) {
  const me = byTokenFood(db, token);
  if (!me || me.role !== 'kid') return null;
  const k = tkKidOf(db, me.id);
  return k && k.active ? me : null;
}
// private.tutor_link_by_token: an active link not past its end date, whose kid is active with homework on.
function tkLinkByToken(db, token) {
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  const l = (db.tutor_links || []).find((x) => x.token === token);
  if (!l || !l.active || l.expires_on < tkToday(db)) return null;
  const kid = activePerson(db, l.kid_id);
  const k = tkKidOf(db, l.kid_id);
  if (!kid || kid.role !== 'kid' || !k || !k.active) return null;
  if (!l.last_used_at || db.hwNow - tkMs(l.last_used_at) > 60000) l.last_used_at = tkStamp(db.hwNow);
  return l;
}
const tkRoleOf = (by) => (by == null ? null : / \(tutor link\)$/.test(by) ? 'tutor' : / \(My day\)$/.test(by) ? 'kid' : 'family');
// private.count_homework: one more for today, past the day's cap P0001.
function tkCount(db, actor, what, max) {
  const day = tkToday(db);
  db.homework_use = db.homework_use.filter((r) => r.day >= tkAdd(day, -1));
  let r = db.homework_use.find((x) => x.actor_id === actor && x.day === day && x.what === what);
  if (!r) { r = { actor_id: actor, day, what, n: 0 }; db.homework_use.push(r); }
  r.n += 1;
  if (r.n > max) throw new Raise('P0001', "That's a lot for one day.");
}

// ---- Free minutes (private.free_minutes) and placement (private.place_steps)
// Each day from `from` to `to` (at most 56) with homework time: { day, starts, ends, window_minutes, free, planned, busy,
// first_free }. planned: the minutes of not-done steps that day in the kid's other open assignments (all but except).
function tkFree(db, kid, from, to, except) {
  const out = [];
  const wins = (db.hwTimes || {})[kid] || [];
  const last = tkAdd(from, 55) < to ? tkAdd(from, 55) : to;
  for (let d = from; d <= last; d = tkAdd(d, 1)) {
    const ws = wins.filter((w) => w.weekdays.includes(tkIsoWeekday(d)));
    if (!ws.length) continue;
    const s = Math.min(...ws.map((w) => tkMin(w.starts)));
    const e = Math.min(s + 240, Math.max(...ws.map((w) => tkMin(w.ends))));
    const taken = new Array(e - s).fill(false);
    const busy = [];
    (((db.hwBusy || {})[kid] || {})[d] || []).forEach((b) => {
      const bs = tkMin(b.starts);
      const be = Number.isFinite(tkMin(b.ends)) ? tkMin(b.ends) : bs + 60;
      if (be <= s || bs >= e) return;
      busy.push({ starts: b.starts, ends: b.ends || tkHHMM(bs + 60), title: b.title });
      const until = be > s && be < e ? be + 15 : be;
      for (let m = Math.max(bs, s); m < Math.min(until, e); m++) taken[m - s] = true;
    });
    const firstFree = taken.indexOf(false);
    const planned = (db.homework_steps || []).filter((st) => {
      const a = db.assignments.find((x) => x.id === st.assignment_id);
      return a && a.kid_id === kid && a.status === 'open' && a.id !== except && st.done_at == null && st.day === d;
    }).reduce((n, st) => n + st.minutes, 0);
    out.push({ day: d, starts: `${tkHHMM(s)}:00`, ends: `${tkHHMM(e)}:00`, window_minutes: e - s, free: taken.filter((x) => !x).length,
      planned, busy, first_free: firstFree < 0 ? null : `${tkHHMM(s + firstFree)}:00` });
  }
  return out;
}
// The last work day (§5.4): a lesson's do-by day; the day before the due date, two days before when it is 7 or
// more days away; today for one due today or past.
function tkLastDay(db, a) {
  const today = tkToday(db);
  if (a.kind === 'lesson') return a.due_date > today ? a.due_date : today;
  if (tkBetween(today, a.due_date) >= 7) return tkAdd(a.due_date, -2);
  if (a.due_date > today) return tkAdd(a.due_date, -1);
  return today;
}
const tkEnded = (db, row) => !row || tkMin(tkLocal(db, db.hwNow).time) >= tkMin(row.ends);
// steps: [{ id?, kind, minutes, day, done, fixed }] → { steps, fits, over, horizon } or { fits: false, no_time: true }.
function tkPlace(db, kid, a, steps) {
  const today = tkToday(db);
  const fm = tkFree(db, kid, today, tkAdd(today, 55), a.id);
  if (!fm.length) return { steps, fits: false, no_time: true };
  const lo = tkEnded(db, fm.find((f) => f.day === today)) ? tkAdd(today, 1) : today;
  let hi = tkLastDay(db, a);
  const horizon = hi > tkAdd(today, 55) ? tkAdd(today, 55) : null;
  if (horizon) hi = horizon;
  if (hi < lo) hi = lo;
  const room = new Map(fm.map((f) => [f.day, f.free - f.planned]));
  const roomOf = (d) => (room.has(d) ? room.get(d) : -Infinity);
  let prev = lo;
  let over = 0;
  const out = steps.map((x) => Object.assign({}, x));
  out.forEach((s) => {
    if (s.done || (s.fixed && s.day)) {
      if (!s.done && room.has(s.day)) room.set(s.day, roomOf(s.day) - s.minutes);
      if (s.day > prev && s.day <= hi) prev = s.day;
      return;
    }
    if (s.kind === 'turn_in') { s.day = a.due_date < today ? today : a.due_date; return; }
    let day = null;
    for (let d = prev; !day && d <= hi; d = tkAdd(d, 1)) if (roomOf(d) >= s.minutes) day = d;
    if (!day) {
      let most = -Infinity;
      for (let d = prev; d <= hi; d = tkAdd(d, 1)) if (roomOf(d) > most) { most = roomOf(d); day = d; }
      if (!day) day = prev;
      over += s.minutes - Math.max(most, 0);
    }
    room.set(day, roomOf(day) - s.minutes);
    s.day = day;
    prev = day;
  });
  return { steps: out, fits: over === 0, over, horizon };
}

// ---- Points (private.award, private.points_balance)
function tkAward(db, kid, kind, delta, day, o) {
  const k = tkKidOf(db, kid);
  const x = o || {};
  if (!k || !k.points_on || !(delta > 0)) return 0;
  const led = db.points_ledger.filter((l) => l.kid_id === kid);
  if (kind === 'focus' && led.some((l) => l.kind === 'focus' && l.session_id === x.session)) return 0;
  if (kind === 'on_time' && led.some((l) => l.kind === 'on_time' && l.day === day)) return 0;
  if (kind === 'milestone' && led.some((l) => l.kind === 'milestone' && l.step_id === x.step)) return 0;
  let n = delta;
  if (kind === 'focus' || kind === 'on_time') {
    const used = led.filter((l) => (l.kind === 'focus' || l.kind === 'on_time') && l.day === day).reduce((s, l) => s + l.delta, 0);
    n = Math.min(n, k.pts_day_cap - used);
  } else if (kind === 'milestone') {
    const mon = tkMonday(day);
    const used = led.filter((l) => l.kind === 'milestone' && l.day >= mon && l.day <= tkAdd(mon, 6)).reduce((s, l) => s + l.delta, 0);
    n = Math.min(n, k.pts_milestone_week - used);
  }
  if (n <= 0) return 0;
  db.points_ledger.push(tkLedgerRow({ kid_id: kid, at: tkStamp(db.hwNow), day, kind, delta: n, session_id: x.session || null,
    step_id: x.step || null, note: x.note || null, who: x.who }));
  return n;
}
function tkBalance(db, kid) {
  const balance = db.points_ledger.filter((l) => l.kid_id === kid).reduce((s, l) => s + l.delta, 0);
  const held = db.reward_asks.filter((q) => q.kid_id === kid && q.status === 'waiting').reduce((s, q) => s + q.cost, 0);
  return { balance, held };
}

// ---- Jordan's view (private.homework_view_kid) and the card (private.homework_card)
const tkStepsOf = (db, aid) => db.homework_steps.filter((s) => s.assignment_id === aid).sort((x, y) => (x.pos - y.pos) || (x.id < y.id ? -1 : 1));
function tkViewKid(db, kid) {
  const k = tkKidOf(db, kid);
  const me = (db.people || []).find((p) => p.id === kid);
  if (!k || !me) return null;
  const lang = me.language === 'es' ? 'es' : 'en';
  const who = `${tkShortName(db, me)} (My day)`;
  const today = tkToday(db);
  const nowMs = db.hwNow;
  const fm = tkFree(db, kid, today, tkAdd(today, 55), null);
  const win = fm.find((f) => f.day === today) || null;
  const first = win && !tkEnded(db, win) ? today : tkAdd(today, 1);
  const byDue = (x, y) => (x.due_date < y.due_date ? -1 : x.due_date > y.due_date ? 1 : x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id < y.id ? -1 : 1);
  const recent = (a) => a.status === 'open' || (a.status === 'done' && nowMs - tkMs(a.done_at) <= 3 * 86400000);
  const given = db.assignments.filter((a) => a.kid_id === kid && a.given_at && recent(a)).sort(byDue);
  const steps = [];
  given.forEach((a) => tkStepsOf(db, a.id).forEach((st) => steps.push({
    id: st.id, assignment_id: st.assignment_id, assignment: a.title, kind: st.kind, title: st.title, done_looks_like: st.done_looks_like,
    minutes: st.minutes, day: st.day, from_day: st.day < today ? st.day : null, moved: st.moved_from != null, done: st.done_at != null,
    undo: st.done_at != null && st.checked_at == null && st.done_by === who && nowMs - tkMs(st.done_at) <= 15 * 60000,
    checked: st.checked_at != null,
    waiting: st.kind === 'milestone' && st.done_at != null && st.checked_at == null && k.points_on ? k.pts_milestone : null,
    not_yet: st.not_yet_at != null, coach: st.coach_note ? { by: st.coach_note_by, text: st.coach_note } : null,
    question: st.question, answer: st.answer, _open: st.done_at == null && a.status === 'open',
  })));
  const bare = (x) => { const c = Object.assign({}, x); delete c._open; return c; };
  const tonight = steps.filter((x) => x.day === today && (x.done || x._open));
  const earlier = win ? steps.filter((x) => x.day < today && x._open).sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0)) : [];
  const nowStep = tonight.find((x) => x._open) || earlier[0] || null;
  const { balance, held } = tkBalance(db, kid);
  const list = db.assignments.filter((a) => a.kid_id === kid && (recent(a) || (a.status === 'dropped' && nowMs - tkMs(a.updated_at) <= 3 * 86400000)))
    .sort((x, y) => ((x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1)) || byDue(x, y));
  const assignments = list.map((a) => {
    const own = tkStepsOf(db, a.id);
    const open = own.filter((s) => s.done_at == null);
    const last = tkLastDay(db, a);
    const mile = (s) => ({ title: s.title, day: s.day });
    const passed = open.find((m) => m.kind === 'milestone' && (m.day < today || open.some((y) => y.kind !== 'milestone' && y.pos < m.pos && y.day > m.day)));
    const late = open.filter((s) => s.day < today).length;
    const mine = (d) => (a.status === 'open' ? open.filter((s) => s.day === d).reduce((n, s) => n + s.minutes, 0) : 0);
    return {
      id: a.id, kind: a.kind, title: a.title, subject: a.subject, due_date: a.due_date, status: a.status,
      state: a.given_at ? 'given' : a.ai_state === 'running' || a.ai_draft || own.length ? 'planning' : 'none',
      plan_rev: a.plan_rev, added_by: a.added_by, given_by: tkRoleOf(a.given_by), ai_help: own.some((s) => s.source === 'ai'),
      stretch: a.stretch,
      behind: a.given_at && a.status === 'open' && (late > 0 || passed) ? { steps: late, milestone: passed ? mile(passed) : null } : null,
      minutes_left: open.reduce((n, s) => n + s.minutes, 0),
      time_left: fm.filter((f) => f.day >= first && f.day <= (last < tkAdd(today, 55) ? last : tkAdd(today, 55)))
        .reduce((n, f) => n + Math.max(f.free - (f.planned - mine(f.day)), 0), 0),
      horizon: last > tkAdd(today, 55) ? tkAdd(today, 55) : null, no_time: fm.length === 0,
      next_milestone: (open.find((s) => s.kind === 'milestone') && mile(open.find((s) => s.kind === 'milestone'))) || null,
      steps: a.given_at ? steps.filter((x) => x.assignment_id === a.id).map(bare) : [],
    };
  });
  const open = db.focus_sessions.find((f) => f.kid_id === kid && f.ended_at == null) || null;
  const titleOf = (f) => { const s = db.homework_steps.find((x) => x.id === f.step_id); const a = db.assignments.find((x) => x.id === f.assignment_id); return (s && s.title) || (a && a.title) || null; };
  const startedToday = db.focus_sessions.some((f) => f.kid_id === kid && (f.step_id || f.assignment_id) && tkDayOf(db, f.started_at) === today);
  const ledger = db.points_ledger.filter((l) => l.kid_id === kid);
  const mon = tkMonday(today);
  const focusedIn = (a, b) => db.focus_sessions.filter((f) => f.kid_id === kid && f.ended_at && tkDayOf(db, f.started_at) >= a && tkDayOf(db, f.started_at) <= b)
    .reduce((n, f) => n + (f.seen_minutes || 0), 0);
  return tkWithSchool(db, kid, {
    language: lang, as_of: tkAsOf(db), today, server_now: tkServerNow(db),
    me: { first_name: String(me.name).split(' ')[0], tutor: tkTutorWord(db, kid), cue: k.cue, if_stuck: k.if_stuck, length: k.focus_minutes,
      lengths: [10, 15, 20, 25], points_on: k.points_on },
    window: win ? { starts: win.starts.slice(0, 5), ends: win.ends.slice(0, 5) } : null,
    on_time: k.points_on && win && win.first_free ? { from: tkHHMM(tkMin(win.first_free) - 30), until: tkHHMM(tkMin(win.first_free) + 10),
      done: startedToday, points: k.pts_on_time } : null,
    session: open ? { id: open.id, step_id: open.step_id, assignment_id: open.assignment_id, title: titleOf(open), minutes: open.minutes,
      started_at: open.started_at, ends_at: open.ends_at, with: open.with_whom } : null,
    now: nowStep ? bare(nowStep) : null,
    tonight: tonight.map(bare),
    load: { planned: tonight.filter((x) => x._open).reduce((n, x) => n + x.minutes, 0), free: win ? win.free : 0 },
    earlier: earlier.map(bare),
    assignments,
    points: k.points_on ? { balance, held, today: ledger.filter((l) => l.day === today && l.delta > 0).reduce((n, l) => n + l.delta, 0),
      capped: ledger.filter((l) => l.day === today && (l.kind === 'focus' || l.kind === 'on_time')).reduce((n, l) => n + l.delta, 0) >= k.pts_day_cap } : null,
    rewards: k.points_on ? db.rewards.filter((r) => r.kid_id === kid && r.active && r.cost != null)
      .sort((x, y) => (x.sort_order - y.sort_order) || (x.cost - y.cost) || x.title.localeCompare(y.title))
      .map((r) => ({ id: r.id, title: r.title, cost: r.cost,
        can_ask: balance - held >= r.cost && db.reward_asks.filter((q) => q.kid_id === kid && q.status === 'waiting').length < 3
          && !db.reward_asks.some((q) => q.kid_id === kid && q.reward_id === r.id && q.status === 'waiting') })) : null,
    asks: k.points_on ? db.reward_asks.filter((q) => q.kid_id === kid && (q.status === 'waiting'
      || (['approved', 'declined'].includes(q.status) && nowMs - tkMs(q.decided_at) <= 7 * 86400000)))
      .sort((x, y) => tkMs(y.asked_at) - tkMs(x.asked_at))
      .map((q) => ({ id: q.id, reward_id: q.reward_id, title: q.title, cost: q.cost, status: q.status, asked_at: q.asked_at, decided_at: q.decided_at, note: q.note })) : null,
    recent: k.points_on ? ledger.slice().sort((x, y) => tkMs(y.at) - tkMs(x.at)).slice(0, 10).map((l) => ({ day: l.day, kind: l.kind, delta: l.delta, note: l.note })) : null,
    pace: db.hwPace || null,
    week: { focused: focusedIn(mon, tkAdd(mon, 6)), last_week: focusedIn(tkAdd(mon, -7), tkAdd(mon, -1)) },
  });
}
// 0006's wrappers of his view and Pat's (private.homework_view_kid, homework_view_tutor; docs/v1.3-homework.md §12.4):
// the school's marks ({gone, moved_to}) on each assignment made from school, and his from_school once he has a checked
// Assignments link (scNew). Without withSchool, 0005's views as they were.
function tkWithSchool(db, kid, v) {
  if (!db.school_feeds || !v) return v;
  const m = scMarks(db, kid);
  const mark = (a) => (a && m[a.id] ? Object.assign({}, a, { school: m[a.id] }) : a);
  if (Object.keys(m).length && Array.isArray(v.assignments)) v.assignments = v.assignments.map(mark);
  if (Object.keys(m).length && v.assignment && typeof v.assignment === 'object') v.assignment = mark(v.assignment);
  const n = 'me' in v ? scNew(db, kid, tkToday(db)) : null;
  if (n) v.from_school = n;
  return v;
}
// The first word of his active tutor link's label ("Pat"), or null.
function tkTutorWord(db, kid) {
  const l = (db.tutor_links || []).filter((x) => x.kid_id === kid && x.active && x.expires_on >= tkToday(db))
    .sort((x, y) => (x.created_at < y.created_at ? -1 : 1))[0];
  return l ? String(l.label).split(',')[0].trim().split(' ')[0] || null : null;
}
function tkCard(db, kid) {
  const v = tkViewKid(db, kid);
  if (!v) return null;
  const card = {
    next: v.now ? { id: v.now.id, title: v.now.title, assignment: v.now.assignment, minutes: v.now.minutes } : null,
    length: v.me.length,
    steps: v.tonight.filter((x) => !x.done).length,
    minutes: v.tonight.filter((x) => !x.done).reduce((n, x) => n + x.minutes, 0),
  };
  if (v.window && v.earlier.length) card.earlier = v.earlier.length;
  if (v.window) card.window = v.window;
  if (v.session) card.session = { ends_in_s: Math.max(0, Math.ceil((tkMs(v.session.ends_at) - db.hwNow) / 1000)) };
  if (v.points) card.points = v.points.balance;
  if (v.from_school && v.from_school.length) card.from_school = v.from_school.length;   // 0006: how many are new from school
  return card;
}
// get_person_day's v1.3 key (§3.4): only for a kid with an active homework_kids row.
function personDayHomework(db, person, answer) {
  const k = person && person.role === 'kid' ? tkKidOf(db, person.id) : null;
  if (k && k.active) {
    const card = tkCard(db, person.id);
    if (card) answer.homework = card;
  }
  return answer;
}

// ---- One step (private.step_act): his ('kid') and the link's ('tutor') actions
function tkStepAct(db, stepId, action, text, day, key, role, who) {
  const ACTIONS = { kid: ['done', 'undo', 'not_today', 'ask', 'smaller'], tutor: ['check', 'not_yet', 'uncheck', 'answer'] };
  if (!ACTIONS[role].includes(action)) throw new Raise('22023', "That isn't something you can do to a step.");
  const s = db.homework_steps.find((x) => x.id === stepId);
  const a = s && db.assignments.find((x) => x.id === s.assignment_id);
  if (!s || !a) throw new Raise('42501', "That step isn't on your plan.");
  const k = tkKidOf(db, a.kid_id);
  const today = tkToday(db);
  const at = tkStamp(db.hwNow);
  const coach = role === 'tutor' ? 'tutor' : 'family';
  let changed = false;
  let out = {};
  let add = [];
  const keepNote = () => { if (s.coach_note) add = [{ note: s.coach_note, at: s.coach_note_at, by: s.coach_note_by }]; };
  if (action === 'done') {
    if (s.done_at == null) {
      keepNote();
      Object.assign(s, { done_at: at, done_by: who, not_yet_at: null, coach_note: null, coach_note_by: null, coach_note_at: null });
      changed = true;
    }
  } else if (action === 'undo') {
    if (s.done_at != null) {
      if (s.checked_at != null || (role === 'kid' && (s.done_by !== who || db.hwNow - tkMs(s.done_at) > 15 * 60000))) {
        throw new Raise('42501', 'Only your own tick can be undone, for 15 minutes.');
      }
      Object.assign(s, { done_at: null, done_by: null });
      changed = true;
    }
  } else if (action === 'not_today') {
    if (!['start', 'step', 'check'].includes(s.kind)) throw new Raise('42501', "That's a checkpoint. Change it with Pat.");
    if (!day) throw new Raise('22023', 'Say which day the step was on.');
    if (s.done_at == null && s.day === day) {
      const last = tkLastDay(db, a);
      const ownOn = (d) => db.homework_steps.filter((x) => x.assignment_id === a.id && x.done_at == null && x.day === d && x.id !== s.id).reduce((n, x) => n + x.minutes, 0);
      const f = tkFree(db, a.kid_id, tkAdd(today, 1), last, a.id).find((r) => r.free - r.planned - ownOn(r.day) >= s.minutes);
      if (!f) {
        if (!tkFree(db, a.kid_id, today, tkAdd(today, 55), null).length) throw new Raise('22023', 'Set a homework time first.');
        throw new Raise('P0001', "No homework day before it's due has room. Re-plan, make it smaller, or ask Pat.");
      }
      Object.assign(s, { moved_from: s.day, day: f.day });
      changed = true;
    }
  } else if (action === 'ask') {
    const q = tkClean(text, 200);
    if (!q) throw new Raise('22023', 'Type your question.');
    if (s.question !== q || s.answer != null) {
      if (s.question != null) {
        add = [{ question: s.question, asked_at: s.question_at, answer: s.answer, answered_at: s.answer_at,
          by: s.answer_by == null ? null : tkRoleOf(s.answer_by) === 'tutor' ? 'tutor' : 'family' }];
      }
      Object.assign(s, { question: q, question_at: at, answer: null, answer_by: null, answer_at: null });
      changed = true;
    }
  } else if (action === 'smaller') {
    const title = tkClean(text, 200);
    if (!title || tkLen(title) < 3 || tkLen(title) > 80) throw new Raise('22023', "A step's title is 3 to 80 characters.");
    if (!key) throw new Raise('22023', 'A new step needs its id.');
    const there = db.homework_steps.find((x) => x.id === key);
    if (there && there.assignment_id !== a.id) throw new Raise('42501', "That step isn't on your plan.");
    if (!there) {
      if (db.homework_steps.filter((x) => x.assignment_id === a.id).length >= 20) throw new Raise('22023', 'At most 20 steps.');
      db.homework_steps.forEach((x) => { if (x.assignment_id === a.id && x.pos >= s.pos) x.pos += 1; });
      let d = s.day > today ? s.day : today;
      if (a.kind === 'assignment' && a.due_date > today && d >= a.due_date) d = tkAdd(a.due_date, -1);
      db.homework_steps.push(tkStepRow({ id: key, assignment_id: a.id, pos: s.pos - 1, kind: 'step', title, minutes: 10, day: d, source: 'typed', updated_at: at, updated_by: who }));
      db.focus_sessions.forEach((f) => { if (f.kid_id === a.kid_id && f.step_id === s.id && f.ended_at == null) Object.assign(f, { step_id: key, assignment_id: a.id }); });
      changed = true;
    }
    out = { new_step_id: key };
  } else if (action === 'check') {
    if (s.kind !== 'milestone') throw new Raise('22023', 'Only a milestone is checked.');
    out = { paid: 0, used_up: false };
    if (s.checked_at == null) {
      const note = tkClean(text, 160);
      keepNote();
      Object.assign(s, { done_at: s.done_at || at, done_by: s.done_by || who, checked_at: at, checked_by: who, not_yet_at: null,
        coach_note: note, coach_note_by: note ? coach : null, coach_note_at: note ? at : null });
      const paid = tkAward(db, a.kid_id, 'milestone', k.pts_milestone, today, { step: s.id, note: s.title, who });
      out = { paid, used_up: k.points_on && k.pts_milestone > 0 && paid < k.pts_milestone };
      changed = true;
    }
  } else if (action === 'not_yet') {
    if (s.kind !== 'milestone') throw new Raise('22023', 'Only a milestone is checked.');
    const note = tkClean(text, 160);
    if (!note) throw new Raise('22023', "Say what's missing.");
    if (s.checked_at != null) throw new Raise('42501', 'That milestone is checked: take the check back first.');
    if (s.done_at != null) {
      keepNote();
      Object.assign(s, { done_at: null, done_by: null, not_yet_at: at, coach_note: note, coach_note_by: coach, coach_note_at: at });
      changed = true;
    } else if (!(s.not_yet_at && s.coach_note === note)) throw new Raise('22023', 'Not yet is for a ticked milestone.');
  } else if (action === 'uncheck') {
    if (s.checked_at != null) {
      if (s.checked_by !== who || db.hwNow - tkMs(s.checked_at) > 15 * 60000) throw new Raise('42501', 'Only the one who checked it can take it back, for 15 minutes.');
      const paid = db.points_ledger.filter((l) => l.step_id === s.id && l.kind === 'milestone').map((l) => l.id);
      const net = db.points_ledger.filter((l) => paid.includes(l.id) || (l.kind === 'void' && paid.includes(l.void_of))).reduce((n, l) => n + l.delta, 0);
      const kid = db.assignments.find((x) => x.id === s.assignment_id).kid_id;
      if (tkBalance(db, kid).balance - net < 0) throw new Raise('P0001', 'Those points are already spent.');   // never below zero, as void_points
      db.points_ledger = db.points_ledger.filter((l) => !paid.includes(l.id) && !(l.kind === 'void' && paid.includes(l.void_of)));
      Object.assign(s, { checked_at: null, checked_by: null });
      changed = true;
    }
  } else if (action === 'answer') {
    const ans = tkClean(text, 200);
    if (!ans) throw new Raise('22023', 'Type the answer.');
    if (s.question == null) throw new Raise('22023', "There's no question to answer.");
    if (s.answer !== ans) {
      if (s.answer != null) {
        if (s.answer_by !== who || db.hwNow - tkMs(s.answer_at) > 15 * 60000) throw new Raise('42501', 'Only your own answer can be changed, for 15 minutes.');
        add = [{ question: s.question, asked_at: s.question_at, answer: s.answer, answered_at: s.answer_at, by: coach, replaced_at: at }];
      }
      Object.assign(s, { answer: ans, answer_by: who, answer_at: s.answer_at || at });
      changed = true;
    }
  }
  if (changed) {
    s.qa_log = (s.qa_log || []).concat(add).slice(-10);
    Object.assign(s, { updated_at: at, updated_by: who });
    a.plan_rev += 1;
    a.updated_by = who;
    const allDone = !db.homework_steps.some((x) => x.assignment_id === a.id && x.done_at == null);
    if ((action === 'done' || action === 'check') && a.status === 'open' && (s.kind === 'turn_in' || allDone)) Object.assign(a, { status: 'done', done_at: at });
    else if ((action === 'undo' || action === 'not_yet') && a.status === 'done') Object.assign(a, { status: 'open', done_at: null });
  }
  return Object.assign(out, { step_id: s.id, _changed: changed });
}

// ---- A plan saved (private.plan_save): his ('kid', p_steps null is Re-plan) and the link's ('tutor')
function tkPlanSave(db, a, list, give, rev, role, who) {
  const kid = role === 'kid';
  const today = tkToday(db);
  if (rev == null || rev !== a.plan_rev) throw new Raise('P0001', 'This plan was changed since you opened it.');
  if (a.status !== 'open') throw new Raise('P0001', 'This assignment is done or dropped. Open it again first.');
  if (kid && !a.given_at) throw new Raise('42501', 'Plan this one with Pat.');
  if (list == null && !kid) throw new Raise('22023', "Send the plan's steps.");
  const k = tkKidOf(db, a.kid_id);
  const old = tkStepsOf(db, a.id);
  const input = list == null
    ? old.map((s) => ({ id: s.id, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like, minutes: s.minutes,
      day: s.done_at || ['milestone', 'turn_in'].includes(s.kind) ? s.day : null, source: s.source }))
    : list;
  if (!Array.isArray(input) || input.length > 20) throw new Raise('22023', 'At most 20 steps.');
  const out = [];
  const ids = new Set();
  input.forEach((e) => {
    const title = tkClean(e.title, 200);
    if (!['start', 'step', 'milestone', 'check', 'turn_in'].includes(e.kind)) throw new Raise('22023', 'Pick a kind for this step.');
    if (!title || tkLen(title) < 3 || tkLen(title) > 80) throw new Raise('22023', "A step's title is 3 to 80 characters.");
    if (!Number.isInteger(e.minutes) || e.minutes < 5 || e.minutes > 60) throw new Raise('22023', 'A step takes 5 to 60 minutes.');
    if (e.id != null && ids.has(e.id)) throw new Raise('22023', 'The same step is in the plan twice.');
    const o = e.id != null ? old.find((s) => s.id === e.id) : null;
    if (e.id != null && !o) throw new Raise(kid ? '42501' : '22023', kid ? "That step isn't on your plan." : "That step isn't in this plan.");
    if (o) ids.add(o.id);
    if (o && o.done_at) { out.push({ id: o.id, kind: o.kind, title: o.title, done_looks_like: o.done_looks_like, minutes: o.minutes, day: o.day, source: o.source, done: true, fixed: true }); return; }
    const dll = tkClean(e.done_looks_like, 160);
    const lock = (x) => x && ['milestone', 'turn_in'].includes(x.kind);
    if (kid && o && (lock(o) || lock(e)) && (e.kind !== o.kind || title !== o.title || dll !== o.done_looks_like || e.minutes !== o.minutes || (e.day || null) !== o.day)) {
      throw new Raise('42501', "That's a checkpoint. Change it with Pat.");
    }
    if (kid && !o && lock(e)) throw new Raise('42501', "That's a checkpoint. Change it with Pat.");
    const moved = e.day != null && (!o || e.day !== o.day);
    const edited = !o || e.kind !== o.kind || title !== o.title || dll !== o.done_looks_like || e.minutes !== o.minutes || moved;
    const source = o ? (edited ? 'typed' : o.source) : e.source || 'typed';
    const minutes = !o && source === 'template' ? (e.kind === 'turn_in' ? 5 : Math.min(e.minutes, Math.max(k.focus_minutes, 5))) : e.minutes;
    if (moved && e.day < today) throw new Raise('22023', "A step can't go in the past.");
    if (moved && e.kind !== 'turn_in' && a.kind === 'assignment' && a.due_date > today && e.day >= a.due_date) throw new Raise('22023', 'Only the turn-in goes on the due date.');
    out.push({ id: o ? o.id : null, kind: e.kind, title, done_looks_like: dll, minutes, day: e.day || null, source, done: false, fixed: e.day != null });
  });
  old.filter((s) => !ids.has(s.id)).forEach((s) => {
    if (s.done_at) out.push({ id: s.id, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like, minutes: s.minutes, day: s.day, source: s.source, done: true, fixed: true });
    else if (kid && ['milestone', 'turn_in'].includes(s.kind)) throw new Raise('42501', "That's a checkpoint. Change it with Pat.");
  });
  if (out.length > 20) throw new Raise('22023', 'At most 20 steps.');
  if (out.filter((s) => s.kind === 'milestone').length > 4) throw new Raise('22023', 'At most 4 milestones.');
  const placed = tkPlace(db, a.kid_id, a, out);
  if (placed.no_time && out.some((s) => !s.day)) throw new Raise('22023', 'Set a homework time first.');
  const final = placed.no_time ? out : placed.steps;
  const at = tkStamp(db.hwNow);
  db.homework_steps = db.homework_steps.filter((s) => s.assignment_id !== a.id || s.done_at != null || ids.has(s.id));
  final.forEach((e, i) => {
    const s = e.id ? db.homework_steps.find((x) => x.id === e.id) : null;
    if (!s) db.homework_steps.push(tkStepRow({ assignment_id: a.id, pos: i + 1, kind: e.kind, title: e.title, done_looks_like: e.done_looks_like, minutes: e.minutes, day: e.day, source: e.source, updated_at: at, updated_by: who }));
    else if (e.done) s.pos = i + 1;
    else Object.assign(s, { pos: i + 1, kind: e.kind, title: e.title, done_looks_like: e.done_looks_like, minutes: e.minutes, day: e.day, source: e.source, updated_at: at, updated_by: who });
  });
  a.plan_rev += 1;
  if (give && !kid && !a.given_at) Object.assign(a, { given_at: at, given_by: who });
  a.updated_by = who;
  const steps = tkStepsOf(db, a.id);
  const left = steps.filter((s) => !s.done_at).reduce((n, s) => n + s.minutes, 0);
  const fm = tkFree(db, a.kid_id, today, tkAdd(today, 55), a.id);
  const first = tkEnded(db, fm.find((f) => f.day === today)) ? tkAdd(today, 1) : today;
  const lastDay = tkLastDay(db, a);
  const time = fm.filter((f) => f.day >= first && f.day <= lastDay).reduce((n, f) => n + Math.max(f.free - f.planned, 0), 0);
  const over = Math.max(placed.over || 0, left - time, 0);
  const open = steps.filter((s) => !s.done_at);
  return { plan: {
    assignment_id: a.id, plan_rev: a.plan_rev,
    steps: steps.map((s) => ({ id: s.id, pos: s.pos, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like, minutes: s.minutes, day: s.day, source: s.source, done: s.done_at != null })),
    fits: !placed.no_time && over === 0, over, horizon: placed.horizon || null, minutes_left: left, time_left: time, no_time: !!placed.no_time,
    talk: open.filter((m) => m.kind === 'milestone' && (m.day < today || open.some((y) => y.kind !== 'milestone' && y.pos < m.pos && y.day > m.day)))
      .map((m) => ({ title: m.title, day: m.day })),
  } };
}

// ---- A focus block (private.focus_act)
function tkFocusAct(db, kid, action, id, minutes, stepId, asgId, withWhom, result, note) {
  const k = tkKidOf(db, kid);
  const me = (db.people || []).find((p) => p.id === kid);
  const who = `${tkShortName(db, me)} (My day)`;
  const today = tkToday(db);
  const at = tkStamp(db.hwNow);
  const w = withWhom || 'alone';
  if (!['start', 'switch', 'end'].includes(action)) throw new Raise('22023', 'Choose start, switch or end.');
  if (!id) throw new Raise('22023', 'A block needs its id.');
  let f = db.focus_sessions.find((x) => x.id === id);
  if (f && f.kid_id !== kid) throw new Raise('42501', "That block isn't yours.");
  let changed = false;
  const stepOfHis = (sid) => {
    const s = db.homework_steps.find((x) => x.id === sid);
    const a = s && db.assignments.find((x) => x.id === s.assignment_id);
    return s && a && a.kid_id === kid && a.given_at && a.status === 'open' && s.done_at == null ? s : null;
  };
  if (action === 'start') {
    if (!f) {
      if (![10, 15, 20, 25].includes(minutes)) throw new Raise('22023', 'Choose 10, 15, 20 or 25 minutes.');
      if (!['alone', 'tutor', 'parent'].includes(w)) throw new Raise('22023', 'Choose alone, with your tutor or with a parent.');
      let aid = null;
      if (stepId) {
        const s = stepOfHis(stepId);
        if (!s) throw new Raise('42501', "That step isn't on your plan.");
        aid = s.assignment_id;
      } else if (asgId) {
        const a = db.assignments.find((x) => x.id === asgId && x.kid_id === kid && x.status === 'open');
        if (!a) throw new Raise('42501', "That assignment isn't on your list.");
        aid = a.id;
      }
      const open = db.focus_sessions.find((x) => x.kid_id === kid && x.ended_at == null);
      if (open) {
        if (db.hwNow - tkMs(open.started_at) < 24 * 3600000) throw new Raise('P0001', 'Finish the block you started first.');
        Object.assign(open, { ended_at: at, result: 'expired', seen_minutes: 0 });
      }
      let onTime = false;
      if (aid) {
        const row = tkFree(db, kid, today, today, null)[0];
        const ff = row && row.first_free ? tkMin(row.first_free) : NaN;
        const nowMin = tkMin(tkLocal(db, db.hwNow).time);
        onTime = Number.isFinite(ff)
          && !db.focus_sessions.some((x) => x.kid_id === kid && (x.step_id || x.assignment_id) && tkDayOf(db, x.started_at) === today)
          && !db.points_ledger.some((l) => l.kid_id === kid && l.kind === 'on_time' && l.day === today)
          && nowMin >= ff - 30 && nowMin <= ff + 10;
      }
      f = tkSessionRow({ id, kid_id: kid, assignment_id: aid, step_id: stepId || null, minutes, with_whom: w, started_at: at,
        ends_at: tkStamp(db.hwNow + minutes * 60000), on_time: onTime });
      db.focus_sessions.push(f);
      changed = true;
    }
  } else if (action === 'switch') {
    if (!f) throw new Raise('42501', "That block isn't yours.");
    if (f.ended_at == null && f.step_id !== stepId) {
      const s = stepOfHis(stepId);
      if (!s) throw new Raise('42501', "That step isn't on your plan.");
      Object.assign(f, { step_id: s.id, assignment_id: s.assignment_id });
      changed = true;
    }
  } else {
    if (!f) throw new Raise('42501', "That block isn't yours.");
    if (f.ended_at == null) {
      if (!['done', 'more', 'stopped'].includes(result)) throw new Raise('22023', 'Choose step done, more to do or stop.');
      const seen = Math.max(0, Math.min(Math.floor((db.hwNow - tkMs(f.started_at)) / 60000), f.minutes));
      const day = tkDayOf(db, f.started_at);
      Object.assign(f, { ended_at: at, result, seen_minutes: seen, note: tkClean(note, 120) });
      if (result === 'done') {
        if (f.step_id) tkStepAct(db, f.step_id, 'done', null, null, null, 'kid', who);
        else if (f.assignment_id) {
          const a = db.assignments.find((x) => x.id === f.assignment_id);
          if (a && a.status === 'open' && !db.homework_steps.some((s) => s.assignment_id === a.id)) Object.assign(a, { status: 'done', done_at: at, updated_by: who });
        }
      }
      if ((f.step_id || f.assignment_id) && db.hwNow - tkMs(f.started_at) <= 24 * 3600000) {
        const s = db.homework_steps.find((x) => x.id === f.step_id);
        const a = db.assignments.find((x) => x.id === f.assignment_id);
        const title = (s && s.title) || (a && a.title) || null;
        tkAward(db, kid, 'focus', k.pts_focus * Math.floor(seen / 5), day, { session: f.id, step: f.step_id, note: title, who });
        if (f.on_time && seen >= 8) tkAward(db, kid, 'on_time', k.pts_on_time, day, { session: f.id, step: f.step_id, note: title, who });
        f.points = db.points_ledger.filter((l) => l.session_id === f.id && (l.kind === 'focus' || l.kind === 'on_time')).reduce((n, l) => n + l.delta, 0);
      }
      changed = true;
    }
  }
  const sum = (kind) => db.points_ledger.filter((l) => l.session_id === f.id && l.kind === kind).reduce((n, l) => n + l.delta, 0);
  const day = tkDayOf(db, f.started_at);
  return {
    block: { id: f.id, step_id: f.step_id, assignment_id: f.assignment_id, minutes: f.minutes, with: f.with_whom, started_at: f.started_at,
      ends_at: f.ends_at, ended_at: f.ended_at, result: f.result, seen_minutes: f.seen_minutes, on_time: f.on_time, points: f.points },
    earned: { focus: sum('focus'), on_time: sum('on_time'),
      capped: k.points_on && f.ended_at != null && db.points_ledger.filter((l) => l.kid_id === kid && (l.kind === 'focus' || l.kind === 'on_time') && l.day === day)
        .reduce((n, l) => n + l.delta, 0) >= k.pts_day_cap },
    _changed: changed,
  };
}

// ---- Pat's view (private.homework_view_tutor)
function tkViewTutor(db, link, aid, part) {
  const kid = link.kid_id;
  const me = (db.people || []).find((p) => p.id === kid);
  const today = tkToday(db);
  const nowMs = db.hwNow;
  const a1 = aid ? db.assignments.find((x) => x.id === aid && x.kid_id === kid) : null;
  if (part === 'ai') return { assignment: a1 ? { id: a1.id, plan_rev: a1.plan_rev, ai: null } : null };
  const fm = tkFree(db, kid, today, tkAdd(today, 55), null);
  const first = fm.some((f) => f.day === today && !tkEnded(db, f)) ? today : tkAdd(today, 1);
  const byDue = (x, y) => (x.due_date < y.due_date ? -1 : x.due_date > y.due_date ? 1 : x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id < y.id ? -1 : 1);
  const asg = db.assignments.filter((a) => a.kid_id === kid && (a.status === 'open' || (a.status === 'done' && nowMs - tkMs(a.done_at) <= 30 * 86400000)
    || (a.status === 'dropped' && nowMs - tkMs(a.updated_at) <= 30 * 86400000)));
  const stepsOf = (a) => tkStepsOf(db, a.id);
  const all = [];
  asg.forEach((a) => stepsOf(a).forEach((s) => all.push({ s, a })));
  const plannedOn = (d, except) => db.homework_steps.filter((s) => {
    const a = db.assignments.find((x) => x.id === s.assignment_id);
    return a && a.kid_id === kid && a.status === 'open' && a.id !== except && s.done_at == null && s.day === d;
  }).reduce((n, s) => n + s.minutes, 0);
  const timeLeft = (a) => {
    const last = tkLastDay(db, a);
    return fm.filter((f) => f.day >= first && f.day <= (last < tkAdd(today, 55) ? last : tkAdd(today, 55)))
      .reduce((n, f) => n + Math.max(f.free - plannedOn(f.day, a.status === 'open' ? a.id : null), 0), 0);
  };
  const state = (a) => (a.given_at ? 'given' : a.ai_state === 'running' || a.ai_draft || stepsOf(a).length ? 'planning' : 'none');
  const passed = (a, m) => m.kind === 'milestone' && m.done_at == null
    && (m.day < today || stepsOf(a).some((y) => y.done_at == null && y.kind !== 'milestone' && y.pos < m.pos && y.day > m.day));
  const sessions = db.focus_sessions.filter((f) => f.kid_id === kid && f.ended_at && f.result !== 'expired' && (f.step_id || f.assignment_id)
    && tkDayOf(db, f.started_at) >= tkAdd(today, -13) && tkDayOf(db, f.started_at) <= today).sort((x, y) => tkMs(x.started_at) - tkMs(y.started_at));
  const days = [...new Set(sessions.map((f) => tkDayOf(db, f.started_at)))].sort().reverse();
  const out = {
    language: link.language, as_of: tkAsOf(db), today, server_now: tkServerNow(db), tutor: link.label, kid: String(me.name).split(' ')[0],
    ends_on: link.expires_on, ai: null,
    pace: db.hwPace || null,
    to_check: all.filter(({ s }) => s.kind === 'milestone' && s.done_at && !s.checked_at).sort((x, y) => tkMs(x.s.done_at) - tkMs(y.s.done_at))
      .map(({ s, a }) => ({ step_id: s.id, assignment: a.title, title: s.title, done_looks_like: s.done_looks_like, day: s.day, done_day: tkDayOf(db, s.done_at) })),
    to_talk_about: all.filter(({ s, a }) => a.status === 'open' && a.given_at && passed(a, s))
      .map(({ s, a }) => ({ assignment_id: a.id, title: a.title, milestone: s.title, planned_day: s.day })),
    questions: all.filter(({ s }) => s.question && (!s.answer || nowMs - tkMs(s.answer_at) <= 7 * 86400000))
      .sort((x, y) => ((x.s.answer ? 1 : 0) - (y.s.answer ? 1 : 0)) || (tkMs(x.s.question_at) - tkMs(y.s.question_at)))
      .map(({ s, a }) => ({ step_id: s.id, assignment: a.title, title: s.title, question: s.question, question_at: s.question_at, answer: s.answer })),
    plans: asg.filter((a) => a.status === 'open' && !a.given_at && (a.ai_state || a.ai_draft || stepsOf(a).length)).sort(byDue)
      .map((a) => ({ assignment_id: a.id, title: a.title, state: stepsOf(a).length ? 'planning' : 'none', ai_state: a.ai_state })),
    assignments: asg.slice().sort((x, y) => ((x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1)) || byDue(x, y)).map((a) => {
      const st = stepsOf(a);
      const last = tkLastDay(db, a);
      const m = st.find((s) => s.kind === 'milestone' && !s.done_at);
      return { id: a.id, kind: a.kind, title: a.title, subject: a.subject, due_date: a.due_date, status: a.status, state: state(a),
        added_by: a.added_by, given_by: tkRoleOf(a.given_by), minutes_left: st.filter((s) => !s.done_at).reduce((n, s) => n + s.minutes, 0),
        time_left: timeLeft(a), horizon: last > tkAdd(today, 55) ? tkAdd(today, 55) : null, no_time: fm.length === 0,
        steps_done: st.filter((s) => s.done_at).length, steps: st.length, next_milestone: m ? { title: m.title, day: m.day } : null };
    }),
    week: Array.from({ length: 14 }, (v, i) => {
      const d = tkAdd(today, i);
      const f = fm.find((x) => x.day === d);
      return { day: d, window: f ? { starts: f.starts.slice(0, 5), ends: f.ends.slice(0, 5) } : null,
        busy: f ? f.busy.map((b) => ({ starts: b.starts, ends: b.ends })) : [], free: f ? f.free : 0, planned: plannedOn(d, null) };
    }),
    record: days.map((d) => {
      const fs2 = sessions.filter((f) => tkDayOf(db, f.started_at) === d);
      return { day: d, focused: fs2.reduce((n, f) => n + (f.seen_minutes || 0), 0), sessions: fs2.map((f) => {
        const s = db.homework_steps.find((x) => x.id === f.step_id);
        const a = db.assignments.find((x) => x.id === f.assignment_id);
        return { minutes: f.minutes, with_tutor: f.with_whom === 'tutor', result: f.result, step: (s && s.title) || (a && a.title) || null, note: f.note };
      }) };
    }),
  };
  if (aid) {
    let detail = null;
    if (a1) {
      const st = stepsOf(a1);
      const ml = st.filter((s) => !s.done_at).reduce((n, s) => n + s.minutes, 0);
      const tl = timeLeft(a1);
      const last = tkLastDay(db, a1);
      detail = {
        id: a1.id, kind: a1.kind, title: a1.title, subject: a1.subject, due_date: a1.due_date, details: a1.details, stretch: a1.stretch,
        status: a1.status, plan_rev: a1.plan_rev, given_at: a1.given_at, given_by: tkRoleOf(a1.given_by),
        steps: st.map((s) => ({ id: s.id, pos: s.pos, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like, minutes: s.minutes, day: s.day,
          source: s.source, done: !!s.done_at, done_by: tkRoleOf(s.done_by), checked: !!s.checked_at,
          coach: s.coach_note ? { by: s.coach_note_by, text: s.coach_note } : null, moved_from: s.moved_from, question: s.question, answer: s.answer,
          qa_log: (s.qa_log || []).map((x) => { const c = Object.assign({}, x); delete c.answered_by; delete c.cleared_by; return c; }) })),
        ai: null, preview: null, fits: fm.length > 0 && ml <= tl, over: Math.max(ml - tl, 0), horizon: last > tkAdd(today, 55) ? tkAdd(today, 55) : null,
      };
    }
    out.assignment = detail;
  }
  return tkWithSchool(db, kid, out);
}

// ---- The functions: PostgREST finds one by the names sent (every one known, every one without a default sent).
function tkCall(name, args, defaults, run) {
  return (db, b) => {
    const sent = Object.keys(b || {});
    if (!db.homework_kids || sent.some((k) => !args.includes(k) && !defaults.includes(k)) || args.some((k) => !sent.includes(k))) {
      return { __status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${name}(${sent.sort().join(', ')}) in the schema cache`, details: null, hint: null } };
    }
    const saved = JSON.stringify(TK_WRITES.map((t) => db[t]));
    const tick = db.hwNow;
    try {
      const out = run(db, b);
      return out === undefined ? null : JSON.parse(JSON.stringify(out));
    } catch (e) {
      if (!(e instanceof Raise)) throw e;
      JSON.parse(saved).forEach((rows, i) => { db[TK_WRITES[i]] = rows; });
      db.hwNow = tick;
      return raised(e, true);
    }
  };
}
const tkTooLong = () => new Raise('22023', "That's too long.");
const tkKidWho = (db, me) => `${tkShortName(db, me)} (My day)`;
const tkSchoolItem = tkCall('school_item_by_token', ['p_token', 'p_item', 'p_action'], ['p_minutes'], (db, b) => {
  const me = tkKidByToken(db, b.p_token);
  if (!me) return null;
  if (!['quick', 'with_tutor', 'hide'].includes(b.p_action)) throw new Raise('22023', 'Choose quick, with_tutor or hide.');
  if (b.p_action === 'quick' && !(Number.isInteger(b.p_minutes) && b.p_minutes >= 5 && b.p_minutes <= 60)) throw new Raise('22023', 'A step is 5 to 60 minutes.');
  const i = db.school_items.find((x) => x.id === b.p_item);
  const f = i && scFeed(db, i.feed_id);
  if (!f || f.kid_id !== me.id || f.kind !== 'assignments' || !f.checked || i.gone_at || (i.made_at && !i.assignment_id)) {
    throw new Raise('42501', "That isn't on your list from school.");
  }
  let aid = null;
  let changed = false;
  if (b.p_action === 'hide') {
    if (i.made_at) throw new Raise('P0001', 'That one is on your homework already.');
    if (!i.hidden) { i.hidden = true; changed = true; }
  } else {
    if (!i.made_at) changed = true;
    aid = scAssignment(db, i, tkKidWho(db, me), tkStamp(db.hwNow));
    if (b.p_action === 'quick') {
      const r = homeworkTokenRpc.assignment_by_token(db, { p_token: b.p_token, p_action: 'quick', p_assignment: aid, p_minutes: b.p_minutes });
      if (r && r.__status) throw new Raise(r.body.code, r.body.message);
      return r;
    }
  }
  if (changed) tkCount(db, me.id, 'writes', 150);
  return Object.assign({ assignment_id: aid }, tkViewKid(db, me.id));
});
const homeworkTokenRpc = {
  homework_by_token: tkCall('homework_by_token', ['p_token'], [], (db, b) => {
    const me = tkKidByToken(db, b.p_token);
    return me ? tkViewKid(db, me.id) : null;
  }),
  step_by_token: tkCall('step_by_token', ['p_token', 'p_step', 'p_action'], ['p_text', 'p_day', 'p_key'], (db, b) => {
    const me = tkKidByToken(db, b.p_token);
    if (!me) return null;
    if (tkLen(b.p_text) > (b.p_action === 'smaller' ? 80 : 200)) throw tkTooLong();
    const s = db.homework_steps.find((x) => x.id === b.p_step);
    const a = s && db.assignments.find((x) => x.id === s.assignment_id);
    if (!a || a.kid_id !== me.id || !a.given_at) throw new Raise('42501', "That step isn't on your plan.");
    const r = tkStepAct(db, b.p_step, b.p_action, b.p_text, b.p_day, b.p_key, 'kid', tkKidWho(db, me));
    if (r._changed) tkCount(db, me.id, 'writes', 150);
    delete r._changed;
    return Object.assign(r, tkViewKid(db, me.id));
  }),
  plan_by_token: tkCall('plan_by_token', ['p_token', 'p_assignment', 'p_steps', 'p_rev'], [], (db, b) => {
    const me = tkKidByToken(db, b.p_token);
    if (!me) return null;
    if (b.p_steps != null && JSON.stringify(b.p_steps).length > 20000) throw new Raise('22023', 'That plan is too long.');
    const a = db.assignments.find((x) => x.id === b.p_assignment && x.kid_id === me.id);
    if (!a) throw new Raise('42501', "That plan isn't on your list.");
    const r = tkPlanSave(db, a, b.p_steps, false, b.p_rev, 'kid', tkKidWho(db, me));
    tkCount(db, me.id, 'writes', 150);
    return Object.assign(r, tkViewKid(db, me.id));
  }),
  focus_by_token: tkCall('focus_by_token', ['p_token', 'p_action', 'p_session'], ['p_minutes', 'p_step', 'p_assignment', 'p_with', 'p_result', 'p_note'], (db, b) => {
    const me = tkKidByToken(db, b.p_token);
    if (!me) return null;
    if (tkLen(b.p_note) > 120) throw tkTooLong();
    const r = tkFocusAct(db, me.id, b.p_action, b.p_session, b.p_minutes, b.p_step, b.p_assignment, b.p_with, b.p_result, b.p_note);
    if (r._changed) tkCount(db, me.id, b.p_action === 'start' ? 'starts' : 'writes', b.p_action === 'start' ? 20 : 150);
    delete r._changed;
    return Object.assign(r, tkViewKid(db, me.id));
  }),
  reward_by_token: tkCall('reward_by_token', ['p_token', 'p_action'], ['p_reward', 'p_text', 'p_key'], (db, b) => {
    const me = tkKidByToken(db, b.p_token);
    if (!me) return null;
    const who = tkKidWho(db, me);
    if (!['ask', 'cancel', 'suggest'].includes(b.p_action)) throw new Raise('22023', 'Choose ask, cancel or suggest.');
    if (tkLen(b.p_text) > 60) throw tkTooLong();
    if (!tkKidOf(db, me.id).points_on) throw new Raise('42501', 'Points are off.');
    let changed = false;
    if (b.p_action === 'ask') {
      if (!b.p_key) throw new Raise('22023', 'An ask needs its id.');
      const q = db.reward_asks.find((x) => x.id === b.p_key);
      if (q && q.kid_id !== me.id) throw new Raise('42501', "That reward isn't on your list.");
      if (!q) {
        const r = db.rewards.find((x) => x.id === b.p_reward && x.kid_id === me.id && x.active && x.cost != null);
        if (!r) throw new Raise('42501', "That reward isn't on your list.");
        if (!db.reward_asks.some((x) => x.kid_id === me.id && x.reward_id === r.id && x.status === 'waiting')) {
          if (db.reward_asks.filter((x) => x.kid_id === me.id && x.status === 'waiting').length >= 3) throw new Raise('P0001', 'Three asks are waiting already. Wait for a parent first.');
          const { balance, held } = tkBalance(db, me.id);
          if (balance - held < r.cost) throw new Raise('42501', 'Not enough points yet.');
          db.reward_asks.push({ id: b.p_key, kid_id: me.id, reward_id: r.id, title: r.title, cost: r.cost, status: 'waiting', asked_at: tkStamp(db.hwNow), decided_at: null, decided_by: null, note: null });
          changed = true;
        }
      }
    } else if (b.p_action === 'cancel') {
      const q = db.reward_asks.filter((x) => (b.p_key ? x.id === b.p_key : x.reward_id === b.p_reward && x.kid_id === me.id && x.status === 'waiting'))[0];
      if (!q || q.kid_id !== me.id) throw new Raise('42501', "That ask isn't yours.");
      if (q.status === 'waiting') { Object.assign(q, { status: 'cancelled', decided_at: tkStamp(db.hwNow), decided_by: who }); changed = true; }
    } else {
      const title = tkClean(b.p_text, 60);
      if (!title) throw new Raise('22023', 'Type the reward.');
      if (!b.p_key) throw new Raise('22023', 'A suggestion needs its id.');
      const r = db.rewards.find((x) => x.id === b.p_key);
      if (r && (r.kid_id !== me.id || !r.suggested)) throw new Raise('42501', "That reward isn't on your list.");
      if (!r) {
        if (db.rewards.filter((x) => x.kid_id === me.id && x.suggested && x.cost == null).length >= 5) throw new Raise('P0001', 'Five suggestions are waiting already. Wait for a parent first.');
        db.rewards.push(tkRewardRow({ id: b.p_key, kid_id: me.id, title, cost: null, active: false, suggested: true, created_by: who, updated_by: who }));
        changed = true;
      }
    }
    if (changed) tkCount(db, me.id, 'writes', 150);
    return tkViewKid(db, me.id);
  }),
  assignment_by_token: tkCall('assignment_by_token', ['p_token', 'p_action', 'p_assignment'], ['p_title', 'p_subject', 'p_due_date', 'p_minutes'], (db, b) => {
    const me = tkKidByToken(db, b.p_token);
    if (!me) return null;
    const who = tkKidWho(db, me);
    const today = tkToday(db);
    const quick = b.p_action === 'quick' || (b.p_action === 'add' && b.p_minutes != null);
    if (!['add', 'quick', 'drop'].includes(b.p_action)) throw new Raise('22023', 'Choose add, quick or drop.');
    if (tkLen(b.p_title) > 120 || tkLen(b.p_subject) > 40) throw tkTooLong();
    if (quick && !(b.p_minutes >= 5 && b.p_minutes <= 60)) throw new Raise('22023', 'A step is 5 to 60 minutes.');
    if (!b.p_assignment) throw new Raise('22023', 'Homework needs its id.');
    let a = db.assignments.find((x) => x.id === b.p_assignment);
    if (a && a.kid_id !== me.id) throw new Raise('42501', "That assignment isn't on your list.");
    let changed = false;
    if (b.p_action === 'add' && !a) {
      const title = tkClean(b.p_title, 120);
      if (!title) throw new Raise('22023', 'Type what the homework is.');
      if (!b.p_due_date || b.p_due_date < today || b.p_due_date > tkAdd(today, 60)) throw new Raise('22023', 'Choose a due date from today to 60 days ahead.');
      if (db.assignments.filter((x) => x.kid_id === me.id && x.added_by === 'kid' && x.status === 'open').length >= 15) throw new Raise('P0001', 'Fifteen of your own are open already.');
      a = tkAssignmentRow({ id: b.p_assignment, kid_id: me.id, added_by: 'kid', title, subject: tkClean(b.p_subject, 40), due_date: b.p_due_date, created_by: who, updated_by: who });
      db.assignments.push(a);
      changed = true;
    } else if (!a) throw new Raise('42501', "That assignment isn't on your list.");
    if (quick) {
      const own = db.homework_steps.filter((s) => s.assignment_id === a.id);
      if (a.status === 'open' && a.given_by === who && own.length === 1) {
        // his Quick, done already (a resend)
      } else if (a.status !== 'open' || a.given_at || tkBetween(today, a.due_date) > 3 || own.length) {
        throw new Raise('42501', 'Plan this one with Pat.');
      } else {
        const placed = tkPlace(db, me.id, a, [{ kind: 'step', minutes: b.p_minutes, day: null }]);
        if (placed.no_time && b.p_action === 'quick') throw new Raise('22023', 'Set a homework time first.');
        if (!placed.no_time) {   // 'add' with no homework time at all: his homework is kept, with no plan
          const at = tkStamp(db.hwNow);
          db.homework_steps.push(tkStepRow({ assignment_id: a.id, pos: 1, kind: 'step', title: tkLen(a.title) >= 3 ? Array.from(a.title).slice(0, 80).join('') : `Homework: ${a.title}`,
            minutes: b.p_minutes, day: placed.steps[0].day, source: 'typed', updated_at: at, updated_by: who }));
          Object.assign(a, { given_at: at, given_by: who, plan_rev: a.plan_rev + 1, updated_by: who });
          changed = true;
        }
      }
    } else if (b.p_action === 'drop') {
      if (a.added_by !== 'kid' || db.homework_steps.some((s) => s.assignment_id === a.id && s.done_at)) throw new Raise('42501', 'Only homework you added, with nothing ticked, can be dropped.');
      if (a.status !== 'dropped') { Object.assign(a, { status: 'dropped', dropped_at: tkStamp(db.hwNow), updated_by: who, updated_at: tkStamp(db.hwNow) }); changed = true; }
    }
    if (changed) tkCount(db, me.id, 'writes', 150);
    return Object.assign({ assignment_id: a.id }, tkViewKid(db, me.id));
  }),
  // 0006 (§11.4, §12.8): his New from school. 'quick' makes the item an assignment from school and goes through
  // assignment_by_token's own Quick (its refusals undo the whole call); 'with_tutor' makes it one with no plan; 'hide'.
  school_item_by_token: (db, b) => {
    if (!db.school_feeds) {
      return { __status: 404, body: { code: 'PGRST202', message: `Could not find the function public.school_item_by_token(${Object.keys(b || {}).sort().join(', ')}) in the schema cache`, details: null, hint: null } };
    }
    const saved = JSON.stringify(db.school_items);
    const out = tkSchoolItem(db, b);
    if (out && out.__status) db.school_items = JSON.parse(saved);
    return out;
  },
  homework_prefs_by_token: tkCall('homework_prefs_by_token', ['p_token', 'p_cue', 'p_if_stuck', 'p_minutes'], [], (db, b) => {
    const me = tkKidByToken(db, b.p_token);
    if (!me) return null;
    if (tkLen(b.p_cue) > 120 || tkLen(b.p_if_stuck) > 120) throw tkTooLong();
    if (b.p_minutes != null && ![10, 15, 20, 25].includes(b.p_minutes)) throw new Raise('22023', 'Choose 10, 15, 20 or 25 minutes.');
    const k = tkKidOf(db, me.id);
    const next = { cue: tkClean(b.p_cue, 120), if_stuck: tkClean(b.p_if_stuck, 120), focus_minutes: b.p_minutes == null ? k.focus_minutes : b.p_minutes };
    if (k.cue !== next.cue || k.if_stuck !== next.if_stuck || k.focus_minutes !== next.focus_minutes) {
      Object.assign(k, next, { updated_by: tkKidWho(db, me) });
      tkCount(db, me.id, 'writes', 150);
    }
    return tkViewKid(db, me.id);
  }),
  tutor_view_by_token: tkCall('tutor_view_by_token', ['p_token'], ['p_assignment', 'p_part'], (db, b) => {
    const l = tkLinkByToken(db, b.p_token);
    return l ? tkViewTutor(db, l, b.p_assignment || null, b.p_part === 'ai' ? 'ai' : 'all') : null;
  }),
  tutor_assignment_by_token: tkCall('tutor_assignment_by_token', ['p_token', 'p_fields'], [], (db, b) => {
    const l = tkLinkByToken(db, b.p_token);
    if (!l) return null;
    const f = b.p_fields;
    const who = `${l.label} (tutor link)`;
    if (!f || typeof f !== 'object' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(f.id || '')) throw new Raise('22023', 'An assignment needs its id.');
    if (tkLen(f.title) > 120 || tkLen(f.subject) > 40 || tkLen(f.details) > 4000 || tkLen(f.stretch) > 160) throw tkTooLong();
    if ('title' in f && !tkClean(f.title, 120)) throw new Raise('22023', 'An assignment needs a title and a due date.');   // on a change too
    let a = db.assignments.find((x) => x.id === f.id);
    if (a && a.kid_id !== l.kid_id) throw new Raise('42501', "That assignment isn't on this link.");
    const pick = (key, clean) => (key in f ? clean(f[key]) : a ? a[key] : null);
    if (!a) {
      if (!tkClean(f.title, 120) || !f.due_date) throw new Raise('22023', 'An assignment needs a title and a due date.');
      a = tkAssignmentRow({ id: f.id, kid_id: l.kid_id, kind: f.kind || 'assignment', added_by: 'tutor', title: tkClean(f.title, 120), subject: tkClean(f.subject, 40),
        due_date: f.due_date, details: f.details || null, stretch: tkClean(f.stretch, 160), status: f.status || 'open', created_by: who, updated_by: who });
      if (a.status === 'done') a.done_at = tkStamp(db.hwNow);
      if (a.status === 'dropped') a.dropped_at = tkStamp(db.hwNow);
      db.assignments.push(a);
    } else {
      Object.assign(a, { kind: pick('kind', (x) => x), title: pick('title', (x) => tkClean(x, 120)), subject: pick('subject', (x) => tkClean(x, 40)),
        due_date: f.due_date || a.due_date, details: pick('details', (x) => x || null), stretch: pick('stretch', (x) => tkClean(x, 160)),
        status: pick('status', (x) => x), updated_by: who, updated_at: tkStamp(db.hwNow) });
      if (a.status === 'done' && !a.done_at) a.done_at = tkStamp(db.hwNow);
      if (a.status !== 'done') a.done_at = null;
      if (a.status === 'dropped' && !a.dropped_at) a.dropped_at = tkStamp(db.hwNow);
      if (a.status !== 'dropped') a.dropped_at = null;
    }
    tkCount(db, l.id, 'writes', 200);
    return Object.assign({ assignment_id: a.id, moved: 0 }, tkViewTutor(db, l, a.id, 'all'));
  }),
  tutor_plan_by_token: tkCall('tutor_plan_by_token', ['p_token', 'p_assignment', 'p_steps', 'p_rev'], ['p_give'], (db, b) => {
    const l = tkLinkByToken(db, b.p_token);
    if (!l) return null;
    if (b.p_steps != null && JSON.stringify(b.p_steps).length > 20000) throw new Raise('22023', 'That plan is too long.');
    const a = db.assignments.find((x) => x.id === b.p_assignment && x.kid_id === l.kid_id);
    if (!a) throw new Raise('42501', "That assignment isn't on this link.");
    const r = tkPlanSave(db, a, b.p_steps, !!b.p_give, b.p_rev, 'tutor', `${l.label} (tutor link)`);
    tkCount(db, l.id, 'writes', 200);
    return Object.assign(r, tkViewTutor(db, l, a.id, 'all'));
  }),
  tutor_step_by_token: tkCall('tutor_step_by_token', ['p_token', 'p_step', 'p_action'], ['p_text'], (db, b) => {
    const l = tkLinkByToken(db, b.p_token);
    if (!l) return null;
    if (tkLen(b.p_text) > (b.p_action === 'answer' ? 200 : 160)) throw tkTooLong();
    const s = db.homework_steps.find((x) => x.id === b.p_step);
    const a = s && db.assignments.find((x) => x.id === s.assignment_id && x.kid_id === l.kid_id);
    if (!a) throw new Raise('42501', "That step isn't on this link.");
    const r = tkStepAct(db, b.p_step, b.p_action, b.p_text, null, null, 'tutor', `${l.label} (tutor link)`);
    if (r._changed) tkCount(db, l.id, 'writes', 200);
    delete r._changed;
    delete r.paid;
    return Object.assign(r, tkViewTutor(db, l, a.id, 'all'));
  }),
};

// Web Share for the Share buttons. Chromium on Linux has no navigator.share, so a page has none unless
// the test gives it this fake (before page.goto). Each call goes in window.__shares as { data, event }:
// event is the type of the event being handled when it was called ('click' when it's called from the
// tap itself, which a share needs; null after an await). window.__shareAnswer says how the next call ends:
// unset, it shares; otherwise it fails with an error of that name ('AbortError' when the person closes
// the share sheet, 'NotAllowedError', ...). While window.__shareHold is set, a share stays open (the
// sheet is up, the person still choosing) until window.__shareFinish() ends it as __shareAnswer says; a
// call while one is open fails with InvalidStateError, as Web Share has it (a double tap).
function stubShare(page) {
  return page.addInitScript(() => {
    window.__shares = [];
    let open = null;
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data) => {
        window.__shares.push({ data: JSON.parse(JSON.stringify(data)), event: window.event ? window.event.type : null });
        if (open) return Promise.reject(new DOMException('An earlier share has not yet completed.', 'InvalidStateError'));
        const end = () => { const name = window.__shareAnswer; if (name) throw new DOMException('The share did not happen', name); };
        if (!window.__shareHold) return new Promise((resolve) => resolve(end()));
        open = new Promise((resolve) => { window.__shareFinish = () => { open = null; resolve(); }; }).then(end);
        return open;
      },
    });
  });
}

module.exports = { makeDb, install, signIn, expectedConsoleError, SUPA, withCalendars, calendarRow, linkRow, googleEventRow, calendarRpc, md5uuid,
  withFood, mealRow, shopItem, foodRpc, personDayFood, foodStamp,
  withHomework, homeworkRpc, homePlan, hwKidRow, tutorLinkRow, assignmentRow, stepRow, sessionRow, rewardRow, askRow, ledgerRow,
  withHomeworkTokens, homeworkTokenRpc, personDayHomework, tkKidRow, tkLinkRow, tkAssignmentRow, tkStepRow, tkSessionRow, tkRewardRow, tkLedgerRow, stubShare,
  withSchool, schoolRpc, schoolFeedRow, schoolItemRow, schoolUrlOf };
