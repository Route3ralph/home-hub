// Unit tests for hub-jobs' homework_ai action (supabase/functions/hub-jobs/homework.ts; docs/v1.3-homework.md §6),
// through handle() as the Edge Function runs it: a fake Anthropic host behind the injected fetch, a fake database
// answering homework_ai_start and homework_ai_finish with the shapes migration 0005 returns, a fake clock and sleep,
// and deps.background collected so each run's work can be awaited.
// Covered: who may ask (no sign-in, a member who isn't an admin, Test with a token, a malformed token with no SQL, a
// token SQL doesn't know with no call to Anthropic); no ANTHROPIC_API_KEY (not_set_up, no SQL); 0005 not applied
// (503 no_schema); cap, busy and a resent key (no call); the request exactly (the URL, the four headers, the model
// constant, max_tokens, output_config with effort and the schema, fallbacks 'default', the cached system block, the
// system prompt byte-identical for plan, revise and test and equal to §6.6, the user content equal to the RPC's
// input.message, nothing else); privacy (no name, school, teacher, link, email, phone or uuid-shaped string in the
// request); every answer rule of §6.8; refusals and max_tokens; each HTTP answer's code, with one retry only after a
// 429 or a 529; timeouts; the cost from usage.iterations; the 202 before the call ends; homework_ai_finish tried twice
// with only a fixed code logged; nothing personal in any console line; every RPC through deps.service(); no U+2028 or
// U+2029 escape anywhere in hub-jobs; no outside import; no label words in the prompt, the schema or this file's
// fixtures (the word list lives only in tests/docs/labels.test.js, which reads this file too).
// Everything is made up: the household (Alex the parent, Jordan the kid, Pat Lee the tutor), the school's name, the
// teacher, example.com addresses and 555-01xx numbers.
// Run alone with: node --experimental-strip-types tests/fn/homework-ai.test.ts
import { handle } from '../../supabase/functions/hub-jobs/handler.ts';
import {
  HOMEWORK_MODEL, ANTHROPIC, AI_LIMITS, SYSTEM_PROMPT, PLAN_SCHEMA, PRICES, buildRequest, checkPlan, classify, estimateCents, cutOff, OPEN_RUNS,
} from '../../supabase/functions/hub-jobs/homework.ts';
import { readFileSync, readdirSync } from 'node:fs';

const results: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' && !ok ? `  (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)})` : ''}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------
const KEY = 'sk-ant-made-up-key-0000000000000000';         // the Anthropic key, made up
const NOW = Date.parse('2026-11-02T21:40:00Z');
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ASG = 'bbbbbbbb-0000-4000-8000-000000000002';
const REQ_KEY = 'cccccccc-0000-4000-8000-000000000003';
const PAT = 'abcdef0123456789abcdef0123456789';
const MARKER = 'MARKER-7f3a-river';                         // in the teacher's text: never in a console line
const ADMIN_JWT = 'Bearer eyJ.admin.sig';
const MEMBER_JWT = 'Bearer eyJ.member.sig';
const ANON_KEY = 'Bearer sb_publishable_made_up';

// What homework_ai_start hands over: the fields and the one message (already scrubbed by private.ai_input).
const FIELDS = {
  today: 'Mon 2026-11-02', due: 'Fri 2026-11-13 (11 days away)', kind: 'assignment', subject: 'Science', language: 'en',
  session_minutes: 20, pace: 'Past steps took about 1.3 times the planned time.',
  free_time: ['Tue 2026-11-03: 45 min free', 'Wed 2026-11-04: 45 min free', 'Thu 2026-11-05: 20 min free', 'Mon 2026-11-09: 45 min free'],
  assignment_title: 'River poster', assignment_text: `Make a poster about one river. ${MARKER}\nAsk [name] if you need help.`,
  current_plan: null, request: null, answers: [],
};
const MESSAGE = [
  '<today>Mon 2026-11-02</today>', '<due>Fri 2026-11-13 (11 days away)</due>', '<kind>assignment</kind>', '<subject>Science</subject>',
  '<language>en</language>', '<session_minutes>20</session_minutes>', '<pace>Past steps took about 1.3 times the planned time.</pace>',
  '<free_time>', ...FIELDS.free_time, '</free_time>', '<assignment_title>River poster</assignment_title>',
  '<assignment_text>', `Make a poster about one river. ${MARKER}`, 'Ask [name] if you need help.', '</assignment_text>',
].join('\n');
const LOCKED = [
  { ref: 's1', title: 'Find 2 sources and save their links', done_looks_like: '2 titles in your notes', minutes: 20, day: '2026-11-03', kind: 'step', locked: true },
  { ref: 's2', title: 'Sketch the layout', done_looks_like: 'a sketch on paper', minutes: 15, day: '2026-11-04', kind: 'step', locked: false },
  { ref: 's3', title: 'Outline with 3 main points', done_looks_like: 'an outline you can show', minutes: 20, day: '2026-11-05', kind: 'milestone', locked: true },
];
const REVISE_FIELDS = Object.assign({}, FIELDS, { current_plan: LOCKED, request: '<request from="tutor">Smaller steps</request>' });

const step = (o: Record<string, unknown>) => Object.assign({ ref: 'new', title: 'Copy the requirements into your notes', done_looks_like: 'the list in your notes', minutes: 10, day: '2026-11-03', kind: 'step' }, o);
const PLAN = {
  summary: 'Make a poster about one river with two sources.',
  questions: ['Did your teacher say which materials are allowed?'],
  steps: [
    step({ kind: 'start', title: 'Copy the requirements into your notes', minutes: 10 }),
    step({ title: 'Find 2 sources and save their titles', done_looks_like: '2 titles in your notes', minutes: 20 }),
    step({ kind: 'milestone', title: 'Outline with 3 main points', done_looks_like: 'an outline you can show', minutes: 20, day: '2026-11-04' }),
    step({ kind: 'check', title: 'Check it against the instructions', done_looks_like: 'every point ticked', minutes: 15, day: '2026-11-09' }),
    step({ kind: 'turn_in', title: 'Turn it in', done_looks_like: 'the poster handed in', minutes: 5, day: '2026-11-13' }),
  ],
  stretch: 'Which part of the river would you most like to show in detail?',
  fits: true,
  note_for_adult: '',
};
const anthropicOk = (plan: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'msg_made_up', type: 'message', role: 'assistant', model: HOMEWORK_MODEL,
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: JSON.stringify(plan) }],
  stop_reason: 'end_turn', stop_details: null,
  usage: { input_tokens: 900, output_tokens: 2400, cache_read_input_tokens: 1600, cache_creation_input_tokens: 0 },
  ...extra,
});

