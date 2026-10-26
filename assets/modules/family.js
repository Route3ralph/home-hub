/* =====================================================================
   HOME HUB — Family (v1)
   Who can sign in; admins add and remove people. Also the Sign out button.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { G, api, data, firstName, toast, friendly, openForm, route, stale } = core;
  const { esc } = G;

  // ============================================
  // FAMILY
  // ============================================
  async function renderFamily(main, seq) {
    const { me, sb } = core;
    const members = await api.members();
    if (stale(seq)) return;
    data.members = members;
    const admin = me.role === 'admin';
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Family</h1><p class="meta">Signed in as ${esc(me.name)} (${esc(me.email)})</p></div>
        <div class="page-actions">
          <button class="btn" data-act="sign-out">Sign out</button>
          ${admin ? '<button class="btn btn-primary" data-act="add-member">+ Add family member</button>' : ''}
        </div>
      </div>
      <section class="card">
        <div class="card-head"><h2>Who can sign in</h2><span class="card-sub">${admin ? 'As an admin, you can add and remove people' : 'Ask an admin to add someone'}</span></div>
        <ul class="rows">${members.map((m) => `<li>
          <div class="grow"><strong>${esc(m.name)}</strong>${m.email === me.email ? ' (you)' : ''}<div class="sub">${esc(m.email)}</div></div>
          <span class="pill${m.role === 'admin' ? ' role-admin' : ''}">${m.role === 'admin' ? 'Admin' : 'Member'}</span>
          ${admin && m.email !== me.email ? `<button type="button" class="btn btn-sm btn-danger" data-remove="${esc(m.email)}">Remove</button>` : ''}
        </li>`).join('')}</ul>
      </section>
      <section class="card">
        <div class="card-head"><h2>How sign-in works</h2></div>
        <p class="empty">Each person signs in with their own email address. They get a one-time link, and after that their device stays signed in.
        Removing someone here blocks their access right away. Members can edit projects and contractors; admins can also manage this list.</p>
      </section>`;
    main.onclick = async (e) => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'sign-out') { await sb.auth.signOut(); return; }
      if (act && act.dataset.act === 'add-member') { memberForm(); return; }
      const rm = e.target.closest('[data-remove]');
      if (rm && window.confirm(`Remove ${rm.dataset.remove}? They will lose access to the Home Hub.`)) {
        try { await api.removeMember(rm.dataset.remove); toast('Removed'); route(); }
        catch (err) { alert(friendly(err)); }
      }
    };
  }

  function memberForm() {
    openForm({
      title: 'Add family member',
      intro: 'They sign in with this email address. Nothing is sent until they ask for a sign-in link on the Home Hub page.',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'role', label: 'Role', type: 'select', value: 'member',
          options: [['member', 'Member: can edit projects and contractors'], ['admin', 'Admin: can also manage this list']] },
      ],
      submitLabel: 'Add',
      async onSubmit(v) {
        await api.addMember({ name: v.name, email: v.email.toLowerCase(), role: v.role });
        toast(`${firstName(v.name)} can now sign in`);
        route();
      },
    });
  }

  HomeHub.register({
    name: 'family',
    schema: { min: 1, max: 1 },
    nav: { label: 'Family', order: 40 },
    match: (parts) => (parts[0] === 'family' ? {} : null),
    render: (main, ctx) => renderFamily(main, ctx.seq),
  });
})();
