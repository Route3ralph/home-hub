// Unit tests for phone reminders (docs/v1.3-homework.md §31): supabase/functions/hub-jobs/push.ts (the sealing, the
// VAPID signature, the words, one send) and its parts of handler.ts (the run sends them; push_key and push_test), with a
// fake database, push service and clock. The sealing is checked by opening it again here with node:crypto, written from
// RFC 8291 independently of push.ts; everyone in it is made up.
// Run alone with: node --experimental-strip-types tests/fn/push.test.ts
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify, randomBytes } from 'node:crypto';
import { handle } from '../../supabase/functions/hub-jobs/handler.ts';
import { seal, vapidAuth, vapidFrom, reminderFor, sendPush, testNote, dayUrl, b64u, unb64u } from '../../supabase/functions/hub-jobs/push.ts';
import type { DueList } from '../../supabase/functions/hub-jobs/due.ts';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`);

const SECRET = '9f1c2e7a4b6d8e0f1a3c5e7b9d2f4a6c8e0b';
const ALEX = 'aaaaaaaa-0000-4000-8000-000000000001';
const JORDAN = 'aaaaaaaa-0000-4000-8000-000000000003';
const DAY = '2026-11-13';
const TOKEN = '0123456789abcdef0123456789abcdef';
const APPLE = 'https://web.push.apple.com/QGuYzA1b2C3d4E5f6G7h8I9j0K';
const GOOGLE = 'https://fcm.googleapis.com/fcm/send/dX9yZ:APA91bH';

// A phone: its key pair and auth secret, as a browser makes them.
const phone = () => { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const auth = randomBytes(16); return { ecdh, auth, p256dh: b64u(new Uint8Array(ecdh.getPublicKey())), authB64: b64u(new Uint8Array(auth)) }; };
// RFC 8291 and 8188, the other way round: what the phone does.
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, len: number) => {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
};
function open(body: Uint8Array, ph: ReturnType<typeof phone>) {
  const b = Buffer.from(body);
  const salt = b.subarray(0, 16), rs = b.readUInt32BE(16), idlen = b[20], asPublic = b.subarray(21, 21 + idlen), ct = b.subarray(21 + idlen);
  const shared = ph.ecdh.computeSecret(asPublic);
  const ikm = hkdf(ph.auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), ph.ecdh.getPublicKey(), asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return { rs, idlen, delimiter: plain[plain.length - 1], text: plain.subarray(0, plain.length - 1).toString('utf8') };
}
// The hub's VAPID key pair, as `web-push generate-vapid-keys` prints it.
async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), privateKey: jwk.d as string };
}

const list = (lang = 'en'): DueList => ({
  day: DAY, tomorrow: '2026-11-14', tomorrow_label: lang === 'es' ? 'sáb 14 nov' : 'Sat Nov 14',
  coming_to: '2026-11-17', coming_to_label: 'Tue Nov 17',
  kids: [{
    id: JORDAN, name: 'Jordan',
    tomorrow: [{ title: 'Verbs worksheet', subject: 'Spanish', done: true }, { title: 'Volcano poster', subject: 'Science' }, { title: 'Grammar quiz', subject: 'Spanish' }],
    late: [{ title: 'Lab report', missing: true }, { title: 'Map quiz' }],
    coming: [{ title: 'Math topics' }],
  }],
});

function fakeDb(who: string, st: any) {
  return {
    rpc: async (fn: string, args?: any) => {
      st.calls.push({ who, fn, args });
      if (st.failRpc[fn]) return { data: null, error: st.failRpc[fn] };
      const h = st.rpc[fn];
      if (!h) return { data: null, error: { message: `Could not find the function public.${fn}`, code: 'PGRST202' } };
      return { data: await h(args, who), error: null };
    },
    from: (table: string) => {
      const q: any = { table, op: 'select', row: null, filters: [] as any[], mode: 'many' };
      const api: any = {
        select() { if (q.op !== 'select') q.returning = true; return api; },
        insert(row: any) { q.op = 'insert'; q.row = row; return api; },
        update(row: any) { q.op = 'update'; q.row = row; return api; },
        delete() { q.op = 'delete'; return api; },
        eq(c: string, v: any) { q.filters.push([c, 'eq', v]); return api; },
        lt(c: string, v: any) { q.filters.push([c, 'lt', v]); return api; },
        gt(c: string, v: any) { q.filters.push([c, 'gt', v]); return api; },
        gte(c: string, v: any) { q.filters.push([c, 'gte', v]); return api; },
        order() { return api; }, limit() { return api; },
        single() { q.mode = 'single'; return api; },
        maybeSingle() { q.mode = 'maybe'; return api; },
        then(ok: any, bad: any) { return run().then(ok, bad); },
      };
      async function run() {
        st.ops.push({ table, op: q.op, row: q.row, who });
        const rows = (st.tables[table] ||= []);
        let data: any[];
        if (q.op === 'insert') { const r = { id: `run-${rows.length + 1}`, ...q.row }; rows.push(r); data = [r]; }
        else {
          data = rows.filter((r: any) => q.filters.every(([c, op, v]: any) => (op === 'eq' ? r[c] === v : op === 'lt' ? r[c] < v : op === 'gt' ? r[c] > v : r[c] >= v)));
          if (q.op === 'update') data.forEach((r) => Object.assign(r, q.row));
          if (q.op === 'delete') st.tables[table] = rows.filter((r: any) => !data.includes(r));
        }
        if (q.mode === 'single') return { data: data[0] ?? null, error: data.length === 1 ? null : { message: 'not one row' } };
        if (q.mode === 'maybe') return { data: data[0] ?? null, error: null };
        return { data: q.op === 'select' || q.returning ? data : null, error: null };
      }
      return api;
    },
  };
}
(async () => {
  const V = await vapidKeys();
  const vapid = { ...V, subject: 'mailto:hub@family.example' };

  // ---------------------------------------------------------------------
  // Sealing (RFC 8291)
  // ---------------------------------------------------------------------
  {
    const ph = phone();
    const body = await seal(new TextEncoder().encode('{"title":"Due tomorrow"}'), ph.p256dh, ph.authB64);
    const o = open(body, ph);
    check('sealed for the phone: it opens with its own key and auth secret', o.text === '{"title":"Due tomorrow"}', o.text);
    check('... one aes128gcm record: size 4096, the hub\'s one-off key (65 bytes), the last-record delimiter', o.rs === 4096 && o.idlen === 65 && o.delimiter === 2);
    const again = await seal(new TextEncoder().encode('{"title":"Due tomorrow"}'), ph.p256dh, ph.authB64);
    check('... a new salt and key each time (two seals of the same words differ)', b64u(again) !== b64u(body));
    const other = phone();
    let refused = false;
    try { open(body, other); } catch { refused = true; }
    check('... another phone can\'t open it', refused);
    let wrong = false;
    try { await seal(new Uint8Array(1), b64u(new Uint8Array(10)), ph.authB64); } catch { wrong = true; }
    check('keys of the wrong size are refused', wrong);
  }

  // ---------------------------------------------------------------------
  // VAPID (RFC 8292)
  // ---------------------------------------------------------------------
  {
    const now = Date.parse('2026-11-13T21:00:00Z');
    const h = await vapidAuth(APPLE, vapid, now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(\S+)$/.exec(h);
    check('the Authorization header: vapid t=<JWT>, k=<the public key>', !!m && m[4] === V.publicKey, h.slice(0, 40));
    const head = JSON.parse(Buffer.from(unb64u(m![1])).toString()), claims = JSON.parse(Buffer.from(unb64u(m![2])).toString());
    check('... the JWT: ES256, for the push service\'s origin, 12 hours, the contact',
      head.alg === 'ES256' && claims.aud === 'https://web.push.apple.com' && claims.exp === now / 1000 + 12 * 3600 && claims.sub === 'mailto:hub@family.example', JSON.stringify(claims));
    const pub = unb64u(V.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)) }, format: 'jwk' });
    check('... signed by the hub\'s key', verify('sha256', Buffer.from(`${m![1]}.${m![2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(unb64u(m![3]))));
    const env = (o: Record<string, string>) => (k: string) => o[k];
    check('vapidFrom: all three secrets', !!vapidFrom(env({ VAPID_PUBLIC_KEY: V.publicKey, VAPID_PRIVATE_KEY: V.privateKey, VAPID_SUBJECT: 'mailto:hub@family.example' })));
    check('... none, or one missing: not set up', !vapidFrom(env({})) && !vapidFrom(env({ VAPID_PUBLIC_KEY: V.publicKey, VAPID_PRIVATE_KEY: V.privateKey })));
    check('... a key of the wrong size or a contact that isn\'t mailto: or https:: not set up',
      !vapidFrom(env({ VAPID_PUBLIC_KEY: 'abc', VAPID_PRIVATE_KEY: V.privateKey, VAPID_SUBJECT: 'mailto:hub@family.example' }))
      && !vapidFrom(env({ VAPID_PUBLIC_KEY: V.publicKey, VAPID_PRIVATE_KEY: V.privateKey, VAPID_SUBJECT: 'hub@family.example' })));
  }

  // ---------------------------------------------------------------------
  // The words
  // ---------------------------------------------------------------------
  {
    const url = 'https://family.example/hub/day.html?t=x#homework';
    const n = reminderFor(list(), JORDAN, 'en', url)!;
    check('the reminder: tomorrow\'s day, what\'s still to do (not the done one), how many not marked done',
      n.title === 'Due tomorrow (Sat Nov 14)' && n.body === 'Volcano poster, Grammar quiz. Not marked done yet: 2.' && n.url === url && n.tag === `due-${DAY}`, JSON.stringify(n));
    const es = reminderFor(list('es'), JORDAN, 'es', url)!;
    check('... in Spanish', es.title === 'Para mañana (sáb 14 nov)' && es.body === 'Volcano poster, Grammar quiz. Sin marcar como hecho: 2.', JSON.stringify(es));
    const done = reminderFor({ ...list(), kids: [{ ...list().kids[0], tomorrow: [list().kids[0].tomorrow[0]], late: [] }] }, JORDAN, 'en', url)!;
    check('everything due tomorrow done: "All done for tomorrow."', done.title === 'Due tomorrow (Sat Nov 14)' && done.body === 'All done for tomorrow.', JSON.stringify(done));
    const late = reminderFor({ ...list(), kids: [{ ...list().kids[0], tomorrow: [], late: [{ title: 'Map quiz' }] }] }, JORDAN, 'en', url)!;
    check('nothing due tomorrow but one open: "Nothing due tomorrow", and the one', late.title === 'Nothing due tomorrow (Sat Nov 14)' && late.body === 'Not marked done yet: 1.', JSON.stringify(late));
    check('nothing due and nothing open: no reminder at all', reminderFor({ ...list(), kids: [{ ...list().kids[0], tomorrow: [], late: [] }] }, JORDAN, 'en', url) === null);
    check('a kid not in the lists: no reminder', reminderFor(list(), ALEX, 'en', url) === null);
    const many = reminderFor({ ...list(), kids: [{ ...list().kids[0], late: [], tomorrow: ['A', 'B', 'C', 'D', 'E', 'F'].map((t) => ({ title: `${t} task\nline` })) }] }, JORDAN, 'en', url)!;
    check('more than 4: the first 4 and "and 2 more", each title on one line', many.body === 'A task line, B task line, C task line, D task line and 2 more.', many.body);
    check('the link: his My day\'s homework, only with a site and a real code', dayUrl('https://family.example/hub/', TOKEN) === `https://family.example/hub/day.html?t=${TOKEN}#homework`
      && dayUrl(null, TOKEN) === null && dayUrl('https://family.example/hub/', 'nope') === null);
    const exam = reminderFor({ ...list(), kids: [{ ...list().kids[0], late: [], tomorrow: [{ title: 'Listening, chapters 1 to 6', test: true }, { title: 'Volcano poster' }] }] }, JORDAN, 'en', url)!;
    check('0032: a test says so in the reminder', exam.body === 'Listening, chapters 1 to 6 (test), Volcano poster.', exam.body);
    check('... in Spanish "(examen)"', reminderFor({ ...list('es'), kids: [{ ...list('es').kids[0], late: [], tomorrow: [{ title: 'Escucha', test: true }] }] }, JORDAN, 'es', url)!.body === 'Escucha (examen).');
    check('the test notification', testNote('en', '16:00', url).body === 'This is a test. Your homework reminder comes every day at 16:00.');
  }

  // ---------------------------------------------------------------------
  // One send
  // ---------------------------------------------------------------------
  {
    const ph = phone();
    const asked: any[] = [];
    const answer = (status: number) => (async (u: string, init: any) => { asked.push({ u, init }); return new Response('', { status }); }) as any;
    const note = reminderFor(list(), JORDAN, 'en', 'https://family.example/hub/')!;
    const now = Date.parse('2026-11-13T21:00:00Z');
    let r = await sendPush({ endpoint: APPLE, p256dh: ph.p256dh, auth: ph.authB64 }, note, vapid, answer(201), now);
    const h = asked[0].init.headers;
    check('201: ok, posted to the address with the VAPID header, aes128gcm, a TTL and Urgency', r.outcome === 'ok' && asked[0].u === APPLE
      && /^vapid t=/.test(h.Authorization) && h['Content-Encoding'] === 'aes128gcm' && h.TTL === String(6 * 3600) && h.Urgency === 'normal' && asked[0].init.redirect === 'manual');
    check('... the body opens on the phone to the notification', JSON.parse(open(asked[0].init.body, ph).text).body === 'Volcano poster, Grammar quiz. Not marked done yet: 2.');
    r = await sendPush({ endpoint: GOOGLE, p256dh: ph.p256dh, auth: ph.authB64 }, note, vapid, answer(410), now);
    check('410: gone', r.outcome === 'gone' && r.status === 410);
    r = await sendPush({ endpoint: APPLE, p256dh: ph.p256dh, auth: ph.authB64 }, note, vapid, answer(404), now);
    check('404: gone', r.outcome === 'gone');
    r = await sendPush({ endpoint: APPLE, p256dh: ph.p256dh, auth: ph.authB64 }, note, vapid, answer(500), now);
    check('500: failed', r.outcome === 'failed' && r.status === 500);
    r = await sendPush({ endpoint: APPLE, p256dh: ph.p256dh, auth: ph.authB64 }, note, vapid, (async () => { throw new Error('down'); }) as any, now);
    check('no answer: failed', r.outcome === 'failed' && r.status === 0);
    asked.length = 0;
    for (const bad of ['https://evil.example/push', 'http://web.push.apple.com/x', 'https://web.push.apple.com.evil.example/x', 'https://169.254.169.254/latest']) {
      r = await sendPush({ endpoint: bad, p256dh: ph.p256dh, auth: ph.authB64 }, note, vapid, answer(201), now);
      check(`an address that isn't a push service's is never posted to (${bad})`, r.outcome === 'gone' && asked.length === 0);
    }
  }

  // ---------------------------------------------------------------------
  // The run, push_key and push_test, with a fake database
  // ---------------------------------------------------------------------
  const ph = phone();
  function setup(o: { schema?: number; vapid?: boolean; pushDue?: any[]; targets?: any[]; status?: number; listFor?: () => any; me?: any; failRpc?: Record<string, any> } = {}) {
    const st: any = {
      calls: [] as any[], ops: [] as any[], failRpc: o.failRpc ?? {},
      tables: {
        job_runs: [], notification_log: [],
        household: [{ id: true, push_at: '16:00:00' }],
        people: [{ id: JORDAN, name: 'Jordan', language: 'en', active: true }, { id: ALEX, name: 'Alex', language: 'en', active: true }],
      },
      rpc: {
        roll_missed_tasks: () => 0, hub_schema_version: () => o.schema ?? 31,
        digest_due: () => [], weekly_due: () => [], due_due: () => [], email_budget_left: () => 60,
        finish_notification: () => null, today_local: () => DAY,
        whoami: () => ('me' in o ? o.me : { email: 'alex@example.com', role: 'admin', person: { id: ALEX, language: 'en' } }),
        due_list: () => (o.listFor ? o.listFor() : list()),
        push_due: () => o.pushDue ?? [{ person_id: JORDAN, local_date: DAY, kind: 'due' }],
        push_claim: (a: any) => `push-${a.p_person}`,
        push_targets: () => o.targets ?? [{ endpoint: APPLE, p256dh: ph.p256dh, auth: ph.authB64, day_token: TOKEN }],
        push_result: () => null,
      } as Record<string, any>,
    };
    const posted: any[] = [];
    const keys = o.vapid === false ? {} : { VAPID_PUBLIC_KEY: V.publicKey, VAPID_PRIVATE_KEY: V.privateKey, VAPID_SUBJECT: 'mailto:hub@family.example' };
    const deps = {
      env: (k: string) => ({ HUB_CRON_SECRET: SECRET, SITE_URL: 'https://family.example/hub/', RESEND_API_KEY: 're_test', EMAIL_FROM: 'home@family.example',
                             SUPABASE_URL: 'https://project.example', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}', ...keys } as Record<string, string>)[k],
      now: () => Date.parse('2026-11-13T21:05:00Z'),
      sleep: async () => {},
      fetch: (async (url: string, init: any) => { posted.push({ url, init }); return new Response('', { status: o.status ?? 201 }); }) as any,
      service: () => fakeDb('service', st),
      user: (auth: string) => fakeDb(`user:${auth}`, st),
    };
    const rpcs = (fn: string) => st.calls.filter((c: any) => c.fn === fn);
    return { deps, st, posted, rpcs };
  }
  const cron = () => new Request('https://project.example/functions/v1/hub-jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-cron': SECRET }, body: '{"action":"digest"}' });
  const asUser = (body: unknown, auth: string | null = 'Bearer admin-jwt') => new Request('https://project.example/functions/v1/hub-jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });

  let s = setup();
  let res = await handle(cron(), s.deps);
  let out = await res.json();
  check('the run on 31 with the VAPID secrets: push_due, then the reminder to his phone', res.status === 200 && out.ok === true && out.pushed?.sent === 1
    && s.posted.length === 1 && s.posted[0].url === APPLE, JSON.stringify(out));
  check('... claimed with push_claim for him and the day, closed as sent', JSON.stringify(s.rpcs('push_claim').map((c: any) => c.args)) === JSON.stringify([{ p_person: JORDAN, p_day: DAY }])
    && s.rpcs('finish_notification')[0]?.args.p_id === `push-${JORDAN}` && s.rpcs('finish_notification')[0]?.args.p_status === 'sent');
  check('... his lists for the day in his language, and push_result ok for the phone', JSON.stringify(s.rpcs('due_list')[0]?.args) === JSON.stringify({ p_day: DAY, p_lang: 'en' })
    && JSON.stringify(s.rpcs('push_result')[0]?.args) === JSON.stringify({ p_endpoint: APPLE, p_status: 'ok' }));
  const note = JSON.parse(open(s.posted[0].init.body, ph).text);
  check('... the notification: the words, and a tap opens his My day\'s homework', note.title === 'Due tomorrow (Sat Nov 14)' && note.url === `https://family.example/hub/day.html?t=${TOKEN}#homework`, JSON.stringify(note));
  check('... the email budget isn\'t asked for it, and job_runs records it', s.rpcs('email_budget_left').length === 0 && JSON.parse(s.st.tables.job_runs[0].detail).pushed.sent === 1);
  check('... after the emails (due_due before push_due)', s.st.calls.findIndex((c: any) => c.fn === 'due_due') < s.st.calls.findIndex((c: any) => c.fn === 'push_due'));
  s = setup({ vapid: false });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('without the VAPID secrets: push_due isn\'t asked for, and the run is as it was', res.status === 200 && out.ok === true && !('pushed' in out) && s.rpcs('push_due').length === 0);
  s = setup({ schema: 30 });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('on schema 30: push_due isn\'t asked for', res.status === 200 && s.rpcs('push_due').length === 0 && !('pushed' in out));
  s = setup({ listFor: () => ({ ...list(), kids: [{ ...list().kids[0], tomorrow: [], late: [] }] }) });
  await handle(cron(), s.deps);
  check('nothing to say: skipped, nothing posted', s.posted.length === 0 && s.rpcs('finish_notification')[0]?.args.p_status === 'skipped');
  s = setup({ status: 410 });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('the phone let it go (410): push_result gone, the reminder skipped, the run still ok', s.rpcs('push_result')[0]?.args.p_status === 'gone'
    && s.rpcs('finish_notification')[0]?.args.p_status === 'skipped' && out.ok === true);
  s = setup({ status: 500 });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('the push service failing: failed (retried by push_due), and the run is still ok (the emails decide)', s.rpcs('finish_notification')[0]?.args.p_status === 'failed'
    && out.ok === true && out.pushed.failed === 1);
  s = setup({ pushDue: [] });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('nobody due: nothing claimed or posted', s.rpcs('push_claim').length === 0 && s.posted.length === 0 && out.pushed.due === 0);
  s = setup({ failRpc: { push_due: { message: 'permission denied for function push_due', code: '42501' } } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('push_due failing for another reason stops the run as an error', res.status === 500 && out.stop === 'error' && String(out.error).startsWith('push_due:'));

  s = setup();
  res = await handle(asUser({ action: 'push_key' }, null), s.deps);
  out = await res.json();
  check('push_key, signed out: the public key', res.status === 200 && out.public_key === V.publicKey);
  s = setup({ vapid: false });
  res = await handle(asUser({ action: 'push_key' }, null), s.deps);
  out = await res.json();
  check('... without the secrets: 503 not_set_up', res.status === 503 && out.stop === 'not_set_up');

  s = setup();
  res = await handle(asUser({ action: 'push_test', person_id: JORDAN }), s.deps);
  out = await res.json();
  check('push_test (an admin): one test to each of his phones', res.status === 200 && out.phones === 1 && out.sent === 1 && s.posted.length === 1
    && JSON.parse(open(s.posted[0].init.body, ph).text).body === 'This is a test. Your homework reminder comes every day at 16:00.', JSON.stringify(out));
  check('... nothing logged in notification_log (no claim)', s.rpcs('push_claim').length === 0);
  s = setup({ me: { email: 'sam@example.com', role: 'adult' } });
  res = await handle(asUser({ action: 'push_test', person_id: JORDAN }), s.deps);
  check('push_test by a member who isn\'t an admin: 403, nothing posted', res.status === 403 && s.posted.length === 0);
  s = setup();
  res = await handle(asUser({ action: 'push_test', person_id: JORDAN }, null), s.deps);
  check('push_test signed out: 401', res.status === 401);
  s = setup({ vapid: false });
  res = await handle(asUser({ action: 'push_test', person_id: JORDAN }), s.deps);
  check('push_test without the secrets: 503 not_set_up', res.status === 503 && (await res.json()).stop === 'not_set_up');
  s = setup();
  res = await handle(asUser({ action: 'push_test', person_id: 'nope' }), s.deps);
  check('push_test with no person: 400', res.status === 400);
  s = setup({ failRpc: { push_targets: { message: 'Could not find the function public.push_targets', code: 'PGRST202' } } });
  res = await handle(asUser({ action: 'push_test', person_id: JORDAN }), s.deps);
  check('push_test before 0031: 503 no_schema', res.status === 503 && (await res.json()).stop === 'no_schema');

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch((e) => { console.log(results.join('\n')); console.log(`FAIL  push tests stopped: ${e && e.stack}`); process.exit(1); });
