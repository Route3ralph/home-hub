// Browser tests for the core's module system: script order, which pages register in v1 and v2 mode
// (and for schema versions 3, 4 and 5: Food shows on 4 and up, Homework on 5 only, under More on phones), tab order, and the page context (ctx.params, ctx.signal, ctx.stale). A "probe" page module is
// appended to the last module script, so it registers through the same HomeHub.register() contract
// as the real pages, and nothing test-only ships in the site.
// Run alone with: node tests/e2e/modules.test.js
const { chromium } = require('playwright');
const { makeDb, install, signIn, expectedConsoleError, withFood, foodRpc, withHomework, homeworkRpc } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 160)})` : ''}`);

const V1_TABS = [['Home', '#/', 'home'], ['Projects', '#/projects', 'projects'], ['Contractors', '#/contractors', 'contractors'], ['Family', '#/family', 'family']];

// A page module that records the ctx it was given. No tab unless `nav` is passed.
const probeModule = ({ name = 'probe', min = 1, max = 1, nav = null, root = false } = {}) => `
;(function () {
  HomeHub.register({
    name: ${JSON.stringify(name)},
    schema: { min: ${min}, max: ${max} },
    ${nav ? `nav: ${JSON.stringify(nav)},` : ''}
    match: function (parts) {
      if (${root} && !parts.length) return {};
      return parts[0] === ${JSON.stringify(name)} ? { id: parts[1] || null } : null;
    },
    render: function (main, ctx) {
      (window.__ctx = window.__ctx || []).push(ctx);
      main.innerHTML = '<p id="probe">' + ${JSON.stringify(name)} + ' ' + (ctx.params.id || '') + '</p>';
    },
  });
})();`;

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  async function open(opts = {}) {
    const db = opts.db || makeDb();
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    if (opts.email !== null) await signIn(context, opts.email || 'alex@example.com');
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error' || expectedConsoleError(m) || (opts.allowConsole && opts.allowConsole.test(m.text()))) return;
      errors.push(`${opts.label} console: ${m.text()}`);
    });
    page.on('dialog', (d) => d.accept());
    await install(page, db, [], opts);
    // A database function whose request gets no answer at all (the connection drops). Registered after
    // install(), so it takes precedence over the mock for that one address.
    if (opts.dropRpc) {
      await page.route(`**/rest/v1/rpc/${opts.dropRpc}`, (route) => {
        db.dropped = (db.dropped || 0) + 1;
        route.abort('internetdisconnected');
      });
    }
    if (opts.noV2Pages) {
      // 'all' also blanks projects.js, which is a v1 page and a v2 page (schema 1..99).
      for (const m of ['today', 'calendar', 'tasks', 'directory', 'people', 'settings', 'food', 'homework'].concat(opts.noV2Pages === 'all' ? ['projects'] : [])) {
        await page.route(`**/assets/modules/${m}.js*`, (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
      }
    }
    if (opts.probes || opts.delayLastModule) {
      // The last module script: optionally slow (to prove boot waits for it), plus any probe modules.
      await page.route('**/assets/modules/family.js*', async (route) => {
        if (opts.delayLastModule) await new Promise((r) => setTimeout(r, opts.delayLastModule));
        const response = await route.fetch();
        route.fulfill({ response, body: (await response.text()) + (opts.probes || []).join('\n') });
      });
    }
    await page.goto(BASE + (opts.path || '/'));
    await page.waitForTimeout(500);
    return { page, db };
  }
  const tabs = (page) => page.$$eval('.tabs a', (as) => as.map((a) => [a.textContent, a.getAttribute('href'), a.dataset.tab]));
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
  const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(300); };

  // 1. index.html loads everything in a fixed order, synchronously, with one ?v= for all
  let { page, db } = await open({ label: 'scripts' });
  const scripts = await page.$$eval('script[src]', (s) => s.map((x) => ({ src: x.getAttribute('src'), async: x.async || x.defer })));
  const order = scripts.map((s) => s.src.replace(/\?.*$/, '').replace(/^https:\/\/cdn\.jsdelivr\.net\/.*\/supabase\.js$/, 'supabase-js'));
  // shoplist.js (the shopping list's shared pieces, schema 4) and plan.js (homework's, schema 5) right after the
  // core; Food, then Homework, after the other pages. (v1.3 adds plan.js and homework.js, on purpose.)
  const expected = ['config.js', 'supabase-js', 'assets/gantt.js', 'assets/hub.js', 'assets/shoplist.js', 'assets/plan.js',
    'assets/modules/home.js', 'assets/modules/projects.js', 'assets/modules/contractors.js', 'assets/modules/family.js',
    ...['today', 'calendar', 'tasks', 'directory', 'people', 'settings', 'food', 'homework'].map((m) => `assets/modules/${m}.js`)];
  check('scripts load core first, then each module, in a fixed order', JSON.stringify(order) === JSON.stringify(expected), order.join(', '));
  check('no script is async or deferred', scripts.every((s) => !s.async));
  const versions = new Set(scripts.concat(await page.$$eval('link[rel=stylesheet]', (l) => l.map((x) => ({ src: x.getAttribute('href') }))))
    .map((s) => (s.src.match(/[?&]v=([^&]+)/) || [])[1]));
  check('every script and the stylesheet carry the same ?v=', versions.size === 1 && !versions.has(undefined), [...versions].join(', '));

  // 2. v1 mode (no hub_schema_version in the database): exactly today's tabs, in today's order
  check('core asks the database for its schema version', (db.rpcCalls || []).some((c) => c.name === 'hub_schema_version'));
  check('missing hub_schema_version means v1 mode', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 1);
  const v1 = await tabs(page);
  check('v1 tabs are Home, Projects, Contractors, Family with their old links', JSON.stringify(v1) === JSON.stringify(V1_TABS), JSON.stringify(v1));
  check('Home tab is current on the first page', (await page.getAttribute('.tabs a[data-tab="home"]', 'aria-current')) === 'page');
  await go(page, '#/projects/p-kitchen');
  check('project page keeps the Projects tab current', (await page.getAttribute('.tabs a[data-tab="projects"]', 'aria-current')) === 'page' && (await text(page, '#main')).includes('Install cabinets'));
  await go(page, '#/no-such-page');
  check('an unknown address shows Home, as before', /Good (morning|afternoon|evening), Alex/.test(await text(page, '#main')) && (await page.getAttribute('.tabs a[data-tab="home"]', 'aria-current')) === 'page');

  // 3. register() checks its input
  const bad = await page.evaluate(() => {
    const tryReg = (def) => { try { HomeHub.register(def); return 'accepted'; } catch (e) { return e.message; } };
    return {
      noRender: tryReg({ name: 'x', schema: { min: 1, max: 1 }, match: () => null }),
      badSchema: tryReg({ name: 'y', schema: { min: 2, max: 1 }, match: () => null, render() {} }),
      badNav: tryReg({ name: 'z', schema: { min: 1, max: 1 }, nav: { label: 'Z' }, match: () => null, render() {} }),
      clash: tryReg({ name: 'family', schema: { min: 1, max: 2 }, match: () => null, render() {} }),
      nextVersion: tryReg({ name: 'family', schema: { min: 2, max: 2 }, match: () => null, render() {} }),
      frozen: (() => { try { HomeHub.core.route = null; } catch (e) { return 'frozen'; } return HomeHub.core.route === null ? 'changed' : 'frozen'; })(),
    };
  });
  check('register() rejects a module without render()', /needs/.test(bad.noRender), bad.noRender);
  check('register() rejects schema min > max', /needs/.test(bad.badSchema), bad.badSchema);
  check('register() rejects a tab without an order', /needs/.test(bad.badNav), bad.badNav);
  check('register() rejects two modules with one name for the same version', /two "family" modules/.test(bad.clash), bad.clash);
  check('register() allows the same name for another schema version', bad.nextVersion === 'accepted', bad.nextVersion);
  check('the core API cannot be overwritten by a module', bad.frozen === 'frozen', bad.frozen);

  // 4. Boot waits for every module script, even a slow one
  ({ page } = await open({ label: 'slow', delayLastModule: 1500, path: '/#/family' }));
  await page.waitForTimeout(1500);
  check('a slow module script still registers before the first page', JSON.stringify(await tabs(page)) === JSON.stringify(V1_TABS) && (await text(page, '#main')).includes('Who can sign in'));

  // 5. Tab order comes from nav.order, not script order; a module without nav gets no tab
  ({ page } = await open({ label: 'order', probes: [probeModule({ name: 'garden', nav: { label: 'Garden', order: 25 } }), probeModule()] }));
  const ordered = (await tabs(page)).map((t) => t[0]);
  check('a tab with order 25 sits between Projects and Contractors', JSON.stringify(ordered) === JSON.stringify(['Home', 'Projects', 'Garden', 'Contractors', 'Family']), ordered.join(', '));
  check('a module without nav adds no tab', !ordered.includes('probe'));

  // 6. ctx: params, seq, and the signal that aborts when the page is left
  await go(page, '#/probe/abc');
  check('a module page renders with its params', (await text(page, '#probe')) === 'probe abc');
  const first = await page.evaluate(() => { const c = window.__ctx[0]; return { aborted: c.signal.aborted, stale: c.stale(), seq: c.seq }; });
  check('ctx.signal is live and ctx.stale() false while the page is shown', first.aborted === false && first.stale === false && Number.isInteger(first.seq), JSON.stringify(first));
  await go(page, '#/contractors');
  const left = await page.evaluate(() => { const c = window.__ctx[0]; return { aborted: c.signal.aborted, stale: c.stale() }; });
  check('navigating away aborts the previous page\'s ctx.signal', left.aborted === true && left.stale === true, JSON.stringify(left));
  check('the next page renders after the abort', (await text(page, '#main')).includes('Maria Gomez'));
  await go(page, '#/probe/one');
  await go(page, '#/probe/two');
  const same = await page.evaluate(() => window.__ctx.slice(-2).map((c) => ({ id: c.params.id, aborted: c.signal.aborted, seq: c.seq })));
  check('moving between two addresses of one page also aborts the first', same[0].aborted && !same[1].aborted && same[1].seq > same[0].seq && same[1].id === 'two', JSON.stringify(same));
  await page.evaluate(() => HomeHub.core.sb.auth.signOut());
  await page.waitForTimeout(500);
  const out = await page.evaluate(() => window.__ctx[window.__ctx.length - 1].signal.aborted);
  check('signing out aborts the page on screen', out === true && (await text(page, 'body')).includes('Email me a sign-in code'));

  // 7. A deep link straight to a module page
  ({ page } = await open({ label: 'deep', probes: [probeModule()], path: '/#/probe/xyz' }));
  check('opening a module page by its address works', (await text(page, '#probe')) === 'probe xyz');

  // 8. v2 database, no v2 modules yet: v1 pages hide, the shell still works
  const v2 = { hub_schema_version: () => 2, mark_signed_in: () => null,
    clock: () => ({ local_date: '2026-11-01', local_time: '09:00:00', tz: 'America/New_York' }) };
  const v2Db = () => Object.assign(makeDb(), { people: [], household: [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [] }] });
  ({ page } = await open({ label: 'v2-empty', rpc: v2, db: v2Db(), noV2Pages: 'all' }));
  check('hub_schema_version 2 is read as v2', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 2);
  check('v2: v1-only pages are hidden (no tabs)', (await tabs(page)).length === 0 && (await page.isVisible('.topbar .brand')));
  check('v2 with no pages shows a reload hint instead of crashing', (await text(page, '#main')).includes('Reload the page'), await text(page, '#main'));
  await go(page, '#/projects');
  check('v2: v1 addresses no longer open v1 pages', !(await text(page, '#main')).includes('Kitchen Renovation'));
  await page.screenshot({ path: SHOTS + 'v2-empty.png' });

  // 9. v2 database with a v2 module: only it shows; in v1 mode it stays hidden
  const today = probeModule({ name: 'today', min: 2, max: 2, nav: { label: 'Today', order: 5, href: '#/' }, root: true });
  ({ page } = await open({ label: 'v2-today', rpc: v2, db: v2Db(), noV2Pages: 'all', probes: [today] }));
  check('v2: only modules made for v2 get tabs', JSON.stringify(await tabs(page)) === JSON.stringify([['Today', '#/', 'today']]));
  check('v2: the v2 module serves the first page', (await text(page, '#probe')).trim() === 'today');
  ({ page } = await open({ label: 'v2-projects', rpc: v2, db: v2Db(), noV2Pages: true, probes: [today] }));
  check('v2: Projects is made for v1 and v2, so it shows in v2 too, after the v2 pages (order 40)',
    JSON.stringify(await tabs(page)) === JSON.stringify([['Today', '#/', 'today'], ['Projects', '#/projects', 'projects']]), JSON.stringify(await tabs(page)));
  ({ page } = await open({ label: 'v1-today', noV2Pages: true, probes: [today] }));
  check('v1: a v2-only module stays hidden', JSON.stringify(await tabs(page)) === JSON.stringify(V1_TABS));

  // 10. hub_schema_version failing for another reason is an error, not a silent v1
  ({ page } = await open({ label: 'v-error', rpc: { hub_schema_version: () => ({ __status: 500, body: { message: 'Database restarting' } }) }, allowConsole: /status of 500/ }));
  const errText = await text(page, 'body');
  check('a schema version error is reported, not guessed', errText.includes('Something went wrong') && errText.includes('Database restarting') && !(await page.$('.tabs')), errText.slice(0, 120));

  // 11. hub_schema_version answering 1 is v1 mode, like a database without it
  ({ page } = await open({ label: 'v-one', rpc: { hub_schema_version: () => 1 } }));
  check('hub_schema_version 1 is read as v1, with the v1 tabs', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 1 && JSON.stringify(await tabs(page)) === JSON.stringify(V1_TABS), JSON.stringify(await tabs(page)));

  // 12. No answer at all to the version call (the connection dropped just after whoami worked): sign-in
  // isn't blocked, and the site shows the v1 pages, which work on either database (the v2 migration only adds).
  ({ page, db } = await open({ label: 'v-dropped', dropRpc: 'hub_schema_version', allowConsole: /ERR_INTERNET_DISCONNECTED/ }));
  const dropped = (await text(page, 'body')).replace(/\s+/g, ' ');
  check('a dropped connection on the schema version call falls back to v1', db.dropped > 0 && (await page.evaluate(() => HomeHub.core.schemaVersion)) === 1 && JSON.stringify(await tabs(page)) === JSON.stringify(V1_TABS), `${db.dropped || 0} dropped; ${dropped.slice(0, 120)}`);
  check('a dropped connection on the schema version call does not block sign-in', /Good (morning|afternoon|evening), Alex/.test(await text(page, '#main')), dropped.slice(0, 120));

  // 13. Schema version 3 (migration 0003, Google Calendar): the same v2 pages and tabs as version 2
  const V2_TABS = [['Today', '#/', 'today'], ['Calendar', '#/calendar', 'calendar'], ['Tasks', '#/tasks', 'tasks'], ['Projects', '#/projects', 'projects'],
    ['Directory', '#/directory', 'directory'], ['Family', '#/people', 'people'], ['Settings', '#/settings', 'settings']];
  const probe23 = probeModule({ name: 'probe', min: 2, max: 3 });
  ({ page } = await open({ label: 'v2-tabs', rpc: v2, db: v2Db(), path: '/#/probe', probes: [probe23] }));
  const tabs2 = await tabs(page);
  ({ page } = await open({ label: 'v3-tabs', rpc: Object.assign({}, v2, { hub_schema_version: () => 3 }), db: v2Db(), path: '/#/probe', probes: [probe23] }));
  const tabs3 = await tabs(page);
  check('hub_schema_version 3 is read as 3, and is v2 mode (the bottom bar)', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 3 && !!(await page.$('.bottombar')));
  check('version 3 shows the v2 tabs, the same as version 2', JSON.stringify(tabs3) === JSON.stringify(V2_TABS) && JSON.stringify(tabs2) === JSON.stringify(V2_TABS), JSON.stringify([tabs2, tabs3]));
  check('version 3: a page made for 2..3 serves its address', (await text(page, '#probe')).trim() === 'probe');
  check('version 3: no Food page (no tab, and use(\'food\') finds nothing)', !(await page.$('.tabs a[data-tab="food"]')) && !(await page.$('.bottombar a[data-tab="food"]'))
    && (await page.evaluate(() => { try { HomeHub.core.use('food'); return 'found'; } catch (e) { return 'none'; } })) === 'none');

  // 14. Schema version 4 (migration 0004, dinners and the shopping list): the v2 tabs plus Food, after Tasks
  const V4_TABS = V2_TABS.slice(0, 3).concat([['Food', '#/food', 'food']], V2_TABS.slice(3));
  const probe24 = probeModule({ name: 'probe', min: 2, max: 4 });
  // A schema-4 database has the food tables and functions (mock.js withFood, foodRpc), so the real Food page has what it reads.
  ({ page, db } = await open({ label: 'v4-tabs', rpc: Object.assign({}, v2, foodRpc, { hub_schema_version: () => 4 }), db: withFood(v2Db()), path: '/#/probe', probes: [probe24] }));
  const tabs4 = await tabs(page);
  check('hub_schema_version 4 is read as 4, and is v2 mode (the bottom bar)', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 4 && !!(await page.$('.bottombar')));
  check('version 4 shows the v2 tabs plus Food, between Tasks and Projects', JSON.stringify(tabs4) === JSON.stringify(V4_TABS), JSON.stringify(tabs4));
  check('version 4: Food is in the phone bottom bar (a primary page)', !!(await page.$('.bottombar a[data-tab="food"]')));
  await go(page, '#/food');
  check('version 4: #/food opens the Food page, with the Food tab current', (await text(page, '#main h1')) === 'Food' && (await page.getAttribute('.tabs a[data-tab="food"]', 'aria-current')) === 'page', await text(page, '#main'));
  await go(page, '#/food/2026-11-03');
  check('version 4: #/food/<date> is the Food page too', (await text(page, '#main h1')) === 'Food' && (await page.getAttribute('.tabs a[data-tab="food"]', 'aria-current')) === 'page');
  check('version 4: no Homework page (no tab, and use(\'homework\') finds nothing), and no homework request', !(await page.$('.tabs a[data-tab="homework"]'))
    && (await page.evaluate(() => { try { HomeHub.core.use('homework'); return 'found'; } catch (e) { return 'none'; } })) === 'none'
    && !(db.rpcCalls || []).some((c) => c.name === 'homework_week'));

  // 15. Schema version 5 (migration 0005, homework): the version-4 tabs plus Homework, between Food and Projects;
  // not a primary page, so on a phone it is under More and the bottom bar stays as on 4.
  const V5_TABS = V4_TABS.slice(0, 4).concat([['Homework', '#/homework', 'homework']], V4_TABS.slice(4));
  const probe25 = probeModule({ name: 'probe', min: 2, max: 5 });
  const v5Db = () => {
    const d = withHomework(v2Db());
    d.people.push({ id: 'p-jordan', name: 'Jordan Example', role: 'kid', active: true, color: '#16a34a', language: 'en', sort_order: 1 });
    return d;
  };
  ({ page, db } = await open({ label: 'v5-tabs', rpc: Object.assign({}, v2, foodRpc, homeworkRpc, { hub_schema_version: () => 5 }), db: v5Db(), path: '/#/probe', probes: [probe25] }));
  const tabs5 = await tabs(page);
  check('hub_schema_version 5 is read as 5, and is v2 mode', (await page.evaluate(() => HomeHub.core.schemaVersion)) === 5 && !!(await page.$('.bottombar')));
  check('version 5 shows the version-4 tabs plus Homework, between Food and Projects', JSON.stringify(tabs5) === JSON.stringify(V5_TABS), JSON.stringify(tabs5));
  check('version 5: Homework isn\'t in the phone bottom bar (it is under More)', !(await page.$('.bottombar a[data-tab="homework"]')));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.bb-more');
  await page.waitForTimeout(200);
  check('version 5: the More sheet lists Homework', (await page.$$eval('#sheet .sheet-list a', (as) => as.map((a) => a.dataset.tab))).includes('homework'));
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1366, height: 900 });
  await go(page, '#/homework');
  check('version 5: #/homework opens the Homework page, with its tab current', (await text(page, '#main h1')) === 'Homework' && (await page.getAttribute('.tabs a[data-tab="homework"]', 'aria-current')) === 'page',
    await text(page, '#main'));
  check('version 5: use(\'homework\') finds the page', (await page.evaluate(() => { try { HomeHub.core.use('homework'); return 'found'; } catch (e) { return 'none'; } })) === 'found');

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
  await server.close();
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
})().catch((err) => {
  // A step that throws (e.g. a selector that never appears) stops the run: report what ran, then fail.
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
