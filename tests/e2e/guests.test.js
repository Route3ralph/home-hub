// Browser tests for project guests (v1.4, schema 11, docs/v1.4-project-guests.md): a designer who signs in with a code
// and is not on the family list sees only the projects a parent gave them (assets/hub.js signInGuest and the guest
// shell; assets/modules/projects.js's guest page: Contractors, the guest's settings and share dialog), and the family's
// side: Guest access on a project (the parents), the Documents link, and that an adult, a stranger and a schema-10
// database see none of it. The real index.html and page modules are loaded; the fakes are mock.js's (withGuests and
// guestRpc, with the migration's rules). Riley Designer (riley@example.com) is the made-up designer.
// Run alone with: node tests/e2e/guests.test.js
const { chromium } = require('playwright');
const { makeDb, install, signIn, withGuests } = require('./mock');
const { serve } = require('./server');

const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const T = '2026-10-24T16:00:00.000000+00:00';
const RILEY = 'riley@example.com';
const DRIVE = 'https://drive.google.com/drive/folders/kitchen-example';

function guestDb(o = {}) {
  const db = withGuests(makeDb());
  db.people = [
    { id: 'pe-alex', name: 'Alex Example', role: 'parent', email: 'alex@example.com', color: '#2563eb', language: 'en', sort_order: 1, active: true, created_at: T, updated_at: T },
    { id: 'pe-sam', name: 'Sam Example', role: 'adult', email: 'sam@example.com', color: '#db2777', language: 'en', sort_order: 2, active: true, created_at: T, updated_at: T },
  ];
  db.household = [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: null, updated_at: T, updated_by: null }];
  db.clock = { local_date: '2026-10-25', local_time: '07:45:00', tz: 'America/New_York' };
  db.tasks = [];
  db.events = [];
  db.projects.forEach((p) => Object.assign(p, { task_dates: [], task_dates_at: T, on_calendar: true, owner_id: 'pe-alex' }));
  db.contractors.forEach((c) => { c.kind = 'contractor'; });
  // A utility on the directory with an account number, linked to the Kitchen's plumber: the guest sees its name and
  // phone, never its account details, and can't edit it.
  db.contractors.push({ id: 'c-water', name: 'City Water', company: null, trade: null, phone: '(201) 555-0160', email: null, website: null, notes: 'Meter in the side yard', kind: 'account', created_at: T, updated_at: T });
  db.contractor_secrets = [{ contractor_id: 'c-water', account_number: '0000-1111-2222', account_name: 'Alex Example', secret_notes: null }];
  db.projects.find((p) => p.id === 'p-kitchen').schedule.trades.plumber = { name: 'Plumber', who: '', color: '#0891b2', contractor_id: 'c-water' };
  db.guests.push({ email: RILEY, name: 'Riley Designer', created_at: T, created_by: 'alex@example.com' });
  db.project_guests.push({ project_id: 'p-kitchen', guest_email: RILEY, added_at: T, added_by: 'alex@example.com' });
  if (o.both) db.project_guests.push({ project_id: 'p-pool', guest_email: RILEY, added_at: T, added_by: 'alex@example.com' });
  if (o.none) db.project_guests = [];
  return db;
}

