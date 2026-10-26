/* =====================================================================
   HOME HUB — Settings (v2)
   The household's settings, which admins change and everyone else can
   read: the time zone, the usual morning-email time, days off (school
   holidays; repeating events can skip them) and who new pet and house
   tasks go to. For admins: whether the morning email is running (the
   hub-jobs function's status) and a preview of their own. Then Google
   Calendar & Hearth (schema 3; on schema 2 it waits for the database
   update): which Google calendar is whose, Test, the preview and Start
   copying, Sync now, what went wrong and what was put back, and a note on
   the Hearth wall. Members see that card read-only. Then how to put the
   Home Hub on a phone's Home Screen, and Sign out. Dates and times are the
   household's.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { G, esc, q, toast, friendly, firstName, formDialog, detailDialog, wireFormDialog } = core;
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
        <div class="set-body" data-ref="calendar">${core.schemaVersion >= 3 ? '<p class="set-status">Checking…</p>'
          : '<div class="set-row"><span class="set-row-text">Waiting for the database update</span></div>'}</div>
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
    // Google Calendar & Hearth loads alongside the admin's reads (schema 3 only).
    const google = core.schemaVersion >= 3 ? googleCard(ref('calendar'), ctx, admin) : null;
    if (admin) {
      await loadRepeating();
      if (ctx.stale()) return;
      drawStillOn();
      await loadStatus();
    }
    if (google) await google;
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
  // GOOGLE CALENDAR & HEARTH (schema 3: migration 0003_google_calendar.sql)
  // One Google calendar per column on the kitchen wall (each active person, Family; Pets and House if
  // wanted) that the hub copies its items to, plus calendars it only reads. hub-jobs does the copying
  // every 5 minutes and answers Test and Sync now; this card sets the calendars rows (admins: RLS and
  // column grants), shows what hub-jobs recorded (calendar_sync, calendars' status, calendar_links),
  // and nothing is copied to a calendar until an admin has looked at everything it copies (the job's
  // window, yesterday to 60 days ahead) and pressed Start copying. Members see the same card without buttons or the problem lists.
  // ============================================
  const HUB_ID = /^[a-z0-9._-]+@group\.calendar\.google\.com$/;    // a calendar made for the hub (the table's check)
  const ANY_ID = /^[a-z0-9._+#-]{1,200}@[a-z0-9.-]+\.[a-z]{2,}$/;    // any Calendar ID ('#' for holiday calendars)
  const SLOT = { family: 'Family', pets: 'Pets', house: 'House' };
  const MAIN = "Family account's main calendar";
  const MAIN_LABEL = 'Family account';
  const WAITING = 'Waiting for the hub-jobs update';
  // Who a calendar the hub only reads reaches (private.google_for, docs/v1.1 §5.4).
  const READ_HELP = 'Their events show on the Calendar and Today pages and in grown-ups\' morning emails. A Family one\'s reach kids\' My day only with Show to kids, '
    + 'and never a helper\'s. One you give to a person reaches that person\'s My day, texts and morning email, kids and helpers included.';
  const FAMILY_READ = 'They reach kids\' My day only with Show to kids, and never a helper\'s.';
  const personRead = (first) => `They also reach ${first}'s My day, texts and morning email.`;
  // A failed item's error, as Settings words it: what hub-jobs stored (Google's own words already say
  // "Google said …"), without a full stop of its own. The 4th repair in a day is someone's doing.
  const problemText = (error) => {
    if (!error) return 'it couldn\'t be copied';
    if (/^Google keeps changing this event/.test(error)) return 'someone keeps changing it in Google; change it in the hub instead (to skip one day, use Skip this day)';
    return String(error).trim().replace(/[.!?]+$/, '');
  };
  // A run that stopped on something to fix (calendar_sync.last_stop): hub-jobs' fixed message (or this
  // one, if it left none), then what to do about it.
  const STOP_FIX = {
    auth: ['Google refused the key.', 'Make a new key (README, step A.4) and replace GOOGLE_SA_JSON in Supabase.'],
    config: ['The Google setup isn\'t right.', 'Fix it, then press Sync now.'],
    error: ['The last sync failed.', 'It tries again within 5 minutes; if it keeps happening, tell Claude.'],
  };
  // Test's steps (hub-jobs calendar_test), in words.
  const STEP = { list: 'Read the calendar', insert: 'Add a test event', delete: 'Delete it', restore: 'Bring it back', read: 'Read it back',
    compare: 'Same as what was written', cleanup: 'Delete it again' };
  const liveProject = (status) => !['done', 'idea', 'on-hold'].includes(status);

  // The Calendar ID from what was pasted: the ID itself, or the calendar's embed address
  // (…/calendar/embed?src=<id>&…, or the whole <iframe> Google gives), lowercased.
  function calendarId(raw) {
    let s = String(raw || '').trim();
    const m = s.match(/[?&]src=([^&"'\s<>]+)/);
    if (m) s = m[1];
    try { s = decodeURIComponent(s); } catch (e) { /* keep it as pasted */ }
    return s.trim().toLowerCase();
  }

  // An instant's date and minute of the day in the household's time zone.
  function wallOf(instant) {
    const d = new Date(instant);
    if (!instant || isNaN(d)) return null;
    const o = {};
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: (v2.household && v2.household.tz) || (v2.clock && v2.clock.tz) || 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(d).forEach((p) => { o[p.type] = p.value; });
    } catch (e) { return null; }
    return { date: `${o.year}-${o.month}-${o.day}`, min: (Number(o.hour) % 24) * 60 + Number(o.minute) };
  }
  // Minutes from an instant to the household's clock now (negative for one still to come), or null.
  // The household's clock, never the device's.
  function minutesSince(instant) {
    const c = v2.clock;
    const w = wallOf(instant);
    if (!c || !w || !isIso(c.local_date) || !/^\d{1,2}:\d{2}/.test(String(c.local_time || ''))) return null;
    const [h, m] = String(c.local_time).split(':').map(Number);
    return (G.parseDate(c.local_date) - G.parseDate(w.date)) * 1440 + h * 60 + m - w.min;
  }
  // '3 minutes ago', 'just now', or 'today at 6:30am' for anything an hour old or more.
  function agoText(instant) {
    const m = minutesSince(instant);
    if (m != null && m >= 0 && m < 1) return 'just now';
    if (m != null && m >= 1 && m < 60) return `${count(m, 'minute', 'minutes')} ago`;
    return whenLabel(instant) || 'at an unknown time';
  }
  // '3:40pm' on the household's today, else 'Wed Oct 28 at 3:40pm'.
  function atText(instant) {
    const w = wallOf(instant);
    if (!w) return '';
    return w.date === dates.today() ? fmt.time(instant) : `${fmt.day(instant)} at ${fmt.time(instant)}`;
  }
  // When a failed item is tried again: 'at 3:40pm', 'on Wed Oct 28 at 3:40pm', or 'within 5 minutes'
  // once that time has come.
  function retryText(instant) {
    const m = instant ? minutesSince(instant) : null;
    if (m == null || m >= 0) return 'within 5 minutes';
    const w = wallOf(instant);
    return w.date === dates.today() ? `at ${fmt.time(instant)}` : `on ${atText(instant)}`;
  }
  const hubName = (word) => `Hub – ${word}`;

  // Calls hub-jobs with the admin's sign-in, as status and preview do. → { data }, { waiting: true }
  // (a hub-jobs from before v1.1 answers 400 Unknown action; one that isn't deployed, 404; a database
  // without 0003, 503 no_schema: never an error), or { error } with hub-jobs' reason.
  async function hubJobs(body) {
    let res;
    try { res = await core.sb.functions.invoke('hub-jobs', { body }); } catch (err) { res = { error: err }; }
    if (!res.error) return { data: res.data && typeof res.data === 'object' ? res.data : {} };
    const r = res.error.context;
    const status = r && typeof r.status === 'number' ? r.status : 0;
    let reply = null;
    try { reply = r && typeof r.json === 'function' ? await r.json() : null; } catch (e) { /* not JSON */ }
    const said = reply && typeof reply.error === 'string' ? reply.error : '';
    if (status === 404 || (status === 400 && (!said || /unknown action/i.test(said))) || (status === 503 && reply && reply.stop === 'no_schema')) return { waiting: true };
    return { error: said || friendly(res.error) };
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* no clipboard access: the old way */ }
    try {
      const t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand('copy');
      t.remove();
      return ok;
    } catch (e) { return false; }
  }

  // What the card shows. Members read calendars and calendar_sync; admins also what went wrong and
  // what was put back (calendar_links), projects whose dates are stale, and how many events the hub
  // keeps on Google in the job's window.
  async function loadGoogle(admin) {
    const sb = core.sb;
    const [rows, sync] = await Promise.all([
      q(sb.from('calendars').select('*').order('created_at')),
      q(sb.from('calendar_sync').select('*').limit(1)),
    ]);
    const d = { rows: rows || [], sync: (sync || [])[0] || {}, problems: [], repairs: [], stale: [], copied: null };
    if (!admin) return d;
    const from = d.sync.window_from;
    const [problems, repairs, stale, copied] = await Promise.all([
      q(sb.from('calendar_links').select('calendar_id,google_calendar,title,day,error,next_try_at,failing_since')
        .eq('status', 'error').order('failing_since', { ascending: false }).limit(5)),
      q(sb.from('calendar_links').select('calendar_id,google_calendar,title,day,repaired_at,repair_kind')
        .not('repaired_at', 'is', null).order('repaired_at', { ascending: false }).limit(5)),
      q(sb.from('projects').select('id,name,status').eq('on_calendar', true).is('task_dates', null).order('name')),
      isIso(from) ? q(sb.from('calendar_links').select('status').not('synced_at', 'is', null).gte('end_day', from)) : null,
    ]);
    return Object.assign(d, {
      problems: problems || [], repairs: repairs || [], stale: (stale || []).filter((p) => liveProject(p.status)),
      copied: Array.isArray(copied) ? copied.length : null,
    });
  }

  // The calendar rows Settings lists: every active person and Family (each with its writing calendar,
  // if it has one), then anyone off the family list who still has one; Pets and House apart. And the
  // calendars it only reads: the family account's main calendar (a Family one at an account's own
  // address), then the others.
  function slotsOf(d) {
    const writer = (kind, pid) => d.rows.find((c) => c.writes && c.kind === kind && (c.person_id || null) === (pid || null)) || null;
    const person = (p) => ({ key: `person:${p.id}`, kind: 'person', person: p, word: firstName(p.name), cal: writer('person', p.id), writes: true });
    const people = v2.people();
    const reads = d.rows.filter((c) => !c.writes);
    const main = reads.find((c) => c.kind === 'family' && !/calendar\.google\.com$/.test(c.google_id)) || null;
    return {
      columns: people.filter((p) => p.active !== false).map(person)
        .concat([{ key: 'family', kind: 'family', word: SLOT.family, cal: writer('family'), writes: true }])
        .concat(people.filter((p) => p.active === false && writer('person', p.id)).map(person)),
      optional: ['pets', 'house'].map((k) => ({ key: k, kind: k, word: SLOT[k], cal: writer(k), writes: true })),
      main: { key: 'main', kind: 'family', word: MAIN_LABEL, cal: main, writes: false, main: true },
      reads: reads.filter((c) => c !== main),
    };
  }
  // Its status chip: [class, words].
  function chipOf(c) {
    if (!c) return ['none', 'Not connected'];
    if (c.status === 'ok') return c.writes && !c.copy_approved_at ? ['wait', 'Waiting: press Preview, then Start copying'] : ['ok', 'Connected'];
    if (c.status === 'no_access') return ['bad', 'Can\'t reach it'];
    if (c.status === 'error') return ['bad', 'Problem'];
    return ['new', 'Not checked yet'];
  }
  // "Jordan's calendar", "the Family calendar", for the problem and put-back lines.
  function whoseCalendar(d, calendarIdOf) {
    const c = d.rows.find((x) => x.id === calendarIdOf);
    if (!c) return 'a calendar that was disconnected';
    if (c.kind === 'person') {
      const p = v2.person(c.person_id);
      return `${p ? firstName(p.name) : c.label}'s calendar`;
    }
    return `the ${SLOT[c.kind] || c.label} calendar`;
  }

  // The card: draws itself into box, and answers its own buttons. Resolves once it has loaded.
  function googleCard(box, ctx, admin) {
    const st = { d: null, failed: false, tests: new Map(), syncNote: null };

    async function reload() {
      try {
        st.d = await loadGoogle(admin);
        st.failed = false;
      } catch (err) { st.failed = true; }
      if (!ctx.stale()) draw();
    }

    // ---------- Drawing
    function statusHTML(d) {
      const y = d.sync;
      const lines = [];
      const fix = STOP_FIX[y.last_stop];
      if (fix) {
        // hub-jobs' message (a full stop added if it has none), then the fix unless the message says it already.
        const said = String(y.last_error || fix[0]).trim().replace(/([^.!?])$/, '$1.');
        lines.push(`<p class="set-gstop" role="alert"><b>${esc(said)}</b>${said.includes(fix[1]) ? '' : ` ${esc(fix[1])}`}</p>`);
      } else if (!y.auth) {
        lines.push(admin
          ? '<p class="set-gline"><b>Not set up:</b> add the Google key to Supabase (README → Google Calendar and Hearth). Added it? Press Sync now.</p>'
          : '<p class="set-gline"><b>Not set up yet.</b> An admin adds the Google key.</p>');
      } else if (y.auth === 'oauth') lines.push('<p class="set-gline">Signed in as the family account</p>');
      else {
        const acct = y.account || 'the service account';
        lines.push(`<p class="set-gline set-gacct">Signed in as <b>${esc(acct)}</b>${admin && y.account
          ? ` <button type="button" class="btn set-btn set-copy" data-copy="${esc(y.account)}" aria-label="Copy the address ${esc(y.account)}">Copy</button>` : ''}${y.key_id
          ? ` · key …${esc(String(y.key_id).slice(-6))}` : ''}${admin ? ': share each Hub calendar with this address (Make changes and see event details)' : ''}</p>`);
      }
      const sync = [y.last_ok_at ? `Last synced ${agoText(y.last_ok_at)}` : 'Hasn\'t synced yet'];
      if (y.last_ok_at && d.copied != null) sync.push(count(d.copied, 'event', 'events'));
      lines.push(`<p class="set-gline">${esc(sync.join(' · '))}</p>`);
      const r = y.last_result && typeof y.last_result === 'object' ? y.last_result : {};
      const pausedFor = y.paused_until ? minutesSince(y.paused_until) : null;
      if (pausedFor != null && pausedFor < 0) lines.push(`<p class="set-gline">Paused by Google until ${esc(atText(y.paused_until))}</p>`);
      else {
        const hiding = num(r.hiding);
        const copying = num(r.pending) - hiding;
        if (hiding > 0) lines.push(`<p class="set-gline">Hiding ${esc(count(hiding, 'item', 'items'))} in Google…</p>`);
        if (copying > 0) lines.push(`<p class="set-gline">Copying ${esc(count(copying, 'item', 'items'))} to Google…</p>`);
      }
      const since = y.last_run_at ? minutesSince(y.last_run_at) : null;
      if (admin && since != null && since > 30) {
        lines.push('<p class="banner banner-warn set-gwarn">Last synced more than 30 minutes ago. The calendar job may not be scheduled: run supabase/cron.sql again (README).</p>');
      }
      return lines.join('');
    }

    function testHTML(t) {
      if (!t) return '';
      const steps = (t.steps || []).filter((x) => x && typeof x.step === 'string');
      return `<div class="set-gtest is-${t.cls}"><p><b>Test:</b> ${esc(t.text)}</p>${steps.length
        ? `<details class="set-gsteps"><summary>What Test did</summary><ul>${steps.map((x) => `<li class="${x.ok ? 'is-ok' : 'is-bad'}">${esc(STEP[x.step] || x.step)}: ${x.ok
          ? 'done' : `didn't work${x.http ? ` (${esc(x.http)})` : ''}`}</li>`).join('')}</ul></details>` : ''}</div>`;
    }

    // One calendar row: the label, the status chip, the name to make in Google (with Copy), the Google
    // name once read, what's wrong, the name question, the last Test, and the buttons.
    function rowHTML(s) {
      const c = s.cal;
      const [cls, chip] = chipOf(c);
      const first = s.person ? firstName(s.person.name) : '';
      const off = s.person && s.person.active === false;
      const prefix = c && (s.kind === 'pets' || s.kind === 'house') && c.label !== s.word ? ` <small>titles start "${esc(c.label)}:"</small>` : '';
      const whose = !s.writes && c && !s.main ? ` <small>${esc(c.kind === 'person' ? (v2.person(c.person_id) || {}).name || 'Someone' : SLOT[c.kind] || c.kind)}</small>` : '';
      const label = s.main ? MAIN : s.writes ? s.word : c.label;
      const ask = s.person && c && c.google_name && !c.google_name.toLowerCase().includes(first.toLowerCase())
        ? `<p class="set-gq">This calendar is called '${esc(c.google_name)}'. Is that ${esc(first)}'s?</p>` : '';
      const kids = c && c.kind === 'family' && !c.writes
        ? (admin ? `<label class="check set-gkids"><input type="checkbox" data-gkids="${esc(c.id)}"${c.for_kids ? ' checked' : ''}> Show to kids</label>`
          : c.for_kids ? '<p class="set-gmeta">Shown to kids on My day</p>' : '') : '';
      const acts = !admin ? '' : `<div class="set-gacts">
        ${s.key ? `<button type="button" class="btn set-btn${c ? '' : ' btn-primary'}" data-gset="${esc(s.key)}">Set</button>` : ''}
        ${c ? `<button type="button" class="btn set-btn" data-gtest="${esc(c.id)}">Test</button>` : ''}
        ${c && c.writes ? `<button type="button" class="btn set-btn" data-gpreview="${esc(c.id)}">Preview</button>` : ''}
        ${c ? `<button type="button" class="btn btn-danger set-btn" data-gdrop="${esc(c.id)}">Disconnect</button>` : ''}
      </div>`;
      return `<li class="set-gcal" data-slot="${esc(s.key || (c && c.id) || '')}">
        <div class="set-gcal-top">
          <span class="set-gcal-label">${s.person ? v2.ui.personDot(s.person) : ''}<b>${esc(label)}</b>${off ? ' <small>off the family list</small>' : ''}${prefix}${whose}</span>
          <span class="set-chip is-${cls}">${esc(chip)}</span>
        </div>
        ${admin && s.writes ? `<div class="set-gname"><span>Name in Google: <b>${esc(hubName(s.word))}</b></span>
          <button type="button" class="btn set-btn set-copy" data-copy="${esc(hubName(s.word))}" aria-label="Copy the name ${esc(hubName(s.word))}">Copy</button></div>` : ''}
        ${c && c.google_name ? `<p class="set-gmeta">In Google: ${esc(c.google_name)}</p>` : ''}
        ${c && c.status_detail && (c.status === 'no_access' || c.status === 'error') ? `<p class="set-gdetail">${esc(c.status_detail)}</p>` : ''}
        ${ask}${kids}${testHTML(c && st.tests.get(c.id))}${acts}
      </li>`;
    }

    function listsHTML(d) {
      if (!admin) return '';
      const out = [];
      if (d.problems.length) {
        out.push(`<h3 class="set-gh">Problems</h3><ul class="set-glist" data-ref="gproblems">${d.problems.map((l) => `<li>${esc(`${l.title || 'An item'}, ${fmt.day(l.day)}, on ${whoseCalendar(d, l.calendar_id)}: `
          + `${problemText(l.error)}. Trying again ${retryText(l.next_try_at)}.`)}</li>`).join('')}</ul>`);
      }
      if (d.repairs.length) {
        out.push(`<h3 class="set-gh">Changed in Google and put back</h3><ul class="set-glist" data-ref="grepairs">${d.repairs.map((l) => `<li>${esc(`${l.title || 'An item'}, ${fmt.day(l.day)}, ${whoseCalendar(d, l.calendar_id)}: `
          + `${l.repair_kind === 'deleted' ? 'deleted in Google' : 'changed in Google'}, put back ${atText(l.repaired_at)}.`)}</li>`).join('')}</ul>`);
      }
      if (d.stale.length) {
        out.push(`<h3 class="set-gh">Projects with stale dates</h3><ul class="set-glist" data-ref="gstale">${d.stale.map((p) => `<li><a href="#/projects/${encodeURIComponent(p.id)}">${esc(`${p.name}'s dates are out of date: open it in Projects.`)}</a></li>`).join('')}</ul>`);
      }
      const people = v2.people();
      const has = (p) => d.rows.some((c) => c.writes && c.kind === 'person' && c.person_id === p.id);
      const missing = people.filter((p) => p.active !== false && !has(p));
      const gone = people.filter((p) => p.active === false && has(p));
      if (missing.length || gone.length) {
        out.push(`<h3 class="set-gh">Not on Google</h3><div data-ref="gmissing">${missing.length
          ? `<p class="set-help">No Hub calendar, so their items aren't copied to Google or the wall: ${esc(missing.map((p) => firstName(p.name)).join(', '))}.</p>` : ''}
          ${gone.map((p) => {
            const c = d.rows.find((x) => x.writes && x.kind === 'person' && x.person_id === p.id);
            const n = firstName(p.name);
            const g = (c && c.google_name) || hubName(n);
            return `<p class="set-help set-gleft">${esc(`${n} is off the family list, so the hub copies nothing to '${g}'. If ${n} has left: in Google, stop sharing '${g}' with ${n}'s own account, then Disconnect it here.`)}</p>`;
          }).join('')}</div>`);
      }
      return out.join('');
    }

    function draw() {
      if (st.failed || !st.d) {
        box.innerHTML = '<p class="set-help">Couldn\'t load the Google Calendar settings. Reload the page to try again.</p>';
        return;
      }
      const d = st.d;
      const s = slotsOf(d);
      const note = st.syncNote;
      box.innerHTML = `
        <div class="set-gstatus" data-ref="gstatus" aria-live="polite">${statusHTML(d)}</div>
        ${admin ? `<div class="set-actions"><button type="button" class="btn set-btn" data-act="gsync">Sync now</button></div>
          ${note ? `<p class="set-gsync is-${note.cls}" data-ref="gsync" role="status">${esc(note.text)}</p>` : ''}` : ''}
        <h3 class="set-gh">Calendars</h3>
        <p class="set-help">One Google calendar per column on the wall, made in the family Gmail and shared with the hub. The hub copies each person's events and tasks to theirs.</p>
        <ul class="set-gcals" data-ref="gcolumns">${s.columns.map(rowHTML).join('')}</ul>
        <p class="set-help set-gopt">Optional: only if pet or house tasks are often left with nobody in charge</p>
        <ul class="set-gcals" data-ref="goptional">${s.optional.map(rowHTML).join('')}</ul>
        <h3 class="set-gh">Calendars to read</h3>
        <p class="set-help">${esc(READ_HELP)}</p>
        <ul class="set-gcals" data-ref="greads">${[s.main].concat(s.reads.map((c) => ({ cal: c, writes: false }))).map(rowHTML).join('')}</ul>
        ${admin ? '<div class="set-actions"><button type="button" class="btn set-btn" data-act="gadd">Add a calendar to read</button></div>' : ''}
        ${listsHTML(d)}
        <h3 class="set-gh">Hearth (the kitchen wall)</h3>
        <ul class="set-steps set-hearth">
          <li>Connect the family Gmail in the Hearth app from a parent's profile that will stay: if that profile is deleted, its calendars leave the wall. Tick the Hub calendars and give each to its person's profile. A new person needs a new Hub calendar, ticked and given to them in the Hearth app.</li>
          <li>Something missing from the wall? In the Hearth app, press <b>Resync</b>. A change in the hub reaches Google within 5 minutes (for yesterday onward); Hearth then adds its own delay.</li>
          <li>Events are view-only on the wall, and Hearth doesn't alert for them. The morning email does.</li>
          <li>Everyone in the house sees the wall, including the helper and visitors: mark Private anything about health, trips and away days, or with codes or money. Any member can change an item, and from yesterday onward the change reaches the wall within 5 minutes. Earlier days stay on Google as they were: only Private or Delete takes a past item off.</li>
          <li>Every Hub calendar has its notifications turned off in Google (Settings and sharing → Event notifications), so phones signed in to the family account don't ring for each item.</li>
        </ul>`;
    }

    // ---------- Set: a calendar for a column, or the family account's main calendar
    function slotFor(key) {
      const s = slotsOf(st.d);
      return s.columns.concat(s.optional, [s.main]).find((x) => x.key === key) || null;
    }

    function openSet(s) {
      const c = s.cal;
      const pets = s.kind === 'pets' || s.kind === 'house';
      const name = hubName(s.word);
      wireFormDialog();
      if (detailDialog.open) detailDialog.close();
      formDialog.innerHTML = `<form class="form d-inner set-gform" novalidate>
        <div class="d-top"><h3>${esc(s.main ? MAIN : name)}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
        <p class="meta">${s.main
          ? 'The family Gmail address: the family account\'s own calendar, where events typed on a phone usually land. Share it with the hub\'s address first (See event details).'
          : `In Google Calendar, open "${esc(name)}" → Settings and sharing → Integrate calendar, and copy its Calendar ID. Its embed address works too.`}</p>
        <label class="field"><span>${s.main ? 'Family Gmail address' : 'Calendar ID'}</span>
          <input type="text" name="google_id" value="${esc(c ? c.google_id : '')}" autocomplete="off" autocapitalize="none" spellcheck="false"
            placeholder="${s.main ? 'family@gmail.com' : '…@group.calendar.google.com'}"></label>
        ${pets ? `<label class="field"><span>Title prefix</span><input type="text" name="label" maxlength="40" value="${esc(c ? c.label : s.word)}">
          <small>Its items read "${esc(c ? c.label : s.word)}: Heartworm pill" on the wall.</small></label>` : ''}
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions"><button type="button" class="btn set-btn" data-close>Cancel</button><button type="submit" class="btn btn-primary set-btn">Save</button></div>
      </form>`;
      const form = formDialog.querySelector('form');
      const errBox = form.querySelector('.form-error');
      const fail = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errBox.hidden = true;
        const id = calendarId(form.elements.google_id.value);
        const label = pets ? String(form.elements.label.value || '').trim() : s.main ? MAIN_LABEL : s.word.slice(0, 40);
        if (!id) return fail(s.main ? 'Paste the family Gmail address.' : 'Paste the Calendar ID.');
        if (s.writes && !HUB_ID.test(id)) {
          return fail(ANY_ID.test(id)
            ? `That's someone's main calendar (an address like name@gmail.com). The hub copies only to a calendar made for it, whose ID ends in @group.calendar.google.com: make "${name}" in Google Calendar and paste its ID.`
            : 'That isn\'t a Calendar ID. In Google Calendar: Settings and sharing → Integrate calendar → Calendar ID. It ends in @group.calendar.google.com.');
        }
        if (!s.writes && !ANY_ID.test(id)) return fail('That isn\'t an email address or a Calendar ID. Check you copied all of it.');
        if (s.main && /calendar\.google\.com$/.test(id)) return fail('Paste the family account\'s own address (its Gmail address) here. For another calendar, use Add a calendar to read.');
        if (!label) return fail('Give it a title prefix, such as Pets or Dogs.');
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        try {
          const row = await saveCalendar(c, { google_id: id, kind: s.kind, person_id: s.person ? s.person.id : null, label, writes: s.writes, for_kids: false });
          await reload();
          if (!ctx.stale()) openCheck(row, true);
        } catch (err) {
          fail(calendarError(err));
        } finally {
          btn.disabled = false;
        }
      });
      if (!formDialog.open) formDialog.showModal();
      if (window.innerWidth > 700) form.elements.google_id.focus();
    }

    // A new calendars row (the columns admins may insert), or the changed Google ID and label of one.
    // Changing the Google ID starts it again: the database forgets what it knew, Start copying included.
    async function saveCalendar(c, row) {
      if (!c) return q(core.sb.from('calendars').insert(row).select().single());
      const patch = {};
      if (row.google_id !== c.google_id) patch.google_id = row.google_id;
      if (row.label !== c.label) patch.label = row.label;
      if (!Object.keys(patch).length) return c;
      const rows = await q(core.sb.from('calendars').update(patch).eq('id', c.id).select());
      if (!rows || !rows.length) throw new Error('This calendar was disconnected a moment ago. Reload the page to see the latest.');
      return rows[0];
    }
    function calendarError(err) {
      const msg = (err && err.message) || '';
      if (err && err.code === '23505' && /one_writer/.test(msg)) return 'That column has a calendar already (someone set it a moment ago). Reload the page to see it.';
      if (err && err.code === '23505') return 'That calendar is set up here already, on another row.';
      if (err && err.code === '23514') return 'The hub can\'t use that Calendar ID. Check you copied all of it.';
      return friendly(err);
    }

    // ---------- Add a calendar to read (a person's, or Family's, with Show to kids)
    function openAddRead() {
      const people = v2.people().filter((p) => p.active !== false);
      wireFormDialog();
      formDialog.innerHTML = `<form class="form d-inner set-gform" novalidate>
        <div class="d-top"><h3>Add a calendar to read</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
        <p class="meta">Its events show on the Calendar and Today pages and in grown-ups' morning emails. <span data-ref="whose-help">${esc(FAMILY_READ)}</span> Share it with the hub's address first (See event details).</p>
        <label class="field"><span>Calendar ID</span><input type="text" name="google_id" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="…@group.calendar.google.com"></label>
        <label class="field"><span>What to call it</span><input type="text" name="label" maxlength="40" placeholder="School calendar"></label>
        <label class="field"><span>Whose</span><select name="whose"><option value="family">Family</option>${people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label class="check set-gkids" data-ref="kids"><input type="checkbox" name="for_kids"> Show to kids</label>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions"><button type="button" class="btn set-btn" data-close>Cancel</button><button type="submit" class="btn btn-primary set-btn">Add</button></div>
      </form>`;
      const form = formDialog.querySelector('form');
      const el = form.elements;
      const errBox = form.querySelector('.form-error');
      const fail = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
      const kids = form.querySelector('[data-ref="kids"]');
      const whoseHelp = form.querySelector('[data-ref="whose-help"]');
      const showKids = () => {
        kids.hidden = el.whose.value !== 'family';
        el.for_kids.disabled = kids.hidden;
        const p = kids.hidden && people.find((x) => x.id === el.whose.value);
        whoseHelp.textContent = p ? personRead(firstName(p.name)) : FAMILY_READ;
      };
      showKids();
      el.whose.addEventListener('change', showKids);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errBox.hidden = true;
        const id = calendarId(el.google_id.value);
        const label = String(el.label.value || '').trim();
        if (!id) return fail('Paste the Calendar ID.');
        if (!ANY_ID.test(id)) return fail('That isn\'t a Calendar ID. In Google Calendar: Settings and sharing → Integrate calendar → Calendar ID.');
        if (!label) return fail('Give it a name, such as School calendar.');
        const family = el.whose.value === 'family';
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        try {
          const row = await saveCalendar(null, { google_id: id, kind: family ? 'family' : 'person', person_id: family ? null : el.whose.value,
            label, writes: false, for_kids: family && el.for_kids.checked });
          await reload();
          if (!ctx.stale()) openCheck(row, true);
        } catch (err) {
          fail(calendarError(err));
        } finally {
          btn.disabled = false;
        }
      });
      if (!formDialog.open) formDialog.showModal();
    }

    // ---------- Test, then (a calendar the hub writes) everything Start copying would put on it (the
    // job's whole window: yesterday to 60 days ahead), with Make private on each event or task, and
    // Start copying.
    async function runTest(c) {
      const r = await hubJobs({ action: 'calendar_test', calendar_id: c.id });
      let t;
      if (r.waiting) t = { cls: 'wait', text: WAITING };
      else if (r.error) t = { cls: 'bad', text: `It couldn't run: ${r.error}` };
      else {
        const ok = r.data.ok === true;
        t = { cls: ok ? 'ok' : 'bad', text: typeof r.data.message === 'string' && r.data.message ? r.data.message : ok ? 'It worked.' : 'It didn\'t work.',
          steps: Array.isArray(r.data.steps) ? r.data.steps : [], name: typeof r.data.name === 'string' && r.data.name.trim() ? r.data.name.trim() : null };
      }
      st.tests.set(c.id, t);
      return t;
    }

    function previewHTML(rows) {
      if (!rows.length) return '<li class="set-pv-none">Nothing to copy from yesterday to 60 days ahead.</li>';
      let last = '';
      return rows.map((r) => {
        const day = r.day !== last ? `<li class="set-pv-day">${esc(fmt.day(r.day))}</li>` : '';
        last = r.day;
        const canHide = !r.private && (r.item_kind === 'event' || r.item_kind === 'task') && r.item_id;
        const meta = [r.place, r.details].filter((x) => typeof x === 'string' && x.trim()).join(' · ');
        // What can't be made private here, and where it can be kept off instead.
        const hint = r.private ? '' : r.item_kind === 'project' ? 'To keep a project\'s jobs off the wall, untick "Show in Home Hub calendar" on the project.'
          : r.item_kind === 'late' ? 'To hide a task on this line, make the task private on the Tasks page.' : '';
        return `${day}<li class="set-pv-row"><span class="set-pv-what"><span class="set-pv-title">${esc(r.title)}</span>${meta ? `<small class="set-pv-meta">${esc(meta)}</small>` : ''}${hint
          ? `<small class="set-pv-hint">${esc(hint)}</small>` : ''}</span>${r.private ? '<span class="badge">Private</span>' : ''}${canHide
          ? `<button type="button" class="btn set-btn" data-gprivate="${esc(r.item_kind)}|${esc(r.item_id)}" aria-label="Make private: ${esc(r.title)}">Make private</button>` : ''}</li>`;
      }).join('');
    }

    function openCheck(c, test) {
      const s = slotsOf(st.d);
      const slot = s.columns.concat(s.optional).find((x) => x.cal && x.cal.id === c.id);
      const title = slot ? hubName(slot.word) : s.main.cal && s.main.cal.id === c.id ? MAIN : c.label;
      const approve = c.writes && !c.copy_approved_at;
      const first = slot && slot.person ? firstName(slot.person.name) : '';
      // Start copying is the main button only once Home Hub can reach the calendar (the Test passed, or
      // the row is ok) and its Google name doesn't ask whose it is.
      let ready = !test && c.status === 'ok';
      let ask = null;
      wireFormDialog();
      if (detailDialog.open) detailDialog.close();
      formDialog.innerHTML = `<div class="form d-inner set-gcheck">
        <div class="d-top"><h3>${esc(title)}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
        <p class="meta set-gid">${esc(c.google_id)}</p>
        <div data-ref="test" aria-live="polite">${test ? '<p class="set-gline">Testing…</p>' : ''}</div>
        ${c.writes ? `<section class="set-gpv" aria-labelledby="gpvTitle">
          <h4 id="gpvTitle">What it copies: yesterday to 60 days ahead</h4>
          <p class="set-help">Everyone in the house sees the wall. This is everything Start copying puts on it (later days follow as they come). Press Make private on anything that shouldn't be on it: health, trips and away days, anything with a code or money.${c.copy_approved_at ? ' Copying is on.' : ''}</p>
          <p class="set-help set-pv-note">Make private changes the item itself, on every day it repeats: kids and helpers then see only "Private item" for it on My day, in texts and in emails, even when it is their own.</p>
          <ul class="set-pv" data-ref="pv"><li class="set-pv-none">Loading…</li></ul>
        </section>` : ''}
        <div data-ref="ask"></div>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions">
          <button type="button" class="btn set-btn" data-close>${approve ? 'Not now' : 'Done'}</button>
          ${approve ? '<button type="button" class="btn set-btn" data-gstart>Start copying</button>' : ''}
        </div>
      </div>`;
      const dlg = formDialog.querySelector('.set-gcheck');
      const errBox = dlg.querySelector('.form-error');
      const fail = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
      const pv = dlg.querySelector('[data-ref="pv"]');
      const here = () => formDialog.open && formDialog.contains(dlg);
      const paint = () => {
        const btn = dlg.querySelector('[data-gstart]');
        if (btn) btn.classList.toggle('btn-primary', ready && !ask);
        dlg.querySelector('[data-ref="ask"]').innerHTML = ask ? `<p class="set-gq">${esc(ask)}</p>` : '';
      };
      paint();
      async function loadPreview() {
        if (!pv) return;
        try {
          const rows = await v2.call('calendar_preview', { p_calendar: c.id });
          if (here()) pv.innerHTML = previewHTML(Array.isArray(rows) ? rows : []);
        } catch (err) {
          if (here()) pv.innerHTML = `<li class="set-pv-none">Couldn't load what it copies: ${esc(friendly(err))}</li>`;
        }
      }
      if (test) {
        runTest(c).then((t) => {
          if (here()) {
            // What Google calls the calendar, here in the dialog: a pasted ID of the wrong person's calendar shows now.
            dlg.querySelector('[data-ref="test"]').innerHTML = testHTML(t) + (t.name ? `<p class="set-gmeta">In Google: ${esc(t.name)}</p>` : '');
            ready = t.cls === 'ok';
            ask = first && t.name && !t.name.toLowerCase().includes(first.toLowerCase())
              ? `This calendar is called '${t.name}'. Is that ${first}'s? If not, press Not now and Set the right Calendar ID.` : null;
            paint();
          }
          reload();
        });
      }
      loadPreview();
      dlg.addEventListener('click', async (e) => {
        const priv = e.target.closest('[data-gprivate]');
        if (priv) {
          const [kind, id] = priv.dataset.gprivate.split('|');
          priv.disabled = true;
          errBox.hidden = true;
          try {
            const rows = await q(core.sb.from(kind === 'event' ? 'events' : 'tasks').update({ private: true }).eq('id', id).select('id'));
            if (!rows || !rows.length) throw new Error('That item was deleted a moment ago.');
            await loadPreview();
          } catch (err) {
            priv.disabled = false;
            fail(friendly(err));
          }
          return;
        }
        const start = e.target.closest('[data-gstart]');
        if (start) {
          start.disabled = true;
          errBox.hidden = true;
          try {
            const rows = await q(core.sb.from('calendars').update({ copy_approved_at: new Date().toISOString() }).eq('id', c.id).select('id'));
            if (!rows || !rows.length) throw new Error('This calendar was disconnected a moment ago. Reload the page to see the latest.');
            formDialog.close();
            toast(ready ? `Copying to ${title} starts within 5 minutes`
              : `Approved: copying to ${title} starts once Home Hub can reach it (see its row)`);
            reload();
          } catch (err) {
            start.disabled = false;
            fail(friendly(err));
          }
        }
      });
      if (!formDialog.open) formDialog.showModal();
    }

    // ---------- The card's buttons
    async function onClick(e) {
      const t = e.target;
      const copy = t.closest('[data-copy]');
      if (copy) {
        const ok = await copyText(copy.dataset.copy);
        toast(ok ? `Copied: ${copy.dataset.copy}` : `Couldn't copy. Select "${copy.dataset.copy}" and copy it by hand.`, ok ? {} : { error: true });
        return;
      }
      const set = t.closest('[data-gset]');
      if (set) { const s = slotFor(set.dataset.gset); if (s) openSet(s); return; }
      const cal = (attr) => {
        const b = t.closest(`[data-${attr}]`);
        return b ? [b, st.d.rows.find((x) => x.id === b.dataset[attr.replace(/-./g, (m) => m[1].toUpperCase())]) || null] : [null, null];
      };
      const [testBtn, testCal] = cal('gtest');
      if (testBtn) {
        if (!testCal) return;
        testBtn.disabled = true;
        testBtn.textContent = 'Testing…';
        await runTest(testCal);
        if (!ctx.stale()) await reload();
        return;
      }
      const [pvBtn, pvCal] = cal('gpreview');
      if (pvBtn) { if (pvCal) openCheck(pvCal, false); return; }
      const [dropBtn, dropCal] = cal('gdrop');
      if (dropBtn) {
        if (!dropCal) return;
        const s = slotsOf(st.d);
        const slot = s.columns.concat(s.optional).find((x) => x.cal === dropCal);
        const name = slot ? hubName(slot.word) : dropCal === s.main.cal ? MAIN : dropCal.label;
        const ask = !dropCal.writes ? `Disconnect ${name}? Its events stop showing in the hub.`
          : dropCal.status === 'no_access'
            ? `Disconnect ${name}? Home Hub can't reach that calendar now, so the events it put there stay on it, and on the wall. To take them off, delete that calendar in Google Calendar (or share it with the hub again, wait for it to connect, and then Disconnect).`
            : `Disconnect ${name}? The hub's events are taken off that calendar within a few minutes.`;
        if (!window.confirm(ask)) return;
        dropBtn.disabled = true;
        try {
          await q(core.sb.from('calendars').delete().eq('id', dropCal.id));
          st.tests.delete(dropCal.id);
          toast(`Disconnected ${name}`);
        } catch (err) {
          toast(friendly(err), { error: true });
        }
        if (!ctx.stale()) await reload();
        return;
      }
      const act = t.closest('[data-act]');
      if (act && act.dataset.act === 'gadd') openAddRead();
      if (act && act.dataset.act === 'gsync') syncNow(act);
    }

    // Sync now: one run of the calendar job, which also reads every calendar. What it did shows under
    // the button; what it recorded shows in the card as it reloads.
    async function syncNow(btn) {
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      const r = await hubJobs({ action: 'calendar' });
      if (ctx.stale()) return;
      st.syncNote = r.waiting ? { cls: 'wait', text: WAITING } : r.error ? { cls: 'bad', text: r.error } : syncText(r.data);
      await reload();
    }
    function syncText(x) {
      const stop = x.stop;
      if (stop === 'busy') return { cls: 'wait', text: 'A sync is running already. Try again in a minute.' };
      if (stop === 'paused' || stop === 'slow_down') return { cls: 'wait', text: 'Google asked the hub to slow down, so it waits a little. It carries on by itself.' };
      if (stop === 'not_set_up') return { cls: 'bad', text: 'Not set up: add the Google key to Supabase (README → Google Calendar and Hearth), then press Sync now.' };
      if (stop && stop !== 'time') return { cls: 'bad', text: (typeof x.error === 'string' && x.error) || 'The sync didn\'t finish.' };
      const done = [[x.inserted, 'added'], [x.updated, 'changed'], [x.deleted, 'taken off']].filter(([n]) => num(n) > 0).map(([n, w]) => `${num(n)} ${w}`);
      let text = done.length ? `Synced: ${done.join(', ')} in Google.` : 'Synced: nothing to change in Google.';
      if (num(x.read)) text += ` ${count(num(x.read), 'calendar', 'calendars')} read.`;
      if (num(x.failed)) text += ` ${count(num(x.failed), 'item', 'items')} couldn't be copied (see Problems).`;
      if (stop === 'time') text += ' The rest goes in the next run, within 5 minutes.';
      return { cls: num(x.failed) ? 'bad' : 'ok', text };
    }

    // Show to kids, on a Family calendar the hub only reads.
    async function onChange(e) {
      const box2 = e.target.closest('[data-gkids]');
      if (!box2) return;
      const on = box2.checked;
      box2.disabled = true;
      try {
        const rows = await q(core.sb.from('calendars').update({ for_kids: on }).eq('id', box2.dataset.gkids).select('id'));
        if (!rows || !rows.length) throw new Error('This calendar was disconnected a moment ago. Reload the page to see the latest.');
        toast(on ? 'Kids now see its events on My day' : 'Kids no longer see its events on My day');
      } catch (err) {
        box2.checked = !on;
        toast(friendly(err), { error: true });
      }
      if (!ctx.stale()) await reload();
    }

    box.addEventListener('click', onClick, { signal: ctx.signal });
    box.addEventListener('change', onChange, { signal: ctx.signal });
    return reload();
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
