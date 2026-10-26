/* =====================================================================
   HOME HUB — Tasks (v2)
   Everything that gets ticked off: one-off jobs, the inbox (no date yet)
   and jobs that come round again. Filters: Me · Everyone · each person ·
   Repeating · Project. Groups: Late · Today · Coming up · No date ·
   Paused · Done (the last 14 days). One tap on the box ticks a task off
   (with Undo); the row menu does the rest: done on another day, skip,
   edit, pause or resume, delete. The Repeating view groups by kind, says
   how each one repeats, and adds tasks from a starter list.
   Also the task form, which the Add sheet and other pages open with
   use('tasks').openTaskForm(defaults).
   Dates and times are the household's (core.v2), never the device's.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { G, esc, q, toast, friendly, firstName, telHref, detailDialog, formDialog, wireFormDialog } = core;
  const { plural } = G;
  const { v2 } = core;
  const { call, fmt, dates, ui } = v2;

  const CATEGORIES = [['home', 'Home'], ['pets', 'Pets'], ['vehicle', 'Car'], ['health', 'Health'], ['family', 'Family'], ['other', 'Other']];
  const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
  const UNIT_WORDS = { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] };
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // ISO weekday 1..7
  const WD_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const VIEWS = ['me', 'everyone', 'repeating', 'project'];
  const SOON_DAYS = 28;  // Coming up lists the next 4 weeks; later ones wait behind "Show N more"
  const DONE_DAYS = 14;  // Done: what was ticked off or skipped in the last 2 weeks
  const GONE = 'That task was deleted a moment ago. Reload the page to see the latest.';

  // The starter list: generic jobs that come round again (Repeating → "Add from starter list").
  // mode 'schedule' = on set dates, 'after_done' = a while after it's done; month = the season it
  // starts in; lead = heads-up days.
  const STARTER = [
    { key: 'hvac-filter', category: 'home', title: 'Change the furnace/AC filter', mode: 'after_done', count: 60, unit: 'day' },
    { key: 'heat-tuneup', category: 'home', title: 'Heating tune-up (HVAC service)', mode: 'schedule', count: 1, unit: 'year', month: 10 },
    { key: 'cool-tuneup', category: 'home', title: 'Cooling tune-up (HVAC service)', mode: 'schedule', count: 1, unit: 'year', month: 4 },
    { key: 'alarm-test', category: 'home', title: 'Test the smoke and CO alarms', mode: 'schedule', count: 1, unit: 'month' },
    { key: 'alarm-batteries', category: 'home', title: 'Replace the smoke and CO alarm batteries', mode: 'schedule', count: 1, unit: 'year' },
    { key: 'gfci', category: 'home', title: 'Test the GFCI outlets', mode: 'schedule', count: 1, unit: 'month' },
    { key: 'gutters-spring', category: 'home', title: 'Clean the gutters (spring)', mode: 'schedule', count: 1, unit: 'year', month: 4 },
    { key: 'gutters-fall', category: 'home', title: 'Clean the gutters (fall)', mode: 'schedule', count: 1, unit: 'year', month: 11 },
    { key: 'faucets', category: 'home', title: 'Winterize the outdoor faucets', mode: 'schedule', count: 1, unit: 'year' },
    { key: 'water-heater', category: 'home', title: 'Flush the water heater', mode: 'after_done', count: 12, unit: 'month' },
    { key: 'dryer-vent', category: 'home', title: 'Clean the dryer vent', mode: 'after_done', count: 12, unit: 'month' },
    { key: 'fridge-filter', category: 'home', title: 'Replace the fridge water filter', mode: 'after_done', count: 6, unit: 'month' },
    { key: 'dishwasher-filter', category: 'home', title: 'Clean the dishwasher filter', mode: 'after_done', count: 1, unit: 'month' },
    { key: 'hood-filter', category: 'home', title: 'Clean the range hood filter', mode: 'after_done', count: 3, unit: 'month' },
    { key: 'garage-door', category: 'home', title: 'Check and lube the garage door', mode: 'after_done', count: 6, unit: 'month' },
    { key: 'heartworm', category: 'pets', title: 'Heartworm preventive', mode: 'schedule', count: 1, unit: 'month' },
    { key: 'flea-tick', category: 'pets', title: 'Flea and tick preventive', mode: 'schedule', count: 1, unit: 'month' },
    { key: 'vet', category: 'pets', title: 'Vet wellness visit', mode: 'after_done', count: 12, unit: 'month', lead: 21 },
    { key: 'nails', category: 'pets', title: 'Pet nail trim', mode: 'after_done', count: 4, unit: 'week' },
    { key: 'grooming', category: 'pets', title: 'Pet grooming', mode: 'after_done', count: 6, unit: 'week' },
  ];

  let lastView = null; // the filter chosen last, kept while the app is open
  let page = null;     // the Tasks page on screen ({ main, ctx, data, … }), or null while another page shows

  // ============================================
  // HELPERS
  // ============================================
  function isIso(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    try { return dates.addDays(s, 0) === s; } catch (e) { return false; }
  }
  const hm = (t) => (t ? String(t).slice(0, 5) : '');   // '16:00:00' → '16:00' (what a time input holds)
  const yearOf = (iso) => String(iso || '').slice(0, 4);
  // 'Nov 2', or 'Mar 1, 2027' when it isn't this year.
  const shortDate = (iso) => (yearOf(iso) === yearOf(dates.today()) ? fmt.short(iso) : `${fmt.short(iso)}, ${yearOf(iso)}`);
  // 'today', 'tomorrow', 'Tue Oct 27' (or 'Mar 1, 2027').
  function dueWords(iso) {
    const rel = fmt.relDay(iso);
    if (/^(Today|Tomorrow|Yesterday)$/.test(rel)) return rel.toLowerCase();
    return yearOf(iso) === yearOf(dates.today()) ? rel : shortDate(iso);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // By due date (no date last), then time (none last), then name.
  const byDue = (a, b) => cmp(a.due_date || '9999', b.due_date || '9999') || cmp(a.due_time || '99', b.due_time || '99')
    || String(a.title).localeCompare(String(b.title));
  const repeats = (t) => t.repeat_mode === 'schedule' || t.repeat_mode === 'after_done';
  const paused = (t) => t.active === false;
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const alreadyDone = (err) => /^already (done|completed)$/.test((err && err.message) || '');

  // iso plus n days, weeks, months or years, the way the database counts (Jan 31 + 1 month = Feb 28).
  function addUnits(iso, n, unit) {
    if (unit === 'day') return dates.addDays(iso, n);
    if (unit === 'week') return dates.addDays(iso, 7 * n);
    const months = Number(iso.slice(5, 7)) - 1 + (unit === 'year' ? 12 * n : n);
    const y = Number(iso.slice(0, 4)) + Math.floor(months / 12);
    const m = ((months % 12) + 12) % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(Number(iso.slice(8, 10)), last)).padStart(2, '0')}`;
  }

  // The household's date for an instant (done_at, created_at): 'YYYY-MM-DD', or '' if unreadable.
  const dayFormats = new Map();
  function localDate(instant) {
    const d = instant ? new Date(instant) : null;
    if (!d || isNaN(d)) return '';
    const tz = (v2.household && v2.household.tz) || (v2.clock && v2.clock.tz) || 'America/New_York';
    let f = dayFormats.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      dayFormats.set(tz, f);
    }
    const o = {};
    f.formatToParts(d).forEach((p) => { o[p.type] = p.value; });
    return `${o.year}-${o.month}-${o.day}`;
  }
  const instantOrder = (x) => { const n = Date.parse(x || ''); return Number.isNaN(n) ? 0 : n; };

  // Errors the database answers with, in plain words.
  function taskError(err) {
    const code = err && err.code;
    if (alreadyDone(err)) return err.hint || 'Someone already ticked this off.';
    if (code === '23514') return "The task couldn't be saved: its date and how it repeats don't fit together. Check them and try again.";
    if (code === '23503') return 'The person in charge, the project or the contact was removed a moment ago. Reload the page and try again.';
    return friendly(err);
  }

  // '1st', '2nd', '3rd', '4th', '11th', '22nd', '31st'.
  function ordinal(n) {
    const v = n % 100;
    return `${n}${v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
  }
  // 'Monday', 'Monday and Thursday', 'Monday, Wednesday and Friday'.
  const andList = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
  // A sentence's first letter in capitals: the rules below are written to go mid-sentence.
  const cap = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

  // How a task on set dates repeats, from the date its series counts from (the anchor, else the due
  // date): "every month on the 1st", "every year on Nov 1", "every Monday and Thursday", "every 2 weeks
  // on Saturday", "every weekday", "every 3 days". Without a date (the starter list): "every month".
  function ruleText(t) {
    const n = Number(t.every_count) || 1;
    const unit = UNIT_WORDS[t.every_unit] ? t.every_unit : 'day';
    const from = isIso(t.anchor_date) ? t.anchor_date : isIso(t.due_date) ? t.due_date : null;
    const every = n === 1 ? `every ${unit}` : `every ${n} ${UNIT_WORDS[unit][1]}`;
    if (unit === 'week') {
      let days = [...new Set((t.repeat_weekdays || []).map(Number).filter((w) => w >= 1 && w <= 7))].sort((a, b) => a - b);
      if (!days.length && from) days = [dates.isoWeekday(from)];
      if (!days.length) return every;
      const list = days.length === 7 ? 'day' : sameSet(days, [1, 2, 3, 4, 5]) ? 'weekday' : andList(days.map((w) => WD_LONG[w - 1]));
      return n === 1 ? `every ${list}` : `every ${n} weeks on ${list === 'day' ? 'every day' : list === 'weekday' ? 'weekdays' : list}`;
    }
    if (unit === 'month' && from) {
      const day = Number(from.slice(8, 10));
      return `${every} on the ${ordinal(day)}${day > 28 ? ' (or the month\'s last day)' : ''}`;
    }
    if (unit === 'year' && from) return `${every} on ${MONTHS[Number(from.slice(5, 7)) - 1].slice(0, 3)} ${Number(from.slice(8, 10))}`;
    return every;
  }
  // "every month on the 1st" or "every 60 days after it's done" (mid-sentence; cap() starts a line with it).
  function cadence(t) {
    if (t.repeat_mode === 'after_done') {
      const n = Number(t.every_count) || 1;
      const unit = UNIT_WORDS[t.every_unit] ? t.every_unit : 'day';
      return `${n === 1 ? `every ${unit}` : `every ${n} ${UNIT_WORDS[unit][1]}`} after it's done`;
    }
    return ruleText(t);
  }
  // "next Nov 2", "due today", "was due Oct 20".
  function nextText(t, today) {
    if (!t.due_date) return '';
    if (t.due_date < today) return `was due ${shortDate(t.due_date)}`;
    if (t.due_date === today) return 'due today';
    return `next ${shortDate(t.due_date)}`;
  }
  const cadenceLine = (t, today) => [cap(cadence(t)), nextText(t, today)].filter(Boolean).join(' · ');

  // Who ticked it off: done_by is the signed-in email, or "<name> (My day)" from the My day page.
  function whoDid(doneBy) {
    const s = String(doneBy || '').trim();
    if (!s) return '';
    const viaDay = / \(My day\)$/.test(s);
    const name = s.replace(/ \(My day\)$/, '');
    const p = v2.people().find((x) => (viaDay ? x.name === name : String(x.email || '').toLowerCase() === s.toLowerCase()));
    const who = p ? firstName(p.name) : viaDay ? firstName(name) : s;
    return viaDay ? `${who} on My day` : who;
  }

  // Who looks after this kind of task by default (Settings): the pets owner, else the house owner.
  function ownerFor(category) {
    const h = v2.household || {};
    const p = v2.person(category === 'pets' ? h.pets_owner_id : h.house_owner_id);
    return p && p.active !== false ? p : null;
  }

  // ============================================
  // DATA
  // ============================================
  // Project names and the directory are extras: a failed read leaves them out rather than the page.
  async function loadProjects() {
    try { return (await q(core.sb.from('projects').select('id,name,status').order('name'))) || []; } catch (err) { return null; }
  }
  async function loadContractors() {
    try { return (await q(core.sb.from('contractors').select('id,name,company,phone,kind').order('name'))) || []; } catch (err) { return null; }
  }

  // Every task not ticked off (repeating ones always), one-offs ticked off in the last 14 days, and
  // the done and skipped entries of those 14 days. The database's filters are by UTC day; the Done
  // list is cut again by the household's day below.
  async function load() {
    const today = dates.today();
    const since = dates.addDays(today, -DONE_DAYS);
    const [open, doneOnce, log, projects, contacts] = await Promise.all([
      q(core.sb.from('tasks').select('*').is('done_at', null)),
      q(core.sb.from('tasks').select('*').not('done_at', 'is', null).gte('done_at', since)),
      q(core.sb.from('task_log').select('*').in('status', ['done', 'skipped']).gte('created_at', since).order('created_at', { ascending: false })),
      loadProjects(),
      loadContractors(),
    ]);
    return {
      today,
      since,
      open: open || [],
      doneOnce: doneOnce || [],
      log: log || [],
      projectById: new Map((projects || []).map((p) => [p.id, p])),
      contactById: new Map((contacts || []).map((c) => [c.id, c])),
    };
  }
  const projectName = (d, id) => ((d.projectById.get(id) || {}).name || 'A project');

  // The Done list, newest first: { task, log, status, day }. A one-off ticked off without a log
  // entry (there always is one today, but the row is the truth) still shows.
  function doneEntries(d) {
    const tasks = new Map(d.open.concat(d.doneOnce).map((t) => [t.id, t]));
    const logged = new Set();
    const out = [];
    d.log.forEach((l) => {
      const t = tasks.get(l.task_id);
      if (!t || (l.status !== 'done' && l.status !== 'skipped')) return;
      logged.add(t.id);
      const day = l.status === 'done' ? l.done_on || l.occurrence : localDate(l.created_at) || l.occurrence;
      out.push({ task: t, log: l, status: l.status, day, at: l.created_at });
    });
    d.doneOnce.forEach((t) => {
      if (!logged.has(t.id)) out.push({ task: t, log: null, status: 'done', day: localDate(t.done_at), at: t.done_at });
    });
    return out.filter((e) => isIso(e.day) && localDate(e.at) >= d.since).sort((a, b) => instantOrder(b.at) - instantOrder(a.at));
  }

  // A tasks row as an agenda item, so the shared item row can draw it.
  function itemOf(t, d) {
    const c = t.contractor_id ? d.contactById.get(t.contractor_id) : null;
    const late = !paused(t) && !t.done_at && !!t.due_date && t.due_date < d.today;
    return {
      kind: 'task', item_id: t.id, occurrence: t.due_date, title: t.title,
      day: t.due_date, end_day: t.due_date, all_day: !t.due_time, start_at: null, end_at: null,
      local_start: t.due_time || null, local_end: null,
      responsible_id: t.responsible_id || null, participant_ids: [],
      status: t.done_at ? 'done' : late ? 'late' : 'open',
      category: t.category, project_id: t.project_id || null, project_name: t.project_id ? projectName(d, t.project_id) : null,
      contractor_id: t.contractor_id || null, contractor_name: c ? c.name : null, contractor_phone: c ? c.phone : null,
      location: null, notes: t.notes, private: !!t.private, repeating: repeats(t), changed: false, lead_days: t.lead_days || 0, milestone: false,
    };
  }

  // ============================================
  // ACTIONS
  // ============================================
  // After a change: the Tasks page reads everything again if it's on screen (resolving to the new
  // data); any other page is drawn again.
  function afterChange() {
    if (page && !page.ctx.stale()) return refresh(page);
    return core.route();
  }

  // Read everything again and redraw, keeping the newest answer when several are in flight.
  async function refresh(st) {
    const seq = ++st.loads;
    try {
      const data = await load();
      if (seq !== st.loads || st.ctx.stale()) return null;
      st.data = data;
      draw(st);
      return data;
    } catch (err) {
      if (!st.ctx.stale()) toast(friendly(err), { error: true });
      return null;
    }
  }
  const freshTask = (data, id) => (data && data.open ? data.open.find((x) => x.id === id) : null) || null;

  // Tick a task off (today, or on doneOn), show the list as it is now, then "Done · Undo".
  // A repeating one says when it's next due. Someone else's tick (or a screen left open since
  // yesterday) shows the latest list instead of an error.
  async function complete(t, doneOn) {
    let logId;
    try {
      logId = await call('complete_task', { p_id: t.id, p_occurrence: t.due_date || null, p_done_on: doneOn || null });
    } catch (err) {
      if (!alreadyDone(err)) throw err;
      toast('Someone already ticked that off. This is the latest.');
      afterChange();
      return false;
    }
    const now = freshTask(await afterChange(), t.id);
    const next = repeats(t) && now && now.due_date ? ` · next ${shortDate(now.due_date)}` : '';
    const when = doneOn && doneOn !== dates.today() ? ` on ${fmt.short(doneOn)}` : '';
    toast(`Done${when}: ${t.title}${next}`, {
      action: {
        label: 'Undo',
        async onClick() {
          await call('undo_task', { p_log_id: logId });
          toast(`Not done: ${t.title}`);
          afterChange();
        },
      },
    });
    return true;
  }

  // Skip this time (repeating tasks): it moves to its next date, with Undo.
  async function skip(t) {
    let logId;
    try {
      logId = await call('skip_task', { p_id: t.id, p_occurrence: t.due_date });
    } catch (err) {
      if (!alreadyDone(err)) throw err;
      toast('Someone already ticked off or skipped that one. This is the latest.');
      afterChange();
      return false;
    }
    const now = freshTask(await afterChange(), t.id);
    toast(`Skipped: ${t.title}${now && now.due_date ? ` · next ${shortDate(now.due_date)}` : ''}`, {
      action: {
        label: 'Undo',
        async onClick() {
          await call('undo_task', { p_log_id: logId });
          toast(`${t.title} is due ${dueWords(t.due_date)} again`);
          afterChange();
        },
      },
    });
    return true;
  }

  // Undo a Done-list entry (only a task's latest entry, within 7 days; the database says if not).
  async function undoEntry(e) {
    await call('undo_task', { p_log_id: e.log.id });
    toast(e.status === 'skipped' ? `Not skipped: ${e.task.title}` : `Not done: ${e.task.title}`);
    afterChange();
  }

  // Pause (it stays on the list but never comes up or goes late) or resume, with Undo.
  async function setActive(t, on) {
    const write = async (value) => {
      const rows = await q(core.sb.from('tasks').update({ active: value }).eq('id', t.id).select('id'));
      if (!rows || !rows.length) throw new Error(GONE);
    };
    await write(on);
    toast(on ? `Back on: ${t.title}` : `Paused: ${t.title}`, {
      action: {
        label: 'Undo',
        async onClick() {
          await write(!on);
          toast(on ? `Paused again: ${t.title}` : `Back on: ${t.title}`);
          afterChange();
        },
      },
    });
    afterChange();
  }

  // Deletes the task after asking, with an Undo that puts the row back (its history goes for good).
  // Resolves false if they said no.
  async function deleteTask(t) {
    const ask = repeats(t) ? `Delete "${t.title}"? It stops coming round, and its history goes too.` : `Delete "${t.title}"?`;
    if (!window.confirm(ask)) return false;
    await q(core.sb.from('tasks').delete().eq('id', t.id));
    toast(`Deleted ${t.title}`, {
      action: {
        label: 'Undo',
        async onClick() {
          await q(core.sb.from('tasks').insert(t).select('id'));
          toast(`${t.title} is back on the list`);
          afterChange();
        },
      },
    });
    afterChange();
    return true;
  }

  // ============================================
  // DRAWING
  // ============================================
  // The filter on screen, falling back to Me (or Everyone when the signed-in member isn't on the
  // family list) when the chosen person has gone.
  function currentView(st) {
    const v = st.view;
    const mine = v2.mePerson;
    if (v === 'me' || (mine && v === mine.id)) return mine ? 'me' : 'everyone';
    if (VIEWS.includes(v)) return v;
    if (v && v2.person(v)) return v;
    return mine ? 'me' : 'everyone';
  }
  function belongs(t, v) {
    if (v === 'me') return !!v2.mePerson && t.responsible_id === v2.mePerson.id;
    if (VIEWS.includes(v)) return true;
    return t.responsible_id === v;
  }

  // Me (the signed-in person's own chip, labelled Me), Everyone, each other person, Repeating, Project.
  function chipsHTML(v) {
    const mine = v2.mePerson;
    let meChip = '';
    if (mine) {
      const holder = document.createElement('div');
      holder.innerHTML = ui.personChip(mine, { selected: v === 'me' });
      const chip = holder.firstElementChild;
      chip.dataset.view = 'me';
      chip.removeAttribute('data-person');
      chip.querySelector('.pchip-name').textContent = 'Me';
      chip.title = `${mine.name} (you)`;
      meChip = holder.innerHTML;
    }
    const others = v2.people().filter((p) => (p.active !== false || p.id === v) && (!mine || p.id !== mine.id));
    const fchip = (key, label, icon) => `<button type="button" class="pchip tasks-fchip" data-view="${key}" aria-pressed="${v === key}">`
      + `<span class="tasks-fchip-icon" aria-hidden="true">${icon}</span><span class="pchip-name">${label}</span></button>`;
    return meChip + fchip('everyone', 'Everyone', ui.icon.tasks)
      + others.map((p) => ui.personChip(p, { selected: v === p.id })).join('')
      + fchip('repeating', 'Repeating', ui.icon.repeat) + fchip('project', 'Project', ui.icon.page);
  }

  function setTime(row, top, sub, untimed) {
    const box = row.querySelector('.irow-time');
    if (!box) return;
    box.classList.toggle('untimed', !!untimed);
    box.innerHTML = `<span>${esc(top)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}`;
  }

  // More under the title: a badge, then plain parts joined with " · " (after the row's own details).
  function addSub(row, badge, parts) {
    const text = parts.filter(Boolean).join(' · ');
    if (!badge && !text) return;
    let sub = row.querySelector('.irow-sub');
    if (!sub) {
      sub = document.createElement('span');
      sub.className = 'irow-sub';
      row.querySelector('.irow-main').appendChild(sub);
    }
    const hasText = [...sub.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (badge) sub.insertAdjacentHTML('afterbegin', badge);
    if (text) {
      const span = document.createElement('span');
      span.className = 'tasks-sub';
      span.textContent = `${hasText ? '· ' : ''}${text}`;
      sub.appendChild(span);
    }
  }

  // Rows without a tick box (paused, skipped) keep their titles in line with the rest.
  function alignTitle(row) {
    if (row.querySelector('.irow-check')) return;
    const gap = document.createElement('span');
    gap.className = 'tasks-nobox';
    gap.setAttribute('aria-hidden', 'true');
    row.querySelector('.irow-time').after(gap);
  }

  function menuButton(title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tasks-menu';
    b.setAttribute('aria-label', `More for ${title}`);
    b.setAttribute('aria-haspopup', 'dialog');
    b.innerHTML = ui.icon.more;
    b.addEventListener('click', onClick);
    return b;
  }

  // One task: the shared item row (tick box, who, call), plus how it repeats, its project, a
  // Paused badge and the ⋯ menu. opts: showWho, showDate, cadence (with "next …"), inProject.
  function taskRow(st, t, o) {
    const d = st.data;
    const row = ui.itemRow(itemOf(t, d), {
      checkbox: !paused(t),
      showWho: !!o.showWho,
      showDate: !!o.showDate,
      onOpen: () => openDetails(st, t),
      onToggle: () => complete(t),
    });
    row.dataset.task = t.id;
    if (!t.due_date) setTime(row, 'No date', '', true);
    else if (o.showDate && yearOf(t.due_date) !== yearOf(d.today)) {
      setTime(row, fmt.short(t.due_date), [yearOf(t.due_date), t.due_time ? fmt.time(t.due_time) : ''].filter(Boolean).join(' · '));
    }
    addSub(row, paused(t) ? '<span class="badge">Paused</span>' : '', [
      repeats(t) ? (o.cadence ? cadenceLine(t, d.today) : cap(cadence(t))) : '',
      t.project_id && !o.inProject ? projectName(d, t.project_id) : '',
      t.private ? 'Private' : '',
    ]);
    alignTitle(row);
    row.appendChild(menuButton(t.title, () => openDetails(st, t)));
    return row;
  }

  // One Done-list entry: ticked (or Skipped), on the day it was done.
  function doneRow(st, e, o) {
    const t = e.task;
    const it = Object.assign(itemOf(t, st.data), {
      status: e.status, day: e.day, end_day: e.day, occurrence: e.log ? e.log.occurrence : t.due_date, all_day: true, local_start: null,
    });
    // The ticked box can be tapped (after "Mark … as not done?") when the entry can be undone.
    const row = ui.itemRow(it, { checkbox: true, showWho: !!o.showWho, showDate: true, onOpen: () => openDone(st, e),
      onUntick: e.log && e.status === 'done' ? () => undoEntry(e) : undefined });
    row.dataset.task = t.id;
    const occ = e.log && e.log.occurrence;
    const by = whoDid(e.log ? e.log.done_by : t.done_by);
    addSub(row, '', [occ && occ !== e.day ? `was due ${shortDate(occ)}` : '', by ? `by ${by}` : '']);
    alignTitle(row);
    row.appendChild(menuButton(t.title, () => openDone(st, e)));
    return row;
  }

  function fill(root, key, items, make) {
    const list = root.querySelector(`[data-list="${key}"]`);
    if (list) items.forEach((x) => list.appendChild(make(x)));
  }
  const section = (key, title, count, inner) => `<section class="tasks-sec" data-group="${key}" aria-label="${esc(title)}">${ui.sectionHeading(title, count)}${inner}</section>`;
  const card = (key) => `<div class="tasks-card irows" data-list="${key}"></div>`;

  function draw(st) {
    const { main } = st;
    const d = st.data;
    const v = currentView(st);

    // Keep the chip row's sideways scroll and the focused chip across the redraw.
    const oldChips = main.querySelector('.tasks-chips');
    const chipScroll = oldChips ? oldChips.scrollLeft : 0;
    const focused = document.activeElement && main.contains(document.activeElement) && document.activeElement.closest('.tasks-chips .pchip');
    const focusKey = focused ? focused.dataset.view || focused.dataset.person : null;

    main.innerHTML = `
      <div class="page-head tasks-head">
        <div><p class="eyebrow">${esc(fmt.dayLong(d.today))}</p><h1>Tasks</h1></div>
        <div class="page-actions"><button type="button" class="btn btn-primary tasks-add" data-act="add">${ui.icon.plus}Add task</button></div>
      </div>
      <div class="tasks-chips" role="group" aria-label="Show tasks for">${chipsHTML(v)}</div>
      <div class="tasks-body"></div>`;
    const body = main.querySelector('.tasks-body');
    if (v === 'repeating') drawRepeating(st, body);
    else if (v === 'project') drawProjects(st, body);
    else drawList(st, body, v);

    const chips = main.querySelector('.tasks-chips');
    chips.scrollLeft = chipScroll;
    const again = focusKey && [...chips.querySelectorAll('.pchip')].find((b) => (b.dataset.view || b.dataset.person) === focusKey);
    if (again) again.focus();
  }

  // Me, Everyone or one person: Late · Today · Coming up · No date · Paused · Done.
  function drawList(st, body, v) {
    const d = st.data;
    const today = d.today;
    const open = d.open.filter((t) => belongs(t, v));
    const on = open.filter((t) => !paused(t));
    const late = on.filter((t) => t.due_date && t.due_date < today).sort(byDue);
    const now = on.filter((t) => t.due_date === today).sort(byDue);
    const coming = on.filter((t) => t.due_date > today).sort(byDue);
    const inbox = on.filter((t) => !t.due_date).sort((a, b) => cmp(String(a.created_at || ''), String(b.created_at || '')) || String(a.title).localeCompare(String(b.title)));
    const off = open.filter(paused).sort(byDue);
    const done = doneEntries(d).filter((e) => belongs(e.task, v));
    const soonEnd = dates.addDays(today, SOON_DAYS);
    const soon = st.showLater ? coming : coming.filter((t) => t.due_date <= soonEnd);
    const later = coming.length - soon.length;
    const person = v === 'me' || v === 'everyone' ? null : v2.person(v);
    const showWho = v === 'everyone';

    const nothing = v === 'me' ? 'Nothing on your list.' : v === 'everyone' ? 'No tasks yet.' : `Nothing on ${firstName(person.name)}'s list.`;
    body.innerHTML = [
      open.length ? '' : `<p class="tasks-card empty-line tasks-empty">${esc(nothing)} Use Add task to add one${v === 'everyone' ? ', or start from the starter list under Repeating' : ''}.</p>`,
      late.length ? section('late', 'Late', late.length, card('late')) : '',
      now.length ? section('today', 'Today', now.length, card('today')) : '',
      coming.length ? section('coming', 'Coming up', coming.length, `${soon.length ? card('coming') : ''}${later
        ? `<button type="button" class="btn tasks-later" data-act="later">Show ${later} more, after ${esc(fmt.short(soonEnd))}</button>` : ''}`) : '',
      inbox.length ? section('inbox', 'No date', inbox.length, card('inbox')) : '',
      off.length ? section('paused', 'Paused', off.length, card('paused')) : '',
      done.length ? section('done', 'Done in the last 2 weeks', done.length, card('done')) : '',
    ].join('');

    fill(body, 'late', late, (t) => taskRow(st, t, { showWho, showDate: true }));
    fill(body, 'today', now, (t) => taskRow(st, t, { showWho }));
    fill(body, 'coming', soon, (t) => taskRow(st, t, { showWho, showDate: true }));
    fill(body, 'inbox', inbox, (t) => taskRow(st, t, { showWho }));
    fill(body, 'paused', off, (t) => taskRow(st, t, { showWho, showDate: true }));
    fill(body, 'done', done, (e) => doneRow(st, e, { showWho }));
  }

  // Repeating: every repeating task by kind (Home, Pets, Car, …), with how it repeats and when it's next.
  function drawRepeating(st, body) {
    const d = st.data;
    const all = d.open.filter(repeats);
    const top = `<div class="tasks-rep-top">
      <p class="tasks-note">Jobs that come round again. Tick one off and it moves to its next date.</p>
      <button type="button" class="btn tasks-starter-btn" data-act="starter">Add from starter list</button></div>`;
    if (!all.length) {
      body.innerHTML = `${top}<p class="tasks-card empty-line tasks-empty">No repeating tasks yet. The starter list has the usual ones: the furnace filter, smoke alarms, heartworm pills and more.</p>`;
      return;
    }
    const kindOf = (t) => (CATEGORY_LABEL[t.category] ? t.category : 'other');
    const groups = CATEGORIES.map(([key, label]) => ({
      key, label, items: all.filter((t) => kindOf(t) === key).sort((a, b) => (paused(a) - paused(b)) || byDue(a, b)),
    })).filter((g) => g.items.length);
    body.innerHTML = top + groups.map((g) => section(`rep-${g.key}`, g.label, g.items.length, card(`rep-${g.key}`))).join('');
    groups.forEach((g) => fill(body, `rep-${g.key}`, g.items, (t) => taskRow(st, t, { showWho: true, showDate: true, cadence: true })));
  }

  // Project: the open tasks on each project (or on one, from #/tasks/project/<id>).
  function drawProjects(st, body) {
    const d = st.data;
    const items = d.open.filter((t) => t.project_id && (!st.projectId || t.project_id === st.projectId));
    const ids = [...new Set(items.map((t) => t.project_id))];
    const groups = ids.map((id) => ({
      id, name: projectName(d, id), items: items.filter((t) => t.project_id === id).sort((a, b) => (paused(a) - paused(b)) || byDue(a, b)),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const back = st.projectId ? '<p class="tasks-note"><a class="tasks-link" href="#/tasks/project">All projects</a></p>' : '';
    if (!groups.length) {
      const which = st.projectId ? projectName(d, st.projectId) : '';
      body.innerHTML = `${back}<p class="tasks-card empty-line tasks-empty">${st.projectId
        ? `No open tasks on ${esc(which)}.`
        : 'No tasks are on a project yet. Open a task, choose Edit, and pick one under More: Put on project.'}</p>`;
      return;
    }
    body.innerHTML = back + groups.map((g, i) => `<section class="tasks-sec" data-group="proj-${i}" aria-label="${esc(g.name)}">
      <div class="tasks-proj-head">${ui.sectionHeading(g.name, g.items.length)}<a class="tasks-link" href="#/projects/${encodeURIComponent(g.id)}">Open project</a></div>
      ${card(`proj-${i}`)}</section>`).join('');
    groups.forEach((g, i) => fill(body, `proj-${i}`, g.items, (t) => taskRow(st, t, { showWho: true, showDate: true, inProject: true })));
  }

  // ============================================
  // DETAILS AND THE ROW MENU
  // ============================================
  function openDetails(st, t) {
    const d = st.data;
    const today = d.today;
    const rep = repeats(t);
    const off = paused(t);
    const canTick = !off && !t.done_at;
    const resp = v2.person(t.responsible_id);
    const contact = t.contractor_id ? d.contactById.get(t.contractor_id) : null;
    const late = canTick && !!t.due_date && t.due_date < today;
    const due = t.due_date
      ? `${fmt.dayLong(t.due_date)}${yearOf(t.due_date) !== yearOf(today) ? `, ${yearOf(t.due_date)}` : ''}${t.due_time ? ` · ${fmt.time(t.due_time)}` : ''}`
      : 'No date yet';
    // complete_task takes a day up to a year before the due date, and never a day still to come.
    const min = rep && t.due_date ? addUnits(t.due_date, -1, 'year') : '';
    const flags = [late ? '<span class="badge late">Late</span>' : '', off ? '<span class="badge">Paused</span>' : '', t.private ? '<span class="badge">Private</span>' : ''].join('');

    G.showDialog(detailDialog, `<div class="tasks-details">
      <div class="d-top"><span class="d-trade">${rep ? 'Repeating task' : 'Task'} · ${esc(CATEGORY_LABEL[t.category] || 'Other')}</span>
        <button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <h3 id="dTitle">${esc(t.title)}</h3>
      ${flags ? `<p class="tasks-flags">${flags}</p>` : ''}
      <dl>
        <dt>Due</dt><dd>${esc(due)}</dd>
        ${rep ? `<dt>Repeats</dt><dd>${esc(cap(cadence(t)))}</dd>` : ''}
        ${t.last_done ? `<dt>Last done</dt><dd>${esc(fmt.dayLong(t.last_done))}</dd>` : ''}
        <dt>In charge</dt><dd>${resp ? `<span class="tasks-who"><span aria-hidden="true">${ui.personDot(resp)}</span>${esc(resp.name)}</span>` : '<span class="tasks-muted">Nobody yet</span>'}</dd>
        ${t.lead_days ? `<dt>Heads-up</dt><dd>${esc(plural(t.lead_days, 'day'))} before</dd>` : ''}
        ${t.project_id ? `<dt>Project</dt><dd><a href="#/projects/${encodeURIComponent(t.project_id)}">${esc(projectName(d, t.project_id))}</a></dd>` : ''}
        ${contact ? `<dt>Contact</dt><dd class="tasks-contact"><span>${esc(contact.name)}</span>${contact.phone
    ? `<a class="btn tasks-call" href="${esc(telHref(contact.phone))}" aria-label="Call ${esc(contact.name)} ${esc(contact.phone)}">${ui.icon.phone}${esc(contact.phone)}</a>` : ''}</dd>` : ''}
      </dl>
      ${t.notes ? `<p class="d-note">${esc(t.notes)}</p>` : ''}
      <div class="tasks-another" hidden>
        <label class="field"><span>When was it done?</span><input type="date" name="done_on" value="${esc(today)}" max="${esc(today)}"${min ? ` min="${esc(min)}"` : ''}></label>
        <button type="button" class="btn btn-primary" data-act="done-on">Save</button>
      </div>
      <p class="form-error" role="alert" hidden></p>
      <div class="d-actions tasks-actions">
        ${canTick ? '<button type="button" class="btn btn-primary" data-act="done">Mark done</button>' : ''}
        ${canTick ? '<button type="button" class="btn" data-act="another">Done on another day</button>' : ''}
        ${canTick && rep ? '<button type="button" class="btn" data-act="skip">Skip this time</button>' : ''}
        <button type="button" class="btn" data-act="edit">Edit</button>
        ${off ? '<button type="button" class="btn" data-act="resume">Resume</button>' : rep ? '<button type="button" class="btn" data-act="pause">Pause</button>' : ''}
        <button type="button" class="btn btn-danger" data-act="delete">Delete</button>
      </div></div>`);

    const box = detailDialog.querySelector('.tasks-details');
    const errBox = box.querySelector('.form-error');
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (act === 'edit') {
        detailDialog.close();
        openForm({ task: t });
        return;
      }
      if (act === 'another') {
        const more = box.querySelector('.tasks-another');
        more.hidden = false;
        b.setAttribute('aria-expanded', 'true');
        more.querySelector('input').focus();
        return;
      }
      errBox.hidden = true;
      b.disabled = true;
      try {
        let closeIt = true;
        if (act === 'done') await complete(t);
        else if (act === 'done-on') {
          const day = box.querySelector('[name="done_on"]').value;
          if (!isIso(day)) throw new Error('Pick the day it was done.');
          if (day > today) throw new Error("That day hasn't happened yet. Pick today or earlier.");
          if (min && day < min) throw new Error(`That's more than a year before it was due. Pick ${fmt.short(min)} or later.`);
          await complete(t, day);
        } else if (act === 'skip') await skip(t);
        else if (act === 'pause' || act === 'resume') await setActive(t, act === 'resume');
        else if (act === 'delete') closeIt = await deleteTask(t);
        if (closeIt && detailDialog.open) detailDialog.close();
      } catch (err) {
        errBox.textContent = taskError(err);
        errBox.hidden = false;
      } finally {
        b.disabled = false;
      }
    });
  }

  // A Done-list entry: when and by whom, and Undo.
  function openDone(st, e) {
    const t = e.task;
    const l = e.log;
    const by = whoDid(l ? l.done_by : t.done_by);
    G.showDialog(detailDialog, `<div class="tasks-details">
      <div class="d-top"><span class="d-trade">${repeats(t) ? 'Repeating task' : 'Task'} · ${e.status === 'skipped' ? 'Skipped' : 'Done'}</span>
        <button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <h3 id="dTitle">${esc(t.title)}</h3>
      <dl>
        <dt>${e.status === 'skipped' ? 'Skipped' : 'Done'}</dt><dd>${esc(fmt.dayLong(e.day))}${by ? ` · ${esc(by)}` : ''}</dd>
        ${l && l.occurrence && l.occurrence !== e.day ? `<dt>Was due</dt><dd>${esc(fmt.dayLong(l.occurrence))}</dd>` : ''}
        ${repeats(t) && t.due_date ? `<dt>Next</dt><dd>${esc(fmt.dayLong(t.due_date))}</dd>` : ''}
      </dl>
      ${l && l.note ? `<p class="d-note">${esc(l.note)}</p>` : ''}
      <p class="form-error" role="alert" hidden></p>
      <div class="d-actions tasks-actions">
        ${l ? `<button type="button" class="btn" data-act="undo">${e.status === 'skipped' ? 'Undo the skip' : 'Not done after all'}</button>` : ''}
        <button type="button" class="btn" data-close>Close</button>
      </div></div>`);
    const box = detailDialog.querySelector('.tasks-details');
    const undo = box.querySelector('[data-act="undo"]');
    if (!undo) return;
    undo.addEventListener('click', async () => {
      const errBox = box.querySelector('.form-error');
      undo.disabled = true;
      errBox.hidden = true;
      try {
        await undoEntry(e);
        if (detailDialog.open) detailDialog.close();
      } catch (err) {
        errBox.textContent = taskError(err);
        errBox.hidden = false;
        undo.disabled = false;
      }
    });
  }

  // ============================================
  // THE STARTER LIST
  // ============================================
  // First due dates for starter tasks: the ones without a season spread evenly over the 4 weeks
  // from tomorrow, the seasonal ones from the start of their month (tomorrow, if that's in it);
  // never more than 2 on one day. Returns Map(key → 'YYYY-MM-DD').
  function starterDates(picked, today) {
    const tomorrow = dates.addDays(today, 1);
    const used = new Map();
    const take = (iso) => {
      let day = iso;
      while ((used.get(day) || 0) >= 2) day = dates.addDays(day, 1);
      used.set(day, (used.get(day) || 0) + 1);
      return day;
    };
    const out = new Map();
    const plain = picked.filter((s) => !s.month);
    plain.forEach((s, i) => out.set(s.key, take(dates.addDays(tomorrow, Math.floor((i * SOON_DAYS) / plain.length)))));
    picked.filter((s) => s.month).forEach((s) => {
      const y = Number(tomorrow.slice(0, 4));
      const m = Number(tomorrow.slice(5, 7));
      const start = m === s.month ? tomorrow : `${s.month > m ? y : y + 1}-${String(s.month).padStart(2, '0')}-01`;
      out.set(s.key, take(start));
    });
    return out;
  }
  const starterText = (s) => `${cap(cadence({ repeat_mode: s.mode, every_count: s.count, every_unit: s.unit }))}${s.month ? `, starting in ${MONTHS[s.month - 1]}` : ''}${s.lead ? `, heads-up ${s.lead} days before` : ''}`;

  function openStarter() {
    const d = page && page.data;
    const have = new Set(((d && d.open) || []).map((t) => String(t.title).trim().toLowerCase()));
    const groups = [['home', 'Home'], ['pets', 'Pets']].map(([key, label]) => ({ key, label, items: STARTER.filter((s) => s.category === key) }));
    const ownerLine = (key) => {
      const p = ownerFor(key);
      const role = key === 'pets' ? 'looks after the pets' : 'looks after the house';
      return p ? `${firstName(p.name)} will be in charge (Settings says who ${role}).` : `Nobody will be in charge yet. Settings can say who ${role}.`;
    };

    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = `<form class="form d-inner tasks-form tasks-starter" novalidate>
      <div class="d-top"><h3>Starter list</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <p class="meta tasks-intro">The usual jobs that come round again. Tick the ones that fit your home. Their first dates spread over the next 4 weeks, at most 2 a day, so they don't all land at once; seasonal ones start in their month. You can change any of them later.</p>
      ${groups.map((g) => `<fieldset class="tasks-fs"><legend>${esc(g.label)}</legend>
        <small class="tasks-hint">${esc(ownerLine(g.key))}</small>
        <div class="tasks-picks">${g.items.map((s) => (have.has(s.title.toLowerCase())
    ? `<div class="tasks-pick is-have"><span class="tasks-pick-mark" aria-hidden="true">${ui.icon.check}</span><span><b>${esc(s.title)}</b><small>Already on your list</small></span></div>`
    : `<label class="tasks-pick"><input type="checkbox" name="pick" value="${esc(s.key)}"><span><b>${esc(s.title)}</b><small>${esc(starterText(s))}</small></span></label>`)).join('')}</div>
      </fieldset>`).join('')}
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn left" data-act="all">Tick all</button>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary" disabled>Add tasks</button>
      </div>
    </form>`;

    const form = formDialog.querySelector('form');
    const errBox = form.querySelector('.form-error');
    const submit = form.querySelector('[type="submit"]');
    const all = form.querySelector('[data-act="all"]');
    const boxes = () => [...form.querySelectorAll('input[name="pick"]')];
    function update() {
      const n = boxes().filter((b) => b.checked).length;
      submit.disabled = !n;
      submit.textContent = n ? `Add ${plural(n, 'task')}` : 'Add tasks';
      const every = boxes().length > 0 && n === boxes().length;
      all.textContent = every ? 'Untick all' : 'Tick all';
      all.hidden = !boxes().length;
    }
    update();
    form.addEventListener('change', update);
    all.addEventListener('click', () => {
      const on = all.textContent === 'Tick all';
      boxes().forEach((b) => { b.checked = on; });
      update();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const keys = boxes().filter((b) => b.checked).map((b) => b.value);
      const picked = STARTER.filter((s) => keys.includes(s.key));
      if (!picked.length) return;
      const due = starterDates(picked, dates.today());
      const rows = picked.map((s) => {
        const owner = ownerFor(s.category);
        return {
          title: s.title, category: s.category, responsible_id: owner ? owner.id : null,
          due_date: due.get(s.key), due_time: null, lead_days: s.lead || 0,
          repeat_mode: s.mode, every_count: s.count, every_unit: s.unit, repeat_weekdays: [],
        };
      });
      submit.disabled = true;
      errBox.hidden = true;
      let saved;
      try {
        saved = (await q(core.sb.from('tasks').insert(rows).select('id'))) || [];
      } catch (err) {
        errBox.textContent = taskError(err);
        errBox.hidden = false;
        submit.disabled = false;
        return;
      }
      formDialog.close();
      const ids = saved.map((r) => r.id).filter(Boolean);
      const first = rows.map((r) => r.due_date).sort()[0];
      toast(`Added ${plural(rows.length, 'repeating task')} · the first is due ${dueWords(first)}`, {
        action: {
          label: 'Undo',
          async onClick() {
            await q(core.sb.from('tasks').delete().in('id', ids));
            toast(`Took ${plural(ids.length, 'starter task')} off the list`);
            afterChange();
          },
        },
      });
      afterChange();
    });
    formDialog.showModal();
  }

  // ============================================
  // THE TASK FORM
  // openTaskForm(defaults): a new task, or { task: row } / { id } to edit one.
  // defaults for a new one: title, date (or due_date), due_time, responsible_id (or responsibleId),
  // category, project_id, contractor_id, repeat_mode ('schedule' | 'after_done'); onSaved(row)
  // instead of redrawing the page.
  // What · When · Who's in charge · Repeats · More (category, heads-up, project, contact, notes, private).
  // "When" follows the repeat: a date (or No date) for a one-off, "Next one is due" on set dates,
  // and "When was it last done?" (or Not sure) for a while after it's done, which works out the due date.
  // ============================================
  const openForm = (defaults) => openTaskForm(defaults).catch((err) => toast(taskError(err), { error: true }));

  async function openTaskForm(defaults) {
    const d = defaults || {};
    let t = d.task || null;
    if (!t && d.id) {
      t = await q(core.sb.from('tasks').select('*').eq('id', d.id).maybeSingle());
      if (!t) throw new Error("That task isn't on the list any more.");
    }
    const [contacts, projects] = await Promise.all([loadContractors(), loadProjects()]);
    const x = t || {};
    const today = dates.today();
    const tomorrow = dates.addDays(today, 1);
    const yesterday = dates.addDays(today, -1);
    const wasAfter = !!(t && t.repeat_mode === 'after_done');
    const startMode = t ? (repeats(t) ? t.repeat_mode : 'none') : (['schedule', 'after_done'].includes(d.repeat_mode) ? d.repeat_mode : 'none');
    const state = {
      mode: startMode,
      due: t ? t.due_date || '' : [d.due_date, d.date].find(isIso) || '',
      last: t ? t.last_done || '' : '',
      // An after-done task being edited keeps its due date until "last done" or how often changes.
      touched: !wasAfter,
      resp: t ? t.responsible_id || null : d.responsible_id || d.responsibleId || null,
      days: new Set((x.repeat_weekdays || []).map(Number)),
    };
    if (state.mode === 'schedule' && !state.due) state.due = today;
    const count0 = Number(x.every_count) || Number(d.every_count) || 1;
    const unit0 = UNIT_WORDS[x.every_unit] ? x.every_unit : UNIT_WORDS[d.every_unit] ? d.every_unit : 'month';
    const category = CATEGORY_LABEL[x.category || d.category] ? x.category || d.category : 'other';
    const projectId = t ? x.project_id : d.project_id;
    const contactId = t ? x.contractor_id : d.contractor_id;
    const moreOpen = !!(x.notes || x.private || x.lead_days || projectId || contactId);
    const contactOptions = (contacts || []).map((c) => [c.id, c.company && c.company !== c.name ? `${c.name} (${c.company})` : c.name]);
    if (contactId && !contactOptions.some(([id]) => id === contactId)) contactOptions.unshift([contactId, 'The current contact']);
    const projectOptions = (projects || []).filter((p) => p.status !== 'done' || p.id === projectId).map((p) => [p.id, p.name]);
    if (projectId && !projectOptions.some(([id]) => id === projectId)) projectOptions.unshift([projectId, 'The current project']);
    const option = (value, label, chosen) => `<option value="${esc(value)}"${value === chosen ? ' selected' : ''}>${esc(label)}</option>`;

    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = `<form class="form d-inner tasks-form" novalidate>
      <div class="d-top"><h3>${t ? 'Edit task' : 'New task'}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <label class="field"><span>What</span><input type="text" name="title" value="${esc(x.title || d.title || '')}" maxlength="200" autocomplete="off" placeholder="Call the plumber, change the furnace filter"></label>
      <fieldset class="tasks-fs"><legend data-ref="when-label">When</legend>
        <div class="tasks-chiprow">
          <button type="button" class="tasks-chip" data-when="none">No date</button>
          <button type="button" class="tasks-chip" data-when="unsure">Not sure</button>
          <button type="button" class="tasks-chip" data-when="today">Today</button>
          <button type="button" class="tasks-chip" data-when="yesterday">Yesterday</button>
          <button type="button" class="tasks-chip" data-when="tomorrow">Tomorrow</button>
          <input type="date" name="when_date" aria-label="Date">
        </div>
        <label class="field tasks-time" data-show="time"><span>At <small>(optional)</small></span><input type="time" name="due_time" value="${esc(hm(t ? x.due_time : d.due_time))}"></label>
        <p class="tasks-hint" data-ref="due-hint" aria-live="polite"></p>
      </fieldset>
      <fieldset class="tasks-fs"><legend>Who's in charge</legend><div data-ref="who"></div></fieldset>
      <fieldset class="tasks-fs"><legend>Repeats</legend>
        <div class="tasks-modes" role="group" aria-label="Repeats">
          <button type="button" class="tasks-mode" data-mode="none"><b>Doesn't repeat</b></button>
          <button type="button" class="tasks-mode" data-mode="schedule"><b>On set dates</b><small>e.g. the 1st of every month</small></button>
          <button type="button" class="tasks-mode" data-mode="after_done"><b>A while after it's done</b><small>e.g. 60 days after the last change</small></button>
        </div>
        <div class="tasks-every" data-show="every">
          <span>Every</span>
          <input type="number" name="every_count" min="1" max="120" step="1" inputmode="numeric" value="${esc(count0)}" aria-label="How many">
          <select name="every_unit" aria-label="Days, weeks, months or years">${Object.keys(UNIT_WORDS).map((u) => option(u, UNIT_WORDS[u][1], unit0)).join('')}</select>
        </div>
        <div class="tasks-wdays" data-show="wdays" role="group" aria-label="On these days">${WD.map((w, i) => `<button type="button" class="tasks-wd" data-wd="${i + 1}" aria-label="${WD_LONG[i]}">${w.slice(0, 2)}</button>`).join('')}</div>
        <small class="tasks-hint" data-show="wdays">The due date's day of the week is always included.</small>
      </fieldset>
      <details class="tasks-more"${moreOpen ? ' open' : ''}>
        <summary>More: kind, heads-up, project, contact, notes</summary>
        <div class="tasks-more-body">
          <label class="field"><span>Kind</span><select name="category">${CATEGORIES.map(([k, l]) => option(k, l, category)).join('')}</select></label>
          <label class="field"><span>Heads-up <small>(days before it's due)</small></span><input type="number" name="lead_days" min="0" max="90" step="1" inputmode="numeric" value="${esc(x.lead_days || '')}" placeholder="0">
            <small>It shows under Heads-up on Today and in the morning email.</small></label>
          <label class="field"><span>Put on project</span><select name="project_id"><option value="">No project</option>${projectOptions.map(([id, l]) => option(id, l, projectId)).join('')}</select>
            ${projects ? '' : "<small>Couldn't load the projects just now. Try again later to pick one.</small>"}</label>
          <label class="field"><span>Directory contact</span><select name="contractor_id"><option value="">None</option>${contactOptions.map(([id, l]) => option(id, l, contactId)).join('')}</select>
            <small>${contacts ? 'Their phone number shows on the task, one tap to call.' : "Couldn't load the directory just now. Try again later to pick a contact."}</small></label>
          <label class="field"><span>Notes</span><textarea name="notes" rows="3">${esc(x.notes || '')}</textarea></label>
          <label class="check tasks-check"><input type="checkbox" name="private"${x.private ? ' checked' : ''}> Private: shows as 'Private item' on the wall, in Google and to kids and helpers</label>
        </div>
      </details>
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions">
        ${t ? '<button type="button" class="btn btn-danger left" data-act="delete">Delete</button>' : ''}
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${t ? 'Save' : 'Add task'}</button>
      </div>
    </form>`;

    const form = formDialog.querySelector('form');
    const el = form.elements;
    const errBox = form.querySelector('.form-error');
    const whoBox = form.querySelector('[data-ref="who"]');
    const count = () => {
      const n = Number(el.every_count.value);
      return Number.isInteger(n) && n >= 1 && n <= 120 ? n : 0;
    };
    const show = (name, on) => form.querySelectorAll(`[data-show="${name}"]`).forEach((b) => {
      b.hidden = !on;
      b.querySelectorAll('input, select').forEach((i) => { i.disabled = !on; });
    });

    // After done: the due date from when it was last done (not sure: today).
    function afterDue() {
      if (!state.touched && t && t.due_date) return t.due_date;
      if (!state.last) return today;
      const n = count();
      return n && isIso(state.last) ? addUnits(state.last, n, el.every_unit.value) : '';
    }

    function drawWho() {
      const shown = v2.people().filter((p) => p.active !== false || p.id === state.resp);
      const lead = v2.person(state.resp);
      whoBox.innerHTML = shown.length
        ? `<div class="who-chips" role="group" aria-label="Who's in charge">${shown.map((p) => ui.personChip(p, { ring: p.id === state.resp })).join('')}
            <button type="button" class="pchip tasks-nobody" data-nobody aria-pressed="${!state.resp}"><span class="pchip-name">Nobody</span></button></div>
           <small class="who-hint" aria-live="polite">${esc(lead ? `${firstName(lead.name)} is in charge. Tap again for nobody.` : 'Tap a name to put them in charge, or leave it to nobody for now.')}</small>`
        : '<small class="who-hint">No people yet. Add them on the Family page.</small>';
    }

    // Show what applies to the repeat chosen: the When chips and their meaning, the time, how often.
    function apply() {
      const mode = state.mode;
      const after = mode === 'after_done';
      const value = after ? state.last : state.due;
      form.querySelector('[data-ref="when-label"]').textContent = after ? 'When was it last done?' : mode === 'schedule' ? 'Next one is due' : 'When';
      const chipOn = { none: mode === 'none', unsure: after, today: true, yesterday: after, tomorrow: !after };
      const pressed = { none: !state.due, unsure: !state.last, today: value === today, yesterday: value === yesterday, tomorrow: value === tomorrow };
      form.querySelectorAll('[data-when]').forEach((b) => {
        b.hidden = !chipOn[b.dataset.when];
        b.setAttribute('aria-pressed', String(!!pressed[b.dataset.when]));
      });
      if (el.when_date.value !== value) el.when_date.value = value;
      if (after) el.when_date.max = today; else el.when_date.removeAttribute('max');
      el.when_date.setAttribute('aria-label', after ? 'The day it was last done' : 'Due date');
      show('time', !after && !!state.due);
      show('every', mode !== 'none');
      // A while after it's done counts in days, weeks or months (years only if it already did).
      const yearOk = !after || (wasAfter && x.every_unit === 'year');
      const yearOpt = el.every_unit.querySelector('option[value="year"]');
      yearOpt.disabled = !yearOk;
      yearOpt.hidden = !yearOk;
      if (!yearOk && el.every_unit.value === 'year') {
        el.every_unit.value = 'month';
        el.every_count.value = String(Math.min(120, (count() || 1) * 12));
      }
      const weekly = mode === 'schedule' && el.every_unit.value === 'week';
      show('wdays', weekly);
      const wd = isIso(state.due) ? dates.isoWeekday(state.due) : null;
      form.querySelectorAll('[data-wd]').forEach((b) => {
        const n = Number(b.dataset.wd);
        b.setAttribute('aria-pressed', String(n === wd || state.days.has(n)));
        if (n === wd) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
      });
      form.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));

      let hint = '';
      if (mode === 'schedule' && isIso(state.due) && count()) {
        const rule = ruleText({ every_count: count(), every_unit: el.every_unit.value, repeat_weekdays: weekly ? [...state.days, wd] : [] });
        hint = `After that: ${rule}, whether or not it's done on time.`;
      } else if (after) {
        const due = afterDue();
        const n = count();
        const every = n ? cadence({ repeat_mode: 'after_done', every_count: n, every_unit: el.every_unit.value }) : '';
        if (!state.touched) hint = `The next one is due ${fmt.dayLong(due)}.`;
        else if (!state.last) hint = `Not sure? Then it's due today.${every ? ` After that: ${every}.` : ''}`;
        else if (!due) hint = '';
        else if (due < today) hint = `So it's late: it was due ${fmt.dayLong(due)}.`;
        else if (due === today) hint = "So it's due today.";
        else hint = `So the next one is due ${fmt.dayLong(due)}.`;
      }
      form.querySelector('[data-ref="due-hint"]').textContent = hint;
    }

    drawWho();
    apply();

    form.addEventListener('click', async (e) => {
      const when = e.target.closest('[data-when]');
      if (when) {
        const day = { today, tomorrow, yesterday, none: '', unsure: '' }[when.dataset.when];
        if (state.mode === 'after_done') { state.last = day; state.touched = true; } else state.due = day;
        apply();
        return;
      }
      const m = e.target.closest('[data-mode]');
      if (m) {
        const mode = m.dataset.mode;
        if (mode === state.mode) return;
        if (mode === 'schedule' && !state.due) state.due = today;
        if (mode === 'after_done' && !wasAfter) state.touched = true;
        state.mode = mode;
        apply();
        return;
      }
      const wdBtn = e.target.closest('[data-wd]');
      if (wdBtn) {
        const n = Number(wdBtn.dataset.wd);
        if (isIso(state.due) && n === dates.isoWeekday(state.due)) return;
        if (state.days.has(n)) state.days.delete(n); else state.days.add(n);
        apply();
        return;
      }
      const chip = e.target.closest('[data-person], [data-nobody]');
      if (chip && whoBox.contains(chip)) {
        const id = chip.dataset.person || null;
        state.resp = !id || id === state.resp ? null : id;
        drawWho();
        const again = id ? [...whoBox.querySelectorAll('[data-person]')].find((b) => b.dataset.person === id) : whoBox.querySelector('[data-nobody]');
        if (again) again.focus();
        return;
      }
      if (e.target.closest('[data-act="delete"]')) {
        try {
          if (await deleteTask(t)) formDialog.close();
        } catch (err) { errBox.textContent = taskError(err); errBox.hidden = false; }
      }
    });
    const onDate = () => {
      if (state.mode === 'after_done') { state.last = el.when_date.value; state.touched = true; } else state.due = el.when_date.value;
      apply();
    };
    el.when_date.addEventListener('input', onDate);
    el.when_date.addEventListener('change', onDate);
    const onEvery = () => { if (state.mode === 'after_done') state.touched = true; apply(); };
    el.every_count.addEventListener('input', onEvery);
    el.every_unit.addEventListener('change', onEvery);

    // The tasks row from the form, checked against the table's rules first (friendlier than the database's).
    function readTask() {
      const val = (name) => String(el[name].value || '').trim();
      const title = val('title');
      if (!title) throw new Error('Give the task a name.');
      const leadText = val('lead_days');
      const lead = leadText === '' ? 0 : Number(leadText);
      if (!Number.isInteger(lead) || lead < 0 || lead > 90) throw new Error('Heads-up: a number of days from 0 to 90.');
      const row = {
        title,
        category: CATEGORY_LABEL[val('category')] ? val('category') : 'other',
        responsible_id: state.resp || null,
        lead_days: lead,
        project_id: val('project_id') || null,
        contractor_id: val('contractor_id') || null,
        notes: val('notes') || null,
        private: el.private.checked,
      };
      if (state.mode === 'none') {
        if (state.due && !isIso(state.due)) throw new Error('Pick a valid date, or No date.');
        const time = state.due ? val('due_time') : '';
        return Object.assign(row, {
          repeat_mode: 'none', due_date: state.due || null, due_time: time || null,
          every_count: null, every_unit: null, repeat_weekdays: [], anchor_date: null,
        });
      }
      const n = count();
      if (!n) throw new Error('How often? Enter a whole number from 1 to 120.');
      const unit = el.every_unit.value;
      if (state.mode === 'schedule') {
        if (!isIso(state.due)) throw new Error('Pick when the next one is due.');
        const time = val('due_time');
        const days = unit === 'week' ? [...new Set([...state.days, dates.isoWeekday(state.due)])].sort((a, b) => a - b) : [];
        return Object.assign(row, {
          repeat_mode: 'schedule', due_date: state.due, due_time: time || null,
          every_count: n, every_unit: unit, repeat_weekdays: days,
        });
      }
      if (state.last && !isIso(state.last)) throw new Error('Pick a valid date for when it was last done, or Not sure.');
      if (state.last > today) throw new Error("It can't have been done on a day that hasn't happened yet. Pick today or earlier, or Not sure.");
      Object.assign(row, {
        repeat_mode: 'after_done', due_date: afterDue(), due_time: null,
        every_count: n, every_unit: unit, repeat_weekdays: [],
      });
      if (state.touched) row.last_done = state.last || null;
      return row;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let row;
      try { row = readTask(); } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        return;
      }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      errBox.hidden = true;
      try {
        let saved;
        if (t) {
          const rows = await q(core.sb.from('tasks').update(row).eq('id', t.id).select());
          if (!rows || !rows.length) throw new Error(GONE);
          saved = rows[0];
        } else {
          saved = await q(core.sb.from('tasks').insert(row).select().single());
        }
        formDialog.close();
        const due = (saved && saved.due_date) || row.due_date;
        toast(t ? `Saved ${row.title}` : `Added ${row.title} · ${due ? `due ${dueWords(due)}` : 'no date yet'}`);
        if (typeof d.onSaved === 'function') d.onSaved(saved); else afterChange();
      } catch (err) {
        errBox.textContent = taskError(err);
        errBox.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });

    if (!formDialog.open) formDialog.showModal();
    if (window.innerWidth > 700) el.title.focus();
  }

  // ============================================
  // THE PAGE
  // ============================================
  // What a new task starts with on this view: the person on screen in charge, a repeat on Repeating,
  // the project on a project's list.
  function addDefaults(st) {
    const v = currentView(st);
    const out = {};
    if (v === 'me') out.responsible_id = v2.mePerson.id;
    else if (!VIEWS.includes(v)) out.responsible_id = v;
    if (v === 'repeating') out.repeat_mode = 'schedule';
    if (v === 'project' && st.projectId) out.project_id = st.projectId;
    return out;
  }

  // A chip redraws the page and puts the filter in the address (without reloading), so a reload or a
  // shared link shows the same list.
  function setView(st, v) {
    st.view = v;
    st.projectId = null;
    lastView = v;
    try { history.replaceState(null, '', `#/tasks/${encodeURIComponent(v)}`); } catch (e) { /* the address just doesn't follow */ }
    draw(st);
  }

  async function renderTasks(main, ctx) {
    const p = ctx.params || {};
    const st = { main, ctx, data: null, loads: 0, view: null, projectId: p.projectId || null, showLater: false, seenAt: Date.now() };
    let openId = null;
    if (p.arg && (VIEWS.includes(p.arg) || v2.person(p.arg))) st.view = p.arg;
    else if (p.arg) openId = p.arg;
    if (st.view) lastView = st.view; else st.view = lastView;
    st.data = await load();
    if (ctx.stale()) return;
    // #/tasks/<id>/done, or a task that's no longer open: its newest Done entry (with "Not done after
    // all"), over a list that has it (Repeating and Project don't list one-offs' Done entries).
    const open = openId ? st.data.open.find((x) => x.id === openId) : null;
    const done = openId && (p.done || !open) ? doneEntries(st.data).find((e) => e.task.id === openId) || null : null;
    const shownView = currentView(st);
    if (done && (shownView === 'repeating' || shownView === 'project' || !belongs(done.task, shownView))) {
      st.view = v2.mePerson && done.task.responsible_id === v2.mePerson.id ? 'me' : 'everyone';
      lastView = st.view;
    }
    page = st;
    ctx.signal.addEventListener('abort', () => { if (page === st) page = null; });
    // A screen left open (a kitchen tablet) catches up when it's looked at again after 5 minutes
    // away: the household's clock (past midnight, "today" moves on), then the list.
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || Date.now() - st.seenAt < 5 * 60000) return;
      st.seenAt = Date.now();
      try { await v2.refresh(); } catch (err) { /* keep the last clock; the list is still read again */ }
      if (!ctx.stale()) refresh(st);
    }, { signal: ctx.signal });
    main.addEventListener('click', (e) => {
      const chip = e.target.closest('.tasks-chips .pchip');
      if (chip) { setView(st, chip.dataset.view || chip.dataset.person); return; }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'add') openForm(addDefaults(st));
      else if (act.dataset.act === 'later') { st.showLater = true; draw(st); }
      else if (act.dataset.act === 'starter') openStarter();
    }, { signal: ctx.signal });
    draw(st);
    // #/tasks/<id>: the list, with that task open (or its Done entry, above).
    if (done) openDone(st, done);
    else if (open) openDetails(st, open);
    else if (openId) toast("That task isn't on the list any more. Here's the latest.");
  }

  // ============================================
  // REGISTER
  // ============================================
  HomeHub.register({
    name: 'tasks',
    schema: { min: 2, max: 99 },
    nav: { label: 'Tasks', order: 30, primary: true },
    // #/tasks · #/tasks/<me|everyone|repeating|project|person id|task id> · #/tasks/<task id>/done (its
    // Done entry) · #/tasks/project/<project id>; any other tasks address shows the list.
    match(parts) {
      if (parts[0] !== 'tasks') return null;
      if (parts.length === 2) return { arg: parts[1] };
      if (parts.length === 3 && parts[1] === 'project') return { arg: 'project', projectId: parts[2] };
      if (parts.length === 3 && parts[2] === 'done') return { arg: parts[1], done: true };
      return {};
    },
    render: renderTasks,
    provides: { openTaskForm },
  });
})();
