-- =====================================================================
-- HOME HUB v2 — migration 0038: study before tests (a test without a plan gets the starter test plan's study steps)
-- Apply once, after 0037, and only once the site that understands it is live (docs/v1.3-homework.md §38.4).
-- No Edge Function and no cron.sql change: the hourly school read already calls private.school_apply.
-- The contract is docs/v1.3-homework.md §38; the database side is docs/v2-design.md §44.
--
-- Why
--   The hub knew which assignments were tests (0032's is_test) and had a starter test plan on the Homework page (§4.6),
--   but nothing used it unless someone opened the test and planned it by hand. Most tests went on his list with no
--   study steps at all, or only "Take the test". A parent asked for study steps to appear on his days before each test.
--
-- What it adds
--   • homework_kids.test_prep_days (0 to 7, 0 = off): a parent sets how many days before a test the study starts.
--   • assignments.test_prep_at: when the study steps were put on this test. Set once; never again for that test, so a
--     parent who deletes them isn't overruled an hour later.
--   • private.test_prep(p_kid): for each of his open tests (is_test) with no plan of its own (no step other than a
--     turn-in, nothing done) and no test_prep_at, puts the starter test plan's five study steps (list the topics, a
--     study list, practice the first half, practice the second half (a milestone), quiz yourself) on the days from
--     test_prep_days before the due date to the day before it, never before today (tomorrow from 18:00 local), each
--     cut to his first focus length; keeps a turn-in already there, else adds the starter's ("Pack what you need") on
--     the due date; gives the plan to his My day. In his language (English or Spanish). Answers how many tests it planned.
--   • private.school_apply(p_feed) now plans his tests after the read (0030's body moved to private.school_apply_v37,
--     unchanged), so a new test from school gets its steps within the hour, and so does one added by hand.
--   • A trigger on homework_kids: setting test_prep_days above 0 plans his waiting tests at once.
--   • hub_schema_version() (38). The Homework page shows the setting only on 38.
--
-- Rules
--   • One transaction. It refuses to run without 0037, twice, on a database set back to 37 (the column already there),
--     or on one that isn't as 0037 left it.
--   • Additive: off for every kid (test_prep_days 0), so nothing is planned until a parent sets it.
--   • Never touches a plan someone wrote (any step besides the turn-in, or any step done), a test already due, a test
--     whose days are all past, a lesson, or a kid whose homework is off.
--   • The steps are ordinary steps (source 'template'): his ticks, the points (a milestone's half and half), Not
--     today, the Due tomorrow email and the reminders treat them as any other.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: set test_prep_days to 0 and nothing more is planned; steps already put on stay, as any plan). If
-- wanted, in one go:
--   drop trigger homework_kids_test_prep on public.homework_kids;
--   drop function private.homework_kids_test_prep();
--   drop function private.school_apply(uuid);
--   alter function private.school_apply_v37(uuid) rename to school_apply;
--   drop function private.test_prep(uuid);
--   alter table public.assignments drop column test_prep_at;
--   alter table public.homework_kids drop column test_prep_days;
--   then 0037's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0037 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 37 then
    raise exception 'The school''s missing-assignment emails (migration 0037) aren''t installed (hub_schema_version() is %). Run 0037_school_missing_email.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 38 then
    raise exception 'Study before tests (migration 0038) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.homework_kids'::regclass and a.attname = 'test_prep_days' and not a.attisdropped) then
    raise exception 'Study before tests (migration 0038) is already installed, but hub_schema_version() was set back to 37. To switch it on again, make hub_schema_version() return 38 (docs/v1.3-homework.md §38). Nothing was changed.';
  end if;
  -- What this migration reads and changes is as 0037 left it.
  if to_regprocedure('private.school_apply(uuid)') is null
     or to_regprocedure('private.school_apply_v29(uuid)') is null
     or to_regprocedure('private.school_apply_v37(uuid)') is not null
     or to_regprocedure('private.test_prep(uuid)') is not null
     or to_regprocedure('public.school_missing_by_email(text, text, date, text)') is null
     or to_regprocedure('private.now()') is null
     or to_regprocedure('private.tz()') is null
     or to_regprocedure('public.today_local()') is null
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.assignments'::regclass and a.attname = 'is_test' and not a.attisdropped)
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.assignments'::regclass and a.attname = 'test_prep_at' and not a.attisdropped)
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.people'::regclass and a.attname = 'language' and not a.attisdropped) then
    raise exception 'This database isn''t as migration 0037 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The setting and the mark (§38.2)
-- ---------------------------------------------------------------------
alter table public.homework_kids add column test_prep_days int not null default 0 check (test_prep_days between 0 and 7);
grant update (test_prep_days) on public.homework_kids to authenticated;
alter table public.assignments add column test_prep_at timestamptz;   -- the study steps were put on then; never again

