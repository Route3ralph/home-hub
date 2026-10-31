/* =====================================================================
   HOME HUB — Homework (schema 5): plans, focus sessions and points
   #/homework, and #/homework/<assignment id> for one assignment or lesson
   (docs/v1.3-homework.md §9.1, §9.2, §4, §5, §8). The AI parts (PR B,
   §6, §9.2, §9.4), for the parents only: the AI planner's row on the
   switches card (what is sent and kept, Test the AI planner, Words never
   to send, the switch once a Test answered Working, this month's runs and
   their estimated cost, the key's state from the last run) and a tutor
   link's Can ask the AI; on an assignment, plan.js's What Claude will
   see (homework_ai_preview), Send to Claude (hub-jobs' homework_ai, with
   the parent's sign-in), the draft and its Use this plan, Undo and Dismiss
   (homework_ai_draft) and Ask again.
   - The kid line: his points and his homework time; a kid picker with two
     kids or more.
   - First visit (parents): homework on for a kid, his homework time
     (prefilled Mon–Thu 4:30–5:15), then three rewards in three sizes (an
     instant one he cashes on the spot, about 15; one a week, about 200; a
     bigger one, about 500).
   - Then, in this order, each left out when empty: To approve (his asks,
     with his balance and where this week's points came from; his
     suggestions to price), To check (milestones he ticked: Looks done with
     an optional note, Not yet with one), To talk about (milestones his
     steps can't reach), Questions and notes (open questions with Answer;
     every answer and coach's note of the last 7 days, earlier ones in
     qa_log too, with who and when), Assignments and lessons (+ Assignment,
     + Lesson; Done (30 days) folded), This week (the week strip with busy
     titles, focused minutes, pace, his blocks), Points and rewards (Give
     points, Void, the rewards, instant or not; his instant cash-ins in
     Recent), Switches (homework on, points and their values, his instant
     rewards a day, homework time, Pat's links, Erase).
   - An assignment: its fields (the teacher's text keeps its lines), Mark
     done, Drop, Delete, Copy to next week (a lesson); the plan editor
     (assets/plan.js, role 'family'); its questions, answers and notes;
     its blocks. A due date moved here places again the steps it leaves
     behind (save_homework_plan with their days left out).
   - From 0006 (schema 6; §11, §12), the School links row of the switches,
     for the parents: the school's Blackbaud calendar links (Assignments,
     Schedule, Games/Practices), each with its status (the host and "…a1b2",
     last read, items, the last read's stop in words, stale), Add link /
     Replace / Pause / Remove, Check now, the first-import check (Looks
     right, Use the first date, One day off), what is new for him (Add to
     homework, Hide), what he hid (Show), moved and gone assignments, and the
     plain how-to-copy steps. A link goes to the database once and never
     comes back: no answer carries it, and the page keeps no copy of it.
     Assignments made from school say "from school", and when the school
     moved or took one off its site.
   - Reads on open, on focus and after each write; nothing else polls,
     but the AI parts: every 5 seconds while a run is open on the
     assignment shown (one assignments row), and every 2 seconds while a
     Test runs (its ai_runs row), each until the run's lease ends.
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
  const A_COLS = 'id,kid_id,kind,added_by,title,subject,due_date,details,stretch,status,done_at,given_at,given_by,plan_rev,created_at,created_by,updated_at,updated_by,'
    + 'ai_state,ai_stop,ai_draft,ai_prev,ai_at';
  // The AI's runs (PR B), the parents' only: this month's and any still open; and the last Test, whenever it was.
  const RUN_COLS = 'id,kind,status,stop,model,asked_by,assignment_id,link_id,started_at,lease_until,finished_at,cents';

  // Every row a read matches, page by page. The API answers at most its "Max rows" (Supabase's Settings
  // → API, 1,000 unless changed) and cuts the rest without an error, and his points ledger is never
  // trimmed (his balance is the sum of all of it). build() makes the read afresh, ordered oldest first
  // and ending in a unique column, so a row written between two pages lands on the last one; pages until
  // one comes back empty (or brings nothing new), whatever the cap is. (today.js has the same.)
  async function readAll(build) {
    const out = [];
    const seen = new Set();
    for (let from = 0; ;) {
      const page = (await q(build().range(from, from + 999))) || [];
      const fresh = page.filter((r) => !seen.has(r.id));
      if (!fresh.length) return out;
      fresh.forEach((r) => { seen.add(r.id); out.push(r); });
      from += page.length;
    }
  }

  // His week from today, 56 days (the editor's day picker, the bars' time left, the strip). Never throws.
  async function readWeek(kid, today) {
    try {
      const rows = await run(sb().rpc('homework_week', { p_kid: kid, p_from: today, p_days: 56 }));
      return { rows: Array.isArray(rows) ? rows : [], failed: false };
    } catch (err) { return { rows: [], failed: true }; }
  }

  // ---------- School links (0006, schema 6; docs/v1.3-homework.md §11, §12.8)
  // school_feed_status(p_kid) → { kid_id, last_run_at, feeds: [{ id, kind, host, url_end, checked, date_rule, date_shift,
  // paused, last_try_at, last_ok_at, last_count, last_repeats, last_stop, fails, next_at, stale }], check: [the first-import
  // check's items], new: [what is new for him], hidden: [what he hid], moved: [{ assignment_id, title, from, to }], gone:
  // [{ assignment_id, title, due_date }] }: never the address. The writes are the parents': set_school_feed (Add link,
  // Replace; null is Remove), check_school_feed, pause_school_feed, school_item_action, and Check now (hub-jobs' school).
  const FEEDS = [
    ['assignments', 'Assignments', (kid) => `${kid}'s assignments, as homework marked "from school"`],
    ['schedule', 'Schedule', () => 'His classes, as busy time'],
    ['games', 'Games/Practices', () => 'Games and practices, as busy time'],
  ];
  const FEED_LABEL = Object.fromEntries(FEEDS.map(([f, label]) => [f, label]));
  const objs = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []);
  // The status as the page uses it (null, for a kid the database doesn't know, reads as nothing added).
  function schoolStatus(v) {
    const o = v && typeof v === 'object' ? v : {};
    return { last_run_at: o.last_run_at || null, feeds: objs(o.feeds).filter((f) => FEED_LABEL[f.kind] && typeof f.id === 'string'), check: objs(o.check),
      new: objs(o.new), hidden: objs(o.hidden), moved: objs(o.moved), gone: objs(o.gone) };
  }
  const feedOf = (st, kind) => (st.school ? st.school.feeds.find((f) => f.kind === kind) || null : null);
  // The parents' status of his school links: { status, failed }. Never throws; nothing on schema 5 or for Sam.
  async function readSchool(kid) {
    if (!(core.schemaVersion >= 6) || !isAdmin()) return { status: null, failed: false };
    try {
      return { status: schoolStatus(await run(sb().rpc('school_feed_status', { p_kid: kid }))), failed: false };
    } catch (err) { return { status: null, failed: true }; }
  }

  // 0007 (§20.5): the coach's notes on his tutor links, for the parents on schema 7: { notes, failed }. Never throws.
  async function readCoachNotes(links) {
    if (!(core.schemaVersion >= 7) || !isAdmin() || !links.length) return { notes: [], failed: false };
    try {
      return { notes: (await q(sb().from('coach_notes').select('*').in('link_id', links.map((l) => l.id)).order('created_at', { ascending: false }).order('id'))) || [],
        failed: false };
    } catch (err) { return { notes: [], failed: true }; }
  }

  async function load(st) {
    const today = dates.today();
    // An assignment's address opens it whoever's it is: its kid becomes the one on screen.
    const [kids, times, links, owner, house, runs, tests] = await Promise.all([
      q(sb().from('homework_kids').select('*')),
      q(sb().from('homework_times').select('event_id,kid_id')),
      isAdmin() ? q(sb().from('tutor_links').select('*').order('created_at')) : Promise.resolve([]),
      st.params.id && !st.loaded ? q(sb().from('assignments').select('kid_id').eq('id', st.params.id)) : Promise.resolve([]),
      isAdmin() ? q(sb().from('household').select('*').limit(1)) : Promise.resolve([]),
      isAdmin() ? q(sb().from('ai_runs').select(RUN_COLS).or(`started_at.gte.${today.slice(0, 8)}01,status.eq.running`).order('started_at', { ascending: false }))
        : Promise.resolve([]),
      isAdmin() ? q(sb().from('ai_runs').select(RUN_COLS).eq('kind', 'test').order('started_at', { ascending: false }).limit(1)) : Promise.resolve([]),
    ]);
    st.household = (house || [])[0] || null;
    st.aiRuns = runs || [];
    st.lastTest = (tests || [])[0] || null;
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
      week: [], weekFailed: false, school: null, schoolFailed: false, coachNotes: [], coachFailed: false };
    if (kid) {
      const ids = fresh.times.map((t) => t.event_id);
      const [events, assignments, sessions, ledger, rewards, asks, week, school, coach] = await Promise.all([
        ids.length ? q(sb().from('events').select('id,title,start_date,start_time,end_time,repeat,repeat_weekdays,repeat_until').in('id', ids)) : Promise.resolve([]),
        q(sb().from('assignments').select(A_COLS).eq('kid_id', kid).order('due_date')),
        q(sb().from('focus_sessions').select('*').eq('kid_id', kid).order('started_at', { ascending: false })),
        // All of his rows (the balance is their sum), shown newest first.
        readAll(() => sb().from('points_ledger').select('*').eq('kid_id', kid).order('at').order('id')).then((rows) => rows.reverse()),
        q(sb().from('rewards').select('*').eq('kid_id', kid).order('sort_order').order('cost')),
        q(sb().from('reward_asks').select('*').eq('kid_id', kid).order('asked_at', { ascending: false })),
        readWeek(kid, today),
        readSchool(kid),
        readCoachNotes(fresh.links),
      ]);
      const aIds = (assignments || []).map((a) => a.id);
      const steps = aIds.length ? await q(sb().from('homework_steps').select('*').in('assignment_id', aIds).order('pos')) : [];
      Object.assign(fresh, { events: events || [], assignments: assignments || [], steps: steps || [], sessions: sessions || [], ledger: ledger || [],
        rewards: rewards || [], asks: asks || [], week: week.rows, weekFailed: week.failed, school: school.status, schoolFailed: school.failed,
        coachNotes: coach.notes, coachFailed: coach.failed });
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

  // "this week: +31 focus and on time, +20 milestones ticked, +20 milestones checked by Pat" (Mon–Sun), for the
  // trade lines: a milestone pays half at his tick and the rest at the check.
  function weekSources(st) {
    const mon = mondayOf(st.today);
    const rows = st.ledger.filter((l) => l.day >= mon && l.day <= dates.addDays(mon, 6));
    const focus = sum(rows.filter((l) => l.kind === 'focus' || l.kind === 'on_time'), (l) => l.delta);
    const ticked = sum(rows.filter((l) => l.kind === 'milestone_done'), (l) => l.delta);
    const ms = rows.filter((l) => l.kind === 'milestone');
    const given = sum(rows.filter((l) => l.kind === 'given'), (l) => l.delta);
    const voided = sum(rows.filter((l) => l.kind === 'void'), (l) => l.delta);
    const by = [...new Set(ms.map((l) => (viaLink(l.who) ? String(whoName(l.who)).split(/[\s,]+/)[0] : whoName(l.who))))];
    const parts = [];
    if (focus) parts.push(`${signed(focus)} focus and on time`);
    if (ticked) parts.push(`${signed(ticked)} milestones ticked`);
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
  const RESULT = { done: 'Step done', more: 'More to do', stopped: 'Stopped', time: 'Time\'s up (no answer yet)', expired: 'Not answered' };
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
    a.ai = aiOf(st, row, true);
    return a;
  }

  // ============================================
  // THE AI PLANNER (PR B, docs/v1.3-homework.md §6), the parents only
  // ============================================
  // An assignment's AI state, as plan.js's editor takes it: { state, stop, draft, prev, at }, or null. A run still
  // 'running' whose lease has passed reads as failed with 'timeout' (as both token views read it), when the runs read
  // with the row say so.
  function aiOf(st, row, withRuns) {
    if (!row || (!row.ai_state && !row.ai_draft)) return null;
    let state = row.ai_state;
    let stop = row.ai_stop;
    if (withRuns && state === 'running') {
      const now = Date.parse(clockInstant() || '') || Date.now();
      const open = st.aiRuns.some((r) => r.assignment_id === row.id && r.status === 'running' && Date.parse(r.lease_until) >= now);
      if (!open && st.aiRuns.some((r) => r.assignment_id === row.id)) { state = 'failed'; stop = 'timeout'; }
    }
    return { state, stop, draft: row.ai_draft || null, prev: row.ai_prev || null, at: row.ai_at || null };
  }
  // The device's mark of what was last sent for an assignment (the preview's fold), in localStorage when it works.
  const SENT = {
    get: (id) => { try { return localStorage.getItem(`hh.ai.sent.${id}`); } catch (e) { return null; } },
    set: (id, mark) => { try { localStorage.setItem(`hh.ai.sent.${id}`, mark); } catch (e) { /* no storage: always open */ } },
  };
  const aiOn = (st) => !!(st.household && st.household.homework_ai);
  // hub-jobs' homework_ai, with the parent's sign-in: { run_id } | { stop, run_id? } | { error }.
  // An answer that isn't a 2xx (a database error, no service key, 0005 not applied) is its stop, never "Can't reach
  // Home Hub": only a request that got no answer is offline (P.aiFailure).
  async function invokeAi(body) {
    const r = await sb().functions.invoke('hub-jobs', { body: Object.assign({ action: 'homework_ai' }, body) });
    if (r.error) {
      const stop = await P.aiFailure(r.error);
      return stop === 'offline' ? { error: r.error } : { stop };
    }
    return r.data && typeof r.data === 'object' ? r.data : { error: { message: 'No answer.' } };
  }
  // plan.js's editor's AI parts for one assignment, or null (Sam, or the AI off with nothing to show).
  function aiOpts(st, row) {
    if (!isAdmin() || !row || !st.row || !st.row.active) return null;
    if (!aiOn(st) && !row.ai_draft && !row.ai_state) return null;
    const id = row.id;
    const fresh = async () => {
      const rows = await q(sb().from('assignments').select(A_COLS).eq('id', id));
      const x = rows && rows[0];
      if (!x) return { gone: true };
      const i = st.assignments.findIndex((y) => y.id === id);
      if (i >= 0) st.assignments[i] = Object.assign({}, st.assignments[i], { ai_state: x.ai_state, ai_stop: x.ai_stop, ai_draft: x.ai_draft, ai_prev: x.ai_prev, ai_at: x.ai_at });
      return { ai: aiOf(st, x, false) };
    };
    return {
      on: aiOn(st),
      sent: SENT,
      preview: ({ kind, request, answers }) => run(sb().rpc('homework_ai_preview', { p_assignment: id, p_kind: kind, p_request: request, p_answers: answers })),
      send: ({ kind, request, answers, key, shown }) => invokeAi({ kind, assignment_id: id, request, answers, key, shown }),
      state: fresh,
      draft: async (action) => {
        try { await run(sb().rpc('homework_ai_draft', { p_assignment: id, p_action: action })); } catch (err) { return { error: err }; }
        return fresh();
      },
      stretch: async (text) => {
        try {
          await q(sb().from('assignments').update({ stretch: text }).eq('id', id).select('id'));
        } catch (err) { toast(hwError(err), { error: true }); return; }
        if (!st.ctx.stale()) reload(st, true);
      },
    };
  }

  // The switches card's AI row (§9.2): its words.
  const AI_KEY_LINE = {
    auth: 'Anthropic refused the key. Make a new key and replace ANTHROPIC_API_KEY.',
    spend_limit: 'This month\'s limit at Anthropic is reached (Console → Workspaces → Home Hub → Spend limits).',
    billing: 'Anthropic says the account is out of credit: Console → Billing → Buy credits (or turn on auto-reload).',
  };
  const NOT_SET_UP = 'AI planner: not set up (README → Homework)';
  const cents = (n) => (Number(n) || 0);
  const aboutCents = (n) => `about ${Math.round(cents(n))} ${Math.round(cents(n)) === 1 ? 'cent' : 'cents'}`;
  function aiTestLine(st) {
    const t = st.aiTest;
    if (t && t.state === 'running') return 'Testing… (usually under a minute)';
    if (t && t.state === 'not_set_up') return NOT_SET_UP;
    if (t && t.state === 'offline') return 'Couldn\'t reach Home Hub to test. Check the connection and try again.';
    const r = t && t.run ? t.run : st.lastTest;
    if (!r) return 'Not tested yet. Test it before turning it on.';
    if (r.status === 'running') return 'Testing… (usually under a minute)';
    if (r.status === 'ready') {
      const secs = Math.max(1, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000)) || 0;
      return `Working · ${r.model || 'claude'} · ${secs} s · ${aboutCents(r.cents)}`;
    }
    const stop = String(r.stop || '');
    if (stop === 'cap') return 'Not run: AI help is used up for today (12 runs). Try again tomorrow.';
    if (stop === 'month') return 'Not run: AI help is used up for this month. It starts again next month.';
    if (/^refusal/.test(stop)) {
      const cat = /^refusal_[a-z_]+$/.test(stop) ? stop.slice('refusal_'.length).replace(/_/g, ' ') : '';
      return `Not working: the AI declined the test${cat ? ` (${cat})` : ''}.`;
    }
    return `Not working: ${AI_KEY_LINE[stop] || ({ timeout: 'it took too long.' }[stop] || 'try again later.')}`;
  }
  function aiRowHTML(st) {
    const hh = st.household;
    if (!hh) return '';
    const kid = kidName(st);
    const on = !!hh.homework_ai;
    const tested = !!(st.lastTest && st.lastTest.status === 'ready') || !!(st.aiTest && st.aiTest.run && st.aiTest.run.status === 'ready');
    const runs = st.aiRuns;
    const month = runs.filter((r) => householdDate(r.started_at).slice(0, 7) === st.today.slice(0, 7));
    const today = runs.filter((r) => householdDate(r.started_at) === st.today).length;
    const cost = month.reduce((n, r) => n + cents(r.cents), 0);
    const last = runs.find((r) => r.status === 'failed' && r.stop) || null;
    const lastAny = runs.find((r) => r.status !== 'running') || null;
    const warn = [];
    if (st.aiTest && st.aiTest.state === 'not_set_up') warn.push(NOT_SET_UP);
    if (lastAny && lastAny.status === 'failed' && AI_KEY_LINE[lastAny.stop]) warn.push(AI_KEY_LINE[lastAny.stop]);
    const refusal = runs.find((r) => /^refusal_[a-z_]+$/.test(r.stop || ''));
    if (refusal) warn.push(`The AI declined the last one: ${refusal.stop.slice('refusal_'.length).replace(/_/g, ' ')}`);
    else if (last && last.stop === 'refusal') warn.push('The AI declined the last one.');
    const words = hh.homework_never_send || [];
    const busyTest = st.aiTest && st.aiTest.state === 'running';
    return `<div class="hw-switch-row" data-row="ai"><p class="hw-switch-title">AI planner</p>
      ${on || tested ? `<label class="hw-switch"><input type="checkbox" data-act="ai-on"${on ? ' checked' : ''}><span>${on ? 'On' : 'Off'}</span></label>` : ''}
      <small class="hw-switch-line">When on, Pat and the parents can send an assignment (its title, class, dates and text), ${esc(kid)}'s free minutes per day, how long his steps take against the plan, and his short answers to the AI's questions, with the names Home Hub knows taken out, to Anthropic (Claude) to draft a plan. What Claude will see shows exactly what goes. Anthropic doesn't train on it. It may keep it up to 30 days, or up to 2 years if its safety checks flag it. About 6 cents a plan; never more than the $15 monthly limit.</small>
      <p class="hw-ai-state">${esc(`AI planner: ${on ? 'on' : 'off'}`)}</p>
      ${warn.map((x) => `<p class="hw-feed-error hw-ai-key" role="status">${esc(x)}</p>`).join('')}
      <p class="hw-switch-line hw-ai-month">${esc(`AI planner this month: ${plural(month.length, 'run')}, about $${(cost / 100).toFixed(2)} (estimate) · ${today} of 12 today`)}</p>
      <div class="hw-feed-acts">${btn('ai-test', 'Test the AI planner', busyTest ? ' disabled' : '')}</div>
      <p class="hw-switch-line hw-ai-test" role="status">${esc(aiTestLine(st))}</p>
      <p class="hw-switch-title hw-sub-title">Words never to send</p>
      <small class="hw-switch-line">The school's name and its short form, and ${esc(kid)}'s teachers' names. They are taken out of everything sent, as the names Home Hub knows are. The AI can't be turned on without one.</small>
      <ul class="hw-never">${words.map((x, i) => `<li><span>${esc(x)}</span><button type="button" class="linkbtn" data-act="never-remove" data-i="${i}" aria-label="${esc(`Remove ${x}`)}">Remove</button></li>`).join('')}</ul>
      ${words.length < 20 ? `<form class="hw-neverform" data-form="never" novalidate autocomplete="off"><label class="field"><span>A word or name never to send</span>
        <input type="text" name="word" maxlength="40" autocomplete="off" placeholder="North Field School"></label>
        <p class="form-error" role="alert" hidden></p><div class="form-actions"><button type="submit" class="btn">Add</button></div></form>` : ''}
      ${month.length ? `<details class="hw-ai-runs"><summary>${esc(`This month's runs (${month.length})`)}</summary><ul>${month.map((r) => `<li>${esc([
        `${rel(st, householdDate(r.started_at))} ${fmt.time(r.started_at)}`, r.kind === 'test' ? 'Test' : r.kind === 'revise' ? 'Revision' : 'Plan',
        r.asked_by ? whoName(r.asked_by) : '', r.status === 'ready' ? 'Done' : r.status === 'running' ? 'Running' : `Stopped: ${r.stop || 'error'}`,
        r.cents != null ? aboutCents(r.cents) : ''].filter(Boolean).join(' · '))}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  }
  // Test the AI planner: a run with a fixed made-up assignment (nothing stored but its record), read every 2 seconds.
  async function aiTest(st) {
    if (st.aiTest && st.aiTest.state === 'running') return;
    st.aiTest = { state: 'running' };
    draw(st);
    let r;
    try { r = await invokeAi({ kind: 'test', key: P.newId() }); } catch (err) { r = { error: err }; }
    if (st.ctx.stale()) return;
    if (r.error) { st.aiTest = { state: 'offline' }; draw(st); return; }
    if (r.stop === 'not_set_up') { st.aiTest = { state: 'not_set_up' }; draw(st); return; }
    if (r.stop) { st.aiTest = { state: 'done', run: { status: 'failed', stop: r.stop } }; draw(st); return; }
    const until = Date.now() + 6.5 * 60 * 1000;
    const tick = async () => {
      if (st.ctx.stale()) return;
      let rows = null;
      try { rows = await q(sb().from('ai_runs').select(RUN_COLS).eq('id', r.run_id)); } catch (err) { rows = null; }
      if (st.ctx.stale()) return;
      const x = rows && rows[0];
      if ((!x || x.status === 'running') && Date.now() < until) { setTimeout(tick, 2000); return; }
      st.aiTest = { state: 'done', run: x || { status: 'failed', stop: 'timeout' } };
      reload(st, true);
    };
    setTimeout(tick, 2000);
  }
  function addNever(st, form) {
    const err = form.querySelector('.form-error');
    const word = P.clean(form.elements.word.value, 41);
    const words = (st.household && st.household.homework_never_send) || [];
    const fail = (m) => { err.textContent = m; err.hidden = false; form.elements.word.focus(); };
    if (Array.from(word).length < 2 || Array.from(word).length > 40) return fail('A word or name of 2 to 40 characters.');
    if (words.some((x) => x.toLowerCase() === word.toLowerCase())) return fail('That one is on the list already.');
    return saveHouse(st, { homework_never_send: words.concat([word]) }, `Added: ${word}`);
  }
  // The household's AI columns, saved only if nobody changed the household since it was read (as Settings saves it).
  function saveHouse(st, patch, done) {
    const hh = st.household;
    return write(st, async () => {
      const rows = await q(sb().from('household').update(patch).eq('id', true).eq('updated_at', hh.updated_at).select());
      if (!rows || !rows.length) throw new Error('That wasn\'t saved: someone changed the settings a moment ago. Reload, then try again.');
      try { await v2.refresh(); } catch (err) { /* the page reads it again anyway */ }
    }, () => toast(done));
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
      decline: ['A word for him (optional)', 'Not now', LEN.decline, 'text'],
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
    else if (a.added_by === 'school') sub.push(...schoolMarks(st, a));
    let state;
    if (a.status !== 'open') state = a.status === 'done' ? 'Done' : 'Dropped';
    else if (!a.given_at && (aiOf(st, a, true) || {}).state === 'running') state = 'AI is drafting a plan… ›';
    else if (!a.given_at && a.ai_draft) state = 'AI draft ready ›';
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

  const LEDGER = { focus: 'Focus', on_time: 'On time', milestone_done: 'Ticked', milestone: 'Checked', given: 'Given' };
  function ledgerLine(st, l) {
    // A trade of an instant reward he cashed himself says so (no parent's yes was needed).
    const cashed = l.kind === 'trade' && l.ask_id && st.asks.some((x) => x.id === l.ask_id && x.status === 'cashed');
    const what = l.kind === 'void' ? `Void: ${l.note || ''}` : l.kind === 'trade' ? `${l.note || 'Trade'}${cashed ? ` (instant, cashed in by ${kidName(st)})` : ''}`
      : [LEDGER[l.kind], l.note].filter(Boolean).join(l.kind === 'milestone' || l.kind === 'milestone_done' ? ': ' : ' · ');
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
    const ms = sum(st.ledger.filter((l) => (l.kind === 'milestone' || l.kind === 'milestone_done') && l.day >= mon && l.day <= dates.addDays(mon, 6)), (l) => l.delta);
    const line = `${balance(st)} · today ${signed(today)} of ${k.pts_day_cap} · milestones this week ${ms} of ${k.pts_milestone_week}`;
    const acts = admin ? `<span class="hw-adds">${btn('give', 'Give points')}${btn('add-reward', '+ Reward')}</span>` : '';
    const rewards = st.rewards.filter((r) => r.cost != null);
    const voided = new Set(st.ledger.filter((l) => l.kind === 'void').map((l) => l.void_of));
    const last = st.ledger.slice(0, 10);
    return section('points', 'Points and rewards', `<p class="hw-points-line">${esc(line)}</p>`
      + `${rewards.length ? `<ul class="hw-card hw-rows hw-rewards">${rewards.map((r) => `<li class="hw-row${r.active ? '' : ' is-off'}"><div class="hw-row-main">`
        + `<span class="hw-rw-line">${esc(`${r.title} · ${r.cost}${r.instant ? ' · instant' : ''}${r.active ? '' : ' · off'}`)}</span></div>`
        + `${admin ? `<div class="hw-row-acts"><button type="button" class="hw-more" data-act="edit-reward" data-reward="${esc(r.id)}" aria-label="${esc(`Edit ${r.title}`)}">${ICON.dots}</button></div>` : ''}</li>`).join('')}</ul>`
        : `<p class="hw-card empty-line hw-empty">No rewards yet.${admin ? ' Add an instant one he can get after one block (about 15), one about once a week (about 200) and a bigger one (about 500).' : ''}</p>`}`
      + `${last.length ? `<h3 class="hw-sub">Recent</h3><ul class="hw-card hw-rows hw-ledger">${last.map((l) => `<li class="hw-row"><div class="hw-row-main"><span class="hw-ledger-line">${esc(ledgerLine(st, l))}</span></div>`
        + `${admin && ['focus', 'on_time', 'milestone_done', 'milestone', 'given'].includes(l.kind) && !voided.has(l.id) ? `<div class="hw-row-acts">${btn('void', 'Void…', ` data-entry="${esc(l.id)}"`)}</div>` : ''}</li>`).join('')}</ul>` : ''}`, null, acts);
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
      </div>
      <label class="hw-switch hw-link-ai"><input type="checkbox" data-act="link-ai" data-link="${esc(l.id)}"${l.can_ai ? ' checked' : ''}><span>Can ask the AI</span></label>
      ${core.schemaVersion >= 7 ? coachHTML(st, l) : ''}${st.form && st.form.key === `link:${l.id}` ? linkFormHTML(l) : ''}</li>`;
  }
  // 0007 (docs/v1.3-homework.md §20.5): the link's coach view (off by default; set_tutor_coach), with exactly what it
  // shows, and the notes the coach left for the parents: the ones not done, each with Done, and the done ones of the
  // last 30 days folded. Parents only (the links are theirs).
  function coachHTML(st, l) {
    const tutor = String(l.label).split(/[\s,]+/)[0];
    const kid = kidName(st);
    const notes = st.coachNotes.filter((n) => n.link_id === l.id);
    const open = notes.filter((n) => !n.done_at);
    const done = notes.filter((n) => n.done_at && householdDate(n.created_at) >= dates.addDays(st.today, -30));
    const line = (n) => `${cap(when(st, n.created_at))} · “${n.note}”`;
    const keep = `coach:${l.id}`;
    return `<div class="hw-link-coach"><label class="hw-switch"><input type="checkbox" data-act="link-coach" data-link="${esc(l.id)}"${l.coach ? ' checked' : ''}><span>Coach view</span></label>
        <small class="hw-switch-line">${esc(`Also shows ${tutor} ${kid}'s points and rewards (this week's and last week's points, and the last 30 days), his focus sessions, `
          + `his own calendar (the next 14 days and the last 7) and his daily tasks, read-only, and lets ${tutor} leave you a note here. `
          + 'Private items and health tasks show as “Private item”. Never the rest of the family: '
          + "no one else's events, tasks or names, no dinners, shopping list or contacts.")}</small></div>`
      + (st.coachFailed ? `<p class="hw-switch-line">${esc(`${tutor}'s notes couldn't be loaded.`)}</p>` : '')
      + (open.length || done.length ? `<div class="hw-coach-notes"><p class="hw-coach-head">${esc(`Notes from ${l.label} (${open.length})`)}</p>`
        + (open.length ? `<ul>${open.map((n) => `<li><span class="hw-coach-note">${esc(line(n))}</span>${btn('coach-done', 'Done', ` data-note="${esc(n.id)}"`)}</li>`).join('')}</ul>` : '')
        + (done.length ? `<details data-keep="${esc(keep)}"${st.schoolOpen[keep] ? ' open' : ''}><summary>${esc(`Earlier notes (${done.length})`)}</summary>`
          + `<ul>${done.map((n) => `<li><span class="hw-coach-note">${esc(line(n))}</span> · Done</li>`).join('')}</ul></details>` : '')
        + '</div>' : '');
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
    const values = [['pts_focus', 'Per focused minute', 0, 5], ['pts_on_time', 'Starting on time (once 5 minutes are done)', 0, 50],
      ['pts_milestone', 'A milestone (half when he ticks it, half when it\'s checked)', 0, 100],
      ['pts_day_cap', 'Most a day from blocks and on-time starts', 0, 300], ['pts_milestone_week', 'Most a week from milestones', 0, 400],
      ['instant_day', 'Instant rewards he may get a day', 0, 10]];
    const rows = [];
    rows.push(`<div class="hw-switch-row" data-row="kid"><label class="hw-switch"><input type="checkbox" data-act="kid-on"${k.active ? ' checked' : ''}${off}><span>Homework for ${esc(kid)}</span></label>
      <small class="hw-switch-line">Homework on ${esc(kid)}'s My day, and ${esc(tutor ? `${tutor}'s` : 'the tutor\'s')} link. Off hides them; nothing is deleted.</small>
      ${others.map((p) => btn('turn-on', `Turn on homework for ${firstName(p.name)}`, ` data-kid="${esc(p.id)}"`)).join('')}</div>`);
    if (k.active) {
      rows.push(`<div class="hw-switch-row" data-row="points"><label class="hw-switch"><input type="checkbox" data-act="points-on"${k.points_on ? ' checked' : ''}${off}><span>Points</span></label>
        <small class="hw-switch-line">Points for on-time starts, focus blocks (paid the moment a block ends) and milestones (half when he ticks one, half when it's checked). Off: nothing is earned, and his My day shows no points.</small>
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
        rows.push(aiRowHTML(st));
        if (core.schemaVersion >= 6) rows.push(schoolHTML(st));
        rows.push(`<div class="hw-switch-row" data-row="erase">${btn('erase', `Erase ${kid}'s homework…`, '', 'btn-danger')}
          <small class="hw-switch-line">Deletes all of it, for good. His homework-time events stay on the calendar.</small></div>`);
      }
    }
    if (!admin) rows.push('<p class="hw-switch-note">Only parents can change these.</p>');
    return section('switches', 'Switches', `<div class="hw-card hw-switches">${rows.join('')}</div>`);
  }

  // ---------- School links (§11, §12): the parents only, on schema 6
  // The last read's stop (one of hub-jobs' fixed codes), in words. The last good read stays shown beside it.
  const STOP = {
    bad_link: 'Home Hub can\'t use this link. Copy it again and use Replace.',
    redirect: 'The school\'s site sent the read somewhere else. Copy the link again and use Replace.',
    unreachable: 'The school\'s site couldn\'t be reached. Home Hub tries again within the hour.',
    timeout: 'The school\'s site took too long to answer. Home Hub tries again within the hour.',
    down: 'The school\'s site is having trouble. Home Hub tries again within the hour.',
    http: 'The school\'s site answered with an error. Home Hub tries again within the hour.',
    refused: 'The school\'s site refused the link. Copy it again and use Replace.',
    gone: 'Blackbaud doesn\'t know this link any more. Copy it again and use Replace.',
    sign_in: 'Blackbaud answered with a sign-in page: the link may have been replaced. Copy it again and use Replace.',
    not_calendar: 'That link isn\'t a calendar. Copy the one under Individual Filter Feeds and use Replace.',
    too_big: 'The calendar is too big to read, so nothing was changed.',
    too_many: 'It holds more than Home Hub can use, so nothing was changed.',
    empty: 'It came back empty (a new school year?), so nothing was changed.',
  };
  const stopWords = (code) => (Object.prototype.hasOwnProperty.call(STOP, code) ? STOP[code] : 'The last read didn\'t work. Home Hub tries again within the hour.');
  const STALE = 'Not read for over 3 hours: the hourly read may have stopped. Run supabase/cron.sql again (see the README).';
  // What an assignment made from school says: "from school", and the school's marks (moved, gone) from the status.
  function schoolMarks(st, a) {
    const s = st.school;
    const out = ['from school'];
    if (s && s.gone.some((g) => g.assignment_id === a.id)) out.push('no longer on the school site');
    else {
      const m = s && s.moved.find((x) => x.assignment_id === a.id);
      if (m && m.to) out.push(`the school moved it to ${fmt.day(m.to)}`);
    }
    return out;
  }
  function schoolFormHTML(kind, label, set) {
    return `<form class="hw-schoolform" data-form="school" data-feed="${esc(kind)}" novalidate autocomplete="off">
      <label class="field"><span>${esc(set ? `Paste the new ${label} link` : `Paste the ${label} link`)}</span>
        <input type="url" name="url" inputmode="url" maxlength="500" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" placeholder="webcal://…"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions"><button type="button" class="btn" data-act="cancel-note">Cancel</button><button type="submit" class="btn btn-primary">${set ? 'Replace' : 'Save'}</button></div></form>`;
  }
  function feedHTML(st, kind, label, what) {
    const f = feedOf(st, kind);
    const read = f && f.last_ok_at ? `Last read ${when(st, f.last_ok_at)} · ${plural(Number(f.last_count) || 0, 'item')}` : null;
    let state = 'Not added';
    if (f) state = [f.paused ? 'Paused' : null, read || (f.paused ? null : f.last_stop ? 'Added · not read yet' : 'Added · first read within the hour')].filter(Boolean).join(' · ');
    const open = !!(st.form && st.form.key === `school:${kind}`);
    const at = ` data-feed="${esc(kind)}"`;
    const acts = open ? '' : f ? `${btn('school-replace', 'Replace', at)}${btn(f.paused ? 'school-resume' : 'school-pause', f.paused ? 'Resume' : 'Pause', at)}${btn('school-remove', 'Remove', at)}`
      : btn('school-add', 'Add link', at, 'btn-primary');
    const repeats = f ? Number(f.last_repeats) || 0 : 0;
    return `<li class="hw-feed" data-feed="${esc(kind)}"><div class="hw-feed-head"><b class="hw-feed-name">${esc(label)}</b><span class="hw-feed-state">${esc(state)}</span></div>
      <small class="hw-feed-what">${esc(what)}</small>
      ${f ? `<small class="hw-feed-link">${esc(`${f.host} …${f.url_end}`)}</small>` : ''}
      ${f && f.last_stop ? `<p class="hw-feed-error" role="status">${esc(stopWords(f.last_stop))}</p>` : ''}
      ${f && f.stale ? `<p class="hw-feed-error hw-feed-stale" role="status">${esc(STALE)}</p>` : ''}
      ${repeats ? `<small class="hw-feed-what hw-feed-repeats">${esc(`${plural(repeats, 'repeating event')}: Home Hub uses only the first date of each.`)}</small>` : ''}
      ${acts ? `<div class="hw-feed-acts">${acts}</div>` : ''}${open ? schoolFormHTML(kind, label, !!f) : ''}</li>`;
  }
  const itemLine = (x) => [x.subject, x.title, `due ${fmt.day(x.due_date)}`].filter(Boolean).join(' · ');
  // The first-import check (§11.2 step 7): an Assignments link nobody has checked. Until a parent answers, nothing from
  // it reaches him or the tutor; the answer sets the due date as an item's last ('end') or first ('start') day, moved -1 to 1.
  function schoolCheckHTML(st) {
    const f = feedOf(st, 'assignments');
    if (!f || f.checked) return '';
    const kid = kidName(st);
    const tutor = tutorFirst(st) || 'the tutor';
    const head = '<p class="hw-switch-title">Check the dates</p>';
    if (!st.school.check.length) {
      return `<div class="hw-school-check" data-ref="school-check">${head}<p class="hw-switch-line">${esc(`Once the Assignments link is read, its next 5 items show here, to check against Blackbaud. Until you answer, nothing from it reaches ${kid} or ${tutor}.`)}</p></div>`;
    }
    const at = (rule, shift) => ` data-id="${esc(f.id)}" data-rule="${rule}" data-shift="${shift}"`;
    return `<div class="hw-school-check" data-ref="school-check">${head}
      <p class="hw-switch-line">${esc(`Is this what Blackbaud shows? Until you answer, nothing from the Assignments link reaches ${kid} or ${tutor}.`)}</p>
      <ul class="hw-school-items">${st.school.check.map((x) => `<li>${esc(itemLine(x))}</li>`).join('')}</ul>
      <div class="hw-feed-acts">${btn('school-dates', 'Looks right', at('end', 0), 'btn-primary')}${btn('school-dates', 'Use the first date', at('start', 0))}${st.schoolOff ? '' : btn('school-off', 'One day off')}</div>
      ${st.schoolOff ? `<p class="hw-switch-line">Blackbaud shows each one:</p><div class="hw-feed-acts">${btn('school-dates', 'A day earlier', at('end', -1))}${btn('school-dates', 'A day later', at('end', 1))}</div>` : ''}</div>`;
  }
  // What is new for him (Add to homework, Hide), what he hid (Show), and the assignments the school moved or took off its site.
  function schoolItemsHTML(st) {
    const s = st.school;
    const kid = kidName(st);
    const out = [];
    const marks = s.moved.map((m) => [m.assignment_id, `${m.title}: the school moved its due date from ${fmt.day(m.from)} to ${fmt.day(m.to)}. Open it to place it again ›`])
      .concat(s.gone.map((g) => [g.assignment_id, `${g.title} is no longer on the school site ›`]));
    if (marks.length) out.push(`<ul class="hw-school-marks">${marks.map(([id, text]) => `<li><a href="#/homework/${esc(id)}">${esc(text)}</a></li>`).join('')}</ul>`);
    const list = (key, title, rows, acts) => `<details class="hw-school-list" data-keep="${key}"${st.schoolOpen[key] ? ' open' : ''}><summary>${esc(title)}</summary>
      <ul class="hw-school-items">${rows.map((x) => `<li class="hw-school-row" data-item="${esc(x.id)}"><span>${esc(itemLine(x))}</span>
        <span class="hw-feed-acts">${acts.map(([act, label]) => btn('school-item', label, ` data-item="${esc(x.id)}" data-do="${act}"`)).join('')}</span></li>`).join('')}</ul></details>`;
    if (s.new.length) out.push(list('new', `New from school for ${kid} (${s.new.length})`, s.new, [['add', 'Add to homework'], ['hide', 'Hide']]));
    if (s.hidden.length) out.push(list('hidden', `Hidden from ${kid}'s list (${s.hidden.length})`, s.hidden, [['show', 'Show']]));
    return out.join('');
  }
  function schoolHTML(st) {
    const kid = kidName(st);
    const how = `<details class="hw-school-how" data-keep="how"${st.schoolOpen.how ? ' open' : ''}><summary>How to copy a link</summary><ol>
        <li>On a computer, sign in to the school's Blackbaud site with your own parent login (${esc(kid)}'s isn't needed).</li>
        <li>${esc(`Under ${kid}'s Calendars, open Calendar.`)}</li>
        <li>Click the feed button. A box opens: “WebCal Feed for External Calendar”.</li>
        <li>Under Individual Filter Feeds, right-click Assignments and choose Copy Link Address (Copy Link in some browsers). Schedule and Games/Practices go the same way, if you want them as busy time.</li>
        <li>Here, tap Add link next to the same name, paste it and tap Save. Then Check now, and check the dates of the first 5 assignments.</li>
      </ol><p>${esc(`The feed holds the past 2 months and the next 12, and a change on the school's site can take up to an hour to reach it. Don't paste a link anywhere else: anyone who has it can read ${kid}'s calendar.`)}</p></details>`;
    const body = st.schoolFailed || !st.school
      ? '<p class="hw-fail" role="status">School links couldn\'t be loaded. <button type="button" class="linkbtn hw-retry" data-act="retry">Try again</button></p>'
      : `<ul class="hw-feeds">${FEEDS.map(([kind, label, what]) => feedHTML(st, kind, label, what(kid))).join('')}</ul>
        ${st.school.feeds.length ? `<div class="hw-feed-acts">${btn('school-now', 'Check now')}</div>` : ''}${schoolCheckHTML(st)}${schoolItemsHTML(st)}`;
    return `<div class="hw-switch-row" data-row="school"><p class="hw-switch-title">School links</p>
      <small class="hw-switch-line">${esc(`${kid}'s calendars from the school's Blackbaud site. Home Hub reads them every hour. A link works like a password: once saved it is never shown again, here or anywhere.`)}</small>
      ${body}${how}</div>`;
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
      // The owner's sizes: an instant one he can get after one block, one about once a week, a bigger one.
      const sizes = [[15, '15 minutes of extra game time', 'an instant one, after one block', true], [200, 'Choose Friday\'s dinner', 'about once a week', false],
        [500, 'A new book', 'a bigger one', false]];
      parts.push(`<div class="hw-setup-step"><h3>Add 3 rewards</h3><p>What ${esc(kid)}'s points buy. An instant one he gets on the spot (you see it on Today); for the others he asks, and a parent says yes.</p>
        <form class="hw-rewardsform" data-form="rewards" novalidate autocomplete="off"><div class="hw-rws">${sizes.map(([cost, eg, hint, instant]) => `<div class="hw-rw">
          <label class="field"><span>${esc(cap(hint))}</span><input type="text" name="title" maxlength="60" placeholder="${esc(eg)}"></label>
          <label class="field hw-rw-cost"><span>Points</span><input type="number" name="cost" min="1" max="10000" step="1" inputmode="numeric" value="${cost}"></label>
          <label class="check hw-rw-instant"><input type="checkbox" name="instant"${instant ? ' checked' : ''}> Instant</label></div>`).join('')}</div>
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
    st.typing = false;   // the homework time, rewards, points values and link forms are drawn afresh from what was read
    if (window.scrollY !== y) window.scrollTo(window.scrollX, y);
    const input = st.form && main.querySelector(`form[data-key="${CSS.escape(st.form.key)}"] input, form[data-link] input[name="label"], form[data-form="school"] input[name="url"]`);
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
    else if (a.added_by === 'school') bits.push(...schoolMarks(st, a));
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
    const more = { today: st.today, asOf: asOf(), serverNow: clockInstant(), week: st.week, length: st.row.focus_minutes, kid: kidName(st), tutor: tutorFirst(st),
      ai: aiOpts(st, a) };
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
      const instant = !!(r.querySelector('[name="instant"]') && r.querySelector('[name="instant"]').checked);
      rows.push({ kid_id: st.kid, title, cost, active: true, instant, sort_order: start + rows.length + 1 });
    }
    if (!rows.length) return fail('Name at least one reward.');
    return write(st, () => q(sb().from('rewards').insert(rows).select('id')), () => toast(`${plural(rows.length, 'reward')} added`));
  }

  function savePoints(st, form) {
    const f = form.elements;
    const err = form.querySelector('.form-error');
    const patch = {};
    const limits = { pts_focus: 5, pts_on_time: 50, pts_milestone: 100, pts_day_cap: 300, pts_milestone_week: 400, instant_day: 10 };
    for (const name of Object.keys(limits)) {
      const v = Number(f[name].value);
      if (!Number.isInteger(v) || v < 0 || v > limits[name]) { err.textContent = `Use a whole number from 0 to ${limits[name]}.`; err.hidden = false; f[name].focus(); return null; }
      patch[name] = v;
    }
    patch.focus_minutes = Number(f.focus_minutes.value);
    return write(st, () => saveKid(st, patch), () => toast('Saved'));
  }

  // Yes or Not now on his ask. An ask already decided (the other parent, or Today, a moment ago) or that
  // he cancelled comes back as it is, with no error: the toast says what it is, not what was tapped.
  function decide(st, askId, approve, note) {
    const x = st.asks.find((a) => a.id === askId);
    const what = x ? x.title : 'the reward';
    let was = null;
    return write(st, async () => {
      const res = await run(approve ? sb().rpc('decide_reward', { p_ask: askId, p_approve: true })
        : sb().rpc('decide_reward', { p_ask: askId, p_approve: false, p_note: note || null }));
      was = res && res.ask && res.ask.status;
    }, () => toast(was === 'approved' && !approve ? `Already approved: ${what}`
      : was === 'declined' && approve ? `Already answered Not now: ${what}`
        : was === 'cancelled' ? `${v2.person(st.kid) ? kidName(st) : 'He'} cancelled that ask: ${what}`
          : approve ? `Yes: ${what} for ${kidName(st)}` : `Not now: ${what}`));
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
    const max = f.action === 'answer' ? LEN.answer : f.action === 'decline' ? LEN.decline : LEN.note;
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
    const r = reward || { title: '', cost: '', active: true, instant: false };
    const form = openDialog(`<form class="form d-inner hw-reward" novalidate autocomplete="off">${dialogTop(reward ? reward.title : 'New reward')}
      <label class="field"><span>Reward</span><input type="text" name="title" maxlength="60" value="${esc(r.title)}" placeholder="Choose Friday's dinner"></label>
      <label class="field"><span>Points</span><input type="number" name="cost" min="1" max="10000" step="1" inputmode="numeric" value="${esc(r.cost == null ? '' : r.cost)}"></label>
      <label class="check"><input type="checkbox" name="active"${r.active ? ' checked' : ''}> On (he can ask for it)</label>
      <label class="check"><input type="checkbox" name="instant"${r.instant ? ' checked' : ''}> Instant: he gets it on the spot, no ask (you see it on Today; at most ${esc(st.row ? st.row.instant_day : 2)} a day)</label>
      ${dialogFoot('Save', reward ? '<button type="button" class="btn btn-danger left" data-act="delete-reward-now">Delete</button>' : '')}</form>`);
    const f = form.elements;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = form.querySelector('.form-error');
      const title = P.clean(f.title.value, 61);
      const cost = Number(f.cost.value);
      if (!title || Array.from(title).length > 60) { err.textContent = 'Name it, in at most 60 characters.'; err.hidden = false; return undefined; }
      if (!Number.isInteger(cost) || cost < 1 || cost > 10000) { err.textContent = 'It costs 1 to 10,000 points.'; err.hidden = false; return undefined; }
      const row = { title, cost, active: f.active.checked, instant: f.instant.checked };
      if (reward) {
        const patch = {};
        Object.keys(row).forEach((k) => { if (row[k] !== reward[k]) patch[k] = row[k]; });
        if (!Object.keys(patch).length) { formDialog.close(); return undefined; }
        return dialogWrite(st, form, () => q(sb().from('rewards').update(patch).eq('id', reward.id).select('id')), () => toast('Saved'));
      }
      const next = st.rewards.reduce((n, x) => Math.max(n, Number(x.sort_order) || 0), 0) + 1;
      return dialogWrite(st, form, () => q(sb().from('rewards').insert({ kid_id: st.kid, title, cost, active: row.active, instant: row.instant, sort_order: next }).select('id')),
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
      <p>This deletes ${esc(kid)}'s assignments and lessons, their plans, questions, answers and notes, his focus blocks, points, rewards and asks, the tutor's links and the AI planner's run records, for good. His homework-time events stay on the calendar; delete them there if you want. A copy Anthropic keeps of what was sent to the AI planner (up to 30 days) can't be reached from here.</p>
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

  // ---------- School links: Add link, Replace, Remove
  // The pasted link as it is sent: trimmed, webcal:// as https://. The database checks it again (the school's host,
  // the feed's path, its z value) and refuses anything else in its own words. The box is emptied once it is saved,
  // and nothing keeps it: not st, not storage, not a toast.
  const BAD_LINK = 'That isn\'t a calendar feed link: it starts with webcal:// or https://. Copy it again with right-click, then Copy Link Address.';
  function schoolLink(raw) {
    let s = String(raw || '').trim();
    if (!s) return { error: 'Paste the link first.' };
    if (/^webcal:\/\//i.test(s)) s = `https://${s.slice('webcal://'.length)}`;
    let u = null;
    try { u = new URL(s); } catch (e) { u = null; }
    if (!u || u.protocol !== 'https:' || /\s/.test(s)) return { error: BAD_LINK };
    if (s.length > 500) return { error: 'That link is too long for a school calendar link. Copy it again.' };
    return { url: s };
  }
  async function saveSchool(st, form) {
    const feed = form.dataset.feed;
    const label = FEED_LABEL[feed];
    if (!label || st.busy) return;
    const err = form.querySelector('.form-error');
    const box = form.elements.url;
    const buttons = [...form.querySelectorAll('button')];
    const fail = (m) => { err.textContent = m; err.hidden = false; box.focus(); };
    const link = schoolLink(box.value);
    if (link.error) { fail(link.error); return; }
    const replacing = !!feedOf(st, feed);
    err.hidden = true;
    setBusy(st, true);
    buttons.forEach((b) => { b.disabled = true; });
    let res;
    try { res = await sb().rpc('set_school_feed', { p_kid: st.kid, p_kind: feed, p_url: link.url }); } catch (e) { res = { error: e }; }
    if (st.ctx.stale()) return;
    if (res.error) {
      setBusy(st, false);
      buttons.forEach((b) => { b.disabled = false; });
      fail(hwError(res.error));
      return;
    }
    box.value = '';
    st.form = null;
    await reload(st, true);
    setBusy(st, false);
    toast(`${label} link ${replacing ? 'replaced' : 'saved'}. Home Hub reads it within the hour.`);
  }
  function removeSchool(st, feed) {
    const label = FEED_LABEL[feed];
    if (!label) return;
    const what = feed === 'assignments' ? `Assignments already on ${kidName(st)}'s homework stay; the rest of what it brought goes.` : 'His busy time from it goes too.';
    if (!window.confirm(`Remove the ${label} link? Home Hub stops reading it. ${what}`)) return;
    write(st, () => run(sb().rpc('set_school_feed', { p_kid: st.kid, p_kind: feed, p_url: null })), () => toast(`${label} link removed`));
  }
  function pauseSchool(st, feed, paused) {
    const f = feedOf(st, feed);
    if (!f) return;
    write(st, () => run(sb().rpc('pause_school_feed', { p_feed: f.id, p_paused: paused })),
      () => toast(paused ? `${FEED_LABEL[feed]} link paused: Home Hub doesn't read it until you resume it` : `${FEED_LABEL[feed]} link resumed. Home Hub reads it within the hour.`));
  }
  // The first-import check's answer: the due date is an item's last ('end') or first ('start') day, moved by shift.
  function checkDates(st, id, rule, shift) {
    st.schoolOff = false;
    write(st, () => run(sb().rpc('check_school_feed', { p_feed: id, p_date_rule: rule, p_date_shift: shift })),
      () => toast(`Dates checked. ${kidName(st)}'s New from school shows them now.`));
  }
  function schoolItemAct(st, id, action) {
    const x = st.school && [].concat(st.school.new, st.school.hidden).find((y) => y.id === id);
    if (!x || !['add', 'hide', 'show'].includes(action)) return;
    const kid = kidName(st);
    write(st, () => run(sb().rpc('school_item_action', { p_item: id, p_action: action })),
      () => toast(action === 'add' ? `On ${kid}'s homework: ${x.title}` : action === 'hide' ? `Hidden from ${kid}'s list: ${x.title}` : `Back on ${kid}'s New from school: ${x.title}`));
  }
  // Check now: hub-jobs reads every link not read in the last minute, as the parent; then the status is read again.
  async function checkNow(st) {
    if (st.busy) return;
    setBusy(st, true);
    let res;
    try { res = await sb().functions.invoke('hub-jobs', { body: { action: 'school' } }); } catch (err) { res = { error: err }; }
    if (st.ctx.stale()) return;
    let said = null;
    if (res.error) {
      const r = res.error.context;
      let reply = null;
      try { reply = r && typeof r.json === 'function' ? await r.json() : null; } catch (e) { /* not JSON */ }
      said = reply && reply.stop === 'busy' ? null : (reply && typeof reply.error === 'string' && reply.error) || friendly(res.error);
    }
    await reload(st, true);
    setBusy(st, false);
    if (said) { toast(said, { error: true }); return; }
    const d = (res.data && typeof res.data === 'object') ? res.data : {};
    const n = (k) => Number(d[k]) || 0;
    if (d.stop === 'busy') toast('The hourly read is running right now. Try again in a minute.');
    else if (!n('read') && !n('failed')) toast('Nothing to read: each link was read in the last minute.');
    else toast(`Checked ${plural(n('stored'), 'link')} · ${plural(n('items'), 'item')}${n('failed') ? ` · ${n('failed')} didn't work` : ''}`);
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
      // without a day, so the database places them again. The list is the plan as it is now, not the
      // page's copy (Jordan or Pat may have changed it since the page read it): its plan_rev is read
      // first, then its steps, and that plan_rev is sent, so a step added, moved or changed since the
      // page's read is kept, and a change made between the two reads gets the save refused (§4.4), and
      // read again once, rather than undone. Done steps go without a day: the database keeps them as
      // they are whatever the list says (§4.4), and one ticked early can sit after a due date moved
      // before it.
      const last = P.lastWorkDay(next.due_date, st.today, next.kind);
      const behind = (s) => !s.done_at && (s.kind === 'turn_in' ? s.day !== next.due_date : s.day > last || (s.day >= next.due_date && next.kind !== 'lesson'));
      const placeAgain = async () => {
        const fresh = (await q(sb().from('assignments').select('plan_rev').eq('id', a.id)))[0];
        if (!fresh) return { error: null, n: 0 };
        const steps = ((await q(sb().from('homework_steps').select('*').eq('assignment_id', a.id).order('pos'))) || [])
          .sort((x, y) => x.pos - y.pos || (x.id < y.id ? -1 : 1));
        const n = steps.filter(behind).length;
        if (!n) return { error: null, n: 0 };
        const list = steps.map((s) => ({ id: s.id, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like || null, minutes: s.minutes,
          day: s.done_at || behind(s) ? null : s.day, source: s.source }));
        const { error } = await sb().rpc('save_homework_plan', { p_assignment: a.id, p_steps: list, p_rev: fresh.plan_rev, p_give: false });
        return { error, n };
      };
      let r = await placeAgain();
      if (r.error && r.error.code === 'P0001' && /changed since you opened it/i.test(r.error.message || '')) r = await placeAgain();
      const { error } = r;
      moved = r.n;
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
    if (chip && st.main.contains(chip)) { chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true')); st.typing = true; return; }
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
      case 'coach-done': write(st, () => run(sb().rpc('coach_note_done', { p_note: d.note })), () => toast('Marked done')); break;
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
      case 'school-add': case 'school-replace': if (FEED_LABEL[d.feed]) open(`school:${d.feed}`, 'school', d.feed); break;
      case 'school-remove': removeSchool(st, d.feed); break;
      case 'school-pause': case 'school-resume': pauseSchool(st, d.feed, d.act === 'school-pause'); break;
      case 'school-now': checkNow(st); break;
      case 'school-off': st.schoolOff = true; draw(st); break;
      case 'school-dates': checkDates(st, d.id, d.rule, Number(d.shift)); break;
      case 'school-item': schoolItemAct(st, d.item, d.do); break;
      case 'add-link': open('link:new', 'link', null); break;
      case 'erase': eraseDialog(st); break;
      case 'ai-test': aiTest(st); break;
      case 'never-remove': {
        const words = (st.household && st.household.homework_never_send) || [];
        const i = Number(d.i);
        if (!words[i]) break;
        if (st.household.homework_ai && words.length === 1) { toast('Turn the AI planner off first: it needs at least one word never to send.', { error: true }); break; }
        saveHouse(st, { homework_never_send: words.filter((x, j) => j !== i) }, `Removed: ${words[i]}`);
        break;
      }
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
    else if (form.dataset.form === 'school') saveSchool(st, form);
    else if (form.dataset.form === 'never') addNever(st, form);
    else if (form.classList.contains('hw-afields')) saveFields(st, form);
  }

  // ============================================
  // THE PAGE
  // ============================================
  async function renderHomework(main, ctx) {
    const st = { main, ctx, params: ctx.params, today: dates.today(), kids: [], kid: null, row: null, times: [], links: [], events: [], assignments: [], steps: [],
      sessions: [], ledger: [], rewards: [], asks: [], week: [], weekFailed: false, school: null, schoolFailed: false, schoolOpen: {}, schoolOff: false, loaded: false, failed: false,
      busy: false, form: null, editor: null, fieldsDirty: false, typing: false, household: null, aiRuns: [], lastTest: null, aiTest: null };
    ctx.signal.addEventListener('abort', () => stopEditor(st));
    main.innerHTML = '<p class="loading">Loading…</p>';
    main.addEventListener('click', (e) => onClick(st, e), { signal: ctx.signal });
    main.addEventListener('submit', (e) => onSubmit(st, e), { signal: ctx.signal });
    main.addEventListener('input', (e) => {
      const x = e.target;
      if (x.closest('[data-ref="editor"]')) return;
      if (st.form && x.closest('form.hw-note, form.hw-price')) st.form.text = x.value;
      if (x.closest('form[data-form]')) st.typing = true;   // the homework time, rewards, points values and link forms
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
      if (x.dataset.act === 'link-coach') {
        const l = st.links.find((y) => y.id === x.dataset.link);
        const on = x.checked;
        if (l) write(st, () => run(sb().rpc('set_tutor_coach', { p_link: l.id, p_coach: on })), () => toast(`Coach view ${on ? 'on' : 'off'} for ${l.label}`));
        return;
      }
      // The AI planner's switch: the database refuses it with no word never to send, in its own words.
      if (x.dataset.act === 'ai-on') {
        const want = x.checked;
        if (!st.household) return;
        saveHouse(st, { homework_ai: want }, want ? 'The AI planner is on' : 'The AI planner is off').then((ok) => { if (!ok && !st.ctx.stale()) draw(st); });
        return;
      }
      if (x.dataset.act === 'link-ai') {
        const l = st.links.find((y) => y.id === x.dataset.link);
        if (l) saveLink(st, l, { can_ai: x.checked });
        return;
      }
      if (x.closest('form[data-form]')) st.typing = true;
      if (x.closest('form.hw-afields')) st.fieldsDirty = true;
    }, { signal: ctx.signal });
    // School links' folds (the how-to, what is new, what he hid) stay as they were: each write draws the page again.
    main.addEventListener('toggle', (e) => { const k = e.target.dataset && e.target.dataset.keep; if (k) st.schoolOpen[k] = e.target.open; },
      { capture: true, signal: ctx.signal });
    // On focus: read again, unless something is being typed (st.typing: the forms drawList draws afresh).
    window.addEventListener('focus', () => {
      if (ctx.stale() || st.busy || st.fieldsDirty || st.typing || (st.form && st.form.text) || (st.editor && st.editor.dirty())) return;
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
