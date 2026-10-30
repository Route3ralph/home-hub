/* =====================================================================
   HOME HUB — Projects (v1 and v2)
   The project list and each project's page: the editable Gantt schedule,
   task details, and the task, trades, settings and share forms. Also the
   project cards and "New project" form that the Home page (v1) uses, and
   that Today (v2) may use: use('projects').
   With a v2 database (core.schemaVersion >= 2) the same pages also get:
   dates by the household's clock, never the device's; an owner and "Show
   in Home Hub calendar" in the settings; and a Tasks card on each project
   (the tasks table's rows for it), where a task can be ticked off, added,
   or put on the schedule as a Gantt task. v1 mode never reaches the v2
   code, so the v1 pages behave exactly as before. v2 styles are in
   assets/css/projects.css.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { G, api, data, detailDialog, formDialog, $, clone, firstName, slug, uniqueKey, allTasks, stamp, nextMonday,
    randomToken, toast, friendly, resolvedSchedule, contractorFor, reachable, contactFor, shareLink, safeModel,
    openForm, wireFormDialog, signOff, messageDialog, stale } = core;
  const { esc, fmtShort, plural } = G;

  const STATUSES = [['active', 'Active'], ['planning', 'Planning'], ['idea', 'Idea'], ['on-hold', 'On hold'], ['done', 'Done']];
  const STATUS_LABEL = Object.fromEntries(STATUSES);
  const TASK_STATUSES = [['', 'Planned'], ['in-progress', 'In progress'], ['done', 'Done'], ['delayed', 'Delayed']];
  const PALETTE = ['#9333ea', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#db2777', '#b91c1c', '#92622f', '#64748b'];

  let view = null;     // the Gantt view on a project page
  let current = null;  // the project row being viewed
  let tasksLoads = 0;  // v2: numbers each read of the Tasks card, so only the newest one draws

  // Leaving a project page (for another page, or signing out) tears down its Gantt view.
  function destroyView() {
    if (view) view.destroy();
    view = null;
    current = null;
  }

  // ============================================
  // V2 (schemaVersion >= 2)
  // Dates come from the household's clock (core.v2), so the schedule's "today", the cards and the
  // forms follow the household's calendar, never the device's. Nothing here runs in v1 mode.
  // ============================================
  const isV2 = () => core.schemaVersion >= 2;
  const { v2, q } = core;
  const householdToday = () => v2.dates.today();

  // The Gantt model with the household's date as "today" (Coming up, Behind, the Today line).
  function modelFor(p) {
    try { return G.buildModel(resolvedSchedule(p), { today: householdToday() }); } catch (err) { return null; }
  }

  // The Monday after the household's today (a Monday gives the one after), like nextMonday().
  const nextMondayLocal = () => v2.dates.addDays(v2.dates.mondayOf(householdToday()), 7);

  // 'Oct 24, 2026': the household's date of an instant, like stamp().
  function stampLocal(iso) {
    const tz = (v2.household && v2.household.tz) || (v2.clock && v2.clock.tz) || 'America/New_York';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' });
  }

  // The owner gets the project's lines in the morning email, which only parents get; with no owner
  // every parent does. So the choices are the active parents, plus whoever owns it now.
  function ownerOptions(ownerId) {
    const people = v2.people().filter((x) => (x.role === 'parent' && x.active !== false) || x.id === ownerId);
    return [['', 'No owner: every parent'], ...people.map((x) => [x.id, x.active === false ? `${x.name} (inactive)` : x.name])];
  }

  // v2 forms get the .proj-form class (44px buttons and checkboxes, in projects.css).
  function markForm() {
    ensureStyles();
    const form = formDialog.querySelector('.form');
    if (form) form.classList.add('proj-form');
  }

  // The v2 styles are in assets/css/projects.css. index.html links each page's stylesheet; if it
  // doesn't link this one, add it here, with the same ?v= as hub.js so a release fetches it fresh.
  function ensureStyles() {
    if (document.querySelector('link[href*="assets/css/projects.css"]')) return;
    const hub = document.querySelector('script[src*="assets/hub.js"]');
    const version = hub ? (hub.getAttribute('src').split('?')[1] || '') : '';
    document.head.appendChild(Object.assign(document.createElement('link'), {
      rel: 'stylesheet', href: `assets/css/projects.css${version ? `?${version}` : ''}`,
    }));
  }

  // ============================================
  // MESSAGES
  // Drafts for a project's contractors; the composer (messageDialog) is in the core.
  // ============================================
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

  // "on the project page": the message dialog has a Share button of its own (the phone's share sheet).
  const sharingHint = (project) => (project.sharing_enabled ? '' : 'Tip: turn on sharing (the Share button on the project page) to include a link to the live schedule.');

  // ============================================
  // PROJECT CARDS (also on the Home page)
  // In v2 a caller may leave out M; the card then works it out by the household's date.
  // ============================================
  function projectCard(p, M) {
    if (M === undefined && isV2()) M = modelFor(p);
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

  // ============================================
  // PROJECTS LIST
  // ============================================
  async function renderProjects(main, seq) {
    const [projects, contractors] = await Promise.all([api.projects(), api.contractors()]);
    if (stale(seq)) return;
    data.projects = projects;
    data.contractors = contractors;
    const groups = STATUSES.map(([key, label]) => ({ label, items: projects.filter((p) => p.status === key) })).filter((g) => g.items.length);
    const model = isV2() ? modelFor : safeModel;
    const html = `
      <div class="page-head">
        <div><h1>Projects</h1><p class="meta">${plural(projects.length, 'project')}</p></div>
        <div class="page-actions"><button class="btn btn-primary" data-act="new-project">+ New project</button></div>
      </div>
      ${projects.length ? groups.map((g) => `<h2 class="section-title">${esc(g.label)}</h2>
        <div class="grid">${g.items.map((p) => projectCard(p, model(p))).join('')}</div>`).join('') : emptyProjects()}`;
    main.innerHTML = isV2() ? `<div class="proj2">${html}</div>` : html;
    main.onclick = (e) => {
      if (e.target.closest('[data-act="new-project"]')) newProjectForm();
    };
  }

  // v2: Today, unlike v1's Home, doesn't read the project list, so "Start from" reads it first.
  function newProjectForm() {
    if (isV2() && !data.projects.length) {
      api.projects().then((rows) => { data.projects = rows; openNewProjectForm(); }, (err) => toast(friendly(err), { error: true }));
      return;
    }
    openNewProjectForm();
  }

  function openNewProjectForm() {
    const templates = data.projects.filter((p) => allTasks(p.schedule || {}).length);
    openForm({
      title: 'New project',
      fields: [
        { name: 'name', label: 'Project name', type: 'text', required: true, placeholder: 'Pool repairs' },
        { type: 'row', fields: [
          { name: 'status', label: 'Status', type: 'select', options: STATUSES, value: 'planning' },
          { name: 'start', label: 'Start date', type: 'date', required: true, value: isV2() ? nextMondayLocal() : nextMonday() },
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
    if (isV2()) markForm();
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
    // v2: the Tasks card sits between the heading and the schedule.
    main.innerHTML = isV2()
      ? '<div class="proj2"><div data-ref="head"></div><div data-ref="ptasks"></div><div id="gv"></div></div>'
      : '<div data-ref="head"></div><div id="gv"></div>';
    renderProjectHead();
    view = G.createView(main.querySelector('#gv'), Object.assign({
      dialog: detailDialog,
      contactFor: (key) => contactFor(current, key),
      teamActions: (key) => (reachable(contractorFor(current, key)) ? `<button type="button" class="btn btn-sm" data-msg="${esc(key)}">Message</button>` : ''),
      onTaskClick: (tid, M) => openTaskDetail(tid, M),
      emptyHTML: `<div class="card empty-state"><p>This project has no tasks yet.</p>
        <button class="btn btn-primary" data-act="add-task">+ Add the first task</button></div>`,
    }, isV2() ? {
      today: householdToday(),
      emptyHTML: `<div class="card empty-state"><p>Nothing on the schedule yet.</p>
        <button class="btn btn-primary" data-act="add-task">+ Add the first schedule task</button></div>`,
    } : {}));
    view.setSchedule(resolvedSchedule(current));
    const actions = { 'add-task': () => taskForm(null), trades: tradesForm, settings: settingsForm, share: shareDialog };
    if (isV2()) {
      Object.assign(actions, {
        'ptask-add': () => openTodoForm({ project_id: current.id, onSaved: () => drawTasksCard() }),
        'ptasks-retry': () => drawTasksCard(),
      });
      drawTasksCard();
    }
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
    if (isV2()) { renderProjectHeadV2(); return; }
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

  // v2: the same heading, by the household's date, with the owner, whether it's on the calendar, and
  // a quiet note while the dates the calendar and the morning email use are stale (task_dates null:
  // the core fills them in when the project is read; a schedule that can't be drawn explains itself).
  function renderProjectHeadV2() {
    const p = current;
    const owner = p.owner_id ? v2.person(p.owner_id) : null;
    const staleDates = p.task_dates === null && !!modelFor(p);
    $('[data-ref="head"]').innerHTML = `
      <a class="back" href="#/projects">← All projects</a>
      <div class="page-head">
        <div>
          <div class="title-row"><h1>${esc(p.name)}</h1>
            <span class="pill st-${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status)}</span>
            ${p.sharing_enabled ? '<span class="pill">Share link on</span>' : ''}
            ${p.on_calendar === false ? '<span class="pill">Not on the calendar</span>' : ''}</div>
          <p class="meta">${[p.summary ? esc(p.summary) : '', `Updated ${esc(stampLocal(p.updated_at))}`, owner ? `Owner: ${esc(owner.name)}` : ''].filter(Boolean).join(' · ')}</p>
          ${staleDates ? '<p class="proj-stale" role="status">Dates are being refreshed for the calendar and the morning email.</p>' : ''}
        </div>
        <div class="page-actions">
          <button class="btn" data-act="trades">Trades &amp; contractors</button>
          <button class="btn" data-act="share">Share</button>
          <button class="btn" data-act="settings">Settings</button>
          <button class="btn btn-primary" data-act="add-task">+ Schedule task</button>
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

  // ============================================
  // TASKS CARD (v2)
  // The tasks table's open rows for this project: one-offs not yet ticked off, and repeating ones.
  // Tick one off (complete_task, with Undo), tap one to edit it, add one with the Tasks page's form
  // (use('tasks').openTaskForm), or put one on the schedule. Paused ones have no box: the database
  // won't tick them off until they're turned back on (on the Tasks page).
  // ============================================
  const repeats = (t) => t.repeat_mode === 'schedule' || t.repeat_mode === 'after_done';
  const alreadyDone = (err) => /^already (done|completed)$/.test((err && err.message) || '');
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // By due date (no date last), then time (none last), then name.
  const byDue = (a, b) => cmp(a.due_date || '9999', b.due_date || '9999') || cmp(a.due_time || '99', b.due_time || '99')
    || String(a.title).localeCompare(String(b.title));

  // The Tasks page's form, for a new task on this project or to edit one; errors show in a toast.
  function openTodoForm(defaults) {
    try {
      const open = core.use('tasks').openTaskForm;
      if (typeof open !== 'function') throw new Error("Adding tasks isn't available yet. Reload the page to get the latest version.");
      Promise.resolve(open(defaults)).catch((err) => toast(friendly(err), { error: true }));
    } catch (err) { toast(friendly(err), { error: true }); }
  }

  function tasksCardHTML(id, count, body) {
    return `<section class="card ptasks" aria-labelledby="ptasks-title">
      <div class="card-head">
        <h2 id="ptasks-title">Tasks</h2>${count ? `<span class="sec-count">${count}</span>` : ''}
        <span class="card-sub">To-dos for this project that aren't on the schedule</span>
        <span class="ptasks-tools">
          <a class="btn" href="#/tasks/project/${encodeURIComponent(id)}">On the Tasks page</a>
          <button type="button" class="btn btn-primary" data-act="ptask-add">+ Task</button>
        </span>
      </div>
      ${body}
    </section>`;
  }

  // (Re)draw the card from the database. Resolves to the rows drawn, or null (an error, or the page
  // was left, or a newer read is on its way).
  async function drawTasksCard() {
    const box = $('[data-ref="ptasks"]');
    if (!box || !current) return null;
    const id = current.id;
    const seq = ++tasksLoads;
    const gone = () => seq !== tasksLoads || !current || current.id !== id || !box.isConnected;
    if (!box.firstElementChild) box.innerHTML = tasksCardHTML(id, 0, '<p class="empty-line ptasks-note">Loading tasks…</p>');
    let rows;
    try {
      rows = (await q(core.sb.from('tasks').select('*').eq('project_id', id).is('done_at', null))) || [];
    } catch (err) {
      if (gone()) return null;
      box.innerHTML = tasksCardHTML(id, 0, `<div class="ptasks-body"><p class="form-error" role="alert">Couldn't load this project's tasks. ${esc(friendly(err))}</p>
        <button type="button" class="btn ptasks-retry" data-act="ptasks-retry">Try again</button></div>`);
      return null;
    }
    if (gone()) return null;
    rows.sort(byDue);
    box.innerHTML = tasksCardHTML(id, rows.length, rows.length
      ? '<div class="irows ptasks-list"></div>'
      : '<p class="empty-line ptasks-note">No tasks for this project. Add calls, orders and errands here; put one on the schedule when it needs a trade and dates.</p>');
    const list = box.querySelector('.ptasks-list');
    if (list) {
      const today = householdToday();
      const contacts = new Map(data.contractors.map((c) => [c.id, c]));
      rows.forEach((t) => list.appendChild(taskRow(t, today, contacts)));
    }
    return rows;
  }

  // One task: the shared item row (tick box, day, who, call) with a Paused badge, and "Put on the
  // schedule" beside it (under it on phones).
  function taskRow(t, today, contacts) {
    const c = t.contractor_id ? contacts.get(t.contractor_id) : null;
    const paused = t.active === false;
    const item = {
      kind: 'task', item_id: t.id, occurrence: t.due_date, title: t.title,
      day: t.due_date, end_day: t.due_date, all_day: !t.due_time, start_at: null, end_at: null,
      local_start: t.due_time || null, local_end: null, responsible_id: t.responsible_id || null, participant_ids: [],
      status: !paused && t.due_date && t.due_date < today ? 'late' : 'open',
      category: t.category, project_id: t.project_id, project_name: null,
      contractor_id: t.contractor_id || null, contractor_name: c ? c.name : null, contractor_phone: c ? c.phone : null,
      location: null, notes: null, private: !!t.private, repeating: repeats(t), changed: false, lead_days: t.lead_days || 0, milestone: false,
    };
    const row = v2.ui.itemRow(item, {
      checkbox: !paused, showWho: true, showDate: true,
      onOpen: () => openTodoForm({ task: t, onSaved: () => drawTasksCard() }),
      onToggle: () => tickTask(t),
    });
    row.dataset.task = t.id;
    if (!t.due_date) {
      const time = row.querySelector('.irow-time');
      time.classList.add('untimed');
      time.innerHTML = '<span>No date</span>';
    }
    if (paused) {
      let sub = row.querySelector('.irow-sub');
      if (!sub) {
        sub = document.createElement('span');
        sub.className = 'irow-sub';
        row.querySelector('.irow-main').appendChild(sub);
      }
      sub.insertAdjacentHTML('afterbegin', '<span class="badge">Paused</span>');
      // Where the tick box would be, so the titles line up.
      row.querySelector('.irow-time').insertAdjacentHTML('afterend', '<span class="ptask-nobox" aria-hidden="true"></span>');
    }
    const wrap = document.createElement('div');
    wrap.className = 'ptask';
    wrap.dataset.task = t.id;
    wrap.innerHTML = '<div class="ptask-acts"><button type="button" class="btn ptask-sched">Put on the schedule</button></div>';
    const b = wrap.querySelector('.ptask-sched');
    b.setAttribute('aria-label', `Put "${t.title}" on the schedule`);
    b.addEventListener('click', () => putOnSchedule(t));
    wrap.prepend(row);
    return wrap;
  }

  // Tick a task off (today), with Undo. A repeating one moves to its next date. If it throws, the
  // shared row unticks the box and shows the error.
  async function tickTask(t) {
    let logId;
    try {
      logId = await v2.call('complete_task', { p_id: t.id, p_occurrence: t.due_date || null });
    } catch (err) {
      if (!alreadyDone(err)) throw err;
      toast('Someone already ticked that off. This is the latest.');
      drawTasksCard();
      return;
    }
    const rows = await drawTasksCard();
    const now = rows && rows.find((x) => x.id === t.id);
    const next = repeats(t) && now && now.due_date ? ` · next ${v2.fmt.short(now.due_date)}` : '';
    toast(`Done: ${t.title}${next}`, {
      action: {
        label: 'Undo',
        async onClick() {
          await v2.call('undo_task', { p_log_id: logId });
          toast(`Not done: ${t.title}`);
          drawTasksCard();
        },
      },
    });
  }

  // ============================================
  // PUT ON THE SCHEDULE (v2)
  // A task becomes a Gantt task: name, trade (one of the project's, or a new one), working days
  // (1 unless changed) and an optional start date. It goes at the end of the last phase, through
  // saveSchedule like any schedule change, and only then is the task row deleted. The task's notes
  // become the Gantt task's private notes (family only, never on the shared link).
  // ============================================
  function putOnSchedule(t) {
    const s = current.schedule || {};
    const trades = s.trades || {};
    const keys = Object.keys(trades);
    const phases = s.phases || [];
    const phase = phases.length ? phases[phases.length - 1].name : 'Tasks';
    const contact = t.contractor_id ? data.contractors.find((c) => c.id === t.contractor_id) : null;
    const linked = contact ? keys.find((k) => trades[k].contractor_id === contact.id) : null;
    const today = householdToday();
    const projectStart = (s.project || {}).start || '';
    // Its due date if that's still to come; today if the project is under way; otherwise blank, so
    // the schedule puts it at the project's start.
    const start = t.due_date && t.due_date >= today ? t.due_date : projectStart && projectStart <= today ? today : '';
    openForm({
      title: 'Put on the schedule',
      intro: `${esc(`It goes at the end of "${phase}", and "${t.title}" comes off the task list.`)}${repeats(t) ? ' <strong>It repeats: putting it on the schedule ends the repeats.</strong>' : ''}`,
      fields: [
        { name: 'name', label: 'Task', type: 'text', required: true, value: t.title },
        { type: 'row', fields: [
          { name: 'trade', label: 'Who does it', type: 'select',
            options: [...keys.map((k) => [k, trades[k].name]), ['__new', 'New trade…']], value: linked || keys[0] || '__new' },
          { name: 'days', label: 'Working days', type: 'number', min: 1, required: true, value: 1 },
        ] },
        { name: 'newTrade', label: 'New trade name', type: 'text', required: true, placeholder: 'Handyman',
          value: contact ? contact.category || contact.trade || '' : '', showIf: (v) => v.trade === '__new',
          help: contact ? `Linked to ${contact.name} from the directory.` : '' },
        { name: 'start', label: 'Start date', type: 'date', value: start, help: 'Optional. Leave blank to schedule it automatically.' },
      ],
      submitLabel: 'Put on the schedule',
      async onSubmit(v) {
        const days = Math.max(1, parseInt(v.days, 10) || 1);
        let added = null;
        await saveSchedule((next) => {
          const ids = new Set(allTasks(next).map((x) => x.id));
          const nt = { id: uniqueKey(slug(v.name), ids), name: v.name };
          if (v.trade === '__new') {
            const key = uniqueKey(slug(v.newTrade), new Set(Object.keys(next.trades)));
            next.trades[key] = { name: v.newTrade, who: '', color: PALETTE[Object.keys(next.trades).length % PALETTE.length] };
            if (contact) next.trades[key].contractor_id = contact.id;
            nt.trade = key;
          } else {
            nt.trade = v.trade;
          }
          nt.days = days;
          if (v.start) nt.start = v.start;
          if (t.notes) nt.private_notes = t.notes;
          if (!next.phases.length) next.phases.push({ name: 'Tasks', tasks: [] });
          next.phases[next.phases.length - 1].tasks.push(nt);
          added = nt.id;
        });
        // The schedule has it now; only then take it off the task list.
        const r = view && view.model && view.model.byId.get(added);
        const when = r ? ` · ${G.rangeLong(r)}` : '';
        try {
          await q(core.sb.from('tasks').delete().eq('id', t.id));
        } catch (err) {
          toast(`"${v.name}" is on the schedule, but couldn't come off the task list: ${friendly(err)}`, { error: true, ms: 8000 });
          drawTasksCard();
          return;
        }
        toast(`On the schedule: ${v.name}${when}`);
        drawTasksCard();
      },
    });
    markForm();
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
      actionsHTML: `<div class="d-actions${isV2() ? ' proj-d' : ''}">
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
    if (isV2()) markForm();
  }

  function tradesForm() {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    const s = current.schedule;
    const used = new Set(allTasks(s).map((t) => t.trade));
    // v2: the directory also holds accounts and emergency numbers; trades link contractors and services.
    const linkable = (c, selected) => !isV2() || c.id === selected || !c.kind || c.kind === 'contractor' || c.kind === 'service';
    const contractorOptions = (selected) => `<option value="">No contractor linked</option>${data.contractors.filter((c) => linkable(c, selected)).map((c) =>
      `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc([c.name, c.company].filter(Boolean).join(', '))}${c.trade ? ` (${esc(c.trade)})` : ''}</option>`).join('')}`;
    const row = (key, t) => `<div class="trade-row" data-key="${esc(key)}">
      <input type="color" name="color" value="${esc(t.color || PALETTE[0])}" aria-label="Color">
      <input type="text" name="name" value="${esc(t.name || '')}" placeholder="Trade name" required aria-label="Trade name">
      <select name="contractor" aria-label="Contractor">${contractorOptions(t.contractor_id)}</select>
      <button type="button" class="btn btn-sm btn-danger" data-remove${used.has(key) ? ' disabled title="Tasks use this trade"' : ''}>Remove</button>
      <input type="text" class="who" name="who" value="${esc(t.who || '')}" placeholder="Who, if they're not in your contractor list" aria-label="Who"${t.contractor_id ? ' hidden' : ''}>
    </div>`;

    formDialog.innerHTML = `<form class="form d-inner${isV2() ? ' proj-form' : ''}">
      <div class="d-top"><h3>Trades &amp; contractors</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <p class="meta">Link each trade to someone in your <a href="${isV2() ? '#/directory' : '#/contractors'}">contractor directory</a>. The family sees their phone and email here; the shared link shows only their name and company.</p>
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
        // v2: who gets the project's lines in the morning email, and whether its tasks show on the calendar.
        ...(isV2() ? [
          { name: 'owner_id', label: 'Owner', type: 'select', options: ownerOptions(p.owner_id), value: p.owner_id || '',
            help: "Gets this project's lines in the morning email. With no owner, every parent gets them." },
          { name: 'on_calendar', label: 'Show in Home Hub calendar', type: 'checkbox', value: p.on_calendar !== false },
        ] : []),
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
        const patch = { name: v.name, status: v.status, summary: v.summary || null, schedule: next };
        if (isV2()) Object.assign(patch, { owner_id: v.owner_id || null, on_calendar: !!v.on_calendar });
        try {
          current = await api.updateProject(p.id, patch, p.updated_at);
        } catch (err) {
          // v2: the owner was removed from Family while the form was open.
          if (isV2() && err && err.code === '23503') throw new Error('That person was removed a moment ago. Reload the page and pick the owner again.');
          throw err;
        }
        refreshProject();
        toast('Settings saved');
      },
    });
    if (isV2()) markForm();
  }

  function shareDialog() {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    const p = current;
    const link = shareLink(p);
    formDialog.innerHTML = `<div class="form d-inner${isV2() ? ' proj-form' : ''}">
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

  HomeHub.register({
    name: 'projects',
    schema: { min: 1, max: 99 },
    // After Home in v1; after Today, Calendar and Tasks in v2. The core reads the order once it
    // knows the database's schema version.
    nav: { label: 'Projects', get order() { return isV2() ? 40 : 20; } },
    // #/projects, #/projects/<id>, #/projects/<id>/task/<task id>
    match: (parts) => {
      if (parts[0] !== 'projects') return null;
      return parts[1] ? { id: parts[1], task: parts[2] === 'task' ? parts[3] : null } : {};
    },
    render(main, ctx) {
      ctx.signal.addEventListener('abort', destroyView);
      if (isV2()) ensureStyles();
      return ctx.params.id ? renderProject(main, ctx.seq, ctx.params.id, ctx.params.task) : renderProjects(main, ctx.seq);
    },
    provides: { projectCard, emptyProjects, newProjectForm },
  });
})();
