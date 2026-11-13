-- =====================================================================
-- HOME HUB v2 — migration 0028: Take points, the other side of Give points
-- Apply once, after 0027, and only once the site that understands it is live (docs/v1.3-homework.md §28).
--
-- Why
--   A parent can give a kid points for what the rules can't see, and Void an entry that was wrong, but had no way to
--   take points off for something he did: a parent asked for one. Take points is Give points the other way round, with
--   a reason he sees.
--
-- What it adds
--   • A ledger kind, 'taken': points_ledger rows with a negative delta and the reason as the note. The kind check gains
--     it, and the sign check (points_ledger_check: only 'void' and 'trade' were negative) now reads 'void', 'trade' and
--     'taken'.
--   • take_points(p_kid uuid, p_points int, p_note text, p_key uuid) (signed in; a definer): a parent or the coach
--     takes 1 to 200 points, with a reason (1 to 120 characters) he sees on his My day. Never below zero: only his free
--     points (his balance less what his waiting asks hold) can be taken; more is refused and says how many are free.
--     A coach takes at most 200 points a household week (Mon–Sun) from a kid, as a coach gives at most 200 (§25). p_key
--     is the ledger row's id: a resend writes nothing more. Refused while points are off.
--   • hub_schema_version() (28). The Homework page shows Take points only on 28.
--
-- Rules
--   • One transaction. It refuses to run without 0027, twice, on a database set back to 27 (the function already
--     there), or on one that isn't as 0027 left it.
--
-- Undo (not needed: with nothing taken, every page is as on 27). If wanted, in one go (any points taken go with it):
--   drop function public.take_points(uuid, int, text, uuid);
--   delete from public.points_ledger where kind = 'taken';
--   alter table public.points_ledger drop constraint points_ledger_check;
--   alter table public.points_ledger add constraint points_ledger_check check ((kind in ('void', 'trade')) = (delta < 0));
--   alter table public.points_ledger drop constraint points_ledger_kind_check;
--   alter table public.points_ledger add constraint points_ledger_kind_check check (kind in ('focus', 'on_time', 'milestone_done', 'milestone', 'given', 'void', 'trade', 'routine'));
--   then 0027's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0027 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 27 then
    raise exception 'Tasks on the calendar (migration 0027) aren''t installed (hub_schema_version() is %). Run 0027_task_calendar.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 28 then
    raise exception 'Take points (migration 0028) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regprocedure('public.take_points(uuid, int, text, uuid)') is not null then
    raise exception 'Take points (migration 0028) is already installed, but hub_schema_version() was set back to 27. To switch it on again, make hub_schema_version() return 28 (docs/v1.3-homework.md §28). Nothing was changed.';
  end if;
  -- What this migration changes and calls is as 0027 left it.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'on_calendar')
     or to_regprocedure('private.is_coach()') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('private.points_balance(uuid)') is null
     or to_regprocedure('private.monday(date)') is null
     or to_regprocedure('private.clean_text(text, int)') is null
     or (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.points_ledger'::regclass and c.conname = 'points_ledger_check')
        is distinct from 'CHECK (((kind = ANY (ARRAY[''void''::text, ''trade''::text])) = (delta < 0)))'
     or (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.points_ledger'::regclass and c.conname = 'points_ledger_kind_check')
        is distinct from 'CHECK ((kind = ANY (ARRAY[''focus''::text, ''on_time''::text, ''milestone_done''::text, ''milestone''::text, ''given''::text, ''void''::text, ''trade''::text, ''routine''::text])))' then
    raise exception 'This database isn''t as migration 0027 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The ledger: 'taken', negative (§28)
-- ---------------------------------------------------------------------
alter table public.points_ledger drop constraint points_ledger_kind_check;
alter table public.points_ledger add constraint points_ledger_kind_check
  check (kind in ('focus', 'on_time', 'milestone_done', 'milestone', 'given', 'void', 'trade', 'routine', 'taken'));
alter table public.points_ledger drop constraint points_ledger_check;
alter table public.points_ledger add constraint points_ledger_check check ((kind in ('void', 'trade', 'taken')) = (delta < 0));

-- ---------------------------------------------------------------------
-- Take points (§28)
-- ---------------------------------------------------------------------
create function public.take_points(p_kid uuid, p_points int, p_note text, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l    public.points_ledger;
  v_note text := nullif(private.clean_text(p_note, 120), '');
  v_mon  date := private.monday(public.today_local());
  v_free int;
  v_used int;
begin
  if not private.is_coach() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_points is null or p_points not between 1 and 200 then
    raise exception 'Take 1 to 200 points.' using errcode = '22023';
  end if;
  if char_length(p_note) > 120 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if v_note is null then
    raise exception 'Say why the points come off.' using errcode = '22023';
  end if;
  if p_key is null then
    raise exception 'Points need their id.' using errcode = '22023';
  end if;
  select * into v_l from public.points_ledger l where l.id = p_key;
  if v_l.id is not null and (v_l.kid_id <> p_kid or v_l.kind <> 'taken') then
    raise exception 'That id is taken.' using errcode = '22023';
  end if;
  if v_l.id is null then
    if not exists (select 1 from public.homework_kids k where k.kid_id = p_kid and k.points_on) then
      raise exception 'Points are off.' using errcode = '42501';
    end if;
    perform 1 from public.homework_kids k where k.kid_id = p_kid for update;
    -- Never below zero, and never what his waiting asks hold.
    select b.balance - b.held into v_free from private.points_balance(p_kid) b;
    if v_free <= 0 then
      raise exception 'There are no free points to take.' using errcode = 'P0001';
    end if;
    if p_points > v_free then
      raise exception 'Only % points are free to take (the rest are spent or held for a reward he asked for).', v_free using errcode = 'P0001';
    end if;
    if not private.is_admin() then
      select coalesce(-sum(l.delta), 0) into v_used
      from public.points_ledger l
      where l.kid_id = p_kid and l.kind = 'taken' and l.who = public.current_email() and l.day between v_mon and v_mon + 6;
      if v_used + p_points > 200 then
        raise exception 'That''s more than 200 points this week from you. A parent can take more.' using errcode = 'P0001';
      end if;
    end if;
    insert into public.points_ledger (id, kid_id, at, day, kind, delta, note, who)
    values (p_key, p_kid, private.now(), public.today_local(), 'taken', -p_points, v_note, public.current_email())
    on conflict (id) do nothing;
  end if;
  select * into v_l from public.points_ledger l where l.id = p_key;
  return jsonb_build_object('entry', jsonb_build_object('id', v_l.id, 'delta', v_l.delta, 'note', v_l.note),
                            'balance', (select b.balance from private.points_balance(p_kid) b));
exception
  -- A constraint's DETAIL is the whole row (an email in it): never to the page as it is.
  when integrity_constraint_violation then
    raise exception 'That can''t be saved.' using errcode = '22023';
end;
$$;

revoke execute on function public.take_points(uuid, int, text, uuid) from public, anon, service_role;
grant  execute on function public.take_points(uuid, int, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Homework page shows Take points only on 28. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 28;
$$;

commit;
