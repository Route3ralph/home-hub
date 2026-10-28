/* =====================================================================
   HOME HUB — the shopping list's shared pieces (window.HomeShop)
   Used by the Food page (assets/modules/food.js, signed in) and by My
   day's list (assets/day.js, a helper's link). No DOM and no Supabase
   calls of its own: the pages hand it a send() for their writes.
   docs/v1.2-kitchen.md §4 (the list's rules), §4.4 (aisles), §8 (two
   shoppers, bad signal).

   AISLES AND ROWS. A row is what shopping_list() or get_list_by_token()
   gives: { id, name, note, aisle, seen, other?, … }.
     AISLES                  the ten aisles in store order, cold things last:
                             [{ key: 'produce', en: 'Produce', es: 'Frutas y verduras' }, …, { key: 'other', … }]
     aisleName(key, lang)    'Dairy & eggs' / 'Lácteos y huevos'; an unknown key is Other / Otros
     groups(rows, lang)      [{ key, name, rows }]: the rows by aisle in store order, A–Z inside each
                             (as the database sorts: the lowercased name, then the id); empty aisles left out
     byName(a, b)            that A–Z order, for rows.sort(byName)
     nameKey(name)           'milk' for 'Milk' or ' milk ': one item, as the database's name_key
     fold(text)              nameKey without accents, for matching what is typed: 'limon' finds 'Limón'
     withOther(row)          'Leche · milk': the name, then the same thing in the reader's language
                             (row.other) when the word list knows it; otherwise the name. Escape it.
     matches(rows, typed, n) up to n (5) rows whose name, or other word, has what was typed in it;
                             names that start with it first: the add box's suggestions
     parse(text)             { name, note } as the database reads an add (§4.1): '2 lb ground beef' →
                             { name: 'ground beef', note: '2 lb' }; 'Milk: 2 gallons' → { name: 'Milk',
                             note: '2 gallons' }; '2% milk' → { name: '2% milk', note: null }
     sameList(a, b)          two snapshots alike apart from as_of: nothing to redraw
     clean(text, max)        as private.clean_text: one line, no control, bidi or zero-width characters
     answer(res)             what a supabase-js answer to a write means: 'ok', 'gone' (null), 'refused'
                             or 'retry' (below)
     KEYS, POLL_MS (10 s), HOLD_MS (3 s), RETRY_MS, BANNER_MS (15 s), EXPIRE_MS (24 h)

   THE OUTBOX (§8). One per page; every tap goes through it.
     const box = HomeShop.outbox({ key, owner, send, who, mine, visible,
                                   onChange, onReply, onRefused, onGone, onExpired })
       key      KEYS.hub ('homehub.shop.hub', the Food page) or KEYS.day ('homehub.shop.day', My day)
       owner    whose list this is: the signed-in person's id (Food), or await tokenOwner(token) (My
                day: the first 16 hex characters of the token's SHA-256, never the token itself).
                Anything saved for someone else is removed unread. null: nothing is saved or read.
       send(op) sends one change and returns what supabase-js gives back ({ data, error, status }):
                  { op: 'add', name, private, key }   add_to_list(p_name: name, p_private: private, p_key: key) /
                                                      add_to_list_by_token(p_token, p_name: name, p_key: key)
                  { op: 'buy',   item, seen, key }    buy_item(p_item: item, p_bought: true,  p_seen: seen, p_key: key)
                  { op: 'unbuy', item, seen, key }    buy_item(p_item: item, p_bought: false, p_seen: seen, p_key: key)
                                                      (My day: the same through buy_item_by_token)
                name is the text as typed; seen is the row's state as the phone saw it, a string,
                sent back as it came (never through a Date: it keeps microseconds); key is the
                change's own key, a random uuid made when it was queued and sent with every try of
                it (null where the browser can't make one), so the database does it once (below).
       who      optional, the Food page: the signed-in person's id, as added_by / bought_by on rows
                that are waiting
       mine(row) optional: a bought row is this phone's own purchase (Food: bought by the signed-in
                person, or with no bought_by for a member with no person; My day: row.undo). A tick
                answered "no change" that finds the line bought by this phone counts as this phone's
                own (the Undo pressed behind it still undoes it), and an Undo given only an id
                undoes only such a row (below). Without mine, a tick answered "no change" is never
                this phone's own, and an Undo by id undoes the purchase whoever's it is.
       visible() optional: whether to retry now (default: the page isn't hidden)
       onChange()                    what view() or state() gives has changed: draw the list again
                                     (when no finger is on it, see hold())
       onReply(op, reply, outcome)   a change was answered. outcome: for an add, reply.result
                                     ('added' | 'back' | 'already', reply.name is the line's name);
                                     for a tick, 'done' (changed; a resend's answer is the first
                                     try's), 'same' (it was already so: someone else did the same;
                                     say nothing) or 'changed' (someone else changed it first: say
                                     "Changed on another phone"). A change sent
                                     by a page that closed before its answer came is answered on the
                                     page opened again in its place (box.stop(), below)
       onRefused(op, error)          the database refused it (42501, 22023, P0001, 54000, 23505, a
                                     PGRST… code, or any other answer that a resend can't change):
                                     the change is dropped; toast friendly(error) and read the list
       onGone()                      a token function answered null: the link no longer works. The
                                     queue and the saved list are already cleared.
       onExpired(n)                  n changes were more than 24 hours old and were dropped
     box.add(text, priv)  queues an add (false if there is nothing to add)
     box.buy(row)         queues a tick of a row to buy, with the seen it was shown with; box.unbuy(row)
                          un-ticks a bought row (Just bought; Buy again, from the page's table read,
                          with seen: its bought_at, the string as PostgREST gave it). Undo from
                          a tick's toast: box.unbuy(id), and the outbox takes the seen from the tick's
                          reply (kept while the page is open, so it works after a read past the
                          household's midnight has taken the line out of bought). A tick and its Undo
                          cancel out while the tick has never left the phone and no add waits after it
                          (an add reads the line as the changes before it leave it); otherwise both are
                          sent, in order. A tick of a line that a waiting add brings back waits for
                          that add, and takes the line's new seen from its reply (from the line the add
                          landed on, if the database took another one: §4.1). Given a row with no
                          seen (one a waiting change moved, below) or only an id, the outbox takes the
                          seen from the change waiting for that item; for an un-tick, else from the
                          answer to this phone's own tick of it (or from this phone's put-back of it
                          that a tick cancelled before it was sent); else from the list as it has it
                          now. An un-tick then undoes only this phone's own purchase (mine), never one
                          its tick found already bought by someone else. False when there is nothing to
                          do (or that un-tick isn't this phone's). A page sends a row it has ticked or
                          unticked since it drew it by id: every un-tick gives the line a new seen.
     box.view()           the last list with the changes still waiting laid over it, or null before
                          any list. Rows changed by a waiting change carry pending: true, and
                          unsent: true while the outbox can't get an answer ("Not sent yet"); a row
                          a waiting change moved (a tick, an un-tick, or an add bringing a bought line
                          back) has seen: null until that change is answered, so a tap on it never
                          sends the state it had before. A waiting add of something new is a row with
                          id null (no box to tick).
     box.ticket(), box.take(snapshot, ticket)   a read of the list: ticket() before asking,
                          take(answer, ticket) after. Saved; ignored (false) if a write was answered
                          in between (its reply is newer). take() doesn't call onChange: draw after it.
     box.state()          { waiting, unsent, banner, busy, fresh }: changes waiting; how many are not
                          sent yet; banner, that count once the oldest has waited 15 seconds without
                          an answer (else 0); a change on its way (don't poll); fresh, a list was
                          read or answered since the page opened (else view() is the saved one, from
                          view().as_of, the database's time)
     box.kick()           try now: on online, focus and visibilitychange, and once the page is ready
                          to send (a saved queue waits for the first kick())
     box.forget()         clear the queue and the saved list (a link that no longer works)
     box.stop()           the page closed (Food: ctx.signal; My day keeps its outbox while the page is
                          open): no more sends, timers, saves or callbacks. Whatever is waiting stays
                          saved for next time. A change that was on its way and is answered anyway comes
                          off the saved queue then, by its id (a page opened since keeps its own queue
                          there), the changes waiting for it get their seen from the answer, and the
                          list in the answer becomes the saved list (unless a newer one is saved); a
                          page opened again in this window that still has it takes that answer as soon
                          as it comes, even before its first kick(), so that page never saves it back
                          (or, sending, waits for it) instead of sending it again. With no answer it
                          stays, and goes next time.
   A tap is sent at once, unless nothing is getting through: then it waits its turn behind the rest.
   Retries: 2, 5, 10 and 30 seconds after a change gets no answer (or a 5xx, 408 or 429), then every
   30 seconds while the page is visible. Changes older than 24 hours are dropped. Every try of a
   change carries its key, and the database does a change once per key: a try after the first (its
   answer was lost, or the page closed with it on its way) gets the first try's answer and changes
   nothing. So a resent add never brings back a line someone bought since; a resent tick or un-tick
   that was done answers "done", and the change waiting behind it takes the row's seen; and one that
   never got through is done now, against the state it was made on: if the line changed since (an
   un-tick whose line someone put back meanwhile), "no change", and the tick waiting behind it is
   dropped ("changed on another phone"), never buying their new need. A tick found bought by someone
   else never hands its seen to the Undo behind it.
   The poll (the page's): every POLL_MS while the list is on screen and the page visible, and at once
   on focus, visibilitychange and online; none while state().busy; t = ticket(), read, take(answer, t),
   and no redraw when sameList() says the view is as drawn.

   hold(ms, run): no row moves under a finger. touch() on every tap on the list; request() when the
   list should move (a tick's row, a poll's change): run() at once if the last tap was ms (HOLD_MS,
   3 seconds) ago or more, otherwise that long after the last tap. held() and cancel().

   tokenOwner(token): a Promise of the first 16 hex characters of the token's SHA-256 (crypto.subtle),
   or null where there is no crypto.subtle.
   ===================================================================== */
