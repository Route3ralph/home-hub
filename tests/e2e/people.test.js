// Browser tests for the v2 Family page (assets/modules/people.js): the list (colour, role, email with
// "Unconfirmed", phone, morning email, "Can sign in" from members), old #/family links, the add / edit
// form (roles with explanations, colour, language, morning email on/off · time · today/tomorrow ·
// everyone's day for parents, can sign in for parents and adults only), save_person then refresh,
// remove_person, your own row's limits, the My day link (Copy, WhatsApp, Text, New link), members
// see it read-only, errors, phones (390px) and dark mode.
//
// The database functions are fakes that follow supabase/migrations/0002_home_hub_v2.sql and return
// what it returns: save_person → the people row (keys left out keep their value; id, day_token and
// email_verified_at never come from the client; the members row follows), remove_person → null,
// rotate_day_token → the new 32-hex token, clock → { local_date, local_time, tz }, whoami → the
// members row plus person. The other v2 pages are small stubs served in place of their files, so
// this file tests the Family page alone. The browser runs in Pacific/Honolulu with its clock on
// another day; the household is in America/New_York.
// Run alone with: node tests/e2e/people.test.js
const { chromium } = require('playwright');
const { createHash } = require('crypto');
const { makeDb, install, signIn } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };

// ---- Fixtures (fictional people, 555-01xx numbers, example.com)
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-10-25';
const ID = {
  alex: '0e1e0000-0000-4000-8000-000000000001', sam: '0e1e0000-0000-4000-8000-000000000002',
  jordan: '0e1e0000-0000-4000-8000-000000000003', taylor: '0e1e0000-0000-4000-8000-000000000004',
  morgan: '0e1e0000-0000-4000-8000-000000000005',
};
const tokenOf = (s) => createHash('md5').update(String(s)).digest('hex');
const person = (id, name, role, color, sort, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color, language: 'en',
  day_token: tokenOf(id), digest_enabled: false, digest_time: null,
  digest_day: 'today', digest_scope: 'mine', sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);
const XSS = '<img src=x onerror="window.__xss=1">Pat';

function peopleDb() {
  const db = makeDb(); // members: Alex (admin), Sam (member)
  db.people = [
    person(ID.alex, 'Alex Example', 'parent', '#2563eb', 0, { email: 'alex@example.com', email_verified_at: T, digest_enabled: true, digest_scope: 'everyone', phone: '(201) 555-0110' }),
    person(ID.sam, 'Sam Example', 'adult', '#db2777', 1, { email: 'sam@example.com', digest_enabled: true, digest_day: 'tomorrow', digest_time: '19:00:00' }),
    person(ID.jordan, 'Jordan Example', 'kid', '#16a34a', 2, { phone: '(201) 555-0103' }),
    person(ID.taylor, 'Taylor Example', 'helper', '#ca8a04', 3, { phone: '(201) 555-0104', language: 'es' }),
    person(ID.morgan, 'Morgan Example', 'adult', '#0891b2', 4, { active: false }),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: null, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '09:00:00', tz: 'America/New_York' };
  db.confirms = [];
  db.saves = [];
  db.tokenSeq = 0;
  db.events = []; // the Settings page (not stubbed here) reads repeating events for its days-off list
  return db;
}

const callerOf = (db, email) => db.members.find((m) => m.email === email) || null;
const refuse = (code, message, status = 400) => ({ __status: status, body: { code, message, details: null, hint: null } });

// save_person, as the migration has it (with the same messages).
function savePerson(db, body, email) {
  const me = callerOf(db, email);
  if (!me || me.role !== 'admin') return refuse('42501', 'Only an admin can change the family list.', 403);
  const p = body.p;
  const canSignIn = body.p_can_sign_in;
  db.saves.push(JSON.parse(JSON.stringify(body)));
  if (db.saveFail) return refuse('XX000', 'Database restarting', 500);
  if (!p || typeof p !== 'object' || typeof canSignIn !== 'boolean') return refuse('22023', 'save_person needs a person and whether they can sign in.');
  const fixed = ['id', 'day_token', 'email_verified_at', 'created_at', 'updated_at'];
  const given = Object.fromEntries(Object.entries(p).filter(([k]) => !fixed.includes(k)));
  let old = null;
  let r;
  if (p.id) {
    old = db.people.find((x) => x.id === p.id);
    if (!old) return refuse('P0002', 'That person is no longer on the family list.');
    r = Object.assign({}, old, given);
  } else {
    r = Object.assign({ color: '#64748b', language: 'en', digest_enabled: false, digest_day: 'today', digest_scope: 'mine', sort_order: 0, active: true,
      email: null, phone: null, digest_time: null }, given);
  }
  r.name = String(r.name || '').trim();
  r.email = r.email == null || String(r.email).trim() === '' ? null : String(r.email).trim().toLowerCase();
  r.phone = r.phone == null || String(r.phone).trim() === '' ? null : String(r.phone).trim();
  if (r.role !== 'parent') r.digest_scope = 'mine';
  if (!r.name) return refuse('23514', 'new row for relation "people" violates check constraint "people_name_check"');
  if (!['parent', 'adult', 'kid', 'helper'].includes(r.role)) return refuse('23514', 'new row for relation "people" violates check constraint "people_role_check"');
  if (canSignIn) {
    if (!['parent', 'adult'].includes(r.role)) return refuse('22023', 'Only parents and adults can sign in. Kids and helpers get a My day link instead.');
    if (!r.email) return refuse('22023', 'Add an email address before turning on sign-in.');
    if (!r.active) return refuse('22023', 'Someone who isn\'t active can\'t sign in.');
  }
  if (((old && old.email === email) || r.email === email) && (!canSignIn || r.email !== email || r.role !== 'parent' || !r.active)) {
    return refuse('42501', 'You can\'t remove or change your own sign-in. Ask another admin.', 403);
  }
  if (r.email && db.people.some((x) => x.email === r.email && (!old || x.id !== old.id))) {
    return refuse('23505', 'Someone on the family list already has that email address.', 409);
  }
  const t = '2026-10-25T13:00:00.000000+00:00';
  const oldEmail = old ? old.email : null;
  if (!old) {
    db.tokenSeq++;
    r = Object.assign(r, { id: `0e1e0000-0000-4000-8000-0000000001${String(db.tokenSeq).padStart(2, '0')}`, day_token: tokenOf(`new-${db.tokenSeq}`), email_verified_at: null, created_at: t, updated_at: t });
    db.people.push(r);
  } else {
    if (r.email !== old.email) r.email_verified_at = null; // the people_email_changed trigger
    r.updated_at = t;
    Object.assign(old, r);
    r = old;
  }
  // The sign-in list follows.
  if (oldEmail && (oldEmail !== r.email || !canSignIn)) db.members = db.members.filter((m) => m.email !== oldEmail);
  if (canSignIn) {
    const row = db.members.find((m) => m.email === r.email);
    const role = r.role === 'parent' ? 'admin' : 'member';
    if (row) Object.assign(row, { name: r.name, role });
    else db.members.push({ email: r.email, name: r.name, role, created_at: t });
  } else if (r.email) {
    db.members = db.members.filter((m) => m.email !== r.email);
  }
  return JSON.parse(JSON.stringify(r));
}

