/* =====================================================================
   HOME HUB — private family app
   Sign-in, home dashboard, projects (with editable Gantt schedules),
   contractor directory and the family member list.
   ===================================================================== */
(function () {
  'use strict';

  const G = window.HomeGantt;
  const { esc, fmt, fmtShort, plural } = G;
  const cfg = window.HOME_HUB_CONFIG || {};
  const app = document.getElementById('app');
  const detailDialog = document.getElementById('detail');
  const formDialog = document.getElementById('formDialog');

  const STATUSES = [['active', 'Active'], ['planning', 'Planning'], ['idea', 'Idea'], ['on-hold', 'On hold'], ['done', 'Done']];
  const STATUS_LABEL = Object.fromEntries(STATUSES);
  const TASK_STATUSES = [['', 'Planned'], ['in-progress', 'In progress'], ['done', 'Done'], ['delayed', 'Delayed']];
  const PALETTE = ['#9333ea', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#db2777', '#b91c1c', '#92622f', '#64748b'];

  let sb = null;
  let me = null;
  let sessionEmail = null;
  let view = null;     // the Gantt view on a project page
  let current = null;  // the project row being viewed
  const data = { projects: [], contractors: [], members: [] };

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
  // "Send email now" goes through the send-email function (SendGrid).
  // ============================================
  function phoneDigits(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    return d.length === 10 ? `1${d}` : d; // ten digits: assume a US number
  }
  const smsHref = (phone, body) => `sms:+${phoneDigits(phone)}?&body=${encodeURIComponent(body)}`;
  const whatsappHref = (phone, body) => `https://wa.me/${phoneDigits(phone)}?text=${encodeURIComponent(body)}`;
  const mailtoHref = (email, subject, body) => `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const signOff = () => ['', 'Thanks,', firstName(me.name)];

  // The contractor's remaining dates on this project, plus the live link if sharing is on.
  function scheduleMessage(project, tradeKey, contractor) {
    const M = view && view.model;
    const tasks = M && !M.empty
      ? M.items.filter((r) => r.task.trade === tradeKey && r.task.status !== 'done' && !r.milestone).sort((a, b) => a.start - b.start)
      : [];
    const lines = [`Hi ${firstName(contractor.name)},`, ''];
    if (tasks.length) {
      lines.push(`Here are your dates for the ${project.name}:`);
      tasks.forEach((r) => lines.push(`• ${r.task.name}: ${G.rangeLong(r)}`));
    } else {
      lines.push(`Following up about the ${project.name}.`);
    }
    if (project.sharing_enabled) lines.push('', `The live schedule is here: ${shareLink(project, tradeKey)}`);
    return { subject: `${project.name}: your schedule`, body: lines.concat(signOff()).join('\n') };
  }

  function taskMessage(project, r, contractor) {
    const lines = [`Hi ${firstName(contractor.name)},`, '',
      `Checking in about "${r.task.name}" for the ${project.name}, scheduled for ${G.rangeLong(r)}.`];
    if (project.sharing_enabled) lines.push('', `The live schedule is here: ${shareLink(project, r.task.trade)}`);
    return { subject: `${project.name}: ${r.task.name}`, body: lines.concat(signOff()).join('\n') };
  }

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

  const sharingHint = (project) => (project.sharing_enabled ? '' : 'Tip: turn on sharing (Share button) to include a link to the live schedule.');

  // ============================================
  // SIGN-IN
  // ============================================
  function readLinkError() {
    const raw = location.hash.slice(1) || location.search.slice(1);
    const p = new URLSearchParams(raw);
    if (!p.get('error') && !p.get('error_description')) return null;
    history.replaceState(null, '', location.pathname);
    if (p.get('error_code') === 'otp_expired') return 'That sign-in link has expired or was already used. Send yourself a new one.';
    return p.get('error_description') || 'That sign-in link did not work. Send yourself a new one.';
  }

  function loginError(error) {
    const msg = error.message || '';
    if (error.status === 429 || /rate limit|too many/i.test(msg)) return 'Too many sign-in emails were sent recently. Wait a few minutes and try again.';
    if (/family list|signups not allowed|not allowed/i.test(msg) || error.status === 403) return "That email isn't on the family list. Ask a family admin to add you.";
    return msg || 'Could not send the sign-in email. Try again.';
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
        <button class="btn btn-primary" type="submit">Email me a sign-in link</button>
      </form>
      <div id="loginMsg"></div>
      <p class="note">No password needed. The link signs you in on this device, and you stay signed in.</p>
    </div></div>`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = e.target.email.value.trim().toLowerCase();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      let error;
      try {
        ({ error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } }));
      } catch (err) { error = err; }
      btn.disabled = false;
      btn.textContent = 'Email me a sign-in link';
      $('#loginMsg').innerHTML = error
        ? `<p class="form-error">${esc(loginError(error))}</p>`
        : `<p class="ok">Check <strong>${esc(email)}</strong> for a sign-in link. Each link works once.</p>`;
    });
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
    // Supabase can report the same sign-in twice (initial session, then signed in); load once.
    if (session.user.email === sessionEmail) return;
    sessionEmail = session.user.email;
    app.innerHTML = '<div class="loading">Loading…</div>';
    try {
      me = await api.whoami();
    } catch (err) {
      sessionEmail = null;
      renderMessage('Something went wrong', esc(friendly(err)));
      return;
    }
    if (!me) { renderNotListed(session.user.email); return; }
    renderShell();
    route();
  }

  // ============================================
  // SHELL & ROUTING
  // ============================================
  function renderShell() {
    app.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#/">Home Hub</a>
        <nav class="tabs" aria-label="Sections">
          <a href="#/" data-tab="home">Home</a>
          <a href="#/projects" data-tab="projects">Projects</a>
          <a href="#/contractors" data-tab="contractors">Contractors</a>
          <a href="#/family" data-tab="family">Family</a>
        </nav>
      </div></header>
      <main class="page" id="main"></main>`;
  }

  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    if (/access_token=|error=/.test(h)) return { name: 'home' };
    const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'projects' && parts[1]) return { name: 'project', id: parts[1], task: parts[2] === 'task' ? parts[3] : null };
    if (['projects', 'contractors', 'family'].includes(parts[0])) return { name: parts[0] };
    return { name: 'home' };
  }

  function destroyView() {
    if (view) view.destroy();
    view = null;
    current = null;
  }

  // Each navigation gets a number; a slower, older page load must not overwrite a newer one.
  let routeSeq = 0;
  const stale = (seq) => seq !== routeSeq;

  async function route() {
    if (!me || !$('#main')) return;
    const seq = ++routeSeq;
    const r = parseRoute();
    const tab = r.name === 'project' ? 'projects' : r.name;
    document.querySelectorAll('.tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
    destroyView();
    if (detailDialog.open) detailDialog.close();
    if (formDialog.open) formDialog.close();
    const main = $('#main');
    main.onclick = null;
    main.innerHTML = '<div class="loading">Loading…</div>';
    window.scrollTo(0, 0);
    try {
      if (r.name === 'home') await renderHome(main, seq);
      else if (r.name === 'projects') await renderProjects(main, seq);
      else if (r.name === 'project') await renderProject(main, seq, r.id, r.task);
      else if (r.name === 'contractors') await renderContractors(main, seq);
      else if (r.name === 'family') await renderFamily(main, seq);
    } catch (err) {
      if (stale(seq)) return;
      main.innerHTML = `<div class="banner banner-error">${esc(friendly(err))}</div>`;
      console.error(err);
    }
  }

  // ============================================
  // HOME
  // ============================================
  function projectCard(p, M) {
    let foot;
    if (M && !M.empty) {
      const s = G.summarize(M);
      foot = `<div class="progress"><span style="width:${s.pct}%"></span></div>
        <div class="pcard-foot"><span>${s.pct}% done · finishes ${fmtShort(M.finish)}</span>${s.behind ? `<span class="bad">${s.behind} behind</span>` : ''}</div>`;
    } else {
      foot = `<div class="pcard-foot solo"><span${M ? '' : ' class="bad"'}>${M ? 'No tasks yet' : 'Schedule needs attention'}</span></div>`;
    }
    return `<a class="pcard" href="#/projects/${encodeURIComponent(p.id)}">
      <div class="pcard-top"><h3>${esc(p.name)}</h3><span class="pill st-${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status)}</span></div>
      ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}${foot}</a>`;
  }

  const emptyProjects = () => `<div class="card empty-state"><p>No projects yet. Start with whatever is on your mind: the kitchen, the pool, the sprinklers.</p>
    <button class="btn btn-primary" data-act="new-project">+ New project</button></div>`;

  async function renderHome(main, seq) {
    const [projects, contractors] = await Promise.all([api.projects(), api.contractors()]);
    if (stale(seq)) return;
    data.projects = projects;
    data.contractors = contractors;
    const open = projects.filter((p) => p.status !== 'done');
    const models = open.map((p) => ({ p, M: safeModel(p) }));
    const upcoming = [];
    models.forEach(({ p, M }) => {
      if (!M || M.empty) return;
      M.items.forEach((r) => {
        if (r.task.status !== 'done' && r.end >= M.today && r.start <= M.today + 14) upcoming.push({ p, M, r });
      });
    });
    upcoming.sort((a, b) => a.r.start - b.r.start || a.r.end - b.r.end);
    const today = G.todayNum();
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    main.innerHTML = `
      <div class="page-head">
        <div>
          <p class="eyebrow">${esc(fmt(today, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
          <h1>${greeting}, ${esc(firstName(me.name))}</h1>
        </div>
        <div class="page-actions">
          <button class="btn" data-act="new-contractor">+ Contractor</button>
          <button class="btn btn-primary" data-act="new-project">+ New project</button>
        </div>
      </div>
      <section class="card">
        <div class="card-head"><h2>Coming up</h2><span class="card-sub">Next 14 days, across all projects</span></div>
        <ul class="items">${upcoming.length
          ? upcoming.slice(0, 12).map(({ p, M, r }) => G.itemHTML(M, r, { context: p.name, attrs: ` data-project="${esc(p.id)}"` })).join('')
          : '<li class="empty">Nothing scheduled in the next two weeks.</li>'}</ul>
      </section>
      <h2 class="section-title">Open projects</h2>
      ${open.length ? `<div class="grid">${models.map(({ p, M }) => projectCard(p, M)).join('')}</div>` : emptyProjects()}
      <h2 class="section-title">Contractors</h2>
      <div class="card"><div class="card-head"><h2>${plural(contractors.length, 'contractor')} on file</h2><span class="spacer"></span><a class="btn btn-sm" href="#/contractors">Open directory</a></div><p class="empty">Names, numbers and notes for everyone who works on the house.</p></div>`;

    main.onclick = (e) => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'new-project') { newProjectForm(); return; }
      if (act && act.dataset.act === 'new-contractor') { contractorForm(null, () => route()); return; }
      const item = e.target.closest('.item[data-project]');
      if (item) location.hash = `#/projects/${encodeURIComponent(item.dataset.project)}/task/${encodeURIComponent(item.dataset.id)}`;
    };
  }

  // ============================================
  // PROJECTS LIST
  // ============================================
  async function renderProjects(main, seq) {
    const [projects, contractors] = await Promise.all([api.projects(), api.contractors()]);
    if (stale(seq)) return;
    data.projects = projects;
    data.contractors = contractors;
    const groups = STATUSES.map(([key, label]) => ({ label, items: projects.filter((p) => p.status === key) })).filter((g) => g.items.length);
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Projects</h1><p class="meta">${plural(projects.length, 'project')}</p></div>
        <div class="page-actions"><button class="btn btn-primary" data-act="new-project">+ New project</button></div>
      </div>
      ${projects.length ? groups.map((g) => `<h2 class="section-title">${esc(g.label)}</h2>
        <div class="grid">${g.items.map((p) => projectCard(p, safeModel(p))).join('')}</div>`).join('') : emptyProjects()}`;
    main.onclick = (e) => {
      if (e.target.closest('[data-act="new-project"]')) newProjectForm();
    };
  }

  function newProjectForm() {
    const templates = data.projects.filter((p) => allTasks(p.schedule || {}).length);
    openForm({
      title: 'New project',
      fields: [
        { name: 'name', label: 'Project name', type: 'text', required: true, placeholder: 'Pool repairs' },
        { type: 'row', fields: [
          { name: 'status', label: 'Status', type: 'select', options: STATUSES, value: 'planning' },
          { name: 'start', label: 'Start date', type: 'date', required: true, value: nextMonday() },
        ] },
        { name: 'summary', label: 'Short description', type: 'textarea', placeholder: 'What needs doing, and why' },
        { name: 'template', label: 'Start from', type: 'select',
          options: [['', 'A blank schedule'], ...templates.map((p) => [p.id, `A copy of "${p.name}"`])],
          help: 'Copying reuses the tasks, trades and timing, without dates or progress.' },
      ],
      submitLabel: 'Create project',
      async onSubmit(v) {
        let schedule = { project: { start: v.start, holidays: [] }, trades: {}, phases: [] };
        const source = templates.find((p) => p.id === v.template);
        if (source) {
          schedule = clone(source.schedule);
          schedule.project = Object.assign({}, schedule.project, { start: v.start });
          allTasks(schedule).forEach((t) => { delete t.status; delete t.start; delete t.private_notes; });
        }
        const row = await api.createProject({ name: v.name, status: v.status, summary: v.summary || null, schedule });
        location.hash = `#/projects/${encodeURIComponent(row.id)}`;
      },
    });
  }

  // ============================================
  // PROJECT PAGE
  // ============================================
  async function renderProject(main, seq, id, taskId) {
    const [project, contractors] = await Promise.all([api.project(id), api.contractors()]);
    if (stale(seq)) return;
    data.contractors = contractors;
    if (!project) {
      main.innerHTML = '<div class="card empty-state"><p>That project was not found. It may have been deleted.</p><a class="btn" href="#/projects">Back to projects</a></div>';
      return;
    }
    current = project;
    main.innerHTML = '<div data-ref="head"></div><div id="gv"></div>';
    renderProjectHead();
    view = G.createView(main.querySelector('#gv'), {
      dialog: detailDialog,
      contactFor: (key) => contactFor(current, key),
      teamActions: (key) => (reachable(contractorFor(current, key)) ? `<button type="button" class="btn btn-sm" data-msg="${esc(key)}">Message</button>` : ''),
      onTaskClick: (tid, M) => openTaskDetail(tid, M),
      emptyHTML: `<div class="card empty-state"><p>This project has no tasks yet.</p>
        <button class="btn btn-primary" data-act="add-task">+ Add the first task</button></div>`,
    });
    view.setSchedule(resolvedSchedule(current));
    const actions = { 'add-task': () => taskForm(null), trades: tradesForm, settings: settingsForm, share: shareDialog };
    main.onclick = (e) => {
      const msg = e.target.closest('[data-msg]');
      if (msg) {
        const c = contractorFor(current, msg.dataset.msg);
        messageDialog(c, scheduleMessage(current, msg.dataset.msg, c), sharingHint(current));
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act && actions[act.dataset.act]) actions[act.dataset.act]();
    };
    if (taskId && view.model && view.model.byId.has(taskId)) view.openTask(taskId);
  }

  function renderProjectHead() {
    const p = current;
    $('[data-ref="head"]').innerHTML = `
      <a class="back" href="#/projects">← All projects</a>
      <div class="page-head">
        <div>
          <div class="title-row"><h1>${esc(p.name)}</h1>
            <span class="pill st-${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status)}</span>
            ${p.sharing_enabled ? '<span class="pill">Share link on</span>' : ''}</div>
          <p class="meta">${p.summary ? `${esc(p.summary)} · ` : ''}Updated ${stamp(p.updated_at)}</p>
        </div>
        <div class="page-actions">
          <button class="btn" data-act="trades">Trades &amp; contractors</button>
          <button class="btn" data-act="share">Share</button>
          <button class="btn" data-act="settings">Settings</button>
          <button class="btn btn-primary" data-act="add-task">+ Task</button>
        </div>
      </div>`;
  }

  function refreshProject() {
    renderProjectHead();
    view.setSchedule(resolvedSchedule(current));
  }

  // Apply a change to the stored schedule, check it still makes sense, then save.
  async function saveSchedule(mutate, message) {
    const next = clone(current.schedule || {});
    next.project = next.project || {};
    next.trades = next.trades || {};
    next.phases = next.phases || [];
    mutate(next);
    next.phases = next.phases.filter((p) => (p.tasks || []).length);
    G.buildModel(next);
    current = await api.updateProject(current.id, { schedule: next }, current.updated_at);
    refreshProject();
    if (message) toast(message);
  }

  function wireDetailActions() {
    if (detailDialog.dataset.hubWired) return;
    detailDialog.dataset.hubWired = '1';
    detailDialog.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-task-act]');
      if (!b || !current) return;
      const id = b.dataset.tid;
      const act = b.dataset.taskAct;
      if (act === 'edit') { taskForm(id); return; }
      if (act === 'delete') { deleteTask(id); return; }
      if (act === 'message') {
        const r = view.model.byId.get(id);
        const c = contractorFor(current, r.task.trade);
        messageDialog(c, taskMessage(current, r, c), sharingHint(current));
        return;
      }
      const status = { done: 'done', start: 'in-progress', reopen: null }[act];
      b.disabled = true;
      try {
        await saveSchedule((s) => {
          const t = allTasks(s).find((x) => x.id === id);
          if (status) t.status = status; else delete t.status;
        }, status === 'done' ? 'Marked done' : 'Status updated');
        view.openTask(id);
      } catch (err) {
        b.disabled = false;
        alert(friendly(err));
      }
    });
  }

  function openTaskDetail(id, M) {
    wireDetailActions();
    const r = M.byId.get(id);
    const status = r.task.status;
    const contractor = contractorFor(current, r.task.trade);
    const message = reachable(contractor)
      ? `<button type="button" class="btn" data-task-act="message" data-tid="${esc(id)}">Message ${esc(firstName(contractor.name))}</button>` : '';
    const quick = status === 'done'
      ? `<button type="button" class="btn" data-task-act="reopen" data-tid="${esc(id)}">Reopen</button>`
      : `<button type="button" class="btn" data-task-act="done" data-tid="${esc(id)}">Mark done</button>
         ${status !== 'in-progress' ? `<button type="button" class="btn" data-task-act="start" data-tid="${esc(id)}">Mark in progress</button>` : ''}`;
    G.showDialog(detailDialog, G.detailHTML(M, id, {
      contact: contactFor(current, r.task.trade),
      showPrivate: true,
      actionsHTML: `<div class="d-actions">
        <button type="button" class="btn btn-primary" data-task-act="edit" data-tid="${esc(id)}">Edit task</button>
        ${quick}
        ${message}
        <button type="button" class="btn btn-danger" data-task-act="delete" data-tid="${esc(id)}" style="margin-left:auto">Delete</button>
      </div>`,
    }));
  }

  function deleteTask(id) {
    const s = current.schedule;
    const task = allTasks(s).find((t) => t.id === id);
    const dependents = allTasks(s).filter((t) => (t.after || []).includes(id));
    const warning = dependents.length ? `\n\n${plural(dependents.length, 'task')} wait on it and will be rescheduled without it.` : '';
    if (!window.confirm(`Delete "${task.name}"?${warning}`)) return;
    detailDialog.close();
    saveSchedule((next) => {
      next.phases.forEach((p) => { p.tasks = p.tasks.filter((t) => t.id !== id); });
      allTasks(next).forEach((t) => {
        if (t.after) { t.after = t.after.filter((a) => a !== id); if (!t.after.length) delete t.after; }
        if (t.before === id) { delete t.before; delete t.lead; }
      });
    }, 'Task deleted').catch((err) => alert(friendly(err)));
  }

  function taskForm(taskId) {
    const s = current.schedule;
    const phases = s.phases || [];
    const trades = s.trades || {};
    let phaseIdx = -1;
    let task = null;
    phases.forEach((p, i) => (p.tasks || []).forEach((t) => { if (t.id === taskId) { task = t; phaseIdx = i; } }));
    const isNew = !task;
    const t = task || {};
    const tradeKeys = Object.keys(trades);
    const unit = t.weeks ? 'weeks' : (!isNew && !t.days ? 'milestone' : 'days');

    openForm({
      title: isNew ? 'New task' : 'Edit task',
      fields: [
        { name: 'name', label: 'Task', type: 'text', required: true, value: t.name, placeholder: 'Install cabinets' },
        { type: 'row', fields: [
          { name: 'phase', label: 'Phase', type: 'select',
            options: [...phases.map((p, i) => [String(i), p.name]), ['__new', 'New phase…']],
            value: isNew ? (phases.length ? String(phases.length - 1) : '__new') : String(phaseIdx) },
          { name: 'trade', label: 'Who does it', type: 'select',
            options: [...tradeKeys.map((k) => [k, trades[k].name]), ['__new', 'New trade…']],
            value: t.trade || (tradeKeys[0] || '__new') },
        ] },
        { name: 'newPhase', label: 'New phase name', type: 'text', required: true, value: phases.length ? '' : 'Tasks', showIf: (v) => v.phase === '__new' },
        { name: 'newTrade', label: 'New trade name', type: 'text', required: true, placeholder: 'Pool technician', showIf: (v) => v.trade === '__new' },
        { type: 'row', fields: [
          { name: 'unit', label: 'How long', type: 'select', value: unit, options: [
            ['days', 'Working days'], ['weeks', 'Calendar weeks (orders, permits)'], ['milestone', 'Milestone (one moment)']] },
          { name: 'amount', label: 'Amount', type: 'number', min: 1, required: true, value: t.weeks || t.days || 1, showIf: (v) => v.unit !== 'milestone' },
        ] },
        { name: 'after', label: 'Waits on', type: 'checks', value: t.after || [],
          help: 'Tick the tasks that must finish before this one can start.',
          groups: phases.map((p) => ({ label: p.name, items: (p.tasks || []).filter((x) => x.id !== taskId).map((x) => [x.id, x.name]) })) },
        { type: 'row', fields: [
          { name: 'start', label: 'Confirmed start date', type: 'date', value: t.start || '', help: 'Leave blank to schedule automatically.' },
          { name: 'status', label: 'Status', type: 'select', options: TASK_STATUSES, value: t.status || '' },
        ] },
        { name: 'lag', label: 'Extra wait after those finish (working days)', type: 'number', min: 0, value: t.lag || '', help: 'For drying, curing or acclimating. Usually blank.' },
        { name: 'notes', label: 'Notes', type: 'textarea', value: t.notes, help: 'Shown on the shared link, so keep it to things contractors can see.' },
        { name: 'private_notes', label: 'Private notes', type: 'textarea', value: t.private_notes, help: 'Family only. Never shown on the shared link.' },
      ],
      submitLabel: isNew ? 'Add task' : 'Save task',
      extraActions: isNew ? [] : [{ label: 'Delete', danger: true, onClick: () => { formDialog.close(); deleteTask(taskId); return false; } }],
      async onSubmit(v) {
        await saveSchedule((next) => {
          const ids = new Set(allTasks(next).map((x) => x.id));
          const nt = isNew ? { id: uniqueKey(slug(v.name), ids) } : Object.assign({}, task);
          nt.name = v.name;

          if (v.trade === '__new') {
            const key = uniqueKey(slug(v.newTrade), new Set(Object.keys(next.trades)));
            next.trades[key] = { name: v.newTrade, who: '', color: PALETTE[Object.keys(next.trades).length % PALETTE.length] };
            nt.trade = key;
          } else {
            nt.trade = v.trade;
          }

          delete nt.days;
          delete nt.weeks;
          const amount = Math.max(1, parseInt(v.amount, 10) || 1);
          if (v.unit === 'days') nt.days = amount;
          if (v.unit === 'weeks') nt.weeks = amount;

          const setOrDrop = (key, value) => { if (value) nt[key] = value; else delete nt[key]; };
          setOrDrop('after', v.after.length ? v.after : null);
          setOrDrop('start', v.start);
          setOrDrop('status', v.status);
          setOrDrop('lag', Math.max(0, parseInt(v.lag, 10) || 0));
          setOrDrop('notes', v.notes);
          setOrDrop('private_notes', v.private_notes);

          let target;
          if (v.phase === '__new') {
            next.phases.push({ name: v.newPhase || 'Tasks', tasks: [] });
            target = next.phases.length - 1;
          } else {
            target = +v.phase;
          }
          if (!isNew && target === phaseIdx) {
            const list = next.phases[phaseIdx].tasks;
            list[list.findIndex((x) => x.id === nt.id)] = nt;
          } else {
            if (!isNew) next.phases[phaseIdx].tasks = next.phases[phaseIdx].tasks.filter((x) => x.id !== nt.id);
            next.phases[target].tasks.push(nt);
          }
        }, isNew ? 'Task added' : 'Task saved');
      },
    });
  }

  function tradesForm() {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    const s = current.schedule;
    const used = new Set(allTasks(s).map((t) => t.trade));
    const contractorOptions = (selected) => `<option value="">No contractor linked</option>${data.contractors.map((c) =>
      `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc([c.name, c.company].filter(Boolean).join(', '))}${c.trade ? ` (${esc(c.trade)})` : ''}</option>`).join('')}`;
    const row = (key, t) => `<div class="trade-row" data-key="${esc(key)}">
      <input type="color" name="color" value="${esc(t.color || PALETTE[0])}" aria-label="Color">
      <input type="text" name="name" value="${esc(t.name || '')}" placeholder="Trade name" required aria-label="Trade name">
      <select name="contractor" aria-label="Contractor">${contractorOptions(t.contractor_id)}</select>
      <button type="button" class="btn btn-sm btn-danger" data-remove${used.has(key) ? ' disabled title="Tasks use this trade"' : ''}>Remove</button>
      <input type="text" class="who" name="who" value="${esc(t.who || '')}" placeholder="Who, if they're not in your contractor list" aria-label="Who"${t.contractor_id ? ' hidden' : ''}>
    </div>`;

    formDialog.innerHTML = `<form class="form d-inner">
      <div class="d-top"><h3>Trades &amp; contractors</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <p class="meta">Link each trade to someone in your <a href="#/contractors">contractor directory</a>. The family sees their phone and email here; the shared link shows only their name and company.</p>
      <div class="trade-rows">${Object.entries(s.trades || {}).map(([k, t]) => row(k, t)).join('')}</div>
      <div><button type="button" class="btn btn-sm" data-add>+ Add trade</button></div>
      <p class="form-error" hidden></p>
      <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
    </form>`;
    const form = formDialog.querySelector('form');
    const rows = form.querySelector('.trade-rows');
    form.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) {
        const n = rows.children.length;
        rows.insertAdjacentHTML('beforeend', row('', { color: PALETTE[n % PALETTE.length] }));
        rows.lastElementChild.querySelector('[name="name"]').focus();
      }
      const rm = e.target.closest('[data-remove]');
      if (rm && !rm.disabled) rm.closest('.trade-row').remove();
    });
    form.addEventListener('change', (e) => {
      if (e.target.name === 'contractor') e.target.closest('.trade-row').querySelector('.who').hidden = !!e.target.value;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const errBox = form.querySelector('.form-error');
      try {
        await saveSchedule((next) => {
          const old = next.trades || {};
          const fresh = {};
          const taken = new Set([...rows.children].map((r) => r.dataset.key).filter(Boolean));
          [...rows.children].forEach((r) => {
            const name = r.querySelector('[name="name"]').value.trim();
            const key = r.dataset.key || uniqueKey(slug(name), taken);
            taken.add(key);
            const t = Object.assign({}, old[key], { name, color: r.querySelector('[name="color"]').value });
            const contractor = r.querySelector('[name="contractor"]').value;
            if (contractor) t.contractor_id = contractor; else delete t.contractor_id;
            t.who = contractor ? '' : r.querySelector('[name="who"]').value.trim();
            fresh[key] = t;
          });
          next.trades = fresh;
        }, 'Trades saved');
        formDialog.close();
      } catch (err) {
        errBox.textContent = friendly(err);
        errBox.hidden = false;
      }
    });
    formDialog.showModal();
  }

  function settingsForm() {
    const p = current;
    const s = p.schedule || {};
    const phases = s.phases || [];
    openForm({
      title: 'Project settings',
      fields: [
        { name: 'name', label: 'Project name', type: 'text', required: true, value: p.name },
        { type: 'row', fields: [
          { name: 'status', label: 'Status', type: 'select', options: STATUSES, value: p.status },
          { name: 'start', label: 'Start date', type: 'date', required: true, value: (s.project || {}).start },
        ] },
        { name: 'summary', label: 'Short description', type: 'textarea', value: p.summary },
        ...phases.map((ph, i) => ({ name: `phase_${i}`, label: `Phase ${i + 1} name`, type: 'text', required: true, value: ph.name })),
        { name: 'holidays', label: 'Days off (no work)', type: 'textarea', value: ((s.project || {}).holidays || []).join('\n'),
          help: 'One date per line, like 2026-12-25. Weekends are already skipped.' },
      ],
      extraActions: [{
        label: 'Delete project',
        danger: true,
        async onClick() {
          if (!window.confirm(`Delete "${p.name}" and its whole schedule? This can't be undone.`)) return false;
          await api.deleteProject(p.id);
          formDialog.close();
          toast('Project deleted');
          location.hash = '#/projects';
          return false;
        },
      }],
      async onSubmit(v) {
        const holidays = v.holidays.split(/[\s,]+/).filter(Boolean);
        holidays.forEach((d) => G.parseDate(d));
        const next = clone(s);
        next.project = Object.assign({}, next.project, { start: v.start, holidays });
        (next.phases || []).forEach((ph, i) => { ph.name = v[`phase_${i}`]; });
        G.buildModel(next);
        current = await api.updateProject(p.id, { name: v.name, status: v.status, summary: v.summary || null, schedule: next }, p.updated_at);
        refreshProject();
        toast('Settings saved');
      },
    });
  }

  function shareDialog() {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    const p = current;
    const link = shareLink(p);
    formDialog.innerHTML = `<div class="form d-inner">
      <div class="d-top"><h3>Share with contractors</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <p class="meta">Anyone with the link can see this project's schedule: dates, tasks, trades, and contractor names and companies. Phone numbers, emails and private notes are never shown.</p>
      ${p.sharing_enabled ? `
        <label class="field"><span>Share link</span>
          <div class="sharebox"><input type="text" readonly value="${esc(link)}" aria-label="Share link"><button type="button" class="btn" data-share="copy">Copy</button></div>
          <small>Tip: open the link and tap a trade to get a link showing only that trade's dates.</small></label>
        <div class="form-actions">
          <button type="button" class="btn btn-danger left" data-share="off">Turn off sharing</button>
          <button type="button" class="btn" data-share="rotate">Get a new link</button>
          <button type="button" class="btn btn-primary" data-close>Done</button>
        </div>` : `
        <div class="form-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" data-share="on">Turn on sharing</button>
        </div>`}
      <p class="form-error" hidden></p>
    </div>`;
    formDialog.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.share;
      if (act === 'copy') {
        try { await navigator.clipboard.writeText(link); toast('Link copied'); }
        catch (err) { window.prompt('Copy this link:', link); }
        return;
      }
      if (act === 'rotate' && !window.confirm('Make a new link? The old link will stop working for anyone you sent it to.')) return;
      const patch = act === 'on' ? { sharing_enabled: true } : act === 'off' ? { sharing_enabled: false } : { share_token: randomToken() };
      try {
        current = await api.updateProject(p.id, patch, p.updated_at);
        refreshProject();
        shareDialog();
      } catch (err) {
        const box = formDialog.querySelector('.form-error');
        box.textContent = friendly(err);
        box.hidden = false;
      }
    }));
    if (!formDialog.open) formDialog.showModal();
  }

  // ============================================
  // CONTRACTORS
  // ============================================
  function usageOf(contractorId) {
    const uses = [];
    data.projects.forEach((p) => Object.values((p.schedule || {}).trades || {}).forEach((t) => {
      if (t.contractor_id === contractorId) uses.push({ project: p, trade: t.name });
    }));
    return uses;
  }

  function contractorCard(c) {
    const uses = usageOf(c.id);
    return `<div class="ccard">
      <div class="ccard-top">
        <div><h3>${esc(c.name)}</h3>${c.company ? `<div class="company">${esc(c.company)}</div>` : ''}</div>
        ${c.trade ? `<span class="pill">${esc(c.trade)}</span>` : ''}
      </div>
      <div class="links">
        ${c.phone ? `<a href="${esc(telHref(c.phone))}">${esc(c.phone)}</a>` : ''}
        ${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}
        ${c.website ? `<a href="${esc(webHref(c.website))}" target="_blank" rel="noopener">${esc(c.website.replace(/^https?:\/\//i, ''))}</a>` : ''}
      </div>
      ${c.notes ? `<p class="notes">${esc(c.notes)}</p>` : ''}
      ${uses.length ? `<div class="used">On: ${uses.map((u) => `<a href="#/projects/${encodeURIComponent(u.project.id)}">${esc(u.project.name)}</a> (${esc(u.trade)})`).join(', ')}</div>` : ''}
      <div class="form-actions" style="margin-top:10px">
        ${reachable(c) ? `<button type="button" class="btn btn-sm" data-message="${esc(c.id)}">Message</button>` : ''}
        <button type="button" class="btn btn-sm" data-edit="${esc(c.id)}">Edit</button>
      </div>
    </div>`;
  }

  async function renderContractors(main, seq) {
    const [contractors, projects] = await Promise.all([api.contractors(), api.projects()]);
    if (stale(seq)) return;
    data.contractors = contractors;
    data.projects = projects;
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Contractors</h1><p class="meta">${plural(contractors.length, 'contractor')} · visible to the family only</p></div>
        <div class="page-actions"><button class="btn btn-primary" data-act="new-contractor">+ Add contractor</button></div>
      </div>
      ${contractors.length ? `<div class="searchbar"><input type="search" placeholder="Search by name, company, trade or notes" aria-label="Search contractors"></div>` : ''}
      <div class="grid" data-ref="list"></div>
      ${contractors.length ? '' : `<div class="card empty-state"><p>Keep every plumber, painter and pool tech's details in one place.</p>
        <button class="btn btn-primary" data-act="new-contractor">+ Add your first contractor</button></div>`}`;
    const list = main.querySelector('[data-ref="list"]');
    const draw = (term) => {
      const t = (term || '').toLowerCase();
      const shown = contractors.filter((c) => !t || [c.name, c.company, c.trade, c.notes, c.email, c.phone].some((x) => String(x || '').toLowerCase().includes(t)));
      list.innerHTML = shown.map(contractorCard).join('') || '<p class="empty">No contractors match that search.</p>';
    };
    draw('');
    const search = main.querySelector('.searchbar input');
    if (search) search.addEventListener('input', () => draw(search.value));
    main.onclick = (e) => {
      if (e.target.closest('[data-act="new-contractor"]')) { contractorForm(null, () => route()); return; }
      const edit = e.target.closest('[data-edit]');
      if (edit) { contractorForm(contractors.find((c) => c.id === edit.dataset.edit), () => route()); return; }
      const msg = e.target.closest('[data-message]');
      if (msg) {
        const c = contractors.find((x) => x.id === msg.dataset.message);
        messageDialog(c, { subject: 'Hello from the Home Hub', body: [`Hi ${firstName(c.name)},`, '', ''].concat(signOff()).join('\n') });
      }
    };
  }

  function contractorForm(c, after) {
    const x = c || {};
    openForm({
      title: c ? 'Edit contractor' : 'Add contractor',
      fields: [
        { type: 'row', fields: [
          { name: 'name', label: 'Name', type: 'text', required: true, value: x.name, placeholder: 'Pat Lee' },
          { name: 'company', label: 'Company', type: 'text', value: x.company, placeholder: 'Lee Electric' },
        ] },
        { name: 'trade', label: 'Trade', type: 'text', value: x.trade, placeholder: 'Electrician' },
        { type: 'row', fields: [
          { name: 'phone', label: 'Phone', type: 'tel', value: x.phone },
          { name: 'email', label: 'Email', type: 'email', value: x.email },
        ] },
        { name: 'website', label: 'Website', type: 'text', value: x.website, placeholder: 'leeelectric.com' },
        { name: 'notes', label: 'Notes', type: 'textarea', value: x.notes, placeholder: 'Licence number, who referred them, what they charged, how it went' },
      ],
      submitLabel: c ? 'Save' : 'Add contractor',
      extraActions: c ? [{
        label: 'Delete',
        danger: true,
        async onClick() {
          const uses = usageOf(c.id);
          const note = uses.length ? `\n\nThey're linked on ${plural(uses.length, 'project')}; those projects will keep their name but lose the link.` : '';
          if (!window.confirm(`Delete ${c.name}?${note}`)) return false;
          await unlinkContractor(c, uses);
          await api.deleteContractor(c.id);
          formDialog.close();
          toast('Contractor deleted');
          after();
          return false;
        },
      }] : [],
      async onSubmit(v) {
        const row = { name: v.name, company: v.company || null, trade: v.trade || null, phone: v.phone || null,
          email: v.email || null, website: v.website || null, notes: v.notes || null };
        if (c) row.id = c.id;
        await api.saveContractor(row);
        toast(c ? 'Contractor saved' : 'Contractor added');
        after();
      },
    });
  }

  // Before deleting a contractor, turn each link into plain text so projects still say who did the work.
  async function unlinkContractor(c, uses) {
    const label = [c.name, c.company].filter(Boolean).join(', ');
    const projects = [...new Set(uses.map((u) => u.project))];
    for (const p of projects) {
      const next = clone(p.schedule);
      Object.values(next.trades || {}).forEach((t) => {
        if (t.contractor_id === c.id) { delete t.contractor_id; t.who = label; }
      });
      await api.updateProject(p.id, { schedule: next }, p.updated_at);
    }
  }

  // ============================================
  // FAMILY
  // ============================================
  async function renderFamily(main, seq) {
    const members = await api.members();
    if (stale(seq)) return;
    data.members = members;
    const admin = me.role === 'admin';
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Family</h1><p class="meta">Signed in as ${esc(me.name)} (${esc(me.email)})</p></div>
        <div class="page-actions">
          <button class="btn" data-act="sign-out">Sign out</button>
          ${admin ? '<button class="btn btn-primary" data-act="add-member">+ Add family member</button>' : ''}
        </div>
      </div>
      <section class="card">
        <div class="card-head"><h2>Who can sign in</h2><span class="card-sub">${admin ? 'As an admin, you can add and remove people' : 'Ask an admin to add someone'}</span></div>
        <ul class="rows">${members.map((m) => `<li>
          <div class="grow"><strong>${esc(m.name)}</strong>${m.email === me.email ? ' (you)' : ''}<div class="sub">${esc(m.email)}</div></div>
          <span class="pill${m.role === 'admin' ? ' role-admin' : ''}">${m.role === 'admin' ? 'Admin' : 'Member'}</span>
          ${admin && m.email !== me.email ? `<button type="button" class="btn btn-sm btn-danger" data-remove="${esc(m.email)}">Remove</button>` : ''}
        </li>`).join('')}</ul>
      </section>
      <section class="card">
        <div class="card-head"><h2>How sign-in works</h2></div>
        <p class="empty">Each person signs in with their own email address. They get a one-time link, and after that their device stays signed in.
        Removing someone here blocks their access right away. Members can edit projects and contractors; admins can also manage this list.</p>
      </section>`;
    main.onclick = async (e) => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'sign-out') { await sb.auth.signOut(); return; }
      if (act && act.dataset.act === 'add-member') { memberForm(); return; }
      const rm = e.target.closest('[data-remove]');
      if (rm && window.confirm(`Remove ${rm.dataset.remove}? They will lose access to the Home Hub.`)) {
        try { await api.removeMember(rm.dataset.remove); toast('Removed'); route(); }
        catch (err) { alert(friendly(err)); }
      }
    };
  }

  function memberForm() {
    openForm({
      title: 'Add family member',
      intro: 'They sign in with this email address. Nothing is sent until they ask for a sign-in link on the Home Hub page.',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'role', label: 'Role', type: 'select', value: 'member',
          options: [['member', 'Member: can edit projects and contractors'], ['admin', 'Admin: can also manage this list']] },
      ],
      submitLabel: 'Add',
      async onSubmit(v) {
        await api.addMember({ name: v.name, email: v.email.toLowerCase(), role: v.role });
        toast(`${firstName(v.name)} can now sign in`);
        route();
      },
    });
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

  boot();
})();
