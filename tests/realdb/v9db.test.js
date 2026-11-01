// The site as it is now, on the database as it is live before Hearth people (schema.sql, the v1 household,
// migrations 0002 to 0009, then the v2 household): the site and hub-jobs go live before migration 0010 is applied
// (docs/v1.1-google-calendar.md §11.9 steps 1 and 2), so on schema 9 nothing new shows and nothing new is asked for.
// The wall's own Google calendar ("Hearth Calendar", whose events carry Hearth guests such as jordan@team-example-0000)
// is added under Calendars to read as Family, Tested and read by the real hub-jobs: Google is asked for no guest
// address (calendar_read_due has no sort_by_guest on 9). Then the pages make no failing request and ask for no
// hearth_tags, no set_hearth_tag and no sort_by_guest; Settings shows no Sort by Hearth person and no Hearth people
// (Show to kids as before, for Alex and for Sam); Calendar and Today draw its events as before: a Family calendar's,
// under every person filter, neutral, in the grown-ups' days and in no kid's or helper's.
// Run through tests/realdb/run.sh (its own copy of the v9 template database).
const { setup } = require('./lib');

const TODAY = '2026-10-27';
const HEARTH = 'hearth0000@group.calendar.google.com';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NEW_CALLS = /^\/rest\/v1\/(hearth_tags|rpc\/set_hearth_tag)$/;

