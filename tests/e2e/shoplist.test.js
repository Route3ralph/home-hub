// Browser tests for assets/shoplist.js (window.HomeShop), the shopping list's shared pieces
// (docs/v1.2-kitchen.md §4.4 and §8): the ten aisles in store order with their English and Spanish
// names, grouping and A–Z order, the "other" word, how an add is read ("2 lb ground beef"), what an
// answer means, the hold that keeps rows from moving under a finger, and the outbox: taps show at once
// and go one at a time, a tick and its Undo cancel only while the tick never left the phone and no add
// waits after it (someone else's purchase put back with its drawn seen after the two cancel), no answer
// keeps everything ("not sent yet", retries at 2, 5, 10 and 30 seconds, the banner after 15), the queue
// and the list saved for their owner only, refusals, a link that no longer works, "changed on another
// phone", changes older than 24 hours; a change answered after its page closed (taken off the saved
// queue by id, its list saved, never sent again, its answer taken at once by a page opened since); every
// change sent with its own
// key, so a second try gets the first answer and changes nothing (a resent add never brings back a line
// bought since, a resent un-tick that never got through doesn't hand its seen to the tick behind it
// when someone has put the line back); a tick's "no change" is this phone's own only when the line is
// bought by this phone; an Undo by id
// only of this phone's own purchase, with the seen from its tick's answer even after a read past the
// household's midnight; rows a waiting change moved have no seen of their own; a tick of a line a
// waiting add brings back waits for that add, and goes to the line the add lands on if the database takes
// another (a waiting add drawn on the line with its own lock first); a waiting add's note laid over the list as the database
// joins it; two tabs of one list (each keeps the other's waiting changes when it saves, with the change each waits for, and a
// page opened while the other tab is open takes that tab's changes, sends them and never cancels one against a tap).
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
// A change as sent, its key checked and set aside: every change carries its own key, a version 4 uuid
// (a missing or malformed key stays in, so the comparison fails).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyed = (x, k = 'key') => {
  const rest = Object.assign({}, x);
  const key = rest[k];
  delete rest[k];
  return UUID.test(key) ? rest : Object.assign(rest, { [k]: key === undefined ? 'missing' : key });
};

