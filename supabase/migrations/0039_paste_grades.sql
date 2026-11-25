-- =====================================================================
-- HOME HUB v2 — migration 0039: Paste grades (the school portal's grade report marks his homework Graded), and a
-- weekly limit on grade bonuses
-- Apply once, after 0038, and only once the site that understands it is live (docs/v1.3-homework.md §40.4).
-- No Edge Function and no cron.sql change.
-- The contract is docs/v1.3-homework.md §40; the database side is docs/v2-design.md §45.
--
-- Why
--   The school's feed carries no grades; its portal has a grade report (Assignments → Reports → View Assignment
--   Grades). Typing each grade by hand was the slow part. A parent or the coach now pastes the report and the hub marks
--   the matching homework Graded, so 0036's points follow. Only recent work moves points, and bonuses have a weekly
--   limit like the points taken (0036 limited only taking).
--
-- What it adds
--   • homework_kids.pts_bonus_week (50; 0 to 500): the most the grade bonuses give in a household week. A parent
--     changes it with the other values (a column grant).
--   • points_ledger.bonus: the part of a mark line that is a grade bonus given (+) or taken back (−); null otherwise.
--   • private.mark_points(uuid): 0037's, but a bonus is limited by what is left of the week's pts_bonus_week (points
--     given back after a mark is cleared or improved are not), and each line records its bonus part.
--   • public.paste_grades(p_kid uuid, p_rows jsonb, p_apply boolean) returns jsonb: a parent or the coach. Each row
--     {title, class, due, grade} is matched to his homework (title ignoring case and spaces; the class without its
--     section, or no class on the hub; the nearest due date within 7 days). A match due within the last 14 days (or
--     later) is marked Graded with that grade; an older one is left as it is ("older"). Preview (p_apply false) changes
--     nothing. Answers {rows: [{i, status, assignment_id, title, subject, due, grade, was, points}], counts}.
--   • hub_schema_version() (39). The Homework page shows Paste grades and the bonus limit only on 39.
--
-- Rules
--   • One transaction. It refuses to run without 0038, twice, on a database set back to 38 (the column already there),
--     or on one that isn't as 0038 left it.
--   • Additive: one column with a default, one nullable column, a function. Bonuses already given stay.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: Paste grades is only used when a parent pastes). If wanted, in one go:
--   drop function public.paste_grades(uuid, jsonb, boolean);
--   alter table public.points_ledger drop column bonus;
--   alter table public.homework_kids drop column pts_bonus_week;
--   then 0037's private.mark_points ("create or replace function private.mark_points", to its "$$;") and 0038's
--   hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0038 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 38 then
    raise exception 'Study before tests (migration 0038) isn''t installed (hub_schema_version() is %). Run 0038_test_prep.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 39 then
    raise exception 'Paste grades (migration 0039) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.homework_kids'::regclass and a.attname = 'pts_bonus_week' and not a.attisdropped) then
    raise exception 'Paste grades (migration 0039) is already installed, but hub_schema_version() was set back to 38. To switch it on again, make hub_schema_version() return 39 (docs/v1.3-homework.md §40). Nothing was changed.';
  end if;
  -- What this migration reads and changes is as 0038 left it.
  if to_regprocedure('private.mark_points(uuid)') is null
     or to_regprocedure('private.test_prep(uuid)') is null
     or to_regprocedure('private.grade_number(text)') is null
     or to_regprocedure('private.is_coach()') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('private.monday(date)') is null
     or to_regprocedure('public.paste_grades(uuid, jsonb, boolean)') is not null
     or not exists (select 1 from pg_trigger t where t.tgname = 'assignments_mark_points')
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.points_ledger'::regclass and a.attname = 'assignment_id' and not a.attisdropped)
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.points_ledger'::regclass and a.attname = 'bonus' and not a.attisdropped) then
    raise exception 'This database isn''t as migration 0038 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The bonus limit (§40.3)
-- ---------------------------------------------------------------------
alter table public.homework_kids add column pts_bonus_week int not null default 50 check (pts_bonus_week between 0 and 500);
grant update (pts_bonus_week) on public.homework_kids to authenticated;
alter table public.points_ledger add column bonus int;   -- a mark line's grade-bonus part: + given, − taken back

