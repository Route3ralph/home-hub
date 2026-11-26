/* Home Hub — the Birthdays page (v2, schema 40; docs/v2-design.md §46).
   The family's birthdays in one list, the next one first: a name, the day, the year of birth if known ("turns 12"), and
   optionally who it is on the family list. Every member reads it (birthdays, row-level security); only an admin (a parent
   who signs in) adds, changes or deletes one. On the day each shows on the Calendar ("🎂 Sam turns 12") and in the
   morning email; from 7 days before, a parent's Today page and email say "🎁 Gift for Sam" until someone ticks Bought.
   Neither reaches the person whose birthday it is (that's why "Who is it" matters). Never on My day, the wall, the
   family board, Google or a guest's page. */
(function () {
  'use strict';
  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { q, toast } = core;
  const { esc } = core.G;
  const { v2 } = core;
  const { fmt, dates, ui } = v2;

  const COLS = 'id,name,month,day,born_year,person_id';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isAdmin = () => !!(core.me && core.me.role === 'admin');
  const leap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const pad = (n) => String(n).padStart(2, '0');
  const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

  // The day of a birthday in year y: 29 February is the 28th when y isn't a leap year (as private.birthday_on).
  const onYear = (b, y) => `${y}-${pad(b.month)}-${pad(b.month === 2 && b.day === 29 && !leap(y) ? 28 : b.day)}`;
  // Its next day from today (today counts), and the age then.
  function next(b, today) {
    const y = Number(today.slice(0, 4));
    const day = onYear(b, y) >= today ? onYear(b, y) : onYear(b, y + 1);
    const turns = b.born_year && Number(day.slice(0, 4)) > b.born_year ? Number(day.slice(0, 4)) - b.born_year : null;
    return { day, turns, inDays: core.G.parseDate(day) - core.G.parseDate(today) };
  }
  function whenText(n) {
    if (n.inDays === 0) return 'today';
    if (n.inDays === 1) return 'tomorrow';
    return `in ${n.inDays} days`;
  }

  function rowHTML(st, b) {
    const n = next(b, st.today);
    const p = b.person_id ? v2.person(b.person_id) : null;
    const bits = [`${fmt.day(n.day)}`, n.turns ? `turns ${n.turns}` : null, whenText(n)].filter(Boolean);
    return `<li class="bday-row${n.inDays <= 7 ? ' is-soon' : ''}" data-id="${esc(b.id)}">
      <div class="bday-main"><span class="bday-name">${p ? `<span aria-hidden="true">${ui.personDot(p)}</span>` : ''}<span class="bday-n">${esc(b.name)}</span></span>
        <small class="bday-sub">${esc(bits.join(' · '))}</small></div>
      ${st.admin ? `<button type="button" class="btn btn-sm" data-act="edit" data-id="${esc(b.id)}" aria-label="Edit ${esc(b.name)}">Edit</button>` : ''}</li>`;
  }

  function draw(st) {
    const head = `<div class="page-head"><div><h1>Birthdays</h1><p class="meta">On the Calendar on the day, and a gift reminder for the parents a week before</p></div>
      ${st.admin ? '<button type="button" class="btn btn-primary" data-act="add">+ Add</button>' : ''}</div>`;
    if (st.failed && !st.rows.length) {
      st.main.innerHTML = `${head}<p class="bday-fail" role="status">The birthdays couldn't be loaded. Check the connection. <button type="button" class="linkbtn" data-act="retry">Try again</button></p>`;
      return;
    }
    const rows = st.rows.slice().sort((a, b) => next(a, st.today).inDays - next(b, st.today).inDays || a.name.localeCompare(b.name));
    const list = rows.length ? `<ul class="bday-list" role="list">${rows.map((b) => rowHTML(st, b)).join('')}</ul>`
      : `<p class="empty-line">${st.admin ? 'No birthdays yet. Add the family\'s, and anyone you buy presents for.' : 'No birthdays yet. A parent adds them.'}</p>`;
    const note = st.admin ? '' : '<p class="meta bday-note">Only a parent can change the list.</p>';
    st.main.innerHTML = `${head}${ui.sectionHeading('Coming up', rows.length)}${list}${note}`;
  }

  async function load(st) {
    try {
      st.rows = (await q(core.sb.from('birthdays').select(COLS).order('month').order('day').order('name'))) || [];
      st.failed = false;
    } catch (err) {
      st.failed = true;
    }
    if (!st.ctx.stale()) draw(st);
  }

  // The form's values as a row, or an Error that says what to fix.
  function readRow(v) {
    const name = clean(v.name, 60);
    if (!name) throw new Error('Write a name.');
    const month = Number(v.month);
    const day = Number(v.day);
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) throw new Error('Pick the month and the day.');
    if (day > DAYS_IN[month - 1]) throw new Error(`${MONTHS[month - 1]} has only ${DAYS_IN[month - 1]} days.`);
    let born = null;
    if (String(v.born_year || '').trim()) {
      born = Number(String(v.born_year).trim());
      const thisYear = Number(dates.today().slice(0, 4));
      if (!Number.isInteger(born) || born < 1900 || born > thisYear) throw new Error(`The year of birth is a year from 1900 to ${thisYear}, or leave it blank.`);
      if (month === 2 && day === 29 && !leap(born)) throw new Error(`${born} had no 29 February.`);
    }
    const who = String(v.person_id || '');
    return { name, month, day, born_year: born, person_id: who && v2.person(who) ? who : null };
  }

  function openItem(st, b) {
    const people = v2.people().filter((p) => p.active !== false);
    const taken = new Set(st.rows.filter((x) => x.person_id && (!b || x.id !== b.id)).map((x) => x.person_id));
    core.openForm({
      title: b ? `Edit ${b.name}'s birthday` : 'Add a birthday',
      fields: [
        { name: 'name', label: 'Name', required: true, value: b ? b.name : '', placeholder: 'Grandma Pat' },
        { type: 'row', fields: [
          { name: 'month', label: 'Month', type: 'select', value: b ? b.month : '', options: [['', 'Month']].concat(MONTHS.map((m, i) => [i + 1, m])) },
          { name: 'day', label: 'Day', type: 'select', value: b ? b.day : '', options: [['', 'Day']].concat(Array.from({ length: 31 }, (_, i) => [i + 1, String(i + 1)])) },
        ] },
        { name: 'born_year', label: 'Year of birth (optional)', type: 'number', value: b && b.born_year ? b.born_year : '', placeholder: '2014',
          help: 'For the age: "Sam turns 12".' },
        { name: 'person_id', label: 'Who is it (optional)', type: 'select', value: b && b.person_id ? b.person_id : '',
          options: [['', 'Someone not on the family list']].concat(people.filter((p) => !taken.has(p.id)).map((p) => [p.id, p.name])),
          help: 'Pick them if they\'re on the family list: their own gift reminder is then kept from them.' },
      ],
      submitLabel: b ? 'Save' : 'Add',
      extraActions: b ? [{ label: 'Delete', danger: true, onClick: async () => {
        if (!window.confirm(`Delete ${b.name}'s birthday?`)) return false;
        await q(core.sb.from('birthdays').delete().eq('id', b.id));
        toast(`Deleted ${b.name}'s birthday`);
        await load(st);
        return true;
      } }] : [],
      onSubmit: async (v) => {
        const row = readRow(v);
        try {
          if (b) {
            const saved = await q(core.sb.from('birthdays').update(row).eq('id', b.id).select('id'));
            if (!saved || !saved.length) {
              load(st).catch(() => {});
              throw new Error('That birthday isn\'t on the list any more: someone may have deleted it.');
            }
          } else await q(core.sb.from('birthdays').insert(row).select('id'));
        } catch (err) {
          if (err && err.code === '23505') throw new Error(`${row.person_id ? v2.person(row.person_id).name : 'They'} already has a birthday on the list.`);
          throw err;
        }
        toast(b ? 'Saved' : `Added ${row.name}'s birthday`);
        await load(st);
      },
    });
  }

  async function render(main, ctx) {
    const st = { main, ctx, rows: [], failed: false, admin: isAdmin(), today: dates.today() };
    main.innerHTML = '<div class="loading">Loading…</div>';
    main.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !main.contains(btn)) return;
      const b = btn.dataset.id ? st.rows.find((x) => x.id === btn.dataset.id) : null;
      switch (btn.dataset.act) {
        case 'add': if (st.admin) openItem(st, null); break;
        case 'edit': if (st.admin && b) openItem(st, b); break;
        case 'retry': load(st); break;
        default: break;
      }
    }, { signal: ctx.signal });
    await load(st);
  }

  HomeHub.register({
    name: 'birthdays',
    schema: { min: 40, max: 99 },
    nav: { label: 'Birthdays', order: 61 },
    match(parts) { return parts[0] === 'birthdays' && parts.length === 1 ? {} : null; },
    render,
  });
})();
