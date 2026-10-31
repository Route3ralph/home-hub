/* =====================================================================
   HOME HUB — homework's shared pieces (window.HomePlan)
   Used by the Homework page (assets/modules/homework.js, signed in), by
   Jordan's views on My day (assets/day.js, #homework, #focus, #plan/<id>)
   and by Pat's link (day.html?h=<token>, which day.js hands to tutor()).
   No Supabase calls of its own: each page hands it an api. No storage,
   no listeners outside the element it is given, and nothing at all when
   it loads, so it also runs in Node (vm) with only a window object.
   docs/v1.3-homework.md §4 (plans), §5 (homework time, placement, the
   bars and the week strip), §7.2 (the timer), §9.4 (the editor), §9.5
   (Pat's link), §9.7 (the words).
   Every text a person typed is drawn escaped. Dates are the household's
   ('YYYY-MM-DD', from the database), counted in whole UTC days, so the
   device's clock and zone never move one; times are 'HH:MM' in the
   household's zone. The timer counts from the server's clock only.

   CONSTANTS
     LENGTHS [10, 15, 20, 25]   the focus lengths; KINDS the five step kinds; PLAIN ['start', 'step', 'check']
                                (the kinds Jordan may change); HORIZON 56 (days placement looks ahead, today first)
     LIMITS                     plan_check's: { steps 20, milestones 4, title [3, 80], dll 160, minutes [5, 60] },
                                and the texts': question 200, answer 200, note 160, decline 120 (Not now's
                                word, decide_reward's), assignment_title 120, subject 40, details 4000,
                                stretch 160
     STARTERS                   ['essay', 'test', 'reading', 'practice', 'short']

   WORDS AND TEXT
     WORDS { en, es }           every fixed word, the same keys and placeholders in both (§9.7 and the rest)
     t(key, vars, lang)         'Start · 20 min'. {tutor} is the first word of the tutor link's label: with
                                vars.tutor null (no link) a key's '_none' words are used ("Ask for help").
                                Spanish {day} values come from fmt.rel with their article ('el mié'), and
                                "de el"/"a el" become "del"/"al". Values go in as they are: escape the result.
                                An unknown key comes back as the key.
     esc(s)                     & < > " ' escaped, for HTML
     clean(text, max)           as private.clean_text: one line, no control, bidi or zero-width characters
     cleanBlock(text, max)      as private.clean_block: line breaks kept, at most 60 lines, never two blank
                                lines in a row (the teacher's text)
     friendly(err, lang, tutor) the database's homework messages in the reader's words; no connection;
                                anything else as it came (English) or a general line (Spanish)
     answer(res)                what a supabase-js answer means: 'ok', 'gone' (a token function's null: the link
                                no longer works), 'not_yet' (PGRST202: the database is older than 0005),
                                'refused' (42501, 22023, P0001, 54000, 23505, PGRST…) or 'retry' (no answer,
                                5xx, 408, 429)
     newId()                    a random version 4 uuid: the id of a row the page makes (an assignment Pat or
                                Jordan adds, a smaller step, a block, an ask)
     hashText(s), previewMark(message)  (PR B) FNV-1a hex; the mark of what an AI message carries that a person typed
     previewSeal(message)       (PR B) the hash of What Claude will see without its request and answers, sent as shown
                                (hub-jobs' homework.ts has the same function and refuses a message that differs)
     aiFailure(err)             (PR B) a failed call to hub-jobs, as a stop: 'offline' when it never reached it, else the
                                answer's own stop (no_schema, error) or 'error' (async: it reads the answer's body)

   DATES
     addDays(iso, n), daysBetween(a, b) (b − a, in days), weekday(iso) (0 = Sunday), isoWeekday(iso)
     (1 = Monday … 7 = Sunday, as events.repeat_weekdays and add_homework_time take them); null or NaN for
     anything that isn't a date
     fmt.day(iso, lang)         'Fri Nov 13' / 'vie 13 nov'      fmt.short   'Nov 13' / '13 nov'
     fmt.weekday(iso, lang)     'Fri' / 'vie'                     fmt.time    '16:30' → '4:30pm' / '16:30'
     fmt.duration(min, lang)    '45 min', '1 h', '1 h 40'
     fmt.rel(iso, today, lang)  'today', 'tomorrow', 'yesterday', a weekday within 6 days ('Wed'), else
                                'Fri Nov 13'; Spanish 'hoy', 'mañana', 'ayer', 'el mié', 'el vie 13 nov'

   PLACEMENT (§5.4). The database places every saved plan; these are its rules, for the page's own
   arithmetic (time left, the starter plans' days, a preview) and for tests' fakes.
     ended(today, asOf, window) today's homework time is over (as_of 'YYYY-MM-DDTHH:MM', window {starts, ends})
     firstDay(today, ended)     today, or tomorrow once today's homework time is over
     lastWorkDay(due, today, kind)  the day before the due date; two days before when it is 7 or more days
                                away; a lesson's do-by day itself
     horizon(today)             the 56th day from today: placement never goes past it
     homeworkDays(week, from, to)   the days with homework time, from a week's windows ([{day, window}]),
                                and past its last day by the weekdays it has
     place(steps, o)            { steps, fits, over, horizon, no_time }: steps without a day (or whose day is
                                out of range, before the step before it or without room) go on the first day
                                with room, in order; work that doesn't fit goes on the day with the most room
                                left (fits false, over = the minutes too many); the turn-in on the due date;
                                done steps never move. o: { today, due, kind, asOf, days: [{ day, window, free,
                                planned }] } (homework_week's or Pat's week rows). No homework time: no_time.
     timeLeft(days, o)          { minutes, horizon, no_time }: room from the first day to the last work day,
                                after other assignments' steps. days' planned counts every open assignment's
                                steps (as homework_week's does); o.own (this one's steps) is given back.
     workLeft(steps)            the minutes of steps not done
     spare(steps, due)          whole days between the last work step and the due date (null while one has no day)

   STARTER PLANS (§4.6)
     guess(title, kind)         the starter plan a title suggests: test, quiz → 'test'; essay, project →
                                'essay'; read → 'reading'; else a lesson's 'practice', or 'short'
     starter(key, o)            the steps, [{ kind, title, done_looks_like, minutes, day: null, source:
                                'template' }], in o.lang; minutes cut to o.length (his first length; the
                                turn-in stays 5). Reading: o.parts parts (1–10, 2 when none). Practice: one
                                block a day on his homework days up to the do-by day (o.today, o.due, o.asOf,
                                o.week), each with its day, the last a milestone; with o.kind 'assignment', up
                                to its last work day (lastWorkDay: never on the due date, the turn-in's day).
     check(steps, o)            null, or { key, i }: the first rule the plan breaks (plan_check's, and
                                plan_save's "nothing new or moved in the past" and "only the turn-in on the
                                due date"): too_many_steps, too_many_milestones, one_turn_in, turn_in_last,
                                same_id, bad_kind, title_len, dll_len, minutes_range, after_due, due_day,
                                in_past. o: { due, today, kind, orig: { <step id>: its saved day } }. As in
                                the database: after_due is past the later of the due date and today; due_day
                                is for an assignment due after today (a lesson's do-by day is a work day),
                                for a step new or moved there. Done steps are taken as they are.

   DRAWING (HTML strings; user text escaped)
     bars(work, time, o)        Work left and Homework time left, each to scale against the longer; "Doesn't
                                fit: …" when work is longer; o: { lang, horizon ("next 8 weeks"), no_time }.
                                time null: the work bar alone.
     week(days, o)              the week strip: o.count (7) days from o.today, each "45 free · 30 planned"
                                or "20 min over" or "—", with its busy blocks in the window; o.titles shows
                                busy titles (the Homework page), else "Busy" (Pat's link)
     pace(ratio, lang)          'Steps take about 1.3× the planned time' ('' without a pace)
     focused(week, lang)        '1 h 40 focused this week (last week 1 h 15)' from the view's week
     ring(fraction, o)          the timer's shrinking ring, an SVG (class is-done when empty)

   TIMELINES (HTML strings; user text escaped; '' when there is nothing to draw). Days are columns counted
   in whole days from o.today ('YYYY-MM-DD'), so the Nov 1 clock change moves nothing; a header of days
   (the month on the first day and each 1st, the weekday's letter, the date; each week from its Monday;
   today marked); plan.css draws them light and dark, a box too narrow scrolls inside itself.
     overview(items, o)         the parents' Homework page and Pat's link: a row per open assignment (status open
                                or none), by due date, over o.days (21) days. A bar from its first step day (today
                                when it has no plan or that day is earlier) to its due date, the done share filled;
                                milestones as diamonds (filled when done) on their days when the steps are known,
                                else next_milestone's; one not done whose day has passed on today's column (is-behind);
                                the due date a flag; a due date past the days an arrow and "due <day>" in its line;
                                an overdue one marked late (is-late, on today's column only). Each row links to
                                o.link(id) when it gives an href, and carries its label for screen readers ("Essay ·
                                steps from Mon Nov 2 · milestone Outline Thu Nov 5 · due Fri Nov 13 · 2 of 9 steps
                                done"); the line under its name: class · 2 of 9 · due Fri Nov 13. '' with no open one.
                                items: [{ id, kind, title, subject, due_date, status, steps, steps_done?,
                                next_milestone? }], steps either [{ kind, day, done }] (fromRows', his view's once
                                given, Pat's assignment's) or Pat's list's count with steps_done; o: { today, days,
                                lang, link }
     chart(a, o)                one assignment's chart (the parents' #/homework/<id>, Pat's assignment): days from
                                its first step's day (or today, when earlier) to the due date, at most 63 (past them
                                an arrow and "due <day>"); a row per phase, the steps up to and including each
                                milestone (its title, with a diamond), then "Check and turn in" ("The plan" with no
                                milestone), each "4 steps · 1 h 05"; each step a block on its day with its minutes
                                (a day's stacked), done filled, a milestone's diamond, the turn-in's flag, one not
                                done whose day has passed behind ("from earlier"); today's line; days without
                                homework time shaded when o.week (homework_week's or Pat's week rows, as
                                homeworkDays reads them) has any. '' for a plan on fewer than 2 distinct days.
                                a: { kind, due_date, steps: [{ kind, title, minutes, day, done }] }; o: { today,
                                lang, week }
     path(a, o)                 Jordan's path (My day): a dot a day from today ("Today") to the due date (a star),
                                at most 14 (then "… due <day>"); flags on the milestones' days (filled when done;
                                one not done whose day has passed on today's; those done before today counted
                                first); days with his open steps marked (has-work). One line on top: "Next flag:
                                Outline · Thu (3 days) · +20 points now" (today, tomorrow, a weekday and its days,
                                "in 9 days", "from Fri"); the points only with o.points, what his tick pays (his view
                                doesn't carry it: left out rather than guessed); every flag done: "Every flag done!
                                Due Fri Nov 13 (11 days)"; no milestones: "Due …". '' without steps, once done, or
                                past its due date (his screen never says late). a: his view's assignment ({ status,
                                due_date, steps }); o: { today, lang, points }

   THE TIMER (§7.2): never the device's clock
     ms(ts)                     a database timestamp ('…Z', '…+00:00', microseconds) → epoch ms, NaN otherwise
     timer(x, perf)             { endLocal, totalMs }, endLocal = perf + (ends_at − server_now), on the
                                performance.now() clock. x: { ends_at, server_now, started_at?, minutes? }
                                (his view's session and server_now) or { ends_in_s, minutes } (the card).
                                perf: performance.now() when the answer came.
     left(tm, perf)             { ms, seconds, minutes (rounded up), fraction (of the ring), done }
     audioAt(tm, perf, now)     the AudioContext time to start the chime at, given its currentTime now
     pointsLine(end, lang)      the end screen's line from what the server saw, end: { seen, focus, on_time,
                                capped }: '+12 · 12 minutes', '+20 · 20 minutes · +10 on time', 'Under a minute:
                                no points this time.', "Today's limit reached."
     onTimeLine(onTime, lang)   'start by 4:40pm for +10' from his view's on_time ({ until, done, points? })
     estimate(earn, s, minutes) what his timer counts up to while a block runs, from his view's session.earn
                                ({ per_minute, on_time, room }) and the seconds since its start by the server's
                                clock: a point a minute, the on-time points once 5 minutes are seen, never past
                                the block's length or the day's cap (room); 0 without earn
     goalBar(goal, o)           the next-reward bar from his view's goal: "You can get <reward> now!" or "6 points
                                to <reward>", with a bar; o: { lang, extra (points his timer counts, not paid yet) }

   THE PLAN EDITOR (§9.4)
     fromRows(row, stepRows, o) the Homework page's assignments row and homework_steps rows → the editor's
                                assignment (below); with o.week, o.today and o.asOf also its time_left
     const ed = HomePlan.editor(el, opts)
       draws into el (and listens only there). opts:
         role       'family' | 'tutor' (the whole plan: kinds, days, minutes, milestones; starter plans,
                    Place again, Give) or 'kid' (plain steps not done: move, rename, minutes, day, delete,
                    add; milestones and the turn-in locked; Re-plan)
         lang, today, asOf ('YYYY-MM-DDTHH:MM'), serverNow (the answer's server_now: with asOf, gives the
                    household's day of a timestamp), length (his first length), kid (his first name),
                    tutor (the first word of the tutor link's label, or null), week ([{ day, window, free,
                    planned }] for the day picker's homework days and Practice)
         api        { save({ steps, rev, give }), reload(), replan() (kid) }: each a Promise of
                    { assignment } (the plan as saved), { error } (supabase-js's error) or { gone: true }.
                    steps is the whole plan in order: [{ id?, kind, title, done_looks_like, minutes, day,
                    source }] (save_homework_plan's, tutor_plan_by_token's and plan_by_token's p_steps).
         toast(text, { action: { label, onClick } }), friendly(err) (optional), onGone(), onSaved(assignment),
         showDetails (false: no "Teacher's text" fold),
         ai (PR B, not for his role): { on, sent, preview({ kind, request, answers }), send({ kind, request, answers, key }),
                    state(), draft(action), stretch(text) }: What Claude will see (open while what would be sent differs
                    from what was last sent from this device, by previewMark), Send to Claude, "Thinking…" with a read
                    every 5 seconds until the run's lease ends, the draft labelled "Suggested by AI (Claude)" (or
                    "Suggested changes" beside a given plan) with Use this plan, Undo, Dismiss and Ask again, and each
                    stop's words (§6.9); the assignment's ai: { state, stop, draft, prev, at }
       the assignment: { id, kind, title, subject, due_date, details?, status, plan_rev, given_at, given_by
         ('tutor' | 'family' | 'kid'), given_by_name?, time_left, horizon, no_time, steps: [{ id, kind,
         title, done_looks_like, minutes, day, source, done, checked, moved_from }] }
       ed.set(assignment, moreOpts) draws it (and drops unsaved changes); ed.get() the assignment as last
       set; ed.dirty() unsaved changes; ed.stop() no more drawing or calls.
       Hooks: .plan-step[data-i] rows, select[name=day], [data-act=more] (⋯) with [name=title], [name=dll],
       select[name=minutes], select[name=kind], [data-act=up|down|delete|close]; [data-act=starter] and
       [data-starter=<key>], [data-act=add|place|replan|save|give]; .plan-msg.

   PAT'S LINK (§9.5)
     const ctl = HomePlan.tutor(el, opts)
       opts: api { view(assignmentId | null, part), assignment(fields), plan(assignmentId, steps, rev, give),
             step(stepId, action, text), ai(body) (PR B: hub-jobs' homework_ai with the link's token, as functions.invoke
             answers) }: each the supabase-js answer ({ data, error, status }) of
             tutor_view_by_token(p_token, p_assignment, p_part), tutor_assignment_by_token(p_token,
             p_fields), tutor_plan_by_token(p_token, p_assignment, p_steps, p_rev, p_give) and
             tutor_step_by_token(p_token, p_step, p_action, p_text);
             lang (until the link's language is known), toast, onGone(), go(hash) (default: location.hash),
             sent ({ get(id), set(id, mark) }: the preview's "last sent" marks on the device, or null)
       ctl.show(hash)   the page calls it on load and on every hashchange: '#a/<id>' an assignment and its
                        plan, '#new/assignment' and '#new/lesson' the add form, anything else the list
       ctl.refresh()    read again (on focus and visibilitychange), unless something is being edited
       ctl.stop()
       Calls go one at a time. A null answer draws "This link no longer works…" and calls onGone; PGRST202
       "This link doesn't work yet."; no connection, "Try again". A check's answer with used_up: true says
       this week's milestone points are used up.
   ===================================================================== */
