-- Who can see and change what: seeding, whoami, the catalog-wide rules, and the
-- role matrix (anon; signed-in stranger; removed member with a parent row; adult; admin;
-- service_role) for every new table and every new function (migrations 0002 to 0005),
-- and the table and column privileges of 0003's, 0004's and 0005's tables.
\ir roles.sql
\ir fixtures.sql

-- ---------------------------------------------------------------------
-- The migration's starting data
-- ---------------------------------------------------------------------
:as_owner
select test.is((select string_agg(name || ':' || role || ':' || color || ':' || sort_order, ' ' order by sort_order)
                from people where email in ('alex@example.com', 'sam@example.com')),
               'Alex:parent:#9333ea:0 Sam:adult:#2563eb:1', 'members became people (admin → parent, member → adult), with colours in order');
select test.is((select email_verified_at from people where name = 'Alex'), null, 'seeded people start with an unconfirmed email');
select test.is((select count(*) from people_confirm c join people p on p.id = c.person_id where p.name in ('Alex', 'Sam')), 2::bigint,
               '... and each has a confirmation secret');
select test.is((select count(*) || ' ' || tz || ' ' || digest_time from household group by tz, digest_time),
               '1 America/New_York 06:30:00', 'one household row with the defaults');
select test.throws($$insert into household (id) values (false)$$, 'violates check constraint', 'household has only one row');

-- ---------------------------------------------------------------------
-- whoami and the schema version
-- ---------------------------------------------------------------------
:as_admin
select test.is(whoami() - 'created_at' - 'person', '{"email": "alex@example.com", "name": "Alex", "role": "admin"}'::jsonb,
               'whoami keeps its v1 keys');
select test.is((whoami() -> 'person') - 'id', '{"name": "Alex", "role": "parent", "language": "en", "color": "#9333ea"}'::jsonb,
               'whoami adds the caller''s person');
select test.is((whoami() -> 'person' ->> 'id')::uuid, test.person('Alex'), 'whoami person id');
-- Migration 0003 (Google Calendar) changed the version on purpose: the v1.1 client shows its
-- Google card, and asks for Google events, only on 3. Migration 0004 (Food) changes it on purpose
-- again: the v1.2 client shows Food, and asks for meals and the shopping list, only on 4. Migration
-- 0005 (Homework) changes it on purpose once more: the v1.3 client shows Homework, and asks for
-- anything of it (Today's lines, Jordan's card, the tutor link), only on 5. Migration 0006 (the school
-- feed) changes it on purpose again: the client shows the school links and New from school only on 6.
select test.is(hub_schema_version(), 6, 'hub_schema_version is 6');
:as_removed
select test.is(whoami(), null, 'removed member: whoami is null even with a person row');
:as_stranger
select test.is(whoami(), null, 'stranger: whoami is null');
:as_owner
insert into members (email, name, role) values ('casey@example.com', 'Casey', 'member');
:as_stranger
select test.is(whoami() -> 'person', 'null'::jsonb, 'a member without a person row gets person null');
:as_owner
delete from members where email = 'casey@example.com';

-- ---------------------------------------------------------------------
-- Catalog-wide rules
-- ---------------------------------------------------------------------
:as_owner
select test.is((select string_agg(c.relname, ', ') from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity),
               null, 'every public table has row-level security');
-- Tables in private (0004's food_pairs and list_done, 0006's school_feed_urls and school_sync) are read only by definer functions: row-level security on,
-- no policies, and no privilege at all for anon, signed-in users or service_role.
select test.is((select string_agg(c.relname, ', ' order by c.relname) from pg_class c
                where c.relnamespace = 'private'::regnamespace and c.relkind in ('r', 'p')
                  and (not c.relrowsecurity
                       or exists (select 1 from pg_policy y where y.polrelid = c.oid)
                       or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
                                  where has_table_privilege(r, c.oid, 'select, insert, update, delete, truncate, references, trigger')
                                     or has_any_column_privilege(r, c.oid, 'select, insert, update, references')))),
               null, 'every private table has row-level security, no policies and no privilege for anon, authenticated or service_role');
select test.is((select string_agg(c.relname, ', ' order by c.relname) from pg_class c
                where c.relnamespace = 'private'::regnamespace and c.relkind in ('r', 'p')),
               'food_pairs, list_done, school_feed_urls, school_sync', '... (the private tables: food_pairs, list_done, school_feed_urls, school_sync)');
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')),
               'add_to_list_by_token, assignment_by_token, buy_item_by_token, complete_by_token, confirm_digest, focus_by_token, '
               'get_list_by_token, get_person_day, get_shared_project, homework_by_token, homework_prefs_by_token, plan_by_token, '
               'reward_by_token, school_item_by_token, step_by_token, stop_digest, tutor_assignment_by_token, tutor_plan_by_token, tutor_step_by_token, '
               'tutor_view_by_token, undo_by_token',
               'anon can execute only get_shared_project and the twenty token functions (0004 adds the three for the list, 0005 '
               'Jordan''s seven and the tutor link''s four, 0006 his New from school)');
