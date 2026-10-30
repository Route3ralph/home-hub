// End-to-end walkthroughs of the v2 Home Hub: every real page module, one household database, the way
// a family would use it. A parent adds Taylor (a helper) on Family and copies her My day link; adds
// Piano every Tuesday at 4pm with Taylor in charge and Jordan along, sees it on Today for both chips and
// on the Calendar week, and sends Taylor her day; adds a monthly heartworm pill for Taylor and ticks it
// off on Today (with Undo); adds the furnace filter from the starter list (it lands on the house owner);
// adds a utility account with an account number (masked for the admin, never even asked for by a
// member); adds days off in Settings (whose morning-email status says "Not set up yet" with no hub-jobs);
// gives the kitchen project an owner, a task, and puts that task on the schedule. Then Taylor opens her
// My day link and ticks the pill (with Undo), and a v1 database still gets exactly the v1 pages.
// It runs at 390px and 1280px, light and dark, and saves screenshots of each key screen in shots/.
//
// The database functions below follow supabase/migrations/0002_home_hub_v2.sql (agenda, late_items,
// heads_up, day_text, get_person_day, complete_task / complete_by_token, undo_task / undo_by_token,
// save_person, rotate_day_token, clock, whoami, mark_signed_in) and answer with its exact shapes, from
// the same in-memory tables mock.js serves, so a write on one page shows up on the next. Inserts get the
// tables' defaults and triggers (a repeating task's anchor, a weekly event's weekday). The browser runs
// in Pacific/Honolulu while the household is in America/New_York, on the household's Tuesday Dec 1 2026.
// Run alone with: node tests/e2e/walkthrough.test.js
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { makeDb, install, signIn, expectedConsoleError, foodRpc } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };

