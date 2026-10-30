/* =====================================================================
   HOME HUB — private family app: the core
   Sign-in, the shell and router, forms, data access, message helpers and
   toasts. The pages are modules in assets/modules/, loaded after this file;
   each one calls HomeHub.register(...). The core asks the database for its
   schema version and shows only the modules made for that version.
   With a v2 database (schemaVersion >= 2) the core also caches the people,
   the household and its clock, and gives pages the shared v2 pieces in
   HomeHub.core.v2 (formatting in the household time zone, dates, person
   chips, item rows) plus the phone bottom bar, the More and Add sheets.
   ===================================================================== */
(function () {
  'use strict';

  const G = window.HomeGantt;
  const { esc } = G;
  const cfg = window.HOME_HUB_CONFIG || {};
  const app = document.getElementById('app');
  const detailDialog = document.getElementById('detail');
  const formDialog = document.getElementById('formDialog');
  const sheetDialog = document.getElementById('sheet') || document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'sheet', className: 'sheet' }));

  let sb = null;
  let me = null;
  let sessionEmail = null;
  let schemaVersion = null; // from hub_schema_version(); 1 for a database that doesn't have it
  const data = { projects: [], contractors: [], members: [] };
  const modules = [];       // every registered page module, in load order
  let active = [];          // the modules for this database's schema version, in tab order
  let pageAbort = null;     // aborts the signal of the page on screen when it is left
  // v2 caches, loaded at sign-in (see V2 below): every people row (active and inactive), the household
  // row, the household clock { local_date, local_time, tz } (refreshed on every navigation), and the
  // people row of whoever is signed in.
  const cache = { people: [], household: null, clock: null, mePerson: null };

  // ============================================
  // HELPERS
  // ============================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const firstName = (name) => String(name || '').trim().split(/\s+/)[0];
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'item';
  function uniqueKey(base, taken) {
    let key = base;
    for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
    return key;
  }
  const allTasks = (s) => (s.phases || []).flatMap((p) => p.tasks || []);
  const stamp = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const webHref = (url) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);
  const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

  function nextMonday() {
    const t = G.todayNum();
    const wd = ((t + 4) % 7 + 7) % 7;
    return G.toISO(t + ((8 - wd) % 7 || 7));
  }

  function randomToken() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // A short message at the bottom of the screen: toast('Saved') shows for 2 seconds.
  // toast('Done', { action: { label: 'Undo', onClick } }) adds a button and shows for 6 seconds;
  // a newer action toast replaces an older one, and going to another page takes it away (its Undo
  // was for the page left). { ms } changes how long, { error: true } shows it in red for 5 seconds.
  // In v2, toasts stack instead of overlapping. Returns { close() }.
  function toast(msg, opts) {
    const o = opts || {};
    if (!isV2() && !o.action && !o.error) {
      // v1 pages: the plain toast, exactly as it has always been.
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = msg;
      document.body.appendChild(t);
      const timer = setTimeout(() => t.remove(), o.ms || 2000);
      return { close: () => { clearTimeout(timer); t.remove(); } };
    }
    let host = document.querySelector('.toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toasts';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = `toast${o.error ? ' toast-error' : ''}`;
    let timer = null;
    const close = () => { clearTimeout(timer); t.remove(); };
    if (o.action) {
      host.querySelectorAll('.toast-action').forEach((x) => x.remove());
      t.classList.add('toast-action');
      const text = document.createElement('span');
      text.textContent = msg;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-btn';
      btn.textContent = o.action.label || 'Undo';
      btn.addEventListener('click', async () => {
        close();
        try { await o.action.onClick(); } catch (err) { toast(friendly(err), { error: true }); }
      });
      t.append(text, btn);
    } else {
      t.textContent = msg;
    }
    host.appendChild(t);
    timer = setTimeout(close, o.ms || (o.action ? 6000 : o.error ? 5000 : 2000));
    return { close };
  }

  // An Undo belongs to the page it was shown on: leaving the page (or signing out) takes it away.
  function clearActionToasts() {
    document.querySelectorAll('.toasts .toast-action').forEach((t) => t.remove());
  }

  function friendly(err) {
    const msg = (err && (err.message || err.error_description)) || String(err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return "Can't reach the database. Check your internet connection. If it keeps happening, the database may be paused for inactivity (see the README to resume it).";
    }
    if ((err && err.code === 'PGRST301') || /JWT/i.test(msg)) return 'Your sign-in expired. Reload the page to sign in again.';
    if ((err && err.code === '42501') || /row-level security/i.test(msg)) return "You don't have permission to do that.";
    return msg;
  }

  // ============================================
  // DATA
  // ============================================
  async function q(promise) {
    const { data: rows, error } = await promise;
    if (error) throw error;
    return rows;
  }

  // In v2, projects.task_dates is filled in on every read that finds it stale (see TASK DATES)
  // and recomputed on every write that includes the schedule.
  const api = {
    whoami: () => q(sb.rpc('whoami')),
    projects: async () => backfillTaskDates(await q(sb.from('projects').select('*').order('created_at'))),
    async project(id) {
      const row = await q(sb.from('projects').select('*').eq('id', id).maybeSingle());
      return row ? (await backfillTaskDates([row]))[0] : row;
    },
    createProject: (row) => q(sb.from('projects').insert(withTaskDates(row)).select().single()),
    async updateProject(id, patch, expectedUpdatedAt) {
      let query = sb.from('projects').update(withTaskDates(patch)).eq('id', id);
      if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
      const rows = await q(query.select());
      if (!rows.length) throw new Error('Someone else changed this project a moment ago. Reload the page to see the latest version, then try again.');
      return rows[0];
    },
    deleteProject: (id) => q(sb.from('projects').delete().eq('id', id)),
    contractors: () => q(sb.from('contractors').select('*').order('name')),
    saveContractor: (row) => (row.id
      ? q(sb.from('contractors').update(row).eq('id', row.id).select().single())
      : q(sb.from('contractors').insert(row).select().single())),
    deleteContractor: (id) => q(sb.from('contractors').delete().eq('id', id)),
    members: () => q(sb.from('members').select('*').order('created_at')),
    addMember: (row) => q(sb.from('members').insert(row)),
    removeMember: (email) => q(sb.from('members').delete().eq('email', email)),
  };

  // Display copy of a schedule: linked contractors fill in each trade's "who".
  function resolvedSchedule(project) {
    const s = clone(project.schedule || {});
    s.project = s.project || {};
    s.trades = s.trades || {};
    s.phases = s.phases || [];
    Object.values(s.trades).forEach((t) => {
      const c = t.contractor_id && data.contractors.find((x) => x.id === t.contractor_id);
      if (c) t.who = [c.name, c.company].filter(Boolean).join(', ');
    });
    return s;
  }

  function contractorFor(project, tradeKey) {
    const t = project && project.schedule.trades && project.schedule.trades[tradeKey];
    return (t && t.contractor_id && data.contractors.find((x) => x.id === t.contractor_id)) || null;
  }
  const reachable = (c) => !!(c && (c.phone || c.email));

  function contactFor(project, tradeKey) {
    const c = contractorFor(project, tradeKey);
    return c ? { phone: c.phone, email: c.email } : null;
  }

  function shareLink(project, tradeKey) {
    const url = new URL(`share.html?p=${encodeURIComponent(project.share_token)}`, location.href);
    if (tradeKey) url.searchParams.set('trade', tradeKey);
    return url.href;
  }

  function safeModel(project) {
    try { return G.buildModel(resolvedSchedule(project)); } catch (err) { return null; }
  }

  // ============================================
  // TASK DATES (v2)
  // projects.task_dates is the Gantt engine's output, so the database can put project tasks on the
  // calendar and in the morning email without running the engine. A write that changes the schedule
  // without fresh task_dates and task_dates_at makes the database mark them stale (null), as writes
  // from a v1 copy of the site do; reading the projects fills them back in.
  // ============================================
  const isV2 = () => schemaVersion >= 2;

  // [{ id, name, trade, trade_name, start, end, days, status, milestone }], dates as YYYY-MM-DD.
  // days is the task's own length: working days, 7 per calendar week, 0 for a milestone.
  function taskDates(schedule) {
    const M = G.buildModel(schedule);
    return M.items.map((r) => ({
      id: r.id,
      name: r.task.name,
      trade: r.task.trade || null,
      trade_name: (M.trades[r.task.trade] || {}).name || null,
      start: G.toISO(r.start),
      end: G.toISO(r.end),
      days: r.milestone ? 0 : r.task.weeks ? r.task.weeks * 7 : r.task.days,
      status: r.task.status || null,
      milestone: !!r.milestone,
    }));
  }

  // A project row or patch, plus task_dates and task_dates_at when it carries a schedule (v2 only).
  // A schedule the engine can't read is saved with task_dates null (stale) rather than refused.
  function withTaskDates(patch) {
    if (!isV2() || !patch || !('schedule' in patch) || 'task_dates' in patch) return patch;
    let dates = null;
    try { dates = taskDates(patch.schedule); } catch (err) { /* stale until the schedule is fixed */ }
    return Object.assign({}, patch, { task_dates: dates, task_dates_at: new Date().toISOString() });
  }

  // Fill in stale task_dates (v2), quietly: only if nobody changed the project since it was read,
  // and any failure leaves the row as it was. The saved row replaces the old one, so its new
  // updated_at doesn't make the next edit look like someone else's change.
  function backfillTaskDates(rows) {
    if (!isV2()) return rows;
    return Promise.all(rows.map(async (p) => {
      if (!p || p.task_dates !== null || !p.schedule) return p;
      try {
        const patch = { task_dates: taskDates(p.schedule), task_dates_at: new Date().toISOString() };
        const { data: saved, error } = await sb.from('projects').update(patch).eq('id', p.id).eq('updated_at', p.updated_at).select();
        return !error && saved && saved[0] ? saved[0] : p;
      } catch (err) { return p; }
    }));
  }

  // ============================================
  // FORMS (one reusable dialog)
  // field: { name, label, type, value, required, options, help, placeholder, min, showIf, groups, fields }
  // ============================================
  function fieldHTML(f) {
    if (f.type === 'row') return `<div class="field-row">${f.fields.map(fieldHTML).join('')}</div>`;
    const help = f.help ? `<small>${esc(f.help)}</small>` : '';
    const req = f.required ? ' required' : '';
    const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
    const val = f.value == null ? '' : f.value;
    if (f.type === 'checkbox') {
      return `<label class="check" data-field="${f.name}"><input type="checkbox" name="${f.name}"${val ? ' checked' : ''}> ${esc(f.label)}</label>`;
    }
    let control;
    if (f.type === 'textarea') {
      control = `<textarea name="${f.name}"${req}${ph}>${esc(val)}</textarea>`;
    } else if (f.type === 'select') {
      control = `<select name="${f.name}"${req}>${f.options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    } else if (f.type === 'checks') {
      const chosen = new Set(val || []);
      const body = f.groups.filter((g) => g.items.length).map((g) => `${g.label ? `<div class="grp">${esc(g.label)}</div>` : ''}${g.items.map(([v, l]) =>
        `<label><input type="checkbox" name="${f.name}" value="${esc(v)}"${chosen.has(v) ? ' checked' : ''}> ${esc(l)}</label>`).join('')}`).join('');
      return `<div class="field" data-field="${f.name}"><span>${esc(f.label)}</span><div class="checks">${body || '<small>Nothing to choose yet.</small>'}</div>${help}</div>`;
    } else {
      const min = f.min != null ? ` min="${f.min}"` : '';
      control = `<input type="${f.type || 'text'}" name="${f.name}" value="${esc(val)}"${req}${ph}${min}${f.type === 'number' ? ' inputmode="numeric"' : ''}>`;
    }
    return `<label class="field" data-field="${f.name}"><span>${esc(f.label)}</span>${control}${help}</label>`;
  }

  const flatFields = (fields) => fields.flatMap((f) => (f.type === 'row' ? f.fields : [f]));

  function readForm(form, fields) {
    const values = {};
    flatFields(fields).forEach((f) => {
      if (f.type === 'checks') values[f.name] = [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) => i.value);
      else if (f.type === 'checkbox') values[f.name] = form.elements[f.name].checked;
      else values[f.name] = String(form.elements[f.name].value || '').trim();
    });
    return values;
  }

  function wireFormDialog() {
    if (formDialog.dataset.wired) return;
    formDialog.dataset.wired = '1';
    formDialog.addEventListener('click', (e) => {
      if (e.target === formDialog || e.target.closest('[data-close]')) formDialog.close();
    });
  }

  function openForm({ title, intro, fields, submitLabel, onSubmit, extraActions }) {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    const extras = extraActions || [];
    formDialog.innerHTML = `<form class="form d-inner">
      <div class="d-top"><h3>${esc(title)}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      ${intro ? `<p class="meta">${intro}</p>` : ''}
      ${fields.map(fieldHTML).join('')}
      <p class="form-error" hidden></p>
      <div class="form-actions">
        ${extras.map((a, i) => `<button type="button" class="btn ${a.danger ? 'btn-danger' : ''} ${i === 0 ? 'left' : ''}" data-extra="${i}">${esc(a.label)}</button>`).join('')}
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${esc(submitLabel || 'Save')}</button>
      </div>
    </form>`;
    const form = formDialog.querySelector('form');
    const errBox = form.querySelector('.form-error');
    const conditional = flatFields(fields).filter((f) => f.showIf);

    function applyShowIf() {
      const values = readForm(form, fields);
      conditional.forEach((f) => {
        const wrap = form.querySelector(`[data-field="${f.name}"]`);
        const show = f.showIf(values);
        wrap.hidden = !show;
        wrap.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = !show; });
      });
    }
    applyShowIf();
    form.addEventListener('change', applyShowIf);

    const showError = (err) => { errBox.textContent = friendly(err); errBox.hidden = false; };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      errBox.hidden = true;
      try {
        await onSubmit(readForm(form, fields));
        formDialog.close();
      } catch (err) {
        showError(err);
      } finally {
        btn.disabled = false;
      }
    });
    form.querySelectorAll('[data-extra]').forEach((b) => b.addEventListener('click', async () => {
      const action = extras[+b.dataset.extra];
      try {
        const done = await action.onClick(readForm(form, fields));
        if (done !== false) formDialog.close();
      } catch (err) { showError(err); }
    }));
    formDialog.showModal();
    const first = form.querySelector('input:not([type="checkbox"]):not([disabled]), textarea, select');
    if (first && window.innerWidth > 700) first.focus();
  }

  // ============================================
  // MESSAGES
  // Text, WhatsApp, Share and "Open in my email" hand a ready-to-send message to
  // the phone's own apps, so it comes from you and replies come back to you.
  // "Send email now" goes through the send-email function (Resend).
  // ============================================
  function phoneDigits(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    return d.length === 10 ? `1${d}` : d; // ten digits: assume a US number
  }
  const smsHref = (phone, body) => `sms:+${phoneDigits(phone)}?&body=${encodeURIComponent(body)}`;
  const whatsappHref = (phone, body) => `https://wa.me/${phoneDigits(phone)}?text=${encodeURIComponent(body)}`;
  const mailtoHref = (email, subject, body) => `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  // Share opens the phone's share sheet (Web Share) with the same message, for WhatsApp Business or
  // any other app: on an iPhone with both WhatsApps a wa.me link always opens the plain one. Only
  // where the browser has it (phones, and some desktop browsers), and called from the tap itself
  // (a share needs the tap's user activation, which Safari keeps only briefly). One at a time: the
  // browser turns down a second share while the sheet is up (InvalidStateError), so a double tap's
  // second tap does nothing. Closing the share sheet is no error; anything else says so in a toast,
  // or through fail(message) from a dialog, which would cover the toast.
  const canShare = () => typeof navigator.share === 'function';
  let sharing = false; // a share sheet is up (set before the call, which stays inside the tap)
  async function shareText(text, fail) {
    if (sharing) return;
    sharing = true;
    try {
      await navigator.share({ text });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      const msg = 'Couldn\'t open the share menu. Try again, or use WhatsApp or Text.';
      if (fail) fail(msg);
      else toast(msg, { error: true });
    } finally {
      sharing = false;
    }
  }

  const signOff = () => ['', 'Thanks,', firstName(me.name)];

  function messageDialog(contractor, draft, hint) {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    const c = contractor;
    const viaHub = !!(cfg.emailSending && c.email);
    const withShare = !!c.phone && canShare(); // beside WhatsApp
    formDialog.innerHTML = `<div class="form d-inner">
      <div class="d-top"><h3>Message ${esc(c.name)}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <p class="meta">${[c.company, c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</p>
      ${c.email ? `<label class="field"><span>Subject (for email)</span><input type="text" name="subject" value="${esc(draft.subject)}"></label>` : ''}
      <label class="field"><span>Message</span><textarea name="body" rows="9">${esc(draft.body)}</textarea></label>
      ${hint ? `<p class="meta">${hint}</p>` : ''}
      <div class="msg-actions">
        ${c.phone ? '<a class="btn" data-link="sms">Text</a><a class="btn" data-link="whatsapp" target="_blank" rel="noopener">WhatsApp</a>' : ''}
        ${withShare ? '<button type="button" class="btn" data-share aria-label="Share the message with another app">Share</button>' : ''}
        ${c.email ? '<a class="btn" data-link="mail">Open in my email</a>' : ''}
        ${viaHub ? '<button type="button" class="btn btn-primary" data-send>Send email now</button>' : ''}
      </div>
      <p class="form-error" hidden></p>
      <p class="meta">Text, WhatsApp${withShare ? ', Share' : ''} and email open your own apps, so the message comes from you and replies come straight back.${viaHub ? ' "Send email now" sends it from the Home Hub, with your address for replies.' : ''}</p>
    </div>`;
    const body = formDialog.querySelector('[name="body"]');
    const subject = formDialog.querySelector('[name="subject"]');
    const errBox = formDialog.querySelector('.form-error');
    const refresh = () => {
      const text = body.value;
      const subj = subject ? subject.value : draft.subject;
      formDialog.querySelectorAll('[data-link]').forEach((a) => {
        a.href = { sms: () => smsHref(c.phone, text), whatsapp: () => whatsappHref(c.phone, text), mail: () => mailtoHref(c.email, subj, text) }[a.dataset.link]();
      });
    };
    refresh();
    formDialog.querySelector('.form').addEventListener('input', refresh);
    const share = formDialog.querySelector('[data-share]');
    if (share) {
      share.addEventListener('click', () => {
        errBox.hidden = true;
        shareText(body.value, (message) => { errBox.textContent = message; errBox.hidden = false; });
      });
    }
    const send = formDialog.querySelector('[data-send]');
    if (send) {
      send.addEventListener('click', async () => {
        send.disabled = true;
        errBox.hidden = true;
        const { error } = await sb.functions.invoke('send-email', { body: { to: c.email, subject: subject.value, text: body.value } });
        if (!error) { formDialog.close(); toast(`Email sent to ${firstName(c.name)}`); return; }
        let message = error.message;
        try { message = (await error.context.json()).error || message; } catch (e) { /* keep the generic message */ }
        errBox.textContent = message;
        errBox.hidden = false;
        send.disabled = false;
      });
    }
    formDialog.showModal();
  }

  // ============================================
  // V2: PEOPLE, HOUSEHOLD AND CLOCK
  // Loaded once at sign-in (and by v2.refresh()); the clock again on every navigation, because
  // "today" is the household's date from the database, never the device's.
  // ============================================
  async function readClock() {
    const row = await q(sb.rpc('clock'));
    return Array.isArray(row) ? row[0] || null : row;
  }

  async function loadV2() {
    const [people, households, clock] = await Promise.all([
      q(sb.from('people').select('*').order('sort_order').order('name')),
      q(sb.from('household').select('*').limit(1)),
      readClock(),
    ]);
    cache.people = people || [];
    cache.household = (households || [])[0] || null;
    cache.clock = clock;
    const myId = me && me.person && me.person.id;
    const myEmail = String((me && me.email) || sessionEmail || '').toLowerCase();
    cache.mePerson = cache.people.find((p) => p.id === myId)
      || cache.people.find((p) => myEmail && String(p.email || '').toLowerCase() === myEmail) || null;
  }

  function clearV2() {
    cache.people = [];
    cache.household = null;
    cache.clock = null;
    cache.mePerson = null;
  }

  // A failed clock read keeps the last one: the page still shows, and the next navigation tries again.
  async function refreshClock() {
    try { cache.clock = (await readClock()) || cache.clock; } catch (err) { /* keep the last clock */ }
  }

  async function call(name, args) {
    const { data: result, error } = await sb.rpc(name, args || {});
    if (error) throw error;
    return result;
  }

  // ============================================
  // V2: DATES AND TIMES, in the household time zone
  // Dates are 'YYYY-MM-DD' strings; date arithmetic uses whole UTC days (as gantt.js does), so the
  // device's own time zone never shifts a date. Instants (ISO timestamps) are shown in the household zone.
  // ============================================
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const householdTz = () => (cache.household && cache.household.tz) || (cache.clock && cache.clock.tz) || 'America/New_York';

  const zoneFormats = new Map();
  // The household's wall-clock date and time for an instant: { date: 'YYYY-MM-DD', time: 'HH:MM:SS' }.
  function inHousehold(instant) {
    const tz = householdTz();
    let f = zoneFormats.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      zoneFormats.set(tz, f);
    }
    const o = {};
    f.formatToParts(instant).forEach((p) => { o[p.type] = p.value; });
    return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour === '24' ? '00' : o.hour}:${o.minute}:${o.second}` };
  }

  // '16:00:00' stays as it is; an instant becomes the household's wall-clock time. '' if neither.
  function wallTime(x) {
    const s = String(x == null ? '' : x);
    if (/^\d{1,2}:\d{2}/.test(s)) return s;
    const d = s ? new Date(s) : null;
    return d && !isNaN(d) ? inHousehold(d).time : '';
  }
  // '2026-10-27' stays as it is; an instant becomes the household's date that day.
  function wallDate(x) {
    const s = String(x == null ? '' : x);
    if (ISO_DATE.test(s)) return s;
    const d = s ? new Date(s) : null;
    return d && !isNaN(d) ? inHousehold(d).date : '';
  }
  // null for a missing or unreadable date, so the labels below come out empty instead of throwing.
  const dayParts = (iso) => {
    const s = wallDate(iso);
    if (!ISO_DATE.test(s)) return null;
    const n = G.parseDate(s);
    const d = new Date(n * 86400000);
    return { n, weekday: d.getUTCDay(), month: d.getUTCMonth(), day: d.getUTCDate(), year: d.getUTCFullYear() };
  };
  const hourOf = (t) => Number(t.split(':')[0]) % 24; // Postgres allows 24:00:00 (midnight at the end of a day)
  const clockText = (t, meridiem = true) => {
    const h = hourOf(t);
    const m = Number(t.split(':')[1]);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')}${meridiem ? (h < 12 ? 'am' : 'pm') : ''}`;
  };
  const isAm = (t) => hourOf(t) < 12;

  const dates = {
    today: () => (cache.clock && cache.clock.local_date) || inHousehold(new Date()).date,
    addDays: (iso, n) => G.toISO(G.parseDate(iso) + n),
    isoWeekday: (iso) => ((G.parseDate(iso) + 3) % 7 + 7) % 7 + 1, // 1970-01-01 was a Thursday (4)
    mondayOf: (iso) => G.toISO(G.parseDate(iso) - dates.isoWeekday(iso) + 1),
    // Six weeks (Monday to Sunday) covering the month that iso falls in: [[7 dates], … 6 weeks].
    monthGrid(iso) {
      const first = `${String(iso).slice(0, 7)}-01`;
      const start = G.parseDate(dates.mondayOf(first));
      return Array.from({ length: 6 }, (w, i) => Array.from({ length: 7 }, (d, j) => G.toISO(start + i * 7 + j)));
    },
  };

  // An item's end as entered: agenda() rows have local_start / local_end, and end_at is the start plus
  // an hour when nobody entered an end time, so for them only local_end counts. Items with only
  // instants (start_at / end_at) keep end_at.
  const endOf = (it) => (it.local_start ? it.local_end : it.local_end || it.end_at) || null;

  const fmt = {
    time: (x) => { const t = wallTime(x); return t ? clockText(t) : ''; },
    day: (iso) => { const p = dayParts(iso); return p ? `${WEEKDAYS[p.weekday].slice(0, 3)} ${MONTHS[p.month].slice(0, 3)} ${p.day}` : ''; },
    dayLong: (iso) => { const p = dayParts(iso); return p ? `${WEEKDAYS[p.weekday]}, ${MONTHS[p.month]} ${p.day}` : ''; },
    short: (iso) => { const p = dayParts(iso); return p ? `${MONTHS[p.month].slice(0, 3)} ${p.day}` : ''; },
    relDay(iso) {
      const p = dayParts(iso);
      if (!p) return '';
      return { 0: 'Today', 1: 'Tomorrow', '-1': 'Yesterday' }[p.n - G.parseDate(dates.today())] || fmt.day(iso);
    },
    // 'Oct 27–30', or 'Oct 30–Nov 2' across months.
    span(fromIso, toIso) {
      const a = dayParts(fromIso);
      const b = dayParts(toIso);
      if (!a || !b || a.n === b.n) return fmt.short(fromIso);
      return a.month === b.month && a.year === b.year ? `${fmt.short(fromIso)}–${b.day}` : `${fmt.short(fromIso)}–${fmt.short(toIso)}`;
    },
    // The time label for an agenda item: 'All day', 'Oct 27–30', '4:00pm', '4:00–5:00pm', '11:00am–1:00pm'.
    // Only an end time someone entered shows (see endOf).
    range(item) {
      const it = item || {};
      const day = wallDate(it.day || it.start_at);
      const endDay = wallDate(it.end_day) || day;
      const start = it.all_day ? '' : wallTime(it.local_start || it.start_at);
      const end = it.all_day ? '' : wallTime(endOf(it));
      if (!start) return day && endDay > day ? fmt.span(day, endDay) : 'All day';
      if (!end) return clockText(start);
      return isAm(start) === isAm(end) && endDay === day ? `${clockText(start, false)}–${clockText(end)}` : `${clockText(start)}–${clockText(end)}`;
    },
  };

  // ============================================
  // V2: SHARED PIECES (person dots and chips, the who picker, item rows, headings)
  // ============================================
  const COLOR = /^#[0-9a-fA-F]{6}$/;
  const colorOf = (p) => (p && COLOR.test(p.color || '') ? p.color : '#64748b');
  // Dark or white text, whichever contrasts more with the person's colour (WCAG contrast ratio), so
  // the initial on a dot reads on every colour: dark on green, orange and teal, white on blue or red.
  const DARK_INK = '#1f1b16';
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function inkOn(hex) {
    const l = luminance(hex);
    const onWhite = 1.05 / (l + 0.05);
    const onDark = (l + 0.05) / (luminance(DARK_INK) + 0.05);
    return onDark > onWhite ? DARK_INK : '#ffffff';
  }
  const initialOf = (p) => (Array.from(firstName(p.name))[0] || '?').toUpperCase();
  const personById = (id) => cache.people.find((p) => p.id === id) || null;
  // First names, or full names for people who share a first name.
  function shortName(p) {
    const first = firstName(p.name);
    return cache.people.some((x) => x.id !== p.id && firstName(x.name) === first) ? p.name : first;
  }
  const personStyle = (p) => `--pc:${colorOf(p)};--pi:${inkOn(colorOf(p))}`;

  // A small round badge in the person's colour with their initial. { ring: true } marks who's in charge.
  function personDot(person, opts) {
    if (!person) return '';
    const ring = !!(opts && opts.ring);
    const label = `${person.name}${ring ? ', in charge' : ''}`;
    return `<span class="pdot${ring ? ' ring' : ''}" style="${personStyle(person)}" title="${esc(label)}"><span aria-hidden="true">${esc(initialOf(person))}</span><span class="sr-only">${esc(label)}</span></span>`;
  }

  // A tappable chip (a <button>, data-person = id). selected: filled in their colour; ring: in charge.
  function personChip(person, opts) {
    if (!person) return '';
    const o = opts || {};
    const on = !!(o.selected || o.ring);
    return `<button type="button" class="pchip${o.ring ? ' ring' : ''}" data-person="${esc(person.id)}" aria-pressed="${on}" style="${personStyle(person)}">`
      + `<span class="pchip-dot" aria-hidden="true">${esc(initialOf(person))}</span><span class="pchip-name">${esc(shortName(person))}</span>`
      + `${o.ring ? '<span class="pchip-tag">in charge</span>' : ''}</button>`;
  }

  // Who's in charge and who's with them, as people chips in `container`. The first tap puts someone in
  // charge (ring), later taps add people "with" them, and tapping a chosen person again takes them off.
  // Shows active people, plus anyone already chosen. Returns { value(), set({ responsibleId, participantIds }) };
  // value() and onChange(value) give { responsibleId, participantIds }.
  function whoPicker(container, opts) {
    const o = opts || {};
    let responsible = null;
    let withIds = [];
    const value = () => ({ responsibleId: responsible, participantIds: withIds.slice() });
    const set = (v) => {
      responsible = (v && v.responsibleId) || null;
      withIds = [...new Set(((v && v.participantIds) || []).filter((id) => id && id !== responsible))];
      draw();
    };
    const names = (ids) => ids.map(personById).filter(Boolean).map(shortName);
    function draw() {
      const shown = cache.people.filter((p) => p.active !== false || p.id === responsible || withIds.includes(p.id));
      const lead = personById(responsible);
      const others = names(withIds);
      let summary = 'Tap a name to put them in charge. Tap more names for who\'s with them.';
      if (lead || others.length) {
        summary = [lead ? `${shortName(lead)} in charge` : 'Nobody in charge', others.length ? `with ${others.join(', ')}` : '']
          .filter(Boolean).join(' · ') + '. Tap a name again to take them off.';
      }
      container.innerHTML = shown.length
        ? `<div class="who-chips" role="group" aria-label="Who">${shown.map((p) => personChip(p, { ring: p.id === responsible, selected: withIds.includes(p.id) })).join('')}</div>
           <small class="who-hint" aria-live="polite">${esc(summary)}</small>`
        : '<small class="who-hint">No people yet. Add them on the Family page.</small>';
    }
    if (container.whoAbort) container.whoAbort.abort();
    const listening = new AbortController();
    container.whoAbort = listening;
    container.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-person]');
      if (!chip || !container.contains(chip)) return;
      const id = chip.dataset.person;
      if (id === responsible) responsible = null;
      else if (withIds.includes(id)) withIds = withIds.filter((x) => x !== id);
      else if (!responsible) responsible = id;
      else withIds.push(id);
      draw();
      const again = [...container.querySelectorAll('[data-person]')].find((b) => b.dataset.person === id);
      if (again) again.focus();
      if (o.onChange) o.onChange(value());
    }, { signal: listening.signal });
    set({ responsibleId: o.responsibleId, participantIds: o.participantIds });
    return { value, set };
  }

  const ICON = Object.freeze({
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5l2.6.4 1.3 4-1.9 1.5a12 12 0 0 0 6 6l1.5-1.9 4 1.3.4 2.6c.1.9-.6 1.7-1.5 1.8C10.6 19.6 4.4 13.4 4.8 5c.1-.9.9-1.6 1.8-1.5z"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11V9a3 3 0 0 1 3-3h11M15 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H6M9 21l-3-3 3-3"/></svg>',
    today: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5l2 2 3.5-4M3.5 15.5l2 2 3.5-4M12.5 7h8M12.5 16h8"/></svg>',
    page: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M9 9h6M9 13h6"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    // A fork and knife: the Food page (schema 4) in the bottom bar, and Shopping in the Add sheet.
    food: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 3v5a2.5 2.5 0 0 0 5 0V3M8 3v18M17.5 21V3c-2 1.2-3.5 3.8-3.5 7.5V14h3.5"/></svg>',
  });

  // A cancelled day of an event is one someone skipped (Skip this day), so it says so.
  const STATUS_BADGE = { late: 'Late', cancelled: 'Skipped', skipped: 'Skipped', done: 'Done' };

  // One agenda item (an agenda()/late_items()/heads_up() row) as a row element: time column, an
  // optional checkbox, the title and details, who dots, and a call button for a linked contractor.
  // opts: checkbox (show one on open and late tasks, ticked on done ones), showWho (dots), showDate
  // (the day above the time, for lists that span days; late items always show it), onOpen(item, row)
  // when the title is tapped, onToggle(item, row) when the box is ticked, onUntick(item, row) when a
  // ticked box is tapped and they say yes to "Mark … as not done?" (without it, a ticked box is
  // locked). The box shows the new state while the call runs; if it throws or rejects, the box goes
  // back and the error shows in a toast.
  function itemRow(item, opts) {
    const it = item || {};
    const o = opts || {};
    const status = it.status || 'open';
    const isTask = it.kind === 'task';
    const allDay = !!it.all_day || !(it.local_start || it.start_at);
    // Only an all-day item spans days; a timed event that ends after midnight still shows its times.
    const multiDay = allDay && !!(it.end_day && it.day && wallDate(it.end_day) > wallDate(it.day));
    const row = document.createElement('div');
    row.className = `irow st-${status} k-${it.kind || 'item'}`;
    Object.assign(row.dataset, { kind: it.kind || '', id: it.item_id || '', occurrence: it.occurrence || '', status });

    let top;
    let sub = '';
    let untimed = false;
    let isEnd = false; // sub is the end time: a screen reader hears "4:00pm to 5:00pm" (CSS adds a hidden "to")
    if (multiDay) { top = fmt.short(it.day); sub = `– ${fmt.short(it.end_day)}`; }
    else if (allDay) { top = isTask ? 'Any time' : 'All day'; untimed = true; }
    else {
      top = fmt.time(it.local_start || it.start_at);
      if (!isTask && endOf(it)) { sub = fmt.time(endOf(it)); isEnd = true; }
    }
    if ((status === 'late' || o.showDate) && !multiDay && it.day) {
      sub = allDay ? '' : top;
      top = fmt.relDay(it.day);
      untimed = false;
      isEnd = false;
    }

    const resp = personById(it.responsible_id);
    const withPeople = (it.participant_ids || []).map(personById).filter((p) => p && p !== resp);
    const details = [it.kind === 'project' ? it.project_name : null, it.location, it.contractor_name].filter(Boolean);
    const canTick = !!o.checkbox && isTask && (status === 'open' || status === 'late');
    const tickedDone = !!o.checkbox && isTask && status === 'done';
    const canUntick = tickedDone && typeof o.onUntick === 'function';
    const badges = [
      STATUS_BADGE[status] && !tickedDone ? `<span class="badge ${esc(status)}">${STATUS_BADGE[status]}</span>` : '',
      it.changed && status !== 'cancelled' ? '<span class="badge">Changed</span>' : '',
      it.milestone ? '<span class="badge">Milestone</span>' : '',
    ].join('');
    const mainTag = o.onOpen ? 'button type="button"' : 'div';

    row.innerHTML = `
      <div class="irow-time${untimed ? ' untimed' : ''}"><span>${esc(top)}</span>${sub ? `<small${isEnd ? ' class="irow-end"' : ''}>${esc(sub)}</small>` : ''}</div>
      ${canTick || tickedDone ? `<button type="button" class="irow-check" role="checkbox" aria-checked="${tickedDone}"${tickedDone && !canUntick ? ' disabled' : ''} aria-label="Done: ${esc(it.title)}"><span class="irow-box">${ICON.check}</span></button>` : ''}
      <${mainTag} class="irow-main">
        <span class="irow-title">${esc(it.title)}${it.repeating ? `<span class="irow-rep" title="Repeats">${ICON.repeat}<span class="sr-only">, repeats</span></span>` : ''}</span>
        ${details.length || badges ? `<span class="irow-sub">${badges}${details.map(esc).join(' · ')}</span>` : ''}
      </${o.onOpen ? 'button' : 'div'}>
      ${o.showWho && (resp || withPeople.length) ? `<span class="irow-who">${personDot(resp, { ring: true })}${withPeople.map((p) => personDot(p)).join('')}</span>` : ''}
      ${it.contractor_phone ? `<a class="irow-call" href="${esc(telHref(it.contractor_phone))}" aria-label="Call ${esc(it.contractor_name || '')} ${esc(it.contractor_phone)}" title="Call ${esc(it.contractor_phone)}">${ICON.phone}</a>` : ''}`;

    if (o.onOpen) row.querySelector('.irow-main').addEventListener('click', () => o.onOpen(it, row));
    const box = canTick && row.querySelector('.irow-check');
    if (box) {
      box.addEventListener('click', async () => {
        if (box.disabled) return;
        box.disabled = true;
        box.setAttribute('aria-checked', 'true');
        row.classList.add('is-ticked');
        try {
          if (o.onToggle) await o.onToggle(it, row);
        } catch (err) {
          box.disabled = false;
          box.setAttribute('aria-checked', 'false');
          row.classList.remove('is-ticked');
          toast(friendly(err), { error: true });
        }
      });
    }
    const ticked = canUntick && row.querySelector('.irow-check');
    if (ticked) {
      ticked.addEventListener('click', async () => {
        if (ticked.disabled || !window.confirm(`Mark "${it.title}" as not done?`)) return;
        ticked.disabled = true;
        ticked.setAttribute('aria-checked', 'false');
        try {
          await o.onUntick(it, row);
        } catch (err) {
          ticked.setAttribute('aria-checked', 'true');
          toast(friendly(err), { error: true });
        } finally {
          ticked.disabled = false;
        }
      });
    }
    return row;
  }

  // Not done after all, for a done task's row (an agenda row, status 'done'): its task log entry for
  // that day is undone (undo_task; the database allows only a task's latest entry, within 7 days).
  async function undoDone(it) {
    let query = sb.from('task_log').select('id').eq('task_id', it.item_id).eq('status', 'done');
    query = it.occurrence ? query.eq('occurrence', it.occurrence) : query.is('occurrence', null);
    const rows = await q(query.order('created_at', { ascending: false }).limit(1));
    if (!rows || !rows.length) throw new Error("Couldn't find when that was ticked off. Open it on the Tasks page to change it.");
    return call('undo_task', { p_log_id: rows[0].id });
  }

  const sectionHeading = (text, count) => `<h2 class="sec-head"><span>${esc(text)}</span>${count != null ? `<span class="sec-count">${esc(count)}</span>` : ''}</h2>`;

  // ============================================
  // V2: SHEETS (More, Add)
  // One <dialog id="sheet">: a bottom sheet on phones, a small centred dialog on bigger screens.
  // ============================================
  function openSheet(title, bodyHTML) {
    if (detailDialog.open) detailDialog.close();
    if (formDialog.open) formDialog.close();
    if (!sheetDialog.dataset.wired) {
      sheetDialog.dataset.wired = '1';
      sheetDialog.setAttribute('aria-labelledby', 'sheetTitle');
      sheetDialog.addEventListener('click', (e) => {
        if (e.target === sheetDialog || e.target.closest('[data-close]')) sheetDialog.close();
      });
    }
    sheetDialog.innerHTML = `<div class="sheet-inner">
      <div class="d-top"><h3 id="sheetTitle">${esc(title)}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      ${bodyHTML}</div>`;
    if (!sheetDialog.open) sheetDialog.showModal();
    return sheetDialog;
  }
  const closeSheet = () => { if (sheetDialog.open) sheetDialog.close(); };

  // The Food page keeps the shopping list it last saw, and its changes not sent yet, on this device for
  // whoever is signed in (assets/shoplist.js, homehub.shop.hub). It holds locked lines, so it goes when
  // they sign out, before anything else; and again once the page on screen has been closed, in case a
  // change that was still on its way saved it once more.
  const SHOP_KEY = 'homehub.shop.hub';
  function forgetShopping() {
    try { localStorage.removeItem(SHOP_KEY); } catch (err) { /* storage unavailable: nothing was kept */ }
  }

  const signOut = async () => {
    closeSheet();
    forgetShopping();
    try { await sb.auth.signOut(); } catch (err) { toast(friendly(err), { error: true }); }
  };

  // The pages without a place in the bottom bar, and Sign out.
  function openMore() {
    const others = active.filter((m) => m.nav && !m.nav.primary);
    const current = parseRoute();
    const s = openSheet('More', `
      <nav class="sheet-list" aria-label="More pages">${others.map((m) => `<a href="${esc(m.nav.href || `#/${m.name}`)}" data-tab="${esc(m.name)}"${current && current.module === m ? ' aria-current="page"' : ''}>${esc(m.nav.label)}</a>`).join('')}</nav>
      <div class="sheet-foot"><span class="meta">Signed in as ${esc(me ? (cache.mePerson && cache.mePerson.name) || me.name || me.email : '')}</span><button type="button" class="btn" data-act="sign-out">Sign out</button></div>`);
    s.querySelectorAll('.sheet-list a').forEach((a) => a.addEventListener('click', closeSheet));
    s.querySelector('[data-act="sign-out"]').addEventListener('click', signOut);
  }

  // The Food page's one-field "add to the shopping list" dialog, use('food').openListAdd(), or null.
  // Only a database at schema 4 shows the Food page, so only there does the Add sheet offer Shopping.
  function listAdder() {
    try {
      const open = use('food').openListAdd;
      return typeof open === 'function' ? open : null;
    } catch (err) { return null; }
  }

  // The Add sheet: Event or Task (and, on schema 4, Shopping), then that page's form. openAdd('event' |
  // 'task', defaults) and openAdd('shopping') skip the choice. The forms come from the Calendar, Tasks
  // and Food pages: use('calendar').openEventForm(defaults), use('tasks').openTaskForm(defaults),
  // use('food').openListAdd().
  function openAdd(kind, defaults) {
    const start = (k) => {
      closeSheet();
      const [page, fn] = { task: ['tasks', 'openTaskForm'], shopping: ['food', 'openListAdd'] }[k] || ['calendar', 'openEventForm'];
      try {
        const open = use(page)[fn];
        if (typeof open !== 'function') {
          throw new Error(`${k === 'shopping' ? 'Adding to the shopping list' : `Adding ${k}s`} isn't available yet. Reload the page to get the latest version.`);
        }
        Promise.resolve(k === 'shopping' ? open() : open(Object.assign({}, defaults))).catch((err) => toast(friendly(err), { error: true }));
      } catch (err) { toast(friendly(err), { error: true }); }
    };
    if (kind === 'event' || kind === 'task' || kind === 'shopping') { start(kind); return; }
    const shopping = !!listAdder();
    const s = openSheet('Add', `
      <div class="add-switch${shopping ? ' add-three' : ''}" role="group" aria-label="${shopping ? 'Event, task or shopping' : 'Event or task'}">
        <button type="button" class="add-choice" data-add="event">${ICON.calendar}<b>Event</b><small>Happens at a time</small></button>
        <button type="button" class="add-choice" data-add="task">${ICON.tasks}<b>Task</b><small>Gets ticked off</small></button>
        ${shopping ? `<button type="button" class="add-choice" data-add="shopping">${ICON.food}<b>Shopping</b><small>Something to buy</small></button>` : ''}
      </div>
      <p class="meta add-help">Piano, pickups, appointments → Event. Pills, filters, chores, calls → Task.${shopping ? ' Milk, batteries → Shopping.' : ''}</p>`);
    s.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => start(b.dataset.add)));
  }

  // What pages get as HomeHub.core.v2 (meaningful once schemaVersion >= 2).
  const v2 = Object.freeze({
    people: () => cache.people.slice(),
    person: (id) => personById(id),
    get mePerson() { return cache.mePerson; },
    get household() { return cache.household; },
    get clock() { return cache.clock; },
    // Reload people, household and clock, e.g. after saving a person or the settings.
    refresh: () => loadV2(),
    call,
    undoDone,
    fmt: Object.freeze(fmt),
    dates: Object.freeze(dates),
    ui: Object.freeze({ personDot, personChip, whoPicker, itemRow, sectionHeading, icon: ICON }),
  });

  // ============================================
  // SIGN-IN
  // ============================================
  function readLinkError() {
    const raw = location.hash.slice(1) || location.search.slice(1);
    const p = new URLSearchParams(raw);
    if (!p.get('error') && !p.get('error_description')) return null;
    history.replaceState(null, '', location.pathname);
    if (p.get('error_code') === 'otp_expired') return 'That sign-in link has expired or was already used, sometimes by an email security scanner. Send yourself a new code and type it in.';
    return p.get('error_description') || 'That sign-in link did not work. Send yourself a new code and type it in.';
  }

  const CANT_SIGN_IN = "That email can't sign in yet. Ask whoever runs the Home Hub to tick 'Can sign in' for you on the Family page.";

  function loginError(error) {
    const msg = error.message || '';
    if (error.status === 429 || /rate limit|too many/i.test(msg)) return 'Too many sign-in emails were sent recently. Wait a few minutes and try again.';
    // The signup hook refuses anyone without a sign-in, including someone on the Family page whose
    // "Can sign in" isn't ticked, so say what to ask for.
    if (/family list|signups not allowed|not allowed/i.test(msg) || error.status === 403) return CANT_SIGN_IN;
    if (error.status >= 500 || /sending .*email/i.test(msg)) return "The sign-in email couldn't be sent. Try again in a minute. If it keeps happening, the hub's email setup needs checking.";
    return msg || 'Could not send the sign-in email. Try again.';
  }

  function codeError(error) {
    const msg = error.message || '';
    if (error.status === 429 || /rate limit|too many/i.test(msg)) return 'Too many tries. Wait a few minutes, then send yourself a new code.';
    return "That code didn't work. Check you typed the newest one, or send a new code. Each code works once.";
  }

  // Sign-in is by a code typed from the email. Email security scanners (Outlook's, for one) open
  // links in new mail, which uses up a one-time sign-in link and the code that goes with it.
  // Remember who is waiting for a code, so switching to the mail app and back doesn't lose it.
  const PENDING_KEY = 'homehub.pendingSignIn';
  const CODE_LIFETIME = 60 * 60 * 1000;
  function pendingSignIn() {
    try {
      const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
      return p && p.email && Date.now() - p.at < CODE_LIFETIME ? p.email : null;
    } catch (e) { return null; }
  }
  function setPendingSignIn(email) {
    try {
      if (email) localStorage.setItem(PENDING_KEY, JSON.stringify({ email, at: Date.now() }));
      else localStorage.removeItem(PENDING_KEY);
    } catch (e) { /* storage unavailable: the code form just won't survive a reload */ }
  }

  // The signed-out screens replace the whole shell, so the v2 bottom bar and its sheet go too.
  function leaveShell() {
    document.body.classList.remove('has-bottombar');
    closeSheet();
    clearActionToasts();
  }

  function renderLogin(message) {
    destroyView();
    leaveShell();
    app.innerHTML = `<div class="login-wrap"><div class="login">
      <p class="eyebrow">Family only</p>
      <h1>Home Hub</h1>
      <p class="login-lead">Your family's calendar, jobs and projects in one place.</p>
      ${message ? `<p class="form-error">${esc(message)}</p>` : ''}
      <form class="form" id="loginForm">
        <label class="field"><span>Your email</span>
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.com"></label>
        <button class="btn btn-primary" type="submit">Email me a sign-in code</button>
      </form>
      <form class="form" id="codeForm" hidden>
        <p class="ok" id="codeSent"></p>
        <label class="field"><span>Sign-in code</span>
          <input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,12}" maxlength="12" size="10" placeholder="123456"></label>
        <button class="btn btn-primary" type="submit">Sign in</button>
        <button class="linkbtn" type="button" id="restart">Use a different email or send a new code</button>
      </form>
      <div id="loginMsg"></div>
      <p class="note">No password needed. You stay signed in on this device.</p>
    </div></div>`;
    const loginForm = $('#loginForm');
    const codeForm = $('#codeForm');
    let email = '';
    const askForCode = (address) => {
      email = address;
      $('#codeSent').innerHTML = `We emailed a sign-in code to <strong>${esc(email)}</strong>. Type it below.`;
      loginForm.hidden = true;
      codeForm.hidden = false;
      codeForm.code.focus();
    };
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      email = loginForm.email.value.trim().toLowerCase();
      const btn = loginForm.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      $('#loginMsg').innerHTML = '';
      let error;
      try {
        ({ error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } }));
      } catch (err) { error = err; }
      btn.disabled = false;
      btn.textContent = 'Email me a sign-in code';
      if (error) {
        $('#loginMsg').innerHTML = `<p class="form-error">${esc(loginError(error))}</p>`;
        return;
      }
      setPendingSignIn(email);
      askForCode(email);
    });
    codeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = codeForm.code.value.replace(/\D/g, '');
      const btn = codeForm.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      $('#loginMsg').innerHTML = '';
      let error;
      try {
        ({ error } = await sb.auth.verifyOtp({ email, token, type: 'email' }));
      } catch (err) { error = err; }
      // On success the auth listener replaces this screen.
      if (!error) { setPendingSignIn(null); return; }
      btn.disabled = false;
      btn.textContent = 'Sign in';
      $('#loginMsg').innerHTML = `<p class="form-error">${esc(codeError(error))}</p>`;
    });
    $('#restart').addEventListener('click', () => {
      setPendingSignIn(null);
      codeForm.reset();
      codeForm.hidden = true;
      loginForm.hidden = false;
      $('#loginMsg').innerHTML = '';
      loginForm.email.focus();
    });
    const pending = pendingSignIn();
    if (pending) {
      loginForm.email.value = pending;
      askForCode(pending);
    }
  }

  function renderNotListed(email) {
    destroyView();
    leaveShell();
    app.innerHTML = `<div class="login-wrap"><div class="login">
      <h1>Not on the list yet</h1>
      <p>You're signed in as <strong>${esc(email)}</strong>, but that email can't use the Home Hub yet.</p>
      <p>Ask whoever runs the Home Hub to tick 'Can sign in' for you on the Family page, then reload.</p>
      <div class="form-actions"><button class="btn" id="signOut">Sign out</button><button class="btn btn-primary" onclick="location.reload()">Reload</button></div>
    </div></div>`;
    $('#signOut').addEventListener('click', () => sb.auth.signOut());
  }

  function renderMessage(title, body) {
    leaveShell();
    app.innerHTML = `<div class="login-wrap"><div class="login"><h1>${esc(title)}</h1><p>${body}</p></div></div>`;
  }

  async function onSession(session, linkError) {
    if (!session) {
      me = null;
      sessionEmail = null;
      clearV2();
      renderLogin(linkError);   // closes the page on screen (its ctx.signal aborts)
      forgetShopping();
      return;
    }
    setPendingSignIn(null);
    // Supabase can report the same sign-in twice (initial session, then signed in); load once.
    if (session.user.email === sessionEmail) return;
    sessionEmail = session.user.email;
    app.innerHTML = '<div class="loading">Loading…</div>';
    try {
      me = await api.whoami();
      // Which pages to show depends on the database's schema version.
      if (me) activate(await readSchemaVersion());
      // v2: the people, household and clock every page uses.
      if (me && isV2()) await loadV2();
    } catch (err) {
      me = null;
      sessionEmail = null;
      clearV2();
      renderMessage('Something went wrong', esc(friendly(err)));
      return;
    }
    if (!me) { renderNotListed(session.user.email); return; }
    // v2: signing in with a code proves the email address, so it counts as confirmed for the morning
    // email. Best effort: a failure here must not get in the way.
    if (isV2()) sb.rpc('mark_signed_in').then(() => {}, () => {});
    renderShell();
    route();
  }

  // ============================================
  // MODULES & SCHEMA VERSION
  // A page module registers itself with
  //   HomeHub.register({ name, schema: { min, max }, nav: { label, order, href, primary },
  //                      match(parts) → params | null, render(main, ctx), provides })
  // and is shown only when the database's schema version is within min..max.
  //   name      lowercase id; also the tab's data-tab. Two modules may share a name only
  //             if their schema ranges don't overlap (e.g. a v1 and a v2 Family page).
  //   nav       optional tab: label, order (left to right), href (default "#/<name>"),
  //             primary (v2: also in the phone bottom bar; the other tabs go in its More sheet).
  //   match     gets the hash split on "/" ("#/projects/abc" → ["projects", "abc"]) and returns
  //             the page's params, or null if the address isn't this page's.
  //   render    async; ctx = { seq, params, signal, stale() }. signal aborts when the page is
  //             left (navigation or sign-out): tear down with signal.addEventListener('abort', …)
  //             or pass { signal } to addEventListener. stale() is true once the page is left.
  //   provides  optional functions other pages may use: HomeHub.core.use(name).
  // ============================================
  function register(def) {
    const d = def || {};
    const valid = typeof d.name === 'string' && /^[a-z][a-z0-9-]*$/.test(d.name)
      && !!d.schema && Number.isInteger(d.schema.min) && Number.isInteger(d.schema.max) && d.schema.min <= d.schema.max
      && (!d.nav || (typeof d.nav.label === 'string' && Number.isFinite(d.nav.order)))
      && typeof d.match === 'function' && typeof d.render === 'function';
    if (!valid) throw new Error(`HomeHub.register(${JSON.stringify(d.name)}): needs a lowercase name, schema { min, max }, match(parts) and render(main, ctx), and nav { label, order } if it has a tab.`);
    const clash = modules.find((m) => m.name === d.name && m.schema.min <= d.schema.max && d.schema.min <= m.schema.max);
    if (clash) throw new Error(`HomeHub.register: two "${d.name}" modules for the same schema version.`);
    modules.push(d);
  }

  // The modules for this schema version, in tab order (modules without a tab go last).
  function activate(version) {
    schemaVersion = version;
    const order = (m) => (m.nav ? m.nav.order : Number.MAX_SAFE_INTEGER);
    active = modules.filter((m) => m.schema.min <= version && version <= m.schema.max).sort((a, b) => order(a) - order(b));
  }

  // Another page's shared pieces, e.g. use('projects').newProjectForm. Only pages shown for this
  // schema version are available, so call it while rendering, not when the module loads.
  function use(name) {
    const m = active.find((x) => x.name === name);
    if (!m) throw new Error(`The ${name} page isn't available. Reload the page to get the latest version.`);
    return m.provides || {};
  }

  // Today's database (v1) has no hub_schema_version(), so "function not found" means version 1.
  // No answer at all (status 0: the connection dropped just after whoami worked) also means the v1
  // pages, so sign-in isn't blocked; they work on either database, as the v2 migration only adds.
  // An error the database answers with (a 500, say) is reported like any other.
  async function readSchemaVersion() {
    const { data: version, error, status } = await sb.rpc('hub_schema_version');
    if (error) {
      if (error.code === 'PGRST202' || status === 404 || /Could not find the function/i.test(error.message || '')) return 1;
      if (!status) { console.warn('Could not read the schema version, so showing the v1 pages:', error.message); return 1; }
      throw error;
    }
    return typeof version === 'number' ? version : 1;
  }

  // ============================================
  // SHELL & ROUTING
  // ============================================
  function renderShell() {
    if (isV2()) { renderShellV2(); return; }
    const tabs = active.filter((m) => m.nav).map((m) =>
      `<a href="${esc(m.nav.href || `#/${m.name}`)}" data-tab="${esc(m.name)}">${esc(m.nav.label)}</a>`).join('\n          ');
    app.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#/">Home Hub</a>
        <nav class="tabs" aria-label="Sections">
          ${tabs}
        </nav>
      </div></header>
      <main class="page" id="main"></main>`;
  }

  // v2: top tabs on bigger screens; under 640px a bottom bar with the primary pages, ＋ (the Add
  // sheet) in the middle, and More (the other pages and Sign out). CSS picks which one shows.
  // Schema 2 and 3: Today · Calendar · ＋ · Tasks · More; schema 4 adds Food: Today · Calendar · ＋ ·
  // Tasks · Food · More.
  function renderShellV2() {
    const navs = active.filter((m) => m.nav);
    const href = (m) => esc(m.nav.href || `#/${m.name}`);
    const primary = navs.filter((m) => m.nav.primary);
    const half = Math.ceil(primary.length / 2);
    const barLink = (m) => `<a href="${href(m)}" data-tab="${esc(m.name)}">${ICON[m.name] || ICON.page}<span>${esc(m.nav.label)}</span></a>`;
    app.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#/">Home Hub</a>
        <nav class="tabs" aria-label="Sections">
          ${navs.map((m) => `<a href="${href(m)}" data-tab="${esc(m.name)}">${esc(m.nav.label)}</a>`).join('\n          ')}
        </nav>
        <span class="topbar-end">
          <button type="button" class="btn btn-sm" data-shell="add">${ICON.plus}Add</button>
          <button type="button" class="btn btn-sm" data-shell="sign-out">Sign out</button>
        </span>
      </div></header>
      <main class="page" id="main"></main>
      <nav class="bottombar" aria-label="Main">
        ${primary.slice(0, half).map(barLink).join('')}
        <button type="button" class="bb-add" data-shell="add" aria-label="${listAdder() ? 'Add an event, a task or shopping' : 'Add an event or task'}">${ICON.plus}</button>
        ${primary.slice(half).map(barLink).join('')}
        <button type="button" class="bb-more" data-shell="more" aria-haspopup="dialog">${ICON.more}<span>More</span></button>
      </nav>`;
    const actions = { add: () => openAdd(), more: openMore, 'sign-out': signOut };
    app.querySelectorAll('[data-shell]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.shell]()));
    document.body.classList.add('has-bottombar');
  }

  // The page for the current address: the first module (in tab order) whose match() accepts it.
  // An address no page claims shows the first page ("#/"), as it always has.
  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = /access_token=|error=/.test(h) ? [] : h.split('/').filter(Boolean).map(decodeURIComponent);
    const find = (p) => {
      for (const m of active) {
        const params = m.match(p);
        if (params) return { module: m, params };
      }
      return null;
    };
    return find(parts) || find([]);
  }

  // Leaving a page aborts its signal, so it can tear down what it set up (a Gantt view, listeners).
  function destroyView() {
    if (pageAbort) pageAbort.abort();
    pageAbort = null;
  }

  // Each navigation gets a number; a slower, older page load must not overwrite a newer one.
  let routeSeq = 0;
  const stale = (seq) => seq !== routeSeq;

  async function route() {
    if (!me || !$('#main')) return;
    const seq = ++routeSeq;
    const r = parseRoute();
    const tab = r ? r.module.name : null;
    document.querySelectorAll('.tabs a, .bottombar a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
    // v2 phones: More stands for the page on screen when that page isn't in the bottom bar.
    const more = $('.bb-more');
    if (more) more.classList.toggle('is-current', !!(r && r.module.nav && !r.module.nav.primary));
    destroyView();
    if (detailDialog.open) detailDialog.close();
    if (formDialog.open) formDialog.close();
    closeSheet();
    const main = $('#main');
    main.onclick = null;
    main.innerHTML = '<div class="loading">Loading…</div>';
    window.scrollTo(0, 0);
    if (!r) {
      // Only when no page is made for this database's version: the site files are older than the database.
      main.innerHTML = '<div class="card empty-state"><p>This copy of the Home Hub doesn\'t match the database yet. Reload the page to get the latest version.</p></div>';
      return;
    }
    const controller = new AbortController();
    pageAbort = controller;
    const ctx = { seq, params: r.params, signal: controller.signal, stale: () => stale(seq) || controller.signal.aborted };
    // v2: the household's date and time as of this navigation (past midnight, "today" moves on).
    if (isV2()) {
      await refreshClock();
      if (ctx.stale()) return;
    }
    try {
      await r.module.render(main, ctx);
    } catch (err) {
      if (stale(seq)) return;
      main.innerHTML = `<div class="banner banner-error">${esc(friendly(err))}</div>`;
      console.error(err);
    }
  }

  // ============================================
  // START
  // ============================================
  function boot() {
    if (!cfg.supabaseUrl || !cfg.supabaseKey) {
      renderMessage('Almost ready', 'The Home Hub isn\'t connected to its database yet. Follow the setup steps in the README, then reload.');
      return;
    }
    if (!window.supabase || !G) {
      renderMessage('Could not load', 'Part of the page did not load. Check your internet connection and reload.');
      return;
    }
    const linkError = readLinkError();
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    // Don't call Supabase inside this callback (the docs warn it can deadlock); defer instead.
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED') return;
      setTimeout(() => onSession(session, linkError), 0);
    });
    // A new address is another page (or another day or item on it): an Undo from the last one goes.
    // A page drawing itself again (core.route()) keeps it.
    window.addEventListener('hashchange', () => { clearActionToasts(); route(); });
  }

  // What page modules get. See MODULES & SCHEMA VERSION above for register().
  window.HomeHub = Object.freeze({
    register,
    core: Object.freeze({
      G, esc, cfg, detailDialog, formDialog,
      get sb() { return sb; },
      get me() { return me; },
      get schemaVersion() { return schemaVersion; },
      data, api, q,
      $, clone, firstName, slug, uniqueKey, allTasks, stamp, webHref, telHref, nextMonday, randomToken, toast, friendly,
      resolvedSchedule, contractorFor, reachable, contactFor, shareLink, safeModel,
      openForm, wireFormDialog,
      phoneDigits, smsHref, whatsappHref, mailtoHref, canShare, shareText, signOff, messageDialog,
      route, stale, use,
      // v2 (schemaVersion >= 2): caches, formatting, dates and shared pieces; the Add sheet.
      v2, openAdd, taskDates,
    }),
  });

  // The page modules load after this file: start once the page has been parsed, so they have all registered.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
