// Google for hub-jobs: signing in with the service-account key, the Calendar API calls, and the
// content hash of a Google event (docs/v1.1-google-calendar.md §3.5, §5.2, §6.1). No imports from
// outside, so it runs in the Node tests.
//
// Rules:
//   • The key (GOOGLE_SA_JSON) and the access token are never logged, stored or put in a message.
//     Errors from reading the key or exchanging it are fixed messages (V8's JSON errors quote their
//     input, so a mis-pasted key would end up where members can read it).
//   • The helper that calls Google is gcal(…), never call(…): the contract check reads any
//     call('<string>', …) as a database function.
//   • Each call has a 15-second timeout; calls are at least 250 ms apart; no call starts after the
//     run's deadline. A call may have its own deadline (until: the reads' 20 seconds): its timeout
//     is cut to the time left, it doesn't start with less than a second left, and if it times out
//     it isn't tried again, so a calendar that hangs can't hold up the writes.

import { oneLine } from './util.ts';

export const TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const API = 'https://www.googleapis.com/calendar/v3';
export const CALL_TIMEOUT_MS = 15000;
export const CALL_GAP_MS = 250;
export const RETRY_AFTER_MS = 1000;       // a 5xx, a timeout or a network error is tried once more after this
export const MIN_CALL_MS = 1000;          // a call with its own deadline doesn't start with less time left than this
const TOKEN_EARLY_S = 300;                // a cached token is dropped 5 minutes before it runs out
const TOKEN_LIFE_S = 3600;

export const KEY_BAD = "GOOGLE_SA_JSON isn't a service-account key: paste the whole downloaded file";
export const KEY_MISSING = 'Not set up: GOOGLE_SA_JSON is not in the function\'s secrets (README → Google Calendar and Hearth).';
export const KEY_REFUSED = 'Google refused the key. Make a new key (README, step A.4) and replace GOOGLE_SA_JSON in Supabase.';
export const SIGN_IN_DOWN = "Google's sign-in didn't answer. The next run tries again.";
export const API_OFF = "The Google Calendar API isn't turned on in the Cloud project (README, step A.2)";
export const NO_SCOPE = "Google's sign-in for Home Hub doesn't include the calendar scope";
export const SLOW_DOWN = 'Google asked Home Hub to slow down. It waits before trying again.';

// A stop that ends the run (or Test): one of calendar_finish's run-level codes, with a fixed message.
export class GoogleStop extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------
export type ServiceAccount = { client_email: string; private_key: string; private_key_id: string | null; token_uri: string };

// GOOGLE_SA_JSON as pasted: the whole JSON file, or the same in base64. Spaces around it are
// ignored, and a \n written out as two characters in the key becomes a newline.
export function readServiceAccount(raw: string | undefined): { key: ServiceAccount } | { stop: 'not_set_up' | 'config'; error: string } {
  const text = String(raw ?? '').trim();
  if (!text) return { stop: 'not_set_up', error: KEY_MISSING };
  const bad = { stop: 'config' as const, error: KEY_BAD };
  let k: any;
  try {
    k = JSON.parse(text.startsWith('{') ? text : new TextDecoder().decode(base64Bytes(text)));
  } catch {
    return bad;
  }
  if (!k || typeof k !== 'object' || Array.isArray(k)) return bad;
  const email = typeof k.client_email === 'string' ? k.client_email.trim() : '';
  const pem = typeof k.private_key === 'string' ? k.private_key.replace(/\\n/g, '\n') : '';
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(pem)) return bad;
  let tokenUri = TOKEN_URI;
  if (k.token_uri != null) {
    // Only Google's own sign-in: the signed request goes there.
    try {
      const u = new URL(String(k.token_uri));
      if (u.protocol !== 'https:' || !/(^|\.)googleapis\.com$/.test(u.hostname)) return bad;
      tokenUri = u.href;
    } catch {
      return bad;
    }
  }
  const keyId = typeof k.private_key_id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(k.private_key_id) ? k.private_key_id : null;
  return { key: { client_email: email, private_key: pem, private_key_id: keyId, token_uri: tokenUri } };
}

function base64Bytes(s: string): Uint8Array {
  const b = atob(s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const c of bytes) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const utf8 = (s: string) => new TextEncoder().encode(s);

async function sha256hex(s: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s)));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The signed request for a token (RS256 JWT, §6.1): iss the service account, scope the calendar's
// events, aud the token URI, valid for an hour from now (seconds).
export async function signJwt(key: ServiceAccount, nowS: number): Promise<string> {
  let signer: CryptoKey;
  try {
    const der = base64Bytes(key.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, ''));
    signer = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new GoogleStop('config', KEY_BAD);
  }
  const head = b64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(utf8(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: nowS, exp: nowS + TOKEN_LIFE_S })));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, utf8(`${head}.${claims}`)));
  return `${head}.${claims}.${b64url(sig)}`;
}