// In the page: a stand-in for the list functions (the Food page's shapes; { items } for My day's),
// with the rules of §4.2 for a tick (it changes a row only in the state the phone saw), an answer that
// carries the seen the change gave the line ({changed, seen}; an add's: the line's added_at), each change
// done once per key (a second try gets the first answer, as private.list_done keeps it), and a send()
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
        return Object.assign({ result, item_id: r.id, name: r.name, seen: r.added_at }, f.snapshot());
      }
      const r = f.rows.find((x) => x.id === op.item);
      let seen = null;
      if (r && op.op === 'buy' && !r.bought_at && r.added_at === op.seen) { seen = stamp(); Object.assign(r, { bought_at: seen, bought_by: f.me }); }
      // Every un-tick gives the line a new seen (added_at), as the database does (§4.2).
      if (r && op.op === 'unbuy' && r.bought_at && r.bought_at === op.seen) { seen = stamp(); Object.assign(r, { bought_at: null, bought_by: null, added_at: seen }); }
      return Object.assign({ changed: seen != null, seen }, f.snapshot());
    };
    // f.apply once per key: a second try gets the first answer (with the seen the change gave the line),
    // with the list as it is now.
    f.done = new Map();
    f.answer = (op) => {
      if (op.key && f.done.has(op.key)) return Object.assign({}, f.done.get(op.key), f.snapshot());
      const reply = f.apply(op);
      if (op.key) {
        f.done.set(op.key, op.op === 'add' ? { result: reply.result, item_id: reply.item_id, name: reply.name, seen: reply.seen }
          : { changed: reply.changed, seen: reply.seen });
      }
      return reply;
    };
    f.send = async (op) => {
      f.sent.push(JSON.parse(JSON.stringify(op)));
      if (f.gate) await f.gate;
      if (f.mode === 'down') return { data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }, status: 0 };
      if (f.mode === '503') return { data: null, error: { message: 'Service Unavailable', code: '' }, status: 503 };
      if (f.mode === 'refuse') return { data: null, error: { message: 'Too many ticks from My day today.', code: 'P0001' }, status: 400 };
      if (f.mode === 'null') return { data: null, error: null, status: 200 };
      const reply = f.answer(op);
      if (f.mode === 'lost') { f.mode = 'ok'; throw new TypeError('Failed to fetch'); }
      return { data: reply, error: null, status: 200 };
    };
    f.hold = () => { let open; f.gate = new Promise((r) => { open = r; }); return () => { f.gate = null; open(); }; };
    return f;
  };
  // An outbox with every callback recorded in ev.
  // window.inTab(id): the outboxes made after it are in that tab of the browser (its id in sessionStorage,
  // as the outbox keeps it), as if made by another page; null: back to this page's own.
  window.makeBox = (f, extra) => {
    const ev = [];
    const box = HomeShop.outbox(Object.assign({
      key: HomeShop.KEYS.hub, owner: 'p-alex', who: 'p-alex', send: f.send, mine: (r) => r.bought_by === 'p-alex',
      onChange: () => ev.push('change'), onReply: (op, r, how) => ev.push(`${op.op}:${how}`), onRefused: (op, e) => ev.push(`refused:${op.op}:${e.code}`),
      onGone: () => ev.push('gone'), onExpired: (k) => ev.push(`expired:${k}`),
    }, extra));
    return { box, ev, replies: () => ev.filter((e) => e !== 'change') };
  };
  window.inTab = (id) => {
    if (window.ownTab === undefined) window.ownTab = sessionStorage.getItem('homehub.shop.tab');
    const to = id == null ? window.ownTab : id;
    if (to == null) sessionStorage.removeItem('homehub.shop.tab');
    else sessionStorage.setItem('homehub.shop.tab', to);
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
  check('both are sent, in order, each with its own key; the Undo carries the seen from the tick\'s reply (bought_at, microseconds kept)',
    out.sent.length === 2 && same(keyed(out.sent[0]), { op: 'buy', item: 'm', seen: '2026-10-27T13:00:00.111111+00:00' }) && out.sent[1].op === 'unbuy'
    && UUID.test(out.sent[1].key) && out.sent[1].key !== out.sent[0].key
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
  check('Undo before the tick left the phone: the two cancel out, nothing is sent for them', out.st.waiting === 1 && same(out.sent.map((x) => keyed(x)), [{ op: 'add', name: 'Bread', private: false }])
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
    return { replies: replies(), eggsStill, juice, rice: [f.rows[3].bought_at, f.rows[3].bought_by], sent: f.sent.map((x) => `${x.op}:${x.item}`), keys: f.sent.map((x) => x.key) };
  });
  check('a tick someone else already did answers changed: false, and it is the same as asked: nothing to say', out.replies[0] === 'buy:same', JSON.stringify(out.replies));
  check('a tick from before someone put the line back buys nothing new: "changed on another phone"', out.replies[1] === 'buy:changed' && out.eggsStill === null, JSON.stringify(out.replies));
  check('a lost answer: the tick is sent again with the same key and gets its first answer ("done", nothing done twice), and the Undo queued behind it still undoes it',
    same(out.replies.slice(2, 4), ['buy:done', 'unbuy:done']) && out.juice === null && same(out.keys.slice(2, 4), [out.keys[2], out.keys[2]]) && UUID.test(out.keys[2]),
    JSON.stringify(out));
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
  // A page opened again before the answer, its reads still out (no kick() yet): the closed page's change
  // is answered meanwhile, and this page takes that answer at once, so a tap there, which saves its
  // queue, never puts the answered change back on the saved queue for a later visit to send again.
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: 'A1' }]);
    const a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    const open = f.hold();
    a.box.add('Juice');
    a.box.stop();                        // Alex taps Today while the add is on its way
    const b = window.makeBox(f);         // Food again; its reads are slow, so no kick() yet
    open();
    await window.settle();               // the answer comes
    const early = b.replies();
    b.box.add('Rice');                   // a tap there saves its queue
    const stored = JSON.parse(localStorage.getItem('homehub.shop.hub')).queue.map((x) => x.name);
    b.box.kick();
    await window.settle();
    return { early, stored, sent: f.sent.map((x) => x.name), st: b.box.state(), names: b.box.view().to_buy.map((r) => r.name) };
  });
  check('… a page opened again takes that answer as soon as it comes, before its first kick(): a tap there saves its queue without the answered change, which is never sent again',
    same(out.early, ['add:added']) && same(out.stored, ['Rice']) && same(out.sent, ['Juice', 'Rice']) && out.st.waiting === 0
    && same(out.names, ['Eggs', 'Juice', 'Rice']), JSON.stringify(out));
  // The list in that answer is saved with it (§8.2): the next visit, with no signal, shows the change
  // done, and what still waits laid over the line as it is now.
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: 'A1' }]);
    const a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    const open = f.hold();
    a.box.add('Juice');
    a.box.buy(a.box.view().to_buy.find((r) => r.id === 'e'));   // waits behind the add
    a.box.stop();
    open();
    await window.settle();               // the add's answer comes to the closed page
    f.mode = 'down';                     // Food again, with no signal: the saved list is drawn
    const b = window.makeBox(f);
    const v = b.box.view();
    return { buy: v.to_buy.map((r) => [r.name, r.id, !!r.pending]), bought: v.bought.map((r) => [r.name, !!r.pending]), waiting: b.box.state().waiting };
  });
  check('… the list in that answer is saved with it: the next visit with no signal shows the add done (Juice, with its id), and the tick still waiting',
    same(out.buy, [['Juice', 'i-2', false]]) && same(out.bought, [['Eggs', true]]) && out.waiting === 1, JSON.stringify(out));
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', aisle: 'dairy', added_at: 'A1' }, { id: 'e', name: 'Eggs', aisle: 'dairy', added_at: 'A2' }]);
    const a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    const open = f.hold();
    a.box.buy(a.box.view().to_buy.find((r) => r.id === 'm'));   // Alex ticks Milk
    a.box.add('milk');                   // and types it again: it waits behind the tick
    a.box.stop();
    open();
    await window.settle();               // the tick's answer comes to the closed page; the add stays saved
    f.mode = 'down';
    const b = window.makeBox(f);         // Food again, before any read: the waiting add brings Milk back
    const milk = b.box.view().to_buy.find((r) => r.id === 'm');
    const r = b.box.buy(milk);           // he ticks it again
    f.mode = 'ok';
    b.box.kick();
    await window.settle();
    const row = f.rows.find((x) => x.id === 'm');
    return { seen: milk ? milk.seen : 'none', r, sent: f.sent.map((x) => (x.op === 'add' ? `add:${x.name}` : `${x.op}:${x.seen === 'A1' ? 'A1' : 'new'}`)),
      replies: b.replies(), milk: [!!row.bought_at, row.bought_by], waiting: b.box.state().waiting };
  });
  check('… and a tick there of the line the waiting add brings back, before any read, waits for that add: Milk ends bought, nothing about another phone',
    out.seen === null && out.r === true && same(out.sent, ['buy:A1', 'add:milk', 'buy:new']) && same(out.replies, ['add:back', 'buy:done'])
    && same(out.milk, [true, 'p-alex']) && out.waiting === 0, JSON.stringify(out));
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', aisle: 'dairy', added_at: 'A1' }]);
    const a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    const open = f.hold();
    a.box.add('Juice');
    a.box.stop();
    const b = window.makeBox(f);         // Food again: it reads a newer list, and is left too
    b.box.take(Object.assign(f.snapshot(), { as_of: '2026-10-27T09:43' }), b.box.ticket());
    b.box.stop();
    open();
    await window.settle();
    const saved = JSON.parse(localStorage.getItem('homehub.shop.hub'));
    return { asOf: saved.snap.as_of, queue: saved.queue };
  });
  check('… unless a newer list is saved already (a later as_of): that one stays', out.asOf === '2026-10-27T09:43' && same(out.queue, []), JSON.stringify(out));

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
  out = await ev(() => ({ r: window.r16, sent: window.f16.sent.map((x) => `${x.op}:${x.seen}`), keys: window.f16.sent.map((x) => x.key), replies: window.b16.replies(),
    milk: [window.f16.rows[0].bought_at, window.f16.rows[0].bought_by, window.f16.rows[0].added_at], st: window.b16.box.state() }));
  check('an un-tick sent again after a lost answer gets its first answer (done, with the same key): the tick behind it goes with the line\'s new seen, and Milk is bought, with nothing to say',
    out.r === true && same(out.sent, ['unbuy:B1', 'unbuy:B1', `buy:${out.milk[2]}`]) && out.milk[2] !== 'A1' && same(out.replies, ['unbuy:done', 'buy:done'])
    && out.keys[0] === out.keys[1] && UUID.test(out.keys[0])
    && !!out.milk[0] && out.milk[1] === 'p-alex' && out.st.waiting === 0, JSON.stringify(out));
  // The same taps when the un-tick never got through, and Sam put the line back meanwhile (a new need):
  // the un-tick, done only now, finds the line no longer as it saw it, "no change", so the tick waiting
  // behind it is dropped ("changed on another phone") and never buys Sam's need.
  await ev(() => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1', bought_at: 'B1', bought_by: 'p-alex' }]);
    window.f16 = f;
    window.b16 = window.makeBox(f);
    const { box } = window.b16;
    box.take(f.snapshot(), box.ticket());
    f.mode = 'down';                    // the un-tick gets no answer and isn't done
    box.unbuy(box.view().bought[0]);
    window.r16 = box.buy('m');          // tapped again: it waits behind the un-tick
  });
  await tick(0);
  await ev(() => {
    Object.assign(window.f16.rows[0], { bought_at: null, bought_by: null, added_at: 'A-sam', added_by: 'p-sam' });   // Sam puts Milk back
    window.f16.mode = 'ok';
  });
  await tick(2000);
  out = await ev(() => ({ r: window.r16, sent: window.f16.sent.map((x) => `${x.op}:${x.seen}`), replies: window.b16.replies(),
    milk: [window.f16.rows[0].bought_at, window.f16.rows[0].added_at], st: window.b16.box.state() }));
  check('an un-tick that never got through, sent again after Sam put the line back: "no change", so the tick behind it is dropped ("changed on another phone") and Sam\'s need stays to buy',
    out.r === true && same(out.sent, ['unbuy:B1', 'unbuy:B1']) && same(out.replies, ['unbuy:changed']) && same(out.milk, [null, 'A-sam']) && out.st.waiting === 0, JSON.stringify(out));
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
  // A tick done with its answer lost, sent again once Sam has put the line back and bought it himself: the
  // second try gets the first answer ("done") with the list as it is now, and the answer's seen (the
  // bought_at this tick made) isn't the one the list has (Sam's): the line has changed since, so the Undo
  // waiting behind it is dropped ("changed on another phone"), and the toast's Undo after that answer
  // isn't queued. Sam's purchase stays either way.
  for (const queued of [true, false]) {
    await ev((q) => {
      localStorage.clear();
      const f = window.fakeList([{ id: 'r', name: 'Rice', added_at: 'A2' }]);
      window.f16 = f;
      window.b16 = window.makeBox(f);
      const { box } = window.b16;
      box.take(f.snapshot(), box.ticket());
      f.mode = 'lost';                    // the tick is done, and its answer lost
      box.buy(box.view().to_buy[0]);
      if (q) box.unbuy('r');              // Undo, behind the tick on its way
    }, queued);
    await tick(0);
    await ev(() => { Object.assign(window.f16.rows[0], { bought_at: 'B-sam', bought_by: 'p-sam', added_at: 'A-sam' }); });   // Sam put it back, then bought it
    await tick(2000);                     // the tick goes again
    out = await ev(async () => {
      const byId = window.b16.box.unbuy('r');   // the toast's Undo, after that answer
      await window.settle();
      return { byId, sent: window.f16.sent.map((x) => `${x.op}:${x.seen}`), keys: window.f16.sent.map((x) => x.key), replies: window.b16.replies(),
        rice: [window.f16.rows[0].bought_at, window.f16.rows[0].bought_by], st: window.b16.box.state() };
    });
    check(`a tick done with its answer lost, sent again after Sam put the line back and bought it: its first answer ("done"), but the line is Sam's purchase now: ${queued ? 'the Undo waiting behind it is dropped ("changed on another phone")' : 'the toast\'s Undo isn\'t queued'}, and Sam's purchase stays`,
      out.byId === false && same(out.sent, ['buy:A2', 'buy:A2']) && out.keys[0] === out.keys[1] && same(out.replies, [queued ? 'buy:changed' : 'buy:done'])
      && same(out.rice, ['B-sam', 'p-sam']) && out.st.waiting === 0, JSON.stringify(out));
  }
  // The mirror: an un-tick done with its answer lost, the tick tapped again behind it, and Sam buys the line
  // and puts it back before the un-tick is sent again: its first answer ("done"), but the line is to buy
  // with Sam's new seen, not the one this un-tick gave it, so the tick waiting behind it is dropped and
  // never buys Sam's new need.
  await ev(() => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1', bought_at: 'B1', bought_by: 'p-alex' }]);
    window.f16 = f;
    window.b16 = window.makeBox(f);
    const { box } = window.b16;
    box.take(f.snapshot(), box.ticket());
    f.mode = 'lost';                    // the un-tick is done, and its answer lost
    box.unbuy(box.view().bought[0]);
    window.r16 = box.buy('m');          // tapped again: it waits behind the un-tick on its way
  });
  await tick(0);
  await ev(() => { Object.assign(window.f16.rows[0], { bought_at: null, bought_by: null, added_at: 'A-sam', added_by: 'p-sam' }); });   // Sam bought it, then put it back
  await tick(2000);
  out = await ev(() => ({ r: window.r16, sent: window.f16.sent.map((x) => `${x.op}:${x.seen}`), replies: window.b16.replies(),
    milk: [window.f16.rows[0].bought_at, window.f16.rows[0].added_at], st: window.b16.box.state() }));
  check('an un-tick done with its answer lost, sent again after Sam bought the line and put it back: its first answer, but the line has Sam\'s new seen, so the tick behind it is dropped ("changed on another phone") and Sam\'s need stays to buy',
    out.r === true && same(out.sent, ['unbuy:B1', 'unbuy:B1']) && same(out.replies, ['unbuy:changed']) && same(out.milk, [null, 'A-sam']) && out.st.waiting === 0, JSON.stringify(out));

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

  // Someone else's purchase under Just bought, un-ticked, ticked and un-ticked again by id (or Undo) while
  // another change is on its way: the first two cancel before leaving the phone, and the third goes with
  // the seen the row was drawn with, as the first would have: put back, no "changed on another phone".
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', added_at: 'A0', bought_at: 'B-sam', bought_by: 'p-sam' },
      { id: 'm', name: 'Milk', added_at: 'A1', bought_at: 'B-sam2', bought_by: 'p-sam' }, { id: 'j', name: 'Juice', added_at: 'A2' }]);
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    let open = f.hold();
    box.buy(box.view().to_buy.find((r) => r.id === 'j'));          // on its way
    const eggs = [box.unbuy(box.view().bought.find((r) => r.id === 'e')), box.buy('e'), box.unbuy('e')];
    open();
    await window.settle();
    open = f.hold();
    box.unbuy('j');                                                 // on its way
    const milk = [box.unbuy(box.view().bought.find((r) => r.id === 'm')), box.buy('m'), box.unbuy('m')];
    Object.assign(f.rows[1], { bought_at: 'B-sam3' });               // Sam put Milk back and bought it again meanwhile
    open();
    await window.settle();
    return { eggs, milk, sent: f.sent.map((x) => `${x.op}:${x.item}:${x.seen}`), replies: replies(), rows: f.rows.map((r) => [r.id, r.bought_at, r.bought_by]) };
  });
  check('someone else\'s purchase under Just bought, un-ticked, ticked and un-ticked again while a change is on its way: put back, with the seen it was drawn with (no "changed on another phone")',
    same(out.eggs, [true, true, true]) && out.sent.includes('unbuy:e:B-sam') && same(out.replies.slice(0, 2), ['buy:done', 'unbuy:done']) && out.rows[0][1] === null, JSON.stringify(out));
  check('… and if their purchase changed since, that un-tick is answered "changed on another phone" and the new purchase stays',
    same(out.milk, [true, true, true]) && out.sent.includes('unbuy:m:B-sam2') && same(out.replies.slice(2), ['unbuy:done', 'unbuy:changed'])
    && same(out.rows[1].slice(1), ['B-sam3', 'p-sam']), JSON.stringify(out));

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
      eggs: f.rows[0].bought_at, ham: f.rows[1].bought_by, hamSeen: f.rows[1].added_at, bought1: f.sent[2] && f.sent[2].seen };
  });
  check('a row a waiting tick or un-tick moved has no seen of its own (pending)', same(out.seen, [null, null, true, true]), JSON.stringify(out.seen));
  check('… tapped after that change was answered (before the redraw), it goes with the seen in the answer, not the one from before: both done',
    out.r1 === true && out.r2 === true && same(out.replies, ['buy:done', 'unbuy:done', 'unbuy:done', 'buy:done']) && out.sent[2].startsWith('unbuy:e:2026-')
    && out.sent[3] === `buy:h:${out.hamSeen}` && out.hamSeen !== 'A0' && out.eggs === null && out.ham === 'p-alex', JSON.stringify(out));

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

  // A tick on its way, its Undo (waiting), the name typed again (it joins the line the Undo puts back)
  // and the line ticked again: the tick never cancels the Undo across that add (without the Undo, the add
  // would bring the bought line back, and this tap would be lost); it waits its turn, and the line ends
  // bought. Food and My day.
  for (const myDay of [false, true]) {
    out = await ev(async (md) => {
      localStorage.clear();
      const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1' }, { id: 'b', name: 'Bread', added_at: 'A2' }], md ? { myDay: true, me: 'p-taylor' } : undefined);
      const { box, replies } = md ? window.makeBox(f, { key: 'homehub.shop.day', owner: 'abcdef0123456789', who: undefined, mine: (r) => !!r.undo }) : window.makeBox(f);
      box.take(f.snapshot(), box.ticket());
      const list = (v) => v[md ? 'items' : 'to_buy'];
      const open = f.hold();
      const taps = [box.buy(list(box.view()).find((r) => r.id === 'm'))];   // on its way
      taps.push(box.unbuy('m'));                                          // Undo: waits behind it
      taps.push(box.add(md ? 'Milk: 2' : '2 milk'));                      // joins Milk, to buy again
      const joined = list(box.view()).filter((r) => r.id === 'm').map((r) => r.note);
      taps.push(box.buy('m'));                                            // ticked again
      const shown = [list(box.view()).map((r) => r.name), box.view().bought.map((r) => [r.name, !!r.pending])];
      open();
      await window.settle();
      return { taps, joined, shown, sent: f.sent.map((x) => `${x.op}:${x.item || x.name}`), replies: replies(), milk: [!!f.rows[0].bought_at, f.rows[0].bought_by],
        waiting: box.state().waiting };
    }, myDay);
    check(`${myDay ? 'My day' : 'Food'}: a tick on its way, its Undo, the name added again and the line ticked again: the last tick waits its turn (no cancel across the add), and the line ends bought`,
      same(out.taps, [true, true, true, true]) && same(out.joined, ['2']) && same(out.shown, [['Bread'], [['Milk', true]]])
      && same(out.sent, ['buy:m', 'unbuy:m', `add:${myDay ? 'Milk: 2' : '2 milk'}`, 'buy:m']) && same(out.replies, ['buy:done', 'unbuy:done', 'add:already', 'buy:done'])
      && same(out.milk, [true, myDay ? 'p-taylor' : 'p-alex']) && out.waiting === 0, JSON.stringify(out));
  }
  // Nothing gets through: a Just bought line un-ticked, its name typed again and the line ticked again.
  // The tick doesn't cancel the waiting un-tick across that add (the add would then bring the bought
  // line back): all three go, in order, and the line ends bought, as tapped.
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1', bought_at: 'B1', bought_by: 'p-alex' }, { id: 'e', name: 'Eggs', added_at: 'A2' }]);
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    f.mode = 'down';
    box.buy(box.view().to_buy.find((r) => r.id === 'e'));          // no answer: nothing is getting through
    await window.settle();
    const taps = [box.unbuy(box.view().bought.find((r) => r.id === 'm')), box.add('milk: 2')];
    taps.push(box.buy(box.view().to_buy.find((r) => r.id === 'm')));
    const shown = [box.view().to_buy.map((r) => r.name), box.view().bought.map((r) => r.name)];
    f.mode = 'ok';
    box.kick();
    await window.settle();
    return { taps, shown, sent: f.sent.map((x) => `${x.op}:${x.item || x.name}`), replies: replies(), milk: [!!f.rows[0].bought_at, f.rows[0].bought_by], waiting: box.state().waiting };
  });
  check('Food, nothing getting through: a Just bought line un-ticked, added again and ticked: no cancel across the add; all three go, and Milk ends bought',
    same(out.taps, [true, true, true]) && same(out.shown, [[], ['Milk', 'Eggs']]) && same(out.sent.slice(-3), ['unbuy:m', 'add:milk: 2', 'buy:m'])
    && same(out.replies, ['buy:done', 'unbuy:done', 'add:already', 'buy:done']) && same(out.milk, [true, 'p-alex']) && out.waiting === 0, JSON.stringify(out));
  // A tick of a line to buy behind a waiting add of it that is refused (My day, at the cap): the tick
  // isn't waiting for that add, so it still goes.
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'h', name: 'Huevos', aisle: 'dairy', added_at: 'A1' }], { myDay: true, me: 'p-taylor' });
    const send = async (op) => {
      if (op.op !== 'add') return f.send(op);
      f.sent.push(JSON.parse(JSON.stringify(op)));
      if (f.gate) await f.gate;
      return { data: null, error: { message: 'Too many changes from My day today.', code: 'P0001' }, status: 400 };
    };
    const { box, replies } = window.makeBox(f, { key: 'homehub.shop.day', owner: 'abcdef0123456789', who: undefined, mine: (r) => !!r.undo, send });
    box.take(f.snapshot(), box.ticket());
    const open = f.hold();
    box.add('huevos: 2');                                          // on its way
    const ticked = box.buy(box.view().items.find((r) => r.id === 'h'));
    open();
    await window.settle();
    return { ticked, replies: replies(), sent: f.sent.map((x) => `${x.op}:${x.item || x.name}:${x.seen || ''}`), row: [!!f.rows[0].bought_at, f.rows[0].bought_by] };
  });
  check('My day: a tick of a line to buy behind a waiting add of it that is refused: the tick still goes, and the line is bought',
    out.ticked === true && same(out.replies, ['refused:add:P0001', 'buy:done']) && same(out.sent, ['add:huevos: 2:', 'buy:h:A1']) && same(out.row, [true, 'p-taylor']), JSON.stringify(out));

  // ---- 19b. An add that lands on another line than the one drawn: the database takes the line with
  // this lock first, to buy or bought, even one bought before today, which the list doesn't have (§4.1).
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([
      { id: 'u', name: 'Cake', private: false, added_at: 'A6', bought_at: '2026-10-26T18:00:00.111111+00:00', bought_by: 'p-sam' },   // yesterday
      { id: 'k', name: 'Cake', private: true, added_at: 'A5', bought_at: '2026-10-27T13:30:00.111111+00:00', bought_by: 'p-alex' }]);
    const all = f.snapshot;
    f.snapshot = () => { const sn = all(); sn.bought = sn.bought.filter((r) => r.seen >= '2026-10-27'); return sn; };   // bought since midnight only
    const apply = f.apply;
    f.apply = (op) => {
      if (op.op !== 'add') return apply(op);
      const name = HomeShop.parse(op.name).name.toLowerCase();
      const named = f.rows.filter((x) => x.name.toLowerCase() === name);
      const r = named.find((x) => !!x.private === !!op.private) || named[0];   // this lock first, in any state
      let result = 'already';
      if (r.bought_at) { Object.assign(r, { bought_at: null, bought_by: null, added_at: 'A-back', added_by: f.me }); result = 'back'; }
      return Object.assign({ result, item_id: r.id, name: r.name }, f.snapshot());
    };
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    f.mode = 'down';
    box.add('Cake', false);                                         // lock off
    await window.settle();
    const drawn = box.view().to_buy.find((r) => r.name === 'Cake');   // the locked one, drawn back
    const ticked = box.buy(drawn);                                  // picked up before the add is answered
    f.mode = 'ok';
    box.kick();
    await window.settle();
    return { drawn: [drawn.id, drawn.seen], ticked, replies: replies(), sent: f.sent.map((x) => `${x.op}:${x.item || x.name}:${x.seen || ''}`),
      u: [f.rows[0].bought_at != null, f.rows[0].bought_by], k: f.rows[1].bought_at, waiting: box.state().waiting };
  });
  check('Food: an add that lands on a line the list doesn\'t have (this lock, bought before today) while the other lock\'s was drawn back: the tick goes to the line the add landed on, bought by Alex, not dropped without a word',
    same(out.drawn, ['k', null]) && out.ticked === true && same(out.replies, ['add:back', 'buy:done']) && out.sent.slice(-1)[0] === 'buy:u:A-back'
    && same(out.u, [true, 'p-alex']) && out.k === '2026-10-27T13:30:00.111111+00:00' && out.waiting === 0, JSON.stringify(out));
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'k', name: 'Cake', private: true, added_at: 'A1' },
      { id: 'u', name: 'Cake', private: false, added_at: 'A0', bought_at: '2026-10-27T13:30:00.111111+00:00', bought_by: 'p-sam' }]);
    const { box } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    f.mode = 'down';
    box.add('Cake', false);
    await window.settle();
    const v = box.view();
    box.stop();
    return { toBuy: v.to_buy.map((r) => [r.id, !!r.private, r.seen]), bought: v.bought.map((r) => r.id) };
  });
  check('… and a waiting add is drawn where the database will put it: the line with its own lock first, bought or not (the unlocked Cake back on the list), not the locked one to buy',
    same(out.toBuy, [['k', true, 'A1'], ['u', false, null]]) && same(out.bought, []), JSON.stringify(out));

  // ---- 19c. A put-back of a line this phone's own waiting add brings back (Buy again → Bread, bought
  // yesterday, while "Bread" typed offline waits: the page draws that add as a new row, since the list
  // has only today's buys), with an add and a tick of the line behind it. The add lands on the line
  // ("back"), so the put-back, made against yesterday's purchase, changes nothing: the line is to buy
  // at the very seen this phone's own add gave it, so the put-back is "same" (nothing said) and the tick
  // behind it buys the line. If someone else bought it and put it back in between, the seen differs:
  // "changed on another phone", and the tick is dropped (never buying their new need).
  for (const meddled of [false, true]) {
    out = await ev(async (m) => {
      localStorage.clear();
      const was = '2026-10-26T18:00:00.111111+00:00';            // yesterday
      const f = window.fakeList([{ id: 'b', name: 'Bread', aisle: 'bakery', added_at: 'A0', bought_at: was, bought_by: 'p-alex' },
        { id: 'm', name: 'Milk', aisle: 'dairy', added_at: 'A1' }]);
      const all = f.snapshot;
      f.snapshot = () => { const sn = all(); sn.bought = sn.bought.filter((r) => r.seen >= '2026-10-27'); return sn; };   // bought since midnight only
      const send = f.send;
      f.send = (op) => {
        if (m && op.op === 'unbuy') Object.assign(f.rows[0], { bought_at: null, bought_by: null, added_at: 'A-sam', added_by: 'p-sam' });   // Sam bought it and put it back
        return send(op);
      };
      const { box, replies } = window.makeBox(f);
      box.take(f.snapshot(), box.ticket());
      f.mode = 'down';                                           // no signal
      box.add('Bread');
      await window.settle();
      const drawn = box.view().to_buy.filter((r) => r.name === 'Bread').map((r) => r.id);
      const taps = [box.unbuy({ id: 'b', seen: was, name: 'Bread', note: null, aisle: 'bakery', private: false })];   // Buy again → Bread
      taps.push(box.add('Milk'));
      taps.push(box.buy(box.view().to_buy.find((r) => r.id === 'b')));   // the Bread row the put-back draws, ticked
      f.mode = 'ok';
      box.kick();
      await window.settle();
      return { drawn, taps, replies: replies(), sent: f.sent.slice(-4).map((x) => `${x.op}:${x.item || x.name}:${x.seen || ''}`),
        bread: [f.rows[0].bought_at != null, f.rows[0].bought_by, f.rows[0].added_at], waiting: box.state().waiting };
    }, meddled);
    check(meddled
      ? '… and when someone else bought it and put it back in between, the put-back is "changed on another phone" and the tick behind it is dropped: their new need stays to buy'
      : 'Food: Buy again → Bread (bought yesterday) while this phone\'s own add of Bread waits, then an add and a tick of it: the add brings Bread back, the put-back is "same" (this phone\'s own add did it), and the tick buys it',
      same(out.drawn, [null]) && same(out.taps, [true, true, true]) && out.waiting === 0 && (meddled
        ? same(out.replies, ['add:back', 'unbuy:changed', 'add:already']) && same(out.bread, [false, null, 'A-sam'])
        : same(out.replies, ['add:back', 'unbuy:same', 'add:already', 'buy:done']) && same(out.bread.slice(0, 2), [true, 'p-alex'])),
      JSON.stringify(out));
  }
  // My day: "¿Añadir otra vez?" on Huevos (bought this morning by Alex) brings it back; a tap on the
  // Comprado hoy row still held there sends an un-tick with the old seen, on its way when she ticks the
  // line under the list: the un-tick is "same" (her own add put it back), and the tick buys it.
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'h', name: 'Huevos', aisle: 'dairy', added_at: 'A0', bought_at: '2026-10-27T13:30:00.111111+00:00', bought_by: 'p-alex' }],
      { myDay: true, me: 'p-taylor' });
    const { box, replies } = window.makeBox(f, { key: 'homehub.shop.day', owner: 'abcdef0123456789', who: undefined, mine: (r) => !!r.undo });
    box.take(f.snapshot(), box.ticket());
    const held = box.view().bought.find((r) => r.id === 'h');   // drawn under Comprado hoy, held by her finger
    box.add('Huevos');                                          // ¿Añadir otra vez?
    await window.settle();
    const open = f.hold();
    const taps = [box.unbuy(held)];                              // the held row tapped: the old seen, on its way
    taps.push(box.buy('h'));                                     // ticked under the list: waits behind it
    open();
    await window.settle();
    return { taps, replies: replies(), sent: f.sent.map((x) => `${x.op}:${x.seen || ''}`), row: [!!f.rows[0].bought_at, f.rows[0].bought_by], waiting: box.state().waiting };
  });
  check('My day: "¿Añadir otra vez?" brings Huevos back, a tap on the held Comprado hoy row (its old seen) and a tick of the line behind it: the un-tick is "same", and the tick buys it, by her',
    same(out.taps, [true, true]) && same(out.replies, ['add:back', 'unbuy:same', 'buy:done']) && same(out.row, [true, 'p-taylor']) && out.waiting === 0, JSON.stringify(out));

  // ---- 20. A waiting add's note is laid over the list as the database will join it (§4.1): after
  // " · ", unless it is in the line's note already (the whole note, or a run of its " · " parts)
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', note: '12', added_at: 'A1' }, { id: 'p', name: 'Pan dulce', note: '2 · los grandes', added_at: 'A2' },
      { id: 't', name: 'Tortillas', added_at: 'A3' }]);
    const { box } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    f.mode = 'down';                            // nothing is answered: the view is the overlay
    box.add('Eggs: 2');                         // "2" is in "12" but isn't one of its parts: joined
    box.add('Pan dulce: 2 · los grandes');      // its whole note: unchanged
    box.add('Pan dulce: los grandes');          // one of its parts: unchanged
    box.add('Tortillas: 1 paquete');            // no note yet: the note
    await window.settle();
    const rows = box.view().to_buy.map((r) => [r.name, r.note]);
    box.stop();
    return rows;
  });
  check('a waiting add\'s note shows as the database will join it: after " · ", unless already in the note (the whole note or a run of its " · " parts)',
    same(out, [['Eggs', '12 · 2'], ['Pan dulce', '2 · los grandes'], ['Tortillas', '1 paquete']]), JSON.stringify(out));

  // ---- 21. Undo given only the item after a read past the household's midnight has taken this phone's
  // purchase out of bought: it goes with the seen from the tick's reply (§6.1), drawn to buy at once
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', aisle: 'dairy', added_at: '2026-10-27T13:00:00.111111+00:00' }]);
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    box.buy(box.view().to_buy.find((r) => r.id === 'm'));        // 23:59:57
    await window.settle();
    const boughtAt = f.rows[0].bought_at;
    box.take(Object.assign(f.snapshot(), { as_of: '2026-10-28T00:00', bought: [] }), box.ticket());   // the poll at 00:00:02
    const gone = box.view().bought.length + box.view().to_buy.length;
    const open = f.hold();
    const undo = box.unbuy('m');                                  // Undo on "Bought: Milk"
    const shown = box.view().to_buy.map((r) => [r.name, r.aisle, r.pending]);
    open();
    await window.settle();
    return { boughtAt, gone, undo, shown, sent: f.sent, replies: replies(), milk: f.rows[0].bought_at, after: box.view().to_buy.map((r) => r.name) };
  });
  check('Undo by id after a read past midnight left the line out of the list: sent with the seen from the tick\'s reply, shown to buy at once, and Milk is to buy again',
    out.gone === 0 && out.undo === true && same(out.shown, [['Milk', 'dairy', true]]) && out.sent.length === 2 && same(keyed(out.sent[1]), { op: 'unbuy', item: 'm', seen: out.boughtAt })
    && same(out.replies, ['buy:done', 'unbuy:done']) && out.milk === null && same(out.after, ['Milk']), JSON.stringify(out));
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1' }]);
    const { box, replies } = window.makeBox(f);
    box.take(f.snapshot(), box.ticket());
    box.buy(box.view().to_buy[0]);
    await window.settle();
    const mine = f.rows[0].bought_at;
    Object.assign(f.rows[0], { bought_at: 'B-sam', bought_by: 'p-sam', added_at: 'A2' });   // Sam put it back and bought it again
    box.take(Object.assign(f.snapshot(), { bought: [] }), box.ticket());
    const undo = box.unbuy('m');
    await window.settle();
    return { undo, mine, sent: f.sent.map((x) => `${x.op}:${x.seen}`), replies: replies(), milk: [f.rows[0].bought_at, f.rows[0].bought_by] };
  });
  check('… a purchase since then by someone else stays: the Undo carries this phone\'s tick\'s seen, so it is answered "changed on another phone"',
    out.undo === true && same(out.sent.slice(1), [`unbuy:${out.mine}`]) && same(out.replies, ['buy:done', 'unbuy:changed']) && same(out.milk, ['B-sam', 'p-sam']), JSON.stringify(out));
  // A tick at 23:57 done with its answer lost, sent again only at 00:16: its first answer ("done") comes
  // with a list that no longer has the line (bought before the household's midnight, more than 15 minutes
  // ago). The answer's seen is the bought_at this tick made, so the Undo waiting behind it (or the toast's
  // Undo after the answer) goes with it, and Milk is to buy again: no "changed on another phone".
  for (const queued of [true, false]) {
    out = await ev(async (q) => {
      localStorage.clear();
      const f = window.fakeList([{ id: 'm', name: 'Milk', aisle: 'dairy', added_at: '2026-10-27T13:00:00.111111+00:00' }]);
      const { box, replies } = window.makeBox(f);
      box.take(f.snapshot(), box.ticket());
      f.mode = 'lost';                                            // 23:57: done, and the answer lost
      box.buy(box.view().to_buy[0]);
      if (q) box.unbuy('m');                                      // Undo, behind the tick on its way
      await window.settle();
      const boughtAt = f.rows[0].bought_at;
      const all = f.snapshot;
      f.snapshot = () => Object.assign(all(), { as_of: '2026-10-28T00:16', bought: [] });
      box.kick();                                                 // 00:16: the tick goes again
      await window.settle();
      const byId = q ? null : box.unbuy('m');                     // the toast's Undo, after that answer
      const shown = box.view().to_buy.map((r) => [r.name, r.aisle, !!r.pending]);
      await window.settle();
      return { boughtAt, byId, shown, sent: f.sent.map((x) => `${x.op}:${x.seen}`), replies: replies(), milk: f.rows[0].bought_at, waiting: box.state().waiting };
    }, queued);
    check(`a tick at 23:57 whose answer was lost, sent again at 00:16 (the list in its answer no longer has the line): ${queued ? 'the Undo waiting behind it' : 'the toast\'s Undo after that answer'} goes with the tick's own bought_at (the answer's seen), and Milk is to buy again`,
      !!out.boughtAt && (queued || (out.byId === true && same(out.shown, [['Milk', 'dairy', true]])))
      && same(out.sent, ['buy:2026-10-27T13:00:00.111111+00:00', 'buy:2026-10-27T13:00:00.111111+00:00', `unbuy:${out.boughtAt}`])
      && same(out.replies, ['buy:done', 'unbuy:done']) && out.milk === null && out.waiting === 0, JSON.stringify(out));
  }
  // ---- 22. An add done with its answer lost, sent again once Sam has bought the line: the same key,
  // so it gets its first answer and changes nothing (Milk stays bought, not "back on the list"). The
  // same after a reload, from the saved queue.
  for (const reload of [false, true]) {
    out = await ev(async (again) => {
      localStorage.clear();
      const f = window.fakeList([{ id: 'm', name: 'Milk', aisle: 'dairy', added_at: 'A1' }, { id: 'e', name: 'Eggs', added_at: 'A2' }]);
      let { box, replies } = window.makeBox(f);
      box.take(f.snapshot(), box.ticket());
      f.mode = 'lost';                                   // done, and the answer lost
      box.add('Milk: 2 · big');
      await window.settle();
      Object.assign(f.rows[0], { bought_at: 'B-sam', bought_by: 'p-sam' });   // Sam buys Milk
      if (again) { box.stop(); ({ box, replies } = window.makeBox(f)); }        // the page reloaded, the add saved
      box.kick();
      await window.settle();
      return { sent: f.sent.map((x) => [x.op, x.name, x.key]), replies: replies(), milk: [f.rows[0].bought_at, f.rows[0].bought_by], st: box.state() };
    }, reload);
    check(`an add whose answer was lost, sent again${reload ? ' after a reload (from the saved queue)' : ''} once Sam bought the line: the same key, its first answer ("already"), and Milk stays bought by Sam`,
      out.sent.length === 2 && out.sent[0][2] === out.sent[1][2] && UUID.test(out.sent[0][2]) && same(out.replies, ['add:already'])
      && same(out.milk, ['B-sam', 'p-sam']) && out.st.waiting === 0, JSON.stringify(out));
  }
  // An add that brings a bought line back, done with its answer lost, the line ticked behind it, and Sam
  // buys it and puts it back before the add is sent again: the add's first answer ("back") carries the seen
  // it gave the line, and the tick goes with that one, not Sam's new one: "no change", "changed on another
  // phone", and Sam's new need stays to buy. Untouched since, the same tick buys it (section 19).
  await ev(() => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A1', bought_at: 'B1', bought_by: 'p-alex' }]);
    window.f22 = f;
    window.b22 = window.makeBox(f);
    const { box } = window.b22;
    box.take(f.snapshot(), box.ticket());
    f.mode = 'lost';                                   // done ("back"), and the answer lost
    box.add('milk');
    window.r22 = box.buy(box.view().to_buy.find((r) => r.id === 'm'));   // it waits for the add
  });
  await tick(0);
  await ev(() => { window.a22 = window.f22.rows[0].added_at; Object.assign(window.f22.rows[0], { bought_at: null, bought_by: null, added_at: 'A-sam', added_by: 'p-sam' }); });   // Sam bought it, then put it back
  await tick(2000);
  out = await ev(() => ({ r: window.r22, own: window.a22, sent: window.f22.sent.map((x) => `${x.op}:${x.item || x.name}:${x.seen || ''}`), replies: window.b22.replies(),
    milk: [window.f22.rows[0].bought_at, window.f22.rows[0].added_at], st: window.b22.box.state() }));
  check('an add done with its answer lost, a tick waiting for it, and Sam buys the line and puts it back before the add goes again: the tick goes with the seen the add gave the line, "changed on another phone", and Sam\'s need stays to buy',
    out.r === true && same(out.sent, ['add:milk:', 'add:milk:', `buy:m:${out.own}`]) && out.own !== 'A1' && same(out.replies, ['add:back', 'buy:changed'])
    && same(out.milk, [null, 'A-sam']) && out.st.waiting === 0, JSON.stringify(out));

  // ---- 23. Two pages of the same list in one browser (two tabs of one My day link, or of the hub) share
  // what is saved: each keeps the other's waiting changes when it saves, so a change still waiting in a tab
  // that is then closed goes from the next page opened; a change a tab has taken off (here, a tick and its
  // Undo that cancelled) isn't put back.
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', added_at: 'A1' }, { id: 'm', name: 'Milk', added_at: 'A2' }]);
    const saved = () => (JSON.parse(localStorage.getItem('homehub.shop.hub') || 'null') || { queue: [] }).queue.map((x) => `${x.op}:${x.item || x.name}`);
    const older = window.makeBox(f);                             // a tab opened earlier, still in memory
    older.box.take(f.snapshot(), older.box.ticket());
    const front = window.makeBox(f);                             // the tab in front
    front.box.take(f.snapshot(), front.box.ticket());
    f.mode = 'down';                                             // no signal
    front.box.add('Limones');
    await window.settle();
    const afterAdd = saved();
    older.box.take(f.snapshot(), older.box.ticket());            // the older tab brought to the front reads the list
    const afterRead = saved();
    older.box.buy(older.box.view().to_buy.find((r) => r.id === 'e'));   // and a tick there (no answer)
    await window.settle();
    older.box.buy(older.box.view().to_buy.find((r) => r.id === 'm'));   // a tick waiting its turn…
    older.box.unbuy('m');                                        // …and its Undo: the two cancel
    const afterTaps = saved().sort();
    front.box.stop();                                            // both closed (the phone discards them)
    older.box.stop();
    f.mode = 'ok';
    const next = window.makeBox(f);                              // the link opened again
    const waiting = next.box.state().waiting;
    next.box.kick();
    await window.settle();
    return { afterAdd, afterRead, afterTaps, waiting, sent: f.sent.slice(-2).map((x) => `${x.op}:${x.item || x.name}`),
      rows: f.rows.map((r) => `${r.name}:${r.bought_at ? 'bought' : 'to buy'}`).sort(), left: next.box.state().waiting, end: saved() };
  });
  check('two tabs of one list: a tab that reads the list or is tapped keeps the other tab\'s waiting change in the saved queue (no cancelled change put back)',
    same(out.afterAdd, ['add:Limones']) && same(out.afterRead, ['add:Limones']) && same(out.afterTaps, ['add:Limones', 'buy:e']), JSON.stringify(out));
  check('… so with both closed, the page opened next sends both waiting changes: Limones is on the list and Eggs is bought',
    out.waiting === 2 && same(out.sent.slice().sort(), ['add:Limones', 'buy:e']) && same(out.rows, ['Eggs:bought', 'Limones:to buy', 'Milk:to buy'])
    && out.left === 0 && same(out.end, []), JSON.stringify(out));

  // ---- 23b. A tab that has sent the other tab's add (read from the saved queue) keeps, when it saves, the
  // other tab's tick waiting for that add together with the add, never the tick alone (it could never get
  // its seen, and would be dropped without a word with whatever waits behind it): a page reloaded from what
  // is saved sends both (the add's key gives its first answer, with its seen), and a tap behind the tick
  // there goes too.
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'b', name: 'Bread', added_at: 'A0', added_by: 'p-sam', bought_at: '2026-10-27T12:00:00.000001+00:00', bought_by: 'p-sam' },
      { id: 'm', name: 'Milk', added_at: 'A1' }]);
    const up = { one: true, two: true };
    const via = (tab) => (op) => (up[tab] ? f.send(op) : Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }));
    const saved = () => (JSON.parse(localStorage.getItem('homehub.shop.hub') || 'null') || { queue: [] }).queue.map((x) => `${x.op}:${x.item || x.name}`);
    window.inTab('tab-1');
    const one = window.makeBox(f, { send: via('one') });
    one.box.take(f.snapshot(), one.box.ticket());
    up.one = false;                                                // tab 1 loses signal
    one.box.add('Bread');                                          // Sam bought it this morning: the add brings it back
    await window.settle();
    window.inTab('tab-2');
    const two = window.makeBox(f, { send: via('two') });          // tab 2, opened after, with signal
    two.box.take(f.snapshot(), two.box.ticket());
    two.box.kick();                                                // sends the add it read from the saved queue: 'back'
    await window.settle();
    one.box.buy(one.box.view().to_buy.find((r) => r.name === 'Bread'));   // tab 1 ticks Bread: waits for its own copy of the add
    await window.settle();
    two.box.take(f.snapshot(), two.box.ticket());                  // tab 2's poll saves
    const afterRead = saved();
    two.box.stop();                                                // tab 2 reloaded with no signal
    up.two = false;
    const again = window.makeBox(f, { send: via('two') });
    const drawn = again.box.view().bought.map((r) => r.name);
    again.box.add('Pan dulce');
    const r = again.box.unbuy(again.box.view().bought.find((x) => x.name === 'Bread'));   // takes Bread back
    await window.settle();
    up.one = true;                                                 // signal back
    up.two = true;
    again.box.kick();
    await window.settle();
    one.box.kick();
    await window.settle();
    window.inTab(null);
    const bread = f.rows.find((x) => x.id === 'b');
    return { afterRead, drawn, r, replies: again.replies(), one: one.replies(), bread: bread.bought_at ? 'bought' : 'to buy',
      left: [again.box.state().waiting, one.box.state().waiting], end: saved() };
  });
  check('two tabs: a tab that sent the other tab\'s add keeps that tab\'s tick waiting for it together with the add in the saved queue, never the tick alone',
    same(out.afterRead, ['add:Bread', 'buy:b']), JSON.stringify(out));
  check('… so reloaded, it shows the tick and sends both (the add\'s first answer, with its seen), and the un-tick tapped behind the tick there goes too: Bread is to buy, as last tapped',
    same(out.drawn, ['Bread']) && out.r === true && same(out.replies, ['add:back', 'buy:done', 'add:added', 'unbuy:done']) && same(out.one, ['add:back', 'buy:done'])
    && out.bread === 'to buy' && same(out.left, [0, 0]) && same(out.end, []), JSON.stringify(out));

  // ---- 23c. A page opened while another tab of the list still holds waiting changes (the front tab
  // reloaded after it saved them back, or Food -> Today -> Food there) takes them too: that tab may be
  // closed, or still open and about to send them. So it marks them taken in the saved queue, and a tap in
  // either tab never cancels one (only that tab's copy would go, and the other would still send it): the
  // tap waits its turn after it, so the last tap wins whichever tab sends first.
  for (const where of ['reloaded', 'older']) {
    for (const first of ['reloaded', 'older']) {
      out = await ev(async ([where, first]) => {
        localStorage.clear();
        const f = window.fakeList([{ id: 'e', name: 'Eggs', added_at: 'A1' }, { id: 'm', name: 'Milk', added_at: 'A2' }]);
        window.inTab('tab-older');
        const older = window.makeBox(f);                         // a tab opened earlier, still open
        older.box.take(f.snapshot(), older.box.ticket());
        window.inTab('tab-front');
        let front = window.makeBox(f);
        front.box.take(f.snapshot(), front.box.ticket());
        f.mode = 'down';                                         // no signal
        older.box.buy(older.box.view().to_buy.find((r) => r.id === 'e'));   // sent, no answer
        await window.settle();
        older.box.buy(older.box.view().to_buy.find((r) => r.id === 'm'));   // waits its turn: never left the phone
        front.box.take(f.snapshot(), front.box.ticket());        // the front tab saves (the other's two kept)
        front.box.stop();
        front = window.makeBox(f);                               // and reloads, the older tab still open
        const drawn = front.box.view().bought.map((r) => r.name);
        const tab = where === 'reloaded' ? front : older;        // the user unticks Milk in one of them
        const before = tab.box.state().waiting;
        const r = tab.box.unbuy(tab.box.view().bought.find((x) => x.id === 'm'));
        const after = tab.box.state().waiting;
        f.mode = 'ok';
        for (const b of first === 'reloaded' ? [front, older] : [older, front]) { b.box.kick(); await window.settle(); }
        window.inTab(null);
        const milkKeys = [...new Set(f.sent.filter((x) => x.op === 'buy' && x.item === 'm').map((x) => x.key))];
        return { drawn, before, r, after, milkKeys: milkKeys.length, rows: f.rows.map((x) => `${x.name}:${x.bought_at ? 'bought' : 'to buy'}`).sort(),
          left: [front.box.state().waiting, older.box.state().waiting] };
      }, [where, first]);
      check(`two tabs: the front tab reloaded while the other waits with a tick of Milk it never sent shows it; an un-tick in the ${where} tab is queued after it, not cancelled, and the last tap wins (${first} tab sends first)`,
        out.drawn.includes('Milk') && out.before === 2 && out.r === true && out.after === 3 && out.milkKeys === 1
        && same(out.rows, ['Eggs:bought', 'Milk:to buy']) && same(out.left, [0, 0]), JSON.stringify(out));
    }
  }

  // The same once the reloaded tab has sent the older tab's tick and taken it off the saved queue (so the
  // mark went with it): the older tab, still without signal, finds it gone from there, so another page
  // has it, and the un-tick there still waits its turn after it rather than cancelling it.
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', added_at: 'A1' }, { id: 'm', name: 'Milk', added_at: 'A2' }]);
    const up = { older: false };
    const via = (op) => (up.older ? f.send(op) : Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }));
    window.inTab('tab-older');
    const older = window.makeBox(f, { send: via });              // no signal in the older tab
    older.box.take(f.snapshot(), older.box.ticket());
    older.box.buy(older.box.view().to_buy.find((r) => r.id === 'e'));   // sent, no answer
    await window.settle();
    older.box.buy(older.box.view().to_buy.find((r) => r.id === 'm'));   // waits its turn: never left the phone
    window.inTab('tab-front');
    const front = window.makeBox(f);                             // the front tab reloaded, with signal
    front.box.take(f.snapshot(), front.box.ticket());
    front.box.kick();                                            // sends both ticks (Milk is bought)
    await window.settle();
    const sent = f.sent.map((x) => `${x.op}:${x.item}`);
    const r = older.box.unbuy(older.box.view().bought.find((x) => x.id === 'm'));   // Milk: not bought after all
    const waiting = older.box.state().waiting;
    up.older = true;
    older.box.kick();
    await window.settle();
    window.inTab(null);
    return { sent, r, waiting, rows: f.rows.map((x) => `${x.name}:${x.bought_at ? 'bought' : 'to buy'}`).sort(), left: older.box.state().waiting, older: older.replies() };
  });
  check('… and once the reloaded tab has sent the older tab\'s tick of Milk (gone from the saved queue), an un-tick in the older tab still goes after it, not cancelled: Milk is to buy, as last tapped',
    same(out.sent, ['buy:e', 'buy:m']) && out.r === true && out.waiting === 3 && same(out.rows, ['Eggs:bought', 'Milk:to buy']) && out.left === 0
    && same(out.older, ['buy:done', 'buy:done', 'unbuy:done']), JSON.stringify(out));
  // The same tab reloaded (sessionStorage keeps its id) is the same tab: a tick waiting from before the
  // reload is still its own, and its Undo there still cancels it (nothing is sent).
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'm', name: 'Milk', added_at: 'A2' }]);
    let a = window.makeBox(f);
    a.box.take(f.snapshot(), a.box.ticket());
    f.mode = 'down';
    a.box.add('Limones');                                        // no answer: what follows waits its turn
    await window.settle();
    a.box.buy(a.box.view().to_buy.find((r) => r.id === 'm'));
    a.box.stop();
    a = window.makeBox(f);                                       // reloaded
    const r = a.box.unbuy(a.box.view().bought.find((x) => x.id === 'm'));
    const waiting = a.box.state().waiting;
    f.mode = 'ok';
    a.box.kick();
    await window.settle();
    return { r, waiting, sent: f.sent.map((x) => `${x.op}:${x.item || x.name}`), milk: f.rows[0].bought_at ? 'bought' : 'to buy', left: a.box.state().waiting };
  });
  check('the same tab reloaded: its own tick waiting from before the reload is still its own, and an un-tick there cancels it (only the add is sent)',
    out.r === true && out.waiting === 1 && same(out.sent, ['add:Limones', 'add:Limones']) && out.milk === 'to buy' && out.left === 0, JSON.stringify(out));

  // ---- 23d. A page reloaded while the other tab is still open sends that tab's waiting tick too, and both
  // pages get its answer and say what it means: so the reloaded tab can say "changed on another phone"
  // about a tick made in the other one (§8, what it doesn't do). The database does the tick once, by its key.
  out = await ev(async () => {
    localStorage.clear();
    const f = window.fakeList([{ id: 'e', name: 'Eggs', added_at: 'A1' }, { id: 'm', name: 'Milk', added_at: 'A2' }]);
    window.inTab('tab-B');
    const b = window.makeBox(f);                                 // tab B, behind
    b.box.take(f.snapshot(), b.box.ticket());
    window.inTab('tab-A');
    let a = window.makeBox(f);                                   // tab A, in front
    a.box.take(f.snapshot(), a.box.ticket());
    f.mode = 'down';                                             // no signal in tab B
    b.box.buy(b.box.view().to_buy.find((r) => r.id === 'e'));
    await window.settle();
    Object.assign(f.rows[0], { added_at: 'A-sam', added_by: 'p-sam' });   // Sam bought Eggs and put them back
    a.box.take(f.snapshot(), a.box.ticket());                    // tab A reads the list (and saves B's tick back)
    a.box.stop();                                                // and is reloaded
    a = window.makeBox(f);
    const shown = a.box.view().bought.map((r) => r.id);
    f.mode = 'ok';
    a.box.kick();
    await window.settle();
    b.box.kick();
    await window.settle();
    window.inTab(null);
    return { shown, a: a.replies(), b: b.replies(), keys: new Set(f.sent.map((x) => x.key)).size, eggs: f.rows[0].bought_at ? 'bought' : 'to buy',
      left: [a.box.state().waiting, b.box.state().waiting] };
  });
  check('two tabs: a page reloaded while the other tab is open shows and sends that tab\'s waiting tick, and so does that tab (one key); both get the answer and both say "changed on another phone"',
    same(out.shown, ['e']) && same(out.a, ['buy:changed']) && same(out.b, ['buy:changed']) && out.keys === 1 && out.eggs === 'to buy' && same(out.left, [0, 0]), JSON.stringify(out));
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
      send: (op) => (op.op === 'add' ? sb.rpc('add_to_list', { p_name: op.name, p_private: !!op.private, p_key: op.key })
        : sb.rpc('buy_item', { p_item: op.item, p_bought: op.op === 'buy', p_seen: op.seen, p_key: op.key })),
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
  const milkSeen0 = milkRow.added_at;
  await page.evaluate(() => {
    const milk = window.box2.view().to_buy.find((r) => r.name === 'milk');
    window.box2.buy(milk);
    window.box2.unbuy(milk.id);
  });
  await until(() => window.box2.state().waiting === 0);
  p2 = await page.evaluate(() => ({ log: window.log2.slice(3), view: window.box2.view() }));
  const buys = (db.rpcCalls || []).filter((c) => c.name === 'buy_item');
  check('a tick and its Undo through buy_item: seen goes back exactly as the database wrote it (microseconds), and the line is to buy again, with a new seen',
    same(p2.log, [['buy', 'done', null], ['unbuy', 'done', null]]) && buys.length === 2 && buys[0].body.p_seen === milkSeen0 && /\.\d{6}\+00:00$/.test(buys[1].body.p_seen)
    && same(keyed(buys[1].body, 'p_key'), { p_item: milkRow.id, p_bought: false, p_seen: buys[1].body.p_seen }) && milkRow.bought_at === null && milkRow.added_at !== milkSeen0
    && (p2.view.to_buy.find((r) => r.name === 'milk') || {}).seen === milkRow.added_at, JSON.stringify([p2.log, buys.map((b) => b.body), milkRow.added_at]));
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
  // The same key twice through supabase-js and the fakes: the first answer, nothing done twice.
  p2 = await page.evaluate(async () => {
    const sb = HomeHub.core.sb;
    const key = crypto.randomUUID();
    const a = await sb.rpc('add_to_list', { p_name: 'Bagels', p_key: key });
    const { data } = await sb.rpc('shopping_list');
    const bagels = (data.to_buy || []).find((r) => r.name === 'Bagels') || {};
    await sb.rpc('buy_item', { p_item: bagels.id, p_bought: true, p_seen: bagels.seen, p_key: crypto.randomUUID() });
    const b = await sb.rpc('add_to_list', { p_name: 'Bagels', p_key: key });
    return [a.data && a.data.result, b.data && b.data.result, !!b.data && b.data.bought.some((r) => r.name === 'Bagels'), !!b.data && b.data.to_buy.some((r) => r.name === 'Bagels')];
  });
  check('through the fakes: an add sent twice with the same key gets its first answer ("added") and doesn\'t bring back the line bought in between',
    same(p2, ['added', 'added', true, false]), JSON.stringify(p2));
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
