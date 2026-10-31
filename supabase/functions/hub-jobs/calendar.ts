// hub-jobs' Google Calendar actions (docs/v1.1-google-calendar.md §3.4–§3.6, §5.1–§5.2, §6.5).
// handler.ts checks who is asking and that the service key is there, then calls these. The rules
// live in the database: calendar_read_due says what to read, calendar_store_events what to keep and
// what to put back, calendar_plan what to write. This file only talks to Google and reports back.
//
//   calendar       pg_cron every 5 minutes (x-hub-cron), or an admin's Sync now (which also reads every
//                  calendar). One run: take the lease (calendar_begin), sign in, read the calendars that
//                  are due (20 seconds at most: no read call outlives them, and one that times out isn't
//                  tried again, so a calendar that hangs can't hold up the writes), write what
//                  calendar_plan says (60 at most), record Google's answers 20 at a time
//                  (calendar_record), and end the run (calendar_finish). No Google call starts after
//                  30 seconds, so a run and its last call's 15-second timeout end inside pg_net's 60
//                  seconds; what's left goes in the next run.
//   calendar_test  an admin's Test on one calendar { calendar_id }: its Google name and the access role
//                  the hub has there; on a calendar the hub writes whose name and role pass, add an event,
//                  delete it, bring it back, read it and delete it again (gate 2). Recorded with calendar_mark.
//
// Every database call here uses the service-role client (deps.service()). Nothing is logged. A run's
// stop is stored with a fixed message (calendar_sync.last_error, which members can read, and pg_net's
// log): never the key, a token, Google's replies or the database's own error text. A calendar's
// status_detail is a fixed message and at most Google's reason; only a single item's error (admins
// only) keeps Google's one-line message, cleaned (google.ts).

import { json, isUuid, noSchema } from './util.ts';
import type { Db, Deps } from './util.ts';
import { siteBase } from './render.ts';
import {
  google, readServiceAccount, eventsPath, classify, runStop, linkError, contentHash, GoogleStop,
} from './google.ts';
import type { Google, GResult, ServiceAccount } from './google.ts';

export const RUN_BUDGET_MS = 30000;   // no Google call starts after this
export const READ_BUDGET_MS = 20000;  // no calendar starts being read after this
export const READ_LIMIT = 10;         // calendars read per run
export const PAGES_MAX = 4;           // pages of one calendar's events per read
export const SEND_MAX = 2500;         // events of one calendar sent to calendar_store_events (it keeps 1,000)
export const PLAN_LIMIT = 60;         // writes per run
export const RECORD_BATCH = 20;       // results per calendar_record
export const REACHABLE_MS = 10 * 60000;
export const READ_FIELDS = 'accessRole,summary,nextPageToken,items(id,status,summary,location,start,end,visibility,'
  + 'recurringEventId,updated,organizer/self,attendees(self,responseStatus),extendedProperties/private)';
// A calendar sorted by Hearth person (calendar_read_due's sort_by_guest, migration 0010): the guests' addresses too,
// so the Hearth profiles on each event can be kept (docs/v1.1-google-calendar.md §11.3). Every other calendar is read
// with READ_FIELDS: no address is asked for. maxAttendees is never sent (with it, Google answers a longer guest list
// with only the calendar's own entry).
export const READ_FIELDS_GUESTS = READ_FIELDS.replace('attendees(self,responseStatus)', 'attendees(email,self,responseStatus)');
// A Hearth profile's guest address ("<profile>@team-<family>-<digits>", no dot after the @): the pattern of
// private.hearth_tag(p_email) in migration 0010.
export const HEARTH_TAG = /^[a-z0-9._+-]{1,64}@team-[a-z0-9-]{1,120}$/;
const TAGS_READ = 100;   // guest entries looked at per event
const TAGS_KEPT = 16;    // tags kept per event (google_events.guests holds at most 16)

