// Sends an email through Resend on behalf of a signed-in family member.
// Kept free of imports so it can be tested outside Supabase; index.ts wires it up.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   RESEND_API_KEY   a Resend API key with sending access
//   EMAIL_FROM       an address on a domain you've verified in Resend
//   EMAIL_FROM_NAME  optional, defaults to "Home Hub"

export const MAX_RECIPIENTS = 10;
export const DAILY_LIMIT = 50;
const MAX_SUBJECT = 200;
const MAX_TEXT = 20000;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Result<T> = { data: T | null; error: unknown; count?: number | null };
export interface Db {
  rpc(fn: string): PromiseLike<Result<{ email: string; name: string }>>;
  from(table: string): {
    select(cols: string, opts: { count: 'exact'; head: true }): { gte(col: string, value: string): PromiseLike<Result<unknown>> };
    insert(row: Record<string, unknown>): PromiseLike<Result<unknown>>;
  };
}
export interface Deps {
  env: (name: string) => string | undefined;
  db: (authorization: string) => Db;
  fetch: typeof fetch;
  now?: () => number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Resend takes the sender as `Name <address>`; keep the name to characters that can't break that format.
const displayName = (s: string) => s.replace(/[^\p{L}\p{N} '.-]/gu, '').replace(/\s+/g, ' ').trim() || 'Home Hub';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Plain text → simple HTML: keep line breaks, make links clickable.
export function toHtml(text: string): string {
  const linked = escapeHtml(text).replace(/https?:\/\/[^\s<]*[^\s<.,;:!?)]/g, (url) => `<a href="${url}">${url}</a>`);
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1f1b16">${linked.replace(/\n/g, '<br>')}</div>`;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const authorization = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/.test(authorization)) return json(401, { error: 'Sign in first.' });

  const apiKey = deps.env('RESEND_API_KEY');
  const from = deps.env('EMAIL_FROM');
  if (!apiKey || !from) return json(503, { error: 'Email sending is not set up yet. Add the Resend secrets in Supabase.' });

  let body: { to?: unknown; subject?: unknown; text?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: 'The request was not valid JSON.' }); }

  const rawTo = Array.isArray(body.to) ? body.to : [body.to];
  const recipients = [...new Set(rawTo.map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean))];
  const subject = String(body.subject ?? '').trim();
  const text = String(body.text ?? '').trim();
  if (!recipients.length) return json(400, { error: 'Add at least one recipient.' });
  if (recipients.length > MAX_RECIPIENTS) return json(400, { error: `Send to at most ${MAX_RECIPIENTS} people at once.` });
  const bad = recipients.find((r) => !EMAIL_RE.test(r));
  if (bad) return json(400, { error: `"${bad}" doesn't look like an email address.` });
  if (!subject || subject.length > MAX_SUBJECT) return json(400, { error: `Add a subject (up to ${MAX_SUBJECT} characters).` });
  if (/[\r\n]/.test(subject)) return json(400, { error: 'The subject must be a single line.' });
  if (!text || text.length > MAX_TEXT) return json(400, { error: 'Add a message (up to 20,000 characters).' });

  const db = deps.db(authorization);
  const { data: me, error: whoErr } = await db.rpc('whoami');
  if (whoErr || !me) return json(403, { error: 'Only family members can send email from the hub.' });

  const since = new Date((deps.now ? deps.now() : Date.now()) - 86400000).toISOString();
  const { count, error: countErr } = await db.from('email_log').select('id', { count: 'exact', head: true }).gte('created_at', since);
  if (countErr) return json(500, { error: 'Could not check the daily sending limit. Try again.' });
  if ((count ?? 0) >= DAILY_LIMIT) return json(429, { error: `The hub has sent ${DAILY_LIMIT} emails in the last 24 hours. Try again tomorrow.` });

  const fromName = deps.env('EMAIL_FROM_NAME') || 'Home Hub';
  const payload = {
    from: `${displayName(`${me.name} via ${fromName}`)} <${from}>`,
    to: recipients,
    reply_to: me.email,
    subject,
    text,
    html: toHtml(text),
  };

  let ok = false;
  let detail: string | null = null;
  try {
    const res = await deps.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    ok = res.status >= 200 && res.status < 300;
    if (!ok) detail = (await res.text()).slice(0, 500);
  } catch (err) {
    detail = String(err).slice(0, 500);
  }

  await db.from('email_log').insert({ recipients, subject, status: ok ? 'sent' : 'failed', error: detail });
  if (!ok) return json(502, { error: "Resend didn't accept the email. Check that the sender's domain is verified in Resend and the API key is right.", detail });
  return json(200, { sent: recipients.length });
}
