// hub-jobs: Home Hub's morning email, its Google Calendar copy, the school feed and the AI planner. One Edge Function, deployed
// with verify_jwt off; each action checks who is asking itself. Kept free of outside imports so it
// can be tested in Node; index.ts wires it up. (send-email is a separate function, unchanged.)
//
// POST JSON { action }:
//   digest   pg_cron (supabase/cron.sql) every 15 minutes, with the header x-hub-cron: <HUB_CRON_SECRET>.
//            Rolls missed tasks forward, then for each email that is due (digest_due): checks the
//            daily budget, claims it, renders it (digest_for, or a confirmation email), sends it
//            with Resend and records the result (finish_notification). Writes a job_runs row, then
//            pings HEALTHCHECK_URL when the run went well (everything due went out), and
//            HEALTHCHECK_URL + "/fail" (healthchecks.io's failure signal) when it didn't: an email
//            failed, the daily budget ran out, or the run stopped. Any other body is ignored.
//            A request without an action is a digest request, so a bare POST answers 401.
//            Who can sign in (the members table) decides the links: the hub for them, My day
//            for everyone else (render.ts). A confirmation email goes once, plus at most one
//            reminder, per address (CONFIRM_MAX; digest_due offers no more either).
//   preview  admins (their own sign-in): { date?: 'YYYY-MM-DD', person_id?: uuid } → the rendered
//            emails, one per person, without sending or logging anything.
//   status   admins: the last 10 runs and today's emails, as counts and fixed messages.
//   calendar pg_cron (supabase/cron.sql) every 5 minutes with x-hub-cron, or an admin's Sync now
//            (their own sign-in; it also reads every calendar): copies hub items to Google and reads
//            Google's events back (calendar.ts, docs/v1.1-google-calendar.md §3.4).
//   calendar_test  admins: { calendar_id } → checks one calendar in Google (calendar.ts).
//            Both answer 503 {stop: 'no_schema'} until migration 0003 is applied. The body is ignored
//            except for action and calendar_id.
//   school   pg_cron (supabase/cron.sql) every hour at minute 23 with x-hub-cron, or a parent's Check now
//            (their own sign-in; it reads every link not read in the last minute): reads the school's
//            Blackbaud calendar links (school.ts, ical.ts; docs/v1.3-homework.md §11.3). Answers 503
//            {stop: 'no_schema'} until migration 0006 is applied. The body is ignored except for action.
//   homework_ai  a parent (their own sign-in) or Pat's tutor link (its token in the body): { kind: 'plan' |
//            'revise' | 'test', assignment_id?, token?, request?, answers?, key } → 202 {run_id}, or 200 {stop}; the
//            draft plan from Claude is written to the assignment in the background (homework.ts,
//            docs/v1.3-homework.md §6). Without ANTHROPIC_API_KEY: 200 {stop: 'not_set_up'}. 503 {stop: 'no_schema'}
//            until migration 0005 is applied.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   HUB_CRON_SECRET  at least 32 random characters; the same value as the Vault secret hub_cron_secret
//   SITE_URL         the site's address, e.g. https://<you>.github.io/<repo>/ (for the links in emails)
//   RESEND_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME (optional)   as for send-email
//   HEALTHCHECK_URL  optional, e.g. a healthchecks.io ping URL (it must also answer at <url>/fail)
//   GOOGLE_SA_JSON   optional: the Google service-account key file, for the calendar (read in calendar.ts)
//   ANTHROPIC_API_KEY  optional: the AI planner's key at Anthropic (read in homework.ts; never logged). Without it the
//                    homework_ai action answers not_set_up and everything else works.
// The school feed needs no secret of its own: the links are in the database (private.school_feed_urls).
// Supabase provides SUPABASE_URL, the publishable key and the secret (service-role) key.

import { renderConfirm, renderDigest, siteBase, confirmUrl } from './render.ts';
import type { Digest, Email } from './render.ts';
import { CORS, DETAIL_MAX, json, message, oneLine, sameSecret, isUuid } from './util.ts';
import type { Db, Deps } from './util.ts';
import { runCalendar, testCalendar } from './calendar.ts';
import { runSchool } from './school.ts';
import { homeworkAi } from './homework.ts';

