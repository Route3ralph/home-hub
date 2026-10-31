// Browser tests for My day (day.html?t=<token>), the public page for kids and helpers: what it loads
// (config.js and supabase-js only, no hub, no manifest, noindex and no-referrer), today / late / tomorrow
// in English and Spanish, ticking off with Undo, refreshes, links that don't work, the #confirm and #stop
// questions (nothing changes on load), the "Add to Home Screen" hint, phone width and dark mode; and (schema 3)
// a Google Calendar event (kind 'google'): no box to tick, an outlined dot, a hostile title shown as text.
//
// The fake RPCs answer with the shapes in supabase/migrations/0002_home_hub_v2.sql:
//   get_person_day(p_token) → { person: { name, language, digest_enabled, email_confirmed }, today,
//     days: [{ day, items }, { day, items }], late } or null; items have kind, item_id, occurrence, day,
//     end_day, title, all_day, start_time / end_time ('HH:MM'), time_label, location, contractor_name,
//     contractor_phone, note, who, status, mine (who: the other people on it, by first name, from the
//     person's side: "with Jordan" for the one in charge, "Pat" for someone along; null on a private item)
//   complete_by_token(p_token, p_task_id, p_occurrence) → uuid | null; undo_by_token(p_token, p_log_id) → uuid | null
//   confirm_digest(p_confirm) → boolean (the confirmation secret is the whole key); stop_digest(p_token) → boolean
// The confirmation email links to day.html?c=<secret>#confirm, with no My day token.
// v1.2 (docs/v1.2-kitchen.md §7, §8, §13), on a database with mock.js's withFood: get_person_day's
// days[i].meals and list keys (personDayFood), and the list's token functions (foodRpc, the
// migration's rules and shapes): get_list_by_token(p_token) → { language, as_of, can_add, items,
// bought, suggest? } or null; add_to_list_by_token(p_token, p_name) → { result, item_id, name } and
// the list; buy_item_by_token(p_token, p_item, p_bought, p_seen) → { changed, seen } and the list. Meal rows
// in English and Spanish; the list button only with `list`, and no list request without it; the list
// read and saved in the background after the day's own request; #list in Spanish at 390px (ticks in
// place, the Undo toast (Deshacer unticks the row where it is, under Comprado hoy too), Comprado hoy, Add again, the add box and its suggestions, Comprar otra vez,
// every new error word); the 10-second read only on #list; the outbox (not sent yet, the banner, a
// reload, retries, "changed on another phone", a line added again offline and ticked before the add is
// answered, Deshacer of a tick that found Alex's purchase, Deshacer of a tick waiting for "¿Añadir otra vez?"
// after a read past midnight); the saved list when Supabase gets no answer at the
// start; a null answer clearing what was saved.
// v1.3 (docs/v1.3-homework.md §7, §8, §9.6, §9.7, §14), with mock.js's homeworkTokenRpc (the migration's rules and
// shapes; db.hwNow is the server's clock): the card only with get_person_day's homework key (none for a helper,
// on schema 4, with homework off, or without plan.js) and its one-tap Start; #focus counted from the server's
// clock with the phone's a day off (8 minutes on, a hidden page back, a reload with the phone 5 hours off),
// Wake Lock, AudioContext and Notification asked for only inside a tap, the chime scheduled on the audio clock at
// Start, the cue for the first minute, Done then Keep going, the stuck sheet (Make it smaller moves the block),
// the end screen (the server's points, More to do, Stop, under 5 minutes, the daily cap), the break, Next; an End
// and a Start with no answer sent again with the same id; offline; #homework at 390px, 420px and 1280×800 (Now,
// Tonight, From earlier with Re-plan, Due soon with the bars, Behind the plan and the milestone line that opens
// Ask Pat, the who-sees line), tick and Undo, Not today, Quick and + Homework, his cue; #points (ask, cancel,
// suggest, decided, the last entries, points off); #plan/<id> in his role; every new word and database message
// in Spanish; no tutor link; homework off while open; hostile text; a phone where plan.js didn't load (the day as
// before, with no card). Then (18b) a second tap on an End on its way (one End, its screen drawn), the wake lock
// held while the ring runs on any view, taken again on coming back to any view after the browser let go of it
// while the page was hidden (HW_WAKE_DROP), and let go of at its end or for a Start with no block, the stuck sheet
// on a block with no plan (Quick and 'switch' first), Make it smaller sent twice (one key, one step), Chime even on
// silent ('playback' just for the chime) and the chime set again after time away on any view (#focus, #homework,
// the day), called off when the ring ran out meanwhile, and made at the first tap after a reload (HW_CLOCKED: an
// AudioContext on the page's clock that stands still while the page is hidden); "Pasado al mié".
// 0006 (schema 6, docs/v1.3-homework.md §11.4), with mock.js's withSchool: New from school on #homework (his view's
// from_school), after Due soon: a short list (five, the rest folded), each with Quick (his length, only for one due within
// 3 days), Plan with Pat and Hide in one tap (school_item_by_token); a refusal; one call for a double tap; the card's
// "New from school" line opening it; nothing from an unchecked link; the school's marks (moved, gone) under Due soon;
// the description never on his screen; Spanish; hostile text; none on schema 5.
// The timelines (no migration, docs/v1.3-homework.md §21), section 23: his path on #homework under Tonight (plans given to
// him due 4 or more days out or with a milestone, three then "+2 more"), each line, the links to #plan/<id> with the path at
// the top, drawn again from reads, no points, Spanish, 390px and 1280px light and dark (screenshots to TIMELINE_SHOTS).
// mock.js answers RPCs for signed-in members only, so the token functions (called signed out) are
// answered by a route added here; everything else (config.js, supabase-js) comes from mock.js.
// The browser runs in Pacific/Kiritimati (UTC+14) with its clock set so the device's date is a day
// ahead of the household's: anything using the device's date or zone shows the wrong day.
// Run alone with: node tests/e2e/day.test.js
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { makeDb, install, signIn, SUPA, withFood, foodRpc, personDayFood, shopItem, mealRow, withHomeworkTokens, homeworkTokenRpc: homeworkRpc,
  personDayHomework, tkKidRow: hwKidRow, tkLinkRow: tutorLinkRow, tkAssignmentRow: assignmentRow, tkStepRow: stepRow, tkSessionRow: sessionRow,
  tkRewardRow: rewardRow, tkLedgerRow: ledgerRow, withSchool, schoolFeedRow, schoolItemRow, withCoach } = require('./mock');
const { serve, ROOT } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A list change's body as sent, its key checked and set aside: every change carries its own key
// (p_key, a version 4 uuid), sent with every try; a missing or malformed one stays in, so a comparison fails.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyed = (body) => {
  const rest = Object.assign({}, body);
  const key = rest.p_key;
  delete rest.p_key;
  return UUID.test(key) ? rest : Object.assign(rest, { p_key: key === undefined ? 'missing' : key });
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };

// ---- Fixtures (fictional people only)
const TAYLOR = '0123456789abcdef0123456789abcdef';   // helper, English
const JORDAN = 'fedcba9876543210fedcba9876543210';   // kid, Spanish
const MORGAN = '00112233445566778899aabbccddeeff';   // kid, nothing planned, email confirmed, morning email off
const UNKNOWN = 'ffffffffffffffffffffffffffffffff';
const CONFIRM = 'c0ffee00c0ffee00c0ffee00c0ffee00';  // the code in Taylor's confirmation email
const ID = {
  walk: '11111111-1111-4111-8111-111111111111',
  feed: '22222222-2222-4222-8222-222222222222',
  recycle: '33333333-3333-4333-8333-333333333333',
  sweep: '44444444-4444-4444-8444-444444444444',
  gutters: '55555555-5555-4555-8555-555555555555',
  bed: '66666666-6666-4666-8666-666666666666',
  furnace: '77777777-7777-4777-8777-777777777777',
  piano: '88888888-8888-4888-8888-888888888888',
  holiday: '99999999-9999-4999-8999-999999999999',
  dentist: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  camping: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  jpiano: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const TODAY = '2026-10-25';      // a Sunday, in the household (America/New_York)
const TOMORROW = '2026-10-26';
const DEVICE_NOW = new Date('2026-10-25T14:00:00Z');   // 10:00 in New York; already Oct 26 in Kiritimati

// One My day item, exactly the keys private.my_day_item builds.
const item = (o) => {
  const it = Object.assign({
    kind: 'event', item_id: null, occurrence: TODAY, day: TODAY, end_day: null, title: '', all_day: false,
    start_time: null, end_time: null, time_label: null, location: null, contractor_name: null, contractor_phone: null,
    note: null, who: null, status: 'open', mine: false,
  }, o);
  if (!('end_day' in o)) it.end_day = it.day;
  return it;
};
const task = (o) => item(Object.assign({ kind: 'task', all_day: true, mine: true }, o));

function dayDb() {
  const db = makeDb();
  db.calls = [];
  db.logs = [];
  db.my = {
    [TAYLOR]: {
      person: { name: 'Taylor Example', language: 'en', digest_enabled: true, email_confirmed: false },
      days: [
        [
          task({ item_id: ID.walk, title: 'Walk the dogs', all_day: false, start_time: '08:00', time_label: '8:00am' }),
          item({ item_id: ID.furnace, title: 'Furnace check', start_time: '10:30', end_time: '11:30', time_label: '10:30am', contractor_name: 'Pat Lee', contractor_phone: '(201) 555-0100' }),
          item({ item_id: ID.piano, title: 'Piano pickup', start_time: '16:00', end_time: '17:00', time_label: '4:00pm', location: 'Music school' }),
          item({ item_id: ID.holiday, title: 'School holiday', all_day: true }),
          task({ item_id: ID.feed, title: '<b>Feed</b> & water the cat' }),
          task({ item_id: ID.recycle, title: 'Take out recycling', status: 'done' }),
          task({ item_id: ID.sweep, title: 'Sweep the porch', status: 'skipped' }),
        ],
        [
          item({ item_id: ID.dentist, occurrence: TOMORROW, day: TOMORROW, title: 'Dentist', start_time: '09:00', end_time: '10:00', time_label: '9:00am', location: 'Example Dental', who: 'with Jordan' }),
          item({ item_id: ID.camping, occurrence: TOMORROW, day: TOMORROW, end_day: '2026-10-28', title: 'Camping trip', all_day: true }),
        ],
      ],
      late: [task({ item_id: ID.gutters, occurrence: '2026-10-23', day: '2026-10-23', title: 'Clean the gutters', status: 'late' })],
    },
    [JORDAN]: {
      person: { name: 'Jordan Example', language: 'es', digest_enabled: true, email_confirmed: false },
      days: [
        [
          item({ item_id: ID.jpiano, title: 'Piano', start_time: '16:00', end_time: '17:00', time_label: '16:00', location: 'Escuela de música', who: 'Taylor' }),
          task({ item_id: ID.bed, title: 'Tender la cama' }),
        ],
        [],
      ],
      late: [],
    },
    [MORGAN]: {
      person: { name: 'Morgan Example', language: 'en', digest_enabled: false, email_confirmed: true },
      days: [[], []],
      late: [],
    },
  };
  db.confirmCodes = { [CONFIRM]: TAYLOR };   // the secret in Taylor's confirmation email
  return db;
}

// ---- v1.2: meals and the shopping list. The household's now is Sunday Oct 25, 10:00 in New York.
const P = { alex: 'p-alex', sam: 'p-sam', taylor: 'p-taylor', jordan: 'p-jordan', morgan: 'p-morgan' };
const FOOD_NOW = '2026-10-25T14:00:00Z';
const RECIPE = 'https://cooking.example.com/tacos?serves=4';
// The same people as db.my, as rows: Taylor is the helper (in Spanish unless lang says otherwise).
function foodDb(o) {
  const opts = o || {};
  const lang = opts.lang || 'es';
  const db = dayDb();
  db.my[TAYLOR].person.language = lang;
  db.household = [{ id: true, tz: 'America/New_York' }];
  db.people = [
    { id: P.alex, name: 'Alex Example', role: 'admin', language: 'en', email: 'alex@example.com', day_token: null, active: true },
    { id: P.sam, name: 'Sam Example', role: 'adult', language: 'en', email: 'sam@example.com', day_token: null, active: true },
    { id: P.taylor, name: 'Taylor Example', role: 'helper', language: lang, email: null, day_token: TAYLOR, active: true },
    { id: P.jordan, name: 'Jordan Example', role: 'kid', language: 'es', email: null, day_token: JORDAN, active: true },
    { id: P.morgan, name: 'Morgan Example', role: 'kid', language: 'en', email: null, day_token: MORGAN, active: true },
  ];
  return withFood(db, { now: FOOD_NOW, helperList: opts.helperList || 'add' });
}
// The list: four unlocked lines to buy, one locked; Huevos bought this morning by Alex (Comprado hoy);
// Arroz and Jabón bought lately (Comprar otra vez); Bagels bought too long ago; a locked bought line.
// Times keep their microseconds, as Postgres writes them.
function withList(db) {
  db.shopping_items.push(
    shopItem({ name: 'Cebollas', note: '3', aisle: 'produce', added_at: '2026-10-24T22:15:03.123456+00:00', added_by: P.alex }),
    shopItem({ name: 'Cilantro', aisle: 'produce', added_at: '2026-10-24T22:15:04.000001+00:00', added_by: P.alex }),
    shopItem({ name: 'Tortillas', aisle: 'bakery', added_at: '2026-10-24T22:16:00.500000+00:00', added_by: P.sam }),
    shopItem({ name: 'Milk', note: '2', aisle: 'dairy', added_at: '2026-10-25T12:01:02.654321+00:00', added_by: P.alex }),
    shopItem({ name: 'Pregnancy test', aisle: 'personal', private: true, added_at: '2026-10-25T12:30:00.000000+00:00', added_by: P.alex }),
    shopItem({ name: 'Huevos', aisle: 'dairy', added_at: '2026-10-23T12:00:00.000000+00:00', added_by: P.alex, bought_at: '2026-10-25T13:30:00.111111+00:00', bought_by: P.alex }),
    shopItem({ name: 'Arroz', aisle: 'pantry', added_at: '2026-10-20T12:00:00.000000+00:00', added_by: P.alex, bought_at: '2026-10-24T15:00:00.222222+00:00', bought_by: P.alex }),
    shopItem({ name: 'Jabón', aisle: 'household', added_at: '2026-10-18T12:00:00.000000+00:00', added_by: P.sam, bought_at: '2026-10-20T15:00:00.333333+00:00', bought_by: P.sam }),
    shopItem({ name: 'Bagels', aisle: 'bakery', added_at: '2026-08-30T12:00:00.000000+00:00', added_by: P.sam, bought_at: '2026-09-01T15:00:00.000000+00:00', bought_by: P.sam }),
    shopItem({ name: 'Vitamins', aisle: 'personal', private: true, added_at: '2026-10-24T12:00:00.000000+00:00', added_by: P.alex, bought_at: '2026-10-25T13:00:00.000000+00:00', bought_by: P.alex }),
  );
  return db;
}
const itemOf = (db, name) => db.shopping_items.find((r) => r.name === name);
const hashOf = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const clone = (o) => JSON.parse(JSON.stringify(o));
const fail = (status, code, message, hint) => ({ __status: status, body: { code, message, details: null, hint: hint || null } });
// v1.2's list writes, through foodRpc; db.listError refuses the next one with [status, code, message].
const listWrite = (name) => (db, b) => {
  if (db.listError) { const e = db.listError; db.listError = null; return fail(...e); }
  return foodRpc[name](db, b);
};
const findTask = (who, id) => {
  for (const [w, list] of [['today', who.days[0]], ['tomorrow', who.days[1]], ['late', who.late]]) {
    const i = list.findIndex((x) => x.kind === 'task' && x.item_id === id);
    if (i >= 0) return { where: w, list, i, it: list[i] };
  }
  return null;
};

const FAKES = {
  // With withFood (schema 4): plus each day's meals and, for a helper with the list on, list.
  get_person_day: (db, b) => {
    const who = db.my[b.p_token];
    if (!who) return null;
    // db.myToday: the household's day, for the homework household (v1.3), whose clock is Mon Nov 2.
    const today = db.myToday || TODAY;
    const out = clone({ person: who.person, today, days: [{ day: today, items: who.days[0] }, { day: hwAdd(today, 1), items: who.days[1] }], late: who.late });
    const person = (db.people || []).find((p) => p.day_token === b.p_token);
    // With withHomeworkTokens (schema 5): get_person_day's homework key, for a kid with homework on.
    if (person && db.homework_kids) personDayHomework(db, person, out);
    return person && db.shopping_items ? personDayFood(db, person, out) : out;
  },
  get_list_by_token: (db, b) => foodRpc.get_list_by_token(db, b),
  add_to_list_by_token: listWrite('add_to_list_by_token'),
  buy_item_by_token: listWrite('buy_item_by_token'),
  complete_by_token: (db, b) => {
    const who = db.my[b.p_token];
    if (!who) return null;
    const f = findTask(who, b.p_task_id);
    if (!f) return fail(403, '42501', "That task isn't on your list.");
    if (db.completeError) return fail(...db.completeError);
    if (db.someoneElseTicked) { f.it.status = 'done'; return fail(400, 'P0001', 'already completed', 'This date was already ticked off or skipped.'); }
    if (f.it.status !== 'open' && f.it.status !== 'late') return fail(400, 'P0001', 'already completed');
    if (b.p_occurrence !== f.it.occurrence) return fail(400, 'P0001', 'already completed');
    const id = crypto.randomUUID();
    db.logs.push({ id, token: b.p_token, task: b.p_task_id, before: clone(f.it), where: f.where, at: f.i });
    // A late task is no longer late once done; a task due today shows as done.
    if (f.where === 'late') f.list.splice(f.i, 1);
    else f.it.status = 'done';
    return id;
  },
  undo_by_token: (db, b) => {
    const who = db.my[b.p_token];
    if (!who) return null;
    if (db.undoError) return fail(...db.undoError);
    const log = db.logs.find((l) => l.id === b.p_log_id && l.token === b.p_token);
    if (!log) return fail(404, 'P0002', "There's nothing to undo.");
    db.logs = db.logs.filter((l) => l !== log);
    if (log.where === 'late') who.late.splice(log.at, 0, log.before);
    else findTask(who, log.task).it.status = log.before.status;
    return log.task;
  },
  // confirm_digest(p_confirm): the secret alone. Any other argument (a p_token) names a function that
  // doesn't exist, which PostgREST answers with 404 PGRST202.
  confirm_digest: (db, b) => {
    if (JSON.stringify(Object.keys(b)) !== '["p_confirm"]') {
      return fail(404, 'PGRST202', 'Could not find the function public.confirm_digest(' + Object.keys(b).sort().join(', ') + ') in the schema cache');
    }
    const token = (db.confirmCodes || {})[b.p_confirm];
    const who = token && db.my[token];
    if (!who) return false;
    who.person.email_confirmed = true;
    return true;
  },
  stop_digest: (db, b) => {
    const who = db.my[b.p_token];
    if (!who) return false;
    who.person.digest_enabled = false;
    return true;
  },
};
// v1.3: Jordan's seven homework functions and the tutor link's four, through mock.js's homeworkTokenRpc (the
// migration's rules and shapes). db.hwError refuses the next homework write with [status, code, message].
Object.keys(homeworkRpc).forEach((name) => {
  FAKES[name] = (db, b) => {
    if (db.hwError && !/^(homework_by_token|tutor_view_by_token)$/.test(name)) { const e = db.hwError; db.hwError = null; return fail(...e); }
    return homeworkRpc[name](db, b);
  };
});
const hwAdd = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// The token functions, answered for signed-out callers (mock.js wants a member). Every call is
// recorded in db.calls with its body, Authorization header, and when it came and was answered (ms);
// db.offline drops the connection; db.slow[name] answers that function after so many ms;
// db.status[name] answers it with that HTTP status and no database code (a 503 from the gateway).
async function tokenRpcs(page, db) {
  await page.route((url) => url.host === 'test.supabase.co' && url.pathname.startsWith('/rest/v1/rpc/'), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.slice('/rest/v1/rpc/'.length);
    if (!FAKES[name]) return route.fallback();
    if (db.offline) return route.abort('internetdisconnected');
    const body = JSON.parse(req.postData() || '{}');
    const call = { name, body, method: req.method(), auth: req.headers()['authorization'] || '', at: Date.now(), done: null };
    db.calls.push(call);
    const reply = (status, payload) => { call.done = Date.now(); return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(payload) }); };
    if (db.slow && db.slow[name]) await new Promise((r) => setTimeout(r, db.slow[name]));
    if (db.status && db.status[name]) return reply(db.status[name], { message: 'Service Unavailable' });
    // db.loseAnswer[name]: the call is made, and its answer never reaches the phone (so many times).
    if (db.loseAnswer && db.loseAnswer[name] > 0) { db.loseAnswer[name] -= 1; FAKES[name](db, body); call.done = Date.now(); return route.abort('internetdisconnected'); }
    const out = FAKES[name](db, body);
    return out && out.__status ? reply(out.__status, out.body) : reply(200, out === undefined ? null : out);
  });
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

