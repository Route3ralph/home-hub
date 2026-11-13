-- =====================================================================
-- HOME HUB v2 — migration 0027: a task shows on the Calendar page only when asked to
-- Apply once, after 0026, and only once the site that understands it is live (docs/v2-design.md §33).
--
-- Why
--   Every task with a date was on the Calendar page: one-off jobs, chores and every task of a project, which crowded
--   the family's events. A parent wants a task there only when they ask for it, as projects already have their own
--   "Show in Home Hub calendar" switch (projects.on_calendar).
--
-- What it adds
--   • A column on public.tasks: on_calendar (boolean, false by default; every task there now starts false). The Tasks
--     page's form has "Show on the calendar"; the Calendar page (its weeks, months and printed sheet) shows a task only
--     when it is ticked. Members change it as they change the rest of a task (the table's policy, unchanged).
--   • Nothing else reads it: Today, My day, the morning and Sunday emails, the Tomorrow message, the family board and
--     Google still show every task as before (agenda and the rest are unchanged).
--   • hub_schema_version() (27). The pages ask for the column only on 27; before it, every task is on the Calendar
--     as before.
--
-- Rules
--   • One transaction. It refuses to run without 0026, twice, on a database set back to 26 (the column already there),
--     or on one that isn't as 0026 left it.
--
-- Undo (not needed: tick every task's box and the Calendar is as on 26). If wanted, in one go:
--   alter table public.tasks drop column on_calendar;
--   then 0026's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0026 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 26 then
    raise exception 'Homework counts (migration 0026) aren''t installed (hub_schema_version() is %). Run 0026_homework_counts.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 27 then
    raise exception 'Tasks on the calendar (migration 0027) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'on_calendar') then
    raise exception 'Tasks on the calendar (migration 0027) are already installed, but hub_schema_version() was set back to 26. To switch them on again, make hub_schema_version() return 27 (docs/v2-design.md §33). Nothing was changed.';
  end if;
  -- What this migration changes is as 0026 left it.
  if to_regclass('public.tasks') is null
     or to_regprocedure('public.count_by_token(text, uuid, int, int)') is null then
    raise exception 'This database isn''t as migration 0026 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The column (§33)
-- ---------------------------------------------------------------------
-- Every task there now starts off the Calendar page; a member ticks the ones that belong there.
alter table public.tasks add column on_calendar boolean not null default false;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages ask for on_calendar only on 27. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 27;
$$;

commit;
