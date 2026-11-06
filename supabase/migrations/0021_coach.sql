-- =====================================================================
-- HOME HUB v1.3 — migration 0021: the coach (an adult who runs the kids' homework, rewards and routine)
-- Apply once, after 0020, and only once the site and hub-jobs that understand it are live (docs/v1.3-homework.md §25).
-- The contract is docs/v1.3-homework.md §25.
--
-- Why
--   Only the parents can change homework today. A trusted adult who signs in (a grandparent, an older cousin, the
--   coach) sees the Homework page read-only. This lets a parent tick one box on that adult's card on the Family page:
--   the adult then does on the Homework page what a parent does for the kids, and nothing else.
--
-- What it adds and changes
--   • Column: people.coach (false by default). It counts only for an active adult who can sign in.
--   • private.is_coach_email(p_email text): a parent who can sign in, or an active adult with coach on who can sign in.
--     private.is_coach(): is_coach_email of the caller. public.can_coach() (signed in): the same, for the pages and
--     hub-jobs.
--   • set_coach(p_person uuid, p_on boolean) (parents): the box on an adult's card.
--   • Ten functions that were the parents' own now take the coach too, each with only that one check changed (the
--     migration rewrites the check in place, with private.coach_rewrite(false), and refuses a body it doesn't expect):
--     save_homework_plan, homework_step, decide_reward, give_points, void_points, homework_ai_preview,
--     homework_ai_draft, school_item_action, save_routine, and hub-jobs' homework_ai_start (a signed-in coach may ask
--     the AI for a plan or a revision, never the parents' Test).
--   • give_points and save_routine get a wrapper each (the rewritten ones are kept as private.give_points_v20 and
--     private.save_routine_v20, for nobody): a coach gives at most 200 points a household week (Mon–Sun) to a kid
--     (P0001), and saves the routine only with its points as they are (42501). A parent is as before.
--   • The policies that let the parents add, change and remove assignments and rewards take the coach too.
--   • hub_schema_version() (21). The pages show the coach's buttons and the Family page's box only on 21.
--
-- What stays the parents' own
--   Family, Settings, the My day and board links, project guests, Hearth tags, tutor links (and their coach view and
--   rewards switches), the school links and Change dates, the AI planner's switch, its never-send words and Test,
--   homework on or off for a kid, points on or off, what each thing is worth and the caps, homework time, the
--   routine's points, and Erase. The AI runs and the tutor's notes stay the parents' to read.
--
-- Rules
--   • One transaction. It refuses to run without 0020, twice, on a database set back to 20, or on one that isn't as
--     0020 left it (a function above whose check isn't there exactly once).
--   • set search_path = '' on every function; revoke then grant. No new table.
--   • Additive: until a parent ticks the box nothing anywhere changes. A coach is a member: whoami() and
--     private.is_member() are unchanged, and a project guest is never a coach.
--
-- Undo (not needed: with the box off for everyone, as this leaves it, every answer is 20's). If wanted, in one go:
--   drop function public.give_points(uuid, int, text, uuid);
--   alter function private.give_points_v20(uuid, int, text, uuid) set schema public;
--   alter function public.give_points_v20(uuid, int, text, uuid) rename to give_points;
--   grant execute on function public.give_points(uuid, int, text, uuid) to authenticated;
--   drop function public.save_routine(uuid, jsonb, int);
--   alter function private.save_routine_v20(uuid, jsonb, int) set schema public;
--   alter function public.save_routine_v20(uuid, jsonb, int) rename to save_routine;
--   grant execute on function public.save_routine(uuid, jsonb, int) to authenticated;
--   do $$ begin perform private.coach_rewrite(true); end $$;
--   alter policy "Parents add assignments" on public.assignments with check (private.is_admin());
--   alter policy "Parents change assignments" on public.assignments using (private.is_admin()) with check (private.is_admin());
--   alter policy "Parents remove assignments" on public.assignments using (private.is_admin());
--   alter policy "Parents add rewards" on public.rewards with check (private.is_admin());
--   alter policy "Parents change rewards" on public.rewards using (private.is_admin()) with check (private.is_admin());
--   alter policy "Parents remove rewards" on public.rewards using (private.is_admin());
--   drop function private.coach_rewrite(boolean);
--   drop function public.set_coach(uuid, boolean);
--   drop function public.can_coach();
--   drop function private.is_coach();
--   drop function private.is_coach_email(text);
--   alter table public.people drop column coach;
--   then 0020's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;"). What a
--   coach did stays, as anyone's change does.
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0020 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 20 then
    raise exception 'The family board (migration 0020) isn''t installed (hub_schema_version() is %). Run 0020_family_board.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 21 then
    raise exception 'The coach (migration 0021) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'people' and column_name = 'coach') then
    raise exception 'The coach (migration 0021) is already installed, but hub_schema_version() was set back to 20. To switch it on again, make hub_schema_version() return 21 (docs/v1.3-homework.md §25). Nothing was changed.';
  end if;
  -- What this migration reads, wraps and rewrites is as 0020 left it (coach_rewrite checks each body too).
  if to_regclass('public.family_board') is null
     or to_regprocedure('private.monday(date)') is null
     or to_regprocedure('public.today_local()') is null
     or (select count(*) from pg_policies p where p.schemaname = 'public'
         and ((p.tablename = 'assignments' and p.policyname in ('Parents add assignments', 'Parents change assignments', 'Parents remove assignments'))
           or (p.tablename = 'rewards' and p.policyname in ('Parents add rewards', 'Parents change rewards', 'Parents remove rewards')))) <> 6 then
    raise exception 'This database isn''t as migration 0020 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Who is the coach (§25.2)
-- ---------------------------------------------------------------------
-- The box on an adult's card. It counts only while that person is an active adult who can sign in.
alter table public.people add column coach boolean not null default false;

-- A parent who can sign in, or an active adult with the box ticked who can sign in.
create function private.is_coach_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.members m where m.email = lower(p_email) and m.role = 'admin')
      or exists (select 1 from public.members m join public.people p on p.email = m.email
                 where m.email = lower(p_email) and p.role = 'adult' and p.active and p.coach);
$$;

-- The caller (the policies and the homework functions ask this).
create function private.is_coach()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_coach_email(public.current_email());
$$;

-- For the pages (the coach's buttons) and hub-jobs (the AI planner, after whoami).
create function public.can_coach()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.is_coach();
$$;

-- The box on an adult's card (parents). On needs an active adult who can sign in; off always works.
create function public.set_coach(p_person uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.people;
begin
  if not private.is_admin() then
    raise exception 'Only an admin can change the family list.' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  select * into v_p from public.people p where p.id = p_person for update;
  if v_p.id is null then
    raise exception 'That person is gone.' using errcode = '22023';
  end if;
  if p_on and (v_p.role <> 'adult' or not v_p.active) then
    raise exception 'Only an adult on the family list can manage the kids'' homework.' using errcode = '22023';
  end if;
  if p_on and not exists (select 1 from public.members m where m.email = v_p.email) then
    raise exception 'Tick Can sign in first.' using errcode = '22023';
  end if;
  update public.people set coach = p_on where id = p_person and coach is distinct from p_on;
end;
$$;

-- ---------------------------------------------------------------------
-- The parents' homework functions take the coach too (§25.3)
-- ---------------------------------------------------------------------
-- Rewrites one check in each body, in place, and nothing else: the parents' check becomes the coach's (p_undo false),
-- or back (p_undo true, the undo). Each body must hold what it replaces exactly once, or nothing changes.
create function private.coach_rewrite(p_undo boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t      record;
  v_src  text;
  v_from text;
  v_to   text;
begin
  for t in
    select * from (values
      ('public.save_homework_plan(uuid, jsonb, int, boolean)', 'private.is_admin()', 'private.is_coach()'),
      ('public.homework_step(uuid, text, text)', 'private.is_admin()', 'private.is_coach()'),
      ('public.decide_reward(uuid, boolean, text)', 'private.is_admin()', 'private.is_coach()'),
      ('public.give_points(uuid, int, text, uuid)', 'private.is_admin()', 'private.is_coach()'),
      ('public.void_points(uuid, text)', 'private.is_admin()', 'private.is_coach()'),
      ('public.homework_ai_preview(uuid, text, text, text[])', 'private.is_admin()', 'private.is_coach()'),
      ('public.homework_ai_draft(uuid, text)', 'private.is_admin()', 'private.is_coach()'),
      ('public.school_item_action(uuid, text, date)', 'private.is_admin()', 'private.is_coach()'),
      ('public.save_routine(uuid, jsonb, int)', 'private.is_admin()', 'private.is_coach()'),
      ('public.homework_ai_start(text, text, uuid, text, text, text[], uuid)', 'and m.role = ''admin'') then',
       'and (m.role = ''admin'' or (p_kind <> ''test'' and private.is_coach_email(m.email)))) then')
    ) v (fn, before, after)
  loop
    v_from := case when p_undo then t.after else t.before end;
    v_to := case when p_undo then t.before else t.after end;
    if to_regprocedure(t.fn) is null then
      raise exception 'This database isn''t as migration 0020 left it. Nothing was changed.';
    end if;
    v_src := pg_get_functiondef(to_regprocedure(t.fn));
    if (char_length(v_src) - char_length(replace(v_src, v_from, ''))) / char_length(v_from) <> 1
       or (not p_undo and strpos(v_src, 'is_coach') > 0) then
      raise exception 'This database isn''t as migration 0020 left it. Nothing was changed.';
    end if;
    execute replace(v_src, v_from, v_to);
  end loop;
end;
$$;

do $$ begin perform private.coach_rewrite(false); end $$;

-- The coach's limits, around the rewritten functions (kept as private.*_v20, for nobody).
alter function public.give_points(uuid, int, text, uuid) rename to give_points_v20;
alter function public.give_points_v20(uuid, int, text, uuid) set schema private;
alter function public.save_routine(uuid, jsonb, int) rename to save_routine_v20;
alter function public.save_routine_v20(uuid, jsonb, int) set schema private;

-- Points given (as before), and for a coach at most 200 a household week (Mon–Sun) to a kid. A resent key is
-- answered as it was, whatever the week's total.
create function public.give_points(p_kid uuid, p_points int, p_note text, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mon  date := private.monday(public.today_local());
  v_used int;
begin
  if not private.is_coach() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if not private.is_admin() and p_key is not null and p_points between 1 and 200
     and not exists (select 1 from public.points_ledger l where l.id = p_key) then
    perform 1 from public.homework_kids k where k.kid_id = p_kid for update;
    select coalesce(sum(l.delta), 0) into v_used
    from public.points_ledger l
    where l.kid_id = p_kid and l.kind = 'given' and l.who = public.current_email() and l.day between v_mon and v_mon + 6;
    if v_used + p_points > 200 then
      raise exception 'That''s more than 200 points this week from you. A parent can give more.' using errcode = 'P0001';
    end if;
  end if;
  return private.give_points_v20(p_kid, p_points, p_note, p_key);
end;
$$;

-- The routine (as before); a coach saves it only with its points as they are.
create function public.save_routine(p_kid uuid, p_sections jsonb, p_points int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_coach() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if not private.is_admin()
     and p_points is distinct from coalesce((select k.routine_points from public.homework_kids k where k.kid_id = p_kid), 0) then
    raise exception 'Only a parent can change the routine''s points.' using errcode = '42501';
  end if;
  return private.save_routine_v20(p_kid, p_sections, p_points);
end;
$$;

-- Assignments and rewards: the coach adds, changes and removes them as the parents do.
alter policy "Parents add assignments" on public.assignments with check (private.is_coach());
alter policy "Parents change assignments" on public.assignments using (private.is_coach()) with check (private.is_coach());
alter policy "Parents remove assignments" on public.assignments using (private.is_coach());
alter policy "Parents add rewards" on public.rewards with check (private.is_coach());
alter policy "Parents change rewards" on public.rewards using (private.is_coach()) with check (private.is_coach());
alter policy "Parents remove rewards" on public.rewards using (private.is_coach());

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages offer the coach only on 21. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 21;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------
-- The policies ask is_coach as the signed-in caller.
revoke execute on function private.is_coach()                                    from public, anon;
grant  execute on function private.is_coach()                                    to authenticated;
revoke execute on function private.is_coach_email(text)                          from public, anon, authenticated;
revoke execute on function private.coach_rewrite(boolean)                        from public, anon, authenticated, service_role;
-- The pages and hub-jobs (with the caller's sign-in).
revoke execute on function public.can_coach()                                    from public, anon, service_role;
grant  execute on function public.can_coach()                                    to authenticated;
-- The Family page (parents).
revoke execute on function public.set_coach(uuid, boolean)                       from public, anon, service_role;
grant  execute on function public.set_coach(uuid, boolean)                       to authenticated;
-- The wrappers, as the functions they wrap.
revoke execute on function public.give_points(uuid, int, text, uuid)             from public, anon, service_role;
grant  execute on function public.give_points(uuid, int, text, uuid)             to authenticated;
revoke execute on function public.save_routine(uuid, jsonb, int)                 from public, anon, service_role;
grant  execute on function public.save_routine(uuid, jsonb, int)                 to authenticated;
-- The wrapped ones: nobody but the wrappers.
revoke execute on function private.give_points_v20(uuid, int, text, uuid)        from public, anon, authenticated, service_role;
revoke execute on function private.save_routine_v20(uuid, jsonb, int)            from public, anon, authenticated, service_role;

commit;