// The access token, kept until 5 minutes before it runs out, keyed by a fingerprint of the
// credential: a warm function reuses it, and a changed secret never gets the old one.
let cached: { fp: string; token: string; until: number } | null = null;
export function resetTokenCache(): void {
  cached = null;
}
const fingerprint = (key: ServiceAccount) => sha256hex(`${key.client_email}\n${key.private_key_id ?? ''}\n${key.token_uri}\n${key.private_key}`);

// ---------------------------------------------------------------------
// Calling Google
// ---------------------------------------------------------------------
export type GoogleDeps = {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadline?: number;                  // no call starts at or after this time (ms); the run's 30 seconds
};
// What Google answered: the HTTP status (0: no answer at all), the JSON body, and the error's
// reasons and message (one line), when there is one.
export type GResult = { status: number; data: any; reasons: string[]; error: string };

export type Google = {
  token(fresh?: boolean): Promise<string>;
  gcal(method: string, path: string, opts?: { query?: Record<string, string | number | undefined>; body?: unknown; until?: number }): Promise<GResult>;
  calls(): number;
};

export function google(key: ServiceAccount, d: GoogleDeps): Google {
  let last = -Infinity;
  let n = 0;
  let refreshed = false;

  // Spaced out, and never past the deadline (or the call's own, until). A stop of 'time' ends the
  // run (or, for a read, the reads).
  const pace = async (until?: number) => {
    const over = () => (d.deadline != null && d.now() >= d.deadline) || (until != null && until - d.now() < MIN_CALL_MS);
    if (over()) throw new GoogleStop('time', '');
    const wait = last + CALL_GAP_MS - d.now();
    if (wait > 0) await d.sleep(wait);
    if (over()) throw new GoogleStop('time', '');
    last = d.now();
    n++;
  };

  // One request with the timeout (cut to what is left before until); a 5xx, a timeout or a network
  // error is tried once more after a second, except that a call with until that timed out isn't, nor
  // one with too little time left for a second try.
  const send = async (url: string, init: RequestInit, until?: number): Promise<GResult> => {
    let r: GResult = { status: 0, data: null, reasons: [], error: '' };
    let timedOut = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        if (until != null && (timedOut || until - d.now() < RETRY_AFTER_MS + CALL_GAP_MS + MIN_CALL_MS)) break;
        await d.sleep(RETRY_AFTER_MS);
      }
      await pace(until);
      const ms = until == null ? CALL_TIMEOUT_MS : Math.max(1, Math.min(CALL_TIMEOUT_MS, until - d.now()));
      try {
        const res = await d.fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
        const text = await res.text();
        let data: any = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        r = { status: res.status, data, ...problem(res.status, data) };
      } catch (err) {
        timedOut = /timeout|abort/i.test(String((err as { name?: string })?.name ?? ''));
        r = { status: 0, data: null, reasons: [], error: timedOut ? "Google didn't answer in time." : "Couldn't reach Google." };
      }
      if (!(r.status === 0 || r.status >= 500)) break;
    }
    return r;
  };

  const token = async (fresh = false): Promise<string> => {
    const fp = await fingerprint(key);
    if (!fresh && cached && cached.fp === fp && d.now() < cached.until) return cached.token;
    cached = null;
    const jwt = await signJwt(key, Math.floor(d.now() / 1000));
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt });
    const r = await send(key.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (r.status === 200 && typeof r.data?.access_token === 'string' && r.data.access_token) {
      const life = Number(r.data.expires_in);
      const until = d.now() + ((Number.isFinite(life) ? life : TOKEN_LIFE_S) - TOKEN_EARLY_S) * 1000;
      if (until > d.now()) cached = { fp, token: r.data.access_token, until };
      return r.data.access_token;
    }
    // Never Google's own words here: an invalid_grant reply can describe the request.
    if (r.status === 429) throw new GoogleStop('slow_down', SLOW_DOWN);
    if (r.status === 0 || r.status >= 500) throw new GoogleStop('error', SIGN_IN_DOWN);
    throw new GoogleStop('auth', KEY_REFUSED);
  };

  // A Calendar API call. path is under /calendar/v3, with every id already URL-encoded (eventPath).
  // A 401 gets a new token once (per run) and is tried again.
  const gcal: Google['gcal'] = async (method, path, opts = {}) => {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const go = async (fresh: boolean) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${await token(fresh)}`, Accept: 'application/json' };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      return send(url.href, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, opts.until);
    };
    let r = await go(false);
    if (r.status === 401 && !refreshed) {
      refreshed = true;
      r = await go(true);
    }
    return r;
  };

  return { token, gcal, calls: () => n };
}

// The path of a calendar's events, or of one event: both ids URL-encoded (a holiday calendar's
// id has a '#').
export const eventsPath = (calendar: string, event?: string) =>
  `/calendars/${encodeURIComponent(calendar)}/events${event === undefined ? '' : `/${encodeURIComponent(event)}`}`;

// Google's error reasons (error.errors[0].reason, error.status, error.details[].reason) and its
// message, on one line, at most 300 characters, with anything shaped like a token removed.
function problem(status: number, data: any): { reasons: string[]; error: string } {
  if (status >= 200 && status < 300) return { reasons: [], error: '' };
  const e = data && typeof data === 'object' ? data.error : null;
  const reasons: string[] = [];
  if (e && typeof e === 'object') {
    if (Array.isArray(e.errors) && e.errors[0]?.reason) reasons.push(String(e.errors[0].reason));
    if (e.status) reasons.push(String(e.status));
    if (Array.isArray(e.details)) for (const x of e.details) if (x?.reason) reasons.push(String(x.reason));
  } else if (typeof e === 'string') {
    reasons.push(e);              // the token endpoint: {"error": "invalid_grant"}
  }
  const said = e && typeof e === 'object' && e.message ? String(e.message) : '';
  return { reasons: reasons.map((x) => oneLine(x).slice(0, 60)), error: cleanError(said) };
}

// One line of at most 300 characters, without anything shaped like a Google token (ya29.…, 1//…,
// a JWT): the database does the same again when it stores a message (private.clean_error).
export const cleanError = (s: unknown) =>
  oneLine(String(s ?? '').replace(/(ya29\.[0-9A-Za-z._~+/=-]+|1\/\/[0-9A-Za-z._~+/=-]+|eyJ[0-9A-Za-z_-]*\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]*)/g, '…')).slice(0, 300);

// What an answer means for the hub (§3.5):
//   slow_down  429, or 403 with a rate-limit reason: stop the run, and pause
//   api_off    403 accessNotConfigured or SERVICE_DISABLED: stop, config
//   scope      403 insufficientPermissions or ACCESS_TOKEN_SCOPE_INSUFFICIENT: stop, config
//   no_access  403 requiredAccessLevel or forbidden: the calendar can't be reached
//   forbidden  any other 403: a link error with Google's reason
//   auth       401 (after a new token)
//   missing    404 or 410
//   conflict   409
//   bad        400, or anything else unexpected: a link error with Google's message
//   down       5xx, a timeout or no answer (after one retry): a link error; calendars.status stays
export type Answer = 'ok' | 'slow_down' | 'api_off' | 'scope' | 'no_access' | 'forbidden' | 'auth' | 'missing' | 'conflict' | 'bad' | 'down';
const RATE = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'];
export function classify(r: GResult): Answer {
  const has = (list: string[]) => r.reasons.some((x) => list.includes(x));
  if (r.status >= 200 && r.status < 300) return 'ok';
  if (r.status === 429 || (r.status === 403 && has(RATE))) return 'slow_down';
  if (r.status === 403 && has(['accessNotConfigured', 'SERVICE_DISABLED'])) return 'api_off';
  if (r.status === 403 && has(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'])) return 'scope';
  if (r.status === 403 && has(['requiredAccessLevel', 'forbidden'])) return 'no_access';
  if (r.status === 403) return 'forbidden';
  if (r.status === 401) return 'auth';
  if (r.status === 404 || r.status === 410) return 'missing';
  if (r.status === 409) return 'conflict';
  if (r.status === 0 || r.status >= 500) return 'down';
  return 'bad';
}

// The stops a Google answer can cause for the whole run, or null.
export function runStop(a: Answer): GoogleStop | null {
  if (a === 'slow_down') return new GoogleStop('slow_down', SLOW_DOWN);
  if (a === 'api_off') return new GoogleStop('config', API_OFF);
  if (a === 'scope') return new GoogleStop('config', NO_SCOPE);
  if (a === 'auth') return new GoogleStop('auth', KEY_REFUSED);
  return null;
}

// A link's error message: the status, Google's reason and its message, on one line.
export function linkError(r: GResult): string {
  if (r.status === 0) return r.error || "Couldn't reach Google.";
  const reason = r.reasons.find((x) => !/^[A-Z_]+$/.test(x)) ?? r.reasons[0] ?? '';
  return cleanError(`Google said ${r.status}${reason ? ` ${reason}` : ''}${r.error ? `: ${r.error}` : ''}`);
}

// ---------------------------------------------------------------------
// The content hash of a Google event (§5.2)
// ---------------------------------------------------------------------
// SHA-256 of Google's own summary, location, start, end (dates as written, times as instants),
// visibility and status, worked out the same way from a write's answer and from a read, so a
// change of reminders or colour (which may move "updated") isn't taken for an edit. Fields Google
// leaves out when they have their default value count as that value.
export function contentHash(ev: any): Promise<string> {
  const when = (t: any) => {
    if (!t || typeof t !== 'object') return null;
    if (t.date != null) return { date: String(t.date) };
    if (t.dateTime != null) {
      const ms = Date.parse(String(t.dateTime));
      return { at: Number.isNaN(ms) ? String(t.dateTime) : new Date(ms).toISOString() };
    }
    return null;
  };
  const e = ev && typeof ev === 'object' ? ev : {};
  return sha256hex(JSON.stringify([
    String(e.summary ?? ''), String(e.location ?? ''), when(e.start), when(e.end),
    String(e.visibility ?? 'default'), String(e.status ?? 'confirmed'),
  ]));
}
