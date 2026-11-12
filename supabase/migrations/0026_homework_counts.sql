-- =====================================================================
-- HOME HUB v2 — migration 0026: a count on an assignment ("5 of 7 topics"), that the kid moves himself
-- Apply once, after 0025, and only once the site that understands it is live (docs/v1.3-homework.md §27).
--
-- Why
--   Some homework is a number of things to do, not a plan: 7 ALEKS topics, 20 IXL questions, 30 minutes of reading. The
--   hub knew only open or done, so "5 of the 7 are done" had nowhere to go, and a plan of seven one-line steps clutters
--   his day. Now an assignment can carry a count: a parent or the coach sets how many, he taps +1 on his My day as he
--   finishes each one, and when the count is reached the assignment is done.
--
-- What it adds
--   • Columns on public.assignments: count_goal (1 to 200, or null: no count) and count_done (0 to count_goal; 0 when
--     there is no count). Parents and the coach change them as they change the rest of an assignment (the table's
--     policies, unchanged; a column grant of update on the two).
--   • A trigger (assignments_count, before the tidy one): when an update brings count_done up to count_goal, an open
--     assignment is done; when one takes it back down from there, a done one is open again. An update that also
--     changes status (a parent's Mark done or Open again) is left as it says.
--   • count_by_token(p_token text, p_assignment uuid, p_from int, p_delta int) (a kid's My day): his +1 or −1 on one of
--     his own assignments with a count. p_from is the count his screen showed: when the count is no longer that (a
--     resend, or another tap first) nothing changes. Never below 0 or past the count. Written as "<his name> (My day)";
--     one of his homework writes (150 a day). Answers what assignment_by_token answers: his view.
--   • His view (private.homework_view_kid) gives each assignment with a count its count: {"goal": 7, "done": 5}.
--   • hub_schema_version() (26). The pages show counts only on 26.
--
-- Rules
--   • One transaction. It refuses to run without 0025, twice, on a database set back to 25 (the column already there),
--     or on one that isn't as 0025 left it.
--
-- Undo (not needed: with no counts set, every page is as on 25). If wanted, in one go:
--   drop function public.count_by_token(text, uuid, int, int);
--   drop function private.homework_view_kid(uuid, text);
--   alter function private.homework_view_kid_v25(uuid, text) rename to homework_view_kid;
--   drop trigger assignments_count on public.assignments;
--   drop function private.assignment_count_status();
--   alter table public.assignments drop column count_done, drop column count_goal;
--   then 0025's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;"). The counts
--   go with it; what they made done stays done.
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0025 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 25 then
    raise exception 'The Sunday sheets (migration 0025) aren''t installed (hub_schema_version() is %). Run 0025_weekly_sheets.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 26 then
    raise exception 'Homework counts (migration 0026) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'count_goal') then
    raise exception 'Homework counts (migration 0026) are already installed, but hub_schema_version() was set back to 25. To switch them on again, make hub_schema_version() return 26 (docs/v1.3-homework.md §27). Nothing was changed.';
  end if;
  -- What this migration reads and calls is as 0025 left it.
  if to_regclass('public.assignments') is null
     or to_regprocedure('public.weekly_sheet(uuid, date, text)') is null
     or to_regprocedure('private.homework_view_kid(uuid, text)') is null
     or to_regprocedure('private.homework_kid_by_token(text)') is null
     or to_regprocedure('private.count_homework(uuid, text, int)') is null
     or to_regprocedure('private.homework_trim(uuid)') is null
     or to_regprocedure('private.short_name(public.people)') is null
     or to_regprocedure('private.homework_view_kid_v25(uuid, text)') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'count_done')
     or exists (select 1 from pg_trigger t where t.tgrelid = 'public.assignments'::regclass and t.tgname = 'assignments_count') then
    raise exception 'This database isn''t as migration 0025 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The columns (§27)
-- ---------------------------------------------------------------------
alter table public.assignments
  add column count_goal int check (count_goal between 1 and 200),
  add column count_done int not null default 0 check (count_done >= 0),
  add constraint assignments_count_in_range check (count_done <= coalesce(count_goal, 0));

-- Parents and the coach change them (the table's policies decide who); the page sends both together.
grant update (count_goal, count_done) on public.assignments to authenticated;

-- ---------------------------------------------------------------------
-- Reaching the count is done; going back below it opens it again (§27)
-- ---------------------------------------------------------------------
-- Named to run before assignments_tidy (triggers run in name order), which then stamps done_at as for any done.
create function private.assignment_count_status()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_was boolean := old.count_goal is not null and old.count_done >= old.count_goal;
  v_is  boolean := new.count_goal is not null and new.count_done >= new.count_goal;
begin
  if new.status is distinct from old.status then
    return new;   -- a parent's Mark done, Open again or Drop says what it is
  end if;
  if v_is and not v_was and new.status = 'open' then
    new.status := 'done';
  elsif v_was and not v_is and new.status = 'done' and new.count_goal is not null and new.count_done < old.count_done then
    new.status := 'open';
  end if;
  return new;
end;
$$;

create trigger assignments_count before update of count_goal, count_done on public.assignments
  for each row execute function private.assignment_count_status();

-- ---------------------------------------------------------------------
-- His +1 and −1 (§27)
-- ---------------------------------------------------------------------
create function public.count_by_token(p_token text, p_assignment uuid, p_from int, p_delta int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me    public.people;
  v_a   public.assignments;
  v_who text;
  v_to  int;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if p_delta is null or p_delta not in (1, -1) or p_from is null or p_assignment is null then
    raise exception 'Choose +1 or −1.' using errcode = '22023';
  end if;
  select * into v_a from public.assignments a where a.id = p_assignment for update;
  if v_a.id is null or v_a.kid_id <> me.id then
    raise exception 'That assignment isn''t on your list.' using errcode = '42501';
  end if;
  if v_a.count_goal is null or v_a.status = 'dropped' then
    raise exception 'That one has no count.' using errcode = '22023';
  end if;
  v_who := private.short_name(me) || ' (My day)';
  v_to := p_from + p_delta;
  -- What his screen showed is still the count, and the new one is in range (else a resend, or a tap behind another one:
  -- nothing changes, and he gets his view as it is).
  if v_a.count_done = p_from and v_to between 0 and v_a.count_goal and (v_a.status = 'open' or p_delta < 0) then
    perform private.count_homework(me.id, 'writes', 150);
    update public.assignments a set count_done = v_to, updated_by = v_who where a.id = v_a.id;
  end if;
  perform private.homework_trim(me.id);
  return jsonb_build_object('assignment_id', v_a.id) || private.homework_view_kid(me.id, me.language);
exception
  -- A constraint's DETAIL is the whole row (a parent's email in it): never to a link (§3.4).
  when integrity_constraint_violation then
    raise exception 'That can''t be saved.' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------
-- His view: each assignment with a count says it (§27)
-- ---------------------------------------------------------------------
alter function private.homework_view_kid(uuid, text) rename to homework_view_kid_v25;

create function private.homework_view_kid(p_kid uuid, p_lang text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb := private.homework_view_kid_v25(p_kid, p_lang);
  c jsonb;
begin
  if v is null or jsonb_typeof(v -> 'assignments') is distinct from 'array' then
    return v;
  end if;
  select jsonb_object_agg(a.id::text, jsonb_build_object('goal', a.count_goal, 'done', a.count_done)) into c
  from public.assignments a
  where a.kid_id = p_kid and a.count_goal is not null;
  if c is null then
    return v;
  end if;
  return jsonb_set(v, '{assignments}',
                   (select coalesce(jsonb_agg(case when c ? (x ->> 'id') then x || jsonb_build_object('count', c -> (x ->> 'id')) else x end
                                              order by t.n), '[]')
                    from jsonb_array_elements(v -> 'assignments') with ordinality t (x, n)));
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.assignment_count_status()           from public, anon, authenticated;
revoke execute on function private.homework_view_kid(uuid, text)       from public, anon, authenticated;
revoke execute on function private.homework_view_kid_v25(uuid, text)   from public, anon, authenticated;
revoke execute on function public.count_by_token(text, uuid, int, int) from public, service_role;
grant  execute on function public.count_by_token(text, uuid, int, int) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages show counts only on 26. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 26;
$$;

commit;
