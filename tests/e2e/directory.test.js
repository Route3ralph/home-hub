// Browser tests for the v2 Directory page (assets/modules/directory.js): the kind filter, search,
// cards (call / text / WhatsApp / email / website / map, contract ends, notes, projects), account
// numbers for admins only (masked, Show, loaded on their own, never asked for by a member), the
// add / edit / delete form, the database's "account details need an admin" rule, old #/contractors
// links, #/directory/<id>, use('directory').contractorForm, phones (390px) and dark mode.
//
// The database rules the mock doesn't know are added here as routes in front of it, the way
// PostgREST answers with the migration's policies: contractor_secrets is admins only (a member's
// read comes back empty, a write is refused); a member's update or delete of a directory entry that
// has account details changes nothing and returns no rows; contractor_secrets upserts merge on
// contractor_id; deleting an entry deletes its account details. The other v2 pages are small stubs
// served in place of their files, so this file tests the Directory alone. The browser runs in
// Pacific/Honolulu with its clock on another day; "today" comes from clock() (America/New_York).
// Run alone with: node tests/e2e/directory.test.js
const { chromium } = require('playwright');
const { createHash } = require('crypto');
const { makeDb, install, signIn, SUPA } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };

// ---- Fixtures (fictional people, 555-01xx numbers, example.com / .example)
const T = '2026-10-24T16:00:00.000000+00:00';
const TODAY = '2026-10-25';   // the household's date; the device is on Jan 14, evening, in Honolulu
const ID = { alex: '0d1e0000-0000-4000-8000-000000000001', sam: '0d1e0000-0000-4000-8000-000000000002', jordan: '0d1e0000-0000-4000-8000-000000000003' };
const person = (id, name, role, color, sort, extra) => Object.assign({
  id, name, role, email: null, email_verified_at: null, phone: null, color, language: 'en',
  day_token: createHash('md5').update(id).digest('hex'), digest_enabled: false, digest_time: null,
  digest_day: 'today', digest_scope: 'mine', sort_order: sort, active: true, created_at: T, updated_at: T,
}, extra);
// A v2 directory row: every contractors column (v1's plus kind, category, address, contract_end, updated_by).
const entry = (o) => Object.assign({ id: null, name: '', company: null, trade: null, phone: null, email: null, website: null, notes: null,
  kind: 'contractor', category: null, address: null, contract_end: null, updated_by: null, created_at: T, updated_at: T }, o);
const secret = (o) => Object.assign({ contractor_id: null, account_number: null, account_name: null, secret_notes: null, updated_at: T, updated_by: 'alex@example.com' }, o);
const XSS_NAME = '<img src=x onerror="window.__xss=1">Tutor';

function dirDb() {
  const db = makeDb(); // members: Alex (admin), Sam (member); v1 contractors Pat Lee and Maria Gomez (no kind)
  db.people = [
    person(ID.alex, 'Alex Example', 'parent', '#2563eb', 1, { email: 'alex@example.com', email_verified_at: T }),
    person(ID.sam, 'Sam Example', 'adult', '#db2777', 2, { email: 'sam@example.com' }),
    person(ID.jordan, 'Jordan Example', 'kid', '#16a34a', 3),
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: null, updated_at: T, updated_by: null }];
  db.clock = { local_date: TODAY, local_time: '09:00:00', tz: 'America/New_York' };
  db.contractors.push(
    entry({ id: 'c-acme', kind: 'account', name: 'Acme Internet', trade: 'Internet', category: 'Internet', phone: '(201) 555-0102', email: 'help@acme.example', website: 'https://acme.example/account', contract_end: '2026-11-10', notes: 'Promo price until November.' }),
    entry({ id: 'c-gas', kind: 'account', name: 'Example Gas Co', category: 'Gas', phone: '(201) 555-0106', contract_end: '2026-10-20' }),
    entry({ id: 'c-water', kind: 'account', name: 'City Water', category: 'Water', phone: '(201) 555-0107', contract_end: '2027-03-03' }),
    entry({ id: 'c-vet', kind: 'service', name: 'Happy Paws Vet', company: 'Happy Paws Animal Clinic', category: 'Vet', phone: '(201) 555-0103', email: 'desk@happypaws.example', website: 'happypaws.example', address: '12 Example Street, Springfield', notes: 'Ask for Dr. Morgan.' }),
    entry({ id: 'c-poison', kind: 'emergency', name: 'Poison control', category: 'Poison control', phone: '(201) 555-0199' }),
    entry({ id: 'c-911', kind: 'emergency', name: 'Emergency services', phone: '911' }),
    entry({ id: 'c-xss', kind: 'service', name: XSS_NAME, category: 'Tutor', website: 'javascript:alert(1)', notes: '<script>window.__xss=2</script>' }),
  );
  db.contractor_secrets = [
    secret({ contractor_id: 'c-acme', account_number: '0012 3456 7890', account_name: 'Alex Example', secret_notes: 'Customer since 2019.' }),
    secret({ contractor_id: 'c-water', account_number: '998877' }),
  ];
  db.secretCalls = [];
  db.writes = [];
  db.confirms = [];
  return db;
}

const v2Rpc = {
  hub_schema_version: () => 2,
  clock: (db) => Object.assign({}, db.clock),
  mark_signed_in: () => null,
};

// ---- Stub v2 pages: same register() contract as the real ones
const STUBS = {
  today: { nav: { label: 'Today', order: 10, href: '#/', primary: true }, root: true },
  calendar: { nav: { label: 'Calendar', order: 20, primary: true } },
  tasks: { nav: { label: 'Tasks', order: 30, primary: true } },
  people: { nav: { label: 'Family', order: 60 } },
  settings: { nav: { label: 'Settings', order: 70 } },
};
const stubModule = (name, s) => `;(function () {
  HomeHub.register({
    name: ${JSON.stringify(name)}, schema: { min: 2, max: 2 }, nav: ${JSON.stringify(s.nav)},
    match: function (parts) { return (${!!s.root} && !parts.length) || parts[0] === ${JSON.stringify(name)} ? {} : null; },
    render: function (main) { main.innerHTML = '<h1 id="stub">${s.nav.label}</h1>'; },
  });
})();`;

