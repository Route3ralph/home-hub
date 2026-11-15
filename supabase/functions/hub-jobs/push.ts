// Phone reminders (docs/v1.3-homework.md §31): one notification a day on a kid's phone, from his My day added to the
// Home Screen. The database says who and when (push_due), keeps his phones (push_targets) and works out his lists
// (due_list); this file writes the words and sends each one through the phone's push service: Web Push (RFC 8030),
// sealed for that phone (RFC 8291, aes128gcm), signed by the hub's VAPID key (RFC 8292). WebCrypto only, so it runs in
// Deno and in the Node tests, and no library sees a key.
// Rules: only the push services' own hosts are posted to (the database refuses any other address, and this checks
// again); the payload names assignments by their titles as the school wrote them, never their text, plan or grade;
// a key or address is never logged or stored in a detail.

import type { DueItem, DueList } from './due.ts';
import { oneLine } from './util.ts';

export type Vapid = { publicKey: string; privateKey: string; subject: string };
export type PushTarget = { endpoint: string; p256dh: string; auth: string; day_token?: string | null };
export type PushNote = { title: string; body: string; url: string; tag: string };
export type PushOutcome = 'ok' | 'gone' | 'failed';

// The push services' hosts, as push_subscriptions' check has them.
export const PUSH_HOST = /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)\/[A-Za-z0-9_./:=%+~-]+$/;

// ---------- base64url
export const b64u = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s: string): Uint8Array => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// ---------- the keys
// The VAPID secrets: the public key as the 65-byte uncompressed point and the private key as its 32-byte scalar, both
// base64url (what `npx web-push generate-vapid-keys` prints), and a contact (mailto: or https:). Null when any is
// missing or malformed.
export function vapidFrom(env: (name: string) => string | undefined): Vapid | null {
  const publicKey = (env('VAPID_PUBLIC_KEY') || '').trim();
  const privateKey = (env('VAPID_PRIVATE_KEY') || '').trim();
  const subject = (env('VAPID_SUBJECT') || '').trim();
  try {
    if (unb64u(publicKey).length !== 65 || unb64u(publicKey)[0] !== 4 || unb64u(privateKey).length !== 32) return null;
  } catch { return null; }
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

const signingKey = (v: Vapid) => {
  const pub = unb64u(v.publicKey);
  return crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: v.privateKey, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: false,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
};

// The Authorization header (RFC 8292): a JWT for the push service's origin, good for 12 hours.
export async function vapidAuth(endpoint: string, v: Vapid, nowMs: number): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(utf8(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: v.subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(v), utf8(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

// ---------- sealing (RFC 8291 with RFC 8188's aes128gcm, one record)
const hmac = async (key: Uint8Array, data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
const expand = async (prk: Uint8Array, info: Uint8Array, len: number) => (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);

// The body for one phone: salt(16) | record size(4) | key length(1) | the hub's one-off public key(65) | ciphertext.
// salt and the one-off key pair can be given (the tests), else they are new each time.
export async function seal(plain: Uint8Array, p256dh: string, auth: string,
                           fixed?: { salt: Uint8Array; keys: CryptoKeyPair }): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('That phone\'s keys are the wrong size.');
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const keys = fixed ? fixed.keys : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, keys.privateKey, 256));
  const ikm = await expand(await hmac(authSecret, shared), concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const prk = await hmac(salt, ikm);
  const cek = await expand(prk, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await expand(prk, utf8('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plain, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// ---------- sending
// One notification to one phone. 201/202: ok; 404/410: the phone let it go; anything else (or no answer in 10 s): failed.
export async function sendPush(target: PushTarget, note: PushNote, v: Vapid, fetchFn: typeof fetch, nowMs: number,
                               ttlSeconds = 6 * 3600): Promise<{ outcome: PushOutcome; status: number }> {
  if (!PUSH_HOST.test(target.endpoint)) return { outcome: 'gone', status: 0 };
  let body: Uint8Array;
  try {
    body = await seal(utf8(JSON.stringify(note)), target.p256dh, target.auth);
  } catch {
    return { outcome: 'gone', status: 0 };
  }
  try {
    const res = await fetchFn(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuth(target.endpoint, v, nowMs),
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: String(ttlSeconds), Urgency: 'normal',
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    try { await res.arrayBuffer(); } catch { /* the body isn't needed */ }
    if (res.status === 201 || res.status === 202 || res.status === 200) return { outcome: 'ok', status: res.status };
    if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status };
    return { outcome: 'failed', status: res.status };
  } catch {
    return { outcome: 'failed', status: 0 };
  }
}

// ---------- the words
const WORDS = {
  en: {
    title: 'Due tomorrow ({day})', title_none: 'Nothing due tomorrow ({day})',
    late: 'Not marked done yet: {n}.', late_one: 'Not marked done yet: 1.', all_done: 'All done for tomorrow.',
    more: 'and {n} more', test_title: 'Home Hub reminders are on', test_body: 'This is a test. Your homework reminder comes every day at {at}.',
  },
  es: {
    title: 'Para mañana ({day})', title_none: 'Nada para mañana ({day})',
    late: 'Sin marcar como hecho: {n}.', late_one: 'Sin marcar como hecho: 1.', all_done: 'Todo hecho para mañana.',
    more: 'y {n} más', test_title: 'Los recordatorios de Home Hub están activados', test_body: 'Es una prueba. Tu recordatorio de tareas llega cada día a las {at}.',
  },
} as const;
type Lang = keyof typeof WORDS;
const w = (l: Lang, key: keyof typeof WORDS['en'], vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), WORDS[l][key] as string);
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const MAX_TITLES = 4;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The link a tap opens: his My day's homework. Null without a site or a code.
export function dayUrl(site: string | null, token: string | null | undefined): string | null {
  return site && token && /^[0-9a-f]{32}$/.test(token) ? `${site}day.html?t=${token}#homework` : null;
}

// Today's reminder for one kid from due_list, or null when there is nothing to say (nothing due tomorrow and nothing
// open from before): then no notification goes.
export function reminderFor(list: DueList, kidId: string, language: unknown, url: string): PushNote | null {
  const l: Lang = language === 'es' ? 'es' : 'en';
  const kid = arr<DueList['kids'][number]>(list && list.kids).find((k) => k && k.id === kidId);
  if (!kid) return null;
  const tomorrow = arr<DueItem>(kid.tomorrow);
  const open = tomorrow.filter((it) => !it.done);
  const late = arr<DueItem>(kid.late).length;
  if (!tomorrow.length && !late) return null;
  const day = oneLine(list.tomorrow_label);
  const titles = open.slice(0, MAX_TITLES).map((it) => cut(oneLine(it.title), 60));
  const parts: string[] = [];
  if (titles.length) parts.push(titles.join(', ') + (open.length > MAX_TITLES ? ` ${w(l, 'more', { n: open.length - MAX_TITLES })}` : '') + '.');
  else if (tomorrow.length) parts.push(w(l, 'all_done'));
  if (late) parts.push(late === 1 ? w(l, 'late_one') : w(l, 'late', { n: late }));
  return {
    title: w(l, tomorrow.length ? 'title' : 'title_none', { day }),
    body: cut(parts.join(' '), 240),
    url, tag: `due-${oneLine(list.day)}`,
  };
}

// Settings' Send a test.
export function testNote(language: unknown, atLabel: string, url: string): PushNote {
  const l: Lang = language === 'es' ? 'es' : 'en';
  return { title: w(l, 'test_title'), body: w(l, 'test_body', { at: oneLine(atLabel) }), url, tag: 'test' };
}
