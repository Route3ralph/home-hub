/* =====================================================================
   HOME HUB — My day (day.html?t=<day_token>)
   The public page for kids and helpers: no sign-in, just that person's
   today and tomorrow (and anything of theirs that is late), from
   get_person_day(token). Each item says who else is on it ("with
   Jordan", or who's taking them). They tick off their own tasks with
   complete_by_token, and can take a tick back for 15 minutes with
   undo_by_token. The page refreshes when it comes back into view and
   every 5 minutes.
   The confirmation email opens day.html?c=<secret>#confirm: the secret
   alone, no My day code, so the page shows only the confirm question
   (confirm_digest(p_confirm)) and loads nobody's day. (An older email's
   ?t=…&c=…#confirm still works, the same way.) #confirm and #stop ask
   first and change something only when the button is pressed: email
   security scanners open every link in new mail.
   Fixed words come in English or Spanish (the person's language); titles
   stay as typed. Dates and times come from the database, in the
   household's time zone; the device's clock and zone are never used.
   Loads config.js and supabase-js only, never the hub.
   ===================================================================== */
(function () {
  'use strict';

  const cfg = window.HOME_HUB_CONFIG || {};
  const root = document.getElementById('app');
  const query = new URLSearchParams(location.search);
  const token = String(query.get('t') || '').trim().toLowerCase();
  const confirmCode = String(query.get('c') || '').trim().toLowerCase();
  const confirmOnly = !token && query.has('c');   // the confirmation email's link: the question, nothing else
  const CODE = /^[0-9a-f]{32}$/;          // day tokens and confirmation codes alike
  const REFRESH_MS = 5 * 60 * 1000;
  const UNDO_MS = 15 * 60 * 1000;         // undo_by_token takes back a tick for 15 minutes
  const HINT_KEY = 'homehub.myday.hint-off';
  const dayHref = `?t=${encodeURIComponent(token)}`;  // this page, without the hash or the confirmation code

  // ============================================
  // HELPERS
  // ============================================
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const firstName = (name) => String(name || '').trim().split(/\s+/)[0];
  const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;
  const ICON = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5l2.6.4 1.3 4-1.9 1.5a12 12 0 0 0 6 6l1.5-1.9 4 1.3.4 2.6c.1.9-.6 1.7-1.5 1.8C10.6 19.6 4.4 13.4 4.8 5c.1-.9.9-1.6 1.8-1.5z"/></svg>',
  };

  // ============================================
  // WORDS (fixed words only; titles stay as typed)
  // ============================================
  const WORDS = {
    en: {
      my_day: 'My day', hi: 'Hi, {name}', today: 'Today', tomorrow: 'Tomorrow', yesterday: 'Yesterday', late: 'Late',
      nothing_today: 'Nothing planned for today.', nothing_tomorrow: 'Nothing planned for tomorrow.',
      all_day: 'All day', any_time: 'Any time', skipped: 'Skipped',
      done_label: 'Done: {title}', call: 'Call {name}', ticked: 'Done: {title}', undo: 'Undo', dismiss: 'Close',
      undone: "Undone. It's back on your list.",
      already: 'That was already ticked off. The list is up to date now.',
      not_yours: "That task isn't on your list any more.",
      paused: "That task is paused, so it can't be ticked off right now.",
      too_late_undo: "That can't be undone here any more. Ask the family to fix it.",
      offline: "Can't reach Home Hub. Check your internet connection and try again.",
      refresh_failed: "Couldn't refresh just now. Check your internet connection.",
      error_generic: 'Something went wrong. Try again.', try_again: 'Try again', loading: 'Loading…', working: 'One moment…',
      bad_link: "This link isn't working. Ask the family for a new link.",
      no_token: 'This link is missing its code. Ask the family for a new link.',
      not_setup: 'This site is not finished being set up yet.',
      not_loaded: 'The page did not load completely. Check your connection and reload.',
      footer: "This page is just for you. Please don't share the link.",
      confirm_q: 'Send me the morning email?',
      confirm_body: "Each morning you'll get one email with your day: what's on and what needs doing.",
      confirm_yes: 'Yes, send me the morning email',
      confirm_ok: "You're all set. Your morning email starts with the next one.",
      confirm_already: 'Your email address is already confirmed.',
      confirm_bad: "That didn't work. The link may be out of date: open the newest email from Home Hub, or ask the family for a new link.",
      confirm_missing: 'This link is incomplete. Open the newest email from Home Hub, or ask the family for a new link.',
      stop_q: 'Stop the morning email?',
      stop_body: "You won't get the morning email any more. This page keeps working.",
      stop_yes: 'Stop the morning email',
      stop_ok: "Stopped. You won't get the morning email any more. Ask the family if you want it back.",
      stop_already: 'The morning email is already off.',
      see_day: 'See my day',
      email_title: 'Morning email',
      switch_lang: 'En español',
      hint_label: 'Tip',
      hint_ios: 'Keep this page handy: tap the Share button, then "Add to Home Screen".',
      hint_android: 'Keep this page handy: tap the ⋮ menu, then "Add to Home screen".',
    },
    es: {
      my_day: 'Mi día', hi: 'Hola, {name}', today: 'Hoy', tomorrow: 'Mañana', yesterday: 'Ayer', late: 'Atrasado',
      nothing_today: 'Nada planeado para hoy.', nothing_tomorrow: 'Nada planeado para mañana.',
      all_day: 'Todo el día', any_time: 'Sin hora', skipped: 'Saltada',
      done_label: 'Hecho: {title}', call: 'Llamar a {name}', ticked: 'Hecho: {title}', undo: 'Deshacer', dismiss: 'Cerrar',
      undone: 'Deshecho. Vuelve a estar en tu lista.',
      already: 'Eso ya estaba marcado. La lista ya está al día.',
      not_yours: 'Esa tarea ya no está en tu lista.',
      paused: 'Esa tarea está en pausa, así que no se puede marcar ahora.',
      too_late_undo: 'Eso ya no se puede deshacer aquí. Pide a la familia que lo corrija.',
      offline: 'No se puede conectar con Home Hub. Revisa tu conexión a internet e inténtalo de nuevo.',
      refresh_failed: 'No se pudo actualizar ahora. Revisa tu conexión a internet.',
      error_generic: 'Algo salió mal. Inténtalo de nuevo.', try_again: 'Intentar de nuevo', loading: 'Cargando…', working: 'Un momento…',
      bad_link: 'Este enlace no funciona. Pide a la familia un enlace nuevo.',
      no_token: 'A este enlace le falta su código. Pide a la familia un enlace nuevo.',
      not_setup: 'Este sitio todavía no está listo.',
      not_loaded: 'La página no se cargó por completo. Revisa tu conexión y vuelve a cargarla.',
      footer: 'Esta página es solo para ti. Por favor, no compartas el enlace.',
      confirm_q: '¿Quieres recibir el correo de la mañana?',
      confirm_body: 'Cada mañana recibirás un correo con tu día: lo que hay y lo que hay que hacer.',
      confirm_yes: 'Sí, quiero el correo de la mañana',
      confirm_ok: 'Listo. El correo de la mañana empieza con el próximo.',
      confirm_already: 'Tu correo electrónico ya está confirmado.',
      confirm_bad: 'No funcionó. Puede que el enlace sea antiguo: abre el correo más reciente de Home Hub o pide a la familia un enlace nuevo.',
      confirm_missing: 'Este enlace está incompleto. Abre el correo más reciente de Home Hub o pide a la familia un enlace nuevo.',
      stop_q: '¿Dejar de recibir el correo de la mañana?',
      stop_body: 'Ya no recibirás el correo de la mañana. Esta página sigue funcionando.',
      stop_yes: 'Dejar de recibir el correo',
      stop_ok: 'Listo. Ya no recibirás el correo de la mañana. Pide a la familia si lo quieres otra vez.',
      stop_already: 'El correo de la mañana ya está desactivado.',
      see_day: 'Ver mi día',
      email_title: 'Correo de la mañana',
      switch_lang: 'In English',
      hint_label: 'Consejo',
      hint_ios: 'Tenla a mano: toca el botón Compartir y luego "Agregar a inicio".',
      hint_android: 'Tenla a mano: toca el menú ⋮ y luego "Agregar a la pantalla principal".',
    },
  };
  // Until the person is known (or when the link doesn't work), the device's language is a guess.
  const guessed = /^es\b/i.test(navigator.language || '') ? 'es' : 'en';
  let lang = guessed;
  // t('hi', { name }) → 'Hi, Taylor'. Values are put in as they are, so escape the result.
  const t = (key, vars, l) => String(WORDS[l || lang][key] || WORDS.en[key] || key)
    .replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));

  // ============================================
  // DATES AND TIMES
  // Dates are 'YYYY-MM-DD' strings from the database (the household's dates); the arithmetic uses
  // whole UTC days, so the device's time zone never shifts a date. Times are 'HH:MM' wall-clock
  // times in the household's zone, written as the database writes them (8:00am / 8:00).
  // ============================================
  const DAYS = {
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  };
  const MONTHS = {
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // { n: whole days since 1970-01-01, weekday: 0 = Sunday, month, day }, or null for anything else.
  function dateParts(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso));
    if (!m) return null;
    const n = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
    const d = new Date(n * 86400000);
    return { n, weekday: d.getUTCDay(), month: d.getUTCMonth(), day: d.getUTCDate() };
  }
  const fmt = {
    // 'Sunday, October 25' / 'Domingo, 25 de octubre'
    long(iso) {
      const p = dateParts(iso);
      if (!p) return '';
      return lang === 'es' ? cap(`${DAYS.es[p.weekday]}, ${p.day} de ${MONTHS.es[p.month]}`)
        : `${DAYS.en[p.weekday]}, ${MONTHS.en[p.month]} ${p.day}`;
    },
    // 'Sun Oct 25' / 'dom 25 oct'
    day(iso) {
      const p = dateParts(iso);
      if (!p) return '';
      const wd = DAYS[lang][p.weekday].slice(0, 3);
      const mo = MONTHS[lang][p.month].slice(0, 3);
      return lang === 'es' ? `${wd} ${p.day} ${mo}` : `${wd} ${mo} ${p.day}`;
    },
    // 'Oct 25' / '25 oct'
    short(iso) {
      const p = dateParts(iso);
      if (!p) return '';
      const mo = MONTHS[lang][p.month].slice(0, 3);
      return lang === 'es' ? `${p.day} ${mo}` : `${mo} ${p.day}`;
    },
    // 'Yesterday' / 'Today' / 'Tomorrow', otherwise 'Fri Oct 23'.
    rel(iso, todayIso) {
      const a = dateParts(iso);
      const b = dateParts(todayIso);
      if (!a || !b) return fmt.day(iso);
      return { '-1': t('yesterday'), 0: t('today'), 1: t('tomorrow') }[a.n - b.n] || fmt.day(iso);
    },
    // '16:00' → '4:00pm' / '16:00'
    time(hhmm) {
      const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
      if (!m) return '';
      const h = Number(m[1]) % 24;
      return lang === 'es' ? `${h}:${m[2]}` : `${h % 12 || 12}:${m[2]}${h < 12 ? 'am' : 'pm'}`;
    },
  };

  // ============================================
  // MESSAGES FOR ERRORS
  // The database's messages are in English; the ones a person can meet here have their own words.
  // ============================================
  function friendly(err) {
    const msg = String((err && (err.message || err.error_description)) || err || '');
    if (/Failed to fetch|NetworkError|Load failed|network connection/i.test(msg)) return t('offline');
    if (/^already (done|completed)$/.test(msg)) return t('already');
    if (/paused/i.test(msg)) return t('paused');
    if (/can't be undone|nothing to undo|latest change|only something you ticked off/i.test(msg)) return t('too_late_undo');
    if ((err && err.code === '42501') || /isn't on your list/i.test(msg)) return t('not_yours');
    return lang === 'en' && msg ? msg : t('error_generic');
  }
  const isStale = (err) => /^already (done|completed)$/.test(String((err && err.message) || ''));

  // ============================================
  // DATA
  // ============================================
  let sb = null;
  let state = null;     // the last get_person_day answer
  let drawn = '';       // the answer the day view shows, as JSON, so an unchanged refresh doesn't redraw
  let rows = [];        // the items on screen, by data-i
  let view = 'day';     // 'day' | 'confirm' | 'stop' | 'problem'
  let notice = '';      // a refresh that failed, shown above the lists
  let loading = null;   // the get_person_day request in flight
  let lastLoad = 0;
  let busy = 0;         // ticks and undos in flight: no refresh redraws in the middle of one
  let confirmed = null; // the confirm-only page's answer: 'ok', 'bad' or null (not asked yet)
  let hintOff = readHintOff();

  async function rpc(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }

  // One get_person_day request at a time; a second caller shares the one in flight.
  // Resolves to the answer (null for a link that doesn't work).
  function fetchDay() {
    if (!loading) {
      loading = rpc(sb.rpc('get_person_day', { p_token: token }))
        .then((day) => { lastLoad = Date.now(); return day && typeof day === 'object' ? day : null; })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  function accept(day) {
    state = day;
    const person = day.person || {};
    lang = person.language === 'es' ? 'es' : 'en';
    document.documentElement.lang = lang;
    document.title = `${firstName(person.name) || t('my_day')} · ${t('my_day')}`;
  }

  // Load again and redraw the day view if anything changed. A failure keeps what's on screen
  // and says so above it; the next refresh tries again.
  async function refresh() {
    if (view !== 'day') return;
    let day;
    try {
      day = await fetchDay();
    } catch (err) {
      if (view === 'day' && state) { notice = friendly(err) === t('offline') ? t('refresh_failed') : friendly(err); renderDay(true); }
      return;
    }
    if (!day) { showProblem('bad_link'); return; }
    const hadNotice = !!notice;
    notice = '';
    accept(day);
    if (view === 'day') renderDay(hadNotice);
  }

  // Focus, coming back into view and the 5-minute timer. Skipped while a tick or undo is in
  // flight (it refreshes when it's done) and right after another load.
  function refreshSoon() {
    if (document.visibilityState === 'hidden' || busy) return;
    if (view === 'problem' && root.querySelector('[data-act="retry"]')) { start(); return; }
    if (view !== 'day' || !state || Date.now() - lastLoad < 1000) return;
    refresh();
  }

  // ============================================
  // TOASTS (the shared .toasts styles from styles.css)
  // toast(msg) for a few seconds; { error: true } in red; { action: { label, onClick }, ms } adds
  // a button and a close button, and replaces an older toast with a button.
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
  }

  // ============================================
  // TICK AND UNDO
  // ============================================
  async function tick(box) {
    const row = box.closest('.irow');
    const it = row && rows[Number(row.dataset.i)];
    if (!it || box.disabled) return;
    box.disabled = true;
    box.setAttribute('aria-checked', 'true');
    row.classList.add('is-ticked');
    busy++;
    let reload = true;
    try {
      // p_occurrence is the date the page showed, so a page left open can't tick off the next one.
      const logId = await rpc(sb.rpc('complete_by_token', { p_token: token, p_task_id: it.item_id, p_occurrence: it.occurrence }));
      if (!logId) { showProblem('bad_link'); return; }
      toast(t('ticked', { title: it.title }), { ms: UNDO_MS, action: { label: t('undo'), onClick: () => undo(logId) } });
    } catch (err) {
      box.disabled = false;
      box.setAttribute('aria-checked', 'false');
      row.classList.remove('is-ticked');
      toast(friendly(err), { error: true });
      reload = isStale(err);   // someone else ticked it: show the list as it is now
    } finally {
      busy--;
    }
    if (reload && !busy) await refresh();
  }

  async function undo(logId) {
    busy++;
    let reload = true;
    try {
      const taskId = await rpc(sb.rpc('undo_by_token', { p_token: token, p_log_id: logId }));
      if (!taskId) { showProblem('bad_link'); return; }
      toast(t('undone'));
    } catch (err) {
      toast(friendly(err), { error: true });
      reload = !/Failed to fetch|NetworkError|Load failed/i.test(String(err && err.message));
    } finally {
      busy--;
    }
    if (reload && !busy) await refresh();
  }

  // ============================================
  // "ADD TO HOME SCREEN" HINT (phones, until dismissed on this device)
  // ============================================
  function readHintOff() {
    try { return localStorage.getItem(HINT_KEY) === '1'; } catch (e) { return false; }
  }
  function phoneKind() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    return /Android/.test(ua) ? 'android' : null;
  }
  const standalone = () => navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  function hintHTML() {
    const kind = phoneKind();
    if (hintOff || !kind || standalone()) return '';
    return `<aside class="day-hint" aria-label="${esc(t('hint_label'))}">
      <p>${esc(t(kind === 'ios' ? 'hint_ios' : 'hint_android'))}</p>
      <button type="button" class="day-hint-x" data-act="hint-off" aria-label="${esc(t('dismiss'))}">×</button>
    </aside>`;
  }
  function dismissHint() {
    hintOff = true;
    try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* hidden for this visit only */ }
    const el = root.querySelector('.day-hint');
    if (el) el.remove();
  }

  // ============================================
  // VIEWS
  // ============================================
  function headerHTML() {
    const person = state.person || {};
    return `<header class="day-head">
      <p class="eyebrow">${esc(t('my_day'))}</p>
      <h1>${esc(t('hi', { name: firstName(person.name) }))}</h1>
      <p class="meta">${esc(fmt.long(state.today))}</p>
    </header>`;
  }
  const footerHTML = () => `<p class="footer">${esc(t('footer'))}</p>`;

  // One item as a row (the shared .irow styles): time, a box to tick for their own open tasks,
  // the title with place and contact, and a call button for a linked contact with a phone.
  function rowHTML(it, i, late) {
    const status = it.status || 'open';
    const isTask = it.kind === 'task';
    const timed = !it.all_day && !!it.start_time;
    let top;
    let sub = '';
    let untimed = false;
    if (late) {
      top = fmt.rel(it.day, state.today);
      sub = timed ? it.time_label || fmt.time(it.start_time) : '';
    } else if (it.end_day && it.day && it.end_day > it.day) {
      top = fmt.short(it.day);
      sub = `– ${fmt.short(it.end_day)}`;
    } else if (timed) {
      top = it.time_label || fmt.time(it.start_time);
      if (!isTask && it.end_time) sub = fmt.time(it.end_time);
    } else {
      top = isTask ? t('any_time') : t('all_day');
      untimed = true;
    }
    const canTick = !!it.mine && isTask && (status === 'open' || status === 'late');
    const ticked = !!it.mine && isTask && status === 'done';
    // Who else is on it ("with Jordan"; for someone along, who's in charge), then the place and the contact.
    const details = [it.who, it.location, it.contractor_name].filter(Boolean).map(esc).join(' · ');
    const badge = status === 'skipped' ? `<span class="badge skipped">${esc(t('skipped'))}</span>` : '';
    const who = [it.contractor_name, it.contractor_phone].filter(Boolean).join(' ');
    return `<div class="irow st-${esc(status)} k-${esc(it.kind)}" data-i="${i}">
      <div class="irow-time${untimed ? ' untimed' : ''}"><span>${esc(top)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      ${canTick || ticked ? `<button type="button" class="irow-check day-check" role="checkbox" aria-checked="${ticked}"${ticked ? ' disabled' : ''} aria-label="${esc(t('done_label', { title: it.title }))}"><span class="irow-box">${ICON.check}</span></button>` : ''}
      <div class="irow-main"><span class="irow-title">${esc(it.title)}</span>${details || badge ? `<span class="irow-sub">${badge}${details}</span>` : ''}</div>
      ${it.contractor_phone ? `<a class="irow-call" href="${esc(telHref(it.contractor_phone))}" aria-label="${esc(t('call', { name: who }))}" title="${esc(t('call', { name: who }))}">${ICON.phone}</a>` : ''}
    </div>`;
  }

  // A key for an item, to keep the focus on it when the list is redrawn.
  const itemKey = (it, where) => `${where}|${it.kind}|${it.item_id}|${it.occurrence}`;

  // The day view. force: redraw even if the answer is the same as the one on screen.
  function renderDay(force) {
    view = 'day';
    const json = JSON.stringify(state);
    if (!force && json === drawn && root.querySelector('.day-sec')) return;
    drawn = json;

    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.irow');
    const focusKey = focused && root.contains(focused) ? focused.dataset.key : null;
    const focusCall = !!(focused && document.activeElement.classList.contains('irow-call'));

    rows = [];
    const keys = [];
    const list = (items, where, emptyText) => {
      const html = (Array.isArray(items) ? items : []).map((it) => {
        rows.push(it);
        keys.push(itemKey(it, where));
        return rowHTML(it, rows.length - 1, where === 'late');
      }).join('');
      return `<div class="day-list irows">${html || `<p class="empty-line">${esc(emptyText)}</p>`}</div>`;
    };
    const days = Array.isArray(state.days) ? state.days : [];
    const late = Array.isArray(state.late) ? state.late : [];
    const section = (id, title, date, body, extra) => `<section class="day-sec${extra || ''}" aria-labelledby="${id}">
        <h2 class="sec-head" id="${id}"><span>${esc(title)}</span>${date ? `<span class="day-date">${esc(date)}</span>` : ''}</h2>
        ${body}
      </section>`;
    // Today first, then anything late (it still needs doing), then tomorrow.
    const today = days[0] || { day: state.today, items: [] };
    const tomorrow = days[1] || null;
    const parts = [
      section('day-today', fmt.rel(today.day, state.today), fmt.day(today.day), list(today.items, 'today', t('nothing_today'))),
      late.length ? section('day-late', t('late'), '', list(late, 'late', ''), ' is-late') : '',
      tomorrow ? section('day-tomorrow', fmt.rel(tomorrow.day, state.today), fmt.day(tomorrow.day), list(tomorrow.items, 'tomorrow', t('nothing_tomorrow'))) : '',
    ];
    root.innerHTML = `${headerHTML()}${hintHTML()}
      ${notice ? `<p class="banner banner-warn day-notice" role="status">${esc(notice)}</p>` : ''}
      ${parts.join('')}
      ${footerHTML()}`;
    root.querySelectorAll('.irow').forEach((r) => { r.dataset.key = keys[Number(r.dataset.i)]; });

    if (focusKey) {
      const again = [...root.querySelectorAll('.irow')].find((r) => r.dataset.key === focusKey);
      const target = again && (again.querySelector(focusCall ? '.irow-call' : '.day-check:not([disabled])') || again.querySelector('.day-check, .irow-call'));
      if (target) target.focus();
    }
  }

  // #confirm and #stop: one question, one button. Nothing changes until it is pressed.
  function renderAsk(kind) {
    view = kind;
    const person = state.person || {};
    let body;
    if (kind === 'confirm' && !CODE.test(confirmCode)) {
      body = `<p class="banner banner-error" role="alert">${esc(t('confirm_missing'))}</p>`;
    } else if (kind === 'confirm' && person.email_confirmed) {
      body = `<p class="day-ok" role="status">${esc(t('confirm_already'))}</p>`;
    } else if (kind === 'stop' && person.digest_enabled === false) {
      body = `<p class="day-ok" role="status">${esc(t('stop_already'))}</p>`;
    } else {
      body = `<p>${esc(t(`${kind}_body`))}</p>
        <button type="button" class="btn ${kind === 'confirm' ? 'btn-primary' : 'btn-danger'} day-big" data-act="${kind}">${esc(t(`${kind}_yes`))}</button>
        <p class="day-result" role="status" hidden></p>`;
    }
    root.innerHTML = `${headerHTML()}
      <section class="day-panel" aria-labelledby="day-ask">
        <h2 id="day-ask">${esc(t(`${kind}_q`))}</h2>
        ${body}
        <p class="day-actions"><a class="btn day-link" href="${esc(dayHref)}">${esc(t('see_day'))}</a></p>
      </section>
      ${footerHTML()}`;
  }

  async function answerAsk(btn) {
    const kind = btn.dataset.act;
    const result = root.querySelector('.day-result');
    btn.disabled = true;
    btn.textContent = t('working');
    result.hidden = true;
    let ok;
    try {
      ok = kind === 'confirm'
        ? await rpc(sb.rpc('confirm_digest', { p_confirm: confirmCode }))
        : await rpc(sb.rpc('stop_digest', { p_token: token }));
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t(`${kind}_yes`);
      result.className = 'day-result banner banner-error';
      result.textContent = friendly(err);
      result.hidden = false;
      return;
    }
    if (confirmOnly) {
      confirmed = ok === true ? 'ok' : 'bad';
      renderConfirmOnly();
      return;
    }
    if (ok === true) {
      if (kind === 'confirm') state.person.email_confirmed = true;
      else state.person.digest_enabled = false;
      // Done: drop the hash and the confirmation code, so reloading (or saving the page to the
      // home screen) shows the day.
      try { history.replaceState(null, '', dayHref); } catch (e) { /* the address stays as it was */ }
      btn.remove();
      result.className = 'day-result day-ok';
      result.textContent = t(`${kind}_ok`);
    } else {
      // false: the link is no longer valid (or, for confirm, the code doesn't match).
      btn.remove();
      result.className = 'day-result banner banner-error';
      result.textContent = kind === 'confirm' ? t('confirm_bad') : t('bad_link');
    }
    result.hidden = false;
  }

  // The confirmation email's page (day.html?c=<secret>#confirm): the question and one button, in the
  // device's language with a switch to the other one (the page doesn't know whose address it is).
  function renderConfirmOnly() {
    view = 'confirm';
    document.documentElement.lang = lang;
    document.title = `${t('email_title')} · Home Hub`;
    const other = lang === 'es' ? 'en' : 'es';
    let body;
    if (!CODE.test(confirmCode)) {
      body = `<p class="banner banner-error" role="alert">${esc(t('confirm_missing'))}</p>`;
    } else if (confirmed === 'ok') {
      body = `<p class="day-result day-ok" role="status">${esc(t('confirm_ok'))}</p>`;
    } else if (confirmed === 'bad') {
      body = `<p class="day-result banner banner-error" role="status">${esc(t('confirm_bad'))}</p>`;
    } else {
      body = `<p>${esc(t('confirm_body'))}</p>
        <button type="button" class="btn btn-primary day-big" data-act="confirm">${esc(t('confirm_yes'))}</button>
        <p class="day-result" role="status" hidden></p>`;
    }
    root.innerHTML = `<header class="day-head"><p class="eyebrow">Home Hub</p></header>
      <section class="day-panel" aria-labelledby="day-ask">
        <h2 id="day-ask">${esc(t('confirm_q'))}</h2>
        ${body}
        <p class="day-actions"><button type="button" class="btn day-lang" data-act="lang" lang="${other}">${esc(t('switch_lang'))}</button></p>
      </section>`;
  }

  // A link that doesn't work, a site that isn't set up, or a first load that failed. Before the
  // person is known the message is shown in both languages, the device's first.
  function showProblem(key, retry) {
    view = 'problem';
    const other = lang === 'es' ? 'en' : 'es';
    const message = typeof key === 'function' ? key : () => t(key);
    const both = !state;
    root.innerHTML = `<header class="day-head"><p class="eyebrow">${esc(t('my_day'))}</p></header>
      <div class="banner banner-error day-problem" role="alert">
        <p lang="${lang}">${esc(message(lang))}</p>
        ${both ? `<p class="day-alt" lang="${other}">${esc(withLang(other, () => message(other)))}</p>` : ''}
      </div>
      ${retry ? `<p class="day-actions"><button type="button" class="btn btn-primary day-big" data-act="retry">${esc(t('try_again'))}</button></p>` : ''}`;
  }
  function withLang(l, fn) {
    const was = lang;
    lang = l;
    try { return fn(); } finally { lang = was; }
  }

  // ============================================
  // START
  // ============================================
  const viewFromHash = () => ({ '#confirm': 'confirm', '#stop': 'stop' }[location.hash] || 'day');

  function render() {
    const v = viewFromHash();
    if (v === 'day') renderDay(true);
    else renderAsk(v);
  }

  async function start() {
    root.innerHTML = `<p class="loading">${esc(t('loading'))}</p>`;
    view = 'loading';
    let day;
    try {
      day = await fetchDay();
    } catch (err) {
      showProblem(() => friendly(err), true);
      return;
    }
    if (!day) { showProblem('bad_link'); return; }
    accept(day);
    render();
  }

  root.addEventListener('click', (e) => {
    const box = e.target.closest('.day-check');
    if (box) { tick(box); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'hint-off') dismissHint();
    else if (act.dataset.act === 'retry') start();
    else if (act.dataset.act === 'confirm' || act.dataset.act === 'stop') answerAsk(act);
    else if (act.dataset.act === 'lang') { lang = lang === 'es' ? 'en' : 'es'; renderConfirmOnly(); }
  });

  if (confirmOnly) {
    if (!cfg.supabaseUrl || !cfg.supabaseKey) { showProblem('not_setup'); return; }
    if (!window.supabase || !window.supabase.createClient) { showProblem('not_loaded'); return; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    renderConfirmOnly();
    return;
  }
  if (!token) { showProblem('no_token'); return; }
  if (!CODE.test(token)) { showProblem('bad_link'); return; }
  if (!cfg.supabaseUrl || !cfg.supabaseKey) { showProblem('not_setup'); return; }
  if (!window.supabase || !window.supabase.createClient) { showProblem('not_loaded'); return; }
  // No session at all: this page is anonymous, and never reads or keeps a hub sign-in.
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  window.addEventListener('hashchange', () => { if (state && view !== 'problem') render(); });
  window.addEventListener('focus', refreshSoon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshSoon(); });
  setInterval(refreshSoon, REFRESH_MS);
  start();
})();