const NO_SCHEMA = 'Google Calendar needs the database update (migration 0003_google_calendar.sql).';
const UNEXPECTED = 'Google answered differently than expected: tell Claude.';
const NO_ANSWER = "Google didn't answer. Try again in a minute.";
// The sharing options are named as Google Calendar names them: "See event details", "Make changes and
// see event details", "Make changes and manage sharing", and "Make changes (see private events as
// free/busy)", whose access role is writerWithoutPrivateAccess.
const NAME_RULE = "This calendar isn't named 'Hub …'. The hub writes only to calendars whose name starts with Hub. If it is the right one, rename it in Google.";
const OWNER_ROLE = 'Share it with Make changes and see event details, not Make changes and manage sharing.';
const NO_PRIVATE_ROLE = 'writerWithoutPrivateAccess';
const noPrivate = (account: string) => `Shared with 'Make changes (see private events as free/busy)': Home Hub can't change its private items there. Share it with ${account} and choose Make changes and see event details.`;
const canChange = (account: string) => `Home Hub can't change this calendar. In Google Calendar, share it with ${account} and choose Make changes and see event details.`;
const canRead = (account: string) => `Home Hub can't read this calendar. In Google Calendar, share it with ${account} and choose See event details.`;
const notFound = (account: string) => `No calendar with this ID, or it isn't shared with ${account}.`;
// Gate 2 failing (docs/v1.1 §1.2): Google says the hub may change the calendar, yet refuses to.
const WONT_WRITE = "Shared correctly, but Google won't let Home Hub add an event to it: tell Claude.";
// A refusal that isn't about sharing (another 403, a 400): a fixed message and Google's reason.
const refused = (r: GResult) => {
  const reason = r.reasons.find((x) => /^[A-Za-z_]{1,60}$/.test(x) && !/^[A-Z_]+$/.test(x)) ?? r.reasons.find((x) => /^[A-Za-z_]{1,60}$/.test(x));
  return `Google refused to use this calendar (${r.status}${reason ? ` ${reason}` : ''}).`;
};

// A database error stops the run with a fixed message naming the step (§6.4), never the
// database's own words.
class DbError extends Error {
  constructor(step: string) {
    super(`The run stopped with a database error (${step}).`);
  }
}
const UNEXPECTED_STOP = 'The run stopped with an unexpected error.';

// The key, read with a literal deps.env (the docs check finds the secrets hub-jobs reads that way).
const serviceAccount = (deps: Deps) => readServiceAccount(deps.env('GOOGLE_SA_JSON'));

// The calendar's status from its Google name and the hub's access role, by the rules a read uses
// (private.calendar_status in migration 0003, which calendar_mark applies again): a calendar the hub
// only reads needs reader or better (writerWithoutPrivateAccess reads too); one it writes needs a
// name starting with "Hub" and writer (writerWithoutPrivateAccess can't change the hub's private items).
export function verdict(writes: boolean, name: unknown, role: unknown, account: string): { status: 'ok' | 'no_access' | 'error'; message: string | null } {
  const r = String(role ?? '');
  if (!writes) return ['reader', NO_PRIVATE_ROLE, 'writer', 'owner'].includes(r) ? { status: 'ok', message: null } : { status: 'no_access', message: canRead(account) };
  if (!/^hub/i.test(String(name ?? '').trim())) return { status: 'error', message: NAME_RULE };
  if (r === 'writer') return { status: 'ok', message: null };
  if (r === 'owner') return { status: 'error', message: OWNER_ROLE };
  if (r === NO_PRIVATE_ROLE) return { status: 'no_access', message: noPrivate(account) };
  return { status: 'no_access', message: canChange(account) };
}
// The answers that mean an event id is taken on this calendar by an event the hub can't write there:
// someone moved the hub's event to another calendar in Google, which leaves a cancelled copy behind
// that belongs to the other calendar (an update then gets 403 forbiddenForNonOrganizer, or 404).
const nonOrganizer = (r: GResult) => r.status === 403 && r.reasons.includes('forbiddenForNonOrganizer');
const takenElsewhere = (r: GResult) => ['missing', 'no_access', 'forbidden'].includes(classify(r));

// The Hearth tags among an event's guests (§11.3): of the first 100 entries, not the calendar's own (self), each email
// that is a string, trimmed and lowercased, kept only if it is shaped like a Hearth tag; each once, sorted, the first
// 16. Nothing is rewritten into a tag: an address is kept exactly as lowercased, or dropped, so a guest's real address,
// the family's own, a room's or the calendar's never leaves this function.
export function hearthTags(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const tags = new Set<string>();
  for (const a of list.slice(0, TAGS_READ)) {
    if (!a || typeof a !== 'object' || (a as any).self === true || typeof (a as any).email !== 'string') continue;
    const t = (a as any).email.trim().toLowerCase();
    if (HEARTH_TAG.test(t)) tags.add(t);
  }
  return [...tags].sort().slice(0, TAGS_KEPT);
}