select test.is(has_schema_privilege('anon', 'private', 'usage'), false, 'anon cannot use the private schema');
select test.is((select string_agg(n.nspname || '.' || p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'private') and not coalesce(p.proconfig, '{}') @> '{"search_path=\"\""}'),
               null, 'every function sets search_path = ''''');
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prosecdef),
               'add_to_list, add_to_list_by_token, assignment_by_token, buy_item, buy_item_by_token, check_school_feed, complete_by_token, complete_task, '
               'confirm_digest, decide_reward, erase_homework, focus_by_token, get_list_by_token, get_person_day, get_shared_project, '
               'give_points, homework_ai_draft, homework_ai_finish, homework_ai_preview, homework_ai_start, homework_by_token, homework_prefs_by_token, '
               'homework_step, hook_family_only_signup, mark_signed_in, new_tutor_token, pause_school_feed, plan_by_token, remove_person, reward_by_token, '
               'rotate_day_token, save_homework_kid, save_homework_plan, save_person, save_tutor_link, school_begin, school_feed_status, '
               'school_finish, school_item_action, school_item_by_token, school_store, set_school_feed, skip_task, step_by_token, '
               'stop_digest, tutor_assignment_by_token, tutor_plan_by_token, tutor_step_by_token, tutor_view_by_token, undo_by_token, '
               'undo_task, void_points',
               'the only definer functions in public are the RPCs that check membership, admin, a token or the service key '
               '(0005: the parents'' homework actions, the eleven token functions and hub-jobs'' two AI functions; add_homework_time '
               'and homework_week run as the caller; 0006: the parents'' school links, the status card, his New from school and hub-jobs'' '
               'three school functions)');
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.pronamespace = 'private'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')
                  and p.proname in ('complete_task', 'undo_task', 'roll_task', 'person_by_token', 'my_day_item', 'digest_item', 'people_confirm_sync',
                                    'count_my_day', 'food_words', 'guess_aisle', 'list_add', 'list_buy', 'list_for_helper',
                                    'list_claim', 'list_add_once', 'list_buy_once',
                                    -- 0005: every homework helper but free_minutes, clean_block, homework_word and the triggers
                                    'homework_kid_by_token', 'tutor_link_by_token', 'count_homework', 'place_steps', 'plan_check',
                                    'plan_save', 'step_act', 'award', 'points_balance', 'homework_pace', 'focus_act', 'ai_sweep',
                                    'ai_draft_act', 'homework_trim', 'homework_view_kid', 'homework_card', 'homework_view_tutor', 'scrub', 'ai_input',
                                    -- 0006: every school helper, and 0005's renamed view and card bodies
                                    'school_host_suffix', 'school_url', 'safe_instant', 'school_rows', 'school_assignment', 'school_apply',
                                    'school_marks', 'school_new', 'school_failed', 'school_trim', 'school_feeds_due',
                                    'homework_view_kid_v5', 'homework_view_tutor_v5', 'homework_card_v5')),
               null, 'members cannot call the private helpers that act for someone else');
-- What 0005 grants members in private: free_minutes (homework_week runs as the member), and clean_block
-- and homework_word (the tidy triggers and add_homework_time run as the parent who saves).
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.pronamespace = 'private'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')
                  and p.proname in ('free_minutes', 'clean_block', 'homework_word', 'homework_kid_by_token', 'tutor_link_by_token',
                                    'count_homework', 'place_steps', 'plan_check', 'plan_save', 'step_act', 'award', 'points_balance',
                                    'homework_pace', 'focus_act', 'ai_sweep', 'ai_draft_act', 'homework_trim', 'homework_view_kid', 'homework_card',
                                    'homework_view_tutor', 'scrub', 'ai_input')),
               'clean_block, free_minutes, homework_word', '0005''s private functions members may call: free_minutes, clean_block, homework_word');
select test.is((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
                where p.pronamespace = 'private'::regnamespace and has_function_privilege('anon', p.oid, 'execute')),
               null, 'anon can call nothing in private');
select test.is((select string_agg(r, ', ' order by r) from unnest(array['anon', 'authenticated', 'service_role']) r
                where has_table_privilege(r, 'public.people_confirm', 'insert, update, delete, truncate, references, trigger')),
               null, 'nobody but the owner can write confirmation secrets');

-- Migration 0003's tables: Supabase's default privileges would give anon and authenticated everything
-- (truncate ignores row-level security). Anon gets nothing; signed-in users read, and on calendars
-- admins (by the policies) write the setting columns only.
select test.is((select string_agg(t, ', ' order by t) from unnest(array['calendars', 'calendar_links', 'google_events', 'calendar_sync']) t
                where has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete, truncate, references, trigger')
                   or has_any_column_privilege('anon', 'public.' || t, 'select, insert, update, references')),
               null, 'anon has no privilege on calendars, calendar_links, google_events or calendar_sync');
select test.is((select string_agg(t, ', ' order by t) from unnest(array['calendars', 'calendar_links', 'google_events', 'calendar_sync']) t
                where has_table_privilege('authenticated', 'public.' || t, 'truncate, references, trigger')),
               null, 'signed-in users cannot truncate, reference or put triggers on the calendar tables');
select test.is((select string_agg(t, ', ' order by t) from unnest(array['calendar_links', 'google_events', 'calendar_sync']) t
                where has_table_privilege('authenticated', 'public.' || t, 'insert, update, delete')
                   or has_any_column_privilege('authenticated', 'public.' || t, 'insert, update')),
               null, 'signed-in users cannot write calendar_links, google_events or calendar_sync (only hub-jobs does)');
select test.is((select string_agg(t, ', ' order by t) from unnest(array['calendars', 'calendar_links', 'google_events', 'calendar_sync']) t
                where has_table_privilege('authenticated', 'public.' || t, 'select')),
               'calendar_links, calendar_sync, calendars, google_events', 'signed-in users may select the calendar tables (row-level security decides)');
select test.is(has_table_privilege('authenticated', 'public.calendars', 'insert') or has_table_privilege('authenticated', 'public.calendars', 'update'),
               false, 'calendars: no table-wide insert or update for signed-in users');
select test.is(has_table_privilege('authenticated', 'public.calendars', 'delete'), true, 'calendars: signed-in users may delete (Disconnect; admins only, by policy)');
select test.is((select string_agg(a.attname, ', ' order by a.attname) from pg_attribute a
                where a.attrelid = 'public.calendars'::regclass and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege('authenticated', 'public.calendars', a.attname, 'insert')),
               'for_kids, google_id, kind, label, person_id, writes', 'calendars: the columns signed-in users may insert');
select test.is((select string_agg(a.attname, ', ' order by a.attname) from pg_attribute a
                where a.attrelid = 'public.calendars'::regclass and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege('authenticated', 'public.calendars', a.attname, 'update')),
               'copy_approved_at, for_kids, google_id, kind, label, person_id, writes', 'calendars: the columns signed-in users may update');
select test.is((select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.proname like 'calendar\_%'
                  and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
               'calendar_preview(uuid)', 'of the calendar_* functions, signed-in users may call only calendar_preview (the rest are hub-jobs'')');

-- Migration 0004's tables: anon gets nothing; members read meals and the list (row-level security
-- decides), write a meal's own columns, and on the list change only name, note, aisle and the lock
-- (adds, buys and puts back go through the functions, so added_* and bought_* are never written
-- directly). my_day_use is its owner's alone: only private.count_my_day writes it.
select test.is((select string_agg(t, ', ' order by t) from unnest(array['meals', 'shopping_items', 'my_day_use']) t
                where has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete, truncate, references, trigger')
                   or has_any_column_privilege('anon', 'public.' || t, 'select, insert, update, references')),
               null, 'anon has no privilege on meals, shopping_items or my_day_use');
select test.is((select string_agg(t, ', ' order by t) from unnest(array['meals', 'shopping_items', 'my_day_use']) t
                where has_table_privilege('authenticated', 'public.' || t, 'truncate, references, trigger')),
               null, 'signed-in users cannot truncate, reference or put triggers on meals, shopping_items or my_day_use');
select test.is((select string_agg(r, ', ' order by r) from unnest(array['anon', 'authenticated', 'service_role']) r
                where has_table_privilege(r, 'public.my_day_use', 'select, insert, update, delete, truncate, references, trigger')
                   or has_any_column_privilege(r, 'public.my_day_use', 'select, insert, update, references')),
               null, 'my_day_use: no privilege for anyone but its owner');
select test.is((select string_agg(t || ' ' || x, ', ' order by t, x) from unnest(array['meals', 'shopping_items']) t
                cross join unnest(array['select', 'insert', 'update', 'delete']) x
                where has_table_privilege('authenticated', 'public.' || t, x)),
               'meals delete, meals select, shopping_items delete, shopping_items select',
               'meals and shopping_items: signed-in users may select and delete (row-level security decides), no table-wide insert or update');
select test.is((select string_agg(a.attname, ', ' order by a.attname) from pg_attribute a
                where a.attrelid = 'public.meals'::regclass and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege('authenticated', 'public.meals', a.attname, 'insert')),
               'cook_id, day, kind, link, note, private, slot, title', 'meals: the columns signed-in users may insert');
select test.is((select string_agg(a.attname, ', ' order by a.attname) from pg_attribute a
                where a.attrelid = 'public.meals'::regclass and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege('authenticated', 'public.meals', a.attname, 'update')),
               'cook_id, day, kind, link, note, private, slot, title', 'meals: the columns signed-in users may update (the page upserts on day and slot)');
select test.is(has_any_column_privilege('authenticated', 'public.shopping_items', 'insert'), false,
               'shopping_items: signed-in users cannot insert (add_to_list does)');
select test.is((select string_agg(a.attname, ', ' order by a.attname) from pg_attribute a
                where a.attrelid = 'public.shopping_items'::regclass and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege('authenticated', 'public.shopping_items', a.attname, 'update')),
               'aisle, name, note, private', 'shopping_items: the columns signed-in users may update (never added_* or bought_*)');
select test.is((select string_agg(t, ', ' order by t) from unnest(array['meals', 'shopping_items']) t
                where not has_table_privilege('service_role', 'public.' || t, 'select, insert, update, delete')),
               null, 'service_role keeps its privileges on meals and shopping_items (the email and the calendar job read them)');

-- Migration 0005's tables: anon gets nothing; members read (row-level security decides: tutor_links and
-- ai_runs are the parents' only); the parents write only the columns the Homework page sets (never
-- given_*, plan_rev, done_at, cue, added_by, the AI's columns or the audit columns), and steps, blocks,
-- asks, points and AI runs have no write grant at all (their functions write). homework_use is its
-- owner's alone: only private.count_homework writes it.
select test.is((select string_agg(t, ', ' order by t)
                from unnest(array['homework_kids', 'homework_times', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions',
                                  'rewards', 'reward_asks', 'points_ledger', 'homework_use', 'ai_runs']) t
                where has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete, truncate, references, trigger')
                   or has_any_column_privilege('anon', 'public.' || t, 'select, insert, update, references')),
               null, 'anon has no privilege on any of 0005''s eleven tables');
select test.is((select string_agg(t, ', ' order by t)
                from unnest(array['homework_kids', 'homework_times', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions',
                                  'rewards', 'reward_asks', 'points_ledger', 'homework_use', 'ai_runs']) t
                where has_table_privilege('authenticated', 'public.' || t, 'truncate, references, trigger')),
               null, 'signed-in users cannot truncate, reference or put triggers on 0005''s tables');
select test.is((select string_agg(r, ', ' order by r) from unnest(array['anon', 'authenticated', 'service_role']) r
                where has_table_privilege(r, 'public.homework_use', 'select, insert, update, delete, truncate, references, trigger')
                   or has_any_column_privilege(r, 'public.homework_use', 'select, insert, update, references')),
               null, 'homework_use: no privilege for anyone but its owner');
select test.is((select string_agg(t || ' ' || x, ', ' order by t, x)
                from unnest(array['homework_kids', 'homework_times', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions',
                                  'rewards', 'reward_asks', 'points_ledger', 'ai_runs']) t
                cross join unnest(array['select', 'insert', 'update', 'delete']) x
                where has_table_privilege('authenticated', 'public.' || t, x)),
               'ai_runs select, assignments delete, assignments select, focus_sessions select, homework_kids select, homework_steps select, '
               'homework_times delete, homework_times select, points_ledger select, reward_asks select, rewards delete, rewards select, '
               'tutor_links select',
               '0005''s tables: signed-in users select (row-level security decides), and delete homework time, assignments and rewards; no table-wide insert or update');
select test.is((select string_agg(c.relname || '.' || a.attname, ', ' order by c.relname, a.attname)
                from pg_class c join pg_attribute a on a.attrelid = c.oid
                where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
                  and c.relname in ('homework_kids', 'homework_times', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions',
                                    'rewards', 'reward_asks', 'points_ledger', 'ai_runs')
                  and has_column_privilege('authenticated', c.oid, a.attname, 'insert')),
               'assignments.details, assignments.due_date, assignments.kid_id, assignments.kind, assignments.status, assignments.stretch, '
               'assignments.subject, assignments.title, homework_times.event_id, homework_times.kid_id, rewards.active, rewards.cost, '
               'rewards.instant, rewards.kid_id, rewards.sort_order, rewards.title',
               '0005''s tables: the columns signed-in users may insert (assignments without added_by, given_* or the AI''s; homework_times; rewards)');
select test.is((select string_agg(c.relname || '.' || a.attname, ', ' order by c.relname, a.attname)
                from pg_class c join pg_attribute a on a.attrelid = c.oid
                where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
                  and c.relname in ('homework_kids', 'homework_times', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions',
                                    'rewards', 'reward_asks', 'points_ledger', 'ai_runs')
                  and has_column_privilege('authenticated', c.oid, a.attname, 'update')),
               'assignments.details, assignments.due_date, assignments.kind, assignments.status, assignments.stretch, assignments.subject, '
               'assignments.title, homework_kids.active, homework_kids.focus_minutes, homework_kids.instant_day, homework_kids.points_on, '
               'homework_kids.pts_day_cap, homework_kids.pts_focus, homework_kids.pts_milestone, homework_kids.pts_milestone_week, '
               'homework_kids.pts_on_time, rewards.active, rewards.cost, rewards.instant, rewards.sort_order, rewards.title',
               '0005''s tables: the columns signed-in users may update (never cue, if_stuck, given_*, plan_rev, done_at or added_by)');
select test.is((select string_agg(t, ', ' order by t)
                from unnest(array['homework_kids', 'homework_times', 'tutor_links', 'assignments', 'homework_steps', 'focus_sessions',
                                  'rewards', 'reward_asks', 'points_ledger', 'ai_runs']) t
                where not has_table_privilege('service_role', 'public.' || t, 'select, insert, update, delete')),
               null, 'service_role keeps its privileges on the rest of 0005''s tables');
select test.is((select string_agg(a.attname, ', ' order by a.attname) from pg_attribute a
                where a.attrelid = 'public.household'::regclass and a.attname like 'homework%'
                  and has_column_privilege('authenticated', 'public.household', a.attname, 'update')),
               'homework_ai, homework_ai_month, homework_never_send',
               'household: the three new columns follow its grants (row-level security: admins update)');

-- ---------------------------------------------------------------------
-- Tables: what each role can do (rows seen or changed, or denied)
-- ---------------------------------------------------------------------
:as_owner
insert into events (title, start_date, start_time, repeat, repeat_weekdays, responsible_id, participant_ids)
values ('Piano', '2026-11-02', '16:00', 'weekly', '{1}', test.person('Morgan'), array[test.person('Taylor')]);
insert into event_changes (event_id, on_date, cancelled) values (test.event('Piano'), '2026-11-09', true);
insert into tasks (title, responsible_id, due_date, repeat_mode, every_count, every_unit)
values ('Trash', test.person('Taylor'), '2026-11-02', 'schedule', 1, 'week');
insert into tasks (title, due_date) values ('Call plumber', '2026-11-03');
insert into task_log (task_id, occurrence, status, done_on, prev_due) values (test.task('Trash'), '2026-10-26', 'done', '2026-10-26', '2026-10-26');
insert into notification_log (person_id, local_date, kind, status) values (test.person('Alex'), '2026-11-02', 'digest', 'sent');
insert into job_runs (action, ok, sent) values ('digest', true, 1);
insert into calendars (google_id, kind, person_id, label, status, access_role, copy_approved_at)
values ('hub-taylor@group.calendar.google.com', 'person', test.person('Taylor'), 'Taylor', 'ok', 'writer', '2026-10-27');
insert into calendar_links (google_calendar, base_id, event_id, calendar_id, item_kind, day, end_day)
values ('hub-taylor@group.calendar.google.com', 'hh' || repeat('0', 32), 'hh' || repeat('0', 32), (select id from calendars),
        'event', '2026-11-02', '2026-11-02');
insert into google_events (calendar_id, google_calendar, event_id, title, all_day, start_day, end_day, read_at)
values ((select id from calendars), 'hub-taylor@group.calendar.google.com', 'g1', 'Dentist', true, '2026-11-02', '2026-11-02', now());
insert into meals (day, kind, title, cook_id) values ('2026-11-02', 'cook', 'Tacos', test.person('Morgan'));
insert into shopping_items (name, added_by) values ('Milk', test.person('Alex'));
insert into my_day_use (person_id, day, changes) values (test.person('Morgan'), '2026-11-02', 1);
-- 0005: one row in each homework table.
insert into homework_kids (kid_id) values (test.person('Taylor'));
insert into homework_times (event_id, kid_id) values (test.event('Piano'), test.person('Taylor'));
insert into tutor_links (kid_id, label, expires_on) values (test.person('Taylor'), 'Pat Lee, tutor', '2027-04-30');
insert into assignments (kid_id, title, due_date) values (test.person('Taylor'), 'Worksheet 5', '2026-11-06');
insert into homework_steps (assignment_id, pos, title, minutes, day) select id, 1, 'Do the worksheet', 20, '2026-11-03' from assignments;
insert into focus_sessions (id, kid_id, minutes, started_at, ends_at, ended_at, result, seen_minutes)
values (gen_random_uuid(), test.person('Taylor'), 20, '2026-11-02 21:00+00', '2026-11-02 21:20+00', '2026-11-02 21:20+00', 'done', 20);
insert into rewards (kid_id, title, cost) values (test.person('Taylor'), 'Choose Friday''s dinner', 60);
insert into reward_asks (kid_id, reward_id, title, cost, asked_at) select kid_id, id, title, cost, '2026-11-02 22:00+00' from rewards;
insert into points_ledger (kid_id, at, day, kind, delta, note, who)
values (test.person('Taylor'), '2026-11-02 21:20+00', '2026-11-02', 'given', 70, 'Great week', 'alex@example.com');
insert into homework_use (actor_id, day, what, n) values (test.person('Taylor'), '2026-11-02', 'writes', 1);
insert into ai_runs (kind, asked_by, key, status, started_at, lease_until)
values ('test', 'alex@example.com', gen_random_uuid(), 'ready', '2026-11-02 21:00+00', '2026-11-02 21:06+00');

insert into test.samples (tbl, ins, upd) values
  ('household',          $$insert into public.household (id) values (true)$$,
                         $$update public.household set days_off = days_off$$),
  ('people',             $$insert into public.people (name, role) values ('Robin', 'kid')$$,
                         $$update public.people set name = name$$),
  ('people_confirm',     $$insert into public.people_confirm (person_id) values (test.person('Taylor'))$$,
                         $$update public.people_confirm set token = token$$),
  ('events',             $$insert into public.events (title, start_date) values ('Dentist', '2026-11-03')$$,
                         $$update public.events set title = title$$),
  ('event_changes',      $$insert into public.event_changes (event_id, on_date, cancelled) values (test.event('Piano'), '2026-11-16', true)$$,
                         $$update public.event_changes set note = note$$),
  ('tasks',              $$insert into public.tasks (title) values ('Fix gate')$$,
                         $$update public.tasks set title = title$$),
  ('task_log',           $$insert into public.task_log (task_id, status) values (test.task('Trash'), 'done')$$,
                         $$update public.task_log set note = note$$),
  ('contractors',        $$insert into public.contractors (name) values ('Rivera Tile')$$,
                         $$update public.contractors set name = name$$),
  ('contractor_secrets', $$insert into public.contractor_secrets (contractor_id, account_number) values (test.contractor('Pat Lee'), '1234')$$,
                         $$update public.contractor_secrets set account_name = account_name$$),
  ('projects',           $$insert into public.projects (name) values ('Deck')$$,
                         $$update public.projects set name = name$$),
  ('notification_log',   $$insert into public.notification_log (person_id, local_date, kind) values (test.person('Taylor'), '2026-11-02', 'digest')$$,
                         $$update public.notification_log set detail = detail$$),
  ('job_runs',           $$insert into public.job_runs (action) values ('digest')$$,
                         $$update public.job_runs set detail = detail$$),
  ('calendars',          $$insert into public.calendars (google_id, kind, label, writes) values ('family@example.com', 'family', 'Family account', false)$$,
                         $$update public.calendars set label = label$$),
  ('calendar_links',     $$insert into public.calendar_links (google_calendar, base_id, event_id, day, end_day)
                           values ('hub-taylor@group.calendar.google.com', 'hh' || repeat('1', 32), 'hh' || repeat('1', 32), '2026-11-03', '2026-11-03')$$,
                         $$update public.calendar_links set title = title$$),
  ('google_events',      $$insert into public.google_events (calendar_id, google_calendar, event_id, title, all_day, start_day, end_day, read_at)
                           select id, google_id, 'g2', 'Swim meet', true, '2026-11-04', '2026-11-04', now() from public.calendars$$,
                         $$update public.google_events set title = title$$),
  ('calendar_sync',      $$insert into public.calendar_sync (id) values (true) on conflict (id) do nothing$$,
                         $$update public.calendar_sync set last_error = last_error$$),
  ('meals',              $$insert into public.meals (day, kind, title) values ('2026-11-03', 'cook', 'Soup')$$,
                         $$update public.meals set title = title$$),
  ('shopping_items',     $$insert into public.shopping_items (name) values ('Eggs')$$,
                         $$update public.shopping_items set note = note$$),
  ('my_day_use',         $$insert into public.my_day_use (person_id, day) values (test.person('Morgan'), '2026-11-03')$$,
                         $$update public.my_day_use set ticks = ticks$$),
  ('homework_kids',      $$insert into public.homework_kids (kid_id) values (test.person('Morgan'))$$,
                         $$update public.homework_kids set points_on = points_on$$),
  ('homework_times',     $$with e as (insert into public.events (title, start_date, start_time, end_time, responsible_id)
                                     values ('Homework', '2026-11-03', '16:30', '17:15', test.person('Taylor')) returning id)
                           insert into public.homework_times (event_id, kid_id) select id, test.person('Taylor') from e$$,
                         $$update public.homework_times set kid_id = kid_id$$),
  ('tutor_links',        $$insert into public.tutor_links (kid_id, label, expires_on) values (test.person('Taylor'), 'Casey, tutor', '2027-01-01')$$,
                         $$update public.tutor_links set label = label$$),
  ('assignments',        $$insert into public.assignments (kid_id, title, due_date) values (test.person('Taylor'), 'Worksheet 6', '2026-11-20')$$,
                         $$update public.assignments set title = title$$),
  ('homework_steps',     $$insert into public.homework_steps (assignment_id, pos, title, minutes, day)
                           select id, 2, 'Check the answers', 10, '2026-11-04' from public.assignments$$,
                         $$update public.homework_steps set title = title$$),
  ('focus_sessions',     $$insert into public.focus_sessions (id, kid_id, minutes, started_at, ends_at)
                           values (gen_random_uuid(), test.person('Taylor'), 10, now(), now() + interval '10 minutes')$$,
                         $$update public.focus_sessions set note = note$$),
  ('rewards',            $$insert into public.rewards (kid_id, title, cost) values (test.person('Taylor'), 'Movie night', 100)$$,
                         $$update public.rewards set title = title$$),
  ('reward_asks',        $$insert into public.reward_asks (kid_id, title, cost, asked_at) values (test.person('Taylor'), 'Movie night', 100, now())$$,
                         $$update public.reward_asks set note = note$$),
  ('points_ledger',      $$insert into public.points_ledger (kid_id, at, day, kind, delta, who)
                           values (test.person('Taylor'), now(), '2026-11-02', 'given', 5, 'alex@example.com')$$,
                         $$update public.points_ledger set note = note$$),
  ('homework_use',       $$insert into public.homework_use (actor_id, day, what) values (test.person('Taylor'), '2026-11-03', 'writes')$$,
                         $$update public.homework_use set n = n$$),
  ('ai_runs',            $$insert into public.ai_runs (kind, asked_by, key, started_at, lease_until)
                           values ('test', 'alex@example.com', gen_random_uuid(), now(), now() + interval '6 minutes')$$,
                         $$update public.ai_runs set stop = stop$$);

--                         table                 select    insert    update    delete
:as_anon
select test.matrix('anon', 'household',          'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'people',             'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'people_confirm',     'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'events',             'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'event_changes',      'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'tasks',              'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'task_log',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'contractors',        'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'contractor_secrets', 'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'projects',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'notification_log',   'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'job_runs',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('anon', 'calendars',          'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'calendar_links',     'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'google_events',      'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'calendar_sync',      'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'meals',              'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'shopping_items',     'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'my_day_use',         'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'homework_kids',     'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'homework_times',    'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'tutor_links',       'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'assignments',       'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'homework_steps',    'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'focus_sessions',    'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'rewards',           'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'reward_asks',       'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'points_ledger',     'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'homework_use',      'denied', 'denied', 'denied', 'denied');
select test.matrix('anon', 'ai_runs',           'denied', 'denied', 'denied', 'denied');

:as_stranger
select test.matrix('stranger', 'household',          'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'people',             'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'people_confirm',     'denied', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'events',             'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'event_changes',      'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'tasks',              'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'task_log',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'contractors',        'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'contractor_secrets', 'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'projects',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'notification_log',   'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'job_runs',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'calendars',          'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'calendar_links',     'rows:0', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'google_events',      'rows:0', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'calendar_sync',      'rows:0', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'meals',              'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'shopping_items',     'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'my_day_use',         'denied', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'homework_kids', 'rows:0', 'denied', 'rows:0', 'denied');
select test.matrix('stranger', 'homework_times', 'rows:0', 'denied', 'denied', 'rows:0');
select test.matrix('stranger', 'tutor_links',   'rows:0', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'assignments',   'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'homework_steps', 'rows:0', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'focus_sessions', 'rows:0', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'rewards',       'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('stranger', 'reward_asks',   'rows:0', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'points_ledger', 'rows:0', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'homework_use',  'denied', 'denied', 'denied', 'denied');
select test.matrix('stranger', 'ai_runs',       'rows:0', 'denied', 'denied', 'denied');

:as_removed
select test.matrix('removed', 'household',          'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'people',             'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'people_confirm',     'denied', 'denied', 'denied', 'denied');
select test.matrix('removed', 'events',             'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'event_changes',      'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'tasks',              'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'task_log',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'contractors',        'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'contractor_secrets', 'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'projects',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'notification_log',   'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'job_runs',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'calendars',          'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'calendar_links',     'rows:0', 'denied', 'denied', 'denied');
select test.matrix('removed', 'google_events',      'rows:0', 'denied', 'denied', 'denied');
select test.matrix('removed', 'calendar_sync',      'rows:0', 'denied', 'denied', 'denied');
select test.matrix('removed', 'meals',              'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'shopping_items',     'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'my_day_use',         'denied', 'denied', 'denied', 'denied');
select test.matrix('removed', 'homework_kids',  'rows:0', 'denied', 'rows:0', 'denied');
select test.matrix('removed', 'homework_times', 'rows:0', 'denied', 'denied', 'rows:0');
select test.matrix('removed', 'tutor_links',    'rows:0', 'denied', 'denied', 'denied');
select test.matrix('removed', 'assignments',    'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'homework_steps', 'rows:0', 'denied', 'denied', 'denied');
select test.matrix('removed', 'focus_sessions', 'rows:0', 'denied', 'denied', 'denied');
select test.matrix('removed', 'rewards',        'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('removed', 'reward_asks',    'rows:0', 'denied', 'denied', 'denied');
select test.matrix('removed', 'points_ledger',  'rows:0', 'denied', 'denied', 'denied');
select test.matrix('removed', 'homework_use',   'denied', 'denied', 'denied', 'denied');
select test.matrix('removed', 'ai_runs',        'rows:0', 'denied', 'denied', 'denied');

-- City Water has an account number, so only an admin can change or remove it: a statement
-- by anyone else that touches it is refused (with a reason), not quietly skipped.
:as_adult
select test.matrix('adult', 'household',          'rows:1', 'denied', 'rows:0', 'rows:0');
select test.matrix('adult', 'people',             'rows:5', 'denied', 'rows:0', 'rows:0');
select test.matrix('adult', 'people_confirm',     'denied', 'denied', 'denied', 'denied');
select test.matrix('adult', 'events',             'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('adult', 'event_changes',      'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('adult', 'tasks',              'rows:2', 'rows:1', 'rows:2', 'rows:2');
select test.matrix('adult', 'task_log',           'rows:1', 'denied', 'rows:0', 'rows:0');
select test.matrix('adult', 'contractors',        'rows:3', 'rows:1', 'denied', 'denied');
select test.matrix('adult', 'contractor_secrets', 'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('adult', 'projects',           'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('adult', 'notification_log',   'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('adult', 'job_runs',           'rows:0', 'denied', 'rows:0', 'rows:0');
select test.matrix('adult', 'calendars',          'rows:1', 'denied', 'rows:0', 'rows:0');
select test.matrix('adult', 'calendar_links',     'rows:0', 'denied', 'denied', 'denied');
select test.matrix('adult', 'google_events',      'rows:1', 'denied', 'denied', 'denied');
select test.matrix('adult', 'calendar_sync',      'rows:1', 'denied', 'denied', 'denied');
select test.matrix('adult', 'meals',              'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('adult', 'shopping_items',     'rows:1', 'denied', 'rows:1', 'rows:1');
select test.matrix('adult', 'my_day_use',         'denied', 'denied', 'denied', 'denied');
select test.matrix('adult', 'homework_kids',    'rows:1', 'denied', 'rows:0', 'denied');
select test.matrix('adult', 'homework_times',   'rows:1', 'denied', 'denied', 'rows:0');
select test.matrix('adult', 'tutor_links',      'rows:0', 'denied', 'denied', 'denied');
select test.matrix('adult', 'assignments',      'rows:1', 'denied', 'rows:0', 'rows:0');
select test.matrix('adult', 'homework_steps',   'rows:1', 'denied', 'denied', 'denied');
select test.matrix('adult', 'focus_sessions',   'rows:1', 'denied', 'denied', 'denied');
select test.matrix('adult', 'rewards',          'rows:1', 'denied', 'rows:0', 'rows:0');
select test.matrix('adult', 'reward_asks',      'rows:1', 'denied', 'denied', 'denied');
select test.matrix('adult', 'points_ledger',    'rows:1', 'denied', 'denied', 'denied');
select test.matrix('adult', 'homework_use',     'denied', 'denied', 'denied', 'denied');
select test.matrix('adult', 'ai_runs',          'rows:0', 'denied', 'denied', 'denied');

:as_admin
select test.matrix('admin', 'household',          'rows:1', 'denied', 'rows:1', 'rows:0');
select test.matrix('admin', 'people',             'rows:5', 'denied', 'rows:0', 'rows:0');
select test.matrix('admin', 'people_confirm',     'denied', 'denied', 'denied', 'denied');
select test.matrix('admin', 'events',             'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('admin', 'event_changes',      'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('admin', 'tasks',              'rows:2', 'rows:1', 'rows:2', 'rows:2');
select test.matrix('admin', 'task_log',           'rows:1', 'denied', 'rows:0', 'rows:0');
select test.matrix('admin', 'contractors',        'rows:3', 'rows:1', 'rows:3', 'rows:3');
select test.matrix('admin', 'contractor_secrets', 'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('admin', 'projects',           'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('admin', 'notification_log',   'rows:1', 'denied', 'rows:0', 'rows:0');
select test.matrix('admin', 'job_runs',           'rows:1', 'denied', 'rows:0', 'rows:0');
select test.matrix('admin', 'calendars',          'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('admin', 'calendar_links',     'rows:1', 'denied', 'denied', 'denied');
select test.matrix('admin', 'google_events',      'rows:1', 'denied', 'denied', 'denied');
select test.matrix('admin', 'calendar_sync',      'rows:1', 'denied', 'denied', 'denied');
select test.matrix('admin', 'meals',              'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('admin', 'shopping_items',     'rows:1', 'denied', 'rows:1', 'rows:1');
select test.matrix('admin', 'my_day_use',         'denied', 'denied', 'denied', 'denied');
select test.matrix('admin', 'homework_kids',    'rows:1', 'denied', 'rows:1', 'denied');
select test.matrix('admin', 'homework_times',   'rows:1', 'rows:1', 'denied', 'rows:1');
select test.matrix('admin', 'tutor_links',      'rows:1', 'denied', 'denied', 'denied');
select test.matrix('admin', 'assignments',      'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('admin', 'homework_steps',   'rows:1', 'denied', 'denied', 'denied');
select test.matrix('admin', 'focus_sessions',   'rows:1', 'denied', 'denied', 'denied');
select test.matrix('admin', 'rewards',          'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('admin', 'reward_asks',      'rows:1', 'denied', 'denied', 'denied');
select test.matrix('admin', 'points_ledger',    'rows:1', 'denied', 'denied', 'denied');
select test.matrix('admin', 'homework_use',     'denied', 'denied', 'denied', 'denied');
select test.matrix('admin', 'ai_runs',          'rows:1', 'denied', 'denied', 'denied');
-- Admins set a calendar's setting columns only; what Google said about it is hub-jobs' to write.
select test.is(test.try($$update public.calendars set copy_approved_at = now(), label = 'Taylor', for_kids = false$$), 'rows:1',
               'admin: can change a calendar''s setting columns (and Start copying)');
select test.is(test.try($$update public.calendars set status = 'ok'$$), 'denied', 'admin: cannot set a calendar''s status');
select test.is(test.try($$update public.calendars set access_role = 'writer', google_name = 'Hub – Taylor'$$), 'denied',
               'admin: cannot set the access role or Google name');
select test.is(test.try($$insert into public.calendars (google_id, kind, label, writes, status)
                          values ('family@example.com', 'family', 'Family account', false, 'ok')$$), 'denied',
               'admin: cannot insert a calendar that says it is ok');
select test.is(test.try($$insert into public.calendars (google_id, kind, label, writes, copy_approved_at)
                          values ('family@example.com', 'family', 'Family account', false, now())$$), 'denied',
               'admin: cannot insert a calendar already approved (Start copying comes after the preview)');

-- hub-jobs writes the email log and job runs, and reads confirmation secrets; account numbers are closed to it.
:as_service
select test.matrix('service', 'contractor_secrets', 'denied', 'denied', 'denied', 'denied');
select test.matrix('service', 'people_confirm',     'rows:4', 'denied', 'denied', 'denied');
select test.is((select count(*) from people_confirm where token ~ '^[0-9a-f]{32}$'), 4::bigint,
               'service reads each unconfirmed person''s 32-hex confirmation secret (for the email link)');
select test.matrix('service', 'notification_log',   'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'job_runs',           'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'calendars',          'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'calendar_links',     'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'google_events',      'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'calendar_sync',      'rows:1', 'rows:0', 'rows:1', 'rows:1');
select test.matrix('service', 'meals',              'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'shopping_items',     'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'my_day_use',         'denied', 'denied', 'denied', 'denied');
select test.matrix('service', 'homework_kids',  'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'homework_times', 'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'tutor_links',    'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'assignments',    'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'homework_steps', 'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'focus_sessions', 'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'rewards',        'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'reward_asks',    'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'points_ledger',  'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.matrix('service', 'homework_use',   'denied', 'denied', 'denied', 'denied');
select test.matrix('service', 'ai_runs',        'rows:1', 'rows:1', 'rows:1', 'rows:1');
select test.is(test.try('select * from public.people'), 'rows:5', 'service select people');
select test.is(test.try('select * from public.tasks'), 'rows:2', 'service select tasks');

-- ---------------------------------------------------------------------
-- Functions: who can call each one ('ok' = it ran; 'denied' = permission
-- denied, or the function refused with insufficient_privilege)
-- ---------------------------------------------------------------------
:as_owner
create temp table rpc (fn text, call text, anon text, stranger text, removed text, adult text, admin text, service text);
grant select on rpc to public;
insert into rpc values
--  function              call                                                                             anon      stranger  removed   adult     admin     service
  ('clock',              'select * from clock()',                                                           'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('today_local',        'select today_local()',                                                            'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('agenda',             $$select * from agenda('2026-11-01', '2026-11-30')$$,                              'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('late_items',         'select * from late_items()',                                                      'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('heads_up',           $$select * from heads_up('2026-11-02')$$,                                          'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('day_text',           $$select day_text(test.person('Taylor'), '2026-11-02')$$,                          'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('hub_schema_version', 'select hub_schema_version()',                                                     'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('complete_task',      $$select complete_task(test.task('Call plumber'))$$,                               'denied', 'denied', 'denied', 'ok',     'ok',     'denied'),
  ('skip_task',          $$select skip_task(test.task('Trash'))$$,                                          'denied', 'denied', 'denied', 'ok',     'ok',     'denied'),
  ('undo_task',          $$select undo_task((select id from task_log limit 1))$$,                           'denied', 'denied', 'denied', 'ok',     'ok',     'denied'),
  ('save_person',        $$select save_person('{"name": "Robin", "role": "kid"}', false)$$,                 'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('remove_person',      $$select remove_person(test.person('Taylor'))$$,                                   'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('rotate_day_token',   $$select rotate_day_token(test.person('Taylor'))$$,                                'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('mark_signed_in',     'select mark_signed_in()',                                                         'denied', 'ok',     'ok',     'ok',     'ok',     'denied'),
  ('get_person_day',     $$select get_person_day(test.token('Taylor'))$$,                                   'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('complete_by_token',  $$select complete_by_token(test.token('Taylor'), test.task('Trash'), '2026-11-02')$$, 'ok',   'ok',     'ok',     'ok',     'ok',     'denied'),
  ('undo_by_token',      $$select undo_by_token(repeat('0', 32), gen_random_uuid())$$,                      'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('confirm_digest',     $$select confirm_digest(test.confirm_token('Morgan'))$$,                          'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('stop_digest',        $$select stop_digest(test.token('Morgan'))$$,                                      'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('roll_missed_tasks',  'select roll_missed_tasks()',                                                      'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('email_budget_left',  'select email_budget_left()',                                                      'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('digest_due',         'select * from digest_due(10)',                                                    'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('claim_notification', $$select claim_notification(test.person('Taylor'), '2026-11-03', 'digest')$$,      'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('finish_notification',$$select finish_notification((select id from notification_log limit 1), 'sent')$$, 'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('digest_for',         $$select digest_for(test.person('Alex'), '2026-11-02')$$,                          'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  -- Migration 0003: Google events for the pages; the preview for admins; the calendar job for hub-jobs.
  ('google_items',       $$select * from google_items('2026-11-01', '2026-11-30')$$,                        'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('calendar_preview',   $$select * from calendar_preview((select id from calendars limit 1))$$,            'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('calendar_begin',     'select calendar_begin()',                                                         'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('calendar_signed_in', $$select calendar_signed_in(gen_random_uuid(), 'service_account', 'home-hub-sync@example.com', 'k1')$$,
                                                                                                            'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('calendar_read_due',  'select * from calendar_read_due()',                                               'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('calendar_store_events', $$select calendar_store_events(gen_random_uuid(), 'hub-taylor@group.calendar.google.com', '2026-11-01',
                                                            '2026-12-31', 'Hub – Taylor', 'writer', true, '[]', '[]')$$,
                                                                                                            'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('calendar_mark',      $$select calendar_mark(gen_random_uuid(), 'hub-taylor@group.calendar.google.com', 'ok')$$, 'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('calendar_plan',      'select * from calendar_plan()',                                                   'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('calendar_record',    $$select calendar_record('[]')$$,                                                  'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('calendar_finish',    $$select calendar_finish(gen_random_uuid(), '{}')$$,                               'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  -- Migration 0004: the list for the Food page; its actions for members; My day's three for the token.
  ('shopping_list',      'select shopping_list()',                                                          'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('add_to_list',        $$select add_to_list('Bread')$$,                                                   'denied', 'denied', 'denied', 'ok',     'ok',     'denied'),
  ('buy_item',           $$select buy_item(gen_random_uuid(), true, now())$$,                              'denied', 'denied', 'denied', 'ok',     'ok',     'denied'),
  ('get_list_by_token',  $$select get_list_by_token(test.token('Morgan'))$$,                                'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('add_to_list_by_token', $$select add_to_list_by_token(test.token('Morgan'), 'Bread')$$,                  'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('buy_item_by_token',  $$select buy_item_by_token(test.token('Morgan'), gen_random_uuid(), true, now())$$, 'ok',   'ok',     'ok',     'ok',     'ok',     'denied'),
  -- Migration 0005: the week strip for members (row-level security decides); the parents' actions; Jordan's
  -- seven and the tutor link's four for their tokens (an unknown token answers null); hub-jobs' two AI functions.
  ('homework_week',      $$select homework_week(test.person('Taylor'), '2026-11-02')$$,                     'denied', 'ok',     'ok',     'ok',     'ok',     'ok'),
  ('save_homework_kid',  $$select save_homework_kid(test.person('Taylor'), true)$$,                         'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('add_homework_time',  $$select add_homework_time(test.person('Taylor'), '{1}', '16:30', '17:00')$$,       'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('save_homework_plan', $$select save_homework_plan((select id from assignments limit 1), '[]', 0)$$,      'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('homework_step',      $$select homework_step((select id from homework_steps limit 1), 'done')$$,         'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('decide_reward',      $$select decide_reward((select id from reward_asks limit 1), true)$$,              'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('give_points',        $$select give_points(test.person('Taylor'), 5, 'Good work', gen_random_uuid())$$,  'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('void_points',        $$select void_points((select id from points_ledger limit 1), 'A mistake')$$,       'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('save_tutor_link',    $$select save_tutor_link(null, test.person('Taylor'), 'Casey, tutor', 'en', null, true, true)$$,
                                                                                                            'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('new_tutor_token',    $$select new_tutor_token((select id from tutor_links limit 1))$$,                  'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('homework_ai_preview',$$select homework_ai_preview((select id from assignments limit 1))$$,             'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('erase_homework',     $$select erase_homework(test.person('Taylor'), 'ERASE')$$,                         'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('homework_ai_draft',  $$select homework_ai_draft((select id from assignments limit 1), 'dismiss')$$,     'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('homework_by_token',  $$select homework_by_token(test.token('Taylor'))$$,                                'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('step_by_token',      $$select step_by_token(repeat('0', 32), gen_random_uuid(), 'done')$$,             'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('plan_by_token',      $$select plan_by_token(repeat('0', 32), gen_random_uuid(), '[]', 0)$$,            'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('focus_by_token',     $$select focus_by_token(repeat('0', 32), 'start', gen_random_uuid(), 20)$$,       'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('reward_by_token',    $$select reward_by_token(repeat('0', 32), 'ask', gen_random_uuid())$$,            'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('assignment_by_token',$$select assignment_by_token(repeat('0', 32), 'add', gen_random_uuid(), 'Worksheet 7')$$,
                                                                                                            'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('homework_prefs_by_token', $$select homework_prefs_by_token(repeat('0', 32), null, null, 20)$$,          'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('tutor_view_by_token',$$select tutor_view_by_token(repeat('0', 32))$$,                                   'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('tutor_assignment_by_token', $$select tutor_assignment_by_token(repeat('0', 32), '{}')$$,                'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('tutor_plan_by_token',$$select tutor_plan_by_token(repeat('0', 32), gen_random_uuid(), '[]', 0)$$,       'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('tutor_step_by_token',$$select tutor_step_by_token(repeat('0', 32), gen_random_uuid(), 'check')$$,       'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('homework_ai_start',  $$select homework_ai_start(repeat('0', 32), null, gen_random_uuid(), 'plan', null, null, gen_random_uuid())$$,
                                                                                                            'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('homework_ai_finish', $$select homework_ai_finish(gen_random_uuid(), 'error', null, null, null)$$,      'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  -- Migration 0006: the status card for members (null for others); the parents' links and items; his New from
  -- school for his token; hub-jobs' three school functions.
  ('school_feed_status', $$select school_feed_status(test.person('Taylor'))$$,                              'denied', 'ok',     'ok',     'ok',     'ok',     'denied'),
  ('set_school_feed',    $$select set_school_feed(test.person('Taylor'), 'games', null)$$,                  'denied', 'denied', 'denied', 'denied', 'ok',     'denied'),
  ('check_school_feed',  $$select check_school_feed(gen_random_uuid(), 'end', 0)$$,                         'denied', 'denied', 'denied', 'denied', 'error: That school link isn''t there any more.', 'denied'),
  ('pause_school_feed',  $$select pause_school_feed(gen_random_uuid(), true)$$,                             'denied', 'denied', 'denied', 'denied', 'error: That school link isn''t there any more.', 'denied'),
  ('school_item_action', $$select school_item_action(gen_random_uuid(), 'hide')$$,                          'denied', 'denied', 'denied', 'denied', 'error: That item from school isn''t there any more.', 'denied'),
  ('school_item_by_token', $$select school_item_by_token(repeat('0', 32), gen_random_uuid(), 'hide')$$,     'ok',     'ok',     'ok',     'ok',     'ok',     'denied'),
  ('school_begin',       'select school_begin()',                                                           'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('school_store',       $$select school_store(gen_random_uuid(), gen_random_uuid(), '[]', null)$$,         'denied', 'denied', 'denied', 'denied', 'denied', 'ok'),
  ('school_finish',      $$select school_finish(gen_random_uuid())$$,                                       'denied', 'denied', 'denied', 'denied', 'denied', 'ok');

:as_anon
select test.is(test.can(call), anon, 'anon → ' || fn) from rpc order by fn;
:as_stranger
select test.is(test.can(call), stranger, 'stranger → ' || fn) from rpc order by fn;
:as_removed
select test.is(test.can(call), removed, 'removed → ' || fn) from rpc order by fn;
:as_adult
select test.is(test.can(call), adult, 'adult → ' || fn) from rpc order by fn;
:as_admin
select test.is(test.can(call), admin, 'admin → ' || fn) from rpc order by fn;
:as_service
select test.is(test.can(call), service, 'service → ' || fn) from rpc order by fn;

-- The read functions run with the caller's rights: outsiders get nothing back.
:as_stranger
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30')), 0::bigint, 'stranger: agenda is empty');
select test.is(day_text(test.person('Taylor'), '2026-11-02'), null, 'stranger: day_text is null');
:as_removed
select test.is((select count(*) from agenda('2026-11-01', '2026-11-30')), 0::bigint, 'removed member: agenda is empty');
select test.is((select count(*) from late_items()), 0::bigint, 'removed member: late_items is empty');
:as_adult
select test.ok((select count(*) from agenda('2026-11-01', '2026-11-30')) > 0, 'adult: agenda has the household''s items');

-- ---------------------------------------------------------------------
-- Directory entries with account numbers
-- ---------------------------------------------------------------------
:as_adult
select test.throws($$update contractors set phone = '555-0161' where name = 'City Water'$$,
                   'Only an admin can change City Water, because it has account details saved', 'adult cannot change an entry with an account number');
select test.throws($$delete from contractors where name = 'City Water'$$,
                   'Only an admin can delete City Water, because it has account details saved', 'adult cannot remove an entry with an account number');
select test.is(test.try($$delete from contractors where name = 'City Water'$$), 'denied', '... the refusal is a permission error (42501), so a v1 page says so');
select test.is(test.try($$update contractors set phone = '555-0151' where name = 'Rivera Music'$$), 'rows:1', 'adult can change other entries');
select test.is((select phone from contractors where name = 'City Water'), '555-0160', 'adult still sees the entry itself');
:as_admin
select test.is(test.try($$update contractors set phone = '555-0161' where name = 'City Water'$$), 'rows:1', 'admin can change an entry with an account number');
select test.is((select account_number from contractor_secrets), '0000-1111-2222', 'admin reads the account number');

-- ---------------------------------------------------------------------
-- Audit columns come from the signed-in email
-- ---------------------------------------------------------------------
:as_adult
insert into events (title, start_date, created_by, updated_by) values ('Recital', '2026-11-20', 'alex@example.com', 'alex@example.com');
insert into tasks (title, done_at, done_by, created_by) values ('Buy stamps', now(), 'alex@example.com', 'alex@example.com');
select test.is((select created_by || ' ' || updated_by from events where title = 'Recital'), 'sam@example.com sam@example.com',
               'created_by and updated_by are the caller, whatever the client sends');
select test.is((select done_by from tasks where title = 'Buy stamps'), 'sam@example.com', 'done_by is the caller');
:as_admin
update events set title = 'School recital', created_by = 'casey@example.com' where title = 'Recital';
update tasks set done_by = 'casey@example.com' where title = 'Buy stamps';
select test.is((select created_by || ' ' || updated_by from events where title = 'School recital'), 'sam@example.com alex@example.com',
               'an update keeps created_by and sets updated_by');
select test.is((select done_by from tasks where title = 'Buy stamps'), 'alex@example.com', 'done_by cannot be rewritten to someone else');
update tasks set done_at = null where title = 'Buy stamps';
select test.is((select done_by from tasks where title = 'Buy stamps'), null, 'reopening a task clears done_by');
update household set updated_by = 'casey@example.com', days_off = '{2026-11-26}';
select test.is((select updated_by from household), 'alex@example.com', 'household updated_by is the admin');
update contractor_secrets set account_name = 'Alex E.', updated_by = 'casey@example.com';
select test.is((select updated_by from contractor_secrets), 'alex@example.com', 'contractor_secrets updated_by is the admin');

-- ---------------------------------------------------------------------
-- The v1 site's own writes still work on the v2 schema
-- ---------------------------------------------------------------------
:as_adult
create temp table v1_project as
  select id, updated_at from projects where name = 'Kitchen';
select test.is(test.try($$update projects set schedule = '{"project": {}, "trades": {}, "phases": []}'
                          where id = (select id from v1_project) and updated_at = (select updated_at from v1_project)$$),
               'rows:1', 'v1: saving a schedule with the updated_at check');
select test.is(test.try($$insert into contractors (name, company, trade, phone, email, website, notes)
                          values ('Rivera Tile', 'Rivera Tile', 'Tile', '555-0120', 'tile@rivera.example', 'rivera.example', 'Ask for Pat')$$),
               'rows:1', 'v1: adding a contractor with the v1 fields');
:as_admin
select test.is(test.try($$insert into members (email, name) values ('casey@example.com', 'Casey')$$), 'rows:1', 'v1: the old Family page can still add a member');
select test.is(test.try($$delete from members where email = 'sam@example.com'$$), 'rows:1', 'v1: ... and remove one');
