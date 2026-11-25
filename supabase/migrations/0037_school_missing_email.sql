-- =====================================================================
-- HOME HUB v2 — migration 0037: the school's missing-assignment emails mark the work Missing
-- Apply once, after 0036, and only once the hub-jobs that understands it is live (docs/v1.3-homework.md §37.4).
-- The pages and cron.sql don't change.
-- The contract is docs/v1.3-homework.md §37; the database side is docs/v2-design.md §43.
--
-- Why
--   The school's portal emails a parent when a teacher marks work missing. A parent forwards those emails (an Outlook
--   or Gmail rule) to the hub's inbox; hub-jobs reads the notice (school_mail.ts: the title, the class and the due
--   date, no AI) and calls school_missing_by_email, which finds the assignment and marks it Missing, so the points
--   follow (0036) within a minute, with no one typing it.
--
-- What it adds
--   • public.school_missing_by_email(p_title text, p_class text, p_due date, p_by text) returns jsonb, for
--     service_role only (hub-jobs' inbox). It looks, among the kids with homework on, for the assignment with that
--     title, that class (without its section: "Science 6 - A" is "Science 6") and a due date within 14 days of p_due;
--     then for an item from school not yet made one; else, with one kid only, adds it as his homework. Then it marks it
--     Missing (once: marked already answers 'already').
--   • private.mark_points: 0036's, with the mark's line written as p_by ("Pat (email)") when no one is signed in.
--   • hub_schema_version() (37). hub-jobs reads the notices only on 37.
--
-- Rules
--   • One transaction. It refuses to run without 0036, twice, on a database set back to 36 (the function already
--     there), or on one that isn't as 0036 left it.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: with no notice forwarded, nothing happens). If wanted, in one go:
--   drop function public.school_missing_by_email(text, text, date, text);
--   then 0036's private.mark_points ("create function private.mark_points", to its "$$;", as create or replace) and
--   0036's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0036 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 36 then
    raise exception 'Points from the school''s marks (migration 0036) aren''t installed (hub_schema_version() is %). Run 0036_school_mark_points.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 37 then
    raise exception 'The school''s missing-assignment emails (migration 0037) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regprocedure('public.school_missing_by_email(text, text, date, text)') is not null then
    raise exception 'The school''s missing-assignment emails (migration 0037) are already installed, but hub_schema_version() was set back to 36. To switch them on again, make hub_schema_version() return 37 (docs/v1.3-homework.md §37). Nothing was changed.';
  end if;
  -- What this migration reads, calls and replaces is as 0036 left it.
  if to_regprocedure('private.mark_points(uuid)') is null
     or to_regprocedure('private.school_assignment(uuid, text, date)') is null
     or to_regclass('public.school_items') is null
     or to_regclass('public.school_feeds') is null
     or not exists (select 1 from pg_trigger t where t.tgname = 'assignments_mark_points' and t.tgrelid = 'public.assignments'::regclass) then
    raise exception 'This database isn''t as migration 0036 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Who a mark's line is from (§37.3)
-- ---------------------------------------------------------------------
-- 0036's, with one change: when no one is signed in (hub-jobs), the line is written as hub.mark_by, which
-- school_missing_by_email sets for its own transaction.
create or replace function private.mark_points(p_assignment uuid)
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
          left(v_note || a.title, 120), coalesce(nullif(public.current_email(), ''), nullif(current_setting('hub.mark_by', true), ''), 'Home Hub'), a.id);
end;
$$;

