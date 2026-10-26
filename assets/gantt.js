/* =====================================================================
   HOME HUB — schedule engine and Gantt view
   Shared by the private hub (index.html) and the public share page.
   A schedule looks like:
     { project: { start: 'YYYY-MM-DD', holidays: [...] },
       trades:  { key: { name, who, color, contractor_id } },
       phases:  [ { name, tasks: [ { id, name, trade, days|weeks, after, ... } ] } ] }
   ===================================================================== */
(function () {
  'use strict';

  // ============================================
  // DATES: whole days since 1970-01-01 (UTC), so no time-zone drift
  // ============================================
  const DAY_MS = 86400000;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
    if (!m) throw new Error(`"${s}" is not a valid date. Use the format YYYY-MM-DD.`);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS;
  }
  const toISO = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
  const weekday = (n) => ((n + 4) % 7 + 7) % 7; // 0 = Sunday
  const fmt = (n, o) => new Date(n * DAY_MS).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, o));
  const fmtShort = (n) => fmt(n, { month: 'short', day: 'numeric' });
  const fmtDay = (n) => fmt(n, { weekday: 'short', month: 'short', day: 'numeric' });
  const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

  function todayNum(override) {
    if (override) return parseDate(override);
    const d = new Date();
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
  }

  function makeCalendar(holidays) {
    const off = new Set(holidays.map(parseDate));
    const isWork = (n) => { const w = weekday(n); return w !== 0 && w !== 6 && !off.has(n); };
    const onOrAfter = (n) => { while (!isWork(n)) n++; return n; };
    const after = (n) => onOrAfter(n + 1);
    const forward = (n, k) => { n = onOrAfter(n); while (k-- > 0) n = after(n); return n; };
    const back = (n, k) => { while (k-- > 0) { n--; while (!isWork(n)) n--; } return n; };
    const count = (a, b) => { let k = 0; for (let n = a; n <= b; n++) if (isWork(n)) k++; return k; };
    return { off, isWork, onOrAfter, after, forward, back, count };
  }

  // ============================================
  // SCHEDULER: forward pass over `after` / `before` links
  // ============================================
  function schedule(tasks, projectStart, cal, bumpId) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const out = new Map();
    const visiting = new Set();

    function calc(id, from) {
      if (out.has(id)) return out.get(id);
      const t = byId.get(id);
      if (!t) throw new Error(`"${byId.get(from) ? byId.get(from).name : from}" waits on a task that no longer exists.`);
      if (visiting.has(id)) throw new Error(`Tasks wait on each other in a loop, around "${t.name}".`);
      visiting.add(id);

      const milestone = !t.days && !t.weeks;
      const deps = (t.after || []).map((d) => calc(d, id));
      let earliest = projectStart;
      let depEnd = null;
      if (deps.length) {
        depEnd = Math.max(...deps.map((d) => d.end));
        earliest = milestone ? depEnd : cal.after(depEnd);
      }
      if (t.lag) earliest = cal.forward(earliest, t.lag);

      let start = earliest;
      if (t.before) start = Math.max(start, cal.back(calc(t.before, id).start, t.lead || 0));

      let conflict = null;
      if (t.start) {
        const pinned = parseDate(t.start);
        if (depEnd !== null && pinned < earliest) {
          conflict = `It's pinned to ${fmtDay(pinned)}, but the work it waits on isn't scheduled to finish until ${fmtDay(depEnd)}.`;
        }
        start = pinned;
      }
      start = cal.onOrAfter(start);

      let end = t.weeks ? start + t.weeks * 7 - 1 : milestone ? start : cal.forward(start, t.days - 1);
      if (id === bumpId) { end = cal.after(end); if (milestone) start = end; }

      const r = { id, task: t, start, end, milestone, wait: !!t.weeks, conflict };
      visiting.delete(id);
      out.set(id, r);
      return r;
    }

    tasks.forEach((t) => calc(t.id));
    return out;
  }

  const lastEnd = (sched) => Math.max(...[...sched.values()].map((r) => r.end));

  // A task is critical if a one-day slip in it moves the finish date.
  function findCritical(tasks, projectStart, cal, finish) {
    const crit = new Set();
    for (const t of tasks) {
      if (t.status === 'done') continue;
      if (lastEnd(schedule(tasks, projectStart, cal, t.id)) > finish) crit.add(t.id);
    }
    return crit;
  }

  // ============================================
  // MODEL
  // ============================================
  function buildModel(data, opts) {
    opts = opts || {};
    if (!data || !data.project || !Array.isArray(data.phases)) {
      throw new Error('This schedule is missing its settings or phases.');
    }
    if (!data.project.start) throw new Error('This project needs a start date.');
    const cal = makeCalendar(data.project.holidays || []);
    const warnings = [];
    const trades = Object.assign({}, data.trades);
    const tasks = [];
    const phaseOf = new Map();

    data.phases.forEach((p, i) => (p.tasks || []).forEach((t) => {
      if (!t.id) throw new Error(`A task in "${p.name}" is missing an id.`);
      if (phaseOf.has(t.id)) throw new Error(`Two tasks share the id "${t.id}".`);
      if (!trades[t.trade]) {
        if (t.trade) warnings.push(`"${t.name}" uses trade "${t.trade}", which isn't in the trades list.`);
        trades[t.trade] = { name: t.trade || 'Unassigned', who: '', color: '#8a8277' };
      }
      tasks.push(t);
      phaseOf.set(t.id, i);
    }));

    const projectStart = cal.onOrAfter(parseDate(data.project.start));
    const today = todayNum(opts.today);
    const succ = new Map(tasks.map((t) => [t.id, []]));
    if (!tasks.length) {
      return { data, cal, trades, items: [], byId: new Map(), succ, crit: new Set(), warnings,
        start: projectStart, finish: projectStart, today, empty: true };
    }

    const sched = schedule(tasks, projectStart, cal);
    const finish = lastEnd(sched);
    const crit = findCritical(tasks, projectStart, cal, finish);
    tasks.forEach((t) => (t.after || []).forEach((d) => { if (succ.has(d)) succ.get(d).push(t.id); }));

    const items = tasks.map((t) => Object.assign(sched.get(t.id), { phase: phaseOf.get(t.id) }));
    items.forEach((r) => { if (r.conflict) warnings.push(`"${r.task.name}": ${r.conflict}`); });
    items.sort((a, b) => a.phase - b.phase || a.start - b.start || a.end - b.end);

    return {
      data, cal, trades, items, byId: sched, succ, crit, finish, warnings, today,
      start: Math.min(...items.map((r) => r.start)),
    };
  }

  function statusOf(M, r) {
    const s = r.task.status;
    if (s === 'done') return { key: 'done', label: 'Done' };
    if (s === 'delayed') return { key: 'delayed', label: 'Delayed' };
    if (r.end < M.today) return { key: 'overdue', label: 'Past due' };
    if (s === 'in-progress') return { key: 'active', label: 'In progress' };
    if (r.start <= M.today) return { key: 'now', label: 'Scheduled now' };
    return { key: 'planned', label: 'Planned' };
  }
  const isBehind = (M, r) => ['overdue', 'delayed'].includes(statusOf(M, r).key);

  // Progress summary used by stats tiles and the hub's project cards.
  function summarize(M) {
    const real = M.items.filter((r) => !r.milestone);
    const done = real.filter((r) => r.task.status === 'done').length;
    return {
      total: real.length,
      done,
      pct: real.length ? Math.round((done / real.length) * 100) : 0,
      behind: M.items.filter((r) => isBehind(M, r)).length,
      workdays: M.cal.count(M.start, M.finish),
    };
  }

  function rangeShort(r) {
    if (r.start === r.end) return fmtShort(r.start);
    const sameMonth = fmt(r.start, { month: 'short' }) === fmt(r.end, { month: 'short' });
    return sameMonth ? `${fmtShort(r.start)} – ${fmt(r.end, { day: 'numeric' })}` : `${fmtShort(r.start)} – ${fmtShort(r.end)}`;
  }
  function rangeLong(r) {
    return r.start === r.end ? fmtDay(r.start) : `${fmtDay(r.start)} – ${fmtDay(r.end)}`;
  }
  function durationText(r) {
    if (r.milestone) return 'Milestone';
    if (r.task.weeks) return `${plural(r.task.weeks, 'week')} (calendar time)`;
    return plural(r.task.days, 'working day');
  }
  const shortDuration = (r) => (r.milestone ? 'Milestone' : r.task.weeks ? plural(r.task.weeks, 'wk') : plural(r.task.days, 'day'));

  // ============================================
  // SHARED MARKUP
  // ============================================
  function itemHTML(M, r, opts) {
    opts = opts || {};
    const tr = M.trades[r.task.trade];
    const st = statusOf(M, r);
    const isCrit = M.crit.has(r.id);
    const badge = st.key === 'planned'
      ? (opts.critBadge && isCrit ? '<span class="badge crit">Critical</span>' : '')
      : `<span class="badge ${st.key}">${st.label}</span>`;
    const context = opts.context ? `${esc(opts.context)} · ` : '';
    return `<li><button type="button" class="item${isCrit ? ' is-crit' : ''}" data-id="${esc(r.id)}"${opts.attrs || ''}>
      <span class="datebox"><b>${fmt(r.start, { month: 'short' })}</b><span>${fmt(r.start, { day: 'numeric' })}</span></span>
      <span class="item-main">
        <span class="item-name">${esc(r.task.name)}</span>
        <span class="item-sub"><i class="dot" style="--c:${esc(tr.color)}"></i>${context}${esc(tr.name)} · ${rangeShort(r)} · ${shortDuration(r)}</span>
      </span>${badge}</button></li>`;
  }

  function statsHTML(M, phaseName) {
    const s = summarize(M);
    let nowValue;
    let nowSub;
    if (s.total && s.done === s.total) { nowValue = 'Complete'; nowSub = 'All tasks are done'; }
    else if (M.today < M.start) { nowValue = 'Not started'; nowSub = `Work begins in ${plural(M.start - M.today, 'day')}`; }
    else if (M.today > M.finish) { nowValue = 'Past target date'; nowSub = `${plural(s.total - s.done, 'task')} still open`; }
    else {
      // Prefer on-site work happening today, then waiting periods, then whatever is next.
      const open = M.items.filter((r) => r.task.status !== 'done');
      const spanning = open.filter((r) => r.start <= M.today && r.end >= M.today);
      const current = spanning.find((r) => !r.wait) || spanning[0] ||
        open.filter((r) => r.start > M.today).sort((a, b) => a.start - b.start)[0] || open[0];
      nowValue = esc(phaseName(current.phase));
      nowSub = `Working day ${M.cal.count(M.start, M.today)} of ${s.workdays}`;
    }
    const health = s.behind
      ? `<div class="stat-sub bad">${plural(s.behind, 'task')} behind schedule</div>`
      : '<div class="stat-sub good">No tasks behind schedule</div>';
    return `
      <div class="stat"><div class="stat-label">Start</div><div class="stat-value">${fmtDay(M.start)}</div>
        <div class="stat-sub">${fmt(M.start, { year: 'numeric' })}</div></div>
      <div class="stat"><div class="stat-label">Target finish</div><div class="stat-value">${fmtDay(M.finish)}</div>
        <div class="stat-sub">${plural(s.workdays, 'working day')}, about ${Math.max(1, Math.round((M.finish - M.start + 1) / 7))} weeks</div></div>
      <div class="stat"><div class="stat-label">Progress</div><div class="stat-value">${s.pct}%</div>
        <div class="progress" role="progressbar" aria-valuenow="${s.pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${s.pct}%"></span></div>
        <div class="stat-sub">${s.done} of ${plural(s.total, 'task')} done</div></div>
      <div class="stat"><div class="stat-label">Right now</div><div class="stat-value">${nowValue}</div>
        <div class="stat-sub">${nowSub}</div>${health}</div>`;
  }

  // Detail panel body for one task. `extra` adds hub-only content.
  function detailHTML(M, id, extra) {
    extra = extra || {};
    const r = M.byId.get(id);
    if (!r) return '';
    const tr = M.trades[r.task.trade];
    const st = statusOf(M, r);
    const link = (d) => { const x = M.byId.get(d); return x ? `<button type="button" class="linkbtn" data-goto="${esc(d)}">${esc(x.task.name)}</button>` : ''; };
    const waits = (r.task.after || []).map(link).join('');
    const unblocks = (M.succ.get(r.id) || []).map(link).join('');
    const timed = r.task.before && M.byId.get(r.task.before)
      ? `<dt>Timing</dt><dd>Starts ${plural(r.task.lead || 0, 'working day')} before ${link(r.task.before)}</dd>` : '';
    const c = extra.contact;
    const contact = c && (c.phone || c.email)
      ? `<dt>Contact</dt><dd class="d-links">${c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>` : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</dd>` : '';
    return `
      <div class="d-top">
        <span class="d-trade"><i class="dot" style="--c:${esc(tr.color)}"></i>${esc(tr.name)}</span>
        <button type="button" class="d-close" data-close aria-label="Close">×</button>
      </div>
      <h3 id="dTitle">${esc(r.task.name)}</h3>
      <dl>
        <dt>When</dt><dd>${rangeLong(r)}, ${fmt(r.end, { year: 'numeric' })}</dd>
        <dt>Duration</dt><dd>${durationText(r)}</dd>
        ${tr.who ? `<dt>Who</dt><dd>${esc(tr.who)}</dd>` : ''}
        ${contact}
        <dt>Status</dt><dd><span class="badge ${st.key}">${st.label}</span></dd>
        ${waits ? `<dt>Waits on</dt><dd class="d-links">${waits}</dd>` : ''}
        ${unblocks ? `<dt>Unblocks</dt><dd class="d-links">${unblocks}</dd>` : ''}
        ${timed}
      </dl>
      ${M.crit.has(r.id) ? '<p class="d-crit">◆ Sets the finish date: any delay here pushes back the finish.</p>' : ''}
      ${r.task.notes ? `<p class="d-note">${esc(r.task.notes)}</p>` : ''}
      ${extra.showPrivate && r.task.private_notes ? `<p class="d-note d-private"><strong>Family only:</strong> ${esc(r.task.private_notes)}</p>` : ''}
      ${r.conflict ? `<p class="d-warn">⚠ ${esc(r.conflict)}</p>` : ''}
      ${extra.actionsHTML || ''}`;
  }

  // One dialog per page; clicks on [data-goto] reopen it on another task.
  let activeView = null;
  function wireDialog(dialog) {
    if (dialog.dataset.wired) return;
    dialog.dataset.wired = '1';
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || e.target.closest('[data-close]')) { dialog.close(); return; }
      const go = e.target.closest('[data-goto]');
      if (go && activeView) activeView.openTask(go.dataset.goto);
    });
  }
  function showDialog(dialog, html) {
    wireDialog(dialog);
    dialog.innerHTML = `<div class="d-inner">${html}</div>`;
    if (!dialog.open) dialog.showModal();
  }

  // ============================================
  // VIEW
  // opts: { schedule, phaseName?, dialog, onTaskClick?(id, M), contactFor?(tradeKey),
  //         tradeLinks?: bool (sync ?trade= and offer "Copy link"), emptyHTML?, today? }
  // ============================================
  function createView(root, opts) {
    const params = new URLSearchParams(location.search);
    const state = { trade: null, view: window.innerWidth < 700 ? 'list' : 'timeline', critical: false };
    if (opts.tradeLinks && params.get('trade')) state.trade = params.get('trade');
    let M = null;
    const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
    const phaseName = (i) => (M.data.phases[i] ? M.data.phases[i].name : '');
    const visible = () => M.items.filter((r) => !state.trade || r.task.trade === state.trade);

    root.innerHTML = `
      <div class="banner banner-error" role="alert" data-ref="error" hidden></div>
      <div data-ref="body">
        <div class="banner banner-warn" data-ref="warnings" hidden></div>
        <section class="stats" data-ref="stats" aria-label="Project summary"></section>
        <section class="card upcoming">
          <div class="card-head"><h2>Coming up</h2><span class="card-sub" data-ref="upcomingSub"></span></div>
          <ul class="items" data-ref="upcoming"></ul>
        </section>
        <section class="card" data-ref="schedule">
          <div class="card-head"><h2>Schedule</h2><span class="card-sub">Tap any task for details</span></div>
          <div class="toolbar">
            <div class="chips" data-ref="chips" role="group" aria-label="Filter by trade"></div>
            <div class="toolbar-right">
              <label class="toggle" title="Tasks where any delay pushes back the finish date">
                <input type="checkbox" data-ref="crit"> Tasks that set the finish date
              </label>
              <div class="segmented" role="tablist" aria-label="View">
                <button type="button" role="tab" data-view="timeline">Timeline</button>
                <button type="button" role="tab" data-view="list">List</button>
              </div>
            </div>
          </div>
          <div class="share" data-ref="share" hidden></div>
          <div class="gantt" data-ref="timeline"></div>
          <div class="list" data-ref="list" hidden></div>
          <div class="legend">
            <span><i class="lg lg-work"></i>Work on site</span>
            <span><i class="lg lg-wait"></i>Waiting: orders, permits, fabrication</span>
            <span><i class="lg lg-ms"></i>Milestone</span>
            <span><i class="lg lg-today"></i>Today</span>
            <span><i class="lg lg-hol"></i>Holiday / no work</span>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Team</h2><span class="card-sub">Who is needed, and when</span></div>
          <div class="team" data-ref="team"></div>
        </section>
      </div>`;

    function renderWarnings() {
      const w = ref('warnings');
      w.hidden = !M.warnings.length;
      w.innerHTML = M.warnings.length
        ? `<strong>${plural(M.warnings.length, 'scheduling issue')} to check</strong><ul>${M.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    }

    function renderUpcoming() {
      const horizon = M.today + 14;
      const list = M.items
        .filter((r) => r.task.status !== 'done' && r.end >= M.today && r.start <= horizon)
        .sort((a, b) => a.start - b.start || a.end - b.end);
      ref('upcomingSub').textContent = `${fmtShort(M.today)} – ${fmtShort(horizon)}`;
      ref('upcoming').innerHTML = list.length
        ? list.map((r) => itemHTML(M, r)).join('')
        : `<li class="empty">Nothing scheduled in the next two weeks.${M.today < M.start ? ` Work begins ${fmtDay(M.start)}.` : ''}</li>`;
    }

    function renderChips() {
      const counts = {};
      M.items.forEach((r) => { counts[r.task.trade] = (counts[r.task.trade] || 0) + 1; });
      if (state.trade && !counts[state.trade]) state.trade = null;
      const chip = (key, label, color, n) => `<button type="button" class="chip" data-trade="${esc(key)}" aria-pressed="${key ? state.trade === key : !state.trade}">
        ${color ? `<i class="dot" style="--c:${esc(color)}"></i>` : ''}${esc(label)} <span class="n">${n}</span></button>`;
      const chips = ref('chips');
      chips.innerHTML = chip('', 'All trades', null, M.items.length) +
        Object.keys(M.trades).filter((k) => counts[k]).map((k) => chip(k, M.trades[k].name, M.trades[k].color, counts[k])).join('');
      // On phones the chips scroll sideways, so bring the selected one into view.
      const pressed = chips.querySelector('[aria-pressed="true"]');
      if (pressed) chips.scrollLeft = pressed.offsetLeft - chips.offsetLeft - 16;
    }

    function renderShare() {
      const box = ref('share');
      if (!opts.tradeLinks || !state.trade) { box.hidden = true; return; }
      box.innerHTML = `<span>Showing <strong>${esc(M.trades[state.trade].name)}</strong> only. Send this link so they see just their dates.</span>
        <button type="button" class="btn" data-copy-link>Copy link</button>
        <button type="button" class="linkbtn" data-trade="">Show all trades</button>`;
      box.hidden = false;
    }

    function renderTimeline(items) {
      const el = ref('timeline');
      if (!items.length) { el.innerHTML = '<p class="empty">No tasks for this trade.</p>'; return; }

      // Keep the same date range for every filter so views line up.
      const c0 = M.start - ((weekday(M.start) + 6) % 7);    // Monday on/before
      const c1 = M.finish + ((7 - weekday(M.finish)) % 7);  // Sunday on/after
      const days = c1 - c0 + 1;
      const width = el.clientWidth || root.clientWidth || 1000;
      const narrow = width < 700;
      const labelW = narrow ? 150 : 340;
      const dayW = Math.max(narrow ? 7 : 9, Math.min(30, Math.floor(((width - labelW - 2) / days) * 2) / 2));
      const W = days * dayW;
      const x = (n) => (n - c0) * dayW;

      let months = '';
      for (let n = c0; n <= c1;) {
        const d = new Date(n * DAY_MS);
        const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY_MS;
        const end = Math.min(next, c1 + 1);
        months += `<div class="g-month" style="left:${x(n)}px;width:${(end - n) * dayW}px">${(end - n) * dayW > 60 ? fmt(n, { month: 'long', year: 'numeric' }) : ''}</div>`;
        n = end;
      }
      let weeks = '';
      for (let n = c0; n <= c1; n += 7) {
        weeks += `<div class="g-week" style="left:${x(n)}px;width:${7 * dayW}px">${fmt(n, { day: 'numeric' })}</div>`;
      }
      let hol = '';
      M.cal.off.forEach((n) => {
        if (n >= c0 && n <= c1 && weekday(n) % 6 !== 0) hol += `<div class="g-hol" style="left:${x(n)}px;width:${dayW}px" title="${esc(fmtDay(n))}: no work"></div>`;
      });
      const showToday = M.today >= c0 && M.today <= c1;
      const todayX = x(M.today) + dayW / 2;

      let rows = '';
      let lastPhase = -1;
      for (const r of items) {
        if (r.phase !== lastPhase) {
          rows += `<div class="g-row phase"><div class="g-label" style="width:${labelW}px">${esc(phaseName(r.phase))}</div><div class="g-track" style="width:${W}px"></div></div>`;
          lastPhase = r.phase;
        }
        const tr = M.trades[r.task.trade];
        const st = statusOf(M, r);
        const isCrit = M.crit.has(r.id);
        const cls = ['g-bar', r.milestone ? 'ms' : '', r.wait ? 'wait' : '', `st-${st.key}`, isCrit ? 'crit' : ''].join(' ');
        const left = x(r.start);
        const w = (r.end - r.start + 1) * dayW;
        const tip = esc(`${r.task.name} · ${rangeLong(r)} · ${st.label}`);
        const bar = r.milestone
          ? `<div class="${cls}" data-id="${esc(r.id)}" title="${tip}" style="--c:${esc(tr.color)};left:${left + dayW / 2 - 6.5}px"></div>`
          : `<div class="${cls}" data-id="${esc(r.id)}" title="${tip}" style="--c:${esc(tr.color)};left:${left}px;width:${w}px"></div>`;
        const markX = r.milestone ? left + dayW / 2 + 10 : left + w + 5;
        const mark = st.key === 'done' ? `<span class="g-mark done" style="left:${markX}px">✓</span>`
          : isBehind(M, r) ? `<span class="g-mark bad" style="left:${markX}px">!</span>` : '';
        rows += `<div class="g-row${isCrit ? ' is-crit' : ''}">
          <button type="button" class="g-label" data-id="${esc(r.id)}" style="width:${labelW}px">
            <i class="dot" style="--c:${esc(tr.color)}"></i><span class="g-name">${esc(r.task.name)}</span><span class="g-dates">${rangeShort(r)}</span>
          </button>
          <div class="g-track" style="width:${W}px">${bar}${mark}</div></div>`;
      }

      const gridBg = `background-size:${7 * dayW}px 100%;background-image:linear-gradient(to right, var(--gridline) 1px, transparent 1px),linear-gradient(to right, transparent ${5 * dayW}px, var(--weekend) ${5 * dayW}px)`;
      el.className = `gantt${narrow ? ' narrow' : ''}${state.critical ? ' crit-on' : ''}`;
      el.innerHTML = `<div class="g-inner" style="width:${labelW + W}px">
        <div class="g-head">
          <div class="g-corner" style="width:${labelW}px">Task</div>
          <div class="g-scale" style="width:${W}px">${months}${weeks}${showToday ? `<div class="g-today-pill" style="left:${todayX}px">TODAY</div>` : ''}</div>
        </div>
        <div class="g-body">
          <div class="g-grid" style="left:${labelW}px;width:${W}px;${gridBg}">${hol}${showToday ? `<div class="g-today" style="left:${todayX}px"></div>` : ''}</div>
          ${rows}
        </div></div>`;
    }

    function renderList(items) {
      const el = ref('list');
      el.className = `list${state.critical ? ' crit-on' : ''}`;
      if (!items.length) { el.innerHTML = '<p class="empty">No tasks for this trade.</p>'; return; }
      el.innerHTML = M.data.phases.map((p, i) => {
        const group = items.filter((r) => r.phase === i);
        return group.length ? `<h3>${esc(p.name)}</h3><ul class="items">${group.map((r) => itemHTML(M, r, { critBadge: state.critical })).join('')}</ul>` : '';
      }).join('');
    }

    function renderSchedule() {
      const items = visible();
      root.querySelectorAll('.segmented button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
      ref('crit').checked = state.critical;
      ref('timeline').hidden = state.view !== 'timeline';
      ref('list').hidden = state.view !== 'list';
      if (state.view === 'timeline') renderTimeline(items); else renderList(items);
    }

    function renderTeam() {
      ref('team').innerHTML = Object.keys(M.trades).map((k) => {
        const tr = M.trades[k];
        const mine = M.items.filter((r) => r.task.trade === k);
        if (!mine.length) return '';
        const from = Math.min(...mine.map((r) => r.start));
        const to = Math.max(...mine.map((r) => r.end));
        const next = mine.filter((r) => r.task.status !== 'done' && r.end >= M.today).sort((a, b) => a.start - b.start)[0];
        const c = opts.contactFor ? opts.contactFor(k) : null;
        const contact = c && (c.phone || c.email)
          ? `<div class="member-contact">${c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>` : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</div>` : '';
        return `<div class="member">
          <div class="member-top"><i class="dot" style="--c:${esc(tr.color)}"></i>${esc(tr.name)}</div>
          ${tr.who ? `<div class="member-who">${esc(tr.who)}</div>` : ''}
          ${contact}
          <div class="member-when">${rangeShort({ start: from, end: to })} · ${plural(mine.length, 'task')}</div>
          <div class="member-next">${next ? `Next: ${esc(next.task.name)}, ${fmtShort(next.start)}` : 'All done ✓'}</div>
          <div class="member-actions">
            <button type="button" class="linkbtn member-filter" data-trade="${esc(k)}">Show only these tasks</button>
            ${opts.teamActions ? opts.teamActions(k) : ''}
          </div>
        </div>`;
      }).join('');
    }

    function syncUrl() {
      if (!opts.tradeLinks) return;
      const p = new URLSearchParams(location.search);
      if (state.trade) p.set('trade', state.trade); else p.delete('trade');
      history.replaceState(null, '', `${location.pathname}?${p.toString()}`.replace(/\?$/, ''));
    }

    function setTrade(key) {
      state.trade = key || null;
      syncUrl();
      renderChips();
      renderShare();
      renderSchedule();
    }

    function openTask(id) {
      if (opts.onTaskClick) { opts.onTaskClick(id, M); return; }
      const r = M.byId.get(id);
      const contact = r && opts.contactFor ? opts.contactFor(r.task.trade) : null;
      showDialog(opts.dialog, detailHTML(M, id, { contact }));
    }

    function toast(msg) {
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 1800);
    }

    root.addEventListener('click', async (e) => {
      const tradeBtn = e.target.closest('[data-trade]');
      if (tradeBtn) {
        setTrade(tradeBtn.dataset.trade);
        if (tradeBtn.classList.contains('member-filter')) ref('schedule').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const viewBtn = e.target.closest('[data-view]');
      if (viewBtn) { state.view = viewBtn.dataset.view; renderSchedule(); return; }
      if (e.target.closest('[data-copy-link]')) {
        try { await navigator.clipboard.writeText(location.href); toast('Link copied'); }
        catch (err) { window.prompt('Copy this link:', location.href); }
        return;
      }
      const task = e.target.closest('[data-id]');
      if (task) openTask(task.dataset.id);
    });
    root.addEventListener('change', (e) => {
      if (e.target === ref('crit')) { state.critical = e.target.checked; renderSchedule(); }
    });

    let lastW = window.innerWidth;
    let timer;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (M && window.innerWidth !== lastW && state.view === 'timeline') { lastW = window.innerWidth; renderSchedule(); }
      }, 120);
    };
    window.addEventListener('resize', onResize);

    function setSchedule(scheduleData) {
      const err = ref('error');
      const body = ref('body');
      const emptyEl = root.querySelector('[data-ref="empty"]');
      try {
        M = buildModel(scheduleData, { today: opts.today || params.get('today') });
      } catch (ex) {
        M = null;
        err.innerHTML = `<strong>The schedule couldn't be drawn.</strong><br>${esc(ex.message)}`;
        err.hidden = false;
        body.hidden = true;
        if (emptyEl) emptyEl.remove();
        return null;
      }
      err.hidden = true;
      if (M.empty) {
        body.hidden = true;
        if (!emptyEl) root.insertAdjacentHTML('beforeend', `<div data-ref="empty">${opts.emptyHTML || '<p class="empty">No tasks yet.</p>'}</div>`);
        return M;
      }
      if (emptyEl) emptyEl.remove();
      body.hidden = false;
      renderWarnings();
      ref('stats').innerHTML = statsHTML(M, phaseName);
      renderUpcoming();
      renderChips();
      renderShare();
      renderSchedule();
      renderTeam();
      return M;
    }

    const view = {
      setSchedule,
      openTask,
      get model() { return M; },
      destroy() { window.removeEventListener('resize', onResize); if (activeView === view) activeView = null; },
    };
    activeView = view;
    if (opts.schedule) setSchedule(opts.schedule);
    return view;
  }

  window.HomeGantt = {
    DAY_MS, esc, parseDate, toISO, fmt, fmtShort, fmtDay, plural, todayNum,
    buildModel, statusOf, isBehind, summarize, rangeShort, rangeLong, durationText,
    itemHTML, detailHTML, showDialog, createView,
  };
})();
