/* =====================================================================
   HOME HUB — Directory (v2)
   Everyone and everything the household calls: contractors, accounts and
   utilities, services (the vet, the school, the doctor) and emergency
   numbers. Kind filter, search, and a card per entry with call / text /
   WhatsApp / email / website / map, the contract or promo end date (with
   a badge inside 30 days), notes and the projects it is linked on.
   Admins also see account numbers (contractor_secrets): masked until
   Show, loaded on their own, and never asked for by anyone else's
   browser. Replaces the v1 Contractors page (old #/contractors links open
   this one). Other pages open the form with
   use('directory').contractorForm(entry, after), as v1's
   use('contractors').contractorForm. Dates are the household's.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { G, esc, q, api, data, clone, toast, friendly, telHref, webHref, smsHref, whatsappHref,
    detailDialog, formDialog, wireFormDialog } = core;
  const { v2 } = core;
  const { fmt, dates, ui } = v2;

  const KIND_KEY = 'homehub.directory.kind'; // the kind filter, remembered on this device
  // contractors.kind; a row from before v2 has none and counts as a contractor.
  const KINDS = [
    { key: 'contractor', one: 'Contractor', many: 'Contractors', choice: 'Contractor or trade', name: 'Pat Lee', company: 'Lee Electric' },
    { key: 'account', one: 'Account', many: 'Accounts & utilities', choice: 'Account or utility', name: 'Acme Internet', company: '' },
    { key: 'service', one: 'Service', many: 'Services', choice: 'Service (vet, school, doctor…)', name: 'Happy Paws Vet', company: '' },
    { key: 'emergency', one: 'Emergency', many: 'Emergency', choice: 'Emergency number', name: 'Poison control', company: '' },
  ];
  const KIND = Object.fromEntries(KINDS.map((k) => [k.key, k]));
  // Category suggestions for each kind (the form's list; any other text is fine too).
  const SUGGEST = {
    contractor: ['Plumber', 'Electrician', 'HVAC', 'Handyman', 'Painter', 'Carpenter', 'Roofer', 'Landscaper', 'Pool', 'Pest control', 'Appliance repair', 'Cleaning', 'Tile', 'Flooring'],
    account: ['Internet', 'Cable/TV', 'Phone', 'Electric', 'Gas', 'Water', 'Trash', 'Insurance', 'Mortgage', 'Bank', 'Credit card', 'Streaming'],
    service: ['Vet', 'Groomer', 'School', 'Doctor', 'Dentist', 'Pediatrician', 'Pharmacy', 'Babysitter', 'Dog walker', 'Lawn care', 'Tutor'],
    emergency: ['Police', 'Fire', 'Poison control', 'Hospital', 'Urgent care', 'Emergency vet', 'Gas leak', 'Power outage', 'Water main', 'Locksmith'],
  };
  // The columns the form edits; a row passed in without all of them is read again first.
  const FORM_COLS = ['name', 'company', 'kind', 'category', 'phone', 'email', 'website', 'address', 'contract_end', 'notes'];
  const SECRET_COLS = ['account_number', 'account_name', 'secret_notes'];
  const SOON_DAYS = 30; // contract ends: badge from 30 days before (as heads_up() in the database)

  const ICON = Object.freeze({
    phone: ui.icon.phone,
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4 7l8 6 8-6"/></svg>',
    web: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.6 5.2 3.6 8.5s-1.1 6.1-3.6 8.5c-2.5-2.4-3.6-5.2-3.6-8.5S9.5 5.9 12 3.5z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
  });

  // The directory on screen: { reload(), stale() }, or null while another page shows.
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

  const isAdmin = () => !!(core.me && core.me.role === 'admin');
  const kindOf = (c) => (c && KIND[c.kind] ? c.kind : 'contractor');
  // v1 rows have a trade and no category; v2 saves both (see readEntry).
  const categoryOf = (c) => String((c && (c.category || c.trade)) || '').trim();
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const digits = (s) => String(s || '').replace(/\D/g, '');
  function isIso(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    try { return dates.addDays(s, 0) === s; } catch (e) { return false; }
  }
  // '•••• 7890': only the last 4, and nothing at all of a number that short.
  function masked(n) {
    const s = String(n || '').replace(/\s+/g, '');
    return s.length > 4 ? `•••• ${s.slice(-4)}` : '••••';
  }
  const mapHref = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  const shortUrl = (url) => String(url).replace(/^https?:\/\//i, '').replace(/\/$/, '');
  // Text and WhatsApp need a full number; 911 or a 3-digit service line only gets Call.
  const textable = (phone) => digits(phone).length >= 10;
  // 'Nov 10', or 'Mar 3, 2027' when it isn't this year (the household's year).
  const dayLabel = (iso) => (iso.slice(0, 4) === dates.today().slice(0, 4) ? fmt.short(iso) : `${fmt.short(iso)}, ${iso.slice(0, 4)}`);

  // Contract or promo end: the badge text and style, or null when it's more than 30 days off.
  function endBadge(iso) {
    const n = G.parseDate(iso) - G.parseDate(dates.today());
    if (n > SOON_DAYS) return null;
    if (n < 0) return { text: 'Ended', cls: 'dir-ended' };
    if (n === 0) return { text: 'Ends today', cls: 'dir-soon' };
    if (n === 1) return { text: 'Ends tomorrow', cls: 'dir-soon' };
    return { text: `Ends in ${n} days`, cls: n <= 7 ? 'dir-soon' : 'dir-near' };
  }

  // Which projects link this entry to a trade (v1's "On: Kitchen (Electrician)").
  function usageOf(contractorId, projects) {
    const uses = [];
    (projects || []).forEach((p) => Object.values((p.schedule || {}).trades || {}).forEach((t) => {
      if (t && t.contractor_id === contractorId) uses.push({ project: p, trade: t.name });
    }));
    return uses;
  }

  // Search: every word somewhere in the entry, or (3+ digits) part of its phone number.
  function matchesTerm(c, term) {
    const t = String(term || '').trim().toLowerCase();
    if (!t) return true;
    const hay = [c.name, c.company, categoryOf(c), c.trade, c.notes, c.email, c.phone, c.website, c.address, KIND[kindOf(c)].one]
      .map((x) => String(x || '')).join(' ').toLowerCase();
    if (t.split(/\s+/).every((w) => hay.includes(w))) return true;
    const d = digits(t);
    return d.length >= 3 && d.length === t.replace(/[\s()+.-]/g, '').length && digits(c.phone).includes(d);
  }

  // ============================================
  // DATA
  // ============================================
  const projectsQuery = () => q(core.sb.from('projects').select('id,name,schedule,updated_at').order('created_at'));
  const entryById = (id) => q(core.sb.from('contractors').select('*').eq('id', id).maybeSingle());
  // Admins only (the database refuses everyone else; this page never asks for them).
  const allSecrets = () => q(core.sb.from('contractor_secrets').select('contractor_id,account_number,account_name,secret_notes'));
  const secretFor = (id) => q(core.sb.from('contractor_secrets').select('contractor_id,account_number,account_name,secret_notes').eq('contractor_id', id).maybeSingle());

  // The database refuses a member's change to an entry with account details (private.contractors_guard)
  // with 42501 and the reason in plain words: show that, not the general "no permission".
  const guarded = (err) => !!(err && err.code === '42501' && err.message && !/row-level security|permission denied/i.test(err.message));
  async function write(query) {
    try { return await q(query); } catch (err) { throw guarded(err) ? new Error(err.message) : err; }
  }

  // Nothing was changed or deleted: either the entry is gone, or it has account details and the
  // database lets only an admin change it (members can't see contractor_secrets, so ask after).
  async function refusal(c, verb) {
    let still = true;
    try { still = !!(await entryById(c.id)); } catch (e) { /* assume it's still there */ }
    return still
      ? `Only an admin can ${verb} ${c.name}, because it has account details saved. Ask an admin to ${verb} it.`
      : `${c.name} was deleted a moment ago. Reload the page to see the latest.`;
  }

  async function updateEntry(c, row) {
    const rows = await write(core.sb.from('contractors').update(row).eq('id', c.id).select());
    if (rows && rows.length) return rows[0];
    throw new Error(await refusal(c, 'change'));
  }

  // Admins only. All three fields empty removes the row, so the entry no longer needs an admin.
  // Returns the account details as saved (null when there are none).
  async function saveAccount(id, acct, before) {
    const empty = SECRET_COLS.every((k) => !acct[k]);
    const same = !!before && SECRET_COLS.every((k) => (before[k] || null) === acct[k]);
    if (empty ? !before : same) return before;
    if (empty) {
      await q(core.sb.from('contractor_secrets').delete().eq('contractor_id', id));
      return null;
    }
    const row = Object.assign({ contractor_id: id }, acct);
    await q(core.sb.from('contractor_secrets').upsert(row, { onConflict: 'contractor_id' }));
    return row;
  }

  // Before a project loses the link, its trade gets the name as plain text, so it still says who
  // did the work (as v1 did). api.updateProject also refreshes the project's task dates.
  async function unlinkContractor(c, uses) {
    const label = [c.name, c.company].filter(Boolean).join(', ');
    const failed = [];
    for (const p of [...new Set(uses.map((u) => u.project))]) {
      const next = clone(p.schedule);
      Object.values(next.trades || {}).forEach((t) => {
        if (t && t.contractor_id === c.id) { delete t.contractor_id; t.who = label; }
      });
      try { await api.updateProject(p.id, { schedule: next }, p.updated_at); } catch (err) { failed.push(p.name); }
    }
    return failed;
  }

  // Delete after asking. The database refuses when a member deletes an entry with account details,
  // so delete first and unlink the projects after: a refusal changes nothing.
  // Returns false if cancelled.
  async function deleteEntry(c) {
    const projects = await projectsQuery();
    const uses = usageOf(c.id, projects);
    const linked = [...new Set(uses.map((u) => u.project.name))];
    const note = linked.length
      ? `\n\nIt's linked on ${count(linked.length, 'project', 'projects')} (${linked.join(', ')}); they'll keep the name but lose the link.`
      : '';
    if (!window.confirm(`Delete ${c.name}?${note}`)) return false;
    const rows = await write(core.sb.from('contractors').delete().eq('id', c.id).select('id'));
    if (Array.isArray(rows) && !rows.length) throw new Error(await refusal(c, 'delete'));
    const failed = await unlinkContractor(c, uses);
    toast(`Deleted ${c.name}`);
    if (failed.length) {
      toast(`Couldn't update ${failed.join(', ')}: open Trades & contractors there to put the name back.`, { error: true, ms: 9000 });
    }
    return true;
  }

  // ============================================
  // THE PAGE
  // ============================================
  async function renderDirectory(main, ctx) {
    const admin = isAdmin();
    const view = {
      entries: [], projects: [], secrets: null, secretsFailed: false,
      kind: KIND[stored(KIND_KEY)] ? stored(KIND_KEY) : 'all',
      term: '', shown: new Set(), target: ctx.params.id || null,
    };

    async function fetchAll() {
      const [entries, projects] = await Promise.all([api.contractors(), projectsQuery().catch(() => [])]);
      view.entries = entries || [];
      view.projects = projects || [];
      data.contractors = view.entries;
    }
    // Account numbers come after the cards, on their own; a failure only hides them.
    async function fetchSecrets() {
      if (!admin) return;
      try {
        const rows = await allSecrets();
        view.secrets = new Map((rows || []).map((r) => [r.contractor_id, r]));
        view.secretsFailed = false;
      } catch (err) {
        view.secrets = null;
        view.secretsFailed = true;
      }
    }

    await fetchAll();
    if (ctx.stale()) return;

    // An address for one entry (#/directory/<id>) shows it, whatever the filter was.
    const target = view.target && view.entries.find((c) => c.id === view.target);
    if (target && view.kind !== 'all' && view.kind !== kindOf(target)) view.kind = 'all';

    main.innerHTML = `
      <div class="page-head dir-head">
        <div><h1>Directory</h1><p class="meta" data-ref="meta"></p></div>
        <div class="page-actions"><button type="button" class="btn btn-primary dir-add" data-act="new">${ui.icon.plus}Add</button></div>
      </div>
      <div data-ref="banner"></div>
      <div class="dir-kinds" role="group" aria-label="Show" data-ref="kinds"></div>
      <div class="searchbar dir-searchbar" data-ref="searchbar"><input type="search" placeholder="Search names, numbers, notes" aria-label="Search the directory" autocomplete="off"></div>
      <p class="sr-only" aria-live="polite" data-ref="status"></p>
      <div data-ref="list"></div>`;
    const ref = (name) => main.querySelector(`[data-ref="${name}"]`);
    const search = main.querySelector('.dir-searchbar input');
    if (view.target && !target) {
      ref('banner').innerHTML = '<div class="banner banner-warn">That entry isn\'t in the directory any more.</div>';
    }

    function drawHead() {
      const n = view.entries.length;
      ref('meta').textContent = `${count(n, 'entry', 'entries')} · visible to the family only${admin ? '; account numbers to admins only' : ''}`;
      const counts = { all: n };
      view.entries.forEach((c) => { counts[kindOf(c)] = (counts[kindOf(c)] || 0) + 1; });
      const chip = (key, label) => `<button type="button" class="dir-chip" data-kind="${key}" aria-pressed="${view.kind === key}">${esc(label)}<span class="n">${counts[key] || 0}</span></button>`;
      const kinds = ref('kinds');
      const scroll = kinds.scrollLeft;
      kinds.innerHTML = chip('all', 'All') + KINDS.map((k) => chip(k.key, k.many)).join('');
      kinds.scrollLeft = scroll;
      kinds.hidden = !n;
      ref('searchbar').hidden = !n;
    }

    function drawList() {
      const list = ref('list');
      const shownKinds = view.kind === 'all' ? KINDS : [KIND[view.kind]];
      const matching = view.entries.filter((c) => (view.kind === 'all' || kindOf(c) === view.kind) && matchesTerm(c, view.term));
      const grid = (rows) => `<div class="grid dir-grid">${rows.map((c) => cardHTML(c, view, admin)).join('')}</div>`;
      let html;
      if (!view.entries.length) {
        html = `<div class="card empty-state dir-empty"><p>Keep the plumber, the internet company, the vet and the emergency numbers in one place.</p>
          <button type="button" class="btn btn-primary dir-btn" data-act="new">Add the first one</button></div>`;
      } else if (!matching.length) {
        html = view.term.trim()
          ? `<p class="empty-line dir-none">Nothing matches “${esc(view.term.trim())}”${view.kind === 'all' ? '' : ` in ${esc(KIND[view.kind].many)}`}.</p>`
          : `<div class="card empty-state dir-empty"><p>No ${esc(KIND[view.kind].many.toLowerCase())} yet.</p>
              <button type="button" class="btn btn-primary dir-btn" data-act="new">Add one</button></div>`;
      } else if (view.kind === 'all') {
        html = shownKinds.map((k) => {
          const rows = matching.filter((c) => kindOf(c) === k.key);
          return rows.length ? `<section class="dir-sec" data-group="${k.key}" aria-label="${esc(k.many)}">${ui.sectionHeading(k.many, rows.length)}${grid(rows)}</section>` : '';
        }).join('');
      } else {
        html = grid(matching);
      }
      list.innerHTML = html;
      // Account details someone opened stay open across a redraw (typing a search, say).
      list.querySelectorAll('.dir-account').forEach((box) => {
        if (view.shown.has(box.dataset.account)) fillAccount(box, view.secrets.get(box.dataset.account), true, false);
      });
      if (admin && view.secretsFailed) {
        list.insertAdjacentHTML('afterbegin', '<p class="meta dir-note">Couldn\'t load the account numbers just now. Reload the page to try again.</p>');
      }
      ref('status').textContent = view.entries.length && view.term.trim() ? `${count(matching.length, 'entry matches', 'entries match')}` : '';
    }

    function draw() { drawHead(); drawList(); }

    async function reload() {
      try {
        await fetchAll();
        if (ctx.stale()) return;
        view.target = null;
        draw();
        await fetchSecrets();
        if (!ctx.stale() && admin) drawList();
      } catch (err) {
        if (!ctx.stale()) toast(friendly(err), { error: true });
      }
    }

    draw();
    if (target) {
      const card = main.querySelector(`.dir-card[data-id="${CSS.escape(target.id)}"]`);
      if (card) {
        card.classList.add('is-target');
        card.scrollIntoView({ block: 'center' });
        card.querySelector('h3').focus({ preventScroll: true });
      }
    }

    // Copy a shown account number. Without a clipboard (an older phone), it shows to copy by hand.
    async function copyAccount(btn) {
      const sec = view.secrets && view.secrets.get(btn.dataset.copyAcct);
      if (!sec || !sec.account_number) return;
      try {
        await navigator.clipboard.writeText(sec.account_number);
        toast('Account number copied');
      } catch (err) {
        window.prompt('Copy the account number:', sec.account_number);
      }
    }

    // Show / Hide one entry's account details (admins). The full number is only ever put in as text.
    function toggleAccount(btn) {
      const id = btn.dataset.show;
      const box = btn.closest('.dir-account');
      const sec = view.secrets && view.secrets.get(id);
      if (!box || !sec) return;
      const open = btn.getAttribute('aria-expanded') !== 'true';
      if (open) view.shown.add(id); else view.shown.delete(id);
      fillAccount(box, sec, open, true);
    }

    main.addEventListener('click', (e) => {
      const kindBtn = e.target.closest('[data-kind]');
      if (kindBtn) {
        view.kind = kindBtn.dataset.kind;
        store(KIND_KEY, view.kind);
        drawHead();
        drawList();
        const again = ref('kinds').querySelector(`[data-kind="${view.kind}"]`);
        if (again) again.focus();
        return;
      }
      if (e.target.closest('[data-act="new"]')) {
        contractorForm(view.kind === 'all' ? null : { kind: view.kind }, reload);
        return;
      }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const c = view.entries.find((x) => x.id === edit.dataset.edit);
        if (c) contractorForm(c, reload);
        return;
      }
      const show = e.target.closest('[data-show]');
      if (show) { toggleAccount(show); return; }
      const copy = e.target.closest('[data-copy-acct]');
      if (copy) copyAccount(copy);
    }, { signal: ctx.signal });
    search.addEventListener('input', () => { view.term = search.value; drawList(); }, { signal: ctx.signal });

    page = { reload, stale: ctx.stale };
    ctx.signal.addEventListener('abort', () => { if (page && page.reload === reload) page = null; });

    if (admin) {
      await fetchSecrets();
      if (!ctx.stale()) drawList();
    }
  }

  // One entry's card: who, how to reach them, the contract end, notes, account (admins) and projects.
  function cardHTML(c, view, admin) {
    const kind = kindOf(c);
    const cat = categoryOf(c);
    const lines = [];
    // People and services can be texted; an account's phone line or an emergency number gets Call only.
    const messages = textable(c.phone) && (kind === 'contractor' || kind === 'service');
    if (c.phone) {
      lines.push(`<div class="dir-line dir-phone">
        <a class="dir-link" href="${esc(telHref(c.phone))}" data-via="call" aria-label="Call ${esc(c.name)}, ${esc(c.phone)}">${ICON.phone}<span>${esc(c.phone)}</span></a>
        ${messages ? `<a class="btn dir-btn" href="${esc(smsHref(c.phone, ''))}" data-via="sms" aria-label="Text ${esc(c.name)}">Text</a>
        <a class="btn dir-btn" href="${esc(whatsappHref(c.phone, ''))}" data-via="whatsapp" target="_blank" rel="noopener" aria-label="WhatsApp ${esc(c.name)}">WhatsApp</a>` : ''}
      </div>`);
    }
    if (c.email) lines.push(`<a class="dir-link" href="mailto:${esc(c.email)}" data-via="email" aria-label="Email ${esc(c.name)}, ${esc(c.email)}">${ICON.mail}<span>${esc(c.email)}</span></a>`);
    if (c.website) lines.push(`<a class="dir-link" href="${esc(webHref(c.website))}" data-via="web" target="_blank" rel="noopener">${ICON.web}<span>${esc(shortUrl(c.website))}</span></a>`);
    if (c.address) lines.push(`<a class="dir-link" href="${esc(mapHref(c.address))}" data-via="map" target="_blank" rel="noopener" aria-label="Map: ${esc(c.address)}">${ICON.pin}<span>${esc(c.address)}</span></a>`);

    let end = '';
    if (isIso(c.contract_end)) {
      const badge = endBadge(c.contract_end);
      const past = G.parseDate(c.contract_end) < G.parseDate(dates.today());
      end = `<p class="dir-end">${past ? 'Contract ended' : 'Contract ends'} ${esc(dayLabel(c.contract_end))}${badge ? ` <span class="badge ${badge.cls}">${esc(badge.text)}</span>` : ''}</p>`;
    }

    let account = '';
    const sec = admin && view.secrets ? view.secrets.get(c.id) : null;
    if (sec && SECRET_COLS.some((k) => sec[k])) {
      account = `<div class="dir-account" data-account="${esc(c.id)}" data-name="${esc(c.name)}">${accountInner(c.id, c.name, sec, false)}</div>`;
    }

    const uses = usageOf(c.id, view.projects);
    const used = uses.length
      ? `<div class="dir-used"><span>On:</span> ${uses.map((u, i) => `<span class="dir-use"><a href="#/projects/${encodeURIComponent(u.project.id)}">${esc(u.project.name)}</a>${u.trade ? ` (${esc(u.trade)})` : ''}${i < uses.length - 1 ? ',' : ''}</span>`).join(' ')}</div>`
      : '';

    return `<article class="ccard dir-card k-${kind}" data-id="${esc(c.id)}" aria-label="${esc(c.name)}">
      <div class="ccard-top">
        <div class="dir-title"><h3 tabindex="-1">${esc(c.name)}</h3>
          <div class="dir-sub">${c.company && c.company !== c.name ? `<span class="company">${esc(c.company)}</span>` : ''}<span class="pill dir-pill k-${kind}">${esc(cat || KIND[kind].one)}</span></div></div>
        <button type="button" class="btn dir-btn dir-edit" data-edit="${esc(c.id)}" aria-label="Edit ${esc(c.name)}">Edit</button>
      </div>
      ${lines.length ? `<div class="dir-lines">${lines.join('')}</div>` : ''}
      ${end}
      ${c.notes ? `<p class="notes dir-notes">${esc(c.notes)}</p>` : ''}
      ${account}
      ${used}
    </article>`;
  }

  // The account line, masked or shown. Shown, the number, name and notes go in as text only
  // (fillAccount), so the full number is never in the page until someone taps Show; then Copy puts
  // the number on the clipboard (for reading it out on hold, or pasting into a form).
  function accountInner(id, name, sec, open) {
    const what = `the ${name} account ${sec.account_number ? 'number' : 'details'}`;
    return `<span class="dir-acct-icon" aria-hidden="true">${ICON.lock}</span>
      <span class="dir-acct-text"><span class="dir-acct-label">Account</span> <span class="dir-acct-num" data-ref="num">${sec.account_number ? esc(masked(sec.account_number)) : 'details saved'}</span></span>
      <span class="dir-acct-btns">
        ${open && sec.account_number ? `<button type="button" class="btn dir-btn" data-copy-acct="${esc(id)}" aria-label="Copy ${esc(`the ${name} account number`)}">Copy</button>` : ''}
        <button type="button" class="btn dir-btn" data-show="${esc(id)}" aria-expanded="${!!open}" aria-label="${esc(`${open ? 'Hide' : 'Show'} ${what}`)}">${open ? 'Hide' : 'Show'}</button>
      </span>
      <div class="dir-acct-more" data-ref="more"${open ? '' : ' hidden'}></div>`;
  }
  function fillAccount(box, sec, open, focus) {
    box.innerHTML = accountInner(box.dataset.account, box.dataset.name || '', sec, open);
    if (open) {
      if (sec.account_number) box.querySelector('[data-ref="num"]').textContent = sec.account_number;
      const more = box.querySelector('[data-ref="more"]');
      more.textContent = [sec.account_name ? `Name on the account: ${sec.account_name}` : '', sec.secret_notes || ''].filter(Boolean).join('\n');
      more.hidden = !more.textContent;
    }
    const btn = box.querySelector('[data-show]');
    if (focus && btn) btn.focus();
  }

  // ============================================
  // THE FORM (add / edit; also for other pages: use('directory').contractorForm)
  // contractorForm(entry, after): entry = a contractors row to edit, or null (or defaults such as
  // { kind: 'account' }) to add one; after() runs once something was saved or deleted.
  // ============================================
  function contractorForm(entry, after) {
    return openEntryForm(entry, after).catch((err) => toast(friendly(err), { error: true }));
  }

  async function openEntryForm(entry, after) {
    const editing = !!(entry && entry.id);
    const admin = isAdmin();
    const defaults = !editing && entry ? entry : {};
    const needsRow = editing && !FORM_COLS.every((k) => k in entry);
    // Account details are read fresh, by this entry's id, and only by an admin.
    const [row, secret] = await Promise.all([
      needsRow ? entryById(entry.id) : entry,
      admin && editing ? secretFor(entry.id).then((s) => ({ ok: true, row: s || null }), () => ({ ok: false, row: null })) : { ok: admin, row: null },
    ]);
    if (editing && !row) throw new Error(`${entry.name || 'That entry'} isn't in the directory any more. Reload the page to see the latest.`);
    let c = editing ? row : null;            // the saved row; set once a new entry is added
    let acctBefore = secret.row;
    const x = c || {};
    let kind = KIND[x.kind] ? x.kind : KIND[defaults.kind] ? defaults.kind : 'contractor';
    const after1 = typeof after === 'function' ? after : () => { if (page && !page.stale()) page.reload(); };
    const val = (k) => (x[k] != null ? x[k] : defaults[k] != null ? defaults[k] : '');

    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = `<form class="form d-inner dir-form" novalidate>
      <div class="d-top"><h3>${editing ? `Edit ${esc(x.name)}` : 'Add to the directory'}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>
      <label class="field"><span>Kind</span><select name="kind">${KINDS.map((k) => `<option value="${k.key}"${k.key === kind ? ' selected' : ''}>${esc(k.choice)}</option>`).join('')}</select></label>
      <div class="field-row">
        <label class="field"><span>Name</span><input type="text" name="name" value="${esc(val('name'))}" maxlength="200" autocomplete="off" required></label>
        <label class="field"><span>Company <small>(optional)</small></span><input type="text" name="company" value="${esc(val('company'))}" maxlength="200" autocomplete="off"></label>
      </div>
      <label class="field"><span>Category</span><input type="text" name="category" list="dirCategories" value="${esc(categoryOf(x) || val('category'))}" maxlength="80" autocomplete="off">
        <datalist id="dirCategories"></datalist><small>Pick a suggestion or type your own.</small></label>
      <div class="field-row">
        <label class="field"><span>Phone</span><input type="tel" name="phone" value="${esc(val('phone'))}" maxlength="40" autocomplete="off" placeholder="(201) 555-0100"></label>
        <label class="field"><span>Email</span><input type="email" name="email" value="${esc(val('email'))}" maxlength="200" autocomplete="off"></label>
      </div>
      <label class="field"><span>Website or account portal</span><input type="text" name="website" inputmode="url" value="${esc(val('website'))}" maxlength="300" autocomplete="off"></label>
      <label class="field"><span>Address</span><input type="text" name="address" value="${esc(val('address'))}" maxlength="300" autocomplete="off"></label>
      <label class="field"><span>Contract or promo ends <small>(optional)</small></span><input type="date" name="contract_end" value="${esc(isIso(x.contract_end) ? x.contract_end : '')}">
        <small>It shows a badge, and a heads-up in Today and the morning email, from 30 days before.</small></label>
      <label class="field"><span>Notes</span><textarea name="notes" rows="3" maxlength="4000">${esc(val('notes'))}</textarea></label>
      ${admin ? accountFields(secret) : ''}
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions">
        ${editing ? '<button type="button" class="btn btn-danger left" data-act="delete">Delete</button>' : ''}
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Add'}</button>
      </div>
    </form>`;

    const form = formDialog.querySelector('form');
    const el = form.elements;
    const errBox = form.querySelector('.form-error');
    const submit = form.querySelector('[type="submit"]');
    const showError = (msg) => { errBox.textContent = msg; errBox.hidden = false; };

    // Suggestions and examples follow the kind.
    function applyKind() {
      kind = KIND[el.kind.value] ? el.kind.value : 'contractor';
      form.querySelector('#dirCategories').innerHTML = SUGGEST[kind].map((s) => `<option value="${esc(s)}"></option>`).join('');
      el.name.placeholder = KIND[kind].name;
      el.company.placeholder = KIND[kind].company;
      el.category.placeholder = SUGGEST[kind].slice(0, 3).join(', ');
    }
    applyKind();
    el.kind.addEventListener('change', applyKind);

    // The saved account number stays masked until Show; then it can be changed.
    const reveal = form.querySelector('[data-act="reveal"]');
    if (reveal) {
      reveal.addEventListener('click', () => {
        const input = el.account_number;
        const mask = form.querySelector('.dir-mask');
        const open = input.hidden;
        input.hidden = !open;
        mask.hidden = open;
        if (!open) mask.textContent = input.value.trim() ? masked(input.value) : 'None';
        reveal.textContent = open ? 'Hide' : 'Show';
        reveal.setAttribute('aria-expanded', String(open));
        if (open) input.focus();
      });
    }

    // After a new entry is saved it is edited from then on, so trying again doesn't add a second one.
    function nowEditing(saved) {
      c = saved;
      form.querySelector('.d-top h3').textContent = `Edit ${saved.name}`;
      submit.textContent = 'Save';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let row1;
      let acct = null;
      try {
        row1 = readEntry(form, kind);
        if (admin && secret.ok) acct = readAccount(form);
      } catch (err) { showError(err.message); return; }
      submit.disabled = true;
      errBox.hidden = true;
      const added = !c;
      try {
        const saved = c ? await updateEntry(c, row1) : await q(core.sb.from('contractors').insert(row1).select().single());
        nowEditing(saved);
        if (acct) {
          try {
            acctBefore = await saveAccount(saved.id, acct, acctBefore);
          } catch (err) {
            after1();
            showError(`${added ? 'Added' : 'Saved'} ${saved.name}, but the account details weren't saved: ${friendly(err)} Try Save again.`);
            return;
          }
        }
        formDialog.close();
        toast(`${added ? 'Added' : 'Saved'} ${saved.name}`);
        after1();
      } catch (err) {
        showError(friendly(err));
      } finally {
        submit.disabled = false;
      }
    });

    const del = form.querySelector('[data-act="delete"]');
    if (del) {
      del.addEventListener('click', async () => {
        del.disabled = true;
        errBox.hidden = true;
        try {
          if (await deleteEntry(c)) {
            formDialog.close();
            after1();
          }
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

  // Admins: the account section. A saved number shows masked, with Show.
  function accountFields(secret) {
    if (!secret.ok) {
      return `<fieldset class="dir-fs"><legend>Account <small>(admins only)</small></legend>
        <p class="meta dir-note">Couldn't load the account details just now, so saving leaves them as they are. Close this and open it again to change them.</p></fieldset>`;
    }
    const s = secret.row || {};
    const has = !!s.account_number;
    return `<fieldset class="dir-fs dir-acct-fs"><legend>Account <small>(admins only)</small></legend>
      <div class="field"><span id="dirNumLabel">Account number</span>
        <div class="dir-secret">
          ${has ? `<span class="dir-mask">${esc(masked(s.account_number))}</span>
          <button type="button" class="btn dir-btn" data-act="reveal" aria-expanded="false" aria-controls="dirNum">Show</button>` : ''}
          <input type="text" id="dirNum" name="account_number" value="${esc(s.account_number || '')}" maxlength="100" autocomplete="off" spellcheck="false" aria-labelledby="dirNumLabel"${has ? ' hidden' : ''}>
        </div>
      </div>
      <label class="field"><span>Name on the account</span><input type="text" name="account_name" value="${esc(s.account_name || '')}" maxlength="200" autocomplete="off"></label>
      <label class="field"><span>Private notes</span><textarea name="secret_notes" rows="2" maxlength="4000" placeholder="The plan, who's on it, how to cancel">${esc(s.secret_notes || '')}</textarea></label>
      <small class="dir-help">Only admins can see these. An entry with account details can only be changed or deleted by an admin.</small>
    </fieldset>`;
  }

  // The contractors row from the form, checked first (friendlier than the database's errors).
  // trade gets the category too, so the Projects trade picker and older copies of the site still say what they do.
  function readEntry(form, kind) {
    const v = (name) => String(form.elements[name].value || '').trim();
    const name = v('name');
    if (!name) throw new Error('Give the entry a name.');
    const email = v('email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Check the email address, or leave it empty.');
    const phone = v('phone');
    if (phone && !digits(phone)) throw new Error('Check the phone number, or leave it empty.');
    const end = v('contract_end');
    if (end && !isIso(end)) throw new Error('Pick a valid date for when the contract ends, or clear it.');
    const category = v('category');
    return {
      kind,
      name,
      company: v('company') || null,
      category: category || null,
      trade: category || null,
      phone: phone || null,
      email: email || null,
      website: v('website') || null,
      address: v('address') || null,
      contract_end: end || null,
      notes: v('notes') || null,
    };
  }

  function readAccount(form) {
    const v = (name) => String(form.elements[name].value || '').trim() || null;
    return { account_number: v('account_number'), account_name: v('account_name'), secret_notes: v('secret_notes') };
  }

  // ============================================
  // REGISTER
  // ============================================
  HomeHub.register({
    name: 'directory',
    schema: { min: 2, max: 99 },
    nav: { label: 'Directory', order: 50 },
    // #/directory · #/directory/<id> (that entry, highlighted) · #/contractors (v1 links).
    match(parts) {
      if (parts[0] === 'directory') return { id: parts[1] || null };
      if (parts[0] === 'contractors') return { id: null };
      return null;
    },
    render: renderDirectory,
    provides: { contractorForm },
  });
})();
