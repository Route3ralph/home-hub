/* =====================================================================
   HOME HUB — Settings (v2)
   The household's settings, which admins change and everyone else can
   read: the time zone, the usual morning-email time, days off (school
   holidays; repeating events can skip them) and who new pet and house
   tasks go to. For admins: whether the morning email is running (the
   hub-jobs function's status) and a preview of their own. Then Google
   Calendar & Hearth (coming next), how to put the Home Hub on a phone's
   Home Screen, and Sign out. Dates and times are the household's.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { G, esc, q, toast, friendly, formDialog, detailDialog, wireFormDialog } = core;
  const { v2 } = core;
  const { fmt, dates } = v2;

  // household.tz allows these (the migration's check), with names people know.
  const ZONES = [
    ['America/New_York', 'Eastern time (New York)'],
    ['America/Chicago', 'Central time (Chicago)'],
    ['America/Denver', 'Mountain time (Denver)'],
    ['America/Phoenix', 'Arizona (Phoenix, no daylight saving)'],
    ['America/Los_Angeles', 'Pacific time (Los Angeles)'],
    ['America/Anchorage', 'Alaska (Anchorage)'],
    ['Pacific/Honolulu', 'Hawaii (Honolulu)'],
  ];
  const ZONE = Object.fromEntries(ZONES);
  const MAX_RANGE = 120; // days in one "days off" range (a summer break fits; a typo of a year doesn't)
  // Why a previewed email wouldn't go out (hub-jobs preview's reason).
  const WHY_NOT = {
    email_off: 'Your morning email is off (Family page), so this is only what it would look like.',
    no_email: 'You have no email address on the Family page, so this wouldn\'t be sent.',
    unconfirmed: 'Your address isn\'t confirmed yet, so this wouldn\'t be sent until it is.',
    nothing_today: 'There\'s nothing on that day, so this one wouldn\'t be sent.',
  };

  // ============================================
  // HELPERS
  // ============================================
  const isAdmin = () => !!(core.me && core.me.role === 'admin');
  const hhmm = (t) => String(t || '').slice(0, 5);
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function isIso(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    try { return dates.addDays(s, 0) === s; } catch (e) { return false; }
  }
  const daysBetween = (a, b) => G.parseDate(b) - G.parseDate(a);
  // 'Thu Nov 26', with the year when it isn't the household's this year.
  const dayLabel = (iso) => `${fmt.day(iso)}${iso.slice(0, 4) === dates.today().slice(0, 4) ? '' : `, ${iso.slice(0, 4)}`}`;
  // 'today at 6:30am', 'yesterday at 6:30am', 'Tue Oct 27 at 6:30am' (an instant, in the household's zone).
  function whenLabel(instant) {
    const day = fmt.relDay(instant);
    const time = fmt.time(instant);
    if (!day || !time) return '';
    return `${/^(Today|Yesterday|Tomorrow)$/.test(day) ? day.toLowerCase() : day} at ${time}`;
  }
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

  // Sorted, unique, valid days off, grouped into runs of consecutive days: [{ from, to, days }].
  function dayRuns(list) {
    const days = [...new Set((list || []).map((d) => String(d).slice(0, 10)).filter(isIso))].sort();
    const runs = [];
    days.forEach((d) => {
      const last = runs[runs.length - 1];
      if (last && dates.addDays(last.to, 1) === d) { last.to = d; last.days.push(d); }
      else runs.push({ from: d, to: d, days: [d] });
    });
    return runs;
  }
  function runLabel(r) {
    if (r.from === r.to) return dayLabel(r.from);
    return `${dayLabel(r.from)} – ${dayLabel(r.to)} (${r.days.length} days)`;
  }
  // The same, as HTML: the day count kept on one line.
  function runHTML(r) {
    if (r.from === r.to) return esc(dayLabel(r.from));
    return `${esc(dayLabel(r.from))} – ${esc(dayLabel(r.to))} <span class="set-dayoff-n">(${r.days.length} days)</span>`;
  }

  // The household row, changed only if nobody else changed it since it was read. Returns the saved row.
  // An update the database refuses (not an admin) changes no rows, as does one that lost that race.
  async function saveHousehold(hh, patch) {
    const rows = await q(core.sb.from('household').update(patch).eq('id', true).eq('updated_at', hh.updated_at).select());
    if (!rows || !rows.length) {
      throw new Error('The settings weren\'t saved: someone else changed them a moment ago, or only an admin can. Reload the page to see the latest, then try again.');
    }
    // The rest of the hub (times, "today") follows the saved settings.
    try { await v2.refresh(); } catch (err) { /* the saved row still shows; the next sign-in catches up */ }
    return rows[0];
  }

  // The reason hub-jobs gave ({ error }), if it gave one; else fallback. A function that isn't
  // deployed answers 404 without one, as does a connection that never got through.
  async function fnMessage(error, fallback) {
    const res = error && error.context;
    try {
      const body = res && typeof res.json === 'function' ? await res.json() : null;
      if (body && typeof body.error === 'string' && body.error) return body.error;
    } catch (e) { /* not JSON */ }
    return fallback;
  }

  // ============================================
  // THE PAGE
  // ============================================
  async function renderSettings(main, ctx) {
    const admin = isAdmin();
    // Fresh settings: another admin may have changed them since sign-in.
    let refreshFailed = false;
    try { await v2.refresh(); } catch (err) { refreshFailed = true; }
    if (ctx.stale()) return;
    let hh = v2.household;

    main.innerHTML = `
      <div class="page-head set-head">
        <div><h1>Settings</h1><p class="meta">${admin ? 'For the whole household.' : 'Only admins (parents who sign in) can change these.'}</p></div>
      </div>
      ${refreshFailed ? '<div class="banner banner-warn">Couldn\'t load the latest settings, so these are the ones from when you signed in. Reload the page to try again.</div>' : ''}
      <section class="card set-card" aria-labelledby="setHousehold">
        <div class="card-head"><h2 id="setHousehold">Household</h2></div>
        <div class="set-body" data-ref="household"></div>
      </section>
      <section class="card set-card" aria-labelledby="setDaysOff">
        <div class="card-head"><h2 id="setDaysOff">Days off</h2><span class="card-sub">School holidays and other days off</span></div>
        <div class="set-body">
          <p class="set-help">Repeating events set to skip days off (the school run, say) don't happen on these days.</p>
          ${admin ? `<form class="set-dayoff" data-ref="dayoffForm" novalidate>
            <label class="field"><span>From</span><input type="date" name="from" required></label>
            <label class="field"><span>To <small>(optional)</small></span><input type="date" name="to"></label>
            <button type="submit" class="btn btn-primary set-btn">Add</button>
          </form>
          <p class="form-error" data-ref="dayoffError" role="alert" hidden></p>` : ''}
          <div data-ref="daysoff"></div>
          ${admin ? '<div class="set-stillon" data-ref="stillOn" aria-live="polite"></div>' : ''}
        </div>
      </section>
      <section class="card set-card" aria-labelledby="setEmail">
        <div class="card-head"><h2 id="setEmail">Morning email</h2></div>
        <div class="set-body">${admin ? `
          <div data-ref="status" aria-live="polite"></div>
          <div class="set-actions"><button type="button" class="btn set-btn" data-act="preview">Preview my morning email</button></div>`
          : '<p class="set-help">Each person\'s morning email is set on the Family page. Ask an admin to turn yours on or change it.</p>'}
        </div>
      </section>
      <section class="card set-card" aria-labelledby="setCalendar">
        <div class="card-head"><h2 id="setCalendar">Google Calendar &amp; Hearth</h2></div>
        <div class="set-body"><div class="set-row" data-ref="calendar"><span class="set-row-text">Not connected yet — coming next</span></div></div>
      </section>
      <section class="card set-card" aria-labelledby="setApp">
        <div class="card-head"><h2 id="setApp">Add Home Hub to your Home Screen</h2></div>
        <div class="set-body">
          <p class="set-help">It then opens like an app, full screen, one tap away.</p>
          <ul class="set-steps">
            <li><b>iPhone:</b> in Safari, tap Share (the square with an arrow), then <b>Add to Home Screen</b>. Open it from there and sign in again: the Home Screen app keeps its own sign-in.</li>
            <li><b>Android:</b> in Chrome, tap the ⋮ menu, then <b>Install app</b> (or <b>Add to Home screen</b>).</li>
          </ul>
          <p class="set-ok" data-ref="standalone" hidden>You're using the Home Screen app now.</p>
        </div>
      </section>
      <section class="card set-card" aria-labelledby="setAccount">
        <div class="card-head"><h2 id="setAccount">Signed in</h2></div>
        <div class="set-body set-account">
          <p class="set-who" data-ref="who"></p>
          <button type="button" class="btn set-btn" data-act="sign-out">Sign out</button>
        </div>
      </section>`;
    const ref = (name) => main.querySelector(`[data-ref="${name}"]`);
    // The family list's name (as the More sheet shows it), else the sign-in list's.
    const myName = (v2.mePerson && v2.mePerson.name) || (core.me && core.me.name) || '';
    ref('who').textContent = core.me ? `${myName}${core.me.email ? ` (${core.me.email})` : ''}`.trim() : '';
    let standalone = false;
    try { standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { /* older browsers */ }
    ref('standalone').hidden = !standalone;

    if (!hh) {
      ref('household').innerHTML = '<p class="set-help">The household\'s settings aren\'t there yet. Reload the page to try again.</p>';
    }

    // ---------- Household: time zone, morning-email time, who gets new pet and house tasks
    function ownerName(id) {
      const p = id && v2.person(id);
      return p ? `${p.name}${p.active === false ? ' (not active)' : ''}` : 'Nobody (choose each time)';
    }
    function ownerOptions(current) {
      const people = v2.people().filter((p) => p.active !== false || p.id === current);
      return `<option value="">Nobody (choose each time)</option>${people.map((p) =>
        `<option value="${esc(p.id)}"${p.id === current ? ' selected' : ''}>${esc(p.name)}${p.active === false ? ' (not active)' : ''}</option>`).join('')}`;
    }

    function drawHousehold() {
      if (!hh) return;
      const box = ref('household');
      if (!admin) {
        box.innerHTML = `<dl class="set-dl">
          <dt>Time zone</dt><dd>${esc(ZONE[hh.tz] || hh.tz)}</dd>
          <dt>Morning email time</dt><dd>${esc(fmt.time(hhmm(hh.digest_time)) || '—')}</dd>
          <dt>New pet tasks go to</dt><dd>${esc(ownerName(hh.pets_owner_id))}</dd>
          <dt>New house tasks go to</dt><dd>${esc(ownerName(hh.house_owner_id))}</dd>
        </dl>`;
        return;
      }
      const zones = ZONE[hh.tz] ? ZONES : [[hh.tz, hh.tz], ...ZONES];
      box.innerHTML = `<form class="form set-form" novalidate>
        <label class="field"><span>Time zone</span><select name="tz">${zones.map(([v, l]) => `<option value="${esc(v)}"${v === hh.tz ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
          <small>Every date and time in the Home Hub and the morning email uses this, wherever your phone is.</small></label>
        <label class="field"><span>Morning email time</span><input type="time" name="digest_time" value="${esc(hhmm(hh.digest_time))}" required>
          <small>When morning emails go out, unless someone picks their own time on the Family page.</small></label>
        <div class="field-row">
          <label class="field"><span>New pet tasks go to</span><select name="pets_owner_id">${ownerOptions(hh.pets_owner_id)}</select></label>
          <label class="field"><span>New house tasks go to</span><select name="house_owner_id">${ownerOptions(hh.house_owner_id)}</select></label>
        </div>
        <small class="set-help">Who's in charge to start with when you add a pet or house task (and starter tasks).</small>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions"><button type="submit" class="btn btn-primary set-btn">Save</button></div>
      </form>`;
      const form = box.querySelector('form');
      const errBox = form.querySelector('.form-error');
      const submit = form.querySelector('[type="submit"]');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const el = form.elements;
        const tz = el.tz.value;
        const time = String(el.digest_time.value || '').slice(0, 5);
        errBox.hidden = true;
        if (!ZONE[tz]) { errBox.textContent = 'Pick a time zone from the list.'; errBox.hidden = false; return; }
        if (!/^\d{2}:\d{2}$/.test(time)) { errBox.textContent = 'Pick a time for the morning email.'; errBox.hidden = false; return; }
        const patch = { tz, digest_time: time, pets_owner_id: el.pets_owner_id.value || null, house_owner_id: el.house_owner_id.value || null };
        const moved = tz !== hh.tz;
        submit.disabled = true;
        try {
          hh = await saveHousehold(hh, patch);
          if (ctx.stale()) return;
          toast('Settings saved');
          drawAll();
          // The last run's time reads differently in the new zone.
          if (moved) loadStatus();
        } catch (err) {
          errBox.textContent = friendly(err);
          errBox.hidden = false;
        } finally {
          submit.disabled = false;
        }
      }, { signal: ctx.signal });
    }

    // ---------- Days off
    function drawDaysOff() {
      const box = ref('daysoff');
      if (!hh) { box.innerHTML = ''; return; }
      const today = dates.today();
      const runs = dayRuns(hh.days_off);
      const coming = runs.filter((r) => r.to >= today);
      const past = runs.filter((r) => r.to < today);
      const row = (r) => `<li class="set-dayoff-row" data-from="${esc(r.from)}" data-to="${esc(r.to)}">
        <span class="set-dayoff-label">${runHTML(r)}</span>
        ${admin ? `<button type="button" class="btn btn-danger set-btn" data-remove="${esc(r.from)}" aria-label="Remove ${esc(runLabel(r))}">Remove</button>` : ''}
      </li>`;
      box.innerHTML = `${coming.length
        ? `<ul class="set-dayoffs">${coming.map(row).join('')}</ul>`
        : '<p class="empty-line">No days off coming up.</p>'}
        ${past.length ? `<details class="set-past"><summary>${esc(count(past.reduce((n, r) => n + r.days.length, 0), 'past day off', 'past days off'))}</summary>
          <ul class="set-dayoffs">${past.map(row).join('')}</ul></details>` : ''}`;
    }

    // Repeating events that would still happen on a coming day off, because they don't skip days off
    // (that box is easy to miss when adding the school run): each with a one-tap "Skip on days off".
    let repeating = null; // weekly events that don't skip days off; null until read (or if that failed)
    async function loadRepeating() {
      try {
        repeating = (await q(core.sb.from('events').select('id,title,start_date,repeat_every,repeat_weekdays,repeat_until')
          .eq('repeat', 'weekly').eq('skip_days_off', false).order('title'))) || [];
      } catch (err) { repeating = null; }
    }
    // The coming days off this event falls on (the database's rule: its weekdays, every N weeks from its start).
    function hitsOf(ev, days) {
      const weekdays = (ev.repeat_weekdays || []).map(Number);
      const every = Number(ev.repeat_every) || 1;
      const startMonday = dates.mondayOf(ev.start_date);
      return days.filter((d) => d >= ev.start_date && (!ev.repeat_until || d <= ev.repeat_until) && weekdays.includes(dates.isoWeekday(d))
        && (daysBetween(startMonday, dates.mondayOf(d)) / 7) % every === 0);
    }
    function drawStillOn() {
      const box = ref('stillOn');
      if (!box) return;
      const today = dates.today();
      const coming = hh ? dayRuns(hh.days_off).flatMap((r) => r.days).filter((d) => d >= today) : [];
      const hits = (repeating || []).map((ev) => ({ ev, days: hitsOf(ev, coming) })).filter((x) => x.days.length);
      if (!hits.length) { box.innerHTML = ''; return; }
      const daysText = (list) => `${list.slice(0, 3).map(dayLabel).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`;
      box.innerHTML = `<p class="set-help">These repeating events still happen on days off:</p>
        <ul class="set-dayoffs">${hits.map(({ ev, days }) => `<li class="set-dayoff-row">
          <span class="set-dayoff-label"><b>${esc(ev.title)}</b> <small>${esc(daysText(days))}</small></span>
          <button type="button" class="btn set-btn" data-skip-off="${esc(ev.id)}" aria-label="Skip ${esc(ev.title)} on days off">Skip on days off</button>
        </li>`).join('')}</ul>`;
    }
    async function setSkipDaysOff(ev, on) {
      const rows = await q(core.sb.from('events').update({ skip_days_off: on }).eq('id', ev.id).select('id'));
      if (!rows || !rows.length) throw new Error('That event was deleted a moment ago. Reload the page to see the latest.');
      await loadRepeating();
      if (!ctx.stale()) drawStillOn();
    }
    async function skipDaysOff(btn) {
      const ev = (repeating || []).find((x) => x.id === btn.dataset.skipOff);
      if (!ev) return;
      btn.disabled = true;
      try {
        await setSkipDaysOff(ev, true);
      } catch (err) {
        btn.disabled = false;
        toast(friendly(err), { error: true });
        return;
      }
      toast(`${ev.title} won't happen on days off`, {
        action: {
          label: 'Undo',
          async onClick() {
            await setSkipDaysOff(ev, false);
            toast(`${ev.title} happens on days off again`);
          },
        },
      });
    }

    async function writeDaysOff(next, done) {
      const errBox = ref('dayoffError');
      if (errBox) errBox.hidden = true;
      try {
        hh = await saveHousehold(hh, { days_off: next });
        if (ctx.stale()) return false;
        drawDaysOff();
        drawStillOn();
        toast(done);
        return true;
      } catch (err) {
        if (ctx.stale()) return false;
        if (errBox) { errBox.textContent = friendly(err); errBox.hidden = false; }
        else toast(friendly(err), { error: true });
        return false;
      }
    }

    const dayoffForm = ref('dayoffForm');
    if (dayoffForm) {
      dayoffForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = ref('dayoffError');
        const fail = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
        errBox.hidden = true;
        if (!hh) { fail('The household\'s settings aren\'t there yet. Reload the page to try again.'); return; }
        const from = dayoffForm.elements.from.value;
        const to = dayoffForm.elements.to.value || from;
        if (!isIso(from)) { fail('Pick the first day off.'); return; }
        if (!isIso(to)) { fail('Pick a valid last day, or leave it empty for one day.'); return; }
        if (to < from) { fail('The last day comes before the first. Check the dates.'); return; }
        if (daysBetween(from, to) + 1 > MAX_RANGE) { fail(`That's more than ${MAX_RANGE} days. Check the dates, or add it in parts.`); return; }
        const have = new Set(dayRuns(hh.days_off).flatMap((r) => r.days));
        const adding = [];
        for (let d = from; d <= to; d = dates.addDays(d, 1)) if (!have.has(d)) adding.push(d);
        if (!adding.length) { fail(from === to ? `${dayLabel(from)} is already a day off.` : 'Those days are already days off.'); return; }
        const next = [...have, ...adding].sort();
        const btn = dayoffForm.querySelector('[type="submit"]');
        btn.disabled = true;
        const label = from === to ? `${dayLabel(from)} is now a day off` : `Added ${count(adding.length, 'day', 'days')} off (${fmt.span(from, to)})`;
        if (await writeDaysOff(next, label)) dayoffForm.reset();
        btn.disabled = false;
      }, { signal: ctx.signal });
    }

    // ---------- Morning email: hub-jobs status (admins). Any failure reads "Not set up yet".
    async function loadStatus() {
      const box = ref('status');
      if (!box) return;
      box.innerHTML = '<p class="set-status">Checking…</p>';
      let data = null;
      let error = null;
      try {
        ({ data, error } = await core.sb.functions.invoke('hub-jobs', { body: { action: 'status' } }));
      } catch (err) { error = err; }
      if (ctx.stale()) return;
      if (error || !data || typeof data !== 'object') {
        const why = error ? await fnMessage(error, '') : '';
        if (ctx.stale()) return;
        box.innerHTML = `<p class="set-status"><b>Not set up yet</b></p>
          <p class="set-help">The morning email isn't switched on yet. Whoever set up the Home Hub needs to finish one last step (see the README).</p>
          <p class="set-help set-why" hidden></p>`;
        if (why) { const w = box.querySelector('.set-why'); w.textContent = why; w.hidden = false; }
        return;
      }
      const run = data.last_run && typeof data.last_run === 'object' ? data.last_run : null;
      const lines = [];
      if (!run) lines.push('<p class="set-status"><b>Hasn\'t run yet</b></p>');
      else {
        const failed = num(run.failed);
        lines.push(`<p class="set-status"><b>Last run ${esc(whenLabel(run.started_at) || 'at an unknown time')}, ${num(run.sent)} sent</b>${failed ? `<span class="badge late">${esc(`${failed} failed`)}</span>` : ''}</p>`);
        if (typeof run.message === 'string' && run.message) lines.push(`<p class="set-help">${esc(run.message)}</p>`);
      }
      const last = data.last_sent && typeof data.last_sent === 'object' ? data.last_sent : null;
      if (last && (!run || last.started_at !== run.started_at)) {
        lines.push(`<p class="set-help">Emails last went out ${esc(whenLabel(last.started_at))} (${esc(count(num(last.sent), 'email', 'emails'))}).</p>`);
      }
      const today = data.today_counts && data.today_counts.digest ? data.today_counts : null;
      if (today) {
        const sent = num(today.digest.sent);
        const confirms = today.confirm ? num(today.confirm.sent) : 0;
        lines.push(`<p class="set-help">Today: ${esc(count(sent, 'morning email', 'morning emails'))} sent${confirms ? `, ${esc(count(confirms, 'confirmation', 'confirmations'))}` : ''}.</p>`);
      }
      const messages = Array.isArray(data.messages) ? data.messages.filter((m) => typeof m === 'string' && m) : [];
      if (messages.length) lines.push(`<div class="banner banner-warn set-messages"><ul>${messages.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`);
      box.innerHTML = lines.join('');
    }

    // ---------- Preview my morning email (admins): subject and the text version, nothing sent.
    async function preview(btn) {
      const mine = v2.mePerson;
      if (!mine) { toast('You\'re not on the family list, so there\'s no morning email to preview.', { error: true }); return; }
      btn.disabled = true;
      btn.textContent = 'Making a preview…';
      try {
        let res;
        try { res = await core.sb.functions.invoke('hub-jobs', { body: { action: 'preview', person_id: mine.id } }); }
        catch (err) { res = { error: err }; }
        if (res.error) throw new Error(await fnMessage(res.error, 'Couldn\'t make a preview: the morning email isn\'t set up yet.'));
        const emails = res.data && Array.isArray(res.data.emails) ? res.data.emails : [];
        if (!ctx.stale()) showPreview(emails.find((x) => x && x.person_id === mine.id) || emails[0] || null);
      } catch (err) {
        if (!ctx.stale()) toast(friendly(err), { error: true });
      } finally {
        btn.disabled = false;
        btn.textContent = 'Preview my morning email';
      }
    }

    main.addEventListener('click', async (e) => {
      const skipOff = e.target.closest('[data-skip-off]');
      if (skipOff) { skipDaysOff(skipOff); return; }
      const rm = e.target.closest('[data-remove]');
      if (rm && hh) {
        const r = dayRuns(hh.days_off).find((x) => x.from === rm.dataset.remove);
        if (!r) return;
        const gone = new Set(r.days);
        rm.disabled = true;
        const ok = await writeDaysOff(dayRuns(hh.days_off).flatMap((x) => x.days).filter((d) => !gone.has(d)),
          r.from === r.to ? `${dayLabel(r.from)} is no longer a day off` : `Removed ${count(r.days.length, 'day', 'days')} off`);
        if (!ok) rm.disabled = false;
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'preview') preview(act);
      if (act.dataset.act === 'sign-out') {
        act.disabled = true;
        try { await core.sb.auth.signOut(); } catch (err) { act.disabled = false; toast(friendly(err), { error: true }); }
      }
    }, { signal: ctx.signal });

    function drawAll() { drawHousehold(); drawDaysOff(); drawStillOn(); }
    drawAll();
    if (admin) {
      await loadRepeating();
      if (ctx.stale()) return;
      drawStillOn();
      await loadStatus();
    }
  }

  // The preview dialog: who it's for, why it wouldn't go out (if so), the subject and the plain text.
  function showPreview(email) {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = `<div class="form d-inner set-preview">
      <div class="d-top"><h3>Your morning email</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <p class="meta" data-ref="for"></p>
      <p class="d-warn" data-ref="why" hidden></p>
      <div class="set-subject" data-ref="subjectBox"><span>Subject</span><strong data-ref="subject"></strong></div>
      <pre class="set-text" data-ref="text"></pre>
      <div class="form-actions"><button type="button" class="btn btn-primary set-btn" data-close>Done</button></div>
    </div>`;
    const ref = (name) => formDialog.querySelector(`[data-ref="${name}"]`);
    if (!email) {
      ref('for').textContent = 'There\'s no email to preview for you yet.';
      ref('subjectBox').hidden = true;
      ref('text').hidden = true;
    } else {
      ref('for').textContent = [email.local_date ? `For ${fmt.dayLong(email.local_date)}` : '', email.email ? `to ${email.email}` : ''].filter(Boolean).join(' · ');
      const why = !email.would_send && (WHY_NOT[email.reason] || 'This one wouldn\'t be sent.');
      if (why) { ref('why').textContent = why; ref('why').hidden = false; }
      ref('subject').textContent = String(email.subject || '');
      ref('text').textContent = String(email.text || '');
    }
    if (!formDialog.open) formDialog.showModal();
  }

  // ============================================
  // REGISTER
  // ============================================
  HomeHub.register({
    name: 'settings',
    schema: { min: 2, max: 99 },
    nav: { label: 'Settings', order: 70 },
    match: (parts) => (parts[0] === 'settings' ? {} : null),
    render: renderSettings,
  });
})();