// One Google event as calendar_store_events takes it (§5.1): it keeps no email address, description
// or attendee other than the calendar's own answer, but a sorted calendar's Hearth tags (guests: hearthTags, on every
// event of a read that asked Google for guests, [] for one with none; never on the hub's own, p_seen).
type Item = Record<string, unknown>;
async function storeItem(it: any, guests = false): Promise<Item> {
  const when = (t: any) => (t && typeof t === 'object'
    ? (t.date != null ? { date: String(t.date) } : t.dateTime != null ? { dateTime: String(t.dateTime) } : null)
    : null);
  const mine = Array.isArray(it.attendees) ? it.attendees.find((a: any) => a && a.self === true) : null;
  const props = it.extendedProperties?.private;
  return {
    id: it.id == null ? null : String(it.id),
    status: it.status ?? null,
    title: it.summary ?? '',
    location: it.location ?? null,
    start: when(it.start),
    end: when(it.end),
    visibility: it.visibility ?? 'default',
    recurring: !!it.recurringEventId,
    updated: it.updated ?? null,
    organizer_self: it.organizer?.self === true,
    response: mine?.responseStatus ?? null,
    props: props && typeof props === 'object' && !Array.isArray(props) ? props : null,
    hash: await contentHash(it),
    ...(guests ? { guests: hearthTags(it.attendees) } : {}),
  };
}
// The hub's own events: marked homehub, with an id the hub chose.
const isHubEvent = (it: any) => it?.extendedProperties?.private?.homehub != null && /^hh[0-9a-f]{32}$/.test(String(it?.id ?? ''));

const rfc3339 = (s: unknown) => {
  const ms = Date.parse(String(s ?? ''));
  return Number.isNaN(ms) ? String(s ?? '') : new Date(ms).toISOString();
};

// ---------------------------------------------------------------------
// calendar: one run of the reconciler
// ---------------------------------------------------------------------
type Tally = {
  read: number; stored: number; skipped: number; repaired: number; adopted: number;
  inserted: number; updated: number; deleted: number; failed: number; pending: number | null; hiding: number | null;
};
type PlanRow = {
  op: 'insert' | 'update' | 'delete'; calendar_id: string | null; google_calendar: string; base_id: string; event_id: string;
  gen: number; item_kind: string; item_id: string | null; job_id: string | null; occurrence: string | null; part: string;
  day: string; end_day: string; title: string; body: any; hash: string | null; pending: number; hiding: number;
};
type Probe = { seen: 'ok' | 'gone' | 'unknown'; role: string | null; why: string | null };
type Outcome = {
  ok: boolean; gone: boolean; clash: boolean; forget: boolean;
  google_hash: string | null; google_updated: string | null; http: number | null; error: string | null;
};