const rpcFor = (version) => ({ hub_schema_version: () => version, clock: (db) => Object.assign({}, db.clock), mark_signed_in: () => null });

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

  async function open(o = {}) {
    const db = o.db || guestDb();
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 } }, o.ctx));
    await signIn(context, o.email || RILEY);
    const page = await context.newPage();
    const expect = { failures: false };
    page.on('pageerror', (e) => errors.push(`${o.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (expect.failures && /status of (400|403)/.test(m.text())) return;
      errors.push(`${o.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => d.accept());
    await install(page, db, log, { rpc: rpcFor(o.version || 11), emailSending: true });
    await page.goto(BASE + (o.path || '/'));
    await page.waitForTimeout(o.wait || 1000);
    return { page, db, log, context, expect };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim()).catch(() => '');
  const texts = (page, sel) => page.$$eval(sel, (es) => es.filter((e) => e.offsetParent).map((e) => e.innerText.trim()));
  const visible = (page, sel) => page.$$eval(sel, (es) => es.some((e) => e.offsetParent !== null));
  const rpcNames = (db) => [...new Set((db.rpcCalls || []).map((c) => c.name))].sort();
  const tablesRead = (log) => [...new Set(log.filter((l) => /\/rest\/v1\/(?!rpc\/)/.test(l)).map((l) => l.split(' ')[1].split('?')[0].replace('/rest/v1/', '')))].sort();
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(700); };
  const formOpen = (page) => page.evaluate(() => document.getElementById('formDialog').open);
  const toastText = (page) => texts(page, '.toasts .toast').then((t) => t.join(' | '));
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  // ---------------------------------------------------------------------
  // 1. A guest with one project: straight to it, and nothing of the family's
  // ---------------------------------------------------------------------
  {
    const { page, db, log, context } = await open({ label: 'guest' });
    check('guest: lands on their one project', page.url().endsWith('#/projects/p-kitchen') && (await text(page, '#main h1')) === 'Kitchen Renovation', page.url());
    check('guest: the header has Projects only, their name and Sign out (no Add, no bottom bar)',
      same(await texts(page, '.topbar .tabs a'), ['Projects']) && (await text(page, '.topbar .guest-name')) === 'Riley Designer'
      && (await visible(page, '[data-shell="sign-out"]')) && !(await page.$('[data-shell="add"]')) && !(await page.$('.bottombar')),
      await texts(page, '.topbar a, .topbar button'));
    check('guest: whoami, then guest_whoami; never mark_signed_in, never a family function',
      log[0] === 'POST /rest/v1/rpc/whoami' && same(rpcNames(db), ['clock', 'guest_contacts', 'guest_whoami', 'hub_schema_version']), [log[0], rpcNames(db)]);
    check('guest: reads only the projects table (not people, household, contractors, tasks or anything else)', same(tablesRead(log), ['projects']), tablesRead(log));
    check('guest: guest_contacts for this project', (db.rpcCalls || []).filter((c) => c.name === 'guest_contacts').every((c) => c.body.p_project === 'p-kitchen'));
    check('guest: no Tasks card, no owner, no back link (one project), no Guest access',
      !(await page.$('.ptasks')) && !(await text(page, '.page-head .meta')).includes('Owner') && !(await page.$('#main a.back')) && !(await page.$('[data-act="guests"]')),
      await text(page, '.page-head'));
    check('guest: the actions are Trades & contractors, Contractors, Share, Settings, + Schedule task (no Documents until a link is set)',
      same(await texts(page, '.page-head .page-actions .btn'), ['Trades & contractors', 'Contractors', 'Share', 'Settings', '+ Schedule task']),
      await texts(page, '.page-head .page-actions .btn'));
    check('guest: the schedule shows the linked contractors\' names', /Pat Lee/.test(await text(page, '#gv')) && /City Water/.test(await text(page, '#gv')));
    await page.screenshot({ path: SHOTS + 'guest-project.png' });

    // Contractors: the two on the project; City Water (account details saved) can't be edited.
    await page.click('[data-act="contacts"]');
    await page.waitForTimeout(300);
    check('Contractors: the ones on this project, with phones; only the one without account details can be edited',
      same(await texts(page, '#formDialog .contact-list li strong'), ['City Water', 'Pat Lee'])
      && (await page.$$('#formDialog [data-contact-edit]')).length === 1 && !!(await page.$('#formDialog [data-contact-edit="c-pat"]'))
      && !/0000-1111|Meter in the side yard/.test(await text(page, '#formDialog')),
      await text(page, '#formDialog'));
    await page.click('#formDialog [data-contact-new]');
    await page.waitForTimeout(200);
    await page.fill('#formDialog [name="name"]', 'Quinn Tile');
    await page.fill('#formDialog [name="trade"]', 'Tile');
    await page.fill('#formDialog [name="phone"]', '(201) 555-0170');
    await page.fill('#formDialog [name="email"]', 'Quinn@Example.com');
    await page.click('#formDialog button[type="submit"]');
    await page.waitForTimeout(700);
    const quinn = db.contractors.find((c) => c.name === 'Quinn Tile');
    check('+ New contractor: guest_save_contact(this project, the details); a directory entry, on this project',
      !!quinn && quinn.kind === 'contractor' && quinn.email === 'quinn@example.com' && db.project_contacts.some((x) => x.contractor_id === quinn.id && x.project_id === 'p-kitchen')
      && same(Object.keys(db.guestSaves[0].p_contact).sort(), ['company', 'email', 'name', 'phone', 'trade', 'website']), db.guestSaves);
    check('... the list again, with Quinn Tile, and a toast', same(await texts(page, '#formDialog .contact-list li strong'), ['City Water', 'Pat Lee', 'Quinn Tile'])
      && /Quinn Tile is on this project/.test(await toastText(page)), await toastText(page));
    await page.click('#formDialog [data-contact-edit="c-pat"]');
    await page.waitForTimeout(200);
    await page.fill('#formDialog [name="phone"]', '(201) 555-0111');
    await page.click('#formDialog button[type="submit"]');
    await page.waitForTimeout(700);
    check('Edit: the guest changes Pat Lee\'s phone', db.contractors.find((c) => c.id === 'c-pat').phone === '(201) 555-0111' && db.guestSaves[1].p_contact.id === 'c-pat');
    await page.click('#formDialog [data-close]');

    // Trades: a new trade linked to Quinn Tile; the options are the project's contractors only.
    await page.click('[data-act="trades"]');
    await page.waitForTimeout(300);
    const options = await page.$$eval('#formDialog .trade-row:first-child select[name="contractor"] option', (os) => os.map((x) => x.textContent.trim()));
    check('Trades: a guest picks from the contractors on the project only (not the directory)',
      options.some((x) => /Quinn Tile/.test(x)) && options.some((x) => /Pat Lee/.test(x)) && !options.some((x) => /Maria Gomez/.test(x))
      && /Add new ones, or fix their details, under Contractors/.test(await text(page, '#formDialog .meta')), options);
    await page.click('#formDialog [data-add]');
    const last = '#formDialog .trade-row:last-child';
    await page.fill(`${last} [name="name"]`, 'Tile setter');
    await page.selectOption(`${last} [name="contractor"]`, quinn.id);
    await page.click('#formDialog button[type="submit"]');
    await page.waitForTimeout(700);
    const trades = db.projects.find((p) => p.id === 'p-kitchen').schedule.trades;
    check('... saved: the new trade links Quinn Tile', Object.values(trades).some((t) => t.name === 'Tile setter' && t.contractor_id === quinn.id) && !(await formOpen(page)));

    // Settings: no owner, no calendar switch, no delete; the documents link, a Google Drive address only.
    await page.click('[data-act="settings"]');
    await page.waitForTimeout(300);
    const names = await page.$$eval('#formDialog [name]', (es) => es.map((e) => e.name).filter((n) => !/^phase_/.test(n)));
    check('Settings (guest): name, status, start, summary, documents folder, days off; no owner, calendar switch or Delete project',
      same(names, ['name', 'status', 'start', 'summary', 'documents_url', 'holidays']) && !/Delete project/.test(await text(page, '#formDialog')), names);
    await page.fill('#formDialog [name="documents_url"]', 'https://example.com/folder');
    await page.click('#formDialog button[type="submit"]');
    await page.waitForTimeout(400);
    check('... a link that isn\'t Google Drive: says so, nothing saved', /starts with https:\/\/drive\.google\.com\//.test(await text(page, '#formDialog .form-error'))
      && db.projects.find((p) => p.id === 'p-kitchen').documents_url === null, await text(page, '#formDialog .form-error'));
    await page.fill('#formDialog [name="documents_url"]', DRIVE);
    await page.fill('#formDialog [name="summary"]', 'Cabinets, counters and tile.');
    await page.click('#formDialog button[type="submit"]');
    await page.waitForTimeout(700);
    const k = db.projects.find((p) => p.id === 'p-kitchen');
    check('... a Drive folder: saved with the summary; owner and calendar switch untouched', k.documents_url === DRIVE && k.summary === 'Cabinets, counters and tile.' && k.owner_id === 'pe-alex' && k.on_calendar === true, k);
    const docs = await page.$('[data-ref="docs"]');
    check('... the Documents button opens the folder in a new tab', !!docs && (await docs.getAttribute('href')) === DRIVE && (await docs.getAttribute('target')) === '_blank'
      && /noopener/.test(await docs.getAttribute('rel')), docs && await docs.getAttribute('href'));

    // Share: off, so nothing to turn on; on, the link to copy, and no off or new link.
    await page.click('[data-act="share"]');
    await page.waitForTimeout(300);
    check('Share (guest, sharing off): asks the family; no Turn on sharing', /The share link is off/.test(await text(page, '#formDialog')) && !(await page.$('#formDialog [data-share="on"]')));
    await page.click('#formDialog [data-close]');
    k.sharing_enabled = true;
    await page.reload();
    await page.waitForTimeout(1000);
    await page.click('[data-act="share"]');
    await page.waitForTimeout(300);
    check('Share (guest, sharing on): the link and Copy; no Turn off, no new link',
      /share\.html\?p=kitchentoken/.test(await page.inputValue('#formDialog .sharebox input')) && !!(await page.$('#formDialog [data-share="copy"]'))
      && !(await page.$('#formDialog [data-share="off"]')) && !(await page.$('#formDialog [data-share="rotate"]')));
    await page.click('#formDialog [data-close]');

    // Messages: their own apps only (the hub's send-email answers a guest 403).
    await page.click('#gv [data-msg="electrician"]');
    await page.waitForTimeout(300);
    check('Message (guest): Text and WhatsApp, no "Send email now" (even with hub email on)',
      !!(await page.$('#formDialog [data-link="sms"]')) && !(await page.$('#formDialog [data-send]')), await text(page, '#formDialog .msg-actions'));
    await page.click('#formDialog [data-close]');

    // The family's pages aren't there: any other address shows their project.
    const before = log.length;
    await go(page, '#/tasks');
    await go(page, '#/settings');
    check('guest: #/tasks and #/settings show their project, and read nothing else',
      page.url().endsWith('#/projects/p-kitchen') && (await text(page, '#main h1')) === 'Kitchen Renovation'
      && !log.slice(before).some((l) => /\/rest\/v1\/(tasks|events|household|people|contractors|members)\b/.test(l)), log.slice(before));
    check('guest: still only the guest RPCs', same(rpcNames(db), ['clock', 'guest_contacts', 'guest_save_contact', 'guest_whoami', 'hub_schema_version']), rpcNames(db));
    await page.click('[data-shell="sign-out"]');
    await page.waitForTimeout(600);
    check('Sign out: back to the sign-in screen', !!(await page.$('#loginForm')));
    await context.close();
  }

  // 2. Two projects: the list (no New project); none: a plain note.
  {
    const { page, context } = await open({ label: 'guest 2', db: guestDb({ both: true }) });
    check('guest with two projects: the list of those two, no + New project',
      same((await texts(page, '.pcard h3')).sort(), ['Kitchen Renovation', 'Pool repairs']) && !(await page.$('[data-act="new-project"]'))
      && /2 projects shared with you/.test(await text(page, '.page-head')), await texts(page, '.pcard h3'));
    await page.click('.pcard >> text=Pool repairs');
    await page.waitForTimeout(800);
    check('... a project page has the back link', (await text(page, '#main h1')) === 'Pool repairs' && !!(await page.$('#main a.back')));
    await context.close();
  }
  {
    const { page, context } = await open({ label: 'guest 0', db: guestDb({ none: true }) });
    check('guest with no projects: says so', /No projects are shared with you right now/.test(await text(page, '#main')) && !(await page.$('.pcard')), await text(page, '#main'));
    await context.close();
  }

  // 3. On a phone: no side scroll, and Sign out in reach.
  {
    const { page, context } = await open({ label: 'guest phone', ctx: phone });
    check('guest on a phone: the project fits (no side scroll); their name and Sign out show', (await noSideScroll(page)) && (await visible(page, '[data-shell="sign-out"]')));
    const bar = await page.$eval('.topbar', (e) => Math.round(e.getBoundingClientRect().height));
    check('... the header is one row (the brand links to Projects, so the lone tab goes)', bar < 80 && !(await visible(page, '.topbar .tabs a')), bar);
    await page.screenshot({ path: SHOTS + 'guest-phone.png' });
    await context.close();
  }

  // ---------------------------------------------------------------------
  // 4. The family's side
  // ---------------------------------------------------------------------
  {
    const db = guestDb({ none: true });
    db.guests = [];
    db.projects.find((p) => p.id === 'p-kitchen').documents_url = DRIVE;
    const { page, context, expect } = await open({ label: 'admin', email: 'alex@example.com', db, path: '/#/projects/p-kitchen' });
    const acts = await texts(page, '.page-head .page-actions .btn');
    check('parent: Documents, Guest access, and the Tasks card', acts.includes('Documents') && acts.includes('Guest access') && !!(await page.$('.ptasks')), acts);
    await page.click('[data-act="settings"]');
    await page.waitForTimeout(300);
    const names = await page.$$eval('#formDialog [name]', (es) => es.map((e) => e.name).filter((n) => !/^phase_/.test(n)));
    check('parent: Settings has the documents folder, the owner and the calendar switch', same(names, ['name', 'status', 'start', 'summary', 'documents_url', 'owner_id', 'on_calendar', 'holidays']), names);
    await page.click('#formDialog [data-close]');

    await page.click('[data-act="guests"]');
    await page.waitForTimeout(500);
    check('Guest access: nobody yet', /Nobody outside the family sees this project/.test(await text(page, '#formDialog')));
    await page.fill('#formDialog [name="name"]', 'Riley Designer');
    await page.fill('#formDialog [name="email"]', 'Riley@Example.com');
    await page.click('#formDialog button[type="submit"]');
    await page.waitForTimeout(700);
    check('Give access: add_project_guest(project, email, name); Riley listed',
      db.project_guests.some((l) => l.project_id === 'p-kitchen' && l.guest_email === RILEY) && same(await texts(page, '#formDialog .contact-list strong'), ['Riley Designer'])
      && /Riley Designer can sign in and see Kitchen Renovation/.test(await toastText(page)), await text(page, '#formDialog'));
    expect.failures = true;
    await page.fill('#formDialog [name="name"]', 'Sam');
    await page.fill('#formDialog [name="email"]', 'sam@example.com');
    await page.click('#formDialog button[type="submit"]');
    await page.waitForTimeout(600);
    expect.failures = false;
    check('... a family member\'s address: the reason, and nothing added', /already signs in as family/.test(await text(page, '#formDialog .form-error')) && db.project_guests.length === 1,
      await text(page, '#formDialog .form-error'));
    await page.click('#formDialog [data-guest-remove="riley@example.com"]');
    await page.waitForTimeout(700);
    check('Remove: remove_project_guest; nobody again (Riley keeps a guest record, with no projects)',
      db.project_guests.length === 0 && db.guests.length === 1 && /Nobody outside the family/.test(await text(page, '#formDialog')), db.project_guests);
    await context.close();
  }
  {
    const db = guestDb();
    db.projects.find((p) => p.id === 'p-kitchen').documents_url = DRIVE;
    const { page, context } = await open({ label: 'adult', email: 'sam@example.com', path: '/#/projects/p-kitchen', db });
    check('adult: no Guest access (the parents only); the Documents button opens the folder', !(await page.$('[data-act="guests"]')) && (await text(page, '#main h1')) === 'Kitchen Renovation'
      && (await page.getAttribute('[data-ref="docs"]', 'href')) === DRIVE);
    await page.click('[data-act="settings"]');
    await page.waitForTimeout(300);
    const noField = !(await page.$('#formDialog [name="documents_url"]'));
    await page.fill('#formDialog [name="summary"]', 'Adult edit');
    await page.click('#formDialog button[type="submit"]');
    await page.waitForTimeout(600);
    const k = db.projects.find((p) => p.id === 'p-kitchen');
    check('adult: Settings has no documents folder (the parents and the guest change it), and saves the rest without touching it',
      noField && k.summary === 'Adult edit' && k.documents_url === DRIVE, k);
    await context.close();
  }
  {
    const { page, context } = await open({ label: 'admin v10', email: 'alex@example.com', version: 10, path: '/#/projects/p-kitchen' });
    await page.click('[data-act="settings"]');
    await page.waitForTimeout(300);
    check('schema 10: no Guest access, no documents folder', !(await page.$('[data-act="guests"]')) && !(await page.$('#formDialog [name="documents_url"]')));
    await context.close();
  }
  {
    const { page, db, context } = await open({ label: 'stranger', email: 'casey@example.com' });
    check('a stranger (neither family nor guest): Not on the list yet', /Not on the list yet/.test(await text(page, '#app')) && !(db.rpcCalls || []).some((c) => c.name === 'guest_contacts'),
      await text(page, '#app'));
    await context.close();
  }

  await browser.close();
  server.close();
  errors.forEach((e) => results.push(`FAIL  no page errors  (${e.slice(0, 300)})`));
  results.forEach((r) => console.log(r));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`== guests: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
