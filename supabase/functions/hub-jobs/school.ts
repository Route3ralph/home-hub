// hub-jobs' school action: reads the school's Blackbaud calendar links (docs/v1.3-homework.md §11.3,
// §12). handler.ts checks who is asking (pg_cron's x-hub-cron header, or a parent's Check now) and
// that the service key is there, then calls runSchool. The rules live in the database: school_begin
// says what to read (and is the only reader of the addresses), school_store what to keep. This file
// fetches, parses (ical.ts) and hands the items over.
//
// One run: take the lease (school_begin), then for each link it hands over, while there is time (no
// fetch starts after RUN_BUDGET_MS): check the address again, fetch it (FETCH_MS for the whole read,
// redirects and body included; at most MAX_REDIRECTS redirects, each checked like the link; at most
// MAX_BYTES), parse it, keep what the hub uses (assignments due from today − 14 to today + 120 days,
// schedule and games items with a start from today to today + 55; then at most 400 assignments or
// 2,000 other items, else 'too_many') and store it, or store its stop (school_store; if school_store refuses
// the items, the read is stored again as 'error', with none); then end the run (school_finish). A link that
// fails doesn't stop the others. A run stopped partway (the Edge Function's limits) never reaches
// school_finish: the next school_begin marks the link it was reading as failed (school_sync.handed).
//
// Safety: the address works like a password. It is fetched only as https on port 443, from a host
// ending in SCHOOL_HOST.suffix, with no user info, and redirect: 'manual', so a redirect off those
// hosts (or to http, another port, user info) is refused, never followed. Nothing in this file logs,
// and no error text is ever stored or answered: Deno's fetch errors quote the whole address, z=
// included, so every fetch failure becomes a fixed code (unreachable, timeout, …), as google.ts does.
// util.ts's message() is never used here. Every database call uses the service-role client.

import { json, noSchema } from './util.ts';
import type { Deps } from './util.ts';
import { parseIcal, splitClass, addDays, cutText, unfoldBytes } from './ical.ts';
import type { IcalEvent } from './ical.ts';

// The hosts a school link may name: Blackbaud's. The tests replace it with a made-up one.
export const SCHOOL_HOST = { suffix: '.myschoolapp.com' };
// Limits. The tests shorten the fetch time.
export const SCHOOL_LIMITS = { fetchMs: 15000 };
export const RUN_BUDGET_MS = 30000;      // no fetch starts after this (pg_net waits 60 seconds)
export const MAX_REDIRECTS = 3;
export const MAX_BYTES = 3 * 1024 * 1024;
export const MAX_ASSIGNMENTS = 400;
export const MAX_BUSY = 2000;
export const ASSIGNMENT_WINDOW = { from: -14, to: 120 };   // days from today (the due date)
export const BUSY_WINDOW = { from: 0, to: 55 };            // days from today (the start)

// The fixed codes a read can end with (school_feeds.last_stop).
export type Stop = 'bad_link' | 'redirect' | 'unreachable' | 'timeout' | 'too_big' | 'refused' | 'gone' | 'down' | 'http'
  | 'sign_in' | 'not_calendar' | 'too_many' | 'error';

const NO_SCHEMA = 'The school feed needs the database update (migration 0006_homework_school.sql).';
const DB_STOP = (step: string) => `The run stopped with a database error (${step}).`;

