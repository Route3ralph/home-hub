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
                                and the texts': question 200, answer 200, note 160, assignment_title 120,
                                subject 40, details 4000, stretch 160
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
                                o.week), each with its day, the last a milestone.
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

   THE TIMER (§7.2): never the device's clock
     ms(ts)                     a database timestamp ('…Z', '…+00:00', microseconds) → epoch ms, NaN otherwise
     timer(x, perf)             { endLocal, totalMs }, endLocal = perf + (ends_at − server_now), on the
                                performance.now() clock. x: { ends_at, server_now, started_at?, minutes? }
                                (his view's session and server_now) or { ends_in_s, minutes } (the card).
                                perf: performance.now() when the answer came.
     left(tm, perf)             { ms, seconds, minutes (rounded up), fraction (of the ring), done }
     audioAt(tm, perf, now)     the AudioContext time to start the chime at, given its currentTime now
     pointsLine(end, lang)      the end screen's line from what the server saw, end: { seen, focus, on_time,
                                capped }: '+2 · 12 minutes', '+4 · 20 minutes · +5 on time', 'Under 5 minutes:
                                no points this time.', "Today's limit reached."
     onTimeLine(onTime, lang)   'start by 4:40pm for +5' from his view's on_time ({ until, done, points? })

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
         showDetails (false: no "Teacher's text" fold)
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
             step(stepId, action, text) }: each the supabase-js answer ({ data, error, status }) of
             tutor_view_by_token(p_token, p_assignment, p_part), tutor_assignment_by_token(p_token,
             p_fields), tutor_plan_by_token(p_token, p_assignment, p_steps, p_rev, p_give) and
             tutor_step_by_token(p_token, p_step, p_action, p_text);
             lang (until the link's language is known), toast, onGone(), go(hash) (default: location.hash)
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
    question: 200, answer: 200, note: 160, assignment_title: 120, subject: 40, details: 4000, stretch: 160,
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
      on_time: 'On time · +{n} once 8 minutes are done', start_by: 'start by {time} for +{n}',
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
      not_yet: 'Not yet: {note}', coach_note: '{who}: {note}',
      milestone_lock: 'Milestones are checkpoints you set with {tutor}. Change them together.',
      milestone_lock_none: 'Milestones are checkpoints you set with your parents. Change them together.',
      under_five: 'Under 5 minutes: no points this time.', limit_reached: "Today's limit reached.",
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
    },
    es: {
      homework: 'Tarea', now: 'Ahora', tonight: 'Esta tarde', due_soon: 'Para pronto', start_n: 'Empezar · {n} min',
      on_time: 'A tiempo · +{n} cuando lleves 8 minutos', start_by: 'empieza antes de las {time} para +{n}',
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
      not_yet: 'Todavía no: {note}', coach_note: '{who}: {note}',
      milestone_lock: 'Los hitos son puntos de control que fijaste con {tutor}. Cámbienlos juntos.',
      milestone_lock_none: 'Los hitos son puntos de control que fijaste con tus padres. Cámbienlos juntos.',
      under_five: 'Menos de 5 minutos: esta vez sin puntos.', limit_reached: 'Llegaste al límite de hoy.',
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
      tutor_title: 'Tarea · {kid}', tutor_hi: 'Hola, {label} · El enlace vence el {day}',
      tutor_coach: 'Empieza por lo que hizo. Pregunta qué sigue y cuándo lo empezará.',
      sec_check: 'Por revisar', sec_talk: 'Para hablar', sec_questions: 'Preguntas', sec_plans: 'Planes por mirar',
      sec_assignments: 'Trabajos', sec_week: 'Su semana', sec_record: 'Últimos 14 días', sec_qa: 'Preguntas y notas',
      looks_done: 'Se ve terminado', not_yet_btn: 'Todavía no', note_good: 'Di qué tiene de bueno (opcional)', note_missing: 'Di qué falta',
      your_answer: 'Tu respuesta', answer_btn: 'Responder', change_answer: 'Cambiar', answer_line: 'Respuesta: {text}',
      ticked_on: 'marcado {day}', talk_line: '"{title}" estaba planeado para {day} · Pregunta qué se lo impidió y elijan juntos otro día.',
      plan_not_given: 'Plan todavía sin dar', add_assignment: '+ Trabajo', add_lesson: '+ Lección', n_of_m: '{n} de {m}',
      added_by_kid: 'añadido por {kid}', lesson_tag: 'lección', with_you: 'contigo', next_week: 'Los 7 días siguientes',
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
        const hi = x.due > horizon(x.today) ? horizon(x.today) : x.due;
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
    if (seen < 5) return t('under_five', null, lang);
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
    return t('start_by', { time: fmt.time(x.until, lang), n: x.points != null ? x.points : 5 }, lang);
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
    const payload = (placeAgain) => steps.map((s) => {
      const x = { kind: s.kind, title: clean(s.title, LIMITS.title[1]), done_looks_like: clean(s.done_looks_like, LIMITS.dll) || null, minutes: s.minutes,
        day: placeAgain && !s.done ? null : s.day || null, source: changed(s) ? 'typed' : s.source };
      return s.id ? Object.assign({ id: s.id }, x) : x;
    });
    const say = (err) => (o.friendly ? o.friendly(err) : friendly(err, L(), o.tutor || null));

    function set(next, more) {
      if (more) Object.assign(o, more);
      a = next || null;
      steps = ((a && a.steps) || []).map((s) => copy(s));
      dirty = false;
      open = -1;
      picking = false;
      msg = null;
      draw();
    }

    // ---------- Drawing ----------
    function dayOptions(s) {
      const l = L();
      const today = o.today;
      const due = a.due_date;
      const max = s.kind === 'turn_in' ? due : addDays(due, -1);
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
      return `<li class="${cls}" data-i="${i}"${s.id ? ` data-id="${esc(s.id)}"` : ''}>`
        + `<span class="plan-box${s.done ? ' is-done' : ''}" aria-hidden="true">${mark}</span>`
        + `<div class="plan-step-main"><span class="plan-step-title">${esc(title)}</span>`
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
      const tools = isKid()
        ? `<div class="plan-tools"><button type="button" class="btn" data-act="add"${dis}>${esc(w('add_step'))}</button>`
          + `<button type="button" class="btn" data-act="replan"${busy || dirty ? ' disabled' : ''}${dirty ? ` title="${esc(w('save_first'))}"` : ''}>${esc(w('replan'))}</button></div>`
        : `<div class="plan-tools"><button type="button" class="btn" data-act="starter" aria-expanded="${picking}"${dis}>${esc(w('starter_btn'))}</button>`
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
      return `<div class="plan-editor" data-role="${esc(o.role)}"${busy ? ' aria-busy="true"' : ''}>${head}${text}${tools}${picker}${list}${lock}${fitHtml()}${note}${acts}</div>`;
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
        set(r.assignment);
        if (done && o.toast) o.toast(done);
        if (o.onSaved) o.onSaved(r.assignment);
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
      const fresh = starter(key, { lang: L(), length: o.length, parts, today: o.today, due: a.due_date, asOf: o.asOf, week: o.week });
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

    // ---------- Taps and typing ----------
    function onClick(e) {
      const btn = e.target.closest('button');
      if (!btn || !el.contains(btn) || btn.disabled || !a) return;
      const i = btn.hasAttribute('data-i') ? Number(btn.getAttribute('data-i')) : -1;
      if (btn.dataset.starter) { applyStarter(btn.dataset.starter); return; }
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
    if (o.assignment) set(o.assignment);

    return Object.freeze({
      set,
      get: () => a,
      dirty: () => dirty,
      stop() {
        stopped = true;
        el.removeEventListener('click', onClick);
        el.removeEventListener('input', onInput);
        el.removeEventListener('change', onChange);
        el.removeEventListener('keydown', onKey);
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

    function assignmentRow(x) {
      const top = [x.subject, x.title].filter(Boolean).join(' · ');
      const sub = [];
      if (x.kind === 'lesson') sub.push(w('lesson_tag'));
      sub.push(w(x.kind === 'lesson' ? 'do_by' : 'due_on', { day: rel(x.due_date) }));
      if (x.added_by === 'kid') sub.push(w('added_by_kid'));
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
          + `<span class="plan-row-title">${esc(x.title)}</span><span class="plan-row-sub">${esc(x.state === 'none' ? w('no_plan') : w('plan_not_given'))} ›</span></a></li>`).join('')}</ul>`));
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
          const result = s.result === 'done' ? w('step_done') : s.result === 'more' ? w('more_to_do') : s.result === 'stopped' ? w('res_stopped') : w('res_expired');
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
        + `<p class="meta">${esc([x.subject, w(x.kind === 'lesson' ? 'do_by' : 'due_on', { day: rel(x.due_date) }), x.added_by === 'kid' ? w('added_by_kid') : ''].filter(Boolean).join(' · '))}</p></header>`;
      const fresh = edFor !== x.id || !el.querySelector('[data-ref="editor"]');
      if (fresh) {
        if (ed) ed.stop();
        el.innerHTML = `<div class="plan-tutor plan-tutor-a"><div data-ref="head">${head}</div><div data-ref="fields">${fieldsHtml(x, false)}</div>`
          + `<div class="plan-ed" data-ref="editor"></div><div data-ref="qa">${qaHtml(x)}</div></div>`;
        edFor = x.id;
        ed = editor(el.querySelector('[data-ref="editor"]'), {
          role: 'tutor', lang, today: view.today, asOf: view.as_of, serverNow: view.server_now, length: view.length || null,
          kid: view.kid || '', tutor: tutorName(), week: view.week || [], showDetails: false, toast: o.toast,
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
        if (!ed.dirty()) ed.set(x, { lang, today: view.today, asOf: view.as_of, serverNow: view.server_now, week: view.week || [] });
        el.querySelector('[data-ref="qa"]').innerHTML = qaHtml(x);
      }
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
    t, esc, clean, cleanBlock, friendly, answer, newId,
    addDays, daysBetween, weekday, isoWeekday, fmt: Object.freeze(fmt),
    ended, firstDay, lastWorkDay, horizon, homeworkDays, place, timeLeft, workLeft, spare,
    guess, starter, check,
    bars, week, pace, focused, ring,
    ms, timer, left, audioAt, pointsLine, onTimeLine,
    fromRows, editor, tutor,
  });
})();
