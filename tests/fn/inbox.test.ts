// Unit tests for hub-jobs' inbox (supabase/functions/hub-jobs/inbox.ts; docs/v2-design.md §28): Resend's email.received
// webhook, through handle() as the Edge Function runs it, with a fake database (chained queries recorded), Resend and
// Anthropic behind the injected fetch, and a fixed clock. Covered: the signature (none, wrong, stale, a second v1 value,
// no secret: 503); other events and other addresses ignored with a 200; the happy path (the event's columns, who is in
// charge, created_by, the reply as a reply with the calendar's link); a resend of the same email does nothing; a
// stranger and a forged sender get nothing and no answer; the day's limit; Claude's request (model, effort, schema, no
// family name); Claude failing; the answer's checks (dates, times, next day, several days, the cap); the helpers.
// Run alone with: node --experimental-strip-types tests/fn/inbox.test.ts
import { handle } from '../../supabase/functions/hub-jobs/handler.ts';
import {
  INBOX_MODEL, INBOX_DAY_MAX, INBOX_EVENTS_MAX, INBOX_PROMPT, verifySignature, address, checkEvents, emailText, htmlText,
  matchPeople, eventLine, forged, today, alsoFrom,
} from '../../supabase/functions/hub-jobs/inbox.ts';
import { ANTHROPIC } from '../../supabase/functions/hub-jobs/homework.ts';
import { createHmac } from 'node:crypto';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`);

// ---------------------------------------------------------------------
// Fixtures (fictional)
// ---------------------------------------------------------------------
const KEY_BYTES = Buffer.from('made-up-signing-key-0123456789ab');
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const INBOX = 'cal-7f3k9q2m@hub-made-up.resend.app';
const NOW = Date.parse('2026-11-06T15:00:00Z'); // Fri Nov 6, 10am in New York
const ALEX = 'aaaaaaaa-0000-4000-8000-000000000001';
const SAM = 'aaaaaaaa-0000-4000-8000-000000000002';
const TAYLOR = 'aaaaaaaa-0000-4000-8000-000000000003';
const PEOPLE = [
  { id: ALEX, name: 'Alex Lee', email: 'alex@example.com', active: true },
  { id: SAM, name: 'Sam Lee', email: 'sam@example.com', active: true },
  { id: TAYLOR, name: 'Taylor', email: null, active: true },
];
const MEMBERS = [{ email: 'Alex@Example.com' }, { email: 'sam@example.com' }];

const sign = (id: string, ts: string, body: string) => `v1,${createHmac('sha256', KEY_BYTES).update(`${id}.${ts}.${body}`).digest('base64')}`;
const webhook = (o: { id?: string; to?: string[]; type?: string; ts?: number; sig?: string; noSig?: boolean } = {}) => {
  const body = JSON.stringify({ type: o.type ?? 'email.received', created_at: '2026-11-06T15:00:00Z',
    data: { email_id: o.id ?? 'em_made_up_1', from: 'Alex Lee <alex@example.com>', to: o.to ?? [INBOX], subject: 'dinner', attachments: [] } });
  const id = 'msg_made_up';
  const ts = String(o.ts ?? Math.floor(NOW / 1000));
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': ts };
  if (!o.noSig) headers['svix-signature'] = o.sig ?? `v1,bm90IGl0 ${sign(id, ts, body)}`;
  return new Request('https://project.example/functions/v1/hub-jobs', { method: 'POST', headers, body });
};
const received = (o: Record<string, unknown> = {}) => Object.assign({
  object: 'email', id: 'em_made_up_1', from: 'Alex Lee <alex@example.com>', to: [INBOX], subject: 'dinner',
  text: 'Dinner at the Lees Fri Dec 4, 6-8. Bring Sam.\n\nOn Thu, Nov 5, 2026 Sam wrote:\n> old stuff Jan 1', html: '<p>x</p>',
  message_id: '<orig-made-up@mail.example>', headers: { 'authentication-results': 'mx.example; spf=pass; dkim=pass; dmarc=pass' },
}, o);
const answer = (events: unknown[], problem = '') => ({
  id: 'msg_made_up', type: 'message', role: 'assistant', model: INBOX_MODEL, stop_reason: 'end_turn', stop_details: null,
  content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify({ events, problem }) }],
  usage: { input_tokens: 500, output_tokens: 100 },
});
const DINNER = { title: 'Dinner at the Lees', date: '2026-12-04', end_date: '', start_time: '18:00', end_time: '20:00', ends_next_day: false, location: '', people: ['Sam'] };
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ---------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------
type Op = { table: string; op: string; args: any[]; filters: any[] };
function setup(o: { env?: Record<string, string | undefined>; mail?: any; mailStatus?: number; claude?: Response; seen?: boolean; count?: number; insertFail?: boolean } = {}) {
  const ops: Op[] = [];
  const hits: { url: string; init: any; body: any }[] = [];
  const bg: Promise<unknown>[] = [];
  const query = (table: string) => {
    const q: Op = { table, op: 'select', args: [], filters: [] };
    ops.push(q);
    const result = () => {
      if (table === 'job_runs' && q.op === 'select') return { data: o.seen ? [{ id: 'r0' }] : [], error: null };
      if (table === 'job_runs' && q.op === 'insert') return { data: { id: 'run1' }, error: null };
      if (table === 'members') return { data: MEMBERS, error: null };
      if (table === 'people') return { data: PEOPLE, error: null };
      if (table === 'household') return { data: [{ tz: 'America/New_York' }], error: null };
      if (table === 'events' && q.op === 'select') return { data: null, count: o.count ?? 0, error: null };
      if (table === 'events' && q.op === 'insert') return o.insertFail ? { data: null, error: { message: 'no' } } : { data: null, error: null };
      return { data: null, error: null };
    };
    const chain: any = {
      select(...a: any[]) { if (q.op === 'select') q.args = a; return chain; },
      insert(row: any) { q.op = 'insert'; q.args = [row]; return chain; },
      update(row: any) { q.op = 'update'; q.args = [row]; return chain; },
      eq(...a: any[]) { q.filters.push(['eq', ...a]); return chain; },
      like(...a: any[]) { q.filters.push(['like', ...a]); return chain; },
      gte(...a: any[]) { q.filters.push(['gte', ...a]); return chain; },
      limit(...a: any[]) { q.filters.push(['limit', ...a]); return chain; },
      single() { return chain; },
      then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej); },
    };
    return chain;
  };
  const env: Record<string, string | undefined> = Object.assign({
    RESEND_WEBHOOK_SECRET: SECRET, INBOX_ADDRESS: INBOX, ANTHROPIC_API_KEY: 'sk-ant-made-up', RESEND_API_KEY: 're_made_up',
    EMAIL_FROM: 'hub@family.example', SITE_URL: 'https://family.example/hub/', SUPABASE_URL: 'https://project.example',
    SUPABASE_SECRET_KEYS: '{"default":"sb_secret_made_up"}',
  }, o.env);
  const fetchFake = async (input: string | URL, init: any = {}) => {
    const url = String(input);
    let body: any = null;
    try { body = JSON.parse(init.body); } catch { body = init.body ?? null; }
    hits.push({ url, init, body });
    if (url.startsWith('https://api.resend.com/emails/receiving/')) return jsonRes(o.mailStatus ?? 200, o.mail ?? received());
    if (url === 'https://api.resend.com/emails') return jsonRes(200, { id: 'sent_made_up' });
    if (url === ANTHROPIC.url) return (o.claude ?? jsonRes(200, answer([DINNER]))).clone();
    return jsonRes(404, {});
  };
  const deps: any = {
    env: (n: string) => env[n], fetch: fetchFake, now: () => NOW,
    service: () => ({ from: query, rpc: () => Promise.resolve({ data: null, error: { message: 'no rpc here' } }) }),
    user: () => { throw new Error('no sign-in for the inbox'); },
    background: (p: Promise<unknown>) => { bg.push(p); },
  };
  return { deps, ops, hits, bg };
}
const logged: string[] = [];
const real = { log: console.log, error: console.error };
async function run(s: ReturnType<typeof setup>, req: Request) {
  console.log = (...a: unknown[]) => logged.push(a.join(' '));
  console.error = (...a: unknown[]) => logged.push(a.join(' '));
  try {
    const res = await handle(req, s.deps);
    const body = await res.json().catch(() => null);
    await Promise.all(s.bg);
    return { status: res.status, body };
  } finally { Object.assign(console, real); }
}
const inserts = (s: ReturnType<typeof setup>, table: string) => s.ops.filter((x) => x.table === table && x.op === 'insert').map((x) => x.args[0]);
const replies = (s: ReturnType<typeof setup>) => s.hits.filter((h) => h.url === 'https://api.resend.com/emails').map((h) => h.body);
const claudeHits = (s: ReturnType<typeof setup>) => s.hits.filter((h) => h.url === ANTHROPIC.url);

(async () => {
  // ---- The signature
  {
    const s = setup({ env: { RESEND_WEBHOOK_SECRET: undefined } });
    const r = await run(s, webhook());
    check('no RESEND_WEBHOOK_SECRET: 503 not_set_up, nothing read', r.status === 503 && r.body.stop === 'not_set_up' && !s.hits.length && !s.ops.length);
  }
  for (const [name, req] of [
    ['no signature', webhook({ noSig: true })],
    ['a wrong signature', webhook({ sig: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })],
    ['a signature six minutes old', webhook({ ts: Math.floor(NOW / 1000) - 360 })],
  ] as const) {
    const s = setup();
    const r = await run(s, req);
    check(`${name}: 401, nothing read or sent`, r.status === 401 && !s.hits.length && !s.ops.length, JSON.stringify(r));
  }
  check('verifySignature: the right content and key, any v1 value of several',
    await verifySignature(SECRET, 'i', '1793976000', `v1,x ${sign('i', '1793976000', 'b')}`, 'b', 1793976000000)
    && !(await verifySignature(SECRET, 'i', '1793976000', sign('i', '1793976000', 'b'), 'b2', 1793976000000))
    && !(await verifySignature(SECRET, 'i', '1793976000', sign('i', '1793976000', 'b').replace('v1', 'v2'), 'b', 1793976000000)));

  // ---- Ignored with a 200
  {
    const s = setup();
    const r = await run(s, webhook({ type: 'email.sent' }));
    check('another event type: 200 ignored, nothing read', r.status === 200 && r.body.ignored === 'type' && !s.hits.length && !s.ops.length);
  }
  {
    const s = setup();
    const r = await run(s, webhook({ to: ['someone@hub-made-up.resend.app'] }));
    check('mail to another address: 200 ignored, nothing read', r.status === 200 && r.body.ignored === 'address' && !s.hits.length && !s.ops.length);
  }
  {
    const s = setup({ env: { ANTHROPIC_API_KEY: undefined } });
    const r = await run(s, webhook());
    check('no ANTHROPIC_API_KEY: 503 not_set_up', r.status === 503 && r.body.stop === 'not_set_up' && !s.hits.length);
  }

  // ---- The happy path
  {
    const s = setup();
    const r = await run(s, webhook());
    const ev = inserts(s, 'events');
    check('a family member\'s email: 200 ok', r.status === 200 && r.body.ok === true);
    check('one job_runs row keyed by the email', inserts(s, 'job_runs').length === 1 && inserts(s, 'job_runs')[0].action === 'inbox' && inserts(s, 'job_runs')[0].detail === 'email em_made_up_1');
    check('the email read from Resend with the key', s.hits.some((h) => h.url === 'https://api.resend.com/emails/receiving/em_made_up_1' && h.init.headers.Authorization === 'Bearer re_made_up'));
    check('one event with the checked columns', ev.length === 1 && ev[0].title === 'Dinner at the Lees' && ev[0].start_date === '2026-12-04'
      && ev[0].start_time === '18:00' && ev[0].end_time === '20:00' && ev[0].end_date === null && ev[0].ends_next_day === false, JSON.stringify(ev));
    check('the person it names is in charge, created_by "<first name> (email)"', ev[0].responsible_id === SAM && ev[0].participant_ids.length === 0 && ev[0].created_by === 'Alex (email)');
    const rep = replies(s);
    check('one reply, to the sender, as a reply', rep.length === 1 && rep[0].to[0] === 'alex@example.com' && rep[0].subject === 'Re: dinner'
      && rep[0].headers?.['In-Reply-To'] === '<orig-made-up@mail.example>' && rep[0].from === '"Home Hub" <hub@family.example>');
    check('the reply says what was added, with the calendar\'s link', /Dinner at the Lees · Fri Dec 4, 6:00pm–8:00pm/.test(rep[0].text)
      && rep[0].text.includes('https://family.example/hub/#/calendar/2026-12-04'));
    check('job_runs finished: ok, sent 1', s.ops.some((x) => x.table === 'job_runs' && x.op === 'update' && x.args[0].ok === true && x.args[0].sent === 1));
    const c = claudeHits(s)[0];
    const req = c?.body;
    check('Claude: the model, low effort, the schema, fallbacks, the API version', req?.model === INBOX_MODEL && INBOX_MODEL === 'claude-opus-5-5'
      && req.output_config.effort === 'low' && req.output_config.format.type === 'json_schema' && req.fallbacks === 'default'
      && c.init.headers['anthropic-version'] === ANTHROPIC.version && req.system[0].text === INBOX_PROMPT);
    const msg = req?.messages?.[0]?.content as string;
    check('Claude sees today, the time zone and the email, without the quoted part', /Today is Friday, 2026-11-06\. The family's time zone is America\/New_York\./.test(msg)
      && msg.includes('Dinner at the Lees Fri Dec 4, 6-8') && !msg.includes('old stuff') && !msg.includes('Sam wrote'));
    check('no family list and no address reach Claude', !msg.includes('Taylor') && !msg.includes('alex@example.com') && !msg.includes(ALEX) && !INBOX_PROMPT.includes('Lee'));
    check('the console has only fixed codes', logged.every((l) => /^inbox: [a-z_]+( \d+)?$/.test(l)), logged.join(' | '));
  }
  {
    const s = setup({ claude: jsonRes(200, answer([{ ...DINNER, people: [] }])) });
    await run(s, webhook());
    check('no one named: the sender is in charge', inserts(s, 'events')[0]?.responsible_id === ALEX);
  }
  {
    const s = setup({ claude: jsonRes(200, answer([{ ...DINNER, people: ['taylor', 'Sam Lee', 'Grandma'] }])) });
    await run(s, webhook());
    const e = inserts(s, 'events')[0];
    check('several named: the first in charge, the others along, an unknown name left out', e?.responsible_id === TAYLOR && e.participant_ids.join() === SAM);
  }
  {
    const s = setup({ mail: received({ text: '', html: '<div>Soccer <b>Sat</b> 9-11am</div>' }), claude: jsonRes(200, answer([{ ...DINNER, title: 'Soccer' }])) });
    await run(s, webhook());
    check('an html-only email is read as text', (claudeHits(s)[0]?.body.messages[0].content as string).includes('Soccer Sat 9-11am'));
  }

  // ---- Stops
  {
    const s = setup({ seen: true });
    await run(s, webhook());
    check('the same email again: nothing read, added or sent', !s.hits.length && !inserts(s, 'events').length && !inserts(s, 'job_runs').length);
  }
  {
    const s = setup({ mail: received({ from: 'Stranger <stranger@elsewhere.example>' }) });
    await run(s, webhook());
    check('a sender who can\'t sign in: nothing added, no answer, no Claude', !inserts(s, 'events').length && !replies(s).length && !claudeHits(s).length);
  }
  {
    const s = setup({ mail: received({ from: 'Alex at work <Alex.Lee@Work.example>' }), env: { INBOX_ALSO_FROM: 'alex.lee@work.example=alex@example.com, x@y.example=sam@example.com' } });
    await run(s, webhook());
    const e = inserts(s, 'events')[0];
    const rep = replies(s);
    check('INBOX_ALSO_FROM: a second address counts as the member (created_by, in charge when no one is named)', e?.created_by === 'Alex (email)'
      && inserts(s, 'events').length === 1);
    check('INBOX_ALSO_FROM: the reply goes to the address that wrote', rep.length === 1 && rep[0].to[0] === 'alex.lee@work.example');
  }
  {
    const s = setup({ mail: received({ from: 'Alex at work <alex.lee@work.example>' }), env: { INBOX_ALSO_FROM: 'other@work.example=alex@example.com' } });
    await run(s, webhook());
    check('an address INBOX_ALSO_FROM doesn\'t name is still a stranger: nothing added, no answer', !inserts(s, 'events').length && !replies(s).length);
  }
  {
    const s = setup({ mail: received({ from: 'Mallory <x@work.example>' }), env: { INBOX_ALSO_FROM: 'x@work.example=nobody@example.com' } });
    await run(s, webhook());
    check('INBOX_ALSO_FROM pointing at an address that can\'t sign in: nothing added, no answer', !inserts(s, 'events').length && !replies(s).length);
  }
  {
    const s = setup({ mail: received({ from: 'Alex at work <alex.lee@work.example>', headers: { 'authentication-results': 'mx.example; dmarc=fail' } }),
      env: { INBOX_ALSO_FROM: 'alex.lee@work.example=alex@example.com' } });
    await run(s, webhook());
    check('INBOX_ALSO_FROM: a forged second address is still dropped', !inserts(s, 'events').length && !replies(s).length);
  }
  {
    const s = setup({ mail: received({ headers: { 'authentication-results': 'mx.example; spf=pass; dkim=fail; dmarc=fail' } }) });
    await run(s, webhook());
    check('a forged sender (dmarc=fail): nothing added, no answer', !inserts(s, 'events').length && !replies(s).length && !claudeHits(s).length);
  }
  {
    const s = setup({ count: INBOX_DAY_MAX });
    await run(s, webhook());
    const rep = replies(s);
    check(`the day's ${INBOX_DAY_MAX}: nothing added, no Claude, an answer that says so`, !inserts(s, 'events').length && !claudeHits(s).length
      && rep.length === 1 && rep[0].text.includes(`${INBOX_DAY_MAX} events a day`));
    check('the limit counts the last 24 hours of "(email)" events', s.ops.some((x) => x.table === 'events' && x.op === 'select'
      && x.filters.some((f) => f[0] === 'like' && f[2] === '% (email)') && x.filters.some((f) => f[0] === 'gte' && f[2] === new Date(NOW - 86400000).toISOString())));
  }
  {
    const s = setup({ claude: jsonRes(200, answer([], 'I couldn\'t tell which day you meant.')) });
    await run(s, webhook());
    const rep = replies(s);
    check('nothing Claude can add: the reason in the answer, nothing added', !inserts(s, 'events').length && rep.length === 1 && rep[0].text.includes('which day you meant'));
  }
  {
    const s = setup({ claude: jsonRes(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) });
    await run(s, webhook());
    const rep = replies(s);
    check('Claude failing: a sorry answer, nothing added, run not ok', !inserts(s, 'events').length && rep.length === 1 && /couldn't read/.test(rep[0].text)
      && s.ops.some((x) => x.table === 'job_runs' && x.op === 'update' && x.args[0].ok === false));
  }
  {
    const s = setup({ mailStatus: 404 });
    await run(s, webhook());
    check('the email not found at Resend: nothing added, no answer', !inserts(s, 'events').length && !replies(s).length);
  }
  {
    const s = setup({ insertFail: true });
    await run(s, webhook());
    check('the insert failing: a sorry answer', /couldn't save/.test(replies(s)[0]?.text ?? ''));
  }

  // ---- The answer's checks
  const T = '2026-11-06';
  const one = (e: Record<string, unknown>) => checkEvents({ events: [{ ...DINNER, ...e }], problem: '' }, T).events;
  check('a date that isn\'t one, or out of range, is dropped', !one({ date: '2026-02-30' }).length && !one({ date: '2026-11-04' }).length
    && one({ date: '2026-11-05' }).length === 1 && !one({ date: '2027-12-12' }).length);
  check('no title: dropped; a long one cut to 100', !one({ title: '  ' }).length && one({ title: 'x'.repeat(150) })[0].title.length === 100);
  check('11pm to 1am ends the next day', one({ start_time: '23:00', end_time: '01:00' })[0].ends_next_day === true);
  check('equal times: no end', one({ start_time: '18:00', end_time: '18:00' })[0].end_time === null);
  check('a bad time is an all-day event', one({ start_time: '6pm', end_time: '20:00' })[0].start_time === null && one({ start_time: '6pm' })[0].end_time === null);
  check('several days only when all day', one({ start_time: '', end_time: '', end_date: '2026-12-06' })[0].end_date === '2026-12-06'
    && one({ end_date: '2026-12-06' })[0].end_date === null && one({ start_time: '', end_date: '2026-12-01' })[0].end_date === null);
  check(`at most ${INBOX_EVENTS_MAX} events`, checkEvents({ events: Array(9).fill(DINNER), problem: '' }, T).events.length === INBOX_EVENTS_MAX);
  check('junk is no events', checkEvents(null, T).events.length === 0 && checkEvents({ events: 'x' }, T).events.length === 0);

  // ---- Helpers
  check('address: from a display name, lower case', address('Alex Lee <Alex@Example.com>') === 'alex@example.com' && address('sam@example.com') === 'sam@example.com' && address('nobody') === '');
  check('alsoFrom: pairs by comma, semicolon or line, display names and case aside; junk and self-maps left out',
    [...alsoFrom('A@Work.example=Alex <alex@example.com>; b@w.example = sam@example.com\nnot a pair, c@x.example=c@x.example, =d@e.example').entries()].map((x) => x.join('>')).join() === 'a@work.example>alex@example.com,b@w.example>sam@example.com'
    && alsoFrom(undefined).size === 0);
  check('emailText drops quoted lines and what follows "On … wrote:"', emailText('a\n> b\nc\nOn Mon, Nov 2, 2026 at 9:00 AM Sam <s@example.com> wrote:\nd') === 'a\nc');
  check('htmlText reads tags and entities', htmlText('<p>Tea &amp; cake</p><style>x{}</style><br>at 4') === 'Tea & cake\n\nat 4');
  check('matchPeople: by first or full name, ignoring case and accents', matchPeople(['SAM', 'taylor', 'Zoë'], [...PEOPLE, { id: 'z', name: 'Zoe', email: null }]).map((p) => p.id).join() === `${SAM},${TAYLOR},z`);
  check('eventLine: all day, several days, a place', eventLine({ title: 'Camp', start_date: '2026-12-01', end_date: '2026-12-03', start_time: null, end_time: null, ends_next_day: false, location: 'Lake', people: [] }) === 'Camp · Tue Dec 1 to Thu Dec 3 · Lake'
    && eventLine({ title: 'Fair', start_date: '2026-12-05', end_date: null, start_time: null, end_time: null, ends_next_day: false, location: null, people: [] }) === 'Fair · Sat Dec 5, all day');
  check('forged: dmarc=fail, or spf=fail without dkim=pass; no header passes', forged({ 'Authentication-Results': 'dmarc=fail' })
    && forged([{ name: 'authentication-results', value: 'spf=fail; dkim=none' }]) && !forged({ 'authentication-results': 'spf=fail; dkim=pass' }) && !forged({}));
  check('today in the household\'s time zone', today(Date.parse('2026-11-07T03:00:00Z'), 'America/New_York').date === '2026-11-06'
    && today(Date.parse('2026-11-07T03:00:00Z'), 'America/New_York').weekday === 'Friday');

  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
