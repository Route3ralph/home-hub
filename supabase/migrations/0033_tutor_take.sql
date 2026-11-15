-- =====================================================================
-- HOME HUB v2 — migration 0033: Take points on the tutor link (a tutor whose link runs his rewards takes points off)
-- Apply once, after 0032, and only once the site that understands it is live (docs/v1.3-homework.md §33.3).
-- No Edge Function and cron.sql don't change.
-- The contract is docs/v1.3-homework.md §33; the database side is docs/v2-design.md §39.
--
-- Why
--   A tutor link that runs his rewards (0012) can give points and void a line it gave or he earned, but can't take
--   points off for what he did: Void takes back exactly one line. A parent and the coach can (0028, take_points).
--
-- What it adds
--   • public.coach_reward_by_token takes one more action, 'take' ({points, note}): 1 to 200 points off his balance,
--     with the reason he sees, as a 'taken' line written "<link label> (tutor link)", as the link's other changes.
--     Never more than his free points (his balance less what his waiting asks hold), and at most 200 points a
--     household week taken through tutor links (apart from the 200 they may give). The key makes it once only.
--     The other actions are 0012's function (moved to private.coach_reward_by_token_v32, unchanged).
--   • The coach view's `manage` (private.coach_view, 0012's moved to coach_view_v32, unchanged) gains `take: true` and
--     `free`, his free points (0 or more), so the link shows Take points and how many can come off.
--   • hub_schema_version() (33). The tutor link shows Take points only on 33.
--
-- Rules
--   • One transaction. It refuses to run without 0032, twice, on a database set back to 32 (the moved function
--     already there), or on one that isn't as 0032 left it.
--   • Additive: one more action; every other answer is as before.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: with nothing taken through a link, every page is as on 32). If wanted, in one go:
--   drop function private.coach_view(uuid);
--   alter function private.coach_view_v32(uuid) rename to coach_view;
--   drop function public.coach_reward_by_token(text, text, uuid, jsonb);
--   alter function private.coach_reward_by_token_v32(text, text, uuid, jsonb) set schema public;
--   alter function public.coach_reward_by_token_v32(text, text, uuid, jsonb) rename to coach_reward_by_token;
--   grant execute on function public.coach_reward_by_token(text, text, uuid, jsonb) to anon, authenticated;
--   then 0032's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0032 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 32 then
    raise exception 'What to do and Check the portal (migration 0032) aren''t installed (hub_schema_version() is %). Run 0032_school_clarity.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 33 then
    raise exception 'Take points on the tutor link (migration 0033) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regprocedure('private.coach_reward_by_token_v32(text, text, uuid, jsonb)') is not null then
    raise exception 'Take points on the tutor link (migration 0033) is already installed, but hub_schema_version() was set back to 32. To switch it on again, make hub_schema_version() return 33 (docs/v1.3-homework.md §33). Nothing was changed.';
  end if;
  -- What this migration reads, calls and replaces is as 0032 left it.
  if to_regprocedure('public.coach_reward_by_token(text, text, uuid, jsonb)') is null
     or to_regprocedure('public.take_points(uuid, integer, text, uuid)') is null
     or to_regprocedure('private.tutor_link_by_token(text)') is null
     or to_regprocedure('private.coach_view(uuid)') is null
     or to_regprocedure('private.points_balance(uuid)') is null
     or to_regprocedure('private.count_homework(uuid, text, integer)') is null
     or to_regprocedure('private.portal_class(uuid, text)') is null
     or to_regprocedure('public.coach_reward_by_token_v32(text, text, uuid, jsonb)') is not null
     or to_regprocedure('private.coach_view_v32(uuid)') is not null then
    raise exception 'This database isn''t as migration 0032 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Take points through the link (§33.1)
-- ---------------------------------------------------------------------
-- 0012's function, unchanged, out of reach of the browser: the new one calls it for every action but 'take'.
alter function public.coach_reward_by_token(text, text, uuid, jsonb) rename to coach_reward_by_token_v32;
alter function public.coach_reward_by_token_v32(text, text, uuid, jsonb) set schema private;
revoke execute on function private.coach_reward_by_token_v32(text, text, uuid, jsonb) from public, anon, authenticated, service_role;

