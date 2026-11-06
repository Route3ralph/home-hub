-- =====================================================================
-- HOME HUB v2 — migration 0023: Missing and Graded on an assignment (what the school says about it)
-- Apply once, after 0022, and only once the site that understands it is live (docs/v1.3-homework.md §26).
--
-- Why
--   The school's portal says an assignment is missing, or graded, and the hub didn't: a parent marks it by hand on the
--   assignment's page ("Missing", "Graded" with an optional grade such as "92" or "B+"), so the Homework list shows what
--   needs chasing. Nothing reads the portal for it: the feed carries no grades (docs/v1.3-homework.md §26).
--
-- What it adds
--   • Columns on public.assignments: school_mark ('missing' or 'graded', or null) and grade (1 to 20 characters, one
--     line, only with 'graded'). Parents and the coach change them as they change the rest of an assignment (the
--     table's policies, unchanged; a column grant of update on the two). Nothing else reads them: not a kid's My day,
--     not the tutor link, not the board, the wall, Google or an email.
--   • hub_schema_version() (23). The page shows Missing and Graded only on 23.
--
-- Rules
--   • One transaction. It refuses to run without 0022, twice, on a database set back to 22 (the column already there),
--     or on one that isn't as 0022 left it.
--
-- Undo (not needed: with nothing marked, every page is as on 22). If wanted, in one go:
--   alter table public.assignments drop column grade, drop column school_mark;
--   then 0022's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;"). The marks
--   go with it.
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0022 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 22 then
    raise exception 'The watch list (migration 0022) isn''t installed (hub_schema_version() is %). Run 0022_watch_list.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 23 then
    raise exception 'Missing and Graded (migration 0023) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'school_mark') then
    raise exception 'Missing and Graded (migration 0023) are already installed, but hub_schema_version() was set back to 22. To switch them on again, make hub_schema_version() return 23 (docs/v1.3-homework.md §26). Nothing was changed.';
  end if;
  -- What this migration changes is as 0022 left it.
  if to_regclass('public.watch_items') is null
     or to_regclass('public.assignments') is null
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'grade') then
    raise exception 'This database isn''t as migration 0022 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The columns (§26)
-- ---------------------------------------------------------------------
alter table public.assignments
  add column school_mark text check (school_mark in ('missing', 'graded')),
  add column grade text check (grade is null or (char_length(grade) between 1 and 20 and grade !~ '[[:cntrl:]]' and grade = btrim(grade))),
  add constraint assignments_grade_graded check (grade is null or school_mark is not distinct from 'graded');

-- Parents and the coach change them (the table's policies decide who); the page sends them alone or with the rest.
grant update (school_mark, grade) on public.assignments to authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The page shows Missing and Graded only on 23. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 23;
$$;

commit;
