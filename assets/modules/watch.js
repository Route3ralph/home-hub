/* Home Hub — the Watch page (v2, schema 22; docs/v2-design.md §27).
   Movies and shows the family wants to see: on Netflix, another streaming service, in the cinema or at a theatre.
   Every member reads and changes the list (watch_items, row-level security: members). The kids add to it from their
   My day (day.js, watch_add_by_token), written as "<name> (My day)".
   - Chips filter by where (All · Netflix · Streaming · Cinema · Theatre).
   - + Add / Edit (with Delete): a title, movie or show, where, the service's name, the last day it's showing (cinema
     and theatre), a link (https only) and a note.
   - Each row: Watched (it folds into Seen), Plan it (the Calendar's event form: "Movie night: …", 7pm), Edit.
   - Seen: the watched ones, with Not yet (back on the list). */
(function () {
  'use strict';
  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { q, toast, friendly, firstName } = core;
  const { esc } = core.G;
  const { v2 } = core;
  const { fmt, dates, ui } = v2;

  const PLACES = [['netflix', 'Netflix'], ['streaming', 'Streaming'], ['cinema', 'Cinema'], ['theatre', 'Theatre']];
  const PLACE_WORD = Object.fromEntries(PLACES);
  const KINDS = [['movie', 'Movie'], ['show', 'Show']];
  const KIND_WORD = Object.fromEntries(KINDS);
  const COLS = 'id,title,kind,place,service,url,note,showing_until,watched_at,created_at,created_by';
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  // A link as the database keeps it (as recipes'): https only, printable ASCII, from new URL(typed).href.
  // '' for nothing typed, null for one that can't be saved.
  function watchLink(typed) {
    const t = String(typed || '').trim();
    if (!t) return '';
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`); } catch (e) { return null; }
    if (u.protocol !== 'https:') return null;
    const href = u.href;
    return /^https:\/\/[!#-;=?-~]{4,}$/.test(href) && href.length <= 508 ? href : null;
  }
  const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

  // Who added it: a member's first name from their email, or the kid's name from "Max (My day)".
  function whoAdded(row) {
    const by = String(row.created_by || '');
    const kid = /^(.+) \(My day\)$/.exec(by);
    if (kid) return kid[1];
    const p = v2.people().find((x) => x.email && x.email === by);
    return p ? firstName(p.name) : '';
  }

  function subLine(st, r) {
    const bits = [KIND_WORD[r.kind] || 'Movie', PLACE_WORD[r.place] || 'Netflix'];
    if (r.service) bits.push(r.service);
    let until = '';
    if (r.showing_until && (r.place === 'cinema' || r.place === 'theatre') && !r.watched_at) {
      const left = (G_days(r.showing_until) - G_days(st.today));
      if (left < 0) until = `<span class="watch-soon">ended ${esc(fmt.day(r.showing_until))}</span>`;
      else if (left <= 7) until = `<span class="watch-soon">until ${esc(left === 0 ? 'today' : fmt.day(r.showing_until))}</span>`;
      else bits.push(`until ${fmt.day(r.showing_until)}`);
    }
    const who = whoAdded(r);
    if (who) bits.push(`added by ${who}`);
    return `${esc(bits.join(' · '))}${until ? ` · ${until}` : ''}`;
  }
  const G_days = (iso) => core.G.parseDate(iso);

  function rowHTML(st, r) {
    const name = r.url ? `<a class="watch-title" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>`
      : `<span class="watch-title">${esc(r.title)}</span>`;
    const acts = r.watched_at
      ? `<button type="button" class="btn btn-sm" data-act="unwatch" data-id="${esc(r.id)}">Not yet</button>`
      : `<button type="button" class="btn btn-sm" data-act="watched" data-id="${esc(r.id)}">Watched ✓</button>`
        + `<button type="button" class="btn btn-sm" data-act="plan" data-id="${esc(r.id)}">Plan it</button>`;
    return `<li class="watch-row" data-id="${esc(r.id)}">
      <div class="watch-main">${name}<small class="watch-sub">${subLine(st, r)}</small>${r.note ? `<p class="watch-note">${esc(r.note)}</p>` : ''}</div>
      <div class="watch-acts">${acts}<button type="button" class="btn btn-sm" data-act="edit" data-id="${esc(r.id)}">Edit</button></div></li>`;
  }

  function draw(st) {
    const main = st.main;
    const head = `<div class="page-head"><div><h1>Watch</h1><p class="meta">Movies and shows to see: on Netflix, streaming, in the cinema or at the theatre</p></div>
      <button type="button" class="btn btn-primary" data-act="add">+ Add</button></div>`;
    if (st.failed && !st.rows.length) {
      main.innerHTML = `${head}<p class="watch-fail" role="status">The list couldn't be loaded. Check the connection. <button type="button" class="linkbtn" data-act="retry">Try again</button></p>`;
      return;
    }
    const chips = `<div class="watch-chips" role="group" aria-label="Where">${[['all', 'All']].concat(PLACES).map(([k, l]) =>
      `<button type="button" class="watch-chip" data-act="place" data-place="${k}" aria-pressed="${st.place === k}">${esc(l)}</button>`).join('')}</div>`;
    const shown = st.rows.filter((r) => st.place === 'all' || r.place === st.place);
    const open = shown.filter((r) => !r.watched_at);
    const seen = shown.filter((r) => r.watched_at).sort((a, b) => (a.watched_at < b.watched_at ? 1 : -1));
    const list = open.length ? `<ul class="watch-list" role="list">${open.map((r) => rowHTML(st, r)).join('')}</ul>`
      : `<p class="empty-line">${st.rows.some((r) => !r.watched_at) ? 'Nothing here for that place.' : 'Nothing on the list yet. Add a movie or show you want to see; the kids can add from their My day.'}</p>`;
    const seenHTML = seen.length ? `<details class="watch-seen"${st.seenOpen ? ' open' : ''}><summary>${esc(`Seen (${seen.length})`)}</summary>
      <ul class="watch-list" role="list">${seen.map((r) => rowHTML(st, r)).join('')}</ul></details>` : '';
    main.innerHTML = `${head}<div class="watch-tools">${chips}</div>${ui.sectionHeading('To watch', open.length)}${list}${seenHTML}`;
  }

  async function load(st) {
    try {
      st.rows = (await q(core.sb.from('watch_items').select(COLS).order('created_at', { ascending: false }).order('id'))) || [];
      st.failed = false;
    } catch (err) {
      st.failed = true;
    }
    if (!st.ctx.stale()) draw(st);
  }

  function openItem(st, r) {
    core.openForm({
      title: r ? 'Edit' : 'Add a movie or show',
      fields: [
        { name: 'title', label: 'Title', required: true, value: r ? r.title : '', placeholder: 'Paddington in Peru' },
        { name: 'kind', label: 'Movie or show', type: 'select', value: r ? r.kind : 'movie', options: KINDS },
        { name: 'place', label: 'Where', type: 'select', value: r ? r.place : (st.place !== 'all' ? st.place : 'netflix'), options: PLACES },
        { name: 'service', label: 'Which one (optional)', value: r && r.service ? r.service : '', placeholder: 'Disney+, AMC, the Lyric Theatre' },
        { name: 'showing_until', label: 'Showing until (optional)', type: 'date', value: r && r.showing_until ? r.showing_until : '',
          help: 'For the cinema or a theatre: the last day it\'s on.' },
        { name: 'url', label: 'Link (optional)', type: 'url', value: r && r.url ? r.url : '', placeholder: 'https://…', help: 'The trailer, its Netflix page or the tickets.' },
        { name: 'note', label: 'Note (optional)', type: 'textarea', value: r && r.note ? r.note : '', placeholder: 'PG · Max and Leo want to see it' },
      ],
      submitLabel: r ? 'Save' : 'Add',
      extraActions: r ? [{ label: 'Delete', danger: true, onClick: async () => {
        if (!window.confirm(`Delete "${r.title}" from the list?`)) return false;
        await q(core.sb.from('watch_items').delete().eq('id', r.id));
        toast(`Deleted ${r.title}`);
        await load(st);
        return true;
      } }] : [],
      onSubmit: async (v) => {
        const title = clean(v.title, 100);
        if (!title) throw new Error('Write a title.');
        const url = watchLink(v.url);
        if (url === null) throw new Error('The link has to be a web address starting with https://.');
        const until = String(v.showing_until || '');
        if (until && !ISO_DATE.test(until)) throw new Error('Pick the last day from the calendar, or leave it blank.');
        const row = {
          title,
          kind: KIND_WORD[v.kind] ? v.kind : 'movie',
          place: PLACE_WORD[v.place] ? v.place : 'netflix',
          service: clean(v.service, 40) || null,
          showing_until: until || null,
          url: url || null,
          note: clean(v.note, 200) || null,
        };
        if (r) {
          const saved = await q(core.sb.from('watch_items').update(row).eq('id', r.id).select('id'));
          if (!saved || !saved.length) {
            load(st).catch(() => {});
            throw new Error('That one isn\'t on the list any more: someone may have deleted it.');
          }
        } else await q(core.sb.from('watch_items').insert(row).select('id'));
        toast(r ? 'Saved' : `Added ${title}`);
        await load(st);
      },
    });
  }

  async function setWatched(st, r, on) {
    try {
      const saved = await q(core.sb.from('watch_items').update({ watched_at: on ? new Date().toISOString() : null }).eq('id', r.id).select('id'));
      if (!saved || !saved.length) throw new Error('That one isn\'t on the list any more: someone may have deleted it.');
      toast(on ? `Watched: ${r.title}` : `Back on the list: ${r.title}`);
    } catch (err) {
      toast(friendly(err), { error: true });
    }
    await load(st);
  }

  // Plan it: the Calendar's own event form, filled in; nothing is saved until its Save.
  function plan(st, r) {
    const title = r.place === 'theatre' ? `Theatre: ${r.title}` : r.place === 'cinema' ? `Cinema: ${r.title}` : `Movie night: ${r.title}`;
    try {
      const open = core.use('calendar').openEventForm;
      Promise.resolve(open({ title, start_time: '19:00', date: st.today })).catch((err) => toast(friendly(err), { error: true }));
    } catch (err) {
      toast(friendly(err), { error: true });
    }
  }

  async function render(main, ctx) {
    const st = { main, ctx, rows: [], failed: false, place: 'all', seenOpen: false, today: dates.today() };
    main.innerHTML = '<div class="loading">Loading…</div>';
    main.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !main.contains(b)) return;
      const r = b.dataset.id ? st.rows.find((x) => x.id === b.dataset.id) : null;
      switch (b.dataset.act) {
        case 'add': openItem(st, null); break;
        case 'edit': if (r) openItem(st, r); break;
        case 'watched': if (r) setWatched(st, r, true); break;
        case 'unwatch': if (r) setWatched(st, r, false); break;
        case 'plan': if (r) plan(st, r); break;
        case 'place': st.place = b.dataset.place || 'all'; draw(st); break;
        case 'retry': load(st); break;
        default: break;
      }
    }, { signal: ctx.signal });
    main.addEventListener('toggle', (e) => { if (e.target.classList && e.target.classList.contains('watch-seen')) st.seenOpen = e.target.open; }, { capture: true, signal: ctx.signal });
    await load(st);
  }

  HomeHub.register({
    name: 'watch',
    schema: { min: 22, max: 99 },
    nav: { label: 'Watch', order: 36 },
    match(parts) { return parts[0] === 'watch' && parts.length === 1 ? {} : null; },
    render,
  });
})();
