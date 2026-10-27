/* =====================================================================
   HOME HUB — Food (schema 4): this week's dinners and the shopping list
   #/food, and #/food/<YYYY-MM-DD> for that day's dinner (docs/v1.2-kitchen.md
   §5, §6.1, §8).
   - Dinners: one card a day for the next 7 days, today first. A card opens
     the dinner dialog (a name or one of the quick kinds, who cooks, a note,
     a recipe link, the lock; Save, Clear this day, Add a prep reminder…).
     A family that hasn't planned a dinner for two weeks sees one line,
     "Plan dinners ›", so the list comes first.
   - The shopping list: the add box (with suggestions from the household's
     own items, and a lock for the next add), To buy by aisle, Just bought,
     Buy again (folded), Edit and Forget, "Send Taylor the list", and the
     parents' two switches.
   - Tap = bought: the row is struck through where it is and moves only 3
     seconds after the last tap on the list, as does a change another phone
     made. The list is read again every 10 seconds while the page is
     visible; nothing is redrawn when nothing changed.
   - Every change to the list goes through the outbox in assets/shoplist.js
     (window.HomeShop), so a tap shows at once, waits on the phone when there
     is no signal ("Not sent yet"), and is saved on this device for whoever is
     signed in. When the list can't be read, the saved one is drawn.
   provides: { openListAdd } for the Add sheet's Shopping choice (§6.3).
   Dates are the household's (core.v2), never the device's.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { q, toast, friendly, firstName, smsHref, whatsappHref, wireFormDialog, formDialog, detailDialog } = core;
  const { esc, plural } = core.G;
  const { v2 } = core;
  const { call, fmt, dates, ui } = v2;
  const S = window.HomeShop;
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  // The Food page on screen (its state), for openListAdd(); null when it isn't.
  let live = null;

  // Buy again open or closed, remembered on this device.
  const AGAIN_KEY = 'homehub.food.buyAgain';
  function againOpen() {
    try { return localStorage.getItem(AGAIN_KEY) === 'open'; } catch (e) { return false; }
  }
  function setAgainOpen(open) {
    try { localStorage.setItem(AGAIN_KEY, open ? 'open' : 'closed'); } catch (e) { /* storage unavailable: folded next time */ }
  }

  const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';
  const DOTS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
  const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

  // ============================================
  // DINNERS: words and people
  // ============================================
  const QUICK = [['leftovers', 'Leftovers'], ['out', 'Eating out'], ['takeout', 'Takeout'], ['fend', 'Fend for yourself']];
  const KIND_WORD = Object.fromEntries(QUICK);
  // Eating out and Fend for yourself have nobody on them; Leftovers and Takeout have "who's on dinner".
  const NOBODY = ['out', 'fend'];
  const mealTitle = (m) => (m.kind === 'cook' ? m.title || '' : KIND_WORD[m.kind] || '');

  // An inactive person counts as nobody, as in the email and on My day.
  const activePerson = (id) => { const p = id && v2.person(id); return p && p.active !== false ? p : null; };
  // First names, or full names for people who share a first name (as the core's person chips).
  function shortName(p) {
    const first = firstName(p.name);
    return v2.people().some((x) => x.id !== p.id && firstName(x.name) === first) ? p.name : first;
  }
  // "Sam cooks", "Sam's on dinner", "You cook", "You're on dinner"; '' for nobody.
  function cookWords(m) {
    const p = NOBODY.includes(m.kind) ? null : activePerson(m.cook_id);
    if (!p) return '';
    const me = v2.mePerson && v2.mePerson.id === p.id;
    if (m.kind === 'cook') return me ? 'You cook' : `${shortName(p)} cooks`;
    return me ? 'You\'re on dinner' : `${shortName(p)}'s on dinner`;
  }

  const weekday = (iso) => fmt.day(iso).slice(0, 3);
  // A recipe link as the database keeps it (§3.2): https only, printable ASCII, from new URL(typed).href.
  // "cooking.example.com/tacos" gets its https:// added; anything else that isn't https is refused (null).
  function recipeLink(typed) {
    let s = String(typed || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
    let url;
    try { url = new URL(s); } catch (err) { return null; }
    if (url.protocol !== 'https:' || !url.hostname) return null;
    return /^https:\/\/[!#-;=?-~]{4,500}$/.test(url.href) ? url.href : null;
  }
  const hostOf = (link) => { try { return new URL(link).hostname; } catch (err) { return ''; } };

  // ============================================
  // DINNERS: reading
  // ============================================
  // The 15 days before and this week (the 14 days before decide the folded row). A failed read is
  // said in one line; it never stops the list.
  async function loadMeals(st) {
    const today = dates.today();
    st.today = today;
    const near = q(core.sb.from('meals').select('id,day,slot,kind,title,cook_id,note,link,private,updated_at').eq('slot', 'dinner')
      .gte('day', dates.addDays(today, -14)).lte('day', dates.addDays(today, 6)).order('day'));
    // Suggestions: the 8 most frequent cooked titles of the last 180 days, counted here; picking one
    // also fills its latest recipe link.
    const past = q(core.sb.from('meals').select('day,title,link').eq('kind', 'cook').gte('day', dates.addDays(today, -180)).lte('day', today)
      .order('day', { ascending: false }));
    try {
      st.meals = { rows: (await near) || [], loaded: true, failed: false };
    } catch (err) {
      st.meals = { rows: st.meals.rows, loaded: true, failed: true };
    }
    try {
      const by = new Map();
      ((await past) || []).forEach((r) => {
        const title = String(r.title || '').trim();
        if (!title) return;
        const key = title.toLowerCase();
        if (!by.has(key)) by.set(key, { title, n: 0, day: r.day, link: null });
        const s = by.get(key);
        s.n++;
        if (!s.link && r.link) s.link = r.link;
      });
      st.suggest = [...by.values()].sort((a, b) => b.n - a.n || (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)).slice(0, 8);
    } catch (err) { /* no suggestions this time */ }
  }

  const mealOn = (st, day) => st.meals.rows.find((m) => m.day === day && m.slot === 'dinner') || null;

  // ============================================
  // DINNERS: the week row
  // ============================================
  function drawWeek(st) {
    const box = st.main.querySelector('[data-ref="week"]');
    if (!box) return;
    const today = st.today;
    const head = ui.sectionHeading('This week\'s dinners');
    if (!st.meals.loaded) { box.innerHTML = `${head}<p class="empty-line">Loading dinners…</p>`; return; }
    if (st.meals.failed) {
      box.innerHTML = `${head}<p class="food-fail" role="status">Dinners couldn't be loaded. <button type="button" class="linkbtn food-retry" data-act="meals-retry">Try again</button></p>`;
      return;
    }
    const days = Array.from({ length: 7 }, (x, i) => dates.addDays(today, i));
    const planned = st.meals.rows.some((m) => m.day >= dates.addDays(today, -14) && m.day <= days[6]);
    if (!planned && !st.unfold) {
      box.innerHTML = '<button type="button" class="food-plan" data-act="unfold">Plan dinners <span aria-hidden="true">›</span></button>';
      return;
    }
    box.innerHTML = `${head}<div class="food-week" role="list">${days.map((d, i) => {
      const m = mealOn(st, d);
      const title = m ? mealTitle(m) : '';
      const p = m && !NOBODY.includes(m.kind) ? activePerson(m.cook_id) : null;
      const label = `${i === 0 ? 'Today, ' : ''}${fmt.dayLong(d)}: ${m ? [title, cookWords(m), m.private ? 'locked' : ''].filter(Boolean).join(', ') : 'nothing planned'}`;
      return `<div role="listitem" class="food-day-item"><button type="button" class="food-day${i === 0 ? ' is-today' : ''}${m ? '' : ' is-empty'}" data-act="day" data-day="${d}" aria-label="${esc(label)}" title="${esc(fmt.dayLong(d))}">
        <span class="food-day-label">${i === 0 ? 'Today' : esc(weekday(d))}</span>
        <span class="food-day-title">${m ? esc(title) : '—'}${m && m.private ? `<span class="food-lockmark">${LOCK}</span>` : ''}</span>
        ${p ? `<span class="food-day-cook">${esc(shortName(p))}</span>` : ''}
      </button></div>`;
    }).join('')}</div>`;
  }

  // ============================================
  // DINNERS: the dialog
  // ============================================
  // A day's dinner: what, who, More (note, recipe link, lock); Save upserts on (day, slot). On a
  // dinner already saved, also Clear this day and Add a prep reminder… (the task form takes over the
  // dialog, so it is offered only when nothing unsaved would be lost).
  async function openDinner(st, day) {
    let m = mealOn(st, day);
    if (!m && (day < dates.addDays(st.today, -14) || day > dates.addDays(st.today, 6))) {
      // A day outside the week (an old link): read it on its own.
      m = ((await q(core.sb.from('meals').select('id,day,slot,kind,title,cook_id,note,link,private,updated_at').eq('day', day).eq('slot', 'dinner'))) || [])[0] || null;
      if (st.ctx.stale()) return;
    }
    const x = m || {};
    const state = { kind: m ? m.kind : 'cook', cook: m && !NOBODY.includes(m.kind) ? x.cook_id || null : null };
    const people = v2.people().filter((p) => p.active !== false || p.id === state.cook);
    const moreOpen = !!(x.note || x.link || x.private);

    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = `<form class="form d-inner food-dinner" novalidate autocomplete="off">
      <div class="d-top"><h3>Dinner · ${esc(day === st.today ? 'Today' : fmt.day(day))}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <label class="field"><span>What's for dinner?</span><input type="text" name="title" maxlength="80" value="${esc(x.kind === 'cook' ? x.title || '' : '')}" placeholder="Tacos"></label>
      ${st.suggest.length ? `<div class="food-chips food-sugg" role="group" aria-label="Our dinners">${st.suggest.map((s, i) =>
        `<button type="button" class="food-chip" data-sugg="${i}">${esc(s.title)}</button>`).join('')}</div>` : ''}
      <div class="food-chips food-kinds" role="group" aria-label="Or one tap">${QUICK.map(([k, l]) =>
        `<button type="button" class="food-chip" data-kind="${k}" aria-pressed="false">${esc(l)}</button>`).join('')}</div>
      <fieldset class="food-fs" data-ref="cookset"><legend data-ref="cooklabel">Who cooks?</legend>
        <div class="who-chips" role="group" data-ref="cooks">${people.map((p) => ui.personChip(p, { selected: p.id === state.cook })).join('')}</div>
        <small class="who-hint">Optional. They see the note and the recipe on their My day and in their email.</small>
      </fieldset>
      <details class="food-more"${moreOpen ? ' open' : ''}><summary>More</summary>
        <label class="field"><span>Note</span><textarea name="note" maxlength="300" rows="2" placeholder="Chicken is in the freezer · 350° for 20 min">${esc(x.note || '')}</textarea>
          <small>For whoever cooks.</small></label>
        <label class="field" data-ref="linkfield"><span>Recipe link</span><input type="url" name="link" inputmode="url" value="${esc(x.link || '')}" placeholder="https://cooking.example.com/tacos">
          <small data-ref="linkhost">${x.link ? `Opens <a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(x.link))}</a>` : 'An https:// address.'}</small></label>
        <label class="check food-check"><input type="checkbox" name="private"${x.private ? ' checked' : ''}> Keep the title private</label>
        <small class="food-help">Off the wall, other people's My day and email subjects. Grown-ups who sign in still see it.</small>
      </details>
      ${m ? `<div class="food-prep"><button type="button" class="btn" data-act="prep">Add a prep reminder…</button>
        <small>A task for the day before (today, for tonight's). It stays put if the dinner moves.</small></div>` : ''}
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions">
        ${m ? '<button type="button" class="btn btn-danger left" data-act="clear">Clear this day</button>' : ''}
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`;
    const form = formDialog.querySelector('form');
    const el = form.elements;
    const errBox = form.querySelector('.form-error');
    const fail = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
    const ref = (name) => form.querySelector(`[data-ref="${name}"]`);

    function paint() {
      form.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === state.kind)));
      ref('cookset').hidden = NOBODY.includes(state.kind);
      ref('cooklabel').textContent = state.kind === 'leftovers' || state.kind === 'takeout' ? 'Who\'s on dinner?' : 'Who cooks?';
      ref('linkfield').hidden = state.kind !== 'cook';
      form.querySelectorAll('[data-ref="cooks"] [data-person]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.person === state.cook)));
      const typed = S.nameKey(el.title.value);
      form.querySelectorAll('[data-sugg]').forEach((b) => b.setAttribute('aria-pressed', String(!!typed && S.nameKey(st.suggest[+b.dataset.sugg].title) === typed)));
    }
    paint();

    el.title.addEventListener('input', () => {
      if (el.title.value.trim() && state.kind !== 'cook') state.kind = 'cook';
      paint();
    });
    form.addEventListener('click', (e) => {
      const kind = e.target.closest('[data-kind]');
      if (kind) {
        state.kind = state.kind === kind.dataset.kind ? 'cook' : kind.dataset.kind;
        if (state.kind !== 'cook') el.title.value = '';
        paint();
        return;
      }
      const sugg = e.target.closest('[data-sugg]');
      if (sugg) {
        const s = st.suggest[+sugg.dataset.sugg];
        state.kind = 'cook';
        el.title.value = s.title;
        if (s.link) {
          el.link.value = s.link;
          form.querySelector('.food-more').open = true;
        }
        paint();
        return;
      }
      const chip = e.target.closest('[data-ref="cooks"] [data-person]');
      if (chip) {
        state.cook = state.cook === chip.dataset.person ? null : chip.dataset.person;
        paint();
        chip.focus();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'clear') clearDay(st, day, act, fail);
      else if (act && act.dataset.act === 'prep') prepReminder(st, m, fail, !!m.private || el.private.checked);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const title = S.clean(el.title.value, 80);
      if (state.kind === 'cook' && !title) { fail('Type what\'s for dinner, or tap Leftovers, Eating out, Takeout or Fend for yourself.'); return; }
      const link = state.kind === 'cook' ? recipeLink(el.link.value) : '';
      if (link === null) { fail('The recipe link has to be a web address starting with https://.'); return; }
      const row = {
        day, slot: 'dinner', kind: state.kind, title: state.kind === 'cook' ? title : null,
        cook_id: NOBODY.includes(state.kind) ? null : state.cook, note: S.clean(el.note.value, 300) || null,
        link: link || null, private: el.private.checked,
      };
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        await q(core.sb.from('meals').upsert(row, { onConflict: 'day,slot' }).select('id'));
      } catch (err) {
        btn.disabled = false;
        fail(friendly(err));
        return;
      }
      formDialog.close();
      toast(`Dinner ${day === st.today ? 'tonight' : `on ${weekday(day)}`}: ${mealTitle(row)}`);
      if (st.ctx.stale()) return;
      await loadMeals(st);
      if (!st.ctx.stale()) drawWeek(st);
    });

    // Closing it leaves #/food/<date> for #/food, so a reload doesn't open it again.
    formDialog.addEventListener('close', () => {
      if (!st.ctx.stale() && /^#\/food\/\d{4}-\d{2}-\d{2}$/.test(location.hash)) history.replaceState(null, '', '#/food');
    }, { once: true });
    if (!formDialog.open) formDialog.showModal();
    if (window.innerWidth > 700) el.title.focus();
  }

  async function clearDay(st, day, btn, fail) {
    btn.disabled = true;
    try {
      await q(core.sb.from('meals').delete().eq('day', day).eq('slot', 'dinner'));
    } catch (err) {
      btn.disabled = false;
      fail(friendly(err));
      return;
    }
    formDialog.close();
    toast(`Cleared ${day === st.today ? 'tonight\'s' : `${weekday(day)}'s`} dinner`);
    if (st.ctx.stale()) return;
    await loadMeals(st);
    if (!st.ctx.stale()) drawWeek(st);
  }

  // A prep reminder is an ordinary task (§5): "Prep: Tacos", due the day before or, for tonight's,
  // today (never born Late), the cook in charge, family; saving it comes back to Food.
  // A locked dinner's is a private task (Private ticked under More), so "Prep: <title>" stays off the
  // wall, other people's My day and every email subject as the dinner's title does. `locked` is the
  // saved lock or the box ticked in the dialog now: either one keeps the title private.
  function prepReminder(st, m, fail, locked) {
    let open;
    try { open = core.use('tasks').openTaskForm; } catch (err) { fail(friendly(err)); return; }
    if (typeof open !== 'function') { fail('Adding tasks isn\'t available yet. Reload the page to get the latest version.'); return; }
    const before = dates.addDays(m.day, -1);
    const cook = NOBODY.includes(m.kind) ? null : activePerson(m.cook_id);
    Promise.resolve(open({
      title: `Prep: ${mealTitle(m)}`,
      date: before > dates.today() ? before : dates.today(),
      responsible_id: cook ? cook.id : null,
      category: 'family',
      private: !!locked,
      onSaved() {
        toast('Prep reminder added');
        if (location.hash !== '#/food') location.hash = '#/food';
        else if (!st.ctx.stale()) loadMeals(st).then(() => { if (!st.ctx.stale()) drawWeek(st); });
      },
    })).catch((err) => toast(friendly(err), { error: true }));
  }

  // ============================================
  // THE LIST: reading
  // ============================================
  // The household's date of an instant (bought_at), in its time zone.
  function householdDate(instant) {
    const o = {};
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: (v2.household && v2.household.tz) || (v2.clock && v2.clock.tz) || 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)).forEach((p) => { o[p.type] = p.value; });
    } catch (e) { return ''; }
    return o.year ? `${o.year}-${o.month}-${o.day}` : '';
  }

  // Every line the household has (suggestions and Buy again): on open, on focus and after a put-back.
  async function loadItems(st) {
    try {
      st.items = (await q(core.sb.from('shopping_items').select('id,name,note,aisle,private,added_at,bought_at'))) || [];
    } catch (err) { /* keep what was read before */ }
  }

  // shopping_list(): one read at a time, none while a change is on its way, no redraw when the answer
  // is the same. Every 10 seconds while the page is visible, and at once on focus, visibilitychange
  // and online. Asked for while a read is on its way (after an edit), it reads again when that one is back.
  async function poll(st) {
    if (st.reading) { st.readAgain = true; return; }
    clearTimeout(st.pollTimer);
    st.pollTimer = null;
    if (st.ctx.stale()) return;
    if (document.visibilityState === 'hidden') return;   // visibilitychange starts it again
    if (st.box.state().busy) { st.pollTimer = setTimeout(() => poll(st), S.POLL_MS); return; }
    st.reading = true;
    const ticket = st.box.ticket();
    let res;
    try { res = await core.sb.rpc('shopping_list'); } catch (err) { res = { data: null, error: err }; }
    st.reading = false;
    if (st.ctx.stale()) return;
    if (!res.error && res.data && typeof res.data === 'object') {
      st.listFailed = false;
      st.box.take(res.data, ticket);
    } else {
      st.listFailed = true;
    }
    requestDraw(st);
    const again = st.readAgain;
    st.readAgain = false;
    st.pollTimer = setTimeout(() => poll(st), again ? 0 : S.POLL_MS);
  }

  // ============================================
  // THE LIST: drawing
  // ============================================
  // A list move (a tick's row, a poll's change) waits until 3 seconds after the last tap on the list.
  const requestDraw = (st) => { if (!st.ctx.stale()) st.hold.request(); };

  // '3:42pm', or 'Mon 3:42pm' when it isn't today: the database's as_of, never the phone's clock.
  function whenText(asOf) {
    const s = String(asOf || '');
    const day = s.slice(0, 10);
    const time = fmt.time(`${s.slice(11, 16)}:00`);
    if (!ISO_DATE.test(day) || !time) return 'earlier';
    return day === dates.today() ? time : `${weekday(day)} ${time}`;
  }

  // Lines bought in the 60 days before today and not on the list now (from the table read).
  function buyAgain(st, v) {
    const shown = new Set((v.to_buy || []).concat(v.bought || []).map((r) => r.id));
    const today = dates.today();
    const from = dates.addDays(today, -60);
    return (st.items || []).filter((r) => {
      if (!r.bought_at || shown.has(r.id)) return false;
      const d = householdDate(r.bought_at);
      return d >= from && d < today;
    });
  }

  function rowHTML(st, r, where) {
    const key = `${where}:${r.id}`;
    if (r.id) st.rowData.set(key, r);
    const other = r.other && S.fold(r.other) !== S.fold(r.name) ? `<small class="food-other"> · ${esc(r.other)}</small>` : '';
    const what = `<span class="food-what"><span class="food-line"><span class="food-name">${esc(r.name)}</span>${other}${r.private
      ? `<span class="food-lockmark" title="Locked">${LOCK}<span class="sr-only">, locked</span></span>` : ''}</span>${r.note ? `<small class="food-note">${esc(r.note)}</small>` : ''}${r.unsent
      ? '<small class="food-unsent">Not sent yet</small>' : ''}</span>`;
    const who = where === 'buy' ? r.added_by : where === 'bought' ? r.bought_by : null;
    const dot = who && v2.person(who) ? `<span class="food-dot">${ui.personDot(v2.person(who))}</span>` : '';
    let main;
    if (!r.id) main = `<div class="food-tick is-waiting">${what}</div>`;   // an add not sent yet: no box until it has an id
    else if (where === 'again') {
      main = `<button type="button" class="food-tick food-again-btn" data-act="again" aria-label="Put ${esc(r.name)} back on the list"><span class="food-plus" aria-hidden="true">${PLUS}</span>${what}</button>`;
    } else {
      main = `<button type="button" class="food-tick" role="checkbox" aria-checked="${where === 'bought'}" data-act="tick"><span class="food-box" aria-hidden="true">${ui.icon.check}</span>${what}</button>`;
    }
    const picking = where === 'buy' && r.id && (r.aisle || 'other') === 'other';
    const open = picking && st.aislePick === r.id;
    return `<div class="food-row${where === 'buy' ? '' : ' is-bought'}${r.pending ? ' is-pending' : ''}" data-id="${esc(r.id || '')}" data-where="${where}">
      ${main}${dot}${picking ? `<button type="button" class="food-aisle-q" data-act="aisle" aria-expanded="${open}" aria-label="Choose an aisle for ${esc(r.name)}">Aisle?</button>` : ''}${r.id
      ? `<button type="button" class="food-menu" data-act="edit" aria-label="Edit ${esc(r.name)}">${DOTS}</button>` : ''}
    </div>${open ? `<div class="food-aisle-pick" role="group" aria-label="Aisle for ${esc(r.name)}">${S.AISLES.map((a) =>
      `<button type="button" class="food-chip" data-act="set-aisle" data-aisle="${a.key}" data-for="${esc(r.id)}" aria-pressed="${a.key === 'other'}">${esc(a.en)}</button>`).join('')}</div>` : ''}`;
  }

  // One card, the aisles in store order inside it, each under its name.
  const groupsHTML = (st, rows, where) => `<div class="food-card food-groups">${S.groups(rows, 'en').map((g) => `<div class="food-group" data-aisle="${g.key}">
      <h3 class="food-aisle">${esc(g.name)}</h3>${g.rows.map((r) => rowHTML(st, r, where)).join('')}</div>`).join('')}</div>`;

  function listHTML(st) {
    st.rowData = new Map();
    st.tapped = new Set();   // rows ticked or unticked here since this draw ("where:id")
    const v = st.box.view();
    const s = st.box.state();
    if (!v) {
      return st.listFailed
        ? '<p class="food-fail" role="status">The shopping list couldn\'t be loaded. Check the connection. <button type="button" class="linkbtn food-retry" data-act="retry">Try again</button></p>'
        : '<p class="empty-line">Loading the list…</p>';
    }
    const out = [];
    if (st.listFailed) {
      out.push(`<p class="banner banner-warn food-offline" role="status">No connection: this is the list from ${esc(whenText(v.as_of))}. <button type="button" class="linkbtn food-retry" data-act="retry">Try again</button></p>`);
    }
    if (s.banner) out.push(`<p class="banner banner-warn food-unsent-banner" role="status">${esc(plural(s.banner, 'change'))} not sent yet. They'll go when there's signal; keep this page open.</p>`);
    const toBuy = v.to_buy || [];
    out.push(`<section class="food-part" data-part="buy" aria-label="To buy">${ui.sectionHeading('To buy', toBuy.length)}${toBuy.length
      ? groupsHTML(st, toBuy, 'buy') : '<p class="food-card empty-line food-empty">Nothing to buy.</p>'}</section>`);
    const bought = v.bought || [];
    if (bought.length) {
      out.push(`<section class="food-part" data-part="bought" aria-label="Just bought">${ui.sectionHeading('Just bought', bought.length)}
        <div class="food-card">${bought.map((r) => rowHTML(st, r, 'bought')).join('')}</div></section>`);
    }
    const again = buyAgain(st, v);
    if (again.length) {
      out.push(`<section class="food-part" data-part="again" aria-label="Buy again">
        <button type="button" class="food-again-toggle" data-act="buy-again" aria-expanded="${st.againOpen}" aria-controls="foodAgain">Buy again (${again.length}) <span aria-hidden="true">›</span></button>
        <div id="foodAgain"${st.againOpen ? '' : ' hidden'}>${groupsHTML(st, again.map((r) => Object.assign({}, r, { seen: r.bought_at })), 'again')}</div></section>`);
    }
    return out.join('');
  }

  // Draw the list again, unless it would come out the same (the add box is outside it, so its text and
  // focus never move; the scroll stays where it was).
  function drawList(st) {
    if (st.ctx.stale()) return;
    const box = st.main.querySelector('[data-ref="list"]');
    if (!box) return;
    const html = listHTML(st);
    if (html === st.drawn && !st.dirty) return;
    const active = document.activeElement;
    const row = active && box.contains(active) && active.closest('.food-row');
    const focusKey = row ? `${row.dataset.where}:${row.dataset.id}:${active.dataset.act || ''}` : null;
    const y = window.scrollY;
    box.innerHTML = html;
    st.drawn = html;
    st.dirty = false;
    st.draws++;
    if (window.scrollY !== y) window.scrollTo(window.scrollX, y);
    if (focusKey) {
      const [where, id, act] = focusKey.split(':');
      const again = box.querySelector(`.food-row[data-where="${where}"][data-id="${CSS.escape(id)}"]${act ? ` [data-act="${act}"]` : ''}`);
      if (again) again.focus();
    }
  }

  // ============================================
  // THE LIST: taps
  // ============================================
  // A row is ticked (or unticked) where it is; it moves 3 seconds after the last tap on the list.
  function tapRow(st, rowEl) {
    const id = rowEl.dataset.id;
    const where = rowEl.dataset.where;
    const btn = rowEl.querySelector('.food-tick[role="checkbox"]');
    if (!id || !btn) return;
    const checked = btn.getAttribute('aria-checked') === 'true';
    const drawnChecked = where === 'bought';
    const key = `${where}:${id}`;
    const data = st.rowData.get(key);
    // A row not tapped since it was drawn goes with the state it was shown in (its seen). One already
    // changed here goes by id, even when it is back as drawn (ticked and unticked): the outbox reverses
    // that change, or takes the seen from its reply or the list as it is now. Every un-tick gives the
    // line a new seen (§4.2), so the one it was drawn with would be refused.
    const arg = checked === drawnChecked && data && !st.tapped.has(key) ? data : id;
    const ok = checked ? st.box.unbuy(arg) : st.box.buy(arg);
    if (!ok) { notQueued(st, id, checked); return; }
    st.tapped.add(key);
    btn.setAttribute('aria-checked', String(!checked));
    st.dirty = true;
    const name = data ? data.name : rowEl.querySelector('.food-name').textContent;
    if (!checked) {
      toast(`Bought: ${name}`, { action: { label: 'Undo', onClick: () => undoTick(st, id) } });
    } else if (drawnChecked) {
      toast(`Back on the list: ${name}`);
    }
    requestDraw(st);
  }

  // A tap or Undo the outbox didn't queue: the list is drawn as it is now. An un-tick of a line that
  // is still bought says "Changed on another phone": this phone's tick found someone else had bought it
  // first, so the purchase isn't this phone's to undo (§8).
  function notQueued(st, id, untick) {
    const v = st.box.view();
    if (untick && v && (v.bought || []).some((r) => r.id === id)) toast('Changed on another phone');
    st.dirty = true;
    requestDraw(st);
  }

  // Undo from the "Bought" toast: un-tick it (in place, if it hasn't moved yet).
  function undoTick(st, id) {
    if (st.ctx.stale()) return;
    if (!st.box.unbuy(id)) { notQueued(st, id, true); return; }
    const btn = st.main.querySelector(`.food-row[data-where="buy"][data-id="${CSS.escape(id)}"] .food-tick`);
    if (btn) btn.setAttribute('aria-checked', 'false');
    st.tapped.add(`buy:${id}`);   // changed here: a tap on it now goes by id
    st.dirty = true;
    requestDraw(st);
  }

  // Buy again: one tap puts it back on the list (its seen is its bought_at, as PostgREST gave it).
  function putBack(st, rowEl) {
    const r = st.rowData.get(`again:${rowEl.dataset.id}`);
    if (!r || rowEl.classList.contains('is-done')) return;
    if (!st.box.unbuy({ id: r.id, seen: r.bought_at, name: r.name, note: r.note, aisle: r.aisle, private: r.private })) return;
    rowEl.classList.add('is-done');
    const plus = rowEl.querySelector('.food-plus');
    if (plus) plus.innerHTML = ui.icon.check;
    st.dirty = true;
    toast(`Back on the list: ${r.name}`);
    requestDraw(st);
  }

  // The Aisle? chip on a row under Other: the ten chips open under it, in place.
  function toggleAisle(st, rowEl) {
    const id = rowEl.dataset.id;
    const open = st.aislePick === id;
    st.main.querySelectorAll('.food-aisle-pick').forEach((x) => x.remove());
    st.main.querySelectorAll('.food-aisle-q[aria-expanded="true"]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
    st.aislePick = open ? null : id;
    if (!open) {
      const name = rowEl.querySelector('.food-name').textContent;
      rowEl.insertAdjacentHTML('afterend', `<div class="food-aisle-pick" role="group" aria-label="Aisle for ${esc(name)}">${S.AISLES.map((a) =>
        `<button type="button" class="food-chip" data-act="set-aisle" data-aisle="${a.key}" data-for="${esc(id)}" aria-pressed="${a.key === 'other'}">${esc(a.en)}</button>`).join('')}</div>`);
      rowEl.querySelector('.food-aisle-q').setAttribute('aria-expanded', 'true');
    }
    st.dirty = true;
  }

  async function setAisle(st, id, aisle, btn) {
    btn.disabled = true;
    try {
      const rows = await q(core.sb.from('shopping_items').update({ aisle }).eq('id', id).select('id'));
      if (!rows || !rows.length) throw new Error('That line isn\'t on the list any more.');
    } catch (err) {
      btn.disabled = false;
      toast(friendly(err), { error: true });
      return;
    }
    if (st.ctx.stale()) return;
    st.aislePick = null;
    toast(`Moved to ${S.aisleName(aisle, 'en')}`);
    st.dirty = true;
    loadItems(st);
    poll(st);
  }

  function toggleAgain(st, btn) {
    st.againOpen = !st.againOpen;
    setAgainOpen(st.againOpen);
    btn.setAttribute('aria-expanded', String(st.againOpen));
    const body = st.main.querySelector('#foodAgain');
    if (body) body.hidden = !st.againOpen;
    st.dirty = true;
  }

  // ============================================
  // THE LIST: adding
  // ============================================
  function lockHint() {
    const names = helpers().map((p) => `${firstName(p.name)}'s`);
    const where = names.length ? `${names.join(' and ')} My day` : 'My day links';
    return `Locked: not on ${where}. Every grown-up who signs in still sees it.`;
  }

  function wireAdd(st) {
    const form = st.main.querySelector('[data-ref="add"]');
    const input = form.elements.what;
    const lock = form.querySelector('[data-ref="lock"]');
    const hint = form.querySelector('[data-ref="lockhint"]');
    const list = form.querySelector('[data-ref="suggest"]');
    let shown = [];
    const setLock = (on) => {
      lock.setAttribute('aria-pressed', String(on));
      hint.hidden = !on;
      if (on) hint.textContent = lockHint();
    };
    // Up to 5 of the household's own lines: names with what was typed in them, and a line to buy also
    // by its other word; "on the list" when it is to buy; a lock on a locked one.
    function suggest() {
      const typed = input.value;
      const v = st.box.view() || {};
      const open = new Map((v.to_buy || []).map((r) => [r.id, r]));
      const byId = new Map();
      (st.items || []).forEach((r) => byId.set(r.id, { id: r.id, name: r.name, private: !!r.private }));
      (v.to_buy || []).concat(v.bought || []).forEach((r) => { if (r.id) byId.set(r.id, Object.assign(byId.get(r.id) || {}, { id: r.id, name: r.name, private: !!r.private })); });
      const rows = [...byId.values()].map((r) => Object.assign(r, { other: open.has(r.id) ? open.get(r.id).other : null }));
      shown = S.fold(typed).length ? S.matches(rows, typed, 5) : [];
      list.innerHTML = shown.map((r, i) => `<li><button type="button" class="food-sug" data-sug="${i}">
        <span class="food-name">${esc(r.name)}</span>${r.other ? `<small class="food-other"> · ${esc(r.other)}</small>` : ''}${r.private
        ? `<span class="food-lockmark" title="Locked">${LOCK}<span class="sr-only">, locked</span></span>` : ''}${open.has(r.id) ? '<small class="food-onlist">on the list</small>' : ''}</button></li>`).join('');
      list.hidden = !shown.length;
    }
    function add(text, priv) {
      if (!S.parse(text).name) { toast('Type what to buy.'); input.focus(); return; }
      st.box.add(text, priv);
      input.value = '';
      setLock(false);
      suggest();
      input.focus();
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      add(input.value, lock.getAttribute('aria-pressed') === 'true');
    }, { signal: st.ctx.signal });
    lock.addEventListener('click', () => { setLock(lock.getAttribute('aria-pressed') !== 'true'); input.focus(); }, { signal: st.ctx.signal });
    input.addEventListener('input', suggest, { signal: st.ctx.signal });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { list.hidden = true; } }, { signal: st.ctx.signal });
    // The suggestions go when the add box is left (not for a tap on one of them).
    form.addEventListener('focusout', (e) => { if (!form.contains(e.relatedTarget)) list.hidden = true; }, { signal: st.ctx.signal });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sug]');
      if (!b) return;
      const r = shown[+b.dataset.sug];
      // A locked line picked turns the lock on.
      add(r.name, r.private || lock.getAttribute('aria-pressed') === 'true');
    }, { signal: st.ctx.signal });
  }

  // ============================================
  // THE LIST: Edit, Forget, Merge (§4.3)
  // ============================================
  function openEdit(st, rowEl) {
    const r = st.rowData.get(`${rowEl.dataset.where}:${rowEl.dataset.id}`);
    if (!r) return;
    const state = { aisle: S.AISLES.some((a) => a.key === r.aisle) ? r.aisle : 'other' };
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = `<form class="form d-inner food-edit" novalidate autocomplete="off">
      <div class="d-top"><h3>${esc(r.name)}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <fieldset class="food-fs"><legend>Aisle</legend><div class="food-chips" role="group" aria-label="Aisle">${S.AISLES.map((a) =>
        `<button type="button" class="food-chip" data-aisle="${a.key}" aria-pressed="${a.key === state.aisle}">${esc(a.en)}</button>`).join('')}</div></fieldset>
      <label class="field"><span>Name</span><input type="text" name="name" maxlength="60" value="${esc(r.name)}" required></label>
      <label class="field"><span>Note</span><input type="text" name="note" maxlength="80" value="${esc(r.note || '')}" placeholder="2, big pack, 2 gallons"></label>
      <label class="check food-check"><input type="checkbox" name="private"${r.private ? ' checked' : ''}> Locked</label>
      <small class="food-help">${esc(lockHint())}</small>
      <p class="form-error" role="alert" hidden></p>
      <div class="food-merge" data-ref="merge" hidden></div>
      <div class="form-actions">
        <button type="button" class="btn btn-danger left" data-act="forget">Forget</button>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`;
    const form = formDialog.querySelector('form');
    const el = form.elements;
    const errBox = form.querySelector('.form-error');
    const mergeBox = form.querySelector('[data-ref="merge"]');
    const fail = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
    const values = () => ({ name: S.clean(el.name.value, 60), note: S.clean(el.note.value, 80) || null, aisle: state.aisle, private: el.private.checked });
    form.addEventListener('click', (e) => {
      const a = e.target.closest('[data-aisle]');
      if (a) {
        state.aisle = a.dataset.aisle;
        form.querySelectorAll('[data-aisle]').forEach((b) => b.setAttribute('aria-pressed', String(b === a)));
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'forget') forget(st, r, act, fail);
      else if (act && act.dataset.act === 'merge') merge(st, r, values(), act, fail);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      mergeBox.hidden = true;
      const patch = values();
      if (!patch.name) { fail('Give it a name.'); return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const rows = await q(core.sb.from('shopping_items').update(patch).eq('id', r.id).select('id'));
        if (!rows || !rows.length) throw new Error('That line isn\'t on the list any more.');
      } catch (err) {
        btn.disabled = false;
        if (err && err.code === '23505') {
          // Another line has that name (with the same lock): say which, and offer to merge into it.
          const key = S.nameKey(patch.name);
          const other = (st.items || []).find((x) => x.id !== r.id && S.nameKey(x.name) === key && !!x.private === patch.private);
          const name = other ? other.name : patch.name;
          fail(`There's already a line called ${name}.`);
          mergeBox.innerHTML = `<button type="button" class="btn" data-act="merge" data-into="${esc(name)}">Merge</button>
            <small>Forgets this line and puts ${esc(patch.note ? 'its note' : 'it')} on ${esc(name)}.</small>`;
          mergeBox.hidden = false;
          return;
        }
        fail(friendly(err));
        return;
      }
      formDialog.close();
      toast(`Saved ${patch.name}`);
      afterChange(st);
    });
    if (!formDialog.open) formDialog.showModal();
  }

  // After an edit, forget or merge: read the list and the lines again.
  function afterChange(st) {
    if (st.ctx.stale()) return;
    st.dirty = true;
    loadItems(st).then(() => requestDraw(st));
    poll(st);
  }

  async function forget(st, r, btn, fail) {
    if (!window.confirm(`Forget ${r.name}? It won't be suggested again.`)) return;
    btn.disabled = true;
    try {
      await q(core.sb.from('shopping_items').delete().eq('id', r.id));
    } catch (err) {
      btn.disabled = false;
      fail(friendly(err));
      return;
    }
    formDialog.close();
    toast(`Forgot ${r.name}`);
    afterChange(st);
  }

  // Merge (§4.3): forget this line, then add the other line's name with this line's note and lock, so
  // the note joins it and a bought line comes back on the list. Both while the dialog waits (it is one
  // change to the person merging), and the list takes the add's answer.
  async function merge(st, r, values, btn, fail) {
    const into = btn.dataset.into || values.name;
    // "Milk: 2 gallons" carries the note, unless the name itself would read as an amount.
    const text = values.note && S.nameKey(S.parse(`${into}: ${values.note}`).name) === S.nameKey(into) ? `${into}: ${values.note}` : into;
    btn.disabled = true;
    let reply;
    try {
      await q(core.sb.from('shopping_items').delete().eq('id', r.id));
      reply = await call('add_to_list', { p_name: text, p_private: values.private });
    } catch (err) {
      btn.disabled = false;
      fail(listError(err));
      afterChange(st);
      return;
    }
    formDialog.close();
    toast(`Merged into ${reply && reply.name ? reply.name : into}`);
    if (st.ctx.stale()) return;
    if (reply) st.box.take(reply);
    afterChange(st);
  }

  // ============================================
  // SEND TAYLOR THE LIST, AND THE PARENTS' SWITCHES
  // ============================================
  const helpers = () => v2.people().filter((p) => p.active !== false && p.role === 'helper');
  const textable = (phone) => String(phone || '').replace(/\D/g, '').length >= 10;
  const listLink = (p) => new URL(`day.html?t=${encodeURIComponent(p.day_token || '')}#list`, location.href).href;
  // Worded like the Family page's My day link message, in her language.
  function listMessage(p) {
    const name = firstName(p.name);
    const link = listLink(p);
    return p.language === 'es'
      ? `Hola ${name}: esta es la lista de compras de la casa en Home Hub. Tócala para verla y marcar lo que compres:\n${link}`
      : `Hi ${name}, here's the household's shopping list on Home Hub. Tap to see it and tick off what you buy:\n${link}`;
  }

  function drawSend(st) {
    const box = st.main.querySelector('[data-ref="send"]');
    if (!box) return;
    const hh = v2.household;
    const who = hh && hh.helper_list !== 'off' ? helpers().filter((p) => textable(p.phone) && p.day_token) : [];
    const html = who.length ? `${ui.sectionHeading(who.length === 1 ? `Send ${firstName(who[0].name)} the list` : 'Send the list')}
      <ul class="food-card food-send">${who.map((p) => {
        const name = firstName(p.name);
        const msg = listMessage(p);
        return `<li data-send="${esc(p.id)}"><div class="food-send-who">${ui.personDot(p)}<b>Send ${esc(name)} the list</b></div>
          <div class="food-send-btns">
            <a class="btn" data-via="whatsapp" href="${esc(whatsappHref(p.phone, msg))}" target="_blank" rel="noopener" aria-label="Send ${esc(name)} the list by WhatsApp">WhatsApp</a>
            <a class="btn" data-via="sms" href="${esc(smsHref(p.phone, msg))}" aria-label="Send ${esc(name)} the list by text">Text</a>
          </div></li>`;
      }).join('')}</ul>` : '';
    if (st.sendDrawn === html) return;
    st.sendDrawn = html;
    box.innerHTML = html;
    box.hidden = !html;
  }

  const HELPER_LIST = [['off', 'Off'], ['see', 'See and tick'], ['add', 'See, tick and add']];
  function drawSwitches(st) {
    const box = st.main.querySelector('[data-ref="switches"]');
    const hh = v2.household;
    if (!box || !hh) { if (box) box.innerHTML = ''; return; }
    const admin = !!(core.me && core.me.role === 'admin');
    const names = helpers().map((p) => `${firstName(p.name)}'s`);
    const whose = names.length ? names.join(' and ') : 'helpers\'';
    const off = admin ? '' : ' disabled';
    box.innerHTML = `${ui.sectionHeading('Settings')}
      <div class="food-card food-set">
        <div class="food-set-row">
          <p class="food-set-title" id="foodHelperTitle">Shopping list on ${esc(whose)} My day</p>
          <div class="food-seg" role="radiogroup" aria-labelledby="foodHelperTitle">${HELPER_LIST.map(([value, label]) =>
            `<button type="button" role="radio" class="food-seg-btn" data-act="helper-list" data-value="${value}" aria-checked="${hh.helper_list === value}"${off}>${esc(label)}</button>`).join('')}</div>
        </div>
        <div class="food-set-row">
          <label class="food-switch"><input type="checkbox" role="switch" data-act="wall"${hh.meals_on_wall ? ' checked' : ''}${off}><span>Dinners on the kitchen wall (Hub – Family)</span></label>
          ${st.familyCalendar === false ? '<small class="food-set-hint">Needs Google Calendar & Hearth with a Family calendar</small>' : ''}
        </div>
        ${admin ? '' : '<p class="food-set-note">Only parents can change these.</p>'}
      </div>`;
  }

  // Saved as Settings saves the household: only if nobody changed it since it was read.
  async function saveHousehold(st, patch, control) {
    const hh = v2.household;
    if (control) control.disabled = true;
    try {
      const rows = await q(core.sb.from('household').update(patch).eq('id', true).eq('updated_at', hh.updated_at).select());
      if (!rows || !rows.length) {
        throw new Error('That wasn\'t saved: someone else changed the settings a moment ago, or only a parent can. Reload the page to see the latest, then try again.');
      }
      try { await v2.refresh(); } catch (err) { /* the saved row still shows; the next sign-in catches up */ }
      if (!st.ctx.stale()) toast('Saved');
    } catch (err) {
      if (!st.ctx.stale()) toast(friendly(err), { error: true });
    }
    if (st.ctx.stale()) return;
    drawSwitches(st);
    drawSend(st);
  }

  // Is there a writing Family calendar (Hub – Family) for the wall? null when it couldn't be read.
  async function loadFamilyCalendar(st) {
    try {
      st.familyCalendar = ((await q(core.sb.from('calendars').select('id').eq('kind', 'family').eq('writes', true).limit(1))) || []).length > 0;
    } catch (err) { st.familyCalendar = null; }
  }

  // ============================================
  // THE PAGE
  // ============================================
  async function renderFood(main, ctx) {
    const me = v2.mePerson;
    const st = {
      main, ctx, today: dates.today(), meals: { rows: [], loaded: false, failed: false }, suggest: [], unfold: false,
      items: null, listFailed: false, reading: false, readAgain: false, pollTimer: null, drawn: null, dirty: false, draws: 0,
      rowData: new Map(), tapped: new Set(), aislePick: null, againOpen: againOpen(), familyCalendar: null, me: me ? me.id : null,
    };
    st.hold = S.hold(S.HOLD_MS, () => drawList(st));
    st.box = S.outbox({
      key: S.KEYS.hub,
      owner: st.me,
      who: st.me,
      send: (op) => (op.op === 'add'
        ? core.sb.rpc('add_to_list', { p_name: op.name, p_private: !!op.private })
        : core.sb.rpc('buy_item', { p_item: op.item, p_bought: op.op === 'buy', p_seen: op.seen })),
      // A member with no person has no bought_by to compare with: no mine, so an Undo goes as it did.
      mine: st.me ? (row) => row.bought_by === st.me : undefined,
      onChange: () => requestDraw(st),
      onReply(op, reply, outcome) {
        if (op.op === 'add') {
          const typed = S.parse(op.name).name;
          if (outcome === 'already') toast(S.nameKey(reply.name) !== S.nameKey(typed) ? `Already on the list as ${reply.name}` : 'Already on the list');
          else if (outcome === 'back') toast('Back on the list');
        } else if (outcome === 'changed') {
          toast('Changed on another phone');
        }
        st.listFailed = false;
        if (op.op === 'unbuy' || outcome === 'back') loadItems(st).then(() => requestDraw(st));
      },
      onRefused(op, error) {
        toast(listError(error), { error: true });
        poll(st);
      },
      onGone: () => poll(st),
      onExpired: (n) => toast(`${plural(n, 'change')} from more than a day ago ${n === 1 ? 'was' : 'were'} dropped, not sent.`, { error: true }),
    });
    live = st;
    ctx.signal.addEventListener('abort', () => {
      if (live === st) live = null;
      st.box.stop();
      st.hold.cancel();
      clearTimeout(st.pollTimer);
    });

    main.innerHTML = `
      <div class="page-head food-head"><div><h1>Food</h1><p class="meta">Dinners and the shopping list</p></div></div>
      <section class="food-sec food-week-sec" data-ref="week" aria-label="This week's dinners"></section>
      <section class="food-sec food-list-sec" aria-label="Shopping list">
        <form class="food-add" data-ref="add" autocomplete="off" novalidate>
          <div class="food-add-row">
            <input type="text" name="what" maxlength="100" placeholder="Add to the list…" aria-label="Add to the list" enterkeyhint="done" autocapitalize="sentences" spellcheck="false">
            <button type="button" class="food-lock" data-ref="lock" aria-pressed="false" aria-label="Lock the next item (hidden from My day links)" title="Lock the next item">${LOCK}</button>
            <button type="submit" class="btn btn-primary food-add-btn">Add</button>
          </div>
          <ul class="food-suggest" data-ref="suggest" role="list" hidden></ul>
          <p class="food-lock-hint" data-ref="lockhint" role="status" hidden></p>
        </form>
        <div class="food-list" data-ref="list"></div>
      </section>
      <section class="food-sec" data-ref="send" aria-label="Send the list"></section>
      <section class="food-sec" data-ref="switches" aria-label="Settings"></section>`;
    drawWeek(st);
    drawList(st);   // the list saved on this device, if any, while the database is asked
    drawSend(st);
    drawSwitches(st);
    wireAdd(st);

    const list = main.querySelector('[data-ref="list"]');
    // Every tap on the list holds its rows where they are for 3 seconds.
    list.addEventListener('pointerdown', () => st.hold.touch(), { signal: ctx.signal });
    main.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act || !main.contains(act)) return;
      if (list.contains(act)) st.hold.touch();
      const rowEl = act.closest('.food-row');
      switch (act.dataset.act) {
        case 'tick': tapRow(st, rowEl); break;
        case 'again': putBack(st, rowEl); break;
        case 'edit': openEdit(st, rowEl); break;
        case 'aisle': toggleAisle(st, rowEl); break;
        case 'set-aisle': setAisle(st, act.dataset.for, act.dataset.aisle, act); break;
        case 'buy-again': toggleAgain(st, act); break;
        case 'retry': st.box.kick(); poll(st); loadItems(st); break;
        case 'unfold': st.unfold = true; drawWeek(st); { const first = main.querySelector('.food-day'); if (first) first.focus(); } break;
        case 'day': openDinner(st, act.dataset.day).catch((err) => toast(friendly(err), { error: true })); break;
        case 'meals-retry': loadMeals(st).then(() => { if (!ctx.stale()) drawWeek(st); }); break;
        case 'helper-list':
          if (act.getAttribute('aria-checked') !== 'true') saveHousehold(st, { helper_list: act.dataset.value }, act);
          break;
        default: break;
      }
    }, { signal: ctx.signal });
    main.addEventListener('change', (e) => {
      const sw = e.target.closest('[data-act="wall"]');
      if (sw) saveHousehold(st, { meals_on_wall: sw.checked }, sw);
    }, { signal: ctx.signal });

    // Freshness (§8): at once on focus, visibilitychange and online; the timer stops while hidden.
    const wake = () => {
      if (ctx.stale()) return;
      st.box.kick();
      poll(st);
    };
    window.addEventListener('online', wake, { signal: ctx.signal });
    window.addEventListener('focus', () => {
      wake();
      loadItems(st).then(() => requestDraw(st));
      loadMeals(st).then(() => { if (!ctx.stale()) drawWeek(st); });
    }, { signal: ctx.signal });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); }, { signal: ctx.signal });

    // The reads, each on its own: a failed one never stops the others.
    await Promise.all([
      loadMeals(st).then(() => { if (!ctx.stale()) drawWeek(st); }),
      loadItems(st),
      poll(st),
      loadFamilyCalendar(st),
    ]);
    if (ctx.stale()) return;
    st.dirty = true;
    drawList(st);
    drawSwitches(st);
    st.box.kick();   // a queue saved on this device goes once the page is ready
    // The people and the household as they are now (a new helper, the switches changed elsewhere).
    v2.refresh().then(() => { if (!ctx.stale()) { drawSwitches(st); drawSend(st); } }, () => {});
    if (ctx.params.day) openDinner(st, ctx.params.day).catch((err) => toast(friendly(err), { error: true }));
  }

  // What the database said, in words: its own message for the list's rules, else the core's.
  function listError(err) {
    if (err && ['42501', '22023', 'P0001', '54000'].includes(err.code) && err.message) return err.message;
    return friendly(err);
  }

  // ============================================
  // THE ADD SHEET'S SHOPPING (§6.3)
  // ============================================
  // One field: type, Enter, the same add_to_list call and words; it stays open for the next item.
  function openListAdd() {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = `<form class="form d-inner food-quick" novalidate autocomplete="off">
      <div class="d-top"><h3>Add to the shopping list</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <label class="field"><span>What to buy</span><input type="text" name="what" maxlength="100" placeholder="Milk, 2 lb ground beef…" enterkeyhint="send" autocapitalize="sentences" spellcheck="false"></label>
      <p class="food-said" data-ref="said" role="status" aria-live="polite"></p>
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn" data-close>Done</button>
        <button type="submit" class="btn btn-primary">Add</button>
      </div>
    </form>`;
    const form = formDialog.querySelector('form');
    const input = form.elements.what;
    const said = form.querySelector('[data-ref="said"]');
    const errBox = form.querySelector('.form-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const text = input.value;
      if (!S.parse(text).name) { errBox.textContent = 'Type what to buy.'; errBox.hidden = false; input.focus(); return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      let reply;
      try {
        reply = await call('add_to_list', { p_name: text, p_private: false });
      } catch (err) {
        btn.disabled = false;
        errBox.textContent = listError(err);
        errBox.hidden = false;
        return;
      }
      btn.disabled = false;
      const typed = S.parse(text).name;
      const as = reply.result === 'already' && S.nameKey(reply.name) !== S.nameKey(typed);
      const words = reply.result === 'already' ? (as ? `Already on the list as ${reply.name}` : 'Already on the list')
        : reply.result === 'back' ? 'Back on the list' : null;
      said.textContent = as ? words : words ? `${words}: ${reply.name}` : `Added: ${reply.name}`;
      if (words) toast(words);
      input.value = '';
      input.focus();
      // The Food page on screen shows it at once.
      if (live && !live.ctx.stale()) {
        live.box.take(reply);
        live.dirty = true;
        requestDraw(live);
      }
    });
    if (!formDialog.open) formDialog.showModal();
    input.focus();
  }

  HomeHub.register({
    name: 'food',
    schema: { min: 4, max: 99 },
    nav: { label: 'Food', order: 35, primary: true },
    // #/food · #/food/<YYYY-MM-DD> (that day's dinner).
    match(parts) {
      if (parts[0] !== 'food' || parts.length > 2) return null;
      if (parts.length === 2 && !ISO_DATE.test(parts[1])) return null;
      return { day: parts[1] || null };
    },
    render: renderFood,
    provides: { openListAdd },
  });
})();