(function () {
  'use strict';

  const LENGTHS = Object.freeze([10, 15, 20, 25]);
  const KINDS = Object.freeze(['start', 'step', 'milestone', 'check', 'turn_in']);
  const PLAIN = Object.freeze(['start', 'step', 'check']);
  const HORIZON = 56;
  const LIMITS = Object.freeze({
    steps: 20, milestones: 4, title: Object.freeze([3, 80]), dll: 160, minutes: Object.freeze([5, 60]),
    question: 200, answer: 200, note: 160, decline: 120, assignment_title: 120, subject: 40, details: 4000, stretch: 160,
  });
  const STARTERS = Object.freeze(['essay', 'test', 'reading', 'practice', 'short']);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ============================================
  // WORDS (fixed words only; titles, notes and questions stay as typed)
  // ============================================
  const WORDS = {
    en: {
      // His screens (§9.7)
      homework: 'Homework', now: 'Now', tonight: 'Tonight', due_soon: 'Due soon', start_n: 'Start · {n} min',
      on_time: 'On time · +{n} once 5 minutes are done', start_by: 'start by {time} for +{n}',
      stuck: "I'm stuck", make_smaller: 'Make it smaller',
      ask_tutor: 'Ask {tutor}', ask_tutor_none: 'Ask for help',
      next_step: 'Next step', keep_going: 'Keep going: {title}', end_block: 'End the block', step_done: 'Step done',
      more_to_do: 'More to do', what_done: 'What did you get done? (optional)', take_break: 'Take 5 minutes.',
      not_today: 'Not today', from_day: 'from {day}', from_earlier: 'From earlier · {n} steps · {m} min', replan: 'Re-plan',
      behind: 'Behind the plan',
      pick_new_day: '{title} was planned for {day}. Pick a new day with {tutor}.',
      pick_new_day_none: '{title} was planned for {day}. Pick a new day with your parents.',
      add_homework: '+ Homework', quick: 'Quick',
      plan_with_tutor: 'Plan this one with {tutor}.', plan_with_tutor_none: 'Plan this one with your parents.',
      no_plan: 'No plan yet', being_planned: 'Being planned', work_left: 'Work left', time_left: 'Homework time left',
      waiting_check: '+{n} when {tutor} checks it', waiting_check_none: "+{n} when it's checked",
      milestone_now: '+{n} now · +{m} more when {tutor} checks it', milestone_now_none: "+{n} now · +{m} more when it's checked",
      not_yet: 'Not yet: {note}', coach_note: '{who}: {note}',
      milestone_lock: 'Milestones are checkpoints you set with {tutor}. Change them together.',
      milestone_lock_none: 'Milestones are checkpoints you set with your parents. Change them together.',
      under_minute: 'Under a minute: no points this time.', limit_reached: "Today's limit reached.",
      goal_need: '{n} points to {title}', goal_need_one: '1 point to {title}', goal_now: 'You can get {title} now!',
      goal_after: '{title} when this block ends!', so_far: '+{n} so far', res_time: "Time's up",
      waiting_parent: 'Waiting for a parent', suggest_reward: 'Suggest a reward', tell_parent: 'Tell a parent you asked.',
      who_sees: '{tutor} and the grown-ups in your family see your plan and your notes. The grown-ups see your points.',
      who_sees_none: 'The grown-ups in your family see your plan, your notes and your points.',
      pace: 'Steps take about {x}× the planned time', chime_silent: 'Chime even on silent',
      needs_signal: 'Starting needs a connection.', open_first: 'Finish the block you started first.',
      no_day_left: "No homework day before it's due has room. Re-plan, make it smaller, or ask {tutor}.",
      no_day_left_none: "No homework day before it's due has room. Re-plan, make it smaller, or ask for help.",
      changed: 'This plan was changed since you opened it.',
      link_gone: 'This link no longer works. Ask the family for a new one.', link_not_yet: "This link doesn't work yet.",
      focus_left: 'Focus · {n} min left', block_ended: 'Your {n}-minute block ended at {time}. How did it go?',
      keep_screen: 'Tip: keep the phone face up; the timer is right when you look.',
      points_seen: '+{n} · {m} minutes', minutes_only: '{m} minutes', on_time_paid: '+{n} on time',
      focused_week: '{t} focused this week', focused_vs: '{t} focused this week (last week {u})',
      turn_in: 'Turn it in',
      // Dates
      rel_today: 'today', rel_tomorrow: 'tomorrow', rel_yesterday: 'yesterday', in_days: '({n} days)', days_ago: '({n} days ago)',
      // The editor (§9.4)
      due_on: 'due {day}', do_by: 'do by {day}', teachers_text: "Teacher's text", starter_btn: 'Start from a starter plan',
      starter_pick: 'Pick a starter plan.', starter_replace: 'It replaces the {n} steps not done yet.',
      starter_essay: 'Essay or project', starter_test: 'Test', starter_reading: 'Reading', starter_practice: 'Practice', starter_short: 'Short',
      parts: 'Parts to read', cancel: 'Cancel', add_step: 'Add a step', place_again: 'Place again', save: 'Save',
      give: 'Give {kid} this plan', given_line: "On {kid}'s My day since {day} · by {who}", given_line_nodate: "On {kid}'s My day · by {who}",
      who_you: 'you', who_family: 'the family', who_tutor: 'the tutor',
      saved: 'Saved', given_toast: 'Given to {kid}', placed: 'Placed again', replanned: 'Planned again from today',
      no_steps: 'No steps yet. Start from a starter plan, or add a step.', no_steps_kid: 'No steps yet.',
      untitled: '(no title yet)', more_for: 'More for {title}', day_for: 'Day for {title}', dll_line: 'Done looks like: {text}',
      f_title: 'Title', f_dll: 'Done looks like', f_minutes: 'Minutes', f_kind: 'Kind', move_up: 'Move up', move_down: 'Move down',
      delete: 'Delete', done_edit: 'Done',
      kind_start: 'First small step', kind_step: 'Step', kind_milestone: 'Milestone', kind_check: 'Check against the instructions', kind_turn_in: 'Turn it in',
      tag_start: 'start', tag_milestone: 'milestone', tag_check: 'check', tag_turn_in: 'turn in',
      hw_days: 'Homework days', other_days: 'Other days', not_hw_day: 'not a homework day', placed_on_save: 'placed when saved',
      moved_from: 'moved from {day}', checkpoint_short: 'A checkpoint: change it with {tutor}', checkpoint_short_none: 'A checkpoint: change it with your parents',
      fits: 'Fits', fits_spare: 'Fits · {n} days spare', fits_spare_1: 'Fits · 1 day spare',
      doesnt_fit: "Doesn't fit: add homework time, drop a step or talk to the teacher.", no_time: 'No homework time set', next_8_weeks: 'next 8 weeks',
      changed_reload: 'Changed since you opened it: here it is now.', save_first: 'Save your changes first.',
      step_n: 'Step {n}: {text}',
      chk_too_many_steps: 'At most 20 steps.', chk_too_many_milestones: 'At most 4 milestones.', chk_one_turn_in: 'Only one turn-in step.',
      chk_turn_in_last: 'The turn-in step goes last.', chk_same_id: 'This step is in the plan twice.', chk_bad_kind: 'Pick a kind for this step.',
      chk_title_len: 'Give it a title of 3 to 80 characters.', chk_dll_len: '"Done looks like" is at most 160 characters.',
      chk_minutes_range: 'A step takes 5 to 60 minutes.', chk_after_due: "A step can't be after the due date.",
      chk_due_day: 'Only the turn-in goes on the due date.', chk_in_past: "A new or moved step can't go in the past.",
      // The week strip
      w_free: '{n} free', w_free_planned: '{n} free · {m} planned', w_over: '{n} min over', w_busy: 'Busy',
      // The timelines: the overview, an assignment's chart, his path
      tl_next_weeks: 'Next {n} weeks', tl_overview: 'Open assignments, {from} to {to}', tl_chart: 'Plan by day, {from} to {to}',
      tl_from: 'steps from {day}', tl_no_plan: 'no plan yet', tl_ms: 'milestone {title} {day}', tl_ms_done: 'milestone {title} done',
      tl_steps_done: '{n} of {m} steps done', tl_late: 'late', tl_behind: 'from earlier',
      tl_phase_end: 'Check and turn in', tl_phase_all: 'The plan', tl_n_steps: '{n} steps', tl_n_steps_one: '1 step',
      tl_key_due: 'due date', tl_key_done: 'done', tl_key_off: 'no homework time',
      tl_next_flag: 'Next flag: {title}', tl_points_now: '+{n} points now', tl_all_flags: 'Every flag done!', tl_due_when: 'Due {when}',
      tl_in_days: 'in {n} days', tl_today: 'Today', tl_path: 'From today to {to}', tl_flag: 'flag {title} {day}', tl_flag_done: 'flag {title} done',
      tl_flags_won: '{n} flags done', tl_flags_won_one: '1 flag done',
      // Pat's link (§9.5)
      tutor_title: 'Homework · {kid}', tutor_hi: 'Hi {label} · Link ends {day}',
      tutor_coach: "Start with what he did. Ask what's next and when he'll start it.",
      sec_check: 'To check', sec_talk: 'To talk about', sec_questions: 'Questions', sec_plans: 'Plans to look at',
      sec_assignments: 'Assignments', sec_week: 'His week', sec_record: 'Last 14 days', sec_qa: 'Questions and notes',
      looks_done: 'Looks done', not_yet_btn: 'Not yet', note_good: "Say what's good about it (optional)", note_missing: "Say what's missing",
      your_answer: 'Your answer', answer_btn: 'Answer', change_answer: 'Change', answer_line: 'Answer: {text}',
      ticked_on: 'ticked {day}', talk_line: '"{title}" was planned for {day} · Ask what got in the way, then pick a new day together.',
      plan_not_given: 'Plan not given yet', add_assignment: '+ Assignment', add_lesson: '+ Lesson', n_of_m: '{n} of {m}',
      added_by_kid: 'added by {kid}', lesson_tag: 'lesson', with_you: 'with you', next_week: 'The 7 days after',
      from_school: 'from school', school_gone: 'no longer on the school site', school_moved: 'the school moved it to {day}',
      res_stopped: 'Stopped', res_expired: 'Not answered', done_30: 'Done (30 days)', st_done: 'Done', st_dropped: 'Dropped', st_open: 'Open',
      back: '‹ All homework', new_assignment: 'New assignment', new_lesson: 'New lesson',
      a_kind: 'This is', kind_assignment: 'An assignment', kind_lesson: 'A lesson', a_title: 'Title', a_subject: 'Class',
      a_due: 'Due', a_do_by: 'Do by', a_details: "Teacher's text", a_instructions: 'Instructions for {kid}',
      live_text: "To use a photo of the sheet, copy its text with your phone's Live Text and paste it here. Photos aren't sent anywhere.",
      a_stretch: 'An optional question for {kid} (an interesting angle)', a_status: 'Status', a_save: 'Save', a_add: 'Add',
      need_title: 'Give it a title.', need_due: 'Pick a due date.', too_long: "That's too long.",
      checked_toast: 'Checked: {title}', sent_back: 'Sent back with your note', answer_sent: 'Answer sent', undo: 'Undo',
      milestones_used_up: "This week's milestone points are used up.",
      qa_asked: '{kid} asked: {text}', qa_by: '{who}: {text}', who_kid: '{kid}',
      // Messages
      offline: "Can't reach Home Hub. Check your internet connection and try again.",
      refresh_failed: "Couldn't refresh just now. Check your internet connection.",
      error_generic: 'Something went wrong. Try again.', try_again: 'Try again', loading: 'Loading…',
      step_not_yours: "That step isn't on your plan.", own_tick_only: 'Only your own tick can be undone, for 15 minutes.',
      checkpoint: "That's a checkpoint. Change it with {tutor}.", checkpoint_none: "That's a checkpoint. Change it with your parents.",
      block_not_yours: "That block isn't yours.", too_much_today: "That's a lot for one day. Carry on tomorrow.",
      not_enough: 'Not enough points yet.', points_off: 'Points are off.', choose_length: 'Choose 10, 15, 20 or 25 minutes.',
      set_time_first: 'Set a homework time first.', not_on_link: "That assignment isn't on this link.", say_missing: "Say what's missing.",
      step_not_on_link: "That step isn't on this link.", plan_not_yours: "That plan isn't on your list.",
      closed: 'This assignment is done or dropped. Open it again first.', plan_too_long: 'That plan is too long.',
      asks_full: 'Three asks are waiting already. Wait for a parent first.', suggest_full: 'Five suggestions are waiting already. Wait for a parent first.',
      own_full: 'Fifteen of your own are open already.',
      points_spent: 'Those points are already spent.', cant_save: "That can't be saved.",
      ask_parent: 'Ask a parent for that one.', instant_done: "That's all the instant rewards for today. Ask a parent for this one.",
      price_changed: "That reward's price changed. Look again before you get it.",
      // The AI planner (PR B, §6, §9.4): Pat's link and the Homework page only, never his screens
      ai_preview: 'What Claude will see',
      ai_preview_hint: "This is all that goes to Anthropic (Claude), with the names Home Hub knows, links, emails and phone numbers taken out. Change the teacher's text first if anything else shouldn't go.",
      ai_preview_failed: "Couldn't load what Claude will see. Check the connection.",
      ai_send: 'Send to Claude', ai_thinking: 'Thinking about a plan… (usually under a minute)', ai_thinking_short: 'Thinking…',
      ai_label: '{what} · Suggested by AI (Claude). Check it with {kid}.', ai_draft: 'Draft', ai_changes: 'Suggested changes',
      ai_use: 'Use this plan', ai_undo: 'Undo', ai_dismiss: 'Dismiss', ai_draft_ready: 'AI draft ready',
      ai_loaded: 'The draft is in the plan below, not saved yet. Change it with {kid}, then Save.',
      ai_ask_for: 'Ask for changes', ai_note: 'Or say what to change (optional)', ai_again: 'Ask again',
      ai_chip_smaller: 'Smaller steps', ai_chip_fewer: 'Fewer steps', ai_chip_no_wed: 'Nothing on Wednesday', ai_chip_later: 'Start later',
      ai_chip_writing: 'More time for writing',
      ai_questions: 'Questions for {kid}', ai_answer: "{kid}'s answer (optional)", ai_optional: 'Optional: {text}', ai_note_adult: 'Note for you: {text}',
      ai_over: "Doesn't fit his homework time: {n} min too many.", ai_fits: 'Fits his homework time.', ai_mark: 'AI', ai_mark_label: 'Suggested by AI',
      ai_too_long: 'Ask for changes in at most 200 characters.',
      ai_s_not_set_up: "AI help isn't set up yet. Start from a starter plan.",
      ai_s_cap: 'AI help is used up for today. Start from a starter plan.',
      ai_s_month: 'AI help is used up for this month. Start from a starter plan.',
      ai_s_auth: "AI help isn't working right now. Start from a starter plan.",
      ai_s_spend: 'AI help is done for this month. Start from a starter plan.',
      ai_s_billing: 'AI help is paused. Start from a starter plan.',
      ai_s_later: "The AI couldn't make a plan just now. Try again later, or start from a starter plan.",
      ai_s_refusal: "The AI couldn't help with this one. Start from a starter plan.",
      ai_s_changed: 'What Claude will see has changed. Read it again above, then send.',
    },
    es: {
      homework: 'Tarea', now: 'Ahora', tonight: 'Esta tarde', due_soon: 'Para pronto', start_n: 'Empezar · {n} min',
      on_time: 'A tiempo · +{n} cuando lleves 5 minutos', start_by: 'empieza antes de las {time} para +{n}',
      stuck: 'Estoy atascado', make_smaller: 'Hazlo más pequeño',
      ask_tutor: 'Preguntar a {tutor}', ask_tutor_none: 'Pedir ayuda',
      next_step: 'Siguiente paso', keep_going: 'Sigue con: {title}', end_block: 'Terminar el bloque', step_done: 'Paso hecho',
      more_to_do: 'Queda más', what_done: '¿Qué hiciste? (opcional)', take_break: 'Descansa 5 minutos.',
      not_today: 'Hoy no', from_day: 'de {day}', from_earlier: 'De antes · {n} pasos · {m} min', replan: 'Volver a planear',
      behind: 'Por detrás del plan',
      pick_new_day: '{title} estaba planeado para {day}. Elige otro día con {tutor}.',
      pick_new_day_none: '{title} estaba planeado para {day}. Elige otro día con tus padres.',
      add_homework: '+ Tarea', quick: 'Rápido',
      plan_with_tutor: 'Planéalo con {tutor}.', plan_with_tutor_none: 'Planéalo con tus padres.',
      no_plan: 'Todavía sin plan', being_planned: 'En preparación', work_left: 'Trabajo pendiente', time_left: 'Tiempo de tarea que queda',
      waiting_check: '+{n} cuando {tutor} lo revise', waiting_check_none: '+{n} cuando lo revisen',
      milestone_now: '+{n} ahora · +{m} más cuando {tutor} lo revise', milestone_now_none: '+{n} ahora · +{m} más cuando lo revisen',
      not_yet: 'Todavía no: {note}', coach_note: '{who}: {note}',
      milestone_lock: 'Los hitos son puntos de control que fijaste con {tutor}. Cámbienlos juntos.',
      milestone_lock_none: 'Los hitos son puntos de control que fijaste con tus padres. Cámbienlos juntos.',
      under_minute: 'Menos de un minuto: esta vez sin puntos.', limit_reached: 'Llegaste al límite de hoy.',
      goal_need: '{n} puntos para {title}', goal_need_one: '1 punto para {title}', goal_now: '¡Ya puedes conseguir {title}!',
      goal_after: '¡{title} al terminar este bloque!', so_far: '+{n} hasta ahora', res_time: 'Se acabó el tiempo',
      waiting_parent: 'Esperando a tus padres', suggest_reward: 'Proponer un premio', tell_parent: 'Avisa a tus padres de que lo pediste.',
      who_sees: '{tutor} y los adultos de tu familia ven tu plan y tus notas. Los adultos ven tus puntos.',
      who_sees_none: 'Los adultos de tu familia ven tu plan, tus notas y tus puntos.',
      pace: 'Los pasos llevan unas {x} veces el tiempo previsto', chime_silent: 'Sonar aunque esté en silencio',
      needs_signal: 'Para empezar hace falta conexión.', open_first: 'Termina primero el bloque que empezaste.',
      no_day_left: 'No queda ningún día de tarea con sitio antes de la entrega. Vuelve a planear, hazlo más pequeño o pregunta a {tutor}.',
      no_day_left_none: 'No queda ningún día de tarea con sitio antes de la entrega. Vuelve a planear, hazlo más pequeño o pide ayuda.',
      changed: 'Este plan cambió desde que lo abriste.',
      link_gone: 'Este enlace ya no funciona. Pide uno nuevo a la familia.', link_not_yet: 'Este enlace todavía no funciona.',
      focus_left: 'Concentración · quedan {n} min', block_ended: 'Tu bloque de {n} minutos terminó a las {time}. ¿Qué tal fue?',
      keep_screen: 'Consejo: deja el teléfono boca arriba; el temporizador va bien cuando lo miras.',
      points_seen: '+{n} · {m} minutos', minutes_only: '{m} minutos', on_time_paid: '+{n} a tiempo',
      focused_week: '{t} de concentración esta semana', focused_vs: '{t} de concentración esta semana (la semana pasada {u})',
      turn_in: 'Entregarlo',
      rel_today: 'hoy', rel_tomorrow: 'mañana', rel_yesterday: 'ayer', in_days: '({n} días)', days_ago: '(hace {n} días)',
      due_on: 'para {day}', do_by: 'hacer para {day}', teachers_text: 'Texto del profesor', starter_btn: 'Empezar con un plan base',
      starter_pick: 'Elige un plan base.', starter_replace: 'Reemplaza los {n} pasos que faltan.',
      starter_essay: 'Redacción o proyecto', starter_test: 'Examen', starter_reading: 'Lectura', starter_practice: 'Práctica', starter_short: 'Corta',
      parts: 'Partes para leer', cancel: 'Cancelar', add_step: 'Añadir un paso', place_again: 'Colocar de nuevo', save: 'Guardar',
      give: 'Darle este plan a {kid}', given_line: 'En el Mi día de {kid} desde {day} · por {who}', given_line_nodate: 'En el Mi día de {kid} · por {who}',
      who_you: 'ti', who_family: 'la familia', who_tutor: 'el tutor',
      saved: 'Guardado', given_toast: 'Plan dado a {kid}', placed: 'Colocado de nuevo', replanned: 'Planeado de nuevo desde hoy',
      no_steps: 'Todavía no hay pasos. Empieza con un plan base o añade un paso.', no_steps_kid: 'Todavía no hay pasos.',
      untitled: '(todavía sin título)', more_for: 'Más de {title}', day_for: 'Día de {title}', dll_line: 'Hecho se ve así: {text}',
      f_title: 'Título', f_dll: 'Hecho se ve así', f_minutes: 'Minutos', f_kind: 'Tipo', move_up: 'Subir', move_down: 'Bajar',
      delete: 'Borrar', done_edit: 'Listo',
      kind_start: 'Primer paso pequeño', kind_step: 'Paso', kind_milestone: 'Hito', kind_check: 'Revisar con las instrucciones', kind_turn_in: 'Entregarlo',
      tag_start: 'inicio', tag_milestone: 'hito', tag_check: 'revisión', tag_turn_in: 'entrega',
      hw_days: 'Días de tarea', other_days: 'Otros días', not_hw_day: 'no es día de tarea', placed_on_save: 'se coloca al guardar',
      moved_from: 'movido de {day}', checkpoint_short: 'Un punto de control: cámbialo con {tutor}', checkpoint_short_none: 'Un punto de control: cámbialo con tus padres',
      fits: 'Cabe', fits_spare: 'Cabe · {n} días de margen', fits_spare_1: 'Cabe · 1 día de margen',
      doesnt_fit: 'No cabe: añade tiempo de tarea, quita un paso o habla con el profesor.', no_time: 'No hay tiempo de tarea', next_8_weeks: 'próximas 8 semanas',
      changed_reload: 'Cambió desde que lo abriste: así está ahora.', save_first: 'Guarda primero tus cambios.',
      step_n: 'Paso {n}: {text}',
      chk_too_many_steps: 'Como mucho 20 pasos.', chk_too_many_milestones: 'Como mucho 4 hitos.', chk_one_turn_in: 'Solo un paso de entrega.',
      chk_turn_in_last: 'El paso de entrega va al final.', chk_same_id: 'Este paso está dos veces en el plan.', chk_bad_kind: 'Elige un tipo para este paso.',
      chk_title_len: 'Ponle un título de 3 a 80 caracteres.', chk_dll_len: '"Hecho se ve así" tiene como mucho 160 caracteres.',
      chk_minutes_range: 'Un paso dura de 5 a 60 minutos.', chk_after_due: 'Un paso no puede ir después de la fecha de entrega.',
      chk_due_day: 'Solo la entrega va en la fecha de entrega.', chk_in_past: 'Un paso nuevo o movido no puede ir en el pasado.',
      w_free: '{n} libres', w_free_planned: '{n} libres · {m} planeados', w_over: '{n} min de más', w_busy: 'Ocupado',
      tl_next_weeks: 'Las próximas {n} semanas', tl_overview: 'Trabajos abiertos, del {from} al {to}', tl_chart: 'Plan por días, del {from} al {to}',
      tl_from: 'pasos desde {day}', tl_no_plan: 'todavía sin plan', tl_ms: 'hito {title} {day}', tl_ms_done: 'hito {title} hecho',
      tl_steps_done: '{n} de {m} pasos hechos', tl_late: 'con retraso', tl_behind: 'de antes',
      tl_phase_end: 'Revisar y entregar', tl_phase_all: 'El plan', tl_n_steps: '{n} pasos', tl_n_steps_one: '1 paso',
      tl_key_due: 'entrega', tl_key_done: 'hecho', tl_key_off: 'sin tiempo de tarea',
      tl_next_flag: 'Siguiente bandera: {title}', tl_points_now: '+{n} puntos ahora', tl_all_flags: '¡Todas las banderas hechas!', tl_due_when: 'Se entrega {when}',
      tl_in_days: 'en {n} días', tl_today: 'Hoy', tl_path: 'De hoy al {to}', tl_flag: 'bandera {title} {day}', tl_flag_done: 'bandera {title} hecha',
      tl_flags_won: '{n} banderas hechas', tl_flags_won_one: '1 bandera hecha',
      tutor_title: 'Tarea · {kid}', tutor_hi: 'Hola, {label} · El enlace vence el {day}',
      tutor_coach: 'Empieza por lo que hizo. Pregunta qué sigue y cuándo lo empezará.',
      sec_check: 'Por revisar', sec_talk: 'Para hablar', sec_questions: 'Preguntas', sec_plans: 'Planes por mirar',
      sec_assignments: 'Trabajos', sec_week: 'Su semana', sec_record: 'Últimos 14 días', sec_qa: 'Preguntas y notas',
      looks_done: 'Se ve terminado', not_yet_btn: 'Todavía no', note_good: 'Di qué tiene de bueno (opcional)', note_missing: 'Di qué falta',
      your_answer: 'Tu respuesta', answer_btn: 'Responder', change_answer: 'Cambiar', answer_line: 'Respuesta: {text}',
      ticked_on: 'marcado {day}', talk_line: '"{title}" estaba planeado para {day} · Pregunta qué se lo impidió y elijan juntos otro día.',
      plan_not_given: 'Plan todavía sin dar', add_assignment: '+ Trabajo', add_lesson: '+ Lección', n_of_m: '{n} de {m}',
      added_by_kid: 'añadido por {kid}', lesson_tag: 'lección', with_you: 'contigo', next_week: 'Los 7 días siguientes',
      from_school: 'de la escuela', school_gone: 'ya no está en el sitio de la escuela', school_moved: 'la escuela la pasó a {day}',
      res_stopped: 'Parado', res_expired: 'Sin respuesta', done_30: 'Hechos (30 días)', st_done: 'Hecho', st_dropped: 'Cancelado', st_open: 'Abierto',
      back: '‹ Toda la tarea', new_assignment: 'Trabajo nuevo', new_lesson: 'Lección nueva',
      a_kind: 'Es', kind_assignment: 'Un trabajo', kind_lesson: 'Una lección', a_title: 'Título', a_subject: 'Asignatura',
      a_due: 'Fecha de entrega', a_do_by: 'Hacer para', a_details: 'Texto del profesor', a_instructions: 'Instrucciones para {kid}',
      live_text: 'Para usar una foto de la hoja, copia su texto con Texto en vivo del teléfono y pégalo aquí. Las fotos no se envían a ningún sitio.',
      a_stretch: 'Una pregunta opcional para {kid} (un ángulo interesante)', a_status: 'Estado', a_save: 'Guardar', a_add: 'Añadir',
      need_title: 'Ponle un título.', need_due: 'Elige una fecha.', too_long: 'Es demasiado largo.',
      checked_toast: 'Revisado: {title}', sent_back: 'Devuelto con tu nota', answer_sent: 'Respuesta enviada', undo: 'Deshacer',
      milestones_used_up: 'Los puntos de hitos de esta semana ya se usaron.',
      qa_asked: '{kid} preguntó: {text}', qa_by: '{who}: {text}', who_kid: '{kid}',
      offline: 'No se puede conectar con Home Hub. Revisa tu conexión a internet e inténtalo de nuevo.',
      refresh_failed: 'No se pudo actualizar ahora. Revisa tu conexión a internet.',
      error_generic: 'Algo salió mal. Inténtalo de nuevo.', try_again: 'Intentar de nuevo', loading: 'Cargando…',
      step_not_yours: 'Ese paso no está en tu plan.', own_tick_only: 'Solo puedes deshacer lo que marcaste tú, durante 15 minutos.',
      checkpoint: 'Es un punto de control. Cámbialo con {tutor}.', checkpoint_none: 'Es un punto de control. Cámbialo con tus padres.',
      block_not_yours: 'Ese bloque no es tuyo.', too_much_today: 'Es mucho para un día. Sigue mañana.',
      not_enough: 'Todavía no tienes puntos suficientes.', points_off: 'Los puntos están desactivados.', choose_length: 'Elige 10, 15, 20 o 25 minutos.',
      set_time_first: 'Primero hay que poner un tiempo de tarea.', not_on_link: 'Ese trabajo no está en este enlace.', say_missing: 'Di qué falta.',
      step_not_on_link: 'Ese paso no está en este enlace.', plan_not_yours: 'Ese plan no está en tu lista.',
      closed: 'Este trabajo está terminado o descartado. Vuelve a abrirlo primero.', plan_too_long: 'Ese plan es demasiado largo.',
      asks_full: 'Ya hay tres pedidos esperando. Espera primero a tus padres.', suggest_full: 'Ya hay cinco propuestas esperando. Espera primero a tus padres.',
      own_full: 'Ya tienes quince tareas tuyas abiertas.',
      points_spent: 'Esos puntos ya se gastaron.', cant_save: 'Eso no se puede guardar.',
      ask_parent: 'Ese pídeselo a tus padres.', instant_done: 'Ya usaste los premios al momento de hoy. Este pídeselo a tus padres.',
      price_changed: 'El precio de ese premio cambió. Míralo otra vez antes de conseguirlo.',
      ai_preview: 'Lo que verá Claude',
      ai_preview_hint: 'Esto es todo lo que va a Anthropic (Claude), sin los nombres que conoce Home Hub, ni enlaces, correos o teléfonos. Cambia antes el texto del profesor si algo más no debe ir.',
      ai_preview_failed: 'No se pudo cargar lo que verá Claude. Revisa la conexión.',
      ai_send: 'Enviar a Claude', ai_thinking: 'Pensando un plan… (suele tardar menos de un minuto)', ai_thinking_short: 'Pensando…',
      ai_label: '{what} · Sugerido por IA (Claude). Revísalo con {kid}.', ai_draft: 'Borrador', ai_changes: 'Cambios sugeridos',
      ai_use: 'Usar este plan', ai_undo: 'Deshacer', ai_dismiss: 'Descartar', ai_draft_ready: 'Borrador de IA listo',
      ai_loaded: 'El borrador está en el plan de abajo, todavía sin guardar. Cámbialo con {kid} y luego guárdalo.',
      ai_ask_for: 'Pedir cambios', ai_note: 'O di qué cambiar (opcional)', ai_again: 'Pedir otra vez',
      ai_chip_smaller: 'Pasos más pequeños', ai_chip_fewer: 'Menos pasos', ai_chip_no_wed: 'Nada el miércoles', ai_chip_later: 'Empezar más tarde',
      ai_chip_writing: 'Más tiempo para escribir',
      ai_questions: 'Preguntas para {kid}', ai_answer: 'Respuesta de {kid} (opcional)', ai_optional: 'Opcional: {text}', ai_note_adult: 'Nota para ti: {text}',
      ai_over: 'No cabe en su tiempo de tarea: {n} min de más.', ai_fits: 'Cabe en su tiempo de tarea.', ai_mark: 'IA', ai_mark_label: 'Sugerido por IA',
      ai_too_long: 'Pide los cambios en 200 caracteres como mucho.',
      ai_s_not_set_up: 'La ayuda de IA todavía no está configurada. Empieza con un plan base.',
      ai_s_cap: 'La ayuda de IA de hoy ya se usó. Empieza con un plan base.',
      ai_s_month: 'La ayuda de IA de este mes ya se usó. Empieza con un plan base.',
      ai_s_auth: 'La ayuda de IA no funciona ahora mismo. Empieza con un plan base.',
      ai_s_spend: 'La ayuda de IA terminó por este mes. Empieza con un plan base.',
      ai_s_billing: 'La ayuda de IA está en pausa. Empieza con un plan base.',
      ai_s_later: 'La IA no pudo hacer un plan ahora. Inténtalo más tarde o empieza con un plan base.',
      ai_s_refusal: 'La IA no pudo ayudar con este. Empieza con un plan base.',
      ai_s_changed: 'Lo que verá Claude ha cambiado. Vuelve a leerlo arriba y luego envíalo.',
    },
  };

  Object.freeze(WORDS.en);
  Object.freeze(WORDS.es);
  Object.freeze(WORDS);
  const langOf = (l) => (l === 'es' ? 'es' : 'en');
  function t(key, vars, lang) {
    const l = langOf(lang);
    const pick = (k) => (WORDS[l][k] != null ? WORDS[l][k] : WORDS.en[k]);
    let raw = pick(key);
    if (raw == null) return String(key);
    if (raw.includes('{tutor}') && (!vars || vars.tutor == null || vars.tutor === '') && pick(`${key}_none`) != null) raw = pick(`${key}_none`);
    let s = String(raw);
    // "de el lun" → "del lun", "a el lun" → "al lun": only where the template itself puts the preposition.
    if (l === 'es') {
      s = s.replace(/(^|[^\p{L}])(de|a) \{(\w+)\}/gu, (m, pre, p, name) => {
        const v = vars && vars[name] != null ? String(vars[name]) : null;
        return v != null && /^el /.test(v) ? `${pre}${p === 'de' ? 'del' : 'al'} ${v.slice(3)}` : m;
      });
    }
    return s.replace(/\{(\w+)\}/g, (m, name) => (vars && vars[name] != null ? String(vars[name]) : m));
  }

  // ============================================
  // TEXT
  // ============================================
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const chars = (s) => Array.from(String(s == null ? '' : s)).length;
  // private.clean_text(p_text, p_max): control characters become spaces, bidi and zero-width
  // characters go, runs of spaces become one, trimmed, at most p_max characters.
  function oneLine(text) {
    return String(text == null ? '' : text)
      .replace(/[\u0001-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
      .replace(/[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
      .trim();
  }
  const cut = (s, max) => Array.from(s).slice(0, Math.max(max, 0)).join('').trimEnd();
  const clean = (text, max) => cut(oneLine(text), max);
  // private.clean_block(p_text, p_max): each line as clean_text, never two blank lines in a row,
  // none at the start or the end, at most 60 lines, at most p_max characters.
  function cleanBlock(text, max) {
    const out = [];
    String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
      const l = oneLine(line);
      if (!l && (!out.length || out[out.length - 1] === '')) return;
      out.push(l);
    });
    while (out.length && out[out.length - 1] === '') out.pop();
    return cut(out.slice(0, 60).join('\n'), max);
  }

  // A row's id made by the page: crypto.randomUUID, else one from crypto.getRandomValues.
  // FNV-1a over a text's code points, as 8 hex characters: the preview's "what was sent" mark on the device.
  function hashText(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text == null ? '' : text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  // What What Claude will see compares with what was last sent: the parts a person typed (the class, the title, the
  // teacher's text, the request, the answers, and in the current plan each locked step's title and "done looks like",
  // which are the people's: his renames on My day, Pat's or a parent's edits). Today's date, the free minutes, the
  // pace and the rest of the current plan (the AI's or a starter plan's steps, the minutes and days) change by
  // themselves (each day, each draft) and would open the fold for nothing new to read.
  const TYPED_PARTS = /<(subject|assignment_title|assignment_text|current_plan|request|answers)(?: [^>]*)?>([\s\S]*?)<\/\1>/g;
  function previewMark(text) {
    const parts = [...String(text == null ? '' : text).matchAll(TYPED_PARTS)].map((m) => {
      if (m[1] !== 'current_plan') return `${m[1]}:${m[2]}`;
      let plan = null;
      try { plan = JSON.parse(m[2]); } catch (e) { return `${m[1]}:${m[2]}`; }
      const mine = (Array.isArray(plan) ? plan : []).filter((x) => x && x.locked === true).map((x) => [x.title, x.done_looks_like || null]);
      return mine.length ? `${m[1]}:${JSON.stringify(mine)}` : '';
    }).filter(Boolean);
    return hashText(parts.length ? parts.join('\n') : text);
  }
  // The seal of What Claude will see, as hub-jobs checks it (homework.ts's previewSeal, the same function): the hash of
  // the message without its request and answers, which come last and are what the asker sends in the body. Every
  // person-typed text has its '<' replaced, so the first "\n<request from=" or "\n<answers>" is where they start.
  function previewSeal(text) {
    let base = String(text == null ? '' : text);
    ['\n<request from="', '\n<answers>\n'].forEach((tag) => { const i = base.indexOf(tag); if (i >= 0) base = base.slice(0, i); });
    return hashText(base);
  }
  // Whether a draft's text is the copy the AI was sent of a person's text: private.scrub's placeholders ([name],
  // [link], [email], [phone], [id]) stand for anything, its ‹ › for < >, and the invisible characters and runs of spaces
  // it and clean_text take out or join don't count.
  const INVISIBLE = /[\u00ad\u034f\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
  const flat = (x) => String(x == null ? '' : x).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  function copyOf(draft, person) {
    const d = flat(draft);
    const p = flat(person);
    if (d === p) return true;
    if (!/\[(name|link|email|phone|id)\]|[‹›]/.test(d) || d.length > 400) return false;
    const re = d.split(/(\[(?:name|link|email|phone|id)\]|[‹›])/).map((part, i) => {
      if (i % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return part === '‹' ? '[‹<]' : part === '›' ? '[›>]' : '.+?';
    }).join('');
    try { return new RegExp(`^${re}$`).test(p); } catch (e) { return false; }
  }
  // A failed call to hub-jobs (supabase-js's functions.invoke), as the editor's stop: 'offline' only when the request
  // never got an answer (FunctionsFetchError, FunctionsRelayError, a fetch that threw); an answer that isn't a 2xx
  // (FunctionsHttpError, its Response in context) is its body's stop (no_schema, error), else 'error' ("Try again later").
  async function aiFailure(err) {
    const res = err && err.context;
    const isHttp = (err && err.name === 'FunctionsHttpError') || (res && typeof res.status === 'number' && res.status > 0 && typeof res.json === 'function');
    if (!isHttp) return 'offline';
    let body = null;
    try { body = res && typeof res.clone === 'function' ? await res.clone().json() : await res.json(); } catch (e) { body = null; }
    const stop = body && typeof body.stop === 'string' && /^[a-z_]{1,40}$/.test(body.stop) ? body.stop : 'error';
    return stop;
  }

  function newId() {
    try {
      if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    } catch (err) { return null; }
  }

  // ============================================
  // ANSWERS AND MESSAGES
  // ============================================
  const REFUSALS = new Set(['42501', '22023', 'P0001', '54000', '23505']);
  function answer(res) {
    if (!res) return 'retry';
    if (!res.error) return res.data && typeof res.data === 'object' ? 'ok' : 'gone';
    const code = String(res.error.code || '');
    if (code === 'PGRST202') return 'not_yet';
    if (REFUSALS.has(code) || /^PGRST/.test(code)) return 'refused';
    const status = Number(res.status) || 0;
    if (!status || status >= 500 || status === 408 || status === 429) return 'retry';
    return 'refused';
  }

  // The database's messages (English), as the reader reads them.
  const MESSAGES = [
    [/Failed to fetch|NetworkError|Load failed|network connection/i, 'offline'],
    [/That step isn't on your plan/i, 'step_not_yours'],
    [/Only your own tick/i, 'own_tick_only'],
    [/That's a checkpoint/i, 'checkpoint'],
    [/Finish the block you started first/i, 'open_first'],
    [/That block isn't yours/i, 'block_not_yours'],
    [/That's a lot for one day/i, 'too_much_today'],
    [/No homework day before it's due has room/i, 'no_day_left'],
    [/was changed since you opened it/i, 'changed'],
    [/Not enough points yet/i, 'not_enough'],
    [/Points are off/i, 'points_off'],
    [/Choose 10, 15, 20 or 25/i, 'choose_length'],
    [/Plan this one with/i, 'plan_with_tutor'],
    [/Set a homework time first/i, 'set_time_first'],
    [/That's too long/i, 'too_long'],
    [/That assignment isn't on this link/i, 'not_on_link'],
    [/That step isn't on this link/i, 'step_not_on_link'],
    [/That plan isn't on your list/i, 'plan_not_yours'],
    [/is done or dropped/i, 'closed'],
    [/That plan is too long/i, 'plan_too_long'],
    [/Say what's missing/i, 'say_missing'],
    // His limits on My day: a plan's 20 steps (Make it smaller), his waiting asks and suggestions, his own homework.
    // The 20 is matched whole: another number (PR B's "At most 12 steps.") isn't given these words.
    [/^At most 20 steps\.?$/i, 'chk_too_many_steps'],
    [/Three asks are waiting already/i, 'asks_full'],
    [/Five suggestions are waiting already/i, 'suggest_full'],
    [/Fifteen of your own are open already/i, 'own_full'],
    // Pat's Uncheck once the milestone's points were traded (as a Void), and the token writers' last guard
    // (a constraint error said without its detail).
    [/Those points are already spent/i, 'points_spent'],
    [/That can't be saved/i, 'cant_save'],
    // Instant rewards: one that needs a parent's yes, and the day's limit on cashing them.
    [/Ask a parent for that one/i, 'ask_parent'],
    [/That's all the instant rewards for today/i, 'instant_done'],
    // An instant reward re-priced after his screen showed it: the cash-in names the price it showed (p_cost).
    [/That reward's price changed/i, 'price_changed'],
  ];
  const messageOf = (err) => String((err && (err.message || err.error_description)) || err || '');
  function friendly(err, lang, tutor) {
    const msg = messageOf(err);
    const hit = MESSAGES.find(([re]) => re.test(msg));
    if (hit) return t(hit[1], { tutor: tutor == null ? null : tutor }, lang);
    return langOf(lang) === 'en' && msg ? msg : t('error_generic', null, lang);
  }
  const CONFLICT = /changed since you opened it/i;

  // ============================================
  // DATES: 'YYYY-MM-DD' strings, counted in whole UTC days
  // ============================================
  function dayNumber(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN;
  }
  const fromNumber = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const addDays = (iso, n) => { const x = dayNumber(iso); return Number.isFinite(x) ? fromNumber(x + n) : null; };
  const daysBetween = (a, b) => dayNumber(b) - dayNumber(a);
  const weekday = (iso) => { const x = dayNumber(iso); return Number.isFinite(x) ? new Date(x * 86400000).getUTCDay() : NaN; };
  const isoWeekday = (iso) => { const w = weekday(iso); return Number.isFinite(w) ? (w === 0 ? 7 : w) : NaN; };

  const DAYS = {
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  };
  const MONTHS = {
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  };
  function parts(iso) {
    const n = dayNumber(iso);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n * 86400000);
    return { n, weekday: d.getUTCDay(), month: d.getUTCMonth(), day: d.getUTCDate() };
  }
  const minutesOf = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  const fmt = {
    // 'Fri Nov 13' / 'vie 13 nov'
    day(iso, lang) {
      const p = parts(iso);
      if (!p) return '';
      const l = langOf(lang);
      const wd = DAYS[l][p.weekday].slice(0, 3);
      const mo = MONTHS[l][p.month].slice(0, 3);
      return l === 'es' ? `${wd} ${p.day} ${mo}` : `${wd} ${mo} ${p.day}`;
    },
    // 'Nov 13' / '13 nov'
    short(iso, lang) {
      const p = parts(iso);
      if (!p) return '';
      const l = langOf(lang);
      const mo = MONTHS[l][p.month].slice(0, 3);
      return l === 'es' ? `${p.day} ${mo}` : `${mo} ${p.day}`;
    },
    // 'Fri' / 'vie'
    weekday(iso, lang) {
      const p = parts(iso);
      return p ? DAYS[langOf(lang)][p.weekday].slice(0, 3) : '';
    },
    // '16:30' → '4:30pm' / '16:30'
    time(hhmm, lang) {
      const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
      if (!m) return '';
      const h = Number(m[1]) % 24;
      return langOf(lang) === 'es' ? `${h}:${m[2]}` : `${h % 12 || 12}:${m[2]}${h < 12 ? 'am' : 'pm'}`;
    },
    // 45 → '45 min', 100 → '1 h 40', 120 → '2 h'
    duration(min) {
      const m = Math.max(0, Math.round(Number(min) || 0));
      if (m < 60) return `${m} min`;
      const r = m % 60;
      return r ? `${Math.floor(m / 60)} h ${String(r).padStart(2, '0')}` : `${Math.floor(m / 60)} h`;
    },
    // 'today' / 'tomorrow' / 'yesterday', a weekday within 6 days, else the date; Spanish with its article.
    rel(iso, today, lang) {
      const l = langOf(lang);
      const d = daysBetween(today, iso);
      if (!Number.isFinite(d)) return fmt.day(iso, l);
      if (d === 0) return t('rel_today', null, l);
      if (d === 1) return t('rel_tomorrow', null, l);
      if (d === -1) return t('rel_yesterday', null, l);
      const s = Math.abs(d) <= 6 ? fmt.weekday(iso, l) : fmt.day(iso, l);
      return l === 'es' ? `el ${s}` : s;
    },
  };

  // ============================================
  // THE SERVER'S CLOCK
  // ============================================
  const TS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
  function ms(ts) {
    const m = TS.exec(String(ts == null ? '' : ts).trim());
    if (!m) return NaN;
    let out = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), m[7] ? Number(`${m[7]}00`.slice(0, 3)) : 0);
    const z = m[8];
    if (z && z.toUpperCase() !== 'Z') {
      const digits = z.replace(':', '');
      const off = Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5) || 0);
      out -= (z[0] === '-' ? -1 : 1) * off * 60000;
    }
    return out;
  }
  // The household's day of a timestamp, from an answer's as_of (its local date and time) and server_now:
  // their difference is the household's offset (to the quarter hour). Without them, the date as written.
  function localDay(ts, asOf, serverNow) {
    const at = ms(ts);
    if (!Number.isFinite(at)) return null;
    const here = ms(`${String(asOf || '').slice(0, 16)}Z`);
    const now = ms(serverNow);
    if (Number.isFinite(here) && Number.isFinite(now)) {
      const off = Math.round((here - now) / 900000) * 900000;
      return new Date(at + off).toISOString().slice(0, 10);
    }
    return /^\d{4}-\d{2}-\d{2}/.test(String(ts)) ? String(ts).slice(0, 10) : null;
  }
  const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // The block's end on the performance.now() clock: perf + (ends_at − server_now), or perf + ends_in_s.
  function timer(x, perf) {
    const p = Number.isFinite(perf) ? perf : perfNow();
    const o = x || {};
    let total = Number(o.minutes) > 0 ? Number(o.minutes) * 60000 : NaN;
    let endLocal;
    if (o.ends_in_s != null) {
      endLocal = p + (Number(o.ends_in_s) || 0) * 1000;
    } else {
      const end = ms(o.ends_at);
      const now = ms(o.server_now);
      endLocal = p + (Number.isFinite(end) && Number.isFinite(now) ? end - now : 0);
      const start = ms(o.started_at);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) total = end - start;
    }
    if (!Number.isFinite(total) || total <= 0) total = Math.max(endLocal - p, 1);
    return { endLocal, totalMs: total };
  }
  function left(tm, perf) {
    const p = Number.isFinite(perf) ? perf : perfNow();
    const rest = Math.max(0, (tm ? tm.endLocal : 0) - p);
    return {
      ms: rest, seconds: Math.ceil(rest / 1000), minutes: Math.ceil(rest / 60000),
      fraction: tm && tm.totalMs > 0 ? Math.min(1, rest / tm.totalMs) : 0, done: rest <= 0,
    };
  }
  // Schedule the chime on the audio clock at Start (oscillator.start(audioAt(…))), so a hidden page's
  // slow timers can't delay it.
  const audioAt = (tm, perf, ctxNow) => (Number(ctxNow) || 0) + left(tm, perf).ms / 1000;

  // ============================================
  // PLACEMENT (§5.4)
  // ============================================
  function ended(today, asOf, window) {
    if (!window || !asOf) return false;
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(asOf));
    if (!m) return false;
    if (m[1] !== today) return m[1] > today;
    const end = minutesOf(window.ends);
    return Number.isFinite(end) && minutesOf(m[2]) >= end;
  }
  const firstDay = (today, isOver) => (isOver ? addDays(today, 1) : today);
  function lastWorkDay(due, today, kind) {
    if (kind === 'lesson') return due;
    return addDays(due, daysBetween(today, due) >= 7 ? -2 : -1);
  }
  const horizon = (today) => addDays(today, HORIZON - 1);
  const hasWindow = (rows) => rows.some((d) => d && d.window);

  function homeworkDays(week, from, to) {
    const rows = (week || []).filter((d) => d && d.day);
    const out = [];
    if (!rows.length || !from || !to) return out;
    const known = rows.map((d) => d.day).sort();
    const lo = known[0];
    const hi = known[known.length - 1];
    const yes = new Set(rows.filter((d) => d.window).map((d) => d.day));
    const weekdays = new Set(rows.filter((d) => d.window).map((d) => weekday(d.day)));
    for (let d = from, n = 0; d && d <= to && n < 400; d = addDays(d, 1), n++) {
      if (d >= lo && d <= hi ? yes.has(d) : weekdays.has(weekday(d))) out.push(d);
    }
    return out;
  }

  // The first day and the last work day of an assignment, inside the horizon.
  function range(o, rows) {
    const todayRow = rows.find((d) => d && d.day === o.today);
    let lo = firstDay(o.today, ended(o.today, o.asOf, todayRow && todayRow.window));
    let hi = lastWorkDay(o.due, o.today, o.kind);
    let cutAt = null;
    const h = horizon(o.today);
    if (hi > h) { hi = h; cutAt = h; }
    if (hi < lo) hi = lo;
    if (o.due < lo) { lo = o.due < o.today ? o.today : o.due; hi = lo; }
    return { lo, hi, cutAt };
  }

  function place(steps, o) {
    const x = o || {};
    const rows = (x.days || []).filter(Boolean);
    const out = (steps || []).map((s) => Object.assign({}, s));
    if (!hasWindow(rows)) return { steps: out, fits: false, over: 0, horizon: null, no_time: true };
    const { lo, hi, cutAt } = range(x, rows);
    const room = new Map(rows.filter((d) => d.window).map((d) => [d.day, (Number(d.free) || 0) - (Number(d.planned) || 0)]));
    const roomOf = (d) => (room.has(d) ? room.get(d) : 0);
    let prev = lo;
    let fits = true;
    let over = 0;
    out.forEach((s) => {
      if (s.done) return;
      if (s.kind === 'turn_in') { s.day = x.due; return; }
      const m = Number(s.minutes) || 0;
      const from = prev > lo ? prev : lo;
      let day = null;
      if (s.day && s.day >= from && s.day <= hi && roomOf(s.day) >= m) day = s.day;
      for (let d = from; !day && d <= hi; d = addDays(d, 1)) if (roomOf(d) >= m) day = d;
      if (!day) {
        let best = from;
        let most = -Infinity;
        for (let d = from; d <= hi; d = addDays(d, 1)) if (roomOf(d) > most) { best = d; most = roomOf(d); }
        day = best;
        fits = false;
        over += m - Math.max(most, 0);
      }
      room.set(day, roomOf(day) - m);
      s.day = day;
      prev = day;
    });
    return { steps: out, fits, over, horizon: cutAt, no_time: false };
  }

  function timeLeft(days, o) {
    const x = o || {};
    const rows = (days || []).filter(Boolean);
    if (!hasWindow(rows)) return { minutes: 0, horizon: null, no_time: true };
    const { lo, hi, cutAt } = range(x, rows);
    const own = new Map();
    (x.own || []).forEach((s) => { if (!s.done && s.day) own.set(s.day, (own.get(s.day) || 0) + (Number(s.minutes) || 0)); });
    let sum = 0;
    rows.forEach((d) => {
      if (!d.window || d.day < lo || d.day > hi) return;
      const others = Math.max(0, (Number(d.planned) || 0) - (own.get(d.day) || 0));
      sum += Math.max(0, (Number(d.free) || 0) - others);
    });
    return { minutes: sum, horizon: cutAt, no_time: false };
  }

  const workLeft = (steps) => (steps || []).reduce((n, s) => n + (s && !s.done ? Number(s.minutes) || 0 : 0), 0);
  function spare(steps, due) {
    const work = (steps || []).filter((s) => s && !s.done && s.kind !== 'turn_in');
    if (!work.length || work.some((s) => !s.day)) return null;
    const last = work.map((s) => s.day).sort().pop();
    return Math.max(0, daysBetween(last, due) - 1);
  }

  // ============================================
  // STARTER PLANS (§4.6): [kind, minutes, title, done looks like]
  // ============================================
  const PLANS = {
    essay: {
      en: [['start', 10, 'Copy the requirements into your notes', 'the requirements in your notes'],
        ['step', 10, "List what's unclear and ask", 'a list of questions, sent'],
        ['step', 20, 'Gather materials or sources', "what you'll use, saved in one place"],
        ['milestone', 25, 'Plan it: an outline or a sketch', 'an outline or sketch you can show'],
        ['step', 25, 'Draft the first half', 'the first half written, rough is fine'],
        ['step', 25, 'Draft the second half', 'the second half written, rough is fine'],
        ['milestone', 25, 'Finish a full draft', 'a whole draft, start to end'],
        ['check', 20, 'Check it against the instructions', 'each requirement ticked off'],
        ['turn_in', 5, 'Turn it in', 'handed in']],
      es: [['start', 10, 'Copia los requisitos en tus notas', 'los requisitos en tus notas'],
        ['step', 10, 'Apunta lo que no está claro y pregunta', 'una lista de preguntas, enviada'],
        ['step', 20, 'Reúne los materiales o las fuentes', 'lo que vas a usar, guardado en un sitio'],
        ['milestone', 25, 'Planéalo: un esquema o un boceto', 'un esquema o boceto que puedas enseñar'],
        ['step', 25, 'Escribe el borrador de la primera mitad', 'la primera mitad escrita, aunque sea en sucio'],
        ['step', 25, 'Escribe el borrador de la segunda mitad', 'la segunda mitad escrita, aunque sea en sucio'],
        ['milestone', 25, 'Termina un borrador completo', 'un borrador entero, de principio a fin'],
        ['check', 20, 'Revísalo con las instrucciones', 'cada requisito comprobado'],
        ['turn_in', 5, 'Entregarlo', 'entregado']],
    },
    test: {
      en: [['start', 10, 'List what the test covers', 'a list of topics'],
        ['step', 20, 'Make a study list', 'the topics in order, hardest first'],
        ['step', 25, 'Practice the first half of the topics', 'practice questions done and checked'],
        ['milestone', 25, 'Practice the second half', 'practice questions done and checked'],
        ['check', 20, 'Quiz yourself', 'a self-quiz with the misses marked'],
        ['turn_in', 5, 'Pack what you need', 'bag packed']],
      es: [['start', 10, 'Apunta lo que entra en el examen', 'una lista de temas'],
        ['step', 20, 'Haz una lista para estudiar', 'los temas en orden, el más difícil primero'],
        ['step', 25, 'Practica la primera mitad de los temas', 'preguntas de práctica hechas y corregidas'],
        ['milestone', 25, 'Practica la segunda mitad', 'preguntas de práctica hechas y corregidas'],
        ['check', 20, 'Ponte a prueba', 'una autoevaluación con los fallos marcados'],
        ['turn_in', 5, 'Prepara lo que necesitas', 'la mochila lista']],
    },
    reading: {
      en: { first: ['start', 5, 'Note the pages and the due date', 'pages and date in your notes'],
        part: ['step', 20, 'Read part {n}', 'that part read'],
        last: ['check', 10, 'Write 3 things to remember', '3 lines in your notes'] },
      es: { first: ['start', 5, 'Apunta las páginas y la fecha de entrega', 'las páginas y la fecha en tus notas'],
        part: ['step', 20, 'Lee la parte {n}', 'esa parte leída'],
        last: ['check', 10, 'Escribe 3 cosas para recordar', '3 líneas en tus notas'] },
    },
    practice: {
      en: ['Do practice session {n}', "that day's practice done"],
      es: ['Haz la sesión de práctica {n}', 'la práctica del día hecha'],
    },
    short: {
      en: [['step', 20, 'Do it', 'done and in your bag'], ['turn_in', 5, 'Turn it in', 'handed in']],
      es: [['step', 20, 'Hazlo', 'hecho y en la mochila'], ['turn_in', 5, 'Entregarlo', 'entregado']],
    },
  };

  function guess(title, kind) {
    const s = String(title || '').toLowerCase();
    if (/\b(tests?|quiz(zes)?|exams?|ex[aá]men(es)?|pruebas?)\b/.test(s)) return 'test';
    if (/\b(essays?|projects?|reports?|ensayos?|redacci[oó]n|proyectos?|informes?)(?![\p{L}])/u.test(s)) return 'essay';
    if (/\b(read|reading|leer|lectura)\b/.test(s)) return 'reading';
    return kind === 'lesson' ? 'practice' : 'short';
  }

  function starter(key, o) {
    const x = o || {};
    const l = langOf(x.lang);
    const length = LENGTHS.includes(Number(x.length)) ? Number(x.length) : null;
    const mins = (kind, m) => (kind === 'turn_in' ? 5 : length ? Math.min(m, length) : m);
    const step = (row, n, day) => ({
      kind: row[0], title: String(row[2]).replace('{n}', n), done_looks_like: row[3],
      minutes: mins(row[0], row[1]), day: day || null, source: 'template',
    });
    if (key === 'reading') {
      const p = PLANS.reading[l];
      const n = Math.min(10, Math.max(1, Math.floor(Number(x.parts)) || 2));
      return [step(p.first)].concat(Array.from({ length: n }, (v, i) => step(p.part, i + 1)), [step(p.last)]);
    }
    if (key === 'practice') {
      const [title, dll] = PLANS.practice[l];
      let days = [];
      if (x.today && x.due) {
        const rows = (x.week || []).filter(Boolean);
        const todayRow = rows.find((d) => d.day === x.today);
        const lo = firstDay(x.today, ended(x.today, x.asOf, todayRow && todayRow.window));
        // The last work day as placement has it (§5.4): a lesson's do-by day; an assignment's day before
        // its due date (two before when that is 7 or more days away), as only the turn-in goes on it.
        const end = x.kind === 'assignment' ? lastWorkDay(x.due, x.today, x.kind) : x.due;
        const hi = end > horizon(x.today) ? horizon(x.today) : end;
        days = homeworkDays(rows, lo, hi).slice(0, LIMITS.steps);
      }
      const n = Math.max(1, days.length);
      return Array.from({ length: n }, (v, i) => step([i === n - 1 ? 'milestone' : 'step', length || 20, title, dll], i + 1, days[i]));
    }
    return (PLANS[key] || PLANS.short)[l].map((row) => step(row));
  }

  // plan_check's rules (§4.2), and plan_save's "nothing new or moved in the past".
  function check(steps, o) {
    const x = o || {};
    const list = steps || [];
    const bad = (key, i) => ({ key, i });
    if (list.length > LIMITS.steps) return bad('too_many_steps', LIMITS.steps);
    let milestones = 0;
    let turnIns = 0;
    const ids = new Set();
    for (let i = 0; i < list.length; i++) {
      const s = list[i] || {};
      if (s.kind === 'milestone' && ++milestones > LIMITS.milestones) return bad('too_many_milestones', i);
      if (s.kind === 'turn_in' && ++turnIns > 1) return bad('one_turn_in', i);
      if (s.id != null) {
        if (ids.has(s.id)) return bad('same_id', i);
        ids.add(s.id);
      }
    }
    for (let i = 0; i < list.length; i++) {
      const s = list[i] || {};
      if (s.kind === 'turn_in' && i !== list.length - 1) return bad('turn_in_last', i);
      if (s.done) continue;
      if (!KINDS.includes(s.kind)) return bad('bad_kind', i);
      const title = chars(clean(s.title, 200));
      if (title < LIMITS.title[0] || title > LIMITS.title[1]) return bad('title_len', i);
      if (chars(clean(s.done_looks_like, 400)) > LIMITS.dll) return bad('dll_len', i);
      const m = s.minutes;
      if (!Number.isInteger(m) || m < LIMITS.minutes[0] || m > LIMITS.minutes[1]) return bad('minutes_range', i);
      if (s.day) {
        const kept = x.orig && s.id != null ? x.orig[s.id] : undefined;
        const moved = kept !== s.day;
        // plan_check takes the later of the due date and today; plan_save keeps the due date for the
        // turn-in only on an assignment that is still ahead (a lesson works up to its do-by day).
        const last = x.due && x.today && x.today > x.due ? x.today : x.due;
        if (last && s.day > last) return bad('after_due', i);
        if (moved && x.kind !== 'lesson' && x.due && !(x.today && x.due <= x.today) && s.day === x.due && s.kind !== 'turn_in') return bad('due_day', i);
        if (x.today && s.day < x.today && moved) return bad('in_past', i);
      }
    }
    return null;
  }

  // ============================================
  // DRAWING: the two bars, the week strip, pace, focused minutes, the ring
  // ============================================
  const pct = (v, top) => `${Number(((v / top) * 100).toFixed(1))}%`;
  function bars(work, time, o) {
    const x = o || {};
    const l = langOf(x.lang);
    const w = Math.max(0, Math.round(Number(work) || 0));
    const noTime = !!x.no_time;
    const hasTime = !noTime && time != null && Number.isFinite(Number(time));
    const tm = hasTime ? Math.max(0, Math.round(Number(time))) : 0;
    const top = Math.max(w, tm, 1);
    const over = hasTime && w > tm;
    const bar = (cls, label, v, extra) => `<div class="plan-bar ${cls}"><span class="plan-bar-label">${esc(label)}</span> `
      + `<span class="plan-bar-track" aria-hidden="true"><span class="plan-bar-fill" style="width:${pct(v, top)}"></span></span> `
      + `<span class="plan-bar-val">${esc(fmt.duration(v))}${extra ? esc(extra) : ''}</span></div>`;
    let html = `<div class="plan-bars${over ? ' is-over' : ''}">${bar('plan-bar-work', t('work_left', null, l), w)}`;
    if (hasTime) html += bar('plan-bar-time', t('time_left', null, l), tm, x.horizon ? ` · ${t('next_8_weeks', null, l)}` : '');
    if (noTime) html += `<p class="plan-fit">${esc(t('no_time', null, l))}</p>`;
    else if (over) html += `<p class="plan-fit is-over">${esc(t('doesnt_fit', null, l))}</p>`;
    return `${html}</div>`;
  }

  function week(days, o) {
    const x = o || {};
    const l = langOf(x.lang);
    const rows = (days || []).filter((d) => d && d.day);
    const start = x.today || (rows[0] && rows[0].day);
    const count = Math.max(1, Math.min(56, Number(x.count) || 7));
    const by = new Map(rows.map((d) => [d.day, d]));
    let html = '<ul class="plan-week">';
    for (let i = 0; start && i < count; i++) {
      const day = addDays(start, i);
      const d = by.get(day);
      const name = `<span class="plan-wday-name">${esc(fmt.weekday(day, l))}</span>`;
      const today = i === 0 && day === x.today ? ' is-today' : '';
      if (!d || !d.window) {
        html += `<li class="plan-wday is-off${today}">${name} <span class="plan-wday-text">—</span></li>`;
        continue;
      }
      const free = Math.max(0, Math.round(Number(d.free) || 0));
      const planned = Math.max(0, Math.round(Number(d.planned) || 0));
      const over = Math.max(0, planned - free);
      const text = over > 0 ? t('w_over', { n: over }, l) : planned > 0 ? t('w_free_planned', { n: free, m: planned }, l) : t('w_free', { n: free }, l);
      const ws = minutesOf(d.window.starts);
      const wm = Math.max(1, minutesOf(d.window.ends) - ws);
      const segs = (d.busy || []).map((b) => {
        const s = Math.max(minutesOf(b.starts), ws);
        const e = Math.min(minutesOf(b.ends), ws + wm);
        return Number.isFinite(s) && Number.isFinite(e) && e > s
          ? `<span class="plan-wday-busy-seg" style="left:${pct(s - ws, wm)};width:${pct(e - s, wm)}"></span>` : '';
      }).join('');
      const fill = `<span class="plan-wday-planned${over ? ' is-over' : ''}" style="width:${pct(Math.min(planned, wm), wm)}"></span>`;
      const busy = (d.busy || []).map((b) => `${x.titles && b.title ? b.title : t('w_busy', null, l)} ${fmt.time(b.starts, l)}`);
      html += `<li class="plan-wday${today}${over ? ' is-over' : ''}">${name} <span class="plan-wday-bar" aria-hidden="true">${segs}${fill}</span> `
        + `<span class="plan-wday-text">${esc(text)}</span>${busy.length ? ` <span class="plan-wday-busy">${esc(busy.join(' · '))}</span>` : ''}</li>`;
    }
    return `${html}</ul>`;
  }

  function pace(ratio, lang) {
    const r = Number(ratio);
    if (ratio == null || !Number.isFinite(r)) return '';
    const x = r.toFixed(1);
    return t('pace', { x: langOf(lang) === 'es' ? x.replace('.', ',') : x }, lang);
  }
  function focused(w, lang) {
    if (!w || w.focused == null) return '';
    const now = fmt.duration(w.focused);
    return w.last_week == null ? t('focused_week', { t: now }, lang) : t('focused_vs', { t: now, u: fmt.duration(w.last_week) }, lang);
  }

  const RING_R = 45;
  const RING_C = 2 * Math.PI * RING_R;
  const r2 = (n) => Number(n.toFixed(2));
  function ring(fraction, o) {
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    const label = o && o.label ? ` role="img" aria-label="${esc(o.label)}"` : ' aria-hidden="true"';
    return `<svg class="plan-ring${f <= 0 ? ' is-done' : ''}" viewBox="0 0 100 100"${label}>`
      + `<circle class="plan-ring-track" cx="50" cy="50" r="${RING_R}"/>`
      + `<circle class="plan-ring-left" cx="50" cy="50" r="${RING_R}" stroke-dasharray="${r2(RING_C)}" stroke-dashoffset="${r2(RING_C * (1 - f))}" transform="rotate(-90 50 50)"/></svg>`;
  }

  function pointsLine(end, lang) {
    const e = end || {};
    const seen = Math.max(0, Math.floor(Number(e.seen) || 0));
    if (seen < 1) return t('under_minute', null, lang);
    const focus = Number(e.focus) || 0;
    const onTime = Number(e.on_time) || 0;
    const out = [];
    if (focus > 0) out.push(t('points_seen', { n: focus, m: seen }, lang));
    else if (!e.capped) out.push(t('minutes_only', { m: seen }, lang));
    if (onTime > 0) out.push(t('on_time_paid', { n: onTime }, lang));
    if (e.capped) out.push(t('limit_reached', null, lang));
    return out.join(' · ');
  }
  function onTimeLine(x, lang) {
    if (!x || x.done || !x.until) return '';
    return t('start_by', { time: fmt.time(x.until, lang), n: x.points != null ? x.points : 10 }, lang);
  }
  // What his timer counts up to while a block runs: an estimate from the server's start time (seconds since
  // it, by the server's clock), one per minute, never past the block's length, the on-time points once 5
  // minutes are seen, and never past what is left of the day's cap (earn.room), so it never shows more than
  // the end pays. earn: his view's session.earn ({ per_minute, on_time, room }), or null (his own block).
  function estimate(earn, seconds, minutes) {
    if (!earn) return 0;
    const m = Math.max(0, Math.min(Math.floor((Number(seconds) || 0) / 60), Number(minutes) || 0));
    const n = (Number(earn.per_minute) || 0) * m + (m >= 5 ? Number(earn.on_time) || 0 : 0);
    return Math.max(0, Math.min(n, Number(earn.room) || 0));
  }
  // The next-reward bar (his view's goal: { next: { title, cost, need }, now: { title, cost, instant } }):
  // "You can get <now> now!" when he can get one, else "<need> points to <next>" (the cheapest he can't
  // afford yet), with a bar of his free points against its cost; with both, the bar and its small line show
  // the way to the next. o.extra: points his timer counts that aren't paid yet (the bar moves on; "<next>
  // when this block ends!" once they would reach it). '' without a goal.
  function goalBar(goal, o) {
    const x = o || {};
    const l = langOf(x.lang);
    if (!goal || (!goal.next && !goal.now)) return '';
    const extra = Math.max(0, Math.floor(Number(x.extra) || 0));
    const next = goal.next;
    const need = next ? Math.max(0, (Number(next.need) || 0) - extra) : 0;
    const toNext = next ? (need > 0 ? t(need === 1 ? 'goal_need_one' : 'goal_need', { n: need, title: next.title }, l) : t('goal_after', { title: next.title }, l)) : '';
    const text = goal.now ? t('goal_now', { title: goal.now.title }, l) : toNext;
    const cost = next ? Number(next.cost) || 0 : 0;
    const fill = next && cost > 0 ? Math.min(1, Math.max(0, (cost - need) / cost)) : 1;
    return `<div class="plan-goal${goal.now ? ' is-now' : ''}${next && need <= 0 ? ' is-reached' : ''}">`
      + `<p class="plan-goal-text">${esc(text)}</p>`
      + `<span class="plan-goal-track" aria-hidden="true"><span class="plan-goal-fill" style="width:${Number((fill * 100).toFixed(1))}%"></span></span>`
      + `${goal.now && next ? `<p class="plan-goal-next">${esc(toNext)}</p>` : ''}</div>`;
  }

  // ============================================
  // TIMELINES: the overview of open assignments, an assignment's chart, his path
  // ============================================
  // Whole days from o.today, as everywhere here: a column a day, never the device's clock or zone.
  const LETTERS = Object.freeze({ en: Object.freeze(['S', 'M', 'T', 'W', 'T', 'F', 'S']), es: Object.freeze(['D', 'L', 'M', 'X', 'J', 'V', 'S']) });
  const TL_DAYS = 21;      // the overview's days (3 weeks)
  const TL_MAX = 63;       // the most days the overview or a chart draws (9 weeks)
  const PATH_MAX = 14;     // the most dots on his path
  const isDay = (iso) => Number.isFinite(dayNumber(iso));
  // A day inside a sentence: Spanish takes its article ('para el vie 13 nov', 'hito Esquema el jue 5 nov').
  const dayIn = (iso, l) => (l === 'es' ? `el ${fmt.day(iso, l)}` : fmt.day(iso, l));
  const monthOf = (iso, l) => { const p = parts(iso); return p ? MONTHS[l][p.month].slice(0, 3) : ''; };
  const isOpen = (a) => !!a && (a.status == null || a.status === 'open');
  const stepsOf = (a) => (Array.isArray(a && a.steps) ? a.steps.filter((s) => s && typeof s === 'object') : null);
  const earliest = (days) => days.reduce((m, d) => (m == null || d < m ? d : m), null);
  const latest = (days) => days.reduce((m, d) => (m == null || d > m ? d : m), null);
  const minutesText = (m) => fmt.duration(Math.max(0, Math.round(Number(m) || 0)));
  const str = (v) => (v == null ? '' : String(v));   // a title in t()'s vars (null would leave '{title}')

  // The days across the top: the month on the first day and on each 1st, the weekday's letter and the
  // date; each week from its Monday; today, the due day and (o.off) days without homework time marked;
  // o.arrow: an arrow after the last day (the due date is past it).
  function tlHead(from, n, o, l) {
    let html = '';
    for (let i = 0; i < n; i++) {
      const d = addDays(from, i);
      const p = parts(d);
      const cls = ['plan-tl-hday'];
      if (d === o.today) cls.push('is-today');
      if (p.weekday === 1) cls.push('is-mon');
      if (o.off && o.off.has(d)) cls.push('is-off');
      if (d === o.due) cls.push('is-due');
      const month = i === 0 || p.day === 1 ? `<span class="plan-tl-month">${esc(monthOf(d, l))}</span>` : '';
      html += `<span class="${cls.join(' ')}">${month}<span class="plan-tl-letter">${LETTERS[l][p.weekday]}</span>`
        + `<span class="plan-tl-date">${p.day}</span></span>`;
    }
    const more = o.arrow ? `<span class="plan-tl-arrow">${ICON.arrow}</span>` : '';
    return `<div class="plan-tl-head" aria-hidden="true"><span class="plan-tl-corner"></span><span class="plan-tl-days">${html}</span>${more}</div>`;
  }
  // A row's background: a cell a day (today's line, each Monday's edge, days without homework time).
  function tlCells(from, n, o) {
    let html = '';
    for (let i = 0; i < n; i++) {
      const d = addDays(from, i);
      const cls = ['plan-tl-cell'];
      if (d === o.today) cls.push('is-today');
      if (weekday(d) === 1) cls.push('is-mon');
      if (o.off && o.off.has(d)) cls.push('is-off');
      html += `<span class="${cls.join(' ')}" style="grid-column:${i + 1}"></span>`;
    }
    return html;
  }
  const tlKey = (items) => `<p class="plan-tl-key" aria-hidden="true">${items.map(([cls, icon, text]) => `<span class="${cls}">${icon}${esc(text)}</span>`).join(' ')}</p>`;

  // The overview: a row per open assignment by due date, across o.days days from o.today.
  function overview(items, o) {
    const x = o || {};
    const l = langOf(x.lang);
    const today = x.today;
    if (!isDay(today)) return '';
    const n = Math.max(7, Math.min(TL_MAX, Math.round(Number(x.days)) || TL_DAYS));
    const end = addDays(today, n - 1);
    const open = (Array.isArray(items) ? items : []).map((a, i) => ({ a, i }))
      .filter(({ a }) => isOpen(a) && isDay(a.due_date))
      .sort((p, q) => (p.a.due_date < q.a.due_date ? -1 : p.a.due_date > q.a.due_date ? 1 : p.i - q.i));
    if (!open.length) return '';
    const colOf = (d) => Math.max(0, Math.min(n - 1, daysBetween(today, d)));
    const cells = tlCells(today, n, { today });
    const rows = open.map(({ a }) => {
      const steps = stepsOf(a);
      const total = steps ? steps.length : Math.max(0, Math.round(Number(a.steps)) || 0);
      const done = steps ? steps.filter((s) => s.done).length : Math.max(0, Math.min(total, Math.round(Number(a.steps_done)) || 0));
      const first = steps ? earliest(steps.filter((s) => isDay(s.day)).map((s) => s.day)) : null;
      const due = a.due_date;
      const late = due < today;
      const past = due > end;
      let start = first && first > today ? first : today;
      if (start > due) start = due < today ? today : due;
      const c0 = late ? 0 : colOf(start);
      const c1 = late ? 0 : colOf(due);
      // Milestones: every one the plan has (with its day) or, without the steps, only the next.
      let ms = steps ? steps.filter((s) => s.kind === 'milestone') : [];
      if (!ms.length && a.next_milestone && a.next_milestone.title != null) ms = [{ title: a.next_milestone.title, day: a.next_milestone.day, done: false }];
      const marks = ms.map((m) => {
        if (!isDay(m.day) || m.day > end || (m.day < today && m.done)) return '';
        const behind = m.day < today;
        return `<span class="plan-tl-ms${m.done ? ' is-done' : ''}${behind ? ' is-behind' : ''}" style="grid-column:${behind ? 1 : colOf(m.day) + 1}">${ICON.diamond}</span>`;
      }).join('');
      const dueWords = t(a.kind === 'lesson' ? 'do_by' : 'due_on', { day: dayIn(due, l) }, l);
      const label = [str(a.title), !late && first ? t('tl_from', { day: dayIn(start, l) }, l) : total ? null : t('tl_no_plan', null, l),
        ...ms.map((m) => (m.done ? t('tl_ms_done', { title: str(m.title) }, l) : isDay(m.day) ? t('tl_ms', { title: str(m.title), day: dayIn(m.day, l) }, l) : null)),
        late ? t('tl_late', null, l) : null, dueWords, total ? t('tl_steps_done', { n: done, m: total }, l) : null].filter((v) => v != null && v !== '').join(' · ');
      // Each piece of the line kept whole, so a narrow name column breaks it between them, never inside a date.
      const sub = [a.subject, total ? t('n_of_m', { n: done, m: total }, l) : t('tl_no_plan', null, l), late ? t('tl_late', null, l) : null, dueWords]
        .filter((v) => v != null && v !== '').map((v) => `<span>${esc(v)}</span>`).join(' · ');
      const href = typeof x.link === 'function' ? x.link(a.id) : null;
      const name = `<span class="sr-only">${esc(label)}</span><span class="plan-tl-title" aria-hidden="true">${esc(a.title)}</span>`
        + `<span class="plan-tl-sub" aria-hidden="true">${sub}</span>`;
      const bar = `<span class="plan-tl-bar${late ? ' is-late' : ''}${past ? ' is-past' : ''}" style="grid-column:${c0 + 1} / ${c1 + 2}">`
        + `${total ? `<span class="plan-tl-fill" style="width:${pct(done, total)}"></span>` : ''}</span>`;
      const tail = past ? `<span class="plan-tl-arrow" style="grid-column:${n}">${ICON.arrow}</span>`
        : late ? '' : `<span class="plan-tl-due" style="grid-column:${c1 + 1}">${ICON.flag}</span>`;
      return `<li class="plan-tl-row${late ? ' is-late' : ''}" data-id="${esc(a.id)}">`
        + `${href ? `<a class="plan-tl-name" href="${esc(href)}">${name}</a>` : `<div class="plan-tl-name">${name}</div>`}`
        + `<span class="plan-tl-track" aria-hidden="true">${cells}${bar}${marks}${tail}</span></li>`;
    }).join('');
    const label = t('tl_overview', { from: fmt.day(today, l), to: fmt.day(end, l) }, l);
    return `<div class="plan-tl plan-tl-overview" role="group" aria-label="${esc(label)}" style="--tl-days:${n}">`
      + `<div class="plan-tl-scroll"><div class="plan-tl-grid">${tlHead(today, n, { today }, l)}<ul class="plan-tl-rows">${rows}</ul></div></div>`
      + `${tlKey([['k-ms', ICON.diamond, t('tag_milestone', null, l)], ['k-due', ICON.flag, t('tl_key_due', null, l)], ['k-today', '<i></i>', t('rel_today', null, l)]])}</div>`;
  }

  // An assignment's chart: its days, a row per phase (the steps up to and including each milestone, then
  // the rest), each step a block on its day.
  function chart(a, o) {
    const x = o || {};
    const l = langOf(x.lang);
    const steps = stepsOf(a);
    if (!steps || !steps.length || !isDay(a.due_date)) return '';
    const days = steps.filter((s) => isDay(s.day)).map((s) => s.day);
    if (new Set(days).size < 2) return '';
    const today = isDay(x.today) ? x.today : null;
    const due = a.due_date;
    const first = earliest(days);
    const lo = today && today < first ? today : first;
    let hi = latest(days.concat([due]));
    const cut = daysBetween(lo, hi) + 1 > TL_MAX;
    if (cut) hi = addDays(lo, TL_MAX - 1);
    const n = daysBetween(lo, hi) + 1;
    // Days without homework time, from the page's week (and its weekdays past it), when it has any.
    const week = (Array.isArray(x.week) ? x.week : []).filter((d) => d && isDay(d.day));
    let off = null;
    if (hasWindow(week)) {
      const yes = new Set(homeworkDays(week, lo, hi));
      off = new Set();
      for (let i = 0; i < n; i++) { const d = addDays(lo, i); if (!yes.has(d)) off.add(d); }
    }
    const mark = { today, due, off };
    const cells = tlCells(lo, n, mark);
    const phases = [];
    let cur = [];
    steps.forEach((s) => { cur.push(s); if (s.kind === 'milestone') { phases.push({ ms: s, steps: cur }); cur = []; } });
    if (cur.length) phases.push({ ms: null, steps: cur });
    const anyMs = phases.some((p) => p.ms);
    const block = (s) => {
      const kind = KINDS.includes(s.kind) ? s.kind : 'step';
      const done = !!s.done;
      const behind = !done && !!today && s.day < today;
      const m = Math.max(0, Math.round(Number(s.minutes) || 0));
      const icon = kind === 'milestone' ? ICON.diamond : kind === 'turn_in' ? ICON.flag : '';
      const sr = [str(s.title), kind === 'step' ? null : t(`tag_${kind}`, null, l), fmt.day(s.day, l), minutesText(m),
        done ? t('tl_key_done', null, l) : behind ? t('tl_behind', null, l) : null].filter((v) => v != null && v !== '').join(' · ');
      return `<span class="plan-tl-step k-${kind}${done ? ' is-done' : ''}${behind ? ' is-behind' : ''}" title="${esc(`${str(s.title)} · ${minutesText(m)}`)}">`
        + `<span class="plan-tl-min" aria-hidden="true">${icon}${m}</span><span class="sr-only">${esc(sr)}</span></span>`;
    };
    const rows = phases.map((p) => {
      const slots = new Map();
      p.steps.forEach((s) => {
        if (!isDay(s.day)) return;
        const c = Math.max(0, Math.min(n - 1, daysBetween(lo, s.day)));
        if (!slots.has(c)) slots.set(c, []);
        slots.get(c).push(s);
      });
      const blocks = [...slots.keys()].sort((u, v) => u - v)
        .map((c) => `<span class="plan-tl-slot" style="grid-column:${c + 1}">${slots.get(c).map(block).join('')}</span>`).join('');
      const title = p.ms ? p.ms.title : t(anyMs ? 'tl_phase_end' : 'tl_phase_all', null, l);
      const count = p.steps.length;
      const sub = `${count === 1 ? t('tl_n_steps_one', null, l) : t('tl_n_steps', { n: count }, l)} · ${minutesText(p.steps.reduce((v, s) => v + (Number(s.minutes) || 0), 0))}`;
      const dia = p.ms ? `<span class="plan-tl-dia${p.ms.done ? ' is-done' : ''}" aria-hidden="true">${ICON.diamond}</span>` : '';
      return `<li class="plan-tl-row${p.ms ? ' is-ms' : ''}"><div class="plan-tl-name"><span class="plan-tl-title">${dia}${esc(title)}</span>`
        + `<span class="plan-tl-sub">${esc(sub)}</span></div><span class="plan-tl-track">${cells}${blocks}</span></li>`;
    }).join('');
    const head = tlHead(lo, n, Object.assign({ arrow: cut }, mark), l);
    const label = t('tl_chart', { from: fmt.day(lo, l), to: fmt.day(hi, l) }, l);
    const key = [['k-done', '<i></i>', t('tl_key_done', null, l)], ['k-behind', '<i></i>', t('tl_behind', null, l)], ['k-ms', ICON.diamond, t('tag_milestone', null, l)],
      ['k-due', ICON.flag, t('tag_turn_in', null, l)]].concat(off ? [['k-off', '<i></i>', t('tl_key_off', null, l)]] : []);
    return `<div class="plan-tl plan-tl-chart" role="group" aria-label="${esc(label)}" style="--tl-days:${n}">`
      + `<div class="plan-tl-scroll"><div class="plan-tl-grid">${head}<ul class="plan-tl-rows">${rows}</ul></div></div>`
      + `${cut ? `<p class="plan-tl-foot">${esc(`${t(a.kind === 'lesson' ? 'do_by' : 'due_on', { day: dayIn(due, l) }, l)} →`)}</p>` : ''}${tlKey(key)}</div>`;
  }

  // His path: a dot a day from today to the due date (at most 14), flags on the milestones' days, and one
  // line on top: the next flag, when, and the points his tick pays (o.points, when his view gives it).
  function path(a, o) {
    const x = o || {};
    const l = langOf(x.lang);
    const today = x.today;
    const steps = stepsOf(a);
    if (!isOpen(a) || !steps || !steps.length || !isDay(today) || !isDay(a.due_date) || a.due_date < today) return '';
    const due = a.due_date;
    const span = daysBetween(today, due) + 1;
    const n = Math.min(PATH_MAX, span);
    const when = (day, isDue) => {
      const d = daysBetween(today, day);
      if (!Number.isFinite(d)) return '';
      if (d < 0) return t('from_day', { day: fmt.rel(day, today, l) }, l);
      if (d === 0) return t('rel_today', null, l);
      if (d === 1) return t('rel_tomorrow', null, l);
      if (d <= 6 || isDue) return `${fmt.rel(day, today, l)} ${t('in_days', { n: d }, l)}`;
      return t('tl_in_days', { n: d }, l);
    };
    const ms = steps.filter((s) => s.kind === 'milestone');
    const next = ms.find((s) => !s.done) || null;
    const points = Math.round(Number(x.points));
    // The line's pieces: [class, text]; the when and the points are kept whole when it wraps.
    let line;
    if (next) {
      line = [['plan-path-what', t('tl_next_flag', { title: str(next.title) }, l)], ['plan-path-when', isDay(next.day) ? when(next.day) : ''],
        ['plan-path-pts', points > 0 ? t('tl_points_now', { n: points }, l) : '']].filter((p) => p[1]);
    } else {
      line = [['plan-path-cheer', ms.length ? t('tl_all_flags', null, l) : ''], ['plan-path-when', t('tl_due_when', { when: when(due, true) }, l)]].filter((p) => p[1]);
    }
    const lineHtml = line.map(([cls, text]) => `<span class="${cls}">${esc(text)}</span>`).join(next ? ' · ' : ' ');
    // Flags on their days; a done one before today is counted at the start, one not done whose day has
    // passed is today's (it is what's next).
    const flags = new Map();
    let won = 0;
    ms.forEach((m) => {
      if (!isDay(m.day)) return;
      const d = daysBetween(today, m.day);
      if (d < 0 && m.done) { won++; return; }
      const i = d < 0 ? 0 : d;
      if (i >= n) return;
      if (!flags.has(i)) flags.set(i, []);
      flags.get(i).push({ done: !!m.done, earlier: d < 0 });
    });
    const work = new Set(steps.filter((s) => !s.done && isDay(s.day) && s.day >= today).map((s) => daysBetween(today, s.day)));
    let dots = won ? `<li class="plan-path-won">${Array.from({ length: Math.min(won, 4) }, () => `<span class="plan-path-flag is-done">${ICON.flag}</span>`).join('')}</li>` : '';
    for (let i = 0; i < n; i++) {
      const day = addDays(today, i);
      const f = flags.get(i) || [];
      const cls = ['plan-path-day'];
      if (i === 0) cls.push('is-today');
      if (day === due) cls.push('is-due');
      if (work.has(i)) cls.push('has-work');
      if (f.length) cls.push('has-flag');
      const flag = f.length ? `<span class="plan-path-flag${f.every((m) => m.done) ? ' is-done' : ''}${f.some((m) => m.earlier) ? ' is-earlier' : ''}">${ICON.flag}</span>` : '';
      dots += `<li class="${cls.join(' ')}">${flag}<span class="plan-path-dot">${day === due ? ICON.star : ''}</span>`
        + `<span class="plan-path-name">${esc(i === 0 ? t('tl_today', null, l) : LETTERS[l][weekday(day)])}</span></li>`;
    }
    const fold = span > PATH_MAX ? `<p class="plan-path-fold" aria-hidden="true">… ${esc(t('due_on', { day: fmt.rel(due, today, l) }, l))}</p>` : '';
    const sr = [t('tl_path', { to: fmt.day(due, l) }, l), won ? (won === 1 ? t('tl_flags_won_one', null, l) : t('tl_flags_won', { n: won }, l)) : '',
      ...ms.filter((m) => !(m.done && isDay(m.day) && m.day < today)).map((m) => (m.done ? t('tl_flag_done', { title: str(m.title) }, l)
        : isDay(m.day) ? t('tl_flag', { title: str(m.title), day: dayIn(m.day, l) }, l) : ''))].filter(Boolean).join(' · ');
    return `<div class="plan-path${span > PATH_MAX ? ' is-folded' : ''}"><p class="plan-path-line">${lineHtml}</p>`
      + `<ol class="plan-path-days" aria-hidden="true">${dots}</ol>${fold}<p class="sr-only">${esc(sr)}</p></div>`;
  }

  // ============================================
  // THE HOMEWORK PAGE'S ROWS → THE EDITOR'S ASSIGNMENT
  // ============================================
  // done_by and given_by are "Pat Lee, tutor (tutor link)", "Jordan (My day)" or an email.
  const roleOf = (by) => (by == null ? null : /\(tutor link\)\s*$/.test(by) ? 'tutor' : /\(My day\)\s*$/.test(by) ? 'kid' : 'family');
  function fromRows(row, stepRows, o) {
    if (!row) return null;
    const x = o || {};
    const steps = (stepRows || []).filter((s) => s && (s.assignment_id == null || s.assignment_id === row.id))
      .slice().sort((a, b) => (Number(a.pos) - Number(b.pos)) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
      .map((s) => ({
        id: s.id, pos: s.pos, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like || null, minutes: s.minutes, day: s.day || null,
        source: s.source || 'typed', done: !!s.done_at, done_by: roleOf(s.done_by), checked: !!s.checked_at, moved_from: s.moved_from || null,
        question: s.question || null, answer: s.answer || null, coach: s.coach_note ? { by: s.coach_note_by, text: s.coach_note } : null,
        qa_log: Array.isArray(s.qa_log) ? s.qa_log : [],
      }));
    const a = {
      id: row.id, kind: row.kind, title: row.title, subject: row.subject || null, due_date: row.due_date, details: row.details || null,
      stretch: row.stretch || null, status: row.status, added_by: row.added_by || 'family', plan_rev: Number(row.plan_rev) || 0,
      given_at: row.given_at || null, given_by: roleOf(row.given_by),
      given_by_name: row.given_by ? String(row.given_by).replace(/\s*\((tutor link|My day)\)\s*$/, '') : null,
      steps, minutes_left: workLeft(steps),
    };
    if (x.week) {
      const l = timeLeft(x.week, { today: x.today, due: row.due_date, kind: row.kind, asOf: x.asOf, own: steps });
      Object.assign(a, { time_left: l.minutes, horizon: l.horizon, no_time: l.no_time });
    }
    return a;
  }

  // ============================================
  // ICONS
  // ============================================
  const ICON = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
    diamond: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/></svg>',
    // The timelines: a flag (a milestone on his path, a due date), the star at his path's end, the arrow past the last day.
    flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 21V3.5M6.5 4.5h11l-2.6 4 2.6 4h-11"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>',
  };

  // ============================================
  // THE PLAN EDITOR (§9.4)
  // ============================================
  function editor(el, opts) {
    const o = Object.assign({ role: 'family', lang: 'en' }, opts || {});
    let a = null;
    let steps = [];
    let dirty = false;
    let busy = false;
    let msg = null;          // { text, error }
    let open = -1;           // the step whose ⋯ is open
    let picking = false;     // the starter plans are showing
    let parts = 2;
    let stopped = false;
    let seq = 0;
    // The AI planner (PR B, §6.10, §9.4): only with opts.ai, never for his role.
    let ai = null;           // the assignment's AI state { state, stop, draft, prev, at }, as last read
    let aiLocal = null;      // { stop } hub-jobs answered at once (not_set_up, cap, month, offline), not stored anywhere
    let aiOff = false;       // hub-jobs said off or not_found: no button until the page draws it again
    let aiBusy = false;
    let poll = null;         // { timer, until } while a run is open
    let prev = { key: null, text: null, failed: false, open: null, seq: 0, timer: null, loading: false };   // What Claude will see
    let asks = { chips: [], note: '', answers: [] };   // Ask again's inputs, kept while the same assignment is on screen
    let fromDraft = null;    // { stretch } once Use this plan loaded a draft, until the next save

    const L = () => langOf(o.lang);
    const w = (key, vars) => t(key, Object.assign({ tutor: o.tutor || null, kid: o.kid || '' }, vars), L());
    const isKid = () => o.role === 'kid';
    const locked = (s) => s.done || (isKid() && !PLAIN.includes(s.kind));
    const snap = (s) => JSON.stringify([s.kind, s.title || '', s.done_looks_like || '', Number(s.minutes) || 0, s.day || null]);
    const copy = (s, source) => {
      const c = {
        key: ++seq, id: s.id || null, kind: s.kind || 'step', title: s.title || '', done_looks_like: s.done_looks_like || '',
        minutes: Number(s.minutes) || 0, day: s.day || null, source: source || s.source || 'typed', done: !!s.done, checked: !!s.checked,
        moved_from: s.moved_from || null,
      };
      c.orig = snap(c);
      return c;
    };
    const changed = (s) => snap(s) !== s.orig;
    const origDays = () => {
      const out = {};
      ((a && a.steps) || []).forEach((s) => { if (s.id) out[s.id] = s.day || null; });
      return out;
    };
    // A done step goes without a day: the database keeps it as it is whatever the list says (§4.4), and
    // one ticked early can sit after a due date moved before it, which the save's day check would refuse.
    const payload = (placeAgain) => steps.map((s) => {
      const x = { kind: s.kind, title: clean(s.title, LIMITS.title[1]), done_looks_like: clean(s.done_looks_like, LIMITS.dll) || null, minutes: s.minutes,
        day: placeAgain || s.done ? null : s.day || null, source: changed(s) ? 'typed' : s.source };
      return s.id ? Object.assign({ id: s.id }, x) : x;
    });
    const say = (err) => (o.friendly ? o.friendly(err) : friendly(err, L(), o.tutor || null));

    function set(next, more) {
      if (more) Object.assign(o, more);
      const same = a && next && a.id === next.id;
      a = next || null;
      steps = ((a && a.steps) || []).map((s) => copy(s));
      dirty = false;
      open = -1;
      picking = false;
      msg = null;
      if (!same) {
        asks = { chips: [], note: '', answers: [] };
        aiLocal = null;
        aiOff = false;
        fromDraft = null;
        clearTimeout(prev.timer);
        prev = { key: null, text: null, failed: false, open: null, seq: prev.seq + 1, timer: null, loading: false };
      }
      ai = a && a.ai && typeof a.ai === 'object' ? a.ai : null;
      if (ai && ai.state === 'running') watch();
      draw();
      loadPreview(true);
    }

    // ---------- Drawing ----------
    function dayOptions(s) {
      const l = L();
      const today = o.today;
      const due = a.due_date;
      // Only the turn-in goes on an assignment's due date; a lesson's do-by day is a work day (§5.4).
      const max = s.kind === 'turn_in' || a.kind === 'lesson' ? due : addDays(due, -1);
      const days = [];
      for (let d = today; d && max && d <= max && days.length < 120; d = addDays(d, 1)) days.push(d);
      const hw = o.week && o.week.length ? new Set(homeworkDays(o.week, today, max)) : null;
      const opt = (d, label) => `<option value="${esc(d)}"${s.day === d ? ' selected' : ''}>${esc(label || fmt.day(d, l))}</option>`;
      let html = '';
      if (!s.day) html += `<option value="" selected>${esc(w('placed_on_save'))}</option>`;
      else if (!days.includes(s.day)) html += opt(s.day, s.day < today ? `${fmt.day(s.day, l)} · ${w('from_day', { day: fmt.rel(s.day, today, l) })}` : '');
      if (hw) {
        const yes = days.filter((d) => hw.has(d));
        const no = days.filter((d) => !hw.has(d));
        if (yes.length) html += `<optgroup label="${esc(w('hw_days'))}">${yes.map((d) => opt(d)).join('')}</optgroup>`;
        if (no.length) html += `<optgroup label="${esc(w('other_days'))}">${no.map((d) => opt(d, `${fmt.day(d, l)} · ${w('not_hw_day')}`)).join('')}</optgroup>`;
      } else {
        html += days.map((d) => opt(d)).join('');
      }
      return html;
    }

    function movable(i, j) {
      const s = steps[i];
      const n = steps[j];
      if (!s || !n || s.done || n.done) return false;
      if (isKid() && (locked(s) || n.kind === 'turn_in')) return false;
      return true;
    }

    function editHtml(s, i) {
      const mins = [];
      for (let m = 5; m <= 60; m += 5) mins.push(m);
      if (s.minutes && !mins.includes(s.minutes)) mins.push(s.minutes);
      mins.sort((x, y) => x - y);
      const kind = isKid() ? '' : `<label class="field"><span>${esc(w('f_kind'))}</span><select name="kind" data-i="${i}">`
        + `${KINDS.map((k) => `<option value="${k}"${k === s.kind ? ' selected' : ''}>${esc(w(`kind_${k}`))}</option>`).join('')}</select></label>`;
      const btn = (act, label, ok, cls) => `<button type="button" class="btn btn-sm${cls ? ` ${cls}` : ''}" data-act="${act}" data-i="${i}"${ok ? '' : ' disabled'}>${esc(label)}</button>`;
      return `<div class="plan-step-edit" data-i="${i}">`
        + `<label class="field"><span>${esc(w('f_title'))}</span><input type="text" name="title" data-i="${i}" maxlength="${LIMITS.title[1]}" value="${esc(s.title)}" autocomplete="off" enterkeyhint="done"></label>`
        + `<label class="field"><span>${esc(w('f_dll'))}</span><input type="text" name="dll" data-i="${i}" maxlength="${LIMITS.dll}" value="${esc(s.done_looks_like)}" autocomplete="off" enterkeyhint="done"></label>`
        + `<div class="field-row"><label class="field"><span>${esc(w('f_minutes'))}</span><select name="minutes" data-i="${i}">`
        + `${mins.map((m) => `<option value="${m}"${m === s.minutes ? ' selected' : ''}>${m}</option>`).join('')}</select></label>${kind}</div>`
        + `<div class="plan-edit-acts">${btn('up', w('move_up'), movable(i, i - 1))}${btn('down', w('move_down'), movable(i, i + 1))}`
        + `${btn('delete', w('delete'), true, 'btn-danger')}${btn('close', w('done_edit'), true, 'btn-primary')}</div></div>`;
    }

    function rowHtml(s, i) {
      const l = L();
      const lk = locked(s);
      const title = s.title || w('untitled');
      const mark = s.done ? ICON.check : s.kind === 'milestone' ? ICON.diamond : '';
      const day = lk
        ? `<span class="plan-step-day">${esc(s.day ? fmt.day(s.day, l) : w('placed_on_save'))}</span>`
        : `<select name="day" class="plan-day" data-i="${i}" aria-label="${esc(w('day_for', { title }))}"${busy ? ' disabled' : ''}>${dayOptions(s)}</select>`;
      const sub = [day, `<span class="plan-step-min">${esc(fmt.duration(s.minutes))}</span>`];
      if (s.kind !== 'step') sub.push(`<span class="plan-tag">${esc(w(`tag_${s.kind}`))}</span>`);
      if (s.moved_from) sub.push(`<span class="plan-step-moved">${esc(w('moved_from', { day: fmt.rel(s.moved_from, o.today, l) }))}</span>`);
      const tail = !lk
        ? `<button type="button" class="plan-more" data-act="more" data-i="${i}" aria-expanded="${open === i}" aria-label="${esc(w('more_for', { title }))}">${ICON.dots}</button>`
        : isKid() && !s.done ? `<span class="plan-lock" role="img" aria-label="${esc(w('checkpoint_short'))}" title="${esc(w('checkpoint_short'))}">${ICON.lock}</span>` : '';
      const cls = `plan-step k-${s.kind}${s.done ? ' is-done' : ''}${lk ? ' is-locked' : ''}${open === i ? ' is-open' : ''}${s.source === 'typed' || changed(s) ? '' : ` src-${esc(s.source)}`}`;
      const aiMark = s.source === 'ai' && !changed(s) && !s.done
        ? ` <span class="plan-ai-mark" title="${esc(w('ai_mark_label'))}">${esc(w('ai_mark'))}</span>` : '';
      return `<li class="${cls}" data-i="${i}"${s.id ? ` data-id="${esc(s.id)}"` : ''}>`
        + `<span class="plan-box${s.done ? ' is-done' : ''}" aria-hidden="true">${mark}</span>`
        + `<div class="plan-step-main"><span class="plan-step-title">${esc(title)}${aiMark}</span>`
        + `<span class="plan-step-sub">${sub.join(' ')}</span>`
        + `${s.done_looks_like ? `<span class="plan-step-dll">${esc(w('dll_line', { text: s.done_looks_like }))}</span>` : ''}</div>`
        + `${tail}${open === i && !lk ? editHtml(s, i) : ''}</li>`;
    }

    function fitHtml() {
      const l = L();
      const work = workLeft(steps);
      let time = a.time_left != null ? Number(a.time_left) : null;
      let hz = a.horizon || null;
      let noTime = !!a.no_time;
      if (time == null && o.week && o.today) {
        const tl = timeLeft(o.week, { today: o.today, due: a.due_date, kind: a.kind, asOf: o.asOf, own: steps });
        time = tl.minutes;
        hz = tl.horizon;
        noTime = tl.no_time;
      }
      let html = bars(work, time, { lang: l, horizon: hz, no_time: noTime });
      if (!noTime && time != null && work <= time && steps.some((s) => !s.done)) {
        const n = spare(steps, a.due_date);
        const text = n == null || n === 0 ? w('fits') : n === 1 ? w('fits_spare_1') : w('fits_spare', { n });
        html += `<p class="plan-fit is-ok">${esc(text)}</p>`;
      }
      return `<div class="plan-ed-fit">${html}</div>`;
    }

    function givenHtml() {
      if (!a.given_at || isKid()) return '';
      const who = a.given_by === 'tutor'
        ? (o.role === 'tutor' ? w('who_you') : a.given_by_name || w('who_tutor'))
        : a.given_by === 'kid' ? o.kid || '' : (o.role === 'family' && a.given_by_name) || w('who_family');
      const day = localDay(a.given_at, o.asOf, o.serverNow);
      return `<p class="plan-given">${esc(day ? w('given_line', { day: fmt.rel(day, o.today, L()), who }) : w('given_line_nodate', { who }))}</p>`;
    }

    function html() {
      const l = L();
      const due = a.due_date;
      const n = daysBetween(o.today, due);
      const when = w(a.kind === 'lesson' ? 'do_by' : 'due_on', { day: fmt.rel(due, o.today, l) });
      const away = n > 1 ? ` ${w('in_days', { n })}` : n < -1 ? ` ${w('days_ago', { n: -n })}` : '';
      const head = `<div class="plan-ed-head"><h2 class="plan-ed-title">${esc(a.title)}</h2><p class="plan-ed-due">${esc(when + away)}</p></div>`;
      const text = o.showDetails !== false && !isKid() && a.details
        ? `<details class="plan-text"><summary>${esc(w('teachers_text'))}</summary><div class="plan-text-body">${esc(a.details)}</div></details>` : '';
      const dis = busy ? ' disabled' : '';
      const send = aiCan() ? `<button type="button" class="btn btn-primary" data-act="ai-send"${busy || aiBusy || aiRunning() || previewPending() ? ' disabled' : ''}>${esc(w('ai_send'))}</button>` : '';
      const tools = isKid()
        ? `<div class="plan-tools"><button type="button" class="btn" data-act="add"${dis}>${esc(w('add_step'))}</button>`
          + `<button type="button" class="btn" data-act="replan"${busy || dirty ? ' disabled' : ''}${dirty ? ` title="${esc(w('save_first'))}"` : ''}>${esc(w('replan'))}</button></div>`
        : `<div class="plan-tools">${send}<button type="button" class="btn" data-act="starter" aria-expanded="${picking}"${dis}>${esc(w('starter_btn'))}</button>`
          + `<button type="button" class="btn" data-act="add"${dis}>${esc(w('add_step'))}</button>`
          + `${steps.some((s) => !s.done) ? `<button type="button" class="btn" data-act="place"${dis}>${esc(w('place_again'))}</button>` : ''}</div>`;
      let picker = '';
      if (picking && !isKid()) {
        const g = guess(a.title, a.kind);
        const left = steps.filter((s) => !s.done).length;
        picker = `<div class="plan-starter"><p class="plan-starter-q">${esc(w('starter_pick'))}${left ? ` ${esc(w('starter_replace', { n: left }))}` : ''}</p>`
          + `<div class="plan-chips">${STARTERS.map((k) => `<button type="button" class="plan-chip${k === g ? ' is-guess' : ''}" data-starter="${k}"${dis}>${esc(w(`starter_${k}`))}</button>`).join('')}</div>`
          + `<div class="plan-starter-foot"><label class="plan-parts"><span>${esc(w('parts'))}</span><input type="number" name="parts" min="1" max="10" step="1" inputmode="numeric" value="${parts}"></label>`
          + `<button type="button" class="btn btn-sm" data-act="cancel-starter">${esc(w('cancel'))}</button></div></div>`;
      }
      const list = steps.length
        ? `<ol class="plan-steps">${steps.map(rowHtml).join('')}</ol>`
        : `<p class="empty-line plan-empty">${esc(w(isKid() ? 'no_steps_kid' : 'no_steps'))}</p>`;
      const lock = isKid() && steps.some((s) => !s.done && !PLAIN.includes(s.kind))
        ? `<p class="plan-lock-note">${ICON.lock}<span>${esc(w('milestone_lock'))}</span></p>` : '';
      const note = msg ? `<p class="plan-msg${msg.error ? ' is-error' : ''}" role="${msg.error ? 'alert' : 'status'}">${esc(msg.text)}</p>` : '';
      const give = !isKid() && !a.given_at;
      const acts = `<div class="plan-actions">`
        + `<button type="button" class="btn${give ? '' : ' btn-primary'}" data-act="save"${!dirty || busy ? ' disabled' : ''}>${esc(w('save'))}</button>`
        + `${give ? `<button type="button" class="btn btn-primary" data-act="give"${busy || !steps.length ? ' disabled' : ''}>${esc(w('give'))}</button>` : ''}`
        + `${givenHtml()}</div>`;
      return `<div class="plan-editor" data-role="${esc(o.role)}"${busy ? ' aria-busy="true"' : ''}>${head}${text}${aiPreviewHtml()}${tools}${aiStatusHtml()}${picker}`
        + `${aiDraftHtml()}${list}${lock}${fitHtml()}${note}${acts}</div>`;
    }

    function draw() {
      if (stopped) return;
      if (!a) { el.innerHTML = ''; return; }
      const f = el.contains(document.activeElement) ? document.activeElement : null;
      const keep = f && f.name ? { name: f.name, i: f.getAttribute('data-i'), act: null }
        : f && f.dataset && f.dataset.act ? { act: f.dataset.act, i: f.getAttribute('data-i') } : null;
      el.innerHTML = html();
      if (keep) {
        const sel = keep.act ? `[data-act="${keep.act}"]` : `[name="${keep.name}"]`;
        const again = el.querySelector(keep.i != null ? `${sel}[data-i="${keep.i}"]` : sel);
        if (again && !again.disabled) again.focus();
      }
    }
    const focusField = (i, name) => {
      const x = el.querySelector(`[name="${name}"][data-i="${i}"]`);
      if (x) x.focus();
    };

    // ---------- Saving ----------
    async function call(fn, done) {
      if (busy || stopped) return;
      busy = true;
      msg = null;
      draw();
      let r;
      try { r = await fn(); } catch (err) { r = { error: err }; }
      busy = false;
      if (stopped) return;
      if (r && r.gone) { draw(); if (o.onGone) o.onGone(); return; }
      if (r && r.error) {
        if (CONFLICT.test(messageOf(r.error)) && o.api && o.api.reload) {
          let rr;
          try { rr = await o.api.reload(); } catch (err) { rr = { error: err }; }
          if (stopped) return;
          if (rr && rr.gone) { if (o.onGone) o.onGone(); return; }
          if (rr && rr.assignment) {
            set(rr.assignment);
            msg = { text: w('changed_reload') };
          } else {
            msg = { text: w('changed'), error: true };
          }
        } else {
          msg = { text: say(r.error), error: true };
        }
        draw();
        return;
      }
      if (r && r.assignment) {
        const used = fromDraft;
        fromDraft = null;
        set(r.assignment);
        if (done && o.toast) o.toast(done);
        if (o.onSaved) o.onSaved(r.assignment);
        // Use this plan, then Save or Give: the draft's stretch question goes to the assignment (§6.10).
        if (used && used.stretch && used.stretch !== (r.assignment.stretch || null) && aiOpts() && aiOpts().stretch) {
          Promise.resolve(aiOpts().stretch(used.stretch)).catch(() => {});
        }
      } else {
        draw();
      }
    }

    function save(give, placeAgain) {
      if (!a || !o.api || !o.api.save) return;
      const list = payload(placeAgain);
      const problem = check(list.map((x, i) => Object.assign({}, x, { done: steps[i].done })), { due: a.due_date, today: o.today, kind: a.kind, orig: origDays() });
      if (problem) {
        const n = problem.i + 1;
        msg = { text: problem.i < steps.length ? w('step_n', { n, text: w(`chk_${problem.key}`) }) : w(`chk_${problem.key}`), error: true };
        if (problem.i < steps.length && !locked(steps[problem.i]) && /title|dll|minutes|kind/.test(problem.key)) open = problem.i;
        draw();
        return;
      }
      call(() => o.api.save({ steps: list, rev: Number(a.plan_rev) || 0, give: !!give }),
        give ? w('given_toast') : placeAgain ? w('placed') : w('saved'));
    }

    function applyStarter(key) {
      if (!a || busy) return;
      const fresh = starter(key, { lang: L(), length: o.length, parts, today: o.today, due: a.due_date, kind: a.kind, asOf: o.asOf, week: o.week });
      steps = steps.filter((s) => s.done).concat(fresh.map((s) => copy(s, 'template')));
      picking = false;
      open = -1;
      dirty = true;
      save(false, false);
    }

    function markDirty() {
      dirty = true;
      const b = el.querySelector('[data-act="save"]');
      if (b && !busy) b.disabled = false;
      const r = el.querySelector('[data-act="replan"]');
      if (r) r.disabled = true;
    }

    // ---------- The AI planner (§6.4, §6.9, §6.10) ----------
    // opts.ai: { on (the asker may ask now), sent: { get(id), set(id, mark) } (the device's "last sent" marks, or null),
    // preview({ kind, request, answers }) → the message text (or null), send({ kind, request, answers, key }) →
    // { run_id } | { stop, run_id? } | { error }, state() → { ai } | { error } | { gone }, draft(action) → { ai } | { error },
    // stretch(text) }. Each may throw; nothing here touches the database itself.
    const aiOpts = () => (!isKid() && o.ai && typeof o.ai === 'object' ? o.ai : null);
    const aiCan = () => !!(aiOpts() && aiOpts().on && !aiOff && a);
    const aiRunning = () => !!(ai && ai.state === 'running');
    const hasPlan = () => !!(a && ((a.steps || []).length || (ai && ai.draft)));
    const aiKind = () => (hasPlan() ? 'revise' : 'plan');
    const CHIPS = ['smaller', 'fewer', 'no_wed', 'later', 'writing'];
    // The request: the chips' words and the note, in the asker's language; null when there is none (a plan never has one).
    function aiRequest() {
      if (aiKind() !== 'revise') return null;
      const parts = CHIPS.filter((c) => asks.chips.includes(c)).map((c) => w(`ai_chip_${c}`));
      const note = clean(asks.note, 300);
      if (note) parts.push(note);
      return parts.length ? parts.join('. ') : null;
    }
    function aiAnswers() {
      const qs = ai && ai.draft && Array.isArray(ai.draft.questions) ? ai.draft.questions : [];
      const out = qs.map((q, i) => clean(asks.answers[i], 300)).filter(Boolean).slice(0, 3);
      return out.length ? out : null;
    }
    const tooLong = () => chars(aiRequest() || '') > 200 || (aiAnswers() || []).some((x) => chars(x) > 200);
    function stopWords(stop) {
      const k = String(stop || '');
      if (/^refusal/.test(k)) return w('ai_s_refusal');
      const key = { not_set_up: 'ai_s_not_set_up', cap: 'ai_s_cap', month: 'ai_s_month', auth: 'ai_s_auth', spend_limit: 'ai_s_spend',
        billing: 'ai_s_billing', offline: 'offline', changed: 'ai_s_changed' }[k];
      if (key) return w(key);
      if (k === 'late' || k === 'off' || k === 'not_found' || k === 'busy') return '';
      return w('ai_s_later');
    }
    // What Claude will see: read again when what would be sent may have changed (debounced while typing).
    // While a read is waiting or on its way, Send to Claude and Ask again wait too (what they would send isn't shown yet).
    function previewPending() { return !!(prev.timer || prev.loading); }
    function setSendable() {
      const dis = busy || aiBusy || aiRunning() || previewPending();
      const s = el.querySelector('[data-act="ai-send"]');
      if (s) s.disabled = dis;
      const again = el.querySelector('[data-act="ai-again"]');
      if (again) again.disabled = dis || tooLong();
    }
    function loadPreview(now) {
      const x = aiOpts();
      if (!aiCan() || !x.preview) return;
      clearTimeout(prev.timer);
      prev.timer = setTimeout(() => {
        prev.timer = null;
        const kind = aiKind();
        const request = aiRequest();
        const answers = aiAnswers();
        const key = JSON.stringify([a && a.id, kind, request, answers]);
        const n = ++prev.seq;
        prev.loading = true;
        Promise.resolve().then(() => x.preview({ kind, request, answers })).then((text) => {
          if (stopped || n !== prev.seq) return;
          const was = prev.text;
          prev.loading = false;
          prev.key = key;
          prev.failed = typeof text !== 'string';
          prev.text = typeof text === 'string' ? text : null;
          if (was !== prev.text) prev.open = null;   // something new to read: the device decides again
          draw();
        }, () => {
          if (stopped || n !== prev.seq) return;
          prev.loading = false;
          prev.failed = true;
          draw();
        });
      }, now ? 0 : 500);
      setSendable();
    }
    // Open whenever what would be sent differs from what was last sent from this device (always, without storage).
    function previewOpen() {
      if (prev.open !== null) return prev.open;
      if (prev.text == null) return true;
      let last = null;
      try { last = aiOpts().sent ? aiOpts().sent.get(a.id) : null; } catch (e) { last = null; }
      return last !== previewMark(prev.text);
    }
    function aiPreviewHtml() {
      if (!aiCan()) return '';
      const body = prev.text != null ? `<pre class="plan-ai-text">${esc(prev.text)}</pre><p class="plan-ai-hint">${esc(w('ai_preview_hint'))}</p>`
        : prev.failed ? `<p class="plan-ai-hint is-error">${esc(w('ai_preview_failed'))}</p>` : `<p class="plan-ai-hint">${esc(w('loading'))}</p>`;
      return `<details class="plan-ai-preview"${previewOpen() ? ' open' : ''}><summary>${esc(w('ai_preview'))}</summary>${body}</details>`;
    }
    function aiStatusHtml() {
      if (!aiOpts()) return '';
      if (aiRunning()) return `<p class="plan-ai-status" role="status">${esc(w('ai_thinking'))}</p>`;
      const stop = aiLocal ? aiLocal.stop : ai && ai.state === 'failed' ? ai.stop : null;
      const words = stop && (aiCan() || aiLocal) ? stopWords(stop) : '';
      return words ? `<p class="plan-ai-status is-stop" role="status">${esc(words)}</p>` : '';
    }
    function aiDraftHtml() {
      const d = ai && ai.draft && Array.isArray(ai.draft.steps) ? ai.draft : null;
      if (!aiOpts() || !d) return '';
      const l = L();
      const dis = busy || aiBusy ? ' disabled' : '';
      const label = w('ai_label', { what: w(a.given_at ? 'ai_changes' : 'ai_draft') });
      const [first, ...rest] = label.split(' · ');
      const rows = d.steps.map((s) => {
        const tag = s.kind && s.kind !== 'step' ? ` <span class="plan-tag">${esc(w(`tag_${s.kind}`))}</span>` : '';
        return `<li class="plan-ai-step k-${esc(s.kind)}"><span class="plan-step-day">${esc(s.day ? fmt.day(s.day, l) : w('placed_on_save'))}</span>`
          + `<span class="plan-ai-step-title">${s.kind === 'milestone' ? ICON.diamond : ''}${esc(s.title)} · ${esc(fmt.duration(s.minutes))}${tag}</span>`
          + `<span class="plan-ai-mark">${esc(w('ai_mark'))}</span>`
          + `${s.done_looks_like ? `<span class="plan-step-dll">${esc(w('dll_line', { text: s.done_looks_like }))}</span>` : ''}</li>`;
      }).join('');
      const fit = d.fits === false || Number(d.over) > 0 ? `<p class="plan-fit is-over">${esc(w('ai_over', { n: Number(d.over) || 0 }))}</p>`
        : `<p class="plan-fit is-ok">${esc(w('ai_fits'))}</p>`;
      const qs = Array.isArray(d.questions) ? d.questions : [];
      const questions = qs.length ? `<div class="plan-ai-qs"><p class="plan-ai-sub">${esc(w('ai_questions'))}</p>${qs.map((q, i) => `<label class="field plan-ai-q">`
        + `<span>${esc(q)}</span><input type="text" name="ai-answer" data-i="${i}" maxlength="200" value="${esc(asks.answers[i] || '')}" placeholder="${esc(w('ai_answer'))}" autocomplete="off"></label>`).join('')}</div>` : '';
      const ask = aiCan() ? aiAskHtml(dis) : '';
      return `<section class="plan-ai-draft" aria-label="${esc(first)}"><div class="plan-ai-head"><p class="plan-ai-label"><b>${esc(first)}</b> · ${esc(rest.join(' · '))}</p>`
        + `<div class="plan-ai-acts"><button type="button" class="btn btn-sm btn-primary" data-act="ai-use"${dis}>${esc(w('ai_use'))}</button>`
        + `${ai.prev ? `<button type="button" class="btn btn-sm" data-act="ai-undo"${dis}>${esc(w('ai_undo'))}</button>` : ''}`
        + `<button type="button" class="btn btn-sm" data-act="ai-dismiss"${dis}>${esc(w('ai_dismiss'))}</button></div></div>`
        + `${d.summary ? `<p class="plan-ai-summary">${esc(d.summary)}</p>` : ''}<ol class="plan-ai-steps">${rows}</ol>${fit}`
        + `${d.note_for_adult ? `<p class="plan-ai-note">${esc(w('ai_note_adult', { text: d.note_for_adult }))}</p>` : ''}${questions}`
        + `${d.stretch ? `<p class="plan-ai-stretch">${esc(w('ai_optional', { text: d.stretch }))}</p>` : ''}${ask}</section>`;
    }
    function aiAskHtml(dis) {
      const chips = CHIPS.map((c) => `<button type="button" class="plan-chip" data-ai-chip="${c}" aria-pressed="${asks.chips.includes(c)}"${dis}>${esc(w(`ai_chip_${c}`))}</button>`).join('');
      const long = tooLong();
      return `<div class="plan-ai-ask"><p class="plan-ai-sub">${esc(w('ai_ask_for'))}</p><div class="plan-chips">${chips}</div>`
        + `<label class="field"><span class="sr-only">${esc(w('ai_note'))}</span><input type="text" name="ai-note" maxlength="200" value="${esc(asks.note)}" placeholder="${esc(w('ai_note'))}" autocomplete="off"></label>`
        + `${long ? `<p class="form-error">${esc(w('ai_too_long'))}</p>` : ''}`
        + `<button type="button" class="btn" data-act="ai-again"${dis || aiRunning() || long || previewPending() ? ' disabled' : ''}>${esc(w('ai_again'))}</button></div>`;
    }
    // A run is open: read its state every 5 seconds until it ends or its lease (6 minutes) runs out.
    function watch() {
      const x = aiOpts();
      if (!x || !x.state || poll) return;
      poll = { until: Date.now() + 6.5 * 60 * 1000, timer: null };
      const tick = async () => {
        if (!poll || stopped) return;
        poll.timer = null;
        let r;
        try { r = await x.state(); } catch (err) { r = { error: err }; }
        if (stopped || !poll) return;
        if (r && r.gone) { poll = null; if (o.onGone) o.onGone(); return; }
        if (r && 'ai' in r) ai = r.ai && typeof r.ai === 'object' ? r.ai : null;
        if (aiRunning() && Date.now() < poll.until) { poll.timer = setTimeout(tick, 5000); return; }
        if (aiRunning()) ai = Object.assign({}, ai, { state: 'failed', stop: 'timeout' });
        poll = null;
        draw();
        loadPreview(true);
      };
      poll.timer = setTimeout(tick, 5000);
    }
    // What Claude will see has changed since it was drawn: drawn again, open, and nothing sent until the next tap.
    function previewChanged(text) {
      prev.text = text;
      prev.failed = false;
      prev.open = true;
      aiLocal = { stop: 'changed' };
      draw();
    }
    async function aiSend() {
      const x = aiOpts();
      if (!aiCan() || aiBusy || busy || aiRunning() || tooLong() || previewPending()) return;
      // What the page showed at the tap: the message sent must be exactly this (§6.4).
      const shownText = prev.text;
      // Ask again: the editor is saved first, so current_plan is the plan as people left it (§6.10).
      if (dirty) {
        const before = a && a.plan_rev;
        await new Promise((done) => { save(false, false); const wait = () => (busy ? setTimeout(wait, 50) : done()); wait(); });
        if (stopped || dirty || (a && a.plan_rev === before)) return;
      }
      const kind = aiKind();
      const request = aiRequest();
      const answers = aiAnswers();
      aiBusy = true;
      aiLocal = null;
      draw();
      // What Claude will see, read again with exactly what goes: something changed since it was shown (the school's
      // update, an edit on another phone, a step renamed on My day, the plan just saved) → shown again, not sent.
      clearTimeout(prev.timer);
      prev.timer = null;
      const n = ++prev.seq;
      prev.loading = false;
      let text = null;
      try { text = await x.preview({ kind, request, answers, fresh: true }); } catch (err) { text = null; }
      if (stopped || n !== prev.seq) { aiBusy = false; if (!stopped) draw(); return; }
      if (typeof text !== 'string') { aiBusy = false; prev.failed = prev.text == null; aiLocal = { stop: 'offline' }; draw(); return; }
      prev.key = JSON.stringify([a && a.id, kind, request, answers]);
      if (text !== shownText) { aiBusy = false; previewChanged(text); return; }
      let r;
      try { r = await x.send({ kind, request, answers, key: newId(), shown: previewSeal(text) }); } catch (err) { r = { error: err }; }
      aiBusy = false;
      if (stopped) return;
      if (!r || r.error) { aiLocal = { stop: r && r.stop ? r.stop : 'offline' }; draw(); return; }
      if (r.stop === 'changed') {
        // hub-jobs built a different message than this one (it changed in the moment between): read it again, open.
        aiLocal = { stop: 'changed' };
        prev.open = true;
        ai = Object.assign({}, ai || {}, { state: 'failed', stop: 'changed' });
        draw();
        let again = null;
        try { again = await x.preview({ kind, request, answers, fresh: true }); } catch (err) { again = null; }
        if (stopped) return;
        if (typeof again === 'string') previewChanged(again);
        return;
      }
      if (r.stop && r.stop !== 'busy') {
        if (r.stop === 'off' || r.stop === 'not_found') aiOff = true;
        aiLocal = { stop: r.stop };
        draw();
        return;
      }
      const sentText = text;
      // The run is open (or one was already): what was sent is marked on the device, and the inputs are cleared.
      if (sentText != null && x.sent) { try { x.sent.set(a.id, previewMark(sentText)); } catch (e) { /* no storage: always open */ } }
      prev.open = null;
      asks = { chips: [], note: '', answers: [] };
      ai = Object.assign({}, ai || {}, { state: 'running', stop: null });
      watch();
      draw();
    }
    // Use this plan: the draft into the editor, nothing saved (§6.10). A draft step that is a person's locked step put
    // back (§6.8) comes in as that person's step, with its own text: the draft holds the copy the AI was sent, with
    // the names, links, emails and phone numbers taken out and '<' replaced, which must never reach his plan. The
    // draft's id is only a hint: the database numbered the steps again when the answer came, so a step ticked, added
    // or moved in between can shift it onto another step. So a draft step takes a not-done typed step of the plan
    // whose kind and text it matches (that copy is of it), the one its id names first. A person's copy (its ref or id
    // says so) that matches none: a step done since is left out (it stays done); one whose id names a typed step of
    // its kind that nothing else took is that step, renamed since (its new words win). Anything else is the AI's own,
    // new step. And Use this plan never drops a person's typed step: one no draft step took (added while the AI was
    // asked) stays, before the turn-in (a person's turn-in in place of the AI's).
    function aiUse() {
      const d = ai && ai.draft;
      if (!d || !Array.isArray(d.steps) || busy) return;
      const mine = steps.filter((s) => !s.done && s.id && s.source === 'typed');
      const done = steps.filter((s) => s.done);
      const taken = new Map();   // a step of the plan → the draft step that took it
      const ofIt = (s, x) => x.kind === s.kind && copyOf(s.title, x.title);
      const theirs = (s) => (typeof s.ref === 'string' && s.ref !== 'new') || !!s.id;
      const free = (x) => !taken.has(x);
      d.steps.forEach((s) => {
        const was = (s.id && mine.find((x) => x.id === s.id && free(x) && ofIt(s, x))) || mine.find((x) => free(x) && ofIt(s, x));
        if (was) taken.set(was, s);
      });
      const claimed = new Set(taken.values());
      d.steps.forEach((s) => {
        if (claimed.has(s) || !theirs(s) || done.some((x) => ofIt(s, x))) return;
        const was = s.id && mine.find((x) => x.id === s.id && free(x) && x.kind === s.kind);
        if (was) { taken.set(was, s); claimed.add(s); }
      });
      const by = new Map([...taken].map(([x, s]) => [s, x]));
      const fresh = [];
      d.steps.forEach((s) => {
        const was = by.get(s);
        if (was) {
          fresh.push(copy({ id: was.id, kind: was.kind, title: was.title, done_looks_like: was.done_looks_like, minutes: was.minutes, day: s.day || null }, was.source));
          return;
        }
        if (theirs(s) && done.some((x) => ofIt(s, x))) return;
        fresh.push(copy({ id: null, kind: s.kind, title: s.title, done_looks_like: s.done_looks_like, minutes: s.minutes, day: s.day || null }, 'ai'));
      });
      mine.filter(free).forEach((x) => {
        const keep = copy(x);
        const end = fresh.findIndex((y) => y.kind === 'turn_in');
        if (x.kind === 'turn_in' && end >= 0 && fresh[end].source === 'ai') fresh.splice(end, 1, keep);
        else if (x.kind === 'turn_in') fresh.push(keep);
        else fresh.splice(end >= 0 ? end : fresh.length, 0, keep);
      });
      steps = done.concat(fresh);
      dirty = true;
      open = -1;
      picking = false;
      fromDraft = { stretch: d.stretch || null };
      msg = { text: w('ai_loaded') };
      draw();
    }
    async function aiDraftAct(action) {
      const x = aiOpts();
      if (!x || !x.draft || aiBusy || busy) return;
      aiBusy = true;
      draw();
      let r;
      try { r = await x.draft(action); } catch (err) { r = { error: err }; }
      aiBusy = false;
      if (stopped) return;
      if (r && r.gone) { draw(); if (o.onGone) o.onGone(); return; }
      if (!r || r.error) { msg = { text: r && r.error ? say(r.error) : w('offline'), error: true }; draw(); return; }
      if ('ai' in r) ai = r.ai && typeof r.ai === 'object' ? r.ai : null;
      aiLocal = null;
      asks.answers = [];
      draw();
      loadPreview(true);
    }

    // ---------- Taps and typing ----------
    function onClick(e) {
      const btn = e.target.closest('button');
      if (!btn || !el.contains(btn) || btn.disabled || !a) return;
      const i = btn.hasAttribute('data-i') ? Number(btn.getAttribute('data-i')) : -1;
      if (btn.dataset.starter) { applyStarter(btn.dataset.starter); return; }
      if (btn.dataset.aiChip) {
        const c = btn.dataset.aiChip;
        asks.chips = asks.chips.includes(c) ? asks.chips.filter((x) => x !== c) : asks.chips.concat([c]);
        draw();
        loadPreview(false);
        return;
      }
      switch (btn.dataset.act) {
        case 'ai-send': case 'ai-again': aiSend(); return;
        case 'ai-use': aiUse(); return;
        case 'ai-undo': aiDraftAct('undo'); return;
        case 'ai-dismiss': aiDraftAct('dismiss'); return;
        default:
      }
      switch (btn.dataset.act) {
        case 'more':
          open = open === i ? -1 : i;
          draw();
          if (open === i) focusField(i, 'title');
          break;
        case 'close':
          open = -1;
          draw();
          break;
        case 'up':
        case 'down': {
          const j = btn.dataset.act === 'up' ? i - 1 : i + 1;
          if (!movable(i, j)) return;
          [steps[i], steps[j]] = [steps[j], steps[i]];
          open = j;
          dirty = true;
          draw();
          break;
        }
        case 'delete':
          if (!steps[i] || locked(steps[i])) return;
          steps.splice(i, 1);
          open = -1;
          dirty = true;
          draw();
          break;
        case 'add': {
          const s = copy({ kind: 'step', title: '', minutes: LENGTHS.includes(Number(o.length)) ? Number(o.length) : 20, day: null }, 'typed');
          s.orig = null;
          const last = steps.length && steps[steps.length - 1].kind === 'turn_in' ? steps.length - 1 : steps.length;
          steps.splice(last, 0, s);
          open = last;
          picking = false;
          dirty = true;
          draw();
          focusField(last, 'title');
          break;
        }
        case 'starter':
          picking = !picking;
          draw();
          break;
        case 'cancel-starter':
          picking = false;
          draw();
          break;
        case 'place':
          save(false, true);
          break;
        case 'replan':
          if (dirty || !o.api || !o.api.replan) return;
          call(() => o.api.replan(), w('replanned'));
          break;
        case 'save':
          save(false, false);
          break;
        case 'give':
          save(true, false);
          break;
        default:
      }
    }
    function onInput(e) {
      const x = e.target;
      if (x.name === 'parts') { parts = Math.min(10, Math.max(1, Math.floor(Number(x.value)) || 2)); return; }
      if (x.name === 'ai-note' || x.name === 'ai-answer') {
        if (x.name === 'ai-note') asks.note = x.value;
        else asks.answers[Number(x.getAttribute('data-i')) || 0] = x.value;
        const err = el.querySelector('.plan-ai-ask .form-error');
        const again = el.querySelector('[data-act="ai-again"]');
        if (again) again.disabled = busy || aiBusy || aiRunning() || tooLong();
        if (!!err !== tooLong()) draw();
        loadPreview(false);
        return;
      }
      const i = Number(x.getAttribute('data-i'));
      const s = steps[i];
      if (!s || locked(s)) return;
      if (x.name === 'title') {
        s.title = x.value;
        const span = el.querySelector(`.plan-step[data-i="${i}"] .plan-step-title`);
        if (span) span.textContent = s.title || w('untitled');
        markDirty();
      } else if (x.name === 'dll') {
        s.done_looks_like = x.value;
        markDirty();
      }
    }
    function onChange(e) {
      const x = e.target;
      if (x.name === 'ai-note' || x.name === 'ai-answer') return;
      const i = Number(x.getAttribute('data-i'));
      const s = steps[i];
      if (!s || locked(s)) return;
      if (x.name === 'day') s.day = x.value || null;
      else if (x.name === 'minutes') s.minutes = Number(x.value);
      else if (x.name === 'kind' && !isKid() && KINDS.includes(x.value)) s.kind = x.value;
      else return;
      dirty = true;
      draw();
    }
    // The fold the person opened or closed stays so until what it shows changes.
    function onToggle(e) {
      if (e.target && e.target.classList && e.target.classList.contains('plan-ai-preview')) prev.open = e.target.open;
    }
    function onKey(e) {
      if (e.key === 'Enter' && e.target && (e.target.name === 'title' || e.target.name === 'dll')) {
        e.preventDefault();
        open = -1;
        draw();
      }
    }

    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKey);
    el.addEventListener('toggle', onToggle, true);
    if (o.assignment) set(o.assignment);

    return Object.freeze({
      set,
      get: () => a,
      dirty: () => dirty,
      stop() {
        stopped = true;
        if (poll && poll.timer) clearTimeout(poll.timer);
        poll = null;
        clearTimeout(prev.timer);
        el.removeEventListener('click', onClick);
        el.removeEventListener('input', onInput);
        el.removeEventListener('change', onChange);
        el.removeEventListener('keydown', onKey);
        el.removeEventListener('toggle', onToggle, true);
      },
    });
  }

  // ============================================
  // PAT'S LINK (§9.5)
  // ============================================
  function tutor(el, opts) {
    const o = Object.assign({}, opts || {});
    const api = o.api || {};
    let lang = langOf(o.lang);
    let view = null;             // the last answer of tutor_view_by_token
    let screen = { kind: 'list' };
    let detail = null;           // the open assignment, as its answer had it
    let ed = null;               // the editor on an assignment's screen, and its assignment id
    let edFor = null;
    let note = null;             // { step, action, text } the open note or answer on the list
    let formDirty = false;
    let failed = null;           // 'gone' | 'not_yet' | 'offline' | null
    let stopped = false;
    let chain = Promise.resolve();
    const serial = (fn) => {
      const p = chain.then(() => (stopped ? null : fn()));
      chain = p.catch(() => {});
      return p;
    };
    const w = (key, vars) => t(key, Object.assign({ tutor: tutorName(), kid: (view && view.kid) || '' }, vars), lang);
    const tutorName = () => (view && view.tutor ? String(view.tutor).split(/[\s,]+/)[0] : null);
    const rel = (d) => fmt.rel(d, view && view.today, lang);
    const toast = (text, x) => { if (o.toast) o.toast(text, x); };
    const go = (hash) => { if (o.go) o.go(hash); else location.hash = hash; };
    const take = (data) => {
      if (data && typeof data === 'object' && Array.isArray(data.assignments)) {
        view = data;
        lang = langOf(data.language || lang);
        return true;
      }
      return false;
    };
    const entryOf = (id) => ((view && view.assignments) || []).find((x) => x.id === id) || null;
    // The open assignment with its bars' numbers, which Pat's view carries on the list's entry.
    const withTime = (x) => {
      if (!x) return x;
      const e = entryOf(x.id);
      return Object.assign({}, x, e ? { minutes_left: e.minutes_left, time_left: e.time_left, no_time: e.no_time, horizon: x.horizon != null ? x.horizon : e.horizon } : {});
    };

    function gone() {
      failed = 'gone';
      view = null;
      if (ed) { ed.stop(); ed = null; edFor = null; }
      el.innerHTML = `<div class="plan-problem day-problem"><p>${esc(t('link_gone', null, lang))}</p></div>`;
      if (o.onGone) o.onGone();
    }
    // What an answer means for the page: true when it can be used.
    function handle(r, quiet) {
      const k = answer(r);
      if (k === 'ok') { failed = null; return true; }
      if (k === 'gone') { gone(); return false; }
      if (k === 'not_yet') {
        failed = 'not_yet';
        el.innerHTML = `<div class="plan-problem day-problem"><p>${esc(t('link_not_yet', null, lang))}</p></div>`;
        return false;
      }
      if (k === 'retry' && !view) {
        failed = 'offline';
        el.innerHTML = `<div class="plan-problem day-problem"><p>${esc(t('offline', null, lang))}</p>`
          + `<p><button type="button" class="btn" data-act="retry">${esc(t('try_again', null, lang))}</button></p></div>`;
        return false;
      }
      if (!quiet) toast(k === 'retry' ? t('refresh_failed', null, lang) : friendly(r && r.error, lang, tutorName()), { error: true });
      return false;
    }

    function parse(hash) {
      const h = String(hash || '');
      let m = /^#a\/([0-9a-f-]{36})$/i.exec(h);
      if (m && UUID_RE.test(m[1])) return { kind: 'assignment', id: m[1].toLowerCase() };
      m = /^#new\/(assignment|lesson)$/.exec(h);
      if (m) return { kind: 'new', type: m[1] };
      return { kind: 'list' };
    }

    function show(hash) {
      if (stopped) return Promise.resolve();
      const next = parse(hash);
      if (screen.kind === 'assignment' && !(next.kind === 'assignment' && next.id === screen.id) && ed) {
        ed.stop();
        ed = null;
        edFor = null;
      }
      screen = next;
      note = null;
      formDirty = false;
      if (screen.kind === 'new' && view) { draw(); return Promise.resolve(); }
      if (!view || failed) el.innerHTML = `<p class="loading">${esc(t('loading', null, lang))}</p>`;
      return load(false);
    }

    function load(quiet) {
      const id = screen.kind === 'assignment' ? screen.id : null;
      return serial(async () => {
        let r;
        try { r = await api.view(id, 'all'); } catch (err) { r = { error: err }; }
        if (stopped || !handle(r, quiet)) return;
        take(r.data);
        if (id && screen.kind === 'assignment' && screen.id === id) detail = r.data.assignment ? withTime(r.data.assignment) : null;
        draw();
      });
    }

    function refresh() {
      if (stopped || failed === 'gone') return Promise.resolve();
      if (formDirty || (ed && ed.dirty()) || (note && note.text)) return Promise.resolve();
      return load(true);
    }

    // ---------- The list ----------
    function section(key, count, body, extra) {
      return `<section class="plan-sec" data-sec="${key}"><h2 class="sec-head">${esc(w(`sec_${key}`))}`
        + `${count != null ? ` <span class="sec-count">${count}</span>` : ''}${extra || ''}</h2>${body}</section>`;
    }
    function noteForm(step, action, value) {
      const label = action === 'check' ? w('note_good') : action === 'not_yet' ? w('note_missing') : w('your_answer');
      const max = action === 'answer' ? LIMITS.answer : LIMITS.note;
      const submit = action === 'check' ? w('looks_done') : action === 'not_yet' ? w('not_yet_btn') : w('answer_btn');
      return `<form class="plan-note" data-step="${esc(step)}" data-action="${action}" novalidate autocomplete="off">`
        + `<label class="field"><span>${esc(label)}</span><input type="text" name="text" maxlength="${max}" value="${esc(value || '')}" enterkeyhint="send"></label>`
        + `<p class="form-error" hidden></p><div class="form-actions"><button type="button" class="btn" data-act="cancel-note">${esc(t('cancel', null, lang))}</button>`
        + `<button type="submit" class="btn btn-primary">${esc(submit)}</button></div></form>`;
    }
    const isOpen = (step, action) => note && note.step === step && (!action || note.action === action);

    // 0006: an assignment made from school says so, and when the school moved its date or took it off its site.
    function schoolBits(x) {
      const m = x.school && typeof x.school === 'object' ? x.school : null;   // the detail has its marks but no added_by
      if (x.added_by !== 'school' && !m) return [];
      return [w('from_school')].concat(m && m.gone ? [w('school_gone')] : m && m.moved_to ? [w('school_moved', { day: rel(m.moved_to) })] : []);
    }
    function assignmentRow(x) {
      const top = [x.subject, x.title].filter(Boolean).join(' · ');
      const sub = [];
      if (x.kind === 'lesson') sub.push(w('lesson_tag'));
      sub.push(w(x.kind === 'lesson' ? 'do_by' : 'due_on', { day: rel(x.due_date) }));
      if (x.added_by === 'kid') sub.push(w('added_by_kid'));
      sub.push(...schoolBits(x));
      let state;
      if (x.status !== 'open') state = w(x.status === 'done' ? 'st_done' : 'st_dropped');
      else if (x.state === 'none' || !Number(x.steps)) state = `${w('no_plan')} ›`;
      else if (x.state !== 'given') state = w('plan_not_given');
      else {
        state = w('n_of_m', { n: Number(x.steps_done) || 0, m: Number(x.steps) || 0 });
        if (x.next_milestone && x.next_milestone.title) state += ` · ${x.next_milestone.title} ${rel(x.next_milestone.day)}`;
      }
      const showBars = x.status === 'open' && x.state === 'given';
      return `<li class="plan-arow"><a class="plan-arow-link" href="#a/${esc(x.id)}">`
        + `<span class="plan-row-title">${esc(top)}</span><span class="plan-row-sub">${esc(sub.join(' · '))}</span>`
        + `<span class="plan-arow-state">${esc(state)}</span></a>`
        + `${showBars ? bars(x.minutes_left, x.time_left, { lang, horizon: x.horizon, no_time: x.no_time }) : ''}</li>`;
    }

    function listHtml() {
      const v = view;
      const out = [];
      const tutorLabel = v.tutor || '';
      out.push(`<header class="plan-head"><h1>${esc(w('tutor_title'))}</h1>`
        + `<p class="meta">${esc(w('tutor_hi', { label: tutorLabel, day: fmt.short(v.ends_on, lang) }))}</p>`
        + `<p class="plan-coach">${esc(w('tutor_coach'))}</p></header>`);
      const toCheck = v.to_check || [];
      if (toCheck.length) {
        out.push(section('check', toCheck.length, `<ul class="plan-rows">${toCheck.map((x) => `<li class="plan-row" data-step="${esc(x.step_id)}">`
          + `<div class="plan-row-main"><span class="plan-row-title"><span class="plan-diamond">${ICON.diamond}</span>${esc(x.title)}</span>`
          + `<span class="plan-row-sub">${esc([x.assignment, x.done_day ? w('ticked_on', { day: rel(x.done_day) }) : ''].filter(Boolean).join(' · '))}</span>`
          + `${x.done_looks_like ? `<span class="plan-row-sub">${esc(w('dll_line', { text: x.done_looks_like }))}</span>` : ''}</div>`
          + `<div class="plan-row-acts"><button type="button" class="btn btn-sm" data-act="looks-done" data-step="${esc(x.step_id)}" data-title="${esc(x.title)}">${esc(w('looks_done'))}</button>`
          + `<button type="button" class="btn btn-sm" data-act="not-yet" data-step="${esc(x.step_id)}">${esc(w('not_yet_btn'))}</button></div>`
          + `${isOpen(x.step_id, 'check') || isOpen(x.step_id, 'not_yet') ? noteForm(x.step_id, note.action, note.text) : ''}</li>`).join('')}</ul>`));
      }
      const talk = v.to_talk_about || [];
      if (talk.length) {
        out.push(section('talk', talk.length, `<ul class="plan-rows">${talk.map((x) => `<li class="plan-row"><a class="plan-row-link" href="#a/${esc(x.assignment_id)}">`
          + `<span class="plan-row-title">${esc(x.title)}</span>`
          + `<span class="plan-row-sub">${esc(w('talk_line', { title: x.milestone, day: rel(x.planned_day) }))}</span></a></li>`).join('')}</ul>`));
      }
      const questions = v.questions || [];
      if (questions.length) {
        out.push(section('questions', questions.filter((x) => !x.answer).length || null, `<ul class="plan-rows">${questions.map((x) => `<li class="plan-row" data-step="${esc(x.step_id)}">`
          + `<div class="plan-row-main"><span class="plan-row-sub">${esc([x.assignment, x.title].filter(Boolean).join(' · '))}</span>`
          + `<span class="plan-row-q">“${esc(x.question)}”</span>`
          + `${x.answer ? `<span class="plan-row-a">${esc(w('answer_line', { text: x.answer }))}</span>` : ''}</div>`
          + `<div class="plan-row-acts"><button type="button" class="btn btn-sm" data-act="answer" data-step="${esc(x.step_id)}" data-text="${esc(x.answer || '')}">`
          + `${esc(x.answer ? w('change_answer') : w('answer_btn'))}</button></div>`
          + `${isOpen(x.step_id, 'answer') ? noteForm(x.step_id, 'answer', note.text) : ''}</li>`).join('')}</ul>`));
      }
      const plans = v.plans || [];
      if (plans.length) {
        out.push(section('plans', plans.length, `<ul class="plan-rows">${plans.map((x) => `<li class="plan-row"><a class="plan-row-link" href="#a/${esc(x.assignment_id)}">`
          + `<span class="plan-row-title">${esc(x.title)}</span><span class="plan-row-sub">${esc(x.ai_state === 'ready' ? w('ai_draft_ready')
            : x.ai_state === 'running' ? w('ai_thinking_short') : x.state === 'none' ? w('no_plan') : w('plan_not_given'))} ›</span></a></li>`).join('')}</ul>`));
      }
      const all = v.assignments || [];
      const open = all.filter((x) => x.status === 'open');
      const closed = all.filter((x) => x.status !== 'open');
      const adds = `<span class="plan-adds"><a class="btn btn-sm" href="#new/assignment">${esc(w('add_assignment'))}</a><a class="btn btn-sm" href="#new/lesson">${esc(w('add_lesson'))}</a></span>`;
      out.push(section('assignments', null, `${open.length ? `<ul class="plan-arows">${open.map(assignmentRow).join('')}</ul>` : `<p class="empty-line">${esc(w('no_plan'))}</p>`}`
        + `${closed.length ? `<details class="plan-done"><summary>${esc(w('done_30'))}</summary><ul class="plan-arows">${closed.map(assignmentRow).join('')}</ul></details>` : ''}`, adds));
      const days = v.week || [];
      out.push(section('week', null, `${week(days, { today: v.today, lang })}`
        + `${days.length > 7 ? `<details class="plan-more-week"><summary>${esc(w('next_week'))}</summary>${week(days, { today: addDays(v.today, 7), lang })}</details>` : ''}`));
      const record = (v.record || []).filter((d) => (d.sessions || []).length);
      const paceLine = v.pace ? pace(v.pace.ratio, lang) : '';
      if (record.length || paceLine) {
        const lines = [];
        record.forEach((d) => (d.sessions || []).forEach((s) => {
          const result = s.result === 'done' ? w('step_done') : s.result === 'more' ? w('more_to_do') : s.result === 'stopped' ? w('res_stopped')
            : s.result === 'time' ? w('res_time') : w('res_expired');
          const day = rel(d.day);
          const bits = [day.charAt(0).toUpperCase() + day.slice(1), fmt.duration(s.minutes)];
          if (s.with_tutor === true) bits.push(w('with_you'));
          bits.push(result);
          if (s.step) bits.push(s.step);
          lines.push(`<li>${esc(bits.join(' · '))}${s.note ? ` · <q>${esc(s.note)}</q>` : ''}</li>`);
        }));
        out.push(section('record', null, `${lines.length ? `<ul class="plan-record">${lines.join('')}</ul>` : ''}${paceLine ? `<p class="plan-pace">${esc(paceLine)}</p>` : ''}`));
      }
      return `<div class="plan-tutor">${out.join('')}</div>`;
    }

    // ---------- An assignment, and the add form ----------
    function fieldsHtml(x, isNew) {
      const lesson = x.kind === 'lesson';
      const radio = (k) => `<label class="plan-radio"><input type="radio" name="kind" value="${k}"${x.kind === k ? ' checked' : ''}><span>${esc(w(`kind_${k}`))}</span></label>`;
      const status = isNew ? '' : `<label class="field"><span>${esc(w('a_status'))}</span><select name="status">`
        + `${['open', 'done', 'dropped'].map((s) => `<option value="${s}"${x.status === s ? ' selected' : ''}>${esc(w(`st_${s}`))}</option>`).join('')}</select></label>`;
      return `<form class="form plan-afields${lesson ? ' is-lesson' : ''}" data-form="assignment" novalidate autocomplete="off">`
        + `<fieldset class="plan-kinds"><legend>${esc(w('a_kind'))}</legend>${radio('assignment')}${radio('lesson')}</fieldset>`
        + `<label class="field"><span>${esc(w('a_title'))}</span><input type="text" name="title" maxlength="${LIMITS.assignment_title}" value="${esc(x.title || '')}" required></label>`
        + `<div class="field-row"><label class="field"><span>${esc(w('a_subject'))}</span><input type="text" name="subject" maxlength="${LIMITS.subject}" value="${esc(x.subject || '')}"></label>`
        + `<label class="field"><span class="plan-if-assignment">${esc(w('a_due'))}</span><span class="plan-if-lesson">${esc(w('a_do_by'))}</span>`
        + `<input type="date" name="due_date" value="${esc(x.due_date || '')}"${isNew && view ? ` min="${esc(view.today)}"` : ''} required></label></div>`
        + `<label class="field"><span class="plan-if-assignment">${esc(w('a_details'))}</span><span class="plan-if-lesson">${esc(w('a_instructions'))}</span>`
        + `<textarea name="details" maxlength="${LIMITS.details}" rows="6">${esc(x.details || '')}</textarea><small>${esc(w('live_text'))}</small></label>`
        + `<label class="field"><span>${esc(w('a_stretch'))}</span><input type="text" name="stretch" maxlength="${LIMITS.stretch}" value="${esc(x.stretch || '')}"></label>`
        + `${status}<p class="form-error" hidden></p><div class="form-actions"><button type="submit" class="btn btn-primary">${esc(w(isNew ? 'a_add' : 'a_save'))}</button></div></form>`;
    }

    function qaHtml(x) {
      const items = [];
      const who = (by) => (by === 'tutor' ? w('who_you') : by === 'kid' ? w('who_kid') : w('who_family'));
      (x.steps || []).forEach((s) => {
        const lines = [];
        (Array.isArray(s.qa_log) ? s.qa_log : []).forEach((q) => {
          if (q && q.question) lines.push(w('qa_asked', { text: q.question }));
          if (q && q.answer) lines.push(w('qa_by', { who: who(q.by || q.answer_by), text: q.answer }));
        });
        if (s.question) lines.push(w('qa_asked', { text: s.question }));
        if (s.answer) lines.push(w('answer_line', { text: s.answer }));
        if (s.coach && s.coach.text) lines.push(w('qa_by', { who: who(s.coach.by), text: s.coach.text }));
        if (lines.length) items.push(`<li><span class="plan-row-title">${esc(s.title)}</span>${lines.map((l) => `<span class="plan-row-sub">${esc(l)}</span>`).join('')}</li>`);
      });
      return items.length ? section('qa', null, `<ul class="plan-rows plan-qa">${items.join('')}</ul>`) : '';
    }

    function assignmentScreen() {
      const x = detail;
      if (!x) { el.innerHTML = `<div class="plan-tutor"><a class="back" href="#">${esc(w('back'))}</a><p class="empty-line">${esc(friendly({ message: "That assignment isn't on this link." }, lang))}</p></div>`; return; }
      const head = `<a class="back" href="#">${esc(w('back'))}</a><header class="plan-head"><p class="eyebrow">${esc(w('tutor_title'))}</p><h1>${esc(x.title)}</h1>`
        + `<p class="meta">${esc([x.subject, w(x.kind === 'lesson' ? 'do_by' : 'due_on', { day: rel(x.due_date) }), x.added_by === 'kid' ? w('added_by_kid') : '', ...schoolBits(x)].filter(Boolean).join(' · '))}</p></header>`;
      const fresh = edFor !== x.id || !el.querySelector('[data-ref="editor"]');
      if (fresh) {
        if (ed) ed.stop();
        el.innerHTML = `<div class="plan-tutor plan-tutor-a"><div data-ref="head">${head}</div><div data-ref="fields">${fieldsHtml(x, false)}</div>`
          + `<div class="plan-ed" data-ref="editor"></div><div data-ref="qa">${qaHtml(x)}</div></div>`;
        edFor = x.id;
        ed = editor(el.querySelector('[data-ref="editor"]'), {
          role: 'tutor', lang, today: view.today, asOf: view.as_of, serverNow: view.server_now, length: view.length || null,
          kid: view.kid || '', tutor: tutorName(), week: view.week || [], showDetails: false, toast: o.toast, ai: aiFor(x.id),
          friendly: (err) => friendly(err, lang, tutorName()), onGone: gone,
          api: {
            save: ({ steps, rev, give }) => write(() => api.plan(x.id, steps, rev, give), x.id),
            reload: () => write(() => api.view(x.id, 'all'), x.id),
          },
        });
        ed.set(x);
        formDirty = false;
      } else {
        el.querySelector('[data-ref="head"]').innerHTML = head;
        if (!formDirty) el.querySelector('[data-ref="fields"]').innerHTML = fieldsHtml(x, false);
        if (!ed.dirty()) ed.set(x, { lang, today: view.today, asOf: view.as_of, serverNow: view.server_now, week: view.week || [], ai: aiFor(x.id) });
        el.querySelector('[data-ref="qa"]').innerHTML = qaHtml(x);
      }
    }

    // The AI parts on the link (PR B): only while the parents' switch is on and the link may ask (the view's ai), or to
    // show a draft that is there. hub-jobs gets the token in the body (api.ai); the preview is the view's own message
    // (tutor_view_by_token(…, p_assignment)), with the request and his answers as hub-jobs will add them.
    function aiFor(id) {
      const on = !!(view && view.ai && view.ai.on);
      if (!api.ai || (!on && !(detail && detail.id === id && detail.ai))) return null;
      return {
        on,
        sent: o.sent || null,
        // fresh (Send to Claude, Ask again): the view read again first, so what is compared with the screen is what
        // hub-jobs will build now.
        preview: async ({ request, answers, fresh }) => {
          if (fresh) {
            const r = await serial(async () => {
              try { return await api.view(id, 'all'); } catch (err) { return { error: err }; }
            });
            if (answer(r) !== 'ok' || !r.data || !r.data.assignment || r.data.assignment.id !== id) return null;
            if (detail && detail.id === id) detail = Object.assign({}, detail, { preview: r.data.assignment.preview });
          }
          const base = detail && detail.id === id ? detail.preview : null;
          if (typeof base !== 'string') return null;
          const angle = (x) => String(x).replace(/</g, '‹').replace(/>/g, '›');
          const extra = [];
          if (request) extra.push(`<request from="tutor">${angle(request)}</request>`);
          if (answers && answers.length) extra.push(`<answers>\n${answers.map((x) => `- ${angle(x)}`).join('\n')}\n</answers>`);
          return [base].concat(extra).join('\n');
        },
        send: ({ kind, request, answers, key, shown }) => serial(async () => {
          let r;
          try { r = await api.ai({ kind, assignment_id: id, request, answers, key, shown }); } catch (err) { r = { error: err }; }
          if (r && r.data && !r.error) return r.data;
          const err = (r && r.error) || { message: 'Failed to fetch' };
          const stop = await aiFailure(err);
          return stop === 'offline' ? { error: err } : { stop };
        }),
        state: () => serial(async () => {
          let r;
          try { r = await api.view(id, 'ai'); } catch (err) { r = { error: err }; }
          const k = answer(r);
          if (k === 'gone') return { gone: true };
          if (k !== 'ok' || !r.data || !r.data.assignment) return { error: (r && r.error) || { message: 'Failed to fetch' } };
          if (detail && detail.id === id) detail = Object.assign({}, detail, { ai: r.data.assignment.ai, plan_rev: r.data.assignment.plan_rev });
          return { ai: r.data.assignment.ai };
        }),
        draft: (action) => write(() => api.assignment({ id, ai: action }), id).then((r) => (r.assignment ? { ai: r.assignment.ai } : r)),
        stretch: (text) => write(() => api.assignment({ id, stretch: text }), id),
      };
    }

    // A write from the editor, as the editor wants its answer: { assignment } | { error } | { gone }.
    function write(fn, id) {
      return serial(async () => {
        let r;
        try { r = await fn(); } catch (err) { r = { error: err }; }
        const k = answer(r);
        if (k === 'gone') return { gone: true };
        if (k !== 'ok') return { error: (r && r.error) || { message: 'Failed to fetch' } };
        take(r.data);
        let x = r.data.assignment;
        if (!x || x.id !== id) {
          let rr;
          try { rr = await api.view(id, 'all'); } catch (err) { rr = { error: err }; }
          const kk = answer(rr);
          if (kk === 'gone') return { gone: true };
          if (kk !== 'ok' || !rr.data.assignment) return { error: (rr && rr.error) || { message: 'Failed to fetch' } };
          take(rr.data);
          x = rr.data.assignment;
        }
        detail = withTime(x);
        return { assignment: detail };
      });
    }

    function newScreen() {
      const type = screen.type;
      el.innerHTML = `<div class="plan-tutor plan-tutor-a"><a class="back" href="#">${esc(w('back'))}</a>`
        + `<header class="plan-head"><p class="eyebrow">${esc(w('tutor_title'))}</p><h1>${esc(w(type === 'lesson' ? 'new_lesson' : 'new_assignment'))}</h1></header>`
        + `<div data-ref="fields">${fieldsHtml({ kind: type, status: 'open' }, true)}</div></div>`;
    }

    function draw() {
      if (stopped || !view) return;
      if (screen.kind === 'assignment') assignmentScreen();
      else if (screen.kind === 'new') newScreen();
      else el.innerHTML = listHtml();
    }

    // ---------- Writes from the list and the forms ----------
    function stepWrite(step, action, text, title) {
      return serial(async () => {
        let r;
        try { r = await api.step(step, action, text == null || text === '' ? null : text); } catch (err) { r = { error: err }; }
        if (stopped) return false;
        if (!handle(r)) return false;
        const usedUp = r.data && r.data.used_up === true;
        if (!take(r.data)) {
          let rr;
          try { rr = await api.view(null, 'all'); } catch (err) { rr = { error: err }; }
          if (handle(rr, true)) take(rr.data);
        }
        note = null;
        draw();
        if (action === 'check') {
          toast(usedUp ? w('milestones_used_up') : w('checked_toast', { title: title || '' }),
            { action: { label: w('undo'), onClick: () => stepWrite(step, 'uncheck', null) } });
        } else if (action === 'not_yet') toast(w('sent_back'));
        else if (action === 'answer') toast(w('answer_sent'));
        return true;
      });
    }

    function submitNote(form) {
      const step = form.getAttribute('data-step');
      const action = form.getAttribute('data-action');
      const max = action === 'answer' ? LIMITS.answer : LIMITS.note;
      const text = clean(form.elements.text.value, max + 1);
      const err = form.querySelector('.form-error');
      const fail = (m) => { err.textContent = m; err.hidden = false; form.elements.text.focus(); };
      if ((action === 'not_yet' || action === 'answer') && !text) return fail(action === 'not_yet' ? t('say_missing', null, lang) : w('your_answer'));
      if (chars(text) > max) return fail(t('too_long', null, lang));
      const row = (view.to_check || []).find((x) => x.step_id === step);
      stepWrite(step, action, text, row && row.title);
    }

    function submitAssignment(form) {
      const f = form.elements;
      const isNew = screen.kind === 'new';
      const err = form.querySelector('.form-error');
      const fail = (m, field) => { err.textContent = m; err.hidden = false; if (field) field.focus(); };
      const title = clean(f.title.value, LIMITS.assignment_title + 1);
      const subject = clean(f.subject.value, LIMITS.subject + 1);
      const details = cleanBlock(f.details.value, LIMITS.details + 1);
      const stretch = clean(f.stretch.value, LIMITS.stretch + 1);
      const due = String(f.due_date.value || '');
      if (!title) return fail(w('need_title'), f.title);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return fail(w('need_due'), f.due_date);
      if (chars(title) > LIMITS.assignment_title || chars(subject) > LIMITS.subject || chars(details) > LIMITS.details || chars(stretch) > LIMITS.stretch) {
        return fail(t('too_long', null, lang));
      }
      const id = isNew ? newId() : detail.id;
      const fields = { id, kind: f.kind.value === 'lesson' ? 'lesson' : 'assignment', title, subject: subject || null, due_date: due,
        details: details || null, stretch: stretch || null };
      if (!isNew) fields.status = f.status.value;
      form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      serial(async () => {
        let r;
        try { r = await api.assignment(fields); } catch (e) { r = { error: e }; }
        if (stopped) return;
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        const k = answer(r);
        if (k === 'gone') { gone(); return; }
        if (k !== 'ok') { fail(k === 'retry' ? t('offline', null, lang) : friendly(r.error, lang, tutorName())); return; }
        take(r.data);
        formDirty = false;
        if (isNew) { go(`#a/${id}`); return; }
        if (r.data.assignment && r.data.assignment.id === id) detail = withTime(r.data.assignment);
        else detail = withTime(Object.assign({}, detail, fields));
        toast(t('saved', null, lang));
        assignmentScreen();
      });
      return undefined;
    }

    function onClick(e) {
      const btn = e.target.closest('button');
      if (!btn || !el.contains(btn) || btn.disabled) return;
      if (btn.closest('[data-ref="editor"]')) return;
      const step = btn.getAttribute('data-step');
      switch (btn.dataset.act) {
        case 'retry':
          show(screen.kind === 'assignment' ? `#a/${screen.id}` : '');
          break;
        case 'looks-done':
        case 'not-yet':
        case 'answer':
          note = { step, action: btn.dataset.act === 'looks-done' ? 'check' : btn.dataset.act === 'not-yet' ? 'not_yet' : 'answer', text: btn.getAttribute('data-text') || '' };
          draw();
          { const input = el.querySelector('.plan-note input[name="text"]'); if (input) input.focus(); }
          break;
        case 'cancel-note':
          note = null;
          draw();
          break;
        default:
      }
    }
    function onSubmit(e) {
      const form = e.target;
      if (!el.contains(form) || form.closest('[data-ref="editor"]')) return;
      e.preventDefault();
      if (form.classList.contains('plan-note')) submitNote(form);
      else if (form.dataset.form === 'assignment') submitAssignment(form);
    }
    function onInput(e) {
      const x = e.target;
      if (x.closest('[data-ref="editor"]')) return;
      if (x.closest('.plan-note') && note) note.text = x.value;
      if (x.closest('.plan-afields')) {
        formDirty = true;
        if (x.name === 'kind') x.closest('.plan-afields').classList.toggle('is-lesson', x.value === 'lesson');
      }
    }

    el.addEventListener('click', onClick);
    el.addEventListener('submit', onSubmit);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onInput);

    return Object.freeze({
      show,
      refresh,
      stop() {
        stopped = true;
        if (ed) ed.stop();
        el.removeEventListener('click', onClick);
        el.removeEventListener('submit', onSubmit);
        el.removeEventListener('input', onInput);
        el.removeEventListener('change', onInput);
      },
    });
  }

  window.HomePlan = Object.freeze({
    LENGTHS, KINDS, PLAIN, HORIZON, LIMITS, STARTERS, WORDS,
    t, esc, clean, cleanBlock, friendly, answer, newId, hashText, previewMark, previewSeal, aiFailure,
    addDays, daysBetween, weekday, isoWeekday, fmt: Object.freeze(fmt),
    ended, firstDay, lastWorkDay, horizon, homeworkDays, place, timeLeft, workLeft, spare,
    guess, starter, check,
    bars, week, pace, focused, ring, overview, chart, path,
    ms, timer, left, audioAt, pointsLine, onTimeLine, estimate, goalBar,
    fromRows, editor, tutor,
  });
})();
