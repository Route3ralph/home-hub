// Phone reminders (migration 0031, docs/v1.3-homework.md §31) against the REAL database (tests/realdb/run.sh), with the
// real hub-jobs handler and a fake push service (lib.js's h.pushed):
//   Fri Nov 13, 3:00pm  Alex opens Settings → Phone reminders: turns them on at 4:00pm (household.push_at, through the
//                       household's own RLS).
//   Jordan's phone      His My day from the Home Screen (the page's push service faked in the browser, with a real key
//                       pair made here): Turn on reminders; the real push_by_token keeps his phone. Settings then lists
//                       him (the real push_people).
//   3:59pm and 4:00pm   The morning email's run sends nothing at 3:59pm; at 4:00pm one notification to his phone, sealed
//                       for it (opened here with the phone's key): "Due tomorrow (Sat Nov 14)", the open title, the one
//                       not marked done; logged once (kind due, channel push); the next run sends no second one.
//   Send a test         Alex's Send a test (the real push_test): one more, the test's words.
//   The phone lets go   The next day the push service answers 410: the phone is forgotten, and nothing more goes.
// Everything is made up.
const crypto = require('crypto');
const { setup } = require('./lib');

const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;
const ENDPOINT = 'https://web.push.apple.com/QRealdbPhone0001';

// The phone's key pair and auth secret, and RFC 8291 the phone's way round (independent of push.ts).
const phone = crypto.createECDH('prime256v1');
phone.generateKeys();
const authSecret = crypto.randomBytes(16);
const P256DH = phone.getPublicKey().toString('base64url');
const AUTH = authSecret.toString('base64url');
const hkdf = (salt, ikm, info, len) => crypto.createHmac('sha256', crypto.createHmac('sha256', salt).update(ikm).digest())
  .update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
