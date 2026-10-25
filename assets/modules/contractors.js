/* =====================================================================
   HOME HUB — Contractors (v1)
   The contractor directory: search, cards with tap-to-call and Message,
   and the add/edit form (which the Home page also uses).
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { G, api, data, formDialog, clone, firstName, webHref, telHref, toast, reachable, openForm,
    signOff, messageDialog, route, stale } = core;
  const { esc, plural } = G;

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

  HomeHub.register({
    name: 'contractors',
    schema: { min: 1, max: 1 },
    nav: { label: 'Contractors', order: 30 },
    match: (parts) => (parts[0] === 'contractors' ? {} : null),
    render: (main, ctx) => renderContractors(main, ctx.seq),
    provides: { contractorForm },
  });
})();
