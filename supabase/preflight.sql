-- =====================================================================
-- HOME HUB — preflight checks before applying migrations/0002_home_hub_v2.sql
-- Read-only: one query, no changes. Run it on the live database (SQL editor
-- or execute_sql) and apply the migration only if every row says ok = true.
--   • The v1 baseline from schema.sql is there: tables and their columns,
--     row-level security, policies, functions, triggers, the private schema,
--     pgcrypto and the API roles.
--   • Nothing migration 0002 creates exists yet (it would stop half-way).
--   • There is at least one admin, who becomes the first parent.
-- The first row is the server version, for the record.
-- =====================================================================
with expected (n, kind, name, want) as (
  values
    -- Baseline: schema.sql
    (1, 'schema',    'private', true),
    (1, 'role',      'anon', true),
    (1, 'role',      'authenticated', true),
    (1, 'role',      'service_role', true),
    (1, 'extension', 'pgcrypto', true),
    (1, 'function',  'extensions.gen_random_bytes(integer)', true),
    (2, 'rls',       'public.members', true),
    (2, 'rls',       'public.contractors', true),
    (2, 'rls',       'public.projects', true),
    (2, 'rls',       'public.email_log', true),
    (3, 'columns',   'public.members: email name role created_at', true),
    (3, 'columns',   'public.contractors: id name company trade phone email website notes created_at updated_at', true),
    (3, 'columns',   'public.projects: id name status summary schedule sharing_enabled share_token created_at updated_at', true),
    (3, 'columns',   'public.email_log: id sent_by recipients subject status error created_at', true),
    (4, 'policy',    'public.members: Family can see the member list', true),
    (4, 'policy',    'public.members: Admins add members', true),
    (4, 'policy',    'public.members: Admins update members', true),
    (4, 'policy',    'public.members: Admins remove other members', true),
    (4, 'policy',    'public.contractors: Family manages contractors', true),
    (4, 'policy',    'public.projects: Family manages projects', true),
    (4, 'policy',    'public.email_log: Family can see sent emails', true),
    (4, 'policy',    'public.email_log: Members log their own emails', true),
    (5, 'function',  'public.touch_updated_at()', true),
    (5, 'function',  'public.current_email()', true),
    (5, 'function',  'private.is_member()', true),
    (5, 'function',  'private.is_admin()', true),
    (5, 'function',  'public.whoami()', true),
    (5, 'function',  'public.get_shared_project(text)', true),
    (5, 'function',  'public.hook_family_only_signup(jsonb)', true),
    (5, 'trigger',   'public.contractors: contractors_touch_updated_at', true),
    (5, 'trigger',   'public.projects: projects_touch_updated_at', true),
    (6, 'admin',     'at least one admin in members', true),
    -- Not there yet: everything migration 0002 creates
    (7, 'table',     'public.household', false),
    (7, 'table',     'public.people', false),
    (7, 'table',     'public.events', false),
    (7, 'table',     'public.event_changes', false),
    (7, 'table',     'public.tasks', false),
    (7, 'table',     'public.task_log', false),
    (7, 'table',     'public.contractor_secrets', false),
    (7, 'table',     'public.notification_log', false),
    (7, 'table',     'public.job_runs', false),
    (7, 'type',      'public.agenda_item', false),
    (8, 'column',    'public.contractors.kind', false),
    (8, 'column',    'public.contractors.category', false),
    (8, 'column',    'public.contractors.address', false),
    (8, 'column',    'public.contractors.contract_end', false),
    (8, 'column',    'public.contractors.updated_by', false),
    (8, 'column',    'public.projects.task_dates', false),
    (8, 'column',    'public.projects.on_calendar', false),
    (8, 'column',    'public.projects.owner_id', false),
    (9, 'named',     'public: hub_schema_version clock today_local agenda late_items heads_up day_text complete_task '
                     'skip_task undo_task roll_missed_tasks save_person remove_person rotate_day_token get_person_day '
                     'complete_by_token confirm_digest stop_digest email_budget_left digest_due claim_notification '
                     'finish_notification digest_for', false),
    (9, 'named',     'private: now tz stamp people_email_changed events_weekdays tasks_defaults projects_mark_dates_stale '
                     'has_secrets monday in_weekly_series add_units months_between series_after series_on_or_before '
                     'safe_date word day_label short_date time_label task_item item_order person_items names who_text '
                     'text_line complete_task person_by_token my_day_item digest_item', false)
),
found as (
  select e.n, e.kind, e.name, e.want,
         case e.kind
           when 'schema'    then exists (select 1 from pg_namespace where nspname = e.name)
           when 'role'      then exists (select 1 from pg_roles where rolname = e.name)
           when 'extension' then exists (select 1 from pg_extension where extname = e.name)
           when 'function'  then to_regprocedure(e.name) is not null
           when 'table'     then to_regclass(e.name) is not null
           when 'type'      then to_regtype(e.name) is not null
           when 'rls'       then coalesce((select relrowsecurity from pg_class where oid = to_regclass(e.name)), false)
           when 'columns'   then not exists (
                                   select 1 from unnest(string_to_array(split_part(e.name, ': ', 2), ' ')) c (col)
                                   where not exists (select 1 from pg_attribute a
                                                     where a.attrelid = to_regclass(split_part(e.name, ': ', 1))
                                                       and a.attname = c.col and not a.attisdropped))
           when 'column'    then exists (select 1 from pg_attribute a
                                         where a.attrelid = to_regclass(regexp_replace(e.name, '\.[^.]+$', ''))
                                           and a.attname = regexp_replace(e.name, '^.*\.', '') and not a.attisdropped)
           when 'policy'    then exists (select 1 from pg_policies p
                                         where p.schemaname || '.' || p.tablename = split_part(e.name, ': ', 1)
                                           and p.policyname = split_part(e.name, ': ', 2))
           when 'trigger'   then exists (select 1 from pg_trigger t
                                         where t.tgrelid = to_regclass(split_part(e.name, ': ', 1))
                                           and t.tgname = split_part(e.name, ': ', 2))
           -- (query_to_xml so a missing members table is reported, not an error)
           when 'admin'     then to_regclass('public.members') is not null
                                 and (xpath('/row/c/text()', query_to_xml(
                                       'select count(*) as c from public.members where role = ''admin''', false, true, '')))[1]::text::int > 0
           when 'named'     then exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                                         where s.nspname = split_part(e.name, ': ', 1)
                                           and p.proname = any (string_to_array(split_part(e.name, ': ', 2), ' ')))
         end as present
  from expected e
)
select item, ok, detail
from (
  select 'server version' as item, true as ok, version() as detail, 0 as n
  union all
  select case when want then kind || ' exists: ' else kind || ' not there yet: ' end || name,
         present = want,
         case when present = want then 'ok'
              when want then 'MISSING: the live database differs from schema.sql; fix this before migrating'
              else 'ALREADY THERE: the migration would stop; find out where it came from first' end,
         n
  from found
) result
order by n, item;