// ---------------------------------------------------------------------
// The harness: a fake database, Anthropic behind fetch, background collected
// ---------------------------------------------------------------------
type Call = { fn: string; args: any; via: string };
type Hit = { url: string; init: any; body: any };
type Reply = Response | (() => Response | Promise<Response>) | Error;

function setup(opts: { start?: any; finishFail?: number; env?: Record<string, string | undefined>; replies?: Reply[]; admin?: boolean; noBackground?: boolean } = {}) {
  const calls: Call[] = [];
  const hits: Hit[] = [];
  const waits: number[] = [];
  const bg: Promise<unknown>[] = [];
  const clock = { t: NOW };
  let finishFail = opts.finishFail ?? 0;
  const replies = (opts.replies ?? [json(200, anthropicOk(PLAN))]).slice();
  const db = (via: string) => ({
    rpc(fn: string, args?: any) {
      calls.push({ fn, args, via });
      if (via !== 'service') return Promise.resolve({ data: null, error: { message: 'not this client', code: '42501' } });
      if (fn === 'homework_ai_start') return Promise.resolve(opts.start ?? { data: { run_id: RUN, input: { fields: FIELDS, message: MESSAGE } }, error: null });
      if (fn === 'homework_ai_finish') {
        if (finishFail > 0) { finishFail--; return Promise.resolve({ data: null, error: { message: `connection reset ${MARKER}`, code: '08006' } }); }
        return Promise.resolve({ data: { ok: true, state: args.p_stop ? 'failed' : 'ready', stop: args.p_stop }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected ${fn}`, code: 'PGRST202' } });
    },
    from() { throw new Error('no table reads in the homework_ai action'); },
  });
  const service = db('service');
  const fetchFake = async (input: string | URL, init: any = {}) => {
    const url = String(input);
    let body: any = null;
    try { body = JSON.parse(init.body); } catch { body = init.body; }
    hits.push({ url, init, body });
    const r = replies.length > 1 ? replies.shift()! : replies[0];
    if (r instanceof Error) throw r;
    const res = typeof r === 'function' ? await r() : r;
    return res.clone();
  };
  const env: Record<string, string | undefined> = Object.assign({ ANTHROPIC_API_KEY: KEY, SUPABASE_URL: 'https://project.example', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_made_up"}' }, opts.env);
  const deps: any = {
    env: (n: string) => env[n],
    fetch: fetchFake as unknown as typeof fetch,
    service: () => service,
    user: (authorization: string) => ({
      rpc: (fn: string) => {
        calls.push({ fn, args: null, via: 'user' });
        if (fn !== 'whoami') return Promise.resolve({ data: null, error: null });
        if (authorization === ADMIN_JWT) return Promise.resolve({ data: { email: 'Alex@Example.com', role: 'admin' }, error: null });
        if (authorization === MEMBER_JWT) return Promise.resolve({ data: { email: 'sam@example.com', role: 'member' }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
    }),
    now: () => clock.t,
    sleep: (ms: number) => { waits.push(ms); clock.t += ms; return Promise.resolve(); },
  };
  if (!opts.noBackground) deps.background = (p: Promise<unknown>) => { bg.push(p); };
  return { deps, calls, hits, waits, bg, clock };
}
function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
const apiError = (status: number, type: string, message: string, headers: Record<string, string> = {}, details?: unknown) =>
  json(status, { type: 'error', error: Object.assign({ type, message }, details ? { details } : {}), request_id: 'req_made_up' }, headers);
const post = (body: Record<string, unknown>, authorization?: string) => new Request('https://project.example/functions/v1/hub-jobs', {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authorization ? { Authorization: authorization } : {}), body: JSON.stringify(body),
});
const ask = (o: Record<string, unknown> = {}) => Object.assign({ action: 'homework_ai', kind: 'plan', assignment_id: ASG, key: REQ_KEY }, o);

// The console, while the action runs: every line kept, to look for anything personal.
const logged: string[] = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
function quiet() { for (const k of Object.keys(realConsole) as (keyof typeof realConsole)[]) (console as any)[k] = (...a: unknown[]) => logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }
function loud() { Object.assign(console, realConsole); }
async function run(s: ReturnType<typeof setup>, req: Request) {
  quiet();
  try {
    const res = await handle(req, s.deps);
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    const at = s.hits.length;
    await Promise.all(s.bg);
    return { status: res.status, body, hitsAtAnswer: at };
  } finally {
    loud();
  }
}
const finishes = (s: ReturnType<typeof setup>) => s.calls.filter((c) => c.fn === 'homework_ai_finish').map((c) => c.args);
const starts = (s: ReturnType<typeof setup>) => s.calls.filter((c) => c.fn === 'homework_ai_start').map((c) => c.args);
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const keepAlive = setInterval(() => { /* waiting */ }, 1000);

(async () => {
  // ---- The constants (§6.5, §6.7)
  check('the model is one constant, claude-opus-5-5', HOMEWORK_MODEL === 'claude-opus-5-5');
  check('Anthropic: the Messages endpoint, API version 2026-10-21, the default-fallback beta',
    ANTHROPIC.url === 'https://api.anthropic.com/v1/messages' && ANTHROPIC.version === '2026-10-21' && ANTHROPIC.beta === 'server-side-fallback-2026-07-01');
  check('limits: 120 s a call, a 300-second run, 12000 max_tokens', AI_LIMITS.callMs === 120000 && AI_LIMITS.budgetMs === 300000 && AI_LIMITS.maxTokens === 12000);
  check('prices: $4/$20 a million for claude-opus-5-5, $5/$25 for claude-opus-5 and claude-opus-4-8',
    PRICES['claude-opus-5-5'].in === 4 && PRICES['claude-opus-5-5'].out === 20 && PRICES['claude-opus-5'].in === 5 && PRICES['claude-opus-5'].out === 25
    && PRICES['claude-opus-4-8'].in === 5 && PRICES['claude-opus-4-8'].out === 25);
  const doc = readFileSync(new URL('../../docs/v1.3-homework.md', import.meta.url), 'utf8');
  const docPrompt = (/### 6\.6 The prompt[\s\S]*?```text\n([\s\S]*?)\n```/.exec(doc) || [])[1];
  check('the system prompt is §6.6\'s text, byte for byte', !!docPrompt && SYSTEM_PROMPT === docPrompt, docPrompt ? 'differs' : 'no §6.6 block');
  const docSchema = (/### 6\.7 The output schema[\s\S]*?```json\n([\s\S]*?)\n```/.exec(doc) || [])[1];
  check('the schema is §6.7\'s', !!docSchema && same(PLAN_SCHEMA, JSON.parse(docSchema)));
  const objects: any[] = [];
  const walk = (x: any) => { if (x && typeof x === 'object') { if (x.type === 'object') objects.push(x); Object.values(x).forEach(walk); } };
  walk(PLAN_SCHEMA);
  check('... every object has additionalProperties: false and lists every property as required', objects.length === 2
    && objects.every((o) => o.additionalProperties === false && same(Object.keys(o.properties).sort(), [...o.required].sort())));
  check('... with none of the keywords structured outputs refuse (minLength, maxLength, minimum, maximum, maxItems, minItems)',
    !/"(minLength|maxLength|minimum|maximum|maxItems|minItems|multipleOf|pattern)"/.test(JSON.stringify(PLAN_SCHEMA)));
  check('the system prompt holds no date, no name and no number of a household (its bytes never change)',
    !/\b20\d\d-\d\d-\d\d\b|Jordan|Alex|Morgan|Pat\b|Lee\b|Sam\b|Taylor|@|555-01/.test(SYSTEM_PROMPT));

  // ---- The request, exactly
  {
    let open: () => void = () => {};
    const gate = new Promise<void>((done) => { open = done; });
    const s = setup({ replies: [async () => { await gate; return json(200, anthropicOk(PLAN)); }] });
    quiet();
    const res = await handle(post(ask(), ADMIN_JWT), s.deps);
    const early = { status: res.status, finished: finishes(s).length, bg: s.bg.length };
    loud();
    open();
    const r = await run(s, new Request('https://project.example/unused', { method: 'OPTIONS' }));
    const answered = await res.json();
    check('a parent\'s plan: 202 {run_id} at once', early.status === 202 && answered.run_id === RUN && r.status === 200, early);
    check('... while the call to Anthropic is still on its way (the work is in deps.background)', early.finished === 0 && early.bg === 1 && s.hits.length === 1, early);
    check('... homework_ai_start as service_role with the admin\'s email, the assignment, kind, request, answers and key',
      same(starts(s), [{ p_token: null, p_email: 'alex@example.com', p_assignment: ASG, p_kind: 'plan', p_request: null, p_answers: null, p_key: REQ_KEY }])
      && s.calls.filter((c) => c.fn.startsWith('homework_ai_')).every((c) => c.via === 'service'), starts(s));
    const h = s.hits[0];
    const hdr = h.init.headers as Record<string, string>;
    check('POST https://api.anthropic.com/v1/messages', h.url === 'https://api.anthropic.com/v1/messages' && h.init.method === 'POST', h.url);
    check('the four headers: x-api-key, anthropic-version 2026-10-21, anthropic-beta server-side-fallback-2026-07-01, content-type',
      same(Object.keys(hdr).map((k) => k.toLowerCase()).sort(), ['anthropic-beta', 'anthropic-version', 'content-type', 'x-api-key'])
      && hdr['x-api-key'] === KEY && hdr['anthropic-version'] === '2026-10-21' && hdr['anthropic-beta'] === 'server-side-fallback-2026-07-01'
      && hdr['content-type'] === 'application/json', hdr);
    check('... a timeout on the call (an AbortSignal)', !!h.init.signal && typeof h.init.signal.aborted === 'boolean');
    const b = h.body;
    check('the body\'s keys: model, max_tokens, system, messages, output_config, fallbacks; nothing else',
      same(Object.keys(b).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']), Object.keys(b));
    check('model claude-opus-5-5, max_tokens 12000, fallbacks \'default\'', b.model === 'claude-opus-5-5' && b.max_tokens === 12000 && b.fallbacks === 'default');
    check('output_config: effort medium and the schema as json_schema', same(b.output_config, { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } }), b.output_config);
    check('system: one text block, the prompt, cached (ephemeral)', same(b.system, [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]));
    check('messages: one user message, input.message as it is', same(b.messages, [{ role: 'user', content: MESSAGE }]), b.messages);
    check('no thinking, temperature, top_p, top_k, tools, tool_choice or stream',
      ['thinking', 'temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'stream'].every((k) => !(k in b)));
    check('buildRequest gives the same body', same(buildRequest(MESSAGE), b));
    const f = finishes(s);
    check('... then homework_ai_finish once: the run, no stop, the checked draft, the usage with cents, the model', f.length === 1 && f[0].p_run === RUN && f[0].p_stop === null
      && f[0].p_model === 'claude-opus-5-5' && Array.isArray(f[0].p_draft.steps) && f[0].p_draft.steps.length === 5
      && f[0].p_usage.input_tokens === 900 && f[0].p_usage.output_tokens === 2400 && f[0].p_usage.cache_read_input_tokens === 1600
      && f[0].p_usage.cache_creation_input_tokens === 0 && typeof f[0].p_usage.cents === 'number', f);
    // 900 × $4 + 1,600 × $0.20 + 2,400 × $20, a million each: $0.05192 → 5.19 cents.
    check('... cents at Opus 5.5\'s prices (cache reads at $0.20 a million): 5.19', f[0].p_usage.cents === 5.19, f[0].p_usage);
    check('... the draft keeps the schema\'s keys and the steps their refs', same(Object.keys(f[0].p_draft).sort(), ['fits', 'note_for_adult', 'questions', 'steps', 'stretch', 'summary'])
      && f[0].p_draft.steps.every((x: any) => x.ref === 'new'), f[0].p_draft);
  }

  // ---- The system prompt is the same bytes for plan, revise and test; privacy
  {
    const bodies: any[] = [];
    for (const [kind, fields] of [['plan', FIELDS], ['revise', REVISE_FIELDS], ['test', FIELDS]] as const) {
      const s = setup({ start: { data: { run_id: RUN, input: { fields, message: MESSAGE + (kind === 'revise' ? '\n<request from="tutor">Smaller steps</request>' : '') } }, error: null } });
      await run(s, post(ask({ kind, assignment_id: kind === 'test' ? undefined : ASG }), ADMIN_JWT));
      bodies.push(s.hits[0] && s.hits[0].body);
    }
    check('the system block is byte-identical for plan, revise and test (so the cache is read)', bodies.every((b) => b && same(b.system, bodies[0].system)) && same(bodies[0].system, bodies[2].system));
    check('... and so are the model, max_tokens, output_config and fallbacks', bodies.every((b) => same([b.model, b.max_tokens, b.output_config, b.fallbacks], [bodies[0].model, bodies[0].max_tokens, bodies[0].output_config, bodies[0].fallbacks])));
    const all = JSON.stringify(bodies);
    check('privacy: no name, school, teacher, link, email, phone, token, key or uuid-shaped string in any request',
      !/Jordan|Alex|Morgan|Taylor|Pat Lee|North Field|Rivera|example\.com|555-01|https?:\/\/(?!json)/.test(all.replace(/\[name\]/g, '')) && !all.includes(PAT) && !all.includes(KEY) && !UUID_ANY.test(all),
      all.match(UUID_ANY) || all.slice(0, 200));
  }

  // ---- Who may ask (§6.2 steps 1 to 3)
  {
    let s = setup();
    let r = await run(s, post(ask()));
    check('no Authorization and no token → 401, nothing called', r.status === 401 && s.calls.length === 0 && s.hits.length === 0, r);
    s = setup();
    r = await run(s, post(ask(), MEMBER_JWT));
    check('a member who isn\'t an admin → 403, no SQL and no call', r.status === 403 && !starts(s).length && s.hits.length === 0, r);
    s = setup();
    r = await run(s, post(ask(), ANON_KEY));
    check('the publishable key alone (no sign-in) → 403', r.status === 403 && !starts(s).length, r);
    s = setup();
    r = await run(s, post(ask({ kind: 'test', token: PAT, assignment_id: undefined }), ANON_KEY));
    check('Test from a tutor link → 403 (parents only)', r.status === 403 && !starts(s).length && s.hits.length === 0, r);
    for (const bad of ['abc', PAT.toUpperCase() + 'x', `${PAT.slice(0, 31)}g`, 42, '']) {
      s = setup();
      r = await run(s, post(ask({ token: bad }), ANON_KEY));
      check(`a malformed token (${JSON.stringify(bad)}) → 200 not_found with no SQL`, r.status === 200 && r.body.stop === 'not_found' && s.calls.length === 0 && s.hits.length === 0, r);
    }
    s = setup({ start: { data: { stop: 'not_found' }, error: null } });
    r = await run(s, post(ask({ token: PAT }), ANON_KEY));
    check('a well-formed token goes to SQL as it is (with no email); SQL\'s not_found → 200 not_found, no call to Anthropic',
      r.status === 200 && r.body.stop === 'not_found' && same(starts(s)[0], { p_token: PAT, p_email: null, p_assignment: ASG, p_kind: 'plan', p_request: null, p_answers: null, p_key: REQ_KEY })
      && s.hits.length === 0 && !s.calls.some((c) => c.fn === 'whoami'), [r, starts(s)]);
    s = setup();
    r = await run(s, post(ask({ token: PAT, kind: 'revise', request: 'Smaller steps', answers: ['Markers only'] }), ANON_KEY));
    check('Pat\'s revise: 202, with the request and the answers passed on', r.status === 202 && starts(s)[0].p_request === 'Smaller steps' && same(starts(s)[0].p_answers, ['Markers only']), starts(s));
    s = setup({ env: { ANTHROPIC_API_KEY: undefined } });
    r = await run(s, post(ask(), ADMIN_JWT));
    check('no ANTHROPIC_API_KEY → 200 not_set_up, and no SQL', r.status === 200 && r.body.stop === 'not_set_up' && !starts(s).length && s.hits.length === 0, r);
    s = setup({ env: { ANTHROPIC_API_KEY: '   ' } });
    r = await run(s, post(ask({ token: PAT }), ANON_KEY));
    check('... a blank one too, for Pat\'s link', r.status === 200 && r.body.stop === 'not_set_up' && s.calls.length === 0, r);
    s = setup({ env: { SUPABASE_SECRET_KEYS: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined } });
    r = await run(s, post(ask(), ADMIN_JWT));
    check('no service key → 503', r.status === 503 && !starts(s).length, r);
    s = setup({ start: { data: null, error: { message: 'Could not find the function public.homework_ai_start', code: 'PGRST202' } } });
    r = await run(s, post(ask(), ADMIN_JWT));
    check('0005 not applied yet → 503 {stop: no_schema}', r.status === 503 && r.body.stop === 'no_schema' && s.hits.length === 0, r);
    s = setup({ start: { data: null, error: { message: 'deadlock detected', code: '40P01' } } });
    r = await run(s, post(ask(), ADMIN_JWT));
    check('another database error → 500 {stop: error}, with a fixed message', r.status === 500 && r.body.stop === 'error' && !/deadlock/.test(JSON.stringify(r.body)), r);
    for (const stop of ['off', 'cap', 'month']) {
      s = setup({ start: { data: { stop }, error: null } });
      r = await run(s, post(ask(), ADMIN_JWT));
      check(`SQL's ${stop} → 200 {stop: ${stop}}, no call`, r.status === 200 && r.body.stop === stop && s.hits.length === 0 && !s.bg.length, r);
    }
    s = setup({ start: { data: { stop: 'busy', run_id: RUN }, error: null } });
    r = await run(s, post(ask(), ADMIN_JWT));
    check('busy → 200 {stop: busy, run_id}, no call', r.status === 200 && r.body.stop === 'busy' && r.body.run_id === RUN && s.hits.length === 0, r);
    s = setup({ start: { data: { run_id: RUN }, error: null } });
    r = await run(s, post(ask(), ADMIN_JWT));
    check('a resent key (SQL answers the run with no input) → 202 {run_id}, nothing started again', r.status === 202 && r.body.run_id === RUN && s.hits.length === 0 && !s.bg.length && !finishes(s).length, r);
  }

  // ---- The shape, before any work (§6.2 step 1)
  {
    const bad: [string, Record<string, unknown>][] = [
      ['a bad kind', ask({ kind: 'essay' })], ['no kind', ask({ kind: undefined })], ['a bad key', ask({ key: 'not-a-uuid' })], ['no key', ask({ key: undefined })],
      ['no assignment for a plan', ask({ assignment_id: undefined })], ['a bad assignment id', ask({ assignment_id: 'x' })],
      ['a 201-character request', ask({ kind: 'revise', request: 'a'.repeat(201) })], ['a request that isn\'t text', ask({ kind: 'revise', request: { x: 1 } })],
      ['four answers', ask({ answers: ['a', 'b', 'c', 'd'] })], ['a 201-character answer', ask({ answers: ['é'.repeat(201)] })], ['answers that aren\'t a list', ask({ answers: 'yes' })],
    ];
    for (const [name, b] of bad) {
      const s = setup();
      const r = await run(s, post(b, ADMIN_JWT));
      check(`${name} → 400 before any work`, r.status === 400 && s.calls.length === 0 && s.hits.length === 0, r);
    }
    const s = setup();
    const r = await run(s, post(ask({ kind: 'revise', request: 'é'.repeat(200), answers: ['ü'.repeat(200), '', 'x'] }), ADMIN_JWT));
    check('200 characters of request and of each answer are fine (counted as characters)', r.status === 202, r);
  }

  // ---- The answer's checks (§6.8), on checkPlan directly
  {
    const ok = (p: unknown, f: any = FIELDS) => checkPlan(p, f);
    const steps = (o: any) => Object.assign({}, PLAN, o);
    const good = ok(PLAN);
    check('a good plan passes, as the draft homework_ai_finish takes', !!good && good.steps.length === 5 && good.summary === PLAN.summary, good);
    check('parses as the schema\'s object: a list, a string, a missing key or an extra key → invalid',
      ok([PLAN]) === null && ok('{}') === null && ok(Object.assign({}, PLAN, { fits: undefined })) === null && ok(Object.assign({}, PLAN, { extra: 1 })) === null);
    const thirteen = Array.from({ length: 13 }, (_, i) => step({ kind: i === 0 ? 'start' : i === 12 ? 'turn_in' : 'step', minutes: i === 0 || i === 12 ? 5 : 15 }));
    check('13 steps → invalid; 12 are fine', ok(steps({ steps: thirteen })) === null && !!ok(steps({ steps: thirteen.slice(0, 11).concat([thirteen[12]]) })));
    check('no steps → invalid', ok(steps({ steps: [] })) === null);
    check('an assignment with no turn-in → invalid', ok(steps({ steps: PLAN.steps.slice(0, 4) })) === null);
    check('two turn-ins → invalid', ok(steps({ steps: PLAN.steps.concat([PLAN.steps[4]]) })) === null);
    check('a turn-in that isn\'t last → invalid', ok(steps({ steps: [PLAN.steps[0], PLAN.steps[4], PLAN.steps[1]] })) === null);
    check('a lesson may have no turn-in', !!ok(steps({ steps: PLAN.steps.slice(0, 4) }), Object.assign({}, FIELDS, { kind: 'lesson' })));
    check('3 steps or more that don\'t start with a start → invalid', ok(steps({ steps: PLAN.steps.slice(1) })) === null);
    check('5 milestones → invalid', ok(steps({ steps: [PLAN.steps[0], ...Array.from({ length: 5 }, () => step({ kind: 'milestone', minutes: 20 })), PLAN.steps[4]] })) === null);
    check('a kind outside the five → invalid', ok(steps({ steps: [PLAN.steps[0], step({ kind: 'essay' }), PLAN.steps[4]] })) === null);
    check('a title of 2 characters, or 81 → invalid', ok(steps({ steps: [PLAN.steps[0], step({ title: 'Go' }), PLAN.steps[4]] })) === null
      && ok(steps({ steps: [PLAN.steps[0], step({ title: 'W'.repeat(81) }), PLAN.steps[4]] })) === null);
    check('"done looks like" of 2 characters, or 161 → invalid', ok(steps({ steps: [PLAN.steps[0], step({ done_looks_like: 'ok' }), PLAN.steps[4]] })) === null
      && ok(steps({ steps: [PLAN.steps[0], step({ done_looks_like: 'd'.repeat(161) }), PLAN.steps[4]] })) === null);
    check('an empty summary, or 301 characters → invalid', ok(steps({ summary: '' })) === null && ok(steps({ summary: 's'.repeat(301) })) === null);
    check('four questions, or one of 161 characters → invalid', ok(steps({ questions: ['a?', 'b?', 'c?', 'd?'] })) === null && ok(steps({ questions: ['q'.repeat(161)] })) === null);
    check('a stretch of 161 characters → invalid; an empty one is fine', ok(steps({ stretch: 's'.repeat(161) })) === null && !!ok(steps({ stretch: '' })));
    check('a 400-character note for the adult → invalid; 300 is fine', ok(steps({ note_for_adult: 'n'.repeat(400) })) === null && !!ok(steps({ note_for_adult: 'n'.repeat(300) })));
    const linky = ok(steps({ steps: [PLAN.steps[0], step({ title: 'Read https://example.com/rubric then note it', done_looks_like: 'Mail teacher@example.com or call (201) 555-0100 with notes' }), PLAN.steps[4]] }));
    check('a link, an email and a phone number in a step are taken out', !!linky && linky.steps[1].title === 'Read then note it'
      && !/example|555|@/.test(JSON.stringify(linky)), linky && linky.steps[1]);
    check('a field left empty by taking a link out → invalid', ok(steps({ steps: [PLAN.steps[0], step({ title: 'https://example.com/a' }), PLAN.steps[4]] })) === null);
    const lines = ok(steps({ summary: 'Two\nlines and\ttabs', note_for_adult: 'x\u0000y' }));
    check('every string on one line (line breaks, U+2028, tabs and controls become spaces)', !!lines && lines.summary === 'Two lines and tabs' && lines.note_for_adult === 'x y', lines && lines.summary);
    const clamp = ok(steps({ steps: [step({ kind: 'start', minutes: 30 }), step({ minutes: 45 }), step({ minutes: 2 }), step({ kind: 'turn_in', minutes: 20 })] }));
    check('minutes clamped: a start to 10, a step to his 20-minute session, at least 5, the turn-in 5', !!clamp && same(clamp.steps.map((x: any) => x.minutes), [10, 20, 5, 5]), clamp && clamp.steps);
    check('minutes that aren\'t a whole number → invalid', ok(steps({ steps: [PLAN.steps[0], step({ minutes: 'ten' }), PLAN.steps[4]] })) === null);
    const nodate = ok(steps({ steps: [PLAN.steps[0], step({ day: 'next Tuesday' }), PLAN.steps[4]] }));
    check('a day that isn\'t a date is left for the database to place (null), never refused', !!nodate && nodate.steps[1].day === null);

    // Locked steps (revise): put back, in their place; the same locked ref twice; unknown refs.
    const back = ok({
      summary: 'A poster.', questions: [], stretch: '', fits: true, note_for_adult: '',
      steps: [
        step({ kind: 'start', title: 'List what is unclear', minutes: 5 }),
        step({ ref: 's1', title: 'Find 3 sources instead', done_looks_like: 'changed', minutes: 25 }),   // locked, changed: put back
        step({ ref: 's2', title: 'Sketch two layouts', done_looks_like: 'two sketches' }),                // not locked: a new step
        step({ ref: 's9', title: 'Draw the river', done_looks_like: 'the river drawn' }),                 // unknown ref: new
        // s3 (locked) dropped by the answer: put back after s2's place
        step({ kind: 'check', title: 'Check it against the instructions', done_looks_like: 'every point ticked', minutes: 15 }),
        step({ kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5 }),
      ],
    }, REVISE_FIELDS);
    check('revise: a changed locked step is put back as the people left it, with its ref', !!back && same(back.steps[1], { ref: 's1', title: LOCKED[0].title, done_looks_like: LOCKED[0].done_looks_like, minutes: 20, day: '2026-11-03', kind: 'step' }), back && back.steps[1]);
    check('... a step the people didn\'t lock is the AI\'s, as a new step', !!back && back.steps[2].ref === 'new' && back.steps[2].title === 'Sketch two layouts');
    check('... a locked step the answer left out is put back in its place (right after the step that came before it)', !!back && back.steps[3] && back.steps[3].ref === 's3'
      && back.steps[3].title === LOCKED[2].title && back.steps[5].kind === 'check' && back.steps.length === 7, back && back.steps.map((x: any) => x.ref + ':' + x.title));
    check('... an unknown ref is treated as new', !!back && back.steps[4].ref === 'new' && back.steps[4].title === 'Draw the river');
    const twice = ok({
      summary: 'A poster.', questions: [], stretch: '', fits: true, note_for_adult: '',
      steps: [step({ kind: 'start', minutes: 5 }), step({ ref: 's1', title: LOCKED[0].title, done_looks_like: LOCKED[0].done_looks_like, minutes: 20 }),
        step({ ref: 's1', title: 'Find more sources', done_looks_like: 'more' }), step({ ref: 's3', title: LOCKED[2].title, done_looks_like: LOCKED[2].done_looks_like, minutes: 20, kind: 'milestone' }),
        step({ kind: 'turn_in', minutes: 5, title: 'Turn it in', done_looks_like: 'handed in' })],
    }, REVISE_FIELDS);
    check('... the same locked ref twice: the first copy kept, the later one dropped', !!twice && twice.steps.filter((x: any) => x.ref === 's1').length === 1 && twice.steps.length === 4, twice && twice.steps);
    const noDll = ok({
      summary: 'A poster.', questions: [], stretch: '', fits: true, note_for_adult: '',
      steps: [step({ kind: 'start', minutes: 5 }), step({ ref: 's1', title: LOCKED[0].title, done_looks_like: 'two titles saved in your notes', minutes: 20 }),
        step({ kind: 'turn_in', minutes: 5, title: 'Turn it in', done_looks_like: 'handed in' })],
    }, Object.assign({}, REVISE_FIELDS, { current_plan: [Object.assign({}, LOCKED[0], { done_looks_like: null })] }));
    check('... a locked step the people left without "done looks like" takes the AI\'s line, nothing else of it', !!noDll
      && same(noDll.steps[1], { ref: 's1', title: LOCKED[0].title, done_looks_like: 'two titles saved in your notes', minutes: 20, day: '2026-11-03', kind: 'step' }), noDll && noDll.steps[1]);
  }

  // ---- Through the action: an invalid answer, refusals, max_tokens, a parse error
  {
    const cases: [string, Reply[], string][] = [
      ['a 13-step answer', [json(200, anthropicOk(Object.assign({}, PLAN, { steps: Array.from({ length: 13 }, () => PLAN.steps[1]) })))], 'invalid'],
      ['an answer whose text isn\'t JSON', [json(200, Object.assign(anthropicOk(PLAN), { content: [{ type: 'text', text: '{"summary": "half' }] }))], 'invalid'],
      ['an answer with no text block', [json(200, Object.assign(anthropicOk(PLAN), { content: [{ type: 'thinking', thinking: '' }] }))], 'invalid'],
      ['stop_reason max_tokens', [json(200, Object.assign(anthropicOk(PLAN), { stop_reason: 'max_tokens' }))], 'invalid'],
      ['a refusal with no category', [json(200, Object.assign(anthropicOk(PLAN), { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }))], 'refusal'],
      ['a refusal in the cyber category', [json(200, Object.assign(anthropicOk(PLAN), { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } }))], 'refusal_cyber'],
      ['a refusal with an odd category', [json(200, Object.assign(anthropicOk(PLAN), { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'New Thing!', explanation: 'x' } }))], 'refusal'],
      ['a body that isn\'t JSON', [new Response('<html>oops</html>', { status: 200 })], 'invalid'],
    ];
    for (const [name, replies, stop] of cases) {
      const s = setup({ replies });
      const r = await run(s, post(ask(), ADMIN_JWT));
      const f = finishes(s);
      check(`${name} → finish with stop ${stop} and no draft`, r.status === 202 && f.length === 1 && f[0].p_stop === stop && f[0].p_draft === null && s.hits.length === 1, f);
    }
    const s = setup({ replies: [json(200, Object.assign(anthropicOk(PLAN), { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: 'x' } }))] });
    await run(s, post(ask(), ADMIN_JWT));
    check('... a refusal still reports its usage (some are billed)', finishes(s)[0].p_usage && finishes(s)[0].p_usage.input_tokens === 900);
  }

  // ---- HTTP errors (§6.5), retries only after a 429 or 529
  {
    const cases: [string, Reply[], string, number][] = [
      ['401', [apiError(401, 'authentication_error', 'invalid x-api-key')], 'auth', 1],
      ['403', [apiError(403, 'permission_error', 'not allowed')], 'auth', 1],
      ['402', [apiError(402, 'billing_error', 'There is an issue with your billing')], 'billing', 1],
      ['a credit-balance 400', [apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')], 'billing', 1],
      ['the spend-limit 400', [apiError(400, 'invalid_request_error', 'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.')], 'spend_limit', 1],
      ['the tier\'s spend cap (a 429 with no retry-after)', [apiError(429, 'rate_limit_error', 'You have reached your API usage limits', {}, { error_code: 'enforced_spend_limit_reached' })], 'spend_limit', 1],
      ['another 400', [apiError(400, 'invalid_request_error', 'messages: something')], 'error', 1],
      ['a 404', [apiError(404, 'not_found_error', 'model: claude-opus-5-5')], 'error', 1],
      ['a 500 (not retried)', [apiError(500, 'api_error', 'internal')], 'busy_api', 1],
      ['a 503 (not retried)', [apiError(503, 'api_error', 'unavailable')], 'busy_api', 1],
      ['a 429, then a 429', [apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '3' }), apiError(429, 'rate_limit_error', 'slow down')], 'busy_api', 2],
      ['a 529, then a 529', [apiError(529, 'overloaded_error', 'Overloaded'), apiError(529, 'overloaded_error', 'Overloaded')], 'busy_api', 2],
      ['a 529, then a good answer', [apiError(529, 'overloaded_error', 'Overloaded'), json(200, anthropicOk(PLAN))], '', 2],
      ['a 429, then a 500 (not retried again)', [apiError(429, 'rate_limit_error', 'slow down'), apiError(500, 'api_error', 'x')], 'busy_api', 2],
    ];
    for (const [name, replies, stop, n] of cases) {
      const s = setup({ replies });
      await run(s, post(ask(), ADMIN_JWT));
      const f = finishes(s);
      check(`${name} → ${stop || 'ready'} after ${n} ${n === 1 ? 'call' : 'calls'}`, f.length === 1 && (f[0].p_stop || '') === stop && s.hits.length === n, [f, s.hits.length]);
    }
    let s = setup({ replies: [apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '3' }), json(200, anthropicOk(PLAN))] });
    await run(s, post(ask(), ADMIN_JWT));
    check('the retry waits as long as retry-after says (3 s)', same(s.waits, [3000]), s.waits);
    s = setup({ replies: [apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '900' }), json(200, anthropicOk(PLAN))] });
    await run(s, post(ask(), ADMIN_JWT));
    check('... at most 20 s, however long it asks', same(s.waits, [20000]), s.waits);
    s = setup({ replies: [() => { s.clock.t += 295000; return apiError(529, 'overloaded_error', 'Overloaded'); }, json(200, anthropicOk(PLAN))] });
    await run(s, post(ask(), ADMIN_JWT));
    check('no retry when the run\'s 300-second budget is spent → busy_api', s.hits.length === 1 && finishes(s)[0].p_stop === 'busy_api', [s.hits.length, finishes(s)]);
  }

  // ---- Timeouts and fetch exceptions
  {
    const timeoutErr = Object.assign(new Error('The signal has been aborted'), { name: 'TimeoutError' });
    let s = setup({ replies: [timeoutErr, json(200, anthropicOk(PLAN))] });
    await run(s, post(ask(), ADMIN_JWT));
    check('our own timeout → timeout, not retried (the call may still be billed)', s.hits.length === 1 && finishes(s)[0].p_stop === 'timeout', finishes(s));
    const leak = new TypeError(`error sending request for url (https://api.anthropic.com/v1/messages?key=${KEY}): ${MARKER}`);
    s = setup({ replies: [leak] });
    await run(s, post(ask(), ADMIN_JWT));
    check('a fetch exception → a fixed code (error), not retried', s.hits.length === 1 && finishes(s)[0].p_stop === 'error', finishes(s));
    // A real timeout: the call never answers; the signal ends it.
    const saved = AI_LIMITS.callMs;
    AI_LIMITS.callMs = 50;
    s = setup();
    s.deps.fetch = ((_u: string, init: any) => new Promise((_res, rej) => {
      s.hits.push({ url: _u, init, body: null });
      init.signal.addEventListener('abort', () => rej(init.signal.reason));
    })) as unknown as typeof fetch;
    await run(s, post(ask(), ADMIN_JWT));
    AI_LIMITS.callMs = saved;
    check('a call that never answers is cut off by its signal → timeout', finishes(s).length === 1 && finishes(s)[0].p_stop === 'timeout', finishes(s));
  }

  // ---- The cost with a fallback: usage.iterations, each at its own model's price
  {
    const withFallback = Object.assign(anthropicOk(PLAN), {
      model: 'claude-opus-4-8',
      content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } },
        { type: 'text', text: JSON.stringify(PLAN) }],
      usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        iterations: [
          { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ] },
    });
    const s = setup({ replies: [json(200, withFallback)] });
    await run(s, post(ask(), ADMIN_JWT));
    const f = finishes(s)[0];
    // Opus 5.5: 1,000 × $4 + 500 × $20 = $0.014; Opus 4.8: 1,000 × $5 + 2,000 × $25 = $0.055 → 6.9 cents.
    check('a fallback\'s answer: ready, the model taken from the answer, the text found by its type', f.p_stop === null && f.p_model === 'claude-opus-4-8' && f.p_draft.steps.length === 5, f);
    check('... cents sum usage.iterations at each model\'s price (6.9)', f.p_usage.cents === 6.9, f.p_usage);
    check('estimateCents: an unknown model at $5/$25; no usage → 0', estimateCents({ input_tokens: 1e6, output_tokens: 0 }, 'claude-new-model') === 500 && estimateCents(null, HOMEWORK_MODEL) === 0);
  }

  // ---- Test the AI planner: checked like a plan, nothing but the run stored
  {
    const s = setup();
    const r = await run(s, post(ask({ kind: 'test', assignment_id: undefined }), ADMIN_JWT));
    check('Test (a parent): 202, homework_ai_start with no assignment', r.status === 202 && starts(s)[0].p_kind === 'test' && starts(s)[0].p_assignment === null, starts(s));
    check('... finish with no stop and no draft (Test stores nothing but the run)', finishes(s).length === 1 && finishes(s)[0].p_stop === null && finishes(s)[0].p_draft === null, finishes(s));
    const s2 = setup({ replies: [json(200, anthropicOk(Object.assign({}, PLAN, { steps: [] })))] });
    await run(s2, post(ask({ kind: 'test', assignment_id: undefined }), ADMIN_JWT));
    check('... a bad test answer is invalid, so Test says it isn\'t working', finishes(s2)[0].p_stop === 'invalid');
  }

  // ---- The background work never throws; finish tried twice; nothing personal logged
  {
    let s = setup({ finishFail: 1 });
    await run(s, post(ask(), ADMIN_JWT));
    check('a homework_ai_finish error is tried again (twice in all)', finishes(s).length === 2 && finishes(s)[1].p_stop === null, finishes(s).length);
    s = setup({ finishFail: 5 });
    const r = await run(s, post(ask(), ADMIN_JWT));
    check('... both failing: still 202, the work ends without throwing, and only a fixed code is logged', r.status === 202 && finishes(s).length === 2
      && logged.some((l) => /homework_ai: finish failed/.test(l)), logged);
    s = setup({ replies: [json(200, anthropicOk(PLAN))] });
    s.deps.fetch = (async () => { throw Object.assign(new Error(`parse ${MARKER}`), { name: 'SyntaxError' }); }) as any;
    await run(s, post(ask(), ADMIN_JWT));
    check('a thrown error in the work still calls finish with a fixed code', finishes(s).length === 1 && finishes(s)[0].p_stop === 'error');
    s = setup();
    const orig = s.deps.service;
    let n = 0;
    s.deps.service = () => { n++; return orig(); };
    await run(s, post(ask(), ADMIN_JWT));
    check('every RPC through deps.service()', n >= 2 && s.calls.filter((c) => c.fn !== 'whoami').every((c) => c.via === 'service'));
    // Everything that was logged in the cases above.
    const all = logged.join('\n');
    check('no console line holds the teacher\'s text, the key, a token, an error body or a message from Anthropic',
      !all.includes(MARKER) && !all.includes(KEY) && !all.includes(PAT) && !/issue with your billing|credit balance|slow down|Overloaded|invalid x-api-key|connection reset|usage limits|internal|unavailable/.test(all), all.slice(0, 400));
    check('... console lines are fixed codes and counts', logged.every((l) => /^homework_ai: [a-z_]+( [a-z_]+=\d+)*$|^homework_ai: finish failed$/.test(l)), logged.filter((l) => !/^homework_ai: /.test(l)));
  }

  // ---- No deps.background (an older index.ts): the work is done before the 202
  {
    const s = setup({ noBackground: true });
    const r = await run(s, post(ask(), ADMIN_JWT));
    check('without deps.background the work runs before the answer (nothing is lost)', r.status === 202 && r.hitsAtAnswer === 1 && finishes(s).length === 1);
  }

  // ---- A cut-off worker: the open runs are closed as timeout
  {
    const s = setup();
    let release: (v: Response) => void = () => {};
    s.deps.fetch = ((u: string, init: any) => { s.hits.push({ url: u, init, body: null }); return new Promise<Response>((res) => { release = res; }); }) as any;
    quiet();
    const res = await handle(post(ask(), ADMIN_JWT), s.deps);
    loud();
    check('while a call runs, its run is open', res.status === 202 && OPEN_RUNS.has(RUN));
    quiet();
    await cutOff(s.deps);
    loud();
    check('cutOff (beforeunload) finishes each open run with timeout', finishes(s).length === 1 && finishes(s)[0].p_stop === 'timeout' && !OPEN_RUNS.has(RUN), finishes(s));
    release(json(200, anthropicOk(PLAN)));
    quiet();
    await Promise.all(s.bg);
    loud();
    check('... and the call that answers later finishes nothing more', finishes(s).length === 1, finishes(s).length);
  }

  // ---- classify, on its own
  check('classify: 401 auth, 402 billing, 413 error, 422 error, 504 busy_api', classify(401, '') === 'auth' && classify(402, '') === 'billing'
    && classify(413, '') === 'error' && classify(422, '') === 'error' && classify(504, '') === 'busy_api');

  // ---- The source: no outside import, no U+2028/2029 escape, no message() of an error, the action named
  {
    const dir = new URL('../../supabase/functions/hub-jobs/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    const all = files.map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
    check('no \\u2028 or \\u2029 escape anywhere in hub-jobs\' source (an MCP deploy breaks on them)', !/\\u2028|\\u2029/i.test(all));
    const src = readFileSync(new URL('homework.ts', dir), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    check('homework.ts imports nothing from outside the function', [...code.matchAll(/^import .* from '([^']+)'/gm)].every((m) => m[1].startsWith('./')));
    check('homework.ts never uses util.ts\'s message() (it quotes an error\'s text)', !/\bmessage\(/.test(code));
    const logs = [...code.matchAll(/console\.(\w+)\(([^\n]*)/g)];
    check('homework.ts\'s console lines start with a fixed "homework_ai: " (and never hold a body or an error object)', logs.length >= 1
      && logs.every((m) => /^['`]homework_ai: /.test(m[2]) && !/\$\{[^}]*\b(text|body|err|error|reply|res|message|w\.|fields)\b/.test(m[2])), logs.map((m) => m[0]));
    const handler = readFileSync(new URL('handler.ts', dir), 'utf8');
    check('handler.ts names ANTHROPIC_API_KEY among its secrets, and homework_ai among its actions', /ANTHROPIC_API_KEY/.test(handler) && /homework_ai/.test(handler));
    const index = readFileSync(new URL('index.ts', dir), 'utf8');
    check('index.ts passes background: EdgeRuntime.waitUntil, and lists homework.ts among its files', /background:\s*\(p[^)]*\)\s*=>\s*EdgeRuntime\.waitUntil\(p\)/.test(index) && /homework\.ts/.test(index));
    check('... and closes a cut-off run on beforeunload', /beforeunload/.test(index) && /cutOff/.test(index));
    const s = setup();
    const r = await run(s, post({ action: 'make-coffee' }, ADMIN_JWT));
    check('the "Unknown action" message names homework_ai', r.status === 400 && /homework_ai/.test(r.body.error), r.body);
  }

  finish();
})().catch((err) => {
  clearInterval(keepAlive);
  loud();
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ')}`);
  process.exit(1);
});

function finish() {
  clearInterval(keepAlive);
  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
}