// =====================================================================
// Dates (whole UTC days, like the site) and America/New_York instants
// =====================================================================
const dnum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
const diso = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const addDays = (iso, n) => diso(dnum(iso) + n);
const isoDow = (iso) => ((dnum(iso) + 3) % 7 + 7) % 7 + 1;
const mondayOf = (iso) => addDays(iso, 1 - isoDow(iso));
const hms = (t) => (t == null || t === '' ? null : String(t).length === 5 ? `${t}:00` : String(t));
// Daylight time until 2026-11-01, standard time until 2027-03-14 (no fixture is near 2am).
const offsetOf = (day) => (day < '2026-11-01' || day >= '2027-03-14' ? '-04:00' : '-05:00');
const instant = (day, time) => new Date(`${day}T${hms(time)}${offsetOf(day)}`).toISOString().replace('.000Z', '+00:00');
const plusHour = (inst) => new Date(new Date(inst).getTime() + 3600e3).toISOString().replace('.000Z', '+00:00');
const nowIso = () => new Date().toISOString().replace('Z', '000+00:00');
// private.add_units: months clamp to the month's last day.
function addUnits(iso, n, unit) {
  if (unit === 'day') return addDays(iso, n);
  if (unit === 'week') return addDays(iso, 7 * n);
  const months = (+iso.slice(5, 7) - 1) + n * (unit === 'year' ? 12 : 1);
  const y = +iso.slice(0, 4) + Math.floor(months / 12);
  const m = ((months % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return diso(Date.UTC(y, m, Math.min(+iso.slice(8, 10), last)) / 864e5);
}
const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
const inWeekly = (d, start, weekdays, every) => d >= start && (weekdays || []).map(Number).includes(isoDow(d))
  && ((dnum(mondayOf(d)) - dnum(mondayOf(start))) / 7) % (every || 1) === 0;
// private.series_after: the first series date strictly after `after`, counted from the anchor.
function seriesAfter(t, after) {
  if (t.repeat_mode === 'none' || !t.anchor_date || !after) return null;
  if (t.every_unit === 'week' && (t.repeat_weekdays || []).length) {
    let d = addDays(after, 1) > t.anchor_date ? addDays(after, 1) : t.anchor_date;
    for (let i = 0; i <= 7 * t.every_count + 6; i++, d = addDays(d, 1)) if (inWeekly(d, t.anchor_date, t.repeat_weekdays, t.every_count)) return d;
    return null;
  }
  if (after < t.anchor_date) return t.anchor_date;
  if (t.every_unit === 'day' || t.every_unit === 'week') {
    const step = t.every_count * (t.every_unit === 'week' ? 7 : 1);
    return addDays(t.anchor_date, (Math.floor((dnum(after) - dnum(t.anchor_date)) / step) + 1) * step);
  }
  const step = t.every_count * (t.every_unit === 'year' ? 12 : 1);
  const k = Math.floor(monthsBetween(t.anchor_date, after) / step);
  const at = addUnits(t.anchor_date, k * step, 'month');
  return at > after ? at : addUnits(t.anchor_date, (k + 1) * step, 'month');
}

// =====================================================================
// The household (fictional people only)
// =====================================================================
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-12-01';     // a Tuesday, and the 1st
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hex32 = () => crypto.randomBytes(16).toString('hex');
const P = { alex: uid(101), sam: uid(102), jordan: uid(103) };
const person = (id, name, role, sort, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color: '#64748b', language: 'en', day_token: hex32(),
  digest_enabled: false, digest_time: null, digest_day: 'today', digest_scope: 'mine', sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);

function walkDb() {
  const db = makeDb();
  // The sign-in list can carry an older, shorter name; the hub shows the family list's.
  db.members[0].name = 'Alex';
  db.people = [
    person(P.alex, 'Alex Example', 'parent', 1, { email: 'alex@example.com', email_verified_at: T, color: '#2563eb', digest_enabled: true, digest_scope: 'everyone' }),
    person(P.sam, 'Sam Example', 'adult', 2, { email: 'sam@example.com', email_verified_at: T, color: '#db2777' }),
    person(P.jordan, 'Jordan Example', 'kid', 3, { phone: '(201) 555-0103', color: '#16a34a' }),
  ];
  // Sam looks after the house, so the starter list's home tasks go to Sam.
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: P.sam, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '15:10:00', tz: 'America/New_York' };
  db.events = [];
  db.event_changes = [];
  db.tasks = [];
  db.task_log = [];
  db.contractor_secrets = [];
  db.notification_log = [];
  db.job_runs = [];
  db.contractors.forEach((c) => Object.assign(c, { kind: 'contractor', category: c.trade, address: null, contract_end: null, updated_by: null }));
  // Stale task dates (as a v1 copy of the site leaves them): the hub fills them in on its first read.
  db.projects.forEach((p) => Object.assign(p, { task_dates: null, task_dates_at: null, on_calendar: true, owner_id: null }));
  db.calls = [];       // every database function call: { name, body, email }
  db.writes = [];      // every table write: { method, table, url, body, email }
  db.logSeq = 0;
  return db;
}

// =====================================================================
// The database functions (0002_home_hub_v2.sql), over the mock's tables
// =====================================================================
class Raise extends Error { constructor(code, message, hint) { super(message); this.code = code; this.hint = hint || null; } }
const word = (key, lang) => ({
  en: { late: 'Late', all_day: 'All day', with: 'with', more: '+{n} more', nothing_planned: 'Nothing planned', private_item: 'Private item' },
  es: { late: 'Atrasado', all_day: 'Todo el día', with: 'con', more: '+{n} más', nothing_planned: 'Nada planeado', private_item: 'Asunto privado' },
}[lang === 'es' ? 'es' : 'en'][key]);
const WD3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d) => `${WD3[isoDow(d) - 1]} ${MON3[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
const shortDate = (d) => `${MON3[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
function timeLabel(t, lang) {
  if (!t) return null;
  const h = +t.slice(0, 2);
  const mm = t.slice(3, 5);
  return lang === 'es' ? `${h}:${mm}` : `${h % 12 || 12}:${mm}${h < 12 ? 'am' : 'pm'}`;
}
const contractorOf = (db, id) => db.contractors.find((c) => c.id === id) || null;

// private.task_item
function taskItem(db, t, day, status) {
  const k = contractorOf(db, t.contractor_id);
  const p = db.projects.find((x) => x.id === t.project_id);
  return {
    kind: 'task', item_id: t.id, occurrence: day, title: t.title, day, end_day: day, all_day: t.due_time == null,
    start_at: t.due_time ? instant(day, t.due_time) : null, end_at: null, local_start: hms(t.due_time), local_end: null,
    responsible_id: t.responsible_id || null, participant_ids: [], status, category: t.category, project_id: t.project_id || null, project_name: p ? p.name : null,
    contractor_id: t.contractor_id || null, contractor_name: k ? k.name : null, contractor_phone: k ? k.phone : null,
    location: null, notes: t.notes || null, private: !!t.private, repeating: t.repeat_mode !== 'none', changed: false, lead_days: t.lead_days || 0, milestone: false,
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// agenda(p_from, p_to): every event occurrence, tasks due (open, done one-offs, done/skipped repeats), project tasks.
function agenda(db, from, to) {
  if (!from || !to || to < from || dnum(to) - dnum(from) > 61) throw new Raise('22023', 'agenda() needs a range of 1 to 62 days.');
  const off = db.household[0].days_off || [];
  const rows = [];
  db.events.forEach((e) => {
    const days = [];
    if (e.repeat !== 'weekly') { if (e.start_date <= to && (e.end_date || e.start_date) >= from) days.push(e.start_date); }
    else for (let d = e.start_date > from ? e.start_date : from; d <= to && (!e.repeat_until || d <= e.repeat_until); d = addDays(d, 1)) {
      if (inWeekly(d, e.start_date, e.repeat_weekdays, e.repeat_every)) days.push(d);
    }
    days.filter((d) => !(e.skip_days_off && off.includes(d))).forEach((day) => {
      const c = db.event_changes.find((x) => x.event_id === e.id && x.on_date === day);
      const moved = !!(c && (c.start_time || c.end_time));
      const st = hms(moved ? c.start_time || e.start_time : e.start_time);
      const et = hms(moved ? c.end_time : e.end_time);
      const next = moved ? !!(et && et <= st) : !!e.ends_next_day;
      const resp = (c && c.responsible_id) || e.responsible_id || null;
      const parts = (c && c.participant_ids) || e.participant_ids || [];
      const sAt = st ? instant(day, st) : null;
      const eAt = st ? (et ? instant(next ? addDays(day, 1) : day, et) : plusHour(sAt)) : null;
      const k = contractorOf(db, e.contractor_id);
      rows.push({
        kind: 'event', item_id: e.id, occurrence: day, title: e.title, day, end_day: e.end_date || (st && next ? addDays(day, 1) : day),
        all_day: !st, start_at: sAt, end_at: eAt, local_start: st, local_end: st ? et : null,
        responsible_id: resp, participant_ids: parts.filter((x) => x !== resp), status: c && c.cancelled ? 'cancelled' : 'open',
        category: null, project_id: null, project_name: null,
        contractor_id: e.contractor_id || null, contractor_name: k ? k.name : null, contractor_phone: k ? k.phone : null,
        location: e.location || null, notes: [c && c.note, e.notes].filter(Boolean).join('\n\n') || null,
        private: !!e.private, repeating: e.repeat === 'weekly', changed: !!c, lead_days: null, milestone: false,
      });
    });
  });
  db.tasks.forEach((t) => {
    const doneOneOff = t.repeat_mode === 'none' && !!t.done_at;
    if (t.due_date && t.due_date >= from && t.due_date <= to && (doneOneOff || t.active)) rows.push(taskItem(db, t, t.due_date, doneOneOff ? 'done' : 'open'));
  });
  db.task_log.forEach((l) => {
    const t = db.tasks.find((x) => x.id === l.task_id);
    if (t && t.repeat_mode !== 'none' && ['done', 'skipped'].includes(l.status) && l.occurrence >= from && l.occurrence <= to) rows.push(taskItem(db, t, l.occurrence, l.status));
  });
  db.projects.filter((p) => p.on_calendar && Array.isArray(p.task_dates)).forEach((p) => p.task_dates.forEach((x) => {
    if (!(x.start <= to && x.end >= from)) return;
    const trade = ((p.schedule || {}).trades || {})[x.trade] || {};
    const k = contractorOf(db, trade.contractor_id);
    rows.push({
      kind: 'project', item_id: p.id, occurrence: x.start, title: x.name, day: x.start, end_day: x.end, all_day: true,
      start_at: null, end_at: null, local_start: null, local_end: null, responsible_id: p.owner_id || null, participant_ids: [],
      status: x.status === 'done' ? 'done' : 'open', category: null, project_id: p.id, project_name: p.name,
      contractor_id: k ? k.id : null, contractor_name: k ? k.name : null, contractor_phone: k ? k.phone : null,
      location: null, notes: null, private: false, repeating: false, changed: false, lead_days: null, milestone: !!x.milestone,
    });
  }));
  return rows.sort((a, b) => cmp(a.day, b.day) || (a.local_start == null) - (b.local_start == null) || cmp(a.local_start || '', b.local_start || '')
    || cmp(a.kind, b.kind) || cmp(a.title, b.title));
}
const openTask = (t) => t.active !== false && !t.done_at && !!t.due_date;
// late_items()
const lateItems = (db) => db.tasks.filter((t) => openTask(t) && t.due_date < db.clock.local_date)
  .sort((a, b) => cmp(a.due_date, b.due_date) || (a.due_time == null) - (b.due_time == null) || cmp(a.due_time || '', b.due_time || '') || cmp(a.title, b.title))
  .map((t) => taskItem(db, t, t.due_date, 'late'));
// heads_up(p_day): tasks inside their lead time; directory contracts ending within 30 days.
function headsUp(db, day) {
  const tasks = db.tasks.filter((t) => openTask(t) && t.lead_days > 0 && addDays(t.due_date, -t.lead_days) <= day && day < t.due_date).map((t) => taskItem(db, t, t.due_date, 'open'));
  const contracts = db.contractors.filter((k) => k.contract_end && k.contract_end >= day && k.contract_end <= addDays(day, 30)).map((k) => ({
    kind: 'contract', item_id: k.id, occurrence: k.contract_end, title: k.name, day: k.contract_end, end_day: k.contract_end, all_day: true,
    start_at: null, end_at: null, local_start: null, local_end: null, responsible_id: null, participant_ids: [], status: 'open', category: k.category || null,
    project_id: null, project_name: null, contractor_id: k.id, contractor_name: k.name, contractor_phone: k.phone || null,
    location: k.address || null, notes: null, private: false, repeating: false, changed: false, lead_days: null, milestone: false,
  }));
  return tasks.concat(contracts).sort((a, b) => cmp(a.day, b.day) || cmp(a.title, b.title));
}
// private.item_order / private.person_items / private.names / private.who_text / private.text_line
const itemOrder = (a) => (a.local_start ? 0 : a.kind === 'event' ? 1 : a.kind === 'project' ? 2 : 3);
const byItemOrder = (a, b) => itemOrder(a) - itemOrder(b) || (a.local_start == null) - (b.local_start == null) || cmp(a.local_start || '', b.local_start || '') || cmp(a.title, b.title);
const personItems = (db, id, day) => agenda(db, day, day)
  .filter((a) => (a.responsible_id === id || (a.participant_ids || []).includes(id)) && a.status !== 'cancelled' && (a.kind !== 'project' || a.day === day))
  .sort(byItemOrder);
function names(db, ids) {
  const list = db.people.filter((p) => (ids || []).includes(p.id) && p.active).sort((a, b) => a.sort_order - b.sort_order || cmp(a.name, b.name));
  return list.length ? list.map((p) => p.name).join(', ') : null;
}
function whoText(db, a, id, lang) {
  if (a.responsible_id === id) { const n = (a.participant_ids || []).length ? names(db, a.participant_ids) : null; return n ? `${word('with', lang)} ${n}` : null; }
  if ((a.participant_ids || []).includes(id)) return names(db, [a.responsible_id]);
  return [names(db, [a.responsible_id]), names(db, a.participant_ids)].filter(Boolean).join(` ${word('with', lang)} `) || null;
}
function textLine(db, a, id, lang) {
  const head = (a.local_start ? `${timeLabel(a.local_start, lang)} ` : '') + (!a.local_start && a.kind === 'event' ? `${word('all_day', lang)}: ` : '')
    + (a.kind === 'task' ? '☐ ' : '') + (a.kind === 'project' ? `${a.project_name}: ` : '') + (a.private ? word('private_item', lang) : a.title);
  const contact = [a.contractor_name, a.contractor_phone].filter(Boolean).join(' ') || null;
  return [head, a.private ? null : whoText(db, a, id, lang), a.private ? null : contact].filter((x) => x != null).join(' · ');
}
// day_text(p_person, p_day)
function dayText(db, id, day) {
  const me = db.people.find((p) => p.id === id);
  if (!me || !day) return null;
  const lang = me.language;
  const lines = [`${me.name} · ${dayLabel(day)}`].concat(personItems(db, id, day).filter((a) => a.status === 'open').map((a) => textLine(db, a, id, lang)));
  if (lines.length === 1) lines.push(word('nothing_planned', lang));
  const late = db.tasks.filter((t) => t.responsible_id === id && openTask(t) && t.due_date < day).sort((a, b) => cmp(a.due_date, b.due_date) || cmp(a.title, b.title));
  if (late.length) {
    lines.push(`${word('late', lang)}:`);
    late.slice(0, 3).forEach((t) => lines.push(`☐ ${t.private ? word('private_item', lang) : t.title} (${shortDate(t.due_date)})`));
    if (late.length > 3) lines.push(word('more', lang).replace('{n}', late.length - 3));
  }
  return lines.join('\n');
}
// private.person_by_token / private.my_day_item / get_person_day(p_token)
const byToken = (db, token) => (/^[0-9a-f]{32}$/.test(String(token || '')) && db.people.find((p) => p.day_token === token && p.active)) || null;
const myDayItem = (a, id, lang) => ({
  kind: a.kind, item_id: a.item_id, occurrence: a.occurrence, day: a.day, end_day: a.end_day, title: a.private ? word('private_item', lang) : a.title,
  all_day: a.all_day, start_time: a.local_start ? a.local_start.slice(0, 5) : null, end_time: a.local_end ? a.local_end.slice(0, 5) : null,
  time_label: timeLabel(a.local_start, lang), location: a.private ? null : a.location, contractor_name: a.private ? null : a.contractor_name,
  contractor_phone: a.private ? null : a.contractor_phone, status: a.status, mine: a.kind === 'task' && a.responsible_id === id,
});
function getPersonDay(db, token) {
  const me = byToken(db, token);
  if (!me) return null;
  const today = db.clock.local_date;
  return {
    person: { name: me.name, language: me.language, digest_enabled: me.digest_enabled, email_confirmed: !!me.email_verified_at },
    today,
    days: [today, addDays(today, 1)].map((day) => ({ day, items: personItems(db, me.id, day).map((a) => myDayItem(a, me.id, me.language)) })),
    late: db.tasks.filter((t) => t.responsible_id === me.id && openTask(t) && t.due_date < today).sort((a, b) => cmp(a.due_date, b.due_date) || cmp(a.title, b.title))
      .map((t) => myDayItem(taskItem(db, t, t.due_date, 'late'), me.id, me.language)),
  };
}
// private.complete_task: returns the task_log id
function completeTask(db, id, occurrence, doneOn, note, who) {
  const t = db.tasks.find((x) => x.id === id);
  if (!t) throw new Raise('P0002', 'That task no longer exists.');
  if (t.active === false) throw new Raise('22023', 'This task is paused. Turn it back on before ticking it off.');
  const today = db.clock.local_date;
  const done = doneOn || today;
  if (done > today) throw new Raise('22023', 'A task can\'t be done on a day that hasn\'t happened yet.');
  const log = { id: crypto.randomUUID(), seq: ++db.logSeq, task_id: t.id, occurrence: t.due_date, status: 'done', done_on: done, done_by: who, note: note || null,
    prev_due: null, prev_last_done: null, prev_done_at: null, created_at: nowIso(), at: Date.now() };
  if (t.repeat_mode === 'none') {
    if (t.done_at) throw new Raise('P0001', 'already done', 'Someone already ticked this off.');
    log.prev_done_at = t.done_at;
    Object.assign(t, { done_at: nowIso(), done_by: who });
  } else {
    if (occurrence != null && occurrence !== t.due_date) throw new Raise('P0001', 'already completed', 'This date was already ticked off or skipped.');
    if (done < addUnits(t.due_date, -1, 'year')) throw new Raise('22023', 'That date is more than a year before the task was due.');
    Object.assign(log, { prev_due: t.due_date, prev_last_done: t.last_done });
    const next = t.repeat_mode === 'schedule' ? seriesAfter(t, t.due_date > done ? t.due_date : done) : addUnits(done, t.every_count, t.every_unit);
    Object.assign(t, { due_date: next, last_done: done });
  }
  db.task_log.push(log);
  return log.id;
}
// private.undo_task: returns the task id
function undoTask(db, logId, personId, who) {
  const l = db.task_log.find((x) => x.id === logId);
  if (!l) throw new Raise('P0002', 'There\'s nothing to undo.');
  const t = db.tasks.find((x) => x.id === l.task_id);
  if (personId && (t.responsible_id !== personId || l.status !== 'done' || l.done_by !== who)) throw new Raise('42501', 'Only something you ticked off on this page can be undone here.');
  if (db.task_log.some((x) => x.task_id === l.task_id && x.seq > l.seq)) throw new Raise('22023', 'Only the latest change to a task can be undone.');
  if (!personId && Date.now() - l.at > 7 * 864e5) throw new Raise('22023', 'That was more than 7 days ago, so it can\'t be undone.');
  if (personId && Date.now() - l.at > 15 * 60e3) throw new Raise('22023', 'That was more than 15 minutes ago, so it can\'t be undone here.');
  if (t.repeat_mode === 'none') Object.assign(t, { done_at: l.prev_done_at, done_by: null });
  else Object.assign(t, { due_date: l.prev_due, last_done: l.prev_last_done });
  db.task_log.splice(db.task_log.indexOf(l), 1);
  return t.id;
}
// save_person(p, p_can_sign_in): the people row, with the sign-in list following
const PERSON_COLS = ['name', 'role', 'email', 'phone', 'color', 'language', 'digest_enabled', 'digest_time', 'digest_day', 'digest_scope', 'sort_order', 'active'];
const isAdmin = (db, email) => (db.members.find((m) => m.email === email) || {}).role === 'admin';
function savePerson(db, p, canSignIn, email) {
  if (!isAdmin(db, email)) throw new Raise('42501', 'Only an admin can change the family list.');
  if (!p || typeof p !== 'object' || Array.isArray(p) || canSignIn == null) throw new Raise('22023', 'save_person needs a person and whether they can sign in.');
  const given = Object.fromEntries(PERSON_COLS.filter((k) => k in p).map((k) => [k, p[k]]));
  let old = null;
  let r;
  if (p.id) {
    old = db.people.find((x) => x.id === p.id);
    if (!old) throw new Raise('P0002', 'That person is no longer on the family list.');
    r = Object.assign({}, old, given);
  } else {
    r = Object.assign({ color: '#64748b', language: 'en', digest_enabled: false, digest_time: null, digest_day: 'today', digest_scope: 'mine', sort_order: 0, active: true }, given);
  }
  r.name = String(r.name || '').trim();
  r.email = String(r.email || '').trim().toLowerCase() || null;
  r.phone = String(r.phone || '').trim() || null;
  if (r.role !== 'parent') r.digest_scope = 'mine';
  if (!r.name || !['parent', 'adult', 'kid', 'helper'].includes(r.role)) throw new Raise('23514', 'new row for relation "people" violates check constraint');
  if (canSignIn) {
    if (!['parent', 'adult'].includes(r.role)) throw new Raise('22023', 'Only parents and adults can sign in. Kids and helpers get a My day link instead.');
    if (!r.email) throw new Raise('22023', 'Add an email address before turning on sign-in.');
    if (!r.active) throw new Raise('22023', 'Someone who isn\'t active can\'t sign in.');
  }
  if (((old && old.email === email) || r.email === email) && (!canSignIn || r.email !== email || r.role !== 'parent' || !r.active)) {
    throw new Raise('42501', 'You can\'t remove or change your own sign-in. Ask another admin.');
  }
  if (r.email && db.people.some((x) => x.email === r.email && (!old || x.id !== old.id))) throw new Raise('23505', 'Someone on the family list already has that email address.');
  if (!old) {
    r = Object.assign(r, { id: crypto.randomUUID(), day_token: hex32(), email_verified_at: null, created_at: nowIso(), updated_at: nowIso() });
    db.people.push(r);
  } else {
    if (r.email !== old.email) r.email_verified_at = null;   // private.people_email_changed
    Object.assign(old, r, { updated_at: nowIso() });
    r = old;
  }
  if (old && old.email && (old.email !== r.email || !canSignIn)) db.members = db.members.filter((m) => m.email !== old.email);
  if (canSignIn) {
    const m = db.members.find((x) => x.email === r.email);
    const row = { email: r.email, name: r.name, role: r.role === 'parent' ? 'admin' : 'member' };
    if (m) Object.assign(m, row); else db.members.push(Object.assign(row, { created_at: nowIso() }));
  } else if (r.email) db.members = db.members.filter((m) => m.email !== r.email);
  return Object.assign({}, r);
}

const SQL = {
  hub_schema_version: () => 2,
  clock: (db) => Object.assign({}, db.clock),
  today_local: (db) => db.clock.local_date,
  whoami: (db, b, email) => {
    const m = db.members.find((x) => x.email === email);
    if (!m) return null;
    const p = db.people.find((x) => x.email === email);
    return Object.assign({}, m, { person: p ? { id: p.id, name: p.name, role: p.role, language: p.language, color: p.color } : null });
  },
  mark_signed_in: (db, b, email) => {
    const p = db.people.find((x) => x.email === email);
    if (p && !p.email_verified_at) p.email_verified_at = nowIso();
    return null;
  },
  agenda: (db, b) => agenda(db, b.p_from, b.p_to),
  late_items: (db) => lateItems(db),
  heads_up: (db, b) => headsUp(db, b.p_day),
  day_text: (db, b) => dayText(db, b.p_person, b.p_day),
  complete_task: (db, b, email) => completeTask(db, b.p_id, b.p_occurrence || null, b.p_done_on || null, b.p_note || null, email),
  skip_task: (db, b, email) => {
    const t = db.tasks.find((x) => x.id === b.p_id);
    if (!t) throw new Raise('P0002', 'That task no longer exists.');
    if (t.repeat_mode === 'none') throw new Raise('22023', 'Only repeating tasks can be skipped.');
    if (b.p_occurrence && b.p_occurrence !== t.due_date) throw new Raise('P0001', 'already completed');
    const today = db.clock.local_date;
    const from = t.due_date > today ? t.due_date : today;
    const log = { id: crypto.randomUUID(), seq: ++db.logSeq, task_id: t.id, occurrence: t.due_date, status: 'skipped', done_on: null, done_by: email, prev_due: t.due_date, prev_last_done: t.last_done, created_at: nowIso(), at: Date.now() };
    t.due_date = t.repeat_mode === 'schedule' ? seriesAfter(t, from) : addUnits(from, t.every_count, t.every_unit);
    db.task_log.push(log);
    return log.id;
  },
  undo_task: (db, b) => undoTask(db, b.p_log_id, null, null),
  save_person: (db, b, email) => savePerson(db, b.p, b.p_can_sign_in, email),
  rotate_day_token: (db, b, email) => {
    if (!isAdmin(db, email)) throw new Raise('42501', 'Only an admin can do that.');
    const p = db.people.find((x) => x.id === b.p_person);
    if (!p) throw new Raise('P0002', 'That person is no longer on the family list.');
    p.day_token = hex32();
    return p.day_token;
  },
  // My day (signed out): the token is the only key.
  get_person_day: (db, b) => getPersonDay(db, b.p_token),
  complete_by_token: (db, b) => {
    const me = byToken(db, b.p_token);
    if (!me) return null;
    const t = db.tasks.find((x) => x.id === b.p_task_id && x.responsible_id === me.id);
    if (!t) throw new Raise('42501', 'That task isn\'t on your list.');
    if (t.repeat_mode !== 'none' && !b.p_occurrence) throw new Raise('P0001', 'already completed', 'Reload the page to see the task\'s current date.');
    return completeTask(db, t.id, b.p_occurrence, null, null, `${me.name} (My day)`);
  },
  undo_by_token: (db, b) => {
    const me = byToken(db, b.p_token);
    return me ? undoTask(db, b.p_log_id, me.id, `${me.name} (My day)`) : null;
  },
  // v1.2 (migration 0004): My day's shopping list, as mock.js fakes it. This household's database is on
  // schema 2, without the food tables, so they answer 404 PGRST202, as they would there.
  get_list_by_token: foodRpc.get_list_by_token,
  add_to_list_by_token: foodRpc.add_to_list_by_token,
  buy_item_by_token: foodRpc.buy_item_by_token,
};
// What anon (the signed-out My day page) may execute; everything else needs a member.
const ANON = new Set(['get_person_day', 'complete_by_token', 'undo_by_token', 'confirm_digest', 'stop_digest',
  'get_list_by_token', 'add_to_list_by_token', 'buy_item_by_token']);

// Table defaults and triggers for inserts (tasks_defaults, events_weekdays), so rows look as the database keeps them.
const TASK_DEFAULTS = { notes: null, category: 'other', responsible_id: null, due_date: null, due_time: null, lead_days: 0, project_id: null, contractor_id: null,
  private: false, repeat_mode: 'none', every_count: null, every_unit: null, repeat_weekdays: [], anchor_date: null, last_done: null, active: true, done_at: null, done_by: null };
const EVENT_DEFAULTS = { notes: null, location: null, end_date: null, start_time: null, end_time: null, ends_next_day: false, responsible_id: null, participant_ids: [],
  contractor_id: null, private: false, repeat: 'none', repeat_every: 1, repeat_weekdays: [], repeat_until: null, skip_days_off: false };
function taskRow(r, email) {
  const t = Object.assign({}, TASK_DEFAULTS, r, { created_by: email, updated_by: email });
  if (!(t.repeat_mode === 'schedule' && t.every_unit === 'week')) t.repeat_weekdays = [];
  if (t.repeat_mode === 'none') Object.assign(t, { every_count: null, every_unit: null, anchor_date: null });
  else if (!t.anchor_date) t.anchor_date = t.due_date;
  return t;
}
function eventRow(r, email) {
  const e = Object.assign({}, EVENT_DEFAULTS, r, { created_by: email, updated_by: email });
  e.repeat_weekdays = e.repeat === 'weekly' ? [...new Set([...(e.repeat_weekdays || []).map(Number), isoDow(e.start_date)])].sort((a, b) => a - b) : [];
  return e;
}

const emailOf = (req) => {
  const tok = (req.headers()['authorization'] || '').replace(/^Bearer\s+/i, '');
  try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email || null; } catch (e) { return null; }
};
const reply = (route, status, payload) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: payload === undefined ? '' : JSON.stringify(payload) });

// The site's Supabase, v2: mock.js for Auth and the tables, plus the functions above, the table rules
// mock.js doesn't model (defaults, the stale task_dates trigger, admin-only contractor_secrets), and no
// hub-jobs Edge Function (not deployed yet).
async function installHub(page, db, log, opts = {}) {
  await install(page, db, log, {});
  if (opts.v1) return;   // a v1 database: no hub_schema_version, no v2 functions (mock.js answers 404)
  await page.route((url) => url.host === 'test.supabase.co' && url.pathname.startsWith('/rest/v1/rpc/'), (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.slice('/rest/v1/rpc/'.length);
    if (!SQL[name]) return route.fallback();
    const email = emailOf(req);
    const body = JSON.parse(req.postData() || '{}');
    db.calls.push({ name, body, email });
    if (!ANON.has(name) && !db.members.some((m) => m.email === email)) return reply(route, 401, { code: '42501', message: 'permission denied for function ' + name });
    try {
      const out = SQL[name](db, body, email);
      if (out && out.__status) return reply(route, out.__status, out.body);   // mock.js's answer for an error
      return reply(route, 200, out === undefined ? null : out);
    } catch (e) {
      if (!(e instanceof Raise)) throw e;
      return reply(route, e.code === '42501' ? 403 : e.code === 'P0002' ? 404 : e.code === '23505' ? 409 : 400, { code: e.code, message: e.message, details: null, hint: e.hint });
    }
  });
  await page.route((url) => url.host === 'test.supabase.co' && /^\/rest\/v1\/(tasks|events|projects|contractors|household|people|members)$/.test(url.pathname), (route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS' || method === 'GET') return route.fallback();
    const url = new URL(req.url());
    const table = url.pathname.slice('/rest/v1/'.length);
    const email = emailOf(req);
    let body = req.postData() ? JSON.parse(req.postData()) : null;
    db.writes.push({ method, table, url: decodeURIComponent(url.search), body, email });
    if (table === 'people' || table === 'members') return reply(route, 403, { code: '42501', message: `permission denied for table ${table}` });   // save_person only
    if (method === 'POST' && table === 'tasks') body = Array.isArray(body) ? body.map((r) => taskRow(r, email)) : taskRow(body, email);
    if (method === 'POST' && table === 'events') body = Array.isArray(body) ? body.map((r) => eventRow(r, email)) : eventRow(body, email);
    if (method === 'POST' && table === 'contractors') body = Object.assign({ kind: 'contractor', category: null, address: null, contract_end: null }, body, { updated_by: email });
    if (method === 'PATCH' && table === 'events' && body && body.repeat === 'none') body = Object.assign({}, body, { repeat_weekdays: [] });
    // projects_mark_dates_stale: a schedule written without a new task_dates_at marks the dates stale.
    if (method === 'PATCH' && table === 'projects' && body && 'schedule' in body && !('task_dates_at' in body)) body = Object.assign({}, body, { task_dates: null });
    if (method === 'PATCH' && table === 'household' && !isAdmin(db, email)) return reply(route, 200, []);
    return route.fallback({ postData: JSON.stringify(body) });
  });
  // contractor_secrets: admins only. A member's read comes back empty (RLS), writes are refused.
  await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/contractor_secrets', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    const email = emailOf(req);
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const eq = [...url.searchParams].filter(([k, v]) => /^eq\./.test(v)).map(([k, v]) => [k, v.slice(3)]);
    const hit = (r) => eq.every(([k, v]) => String(r[k]) === v);
    const rows = /return=representation/.test(req.headers()['prefer'] || '');
    if (req.method() === 'GET') return reply(route, 200, isAdmin(db, email) ? db.contractor_secrets.filter(hit) : []);
    if (!isAdmin(db, email)) return reply(route, 403, { code: '42501', message: 'new row violates row-level security policy for table "contractor_secrets"' });
    if (req.method() === 'POST') {
      const out = (Array.isArray(body) ? body : [body]).map((r) => {
        const old = db.contractor_secrets.find((x) => x.contractor_id === r.contractor_id);
        if (old) return Object.assign(old, r, { updated_at: nowIso(), updated_by: email });
        const row = Object.assign({ account_number: null, account_name: null, secret_notes: null }, r, { updated_at: nowIso(), updated_by: email });
        db.contractor_secrets.push(row);
        return row;
      });
      return rows ? reply(route, 201, out) : route.fulfill({ status: 201, headers: CORS });
    }
    if (req.method() === 'DELETE') {
      db.contractor_secrets = db.contractor_secrets.filter((r) => !hit(r));
      return route.fulfill({ status: 204, headers: CORS });
    }
    return reply(route, 405, {});
  });
  // hub-jobs isn't deployed yet: Supabase answers 404.
  await page.route((url) => url.host === 'test.supabase.co' && url.pathname.startsWith('/functions/v1/hub-jobs'), (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    db.hubJobs = (db.hubJobs || 0) + 1;
    return reply(route, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
  });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  const DESKTOP = { viewport: { width: 1280, height: 900 } };
  const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const db = walkDb();

  // A browser context at one size and colour scheme, signed in as `email` (null: signed out).
  async function open(opts) {
    const log = [];
    const context = await browser.newContext(Object.assign({ timezoneId: 'Pacific/Honolulu', colorScheme: opts.dark ? 'dark' : 'light' }, opts.phone ? PHONE : DESKTOP));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    if (opts.email !== null) await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error' || expectedConsoleError(m)) return;
      // The Settings page asks hub-jobs for the morning email's status; it isn't deployed, so 404.
      if (/status of 404/.test(m.text()) && /\/functions\/v1\/hub-jobs/.test((m.location() || {}).url || '')) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => d.accept());
    await installHub(page, opts.db || db, log, { v1: opts.v1 });
    await page.goto(BASE + (opts.path || '/'));
    await settle(page);
    return { page, log, context };
  }
  async function settle(page, ms = 300) {
    await page.waitForFunction(() => !document.querySelector('#main > .loading, #app > .loading, #app > .page > .loading'), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(ms);
  }
  const go = async (page, hash) => {
    await page.evaluate((h) => { if (location.hash === h) HomeHub.core.route(); else location.hash = h; }, hash);
    await settle(page);
  };
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const lastToast = async (page) => (await texts(page, '.toasts .toast, body > .toast')).slice(-1)[0] || '';
  const formOpen = (page) => page.evaluate(() => document.getElementById('formDialog').open);
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const calls = (name) => db.calls.filter((c) => c.name === name);
  const until = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  // A row's title as shown (its first text node: the hidden ", repeats" label isn't part of it).
  const titles = (page, sel) => page.$$eval(`${sel} .irow-title`, (es) => es.map((e) => e.firstChild.textContent.trim()));
  const dayTitles = (page) => titles(page, '[data-list="day"]');
  const chip = (id) => `.today-chips .pchip[data-person="${id}"]`;
  // A full-page shot draws the phone's fixed bottom bar where the first screen ends, over the middle of a long
  // page; for the picture it sits at the end of the page instead (where it is once scrolled to the bottom).
  const shot = async (page, name) => {
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'shot-pin';
      s.textContent = 'body { position: relative; min-height: 100vh; } body.has-bottombar .bottombar { position: absolute !important; }';
      document.head.appendChild(s);
    });
    await page.screenshot({ path: SHOTS + `walk-${name}.png`, fullPage: true });
    await page.evaluate(() => document.getElementById('shot-pin').remove());
  };
  // What a phone shows when the page opens (the first screen, bottom bar and all).
  const firstScreen = (page, name) => page.screenshot({ path: SHOTS + `walk-${name}.png` });
  // Of the elements matching sel that are on screen, those smaller than 44px either way.
  const smallTargets = (page, sel) => page.$$eval(sel, (els) => els.filter((e) => e.offsetParent !== null).map((e) => {
    const r = e.getBoundingClientRect();
    return { t: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((r) => r.w < 44 || r.h < 44));

  // =====================================================================
  // (e) Family, desktop light: add Taylor (a helper) with a phone; copy and send her My day link
  // =====================================================================
  let { page } = await open({ label: 'family', path: '/#/people' });
  check('sign-in: v2, the people and the household are loaded, and signing in confirms Alex\'s address',
    (await page.evaluate(() => HomeHub.core.schemaVersion)) === 2 && calls('mark_signed_in').length === 1 && !!(await page.$('.ppl-card')));
  await page.click('[data-act="add"]');
  await page.waitForTimeout(300);
  await page.fill('#formDialog input[name="name"]', 'Taylor Example');
  await page.click('#formDialog label:has(> input[name="role"][value="helper"])');
  await page.fill('#formDialog input[name="phone"]', '(201) 555-0104');
  await shot(page, 'family-add-desktop');
  await page.click('#formDialog [type="submit"]');
  await settle(page, 500);
  const taylor = db.people.find((p) => p.name === 'Taylor Example');
  const save = calls('save_person').slice(-1)[0];
  check('(e) add a helper: save_person with role helper, the phone, and no sign-in', !!taylor && save && save.body.p_can_sign_in === false
    && save.body.p.role === 'helper' && save.body.p.phone === '(201) 555-0104' && !db.members.some((m) => /taylor/i.test(m.name)), JSON.stringify(save && save.body));
  check('(e) the form closes with "Added Taylor Example" and her card shows, with a My day link', !(await formOpen(page)) && (await lastToast(page)) === 'Added Taylor Example'
    && !!taylor && !!(await page.$(`.ppl-card[data-id="${taylor.id}"] .ppl-day`)), await lastToast(page));
  const link = `${BASE}/day.html?t=${taylor.day_token}`;
  await page.click(`.ppl-card[data-id="${taylor.id}"] [data-copy]`);
  await page.waitForTimeout(300);
  check('(e) Copy puts her My day link on the clipboard and says so', (await page.evaluate(() => navigator.clipboard.readText())) === link
    && (await lastToast(page)) === 'Copied Taylor\'s My day link', await lastToast(page));
  const waLink = await page.getAttribute(`.ppl-card[data-id="${taylor.id}"] [data-via="whatsapp"]`, 'href');
  const smsLink = await page.getAttribute(`.ppl-card[data-id="${taylor.id}"] [data-via="sms"]`, 'href');
  check('(e) WhatsApp and Text go to her number with the link and the Home Screen tip', waLink.startsWith('https://wa.me/12015550104?text=') && smsLink.startsWith('sms:+12015550104?&body=')
    && decodeURIComponent(waLink.split('?text=')[1]) === `Hi Taylor, here's your Home Hub day. Tap to see what's on today and tomorrow:\n${link}\n\nAdd it to your Home Screen to keep it one tap away.`, waLink);
  await shot(page, 'family-desktop');
  await page.context().close();

  // =====================================================================
  // (a) Piano every Tuesday at 4pm, phone light: Taylor in charge, Jordan along
  // =====================================================================
  ({ page } = await open({ label: 'piano-phone', phone: true }));
  check('Today\'s checklist: "Add starter tasks" goes to Repeating, where the starter list is', (await page.getAttribute('.today-steps li:last-child a', 'href')) === '#/tasks/repeating');
  check('phone: Today first, with the bottom bar (Today · Calendar · ＋ · Tasks · More)', (await texts(page, '.bottombar a, .bottombar button')).join('|') === 'Today|Calendar||Tasks|More'
    && /Good afternoon, Alex/.test(await text(page, '#main h1')) && /Tuesday, December 1/i.test(await text(page, '.today-head .eyebrow')), await text(page, '.today-head'));
  await page.click('.bb-add');
  await page.waitForTimeout(200);
  await shot(page, 'add-sheet-phone');
  await page.click('#sheet [data-add="event"]');
  await page.waitForSelector('.cal-form');
  await page.fill('.cal-form [name="title"]', 'Piano');
  check('(a) the form starts on today, the household\'s Tuesday Dec 1, and offers "Every Tue"', (await page.inputValue('.cal-form [name="start_date"]')) === TODAY
    && (await tc(page, '.cal-form [data-preset="weekly"]')) === 'Every Tue');
  await page.fill('.cal-form [name="start_time"]', '16:00');
  await page.click(`.cal-form [data-ref="who"] .pchip[data-person="${taylor.id}"]`);
  await page.click(`.cal-form [data-ref="who"] .pchip[data-person="${P.jordan}"]`);
  check('(a) who: Taylor in charge (first tap), Jordan with her (second tap)', (await tc(page, '.cal-form .who-hint')).startsWith('Taylor in charge · with Jordan'), await tc(page, '.cal-form .who-hint'));
  await page.click('.cal-form [data-preset="weekly"]');
  await page.click('.cal-form .cal-more summary');
  await page.fill('.cal-form [name="end_time"]', '17:00');
  await page.fill('.cal-form [name="location"]', 'Music school');
  check('(a) phone: the event form fits at 390px, its targets are at least 44px', await noSideScroll(page)
    && !(await smallTargets(page, '.cal-form .cal-chip, .cal-form .pchip, .cal-form .btn, .cal-form .d-close')).length, JSON.stringify(await smallTargets(page, '.cal-form .cal-chip, .cal-form .pchip, .cal-form .btn, .cal-form .d-close')));
  await shot(page, 'event-form-phone');
  await page.click('.cal-form [type="submit"]');
  await settle(page, 500);
  const piano = db.events.find((e) => e.title === 'Piano');
  check('(a) saved: weekly on Tuesdays from Dec 1, 4–5pm, Taylor in charge with Jordan, at the music school', !!piano && same(
    [piano.start_date, piano.start_time, piano.end_time, piano.repeat, piano.repeat_every, piano.repeat_weekdays, piano.responsible_id, piano.participant_ids, piano.location],
    [TODAY, '16:00', '17:00', 'weekly', 1, [2], taylor.id, [P.jordan], 'Music school']), JSON.stringify(piano));
  check('(a) a clear result: "Added Piano · Tue Dec 1", and the form is gone', (await lastToast(page)) === 'Added Piano · Tue Dec 1' && !(await formOpen(page)), await lastToast(page));
  await page.click(chip(taylor.id));
  await page.waitForTimeout(200);
  const taylorDay = await dayTitles(page);
  await page.click(chip(P.jordan));
  await page.waitForTimeout(200);
  const jordanDay = await dayTitles(page);
  check('(a) Today: Piano is on Taylor\'s day and on Jordan\'s day', taylorDay.includes('Piano') && jordanDay.includes('Piano'), `${taylorDay} / ${jordanDay}`);
  const pianoRow = await page.$eval('[data-list="day"] .irow', (r) => ({ time: r.querySelector('.irow-time').innerText.replace(/\s+/g, ' '), who: [...r.querySelectorAll('.irow-who .pdot')].map((d) => d.title), place: (r.querySelector('.irow-sub') || {}).textContent }));
  check('(a) the row: 4:00pm to 5:00pm, Taylor (in charge) and Jordan, at the music school', same(pianoRow, { time: '4:00pm 5:00pm', who: ['Taylor Example, in charge', 'Jordan Example'], place: 'Music school' }), JSON.stringify(pianoRow));
  await page.click('.today-chips [data-view="me"]');
  await page.waitForTimeout(200);
  check('(a) Alex\'s own day doesn\'t have it (he isn\'t on it)', !(await dayTitles(page)).includes('Piano'));
  const sendTaylor = `[data-send="${taylor.id}"]`;
  const wa = await page.getAttribute(`${sendTaylor} [data-via="whatsapp"]`, 'href');
  const expected = 'Taylor Example · Tue Dec 1\n4:00pm Piano · with Jordan Example';
  check('(a) "Send Taylor their day": WhatsApp to her number with day_text for today, word for word',
    wa.startsWith('https://wa.me/12015550104?text=') && decodeURIComponent(wa.split('?text=')[1]) === expected && dayText(db, taylor.id, TODAY) === expected
    && calls('day_text').some((c) => same(c.body, { p_person: taylor.id, p_day: TODAY })), decodeURIComponent(wa.split('?text=')[1] || ''));
  const jordanWa = decodeURIComponent((await page.getAttribute(`[data-send="${P.jordan}"] [data-via="whatsapp"]`, 'href')).split('?text=')[1]);
  check('(a) and Jordan\'s copy reads "Piano · Taylor Example"', jordanWa === 'Jordan Example · Tue Dec 1\n4:00pm Piano · Taylor Example', jordanWa);
  check('(a) phone: Today fits at 390px', await noSideScroll(page));
  await shot(page, 'today-phone');
  await page.click('.bottombar a[data-tab="calendar"]');
  await settle(page);
  const week = await titles(page, `[data-list="${TODAY}"]`);
  check('(a) Calendar (the week, on a phone): Piano on Tuesday Dec 1, and the week is Nov 30–Dec 6', week.includes('Piano') && (await text(page, '.cal-head h1')) === 'Nov 30–Dec 6'
    && (await page.getAttribute('[data-view="week"]', 'aria-pressed')) === 'true', `${await text(page, '.cal-head h1')}: ${week}`);
  check('(a) the calendar asked agenda() for that Monday to Sunday', calls('agenda').some((c) => same(c.body, { p_from: '2026-11-30', p_to: '2026-12-06' })));
  check('(a) phone: the Calendar week fits at 390px', await noSideScroll(page));
  await shot(page, 'calendar-week-phone');

  // =====================================================================
  // (b) Heartworm pill on the 1st of every month, for Taylor; tick it on Today, then Undo
  // =====================================================================
  await page.click('.bb-add');
  await page.waitForTimeout(200);
  await page.click('#sheet [data-add="task"]');
  await page.waitForSelector('.tasks-form');
  await page.fill('.tasks-form [name="title"]', 'Heartworm pill');
  await page.click(`.tasks-form [data-ref="who"] .pchip[data-person="${taylor.id}"]`);
  await page.click('.tasks-form [data-mode="schedule"]');
  await page.click('.tasks-form [data-when="today"]');
  await page.fill('.tasks-form [name="every_count"]', '1');
  await page.selectOption('.tasks-form [name="every_unit"]', 'month');
  await page.click('.tasks-form .tasks-more summary');
  await page.selectOption('.tasks-form [name="category"]', 'pets');
  check('(b) the form says "Next one is due" and how it repeats', (await tc(page, '.tasks-form [data-ref="when-label"]')) === 'Next one is due'
    && /^After that: /.test(await tc(page, '.tasks-form [data-ref="due-hint"]')), await tc(page, '.tasks-form [data-ref="due-hint"]'));
  await shot(page, 'task-form-phone');
  await page.click('.tasks-form [type="submit"]');
  await settle(page, 500);
  const pill = db.tasks.find((t) => t.title === 'Heartworm pill');
  check('(b) saved: on set dates, every 1 month, due today (the 1st), anchored there, Taylor in charge, pets', !!pill && same(
    [pill.repeat_mode, pill.every_count, pill.every_unit, pill.due_date, pill.anchor_date, pill.responsible_id, pill.category, pill.active],
    ['schedule', 1, 'month', TODAY, TODAY, taylor.id, 'pets', true]), JSON.stringify(pill));
  check('(b) a clear result toast, and the form closes', /Heartworm pill/.test(await lastToast(page)) && !(await formOpen(page)), await lastToast(page));
  await page.click('.bottombar a[data-tab="today"]');
  await settle(page);
  await page.click(chip(taylor.id));
  await page.waitForTimeout(200);
  check('(b) Today, Taylor\'s day: Piano and the heartworm pill', same((await dayTitles(page)).sort(), ['Heartworm pill', 'Piano']), (await dayTitles(page)).join(','));
  const pillRow = page.locator('[data-list="day"] .irow', { hasText: 'Heartworm pill' });
  await pillRow.locator('.irow-check').click();
  await until(async () => /^Done: Heartworm pill/.test(await lastToast(page)));
  const ticked = calls('complete_task').slice(-1)[0];
  check('(b) tick: complete_task for this date; the pill moves to Jan 1; the toast says so, with Undo',
    ticked && same(ticked.body, { p_id: pill.id, p_occurrence: TODAY }) && pill.due_date === '2027-01-01' && pill.last_done === TODAY
    && (await lastToast(page)) === 'Done: Heartworm pillUndo', JSON.stringify(ticked && ticked.body));
  await settle(page, 300);
  check('(b) after the tick it shows as done on today', (await pillRow.getAttribute('class') || '').includes('st-done'), await pillRow.getAttribute('class'));
  await shot(page, 'today-ticked-phone');
  await page.click('.toasts .toast-action .toast-btn');
  await until(async () => /^Not done: Heartworm pill/.test(await lastToast(page)));
  await settle(page, 300);
  check('(b) Undo: undo_task with the log id; due on the 1st again; the box is open again',
    calls('undo_task').length === 1 && calls('undo_task')[0].body.p_log_id && pill.due_date === TODAY && pill.last_done === null && !db.task_log.length
    && (await pillRow.locator('.irow-check').getAttribute('aria-checked')) === 'false', `${pill.due_date} ${await lastToast(page)}`);
  await page.click('.today-chips [data-view="me"]');
  await page.waitForTimeout(200);
  const wa2 = decodeURIComponent((await page.getAttribute(`${sendTaylor} [data-via="whatsapp"]`, 'href')).split('?text=')[1]);
  check('(b) "Send Taylor their day" now has the pill too (timed items first, then tasks)', wa2 === `${expected}\n☐ Heartworm pill`, wa2);
  // Rows on Today open where the item lives.
  await page.click(chip(taylor.id));
  await page.waitForTimeout(200);
  await page.locator('[data-list="day"] .irow', { hasText: 'Piano' }).locator('.irow-main').click();
  await settle(page, 400);
  check('Today: tapping an event opens that day of it on the Calendar, with its details', (await page.evaluate(() => location.hash)) === `#/calendar/event/${piano.id}/${TODAY}`
    && (await page.evaluate(() => document.getElementById('detail').open)) && /Piano/.test(await text(page, '#detail')), await page.evaluate(() => location.hash));
  await page.evaluate(() => document.getElementById('detail').close());
  await go(page, '#/');
  await page.locator('[data-list="day"] .irow', { hasText: 'Heartworm pill' }).locator('.irow-main').click();
  await settle(page, 400);
  check('Today: tapping a task opens it on Tasks, with its details', (await page.evaluate(() => location.hash)) === `#/tasks/${pill.id}`
    && (await page.evaluate(() => document.getElementById('detail').open)) && /Heartworm pill/.test(await text(page, '#detail')), await page.evaluate(() => location.hash));
  await page.context().close();

  // =====================================================================
  // (c) The starter list, desktop light: the furnace filter lands on the house owner (Sam)
  // =====================================================================
  ({ page } = await open({ label: 'starter', path: '/#/tasks/repeating' }));
  await page.click('[data-act="starter"]');
  await page.waitForTimeout(300);
  const owners = await texts(page, '.tasks-starter .tasks-hint');
  check('(c) the starter list says Sam will be in charge of the house jobs (Settings: the house owner)', /^Sam will be in charge/.test(owners[0] || ''), owners.join(' | '));
  check('(c) the pill already on the list doesn\'t stop the heartworm item (it has another name)', (await page.$$('.tasks-starter input[name="pick"]')).length === 20);
  await page.check('.tasks-starter input[name="pick"][value="hvac-filter"]');
  await shot(page, 'starter-desktop');
  await page.click('.tasks-starter [type="submit"]');
  await settle(page, 500);
  const filter = db.tasks.find((t) => t.title === 'Change the furnace/AC filter');
  check('(c) added: Sam in charge, home, 60 days after it\'s done, first due tomorrow', !!filter && same(
    [filter.responsible_id, filter.category, filter.repeat_mode, filter.every_count, filter.every_unit, filter.due_date], [P.sam, 'home', 'after_done', 60, 'day', '2026-12-02']), JSON.stringify(filter));
  check('(c) a clear result: "Added 1 repeating task · …" with Undo', /^Added 1 repeating task/.test(await lastToast(page)), await lastToast(page));
  const filterRow = page.locator('.tasks-body .irow', { hasText: 'furnace' }).first();
  check('(c) the Repeating list shows it with Sam\'s dot', (await filterRow.count()) === 1 && (await filterRow.locator('.pdot').first().getAttribute('title')) === 'Sam Example, in charge');
  await shot(page, 'tasks-repeating-desktop');

  // =====================================================================
  // (d) Directory, desktop light (Alex, an admin): an account with an account number
  // =====================================================================
  await go(page, '#/directory');
  await page.click('.dir-add');
  await page.waitForTimeout(300);
  await page.selectOption('#formDialog [name="kind"]', 'account');
  const acct = { name: 'Example Power & Light', category: 'Electric', phone: '(201) 555-0110', contract_end: '2026-12-20', account_number: '5555 0101 2468', account_name: 'Alex Example' };
  for (const [k, v] of Object.entries(acct)) await page.fill(`#formDialog [name="${k}"]`, v);
  await page.click('#formDialog [type="submit"]');
  await settle(page, 500);
  const power = db.contractors.find((c) => c.name === acct.name);
  check('(d) saved: an account entry, and its number in contractor_secrets (admins only)', !!power && power.kind === 'account' && !('account_number' in power)
    && db.contractor_secrets.some((s) => s.contractor_id === power.id && s.account_number === acct.account_number) && (await lastToast(page)) === `Added ${acct.name}`, await lastToast(page));
  const card = power ? `.dir-card[data-id="${power.id}"]` : '.none';
  check('(d) admin: the number is masked to the last 4, and the full number isn\'t in the page', (await tc(page, `${card} .dir-acct-num`)) === '•••• 2468' && !(await page.content()).includes('5555 0101'));
  check('(d) the contract end shows with a badge (19 days from the household\'s today)', (await tc(page, `${card} .dir-end`)) === 'Contract ends Dec 20 Ends in 19 days', await tc(page, `${card} .dir-end`));
  await page.click(`${card} [data-show]`);
  check('(d) admin: Show reveals it', (await tc(page, `${card} .dir-acct-num`)) === acct.account_number);
  await shot(page, 'directory-desktop');

  // =====================================================================
  // (g) Settings, desktop light: days off; the morning email's status without hub-jobs
  // =====================================================================
  await go(page, '#/settings');
  await page.fill('[data-ref="dayoffForm"] input[name="from"]', '2026-12-21');
  await page.fill('[data-ref="dayoffForm"] input[name="to"]', '2026-12-31');
  await page.click('[data-ref="dayoffForm"] [type="submit"]');
  await settle(page, 500);
  const off = db.household[0].days_off;
  check('(g) days off: Dec 21–31 saved on the household (11 days), and listed as one run', off.length === 11 && off[0] === '2026-12-21' && off[10] === '2026-12-31'
    && (await texts(page, '[data-ref="daysoff"] .set-dayoff-label')).includes('Mon Dec 21 – Thu Dec 31 (11 days)'), JSON.stringify(await texts(page, '[data-ref="daysoff"] .set-dayoff-label')));
  check('(g) a clear result for the days off', /Dec 21/.test(await lastToast(page)), await lastToast(page));
  check('(g) "Signed in" shows the family list\'s name (the sign-in list still has the shorter one)', (await tc(page, '[data-ref="who"]')) === 'Alex Example (alex@example.com)', await tc(page, '[data-ref="who"]'));
  await until(async () => (await tc(page, '[data-ref="status"] .set-status')) !== '');
  check('(g) no hub-jobs yet: the morning email\'s status says "Not set up yet", and the page still works', (await tc(page, '[data-ref="status"] .set-status')) === 'Not set up yet'
    && db.hubJobs > 0 && !!(await page.$('.set-form')), await tc(page, '[data-ref="status"]'));
  await shot(page, 'settings-desktop');

  // =====================================================================
  // (h) Projects, desktop light: an owner, the Tasks card, Put on the schedule
  // =====================================================================
  await go(page, '#/projects/p-kitchen');
  const kitchen = db.projects.find((p) => p.id === 'p-kitchen');
  check('(h) reading the projects filled in the stale task dates (with task_dates_at)', Array.isArray(kitchen.task_dates) && kitchen.task_dates.length > 10 && !!kitchen.task_dates_at);
  await page.click('[data-ref="head"] [data-act="settings"]');
  await page.waitForTimeout(300);
  await page.selectOption('#formDialog select[name="owner_id"]', P.alex);
  await page.click('#formDialog [type="submit"]');
  await settle(page, 500);
  const ownerWrite = db.writes.filter((w) => w.table === 'projects' && w.method === 'PATCH' && w.body && 'owner_id' in w.body).slice(-1)[0];
  check('(h) owner: saved with the schedule, fresh task_dates and task_dates_at; the heading says "Owner: Alex Example"', kitchen.owner_id === P.alex
    && ownerWrite && Array.isArray(ownerWrite.body.task_dates) && !!ownerWrite.body.task_dates_at && /Owner: Alex Example/.test(await tc(page, '[data-ref="head"] .meta')), await tc(page, '[data-ref="head"] .meta'));
  await page.click('.ptasks [data-act="ptask-add"]');
  await page.waitForTimeout(400);
  check('(h) Tasks card: + Task opens the task form on this project', (await page.$eval('#formDialog select[name="project_id"]', (s) => s.value)) === 'p-kitchen');
  await page.fill('#formDialog input[name="title"]', 'Order cabinet pulls');
  await page.click('#formDialog [type="submit"]');
  await settle(page, 600);
  const pulls = db.tasks.find((t) => t.title === 'Order cabinet pulls');
  check('(h) Tasks card: the new task is on the project and listed on the card', !!pulls && pulls.project_id === 'p-kitchen'
    && (await titles(page, '.ptasks')).includes('Order cabinet pulls'), (await titles(page, '.ptasks')).join(','));
  await shot(page, 'project-tasks-desktop');
  await page.locator('.ptasks .ptask', { hasText: 'Order cabinet pulls' }).first().locator('.ptask-sched').click();
  await page.waitForTimeout(400);
  check('(h) Put on the schedule: its form, with the task\'s name', (await tc(page, '#formDialog h3')) === 'Put on the schedule' && (await page.inputValue('#formDialog input[name="name"]')) === 'Order cabinet pulls');
  await page.click('#formDialog [type="submit"]');
  await settle(page, 800);
  const sched = kitchen.schedule.phases.flatMap((ph) => ph.tasks);
  const onSched = sched.find((t) => t.name === 'Order cabinet pulls');
  const schedWrite = db.writes.filter((w) => w.table === 'projects' && w.method === 'PATCH' && w.body && w.body.schedule).slice(-1)[0];
  check('(h) Put on the schedule: a 1-day task at the end of the last phase, saved with fresh task dates; the task row is gone',
    !!onSched && kitchen.schedule.phases.slice(-1)[0].tasks.slice(-1)[0] === onSched && onSched.days === 1 && !db.tasks.some((t) => t.title === 'Order cabinet pulls')
    && schedWrite.body.task_dates.some((x) => x.name === 'Order cabinet pulls') && !!schedWrite.body.task_dates_at, JSON.stringify(onSched));
  check('(h) a clear result: "On the schedule: Order cabinet pulls · …"; the card no longer lists it', /^On the schedule: Order cabinet pulls/.test(await lastToast(page))
    && !(await titles(page, '.ptasks')).includes('Order cabinet pulls'), await lastToast(page));
  check('(h) desktop: the project page fits', await noSideScroll(page));
  await shot(page, 'project-desktop');
  await page.context().close();

  // =====================================================================
  // (d) A member (Sam), desktop dark: the account entry, without ever asking for account numbers
  // =====================================================================
  let log;
  ({ page, log } = await open({ label: 'member-dark', email: 'sam@example.com', dark: true, path: '/#/directory' }));
  check('(d) member: the entry shows, with no account line', !!(await page.$(card)) && !(await page.$(`${card} .dir-account`)) && !(await page.content()).includes('2468'));
  check('(d) member: contractor_secrets is never requested', !log.some((l) => l.includes('contractor_secrets')), log.filter((l) => /secrets/.test(l)).join(' | '));
  await shot(page, 'directory-member-desktop-dark');
  await go(page, '#/');
  await page.locator('[data-list="heads"] .irow', { hasText: 'Contract ends' }).locator('.irow-main').click();
  await settle(page, 400);
  check('Today: tapping a contract heads-up opens that entry in the Directory', (await page.evaluate(() => location.hash)) === `#/directory/${power.id}` && !!(await page.$(card)),
    await page.evaluate(() => location.hash));
  const jobsBefore = db.hubJobs;
  await go(page, '#/settings');
  check('(d) member: Settings is read-only and never asks hub-jobs', !(await page.$('[data-ref="dayoffForm"]')) && db.hubJobs === jobsBefore
    && (await texts(page, '[data-ref="daysoff"] .set-dayoff-label')).includes('Mon Dec 21 – Thu Dec 31 (11 days)'));
  await page.context().close();

  // =====================================================================
  // (f) My day, phone dark, signed out: Taylor's link shows Piano and the pill; tick, then Undo
  // =====================================================================
  ({ page, log } = await open({ label: 'my-day', email: null, phone: true, dark: true, path: `/day.html?t=${taylor.day_token}` }));
  await page.waitForSelector('.day-head', { timeout: 5000 });
  await settle(page, 300);
  const myToday = await titles(page, 'section[aria-labelledby="day-today"]');
  check('(f) My day (no sign-in): today has Piano and the heartworm pill', myToday.includes('Piano') && myToday.includes('Heartworm pill'), myToday.join(','));
  check('(f) My day asks only get_person_day with her token, signed out', calls('get_person_day').slice(-1)[0].email === null && same(calls('get_person_day').slice(-1)[0].body, { p_token: taylor.day_token }));
  const myPill = page.locator('section[aria-labelledby="day-today"] .irow', { hasText: 'Heartworm pill' });
  await myPill.locator('.day-check').click();
  await until(async () => calls('complete_by_token').length === 1 && (await page.$('.toast-action .toast-btn:not(.toast-x)')) !== null);
  check('(f) tick: complete_by_token with her token, the task and this date; logged as "Taylor Example (My day)"',
    same(calls('complete_by_token')[0].body, { p_token: taylor.day_token, p_task_id: pill.id, p_occurrence: TODAY }) && pill.due_date === '2027-01-01'
    && db.task_log.length === 1 && db.task_log[0].done_by === 'Taylor Example (My day)', JSON.stringify(calls('complete_by_token')[0]));
  await settle(page, 300);
  check('(f) the pill shows as done', (await myPill.locator('.day-check').getAttribute('aria-checked')) === 'true');
  await shot(page, 'my-day-ticked-phone-dark');
  await page.click('.toast-action .toast-btn:not(.toast-x)');
  await until(async () => calls('undo_by_token').length === 1 && pill.due_date === TODAY);
  await settle(page, 400);
  check('(f) Undo: undo_by_token with her token and the log id; the pill is due today again and open', same(calls('undo_by_token')[0].body, { p_token: taylor.day_token, p_log_id: calls('undo_by_token')[0].body.p_log_id })
    && pill.due_date === TODAY && !db.task_log.length && (await myPill.locator('.day-check').getAttribute('aria-checked')) === 'false');
  check('(f) My day fits at 390px', await noSideScroll(page));
  check('(f) My day never loads the hub, and its database calls are only the token functions', !log.some((l) => /\/rest\/v1\/(?!rpc\/(get_person_day|complete_by_token|undo_by_token|get_list_by_token|add_to_list_by_token|buy_item_by_token)$)/.test(l.split('?')[0])), log.join(' | '));
  await shot(page, 'my-day-phone-dark');
  await page.context().close();

  // =====================================================================
  // Every page at 390px and 1280px, light and dark: no sideways scroll; screenshots to look at
  // =====================================================================
  const PAGES = [['today', '#/'], ['calendar', '#/calendar'], ['tasks', '#/tasks/everyone'], ['projects', '#/projects'], ['project', '#/projects/p-kitchen'],
    ['directory', '#/directory'], ['family', '#/people'], ['settings', '#/settings']];

  // Project work, worked out from the projects' task_dates (the kitchen has jobs that last weeks, several
  // at once): on a day's calendar list, a job is a row only on the day it starts and the day it finishes
  // (a one-day job or milestone on its day); on the days between, one "N jobs in progress" line per
  // project. Today has one short line per project.
  const projectJobs = () => db.projects.filter((p) => p.on_calendar && Array.isArray(p.task_dates)).flatMap((p) => p.task_dates.map((x) => Object.assign({ project: p }, x)));
  const oneDayJob = (x) => !!x.milestone || x.end <= x.start;
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const jobsText = (n) => `${n} job${n === 1 ? '' : 's'}`;
  function expectedDay(day) {
    const jobs = projectJobs();
    const rows = jobs.filter((x) => (oneDayJob(x) ? x.start === day : x.start === day || x.end === day)).map((x) => x.name).sort(byText);
    const lines = [...new Set(jobs.map((x) => x.project))].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const during = jobs.filter((x) => x.project === p && !oneDayJob(x) && x.start < day && day < x.end);
      const open = during.filter((x) => x.status !== 'done').length;
      const done = during.length - open;
      if (!during.length) return null;
      return `${p.name} · ${open ? `${jobsText(open)} in progress${done ? ` · ${done} done` : ''}` : `${jobsText(done)} done`}`;
    }).filter(Boolean);
    return { rows, lines };
  }
  function expectedToday() {
    const jobs = projectJobs().filter((x) => x.status !== 'done' && x.start <= TODAY && TODAY <= x.end && !['done', 'idea', 'on-hold'].includes(x.project.status));
    return [...new Set(jobs.map((x) => x.project))].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const mine = jobs.filter((x) => x.project === p);
      const starting = mine.filter((x) => x.start === TODAY).map((x) => x.name).sort(byText);
      const going = mine.length - starting.length;
      const names = starting.slice(0, 2).concat(starting.length > 2 ? [`+${starting.length - 2} more`] : []);
      return [`${p.name}: ${[starting.length ? `${starting.length} starting today` : '', going ? `${going} in progress` : ''].filter(Boolean).join(' · ')}`,
        names.length ? names.join(' · ') : null, `#/projects/${p.id}`];
    });
  }
  // A calendar day list as shown: its project rows (by title), its "in progress" lines, and whether the
  // lines come last and every project row comes after the day's events.
  const shownDay = (page, sel) => page.$eval(sel, (l) => {
    const own = [...l.querySelectorAll('.irow')].filter((r) => !r.closest('.cal-ongoing'));
    const kids = [...l.children];
    const firstProject = own.findIndex((r) => r.dataset.kind === 'project');
    return {
      rows: own.filter((r) => r.dataset.kind === 'project').map((r) => r.querySelector('.irow-title').textContent.trim()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      lines: [...l.querySelectorAll('.cal-ongoing > summary')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()),
      linesLast: kids.every((k, i) => !k.classList.contains('cal-ongoing') || kids.slice(i).every((x) => x.classList.contains('cal-ongoing'))),
      eventsFirst: firstProject < 0 || !own.slice(firstProject).some((r) => r.dataset.kind === 'event' && !r.classList.contains('cal-span')),
    };
  });
  const todayProjects = (page) => page.$$eval('.today-projects li', (lis) => lis.map((li) => [
    li.querySelector('.today-proj-line').textContent.replace(/\s+/g, ' ').trim(),
    li.querySelector('.today-proj-jobs') ? li.querySelector('.today-proj-jobs').textContent.trim() : null,
    li.querySelector('.today-proj').getAttribute('href'),
  ]));
  for (const [size, phone] of [['phone', true], ['desktop', false]]) {
    for (const scheme of ['light', 'dark']) {
      ({ page } = await open({ label: `${size}-${scheme}`, phone, dark: scheme === 'dark' }));
      const wide = [];
      for (const [name, hash] of PAGES) {
        await go(page, hash);
        if (!(await noSideScroll(page))) wide.push(name);
        await shot(page, `${name}-${size}-${scheme}`);
      }
      check(`${size} ${scheme}: every page fits without sideways scroll`, !wide.length, wide.join(','));
      await go(page, '#/');
      const projLines = await todayProjects(page);
      check(`${size} ${scheme}: Today has one short line per project ("N starting today · M in progress", the starting jobs named), not a list of every job`,
        projLines.length >= 1 && same(projLines, expectedToday()) && !/until|;/.test(await tc(page, '.today-projects')), JSON.stringify([projLines, expectedToday()]));
      if (phone) {
        // The full-page shot has the bottom bar over the end of the page, so the card gets a shot of its own.
        await page.$eval('.today-sec[aria-label="Projects today"]', (s) => s.scrollIntoView({ block: 'center' }));
        await page.locator('.today-sec[aria-label="Projects today"]').screenshot({ path: SHOTS + `walk-today-projects-${size}-${scheme}.png` });
      }
      await go(page, '#/calendar');
      const lists = phone ? Array.from({ length: 7 }, (_, i) => [addDays(mondayOf(TODAY), i), `[data-list="${addDays(mondayOf(TODAY), i)}"]`]) : [[TODAY, '.cal-panel .cal-list']];
      const seen = await Promise.all(lists.map(([, sel]) => shownDay(page, sel)));
      const want = lists.map(([d]) => expectedDay(d));
      check(`${size} ${scheme}: Calendar ${phone ? 'week' : 'day panel'}: each long job is a row only on its start and finish days, one "in progress" line per project between, after the day's events`,
        lists.every((_, i) => same(seen[i].rows, want[i].rows) && same(seen[i].lines, want[i].lines) && seen[i].linesLast && seen[i].eventsFirst)
          && seen.some((s) => s.lines.length) && seen.reduce((n, s) => n + s.rows.length, 0) <= 2 * projectJobs().length,
        JSON.stringify(lists.map(([d], i) => [d, seen[i], want[i]])));
      if (phone) {
        // The Calendar's first screen on a phone: the strip has a bar per project, not one per job (it was six
        // rows of kitchen bars, "on order" ones and cut-off "O…", "S…", with today's piano behind the bottom bar).
        const monday = mondayOf(TODAY);
        const weekProjects = [...new Set(projectJobs().filter((x) => x.start <= addDays(monday, 6) && x.end >= monday).map((x) => x.project.name))].sort();
        const stripBars = await page.$$eval('.cal-strip .cal-bar.k-project', (bs) => bs.map((b) => ({ text: b.innerText.replace(/\s+/g, ' ').trim(), fits: b.scrollWidth <= b.clientWidth + 1 })));
        const firstToday = await page.evaluate((day) => {
          const row = [...document.querySelectorAll(`[data-list="${day}"] .irow`)].find((r) => !r.closest('.cal-ongoing') && r.dataset.kind !== 'project');
          return row && { title: row.querySelector('.irow-title').firstChild.textContent.trim(), bottom: Math.round(row.getBoundingClientRect().bottom),
            bar: Math.round(document.querySelector('.bottombar').getBoundingClientRect().top), scrolled: window.scrollY };
        }, TODAY);
        check(`${size} ${scheme}: Calendar (phone): the strip has one bar per project this week, whole, and today's first event shows on the first screen, above the bottom bar`,
          stripBars.length === weekProjects.length && stripBars.every((b, i) => b.fits && b.text.startsWith(`${weekProjects[i]} · `))
            && !!firstToday && firstToday.scrolled === 0 && firstToday.bottom <= firstToday.bar, JSON.stringify([stripBars, weekProjects, firstToday]));
        await firstScreen(page, `calendar-first-screen-${size}-${scheme}`);
        await go(page, '#/');
        await page.click('.bb-more');
        await page.waitForTimeout(250);
        check(`${size} ${scheme}: More lists Projects, Directory, Family, Settings, then Sign out (signed in as the family list's name)`,
          same(await texts(page, '#sheet .sheet-list a'), ['Projects', 'Directory', 'Family', 'Settings']) && /Signed in as Alex Example/.test(await tc(page, '#sheet .sheet-foot')), await tc(page, '#sheet .sheet-foot'));
        await shot(page, `more-sheet-${size}-${scheme}`);
        await page.click('#sheet [data-close]');
        await page.waitForTimeout(150);
        const small = await smallTargets(page, '.bottombar a, .bottombar button, .today-chips .pchip, #main .irow-check, #main .btn');
        check(`${size} ${scheme}: Today's tap targets and the bottom bar are at least 44px`, !small.length, JSON.stringify(small));
      }
      await page.context().close();
    }
  }

  // =====================================================================
  // (i) v1 mode (no hub_schema_version): exactly the v1 pages
  // =====================================================================
  const v1db = makeDb();
  for (const [size, phone] of [['desktop', false], ['phone', true]]) {
    ({ page, log } = await open({ label: `v1-${size}`, v1: true, db: v1db, phone }));
    const tabs = await page.$$eval('.tabs a', (as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
    check(`(i) v1 ${size}: the v1 tabs, in order (Home, Projects, Contractors, Family)`, same(tabs, [['Home', '#/'], ['Projects', '#/projects'], ['Contractors', '#/contractors'], ['Family', '#/family']])
      && (await page.evaluate(() => HomeHub.core.schemaVersion)) === 1, JSON.stringify(tabs));
    check(`(i) v1 ${size}: no bottom bar, no Add button, the v1 Home page`, !(await page.$('.bottombar')) && !(await page.$('[data-shell="add"]'))
      && /Good (morning|afternoon|evening), Alex/.test(await text(page, '#main')));
    await shot(page, `v1-home-${size}`);
    await go(page, '#/contractors');
    check(`(i) v1 ${size}: the Contractors page`, (await text(page, '#main')).includes('Maria Gomez'));
    await go(page, '#/family');
    check(`(i) v1 ${size}: the old Family page`, (await text(page, '#main')).includes('Who can sign in'));
    await go(page, '#/projects/p-kitchen');
    check(`(i) v1 ${size}: the v1 project page (no Tasks card)`, (await text(page, '#main')).includes('Install cabinets') && !(await page.$('.ptasks')));
    await shot(page, `v1-project-${size}`);
    check(`(i) v1 ${size}: no v2 reads or calls`, !log.some((l) => /\/rest\/v1\/(people|household|tasks|events|task_log)|rpc\/(clock|agenda|mark_signed_in|late_items)/.test(l)), log.filter((l) => /people|clock|agenda/.test(l)).join(' | '));
    await page.context().close();
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