-- ---------------------------------------------------------------------
-- Planning his tests (§38.3)
-- ---------------------------------------------------------------------
create function private.test_prep(p_kid uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_k     public.homework_kids;
  v_es    boolean;
  v_now   timestamptz := private.now();
  v_today date := public.today_local();
  v_late  boolean := extract(hour from private.now() at time zone private.tz()) >= 18;
  v_who   constant text := 'Home Hub';
  v_a     public.assignments;
  v_first date;
  v_last  date;
  v_days  int;
  v_len   int;
  v_n     int := 0;
  v_turn  uuid;
  v_i     int;
  v_steps jsonb;
  v_s     jsonb;
begin
  select * into v_k from public.homework_kids k where k.kid_id = p_kid;
  if v_k.kid_id is null or not v_k.active or v_k.test_prep_days < 1 then
    return 0;
  end if;
  v_es := coalesce((select p.language from public.people p where p.id = p_kid), 'en') = 'es';
  v_len := greatest(v_k.focus_minutes, 5);
  -- The starter test plan's study steps (assets/plan.js PLANS.test, without its turn-in): kind, minutes, title, done looks like.
  v_steps := case when v_es then jsonb_build_array(
      jsonb_build_array('start', 10, 'Apunta lo que entra en el examen', 'una lista de temas'),
      jsonb_build_array('step', 20, 'Haz una lista para estudiar', 'los temas en orden, el más difícil primero'),
      jsonb_build_array('step', 25, 'Practica la primera mitad de los temas', 'preguntas de práctica hechas y corregidas'),
      jsonb_build_array('milestone', 25, 'Practica la segunda mitad', 'preguntas de práctica hechas y corregidas'),
      jsonb_build_array('check', 20, 'Ponte a prueba', 'una autoevaluación con los fallos marcados'))
    else jsonb_build_array(
      jsonb_build_array('start', 10, 'List what the test covers', 'a list of topics'),
      jsonb_build_array('step', 20, 'Make a study list', 'the topics in order, hardest first'),
      jsonb_build_array('step', 25, 'Practice the first half of the topics', 'practice questions done and checked'),
      jsonb_build_array('milestone', 25, 'Practice the second half', 'practice questions done and checked'),
      jsonb_build_array('check', 20, 'Quiz yourself', 'a self-quiz with the misses marked')) end;

  for v_a in
    select a.* from public.assignments a
    where a.kid_id = p_kid and a.kind = 'assignment' and a.status = 'open' and a.is_test
      and a.test_prep_at is null and a.due_date > v_today
      and not exists (select 1 from public.homework_steps s
                      where s.assignment_id = a.id and (s.kind <> 'turn_in' or s.done_at is not null))
    order by a.due_date, a.id
    for update of a
  loop
    v_first := greatest(v_today + case when v_late then 1 else 0 end, v_a.due_date - v_k.test_prep_days);
    v_last := v_a.due_date - 1;
    continue when v_first > v_last;
    v_days := v_last - v_first + 1;
    -- The turn-in already there (kept, moved last), else the starter's on the due date.
    select s.id into v_turn from public.homework_steps s where s.assignment_id = v_a.id order by s.pos, s.id limit 1;
    delete from public.homework_steps s where s.assignment_id = v_a.id and s.id is distinct from v_turn;
    for v_i in 0 .. 4 loop
      v_s := v_steps -> v_i;
      insert into public.homework_steps (assignment_id, pos, kind, title, done_looks_like, minutes, day, source, updated_by)
      values (v_a.id, v_i + 1, v_s ->> 0, v_s ->> 2, v_s ->> 3, least((v_s ->> 1)::int, v_len),
              v_first + (v_i * v_days / 5), 'template', v_who);
    end loop;
    if v_turn is null then
      insert into public.homework_steps (assignment_id, pos, kind, title, done_looks_like, minutes, day, source, updated_by)
      values (v_a.id, 6, 'turn_in',
              case when v_es then 'Prepara lo que necesitas' else 'Pack what you need' end,
              case when v_es then 'la mochila lista' else 'bag packed' end,
              5, v_a.due_date, 'template', v_who);
    else
      update public.homework_steps s set pos = 6, updated_at = v_now, updated_by = v_who where s.id = v_turn;
    end if;
    update public.assignments a
    set test_prep_at = v_now, plan_rev = a.plan_rev + 1,
        given_at = coalesce(a.given_at, v_now), given_by = coalesce(a.given_by, v_who),
        updated_by = v_who
    where a.id = v_a.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- The hourly read plans his tests after applying what came in (0030's school_apply moved, unchanged).
alter function private.school_apply(uuid) rename to school_apply_v37;
create function private.school_apply(p_feed uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  v_n := private.school_apply_v37(p_feed);
  perform private.test_prep(f.kid_id) from public.school_feeds f where f.id = p_feed;
  return v_n;
end;
$$;

-- A parent sets the days: his waiting tests are planned at once.
create function private.homework_kids_test_prep()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.test_prep_days > 0 and new.test_prep_days is distinct from old.test_prep_days then
    perform private.test_prep(new.kid_id);
  end if;
  return null;
end;
$$;
create trigger homework_kids_test_prep after update of test_prep_days on public.homework_kids
  for each row execute function private.homework_kids_test_prep();

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.test_prep(uuid)                from public, anon, authenticated;
revoke execute on function private.school_apply(uuid)             from public, anon, authenticated;
revoke execute on function private.homework_kids_test_prep()      from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Homework page shows the setting only on 38. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 38;
$$;

commit;
