/* =====================================================================
   HOME HUB — Today (v2)
   One person's day at a glance. Person chips pick whose day (Me, each
   person, Everyone); their events and tasks for today, with one tap to tick
   a task off (and Undo); what's late; heads-up for what's coming; what
   nobody is on (parents); "Send <name> their day" for kids and helpers; one
   line per project with work today; and a first-run checklist until the
   household is set up. Dates and times are the household's (core.v2).
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { q, toast, friendly, firstName, telHref, smsHref, whatsappHref, openAdd } = core;
  const { esc, plural } = core.G;
  const { v2 } = core;
  const { call, fmt, dates, ui } = v2;

  // Whose day is on screen: 'me', 'all' or a person's id. Kept while the app is open, so coming
  // back to Today shows the same person.
  let view = null;

  // The checklist is a nudge: once the household is set up (or someone hides it), this device stops
  // asking. Per device, so a blocked or cleared storage only means the data is checked again.
  const SETUP_KEY = 'homehub.today.setup';
  function setupFlag() {
    try { return localStorage.getItem(SETUP_KEY); } catch (e) { return null; }
  }
  function setSetupFlag(value) {
    try { localStorage.setItem(SETUP_KEY, value); } catch (e) { /* storage unavailable: shown again next time */ }
  }

  // ============================================
  // WHO
  // ============================================
  // Inactive people (off the list for now) don't count as being on an item, as in the morning email.
  const activePerson = (id) => { const p = id && v2.person(id); return p && p.active !== false ? p : null; };
  const involves = (it, id) => it.responsible_id === id || (it.participant_ids || []).includes(id);
  const unassigned = (it) => !activePerson(it.responsible_id) && !(it.participant_ids || []).some(activePerson);
  const sendable = (p) => p.active !== false && (p.role === 'kid' || p.role === 'helper') && !!p.phone;
  const possessive = (name) => `${name}'s`;

  // The chip on screen, falling back to Me (or Everyone when the signed-in member isn't on the
  // family list) when the chosen person has gone.
  function currentView() {
    const mine = v2.mePerson;
    if (view === 'me' && mine) return 'me';
    if (view === 'all') return 'all';
    if (mine && view === mine.id) return 'me';
    if (view && activePerson(view)) return view;
    return mine ? 'me' : 'all';
  }

  // ============================================
  // DATA
  // ============================================
  // A project counts as active unless it's done, an idea or on hold.
  const liveProject = (status) => !['done', 'idea', 'on-hold'].includes(status);

  // Project names and statuses, for "one line per active project". Project tasks reach agenda()
  // through projects.task_dates, which a v1 copy of the site leaves stale (null) when it saves a
  // schedule; api.projects() fills them in, and then the agenda is read again.
  // Only the project lines need them, so a failed read leaves those out rather than the whole page.
  async function loadProjects() {
    let rows;
    try { rows = (await q(core.sb.from('projects').select('id,name,status,on_calendar,task_dates'))) || []; } catch (err) { return { rows: [], backfilled: false }; }
    const stale = rows.some((p) => p.on_calendar !== false && p.task_dates == null && liveProject(p.status));
    if (!stale) return { rows, backfilled: false };
    try { await core.api.projects(); } catch (err) { return { rows, backfilled: false }; }
    return { rows, backfilled: true };
  }

  // What the checklist needs from the database (the people steps use the people cache).
  // A failed check hides the checklist this time; it's not worth an error.
  async function loadSetup() {
    if (setupFlag()) return null;
    try {
      const [weekly, repeating, directory] = await Promise.all([
        q(core.sb.from('events').select('id').eq('repeat', 'weekly').limit(1)),
        q(core.sb.from('tasks').select('id').neq('repeat_mode', 'none').limit(1)),
        q(core.sb.from('contractors').select('id').limit(1)),
      ]);
      return { weekly: weekly.length > 0, repeating: repeating.length > 0, directory: directory.length > 0 };
    } catch (err) { return null; }
  }

  // day_text for every kid and helper with a phone, so the Send buttons are ready to tap (a link
  // has to have its message before the tap, or phones block the new window).
  function loadTexts(today) {
    return Promise.all(v2.people().filter(sendable).map((p) => call('day_text', { p_person: p.id, p_day: today })
      .then((text) => ({ person: p, text }), (err) => ({ person: p, error: friendly(err) }))));
  }

  async function load() {
    const today = dates.today();
    const projects = loadProjects();
    const [agenda, late, heads, setup, texts] = await Promise.all([
      call('agenda', { p_from: today, p_to: today }),
      call('late_items'),
      call('heads_up', { p_day: today }),
      loadSetup(),
      loadTexts(today),
      projects,
    ]);
    const p = await projects;
    return {
      today,
      agenda: (p.backfilled ? await call('agenda', { p_from: today, p_to: today }) : agenda) || [],
      late: late || [],
      heads: heads || [],
      projects: p.rows,
      setup,
      texts,
    };
  }

  // ============================================
  // ACTIONS
  // ============================================
  // Read everything again and redraw, keeping the newest answer when several are in flight.
  async function refresh(st) {
    const seq = ++st.loads;
    try {
      const data = await load();
      if (seq !== st.loads || st.ctx.stale()) return;
      st.data = data;
      draw(st);
    } catch (err) {
      if (!st.ctx.stale()) toast(friendly(err), { error: true });
    }
  }

  // The tick box: done today, with a 6-second Undo. Someone else's tick (or a screen left open
  // since yesterday) shows the latest list instead of an error.
  async function tick(st, it) {
    let logId;
    try {
      logId = await call('complete_task', { p_id: it.item_id, p_occurrence: it.occurrence });
    } catch (err) {
      if (!/^already (done|completed)$/.test((err && err.message) || '')) throw err;
      toast('Someone already ticked that off. This is the latest.');
      refresh(st);
      return;
    }
    toast(`Done: ${it.title}`, {
      action: {
        label: 'Undo',
        async onClick() {
          await call('undo_task', { p_log_id: logId });
          toast(`Not done: ${it.title}`);
          if (!st.ctx.stale()) refresh(st);
        },
      },
    });
    refresh(st);
  }

  // A tap on a ticked box (after asking): not done after all. Its task log entry is undone.
  async function untick(st, it) {
    await v2.undoDone(it);
    toast(`Not done: ${it.title}`);
    if (!st.ctx.stale()) refresh(st);
  }

  // "I'll do it" on something nobody is on: puts the signed-in person in charge, unless someone
  // else got there first. "Nobody" includes someone taken off the lists for now (not active), so the
  // write matches whoever the screen showed in charge, and Undo puts them back. On a repeating event
  // it's that one day (its event_changes row, as Change this day writes it), not every week.
  async function take(st, it, btn) {
    const mine = v2.mePerson;
    const oneDay = it.kind === 'event' && !!it.repeating;
    btn.disabled = true;
    let undo;
    try {
      undo = oneDay ? await takeDay(it, mine.id) : await takeItem(it, mine.id);
    } catch (err) {
      btn.disabled = false;
      toast(friendly(err), { error: true });
      return;
    }
    if (!undo) {
      toast('Someone else just took that one. This is the latest.');
      refresh(st);
      return;
    }
    const when = !oneDay ? '' : it.occurrence === dates.today() ? ' today only' : ` on ${fmt.day(it.occurrence)} only`;
    toast(`You're on it${when}: ${it.title}`, {
      action: {
        label: 'Undo',
        async onClick() {
          await undo();
          toast(`Nobody's on it again: ${it.title}`);
          if (!st.ctx.stale()) refresh(st);
        },
      },
    });
    refresh(st);
  }

  // A filter on who's in charge: that person, or nobody.
  const inCharge = (query, id) => (id ? query.eq('responsible_id', id) : query.is('responsible_id', null));

  // A task or a one-off event: its own row. Resolves to the Undo, or null if someone else was quicker.
  async function takeItem(it, myId) {
    const table = () => core.sb.from(it.kind === 'event' ? 'events' : 'tasks');
    const was = it.responsible_id || null;
    const rows = await q(inCharge(table().update({ responsible_id: myId }).eq('id', it.item_id), was).select('id'));
    if (!rows || !rows.length) return null;
    return () => q(table().update({ responsible_id: was }).eq('id', it.item_id).eq('responsible_id', myId).select('id'));
  }

  // One day of a repeating event: a new change for that day, or (a day already changed) that change,
  // only if it still has the person the screen showed. Resolves to the Undo, or null.
  async function takeDay(it, myId) {
    const changes = () => core.sb.from('event_changes');
    const day = it.occurrence;
    if (!it.changed) {
      try {
        await q(changes().insert({ event_id: it.item_id, on_date: day, cancelled: false, responsible_id: myId }).select('event_id'));
      } catch (err) {
        if (err && err.code === '23505') return null; // someone changed that day a moment ago
        throw err;
      }
      return () => q(changes().delete().eq('event_id', it.item_id).eq('on_date', day).eq('responsible_id', myId));
    }
    const found = (await q(changes().select('responsible_id').eq('event_id', it.item_id).eq('on_date', day))) || [];
    if (!found.length) return null;
    // A change without a person leaves the series' person in charge, which is what the screen showed.
    const was = found[0].responsible_id || null;
    if (was && was !== (it.responsible_id || null)) return null;
    const rows = await q(inCharge(changes().update({ responsible_id: myId }).eq('event_id', it.item_id).eq('on_date', day), was).select('event_id'));
    if (!rows || !rows.length) return null;
    return () => q(changes().update({ responsible_id: was }).eq('event_id', it.item_id).eq('on_date', day).eq('responsible_id', myId).select('event_id'));
  }

  // "Which one is you?": link the signed-in admin's email to a parent on the family list who has
  // none yet. Signing in proved the address, so it counts as confirmed for the morning email.
  async function linkMe(st, btn) {
    const p = activePerson(st.pick);
    if (!p) return;
    btn.disabled = true;
    try {
      await call('save_person', { p: { id: p.id, email: core.me.email }, p_can_sign_in: true });
      await call('mark_signed_in').catch(() => {});
      await v2.refresh();
    } catch (err) {
      btn.disabled = false;
      toast(friendly(err), { error: true });
      return;
    }
    if (st.ctx.stale()) return;
    st.pick = null;
    view = 'me';
    toast(`Thanks, ${firstName(p.name)}. Today now shows your day.`);
    draw(st);
  }

  // ============================================
  // DRAWING
  // ============================================
  const svg = (name) => ui.icon[name] || '';

  // Tapping a row opens it where it lives: an event's day on the Calendar, a task on Tasks (one that's
  // done opens its Done entry, with "Not done after all"), a project task on its project, a contract
  // in the Directory.
  function openItem(it) {
    const id = encodeURIComponent(it.item_id || '');
    const task = it.status === 'done' ? `#/tasks/${id}/done` : `#/tasks/${id}`;
    const to = { event: `#/calendar/event/${id}/${encodeURIComponent(it.occurrence || '')}`, task,
      project: `#/projects/${encodeURIComponent(it.project_id || it.item_id || '')}`, contract: `#/directory/${id}` }[it.kind];
    if (to) location.hash = to;
  }

  function greeting() {
    const hour = Number(String((v2.clock && v2.clock.local_time) || '12').slice(0, 2));
    const mine = v2.mePerson;
    const name = firstName(mine ? mine.name : (core.me && core.me.name) || '');
    const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    return name ? `${hello}, ${name}` : hello;
  }

  // Me (the signed-in person's own chip, labelled Me), everyone else on the list, then Everyone.
  function chipsHTML(v) {
    const mine = v2.mePerson;
    const holder = document.createElement('div');
    if (mine) {
      holder.innerHTML = ui.personChip(mine, { selected: v === 'me' });
      const chip = holder.firstElementChild;
      chip.dataset.view = 'me';
      chip.removeAttribute('data-person');
      chip.querySelector('.pchip-name').textContent = 'Me';
      chip.title = `${mine.name} (you)`;
    }
    const others = v2.people().filter((p) => p.active !== false && (!mine || p.id !== mine.id));
    const colors = others.concat(mine ? [mine] : []).map((p) => p.color).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c || '')).slice(0, 6);
    const wheel = colors.length
      ? `conic-gradient(${colors.map((c, i) => `${c} ${(i * 100) / colors.length}% ${((i + 1) * 100) / colors.length}%`).join(', ')})`
      : 'var(--text-3)';
    return `${holder.innerHTML}${others.map((p) => ui.personChip(p, { selected: v === p.id })).join('')}
      <button type="button" class="pchip today-all" data-view="all" aria-pressed="${v === 'all'}"><span class="pchip-dot today-all-dot" style="background:${wheel}" aria-hidden="true"></span><span class="pchip-name">Everyone</span></button>`;
  }

  function whoHTML(st) {
    if (v2.mePerson || !core.me) return '';
    if (core.me.role !== 'admin') {
      return '<p class="banner banner-warn today-who">You aren\'t on the family list yet, so Today shows everyone. Ask an admin to add you on the Family page.</p>';
    }
    const candidates = v2.people().filter((p) => p.active !== false && p.role === 'parent' && !p.email);
    if (!candidates.length) {
      return `<p class="banner banner-warn today-who">You aren't on the family list yet, so Today shows everyone.
        <a href="#/people">Add yourself on the Family page</a> with ${esc(core.me.email)}.</p>`;
    }
    return `<section class="today-card today-who" aria-labelledby="todayWhoTitle">
      <h2 id="todayWhoTitle">Which one is you?</h2>
      <p class="today-note">Pick your name so Today can show your day. It gets your sign-in email, ${esc(core.me.email)}.</p>
      <div class="who-chips" role="group" aria-label="Which one is you">${candidates.map((p) => ui.personChip(p, { selected: p.id === st.pick })).join('')}</div>
      <div class="today-who-actions"><button type="button" class="btn btn-primary" data-act="link-me"${activePerson(st.pick) ? '' : ' disabled'}>That's me</button></div>
    </section>`;
  }

  // Events first (all-day, then by time), then tasks (by time, then the rest; done ones last).
  function dayOrder(a, b) {
    const rank = (it) => (it.kind === 'event' ? (it.local_start ? 1 : 0) : it.status === 'open' ? 2 : 3);
    // 'HH:MM:SS' sorts as text; no time goes last.
    const time = (it) => it.local_start || '99';
    return rank(a) - rank(b) || (time(a) < time(b) ? -1 : time(a) > time(b) ? 1 : 0) || String(a.title).localeCompare(String(b.title));
  }

  function projectLines(d) {
    const byId = new Map(d.projects.map((p) => [p.id, p]));
    const groups = new Map();
    d.agenda.filter((it) => it.kind === 'project' && it.status !== 'done').forEach((it) => {
      const p = byId.get(it.project_id);
      if (p && !liveProject(p.status)) return;
      if (!groups.has(it.project_id)) groups.set(it.project_id, { id: it.project_id, name: it.project_name || (p && p.name) || 'Project', items: [] });
      groups.get(it.project_id).items.push(it);
    });
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  // One short line per project, however many jobs overlap: "Kitchen Renovation: 2 starting today ·
  // 4 in progress", with the jobs starting today named under it (two at most, then "+N more").
  // Starting today includes one-day jobs and milestones; a job finishing today is still in progress.
  function projectSummary(g, today) {
    const starting = g.items.filter((it) => it.day === today);
    const going = g.items.length - starting.length;
    const counts = [starting.length ? `${starting.length} starting today` : '', going ? `${going} in progress` : ''].filter(Boolean);
    const names = starting.slice(0, 2).map((it) => it.title);
    if (starting.length > 2) names.push(`+${starting.length - 2} more`);
    return { counts, names };
  }

  function projectsHTML(lines, today) {
    return `<ul class="today-projects">${lines.map((g) => {
      const { counts, names } = projectSummary(g, today);
      const calls = new Map();
      g.items.forEach((it) => { if (it.contractor_phone && !calls.has(it.contractor_phone)) calls.set(it.contractor_phone, it.contractor_name || ''); });
      return `<li>
        <a class="today-proj" href="#/projects/${encodeURIComponent(g.id)}"><span class="today-proj-line"><b>${esc(g.name)}:</b> ${counts.map((c) => `<span class="today-proj-count">${esc(c)}</span>`).join(' · ')}</span>${names.length
          ? `<small class="today-proj-jobs">${esc(names.join(' · '))}</small>` : ''}</a>
        ${[...calls].slice(0, 2).map(([phone, name]) => `<a class="today-call" href="${esc(telHref(phone))}" aria-label="Call ${esc(name)} ${esc(phone)}" title="Call ${esc([name, phone].filter(Boolean).join(', '))}">${svg('phone')}</a>`).join('')}
      </li>`;
    }).join('')}</ul>`;
  }

  function sendHTML(texts) {
    return `<ul class="today-send">${texts.map(({ person, text, error }) => {
      const name = firstName(person.name);
      if (error || !text) {
        return `<li><div class="today-send-who">${ui.personDot(person)}<b>Send ${esc(name)} their day</b></div>
          <p class="today-note">Couldn't get ${esc(possessive(name))} day: ${esc(error || 'nothing came back')}. Reload to try again.</p></li>`;
      }
      return `<li data-send="${esc(person.id)}">
        <div class="today-send-who">${ui.personDot(person)}<b>Send ${esc(name)} their day</b></div>
        <div class="today-send-btns">
          <a class="btn" data-via="whatsapp" href="${esc(whatsappHref(person.phone, text))}" target="_blank" rel="noopener" aria-label="Send ${esc(name)} their day by WhatsApp">WhatsApp</a>
          <a class="btn" data-via="sms" href="${esc(smsHref(person.phone, text))}" aria-label="Send ${esc(name)} their day by text">Text</a>
        </div>
        <details class="today-preview"><summary>See the message</summary><pre>${esc(text)}</pre></details>
      </li>`;
    }).join('')}</ul>`;
  }

  function setupHTML(setup) {
    const people = v2.people().filter((p) => p.active !== false);
    const steps = [
      { done: people.length >= 2, title: 'Add the people in your home', help: 'Kids, helpers and the other grown-ups, each with a colour.', href: '#/people', go: 'Family' },
      { done: people.some((p) => p.digest_enabled), title: 'Turn on someone\'s morning email', help: 'Their day in their inbox before breakfast.', href: '#/people', go: 'Family' },
      { done: setup.weekly, title: 'Add the weekly routine', help: 'Piano on Tuesdays, Saturday swim: events that repeat every week.', act: 'add-event', go: 'Add event' },
      { done: setup.directory, title: 'Add a directory entry', help: 'The plumber, the internet company, the vet.', href: '#/directory', go: 'Directory' },
      { done: setup.repeating, title: 'Add starter tasks', help: 'Furnace filter, heartworm pill, oil change: tasks that repeat.', href: '#/tasks/repeating', go: 'Tasks' },
    ];
    const done = steps.filter((s) => s.done).length;
    if (done === steps.length) return '';
    return `<section class="today-card today-setup" aria-labelledby="todaySetupTitle">
      <div class="today-setup-head"><h2 id="todaySetupTitle">Get the Home Hub ready</h2><span class="sec-count">${done} of ${steps.length}</span></div>
      <ol class="today-steps">${steps.map((s) => `<li class="${s.done ? 'is-done' : ''}">
        <span class="today-step-mark" aria-hidden="true">${s.done ? svg('check') : ''}</span>
        <span class="today-step-text"><b>${esc(s.title)}</b>${s.done ? '<span class="sr-only"> (done)</span>' : `<small>${esc(s.help)}</small>`}</span>
        ${s.done ? '' : s.act ? `<button type="button" class="btn btn-sm" data-act="${s.act}">${esc(s.go)}</button>` : `<a class="btn btn-sm" href="${s.href}">${esc(s.go)}</a>`}
      </li>`).join('')}</ol>
      <button type="button" class="linkbtn today-hide" data-act="hide-setup">Hide this list</button>
    </section>`;
  }

  function draw(st) {
    const { main } = st;
    const d = st.data;
    const v = currentView();
    const mine = v2.mePerson;
    const focus = v === 'me' ? mine.id : v === 'all' ? null : v;
    const focusPerson = focus && v2.person(focus);
    const household = v === 'me' || v === 'all';
    const parent = mine ? mine.role === 'parent' : !!(core.me && core.me.role === 'admin');
    const showNobody = parent && household;
    // Everyone's view leaves out what nobody is on when "Nobody's on it" lists it.
    const shown = (it) => (focus ? involves(it, focus) : !(showNobody && unassigned(it)));
    const dayKinds = (it) => (it.kind === 'event' || it.kind === 'task') && it.status !== 'cancelled';

    const dayItems = d.agenda.filter((it) => dayKinds(it) && shown(it)).sort(dayOrder);
    const late = d.late.filter(shown);
    const heads = d.heads.filter((it) => (it.kind === 'contract' ? household : !focus || involves(it, focus)));
    const nobody = showNobody
      ? d.agenda.filter((it) => dayKinds(it) && it.status === 'open' && unassigned(it)).sort(dayOrder).concat(d.late.filter(unassigned))
      : [];
    const lines = household ? projectLines(d) : [];
    const texts = d.texts.filter((t) => (household ? true : t.person.id === focus));
    let setup = '';
    if (household && d.setup && !setupFlag()) {
      setup = setupHTML(d.setup);
      if (!setup) setSetupFlag('done');
    }

    const dayTitle = v === 'me' ? 'Your day' : v === 'all' ? 'Everyone today' : `${possessive(firstName(focusPerson.name))} day`;
    const nothing = v === 'me' ? 'Nothing for you today.' : v === 'all' ? 'Nothing planned today.' : `Nothing for ${firstName(focusPerson.name)} today.`;
    const side = [
      nobody.length ? `<section class="today-sec" aria-label="Nobody's on it">${ui.sectionHeading('Nobody\'s on it', nobody.length)}<div class="today-card irows" data-list="nobody"></div>
        ${nobody.length > 5 ? `<a class="today-more" href="#/tasks">${nobody.length - 5} more on the Tasks page</a>` : ''}</section>` : '',
      texts.length ? `<section class="today-sec" aria-label="Send their day">${ui.sectionHeading('Send their day')}<div class="today-card">${sendHTML(texts)}</div></section>` : '',
      lines.length ? `<section class="today-sec" aria-label="Projects today">${ui.sectionHeading('Projects today', lines.length)}<div class="today-card">${projectsHTML(lines, d.today)}</div></section>` : '',
      setup,
    ].join('');

    // Keep the chip row's sideways scroll and the focused chip across the redraw.
    const oldChips = main.querySelector('.today-chips');
    const chipScroll = oldChips ? oldChips.scrollLeft : 0;
    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.pchip');
    const focusKey = focused ? focused.dataset.view || focused.dataset.person : null;

    main.innerHTML = `
      <div class="page-head today-head">
        <div><p class="eyebrow">${esc(fmt.dayLong(d.today))}</p><h1>${esc(greeting())}</h1></div>
      </div>
      ${whoHTML(st)}
      <div class="today-chips" role="group" aria-label="Whose day">${chipsHTML(v)}</div>
      <div class="today-grid${side ? ' has-side' : ''}">
        <div class="today-col">
          <section class="today-sec" aria-label="${esc(dayTitle)}">${ui.sectionHeading(dayTitle, dayItems.length)}
            ${dayItems.length ? '<div class="today-card irows" data-list="day"></div>' : `<p class="today-card empty-line today-empty">${esc(nothing)} Use ＋ to add an event or a task.</p>`}
          </section>
          ${late.length ? `<section class="today-sec" aria-label="Late">${ui.sectionHeading('Late', late.length)}<div class="today-card irows" data-list="late"></div>
            ${late.length > 3 ? `<a class="today-more" href="#/tasks">${esc(plural(late.length - 3, 'more late task'))} on the Tasks page</a>` : ''}</section>` : ''}
          ${heads.length ? `<section class="today-sec" aria-label="Heads-up">${ui.sectionHeading('Heads-up', heads.length)}<div class="today-card irows" data-list="heads"></div></section>` : ''}
        </div>
        ${side ? `<div class="today-col today-side">${side}</div>` : ''}
      </div>`;

    const rowOpts = (extra) => Object.assign({ checkbox: true, showWho: true, onToggle: (it) => tick(st, it), onUntick: (it) => untick(st, it), onOpen: openItem }, extra);
    const fill = (name, items, extra) => {
      const list = main.querySelector(`[data-list="${name}"]`);
      if (list) items.forEach((it) => list.appendChild(ui.itemRow(it, rowOpts(extra))));
      return list;
    };
    fill('day', dayItems);
    fill('late', late.slice(0, 3));
    fill('heads', heads.map((it) => (it.kind === 'contract' ? Object.assign({}, it, { title: 'Contract ends', location: null }) : it)), { showDate: true });
    const nobodyList = fill('nobody', nobody.slice(0, 5));
    if (nobodyList && mine) {
      nobody.slice(0, 5).forEach((it, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm today-take';
        btn.textContent = 'I\'ll do it';
        btn.setAttribute('aria-label', `I'll do it: ${it.title}`);
        btn.addEventListener('click', () => take(st, it, btn));
        nobodyList.children[i].appendChild(btn);
      });
    }

    const chips = main.querySelector('.today-chips');
    chips.scrollLeft = chipScroll;
    const again = focusKey && [...main.querySelectorAll('.pchip')].find((b) => (b.dataset.view || b.dataset.person) === focusKey);
    if (again) again.focus();
  }

  // ============================================
  // TODAY
  // ============================================
  async function renderToday(main, ctx) {
    const st = { main, ctx, data: null, loads: 0, pick: null, seenAt: Date.now() };
    st.data = await load();
    if (ctx.stale()) return;
    // A screen left open (a kitchen tablet, a phone in a pocket overnight) catches up when it's looked
    // at again after 5 minutes away: the household's clock (past midnight, "today" moves on), then the day.
    // Date.now() only measures the time away; dates come from the household's clock.
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || Date.now() - st.seenAt < 5 * 60000) return;
      st.seenAt = Date.now();
      try { await v2.refresh(); } catch (err) { /* keep the last clock; the day is still read again */ }
      if (!ctx.stale()) refresh(st);
    }, { signal: ctx.signal });
    main.addEventListener('click', (e) => {
      const chip = e.target.closest('.today-chips .pchip');
      if (chip) { view = chip.dataset.view || chip.dataset.person; draw(st); return; }
      const pick = e.target.closest('.today-who .pchip');
      if (pick) { st.pick = pick.dataset.person; draw(st); return; }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'add-event') openAdd('event');
      else if (act.dataset.act === 'link-me') linkMe(st, act);
      else if (act.dataset.act === 'hide-setup') {
        setSetupFlag('hidden');
        draw(st);
        toast('Checklist hidden on this device.');
      }
    }, { signal: ctx.signal });
    draw(st);
  }

  HomeHub.register({
    name: 'today',
    schema: { min: 2, max: 99 },
    nav: { label: 'Today', order: 10, href: '#/', primary: true },
    // The first page ("#/"); the core also shows it for any address no other page claims.
    match: (parts) => (!parts.length || (parts.length === 1 && parts[0] === 'today') ? {} : null),
    render: renderToday,
  });
})();