-- ---------------------------------------------------------------------
-- The notice (§37.2)
-- ---------------------------------------------------------------------
-- The assignment a missing-assignment email names, marked Missing. Answers {status, kid, title, subject, due,
-- assignment_id, points}: status 'marked', 'added' (it wasn't on the hub: added as his homework, then marked),
-- 'already' (marked Missing before: nothing changed), 'no_kid' (no kid has homework on) or 'many' (several kids,
-- and none has it: whose can't be told). points: what the mark moved (0 when his points are off or the week's limit
-- is reached).
create function public.school_missing_by_email(p_title text, p_class text, p_due date, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title  text := btrim(coalesce(p_title, ''));
  v_class  text := btrim(regexp_replace(coalesce(p_class, ''), '\s+-\s+[A-Za-z0-9]{1,3}$', ''));
  v_by     text := left(coalesce(nullif(btrim(p_by), ''), 'Home Hub'), 60);
  v_kids   uuid[];
  v_a      public.assignments;
  v_item   uuid;
  v_status text := 'marked';
  v_before int;
  v_after  int;
begin
  if v_title = '' or char_length(v_title) > 120 or p_due is null then
    raise exception 'That needs the title and the due date.' using errcode = '22023';
  end if;
  select coalesce(array_agg(k.kid_id order by p.sort_order, p.name), '{}') into v_kids
  from public.homework_kids k join public.people p on p.id = k.kid_id
  where k.active and p.active;
  if cardinality(v_kids) = 0 then
    return jsonb_build_object('status', 'no_kid');
  end if;
  -- 1. His assignment: the same title and class, due within 14 days of the notice's date.
  select a.* into v_a from public.assignments a
  where a.kid_id = any (v_kids) and a.kind = 'assignment'
    and lower(btrim(a.title)) = lower(v_title)
    and (a.subject is null or v_class = '' or lower(btrim(a.subject)) = lower(v_class))
    and abs(a.due_date - p_due) <= 14
  order by (lower(btrim(coalesce(a.subject, ''))) = lower(v_class)) desc, abs(a.due_date - p_due), a.created_at desc
  limit 1;
  -- 2. An item from school not made one yet: made one now.
  if v_a.id is null then
    select i.id into v_item from public.school_items i join public.school_feeds f on f.id = i.feed_id
    where f.kid_id = any (v_kids) and i.made_at is null and i.due_date is not null
      and lower(btrim(i.title)) = lower(v_title)
      and (i.subject is null or v_class = '' or lower(btrim(i.subject)) = lower(v_class))
      and abs(i.due_date - p_due) <= 14
    order by abs(i.due_date - p_due) limit 1;
    if v_item is not null then
      select a.* into v_a from public.assignments a where a.id = private.school_assignment(v_item, v_by, null);
      v_status := 'added';
    end if;
  end if;
  -- 3. Not on the hub at all: with one kid, his homework now.
  if v_a.id is null then
    if cardinality(v_kids) > 1 then
      return jsonb_build_object('status', 'many');
    end if;
    insert into public.assignments (kid_id, kind, added_by, title, subject, due_date, created_by, updated_by)
    values (v_kids[1], 'assignment', 'school', v_title, nullif(left(v_class, 40), ''), p_due, v_by, v_by)
    returning * into v_a;
    v_status := 'added';
  end if;
  if v_a.school_mark = 'missing' then
    v_status := 'already';
  else
    select coalesce(sum(l.delta), 0)::int into v_before from public.points_ledger l where l.assignment_id = v_a.id and l.kind in ('mark_off', 'mark_on');
    perform set_config('hub.mark_by', v_by, true);
    update public.assignments a set school_mark = 'missing', grade = null, updated_by = v_by where a.id = v_a.id;
    perform set_config('hub.mark_by', '', true);
  end if;
  select coalesce(sum(l.delta), 0)::int into v_after from public.points_ledger l where l.assignment_id = v_a.id and l.kind in ('mark_off', 'mark_on');
  return jsonb_build_object(
    'status', v_status,
    'kid', (select split_part(p.name, ' ', 1) from public.people p where p.id = v_a.kid_id),
    'title', v_a.title, 'subject', v_a.subject, 'due', v_a.due_date, 'assignment_id', v_a.id,
    'points', case when v_status = 'already' then 0 else v_after - coalesce(v_before, 0) end);
end;
$$;

revoke execute on function public.school_missing_by_email(text, text, date, text) from public, anon, authenticated;
grant  execute on function public.school_missing_by_email(text, text, date, text) to service_role;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- hub-jobs reads the notices only on 37. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 37;
$$;

commit;
