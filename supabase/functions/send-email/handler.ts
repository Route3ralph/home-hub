// Sends an email through SendGrid on behalf of a signed-in family member.
// Kept free of imports so it can be tested outside Supabase; index.ts wires it up.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   SENDGRID_API_KEY  a SendGrid API key with "Mail Send" permission
//   EMAIL_FROM        an address on a domain you've authenticated in SendGrid
//   EMAIL_FROM_NAME   optional, defaults to "Home Hub"

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

  const apiKey = deps.env('SENDGRID_API_KEY');
  const from = deps.env('EMAIL_FROM');
  if (!apiKey || !from) return json(503, { error: 'Email sending is not set up yet. Add the SendGrid secrets in Supabase.' });

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
    personalizations: [{ to: recipients.map((email) => ({ email })) }],
    from: { email: from, name: `${me.name} via ${fromName}` },
    reply_to: { email: me.email, name: me.name },
    subject,
    content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: toHtml(text) }],
  };

  let ok = false;
  let detail: string | null = null;
  try {
    const res = await deps.fetch('https://api.sendgrid.com/v3/mail/send', {
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
  if (!ok) return json(502, { error: "SendGrid didn't accept the email. Check the sender address and API key in SendGrid.", detail });
  return json(200, { sent: recipients.length });
}
