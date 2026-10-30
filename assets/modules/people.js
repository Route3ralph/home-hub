/* =====================================================================
   HOME HUB — Family (v2)
   The household's people in one list: their colour, role, email (with an
   "Unconfirmed" badge until the address is confirmed), phone, morning
   email, and whether they can sign in (a members row for their email).
   Admins add, change and remove people: save_person and remove_person keep
   the sign-in list in step, so this page never writes members itself.
   Everyone can copy or send a person their My day link (day.html?t=…);
   admins can also replace it (rotate_day_token). Parents and adults can
   sign in; kids and helpers get a My day link instead. Replaces the v1
   Family page (old #/family links open this one).
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { esc, api, toast, friendly, firstName, telHref, smsHref, whatsappHref, canShare, shareText, formDialog, detailDialog, wireFormDialog } = core;
  const { v2 } = core;
  const { call, fmt, ui } = v2;

  const ROLES = [
    { key: 'parent', label: 'Parent', help: 'Runs the house. Can sign in as an admin, who manages Family and Settings.' },
    { key: 'adult', label: 'Adult', help: 'A grown-up who helps out. Can sign in, but can\'t change Family or Settings.' },
    { key: 'kid', label: 'Kid', help: 'Doesn\'t sign in. Gets a My day link with their own day.' },
    { key: 'helper', label: 'Helper', help: 'A nanny, sitter, cleaner or dog walker. Doesn\'t sign in; gets a My day link.' },
  ];
  const ROLE = Object.fromEntries(ROLES.map((r) => [r.key, r]));
  // The colours the migration gives the first people, in the same order.
  const PALETTE = [
    ['#9333ea', 'Purple'], ['#2563eb', 'Blue'], ['#0891b2', 'Teal'], ['#16a34a', 'Green'], ['#ca8a04', 'Mustard'],
    ['#ea580c', 'Orange'], ['#db2777', 'Pink'], ['#b91c1c', 'Red'], ['#92622f', 'Brown'], ['#64748b', 'Slate'],
  ];
  const COLOR = /^#[0-9a-fA-F]{6}$/;
  const EVENING = '19:00'; // an evening preview's usual time
  const ICON = Object.freeze({
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4 7l8 6 8-6"/></svg>',
  });

  // The page on screen: { reload() }, or null while another page shows.
  let page = null;

  // ============================================
  // HELPERS
  // ============================================
  const isAdmin = () => !!(core.me && core.me.role === 'admin');
  const myEmail = () => String((core.me && core.me.email) || '').toLowerCase();
  const isMe = (p) => !!p && ((!!v2.mePerson && v2.mePerson.id === p.id) || (!!p.email && p.email === myEmail()));
  const canLogin = (role) => role === 'parent' || role === 'adult';
  const peopleCount = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
  // Text and WhatsApp need a full number.
  const textable = (phone) => String(phone || '').replace(/\D/g, '').length >= 10;
  const hhmm = (t) => String(t || '').slice(0, 5);
  // The household's usual morning-email time, 'HH:MM'.
  const householdTime = () => hhmm((v2.household && v2.household.digest_time) || '06:30');

  // Their members row (they can sign in), false when there is none, null when the list couldn't be read.
  function loginOf(p, members) {
    if (!members) return null;
    return (p.email && members.find((m) => String(m.email || '').toLowerCase() === p.email)) || false;
  }

  // The My day page for a person: no sign-in, their today and tomorrow. tokens holds links made since
  // the people were last read (New link), so Copy and Send never hand out the old one.
  const dayLink = (p, tokens) => new URL(`day.html?t=${encodeURIComponent((tokens && tokens.get(p.id)) || p.day_token)}`, location.href).href;

  // What the WhatsApp or text message says, in their language.
  function dayMessage(p, link) {
    const name = firstName(p.name);
    return p.language === 'es'
      ? `Hola ${name}: este es tu día en Home Hub. Tócalo para ver qué hay hoy y mañana:\n${link}\n\nAñádelo a tu pantalla de inicio para tenerlo siempre a mano.`
      : `Hi ${name}, here's your Home Hub day. Tap to see what's on today and tomorrow:\n${link}\n\nAdd it to your Home Screen to keep it one tap away.`;
  }

  // 'Morning email at 6:30am · today's plan', plus why nothing is sent yet, if that's so. login: their
  // members row (signing in confirms the address too), or false / null.
  function digestSummary(p, login) {
    if (!p.digest_enabled) return { text: 'Morning email off', warn: '' };
    const evening = p.digest_day === 'tomorrow';
    const parts = [`${evening ? 'Evening email' : 'Morning email'} at ${fmt.time(hhmm(p.digest_time) || householdTime())}`,
      evening ? 'tomorrow\'s plan' : 'today\'s plan'];
    if (p.digest_scope === 'everyone') parts.push('everyone\'s day');
    let warn = '';
    if (!p.email) warn = 'No email address yet, so nothing is sent.';
    else if (!p.email_verified_at) {
      warn = `Waiting for them to confirm their email. The first email asks them to${login && canLogin(p.role) ? '; signing in to the Home Hub also counts' : ''}.`;
    }
    return { text: parts.join(' · '), warn };
  }

  // The first palette colour nobody on the list has yet.
  function freeColor() {
    const used = new Set(v2.people().filter((p) => p.active !== false).map((p) => String(p.color || '').toLowerCase()));
    return (PALETTE.find(([c]) => !used.has(c)) || PALETTE[0])[0];
  }
  const nextSortOrder = () => v2.people().reduce((n, p) => Math.max(n, Number(p.sort_order) || 0), 0) + 1;

  // ============================================
  // THE PAGE
  // ============================================
  async function renderPeople(main, ctx) {
    const admin = isAdmin();
    const view = { members: null, refreshFailed: false, tokens: new Map() };

    // The family list fresh from the database (another admin may have changed it since sign-in), and
    // the sign-in list for "Can sign in". A failure keeps what the hub already has, with a note.
    async function fetchAll() {
      const [, members] = await Promise.all([
        // Once the people are read again, their tokens are the latest: links made here are in them.
        v2.refresh().then(() => { view.refreshFailed = false; view.tokens.clear(); }, () => { view.refreshFailed = true; }),
        api.members().then((rows) => rows || [], () => null),
      ]);
      view.members = members;
    }

    await fetchAll();
    if (ctx.stale()) return;

    main.innerHTML = `
      <div class="page-head ppl-head">
        <div><h1>Family</h1><p class="meta" data-ref="meta"></p></div>
        ${admin ? `<div class="page-actions"><button type="button" class="btn btn-primary ppl-add" data-act="add">${ui.icon.plus}Add person</button></div>` : ''}
      </div>
      <p class="ppl-intro">Parents and adults can sign in with their email. Kids and helpers don't sign in: send them their My day link instead.</p>
      <div data-ref="banner"></div>
      <div data-ref="list"></div>
      <div data-ref="foot"></div>`;
    const ref = (name) => main.querySelector(`[data-ref="${name}"]`);

    function draw() {
      const people = v2.people();
      const active = people.filter((p) => p.active !== false);
      const inactive = people.filter((p) => p.active === false);
      ref('meta').textContent = `${peopleCount(active.length)} · ${admin ? 'you can add, change and remove people' : 'only admins (parents who sign in) can change the list'}`;
      ref('banner').innerHTML = view.refreshFailed
        ? '<div class="banner banner-warn">Couldn\'t load the latest family list, so this is the one from when you signed in. Reload the page to try again.</div>'
        : '';
      const grid = (rows) => `<div class="grid ppl-grid">${rows.map((p) => cardHTML(p, admin, view)).join('')}</div>`;
      let html = active.length
        ? grid(active)
        : `<div class="card empty-state ppl-empty"><p>Nobody on the family list yet.</p>${admin ? '<button type="button" class="btn btn-primary ppl-btn" data-act="add">Add the first person</button>' : ''}</div>`;
      if (inactive.length) html += `<section class="ppl-sec" aria-label="Not active">${ui.sectionHeading('Not active', inactive.length)}${grid(inactive)}</section>`;
      ref('list').innerHTML = html;

      const notes = [];
      if (!view.members) notes.push('Couldn\'t check who can sign in just now. Reload the page to try again.');
      else if (admin) {
        // Sign-ins with no person row (from before v2, say): adding a person with that email manages it.
        const strays = view.members.filter((m) => !people.some((p) => p.email && p.email === String(m.email || '').toLowerCase()));
        if (strays.length) notes.push(`Can sign in, but isn't on the family list: ${strays.map((m) => m.email).join(', ')}. Add them as a person with the same email to manage their sign-in.`);
      }
      ref('foot').innerHTML = notes.map((n) => `<p class="meta ppl-note">${esc(n)}</p>`).join('');
    }

    async function reload() {
      try {
        await fetchAll();
      } catch (err) {
        if (!ctx.stale()) toast(friendly(err), { error: true });
        return;
      }
      if (!ctx.stale()) draw();
    }

    draw();

    main.addEventListener('click', (e) => {
      const byId = (id) => v2.people().find((p) => p.id === id);
      if (e.target.closest('[data-act="add"]')) { personForm(null, reload); return; }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const p = byId(edit.dataset.edit);
        if (p) personForm(p, reload);
        return;
      }
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        const p = byId(copy.dataset.copy);
        if (p) copyLink(p, view.tokens);
        return;
      }
      const share = e.target.closest('[data-share]');
      if (share) { shareText(share.dataset.share); return; }
      const rotate = e.target.closest('[data-rotate]');
      if (rotate) {
        const p = byId(rotate.dataset.rotate);
        if (p) newLink(p, view.tokens, rotate, () => { if (!ctx.stale()) draw(); });
      }
    }, { signal: ctx.signal });

    page = { reload };
    ctx.signal.addEventListener('abort', () => { if (page && page.reload === reload) page = null; });
  }

  // One person's card: who, how to reach them, their morning email, and their My day link.
  function cardHTML(p, admin, view) {
    const you = isMe(p);
    const login = loginOf(p, view.members);
    const role = ROLE[p.role] || { label: p.role };
    const digest = digestSummary(p, login);
    // A parent or adult without a sign-in (login false: the sign-in list was read and they aren't on it).
    const cantSignIn = login === false && canLogin(p.role) && p.active !== false;
    const tags = [
      `<span class="pill ppl-role r-${esc(p.role)}">${esc(role.label)}</span>`,
      login ? `<span class="pill ppl-signin">Can sign in${login.role === 'admin' ? ' · admin' : ''}</span>` : '',
      cantSignIn ? `<span class="pill ppl-cant">Can't sign in yet${admin ? ' (Edit to turn on)' : ''}</span>` : '',
      p.language === 'es' ? '<span class="pill">Español</span>' : '',
      p.active === false ? '<span class="pill ppl-off">Not active</span>' : '',
    ].join('');
    const lines = [];
    if (p.email) {
      // "Unconfirmed" matters only while their email is on (the line under it says what it waits for).
      lines.push(`<div class="ppl-line"><a class="ppl-link" href="mailto:${esc(p.email)}" data-via="email" aria-label="Email ${esc(p.name)}, ${esc(p.email)}">${ICON.mail}<span>${esc(p.email)}</span></a>${
        p.email_verified_at || !p.digest_enabled ? '' : '<span class="badge ppl-unconfirmed" title="Not confirmed yet: their email waits until it is">Unconfirmed</span>'}</div>`);
    }
    if (p.phone) {
      lines.push(`<a class="ppl-link" href="${esc(telHref(p.phone))}" data-via="call" aria-label="Call ${esc(p.name)}, ${esc(p.phone)}">${ui.icon.phone}<span>${esc(p.phone)}</span></a>`);
    }
    return `<article class="ccard ppl-card${p.active === false ? ' is-inactive' : ''}" data-id="${esc(p.id)}" aria-label="${esc(p.name)}">
      <div class="ppl-top">
        <span class="ppl-avatar">${ui.personDot(p)}</span>
        <div class="ppl-title"><h3>${esc(p.name)}${you ? ' <span class="ppl-you">(you)</span>' : ''}</h3><div class="ppl-tags">${tags}</div></div>
        ${admin ? `<button type="button" class="btn ppl-btn ppl-edit" data-edit="${esc(p.id)}" aria-label="Edit ${esc(p.name)}">Edit</button>` : ''}
      </div>
      ${lines.length ? `<div class="ppl-lines">${lines.join('')}</div>` : ''}
      <p class="ppl-digest${p.digest_enabled ? ' is-on' : ''}">${esc(digest.text)}</p>
      ${digest.warn ? `<p class="ppl-warn">${esc(digest.warn)}</p>` : ''}
      ${p.active === false ? '' : dayLinkHTML(p, admin, view)}
    </article>`;
  }

  // Copy, WhatsApp, Share (where the browser has it) and Text (the core's message helpers), and New
  // link for admins. Share carries the WhatsApp message itself.
  function dayLinkHTML(p, admin, view) {
    const name = firstName(p.name);
    const msg = dayMessage(p, dayLink(p, view.tokens));
    const send = textable(p.phone);
    return `<div class="ppl-day" role="group" aria-label="${esc(name)}'s My day link">
      <span class="ppl-day-label">My day link</span>
      <div class="ppl-day-actions">
        <button type="button" class="btn ppl-btn" data-copy="${esc(p.id)}" aria-label="Copy ${esc(name)}'s My day link">Copy</button>
        ${send ? `<a class="btn ppl-btn" data-via="whatsapp" href="${esc(whatsappHref(p.phone, msg))}" target="_blank" rel="noopener" aria-label="Send ${esc(name)} their My day link by WhatsApp">WhatsApp</a>
        ${canShare() ? `<button type="button" class="btn ppl-btn" data-share="${esc(msg)}" aria-label="Share ${esc(name)}'s My day link with another app">Share</button>` : ''}
        <a class="btn ppl-btn" data-via="sms" href="${esc(smsHref(p.phone, msg))}" aria-label="Send ${esc(name)} their My day link by text">Text</a>` : ''}
        ${admin ? `<button type="button" class="btn ppl-btn" data-rotate="${esc(p.id)}" aria-label="Make a new My day link for ${esc(name)}">New link</button>` : ''}
      </div>
      ${send ? '' : '<small class="ppl-day-hint">Add a phone number to send it by WhatsApp or text.</small>'}
    </div>`;
  }

  // ============================================
  // MY DAY LINK
  // ============================================
  async function copyLink(p, tokens) {
    const link = dayLink(p, tokens);
    try {
      await navigator.clipboard.writeText(link);
      toast(`Copied ${firstName(p.name)}'s My day link`);
    } catch (err) {
      // No clipboard (an older phone, or permission refused): show it to copy by hand.
      window.prompt(`Copy ${firstName(p.name)}'s My day link:`, link);
    }
  }

  // A new token: the old link stops working at once (also on their Home Screen), so ask first.
  async function newLink(p, tokens, btn, redraw) {
    const name = firstName(p.name);
    if (!window.confirm(`Make a new My day link for ${p.name}? The old link stops working right away, also on their Home Screen, so send ${name} the new one.`)) return;
    btn.disabled = true;
    try {
      const token = await call('rotate_day_token', { p_person: p.id });
      if (typeof token === 'string' && token) tokens.set(p.id, token);
    } catch (err) {
      btn.disabled = false;
      toast(friendly(err), { error: true });
      return;
    }
    // The people are read again for the new token; until then (or if that fails) tokens has it.
    try { await v2.refresh(); tokens.delete(p.id); } catch (err) { /* tokens keeps the new link */ }
    toast(`New link made. Send it to ${name}.`);
    redraw();
  }

  // ============================================
  // THE FORM (add / edit; admins)
  // personForm(person, after): person = a people row to edit, or null to add one; after() runs once
  // something was saved or removed. The sign-in list is read fresh, so "Can sign in" starts out right.
  // ============================================
  function personForm(person, after) {
    return openPersonForm(person, after).catch((err) => toast(friendly(err), { error: true }));
  }

  async function openPersonForm(person, after) {
    const editing = !!(person && person.id);
    const members = await api.members();
    const p = editing ? (v2.person(person.id) || person) : {};
    const you = editing && isMe(p);
    const hadLogin = editing && !!loginOf(p, members || []);
    const role0 = ROLE[p.role] ? p.role : 'adult';
    const color0 = COLOR.test(p.color || '') ? p.color.toLowerCase() : freeColor();
    const digest0 = p.digest_enabled ? (p.digest_day === 'tomorrow' ? 'tomorrow' : 'today') : 'off';
    const time0 = hhmm(p.digest_time) || (p.digest_day === 'tomorrow' ? EVENING : householdTime());
    const colors = PALETTE.some(([c]) => c === color0) ? PALETTE : [[color0, 'Their colour now'], ...PALETTE];
    const after1 = typeof after === 'function' ? after : () => { if (page) page.reload(); };
    const lock = you ? ' disabled' : '';

    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = `<form class="form d-inner ppl-form" novalidate>
      <div class="d-top"><h3>${editing ? `Edit ${esc(p.name)}` : 'Add a person'}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      ${you ? '<p class="meta ppl-form-note">This is you. Another admin can change your role, email or sign-in.</p>' : ''}
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(p.name || '')}" maxlength="100" autocomplete="off" required></label>
      <fieldset class="ppl-fs"><legend>Role</legend>
        <div class="ppl-roles">${ROLES.map((r) => `<label class="ppl-choice"><input type="radio" name="role" value="${r.key}"${r.key === role0 ? ' checked' : ''}${you && r.key !== role0 ? ' disabled' : ''}>
          <span><b>${esc(r.label)}</b><small>${esc(r.help)}</small></span></label>`).join('')}</div>
      </fieldset>
      <label class="field"><span>Email</span><input type="email" name="email" value="${esc(p.email || '')}" maxlength="200" autocomplete="off" spellcheck="false"${you ? ' readonly' : ''}>
        <small>For signing in and the daily email.</small></label>
      <label class="check ppl-check" data-ref="signin"><input type="checkbox" name="can_sign_in"${hadLogin ? ' checked' : ''}${lock}>
        <span>Can sign in <small>With a code emailed to them. Parents can change Family and Settings; adults can see and add everything else.</small></span></label>
      <p class="ppl-nosignin" data-ref="inactiveNote" hidden>Someone who isn't active can't sign in. Tick Active again to let them.</p>
      <p class="ppl-nosignin" data-ref="nosignin">Kids and helpers don't sign in. Send them their My day link instead (on their card).</p>
      <label class="field"><span>Phone</span><input type="tel" name="phone" value="${esc(p.phone || '')}" maxlength="40" autocomplete="off" placeholder="(201) 555-0100">
        <small>To send their My day link by WhatsApp or text.</small></label>
      <fieldset class="ppl-fs"><legend>Colour</legend>
        <div class="ppl-swatches">${colors.map(([c, label]) => `<label class="ppl-swatch" style="--sw:${esc(c)}" title="${esc(label)}"><input type="radio" name="color" value="${esc(c)}"${c === color0 ? ' checked' : ''}><span class="ppl-sw" aria-hidden="true"></span><span class="sr-only">${esc(label)}</span></label>`).join('')}</div>
      </fieldset>
      <label class="field"><span>Language</span><select name="language"><option value="en"${p.language === 'es' ? '' : ' selected'}>English</option><option value="es"${p.language === 'es' ? ' selected' : ''}>Español</option></select>
        <small>For their morning email and My day page.</small></label>
      <fieldset class="ppl-fs"><legend>Daily email</legend>
        <div class="ppl-seg">${[['off', 'Off'], ['today', 'Morning: today\'s plan'], ['tomorrow', 'Evening: tomorrow\'s plan']].map(([v, l]) =>
          `<label><input type="radio" name="digest" value="${v}"${v === digest0 ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
        <div class="ppl-digest-more" data-ref="digestMore">
          <label class="field ppl-time"><span>Time</span><input type="time" name="digest_time" value="${esc(time0)}"><small data-ref="timeHelp"></small></label>
          <label class="check ppl-check" data-ref="everyone"><input type="checkbox" name="everyone"${p.digest_scope === 'everyone' ? ' checked' : ''}>
            <span>Everyone's day, not just theirs <small>Parents only.</small></span></label>
        </div>
        <small class="ppl-help">A new address gets one email asking to confirm it before anything else is sent.</small>
      </fieldset>
      ${editing ? `<label class="check ppl-check"><input type="checkbox" name="active"${p.active === false ? '' : ' checked'}${lock}>
        <span>Active <small>Untick to take them off the lists, the morning email and My day for now, without removing them.</small></span></label>` : ''}
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions">
        ${editing && !you ? '<button type="button" class="btn btn-danger left" data-act="remove">Remove</button>' : ''}
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Add'}</button>
      </div>
    </form>`;

    const form = formDialog.querySelector('form');
    const el = form.elements;
    const ref = (name) => form.querySelector(`[data-ref="${name}"]`);
    const errBox = form.querySelector('.form-error');
    const submit = form.querySelector('[type="submit"]');
    const showError = (msg) => { errBox.textContent = msg; errBox.hidden = false; };
    const checked = (name) => (form.querySelector(`input[name="${name}"]:checked`) || {}).value;

    // What shows follows the role, Active and the email choice. Hidden choices are kept (switching
    // back brings them back) but not saved. Someone not active can't sign in: the box is unticked and
    // greyed out until Active is ticked again, when it gets its earlier state back.
    let digestWas = digest0;
    let offWas = !!el.active && !el.active.checked;
    let signInBeforeOff = el.can_sign_in.checked;
    if (offWas) el.can_sign_in.checked = false;
    function apply() {
      const role = checked('role');
      const digest = checked('digest') || 'off';
      const off = !!el.active && !el.active.checked;
      if (off && !offWas) { signInBeforeOff = el.can_sign_in.checked; el.can_sign_in.checked = false; }
      if (!off && offWas) el.can_sign_in.checked = signInBeforeOff;
      offWas = off;
      el.can_sign_in.disabled = you || off;
      ref('inactiveNote').hidden = !off || !canLogin(role);
      // The usual times follow the choice, unless someone picked their own.
      if (digest !== digestWas) {
        const t = el.digest_time.value;
        if (digest === 'tomorrow' && (!t || t === householdTime())) el.digest_time.value = EVENING;
        if (digest === 'today' && (!t || t === EVENING)) el.digest_time.value = householdTime();
        digestWas = digest;
      }
      ref('signin').hidden = !canLogin(role);
      ref('nosignin').hidden = canLogin(role);
      ref('digestMore').hidden = digest === 'off';
      ref('everyone').hidden = role !== 'parent';
      ref('timeHelp').textContent = digest === 'tomorrow'
        ? 'The evening before, with the next day\'s plan.'
        : `The household's usual time is ${fmt.time(householdTime())} (Settings).`;
    }
    apply();
    form.addEventListener('change', apply);

    // A new parent or adult (or someone getting their first email address) can sign in as soon as
    // there's an email, as the Parent and Adult roles say; the box can still be unticked, and once
    // someone ticks or unticks it themselves, typing leaves it alone.
    const autoSignIn = !you && !hadLogin && (!editing || !p.email);
    let signInTouched = false;
    el.can_sign_in.addEventListener('change', () => { signInTouched = true; });
    el.email.addEventListener('input', () => {
      if (!autoSignIn || signInTouched || el.can_sign_in.disabled) return;
      el.can_sign_in.checked = !!el.email.value.trim();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let read;
      try { read = readPerson(form); } catch (err) { showError(err.message); return; }
      if (hadLogin && !read.canSignIn
        && !window.confirm(`${p.name} won't be able to sign in any more. Save anyway?`)) return;
      submit.disabled = true;
      errBox.hidden = true;
      try {
        const row = editing ? Object.assign({ id: p.id }, read.row) : Object.assign(read.row, { sort_order: nextSortOrder() });
        const saved = await call('save_person', { p: row, p_can_sign_in: read.canSignIn });
        formDialog.close();
        toast(`${editing ? 'Saved' : 'Added'} ${(saved && saved.name) || read.row.name}`);
        after1();
      } catch (err) {
        showError(friendly(err));
      } finally {
        submit.disabled = false;
      }
    });

    const del = form.querySelector('[data-act="remove"]');
    if (del) {
      del.addEventListener('click', async () => {
        const note = hadLogin ? ' They won\'t be able to sign in any more.' : '';
        if (!window.confirm(`Remove ${p.name} from the family list?${note} Their My day link stops working. Their events and tasks stay, with nobody in charge.`)) return;
        del.disabled = true;
        errBox.hidden = true;
        try {
          await call('remove_person', { p_person: p.id });
          formDialog.close();
          toast(`Removed ${p.name}`);
          after1();
        } catch (err) {
          showError(friendly(err));
        } finally {
          del.disabled = false;
        }
      });
    }

    if (!formDialog.open) formDialog.showModal();
    if (window.innerWidth > 700) el.name.focus();
  }

  // The save_person row from the form, checked first (friendlier than the database's errors).
  // Morning email off leaves its day, time and scope as they were, so turning it on again keeps them.
  function readPerson(form) {
    const el = form.elements;
    const v = (name) => String(el[name].value || '').trim();
    const checked = (name) => (form.querySelector(`input[name="${name}"]:checked`) || {}).value;
    const name = v('name').replace(/\s+/g, ' ');
    if (!name) throw new Error('Give them a name.');
    const role = checked('role');
    if (!ROLE[role]) throw new Error('Pick a role.');
    const email = v('email').toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Check the email address, or leave it empty.');
    const phone = v('phone');
    if (phone && !/\d/.test(phone)) throw new Error('Check the phone number, or leave it empty.');
    const color = checked('color');
    const digest = checked('digest') || 'off';
    const time = v('digest_time').slice(0, 5);
    const active = el.active ? el.active.checked : true;
    // Someone not active can't sign in (save_person refuses it), so unticking Active takes it away.
    const canSignIn = canLogin(role) && active && el.can_sign_in.checked;
    if (digest !== 'off' && !email) throw new Error('Add an email address for the morning email, or turn it off.');
    if (digest !== 'off' && !/^\d{2}:\d{2}$/.test(time)) throw new Error('Pick a time for the morning email.');
    if (canSignIn && !email) throw new Error('Add an email address so they can sign in, or untick "Can sign in".');

    const row = {
      name, role, email: email || null, phone: phone || null,
      color: COLOR.test(color || '') ? color : '#64748b',
      language: el.language.value === 'es' ? 'es' : 'en',
      digest_enabled: digest !== 'off',
      active,
    };
    if (digest !== 'off') {
      row.digest_day = digest;
      // The household's time is saved as "the household's time" (null), so it follows Settings.
      row.digest_time = digest === 'today' && time === householdTime() ? null : time;
      row.digest_scope = role === 'parent' && el.everyone.checked ? 'everyone' : 'mine';
    }
    return { row, canSignIn };
  }

  // ============================================
  // REGISTER
  // ============================================
  HomeHub.register({
    name: 'people',
    schema: { min: 2, max: 99 },
    nav: { label: 'Family', order: 60 },
    // #/people, and #/family (the v1 page's address).
    match: (parts) => (parts[0] === 'people' || parts[0] === 'family' ? {} : null),
    render: renderPeople,
    provides: { personForm },
  });
})();
