// Browser tests for assets/shoplist.js (window.HomeShop), the shopping list's shared pieces
// (docs/v1.2-kitchen.md §4.4 and §8): the ten aisles in store order with their English and Spanish
// names, grouping and A–Z order, the "other" word, how an add is read ("2 lb ground beef"), what an
// answer means, the hold that keeps rows from moving under a finger, and the outbox: taps show at once
// and go one at a time, a tick and its Undo cancel only while the tick never left the phone, no answer
// keeps everything ("not sent yet", retries at 2, 5, 10 and 30 seconds, the banner after 15), the queue
// and the list saved for their owner only, refusals, a link that no longer works, "changed on another
// phone", changes older than 24 hours; a change answered after its page closed (taken off the saved
// queue by id, never sent again, its answer taken by a page opened since); a resend's "no change" (an
// un-tick's is this phone's own, a tick's only when the line is bought by this phone); an Undo by id
// only of this phone's own purchase; rows a waiting change moved have no seen of their own; a tick of a
// line a waiting add brings back waits for that add.
// Part 1 runs in day.html (which loads shoplist.js before day.js; day.js and supabase-js are stubbed
// out) with a fake send() in the page and the page's clock paused, so every timer runs when the test
// says. Part 2 runs the outbox in the hub on a schema-4 database, through supabase-js and mock.js's
// fakes of shopping_list, add_to_list and buy_item, so the shapes on both sides fit.
// Run alone with: node tests/e2e/shoplist.test.js
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { makeDb, install, signIn, withFood, foodRpc } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TOKEN = '0123456789abcdef0123456789abcdef';
const START = new Date('2026-10-27T13:42:00Z');

