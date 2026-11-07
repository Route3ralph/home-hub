// hub-jobs' inbox (docs/v2-design.md §28): an email to the family's private hub address becomes events on the calendar.
// "Dinner Fri Dec 4, 6-8" from a family member's own address, and the hub adds it and answers "Added: …".
//
// The path, all in this file (handler.ts sends here every POST that carries Resend's svix-id header):
//   1. Resend's webhook (email.received) is signed (Svix: HMAC-SHA256 of "<svix-id>.<svix-timestamp>.<raw body>" with
//      the base64 key after "whsec_" in RESEND_WEBHOOK_SECRET). A bad or missing signature, or a timestamp more than five
//      minutes off, is a 401 and nothing more. Without the secret: 503 {stop: 'not_set_up'}.
//   2. Only mail to INBOX_ADDRESS (the address with a random part, so it can't be guessed) is read; anything else is a
//      200 {ignored} so Resend doesn't send it again. Then 200 {ok} at once, and the work goes on in the background.
//   3. One run per email: a job_runs row (action 'inbox', detail 'email <id>') is written first; a resend of the same
//      email finds it and stops.
//   4. The email (GET /emails/receiving/<id>, with RESEND_API_KEY). Its sender must be a members address (who can sign
//      in), or an address INBOX_ALSO_FROM maps to one ("work@example.org=home@example.com", several separated by commas:
//      a second address the person sends from, which counts as them; the reply goes to the address that wrote), and
//      the receiving server's Authentication-Results header (the first) that reads dmarc=fail, or spf=fail with no
//      dkim=pass for the sender's own domain, drops it. Neither
//      gets an answer: a stranger, or a forged sender, never hears from the hub.
//   5. At most INBOX_DAY_MAX events added by email in 24 hours (the created_by "… (email)" rows); past that, an answer
//      that says so and nothing added.
//   6. Claude (INBOX_MODEL, effort low, a JSON schema) reads the subject and the text and gives up to five events, each
//      with the words the email used for people ("Max", "the kids" stays unmatched). No family name, address or id is
//      sent: today's date, the time zone and the email are all it sees. Each event is checked here (a real date from
//      yesterday to 400 days ahead, times HH:MM, an end after the start or on the next day, a title of 1 to 100).
//   7. The events go in (service role) with created_by "<first name> (email)": the person in charge is the first person
//      the email names who is on the family list, and the others it names come along. An email that names no one makes
//      an event with nobody in charge and nobody along, which the calendar job copies to Family (the wall's Family
//      column), as it does any such event.
//   8. The answer, to the sender, as a reply (In-Reply-To): what was added, with the calendar's link, or why nothing
//      was. job_runs gets ok and sent (the events added).
// Privacy: console lines are fixed codes; the email, its sender and Claude's answer are never logged or kept, except
// as the events themselves.

import { ANTHROPIC, classify } from './homework.ts';
import { siteBase } from './render.ts';
import { json, oneLine, sameSecret } from './util.ts';
import type { Db, Deps } from './util.ts';

export const INBOX_MODEL = 'claude-opus-5-5';
export const INBOX_DAY_MAX = 20;          // events added by email in 24 hours, the whole family
export const INBOX_EVENTS_MAX = 5;        // events from one email
export const INBOX_TEXT_MAX = 6000;       // characters of the email Claude reads
export const SIGNATURE_TOLERANCE_S = 300; // Svix's own: five minutes either way
const CALL_MS = 60000;
const FETCH_MS = 15000;