// ---- v1.3: homework (docs/v1.3-homework.md §7, §8, §9.6), with mock.js's homeworkTokenRpc. The household's clock
// is Mon Nov 2 2026, 4:31pm in New York; the phone says Tue Nov 3, 12:07pm in Kiritimati, so nothing may lean on
// its clock or zone. Homework time Mon–Thu 4:30–5:15 and Sun 5:00–5:45; piano on Tuesday at 5:00.
const HW_NOW = '2026-11-02T21:31:04.512Z';
const HW_DEVICE = new Date('2026-11-03T22:07:00Z');
const HWT = '2026-11-02';
const PAT = 'abcdef0123456789abcdef0123456789';   // the tutor link's token ("Pat Lee, tutor")
const hwStamp = (ms) => new Date(ms).toISOString();
const hid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const H = {
  link: hid(1), sci: hid(10), s0: hid(11), s1: hid(12), s2: hid(13), s3: hid(14), s4: hid(15), s5: hid(16), s6: hid(17),
  math: hid(20), m1: hid(21), span: hid(30), v1: hid(31), v2: hid(32), v3: hid(33), ws51: hid(40), frac: hid(50), f1: hid(51),
  game: hid(60), dinner: hid(61), book: hid(62), askOld: hid(70), askNo: hid(71), old: hid(80),
};
const HW_TITLES = { m1: 'Do worksheet 4.2', s1: 'Copy the requirements into your notes', s2: 'Find 2 sources and save their links' };
function hwDb(o) {
  const opts = o || {};
  const db = dayDb();
  db.myToday = HWT;
  db.my[JORDAN] = {
    person: { name: 'Jordan Example', language: opts.lang || 'en', digest_enabled: true, email_confirmed: false },
    days: [[item({ item_id: hid(90), occurrence: HWT, day: HWT, title: 'Homework', start_time: '16:30', end_time: '17:15', time_label: opts.lang === 'es' ? '16:30' : '4:30pm' })], []],
    late: [],
  };
  db.household = [{ id: true, tz: 'America/New_York' }];
  db.people = [
    { id: P.alex, name: 'Alex Example', role: 'admin', language: 'en', email: 'alex@example.com', day_token: null, active: true },
    { id: P.sam, name: 'Sam Example', role: 'adult', language: 'en', email: 'sam@example.com', day_token: null, active: true },
    { id: P.taylor, name: 'Taylor Example', role: 'helper', language: 'es', email: null, day_token: TAYLOR, active: true },
    { id: P.jordan, name: 'Jordan Example', role: 'kid', language: opts.lang || 'en', email: null, day_token: JORDAN, active: true },
    { id: P.morgan, name: 'Morgan Example', role: 'kid', language: 'en', email: null, day_token: MORGAN, active: true },
  ];
  withHomeworkTokens(db, { now: HW_NOW });
  // His first length is 20 here (the flows below were written for 20-minute blocks); the default, 10, has its own check.
  db.homework_kids.push(hwKidRow({ kid_id: P.jordan, focus_minutes: opts.length || 20, cue: "When I've had my snack, I open my notes doc.",
    if_stuck: opts.ifStuck === undefined ? "If I'm stuck for 5 minutes, I'll write the question for Pat and move on." : opts.ifStuck }));
  db.hwTimes[P.jordan] = [{ weekdays: [1, 2, 3, 4], starts: '16:30', ends: '17:15' }, { weekdays: [7], starts: '17:00', ends: '17:45' }];
  db.hwBusy[P.jordan] = { '2026-11-03': [{ starts: '17:00', ends: '18:00', title: 'Piano' }] };
  if (!opts.noTutor) db.tutor_links.push(tutorLinkRow({ id: H.link, kid_id: P.jordan, token: PAT, created_at: '2026-10-20T12:00:00.000000+00:00' }));
  const kid = P.jordan;
  const at = (iso) => `${iso}.000000+00:00`;
  const fam = 'alex@example.com';
  const tut = 'Pat Lee, tutor (tutor link)';
  const me = 'Jordan (My day)';
  db.assignments.push(
    assignmentRow({ id: H.sci, kid_id: kid, title: 'Science project: river poster', subject: 'Science', due_date: '2026-11-13', added_by: 'tutor',
      stretch: 'Which part of the river would you most like to show in detail?', given_at: at('2026-10-26T22:00:00'), given_by: tut, plan_rev: 3,
      created_at: at('2026-10-25T15:00:00'), details: 'Make a poster about one river. Two sources at least.' }),
    assignmentRow({ id: H.math, kid_id: kid, title: 'Worksheet 4.2', subject: 'Math', due_date: '2026-11-03', given_at: at('2026-11-01T15:00:00'), given_by: fam,
      plan_rev: 2, created_at: at('2026-11-01T14:00:00') }),
    assignmentRow({ id: H.span, kid_id: kid, title: 'Vocabulary project', subject: 'Spanish', due_date: '2026-11-09', given_at: at('2026-10-27T15:00:00'),
      given_by: fam, plan_rev: 4, created_at: at('2026-10-27T14:00:00') }),
    assignmentRow({ id: H.ws51, kid_id: kid, title: 'Worksheet 5.1', subject: 'Math', due_date: '2026-11-04', added_by: 'kid', created_by: me,
      created_at: at('2026-11-02T20:00:00') }),
    assignmentRow({ id: H.frac, kid_id: kid, kind: 'lesson', title: 'Fractions practice', subject: 'Math', due_date: '2026-11-06', added_by: 'tutor',
      created_at: at('2026-11-01T16:00:00') }),
  );
  db.homework_steps.push(
    stepRow({ id: H.s0, assignment_id: H.sci, pos: 1, kind: 'milestone', title: 'Choose the river and its part', minutes: 10, day: '2026-10-30',
      done_at: at('2026-10-30T21:00:00'), done_by: me, checked_at: at('2026-10-31T15:00:00'), checked_by: tut,
      coach_note: 'Good choice. The delta is a strong focus.', coach_note_by: 'tutor', coach_note_at: at('2026-10-31T15:00:00') }),
    stepRow({ id: H.s1, assignment_id: H.sci, pos: 2, kind: 'start', title: HW_TITLES.s1, done_looks_like: 'the requirements in your notes', minutes: 10, day: HWT }),
    stepRow({ id: H.s2, assignment_id: H.sci, pos: 3, kind: 'step', title: HW_TITLES.s2, done_looks_like: '2 titles and links in your notes doc', minutes: 20, day: HWT }),
    stepRow({ id: H.s3, assignment_id: H.sci, pos: 4, kind: 'milestone', title: 'Outline with 3 main points', done_looks_like: 'an outline you can show', minutes: 25, day: '2026-11-04' }),
    stepRow({ id: H.s4, assignment_id: H.sci, pos: 5, kind: 'step', title: 'Draft the first half', minutes: 25, day: '2026-11-05' }),
    stepRow({ id: H.s5, assignment_id: H.sci, pos: 6, kind: 'check', title: 'Check it against the instructions', minutes: 20, day: '2026-11-11' }),
    stepRow({ id: H.s6, assignment_id: H.sci, pos: 7, kind: 'turn_in', title: 'Turn it in', minutes: 5, day: '2026-11-13' }),
    stepRow({ id: H.m1, assignment_id: H.math, pos: 1, kind: 'step', title: HW_TITLES.m1, minutes: 15, day: HWT,
      question: "What does 'simplify fully' mean here?", question_at: at('2026-11-01T22:00:00'),
      answer: 'No common factor is left.', answer_by: tut, answer_at: at('2026-11-01T23:10:00') }),
    stepRow({ id: H.v1, assignment_id: H.span, pos: 1, kind: 'step', title: 'List the 20 words', minutes: 15, day: '2026-10-29' }),
    stepRow({ id: H.v2, assignment_id: H.span, pos: 2, kind: 'milestone', title: 'Flashcards made', minutes: 20, day: '2026-10-30',
      not_yet_at: at('2026-10-31T16:00:00'), coach_note: 'Add the last five words.', coach_note_by: 'tutor', coach_note_at: at('2026-10-31T16:00:00') }),
    stepRow({ id: H.v3, assignment_id: H.span, pos: 3, kind: 'turn_in', title: 'Turn it in', minutes: 5, day: '2026-11-09' }),
    stepRow({ id: H.f1, assignment_id: H.frac, pos: 1, kind: 'step', title: 'Do practice session 1', minutes: 20, day: '2026-11-05' }),
  );
  db.rewards.push(
    rewardRow({ id: H.game, kid_id: kid, title: '15 minutes of extra game time', cost: 15, sort_order: 1 }),
    rewardRow({ id: H.dinner, kid_id: kid, title: "Choose Friday's dinner", cost: 60, sort_order: 2 }),
    rewardRow({ id: H.book, kid_id: kid, title: 'A new book', cost: 150, sort_order: 3 }),
  );
  db.reward_asks.push(
    { id: H.askOld, kid_id: kid, reward_id: H.dinner, title: "Choose Friday's dinner", cost: 60, status: 'approved', asked_at: at('2026-10-30T22:00:00'),
      decided_at: at('2026-10-31T13:00:00'), decided_by: 'morgan@example.com', note: null },
    { id: H.askNo, kid_id: kid, reward_id: H.game, title: '15 minutes of extra game time', cost: 15, status: 'declined', asked_at: at('2026-11-01T22:00:00'),
      decided_at: at('2026-11-01T23:00:00'), decided_by: 'alex@example.com', note: 'Not on a school night' },
  );
  db.points_ledger.push(
    ledgerRow({ kid_id: kid, at: at('2026-10-26T23:00:00'), day: '2026-10-26', kind: 'given', delta: 149, note: 'Great session with Pat', who: fam }),
    ledgerRow({ kid_id: kid, at: at('2026-10-31T15:00:00'), day: '2026-10-31', kind: 'milestone', delta: 20, step_id: H.s0, note: 'Choose the river and its part', who: tut }),
    ledgerRow({ kid_id: kid, at: at('2026-10-31T13:00:00'), day: '2026-10-31', kind: 'trade', delta: -60, note: "Choose Friday's dinner", who: 'morgan@example.com' }),
    ledgerRow({ kid_id: kid, at: at('2026-11-01T22:21:00'), day: '2026-11-01', kind: 'focus', delta: 4, session_id: H.old, step_id: H.s0, note: 'Choose the river and its part', who: me }),
    ledgerRow({ kid_id: kid, at: at('2026-11-01T22:21:01'), day: '2026-11-01', kind: 'on_time', delta: 5, session_id: H.old, step_id: H.s0, note: 'Choose the river and its part', who: me }),
  );
  db.focus_sessions.push(sessionRow({ id: H.old, kid_id: kid, assignment_id: H.sci, step_id: H.s0, minutes: 20, with_whom: 'tutor',
    started_at: at('2026-11-01T22:00:00'), ends_at: at('2026-11-01T22:20:00'), ended_at: at('2026-11-01T22:21:00'), result: 'done', seen_minutes: 20,
    on_time: true, points: 9, note: 'picked the delta' }));
  return db;
}
// Wake Lock, AudioContext and Notification, recorded with whether a tap was being handled (user activation).
const HW_STUBS = () => {
  const rec = { wake: [], audio: [], osc: [], ask: [], notes: [], released: 0, session: [], cheer: [] };   // osc: the chime's tones; cheer: the celebration's
  window.__hw = rec;
  const active = () => !!(navigator.userActivation && navigator.userActivation.isActive);
  try {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request(type) {
      rec.wake.push({ type, active: active() });
      const s = { released: false, release() { s.released = true; rec.released += 1; return Promise.resolve(); }, addEventListener() {} };
      return Promise.resolve(s);
    } } });
  } catch (e) { /* the test says so */ }
  class FakeAudio {
    constructor() { rec.audio.push({ active: active() }); this.currentTime = 5; this.state = 'running'; this.destination = {}; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createOscillator() {
      const o = { type: 'sine', frequency: { value: 0, setValueAtTime() {} }, connect() {}, stop() {},
        start(when) { if (o.type === 'triangle') rec.cheer.push(when); else rec.osc.push(when); } };
      return o;
    }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  window.AudioContext = FakeAudio;
  window.webkitAudioContext = FakeAudio;
  function FakeNote(title, o) { rec.notes.push({ title, body: o && o.body }); }
  FakeNote.permission = 'default';
  FakeNote.requestPermission = () => { rec.ask.push(active()); FakeNote.permission = 'granted'; return Promise.resolve('granted'); };
  window.Notification = FakeNote;
};

// After HW_STUBS: an AudioContext on a clock (its currentTime follows the page's clock and stands still while
// the page is hidden, as iOS stops a hidden page's audio), oscillators that end at their stop time, and
// navigator.audioSession, each change recorded with the audio clock's time. window.__hide() / __show() hide
// the page and bring it back (visibilityState and visibilitychange).
const HW_CLOCKED = () => {
  const rec = window.__hw;
  rec.ctx = [];
  rec.tones = [];
  rec.session = [];
  let hiddenSince = null;
  let away = 0;
  const vis = (v) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => v === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  window.__hide = () => { hiddenSince = performance.now(); vis('hidden'); };
  window.__show = () => { away += performance.now() - hiddenSince; hiddenSince = null; vis('visible'); };
  class Clocked {
    constructor() {
      this.t0 = performance.now();
      this.state = 'running';
      this.destination = {};
      rec.audio.push({ active: !!(navigator.userActivation && navigator.userActivation.isActive) });
      rec.ctx.push(this);
    }
    get currentTime() { return 5 + ((hiddenSince != null ? hiddenSince : performance.now()) - this.t0 - away) / 1000; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createOscillator() {
      const ctx = this;
      const o = {
        type: 'sine', frequency: { value: 0 }, connect() {}, onended: null, when: null, stopAt: null, ended: false, cancelled: false,
        start(when) { o.when = when; if (o.type === 'triangle') { rec.cheer.push(when); return; } rec.osc.push(when); rec.tones.push(o); },
        stop(when) {
          if (o.cancelled || o.ended) return;
          if (!when) { o.cancelled = true; return; }
          o.stopAt = when;
          // Ends when the audio clock reaches its stop time (later, if the clock stood still meanwhile).
          const wait = () => setTimeout(() => {
            if (o.cancelled || o.ended) return;
            if (ctx.currentTime < o.stopAt) { wait(); return; }
            o.ended = true;
            if (o.onended) o.onended({});
          }, Math.max(1, (o.stopAt - ctx.currentTime) * 1000));
          wait();
        },
      };
      return o;
    }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  window.AudioContext = Clocked;
  window.webkitAudioContext = Clocked;
  let type = 'auto';
  Object.defineProperty(navigator, 'audioSession', { configurable: true, value: {
    get type() { return type; },
    set type(v) { type = v; const c = rec.ctx[rec.ctx.length - 1]; rec.session.push({ type: v, at: c ? Math.round(c.currentTime * 1000) / 1000 : null }); },
  } });
  // When the next tone not called off or played is due, in seconds on the audio clock (null: none).
  window.__chimeIn = () => {
    const c = rec.ctx[rec.ctx.length - 1];
    const due = rec.tones.filter((t) => !t.cancelled && !(t.stopAt != null && c && c.currentTime >= t.stopAt)).map((t) => t.when);
    return c && due.length ? Math.min(...due) - c.currentTime : null;
  };
};
const HW_AUDIO = `(${HW_STUBS})(); (${HW_CLOCKED})();`;
// After HW_STUBS and HW_CLOCKED: a wake lock the browser lets go of when the page is hidden, as browsers do (its
// 'release' listeners called; rec.dropped counts them). window.__hide() / __show() hide the page and bring it back.
const HW_WAKE_DROP = () => {
  const rec = window.__hw;
  rec.dropped = 0;
  const live = [];
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request(type) {
    rec.wake.push({ type, active: !!(navigator.userActivation && navigator.userActivation.isActive) });
    const ls = [];
    const s = { released: false, release() { if (!s.released) { s.released = true; rec.released += 1; } return Promise.resolve(); },
      addEventListener(kind, f) { if (kind === 'release') ls.push(f); } };
    live.push({ s, ls });
    return Promise.resolve(s);
  } } });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    live.splice(0).forEach(({ s, ls }) => { if (s.released) return; s.released = true; rec.dropped += 1; ls.forEach((f) => f(new Event('release'))); });
  }, true);
};
const HW_AUDIO_DROP = `(${HW_STUBS})(); (${HW_CLOCKED})(); (${HW_WAKE_DROP})();`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  const phone = (ua) => ({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: ua || IPHONE });

  async function open(opts) {
    const db = opts.db || dayDb();
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: 'Pacific/Kiritimati' }, opts.ctx));
    if (opts.signedIn) await signIn(context, 'alex@example.com');
    if (opts.init) await context.addInitScript(opts.init);
    const page = await context.newPage();
    await page.clock.install({ time: opts.device || DEVICE_NOW });
    // opts.noPlan: plan.js doesn't load (a phone that kept an older day.html, or a failed fetch).
    if (opts.noPlan) await page.route(/\/assets\/plan\.js/, (route) => route.abort('failed'));
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await install(page, db, [], { rpc: FAKES });
    await tokenRpcs(page, db);
    await page.goto(BASE + opts.path);
    await page.waitForSelector('.day-head', { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 5000 });
    await page.waitForTimeout(100);
    return { page, db, context, requests };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.trim()));
  const calls = (db, name) => db.calls.filter((c) => c.name === name);
  const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const size = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  const rowsOf = (page, which) => page.$$eval(`section[aria-labelledby="day-${which}"] .irow`, (rs) => rs.map((r) => {
    const box = r.querySelector('.day-check');
    const call = r.querySelector('.irow-call');
    const small = r.querySelector('.irow-time small');
    return {
      title: r.querySelector('.irow-title').textContent,
      top: r.querySelector('.irow-time span').textContent,
      sub: small ? small.textContent : '',
      details: (r.querySelector('.irow-sub') || { textContent: '' }).textContent,
      box: box ? { checked: box.getAttribute('aria-checked'), disabled: box.disabled, label: box.getAttribute('aria-label') } : null,
      call: call ? { href: call.getAttribute('href'), label: call.getAttribute('aria-label') } : null,
      cls: r.className,
    };
  }));
  const rowByTitle = (page, title) => page.locator('.irow').filter({ has: page.locator('.irow-title', { hasText: title }) });

  // =====================================================================
  // 1. What day.html loads: no hub, no manifest, no sign-in; noindex and no-referrer
  // =====================================================================
  let { page, db, requests } = await open({ label: 'en', path: `/day.html?t=${TAYLOR}`, signedIn: true });
  const head = await page.evaluate(() => ({
    scripts: [...document.querySelectorAll('script[src]')].map((s) => ({ src: s.getAttribute('src'), async: s.async || s.defer })),
    inline: document.querySelectorAll('script:not([src])').length,
    styles: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')),
    manifest: !!document.querySelector('link[rel=manifest]'),
    robots: (document.querySelector('meta[name=robots]') || {}).content,
    referrer: (document.querySelector('meta[name=referrer]') || {}).content,
    hub: typeof window.HomeHub, gantt: typeof window.HomeGantt,
  }));
  const indexCdn = (fs.readFileSync(`${ROOT}/index.html`, 'utf8').match(/https:\/\/cdn\.jsdelivr\.net\/[^"?]*supabase\.js/) || [])[0];
  const order = head.scripts.map((s) => s.src.replace(/\?.*$/, ''));
  // shoplist.js (v1.2: the shopping list's aisles and outbox) and plan.js (v1.3: homework's editor and timer, added on
  // purpose), neither with database calls of its own, come before day.js.
  check('day.html: config.js, then supabase-js (the same pinned URL as index.html), then assets/shoplist.js, assets/plan.js and assets/day.js',
    same(order, ['config.js', indexCdn, 'assets/shoplist.js', 'assets/plan.js', 'assets/day.js']) && /@2\.\d+\.\d+\//.test(indexCdn || ''), order.join(', '));
  check('day.html: no async scripts, no inline script', head.scripts.every((s) => !s.async) && head.inline === 0);
  check('day.html: styles.css, css/day.css, then css/plan.css (v1.3)', same(head.styles.map((h) => h.replace(/\?.*$/, '')), ['assets/styles.css', 'assets/css/day.css', 'assets/css/plan.css']),
    head.styles.join(', '));
  check('day.html: robots noindex,nofollow and referrer no-referrer', /noindex/.test(head.robots || '') && /nofollow/.test(head.robots || '') && head.referrer === 'no-referrer', JSON.stringify(head));
  check('day.html: no manifest link (the hub\'s manifest would install the hub)', !head.manifest);
  check('day.html: the hub and the Gantt engine are not loaded', head.hub === 'undefined' && head.gantt === 'undefined'
    && !requests.some((u) => /hub\.js|gantt\.js|manifest\.webmanifest|assets\/modules\//.test(u)), requests.filter((u) => /assets/.test(u)).join(' | '));
  const fetched = await page.evaluate(async (urls) => Promise.all(urls.map(async (u) => (await fetch(new URL(u, location.href))).status)), head.styles.concat(['assets/shoplist.js', 'assets/plan.js', 'assets/day.js']));
  check('day.html: its stylesheets and scripts exist', fetched.every((s) => s === 200), fetched.join(','));
  check('no sign-in: no Auth requests', !requests.some((u) => u.includes('/auth/v1/')), requests.filter((u) => u.includes('/auth/')).join(' | '));
  const gpd = calls(db, 'get_person_day');
  check('get_person_day is called once, with { p_token } only', gpd.length === 1 && same(gpd[0].body, { p_token: TAYLOR }), JSON.stringify(gpd.map((c) => c.body)));
  check('no sign-in: a hub sign-in in this browser is not used (no user token sent)', gpd.length && !/^Bearer eyJ/.test(gpd[0].auth), gpd[0] && gpd[0].auth.slice(0, 30));
  check('loading changes nothing: no tick, undo, confirm or stop calls', db.calls.every((c) => c.name === 'get_person_day'), db.calls.map((c) => c.name).join(','));

  // =====================================================================
  // 2. English: header, Today, Late, Tomorrow
  // =====================================================================
  check('header: the person\'s first name and the household\'s date (not the device\'s)',
    (await text(page, '.day-head h1')) === 'Hi, Taylor' && (await text(page, '.day-head .meta')) === 'Sunday, October 25'
    && (await page.evaluate(() => new Date().getDate())) === 26, `${await text(page, '.day-head h1')} / ${await text(page, '.day-head .meta')}`);
  check('page language and title follow the person', (await page.evaluate(() => document.documentElement.lang)) === 'en' && (await page.title()) === 'Taylor · My day', await page.title());
  check('sections: Today, Late, Tomorrow in that order, with their dates',
    same(await texts(page, '.day-sec .sec-head > span:first-child'), ['Today', 'Late', 'Tomorrow']) && same(await texts(page, '.day-sec .day-date'), ['Sun Oct 25', 'Mon Oct 26']),
    (await texts(page, '.day-sec .sec-head')).join(' | '));
  let today = await rowsOf(page, 'today');
  check('today: items in the database\'s order', same(today.map((r) => r.title),
    ['Walk the dogs', 'Furnace check', 'Piano pickup', 'School holiday', '<b>Feed</b> & water the cat', 'Take out recycling', 'Sweep the porch']), today.map((r) => r.title).join(' | '));
  check('today: times from the database (start, and end under it for events), All day, Any time',
    same(today.map((r) => [r.top, r.sub]), [['8:00am', ''], ['10:30am', '11:30am'], ['4:00pm', '5:00pm'], ['All day', ''], ['Any time', ''], ['Any time', ''], ['Any time', '']]),
    JSON.stringify(today.map((r) => [r.top, r.sub])));
  check('titles are shown as typed, never as HTML', today[4].title === '<b>Feed</b> & water the cat' && !(await page.$('.irow-title b')));
  check('a big checkbox on their own open tasks only (not on events, done or skipped items)',
    same(today.map((r) => (r.box ? (r.box.disabled ? 'ticked' : 'box') : '-')), ['box', '-', '-', '-', 'box', 'ticked', '-']) && today[0].box.label === 'Done: Walk the dogs' && today[0].box.checked === 'false',
    JSON.stringify(today.map((r) => r.box)));
  check('done tasks are ticked and struck through; skipped ones say so', /st-done/.test(today[5].cls) && today[5].box.checked === 'true' && /st-skipped/.test(today[6].cls) && today[6].details === 'Skipped');
  check('tap to call the linked contact', today[1].call && today[1].call.href === 'tel:2015550100' && today[1].call.label === 'Call Pat Lee (201) 555-0100' && today[1].details === 'Pat Lee', JSON.stringify(today[1]));
  check('the place shows under the title', today[2].details === 'Music school' && !today[2].call);
  const late = await rowsOf(page, 'late');
  check('late: their late task with its due day and a box', late.length === 1 && late[0].title === 'Clean the gutters' && late[0].top === 'Fri Oct 23' && late[0].box && !late[0].box.disabled, JSON.stringify(late));
  const tomorrow = await rowsOf(page, 'tomorrow');
  check('tomorrow: timed event, and a trip over several days as its dates',
    same(tomorrow.map((r) => [r.title, r.top, r.sub]), [['Dentist', '9:00am', '10:00am'], ['Camping trip', 'Oct 26', '– Oct 28']]), JSON.stringify(tomorrow));
  check('who else is on it shows on the second line, before the place ("with Jordan · Example Dental")',
    tomorrow[0].details === 'with Jordan · Example Dental' && tomorrow[1].details === '', JSON.stringify(tomorrow.map((r) => r.details)));
  check('no "Add to Home Screen" hint on a computer', !(await page.$('.day-hint')));
  check('footer: the page is just for them', (await text(page, '.footer')) === "This page is just for you. Please don't share the link.");
  check('nothing else: no sign-in, notes or other pages', !(await page.$('input, textarea, nav, form')));
  await page.screenshot({ path: SHOTS + 'day-desktop.png', fullPage: true });

  // =====================================================================
  // 3. Tick off, Undo
  // =====================================================================
  let loads = calls(db, 'get_person_day').length;
  await rowByTitle(page, 'Walk the dogs').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  const done = calls(db, 'complete_by_token');
  check('tick: complete_by_token with the token, the task and the date shown',
    done.length === 1 && same(done[0].body, { p_token: TAYLOR, p_task_id: ID.walk, p_occurrence: TODAY }), JSON.stringify(done.map((c) => c.body)));
  check('tick: a "Done" toast with Undo and a close button',
    (await text(page, '.toast-action span')) === 'Done: Walk the dogs' && same(await texts(page, '.toast-action button'), ['Undo', '×']), await text(page, '.toast-action'));
  check('tick: the list reloads and shows it done',
    await until(async () => calls(db, 'get_person_day').length === loads + 1 && /st-done/.test((await rowsOf(page, 'today'))[0].cls)),
    JSON.stringify((await rowsOf(page, 'today'))[0]));
  today = await rowsOf(page, 'today');
  check('tick: the box stays ticked and can\'t be tapped again', today[0].box && today[0].box.checked === 'true' && today[0].box.disabled);
  const logId = db.logs[0] && db.logs[0].id;
  loads = calls(db, 'get_person_day').length;
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await until(async () => calls(db, 'undo_by_token').length === 1);
  const undone = calls(db, 'undo_by_token');
  check('Undo: undo_by_token with the token and the log id from the tick', undone.length === 1 && same(undone[0].body, { p_token: TAYLOR, p_log_id: logId }), JSON.stringify(undone.map((c) => c.body)));
  check('Undo: says so, and the task is open again',
    await until(async () => (await text(page, '.toast')) === "Undone. It's back on your list." && !(await page.$('.toast-action'))
      && calls(db, 'get_person_day').length === loads + 1 && /st-open/.test((await rowsOf(page, 'today'))[0].cls) && !(await rowsOf(page, 'today'))[0].box.disabled),
    await text(page, '.toasts'));

  await rowByTitle(page, 'Clean the gutters').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  const lateTick = calls(db, 'complete_by_token').slice(-1)[0];
  check('tick a late task: its own due date is sent', lateTick && same(lateTick.body, { p_token: TAYLOR, p_task_id: ID.gutters, p_occurrence: '2026-10-23' }), JSON.stringify(lateTick && lateTick.body));
  check('tick a late task: the Late section goes away', await until(async () => !(await page.$('section[aria-labelledby="day-late"]'))));
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await until(async () => calls(db, 'complete_by_token').length === 3);
  await page.waitForTimeout(200);
  check('a second tick replaces the first one\'s Undo toast', (await page.$$('.toast-action')).length === 1 && (await text(page, '.toast-action span')) === 'Done: <b>Feed</b> & water the cat');
  await page.click('.toast-action .toast-x');
  check('the close button closes the Undo toast', !(await page.$('.toast-action')));
  await page.context().close();

  // =====================================================================
  // 4. Errors when ticking and undoing
  // =====================================================================
  ({ page, db } = await open({ label: 'tick-errors', path: `/day.html?t=${TAYLOR}`, allowConsole: /status of (400|403|404)|ERR_INTERNET_DISCONNECTED/ }));
  db.someoneElseTicked = true;
  loads = calls(db, 'get_person_day').length;
  await rowByTitle(page, 'Walk the dogs').locator('.day-check').click();
  await page.waitForSelector('.toast-error');
  check('already ticked (another phone): says so and shows the list as it is now',
    (await text(page, '.toast-error')) === 'That was already ticked off. The list is up to date now.'
    && await until(async () => calls(db, 'get_person_day').length === loads + 1 && /st-done/.test((await rowsOf(page, 'today'))[0].cls)), await text(page, '.toast-error'));
  db.someoneElseTicked = false;
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  db.completeError = [403, '42501', "That task isn't on your list."];
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await page.waitForSelector('.toast-error');
  let feed = (await rowsOf(page, 'today'))[4];
  check('not theirs any more: says so and unticks the box', (await text(page, '.toast-error')) === "That task isn't on your list any more."
    && feed.box.checked === 'false' && !feed.box.disabled && !/is-ticked/.test(feed.cls), JSON.stringify(feed));
  db.completeError = [400, '22023', 'This task is paused. Turn it back on before ticking it off.'];
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await page.waitForSelector('.toast-error');
  check('paused task: says so', (await text(page, '.toast-error')) === "That task is paused, so it can't be ticked off right now.");
  db.completeError = null;
  db.offline = true;
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await page.waitForSelector('.toast-error');
  feed = (await rowsOf(page, 'today'))[4];
  check('no connection: says so and unticks the box', (await text(page, '.toast-error')) === "Can't reach Home Hub. Check your internet connection and try again." && feed.box.checked === 'false' && !feed.box.disabled);
  db.offline = false;
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await rowByTitle(page, 'Feed').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  db.undoError = [400, '22023', "That was more than 15 minutes ago, so it can't be undone here."];
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await page.waitForSelector('.toast-error');
  check('Undo refused (too late): says so in plain words', (await text(page, '.toast-error')) === "That can't be undone here any more. Ask the family to fix it.", await text(page, '.toast-error'));
  await page.context().close();

  // The Undo toast stays for the 15 minutes undo_by_token allows, then goes.
  ({ page, db } = await open({ label: 'undo-15', path: `/day.html?t=${TAYLOR}` }));
  await rowByTitle(page, 'Walk the dogs').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  await page.clock.fastForward('14:00');
  check('Undo toast: still there after 14 minutes', !!(await page.$('.toast-action')));
  await page.clock.fastForward('01:05');
  check('Undo toast: gone after 15 minutes', await until(async () => !(await page.$('.toast-action'))));
  await page.context().close();

  // =====================================================================
  // 5. Refreshes: focus, coming back into view, every 5 minutes; a failed one keeps the list
  // =====================================================================
  ({ page, db } = await open({ label: 'refresh', path: `/day.html?t=${TAYLOR}`, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
  loads = calls(db, 'get_person_day').length;
  await page.waitForTimeout(1100);
  db.my[TAYLOR].days[0].push(task({ item_id: crypto.randomUUID(), title: 'Bring in the mail' }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check('focus: loads again and shows what changed',
    await until(async () => calls(db, 'get_person_day').length === loads + 1 && (await rowsOf(page, 'today')).some((r) => r.title === 'Bring in the mail')));
  await page.waitForTimeout(1100);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  check('coming back into view: loads again', await until(async () => calls(db, 'get_person_day').length === loads + 2));
  await page.clock.fastForward('05:00');
  check('every 5 minutes: loads again', await until(async () => calls(db, 'get_person_day').length === loads + 3), calls(db, 'get_person_day').length - loads);
  db.offline = true;
  await page.clock.fastForward('05:00');
  check('a failed refresh keeps the list and says so',
    await until(async () => (await text(page, '.day-notice')) === "Couldn't refresh just now. Check your internet connection.") && (await rowsOf(page, 'today')).length === 8,
    await text(page, '.day-notice'));
  db.offline = false;
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check('the next refresh clears the notice', await until(async () => !(await page.$('.day-notice'))));
  await page.context().close();

  // =====================================================================
  // 6. Spanish, and a day with nothing planned
  // =====================================================================
  ({ page, db } = await open({ label: 'es', path: `/day.html?t=${JORDAN}` }));
  check('es: header in Spanish', (await text(page, '.day-head h1')) === 'Hola, Jordan' && (await text(page, '.day-head .meta')) === 'Domingo, 25 de octubre' && (await text(page, '.day-head .eyebrow')).toLowerCase() === 'mi día',
    `${await text(page, '.day-head h1')} / ${await text(page, '.day-head .meta')}`);
  check('es: sections Hoy and Mañana with Spanish dates, no Late section',
    same(await texts(page, '.day-sec .sec-head > span:first-child'), ['Hoy', 'Mañana']) && same(await texts(page, '.day-sec .day-date'), ['dom 25 oct', 'lun 26 oct']),
    (await texts(page, '.day-sec .sec-head')).join(' | '));
  const es = await rowsOf(page, 'today');
  check('es: times as the database writes them (24-hour), Sin hora, titles as typed',
    same(es.map((r) => [r.title, r.top, r.sub]), [['Piano', '16:00', '17:00'], ['Tender la cama', 'Sin hora', '']]) && es[1].box.label === 'Hecho: Tender la cama', JSON.stringify(es));
  check('es: empty tomorrow', (await text(page, 'section[aria-labelledby="day-tomorrow"] .empty-line')) === 'Nada planeado para mañana.');
  check('es: a kid sees who takes them ("Taylor · Escuela de música")', es[0].details === 'Taylor · Escuela de música', es[0].details);
  check('es: page language, title and footer', (await page.evaluate(() => document.documentElement.lang)) === 'es' && (await page.title()) === 'Jordan · Mi día'
    && (await text(page, '.footer')) === 'Esta página es solo para ti. Por favor, no compartas el enlace.');
  await rowByTitle(page, 'Tender la cama').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  check('es: tick toast and Undo in Spanish', (await text(page, '.toast-action span')) === 'Hecho: Tender la cama' && (await texts(page, '.toast-action button'))[0] === 'Deshacer'
    && same(calls(db, 'complete_by_token')[0].body, { p_token: JORDAN, p_task_id: ID.bed, p_occurrence: TODAY }));
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  check('es: Undo result in Spanish', await until(async () => (await text(page, '.toast')) === 'Deshecho. Vuelve a estar en tu lista.'));
  await page.screenshot({ path: SHOTS + 'day-es.png', fullPage: true });
  await page.context().close();

  ({ page } = await open({ label: 'empty', path: `/day.html?t=${MORGAN}` }));
  check('nothing planned: both empty states, no Late section',
    same(await texts(page, '.day-sec .empty-line'), ['Nothing planned for today.', 'Nothing planned for tomorrow.']) && !(await page.$('section[aria-labelledby="day-late"]')) && !(await page.$('.irow')));
  await page.context().close();

  // =====================================================================
  // 7. Links that don't work
  // =====================================================================
  ({ page, db } = await open({ label: 'unknown', path: `/day.html?t=${UNKNOWN}` }));
  check('unknown or expired link: "Ask the family for a new link", in both languages',
    (await text(page, '.day-problem p:first-child')) === "This link isn't working. Ask the family for a new link."
    && (await text(page, '.day-problem .day-alt')) === 'Este enlace no funciona. Pide a la familia un enlace nuevo.'
    && !(await page.$('.day-sec')) && same(calls(db, 'get_person_day').map((c) => c.body), [{ p_token: UNKNOWN }]), await text(page, '.day-problem'));
  await page.context().close();
  ({ page, db } = await open({ label: 'malformed', path: '/day.html?t=not-a-real-code' }));
  check('a malformed link: the same message, without asking the database',
    /Ask the family for a new link/.test(await text(page, '.day-problem')) && db.calls.length === 0);
  await page.context().close();
  ({ page, db } = await open({ label: 'no-token', path: '/day.html' }));
  check('no code in the link: says so', (await text(page, '.day-problem p:first-child')) === 'This link is missing its code. Ask the family for a new link.' && db.calls.length === 0);
  await page.context().close();
  ({ page } = await open({ label: 'unknown-es', path: `/day.html?t=${UNKNOWN}`, ctx: { locale: 'es-MX' } }));
  check('unknown link on a Spanish phone: Spanish first', (await text(page, '.day-problem p:first-child')) === 'Este enlace no funciona. Pide a la familia un enlace nuevo.'
    && (await page.$eval('.day-problem p:first-child', (e) => e.lang)) === 'es');
  await page.context().close();
  db = dayDb();
  db.offline = true;
  ({ page } = await open({ label: 'offline', db, path: `/day.html?t=${TAYLOR}`, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
  check('no connection on the first load: says so, with Try again',
    /Can't reach Home Hub/.test(await text(page, '.day-problem')) && !!(await page.$('[data-act="retry"]')), await text(page, '.day-problem'));
  db.offline = false;
  await page.click('[data-act="retry"]');
  check('Try again: the day shows', await until(async () => (await rowsOf(page, 'today')).length === 7));
  await page.context().close();

  // =====================================================================
  // 8. #confirm and #stop: a question and a button; nothing changes on load
  // =====================================================================
  ({ page, db } = await open({ label: 'confirm', path: `/day.html?t=${TAYLOR}&c=${CONFIRM}#confirm` }));
  await page.waitForTimeout(800);
  check('#confirm: asks "Send me the morning email?" with a button', (await text(page, '.day-panel h2')) === 'Send me the morning email?'
    && (await text(page, '[data-act="confirm"]')) === 'Yes, send me the morning email' && !(await page.$('.day-sec')));
  check('#confirm: nothing is confirmed on load (email scanners open links)', calls(db, 'confirm_digest').length === 0 && calls(db, 'stop_digest').length === 0
    && db.my[TAYLOR].person.email_confirmed === false, db.calls.map((c) => c.name).join(','));
  await page.click('[data-act="confirm"]');
  check('#confirm (an older email\'s link, with t= too): the button sends confirm_digest with the code only', await until(async () => calls(db, 'confirm_digest').length === 1)
    && same(calls(db, 'confirm_digest')[0].body, { p_confirm: CONFIRM }), JSON.stringify(calls(db, 'confirm_digest').map((c) => c.body)));
  check('#confirm: says it worked, and the button is gone', await until(async () => (await text(page, '.day-result')) === "You're all set. Your morning email starts with the next one.") && !(await page.$('[data-act="confirm"]')));
  check('#confirm: the code and the hash leave the address', await page.evaluate((t) => location.search === `?t=${t}` && location.hash === '', TAYLOR), await page.evaluate(() => location.href));
  await page.click('.day-link');
  check('#confirm: "See my day" opens the day', await until(async () => (await rowsOf(page, 'today')).length === 7));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-es', path: `/day.html?t=${JORDAN}&c=${'1'.repeat(32)}#confirm` }));
  check('#confirm in Spanish', (await text(page, '.day-panel h2')) === '¿Quieres recibir el correo de la mañana?' && (await text(page, '[data-act="confirm"]')) === 'Sí, quiero el correo de la mañana');
  await page.click('[data-act="confirm"]');
  check('#confirm with a code that doesn\'t match: says what to do', await until(async () => /el correo más reciente de Home Hub/.test(await text(page, '.day-result')))
    && db.my[JORDAN].person.email_confirmed === false && !(await page.$('[data-act="confirm"]')), await text(page, '.day-result'));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-nocode', path: `/day.html?t=${TAYLOR}#confirm` }));
  check('#confirm without the code: says the link is incomplete, no button', /This link is incomplete/.test(await text(page, '.day-panel')) && !(await page.$('[data-act="confirm"]')) && calls(db, 'confirm_digest').length === 0);
  await page.context().close();
  ({ page, db } = await open({ label: 'confirm-already', path: `/day.html?t=${MORGAN}&c=${CONFIRM}#confirm` }));
  check('#confirm when already confirmed: says so, no button', (await text(page, '.day-panel .day-ok')) === 'Your email address is already confirmed.' && !(await page.$('[data-act="confirm"]')));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-offline', path: `/day.html?t=${TAYLOR}&c=${CONFIRM}#confirm`, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
  db.offline = true;
  await page.click('[data-act="confirm"]');
  check('#confirm with no connection: says so, and the button works again', await until(async () => /Can't reach Home Hub/.test(await text(page, '.day-result')))
    && !(await page.$eval('[data-act="confirm"]', (b) => b.disabled)) && (await text(page, '[data-act="confirm"]')) === 'Yes, send me the morning email');
  await page.context().close();

  // ---- The confirmation email's link: day.html?c=<secret>#confirm, with no My day token. The page
  // shows only the question: it knows nobody's day, and loads none.
  ({ page, db } = await open({ label: 'confirm-code-only', path: `/day.html?c=${CONFIRM}#confirm` }));
  await page.waitForTimeout(800);
  check('?c= only: asks "Send me the morning email?" with a button, and shows no day',
    (await text(page, '.day-panel h2')) === 'Send me the morning email?' && (await text(page, '[data-act="confirm"]')) === 'Yes, send me the morning email'
    && !(await page.$('.day-sec')) && !(await page.$('.day-problem')), await text(page, 'main'));
  check('?c= only: no My day is loaded (no get_person_day), nothing confirmed on load', db.calls.length === 0 && db.my[TAYLOR].person.email_confirmed === false, db.calls.map((c) => c.name).join(','));
  check('?c= only: no name, no My day link and no "See my day" (the page doesn\'t know whose it is)',
    !/Taylor/.test(await text(page, 'main')) && !(await page.$('.day-link')) && !(await page.$('a[href*="t="]')), await text(page, 'main'));
  check('?c= only: the page\'s title', (await page.title()) === 'Morning email · Home Hub', await page.title());
  await page.click('[data-act="confirm"]');
  check('?c= only: the button sends confirm_digest({ p_confirm }) and says it worked',
    await until(async () => (await text(page, '.day-result')) === "You're all set. Your morning email starts with the next one.")
    && same(calls(db, 'confirm_digest').map((c) => c.body), [{ p_confirm: CONFIRM }]) && db.my[TAYLOR].person.email_confirmed === true && !(await page.$('[data-act="confirm"]')),
    JSON.stringify(calls(db, 'confirm_digest').map((c) => c.body)));
  check('?c= only: still no other call (no day loaded afterwards)', db.calls.every((c) => c.name === 'confirm_digest'), db.calls.map((c) => c.name).join(','));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-nohash', path: `/day.html?c=${CONFIRM}` }));
  check('?c= without #confirm: the same question (the code means confirm)', (await text(page, '.day-panel h2')) === 'Send me the morning email?' && db.calls.length === 0);
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-wrong', path: `/day.html?c=${'2'.repeat(32)}#confirm` }));
  await page.click('[data-act="confirm"]');
  check('?c= only, a code that doesn\'t match (replaced since): says what to do',
    await until(async () => /open the newest email from Home Hub/.test(await text(page, '.day-result'))) && !(await page.$('[data-act="confirm"]')), await text(page, '.day-result'));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-bad', path: '/day.html?c=not-a-code#confirm' }));
  check('?c= only, a malformed code: "This link is incomplete", no button, nothing asked',
    /This link is incomplete/.test(await text(page, '.day-panel')) && !(await page.$('[data-act="confirm"]')) && db.calls.length === 0, await text(page, 'main'));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-es', path: `/day.html?c=${CONFIRM}#confirm`, ctx: { locale: 'es-MX' } }));
  check('?c= only on a Spanish phone: in Spanish, with a switch to English',
    (await text(page, '.day-panel h2')) === '¿Quieres recibir el correo de la mañana?' && (await page.evaluate(() => document.documentElement.lang)) === 'es'
    && (await text(page, '[data-act="lang"]')) === 'In English', await text(page, 'main'));
  await page.click('[data-act="lang"]');
  check('... the switch shows it in English (and offers Spanish back)', (await text(page, '.day-panel h2')) === 'Send me the morning email?'
    && (await page.evaluate(() => document.documentElement.lang)) === 'en' && (await text(page, '[data-act="lang"]')) === 'En español', await text(page, 'main'));
  await page.click('[data-act="lang"]');
  await page.click('[data-act="confirm"]');
  check('... and confirming answers in the language shown', await until(async () => (await text(page, '.day-result')) === 'Listo. El correo de la mañana empieza con el próximo.'), await text(page, '.day-result'));
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-offline', path: `/day.html?c=${CONFIRM}#confirm`, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
  db.offline = true;
  await page.click('[data-act="confirm"]');
  check('?c= only with no connection: says so, and the button works again', await until(async () => /Can't reach Home Hub/.test(await text(page, '.day-result')))
    && !(await page.$eval('[data-act="confirm"]', (b) => b.disabled)));
  db.offline = false;
  await page.click('[data-act="confirm"]');
  check('... and the second try confirms', await until(async () => /You're all set/.test(await text(page, '.day-result'))) && db.my[TAYLOR].person.email_confirmed === true);
  await page.context().close();

  ({ page, db } = await open({ label: 'confirm-code-only-phone', path: `/day.html?c=${CONFIRM}#confirm`, ctx: phone() }));
  const yesOnly = await size(page, '[data-act="confirm"]');
  const langBtn = await size(page, '[data-act="lang"]');
  check('?c= only on a phone: fits, full-width button, 44px targets, no Home Screen hint',
    await noSideScroll(page) && yesOnly.h >= 44 && yesOnly.w >= 300 && langBtn.h >= 44 && !(await page.$('.day-hint')), JSON.stringify({ yesOnly, langBtn }));
  await page.screenshot({ path: SHOTS + 'day-phone-confirm-code.png' });
  await page.context().close();

  ({ page, db } = await open({ label: 'stop', path: `/day.html?t=${TAYLOR}#stop` }));
  await page.waitForTimeout(800);
  check('#stop: asks "Stop the morning email?" with a button', (await text(page, '.day-panel h2')) === 'Stop the morning email?' && (await text(page, '[data-act="stop"]')) === 'Stop the morning email');
  check('#stop: nothing is stopped on load', calls(db, 'stop_digest').length === 0 && calls(db, 'confirm_digest').length === 0 && db.my[TAYLOR].person.digest_enabled === true);
  await page.click('[data-act="stop"]');
  check('#stop: the button sends stop_digest(token)', await until(async () => calls(db, 'stop_digest').length === 1) && same(calls(db, 'stop_digest')[0].body, { p_token: TAYLOR }));
  check('#stop: says it worked', await until(async () => (await text(page, '.day-result')) === "Stopped. You won't get the morning email any more. Ask the family if you want it back.")
    && db.my[TAYLOR].person.digest_enabled === false && await page.evaluate(() => location.hash === ''));
  await page.context().close();
  ({ page, db } = await open({ label: 'stop-off', path: `/day.html?t=${MORGAN}#stop` }));
  check('#stop when it\'s already off: says so, no button', (await text(page, '.day-panel .day-ok')) === 'The morning email is already off.' && !(await page.$('[data-act="stop"]')));
  await page.context().close();
  ({ page, db } = await open({ label: 'stop-unknown', path: `/day.html?t=${UNKNOWN}#stop` }));
  check('#stop with a link that doesn\'t work: the new-link message, nothing sent', /Ask the family for a new link/.test(await text(page, '.day-problem')) && calls(db, 'stop_digest').length === 0);
  await page.context().close();

  // =====================================================================
  // 8b. Google Calendar events (kind 'google', from migration 0003's person_items): never a box to tick
  // =====================================================================
  db = dayDb();
  db.my[TAYLOR].days[0].push(
    item({ kind: 'google', item_id: crypto.randomUUID(), title: '<img src=x onerror="window.__xss=1">Swim meet', start_time: '11:00', end_time: '12:00', time_label: '11:00am',
      location: 'javascript:alert(1)' }),
    item({ kind: 'google', item_id: crypto.randomUUID(), title: 'Private item', all_day: true }),
  );
  ({ page } = await open({ label: 'google', db, path: `/day.html?t=${TAYLOR}` }));
  const google = (await rowsOf(page, 'today')).filter((r) => /k-google/.test(r.cls));
  check('a Google event: no box to tick, its time and place', same(google.map((r) => [r.title, r.top, r.sub, r.details, r.box]), [
    ['<img src=x onerror="window.__xss=1">Swim meet', '11:00am', '12:00pm', 'javascript:alert(1)', null], ['Private item', 'All day', '', '', null]]), JSON.stringify(google));
  check('a Google event: the hostile title and place are text (no image, no link), nothing runs', !(await page.$('.irow img, .irow-sub a')) && await page.evaluate(() => !window.__xss));
  const dot = await page.$eval('.irow.k-google .irow-title', (t) => { const b = getComputedStyle(t, '::before'); return [b.borderTopStyle, b.borderRadius, b.backgroundColor]; });
  check('a Google event: an outlined dot before its title (day.css)', dot[0] === 'solid' && dot[1] === '50%' && dot[2] === 'rgba(0, 0, 0, 0)', JSON.stringify(dot));
  await page.screenshot({ path: SHOTS + 'day-google.png', fullPage: true });
  await page.context().close();
  ({ page } = await open({ label: 'google-phone', db, path: `/day.html?t=${TAYLOR}`, ctx: Object.assign(phone(), { colorScheme: 'dark' }) }));
  check('a Google event (phone, dark): no sideways scroll; still no box', await noSideScroll(page) && !(await page.$('.irow.k-google .day-check')));
  await page.screenshot({ path: SHOTS + 'day-google-phone-dark.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 9. Phones: 390px wide, 44px targets, the "Add to Home Screen" hint, dark mode
  // =====================================================================
  db = dayDb();
  db.my[TAYLOR].days[0].push(task({ item_id: crypto.randomUUID(), title: 'Pick up the replacement furnace filters from the hardware store before it closes tonight', all_day: false, start_time: '17:30', time_label: '5:30pm' }));
  db.my[TAYLOR].days[0].push(task({ item_id: crypto.randomUUID(), title: 'Supercalifragilisticexpialidociouslylongwordwithoutanyspaces' }));
  ({ page } = await open({ label: 'phone', db, path: `/day.html?t=${TAYLOR}`, ctx: phone() }));
  check('phone: no sideways scroll', await noSideScroll(page), await page.evaluate(() => document.documentElement.scrollWidth));
  const box = await size(page, '.day-check');
  const call = await size(page, '.irow-call');
  check('phone: checkboxes and call buttons are at least 44px', box.w >= 44 && box.h >= 44 && call.w >= 44 && call.h >= 44, JSON.stringify({ box, call }));
  check('phone (iPhone): the "Add to Home Screen" hint', /tap the Share button, then "Add to Home Screen"/.test(await text(page, '.day-hint')), await text(page, '.day-hint'));
  const x = await size(page, '.day-hint-x');
  check('phone: the hint\'s close button is at least 44px', x.w >= 44 && x.h >= 44, JSON.stringify(x));
  await page.screenshot({ path: SHOTS + 'day-phone.png', fullPage: true });
  await rowByTitle(page, 'Walk the dogs').locator('.day-check').click();
  await page.waitForSelector('.toast-action');
  const undoBtn = await size(page, '.toast-action .toast-btn');
  check('phone: the Undo toast fits, with 44px buttons', undoBtn.h >= 44 && undoBtn.w >= 44 && await noSideScroll(page)
    && await page.$eval('.toasts', (e) => e.getBoundingClientRect().right <= window.innerWidth), JSON.stringify(undoBtn));
  await page.screenshot({ path: SHOTS + 'day-phone-undo.png' });
  await page.click('.day-hint-x');
  check('hint: closes', !(await page.$('.day-hint')));
  await page.reload();
  await page.waitForSelector('.day-sec');
  check('hint: stays closed on this phone', !(await page.$('.day-hint')));
  await page.context().close();

  ({ page } = await open({ label: 'android', path: `/day.html?t=${TAYLOR}`, ctx: phone(ANDROID) }));
  check('phone (Android): the hint names the ⋮ menu and "Add to Home screen"', /tap the ⋮ menu, then "Add to Home screen"/.test(await text(page, '.day-hint')), await text(page, '.day-hint'));
  await page.context().close();

  ({ page } = await open({ label: 'android-es', path: `/day.html?t=${JORDAN}`, ctx: phone(ANDROID) }));
  check('phone in Spanish: the hint in Spanish', /Agregar a la pantalla principal/.test(await text(page, '.day-hint')));
  await page.context().close();

  // Storage that throws (some private modes): the page still works and the hint still closes.
  ({ page } = await open({ label: 'no-storage', path: `/day.html?t=${TAYLOR}`, ctx: phone(),
    init: () => { const no = () => { throw new Error('storage disabled'); }; Storage.prototype.getItem = no; Storage.prototype.setItem = no; } }));
  check('no storage: the page and the hint still show', (await rowsOf(page, 'today')).length === 7 && !!(await page.$('.day-hint')));
  await page.click('.day-hint-x');
  check('no storage: the hint still closes', !(await page.$('.day-hint')));
  await page.context().close();

  ({ page } = await open({ label: 'phone-confirm', path: `/day.html?t=${TAYLOR}&c=${CONFIRM}#confirm`, ctx: phone() }));
  const yes = await size(page, '[data-act="confirm"]');
  const see = await size(page, '.day-link');
  check('phone #confirm: fits, with a full-width button and 44px targets', await noSideScroll(page) && yes.h >= 44 && yes.w >= 300 && see.h >= 44 && !(await page.$('.day-hint')), JSON.stringify({ yes, see }));
  await page.screenshot({ path: SHOTS + 'day-phone-confirm.png' });
  await page.context().close();

  ({ page } = await open({ label: 'dark', path: `/day.html?t=${TAYLOR}`, ctx: Object.assign(phone(), { colorScheme: 'dark' }) }));
  const colors = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    list: getComputedStyle(document.querySelector('.day-list')).backgroundColor,
    text: getComputedStyle(document.querySelector('.irow-title')).color,
  }));
  check('dark mode: the dark colour tokens', colors.body === 'rgb(18, 17, 16)' && colors.list === 'rgb(27, 25, 23)' && colors.text === 'rgb(243, 239, 233)', JSON.stringify(colors));
  await page.screenshot({ path: SHOTS + 'day-phone-dark.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 10. Meals (v1.2): each day's last rows, in English and Spanish, with no box; the note and the
  //     recipe link only for the person on it; a locked meal's title only for them
  // =====================================================================
  const mealDb = () => {
    const d = foodDb();
    d.meals.push(
      mealRow({ day: TODAY, kind: 'cook', title: 'Tacos', cook_id: P.taylor, note: '<b>350°</b> for 20 min', link: RECIPE, private: true }),
      mealRow({ day: TOMORROW, kind: 'leftovers', cook_id: P.taylor }),
    );
    return d;
  };
  const mealsOf = (pg, which) => pg.$$eval(`section[aria-labelledby="day-${which}"] .irow`, (rs) => rs.map((r) => ({
    meal: r.classList.contains('k-meal'), title: r.querySelector('.irow-title').textContent, top: r.querySelector('.irow-time span').textContent,
    sub: (r.querySelector('.irow-sub') || { textContent: '' }).textContent, box: !!r.querySelector('.day-check, .irow-box'),
    note: (r.querySelector('.meal-note') || { textContent: null }).textContent,
    link: r.querySelector('.meal-recipe') ? { href: r.querySelector('.meal-recipe').getAttribute('href'), target: r.querySelector('.meal-recipe').target,
      rel: r.querySelector('.meal-recipe').rel, text: r.querySelector('.meal-recipe').textContent } : null,
  })));
  db = mealDb();
  ({ page } = await open({ label: 'meals-es', db, path: `/day.html?t=${TAYLOR}`, ctx: phone() }));
  let meals = await mealsOf(page, 'today');
  const tacos = meals[meals.length - 1];
  check('meals (es): the day\'s last row, "Cena", the title she is on even when locked, "Cocinas tú", no box',
    meals.length === 8 && meals.slice(0, 7).every((r) => !r.meal) && tacos.meal && tacos.top === 'Cena' && tacos.title === 'Tacos' && tacos.sub === 'Cocinas tú' && !tacos.box,
    JSON.stringify(tacos));
  check('meals (es): the note for the person on it, as text', tacos.note === '<b>350°</b> for 20 min' && !(await page.$('.k-meal b')), JSON.stringify(tacos.note));
  check('meals (es): a Receta link for the person on it: its host shown, a new tab, no opener, no referrer',
    !!tacos.link && tacos.link.href === RECIPE && tacos.link.target === '_blank' && tacos.link.rel === 'noopener noreferrer' && tacos.link.text === 'Receta · cooking.example.com',
    JSON.stringify(tacos.link));
  meals = await mealsOf(page, 'tomorrow');
  check('meals (es): leftovers she is on: "Sobras", "Te encargas tú", nothing else',
    meals.length === 3 && same(meals[2], { meal: true, title: 'Sobras', top: 'Cena', sub: 'Te encargas tú', box: false, note: null, link: null }), JSON.stringify(meals[2]));
  check('meals (es): no list, so no list button and no list request', !(await page.$('.day-list-btn')) && calls(db, 'get_list_by_token').length === 0);
  check('meals (phone): no sideways scroll; the recipe link is a 44px target', await noSideScroll(page) && (await size(page, '.meal-recipe')).h >= 44);
  await page.screenshot({ path: SHOTS + 'day-meals-es.png', fullPage: true });
  await page.context().close();

  ({ page, db } = await open({ label: 'meals-en', db: mealDb(), path: `/day.html?t=${MORGAN}` }));
  meals = await mealsOf(page, 'today');
  check('meals (en, a kid not on it): "Dinner", "Private item" for a locked one, "Taylor cooks", no note, no link, no box',
    same(meals, [{ meal: true, title: 'Private item', top: 'Dinner', sub: 'Taylor cooks', box: false, note: null, link: null }]), JSON.stringify(meals));
  check('meals (en): a day with only a meal has no "Nothing planned" line',
    !(await page.$('section[aria-labelledby="day-today"] .empty-line')) && same(await mealsOf(page, 'tomorrow'), [{ meal: true, title: 'Leftovers', top: 'Dinner', sub: "Taylor's on dinner", box: false, note: null, link: null }]),
    await text(page, 'section[aria-labelledby="day-today"]'));
  const mealLook = await page.$eval('.irow.k-meal .irow-title', (e) => getComputedStyle(e).fontWeight);
  check('meals (en): a muted look (day.css)', Number(mealLook) < 600, mealLook);
  await page.context().close();
  ({ page, db } = await open({ label: 'meals-kid-es', db: mealDb(), path: `/day.html?t=${JORDAN}` }));
  meals = await mealsOf(page, 'today');
  check('meals (es, a kid not on it): "Asunto privado", "Cocina Taylor", after his items',
    same(meals.map((r) => [r.meal, r.title, r.sub]).slice(-1), [[true, 'Asunto privado', 'Cocina Taylor']]) && meals.length === 3 && meals[2].link === null && meals[2].note === null, JSON.stringify(meals));
  await page.context().close();

  // =====================================================================
  // 11. The list's button and the background read (v1.2): only with get_person_day's list
  // =====================================================================
  db = withList(foodDb());
  db.slow = { get_person_day: 400 };
  ({ page, db } = await open({ label: 'list-button', db, path: `/day.html?t=${TAYLOR}` }));
  check('the list button: under the greeting, "Lista de compras · 4 ›" (her language; unlocked lines only)',
    (await text(page, '.day-head + .day-shop .day-list-btn')) === 'Lista de compras · 4 ›' && (await page.getAttribute('.day-list-btn', 'href')) === '#list',
    await text(page, '.day-shop'));
  check('background read: get_list_by_token({ p_token }) once, after get_person_day was answered (never at the same time)',
    await until(() => calls(db, 'get_list_by_token').length === 1) && same(db.calls.map((c) => c.name), ['get_person_day', 'get_list_by_token'])
    && same(calls(db, 'get_list_by_token')[0].body, { p_token: TAYLOR }) && calls(db, 'get_list_by_token')[0].at >= calls(db, 'get_person_day')[0].done,
    JSON.stringify(db.calls.map((c) => [c.name, c.at, c.done])));
  let saved = null;
  await until(async () => { saved = await page.evaluate(() => localStorage.getItem('homehub.shop.day')); return !!saved && /Cebollas/.test(saved); });
  check('background read: the list is saved on the phone under the token\'s hash, never the token, with nothing locked',
    !!saved && JSON.parse(saved).owner === hashOf(TAYLOR) && !saved.includes(TAYLOR) && !/Pregnancy|Vitamins/.test(saved)
    && same(JSON.parse(saved).snap.items.map((r) => r.name), ['Cebollas', 'Cilantro', 'Milk', 'Tortillas']), String(saved).slice(0, 200));
  db.slow = null;
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(() => calls(db, 'get_person_day').length === 2);
  await page.waitForTimeout(300);
  check('a refresh with the same count: no new list read', calls(db, 'get_list_by_token').length === 1, db.calls.map((c) => c.name).join(','));
  foodRpc.add_to_list(db, { p_name: 'Plátanos' }, 'alex@example.com');
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check('a refresh with a different count: the list is read again, and the button says so',
    await until(async () => calls(db, 'get_list_by_token').length === 2 && (await text(page, '.day-list-btn')) === 'Lista de compras · 5 ›'), await text(page, '.day-list-btn'));
  await page.click('.day-list-btn');
  check('the button opens #list', await until(async () => (await text(page, '.list-head h1')) === 'Lista de compras') && await page.evaluate(() => location.hash === '#list'));
  await page.click('.list-back');
  check('‹ Mi día goes back to the day', await until(async () => !!(await page.$('section[aria-labelledby="day-today"]')) && await page.evaluate(() => location.hash === '')));
  await page.context().close();

  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-kid', db, path: `/day.html?t=${JORDAN}#list` }));
  await page.waitForTimeout(300);
  check('a kid: no list button, no list request, and #list shows the day',
    !(await page.$('.day-list-btn, .list-head')) && !!(await page.$('.day-sec')) && db.calls.every((c) => c.name === 'get_person_day'), db.calls.map((c) => c.name).join(','));
  await page.context().close();

  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-off', db, path: `/day.html?t=${TAYLOR}` }));
  await until(async () => /Cebollas/.test(await page.evaluate(() => localStorage.getItem('homehub.shop.day') || '')));
  db.household[0].helper_list = 'off';
  await page.reload();
  await page.waitForSelector('.day-sec');
  await page.waitForTimeout(300);
  check('the switch Off: no button, no list request, and the list saved for this link is removed',
    !(await page.$('.day-list-btn')) && calls(db, 'get_list_by_token').length === 1 && (await page.evaluate(() => localStorage.getItem('homehub.shop.day'))) === null,
    db.calls.map((c) => c.name).join(','));
  await page.context().close();

  // =====================================================================
  // 12. #list in Spanish at 390px: aisles, big rows, ticks in place, Undo, Comprado hoy, add
  // =====================================================================
  const LIST_ERRORS = /status of (400|401|403|404|409|413|503)|ERR_INTERNET_DISCONNECTED/;
  const listView = (pg) => pg.evaluate(() => {
    const rowsIn = (el) => (el ? [...el.querySelectorAll('.lrow')].map((r) => ({
      name: (r.querySelector('.lrow-name') || {}).textContent, note: (r.querySelector('.lrow-note') || { textContent: '' }).textContent,
      checked: r.getAttribute('aria-checked'), unsent: (r.querySelector('.lrow-unsent') || { textContent: '' }).textContent,
    })) : []);
    const sec = document.querySelector('section.list-sec:not(.list-bought)');
    return {
      aisles: sec ? [...sec.querySelectorAll('h3')].map((h) => h.textContent) : [],
      toBuy: rowsIn(sec),
      boughtHead: (document.querySelector('.list-bought h2') || { textContent: '' }).textContent,
      bought: rowsIn(document.querySelector('.list-bought')),
      empty: (document.querySelector('.list-empty') || { textContent: '' }).textContent,
    };
  });
  const names = (rs) => rs.map((r) => r.name);
  const lrow = (pg, name) => pg.locator('.lrow', { has: pg.locator('.lrow-name', { hasText: new RegExp(`^${name}`) }) });
  const toasts = (pg) => pg.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
  const typeAdd = async (pg, s) => { await pg.fill('.list-input', s); await pg.press('.list-input', 'Enter'); };

  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-es', db, path: `/day.html?t=${TAYLOR}#list`, ctx: phone(), allowConsole: LIST_ERRORS }));
  let lv = await listView(page);
  check('#list (es): heading, back link, page language and title', (await text(page, '.list-head h1')) === 'Lista de compras' && (await text(page, '.list-back')) === '‹ Mi día'
    && (await page.evaluate(() => document.documentElement.lang)) === 'es' && (await page.title()) === 'Lista de compras · Mi día', await page.title());
  check('#list: opened from the link, it reads the list after the day (one request at a time)',
    same(db.calls.map((c) => c.name).slice(0, 2), ['get_person_day', 'get_list_by_token']) && calls(db, 'get_list_by_token').every((c) => same(c.body, { p_token: TAYLOR })),
    db.calls.map((c) => c.name).join(','));
  check('#list: aisle headings in Spanish, in store order, as h3', same(lv.aisles, ['Frutas y verduras', 'Panadería', 'Lácteos y huevos'])
    && (await page.$$eval('section.list-sec:not(.list-bought) .list-aisle', (hs) => hs.every((h) => h.tagName === 'H3'))), JSON.stringify(lv.aisles));
  check('#list: rows A–Z in each aisle, "Milk · leche" (the word in her language), the note small', same(names(lv.toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche'])
    && same(lv.toBuy.map((r) => r.note), ['3', '', '', '2']), JSON.stringify(lv.toBuy));
  const rowLook = await page.$$eval('section.list-sec:not(.list-bought) .lrow', (rs) => rs.map((r) => ({
    tag: r.tagName, role: r.getAttribute('role'), checked: r.getAttribute('aria-checked'), h: r.getBoundingClientRect().height, w: r.getBoundingClientRect().width,
    font: getComputedStyle(r.querySelector('.lrow-name')).fontSize })));
  check('#list: the whole row is the checkbox (role checkbox, aria-checked), at least 56px tall, 18px text',
    rowLook.every((r) => r.tag === 'BUTTON' && r.role === 'checkbox' && r.checked === 'false' && r.h >= 56 && r.w >= 300 && r.font === '18px'), JSON.stringify(rowLook[0]));
  check('#list: Comprado hoy (1): this morning\'s Huevos, ticked; nothing locked, no family names, no ids of people',
    lv.boughtHead === 'Comprado hoy (1)' && same(names(lv.bought), ['Huevos']) && lv.bought[0].checked === 'true'
    && !/Pregnancy|Vitamins|Alex|Sam |p-alex|p-sam/.test(await page.evaluate(() => document.body.innerHTML)), JSON.stringify(lv.bought));
  const addBox = await page.$eval('.list-input', (i) => ({ ph: i.placeholder, max: i.maxLength, font: getComputedStyle(i).fontSize, h: i.getBoundingClientRect().height }));
  check('#list: the add box (she can add): "Añadir algo…", at most 100 characters, 16px text, and "Añadir"',
    same(addBox, { ph: 'Añadir algo…', max: 100, font: '16px', h: addBox.h }) && addBox.h >= 44 && (await text(page, '.list-add-btn')) === 'Añadir', JSON.stringify(addBox));
  check('#list: Comprar otra vez (3) ›, folded away under the add box', (await text(page, '.list-again summary')) === 'Comprar otra vez (3) ›'
    && !(await page.$eval('.list-again', (d) => d.open)) && (await page.$eval('.list-add', (f) => !!(f.nextElementSibling && f.nextElementSibling.querySelector('.list-again')))));
  check('#list (phone): no sideways scroll', await noSideScroll(page));
  await page.screenshot({ path: SHOTS + 'day-list-es.png', fullPage: true });
  // From here the page's clock moves only when the test says, so "3 seconds after the last tap" is exact.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));

  // ---- Tick: where it is, then Comprado hoy 3 seconds after the last tap
  await lrow(page, 'Cebollas').click();
  lv = await listView(page);
  check('tick: the row is checked and struck through where it is', same(names(lv.toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']) && lv.toBuy[0].checked === 'true'
    && (await page.$eval('.lrow[aria-checked="true"] .lrow-name', (e) => getComputedStyle(e).textDecorationLine)) === 'line-through', JSON.stringify(lv.toBuy));
  check('tick: "Comprado: Cebollas" with Deshacer and ×', (await text(page, '.toast-action span')) === 'Comprado: Cebollas' && same(await texts(page, '.toast-action button'), ['Deshacer', '×']));
  await until(() => calls(db, 'buy_item_by_token').length === 1);
  check('tick: buy_item_by_token with the token, the line, true and the seen it was shown with (microseconds kept)',
    same(keyed(calls(db, 'buy_item_by_token')[0].body), { p_token: TAYLOR, p_item: itemOf(db, 'Cebollas').id, p_bought: true, p_seen: '2026-10-24T22:15:03.123456+00:00' }),
    JSON.stringify(calls(db, 'buy_item_by_token')[0].body));
  await lrow(page, 'Cilantro').click();
  lv = await listView(page);
  check('a quick second tap: the next row is ticked too, and nothing has moved', same(names(lv.toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche'])
    && same(lv.toBuy.map((r) => r.checked), ['true', 'true', 'false', 'false']), JSON.stringify(lv.toBuy));
  check('the next tick\'s toast replaces the first one', (await page.$$('.toast-action')).length === 1 && (await text(page, '.toast-action span')) === 'Comprado: Cilantro');
  await page.clock.runFor(2000);
  check('2 seconds after the last tap: still in place', same(names((await listView(page)).toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']));
  await page.clock.runFor(2000);
  lv = await listView(page);
  check('3 seconds after the last tap: both under Comprado hoy, the latest first, and the right ones',
    same(names(lv.toBuy), ['Tortillas', 'Milk · leche']) && same(names(lv.bought), ['Cilantro', 'Cebollas', 'Huevos']) && lv.boughtHead === 'Comprado hoy (3)'
    && itemOf(db, 'Cebollas').bought_by === P.taylor && itemOf(db, 'Cilantro').bought_by === P.taylor && itemOf(db, 'Tortillas').bought_at === null, JSON.stringify(lv));
  check('tick: the toast stays for the 15 minutes Undo works', await page.$eval('.toast-action', () => true).catch(() => false));

  // ---- Deshacer: buy_item_by_token(false) with the seen of her tick
  const cilantroBought = itemOf(db, 'Cilantro').bought_at;
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await until(() => calls(db, 'buy_item_by_token').length === 3);
  check('Deshacer: buy_item_by_token with false and the seen of her tick (from the reply)',
    same(keyed(calls(db, 'buy_item_by_token')[2].body), { p_token: TAYLOR, p_item: itemOf(db, 'Cilantro').id, p_bought: false, p_seen: cilantroBought }), JSON.stringify(calls(db, 'buy_item_by_token')[2].body));
  check('Deshacer: "Deshecho…", and Cilantro is back to buy', await until(async () => (await text(page, '.toast')) === 'Deshecho. Vuelve a estar en tu lista.'
    && same(names((await listView(page)).toBuy), ['Cilantro', 'Tortillas', 'Milk · leche'])), JSON.stringify(await listView(page)));
  await toasts(page);

  // ---- Comprado hoy: her own tick unticks at once; an older one offers "¿Añadir otra vez?"
  const cebollasBought = itemOf(db, 'Cebollas').bought_at;
  await lrow(page, 'Cebollas').click();
  check('tapping her own tick under Comprado hoy: unticked at once, no question, the undone toast',
    (await lrow(page, 'Cebollas').getAttribute('aria-checked')) === 'false' && (await text(page, '.toast')) === 'Deshecho. Vuelve a estar en tu lista.' && !(await page.$('.toast-action')));
  await until(() => calls(db, 'buy_item_by_token').length === 4);
  check('... with buy_item_by_token(false) and its seen', same(keyed(calls(db, 'buy_item_by_token')[3].body), { p_token: TAYLOR, p_item: itemOf(db, 'Cebollas').id, p_bought: false, p_seen: cebollasBought }));
  await page.clock.runFor(3000);
  check('... and it is back to buy once the finger is off the list', same(names((await listView(page)).toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']));
  await toasts(page);
  // ---- One row tapped three times before it moves, each tap answered before the next. Every un-tick
  // gives the line a new seen (§4.2), so a tap on a row already changed here goes by id, with the seen
  // the list has now: no "Cambiado en otro teléfono", and the row ends as tapped.
  const tapAnswered = async (name) => {
    const n = calls(db, 'buy_item_by_token').length;
    await lrow(page, name).click();
    await until(() => calls(db, 'buy_item_by_token').length > n);
    await page.waitForTimeout(250);   // its answer taken
  };
  const tortSeen0 = itemOf(db, 'Tortillas').added_at;
  let taps0 = calls(db, 'buy_item_by_token').length;
  await tapAnswered('Tortillas');   // tick
  const tortBought = itemOf(db, 'Tortillas').bought_at;
  await tapAnswered('Tortillas');   // take it back (an Undo: a new seen)
  const tortSeen1 = itemOf(db, 'Tortillas').added_at;
  await tapAnswered('Tortillas');   // tick again
  let tortCalls = calls(db, 'buy_item_by_token').slice(taps0).map((c) => [c.body.p_bought, c.body.p_seen]);
  check('to buy: tick, take back, tick on one row before it moves: each with the row\'s seen at that moment (the last the new seen of her Undo); bought, nothing else said',
    same(tortCalls, [[true, tortSeen0], [false, tortBought], [true, tortSeen1]]) && tortSeen1 !== tortSeen0 && itemOf(db, 'Tortillas').bought_by === P.taylor
    && (await lrow(page, 'Tortillas').getAttribute('aria-checked')) === 'true' && !(await texts(page, '.toast')).some((x) => x.includes('Cambiado')),
    JSON.stringify([tortCalls, tortSeen0, tortSeen1, await texts(page, '.toast')]));
  await page.clock.runFor(3000);
  await toasts(page);
  taps0 = calls(db, 'buy_item_by_token').length;
  await tapAnswered('Tortillas');   // her tick under Comprado hoy: taken back
  await tapAnswered('Tortillas');   // ticked again
  const tortBought2 = itemOf(db, 'Tortillas').bought_at;
  await tapAnswered('Tortillas');   // taken back again
  tortCalls = calls(db, 'buy_item_by_token').slice(taps0).map((c) => [c.body.p_bought, c.body.p_seen]);
  check('Comprado hoy: take back, tick, take back on her own tick before it moves: the last with the new tick\'s seen; to buy, nothing else said',
    tortCalls.length === 3 && same(tortCalls.map((c) => c[0]), [false, true, false]) && tortCalls[2][1] === tortBought2 && itemOf(db, 'Tortillas').bought_at === null
    && (await lrow(page, 'Tortillas').getAttribute('aria-checked')) === 'false' && !(await texts(page, '.toast')).some((x) => x.includes('Cambiado')),
    JSON.stringify([tortCalls, tortBought2, await texts(page, '.toast')]));
  await page.clock.runFor(3000);
  check('... and 3 seconds later Tortillas is to buy', same(names((await listView(page)).toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']), JSON.stringify(await listView(page)));
  await toasts(page);
  const before = db.calls.length;
  await lrow(page, 'Huevos').click();
  check('a bought line she can\'t undo (Alex\'s): "¿Añadir otra vez?", nothing sent yet',
    (await text(page, '.toast-action span')) === 'Huevos' && (await texts(page, '.toast-action button'))[0] === '¿Añadir otra vez?' && db.calls.length === before);
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await until(() => calls(db, 'add_to_list_by_token').length === 1);
  check('"¿Añadir otra vez?" adds it again by name', same(keyed(calls(db, 'add_to_list_by_token')[0].body), { p_token: TAYLOR, p_name: 'Huevos' }));
  // The answer's toast lasts 3 seconds of the page's clock, so look for it before running the clock on.
  const backToast = await until(async () => (await text(page, '.toast')) === 'Otra vez en la lista');
  const backToastText = await text(page, '.toasts');
  await page.clock.runFor(3000);   // the tap on Huevos was a tap on the list: it moves 3 seconds later
  check('... "Otra vez en la lista", and Huevos is to buy', backToast && await until(async () => names((await listView(page)).toBuy).includes('Huevos')),
    `${backToastText} ${JSON.stringify((await listView(page)).toBuy)}`);
  await toasts(page);

  // ---- The add box: Enter, the reply's words, the box keeps the focus
  await typeAdd(page, 'Leche');
  await until(() => calls(db, 'add_to_list_by_token').length === 2);
  check('add: add_to_list_by_token with the text as typed', same(keyed(calls(db, 'add_to_list_by_token')[1].body), { p_token: TAYLOR, p_name: 'Leche' }));
  check('add "Leche" while Milk is to buy: "Ya está en la lista como Milk"', await until(async () => (await text(page, '.toast')) === 'Ya está en la lista como Milk'), await text(page, '.toasts'));
  check('add: the box is empty and keeps the focus', (await page.$eval('.list-input', (i) => i.value)) === '' && await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('list-input')));
  await toasts(page);
  await typeAdd(page, 'milk');
  check('add "milk": "Ya está en la lista"', await until(async () => (await text(page, '.toast')) === 'Ya está en la lista'), await text(page, '.toasts'));
  await toasts(page);
  await typeAdd(page, '2 tomates');
  check('add "2 tomates": a new line under its aisle, its amount as the note, no toast',
    await until(async () => (await listView(page)).toBuy.some((r) => r.name === 'tomates' && r.note === '2')) && !(await page.$('.toast')), JSON.stringify((await listView(page)).toBuy));

  // ---- Comprar otra vez: by aisle; one tap adds it by name
  await page.click('.list-again summary');
  const again = await page.$$eval('.list-again .list-aisle', (hs) => hs.map((h) => [h.textContent, [...h.nextElementSibling.querySelectorAll('.list-chip')].map((c) => c.textContent)]));
  check('Comprar otra vez: lately bought names by aisle (none locked, none older than 30 days)', same(again, [['Despensa', ['Arroz']], ['Limpieza y hogar', ['Jabón']]]), JSON.stringify(again));
  await page.click('.list-chip[data-key="again|Arroz"]');
  await until(() => calls(db, 'add_to_list_by_token').length === 5);
  check('Comprar otra vez: a tap adds it by name, "Otra vez en la lista"', same(keyed(calls(db, 'add_to_list_by_token')[4].body), { p_token: TAYLOR, p_name: 'Arroz' })
    && await until(async () => (await text(page, '.toast')) === 'Otra vez en la lista'));
  await page.clock.runFor(3000);
  check('Comprar otra vez: stays open, now without Arroz', await until(async () => (await page.$eval('.list-again', (d) => d.open)) && (await text(page, '.list-again summary')) === 'Comprar otra vez (1) ›'));
  await toasts(page);

  // ---- Suggestions as she types (from suggest, in either language), with the amount kept
  await page.fill('.list-input', '2 jab');
  check('suggestions: "2 jab" suggests Jabón', same(await texts(page, '.list-suggest .list-sug'), ['Jabón']), JSON.stringify(await texts(page, '.list-suggest .list-sug')));
  await page.click('.list-sug');
  await until(() => calls(db, 'add_to_list_by_token').length === 6);
  check('suggestions: picking one adds it with the amount typed', same(keyed(calls(db, 'add_to_list_by_token')[5].body), { p_token: TAYLOR, p_name: 'Jabón: 2' })
    && (await page.$eval('.list-input', (i) => i.value)) === '' && await page.$eval('.list-suggest', (e) => e.hidden));
  await page.fill('.list-input', 'zz');
  check('suggestions: none for a name she hasn\'t bought', await page.$eval('.list-suggest', (e) => e.hidden));
  await page.fill('.list-input', '');
  await toasts(page);
  await page.screenshot({ path: SHOTS + 'day-list-es-after.png', fullPage: true });

  // ---- Each new error word in Spanish (not "Esa tarea ya no está en tu lista")
  const refusals = [
    ['an add', [400, '22023', 'Type what to buy.'], 'Escribe qué comprar.'],
    ['an add', [413, '54000', 'The list is full.'], 'La lista está llena.'],
    ['an add', [401, '42501', "The shopping list isn't on your My day."], 'La lista de compras no está en tu Mi día.'],
    ['an add', [401, '42501', "You can't add to the list from My day."], 'La lista de compras no está en tu Mi día.'],
    ['a tick', [401, '42501', 'Only your own tick can be undone, for 15 minutes.'], 'Eso ya no se puede deshacer aquí. Pide a la familia que lo corrija.'],
  ];
  for (const [what, err, words] of refusals) {
    db.listError = err;
    if (what === 'an add') await typeAdd(page, 'Pan dulce');
    else await lrow(page, 'Tortillas').click();
    const shown = await page.waitForSelector('.toast-error', { timeout: 3000 }).then(() => text(page, '.toast-error')).catch(() => '');
    check(`refused (${err[2]}): "${words}"`, shown === words, shown);
    await toasts(page);
    await page.clock.runFor(3000);
  }
  check('a refused change is dropped: no "Pan dulce", Tortillas still to buy', await until(async () => {
    const v = await listView(page);
    return !names(v.toBuy).includes('Pan dulce') && v.toBuy.some((r) => r.name === 'Tortillas' && r.checked === 'false');
  }), JSON.stringify(await listView(page)));
  // The day's caps, as private.count_my_day keeps them: 30 changes and 100 ticks already today.
  const use = db.my_day_use.find((r) => r.person_id === P.taylor && r.day === TODAY);
  if (use) Object.assign(use, { changes: 30, ticks: 100 });
  else db.my_day_use.push({ person_id: P.taylor, day: TODAY, changes: 30, ticks: 100 });
  await typeAdd(page, 'Pan dulce');
  check('the day\'s cap on changes: "Es mucho para un día…"', await page.waitForSelector('.toast-error', { timeout: 3000 }).then(() => text(page, '.toast-error')).catch(() => '')
    .then((s) => s === 'Es mucho para un día. Pide a la familia que añada el resto.'), await text(page, '.toasts'));
  await toasts(page);
  await lrow(page, 'Tortillas').click();
  check('the day\'s cap on ticks: the same words', await page.waitForSelector('.toast-error', { timeout: 3000 }).then(() => text(page, '.toast-error')).catch(() => '')
    .then((s) => s === 'Es mucho para un día. Pide a la familia que añada el resto.'), await text(page, '.toasts'));
  await page.context().close();

  // ---- Deshacer after the row has moved to Comprado hoy, while a tap on the list holds it there: the row
  // is unticked where it is, and a tap on it goes by id, never with the bought_at it was drawn with (the
  // Undo replaced it). Ticked again, then taken back before that answer comes: each with the line's seen
  // at that moment, and Cilantro ends as last tapped, with no "Cambiado en otro teléfono".
  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-undo-moved', db, path: `/day.html?t=${TAYLOR}#list`, ctx: phone(), allowConsole: LIST_ERRORS }));
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  await lrow(page, 'Cebollas').click();
  await lrow(page, 'Cilantro').click();
  await until(() => calls(db, 'buy_item_by_token').length === 2);
  await page.clock.runFor(3100);                                       // both under Comprado hoy
  const movedDay = names((await listView(page)).bought).includes('Cilantro');
  const cilBought = itemOf(db, 'Cilantro').bought_at;
  await lrow(page, 'Cebollas').click();                                // she takes back Cebollas: the list holds
  await until(() => calls(db, 'buy_item_by_token').length === 3);
  await page.click('.toast-action .toast-btn:not(.toast-x)');          // Deshacer on "Comprado: Cilantro"
  await until(() => calls(db, 'buy_item_by_token').length === 4 && itemOf(db, 'Cilantro').bought_at === null);
  await page.waitForTimeout(250);
  const afterDeshacer = await lrow(page, 'Cilantro').getAttribute('aria-checked');
  const cilSeen = itemOf(db, 'Cilantro').added_at;
  const said = [];
  const c0 = calls(db, 'buy_item_by_token').length;
  db.slow = { buy_item_by_token: 1500 };
  await lrow(page, 'Cilantro').click();                                // ticked again
  said.push(...await texts(page, '.toast'));
  await page.waitForTimeout(300);
  await lrow(page, 'Cilantro').click();                                // and taken back, before that answer
  said.push(...await texts(page, '.toast'));
  const shownDay = await lrow(page, 'Cilantro').getAttribute('aria-checked');
  await until(() => calls(db, 'buy_item_by_token').length === c0 + 2 && itemOf(db, 'Cilantro').bought_at === null, 8000);
  await page.waitForTimeout(400);
  said.push(...await texts(page, '.toast'));
  db.slow = null;
  const cilCalls = calls(db, 'buy_item_by_token').slice(c0).map((c) => [c.body.p_bought, c.body.p_seen]);
  check('Deshacer after the row moved to Comprado hoy (the list held): unticked where it is; tapped again it goes by id with the new seen, and tick then take back end as tapped, with no "Cambiado"',
    movedDay && afterDeshacer === 'false' && cilCalls.length === 2 && same(cilCalls[0], [true, cilSeen]) && cilCalls[1][0] === false && cilCalls[1][1] !== cilBought
    && shownDay === 'false' && itemOf(db, 'Cilantro').bought_at === null && !said.some((x) => x.includes('Cambiado')),
    JSON.stringify([movedDay, afterDeshacer, cilCalls, cilBought, cilSeen, shownDay, said]));
  await page.context().close();

  // ---- See and tick: no add box, no Comprar otra vez, an old tick does nothing
  db = withList(foodDb({ helperList: 'see' }));
  ({ page, db } = await open({ label: 'list-see', db, path: `/day.html?t=${TAYLOR}#list`, ctx: phone() }));
  check('See and tick: no add box and no Comprar otra vez', await page.$eval('.list-add', (f) => f.hidden) && !(await page.$('.list-again')) && (await listView(page)).toBuy.length === 4);
  await lrow(page, 'Huevos').click({ force: true });   // aria-disabled: Playwright would wait for it to be enabled
  await page.waitForTimeout(300);
  check('See and tick: tapping a bought line she can\'t undo does nothing', !(await page.$('.toast')) && db.calls.every((c) => c.name !== 'add_to_list_by_token' && c.name !== 'buy_item_by_token')
    && (await lrow(page, 'Huevos').getAttribute('aria-disabled')) === 'true');
  await page.context().close();

  // ---- Empty, English, dark
  db = foodDb({ lang: 'en' });
  db.shopping_items.push(shopItem({ name: 'Huevos', aisle: 'dairy', added_at: '2026-10-23T12:00:00.000000+00:00', bought_at: '2026-10-25T13:30:00.111111+00:00', bought_by: P.alex }));
  ({ page, db } = await open({ label: 'list-en-empty', db, path: `/day.html?t=${TAYLOR}#list`, ctx: Object.assign(phone(), { colorScheme: 'dark' }) }));
  check('#list (en): "Shopping list", "‹ My day", "Nothing to buy", "Bought today (1)", "Add something…"',
    (await text(page, '.list-head h1')) === 'Shopping list' && (await text(page, '.list-back')) === '‹ My day' && (await listView(page)).empty === 'Nothing to buy'
    && (await listView(page)).boughtHead === 'Bought today (1)' && (await page.getAttribute('.list-input', 'placeholder')) === 'Add something…');
  check('#list (phone, dark): no sideways scroll; the rows on the dark surface', await noSideScroll(page)
    && (await page.$eval('.list-rows', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(27, 25, 23)');
  await page.screenshot({ path: SHOTS + 'day-list-en-dark.png', fullPage: true });
  await page.context().close();

  // =====================================================================
  // 13. Reading the list again: every 10 seconds, only on #list, only while visible; a change waits
  //     for the finger; no redraw when nothing changed
  // =====================================================================
  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-poll', db, path: `/day.html?t=${TAYLOR}`, allowConsole: LIST_ERRORS }));
  await until(() => calls(db, 'get_list_by_token').length === 1);
  const pageNow = () => page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date((await pageNow()) + 1000));
  const reads = () => calls(db, 'get_list_by_token').length;
  const settle = async (n) => { await until(() => reads() === n); await page.waitForTimeout(150); };
  await page.clock.runFor(30000);
  await page.waitForTimeout(200);
  check('the day view: no 10-second read', reads() === 1, reads());
  await page.click('.day-list-btn');
  await settle(2);
  check('#list: read at once on opening', reads() === 2);
  await page.clock.runFor(10000);
  await settle(3);
  check('#list: read again after 10 seconds', reads() === 3, reads());
  await page.$eval('section.list-sec .lrow', (r) => { r.dataset.mark = 'same'; });
  await page.clock.runFor(10000);
  await settle(4);
  check('no redraw when the answer is the same (as_of aside)', (await page.$eval('section.list-sec .lrow', (r) => r.dataset.mark || '')) === 'same');
  foodRpc.add_to_list(db, { p_name: 'Plátanos' }, 'alex@example.com');
  db.foodNow += 60e3;
  await page.clock.runFor(10000);
  await settle(5);
  check('a line added on another phone shows within 10 seconds', await until(async () => names((await listView(page)).toBuy).includes('Plátanos')), JSON.stringify(names((await listView(page)).toBuy)));
  // A tap just before a read: the read's change waits until 3 seconds after the tap.
  await page.clock.runFor(9500);
  await lrow(page, 'Tortillas').click();
  await until(() => calls(db, 'buy_item_by_token').length === 1);
  await page.waitForTimeout(200);   // its answer is in
  foodRpc.add_to_list(db, { p_name: 'Café' }, 'alex@example.com');
  await page.clock.runFor(600);
  await settle(6);
  lv = await listView(page);
  check('held: a read right after a tap moves nothing (no new line, the tick still in place)', !names(lv.toBuy).includes('Café') && lv.toBuy.some((r) => r.name === 'Tortillas' && r.checked === 'true'), JSON.stringify(names(lv.toBuy)));
  await page.clock.runFor(3000);
  lv = await listView(page);
  check('... and 3 seconds after the tap the list moves', names(lv.toBuy).includes('Café') && names(lv.bought).includes('Tortillas'), JSON.stringify(lv));
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenAt = reads();
  await page.clock.runFor(60000);
  await page.waitForTimeout(200);
  check('hidden: no reads', reads() === hiddenAt, reads() - hiddenAt);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  check('visible again: read at once', await until(() => reads() === hiddenAt + 1), reads() - hiddenAt);
  await page.click('.list-back');
  await page.waitForSelector('.day-sec');
  const dayAt = reads();
  await page.clock.runFor(60000);
  await page.waitForTimeout(200);
  check('back on the day view: the 10-second read stops', reads() === dayAt, reads() - dayAt);
  await page.context().close();

  // =====================================================================
  // 14. The outbox: no answer, "sin enviar", the banner, a reload, sent once; a 503 retried;
  //     a tick that waited while the line was bought and added again; a null answer
  // =====================================================================
  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-outbox', db, path: `/day.html?t=${TAYLOR}#list`, ctx: phone(), allowConsole: LIST_ERRORS }));
  const tortillasSeen = itemOf(db, 'Tortillas').added_at;
  db.offline = true;
  await lrow(page, 'Tortillas').click();
  await page.clock.fastForward('00:03');
  lv = await listView(page);
  check('no answer: the tick shows, under Comprado hoy, marked "⟳ sin enviar"', await until(async () => {
    lv = await listView(page);
    return lv.bought.some((r) => r.name === 'Tortillas' && r.unsent === '⟳ sin enviar');
  }), JSON.stringify(lv.bought));
  check('no answer: no banner before 15 seconds', !(await page.$('.list-unsent')));
  await page.clock.fastForward('00:15');
  check('after 15 seconds: "1 cambios sin enviar…"', await until(async () => (await text(page, '.list-unsent')) === '1 cambios sin enviar. Se enviarán cuando haya señal; no cierres esta página.'),
    await text(page, '.list-banners'));
  check('nothing reached the database', calls(db, 'buy_item_by_token').length === 0);
  await page.reload();
  await page.waitForSelector('.list-head');
  await page.waitForFunction(() => !document.querySelector('.loading'));
  lv = await listView(page);
  check('a reload with no answer: the saved list, "Sin conexión" with its day (the day itself didn\'t load), the tick still waiting',
    (await text(page, '.list-offline p')) === 'Sin conexión: esta es la lista de las dom 10:00.' && lv.bought.some((r) => r.name === 'Tortillas' && r.unsent === '⟳ sin enviar')
    && !names(lv.toBuy).includes('Tortillas') && (await text(page, '.list-offline .btn')) === 'Intentar de nuevo', `${await text(page, '.list-banners')} ${JSON.stringify(lv.bought)}`);
  db.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  check('back online: the tick is sent once, with the seen it was shown with', await until(() => calls(db, 'buy_item_by_token').length === 1)
    && same(keyed(calls(db, 'buy_item_by_token')[0].body), { p_token: TAYLOR, p_item: itemOf(db, 'Tortillas').id, p_bought: true, p_seen: tortillasSeen }) && itemOf(db, 'Tortillas').bought_by === P.taylor);
  check('back online: the banners and the marks go', await until(async () => !(await page.$('.list-offline, .list-unsent, .lrow-unsent'))), await text(page, '.list-banners'));
  await page.waitForTimeout(500);
  check('... and nothing is sent twice', calls(db, 'buy_item_by_token').length === 1);
  await toasts(page);

  // A 503 is kept and sent again; a tick that waited while Alex bought the line and put it back
  // doesn't buy the new need: "Cambiado en otro teléfono".
  db.status = { buy_item_by_token: 503 };
  await lrow(page, 'Cebollas').click();
  await until(() => calls(db, 'buy_item_by_token').length === 2);
  db.status = null;
  await page.clock.fastForward('00:03');
  check('a 503 is sent again (2 seconds later)', await until(() => calls(db, 'buy_item_by_token').length === 3) && same(calls(db, 'buy_item_by_token')[2].body, calls(db, 'buy_item_by_token')[1].body)
    && itemOf(db, 'Cebollas').bought_by === P.taylor);
  await toasts(page);
  db.offline = true;
  const milkSeen = itemOf(db, 'Milk').added_at;
  await lrow(page, 'Milk').click();
  await page.clock.fastForward('00:03');
  foodRpc.buy_item(db, { p_item: itemOf(db, 'Milk').id, p_bought: true, p_seen: milkSeen }, 'alex@example.com');
  db.foodNow += 20 * 60e3;
  foodRpc.add_to_list(db, { p_name: 'Milk' }, 'alex@example.com');
  db.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  check('a tick that waited while the line was bought and added again: "Cambiado en otro teléfono", and the new need stays to buy',
    await until(async () => (await texts(page, '.toast')).includes('Cambiado en otro teléfono')) && itemOf(db, 'Milk').bought_at === null
    && same(calls(db, 'buy_item_by_token').slice(-1)[0].body.p_seen, milkSeen) && await until(async () => names((await listView(page)).toBuy).includes('Milk · leche')),
    `${await text(page, '.toasts')} ${JSON.stringify(itemOf(db, 'Milk'))}`);

  // Huevos, bought this morning by Alex: "¿Añadir otra vez?" with no signal brings it back, and she
  // ticks it before the add is answered. The tick waits for the add and takes the line's new seen from
  // its answer, so it buys the line; nobody else changed it, so no "Cambiado en otro teléfono".
  await toasts(page);
  db.offline = true;
  await lrow(page, 'Huevos').click();
  await page.click('.toast-action .toast-btn:not(.toast-x)');   // ¿Añadir otra vez?
  await page.clock.fastForward('00:03');
  check('no signal, "¿Añadir otra vez?" on a line bought this morning: it is to buy again at once, with a box, "⟳ sin enviar"',
    await until(async () => (await listView(page)).toBuy.some((r) => r.name === 'Huevos' && r.unsent === '⟳ sin enviar' && r.checked === 'false')),
    JSON.stringify((await listView(page)).toBuy));
  await lrow(page, 'Huevos').click();   // she picks it up
  db.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => itemOf(db, 'Huevos').bought_by === P.taylor);
  await page.waitForTimeout(400);
  check('back online: the add, then her tick with the line\'s new seen from the add\'s answer: Huevos bought by Taylor, no "Cambiado en otro teléfono"',
    itemOf(db, 'Huevos').bought_by === P.taylor && same(keyed(calls(db, 'buy_item_by_token').slice(-1)[0].body), { p_token: TAYLOR, p_item: itemOf(db, 'Huevos').id, p_bought: true, p_seen: itemOf(db, 'Huevos').added_at })
    && itemOf(db, 'Huevos').added_at !== '2026-10-23T12:00:00.000000+00:00' && same(calls(db, 'add_to_list_by_token').map((c) => c.body.p_name), ['Huevos'])
    && !(await texts(page, '.toast')).includes('Cambiado en otro teléfono'), `${await text(page, '.toasts')} ${JSON.stringify(itemOf(db, 'Huevos'))}`);

  // Yogur, bought this morning by Alex: "¿Añadir otra vez?" with no signal brings it back and she ticks
  // it (the tick waits for the add). The add still gets no answer when a read past the household's
  // midnight does (Alex's purchase is yesterday's now, so the list no longer has the line): the waiting
  // add is drawn as a new row. Deshacer takes her tick back (it never left the phone): "Deshecho…", not
  // "Cambiado en otro teléfono"; then the add goes, and nothing is bought.
  await toasts(page);
  db.shopping_items.push(shopItem({ name: 'Yogur', aisle: 'dairy', added_at: '2026-10-23T12:00:00.000000+00:00', added_by: P.alex, bought_at: '2026-10-25T13:31:00.111111+00:00', bought_by: P.alex }));
  await page.clock.fastForward('00:11');
  await until(async () => names((await listView(page)).bought).includes('Yogur'));
  db.offline = true;
  await lrow(page, 'Yogur').click();
  await page.click('.toast-action .toast-btn:not(.toast-x)');   // ¿Añadir otra vez?
  await page.clock.fastForward('00:03');
  await until(async () => (await listView(page)).toBuy.some((r) => r.name === 'Yogur' && r.checked === 'false' && r.unsent === '⟳ sin enviar'));
  await toasts(page);
  await lrow(page, 'Yogur').click();   // she picks it up: the tick waits for the add
  itemOf(db, 'Yogur').bought_at = '2026-10-24T13:31:00.111111+00:00';   // past midnight: yesterday's purchase
  db.offline = false;
  db.status = { add_to_list_by_token: 503 };   // the add still gets no answer; the read does
  const readsDone = () => calls(db, 'get_list_by_token').filter((c) => c.done).length;
  const reads0 = readsDone();
  for (let i = 0; i < 8 && readsDone() === reads0; i++) { await page.clock.fastForward('00:10'); await page.waitForTimeout(200); }
  await page.waitForTimeout(300);
  const yogurDrawn = (await listView(page)).toBuy.filter((r) => r.name === 'Yogur').map((r) => r.checked);
  await page.click('.toast-action .toast-btn:not(.toast-x)');   // Deshacer
  await page.waitForTimeout(300);
  const yogurToasts = await texts(page, '.toast');
  check('Deshacer of a tick waiting for "¿Añadir otra vez?", after a read past midnight drew that add as a new row: "Deshecho…", not "Cambiado en otro teléfono"',
    readsDone() > reads0 && yogurDrawn.length === 1 && yogurToasts.includes('Deshecho. Vuelve a estar en tu lista.') && !yogurToasts.includes('Cambiado en otro teléfono'),
    JSON.stringify([yogurDrawn, yogurToasts]));
  db.status = null;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => itemOf(db, 'Yogur').bought_at === null);
  await page.waitForTimeout(400);
  check('... then the add goes, and nothing is bought', itemOf(db, 'Yogur').bought_at === null && calls(db, 'buy_item_by_token').every((c) => c.body.p_item !== itemOf(db, 'Yogur').id),
    JSON.stringify(itemOf(db, 'Yogur')));

  // Cilantro: Alex buys it on his phone before hers reads the list again; her tick finds it already
  // bought ("no change"). It isn't hers to undo: Deshacer, or tapping the row again, sends nothing and
  // says "Cambiado en otro teléfono"; Alex's purchase stays.
  await toasts(page);
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));   // the row stays where it is while the test taps
  foodRpc.buy_item(db, { p_item: itemOf(db, 'Cilantro').id, p_bought: true, p_seen: itemOf(db, 'Cilantro').added_at }, 'alex@example.com');
  const alexBought = itemOf(db, 'Cilantro').bought_at;
  const ticks0 = calls(db, 'buy_item_by_token').length;
  await lrow(page, 'Cilantro').click();
  await until(() => calls(db, 'buy_item_by_token').length === ticks0 + 1 && !!calls(db, 'buy_item_by_token')[ticks0].done);
  await page.waitForTimeout(300);
  await page.click('.toast-action .toast-btn:not(.toast-x)');   // Deshacer
  check('Deshacer after her tick found the line already bought by Alex: nothing is sent, "Cambiado en otro teléfono", and his purchase stays',
    await until(async () => (await texts(page, '.toast')).includes('Cambiado en otro teléfono')) && calls(db, 'buy_item_by_token').length === ticks0 + 1
    && itemOf(db, 'Cilantro').bought_at === alexBought && itemOf(db, 'Cilantro').bought_by === P.alex, `${await text(page, '.toasts')} ${JSON.stringify(calls(db, 'buy_item_by_token').slice(ticks0).map((c) => c.body))}`);
  await toasts(page);
  await lrow(page, 'Cilantro').click();   // the row, still ticked where it is: take it back
  check('… and so does tapping the ticked row again: it stays ticked, nothing is sent',
    await until(async () => (await texts(page, '.toast')).includes('Cambiado en otro teléfono')) && (await lrow(page, 'Cilantro').getAttribute('aria-checked')) === 'true'
    && calls(db, 'buy_item_by_token').length === ticks0 + 1 && itemOf(db, 'Cilantro').bought_by === P.alex, `${await text(page, '.toasts')}`);
  await page.clock.resume();

  // A null answer: the link was replaced. The saved list goes, and the link's screen shows.
  delete db.my[TAYLOR];
  db.people.find((p) => p.id === P.taylor).day_token = 'abcabcabcabcabcabcabcabcabcabcab';
  await page.clock.fastForward('00:10');
  check('a null answer: "Este enlace no funciona…", and the list saved for the link is removed',
    await until(async () => /Este enlace no funciona/.test(await text(page, '.day-problem'))) && (await page.evaluate(() => localStorage.getItem('homehub.shop.day'))) === null,
    await text(page, 'main'));
  await page.context().close();

  // =====================================================================
  // 15. No answer at the start, with a list saved at home: the problem screen opens it, in Spanish,
  //     under "Sin conexión"; ticks there wait and go when there is an answer
  // =====================================================================
  db = withList(foodDb());
  ({ page, db } = await open({ label: 'list-saved', db, path: `/day.html?t=${TAYLOR}`, ctx: phone(), allowConsole: LIST_ERRORS }));
  await until(async () => /Cebollas/.test(await page.evaluate(() => localStorage.getItem('homehub.shop.day') || '')));
  db.offline = true;
  await page.reload();
  await page.waitForSelector('.day-problem');
  check('no answer at the start, a list saved: the problem (in her saved language first) with Intentar de nuevo and a Lista de compras button',
    /No se puede conectar con Home Hub/.test(await text(page, '.day-problem p:first-child')) && same(await texts(page, '.day-actions .btn'), ['Intentar de nuevo', 'Lista de compras']),
    `${await text(page, '.day-problem')} | ${await texts(page, '.day-actions .btn')}`);
  await page.click('.day-list-btn');
  await page.waitForSelector('.list-head');
  lv = await listView(page);
  check('... it opens the saved list in Spanish, under "Sin conexión: esta es la lista de las dom 10:00."',
    (await text(page, '.list-offline p')) === 'Sin conexión: esta es la lista de las dom 10:00.' && (await text(page, '.list-head h1')) === 'Lista de compras'
    && same(names(lv.toBuy), ['Cebollas', 'Cilantro', 'Tortillas', 'Milk · leche']) && same(lv.aisles, ['Frutas y verduras', 'Panadería', 'Lácteos y huevos']), JSON.stringify(lv));
  await page.screenshot({ path: SHOTS + 'day-list-offline.png', fullPage: true });
  // The clock moves only when the test says, so no retry goes before Intentar de nuevo is pressed.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  await lrow(page, 'Cilantro').click();
  await page.clock.runFor(3000);
  check('a tick there waits on the phone', await until(async () => (await listView(page)).bought.some((r) => r.name === 'Cilantro' && r.unsent === '⟳ sin enviar')) && calls(db, 'buy_item_by_token').length === 0);
  await typeAdd(page, 'Limones');
  const waiting = await page.$$eval('.lrow.is-new', (rs) => rs.map((r) => [r.tagName, r.querySelector('.lrow-name').textContent, !!r.querySelector('.irow-box'), (r.querySelector('.lrow-unsent') || {}).textContent]));
  check('an add that waits: a row with no box (it has no id yet), marked "⟳ sin enviar"', same(waiting, [['DIV', 'Limones', false, '⟳ sin enviar']]), JSON.stringify(waiting));
  db.offline = false;
  await page.click('.list-offline .btn');
  check('Intentar de nuevo: the tick and the add are sent, in order, and the list is read again',
    await until(() => calls(db, 'buy_item_by_token').length === 1 && itemOf(db, 'Cilantro').bought_by === P.taylor && calls(db, 'add_to_list_by_token').length === 1)
    && same(db.calls.filter((c) => /^(buy_item|add_to)/.test(c.name)).map((c) => c.name), ['buy_item_by_token', 'add_to_list_by_token'])
    && await until(async () => !(await page.$('.list-offline, .lrow-unsent, .lrow.is-new')) && (await listView(page)).toBuy.some((r) => r.name === 'Limones')), await text(page, '.list-banners'));
  await page.click('.list-back');
  check('‹ Mi día: the day loads now', await until(async () => (await text(page, '.day-head h1')) === 'Hola, Taylor' && !!(await page.$('.day-list-btn'))), await text(page, 'main'));
  check('the list stays saved for this link', /Limones/.test(await page.evaluate(() => localStorage.getItem('homehub.shop.day') || '')));
  await page.goto(`${BASE}/day.html?t=${JORDAN}`);
  await page.waitForSelector('.day-sec');
  check('another link on the same phone: the list saved for Taylor\'s link is removed unread', (await page.evaluate(() => localStorage.getItem('homehub.shop.day'))) === null);
  await page.context().close();

  // =====================================================================
  // 16. Homework (v1.3): the card, only with get_person_day's homework key, and no homework request without it
  // =====================================================================
  const hwCalls = (d) => d.calls.filter((c) => /_by_token$/.test(c.name) && !/^(complete|undo|get_list|add_to_list|buy_item)_by_token$/.test(c.name));
  const hwText = (pg, sel) => pg.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const hwTexts = (pg, sel) => pg.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const hwVisible = (pg, sel) => pg.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight)).catch(() => false);
  const hwToast = async (pg) => (await pg.waitForSelector('.toast', { timeout: 3000 }).then(() => text(pg, '.toast:last-child')).catch(() => ''));
  const hwClear = (pg) => pg.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
  const hwRec = (pg) => pg.evaluate(() => window.__hw);
  // Move the server's clock and the phone's together (the phone's by the same amount, from wherever it is).
  const hwTick = async (pg, d, ms) => { d.hwNow += ms; await pg.clock.fastForward(ms); await pg.waitForTimeout(50); };
  const hwPause = async (pg) => pg.clock.pauseAt(new Date((await pg.evaluate(() => Date.now())) + 200));

  // A helper's My day: no card, no homework request (Taylor has no homework_kids row).
  ({ page, db, requests } = await open({ label: 'hw-helper', path: `/day.html?t=${TAYLOR}`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS }));
  check('homework: no card on a helper\'s My day, and no homework request', !(await page.$('.hw-card')) && !hwCalls(db).length, db.calls.map((c) => c.name).join(','));
  await page.context().close();
  // Schema 4 (no 0005 yet): get_person_day has no homework key; the day draws as before, with no homework request.
  {
    const d4 = hwDb();
    delete d4.homework_kids;
    ({ page, db } = await open({ label: 'hw-schema4', path: `/day.html?t=${JORDAN}`, db: d4, device: HW_DEVICE, init: HW_STUBS }));
    check('homework: on schema 4 there is no card and no homework request; the day is as before',
      !(await page.$('.hw-card')) && !hwCalls(db).length && (await text(page, '.day-head h1')) === 'Hi, Jordan'
      && same((await rowsOf(page, 'today')).map((r) => r.title), ['Homework']), db.calls.map((c) => c.name).join(','));
    await page.context().close();
  }
  // A kid with homework off: no card either.
  {
    const off = hwDb();
    off.homework_kids[0].active = false;
    ({ page, db } = await open({ label: 'hw-off', path: `/day.html?t=${JORDAN}`, db: off, device: HW_DEVICE, init: HW_STUBS }));
    check('homework: homework off → no card, no homework request', !(await page.$('.hw-card')) && !hwCalls(db).length);
    await page.context().close();
  }
  // + Homework due within 3 days (so 'add' does Quick too) while he has no homework time at all: his homework is kept,
  // with no plan; the form closes and nothing says "Set a homework time first." to him.
  {
    const nt = hwDb();
    delete nt.hwTimes[P.jordan];
    ({ page, db } = await open({ label: 'hw-notime', path: `/day.html?t=${JORDAN}#homework`, db: nt, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('[data-act="hw-add"]', { timeout: 5000 });
    await page.click('[data-act="hw-add"]');
    await page.fill('.hw-add-form input[name="title"]', 'Worksheet 6.1');
    await page.fill('.hw-add-form input[name="due"]', '2026-11-03');
    await page.click('.hw-add-form [type="submit"]');
    await until(() => calls(db, 'assignment_by_token').length === 1);
    const sent = calls(db, 'assignment_by_token')[0].body;
    check('+ Homework with no homework time: his homework is kept, with no plan; the form closes, no error',
      sent.p_minutes === 15 && await until(() => db.assignments.some((a) => a.id === sent.p_assignment && a.added_by === 'kid'))
      && !db.homework_steps.some((s) => s.assignment_id === sent.p_assignment)
      && await until(async () => !(await page.$('.hw-add-form'))) && !/homework time/i.test(await page.evaluate(() => document.body.innerText.match(/Set a homework time first/) ? 'homework time' : '')),
      `${JSON.stringify(sent)} ${await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '))}`);
    await page.context().close();
  }
  // Without plan.js (it didn't load: a phone that kept an older day.html, or a failed fetch): the day still works, with no card.
  {
    ({ page, db } = await open({ label: 'hw-noplan', path: `/day.html?t=${JORDAN}`, db: hwDb(), noPlan: true, device: HW_DEVICE, init: HW_STUBS,
      allowConsole: /plan\.js|ERR_FAILED/ }));
    const planLoaded = await page.evaluate(() => typeof window.HomePlan);
    check('homework: without plan.js the day draws as before (no card, no homework request)',
      planLoaded === 'undefined' && !(await page.$('.hw-card')) && !hwCalls(db).length && !!(await page.$('.day-sec')), planLoaded);
    await page.context().close();
  }

  ({ page, db, requests } = await open({ label: 'hw-en', path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS }));
  check('homework card: under the greeting, above today\'s items',
    await page.evaluate(() => { const c = document.querySelector('.hw-card'); const h = document.querySelector('.day-head'); const s = document.querySelector('.day-sec');
      return !!(c && h && s && (h.compareDocumentPosition(c) & 4) && (c.compareDocumentPosition(s) & 4)); }));
  check('homework card: "Homework · 4:30pm · 3 steps · 45 min · 2 from earlier", the balance, Next and its own Start',
    (await hwText(page, '.hw-card-head')) === 'Homework · 4:30pm · 3 steps · 45 min · 2 from earlier'
    && (await hwText(page, '.hw-card-points')) === '★ 118'
    && (await hwText(page, '.hw-card-next')) === 'Next: Worksheet 4.2 · Do worksheet 4.2'
    && (await hwText(page, '.hw-card [data-act="hw-card-start"]')) === 'Start · 20 min'
    && (await page.$eval('.hw-card a.hw-open', (a) => a.getAttribute('href'))) === '#homework',
    `${await hwText(page, '.hw-card')}`);
  // The next-reward bar (the owner's "immediate gratification"): 118 points buy Friday's dinner (60) now; the
  // cheapest he can't afford yet is the book (150), 32 to go.
  check('homework card: the next-reward bar, "You can get Choose Friday\'s dinner now!" and "32 points to A new book"',
    (await hwText(page, '.hw-card .plan-goal-text')) === "You can get Choose Friday's dinner now!" && (await hwText(page, '.hw-card .plan-goal-next')) === '32 points to A new book'
    && (await page.$eval('.hw-card .plan-goal-fill', (f) => f.style.width)) === '78.7%', await hwText(page, '.hw-card'));
  check('homework card: drawn from get_person_day alone (no homework_by_token on the day view)', !calls(db, 'homework_by_token').length);
  check('homework card on schema 5 (no from_school count): no New from school line', !(await page.$('.hw-card-school')));
  check('homework card: nothing asked for before a tap (no wake lock, no audio, no notification)',
    await page.evaluate(() => !window.__hw.wake.length && !window.__hw.audio.length && !window.__hw.ask.length));

  // ---- One tap from My day to a running ring
  await page.click('.hw-card [data-act="hw-card-start"]');
  await until(async () => (await page.evaluate(() => location.hash)) === '#focus' && !!(await page.$('.hw-ring')));
  let fstart = calls(db, 'focus_by_token');
  check('the card\'s Start: one focus_by_token start on Next, at his first length, alone, with the phone\'s id for the block',
    fstart.length === 1 && same(Object.assign({}, fstart[0].body, { p_session: 'id' }), { p_token: JORDAN, p_action: 'start', p_session: 'id', p_minutes: 20, p_step: H.m1, p_with: 'alone' })
    && UUID.test(fstart[0].body.p_session), JSON.stringify(fstart.map((c) => c.body)));
  const blockId = fstart[0] && fstart[0].body.p_session;
  let rec = await hwRec(page);
  check('Start: the screen wake lock and the AudioContext are asked for inside the tap',
    rec.wake.length >= 1 && rec.wake[0].type === 'screen' && rec.wake[0].active && rec.audio.length === 1 && rec.audio[0].active, JSON.stringify(rec));
  check('Start: the chime is scheduled on the audio clock at Start (currentTime + 20 minutes), not by a timer',
    rec.osc.length >= 1 && rec.osc.every((w) => Math.abs(w - (5 + 1200)) < 3), JSON.stringify(rec.osc));
  check('#focus: the step, its assignment, the ring and "20 min" from the server\'s clock (the phone is a day off)',
    (await hwText(page, '.hw-focus-title')) === 'Do worksheet 4.2' && (await hwText(page, '.hw-focus-sub')) === 'Worksheet 4.2'
    && (await hwText(page, '.hw-left')) === '20 min' && !!(await page.$('.hw-ring svg.plan-ring')), await hwText(page, '.hw-focus'));
  check('#focus: on time at once ("On time · +10 once 5 minutes are done") and his cue for the first minute',
    (await hwText(page, '.hw-ontime')) === 'On time · +10 once 5 minutes are done'
    && (await hwText(page, '.hw-focus-cue')) === '“When I\'ve had my snack, I open my notes doc.”', await hwText(page, '.hw-focus'));
  check('#focus: I\'m stuck, Done and Stop', same(await hwTexts(page, '.hw-focus-acts button'), ['I\'m stuck', 'Done', 'Stop']), JSON.stringify(await hwTexts(page, '.hw-focus-acts button')));
  check('#focus: no ticking seconds shown', !/\d:\d\d/.test(await hwText(page, '.hw-ring')), await hwText(page, '.hw-ring'));
  check('#focus: the points so far ("★ 118 +0 so far") and the next-reward bar', (await hwText(page, '.hw-live')) === '★ 118 +0 so far'
    && (await hwText(page, '.hw-focus .plan-goal-text')) === "You can get Choose Friday's dinner now!", await hwText(page, '.hw-focus'));
  await page.screenshot({ path: SHOTS + 'day-hw-focus.png', fullPage: true });

  // ---- The ring counts to the server's ends_at, whatever the phone's clock says
  await hwPause(page);
  await hwTick(page, db, 61 * 1000);
  check('#focus: the cue goes after the first minute', !(await hwVisible(page, '.hw-focus-cue')));
  check('#focus: a minute on, the points tick up: "★ 119 +1 so far"', (await hwText(page, '.hw-live')) === '★ 119 +1 so far', await hwText(page, '.hw-live'));
  await hwTick(page, db, 7 * 60 * 1000);
  check('#focus: 8 minutes on, 12 left', (await hwText(page, '.hw-left')) === '12 min', await hwText(page, '.hw-left'));
  // An estimate from the server's start time, a point a minute, and the on-time +10 once 5 minutes are seen; the
  // bar to the book moves with it (32 − 18 = 14 to go). The end pays what the server saw.
  check('#focus: 8 minutes on, "★ 136 +18 so far" (8 a minute and the on-time 10), and the bar moves on: "14 points to A new book"',
    (await hwText(page, '.hw-live')) === '★ 136 +18 so far' && (await hwText(page, '.hw-focus .plan-goal-next')) === '14 points to A new book', await hwText(page, '.hw-focus'));
  const hwReads = calls(db, 'homework_by_token').length;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  check('#focus: back into view reads homework_by_token again', await until(() => calls(db, 'homework_by_token').length === hwReads + 1), String(calls(db, 'homework_by_token').length));
  // A phone clock that jumps by hours, then a reload in the middle of the block: the server answers the open block.
  await page.clock.setSystemTime(new Date(HW_DEVICE.getTime() - 5 * 3600 * 1000));
  await page.reload();
  await page.waitForSelector('.hw-ring', { timeout: 5000 });
  check('a reload mid-block shows it again, 12 minutes left, with the phone\'s clock 5 hours off', (await hwText(page, '.hw-left')) === '12 min'
    && (await hwText(page, '.hw-focus-title')) === 'Do worksheet 4.2', await hwText(page, '.hw-focus'));
  check('a reload: no second start (the server\'s open block is shown)', calls(db, 'focus_by_token').length === 1);
  await hwPause(page);

  // ---- Done, then Keep going: the same block moves on
  await page.click('[data-act="hw-done-step"]');
  await until(() => calls(db, 'step_by_token').length === 1);
  check('Done: the step is ticked (step_by_token done)', same(calls(db, 'step_by_token')[0].body, { p_token: JORDAN, p_step: H.m1, p_action: 'done' }), JSON.stringify(calls(db, 'step_by_token').map((c) => c.body)));
  await page.waitForSelector('.hw-after-done', { timeout: 3000 });
  check('Done: offers Keep going on the next step, or End the block',
    same(await hwTexts(page, '.hw-after-done button'), [`Keep going: ${HW_TITLES.s1}`, 'End the block']), JSON.stringify(await hwTexts(page, '.hw-after-done button')));
  await page.click('[data-act="hw-keep"]');
  await until(() => calls(db, 'focus_by_token').length === 2);
  check('Keep going: focus_by_token switch, the same block, to the next step',
    same(calls(db, 'focus_by_token')[1].body, { p_token: JORDAN, p_action: 'switch', p_session: blockId, p_step: H.s1 }), JSON.stringify(calls(db, 'focus_by_token')[1].body));
  check('Keep going: the ring goes on with the new step', await until(async () => (await hwText(page, '.hw-focus-title')) === HW_TITLES.s1) && (await hwText(page, '.hw-left')) === '12 min');

  // ---- The stuck sheet: his plan, Make it smaller (the block moves to it), Ask Pat, Next step
  await page.click('[data-act="hw-stuck"]');
  await page.waitForSelector('.hw-sheet');
  check('I\'m stuck: his own if-then plan first', (await hwText(page, '.hw-sheet .hw-stuck-plan')) === 'Stuck? Your plan: “If I\'m stuck for 5 minutes, I\'ll write the question for Pat and move on.”', await hwText(page, '.hw-sheet'));
  check('I\'m stuck: Make it smaller, Ask Pat, Next step (the next step named), Back to the timer; no AI',
    same(await hwTexts(page, '.hw-sheet .hw-sheet-acts > button'), ['Make it smaller', 'Ask Pat', 'Next step', 'Back to the timer'])
    && /Science project: river poster · Find 2 sources and save their links/.test(await hwText(page, '.hw-sheet'))
    && !/AI|Claude/.test(await hwText(page, '.hw-sheet')), await hwText(page, '.hw-sheet'));
  check('I\'m stuck: the ring keeps running underneath', !!(await page.$('.hw-ring')) && (await hwText(page, '.hw-left')) === '12 min');
  await page.click('.hw-sheet [data-act="hw-smaller"]');
  check('Make it smaller: the chips and your own',
    same(await hwTexts(page, '.hw-sheet [data-chip]'), ['Write one sentence', 'List what\'s unclear', 'Do the easiest part']) && !!(await page.$('.hw-sheet input[name="text"]')));
  await page.click('.hw-sheet [data-chip="1"]');
  await until(() => calls(db, 'step_by_token').length === 2);
  const smaller = calls(db, 'step_by_token')[1].body;
  check('Make it smaller: step_by_token smaller on the running step, with the phone\'s key for the new one',
    same(Object.assign({}, smaller, { p_key: 'k' }), { p_token: JORDAN, p_step: H.s1, p_action: 'smaller', p_text: 'List what\'s unclear', p_key: 'k' }) && UUID.test(smaller.p_key), JSON.stringify(smaller));
  check('Make it smaller during a block: the block moves to the new step', await until(async () => (await hwText(page, '.hw-focus-title')) === 'List what\'s unclear')
    && db.focus_sessions.find((f) => f.id === blockId).step_id === smaller.p_key && !(await page.$('.hw-sheet')), await hwText(page, '.hw-focus-title'));
  await page.click('[data-act="hw-stuck"]');
  await page.click('.hw-sheet [data-act="hw-ask"]');
  await page.fill('.hw-sheet input[name="text"]', 'Do I need a list for every source?');
  await page.click('.hw-sheet [data-act="hw-sheet-send"]');
  await until(() => calls(db, 'step_by_token').length === 3);
  check('Ask Pat: a short question on the step; the step stays open and the timer runs on',
    same(calls(db, 'step_by_token')[2].body, { p_token: JORDAN, p_step: smaller.p_key, p_action: 'ask', p_text: 'Do I need a list for every source?' })
    && (await hwToast(page)) === 'Question sent.' && !!(await page.$('.hw-ring')), JSON.stringify(calls(db, 'step_by_token')[2].body));
  await hwClear(page);
  await page.click('[data-act="hw-stuck"]');
  await page.click('.hw-sheet [data-act="hw-sheet-close"]');
  check('Back to the timer closes the sheet', !(await page.$('.hw-sheet')));

  // ---- The end screen. The owner changed the rule: the block is paid the moment its ring runs out (End 'time',
  // sent at once, before he answers), with a small celebration; his answer (More to do, his note) comes after.
  await hwTick(page, db, 12 * 60 * 1000 + 2000);
  await page.waitForSelector('.hw-end', { timeout: 3000 });
  await until(() => calls(db, 'focus_by_token').length === 3 && !!calls(db, 'focus_by_token')[2].done);
  check('the ring runs out: the block is paid at once (focus_by_token end, time), before he answers', same(calls(db, 'focus_by_token')[2].body,
    { p_token: JORDAN, p_action: 'end', p_session: blockId, p_result: 'time' }), JSON.stringify(calls(db, 'focus_by_token')[2].body));
  await page.waitForSelector('.hw-points-line', { timeout: 3000 });
  const earned = db.points_ledger.filter((l) => l.session_id === blockId).map((l) => [l.kind, l.delta]);
  check('the points shown are the server\'s: "+20 · 20 minutes · +10 on time", and "+30" by the counter, which starts at ★ 118',
    (await hwText(page, '.hw-points-line')) === '+20 · 20 minutes · +10 on time' && (await hwText(page, '.hw-end-balance')) === '★ 118'
    && (await hwText(page, '.hw-end .hw-plus')) === '+30' && same(earned, [['focus', 20], ['on_time', 10]]), `${await hwText(page, '.hw-end')} / ${JSON.stringify(earned)}`);
  rec = await hwRec(page);
  check('the celebration: a short sound (two tones, not the chime) on the AudioContext his Start made', rec.cheer.length === 2, JSON.stringify(rec.cheer));
  await page.clock.runFor(1200);
  check('the celebration: the counter ticks up to the new total, ★ 148', (await hwText(page, '.hw-end-balance')) === '★ 148', await hwText(page, '.hw-end'));
  check('then: "Time. How did it go?", the ring solid, Step done and More to do, and the optional note',
    (await hwText(page, '.hw-end h2')) === 'Time. How did it go?' && !!(await page.$('.hw-ring svg.plan-ring.is-done'))
    && same(await hwTexts(page, '.hw-end [data-act="hw-end"]'), ['Step done ✓', 'More to do'])
    && (await page.$eval('.hw-end label', (l) => l.textContent.trim())).startsWith('What did you get done? (optional)'), await hwText(page, '.hw-end'));
  rec = await hwRec(page);
  check('the end is always visual; no notification on a computer that didn\'t ask for one', rec.notes.length === 0);
  await page.fill('.hw-end input[name="note"]', 'found 2 sources, 1 more to check');
  await page.click('.hw-end [data-act="hw-end"][data-result="more"]');
  await until(() => calls(db, 'focus_by_token').length === 4);
  check('More to do: his answer, a second focus_by_token end with the note (the points stay as paid)', same(calls(db, 'focus_by_token')[3].body,
    { p_token: JORDAN, p_action: 'end', p_session: blockId, p_result: 'more', p_note: 'found 2 sources, 1 more to check' })
    && await until(async () => (await hwText(page, '.hw-end h2')) === 'Block finished.') && (await hwText(page, '.hw-points-line')) === '+20 · 20 minutes · +10 on time'
    && (await hwText(page, '.hw-end-balance')) === '★ 148' && db.points_ledger.filter((l) => l.session_id === blockId).length === 2
    && db.focus_sessions.find((f) => f.id === blockId).note === 'found 2 sources, 1 more to check',
    JSON.stringify(calls(db, 'focus_by_token')[3].body));
  check('the end screen: a break, and Next', same(await hwTexts(page, '.hw-end-next button'), ['Break · 5 min', `Next: ${HW_TITLES.s1} ›`]), JSON.stringify(await hwTexts(page, '.hw-end-next button')));
  rec = await hwRec(page);
  check('the wake lock: asked for again after the reload, and released at the end', rec.wake.length >= 1 && rec.wake[0].type === 'screen' && rec.released >= 1, JSON.stringify(rec));
  await page.screenshot({ path: SHOTS + 'day-hw-end.png', fullPage: true });
  await page.click('[data-act="hw-break"]');
  check('Break: "Take 5 minutes." with a small ring on the device, and Skip break; nothing stored',
    (await hwText(page, '.hw-break p')) === 'Take 5 minutes.' && !!(await page.$('.hw-break svg.plan-ring')) && !!(await page.$('[data-act="hw-skip-break"]'))
    && calls(db, 'focus_by_token').length === 4);
  await page.click('[data-act="hw-skip-break"]');
  await page.click('.hw-end-next [data-act="hw-next"]');
  await until(async () => (await page.evaluate(() => location.hash)) === '#homework' && !!(await page.$('.hw-now-card')));
  check('Next: #homework with that step as Now', (await hwText(page, '.hw-now-title')) === HW_TITLES.s1, await hwText(page, '.hw-now'));
  await page.context().close();

  // =====================================================================
  // 17. #homework: Now, Tonight, From earlier, Due soon, at 390px, 420px and 1280×800
  // =====================================================================
  const hwSizes = [['phone', phone(), 390], ['window', { viewport: { width: 420, height: 800 } }, 420], ['desktop', { viewport: { width: 1280, height: 800 } }, 1280]];
  for (const [label, ctx, width] of hwSizes) {
    ({ page, db } = await open({ label: `hw-${label}`, path: `/day.html?t=${JORDAN}#homework`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS, ctx }));
    await page.waitForSelector('.hw-now-card');
    check(`#homework at ${width}px: no sideways scroll`, await noSideScroll(page));
    await page.screenshot({ path: SHOTS + `day-hw-${label}.png`, fullPage: true });
    if (label !== 'phone') { await page.context().close(); continue; }
    check('#homework: read with homework_by_token({ p_token })', same(calls(db, 'homework_by_token').map((c) => c.body), [{ p_token: JORDAN }]), JSON.stringify(calls(db, 'homework_by_token').map((c) => c.body)));
    check('#homework: ‹ My day, "Homework", the balance', (await hwText(page, '.hw-head .list-back')) === '‹ My day' && (await hwText(page, '.hw-head h1')) === 'Homework'
      && (await hwText(page, '.hw-head .hw-points')) === '★ 118');
    check('Now: "Now · homework time 4:30pm–5:15pm · start by 4:40pm for +10"', (await hwText(page, '#hw-now-h')) === 'Now · homework time 4:30pm–5:15pm · start by 4:40pm for +10', await hwText(page, '#hw-now-h'));
    check('#homework: the next-reward bar under the heading', (await hwText(page, '.hw-head .plan-goal-text')) === "You can get Choose Friday's dinner now!"
      && (await hwText(page, '.hw-head .plan-goal-next')) === '32 points to A new book', await hwText(page, '.hw-head'));
    check('Now: the card\'s Next, with its place in the plan, its "done looks like", his cue and ✎',
      (await hwText(page, '.hw-now-title')) === 'Do worksheet 4.2' && (await hwText(page, '.hw-now-sub')) === 'Worksheet 4.2 · step 1 of 1 · 15 min'
      && (await hwText(page, '.hw-now-card .hw-cue')).startsWith('“When I\'ve had my snack, I open my notes doc.”') && !!(await page.$('.hw-now-card [data-act="hw-cue"]')), await hwText(page, '.hw-now-card'));
    check('Now: the length chips (his first length chosen) and Alone ▾ (With Pat, With a parent)',
      same(await hwTexts(page, '.hw-len'), ['10', '15', '20', '25']) && (await page.$eval('.hw-len[aria-checked="true"]', (b) => b.textContent.trim())) === '20'
      && same(await page.$$eval('.hw-now-card select[name="with"] option', (os) => os.map((x) => [x.value, x.textContent])), [['alone', 'Alone'], ['tutor', 'With Pat'], ['parent', 'With a parent']])
      && (await hwText(page, '.hw-now-card [data-act="hw-start"]')) === 'Start · 20 min');
    check('Tonight: "Tonight · 45 min planned · 45 min of homework time", in the plans\' order',
      (await hwText(page, '#hw-tonight-h')) === 'Tonight · 45 min planned · 45 min of homework time'
      && same(await hwTexts(page, '.hw-tonight .hw-list > .hw-steps > .hw-step .hw-step-title'), ['Worksheet 4.2 · Do worksheet 4.2', `Science project: river poster · ${HW_TITLES.s1}`, `Science project: river poster · ${HW_TITLES.s2}`]),
      JSON.stringify(await hwTexts(page, '.hw-tonight .hw-list > .hw-steps > .hw-step .hw-step-title')));
    // His view says who answered only as a role it doesn't carry for answers: "Answer: …" (never a name that might be wrong).
    check('Tonight: his question and the answer under the step', (await hwText(page, `.hw-step[data-step="${H.m1}"] .hw-q`)) === 'You asked: What does \'simplify fully\' mean here?'
      && (await hwText(page, `.hw-step[data-step="${H.m1}"] .hw-note`)) === 'Answer: No common factor is left.', await hwText(page, `.hw-step[data-step="${H.m1}"]`));
    check('Tonight: homework with no plan, due soon: "Math · Worksheet 5.1 · due Wed" with Quick and Start',
      (await hwText(page, `.hw-noplan[data-asg="${H.ws51}"] .hw-noplan-title`)) === 'Math · Worksheet 5.1 · due Wed'
      && same(await hwTexts(page, `.hw-noplan[data-asg="${H.ws51}"] button`), ['Quick', 'Start']), await hwText(page, '.hw-tonight'));
    check('From earlier: folded into one line with Re-plan', (await hwText(page, '.hw-earlier summary')) === 'From earlier · 2 steps · 35 min · Re-plan ›'
      && !(await page.$eval('.hw-earlier', (d) => d.open)), await hwText(page, '.hw-earlier summary'));
    await page.click('.hw-earlier summary');
    check('From earlier, opened: each step with Start and Not today (none on a checkpoint), and Re-plan; the Not yet note under the milestone',
      same(await hwTexts(page, '.hw-earlier .hw-step-title'), ['Vocabulary project · List the 20 words', 'Vocabulary project · Flashcards made'])
      && (await page.$$(`.hw-earlier .hw-step[data-step="${H.v1}"] [data-act="hw-not-today"]`)).length === 1
      && !(await page.$(`.hw-earlier .hw-step[data-step="${H.v2}"] [data-act="hw-not-today"]`))
      && (await hwText(page, `.hw-earlier .hw-step[data-step="${H.v2}"] .hw-note`)) === 'Not yet: Add the last five words.'
      && !!(await page.$('.hw-earlier [data-act="hw-replan-earlier"]')), await hwText(page, '.hw-earlier'));
    check('nothing red and no "late" in From earlier', !/late/i.test(await hwText(page, '.hw-earlier')) && (await page.$eval('.hw-earlier', (e) => getComputedStyle(e).color)) !== 'rgb(220, 38, 38)');
    check('+ Homework', (await hwText(page, '[data-act="hw-add"]')) === '+ Homework');
    const due = await page.$$eval('.hw-due .hw-asg', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
    check('Due soon: the Science project with its next milestone, the two bars, the checked milestone\'s note and the stretch question',
      /^Science · Science project: river poster · due Fri Nov 13 · ◆ Outline with 3 main points Wed/.test(due.find((x) => /river/.test(x)) || '')
      && !!(await page.$(`.hw-asg[data-asg="${H.sci}"] .plan-bars .plan-bar-work`)) && !!(await page.$(`.hw-asg[data-asg="${H.sci}"] .plan-bars .plan-bar-time`))
      && /Pat: Good choice\. The delta is a strong focus\./.test(due.find((x) => /river/.test(x)) || '')
      && /Optional: Which part of the river would you most like to show in detail\?/.test(due.find((x) => /river/.test(x)) || ''), JSON.stringify(due));
    check('Due soon: Behind the plan · Re-plan ›, as plain text, and the passed milestone\'s line',
      /Spanish · Vocabulary project · due Mon Nov 9 · Behind the plan · Re-plan ›/.test(due.join(' | '))
      && /Flashcards made was planned for Fri Oct 30\. Pick a new day with Pat ›/.test(due.join(' | ')), JSON.stringify(due));
    check('Due soon: a lesson being planned', due.some((x) => x === 'Math · Fractions practice · lesson · do by Fri · Being planned'), JSON.stringify(due));
    check('the who-sees line', (await hwText(page, '.hw-who')) === 'Pat and the grown-ups in your family see your plan and your notes. The grown-ups see your points.');
    check('#homework on schema 5 (no from_school): no New from school section', !(await page.$('.hw-school')));
    check('focused minutes this week against last week', (await hwText(page, '.hw-pace')) === '0 min focused this week (last week 20 min)', await hwText(page, '.hw-pace'));
    check('a phone: no "Show a notification" offer', !(await page.$('[data-act="hw-notify"]')));
    check('no Notification asked for, ever, on a phone', !(await hwRec(page)).ask.length);

    // ---- Tapping another step makes it Now
    await page.click(`.hw-tonight .hw-step[data-step="${H.s2}"] .hw-step-main`);
    check('tapping a step makes it Now', (await hwText(page, '.hw-now-title')) === HW_TITLES.s2 && (await hwText(page, '.hw-now-card .hw-now-dll')) === 'Done looks like: 2 titles and links in your notes doc');

    // ---- Tick, and the 15-minute Undo
    await page.click(`.hw-tonight .hw-step[data-step="${H.m1}"] .hw-box`);
    await until(() => calls(db, 'step_by_token').length === 1);
    await page.waitForSelector('.toast-action', { timeout: 3000 }).catch(() => {});
    check('tick: step_by_token done, a "Done" toast with Undo', same(calls(db, 'step_by_token')[0].body, { p_token: JORDAN, p_step: H.m1, p_action: 'done' })
      && (await hwText(page, '.toast-action span')) === 'Done: Do worksheet 4.2' && same(await texts(page, '.toast-action button'), ['Undo', '×']));
    check('tick: the box shows it done (from the answer, no second read)', await until(async () => (await page.$eval(`.hw-step[data-step="${H.m1}"] .hw-box`, (b) => b.getAttribute('aria-checked'))) === 'true')
      && calls(db, 'homework_by_token').length === 1);
    await page.click('.toast-action .toast-btn:not(.toast-x)');
    await until(() => calls(db, 'step_by_token').length === 2);
    check('Undo: step_by_token undo', same(calls(db, 'step_by_token')[1].body, { p_token: JORDAN, p_step: H.m1, p_action: 'undo' })
      && await until(async () => (await page.$eval(`.hw-step[data-step="${H.m1}"] .hw-box`, (b) => b.getAttribute('aria-checked'))) === 'false'));
    await hwClear(page);

    // ---- Not today (⋯), a resend is harmless
    await page.click(`.hw-tonight .hw-step[data-step="${H.s2}"] [data-act="hw-more"]`);
    check('⋯ on a step: Done, Not today, Make it smaller, Ask Pat, Edit',
      same(await hwTexts(page, `.hw-step[data-step="${H.s2}"] .hw-menu button`), ['Done', 'Not today', 'Make it smaller', 'Ask Pat', 'Edit']), JSON.stringify(await hwTexts(page, `.hw-step[data-step="${H.s2}"] .hw-menu button`)));
    await page.click(`.hw-step[data-step="${H.s2}"] .hw-menu [data-act="hw-not-today"]`);
    await until(() => calls(db, 'step_by_token').length === 3);
    check('Not today: step_by_token not_today with the day his screen showed', same(calls(db, 'step_by_token')[2].body, { p_token: JORDAN, p_step: H.s2, p_action: 'not_today', p_day: HWT }));
    const moved = db.homework_steps.find((s) => s.id === H.s2);
    check('Not today: the step goes to the next homework day with room (Tuesday), and leaves Tonight',
      moved.day === '2026-11-03' && moved.moved_from === HWT && await until(async () => !(await page.$(`.hw-tonight .hw-step[data-step="${H.s2}"]`))), JSON.stringify(moved));
    check('Not today: a toast says where it went', /^Moved to tomorrow/.test(await hwToast(page)), await text(page, '.toasts'));
    const resend = homeworkRpc.step_by_token(db, { p_token: JORDAN, p_step: H.s2, p_action: 'not_today', p_day: HWT });
    check('Not today sent again with the old day changes nothing (a resend)', db.homework_steps.find((s) => s.id === H.s2).day === '2026-11-03' && !resend.__status);
    await hwClear(page);

    // ---- Quick → Now, + Homework → Now
    await page.click(`.hw-noplan[data-asg="${H.ws51}"] [data-act="hw-quick"]`);
    check('Quick: his guess of the minutes, one tap', same(await hwTexts(page, `.hw-noplan[data-asg="${H.ws51}"] [data-quick]`), ['10', '15', '20', '30', '45']));
    await page.click(`.hw-noplan[data-asg="${H.ws51}"] [data-quick="15"]`);
    await until(() => calls(db, 'assignment_by_token').length === 1);
    check('Quick: assignment_by_token quick with the minutes', same(calls(db, 'assignment_by_token')[0].body, { p_token: JORDAN, p_action: 'quick', p_assignment: H.ws51, p_minutes: 15 }));
    check('Quick: one plain step tonight, given, and it is Now', await until(async () => (await hwText(page, '.hw-now-title')) === 'Worksheet 5.1')
      && (await hwTexts(page, '.hw-tonight .hw-step-title')).includes('Worksheet 5.1 · Worksheet 5.1') && !(await page.$(`.hw-noplan[data-asg="${H.ws51}"]`)), await hwText(page, '.hw-tonight'));
    await page.click('[data-act="hw-add"]');
    check('+ Homework: what, class, due, about how many minutes (15)', same(await page.$$eval('.hw-add-form input', (is) => is.map((i) => [i.name, i.type, i.value])),
      [['title', 'text', ''], ['subject', 'text', ''], ['due', 'date', ''], ['minutes', 'number', '15']]) && (await page.$eval('.hw-add-form input[name="due"]', (i) => [i.min, i.max].join())) === '2026-11-02,2027-01-01');
    await page.fill('.hw-add-form input[name="title"]', 'Worksheet 5.2');
    await page.fill('.hw-add-form input[name="subject"]', 'Math');
    await page.fill('.hw-add-form input[name="due"]', '2026-11-03');
    await page.click('.hw-add-form [type="submit"]');
    await until(() => calls(db, 'assignment_by_token').length === 2);
    const add = calls(db, 'assignment_by_token')[1].body;
    check('+ Homework: assignment_by_token add with the phone\'s id and the minutes (due within 3 days: Quick too)',
      same(Object.assign({}, add, { p_assignment: 'id' }), { p_token: JORDAN, p_action: 'add', p_assignment: 'id', p_title: 'Worksheet 5.2', p_subject: 'Math', p_due_date: '2026-11-03', p_minutes: 15 })
      && UUID.test(add.p_assignment), JSON.stringify(add));
    check('+ Homework: it is Now', await until(async () => (await hwText(page, '.hw-now-title')) === 'Worksheet 5.2') && db.assignments.find((a) => a.id === add.p_assignment).added_by === 'kid');
    await page.click('[data-act="hw-add"]');
    await page.fill('.hw-add-form input[name="title"]', 'Book report');
    await page.fill('.hw-add-form input[name="due"]', '2026-11-20');
    await page.click('.hw-add-form [type="submit"]');
    await until(() => calls(db, 'assignment_by_token').length === 3);
    check('+ Homework due later: added without minutes (no Quick), shown under Due soon with "Plan this one with Pat."',
      !('p_minutes' in calls(db, 'assignment_by_token')[2].body) && calls(db, 'assignment_by_token')[2].body.p_subject === null
      && await until(async () => /Book report · due Fri Nov 20 · No plan yet · Plan this one with Pat\./.test(await hwText(page, '.hw-due'))), `${JSON.stringify(calls(db, 'assignment_by_token')[2].body)} ${await hwText(page, '.hw-due')}`);

    // ---- Re-plan from earlier, and the passed milestone's line filling Ask Pat
    await page.click('.hw-earlier [data-act="hw-replan-earlier"]');
    await until(() => calls(db, 'plan_by_token').length === 1);
    check('Re-plan: plan_by_token with p_steps null and the plan\'s rev', same(calls(db, 'plan_by_token')[0].body, { p_token: JORDAN, p_assignment: H.span, p_steps: null, p_rev: 4 }), JSON.stringify(calls(db, 'plan_by_token')[0].body));
    check('Re-plan: his plain step placed from today; the milestone keeps its day', db.homework_steps.find((s) => s.id === H.v1).day >= HWT
      && db.homework_steps.find((s) => s.id === H.v2).day === '2026-10-30', JSON.stringify(db.homework_steps.filter((s) => s.assignment_id === H.span).map((s) => [s.title, s.day])));
    await page.waitForSelector('.hw-talk', { timeout: 3000 });
    check('Re-plan: the milestone it can\'t move says "Flashcards made was planned for Fri Oct 30. Pick a new day with Pat ›"',
      (await hwText(page, '.hw-talk')) === 'Flashcards made was planned for Fri Oct 30. Pick a new day with Pat ›', await hwText(page, '.hw-talk'));
    await page.click('.hw-talk [data-act="hw-talk"]');
    await page.waitForSelector('.hw-sheet input[name="text"]');
    check('…which opens Ask Pat with that line filled in', (await page.$eval('.hw-sheet input[name="text"]', (i) => i.value)) === 'Flashcards made was planned for Fri Oct 30. Pick a new day with Pat.');
    await page.click('.hw-sheet [data-act="hw-sheet-send"]');
    await until(() => calls(db, 'step_by_token').length === 4);
    check('…and asks on the milestone', same(calls(db, 'step_by_token')[3].body, { p_token: JORDAN, p_step: H.v2, p_action: 'ask', p_text: 'Flashcards made was planned for Fri Oct 30. Pick a new day with Pat.' }));
    await hwClear(page);

    // ---- His cue, set with ✎
    await page.click('.hw-now-card [data-act="hw-cue"]');
    await page.fill('.hw-sheet input[name="text"]', 'When the timer is set, I open the worksheet.');
    await page.click('.hw-sheet [data-act="hw-sheet-send"]');
    await until(() => calls(db, 'homework_prefs_by_token').length === 1);
    check('✎ his start cue: homework_prefs_by_token with both lines (his if-stuck line kept) and his first length kept',
      same(calls(db, 'homework_prefs_by_token')[0].body, { p_token: JORDAN, p_cue: 'When the timer is set, I open the worksheet.', p_if_stuck: "If I'm stuck for 5 minutes, I'll write the question for Pat and move on.", p_minutes: null })
      && await until(async () => (await hwText(page, '.hw-now-card .hw-cue')).startsWith('“When the timer is set, I open the worksheet.”')), JSON.stringify(calls(db, 'homework_prefs_by_token')[0].body));

    // ---- A length chip is remembered on the device; Start uses it and "With Pat"
    await page.click('.hw-len[data-len="15"]');
    await page.selectOption('.hw-now-card select[name="with"]', 'tutor');
    check('a length chip: Start · 15 min, remembered on the device', (await hwText(page, '.hw-now-card [data-act="hw-start"]')) === 'Start · 15 min'
      && /15/.test(await page.evaluate(() => { try { return localStorage.getItem('homehub.myday.length'); } catch (e) { return ''; } }) || ''));
    // The 60-second read only while #homework is on screen and visible.
    const before60 = calls(db, 'homework_by_token').length;
    await hwPause(page);
    await page.clock.fastForward(61 * 1000);
    check('#homework: read again every 60 seconds while it is on screen', await until(() => calls(db, 'homework_by_token').length === before60 + 1), String(calls(db, 'homework_by_token').length - before60));
    await page.click('.hw-now-card [data-act="hw-start"]');
    await until(() => calls(db, 'focus_by_token').length === 1);
    check('Start on Now: its step, the chosen length and with whom', same(Object.assign({}, calls(db, 'focus_by_token')[0].body, { p_session: 'id' }),
      { p_token: JORDAN, p_action: 'start', p_session: 'id', p_minutes: 15, p_step: db.homework_steps.find((s) => s.title === 'Worksheet 5.2').id, p_with: 'tutor' }), JSON.stringify(calls(db, 'focus_by_token')[0].body));
    await page.waitForSelector('.hw-ring');
    const n60 = calls(db, 'homework_by_token').length;
    await page.clock.fastForward(130 * 1000);
    db.hwNow += 130 * 1000;
    check('never the 60-second read while #focus is on screen', calls(db, 'homework_by_token').length === n60, String(calls(db, 'homework_by_token').length - n60));
    // Stop at 2 minutes: a point a minute the server saw (the owner changed the rule: under 5 minutes paid nothing),
    // and not the on-time 10, which needs 5 minutes (Stop ends at once).
    await page.click('[data-act="hw-stop"]');
    await until(() => calls(db, 'focus_by_token').length === 2);
    check('Stop: focus_by_token end, stopped, at once', same(Object.assign({}, calls(db, 'focus_by_token')[1].body, { p_session: 'id' }), { p_token: JORDAN, p_action: 'end', p_session: 'id', p_result: 'stopped' }));
    check('Stop at 2 minutes: "+2 · 2 minutes" (a point a minute; the on-time 10 needs 5 minutes)', await until(async () => (await hwText(page, '.hw-points-line')) === '+2 · 2 minutes'), await hwText(page, '.hw-end'));
    await page.context().close();
  }

  // =====================================================================
  // 18. Points earned alike, the daily cap, a lost answer resent, offline Start, Finish the block first
  // =====================================================================
  {
    const d = hwDb();
    // A block of his 12 minutes old, still open: the card says how long is left, and #focus shows it.
    ({ page, db } = await open({ label: 'hw-stop', path: `/day.html?t=${JORDAN}`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await page.waitForSelector('.hw-ring');
    await hwPause(page);
    await hwTick(page, db, 12 * 60 * 1000 + 5000);
    await page.click('[data-act="hw-stop"]');
    check('Stop at 12 minutes: "+12 · 12 minutes" and the on-time +10', await until(async () => (await hwText(page, '.hw-points-line')) === '+12 · 12 minutes · +10 on time'), await hwText(page, '.hw-end'));
    // Back to the card with no block running.
    await page.goto(`${BASE}/day.html?t=${JORDAN}`);
    await page.waitForSelector('.hw-card');
    check('the card after: Next is still the step, 22 points more', (await hwText(page, '.hw-card-points')) === '★ 140', await hwText(page, '.hw-card'));
    // The day's cap (60): 36 more already today (58 in all) → the next block crossing it gets the 2 left, and says so.
    db.points_ledger.push(ledgerRow({ kid_id: P.jordan, at: hwStamp(db.hwNow), day: HWT, kind: 'focus', delta: 36, note: 'x', who: 'Jordan (My day)' }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await page.waitForSelector('.hw-ring');
    await hwPause(page);
    await hwTick(page, db, 20 * 60 * 1000 + 2000);
    await page.waitForSelector('.hw-end [data-act="hw-end"]');
    await page.click('.hw-end [data-act="hw-end"][data-result="done"]');
    check('over the daily cap: "+2 · 20 minutes · Today\'s limit reached."', await until(async () => (await hwText(page, '.hw-points-line')) === '+2 · 20 minutes · Today\'s limit reached.'), await hwText(page, '.hw-end'));
    // While a block runs, the card says how long is left.
    await page.context().close();
  }
  {
    const d = hwDb();
    d.focus_sessions.push(sessionRow({ id: hid(99), kid_id: P.jordan, assignment_id: H.math, step_id: H.m1, minutes: 20, started_at: hwStamp(d.hwNow - 8 * 60000),
      ends_at: hwStamp(d.hwNow + 12 * 60000), on_time: true }));
    ({ page, db } = await open({ label: 'hw-running', path: `/day.html?t=${JORDAN}`, db: d, device: HW_DEVICE, init: HW_STUBS, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
    check('a block running: the card says "Focus · 12 min left ›" (from ends_in_s), linking to #focus',
      (await hwText(page, '.hw-card a.hw-card-focus')) === 'Focus · 12 min left ›' && (await page.$eval('.hw-card a.hw-card-focus', (a) => a.getAttribute('href'))) === '#focus'
      && !(await page.$('.hw-card [data-act="hw-card-start"]')), await hwText(page, '.hw-card'));
    // Start on #homework while that block is open: "Finish the block you started first." and that block's screen.
    await page.goto(`${BASE}/day.html?t=${JORDAN}#homework`);
    await page.waitForSelector('.hw-now-card');
    await page.click('.hw-now-card [data-act="hw-start"]').catch(() => {});
    check('Start with a block open goes to that block', await until(async () => (await page.evaluate(() => location.hash)) === '#focus' && (await hwText(page, '.hw-left')) === '12 min'), await hwText(page, 'main'));
    // An End whose answer never comes back: kept, sent again on `online`, and the block answers once.
    db.loseAnswer = { focus_by_token: 1 };
    await page.click('[data-act="hw-stop"]');
    check('an End with no answer: kept on the phone, "Not sent yet"', await until(async () => /Not sent yet/.test(await hwText(page, 'main'))), await hwText(page, 'main'));
    const ended = db.focus_sessions.find((f) => f.id === hid(99));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    check('…sent again on `online`, with the same block; the server answers its first answer (one end, one set of points)',
      await until(() => calls(db, 'focus_by_token').filter((c) => c.body.p_action === 'end').length === 2)
      && same(calls(db, 'focus_by_token').filter((c) => c.body.p_action === 'end').map((c) => c.body.p_session), [hid(99), hid(99)])
      && db.points_ledger.filter((l) => l.session_id === hid(99) && l.kind === 'focus').length === 1 && ended.result === 'stopped'
      && await until(async () => (await hwText(page, '.hw-points-line')) === '+8 · 8 minutes · +10 on time'), `${JSON.stringify(ended)} ${await hwText(page, '.hw-end')}`);
    await page.context().close();
  }
  {
    // Offline: Start says it needs a connection and calls nothing.
    ({ page, db } = await open({ label: 'hw-offline', path: `/day.html?t=${JORDAN}#homework`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS, allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
    await page.waitForSelector('.hw-now-card');
    await page.context().setOffline(true);
    await page.click('.hw-now-card [data-act="hw-start"]');
    check('offline: "Starting needs a connection." and no call', (await hwToast(page)) === 'Starting needs a connection.' && !calls(db, 'focus_by_token').length);
    await page.context().setOffline(false);
    await hwClear(page);
    // A Start whose answer is lost: the next tap sends the same block id, so the server finds the one it made.
    db.loseAnswer = { focus_by_token: 1 };
    await page.click('.hw-now-card [data-act="hw-start"]');
    await until(() => calls(db, 'focus_by_token').length === 1);
    check('a Start with no answer: "Starting needs a connection."', (await hwToast(page)) === 'Starting needs a connection.');
    await hwClear(page);
    await page.click('.hw-now-card [data-act="hw-start"]');
    await until(() => calls(db, 'focus_by_token').length === 2);
    check('Start again: the same block id; one block on the server', calls(db, 'focus_by_token')[0].body.p_session === calls(db, 'focus_by_token')[1].body.p_session
      && db.focus_sessions.filter((f) => f.ended_at == null).length === 1 && await until(async () => !!(await page.$('.hw-ring'))));
    await page.context().close();
  }
  {
    // A computer: the one-time "Show a notification when a block ends", asked inside the tap.
    ({ page, db } = await open({ label: 'hw-notify', path: `/day.html?t=${JORDAN}#homework`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-now-card');
    check('a computer: "Show a notification when a block ends"', (await hwText(page, '[data-act="hw-notify"]')) === 'Show a notification when a block ends');
    await page.click('[data-act="hw-notify"]');
    check('…asked inside the tap, then gone', same((await hwRec(page)).ask, [true]) && !(await page.$('[data-act="hw-notify"]')));
    await page.context().close();
  }

  // =====================================================================
  // 18b. A second tap on an End on its way; the wake lock on every view; the stuck sheet on a block with
  //      no plan; Make it smaller sent twice; the chime on silent and after time away
  // =====================================================================
  const endsSent = (d) => calls(d, 'focus_by_token').filter((c) => c.body.p_action === 'end').length;
  {
    // Stop tapped again while the first End is on its way (a slow answer): the buttons wait, one End is sent,
    // and its end screen comes when it answers, with no focus or visibilitychange to send it again.
    ({ page, db } = await open({ label: 'hw-stop-twice', path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await page.waitForSelector('.hw-ring');
    await hwPause(page);
    await hwTick(page, db, 12 * 60 * 1000 + 5000);
    db.slow = { focus_by_token: 800 };
    await page.click('[data-act="hw-stop"]');
    await new Promise((r) => setTimeout(r, 150));
    const waiting = await page.$$eval('.hw-focus-acts button', (bs) => bs.map((b) => b.disabled));
    await page.$eval('[data-act="hw-stop"]', (b) => b.click()).catch(() => {});
    check('Stop twice while the End is on its way: the buttons wait; one End; then "+12 · 12 minutes" and Break, with no focus or visibilitychange',
      same(waiting, [true, true, true]) && await until(async () => (await hwText(page, '.hw-points-line')) === '+12 · 12 minutes · +10 on time' && !!(await page.$('[data-act="hw-break"]')))
      && endsSent(db) === 1, `${JSON.stringify(waiting)} ${endsSent(db)} ${await hwText(page, '.hw-focus')}`);
    db.slow = null;
    await page.context().close();
    // The end screen's Step done ✓, tapped twice.
    ({ page, db } = await open({ label: 'hw-done-twice', path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await page.waitForSelector('.hw-ring');
    await hwPause(page);
    await hwTick(page, db, 20 * 60 * 1000 + 2000);
    await page.waitForSelector('.hw-end [data-act="hw-end"]');
    db.slow = { focus_by_token: 800 };
    await page.click('.hw-end [data-act="hw-end"][data-result="done"]');
    await new Promise((r) => setTimeout(r, 150));
    await page.$eval('.hw-end [data-act="hw-end"][data-result="done"]', (b) => b.click()).catch(() => {});
    // The ring ran out: the block's own End ('time', paid at once), then his answer, once, however often he taps.
    const answers = () => calls(db, 'focus_by_token').filter((c) => c.body.p_action === 'end' && c.body.p_result === 'done').length;
    check('Step done ✓ twice on the end screen: the time End and one answer, then its points line',
      await until(async () => /^\+\d+ · \d+ minutes/.test(await hwText(page, '.hw-points-line')) && endsSent(db) === 2 && (await hwText(page, '.hw-end h2')) === 'Block finished.')
      && answers() === 1 && calls(db, 'focus_by_token').filter((c) => c.body.p_result === 'time').length === 1, `${endsSent(db)} ${answers()} ${await hwText(page, '.hw-focus')}`);
    db.slow = null;
    await page.context().close();
  }
  {
    // The wake lock follows the block, not the screen: kept while the ring runs on #homework, let go of when it
    // runs out on the day view, not asked for again on an end screen whose ring ran out.
    const held = async (pg) => { const r = await hwRec(pg); return r.wake.length - r.released; };
    ({ page, db } = await open({ label: 'hw-wake', path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await until(async () => (await page.evaluate(() => location.hash)) === '#focus' && !!(await page.$('.hw-ring')));
    await page.click('.hw-head a.list-back[href="#homework"]');
    await page.waitForSelector('.hw-tonight');
    await hwPause(page);
    await hwTick(page, db, 10 * 60 * 1000);
    check('the wake lock: kept while the block runs, on #homework too', (await held(page)) === 1, JSON.stringify(await hwRec(page)));
    await page.click('[data-act="hw-day"]');
    await page.waitForSelector('.hw-card');
    await hwTick(page, db, 11 * 60 * 1000);
    check('the wake lock: let go of when the ring runs out, on the day view (not only on #focus)', (await held(page)) === 0, JSON.stringify(await hwRec(page)));
    await page.click('.hw-card a.hw-card-focus');
    await page.waitForSelector('.hw-end [data-act="hw-end"]');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await hwTick(page, db, 2000);
    check('the wake lock: not asked for again on coming back to a block whose ring ran out', (await hwRec(page)).wake.length === 1 && (await held(page)) === 0, JSON.stringify(await hwRec(page)));
    await page.context().close();
    // A Start with no answer (503): the lock taken in the tap is let go of; a Start that works keeps its own.
    const d = hwDb();
    d.status = { focus_by_token: 503 };
    ({ page, db } = await open({ label: 'hw-wake-503', path: `/day.html?t=${JORDAN}`, db: d, device: HW_DEVICE, init: HW_STUBS, allowConsole: /status of 503/ }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    check('a Start answered 503: "Starting needs a connection." and the wake lock let go of',
      (await hwToast(page)) === 'Starting needs a connection.' && await until(async () => (await held(page)) === 0), JSON.stringify(await hwRec(page)));
    db.status = {};
    await hwClear(page);
    await page.click('.hw-card [data-act="hw-card-start"]');
    check('…Start again: the lock taken again in the tap and kept for the block',
      await until(async () => !!(await page.$('.hw-ring'))) && (await held(page)) === 1 && (await hwRec(page)).wake.length === 2, JSON.stringify(await hwRec(page)));
    await page.context().close();
  }
  for (const where of ['focus', 'homework', 'day']) {
    // The browser lets go of the lock while the page is hidden: coming back with the ring still running takes it
    // again on whatever view he comes back to, not only on #focus.
    const held = async (pg) => { const r = await hwRec(pg); return r.wake.length - r.released - r.dropped; };
    ({ page, db } = await open({ label: `hw-wake-back-${where}`, path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: HW_AUDIO_DROP }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await until(async () => (await page.evaluate(() => location.hash)) === '#focus' && !!(await page.$('.hw-ring')));
    if (where !== 'focus') { await page.click('.hw-head a.list-back[href="#homework"]'); await page.waitForSelector('.hw-tonight'); }
    if (where === 'day') { await page.click('[data-act="hw-day"]'); await page.waitForSelector('.hw-card'); }
    await hwPause(page);
    await hwTick(page, db, 60 * 1000);
    const before = await held(page);
    await page.evaluate(() => window.__hide());
    const hidden = await held(page);
    await hwTick(page, db, 60 * 1000);
    await page.evaluate(() => window.__show());
    await hwTick(page, db, 2000);
    check(`the wake lock: let go of by the browser while hidden, taken again on coming back to ${where === 'day' ? 'the day view' : `#${where}`} with the ring running`,
      before === 1 && hidden === 0 && await until(async () => (await held(page)) === 1) && (await hwRec(page)).wake.length === 2, JSON.stringify(await hwRec(page)));
    await page.context().close();
  }
  for (const first of ['smaller', 'ask']) {
    // A block on an assignment with no plan (Start on a Tonight row) has no step: Make it smaller or Ask Pat
    // first gives it one (Quick, the block's length; the block moves to it), then acts on that step.
    ({ page, db } = await open({ label: `hw-noplan-${first}`, path: `/day.html?t=${JORDAN}#homework`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector(`.hw-noplan[data-asg="${H.ws51}"]`);
    await page.click(`.hw-noplan[data-asg="${H.ws51}"] [data-act="hw-asg-start"]`);
    await until(async () => !!(await page.$('.hw-ring')));
    const block = (calls(db, 'focus_by_token')[0] || {}).body.p_session;
    await page.click('[data-act="hw-stuck"]');
    if (first === 'smaller') {
      await page.click('.hw-sheet [data-act="hw-smaller"]');
      await page.click('.hw-sheet [data-chip="0"]');
    } else {
      await page.click('.hw-sheet [data-act="hw-ask"]');
      await page.fill('.hw-sheet input[name="text"]', 'Do I show my work?');
      await page.click('.hw-sheet [data-act="hw-sheet-send"]');
    }
    await until(() => calls(db, 'step_by_token').length === 1 && !!calls(db, 'step_by_token')[0].done);
    await page.waitForTimeout(200);
    const one = db.homework_steps.find((x) => x.assignment_id === H.ws51 && x.title === 'Worksheet 5.1');
    const act = (calls(db, 'step_by_token')[0] || {}).body || {};
    check(`stuck on a block with no plan (${first} first): Quick with the block's length, the block moved to that step, then ${first} on it`,
      !!one && same(calls(db, 'assignment_by_token').map((c) => c.body), [{ p_token: JORDAN, p_action: 'quick', p_assignment: H.ws51, p_minutes: 20 }])
      && same(calls(db, 'focus_by_token').slice(1).map((c) => c.body), [{ p_token: JORDAN, p_action: 'switch', p_session: block, p_step: one.id }])
      && act.p_step === one.id && act.p_action === first && !(await page.$('.toast-error')),
      JSON.stringify([db.calls.map((c) => [c.name, c.body.p_action, c.body.p_step]), await text(page, '.toasts')]));
    if (first === 'smaller') {
      check('... the block goes on with the smaller step', await until(async () => (await hwText(page, '.hw-focus-title')) === 'Write one sentence')
        && db.focus_sessions.find((f) => f.id === block).step_id === act.p_key, await hwText(page, '.hw-focus-title'));
    } else {
      check('... his question is sent ("Question sent."), on the step', (await hwToast(page)) === 'Question sent.' && one.question === 'Do I show my work?', JSON.stringify(one));
    }
    await page.context().close();
  }
  {
    // Make it smaller sent twice: a second tap while the first is on its way, and a tap again after a lost answer
    // (the step was made). One key per sheet, so the server finds the step it made: one step, never two.
    for (const how of ['twice', 'lost']) {
      ({ page, db } = await open({ label: `hw-smaller-${how}`, path: `/day.html?t=${JORDAN}#homework`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS, ctx: phone(),
        allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
      await page.waitForSelector('.hw-now-card');
      if (how === 'twice') db.slow = { step_by_token: 600 };
      else db.loseAnswer = { step_by_token: 1 };
      await page.click(`.hw-tonight .hw-step[data-step="${H.s2}"] [data-act="hw-more"]`);
      await page.click(`.hw-step[data-step="${H.s2}"] .hw-menu [data-act="hw-smaller"]`);
      await page.click('.hw-sheet [data-chip="0"]');
      if (how === 'twice') await page.waitForTimeout(100);
      else {
        await until(() => calls(db, 'step_by_token').length === 1 && !!calls(db, 'step_by_token')[0].done);
        check('Make it smaller with a lost answer: "Can\'t reach Home Hub", the sheet stays', /^Can't reach Home Hub/.test(await hwToast(page)) && !!(await page.$('.hw-sheet [data-chip="0"]')), await text(page, '.toasts'));
      }
      await page.click('.hw-sheet [data-chip="0"]', { timeout: 1000 }).catch(() => {});
      await until(async () => calls(db, 'step_by_token').every((c) => c.done) && !(await page.$('.hw-sheet')));
      db.slow = null;
      const made = db.homework_steps.filter((x) => x.title === 'Write one sentence');
      const keys = [...new Set(calls(db, 'step_by_token').map((c) => c.body.p_key))];
      check(`Make it smaller, ${how === 'twice' ? 'tapped twice while the answer is on its way' : 'tapped again after a lost answer'}: one new step, one key, and it is Now`,
        made.length === 1 && keys.length === 1 && made[0].id === keys[0] && (await hwText(page, '.hw-now-title')) === 'Write one sentence',
        `steps=${made.length} keys=${JSON.stringify(keys)} now=${await hwText(page, '.hw-now-title')}`);
      await page.context().close();
    }
  }
  {
    // Chime even on silent: navigator.audioSession is 'playback' just for the chime (from a moment before it until
    // its last tone has played), not at Start; and never for a block stopped before its end.
    const silentInit = `${HW_AUDIO} try { localStorage.setItem('homehub.myday.chime-silent', '1'); } catch (e) {}`;
    ({ page, db } = await open({ label: 'hw-silent', path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: silentInit, ctx: phone() }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await until(async () => !!(await page.$('.hw-ring')));
    await hwPause(page);
    check('Chime even on silent: nothing changed at Start (his music plays on)', !(await hwRec(page)).session.length, JSON.stringify((await hwRec(page)).session));
    db.hwNow += 20 * 60 * 1000 + 3000;
    await page.clock.runFor(20 * 60 * 1000 + 3000);
    await page.waitForSelector('.hw-end', { timeout: 3000 });
    let r = await hwRec(page);
    const first = Math.min(...r.osc);
    const last = Math.max(...r.tones.map((t) => t.stopAt || 0));   // the chime's tones (the celebration's are rec.cheer)
    check('…"playback" from a moment before the chime, back to "auto" only once its last tone has played',
      same(r.session.map((x) => x.type), ['playback', 'auto']) && r.session[0].at >= first - 3.5 && r.session[0].at <= first && r.session[1].at >= last - 0.001,
      JSON.stringify({ session: r.session, first, last }));
    await page.context().close();
    ({ page, db } = await open({ label: 'hw-silent-stop', path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: silentInit, ctx: phone() }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await until(async () => !!(await page.$('.hw-ring')));
    await hwPause(page);
    db.hwNow += 5 * 60 * 1000;
    await page.clock.runFor(5 * 60 * 1000);
    await page.click('[data-act="hw-stop"]');
    await page.waitForSelector('.hw-points-line', { timeout: 3000 });
    await page.clock.runFor(20 * 60 * 1000);
    r = await hwRec(page);
    check('…a block stopped before its end: never "playback"', !r.session.some((x) => x.type === 'playback'), JSON.stringify(r.session));
    await page.context().close();
  }
  {
    // The chime after time away: iOS stops a hidden page's audio clock, so the tones are set again on coming
    // back (on the ring's end), called off when the ring ran out meanwhile, and made at the first tap after a reload.
    const chimeIn = (pg) => pg.evaluate(() => window.__chimeIn());
    ({ page, db } = await open({ label: 'hw-chime-away', path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: HW_AUDIO, ctx: phone() }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await until(async () => !!(await page.$('.hw-ring')));
    await hwPause(page);
    check('the chime: set at Start for the ring\'s end (20 minutes)', Math.abs((await chimeIn(page)) - 1200) < 2, String(await chimeIn(page)));
    await hwTick(page, db, 2 * 60 * 1000);
    await page.evaluate(() => window.__hide());
    await hwTick(page, db, 5 * 60 * 1000);
    await page.evaluate(() => window.__show());
    await until(async () => (await hwText(page, '.hw-left')) === '13 min');
    await page.waitForTimeout(200);
    check('back after 5 minutes away (the audio clock stood still): the chime set again for the ring\'s end, 13 minutes on', Math.abs((await chimeIn(page)) - 780) < 2,
      String(await chimeIn(page)));
    await page.evaluate(() => window.__hide());
    await hwTick(page, db, 20 * 60 * 1000);
    await page.evaluate(() => window.__show());
    await page.waitForSelector('.hw-end', { timeout: 3000 });
    await page.waitForTimeout(200);
    const late = await chimeIn(page);
    check('back after the ring ran out while away: the end screen, and no chime still to come', late === null || late <= 2, String(late));
    await page.context().close();
    // ... and the same on #homework and on the day: the block runs there too (the lock follows it), so the chime
    // is set again on coming back whatever is on screen, and a ring that ran out meanwhile leaves none to come.
    for (const where of ['homework', 'day']) {
      const on = where === 'day' ? 'on the day' : 'on #homework';
      ({ page, db } = await open({ label: `hw-chime-away-${where}`, path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: HW_AUDIO, ctx: phone() }));
      await page.click('.hw-card [data-act="hw-card-start"]');
      await until(async () => !!(await page.$('.hw-ring')));
      await hwPause(page);
      await hwTick(page, db, 2 * 60 * 1000);
      await page.click('.hw-head a.list-back');
      await until(async () => (await page.evaluate(() => location.hash)) === '#homework');
      if (where === 'day') {
        await page.click('.hw-head [data-act="hw-day"]');
        await page.waitForSelector('.hw-card', { timeout: 3000 });
      }
      await page.waitForTimeout(200);
      await page.evaluate(() => window.__hide());
      await hwTick(page, db, 5 * 60 * 1000);
      await page.evaluate(() => window.__show());
      await page.waitForTimeout(200);
      check(`…${on}, back after 5 minutes away: the chime set again for the ring's end, 13 minutes on`, Math.abs((await chimeIn(page)) - 780) < 2,
        String(await chimeIn(page)));
      await page.evaluate(() => window.__hide());
      await hwTick(page, db, 20 * 60 * 1000);
      // The ring ran out while away (iOS: the audio clock stood still): its tones are called off when it runs out.
      const away = await chimeIn(page);
      await page.evaluate(() => window.__show());
      await page.waitForTimeout(200);
      const back = await chimeIn(page);
      check(`…${on}, the ring ran out while away: no chime still to come, before or after coming back`,
        (away === null || away <= 2) && (back === null || back <= 2), JSON.stringify({ away, back }));
      await page.context().close();
    }
    ({ page, db } = await open({ label: 'hw-chime-reload', path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: HW_AUDIO, ctx: phone() }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await until(async () => !!(await page.$('.hw-ring')));
    await hwPause(page);
    await hwTick(page, db, 3 * 60 * 1000);
    await page.reload();
    await page.waitForSelector('.hw-ring', { timeout: 5000 });
    await hwPause(page);
    check('a reload: no AudioContext until a tap', !(await hwRec(page)).ctx.length);
    await page.click('[data-act="hw-stuck"]');
    await page.click('.hw-sheet [data-act="hw-sheet-close"]');
    await page.waitForTimeout(200);
    const after = await hwRec(page);
    check('…his first tap on #focus makes it (inside the tap) and sets the chime for the ring\'s end (17 minutes)',
      after.ctx.length === 1 && after.audio.length === 1 && after.audio[0].active && after.osc.length === 2 && Math.abs((await chimeIn(page)) - 1020) < 2,
      JSON.stringify({ audio: after.audio, osc: after.osc, chimeIn: await chimeIn(page) }));
    await page.context().close();
    // ... but a first tap that ends the block (Stop) sets no chime for it.
    ({ page, db } = await open({ label: 'hw-chime-reload-stop', path: `/day.html?t=${JORDAN}`, db: hwDb(), device: HW_DEVICE, init: HW_AUDIO, ctx: phone() }));
    await page.click('.hw-card [data-act="hw-card-start"]');
    await until(async () => !!(await page.$('.hw-ring')));
    await hwPause(page);
    await hwTick(page, db, 3 * 60 * 1000);
    await page.reload();
    await page.waitForSelector('.hw-ring', { timeout: 5000 });
    await hwPause(page);
    await page.click('[data-act="hw-stop"]');
    await page.waitForSelector('.hw-points-line', { timeout: 3000 });
    await page.waitForTimeout(200);
    check('…a first tap after a reload that is Stop: the block ends, and no chime is set for it', (await chimeIn(page)) === null, JSON.stringify((await hwRec(page)).osc));
    await page.context().close();
  }

  // =====================================================================
  // 19. #points: the balance and "+9 today", asks, rewards, suggest, the last entries
  // =====================================================================
  {
    const d = hwDb();
    d.points_ledger.push(ledgerRow({ kid_id: P.jordan, at: hwStamp(d.hwNow - 3600000), day: HWT, kind: 'focus', delta: 4, note: 'Do worksheet 4.2', who: 'Jordan (My day)' }),
      ledgerRow({ kid_id: P.jordan, at: hwStamp(d.hwNow - 3500000), day: HWT, kind: 'on_time', delta: 5, note: 'Do worksheet 4.2', who: 'Jordan (My day)' }));
    ({ page, db } = await open({ label: 'hw-points', path: `/day.html?t=${JORDAN}#points`, db: d, device: HW_DEVICE, init: HW_STUBS, ctx: phone() }));
    await page.waitForSelector('.hw-balance-big');
    check('#points: the balance and "+9 today", with no daily target', (await hwText(page, '.hw-balance-big')) === '★ 127' && (await hwText(page, '.hw-today')) === '+9 today'
      && !/ of /.test(await hwText(page, '.hw-today')), `${await hwText(page, '.hw-balance-big')} ${await hwText(page, '.hw-today')}`);
    check('#points: rewards, with what he can ask for and how many more the rest need',
      same(await page.$$eval('.hw-reward', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ').trim())), ['15 minutes of extra game time · 15 Ask', "Choose Friday's dinner · 60 Ask", 'A new book · 150 23 more']),
      JSON.stringify(await page.$$eval('.hw-reward', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ').trim()))));
    check('#points: decided asks for 7 days (Yes; Not now with the parent\'s word)', /Choose Friday's dinner · 60 · Yes/.test(await hwText(page, '.hw-decided'))
      && /15 minutes of extra game time · 15 · Not now: Not on a school night/.test(await hwText(page, '.hw-decided')), await hwText(page, '.hw-decided'));
    check('#points: the last entries ("+4 Focus · Do worksheet 4.2 · today", "Trade: …")',
      same((await hwTexts(page, '.hw-recent li')).slice(0, 2), ['+5 On time · Do worksheet 4.2 · today', '+4 Focus · Do worksheet 4.2 · today'])
      && (await hwTexts(page, '.hw-recent li')).includes("−60 Trade · Choose Friday's dinner · Sat"), JSON.stringify(await hwTexts(page, '.hw-recent li')));
    await page.click(`.hw-reward[data-reward="${H.dinner}"] [data-act="hw-ask-reward"]`);
    await until(() => calls(db, 'reward_by_token').length === 1);
    const ask = calls(db, 'reward_by_token')[0].body;
    check('Ask: reward_by_token ask with the reward and the phone\'s key', same(Object.assign({}, ask, { p_key: 'k' }), { p_token: JORDAN, p_action: 'ask', p_reward: H.dinner, p_key: 'k' }) && UUID.test(ask.p_key), JSON.stringify(ask));
    check('Ask: "Waiting for a parent", what is free to trade, "Tell a parent you asked."', await until(async () => /Waiting for a parent/.test(await hwText(page, '.hw-asks')))
      && /Choose Friday's dinner · 60/.test(await hwText(page, '.hw-asks')) && /67 free to trade/.test(await hwText(page, '.hw-asks'))
      && /Tell a parent you asked\./.test(await hwText(page, '.hw-asks')), await hwText(page, '.hw-asks'));
    await page.click('.hw-asks [data-act="hw-cancel-ask"]');
    await until(() => calls(db, 'reward_by_token').length === 2);
    check('Cancel: his own ask, by its key', same(calls(db, 'reward_by_token')[1].body, { p_token: JORDAN, p_action: 'cancel', p_key: ask.p_key })
      && await until(async () => !(await page.$('.hw-asks .hw-ask'))));
    await page.fill('.hw-suggest-form input[name="text"]', 'A trip to the climbing gym');
    await page.click('.hw-suggest-form [type="submit"]');
    await until(() => calls(db, 'reward_by_token').length === 3);
    const sug = calls(db, 'reward_by_token')[2].body;
    check('Suggest a reward: reward_by_token suggest with the phone\'s key; "a parent prices it"', same(Object.assign({}, sug, { p_key: 'k' }), { p_token: JORDAN, p_action: 'suggest', p_text: 'A trip to the climbing gym', p_key: 'k' })
      && (await hwText(page, '.hw-suggest-hint')) === 'A parent prices it.' && db.rewards.some((r) => r.id === sug.p_key && r.suggested && r.cost === null), JSON.stringify(sug));
    check('#points at 390px: no sideways scroll', await noSideScroll(page));
    await page.screenshot({ path: SHOTS + 'day-hw-points.png', fullPage: true });
    // Points off: no points, rewards or asks; #points goes back to #homework.
    db.homework_kids[0].points_on = false;
    await page.reload();
    await page.waitForSelector('.hw-now-card');
    check('points off: #points shows #homework, with no balance anywhere', (await page.evaluate(() => location.hash)) === '#homework' && !/★/.test(await hwText(page, 'main')), await hwText(page, 'main'));
    await page.goto(`${BASE}/day.html?t=${JORDAN}`);
    await page.waitForSelector('.hw-card');
    check('points off: the card has no balance either', !(await page.$('.hw-card-points')));
    await page.context().close();
  }

  // =====================================================================
  // 19b. The owner's "immediate gratification" (docs/v1.3-homework.md §8): instant rewards cashed on the spot,
  //      a milestone's first half at his tick, 10 minutes offered first, and a block paid the moment its ring
  //      runs out on the day view (after a reload, with no view read yet)
  // =====================================================================
  {
    const d = hwDb();
    d.rewards.find((r) => r.id === H.game).instant = true;
    ({ page, db } = await open({ label: 'hw-instant', path: `/day.html?t=${JORDAN}#points`, db: d, device: HW_DEVICE, init: HW_STUBS, ctx: phone() }));
    await page.waitForSelector('.hw-balance-big');
    const rewards = () => page.$$eval('.hw-reward', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
    check('#points: an instant reward is marked "instant", with "Get it now"; the others are asked for',
      same(await rewards(), ['15 minutes of extra game time · 15 · instant Get it now', "Choose Friday's dinner · 60 Ask", 'A new book · 150 32 more']), JSON.stringify(await rewards()));
    check('#points: the next-reward bar under the heading', (await hwText(page, '.hw-head .plan-goal-text')) === "You can get Choose Friday's dinner now!", await hwText(page, '.hw-head'));
    await page.click(`.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    check('Get it now asks once more ("Yes, get it · −15", Cancel), and sends nothing yet',
      (await hwText(page, '[data-act="hw-cash-yes"]')) === 'Yes, get it · −15' && !!(await page.$('[data-act="hw-cash-no"]')) && !calls(db, 'reward_by_token').length);
    await page.click('[data-act="hw-cash-yes"]');
    await until(() => calls(db, 'reward_by_token').length === 1 && !!calls(db, 'reward_by_token')[0].done);
    const cash = calls(db, 'reward_by_token')[0].body;
    check('Yes: reward_by_token cash, with the reward, the price his button showed and the phone\'s key',
      same(Object.assign({}, cash, { p_key: 'k' }), { p_token: JORDAN, p_action: 'cash', p_reward: H.game, p_key: 'k', p_cost: 15 })
      && UUID.test(cash.p_key), JSON.stringify(cash));
    check('cashed on the spot: "Got it: … Tell a parent.", ★ 103, "Got it" with his decided asks, and a trade of −15 the parents see',
      (await hwToast(page)) === 'Got it: 15 minutes of extra game time. Tell a parent.' && await until(async () => (await hwText(page, '.hw-balance-big')) === '★ 103')
      && /15 minutes of extra game time · 15 · Got it/.test(await hwText(page, '.hw-decided'))
      && db.points_ledger.some((l) => l.kind === 'trade' && l.delta === -15 && l.ask_id === cash.p_key) && db.reward_asks.find((q) => q.id === cash.p_key).status === 'cashed',
      `${await hwText(page, '.hw-balance-big')} | ${await hwText(page, '.hw-decided')}`);
    await hwClear(page);
    await page.click(`.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    await page.click('[data-act="hw-cash-yes"]');
    await until(() => calls(db, 'reward_by_token').length === 2 && !!calls(db, 'reward_by_token')[1].done);
    check('a second one today: a new key, ★ 88', calls(db, 'reward_by_token')[1].body.p_key !== cash.p_key && await until(async () => (await hwText(page, '.hw-balance-big')) === '★ 88'));
    check('past the parents\' 2 a day: no more "Get it now"; it can still be asked for, and he is told so',
      await until(async () => (await rewards())[0] === '15 minutes of extra game time · 15 · instant Ask') && (await hwText(page, '.hw-cash-none')) === 'No more instant rewards today: ask a parent.',
      JSON.stringify(await rewards()));
    await page.context().close();
  }
  {
    // A milestone ticked from From earlier: half its points at once (40 → +20 now, +20 when checked).
    ({ page, db } = await open({ label: 'hw-milestone-now', path: `/day.html?t=${JORDAN}#homework`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS, ctx: phone() }));
    await page.waitForSelector('.hw-now-card');
    await page.click('.hw-earlier summary');
    await page.click(`.hw-step[data-step="${H.v2}"] .hw-box`);
    await until(() => calls(db, 'step_by_token').length === 1 && !!calls(db, 'step_by_token')[0].done);
    check('a milestone ticked: half its points at once, "+20 now · +20 more when Pat checks it"',
      (await hwToast(page)).startsWith('+20 now · +20 more when Pat checks it') && db.points_ledger.some((l) => l.kind === 'milestone_done' && l.step_id === H.v2 && l.delta === 20),
      await text(page, '.toasts'));
    check('... the counter by the heading starts at ★ 118 with "+20", and ticks up to ★ 138', (await hwText(page, '.hw-head .hw-plus')) === '+20'
      && await until(async () => (await hwText(page, '.hw-head .hw-points')) === '★ 138'), await hwText(page, '.hw-head'));
    await page.context().close();
  }
  {
    // 10 minutes offered first (the default; the owner changed it from 20): the card's Start is 10 minutes.
    ({ page, db } = await open({ label: 'hw-ten', path: `/day.html?t=${JORDAN}`, db: hwDb({ length: 10 }), device: HW_DEVICE, init: HW_STUBS }));
    check('the default first length: "Start · 10 min" on the card', (await hwText(page, '.hw-card [data-act="hw-card-start"]')) === 'Start · 10 min', await hwText(page, '.hw-card'));
    await page.context().close();
    check('a new homework_kids row (the fakes\' default, as the migration\'s) offers 10 minutes first', hwKidRow({}).focus_minutes === 10);
  }
  {
    // A reload on the day view with a block running: when the card's ring runs out, his view is read once and the
    // block is paid at once (End 'time'), and the card asks how it went; #focus has the celebration's points.
    const d = hwDb();
    d.focus_sessions.push(sessionRow({ id: hid(98), kid_id: P.jordan, assignment_id: H.math, step_id: H.m1, minutes: 20, started_at: hwStamp(d.hwNow - 19 * 60000),
      ends_at: hwStamp(d.hwNow + 60000), on_time: true }));
    ({ page, db } = await open({ label: 'hw-day-payout', path: `/day.html?t=${JORDAN}`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    check('a block running, on the day view: "Focus · 1 min left ›", no view read yet', (await hwText(page, '.hw-card a.hw-card-focus')) === 'Focus · 1 min left ›'
      && !calls(db, 'homework_by_token').length, await hwText(page, '.hw-card'));
    await hwPause(page);
    await hwTick(page, db, 62 * 1000);
    await until(() => calls(db, 'focus_by_token').length === 1 && !!calls(db, 'focus_by_token')[0].done);
    check('its ring runs out on the day view: his view read once, and the block paid at once (end, time)', calls(db, 'homework_by_token').length === 1
      && same(calls(db, 'focus_by_token')[0].body, { p_token: JORDAN, p_action: 'end', p_session: hid(98), p_result: 'time' })
      && db.points_ledger.filter((l) => l.session_id === hid(98)).reduce((n, l) => n + l.delta, 0) === 30, JSON.stringify(db.calls.map((c) => [c.name, c.body.p_action])));
    check('... the card asks how it went, and celebrates there: "+30", counting up to the new balance',
      await until(async () => (await hwText(page, '.hw-card a.hw-card-focus')) === 'Your block is over. How did it go? ›' && (await hwText(page, '.hw-card .hw-plus')) === '+30')
      && await until(async () => { await page.clock.runFor(100); return (await hwText(page, '.hw-card-points')) === '★ 148'; }), await hwText(page, '.hw-card'));
    await page.click('.hw-card a.hw-card-focus');
    await page.waitForSelector('.hw-end [data-act="hw-end"]');
    check('... and #focus: "+20 · 20 minutes · +10 on time", How did it go? (the "+30" was the card\'s, not played again)',
      (await hwText(page, '.hw-points-line')) === '+20 · 20 minutes · +10 on time'
      && !(await page.$('.hw-end .hw-plus')) && (await hwText(page, '.hw-end h2')) === 'Time. How did it go?', await hwText(page, '.hw-end'));
    await page.click('.hw-end [data-act="hw-end"][data-result="done"]');
    await until(() => calls(db, 'focus_by_token').length === 2 && !!calls(db, 'focus_by_token')[1].done);
    check('... Step done: his answer, a second end; the step ticked, the points as paid',
      same(calls(db, 'focus_by_token')[1].body, { p_token: JORDAN, p_action: 'end', p_session: hid(98), p_result: 'done' }) && !!db.homework_steps.find((x) => x.id === H.m1).done_at
      && db.points_ledger.filter((l) => l.session_id === hid(98)).length === 2 && await until(async () => (await hwText(page, '.hw-end h2')) === 'Block finished.'), await hwText(page, '.hw-end'));
    await page.context().close();
  }

  // =====================================================================
  // 19c. Review fixes to 19b: the confirm tap never under the first one (a double tap spends nothing), a cash-in's
  //      key kept until it is answered, a refusal read again, the price his button showed, the bar never on a reward
  //      he asked for; the celebration's +N is what the End paid, played where he is (the card too) and never later;
  //      a reload between the paid End and his answer still asks how it went; the bar on the end screen and the break
  // =====================================================================
  const instantDb = () => { const d = hwDb(); d.rewards.find((r) => r.id === H.game).instant = true; return d; };
  const rewardRows = (pg) => pg.$$eval('.hw-reward', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  const centre = (pg, sel) => pg.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  {
    ({ page, db } = await open({ label: 'hw-cash-dbl', path: `/day.html?t=${JORDAN}#points`, db: instantDb(), device: HW_DEVICE, init: HW_STUBS, ctx: phone() }));
    await page.waitForSelector('.hw-balance-big');
    const at = await centre(page, `.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    await page.mouse.dblclick(at.x, at.y);
    await page.waitForTimeout(600);
    check('a double tap on "Get it now" only opens its "Yes, get it · −15": nothing is sent (the Yes waits a moment before it takes a tap)',
      !calls(db, 'reward_by_token').length && (await hwText(page, '[data-act="hw-cash-yes"]')) === 'Yes, get it · −15' && (await hwText(page, '.hw-balance-big')) === '★ 118',
      `calls=${calls(db, 'reward_by_token').length} ${await hwText(page, '.hw-balance-big')}`);
    await page.click('[data-act="hw-cash-no"]');
    const again = await centre(page, `.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    await page.touchscreen.tap(again.x, again.y);
    await page.touchscreen.tap(again.x, again.y);
    await page.waitForTimeout(600);
    check('... and so do two quick taps on a touch screen', !calls(db, 'reward_by_token').length && db.reward_asks.every((q) => q.status !== 'cashed'),
      `calls=${calls(db, 'reward_by_token').length}`);
    await page.click('[data-act="hw-cash-yes"]');
    check('... a deliberate Yes then cashes it', await until(() => calls(db, 'reward_by_token').length === 1 && !!calls(db, 'reward_by_token')[0].done)
      && await until(async () => (await hwText(page, '.hw-balance-big')) === '★ 103'));
    await page.context().close();
  }
  {
    // A refusal (a parent set today's instant rewards to 0 after #points was drawn): his view is read again.
    ({ page, db } = await open({ label: 'hw-cash-refused', path: `/day.html?t=${JORDAN}#points`, db: instantDb(), device: HW_DEVICE, init: HW_STUBS, ctx: phone(),
      allowConsole: /status of 4\d\d/ }));
    await page.waitForSelector('.hw-balance-big');
    db.homework_kids.find((k) => k.kid_id === P.jordan).instant_day = 0;
    const reads = calls(db, 'homework_by_token').length;
    await page.click(`.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    await page.click('[data-act="hw-cash-yes"]');
    check('a refused cash-in says why ("That\'s all the instant rewards for today…")', (await hwToast(page)) === "That's all the instant rewards for today. Ask a parent for this one.");
    check('... and his view is read again: no "Get it now" left, "No more instant rewards today", the reward can be asked for',
      await until(async () => calls(db, 'homework_by_token').length === reads + 1 && (await rewardRows(page))[0] === '15 minutes of extra game time · 15 · instant Ask')
      && (await hwText(page, '.hw-cash-none')) === 'No more instant rewards today: ask a parent.', JSON.stringify(await rewardRows(page)));
    await page.context().close();
  }
  {
    // The price his button showed: a parent changes it meanwhile; the cash-in is refused and the new price drawn.
    ({ page, db } = await open({ label: 'hw-cash-price', path: `/day.html?t=${JORDAN}#points`, db: instantDb(), device: HW_DEVICE, init: HW_STUBS, ctx: phone(),
      allowConsole: /status of 4\d\d/ }));
    await page.waitForSelector('.hw-balance-big');
    await page.click(`.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    db.rewards.find((r) => r.id === H.game).cost = 30;
    await page.click('[data-act="hw-cash-yes"]');
    check('a price changed since his screen showed it: refused ("That reward\'s price changed."), nothing taken',
      (await hwToast(page)) === "That reward's price changed. Look again before you get it." && calls(db, 'reward_by_token')[0].body.p_cost === 15
      && !db.reward_asks.some((q) => q.status === 'cashed' && q.reward_id === H.game && q.cost === 30), await text(page, '.toasts'));
    check('... and the new price drawn', await until(async () => (await rewardRows(page))[0] === '15 minutes of extra game time · 30 · instant Get it now'),
      JSON.stringify(await rewardRows(page)));
    await page.context().close();
  }
  {
    // A cash-in whose answer is lost, and the read after it too: Cancel and Get it now again keep its key, so the
    // tap again finds the cash-in it made.
    ({ page, db } = await open({ label: 'hw-cash-lost', path: `/day.html?t=${JORDAN}#points`, db: instantDb(), device: HW_DEVICE, init: HW_STUBS, ctx: phone(),
      allowConsole: /ERR_INTERNET_DISCONNECTED|Failed to load/ }));
    await page.waitForSelector('.hw-balance-big');
    db.loseAnswer = { reward_by_token: 1, homework_by_token: 1 };
    await page.click(`.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    await page.click('[data-act="hw-cash-yes"]');
    await until(() => calls(db, 'reward_by_token').length === 1 && !!calls(db, 'reward_by_token')[0].done && db.loseAnswer.homework_by_token === 0);
    await page.waitForTimeout(300);
    // Its "Can't reach" stays 6 seconds: cleared, so the toast checked below is the one the second Yes brings
    // (the fake marks a call done before its answer reaches the page).
    check('a cash-in with a lost answer, and the read after it lost too: "Can\'t reach Home Hub", its Yes still there',
      (await hwToast(page)) === "Can't reach Home Hub. Check your internet connection and try again." && !!(await page.$('[data-act="hw-cash-yes"]')), await text(page, '.toasts'));
    await hwClear(page);
    await page.click('[data-act="hw-cash-no"]');
    await page.evaluate(() => { location.hash = '#homework'; });
    await page.waitForSelector('.hw-tonight');
    await page.evaluate(() => { location.hash = '#points'; });
    await page.waitForSelector(`.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    await page.click(`.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    await page.click('[data-act="hw-cash-yes"]');
    await until(() => calls(db, 'reward_by_token').length === 2 && !!calls(db, 'reward_by_token')[1].done);
    const keys = calls(db, 'reward_by_token').map((c) => c.body.p_key);
    const got = await hwToast(page);
    const cashed = db.reward_asks.filter((q) => q.status === 'cashed').length;
    const trades = db.points_ledger.filter((l) => l.kind === 'trade' && l.delta === -15).length;
    check('a lost answer, Cancel, another view, Get it now and Yes again: the same key, one cash-in, one trade of −15',
      keys[0] === keys[1] && cashed === 1 && trades === 1 && got === 'Got it: 15 minutes of extra game time. Tell a parent.',
      `keys same=${keys[0] === keys[1]} cashed=${cashed} trades=${trades} toast=${JSON.stringify(got)} toasts=${JSON.stringify(await texts(page, '.toast'))}`);
    await page.context().close();
  }
  {
    // A cash-in whose answer is lost: the read after it shows it landed ("Got it"), and no Yes is left to tap twice.
    const d = instantDb();
    d.loseAnswer = { reward_by_token: 1 };
    ({ page, db } = await open({ label: 'hw-cash-landed', path: `/day.html?t=${JORDAN}#points`, db: d, device: HW_DEVICE, init: HW_STUBS, ctx: phone(),
      allowConsole: /ERR_INTERNET_DISCONNECTED|Failed to load/ }));
    await page.waitForSelector('.hw-balance-big');
    await page.click(`.hw-reward[data-reward="${H.game}"] [data-act="hw-cash"]`);
    await page.click('[data-act="hw-cash-yes"]');
    check('a lost answer: his view is read again and shows the cash-in landed ("Got it", ★ 103), with no Yes left',
      await until(async () => (await hwText(page, '.hw-balance-big')) === '★ 103' && /15 minutes of extra game time · 15 · Got it/.test(await hwText(page, '.hw-decided')))
      && !(await page.$('[data-act="hw-cash-yes"]')) && /Got it: 15 minutes of extra game time\. Tell a parent\./.test(await text(page, '.toasts'))
      && db.reward_asks.filter((q) => q.status === 'cashed').length === 1, `${await hwText(page, '.hw-balance-big')} | ${await text(page, '.toasts')}`);
    await page.context().close();
  }
  {
    // The bar never names a reward he asked for: its points are held, waiting for a parent's Yes.
    const d = hwDb();
    d.rewards.find((r) => r.id === H.game).active = false;
    d.rewards.find((r) => r.id === H.dinner).cost = 100;
    ({ page, db } = await open({ label: 'hw-goal-asked', path: `/day.html?t=${JORDAN}#points`, db: d, device: HW_DEVICE, init: HW_STUBS, ctx: phone() }));
    await page.waitForSelector('.hw-balance-big');
    await page.click(`.hw-reward[data-reward="${H.dinner}"] [data-act="hw-ask-reward"]`);
    await until(() => calls(db, 'reward_by_token').length === 1 && !!calls(db, 'reward_by_token')[0].done);
    check('after he asks for the dinner (100 of his 118), the bar is toward A new book (132 to go), never the dinner',
      await until(async () => (await hwText(page, '.hw-head .plan-goal-text')) === '132 points to A new book'), await hwText(page, '.hw-head .plan-goal'));
    await page.goto(`${BASE}/day.html?t=${JORDAN}`);
    await page.waitForSelector('.hw-card');
    check('... on the card too', (await hwText(page, '.hw-card .plan-goal-text')) === '132 points to A new book', await hwText(page, '.hw-card .plan-goal'));
    await page.context().close();
  }
  const running = (d) => d.focus_sessions.push(sessionRow({ id: hid(98), kid_id: P.jordan, assignment_id: H.math, step_id: H.m1, minutes: 20,
    started_at: hwStamp(d.hwNow - 19 * 60000), ends_at: hwStamp(d.hwNow + 60000), on_time: true }));
  {
    // Paid on the day view: the card celebrates there and then, and a later #homework has no stale "+N".
    const d = hwDb();
    running(d);
    ({ page, db } = await open({ label: 'hw-cheer-day', path: `/day.html?t=${JORDAN}`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    await page.click('.hw-card a.hw-card-focus');
    await page.waitForSelector('.hw-ring');
    await page.click('.hw-focus h1');   // his first tap on #focus after a reload makes the AudioContext
    await page.goBack();
    await page.waitForSelector('.hw-card');
    await hwPause(page);
    await hwTick(page, db, 62 * 1000);
    await until(() => calls(db, 'focus_by_token').length === 1 && !!calls(db, 'focus_by_token')[0].done);
    check('paid while he is on the day: the card shows "+30" and counts up from ★ 118 to ★ 148, with the short sound',
      await until(async () => (await hwText(page, '.hw-card .hw-plus')) === '+30') && (await hwRec(page)).cheer.length > 0
      && await until(async () => { await page.clock.runFor(100); return (await hwText(page, '.hw-card-points')) === '★ 148'; }), await hwText(page, '.hw-card'));
    const sounds = (await hwRec(page)).cheer.length;
    await hwTick(page, db, 10 * 60 * 1000);
    await page.click('.hw-card .hw-open');
    await page.waitForSelector('.hw-tonight');
    check('... and ten minutes later #homework has no "+30" and no sound: ★ 148 as it is', !(await page.$('.hw-head .hw-plus'))
      && (await hwText(page, '.hw-head .hw-points')) === '★ 148' && (await hwRec(page)).cheer.length === sounds, await hwText(page, '.hw-head'));
    await page.context().close();
  }
  {
    // The "+N" is what the End paid, whatever else moved his balance during the block.
    const d = hwDb();
    running(d);
    ({ page, db } = await open({ label: 'hw-cheer-given', path: `/day.html?t=${JORDAN}#focus`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-ring');
    db.points_ledger.push(ledgerRow({ kid_id: P.jordan, at: hwStamp(db.hwNow), day: HWT, kind: 'given', delta: 50, note: 'Helped with dinner', who: 'alex@example.com' }));
    await hwPause(page);
    await hwTick(page, db, 62 * 1000);
    await until(() => calls(db, 'focus_by_token').length === 1 && !!calls(db, 'focus_by_token')[0].done);
    check('a parent gave 50 during the block: the end screen\'s "+30" is what the block paid (not +80)',
      await until(async () => (await hwText(page, '.hw-end .hw-plus')) === '+30'), `${await hwText(page, '.hw-end .hw-plus')} | ${await hwText(page, '.hw-points-line')}`);
    await page.context().close();
  }
  {
    const d = hwDb();
    running(d);
    d.reward_asks.push({ id: hid(77), kid_id: P.jordan, reward_id: H.dinner, title: "Choose Friday's dinner", cost: 60, status: 'waiting',
      asked_at: '2026-11-02T21:00:00.000000+00:00', decided_at: null, decided_by: null, note: null });
    ({ page, db } = await open({ label: 'hw-cheer-trade', path: `/day.html?t=${JORDAN}#focus`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-ring');
    await page.click('.hw-focus h1');   // his first tap on #focus after a reload makes the AudioContext
    Object.assign(db.reward_asks.find((x) => x.id === hid(77)), { status: 'approved', decided_at: hwStamp(db.hwNow), decided_by: 'alex@example.com' });
    db.points_ledger.push(ledgerRow({ kid_id: P.jordan, at: hwStamp(db.hwNow), day: HWT, kind: 'trade', delta: -60, ask_id: hid(77), note: "Choose Friday's dinner", who: 'alex@example.com' }));
    await hwPause(page);
    await hwTick(page, db, 62 * 1000);
    await until(() => calls(db, 'focus_by_token').length === 1 && !!calls(db, 'focus_by_token')[0].done);
    check('a parent said Yes to his ask (−60) during the block: the block\'s "+30" is still celebrated, up to ★ 88',
      await until(async () => (await hwText(page, '.hw-end .hw-plus')) === '+30') && (await hwRec(page)).cheer.length > 0
      && await until(async () => { await page.clock.runFor(100); return (await hwText(page, '.hw-end-balance')) === '★ 88'; }), `${await hwText(page, '.hw-end')}`);
    await page.context().close();
  }
  {
    // A reload between the paid End and his answer: #focus asks again (the view's answer_due), and so do #homework
    // and the card; his answer ticks the step.
    const d = hwDb();
    running(d);
    ({ page, db } = await open({ label: 'hw-answer-due', path: `/day.html?t=${JORDAN}#focus`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-ring');
    await hwPause(page);
    await hwTick(page, db, 62 * 1000);
    await until(() => calls(db, 'focus_by_token').length === 1 && !!calls(db, 'focus_by_token')[0].done);
    await page.waitForSelector('.hw-end [data-act="hw-end"]');
    await page.clock.resume();
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('.loading'));
    check('a reload after the ring ran out (paid): #focus still asks "Time. How did it go?", with what it paid',
      await until(async () => (await hwText(page, '.hw-end h2')) === 'Time. How did it go?') && (await hwText(page, '.hw-points-line')) === '+20 · 20 minutes · +10 on time'
      && !(await page.$('.hw-end .hw-plus')), `${await page.evaluate(() => location.hash)} | ${await hwText(page, 'main')}`.slice(0, 240));
    await page.evaluate(() => { location.hash = '#homework'; });
    check('... #homework asks too', await until(async () => (await hwText(page, '.hw-block')) === 'Your block is over. How did it go? ›'), await hwText(page, '.hw-block'));
    await page.goto(`${BASE}/day.html?t=${JORDAN}`);
    await page.waitForSelector('.hw-card');
    check('... and so does the card on My day after a reload', (await hwText(page, '.hw-card a.hw-card-focus')) === 'Your block is over. How did it go? ›', await hwText(page, '.hw-card'));
    await page.click('.hw-card a.hw-card-focus');
    await page.waitForSelector('.hw-end [data-act="hw-end"][data-result="done"]');
    await page.click('.hw-end [data-act="hw-end"][data-result="done"]');
    check('... Step done from there: his answer, the step ticked, the points as paid',
      await until(() => calls(db, 'focus_by_token').length === 2 && !!calls(db, 'focus_by_token')[1].done)
      && same(calls(db, 'focus_by_token')[1].body, { p_token: JORDAN, p_action: 'end', p_session: hid(98), p_result: 'done' }) && !!db.homework_steps.find((x) => x.id === H.m1).done_at
      && db.points_ledger.filter((l) => l.session_id === hid(98)).reduce((n, l) => n + l.delta, 0) === 30
      && await until(async () => (await hwText(page, '.hw-end h2')) === 'Block finished.'), await hwText(page, '.hw-end'));
    await page.context().close();
  }
  {
    // The next-reward bar stays on the timer screen: the end screen, after his answer, and the break.
    const d = hwDb();
    running(d);
    ({ page, db } = await open({ label: 'hw-goal-end', path: `/day.html?t=${JORDAN}#focus`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-ring');
    await hwPause(page);
    await hwTick(page, db, 62 * 1000);
    await until(() => calls(db, 'focus_by_token').length === 1 && !!calls(db, 'focus_by_token')[0].done);
    await page.waitForSelector('.hw-end .hw-points-line');
    const atEnd = await hwText(page, '.hw-focus .plan-goal');
    await page.click('.hw-end [data-act="hw-end"][data-result="more"]');
    await until(async () => (await hwText(page, '.hw-end h2')) === 'Block finished.');
    const finished = await hwText(page, '.hw-focus .plan-goal');
    await page.click('[data-act="hw-break"]');
    const brk = await hwText(page, '.hw-focus .plan-goal');
    const want = "You can get Choose Friday's dinner now!2 points to A new book";
    check('the next-reward bar on the timer screen when the block ends, after his answer and on the break ("2 points to A new book")',
      atEnd === want && finished === want && brk === want, JSON.stringify({ atEnd, finished, brk }));
    await page.context().close();
  }

  // =====================================================================
  // 20. #plan/<id>: his rules (a plain step moved, a milestone locked), and Re-plan
  // =====================================================================
  {
    // The stale save below is refused with a 400, which Chrome logs.
    ({ page, db } = await open({ label: 'hw-plan', path: `/day.html?t=${JORDAN}#plan/${H.sci}`, db: hwDb(), device: HW_DEVICE, init: HW_STUBS, allowConsole: /status of 400/ }));
    await page.waitForSelector('.plan-editor');
    check('#plan/<id>: the editor in his role, with ‹ Homework', (await page.$eval('.plan-editor', (e) => e.dataset.role)) === 'kid' && (await hwText(page, '.hw-head .list-back')) === '‹ Homework');
    check('#plan/<id>: milestones and the turn-in locked, with "Milestones are checkpoints you set with Pat. Change them together."',
      !(await page.$(`.plan-step[data-id="${H.s3}"] select[name="day"]`)) && !!(await page.$(`.plan-step[data-id="${H.s3}"] .plan-lock`))
      && (await hwText(page, '.plan-lock-note')) === 'Milestones are checkpoints you set with Pat. Change them together.');
    // His path at the top: the days with his open steps (has-work), from the view and then from each write's answer.
    const workDays = () => page.$$eval('.hw-plan-path .plan-path-day', (ds) => ds.map((d, i) => (d.classList.contains('has-work') ? i : -1)).filter((i) => i >= 0));
    const dbWorkDays = () => [...new Set(db.homework_steps.filter((x) => x.assignment_id === H.sci && !x.done_at && x.day && x.day >= HWT)
      .map((x) => Math.round((Date.parse(`${x.day}T00:00:00Z`) - Date.parse(`${HWT}T00:00:00Z`)) / 864e5)))].sort((a, b) => a - b);
    check('#plan/<id>: his path at the top, his open steps on its days', same(await workDays(), [0, 2, 3, 9, 11]), JSON.stringify(await workDays()));
    const reads = calls(db, 'homework_by_token').length;
    const i2 = await page.$eval(`.plan-step[data-id="${H.s2}"]`, (e) => e.dataset.i);
    await page.selectOption(`.plan-step[data-i="${i2}"] select[name="day"]`, '2026-11-03');
    await page.click('.plan-editor [data-act="save"]');
    await until(() => calls(db, 'plan_by_token').length === 1);
    const ps = calls(db, 'plan_by_token')[0].body;
    check('Save: plan_by_token with the whole plan and its rev; the plain step moved', ps.p_assignment === H.sci && ps.p_rev === 3
      && ps.p_steps.find((s) => s.id === H.s2).day === '2026-11-03' && ps.p_steps.find((s) => s.id === H.s3).day === '2026-11-04'
      && db.homework_steps.find((s) => s.id === H.s2).day === '2026-11-03', JSON.stringify(ps));
    check('Save: the path at the top drawn again from the answer (the moved step on Tue), with no read in between',
      await until(async () => same(await workDays(), [0, 1, 2, 3, 9, 11])) && calls(db, 'homework_by_token').length === reads, JSON.stringify([await workDays(), calls(db, 'homework_by_token').length - reads]));
    // A stale copy (someone ticked a step since): reloads with "Changed since you opened it".
    db.assignments.find((a) => a.id === H.sci).plan_rev += 1;
    const i4 = await page.$eval(`.plan-step[data-id="${H.s4}"]`, (e) => e.dataset.i);
    await page.selectOption(`.plan-step[data-i="${i4}"] select[name="day"]`, '2026-11-09');
    await page.click('.plan-editor [data-act="save"]');
    check('a stale save: read again, "Changed since you opened it: here it is now."', await until(async () => (await hwText(page, '.plan-msg')) === 'Changed since you opened it: here it is now.'), await hwText(page, '.plan-msg'));
    await page.click('.plan-editor [data-act="replan"]');
    await until(() => calls(db, 'plan_by_token').length === 3);
    check('Re-plan in the editor: plan_by_token with p_steps null', calls(db, 'plan_by_token')[2].body.p_steps === null);
    const r3 = calls(db, 'homework_by_token').length;
    check('Re-plan: the path at the top drawn again from its answer (the days as placed again), with no read in between',
      await until(async () => same(await workDays(), dbWorkDays())) && !same(dbWorkDays(), [0, 1, 2, 3, 9, 11]) && calls(db, 'homework_by_token').length === r3,
      JSON.stringify([await workDays(), dbWorkDays()]));
    await page.click('.hw-head .list-back');
    check('‹ Homework goes back to #homework', await until(async () => (await page.evaluate(() => location.hash)) === '#homework'));
    await page.context().close();
  }

  // =====================================================================
  // 21. Spanish: the words, and the database's messages in his words (before the 42501 line)
  // =====================================================================
  {
    // The refusals below come back as 400 and 403, which Chrome logs.
    ({ page, db } = await open({ label: 'hw-es', path: `/day.html?t=${JORDAN}`, db: hwDb({ lang: 'es', ifStuck: null }), device: HW_DEVICE, init: HW_STUBS, ctx: phone(),
      allowConsole: /status of 40[03]/ }));
    check('Spanish card: "Tarea · 16:30 · 3 pasos · 45 min · 2 de antes", "Empezar · 20 min", "Abrir ›"',
      (await hwText(page, '.hw-card-head')) === 'Tarea · 16:30 · 3 pasos · 45 min · 2 de antes' && (await hwText(page, '.hw-card [data-act="hw-card-start"]')) === 'Empezar · 20 min'
      && (await hwText(page, '.hw-card a.hw-open')) === 'Abrir ›' && (await hwText(page, '.hw-card-next')) === 'Siguiente: Worksheet 4.2 · Do worksheet 4.2', await hwText(page, '.hw-card'));
    await page.click('.hw-card a.hw-open');
    await page.waitForSelector('.hw-now-card');
    check('Spanish #homework: Ahora, Esta tarde, Para pronto, De antes, + Tarea, the who-sees line',
      /^Ahora · tiempo de tarea 16:30–17:15 · empieza antes de las 16:40 para \+10$/.test(await hwText(page, '#hw-now-h'))
      && (await hwText(page, '.hw-head .plan-goal-text')) === '¡Ya puedes conseguir Choose Friday\'s dinner!' && (await hwText(page, '.hw-head .plan-goal-next')) === '32 puntos para A new book'
      && (await hwText(page, '#hw-tonight-h')) === 'Esta tarde · 45 min planeados · 45 min de tiempo de tarea'
      && (await hwText(page, '#hw-due-h')) === 'Para pronto' && (await hwText(page, '.hw-earlier summary')) === 'De antes · 2 pasos · 35 min · Volver a planear ›'
      && (await hwText(page, '[data-act="hw-add"]')) === '+ Tarea'
      && (await hwText(page, '.hw-who')) === 'Pat y los adultos de tu familia ven tu plan y tus notas. Los adultos ven tus puntos.'
      && (await hwText(page, '.hw-head .list-back')) === '‹ Mi día' && (await hwText(page, '.hw-head h1')) === 'Tarea',
      `${await hwText(page, '#hw-now-h')} | ${await hwText(page, '#hw-tonight-h')} | ${await hwText(page, '.hw-earlier summary')}`);
    check('Spanish Due soon: "Por detrás del plan · Volver a planear ›" and the milestone line', /Por detrás del plan · Volver a planear ›/.test(await hwText(page, '.hw-due'))
      && /Flashcards made estaba planeado para el vie 30 oct\. Elige otro día con Pat ›/.test(await hwText(page, '.hw-due')), await hwText(page, '.hw-due'));
    check('Spanish: the length chips, Solo / Con Pat / Con tu madre o tu padre', same(await page.$$eval('.hw-now-card select[name="with"] option', (os) => os.map((x) => x.textContent)), ['Solo', 'Con Pat', 'Con tu madre o tu padre']));
    await page.screenshot({ path: SHOTS + 'day-hw-es.png', fullPage: true });
    // The stuck sheet with no if-stuck line yet.
    await page.click('.hw-now-card [data-act="hw-start"]');
    await page.waitForSelector('.hw-ring');
    check('Spanish #focus: Estoy atascado, Hecho, Parar', same(await hwTexts(page, '.hw-focus-acts button'), ['Estoy atascado', 'Hecho', 'Parar'])
      && (await hwText(page, '.hw-ontime')) === 'A tiempo · +10 cuando lleves 5 minutos' && (await hwText(page, '.hw-sofar')) === '+0 hasta ahora',
      JSON.stringify(await hwTexts(page, '.hw-focus-acts button')));
    await page.click('[data-act="hw-stuck"]');
    check('Spanish stuck sheet: no plan yet → "Escribe tu plan para cuando te atasques ✎"; Hazlo más pequeño, Preguntar a Pat, Siguiente paso, Volver al temporizador',
      (await hwText(page, '.hw-sheet .hw-stuck-plan')) === 'Escribe tu plan para cuando te atasques ✎'
      && same(await hwTexts(page, '.hw-sheet .hw-sheet-acts > button'), ['Hazlo más pequeño', 'Preguntar a Pat', 'Siguiente paso', 'Volver al temporizador']), await hwText(page, '.hw-sheet'));
    await page.click('.hw-sheet [data-act="hw-smaller"]');
    check('Spanish chips', same(await hwTexts(page, '.hw-sheet [data-chip]'), ['Escribe una frase', 'Apunta lo que no está claro', 'Haz la parte más fácil']));
    await page.click('.hw-sheet [data-act="hw-sheet-close"]');
    await hwPause(page);
    await hwTick(page, db, 20 * 60 * 1000 + 2000);
    await page.waitForSelector('.hw-end [data-act="hw-end"]');
    check('Spanish end screen', (await hwText(page, '.hw-end h2')) === 'Tiempo. ¿Qué tal fue?' && same(await hwTexts(page, '.hw-end [data-act="hw-end"]'), ['Paso hecho ✓', 'Queda más']));
    await page.click('.hw-end [data-act="hw-end"][data-result="done"]');
    check('Spanish points line', await until(async () => (await hwText(page, '.hw-points-line')) === '+20 · 20 minutos · +10 a tiempo'), await hwText(page, '.hw-end'));
    await page.goto(`${BASE}/day.html?t=${JORDAN}#homework`);
    await page.waitForSelector('.hw-now-card');
    // Each database message, from a homework call, in his words.
    const msgs = [
      [403, '42501', "That step isn't on your plan.", 'Ese paso no está en tu plan.'],
      [403, '42501', 'Only your own tick can be undone, for 15 minutes.', 'Solo puedes deshacer lo que marcaste tú, durante 15 minutos.'],
      [403, '42501', "That's a checkpoint. Change it with Pat.", 'Es un punto de control. Cámbialo con Pat.'],
      [400, 'P0001', 'Finish the block you started first.', 'Termina primero el bloque que empezaste.'],
      [403, '42501', "That block isn't yours.", 'Ese bloque no es tuyo.'],
      [400, 'P0001', "That's a lot for one day.", 'Es mucho para un día. Sigue mañana.'],
      [400, 'P0001', "No homework day before it's due has room. Re-plan, make it smaller, or ask Pat.", 'No queda ningún día de tarea con sitio antes de la entrega. Vuelve a planear, hazlo más pequeño o pregunta a Pat.'],
      [400, 'P0001', 'This plan was changed since you opened it.', 'Este plan cambió desde que lo abriste.'],
      [403, '42501', 'Not enough points yet.', 'Todavía no tienes puntos suficientes.'],
      [403, '42501', 'Points are off.', 'Los puntos están desactivados.'],
      [400, '22023', 'Choose 10, 15, 20 or 25 minutes.', 'Elige 10, 15, 20 o 25 minutos.'],
      [403, '42501', 'Plan this one with Pat.', 'Planéalo con Pat.'],
      [400, '22023', 'Set a homework time first.', 'Primero hay que poner un tiempo de tarea.'],
      // His limits: retrying can't help, so never "Algo salió mal. Inténtalo de nuevo.".
      [400, '22023', 'At most 20 steps.', 'Como mucho 20 pasos.'],
      [400, 'P0001', 'Three asks are waiting already. Wait for a parent first.', 'Ya hay tres pedidos esperando. Espera primero a tus padres.'],
      [400, 'P0001', 'Five suggestions are waiting already. Wait for a parent first.', 'Ya hay cinco propuestas esperando. Espera primero a tus padres.'],
      [400, 'P0001', 'Fifteen of your own are open already.', 'Ya tienes quince tareas tuyas abiertas.'],
      // A token writer's last guard: a constraint error said without its detail.
      [400, '22023', "That can't be saved.", 'Eso no se puede guardar.'],
      // Instant rewards: one that needs a parent's yes, and the day's limit on cashing them.
      [403, '42501', 'Ask a parent for that one.', 'Ese pídeselo a tus padres.'],
      [400, 'P0001', "That's all the instant rewards for today. Ask a parent for this one.", 'Ya usaste los premios al momento de hoy. Este pídeselo a tus padres.'],
    ];
    for (const [status, code, msg, words] of msgs) {
      await hwClear(page);
      db.hwError = [status, code, msg];
      await page.click(`.hw-tonight .hw-step[data-step="${H.s1}"] [data-act="hw-more"]`);
      await page.click(`.hw-step[data-step="${H.s1}"] .hw-menu [data-act="hw-not-today"]`);
      const shown = await page.waitForSelector('.toast-error', { timeout: 3000 }).then(() => text(page, '.toast-error')).catch(() => '');
      check(`Spanish: "${msg}" → "${words}"`, shown === words, shown);
      await page.waitForTimeout(50);
    }
    // Not today to a day past tomorrow (Tuesday's homework time is full): "Pasado al mié", as plan.js's t()
    // says it ("a el" → "al").
    await hwClear(page);
    db.hwError = null;
    db.hwBusy[P.jordan]['2026-11-03'] = [{ starts: '16:00', ends: '18:00', title: 'Piano' }];
    const movedCalls = calls(db, 'step_by_token').length;
    await page.click(`.hw-tonight .hw-step[data-step="${H.s1}"] [data-act="hw-more"]`);
    await page.click(`.hw-step[data-step="${H.s1}"] .hw-menu [data-act="hw-not-today"]`);
    await until(() => calls(db, 'step_by_token').length === movedCalls + 1 && !!calls(db, 'step_by_token').slice(-1)[0].done);
    const movedEs = await hwToast(page);
    check('Spanish Not today to Wednesday: "Pasado al mié" (a + el → al), never "a el"',
      db.homework_steps.find((x) => x.id === H.s1).day === '2026-11-04' && movedEs === 'Pasado al mié', `${movedEs} | ${db.homework_steps.find((x) => x.id === H.s1).day}`);
    await page.context().close();
  }
  {
    // No tutor link: "Ask for help", and the words without Pat.
    ({ page, db } = await open({ label: 'hw-notutor', path: `/day.html?t=${JORDAN}#homework`, db: hwDb({ noTutor: true }), device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-now-card');
    check('no tutor link: "With your tutor" is left out, and the who-sees line names only the family',
      same(await page.$$eval('.hw-now-card select[name="with"] option', (os) => os.map((x) => x.value)), ['alone', 'parent'])
      && (await hwText(page, '.hw-who')) === 'The grown-ups in your family see your plan, your notes and your points.');
    await page.click(`.hw-tonight .hw-step[data-step="${H.s1}"] [data-act="hw-more"]`);
    check('no tutor link: "Ask for help"', (await hwTexts(page, `.hw-step[data-step="${H.s1}"] .hw-menu button`)).includes('Ask for help'));
    await page.context().close();
  }
  {
    // 0007: his tutor link's coach view is on: his screen says Pat sees his points too (his view's me.coach).
    const d = withCoach(hwDb());
    d.tutor_links[0].coach = true;
    ({ page, db } = await open({ label: 'hw-coach', path: `/day.html?t=${JORDAN}#homework`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-now-card');
    check('the coach view on for Pat\'s link: the who-sees line names everything Pat now sees too (his points and rewards, focus sessions, own calendar, daily tasks)',
      (await hwText(page, '.hw-who')) === 'Pat and the grown-ups in your family see your plan and your notes. The grown-ups and Pat see your points and rewards, '
        + 'your focus sessions, your own calendar and your daily tasks.', await hwText(page, '.hw-who'));
    await page.context().close();
  }
  {
    // ... and in Spanish.
    const d = withCoach(hwDb({ lang: 'es' }));
    d.tutor_links[0].coach = true;
    ({ page, db } = await open({ label: 'hw-coach-es', path: `/day.html?t=${JORDAN}#homework`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-now-card');
    check('... in Spanish too', (await hwText(page, '.hw-who')) === 'Pat y los adultos de tu familia ven tu plan y tus notas. Los adultos y Pat ven tus puntos y premios, '
      + 'tus sesiones de concentración, tu propio calendario y tus tareas diarias.', await hwText(page, '.hw-who'));
    await page.context().close();
  }
  {
    // homework_by_token answers null (homework turned off a moment ago) while the day link works: the day, and a word.
    const d = hwDb();
    ({ page, db } = await open({ label: 'hw-null', path: `/day.html?t=${JORDAN}`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    db.homework_kids[0].active = false;
    await page.click('.hw-card a.hw-open');
    check('homework off while open: back to the day, with no card, and "Homework isn\'t on your My day right now."',
      await until(async () => !!(await page.$('.day-sec')) && !(await page.$('.hw-card'))) && (await hwToast(page)) === "Homework isn't on your My day right now.", await hwText(page, 'main'));
    // A link that no longer works at all.
    delete db.my[JORDAN];
    db.people.find((p) => p.id === P.jordan).day_token = null;
    await page.goto(`${BASE}/day.html?t=${JORDAN}#homework`);
    await page.reload();
    await page.waitForSelector('.day-problem');
    check('a link that no longer works: the usual words', /This link isn't working/.test(await hwText(page, '.day-problem')));
    await page.context().close();
  }
  {
    // A hostile title and note are drawn as text.
    const d = hwDb();
    d.homework_steps.find((s) => s.id === H.m1).title = '<img src=x onerror="window.__xss=1">';
    d.homework_steps.find((s) => s.id === H.m1).answer = '<b>bold</b>';
    ({ page, db } = await open({ label: 'hw-xss', path: `/day.html?t=${JORDAN}#homework`, db: d, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-now-card');
    check('a hostile title and answer are drawn as text', (await hwText(page, '.hw-now-title')) === '<img src=x onerror="window.__xss=1">'
      && !(await page.$('.hw-now-card img, .hw-note b')) && !(await page.evaluate(() => window.__xss)));
    await page.context().close();
  }

  // =====================================================================
  // 22. New from school (schema 6, 0006; docs/v1.3-homework.md §11.4, §12.8): the school's items he hasn't planned or hidden
  // =====================================================================
  {
    // His checked Assignments link (the made-up school's host): Read chapter 5 due Wed (Quick), Lab report due Fri Nov 20 (too far
    // for Quick), and two assignments made from school: Map quiz, no longer on the school site, and a poem whose date the school moved.
    const schoolDb = (o, extra) => {
      const d = withSchool(hwDb(o));
      const feed = schoolFeedRow({ id: hid(99), kid_id: P.jordan, kind: 'assignments', checked: true, last_ok_at: '2026-11-02T20:23:00.000000+00:00', last_count: 4 });
      d.school_feeds.push(feed);
      const I = (x) => d.school_items.push(schoolItemRow(Object.assign({ feed_id: feed.id }, x)));
      I({ id: hid(100), title: 'Read chapter 5', subject: 'History', due_date: '2026-11-04' });
      I({ id: hid(101), title: 'Lab report', subject: 'Biology', due_date: '2026-11-20', details: 'Write up the bean plant lab: hypothesis, method, results.' });
      d.assignments.push(
        assignmentRow({ id: hid(102), kid_id: P.jordan, added_by: 'school', title: 'Map quiz', subject: 'Geography', due_date: '2026-11-09', created_by: 'Jordan (My day)',
          created_at: '2026-10-30T20:00:00.000000+00:00' }),
        assignmentRow({ id: hid(103), kid_id: P.jordan, added_by: 'school', title: 'Poem', subject: 'English', due_date: '2026-11-12', created_by: 'alex@example.com',
          created_at: '2026-10-30T20:00:00.000000+00:00' }),
      );
      I({ id: hid(104), title: 'Map quiz', subject: 'Geography', due_date: '2026-11-09', assignment_id: hid(102), made_at: '2026-10-30T20:00:00.000000+00:00',
        applied: { title: 'Map quiz', subject: 'Geography', due_date: '2026-11-09', details: null }, gone_at: '2026-11-01T20:00:00.000000+00:00' });
      I({ id: hid(105), title: 'Poem', subject: 'English', due_date: '2026-11-16', assignment_id: hid(103), made_at: '2026-10-30T20:00:00.000000+00:00',
        applied: { title: 'Poem', subject: 'English', due_date: '2026-11-12', details: null } });
      (extra || []).forEach((x, i) => I(Object.assign({ id: hid(110 + i), subject: 'Art', due_date: '2026-11-25' }, x)));
      return d;
    };
    const SCH = (id) => `.hw-school .hw-school-item[data-item="${id}"]`;
    // The refusal below comes back as 403, which Chrome logs.
    ({ page, db } = await open({ label: 'hw-school-card', path: `/day.html?t=${JORDAN}`, db: schoolDb(), device: HW_DEVICE, init: HW_STUBS, ctx: phone(), allowConsole: /status of 403/ }));
    check('the card: "New from school: 2 ›" (get_person_day\'s from_school count)', (await hwText(page, '.hw-card .hw-card-school')) === 'New from school: 2 ›', await hwText(page, '.hw-card'));
    await page.click('.hw-card .hw-card-school');
    await page.waitForSelector('.hw-school', { timeout: 3000 }).catch(() => {});
    check('... a tap opens #homework at New from school', (await page.evaluate(() => location.hash)) === '#homework'
      && await until(() => page.evaluate(() => { const r = document.querySelector('.hw-school').getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; })));
    check('New from school: after Due soon, "New from school (2)"', (await hwText(page, '#hw-school-h')) === 'New from school (2)'
      && await page.evaluate(() => { const d = document.querySelector('.hw-due'); const s = document.querySelector('.hw-school'); return !!(d && s && (d.compareDocumentPosition(s) & 4)); }),
      await hwText(page, '#hw-school-h'));
    check('... each item its class, title and due day, soonest first', same(await hwTexts(page, '.hw-school .hw-school-line'), ['History · Read chapter 5 · due Wed', 'Biology · Lab report · due Fri Nov 20']),
      JSON.stringify(await hwTexts(page, '.hw-school .hw-school-line')));
    check('... one tap each: Quick (his first length) only for the one due within 3 days; Plan with Pat; Hide', same(await hwTexts(page, `${SCH(hid(100))} button`), ['Quick · 20 min', 'Plan with Pat', 'Hide'])
      && same(await hwTexts(page, `${SCH(hid(101))} button`), ['Plan with Pat', 'Hide']), JSON.stringify([await hwTexts(page, `${SCH(hid(100))} button`), await hwTexts(page, `${SCH(hid(101))} button`)]));
    check('... the school\'s description never on his screen', !(await page.content()).includes('bean plant'));
    const due = await hwTexts(page, '.hw-due .hw-asg-line');
    check('Due soon: an assignment from school the school took off its site says so, and one whose date the school moved says where to',
      due.some((x) => /^Geography · Map quiz · due .* · No longer on the school site · /.test(x)) && due.some((x) => /^English · Poem · due .* · The school moved it to Mon Nov 16 · /.test(x)), JSON.stringify(due));
    check('phone: no sideways scroll; the buttons at least 44px tall', await noSideScroll(page)
      && (await page.$$eval('.hw-school button', (bs) => bs.every((b) => b.getBoundingClientRect().height >= 44))));
    await page.screenshot({ path: SHOTS + 'day-hw-school.png', fullPage: true });
    await page.locator('.hw-school').screenshot({ path: SHOTS + 'day-hw-school-list.png' });

    // ---- A refusal: said, the item stays, its buttons work again
    db.hwError = [403, '42501', "That isn't on your list from school."];
    await page.click(`${SCH(hid(101))} [data-act="hw-school-pat"]`);
    check('a refusal: "That isn\'t on your list from school any more.", the item stays and can be tapped again', (await hwToast(page)) === "That isn't on your list from school any more."
      && await until(async () => !!(await page.$(`${SCH(hid(101))} [data-act="hw-school-pat"]:not([disabled])`))), await text(page, '.toasts'));
    await hwClear(page);

    // ---- Quick: one tap at his length (a double tap is one call)
    db.slow = { school_item_by_token: 500 };
    await page.click(`${SCH(hid(100))} [data-act="hw-school-quick"]`);
    await page.click(`${SCH(hid(100))} [data-act="hw-school-quick"]`, { force: true }).catch(() => {});
    await until(async () => !(await page.$(SCH(hid(100)))));
    db.slow = {};
    const qk = calls(db, 'school_item_by_token');
    const made = db.assignments.find((a) => a.title === 'Read chapter 5');
    const placed = made && db.homework_steps.find((s) => s.assignment_id === made.id);
    check('Quick: one school_item_by_token quick with his length (a second tap while it goes sends nothing)', qk.length === 2
      && same(qk[1].body, { p_token: JORDAN, p_item: hid(100), p_action: 'quick', p_minutes: 20 }), JSON.stringify(qk.map((c) => c.body)));
    check('... an assignment from school with one plain step of 20 minutes, placed and given; it leaves New from school (1 left)',
      !!made && made.added_by === 'school' && !!placed && placed.minutes === 20 && !!made.given_at && (await hwText(page, '#hw-school-h')) === 'New from school (1)', JSON.stringify(placed));
    const dayWord = placed && placed.day === '2026-11-03' ? 'tomorrow' : placed && placed.day === HWT ? 'today' : null;
    check('... "Planned for tomorrow: Read chapter 5" (the day the database placed it)', !!dayWord && (await hwToast(page)) === `Planned for ${dayWord}: Read chapter 5`, `${placed && placed.day} ${await text(page, '.toasts')}`);
    await hwClear(page);

    // ---- Plan with Pat: an assignment from school with no plan, under Due soon
    await page.click(`${SCH(hid(101))} [data-act="hw-school-pat"]`);
    await until(async () => !(await page.$('.hw-school')));
    const lab = db.assignments.find((a) => a.title === 'Lab report');
    check('Plan with Pat: school_item_by_token with_tutor; an assignment from school with no plan and its description as the teacher\'s text; the section goes with its last item',
      same(calls(db, 'school_item_by_token').slice(-1)[0].body, { p_token: JORDAN, p_item: hid(101), p_action: 'with_tutor' }) && !!lab && lab.added_by === 'school'
      && /bean plant/.test(lab.details || '') && !db.homework_steps.some((s) => s.assignment_id === lab.id) && !(await page.$('.hw-school')), JSON.stringify(calls(db, 'school_item_by_token').slice(-1)[0].body));
    check('... "On your homework, to plan with Pat: Lab report", and under Due soon "No plan yet · Plan this one with Pat."', (await hwToast(page)) === 'On your homework, to plan with Pat: Lab report'
      && (await hwTexts(page, '.hw-due .hw-asg-line')).includes('Biology · Lab report · due Fri Nov 20 · No plan yet · Plan this one with Pat.'), JSON.stringify(await hwTexts(page, '.hw-due .hw-asg-line')));
    await page.context().close();

    // ---- A short list: five, then "3 more" folded; Hide
    const many = schoolDb(null, ['Collage', 'Sketchbook page', 'Color wheel', 'Clay pot', 'Gallery notes', 'Self-portrait'].map((title) => ({ title })));
    ({ page, db } = await open({ label: 'hw-school-many', path: `/day.html?t=${JORDAN}#homework`, db: many, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-school');
    check('eight from school: "New from school (8)", five shown, then "3 more" folded with the rest', (await hwText(page, '#hw-school-h')) === 'New from school (8)'
      && (await page.$$('.hw-school .hw-list > .hw-school-item')).length === 5 && (await hwText(page, '.hw-school details.hw-school-more summary')) === '3 more'
      && (await page.$$('.hw-school details.hw-school-more .hw-school-item')).length === 3 && !(await page.$eval('.hw-school details.hw-school-more', (x) => x.open)),
      await hwText(page, '.hw-school'));
    await page.click(`${SCH(hid(110))} [data-act="hw-school-hide"]`);
    await until(async () => !(await page.$(SCH(hid(110)))));
    check('Hide: school_item_by_token hide; "Hidden: Collage. A parent can bring it back."; 7 left; no assignment made', same(calls(db, 'school_item_by_token').slice(-1)[0].body,
      { p_token: JORDAN, p_item: hid(110), p_action: 'hide' }) && (await hwToast(page)) === 'Hidden: Collage. A parent can bring it back.'
      && (await hwText(page, '#hw-school-h')) === 'New from school (7)' && db.school_items.find((i) => i.id === hid(110)).hidden && !db.assignments.some((a) => a.title === 'Collage'),
      await text(page, '.toasts'));
    await hwClear(page);
    // Homework turned off a moment ago: Quick is answered null, and the day shows with the word, not #homework.
    db.homework_kids[0].active = false;
    await page.click(`${SCH(hid(100))} [data-act="hw-school-quick"]`);
    check('homework off while New from school is open: Quick goes back to the day, with "Homework isn\'t on your My day right now."',
      await until(async () => !!(await page.$('.day-sec')) && !(await page.$('.hw-school')) && !(await page.$('.hw-head')))
      && (await hwToast(page)) === "Homework isn't on your My day right now." && !db.assignments.some((a) => a.title === 'Read chapter 5'),
      await hwText(page, 'main'));
    await page.context().close();

    // ---- An Assignments link no parent has checked yet: nothing from it on his screen
    const unchecked = schoolDb();
    unchecked.school_feeds[0].checked = false;
    ({ page, db } = await open({ label: 'hw-school-unchecked', path: `/day.html?t=${JORDAN}#homework`, db: unchecked, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-tonight');
    check('an unchecked Assignments link: no New from school, no card line', !(await page.$('.hw-school')) && !(await page.$('.hw-card-school')));
    await page.context().close();

    // ---- Spanish, and a hostile title
    const es = schoolDb({ lang: 'es' }, [{ title: '<img src=x onerror="window.__xss2=1">' }]);
    ({ page, db } = await open({ label: 'hw-school-es', path: `/day.html?t=${JORDAN}`, db: es, device: HW_DEVICE, init: HW_STUBS }));
    check('Spanish card: "Nuevo de la escuela: 3 ›"', (await hwText(page, '.hw-card .hw-card-school')) === 'Nuevo de la escuela: 3 ›', await hwText(page, '.hw-card'));
    await page.click('.hw-card .hw-card-school');
    await page.waitForSelector('.hw-school');
    check('Spanish: "Nuevo de la escuela (3)", "Rápido · 20 min", "Planear con Pat", "Ocultar"', (await hwText(page, '#hw-school-h')) === 'Nuevo de la escuela (3)'
      && same(await hwTexts(page, `${SCH(hid(100))} button`), ['Rápido · 20 min', 'Planear con Pat', 'Ocultar']), await hwText(page, '.hw-school'));
    const dueEs = await hwTexts(page, '.hw-due .hw-asg-line');
    check('Spanish: "Ya no está en el sitio de la escuela", "La escuela la pasó al lun 16 nov"-style', dueEs.some((x) => /Ya no está en el sitio de la escuela/.test(x))
      && dueEs.some((x) => /La escuela la pasó al? /.test(x) && !/pasó a el /.test(x)), JSON.stringify(dueEs.slice(3)));
    check('a hostile title from school is drawn as text', (await hwTexts(page, '.hw-school .hw-school-line')).some((x) => x.includes('<img src=x onerror="window.__xss2=1">'))
      && !(await page.$('.hw-school img')) && !(await page.evaluate(() => window.__xss2)));
    await page.click(`${SCH(hid(101))} [data-act="hw-school-hide"]`);
    check('Spanish: "Oculta: Lab report. Tus padres pueden recuperarla."', (await hwToast(page)) === 'Oculta: Lab report. Tus padres pueden recuperarla.', await text(page, '.toasts'));
    await hwClear(page);
    await page.click(`${SCH(hid(110))} [data-act="hw-school-pat"]`);
    check('Spanish: "En tu tarea, para planear con Pat: …"', /^En tu tarea, para planear con Pat: /.test(await hwToast(page)), await text(page, '.toasts'));
    await hwClear(page);
    await page.click(`${SCH(hid(100))} [data-act="hw-school-quick"]`);
    check('Spanish: "Planeado para mañana: Read chapter 5"', (await hwToast(page)) === 'Planeado para mañana: Read chapter 5', await text(page, '.toasts'));
    await page.context().close();
  }

  // =====================================================================
  // 23. His path (no migration; docs/v1.3-homework.md §21): on #homework, under Tonight, a path for each plan given to
  // him that is due 4 or more days out or has a milestone (at most 3, then "+N more"); on #plan/<id>, the path at the top
  // =====================================================================
  // tlKidDb() is hwDb() and three more plans given to him: the two-week essay (due Fri Nov 20, Outline on Thu, Full draft
  // on Mon Nov 16), the reading log (due Fri, 4 days out, no milestone) and one with a hostile title and milestone. Already
  // there: the science project (due Fri Nov 13; its first milestone done and checked before today, Outline with 3 main
  // points on Wed), the vocabulary project (due Mon Nov 9; Flashcards made, planned for Fri Oct 30, not done) and
  // Worksheet 4.2 (due tomorrow, no milestone: no path). His view carries no milestone's points, so no line names any.
  {
    const KT = { essay: hid(200), read: hid(210), bad: hid(220) };
    const BADT = '<img src=x onerror="window.__tlx=1">';
    const BADM = '<img src=y onerror="window.__tly=1">';
    const tlKidDb = (o) => {
      const d = hwDb(o);
      const at = (iso) => `${iso}.000000+00:00`;
      const A = (x) => d.assignments.push(assignmentRow(Object.assign({ kid_id: P.jordan, given_at: at('2026-11-01T15:00:00'), given_by: 'alex@example.com', plan_rev: 1,
        created_at: at('2026-11-01T14:00:00') }, x)));
      const S = (aid, list) => list.forEach(([kind, title, minutes, day], i) => d.homework_steps.push(stepRow({ assignment_id: aid, pos: i + 1, kind, title, minutes, day })));
      A({ id: KT.essay, title: 'Essay: a river\'s journey', subject: 'English', due_date: '2026-11-20' });
      S(KT.essay, [['start', 'Copy the requirements into your notes', 10, '2026-11-03'], ['milestone', 'Outline', 20, '2026-11-05'], ['step', 'Draft the first half', 20, '2026-11-09'],
        ['step', 'Draft the second half', 20, '2026-11-10'], ['milestone', 'Full draft', 20, '2026-11-16'], ['check', 'Check it against the instructions', 15, '2026-11-18'],
        ['turn_in', 'Turn it in', 5, '2026-11-20']]);
      A({ id: KT.read, title: 'Reading log', subject: 'English', due_date: '2026-11-06' });
      S(KT.read, [['step', 'Read chapter 3', 20, '2026-11-03'], ['step', 'Read chapter 4', 20, '2026-11-04'], ['turn_in', 'Turn it in', 5, '2026-11-06']]);
      A({ id: KT.bad, title: BADT, subject: '<b>Art</b>', due_date: '2026-11-12' });
      S(KT.bad, [['milestone', BADM, 20, '2026-11-10'], ['turn_in', 'Turn it in', 5, '2026-11-12']]);
      return d;
    };
    // What #homework or #plan/<id> drew: each path with its link, its line, its day names, which days have a flag (and done).
    const readPaths = (pg, sel) => pg.$$eval(sel, (ps) => ps.map((p) => {
      const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
      const a = p.querySelector('a.hw-path-title');
      const days = Array.from(p.querySelectorAll('.plan-path-day'));
      const idx = (f) => days.map((x, i) => (f(x) ? i : -1)).filter((i) => i >= 0);
      return { id: p.dataset.asg || null, href: a ? a.getAttribute('href') : null, title: txt(a), line: txt(p.querySelector('.plan-path-line')),
        names: days.map((x) => txt(x.querySelector('.plan-path-name'))), flags: idx((x) => !!x.querySelector('.plan-path-flag')),
        done: idx((x) => !!x.querySelector('.plan-path-flag.is-done')), fold: txt(p.querySelector('.plan-path-fold')), won: p.querySelectorAll('.plan-path-won .plan-path-flag').length,
        pts: !!p.querySelector('.plan-path-pts'), shown: !p.closest('details:not([open])') && !!(p.offsetWidth || p.offsetHeight) };
    }));
    const PATHS = '.hw-paths .hw-path';
    const TL_SHOTS = `${(process.env.TIMELINE_SHOTS || SHOTS).replace(/\/+$/, '')}/`;
    fs.mkdirSync(TL_SHOTS, { recursive: true });
    ({ page, db } = await open({ label: 'hw-path', path: `/day.html?t=${JORDAN}#homework`, db: tlKidDb(), device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-tonight');
    check('#homework: "Your path" under Tonight (Tonight stays first), before Due soon', (await hwText(page, '#hw-paths-h')) === 'Your path'
      && await page.evaluate(() => { const t = document.querySelector('.hw-tonight'); const p = document.querySelector('.hw-paths'); const d = document.querySelector('.hw-due');
        return !!(t && p && d && (t.compareDocumentPosition(p) & 4) && (p.compareDocumentPosition(d) & 4)); }), await hwText(page, '.hw-paths'));
    let paths = await readPaths(page, PATHS);
    const pathOf = (id) => paths.find((p) => p.id === id) || {};
    check('a path for each plan given to him due 4 or more days out or with a milestone, by due date: the first 3 shown, the rest under "+2 more" (Worksheet 4.2, due tomorrow with no milestone, has none)',
      same(paths.map((p) => [p.id, p.shown]), [[KT.read, true], [H.span, true], [KT.bad, true], [H.sci, false], [KT.essay, false]])
      && (await hwText(page, '.hw-paths-more > summary')) === '+2 more' && !(await page.$eval('.hw-paths-more', (x) => x.open)), JSON.stringify(paths.map((p) => [p.title, p.shown])));
    check('each path\'s name is a link to its plan (#plan/<id>), at least 44px tall', same(paths.map((p) => p.href), [KT.read, H.span, KT.bad, H.sci, KT.essay].map((id) => `#plan/${id}`))
      && pathOf(KT.read).title === 'Reading log ›' && pathOf(H.sci).title === 'Science project: river poster ›'
      && (await page.$$eval('.hw-paths .hw-path:not(.hw-paths-more .hw-path) a.hw-path-title', (as) => as.every((a) => a.getBoundingClientRect().height >= 44))), JSON.stringify(paths.map((p) => [p.href, p.title])));
    const rd = pathOf(KT.read);
    check('the reading log (no milestone, due Fri): "Due Fri (4 days)", a dot a day from "Today" to Friday, no flag',
      rd.line === 'Due Fri (4 days)' && same(rd.names, ['Today', 'T', 'W', 'T', 'F']) && !rd.flags.length && rd.fold === null, JSON.stringify(rd));
    const sp = pathOf(H.span);
    check('the vocabulary project: its milestone (Fri Oct 30, not done) is the next flag, on today\'s dot: "Next flag: Flashcards made · from Fri Oct 30" (its date: the dots show this Friday)',
      sp.line === 'Next flag: Flashcards made · from Fri Oct 30' && sp.names.length === 8 && same(sp.flags, [0]) && !sp.done.length, JSON.stringify(sp));
    const bd = pathOf(KT.bad);
    check('a hostile title and milestone: as text ("Next flag: <img …> · in 8 days"), no element made from them',
      bd.title === `${BADT} ›` && bd.line === `Next flag: ${BADM} · in 8 days` && same(bd.flags, [8]) && !(await page.$('.hw-paths img, .hw-paths b'))
      && !(await page.evaluate(() => window.__tlx || window.__tly)), JSON.stringify(bd));
    check('no line names points (his view doesn\'t carry what a milestone pays: left out, not guessed)', paths.every((p) => p.line && !p.pts && !/\+\d|points? now/i.test(p.line)),
      JSON.stringify(paths.map((p) => p.line)));
    // "+2 more" opens the rest, and stays open through a read that changes them.
    await page.click('.hw-paths-more > summary');
    paths = await readPaths(page, PATHS);
    const sc = pathOf(H.sci);
    const es = pathOf(KT.essay);
    check('"+2 more" opens the science project ("Next flag: Outline with 3 main points · Wed (2 days)", its first flag won before today) and the essay',
      sc.shown && es.shown && sc.line === 'Next flag: Outline with 3 main points · Wed (2 days)' && sc.won === 1 && sc.names.length === 12 && same(sc.flags, [2]), JSON.stringify(sc));
    check('the two-week essay: 14 dots from Today, then "… due Fri Nov 20"; "Next flag: Outline · Thu (3 days)" (Full draft, past the 14 dots, not drawn)',
      es.line === 'Next flag: Outline · Thu (3 days)' && es.names.length === 14 && es.names[0] === 'Today' && same(es.flags, [3]) && es.fold === '… due Fri Nov 20', JSON.stringify(es));
    // Outline done on the server (his tick from another phone), then a read.
    const outline = db.homework_steps.find((s) => s.assignment_id === KT.essay && s.title === 'Outline');
    outline.done_at = '2026-11-02T21:00:00.000000+00:00';
    outline.done_by = 'Jordan (My day)';
    await page.waitForTimeout(1100);
    const reads = calls(db, 'homework_by_token').length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(() => calls(db, 'homework_by_token').length > reads);
    await until(async () => (await readPaths(page, PATHS)).some((p) => p.id === KT.essay && /Full draft/.test(p.line)));
    paths = await readPaths(page, PATHS);
    check('a read draws the paths again: the essay\'s next flag is Full draft ("in 14 days"), Outline\'s flag filled; "+2 more" still open',
      pathOf(KT.essay).line === 'Next flag: Full draft · in 14 days' && same(pathOf(KT.essay).done, [3]) && await page.$eval('.hw-paths-more', (x) => x.open), JSON.stringify(pathOf(KT.essay)));
    // The essay's link opens its plan, with the path at the top.
    await page.click(`.hw-path[data-asg="${KT.essay}"] a.hw-path-title`);
    await until(async () => (await page.evaluate(() => location.hash)) === `#plan/${KT.essay}` && !!(await page.$('.hw-plan .plan-editor')), 4000);
    let top = await readPaths(page, '.hw-plan-path');
    check('#plan/<id>: the path at the top, above the plan', top.length === 1 && top[0].line === 'Next flag: Full draft · in 14 days' && top[0].names.length === 14
      && await page.evaluate(() => { const p = document.querySelector('.hw-plan-path .plan-path'); const e = document.querySelector('.hw-plan .plan-editor'); const h = document.querySelector('.hw-head');
        return !!(p && e && h && (h.compareDocumentPosition(p) & 4) && (p.compareDocumentPosition(e) & 4)); }), JSON.stringify(top));
    // Every flag done: a short cheer and the due date.
    const full = db.homework_steps.find((s) => s.assignment_id === KT.essay && s.title === 'Full draft');
    full.done_at = '2026-11-02T21:05:00.000000+00:00';
    full.done_by = 'Jordan (My day)';
    await page.waitForTimeout(1100);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => /Every flag/.test((await readPaths(page, '.hw-plan-path'))[0].line || ''), 4000);
    top = await readPaths(page, '.hw-plan-path');
    check('every flag done: "Every flag done! Due Fri Nov 20 (18 days)" at the top of his plan, drawn again from the read', top.length === 1
      && top[0].line === 'Every flag done! Due Fri Nov 20 (18 days)' && same(top[0].done, [3]), JSON.stringify(top));
    await page.context().close();

    // #plan/<id> for a plan not given yet (being planned): no path.
    ({ page, db } = await open({ label: 'hw-path-noplan', path: `/day.html?t=${JORDAN}#plan/${H.frac}`, db: tlKidDb(), device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-plan');
    check('#plan/<id> of a plan not given to him yet: "Being planned", no path', !(await page.$('.plan-path')) && /Being planned/.test(await hwText(page, '.hw-plan')), await hwText(page, 'main'));
    await page.context().close();

    // Nothing that needs a path (only the worksheet due tomorrow): no section at all.
    const few = hwDb();
    few.assignments = few.assignments.filter((a) => a.id === H.math);
    few.homework_steps = few.homework_steps.filter((s) => s.assignment_id === H.math);
    ({ page, db } = await open({ label: 'hw-path-none', path: `/day.html?t=${JORDAN}#homework`, db: few, device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-tonight');
    check('no plan due 4 or more days out and none with a milestone: no "Your path" at all', !(await page.$('.hw-paths')) && !(await page.$('.plan-path')));
    await page.context().close();

    // Spanish.
    ({ page, db } = await open({ label: 'hw-path-es', path: `/day.html?t=${JORDAN}#homework`, db: tlKidDb({ lang: 'es' }), device: HW_DEVICE, init: HW_STUBS }));
    await page.waitForSelector('.hw-paths');
    await page.click('.hw-paths-more > summary');
    paths = await readPaths(page, PATHS);
    check('Spanish: "Tu camino", "+2 más", "Se entrega el vie (4 días)", "Siguiente bandera: Outline · el jue (3 días)", "Hoy", "… para el vie 20 nov"',
      (await hwText(page, '#hw-paths-h')) === 'Tu camino' && (await hwText(page, '.hw-paths-more > summary')) === '+2 más'
      && pathOf(KT.read).line === 'Se entrega el vie (4 días)' && same(pathOf(KT.read).names, ['Hoy', 'M', 'X', 'J', 'V'])
      && pathOf(KT.essay).line === 'Siguiente bandera: Outline · el jue (3 días)' && pathOf(KT.essay).fold === '… para el vie 20 nov'
      && pathOf(H.span).line === 'Siguiente bandera: Flashcards made · del vie 30 oct', JSON.stringify(paths.map((p) => [p.line, p.fold])));
    await page.context().close();

    // Four flags won before today (the most a plan has) on a plan due Wed Dec 2: at 390px "Today" never runs into the next
    // day's letter, on #homework and at the top of #plan/<id>.
    {
      const won = hwDb();
      won.assignments = won.assignments.filter((a) => a.id === H.math);
      won.homework_steps = won.homework_steps.filter((x) => x.assignment_id === H.math);
      const W4 = hid(240);
      const at = (iso) => `${iso}.000000+00:00`;
      won.assignments.push(assignmentRow({ id: W4, kid_id: P.jordan, title: 'Ecosystem project', subject: 'Science', due_date: '2026-12-02', given_at: at('2026-10-20T15:00:00'),
        given_by: 'alex@example.com', plan_rev: 1, created_at: at('2026-10-20T14:00:00') }));
      [['milestone', 'Pick the ecosystem', '2026-10-26'], ['milestone', 'Find 3 sources', '2026-10-28'], ['milestone', 'Notes done', '2026-10-29'], ['milestone', 'Outline', '2026-10-30'],
        ['step', 'Draft it', '2026-11-04'], ['step', 'Make the diagram', '2026-11-16'], ['turn_in', 'Turn it in', '2026-12-02']].forEach(([kind, title, day], i) => won.homework_steps.push(stepRow({
        assignment_id: W4, pos: i + 1, kind, title, minutes: 20, day, done_at: day < HWT ? at(`${day}T21:00:00`) : null, done_by: day < HWT ? 'Jordan (My day)' : null })));
      ({ page, db } = await open({ label: 'hw-path-won4', path: `/day.html?t=${JORDAN}#homework`, db: won, device: HW_DEVICE, init: HW_STUBS, ctx: phone() }));
      await page.waitForSelector('.hw-paths .plan-path');
      const apart = (sel) => page.$eval(sel, (p) => {
        const names = Array.from(p.querySelectorAll('.plan-path-name')).map((n) => n.getBoundingClientRect());
        const today = p.querySelector('.plan-path-day.is-today');
        return { won: p.querySelectorAll('.plan-path-won .plan-path-flag').length, overlaps: names.slice(1).map((b, i) => Number((names[i].right - b.left).toFixed(1))).filter((x) => x > 0.5),
          today: [Number(today.getBoundingClientRect().width.toFixed(1)), Number(today.querySelector('.plan-path-name').getBoundingClientRect().width.toFixed(1))],
          line: p.querySelector('.plan-path-line').textContent.replace(/\s+/g, ' ').trim() };
      });
      const home = await apart(`.hw-path[data-asg="${W4}"] .plan-path`);
      check('his path at 390px with four flags won before today: "Today" and every day\'s letter apart, the today dot as wide as its name (#homework)',
        home.won === 4 && !home.overlaps.length && home.today[0] >= home.today[1] && home.line === 'Every flag done! Due Wed Dec 2 (30 days)' && await noSideScroll(page), JSON.stringify(home));
      await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); });
      await page.locator('.hw-paths').screenshot({ path: `${TL_SHOTS}myday-paths-won4-390-light.png` });
      await page.evaluate((id) => { location.hash = `#plan/${id}`; }, W4);
      await page.waitForSelector('.hw-plan-path .plan-path');
      const top = await apart('.hw-plan-path .plan-path');
      check('... and at the top of #plan/<id>', top.won === 4 && !top.overlaps.length && top.today[0] >= top.today[1] && await noSideScroll(page), JSON.stringify(top));
      await page.context().close();
    }

    // Phones and desktops, light and dark: no sideways page scroll.
    for (const [w, ctxOpts] of [[390, phone()], [1280, { viewport: { width: 1280, height: 900 } }]]) {
      for (const scheme of ['light', 'dark']) {
        ({ page, db } = await open({ label: `hw-path-${w}-${scheme}`, path: `/day.html?t=${JORDAN}#homework`, db: tlKidDb(), device: HW_DEVICE, init: HW_STUBS,
          ctx: Object.assign({ colorScheme: scheme }, ctxOpts) }));
        await page.waitForSelector('.hw-paths');
        await page.click('.hw-paths-more > summary');
        check(`his path ${w}px (${scheme}): #homework with no sideways page scroll, every dot inside its card`, await noSideScroll(page)
          && await page.$$eval('.hw-paths .hw-path', (ps) => ps.every((p) => { const r = p.getBoundingClientRect(); return Array.from(p.querySelectorAll('.plan-path-day, .plan-path-fold'))
            .every((x) => { const b = x.getBoundingClientRect(); return b.left >= r.left - 0.5 && b.right <= r.right + 0.5; }); })));
        const level = await page.$eval(`.hw-path[data-asg="${H.sci}"]`, (p) => { const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
          return [mid(p.querySelector('.plan-path-won .plan-path-flag')), mid(p.querySelector('.plan-path-day.is-today .plan-path-dot'))]; });
        check(`his path ${w}px (${scheme}): the flag he won before today sits level with the dots`, Math.abs(level[0] - level[1]) <= 3, JSON.stringify(level));
        await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); });
        await page.locator('.hw-paths').screenshot({ path: `${TL_SHOTS}myday-paths-${w}-${scheme}.png` });
        await page.screenshot({ path: `${TL_SHOTS}myday-homework-${w}-${scheme}.png`, fullPage: true });
        await page.evaluate((id) => { location.hash = `#plan/${id}`; }, KT.essay);
        await page.waitForSelector('.hw-plan .plan-editor');
        check(`his path ${w}px (${scheme}): #plan/<id> with the path at the top and no sideways page scroll`, !!(await page.$('.hw-plan-path .plan-path')) && await noSideScroll(page));
        await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); });
        await page.screenshot({ path: `${TL_SHOTS}myday-plan-${w}-${scheme}.png` });
        await page.context().close();
      }
    }
  }

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
  await server.close();
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
})().catch((err) => {
  // A step that throws (e.g. a selector that never appears) stops the run: report what ran, then fail.
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
