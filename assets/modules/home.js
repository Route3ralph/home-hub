/* =====================================================================
   HOME HUB — Home page (v1)
   The greeting, what's coming up across all projects, the open projects
   and a link to the contractor directory.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { G, api, data, firstName, safeModel, route, stale } = core;
  const { esc, fmt, plural } = G;

  // ============================================
  // HOME
  // ============================================
  async function renderHome(main, seq) {
    const { me } = core;
    const { projectCard, emptyProjects, newProjectForm } = core.use('projects');
    const { contractorForm } = core.use('contractors');
    const [projects, contractors] = await Promise.all([api.projects(), api.contractors()]);
    if (stale(seq)) return;
    data.projects = projects;
    data.contractors = contractors;
    const open = projects.filter((p) => p.status !== 'done');
    const models = open.map((p) => ({ p, M: safeModel(p) }));
    const upcoming = [];
    models.forEach(({ p, M }) => {
      if (!M || M.empty) return;
      M.items.forEach((r) => {
        if (r.task.status !== 'done' && r.end >= M.today && r.start <= M.today + 14) upcoming.push({ p, M, r });
      });
    });
    upcoming.sort((a, b) => a.r.start - b.r.start || a.r.end - b.r.end);
    const today = G.todayNum();
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    main.innerHTML = `
      <div class="page-head">
        <div>
          <p class="eyebrow">${esc(fmt(today, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
          <h1>${greeting}, ${esc(firstName(me.name))}</h1>
        </div>
        <div class="page-actions">
          <button class="btn" data-act="new-contractor">+ Contractor</button>
          <button class="btn btn-primary" data-act="new-project">+ New project</button>
        </div>
      </div>
      <section class="card">
        <div class="card-head"><h2>Coming up</h2><span class="card-sub">Next 14 days, across all projects</span></div>
        <ul class="items">${upcoming.length
          ? upcoming.slice(0, 12).map(({ p, M, r }) => G.itemHTML(M, r, { context: p.name, attrs: ` data-project="${esc(p.id)}"` })).join('')
          : '<li class="empty">Nothing scheduled in the next two weeks.</li>'}</ul>
      </section>
      <h2 class="section-title">Open projects</h2>
      ${open.length ? `<div class="grid">${models.map(({ p, M }) => projectCard(p, M)).join('')}</div>` : emptyProjects()}
      <h2 class="section-title">Contractors</h2>
      <div class="card"><div class="card-head"><h2>${plural(contractors.length, 'contractor')} on file</h2><span class="spacer"></span><a class="btn btn-sm" href="#/contractors">Open directory</a></div><p class="empty">Names, numbers and notes for everyone who works on the house.</p></div>`;

    main.onclick = (e) => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'new-project') { newProjectForm(); return; }
      if (act && act.dataset.act === 'new-contractor') { contractorForm(null, () => route()); return; }
      const item = e.target.closest('.item[data-project]');
      if (item) location.hash = `#/projects/${encodeURIComponent(item.dataset.project)}/task/${encodeURIComponent(item.dataset.id)}`;
    };
  }

  HomeHub.register({
    name: 'home',
    schema: { min: 1, max: 1 },
    nav: { label: 'Home', order: 10, href: '#/' },
    // The first page; the core also shows it for any address no other page claims.
    match: (parts) => (parts.length ? null : {}),
    render: (main, ctx) => renderHome(main, ctx.seq),
  });
})();
