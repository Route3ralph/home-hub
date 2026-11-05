/* =====================================================================
   HOME HUB — the family board (board.html?b=<code>), docs/v2-design.md §25
   One screen for the whole house, made for a monitor on the wall: no
   sign-in, the board's secret link only. From board_by_token(code, lang):
   the date and a clock, today's meals, a Family column and a column for
   each person on the family list (their events, tasks and late tasks),
   and each kid's routine. Chores are ticked with board_tick_by_token
   (Undo for 15 minutes in the toast, board_undo_by_token) and routine
   items with board_routine_by_token; each answers the whole board.
   It shows what the wall shows: private items read "Private item", and
   there are no notes, phone numbers, homework, points or shopping list.
   The page reads the board again every minute, when it comes back into
   view or online, and when the household's day changes. The clock is the
   server's (its answer's `now`, in the household's time zone), kept
   running on the device's timer; the device's own clock and zone are
   never used. From 9pm to 6am it goes dark. It asks the browser to keep
   the screen on. English or Español, kept on this screen.
   Loads config.js and supabase-js only, never the hub.
   ===================================================================== */
(function () {
  'use strict';

  const cfg = window.HOME_HUB_CONFIG || {};
  const root = document.getElementById('app');
  const query = new URLSearchParams(location.search);
  const token = String(query.get('b') || '').trim().toLowerCase();
  const CODE = /^[0-9a-f]{32}$/;
  const REFRESH_MS = 60 * 1000;
  const UNDO_MS = 15 * 60 * 1000;          // board_undo_by_token takes back a tick for 15 minutes
  const LANG_KEY = 'homehub.board.lang';

  // ============================================
  // HELPERS
  // ============================================
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  };
  const HEX = /^#[0-9a-fA-F]{6}$/;

  // ============================================
  // WORDS (fixed words only; titles stay as typed)
  // ============================================
  const WORDS = {
    en: {
      board: 'Family board', family: 'Family', late: 'Late', nothing: 'Nothing today', all_day: 'All day',
      skipped: 'Skipped', due: 'Due {d}', routine: 'Routine', count: '{done} of {total}',
      done_toast: 'Done: {title}', undo: 'Undo', dismiss: 'Close', undone: "Undone. It's back on the board.",
      section_done: '{title} done!', all_done: 'All done for today!',
      already: 'That was already ticked off. The board is up to date now.',
      not_on_board: "That isn't on the board any more.",
      paused: "That task is paused, so it can't be ticked off right now.",
      school_days: 'That one is for school days.',
      too_many: "That's a lot of ticks for one day. Try again tomorrow.",
      too_late_undo: "That can't be undone here any more. Ask a parent to fix it in Home Hub.",
      offline: "Can't reach Home Hub. This is the board from {time}.",
      error_generic: 'Something went wrong. Try again.', try_again: 'Try again', loading: 'Loading…',
      bad_link: "This board link isn't working. Ask a parent for the new one (Home Hub, Settings, Family board).",
      no_token: 'This link is missing its code. Ask a parent for the board link (Home Hub, Settings, Family board).',
      not_setup: 'This site is not finished being set up yet.',
      not_loaded: 'The page did not load completely. Check the connection and reload.',
      switch_lang: 'Español',
    },
    es: {
      board: 'Tablero familiar', family: 'Familia', late: 'Atrasado', nothing: 'Nada para hoy', all_day: 'Todo el día',
      skipped: 'Omitido', due: 'Vencía {d}', routine: 'Rutina', count: '{done} de {total}',
      done_toast: 'Hecho: {title}', undo: 'Deshacer', dismiss: 'Cerrar', undone: 'Deshecho. Está otra vez en el tablero.',
      section_done: '¡{title} terminado!', all_done: '¡Todo listo por hoy!',
      already: 'Eso ya estaba marcado. El tablero ya está al día.',
      not_on_board: 'Eso ya no está en el tablero.',
      paused: 'Esa tarea está en pausa, así que no se puede marcar ahora.',
      school_days: 'Eso es solo para días de escuela.',
      too_many: 'Son muchas marcas para un día. Inténtalo mañana.',
      too_late_undo: 'Eso ya no se puede deshacer aquí. Pide a un padre que lo arregle en Home Hub.',
      offline: 'No se puede conectar con Home Hub. Este es el tablero de las {time}.',
      error_generic: 'Algo salió mal. Inténtalo de nuevo.', try_again: 'Intentar de nuevo', loading: 'Cargando…',
      bad_link: 'Este enlace del tablero no funciona. Pide a un padre el nuevo (Home Hub, Ajustes, Tablero familiar).',
      no_token: 'A este enlace le falta su código. Pide a un padre el enlace del tablero.',
      not_setup: 'Este sitio todavía no está configurado.',
      not_loaded: 'La página no cargó completa. Revisa la conexión y vuelve a cargarla.',
      switch_lang: 'English',
    },
  };
  let lang = readLang();
  const t = (key, vars) => {
    let s = (WORDS[lang] && WORDS[lang][key]) || WORDS.en[key] || key;
    if (vars) Object.keys(vars).forEach((k) => { s = s.split(`{${k}}`).join(String(vars[k])); });
    return s;
  };
  function readLang() {
    try { const l = localStorage.getItem(LANG_KEY); if (l === 'es' || l === 'en') return l; } catch (e) { /* private mode */ }
    return 'en';
  }
  function saveLang(l) {
    try { localStorage.setItem(LANG_KEY, l); } catch (e) { /* private mode: this visit only */ }
  }

  // ============================================
  // THE CLOCK (the server's, in the household's zone)
  // The answer's `now` (ms) is the server's clock when it answered; the device's timer moves it on.
  // ============================================
  let offset = 0;          // server time minus Date.now(), from the last answer
  const serverNow = () => Date.now() + offset;
  function zoneParts(ms, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(ms));
      const get = (type) => (parts.find((p) => p.type === type) || {}).value;
      return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: get('minute') };
    } catch (e) {
      return null;
    }
  }
  function clockText() {
    const z = state && zoneParts(serverNow(), state.tz);
    if (!z) return { main: '', ampm: '' };
    if (lang === 'es') return { main: `${z.hour}:${z.minute}`, ampm: '' };
    return { main: `${z.hour % 12 || 12}:${z.minute}`, ampm: z.hour < 12 ? 'am' : 'pm' };
  }
  // "Thursday, November 5" / "jueves, 5 de noviembre", from the household's date.
  function dateText(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
    try {
      return new Intl.DateTimeFormat(lang === 'es' ? 'es' : 'en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(d);
    } catch (e) {
      return iso;
    }
  }
  const isNight = (z) => !!z && (z.hour >= 21 || z.hour < 6);

  function tickClock() {
    if (!state || view !== 'board') return;
    const c = clockText();
    const el = root.querySelector('.bd-clock');
    if (el) el.innerHTML = `${esc(c.main)}${c.ampm ? `<span class="bd-ampm">${esc(c.ampm)}</span>` : ''}`;
    const z = zoneParts(serverNow(), state.tz);
    document.body.classList.toggle('night', isNight(z));
    // A new day in the household: read the board again.
    if (z && z.date !== state.today && !busy && Date.now() - lastLoad > 5000) refresh();
  }

  // ============================================
  // MESSAGES FOR ERRORS
  // ============================================
  function friendly(err) {
    const msg = String((err && (err.message || err.error_description)) || err || '');
    if (/Failed to fetch|NetworkError|Load failed|network connection/i.test(msg)) return t('offline', { time: shownAt() });
    if (/^already (done|completed)$/.test(msg)) return t('already');
    if (/paused/i.test(msg)) return t('paused');
    if (/for school days/i.test(msg)) return t('school_days');
    if (/a lot for one day/i.test(msg)) return t('too_many');
    if (/can't be undone|nothing to undo|latest change|ticked off on the board/i.test(msg)) return t('too_late_undo');
    if ((err && err.code === '42501') || /isn't on the board/i.test(msg)) return t('not_on_board');
    return lang === 'en' && msg ? msg : t('error_generic');
  }
  const isStale = (err) => /^already (done|completed)$|isn't on the board/.test(String((err && err.message) || ''));

  // ============================================
  // DATA
  // ============================================
  let sb = null;
  let state = null;      // the last board answer
  let drawn = '';        // what the board shows, as JSON, so an unchanged refresh doesn't redraw
  let view = 'loading';  // 'loading' | 'board' | 'problem'
  let notice = '';       // a refresh that failed, shown above the columns
  let loadedAt = 0;      // server time of the board on screen (for "the board from 4:12pm")
  let lastLoad = 0;
  let busy = 0;          // ticks in flight: no refresh redraws in the middle of one
  let loading = null;
  const routineOpen = new Map();   // kid id → a section opened ('<id>') or folded ('-<id>') by hand

  async function rpc(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }
  // One request at a time: each call starts once the one before it has its answer.
  let line = Promise.resolve();
  function one(start) {
    const p = line.then(start);
    line = p.then(() => {}, () => {});
    return p;
  }
  function fetchBoard() {
    if (!loading) {
      loading = rpc(one(() => sb.rpc('board_by_token', { p_token: token, p_lang: lang })))
        .then((b) => { lastLoad = Date.now(); return b && typeof b === 'object' ? b : null; })
        .finally(() => { loading = null; });
    }
    return loading;
  }
  function accept(b) {
    state = b;
    if (Number.isFinite(Number(b.now))) offset = Number(b.now) - Date.now();
    loadedAt = serverNow();
    document.documentElement.lang = lang;
    document.title = t('board');
  }
  function shownAt() {
    const z = state && zoneParts(loadedAt, state.tz);
    if (!z) return '';
    return lang === 'es' ? `${z.hour}:${z.minute}` : `${z.hour % 12 || 12}:${z.minute}${z.hour < 12 ? 'am' : 'pm'}`;
  }

  async function refresh() {
    if (view === 'problem' && !state) return start();
    let b;
    try {
      b = await fetchBoard();
    } catch (err) {
      if (state) { notice = friendly(err); render(true); }
      else showProblem(() => friendly(err), true);
      return;
    }
    if (!b) { linkGone(); return; }
    const had = !!notice;
    notice = '';
    accept(b);
    render(had);
  }
  function refreshSoon() {
    if (document.visibilityState === 'hidden' || busy) return;
    if (view === 'problem' && root.querySelector('[data-act="retry"]')) { start(); return; }
    if (!state || Date.now() - lastLoad < 1000) return;
    refresh();
  }
  function linkGone() {
    state = null;
    drawn = '';
    showProblem(() => t('bad_link'));
  }

  // ============================================
  // TOASTS (the shared .toasts styles from styles.css)
  // ============================================
  function toast(msg, opts) {
    const o = opts || {};
    let host = document.querySelector('.toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toasts';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast${o.error ? ' toast-error' : ''}`;
    let timer = null;
    const close = () => { clearTimeout(timer); el.remove(); };
    if (o.action) {
      host.querySelectorAll('.toast-action').forEach((x) => x.closeToast());
      el.classList.add('toast-action');
      const text = document.createElement('span');
      text.textContent = msg;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-btn';
      btn.textContent = o.action.label;
      btn.addEventListener('click', () => { close(); o.action.onClick(); });
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'toast-btn toast-x';
      x.setAttribute('aria-label', t('dismiss'));
      x.textContent = '×';
      x.addEventListener('click', close);
      el.append(text, btn, x);
    } else {
      el.textContent = msg;
    }
    el.closeToast = close;
    host.appendChild(el);
    timer = setTimeout(close, o.ms || (o.error ? 6000 : 3000));
    return el;
  }

  // ============================================
  // DRAWING
  // ============================================
  function itemHTML(it) {
    const done = it.status === 'done';
    const skipped = it.status === 'skipped';
    const late = it.status === 'late';
    const isTask = it.kind === 'task';
    // The time in its own column (an event without one says "All day"; a task without one has none).
    const time = it.time_label ? `<span class="bd-time">${esc(it.time_label)}</span>`
      : isTask ? '' : `<span class="bd-time bd-allday">${esc(t('all_day'))}</span>`;
    const chips = (late && it.due_label ? `<span class="bd-chip bd-chip-late">${esc(t('due', { d: it.due_label }))}</span>` : '')
      + (skipped ? `<span class="bd-chip">${esc(t('skipped'))}</span>` : '');
    const main = `<span class="bd-main"><span class="bd-title${it.private ? ' bd-private' : ''}">${esc(it.title)}</span>${chips ? ` ${chips}` : ''}</span>`;
    const text = `<span class="bd-text${time ? ' has-time' : ''}">${time}${time ? ' ' : ''}${main}</span>`;
    const cls = `bd-item bd-${esc(it.kind)}${done ? ' is-done' : ''}${skipped ? ' is-skipped' : ''}${late ? ' is-late' : ''}`;
    if (isTask && (it.status === 'open' || late)) {
      return `<li><button type="button" class="${cls} bd-check" role="checkbox" aria-checked="false" data-act="tick"
        data-task="${esc(it.item_id)}" data-occ="${esc(it.occurrence || '')}" data-title="${esc(it.title)}">
        <span class="bd-box">${ICON.check}</span>${text}</button></li>`;
    }
    if (isTask) {
      return `<li><div class="${cls} bd-check" role="checkbox" aria-checked="${done ? 'true' : 'false'}" aria-disabled="true">
        <span class="bd-box">${done ? ICON.check : ''}</span>${text}</div></li>`;
    }
    return `<li><div class="${cls}">${text}</div></li>`;
  }
  function listHTML(items) {
    return items.length ? `<ul class="bd-items">${items.map(itemHTML).join('')}</ul>` : '';
  }

  function routineHTML(p) {
    const r = p.routine;
    const parts = r && Array.isArray(r.sections) ? r.sections : [];
    if (!parts.length) return '';
    const done = parts.reduce((n, x) => n + (Number(x.done) || 0), 0);
    const total = parts.reduce((n, x) => n + (Number(x.total) || 0), 0);
    const first = parts.find((x) => Number(x.done) < Number(x.total));
    const hand = routineOpen.get(p.id);
    const isOpen = (x) => (hand === x.id ? true : hand === `-${x.id}` ? false : !!first && first.id === x.id);
    const body = parts.map((x) => {
      let part = null;
      const items = (Array.isArray(x.items) ? x.items : []).map((it) => {
        const head = it.part && it.part !== part ? `<p class="bd-part">${esc(it.part)}</p>` : '';
        part = it.part || null;
        return `${head}<button type="button" class="bd-item bd-check bd-rt-item${it.done ? ' is-done' : ''}" role="checkbox" aria-checked="${it.done ? 'true' : 'false'}"
          data-act="rt" data-kid="${esc(p.id)}" data-item="${esc(it.id)}" data-section="${esc(x.id)}">
          <span class="bd-box">${ICON.check}</span><span class="bd-text"><span class="bd-title">${esc(it.title)}</span>${it.tag ? ` <span class="bd-chip">${esc(it.tag)}</span>` : ''}</span></button>`;
      }).join('');
      const finished = Number(x.done) >= Number(x.total);
      return `<details class="bd-sec${finished ? ' is-done' : ''}" data-kid="${esc(p.id)}" data-section="${esc(x.id)}"${isOpen(x) ? ' open' : ''}>
        <summary><span class="bd-sec-title">${esc(x.title)}</span><span class="bd-sec-count">${finished ? '✓ ' : ''}${esc(t('count', { done: x.done, total: x.total }))}</span></summary>
        ${x.note ? `<p class="bd-sec-note">${esc(x.note)}</p>` : ''}<div class="bd-sec-items">${items}</div></details>`;
    }).join('');
    return `<section class="bd-rt" aria-label="${esc(t('routine'))}">
      <h3 class="bd-sub">${esc(t('routine'))}<span class="bd-count">${esc(done >= total ? t('all_done') : t('count', { done, total }))}</span></h3>${body}</section>`;
  }

  function columnHTML(o) {
    const items = Array.isArray(o.items) ? o.items : [];
    const late = Array.isArray(o.late) ? o.late : [];
    const routine = o.person ? routineHTML(o.person) : '';
    const color = o.family ? 'var(--accent)' : HEX.test(String(o.color || '')) ? o.color : '#64748b';
    const empty = !items.length && !late.length && !routine;
    return `<section class="bd-col${o.family ? ' bd-family' : ''}" style="--who: ${color}" ${o.person ? `data-person="${esc(o.person.id)}"` : 'data-col="family"'}>
      <h2 class="bd-name"><span class="bd-dot" aria-hidden="true"></span>${esc(o.name)}</h2>
      ${routine}
      ${listHTML(items)}
      ${late.length ? `<h3 class="bd-sub bd-late-head">${esc(t('late'))}</h3>${listHTML(late)}` : ''}
      ${empty ? `<p class="bd-empty">${esc(t('nothing'))}</p>` : ''}
    </section>`;
  }

  function render(force) {
    if (!state) return;
    const json = JSON.stringify([state, lang, notice]);
    if (!force && view === 'board' && json === drawn) { tickClock(); return; }
    // Keep the routine sections as the person left them (open or folded by hand) across a redraw.
    drawn = json;
    view = 'board';
    const people = Array.isArray(state.people) ? state.people : [];
    const fam = state.family || {};
    const meals = Array.isArray(state.meals) ? state.meals : [];
    const c = clockText();
    root.innerHTML = `
      <header class="bd-head">
        <h1 class="bd-date">${esc(dateText(state.today))}</h1>
        <p class="bd-clock" aria-hidden="true">${esc(c.main)}${c.ampm ? `<span class="bd-ampm">${esc(c.ampm)}</span>` : ''}</p>
      </header>
      ${notice ? `<p class="banner banner-warn bd-notice" role="status">${esc(notice)}</p>` : ''}
      ${meals.length ? `<p class="bd-meals">${meals.map((m) => `<span class="bd-meal"><b>${esc(m.label)}:</b> ${esc(m.title)}${m.cook ? ` (${esc(m.cook)})` : ''}</span>`).join('')}</p>` : ''}
      <div class="bd-cols">
        ${columnHTML({ family: true, name: t('family'), items: fam.items, late: fam.late })}
        ${people.map((p) => columnHTML({ person: p, name: p.name, color: p.color, items: p.items, late: p.late })).join('')}
      </div>
      <footer class="bd-foot"><button type="button" class="btn bd-lang" data-act="lang" lang="${lang === 'es' ? 'en' : 'es'}">${esc(t('switch_lang'))}</button></footer>`;
    tickClock();
  }

  function showProblem(message, retry) {
    view = 'problem';
    drawn = '';
    root.innerHTML = `<header class="bd-head"><h1 class="bd-date">${esc(t('board'))}</h1></header>
      <div class="banner banner-error bd-problem" role="alert"><p>${esc(message())}</p></div>
      ${retry ? `<p class="bd-actions"><button type="button" class="btn btn-primary" data-act="retry">${esc(t('try_again'))}</button></p>` : ''}`;
  }

  // ============================================
  // TICKS
  // ============================================
  async function tickTask(btn) {
    const id = btn.dataset.task;
    const occ = btn.dataset.occ || null;
    const title = btn.dataset.title || '';
    btn.disabled = true;
    btn.setAttribute('aria-checked', 'true');
    btn.classList.add('is-done');
    busy += 1;
    let b = null;
    try {
      b = await rpc(one(() => sb.rpc('board_tick_by_token', { p_token: token, p_task_id: id, p_occurrence: occ, p_lang: lang })));
    } catch (err) {
      busy -= 1;
      toast(friendly(err), { error: true });
      if (isStale(err) || !String((err && err.message) || '').match(/Failed to fetch|NetworkError|Load failed/i)) refresh();
      else render(true);
      return;
    }
    busy -= 1;
    if (!b) { linkGone(); return; }
    const logId = b.log_id;
    delete b.log_id;
    notice = '';
    accept(b);
    render(true);
    if (logId) {
      toast(t('done_toast', { title }), { ms: UNDO_MS, action: { label: t('undo'), onClick: () => undoTask(logId) } });
    }
  }
  async function undoTask(logId) {
    busy += 1;
    let b = null;
    try {
      b = await rpc(one(() => sb.rpc('board_undo_by_token', { p_token: token, p_log_id: logId, p_lang: lang })));
    } catch (err) {
      busy -= 1;
      toast(friendly(err), { error: true });
      refresh();
      return;
    }
    busy -= 1;
    if (!b) { linkGone(); return; }
    accept(b);
    render(true);
    toast(t('undone'));
  }

  async function tickRoutine(btn) {
    const kid = btn.dataset.kid;
    const item = btn.dataset.item;
    const section = btn.dataset.section;
    const toDone = btn.getAttribute('aria-checked') !== 'true';
    const before = sectionOf(kid, section);
    btn.disabled = true;
    btn.setAttribute('aria-checked', toDone ? 'true' : 'false');
    btn.classList.toggle('is-done', toDone);
    busy += 1;
    let b = null;
    try {
      b = await rpc(one(() => sb.rpc('board_routine_by_token', { p_token: token, p_item: item, p_done: toDone, p_lang: lang })));
    } catch (err) {
      busy -= 1;
      toast(friendly(err), { error: true });
      refresh();
      return;
    }
    busy -= 1;
    if (!b) { linkGone(); return; }
    routineOpen.delete(kid);   // a tick: the first section not finished opens again
    accept(b);
    render(true);
    const after = sectionOf(kid, section);
    if (toDone && before && after && Number(before.done) < Number(before.total) && Number(after.done) >= Number(after.total)) {
      toast(t('section_done', { title: after.title }));
    }
  }
  function sectionOf(kid, id) {
    const p = state && (state.people || []).find((x) => x.id === kid);
    const parts = p && p.routine && Array.isArray(p.routine.sections) ? p.routine.sections : [];
    return parts.find((x) => x.id === id) || null;
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const act = el.dataset.act;
    if (act === 'tick' && !el.disabled) tickTask(el);
    else if (act === 'rt' && !el.disabled) tickRoutine(el);
    else if (act === 'retry') start();
    else if (act === 'lang') {
      lang = lang === 'es' ? 'en' : 'es';
      saveLang(lang);
      drawn = '';
      refresh();
    }
  });
  // A section opened or folded by hand stays so until the next tick.
  root.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('bd-sec')) return;
    routineOpen.set(d.dataset.kid, d.open ? d.dataset.section : `-${d.dataset.section}`);
  }, true);

  // ============================================
  // KEEP THE SCREEN ON (where the browser can)
  // ============================================
  let wake = null;
  async function keepAwake() {
    try {
      if (navigator.wakeLock && document.visibilityState === 'visible' && !wake) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } catch (e) { wake = null; }
  }

  // ============================================
  // START
  // ============================================
  async function start() {
    view = 'loading';
    root.innerHTML = `<p class="loading">${esc(t('loading'))}</p>`;
    let b;
    try {
      b = await fetchBoard();
    } catch (err) {
      showProblem(() => friendly(err), true);
      return;
    }
    if (!b) { linkGone(); return; }
    accept(b);
    render(true);
  }

  document.documentElement.lang = lang;
  if (!token) { showProblem(() => t('no_token')); return; }
  if (!CODE.test(token)) { showProblem(() => t('bad_link')); return; }
  if (!cfg.supabaseUrl || !cfg.supabaseKey) { showProblem(() => t('not_setup')); return; }
  if (!window.supabase || !window.supabase.createClient) { showProblem(() => t('not_loaded')); return; }
  // No session at all: this page is anonymous, and never reads or keeps a hub sign-in.
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  window.addEventListener('focus', refreshSoon);
  window.addEventListener('online', refreshSoon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshSoon(); keepAwake(); } });
  setInterval(refreshSoon, REFRESH_MS);
  setInterval(tickClock, 10 * 1000);
  keepAwake();
  start();
})();