function openNote(body) {
  const b = Buffer.from(body);
  const salt = b.subarray(0, 16), idlen = b[20], asPublic = b.subarray(21, 21 + idlen), ct = b.subarray(21 + idlen);
  const ikm = hkdf(authSecret, phone.computeSecret(asPublic), Buffer.concat([Buffer.from('WebPush: info\0'), phone.getPublicKey(), asPublic]), 32);
  const d = crypto.createDecipheriv('aes-128-gcm', hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}
// The phone's side in the page: from the Home Screen, a service worker and a push manager that hand over this phone.
const PUSH_FAKE = `(() => {
  let sub = null;
  const mk = () => ({ endpoint: ${JSON.stringify(ENDPOINT)}, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: ${JSON.stringify(P256DH)}, auth: ${JSON.stringify(AUTH)} } }; },
                      unsubscribe() { sub = null; return Promise.resolve(true); } });
  const pm = { getSubscription: () => Promise.resolve(sub), subscribe: () => { window.__perm = 'granted'; sub = mk(); return Promise.resolve(sub); } };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: () => Promise.resolve({ pushManager: pm }) } });
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  try { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => window.__perm || 'default' }); } catch (e) {}
})();`;

(async () => {
  const h = await setup('push');
  const { check, flow, sql, open, tc, until, lastToast } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };

  await h.setClock(at('2026-11-13', '15:00'));
  await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
  await sql(`insert into assignments (kid_id, title, subject, due_date, status) values
             ('${P.jordan.id}', 'Volcano poster', 'Science', '2026-11-14', 'open'),
             ('${P.jordan.id}', 'Map quiz', 'History', '2026-11-12', 'open')`);

  await flow('alex turns them on', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'push-alex' });
    await page.waitForSelector('.set-push', { timeout: 8000 });
    check('Settings: the Phone reminders card, off, 4:00pm suggested', (await tc(page, '#setPush')) === 'Phone reminders' && !(await page.isChecked('.set-push input[name="on"]'))
      && (await page.inputValue('.set-push input[name="at"]')) === '16:00');
    await page.check('.set-push input[name="on"]');
    await page.click('.set-push [type="submit"]');
    await until(async () => (await lastToast(page)) === 'Phone reminders on: every day at 4:00pm');
    check('on: household.push_at 16:00 (through the household\'s own RLS)', (await one('select push_at::text as t from household')).t === '16:00:00');
    check('alex: no API request failed', !(await failures()).length, await failures());
    await context.close();
  });

  await flow('jordan turns them on', async () => {
    await h.mark();
    const { page, context } = await open({ phone: true, init: PUSH_FAKE, path: `/day.html?t=${P.jordan.day_token}#homework`, label: 'push-jordan' });
    await page.waitForSelector('[data-act="hw-remind-on"]', { timeout: 8000 });
    check('his My day from the Home Screen: "every day at 4:00pm", Turn on reminders (the real homework view says they\'re on)',
      (await tc(page, '.hw-remind-line')) === 'Get a reminder of tomorrow\'s homework on this phone every day at 4:00pm.', await tc(page, '.hw-remind'));
    await page.click('[data-act="hw-remind-on"]');
    await until(async () => (await tc(page, '.hw-remind-line')) === 'Reminders on: every day at 4:00pm.');
    const row = await one(`select person_id, endpoint, p256dh, auth from push_subscriptions`);
    check('Turn on reminders (the real push_by_token): his phone kept, with its address and keys',
      !!row && row.person_id === P.jordan.id && row.endpoint === ENDPOINT && row.p256dh === P256DH && row.auth === AUTH, row);
    check('jordan: no API request failed', !(await failures()).length, await failures());
    await context.close();
    const { page: p2, context: c2 } = await open({ email: 'alex@example.com', path: '/#/settings', label: 'push-alex-who' });
    await p2.waitForSelector('.set-push-row', { timeout: 8000 });
    check('Settings now lists him (the real push_people): "Jordan …: on 1 phone"', /^Jordan.*: on 1 phone$/.test(await tc(p2, '.set-push-row span')), await tc(p2, '.set-push-row'));
    await c2.close();
  });

  await flow('the reminder', async () => {
    await h.setClock(at('2026-11-13', '15:59'));
    await h.runDigest();
    check('3:59pm: no reminder yet', h.pushed.length === 0);
    await h.setClock(at('2026-11-13', '16:00'));
    const res = await h.runDigest();
    check('4:00pm: the run is ok', res.status === 200, res.body);
    check('... one notification, to his phone, with the VAPID header and aes128gcm', h.pushed.length === 1 && h.pushed[0].url === ENDPOINT
      && h.pushed[0].headers['Content-Encoding'] === 'aes128gcm' && h.pushed[0].headers.Authorization.endsWith(`k=${h.VAPID_PUBLIC}`), h.pushed.map((x) => x.url));
    const note = h.pushed[0] ? openNote(h.pushed[0].body) : {};
    check('... sealed for his phone: "Due tomorrow (Sat Nov 14)", the open title and the one not marked done, from the real due_list',
      note.title === 'Due tomorrow (Sat Nov 14)' && note.body === 'Volcano poster. Not marked done yet: 1.', JSON.stringify(note));
    check('... a tap opens his My day\'s homework', note.url === `https://family.example/hub/day.html?t=${P.jordan.day_token}#homework`, note.url);
    check('... logged once (kind due, channel push, sent); no email row', (await one(`select string_agg(kind || ' ' || channel || ' ' || status, ', ') as s from notification_log`)).s === 'due push sent');
    check('... the phone\'s last sent noted', !!(await one('select last_ok_at from push_subscriptions')).last_ok_at);
    await h.runDigest();
    check('the next run: no second one', h.pushed.length === 1);
  });

  await flow('send a test', async () => {
    const res = await h.hubJobsAs('alex@example.com', { action: 'push_test', person_id: P.jordan.id });
    check('Send a test (the real push_test): one more to his phone', res.status === 200 && res.body.sent === 1 && h.pushed.length === 2, res.body);
    check('... the test\'s words', openNote(h.pushed[1].body).body === 'This is a test. Your homework reminder comes every day at 16:00.');
    const sam = await h.hubJobsAs('sam@example.com', { action: 'push_test', person_id: P.jordan.id });
    check('... Sam (not a parent) can\'t', sam.status === 403 && h.pushed.length === 2);
  });

  await flow('the phone lets go', async () => {
    h.push.reply = 410;
    await h.setClock(at('2026-11-14', '16:00'));
    await h.runDigest();
    check('the next day the push service answers 410: his phone is forgotten', !(await one('select 1 as x from push_subscriptions')));
    await h.setClock(at('2026-11-15', '16:00'));
    const before = h.pushed.length;
    await h.runDigest();
    check('... and nothing more goes', h.pushed.length === before);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  push stopped: ${e && e.stack}`); process.exit(1); });
