// Browser tests for the v1 hub (sign-in, Home, Projects, Contractors, Family) and the public
// share page, against a mocked Supabase. Run alone with: node tests/e2e/v1.test.js
const { chromium } = require('playwright');
const { makeDb, install, signIn, expectedConsoleError } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  async function open(opts = {}) {
    const db = opts.db || makeDb();
    const log = [];
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 } }, opts.ctx));
    if (opts.email) await signIn(context, opts.email);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${opts.label || ''}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !expectedConsoleError(m)) errors.push(`${opts.label || ''} console: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    await install(page, db, log, opts);
    await page.goto(BASE + (opts.path || '/'));
    await page.waitForTimeout(400);
    return { page, db, log, context };
  }
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');

  // 1. Not configured yet
  let { page } = await open({ noConfig: true, label: 'noconfig' });
  check('unconfigured hub shows setup message', (await text(page, 'body')).includes('Almost ready'));

  // 2. Login screen + sending a code + rejected email
  let loginCtx = await open({ label: 'login' });
  page = loginCtx.page;
  check('signed-out visitor sees login', (await text(page, 'body')).includes('Email me a sign-in code'));
  check('the sign-in page says what the hub is for now (not the v1 "projects, contractors and plans")', (await text(page, '.login .login-lead')) === "Your family's calendar, jobs and projects in one place.", await text(page, '.login .login-lead'));
  await page.screenshot({ path: SHOTS + 'login.png' });
  await page.fill('input[name=email]', 'stranger@example.com');
  await page.click('#loginForm button[type=submit]');
  await page.waitForTimeout(300);
  // Someone added on the Family page without "Can sign in" is refused the same way, so the message
  // says what to do rather than that they aren't on the family list.
  check('unlisted email is refused, with what to ask for', (await text(page, '#loginMsg')).trim() === "That email can't sign in yet. Ask whoever runs the Home Hub to tick 'Can sign in' for you on the Family page.", await text(page, '#loginMsg'));
  check('code box stays hidden after a refusal', await page.$eval('#codeForm', (f) => f.hidden));
  await page.fill('input[name=email]', 'Alex@Example.com');
  await page.click('#loginForm button[type=submit]');
  await page.waitForTimeout(300);
  check('listed email is asked for the code', await page.isVisible('input[name=code]') && (await text(page, '#codeSent')).includes('alex@example.com'), await text(page, '#codeSent'));
  check('code box is focused', await page.evaluate(() => document.activeElement && document.activeElement.name === 'code'));
  await page.screenshot({ path: SHOTS + 'login-code.png' });

  // 2b. A reload (switching to the mail app on a phone) keeps the code box
  await page.reload();
  await page.waitForTimeout(400);
  check('pending code survives a reload', await page.isVisible('input[name=code]') && (await text(page, '#codeSent')).includes('alex@example.com'));

  // 2c. Wrong code, then the right one (typed with a space)
  await page.fill('input[name=code]', '000000');
  await page.click('#codeForm button[type=submit]');
  await page.waitForTimeout(300);
  check('wrong code explained', (await text(page, '#loginMsg')).includes("didn't work"), await text(page, '#loginMsg'));
  check('sign-in button usable again after a wrong code', await page.isEnabled('#codeForm button[type=submit]'));
  await page.fill('input[name=code]', '123 456');
  await page.click('#codeForm button[type=submit]');
  await page.waitForTimeout(700);
  const lastVerify = (loginCtx.db.verifyCalls || []).slice(-1)[0] || {};
  check('code verified as email OTP for that address', lastVerify.email === 'alex@example.com' && lastVerify.token === '123456' && lastVerify.type === 'email', JSON.stringify(lastVerify));
  check('right code signs in to home', /Good (morning|afternoon|evening), Alex/.test(await text(page, '#main')));
  check('pending code cleared after sign-in', await page.evaluate(() => localStorage.getItem('homehub.pendingSignIn') === null));

  // 2d. "Use a different email" goes back and forgets the pending code
  loginCtx = await open({ label: 'restart' });
  page = loginCtx.page;
  await page.fill('input[name=email]', 'sam@example.com');
  await page.click('#loginForm button[type=submit]');
  await page.waitForTimeout(300);
  await page.click('#restart');
  await page.waitForTimeout(100);
  check('restart returns to the email box', await page.isVisible('input[name=email]') && !(await page.isVisible('input[name=code]')));
  await page.reload();
  await page.waitForTimeout(400);
  check('restart forgets the pending code', await page.isVisible('input[name=email]') && !(await page.isVisible('input[name=code]')));

  // 2e. The email service refuses to send
  ({ page } = await open({ label: 'smtpdown', smtpDown: true }));
  await page.fill('input[name=email]', 'alex@example.com');
  await page.click('#loginForm button[type=submit]');
  await page.waitForTimeout(300);
  check('email service failure explained', (await text(page, '#loginMsg')).includes("couldn't be sent") && !(await page.isVisible('input[name=code]')), await text(page, '#loginMsg'));

  // 3. Expired link message
  ({ page } = await open({ label: 'expired', path: '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid' }));
  check('expired magic link explained', (await text(page, 'body')).includes('expired or was already used') && (await text(page, 'body')).includes('type it in'));

  // 4. Signed in but not on the list
  ({ page } = await open({ label: 'notlisted', email: 'ex@example.com' }));
  check('signed-in non-member blocked', (await text(page, 'body')).includes('Not on the list yet'));
  check('signed-in non-member: told what to ask for', (await text(page, 'body')).includes("can't use the Home Hub yet") && (await text(page, 'body')).includes("tick 'Can sign in' for you on the Family page"), await text(page, 'body'));

  // 5. Home dashboard
  let ctx = await open({ label: 'home', email: 'alex@example.com' });
  page = ctx.page;
  const home = await text(page, '#main');
  check('home greets by first name', /Good (morning|afternoon|evening), Alex/.test(home));
  check('home lists open projects', home.includes('Kitchen Renovation') && home.includes('Pool repairs') && home.includes('Sprinkler winterization'));
  check('home shows upcoming tasks across projects', home.includes('Design consult & final layout') && home.includes('Kitchen Renovation ·'));
  await page.screenshot({ path: SHOTS + 'home.png', fullPage: true });

  // 6. Upcoming item opens the project at that task
  await page.click('.item[data-project] >> nth=0');
  await page.waitForTimeout(500);
  check('upcoming item deep-links to task', page.url().includes('#/projects/p-kitchen/task/') && await page.$eval('#detail', (d) => d.open));
  await page.keyboard.press('Escape');

  // 7. Project page
  const proj = await text(page, '#main');
  check('project page renders schedule', proj.includes('Kitchen Renovation') && proj.includes('Install cabinets') && /target finish/i.test(proj));
  check('team card shows linked contractor contact', proj.includes('Pat Lee, Lee Electric') && proj.includes('(201) 555-0100'));
  await page.screenshot({ path: SHOTS + 'project.png', fullPage: true });

  // 8. Task detail shows private notes + quick "Mark done"
  await page.click('.g-label[data-id="design"]');
  await page.waitForTimeout(200);
  const det = await text(page, '#detail');
  check('detail shows family-only note', det.includes('Side gate code 4821'));
  await page.screenshot({ path: SHOTS + 'detail.png' });
  await page.click('[data-task-act="done"]');
  await page.waitForTimeout(500);
  const kitchenRow = () => ctx.db.projects.find((p) => p.id === 'p-kitchen');
  check('mark done saves to database', kitchenRow().schedule.phases[0].tasks[0].status === 'done');
  check('detail reopens with Done status', (await text(page, '#detail')).includes('Reopen'));
  await page.keyboard.press('Escape');

  // 9. Edit a task: rename + pin a date
  await page.click('.g-label[data-id="demo"]');
  await page.click('[data-task-act="edit"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: SHOTS + 'task-form.png' });
  await page.fill('#formDialog input[name=name]', 'Demolition, haul-away & dumpster');
  await page.fill('#formDialog input[name=start]', '2026-12-03');
  await page.click('#formDialog [type=submit]');
  await page.waitForTimeout(500);
  const demo = kitchenRow().schedule.phases.flatMap((p) => p.tasks).find((t) => t.id === 'demo');
  check('task edit saved (name, pinned start, kept before/lead)', demo.name === 'Demolition, haul-away & dumpster' && demo.start === '2026-12-03' && demo.before === 'cabinets-arrive', JSON.stringify({ name: demo.name, start: demo.start, before: demo.before }));
  check('form closed after save', !(await page.$eval('#formDialog', (d) => d.open)));

  // 10. A loop is rejected
  await page.click('.g-label[data-id="design"]');
  await page.click('[data-task-act="edit"]');
  await page.check('#formDialog input[name=after][value="complete"]');
  await page.click('#formDialog [type=submit]');
  await page.waitForTimeout(300);
  check('dependency loop rejected with explanation', (await text(page, '#formDialog .form-error')).includes('loop'), await text(page, '#formDialog .form-error'));
  await page.keyboard.press('Escape');

  // 11. Someone else edited meanwhile → friendly conflict message
  kitchenRow().updated_at = '2026-10-24T17:59:59.000000+00:00';
  await page.click('.g-label[data-id="design"]');
  await page.click('[data-task-act="reopen"]');
  await page.waitForTimeout(400);
  check('concurrent edit detected', ctx.log.some((l) => l.startsWith('PATCH')) && kitchenRow().schedule.phases[0].tasks[0].status === 'done');
  await page.keyboard.press('Escape');

  // 12. Share: turn on, then open the public page
  await page.goto(BASE + '/#/projects/p-kitchen');
  await page.waitForTimeout(500);
  await page.click('[data-act=share]');
  await page.click('[data-share=on]');
  await page.waitForTimeout(400);
  const link = await page.$eval('#formDialog .sharebox input', (i) => i.value).catch(() => '');
  check('sharing turned on and link shown', kitchenRow().sharing_enabled === true && link.includes('share.html?p=kitchentoken0123456789ab'), link);
  await page.screenshot({ path: SHOTS + 'share-dialog.png' });
  await page.keyboard.press('Escape');

  const pub = await open({ label: 'share', db: ctx.db, path: '/share.html?p=kitchentoken0123456789ab' });
  const pubText = await text(pub.page, 'body');
  check('public page renders shared schedule', pubText.includes('Kitchen Renovation') && pubText.includes('Install cabinets'));
  check('public page shows contractor name only', pubText.includes('Pat Lee, Lee Electric') && !pubText.includes('555') && !pubText.includes('@leeelectric'));
  await pub.page.click('.g-label[data-id="design"]');
  check('public page hides private notes', !(await text(pub.page, '#detail')).includes('4821'));
  await pub.page.keyboard.press('Escape');
  await pub.page.screenshot({ path: SHOTS + 'share-page.png', fullPage: true });
  const bad = await open({ label: 'share-bad', db: ctx.db, path: '/share.html?p=nottherighttoken00000000' });
  check('unknown share link explained', (await text(bad.page, '#error')).includes('no longer active'));

  // 13. Rotating the link kills the old one
  await page.click('[data-act=share]');
  await page.click('[data-share=rotate]');
  await page.waitForTimeout(400);
  const old = await open({ label: 'share-old', db: ctx.db, path: '/share.html?p=kitchentoken0123456789ab' });
  check('old link stops working after rotation', (await text(old.page, '#error')).includes('no longer active'));
  await page.keyboard.press('Escape');

  // 14. Trades: link Maria to the tile trade
  await page.click('[data-act=trades]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: SHOTS + 'trades-form.png' });
  await page.selectOption('#formDialog .trade-row[data-key="tile"] select', 'c-maria');
  await page.click('#formDialog [type=submit]');
  await page.waitForTimeout(400);
  check('trade linked to contractor', kitchenRow().schedule.trades.tile.contractor_id === 'c-maria');
  check('team panel shows newly linked contractor', (await text(page, '#main')).includes('Maria Gomez, Gomez Tile & Stone'));

  // 15. Blank project: add first task with a new phase and trade
  await page.goto(BASE + '/#/projects/p-pool');
  await page.waitForTimeout(500);
  check('empty project prompts for first task', (await text(page, '#main')).includes('no tasks yet'));
  await page.click('#gv [data-act=add-task]');
  await page.fill('#formDialog input[name=name]', 'Replace pool pump');
  await page.fill('#formDialog input[name=newPhase]', 'Equipment');
  await page.fill('#formDialog input[name=newTrade]', 'Pool technician');
  await page.fill('#formDialog input[name=amount]', '2');
  await page.click('#formDialog [type=submit]');
  await page.waitForTimeout(500);
  const pool = ctx.db.projects.find((p) => p.id === 'p-pool').schedule;
  check('first task creates phase + trade', pool.phases[0].name === 'Equipment' && pool.phases[0].tasks[0].trade === 'pool-technician' && pool.trades['pool-technician'].name === 'Pool technician' && pool.phases[0].tasks[0].days === 2, JSON.stringify(pool.phases));
  check('pool project now shows a schedule', (await text(page, '#main')).includes('Replace pool pump'));

  // 16. New project copied from the kitchen
  await page.goto(BASE + '/#/projects');
  await page.waitForTimeout(400);
  await page.click('[data-act=new-project]');
  await page.fill('#formDialog input[name=name]', 'Primary bathroom');
  await page.selectOption('#formDialog select[name=template]', 'p-kitchen');
  await page.click('#formDialog [type=submit]');
  await page.waitForTimeout(600);
  const bath = ctx.db.projects.find((p) => p.name === 'Primary bathroom');
  const bathTasks = bath ? bath.schedule.phases.flatMap((p) => p.tasks) : [];
  check('copied project has tasks without progress, pins or private notes', bathTasks.length === 36 && bathTasks.every((t) => !t.status && !t.start && !t.private_notes), `${bathTasks.length} tasks`);
  check('navigated to new project', page.url().includes(`#/projects/${bath && bath.id}`));

  // 17. Contractors: add, search, then delete one that is linked
  await page.goto(BASE + '/#/contractors');
  await page.waitForTimeout(400);
  await page.click('[data-act=new-contractor] >> nth=0');
  await page.fill('#formDialog input[name=name]', 'Dana Brooks');
  await page.fill('#formDialog input[name=company]', 'Brooks Plumbing');
  await page.fill('#formDialog input[name=trade]', 'Plumber');
  await page.fill('#formDialog input[name=phone]', '(201) 555-0102');
  await page.click('#formDialog [type=submit]');
  await page.waitForTimeout(500);
  check('contractor added', ctx.db.contractors.some((c) => c.name === 'Dana Brooks') && (await text(page, '#main')).includes('Brooks Plumbing'));
  await page.fill('.searchbar input', 'tile');
  await page.waitForTimeout(100);
  const found = await page.$$eval('.ccard h3', (els) => els.map((e) => e.textContent));
  check('search filters contractors', found.length === 1 && found[0] === 'Maria Gomez', found.join(','));
  await page.fill('.searchbar input', '');
  await page.screenshot({ path: SHOTS + 'contractors.png', fullPage: true });
  await page.click('.ccard:has-text("Pat Lee") [data-edit]');
  await page.click('#formDialog [data-extra="0"]');
  await page.waitForTimeout(600);
  const elec = kitchenRow().schedule.trades.electrician;
  check('deleting a linked contractor keeps their name on the project', !ctx.db.contractors.some((c) => c.id === 'c-pat') && !elec.contractor_id && elec.who === 'Pat Lee, Lee Electric', JSON.stringify(elec));

  // 18. Family: add and remove a member
  await page.goto(BASE + '/#/family');
  await page.waitForTimeout(400);
  await page.click('[data-act=add-member]');
  await page.fill('#formDialog input[name=name]', 'Jordan Example');
  await page.fill('#formDialog input[name=email]', 'Jordan@Example.com');
  await page.click('#formDialog [type=submit]');
  await page.waitForTimeout(500);
  check('member added with lowercased email', ctx.db.members.some((m) => m.email === 'jordan@example.com'));
  await page.screenshot({ path: SHOTS + 'family.png', fullPage: true });
  await page.click('[data-remove="jordan@example.com"]');
  await page.waitForTimeout(500);
  check('member removed', !ctx.db.members.some((m) => m.email === 'jordan@example.com'));
  check('admin cannot remove self (no button)', !(await page.$('[data-remove="alex@example.com"]')));

  // 19. Non-admin member: no member management
  const sam = await open({ label: 'sam', email: 'sam@example.com', path: '/#/family', db: ctx.db });
  check('member (non-admin) cannot add people', !(await sam.page.$('[data-act=add-member]')));

  // 20. Sign out
  await page.click('[data-act=sign-out]');
  await page.waitForTimeout(500);
  check('sign out returns to login', (await text(page, 'body')).includes('Email me a sign-in code'));

  // 21. Database unreachable (e.g. paused project)
  const off = await open({ label: 'offline', email: 'alex@example.com', offline: true });
  check('unreachable database explained', (await text(off.page, 'body')).includes("Can't reach the database"), (await text(off.page, 'body')).slice(0, 120));

  // 22. Phone + dark mode
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const m1 = await open({ label: 'm-home', email: 'alex@example.com', ctx: phone });
  check('phone: no sideways page scroll (home)', !(await m1.page.evaluate(() => document.documentElement.scrollWidth > 390)));
  await m1.page.screenshot({ path: SHOTS + 'm-home.png', fullPage: true });
  await m1.page.goto(BASE + '/#/projects/p-kitchen');
  await m1.page.waitForTimeout(500);
  check('phone: no sideways page scroll (project)', !(await m1.page.evaluate(() => document.documentElement.scrollWidth > 390)));
  await m1.page.screenshot({ path: SHOTS + 'm-project.png' });
  await m1.page.click('[data-act=add-task]');
  await m1.page.waitForTimeout(200);
  await m1.page.screenshot({ path: SHOTS + 'm-taskform.png' });
  const m2 = await open({ label: 'm-login', ctx: Object.assign({ colorScheme: 'dark' }, phone) });
  await m2.page.fill('input[name=email]', 'alex@example.com');
  await m2.page.click('#loginForm button[type=submit]');
  await m2.page.waitForTimeout(300);
  check('phone: code screen fits', await m2.page.isVisible('input[name=code]') && !(await m2.page.evaluate(() => document.documentElement.scrollWidth > 390)));
  check('phone: code box brings up the number pad', (await m2.page.getAttribute('input[name=code]', 'inputmode')) === 'numeric' && (await m2.page.getAttribute('input[name=code]', 'autocomplete')) === 'one-time-code');
  await m2.page.screenshot({ path: SHOTS + 'm-login-code-dark.png' });
  const d1 = await open({ label: 'dark', email: 'alex@example.com', ctx: { viewport: { width: 1366, height: 900 }, colorScheme: 'dark' }, path: '/#/contractors' });
  await d1.page.screenshot({ path: SHOTS + 'dark-contractors.png' });

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  const realErrors = errors.filter((e) => !/internetdisconnected|Failed to fetch|ERR_INTERNET_DISCONNECTED|status of 40[36]/i.test(e) && !/^smtpdown console: .*status of 500/.test(e));
  console.log('PAGE ERRORS:', realErrors.length ? '\n' + realErrors.join('\n') : 'none');
  await browser.close();
  await server.close();
  if (results.some((r) => r.startsWith('FAIL')) || realErrors.length) process.exitCode = 1;
})().catch((err) => {
  // A step that throws (e.g. a selector that never appears) stops the run: report what ran, then fail.
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
