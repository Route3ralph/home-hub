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
   One request at a time: every call to the database waits for the one
   before it.
   v1.2 (docs/v1.2-kitchen.md §7, §8): each day's meals are its last rows
   (days[i].meals), with the note and recipe link for the person on it.
   A helper whose answer has `list` gets a "Shopping list · 7 ›" button
   that opens #list: the household's list from get_list_by_token, to tick
   off (buy_item_by_token, with Undo for 15 minutes) and add to
   (add_to_list_by_token), read again every 10 seconds while it is on
   screen. Every change goes through the outbox in assets/shoplist.js,
   which keeps the queue and the last list on the phone under a hash of
   the token (never the token), so the list read at home still shows in
   the store when the signal doesn't reach Home Hub.
   v1.3 (docs/v1.3-homework.md §7, §8, §9.5, §9.6): a kid whose answer has `homework` gets a card under
   the greeting (the next step and its own Start) and #homework (Now, Tonight, From earlier, Due soon),
   #focus (the timer, the stuck sheet, the end screen), #points and #plan/<id> (plan.js's editor in his
   role), from homework_by_token and his six writers; without the key (anyone else, homework off, a
   database before 0005, or no plan.js) there is no card and no homework request. day.html?h=<token>,
   with no t=, is the tutor link: nobody's day is loaded, and plan.js's tutor view draws Jordan's homework
   with the four tutor functions only.
   Loads config.js, supabase-js, shoplist.js and plan.js only, never the hub.
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
  const shop = window.HomeShop || null;   // assets/shoplist.js: the list's aisles, outbox and hold
  const plan = window.HomePlan || null;   // assets/plan.js (v1.3): homework's words, timer, editor and the tutor view
  const tutorToken = String(query.get('h') || '').trim().toLowerCase();
  const tutorMode = !token && query.has('h');   // the tutor link: Jordan's homework, nobody's day

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
    dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
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
      // v1.2: meals and the shopping list (docs/v1.2-kitchen.md §7.4)
      shopping_list: 'Shopping list', back_to_day: '‹ My day', add_placeholder: 'Add something…', add: 'Add',
      bought_today: 'Bought today', buy_again: 'Buy again', bought_toast: 'Bought: {title}', add_again: 'Add it again?',
      already_on_list: 'Already on the list', already_as: 'Already on the list as {name}', back_on_list: 'Back on the list',
      changed_elsewhere: 'Changed on another phone', nothing_to_buy: 'Nothing to buy', not_sent: 'not sent yet',
      n_not_sent: "{n} changes not sent yet. They'll go when there's signal; keep this page open.",
      saved_list: 'No connection: this is the list from {when}.',
      n_expired: '{n} changes waited more than a day and were not sent.',
      you_cook: 'You cook', recipe: 'Recipe', type_item: 'Type what to buy.',
      too_many_today: "That's a lot for one day. Ask the family to add the rest.",
      list_full: 'The list is full.', no_list: "The shopping list isn't on your My day.",
      // v1.3: homework (docs/v1.3-homework.md §9.6, §9.7); plan.js has the rest of its words. {tutor} is the first
      // word of his tutor link's label; with none, a key's "_none" words are used.
      hw_one_step: '1 step', hw_n_steps: '{n} steps', hw_n_earlier: '{n} from earlier', hw_next: 'Next: {text}', hw_open: 'Open ›',
      hw_nothing: 'Nothing planned for tonight.', hw_block_done: 'Your block is over. How did it go? ›',
      hw_now_line: 'Now · homework time {from}–{to}', hw_step_of: '{assignment} · step {n} of {m} · {min} min',
      hw_tonight_line: 'Tonight · {p} min planned · {f} min of homework time', hw_length: 'Length',
      hw_alone: 'Alone', hw_with_tutor: 'With {tutor}', hw_with_parent: 'With a parent', hw_with: 'Working with',
      hw_cue_edit: 'Your start cue', hw_cue_add: 'Write your start cue ✎', hw_cue_hint: 'When I…, I…',
      hw_stuck_title: 'Stuck?', hw_stuck_plan: 'Stuck? Your plan: “{text}”', hw_stuck_none: 'Write your own if-stuck plan ✎',
      hw_stuck_edit: 'Your if-stuck plan', hw_stuck_hint: 'If I…, I’ll…',
      hw_smaller_hint: 'a tiny first piece', hw_chip_0: 'Write one sentence', hw_chip_1: "List what's unclear", hw_chip_2: 'Do the easiest part',
      hw_own: 'or your own', hw_ask_hint: 'a short question {tutor} sees; this step stays open', hw_ask_hint_none: 'a short question your parents see; this step stays open',
      hw_back_timer: 'Back to the timer', hw_cancel: 'Cancel', hw_send: 'Send', hw_save: 'Save', hw_question_sent: 'Question sent.',
      hw_done_btn: 'Done', hw_stop: 'Stop', hw_time_up: 'Time. How did it go?', hw_finished: 'Block finished.',
      hw_done_check: 'Step done ✓', hw_break_btn: 'Break · 5 min', hw_skip_break: 'Skip break', hw_next_btn: 'Next: {title} ›',
      hw_not_sent: "Not sent yet. It goes when there's a connection.", hw_moved: 'Moved to {day}', hw_edit: 'Edit',
      hw_quick_q: 'About how many minutes?', hw_add_title: 'What', hw_add_subject: 'Class', hw_add_due: 'Due', hw_add_btn: 'Add',
      hw_add_need: 'Type what the homework is.', hw_add_need_due: 'Pick a due date from today to 60 days ahead.',
      hw_add_minutes_bad: 'Type 5 to 60 minutes.', hw_stretch: 'Optional: {text}', hw_you_asked: 'You asked: {text}',
      hw_from_parents: 'Your parents', hw_from_tutor_none: 'Your tutor', hw_off: "Homework isn't on your My day right now.",
      hw_not_yours: "That isn't on your list any more.",
      hw_points: 'Points', hw_today_plus: '+{n} today', hw_free: '{n} free to trade', hw_n_more: '{n} more', hw_ask_btn: 'Ask',
      hw_asked: 'Asked', hw_rewards: 'Rewards', hw_suggest_btn: 'Suggest', hw_suggest_hint: 'A parent prices it.', hw_recent: 'Recent',
      hw_decided: 'Decided', hw_yes: 'Yes', hw_not_now: 'Not now', hw_not_now_note: 'Not now: {note}', hw_suggested: 'Sent to your parents: {title}',
      hw_asked_toast: 'Asked: {title}', hw_no_rewards: 'No rewards yet. Suggest one.',
      hw_k_focus: 'Focus', hw_k_on_time: 'On time', hw_k_milestone: 'Milestone checked', hw_k_given: 'From your parents', hw_k_void: 'Void',
      hw_k_trade: 'Trade', hw_back_home: '‹ Homework', hw_notify: 'Show a notification when a block ends', hw_notify_body: 'Your block is over.',
      hw_being_planned: 'Being planned', hw_start: 'Start',
      // PR B: a plan made with an AI draft says so (§6.10); his view carries no parent's name.
      hw_ai_help: 'Plan by {tutor}, with AI help', hw_ai_help_none: 'Plan by your parents, with AI help', hw_ai_help_family: 'Plan by your parents, with AI help',
      // 0006: New from school (docs/v1.3-homework.md §11.4)
      hw_school: 'New from school ({n})', hw_school_card: 'New from school: {n} ›', hw_school_quick: 'Quick · {n} min',
      hw_school_pat: 'Plan with {tutor}', hw_school_pat_none: 'Plan with your parents', hw_school_hide: 'Hide',
      hw_school_planned: 'Planned for {day}: {title}', hw_school_for_pat: 'On your homework, to plan with {tutor}: {title}',
      hw_school_for_pat_none: 'On your homework, to plan with your parents: {title}', hw_school_hidden: 'Hidden: {title}. A parent can bring it back.',
      hw_school_more: '{n} more', hw_school_gone: 'No longer on the school site', hw_school_moved: 'The school moved it to {day}',
      hw_school_not_yours: "That isn't on your list from school any more.", hw_school_already: 'That one is on your homework already.',
      hw_cash_btn: 'Get it now', hw_cash_sure: 'Yes, get it · −{n}', hw_cashed_toast: 'Got it: {title}. Tell a parent.', hw_instant: 'instant',
      hw_got: 'Got it', hw_k_milestone_done: 'Milestone done', hw_cash_none: 'No more instant rewards today: ask a parent.',
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
      shopping_list: 'Lista de compras', back_to_day: '‹ Mi día', add_placeholder: 'Añadir algo…', add: 'Añadir',
      bought_today: 'Comprado hoy', buy_again: 'Comprar otra vez', bought_toast: 'Comprado: {title}', add_again: '¿Añadir otra vez?',
      already_on_list: 'Ya está en la lista', already_as: 'Ya está en la lista como {name}', back_on_list: 'Otra vez en la lista',
      changed_elsewhere: 'Cambiado en otro teléfono', nothing_to_buy: 'Nada por comprar', not_sent: 'sin enviar',
      n_not_sent: '{n} cambios sin enviar. Se enviarán cuando haya señal; no cierres esta página.',
      saved_list: 'Sin conexión: esta es la lista de las {when}.',
      n_expired: '{n} cambios esperaron más de un día y no se enviaron.',
      you_cook: 'Cocinas tú', recipe: 'Receta', type_item: 'Escribe qué comprar.',
      too_many_today: 'Es mucho para un día. Pide a la familia que añada el resto.',
      list_full: 'La lista está llena.', no_list: 'La lista de compras no está en tu Mi día.',
      hw_one_step: '1 paso', hw_n_steps: '{n} pasos', hw_n_earlier: '{n} de antes', hw_next: 'Siguiente: {text}', hw_open: 'Abrir ›',
      hw_nothing: 'Nada planeado para esta tarde.', hw_block_done: 'Tu bloque terminó. ¿Qué tal fue? ›',
      hw_now_line: 'Ahora · tiempo de tarea {from}–{to}', hw_step_of: '{assignment} · paso {n} de {m} · {min} min',
      hw_tonight_line: 'Esta tarde · {p} min planeados · {f} min de tiempo de tarea', hw_length: 'Duración',
      hw_alone: 'Solo', hw_with_tutor: 'Con {tutor}', hw_with_parent: 'Con tu madre o tu padre', hw_with: 'Con quién',
      hw_cue_edit: 'Tu señal para empezar', hw_cue_add: 'Escribe tu señal para empezar ✎', hw_cue_hint: 'Cuando…, …',
      hw_stuck_title: '¿Atascado?', hw_stuck_plan: '¿Atascado? Tu plan: “{text}”', hw_stuck_none: 'Escribe tu plan para cuando te atasques ✎',
      hw_stuck_edit: 'Tu plan para cuando te atasques', hw_stuck_hint: 'Si…, …',
      hw_smaller_hint: 'un primer trozo pequeño', hw_chip_0: 'Escribe una frase', hw_chip_1: 'Apunta lo que no está claro', hw_chip_2: 'Haz la parte más fácil',
      hw_own: 'o el tuyo', hw_ask_hint: 'una pregunta corta que ve {tutor}; este paso sigue abierto', hw_ask_hint_none: 'una pregunta corta que ven tus padres; este paso sigue abierto',
      hw_back_timer: 'Volver al temporizador', hw_cancel: 'Cancelar', hw_send: 'Enviar', hw_save: 'Guardar', hw_question_sent: 'Pregunta enviada.',
      hw_done_btn: 'Hecho', hw_stop: 'Parar', hw_time_up: 'Tiempo. ¿Qué tal fue?', hw_finished: 'Bloque terminado.',
      hw_done_check: 'Paso hecho ✓', hw_break_btn: 'Descanso · 5 min', hw_skip_break: 'Saltar el descanso', hw_next_btn: 'Siguiente: {title} ›',
      hw_not_sent: 'Sin enviar. Se enviará cuando haya conexión.', hw_moved: 'Pasado a {day}', hw_edit: 'Editar',
      hw_quick_q: '¿Unos cuántos minutos?', hw_add_title: 'Qué', hw_add_subject: 'Asignatura', hw_add_due: 'Para', hw_add_btn: 'Añadir',
      hw_add_need: 'Escribe qué tarea es.', hw_add_need_due: 'Elige una fecha de entrega entre hoy y dentro de 60 días.',
      hw_add_minutes_bad: 'Escribe de 5 a 60 minutos.', hw_stretch: 'Opcional: {text}', hw_you_asked: 'Preguntaste: {text}',
      hw_from_parents: 'Tus padres', hw_from_tutor_none: 'Tu tutor', hw_off: 'La tarea no está en tu Mi día ahora mismo.',
      hw_not_yours: 'Eso ya no está en tu lista.',
      hw_points: 'Puntos', hw_today_plus: '+{n} hoy', hw_free: '{n} libres para cambiar', hw_n_more: 'faltan {n}', hw_ask_btn: 'Pedir',
      hw_asked: 'Pedido', hw_rewards: 'Premios', hw_suggest_btn: 'Proponer', hw_suggest_hint: 'Tus padres le ponen precio.', hw_recent: 'Últimos movimientos',
      hw_decided: 'Decididos', hw_yes: 'Sí', hw_not_now: 'Ahora no', hw_not_now_note: 'Ahora no: {note}', hw_suggested: 'Enviado a tus padres: {title}',
      hw_asked_toast: 'Pedido: {title}', hw_no_rewards: 'Todavía no hay premios. Propón uno.',
      hw_k_focus: 'Concentración', hw_k_on_time: 'A tiempo', hw_k_milestone: 'Hito revisado', hw_k_given: 'De tus padres', hw_k_void: 'Anulado',
      hw_k_trade: 'Cambio', hw_back_home: '‹ Tarea', hw_notify: 'Avisar con una notificación cuando termine un bloque', hw_notify_body: 'Tu bloque terminó.',
      hw_being_planned: 'En preparación', hw_start: 'Empezar',
      hw_ai_help: 'Plan de {tutor}, con ayuda de IA', hw_ai_help_none: 'Plan de tus padres, con ayuda de IA', hw_ai_help_family: 'Plan de tus padres, con ayuda de IA',
      hw_school: 'Nuevo de la escuela ({n})', hw_school_card: 'Nuevo de la escuela: {n} ›', hw_school_quick: 'Rápido · {n} min',
      hw_school_pat: 'Planear con {tutor}', hw_school_pat_none: 'Planear con tus padres', hw_school_hide: 'Ocultar',
      hw_school_planned: 'Planeado para {day}: {title}', hw_school_for_pat: 'En tu tarea, para planear con {tutor}: {title}',
      hw_school_for_pat_none: 'En tu tarea, para planear con tus padres: {title}', hw_school_hidden: 'Oculta: {title}. Tus padres pueden recuperarla.',
      hw_school_more: '{n} más', hw_school_gone: 'Ya no está en el sitio de la escuela', hw_school_moved: 'La escuela la pasó a {day}',
      hw_school_not_yours: 'Eso ya no está en tu lista de la escuela.', hw_school_already: 'Esa ya está en tu tarea.',
      hw_cash_btn: 'Conseguir ya', hw_cash_sure: 'Sí, conseguirlo · −{n}', hw_cashed_toast: 'Conseguido: {title}. Avisa a tus padres.', hw_instant: 'al momento',
      hw_got: 'Conseguido', hw_k_milestone_done: 'Hito hecho', hw_cash_none: 'Hoy no quedan premios al momento: pídeselo a tus padres.',
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
    // A list's as_of ('2026-10-25T15:42', the household's date and time when it was read) →
    // '3:42pm' / '15:42', with the weekday in front ('Sun 3:42pm' / 'dom 15:42') when it isn't
    // today, or when today isn't known (the day didn't load).
    when(asOf) {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(asOf || ''));
      const p = m && dateParts(m[1]);
      if (!p) return '';
      return state && state.today === m[1] ? fmt.time(m[2]) : `${DAYS[lang][p.weekday].slice(0, 3)} ${fmt.time(m[2])}`;
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
    // The shopping list's (v1.2), before the 42501 line below: several of them are 42501 too.
    if (/Type what to buy/i.test(msg)) return t('type_item');
    if (/Too many (changes|ticks)/i.test(msg)) return t('too_many_today');
    if (/The list is full/i.test(msg)) return t('list_full');
    if (/isn't on your My day|can't add to the list/i.test(msg)) return t('no_list');
    if (/Only your own tick/i.test(msg)) return t('too_late_undo');
    // Homework's (v1.3), before the 42501 line too, in plan.js's words with his tutor's name.
    if (plan && HW_MESSAGES.test(msg)) return plan.friendly(err, lang, hwTutor());
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

  // One request at a time: one(() => sb.rpc(…)) starts the call once the one before it has its
  // answer, and resolves to what supabase-js gives back ({ data, error, status }).
  let line = Promise.resolve();
  function one(start) {
    const p = line.then(start);
    line = p.then(() => {}, () => {});
    return p;
  }

  // One get_person_day request at a time; a second caller shares the one in flight.
  // Resolves to the answer (null for a link that doesn't work).
  function fetchDay() {
    if (!loading) {
      loading = rpc(one(() => sb.rpc('get_person_day', { p_token: token })))
        .then((day) => { lastLoad = Date.now(); dayAt = perfNow(); return day && typeof day === 'object' ? day : null; })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  function accept(day) {
    state = day;
    lang = (day.person || {}).language === 'es' ? 'es' : 'en';
    document.documentElement.lang = lang;
    dayTitle();
  }
  const dayTitle = () => { document.title = `${firstName((state.person || {}).name) || t('my_day')} · ${t('my_day')}`; };

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
    if (!day) { linkGone(); return; }
    const hadNotice = !!notice;
    notice = '';
    accept(day);
    if (view === 'day') renderDay(hadNotice);
    afterDay(day);
  }

  // Focus, coming back into view, coming back online and the 5-minute timer. On #list: send what
  // waits and read the list. Otherwise skipped while a tick or undo is in flight (it refreshes when
  // it's done) and right after another load.
  function refreshSoon() {
    if (document.visibilityState === 'hidden') return;
    if (outbox) outbox.kick();
    // A block runs on any view (#homework, the day, not only #focus): coming back to whichever, the wake lock the
    // browser let go of while the page was hidden is taken again, and the chime is set on the audio clock again.
    if (hv && hv.session) keepAwakeAgain();
    chimeAgain();
    if (view === 'list') { pollList(); return; }
    if (HW_VIEWS.has(view)) { homeworkSoon(); return; }
    if (busy) return;
    if (view === 'problem' && root.querySelector('[data-act="retry"]')) { start(); return; }
    if (view !== 'day' || !state || Date.now() - lastLoad < 1000) return;
    refresh();
  }

  // The link no longer works (a token function answered null): forget the list saved for it.
  function linkGone() {
    if (outbox) outbox.forget();
    if (state) delete state.list;
    showProblem('bad_link');
  }

  // ============================================
  // TOASTS (the shared .toasts styles from styles.css)
  // toast(msg) for a few seconds; { error: true } in red; { action: { label, onClick }, ms } adds
  // a button and a close button, and replaces an older toast with a button. Returns the toast
  // (el.closeToast() closes it).
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
      const logId = await rpc(one(() => sb.rpc('complete_by_token', { p_token: token, p_task_id: it.item_id, p_occurrence: it.occurrence })));
      if (!logId) { linkGone(); return; }
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
      const taskId = await rpc(one(() => sb.rpc('undo_by_token', { p_token: token, p_log_id: logId })));
      if (!taskId) { linkGone(); return; }
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

  // A meal (v1.2, get_person_day's days[i].meals), the day's last row: the slot's word where the time
  // goes ("Cena"), the title ("Private item" for a locked meal they aren't on), who's on it ("Cocina
  // Sam", "Cocinas tú"), all worded by the database. Never a box. For the person on it, the note and
  // the recipe link (its host name shown, so the real address can't hide).
  function mealHTML(m, day) {
    const host = m.mine ? linkHost(m.link) : null;
    const more = [
      m.cook_word ? `<span class="irow-sub">${esc(m.cook_word)}</span>` : '',
      m.mine && m.note ? `<span class="meal-note">${esc(m.note)}</span>` : '',
      host ? `<a class="meal-recipe" href="${esc(host.href)}" target="_blank" rel="noopener noreferrer">${esc(t('recipe'))} · ${esc(host.name)}</a>` : '',
    ].join('');
    return `<div class="irow k-meal${m.mine ? ' is-mine' : ''}" data-key="meal|${esc(day)}|${esc(m.slot)}">
      <div class="irow-time untimed"><span>${esc(m.label)}</span></div>
      <div class="irow-main"><span class="irow-title">${esc(m.title)}</span>${more}</div>
    </div>`;
  }
  // A recipe link's address and host name ('cooking.example.com'), or null for anything but https.
  function linkHost(link) {
    try {
      const u = new URL(String(link || ''));
      return u.protocol === 'https:' && u.hostname ? { href: u.href, name: u.hostname } : null;
    } catch (e) { return null; }
  }

  // The day view. force: redraw even if the answer is the same as the one on screen.
  function renderDay(force) {
    stopViews('day');
    view = 'day';
    const count = listCount();
    const json = JSON.stringify([state, count, !!cheer]);
    if (!force && json === drawn && root.querySelector('.day-sec')) return;
    drawn = json;
    dayTitle();

    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.irow');
    const focusKey = focused && root.contains(focused) ? focused.dataset.key : null;
    const focusCall = !!(focused && document.activeElement.classList.contains('irow-call'));

    rows = [];
    const keys = [];
    // A day's items, then its meals; "Nothing planned" only when it has neither.
    const list = (items, where, emptyText, meals, day) => {
      const html = (Array.isArray(items) ? items : []).map((it) => {
        rows.push(it);
        keys.push(itemKey(it, where));
        return rowHTML(it, rows.length - 1, where === 'late');
      }).join('') + (Array.isArray(meals) ? meals : []).map((m) => mealHTML(m, day)).join('');
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
      section('day-today', fmt.rel(today.day, state.today), fmt.day(today.day), list(today.items, 'today', t('nothing_today'), today.meals, today.day)),
      late.length ? section('day-late', t('late'), '', list(late, 'late', ''), ' is-late') : '',
      tomorrow ? section('day-tomorrow', fmt.rel(tomorrow.day, state.today), fmt.day(tomorrow.day),
        list(tomorrow.items, 'tomorrow', t('nothing_tomorrow'), tomorrow.meals, tomorrow.day)) : '',
    ];
    // v1.2: a helper with the list on her My day gets its button under the greeting.
    const listButton = count == null ? ''
      : `<p class="day-actions day-shop"><a class="btn day-big day-list-btn" href="#list">${esc(t('shopping_list'))} · ${count} ›</a></p>`;
    root.innerHTML = `${headerHTML()}${cardHTML()}${listButton}${hintHTML()}
      ${notice ? `<p class="banner banner-warn day-notice" role="status">${esc(notice)}</p>` : ''}
      ${parts.join('')}
      ${footerHTML()}`;
    root.querySelectorAll('.irow[data-i]').forEach((r) => { r.dataset.key = keys[Number(r.dataset.i)]; });
    dayFollow();
    // A block paid while he is on the day: the card's balance celebrates (and with no card, the celebration goes).
    playCheer();
    cheer = null;

    if (focusKey) {
      const again = [...root.querySelectorAll('.irow')].find((r) => r.dataset.key === focusKey);
      const target = again && (again.querySelector(focusCall ? '.irow-call' : '.day-check:not([disabled])') || again.querySelector('.day-check, .irow-call'));
      if (target) target.focus();
    }
  }

  // #confirm and #stop: one question, one button. Nothing changes until it is pressed.
  function renderAsk(kind) {
    stopViews(kind);
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
        ? await rpc(one(() => sb.rpc('confirm_digest', { p_confirm: confirmCode })))
        : await rpc(one(() => sb.rpc('stop_digest', { p_token: token })));
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
  // person is known the message is shown in both languages, the device's first (or the language of
  // the list saved for this link). withList: a list is saved for this link, so a button opens it.
  function showProblem(key, retry, withList) {
    stopViews('problem');
    view = 'problem';
    const other = lang === 'es' ? 'en' : 'es';
    const message = typeof key === 'function' ? key : () => t(key);
    const both = !state;
    const buttons = (retry ? `<button type="button" class="btn btn-primary day-big" data-act="retry">${esc(t('try_again'))}</button>` : '')
      + (withList ? `<a class="btn day-big day-list-btn" href="#list">${esc(t('shopping_list'))}</a>` : '');
    root.innerHTML = `<header class="day-head"><p class="eyebrow">${esc(t('my_day'))}</p></header>
      <div class="banner banner-error day-problem" role="alert">
        <p lang="${lang}">${esc(message(lang))}</p>
        ${both ? `<p class="day-alt" lang="${other}">${esc(withLang(other, () => message(other)))}</p>` : ''}
      </div>
      ${buttons ? `<p class="day-actions">${buttons}</p>` : ''}`;
  }
  function withLang(l, fn) {
    const was = lang;
    lang = l;
    try { return fn(); } finally { lang = was; }
  }

  // ============================================
  // THE SHOPPING LIST (#list, v1.2: a helper's, while the family has it on her My day)
  // get_list_by_token(p_token) → { language, as_of, can_add, items: [{ id, name, note, aisle, seen,
  // other? }], bought: [{ id, name, note, aisle, seen, undo }], suggest?: [{ name, aisle, other? }] },
  // or null (the link no longer works, or the list isn't on her My day). Nothing locked, no people.
  // Every tap goes through the outbox (shoplist.js, docs/v1.2-kitchen.md §8): it shows at once, is
  // sent one at a time, waits on the phone ("sin enviar") while nothing gets through, and is saved
  // with the last list under the first 16 hex characters of the token's SHA-256. No row moves under
  // a finger: a tick shows where the row is, and the list is drawn again only 3 seconds after the
  // last tap on it (hold); a read's change waits the same way.
  // ============================================
  let outbox = null;          // made once the token's hash is known (outboxReady, below)
  let listOffline = false;    // the last read of the list got no answer: the list shown is the one saved
  let listReading = false;    // a get_list_by_token request is on its way
  let listTimer = null;       // the 10-second read while #list is on screen
  let listDrawn = '';         // what the list view shows, as JSON, so an unchanged answer doesn't redraw
  let listRows = [];          // the rows on screen, by data-i: { row, where: 'buy' | 'bought' }
  let againRows = [];         // Comprar otra vez's names, by data-again
  let sugRows = [];           // the add box's suggestions, by data-sug
  let sugNote = null;         // and the amount typed with them ("2 hue" → Huevos: 2)
  let againOpen = false;      // Comprar otra vez is unfolded
  let patched = false;        // a tap changed a row in place since the list was last drawn
  let fromDay = false;        // #list was opened from this page, so ‹ My day is the browser's Back
  let tickToast = null;       // { id, el }: the latest tick's Undo toast
  const hold = shop ? shop.hold(shop.HOLD_MS, () => drawList()) : null;

  const readList = () => rpc(one(() => sb.rpc('get_list_by_token', { p_token: token })));
  // The outbox's send(): one change, answered with what supabase-js gives back.
  function sendList(op) {
    return one(() => (op.op === 'add'
      ? sb.rpc('add_to_list_by_token', { p_token: token, p_name: op.name, p_key: op.key })
      : sb.rpc('buy_item_by_token', { p_token: token, p_item: op.item, p_bought: op.op === 'buy', p_seen: op.seen, p_key: op.key })));
  }

  function makeOutbox() {
    if (!shop) return Promise.resolve();
    return shop.tokenOwner(token).then((owner) => {
      outbox = shop.outbox({
        key: shop.KEYS.day, owner, send: sendList, mine: (r) => !!r.undo,
        onChange: listChanged,
        onReply: listReply,
        onRefused: (op, err) => { toast(friendly(err), { error: true }); pollList(); },
        onGone: linkGone,
        onExpired: (n) => toast(t('n_expired', { n }), { ms: 6000 }),
      });
    }).catch((err) => { console.error(err); });
  }

  // The list button's count: the list as this phone has it once it has been read, else
  // get_person_day's. null: no button (no list on this My day).
  function listCount() {
    if (!state || !state.list || !outbox) return null;
    const v = outbox.state().fresh ? outbox.view() : null;
    return v ? (v.items || []).length : Number(state.list.to_buy) || 0;
  }
  // #list can show: the day says the list is on her My day, or (no answer at the start) one is saved.
  const canList = () => !!outbox && (state ? !!state.list : !!outbox.view());

  function stopList() {
    clearInterval(listTimer);
    listTimer = null;
    if (hold) hold.cancel();
  }

  // After a day is drawn: with the list on her My day, send what waits and, from the day view, keep
  // the list on the phone; without it (a kid, the switch Off), forget any list saved for this link.
  function afterDay(day) {
    if (!outbox) return;
    if (!day.list) { outbox.forget(); return; }
    outbox.kick();
    if (view === 'day') saveList(day.list.to_buy);
  }

  // The day view reads the list once in the background, after the day's own request, so it is on the
  // phone before she reaches the store; again when the day brings a different count.
  async function saveList(count) {
    const v = outbox.view();
    if (listReading || (outbox.state().fresh && v && (v.items || []).length === Number(count))) return;
    listReading = true;
    const ticket = outbox.ticket();
    let snap;
    try {
      snap = await readList();
    } catch (err) {
      return;   // the day view doesn't need it; the next refresh tries again
    } finally {
      listReading = false;
    }
    if (!snap) {   // the list was turned off a moment ago (or the link replaced: the next refresh says so)
      outbox.forget();
      if (state) delete state.list;
      if (view === 'day') renderDay(true);
      return;
    }
    outbox.take(snap, ticket);
    listOffline = false;
    if (view === 'day') renderDay(false);
    else if (view === 'list') hold.request();
  }

  // Read the list: every 10 seconds while #list is on screen and the page is visible, at once on
  // opening it, focus, visibilitychange and online. Not while a change is on its way.
  async function pollList() {
    if (view !== 'list' || !outbox || listReading || document.visibilityState === 'hidden' || outbox.state().busy) return;
    listReading = true;
    const ticket = outbox.ticket();
    let snap;
    try {
      if (!state) {
        // The day got no answer at the start: load it first (today's date, and whether the list is
        // still on her My day).
        const day = await fetchDay();
        if (!day) { linkGone(); return; }
        accept(day);
        if (!day.list) { listOff(); return; }
        if (view === 'list') document.title = `${t('shopping_list')} · ${t('my_day')}`;
      }
      snap = await readList();
    } catch (err) {
      listOffline = true;
      if (view === 'list') hold.request();
      return;
    } finally {
      listReading = false;
    }
    if (!snap) { listNull(); return; }
    listOffline = false;
    outbox.take(snap, ticket);
    if (view === 'list') hold.request();
  }

  // get_list_by_token answered null: the link no longer works, or the list isn't on her My day any
  // more (the switch is Off). Either way the list saved for it goes; get_person_day says which.
  async function listNull() {
    outbox.forget();
    stopList();
    root.innerHTML = `<p class="loading">${esc(t('loading'))}</p>`;
    view = 'loading';
    let day;
    try {
      day = await fetchDay();
    } catch (err) {
      showProblem(() => friendly(err), true);
      return;
    }
    if (!day) { linkGone(); return; }
    accept(day);
    listOff();
  }
  // The link works, but the list isn't on her My day: the day, and a word about it.
  function listOff() {
    outbox.forget();
    if (state) delete state.list;
    try { history.replaceState(null, '', dayHref); } catch (e) { /* the hash stays; the day shows all the same */ }
    renderDay(true);
    toast(t('no_list'), { error: true });
  }

  // The outbox's onChange: the list (or the button's count) changed. The day view isn't redrawn in
  // the middle of a task's tick (its refresh redraws it).
  function listChanged() {
    if (view === 'list') hold.request();
    else if (view === 'day' && state && state.list && !busy) renderDay(false);
  }

  // A change was answered (§8.4): an add says where it went; a tick that met a newer change says so.
  function listReply(op, reply, outcome) {
    listOffline = false;
    if (op.op === 'add') {
      if (outcome === 'already') {
        const typed = shop.parse(op.name).name;
        toast(shop.nameKey(reply.name) === shop.nameKey(typed) ? t('already_on_list') : t('already_as', { name: reply.name }));
      } else if (outcome === 'back') {
        toast(t('back_on_list'));
      }
    } else if (outcome === 'changed') {
      toast(t('changed_elsewhere'));
    }
    if (view === 'list') hold.request();
  }

  // #list: the frame (heading, the add box) once; drawList() fills in the rest.
  function renderList() {
    stopViews('list');
    view = 'list';
    const v = outbox.view();
    if (!state && v) lang = v.language === 'es' ? 'es' : 'en';   // the day didn't load: the saved list's language
    document.documentElement.lang = lang;
    document.title = `${t('shopping_list')} · ${t('my_day')}`;
    root.innerHTML = `<header class="day-head list-head">
        <a class="list-back" href="${esc(dayHref)}" data-act="back">${esc(t('back_to_day'))}</a>
        <h1>${esc(t('shopping_list'))}</h1>
      </header>
      <div class="list-banners"></div>
      <form class="list-add" hidden>
        <input type="text" class="list-input" maxlength="100" autocomplete="off" autocapitalize="sentences" enterkeyhint="done"
          placeholder="${esc(t('add_placeholder'))}" aria-label="${esc(t('add_placeholder'))}">
        <button type="submit" class="btn btn-primary list-add-btn">${esc(t('add'))}</button>
        <div class="list-suggest" hidden></div>
      </form>
      <div class="list-body"></div>
      ${footerHTML()}`;
    listDrawn = '';
    drawList(true);
    listTimer = setInterval(pollList, shop.POLL_MS);
    outbox.kick();
    pollList();
  }

  // One row: the whole row is the checkbox. An add that isn't sent yet has no id, so no box.
  function listRowHTML(r, where, canAdd) {
    const i = listRows.push({ row: r, where }) - 1;
    const bought = where === 'bought';
    const inner = `<span class="lrow-main"><span class="lrow-name">${esc(shop.withOther(r))}</span>${r.note ? ` <small class="lrow-note">${esc(r.note)}</small>` : ''}</span>`
      + (r.unsent ? `<small class="lrow-unsent">⟳ ${esc(t('not_sent'))}</small>` : '');
    if (r.id == null) return `<div class="lrow is-new">${inner}</div>`;
    const inert = bought && !r.undo && !canAdd;   // See and tick: an old tick can't be taken back here
    return `<button type="button" class="lrow${bought ? ' is-bought' : ''}" role="checkbox" aria-checked="${bought}" data-i="${i}" data-key="${where}|${esc(r.id)}"${inert ? ' aria-disabled="true"' : ''}>`
      + `<span class="irow-box lrow-box">${ICON.check}</span>${inner}</button>`;
  }

  // Draw the list as the outbox has it (the last answer with the changes still waiting laid over it).
  // force: even if it is the same as the one on screen.
  function drawList(force) {
    if (view !== 'list' || !outbox) return;
    const body = root.querySelector('.list-body');
    if (!body) return;
    const v = outbox.view();
    const st = outbox.state();
    const when = listOffline && v ? fmt.when(v.as_of) : '';
    const key = JSON.stringify([v && Object.assign({}, v, { as_of: null }), listOffline, when, st.banner, lang]);
    if (!force && !patched && key === listDrawn) return;
    listDrawn = key;
    patched = false;

    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-key]');
    const focusKey = focused && body.contains(focused) ? focused.dataset.key : null;

    root.querySelector('.list-banners').innerHTML = (when
      ? `<div class="banner banner-warn list-offline" role="status"><p>${esc(t('saved_list', { when }))}</p>
          <button type="button" class="btn list-retry" data-act="list-retry">${esc(t('try_again'))}</button></div>` : '')
      + (st.banner ? `<p class="banner banner-warn list-unsent" role="status">${esc(t('n_not_sent', { n: st.banner }))}</p>` : '');
    const canAdd = !!(v && v.can_add);
    root.querySelector('.list-add').hidden = !canAdd;
    listRows = [];
    if (!v) {
      body.innerHTML = listOffline
        ? `<p class="banner banner-error" role="alert">${esc(t('offline'))}</p>
           <p class="day-actions"><button type="button" class="btn btn-primary day-big" data-act="list-retry">${esc(t('try_again'))}</button></p>`
        : `<p class="loading">${esc(t('loading'))}</p>`;
      return;
    }
    againRows = canAdd && Array.isArray(v.suggest) ? v.suggest : [];
    const again = againRows.length ? `<details class="list-again"${againOpen ? ' open' : ''}>
        <summary>${esc(t('buy_again'))} (${againRows.length}) ›</summary>
        ${shop.groups(againRows.map((s, i) => Object.assign({ i }, s)), lang).map((g) => `<h3 class="list-aisle">${esc(g.name)}</h3>
          <div class="list-chips">${g.rows.map((s) => `<button type="button" class="list-chip" data-again="${s.i}" data-key="again|${esc(s.name)}">${esc(shop.withOther(s))}</button>`).join('')}</div>`).join('')}
      </details>` : '';
    const toBuy = shop.groups(v.items || [], lang).map((g) => `<h3 class="list-aisle">${esc(g.name)}</h3>
        <div class="list-rows">${g.rows.map((r) => listRowHTML(r, 'buy', canAdd)).join('')}</div>`).join('');
    const bought = Array.isArray(v.bought) ? v.bought : [];
    body.innerHTML = `${again}
      <section class="list-sec" aria-label="${esc(t('shopping_list'))}">${toBuy || `<p class="empty-line list-empty">${esc(t('nothing_to_buy'))}</p>`}</section>
      ${bought.length ? `<section class="list-sec list-bought" aria-labelledby="list-bought">
        <h2 class="sec-head" id="list-bought">${esc(t('bought_today'))} (${bought.length})</h2>
        <div class="list-rows">${bought.map((r) => listRowHTML(r, 'bought', canAdd)).join('')}</div>
      </section>` : ''}`;
    if (focusKey) {
      const again2 = [...body.querySelectorAll('[data-key]')].find((e) => e.dataset.key === focusKey);
      if (again2) again2.focus();
    }
  }

  const markRow = (el, on) => { el.setAttribute('aria-checked', String(on)); patched = true; };
  const rowEl = (key) => [...root.querySelectorAll('.lrow[data-key]')].find((e) => e.dataset.key === key);

  // A tap on a row. To buy: ticked where it is, with the 15-minute Undo toast (a second tap before it
  // moves takes it back). Bought today: her own tick of the last 15 minutes is taken back at once;
  // an older one offers "Add it again?" when she can add, and does nothing otherwise.
  // A row not tapped since it was drawn goes with the seen it was shown with. One already changed here
  // (entry.tapped) goes by id, even when it is back as drawn: the outbox takes its seen from that
  // change's reply or the list as it is now. Every un-tick gives the line a new seen (§4.2), so the
  // one it was drawn with would be refused.
  function tapRow(el) {
    const entry = listRows[Number(el.dataset.i)];
    if (!entry || !outbox) return;
    hold.touch();
    const r = entry.row;
    const as = entry.tapped ? r.id : r;
    const on = el.getAttribute('aria-checked') === 'true';
    if (!on) {
      // Not ticked: a row to buy, or a bought one taken back a moment ago that hasn't moved yet (by id).
      if (!outbox.buy(entry.where === 'buy' ? as : r.id)) return;
      entry.tapped = true;
      markRow(el, true);
      tickToast = { id: r.id, el: toast(t('bought_toast', { title: r.name }), { ms: UNDO_MS, action: { label: t('undo'), onClick: () => undoTick(r.id, r.name) } }) };
      return;
    }
    if (entry.where === 'buy') {   // ticked a moment ago and still here: take it back
      if (tickToast && tickToast.id === r.id) tickToast.el.closeToast();
      if (outbox.unbuy(r.id)) { entry.tapped = true; markRow(el, false); } else notTakenBack(r.id);
      return;
    }
    if (r.undo) {
      if (outbox.unbuy(as)) { entry.tapped = true; markRow(el, false); toast(t('undone')); } else notTakenBack(r.id);
      return;
    }
    const v = outbox.view();
    if (v && v.can_add) {
      toast(shop.withOther(r), { ms: 8000, action: { label: t('add_again'), onClick: () => addToList(r.name) } });
    }
  }

  // A take-back the outbox didn't queue: the list is drawn as it is now. A line still bought says
  // "Cambiado en otro teléfono": her tick found it already bought by someone else, so it isn't hers to
  // undo (§8).
  function notTakenBack(id) {
    const v = outbox.view();
    if (v && (v.bought || []).some((x) => x.id === id)) toast(t('changed_elsewhere'));
    patched = true;
    hold.request();
  }

  // Deshacer on a tick's toast: the outbox takes the seen from the tick's reply (or, if the tick never
  // left the phone, the two cancel out); not when her tick found it already bought by someone else.
  // Back on her list is the line itself, or the add still waiting that brings it back ("¿Añadir otra
  // vez?"): drawn as a new row with no id yet once a read past the household's midnight has taken the
  // bought line out of the list. Anything else (a line someone else bought, or forgot) has changed.
  function undoTick(id, name) {
    tickToast = null;
    outbox.unbuy(id);
    const v = outbox.view();
    const back = (x) => x.id === id || (x.id == null && name != null && shop.nameKey(x.name) === shop.nameKey(shop.parse(name).name));
    if (v && (v.items || []).some(back)) {
      toast(t('undone'));
      // Unticked where it is drawn now: to buy if it hasn't moved yet, under Comprado hoy if it has.
      // Changed here: a tap on it now goes by id, never with the seen it was drawn with.
      ['buy', 'bought'].forEach((where) => {
        const el = rowEl(`${where}|${id}`);
        if (!el) return;
        const entry = listRows[Number(el.dataset.i)];
        if (entry) entry.tapped = true;
        markRow(el, false);
      });
    } else {
      toast(t('changed_elsewhere'));
    }
    hold.request();
  }

  function addToList(text) {
    if (!outbox.add(text)) { toast(t('type_item'), { error: true }); return false; }
    return true;
  }

  // The add box: Enter (or Añadir) adds; the box clears and keeps the focus for the next one.
  function submitAdd(form) {
    const input = form.querySelector('.list-input');
    if (!input.value.trim()) { input.focus(); return; }
    if (!addToList(input.value)) return;
    input.value = '';
    showSuggest('');
    input.focus();
  }

  // Up to 5 names she has bought lately (suggest) that match what she typed, in either language.
  function showSuggest(text) {
    const el = root.querySelector('.list-suggest');
    if (!el) return;
    const v = outbox && outbox.view();
    const p = shop.parse(text);
    sugRows = v && v.can_add && p.name ? shop.matches(v.suggest || [], p.name, 5) : [];
    sugNote = p.note;
    el.innerHTML = sugRows.map((s, i) => `<button type="button" class="list-sug" data-sug="${i}">${esc(shop.withOther(s))}</button>`).join('');
    el.hidden = !sugRows.length;
  }
  function pickSuggestion(i) {
    const s = sugRows[i];
    const input = root.querySelector('.list-input');
    if (!s || !addToList(sugNote ? `${s.name}: ${sugNote}` : s.name)) return;
    if (input) { input.value = ''; input.focus(); }
    showSuggest('');
  }

  // ‹ My day: the browser's Back when #list was opened from the day; otherwise the day, in place.
  function backToDay() {
    if (fromDay) { history.back(); return; }
    try { history.replaceState(null, '', dayHref); } catch (e) { /* the hash stays */ }
    if (state) render();
    else start();
  }

  // ============================================
  // HOMEWORK (v1.3, docs/v1.3-homework.md §7, §8, §9.6): Jordan's card and #homework, #focus, #points, #plan/<id>
  // The card comes from get_person_day's homework key (only for a kid with homework on; never on schema 4,
  // and never without plan.js). The views read homework_by_token(p_token) and redraw from every writer's
  // answer, which carries the same view: step_by_token, plan_by_token, focus_by_token, reward_by_token,
  // assignment_by_token, homework_prefs_by_token. A null answer: homework is off (the day, and a word) or the
  // link no longer works. The timer counts from the server's clock (plan.js timer(): the answer's ends_at less
  // its server_now, kept on performance.now()), never the phone's; the chime is scheduled on the audio clock
  // at Start (and set again when the ring and the audio clock drift apart, as after time away), and the
  // screen kept awake while a block's ring runs, on any view. Points are only ever what the server answered,
  // and the block is paid the moment its ring runs out (an End 'time', sent at once on any view; his answer
  // comes after): a small celebration then (the ★ counter ticks up, "+N", a short sound). While the ring runs,
  // #focus counts the points up from the server's start time (plan.js estimate(), never past what the end
  // pays), and the card, #homework, #focus and #points show the next-reward bar (plan.js goalBar()).
  // Instant rewards are cashed on #points (reward_by_token 'cash'); the rest are asked for.
  // Rows the page makes (a block, a smaller step, his own homework, an ask, a suggestion) take their id
  // from the page, so a resend finds them: a Start or an End with no answer is sent again with the same id.
  // From 0006 (schema 6), New from school: the view's from_school, the school's items he hasn't planned or hidden, as a
  // short list after Due soon with Quick (at his length, for one due within 3 days), Plan with Pat and Hide, through
  // school_item_by_token; the card's from_school count is a line that opens it. An assignment made from school says if
  // the school moved its date or took it off its site (its school marks).
  // ============================================
  const HW_VIEWS = new Set(['homework', 'focus', 'points', 'plan']);
  const LENGTH_KEY = 'homehub.myday.length';
  const SILENT_KEY = 'homehub.myday.chime-silent';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let hv = null;            // the last homework view (homework_by_token, or a writer's answer)
  let hvAt = 0;             // performance.now() when it came: the timer's anchor
  let hvDrawn = '';         // what #homework or #points shows, as JSON, so an unchanged read doesn't redraw
  let hvReading = null;     // the homework_by_token request in flight
  let hvLast = 0;
  let hwBusy = 0;           // homework writes in flight: no read redraws in the middle of one
  let hwPollTimer = null;   // the 60-second read while #homework is on screen
  let ringTimer = null;     // the ring's once-a-second redraw while #focus is on screen
  let breakTimer = null;
  let nowId = null;         // the step he tapped to make Now (else the view's now)
  let menuOpen = null;      // the step whose ⋯ is open
  let quickOpen = null;     // the assignment whose Quick minutes are showing
  let addOpen = false;      // the + Homework form
  let earlierOpen = false;  // From earlier unfolded
  let schoolMoreOpen = false;   // New from school's folded rest unfolded (0006)
  const schoolBusy = new Set(); // New from school: the items with a Quick, Plan with Pat or Hide on its way
  let schoolScroll = false;     // the card's "New from school" line was tapped: #homework opens at the list
  let sheet = null;         // { kind: 'stuck' | 'smaller' | 'ask' | 'cue' | 'ifstuck', step, text }
  let withPick = 'alone';
  let lengthPick = readLength();
  let fx = {};              // the block on #focus: { id, onTime, timeUp, afterDone, result, end (unanswered), breakTm }
  let pendingStart = null;  // a Start with no answer: { id, step, assignment }, sent again with the same id
  let audio = null;         // { ctx, session, at, nodes, loudTimer }: made inside a tap (Start, or after a reload any tap on #focus)
  let loud = false;         // "Chime even on silent": navigator.audioSession is 'playback' around the chime
  let wake = null;          // the screen wake lock while a block's ring runs, on any view
  let wakeAsk = null;       // a wake lock asked for and not answered yet (never two at once)
  let wakeTimer = null;     // lets go of the lock when the ring runs out, whatever is on screen
  let starting = false;     // a Start on its way: the lock taken in its tap waits for its answer
  let wakeOk = null;        // false: refused or missing (the tip shows)
  let notifyAsked = false;
  let ed = null;            // the plan editor on #plan/<id>
  let edFor = null;
  let dayAt = 0;            // performance.now() when get_person_day answered (the card's ends_in_s)
  let cheer = null;         // { from, to }: a balance that went up, to tick up on the next view that draws it
  let autoTimer = null;     // sends End 'time' when the ring runs out, whatever is on screen
  let dayTimer = null;      // the day view (no view read yet): reads his view when the card's block runs out
  let cashOpen = null;      // the instant reward whose "Yes, get it" is showing
  let cashArmed = false;    // its Yes takes a tap only a moment after it was drawn (never the second tap of a double tap)
  let cashArmTimer = null;
  const cashKeys = {};      // reward id → its cash-in's id, kept until an answer, or a read showing it landed (a tap again finds the row)
  const perfNow = () => (window.performance && performance.now ? performance.now() : Date.now());

  function readLength() {
    try { const n = Number(localStorage.getItem(LENGTH_KEY)); return [10, 15, 20, 25].includes(n) ? n : null; } catch (e) { return null; }
  }
  function readSilent() {
    try { return localStorage.getItem(SILENT_KEY) === '1'; } catch (e) { return false; }
  }

  // His words: day.js's hw_* keys (with "{tutor}" or, with no tutor link, the key's "_none" words), else plan.js's.
  const hwTutor = () => (hv && hv.me && hv.me.tutor) || null;
  function hw(key, vars) {
    const v = Object.assign({ tutor: hwTutor(), kid: hv && hv.me ? hv.me.first_name : '' }, vars);
    const pick = (k) => (WORDS[lang][k] != null ? WORDS[lang][k] : WORDS.en[k]);
    let raw = pick(key);
    if (raw == null) return plan ? plan.t(key, v, lang) : key;
    if (raw.includes('{tutor}') && v.tutor == null && pick(`${key}_none`) != null) raw = pick(`${key}_none`);
    let s = String(raw);
    // As plan.js's t(): a Spanish {day} comes with its article (fmt.rel's 'el mié'), so "a el"/"de el" become "al"/"del".
    if (lang === 'es') {
      s = s.replace(/(^|[^\p{L}])(de|a) \{(\w+)\}/gu, (m, pre, p, k) => (v[k] != null && /^el /.test(String(v[k]))
        ? `${pre}${p === 'de' ? 'del' : 'al'} ${String(v[k]).slice(3)}` : m));
    }
    return s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m));
  }
  const hwRel = (iso) => plan.fmt.rel(iso, hv ? hv.today : state && state.today, lang);
  // The database's homework messages in his words (plan.js), before anything else: "Only your own tick…" is
  // the shopping list's too, where it has its own words.
  const HW_MESSAGES = /That step isn't on your plan|Only your own tick|That's a checkpoint|Finish the block you started first|That block isn't yours|That's a lot for one day|No homework day before it's due has room|was changed since you opened it|Not enough points yet|Points are off|Choose 10, 15, 20 or 25|Plan this one with|Set a homework time first|That plan isn't on your list|is done or dropped|That's too long|That plan is too long|^At most 20 steps\.?$|Three asks are waiting already|Five suggestions are waiting already|Fifteen of your own are open already|That can't be saved|Those points are already spent|Ask a parent for that one|That's all the instant rewards for today|That reward's price changed/i;
  function hwFriendly(err) {
    const msg = String((err && (err.message || err.error_description)) || err || '');
    if (plan && HW_MESSAGES.test(msg)) return plan.friendly(err, lang, hwTutor());
    if (/That (assignment|reward) isn't on your list|That ask isn't yours/i.test(msg)) return hw('hw_not_yours');
    // 0006: New from school's refusals (school_item_by_token).
    if (/That isn't on your list from school/i.test(msg)) return hw('hw_school_not_yours');
    if (/That one is on your homework already/i.test(msg)) return hw('hw_school_already');
    return friendly(err);
  }

  // ---------- Reading and writing ----------
  function take(data) {
    if (!data || typeof data !== 'object' || !data.me) return false;
    hv = data;
    hvAt = perfNow();
    lang = data.language === 'es' ? 'es' : 'en';
    document.documentElement.lang = lang;
    // A block paid when its ring ran out, his answer still to come, after a reload (or a page the phone dropped):
    // its end screen again, from the view's answer_due (the End's own block and earned).
    const due = data.answer_due;
    if (!data.session && due && due.block && !fx.result && !fx.end) fx = { id: due.block.id, step: due.block.step_id, result: { block: due.block, earned: due.earned } };
    // A cash-in whose answer was lost shows on a read: it landed, and its key is done (no Yes left to tap twice).
    Object.keys(cashKeys).forEach((rid) => {
      if (!(data.asks || []).some((q) => q.id === cashKeys[rid])) return;
      delete cashKeys[rid];
      if (cashOpen === rid) cashOpen = null;
    });
    wakeFollow();
    autoFollow();
    return true;
  }
  // One homework_by_token at a time; resolves to the view, null (homework off, or the link gone) or throws.
  function readHomework() {
    if (!hvReading) {
      hvReading = rpc(one(() => sb.rpc('homework_by_token', { p_token: token })))
        .then((v) => { hvLast = Date.now(); return v && typeof v === 'object' ? v : null; })
        .finally(() => { hvReading = null; });
    }
    return hvReading;
  }
  async function hwRead() {
    let v;
    try {
      v = await readHomework();
    } catch (err) {
      if (!hv && HW_VIEWS.has(view)) showProblem(() => friendly(err), true);
      return;
    }
    if (!v) { hwNull(); return; }
    if (!take(v)) return;
    hwRedraw(false);
  }
  // Redraw the view on screen from hv (a running ring only takes the new anchor).
  function hwRedraw(force) {
    if (view === 'homework') renderHomework(force);
    else if (view === 'points') renderPoints(force);
    else if (view === 'focus') renderFocus();
    else if (view === 'plan' && !ed) renderPlan(planIdFromHash());
    else if (view === 'plan' && !ed.dirty()) { const a = editorAssignment(edFor); if (a) ed.set(a, editorOpts()); else renderHomeworkView('homework'); }
  }
  // homework_by_token (or a writer) answered null: homework was turned off a moment ago, or the link no
  // longer works. get_person_day says which.
  async function hwNull() {
    hv = null;
    wakeFollow();
    stopViews();
    root.innerHTML = `<p class="loading">${esc(t('loading'))}</p>`;
    view = 'loading';
    let day;
    try {
      day = await fetchDay();
    } catch (err) {
      showProblem(() => friendly(err), true);
      return;
    }
    if (!day) { linkGone(); return; }
    accept(day);
    try { history.replaceState(null, '', dayHref); } catch (e) { /* the hash stays; the day shows all the same */ }
    renderDay(true);
    if (!day.homework) toast(hw('hw_off'), { error: true });
  }
  // A homework write: the supabase-js answer, through one(). Answers { data } (its view taken), { gone }, or
  // { error, kind } ('refused' | 'retry' | 'not_yet'), after saying so (quiet: the caller says it).
  async function hwWrite(start, quiet) {
    hwBusy++;
    let res;
    try { res = await one(start); } catch (err) { res = { error: err }; } finally { hwBusy--; }
    const kind = plan.answer(res);
    if (kind === 'ok') { take(res.data); return { data: res.data }; }
    if (kind === 'gone' || kind === 'not_yet') { hwNull(); return { gone: true }; }
    if (!quiet) toast(kind === 'retry' ? t('offline') : hwFriendly(res.error), { error: true });
    if (!quiet && kind === 'refused' && /was changed since you opened it/i.test(String(res.error && res.error.message))) hwRead();
    return { error: res.error || { message: 'Failed to fetch' }, kind };
  }
  const stepCall = (step, action, o) => hwWrite(() => sb.rpc('step_by_token', {
    p_token: token, p_step: step, p_action: action, p_text: (o && o.text) || undefined, p_day: (o && o.day) || undefined, p_key: (o && o.key) || undefined,
  }));
  const focusCall = (action, o, quiet) => hwWrite(() => sb.rpc('focus_by_token', {
    p_token: token, p_action: action, p_session: o.session, p_minutes: o.minutes, p_step: o.step, p_assignment: o.assignment, p_with: o.with,
    p_result: o.result, p_note: o.note,
  }), quiet);
  const planCall = (assignment, steps, rev) => hwWrite(() => sb.rpc('plan_by_token', { p_token: token, p_assignment: assignment, p_steps: steps, p_rev: rev }));
  const rewardCall = (action, o) => hwWrite(() => sb.rpc('reward_by_token', {
    p_token: token, p_action: action, p_reward: o.reward, p_text: o.text, p_key: o.key, p_cost: o.cost,
  }));
  const asgCall = (action, o) => hwWrite(() => sb.rpc('assignment_by_token', {
    p_token: token, p_action: action, p_assignment: o.assignment, p_title: o.title, p_subject: o.subject, p_due_date: o.due, p_minutes: o.minutes,
  }));
  // 0006: an item of New from school ('quick' with his minutes, 'with_tutor', 'hide'); its answer is {assignment_id} and his view.
  const schoolCall = (action, item, minutes) => hwWrite(() => sb.rpc('school_item_by_token', {
    p_token: token, p_item: item, p_action: action, p_minutes: minutes,
  }));
  const prefsCall = (cue, ifStuck) => hwWrite(() => sb.rpc('homework_prefs_by_token', { p_token: token, p_cue: cue, p_if_stuck: ifStuck, p_minutes: null }));

  // ---------- The view's steps ----------
  const allSteps = () => {
    const out = [];
    ((hv && hv.assignments) || []).forEach((a) => (a.steps || []).forEach((s) => out.push(s)));
    return out;
  };
  const stepById = (id) => (hv && [].concat(hv.tonight || [], hv.earlier || []).find((s) => s.id === id)) || allSteps().find((s) => s.id === id) || null;
  const asgById = (id) => ((hv && hv.assignments) || []).find((a) => a.id === id) || null;
  const openSteps = () => [].concat((hv && hv.tonight) || [], (hv && hv.earlier) || []).filter((s) => !s.done);
  function nowStep() {
    const picked = nowId && openSteps().find((s) => s.id === nowId);
    return picked || (hv && hv.now) || null;
  }
  // The next open step after this one (Tonight, then From earlier), or the first other one.
  function nextStep(id) {
    const list = openSteps();
    const i = list.findIndex((s) => s.id === id);
    return (i >= 0 ? list.slice(i + 1).concat(list.slice(0, i)) : list).find((s) => s.id !== id) || null;
  }
  const isPlain = (s) => ['start', 'step', 'check'].includes(s.kind);
  const lengthOf = () => lengthPick || (hv && hv.me && hv.me.length) || (state && state.homework && state.homework.length) || 10;
  const balanceLine = (n) => `★ ${n}`;
  // A balance as drawn: the one a celebration ticks up from, until it plays (playCheer).
  const balanceHTML = (cls, n, href) => (href
    ? `<a class="${cls}" href="${href}" data-cheer>${esc(balanceLine(cheer ? cheer.from : n))}</a>`
    : `<span class="${cls}" data-cheer>${esc(balanceLine(cheer ? cheer.from : n))}</span>`);
  // The block ran out of time and was paid ('time'): his answer (how did it go?) is still to come.
  const timeAnswer = () => !!(fx.result && fx.result.block && fx.result.block.result === 'time');
  // A milestone note or an answer, as he reads it: "Pat: Clear outline…", "Not yet: …", "Answer: …".
  function whoOf(by) {
    if (by === 'tutor') return hwTutor() || hw('hw_from_tutor_none');
    return hw('hw_from_parents');
  }
  function notesHTML(s) {
    const out = [];
    if (s.question) out.push(`<p class="hw-q">${esc(hw('hw_you_asked', { text: s.question }))}</p>`);
    if (s.answer) out.push(`<p class="hw-note">${esc(plan.t('answer_line', { text: s.answer }, lang))}</p>`);
    if (s.coach && s.coach.text) {
      out.push(`<p class="hw-note">${esc(s.not_yet ? plan.t('not_yet', { note: s.coach.text }, lang) : plan.t('coach_note', { who: whoOf(s.coach.by), note: s.coach.text }, lang))}</p>`);
    }
    if (s.kind === 'milestone' && s.done && !s.checked && s.waiting) out.push(`<p class="hw-waiting">${esc(hw('waiting_check', { n: s.waiting }))}</p>`);
    return out.join('');
  }

  // ---------- The card (the day view, from get_person_day's homework key) ----------
  function cardHTML() {
    const c = state && state.homework;
    if (!c || !plan) return '';
    const head = [hw('homework')];
    if (c.window) head.push(plan.fmt.time(c.window.starts, lang));
    if (c.steps) head.push(c.steps === 1 ? hw('hw_one_step') : hw('hw_n_steps', { n: c.steps }), plan.fmt.duration(c.minutes));
    if (c.earlier) head.push(hw('hw_n_earlier', { n: c.earlier }));
    // The balance as balanceHTML draws it: a block paid while he is on the day celebrates here (playCheer).
    const pts = c.points != null ? balanceHTML('hw-card-points', c.points, '#points') : '';
    let acts;
    if (c.session || c.answer_due || timeAnswer()) {
      const left = c.session ? Math.ceil(((Number(c.session.ends_in_s) || 0) * 1000 - (perfNow() - dayAt)) / 60000) : 0;
      acts = `<a class="btn btn-primary hw-card-focus" href="#focus">${esc(left > 0 ? `${plan.t('focus_left', { n: left }, lang)} ›` : hw('hw_block_done'))}</a>`;
    } else {
      acts = c.next ? `<button type="button" class="btn btn-primary hw-start" data-act="hw-card-start">${esc(plan.t('start_n', { n: lengthPick || c.length }, lang))}</button>` : '';
    }
    const next = c.next ? hw('hw_next', { text: [c.next.assignment, c.next.title].filter(Boolean).join(' · ') }) : hw('hw_nothing');
    // 0006: how many are new from school; the line opens #homework at the list.
    const fromSchool = Number(c.from_school) > 0 ? Math.floor(Number(c.from_school)) : 0;
    return `<section class="hw-card" aria-labelledby="hw-card-h">
      <div class="hw-card-top"><h2 class="hw-card-head" id="hw-card-h">${esc(head.join(' · '))}</h2>${pts}</div>
      <p class="hw-card-next">${esc(next)}</p>
      ${fromSchool ? `<p class="hw-card-school-p"><a class="hw-card-school" href="#homework" data-act="hw-school-open">${esc(hw('hw_school_card', { n: fromSchool }))}</a></p>` : ''}
      ${c.goal ? plan.goalBar(c.goal, { lang }) : ''}
      <div class="hw-card-acts">${acts}<a class="btn hw-open" href="#homework">${esc(hw('hw_open'))}</a></div>
    </section>`;
  }
  // The day view with a block running and no view read yet (a reload on the day): when the card's ring runs
  // out, his view is read once, so the block is paid then (autoFollow sends its End 'time').
  function dayFollow() {
    clearTimeout(dayTimer);
    dayTimer = null;
    const c = state && state.homework;
    if (!plan || !c || !c.session || hv) return;
    const ms = (Number(c.session.ends_in_s) || 0) * 1000 - (perfNow() - dayAt);
    dayTimer = setTimeout(() => {
      dayTimer = null;
      if (view === 'day' && !hv) readHomework().then((v) => { if (v) take(v); }).catch(() => {});
    }, Math.max(0, ms) + 500);
  }

  // ---------- Starting a block: one tap, on the card, Now, a step or an assignment ----------
  // The wake lock and the AudioContext are asked for inside the tap (iOS needs one for sound). The lock
  // taken in the tap waits for the Start's answer: kept for a block that runs, let go of otherwise.
  function startBlock(o) {
    if (hv && hv.session) { location.hash = '#focus'; return; }
    if (navigator.onLine === false) { toast(plan.t('needs_signal', null, lang), { error: true }); return; }
    armAudio();
    starting = true;
    keepAwake();
    cheer = null;
    const same = pendingStart && pendingStart.step === (o.step || null) && pendingStart.assignment === (o.assignment || null);
    const id = same ? pendingStart.id : plan.newId();
    pendingStart = { id, step: o.step || null, assignment: o.assignment || null };
    const minutes = o.minutes || lengthOf();
    focusCall('start', { session: id, minutes, step: o.step || undefined, assignment: o.step ? undefined : o.assignment || undefined, with: o.with || 'alone' }, true)
      .then((r) => {
        starting = false;
        // A block that runs keeps the lock until its ring runs out; no answer, gone or refused: let go now
        // (a Start that did reach the server shows on the next read, and #focus asks again).
        wakeFollow();
        if (r.data) {
          pendingStart = null;
          fx = { id, onTime: !!(r.data.block && r.data.block.on_time) };
          scheduleChime();
          if (location.hash === '#focus') renderHomeworkView('focus');
          else location.hash = '#focus';
          return;
        }
        if (r.gone) return;
        if (r.kind === 'retry') { toast(plan.t('needs_signal', null, lang), { error: true }); return; }
        pendingStart = null;
        if (/Finish the block you started first/i.test(String(r.error && r.error.message))) {
          toast(hwFriendly(r.error), { error: true });
          readHomework().then((v) => { if (take(v)) location.hash = '#focus'; }).catch(() => {});
          return;
        }
        toast(hwFriendly(r.error), { error: true });
      });
  }
  // Made (or woken) inside a tap; once it runs, the chime is set on its clock again.
  function armAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audio) audio = { ctx: new AC(), session: null, at: null, nodes: [], loudTimer: null, endTimer: null };
      const p = audio.ctx.resume && audio.ctx.resume();
      if (p && p.then) p.then(() => scheduleChime(), () => {});
      else scheduleChime();
    } catch (e) { audio = null; }
  }
  // Two soft tones at the block's end, on the audio clock, so a hidden page's slow timers can't delay them.
  // Set at Start, and again whenever they no longer fall on the ring's end: iOS stops a hidden page's audio
  // clock, so after a while away the tones would come that much late. Never for a ring that has run out, nor
  // for a block he has ended (an End on its way).
  function scheduleChime() {
    const s = hv && hv.session;
    if (!audio || !s || fx.end || fx.result) return;
    try {
      const tm = plan.timer({ ends_at: s.ends_at, server_now: hv.server_now, started_at: s.started_at, minutes: s.minutes }, hvAt);
      const l = plan.left(tm, perfNow());
      if (l.done) return;
      const at = plan.audioAt(tm, perfNow(), audio.ctx.currentTime);
      if (audio.session === s.id && audio.at != null && Math.abs(at - audio.at) < 1) return;   // still on time
      cancelChime();
      [[660, 0], [880, 0.4]].forEach(([freq, delay]) => {
        const o = audio.ctx.createOscillator();
        const g = audio.ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, at + delay);
        g.gain.exponentialRampToValueAtTime(0.25, at + delay + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, at + delay + 0.6);
        o.connect(g);
        g.connect(audio.ctx.destination);
        o.start(at + delay);
        o.stop(at + delay + 0.7);
        audio.nodes.push(o);
      });
      audio.session = s.id;
      audio.at = at;
      // When the ring runs out, whatever is on screen: tones still more than a moment away are called off.
      audio.endTimer = setTimeout(lateChimeOff, l.ms + 100);
      // Chime even on silent (§7.2): 'playback' just for the chime, from a few seconds before it until its
      // last tone has stopped (or it is called off), never for the whole block (it may pause his music).
      if (readSilent() && navigator.audioSession) {
        const nodes = audio.nodes;
        audio.loudTimer = setTimeout(() => { if (audio && audio.nodes === nodes) loudChime(true); }, Math.max(0, l.ms - 3000));
        nodes[nodes.length - 1].onended = () => { if (audio && audio.nodes === nodes) loudChime(false); };
      }
    } catch (e) { /* the end is visual all the same */ }
  }
  function cancelChime() {
    if (!audio) return;
    clearTimeout(audio.loudTimer);
    audio.loudTimer = null;
    clearTimeout(audio.endTimer);
    audio.endTimer = null;
    audio.nodes.forEach((o) => { try { o.stop(0); } catch (e) { /* already stopped */ } });
    audio.nodes = [];
    audio.session = null;
    audio.at = null;
    loudChime(false);
  }
  // Tones still more than a moment away once the ring has run out (an audio clock that stood still while he
  // was away) are called off, so no chime comes long after the end, whatever is on screen.
  function lateChimeOff() {
    try { if (audio && audio.at != null && audio.at - audio.ctx.currentTime > 2) cancelChime(); } catch (e) { /* visual all the same */ }
  }
  // Coming back into view, on any view (a block runs on #homework and the day too): the Start tap unlocked the
  // audio, so wake it (iOS stops a hidden page's) and set the chime on its clock again; once the ring has run
  // out, call off what is still to come.
  function chimeAgain() {
    if (!audio || !hv || !hv.session || fx.end || fx.result) return;
    if (blockRunning()) armAudio(); else lateChimeOff();
  }
  function loudChime(on) {
    if (!navigator.audioSession || loud === on) return;
    try { navigator.audioSession.type = on ? 'playback' : 'auto'; loud = on; } catch (e) { /* as it was */ }
  }
  function keepAwake() {
    if (wake || wakeAsk) return;
    try {
      if (!navigator.wakeLock || !navigator.wakeLock.request) { wakeOk = false; return; }
      const ask = navigator.wakeLock.request('screen');
      wakeAsk = ask;
      ask.then((w) => {
        // Let go of while it was asked for (the block ended, or the Start got no block): give it back.
        if (wakeAsk !== ask || (!starting && !blockRunning())) {
          if (wakeAsk === ask) wakeAsk = null;
          if (w && w.release) w.release().catch(() => {});
          return;
        }
        wakeAsk = null;
        wake = w;
        wakeOk = true;
        // The browser lets go of it when the page is hidden: asked for again on coming back (keepAwakeAgain).
        if (w && w.addEventListener) w.addEventListener('release', () => { if (wake === w) wake = null; });
        wakeFollow();
      }, () => { if (wakeAsk === ask) wakeAsk = null; wakeOk = false; drawTip(); });
    } catch (e) { wakeAsk = null; wakeOk = false; }
  }
  function releaseWake() {
    const w = wake;
    wake = null;
    wakeAsk = null;   // one still on its way is given back when it comes
    clearTimeout(wakeTimer);
    wakeTimer = null;
    if (w && w.release) w.release().catch(() => {});
  }
  // A block's ring is running (by the server's clock).
  function blockRunning() {
    const tm = focusTimer();
    return !!tm && !plan.left(tm, perfNow()).done;
  }
  // The lock follows the view: kept while a block's ring runs, whatever is on screen (#homework, the day),
  // and let go of when it runs out (a timer), or when no block runs. A Start on its way keeps the tap's.
  function wakeFollow() {
    clearTimeout(wakeTimer);
    wakeTimer = null;
    if (starting || (!wake && !wakeAsk)) return;
    const tm = focusTimer();
    const l = tm ? plan.left(tm, perfNow()) : null;
    if (!l || l.done) { releaseWake(); return; }
    wakeTimer = setTimeout(wakeFollow, l.ms + 100);
  }
  const drawTip = () => { const el = root.querySelector('.hw-tip'); if (el) el.hidden = wakeOk !== false; };

  // ---------- Tonight, From earlier, Due soon (#homework) ----------
  // The heading: #homework goes back to the day (in place of this address, so Back doesn't return here), the
  // rest back to #homework.
  function homeworkHead(kind) {
    const pts = kind === 'homework' && hv.points ? balanceHTML('hw-points', hv.points.balance, '#points') : '';
    const link = kind === 'homework'
      ? `<a class="list-back" href="${esc(dayHref)}" data-act="hw-day">${esc(t('back_to_day'))}</a>`
      : `<a class="list-back" href="#homework">${esc(hw('hw_back_home'))}</a>`;
    const title = kind === 'homework' ? `<div class="hw-head-row"><h1>${esc(hw('homework'))}</h1>${pts}</div>`
      : kind === 'points' ? `<h1>${esc(hw('hw_points'))}</h1>` : '';
    // The next-reward bar, under the heading of #homework and #points.
    const goal = kind !== 'focus' && hv.points ? plan.goalBar(hv.goal, { lang }) : '';
    return `<header class="day-head hw-head">${link}${title}${goal}</header>`;
  }
  function stepRowHTML(s, where) {
    const i = Number(s.minutes) || 0;
    const title = [s.assignment, s.title].filter(Boolean).join(' · ');
    const checked = !!s.done;
    const now = nowStep();
    const plain = isPlain(s);
    const menu = menuOpen === s.id && !s.done ? `<div class="hw-menu" role="group" aria-label="${esc(plan.t('more_for', { title: s.title }, lang))}">
        <button type="button" class="btn btn-sm" data-act="hw-done" data-step="${esc(s.id)}">${esc(hw('hw_done_btn'))}</button>
        ${plain ? `<button type="button" class="btn btn-sm" data-act="hw-not-today" data-step="${esc(s.id)}">${esc(plan.t('not_today', null, lang))}</button>` : ''}
        <button type="button" class="btn btn-sm" data-act="hw-smaller" data-step="${esc(s.id)}">${esc(plan.t('make_smaller', null, lang))}</button>
        <button type="button" class="btn btn-sm" data-act="hw-ask" data-step="${esc(s.id)}">${esc(hw('ask_tutor'))}</button>
        <button type="button" class="btn btn-sm" data-act="hw-edit" data-asg="${esc(s.assignment_id)}">${esc(hw('hw_edit'))}</button>
      </div>` : '';
    const extra = where === 'earlier' ? `<div class="hw-step-acts">
        <button type="button" class="btn btn-sm" data-act="hw-start-step" data-step="${esc(s.id)}">${esc(plan.t('start_n', { n: lengthOf() }, lang))}</button>
        ${plain ? `<button type="button" class="btn btn-sm" data-act="hw-not-today" data-step="${esc(s.id)}">${esc(plan.t('not_today', null, lang))}</button>` : ''}
      </div>` : '';
    const sub = where === 'earlier' && s.from_day ? `<span class="hw-step-from">${esc(plan.t('from_day', { day: hwRel(s.from_day) }, lang))}</span>` : '';
    return `<div class="hw-step k-${esc(s.kind)}${checked ? ' is-done' : ''}${now && now.id === s.id ? ' is-now' : ''}" data-step="${esc(s.id)}">
      <div class="hw-step-row">
        <button type="button" class="irow-check day-check hw-box" role="checkbox" aria-checked="${checked}"${checked ? ' disabled' : ''} aria-label="${esc(t('done_label', { title: s.title }))}"><span class="irow-box">${ICON.check}</span></button>
        <button type="button" class="hw-step-main" data-act="hw-now" data-step="${esc(s.id)}"><span class="hw-step-title">${esc(title)}</span> <span class="hw-step-min">${esc(i)}</span>${sub ? ` ${sub}` : ''}</button>
        ${s.done ? '' : `<button type="button" class="hw-more" data-act="hw-more" data-step="${esc(s.id)}" aria-expanded="${menuOpen === s.id}" aria-label="${esc(plan.t('more_for', { title: s.title }, lang))}">${ICON.dots}</button>`}
      </div>
      ${notesHTML(s)}${menu}${extra}
    </div>`;
  }
  // An assignment with no plan, due within 3 days: Quick (his guess of the minutes) or a block on it.
  const quickDue = (a) => plan.daysBetween(hv.today, a.due_date) <= 3;
  function noPlanHTML(a) {
    const title = [a.subject, a.title, plan.t(a.kind === 'lesson' ? 'do_by' : 'due_on', { day: hwRel(a.due_date) }, lang)].filter(Boolean).join(' · ');
    const chips = quickOpen === a.id ? `<div class="hw-quick-chips"><span>${esc(hw('hw_quick_q'))}</span>
        ${[10, 15, 20, 30, 45].map((m) => `<button type="button" class="list-chip" data-quick="${m}" data-asg="${esc(a.id)}">${m}</button>`).join('')}</div>` : '';
    return `<div class="hw-noplan" data-asg="${esc(a.id)}">
      <span class="hw-noplan-title">${esc(title)}</span>
      <span class="hw-noplan-acts"><button type="button" class="btn btn-sm" data-act="hw-quick" data-asg="${esc(a.id)}" aria-expanded="${quickOpen === a.id}">${esc(plan.t('quick', null, lang))}</button>
      <button type="button" class="btn btn-sm" data-act="hw-asg-start" data-asg="${esc(a.id)}">${esc(hw('hw_start'))}</button></span>
      ${chips}
    </div>`;
  }
  function addFormHTML() {
    const max = plan.addDays(hv.today, 60);
    return `<form class="form hw-add-form" novalidate autocomplete="off">
      <label class="field"><span>${esc(hw('hw_add_title'))}</span><input type="text" name="title" maxlength="120" enterkeyhint="next"></label>
      <label class="field"><span>${esc(hw('hw_add_subject'))}</span><input type="text" name="subject" maxlength="40" enterkeyhint="next"></label>
      <div class="field-row"><label class="field"><span>${esc(hw('hw_add_due'))}</span><input type="date" name="due" min="${esc(hv.today)}" max="${esc(max)}"></label>
      <label class="field"><span>${esc(hw('hw_quick_q'))}</span><input type="number" name="minutes" min="5" max="60" step="5" inputmode="numeric" value="15"></label></div>
      <p class="form-error" hidden></p>
      <div class="form-actions"><button type="button" class="btn" data-act="hw-add-cancel">${esc(hw('hw_cancel'))}</button><button type="submit" class="btn btn-primary">${esc(hw('hw_add_btn'))}</button></div>
    </form>`;
  }
  // The milestone a plan can't reach any more (behind.milestone), as his screen says it: a line that opens Ask Pat.
  function talkHTML(a, m) {
    const ms = (a.steps || []).find((s) => s.kind === 'milestone' && s.title === m.title && s.day === m.day);
    const day = lang === 'es' ? `el ${plan.fmt.day(m.day, lang)}` : plan.fmt.day(m.day, lang);
    const line = hw('pick_new_day', { title: m.title, day });
    return `<p class="hw-talk"><button type="button" class="hw-link" data-act="hw-talk" data-step="${esc(ms ? ms.id : '')}" data-text="${esc(line)}">${esc(`${line.replace(/\.$/, '')} ›`)}</button></p>`;
  }
  function dueRowHTML(a) {
    const bits = [a.subject, a.title];
    if (a.kind === 'lesson') bits.push(plan.t('lesson_tag', null, lang));
    bits.push(plan.t(a.kind === 'lesson' ? 'do_by' : 'due_on', { day: hwRel(a.due_date) }, lang));
    const passed = a.behind && a.behind.milestone;
    if (a.status === 'open' && a.state === 'given' && a.next_milestone && !(passed && passed.title === a.next_milestone.title && passed.day === a.next_milestone.day)) {
      bits.push(`◆ ${a.next_milestone.title} ${hwRel(a.next_milestone.day)}`);
    }
    // 0006: an assignment made from school says when the school moved its date, or took it off its site.
    if (a.school && a.status === 'open') {
      if (a.school.gone) bits.push(hw('hw_school_gone'));
      else if (a.school.moved_to) bits.push(hw('hw_school_moved', { day: hwRel(a.school.moved_to) }));
    }
    let tail = '';
    if (a.status !== 'open') bits.push(plan.t(a.status === 'done' ? 'st_done' : 'st_dropped', null, lang));
    else if (a.state === 'planning') bits.push(hw('hw_being_planned'));
    else if (a.state === 'none') bits.push(plan.t('no_plan', null, lang), hw('plan_with_tutor'));
    if (a.status === 'open' && a.behind) {
      tail = ` · ${esc(plan.t('behind', null, lang))} · <button type="button" class="hw-link" data-act="hw-replan" data-asg="${esc(a.id)}">${esc(`${plan.t('replan', null, lang)} ›`)}</button>`;
    }
    const given = a.status === 'open' && a.state === 'given';
    if (given && a.ai_help === true) bits.push(hw(a.given_by === 'tutor' ? 'hw_ai_help' : 'hw_ai_help_family'));
    const notes = given ? (a.steps || []).filter((s) => s.kind === 'milestone' && s.coach && s.coach.text)
      .map((s) => `<p class="hw-note">${esc(s.not_yet ? plan.t('not_yet', { note: s.coach.text }, lang) : plan.t('coach_note', { who: whoOf(s.coach.by), note: s.coach.text }, lang))}</p>`).join('') : '';
    return `<div class="hw-asg${a.status !== 'open' ? ' is-closed' : ''}" data-asg="${esc(a.id)}">
      <p class="hw-asg-line">${esc(bits.filter(Boolean).join(' · '))}${tail}</p>
      ${passed && given ? talkHTML(a, passed) : ''}
      ${given ? plan.bars(a.minutes_left, a.time_left, { lang, horizon: a.horizon, no_time: a.no_time }) : ''}
      ${notes}
      ${a.stretch && a.status === 'open' ? `<p class="hw-stretch">${esc(hw('hw_stretch', { text: a.stretch }))}</p>` : ''}
    </div>`;
  }
  // New from school (0006, §11.4): his view's from_school ([{id, title, subject, due_date, quick}], id the school item's),
  // after Due soon. A short list (five, the rest folded), each in one tap: Quick (only for one due within 3 days, quick:
  // true: one step of his length, placed by the database on the first homework day with room, given at once), Plan with
  // Pat (an assignment from school with no plan yet: it shows under Due soon and on Pat's link) or Hide (off his list; a
  // parent can show it again). Once made an assignment, an item is no longer in from_school.
  const SCHOOL_SHOWN = 5;
  const schoolList = () => (hv && Array.isArray(hv.from_school) ? hv.from_school.filter((x) => x && typeof x.id === 'string') : []);
  const schoolItem = (id) => schoolList().find((x) => x.id === id) || null;
  const schoolMinutes = () => Math.min(60, Math.max(5, Number(lengthOf()) || 20));
  function schoolRowHTML(x) {
    const line = [x.subject, x.title, plan.t('due_on', { day: hwRel(x.due_date) }, lang)].filter(Boolean).join(' · ');
    const off = schoolBusy.has(x.id) ? ' disabled' : '';
    const b = (act, label, cls) => `<button type="button" class="btn${cls ? ` ${cls}` : ''}" data-act="${act}" data-item="${esc(x.id)}"${off}>${esc(label)}</button>`;
    return `<div class="hw-school-item" data-item="${esc(x.id)}">
      <p class="hw-school-line">${esc(line)}</p>
      <p class="hw-school-acts">${x.quick === true ? b('hw-school-quick', hw('hw_school_quick', { n: schoolMinutes() }), 'btn-primary') : ''}${b('hw-school-pat', hw('hw_school_pat'), x.quick === true ? '' : 'btn-primary')}${b('hw-school-hide', hw('hw_school_hide'))}</p>
    </div>`;
  }
  function schoolHTML(list) {
    if (!list.length) return '';
    const more = list.slice(SCHOOL_SHOWN);
    return `<section class="hw-school day-sec" aria-labelledby="hw-school-h"><h2 class="sec-head" id="hw-school-h">${esc(hw('hw_school', { n: list.length }))}</h2>
      <div class="hw-list">${list.slice(0, SCHOOL_SHOWN).map(schoolRowHTML).join('')}${more.length ? `<details class="hw-school-more"${schoolMoreOpen ? ' open' : ''}>
        <summary>${esc(hw('hw_school_more', { n: more.length }))}</summary>${more.map(schoolRowHTML).join('')}</details>` : ''}</div></section>`;
  }
  function nowHTML() {
    const s = nowStep();
    const w = hv.window;
    let head = hw('now');
    if (w) head = hw('hw_now_line', { from: plan.fmt.time(w.starts, lang), to: plan.fmt.time(w.ends, lang) });
    const onTime = plan.onTimeLine(hv.on_time, lang);
    if (w && onTime) head += ` · ${onTime}`;
    let card;
    if (!s) {
      card = `<p class="empty-line">${esc(hw('hw_nothing'))}</p>`;
    } else {
      const a = asgById(s.assignment_id);
      const list = (a && a.steps) || [];
      const n = list.findIndex((x) => x.id === s.id) + 1;
      const me = hv.me || {};
      const cue = me.cue
        ? `<p class="hw-cue">${esc(`“${me.cue}”`)} <button type="button" class="hw-edit" data-act="hw-cue" aria-label="${esc(hw('hw_cue_edit'))}" title="${esc(hw('hw_cue_edit'))}">✎</button></p>`
        : `<p class="hw-cue"><button type="button" class="hw-link" data-act="hw-cue">${esc(hw('hw_cue_add'))}</button></p>`;
      const len = lengthOf();
      const withs = [['alone', hw('hw_alone')]].concat(hwTutor() ? [['tutor', hw('hw_with_tutor')]] : [], [['parent', hw('hw_with_parent')]]);
      if (!withs.some(([v]) => v === withPick)) withPick = 'alone';
      card = `<div class="hw-now-card" data-step="${esc(s.id)}">
        <p class="hw-now-title">${esc(s.title)}</p>
        <p class="hw-now-sub">${esc(hw('hw_step_of', { assignment: s.assignment, n: n || 1, m: list.length || 1, min: s.minutes }))}</p>
        ${s.done_looks_like ? `<p class="hw-now-dll">${esc(plan.t('dll_line', { text: s.done_looks_like }, lang))}</p>` : ''}
        ${notesHTML(s)}
        ${cue}
        <div class="hw-now-opts">
          <div class="hw-lengths" role="radiogroup" aria-label="${esc(hw('hw_length'))}">${((me.lengths && me.lengths.length) ? me.lengths : [10, 15, 20, 25]).map((m) => `<button type="button" class="hw-len" role="radio" data-len="${m}" aria-checked="${m === len}">${m}</button>`).join('')}</div>
          <label class="hw-with"><span class="sr-only">${esc(hw('hw_with'))}</span><select name="with">${withs.map(([v, l]) => `<option value="${v}"${v === withPick ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        </div>
        <button type="button" class="btn btn-primary day-big hw-start" data-act="hw-start" data-step="${esc(s.id)}">${esc(plan.t('start_n', { n: len }, lang))}</button>
      </div>`;
    }
    return `<section class="hw-now day-sec" aria-labelledby="hw-now-h"><h2 class="sec-head" id="hw-now-h">${esc(head)}</h2>${card}</section>`;
  }
  function blockBanner() {
    const s = hv.session;
    if (!s && timeAnswer()) return `<p class="hw-block"><a class="btn btn-primary day-big" href="#focus">${esc(hw('hw_block_done'))}</a></p>`;
    if (!s) return '';
    const tm = plan.timer({ ends_at: s.ends_at, server_now: hv.server_now, started_at: s.started_at, minutes: s.minutes }, hvAt);
    const left = plan.left(tm, perfNow());
    const text = left.done ? hw('block_ended', { n: s.minutes, time: plan.fmt.time(localTime(s.ends_at), lang) }) : `${plan.t('focus_left', { n: left.minutes }, lang)} ›`;
    return `<p class="hw-block"><a class="btn btn-primary day-big" href="#focus">${esc(text)}</a></p>`;
  }
  // A timestamp's wall-clock time in the household ('HH:MM'), from the view's as_of and server_now.
  function localTime(ts) {
    const at = plan.ms(ts);
    const here = plan.ms(`${String(hv.as_of || '').slice(0, 16)}Z`);
    const now = plan.ms(hv.server_now);
    if (![at, here, now].every(Number.isFinite)) return '';
    return new Date(at + Math.round((here - now) / 900000) * 900000).toISOString().slice(11, 16);
  }
  function renderHomework(force) {
    if (!hv) { hwFrame('homework'); return; }
    const key = JSON.stringify([Object.assign({}, hv, { as_of: null, server_now: null }), nowId, menuOpen, quickOpen, addOpen, earlierOpen, lengthPick, withPick, lang, notifyAsked,
      schoolMoreOpen, [...schoolBusy], timeAnswer(), !!cheer]);
    if (!force && key === hvDrawn && root.querySelector('.hw-tonight')) return;
    if (!force && (addOpen || sheet) && root.querySelector('.hw-tonight')) return;   // never under his fingers
    hvDrawn = key;
    document.title = `${hw('homework')} · ${t('my_day')}`;
    const tonight = hv.tonight || [];
    const earlier = hv.earlier || [];
    const school = schoolList();
    const open = (hv.assignments || []).filter((a) => a.status === 'open');
    const quick = open.filter((a) => a.state === 'none' && quickDue(a));
    const due = (hv.assignments || []).filter((a) => !quick.includes(a));
    const tonightHead = hv.window ? hw('hw_tonight_line', { p: hv.load ? hv.load.planned : 0, f: hv.load ? hv.load.free : 0 }) : hw('tonight');
    const earlierMin = earlier.reduce((n, s) => n + (Number(s.minutes) || 0), 0);
    const earlierHTML = earlier.length ? `<details class="hw-earlier"${earlierOpen ? ' open' : ''}>
        <summary>${esc(`${plan.t('from_earlier', { n: earlier.length, m: earlierMin }, lang)} · ${plan.t('replan', null, lang)} ›`)}</summary>
        <div class="hw-steps">${earlier.map((s) => stepRowHTML(s, 'earlier')).join('')}</div>
        <p class="hw-earlier-acts"><button type="button" class="btn" data-act="hw-replan-earlier">${esc(plan.t('replan', null, lang))}</button></p>
      </details>` : '';
    const paceBits = [hv.pace ? plan.pace(hv.pace.ratio, lang) : '', plan.focused(hv.week, lang)].filter(Boolean);
    const notify = !phoneKind() && !notifyAsked && typeof window.Notification === 'function' && window.Notification.permission === 'default'
      ? `<p class="hw-opt"><button type="button" class="btn btn-sm" data-act="hw-notify">${esc(hw('hw_notify'))}</button></p>` : '';
    const silent = navigator.audioSession ? `<p class="hw-opt"><label class="hw-check"><input type="checkbox" name="silent"${readSilent() ? ' checked' : ''}> ${esc(plan.t('chime_silent', null, lang))}</label></p>` : '';
    root.innerHTML = `${homeworkHead('homework')}
      ${blockBanner()}
      ${nowHTML()}
      <section class="hw-tonight day-sec" aria-labelledby="hw-tonight-h">
        <h2 class="sec-head" id="hw-tonight-h">${esc(tonightHead)}</h2>
        <div class="hw-list">
          <div class="hw-steps">${tonight.map((s) => stepRowHTML(s, 'tonight')).join('')}</div>
          ${quick.map(noPlanHTML).join('')}
          ${!tonight.length && !quick.length ? `<p class="empty-line">${esc(hw('hw_nothing'))}</p>` : ''}
          ${earlierHTML}
          ${addOpen ? addFormHTML() : `<p class="hw-add"><button type="button" class="btn" data-act="hw-add">${esc(plan.t('add_homework', null, lang))}</button></p>`}
        </div>
      </section>
      ${due.length ? `<section class="hw-due day-sec" aria-labelledby="hw-due-h"><h2 class="sec-head" id="hw-due-h">${esc(plan.t('due_soon', null, lang))}</h2>
        <div class="hw-list">${due.map(dueRowHTML).join('')}</div></section>` : ''}
      ${schoolHTML(school)}
      ${paceBits.length ? `<p class="hw-pace">${esc(paceBits.join(' · '))}</p>` : ''}
      <p class="hw-who">${esc(hw('who_sees'))}</p>
      ${notify}${silent}
      ${footerHTML()}`;
    drawSheet();
    startPoll();
    if (schoolScroll) {
      schoolScroll = false;
      const sec = root.querySelector('.hw-school');
      if (sec) sec.scrollIntoView({ block: 'start' });
    }
    playCheer();
  }
  function startPoll() {
    if (hwPollTimer) return;
    hwPollTimer = setInterval(() => {
      if (view !== 'homework' || document.visibilityState === 'hidden' || hwBusy || addOpen || sheet) return;
      hwRead();
    }, 60 * 1000);
  }
  // A view's frame while its first read is on its way.
  function hwFrame(kind) {
    root.innerHTML = `<header class="day-head hw-head"><a class="list-back" href="${esc(kind === 'homework' ? dayHref : '#homework')}"${kind === 'homework' ? ' data-act="hw-day"' : ''}>${esc(kind === 'homework' ? t('back_to_day') : hw('hw_back_home'))}</a></header>
      <p class="loading">${esc(t('loading'))}</p>`;
    hwRead();
  }

  // ---------- #points ----------
  function renderPoints(force) {
    if (!hv) { hwFrame('points'); return; }
    if (!hv.points) { try { history.replaceState(null, '', '#homework'); } catch (e) { /* drawn all the same */ } renderHomeworkView('homework'); return; }
    const key = JSON.stringify(['points', hv.points, hv.rewards, hv.asks, hv.recent, hv.goal, lang, cashOpen, !!cheer]);
    if (!force && key === hvDrawn && root.querySelector('.hw-balance-big')) return;
    if (!force && root.querySelector('.hw-suggest-form input') && root.querySelector('.hw-suggest-form input').value) return;
    hvDrawn = key;
    document.title = `${hw('hw_points')} · ${t('my_day')}`;
    const p = hv.points;
    const free = p.balance - p.held;
    const waiting = (hv.asks || []).filter((q) => q.status === 'waiting');
    const decided = (hv.asks || []).filter((q) => q.status === 'approved' || q.status === 'declined' || q.status === 'cashed');
    const asked = new Set(waiting.map((q) => q.reward_id));
    const kindWord = { focus: 'hw_k_focus', on_time: 'hw_k_on_time', milestone_done: 'hw_k_milestone_done', milestone: 'hw_k_milestone', given: 'hw_k_given',
      void: 'hw_k_void', trade: 'hw_k_trade' };
    const signed = (n) => (n < 0 ? `−${-n}` : `+${n}`);
    // An instant reward he can cash: "Get it now", then "Yes, get it · −15" (one more tap, so a slip can't spend
    // his points; drawn where "Get it now" was, it takes a tap only a moment later, so the second tap of a double
    // tap lands on nothing); past today's instant rewards, it can still be asked for.
    const rewardAct = (r) => {
      if (r.instant && r.can_cash) {
        return cashOpen === r.id
          ? `<button type="button" class="btn btn-sm btn-primary" data-act="hw-cash-yes" data-reward="${esc(r.id)}"${cashArmed ? '' : ' disabled'}>${esc(hw('hw_cash_sure', { n: r.cost }))}</button>
            <button type="button" class="btn btn-sm" data-act="hw-cash-no">${esc(hw('hw_cancel'))}</button>`
          : `<button type="button" class="btn btn-sm btn-primary" data-act="hw-cash" data-reward="${esc(r.id)}">${esc(hw('hw_cash_btn'))}</button>`;
      }
      if (r.can_ask) return `<button type="button" class="btn btn-sm" data-act="hw-ask-reward" data-reward="${esc(r.id)}">${esc(hw('hw_ask_btn'))}</button>`;
      if (asked.has(r.id)) return `<span class="hw-more-needed">${esc(hw('hw_asked'))}</span>`;
      return r.cost > free ? `<span class="hw-more-needed">${esc(hw('hw_n_more', { n: r.cost - free }))}</span>` : '';
    };
    const cashNone = (hv.rewards || []).some((r) => r.instant) && p.cash_left === 0;
    const status = (q) => (q.status === 'approved' ? hw('hw_yes') : q.status === 'cashed' ? hw('hw_got') : q.note ? hw('hw_not_now_note', { note: q.note }) : hw('hw_not_now'));
    root.innerHTML = `${homeworkHead('points')}
      <p class="hw-balance-big">${balanceHTML('hw-balance-num', p.balance)}</p>
      <p class="hw-today">${esc(hw('hw_today_plus', { n: p.today }))}${p.capped ? ` · ${esc(plan.t('limit_reached', null, lang))}` : ''}</p>
      ${waiting.length ? `<section class="hw-asks day-sec" aria-labelledby="hw-asks-h"><h2 class="sec-head" id="hw-asks-h">${esc(plan.t('waiting_parent', null, lang))}</h2>
        <div class="hw-list">${waiting.map((q) => `<div class="hw-ask" data-ask="${esc(q.id)}"><span>${esc(`${q.title} · ${q.cost}`)}</span>
          <button type="button" class="btn btn-sm" data-act="hw-cancel-ask" data-ask="${esc(q.id)}">${esc(hw('hw_cancel'))}</button></div>`).join('')}
          <p class="hw-free">${esc(hw('hw_free', { n: free }))}</p><p class="hw-tell">${esc(plan.t('tell_parent', null, lang))}</p></div></section>` : ''}
      <section class="hw-rewards day-sec" aria-labelledby="hw-rewards-h"><h2 class="sec-head" id="hw-rewards-h">${esc(hw('hw_rewards'))}</h2>
        <div class="hw-list">${(hv.rewards || []).length ? hv.rewards.map((r) => `<div class="hw-reward${r.instant ? ' is-instant' : ''}" data-reward="${esc(r.id)}"><span class="hw-reward-t">${esc(`${r.title} · ${r.cost}${r.instant ? ` · ${hw('hw_instant')}` : ''}`)}</span> ${rewardAct(r)}</div>`).join('')
          : `<p class="empty-line">${esc(hw('hw_no_rewards'))}</p>`}
          ${cashNone ? `<p class="hw-cash-none">${esc(hw('hw_cash_none'))}</p>` : ''}</div></section>
      ${decided.length ? `<section class="hw-decided day-sec" aria-labelledby="hw-decided-h"><h2 class="sec-head" id="hw-decided-h">${esc(hw('hw_decided'))}</h2>
        <ul class="hw-lines">${decided.map((q) => `<li>${esc(`${q.title} · ${q.cost} · ${status(q)}`)}</li>`).join('')}</ul></section>` : ''}
      <section class="hw-suggest day-sec" aria-labelledby="hw-suggest-h"><h2 class="sec-head" id="hw-suggest-h">${esc(plan.t('suggest_reward', null, lang))}</h2>
        <form class="hw-inline hw-suggest-form" novalidate autocomplete="off"><input type="text" name="text" maxlength="60" aria-label="${esc(plan.t('suggest_reward', null, lang))}">
        <button type="submit" class="btn btn-primary">${esc(hw('hw_suggest_btn'))}</button></form>
        <p class="hw-suggest-hint">${esc(hw('hw_suggest_hint'))}</p></section>
      ${(hv.recent || []).length ? `<section class="hw-recent day-sec" aria-labelledby="hw-recent-h"><h2 class="sec-head" id="hw-recent-h">${esc(hw('hw_recent'))}</h2>
        <ul class="hw-lines">${hv.recent.map((l) => `<li>${esc([`${signed(l.delta)} ${hw(kindWord[l.kind] || 'hw_k_given')}`, l.note, hwRel(l.day)].filter(Boolean).join(' · '))}</li>`).join('')}</ul></section>` : ''}
      ${footerHTML()}`;
    playCheer();
  }

  // ---------- #focus: the ring, the stuck sheet, the end screen, the break ----------
  function focusTimer() {
    const s = hv && hv.session;
    return s ? plan.timer({ ends_at: s.ends_at, server_now: hv.server_now, started_at: s.started_at, minutes: s.minutes }, hvAt) : null;
  }
  // Seconds since the block started, by the server's clock.
  function elapsed(s) {
    const start = plan.ms(s.started_at);
    const now = plan.ms(hv.server_now);
    return Number.isFinite(start) && Number.isFinite(now) ? (now - start + (perfNow() - hvAt)) / 1000 : Infinity;
  }
  function renderFocus() {
    if (!hv) { hwFrame('focus'); return; }
    const s = hv.session;
    if (s && fx.id !== s.id) fx = { id: s.id };
    if (!s && !fx.result && !fx.end) { try { history.replaceState(null, '', '#homework'); } catch (e) { /* drawn all the same */ } renderHomeworkView('homework'); return; }
    document.title = `${hw('homework')} · ${t('my_day')}`;
    const tm = focusTimer();
    const left = tm ? plan.left(tm, perfNow()) : { done: true, fraction: 0, minutes: 0 };
    if (s && left.done && !fx.timeUp) { fx.timeUp = true; timeUp(); }
    const step = s ? stepById(s.step_id) : stepById(fx.step);
    const a = s ? asgById(s.assignment_id) : null;
    const title = (step && step.title) || (s && s.title) || (a && a.title) || '';
    const sub = step ? step.assignment : (a && a.subject) || '';
    const ended = !s || fx.result || fx.end;
    let body;
    if (ended || left.done) body = endHTML(s);
    else if (fx.afterDone) {
      const next = nextStep(s.step_id);
      body = `<div class="hw-after-done">${next ? `<button type="button" class="btn btn-primary day-big" data-act="hw-keep" data-step="${esc(next.id)}">${esc(plan.t('keep_going', { title: next.title }, lang))}</button>` : ''}
        <button type="button" class="btn day-big" data-act="hw-end-block">${esc(plan.t('end_block', null, lang))}</button></div>`;
    } else {
      body = `<div class="hw-focus-acts"><button type="button" class="btn day-big" data-act="hw-stuck">${esc(plan.t('stuck', null, lang))}</button>
        <button type="button" class="btn btn-primary day-big" data-act="hw-done-step">${esc(hw('hw_done_btn'))}</button>
        <button type="button" class="btn day-big" data-act="hw-stop">${esc(hw('hw_stop'))}</button></div>`;
    }
    const me = hv.me || {};
    const typed = root.querySelector('.hw-end input[name="note"]');
    const note = typed ? typed.value : '';
    const showCue = s && !ended && me.cue && elapsed(s) < 60;
    const running = !!s && !ended && !left.done;
    const onTime = running && (fx.onTime || s.on_time) && hv.points ? plan.t('on_time', { n: (s.earn && s.earn.on_time) || (hv.on_time && hv.on_time.points) || 10 }, lang) : '';
    // The points ticking up while the block runs: an estimate from the server's start time, a point a minute,
    // never past what the end pays; the next-reward bar moves with it.
    const est = running && s.earn && hv.points ? plan.estimate(s.earn, elapsed(s), s.minutes) : null;
    fx.est = est;
    const live = est != null ? `<p class="hw-live" aria-live="off"><span class="hw-live-bal">${esc(balanceLine(hv.points.balance + est))}</span>
        <span class="hw-sofar">${esc(plan.t('so_far', { n: est }, lang))}</span></p>` : '';
    // The next-reward bar, always on the timer screen: while the ring runs (moving with the count), at the end, after
    // his answer and on the break (the points as paid).
    const goal = hv.points ? plan.goalBar(hv.goal, { lang, extra: running ? est || 0 : 0 }) : '';
    root.innerHTML = `<header class="day-head hw-head"><a class="list-back" href="#homework">${esc(hw('hw_back_home'))}</a></header>
      <section class="hw-focus" aria-labelledby="hw-focus-h">
        ${fx.breakTm ? `${breakHTML()}${goal}` : `<p class="hw-focus-sub">${esc(sub)}</p>
        <h1 class="hw-focus-title" id="hw-focus-h">${esc(title)}</h1>
        ${step && step.done_looks_like && !ended ? `<p class="hw-focus-dll">${esc(plan.t('dll_line', { text: step.done_looks_like }, lang))}</p>` : ''}
        <p class="hw-focus-cue"${showCue ? '' : ' hidden'}>${esc(me.cue ? `“${me.cue}”` : '')}</p>
        ${onTime ? `<p class="hw-ontime">${esc(onTime)}</p>` : ''}
        <div class="hw-ring">${plan.ring(ended ? 0 : left.fraction)}<span class="hw-left">${esc(ended || left.done ? '' : `${left.minutes} min`)}</span></div>
        ${live}${goal}
        <p class="hw-tip"${wakeOk === false && !ended ? '' : ' hidden'}>${esc(plan.t('keep_screen', null, lang))}</p>
        ${body}`}
      </section>`;
    const again = root.querySelector('.hw-end input[name="note"]');
    if (again && note) again.value = note;
    drawSheet();
    playCheer();
    if (s && !ended && !left.done) { scheduleChime(); keepAwakeAgain(); startRing(); } else stopRing();
    if (fx.breakTm) startRing();
  }
  // The end screen. The block is paid the moment it ends: an End he tapped (Stop, End the block), or, when the
  // ring runs out, the End 'time' the page sends at once; then "Time. How did it go?" with what it paid, and
  // his answer (Step done, More to do, his note) is a second End that changes the result, never the points.
  function endHTML(s) {
    const r = fx.result;
    const e = fx.end;
    const asking = timeAnswer() || (e && e.result === 'time') || (!r && !e && s);   // the ring ran out: how did it go?
    if (e && !r && e.result !== 'time') {
      return `<div class="hw-end"><h2>${esc(hw('hw_time_up'))}</h2><p class="banner banner-warn hw-unsent" role="status">${esc(hw('hw_not_sent'))}</p></div>`;
    }
    const pointsHTML = () => {
      if (!r) return e && fx.unsent ? `<p class="banner banner-warn hw-unsent" role="status">${esc(hw('hw_not_sent'))}</p>` : '';
      const line = plan.pointsLine({ seen: r.block.seen_minutes, focus: r.earned.focus, on_time: r.earned.on_time, capped: r.earned.capped }, lang);
      return `<p class="hw-end-points"><span class="hw-points-line">${esc(line)}</span>${hv.points ? ` ${balanceHTML('hw-end-balance', hv.points.balance)}` : ''}</p>`;
    };
    if (r && !asking) {
      const next = nextStep(r.block.step_id);
      return `<div class="hw-end"><h2>${esc(hw('hw_finished'))}</h2>
        ${pointsHTML()}
        <div class="hw-end-next"><button type="button" class="btn day-big" data-act="hw-break">${esc(hw('hw_break_btn'))}</button>
        ${next ? `<button type="button" class="btn btn-primary day-big" data-act="hw-next" data-step="${esc(next.id)}">${esc(hw('hw_next_btn', { title: next.title }))}</button>` : ''}</div></div>`;
    }
    // The ring ran out (or he came back to a block that ended): what it paid, and how did it go?
    const b = s || (r && r.block) || null;
    const lateMs = r ? plan.ms(r.block.ended_at) - plan.ms(r.block.ends_at) : b ? plan.ms(hv.server_now) - plan.ms(b.ends_at) : 0;
    const q = b && lateMs > 2 * 60 * 1000 ? hw('block_ended', { n: b.minutes, time: plan.fmt.time(localTime(b.ends_at), lang) }) : hw('hw_time_up');
    const step = stepById((b && b.step_id) || fx.step);
    const done = step && step.done;
    // His answer is on its way (or waits for the time End): the buttons wait.
    const busy = !!fx.answer || (e && e.result !== 'time');
    const dis = busy ? ' disabled' : '';
    return `<div class="hw-end"><h2>${esc(q)}</h2>
      ${pointsHTML()}
      <label class="field"><span>${esc(plan.t('what_done', null, lang))}</span><input type="text" name="note" maxlength="120" autocomplete="off" enterkeyhint="done"></label>
      <div class="hw-end-acts"><button type="button" class="btn btn-primary day-big" data-act="hw-end" data-result="done"${dis}>${esc(hw('hw_done_check'))}</button>
      ${done ? '' : `<button type="button" class="btn day-big" data-act="hw-end" data-result="more"${dis}>${esc(plan.t('more_to_do', null, lang))}</button>`}</div></div>`;
  }
  function breakHTML() {
    const l = plan.left(fx.breakTm, perfNow());
    return `<div class="hw-break"><div class="hw-ring hw-ring-small">${plan.ring(l.fraction)}<span class="hw-left">${esc(l.done ? '' : `${l.minutes} min`)}</span></div>
      <p>${esc(plan.t('take_break', null, lang))}</p>
      <button type="button" class="btn day-big" data-act="hw-skip-break">${esc(hw('hw_skip_break'))}</button></div>`;
  }
  // Once a second while #focus is on screen: the ring, the minutes left, the cue's first minute.
  function startRing() {
    if (ringTimer) return;
    ringTimer = setInterval(tickRing, 1000);
  }
  function stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;
  }
  function tickRing() {
    if (view !== 'focus' || !hv) { stopRing(); return; }
    if (fx.breakTm) {
      const l = plan.left(fx.breakTm, perfNow());
      if (l.done) { fx.breakTm = null; stopRing(); renderFocus(); return; }
      const ring = root.querySelector('.hw-break .hw-ring');
      if (ring) ring.innerHTML = `${plan.ring(l.fraction)}<span class="hw-left">${esc(`${l.minutes} min`)}</span>`;
      return;
    }
    const s = hv.session;
    const tm = focusTimer();
    if (!s || !tm || fx.result || fx.end) { stopRing(); return; }
    const l = plan.left(tm, perfNow());
    if (l.done) { stopRing(); renderFocus(); timeEnd(); return; }
    const ring = root.querySelector('.hw-focus > .hw-ring');
    if (ring) ring.innerHTML = `${plan.ring(l.fraction)}<span class="hw-left">${esc(`${l.minutes} min`)}</span>`;
    const cue = root.querySelector('.hw-focus-cue');
    if (cue && !cue.hidden && elapsed(s) >= 60) cue.hidden = true;
    // The points counted up, once a minute (by the server's clock), and the bar with them.
    const live = root.querySelector('.hw-live');
    if (live && s.earn && hv.points) {
      const est = plan.estimate(s.earn, elapsed(s), s.minutes);
      if (est !== fx.est) {
        fx.est = est;
        live.querySelector('.hw-live-bal').textContent = balanceLine(hv.points.balance + est);
        live.querySelector('.hw-sofar').textContent = plan.t('so_far', { n: est }, lang);
        const g = root.querySelector('.hw-focus .plan-goal');
        if (g) g.outerHTML = plan.goalBar(hv.goal, { lang, extra: est });
      }
    }
  }
  // The ring ran out: always visual; a buzz where there is one; a notification only on a computer that asked,
  // while the page is hidden. The chime was scheduled at Start (and again on coming back); tones still more
  // than a moment away (an audio clock that stood still while he was away) are called off, so no chime comes
  // long after the end.
  function timeUp() {
    releaseWake();
    lateChimeOff();
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* no buzz */ }
    try {
      if (!phoneKind() && document.visibilityState === 'hidden' && typeof window.Notification === 'function' && window.Notification.permission === 'granted') {
        new window.Notification(hw('hw_time_up'), { body: hw('hw_notify_body') });
      }
    } catch (e) { /* the screen says it */ }
  }
  // End the block: Step done, More to do or Stop. Sent at once (the server counts the minutes to its answer);
  // with no answer it is kept and sent again on online, focus and visibilitychange (a block answers once).
  function endBlock(result) {
    const s = hv && hv.session;
    if (!s) return;
    // A second tap while this block's End is on its way changes nothing: that End's answer is the one drawn.
    if (fx.end && fx.end.session === s.id) return;
    root.querySelectorAll('.hw-focus-acts button, .hw-after-done button, .hw-end-acts button').forEach((b) => { b.disabled = true; });
    const input = root.querySelector('.hw-end input[name="note"]');
    const note = input ? plan.clean(input.value, 120) : '';
    fx.end = { session: s.id, step: s.step_id, result, note: note || undefined };
    fx.step = s.step_id;
    cancelChime();
    releaseWake();
    sendEnd();
  }
  // The payout the second a block ends (the owner's "immediate gratification"): when its ring runs out, on any
  // view, the page sends End 'time' at once, and the server pays the minutes it saw; his answer (Step done, More
  // to do, his note) comes after. A block he ended himself (Stop, End the block) was paid by that End.
  function autoFollow() {
    clearTimeout(autoTimer);
    autoTimer = null;
    const s = hv && hv.session;
    if (!s || (fx.end && fx.end.session === s.id) || (fx.result && fx.result.block && fx.result.block.id === s.id)) return;
    const tm = focusTimer();
    const l = tm ? plan.left(tm, perfNow()) : null;
    if (l && l.done) Promise.resolve().then(timeEnd);   // ended already (a read after time away): paid now
    else if (l) autoTimer = setTimeout(timeEnd, l.ms + 500);
  }
  function timeEnd() {
    clearTimeout(autoTimer);
    autoTimer = null;
    const s = hv && hv.session;
    if (!s || starting) return;
    if (blockRunning()) { autoFollow(); return; }
    if ((fx.end && fx.end.session === s.id) || (fx.result && fx.result.block && fx.result.block.id === s.id)) return;
    if (fx.id !== s.id) fx = { id: s.id };
    fx.end = { session: s.id, step: s.step_id, result: 'time' };
    fx.step = s.step_id;
    releaseWake();
    lateChimeOff();
    sendEnd();
  }
  // His answer on the end screen: after the time End (a second End, the points as paid); tapped while the time End
  // is on its way, it waits for it; before any End went (the ring ran out a moment ago), it is the End.
  function answerBlock(result) {
    const r = fx.result;
    const e = fx.end;
    if (fx.answer || (e && e.result !== 'time')) return;   // his answer is on its way already
    const input = root.querySelector('.hw-end input[name="note"]');
    const note = input ? plan.clean(input.value, 120) : '';
    root.querySelectorAll('.hw-end-acts button').forEach((b) => { b.disabled = true; });
    if (e && e.result === 'time') { fx.answer = { result, note: note || undefined }; return; }
    if (timeAnswer()) {
      fx.end = { session: r.block.id, step: r.block.step_id, result, note: note || undefined, answer: true };
      sendEnd();
      return;
    }
    endBlock(result);
  }
  async function sendEnd() {
    const e = fx.end;
    if (!e || fx.sending) return;
    fx.sending = true;
    const r = await focusCall('end', { session: e.session, result: e.result, note: e.note }, true);
    fx.sending = false;
    if (fx.end !== e) return;
    if (r.data) {
      fx.end = null;
      fx.unsent = false;
      fx.result = { block: r.data.block, earned: r.data.earned };
      // The celebration: what this End paid (its earned; his answer after a 'time' End pays nothing more), ticked
      // up to the balance on the view he is on, whatever else moved the balance during the block.
      const after = hv && hv.points ? hv.points.balance : null;
      const earned = r.data.earned || {};
      const paid = e.answer ? 0 : (Number(earned.focus) || 0) + (Number(earned.on_time) || 0);
      if (paid > 0 && after != null) cheer = { from: after - paid, to: after };
      if (fx.answer && timeAnswer()) {
        const a = fx.answer;
        fx.answer = null;
        fx.end = { session: fx.result.block.id, step: fx.result.block.step_id, result: a.result, note: a.note, answer: true };
        sendEnd();
      }
      fx.answer = null;
      afterEnd();
      return;
    }
    if (r.gone) return;
    if (r.kind === 'retry') { fx.unsent = true; if (view === 'focus') renderFocus(); return; }
    fx.end = null;
    fx.answer = null;
    toast(hwFriendly(r.error), { error: true });
    hwRead();
  }
  // Drawn where he is: the end screen, #homework (its "How did it go?" line), #points, or the day (read again; the
  // card celebrates). Anywhere else (his plan) nothing shows his balance: no celebration, then or later.
  function afterEnd() {
    if (view === 'focus') renderFocus();
    else if (view === 'homework') renderHomework(true);
    else if (view === 'points') renderPoints(true);
    else if (view === 'day') refresh();
    else cheer = null;
  }
  // The small celebration (the owner's "immediate gratification"): the ★ counter ticks up to the new total, a
  // visible "+N", and a short sound through the AudioContext his Start tap made (the silent switch mutes it).
  // Played once, on the view he is on when the points come (the day's card too); at once with reduced motion. A
  // view drawn without it lets it go, so it never plays later, out of context.
  function playCheer() {
    const c = cheer;
    const el = c && root.querySelector('[data-cheer]');
    if (!el) return;
    cheer = null;
    const plus = c.to - c.from;
    el.insertAdjacentHTML('afterend', ` <span class="hw-plus" aria-hidden="true">+${plus}</span>`);
    const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduce) {
      el.textContent = balanceLine(c.to);
    } else {
      const steps = Math.max(1, Math.min(plus, 20));
      let i = 0;
      el.textContent = balanceLine(c.from);
      const tick = setInterval(() => {
        i += 1;
        el.textContent = balanceLine(i >= steps ? c.to : Math.round(c.from + (plus * i) / steps));
        if (i >= steps) clearInterval(tick);
      }, 40);
    }
    cheerSound();
  }
  function cheerSound() {
    try {
      if (!audio || audio.ctx.state === 'closed') return;
      const ctx = audio.ctx;
      const at = ctx.currentTime + 0.02;
      [[784, 0], [1047, 0.1]].forEach(([freq, delay]) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, at + delay);
        g.gain.exponentialRampToValueAtTime(0.18, at + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + delay + 0.15);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(at + delay);
        o.stop(at + delay + 0.18);
      });
    } catch (e) { /* the screen says it */ }
  }
  async function doneStep() {
    const s = hv && hv.session;
    if (!s) return;
    if (!s.step_id) { endBlock('done'); return; }
    const r = await stepCall(s.step_id, 'done');
    if (!r.data) return;
    fx.afterDone = true;
    renderFocus();
    // A milestone done mid-block pays its first half at once.
    const paid = Number(r.data.paid) || 0;
    const after = stepById(s.step_id);
    if (paid > 0) { toast(hw('milestone_now', { n: paid, m: (after && after.waiting) || 0 })); cheerSound(); }
  }
  async function switchTo(stepId) {
    const s = hv && hv.session;
    if (!s || !stepId) return;
    const r = await focusCall('switch', { session: s.id, step: stepId });
    if (!r.data) return;
    fx.afterDone = false;
    sheet = null;
    renderFocus();
  }

  // ---------- Sheets: stuck, Make it smaller, Ask Pat, his cue and his if-stuck line ----------
  function openSheet(kind, step, text) {
    sheet = { kind, step: step || null, text: text || '' };
    drawSheet();
    const input = root.querySelector('.hw-sheet input[name="text"]');
    if (input) input.focus();
    else { const b = root.querySelector('.hw-sheet button'); if (b) b.focus(); }
  }
  function closeSheet() {
    sheet = null;
    drawSheet();
  }
  function drawSheet() {
    const old = root.querySelector('.hw-sheet');
    if (old) old.remove();
    if (!sheet || !hv) return;
    const me = hv.me || {};
    const close = view === 'focus' ? hw('hw_back_timer') : hw('hw_cancel');
    const closeBtn = `<button type="button" class="btn" data-act="hw-sheet-close">${esc(close)}</button>`;
    const field = (max, hint) => `<input type="text" name="text" maxlength="${max}" value="${esc(sheet.text)}" placeholder="${esc(hint || '')}" autocomplete="off" enterkeyhint="send">`;
    let inner;
    if (sheet.kind === 'stuck') {
      const s = hv.session;
      const next = s ? nextStep(s.step_id) : null;
      const plan0 = me.if_stuck
        ? `<h2 class="hw-stuck-plan" id="hw-sheet-h">${esc(hw('hw_stuck_plan', { text: me.if_stuck }))}</h2><button type="button" class="hw-edit" data-act="hw-ifstuck" aria-label="${esc(hw('hw_stuck_edit'))}">✎</button>`
        : `<h2 class="sr-only" id="hw-sheet-h">${esc(hw('hw_stuck_title'))}</h2><button type="button" class="hw-link hw-stuck-plan" data-act="hw-ifstuck">${esc(hw('hw_stuck_none'))}</button>`;
      // A smaller step and a question belong to a step. A block on an assignment with no plan (Start on a
      // Tonight row) gets one when he picks either (blockStep); a block on neither has only Next step.
      const onWork = !!(s && (s.step_id || s.assignment_id));
      inner = `<div class="hw-sheet-head">${plan0}</div>
        <div class="hw-sheet-acts">
          ${onWork ? `<button type="button" class="btn day-big" data-act="hw-smaller" data-step="${esc(s.step_id || '')}">${esc(plan.t('make_smaller', null, lang))}</button>
          <p class="hw-sheet-hint">${esc(`${hw('hw_smaller_hint')}: ${[0, 1, 2].map((i) => hw(`hw_chip_${i}`)).join(' · ')} · ${hw('hw_own')}`)}</p>
          <button type="button" class="btn day-big" data-act="hw-ask" data-step="${esc(s.step_id || '')}">${esc(hw('ask_tutor'))}</button>
          <p class="hw-sheet-hint">${esc(hw('hw_ask_hint'))}</p>` : ''}
          <button type="button" class="btn day-big" data-act="hw-next-step" data-step="${esc(next ? next.id : '')}"${next ? '' : ' disabled'}>${esc(plan.t('next_step', null, lang))}</button>
          <p class="hw-sheet-hint">${esc(next ? [next.assignment, next.title].filter(Boolean).join(' · ') : '')}</p>
          <button type="button" class="btn day-big" data-act="hw-sheet-close">${esc(hw('hw_back_timer'))}</button>
        </div>`;
    } else if (sheet.kind === 'smaller') {
      inner = `<h2 id="hw-sheet-h">${esc(plan.t('make_smaller', null, lang))}</h2><p class="hw-sheet-hint">${esc(hw('hw_smaller_hint'))}</p>
        <div class="list-chips">${[0, 1, 2].map((i) => `<button type="button" class="list-chip" data-chip="${i}">${esc(hw(`hw_chip_${i}`))}</button>`).join('')}</div>
        <form class="hw-inline hw-sheet-form" novalidate>${field(80, hw('hw_own'))}<button type="button" class="btn btn-primary" data-act="hw-sheet-send">${esc(hw('hw_save'))}</button></form>
        <div class="form-actions">${closeBtn}</div>`;
    } else {
      const title = { ask: hw('ask_tutor'), cue: hw('hw_cue_edit'), ifstuck: hw('hw_stuck_edit') }[sheet.kind];
      const hint = { ask: hw('hw_ask_hint'), cue: hw('hw_cue_hint'), ifstuck: hw('hw_stuck_hint') }[sheet.kind];
      inner = `<h2 id="hw-sheet-h">${esc(title)}</h2>
        <form class="hw-inline hw-sheet-form" novalidate>${field(sheet.kind === 'ask' ? 200 : 120, sheet.kind === 'ask' ? '' : hint)}<button type="button" class="btn btn-primary" data-act="hw-sheet-send">${esc(sheet.kind === 'ask' ? hw('hw_send') : hw('hw_save'))}</button></form>
        ${sheet.kind === 'ask' ? `<p class="hw-sheet-hint">${esc(hint)}</p>` : ''}
        <div class="form-actions">${closeBtn}</div>`;
    }
    const el = document.createElement('div');
    el.className = 'hw-sheet';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'hw-sheet-h');
    el.innerHTML = `<div class="hw-sheet-card">${inner}</div>`;
    root.appendChild(el);
  }
  // The step the stuck sheet's Make it smaller and Ask Pat work on: the block's. A block started on an
  // assignment with no plan (Start on a Tonight row) has none: Quick makes it one step of the block's length,
  // given at once (as his Quick does), and the block moves to it ('switch'), so Step done still finishes the
  // assignment. A resend finds his Quick done already, and the block on it.
  async function blockStep() {
    const s = hv && hv.session;
    if (!s) return null;
    if (s.step_id) return s.step_id;
    if (!s.assignment_id) return null;
    const open = () => { const a = asgById(s.assignment_id); return (a && (a.steps || []).find((x) => !x.done)) || null; };
    let st = open();
    if (!st) {
      const q = await asgCall('quick', { assignment: s.assignment_id, minutes: s.minutes });
      if (!q.data) return null;
      st = open();
      if (!st) return null;
    }
    const r = await focusCall('switch', { session: s.id, step: st.id });
    return r.data ? st.id : null;
  }
  // A sheet sends once at a time; Make it smaller keeps one key (the new step's id) until an answer, so a
  // second tap, or a tap again after "Can't reach Home Hub" when the first one landed, finds the step the
  // first one made (one step, never two).
  async function sheetSend(text) {
    const sh = sheet;
    if (!sh || sh.sending) return;
    const typed = plan.clean(text, 200);
    if (sh.kind === 'smaller') {
      if (Array.from(typed).length < 3) { toast(plan.t('chk_title_len', null, lang), { error: true }); return; }
      const key = sh.key || (sh.key = plan.newId());
      sh.sending = true;
      let r;
      try {
        const step = sh.step || await blockStep();
        r = step ? await stepCall(step, 'smaller', { text: typed, key }) : {};
      } finally { sh.sending = false; }
      if (!r.data) return;
      sheet = null;
      if (view === 'focus') { fx.afterDone = false; renderFocus(); } else { nowId = key; renderHomework(true); }
    } else if (sh.kind === 'ask') {
      if (!typed) return;
      sh.sending = true;
      let r;
      try {
        const step = sh.step || await blockStep();
        r = step ? await stepCall(step, 'ask', { text: typed }) : {};
      } finally { sh.sending = false; }
      if (!r.data) return;
      sheet = null;
      toast(hw('hw_question_sent'));
      hwRedraw(true);
    } else {
      const me = hv.me || {};
      const r = await prefsCall(sh.kind === 'cue' ? typed || null : me.cue || null, sh.kind === 'ifstuck' ? typed || null : me.if_stuck || null);
      if (!r.data) return;
      sheet = view === 'focus' && sh.kind === 'ifstuck' ? { kind: 'stuck' } : null;
      hwRedraw(true);
    }
  }

  // ---------- Steps from #homework: tick, Undo, Not today, Re-plan, Quick, + Homework ----------
  async function tickStep(id) {
    const s = stepById(id);
    if (!s || s.done) return;
    menuOpen = null;
    const r = await stepCall(id, 'done');
    if (!r.data) { renderHomework(true); return; }
    const after = stepById(id);
    // A milestone pays half at once: "+20 now · +20 more when Pat checks it", and the counter ticks up by what it paid.
    const paid = Number(r.data.paid) || 0;
    if (paid > 0 && hv.points) cheer = { from: hv.points.balance - paid, to: hv.points.balance };
    const msg = after && after.kind === 'milestone' && paid > 0 && after.waiting ? hw('milestone_now', { n: paid, m: after.waiting })
      : after && after.kind === 'milestone' && after.waiting ? hw('waiting_check', { n: after.waiting }) : t('ticked', { title: s.title });
    toast(msg, { ms: UNDO_MS, action: { label: t('undo'), onClick: () => undoStep(id) } });
    renderHomework(true);
  }
  async function undoStep(id) {
    const r = await stepCall(id, 'undo');
    if (r.data) toast(t('undone'));
    hwRedraw(true);
  }
  async function notToday(id) {
    const s = stepById(id);
    if (!s) return;
    menuOpen = null;
    const r = await stepCall(id, 'not_today', { day: s.day });
    if (r.data) {
      const moved = stepById(id);
      if (moved && moved.day !== s.day) toast(hw('hw_moved', { day: hwRel(moved.day) }));
    }
    renderHomework(true);
  }
  // Re-plan: his plain steps not done placed again from today (plan_by_token with p_steps null), one assignment
  // at a time. A milestone it can't move shows under Due soon, with Ask Pat.
  async function replan(ids) {
    let fits = true;
    for (const id of ids) {
      const a = asgById(id);
      if (!a) continue;
      const r = await planCall(id, null, a.plan_rev);
      if (!r.data) { hwRedraw(true); return; }
      if (r.data.plan && r.data.plan.fits === false) fits = false;
    }
    toast(fits ? plan.t('replanned', null, lang) : plan.t('doesnt_fit', null, lang), fits ? undefined : { ms: 6000 });
    hwRedraw(true);
  }
  async function quick(id, minutes) {
    quickOpen = null;
    const r = await asgCall('quick', { assignment: id, minutes });
    if (r.data) {
      const a = asgById(id);
      const s = a && (a.steps || []).find((x) => !x.done);
      if (s) nowId = s.id;
    }
    renderHomework(true);
  }
  // New from school: Quick (his length), Plan with Pat and Hide, each one tap through school_item_by_token. The item's
  // buttons stay off while one is on its way, so a second tap sends nothing; a refusal is said and the item stays.
  function schoolHold(id, on) {
    if (on) schoolBusy.add(id); else schoolBusy.delete(id);
    root.querySelectorAll(`.hw-school-item[data-item="${CSS.escape(id)}"] button`).forEach((b) => { b.disabled = on; });
  }
  async function schoolAct(id, action) {
    const x = schoolItem(id);
    if (!x || schoolBusy.has(id) || (action === 'quick' && x.quick !== true)) return;
    schoolHold(id, true);
    const r = await schoolCall(action, id, action === 'quick' ? schoolMinutes() : undefined);
    schoolHold(id, false);
    if (r.gone) return;   // homework went off, or the link: hwNull shows the day
    if (r.data) {
      const a = r.data.assignment_id ? asgById(r.data.assignment_id) : null;
      if (action === 'quick') {
        const s = a && (a.steps || []).find((y) => !y.done);
        if (s && s.day === hv.today) nowId = s.id;
        if (s) toast(hw('hw_school_planned', { title: x.title, day: hwRel(s.day) }));
      } else if (action === 'with_tutor') toast(hw('hw_school_for_pat', { title: x.title }));
      else toast(hw('hw_school_hidden', { title: x.title }));
    }
    renderHomework(true);
  }
  async function addHomework(form) {
    const f = form.elements;
    const err = form.querySelector('.form-error');
    const fail = (m, field) => { err.textContent = m; err.hidden = false; if (field) field.focus(); };
    const title = plan.clean(f.title.value, 120);
    const subject = plan.clean(f.subject.value, 40);
    const due = String(f.due.value || '');
    const minutes = Math.round(Number(f.minutes.value));
    if (!title) return fail(hw('hw_add_need'), f.title);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || due < hv.today || due > plan.addDays(hv.today, 60)) return fail(hw('hw_add_need_due'), f.due);
    if (!(minutes >= 5 && minutes <= 60)) return fail(hw('hw_add_minutes_bad'), f.minutes);
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    // Due within 3 days: Quick too (one step of his minutes, given at once). Later: plan it with Pat.
    const id = form.dataset.id || plan.newId();
    form.dataset.id = id;
    const r = await asgCall('add', { assignment: id, title, subject: subject || null, due, minutes: plan.daysBetween(hv.today, due) <= 3 ? minutes : undefined });
    form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    if (!r.data) return undefined;
    addOpen = false;
    const a = asgById(id);
    const s = a && (a.steps || []).find((x) => !x.done);
    if (s) nowId = s.id;
    renderHomework(true);
    return undefined;
  }

  // ---------- #points: Ask, Cash (an instant reward, on the spot), Cancel, Suggest ----------
  // "Get it now": its "Yes, get it" where it was, taking a tap a moment later.
  function openCash(id) {
    cashOpen = id;
    cashArmed = false;
    clearTimeout(cashArmTimer);
    cashArmTimer = setTimeout(() => {
      cashArmed = true;
      const yes = root.querySelector('[data-act="hw-cash-yes"]');
      if (yes && view === 'points') yes.disabled = false;
    }, 400);
    renderPoints(true);
  }
  // Yes: the cash-in, with the price his button showed (a price changed since is refused). Its key is the reward's
  // until an answer comes, or a read shows it landed: a tap again after a lost answer, after Cancel or another view,
  // finds the cash-in it made (never two). A refusal, or no answer, reads his view again, so the buttons say what
  // the server says (and a cash-in that did land shows as got).
  async function cashReward(id) {
    const rw = ((hv && hv.rewards) || []).find((x) => x.id === id);
    if (!rw) return;
    const key = cashKeys[id] || (cashKeys[id] = plan.newId());
    root.querySelectorAll(`.hw-reward[data-reward="${id}"] button`).forEach((b) => { b.disabled = true; });
    const r = await rewardCall('cash', { reward: id, key, cost: rw.cost });
    if (r.data || r.kind === 'refused') {
      if (cashKeys[id] === key) delete cashKeys[id];
      if (cashOpen === id) cashOpen = null;
    }
    if (r.data) { toast(hw('hw_cashed_toast', { title: rw.title })); renderPoints(true); return; }
    renderPoints(true);
    if (r.gone) return;
    await hwRead();
    if (r.kind !== 'refused' && cashKeys[id] !== key) toast(hw('hw_cashed_toast', { title: rw.title }));   // the read found it landed
  }
  async function askReward(id) {
    const r = await rewardCall('ask', { reward: id, key: plan.newId() });
    const rw = ((hv && hv.rewards) || []).find((x) => x.id === id);
    if (r.data && rw) toast(hw('hw_asked_toast', { title: rw.title }));
    renderPoints(true);
    if (r.kind === 'refused') hwRead();   // what can be asked for now, from the server
  }
  async function cancelAsk(id) {
    await rewardCall('cancel', { key: id });
    renderPoints(true);
  }
  async function suggest(form) {
    const input = form.elements.text;
    const text = plan.clean(input.value, 60);
    if (!text) { input.focus(); return; }
    const key = form.dataset.key || plan.newId();
    form.dataset.key = key;
    const r = await rewardCall('suggest', { text, key });
    if (!r.data) return;
    delete form.dataset.key;
    toast(hw('hw_suggested', { title: text }));
    renderPoints(true);
  }

  // ---------- #plan/<id>: the editor in his role ----------
  function editorAssignment(id) {
    const a = asgById(id);
    if (!a || a.state !== 'given' || a.status !== 'open') return null;
    return {
      id: a.id, kind: a.kind, title: a.title, subject: a.subject, due_date: a.due_date, status: a.status, plan_rev: a.plan_rev,
      given_at: null, given_by: a.given_by, time_left: a.time_left, horizon: a.horizon, no_time: a.no_time,
      steps: (a.steps || []).map((s) => ({ id: s.id, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like, minutes: s.minutes,
        day: s.day, source: 'typed', done: s.done, checked: s.checked, moved_from: null })),
    };
  }
  const editorOpts = () => ({ lang, today: hv.today, asOf: hv.as_of, serverNow: hv.server_now, length: lengthOf(), kid: (hv.me || {}).first_name || '', tutor: hwTutor() });
  // The editor's api: { assignment } | { error } | { gone: true }.
  async function edAnswer(start, id) {
    const r = await hwWrite(start, true);
    if (r.gone) return { gone: true };
    if (r.error) return { error: r.error };
    const a = editorAssignment(id);
    return a ? { assignment: a } : { gone: true };
  }
  function renderPlan(id) {
    cheer = null;   // no balance here: a celebration never waits for a later view
    if (!hv) { hwFrame('plan'); return; }
    if (ed && edFor === id && root.querySelector('.hw-plan .plan-editor')) return;
    if (ed) { ed.stop(); ed = null; }
    const a = editorAssignment(id);
    root.innerHTML = `<header class="day-head hw-head"><a class="list-back" href="#homework">${esc(hw('hw_back_home'))}</a></header>
      <div class="hw-plan">${a ? '' : `<p class="empty-line">${esc(hw('hw_being_planned'))}</p>`}</div>${footerHTML()}`;
    document.title = `${(asgById(id) || {}).title || hw('homework')} · ${t('my_day')}`;
    if (!a) return;
    edFor = id;
    ed = plan.editor(root.querySelector('.hw-plan'), Object.assign(editorOpts(), {
      role: 'kid', week: [], toast: (text) => toast(text), friendly: hwFriendly, onGone: hwNull,
      api: {
        save: ({ steps, rev }) => edAnswer(() => sb.rpc('plan_by_token', { p_token: token, p_assignment: id, p_steps: steps, p_rev: rev }), id),
        reload: async () => {
          let v;
          try { v = await readHomework(); } catch (err) { return { error: err }; }
          if (!v) return { gone: true };
          take(v);
          const x = editorAssignment(id);
          return x ? { assignment: x } : { gone: true };
        },
        replan: () => edAnswer(() => sb.rpc('plan_by_token', { p_token: token, p_assignment: id, p_steps: null, p_rev: (asgById(id) || {}).plan_rev }), id),
      },
    }));
    ed.set(a);
  }

  // ---------- Which view, and leaving them ----------
  function renderHomeworkView(v) {
    stopViews(v);
    view = v;
    if (v === 'homework') renderHomework(true);
    else if (v === 'points') renderPoints(true);
    else if (v === 'focus') renderFocus();
    else if (v === 'plan') renderPlan(planIdFromHash());
  }
  const planIdFromHash = () => { const m = /^#plan\/([0-9a-f-]{36})$/i.exec(location.hash); return m && UUID.test(m[1]) ? m[1].toLowerCase() : null; };
  // A homework view can show: plan.js is loaded and the day says homework is on (or no day yet: the read says).
  const canHomework = () => !!plan && !!state && !!state.homework;
  function stopViews(next) {
    stopList();
    stopHomework(next);
  }
  function stopHomework(next) {
    clearInterval(hwPollTimer);
    hwPollTimer = null;
    stopRing();
    // Leaving #focus: a finished block's screen goes (an End still waiting stays, to be sent again, and so does a
    // block paid when its ring ran out, until he says how it went).
    if (next !== 'focus' && !fx.end && !timeAnswer()) fx = hv && hv.session ? Object.assign(fx, { breakTm: null, result: null }) : {};
    if (next !== 'points') cashOpen = null;   // its key stays until an answer (cashKeys)
    if (ed && next !== 'plan') { ed.stop(); ed = null; edFor = null; }
    if (sheet && next !== view) sheet = null;
    menuOpen = null;
    quickOpen = null;
    hvDrawn = '';
  }
  // Focus, coming back into view, coming back online: an End that waits goes again; the view is read again
  // (the ring takes the server's clock again), never under a finger or an unsaved plan. The wake lock and the
  // chime are taken and set again in refreshSoon, on every view.
  function homeworkSoon() {
    if (fx.end) sendEnd();
    if (hwBusy || Date.now() - hvLast < 1000) return;
    if (view === 'plan' && ed && ed.dirty()) return;
    if (view === 'homework' && (addOpen || sheet)) return;
    hwRead();
  }
  // Only while the ring runs: never for an end screen whose ring already ran out, nor once he ended it.
  function keepAwakeAgain() {
    if (wake || wakeAsk || wakeOk === false || document.visibilityState !== 'visible' || fx.end || fx.result || !blockRunning()) return;
    keepAwake();
  }

  // ---------- Taps ----------
  function hwClick(e) {
    // After a reload there is no AudioContext (one needs a tap): his first tap on #focus makes it, and the chime.
    if (view === 'focus' && !audio && hv && hv.session && !fx.end && !fx.result && blockRunning()) armAudio();
    const el = e.target.closest('[data-act^="hw-"], .hw-box, .hw-len, [data-quick], [data-chip]');
    if (!el || !root.contains(el) || el.disabled) return false;
    const stepId = el.getAttribute('data-step');
    const asg = el.getAttribute('data-asg');
    if (el.classList.contains('hw-box')) { tickStep(el.closest('.hw-step').dataset.step); return true; }
    if (el.classList.contains('hw-len')) {
      lengthPick = Number(el.dataset.len);
      try { localStorage.setItem(LENGTH_KEY, String(lengthPick)); } catch (err) { /* this visit only */ }
      renderHomework(true);
      return true;
    }
    if (el.hasAttribute('data-quick')) { quick(asg, Number(el.dataset.quick)); return true; }
    if (el.hasAttribute('data-chip')) { sheetSend(hw(`hw_chip_${el.dataset.chip}`)); return true; }
    switch (el.dataset.act) {
      case 'hw-day':
        e.preventDefault();
        try { history.replaceState(null, '', dayHref); } catch (err) { /* the hash stays */ }
        if (state) render();
        else start();
        break;
      case 'hw-card-start': {
        const c = state && state.homework;
        if (c && c.next) startBlock({ step: c.next.id, minutes: lengthPick || c.length, with: 'alone' });
        break;
      }
      case 'hw-start': startBlock({ step: stepId, minutes: lengthOf(), with: withPick }); break;
      case 'hw-start-step': startBlock({ step: stepId, minutes: lengthOf(), with: withPick }); break;
      case 'hw-asg-start': startBlock({ assignment: asg, minutes: lengthOf(), with: withPick }); break;
      case 'hw-now':
        nowId = stepId;
        menuOpen = null;
        renderHomework(true);
        root.querySelector('.hw-now').scrollIntoView({ block: 'nearest' });
        break;
      case 'hw-more': menuOpen = menuOpen === stepId ? null : stepId; renderHomework(true); break;
      case 'hw-done': tickStep(stepId); break;
      case 'hw-not-today': notToday(stepId); break;
      case 'hw-smaller': menuOpen = null; openSheet('smaller', stepId); break;
      case 'hw-ask': menuOpen = null; openSheet('ask', stepId); break;
      case 'hw-talk': if (stepId) openSheet('ask', stepId, el.dataset.text); break;
      case 'hw-edit': location.hash = `#plan/${asg}`; break;
      case 'hw-quick': quickOpen = quickOpen === asg ? null : asg; renderHomework(true); break;
      case 'hw-school-open': schoolScroll = true; break;   // the link itself opens #homework
      case 'hw-school-quick': schoolAct(el.dataset.item, 'quick'); break;
      case 'hw-school-pat': schoolAct(el.dataset.item, 'with_tutor'); break;
      case 'hw-school-hide': schoolAct(el.dataset.item, 'hide'); break;
      case 'hw-add': addOpen = true; renderHomework(true); { const i = root.querySelector('.hw-add-form input[name="title"]'); if (i) i.focus(); } break;
      case 'hw-add-cancel': addOpen = false; renderHomework(true); break;
      case 'hw-replan-earlier': replan([...new Set(((hv && hv.earlier) || []).map((s) => s.assignment_id))]); break;
      case 'hw-replan': replan([asg]); break;
      case 'hw-cue': openSheet('cue', null, (hv.me || {}).cue || ''); break;
      case 'hw-ifstuck': openSheet('ifstuck', null, (hv.me || {}).if_stuck || ''); break;
      case 'hw-notify':
        notifyAsked = true;
        try { window.Notification.requestPermission().catch(() => {}); } catch (err) { /* nothing more to ask */ }
        renderHomework(true);
        break;
      case 'hw-stuck': openSheet('stuck'); break;
      case 'hw-done-step': doneStep(); break;
      case 'hw-stop': endBlock('stopped'); break;
      case 'hw-keep': switchTo(stepId); break;
      case 'hw-next-step': switchTo(stepId); break;
      case 'hw-end-block': endBlock('done'); break;
      case 'hw-end': answerBlock(el.dataset.result === 'more' ? 'more' : 'done'); break;
      case 'hw-break': fx.breakTm = plan.timer({ ends_in_s: 300, minutes: 5 }, perfNow()); renderFocus(); break;
      case 'hw-skip-break': fx.breakTm = null; stopRing(); renderFocus(); break;
      case 'hw-next': fx = {}; nowId = stepId; location.hash = '#homework'; break;
      case 'hw-sheet-close': closeSheet(); break;
      case 'hw-sheet-send': { const i = root.querySelector('.hw-sheet input[name="text"]'); sheetSend(i ? i.value : ''); break; }
      case 'hw-ask-reward': askReward(el.dataset.reward); break;
      case 'hw-cash': openCash(el.dataset.reward); break;
      case 'hw-cash-no': cashOpen = null; renderPoints(true); break;
      case 'hw-cash-yes': cashReward(el.dataset.reward); break;
      case 'hw-cancel-ask': cancelAsk(el.dataset.ask); break;
      default: return false;
    }
    return true;
  }
  root.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.classList.contains('hw-add-form')) { e.preventDefault(); addHomework(form); } else if (form.classList.contains('hw-suggest-form')) { e.preventDefault(); suggest(form); } else if (form.classList.contains('hw-sheet-form')) {
      e.preventDefault();
      sheetSend(form.elements.text.value);
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.name === 'with' && e.target.closest('.hw-now-card')) withPick = e.target.value;
    else if (e.target.name === 'silent') { try { localStorage.setItem(SILENT_KEY, e.target.checked ? '1' : '0'); } catch (err) { /* this visit only */ } }
  });
  root.addEventListener('input', (e) => { if (sheet && e.target.closest('.hw-sheet') && e.target.name === 'text') sheet.text = e.target.value; });
  root.addEventListener('toggle', (e) => {
    if (e.target.classList && e.target.classList.contains('hw-earlier')) earlierOpen = e.target.open;
    else if (e.target.classList && e.target.classList.contains('hw-school-more')) schoolMoreOpen = e.target.open;
  }, true);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet) closeSheet();
  });

  // ============================================
  // THE TUTOR LINK (day.html?h=<token>, v1.3, docs/v1.3-homework.md §9.5): Jordan's homework and nothing else.
  // Nobody's day is loaded: plan.js's tutor view draws it, with an api of the four tutor functions only. The
  // words follow the link's language. Nothing is kept on the device.
  // ============================================
  function startTutor() {
    root.classList.add('day-tutor');
    if (!CODE.test(tutorToken)) { tutorGone(); return; }
    if (!cfg.supabaseUrl || !cfg.supabaseKey) { showProblem('not_setup'); return; }
    if (!window.supabase || !window.supabase.createClient) { showProblem('not_loaded'); return; }
    if (!plan) { showProblem('not_loaded'); return; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    view = 'tutor';
    // The link's language and the kid's first name, from each answer that carries them.
    const seen = (res) => {
      const d = res && res.data;
      if (d && typeof d === 'object' && d.kid) {
        lang = d.language === 'es' ? 'es' : 'en';
        document.documentElement.lang = lang;
        document.title = plan.t('tutor_title', { kid: d.kid }, lang);
      }
      return res;
    };
    // The AI preview's "last sent" marks (PR B, §6.4): the only thing besides the language kept on the device for the link.
    const sent = {
      get: (id) => { try { return localStorage.getItem(`hh.ai.sent.${id}`); } catch (e) { return null; } },
      set: (id, mark) => { try { localStorage.setItem(`hh.ai.sent.${id}`, mark); } catch (e) { /* no storage: always open */ } },
    };
    // hub-jobs' homework_ai (PR B): the token goes in the body, never in the call's address; supabase-js sends only the
    // publishable key, so it is never a sign-in.
    const invokeAi = async (body) => {
      const r = await sb.functions.invoke('hub-jobs', { body: Object.assign({ action: 'homework_ai', token: tutorToken }, body) });
      return { data: r.error ? null : r.data, error: r.error || null };
    };
    const ctl = plan.tutor(root, {
      lang,
      toast,
      sent,
      onGone: () => { document.title = 'Home Hub'; },
      go: (hash) => { location.hash = hash; },
      api: {
        ai: (body) => one(() => invokeAi(body)),
        view: (id, part) => one(() => sb.rpc('tutor_view_by_token', { p_token: tutorToken, p_assignment: id || null, p_part: part || 'all' })).then(seen),
        assignment: (fields) => one(() => sb.rpc('tutor_assignment_by_token', { p_token: tutorToken, p_fields: fields })).then(seen),
        plan: (id, steps, rev, give) => one(() => sb.rpc('tutor_plan_by_token', { p_token: tutorToken, p_assignment: id, p_steps: steps, p_rev: rev, p_give: !!give })).then(seen),
        step: (stepId, action, text) => one(() => sb.rpc('tutor_step_by_token', { p_token: tutorToken, p_step: stepId, p_action: action, p_text: text })).then(seen),
      },
    });
    document.documentElement.lang = lang;
    ctl.show(location.hash);
    window.addEventListener('hashchange', () => ctl.show(location.hash));
    window.addEventListener('focus', () => ctl.refresh());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ctl.refresh(); });
  }
  // A link that can't work (not 32 hex characters): the words, with no call at all.
  function tutorGone() {
    view = 'problem';
    const words = plan ? plan.t('link_gone', null, lang) : t('bad_link');
    root.innerHTML = `<div class="plan-problem day-problem"><p lang="${lang}">${esc(words)}</p></div>`;
  }

  // ============================================
  // START
  // ============================================
  const viewFromHash = () => ({ '#confirm': 'confirm', '#stop': 'stop', '#list': 'list', '#homework': 'homework', '#focus': 'focus', '#points': 'points' }[location.hash]
    || (planIdFromHash() ? 'plan' : 'day'));

  function render() {
    const v = viewFromHash();
    if (v === 'list' && canList()) renderList();
    else if (HW_VIEWS.has(v) && canHomework()) renderHomeworkView(v);
    else if (v === 'day' || v === 'list' || HW_VIEWS.has(v)) renderDay(true);   // #list or #homework without it on the day: the day
    else renderAsk(v);
  }

  async function start() {
    stopViews('loading');
    root.innerHTML = `<p class="loading">${esc(t('loading'))}</p>`;
    view = 'loading';
    await outboxReady;
    let day;
    try {
      day = await fetchDay();
    } catch (err) {
      // No answer. A list saved for this link still shows, in its own language (§7.2).
      const saved = outbox && outbox.view();
      if (saved) {
        listOffline = true;
        lang = saved.language === 'es' ? 'es' : 'en';
        if (viewFromHash() === 'list') { fromDay = false; renderList(); return; }
      }
      showProblem(() => friendly(err), true, !!saved);
      return;
    }
    if (!day) { linkGone(); return; }
    accept(day);
    render();
    afterDay(day);
  }

  root.addEventListener('click', (e) => {
    if (view === 'tutor') return;   // plan.js's tutor view listens for its own
    if (hwClick(e)) return;
    const box = e.target.closest('.day-check');
    if (box) { tick(box); return; }
    const row = e.target.closest('.lrow[data-i]');
    if (row) { tapRow(row); return; }
    const chip = e.target.closest('[data-again]');
    if (chip) {
      // Comprar otra vez: one tap adds it by name.
      hold.touch();
      const s = againRows[Number(chip.dataset.again)];
      if (s && addToList(s.name)) { chip.disabled = true; patched = true; }
      return;
    }
    const sug = e.target.closest('[data-sug]');
    if (sug) { pickSuggestion(Number(sug.dataset.sug)); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'hint-off') dismissHint();
    else if (act.dataset.act === 'retry') start();
    else if (act.dataset.act === 'confirm' || act.dataset.act === 'stop') answerAsk(act);
    else if (act.dataset.act === 'lang') { lang = lang === 'es' ? 'en' : 'es'; renderConfirmOnly(); }
    else if (act.dataset.act === 'back') { e.preventDefault(); backToDay(); }
    else if (act.dataset.act === 'list-retry') { if (outbox) outbox.kick(); pollList(); }
  });
  // No row moves under a finger: the hold starts when the finger comes down on the list.
  root.addEventListener('pointerdown', (e) => {
    if (view === 'list' && hold && e.target.closest('.lrow, .list-chip')) hold.touch();
  });
  root.addEventListener('submit', (e) => {
    const form = e.target.closest('.list-add');
    if (!form) return;
    e.preventDefault();
    submitAdd(form);
  });
  root.addEventListener('input', (e) => { if (e.target.classList.contains('list-input')) showSuggest(e.target.value); });
  // 'toggle' doesn't bubble: listen on the way down.
  root.addEventListener('toggle', (e) => { if (e.target.classList && e.target.classList.contains('list-again')) againOpen = e.target.open; }, true);

  if (tutorMode) { startTutor(); return; }
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

  const outboxReady = makeOutbox();

  window.addEventListener('hashchange', () => {
    if (view === 'loading') return;   // start() draws what the address says
    if (viewFromHash() === 'list') {
      if (canList()) { fromDay = view === 'day' || view === 'problem'; renderList(); }
      else if (state && view !== 'problem') renderDay(true);
      return;
    }
    if (view === 'list' && !state) { start(); return; }   // back from the saved list: try the day again
    if (state && view !== 'problem') render();
  });
  window.addEventListener('focus', refreshSoon);
  window.addEventListener('online', refreshSoon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshSoon(); });
  // The 5-minute refresh is the day view's (and the list's): it never touches a running ring.
  setInterval(() => { if (!HW_VIEWS.has(view)) refreshSoon(); }, REFRESH_MS);
  start();
})();