const v2Rpc = {
  hub_schema_version: () => 2,
  clock: (db) => Object.assign({}, db.clock),
  mark_signed_in: () => null,
  save_person: savePerson,
  remove_person: (db, body, email) => {
    const me = callerOf(db, email);
    if (!me || me.role !== 'admin') return refuse('42501', 'Only an admin can change the family list.', 403);
    db.removed = (db.removed || []).concat(body.p_person);
    const old = db.people.find((x) => x.id === body.p_person);
    if (!old) return null;
    if (old.email === email) return refuse('42501', 'You can\'t remove yourself. Ask another admin.', 403);
    db.members = db.members.filter((m) => m.email !== old.email);
    db.people = db.people.filter((x) => x.id !== old.id);
    return null;
  },
  rotate_day_token: (db, body, email) => {
    const me = callerOf(db, email);
    if (!me || me.role !== 'admin') return refuse('42501', 'Only an admin can do that.', 403);
    if (db.rotateFail) return refuse('XX000', 'Database restarting', 500);
    const p = db.people.find((x) => x.id === body.p_person);
    if (!p) return refuse('P0002', 'That person is no longer on the family list.');
    db.tokenSeq++;
    p.day_token = tokenOf(`rotated-${db.tokenSeq}`);
    db.rotated = (db.rotated || []).concat(body.p_person);
    return p.day_token;
  },
};