(function () {
  'use strict';

  const KEYS = Object.freeze({ hub: 'homehub.shop.hub', day: 'homehub.shop.day' });
  const POLL_MS = 10 * 1000;            // the list is read again this often while it is on screen
  const HOLD_MS = 3 * 1000;             // and moves only this long after the last tap on it
  const RETRY_MS = [2000, 5000, 10000, 30000];
  const BANNER_MS = 15 * 1000;          // "N changes not sent yet" after this long
  const EXPIRE_MS = 24 * 60 * 60 * 1000;

  // ============================================
  // AISLES (§4.4): store order, cold things last so they go in the cart last
  // ============================================
  const AISLES = Object.freeze([
    { key: 'produce', en: 'Produce', es: 'Frutas y verduras' },
    { key: 'bakery', en: 'Bakery', es: 'Panadería' },
    { key: 'pantry', en: 'Pantry', es: 'Despensa' },
    { key: 'drinks', en: 'Drinks', es: 'Bebidas' },
    { key: 'household', en: 'Household', es: 'Limpieza y hogar' },
    { key: 'personal', en: 'Personal care', es: 'Cuidado personal' },
    { key: 'meat', en: 'Meat & fish', es: 'Carne y pescado' },
    { key: 'dairy', en: 'Dairy & eggs', es: 'Lácteos y huevos' },
    { key: 'frozen', en: 'Frozen', es: 'Congelados' },
    { key: 'other', en: 'Other', es: 'Otros' },
  ].map(Object.freeze));
  const AISLE = new Map(AISLES.map((a) => [a.key, a]));
  const aisleOf = (key) => AISLE.get(key) || AISLE.get('other');
  const aisleName = (key, lang) => aisleOf(key)[lang === 'es' ? 'es' : 'en'];

  // ============================================
  // NAMES
  // ============================================
  // private.clean_text(p_text, p_max): control characters become spaces, bidi and zero-width
  // characters go, runs of spaces become one, trimmed, at most p_max characters.
  function clean(text, max) {
    const s = String(text == null ? '' : text)
      .replace(/[\u0001-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
      .replace(/[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
      .trim();
    return Array.from(s).slice(0, Math.max(max, 0)).join('').trimEnd();
  }
  const nameKey = (name) => clean(name, 60).toLowerCase();
  const fold = (text) => nameKey(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // A leading amount, as private.list_add reads it (§4.1): '2 milk', '2x milk', '2 lb ground beef',
  // '3 cans of black beans', '2 bolsas de arroz'. The name must start with a letter and have 3 or more
  // characters, so '2% milk', '7up' and '7 Up' stay whole.
  const AMOUNT = /^([0-9]{1,3})(?:\s*x)?\s+(?:(lbs?|oz|kg|g|dozen|packs?|bags?|cans?|bottles?|box(?:es)?|jars?|gallons?|bunch(?:es)?|libras?|kilos?|docenas?|paquetes?|bolsas?|latas?|botellas?|cajas?)\s+(?:(?:of|de)\s+)?)?(\p{L}.{2,})$/iu;
  function parse(text) {
    const s = clean(Array.from(String(text == null ? '' : text)).slice(0, 200).join(''), 100);
    const m = AMOUNT.exec(s);
    let name = s;
    let note = null;
    if (m) {
      name = m[3];
      note = m[2] ? `${m[1]} ${m[2]}` : m[1];
    } else if (s.includes(':')) {
      name = s.slice(0, s.indexOf(':'));
      note = s.slice(s.indexOf(':') + 1);
    }
    return { name: clean(name, 60), note: clean(note, 80) || null };
  }

  // A–Z as the database sorts (name_key, then id; code-unit order, as its C collation). A row that
  // isn't saved yet (id null) comes after a saved one with the same name.
  function byName(a, b) {
    const x = nameKey(a.name);
    const y = nameKey(b.name);
    if (x !== y) return x < y ? -1 : 1;
    if (a.id === b.id) return 0;
    if (a.id == null) return 1;
    if (b.id == null) return -1;
    return String(a.id) < String(b.id) ? -1 : 1;
  }

  function groups(rows, lang) {
    const by = new Map(AISLES.map((a) => [a.key, []]));
    (rows || []).forEach((r) => by.get(aisleOf(r.aisle).key).push(r));
    return AISLES.map((a) => ({ key: a.key, name: lang === 'es' ? a.es : a.en, rows: by.get(a.key).slice().sort(byName) }))
      .filter((g) => g.rows.length);
  }

  const withOther = (row) => (row && row.other && fold(row.other) !== fold(row.name) ? `${row.name} · ${row.other}` : (row && row.name) || '');

  function matches(rows, typed, n) {
    const want = fold(typed);
    if (!want) return [];
    const starts = [];
    const within = [];
    (rows || []).forEach((r) => {
      const words = [fold(r.name), r.other ? fold(r.other) : ''];
      if (words.some((w) => w.startsWith(want))) starts.push(r);
      else if (words.some((w) => w.includes(want))) within.push(r);
    });
    return starts.concat(within).slice(0, n == null ? 5 : n);
  }

  const withoutAsOf = (s) => {
    if (!s || typeof s !== 'object') return s;
    const o = Object.assign({}, s);
    delete o.as_of;
    return o;
  };
  const sameList = (a, b) => JSON.stringify(withoutAsOf(a)) === JSON.stringify(withoutAsOf(b));

  // ============================================
  // ANSWERS (§8.4)
  // ============================================
  // What a write's answer means: 'ok' (take the list in it), 'gone' (null from a token function:
  // the link no longer works), 'refused' (the database said no; sending it again won't change that)
  // or 'retry' (no answer, or a 5xx, 408 or 429: keep it and try again).
  const REFUSALS = new Set(['42501', '22023', 'P0001', '54000', '23505']);
  function answer(res) {
    const r = res || {};
    if (!r.error) return r.data && typeof r.data === 'object' ? 'ok' : 'gone';
    const code = String(r.error.code || '');
    if (REFUSALS.has(code) || /^PGRST/.test(code)) return 'refused';
    const status = Number(r.status) || 0;
    if (!status || status >= 500 || status === 408 || status === 429) return 'retry';
    return 'refused';
  }

  // The list in a write's reply: the reply without the write's own keys.
  function snapshotOf(reply) {
    const s = Object.assign({}, reply);
    ['changed', 'result', 'item_id', 'name'].forEach((k) => delete s[k]);
    return s;
  }
  // Food's snapshot keeps the lines to buy in to_buy, My day's in items.
  const listKey = (snap) => (snap && Array.isArray(snap.to_buy) ? 'to_buy' : 'items');

  // A change's key (§8): a random uuid (version 4), sent with every try of the change, so the
  // database does it once. crypto.randomUUID, else one made with crypto.getRandomValues; null where
  // there is neither (the change then goes without one).
  function newKey() {
    try {
      if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    } catch (err) { return null; }
  }

  async function tokenOwner(token) {
    try {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
      return Array.from(new Uint8Array(hash).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) { return null; }
  }

  // ============================================
  // HOLD: no row moves under a finger
  // ============================================
  function hold(ms, run) {
    const wait = ms == null ? HOLD_MS : ms;
    let last = -Infinity;
    let timer = null;
    const fire = () => {
      timer = null;
      const left = last + wait - Date.now();
      if (left > 0) { timer = setTimeout(fire, left); return; }
      run();
    };
    return {
      touch() { last = Date.now(); },
      request() { if (!timer) fire(); },
      held: () => Date.now() - last < wait,
      cancel() { clearTimeout(timer); timer = null; },
    };
  }

  // ============================================
  // THE OUTBOX
  // ============================================
  // Every change on its way from an outbox that saves its queue, by the key it is saved under and its
  // id: a Promise of its answer. When the page closes first (stop()), the change stays saved, and a
  // page opened again in this window (Food → Today → Food) that finds it in the saved queue takes this
  // answer (or waits for it) instead of sending it again. An entry goes once a page that is still open
  // has the answer, at once when the answer is "no answer", or when a page reads a saved queue
  // without that change.
  const onTheWay = new Map();
  let seq = 0;   // change ids are unique in this window, so an answer is never taken for another change

  function outbox(options) {
    const o = options || {};
    const key = o.key;
    const owner = o.owner == null ? null : String(o.owner);
    const keep = !!key && owner != null;   // the queue and the list are saved on this device
    const send = o.send;
    const visible = o.visible || (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
    // The page's callbacks (a callback that throws is reported and doesn't stop the outbox).
    const emit = (name, ...args) => { if (typeof o[name] === 'function') { try { o[name](...args); } catch (err) { console.error(err); } } };

    // queue: { id, op, key, item?, seen?, name?, private?, show?, at, sent, after? }, oldest first.
    // key: the change's own key, sent with every try (the database does it once per key); sent: it
    // has left the phone at least once.
    let queue = [];
    let snap = null;        // the last list read or answered
    let fresh = false;      // a list came from the database since the page opened
    let inflight = null;    // the change on its way
    let failing = false;    // the last try got no answer (or a saved queue is waiting)
    let tries = 0;          // tries in a row that got no answer
    let writes = 0;         // write replies taken (for ticket())
    let timer = null;
    let bannerTimer = null;
    let again = false;      // kick() came while a change was on its way: if it gets no answer, try again at once
    let stopped = false;
    const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const wayKey = (op) => `${key} ${op.id}`;
    // This phone's own purchases, from the answers to its ticks (or a put-back of a bought row this phone
    // took back before it was sent): item → { seen, show }, the bought row's seen (its bought_at) and
    // how to draw it. An un-tick given no seen (the toast's Undo, a row ticked here a moment ago) goes
    // with it (§6.1: "the seen of the reply's bought row"), so it still works after a read past the
    // household's midnight has taken the line out of bought. Kept while the page is open; any other
    // answered change of that item, or forget(), drops it.
    const ownBuys = new Map();

    // ---- Saved on this device, for this owner only
    function read() {
      if (!key) return;
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (err) { saved = null; }
      if (!saved) return;
      if (owner == null || saved.owner !== owner || saved.v !== 1) {
        try { localStorage.removeItem(key); } catch (err) { /* nothing more to do */ }
        return;
      }
      queue = Array.isArray(saved.queue) ? saved.queue.filter((x) => x && ['add', 'buy', 'unbuy'].includes(x.op)) : [];
      snap = saved.snap && typeof saved.snap === 'object' ? saved.snap : null;
      failing = queue.length > 0;
      // Answers kept for changes this queue no longer has (a closed page took them off already).
      const ids = new Set(queue.map(wayKey));
      [...onTheWay.keys()].forEach((k) => { if (k.startsWith(`${key} `) && !ids.has(k)) onTheWay.delete(k); });
      // A change a closed page sent that is still on its way: this page takes its answer as soon as it
      // comes (answeredEarly), not at its first kick(), so no save of this page's queue (a tap, a read)
      // puts it back on the saved queue once it has been answered, for a later visit to send again.
      if (keep) queue.forEach((x) => { const p = onTheWay.get(wayKey(x)); if (p) p.then((res) => answeredEarly(x, res)); });
    }
    function save() {
      if (!key || owner == null || stopped) return;
      try {
        if (!queue.length && !snap) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({ v: 1, owner, queue, snap }));
      } catch (err) { /* the page works without it */ }
    }
    read();

    // ---- The queue
    // The last waiting change of an item's tick: a buy or unbuy of it, or an add that brings its bought
    // line back on the list (as view() lays the queue over the list).
    function lastFor(item) {
      const laid = queue.some((x) => x.op === 'add') ? overlay() : null;
      for (let i = queue.length - 1; i >= 0; i--) {
        const x = queue[i];
        if (x.item === item || (laid && laid.backs.get(x.id) === item)) return x;
      }
      return null;
    }
    // A queue without a change and everything that was waiting for its reply.
    function without(list, op) {
      const gone = new Set([op.id]);
      let more = true;
      while (more) {
        more = false;
        list.forEach((x) => { if (x.after && gone.has(x.after) && !gone.has(x.id)) { gone.add(x.id); more = true; } });
      }
      return list.filter((x) => !gone.has(x.id));
    }
    function drop(op) {
      const before = queue.length;
      queue = without(queue, op);
      return before - queue.length;
    }
    const rowsOf = (s, which) => (s && Array.isArray(s[which === 'bought' ? 'bought' : listKey(s)]) ? s[which === 'bought' ? 'bought' : listKey(s)] : []);
    const idOf = (row) => (row && typeof row === 'object' ? row.id : row);
    const showOf = (row) => (row && typeof row === 'object'
      ? { name: row.name, note: row.note == null ? null : row.note, aisle: row.aisle || 'other', private: !!row.private, other: row.other } : null);
    const isMine = (row) => typeof o.mine !== 'function' || !!o.mine(row);

    function queueTick(kind, row) {
      const item = idOf(row);
      if (stopped || item == null) return false;
      const inverse = kind === 'buy' ? 'unbuy' : 'buy';
      const last = lastFor(item);
      if (last && last.op === kind) return false;   // already waiting to do just that
      if (last && last.op === 'add' && kind === 'unbuy') return false;   // an add is bringing it back: nothing to un-buy
      if (last && last.op === inverse && !last.sent && !queue.slice(queue.indexOf(last) + 1).some((x) => x.op === 'add')) {
        // Never left the phone, and no add waits after it: the two cancel out. (An add after it reads the
        // line as that change leaves it: an add of a line an un-tick puts back joins it, and without the
        // un-tick it would bring the bought line back, so this tap would be lost. Then this one waits
        // its turn after it, below.) A put-back that carried the row's seen (a row under Just bought or
        // Buy again, whoever bought it) stays this phone's to make: an un-tick of the line by id after
        // this (the next tap on it, or the Undo on "Bought") goes with that same seen.
        drop(last);
        if (last.op === 'unbuy' && last.seen != null) ownBuys.set(item, { seen: last.seen, show: last.show });
        changed();
        return true;
      }
      const op = { id: nextId(), op: kind, key: newKey(), item, seen: null, show: showOf(row), at: Date.now(), sent: false };
      if (last) {
        // Its seen comes from that change's reply: a tick's or un-tick's row, or the line an add brought
        // back (its new added_at).
        op.after = last.id;
      } else {
        const shown = row && typeof row === 'object' ? row.seen : null;
        const own = kind === 'unbuy' && shown == null ? ownBuys.get(item) : null;
        if (shown != null) {
          op.seen = shown;   // the row as the phone showed it
        } else if (own) {
          // This phone's own tick, as its answer had it: sent even when the list no longer has the line
          // (a read after midnight), and drawn to buy meanwhile. Changed since (someone bought it again),
          // the answer is "changed": an Undo never reopens a purchase that isn't this phone's.
          op.seen = own.seen;
          if (!op.show) op.show = own.show;
        } else {
          // Given no seen (an Undo from a toast, a row ticked in place a moment ago, or a row a waiting
          // change had moved, answered since): the row as the list has it now. An un-tick then undoes
          // only this phone's own purchase, never someone else's that its tick found already bought.
          const now = rowsOf(snap, kind === 'buy' ? 'to_buy' : 'bought').find((r) => r.id === item);
          if (!now || (kind === 'unbuy' && !isMine(now))) return false;
          op.seen = now.seen;
        }
        if (op.seen == null) return false;
      }
      queue.push(op);
      changed();
      send1();
      return true;
    }

    function add(text, priv) {
      if (stopped || !parse(text).name) return false;
      queue.push({ id: nextId(), op: 'add', key: newKey(), name: String(text), private: !!priv, at: Date.now(), sent: false });
      changed();
      send1();
      return true;
    }
    // A tap sends at once, unless the outbox can't get an answer: then it waits its turn with the rest
    // (the next retry, or kick() on online, focus and visibilitychange).
    function send1() {
      if (!failing) pump();
    }

    // ---- Sending, one at a time, in order
    function changed() {
      save();
      scheduleBanner();
      emit('onChange');
    }

    function dropExpired() {
      const cut = Date.now() - EXPIRE_MS;
      let n = 0;
      queue.filter((x) => x !== inflight && x.at < cut).forEach((x) => { if (queue.includes(x)) n += drop(x); });
      if (n) { changed(); emit('onExpired', n); }
    }

    function retryLater() {
      clearTimeout(timer);
      const delay = RETRY_MS[Math.min(tries, RETRY_MS.length) - 1] || RETRY_MS[RETRY_MS.length - 1];
      timer = setTimeout(() => { timer = null; if (visible()) pump(); }, delay);
    }

    // One change to the database: a Promise of what supabase-js gives back (never rejected).
    function ask(op) {
      let p;
      try {
        p = Promise.resolve(send(op.op === 'add' ? { op: 'add', name: op.name, private: op.private, key: op.key || null }
          : { op: op.op, item: op.item, seen: op.seen, key: op.key || null }));
      } catch (err) {
        p = Promise.reject(err);
      }
      return p.catch((err) => ({ data: null, error: err, status: 0 }));
    }

    async function pump() {
      if (stopped || inflight) return;
      clearTimeout(timer);
      timer = null;
      dropExpired();
      while (!stopped && !inflight && queue.length) {
        const op = queue[0];
        if (op.op !== 'add' && op.seen == null) { drop(op); changed(); continue; }   // its reply never gave one
        inflight = op;
        // Sent by a page that closed before its answer came: take that answer, don't send it again.
        let asked = keep ? onTheWay.get(wayKey(op)) : null;
        if (!asked) {
          asked = ask(op);
          if (keep) onTheWay.set(wayKey(op), asked);
        }
        op.sent = true;   // once it has left the phone, an Undo no longer cancels it
        save();
        emit('onChange');
        const res = await asked;
        inflight = null;
        if (stopped) { answeredLate(op, res); return; }
        onTheWay.delete(wayKey(op));
        const how = answer(res);
        const kicked = again;
        again = false;
        if (how === 'retry') {
          failing = true;
          tries++;
          changed();
          if (kicked) setTimeout(kick, 0);   // the connection came back while it was on its way
          else retryLater();
          return;
        }
        failing = false;
        tries = 0;
        if (how === 'gone') {
          forget();
          emit('onChange');
          emit('onGone');
          return;
        }
        if (how === 'refused') {
          drop(op);
          changed();
          emit('onRefused', op, res.error);
          continue;
        }
        settle(op, res.data);
      }
      if (!queue.length) failing = false;
    }

    // What an answered change means for a queue (§8.4): the queue without it, the changes that were
    // waiting for its reply given their seen from it (or dropped, with everything waiting for them),
    // the list in the reply, and what to say.
    function settled(list, op, reply) {
      const s = snapshotOf(reply);
      let rest = list.filter((x) => x.id !== op.id);
      let outcome = reply.result;
      let from;           // from(next): the row a change waiting for this one takes its seen from, or null
      let own = null;     // a tick of this phone's own: the bought row in the answer
      if (op.op === 'add') {
        // A tick of the line this add brings back (as overlay() drew it) takes its seen from the line the
        // add landed on. That is the line drawn, unless the database took another (§4.1: a line with this
        // lock first, to buy or bought, even one bought before today, which the list doesn't have; or the
        // line drawn was forgotten since): then the tick, and whatever waits behind it for that line,
        // goes to the line the add landed on, never dropped without a word.
        const landed = reply.item_id;
        from = (next) => {
          if (landed == null) return null;
          if (next.item !== landed) {
            const was = next.item;
            const moved = new Set([next.id]);
            rest.forEach((x) => { if (x.after && moved.has(x.after) && x.item === was) { moved.add(x.id); x.item = landed; } });
            next.item = landed;
          }
          return rowsOf(s, next.op === 'buy' ? 'to_buy' : 'bought').find((r) => r.id === landed) || null;
        };
      } else {
        const done = reply.changed === true;
        const where = op.op === 'buy' ? 'bought' : 'to_buy';
        const found = rowsOf(s, where).find((r) => r.id === op.item);
        // This phone's own change: it changed the row (a second try's answer is the first one's, so a
        // try whose answer was lost says so too), or it is a tick that finds the line bought by this
        // phone (mine). "No change" never counts by itself: for a tick the purchase may be someone
        // else's, and an Undo waiting behind it must not undo that; for an un-tick the line may be to
        // buy because someone else put it back since, and a tick waiting behind it must not buy that.
        const ours = !!found && (done || (op.op === 'buy' && typeof o.mine === 'function' && !!o.mine(found)));
        outcome = done ? 'done' : found ? 'same' : 'changed';
        from = () => (ours ? found : null);
        if (op.op === 'buy' && ours) own = found;
      }
      rest.filter((x) => x.after === op.id).forEach((next) => {
        if (!rest.includes(next)) return;   // dropped already, with a change it was waiting for
        const row = from(next);
        if (row) { next.seen = row.seen; delete next.after; return; }
        rest = without(rest, next);
        // Undo (or a tick) that can no longer be done as asked: the list shows it as it is now.
        if (op.op !== 'add' && !rowsOf(s, next.op === 'buy' ? 'bought' : 'to_buy').some((r) => r.id === next.item)) outcome = 'changed';
      });
      return { queue: rest, snap: s, outcome, own };
    }

    // A change was answered: take the list in the reply, give the changes waiting for this one their
    // seen, and say what happened.
    function settle(op, reply) {
      const done = settled(queue, op, reply);
      queue = done.queue;
      snap = done.snap;
      const item = op.op === 'add' ? reply.item_id : op.item;
      if (done.own) ownBuys.set(item, { seen: done.own.seen, show: showOf(done.own) });
      else if (item != null) ownBuys.delete(item);
      fresh = true;
      writes++;
      changed();
      emit('onReply', op, reply, done.outcome);
    }

    // The page closed while this change was on its way, and its answer came anyway (§8.2). It comes off
    // the queue saved on this device by its id, never by saving this page's queue over it (a page
    // opened since may have saved its own there), and the changes waiting for it get their seen from the
    // answer, as settle() gives them; the list in the answer becomes the saved list (unless a newer one
    // is saved: a later as_of), so the next visit, before a read or without one, shows that change done
    // and lays what still waits over the line as it is now. With no answer it stays saved, and goes
    // again next time.
    function answeredLate(op, res) {
      const how = answer(res);
      if (how === 'retry') { onTheWay.delete(wayKey(op)); return; }
      if (!keep) return;
      try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (!saved || saved.owner !== owner || saved.v !== 1 || !Array.isArray(saved.queue)) return;
        const list = saved.queue.filter((x) => x && typeof x === 'object');
        const was = list.find((x) => x.id === op.id);
        if (!was) return;
        if (how === 'ok') {
          const done = settled(list, was, res.data);
          saved.queue = done.queue;
          const kept = saved.snap && typeof saved.snap === 'object' ? String(saved.snap.as_of || '') : '';
          if (!kept || kept <= String(done.snap.as_of || '')) saved.snap = done.snap;   // as_of: 'YYYY-MM-DDTHH:MI'
        } else {
          saved.queue = without(list, was);
        }
        localStorage.setItem(key, JSON.stringify(saved));
      } catch (err) { /* the page works without it */ }
    }

    // The answer to a change a closed page sent (read() found it on the saved queue), come before this
    // page sent it itself: taken now, as pump() takes an answer. With no answer it stays, and goes with
    // the rest. The closed page's answeredLate() has already taken it off the saved queue; settle()
    // then saves this page's queue without it. One this page is waiting for (inflight) is pump()'s.
    function answeredEarly(op, res) {
      if (stopped || inflight === op || !queue.includes(op)) return;
      const how = answer(res);
      if (how === 'retry') return;
      onTheWay.delete(wayKey(op));
      if (how === 'gone') { forget(); emit('onChange'); emit('onGone'); return; }
      if (how === 'refused') { drop(op); changed(); emit('onRefused', op, res.error); }
      else settle(op, res.data);
      if (!queue.length) failing = false;
    }

    // ---- Reads
    function take(snapshot, ticket) {
      if (stopped || !snapshot || typeof snapshot !== 'object') return false;
      if (ticket != null && ticket !== writes) return false;
      snap = snapshotOf(snapshot);
      fresh = true;
      save();
      if (failing && queue.length && !inflight) setTimeout(kick, 0);   // the database answers again: send what waits
      return true;
    }

    // ---- What the page draws
    // The last list with the changes still waiting laid over it (out), and the bought line each waiting
    // add brings back on the list (backs: the add's id → the line's id). A row a waiting change moved
    // has no seen of its own (null) until that change is answered: a tap on it takes its seen from that
    // change's reply, or from the list in it.
    function overlay() {
      if (!snap) return null;
      const out = JSON.parse(JSON.stringify(snap));
      const backs = new Map();
      const lk = listKey(out);
      let toBuy = Array.isArray(out[lk]) ? out[lk] : [];
      let bought = Array.isArray(out.bought) ? out.bought : [];
      const myDay = lk === 'items';
      const mark = (r) => Object.assign(r, { pending: true, unsent: failing });
      const take1 = (list, item) => {
        const i = list.findIndex((r) => r.id === item);
        return i < 0 ? null : list.splice(i, 1)[0];
      };
      queue.forEach((op) => {
        if (op.op === 'buy') {
          const r = take1(toBuy, op.item);
          if (!r) return;
          if (myDay) r.undo = true;
          else if (o.who) r.bought_by = o.who;
          delete r.added_by;
          delete r.other;
          r.seen = null;   // its bought_at comes in the reply
          bought.unshift(mark(r));
        } else if (op.op === 'unbuy') {
          const r = take1(bought, op.item) || (op.show && !toBuy.some((x) => x.id === op.item) ? Object.assign({ id: op.item, seen: null }, op.show) : null);
          if (!r) return;
          delete r.undo;
          delete r.bought_by;
          r.seen = null;   // its added_at comes in the reply
          if (!myDay && o.who && !('added_by' in r)) r.added_by = o.who;
          toBuy.push(mark(r));
        } else {
          const p = parse(op.name);
          const k = nameKey(p.name);
          const priv = !!op.private;
          const exact = (r) => nameKey(r.name) === k;
          const twin = (r) => !!r.other && nameKey(r.other) === k;
          // The line it lands on, as the database looks (§4.1): the one with this name and this lock, to
          // buy or bought; else the other lock's, to buy or bought; else a twin in the other language,
          // while it is to buy (this lock first). A line bought before today isn't in the list: if the
          // database takes it, settled() moves a tick waiting for this add to it.
          const lock = (x) => myDay || !!x.private === priv;
          const pick = (list, match) => list.find((x) => match(x) && lock(x)) || list.find(match);
          let r = toBuy.find((x) => exact(x) && lock(x)) || null;
          let back = r ? null : bought.find((x) => exact(x) && lock(x)) || null;
          if (!r && !back) r = toBuy.find(exact) || null;
          if (!r && !back) back = bought.find(exact) || null;
          if (!r && !back) r = pick(toBuy, twin) || null;
          if (r) {
            // Its note joins after " · ", unless the line's note has it already: the whole note, or a
            // run of its " · " parts (§4.1, as the database reads it).
            if (p.note && !` · ${r.note || ''} · `.includes(` · ${p.note} · `)) r.note = clean(r.note ? `${r.note} · ${p.note}` : p.note, 80);
          } else if (back) {
            r = back;
            bought = bought.filter((x) => x !== r);
            delete r.undo;
            delete r.bought_by;
            r.seen = null;   // the add gives it a new added_at
            r.note = p.note;
            toBuy.push(r);
            backs.set(op.id, r.id);
          } else {
            r = { id: null, name: p.name, note: p.note, aisle: 'other', seen: null };
            if (!myDay) Object.assign(r, { private: priv, added_by: o.who || null });
            toBuy.push(r);
          }
          if (priv && !myDay) r.private = true;
          mark(r);
          if (Array.isArray(out.suggest)) out.suggest = out.suggest.filter((x) => nameKey(x.name) !== k);
        }
      });
      toBuy = toBuy.sort(byName);
      out[lk] = toBuy;
      out.bought = bought;
      return { out, backs };
    }
    function view() {
      const laid = overlay();
      return laid && laid.out;
    }

    function waitingSince() {
      return queue.reduce((m, x) => Math.min(m, x.at), Infinity);
    }
    function state() {
      const unsent = failing ? queue.length : 0;
      return {
        waiting: queue.length,
        unsent,
        banner: unsent && Date.now() - waitingSince() >= BANNER_MS ? unsent : 0,
        busy: !!inflight,
        fresh,
      };
    }
    // Draw again when the oldest change not sent yet reaches 15 seconds, so the banner appears.
    function scheduleBanner() {
      clearTimeout(bannerTimer);
      bannerTimer = null;
      if (stopped || !failing || !queue.length) return;
      const left = waitingSince() + BANNER_MS - Date.now();
      if (left > 0) bannerTimer = setTimeout(() => { bannerTimer = null; emit('onChange'); }, left + 10);
    }

    function kick() {
      if (stopped) return;
      if (inflight) { again = true; return; }
      pump();
    }

    function forget() {
      queue = [];
      snap = null;
      ownBuys.clear();
      failing = false;
      tries = 0;
      clearTimeout(timer);
      clearTimeout(bannerTimer);
      timer = null;
      bannerTimer = null;
      if (key) { try { localStorage.removeItem(key); } catch (err) { /* nothing was kept */ } }
    }

    function stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(bannerTimer);
      timer = null;
      bannerTimer = null;
    }

    if (failing) scheduleBanner();

    return Object.freeze({
      add,
      buy: (row) => queueTick('buy', row),
      unbuy: (row) => queueTick('unbuy', row),
      view,
      ticket: () => writes,
      take,
      state,
      kick,
      forget,
      stop,
    });
  }

  window.HomeShop = Object.freeze({
    KEYS, POLL_MS, HOLD_MS, RETRY_MS: Object.freeze(RETRY_MS.slice()), BANNER_MS, EXPIRE_MS,
    AISLES, aisleName, groups, byName, nameKey, fold, withOther, matches, parse, clean, sameList,
    answer, tokenOwner, hold, outbox,
  });
})();
