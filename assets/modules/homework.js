/* =====================================================================
   HOME HUB — Homework (schema 5): plans, focus sessions and points
   #/homework, and #/homework/<assignment id> for one assignment or lesson
   (docs/v1.3-homework.md §9.1, §9.2, §4, §5, §8). The AI parts (Send to
   Claude, the drafts, the AI switch) come with PR B; nothing here
   mentions the AI.
   - The kid line: his points and his homework time; a kid picker with two
     kids or more.
   - First visit (parents): homework on for a kid, his homework time
     (prefilled Mon–Thu 4:30–5:15), then three rewards in three sizes.
   - Then, in this order, each left out when empty: To approve (his asks,
     with his balance and where this week's points came from; his
     suggestions to price), To check (milestones he ticked: Looks done with
     an optional note, Not yet with one), To talk about (milestones his
     steps can't reach), Questions and notes (open questions with Answer;
     every answer and coach's note of the last 7 days, earlier ones in
     qa_log too, with who and when), Assignments and lessons (+ Assignment,
     + Lesson; Done (30 days) folded), This week (the week strip with busy
     titles, focused minutes, pace, his blocks), Points and rewards (Give
     points, Void, the rewards), Switches (homework on, points and their
     values, homework time, Pat's links, Erase).
   - An assignment: its fields (the teacher's text keeps its lines), Mark
     done, Drop, Delete, Copy to next week (a lesson); the plan editor
     (assets/plan.js, role 'family'); its questions, answers and notes;
     its blocks. A due date moved here places again the steps it leaves
     behind (save_homework_plan with their days left out).
   - Reads on open, on focus and after each write; nothing else polls.
   Only the parents change anything (the database refuses Sam anyway): Sam
   sees it all with no buttons. Dates are the household's (core.v2).
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const { core } = HomeHub;
  const { q, toast, friendly, firstName, wireFormDialog, formDialog, detailDialog } = core;
  const { esc, plural } = core.G;
  const { v2 } = core;
  const { fmt, dates } = v2;
  const P = window.HomePlan;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LEN = P.LIMITS;
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];   // ISO weekday 1..7

  // The kid on screen, kept while the app is open (as Today keeps whose day).
  let chosen = null;

  const ICON = {
    diamond: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/></svg>',
    dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  };

  // ============================================
  // HELPERS
  // ============================================
  const sb = () => core.sb;
  const isAdmin = () => !!(core.me && core.me.role === 'admin');
  const myEmail = () => String((core.me && core.me.email) || '').toLowerCase();
  const sum = (rows, f) => rows.reduce((n, r) => n + (Number(f(r)) || 0), 0);
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const signed = (n) => (n < 0 ? `−${-n}` : `+${n}`);

  // The household's date of an instant (its time zone, never the device's).
  function householdDate(instant) {
    if (!instant) return '';
    const o = {};
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: (v2.household && v2.household.tz) || (v2.clock && v2.clock.tz) || 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)).forEach((p) => { o[p.type] = p.value; });
    } catch (e) { return ''; }
    return o.year ? `${o.year}-${o.month}-${o.day}` : '';
  }
  // The instant of the household's clock (its date and time), for the editor's "given since" day.
  function clockInstant() {
    const c = v2.clock || {};
    const tz = (v2.household && v2.household.tz) || c.tz || 'America/New_York';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.local_date || '')) return null;
    const [h, m] = String(c.local_time || '12:00').split(':').map(Number);
    const want = Date.UTC(+c.local_date.slice(0, 4), +c.local_date.slice(5, 7) - 1, +c.local_date.slice(8, 10), h || 0, m || 0);
    let t = want;
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      for (let i = 0; i < 3; i++) {
        const o = {};
        f.formatToParts(new Date(t)).forEach((p) => { o[p.type] = p.value; });
        t += want - Date.UTC(+o.year, +o.month - 1, +o.day, o.hour === '24' ? 0 : +o.hour, +o.minute);
      }
    } catch (e) { return null; }
    return new Date(t).toISOString();
  }
  const asOf = () => { const c = v2.clock || {}; return `${c.local_date || dates.today()}T${String(c.local_time || '12:00').slice(0, 5)}`; };

  // 'today', 'yesterday', 'Wed', 'Fri Nov 13': a household day next to today.
  const rel = (st, day) => P.fmt.rel(day, st.today, 'en');
  // 'yesterday 6:10pm': an instant, in the household's day and time.
  const when = (st, ts) => `${rel(st, householdDate(ts))} ${fmt.time(ts)}`.trim();
  // '4:30–5:15pm', '11:30am–1:00pm'
  function timeRange(start, end) {
    const a = P.fmt.time(start, 'en');
    const b = P.fmt.time(end, 'en');
    if (!b) return a;
    return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -2)}–${b}` : `${a}–${b}`;
  }
  // [1, 2, 3, 4] → 'Mon–Thu'; [1, 3] → 'Mon, Wed'
  function weekdays(list) {
    const days = [...new Set((list || []).map(Number).filter((d) => d >= 1 && d <= 7))].sort((x, y) => x - y);
    const runs = [];
    days.forEach((d) => { const r = runs[runs.length - 1]; if (r && r[1] === d - 1) r[1] = d; else runs.push([d, d]); });
    return runs.map(([a, b]) => (b - a >= 2 ? `${WD[a - 1]}–${WD[b - 1]}` : b > a ? `${WD[a - 1]}, ${WD[b - 1]}` : WD[a - 1])).join(', ');
  }

  // Who wrote something, as the parents read it: a tutor link's label, his first name, "you", a parent's first name.
  function whoName(by) {
    const s = String(by || '');
    let m = /^(.*) \(tutor link\)$/.exec(s);
    if (m) return m[1];
    m = /^(.*) \(My day\)$/.exec(s);
    if (m) return firstName(m[1]);
    if (!s) return '';
    if (s.toLowerCase() === myEmail()) return 'you';
    const p = v2.people().find((x) => String(x.email || '').toLowerCase() === s.toLowerCase());
    return p ? firstName(p.name) : 'a parent';
  }
  const viaLink = (by) => / \(tutor link\)$/.test(String(by || ''));
  const kidName = (st) => { const p = v2.person(st.kid); return p ? firstName(p.name) : 'him'; };
  // The tutor's first name: the first word of his first link's label (the parents read the links); for
  // Sam, from what a link wrote; else null ("the tutor").
  function tutorFirst(st) {
    const label = (st.links.find((l) => l.active) || st.links[0] || {}).label
      || ((st.steps.map((s) => s.checked_by || s.answer_by).concat(st.assignments.map((a) => a.given_by)).find(viaLink) || '').replace(/ \(tutor link\)$/, ''));
    return label ? String(label).split(/[\s,]+/)[0] : null;
  }

  // What the database said, in words: its own message for the homework rules, else the core's.
  function hwError(err) {
    if (err && ['42501', '22023', 'P0001', '54000'].includes(err.code) && err.message) return err.message;
    return friendly(err);
  }
  // A supabase-js answer's data, or its error thrown.
  async function run(promise) {
    const { data, error } = await promise;
    if (error) throw error;
    return data;
  }

  // ============================================
  // READING
  // ============================================
  const A_COLS = 'id,kid_id,kind,added_by,title,subject,due_date,details,stretch,status,done_at,given_at,given_by,plan_rev,created_at,created_by,updated_at,updated_by';

  // His week from today, 56 days (the editor's day picker, the bars' time left, the strip). Never throws.
  async function readWeek(kid, today) {
    try {
      const rows = await run(sb().rpc('homework_week', { p_kid: kid, p_from: today, p_days: 56 }));
      return { rows: Array.isArray(rows) ? rows : [], failed: false };
    } catch (err) { return { rows: [], failed: true }; }
  }

  async function load(st) {
    const today = dates.today();
    // An assignment's address opens it whoever's it is: its kid becomes the one on screen.
    const [kids, times, links, owner] = await Promise.all([
      q(sb().from('homework_kids').select('*')),
      q(sb().from('homework_times').select('event_id,kid_id')),
      isAdmin() ? q(sb().from('tutor_links').select('*').order('created_at')) : Promise.resolve([]),
      st.params.id && !st.loaded ? q(sb().from('assignments').select('kid_id').eq('id', st.params.id)) : Promise.resolve([]),
    ]);
    if (owner && owner[0]) chosen = owner[0].kid_id;
    const order = (id) => { const p = v2.person(id); return p ? [Number(p.sort_order) || 0, p.name] : [1e9, '']; };
    const known = (kids || []).filter((k) => v2.person(k.kid_id)).sort((a, b) => {
      const x = order(a.kid_id);
      const y = order(b.kid_id);
      return x[0] - y[0] || String(x[1]).localeCompare(String(y[1]));
    });
    if (!known.some((k) => k.kid_id === chosen)) chosen = (known.find((k) => k.active) || known[0] || {}).kid_id || null;
    const kid = chosen;
    const fresh = { today, kids: known, kid, row: known.find((k) => k.kid_id === kid) || null, times: (times || []).filter((t) => t.kid_id === kid),
      links: (links || []).filter((l) => l.kid_id === kid), events: [], assignments: [], steps: [], sessions: [], ledger: [], rewards: [], asks: [],
      week: [], weekFailed: false };
    if (kid) {
      const ids = fresh.times.map((t) => t.event_id);
      const [events, assignments, sessions, ledger, rewards, asks, week] = await Promise.all([
        ids.length ? q(sb().from('events').select('id,title,start_date,start_time,end_time,repeat,repeat_weekdays,repeat_until').in('id', ids)) : Promise.resolve([]),
        q(sb().from('assignments').select(A_COLS).eq('kid_id', kid).order('due_date')),
        q(sb().from('focus_sessions').select('*').eq('kid_id', kid).order('started_at', { ascending: false })),
        q(sb().from('points_ledger').select('*').eq('kid_id', kid).order('at', { ascending: false })),
        q(sb().from('rewards').select('*').eq('kid_id', kid).order('sort_order').order('cost')),
        q(sb().from('reward_asks').select('*').eq('kid_id', kid).order('asked_at', { ascending: false })),
        readWeek(kid, today),
      ]);
      const aIds = (assignments || []).map((a) => a.id);
      const steps = aIds.length ? await q(sb().from('homework_steps').select('*').in('assignment_id', aIds).order('pos')) : [];
      Object.assign(fresh, { events: events || [], assignments: assignments || [], steps: steps || [], sessions: sessions || [], ledger: ledger || [],
        rewards: rewards || [], asks: asks || [], week: week.rows, weekFailed: week.failed });
    }
    Object.assign(st, fresh, { loaded: true, failed: false });
  }

  // Read again and draw: after each write and on focus. A failed read keeps what is on screen.
  async function reload(st, quiet) {
    try {
      await load(st);
    } catch (err) {
      if (st.ctx.stale()) return;
      st.failed = !st.loaded;
      if (!quiet) toast(friendly(err), { error: true });
    }
    if (!st.ctx.stale()) draw(st);
  }

  // ============================================
  // WHAT THE ROWS SAY
  // ============================================
  const stepsOf = (st, id) => st.steps.filter((s) => s.assignment_id === id).sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
  const assignmentOf = (st, id) => st.assignments.find((a) => a.id === id) || null;
  const balance = (st) => sum(st.ledger, (l) => l.delta);
  const mondayOf = (day) => dates.mondayOf(day);
  // His assignments on the page: open ones, and done or dropped ones of the last 30 days.
  const recent = (st, a) => a.status === 'open' || (a.status === 'done' ? householdDate(a.done_at) || a.due_date : householdDate(a.updated_at)) >= dates.addDays(st.today, -30);

  // "this week: +31 focus and on time, +20 milestones checked by Pat" (Mon–Sun), for the trade lines.
  function weekSources(st) {
    const mon = mondayOf(st.today);
    const rows = st.ledger.filter((l) => l.day >= mon && l.day <= dates.addDays(mon, 6));
    const focus = sum(rows.filter((l) => l.kind === 'focus' || l.kind === 'on_time'), (l) => l.delta);
    const ms = rows.filter((l) => l.kind === 'milestone');
    const given = sum(rows.filter((l) => l.kind === 'given'), (l) => l.delta);
    const voided = sum(rows.filter((l) => l.kind === 'void'), (l) => l.delta);
    const by = [...new Set(ms.map((l) => (viaLink(l.who) ? String(whoName(l.who)).split(/[\s,]+/)[0] : whoName(l.who))))];
    const parts = [];
    if (focus) parts.push(`${signed(focus)} focus and on time`);
    if (ms.length) parts.push(`${signed(sum(ms, (l) => l.delta))} milestones checked${by.length ? ` by ${by.join(' and ')}` : ''}`);
    if (given) parts.push(`${signed(given)} given`);
    if (voided) parts.push(`${signed(voided)} voided`);
    return parts.length ? `this week: ${parts.join(', ')}` : 'nothing earned this week';
  }

  // His homework time, from its events: 'Mon–Thu 4:30–5:15pm, Sun 5:00–5:45pm'.
  function timesText(st) {
    const evs = st.events.filter((e) => e.start_time).map((e) => ({ e, first: e.repeat === 'weekly' ? Math.min(...(e.repeat_weekdays || [8])) : 9 }))
      .sort((a, b) => a.first - b.first || String(a.e.start_time).localeCompare(String(b.e.start_time)));
    return evs.map(({ e }) => `${e.repeat === 'weekly' ? weekdays(e.repeat_weekdays) : fmt.day(e.start_date)} ${timeRange(e.start_time, e.end_time)}`).join(', ');
  }

  // A milestone his steps can't reach any more: its day has passed, or a step before it is planned after it.
  function talkAbout(st) {
    const out = [];
    st.assignments.filter((a) => a.status === 'open' && a.given_at).forEach((a) => {
      const steps = stepsOf(st, a.id);
      steps.filter((m) => m.kind === 'milestone' && !m.done_at && (m.day < st.today
        || steps.some((y) => !y.done_at && y.kind !== 'milestone' && y.pos < m.pos && y.day > m.day))).forEach((m) => out.push({ a, m }));
    });
    return out.sort((x, y) => (x.m.day < y.m.day ? -1 : x.m.day > y.m.day ? 1 : x.a.due_date < y.a.due_date ? -1 : 1));
  }

  // Every answer and coach's note of the last 7 days, and the open questions, with who and when.
  function qaItems(st) {
    const since = dates.addDays(st.today, -7);
    const tutor = tutorFirst(st);
    const items = [];
    const shown = st.assignments.filter((a) => recent(st, a));
    const noteBy = (s, by, author) => {
      if (by === 'tutor') return `${tutor ? `${tutor}'s` : 'The tutor\'s'} note`;
      const name = author && !viaLink(author) && !/\(My day\)$/.test(author) ? whoName(author) : '';
      return name === 'you' ? 'Your note' : name && name !== 'a parent' ? `${name}'s note` : 'A parent\'s note';
    };
    shown.forEach((a) => stepsOf(st, a.id).forEach((s) => {
      if (s.question && !s.answer) {
        items.push({ kind: 'question', a, s, at: s.question_at, open: true,
          line: `${a.title} · “${s.question}” · asked ${when(st, s.question_at)}` });
      }
      if (s.answer && householdDate(s.answer_at) >= since) {
        items.push({ kind: 'answer', a, s, at: s.answer_at, current: true,
          mine: String(s.answer_by || '').toLowerCase() === myEmail() && Date.parse(s.answer_at) > Date.parse(clockInstant() || 0) - 15 * 60000,
          line: `${a.title} · Answered by ${whoName(s.answer_by)} · ${when(st, s.answer_at)}: “${s.answer}”` });
      }
      if (s.coach_note && householdDate(s.coach_note_at) >= since) {
        items.push({ kind: 'note', a, s, at: s.coach_note_at, current: true,
          line: `${a.title} · ${noteBy(s, s.coach_note_by, s.checked_at && s.coach_note_at === s.checked_at ? s.checked_by : s.updated_by)} on ${s.title} · ${when(st, s.coach_note_at)}: “${s.coach_note}”` });
      }
      (Array.isArray(s.qa_log) ? s.qa_log : []).forEach((e) => {
        const tail = e.cleared_at ? '(cleared)' : '(earlier)';
        if (e && e.answer && e.answered_at && householdDate(e.answered_at) >= since) {
          items.push({ kind: 'log', a, s, at: e.answered_at, line: `${a.title} · Answered by ${whoName(e.answered_by) || (e.by === 'tutor' ? tutor || 'the tutor' : 'a parent')} · ${when(st, e.answered_at)}: “${e.answer}” ${tail}` });
        } else if (e && e.note && e.at && householdDate(e.at) >= since) {
          items.push({ kind: 'log', a, s, at: e.at, line: `${a.title} · ${noteBy(s, e.by, null)} on ${s.title} · ${when(st, e.at)}: “${e.note}” ${tail}` });
        }
      });
    }));
    const t = (x) => Date.parse(x.at) || 0;
    return items.sort((x, y) => (y.open ? 1 : 0) - (x.open ? 1 : 0) || (x.open ? t(x) - t(y) : t(y) - t(x)));
  }

  // His blocks, as one line: 'Tue 4:35pm · 20 min · with Pat · Step done · Find 2 sources'.
  const RESULT = { done: 'Step done', more: 'More to do', stopped: 'Stopped', expired: 'Not answered' };
  function blockLine(st, b, absolute) {
    const day = householdDate(b.started_at);
    const step = b.step_id ? st.steps.find((s) => s.id === b.step_id) : null;
    const a = b.assignment_id ? assignmentOf(st, b.assignment_id) : null;
    const tutor = tutorFirst(st);
    const bits = [`${absolute ? fmt.day(day) : cap(rel(st, day))} ${fmt.time(b.started_at)}`, `${b.minutes} min`];
    if (b.with_whom === 'tutor') bits.push(`with ${tutor || 'the tutor'}`);
    else if (b.with_whom === 'parent') bits.push('with a parent');
    bits.push(b.ended_at ? RESULT[b.result] || b.result : 'Running now');
    if (step || a) bits.push((step || a).title);
    return `${bits.join(' · ')}${b.note ? ` · “${b.note}”` : ''}`;
  }

  // Pace (§5.5): the median of worked ÷ planned minutes over his last 10 done steps that had blocks,
  // to 0.1, kept between 0.5 and 3; null with fewer than 5 (as private.homework_pace).
  function pace(st) {
    const worked = new Map();
    st.sessions.filter((b) => b.ended_at && b.step_id).forEach((b) => worked.set(b.step_id, (worked.get(b.step_id) || 0) + (Number(b.seen_minutes) || 0)));
    const rows = st.steps.filter((s) => s.done_at && worked.get(s.id) > 0)
      .sort((a, b) => Date.parse(b.done_at) - Date.parse(a.done_at) || (a.id < b.id ? -1 : 1)).slice(0, 10).map((s) => worked.get(s.id) / s.minutes)
      .sort((a, b) => a - b);
    if (rows.length < 5) return null;
    const mid = (rows.length - 1) / 2;
    const m = (rows[Math.floor(mid)] + rows[Math.ceil(mid)]) / 2;
    return Math.min(3, Math.max(0.5, Math.round(m * 10) / 10));
  }

  // The editor's assignment (plan.js fromRows), with who gave it as the parents name them.
  function editorAssignment(st, id) {
    const row = assignmentOf(st, id);
    if (!row) return null;
    const a = P.fromRows(row, stepsOf(st, id), { week: st.week, today: st.today, asOf: asOf() });
    if (row.given_by && !viaLink(row.given_by) && !/\(My day\)$/.test(row.given_by)) a.given_by_name = whoName(row.given_by);
    return a;
  }

  // ============================================
  // DRAWING: the list
  // ============================================
  const heading = (text, count, extra) => `<h2 class="sec-head"><span>${esc(text)}</span>${count != null ? `<span class="sec-count">${esc(count)}</span>` : ''}${extra || ''}</h2>`;
  const section = (key, title, body, count, extra) => `<section class="hw-sec" data-sec="${key}" aria-label="${esc(title)}">${heading(title, count, extra)}${body}</section>`;
  const btn = (act, label, attrs, cls) => `<button type="button" class="btn btn-sm${cls ? ` ${cls}` : ''}" data-act="${act}"${attrs || ''}>${esc(label)}</button>`;

  // The inline note, answer or price form under a row, while it is open.
  function inlineForm(st, key) {
    const f = st.form;
    if (!f || f.key !== key) return '';
    const spec = {
      decline: ['A word for him (optional)', 'Not now', LEN.note, 'text'],
      check: ['Say what\'s good about it (optional)', 'Looks done', LEN.note, 'text'],
      not_yet: ['Say what\'s missing', 'Not yet', LEN.note, 'text'],
      answer: ['Your answer', 'Answer', LEN.answer, 'text'],
      price: ['Points it costs', 'Save', null, 'number'],
    }[f.action];
    if (f.action === 'price') {
      return `<form class="hw-price" data-key="${esc(key)}" novalidate autocomplete="off"><label class="field"><span>${esc(spec[0])}</span>`
        + `<input type="number" name="cost" min="1" max="10000" step="1" inputmode="numeric" value="${esc(f.text || '')}" enterkeyhint="done"></label>`
        + `<p class="form-error" role="alert" hidden></p><div class="form-actions"><button type="button" class="btn" data-act="cancel-note">Cancel</button>`
        + `<button type="submit" class="btn btn-primary">${esc(spec[1])}</button></div></form>`;
    }
    return `<form class="hw-note" data-key="${esc(key)}" novalidate autocomplete="off"><label class="field"><span>${esc(spec[0])}</span>`
      + `<input type="text" name="text" maxlength="${spec[2]}" value="${esc(f.text || '')}" enterkeyhint="send"></label>`
      + `<p class="form-error" role="alert" hidden></p><div class="form-actions"><button type="button" class="btn" data-act="cancel-note">Cancel</button>`
      + `<button type="submit" class="btn btn-primary">${esc(spec[1])}</button></div></form>`;
  }

  function approveHTML(st) {
    const admin = isAdmin();
    const kid = kidName(st);
    const asks = st.asks.filter((x) => x.status === 'waiting');
    const sugg = st.rewards.filter((r) => r.suggested && r.cost == null);
    if (!asks.length && !sugg.length) return '';
    const bal = balance(st);
    const src = weekSources(st);
    const rows = asks.map((x) => `<li class="hw-row hw-ask" data-ask="${esc(x.id)}">
        <div class="hw-row-main"><span class="hw-ask-line">${esc(`${x.title} · ${x.cost} · asked ${rel(st, householdDate(x.asked_at))} · balance ${bal} (${src})`)}</span></div>
        ${admin ? `<div class="hw-row-acts">${btn('yes', 'Yes', ` data-ask="${esc(x.id)}"`, 'btn-primary')}${btn('not-now', 'Not now', ` data-ask="${esc(x.id)}"`)}</div>` : ''}
        ${inlineForm(st, `ask:${x.id}`)}</li>`)
      .concat(sugg.map((r) => `<li class="hw-row hw-sugg" data-reward="${esc(r.id)}">
        <div class="hw-row-main"><span class="hw-sugg-line">${esc(`Suggested by ${kid}: “${r.title}”`)}</span></div>
        ${admin ? `<div class="hw-row-acts">${btn('price', 'Price it', ` data-reward="${esc(r.id)}"`)}${btn('delete-reward', 'Delete', ` data-reward="${esc(r.id)}"`)}</div>` : ''}
        ${inlineForm(st, `price:${r.id}`)}</li>`));
    return section('approve', 'To approve', `<ul class="hw-card hw-rows">${rows.join('')}</ul>`, asks.length + sugg.length);
  }

  function checkHTML(st) {
    const admin = isAdmin();
    const rows = [];
    st.assignments.filter((a) => recent(st, a)).forEach((a) => stepsOf(st, a.id).filter((s) => s.kind === 'milestone' && s.done_at && !s.checked_at)
      .forEach((s) => rows.push({ a, s })));
    if (!rows.length) return '';
    rows.sort((x, y) => Date.parse(x.s.done_at) - Date.parse(y.s.done_at));
    return section('check', 'To check', `<ul class="hw-card hw-rows">${rows.map(({ a, s }) => `<li class="hw-row hw-check" data-step="${esc(s.id)}">
        <div class="hw-row-main"><span class="hw-check-line"><span class="hw-diamond">${ICON.diamond}</span>${esc(`${s.title} · ${a.title} · ticked ${rel(st, householdDate(s.done_at))}`)}</span>
        ${s.done_looks_like ? `<small class="hw-row-sub">${esc(`Done looks like: ${s.done_looks_like}`)}</small>` : ''}</div>
        ${admin ? `<div class="hw-row-acts">${btn('looks-done', 'Looks done', ` data-step="${esc(s.id)}"`, 'btn-primary')}${btn('not-yet', 'Not yet', ` data-step="${esc(s.id)}"`)}</div>` : ''}
        ${inlineForm(st, `step:${s.id}`)}</li>`).join('')}</ul>`, rows.length);
  }

  function talkHTML(st) {
    const rows = talkAbout(st);
    if (!rows.length) return '';
    return section('talk', 'To talk about', `<ul class="hw-card hw-rows">${rows.map(({ a, m }) => `<li class="hw-row"><a class="hw-talk" href="#/homework/${esc(a.id)}">`
      + `${esc(`${a.title} · “${m.title}” was planned for ${rel(st, m.day)} · Re-plan didn't reach it`)} <span aria-hidden="true">›</span></a></li>`).join('')}</ul>`, rows.length);
  }

  function qaHTML(st) {
    const admin = isAdmin();
    const items = qaItems(st);
    if (!items.length) return '';
    const open = items.filter((x) => x.open).length;
    return section('qa', 'Questions and notes', `<ul class="hw-card hw-rows">${items.map((x) => {
      let acts = '';
      if (admin && x.open) acts = btn('answer', 'Answer', ` data-step="${esc(x.s.id)}"`, 'btn-primary');
      else if (admin && x.kind === 'answer') acts = `${x.mine ? btn('change', 'Change', ` data-step="${esc(x.s.id)}"`) : ''}${btn('clear', 'Clear', ` data-step="${esc(x.s.id)}" data-which="answer"`)}`;
      else if (admin && x.kind === 'note') acts = btn('clear', 'Clear', ` data-step="${esc(x.s.id)}" data-which="note"`);
      return `<li class="hw-row hw-qa-item${x.open ? ' hw-q' : ''}" data-step="${esc(x.s.id)}"><div class="hw-row-main"><span class="hw-qa-line">${esc(x.line)}</span></div>`
        + `${acts ? `<div class="hw-row-acts">${acts}</div>` : ''}${x.open || x.kind === 'answer' ? inlineForm(st, `step:${x.s.id}`) : ''}</li>`;
    }).join('')}</ul>`, open || null);
  }

  // One assignment's row: title, its line, and its state; its two bars when its plan is given.
  function assignmentRow(st, a) {
    const steps = stepsOf(st, a.id);
    const tutor = tutorFirst(st);
    const sub = [a.subject];
    if (a.kind === 'lesson') sub.push('lesson');
    sub.push(`${a.kind === 'lesson' ? 'do by' : 'due'} ${rel(st, a.due_date)}`);
    if (a.added_by === 'kid') sub.push(`added by ${kidName(st)}`);
    else if (a.added_by === 'tutor') sub.push(`added by ${tutor || 'the tutor'}`);
    let state;
    if (a.status !== 'open') state = a.status === 'done' ? 'Done' : 'Dropped';
    else if (!steps.length) state = 'No plan yet ›';
    else if (!a.given_at) state = 'Plan not given yet ›';
    else if (/\(My day\)$/.test(a.given_by || '')) state = `Quick · ${sum(steps, (s) => s.minutes)} min`;
    else state = `${steps.filter((s) => s.done_at).length} of ${steps.length} · Given by ${whoName(a.given_by)}`;
    let bars = '';
    if (a.status === 'open' && a.given_at && !st.weekFailed) {
      const ed = editorAssignment(st, a.id);
      bars = P.bars(ed.minutes_left, ed.time_left, { lang: 'en', horizon: ed.horizon, no_time: ed.no_time });
    }
    return `<li><a class="hw-arow" href="#/homework/${esc(a.id)}"><span class="hw-arow-title">${esc(a.title)}</span>`
      + `<span class="hw-arow-sub">${esc(sub.filter(Boolean).join(' · '))}</span><span class="hw-arow-state">${esc(state)}</span></a>${bars}</li>`;
  }

  function assignmentsHTML(st) {
    const admin = isAdmin();
    const open = st.assignments.filter((a) => a.status === 'open').sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
    const closed = st.assignments.filter((a) => a.status !== 'open' && recent(st, a));
    const adds = admin ? `<span class="hw-adds">${btn('add-assignment', '+ Assignment')}${btn('add-lesson', '+ Lesson')}</span>` : '';
    const body = `${open.length ? `<ul class="hw-card hw-arows">${open.map((a) => assignmentRow(st, a)).join('')}</ul>`
      : `<p class="hw-card empty-line hw-empty">No assignments or lessons yet.${admin ? ' Add one, or he can write one down on his My day.' : ''}</p>`}`
      + `${closed.length ? `<details class="hw-done"><summary>Done (30 days)</summary><ul class="hw-card hw-arows">${closed.map((a) => assignmentRow(st, a)).join('')}</ul></details>` : ''}`;
    return section('assignments', 'Assignments and lessons', body, null, adds);
  }

  function weekHTML(st) {
    const mon = mondayOf(st.today);
    const inWeek = (b, from) => { const d = householdDate(b.started_at); return d >= from && d <= dates.addDays(from, 6); };
    const seen = (rows) => sum(rows.filter((b) => b.ended_at), (b) => b.seen_minutes);
    const thisWeek = st.sessions.filter((b) => inWeek(b, mon));
    const focused = P.focused({ focused: seen(thisWeek), last_week: seen(st.sessions.filter((b) => inWeek(b, dates.addDays(mon, -7)))) }, 'en');
    const p = P.pace(pace(st), 'en');
    const strip = st.weekFailed
      ? `<p class="hw-fail" role="status">This week couldn't be loaded. <button type="button" class="linkbtn hw-retry" data-act="retry">Try again</button></p>`
      : P.week(st.week, { today: st.today, lang: 'en', titles: true });
    const blocks = thisWeek.slice().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    return section('week', 'This week', `${strip}<p class="hw-focused">${esc([focused, p].filter(Boolean).join(' · '))}</p>`
      + `${blocks.length ? `<ul class="hw-card hw-blocks">${blocks.map((b) => `<li>${b.assignment_id ? `<a href="#/homework/${esc(b.assignment_id)}">${esc(blockLine(st, b))} <span aria-hidden="true">›</span></a>`
        : esc(blockLine(st, b))}</li>`).join('')}</ul>` : ''}`);
  }

  const LEDGER = { focus: 'Focus', on_time: 'On time', milestone: 'Checked', given: 'Given' };
  function ledgerLine(st, l) {
    const what = l.kind === 'void' ? `Void: ${l.note || ''}` : l.kind === 'trade' ? l.note || 'Trade' : [LEDGER[l.kind], l.note].filter(Boolean).join(l.kind === 'milestone' ? ': ' : ' · ');
    return `${signed(l.delta)} ${what} · ${rel(st, l.day)}`;
  }

  function pointsHTML(st) {
    const admin = isAdmin();
    const k = st.row;
    const kid = kidName(st);
    if (!k.points_on) {
      return section('points', 'Points and rewards', `<p class="hw-card empty-line hw-empty">Points are off for ${esc(kid)}: nothing is earned, and his My day shows no points or rewards.${admin ? ' Turn them on under Switches.' : ''}</p>`);
    }
    const mon = mondayOf(st.today);
    const today = sum(st.ledger.filter((l) => l.day === st.today && (l.kind === 'focus' || l.kind === 'on_time')), (l) => l.delta);
    const ms = sum(st.ledger.filter((l) => l.kind === 'milestone' && l.day >= mon && l.day <= dates.addDays(mon, 6)), (l) => l.delta);
    const line = `${balance(st)} · today ${signed(today)} of ${k.pts_day_cap} · milestones this week ${ms} of ${k.pts_milestone_week}`;
    const acts = admin ? `<span class="hw-adds">${btn('give', 'Give points')}${btn('add-reward', '+ Reward')}</span>` : '';
    const rewards = st.rewards.filter((r) => r.cost != null);
    const voided = new Set(st.ledger.filter((l) => l.kind === 'void').map((l) => l.void_of));
    const last = st.ledger.slice(0, 10);
    return section('points', 'Points and rewards', `<p class="hw-points-line">${esc(line)}</p>`
      + `${rewards.length ? `<ul class="hw-card hw-rows hw-rewards">${rewards.map((r) => `<li class="hw-row${r.active ? '' : ' is-off'}"><div class="hw-row-main">`
        + `<span class="hw-rw-line">${esc(`${r.title} · ${r.cost}${r.active ? '' : ' · off'}`)}</span></div>`
        + `${admin ? `<div class="hw-row-acts"><button type="button" class="hw-more" data-act="edit-reward" data-reward="${esc(r.id)}" aria-label="${esc(`Edit ${r.title}`)}">${ICON.dots}</button></div>` : ''}</li>`).join('')}</ul>`
        : `<p class="hw-card empty-line hw-empty">No rewards yet.${admin ? ' Add one he can afford most homework days (about 15), one about once a week (about 60) and a bigger one (about 150).' : ''}</p>`}`
      + `${last.length ? `<h3 class="hw-sub">Recent</h3><ul class="hw-card hw-rows hw-ledger">${last.map((l) => `<li class="hw-row"><div class="hw-row-main"><span class="hw-ledger-line">${esc(ledgerLine(st, l))}</span></div>`
        + `${admin && ['focus', 'on_time', 'milestone', 'given'].includes(l.kind) && !voided.has(l.id) ? `<div class="hw-row-acts">${btn('void', 'Void…', ` data-entry="${esc(l.id)}"`)}</div>` : ''}</li>`).join('')}</ul>` : ''}`, null, acts);
  }

  // ---------- Switches (§9.2)
  function timeFormHTML(prefill) {
    const days = prefill ? [1, 2, 3, 4] : [];
    return `<form class="hw-timeform" data-form="time" novalidate autocomplete="off">
      <div class="hw-chips" role="group" aria-label="Days">${WD.map((d, i) => `<button type="button" class="hw-chip" data-wd="${i + 1}" aria-pressed="${days.includes(i + 1)}">${d}</button>`).join('')}</div>
      <div class="field-row"><label class="field"><span>From</span><input type="time" name="from" value="${prefill ? '16:30' : ''}" step="300"></label>
      <label class="field"><span>To</span><input type="time" name="to" value="${prefill ? '17:15' : ''}" step="300"></label></div>
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions"><button type="submit" class="btn btn-primary">Add</button></div></form>`;
  }

  const linkUrl = (l) => new URL(`day.html?h=${encodeURIComponent(l.token)}`, location.href).href;
  function linkMessage(st, l) {
    const tutor = String(l.label).split(/[\s,]+/)[0];
    const kid = kidName(st);
    return l.language === 'es'
      ? `Hola, ${tutor}: esta es la página de tareas de ${kid}. Solo muestra su tarea. Ábrela en tu propio teléfono o computadora:\n${linkUrl(l)}`
      : `Hi ${tutor}, here is ${kid}'s homework page. It shows only his homework. Please open it on your own phone or computer:\n${linkUrl(l)}`;
  }
  function linkHTML(st, l) {
    const used = l.last_used_at ? `Last used ${cap(when(st, l.last_used_at))}` : 'Not used yet';
    const ended = l.expires_on < st.today;
    const meta = [l.language === 'es' ? 'Spanish' : 'English', l.active ? '' : 'Off', `${ended ? 'Ended' : 'Ends'} ${P.fmt.short(l.expires_on, 'en')}`, used].filter(Boolean).join(' · ');
    const msg = linkMessage(st, l);
    return `<li class="hw-link" data-link="${esc(l.id)}"><div class="hw-link-head"><b class="hw-link-label">${esc(l.label)}</b>
        <button type="button" class="hw-more" data-act="edit-link" data-link="${esc(l.id)}" aria-label="${esc(`Change ${l.label}`)}">${ICON.dots}</button></div>
      <p class="hw-link-meta">${esc(meta)}</p>
      <div class="hw-link-acts">
        <button type="button" class="btn btn-sm" data-act="copy-link" data-link="${esc(l.id)}">Copy</button>
        <a class="btn btn-sm" data-via="whatsapp" href="${esc(`https://wa.me/?text=${encodeURIComponent(msg)}`)}" target="_blank" rel="noopener">WhatsApp</a>
        <a class="btn btn-sm" data-via="sms" href="${esc(`sms:?&body=${encodeURIComponent(msg)}`)}">Text</a>
        <button type="button" class="btn btn-sm" data-act="new-token" data-link="${esc(l.id)}">New link</button>
        ${l.active ? btn('link-off', 'Off', ` data-link="${esc(l.id)}"`) : btn('link-on', 'On', ` data-link="${esc(l.id)}"`)}
        <button type="button" class="btn btn-sm" data-act="extend" data-link="${esc(l.id)}">Extend 180 days</button>
      </div>${st.form && st.form.key === `link:${l.id}` ? linkFormHTML(l) : ''}</li>`;
  }
  function linkFormHTML(l) {
    const x = l || { label: '', language: 'en' };
    return `<form class="hw-linkform" data-form="link" data-link="${esc(x.id || '')}" novalidate autocomplete="off">
      <div class="field-row"><label class="field"><span>Name</span><input type="text" name="label" maxlength="60" value="${esc(x.label)}" placeholder="Pat Lee, tutor"></label>
      <label class="field"><span>Language</span><select name="language"><option value="en"${x.language === 'es' ? '' : ' selected'}>English</option>
        <option value="es"${x.language === 'es' ? ' selected' : ''}>Spanish</option></select></label></div>
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions"><button type="button" class="btn" data-act="cancel-note">Cancel</button><button type="submit" class="btn btn-primary">${x.id ? 'Save' : 'Make the link'}</button></div></form>`;
  }

  function switchesHTML(st) {
    const admin = isAdmin();
    const k = st.row;
    const kid = kidName(st);
    const off = admin ? '' : ' disabled';
    const tutor = tutorFirst(st);
    const others = admin ? v2.people().filter((p) => p.active !== false && p.role === 'kid' && !st.kids.some((x) => x.kid_id === p.id)) : [];
    const values = [['pts_focus', 'Per 5 minutes of a block', 0, 5], ['pts_on_time', 'Starting on time', 0, 50], ['pts_milestone', 'A milestone checked', 0, 100],
      ['pts_day_cap', 'Most a day from blocks and on-time starts', 0, 300], ['pts_milestone_week', 'Most a week from milestones', 0, 400]];
    const rows = [];
    rows.push(`<div class="hw-switch-row" data-row="kid"><label class="hw-switch"><input type="checkbox" data-act="kid-on"${k.active ? ' checked' : ''}${off}><span>Homework for ${esc(kid)}</span></label>
      <small class="hw-switch-line">Homework on ${esc(kid)}'s My day, and ${esc(tutor ? `${tutor}'s` : 'the tutor\'s')} link. Off hides them; nothing is deleted.</small>
      ${others.map((p) => btn('turn-on', `Turn on homework for ${firstName(p.name)}`, ` data-kid="${esc(p.id)}"`)).join('')}</div>`);
    if (k.active) {
      rows.push(`<div class="hw-switch-row" data-row="points"><label class="hw-switch"><input type="checkbox" data-act="points-on"${k.points_on ? ' checked' : ''}${off}><span>Points</span></label>
        <small class="hw-switch-line">Points for on-time starts, focus blocks and checked milestones. Off: nothing is earned, and his My day shows no points.</small>
        ${admin && k.points_on ? `<form class="hw-values" data-form="values" novalidate autocomplete="off"><div class="hw-values-grid">${values.map(([name, label, lo, hi]) => `<label class="field"><span>${esc(label)}</span>`
          + `<input type="number" name="${name}" min="${lo}" max="${hi}" step="1" inputmode="numeric" value="${esc(k[name])}"></label>`).join('')}
          <label class="field"><span>Focus length offered first</span><select name="focus_minutes">${P.LENGTHS.map((m) => `<option value="${m}"${k.focus_minutes === m ? ' selected' : ''}>${m} min</option>`).join('')}</select></label></div>
          <p class="form-error" role="alert" hidden></p><div class="form-actions"><button type="submit" class="btn btn-primary">Save</button></div></form>`
        : k.points_on ? `<p class="hw-switch-line">${esc(values.map(([name, label]) => `${label}: ${k[name]}`).join(' · '))} · ${esc(`first length ${k.focus_minutes} min`)}</p>` : ''}</div>`);
      const times = timesText(st);
      rows.push(`<div class="hw-switch-row" data-row="time"><p class="hw-switch-title">Homework time</p>
        <small class="hw-switch-line">An ordinary repeating event in ${esc(kid)}'s name: change a day or skip one on the Calendar page. His steps are placed only in it, less his other events.</small>
        ${st.events.length ? `<ul class="hw-times">${st.events.slice().sort((a, b) => Math.min(...(a.repeat_weekdays || [8])) - Math.min(...(b.repeat_weekdays || [8]))).map((e) => `<li class="hw-time">
          <span>${esc(`${e.repeat === 'weekly' ? weekdays(e.repeat_weekdays) : fmt.day(e.start_date)} ${timeRange(e.start_time, e.end_time)}`)}</span>
          ${admin ? btn('change-time', 'Change', ` data-event="${esc(e.id)}"`) : ''}</li>`).join('')}</ul>` : `<p class="hw-switch-line">${esc(times || 'No homework time set')}</p>`}
        ${admin && st.events.length ? `<details class="hw-addtime"><summary>Add another time</summary>${timeFormHTML(false)}</details>` : ''}</div>`);
      if (admin) {
        rows.push(`<div class="hw-switch-row" data-row="links"><p class="hw-switch-title">Tutor links</p>
          <small class="hw-switch-line">A link with no sign-in that shows only ${esc(kid)}'s homework. Send it to the tutor; it ends after 180 days. New link stops the old one at once.</small>
          ${st.links.length ? `<ul class="hw-links">${st.links.map((l) => linkHTML(st, l)).join('')}</ul>` : ''}
          ${st.form && st.form.key === 'link:new' ? linkFormHTML(null) : st.links.length < 3 ? btn('add-link', '+ Tutor link') : ''}</div>`);
        rows.push(`<div class="hw-switch-row" data-row="erase">${btn('erase', `Erase ${kid}'s homework…`, '', 'btn-danger')}
          <small class="hw-switch-line">Deletes all of it, for good. His homework-time events stay on the calendar.</small></div>`);
      }
    }
    if (!admin) rows.push('<p class="hw-switch-note">Only parents can change these.</p>');
    return section('switches', 'Switches', `<div class="hw-card hw-switches">${rows.join('')}</div>`);
  }

  // The first visit: homework on, his homework time, three rewards (the parents).
  function setupHTML(st) {
    const admin = isAdmin();
    if (!st.kid) {
      if (!admin) return '<div class="hw-card hw-setup"><p>Homework isn\'t on for anyone yet. A parent turns it on here.</p></div>';
      const kids = v2.people().filter((p) => p.active !== false && p.role === 'kid');
      return `<div class="hw-card hw-setup"><h2 class="hw-setup-title">Get homework ready</h2>${kids.length
        ? `<p>Homework shows on a kid's My day: his next step, a focus timer and his points. Every grown-up who signs in sees it; only parents change it.</p>
          <div class="hw-setup-acts">${kids.map((p) => btn('turn-on', `Turn on homework for ${firstName(p.name)}`, ` data-kid="${esc(p.id)}"`, 'btn-primary')).join('')}</div>`
        : '<p>Homework is for kids on the family list. Add one on the Family page first.</p>'}</div>`;
    }
    if (!admin || !st.row.active) return '';
    const kid = kidName(st);
    const parts = [];
    if (!st.times.length) {
      parts.push(`<div class="hw-setup-step"><h3>${esc(kid)}'s homework time</h3><p>When he does homework. His steps are placed only in it, around his other events.</p>${timeFormHTML(true)}</div>`);
    } else if (st.row.points_on && !st.rewards.length) {
      const sizes = [[15, '15 minutes of extra game time', 'one he can afford most homework days'], [60, 'Choose Friday\'s dinner', 'about once a week'], [150, 'A new book', 'a bigger one']];
      parts.push(`<div class="hw-setup-step"><h3>Add 3 rewards</h3><p>What ${esc(kid)}'s points buy. He asks for one; a parent says yes.</p>
        <form class="hw-rewardsform" data-form="rewards" novalidate autocomplete="off"><div class="hw-rws">${sizes.map(([cost, eg, hint]) => `<div class="hw-rw">
          <label class="field"><span>${esc(cap(hint))}</span><input type="text" name="title" maxlength="60" placeholder="${esc(eg)}"></label>
          <label class="field hw-rw-cost"><span>Points</span><input type="number" name="cost" min="1" max="10000" step="1" inputmode="numeric" value="${cost}"></label></div>`).join('')}</div>
          <p class="form-error" role="alert" hidden></p><div class="form-actions"><button type="submit" class="btn btn-primary">Add rewards</button></div></form></div>`);
    }
    return parts.length ? `<div class="hw-card hw-setup"><h2 class="hw-setup-title">Get homework ready</h2>${parts.join('')}</div>` : '';
  }

  function kidLine(st) {
    if (!st.kid) return '';
    const kid = kidName(st);
    if (!st.row.active) return `<p class="hw-kidline">${esc(`Homework is off for ${kid}: no card on his My day, and the tutor's link doesn't work. Nothing is deleted.`)}</p>`;
    const times = timesText(st);
    const time = times ? `Homework time ${times}` : 'No homework time set';
    const bits = [kid].concat(st.row.points_on ? [`${balance(st)} points`] : []);
    return `<p class="hw-kidline">${esc(bits.join(' · '))} · ${isAdmin() ? `<button type="button" class="linkbtn hw-timelink" data-act="time">${esc(time)} <span aria-hidden="true">›</span></button>` : esc(time)}</p>`;
  }

  function drawList(st) {
    const main = st.main;
    const picker = st.kids.length > 1 ? `<label class="hw-kidpick"><span class="sr-only">Whose homework</span><select name="kid">${st.kids.map((k) => {
      const p = v2.person(k.kid_id);
      return `<option value="${esc(k.kid_id)}"${k.kid_id === st.kid ? ' selected' : ''}>${esc(firstName(p.name))}</option>`;
    }).join('')}</select></label>` : '';
    const head = `<div class="page-head hw-head"><div><h1>Homework</h1><p class="meta">Plans, focus sessions and points</p></div>${picker}</div>`;
    let body = '';
    if (st.failed) {
      body = '<p class="hw-fail" role="status">Homework couldn\'t be loaded. Check the connection. <button type="button" class="linkbtn hw-retry" data-act="retry">Try again</button></p>';
    } else if (st.kid && st.row.active) {
      body = [approveHTML(st), checkHTML(st), talkHTML(st), qaHTML(st), assignmentsHTML(st), weekHTML(st), pointsHTML(st), switchesHTML(st)].join('');
    } else if (st.kid) {
      body = switchesHTML(st);
    }
    const y = window.scrollY;
    main.innerHTML = `<div class="hw-page">${head}${kidLine(st)}${st.failed ? '' : setupHTML(st)}${body}</div>`;
    if (window.scrollY !== y) window.scrollTo(window.scrollX, y);
    const input = st.form && main.querySelector(`form[data-key="${CSS.escape(st.form.key)}"] input, form[data-link] input[name="label"]`);
    if (input && st.form.focus) { input.focus(); st.form.focus = false; }
  }

  // ============================================
  // DRAWING: one assignment or lesson
  // ============================================
  function fieldsHTML(st, a) {
    const kid = kidName(st);
    const lesson = a.kind === 'lesson';
    const radio = (k, label) => `<label class="hw-radio"><input type="radio" name="kind" value="${k}"${a.kind === k ? ' checked' : ''}><span>${label}</span></label>`;
    return `<form class="form hw-afields${lesson ? ' is-lesson' : ''}" novalidate autocomplete="off">
      <fieldset class="hw-kinds"><legend>This is</legend>${radio('assignment', 'An assignment')}${radio('lesson', 'A lesson')}</fieldset>
      <label class="field"><span>Title</span><input type="text" name="title" maxlength="${LEN.assignment_title}" value="${esc(a.title)}" required></label>
      <div class="field-row"><label class="field"><span>Class</span><input type="text" name="subject" maxlength="${LEN.subject}" value="${esc(a.subject || '')}"></label>
      <label class="field"><span class="hw-if-assignment">Due</span><span class="hw-if-lesson">Do by</span><input type="date" name="due_date" value="${esc(a.due_date)}" required></label></div>
      <label class="field"><span class="hw-if-assignment">Teacher's text</span><span class="hw-if-lesson">${esc(`Instructions for ${kid}`)}</span>
        <textarea name="details" rows="8" maxlength="${LEN.details}">${esc(a.details || '')}</textarea>
        <small class="hw-livetext">To use a photo of the sheet, copy its text with your phone's Live Text and paste it here. Photos aren't sent anywhere.</small></label>
      <label class="field"><span>${esc(`An optional question for ${kid} (an interesting angle)`)}</span><input type="text" name="stretch" maxlength="${LEN.stretch}" value="${esc(a.stretch || '')}"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions"><button type="submit" class="btn btn-primary">Save</button></div></form>`;
  }

  function stepsReadOnly(st, a) {
    const steps = stepsOf(st, a.id);
    if (!steps.length) return '<p class="hw-card empty-line hw-empty">No plan yet.</p>';
    return `<ol class="hw-card hw-rows hw-steps-ro">${steps.map((s) => `<li class="hw-row${s.done_at ? ' is-done' : ''}"><div class="hw-row-main">`
      + `<span>${s.kind === 'milestone' ? `<span class="hw-diamond">${ICON.diamond}</span>` : ''}${esc(s.title)}</span>`
      + `<small class="hw-row-sub">${esc([fmt.day(s.day), `${s.minutes} min`, s.kind === 'step' ? '' : P.t(`tag_${s.kind}`, null, 'en'), s.done_at ? 'done' : '', s.checked_at ? 'checked' : ''].filter(Boolean).join(' · '))}</small></div></li>`).join('')}</ol>`;
  }

  // The steps' questions, answers and notes (qa_log too), with who and when.
  function stepQaHTML(st, a) {
    const admin = isAdmin();
    const kid = kidName(st);
    const tutor = tutorFirst(st);
    const items = [];
    stepsOf(st, a.id).forEach((s) => {
      const lines = [];
      (Array.isArray(s.qa_log) ? s.qa_log : []).forEach((e) => {
        if (e && e.question) lines.push(`${kid} asked: “${e.question}”${e.asked_at ? ` · ${fmt.day(householdDate(e.asked_at))}` : ''}`);
        if (e && e.answer) lines.push(`${cap(whoName(e.answered_by) || (e.by === 'tutor' ? tutor || 'the tutor' : 'a parent'))}: “${e.answer}”${e.cleared_at ? ' (cleared)' : ''}`);
        if (e && e.note) lines.push(`${e.by === 'tutor' ? tutor || 'The tutor' : 'A parent'}'s note: “${e.note}”${e.cleared_at ? ' (cleared)' : ''}`);
      });
      if (s.question) lines.push(`${kid} asked: “${s.question}”`);
      if (s.answer) lines.push(`${cap(whoName(s.answer_by))} · ${fmt.day(householdDate(s.answer_at))} ${fmt.time(s.answer_at)}: “${s.answer}”`);
      if (s.coach_note) lines.push(`${s.coach_note_by === 'tutor' ? tutor || 'The tutor' : 'A parent'}'s note · ${fmt.day(householdDate(s.coach_note_at))}: “${s.coach_note}”`);
      if (!lines.length) return;
      const ask = admin && s.question && !s.answer ? btn('answer', 'Answer', ` data-step="${esc(s.id)}"`, 'btn-primary') : '';
      items.push(`<li class="hw-row" data-step="${esc(s.id)}"><div class="hw-row-main"><span class="hw-qa-step">${esc(s.title)}</span>${lines.map((l) => `<small class="hw-row-sub">${esc(l)}</small>`).join('')}</div>`
        + `${ask ? `<div class="hw-row-acts">${ask}</div>` : ''}${inlineForm(st, `step:${s.id}`)}</li>`);
    });
    return items.length ? `<section class="hw-sec" aria-label="Questions and notes">${heading('Questions and notes')}<ul class="hw-card hw-rows hw-a-qa">${items.join('')}</ul></section>` : '';
  }

  function blocksHTML(st, a) {
    const blocks = st.sessions.filter((b) => b.assignment_id === a.id).sort((x, y) => Date.parse(y.started_at) - Date.parse(x.started_at));
    return blocks.length ? `<section class="hw-sec" aria-label="Focus blocks">${heading('Focus blocks', blocks.length)}<ul class="hw-card hw-blocks hw-a-blocks">${blocks.map((b) => `<li>${esc(blockLine(st, b, true))}</li>`).join('')}</ul></section>` : '';
  }

  function aMeta(st, a) {
    const tutor = tutorFirst(st);
    const bits = [a.subject, `${a.kind === 'lesson' ? 'do by' : 'due'} ${fmt.day(a.due_date)}`];
    if (a.added_by === 'kid') bits.push(`added by ${kidName(st)}`);
    else if (a.added_by === 'tutor') bits.push(`added by ${tutor || 'the tutor'}`);
    bits.push({ open: 'Open', done: 'Done', dropped: 'Dropped' }[a.status]);
    return bits.filter(Boolean).join(' · ');
  }

  // The assignment's page. The fields form and the editor are drawn once and kept while they have
  // changes; the rest is drawn again after each read.
  function drawAssignment(st) {
    const main = st.main;
    const id = st.params.id;
    const a = st.kid ? assignmentOf(st, id) : null;
    const admin = isAdmin();
    if (!a) {
      stopEditor(st);
      main.innerHTML = `<div class="hw-a"><a class="back" href="#/homework">‹ All homework</a><p class="hw-card empty-line hw-empty">${st.failed
        ? 'Homework couldn\'t be loaded. Check the connection, then reload.' : 'That assignment isn\'t on the list. It may have been deleted.'}</p></div>`;
      return;
    }
    const head = `<a class="back" href="#/homework">‹ All homework</a><header class="hw-a-head"><p class="eyebrow">${a.kind === 'lesson' ? 'Lesson' : 'Assignment'}</p>`
      + `<h1>${esc(a.title)}</h1><p class="meta hw-a-meta">${esc(aMeta(st, a))}</p></header>`;
    const status = admin ? `<div class="hw-a-acts">${a.status === 'open' ? btn('mark-done', 'Mark done') : btn('reopen', 'Open again')}`
      + `${a.status === 'dropped' ? '' : btn('drop', 'Drop')}${a.kind === 'lesson' ? btn('copy-week', 'Copy to next week') : ''}${btn('delete-assignment', 'Delete…', '', 'btn-danger')}</div>` : '';
    const ro = admin ? '' : `${a.details ? `<div class="hw-card hw-a-text">${esc(a.details)}</div>` : ''}${a.stretch ? `<p class="hw-a-stretch">${esc(`Optional: ${a.stretch}`)}</p>` : ''}`;
    let root = main.querySelector('.hw-a[data-id]');
    if (!root || root.dataset.id !== a.id) {
      stopEditor(st);
      main.innerHTML = `<div class="hw-a" data-id="${esc(a.id)}"><div data-ref="head"></div><div data-ref="fields"></div><div data-ref="status"></div>`
        + `<section class="hw-sec" aria-label="Plan">${heading('Plan')}<div class="hw-card hw-ed" data-ref="editor"></div></section><div data-ref="qa"></div><div data-ref="blocks"></div></div>`;
      root = main.querySelector('.hw-a');
      st.fieldsDirty = false;
    }
    root.querySelector('[data-ref="head"]').innerHTML = head;
    if (!st.fieldsDirty) root.querySelector('[data-ref="fields"]').innerHTML = admin ? fieldsHTML(st, a) : ro;
    root.querySelector('[data-ref="status"]').innerHTML = status;
    root.querySelector('[data-ref="qa"]').innerHTML = stepQaHTML(st, a);
    const input = st.form && st.form.focus && root.querySelector(`[data-ref="qa"] form[data-key="${CSS.escape(st.form.key)}"] input`);
    if (input) { input.focus(); st.form.focus = false; }
    root.querySelector('[data-ref="blocks"]').innerHTML = blocksHTML(st, a);
    const box = root.querySelector('[data-ref="editor"]');
    const ed = editorAssignment(st, a.id);
    const more = { today: st.today, asOf: asOf(), serverNow: clockInstant(), week: st.week, length: st.row.focus_minutes, kid: kidName(st), tutor: tutorFirst(st) };
    if (!admin) {
      box.innerHTML = stepsReadOnly(st, a);
    } else if (!st.editor) {
      st.editor = P.editor(box, Object.assign({
        role: 'family', lang: 'en', showDetails: false, toast,
        onGone: () => { if (!st.ctx.stale()) reload(st); },
        onSaved: () => { if (!st.ctx.stale()) drawAssignment(st); },
        api: {
          save: ({ steps, rev, give }) => planWrite(st, a.id, () => sb().rpc('save_homework_plan', { p_assignment: a.id, p_steps: steps, p_rev: rev, p_give: give })),
          reload: () => planWrite(st, a.id, null),
        },
      }, more));
      st.editor.set(ed);
    } else if (!st.editor.dirty()) {
      st.editor.set(ed, more);
    }
  }
  function stopEditor(st) {
    if (st.editor) st.editor.stop();
    st.editor = null;
  }

  // A plan write from the editor (or only a read, fn null), answered as the editor wants it:
  // { assignment } | { error } | { gone: true }.
  async function planWrite(st, id, fn) {
    if (fn) {
      let r;
      try { r = await fn(); } catch (err) { r = { error: err }; }
      if (r.error) return { error: r.error };
    }
    try { await load(st); } catch (err) { return { error: err }; }
    if (st.ctx.stale()) return { gone: true };
    const a = editorAssignment(st, id);
    return a ? { assignment: a } : { gone: true };
  }

  function draw(st) {
    if (st.ctx.stale()) return;
    if (st.params.id) drawAssignment(st);
    else { stopEditor(st); drawList(st); }
  }

  // ============================================
  // WRITES
  // ============================================
  // A write: the page is busy while it runs, then everything is read again. A refusal is said in a toast.
  function setBusy(st, on) {
    st.busy = on;
    const root = st.main.querySelector('.hw-page, .hw-a');
    if (root && on) root.setAttribute('aria-busy', 'true');
    else if (root) root.removeAttribute('aria-busy');
  }
  async function write(st, fn, done) {
    if (st.busy) return false;
    setBusy(st, true);
    let ok = true;
    try {
      await fn();
    } catch (err) {
      ok = false;
      if (!st.ctx.stale()) toast(hwError(err), { error: true });
    }
    if (st.ctx.stale()) return ok;
    if (ok) st.form = null;
    await reload(st, true);
    setBusy(st, false);
    if (ok && done) done();
    return ok;
  }

  // The settings on homework_kids, saved only if nobody changed them since they were read.
  async function saveKid(st, patch) {
    const rows = await q(sb().from('homework_kids').update(patch).eq('kid_id', st.kid).eq('updated_at', st.row.updated_at).select('kid_id'));
    if (!rows || !rows.length) {
      throw new Error('That wasn\'t saved: someone else changed it a moment ago, or only a parent can. Here it is now.');
    }
  }

  function turnOn(st, kidId) {
    chosen = kidId;
    write(st, () => run(sb().rpc('save_homework_kid', { p_kid: kidId, p_active: true })),
      () => toast(`Homework is on for ${firstName((v2.person(kidId) || {}).name || '')}`));
  }

  // The homework-time form: ISO weekdays (1 = Monday), from, to.
  function addTime(st, form) {
    const days = [...form.querySelectorAll('[data-wd][aria-pressed="true"]')].map((b) => Number(b.dataset.wd));
    const from = form.elements.from.value;
    const to = form.elements.to.value;
    const err = form.querySelector('.form-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (!days.length) return fail('Pick at least one day.');
    if (!/^\d{2}:\d{2}/.test(from) || !/^\d{2}:\d{2}/.test(to)) return fail('Pick when it starts and ends.');
    if (to <= from) return fail('Homework time ends after it starts.');
    return write(st, () => run(sb().rpc('add_homework_time', { p_kid: st.kid, p_weekdays: days, p_start: from.slice(0, 5), p_end: to.slice(0, 5) })),
      () => toast(`Homework time added: ${weekdays(days)} ${timeRange(from, to)}`));
  }

  function addRewards(st, form) {
    const err = form.querySelector('.form-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    const start = st.rewards.reduce((n, r) => Math.max(n, Number(r.sort_order) || 0), 0);
    const rows = [];
    for (const r of form.querySelectorAll('.hw-rw')) {
      const title = P.clean(r.querySelector('[name="title"]').value, 61);
      const cost = Number(r.querySelector('[name="cost"]').value);
      if (!title) continue;
      if (Array.from(title).length > 60) return fail('A reward\'s name is at most 60 characters.');
      if (!Number.isInteger(cost) || cost < 1 || cost > 10000) return fail('Each reward costs 1 to 10,000 points.');
      rows.push({ kid_id: st.kid, title, cost, active: true, sort_order: start + rows.length + 1 });
    }
    if (!rows.length) return fail('Name at least one reward.');
    return write(st, () => q(sb().from('rewards').insert(rows).select('id')), () => toast(`${plural(rows.length, 'reward')} added`));
  }

  function savePoints(st, form) {
    const f = form.elements;
    const err = form.querySelector('.form-error');
    const patch = {};
    const limits = { pts_focus: 5, pts_on_time: 50, pts_milestone: 100, pts_day_cap: 300, pts_milestone_week: 400 };
    for (const name of Object.keys(limits)) {
      const v = Number(f[name].value);
      if (!Number.isInteger(v) || v < 0 || v > limits[name]) { err.textContent = `Use a whole number from 0 to ${limits[name]}.`; err.hidden = false; f[name].focus(); return null; }
      patch[name] = v;
    }
    patch.focus_minutes = Number(f.focus_minutes.value);
    return write(st, () => saveKid(st, patch), () => toast('Saved'));
  }

  function decide(st, askId, approve, note) {
    const x = st.asks.find((a) => a.id === askId);
    return write(st, () => run(approve ? sb().rpc('decide_reward', { p_ask: askId, p_approve: true })
      : sb().rpc('decide_reward', { p_ask: askId, p_approve: false, p_note: note || null })),
      () => toast(approve ? `Yes: ${x ? x.title : 'the reward'} for ${kidName(st)}` : `Not now: ${x ? x.title : 'the reward'}`));
  }

  function stepAction(st, stepId, action, text) {
    const s = st.steps.find((x) => x.id === stepId);
    let answer = null;
    return write(st, async () => {
      answer = await run(sb().rpc('homework_step', { p_step: stepId, p_action: action, p_text: text == null || text === '' ? null : text }));
    }, () => {
      if (action === 'check') {
        toast(answer && answer.used_up ? 'This week\'s milestone points are used up.' : `Checked: ${s ? s.title : ''}`,
          { action: { label: 'Undo', onClick: () => stepAction(st, stepId, 'uncheck', null) } });
      } else if (action === 'not_yet') toast('Sent back with your note');
      else if (action === 'answer') toast('Answer sent');
      else if (action === 'clear') toast('Cleared. It stays in the step\'s history.');
    });
  }

  // The inline forms' submit: a note, an answer, a word with Not now, a price.
  function submitInline(st, form) {
    const f = st.form;
    if (!f) return;
    const err = form.querySelector('.form-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; const i = form.querySelector('input'); if (i) i.focus(); };
    if (f.action === 'price') {
      const cost = Number(form.elements.cost.value);
      if (!Number.isInteger(cost) || cost < 1 || cost > 10000) return fail('A price is 1 to 10,000 points.');
      return write(st, async () => {
        const rows = await q(sb().from('rewards').update({ cost, active: true }).eq('id', f.id).select('id'));
        if (!rows || !rows.length) throw new Error('That suggestion is gone.');
      }, () => toast('Priced. He can ask for it now.'));
    }
    const max = f.action === 'answer' ? LEN.answer : LEN.note;
    const text = P.clean(form.elements.text.value, max + 1);
    if (Array.from(text).length > max) return fail('That\'s too long.');
    if (f.action === 'not_yet' && !text) return fail('Say what\'s missing.');
    if (f.action === 'answer' && !text) return fail('Type the answer.');
    if (f.action === 'decline') return decide(st, f.id, false, text);
    return stepAction(st, f.id, f.action, text);
  }

  // ---------- Dialogs: an assignment or lesson, a reward, Give points, Void, Erase
  function openDialog(html) {
    wireFormDialog();
    if (detailDialog.open) detailDialog.close();
    formDialog.innerHTML = html;
    if (!formDialog.open) formDialog.showModal();
    return formDialog.querySelector('form');
  }
  const dialogTop = (title) => `<div class="d-top"><h3>${esc(title)}</h3><button type="button" class="d-close" data-close aria-label="Close">×</button></div>`;
  const dialogFoot = (label, extra) => `<p class="form-error" role="alert" hidden></p><div class="form-actions">${extra || ''}<button type="button" class="btn" data-close>Cancel</button>`
    + `<button type="submit" class="btn btn-primary">${esc(label)}</button></div>`;
  // Run a dialog's write: the dialog stays open (with the reason) when it fails.
  async function dialogWrite(st, form, fn, done) {
    const err = form.querySelector('.form-error');
    const submit = form.querySelector('[type="submit"]');
    err.hidden = true;
    submit.disabled = true;
    setBusy(st, true);
    try {
      await fn();
    } catch (e) {
      setBusy(st, false);
      submit.disabled = false;
      err.textContent = hwError(e);
      err.hidden = false;
      return;
    }
    formDialog.close();
    if (st.ctx.stale()) return;
    await reload(st, true);
    setBusy(st, false);
    if (done) done();
  }

  function newAssignment(st, kind) {
    const kid = kidName(st);
    const lesson = kind === 'lesson';
    const form = openDialog(`<form class="form d-inner hw-aform" novalidate autocomplete="off">${dialogTop(lesson ? 'New lesson' : 'New assignment')}
      <label class="field"><span>Title</span><input type="text" name="title" maxlength="${LEN.assignment_title}" placeholder="${lesson ? 'Fractions practice' : 'Science project: river poster'}"></label>
      <div class="field-row"><label class="field"><span>Class</span><input type="text" name="subject" maxlength="${LEN.subject}" placeholder="${lesson ? 'Math' : 'Science'}"></label>
      <label class="field"><span>${lesson ? 'Do by' : 'Due'}</span><input type="date" name="due_date" min="${esc(st.today)}"></label></div>
      <label class="field"><span>${esc(lesson ? `Instructions for ${kid}` : 'Teacher\'s text')}</span><textarea name="details" rows="6" maxlength="${LEN.details}"></textarea>
        <small class="hw-livetext">To use a photo of the sheet, copy its text with your phone's Live Text and paste it here. Photos aren't sent anywhere.</small></label>
      <label class="field"><span>${esc(`An optional question for ${kid} (an interesting angle)`)}</span><input type="text" name="stretch" maxlength="${LEN.stretch}"></label>
      ${dialogFoot('Add')}</form>`);
    const f = form.elements;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = form.querySelector('.form-error');
      const fail = (m, el) => { err.textContent = m; err.hidden = false; if (el) el.focus(); };
      const row = {
        kid_id: st.kid, kind: lesson ? 'lesson' : 'assignment', title: P.clean(f.title.value, LEN.assignment_title + 1),
        subject: P.clean(f.subject.value, LEN.subject + 1) || null, due_date: f.due_date.value,
        details: P.cleanBlock(f.details.value, LEN.details + 1) || null, stretch: P.clean(f.stretch.value, LEN.stretch + 1) || null,
      };
      if (!row.title) return fail('Give it a title.', f.title);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.due_date)) return fail(lesson ? 'Pick the day to do it by.' : 'Pick a due date.', f.due_date);
      if (Array.from(row.title).length > LEN.assignment_title || Array.from(row.subject || '').length > LEN.subject
        || Array.from(row.details || '').length > LEN.details || Array.from(row.stretch || '').length > LEN.stretch) return fail('That\'s too long.');
      let made = null;
      return dialogWrite(st, form, async () => { made = await q(sb().from('assignments').insert(row).select('id').single()); },
        () => { toast(`Added: ${row.title}`); if (made && made.id) location.hash = `#/homework/${made.id}`; });
    });
    if (window.innerWidth > 700) f.title.focus();
  }

  function rewardDialog(st, reward) {
    const r = reward || { title: '', cost: '', active: true };
    const form = openDialog(`<form class="form d-inner hw-reward" novalidate autocomplete="off">${dialogTop(reward ? reward.title : 'New reward')}
      <label class="field"><span>Reward</span><input type="text" name="title" maxlength="60" value="${esc(r.title)}" placeholder="Choose Friday's dinner"></label>
      <label class="field"><span>Points</span><input type="number" name="cost" min="1" max="10000" step="1" inputmode="numeric" value="${esc(r.cost == null ? '' : r.cost)}"></label>
      <label class="check"><input type="checkbox" name="active"${r.active ? ' checked' : ''}> On (he can ask for it)</label>
      ${dialogFoot('Save', reward ? '<button type="button" class="btn btn-danger left" data-act="delete-reward-now">Delete</button>' : '')}</form>`);
    const f = form.elements;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = form.querySelector('.form-error');
      const title = P.clean(f.title.value, 61);
      const cost = Number(f.cost.value);
      if (!title || Array.from(title).length > 60) { err.textContent = 'Name it, in at most 60 characters.'; err.hidden = false; return undefined; }
      if (!Number.isInteger(cost) || cost < 1 || cost > 10000) { err.textContent = 'It costs 1 to 10,000 points.'; err.hidden = false; return undefined; }
      const row = { title, cost, active: f.active.checked };
      if (reward) {
        const patch = {};
        Object.keys(row).forEach((k) => { if (row[k] !== reward[k]) patch[k] = row[k]; });
        if (!Object.keys(patch).length) { formDialog.close(); return undefined; }
        return dialogWrite(st, form, () => q(sb().from('rewards').update(patch).eq('id', reward.id).select('id')), () => toast('Saved'));
      }
      const next = st.rewards.reduce((n, x) => Math.max(n, Number(x.sort_order) || 0), 0) + 1;
      return dialogWrite(st, form, () => q(sb().from('rewards').insert({ kid_id: st.kid, title, cost, active: row.active, sort_order: next }).select('id')),
        () => toast(`Added: ${title}`));
    });
    const del = form.querySelector('[data-act="delete-reward-now"]');
    if (del) {
      del.addEventListener('click', () => {
        if (!window.confirm(`Delete ${reward.title}? His asks for it stay as they are.`)) return;
        dialogWrite(st, form, () => q(sb().from('rewards').delete().eq('id', reward.id)), () => toast(`Deleted ${reward.title}`));
      });
    }
  }

  function giveDialog(st) {
    const key = P.newId();   // the ledger row's id: a resend writes nothing more
    const form = openDialog(`<form class="form d-inner hw-give" novalidate autocomplete="off">${dialogTop(`Give ${kidName(st)} points`)}
      <p class="meta">For what the rules can't see, such as a phone that died mid-block. He sees the note.</p>
      <label class="field"><span>Points (1 to 200)</span><input type="number" name="points" min="1" max="200" step="1" inputmode="numeric"></label>
      <label class="field"><span>What for</span><input type="text" name="note" maxlength="120" placeholder="Great session with the tutor"></label>
      ${dialogFoot('Give')}</form>`);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = form.querySelector('.form-error');
      const points = Number(form.elements.points.value);
      const note = P.clean(form.elements.note.value, 121);
      if (!Number.isInteger(points) || points < 1 || points > 200) { err.textContent = 'Give 1 to 200 points.'; err.hidden = false; return; }
      if (!note) { err.textContent = 'Say what the points are for.'; err.hidden = false; return; }
      if (Array.from(note).length > 120) { err.textContent = 'That\'s too long.'; err.hidden = false; return; }
      dialogWrite(st, form, () => run(sb().rpc('give_points', { p_kid: st.kid, p_points: points, p_note: note, p_key: key })), () => toast(`+${points} for ${kidName(st)}`));
    });
  }

  function voidDialog(st, entry) {
    const l = st.ledger.find((x) => x.id === entry);
    if (!l) return;
    const form = openDialog(`<form class="form d-inner hw-void" novalidate autocomplete="off">${dialogTop('Void points')}
      <p class="meta">${esc(ledgerLine(st, l))}</p>
      <p class="meta">A correction, never a penalty: the same points come off, with your reason. He sees it.</p>
      <label class="field"><span>Why</span><input type="text" name="note" maxlength="120" placeholder="Block left running while away"></label>
      ${dialogFoot('Void')}</form>`);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = form.querySelector('.form-error');
      const note = P.clean(form.elements.note.value, 121);
      if (!note) { err.textContent = 'Say why.'; err.hidden = false; return; }
      if (Array.from(note).length > 120) { err.textContent = 'That\'s too long.'; err.hidden = false; return; }
      dialogWrite(st, form, () => run(sb().rpc('void_points', { p_entry: l.id, p_note: note })), () => toast('Voided'));
    });
  }

  function eraseDialog(st) {
    const kid = kidName(st);
    const form = openDialog(`<form class="form d-inner hw-erase" novalidate autocomplete="off">${dialogTop(`Erase ${kid}'s homework`)}
      <p>This deletes ${esc(kid)}'s assignments and lessons, their plans, questions, answers and notes, his focus blocks, points, rewards and asks, and the tutor's links, for good. His homework-time events stay on the calendar; delete them there if you want.</p>
      <label class="field"><span>Type ERASE to erase</span><input type="text" name="confirm" autocapitalize="characters" spellcheck="false"></label>
      ${dialogFoot('Erase')}</form>`);
    form.querySelector('[type="submit"]').classList.replace('btn-primary', 'btn-danger');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = form.querySelector('.form-error');
      if (form.elements.confirm.value !== 'ERASE') { err.textContent = 'Type ERASE to erase.'; err.hidden = false; return; }
      let counts = null;
      dialogWrite(st, form, async () => { counts = await run(sb().rpc('erase_homework', { p_kid: st.kid, p_confirm: 'ERASE' })); },
        () => toast(`Erased ${kid}'s homework${counts ? ` (${plural(counts.assignments || 0, 'assignment')} and ${plural(counts.sessions || 0, 'focus block')})` : ''}.`));
    });
  }

  // ---------- The tutor's links
  function saveLink(st, l, patch) {
    const x = Object.assign({ label: l.label, language: l.language, expires_on: l.expires_on, can_ai: l.can_ai, active: l.active }, patch);
    return write(st, () => run(sb().rpc('save_tutor_link', { p_link: l.id, p_kid: st.kid, p_label: x.label, p_language: x.language, p_expires_on: x.expires_on,
      p_can_ai: x.can_ai, p_active: x.active })), () => toast(patch.active === false ? `${l.label}: off` : patch.active ? `${l.label}: on` : 'Saved'));
  }
  async function copyLink(l) {
    const link = linkUrl(l);
    try {
      await navigator.clipboard.writeText(link);
      toast(`Copied ${l.label}'s link`);
    } catch (err) {
      window.prompt(`Copy ${l.label}'s link:`, link);
    }
  }
  function submitLink(st, form) {
    const id = form.dataset.link || null;
    const label = P.clean(form.elements.label.value, 61);
    const err = form.querySelector('.form-error');
    if (!label || Array.from(label).length > 60) { err.textContent = 'Name it, in at most 60 characters: "Pat Lee, tutor".'; err.hidden = false; return; }
    const language = form.elements.language.value === 'es' ? 'es' : 'en';
    const l = id ? st.links.find((x) => x.id === id) : null;
    if (l) { saveLink(st, l, { label, language }); return; }
    write(st, () => run(sb().rpc('save_tutor_link', { p_link: null, p_kid: st.kid, p_label: label, p_language: language, p_expires_on: null,
      p_can_ai: true, p_active: true })), () => toast(`Link made for ${label}. Send it with WhatsApp or Text.`));
  }

  // ---------- The assignment's own writes
  // Only the fields that changed; a due date moved places again the steps it leaves behind (§4.1).
  async function saveFields(st, form) {
    const a = assignmentOf(st, st.params.id);
    if (!a) return;
    const f = form.elements;
    const err = form.querySelector('.form-error');
    const fail = (m, el) => { err.textContent = m; err.hidden = false; if (el) el.focus(); };
    const next = {
      kind: f.kind.value === 'lesson' ? 'lesson' : 'assignment', title: P.clean(f.title.value, LEN.assignment_title + 1),
      subject: P.clean(f.subject.value, LEN.subject + 1) || null, due_date: f.due_date.value,
      details: P.cleanBlock(f.details.value, LEN.details + 1) || null, stretch: P.clean(f.stretch.value, LEN.stretch + 1) || null,
    };
    if (!next.title) return fail('Give it a title.', f.title);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.due_date)) return fail('Pick a due date.', f.due_date);
    if (Array.from(next.title).length > LEN.assignment_title || Array.from(next.subject || '').length > LEN.subject
      || Array.from(next.details || '').length > LEN.details || Array.from(next.stretch || '').length > LEN.stretch) return fail('That\'s too long.');
    const patch = {};
    Object.keys(next).forEach((k) => { if ((next[k] || null) !== (a[k] || null)) patch[k] = next[k]; });
    if (!Object.keys(patch).length) { st.fieldsDirty = false; toast('Nothing changed'); return; }
    let moved = 0;
    const ok = await write(st, async () => {
      const rows = await q(sb().from('assignments').update(patch).eq('id', a.id).select('id'));
      if (!rows || !rows.length) throw new Error('That wasn\'t saved: only a parent can change it, or it was deleted.');
      st.fieldsDirty = false;
      if (!('due_date' in patch) && !('kind' in patch)) return;
      // The steps not done that now fall after the last work day (or the turn-in off the due date) go
      // without a day, so the database places them again.
      const steps = stepsOf(st, a.id);
      const last = P.lastWorkDay(next.due_date, st.today, next.kind);
      const behind = (s) => !s.done_at && (s.kind === 'turn_in' ? s.day !== next.due_date : s.day > last || (s.day >= next.due_date && next.kind !== 'lesson'));
      if (!steps.some(behind)) return;
      const fresh = (await q(sb().from('assignments').select('plan_rev').eq('id', a.id)))[0];
      const list = steps.map((s) => ({ id: s.id, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like || null, minutes: s.minutes,
        day: behind(s) ? null : s.day, source: s.source }));
      moved = list.filter((s) => s.day === null).length;
      const { error } = await sb().rpc('save_homework_plan', { p_assignment: a.id, p_steps: list, p_rev: fresh ? fresh.plan_rev : a.plan_rev, p_give: false });
      if (error) {
        moved = 0;
        toast(`Saved, but the steps weren't placed again: ${hwError(error)}`, { error: true });
      }
    }, () => toast(moved ? `${plural(moved, 'step')} moved: due date changed` : 'Saved'));
    if (ok && st.editor && !st.editor.dirty()) st.editor.set(editorAssignment(st, a.id));
  }

  function setStatus(st, status) {
    const a = assignmentOf(st, st.params.id);
    if (!a) return;
    write(st, async () => {
      const rows = await q(sb().from('assignments').update({ status }).eq('id', a.id).select('id'));
      if (!rows || !rows.length) throw new Error('That wasn\'t saved: only a parent can change it, or it was deleted.');
    }, () => toast({ done: `Done: ${a.title}`, open: `Open again: ${a.title}`, dropped: `Dropped: ${a.title}` }[status]));
  }

  function deleteAssignment(st) {
    const a = assignmentOf(st, st.params.id);
    if (!a || !window.confirm(`Delete ${a.title}? Its plan, questions and notes go too. His blocks and points stay.`)) return;
    write(st, () => q(sb().from('assignments').delete().eq('id', a.id)), () => {
      toast(`Deleted ${a.title}`);
      location.hash = '#/homework';
    });
  }

  // A lesson again seven days later, with its plan (not given; the database places it).
  function copyWeek(st) {
    const a = assignmentOf(st, st.params.id);
    if (!a) return;
    const due = dates.addDays(a.due_date, 7);
    write(st, async () => {
      const made = await q(sb().from('assignments').insert({ kid_id: a.kid_id, kind: a.kind, title: a.title, subject: a.subject, due_date: due,
        details: a.details, stretch: a.stretch }).select('id').single());
      const steps = stepsOf(st, a.id).map((s) => ({ kind: s.kind, title: s.title, done_looks_like: s.done_looks_like || null, minutes: s.minutes, day: null, source: s.source }));
      if (made && steps.length) {
        const { error } = await sb().rpc('save_homework_plan', { p_assignment: made.id, p_steps: steps, p_rev: 0, p_give: false });
        if (error) toast(`Copied, but its plan wasn't: ${hwError(error)}`, { error: true });
      }
    }, () => toast(`Copied to next week: do by ${fmt.day(due)}`));
  }

  // ============================================
  // TAPS
  // ============================================
  function onClick(st, e) {
    const chip = e.target.closest('[data-wd]');
    if (chip && st.main.contains(chip)) { chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true')); return; }
    const act = e.target.closest('[data-act]');
    if (!act || !st.main.contains(act) || act.closest('[data-ref="editor"]')) return;
    const d = act.dataset;
    const open = (key, action, id, text) => { st.form = { key, action, id, text: text || '', focus: true }; draw(st); };
    switch (d.act) {
      case 'retry': reload(st); break;
      case 'turn-on': turnOn(st, d.kid); break;
      case 'time': {
        const row = st.main.querySelector('[data-row="time"]');
        if (row) { row.scrollIntoView({ block: 'start' }); const first = row.querySelector('button, input'); if (first) first.focus(); }
        break;
      }
      case 'yes': decide(st, d.ask, true); break;
      case 'not-now': open(`ask:${d.ask}`, 'decline', d.ask); break;
      case 'price': open(`price:${d.reward}`, 'price', d.reward); break;
      case 'delete-reward': {
        const r = st.rewards.find((x) => x.id === d.reward);
        if (r && window.confirm(`Delete ${kidName(st)}'s suggestion "${r.title}"?`)) write(st, () => q(sb().from('rewards').delete().eq('id', r.id)), () => toast('Deleted'));
        break;
      }
      case 'looks-done': open(`step:${d.step}`, 'check', d.step); break;
      case 'not-yet': open(`step:${d.step}`, 'not_yet', d.step); break;
      case 'answer': open(`step:${d.step}`, 'answer', d.step); break;
      case 'change': { const s = st.steps.find((x) => x.id === d.step); open(`step:${d.step}`, 'answer', d.step, s ? s.answer : ''); break; }
      case 'clear': stepAction(st, d.step, 'clear', d.which); break;
      case 'cancel-note': st.form = null; draw(st); break;
      case 'add-assignment': newAssignment(st, 'assignment'); break;
      case 'add-lesson': newAssignment(st, 'lesson'); break;
      case 'give': giveDialog(st); break;
      case 'void': voidDialog(st, d.entry); break;
      case 'add-reward': rewardDialog(st, null); break;
      case 'edit-reward': rewardDialog(st, st.rewards.find((r) => r.id === d.reward)); break;
      case 'change-time': {
        let openForm;
        try { openForm = core.use('calendar').openEventForm; } catch (err) { toast(friendly(err), { error: true }); break; }
        Promise.resolve(openForm({ id: d.event, onSaved: () => { if (!st.ctx.stale()) reload(st); } })).catch((err) => toast(friendly(err), { error: true }));
        break;
      }
      case 'copy-link': { const l = st.links.find((x) => x.id === d.link); if (l) copyLink(l); break; }
      case 'new-token': {
        const l = st.links.find((x) => x.id === d.link);
        if (!l || !window.confirm(`Make a new link for ${l.label}? The old link stops working right away, so send the new one.`)) break;
        write(st, () => run(sb().rpc('new_tutor_token', { p_link: l.id })), () => toast(`New link made. Send it to ${l.label}.`));
        break;
      }
      case 'link-off': case 'link-on': { const l = st.links.find((x) => x.id === d.link); if (l) saveLink(st, l, { active: d.act === 'link-on' }); break; }
      case 'extend': {
        const l = st.links.find((x) => x.id === d.link);
        if (!l) break;
        const from = l.expires_on > st.today ? l.expires_on : st.today;
        const end = dates.addDays(from, 180);
        const most = dates.addDays(st.today, 400);
        saveLink(st, l, { expires_on: end < most ? end : most });
        break;
      }
      case 'edit-link': open(`link:${d.link}`, 'link', d.link); break;
      case 'add-link': open('link:new', 'link', null); break;
      case 'erase': eraseDialog(st); break;
      case 'mark-done': setStatus(st, 'done'); break;
      case 'reopen': setStatus(st, 'open'); break;
      case 'drop': setStatus(st, 'dropped'); break;
      case 'delete-assignment': deleteAssignment(st); break;
      case 'copy-week': copyWeek(st); break;
      default:
    }
  }

  function onSubmit(st, e) {
    const form = e.target;
    if (!st.main.contains(form) || form.closest('[data-ref="editor"]')) return;
    e.preventDefault();
    if (st.busy) return;
    if (form.classList.contains('hw-note') || form.classList.contains('hw-price')) submitInline(st, form);
    else if (form.dataset.form === 'time') addTime(st, form);
    else if (form.dataset.form === 'rewards') addRewards(st, form);
    else if (form.dataset.form === 'values') savePoints(st, form);
    else if (form.dataset.form === 'link') submitLink(st, form);
    else if (form.classList.contains('hw-afields')) saveFields(st, form);
  }

  // ============================================
  // THE PAGE
  // ============================================
  async function renderHomework(main, ctx) {
    const st = { main, ctx, params: ctx.params, today: dates.today(), kids: [], kid: null, row: null, times: [], links: [], events: [], assignments: [], steps: [],
      sessions: [], ledger: [], rewards: [], asks: [], week: [], weekFailed: false, loaded: false, failed: false, busy: false, form: null, editor: null, fieldsDirty: false };
    ctx.signal.addEventListener('abort', () => stopEditor(st));
    main.innerHTML = '<p class="loading">Loading…</p>';
    main.addEventListener('click', (e) => onClick(st, e), { signal: ctx.signal });
    main.addEventListener('submit', (e) => onSubmit(st, e), { signal: ctx.signal });
    main.addEventListener('input', (e) => {
      const x = e.target;
      if (x.closest('[data-ref="editor"]')) return;
      if (st.form && x.closest('form.hw-note, form.hw-price')) st.form.text = x.value;
      if (x.closest('form.hw-afields')) {
        st.fieldsDirty = true;
        if (x.name === 'kind') x.closest('form').classList.toggle('is-lesson', x.value === 'lesson');
      }
    }, { signal: ctx.signal });
    main.addEventListener('change', (e) => {
      const x = e.target;
      if (x.closest('[data-ref="editor"]')) return;
      if (x.name === 'kid' && x.tagName === 'SELECT') { chosen = x.value; st.form = null; reload(st); return; }
      if (x.dataset.act === 'kid-on') { write(st, () => run(sb().rpc('save_homework_kid', { p_kid: st.kid, p_active: x.checked })), () => toast(x.checked ? `Homework is on for ${kidName(st)}` : `Homework is off for ${kidName(st)}`)); return; }
      if (x.dataset.act === 'points-on') { write(st, () => saveKid(st, { points_on: x.checked }), () => toast(x.checked ? 'Points are on' : 'Points are off')); return; }
      if (x.closest('form.hw-afields')) st.fieldsDirty = true;
    }, { signal: ctx.signal });
    // On focus: read again, unless something is being typed.
    window.addEventListener('focus', () => {
      if (ctx.stale() || st.busy || st.fieldsDirty || (st.form && st.form.text) || (st.editor && st.editor.dirty())) return;
      reload(st, true);
    }, { signal: ctx.signal });
    await reload(st);
  }

  HomeHub.register({
    name: 'homework',
    schema: { min: 5, max: 99 },
    nav: { label: 'Homework', order: 37 },
    // #/homework · #/homework/<assignment id>
    match(parts) {
      if (parts[0] !== 'homework' || parts.length > 2) return null;
      if (parts.length === 2 && !UUID.test(parts[1])) return null;
      return { id: parts[1] ? parts[1].toLowerCase() : null };
    },
    render: renderHomework,
  });
})();