// ---- Stub v2 pages (the other builders' pages): same register() contract as the real ones
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true } },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true } },
  directory: { nav: { label: 'Directory', order: 50 } },
};
const stubModule = (name, s) => `;(function () {
  HomeHub.register({
    name: ${JSON.stringify(name)}, schema: { min: 2, max: 2 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return (${!!s.root} && !parts.length) || parts[0] === ${JSON.stringify(name)} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1>'; },
  });
})();`;

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

  async function open(opts = {}) {
    const db = opts.db || peopleDb();
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 }, timezoneId: 'Pacific/Honolulu' }, opts.ctx));
    if (opts.clipboard !== false) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-01-15T05:00:00Z'));
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (opts.v1 && /status of 404/.test(m.text()) && /hub_schema_version$/.test(m.location().url || '')) return;
      if (opts.allowConsole && opts.allowConsole.test(m.text())) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => {
      db.confirms.push([d.type(), d.message(), d.defaultValue()]);
      return db.confirm === false ? d.dismiss() : d.accept();
    });
    if (opts.noClipboardApi) {
      await context.addInitScript(() => {
        try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('NotAllowedError')) } }); } catch (e) {}
      });
    }
    await install(page, db, log, { rpc: opts.v1 ? {} : v2Rpc });
    // whoami in v2 also says which person row is the caller's.
    if (!opts.v1) {
      await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/rpc/whoami', (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const tok = (req.headers()['authorization'] || '').replace(/^Bearer\s+/i, '');
        let email = null;
        try { email = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email; } catch (e) { /* signed out */ }
        const m = db.members.find((x) => x.email === email);
        const p = m && db.people.find((x) => x.email === m.email);
        const out = m ? Object.assign({}, m, { person: p ? { id: p.id, name: p.name, role: p.role, language: p.language, color: p.color } : null }) : null;
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(out) });
      });
      // members and people: a failure on purpose when a test asks for one.
      await page.route((url) => url.host === 'test.supabase.co' && ['/rest/v1/members', '/rest/v1/people'].includes(url.pathname), (route) => {
        const fail = route.request().url().includes('/rest/v1/members') ? db.membersFail : db.peopleFail;
        if (fail && route.request().method() === 'GET') return route.fulfill({ status: 500, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'XX000', message: 'Database restarting' }) });
        return route.fallback();
      });
    }
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule(name, s) }));
    }
    await page.goto(BASE + (opts.path || '/#/people'));
    await page.waitForTimeout(opts.wait || 700);
    return { page, db, log, context };
  }

  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const card = (id) => `.ppl-card[data-id="${id}"]`;
  const cardIds = (page, sel = '.ppl-grid') => page.$$eval(`${sel} .ppl-card`, (cs) => cs.map((c) => c.dataset.id));
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(500); };
  const lastToast = async (page) => (await texts(page, '.toasts .toast')).slice(-1)[0] || '';
  const formOpen = (page) => page.evaluate(() => document.getElementById('formDialog').open);
  const formError = (page) => page.$eval('#formDialog .form-error', (e) => (e.hidden ? '' : e.textContent)).catch(() => '');
  const submit = async (page) => { await page.click('#formDialog [type="submit"]'); await page.waitForTimeout(500); };
  const editOf = async (page, id) => { await page.click(`${card(id)} [data-edit]`); await page.waitForTimeout(400); };
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const visible = (page, sel) => page.isVisible(sel);
  const pick = (page, name, value) => page.click(`#formDialog label:has(> input[name="${name}"][value="${value}"])`);
  const rpcCalls = (db, name) => (db.rpcCalls || []).filter((c) => c.name === name);
  const peopleReads = (log) => log.filter((l) => l.startsWith('GET /rest/v1/people')).length;
  const linkOf = (token) => `${BASE}/day.html?t=${token}`;

  // =====================================================================
  // 1. The list (desktop, Alex: an admin)
  // =====================================================================
  // This part makes the database fail on purpose (a 409 duplicate email, 500s); Chrome logs each one.
  let { page, db, log } = await open({ label: 'desktop', allowConsole: /status of (409|500)/ });
  const reg = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]),
    bar: [...document.querySelectorAll('.bottombar a')].map((a) => a.textContent.trim()),
  }));
  const tabNames = reg.tabs.map((t) => t[0]);
  check('register: a Family tab at "#/people", current, after Directory and before Settings', same(reg.tabs.find((t) => t[0] === 'Family'), ['Family', '#/people', 'page'])
    && tabNames.indexOf('Family') > tabNames.indexOf('Directory') && tabNames.indexOf('Family') < tabNames.indexOf('Settings'), JSON.stringify(reg.tabs));
  check('register: Family is not in the phone bottom bar (it goes in More)', !reg.bar.includes('Family'), reg.bar.join(','));
  check('head: Family, how many active people, and that an admin can change the list', (await tc(page, '.ppl-head h1')) === 'Family'
    && (await tc(page, '[data-ref="meta"]')) === '4 people · you can add, change and remove people', await tc(page, '[data-ref="meta"]'));
  check('one line explains that kids and helpers don\'t sign in', (await tc(page, '.ppl-intro')) === 'Parents and adults can sign in with their email. Kids and helpers don\'t sign in: send them their My day link instead.');
  check('list: active people in sort order; inactive ones under "Not active"', same(await cardIds(page, '[data-ref="list"] > .ppl-grid'), [ID.alex, ID.sam, ID.jordan, ID.taylor])
    && same(await cardIds(page, '.ppl-sec'), [ID.morgan]) && (await tc(page, '.ppl-sec .sec-head')) === 'Not active1', JSON.stringify(await cardIds(page)));
  check('the page read people afresh (v2.refresh) and the sign-in list', peopleReads(log) >= 2 && log.some((l) => l.startsWith('GET /rest/v1/members')), log.filter((l) => /people|members/.test(l)).join(' | '));

  const dot = await page.$eval(`${card(ID.sam)} .ppl-avatar .pdot`, (d) => ({ bg: getComputedStyle(d).backgroundColor, text: d.textContent.trim(), w: d.getBoundingClientRect().width }));
  check('card: a dot in their colour with their initial', dot.bg === 'rgb(219, 39, 119)' && dot.text.startsWith('S') && dot.w >= 40, JSON.stringify(dot));
  check('card: name, (you) on your own, role pill', (await tc(page, `${card(ID.alex)} h3`)) === 'Alex Example (you)' && (await tc(page, `${card(ID.sam)} h3`)) === 'Sam Example'
    && same(await texts(page, '[data-ref="list"] > .ppl-grid .ppl-role'), ['Parent', 'Adult', 'Kid', 'Helper']));
  check('card: "Can sign in" from members (admin for Alex); none for kids and helpers', (await tc(page, `${card(ID.alex)} .ppl-signin`)) === 'Can sign in · admin'
    && (await tc(page, `${card(ID.sam)} .ppl-signin`)) === 'Can sign in' && !(await page.$(`${card(ID.jordan)} .ppl-signin`)) && !(await page.$(`${card(ID.morgan)} .ppl-signin`)));
  check('card: email links, with "Unconfirmed" until the address is confirmed', (await page.getAttribute(`${card(ID.sam)} [data-via="email"]`, 'href')) === 'mailto:sam@example.com'
    && (await tc(page, `${card(ID.sam)} .ppl-unconfirmed`)) === 'Unconfirmed' && !(await page.$(`${card(ID.alex)} .ppl-unconfirmed`)));
  check('card: phone is tap to call', (await page.getAttribute(`${card(ID.jordan)} [data-via="call"]`, 'href')) === 'tel:2015550103' && (await tc(page, `${card(ID.jordan)} [data-via="call"]`)) === '(201) 555-0103');
  check('card: morning email in the household\'s time (6:30am), everyone\'s day for Alex', (await tc(page, `${card(ID.alex)} .ppl-digest`)) === 'Morning email at 6:30am · today\'s plan · everyone\'s day', await tc(page, `${card(ID.alex)} .ppl-digest`));
  check('card: evening preview at its own time, waiting for the address to be confirmed (signing in counts, as Sam can)', (await tc(page, `${card(ID.sam)} .ppl-digest`)) === 'Evening email at 7:00pm · tomorrow\'s plan'
    && (await tc(page, `${card(ID.sam)} .ppl-warn`)) === 'Waiting for them to confirm their email. The first email asks them to; signing in to the Home Hub also counts.', await tc(page, `${card(ID.sam)} .ppl-warn`));
  check('card: morning email off says so; Español shows for Taylor', (await tc(page, `${card(ID.jordan)} .ppl-digest`)) === 'Morning email off' && /Español/.test(await tc(page, `${card(ID.taylor)} .ppl-tags`)));
  check('card: inactive people say so and have no My day link', /Not active/.test(await tc(page, `${card(ID.morgan)} .ppl-tags`)) && !(await page.$(`${card(ID.morgan)} .ppl-day`)));
  check('admin: Add person, and Edit on every card', await visible(page, '[data-act="add"]') && (await page.$$('.ppl-card [data-edit]')).length === 5);

  // ---- My day link
  const dayLinks = async (id) => page.$$eval(`${card(id)} .ppl-day a, ${card(id)} .ppl-day button`, (as) => as.map((a) => [a.dataset.via || Object.keys(a.dataset)[0], a.getAttribute('href'), a.getAttribute('target')]));
  check('My day: Copy, WhatsApp, Text and New link (admin) for someone with a phone', same((await dayLinks(ID.jordan)).map((l) => l[0]), ['copy', 'whatsapp', 'sms', 'rotate']), JSON.stringify(await dayLinks(ID.jordan)));
  const wa = decodeURIComponent((await page.getAttribute(`${card(ID.jordan)} [data-via="whatsapp"]`, 'href')).replace('https://wa.me/12015550103?text=', ''));
  check('My day: WhatsApp (core helper) to their number with the link and the Home Screen tip', (await page.getAttribute(`${card(ID.jordan)} [data-via="whatsapp"]`, 'href')).startsWith('https://wa.me/12015550103?text=')
    && wa === `Hi Jordan, here's your Home Hub day. Tap to see what's on today and tomorrow:\n${linkOf(tokenOf(ID.jordan))}\n\nAdd it to your Home Screen to keep it one tap away.`, wa);
  const sms = decodeURIComponent((await page.getAttribute(`${card(ID.taylor)} [data-via="sms"]`, 'href')).replace('sms:+12015550104?&body=', ''));
  check('My day: Text (core helper), in Spanish for Taylor', (await page.getAttribute(`${card(ID.taylor)} [data-via="sms"]`, 'href')).startsWith('sms:+12015550104?&body=')
    && sms.startsWith('Hola Taylor: este es tu día en Home Hub.') && sms.includes(linkOf(tokenOf(ID.taylor))) && /pantalla de inicio/.test(sms), sms);
  check('My day: no phone → Copy only, with a hint', same((await dayLinks(ID.sam)).map((l) => l[0]), ['copy', 'rotate']) && /Add a phone number/.test(await tc(page, `${card(ID.sam)} .ppl-day-hint`)));
  await page.click(`${card(ID.jordan)} [data-copy]`);
  await page.waitForTimeout(300);
  check('My day: Copy puts the link on the clipboard and says so', (await page.evaluate(() => navigator.clipboard.readText())) === linkOf(tokenOf(ID.jordan))
    && (await lastToast(page)) === 'Copied Jordan\'s My day link', await lastToast(page));

  db.confirm = false;
  await page.click(`${card(ID.jordan)} [data-rotate]`);
  await page.waitForTimeout(300);
  check('New link: asks first; Cancel changes nothing', /Make a new My day link for Jordan Example\? The old link stops working right away/.test(db.confirms.slice(-1)[0][1]) && !rpcCalls(db, 'rotate_day_token').length);
  db.confirm = true;
  await page.click(`${card(ID.jordan)} [data-rotate]`);
  await page.waitForTimeout(600);
  const newTok = db.people.find((p) => p.id === ID.jordan).day_token;
  check('New link: rotate_day_token({ p_person }) once', same(rpcCalls(db, 'rotate_day_token').map((c) => c.body), [{ p_person: ID.jordan }]) && newTok !== tokenOf(ID.jordan));
  check('New link: says what to do next; Send and Copy use the new link', (await lastToast(page)) === 'New link made. Send it to Jordan.'
    && decodeURIComponent(await page.getAttribute(`${card(ID.jordan)} [data-via="whatsapp"]`, 'href')).includes(linkOf(newTok)), await lastToast(page));
  await page.click(`${card(ID.jordan)} [data-copy]`);
  await page.waitForTimeout(300);
  check('New link: Copy gives the new one', (await page.evaluate(() => navigator.clipboard.readText())) === linkOf(newTok));
  db.rotateFail = true;
  await page.click(`${card(ID.taylor)} [data-rotate]`);
  await page.waitForTimeout(500);
  check('New link: a database error shows, and the old link stays', /Database restarting/.test(await lastToast(page))
    && decodeURIComponent(await page.getAttribute(`${card(ID.taylor)} [data-via="sms"]`, 'href')).includes(linkOf(tokenOf(ID.taylor))), await lastToast(page));
  db.rotateFail = false;
  db.peopleFail = true;
  await page.click(`${card(ID.taylor)} [data-rotate]`);
  await page.waitForTimeout(600);
  const taylorTok = db.people.find((p) => p.id === ID.taylor).day_token;
  check('New link: if the list can\'t be read again just then, Send and Copy still use the new link', taylorTok !== tokenOf(ID.taylor)
    && decodeURIComponent(await page.getAttribute(`${card(ID.taylor)} [data-via="sms"]`, 'href')).includes(linkOf(taylorTok)) && (await lastToast(page)) === 'New link made. Send it to Taylor.');
  db.peopleFail = false;
  await page.screenshot({ path: SHOTS + 'people-desktop.png', fullPage: true });

  // ---- Old #/family links open this page
  await go(page, '#/settings');
  await go(page, '#/family');
  check('#/family (the v1 address) opens the Family page, its tab current', (await tc(page, '.ppl-head h1')) === 'Family'
    && (await page.$eval('.tabs a[data-tab="people"]', (a) => a.getAttribute('aria-current'))) === 'page');

  // =====================================================================
  // 2. Add a person
  // =====================================================================
  await page.click('[data-act="add"]');
  await page.waitForTimeout(400);
  check('add: the form opens, Adult by default, with a line on what each role means', await formOpen(page)
    && (await page.$eval('#formDialog input[name="role"]:checked', (i) => i.value)) === 'adult'
    && same(await texts(page, '#formDialog .ppl-choice b'), ['Parent', 'Adult', 'Kid', 'Helper'])
    && (await texts(page, '#formDialog .ppl-choice small')).every((s) => s.length > 20), JSON.stringify(await texts(page, '#formDialog .ppl-choice small')));
  check('add: colour defaults to one nobody active has yet; English; morning email off; can sign in unticked',
    (await page.$eval('#formDialog input[name="color"]:checked', (i) => i.value)) === '#9333ea' && (await page.$eval('#formDialog select[name="language"]', (s) => s.value)) === 'en'
    && (await page.$eval('#formDialog input[name="digest"]:checked', (i) => i.value)) === 'off' && !(await page.isChecked('#formDialog input[name="can_sign_in"]'))
    && !(await visible(page, '#formDialog [data-ref="digestMore"]')) && !(await page.$('#formDialog [data-act="remove"]')));
  const formLayout = await page.evaluate(() => {
    const f = document.querySelector('#formDialog form');
    const box = (el) => el.getBoundingClientRect();
    const email = box(f.elements.email.closest('label'));
    const signin = box(f.querySelector('[data-ref="signin"]'));
    return { below: signin.top >= email.bottom - 1 && signin.top - email.bottom < 40, beforePhone: signin.top < box(f.elements.phone).top,
      legend: [...f.querySelectorAll('legend')].map((l) => l.textContent), help: f.querySelector('[data-ref="signin"] small').textContent };
  });
  check('add: "Can sign in" sits right under Email (not at the bottom of the form)', formLayout.below && formLayout.beforePhone, JSON.stringify(formLayout));
  check('add: "Can sign in" says what each role can do, in plain words', formLayout.help === 'With a code emailed to them. Parents can change Family and Settings; adults can see and add everything else.', formLayout.help);
  check('add: the email choice (morning or evening) is called "Daily email"', formLayout.legend.includes('Daily email') && !formLayout.legend.includes('Morning email'), JSON.stringify(formLayout.legend));
  await page.fill('#formDialog input[name="email"]', 'pat@example.com');
  check('add: typing an email ticks "Can sign in" for an adult', await page.isChecked('#formDialog input[name="can_sign_in"]'));
  await page.fill('#formDialog input[name="email"]', '');
  check('add: clearing the email unticks it again', !(await page.isChecked('#formDialog input[name="can_sign_in"]')));
  await pick(page, 'role', 'kid');
  check('add: a kid can\'t sign in: the box goes, "send their My day link" shows', !(await visible(page, '#formDialog [data-ref="signin"]'))
    && (await tc(page, '#formDialog [data-ref="nosignin"]')) === 'Kids and helpers don\'t sign in. Send them their My day link instead (on their card).');
  await pick(page, 'role', 'adult');
  check('add: back to an adult: Can sign in shows again', await visible(page, '#formDialog [data-ref="signin"]') && !(await visible(page, '#formDialog [data-ref="nosignin"]')));
  await page.check('#formDialog input[name="can_sign_in"]');
  await page.fill('#formDialog input[name="name"]', '  Pat   Lee ');
  await submit(page);
  check('add: sign-in without an email is stopped before the database', /Add an email address so they can sign in/.test(await formError(page)) && !db.saves.length, await formError(page));
  await page.uncheck('#formDialog input[name="can_sign_in"]');
  await pick(page, 'digest', 'today');
  check('add: morning email on shows the time (household default 06:30) and its help', await visible(page, '#formDialog input[name="digest_time"]')
    && (await page.inputValue('#formDialog input[name="digest_time"]')) === '06:30' && /usual time is 6:30am/.test(await tc(page, '#formDialog [data-ref="timeHelp"]'))
    && !(await visible(page, '#formDialog [data-ref="everyone"]')));
  await submit(page);
  check('add: a morning email without an email address is stopped', /Add an email address for the morning email/.test(await formError(page)) && !db.saves.length);
  await page.fill('#formDialog input[name="email"]', 'not-an-email');
  await submit(page);
  check('add: a bad email address is stopped', /Check the email address/.test(await formError(page)) && !db.saves.length);
  await pick(page, 'role', 'kid');
  await page.fill('#formDialog input[name="email"]', 'Pat@Example.com');
  await page.fill('#formDialog input[name="phone"]', '(201) 555-0105');
  await page.click('#formDialog .ppl-swatch:has(input[value="#16a34a"])');
  await page.selectOption('#formDialog select[name="language"]', 'es');
  await pick(page, 'digest', 'tomorrow');
  check('add: switching to the evening preview sets 7:00pm', (await page.inputValue('#formDialog input[name="digest_time"]')) === '19:00');
  const peopleBefore = peopleReads(log);
  await submit(page);
  check('add: save_person with the row and p_can_sign_in false (a kid)', same(db.saves.slice(-1)[0], { p: {
    name: 'Pat Lee', role: 'kid', email: 'pat@example.com', phone: '(201) 555-0105', color: '#16a34a', language: 'es', digest_enabled: true, active: true,
    digest_day: 'tomorrow', digest_time: '19:00', digest_scope: 'mine', sort_order: 5 }, p_can_sign_in: false }), JSON.stringify(db.saves.slice(-1)[0]));
  const pat = db.people.find((p) => p.name === 'Pat Lee');
  check('add: closes, says so, refreshes and shows the new person last', !(await formOpen(page)) && (await lastToast(page)) === 'Added Pat Lee' && peopleReads(log) > peopleBefore
    && (await cardIds(page, '[data-ref="list"] > .ppl-grid')).slice(-1)[0] === pat.id && (await tc(page, `${card(pat.id)} .ppl-digest`)) === 'Evening email at 7:00pm · tomorrow\'s plan', await lastToast(page));
  check('add: the core\'s cache has the new person too (v2.refresh)', await page.evaluate((id) => !!HomeHub.core.v2.person(id), pat.id));
  check('add: a kid waiting to confirm: no "signing in also counts" (kids don\'t sign in)', (await tc(page, `${card(pat.id)} .ppl-warn`)) === 'Waiting for them to confirm their email. The first email asks them to.'
    && (await tc(page, `${card(pat.id)} .ppl-unconfirmed`)) === 'Unconfirmed', await tc(page, `${card(pat.id)} .ppl-warn`));

  // An adult who signs in, then a duplicate email.
  await page.click('[data-act="add"]');
  await page.waitForTimeout(400);
  await page.fill('#formDialog input[name="name"]', 'Morgan Lee');
  await page.fill('#formDialog input[name="email"]', 'sam@example.com');
  await page.check('#formDialog input[name="can_sign_in"]');
  await submit(page);
  check('add: the database\'s error (a duplicate email) shows in the form, which stays open', (await formError(page)) === 'Someone on the family list already has that email address.' && await formOpen(page), await formError(page));
  await page.fill('#formDialog input[name="email"]', 'morgan.lee@example.com');
  await submit(page);
  check('add: an adult who can sign in → p_can_sign_in true, and a members row (member)', db.saves.slice(-1)[0].p_can_sign_in === true
    && same(db.members.find((m) => m.email === 'morgan.lee@example.com'), { email: 'morgan.lee@example.com', name: 'Morgan Lee', role: 'member', created_at: '2026-10-25T13:00:00.000000+00:00' })
    && (await tc(page, `${card(db.people.find((p) => p.name === 'Morgan Lee').id)} .ppl-signin`)) === 'Can sign in', JSON.stringify(db.members));

  // =====================================================================
  // 3. Edit
  // =====================================================================
  await editOf(page, ID.sam);
  check('edit Sam: the form has the saved values, "Can sign in" ticked (a members row)', (await page.inputValue('#formDialog input[name="name"]')) === 'Sam Example'
    && (await page.$eval('#formDialog input[name="role"]:checked', (i) => i.value)) === 'adult' && (await page.inputValue('#formDialog input[name="email"]')) === 'sam@example.com'
    && (await page.$eval('#formDialog input[name="color"]:checked', (i) => i.value)) === '#db2777' && (await page.$eval('#formDialog input[name="digest"]:checked', (i) => i.value)) === 'tomorrow'
    && (await page.inputValue('#formDialog input[name="digest_time"]')) === '19:00' && await page.isChecked('#formDialog input[name="can_sign_in"]')
    && await page.isChecked('#formDialog input[name="active"]') && await visible(page, '#formDialog [data-act="remove"]'));
  await pick(page, 'digest', 'today');
  check('edit: back to the morning: the household\'s time again', (await page.inputValue('#formDialog input[name="digest_time"]')) === '06:30');
  await submit(page);
  check('edit: the household\'s time is saved as null (follows Settings); the id is sent', same(db.saves.slice(-1)[0], { p: { id: ID.sam,
    name: 'Sam Example', role: 'adult', email: 'sam@example.com', phone: null, color: '#db2777', language: 'en', digest_enabled: true, active: true,
    digest_day: 'today', digest_time: null, digest_scope: 'mine' }, p_can_sign_in: true }) && (await lastToast(page)) === 'Saved Sam Example', JSON.stringify(db.saves.slice(-1)[0]));
  check('edit: the card follows', (await tc(page, `${card(ID.sam)} .ppl-digest`)) === 'Morning email at 6:30am · today\'s plan', await tc(page, `${card(ID.sam)} .ppl-digest`));

  await editOf(page, ID.sam);
  await page.fill('#formDialog input[name="digest_time"]', '07:15');
  await pick(page, 'role', 'parent');
  check('edit: a parent can get everyone\'s day', await visible(page, '#formDialog [data-ref="everyone"]'));
  await page.check('#formDialog input[name="everyone"]');
  await submit(page);
  check('edit: own time, everyone\'s day, parent → admin sign-in', same(db.saves.slice(-1)[0].p, { id: ID.sam, name: 'Sam Example', role: 'parent', email: 'sam@example.com', phone: null,
    color: '#db2777', language: 'en', digest_enabled: true, active: true, digest_day: 'today', digest_time: '07:15', digest_scope: 'everyone' })
    && (await tc(page, `${card(ID.sam)} .ppl-signin`)) === 'Can sign in · admin' && (await tc(page, `${card(ID.sam)} .ppl-digest`)) === 'Morning email at 7:15am · today\'s plan · everyone\'s day',
  JSON.stringify(db.saves.slice(-1)[0]));

  // Turning the morning email off leaves its day and time alone; taking sign-in away asks first.
  await editOf(page, ID.sam);
  await pick(page, 'digest', 'off');
  await page.uncheck('#formDialog input[name="can_sign_in"]');
  db.confirm = false;
  const savesBefore = db.saves.length;
  await submit(page);
  check('edit: taking sign-in away asks first; Cancel saves nothing', db.saves.length === savesBefore && /Sam Example won't be able to sign in any more/.test(db.confirms.slice(-1)[0][1]) && await formOpen(page));
  db.confirm = true;
  await submit(page);
  check('edit: off sends only digest_enabled false (day and time kept); p_can_sign_in false', same(db.saves.slice(-1)[0], { p: { id: ID.sam, name: 'Sam Example', role: 'parent',
    email: 'sam@example.com', phone: null, color: '#db2777', language: 'en', digest_enabled: false, active: true }, p_can_sign_in: false })
    && db.people.find((p) => p.id === ID.sam).digest_time === '07:15' && !db.members.some((m) => m.email === 'sam@example.com')
    && !(await page.$(`${card(ID.sam)} .ppl-signin`)) && (await tc(page, `${card(ID.sam)} .ppl-digest`)) === 'Morning email off', JSON.stringify(db.saves.slice(-1)[0]));
  check('card: a parent who can\'t sign in says so, and how to turn it on', (await tc(page, `${card(ID.sam)} .ppl-cant`)) === 'Can\'t sign in yet (Edit to turn on)', await tc(page, `${card(ID.sam)} .ppl-tags`));
  check('card: no "Unconfirmed" badge while their email is off (nothing waits on it)', !(await page.$(`${card(ID.sam)} .ppl-unconfirmed`)) && !(await page.$(`${card(ID.sam)} .ppl-warn`)));

  // Your own row: role, email, sign-in and active are locked, and no Remove.
  await editOf(page, ID.alex);
  const mine = await page.evaluate(() => {
    const f = document.querySelector('#formDialog form');
    return {
      note: (f.querySelector('.ppl-form-note') || {}).textContent,
      roles: [...f.querySelectorAll('input[name="role"]')].map((i) => [i.value, i.disabled]),
      email: f.elements.email.readOnly, signIn: [f.elements.can_sign_in.checked, f.elements.can_sign_in.disabled], active: [f.elements.active.checked, f.elements.active.disabled],
      remove: !!f.querySelector('[data-act="remove"]'),
    };
  });
  check('edit yourself: role, email, sign-in and active locked; no Remove; a note says why', same(mine, {
    note: 'This is you. Another admin can change your role, email or sign-in.', roles: [['parent', false], ['adult', true], ['kid', true], ['helper', true]],
    email: true, signIn: [true, true], active: [true, true], remove: false }), JSON.stringify(mine));
  await page.fill('#formDialog input[name="phone"]', '(201) 555-0111');
  await submit(page);
  check('edit yourself: other changes save, still signing in as a parent', same(db.saves.slice(-1)[0], { p: { id: ID.alex, name: 'Alex Example', role: 'parent', email: 'alex@example.com',
    phone: '(201) 555-0111', color: '#2563eb', language: 'en', digest_enabled: true, active: true, digest_day: 'today', digest_time: null, digest_scope: 'everyone' }, p_can_sign_in: true })
    && (await lastToast(page)) === 'Saved Alex Example', JSON.stringify(db.saves.slice(-1)[0]));

  // A save that fails keeps the form open with the reason.
  await editOf(page, ID.taylor);
  check('edit Taylor: Español, Helper, no sign-in box', (await page.$eval('#formDialog select[name="language"]', (s) => s.value)) === 'es'
    && (await page.$eval('#formDialog input[name="role"]:checked', (i) => i.value)) === 'helper' && !(await visible(page, '#formDialog [data-ref="signin"]')));
  db.saveFail = true;
  await page.fill('#formDialog input[name="name"]', 'Taylor Q Example');
  await submit(page);
  check('edit: a database error shows in the form; nothing changes on the page', (await formError(page)) === 'Database restarting' && await formOpen(page)
    && (await tc(page, `${card(ID.taylor)} h3`)) === 'Taylor Example', await formError(page));
  db.saveFail = false;
  await page.click('#formDialog [data-close]:not(.d-close)');
  await page.waitForTimeout(200);

  // =====================================================================
  // 3b. A new parent can sign in without hunting for the box; taking someone who signs in off the
  //     lists (untick Active) takes their sign-in too, after asking
  // =====================================================================
  await page.click('[data-act="add"]');
  await page.waitForTimeout(400);
  await page.fill('#formDialog input[name="name"]', 'Riley Morgan');
  await pick(page, 'role', 'parent');
  await page.fill('#formDialog input[name="email"]', 'riley@example.com');
  await page.fill('#formDialog input[name="phone"]', '(201) 555-0102');
  await submit(page);
  const riley = db.people.find((p) => p.name === 'Riley Morgan');
  check('add a parent with an email: they can sign in (as an admin) without ticking anything', db.saves.slice(-1)[0].p_can_sign_in === true
    && !!riley && db.members.some((m) => m.email === 'riley@example.com' && m.role === 'admin') && (await tc(page, `${card(riley.id)} .ppl-signin`)) === 'Can sign in · admin',
  JSON.stringify(db.saves.slice(-1)[0]));
  await editOf(page, riley.id);
  await page.uncheck('#formDialog input[name="active"]');
  const offState = await page.evaluate(() => {
    const f = document.querySelector('#formDialog form');
    return { disabled: f.elements.can_sign_in.disabled, note: (f.querySelector('[data-ref="inactiveNote"]') || {}).hidden === false ? f.querySelector('[data-ref="inactiveNote"]').textContent : '' };
  });
  check('edit: unticking Active greys out "Can sign in", with a note why', offState.disabled && offState.note === 'Someone who isn\'t active can\'t sign in. Tick Active again to let them.', JSON.stringify(offState));
  const confirmsBefore = db.confirms.length;
  await submit(page);
  check('edit: taking someone who signs in off the lists asks first, then saves inactive without sign-in', db.confirms.length === confirmsBefore + 1
    && /Riley Morgan won't be able to sign in any more/.test(db.confirms.slice(-1)[0][1])
    && db.saves.slice(-1)[0].p_can_sign_in === false && db.saves.slice(-1)[0].p.active === false && !(await formOpen(page))
    && db.people.find((p) => p.id === riley.id).active === false && !db.members.some((m) => m.email === 'riley@example.com'), JSON.stringify({ err: await formError(page), save: db.saves.slice(-1)[0] }));
  await editOf(page, riley.id);
  await page.check('#formDialog input[name="active"]');
  check('edit: ticking Active again brings "Can sign in" back', !(await page.isDisabled('#formDialog input[name="can_sign_in"]')));
  await page.click('#formDialog [data-close]:not(.d-close)');
  await page.waitForTimeout(200);

  // =====================================================================
  // 4. Remove
  // =====================================================================
  await editOf(page, ID.jordan);
  db.confirm = false;
  await page.click('#formDialog [data-act="remove"]');
  await page.waitForTimeout(300);
  check('remove: asks first (what happens to their items and link); Cancel removes nothing', /Remove Jordan Example from the family list\? Their My day link stops working\. Their events and tasks stay, with nobody in charge\./.test(db.confirms.slice(-1)[0][1])
    && !rpcCalls(db, 'remove_person').length && await formOpen(page), db.confirms.slice(-1)[0][1]);
  db.confirm = true;
  await page.click('#formDialog [data-act="remove"]');
  await page.waitForTimeout(600);
  check('remove: remove_person({ p_person }), then the list and the cache drop them', same(rpcCalls(db, 'remove_person').map((c) => c.body), [{ p_person: ID.jordan }])
    && !(await page.$(card(ID.jordan))) && (await lastToast(page)) === 'Removed Jordan Example' && !(await formOpen(page))
    && await page.evaluate((id) => !HomeHub.core.v2.person(id), ID.jordan), await lastToast(page));
  const morganLee = db.people.find((p) => p.name === 'Morgan Lee');
  await editOf(page, morganLee.id);
  await page.click('#formDialog [data-act="remove"]');
  await page.waitForTimeout(600);
  check('remove: someone who signs in is warned they lose it; their members row goes', /They won't be able to sign in any more\./.test(db.confirms.slice(-1)[0][1])
    && !db.members.some((m) => m.email === 'morgan.lee@example.com'));
  check('no XSS so far', await page.evaluate(() => !window.__xss));
  await page.context().close();

  // =====================================================================
  // 5. A member (Sam) sees the list read-only; strays, errors, escaping
  // =====================================================================
  const memberDb = peopleDb();
  memberDb.people.push(person('0e1e0000-0000-4000-8000-000000000009', XSS, 'helper', '#b91c1c', 9, { phone: '(201) 555-0109', email: 'x"><b>@example.com' }));
  ({ page, db } = await open({ label: 'member', email: 'sam@example.com', db: memberDb }));
  check('member: no Add, no Edit, no New link; Copy and Send still there', !(await page.$('[data-act="add"]')) && !(await page.$('[data-edit]')) && !(await page.$('[data-rotate]'))
    && (await page.$$('[data-copy]')).length === 5 && !!(await page.$(`${card(ID.jordan)} [data-via="whatsapp"]`)));
  check('member: the head says only admins can change the list', (await tc(page, '[data-ref="meta"]')) === '5 people · only admins (parents who sign in) can change the list', await tc(page, '[data-ref="meta"]'));
  check('member: (you) on Sam', (await tc(page, `${card(ID.sam)} h3`)) === 'Sam Example (you)');
  check('escaping: names and emails are text, never markup', await page.evaluate(() => !window.__xss && !document.querySelector('.ppl-card img') && !document.querySelector('.ppl-card b:not(.x)'))
    && (await tc(page, '.ppl-card[data-id="0e1e0000-0000-4000-8000-000000000009"] h3')) === XSS);
  await page.context().close();

  const strayDb = peopleDb();
  strayDb.members.push({ email: 'pat@example.com', name: 'Pat Lee', role: 'member', created_at: T });
  ({ page, db } = await open({ label: 'stray', db: strayDb }));
  check('admin: a sign-in with no person row is pointed out', /Can sign in, but isn't on the family list: pat@example\.com\./.test(await tc(page, '.ppl-note')), await tc(page, '.ppl-note'));
  await page.context().close();

  const failDb = peopleDb();
  failDb.membersFail = true;
  ({ page, db } = await open({ label: 'members-fail', db: failDb, allowConsole: /status of 500/ }));
  check('members unreadable: the list still shows, with a note; no "Can sign in" guesses', (await cardIds(page)).length === 5 && !(await page.$('.ppl-signin'))
    && /Couldn't check who can sign in just now/.test(await tc(page, '.ppl-note')));
  await page.click(`${card(ID.sam)} [data-edit]`);
  await page.waitForTimeout(400);
  check('members unreadable: Edit doesn\'t open a form that could drop a sign-in; the error shows', !(await formOpen(page)) && /Database restarting/.test(await lastToast(page)), await lastToast(page));
  await page.context().close();

  // Copy with no clipboard: the link shows in a prompt to copy by hand.
  ({ page, db } = await open({ label: 'no-clipboard', clipboard: false, noClipboardApi: true }));
  await page.click(`${card(ID.jordan)} [data-copy]`);
  await page.waitForTimeout(300);
  check('Copy without a clipboard: a prompt with the link', same(db.confirms.slice(-1)[0], ['prompt', 'Copy Jordan\'s My day link:', linkOf(tokenOf(ID.jordan))]), JSON.stringify(db.confirms.slice(-1)[0]));
  await page.context().close();

  // =====================================================================
  // 6. Phones (390px): no sideways scroll, 44px targets; light and dark
  // =====================================================================
  for (const scheme of ['light', 'dark']) {
    ({ page, db } = await open({ label: `phone-${scheme}`, ctx: Object.assign({ colorScheme: scheme }, phone) }));
    check(`phone (${scheme}): no sideways scroll`, await noSideScroll(page));
    const sizes = await page.$$eval('.ppl-card .btn, .ppl-link, .ppl-add', (es) => es.filter((e) => e.offsetParent).map((e) => {
      const r = e.getBoundingClientRect(); return [e.className, e.textContent.trim().slice(0, 20), Math.round(r.width), Math.round(r.height)];
    }));
    check(`phone (${scheme}): every button and link is at least 44px`, sizes.length > 20 && sizes.every(([, , w, h]) => w >= 44 && h >= 44), JSON.stringify(sizes.filter(([, , w, h]) => w < 44 || h < 44)));
    check(`phone (${scheme}): cards fit the screen`, await page.$$eval('.ppl-card', (cs) => cs.every((c) => c.getBoundingClientRect().right <= window.innerWidth)));
    const colors = await page.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(document.querySelector('.ppl-card')).backgroundColor,
      text: getComputedStyle(document.querySelector('.ppl-card h3')).color }));
    const want = scheme === 'dark' ? { body: 'rgb(18, 17, 16)', card: 'rgb(27, 25, 23)', text: 'rgb(243, 239, 233)' } : { body: 'rgb(246, 244, 240)', card: 'rgb(255, 255, 255)', text: 'rgb(31, 27, 22)' };
    check(`phone (${scheme}): page and cards use the theme's colours`, same(colors, want), JSON.stringify(colors));
    await page.screenshot({ path: SHOTS + `people-phone-${scheme}.png`, fullPage: true });
    await editOf(page, ID.sam);
    await pick(page, 'role', 'parent');
    const form = await page.evaluate(() => {
      const d = document.getElementById('formDialog');
      const targets = [...d.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="time"], select, button, .ppl-choice, .ppl-swatch, .ppl-seg span, .ppl-check')]
        .filter((e) => e.offsetParent);
      const small = targets.map((e) => [e.name || e.className || e.textContent.trim().slice(0, 20), Math.round(e.getBoundingClientRect().height), Math.round(e.getBoundingClientRect().width)])
        .filter(([, h, w]) => h < 44 || w < 44);
      return { n: targets.length, fits: d.scrollWidth <= d.clientWidth && d.getBoundingClientRect().right <= window.innerWidth, small };
    });
    check(`phone (${scheme}): the form fits the screen; its fields, choices and buttons are 44px`, form.n > 25 && form.fits && form.small.length === 0, JSON.stringify(form));
    await page.screenshot({ path: SHOTS + `people-form-phone-${scheme}.png` });
    await page.context().close();
  }

  // =====================================================================
  // 7. v1 mode: no v2 Family page; #/family is still the v1 page
  // =====================================================================
  ({ page } = await open({ label: 'v1', v1: true, path: '/#/family' }));
  const v1tabs = await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent));
  check('v1: the old tabs; #/family is still the v1 Family page', same(v1tabs, ['Home', 'Projects', 'Contractors', 'Family']) && (await tc(page, 'h1')) === 'Family'
    && !!(await page.$('[data-act="add-member"]')) && !(await page.$('.ppl-card')), v1tabs.join(','));
  await page.context().close();

  await browser.close();
  await server.close();
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