// The address check (private.school_url in migration 0006 does the same): webcal:// becomes https://;
// https only; port 443 or none; no user info; a host of letters, digits, dots and hyphens ending in the
// suffix; for a pasted link the path /podium/feed/iCal.aspx (any case) and a z value; at most 500
// characters (2,000 for a redirect's Location), no spaces, control characters, quotes, backslashes or
// angle brackets. Answers the address to fetch, or null.
export function checkAddress(raw: unknown, opts: { redirect?: boolean } = {}): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > (opts.redirect ? 2000 : 500) || /[\s"<>\\\u0000-\u001f\u007f]/.test(s)) return null;
  s = s.replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\//i.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port !== '' && u.port !== '443')) return null;
  // The authority as written: no "@" (user info), only a host and an optional :443.
  const authority = s.slice(8).split(/[/?#]/)[0];
  if (authority.includes('@') || !/^[A-Za-z0-9.-]+(:443)?$/.test(authority)) return null;
  const host = u.hostname.toLowerCase();
  const suffix = SCHOOL_HOST.suffix.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
      || host.length <= suffix.length || !host.endsWith(suffix)) return null;
  if (!opts.redirect && (u.pathname.toLowerCase() !== '/podium/feed/ical.aspx' || !u.searchParams.get('z'))) return null;
  u.hash = '';
  return u.href;
}

type Fetched = { ok: true; text: string } | { ok: false; stop: Stop };

// The error a timed-out or aborted fetch throws, by its name only (never its message).
const timedOut = (err: unknown) => {
  const n = (err as { name?: string })?.name;
  return n === 'TimeoutError' || n === 'AbortError';
};

// One link's read. Never throws; every failure is a fixed code.
export async function fetchFeed(url: string, deps: Pick<Deps, 'fetch'>): Promise<Fetched> {
  const signal = AbortSignal.timeout(SCHOOL_LIMITS.fetchMs);
  let current = url;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await deps.fetch(current, {
        method: 'GET', redirect: 'manual', signal,
        headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1' },
      });
    } catch (err) {
      return { ok: false, stop: timedOut(err) || signal.aborted ? 'timeout' : 'unreachable' };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await drop(res);
      if (!loc || hop >= MAX_REDIRECTS) return { ok: false, stop: 'redirect' };
      let next: string;
      try { next = new URL(loc, current).href; } catch { return { ok: false, stop: 'redirect' }; }
      const checked = checkAddress(/^[a-z][a-z0-9+.-]*:/i.test(loc) ? loc : next, { redirect: true });
      if (!checked) return { ok: false, stop: 'redirect' };
      current = checked;
      continue;
    }
    if (res.status === 404 || res.status === 410) { await drop(res); return { ok: false, stop: 'gone' }; }
    if (res.status === 401 || res.status === 403) { await drop(res); return { ok: false, stop: 'refused' }; }
    if (res.status === 429 || res.status >= 500) { await drop(res); return { ok: false, stop: 'down' }; }
    if (res.status < 200 || res.status > 299) { await drop(res); return { ok: false, stop: 'http' }; }
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) { await drop(res); return { ok: false, stop: 'too_big' }; }
    return readBody(res, signal);
  }
}

async function drop(res: Response) {
  try { await res.body?.cancel(); } catch { /* nothing to read */ }
}

// The body, at most MAX_BYTES, unfolded on its bytes (a fold inside a character's UTF-8 bytes joins it whole,
// ical.ts's unfoldBytes), then as UTF-8 (a bad byte becomes U+FFFD).
async function readBody(res: Response, signal: AbortSignal): Promise<Fetched> {
  if (!res.body) return { ok: true, text: '' };
  const reader = res.body.getReader();
  const stopReading = () => { reader.cancel().catch(() => { /* gone */ }); };
  signal.addEventListener('abort', stopReading, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { ok: false, stop: 'timeout' };
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { stopReading(); return { ok: false, stop: 'too_big' }; }
      chunks.push(value);
    }
  } catch (err) {
    return { ok: false, stop: timedOut(err) || signal.aborted ? 'timeout' : 'unreachable' };
  } finally {
    signal.removeEventListener('abort', stopReading);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { ok: true, text: new TextDecoder('utf-8').decode(unfoldBytes(all)) };
}

// What school_store takes for one item.
type Item = Record<string, string | null>;

// The items the hub uses from one link's events (see the top of this file), or 'too_many'. Text is cut to what
// the database keeps by characters (cutText), never through the middle of an emoji.
export function keep(events: IcalEvent[], kind: string, today: string): Item[] | 'too_many' {
  const out: Item[] = [];
  if (kind === 'assignments') {
    // Any date rule and shift (§11.2 step 8) may make the due date either end of the span, a day either way.
    const from = addDays(today, ASSIGNMENT_WINDOW.from - 1);
    const to = addDays(today, ASSIGNMENT_WINDOW.to + 1);
    for (const e of events) {
      if (e.lastDay < from || e.firstDay > to) continue;
      const { subject, title } = splitClass(e.summary);
      if (!title) continue;
      out.push({ uid: e.uid, title: cutText(title, 120), subject: subject ? cutText(subject, 40) : null,
        details: e.description ? cutText(e.description, 4000) : null, first_day: e.firstDay, last_day: e.lastDay });
    }
    return out.length > MAX_ASSIGNMENTS ? 'too_many' : out;
  }
  const from = addDays(today, BUSY_WINDOW.from);
  const to = addDays(today, BUSY_WINDOW.to);
  for (const e of events) {
    if (e.allDay || !e.start || e.firstDay < from || e.firstDay > to || !e.summary) continue;
    out.push({ uid: e.uid, title: cutText(e.summary, 120), starts_at: e.start, ends_at: e.end });
  }
  return out.length > MAX_BUSY ? 'too_many' : out;
}

