-- =====================================================================
-- HOME HUB v1.3 — migration 0012: the coach's rewards (a tutor link that may run the kid's points and rewards)
-- Apply once, after 0011, and only once the site that understands it is live (docs/v1.3-homework.md §22.6).
-- The contract is docs/v1.3-homework.md §22.
--
-- Why
--   A tutor who is also the kid's coach plans his homework through the tutor link already (0005) and, with the coach
--   view on, reads his points and rewards (0007). This lets the parents hand that coach the rewards too, link by link:
--   the reward list, Yes or Not now on his asks, points given for what the rules can't see, and a correction.
--
-- What it adds and changes
--   • Column: tutor_links.rewards, a per-link switch, off by default; only the parents set it (set_tutor_rewards).
--     It counts only while the link's coach view is on too: with either off, nothing changes for the link.
--   • New, for the tutor link (anon, by its token): public.coach_reward_by_token(p_token text, p_action text,
--     p_key uuid, p_fields jsonb) returns jsonb, one function for five actions: 'save_reward' (add or change a
--     reward, price his suggestion, retire one), 'remove_reward' (only a suggestion nobody has priced), 'decide' (Yes
--     or Not now on an ask), 'give' (1 to 200 points with a note, at most 200 a household week through tutor links)
--     and 'void' (a correction with a reason). Each as the parents' own (decide_reward, give_points, void_points,
--     their writes to rewards), written as "<the link's label> (tutor link)". Twenty-three token functions for anon in all.
--   • New, for the parents: public.set_tutor_rewards(p_link uuid, p_on boolean) returns void.
--   • Replaced: private.coach_view(p_link uuid) (0007's, renamed private.coach_view_v7 and kept as it is) is a wrapper
--     that adds, for a link with the switch on, manage: the rewards with their ids (his unpriced suggestions and the
--     retired ones too), the asks waiting with their ids, and the last 30 days' ledger lines with their ids and whether
--     each is voided. With the switch off it answers exactly 0007's.
--   • hub_schema_version() (12).
--
-- Rules
--   • One transaction. It refuses to run without 0011, twice, on a database set back to 11 (the column already there),
--     or on a database that isn't as 0011 left it.
--   • No new table. set search_path = '' on every function; revoke then grant on every new one.
--   • Nothing here names anyone but the kid (his first name) and the link's own label.
--
-- Undo (not needed: with the switch off on every link, as this leaves them, every answer is 11's). If wanted, in one
-- go in the SQL editor:
--   drop function public.coach_reward_by_token(text, text, uuid, jsonb); drop function public.set_tutor_rewards(uuid, boolean);
--   drop function private.coach_view(uuid); alter function private.coach_view_v7(uuid) rename to coach_view;
--   alter table public.tutor_links drop column rewards;
--   create or replace function public.hub_schema_version() returns int language sql immutable set search_path = ''
--   as $$ select 11 $$;
-- 0012 can then run again. The site needs no change: it works on 11.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0011 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 11 then
    raise exception 'Project guests (migration 0011) isn''t installed (hub_schema_version() is %). Run 0011_project_guests.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 12 then
    raise exception 'The coach''s rewards (migration 0012) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.tutor_links'::regclass and a.attname = 'rewards' and not a.attisdropped) then
    raise exception 'The coach''s rewards (migration 0012) is already installed, but hub_schema_version() was set back to 11. To switch it on again, make hub_schema_version() return 12 (docs/v1.3-homework.md §22.6). Nothing was changed.';
  end if;
  -- What this migration changes, replaces and reads is as 0011 left it.
  if to_regclass('public.coach_notes') is null
     or to_regprocedure('private.coach_view(uuid)') is null
     or to_regprocedure('private.coach_view_v7(uuid)') is not null
     or to_regprocedure('public.coach_reward_by_token(text, text, uuid, jsonb)') is not null
     or to_regprocedure('public.set_tutor_rewards(uuid, boolean)') is not null
     or to_regprocedure('private.tutor_link_by_token(text)') is null
     or to_regprocedure('private.count_homework(uuid, text, int)') is null
     or to_regprocedure('private.points_balance(uuid)') is null
     or to_regprocedure('private.award(uuid, text, int, date, uuid, uuid, uuid, uuid, text, text)') is null
     or to_regprocedure('private.clean_text(text, int)') is null
     or to_regprocedure('private.monday(date)') is null then
    raise exception 'This database isn''t as migration 0011 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The switch (§22.2)
-- ---------------------------------------------------------------------

-- The coach's rewards: off until a parent turns it on for this link (set_tutor_rewards). It counts only while the
-- link's coach view is on too. The table's select grant (the parents, by its policy) covers the new column; there
-- is no update grant on tutor_links.
alter table public.tutor_links
  add column rewards boolean not null default false;

-- ---------------------------------------------------------------------
-- The coach view, with what the coach manages (§22.3)
-- ---------------------------------------------------------------------
-- 0007's body, kept as it is under a new name; the definer token functions call the wrapper by name.
alter function private.coach_view(uuid) rename to coach_view_v7;

-- 0007's coach view, and for a link whose coach view and rewards switch are both on, manage:
--   {points_on, instant_day,
--    rewards: [{id, title, cost, instant, active, suggested}] (every reward of his: the retired ones and his
--      suggestions nobody has priced too, in the parents' order),
--    asks: [{id, title, cost, asked_on}] (his asks waiting, oldest first),
--    lines: [{id, day, kind, delta, note, voided}] (the coach view's ledger lines, the last 30 days, newest first;
--      voided: a void of it is there)}.
-- Never who wrote a line, and nothing else beyond 0007's.
create function private.coach_view(p_link uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v   jsonb := private.coach_view_v7(p_link);
  l   public.tutor_links;
  k   public.homework_kids;
  tz  text := private.tz();
  td  date := public.today_local();
begin
  if v is null then
    return null;
  end if;
  select * into l from public.tutor_links x where x.id = p_link;
  if not (l.coach and l.rewards) then
    return v;
  end if;
  select * into k from public.homework_kids x where x.kid_id = l.kid_id;
  return v || jsonb_build_object('manage', jsonb_build_object(
    'points_on', coalesce(k.points_on, false),
    'instant_day', k.instant_day,
    'rewards', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'cost', r.cost, 'instant', r.instant,
                                                             'active', r.active, 'suggested', r.suggested)
                                          order by r.active desc, r.sort_order, r.cost nulls first, r.title, r.id), '[]')
                from public.rewards r where r.kid_id = l.kid_id),
    'asks', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'title', q.title, 'cost', q.cost,
                                                          'asked_on', (q.asked_at at time zone tz)::date)
                                       order by q.asked_at, q.id), '[]')
             from public.reward_asks q where q.kid_id = l.kid_id and q.status = 'waiting'),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'day', x.day, 'kind', x.kind, 'delta', x.delta, 'note', x.note,
                                                           'voided', exists (select 1 from public.points_ledger z
                                                                             where z.void_of = x.id and z.kind = 'void'))
                                        order by x.at desc, x.id), '[]')
              from (select y.* from public.points_ledger y
                    where y.kid_id = l.kid_id and y.day between td - 29 and td
                    order by y.at desc, y.id limit 300) x)));