// The system prompt: no date or name in it, so its bytes never change.
export const INBOX_PROMPT = `You read one short email that a parent sent to their family's calendar, and you turn it into calendar events.

Rules:
- Only add what the email asks to put on the calendar. A forwarded invitation counts. Signatures, quoted earlier messages and pleasantries don't.
- Resolve relative dates ("Friday", "tomorrow", "next Tuesday") from today's date given in the message. A weekday with no date is the next one on or after today. If a date and a weekday disagree, trust the date.
- Times are 24-hour HH:MM in the family's own time zone. "6-8" in the evening means 18:00 to 20:00; use common sense for am and pm (dinner, practice and parties are pm; breakfast and school drop-off are am).
- No time given: leave start_time and end_time empty (an all-day event). A start with no end: leave end_time empty.
- end_date only for an all-day event over several days (a trip, a camp); otherwise empty.
- ends_next_day is true only when the event ends after midnight.
- title: short, as the family would write it ("Dinner at the Parks", "Max dentist"). Up to 100 characters.
- location: a place if the email gives one, else empty.
- people: the people the event is for or who go, exactly as the email names them ("Max", "Sam"), not words like "we", "us" or "the kids". Empty if none.
- If nothing can go on the calendar (no date can be worked out, or the email isn't asking for an event), give no events and say why in problem, in one short friendly sentence the sender will read. Otherwise problem is empty.
- At most ${INBOX_EVENTS_MAX} events.`;

export const INBOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['events', 'problem'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date', 'end_date', 'start_time', 'end_time', 'ends_next_day', 'location', 'people'],
        properties: {
          title: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          end_date: { type: 'string', description: 'YYYY-MM-DD, or empty' },
          start_time: { type: 'string', description: 'HH:MM (24-hour), or empty' },
          end_time: { type: 'string', description: 'HH:MM (24-hour), or empty' },
          ends_next_day: { type: 'boolean' },
          location: { type: 'string' },
          people: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    problem: { type: 'string' },
  },
};

export type InboxEvent = {
  title: string; start_date: string; end_date: string | null; start_time: string | null; end_time: string | null;
  ends_next_day: boolean; location: string | null; people: string[];
};

// ---------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function unb64(s: string): Uint8Array | null {
  try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; }
}

// Svix's signature: any of the space-separated "v1,<base64>" values in svix-signature is the HMAC of the content.
export async function verifySignature(secret: string, id: string, timestamp: string, signature: string, body: string, nowMs: number): Promise<boolean> {
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowMs / 1000 - ts) > SIGNATURE_TOLERANCE_S) return false;
  const raw = unb64(secret.trim().replace(/^whsec_/, ''));
  if (!raw || raw.length < 16) return false;
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const expected = b64(mac);
  let ok = false;
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version === 'v1' && value && sameSecret(value, expected)) ok = true;
  }
  return ok;
}

// INBOX_ALSO_FROM: "other@example.org=member@example.com, …" → other → member, both lower case. A pair that isn't two
// addresses is left out.
export function alsoFrom(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of String(raw ?? '').split(/[,;\n]+/)) {
    const [from, to] = pair.split('=');
    const a = address(from);
    const b = address(to);
    if (a && b && a !== b) map.set(a, b);
  }
  return map;
}

// "Alex Lee <alex@example.com>" or "alex@example.com" → "alex@example.com" (lower case), or '' when there's none.
export function address(s: unknown): string {
  const t = String(s ?? '');
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(t) || /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(t);
  return m ? m[1].trim().toLowerCase() : '';
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Today in the household's time zone, as YYYY-MM-DD and its weekday.
export function today(nowMs: number, tz: string): { date: string; weekday: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' })
    .formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: String(parts.weekday) };
}

// HTML to plain text, roughly: enough for Claude to read a message that came without a text part.
export function htmlText(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

// The email's own words, without what it quotes from earlier messages (lines starting ">", and everything after
// "On … wrote:" or a forwarded-message rule is kept: a forwarded invitation is what she means to add).
export function emailText(text: string): string {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200} wrote:\s*$/.test(line.trim())) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\u0000/g, '').trim().slice(0, INBOX_TEXT_MAX);
}