// What the tests and index.ts import from here.
export { CORS, sameSecret };
export type { Db, Deps, Result } from './util.ts';

export const BATCH = 20;              // emails per run (digest_due's limit)
export const KEEP_RUNS_DAYS = 30;     // job_runs older than this are removed after each run
export const SEND_GAP_MS = 600;       // Resend allows 2 requests a second by default
export const CONFIRM_MAX = 2;         // confirmation emails per address: the first and one reminder
const SEND_TIMEOUT_MS = 15000;
const MIN_SECRET = 32;

type Row = { person_id: string; local_date: string; kind: string };
type Outcome = { status: 'sent' | 'skipped' | 'failed'; detail: string | null };

// Resend takes the sender as `"Name" <address>`; keep the name to characters that can't break that.
const displayName = (s: string) => s.replace(/[^\p{L}\p{N} '.-]/gu, '').replace(/\s+/g, ' ').trim() || 'Home Hub';

// The service-role key: SUPABASE_SECRET_KEYS ({"default": "sb_secret_…"}), else the legacy SUPABASE_SERVICE_ROLE_KEY.
export function serviceKey(env: Deps['env']): string | null {
  const keys = env('SUPABASE_SECRET_KEYS');
  if (keys) {
    try {
      const k = JSON.parse(keys).default;
      if (k) return String(k);
    } catch { /* fall back to the legacy key */ }
  }
  return env('SUPABASE_SERVICE_ROLE_KEY') || null;
}

// A real calendar date written as YYYY-MM-DD (not 2026-02-30, not 2026-13-01).
const isDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// 16 hex characters of the secret's SHA-256: enough to tell one address's secret from the next,
// without putting the secret itself in a request header.
async function fingerprint(secret: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Who can sign in: the addresses in members, read once (service role) when first needed.
// Their emails link to the hub; everyone else's to their My day page.
function signInCheck(db: Db): (email: string) => Promise<boolean> {
  let emails: Promise<Set<string>> | null = null;
  return async (email: string) => {
    emails ??= (async () => {
      const { data, error } = await db.from('members').select('email');
      if (error) throw new Error(`members: ${message(error)}`);
      return new Set(((data || []) as { email?: string }[]).map((m) => String(m.email ?? '').trim().toLowerCase()));
    })();
    return (await emails).has(String(email).trim().toLowerCase());
  };
}

// The health check: HEALTHCHECK_URL after a good run, HEALTHCHECK_URL/fail after one that
// wasn't, so the operator hears about it at once, even while the 15-minute runs keep coming.
async function ping(deps: Deps, healthy: boolean): Promise<void> {
  const url = deps.env('HEALTHCHECK_URL');
  if (!url || !/^https?:\/\//.test(url)) return;
  let target = url;
  if (!healthy) {
    try {
      const u = new URL(url);
      u.pathname = `${u.pathname.replace(/\/+$/, '')}/fail`;
      target = u.href;
    } catch { return; }
  }
  try {
    await deps.fetch(target, { method: 'GET', signal: AbortSignal.timeout(5000) });
  } catch { /* the health service notices the missing ping */ }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse((await req.text()) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  } catch { /* a digest request ignores its body; the others need none to be refused */ }
  const action = body.action ?? 'digest';

  if (action === 'digest') return digest(req, deps);
  if (action === 'preview' || action === 'status') {
    const authorization = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S+/.test(authorization)) return json(401, { error: 'Sign in first.' });
    const userDb = deps.user(authorization);
    const { data: me, error } = await userDb.rpc('whoami');
    if (error || !me || me.role !== 'admin') return json(403, { error: 'Only family admins can do this.' });
    return action === 'preview' ? preview(body, deps) : status(userDb, deps);
  }
  if (action === 'calendar' || action === 'calendar_test') return calendar(req, action, body, deps);
  if (action === 'school') return school(req, deps);
  if (action === 'homework_ai') return homeworkAi(req, body, deps);
  return json(400, { error: 'Unknown action. Use digest, preview, status, calendar, calendar_test, school or homework_ai.' });
}

// ---------------------------------------------------------------------
// calendar and calendar_test: who may ask (the work is in calendar.ts)
// calendar: pg_cron's x-hub-cron header (compared in constant time, as for digest), or a signed-in
// admin, whose run is Sync now and reads every calendar. calendar_test: admins only.
// ---------------------------------------------------------------------
async function calendar(req: Request, action: 'calendar' | 'calendar_test', body: Record<string, unknown>, deps: Deps): Promise<Response> {
  const given = (req.headers.get('x-hub-cron') || '').trim();
  let force = false;
  if (action === 'calendar' && given) {
    const secret = (deps.env('HUB_CRON_SECRET') || '').trim();
    if (secret.length < MIN_SECRET) {
      return json(503, { error: `The calendar job is not set up: HUB_CRON_SECRET must be at least ${MIN_SECRET} characters.` });
    }
    if (!sameSecret(given, secret)) return json(401, { error: 'Not allowed.' });
  } else {
    const authorization = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S+/.test(authorization)) return json(401, { error: action === 'calendar' ? 'Not allowed.' : 'Sign in first.' });
    const { data: me, error } = await deps.user(authorization).rpc('whoami');
    if (error || !me || me.role !== 'admin') return json(403, { error: 'Only family admins can do this.' });
    force = true;
  }
  if (!deps.env('SUPABASE_URL') || !serviceKey(deps.env)) {
    return json(503, { error: 'The function has no Supabase service key (SUPABASE_URL and SUPABASE_SECRET_KEYS).' });
  }
  return action === 'calendar' ? runCalendar(deps, { force }) : testCalendar(body, deps);
}

// ---------------------------------------------------------------------
// school: who may ask (the work is in school.ts)
// pg_cron's x-hub-cron header (compared in constant time, as for digest), or a signed-in admin, whose
// run is Check now and reads every link not read in the last minute.
// ---------------------------------------------------------------------
async function school(req: Request, deps: Deps): Promise<Response> {
  const given = (req.headers.get('x-hub-cron') || '').trim();
  let force = false;
  if (given) {
    const secret = (deps.env('HUB_CRON_SECRET') || '').trim();
    if (secret.length < MIN_SECRET) {
      return json(503, { error: `The school feed is not set up: HUB_CRON_SECRET must be at least ${MIN_SECRET} characters.` });
    }
    if (!sameSecret(given, secret)) return json(401, { error: 'Not allowed.' });
  } else {
    const authorization = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S+/.test(authorization)) return json(401, { error: 'Not allowed.' });
    const { data: me, error } = await deps.user(authorization).rpc('whoami');
    if (error || !me || me.role !== 'admin') return json(403, { error: 'Only family admins can do this.' });
    force = true;
  }
  if (!deps.env('SUPABASE_URL') || !serviceKey(deps.env)) {
    return json(503, { error: 'The function has no Supabase service key (SUPABASE_URL and SUPABASE_SECRET_KEYS).' });
  }
  return runSchool(deps, { force });
}

// ---------------------------------------------------------------------
// digest: the cron run
// ---------------------------------------------------------------------
async function digest(req: Request, deps: Deps): Promise<Response> {
  const secret = (deps.env('HUB_CRON_SECRET') || '').trim();
  if (secret.length < MIN_SECRET) {
    return json(503, { error: `The morning email is not set up: HUB_CRON_SECRET must be at least ${MIN_SECRET} characters.` });
  }
  const given = (req.headers.get('x-hub-cron') || '').trim();
  if (!given || !sameSecret(given, secret)) return json(401, { error: 'Not allowed.' });
  if (!deps.env('SUPABASE_URL') || !serviceKey(deps.env)) {
    await ping(deps, false);
    return json(503, { error: 'The function has no Supabase service key (SUPABASE_URL and SUPABASE_SECRET_KEYS).' });
  }

  const now = () => (deps.now ? deps.now() : Date.now());
  const db = deps.service();
  const { data: run, error: runErr } = await db.from('job_runs')
    .insert({ action: 'digest', started_at: new Date(now()).toISOString() }).select('id').single();
  if (runErr || !run) {
    await ping(deps, false);
    return json(500, { ok: false, error: `Could not record the run: ${message(runErr)}` });
  }

  const tally = { due: 0, sent: 0, skipped: 0, failed: 0, busy: 0 };
  let stop: 'config' | 'budget' | 'error' | null = null;
  let error: string | null = null;
  let rollError: string | null = null;
  let rolled: number | null = null;

  // Sends are spaced out to stay inside Resend's rate limit.
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let lastSend = -Infinity;
  const pace = async () => {
    const wait = lastSend + SEND_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    lastSend = now();
  };

  const site = siteBase(deps.env('SITE_URL'));
  const apiKey = deps.env('RESEND_API_KEY');
  const from = deps.env('EMAIL_FROM');
  const canSignIn = signInCheck(db);
  if (!site) {
    stop = 'config';
    error = 'SITE_URL is not set (or is not an http(s) address). Add it to the function\'s secrets, e.g. https://<you>.github.io/<repo>/';
  } else if (!apiKey || !from) {
    stop = 'config';
    error = 'RESEND_API_KEY and EMAIL_FROM are not set. Add the Resend secrets in Supabase.';
  }

  if (!stop) {
    try {
      // Missed repeating tasks move on first, so today's lists are right. A failure here is
      // recorded (and skips the health ping) but doesn't hold back the emails.
      const roll = await db.rpc('roll_missed_tasks');
      if (roll.error) rollError = message(roll.error);
      else rolled = typeof roll.data === 'number' ? roll.data : null;

      const due = await db.rpc('digest_due', { p_limit: BATCH });
      if (due.error) throw new Error(`digest_due: ${message(due.error)}`);
      const rows: Row[] = Array.isArray(due.data) ? due.data : [];
      tally.due = rows.length;

      for (const row of rows) {
        const budget = await db.rpc('email_budget_left');
        if (budget.error) throw new Error(`email_budget_left: ${message(budget.error)}`);
        if (!(Number(budget.data) > 0)) { stop = 'budget'; break; }

        const claim = await db.rpc('claim_notification', { p_person: row.person_id, p_local_date: row.local_date, p_kind: row.kind });
        if (claim.error) throw new Error(`claim_notification: ${message(claim.error)}`);
        if (!claim.data) { tally.busy++; continue; }   // already sent, in flight elsewhere, or out of attempts

        const outcome = await deliver(row, db, deps, site!, { apiKey: apiKey!, from: from!, pace, sleep, canSignIn });
        tally[outcome.status]++;
        const fin = await db.rpc('finish_notification', { p_id: claim.data, p_status: outcome.status, p_detail: outcome.detail });
        if (fin.error) throw new Error(`finish_notification: ${message(fin.error)}`);
      }
    } catch (err) {
      stop = 'error';
      error = message(err);
    }
  }

  const unhandled = stop === 'config' || stop === 'error' || rollError !== null;
  const ok = !unhandled && stop === null && tally.failed === 0;
  const detail = JSON.stringify({ ...tally, rolled, stop, error, roll_error: rollError });
  const fin = await db.from('job_runs')
    .update({ finished_at: new Date(now()).toISOString(), ok, sent: tally.sent, detail }).eq('id', run.id);
  const recorded = !fin.error;

  // Old runs go (one run every 15 minutes adds up). Best effort.
  try {
    await db.from('job_runs').delete().lt('started_at', new Date(now() - KEEP_RUNS_DAYS * 86400000).toISOString());
  } catch { /* next run tries again */ }

  // A run that didn't send everything that was due (a failed email, the budget, a stop) is a
  // failure for the health check: with a revoked Resend key every run fails, and the operator
  // should hear that the morning email stopped, not that the job ran.
  await ping(deps, ok && recorded);

  if (unhandled || !recorded) {
    return json(500, { ok: false, ...tally, stop, error: error || rollError || `Could not record the run: ${message(fin.error)}` });
  }
  return json(200, { ok, ...tally, stop });
}

// Renders and sends one email. Never throws: every problem becomes 'failed' (or 'skipped').
type Sender = {
  apiKey: string; from: string; pace: () => Promise<void>; sleep: (ms: number) => Promise<void>;
  canSignIn: (email: string) => Promise<boolean>;
};
async function deliver(row: Row, db: Db, deps: Deps, site: string, resend: Sender): Promise<Outcome> {
  let to: string;
  let email: Email;
  // Resend sends one email per key (for 24 hours), so a retry after a lost reply can't send twice.
  let key = `${row.kind}-${row.person_id}-${row.local_date}`;
  try {
    if (row.kind === 'digest') {
      const { data, error } = await db.rpc('digest_for', { p_person: row.person_id, p_local_date: row.local_date });
      if (error) return { status: 'failed', detail: `digest_for: ${message(error)}` };
      const d = data as Digest | null;
      if (!d || !d.recipient) return { status: 'skipped', detail: 'Not on the family list any more.' };
      if (d.empty && d.recipient.role !== 'parent') return { status: 'skipped', detail: 'Nothing today.' };
      if (!d.recipient.email) return { status: 'skipped', detail: 'No email address.' };
      let signIn: boolean;
      try {
        signIn = await resend.canSignIn(d.recipient.email);
      } catch (err) {
        return { status: 'failed', detail: message(err) };
      }
      to = d.recipient.email;
      email = renderDigest(d, site, { canSignIn: signIn });
    } else if (row.kind === 'confirm') {
      const { data: p, error } = await db.from('people')
        .select('id, name, email, language, active, digest_enabled, email_verified_at')
        .eq('id', row.person_id).maybeSingle();
      if (error) return { status: 'failed', detail: `people: ${message(error)}` };
      if (!p || !p.active || !p.digest_enabled) return { status: 'skipped', detail: 'The morning email is off.' };
      if (!p.email) return { status: 'skipped', detail: 'No email address.' };
      if (p.email_verified_at) return { status: 'skipped', detail: 'Already confirmed.' };
      const { data: c, error: cErr } = await db.from('people_confirm').select('token, created_at').eq('person_id', row.person_id).maybeSingle();
      if (cErr) return { status: 'failed', detail: `people_confirm: ${message(cErr)}` };
      const link = c && confirmUrl(site, String(c.token));
      if (!link) return { status: 'skipped', detail: 'No confirmation secret.' };
      // One email and at most one reminder per address: count the ones sent since this address's
      // secret was made (a new address gets a new secret, and starts again).
      const { data: earlier, error: nErr } = await db.from('notification_log').select('id')
        .eq('person_id', row.person_id).eq('kind', 'confirm').eq('status', 'sent').gte('created_at', c.created_at);
      if (nErr) return { status: 'failed', detail: `notification_log: ${message(nErr)}` };
      const sentBefore = (earlier || []).length;
      if (sentBefore >= CONFIRM_MAX) {
        return { status: 'skipped', detail: 'Sent twice already (the email and its reminder): no more until the address is confirmed or changed.' };
      }
      to = p.email;
      email = renderConfirm(p, link, { reminder: sentBefore > 0 });
      // The key changes with the address (its secret), so a corrected address gets its email the same
      // day; Resend refuses a key it has seen with a different payload (a different `to` and link).
      key = `${key}-${await fingerprint(String(c.token))}`;
    } else {
      return { status: 'skipped', detail: `Unknown kind ${oneLine(row.kind).slice(0, 20)}.` };
    }
  } catch (err) {
    return { status: 'failed', detail: `render: ${message(err)}` };
  }

  const payload = JSON.stringify({
    from: `"${displayName(deps.env('EMAIL_FROM_NAME') || 'Home Hub')}" <${resend.from}>`,
    to: [to],
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  const send = () => deps.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resend.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: payload,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  try {
    await resend.pace();
    let res = await send();
    if (res.status === 429) {
      // Over Resend's rate limit: wait as long as it asks (1 to 5 seconds), then try once more.
      const after = Number(res.headers.get('retry-after')) * 1000;
      await res.text().catch(() => '');
      await resend.sleep(Math.min(Math.max(Number.isFinite(after) ? after : 0, 1000), 5000));
      await resend.pace();
      res = await send();
    }
    const reply = await res.text();
    if (res.status >= 200 && res.status < 300) {
      let id = '';
      try { id = oneLine(JSON.parse(reply).id).slice(0, 80); } catch { /* no id */ }
      return { status: 'sent', detail: id ? `Resend ${id}` : null };
    }
    // Resend already sent an email under this key (it keeps keys for 24 hours) and refuses this one
    // because its content differs: the reply to the earlier try was lost, and something in the email
    // changed before this retry. The email went out, so it counts as sent.
    let errName = '';
    try { errName = String(JSON.parse(reply).name ?? ''); } catch { /* not JSON */ }
    if (res.status === 409 && errName === 'invalid_idempotent_request') {
      return { status: 'sent', detail: 'Sent earlier: Resend already had this email (409 invalid_idempotent_request).' };
    }
    return { status: 'failed', detail: `Resend ${res.status}: ${oneLine(reply)}`.slice(0, DETAIL_MAX) };
  } catch (err) {
    return { status: 'failed', detail: `Resend: ${message(err)}`.slice(0, DETAIL_MAX) };
  }
}

// ---------------------------------------------------------------------
// preview: what each person's email would look like (nothing sent, nothing logged)
// ---------------------------------------------------------------------
async function preview(body: Record<string, unknown>, deps: Deps): Promise<Response> {
  if (body.date != null && !isDate(body.date)) return json(400, { error: 'date must look like 2026-11-09.' });
  if (body.person_id != null && !isUuid(body.person_id)) return json(400, { error: 'person_id must be a person\'s id.' });
  const site = siteBase(deps.env('SITE_URL'));
  if (!site) return json(503, { error: 'SITE_URL is not set in the function\'s secrets, so the email links can\'t be made.' });
  if (!deps.env('SUPABASE_URL') || !serviceKey(deps.env)) return json(503, { error: 'The function has no Supabase service key.' });

  const db = deps.service();
  let today: string | null = null;
  if (body.date == null) {
    const { data, error } = await db.rpc('today_local');
    if (error || !isDate(data)) return json(500, { error: `Could not read the household's date: ${message(error)}` });
    today = data;
  }
  let q = db.from('people').select('id, name, role, email, email_verified_at, digest_enabled, digest_day, active').eq('active', true);
  q = body.person_id ? q.eq('id', body.person_id) : q.eq('digest_enabled', true);
  const { data: people, error } = await q.order('sort_order').order('name');
  if (error) return json(500, { error: `Could not read the family list: ${message(error)}` });
  if (body.person_id && !(people || []).length) return json(404, { error: 'No active person with that id.' });

  const canSignIn = signInCheck(db);
  const emails = [];
  for (const p of people || []) {
    // Without a date: the next email each person gets (an evening person's is about tomorrow).
    const date = (body.date as string | undefined) ?? (p.digest_day === 'tomorrow' ? addDays(today!, 1) : today!);
    const { data, error: dErr } = await db.rpc('digest_for', { p_person: p.id, p_local_date: date });
    if (dErr) return json(500, { error: `Could not build ${oneLine(p.name)}'s email: ${message(dErr)}` });
    const d = data as Digest | null;
    if (!d) continue;
    const reason = !p.digest_enabled ? 'email_off'
      : !p.email ? 'no_email'
      : !p.email_verified_at ? 'unconfirmed'
      : d.empty && d.recipient.role !== 'parent' ? 'nothing_today'
      : null;
    let signIn = false;
    try {
      signIn = p.email ? await canSignIn(p.email) : false;
    } catch (err) {
      return json(500, { error: `Could not read who can sign in: ${message(err)}` });
    }
    const e = renderDigest(d, site, { canSignIn: signIn });
    emails.push({
      person_id: p.id, name: p.name, role: p.role, email: p.email, local_date: date,
      would_send: reason === null, reason, subject: e.subject, html: e.html, text: e.text,
    });
  }
  return json(200, { date: (body.date as string | undefined) ?? today, emails });
}

// ---------------------------------------------------------------------
// status: for the Settings page. Counts and fixed messages only (no addresses, no Resend replies).
// ---------------------------------------------------------------------
const RUN_MESSAGES = {
  nothing: 'Nothing was due.',
  sent: 'Emails went out.',
  budget: "Stopped early: today's email budget is used up.",
  failed: 'Some emails failed. Resend\'s reason is in notification_log.',
  config: 'Not set up: a secret the morning email needs (SITE_URL or the Resend secrets) is missing.',
  error: 'The run stopped with a database error. The reason is in job_runs.',
  roll: "Couldn't move missed tasks forward. The reason is in job_runs.",
  running: 'Running, or stopped before it could finish.',
};

function runSummary(r: { action: string; started_at: string; finished_at: string | null; ok: boolean | null; sent: number; detail: string | null }) {
  let d: Record<string, any> = {};
  try { d = JSON.parse(r.detail || '{}') || {}; } catch { /* an older or hand-written row */ }
  const n = (k: string) => (typeof d[k] === 'number' ? d[k] : 0);
  const key = !r.finished_at ? 'running'
    : d.stop === 'config' ? 'config'
    : d.stop === 'error' ? 'error'
    : d.roll_error ? 'roll'
    : d.stop === 'budget' ? 'budget'
    : n('failed') > 0 ? 'failed'
    : (r.sent ?? 0) > 0 ? 'sent'
    : 'nothing';
  return {
    action: r.action, started_at: r.started_at, finished_at: r.finished_at, ok: r.ok,
    due: n('due'), sent: r.sent ?? 0, skipped: n('skipped'), failed: n('failed'),
    message: RUN_MESSAGES[key as keyof typeof RUN_MESSAGES],
  };
}

async function status(db: Db, deps: Deps): Promise<Response> {
  const now = deps.now ? deps.now() : Date.now();
  const { data: today, error: tErr } = await db.rpc('today_local');
  if (tErr || !isDate(today)) return json(500, { error: `Could not read the household's date: ${message(tErr)}` });
  const runsQ = await db.from('job_runs').select('action, started_at, finished_at, ok, sent, detail')
    .order('started_at', { ascending: false }).limit(10);
  if (runsQ.error) return json(500, { error: `Could not read job_runs: ${message(runsQ.error)}` });
  const sentQ = await db.from('job_runs').select('started_at, sent').gt('sent', 0)
    .order('started_at', { ascending: false }).limit(1);
  if (sentQ.error) return json(500, { error: `Could not read job_runs: ${message(sentQ.error)}` });
  const logQ = await db.from('notification_log').select('kind, status').eq('local_date', today);
  if (logQ.error) return json(500, { error: `Could not read notification_log: ${message(logQ.error)}` });

  const runs = (runsQ.data || []).map(runSummary);
  const blank = () => ({ sent: 0, failed: 0, skipped: 0, sending: 0 });
  const counts: Record<string, Record<string, number>> = { digest: blank(), confirm: blank() };
  for (const r of logQ.data || []) {
    const k = counts[r.kind];
    if (k && r.status in k) k[r.status]++;
  }

  const messages: string[] = [];
  const last = runs[0];
  // pg_cron's own log says "succeeded" even when the call was refused: net.http_post only queues it.
  // A 401 in net._http_response (kept 6 hours) means the gateway checked for a JWT and refused the
  // cron call before hub-jobs ran: it was deployed without --no-verify-jwt (supabase/config.toml).
  const gateway = 'If it is scheduled, look in net._http_response: a 401 there means hub-jobs was deployed with JWT verification on (deploy it with --no-verify-jwt).';
  if (!last) messages.push(`The morning email has never run. Schedule it with supabase/cron.sql. ${gateway}`);
  else {
    if (now - Date.parse(last.started_at) > 3600000) messages.push(`The last run was more than an hour ago. Check the hub-digest cron job. ${gateway}`);
    if (last.ok === false) messages.push(`Last run: ${last.message}`);
  }
  const failedToday = counts.digest.failed + counts.confirm.failed;
  if (failedToday) messages.push(`${failedToday} ${failedToday === 1 ? 'email' : 'emails'} failed today.`);

  const lastSent = (sentQ.data || [])[0];
  return json(200, {
    today,
    last_run: last ?? null,
    last_sent: lastSent ? { started_at: lastSent.started_at, sent: lastSent.sent } : null,
    runs,
    today_counts: counts,
    messages,
  });
}
