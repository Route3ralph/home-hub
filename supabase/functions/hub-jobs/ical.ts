// A lenient iCalendar (RFC 5545) reader for the school's Blackbaud calendar links
// (docs/v1.3-homework.md §11.3). Hand-written, no imports, so it runs in Deno and in the Node tests.
// It reads what Blackbaud's feeds were seen to hold, and what the research warned about:
//   • CRLF, LF or CR line ends; folded lines (a line starting with a space or a tab continues the last);
//   • VEVENTs only (a VALARM inside one, a VTIMEZONE beside them, are skipped); a repeated property in
//     one event: the last one wins; STATUS:CANCELLED events are left out (an item taken off the site);
//   • DTSTART and DTEND as VALUE=DATE, as date-times at midnight (Blackbaud's non-standard all-day
//     form: an item at 00:00 that ends at 00:00, or has no end, is all-day), with TZID= (an IANA zone,
//     the usual Windows names, or else the household's zone), Z, or floating (the household's zone);
//     DURATION when there is no DTEND; an all-day end is exclusive, so it is moved back a day;
//   • TEXT escapes (\n \, \; \\) and HTML entities; a description's HTML becomes plain text;
//   • RRULE and RDATE aren't expanded: the event is read once, and counted (the status card shows it);
//   • an HTML page (Blackbaud's sign-in page, for a link that was replaced) is 'sign_in', anything else
//     without a VCALENDAR 'not_calendar'.
// Nothing here logs, and nothing here throws on bad input: a property it can't read is left out.

export type IcalEvent = {
  uid: string | null;
  summary: string;              // one line, entities decoded, tags removed
  description: string | null;   // plain text with line breaks, or null
  allDay: boolean;
  firstDay: string;             // YYYY-MM-DD in the household's zone
  lastDay: string;              // inclusive
  start: string | null;         // a timed event's instants, ISO 8601 in UTC
  end: string | null;
  repeats: boolean;             // has RRULE or RDATE (not expanded)
};
export type IcalResult =
  | { kind: 'calendar'; events: IcalEvent[]; repeats: number }
  | { kind: 'sign_in' | 'not_calendar' };

// The Windows zone names a .NET calendar writes in TZID, for the zones a US school is likely in.
const WINDOWS_ZONES: Record<string, string> = {
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'gmt standard time': 'Europe/London',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
};

const zoneOk = new Map<string, boolean>();
function knownZone(z: string): boolean {
  if (!zoneOk.has(z)) {
    let ok = false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); ok = true; } catch { /* not a zone this runtime knows */ }
    zoneOk.set(z, ok);
  }
  return zoneOk.get(z)!;
}
// A TZID as a zone the runtime knows: itself, its Windows name's zone, or (unknown) the household's.
export function resolveZone(tzid: string | null | undefined, household: string): string {
  const t = String(tzid ?? '').replace(/^"|"$/g, '').trim().replace(/^\//, '');
  if (!t) return household;
  if (knownZone(t)) return t;
  const w = WINDOWS_ZONES[t.toLowerCase()];
  return w && knownZone(w) ? w : household;
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const dayOf = (w: { y: number; mo: number; d: number }) => `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}`;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// The wall time an instant shows in a zone.
const fmts = new Map<string, Intl.DateTimeFormat>();
function wallAt(ms: number, zone: string): Wall {
  let f = fmts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmts.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
// The instant a wall time in a zone is (the earlier one when a clock change makes it twice).
function instantOf(w: Wall, zone: string): number {
  const target = wallMs(w);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const off = wallMs(wallAt(t, zone)) - t;
    const next = target - off;
    if (next === t) break;
    t = next;
  }
  return t;
}

// One property's value as a date or a date-time. null when it can't be read.
type When = { date: true; day: string } | { date: false; ms: number; wall: Wall };
function readWhen(value: string, params: Record<string, string>, household: string): When | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const isDate = (params.VALUE || '').toUpperCase() === 'DATE' || m[4] === undefined;
  if (isDate) {
    const day = dayOf({ y, mo, d });
    return Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
      ? null : { date: true, day };
  }
  const wall: Wall = { y, mo, d, h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0) };
  if (wall.h > 23 || wall.mi > 59 || wall.s > 60) return null;
  if (m[7]) {
    const ms = wallMs(wall);
    return { date: false, ms, wall: wallAt(ms, household) };
  }
  const zone = resolveZone(params.TZID, household);
  const ms = instantOf(wall, zone);
  return { date: false, ms, wall };   // the wall time in its own zone (the all-day rule reads it)
}

// A DURATION (P1D, PT45M, P1W, -PT5M) in milliseconds, or null.
function readDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(v.trim());
  if (!m || v.trim().length <= 1) return null;
  const n = (x?: string) => Number(x ?? 0);
  const ms = (((n(m[2]) * 7 + n(m[3])) * 24 + n(m[4])) * 60 + n(m[5])) * 60000 + n(m[6]) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}
const unescapeText = (s: string) => s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
// One line: tags out, entities decoded, every run of spaces (and line breaks) one space.
const oneLineText = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
// A description: HTML's breaks and paragraphs become line breaks, the rest of the markup goes.
function plainText(s: string): string {
  const t = decodeEntities(s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, ''));
  return t.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// A content line: NAME;PARAM=VALUE;PARAM="VALUE":value. Colons inside quotes don't end the name.
function contentLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  let q = false;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const parts: string[] = [];
  let cur = '';
  q = false;
  for (const c of head) {
    if (c === '"') q = !q;
    if (c === ';' && !q) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { name: parts[0].trim().toUpperCase(), params, value: line.slice(i + 1) };
}