export async function runCalendar(deps: Deps, opts: { force: boolean }): Promise<Response> {
  const now = () => (deps.now ? deps.now() : Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = now();
  const db = deps.service();

  const begin = await db.rpc('calendar_begin');
  if (begin.error) {
    if (noSchema(begin.error)) return json(503, { ok: false, stop: 'no_schema', error: NO_SCHEMA });
    return json(500, { ok: false, stop: 'error', error: new DbError('calendar_begin').message });
  }
  const lease = (begin.data ?? {}) as { go?: boolean; stop?: string; run_id?: string };
  if (!lease.go || !lease.run_id) return json(200, { ok: false, stop: lease.stop === 'paused' ? 'paused' : 'busy' });
  const run = lease.run_id;

  const tally: Tally = { read: 0, stored: 0, skipped: 0, repaired: 0, adopted: 0, inserted: 0, updated: 0, deleted: 0, failed: 0, pending: null, hiding: null };
  let stop: string | null = null;
  let error: string | null = null;

  const sa = serviceAccount(deps);
  if ('stop' in sa) {
    stop = sa.stop;
    error = sa.error;
  } else {
    const g = google(sa.key, { fetch: deps.fetch, now, sleep, deadline: started + RUN_BUDGET_MS });
    try {
      await g.token();
      const signed = await db.rpc('calendar_signed_in', { p_run: run, p_auth: 'service_account', p_account: sa.key.client_email, p_key_id: sa.key.private_key_id });
      if (signed.error) throw new DbError('calendar_signed_in');
      const job = new Job(db, g, sa.key, tally, now, started);
      stop = await job.read(opts.force);
      if (stop === null || stop === 'time') await job.write(siteBase(deps.env('SITE_URL')), stop === 'time');
    } catch (err) {
      if (err instanceof GoogleStop) {
        stop = err.code;
        error = err.message || null;
      } else {
        stop = 'error';
        error = err instanceof DbError ? err.message : UNEXPECTED_STOP;
      }
    }
  }

  const fin = await db.rpc('calendar_finish', { p_run: run, p_result: tally, p_stop: stop, p_error: error });
  if (fin.error) return json(500, { ok: false, ...tally, stop: stop ?? 'error', error: new DbError('calendar_finish').message });
  // pg_net's log shows the run-level failures, as it does for digest.
  const failed = stop === 'auth' || stop === 'config' || stop === 'error';
  return json(failed ? 500 : 200, { ok: stop === null || stop === 'time', ...tally, stop, error });
}

// One run's reads and writes. Stops that end the run (slow_down, config, auth, a database error)
// are thrown; 'time' is returned by read() and ends write().
class Job {
  db: Db;
  g: Google;
  key: ServiceAccount;
  tally: Tally;
  now: () => number;
  started: number;
  reachable = new Set<string>();     // Google calendars a read or write succeeded on in this run
  dropped = new Set<string>();       // calendars in use found unreachable: their other writes wait
  probed = new Map<string, Probe>(); // what each calendar's probe said
  known: Map<string, { id: string; writes: boolean; status: string; checked_at: string | null }> | null = null;

  constructor(db: Db, g: Google, key: ServiceAccount, tally: Tally, now: () => number, started: number) {
    this.db = db;
    this.g = g;
    this.key = key;
    this.tally = tally;
    this.now = now;
    this.started = started;
  }

  timeUp(budget = RUN_BUDGET_MS) {
    return this.now() - this.started >= budget;
  }

  // A database answer's data; an error stops the run (stop 'error').
  need(fn: string, result: { data: any; error: any }) {
    if (result.error) throw new DbError(fn);
    return result.data;
  }

  // -------------------------------------------------------------------
  // Read (§5.1): every calendar that is due, while there is time. Reads end by READ_BUDGET_MS: no read
  // call outlives it (google.ts cuts its timeout, and doesn't try a timed-out read again), so the
  // writes, privacy first, always get the rest of the run. Running out of read time stops the reads,
  // not the run.
  // -------------------------------------------------------------------
  async read(force: boolean): Promise<string | null> {
    const due = this.need('calendar_read_due', await this.db.rpc('calendar_read_due', { p_force: force, p_limit: READ_LIMIT }));
    for (const c of Array.isArray(due) ? due : []) {
      if (this.timeUp(READ_BUDGET_MS)) break;
      try {
        await this.readOne(c);
      } catch (err) {
        if (err instanceof GoogleStop && err.code === 'time') break;
        throw err;
      }
    }
    return this.timeUp() ? 'time' : null;
  }

  async readOne(c: { calendar_id: string; google_id: string; writes: boolean; w_from: string; w_to: string; time_min: string; time_max: string; tz: string;
    sort_by_guest?: boolean }) {
    // Sorted by Hearth person (0010): guest addresses are asked for, and only the Hearth tags among them are sent. On
    // schema 9 calendar_read_due has no sort_by_guest, so no address is asked for.
    const sorted = c.sort_by_guest === true;
    const items: any[] = [];
    let name: string | null = null;
    let access: string | null = null;
    let complete = true;
    let page: string | undefined;
    let late: GoogleStop | null = null;
    for (let n = 0; ; n++) {
      if (n >= PAGES_MAX) { complete = false; break; }
      let r: GResult;
      try {
        if (this.timeUp(READ_BUDGET_MS)) throw new GoogleStop('time', '');
        r = await this.g.gcal('GET', eventsPath(c.google_id), {
          query: {
            singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: 2500, eventTypes: 'default',
            timeMin: rfc3339(c.time_min), timeMax: rfc3339(c.time_max), timeZone: c.tz, fields: sorted ? READ_FIELDS_GUESTS : READ_FIELDS, pageToken: page,
          },
          until: this.started + READ_BUDGET_MS,
        });
      } catch (err) {
        // Out of time between pages: what was read is kept as a cut-off read.
        if (err instanceof GoogleStop && err.code === 'time' && n > 0) { late = err; complete = false; break; }
        throw err;
      }
      const a = classify(r);
      if (a !== 'ok') {
        const s = runStop(a);
        if (s) throw s;
        // Nothing is stored: the cache and read_at stay as they were.
        if (a === 'no_access' || a === 'missing') {
          const why = a === 'missing' ? notFound(this.key.client_email) : c.writes ? canChange(this.key.client_email) : canRead(this.key.client_email);
          await this.mark(c.calendar_id, c.google_id, 'no_access', why);
        } else if (a === 'forbidden' || a === 'bad' || a === 'conflict') {
          await this.mark(c.calendar_id, c.google_id, 'error', refused(r));
        }
        return;   // 'down': tried again on a later run; a glitch never changes a calendar's status
      }
      if (n === 0) {
        name = typeof r.data?.summary === 'string' ? r.data.summary : null;
        access = typeof r.data?.accessRole === 'string' ? r.data.accessRole : null;
      }
      if (Array.isArray(r.data?.items)) items.push(...r.data.items);
      page = typeof r.data?.nextPageToken === 'string' && r.data.nextPageToken ? r.data.nextPageToken : undefined;
      if (!page) break;
    }
    this.reachable.add(c.google_id);

    const events: Item[] = [];
    const seen: Item[] = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      if (isHubEvent(it)) seen.push(await storeItem(it));
      else if (events.length < SEND_MAX) events.push(await storeItem(it, sorted));
      else complete = false;
    }
    const out = this.need('calendar_store_events', await this.db.rpc('calendar_store_events', {
      p_calendar: c.calendar_id, p_google_id: c.google_id, p_from: c.w_from, p_to: c.w_to, p_name: name, p_access: access,
      p_complete: complete, p_events: events, p_seen: seen,
    }));
    const num = (k: string) => (typeof out?.[k] === 'number' ? out[k] : 0);
    this.tally.read++;
    this.tally.stored += num('kept');
    this.tally.skipped += num('skipped');
    this.tally.repaired += num('repaired');
    this.tally.adopted += num('adopted');
    if (late) throw late;
  }

  async mark(calendar: string | null, googleId: string, status: string, detail: string | null, name: string | null = null, access: string | null = null) {
    if (!calendar) return;
    this.need('calendar_mark', await this.db.rpc('calendar_mark', {
      p_calendar: calendar, p_google_id: googleId, p_status: status, p_detail: detail, p_name: name, p_access: access,
    }));
  }

  // -------------------------------------------------------------------
  // Write (§3.3, §3.5): the plan's ops in its order, recorded 20 at a time.
  // -------------------------------------------------------------------
  async write(site: string | null, outOfTime: boolean) {
    const plan = this.need('calendar_plan', await this.db.rpc('calendar_plan', { p_site: site, p_limit: PLAN_LIMIT }));
    const rows: PlanRow[] = Array.isArray(plan) ? plan : [];
    let pending = rows.length ? Number(rows[0].pending) || 0 : 0;
    let hiding = rows.length ? Number(rows[0].hiding) || 0 : 0;
    const results: (PlanRow & Outcome)[] = [];
    const flush = async () => {
      if (!results.length) return;
      const batch = results.splice(0, results.length);
      this.need('calendar_record', await this.db.rpc('calendar_record', { p_results: batch }));
    };

    let stopped: unknown = outOfTime ? new GoogleStop('time', '') : null;
    if (!stopped) {
      try {
        for (const row of rows) {
          if (this.timeUp()) throw new GoogleStop('time', '');
          if (this.dropped.has(row.google_calendar)) continue;
          const out = await this.writeOne(row);
          results.push({ ...row, ...out });
          if (out.ok || out.gone) {
            if (row.op === 'insert') this.tally.inserted++;
            else if (row.op === 'update') this.tally.updated++;
            else this.tally.deleted++;
            pending--;
            // What calendar_plan counts as hiding: deletes, and updates that make an item private.
            if (row.op === 'delete' || (row.op === 'update' && row.body?.visibility === 'private')) hiding--;
          } else if (!out.clash) {
            this.tally.failed++;
          }
          if (results.length >= RECORD_BATCH) await flush();
        }
      } catch (err) {
        stopped = err;
      }
    }
    this.tally.pending = Math.max(pending, 0);
    this.tally.hiding = Math.max(hiding, 0);
    // What Google already answered is recorded whatever stopped the run.
    await flush();
    if (stopped) throw stopped;
  }

  // One op: at most three calls (the probe included). A stop is thrown, and the op isn't recorded:
  // the next plan has it again, with the same ids.
  async writeOne(row: PlanRow): Promise<Outcome> {
    const one = eventsPath(row.google_calendar, row.event_id);
    const all = eventsPath(row.google_calendar);
    const q = { sendUpdates: 'none' };
    const done = async (r: GResult): Promise<Outcome> => {
      this.reachable.add(row.google_calendar);
      return {
        ok: true, gone: false, clash: false, forget: false, http: r.status,
        google_hash: row.op === 'delete' ? null : await contentHash(r.data),
        google_updated: row.op === 'delete' || typeof r.data?.updated !== 'string' ? null : r.data.updated,
        error: null,
      };
    };
    const outcome = (r: GResult, extra: Partial<Outcome>): Outcome => ({
      ok: false, gone: false, clash: false, forget: false, google_hash: null, google_updated: null, http: r.status || null, error: null, ...extra,
    });

    if (row.op === 'insert') {
      let r = await this.g.gcal('POST', all, { query: q, body: row.body });
      if (classify(r) === 'ok') return done(r);
      if (classify(r) === 'conflict') {
        // The id exists: written before (a lost reply), or deleted in Google, which keeps deleted ids.
        r = await this.g.gcal('PUT', one, { query: q, body: row.body });
        if (classify(r) === 'ok') return done(r);
        // Taken, but not by an event the hub can write here (moved to another calendar in Google): a
        // new id next time. The POST's 409 already says the hub may write to this calendar.
        if (takenElsewhere(r)) return outcome(r, { clash: true });
      }
      return this.failed(row, r);
    }

    if (row.op === 'update') {
      let r = await this.g.gcal('PUT', one, { query: q, body: row.body });
      if (classify(r) === 'ok') return done(r);
      if (nonOrganizer(r)) return outcome(r, { clash: true });
      if (classify(r) === 'missing' && await this.reach(row)) {
        r = await this.g.gcal('POST', all, { query: q, body: row.body });
        if (classify(r) === 'ok') return done(r);
        if (classify(r) === 'conflict') return outcome(r, { clash: true });
      }
      return this.failed(row, r);
    }

    const r = await this.g.gcal('DELETE', one, { query: q });
    if (classify(r) === 'ok') return done(r);
    if (classify(r) === 'missing' && await this.reach(row)) return { ...outcome(r, {}), gone: true };
    return this.failed(row, r);
  }

  // A failed op: run-level answers stop the run; a calendar that can't be reached (or written) is
  // marked no_access (and its other writes wait); anything else is an error on this link, with backoff.
  // One event's 403 or 404 doesn't say that about the calendar: the probe decides (once per calendar
  // and run), and only a refusal of the calendar itself, or an access role that can't write, counts.
  // forget: the calendar itself can't be reached (calendar_record forgets a gone mapping's link then).
  async failed(row: PlanRow, r: GResult): Promise<Outcome> {
    const a = classify(r);
    const s = runStop(a);
    if (s) throw s;
    const base = { ok: false, gone: false, clash: false, forget: false, google_hash: null, google_updated: null, http: r.status || null };
    if (a === 'no_access' || (a === 'missing' && !this.reachable.has(row.google_calendar))) {
      const p = await this.probe(row);
      if (p.seen === 'gone') return { ...base, forget: true, error: p.why };
      if (a === 'no_access' && p.seen === 'ok' && p.role !== 'writer' && p.role !== 'owner') {
        const why = p.role === NO_PRIVATE_ROLE ? noPrivate(this.key.client_email) : canChange(this.key.client_email);
        await this.unreachable(row, why);
        return { ...base, forget: true, error: why };
      }
    }
    return { ...base, error: linkError(r) };
  }

  // The calendars rows, by Google ID, read once a run when first needed (with the service-role client).
  async calendars() {
    if (!this.known) {
      const { data, error } = await this.db.from('calendars').select('id, google_id, writes, status, checked_at');
      if (error) throw new DbError('calendars');
      this.known = new Map(((data || []) as { id: string; google_id: string; writes: boolean; status: string; checked_at: string | null }[]).map((c) => [c.google_id, c]));
    }
    return this.known;
  }

  // Whether a plan row's calendar is in use: a calendars row with its id, at its Google ID, that the
  // hub writes. Otherwise its deletes are leftovers (Disconnect, a new Google ID, switched to
  // read-only), and a refusal there says nothing about a calendar the hub uses.
  async inUse(row: PlanRow): Promise<boolean> {
    if (!row.calendar_id) return false;
    const k = (await this.calendars()).get(row.google_calendar);
    return !!k && k.id === row.calendar_id && k.writes === true;
  }

  // "The calendar is reachable": a read or write on it succeeded in this run, or it was ok and
  // checked in the last 10 minutes. Otherwise the probe decides. A 404 or 410 on an event is only
  // taken as "the event is gone" on a reachable calendar.
  async reach(row: PlanRow): Promise<boolean> {
    if (this.reachable.has(row.google_calendar)) return true;
    if (this.dropped.has(row.google_calendar)) return false;
    const k = (await this.calendars()).get(row.google_calendar);
    if (k && k.status === 'ok' && k.checked_at && this.now() - Date.parse(k.checked_at) < REACHABLE_MS) return true;
    return (await this.probe(row)).seen === 'ok';
  }

  // GET …/events?maxResults=1&fields=accessRole: 200 → reachable, with the hub's access role there;
  // 403 or 404 → the calendar can't be reached (no_access); anything else → don't know (the link stays
  // in error, with its backoff).
  async probe(row: PlanRow): Promise<Probe> {
    const before = this.probed.get(row.google_calendar);
    if (before) return before;
    const r = await this.g.gcal('GET', eventsPath(row.google_calendar), { query: { maxResults: 1, fields: 'accessRole' } });
    const a = classify(r);
    const s = runStop(a);
    if (s) throw s;
    let p: Probe = { seen: 'unknown', role: null, why: null };
    if (a === 'ok') {
      this.reachable.add(row.google_calendar);
      p = { seen: 'ok', role: typeof r.data?.accessRole === 'string' ? r.data.accessRole : null, why: null };
    } else if (a === 'no_access' || a === 'missing' || a === 'forbidden') {
      p = { seen: 'gone', role: null, why: a === 'missing' ? notFound(this.key.client_email) : canChange(this.key.client_email) };
      await this.unreachable(row, p.why!);
    }
    this.probed.set(row.google_calendar, p);
    return p;
  }

  // A calendar in use that can't be reached or written: marked no_access, and its other writes wait.
  // A leftover's calendar isn't marked (it may be one the hub now only reads), and its other
  // leftovers are still tried, so each is forgotten in this run.
  async unreachable(row: PlanRow, why: string) {
    if (!(await this.inUse(row))) return;
    this.dropped.add(row.google_calendar);
    await this.mark(row.calendar_id, row.google_calendar, 'no_access', why);
  }
}