// The Authentication-Results values, from a headers object or a list of {name, value}, in the order given (the
// receiving server adds its own on top, so the first is the one to trust; a sender can add more below it).
function authResults(headers: unknown): string[] {
  const found: string[] = [];
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h && typeof h === 'object' && /^authentication-results$/i.test(String((h as any).name ?? (h as any).key ?? ''))) found.push(String((h as any).value ?? ''));
    }
  } else if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (/^authentication-results$/i.test(k)) found.push(...(Array.isArray(v) ? v.map(String) : [String(v)]));
    }
  }
  return found;
}
// Whether a signing domain belongs to the sender's: the same, or a parent of it (mail.family.example → family.example).
const aligned = (d: string, from: string) => !!d && !!from && (from === d || from.endsWith(`.${d}`));
// A forged sender, from the receiving server's own header (the first): dmarc=fail, or spf=fail or softfail with no
// dkim=pass signed by the sender's own domain (a pass for some other domain proves nothing about the From).
// No header at all is let through (the address is secret).
export function forged(headers: unknown, fromAddress = ''): boolean {
  const first = (authResults(headers)[0] || '').toLowerCase();
  if (!first) return false;
  if (/\bdmarc=fail\b/.test(first)) return true;
  if (!/\bspf=(fail|softfail)\b/.test(first)) return false;
  const from = fromAddress.trim().toLowerCase().split('@')[1] || '';
  const passes = [...first.matchAll(/\bdkim=pass\b[^;]*?\bheader\.d=([a-z0-9.-]+)/g)].map((m) => m[1].replace(/\.$/, ''));
  return !passes.some((d) => aligned(d, from));
}

// Claude's answer, checked: only what can be saved, at most INBOX_EVENTS_MAX.
export function checkEvents(answer: unknown, todayDate: string): { events: InboxEvent[]; problem: string } {
  const a = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
  const problem = oneLine(a.problem).slice(0, 200);
  const events: InboxEvent[] = [];
  const first = addDays(todayDate, -1);
  const last = addDays(todayDate, 400);
  for (const e of Array.isArray(a.events) ? a.events.slice(0, INBOX_EVENTS_MAX) : []) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const title = oneLine(r.title).slice(0, 100);
    if (!title || !isDate(r.date) || r.date < first || r.date > last) continue;
    let start = HHMM.test(String(r.start_time ?? '')) ? String(r.start_time) : null;
    let end = start && HHMM.test(String(r.end_time ?? '')) ? String(r.end_time) : null;
    let next = !!(start && end && r.ends_next_day === true);
    if (start && end && !next && end <= start) {
      // "11pm-1am" without ends_next_day: it ends the next day. Equal times: no end.
      if (end < start) next = true; else end = null;
    }
    if (!end) next = false;
    let endDate = !start && isDate(r.end_date) && r.end_date > r.date && r.end_date <= addDays(r.date, 60) ? r.end_date : null;
    if (start) endDate = null;
    if (!start) { end = null; next = false; start = null; }
    const location = oneLine(r.location).slice(0, 200) || null;
    const people = (Array.isArray(r.people) ? r.people : []).map((p) => oneLine(p).slice(0, 40)).filter(Boolean).slice(0, 10);
    events.push({ title, start_date: r.date, end_date: endDate, start_time: start, end_time: end, ends_next_day: next, location, people });
  }
  return { events, problem };
}