(async () => {
  const h = await setup('v9db', { v9: true });
  const { check, flow, sql, open, tc, texts, until } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || r.error.error || ''}` : ''}`);
  // Anything of 0010's asked for: its table or function, or the new column in a query or a body.
  const asksNew = (reqs) => reqs.filter((r) => NEW_CALLS.test(r.path) || /sort_by_guest|guests/.test(`${r.query || ''} ${r.body || ''}`));
  const G = h.google;
  let calId = null;

  await flow('schema 9', async () => {
    const v = await one('select public.hub_schema_version() as v');
    const cols = await sql("select column_name from information_schema.columns where table_schema = 'public' and table_name in ('calendars', 'google_events') and column_name in ('sort_by_guest', 'guests')");
    check('v9 db: the database is schema 9 (0009, no 0010): no hearth_tags, no sort_by_guest or guests column', v.v === '9' && !(await one("select to_regclass('public.hearth_tags') as t")).t
      && !cols.length, { v, cols });
    // The wall's calendar in the family Gmail, shared with the hub with See event details, and three wall events: Jordan's
    // lesson, a Family visit, and a private one (Google hides its details from a reader).
    G.add(HEARTH, { summary: 'Hearth Calendar', role: 'reader' });
    G.typeIn(HEARTH, { summary: 'Piano', start: { dateTime: '2026-10-27T20:30:00Z' }, end: { dateTime: '2026-10-27T21:15:00Z' },
      attendees: [{ email: 'jordan@team-example-0000', responseStatus: 'accepted' }, { email: 'alex@example.com', responseStatus: 'accepted' }] });
    G.typeIn(HEARTH, { summary: 'Visit', start: { date: TODAY }, end: { date: '2026-10-28' }, attendees: [{ email: 'familyanddogs@team-example-0000', responseStatus: 'accepted' }] });
    G.typeIn(HEARTH, { summary: 'Doctor', visibility: 'private', location: 'Clinic', start: { dateTime: '2026-10-27T16:00:00Z' }, end: { dateTime: '2026-10-27T16:30:00Z' },
      attendees: [{ email: 'jordan@team-example-0000', responseStatus: 'accepted' }] });
    // Alex adds it under Calendars to read, Whose: Family, as Settings saves it; Test; Sync now.
    const token = (await h.sessionFor('alex@example.com')).access_token;
    const made = await h.api('/rest/v1/calendars', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, prefer: 'return=representation' },
      body: JSON.stringify({ google_id: HEARTH, kind: 'family', person_id: null, label: 'Hearth', writes: false, for_kids: false }) });
    calId = made.body && made.body[0] && made.body[0].id;
    const test = await h.hubJobsAs('alex@example.com', { action: 'calendar_test', calendar_id: calId });
    const n = G.requests.length;
    const sync = await h.hubJobsAs('alex@example.com', { action: 'calendar' });
    const reads = G.requests.slice(n).filter((r) => r.method === 'GET' && r.calendar === HEARTH && !r.event);
    check('v9 db: hub-jobs reads the wall\'s calendar as any other: its fields ask for no guest address', made.status === 201 && test.status === 200 && sync.status === 200
      && reads.length === 1 && /attendees\(self,responseStatus\)/.test(reads[0].query.fields) && !/email/.test(reads[0].query.fields), { made: made.status, test: test.body, sync: sync.body, reads: reads.map((r) => r.query.fields) });
    const ge = await sql(`select title, private, location from google_events where calendar_id = '${calId}' order by start_at nulls first`);
    check('v9 db: its three events are cached as before (the private one without title or place)', same(ge.map((e) => [e.title, e.private, e.location]),
      [['Visit', 'f', null], ['', 't', null], ['Piano', 'f', null]]), ge);
  });

  await flow('pages on schema 9', async () => {
    await h.mark();
    // Settings: Calendars to read as before, for an admin and a member.
    for (const who of ['alex', 'sam']) {
      const { page, context } = await open({ email: `${who}@example.com`, path: '/#/settings', label: `v9db-settings-${who}` });
      await page.waitForSelector('[data-ref="greads"]', { timeout: 10000 });
      const row = `[data-ref="greads"] [data-slot="${calId}"]`;
      const card = await tc(page, '[data-ref="calendar"]');
      check(`v9 db (${who}): Settings shows the Hearth calendar under Calendars to read with no Sort by Hearth person, no Hearth people and no line to match`,
        (await page.evaluate(() => HomeHub.core.schemaVersion)) === 9 && !!(await page.$(row)) && !(await page.$('[data-gsort], [data-hearth], [data-ref="htodo"]'))
        && !/Hearth person|Hearth people/.test(card), card.slice(0, 300));
      check(`v9 db (${who}): Show to kids as before (a box for the admin, nothing for a member with it off)`, who === 'alex' ? !!(await page.$(`${row} [data-gkids]`))
        : !(await page.$(`${row} input`)) && !(await texts(page, `${row} .set-gmeta`)).includes('Shown to kids on My day'));
      await context.close();
    }
    // Calendar (Alex, a phone: the week): the wall's events on today, a Family calendar's: under every filter, neutral.
    const cal = await open({ email: 'alex@example.com', phone: true, path: '/#/calendar', label: 'v9db-calendar' });
    await until(async () => (await cal.page.$$(`[data-list="${TODAY}"] .irow.k-google`)).length > 0);
    const gRows = () => cal.page.$$eval(`[data-list="${TODAY}"] .irow.k-google`, (rs) => rs.map((r) => [r.querySelector('.irow-title').firstChild.textContent.trim(), r.style.getPropertyValue('--pc')]));
    const all = await gRows();
    check('v9 db: Calendar draws the wall\'s events as before: the private one as "Private item", Piano, then the all-day Visit; all neutral (a Family calendar\'s)',
      same(all, [['Private item', ''], ['Piano', ''], ['Visit', '']]), all);
    await cal.page.click(`.cal-people [data-person="${P.taylor.id}"]`);
    await h.settle(cal.page);
    check('v9 db: … and under any one person\'s filter (Taylor\'s), all three still', same((await gRows()).map((r) => r[0]), ['Private item', 'Piano', 'Visit']), await gRows());
    await cal.context.close();
    // Today (Alex): in his day; Jordan's and Taylor's days have none of them (a Family calendar read without Show to kids).
    const t = await open({ email: 'alex@example.com', path: '/', label: 'v9db-today' });
    const day = () => t.page.$$eval('[data-list="day"] .irow.k-google', (rs) => rs.map((r) => r.querySelector('.irow-title').firstChild.textContent.trim()));
    await until(async () => (await day()).length > 0);
    const mine = await day();
    await t.page.click(`.today-chips .pchip[data-person="${P.jordan.id}"]`);
    await h.settle(t.page);
    const jordan = await day();
    await t.page.click(`.today-chips .pchip[data-person="${P.taylor.id}"]`);
    await h.settle(t.page);
    const taylor = await day();
    check('v9 db: Today has them in Alex\'s day, and none in Jordan\'s or Taylor\'s, as before', same(mine, ['Visit', 'Private item', 'Piano']) && !jordan.length && !taylor.length, { mine, jordan, taylor });
    await t.context.close();
    // My day (Jordan's link): none of them, as before.
    const jd = await h.api('/rest/v1/rpc/get_person_day', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_token: P.jordan.day_token }) });
    check('v9 db: Jordan\'s My day has none of the wall\'s events (a Family calendar without Show to kids)', jd.status === 200 && !/Piano|Visit/.test(JSON.stringify(jd.body)), JSON.stringify(jd.body).slice(0, 300));

    const reqs = await h.requests();
    const extra = asksNew(reqs);
    check('v9 db: no page asked for hearth_tags, set_hearth_tag, sort_by_guest or guests', !extra.length, extra.map((r) => `${r.method} ${r.path}${r.query}`));
    check('v9 db: the pages read calendars and google_items as before', reqs.some((r) => r.path === '/rest/v1/calendars') && reqs.some((r) => r.path === '/rest/v1/rpc/google_items'),
      [...new Set(reqs.map((r) => r.path))]);
    const f = await failures();
    check('v9 db: no API request failed', !f.length, f);
  });

  await h.finish();
})().catch((e) => { console.log(`FAIL  v9db stopped: ${e && e.stack}`); process.exit(1); });
