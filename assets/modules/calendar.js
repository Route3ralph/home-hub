/* =====================================================================
   HOME HUB — Calendar (v2)
   The family calendar: a week agenda (the phone default) and a month grid
   (the desktop default), filtered by person; event details with one-day
   changes for repeating events (change, skip, restore); tasks with their
   checkboxes and project tasks as bars (in the day lists: on the days a job
   starts and finishes, and one "N jobs in progress" line per project on the
   days between; in a phone's week strip, one bar per project). Also the event form, which the Add
   sheet and the Today page open with use('calendar').openEventForm(defaults).
   Everything on screen comes from agenda(from, to). Dates and times are the
   household's (core.v2.dates / fmt), never the device's.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { G, esc, q, toast, friendly, telHref, detailDialog, formDialog, wireFormDialog } = core;
  const { v2 } = core;
  const { fmt, dates, ui } = v2;
  const { plural } = G;

  const VIEW_KEY = 'homehub.calendar.view';     // 'week' or 'month', remembered on this device
  const PEOPLE_KEY = 'homehub.calendar.people'; // the person filter: a JSON list of people ids
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // ISO weekday 1..7
  const WD_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const COLOR = /^#[0-9a-fA-F]{6}$/;
  const BAR_ROWS = 3; // month grid: at most this many rows of bars (projects, trips) per week

  // The calendar on screen: { st, refresh(), stale() }, or null while another page shows.
  let page = null;

  // ============================================
  // HELPERS
  // ============================================
  // localStorage can be missing or throw (private browsing, storage turned off): just don't remember.
  function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* not remembered on this device */ }
  }

  function isIso(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    try { return dates.addDays(s, 0) === s; } catch (e) { return false; }
  }
  const daysBetween = (a, b) => G.parseDate(b) - G.parseDate(a);
  const hm = (t) => (t ? String(t).slice(0, 5) : '');   // '16:00:00' → '16:00' (what a time input holds)
  const monthTitle = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
  // The 1st of the month n months from iso's month.
  function addMonths(iso, n) {
    const m = Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1 + n;
    return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`;
  }
  // 'Dec 17', or 'Jan 5, 2027' when it isn't this year.
  const withYear = (label, iso) => (iso.slice(0, 4) === dates.today().slice(0, 4) ? label : `${label}, ${iso.slice(0, 4)}`);
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const daysOff = () => new Set(((v2.household && v2.household.days_off) || []).map(String));

  // People: colours, names, and "Taylor in charge, with Jordan".
  function colorOf(id) {
    const p = id ? v2.person(id) : null;
    return p && COLOR.test(p.color || '') ? p.color : null;
  }
  const itemColor = (it) => colorOf(it.responsible_id) || colorOf((it.participant_ids || [])[0]);
  const pcStyle = (c) => (c ? `--pc:${c};` : '');
  const others = (respId, ids) => (ids || []).filter((id) => id && id !== respId);

  function whoHTML(respId, ids) {
    const resp = v2.person(respId);
    const withPeople = others(respId, ids).map((id) => v2.person(id)).filter(Boolean);
    if (!resp && !withPeople.length) return '<span class="cal-muted">Nobody yet</span>';
    const dot = (p, ring) => `<span aria-hidden="true">${ui.personDot(p, { ring })}</span>`;
    return [
      resp ? `<span class="cal-who">${dot(resp, true)}${esc(resp.name)} <small>in charge</small></span>` : '',
      withPeople.length ? `<span class="cal-who">${resp ? 'with ' : ''}${withPeople.map((p) => `${dot(p, false)}${esc(p.name)}`).join(', ')}</span>` : '',
    ].join(' ');
  }
  function whoText(respId, ids) {
    const resp = v2.person(respId);
    const names = others(respId, ids).map((id) => v2.person(id)).filter(Boolean).map((p) => p.name);
    return [resp ? `${resp.name} in charge` : '', names.length ? `with ${names.join(', ')}` : ''].filter(Boolean).join(', ');
  }

  // Agenda rows: which day they end, whether they show as a bar, how they sort within a day.
  const endOf = (it) => (it.end_day && it.end_day > it.day ? it.end_day : it.day);
  const spans = (it) => it.kind === 'project' || (!!it.all_day && endOf(it) > it.day);
  const covers = (it, day) => it.day <= day && day <= endOf(it);
  // As private.item_order: timed items, then all-day events, project tasks, tasks without a time.
  const rank = (it) => (it.local_start ? 0 : it.kind === 'event' ? 1 : it.kind === 'project' ? 2 : 3);
  const byTime = (a, b) => rank(a) - rank(b) || String(a.local_start || '').localeCompare(String(b.local_start || ''))
    || String(a.title || '').localeCompare(String(b.title || ''));
  const barLabel = (it) => (it.kind === 'project' ? `${it.project_name || 'Project'}: ${it.title}` : it.title);

  // A copy for item rows and labels: an open task on a past day is late; a timed event that ends
  // after midnight keeps its times in the time column (the row's dates are for multi-day items).
  function shown(it, today) {
    const status = it.kind === 'task' && it.status === 'open' && it.day < today ? 'late' : it.status;
    return Object.assign({}, it, { status, end_day: it.all_day ? it.end_day : it.day });
  }

  // The person filter: nobody chosen = everyone. An item matches when someone chosen is in charge or with.
  const matches = (it, chosen) => !chosen.size || chosen.has(it.responsible_id) || (it.participant_ids || []).some((id) => chosen.has(id));

  // Project work in a day's list. A job that lasts days shows in full on the day it starts
  // ('starts') and the day it finishes ('finishes'); a milestone or a one-day job on its day ('on').
  // On the days between ('during') it folds, with the project's other jobs under way, into one quiet
  // line: "Kitchen Renovation · 3 jobs in progress". Otherwise weeks of "on order" would fill every day.
  function projectPhase(it, day) {
    if (it.milestone || endOf(it) === it.day) return it.day === day ? 'on' : null;
    if (day === it.day) return 'starts';
    if (day === endOf(it)) return 'finishes';
    return covers(it, day) ? 'during' : null;
  }
  // The project rows a day lists in full (started, finished or one-day that day).
  const projectRowOn = (it, day) => it.kind === 'project' && ['on', 'starts', 'finishes'].includes(projectPhase(it, day));
  // The projects with jobs under way on a day (between their start and finish), one group each, by name.
  function underWay(items, day) {
    const groups = new Map();
    items.filter((it) => it.kind === 'project' && projectPhase(it, day) === 'during').forEach((it) => {
      const id = it.project_id || it.item_id;
      if (!groups.has(id)) groups.set(id, { id, name: it.project_name || 'Project', items: [] });
      groups.get(id).items.push(it);
    });
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  // "3 jobs in progress"; jobs already ticked off on the project are counted apart ("1 done").
  function underWayText(items) {
    const open = items.filter((it) => it.status !== 'done').length;
    const done = items.length - open;
    if (!open) return `${plural(done, 'job')} done`;
    return `${plural(open, 'job')} in progress${done ? ` · ${done} done` : ''}`;
  }

  // Bars across a week's 7 columns (a..b, 0-based): each gets the first row that is free by then.
  function packRows(bars) {
    const ends = [];
    bars.sort((x, y) => x.a - y.a || y.b - x.b);
    bars.forEach((bar) => {
      let row = ends.findIndex((end) => end < bar.a);
      if (row < 0) { row = ends.length; ends.push(bar.b); } else ends[row] = bar.b;
      bar.row = row;
    });
    return ends.length;
  }
  const barsFor = (items, from, to) => items.filter((it) => it.day <= to && endOf(it) >= from)
    .map((it) => ({ it, a: Math.max(0, daysBetween(from, it.day)), b: Math.min(6, daysBetween(from, endOf(it))) }));
  const narrow = () => window.matchMedia('(max-width: 640px)').matches;

  // The week's strip: family items (a trip) in the top rows, project work below. On a phone a day is a
  // seventh of the screen, so a project with more than one job this week is one bar, "Kitchen Renovation
  // · 9 jobs", from its first day of work to its last (it opens the project; the day lists have each job):
  // a bar per job stacked six rows of "on order" above the first family event.
  function stripBars(items, from, to) {
    const family = barsFor(items.filter((it) => spans(it) && it.kind !== 'project'), from, to);
    let work = barsFor(items.filter((it) => it.kind === 'project'), from, to);
    if (narrow()) {
      const byProject = new Map();
      work.forEach((bar) => {
        const id = bar.it.project_id || bar.it.item_id;
        if (!byProject.has(id)) byProject.set(id, []);
        byProject.get(id).push(bar);
      });
      work = [...byProject.values()].map((bs) => (bs.length < 2 ? bs[0]
        : { it: bs[0].it, jobs: bs.map((bar) => bar.it), a: Math.min(...bs.map((bar) => bar.a)), b: Math.max(...bs.map((bar) => bar.b)) }));
    }
    const top = packRows(family);
    const below = packRows(work);
    work.forEach((bar) => { bar.row += top; });
    return { bars: family.concat(work), rows: top + below };
  }

  // 'Every Tue', 'Every weekday', 'Every 2 weeks on Mon, Wed until Dec 17'.
  function repeatSummary(ev) {
    if (!ev || ev.repeat !== 'weekly') return '';
    const days = [...new Set((ev.repeat_weekdays || []).map(Number))].sort((a, b) => a - b);
    const every = Number(ev.repeat_every) || 1;
    const names = days.map((d) => WD[d - 1]).join(', ');
    let text;
    if (every === 1 && days.length === 7) text = 'Every day';
    else if (every === 1 && sameSet(days, [1, 2, 3, 4, 5])) text = 'Every weekday';
    else if (every === 1) text = `Every ${names}`;
    else text = `Every ${every} weeks on ${names}`;
    if (ev.repeat_until) text += ` until ${withYear(fmt.short(ev.repeat_until), ev.repeat_until)}`;
    return text;
  }

  // One day of an event, from its row and that day's event_changes row, the way agenda() works it out.
  function occurrenceOf(ev, change, day) {
    const c = change || {};
    const moved = !!(c.start_time || c.end_time);
    const start = moved ? c.start_time || ev.start_time : ev.start_time;
    const end = moved ? c.end_time : ev.end_time;
    const nextDay = moved ? !!(c.end_time && hm(c.end_time) <= hm(start)) : !!ev.ends_next_day;
    const resp = c.responsible_id != null ? c.responsible_id : ev.responsible_id || null;
    return {
      day,
      end_day: ev.end_date || (start && nextDay ? dates.addDays(day, 1) : day),
      all_day: !start,
      local_start: start || null,
      local_end: start ? end || null : null,
      responsible_id: resp,
      participant_ids: others(resp, c.participant_ids != null ? c.participant_ids : ev.participant_ids),
      status: c.cancelled ? 'cancelled' : 'open',
    };
  }
  function whenText(occ) {
    if (occ.all_day) return occ.end_day > occ.day ? `${fmt.span(occ.day, occ.end_day)}, all day` : `${fmt.dayLong(occ.day)}, all day`;
    return `${fmt.dayLong(occ.day)} · ${fmt.range(occ)}${occ.end_day > occ.day ? ' (ends the next day)' : ''}`;
  }

  // Errors the database answers with, in plain words.
  function eventError(err) {
    const code = err && err.code;
    if (code === '23514') return "The event couldn't be saved: its dates, times or repeat don't fit together. Check them and try again.";
    if (code === '23503') return 'Someone on this event, or its directory contact, was removed a moment ago. Reload the page and try again.';
    return friendly(err);
  }
  const alreadyDone = (err) => /^already (done|completed)$/.test((err && err.message) || '');
  const taskError = (err) => (alreadyDone(err) ? (err.hint || 'Someone already ticked this off.') : friendly(err));

  // ============================================
  // DATA
  // ============================================
  const loadEvent = (id) => q(core.sb.from('events').select('*').eq('id', id).maybeSingle());
  async function loadChange(id, day) {
    const rows = await q(core.sb.from('event_changes').select('*').eq('event_id', id).eq('on_date', day));
    return (rows || [])[0] || null;
  }
  const saveChange = (row) => q(core.sb.from('event_changes').upsert(row, { onConflict: 'event_id,on_date' }).select());
  const dropChange = (id, day) => q(core.sb.from('event_changes').delete().eq('event_id', id).eq('on_date', day));
  // Put a day back the way it was before an action: its old change row, or none.
  const putBack = (ev, day, prev) => (prev ? saveChange(prev) : dropChange(ev.id, day));
  // The directory, for the event form's contact list; null if it couldn't be read.
  async function loadContractors() {
    try { return (await q(core.sb.from('contractors').select('id,name,company,phone,kind').order('name'))) || []; } catch (err) { return null; }
  }
  async function loadContact(id) {
    try { return await q(core.sb.from('contractors').select('id,name,company,phone').eq('id', id).maybeSingle()); } catch (err) { return null; }
  }

  // After a save: redraw the calendar if it's on screen (keeping the scroll), else re-render the page.
  function afterChange() {
    if (page && !page.stale()) return page.refresh();
    return core.route();
  }

  // ============================================
  // THE PAGE
  // ============================================
  function savedView() {
    const v = stored(VIEW_KEY);
    if (v === 'week' || v === 'month') return v;
    return window.matchMedia('(max-width: 640px)').matches ? 'week' : 'month';
  }
  function savedPeople() {
    let ids;
    try { ids = JSON.parse(stored(PEOPLE_KEY) || '[]'); } catch (e) { ids = []; }
    const active = new Set(v2.people().filter((p) => p.active !== false).map((p) => p.id));
    return new Set((Array.isArray(ids) ? ids : []).filter((id) => active.has(id)));
  }

  async function renderCalendar(main, ctx) {
    const p = ctx.params || {};
    const today = dates.today();
    const st = {
      main, ctx, today,
      view: savedView(),
      chosen: savedPeople(),
      anchor: p.date || p.occurrence || today,  // the date the week or month is built around
      selected: null,                           // month view: the day whose agenda shows beside the grid
      items: [],
      range: null,
      detailsOpen: false,                       // event details showing (the address names the event)
      detailsSeq: 0,
      openGroups: new Set(),                    // "<day>|<project id>": project lines opened to list their jobs
    };
    // A link to an event without a day: a one-off event shows on its own date.
    let linked = null;
    if (p.eventId && !p.occurrence) {
      try { linked = await loadEvent(p.eventId); } catch (err) { linked = null; }
      if (ctx.stale()) return;
      if (linked && linked.repeat !== 'weekly') st.anchor = linked.start_date;
    }
    st.selected = st.anchor;
    page = { st, refresh: () => refresh(st), stale: ctx.stale };
    ctx.signal.addEventListener('abort', () => { if (page && page.st === st) page = null; });
    detailDialog.addEventListener('close', () => detailsClosed(st), { signal: ctx.signal });
    // The week's strip folds project work on a phone only (stripBars()): redraw when a turn crosses that width.
    window.matchMedia('(max-width: 640px)').addEventListener('change', () => { if (st.range && st.view === 'week' && !ctx.stale()) draw(st); }, { signal: ctx.signal });

    await load(st);
    if (ctx.stale() || !p.eventId) return;
    const day = p.occurrence || (linked && linked.repeat !== 'weekly' ? linked.start_date : null);
    openEventDetails(st, p.eventId, day, findEvent(st, p.eventId, day));
  }

  function rangeOf(st) {
    if (st.view === 'week') {
      const from = dates.mondayOf(st.anchor);
      return { from, to: dates.addDays(from, 6) };
    }
    const grid = dates.monthGrid(st.anchor);
    return { from: grid[0][0], to: grid[5][6], grid }; // 42 days, inside agenda()'s 62-day limit
  }

  async function load(st) {
    const range = rangeOf(st);
    const rows = await v2.call('agenda', { p_from: range.from, p_to: range.to });
    if (st.ctx.stale()) return;
    st.range = range;
    st.items = Array.isArray(rows) ? rows : [];
    if (!(st.selected >= range.from && st.selected <= range.to)) st.selected = st.anchor;
    draw(st);
  }

  async function refresh(st) {
    try { await load(st); } catch (err) { if (!st.ctx.stale()) toast(friendly(err), { error: true }); }
  }

  const findEvent = (st, id, day) => st.items.find((it) => it.kind === 'event' && it.item_id === id && it.occurrence === day) || null;
  const calendarHash = (st) => `#/calendar/${st.view === 'month' ? st.selected : st.anchor}`;
  // Event details put the event in the address (so it can be shared and reloaded); closing them takes it out.
  function backToCalendar(st) {
    if (/^#\/calendar\/event\//.test(location.hash)) history.replaceState(null, '', calendarHash(st));
  }
  function detailsClosed(st) {
    if (!st.detailsOpen) return;
    st.detailsOpen = false;
    backToCalendar(st);
  }

  function draw(st) {
    const { main } = st;
    const week = st.view === 'week';
    const unit = week ? 'week' : 'month';
    const title = week ? withYear(fmt.span(st.range.from, st.range.to), st.range.to) : monthTitle(st.anchor);
    const people = v2.people().filter((p) => p.active !== false);
    main.innerHTML = `
      <div class="page-head cal-head">
        <div><p class="eyebrow">Calendar</p><h1>${esc(title)}</h1></div>
        <div class="page-actions"><button type="button" class="btn btn-primary cal-btn" data-act="add">+ Event</button></div>
      </div>
      <div class="cal-toolbar">
        <div class="cal-nav">
          <button type="button" class="btn cal-btn cal-arrow" data-act="prev" aria-label="Previous ${unit}">‹</button>
          <button type="button" class="btn cal-btn" data-act="today">Today</button>
          <button type="button" class="btn cal-btn cal-arrow" data-act="next" aria-label="Next ${unit}">›</button>
        </div>
        <div class="cal-views" role="group" aria-label="View">
          <button type="button" data-view="week" aria-pressed="${week}">Week</button>
          <button type="button" data-view="month" aria-pressed="${!week}">Month</button>
        </div>
      </div>
      ${people.length ? `<div class="cal-people" role="group" aria-label="Show whose plans">
        <button type="button" class="pchip cal-all" data-all aria-pressed="${!st.chosen.size}">Everyone</button>
        ${people.map((p) => ui.personChip(p, { selected: st.chosen.has(p.id) })).join('')}
      </div>` : ''}
      <div data-ref="body"></div>`;
    const body = main.querySelector('[data-ref="body"]');
    if (week) drawWeek(st, body); else drawMonth(st, body);
    main.onclick = (e) => onClick(st, e);
  }

  // One item row (core.v2.ui.itemRow) with a stripe in its person's colour.
  function itemRowFor(st, it, shownAs) {
    const row = ui.itemRow(shownAs || shown(it, st.today), {
      checkbox: true,
      showWho: true,
      onOpen: () => openItem(st, it),
      onToggle: () => tick(it),
      onUntick: () => untick(it),
    });
    const c = itemColor(it);
    if (c) row.style.setProperty('--pc', c);
    return row;
  }

  // A day's list: item rows, then one line per project with jobs under way that day (underWay()).
  // longer: the items that also show as bars (trips, project work), marked so they can look a little
  // different. A project job's row says "Starts" (until Dec 7) on the day it starts and "Finishes" on
  // the day it finishes, in place of its dates (markPhase()).
  function fillList(st, list, day, items, longer, groups) {
    const projects = groups || [];
    if (!items.length && !projects.length) { list.innerHTML = '<p class="empty-line">Nothing planned</p>'; return; }
    items.forEach((it) => {
      const row = itemRowFor(st, it);
      if (longer && longer.has(it)) row.classList.add('cal-span');
      const phase = it.kind === 'project' ? projectPhase(it, day) : null;
      if (phase === 'starts' || phase === 'finishes') markPhase(row, phase, endOf(it));
      list.appendChild(row);
    });
    projects.forEach((g) => list.appendChild(underWayLine(st, day, g)));
  }

  // A project job's row on its first or last day: "Starts" or "Finishes" where its dates were, and on
  // the first day "until Dec 7" ahead of the project's name (the time column is too narrow for it).
  function markPhase(row, phase, end) {
    const time = row.querySelector('.irow-time');
    time.classList.remove('untimed');
    time.classList.add('cal-phase');
    time.innerHTML = `<span>${phase === 'starts' ? 'Starts' : 'Finishes'}</span>`;
    if (phase !== 'starts') return;
    let sub = row.querySelector('.irow-sub');
    if (!sub) {
      sub = document.createElement('span');
      sub.className = 'irow-sub';
      row.querySelector('.irow-main').appendChild(sub);
    }
    // One run of text with the details after it ("until Dec 7 · Kitchen Renovation · Pat Lee"), so it wraps as words.
    const details = [...sub.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    const run = document.createElement('span');
    run.innerHTML = `<span class="cal-until">until ${esc(fmt.short(end))}</span>${details ? ` · ${esc(details.textContent.trim())}` : ''}`;
    if (details) details.replaceWith(run); else sub.appendChild(run);
  }

  // "Kitchen Renovation · 3 jobs in progress": a muted line that opens (a tap) to list those jobs,
  // each with its dates, opening the project. Stays open across redraws while the page is up.
  function underWayLine(st, day, g) {
    const key = `${day}|${g.id}`;
    const box = document.createElement('details');
    box.className = 'cal-ongoing';
    box.dataset.project = g.id;
    box.dataset.day = day;
    box.open = st.openGroups.has(key);
    const c = itemColor(g.items[0]);
    if (c) box.style.setProperty('--pc', c);
    // It wraps only at a "·" ("2 jobs in progress" stays together on a narrow panel).
    const counts = underWayText(g.items).split(' · ').map((s) => `<span class="cal-nb">${esc(s)}</span>`).join(' · ');
    box.innerHTML = `<summary><span class="cal-ongoing-text"><b>${esc(g.name)}</b> · ${counts}</span><span class="cal-ongoing-chev" aria-hidden="true"></span></summary>
      <div class="irows cal-ongoing-list"></div>`;
    const inner = box.querySelector('.cal-ongoing-list');
    // The project's name is on the line already, so each job's row leaves it out.
    g.items.slice().sort(byTime).forEach((it) => inner.appendChild(itemRowFor(st, it, Object.assign(shown(it, st.today), { project_name: null }))));
    box.addEventListener('toggle', () => { if (box.open) st.openGroups.add(key); else st.openGroups.delete(key); });
    return box;
  }

  function dayHead(d, id, long) {
    const label = long ? fmt.dayLong(d) : fmt.day(d);
    const rel = fmt.relDay(d);
    return `<div class="cal-day-head">
      <h2 id="${id}">${rel !== fmt.day(d) ? `<b>${esc(rel)}</b> ` : ''}<span>${esc(label)}</span></h2>
      ${daysOff().has(d) ? '<span class="cal-off">Day off</span>' : ''}
      <button type="button" class="cal-add" data-add-day="${esc(d)}" aria-label="Add an event on ${esc(fmt.dayLong(d))}">+</button>
    </div>`;
  }

  // ---------- Week: projects and longer events as bars across the week, then one list per day. Each
  // day's list starts with the longer events that cover it (a weekend away): on a phone the strip has
  // scrolled away by Saturday. Project work shows on the days a job starts and finishes, and in
  // between as one "N jobs in progress" line per project at the end of the day (projectPhase()).
  function drawWeek(st, body) {
    const days = Array.from({ length: 7 }, (_, i) => dates.addDays(st.range.from, i));
    const visible = st.items.filter((it) => matches(it, st.chosen));
    const { bars, rows } = stripBars(visible, days[0], days[6]);
    body.innerHTML = `
      ${bars.length ? `<section class="cal-strip" aria-label="Projects and longer events this week">
        <div class="cal-strip-grid" style="grid-template-rows:auto repeat(${rows}, auto)">
          ${days.map((d, i) => `<span class="cal-strip-day${d === st.today ? ' is-today' : ''}" style="grid-column:${i + 1}" aria-hidden="true">${WD[i].slice(0, 1)}<b>${Number(d.slice(8))}</b></span>`).join('')}
          ${bars.map((bar) => barButton(st, bar, days[0], days[6])).join('')}
        </div>
      </section>` : ''}
      <div class="cal-days">${days.map((d) => `<section class="cal-day${d === st.today ? ' is-today' : ''}" aria-labelledby="cal-h-${d}">
        ${dayHead(d, `cal-h-${d}`, false)}
        <div class="irows cal-list" data-list="${d}"></div>
      </section>`).join('')}</div>`;
    days.forEach((d) => {
      const longer = visible.filter((it) => spans(it) && it.kind !== 'project' && covers(it, d)).sort(byTime);
      const own = visible.filter((it) => (!spans(it) && it.day === d) || projectRowOn(it, d)).sort(byTime);
      fillList(st, body.querySelector(`[data-list="${d}"]`), d, longer.concat(own), new Set(longer.concat(own.filter(spans))), underWay(visible, d));
    });
  }

  function barButton(st, bar, from, to) {
    const it = bar.it;
    if (bar.jobs) return projectBar(st, bar, from, to);
    const cls = ['cal-bar', `k-${it.kind}`, `st-${it.status}`, it.day < from ? 'cont-l' : '', endOf(it) > to ? 'cont-r' : ''].filter(Boolean).join(' ');
    const label = `${barLabel(it)}, ${fmt.span(it.day, endOf(it))}${it.status === 'cancelled' ? ', skipped' : ''}`;
    return `<button type="button" class="${cls}" style="grid-column:${bar.a + 1} / ${bar.b + 2};grid-row:${bar.row + 2};${pcStyle(itemColor(it))}"
      data-item="${st.items.indexOf(it)}" aria-label="${esc(label)}" title="${esc(label)}">${it.kind === 'project'
  ? `<span class="cal-bar-proj">${esc(it.project_name || 'Project')}: </span>${esc(it.title)}` : esc(barLabel(it))}</button>`;
  }

  // A project's jobs this week as one bar (phones, stripBars()); its label names them. A tap opens the project.
  function projectBar(st, bar, from, to) {
    const { it, jobs } = bar;
    const name = it.project_name || 'Project';
    const allDone = jobs.every((j) => j.status === 'done');
    const cls = ['cal-bar', 'cal-bar-fold', 'k-project', allDone ? 'st-done' : '',
      bar.a === 0 && jobs.some((j) => j.day < from) ? 'cont-l' : '', bar.b === 6 && jobs.some((j) => endOf(j) > to) ? 'cont-r' : ''].filter(Boolean).join(' ');
    const label = `${name}: ${plural(jobs.length, 'job')} this week (${jobs.map((j) => j.title).join(', ')})`;
    return `<button type="button" class="${cls}" style="grid-column:${bar.a + 1} / ${bar.b + 2};grid-row:${bar.row + 2};${pcStyle(itemColor(it))}"
      data-item="${st.items.indexOf(it)}" aria-label="${esc(label)}" title="${esc(label)}"><span class="cal-bar-name">${esc(name)}</span> <span class="cal-bar-n">· ${esc(plural(jobs.length, 'job'))}</span></button>`;
  }

  // ---------- Month: six weeks of day cells (tap one for its agenda), labels or dots coloured by person
  function drawMonth(st, body) {
    const month = st.anchor.slice(0, 7);
    const visible = st.items.filter((it) => matches(it, st.chosen));
    const off = daysOff();
    body.innerHTML = `<div class="cal-month-wrap">
      <div class="cal-month">
        <div class="cal-wkhead" aria-hidden="true">${WD.map((w) => `<span>${w}</span>`).join('')}</div>
        ${st.range.grid.map((week) => weekHTML(st, week, month, visible, off)).join('')}
      </div>
      <section class="cal-panel" data-ref="panel" aria-labelledby="cal-panel-h" aria-live="polite"></section>
    </div>`;
    drawPanel(st, visible);
  }

  function weekHTML(st, week, month, visible, off) {
    const from = week[0];
    const bars = barsFor(visible.filter(spans), from, week[6]);
    const used = Math.min(BAR_ROWS, packRows(bars));
    const last = used + 2;
    let html = `<div class="cal-week" style="grid-template-rows:auto${used ? ` repeat(${used}, var(--cal-bar-h))` : ''} 1fr">`;
    week.forEach((d, i) => {
      const own = visible.filter((it) => !spans(it) && it.day === d).sort(byTime);
      const across = bars.filter((b) => b.a <= i && i <= b.b);
      const more = Math.max(0, own.length - 3) + across.filter((b) => b.row >= BAR_ROWS).length;
      const total = own.length + across.length;
      const flags = [d.slice(0, 7) !== month ? 'is-out' : '', d === st.today ? 'is-today' : '', off.has(d) ? 'is-off' : ''];
      const label = `${fmt.dayLong(d)}${d === st.today ? ', today' : ''}${off.has(d) ? ', day off' : ''}: ${total ? plural(total, 'item') : 'nothing planned'}`;
      html += `<button type="button" class="${['cal-cell', i === 0 ? 'is-first' : '', d === st.selected ? 'is-sel' : ''].concat(flags).filter(Boolean).join(' ')}"
        style="grid-column:${i + 1};grid-row:1 / -1" data-day="${d}" aria-pressed="${d === st.selected}" aria-label="${esc(label)}"></button>
        <span class="${['cal-num'].concat(flags).filter(Boolean).join(' ')}" data-for="${d}" style="grid-column:${i + 1};grid-row:1" aria-hidden="true">${d.slice(8) === '01' ? esc(fmt.short(d)) : Number(d.slice(8))}</span>
        <span class="cal-items" data-for="${d}" style="grid-column:${i + 1};grid-row:${last}" aria-hidden="true">${own.slice(0, 3).map((it) => labelHTML(st, it)).join('')}${more ? `<span class="cal-extra">+${more}</span>` : ''}</span>`;
    });
    html += bars.filter((b) => b.row < BAR_ROWS).map((b) => {
      const it = b.it;
      const cls = ['cal-mbar', `k-${it.kind}`, `st-${it.status}`, it.day < from ? 'cont-l' : '', endOf(it) > week[6] ? 'cont-r' : ''].filter(Boolean).join(' ');
      return `<span class="${cls}" style="grid-column:${b.a + 1} / ${b.b + 2};grid-row:${b.row + 2};${pcStyle(itemColor(it))}" aria-hidden="true">${esc(barLabel(it))}</span>`;
    }).join('');
    return `${html}</div>`;
  }

  function labelHTML(st, it) {
    const status = shown(it, st.today).status;
    const time = it.local_start ? fmt.time(it.local_start).replace(':00', '') : '';
    return `<span class="cal-lab k-${esc(it.kind)} st-${esc(status)}" style="${pcStyle(itemColor(it))}"><i class="cal-dot"></i><span class="cal-lab-t">${time ? `${esc(time)} ` : ''}${esc(it.title)}</span></span>`;
  }

  function drawPanel(st, visible) {
    const panel = st.main.querySelector('[data-ref="panel"]');
    if (!panel) return;
    panel.innerHTML = `${dayHead(st.selected, 'cal-panel-h', true)}<div class="irows cal-list"></div>`;
    const day = st.selected;
    const items = visible || st.items.filter((it) => matches(it, st.chosen));
    // Project work as in the week's lists: rows on its start and finish days, a line per project between.
    fillList(st, panel.querySelector('.cal-list'), day, items.filter((it) => (it.kind === 'project' ? projectRowOn(it, day) : covers(it, day))).sort(byTime),
      null, underWay(items, day));
  }

  function selectDay(st, day) {
    st.selected = day;
    st.main.querySelectorAll('.cal-cell').forEach((c) => {
      const on = c.dataset.day === day;
      c.classList.toggle('is-sel', on);
      c.setAttribute('aria-pressed', String(on));
    });
    drawPanel(st);
    history.replaceState(null, '', `#/calendar/${day}`);
    const panel = st.main.querySelector('[data-ref="panel"]');
    if (panel && window.matchMedia('(max-width: 1023px)').matches) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function setView(st, view) {
    if (st.view === view) return;
    st.view = view;
    store(VIEW_KEY, view);
    if (view === 'week') st.anchor = st.selected || st.anchor;
    else {
      const monday = dates.mondayOf(st.anchor);
      st.anchor = st.today >= monday && st.today <= dates.addDays(monday, 6) ? st.today : st.anchor;
    }
    st.selected = st.anchor;
    history.replaceState(null, '', `#/calendar/${st.anchor}`);
    try { await load(st); } catch (err) { toast(friendly(err), { error: true }); }
  }

  // Prev / next / Today change the address, so each step is a page of its own (Back works).
  function step(st, dir) {
    let target;
    if (st.view === 'week') target = dates.addDays(dates.mondayOf(st.anchor), 7 * dir);
    else {
      target = addMonths(st.anchor, dir);
      if (target.slice(0, 7) === st.today.slice(0, 7)) target = st.today;
    }
    location.hash = `#/calendar/${target}`;
  }

  // The day "+ Event" adds to: the chosen day (month), today if it's in the week shown, or that Monday.
  function addDay(st) {
    if (st.view === 'month') return st.selected;
    return st.today >= st.range.from && st.today <= st.range.to ? st.today : st.range.from;
  }
  const onlyChosen = (st) => (st.chosen.size === 1 ? [...st.chosen][0] : null);

  function onClick(st, e) {
    const t = e.target;
    const act = t.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'prev') step(st, -1);
      else if (a === 'next') step(st, 1);
      else if (a === 'today') {
        if (location.hash === '#/calendar') core.route();
        else location.hash = '#/calendar';
      } else if (a === 'add') openForm({ date: addDay(st), responsible_id: onlyChosen(st) });
      return;
    }
    const view = t.closest('[data-view]');
    if (view) { setView(st, view.dataset.view); return; }
    if (t.closest('[data-all]')) { setChosen(st, new Set(), '[data-all]'); return; }
    const chip = t.closest('.cal-people [data-person]');
    if (chip) {
      const next = new Set(st.chosen);
      if (next.has(chip.dataset.person)) next.delete(chip.dataset.person); else next.add(chip.dataset.person);
      setChosen(st, next, `.cal-people [data-person="${chip.dataset.person}"]`);
      return;
    }
    const add = t.closest('[data-add-day]');
    if (add) { openForm({ date: add.dataset.addDay, responsible_id: onlyChosen(st) }); return; }
    const cell = t.closest('.cal-cell');
    if (cell) { selectDay(st, cell.dataset.day); return; }
    const bar = t.closest('[data-item]');
    if (bar) openItem(st, st.items[Number(bar.dataset.item)]);
  }

  function setChosen(st, chosen, focusSel) {
    st.chosen = chosen;
    store(PEOPLE_KEY, JSON.stringify([...chosen]));
    draw(st);
    const again = st.main.querySelector(focusSel);
    if (again) again.focus();
  }

  const openForm = (defaults) => openEventForm(defaults).catch((err) => toast(eventError(err), { error: true }));

  function openItem(st, it) {
    if (!it) return;
    if (it.kind === 'event') openEventDetails(st, it.item_id, it.occurrence, it);
    else if (it.kind === 'task') openTaskDetails(st, it);
    else if (it.kind === 'project') location.hash = `#/projects/${encodeURIComponent(it.project_id || it.item_id)}`;
  }

  // ============================================
  // TASKS (ticked off here; everything else about them is on the Tasks page)
  // ============================================
  // Ticks one occurrence off, with a 6-second Undo. If the screen was out of date (someone else ticked
  // it), the calendar is redrawn; the error is thrown on so the box unticks and the reason shows.
  async function tick(it) {
    let logId;
    try {
      logId = await v2.call('complete_task', { p_id: it.item_id, p_occurrence: it.occurrence });
    } catch (err) {
      if (alreadyDone(err)) afterChange();
      throw new Error(taskError(err));
    }
    toast(`Done: ${it.title}`, {
      action: {
        label: 'Undo',
        async onClick() {
          await v2.call('undo_task', { p_log_id: logId });
          toast(`${it.title} is back on the list`);
          afterChange();
        },
      },
    });
    afterChange();
  }

  // A tap on a ticked box, after "Mark … as not done?": its task log entry is undone.
  async function untick(it) {
    await v2.undoDone(it);
    toast(`${it.title} is back on the list`);
    afterChange();
  }

  function openTaskDetails(st, it) {
    st.detailsSeq++;
    const x = shown(it, st.today);
    const canTick = x.status === 'open' || x.status === 'late';
    const badge = { late: 'Late', done: 'Done', skipped: 'Skipped' }[x.status];
    G.showDialog(detailDialog, `<div class="cal-details">
      <div class="d-top"><span class="d-trade"><i class="dot" style="--c:${itemColor(it) || 'var(--text-3)'}"></i>${it.repeating ? 'Repeating task' : 'Task'}</span>
        <button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <h3 id="dTitle">${esc(it.title)}</h3>
      ${badge ? `<p class="cal-flag${x.status === 'late' ? ' is-skip' : ''}">${badge}</p>` : ''}
      <dl>
        <dt>Due</dt><dd>${esc(fmt.dayLong(it.day))}${it.local_start ? ` · ${esc(fmt.time(it.local_start))}` : ''}</dd>
        <dt>Who</dt><dd class="cal-whos">${whoHTML(it.responsible_id, it.participant_ids)}</dd>
        ${it.project_name ? `<dt>Project</dt><dd><a href="#/projects/${encodeURIComponent(it.project_id)}">${esc(it.project_name)}</a></dd>` : ''}
        ${contactHTML(it.contractor_name, it.contractor_phone)}
        ${it.private ? '<dt>Private</dt><dd>Kids and helpers see "Private item"</dd>' : ''}
      </dl>
      ${it.notes ? `<p class="d-note">${esc(it.notes)}</p>` : ''}
      <div class="d-actions">
        ${canTick ? '<button type="button" class="btn btn-primary" data-task="done">Mark done</button>' : ''}
        <a class="btn" href="#/tasks/${encodeURIComponent(it.item_id)}${x.status === 'done' ? '/done' : ''}">Open in Tasks</a>
      </div></div>`);
    const done = detailDialog.querySelector('[data-task="done"]');
    if (done) {
      done.addEventListener('click', async () => {
        done.disabled = true;
        try {
          await tick(it);
          detailDialog.close();
        } catch (err) {
          done.disabled = false;
          toast(err.message, { error: true });
        }
      });
    }
  }

  function contactHTML(name, phone) {
    if (!name && !phone) return '';
    return `<dt>Contact</dt><dd class="cal-contact"><span>${esc(name || '')}</span>${phone
      ? `<a class="btn cal-call" href="${esc(telHref(phone))}" aria-label="Call ${esc(name || '')} ${esc(phone)}">${ui.icon.phone}${esc(phone)}</a>` : ''}</dd>`;
  }

  // ============================================
  // EVENT DETAILS
  // ============================================
  async function openEventDetails(st, id, day, item) {
    const seq = ++st.detailsSeq;
    G.showDialog(detailDialog, `<div class="cal-details"><div class="d-top"><span class="d-trade">Event</span>
      <button type="button" class="d-close" data-close aria-label="Close">×</button></div><p class="loading" id="dTitle">Loading…</p></div>`);
    let ev;
    let change = null;
    let contact = null;
    try {
      [ev, change] = await Promise.all([loadEvent(id), day ? loadChange(id, day) : null]);
      if (ev && ev.contractor_id) {
        contact = item && item.contractor_id === ev.contractor_id
          ? { name: item.contractor_name, phone: item.contractor_phone } : await loadContact(ev.contractor_id);
      }
    } catch (err) {
      if (seq === st.detailsSeq && !st.ctx.stale()) { detailDialog.close(); backToCalendar(st); toast(friendly(err), { error: true }); }
      return;
    }
    // Closed while loading, or another item was opened since.
    if (st.ctx.stale() || seq !== st.detailsSeq || !detailDialog.open) return;
    if (!ev) {
      detailDialog.close();
      backToCalendar(st);
      toast("That event isn't on the calendar any more.", { error: true });
      return;
    }
    const repeating = ev.repeat === 'weekly';
    const onDay = repeating && !!day;           // one-day actions need to know which day
    const occ = occurrenceOf(ev, change, day || ev.start_date);
    const color = colorOf(occ.responsible_id) || colorOf(occ.participant_ids[0]);
    const flag = occ.status === 'cancelled' ? '<p class="cal-flag is-skip">Skipped this day</p>' : change ? '<p class="cal-flag">Changed this day</p>' : '';
    G.showDialog(detailDialog, `<div class="cal-details">
      <div class="d-top"><span class="d-trade"><i class="dot" style="--c:${color || 'var(--text-3)'}"></i>${repeating ? 'Repeating event' : 'Event'}</span>
        <button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <h3 id="dTitle">${esc(ev.title)}</h3>
      ${flag}
      <dl>
        <dt>When</dt><dd>${esc(repeating && !day ? `${fmt.range(occ)}, from ${fmt.dayLong(ev.start_date)}` : whenText(occ))}</dd>
        ${repeating ? `<dt>Repeats</dt><dd>${esc(repeatSummary(ev))}${ev.skip_days_off ? ', not on days off' : ''}</dd>`
          : ev.skip_days_off ? '<dt>Days off</dt><dd>Not on days off</dd>' : ''}
        <dt>Who</dt><dd class="cal-whos">${whoHTML(occ.responsible_id, occ.participant_ids)}</dd>
        ${ev.location ? `<dt>Place</dt><dd>${esc(ev.location)}</dd>` : ''}
        ${contact ? contactHTML(contact.name, contact.phone) : ''}
        ${ev.private ? '<dt>Private</dt><dd>Kids and helpers see "Private item"</dd>' : ''}
      </dl>
      ${change && change.note ? `<p class="d-note"><b>This day:</b> ${esc(change.note)}</p>` : ''}
      ${ev.notes ? `<p class="d-note">${esc(ev.notes)}</p>` : ''}
      <p class="form-error" role="alert" hidden></p>
      <div class="d-actions">
        ${onDay ? '<button type="button" class="btn btn-primary" data-ev="change">Change this day</button>' : ''}
        ${onDay && occ.status !== 'cancelled' ? '<button type="button" class="btn" data-ev="skip">Skip this day</button>' : ''}
        ${onDay && change ? '<button type="button" class="btn" data-ev="restore">Restore this day</button>' : ''}
        <button type="button" class="btn${onDay ? '' : ' btn-primary'}" data-ev="edit">${repeating ? 'Edit all days' : 'Edit'}</button>
        <button type="button" class="btn btn-danger cal-right" data-ev="delete">Delete</button>
      </div></div>`);
    st.detailsOpen = true;
    const address = `#/calendar/event/${encodeURIComponent(ev.id)}${day ? `/${day}` : ''}`;
    if (location.hash !== address) history.replaceState(null, '', address);
    detailDialog.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => eventAction(b, { ev, change, occ, day })));
  }

  async function eventAction(btn, x) {
    const { ev, change, day } = x;
    const act = btn.dataset.ev;
    const errBox = detailDialog.querySelector('.form-error');
    if (act === 'edit') { detailDialog.close(); openForm({ event: ev }); return; }
    if (act === 'change') { detailDialog.close(); openChangeForm(ev, change, x.occ, day); return; }
    btn.disabled = true;
    errBox.hidden = true;
    try {
      if (act === 'delete') {
        if (await deleteEvent(ev)) { detailDialog.close(); afterChange(); }
      } else if (act === 'skip') {
        await saveChange({ event_id: ev.id, on_date: day, cancelled: true });
        detailDialog.close();
        toast(`Skipped ${ev.title} on ${fmt.day(day)}`, { action: { label: 'Undo', onClick: () => undoDay(ev, day, change) } });
        afterChange();
      } else if (act === 'restore') {
        await dropChange(ev.id, day);
        detailDialog.close();
        toast(`${ev.title} is back to normal on ${fmt.day(day)}`, { action: { label: 'Undo', onClick: () => undoDay(ev, day, change) } });
        afterChange();
      }
    } catch (err) {
      errBox.textContent = eventError(err);
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function undoDay(ev, day, prev) {
    await putBack(ev, day, prev);
    toast(`Undone: ${ev.title} on ${fmt.day(day)} is as it was`);
    afterChange();
  }

  // Deletes the event (every day of a repeating one) after asking, with an Undo that puts it back,
  // one-day changes included. Resolves false if they said no.
  async function deleteEvent(ev) {
    const repeating = ev.repeat === 'weekly';
    if (!window.confirm(repeating ? `Delete "${ev.title}" on every day it repeats?` : `Delete "${ev.title}"?`)) return false;
    let changes = [];
    if (repeating) {
      try { changes = (await q(core.sb.from('event_changes').select('*').eq('event_id', ev.id))) || []; } catch (err) { changes = []; }
    }
    await q(core.sb.from('events').delete().eq('id', ev.id));
    toast(`Deleted ${ev.title}`, {
      action: {
        label: 'Undo',
        async onClick() {
          await q(core.sb.from('events').insert(ev));
          if (changes.length) await q(core.sb.from('event_changes').insert(changes));
          toast(`${ev.title} is back on the calendar`);
          afterChange();
        },
      },
    });
    return true;
  }

  // ============================================
  // CHANGE THIS DAY (one day of a repeating event: time, who, a note)
  // Writes event_changes for (event, day). Whatever matches the series is saved as "no change" (null),
  // so a later edit of the whole series still reaches this day.
  // ============================================
  function openChangeForm(ev, change, occ, day) {
    wireFormDialog();
    const usual = [ev.start_time ? fmt.range({ day, local_start: ev.start_time, local_end: ev.end_time }) : 'all day',
      whoText(ev.responsible_id, ev.participant_ids)].filter(Boolean).join(', ');
    formDialog.innerHTML = `<form class="form d-inner cal-form" novalidate>
      <div class="d-top"><h3>Change ${esc(fmt.day(day))} only</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <p class="meta cal-usual">${esc(ev.title)} is usually ${esc(usual)}. Other days stay as they are.</p>
      <div class="cal-row">
        <label class="field"><span>Starts</span><input type="time" name="start_time" value="${esc(hm(occ.local_start))}"></label>
        <label class="field"><span>Ends</span><input type="time" name="end_time" value="${esc(hm(occ.local_end))}"></label>
      </div>
      <small class="cal-hint">An end time before the start means it ends the next day.</small>
      <fieldset class="cal-fs"><legend>Who</legend><div data-ref="who"></div></fieldset>
      <label class="field"><span>Note for this day</span><input type="text" name="note" maxlength="300" value="${esc((change && change.note) || '')}" placeholder="Pick up at the side door"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save this day</button>
      </div>
    </form>`;
    const form = formDialog.querySelector('form');
    const errBox = form.querySelector('.form-error');
    const who = ui.whoPicker(form.querySelector('[data-ref="who"]'), { responsibleId: occ.responsible_id, participantIds: occ.participant_ids });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fail = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
      const start = form.elements.start_time.value;
      const end = form.elements.end_time.value;
      const note = form.elements.note.value.trim();
      if (end && !start) return fail('Add a start time too, or clear the end time.');
      if (!start && ev.start_time) return fail(`Add a start time. To take ${fmt.day(day)} off the calendar, skip the day instead.`);
      const w = who.value();
      const sameTime = start === hm(ev.start_time) && end === hm(ev.end_time);
      const sameWho = (w.responsibleId || null) === (ev.responsible_id || null) && sameSet(w.participantIds, others(ev.responsible_id, ev.participant_ids));
      if (!w.responsibleId && ev.responsible_id && !sameWho) {
        return fail('Someone has to be in charge on a changed day. Tap a name to put them in charge, or skip the day instead.');
      }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      errBox.hidden = true;
      try {
        if (sameTime && sameWho && !note) {
          // Nothing differs from the usual: the day goes back to normal.
          if (change) await dropChange(ev.id, day);
          formDialog.close();
          toast(change ? `${ev.title} is back to normal on ${fmt.day(day)}` : 'Nothing changed');
        } else {
          await saveChange({
            event_id: ev.id, on_date: day, cancelled: false,
            start_time: sameTime ? null : start || null, end_time: sameTime ? null : end || null,
            responsible_id: sameWho ? null : w.responsibleId, participant_ids: sameWho ? null : w.participantIds,
            note: note || null,
          });
          formDialog.close();
          toast(`Changed ${ev.title} on ${fmt.day(day)}`, { action: { label: 'Undo', onClick: () => undoDay(ev, day, change) } });
        }
        afterChange();
      } catch (err) {
        fail(eventError(err));
      } finally {
        btn.disabled = false;
      }
    });
    if (!formDialog.open) formDialog.showModal();
  }

  // ============================================
  // THE EVENT FORM
  // openEventForm(defaults): a new event, or { event: row } / { id } to edit one (the whole series).
  // defaults for a new one: date (or start_date; else the day the calendar shows, or today), start_time,
  // all_day, title, responsible_id (or responsibleId), participant_ids (or participantIds); onSaved()
  // instead of redrawing the page.
  // What · When · Who · Repeats (with "Not on days off") · More (end time, place, contact, notes, private).
  // ============================================
  const PRESETS = ['none', 'weekly', 'weekdays', 'daily', 'custom'];

  // Which repeat button an existing event matches.
  function presetOf(ev) {
    if (!ev || ev.repeat !== 'weekly') return 'none';
    const days = [...new Set((ev.repeat_weekdays || []).map(Number))].sort((a, b) => a - b);
    const every = Number(ev.repeat_every) || 1;
    if (every === 1 && sameSet(days, [dates.isoWeekday(ev.start_date)])) return 'weekly';
    if (every === 1 && sameSet(days, [1, 2, 3, 4, 5])) return 'weekdays';
    if (every === 1 && days.length === 7) return 'daily';
    return 'custom';
  }

  async function openEventForm(defaults) {
    const d = defaults || {};
    let ev = d.event || null;
    if (!ev && d.id) {
      ev = await loadEvent(d.id);
      if (!ev) throw new Error("That event isn't on the calendar any more.");
    }
    const contractors = await loadContractors();
    const x = ev || {};
    const today = dates.today();
    const tomorrow = dates.addDays(today, 1);
    const preset = presetOf(ev);
    const state = {
      preset,
      every: preset === 'custom' ? Number(ev.repeat_every) || 1 : 1,
      custom: new Set(preset === 'custom' ? ev.repeat_weekdays.map(Number) : []),
      daysOffTouched: false, // "Not on days off" ticked or unticked by hand: the repeat buttons leave it alone
    };
    // Without a date (the Add sheet), a new event starts on the day the calendar shows, if it's on screen.
    const shownDay = page && !page.stale() && page.st.range ? addDay(page.st) : null;
    const startDate = ev ? ev.start_date : [d.date, d.start_date, shownDay].find(isIso) || today;
    const allDay = ev ? !ev.start_time : !!d.all_day;
    const moreOpen = !!(x.end_time || x.location || x.contractor_id || x.notes || x.private);
    // "Not on days off" belongs to a repeat (the school run on a school holiday); a one-off keeps it
    // only if it already has it.
    const oneOffSkips = !!(ev && ev.repeat !== 'weekly' && ev.skip_days_off);
    const options = (contractors || []).map((c) => [c.id, c.company && c.company !== c.name ? `${c.name} (${c.company})` : c.name]);
    if (x.contractor_id && !options.some(([id]) => id === x.contractor_id)) options.unshift([x.contractor_id, 'The current contact']);

    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = `<form class="form d-inner cal-form" novalidate>
      <div class="d-top"><h3>${ev ? 'Edit event' : 'New event'}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      ${ev && ev.repeat === 'weekly' ? '<p class="meta cal-usual">This changes every day it repeats. To change one day, open that day and use Change this day.</p>' : ''}
      <label class="field"><span>What</span><input type="text" name="title" value="${esc(x.title || d.title || '')}" maxlength="200" autocomplete="off" placeholder="Piano lesson, school pickup, dentist"></label>
      <fieldset class="cal-fs"><legend>When</legend>
        <div class="cal-chips">
          <button type="button" class="cal-chip" data-date="${today}">Today</button>
          <button type="button" class="cal-chip" data-date="${tomorrow}">Tomorrow</button>
          <input type="date" name="start_date" value="${esc(startDate)}" aria-label="Date">
        </div>
        <div class="cal-row">
          <input type="time" name="start_time" value="${esc(hm(ev ? ev.start_time : d.start_time))}" aria-label="Start time">
          <label class="check cal-check"><input type="checkbox" name="all_day"${allDay ? ' checked' : ''}> All day</label>
        </div>
        <label class="field" data-show="ends"><span>Ends <small>(when it lasts a few days)</small></span><input type="date" name="end_date" value="${esc(x.end_date || '')}"></label>
      </fieldset>
      <fieldset class="cal-fs"><legend>Who</legend><div data-ref="who"></div></fieldset>
      <fieldset class="cal-fs"><legend>Repeats</legend>
        <div class="cal-chips" data-ref="presets">${PRESETS.map((k) => `<button type="button" class="cal-chip" data-preset="${k}"></button>`).join('')}</div>
        <div class="cal-custom" data-show="custom">
          <select name="repeat_every" aria-label="How often">${[1, 2, 3, 4].map((n) => `<option value="${n}"${n === state.every ? ' selected' : ''}>${n === 1 ? 'Every week' : `Every ${n} weeks`}</option>`).join('')}</select>
          <div class="cal-wdays" role="group" aria-label="On these days">${WD.map((w, i) => `<button type="button" class="cal-wd" data-wd="${i + 1}" aria-label="${WD_LONG[i]}">${w.slice(0, 2)}</button>`).join('')}</div>
          <small class="cal-hint">The first date's day of the week is always included.</small>
        </div>
        <label class="field" data-show="until"><span>Until <small>(optional)</small></span><input type="date" name="repeat_until" value="${esc(x.repeat_until || '')}"></label>
        <label class="check cal-check" data-show="daysoff"><input type="checkbox" name="skip_days_off"${x.skip_days_off ? ' checked' : ''}> Not on days off (school holidays)</label>
      </fieldset>
      <details class="cal-more"${moreOpen ? ' open' : ''}>
        <summary>More: end time, place, contact, notes</summary>
        <div class="cal-more-body">
          <div class="cal-row" data-show="endtime">
            <label class="field"><span>Ends at</span><input type="time" name="end_time" value="${esc(hm(x.end_time))}"></label>
            <label class="check cal-check"><input type="checkbox" name="ends_next_day"${x.ends_next_day ? ' checked' : ''}> Ends the next day</label>
          </div>
          <label class="field"><span>Place</span><input type="text" name="location" value="${esc(x.location || '')}" maxlength="200" placeholder="Music school"></label>
          <label class="field"><span>Directory contact</span><select name="contractor_id"><option value="">None</option>${options.map(([id, label]) => `<option value="${esc(id)}"${id === x.contractor_id ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
            <small>${contractors ? 'Their phone number shows on the event, one tap to call.' : "Couldn't load the directory just now. Try again later to pick a contact."}</small></label>
          <label class="field"><span>Notes</span><textarea name="notes" rows="3">${esc(x.notes || '')}</textarea></label>
          <label class="check cal-check"><input type="checkbox" name="private"${x.private ? ' checked' : ''}> Private: kids and helpers see "Private item"</label>
        </div>
      </details>
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions">
        ${ev ? '<button type="button" class="btn btn-danger left" data-act="delete">Delete</button>' : ''}
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${ev ? 'Save' : 'Add event'}</button>
      </div>
    </form>`;

    const form = formDialog.querySelector('form');
    const el = form.elements;
    const errBox = form.querySelector('.form-error');
    const who = ui.whoPicker(form.querySelector('[data-ref="who"]'), {
      responsibleId: ev ? ev.responsible_id : d.responsible_id || d.responsibleId || null,
      participantIds: ev ? ev.participant_ids : d.participant_ids || d.participantIds || [],
    });
    const weekday = () => (isIso(el.start_date.value) ? dates.isoWeekday(el.start_date.value) : null);
    const show = (name, on) => form.querySelectorAll(`[data-show="${name}"]`).forEach((box) => {
      box.hidden = !on;
      box.querySelectorAll('input, select').forEach((i) => { i.disabled = !on; });
    });

    // Show what applies: the date chips, repeat buttons (named from the date) and the fields that go with them.
    function apply() {
      const wd = weekday();
      const all = el.all_day.checked;
      const repeating = state.preset !== 'none';
      el.start_time.hidden = all;
      el.start_time.disabled = all;
      show('ends', all && !repeating);
      show('endtime', !all);
      show('custom', state.preset === 'custom');
      show('until', repeating);
      show('daysoff', repeating || oneOffSkips);
      form.querySelectorAll('[data-date]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === el.start_date.value)));
      const labels = { none: "Doesn't repeat", weekly: wd ? `Every ${WD[wd - 1]}` : 'Every week', weekdays: 'Every weekday (Mon–Fri)', daily: 'Every day', custom: 'Custom…' };
      form.querySelectorAll('[data-preset]').forEach((b) => {
        b.textContent = labels[b.dataset.preset];
        b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset));
      });
      form.querySelectorAll('[data-wd]').forEach((b) => {
        const n = Number(b.dataset.wd);
        b.setAttribute('aria-pressed', String(n === wd || state.custom.has(n)));
        if (n === wd) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
      });
    }
    apply();

    form.addEventListener('click', async (e) => {
      const chip = e.target.closest('[data-date]');
      if (chip) { el.start_date.value = chip.dataset.date; apply(); return; }
      const p = e.target.closest('[data-preset]');
      if (p) {
        state.preset = p.dataset.preset;
        if (state.preset === 'custom' && !state.custom.size && weekday()) state.custom.add(weekday());
        // A new "every weekday" event is usually the school run: not on days off, unless they say otherwise.
        if (!ev && !state.daysOffTouched) el.skip_days_off.checked = state.preset === 'weekdays';
        apply();
        return;
      }
      const wdBtn = e.target.closest('[data-wd]');
      if (wdBtn) {
        const n = Number(wdBtn.dataset.wd);
        if (n === weekday()) return;
        if (state.custom.has(n)) state.custom.delete(n); else state.custom.add(n);
        apply();
        return;
      }
      if (e.target.closest('[data-act="delete"]')) {
        try {
          if (await deleteEvent(ev)) { formDialog.close(); afterChange(); }
        } catch (err) { errBox.textContent = eventError(err); errBox.hidden = false; }
      }
    });
    el.start_date.addEventListener('input', apply);
    el.start_date.addEventListener('change', apply);
    el.all_day.addEventListener('change', apply);
    el.repeat_every.addEventListener('change', () => { state.every = Number(el.repeat_every.value) || 1; });
    el.skip_days_off.addEventListener('change', () => { state.daysOffTouched = true; });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let row;
      try { row = readEvent(form, state, who.value()); } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        return;
      }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      errBox.hidden = true;
      try {
        if (ev) {
          const rows = await q(core.sb.from('events').update(row).eq('id', ev.id).select());
          if (!rows || !rows.length) throw new Error("This event was deleted a moment ago, so it couldn't be saved. Reload the page to see the latest.");
        } else {
          await q(core.sb.from('events').insert(row).select().single());
        }
        formDialog.close();
        toast(ev ? `Saved ${row.title}` : `Added ${row.title} · ${fmt.day(row.start_date)}`);
        if (typeof d.onSaved === 'function') d.onSaved(); else afterChange();
      } catch (err) {
        errBox.textContent = eventError(err);
        errBox.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });

    if (!formDialog.open) formDialog.showModal();
    if (window.innerWidth > 700) el.title.focus();
  }

  // The events row from the form, checked against the table's rules first (friendlier than the database's).
  function readEvent(form, state, who) {
    const el = form.elements;
    const val = (name) => String(el[name].value || '').trim();
    const title = val('title');
    if (!title) throw new Error('Give the event a name.');
    const start = val('start_date');
    if (!isIso(start)) throw new Error('Pick a date.');
    const allDay = el.all_day.checked;
    const startTime = allDay ? '' : val('start_time');
    if (!allDay && !startTime) throw new Error('Pick a start time, or tick All day.');
    const repeating = state.preset !== 'none';

    let endDate = allDay && !repeating ? val('end_date') : '';
    if (endDate && !isIso(endDate)) throw new Error('Pick a valid end date, or clear it.');
    if (endDate && endDate < start) throw new Error("The end date can't be before the start date.");
    if (endDate === start) endDate = '';
    const endTime = allDay ? '' : val('end_time');
    const nextDay = !!endTime && el.ends_next_day.checked;
    if (endTime && !nextDay && endTime <= startTime) {
      throw new Error('The end time is before the start time. Tick "Ends the next day" if it goes past midnight.');
    }

    const wd = dates.isoWeekday(start);
    let weekdays = [];
    let every = 1;
    if (state.preset === 'weekly') weekdays = [wd];
    else if (state.preset === 'weekdays') {
      if (wd > 5) throw new Error('"Every weekday" has to start on a weekday. Pick a Monday to Friday for the first date, or choose Custom.');
      weekdays = [1, 2, 3, 4, 5];
    } else if (state.preset === 'daily') weekdays = [1, 2, 3, 4, 5, 6, 7];
    else if (state.preset === 'custom') {
      weekdays = [...new Set([...state.custom, wd])].sort((a, b) => a - b);
      every = Math.min(4, Math.max(1, state.every));
    }
    const until = repeating ? val('repeat_until') : '';
    if (until && !isIso(until)) throw new Error('Pick a valid date for Until, or clear it.');
    if (until && until < start) throw new Error("The repeat can't end before the first date.");

    const resp = who.responsibleId || null;
    return {
      title,
      start_date: start,
      end_date: endDate || null,
      start_time: startTime || null,
      end_time: endTime || null,
      ends_next_day: nextDay,
      responsible_id: resp,
      participant_ids: others(resp, who.participantIds),
      contractor_id: val('contractor_id') || null,
      location: val('location') || null,
      notes: val('notes') || null,
      private: el.private.checked,
      skip_days_off: !el.skip_days_off.disabled && el.skip_days_off.checked,
      repeat: repeating ? 'weekly' : 'none',
      repeat_every: every,
      repeat_weekdays: weekdays,
      repeat_until: until || null,
    };
  }

  // ============================================
  // REGISTER
  // ============================================
  HomeHub.register({
    name: 'calendar',
    schema: { min: 2, max: 99 },
    nav: { label: 'Calendar', order: 20, primary: true },
    // #/calendar · #/calendar/<date> · #/calendar/event/<id>[/<date>]; any other calendar address shows today.
    match(parts) {
      if (parts[0] !== 'calendar') return null;
      if (parts.length === 2 && isIso(parts[1])) return { date: parts[1] };
      if (parts[1] === 'event' && parts[2]) return { eventId: parts[2], occurrence: isIso(parts[3]) ? parts[3] : null };
      return {};
    },
    render: renderCalendar,
    provides: { openEventForm },
  });
})();