type Feed = { feed_id: string; kind: string; url: string };
type Tally = { read: number; stored: number; failed: number; skipped: number; items: number };

export async function runSchool(deps: Deps, opts: { force: boolean }): Promise<Response> {
  const now = () => (deps.now ? deps.now() : Date.now());
  const started = now();
  const db = deps.service();

  const begin = await db.rpc('school_begin', { p_force: opts.force });
  if (begin.error) {
    if (noSchema(begin.error)) return json(503, { ok: false, stop: 'no_schema', error: NO_SCHEMA });
    return json(500, { ok: false, stop: 'error', error: DB_STOP('school_begin') });
  }
  const lease = (begin.data ?? {}) as { go?: boolean; run_id?: string; today?: string; tz?: string; feeds?: Feed[] };
  if (!lease.go || !lease.run_id) return json(200, { ok: false, stop: 'busy' });
  const run = lease.run_id;
  const today = typeof lease.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(lease.today) ? lease.today : null;
  const tz = typeof lease.tz === 'string' && lease.tz ? lease.tz : 'America/New_York';
  const feeds = Array.isArray(lease.feeds) ? lease.feeds : [];

  const tally: Tally = { read: 0, stored: 0, failed: 0, skipped: 0, items: 0 };
  let stop: string | null = today ? null : 'error';
  for (const f of today ? feeds : []) {
    if (now() - started >= RUN_BUDGET_MS) { tally.skipped++; continue; }   // still due: the next run reads it
    let itemStop: Stop | null = null;
    let items: Item[] = [];
    let repeats = 0;
    try {
      const url = checkAddress(f?.url);
      if (!url) itemStop = 'bad_link';
      else {
        tally.read++;
        const got = await fetchFeed(url, deps);
        if (!got.ok) itemStop = got.stop;
        else {
          const parsed = parseIcal(got.text, tz);
          if (parsed.kind !== 'calendar') itemStop = parsed.kind;
          else {
            const kept = keep(parsed.events, String(f.kind), today!);
            if (kept === 'too_many') itemStop = 'too_many';
            else { items = kept; repeats = parsed.repeats; }
          }
        }
      }
    } catch {
      itemStop = 'error';   // never the error's own words
    }
    let r = await db.rpc('school_store', {
      p_run: run, p_feed: f?.feed_id ?? null, p_items: itemStop ? [] : items, p_stop: itemStop, p_repeats: repeats,
    });
    // The items refused (PostgREST or the database answered an error): still store this link's read as a failed
    // one, a fixed code with no items, so it backs off and the status card says so, rather than being due again
    // every hour with nothing recorded.
    if (r.error && !itemStop) {
      r = await db.rpc('school_store', { p_run: run, p_feed: f?.feed_id ?? null, p_items: [], p_stop: 'error', p_repeats: 0 });
    }
    if (r.error) { stop = 'error'; tally.failed++; continue; }
    const out = (r.data ?? {}) as { stored?: boolean; stop?: string; kept?: number };
    if (out.stored) { tally.stored++; tally.items += typeof out.kept === 'number' ? out.kept : 0; }
    else {
      tally.failed++;
      if (out.stop === 'late') { stop = 'late'; break; }   // the lease ran out: stop reading
    }
  }
  const fin = await db.rpc('school_finish', { p_run: run });
  if (fin.error) return json(500, { ok: false, ...tally, stop: 'error', error: DB_STOP('school_finish') });
  if (stop === 'error') return json(500, { ok: false, ...tally, stop, error: DB_STOP('school_store') });
  return json(200, { ok: stop === null && tally.failed === 0, ...tally, stop });
}