-- 'take' ({points, note}) as take_points (0028), by the link: the same link checks as its other actions (a link
-- whose coach view and Can manage rewards are on, else null), points on, his free points, 200 a household week
-- taken through tutor links, the link's writes for the day, and the key once only. Any other action is 0012's.
create function public.coach_reward_by_token(p_token text, p_action text, p_key uuid, p_fields jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l       public.tutor_links;
  v_f     jsonb := coalesce(p_fields, '{}');
  v_e     public.points_ledger;
  v_note  text;
  v_pts   int;
  v_free  int;
  v_used  int;
  v_mon   date := private.monday(public.today_local());
  v_chg   boolean := false;
begin
  if p_action is distinct from 'take' then
    return private.coach_reward_by_token_v32(p_token, p_action, p_key, p_fields);
  end if;
  l := private.tutor_link_by_token(p_token);
  if l.id is null or not (l.coach and l.rewards) then
    return null;
  end if;
  if p_key is null then
    raise exception 'That needs its id.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'That can''t be saved.' using errcode = '22023';
  end if;
  if char_length(v_f ->> 'note') > 120 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  select * into v_e from public.points_ledger x where x.id = p_key;
  if v_e.id is not null then
    if v_e.kid_id <> l.kid_id or v_e.kind <> 'taken' then
      raise exception 'That id is taken.' using errcode = '22023';
    end if;
  else
    if jsonb_typeof(v_f -> 'points') is distinct from 'number' then
      raise exception 'Take 1 to 200 points.' using errcode = '22023';
    end if;
    v_pts := (v_f ->> 'points')::numeric::int;
    if v_pts is null or v_pts not between 1 and 200 then
      raise exception 'Take 1 to 200 points.' using errcode = '22023';
    end if;
    v_note := nullif(private.clean_text(v_f ->> 'note', 120), '');
    if v_note is null then
      raise exception 'Say why the points come off.' using errcode = '22023';
    end if;
    -- His homework_kids row first: every writer of his balance takes that lock first.
    perform 1 from public.homework_kids k where k.kid_id = l.kid_id for update;
    if not exists (select 1 from public.homework_kids k where k.kid_id = l.kid_id and k.points_on) then
      raise exception 'Points are off.' using errcode = '42501';
    end if;
    -- Never below zero, and never what his waiting asks hold.
    select b.balance - b.held into v_free from private.points_balance(l.kid_id) b;
    if coalesce(v_free, 0) <= 0 then
      raise exception 'There are no free points to take.' using errcode = 'P0001';
    end if;
    if v_pts > v_free then
      raise exception 'Only % points are free to take (the rest are spent or held for a reward he asked for).', v_free using errcode = 'P0001';
    end if;
    select coalesce(-sum(x.delta), 0) into v_used
    from public.points_ledger x
    where x.kid_id = l.kid_id and x.kind = 'taken' and x.who like '% (tutor link)' and x.day between v_mon and v_mon + 6;
    if v_used + v_pts > 200 then
      raise exception 'That''s more than 200 points this week taken through the tutor link. A parent can take more.' using errcode = 'P0001';
    end if;
    perform private.count_homework(l.id, 'writes', 200);
    insert into public.points_ledger (id, kid_id, at, day, kind, delta, note, who)
    values (p_key, l.kid_id, private.now(), public.today_local(), 'taken', -v_pts, v_note, l.label || ' (tutor link)')
    on conflict (id) do nothing;
    v_chg := found;
  end if;
  return jsonb_build_object('action', p_action, 'key', p_key, 'changed', v_chg) || private.coach_view(l.id);
exception
  -- A constraint's DETAIL is the whole row: never to a link (as the link's other writers).
  when integrity_constraint_violation then
    raise exception 'That can''t be saved.' using errcode = '22023';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'That can''t be saved.' using errcode = '22023';
end;
$$;

revoke execute on function public.coach_reward_by_token(text, text, uuid, jsonb) from public, service_role;
grant  execute on function public.coach_reward_by_token(text, text, uuid, jsonb) to anon, authenticated;

-- The coach view (§33.2): 0012's, with `take: true` and `free` in `manage` (only there: a link that runs his rewards).
alter function private.coach_view(uuid) rename to coach_view_v32;

create function private.coach_view(p_link uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v    jsonb := private.coach_view_v32(p_link);
  kid  uuid;
  free int;
begin
  if v is null or jsonb_typeof(v -> 'manage') is distinct from 'object' then
    return v;
  end if;
  select x.kid_id into kid from public.tutor_links x where x.id = p_link;
  select greatest(b.balance - b.held, 0) into free from private.points_balance(kid) b;
  return jsonb_set(v, '{manage}', (v -> 'manage') || jsonb_build_object('take', true, 'free', coalesce(free, 0)));
end;
$$;

revoke execute on function private.coach_view(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The tutor link shows Take points only on 33. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 33;
$$;

commit;
