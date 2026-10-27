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
                  { op: 'add', name, private }   add_to_list(p_name: name, p_private: private) /
                                                 add_to_list_by_token(p_token, p_name: name)
                  { op: 'buy',   item, seen }    buy_item(p_item: item, p_bought: true,  p_seen: seen)
                  { op: 'unbuy', item, seen }    buy_item(p_item: item, p_bought: false, p_seen: seen)
                                                 (My day: the same through buy_item_by_token)
                name is the text as typed; seen is the row's state as the phone saw it, a string,
                sent back as it came (never through a Date: it keeps microseconds).
       who      optional, the Food page: the signed-in person's id, as added_by / bought_by on rows
                that are waiting
       mine(row) optional: a bought row is this phone's own purchase (Food: row.bought_by === me;
                My day: row.undo). It lets an Undo pressed before its tick was answered still undo
                that tick when the reply to a resend says "already bought".
       visible() optional: whether to retry now (default: the page isn't hidden)
       onChange()                    what view() or state() gives has changed: draw the list again
                                     (when no finger is on it, see hold())
       onReply(op, reply, outcome)   a change was answered. outcome: for an add, reply.result
                                     ('added' | 'back' | 'already', reply.name is the line's name);
                                     for a tick, 'done' (changed), 'same' (it was already so: a resend
                                     after a lost reply; say nothing) or 'changed' (someone else
                                     changed it first: say "Changed on another phone")
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
                          reply. A tick and its Undo cancel out while the tick has never left the
                          phone; once it has, both are sent, in order. False when there is nothing to do.
     box.view()           the last list with the changes still waiting laid over it, or null before
                          any list. Rows changed by a waiting change carry pending: true, and
                          unsent: true while the outbox can't get an answer ("Not sent yet").
                          A waiting add of something new is a row with id null (no box to tick).
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
     box.stop()           the page closed (ctx.signal, or My day leaving #list): no more sends,
                          timers or saves. Whatever is waiting stays saved for next time.
   A tap is sent at once, unless nothing is getting through: then it waits its turn behind the rest.
   Retries: 2, 5, 10 and 30 seconds after a change gets no answer (or a 5xx, 408 or 429), then every
   30 seconds while the page is visible. Changes older than 24 hours are dropped.
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
  function outbox(options) {
    const o = options || {};
    const key = o.key;
    const owner = o.owner == null ? null : String(o.owner);
    const send = o.send;
    const visible = o.visible || (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
    // The page's callbacks (a callback that throws is reported and doesn't stop the outbox).
    const emit = (name, ...args) => { if (typeof o[name] === 'function') { try { o[name](...args); } catch (err) { console.error(err); } } };

    let queue = [];         // { id, op, item?, seen?, name?, private?, show?, at, sent, after? }, oldest first
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
    let seq = 0;
    const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

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
    const lastFor = (item) => {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].item === item) return queue[i];
      return null;
    };
    // Drop a change and everything that was waiting for its reply.
    function drop(op) {
      const gone = new Set([op.id]);
      let more = true;
      while (more) {
        more = false;
        queue.forEach((x) => { if (x.after && gone.has(x.after) && !gone.has(x.id)) { gone.add(x.id); more = true; } });
      }
      queue = queue.filter((x) => !gone.has(x.id));
      return gone.size;
    }
    const rowsOf = (s, which) => (s && Array.isArray(s[which === 'bought' ? 'bought' : listKey(s)]) ? s[which === 'bought' ? 'bought' : listKey(s)] : []);
    const idOf = (row) => (row && typeof row === 'object' ? row.id : row);
    const showOf = (row) => (row && typeof row === 'object'
      ? { name: row.name, note: row.note == null ? null : row.note, aisle: row.aisle || 'other', private: !!row.private, other: row.other } : null);

    function queueTick(kind, row) {
      const item = idOf(row);
      if (stopped || item == null) return false;
      const inverse = kind === 'buy' ? 'unbuy' : 'buy';
      const last = lastFor(item);
      if (last && last.op === kind) return false;   // already waiting to do just that
      if (last && last.op === inverse && !last.sent) {
        // Never left the phone: the two cancel out.
        drop(last);
        changed();
        return true;
      }
      const op = { id: nextId(), op: kind, item, seen: null, show: showOf(row), at: Date.now(), sent: false };
      if (last) {
        op.after = last.id;   // its seen comes from that change's reply
      } else {
        // The row as the phone showed it; given only an id (Undo from a toast), the row as the list
        // has it now.
        const shown = row && typeof row === 'object' ? row.seen : null;
        const now = rowsOf(snap, kind === 'buy' ? 'to_buy' : 'bought').find((r) => r.id === item);
        op.seen = shown != null ? shown : now ? now.seen : null;
        if (op.seen == null) return false;
      }
      queue.push(op);
      changed();
      send1();
      return true;
    }

    function add(text, priv) {
      if (stopped || !parse(text).name) return false;
      queue.push({ id: nextId(), op: 'add', name: String(text), private: !!priv, at: Date.now(), sent: false });
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

    async function pump() {
      if (stopped || inflight) return;
      clearTimeout(timer);
      timer = null;
      dropExpired();
      while (!stopped && !inflight && queue.length) {
        const op = queue[0];
        if (op.op !== 'add' && op.seen == null) { drop(op); changed(); continue; }   // its reply never gave one
        inflight = op;
        op.sent = true;   // once it has left the phone, an Undo no longer cancels it
        save();
        emit('onChange');
        let res;
        try {
          res = await send(op.op === 'add' ? { op: 'add', name: op.name, private: op.private }
            : { op: op.op, item: op.item, seen: op.seen });
        } catch (err) {
          res = { data: null, error: err, status: 0 };
        }
        inflight = null;
        if (stopped) return;
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

    // A change was answered: take the list in the reply, give the changes waiting for this one their
    // seen, and say what happened.
    function settle(op, reply) {
      queue = queue.filter((x) => x !== op);
      snap = snapshotOf(reply);
      fresh = true;
      writes++;
      let outcome = reply.result;
      if (op.op !== 'add') {
        const done = reply.changed === true;
        const where = op.op === 'buy' ? 'bought' : 'to_buy';
        const row = rowsOf(snap, where).find((r) => r.id === op.item);
        const ours = !!row && (done || (op.op === 'buy' && typeof o.mine === 'function' && !!o.mine(row)));
        outcome = done ? 'done' : row ? 'same' : 'changed';
        queue.filter((x) => x.after === op.id).forEach((next) => {
          if (ours) { next.seen = row.seen; delete next.after; return; }
          drop(next);
          // Undo (or a tick) that can no longer be done as asked: the list shows it as it is now.
          const now = rowsOf(snap, next.op === 'buy' ? 'bought' : 'to_buy').find((r) => r.id === next.item);
          if (!now) outcome = 'changed';
        });
      }
      changed();
      emit('onReply', op, reply, outcome);
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
    function view() {
      if (!snap) return null;
      const out = JSON.parse(JSON.stringify(snap));
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
          bought.unshift(mark(r));
        } else if (op.op === 'unbuy') {
          const r = take1(bought, op.item) || (op.show && !toBuy.some((x) => x.id === op.item) ? Object.assign({ id: op.item, seen: null }, op.show) : null);
          if (!r) return;
          delete r.undo;
          delete r.bought_by;
          if (!myDay && o.who && !('added_by' in r)) r.added_by = o.who;
          toBuy.push(mark(r));
        } else {
          const p = parse(op.name);
          const k = nameKey(p.name);
          const priv = !!op.private;
          const exact = (r) => nameKey(r.name) === k;
          const twin = (r) => !!r.other && nameKey(r.other) === k;
          // The line it lands on, as the database looks (§4.1): one with this name, with this lock
          // first, then the other lock; else a twin in the other language, while it is to buy.
          const pick = (list, match) => list.find((r) => match(r) && (myDay || !!r.private === priv))
            || list.find((r) => match(r) && (myDay || !r.private || !priv));
          let r = pick(toBuy, exact);
          let back = null;
          if (!r) back = pick(bought, exact);
          if (!r && !back) r = pick(toBuy, twin);
          if (r) {
            if (p.note && !String(r.note || '').includes(p.note)) r.note = clean(r.note ? `${r.note} · ${p.note}` : p.note, 80);
          } else if (back) {
            r = back;
            bought = bought.filter((x) => x !== r);
            delete r.undo;
            delete r.bought_by;
            r.note = p.note;
            toBuy.push(r);
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
      return out;
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
