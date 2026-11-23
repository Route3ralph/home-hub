-- =====================================================================
-- HOME HUB v2 — migration 0036: points from the school's marks (Missing and Graded move a kid's points)
-- Apply once, after 0035, and only once the site that understands it is live (docs/v1.3-homework.md §36.4).
-- No Edge Function and cron.sql don't change.
-- The contract is docs/v1.3-homework.md §36; the database side is docs/v2-design.md §42.
--
-- Why
--   The parents and the tutor wanted the school's marks to give the kid real-time feedback in points: work marked
--   Missing costs points, a low grade costs a few, a high grade earns a bonus, and a makeup or a corrected grade gives
--   them back. A parent or the coach still marks an assignment by hand (0023); the points now follow the mark.
--
-- What it adds
--   • homework_kids: pts_missing (10), pts_low_grade (5), grade_floor (75), pts_high_grade (10), grade_top (90) and
--     pts_mark_week (50: the most the marks take in a household week). A parent changes them as the other points
--     values (column grants); 0 turns one off.
--   • points_ledger: kinds 'mark_off' (points taken for a mark, or a bonus taken back) and 'mark_on' (a bonus, or
--     points given back), and assignment_id, the assignment a mark line is for.
--   • private.grade_number(text): a grade as a number out of 100 ("72", "72%", "18/20", "B+"), or null.
--   • private.mark_points(uuid): makes an assignment's mark lines add up to what its mark is worth now: Missing
--     -pts_missing; Graded under grade_floor -pts_low_grade; Graded at grade_top or more +pts_high_grade; anything
--     else 0. Never more taken than his free points or what is left of the week's pts_mark_week. Only with his
--     points on. A trigger on assignments (school_mark, grade) calls it after every change.
--   • hub_schema_version() (36).
--
-- Rules
--   • One transaction. It refuses to run without 0035, twice, on a database set back to 35 (the columns already
--     there), or on one that isn't as 0035 left it.
--   • Additive: columns with defaults, two kinds, a function and a trigger. Nothing that was marked before 0036 moves
--     points: only a mark set or changed after it.
--   • The kid sees each line ("Missing: Lab report", "Grade 92: Essay", "Made up: Lab report"), on his My day and the
--     tutor link, as every points line.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: set the five values to 0 and nothing moves). If wanted, in one go (the mark lines go with it):
--   drop trigger assignments_mark_points on public.assignments;
--   drop function private.assignments_mark_points();
--   drop function private.mark_points(uuid);
--   drop function private.grade_number(text);
--   delete from public.points_ledger where kind in ('mark_off', 'mark_on');
--   alter table public.points_ledger drop column assignment_id;
--   alter table public.points_ledger drop constraint points_ledger_check;
--   alter table public.points_ledger add constraint points_ledger_check check ((kind in ('void', 'trade', 'taken')) = (delta < 0));
--   alter table public.points_ledger drop constraint points_ledger_kind_check;
--   alter table public.points_ledger add constraint points_ledger_kind_check check (kind in ('focus', 'on_time', 'milestone_done', 'milestone', 'given', 'void', 'trade', 'routine', 'taken', 'start'));
--   alter table public.homework_kids drop constraint homework_kids_grade_order;
--   alter table public.homework_kids drop column pts_missing, drop column pts_low_grade, drop column grade_floor, drop column pts_high_grade, drop column grade_top, drop column pts_mark_week;
--   then 0035's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0035 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 35 then
    raise exception 'The Sunday summary (migration 0035) isn''t installed (hub_schema_version() is %). Run 0035_tutor_summary.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 36 then
    raise exception 'Points from the school''s marks (migration 0036) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.homework_kids'::regclass and a.attname = 'pts_missing' and not a.attisdropped) then
    raise exception 'Points from the school''s marks (migration 0036) are already installed, but hub_schema_version() was set back to 35. To switch them on again, make hub_schema_version() return 36 (docs/v1.3-homework.md §36). Nothing was changed.';
  end if;
  -- What this migration reads and changes is as 0035 left it.
  if to_regprocedure('private.points_balance(uuid)') is null
     or to_regprocedure('private.monday(date)') is null
     or to_regprocedure('private.now()') is null
     or to_regprocedure('public.today_local()') is null
     or to_regprocedure('public.current_email()') is null
     or to_regclass('public.tutor_summary_log') is null
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.assignments'::regclass and a.attname = 'school_mark' and not a.attisdropped)
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.points_ledger'::regclass and a.attname = 'assignment_id' and not a.attisdropped)
     or to_regprocedure('private.mark_points(uuid)') is not null
     or (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.points_ledger'::regclass and c.conname = 'points_ledger_kind_check')
        is distinct from 'CHECK ((kind = ANY (ARRAY[''focus''::text, ''on_time''::text, ''milestone_done''::text, ''milestone''::text, ''given''::text, ''void''::text, ''trade''::text, ''routine''::text, ''taken''::text, ''start''::text])))'
     or (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.points_ledger'::regclass and c.conname = 'points_ledger_check')
        is distinct from 'CHECK (((kind = ANY (ARRAY[''void''::text, ''trade''::text, ''taken''::text])) = (delta < 0)))' then
    raise exception 'This database isn''t as migration 0035 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The values (§36.2)
-- ---------------------------------------------------------------------
alter table public.homework_kids
  add column pts_missing    int not null default 10 check (pts_missing between 0 and 100),
  add column pts_low_grade  int not null default 5  check (pts_low_grade between 0 and 100),
  add column grade_floor    int not null default 75 check (grade_floor between 0 and 100),
  add column pts_high_grade int not null default 10 check (pts_high_grade between 0 and 100),
  add column grade_top      int not null default 90 check (grade_top between 0 and 100),
  add column pts_mark_week  int not null default 50 check (pts_mark_week between 0 and 500),
  add constraint homework_kids_grade_order check (grade_floor < grade_top);
grant update (pts_missing, pts_low_grade, grade_floor, pts_high_grade, grade_top, pts_mark_week) on public.homework_kids to authenticated;

-- ---------------------------------------------------------------------
-- The lines (§36.3)
-- ---------------------------------------------------------------------
alter table public.points_ledger add column assignment_id uuid references public.assignments (id) on delete set null;
create index points_ledger_assignment on public.points_ledger (assignment_id) where assignment_id is not null;
alter table public.points_ledger drop constraint points_ledger_kind_check;
alter table public.points_ledger add constraint points_ledger_kind_check
  check (kind in ('focus', 'on_time', 'milestone_done', 'milestone', 'given', 'void', 'trade', 'routine', 'taken', 'start', 'mark_off', 'mark_on'));
alter table public.points_ledger drop constraint points_ledger_check;
alter table public.points_ledger add constraint points_ledger_check check ((kind in ('void', 'trade', 'taken', 'mark_off')) = (delta < 0));

-- A grade as a number out of 100: "92", "92%", "92.5", "18/20" (as a share of 100), or a letter (A+ 98, A 95, A- 91,
-- B+ 88, B 85, B- 81, C+ 78, C 75, C- 71, D+ 68, D 65, D- 61, F 50). Anything else is null: no points either way.
create function private.grade_number(p_grade text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  g text := upper(btrim(coalesce(p_grade, '')));
  m text[];
begin
  if g = '' then
    return null;
  end if;
  m := regexp_match(g, '^(\d{1,3}(?:\.\d+)?)\s*%?$');
  if m is not null then
    return case when m[1]::numeric <= 150 then m[1]::numeric end;
  end if;
  m := regexp_match(g, '^(\d{1,3}(?:\.\d+)?)\s*/\s*(\d{1,3}(?:\.\d+)?)$');
  if m is not null then
    return case when m[2]::numeric > 0 and m[1]::numeric <= m[2]::numeric * 1.5 then round(m[1]::numeric * 100 / m[2]::numeric, 1) end;
  end if;
  return case g
    when 'A+' then 98 when 'A' then 95 when 'A-' then 91
    when 'B+' then 88 when 'B' then 85 when 'B-' then 81
    when 'C+' then 78 when 'C' then 75 when 'C-' then 71
    when 'D+' then 68 when 'D' then 65 when 'D-' then 61
    when 'F' then 50 end;
end;
$$;

-- An assignment's mark lines made to add up to what its mark is worth now. Only taking more is limited: by his free
-- points (his balance less what his waiting asks hold) and by what is left of the household week's pts_mark_week.
create function private.mark_points(p_assignment uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a      public.assignments;
  k      public.homework_kids;
  v_num  numeric;
  v_want int := 0;
  v_have int;
  v_diff int;
  v_free int;
  v_used int;
  v_mon  date := private.monday(public.today_local());
  v_note text;
begin
  select * into a from public.assignments x where x.id = p_assignment;
  if a.id is null then
    return;
  end if;
  -- His homework_kids row first: every writer of his balance takes that lock first.
  select * into k from public.homework_kids x where x.kid_id = a.kid_id for update;
  if k.kid_id is null or not k.points_on then
    return;
  end if;
  v_num := private.grade_number(a.grade);
  if a.school_mark = 'missing' then
    v_want := -k.pts_missing;
  elsif a.school_mark = 'graded' and v_num is not null and v_num < k.grade_floor then
    v_want := -k.pts_low_grade;
  elsif a.school_mark = 'graded' and v_num is not null and v_num >= k.grade_top then
    v_want := k.pts_high_grade;
  end if;
  select coalesce(sum(l.delta), 0)::int into v_have
  from public.points_ledger l where l.assignment_id = a.id and l.kind in ('mark_off', 'mark_on');
  v_diff := v_want - v_have;
  if v_diff < 0 then
    -- Taking: never below his free points, never past the week's limit for the marks.
    select greatest(b.balance - b.held, 0) into v_free from private.points_balance(a.kid_id) b;
    select coalesce(-sum(l.delta), 0)::int into v_used
    from public.points_ledger l where l.kid_id = a.kid_id and l.kind = 'mark_off' and l.day between v_mon and v_mon + 6;
    v_diff := -least(-v_diff, coalesce(v_free, 0), greatest(k.pts_mark_week - v_used, 0));
  end if;
  if v_diff = 0 then
    return;
  end if;
  v_note := case
    when a.school_mark = 'missing' then 'Missing: '
    when a.school_mark = 'graded' and v_num is not null and v_want <> 0 then 'Grade ' || a.grade || ': '
    when v_diff > 0 then 'Made up: '
    else 'Mark changed: ' end;
  insert into public.points_ledger (kid_id, at, day, kind, delta, note, who, assignment_id)
  values (a.kid_id, private.now(), public.today_local(), case when v_diff < 0 then 'mark_off' else 'mark_on' end, v_diff,
          left(v_note || a.title, 120), coalesce(public.current_email(), 'Home Hub'), a.id);
end;
$$;

create function private.assignments_mark_points()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.school_mark is distinct from old.school_mark or new.grade is distinct from old.grade then
    perform private.mark_points(new.id);
  end if;
  return null;
end;
$$;

create trigger assignments_mark_points
  after insert or update of school_mark, grade on public.assignments
  for each row execute function private.assignments_mark_points();

revoke execute on function private.grade_number(text)          from public, anon, authenticated;
revoke execute on function private.mark_points(uuid)           from public, anon, authenticated;
revoke execute on function private.assignments_mark_points()   from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Homework page shows the marks' points values only on 36. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 36;
$$;

commit;