const emailOf = (req) => {
  const tok = (req.headers()['authorization'] || '').replace(/^Bearer\s+/i, '');
  try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email || null; } catch (e) { return null; }
};
// The eq filters in a PostgREST address (the only kind this page sends).
const eqFilters = (url) => [...url.searchParams].filter(([k]) => !['select', 'order', 'limit', 'on_conflict', 'columns'].includes(k))
  .map(([k, v]) => { if (!v.startsWith('eq.')) throw new Error(`unexpected filter ${k}=${v}`); return [k, v.slice(3)]; });
const matches = (row, filters) => filters.every(([k, v]) => row[k] != null && String(row[k]) === v);

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

  async function open(opts = {}) {
    const db = opts.db || dirDb();
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 }, timezoneId: 'Pacific/Honolulu' }, opts.ctx));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
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
      db.confirms.push(d.message());
      return db.confirm === false ? d.dismiss() : d.accept();
    });
    await install(page, db, log, { rpc: opts.v1 ? {} : v2Rpc });

    const reply = (route, status, payload) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: payload === undefined ? '' : JSON.stringify(payload) });
    const isAdmin = (email) => (db.members.find((m) => m.email === email) || {}).role === 'admin';
    const wantsRows = (req) => /return=representation/.test(req.headers()['prefer'] || '');

    // contractor_secrets: admins only. A member's read comes back empty (RLS), writes are refused.
    await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/contractor_secrets', (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const url = new URL(req.url());
      const email = emailOf(req);
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      db.secretCalls.push({ method: req.method(), url: decodeURIComponent(url.pathname + url.search), email, body, prefer: req.headers()['prefer'] || '' });
      const filters = eqFilters(url);
      if (req.method() === 'GET') {
        if (db.secretsFail) return reply(route, 500, { code: 'XX000', message: 'Database restarting' });
        return reply(route, 200, isAdmin(email) ? db.contractor_secrets.filter((r) => matches(r, filters)) : []);
      }
      if (!isAdmin(email)) return reply(route, 403, { code: '42501', message: 'new row violates row-level security policy for table "contractor_secrets"' });
      if (req.method() === 'POST') {
        if (db.secretsSaveFail) return reply(route, 500, { code: 'XX000', message: 'Database restarting' });
        const merge = url.searchParams.get('on_conflict') === 'contractor_id' && /resolution=merge-duplicates/.test(req.headers()['prefer'] || '');
        const out = [];
        for (const r of Array.isArray(body) ? body : [body]) {
          const old = db.contractor_secrets.find((x) => x.contractor_id === r.contractor_id);
          if (old && !merge) return reply(route, 409, { code: '23505', message: 'duplicate key value violates unique constraint "contractor_secrets_pkey"' });
          if (old) Object.assign(old, r, { updated_at: T, updated_by: email });
          else db.contractor_secrets.push(secret(Object.assign({}, r, { updated_by: email })));
          out.push(old || db.contractor_secrets[db.contractor_secrets.length - 1]);
        }
        return wantsRows(req) ? reply(route, 201, out) : route.fulfill({ status: 201, headers: CORS });
      }
      if (req.method() === 'DELETE') {
        const gone = db.contractor_secrets.filter((r) => matches(r, filters));
        db.contractor_secrets = db.contractor_secrets.filter((r) => !matches(r, filters));
        return wantsRows(req) ? reply(route, 200, gone) : route.fulfill({ status: 204, headers: CORS });
      }
      return reply(route, 405, {});
    });

    // contractors: writes are recorded; updates and deletes follow private.contractors_guard (an entry
    // with account details changes only for an admin; anyone else gets 42501 with the reason).
    await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/contractors', (route) => {
      const req = route.request();
      const method = req.method();
      if (method === 'OPTIONS' || method === 'GET') return route.fallback();
      const url = new URL(req.url());
      const email = emailOf(req);
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      db.writes.push({ method, url: decodeURIComponent(url.pathname + url.search), email, body });
      if (db.saveFail && method !== 'DELETE') return reply(route, 500, { code: 'XX000', message: 'Database restarting' });
      if (method === 'POST') return route.fallback();
      const filters = eqFilters(url);
      const allowed = (r) => isAdmin(email) || !db.contractor_secrets.some((s) => s.contractor_id === r.id);
      const blocked = db.contractors.find((r) => matches(r, filters) && !allowed(r));
      if (blocked) {
        const verb = method === 'DELETE' ? 'delete' : 'change';
        return reply(route, 403, { code: '42501', message: `Only an admin can ${verb} ${blocked.name}, because it has account details saved. Ask an admin to ${verb} it.`, details: null, hint: null });
      }
      const hit = db.contractors.filter((r) => matches(r, filters) && allowed(r));
      if (method === 'PATCH') hit.forEach((r) => Object.assign(r, body, { updated_at: '2026-10-25T13:00:00.000000+00:00', updated_by: email }));
      if (method === 'DELETE') {
        db.contractors = db.contractors.filter((r) => !hit.includes(r));
        db.contractor_secrets = db.contractor_secrets.filter((s) => !hit.some((r) => r.id === s.contractor_id)); // on delete cascade
      }
      return wantsRows(req) ? reply(route, 200, hit) : route.fulfill({ status: 204, headers: CORS });
    });
    // projects: record writes, then let the mock answer.
    await page.route((url) => url.host === 'test.supabase.co' && url.pathname === '/rest/v1/projects', (route) => {
      const req = route.request();
      if (req.method() === 'PATCH' || req.method() === 'POST') db.writes.push({ method: req.method(), url: decodeURIComponent(req.url().replace(SUPA, '')), email: emailOf(req), body: JSON.parse(req.postData() || 'null') });
      return route.fallback();
    });
    for (const [name, s] of Object.entries(STUBS)) {
      await page.route(`**/assets/modules/${name}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: opts.v1 ? '// not under test' : stubModule(name, s) }));
    }
    if (opts.storedKind) await context.addInitScript((k) => { try { localStorage.setItem('homehub.directory.kind', k); } catch (e) {} }, opts.storedKind);
    await page.goto(BASE + (opts.path || '/#/directory'));
    await page.waitForTimeout(opts.wait || 700);
    return { page, db, log, context };
  }

  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const tc = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const card = (id) => `.dir-card[data-id="${id}"]`;
  const cardIds = (page) => page.$$eval('.dir-card', (cs) => cs.map((c) => c.dataset.id));
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(450); };
  const lastToast = async (page) => (await texts(page, '.toasts .toast')).slice(-1)[0] || '';
  const formOpen = (page) => page.evaluate(() => document.getElementById('formDialog').open);
  const formError = (page) => page.$eval('#formDialog .form-error', (e) => (e.hidden ? '' : e.textContent)).catch(() => '');
  const submit = async (page) => { await page.click('#formDialog [type="submit"]'); await page.waitForTimeout(450); };
  const editOf = async (page, id) => { await page.click(`${card(id)} [data-edit]`); await page.waitForTimeout(400); };
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const writes = (db, method, path) => db.writes.filter((w) => w.method === method && w.url.startsWith(path));
  const chipState = (page) => page.$$eval('.dir-chip', (cs) => cs.map((c) => [c.firstChild.textContent, c.querySelector('.n').textContent, c.getAttribute('aria-pressed')]));

  // =====================================================================
  // 1. Registration and the All view (desktop, Alex: an admin)
  // =====================================================================
  // This part makes the database fail on purpose (500s); Chrome logs each one.
  let { page, db, log } = await open({ label: 'desktop', allowConsole: /status of 500/ });
  const reg = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]),
    bar: [...document.querySelectorAll('.bottombar a')].map((a) => a.textContent.trim()),
  }));
  const tabNames = reg.tabs.map((t) => t[0]);
  check('register: a Directory tab at "#/directory", current, after Tasks and before Family', same(reg.tabs.find((t) => t[0] === 'Directory'), ['Directory', '#/directory', 'page'])
    && tabNames.indexOf('Directory') > tabNames.indexOf('Tasks') && tabNames.indexOf('Directory') < tabNames.indexOf('Family'), JSON.stringify(reg.tabs));
  check('register: Directory is not in the phone bottom bar (it goes in More)', !reg.bar.includes('Directory'), reg.bar.join(','));
  check('register: no v1 Contractors tab in v2', !tabNames.includes('Contractors'));
  check('head: the title and how many entries, with the admins-only note for an admin', (await text(page, '.dir-head h1')) === 'Directory'
    && (await tc(page, '[data-ref="meta"]')) === '9 entries · visible to the family only; account numbers to admins only', await tc(page, '[data-ref="meta"]'));
  check('kinds: All · Contractors · Accounts & utilities · Services · Emergency, with counts; All chosen', same(await chipState(page),
    [['All', '9', 'true'], ['Contractors', '2', 'false'], ['Accounts & utilities', '3', 'false'], ['Services', '2', 'false'], ['Emergency', '2', 'false']]), JSON.stringify(await chipState(page)));
  check('all: one section per kind, in order, with counts', same(await texts(page, '.dir-sec .sec-head'),
    ['Contractors2', 'Accounts & utilities3', 'Services2', 'Emergency2']), JSON.stringify(await texts(page, '.dir-sec .sec-head')));
  check('all: cards in name order within each kind', same(await cardIds(page), ['c-maria', 'c-pat', 'c-acme', 'c-water', 'c-gas', 'c-xss', 'c-vet', 'c-911', 'c-poison']), (await cardIds(page)).join(','));
  check('v1 rows (no kind) are contractors, with their trade as the category', (await tc(page, `${card('c-pat')} .dir-pill`)) === 'Electrician'
    && (await page.$eval(card('c-pat'), (c) => c.closest('.dir-sec').dataset.group)) === 'contractor');
  check('card: name, company and category', (await tc(page, `${card('c-vet')} h3`)) === 'Happy Paws Vet' && (await tc(page, `${card('c-vet')} .company`)) === 'Happy Paws Animal Clinic'
    && (await tc(page, `${card('c-vet')} .dir-pill`)) === 'Vet');
  check('card: without a category the kind shows instead', (await tc(page, `${card('c-911')} .dir-pill`)) === 'Emergency');

  const links = (id) => page.$$eval(`${card(id)} a[data-via]`, (as) => as.map((a) => [a.dataset.via, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]));
  check('links: call, text and WhatsApp (core message helpers), email and website', same(await links('c-pat'), [
    ['call', 'tel:2015550100', null, null], ['sms', 'sms:+12015550100?&body=', null, null], ['whatsapp', 'https://wa.me/12015550100?text=', '_blank', 'noopener'],
    ['email', 'mailto:pat@leeelectric.example', null, null], ['web', 'https://leeelectric.example', '_blank', 'noopener']]), JSON.stringify(await links('c-pat')));
  check('links: the phone number and the website show as text', (await tc(page, `${card('c-pat')} [data-via="call"]`)) === '(201) 555-0100'
    && (await tc(page, `${card('c-acme')} [data-via="web"]`)) === 'acme.example/account');
  check('links: a short number (911) gets Call only', same(await links('c-911'), [['call', 'tel:911', null, null]]), JSON.stringify(await links('c-911')));
  // Nobody texts or WhatsApps the cable company's phone line or poison control.
  const vias = async (id) => (await links(id)).map((l) => l[0]);
  check('links: accounts and emergency numbers get Call, not Text or WhatsApp', same(await vias('c-acme'), ['call', 'email', 'web']) && same(await vias('c-water'), ['call'])
    && same(await vias('c-poison'), ['call']) && same(await vias('c-pat'), ['call', 'sms', 'whatsapp', 'email', 'web']), JSON.stringify([await vias('c-acme'), await vias('c-poison')]));
  check('links: the address opens a map', same((await links('c-vet')).find((l) => l[0] === 'map'),
    ['map', 'https://www.google.com/maps/search/?api=1&query=12%20Example%20Street%2C%20Springfield', '_blank', 'noopener']) && (await tc(page, `${card('c-vet')} [data-via="map"]`)) === '12 Example Street, Springfield');
  check('contract: ends within 30 days of the household\'s today → "Ends in 16 days"', (await tc(page, `${card('c-acme')} .dir-end`)) === 'Contract ends Nov 10 Ends in 16 days'
    && (await page.$eval(`${card('c-acme')} .dir-end .badge`, (b) => b.className)) === 'badge dir-near', await tc(page, `${card('c-acme')} .dir-end`));
  check('contract: a past end says Ended; a far one has no badge and shows its year', (await tc(page, `${card('c-gas')} .dir-end`)) === 'Contract ended Oct 20 Ended'
    && (await tc(page, `${card('c-water')} .dir-end`)) === 'Contract ends Mar 3, 2027' && (await page.$$(`${card('c-water')} .dir-end .badge`)).length === 0, await tc(page, `${card('c-water')} .dir-end`));
  check('card: notes, and the projects it is linked on (as v1)', (await tc(page, `${card('c-vet')} .dir-notes`)) === 'Ask for Dr. Morgan.'
    && (await tc(page, `${card('c-pat')} .dir-used`)) === 'On: Kitchen Renovation (Electrician)'
    && (await page.getAttribute(`${card('c-pat')} .dir-used a`, 'href')) === '#/projects/p-kitchen', await tc(page, `${card('c-pat')} .dir-used`));
  const xss = await page.evaluate((sel) => ({ img: document.querySelectorAll('#main img').length, flag: window.__xss, name: document.querySelector(`${sel} h3`).textContent,
    notes: document.querySelector(`${sel} .dir-notes`).textContent, web: document.querySelector(`${sel} [data-via="web"]`).getAttribute('href') }), card('c-xss'));
  check('escaping: names and notes are text, never HTML; a javascript: website becomes a plain https link', xss.img === 0 && xss.flag === undefined && xss.name === XSS_NAME
    && xss.notes === '<script>window.__xss=2</script>' && xss.web === 'https://javascript:alert(1)', JSON.stringify(xss));

  // Account numbers (admin): loaded on their own, masked until Show.
  check('account: loaded once, on their own, by an admin', same(db.secretCalls.map((c) => [c.method, c.url, c.email]),
    [['GET', '/rest/v1/contractor_secrets?select=contractor_id,account_number,account_name,secret_notes', 'alex@example.com']]), JSON.stringify(db.secretCalls.map((c) => c.url)));
  check('account: masked to the last 4 (•••• 7890), with Show', (await tc(page, `${card('c-acme')} .dir-account`)) === 'Account •••• 7890 Show'
    && (await tc(page, `${card('c-water')} .dir-acct-num`)) === '•••• 8877', await tc(page, `${card('c-acme')} .dir-account`));
  check('account: the full number isn\'t in the page until Show', !(await page.content()).includes('3456') && !(await page.content()).includes('Customer since'));
  check('account: Show says what it shows (for a screen reader)', (await page.getAttribute(`${card('c-acme')} [data-show]`, 'aria-label')) === 'Show the Acme Internet account number'
    && !(await page.$(`${card('c-acme')} [data-copy-acct]`)));
  check('account: entries without account details have no account line', (await page.$$('.dir-account')).length === 2);
  await page.click(`${card('c-acme')} [data-show]`);
  check('account: Show reveals the number, the name on it and the private notes', (await tc(page, `${card('c-acme')} .dir-acct-num`)) === '0012 3456 7890'
    && (await text(page, `${card('c-acme')} .dir-acct-more`)) === 'Name on the account: Alex Example\nCustomer since 2019.'
    && (await page.getAttribute(`${card('c-acme')} [data-show]`, 'aria-expanded')) === 'true' && (await tc(page, `${card('c-acme')} [data-show]`)) === 'Hide');
  check('account: Hide says what it hides', (await page.getAttribute(`${card('c-acme')} [data-show]`, 'aria-label')) === 'Hide the Acme Internet account number');
  await page.click(`${card('c-acme')} [data-copy-acct]`);
  await page.waitForTimeout(200);
  check('account: Copy puts the number on the clipboard (for a parent on hold) and says so', (await page.evaluate(() => navigator.clipboard.readText())) === '0012 3456 7890'
    && (await tc(page, `${card('c-acme')} [data-copy-acct]`)) === 'Copy' && (await page.getAttribute(`${card('c-acme')} [data-copy-acct]`, 'aria-label')) === 'Copy the Acme Internet account number'
    && (await texts(page, '.toasts .toast')).includes('Account number copied'), JSON.stringify(await texts(page, '.toasts .toast')));
  await page.fill('.dir-searchbar input', 'acme');
  await page.waitForTimeout(150);
  check('account: stays shown while searching', (await tc(page, `${card('c-acme')} .dir-acct-num`)) === '0012 3456 7890');
  await page.click(`${card('c-acme')} [data-show]`);
  check('account: Hide masks it again', (await tc(page, `${card('c-acme')} .dir-acct-num`)) === '•••• 7890' && !(await page.content()).includes('Customer since'));

  // Search and the kind filter
  check('search: by name', same(await cardIds(page), ['c-acme']) && (await tc(page, '[data-ref="status"]')) === '1 entry matches');
  await page.fill('.dir-searchbar input', '555-0199');
  await page.waitForTimeout(150);
  check('search: by phone number, however it is typed', same(await cardIds(page), ['c-poison']), (await cardIds(page)).join(','));
  await page.fill('.dir-searchbar input', 'morgan');
  await page.waitForTimeout(150);
  check('search: by notes', same(await cardIds(page), ['c-vet']), (await cardIds(page)).join(','));
  await page.fill('.dir-searchbar input', 'zzz');
  await page.waitForTimeout(150);
  check('search: nothing matches → says so', (await tc(page, '.dir-none')) === 'Nothing matches “zzz”.' && (await cardIds(page)).length === 0);
  await page.fill('.dir-searchbar input', '');
  await page.click('.dir-chip[data-kind="account"]');
  await page.waitForTimeout(150);
  check('kinds: Accounts & utilities shows only accounts, without section headings', same(await cardIds(page), ['c-acme', 'c-water', 'c-gas'])
    && (await page.$$('.dir-sec')).length === 0 && (await page.getAttribute('.dir-chip[data-kind="account"]', 'aria-pressed')) === 'true', (await cardIds(page)).join(','));
  await page.fill('.dir-searchbar input', 'vet');
  await page.waitForTimeout(150);
  check('kinds: a search inside a kind says which kind had nothing', (await tc(page, '.dir-none')) === 'Nothing matches “vet” in Accounts & utilities.');
  await page.fill('.dir-searchbar input', '');
  await page.reload();
  await page.waitForTimeout(800);
  check('kinds: the choice is remembered on this device', same(await cardIds(page), ['c-acme', 'c-water', 'c-gas']) && (await page.getAttribute('.dir-chip[data-kind="account"]', 'aria-pressed')) === 'true');
  await page.click('.dir-chip[data-kind="all"]');
  await page.screenshot({ path: SHOTS + 'directory-desktop.png', fullPage: true });

  // =====================================================================
  // 2. The form (admin): add with account details, edit, Show, clear, validation
  // =====================================================================
  await page.click('.dir-add');
  await page.waitForTimeout(300);
  const datalist = () => page.$$eval('#dirCategories option', (os) => os.map((o) => o.value));
  const contractorList = await datalist();
  check('form: Add opens "Add to the directory", kind Contractor, trade suggestions', (await tc(page, '#formDialog h3')) === 'Add to the directory'
    && (await page.inputValue('#formDialog [name="kind"]')) === 'contractor' && ['Plumber', 'Electrician', 'HVAC'].every((x) => contractorList.includes(x)), contractorList.join(','));
  await page.selectOption('#formDialog [name="kind"]', 'account');
  const accountList = await datalist();
  await page.selectOption('#formDialog [name="kind"]', 'service');
  const serviceList = await datalist();
  check('form: category suggestions follow the kind (accounts: Internet … Mortgage; services: Vet, Groomer, School, Doctor)',
    ['Internet', 'Cable/TV', 'Electric', 'Gas', 'Water', 'Trash', 'Insurance', 'Mortgage'].every((s) => accountList.includes(s)) && !accountList.includes('Vet')
    && ['Vet', 'Groomer', 'School', 'Doctor'].every((s) => serviceList.includes(s)), `${accountList.join(',')} | ${serviceList.join(',')}`);
  check('form: an admin gets the Account section; with no number saved its field is open', (await page.$$('#formDialog .dir-acct-fs')).length === 1
    && await page.isVisible('#formDialog [name="account_number"]') && (await page.$$('#formDialog [data-act="reveal"]')).length === 0);
  const before = db.writes.length;
  await submit(page);
  check('form: a name is required (nothing is sent)', (await formError(page)) === 'Give the entry a name.' && db.writes.length === before && await formOpen(page));
  await page.selectOption('#formDialog [name="kind"]', 'account');
  await page.fill('#formDialog [name="name"]', 'Example Electric');
  await page.fill('#formDialog [name="email"]', 'billing at example');
  await submit(page);
  check('form: a bad email is caught first', (await formError(page)) === 'Check the email address, or leave it empty.' && db.writes.length === before);
  const fill = { category: 'Electric', phone: '(201) 555-0108', email: 'billing@electric.example', website: 'electric.example/login', address: '1 Power Way, Springfield', contract_end: '2026-12-01', notes: 'Budget billing.', account_number: '5555 4444 3333', account_name: 'Sam Example', secret_notes: 'Autopay on.' };
  for (const [k, v] of Object.entries(fill)) await page.fill(`#formDialog [name="${k}"]`, v);
  await submit(page);
  const added = db.contractors.find((c) => c.name === 'Example Electric');
  const post = writes(db, 'POST', '/rest/v1/contractors')[0];
  check('add: one contractors row with kind, category (and trade, for Projects) and every field', !!added && same(post && post.body, {
    kind: 'account', name: 'Example Electric', company: null, category: 'Electric', trade: 'Electric', phone: '(201) 555-0108', email: 'billing@electric.example',
    website: 'electric.example/login', address: '1 Power Way, Springfield', contract_end: '2026-12-01', notes: 'Budget billing.' }), JSON.stringify(post && post.body));
  const up = db.secretCalls.filter((c) => c.method === 'POST');
  check('add: the account details are upserted into contractor_secrets for the new id', up.length === 1 && /on_conflict=contractor_id/.test(up[0].url)
    && /resolution=merge-duplicates/.test(up[0].prefer) && added && same(up[0].body, { contractor_id: added.id, account_number: '5555 4444 3333', account_name: 'Sam Example', secret_notes: 'Autopay on.' }), JSON.stringify(up.map((c) => [c.url, c.body])));
  check('add: the form closes with "Added Example Electric"', !(await formOpen(page)) && (await lastToast(page)) === 'Added Example Electric', await lastToast(page));
  check('add: the new card shows, its number masked', added && (await tc(page, `${card(added.id)} .dir-acct-num`)) === '•••• 3333' && (await tc(page, `${card(added.id)} .dir-end`)) === 'Contract ends Dec 1',
    added && await tc(page, `${card(added.id)}`));

  // Edit Acme: account details read fresh by id; masked until Show; change them.
  db.secretCalls = [];
  await editOf(page, 'c-acme');
  check('edit: the account details are read again, by this entry\'s id', same(db.secretCalls.map((c) => [c.method, c.url]),
    [['GET', '/rest/v1/contractor_secrets?select=contractor_id,account_number,account_name,secret_notes&contractor_id=eq.c-acme']]), JSON.stringify(db.secretCalls.map((c) => c.url)));
  check('edit: the form is filled in; the saved number is masked, its field hidden', (await tc(page, '#formDialog h3')) === 'Edit Acme Internet'
    && (await page.inputValue('#formDialog [name="kind"]')) === 'account' && (await page.inputValue('#formDialog [name="contract_end"]')) === '2026-11-10'
    && (await tc(page, '#formDialog .dir-mask')) === '•••• 7890' && !(await page.isVisible('#formDialog [name="account_number"]'))
    && (await page.inputValue('#formDialog [name="account_name"]')) === 'Alex Example');
  await page.click('#formDialog [data-act="reveal"]');
  check('edit: Show opens the number to change it', await page.isVisible('#formDialog [name="account_number"]') && (await page.inputValue('#formDialog [name="account_number"]')) === '0012 3456 7890'
    && (await tc(page, '#formDialog [data-act="reveal"]')) === 'Hide');
  await page.fill('#formDialog [name="account_number"]', '0012 3456 9999');
  await page.click('#formDialog [data-act="reveal"]');
  check('edit: Hide masks what was typed', (await tc(page, '#formDialog .dir-mask')) === '•••• 9999');
  await page.fill('#formDialog [name="name"]', 'Acme Fiber');
  await submit(page);
  const patch = writes(db, 'PATCH', '/rest/v1/contractors?id=eq.c-acme').slice(-1)[0];
  check('edit: saves the entry, then the account details (merged, one row)', patch && patch.body.name === 'Acme Fiber' && patch.body.kind === 'account'
    && db.contractor_secrets.filter((s) => s.contractor_id === 'c-acme').length === 1 && db.contractor_secrets.find((s) => s.contractor_id === 'c-acme').account_number === '0012 3456 9999'
    && (await lastToast(page)) === 'Saved Acme Fiber' && (await tc(page, `${card('c-acme')} .dir-acct-num`)) === '•••• 9999', JSON.stringify(patch && patch.body));

  // Edit Pat (a v1 row, no account details): nothing is written to contractor_secrets.
  db.secretCalls = [];
  await editOf(page, 'c-pat');
  check('edit (v1 row): kind Contractor, category from the trade', (await page.inputValue('#formDialog [name="kind"]')) === 'contractor'
    && (await page.inputValue('#formDialog [name="category"]')) === 'Electrician' && (await page.inputValue('#formDialog [name="email"]')) === 'pat@leeelectric.example');
  await submit(page);
  const patPatch = writes(db, 'PATCH', '/rest/v1/contractors?id=eq.c-pat').slice(-1)[0];
  check('edit (v1 row): saved with kind and category; no account write when there are none', patPatch && patPatch.body.kind === 'contractor' && patPatch.body.category === 'Electrician'
    && patPatch.body.trade === 'Electrician' && db.secretCalls.filter((c) => c.method !== 'GET').length === 0, JSON.stringify(db.secretCalls.map((c) => c.method)));

  // Clear City Water's account number: its contractor_secrets row goes.
  await editOf(page, 'c-water');
  await page.click('#formDialog [data-act="reveal"]');
  await page.fill('#formDialog [name="account_number"]', '');
  await submit(page);
  check('edit: clearing every account field deletes the row', !db.contractor_secrets.some((s) => s.contractor_id === 'c-water')
    && db.secretCalls.some((c) => c.method === 'DELETE' && c.url === '/rest/v1/contractor_secrets?contractor_id=eq.c-water')
    && (await page.$$(`${card('c-water')} .dir-account`)).length === 0);

  // Save fails: the form stays open with the error.
  db.saveFail = true;
  await editOf(page, 'c-gas');
  await page.fill('#formDialog [name="notes"]', 'Meter in the side yard.');
  await submit(page);
  check('save fails: the error shows and the form stays open', (await formError(page)) === 'Database restarting' && await formOpen(page));
  db.saveFail = false;
  await page.click('#formDialog [data-close]');

  // Account save fails after a new entry is added: the entry is kept, the form switches to editing it.
  db.secretsSaveFail = true;
  await page.click('.dir-add');
  await page.waitForTimeout(300);
  await page.selectOption('#formDialog [name="kind"]', 'account');
  await page.fill('#formDialog [name="name"]', 'Example Trash Pickup');
  await page.fill('#formDialog [name="account_number"]', '24681357');
  await submit(page);
  check('account save fails: says the entry was added but the details weren\'t; the form now edits it',
    (await formError(page)) === 'Added Example Trash Pickup, but the account details weren\'t saved: Database restarting Try Save again.'
    && (await tc(page, '#formDialog h3')) === 'Edit Example Trash Pickup' && (await tc(page, '#formDialog [type="submit"]')) === 'Save', await formError(page));
  db.secretsSaveFail = false;
  await submit(page);
  const trash = db.contractors.filter((c) => c.name === 'Example Trash Pickup');
  check('account save fails: Save again updates the same entry (no second one) and saves the details', trash.length === 1
    && db.contractor_secrets.some((s) => s.contractor_id === trash[0].id && s.account_number === '24681357') && !(await formOpen(page))
    && (await lastToast(page)) === 'Saved Example Trash Pickup', `${trash.length} ${await lastToast(page)}`);

  // An admin can delete an entry with account details.
  await editOf(page, 'c-acme');
  await page.click('#formDialog [data-act="delete"]');
  await page.waitForTimeout(500);
  check('delete (admin): an entry with account details goes, with its details', !db.contractors.some((c) => c.id === 'c-acme') && !db.contractor_secrets.some((s) => s.contractor_id === 'c-acme')
    && db.confirms.slice(-1)[0] === 'Delete Acme Fiber?' && (await lastToast(page)) === 'Deleted Acme Fiber' && (await page.$$(card('c-acme'))).length === 0, db.confirms.slice(-1)[0]);

  // Secrets can't be read: the cards still show, with a note.
  db.secretsFail = true;
  await page.reload();
  await page.waitForTimeout(800);
  check('account load fails: the page still shows, with a note and no account lines', (await page.$$('.dir-card')).length === 10 && (await page.$$('.dir-account')).length === 0
    && (await tc(page, '.dir-note')) === 'Couldn\'t load the account numbers just now. Reload the page to try again.');
  await editOf(page, 'c-water');
  check('account load fails: the form says the details are left as they are', (await page.$$('#formDialog [name="account_number"]')).length === 0
    && /Couldn't load the account details just now, so saving leaves them as they are/.test(await tc(page, '#formDialog .dir-fs')));
  const sc = db.secretCalls.length;
  await submit(page);
  check('account load fails: saving the entry doesn\'t write to contractor_secrets', db.secretCalls.slice(sc).every((c) => c.method === 'GET') && (await lastToast(page)) === 'Saved City Water',
    JSON.stringify(db.secretCalls.slice(sc).map((c) => c.method)));
  db.secretsFail = false;
  await page.context().close();

  // =====================================================================
  // 3. Sam (a member, not an admin): no account details, ever; the admin-only rule
  // =====================================================================
  ({ page, db, log } = await open({ label: 'member', email: 'sam@example.com', allowConsole: /status of 403/ }));
  check('member: no account lines, and no admins-only note', (await page.$$('.dir-account')).length === 0
    && (await tc(page, '[data-ref="meta"]')) === '9 entries · visible to the family only');
  await editOf(page, 'c-water');
  check('member: the form has no Account section', (await page.$$('#formDialog .dir-fs, #formDialog [name="account_number"]')).length === 0 && await formOpen(page));
  await page.fill('#formDialog [name="notes"]', 'Changed by Sam');
  await submit(page);
  check('member: changing an entry with account details → a friendly "admin only" message, nothing changed',
    (await formError(page)) === 'Only an admin can change City Water, because it has account details saved. Ask an admin to change it.'
    && !db.contractors.find((c) => c.id === 'c-water').notes && await formOpen(page), await formError(page));
  await page.click('#formDialog [data-act="delete"]');
  await page.waitForTimeout(500);
  check('member: deleting an entry with account details → a friendly "admin only" message, still there',
    (await formError(page)) === 'Only an admin can delete City Water, because it has account details saved. Ask an admin to delete it.'
    && db.contractors.some((c) => c.id === 'c-water') && writes(db, 'DELETE', '/rest/v1/contractors?id=eq.c-water').length === 1, await formError(page));
  await page.click('#formDialog [data-close]');

  // Deleting Pat (linked on the kitchen project): asked first; cancelling changes nothing.
  db.confirm = false;
  await editOf(page, 'c-pat');
  await page.click('#formDialog [data-act="delete"]');
  await page.waitForTimeout(400);
  check('delete: asks first, naming the linked project; Cancel changes nothing', db.confirms.slice(-1)[0] === 'Delete Pat Lee?\n\nIt\'s linked on 1 project (Kitchen Renovation); they\'ll keep the name but lose the link.'
    && db.contractors.some((c) => c.id === 'c-pat') && writes(db, 'DELETE', '/rest/v1/contractors').length === 1 && await formOpen(page), db.confirms.slice(-1)[0]);
  db.confirm = true;
  await page.click('#formDialog [data-act="delete"]');
  await page.waitForTimeout(600);
  const kitchen = db.projects.find((p) => p.id === 'p-kitchen');
  const projPatch = writes(db, 'PATCH', '/rest/v1/projects').slice(-1)[0];
  check('delete: the entry goes; the project keeps the name as text, without the link', !db.contractors.some((c) => c.id === 'c-pat')
    && kitchen.schedule.trades.electrician.who === 'Pat Lee, Lee Electric' && !('contractor_id' in kitchen.schedule.trades.electrician), JSON.stringify(kitchen.schedule.trades.electrician));
  check('delete: the project is saved through api.updateProject (only if unchanged, with fresh task dates)', !!projPatch && /id=eq\.p-kitchen/.test(projPatch.url) && /updated_at=eq\./.test(projPatch.url)
    && Array.isArray(projPatch.body.task_dates) && projPatch.body.task_dates.length > 0 && typeof projPatch.body.task_dates_at === 'string', projPatch && projPatch.url);
  check('delete: "Deleted Pat Lee", the form closes and the card goes', (await lastToast(page)) === 'Deleted Pat Lee' && !(await formOpen(page)) && (await page.$$(card('c-pat'))).length === 0);

  // Someone else deleted Maria while the form was open.
  await editOf(page, 'c-maria');
  db.contractors = db.contractors.filter((c) => c.id !== 'c-maria');
  await submit(page);
  check('gone: saving an entry deleted elsewhere says so', (await formError(page)) === 'Maria Gomez was deleted a moment ago. Reload the page to see the latest.', await formError(page));
  await page.click('#formDialog [data-close]');
  check('member: never asked for contractor_secrets', db.secretCalls.length === 0 && !log.some((l) => /contractor_secrets/.test(l)), JSON.stringify(db.secretCalls.map((c) => c.url)));

  // =====================================================================
  // 4. Addresses: #/contractors (v1 links), #/directory/<id>; use('directory').contractorForm
  // =====================================================================
  await go(page, '#/contractors');
  check('#/contractors opens the Directory (its tab current)', (await text(page, '.dir-head h1')) === 'Directory'
    && (await page.getAttribute('.tabs a[data-tab="directory"]', 'aria-current')) === 'page');
  await page.evaluate(() => localStorage.setItem('homehub.directory.kind', 'account'));
  await go(page, '#/directory/c-poison');
  const target = await page.evaluate(() => ({ cls: document.querySelector('.dir-card[data-id="c-poison"]').className,
    focus: document.activeElement && document.activeElement.closest('.dir-card') && document.activeElement.closest('.dir-card').dataset.id }));
  check('#/directory/<id>: shows that entry (even under another kind filter), highlighted and focused', /is-target/.test(target.cls) && target.focus === 'c-poison'
    && (await page.getAttribute('.dir-chip[data-kind="all"]', 'aria-pressed')) === 'true', JSON.stringify(target));
  check('#/directory/<id>: the remembered filter is left alone', (await page.evaluate(() => localStorage.getItem('homehub.directory.kind'))) === 'account');
  await go(page, '#/directory/c-nobody');
  check('#/directory/<id> for an entry that\'s gone says so', (await tc(page, '[data-ref="banner"]')) === 'That entry isn\'t in the directory any more.');

  const provided = await page.evaluate(() => typeof HomeHub.core.use('directory').contractorForm);
  check('provides: use(\'directory\').contractorForm (v1\'s signature: entry, after)', provided === 'function');
  await page.evaluate(() => { HomeHub.core.use('directory').contractorForm({ kind: 'emergency' }, () => { window.__after = (window.__after || 0) + 1; }); });
  await page.waitForTimeout(300);
  check('contractorForm(defaults): a new entry of that kind', (await tc(page, '#formDialog h3')) === 'Add to the directory' && (await page.inputValue('#formDialog [name="kind"]')) === 'emergency');
  await page.fill('#formDialog [name="name"]', 'Example Power Outages');
  await page.fill('#formDialog [name="phone"]', '(201) 555-0150');
  await submit(page);
  check('contractorForm: saving calls after()', (await page.evaluate(() => window.__after)) === 1 && db.contractors.some((c) => c.name === 'Example Power Outages' && c.kind === 'emergency'));
  const reads = log.length;
  await page.evaluate(() => { HomeHub.core.use('directory').contractorForm({ id: 'c-vet', name: 'Happy Paws Vet', phone: '(201) 555-0103' }); });
  await page.waitForTimeout(400);
  check('contractorForm(partial row): reads the whole entry first, so nothing is lost', log.slice(reads).some((l) => l === 'GET /rest/v1/contractors?select=*&id=eq.c-vet')
    && (await page.inputValue('#formDialog [name="address"]')) === '12 Example Street, Springfield' && (await page.inputValue('#formDialog [name="email"]')) === 'desk@happypaws.example', log.slice(reads).join(' | '));
  await page.click('#formDialog [data-close]');
  check('member: still never asked for contractor_secrets', db.secretCalls.length === 0);
  await page.context().close();

  // =====================================================================
  // 5. Phones (390px): no sideways scroll, 44px targets; light and dark
  // =====================================================================
  for (const scheme of ['light', 'dark']) {
    ({ page, db } = await open({ label: `phone-${scheme}`, ctx: Object.assign({ colorScheme: scheme }, phone) }));
    await page.click(`${card('c-acme')} [data-show]`);
    check(`phone (${scheme}): no sideways scroll`, await noSideScroll(page));
    const sizes = await page.$$eval('.dir-chip, .dir-link, .dir-btn, .dir-use a, .dir-add', (es) => es.filter((e) => e.offsetParent).map((e) => {
      const r = e.getBoundingClientRect(); return [e.className, e.textContent.trim().slice(0, 20), Math.round(r.width), Math.round(r.height)];
    }));
    check(`phone (${scheme}): every chip, link and button is at least 44px`, sizes.length > 30 && sizes.every(([, , w, h]) => w >= 44 && h >= 44), JSON.stringify(sizes.filter(([, , w, h]) => w < 44 || h < 44)));
    const cardsFit = await page.$$eval('.dir-card', (cs) => cs.every((c) => c.getBoundingClientRect().right <= window.innerWidth));
    check(`phone (${scheme}): cards fit the screen`, cardsFit);
    if (scheme === 'light') {
      const kinds = await page.$eval('.dir-kinds', (k) => ({ wrap: getComputedStyle(k).flexWrap, overflow: getComputedStyle(k).overflowX }));
      check('phone: the kind chips are one row that scrolls inside itself', kinds.wrap === 'nowrap' && kinds.overflow === 'auto', JSON.stringify(kinds));
    }
    const colors = await page.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(document.querySelector('.dir-card')).backgroundColor,
      chip: getComputedStyle(document.querySelector('.dir-chip[aria-pressed="false"]')).backgroundColor }));
    const want = scheme === 'dark' ? { body: 'rgb(18, 17, 16)', card: 'rgb(27, 25, 23)', chip: 'rgb(27, 25, 23)' } : { body: 'rgb(246, 244, 240)', card: 'rgb(255, 255, 255)', chip: 'rgb(255, 255, 255)' };
    check(`phone (${scheme}): page, cards and chips use the theme's colours`, same(colors, want), JSON.stringify(colors));
    await page.screenshot({ path: SHOTS + `directory-phone-${scheme}.png`, fullPage: true });
    await editOf(page, 'c-acme');
    const form = await page.evaluate(() => {
      const d = document.getElementById('formDialog');
      const small = [...d.querySelectorAll('input:not([type="hidden"]), select, button')].filter((e) => e.offsetParent)
        .map((e) => [e.name || e.className || e.textContent.trim(), Math.round(e.getBoundingClientRect().height), Math.round(e.getBoundingClientRect().width)]).filter(([, h, w]) => h < 44 || w < 44);
      return { fits: d.scrollWidth <= d.clientWidth && d.getBoundingClientRect().right <= window.innerWidth, small };
    });
    check(`phone (${scheme}): the form fits the screen; its fields and buttons are 44px`, form.fits && form.small.length === 0, JSON.stringify(form));
    await page.screenshot({ path: SHOTS + `directory-form-phone-${scheme}.png` });
    await page.context().close();
  }

  // An empty directory: says what it's for, with an Add button.
  const emptyDb = dirDb();
  emptyDb.contractors = [];
  emptyDb.contractor_secrets = [];
  ({ page, db } = await open({ label: 'empty', db: emptyDb }));
  check('empty: explains, offers Add; no filter or search yet', /Keep the plumber, the internet company/.test(await tc(page, '.dir-empty')) && !(await page.isVisible('.dir-kinds'))
    && !(await page.isVisible('.dir-searchbar')) && (await tc(page, '[data-ref="meta"]')) === '0 entries · visible to the family only; account numbers to admins only');
  await page.click('.dir-empty [data-act="new"]');
  await page.waitForTimeout(300);
  check('empty: its button opens the form', await formOpen(page));
  await page.context().close();

  // =====================================================================
  // 6. v1 mode: the Directory isn't there; Contractors is, unchanged
  // =====================================================================
  ({ page } = await open({ label: 'v1', v1: true, path: '/#/contractors' }));
  const v1tabs = await page.$$eval('.tabs a', (as) => as.map((a) => a.textContent));
  check('v1: no Directory tab; #/contractors is still the v1 Contractors page', same(v1tabs, ['Home', 'Projects', 'Contractors', 'Family']) && (await text(page, 'h1')) === 'Contractors', v1tabs.join(','));
  await page.context().close();

  await browser.close();
  await server.close();
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
