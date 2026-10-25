/* =====================================================================
   HOME HUB — private family app: the core
   Sign-in, the shell and router, forms, data access, message helpers and
   toasts. The pages are modules in assets/modules/, loaded after this file;
   each one calls HomeHub.register(...). The core asks the database for its
   schema version and shows only the modules made for that version.
   ===================================================================== */
(function () {
  'use strict';

  const G = window.HomeGantt;
  const { esc } = G;
  const cfg = window.HOME_HUB_CONFIG || {};
  const app = document.getElementById('app');
  const detailDialog = document.getElementById('detail');
  const formDialog = document.getElementById('formDialog');

  let sb = null;
  let me = null;
  let sessionEmail = null;
  let schemaVersion = null; // from hub_schema_version(); 1 for a database that doesn't have it
  const data = { projects: [], contractors: [], members: [] };
  const modules = [];       // every registered page module, in load order
  let active = [];          // the modules for this database's schema version, in tab order
  let pageAbort = null;     // aborts the signal of the page on screen when it is left

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

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2000);
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

  const api = {
    whoami: () => q(sb.rpc('whoami')),
    projects: () => q(sb.from('projects').select('*').order('created_at')),
    project: (id) => q(sb.from('projects').select('*').eq('id', id).maybeSingle()),
    createProject: (row) => q(sb.from('projects').insert(row).select().single()),
    async updateProject(id, patch, expectedUpdatedAt) {
      let query = sb.from('projects').update(patch).eq('id', id);
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
  // Text, WhatsApp and "Open in my email" hand a ready-to-send message to the
  // phone's own apps, so it comes from you and replies come back to you.
  // "Send email now" goes through the send-email function (Resend).
  // ============================================
  function phoneDigits(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    return d.length === 10 ? `1${d}` : d; // ten digits: assume a US number
  }
  const smsHref = (phone, body) => `sms:+${phoneDigits(phone)}?&body=${encodeURIComponent(body)}`;
  const whatsappHref = (phone, body) => `https://wa.me/${phoneDigits(phone)}?text=${encodeURIComponent(body)}`;
  const mailtoHref = (email, subject, body) => `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const signOff = () => ['', 'Thanks,', firstName(me.name)];

  function messageDialog(contractor, draft, hint) {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    const c = contractor;
    const viaHub = !!(cfg.emailSending && c.email);
    formDialog.innerHTML = `<div class="form d-inner">
      <div class="d-top"><h3>Message ${esc(c.name)}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <p class="meta">${[c.company, c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</p>
      ${c.email ? `<label class="field"><span>Subject (for email)</span><input type="text" name="subject" value="${esc(draft.subject)}"></label>` : ''}
      <label class="field"><span>Message</span><textarea name="body" rows="9">${esc(draft.body)}</textarea></label>
      ${hint ? `<p class="meta">${hint}</p>` : ''}
      <div class="msg-actions">
        ${c.phone ? '<a class="btn" data-link="sms">Text</a><a class="btn" data-link="whatsapp" target="_blank" rel="noopener">WhatsApp</a>' : ''}
        ${c.email ? '<a class="btn" data-link="mail">Open in my email</a>' : ''}
        ${viaHub ? '<button type="button" class="btn btn-primary" data-send>Send email now</button>' : ''}
      </div>
      <p class="form-error" hidden></p>
      <p class="meta">Text, WhatsApp and email open your own apps, so the message comes from you and replies come straight back.${viaHub ? ' "Send email now" sends it from the Home Hub, with your address for replies.' : ''}</p>
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

  function loginError(error) {
    const msg = error.message || '';
    if (error.status === 429 || /rate limit|too many/i.test(msg)) return 'Too many sign-in emails were sent recently. Wait a few minutes and try again.';
    if (/family list|signups not allowed|not allowed/i.test(msg) || error.status === 403) return "That email isn't on the family list. Ask a family admin to add you.";
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

  function renderLogin(message) {
    destroyView();
    app.innerHTML = `<div class="login-wrap"><div class="login">
      <p class="eyebrow">Family only</p>
      <h1>Home Hub</h1>
      <p>Projects, contractors and plans for the house, in one place.</p>
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
    app.innerHTML = `<div class="login-wrap"><div class="login">
      <h1>Not on the list yet</h1>
      <p>You're signed in as <strong>${esc(email)}</strong>, but that email isn't on the family list.</p>
      <p>Ask a family admin to add you on the Family page, then reload.</p>
      <div class="form-actions"><button class="btn" id="signOut">Sign out</button><button class="btn btn-primary" onclick="location.reload()">Reload</button></div>
    </div></div>`;
    $('#signOut').addEventListener('click', () => sb.auth.signOut());
  }

  function renderMessage(title, body) {
    app.innerHTML = `<div class="login-wrap"><div class="login"><h1>${esc(title)}</h1><p>${body}</p></div></div>`;
  }

  async function onSession(session, linkError) {
    if (!session) {
      me = null;
      sessionEmail = null;
      renderLogin(linkError);
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
    } catch (err) {
      me = null;
      sessionEmail = null;
      renderMessage('Something went wrong', esc(friendly(err)));
      return;
    }
    if (!me) { renderNotListed(session.user.email); return; }
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
  //             primary (reserved for the phone bottom bar).
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
    document.querySelectorAll('.tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
    destroyView();
    if (detailDialog.open) detailDialog.close();
    if (formDialog.open) formDialog.close();
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
    window.addEventListener('hashchange', route);
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
      phoneDigits, smsHref, whatsappHref, mailtoHref, signOff, messageDialog,
      route, stale, use,
    }),
  });

  // The page modules load after this file: start once the page has been parsed, so they have all registered.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