// ---------------------------------------------------------------------
// calendar_test: an admin's Test on one calendar (§6.5)
// ---------------------------------------------------------------------
type Step = { step: string; ok: boolean; http: number | null };

export async function testCalendar(body: Record<string, unknown>, deps: Deps): Promise<Response> {
  if (!isUuid(body.calendar_id)) return json(400, { error: "calendar_id must be a calendar's id." });
  const db = deps.service();
  const { data: cal, error } = await db.from('calendars').select('id, google_id, writes, status').eq('id', body.calendar_id).maybeSingle();
  if (error) {
    if (noSchema(error)) return json(503, { ok: false, stop: 'no_schema', error: NO_SCHEMA });
    return json(500, { ok: false, stop: 'error', error: new DbError('calendars').message });
  }
  if (!cal) return json(400, { error: 'No calendar with that id.' });

  const steps: Step[] = [];
  let name: string | null = null;
  let role: string | null = null;
  const answer = (ok: boolean, status: string, msg: string | null, stop: string | null = null) =>
    json(200, { ok, status, message: msg, name, role, steps, ...(stop ? { stop } : {}) });

  const sa = serviceAccount(deps);
  if ('stop' in sa) return answer(false, cal.status, sa.error, sa.stop);
  const account = sa.key.client_email;
  const now = () => (deps.now ? deps.now() : Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const g = google(sa.key, { fetch: deps.fetch, now, sleep });
  const mark = async (status: string, detail: string | null) => {
    const r = await db.rpc('calendar_mark', { p_calendar: cal.id, p_google_id: cal.google_id, p_status: status, p_detail: detail, p_name: name, p_access: role });
    if (r.error) throw new DbError('calendar_mark');
  };
  const step = (label: string, r: GResult, want: number[]) => {
    const ok = want.includes(r.status);
    steps.push({ step: label, ok, http: r.status || null });
    return ok;
  };

  try {
    // 1. List one event: the calendar's Google name and the hub's access role.
    const list = await g.gcal('GET', eventsPath(cal.google_id), { query: { maxResults: 1, fields: 'summary,accessRole' } });
    if (!step('list', list, [200])) {
      const a = classify(list);
      const s = runStop(a);
      if (s) return answer(false, cal.status, s.message, s.code);
      if (a === 'no_access' || a === 'missing' || a === 'forbidden') {
        const why = a === 'missing' ? notFound(account) : cal.writes ? canChange(account) : canRead(account);
        await mark('no_access', why);
        return answer(false, 'no_access', why);
      }
      if (a === 'down') return answer(false, cal.status, NO_ANSWER);
      await mark('error', refused(list));
      return answer(false, 'error', refused(list));
    }
    name = typeof list.data?.summary === 'string' ? list.data.summary : null;
    role = typeof list.data?.accessRole === 'string' ? list.data.accessRole : null;
    const v = verdict(!!cal.writes, name, role, account);
    if (v.status !== 'ok') {
      await mark(v.status, v.message);
      return answer(false, v.status, v.message);
    }
    if (!cal.writes) {
      await mark('ok', null);
      return answer(true, 'ok', 'Home Hub can read this calendar.');
    }

    // 2. Gate 2, on a calendar the hub writes: add an event on 2001-01-01 (no wall or phone shows it),
    //    delete it, PUT it back (a deleted event comes back), read it and compare, delete it again.
    const id = `hhtest${randomHex(8)}`;
    const one = eventsPath(cal.google_id, id);
    const q = { sendUpdates: 'none' };
    const event = {
      id, status: 'confirmed', summary: 'Home Hub test', description: 'Made by Home Hub to check it can write here. It is deleted at once.',
      start: { date: '2001-01-01' }, end: { date: '2001-01-02' }, transparency: 'transparent', visibility: 'private',
    };
    const added = await g.gcal('POST', eventsPath(cal.google_id), { query: q, body: event });
    if (!step('insert', added, [200])) {
      const a = classify(added);
      const s = runStop(a);
      if (s) return answer(false, cal.status, s.message, s.code);
      if (a === 'no_access' || a === 'missing' || a === 'forbidden') {
        // Listed with the writer role, yet refused: gate 2 has failed (the sharing isn't the problem).
        const why = a === 'missing' ? notFound(account) : role === 'writer' ? WONT_WRITE : canChange(account);
        await mark('no_access', why);
        return answer(false, 'no_access', why);
      }
      await mark('ok', null);
      return answer(false, 'ok', a === 'down' ? NO_ANSWER : linkError(added));
    }
    let there = true;
    let same = false;
    const del = await g.gcal('DELETE', one, { query: q });
    if (step('delete', del, [200, 204])) {
      there = false;
      const put = await g.gcal('PUT', one, { query: q, body: event });
      if (step('restore', put, [200])) {
        there = true;
        const got = await g.gcal('GET', one);
        if (step('read', got, [200])) {
          same = (await contentHash(got.data)) === (await contentHash(put.data));
          steps.push({ step: 'compare', ok: same, http: null });
        }
      }
    }
    if (there) {
      const gone = await g.gcal('DELETE', one, { query: q });
      step('cleanup', gone, [200, 204]);
    }
    await mark('ok', null);
    const ok = steps.every((s) => s.ok) && same;
    return answer(ok, 'ok', ok ? 'Home Hub can write to this calendar.' : UNEXPECTED);
  } catch (err) {
    if (err instanceof GoogleStop) return answer(false, cal.status, err.message, err.code);
    return json(500, { ok: false, stop: 'error', error: err instanceof DbError ? err.message : UNEXPECTED_STOP, name, role, steps });
  }
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
