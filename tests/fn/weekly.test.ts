// Unit tests for the Sunday sheets (docs/v2-design.md §31): supabase/functions/hub-jobs/weekly.ts (the layout) and its
// parts of handler.ts (the run sends them; weekly_preview shows them), with a fake database, Resend and clock.
// The sheets below have the shape public.weekly_sheet returns (tests/db/weekly.test.sql checks the SQL); everyone in
// them is made up.
// Run alone with: node --experimental-strip-types tests/fn/weekly.test.ts
import { handle } from '../../supabase/functions/hub-jobs/handler.ts';
import { renderWeekly, sheetChoices, sheetHtml } from '../../supabase/functions/hub-jobs/weekly.ts';
import type { Sheet } from '../../supabase/functions/hub-jobs/weekly.ts';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`);

const SECRET = '9f1c2e7a4b6d8e0f1a3c5e7b9d2f4a6c8e0b';
const ALEX = 'aaaaaaaa-0000-4000-8000-000000000001';
const SAM = 'aaaaaaaa-0000-4000-8000-000000000002';
const JORDAN = 'aaaaaaaa-0000-4000-8000-000000000003';
const TAYLOR = 'aaaaaaaa-0000-4000-8000-000000000004';
const MONDAY = '2026-11-16';

const days = (labels: string[], items: Record<number, any[]> = {}) => labels.map((label, i) => ({
  day: `2026-11-${String(16 + i).padStart(2, '0')}`, label, day_off: i === 4, items: items[i] ?? [], meals: [],
}));
const EN = ['Mon Nov 16', 'Tue Nov 17', 'Wed Nov 18', 'Thu Nov 19', 'Fri Nov 20', 'Sat Nov 21', 'Sun Nov 22'];
const ES = ['lun 16 nov', 'mar 17 nov', 'mié 18 nov', 'jue 19 nov', 'vie 20 nov', 'sáb 21 nov', 'dom 22 nov'];
const familySheet = (): Sheet => ({
  who: 'family', lang: 'en', monday: MONDAY, sunday: '2026-11-22', range: 'Nov 16 – Nov 22',
  people: [{ name: 'Alex', color: '#9333ea' }, { name: 'Jordan', color: 'red; background:url(x)' }, { name: 'Taylor', color: '#16a34a' }],
  days: days(EN, {
    0: [{ kind: 'event', time: '7:20am', title: 'Take Jordan to school', who: 'Taylor with Jordan', color: '#16a34a', place: '12 Elm St', task: false, done: false, all_day: false }],
    1: [{ kind: 'event', time: '4:00pm', end: '5:00pm', title: 'Piano <b>& "more"</b>', who: 'Taylor with Jordan', color: '#16a34a', bring: 'Music book', task: false, done: false, all_day: false },
        { kind: 'event', time: '7:00pm', title: 'Private item', color: '#9333ea', task: false, done: false, all_day: false }],
    2: [{ kind: 'task', title: 'Trash', who: 'Jordan', color: 'url(javascript:alert(1))', task: true, done: false, all_day: false }],
  }),
});
const taylorSheet = (): Sheet => ({
  who: TAYLOR, name: 'Taylor', role: 'helper', lang: 'es', monday: MONDAY, sunday: '2026-11-22', range: '16 nov – 22 nov',
  days: days(ES, { 0: [{ kind: 'event', time: '7:20', title: 'Llevar a Jordan', who: 'con Jordan', note: 'Puerta lateral', task: false, done: false, all_day: false }] }),
  shopping: [{ name: 'Milk', note: '2 gallons' }, { name: '<script>alert(1)</script>' }],
});
const jordanSheet = (): Sheet => ({
  who: JORDAN, name: 'Jordan', role: 'kid', lang: 'en', monday: MONDAY, sunday: '2026-11-22', range: 'Nov 16 – Nov 22',
  days: days(EN),
  homework: [{ title: 'Chapter 3 test', subject: 'Math', kind: 'assignment', due: '2026-11-18', due_label: 'Wed Nov 18', steps: [
    { day: '2026-11-16', label: 'Mon Nov 16', title: 'Solve 5 equations', kind: 'step', minutes: 20, done: false },
    { day: '2026-11-18', label: 'Wed Nov 18', title: 'Take the Chapter 3 test', kind: 'turn_in', minutes: 5, done: false },
    { day: '2026-11-17', label: 'Tue Nov 17', title: 'Gather your notes', kind: 'start', minutes: 5, done: true }] }],
  routine: [{ title: 'Morning', note: 'Before the bus', items: [
    { title: 'Make your bed', days: [true, true, true, true, true, true, true] },
    { title: 'Pack your bag', tag: '5 min', part: 'Bag', days: [true, true, true, true, false, false, false] }] }],
});

// ---------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------
{
  const e = renderWeekly([familySheet(), taylorSheet(), jordanSheet()], { language: 'en' });
  check('subject names the week and the sheets', e.subject === 'Week of Nov 16 – Nov 22: Family, Taylor, Jordan', e.subject);
  check('each sheet has its heading, in its own language',
    e.html.includes('>Family week</h1>') && e.html.includes('>Semana de Taylor</h1>') && e.html.includes('>Jordan&#39;s week</h1>'));
  check('a page break after every sheet but the last', (e.html.match(/page-break-after:always/g) || []).length === 2);
  check('printed landscape, and the note on top hidden when printed', e.html.includes('@page { size: letter landscape;') && e.html.includes('.hh-note { display: none !important; }'));
  check('the note on top in the recipient\'s language, with the count', e.html.includes('The week of Nov 16 – Nov 22, ready to print: 3 sheets, each on its own page.'));
  check('no links of any kind', !/href=|<a\b|src=/i.test(e.html), (e.html.match(/(href|src)=[^ >]*/gi) || []).join(' '));
  check('titles are escaped, never markup', e.html.includes('Piano &lt;b&gt;&amp; &quot;more&quot;&lt;/b&gt;') && !e.html.includes('<b>& "more"</b>'));
  check('a shopping item is escaped', e.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !e.html.includes('<script>'));
  check('a person\'s colour is a left border (prints without background graphics)', e.html.includes('border-left:3px solid #16a34a') && !/background:#16a34a/.test(e.html));
  check('a colour that isn\'t #rgb or #rrggbb is dropped, never written into a style',
    !e.html.includes('javascript') && !e.html.includes('url(') && !e.html.includes('red; background'));
  check('an item\'s end time, who and place', e.html.includes('<b>4:00pm–5:00pm</b>') && e.html.includes('Taylor with Jordan · 12 Elm St'));
  check('Bring in the sheet\'s language', e.html.includes('<b>Bring:</b> Music book'));
  check('a task gets a box to tick', /<span style="display:inline-block;width:11px;height:11px;border:1.5px solid #1f1b16;[^"]*"><\/span>Trash/.test(e.html));
  check('a day off is marked', (e.html.match(/Day off/g) || []).length === 2 && e.html.includes('Día libre'));
  check('an empty day shows a dash', e.html.includes('>—</span></td>'));
  check('the family\'s key to the colours, with only valid colours', e.html.includes('Who&#39;s who') && e.html.includes('border-left:3px solid #9333ea;color:#1f1b16;">Alex'));
  check('the Spanish sheet: weekday headings and the shopping list', e.html.includes('>lun 16</th>') && e.html.includes('Lista de compras') && e.html.includes('Milk</span>') === false && e.html.includes('Milk <span'));
  check('the kid\'s homework steps go on their days, after his items, the plan\'s name first',
    e.html.includes('Chapter 3 test: Solve 5 equations (20 min)') && e.html.includes('<b>Due:</b> Take the Chapter 3 test (5 min)'));
  check('a step done is struck through and ticked', /line-through;"><span[^>]*>✓<\/span>Chapter 3 test: Gather your notes/.test(e.html));
  check('his homework list with due dates', e.html.includes('Homework this week') && e.html.includes('due Wed Nov 18'));
  check('his routine: a box for each day an item applies, none on the others',
    e.html.includes('>Routine</h2>') && e.html.includes('Tick each box when it is done.') && e.html.includes('Pack your bag <span style="color:#5f574c;">(5 min)</span>')
    && (e.html.match(/<td style="text-align:center;padding:2px;border:1px solid #cfc8bd;"><\/td>/g) || []).length === 3);
  check('a routine part heading', e.html.includes('>Bag</td>'));
  check('the text part has every sheet, day by day', e.text.includes('Family week · Week of Nov 16 – Nov 22') && e.text.includes('Semana de Taylor · Semana del 16 nov – 22 nov')
    && e.text.includes('- 4:00pm–5:00pm Piano <b>& "more"</b> · Taylor with Jordan · Bring: Music book') && e.text.includes('☐ Trash · Jordan')
    && e.text.includes('Lista de compras\n☐ Milk · 2 gallons') && e.text.includes('☐ Due: Take the Chapter 3 test (5 min)') && e.text.includes('Routine\nMorning · Before the bus\n  ☐ Make your bed'));

  const es = renderWeekly([taylorSheet()], { language: 'es' });
  check('one sheet, a Spanish recipient: subject, note and footer in Spanish, no page break',
    es.subject === 'Semana del 16 nov – 22 nov: Taylor' && es.html.includes('La semana del 16 nov – 22 nov, lista para imprimir.')
    && es.html.includes('Ajustes, Hojas del domingo') && !es.html.includes('page-break-after:always'));
  check('a subject stays on one line', !/[\r\n]/.test(renderWeekly([{ ...taylorSheet(), name: 'Tay\nlor' }], { language: 'en' }).subject));
  check('sheetHtml on its own: the last sheet has no page break', !sheetHtml(familySheet(), true).includes('page-break-after'));
}
{
  const c = sheetChoices([
    { who: 'family', lang: 'en' }, { who: TAYLOR, lang: 'es' }, { who: 'family', lang: 'es' }, { who: 'Max', lang: 'en' },
    { who: JORDAN, lang: 'fr' }, null, 'family', { who: JORDAN.toUpperCase(), lang: 'en' },
  ]);
  check('sheetChoices: keeps family and people\'s ids with en or es, once each, in order',
    JSON.stringify(c) === JSON.stringify([{ who: 'family', lang: 'en' }, { who: TAYLOR, lang: 'es' }, { who: JORDAN.toUpperCase(), lang: 'en' }]), JSON.stringify(c));
  check('sheetChoices: at most 8, and nothing from what isn\'t a list',
    sheetChoices(Array.from({ length: 12 }, (_, i) => ({ who: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, lang: 'en' }))).length === 8
    && sheetChoices({ who: 'family', lang: 'en' }).length === 0 && sheetChoices(null).length === 0);
}

// ---------------------------------------------------------------------
// The run and the preview, with a fake database
// ---------------------------------------------------------------------
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
type Opts = { weeklyDue?: any[] | null; sheets?: any; people?: any[]; budget?: number; failRpc?: Record<string, any>; today?: string; me?: any; sheetFor?: (a: any) => any };
function setup(o: Opts = {}) {
  const st: any = {
    calls: [] as any[], ops: [] as any[], failRpc: o.failRpc ?? {},
    tables: {
      job_runs: [], notification_log: [], members: [{ email: 'alex@example.com' }],
      household: [{ id: true, weekly_at: '16:00:00', weekly_to: [ALEX, SAM, JORDAN],
                    weekly_sheets: o.sheets ?? [{ who: 'family', lang: 'en' }, { who: TAYLOR, lang: 'es' }, { who: JORDAN, lang: 'en' }] }],
      people: o.people ?? [
        { id: ALEX, name: 'Alex', email: 'alex@example.com', language: 'en', active: true, email_verified_at: '2026-10-01T00:00:00Z' },
        { id: SAM, name: 'Sam', email: 'sam@example.com', language: 'es', active: true, email_verified_at: '2026-10-01T00:00:00Z' },
        { id: JORDAN, name: 'Jordan', email: 'jordan@example.com', language: 'en', active: true, email_verified_at: null },
        { id: TAYLOR, name: 'Taylor', email: null, language: 'es', active: true, email_verified_at: null },
      ],
    },
    rpc: {
      roll_missed_tasks: () => 0,
      digest_due: () => [],
      email_budget_left: () => o.budget ?? 60,
      claim_notification: (a: any) => `claim-${a.p_kind}-${a.p_person}`,
      finish_notification: () => null,
      today_local: () => o.today ?? '2026-11-15',
      whoami: () => ('me' in o ? o.me : { email: 'alex@example.com', role: 'admin', person: { id: ALEX, language: 'en' } }),
      weekly_sheet: (a: any) => (o.sheetFor ? o.sheetFor(a)
        : a.p_who === null ? familySheet() : a.p_who === TAYLOR ? taylorSheet() : a.p_who === JORDAN ? jordanSheet() : null),
    } as Record<string, any>,
  };
  if (o.weeklyDue !== null) st.rpc.weekly_due = () => o.weeklyDue ?? [{ person_id: ALEX, local_date: MONDAY, kind: 'weekly' }, { person_id: SAM, local_date: MONDAY, kind: 'weekly' }];
  const sent: any[] = [];
  const deps = {
    env: (k: string) => ({ HUB_CRON_SECRET: SECRET, SITE_URL: 'https://family.example/hub/', RESEND_API_KEY: 're_test', EMAIL_FROM: 'home@family.example',
                           SUPABASE_URL: 'https://project.example', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}' } as Record<string, string>)[k],
    now: () => Date.parse('2026-11-15T21:15:00Z'),
    sleep: async () => {},
    fetch: (async (url: string, init: any) => {
      if (url === 'https://api.resend.com/emails') { sent.push({ body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] }); return new Response(`{"id":"email-${sent.length}"}`); }
      return new Response('unexpected', { status: 500 });
    }) as any,
    service: () => fakeDb('service', st),
    user: (auth: string) => fakeDb(`user:${auth}`, st),
  };
  const rpcs = (fn: string) => st.calls.filter((c: any) => c.fn === fn);
  return { deps, st, sent, rpcs };
}
const cron = () => new Request('https://project.example/functions/v1/hub-jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-cron': SECRET }, body: '{"action":"digest"}' });
const asUser = (body: unknown, auth: string | null = 'Bearer admin-jwt') => new Request('https://project.example/functions/v1/hub-jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });

(async () => {
  // The run sends one email to each person due, with every sheet.
  let s = setup();
  let res = await handle(cron(), s.deps);
  let out = await res.json();
  check('the run sends the Sunday email to each person weekly_due names', res.status === 200 && out.ok === true && out.sent === 2 && s.sent.length === 2, JSON.stringify(out));
  check('... claimed as kind weekly for the Monday', JSON.stringify(s.rpcs('claim_notification').map((c: any) => c.args))
    === JSON.stringify([{ p_person: ALEX, p_local_date: MONDAY, p_kind: 'weekly' }, { p_person: SAM, p_local_date: MONDAY, p_kind: 'weekly' }]));
  check('... finished as sent', s.rpcs('finish_notification').every((c: any) => c.args.p_status === 'sent') && s.rpcs('finish_notification').length === 2);
  check('... each sheet read with its own language and the Monday, the family\'s with no person',
    JSON.stringify(s.rpcs('weekly_sheet').slice(0, 3).map((c: any) => c.args)) === JSON.stringify([
      { p_who: null, p_monday: MONDAY, p_lang: 'en' }, { p_who: TAYLOR, p_monday: MONDAY, p_lang: 'es' }, { p_who: JORDAN, p_monday: MONDAY, p_lang: 'en' }]));
  check('... to each person\'s address, with a key for that person and week (no second email on a retry)',
    s.sent[0].body.to[0] === 'alex@example.com' && s.sent[1].body.to[0] === 'sam@example.com'
    && s.sent[0].key === `weekly-${ALEX}-${MONDAY}` && s.sent[1].key === `weekly-${SAM}-${MONDAY}`);
  check('... the email around the sheets in each recipient\'s language',
    s.sent[0].body.subject === 'Week of Nov 16 – Nov 22: Family, Taylor, Jordan' && s.sent[1].body.subject === 'Semana del 16 nov – 22 nov: Familia, Taylor, Jordan'
    && s.sent[1].body.html.includes('>Family week</h1>') && s.sent[1].body.html.includes('lista para imprimir: 3 hojas'));
  check('... after the morning emails, in the same run (one job_runs row)', s.st.tables.job_runs.length === 1 && s.rpcs('digest_due').length === 1
    && s.st.calls.findIndex((c: any) => c.fn === 'digest_due') < s.st.calls.findIndex((c: any) => c.fn === 'weekly_due'));

  s = setup({ weeklyDue: [{ person_id: JORDAN, local_date: MONDAY, kind: 'weekly' }] });
  res = await handle(cron(), s.deps);
  check('an address not confirmed (by the time it sends): skipped, nothing sent', s.sent.length === 0
    && s.rpcs('finish_notification')[0]?.args.p_status === 'skipped' && s.rpcs('finish_notification')[0]?.args.p_detail === 'The address isn\'t confirmed.');
  s = setup({ sheets: [{ who: TAYLOR, lang: 'es' }], sheetFor: () => null });
  res = await handle(cron(), s.deps);
  check('every sheet\'s person off the list: skipped ("No sheet to send."), nothing sent', s.sent.length === 0
    && s.rpcs('finish_notification').every((c: any) => c.args.p_status === 'skipped' && c.args.p_detail === 'No sheet to send.'));
  s = setup({ sheets: [{ who: 'family', lang: 'en' }, { who: TAYLOR, lang: 'es' }], sheetFor: (a) => (a.p_who === null ? familySheet() : null) });
  res = await handle(cron(), s.deps);
  check('a sheet whose person left is left out; the rest go', s.sent.length === 2 && s.sent[0].body.subject === 'Week of Nov 16 – Nov 22: Family');
  s = setup({ failRpc: { weekly_sheet: { message: 'boom' } } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('a sheet that can\'t be read: that email failed (the run says so), nothing sent', s.sent.length === 0 && out.failed === 2 && out.ok === false
    && s.rpcs('finish_notification')[0]?.args.p_detail === 'weekly_sheet: boom');
  s = setup({ budget: 0 });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('no email budget left: stops before claiming', s.sent.length === 0 && out.stop === 'budget' && s.rpcs('claim_notification').length === 0);
  s = setup({ weeklyDue: null });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('before migration 0025 (no weekly_due): the run is as it was', res.status === 200 && out.ok === true && out.sent === 0 && s.sent.length === 0);
  s = setup({ failRpc: { weekly_due: { message: 'permission denied for function weekly_due', code: '42501' } } });
  res = await handle(cron(), s.deps);
  out = await res.json();
  check('weekly_due failing for another reason stops the run as an error', res.status === 500 && out.stop === 'error' && String(out.error).startsWith('weekly_due:'));

  // weekly_preview: admins only, nothing sent or logged.
  s = setup();
  res = await handle(asUser({ action: 'weekly_preview' }, null), s.deps);
  check('weekly_preview without a sign-in → 401', res.status === 401);
  s = setup({ me: { email: 'sam@example.com', role: 'member', person: { id: SAM } } });
  res = await handle(asUser({ action: 'weekly_preview' }), s.deps);
  check('weekly_preview for a member who isn\'t an admin → 403', res.status === 403 && s.rpcs('weekly_sheet').length === 0);
  s = setup();
  res = await handle(asUser({ action: 'weekly_preview', week: 'last' }), s.deps);
  check('weekly_preview with a week other than this or next → 400', res.status === 400);
  s = setup();
  res = await handle(asUser({ action: 'weekly_preview' }), s.deps);
  out = await res.json();
  check('weekly_preview on a Sunday: next week is the one Sunday\'s email covers (tomorrow)', res.status === 200 && out.monday === MONDAY && out.sunday === '2026-11-22' && out.sheets === 3, JSON.stringify(out).slice(0, 200));
  check('... the email as it would go, in the admin\'s language', out.subject === 'Week of Nov 16 – Nov 22: Family, Taylor, Jordan' && out.html.includes('Semana de Taylor') && out.text.includes('Family week'));
  check('... who it goes to, and why someone wouldn\'t get it', JSON.stringify(out.to) === JSON.stringify([
    { person_id: ALEX, name: 'Alex', would_send: true, reason: null }, { person_id: SAM, name: 'Sam', would_send: true, reason: null },
    { person_id: JORDAN, name: 'Jordan', would_send: false, reason: 'unconfirmed' }]) && out.at === '16:00:00', JSON.stringify(out.to));
  check('... nothing sent, claimed or logged', s.sent.length === 0 && s.rpcs('claim_notification').length === 0 && s.st.ops.every((o: any) => o.op === 'select'));
  s = setup({ today: '2026-11-18' });
  res = await handle(asUser({ action: 'weekly_preview', week: 'this' }), s.deps);
  out = await res.json();
  check('weekly_preview this week on a Wednesday: from that Monday', out.monday === MONDAY && s.rpcs('weekly_sheet')[0].args.p_monday === MONDAY);
  s = setup({ today: '2026-11-18' });
  res = await handle(asUser({ action: 'weekly_preview' }), s.deps);
  out = await res.json();
  check('weekly_preview next week on a Wednesday: the Monday after', out.monday === '2026-11-23');
  s = setup();
  res = await handle(asUser({ action: 'weekly_preview', sheets: [{ who: TAYLOR, lang: 'en' }, { who: 'nobody', lang: 'en' }] }), s.deps);
  out = await res.json();
  check('weekly_preview with sheets given (not yet saved): those, checked', out.sheets === 1
    && JSON.stringify(s.rpcs('weekly_sheet').map((c: any) => c.args)) === JSON.stringify([{ p_who: TAYLOR, p_monday: MONDAY, p_lang: 'en' }]));
  s = setup();
  res = await handle(asUser({ action: 'weekly_preview', sheets: 'family' }), s.deps);
  check('weekly_preview with sheets that aren\'t a list → 400', res.status === 400);
  s = setup({ failRpc: { weekly_sheet: { message: 'Could not find the function public.weekly_sheet', code: 'PGRST202' } } });
  res = await handle(asUser({ action: 'weekly_preview' }), s.deps);
  out = await res.json();
  check('weekly_preview before migration 0025 → 503 no_schema', res.status === 503 && out.stop === 'no_schema');

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
