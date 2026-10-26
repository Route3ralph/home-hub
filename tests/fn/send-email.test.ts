// Unit tests for supabase/functions/send-email/handler.ts with fake Resend and database.
// Run alone with: node --experimental-strip-types tests/fn/send-email.test.ts
import { handle, toHtml, DAILY_LIMIT } from '../../supabase/functions/send-email/handler.ts';

type Call = { url: string; init: any };
const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

function setup(opts: { member?: any; count?: number; sendStatus?: number; env?: Record<string, string | undefined>; countError?: boolean } = {}) {
  const sent: Call[] = [];
  const logged: any[] = [];
  const env: Record<string, string | undefined> = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'home@family.example', ...opts.env };
  const member = 'member' in opts ? opts.member : { email: 'alex@example.com', name: 'Alex Example' };
  const deps = {
    env: (k: string) => env[k],
    fetch: (async (url: string, init: any) => { sent.push({ url, init }); const status = opts.sendStatus ?? 200; return new Response(status === 200 ? '{"id":"email-1"}' : 'bad sender', { status }); }) as any,
    db: (auth: string) => ({
      rpc: async () => ({ data: member, error: null }),
      from: () => ({
        select: () => ({ gte: async () => (opts.countError ? { data: null, error: 'boom', count: null } : { data: null, error: null, count: opts.count ?? 0 }) }),
        insert: async (row: any) => { logged.push(row); return { data: null, error: null }; },
      }),
    }),
  };
  return { deps, sent, logged };
}
const req = (body: unknown, auth = 'Bearer user-jwt', method = 'POST') =>
  new Request('https://x.supabase.co/functions/v1/send-email', { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
const good = { to: 'Pat@LeeElectric.example', subject: 'Kitchen: your schedule', text: 'Hi Pat,\nLink: https://example.com/share.html?p=abc&trade=x\n<b>not bold</b>' };

(async () => {
  let s = setup();
  let res = await handle(req(good), s.deps);
  const payload = JSON.parse(s.sent[0]?.init.body || '{}');
  check('valid request sends via Resend', res.status === 200 && s.sent.length === 1 && s.sent[0].url === 'https://api.resend.com/emails', `status ${res.status}`);
  check('uses API key as bearer', s.sent[0].init.headers.Authorization === 'Bearer re_test');
  check('recipient normalized to lowercase', payload.to.length === 1 && payload.to[0] === 'pat@leeelectric.example');
  check('from = configured sender, named after member', payload.from === 'Alex Example via Home Hub <home@family.example>', payload.from);
  check('reply-to = signed-in member', payload.reply_to === 'alex@example.com');
  check('HTML part escapes markup and links URLs', payload.html.includes('&lt;b&gt;') && payload.html.includes('<a href="https://example.com/share.html?p=abc&amp;trade=x">') && payload.text === good.text);
  check('success is logged', s.logged.length === 1 && s.logged[0].status === 'sent' && s.logged[0].recipients[0] === 'pat@leeelectric.example');
  s = setup({ member: { email: 'x@example.com', name: 'Eve <evil@bad.example>, "Boss"\r\nBcc: v@x.co' } });
  res = await handle(req(good), s.deps);
  const evilFrom = JSON.parse(s.sent[0]?.init.body || '{}').from;
  check('member name cannot inject addresses into From', res.status === 200 && /^[^<>",@\r\n]+ <home@family\.example>$/.test(evilFrom), evilFrom);

  s = setup({ member: null });
  res = await handle(req(good), s.deps);
  check('non-member refused, nothing sent', res.status === 403 && s.sent.length === 0);

  s = setup();
  res = await handle(req(good, ''), s.deps);
  check('missing sign-in refused', res.status === 401 && s.sent.length === 0);

  s = setup({ env: { RESEND_API_KEY: undefined } });
  res = await handle(req(good), s.deps);
  check('not configured → 503 with explanation', res.status === 503 && (await res.json()).error.includes('not set up'));

  s = setup({ count: DAILY_LIMIT });
  res = await handle(req(good), s.deps);
  check('daily limit enforced', res.status === 429 && s.sent.length === 0);

  s = setup({ countError: true });
  res = await handle(req(good), s.deps);
  check('limit check failure fails closed', res.status === 500 && s.sent.length === 0);

  s = setup();
  res = await handle(req({ ...good, to: Array.from({ length: 11 }, (_, i) => `a${i}@x.co`) }), s.deps);
  check('more than 10 recipients rejected', res.status === 400 && s.sent.length === 0);
  res = await handle(req({ ...good, to: 'not-an-email' }), s.deps);
  check('bad address rejected', res.status === 400 && (await res.json()).error.includes('not-an-email'));
  res = await handle(req({ ...good, subject: 'Hi\r\nBcc: victim@x.co' }), s.deps);
  check('header injection in subject rejected', res.status === 400);
  res = await handle(req({ ...good, text: '' }), s.deps);
  check('empty message rejected', res.status === 400);
  res = await handle(req({ ...good, to: ['a@x.co', 'A@X.co'] }), s.deps);
  check('duplicate recipients collapsed', res.status === 200 && JSON.parse(s.sent[0].init.body).to.length === 1);

  s = setup({ sendStatus: 403 });
  res = await handle(req(good), s.deps);
  const failBody = await res.json();
  check('Resend rejection → 502 + logged as failed', res.status === 502 && s.logged[0].status === 'failed' && s.logged[0].error === 'bad sender', failBody.error);

  s = setup();
  res = await handle(req(null, 'Bearer x', 'OPTIONS'), s.deps);
  check('CORS preflight answered', res.status === 200 && res.headers.get('Access-Control-Allow-Origin') === '*');
  res = await handle(req(null, 'Bearer x', 'GET'), s.deps);
  check('GET rejected', res.status === 405);

  check('toHtml keeps line breaks', toHtml('a\nb').includes('a<br>b'));
  // trailing punctuation stays outside the link
  const h = toHtml('See https://example.com/a?b=1. Thanks');
  const linked = h.includes('<a href="https://example.com/a?b=1">https://example.com/a?b=1</a>. Thanks');
  check('trailing period excluded from link', linked, linked ? '' : h);

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