-- 0037's, with the bonus limited by the week's pts_bonus_week and recorded on the line.
create or replace function private.mark_points(p_assignment uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a       public.assignments;
  k       public.homework_kids;
  v_num   numeric;
  v_want  int := 0;
  v_have  int;
  v_diff  int;
  v_free  int;
  v_used  int;
  v_bonus int := 0;
  v_back  int;
  v_mon   date := private.monday(public.today_local());
  v_note  text;
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
    -- What it takes comes off a bonus first, while the assignment holds one.
    v_bonus := -least(greatest(v_have, 0), -v_diff);
  elsif v_diff > 0 then
    -- Giving: points given back (up to 0) always; a bonus (above 0) only up to what is left of the week's limit.
    v_bonus := greatest(greatest(v_want, 0) - greatest(v_have, 0), 0);
    v_back := v_diff - v_bonus;
    select coalesce(sum(l.bonus), 0)::int into v_used
    from public.points_ledger l where l.kid_id = a.kid_id and l.bonus is not null and l.day between v_mon and v_mon + 6;
    v_bonus := least(v_bonus, greatest(k.pts_bonus_week - v_used, 0));
    v_diff := v_back + v_bonus;
  end if;
  if v_diff = 0 then
    return;
  end if;
  v_note := case
    when a.school_mark = 'missing' then 'Missing: '
    when a.school_mark = 'graded' and v_num is not null and v_want <> 0 then 'Grade ' || a.grade || ': '
    when v_diff > 0 then 'Made up: '
    else 'Mark changed: ' end;
  insert into public.points_ledger (kid_id, at, day, kind, delta, note, who, assignment_id, bonus)
  values (a.kid_id, private.now(), public.today_local(), case when v_diff < 0 then 'mark_off' else 'mark_on' end, v_diff,
          left(v_note || a.title, 120), coalesce(nullif(public.current_email(), ''), nullif(current_setting('hub.mark_by', true), ''), 'Home Hub'), a.id,
          nullif(v_bonus, 0));
end;
$$;

-- ---------------------------------------------------------------------
-- Paste grades (§40.2)
-- ---------------------------------------------------------------------
create function public.paste_grades(p_kid uuid, p_rows jsonb, p_apply boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.today_local();
  v_who   text := coalesce(nullif(public.current_email(), ''), 'Home Hub');
  v_out   jsonb := '[]'::jsonb;
  v_r     jsonb;
  v_i     int := 0;
  v_title text;
  v_class text;
  v_due   date;
  v_grade text;
  v_n     int;
  v_a     public.assignments;
  v_st    text;
  v_pts   int;
  v_before int;
begin
  if not (private.is_admin() or private.is_coach()) then
    raise exception 'Only a parent or the coach can paste grades.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.homework_kids k where k.kid_id = p_kid and k.active) then
    raise exception 'Homework isn''t on for that person.' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Paste the grade report first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 400 then
    raise exception 'That''s more than 400 grades. Paste one report at a time.' using errcode = '22023';
  end if;
  for v_r in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_title := regexp_replace(btrim(coalesce(v_r ->> 'title', '')), '\s+', ' ', 'g');
    v_class := regexp_replace(btrim(coalesce(v_r ->> 'class', '')), '\s+', ' ', 'g');
    v_grade := btrim(coalesce(v_r ->> 'grade', ''));
    begin
      v_due := (v_r ->> 'due')::date;
    exception when others then
      v_due := null;
    end;
    v_a := null;
    v_pts := null;
    if v_title = '' or v_due is null or v_grade = '' or char_length(v_grade) > 20 or v_grade ~ '[[:cntrl:]]'
       or char_length(v_title) > 200 or private.grade_number(v_grade) is null then
      v_st := 'bad';
    else
      -- His homework of that title (case and spaces ignored), that class or none, due within 7 days: the nearest.
      select count(*) into v_n
      from public.assignments a
      where a.kid_id = p_kid and a.kind = 'assignment' and a.status <> 'dropped'
        and lower(regexp_replace(btrim(a.title), '\s+', ' ', 'g')) = lower(v_title)
        and (a.subject is null or v_class = '' or lower(v_class) = lower(a.subject) or lower(v_class) like lower(a.subject) || ' %')
        and abs(a.due_date - v_due) <= 7;
      select a.* into v_a
      from public.assignments a
      where a.kid_id = p_kid and a.kind = 'assignment' and a.status <> 'dropped'
        and lower(regexp_replace(btrim(a.title), '\s+', ' ', 'g')) = lower(v_title)
        and (a.subject is null or v_class = '' or lower(v_class) = lower(a.subject) or lower(v_class) like lower(a.subject) || ' %')
        and abs(a.due_date - v_due) <= 7
      order by abs(a.due_date - v_due), a.due_date desc, a.id
      limit 1;
      if v_a.id is null then
        v_st := 'not_found';
      elsif v_n > 1 and exists (select 1 from public.assignments b
                                where b.kid_id = p_kid and b.id <> v_a.id and b.kind = 'assignment' and b.status <> 'dropped'
                                  and lower(regexp_replace(btrim(b.title), '\s+', ' ', 'g')) = lower(v_title)
                                  and abs(b.due_date - v_due) = abs(v_a.due_date - v_due)) then
        v_st := 'many';
      elsif v_a.due_date < v_today - 14 then
        v_st := 'older';
      elsif v_a.school_mark is not distinct from 'graded' and v_a.grade is not distinct from v_grade then
        v_st := 'same';
      else
        v_st := 'graded';
        if coalesce(p_apply, false) then
          select coalesce(sum(l.delta), 0)::int into v_before from public.points_ledger l
          where l.assignment_id = v_a.id and l.kind in ('mark_off', 'mark_on');
          update public.assignments a
          set school_mark = 'graded', grade = v_grade, updated_by = v_who
          where a.id = v_a.id;
          select coalesce(sum(l.delta), 0)::int - v_before into v_pts from public.points_ledger l
          where l.assignment_id = v_a.id and l.kind in ('mark_off', 'mark_on');
        end if;
      end if;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'i', v_i, 'status', v_st, 'assignment_id', v_a.id, 'title', coalesce(v_a.title, nullif(v_title, '')),
      'subject', coalesce(v_a.subject, nullif(v_class, '')), 'due', coalesce(v_a.due_date, v_due),
      'grade', nullif(v_grade, ''), 'was', case when v_a.school_mark = 'graded' then v_a.grade when v_a.school_mark = 'missing' then 'Missing' end,
      'points', v_pts)));
  end loop;
  return jsonb_build_object('rows', v_out, 'applied', coalesce(p_apply, false),
    'counts', (select jsonb_object_agg(s, n) from (select e ->> 'status' s, count(*) n from jsonb_array_elements(v_out) e group by 1) c));
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function public.paste_grades(uuid, jsonb, boolean) from public, anon, service_role;
grant  execute on function public.paste_grades(uuid, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Homework page shows Paste grades and the bonus limit only on 39. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 39;
$$;

commit;