export function parseIcal(text: string, household: string): IcalResult {
  const src = String(text ?? '').replace(/^﻿/, '');
  if (!/^\s*BEGIN:VCALENDAR\b/im.test(src)) {
    return { kind: /<\s*(!doctype|html|head|body|form)\b/i.test(src) ? 'sign_in' : 'not_calendar' };
  }
  // Unfold.
  const lines: string[] = [];
  for (const raw of src.split(/\r\n|\n|\r/)) {
    if ((raw[0] === ' ' || raw[0] === '\t') && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }

  const events: IcalEvent[] = [];
  let repeats = 0;
  const stack: string[] = [];
  let props: Map<string, { params: Record<string, string>; value: string }> | null = null;
  let repeating = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const cl = contentLine(line);
    if (!cl) continue;
    if (cl.name === 'BEGIN') {
      const comp = cl.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && stack.length === 2 && stack[0] === 'VCALENDAR') { props = new Map(); repeating = false; }
      continue;
    }
    if (cl.name === 'END') {
      const comp = cl.value.trim().toUpperCase();
      if (comp === 'VEVENT' && props && stack.length === 2) {
        const ev = toEvent(props, repeating, household);
        if (ev) {
          events.push(ev);
          if (ev.repeats) repeats++;
        }
        props = null;
      }
      // Pop to the matching BEGIN (a missing END inside is forgiven).
      const at = stack.lastIndexOf(comp);
      if (at >= 0) stack.length = at;
      continue;
    }
    // Only the event's own properties: not a VALARM's inside it.
    if (props && stack.length === 2 && stack[1] === 'VEVENT') {
      if (cl.name === 'RRULE' || cl.name === 'RDATE') repeating = true;
      props.set(cl.name, { params: cl.params, value: cl.value });
    }
  }
  return { kind: 'calendar', events, repeats };
}

function toEvent(p: Map<string, { params: Record<string, string>; value: string }>, repeating: boolean, household: string): IcalEvent | null {
  if ((p.get('STATUS')?.value || '').trim().toUpperCase() === 'CANCELLED') return null;
  const ds = p.get('DTSTART');
  if (!ds) return null;
  const start = readWhen(ds.value, ds.params, household);
  if (!start) return null;
  const de = p.get('DTEND');
  let end = de ? readWhen(de.value, de.params, household) : null;
  const dur = !de && p.get('DURATION') ? readDuration(p.get('DURATION')!.value) : null;

  const summary = oneLineText(unescapeText(p.get('SUMMARY')?.value ?? ''));
  const descRaw = p.get('DESCRIPTION')?.value ?? p.get('X-ALT-DESC')?.value ?? null;
  const description = descRaw == null ? null : (plainText(unescapeText(descRaw)) || null);
  const uidRaw = (p.get('UID')?.value ?? '').trim();
  const uid = uidRaw ? unescapeText(uidRaw).replace(/\s+/g, ' ').slice(0, 255) : null;

  const midnight = (w: When | null) => !!w && !w.date && w.wall.h === 0 && w.wall.mi === 0 && w.wall.s === 0;
  // All-day: a date, or Blackbaud's date-time at midnight that ends at midnight (or has no end).
  if (start.date || (midnight(start) && (!end || end.date || midnight(end)) && (dur === null || dur % 86400000 === 0))) {
    const first = start.date ? start.day : dayOf(start.wall);
    let endDay: string | null = null;
    if (end) endDay = end.date ? end.day : dayOf(end.wall);
    else if (dur !== null && dur > 0) endDay = addDays(first, Math.round(dur / 86400000));
    // The end is exclusive: the day before it is the last day.
    let last = endDay && endDay > first ? addDays(endDay, -1) : first;
    if (last < first) last = first;
    return { uid, summary, description, allDay: true, firstDay: first, lastDay: last, start: null, end: null, repeats: repeating };
  }
  if (start.date) return null;
  let endMs: number | null = null;
  if (end && !end.date) endMs = end.ms;
  else if (end && end.date) endMs = Date.parse(`${end.day}T00:00:00Z`) - (wallMs(wallAt(start.ms, household)) - start.ms);
  else if (dur !== null) endMs = start.ms + dur;
  if (endMs !== null && endMs < start.ms) endMs = null;
  const first = dayOf(wallAt(start.ms, household));
  let last = endMs !== null && endMs > start.ms ? dayOf(wallAt(endMs - 1, household)) : first;
  if (last < first) last = first;
  return {
    uid, summary, description, allDay: false, firstDay: first, lastDay: last,
    start: new Date(start.ms).toISOString(), end: endMs !== null ? new Date(endMs).toISOString() : null, repeats: repeating,
  };
}

// An assignment's class, when its title names one: "Biology - 2 (B): Lab report" → Biology,
// "Lab report". The part before the first ": " is the class when it is 2 to 40 characters and doesn't
// start like a part of the work ("Chapter 5: …", "Unit 3: …"); a section ("- 2") and a block ("(B)")
// after the class name are left out.
const NOT_A_CLASS = /^(chapter|chapters|ch\.?|unit|lesson|part|section|page|pages|pp?\.|week|day|quiz|test|exam|lab|hw|homework|reading|read|step|question|questions|problem|problems|task|project|essay|due|note|notes|draft)\b/i;
export function splitClass(summary: string): { subject: string | null; title: string } {
  const m = /^(.{2,60}?):\s+(\S.*)$/.exec(summary);
  if (!m) return { subject: null, title: summary };
  let subject = m[1].trim();
  if (NOT_A_CLASS.test(subject) || /^\d/.test(subject)) return { subject: null, title: summary };
  subject = subject.replace(/(\s*\([^)]{1,12}\))+\s*$/, '').replace(/\s+-\s+\S{1,6}$/, '').trim();
  if (subject.length < 2 || subject.length > 40) return { subject: null, title: summary };
  return { subject, title: m[2].trim() };
}