// In the page: a stand-in for the list functions (the Food page's shapes; { items } for My day's),
// with the rules of §4.2 for a tick (it changes a row only in the state the phone saw), and a send()
// whose answers the test controls: mode 'ok', 'down' (no answer), '503', 'refuse' (P0001), 'null'
// (a token function's null), 'lost' (applied, then the answer is lost); gate holds the answers.
function pageFake() {
  let n = 0;
  const stamp = (p) => `2026-10-27T13:${String(42 + Math.floor(n / 60)).padStart(2, '0')}:${String(n++ % 60).padStart(2, '0')}.12345${n % 10}+00:00`;
  window.settle = async () => { for (let i = 0; i < 200; i++) await null; };
  window.fakeList = (rows, opts) => {
    const o = opts || {};
    const f = { rows: rows.map((r) => Object.assign({ note: null, aisle: 'other', private: false, bought_at: null, bought_by: null }, r)), sent: [], mode: 'ok', gate: null, myDay: !!o.myDay, me: o.me || 'p-alex' };
    f.snapshot = () => {
      const open = f.rows.filter((r) => !r.bought_at).sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
      const bought = f.rows.filter((r) => r.bought_at).sort((a, b) => (a.bought_at < b.bought_at ? 1 : -1));
      return f.myDay
        ? { language: 'es', as_of: '2026-10-27T09:42', can_add: true,
          items: open.map((r) => ({ id: r.id, name: r.name, note: r.note, aisle: r.aisle, seen: r.added_at })),
          bought: bought.map((r) => ({ id: r.id, name: r.name, note: r.note, aisle: r.aisle, seen: r.bought_at, undo: r.bought_by === f.me })),
          suggest: (o.suggest || []).filter((s) => !open.some((r) => r.name.toLowerCase() === s.name.toLowerCase())) }
        : { as_of: '2026-10-27T09:42',
          to_buy: open.map((r) => ({ id: r.id, name: r.name, note: r.note, aisle: r.aisle, private: r.private, added_by: r.added_by || null, seen: r.added_at })),
          bought: bought.map((r) => ({ id: r.id, name: r.name, note: r.note, aisle: r.aisle, private: r.private, bought_by: r.bought_by, seen: r.bought_at })) };
    };
    f.apply = (op) => {
      if (op.op === 'add') {
        const name = HomeShop.parse(op.name).name;
        let r = f.rows.find((x) => x.name.toLowerCase() === name.toLowerCase());
        let result = 'already';
        if (!r) { f.rows.push(r = { id: `i-${f.rows.length + 1}`, name, added_at: stamp(), added_by: f.me }); result = 'added'; }
        else if (r.bought_at) { Object.assign(r, { bought_at: null, bought_by: null, added_at: stamp(), added_by: f.me }); result = 'back'; }
        return Object.assign({ result, item_id: r.id, name: r.name }, f.snapshot());
      }
      const r = f.rows.find((x) => x.id === op.item);
      let changed = false;
      if (r && op.op === 'buy' && !r.bought_at && r.added_at === op.seen) { Object.assign(r, { bought_at: stamp(), bought_by: f.me }); changed = true; }
      if (r && op.op === 'unbuy' && r.bought_at && r.bought_at === op.seen) { Object.assign(r, { bought_at: null, bought_by: null }); changed = true; }
      return Object.assign({ changed }, f.snapshot());
    };
    f.send = async (op) => {
      f.sent.push(JSON.parse(JSON.stringify(op)));
      if (f.gate) await f.gate;
      if (f.mode === 'down') return { data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }, status: 0 };
      if (f.mode === '503') return { data: null, error: { message: 'Service Unavailable', code: '' }, status: 503 };
      if (f.mode === 'refuse') return { data: null, error: { message: 'Too many ticks from My day today.', code: 'P0001' }, status: 400 };
      if (f.mode === 'null') return { data: null, error: null, status: 200 };
      const reply = f.apply(op);
      if (f.mode === 'lost') { f.mode = 'ok'; throw new TypeError('Failed to fetch'); }
      return { data: reply, error: null, status: 200 };
    };
    f.hold = () => { let open; f.gate = new Promise((r) => { open = r; }); return () => { f.gate = null; open(); }; };
    return f;
  };
  // An outbox with every callback recorded in ev.
  window.makeBox = (f, extra) => {
    const ev = [];
    const box = HomeShop.outbox(Object.assign({
      key: HomeShop.KEYS.hub, owner: 'p-alex', who: 'p-alex', send: f.send, mine: (r) => r.bought_by === 'p-alex',
      onChange: () => ev.push('change'), onReply: (op, r, how) => ev.push(`${op.op}:${how}`), onRefused: (op, e) => ev.push(`refused:${op.op}:${e.code}`),
      onGone: () => ev.push('gone'), onExpired: (k) => ev.push(`expired:${k}`),
    }, extra));
    return { box, ev, replies: () => ev.filter((e) => e !== 'change') };
  };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];

  // =====================================================================
  // Part 1: in day.html, with the page's clock paused
  // =====================================================================
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`part 1: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`part 1 console: ${m.text()}`); });
  await page.route('**/config.js*', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.HOME_HUB_CONFIG = {};' }));
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/assets/day.js*', (r) => r.fulfill({ contentType: 'application/javascript', body: '// not under test' }));
  await page.clock.install({ time: START });
  await page.goto(`${BASE}/day.html?t=${TOKEN}`);
  await page.clock.pauseAt(new Date(START.getTime() + 1000));
  await page.evaluate(pageFake);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const tick = async (ms) => { await page.clock.runFor(ms); await ev(() => window.settle()); };

  // ---- 1. Aisles, names, groups
  const basics = await ev(() => {
    const S = window.HomeShop;
    return {
      loaded: typeof S, frozen: Object.isFrozen(S),
      aisles: S.AISLES.map((a) => [a.key, a.en, a.es]),
      names: [S.aisleName('dairy', 'en'), S.aisleName('dairy', 'es'), S.aisleName('nonsense', 'es'), S.aisleName(null, 'en')],
      groups: S.groups([
        { id: 'b', name: 'milk', aisle: 'dairy' }, { id: 'c', name: 'Zucchini', aisle: 'produce' }, { id: 'a', name: 'apples', aisle: 'produce' },
        { id: 'd', name: 'Mystery', aisle: 'gone' }, { id: 'e', name: 'Ice', aisle: 'frozen' }, { id: 'f', name: 'Apples', aisle: 'produce' }, { id: null, name: 'apples', aisle: 'produce' },
      ], 'es').map((g) => [g.key, g.name, g.rows.map((r) => `${r.name}/${r.id}`)]),
      keys: [S.nameKey(' Milk  '), S.nameKey('MILK'), S.fold('Limón'), S.fold(' Plátanos ')],
      other: [S.withOther({ name: 'Leche', other: 'milk' }), S.withOther({ name: 'Milk' }), S.withOther({ name: 'Tortillas', other: 'tortillas' }), S.withOther({ name: 'Café', other: 'cafe' })],
      matches: [
        S.matches([{ name: 'Almond milk' }, { name: 'Leche', other: 'milk' }, { name: 'Milk' }, { name: 'Limón' }, { name: 'Bread' }], 'mil').map((r) => r.name),
        S.matches([{ name: 'Limón' }], 'LIMON').map((r) => r.name), S.matches([{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }, { name: 'a4' }, { name: 'a5' }, { name: 'a6' }], 'a').length,
        S.matches([{ name: 'Milk' }], '  ').length],
      same: [S.sameList({ as_of: '09:42', to_buy: [1] }, { as_of: '09:52', to_buy: [1] }), S.sameList({ as_of: '1', to_buy: [1] }, { as_of: '1', to_buy: [2] })],
      constants: [S.POLL_MS, S.HOLD_MS, S.RETRY_MS, S.BANNER_MS, S.EXPIRE_MS, S.KEYS],
      clean: S.clean('  two\u0007 lines\u2028and\u200b\u202e bidi\u00a0 ', 100),
    };
  });
  check('shoplist.js loads in day.html as window.HomeShop, frozen', basics.loaded === 'object' && basics.frozen);
  check('the ten aisles in store order, cold things last, with their English and Spanish names (§4.4)', same(basics.aisles, [
    ['produce', 'Produce', 'Frutas y verduras'], ['bakery', 'Bakery', 'Panadería'], ['pantry', 'Pantry', 'Despensa'], ['drinks', 'Drinks', 'Bebidas'],
    ['household', 'Household', 'Limpieza y hogar'], ['personal', 'Personal care', 'Cuidado personal'], ['meat', 'Meat & fish', 'Carne y pescado'],
    ['dairy', 'Dairy & eggs', 'Lácteos y huevos'], ['frozen', 'Frozen', 'Congelados'], ['other', 'Other', 'Otros']]), JSON.stringify(basics.aisles));
  check('aisleName: by language; an unknown aisle is Other', same(basics.names, ['Dairy & eggs', 'Lácteos y huevos', 'Otros', 'Other']), JSON.stringify(basics.names));
  check('groups: store order, A–Z inside each (name, then id; a row not saved yet last), unknown aisles under Other, empty aisles left out',
    same(basics.groups, [['produce', 'Frutas y verduras', ['apples/a', 'Apples/f', 'apples/null', 'Zucchini/c']], ['dairy', 'Lácteos y huevos', ['milk/b']],
      ['frozen', 'Congelados', ['Ice/e']], ['other', 'Otros', ['Mystery/d']]]), JSON.stringify(basics.groups));
  check('nameKey and fold: one item whatever the case and spaces; fold also drops accents', same(basics.keys, ['milk', 'milk', 'limon', 'platanos']), JSON.stringify(basics.keys));
  check('withOther: "Leche · milk"; just the name when there is no other word, or it is the same word', same(basics.other, ['Leche · milk', 'Milk', 'Tortillas', 'Café']), JSON.stringify(basics.other));
  check('matches: names (and other words) with what was typed, those starting with it first, accents ignored, 5 at most',
    same(basics.matches, [['Leche', 'Milk', 'Almond milk'], ['Limón'], 5, 0]), JSON.stringify(basics.matches));
  check('sameList ignores as_of only', same(basics.same, [true, false]));
  check('the timings: poll 10s, hold 3s, retries 2/5/10/30s, banner after 15s, 24 hours; the two storage keys',
    same(basics.constants, [10000, 3000, [2000, 5000, 10000, 30000], 15000, 86400000, { hub: 'homehub.shop.hub', day: 'homehub.shop.day' }]), JSON.stringify(basics.constants));
  check('clean: as private.clean_text (control characters to spaces, bidi and zero-width out, one line)', basics.clean === 'two lines and bidi', JSON.stringify(basics.clean));

  // ---- 2. How an add is read (§4.1)
  const parsed = await ev(() => ['2 milk', '2x milk', '2 x milk', '12 huevos', '2 lb ground beef', '1 dozen eggs', '3 cans of black beans', '2 bolsas de arroz',
    '2% milk', '7up', '7 Up', 'Milk: 2 gallons', '  Milk  ', '1234 things', ':', 'x'.repeat(70), '2 LBS of flour'].map((t) => {
    const p = window.HomeShop.parse(t);
    return [p.name, p.note];
  }));
  check('parse: the amount table of §4.1, row by row', same(parsed.slice(0, 11), [['milk', '2'], ['milk', '2'], ['milk', '2'], ['huevos', '12'], ['ground beef', '2 lb'], ['eggs', '1 dozen'],
    ['black beans', '3 cans'], ['arroz', '2 bolsas'], ['2% milk', null], ['7up', null], ['7 Up', null]]), JSON.stringify(parsed.slice(0, 11)));
  check('parse: "Milk: 2 gallons" puts the rest in the note; names trimmed, cut to 60; 4 digits are not an amount; ":" alone has no name',
    same(parsed.slice(11), [['Milk', '2 gallons'], ['Milk', null], ['1234 things', null], ['', null], ['x'.repeat(60), null], ['flour', '2 LBS']]), JSON.stringify(parsed.slice(11)));

  // ---- 3. What an answer means (§8.4)
  const answers = await ev(() => {
    const a = window.HomeShop.answer;
    const err = (code, status) => a({ data: null, error: { message: 'x', code }, status });
    return {
      ok: a({ data: { changed: true }, error: null, status: 200 }), gone: a({ data: null, error: null, status: 200 }),
      refused: [err('42501', 403), err('42501', 401), err('22023', 400), err('P0001', 400), err('54000', 413), err('23505', 409), err('PGRST116', 406), err('PGRST301', 401), err('23514', 400)],
      retry: [err('', 0), err(undefined, 0), err('', 503), err('', 502), err('XX000', 500), err('', 408), err('', 429), a({ data: null, error: new TypeError('Failed to fetch') })],
    };
  });
  check('answer: success, and null (a link that no longer works)', answers.ok === 'ok' && answers.gone === 'gone', JSON.stringify(answers));
  check('answer: database and PostgREST codes are refusals (42501, 22023, P0001, 54000, 23505, PGRST…), and any other 4xx', answers.refused.every((x) => x === 'refused'), JSON.stringify(answers.refused));
  check('answer: no answer, a 5xx, 408 or 429 is tried again', answers.retry.every((x) => x === 'retry'), JSON.stringify(answers.retry));

  // ---- 4. tokenOwner: the first 16 hex characters of the token's SHA-256, never the token
  const owner = await ev((t) => window.HomeShop.tokenOwner(t), TOKEN);
  check('tokenOwner: the first 16 hex characters of SHA-256(token)', owner === crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0, 16), owner);

  // ---- 5. hold(): no row moves under a finger
  await ev(() => { window.ran = 0; window.h = window.HomeShop.hold(3000, () => { window.ran++; }); window.h.request(); });
  check('hold: with no tap, a redraw runs at once', (await ev(() => window.ran)) === 1);
  await ev(() => { window.h.touch(); window.h.request(); window.h.request(); });
  await tick(1000);
  await ev(() => window.h.touch());
  await tick(2900);
  const held = await ev(() => [window.ran, window.h.held()]);
  await tick(200);
  check('hold: a redraw waits until 3 seconds after the last tap, and runs once', same(held, [1, true]) && (await ev(() => [window.ran, window.h.held()])).join() === '2,false', JSON.stringify(held));

  // ---- 6. Taps show at once and go one at a time; an Undo after the tick left the phone is sent after it
  let out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', aisle: 'dairy', added_at: '2026-10-27T13:00:00.111111+00:00' }, { id: 'e', name: 'Eggs', aisle: 'dairy', added_at: '2026-10-27T13:00:01.222222+00:00' }]);
    const { box, replies } = window.makeBox(f);
    const empty = box.view();
    box.take(f.snapshot(), box.ticket());
    const open = f.hold();
    const milk = box.view().to_buy.find((r) => r.id === 'm');
    box.buy(milk);
    const shown = box.view();
    const st1 = box.state();
    const undo = box.unbuy('m');
    const st2 = box.state();
    open();
    await window.settle();
    window.f6 = f;
    return { empty, shown: { toBuy: shown.to_buy.map((r) => r.name), bought: shown.bought.map((r) => [r.name, r.pending, r.unsent, r.bought_by]) }, st1, undo, st2,
      sent: f.sent, replies: replies(), after: box.view(), st3: box.state(), saved: JSON.parse(localStorage.getItem('homehub.shop.hub')) };
  });
  check('view() is null before any list', out.empty === null);
  check('a tick shows at once, before any answer: the row moves to bought, marked pending (not "not sent yet"), with the buyer',
    same(out.shown, { toBuy: ['Eggs'], bought: [['Milk', true, false, 'p-alex']] }) && out.st1.busy && out.st1.waiting === 1, JSON.stringify([out.shown, out.st1]));
  check('Undo once the tick has left the phone: queued behind it, not cancelled', out.undo === true && out.st2.waiting === 2, JSON.stringify(out.st2));
  check('both are sent, in order; the Undo carries the seen from the tick\'s reply (bought_at, microseconds kept)',
    out.sent.length === 2 && same(out.sent[0], { op: 'buy', item: 'm', seen: '2026-10-27T13:00:00.111111+00:00' }) && out.sent[1].op === 'unbuy'
    && /^2026-10-27T13:42:\d\d\.\d{6}\+00:00$/.test(out.sent[1].seen) && same(out.replies, ['buy:done', 'unbuy:done']), JSON.stringify([out.sent, out.replies]));
  check('after the answers: Milk is to buy again, nothing waits, the list and an empty queue are saved for their owner',
    same(out.after.to_buy.map((r) => r.name), ['Eggs', 'Milk']) && !out.after.to_buy.some((r) => r.pending) && out.st3.waiting === 0 && !out.st3.busy
    && out.saved.owner === 'p-alex' && same(out.saved.queue, []) && out.saved.snap.to_buy.length === 2, JSON.stringify(out.saved).slice(0, 200));

  // ---- 7. A tick and its Undo cancel out while the tick never left the phone
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: '2026-10-27T13:00:01.222222+00:00' }]);
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    const open = f.hold();
    box.add('Bread');                         // on its way
    box.buy(box.view().to_buy.find((r) => r.id === 'e'));   // waits behind it: never left the phone
    const mid = box.view();
    box.unbuy('e');
    const st = box.state();
    const twice = box.buy('nope');
    open();
    await window.settle();
    return { mid: mid.bought.map((r) => r.name), st, twice, sent: f.sent, replies: replies(), eggs: f.rows.find((r) => r.id === 'e').bought_at, after: box.view().to_buy.map((r) => [r.name, r.id]) };
  });
  check('a tick waiting behind another change shows at once', same(out.mid, ['Eggs']), JSON.stringify(out.mid));
  check('Undo before the tick left the phone: the two cancel out, nothing is sent for them', out.st.waiting === 1 && same(out.sent, [{ op: 'add', name: 'Bread', private: false }])
    && out.eggs === null && same(out.replies, ['add:added']), JSON.stringify([out.st, out.sent, out.replies]));
  check('a tick of a row the list doesn\'t have does nothing', out.twice === false);
  check('the add is answered: Bread is on the list with its id', same(out.after, [['Bread', 'i-2'], ['Eggs', 'e']]), JSON.stringify(out.after));

  // ---- 8. No answer: kept, "not sent yet", retried at 2, 5, 10 and 30 seconds, the banner after 15
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: '2026-10-27T13:00:01.222222+00:00' }, { id: 'b', name: 'Bread', aisle: 'bakery', added_at: '2026-10-27T13:00:02.333333+00:00' }]);
    window.f8 = f;
    window.b8 = window.makeBox(f);
    const { box } = window.b8;
    box.take(f.snapshot(), box.ticket());
    f.mode = 'down';
    box.buy(box.view().to_buy.find((r) => r.id === 'e'));
    await window.settle();
    box.add('2 milk');
    await window.settle();
    const v = box.view();
    return { sent: f.sent.length, st: box.state(), rows: v.to_buy.map((r) => [r.name, r.note, r.id, r.pending, r.unsent]), bought: v.bought.map((r) => [r.name, r.unsent]) };
  });
  check('no answer: the change stays, its row marked "not sent yet" (unsent), no banner yet', out.st.waiting === 2 && out.st.unsent === 2 && out.st.banner === 0 && !out.st.busy
    && same(out.bought, [['Eggs', true]]), JSON.stringify([out.st, out.bought]));
  check('an add not sent yet shows as a row with no id (no box), read as the database will ("2 milk": milk, note 2)',
    same(out.rows, [['Bread', null, 'b', undefined, undefined], ['milk', '2', null, true, true]]) || same(out.rows.map((r) => r.slice(0, 3)), [['Bread', null, 'b'], ['milk', '2', null]]), JSON.stringify(out.rows));
  const sentAt = [];
  const stamps = [1999, 1, 4999, 1, 9999, 1, 29999, 1, 30000];
  let banner = null;
  for (const ms of stamps) {
    await tick(ms);
    sentAt.push(await ev(() => window.f8.sent.length));
    if (banner === null && (await ev(() => window.b8.box.state().banner))) banner = sentAt.length;
  }
  // Sent so far: the tick, once (no answer). The add, tapped while nothing gets through, waits its turn.
  check('retries come 2, 5, 10 and 30 seconds after, then every 30 seconds; a tap meanwhile waits its turn', same(sentAt, [1, 2, 2, 3, 3, 4, 4, 5, 6]), JSON.stringify(sentAt));
  check('the banner shows once the oldest change has waited 15 seconds, with how many', banner === 5 && (await ev(() => window.b8.box.state().banner)) === 2, `${banner}`);
  out = await ev(async () => {
    const { box } = window.b8;
    const sent = window.f8.sent.length;
    box.buy(box.view().to_buy.find((r) => r.id === 'b'));
    const mid = box.state().waiting;
    box.unbuy('b');
    await window.settle();
    return { mid, st: box.state(), sent: window.f8.sent.length - sent, bread: box.view().to_buy.map((r) => r.name) };
  });
  check('while nothing gets through, a new tick waits its turn (never sent), so its Undo cancels it', out.mid === 3 && out.st.waiting === 2 && out.sent === 0
    && out.bread.includes('Bread'), JSON.stringify(out));
  const saved8 = await ev(() => JSON.parse(localStorage.getItem('homehub.shop.hub')));
  check('the queue is saved with the list, for its owner', saved8.owner === 'p-alex' && same(saved8.queue.map((x) => [x.op, x.item || x.name, x.sent]), [['buy', 'e', true], ['add', '2 milk', false]]), JSON.stringify(saved8.queue));
  // A reload: another outbox for the same owner finds the queue, marked not sent yet; nothing goes before kick().
  out = await ev(async () => {
    window.b8.box.stop();
    window.f8.mode = 'ok';
    window.f8.sent.length = 0;
    const again = window.makeBox(window.f8);
    window.b8b = again;
    await window.settle();
    const before = { st: again.box.state(), sent: window.f8.sent.length, rows: again.box.view().bought.map((r) => [r.name, r.unsent]), add: again.box.view().to_buy.filter((r) => r.id === null).map((r) => r.name) };
    again.box.kick();
    await window.settle();
    return { before, sent: window.f8.sent, st: again.box.state(), replies: again.replies(), stored: JSON.parse(localStorage.getItem('homehub.shop.hub')).queue };
  });
  check('a reload keeps the queue: shown "not sent yet" (with the banner, it has waited), and sent only once kick() says the page is ready',
    out.before.st.waiting === 2 && out.before.st.unsent === 2 && out.before.st.banner === 2 && !out.before.st.fresh && out.before.sent === 0
    && same(out.before.rows, [['Eggs', true]]) && same(out.before.add, ['milk']), JSON.stringify(out.before));
  check('kick(): the waiting changes go once each, in order, and the queue empties', same(out.sent.map((x) => x.op), ['buy', 'add']) && out.st.waiting === 0 && out.st.unsent === 0
    && same(out.replies, ['buy:done', 'add:added']) && same(out.stored, []), JSON.stringify([out.sent, out.replies]));
  // Saved for someone else, or for nobody: removed unread, nothing saved
  out = await ev(async () => {
    const f = window.fakeList([{ id: 'e', name: 'Eggs', added_at: 'A' }]);
    const other = window.makeBox(f, { owner: 'p-sam' });
    const gone = localStorage.getItem('homehub.shop.hub');
    other.box.take(f.snapshot(), other.box.ticket());
    const mine = JSON.parse(localStorage.getItem('homehub.shop.hub')).owner;
    const nobody = window.makeBox(f, { owner: null });
    const removed = localStorage.getItem('homehub.shop.hub');
    nobody.box.take(f.snapshot(), nobody.box.ticket());
    return { view: other.box.view() && other.box.view().to_buy.length, gone, mine, removed, after: localStorage.getItem('homehub.shop.hub'), nobodyView: !!nobody.box.view() };
  });
  check('a list saved for another person is removed unread', out.gone === null && out.view === 1 && out.mine === 'p-sam', JSON.stringify(out));
  check('with no owner (no person, no crypto.subtle) nothing is read or saved, and the page still works', out.removed === null && out.after === null && out.nobodyView, JSON.stringify(out));

  // ---- 9. A 503 is retried; a refusal is dropped (the next change still goes); null means the link no longer works
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', added_at: 'A1' }, { id: 'b', name: 'Bread', added_at: 'A2' }]);
    window.f9 = f;
    window.b9 = window.makeBox(f, { key: 'homehub.shop.day', owner: 'abcdef0123456789' });
    const { box } = window.b9;
    box.take(f.snapshot(), box.ticket());
    f.mode = '503';
    box.buy(box.view().to_buy.find((r) => r.id === 'e'));
    await window.settle();
    return { st: box.state(), sent: f.sent.length };
  });
  check('a 503 keeps the change, "not sent yet"', out.st.waiting === 1 && out.st.unsent === 1 && out.sent === 1, JSON.stringify(out));
  await ev(() => { window.f9.mode = 'ok'; });
  await tick(2000);
  out = await ev(() => ({ st: window.b9.box.state(), sent: window.f9.sent.length, replies: window.b9.replies() }));
  check('… and goes through on the retry 2 seconds later', out.st.waiting === 0 && out.sent === 2 && same(out.replies, ['buy:done']), JSON.stringify(out));
  out = await ev(async () => {
    const { box } = window.b9;
    const f = window.f9;
    f.mode = 'refuse';
    const open = f.hold();
    box.buy(box.view().to_buy.find((r) => r.id === 'b'));
    box.add('Juice');
    open();
    await window.settle();
    const first = { st: box.state(), replies: window.b9.replies(), sent: f.sent.slice(2).map((x) => x.op) };
    return first;
  });
  check('a refusal (P0001): that change is dropped with one onRefused, and the next change is still sent', same(out.replies.slice(1), ['refused:buy:P0001', 'refused:add:P0001'])
    && same(out.sent, ['buy', 'add']) && out.st.waiting === 0 && out.st.unsent === 0, JSON.stringify(out));
  out = await ev(async () => {
    const { box } = window.b9;
    const f = window.f9;
    f.mode = 'null';
    const had = localStorage.getItem('homehub.shop.day') !== null;
    box.add('Juice');
    await window.settle();
    return { had, after: localStorage.getItem('homehub.shop.day'), view: box.view(), st: box.state(), replies: window.b9.replies().slice(-1) };
  });
  check('null from a token function: the queue and the saved list are cleared, and onGone says the link no longer works',
    out.had && out.after === null && out.view === null && out.st.waiting === 0 && same(out.replies, ['gone']), JSON.stringify(out));

  // ---- 10. changed: false: the same already (say nothing), or changed on another phone
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1' }, { id: 'e', name: 'Eggs', added_at: 'A2' }, { id: 'j', name: 'Juice', added_at: 'A3' }, { id: 'r', name: 'Rice', added_at: 'A4' }]);
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    const shown = box.view().to_buy;
    // Someone else bought Milk; someone bought Eggs and put them back (a new need) since this phone looked.
    Object.assign(f.rows[0], { bought_at: 'B-sam', bought_by: 'p-sam' });
    Object.assign(f.rows[1], { added_at: 'A2-again' });
    box.buy(shown.find((r) => r.id === 'm'));
    await window.settle();
    box.buy(shown.find((r) => r.id === 'e'));
    await window.settle();
    const eggsStill = f.rows[1].bought_at;
    // Juice: the tick is applied but its answer is lost; Undo is pressed meanwhile; the resend finds it bought by me.
    f.mode = 'lost';
    box.buy(shown.find((r) => r.id === 'j'));
    box.unbuy('j');
    await window.settle();
    box.kick();
    await window.settle();
    const juice = f.rows[2].bought_at;
    // Rice: someone else buys it while this phone's tick is unanswered: the queued Undo can't undo their purchase.
    const open = f.hold();
    box.buy(shown.find((r) => r.id === 'r'));
    box.unbuy('r');
    Object.assign(f.rows[3], { bought_at: 'B-sam2', bought_by: 'p-sam' });
    open();
    await window.settle();
    return { replies: replies(), eggsStill, juice, rice: [f.rows[3].bought_at, f.rows[3].bought_by], sent: f.sent.map((x) => `${x.op}:${x.item}`) };
  });
  check('a tick someone else already did answers changed: false, and it is the same as asked: nothing to say', out.replies[0] === 'buy:same', JSON.stringify(out.replies));
  check('a tick from before someone put the line back buys nothing new: "changed on another phone"', out.replies[1] === 'buy:changed' && out.eggsStill === null, JSON.stringify(out.replies));
  check('a lost answer: the tick is sent again (changed: false, but bought by me), and the Undo queued behind it still undoes it',
    same(out.replies.slice(2, 4), ['buy:same', 'unbuy:done']) && out.juice === null, JSON.stringify(out));
  check('an Undo queued behind a tick that someone else beat is dropped, never undoing their purchase: "changed on another phone"',
    out.replies[4] === 'buy:changed' && same(out.rice, ['B-sam2', 'p-sam']) && !out.sent.includes('unbuy:r'), JSON.stringify(out));

  // ---- 11. take() and ticket(): a read that started before a write was answered is older than it
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1' }]);
    const { box } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    const t = box.ticket();
    const old = f.snapshot();
    box.buy(box.view().to_buy[0]);
    await window.settle();
    const taken = box.take(old, t);
    const fresh = box.take(f.snapshot(), box.ticket());
    return { taken, fresh, bought: box.view().bought.map((r) => r.name), bad: box.take(null) };
  });
  check('take(): a read from before a write\'s answer is ignored; a newer one is taken', out.taken === false && out.fresh === true && same(out.bought, ['Milk']) && out.bad === false, JSON.stringify(out));

  // ---- 12. Changes older than 24 hours are dropped, with one onExpired
  out = await ev(async () => {
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1' }]);
    const day = 24 * 60 * 60 * 1000;
    localStorage.setItem('homehub.shop.hub', JSON.stringify({ v: 1, owner: 'p-alex', snap: f.snapshot(), queue: [
      { id: 'x1', op: 'buy', item: 'm', seen: 'A1', at: Date.now() - day - 60000, sent: false },
      { id: 'x2', op: 'add', name: 'Old', private: false, at: Date.now() - day - 1000, sent: true },
      { id: 'x3', op: 'add', name: 'Eggs', private: false, at: Date.now() - 1000, sent: false }] }));
    const { box, replies } = window.makeBox(f);
    box.kick();
    await window.settle();
    return { replies: replies(), sent: f.sent.map((x) => x.name || x.item) };
  });
  check('changes older than 24 hours are dropped with one onExpired (here 2), and the rest are sent', same(out.replies, ['expired:2', 'add:added']) && same(out.sent, ['Eggs']), JSON.stringify(out));

  // ---- 13. My day's shape: items, undo, suggest; an add of a suggested name
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'c', name: 'Cebollas', aisle: 'produce', added_at: 'A1' }, { id: 'h', name: 'Huevos', aisle: 'dairy', added_at: 'A0', bought_at: '2026-10-27T13:30:00.5+00:00', bought_by: 'p-sam' }],
      { myDay: true, me: 'p-taylor', suggest: [{ name: 'Cilantro' }, { name: 'Tortillas' }] });
    const { box, replies } = window.makeBox(f, { key: 'homehub.shop.day', owner: 'abcdef0123456789', who: undefined, mine: (r) => !!r.undo });
    box.take(f.snapshot(), box.ticket());
    const open = f.hold();
    box.buy(box.view().items[0]);
    box.add('cilantro');
    const v = box.view();
    open();
    await window.settle();
    const after = box.view();
    box.unbuy('c');
    await window.settle();
    return { lang: v.language, pending: v.bought.map((r) => [r.name, r.undo, r.pending]), items: v.items.map((r) => [r.name, r.id]), suggest: v.suggest.map((s) => s.name),
      after: { bought: after.bought.map((r) => [r.name, r.undo]), suggest: after.suggest.map((s) => s.name) }, replies: replies(), sent: f.sent };
  });
  check('My day: a tick shows at once as her own (undo), an add of a suggested name leaves Comprar otra vez and shows with no id',
    out.lang === 'es' && same(out.pending, [['Cebollas', true, true], ['Huevos', false, undefined]]) && same(out.items, [['cilantro', null]]) && same(out.suggest, ['Tortillas']), JSON.stringify(out));
  check('My day: after the answers, her tick is undoable and Undo by id takes its seen from the reply', same(out.after.bought.slice(0, 1), [['Cebollas', true]])
    && same(out.replies, ['buy:done', 'add:added', 'unbuy:done']) && out.sent[2].op === 'unbuy' && out.sent[2].seen !== 'A1' && !!out.sent[2].seen, JSON.stringify(out));

  // ---- 14. Hidden: the timers wait; kick() (visibilitychange, focus, online) sends at once; stop() ends it
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1' }]);
    window.f14 = f;
    window.hidden14 = true;
    window.b14 = window.makeBox(f, { visible: () => !window.hidden14 });
    window.b14.box.take(f.snapshot(), window.b14.box.ticket());
    f.mode = 'down';
    window.b14.box.buy(window.b14.box.view().to_buy[0]);
    await window.settle();
    return f.sent.length;
  });
  await tick(65000);
  const hiddenSent = await ev(() => window.f14.sent.length);
  out = await ev(async () => {
    window.f14.mode = 'ok';
    window.hidden14 = false;
    window.b14.box.kick();
    await window.settle();
    return { sent: window.f14.sent.length, st: window.b14.box.state() };
  });
  check('while the page is hidden the retries wait; kick() sends at once', hiddenSent === 1 && out.sent === 2 && out.st.waiting === 0, `${hiddenSent} ${JSON.stringify(out)}`);
  out = await ev(async () => {
    const { box } = window.b14;
    box.stop();
    const sentBefore = window.f14.sent.length;
    const r = [box.add('Bread'), box.buy('m')];
    box.kick();
    await window.settle();
    return { r, sent: window.f14.sent.length - sentBefore };
  });
  check('stop(): nothing more is queued or sent', same(out.r, [false, false]) && out.sent === 0, JSON.stringify(out));

  // ---- 15. A change still on its way when the page closes, answered anyway: never sent again
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: 'A1' }]);
    const a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    const open = f.hold();
    a.box.add('Milk');
    a.box.stop();                       // Alex taps Today while the add is on its way
    open();
    await window.settle();              // its answer comes anyway: Milk is on the list
    const stored = JSON.parse(localStorage.getItem('homehub.shop.hub')).queue;
    Object.assign(f.rows.find((r) => r.name === 'Milk'), { bought_at: 'B-sam', bought_by: 'p-sam' });   // Sam buys it
    const b = window.makeBox(f);        // Food again, later
    b.box.kick();
    await window.settle();
    const milk = f.rows.find((r) => r.name === 'Milk');
    return { stored, sent: f.sent.map((x) => x.name), replies: a.replies().concat(b.replies()), milk: [milk.bought_at, milk.bought_by], st: b.box.state() };
  });
  check('a change answered after its page closed comes off the saved queue, and the next visit doesn\'t send it again (a bought line stays bought)',
    same(out.stored, []) && same(out.sent, ['Milk']) && same(out.replies, []) && same(out.milk, ['B-sam', 'p-sam']) && out.st.waiting === 0, JSON.stringify(out));
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: 'A1' }]);
    const a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    const open = f.hold();
    a.box.buy(a.box.view().to_buy[0]);
    a.box.unbuy('e');                   // Undo, queued behind the tick
    a.box.stop();
    open();
    await window.settle();
    const stored = JSON.parse(localStorage.getItem('homehub.shop.hub')).queue;
    const bought = f.rows[0].bought_at;
    const b = window.makeBox(f);
    b.box.kick();
    await window.settle();
    return { stored: stored.map((x) => [x.op, x.item, x.seen, 'after' in x]), bought, sent: f.sent.map((x) => `${x.op}:${x.seen}`), replies: b.replies(), eggs: f.rows[0].bought_at };
  });
  check('… a change waiting for it is saved with its seen from that answer, and goes next time (the tick isn\'t sent twice)',
    same(out.stored, [['unbuy', 'e', out.bought, false]]) && !!out.bought && same(out.sent, ['buy:A1', `unbuy:${out.bought}`]) && same(out.replies, ['unbuy:done']) && out.eggs === null,
    JSON.stringify(out));
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: 'A1' }]);
    const a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    const open = f.hold();
    a.box.add('Juice');
    a.box.stop();
    const b = window.makeBox(f);        // Food again before the answer: the add is in its saved queue
    b.box.add('Rice');                  // waits its turn (a saved queue waits for kick())
    open();
    await window.settle();              // the add's answer comes to the closed page
    const stored = JSON.parse(localStorage.getItem('homehub.shop.hub')).queue.map((x) => x.name);
    b.box.kick();
    await window.settle();
    return { stored, sent: f.sent.map((x) => x.name), replies: b.replies(), st: b.box.state(), names: b.box.view().to_buy.map((r) => [r.name, r.id]), after: JSON.parse(localStorage.getItem('homehub.shop.hub')).queue };
  });
  check('… with a page opened since: only that change comes off the saved queue (the new page\'s own change stays), and the new page takes its answer instead of sending it again',
    same(out.stored, ['Rice']) && same(out.sent, ['Juice', 'Rice']) && same(out.replies, ['add:added', 'add:added']) && out.st.waiting === 0
    && same(out.names, [['Eggs', 'e'], ['Juice', 'i-2'], ['Rice', 'i-3']]) && same(out.after, []), JSON.stringify(out));
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: 'A1' }]);
    const a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    const open = f.hold();
    a.box.add('Juice');
    a.box.stop();
    const b = window.makeBox(f);
    b.box.kick();                        // the new page is ready while the answer is still on its way
    await window.settle();
    const busy = b.box.state().busy;
    open();
    await window.settle();
    return { busy, sent: f.sent.map((x) => x.name), replies: b.replies(), st: b.box.state() };
  });
  check('… and if it is ready before the answer comes, it waits for that answer rather than sending the change a second time',
    out.busy === true && same(out.sent, ['Juice']) && same(out.replies, ['add:added']) && out.st.waiting === 0, JSON.stringify(out));
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: 'A1' }]);
    const a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    f.mode = 'down';
    const open = f.hold();
    a.box.buy(a.box.view().to_buy[0]);
    a.box.stop();
    open();
    await window.settle();              // no answer after all
    const stored = JSON.parse(localStorage.getItem('homehub.shop.hub')).queue.map((x) => [x.op, x.sent]);
    f.mode = 'ok';
    const b = window.makeBox(f);
    b.box.kick();
    await window.settle();
    return { stored, sent: f.sent.length, replies: b.replies(), eggs: f.rows[0].bought_by };
  });
  check('… with no answer it stays saved, and the next visit sends it', same(out.stored, [['buy', true]]) && out.sent === 2 && same(out.replies, ['buy:done']) && out.eggs === 'p-alex',
    JSON.stringify(out));

  // ---- 16. An un-tick whose answer was lost, and the tick tapped again behind it
  await ev(() => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1', bought_at: 'B1', bought_by: 'p-alex' }]);
    window.f16 = f;
    window.b16 = window.makeBox(f);
    const { box } = window.b16;
    box.take(f.snapshot(), box.ticket());
    f.mode = 'lost';                    // the un-tick is done, and its answer lost
    const open = f.hold();
    box.unbuy(box.view().bought[0]);    // Just bought → back on the list
    window.r16 = box.buy('m');          // tapped again before the answer: it waits behind the un-tick
    open();
  });
  await tick(2000);                     // the un-tick goes again: "no change", Milk is to buy
  out = await ev(() => ({ r: window.r16, sent: window.f16.sent.map((x) => `${x.op}:${x.seen}`), replies: window.b16.replies(),
    milk: [window.f16.rows[0].bought_at, window.f16.rows[0].bought_by], st: window.b16.box.state() }));
  check('an un-tick sent again after a lost answer finds the line to buy (its own change): the tick behind it goes with the line\'s seen, and Milk is bought, with nothing to say',
    out.r === true && same(out.sent, ['unbuy:B1', 'unbuy:B1', 'buy:A1']) && same(out.replies, ['unbuy:same', 'buy:done']) && !!out.milk[0] && out.milk[1] === 'p-alex' && out.st.waiting === 0,
    JSON.stringify(out));
  await ev(() => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'r', name: 'Rice', added_at: 'A2' }]);
    window.f16 = f;
    window.b16 = window.makeBox(f);
    const { box } = window.b16;
    box.take(f.snapshot(), box.ticket());
    f.mode = 'down';                    // the tick gets no answer and isn't done
    box.buy(box.view().to_buy[0]);
  });
  await tick(0);
  await ev(() => {
    window.b16.box.unbuy('r');          // Undo, behind the tick that left the phone
    Object.assign(window.f16.rows[0], { bought_at: 'B-sam', bought_by: 'p-sam' });   // Sam buys it meanwhile
    window.f16.mode = 'ok';
  });
  await tick(2000);
  out = await ev(() => ({ sent: window.f16.sent.map((x) => x.op), replies: window.b16.replies(), rice: [window.f16.rows[0].bought_at, window.f16.rows[0].bought_by] }));
  check('a tick sent again that finds the line bought by someone else is never this phone\'s: the Undo behind it is dropped, "changed on another phone"',
    same(out.sent, ['buy', 'buy']) && same(out.replies, ['buy:changed']) && same(out.rice, ['B-sam', 'p-sam']), JSON.stringify(out));

  // ---- 17. An Undo by id after the tick was answered undoes only this phone's own purchase
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', added_at: 'A1' }, { id: 'j', name: 'Juice', added_at: 'A2' }]);
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    const shown = box.view().to_buy;
    Object.assign(f.rows[0], { bought_at: 'B-sam', bought_by: 'p-sam' });   // Sam bought Eggs; this phone hasn't read the list since
    const open = f.hold();
    box.buy(shown.find((r) => r.id === 'e'));
    box.buy(shown.find((r) => r.id === 'j'));
    const moved = box.view().bought.find((r) => r.id === 'e');   // drawn while the tick was on its way
    open();
    await window.settle();
    const undoEggs = box.unbuy('e');                            // Undo on "Bought: Eggs", after its answer
    const tapMoved = box.unbuy(moved);                          // or the row drawn as this phone's tick
    const undoJuice = box.unbuy('j');                           // this phone's own tick: undone
    await window.settle();
    const eggs = [f.rows[0].bought_at, f.rows[0].bought_by];
    const sent1 = f.sent.map((x) => `${x.op}:${x.item}`);
    const putBack = box.unbuy(box.view().bought.find((r) => r.id === 'e'));   // Sam's row from Just bought, as the list shows it
    await window.settle();
    return { undoEggs, tapMoved, undoJuice, eggs, sent1, putBack, replies: replies(), sent: f.sent.map((x) => `${x.op}:${x.item}:${x.seen}`), juice: f.rows[1].bought_at, eggsNow: f.rows[0].bought_at };
  });
  check('an Undo given only the item, after a tick that found the line already bought by someone else, isn\'t queued: their purchase stays',
    out.undoEggs === false && out.tapMoved === false && same(out.eggs, ['B-sam', 'p-sam']) && same(out.sent1, ['buy:e', 'buy:j', 'unbuy:j']), JSON.stringify(out));
  check('… while this phone\'s own tick is undone by id, and someone else\'s purchase can still be put back from Just bought, as the list shows it',
    out.undoJuice === true && out.juice === null && out.putBack === true && out.eggsNow === null
    && same(out.replies, ['buy:same', 'buy:done', 'unbuy:done', 'unbuy:done']) && same(out.sent.map((x) => x.split(':').slice(0, 2).join(':')), ['buy:e', 'buy:j', 'unbuy:j', 'unbuy:e']),
    JSON.stringify(out));

  // ---- 18. Rows a waiting change moved have no seen of their own until it is answered
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', added_at: 'A1' }, { id: 'h', name: 'Ham', added_at: 'A0', bought_at: 'B0', bought_by: 'p-alex' }]);
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    const open = f.hold();
    box.buy(box.view().to_buy.find((r) => r.id === 'e'));      // slow signal: on its way
    box.unbuy(box.view().bought.find((r) => r.id === 'h'));    // waits behind it
    const drawn = box.view();                                   // the list drawn 3 seconds later
    const eggs = drawn.bought.find((r) => r.id === 'e');
    const ham = drawn.to_buy.find((r) => r.id === 'h');
    open();
    await window.settle();                                      // both answered; the redraw waits for a finger
    const r1 = box.unbuy(eggs);                                 // the rows as drawn, tapped
    const r2 = box.buy(ham);
    await window.settle();
    return { seen: [eggs.seen, ham.seen, eggs.pending, ham.pending], r1, r2, sent: f.sent.map((x) => `${x.op}:${x.item}:${x.seen}`), replies: replies(),
      eggs: f.rows[0].bought_at, ham: f.rows[1].bought_by, bought1: f.sent[2] && f.sent[2].seen };
  });
  check('a row a waiting tick or un-tick moved has no seen of its own (pending)', same(out.seen, [null, null, true, true]), JSON.stringify(out.seen));
  check('… tapped after that change was answered (before the redraw), it goes with the seen in the answer, not the one from before: both done',
    out.r1 === true && out.r2 === true && same(out.replies, ['buy:done', 'unbuy:done', 'unbuy:done', 'buy:done']) && out.sent[2].startsWith('unbuy:e:2026-')
    && out.sent[3] === 'buy:h:A0' && out.eggs === null && out.ham === 'p-alex', JSON.stringify(out));

  // ---- 19. A tick of a line that a waiting add brings back waits for that add
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'h', name: 'Huevos', aisle: 'dairy', added_at: 'A0', bought_at: '2026-10-27T13:30:00.111111+00:00', bought_by: 'p-alex' }],
      { myDay: true, me: 'p-taylor' });
    const { box, replies } = window.makeBox(f, { key: 'homehub.shop.day', owner: 'abcdef0123456789', who: undefined, mine: (r) => !!r.undo });
    box.take(f.snapshot(), box.ticket());
    f.mode = 'down';                                            // in the store, no signal
    box.add('huevos');                                          // "¿Añadir otra vez?": the bought line comes back
    await window.settle();
    const back = box.view().items.find((r) => r.id === 'h');
    const ticked = box.buy(back);                               // picked up before the add is answered
    const mid = box.view().bought.map((r) => [r.name, r.undo, r.pending]);
    const saved = JSON.parse(localStorage.getItem('homehub.shop.day')).queue.map((x) => [x.op, x.item || x.name, x.seen || null, !!x.after]);
    f.mode = 'ok';
    box.kick();
    await window.settle();
    return { back: [back.id, back.seen, back.pending], ticked, mid, saved, sent: f.sent.map((x) => [x.op, x.item || x.name, x.seen || null]), replies: replies(),
      row: [f.rows[0].bought_at, f.rows[0].bought_by, f.rows[0].added_at] };
  });
  check('My day: a bought line an unsent add brings back is to buy, with a box but no seen of its own; its tick waits for the add',
    same(out.back, ['h', null, true]) && out.ticked === true && same(out.mid, [['Huevos', true, true]]) && same(out.saved, [['add', 'huevos', null, false], ['buy', 'h', null, true]]), JSON.stringify(out));
  check('… then the add brings it back ("back") and the tick goes with the line\'s new seen from its answer: bought by her, not "changed on another phone"',
    same(out.replies, ['add:back', 'buy:done']) && same(out.sent.slice(-1), [['buy', 'h', out.row[2]]]) && out.row[2] !== 'A0' && !!out.row[0] && out.row[1] === 'p-taylor', JSON.stringify(out));
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1', bought_at: 'B1', bought_by: 'p-sam' }, { id: 'b', name: 'Bread', added_at: 'A2' }]);
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    f.mode = 'down';
    box.add('milk');
    await window.settle();
    const ticked = box.buy(box.view().to_buy.find((r) => r.id === 'm'));
    const undone = box.unbuy('m');                              // Undo: the tick never left the phone
    const unbuyBack = box.unbuy('m');                           // nothing to un-buy: the add brings it back
    const queued = box.state().waiting;
    f.mode = 'ok';
    box.kick();
    await window.settle();
    // Bread: ticked (on its way), then added again (it comes back), then ticked again.
    const open = f.hold();
    box.buy(box.view().to_buy.find((r) => r.id === 'b'));
    box.add('bread');
    const again = box.buy(box.view().to_buy.find((r) => r.id === 'b'));
    open();
    await window.settle();
    return { ticked, undone, unbuyBack, queued, replies: replies(), milk: f.rows[0].bought_at, again, bread: [f.rows[1].bought_at, f.rows[1].bought_by], sent: f.sent.map((x) => `${x.op}:${x.item || x.name}`) };
  });
  check('Food: the tick of a line brought back cancels with its Undo while it never left the phone; the add still goes',
    out.ticked === true && out.undone === true && out.unbuyBack === false && out.queued === 1 && out.milk === null && same(out.replies.slice(0, 1), ['add:back']), JSON.stringify(out));
  check('… a line ticked, added again and ticked again: the second tick waits for the add, and the line ends bought',
    out.again === true && same(out.replies.slice(1), ['buy:done', 'add:back', 'buy:done']) && !!out.bread[0] && out.bread[1] === 'p-alex'
    && same(out.sent.slice(-3), ['buy:b', 'add:bread', 'buy:b']), JSON.stringify(out));
  await context.close();

  // =====================================================================
  // Part 2: the outbox through supabase-js and mock.js's fakes, on a schema-4 hub
  // =====================================================================
  const T = '2026-10-24T16:00:00.000000+00:00';
  const db = withFood(Object.assign(makeDb(), {
    people: [
      { id: 'p-alex', name: 'Alex Example', role: 'parent', email: 'alex@example.com', phone: null, color: '#2563eb', language: 'en', day_token: 'a'.repeat(32), active: true, sort_order: 1, created_at: T, updated_at: T },
      { id: 'p-taylor', name: 'Taylor Example', role: 'helper', email: null, phone: '(201) 555-0104', color: '#fde047', language: 'es', day_token: TOKEN, active: true, sort_order: 3, created_at: T, updated_at: T },
    ],
    household: [{ id: true, tz: 'America/New_York', digest_time: '06:30:00', days_off: [], pets_owner_id: null, house_owner_id: null, updated_at: T, updated_by: null }],
    clock: { local_date: '2026-10-27', local_time: '09:42:00', tz: 'America/New_York' },
  }));
  const rpc = Object.assign({ hub_schema_version: () => 4, mark_signed_in: () => null, clock: (d) => Object.assign({}, d.clock) }, foodRpc);
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signIn(ctx2, 'alex@example.com');
  page = await ctx2.newPage();
  page.on('pageerror', (e) => errors.push(`part 2: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || /ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text())) return;
    errors.push(`part 2 console: ${m.text()}`);
  });
  const log = [];
  await install(page, db, log, { rpc });
  await page.goto(`${BASE}/#/food`);
  await page.waitForFunction(() => window.HomeHub && HomeHub.core.schemaVersion === 4 && document.querySelector('#main h1'), null, { timeout: 5000 });
  const until = async (fn, ms = 4000) => page.waitForFunction(fn, null, { timeout: ms }).then(() => true, () => false);
  await page.evaluate(async () => {
    const sb = HomeHub.core.sb;
    const me = HomeHub.core.v2.mePerson.id;
    window.log2 = [];
    window.box2 = HomeShop.outbox({
      key: HomeShop.KEYS.hub, owner: me, who: me, mine: (r) => r.bought_by === me,
      send: (op) => (op.op === 'add' ? sb.rpc('add_to_list', { p_name: op.name, p_private: !!op.private })
        : sb.rpc('buy_item', { p_item: op.item, p_bought: op.op === 'buy', p_seen: op.seen })),
      onReply: (op, r, how) => window.log2.push([op.op, how, r.name || null]),
      onRefused: (op, e) => window.log2.push(['refused', op.op, e.code]),
    });
    const { data } = await sb.rpc('shopping_list');
    window.box2.take(data, window.box2.ticket());
    window.box2.add('2 milk');
    window.box2.add('Leche');
    window.box2.add('Pregnancy test', true);
  });
  await until(() => window.box2.state().waiting === 0);
  let p2 = await page.evaluate(() => ({ log: window.log2, view: window.box2.view() }));
  const milkRow = db.shopping_items.find((r) => r.name_key === 'milk');
  check('through the fakes: "2 milk" is added as milk (note 2) by Alex; "Leche" joins it ("already", as milk); a locked line',
    same(p2.log, [['add', 'added', 'milk'], ['add', 'already', 'milk'], ['add', 'added', 'Pregnancy test']]) && milkRow && milkRow.note === '2' && milkRow.added_by === 'p-alex'
    && same(p2.view.to_buy.map((r) => [r.name, r.aisle, r.private]), [['milk', 'dairy', false], ['Pregnancy test', 'other', true]]), JSON.stringify(p2));
  await page.evaluate(() => {
    const milk = window.box2.view().to_buy.find((r) => r.name === 'milk');
    window.box2.buy(milk);
    window.box2.unbuy(milk.id);
  });
  await until(() => window.box2.state().waiting === 0);
  p2 = await page.evaluate(() => ({ log: window.log2.slice(3), view: window.box2.view() }));
  const buys = (db.rpcCalls || []).filter((c) => c.name === 'buy_item');
  check('a tick and its Undo through buy_item: seen goes back exactly as the database wrote it (microseconds), and the line is to buy again',
    same(p2.log, [['buy', 'done', null], ['unbuy', 'done', null]]) && buys.length === 2 && buys[0].body.p_seen === milkRow.added_at && /\.\d{6}\+00:00$/.test(buys[1].body.p_seen)
    && same(buys[1].body, { p_item: milkRow.id, p_bought: false, p_seen: buys[1].body.p_seen }) && milkRow.bought_at === null, JSON.stringify([p2.log, buys.map((b) => b.body)]));
  // No connection for buy_item: the tick waits, "not sent yet"; it goes once when the connection is back.
  await page.route('**/rest/v1/rpc/buy_item', (route) => route.abort('internetdisconnected'));
  await page.evaluate(() => window.box2.buy(window.box2.view().to_buy.find((r) => r.name === 'milk')));
  await until(() => window.box2.state().unsent === 1);
  p2 = await page.evaluate(() => ({ st: window.box2.state(), bought: window.box2.view().bought.map((r) => [r.name, r.unsent]),
    saved: JSON.parse(localStorage.getItem('homehub.shop.hub')).queue.map((x) => x.op) }));
  check('offline: the tick shows, "not sent yet", and is saved on the device', p2.st.waiting === 1 && same(p2.bought, [['milk', true]]) && same(p2.saved, ['buy']), JSON.stringify(p2));
  await page.unroute('**/rest/v1/rpc/buy_item');
  await page.evaluate(() => window.box2.kick());
  await until(() => window.box2.state().waiting === 0);
  check('back online: the tick goes once, and milk is bought by Alex', (db.rpcCalls || []).filter((c) => c.name === 'buy_item').length === 3
    && milkRow.bought_by === 'p-alex' && !!milkRow.bought_at, JSON.stringify(milkRow));
  // A refusal from the fakes: a rename clash isn't the outbox's, but a 22023 is (p_seen missing can't happen here); a forged id is changed: false.
  await page.evaluate(() => window.box2.unbuy({ id: '00000000-0000-4000-8000-000000000000', seen: '2026-10-27T13:00:00.000001+00:00', name: 'Ghost' }));
  await until(() => window.box2.state().waiting === 0);
  p2 = await page.evaluate(() => window.log2.slice(-1)[0]);
  check('an unknown id answers changed: false, which the outbox reports as changed on another phone', same(p2, ['unbuy', 'changed', null]), JSON.stringify(p2));
  await page.evaluate(() => HomeHub.core.sb.auth.signOut());
  await page.waitForTimeout(500);
  check('signing out removes the saved list', (await page.evaluate(() => localStorage.getItem('homehub.shop.hub'))) === null);
  await ctx2.close();

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
  await server.close();
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
})().catch((err) => {
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