type Person = { id: string; name: string; email: string | null; active?: boolean };
const firstWord = (name: string) => String(name || '').trim().split(/\s+/)[0] || '';
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// The people an event names who are on the family list, by full name or first name (accents and case aside).
export function matchPeople(words: string[], people: Person[]): Person[] {
  const out: Person[] = [];
  for (const w of words) {
    const f = fold(w.trim());
    const p = people.find((x) => fold(x.name) === f) || people.find((x) => fold(firstWord(x.name)) === f);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

// "Fri Dec 4", "6:00pm", "6:00–8:00pm", for the answer.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const dayLabel = (d: string) => {
  const t = new Date(`${d}T12:00:00Z`);
  return `${DAYS[t.getUTCDay()]} ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`;
};
export const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
};
export function eventLine(e: InboxEvent): string {
  let when = dayLabel(e.start_date);
  if (e.end_date) when += ` to ${dayLabel(e.end_date)}`;
  else if (e.start_time) when += `, ${timeLabel(e.start_time)}${e.end_time ? `–${timeLabel(e.end_time)}${e.ends_next_day ? ' (next day)' : ''}` : ''}`;
  else when += ', all day';
  return `${e.title} · ${when}${e.location ? ` · ${e.location}` : ''}`;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const displayName = (s: string) => s.replace(/[^\p{L}\p{N} '.-]/gu, '').replace(/\s+/g, ' ').trim() || 'Home Hub';

// ---------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------
export async function inbox(req: Request, raw: string, deps: Deps): Promise<Response> {
  const now = () => (deps.now ? deps.now() : Date.now());
  const secret = (deps.env('RESEND_WEBHOOK_SECRET') || '').trim();
  if (!secret) return json(503, { stop: 'not_set_up', error: 'The inbox is not set up: RESEND_WEBHOOK_SECRET is missing.' });
  const good = await verifySignature(secret, req.headers.get('svix-id') || '', req.headers.get('svix-timestamp') || '',
    req.headers.get('svix-signature') || '', raw, now());
  if (!good) return json(401, { error: 'Not allowed.' });

  let event: any = null;
  try { event = JSON.parse(raw); } catch { /* ignored below */ }
  if (!event || event.type !== 'email.received' || !event.data || typeof event.data !== 'object') return json(200, { ignored: 'type' });
  const emailId = String(event.data.email_id ?? '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(emailId)) return json(200, { ignored: 'id' });
  const inboxAddress = address(deps.env('INBOX_ADDRESS'));
  const to = [...(Array.isArray(event.data.to) ? event.data.to : []), ...(Array.isArray(event.data.cc) ? event.data.cc : [])].map(address);
  if (!inboxAddress || !to.includes(inboxAddress)) return json(200, { ignored: 'address' });

  const missing = ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'EMAIL_FROM'].filter((n) => !(deps.env(n) || '').trim());
  if (missing.length) return json(503, { stop: 'not_set_up', error: `The inbox needs ${missing.join(', ')}.` });

  const work = handleEmail(deps, emailId).catch(() => { console.error('inbox: error'); });
  if (deps.background) deps.background(work); else await work;
  return json(200, { ok: true });
}

async function handleEmail(deps: Deps, emailId: string): Promise<void> {
  const now = () => (deps.now ? deps.now() : Date.now());
  const db = deps.service();
  const key = `email ${emailId}`;
  const { data: seen } = await db.from('job_runs').select('id').eq('action', 'inbox').eq('detail', key).limit(1);
  if (Array.isArray(seen) && seen.length) { console.log('inbox: again'); return; }
  const { data: run, error: runErr } = await db.from('job_runs')
    .insert({ action: 'inbox', detail: key, started_at: new Date(now()).toISOString() }).select('id').single();
  if (runErr || !run) { console.error('inbox: no_run'); return; }
  const finish = async (ok: boolean, sent: number, code: string) => {
    console.log(`inbox: ${code} ${sent}`);
    await db.from('job_runs').update({ finished_at: new Date(now()).toISOString(), ok, sent }).eq('id', run.id);
  };

  // The email
  const apiKey = (deps.env('RESEND_API_KEY') || '').trim();
  let mail: any = null;
  try {
    const res = await deps.fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(FETCH_MS),
    });
    if (res.status === 200) mail = await res.json();
  } catch { /* below */ }
  if (!mail || typeof mail !== 'object') return finish(false, 0, 'no_email');

  const sender = address(mail.from);
  // Who it counts as: the sender, or the member INBOX_ALSO_FROM names for that address.
  const owner = alsoFrom(deps.env('INBOX_ALSO_FROM')).get(sender) ?? sender;
  const { data: members } = await db.from('members').select('email');
  const memberSet = new Set(((members || []) as { email?: string }[]).map((m) => String(m.email ?? '').trim().toLowerCase()));
  if (!sender || !memberSet.has(owner)) return finish(false, 0, 'not_family');
  if (forged(mail.headers, sender)) return finish(false, 0, 'forged');

  const { data: peopleRows } = await db.from('people').select('id, name, email, active').eq('active', true);
  const people = ((peopleRows || []) as Person[]).filter((p) => p && p.id && p.name);
  const me = people.find((p) => String(p.email ?? '').trim().toLowerCase() === owner) || null;
  const who = `${firstWord(me ? me.name : owner.split('@')[0]).slice(0, 40)} (email)`;
  const subject = oneLine(mail.subject).slice(0, 200);
  const reply = (text: string, html: string) => sendReply(deps, sender, subject, mail.message_id ?? mail.headers?.['message-id'], text, html, emailId);

  // The day's limit
  const since = new Date(now() - 86400000).toISOString();
  const { count } = await db.from('events').select('id', { count: 'exact', head: true }).like('created_by', '% (email)').gte('created_at', since);
  const left = INBOX_DAY_MAX - (count ?? 0);
  if (left <= 0) {
    await reply(`Nothing was added: the hub takes ${INBOX_DAY_MAX} events a day by email, and today's are used up. Add it on the calendar instead.`, '');
    return finish(false, 0, 'day_max');
  }

  // Claude
  const { data: hh } = await db.from('household').select('tz').limit(1);
  const tz = Array.isArray(hh) && hh[0] && typeof hh[0].tz === 'string' ? hh[0].tz : 'America/New_York';
  const day = today(now(), tz);
  const body = emailText(typeof mail.text === 'string' && mail.text.trim() ? mail.text : htmlText(String(mail.html ?? '')));
  const asked = await askClaude(deps, `Today is ${day.weekday}, ${day.date}. The family's time zone is ${tz}.\n\nSubject: ${subject}\n\n<email>\n${body}\n</email>`);
  if ('stop' in asked) {
    await reply('Sorry, the hub couldn\'t read that email just now. Try again in a little while, or add it on the calendar.', '');
    return finish(false, 0, `ai_${asked.stop}`);
  }
  const checked = checkEvents(asked.answer, day.date);
  const { problem } = checked;
  const events = checked.events.slice(0, left);   // never past the day's limit
  const over = checked.events.length - events.length;
  const site = siteBase(deps.env('SITE_URL'));
  if (!events.length) {
    const why = problem || 'I couldn\'t find a day to put it on.';
    await reply(`Nothing was added. ${why}\n\nTry something like: Dinner at the Parks Fri Dec 4 6-8pm`, '');
    return finish(true, 0, 'none');
  }

  // The events
  const added: InboxEvent[] = [];
  for (const e of events) {
    const named = matchPeople(e.people, people);
    const lead = named[0] || null;   // no one named: nobody in charge, so it goes on Family
    const row = {
      title: e.title, start_date: e.start_date, end_date: e.end_date, start_time: e.start_time, end_time: e.end_time,
      ends_next_day: e.ends_next_day, location: e.location, notes: 'Added by email',
      responsible_id: lead ? lead.id : null,
      participant_ids: named.filter((p) => p !== lead).map((p) => p.id),
      created_by: who, updated_by: who,
    };
    const { error } = await db.from('events').insert(row);
    if (!error) added.push(e);
  }
  if (!added.length) {
    await reply('Sorry, the hub couldn\'t save that just now. Try again in a little while, or add it on the calendar.', '');
    return finish(false, 0, 'insert');
  }
  const link = site ? `${site}#/calendar/${added[0].start_date}` : '';
  const lines = added.map(eventLine);
  const text = `Added to the calendar:\n${lines.map((l) => `• ${l}`).join('\n')}${added.length < events.length ? '\n\n(One or more couldn\'t be saved.)' : ''}`
    + `${over ? `\n\n(${over} more didn't fit: the hub takes ${INBOX_DAY_MAX} events a day by email. Add ${over === 1 ? 'it' : 'them'} on the calendar.)` : ''}`
    + `${link ? `\n\nSee it or change it: ${link}` : ''}`;
  const html = `<p>Added to the calendar:</p><ul>${lines.map((l) => `<li>${escHtml(l)}</li>`).join('')}</ul>`
    + `${added.length < events.length ? '<p>(One or more couldn\'t be saved.)</p>' : ''}`
    + `${over ? `<p>(${over} more didn't fit: the hub takes ${INBOX_DAY_MAX} events a day by email. Add ${over === 1 ? 'it' : 'them'} on the calendar.)</p>` : ''}`
    + `${link ? `<p><a href="${escHtml(link)}">See it or change it</a></p>` : ''}`;
  await reply(text, html);
  return finish(true, added.length, 'added');
}

type Asked = { answer: unknown } | { stop: string };
export function inboxRequest(message: string): Record<string, unknown> {
  return {
    model: INBOX_MODEL,
    max_tokens: 4000,
    system: [{ type: 'text', text: INBOX_PROMPT }],
    messages: [{ role: 'user', content: message }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: INBOX_SCHEMA } },
    fallbacks: 'default',
  };
}
async function askClaude(deps: Deps, message: string): Promise<Asked> {
  const key = (deps.env('ANTHROPIC_API_KEY') || '').trim();
  let res: Response;
  try {
    res = await deps.fetch(ANTHROPIC.url, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC.version, 'anthropic-beta': ANTHROPIC.beta, 'content-type': 'application/json' },
      body: JSON.stringify(inboxRequest(message)),
      signal: AbortSignal.timeout(CALL_MS),
    });
  } catch { return { stop: 'timeout' }; }
  let text = '';
  try { text = await res.text(); } catch { return { stop: 'error' }; }
  if (res.status !== 200) return { stop: classify(res.status, text) };
  let m: any;
  try { m = JSON.parse(text); } catch { return { stop: 'invalid' }; }
  if (m?.stop_reason === 'refusal') return { stop: 'refusal' };
  if (m?.stop_reason === 'max_tokens') return { stop: 'invalid' };
  const block = Array.isArray(m?.content) ? m.content.find((b: any) => b && b.type === 'text' && typeof b.text === 'string') : null;
  if (!block) return { stop: 'invalid' };
  try { return { answer: JSON.parse(block.text) }; } catch { return { stop: 'invalid' }; }
}

async function sendReply(deps: Deps, to: string, subject: string, inReplyTo: unknown, text: string, html: string, emailId: string): Promise<void> {
  const from = (deps.env('EMAIL_FROM') || '').trim();
  const headers: Record<string, string> = {};
  const mid = oneLine(inReplyTo);
  if (/^<[^<>\s]{3,300}>$/.test(mid)) { headers['In-Reply-To'] = mid; headers.References = mid; }
  const payload = JSON.stringify({
    from: `"${displayName(deps.env('EMAIL_FROM_NAME') || 'Home Hub')}" <${from}>`,
    to: [to],
    subject: subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : 'Your calendar email',
    text,
    html: html || `<p>${escHtml(text).replace(/\n/g, '<br>')}</p>`,
    ...(Object.keys(headers).length ? { headers } : {}),
  });
  try {
    await deps.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${(deps.env('RESEND_API_KEY') || '').trim()}`, 'Content-Type': 'application/json', 'Idempotency-Key': `inbox-${emailId}` },
      body: payload,
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch { console.error('inbox: reply_failed'); }
}

export type { Db };