end;
$$;

-- ---------------------------------------------------------------------
-- The tutor link (§22.4): its token is the key (private.tutor_link_by_token, as for its other functions), and the
-- link's coach view and rewards switch must both be on: else null.
-- ---------------------------------------------------------------------

-- One of five actions on the link's kid's rewards and points, each as the parents' own, written as
-- "<the link's label> (tutor link)". p_key is the row it is about (a new reward's or given points' id, made by the
-- page, so a resend finds it and writes nothing more; an ask's or a ledger line's id); p_fields its fields.
--   'save_reward'   {title, cost, instant, active}: a new reward (p_key not yet used) or a change to one of his
--                   (pricing his suggestion: a cost, and it is on his list). Title 1 to 60, cost 1 to 10000; a
--                   reward that is on his list needs a cost. A reward of another kid's → 42501 "That reward isn't on
--                   this link.".
--   'remove_reward' {}: deletes a suggestion of his nobody has priced (22023 "Only his suggestion can be deleted.
--                   Take a reward off his list instead." for any other).
--   'decide'        {approve, note}: Yes or Not now on an ask of his (decide_reward's rules: "Not enough points yet.").
--   'give'          {points, note}: 1 to 200 points with a note he sees (give_points's rules), and at most 200 points
--                   a household week (Mon–Sun) given through tutor links (P0001 "That's more than 200 points this week
--                   from the tutor link. A parent can give more.").
--   'void'          {note}: a correction of one earned or given line of his (void_points's rules).
-- Each write is one of the link's writes (200 a day). A constraint's DETAIL never reaches the link.
-- Answers {action, key, changed} and the coach view (with manage).
create function public.coach_reward_by_token(p_token text, p_action text, p_key uuid, p_fields jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l       public.tutor_links;
  v_who   text;
  v_f     jsonb := coalesce(p_fields, '{}');
  v_r     public.rewards;
  v_q     public.reward_asks;
  v_e     public.points_ledger;
  v_title text;
  v_cost  int;
  v_note  text;
  v_pts   int;
  v_bal   int;
  v_held  int;
  v_used  int;
  v_mon   date := private.monday(public.today_local());
  v_chg   boolean := false;
begin
  l := private.tutor_link_by_token(p_token);
  if l.id is null or not (l.coach and l.rewards) then
    return null;
  end if;
  v_who := l.label || ' (tutor link)';
  if p_action is null or p_action not in ('save_reward', 'remove_reward', 'decide', 'give', 'void') then
    raise exception 'That can''t be done here.' using errcode = '22023';
  end if;
  if p_key is null then
    raise exception 'That needs its id.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'That can''t be saved.' using errcode = '22023';
  end if;
  if char_length(v_f ->> 'title') > 60 or char_length(v_f ->> 'note') > 120 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;

  if p_action = 'save_reward' then
    select * into v_r from public.rewards r where r.id = p_key for update;
    if v_r.id is not null and v_r.kid_id <> l.kid_id then
      raise exception 'That reward isn''t on this link.' using errcode = '42501';
    end if;
    v_title := nullif(private.clean_text(coalesce(v_f ->> 'title', v_r.title), 60), '');
    if v_title is null then
      raise exception 'A reward needs a name.' using errcode = '22023';
    end if;
    if v_f ? 'cost' and jsonb_typeof(v_f -> 'cost') not in ('number', 'null') then
      raise exception 'A reward costs 1 to 10000 points.' using errcode = '22023';
    end if;
    v_cost := case when v_f ? 'cost' then (v_f ->> 'cost')::numeric::int else v_r.cost end;
    if v_cost is not null and v_cost not between 1 and 10000 then
      raise exception 'A reward costs 1 to 10000 points.' using errcode = '22023';
    end if;
    if coalesce((v_f ->> 'active')::boolean, v_r.active, true) and v_cost is null then
      raise exception 'A reward on his list needs a price.' using errcode = '22023';
    end if;
    perform private.count_homework(l.id, 'writes', 200);
    if v_r.id is null then
      insert into public.rewards (id, kid_id, title, cost, active, instant, sort_order, created_by, updated_by)
      values (p_key, l.kid_id, v_title, v_cost, coalesce((v_f ->> 'active')::boolean, true), coalesce((v_f ->> 'instant')::boolean, false),
              coalesce((select max(r.sort_order) + 1 from public.rewards r where r.kid_id = l.kid_id), 0), v_who, v_who);
      v_chg := true;
    else
      update public.rewards r
      set title = v_title, cost = v_cost,
          active = coalesce((v_f ->> 'active')::boolean, r.active),
          instant = coalesce((v_f ->> 'instant')::boolean, r.instant),
          updated_by = v_who
      where r.id = p_key
        and (r.title, r.cost, r.active, r.instant) is distinct from
            (v_title, v_cost, coalesce((v_f ->> 'active')::boolean, r.active), coalesce((v_f ->> 'instant')::boolean, r.instant));
      v_chg := found;
    end if;

  elsif p_action = 'remove_reward' then
    select * into v_r from public.rewards r where r.id = p_key for update;
    if v_r.id is not null then
      if v_r.kid_id <> l.kid_id then
        raise exception 'That reward isn''t on this link.' using errcode = '42501';
      end if;
      if not v_r.suggested or v_r.cost is not null then
        raise exception 'Only his suggestion can be deleted. Take a reward off his list instead.' using errcode = '22023';
      end if;
      perform private.count_homework(l.id, 'writes', 200);
      delete from public.rewards r where r.id = p_key;
      v_chg := true;
    end if;

  elsif p_action = 'decide' then
    if jsonb_typeof(v_f -> 'approve') is distinct from 'boolean' then
      raise exception 'Choose Yes or Not now.' using errcode = '22023';
    end if;
    -- His homework_kids row first, then the ask (as decide_reward): every writer of his balance takes that lock first.
    perform 1 from public.homework_kids k where k.kid_id = l.kid_id for update;
    select * into v_q from public.reward_asks q where q.id = p_key for update;
    if v_q.id is null then
      raise exception 'That ask is gone.' using errcode = '22023';
    end if;
    if v_q.kid_id <> l.kid_id then
      raise exception 'That ask isn''t on this link.' using errcode = '42501';
    end if;
    if v_q.status = 'waiting' then
      perform private.count_homework(l.id, 'writes', 200);
      select b.balance, b.held into v_bal, v_held from private.points_balance(v_q.kid_id) b;
      if (v_f ->> 'approve')::boolean then
        if v_bal - (v_held - v_q.cost) < v_q.cost then
          raise exception 'Not enough points yet.' using errcode = '42501';
        end if;
        perform private.award(v_q.kid_id, 'trade', -v_q.cost, public.today_local(), null, null, v_q.id, null, v_q.title, v_who);
        update public.reward_asks set status = 'approved', decided_at = private.now(), decided_by = v_who where id = v_q.id;
      else
        update public.reward_asks
        set status = 'declined', decided_at = private.now(), decided_by = v_who, note = nullif(private.clean_text(v_f ->> 'note', 120), '')
        where id = v_q.id;
      end if;
      v_chg := true;
    end if;

  elsif p_action = 'give' then
    select * into v_e from public.points_ledger x where x.id = p_key;
    if v_e.id is not null then
      if v_e.kid_id <> l.kid_id or v_e.kind <> 'given' then
        raise exception 'That id is taken.' using errcode = '22023';
      end if;
    else
      if jsonb_typeof(v_f -> 'points') is distinct from 'number' then
        raise exception 'Give 1 to 200 points.' using errcode = '22023';
      end if;
      v_pts := (v_f ->> 'points')::numeric::int;
      if v_pts is null or v_pts not between 1 and 200 then
        raise exception 'Give 1 to 200 points.' using errcode = '22023';
      end if;
      v_note := nullif(private.clean_text(v_f ->> 'note', 120), '');
      if v_note is null then
        raise exception 'Say what the points are for.' using errcode = '22023';
      end if;
      perform 1 from public.homework_kids k where k.kid_id = l.kid_id for update;
      if not exists (select 1 from public.homework_kids k where k.kid_id = l.kid_id and k.points_on) then
        raise exception 'Points are off.' using errcode = '42501';
      end if;
      select coalesce(sum(x.delta), 0) into v_used
      from public.points_ledger x
      where x.kid_id = l.kid_id and x.kind = 'given' and x.who like '% (tutor link)' and x.day between v_mon and v_mon + 6;
      if v_used + v_pts > 200 then
        raise exception 'That''s more than 200 points this week from the tutor link. A parent can give more.' using errcode = 'P0001';
      end if;
      perform private.count_homework(l.id, 'writes', 200);
      insert into public.points_ledger (id, kid_id, at, day, kind, delta, note, who)
      values (p_key, l.kid_id, private.now(), public.today_local(), 'given', v_pts, v_note, v_who)
      on conflict (id) do nothing;
      v_chg := found;
    end if;

  else  -- 'void'
    v_note := nullif(private.clean_text(v_f ->> 'note', 120), '');
    if v_note is null then
      raise exception 'Say why.' using errcode = '22023';
    end if;
    select * into v_e from public.points_ledger x where x.id = p_key;
    if v_e.id is not null and v_e.kid_id <> l.kid_id then
      raise exception 'Those points aren''t on this link.' using errcode = '42501';
    end if;
    if v_e.id is null or v_e.kind not in ('focus', 'on_time', 'milestone_done', 'milestone', 'given') then
      raise exception 'Only earned or given points can be voided.' using errcode = '22023';
    end if;
    perform 1 from public.homework_kids k where k.kid_id = v_e.kid_id for update;
    if not exists (select 1 from public.points_ledger x where x.void_of = v_e.id and x.kind = 'void') then
      if (select b.balance from private.points_balance(v_e.kid_id) b) - v_e.delta < 0 then
        raise exception 'Those points are already spent.' using errcode = 'P0001';
      end if;
      perform private.count_homework(l.id, 'writes', 200);
      v_chg := private.award(v_e.kid_id, 'void', -v_e.delta, public.today_local(), null, null, null, v_e.id, v_note, v_who) <> 0;
    end if;
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

-- ---------------------------------------------------------------------
-- The parents (§22.5)
-- ---------------------------------------------------------------------

-- The coach's rewards on or off for one tutor link (as set_tutor_coach). It counts only while the link's coach
-- view is on. Unknown link: 22023 "That link is gone."; null: 22023 "Choose on or off.".
create function public.set_tutor_rewards(p_link uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  update public.tutor_links l set rewards = p_on where l.id = p_link;
  if not found then
    raise exception 'That link is gone.' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The rewards switch shows on the Homework page, and the coach's controls on the tutor link, only on 12.
-- (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 12;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- New functions: revoke from public and anon (and whoever else mustn't call them), then grant to who calls them.
-- The renamed 0007 body (private.coach_view_v7) keeps its revokes.
-- ---------------------------------------------------------------------

-- The tutor link: its token is the key.
revoke execute on function public.coach_reward_by_token(text, text, uuid, jsonb) from public, service_role;
grant  execute on function public.coach_reward_by_token(text, text, uuid, jsonb) to anon, authenticated;

-- The parents.
revoke execute on function public.set_tutor_rewards(uuid, boolean)            from public, anon, service_role;
grant  execute on function public.set_tutor_rewards(uuid, boolean)            to authenticated;

-- Private: the definer token functions call it; nobody else.
revoke execute on function private.coach_view(uuid)                           from public, anon, authenticated;

commit;
