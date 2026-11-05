-- =====================================================================
-- HOME HUB v2 — migration 0020: the family board
-- Apply once, after 0019, and only once the site that understands it is live (docs/v2-design.md §25).
-- The contract is docs/v2-design.md §25.
--
-- Why
--   One screen for the whole house (a monitor on the wall, a mini PC or an old tablet), with no sign-in: everyone's
--   day in columns, a Family column, today's meals, chores to tick and each kid's routine to tick. It shows what the
--   wall (Hearth) may show and nothing more, because everyone in the house sees it, visitors included.
--
-- What it adds
--   • Table family_board: one row, the board's secret link (a token). No row: the board is off.
--   • board_link(p_action text) (parents): 'show' the token, 'new' make one (the old link stops at once), 'off'.
--   • board_by_token(p_token text, p_lang text) (the board page, no sign-in): today for the house, or null for a
--     link that doesn't work. Each active person's items (the hub's events, tasks and project tasks, and the Google
--     events the wall already shows), their late tasks, and a kid's routine; a Family column for events with 4 or
--     more of the family (or nobody), as on the wall; and today's meals. Private items (and health tasks) read
--     "Private item"; never a note, a phone number, a Bring, homework, points or the shopping list.
--   • board_tick_by_token(p_token text, p_task_id uuid, p_occurrence date, p_lang text): tick off a task the board
--     shows (logged as done by "Family board"); answers the board with 'log_id' (for Undo).
--   • board_undo_by_token(p_token text, p_log_id uuid, p_lang text): take back a tick made on the board, within 15
--     minutes, if it is still the task's latest change; answers the board.
--   • board_routine_by_token(p_token text, p_item uuid, p_done boolean, p_lang text): tick or untick an item of a
--     kid's routine today, as his My day does (the section's bonus once a day; "Family board"); answers the board.
--   • private.board_ok(text), private.board_item(public.agenda_item, text, boolean), private.board_view(text).
--   • hub_schema_version() (20). The pages offer the board only on 20.
--
-- Rules
--   • One transaction. It refuses to run without 0019, twice, on a database set back to 19, or on one that isn't as
--     0019 left it.
--   • RLS on family_board, with no policies and no grants: only the functions read or write it. set search_path = ''
--     on every function; revoke then grant.
--   • Additive: until a parent makes the link nothing anywhere changes.
--
-- Undo (not needed: nothing shows until a parent makes the link). If wanted, in one go:
--   drop function public.board_link(text);
--   drop function public.board_routine_by_token(text, uuid, boolean, text);
--   drop function public.board_undo_by_token(text, uuid, text);
--   drop function public.board_tick_by_token(text, uuid, date, text);
--   drop function public.board_by_token(text, text);
--   drop function private.board_view(text);
--   drop function private.board_item(public.agenda_item, text, boolean);
--   drop function private.board_ok(text);
--   drop table public.family_board;
--   then 0019's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;"). Ticks
--   made on the board stay, as any tick does.
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0019 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 19 then
    raise exception 'The routine (migration 0019) isn''t installed (hub_schema_version() is %). Run 0019_routine.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 20 then
    raise exception 'The family board (migration 0020) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.family_board') is not null then
    raise exception 'The family board (migration 0020) is already installed, but hub_schema_version() was set back to 19. To switch it on again, make hub_schema_version() return 20 (docs/v2-design.md §25). Nothing was changed.';
  end if;
  -- What this migration reads and calls is as 0019 left it.
  if to_regprocedure('private.routine_view(uuid, date)') is null
     or to_regprocedure('private.routine_school_day(date)') is null
     or to_regprocedure('private.count_homework(uuid, text, int)') is null
     or to_regprocedure('private.complete_task(uuid, date, date, text, text)') is null
     or to_regprocedure('private.undo_task(uuid, uuid, text)') is null
     or to_regprocedure('private.google_item(public.google_events, public.calendars)') is null
     or to_regprocedure('private.active_only(public.agenda_item)') is null
     or to_regprocedure('private.task_item(public.tasks, date, text)') is null
     or to_regprocedure('private.meal_title(public.meals, text)') is null
     or to_regprocedure('public.agenda(date, date)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'calendars' and column_name = 'sort_by_guest')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'points_ledger' and column_name = 'routine_section_id')
     or to_regclass('public.points_ledger_routine_day') is null then
    raise exception 'This database isn''t as migration 0019 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The link (§25.2)
-- ---------------------------------------------------------------------
-- The board's secret link: one row, or none (the board is off). Only the functions below read or write it.
create table public.family_board (
  id         boolean primary key default true check (id),
  token      text not null unique default encode(extensions.gen_random_bytes(16), 'hex') check (token ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  created_by text
);
alter table public.family_board enable row level security;
revoke all on public.family_board from public, anon, authenticated, service_role;

-- A parent's: 'show' the link's token (null while the board is off), 'new' make a new one (the old link stops working
-- at once), 'off' turn the board off. Answers the token, or null.
create function public.board_link(p_action text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if not private.is_admin() then
    raise exception 'Only an admin can do that.' using errcode = '42501';
  end if;
  if p_action = 'show' then
    select b.token into v_token from public.family_board b;
    return v_token;
  elsif p_action = 'new' then
    insert into public.family_board as b (id, token, created_at, created_by)
    values (true, encode(extensions.gen_random_bytes(16), 'hex'), private.now(), public.current_email())
    on conflict (id) do update set token = excluded.token, created_at = excluded.created_at, created_by = excluded.created_by
    returning b.token into v_token;
    return v_token;
  elsif p_action = 'off' then
    delete from public.family_board b where b.id;
    return null;
  end if;
  raise exception 'Say show, new or off.' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------
-- The board (§25.3)
-- ---------------------------------------------------------------------
-- The board's token: 32 hex characters, and the link that's on now.
create function private.board_ok(p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_token ~ '^[0-9a-f]{32}$', false)
         and exists (select 1 from public.family_board b where b.token = p_token);
$$;

-- One item as the board shows it: what, when and whether it's done, nothing more (no notes, no people, no contractor,
-- no place, no Bring). p_hidden: "Private item". A project task reads "Kitchen: Tile"; a late task carries its due date.
create function private.board_item(a public.agenda_item, p_lang text, p_hidden boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', a.kind,
    'item_id', a.item_id,
    'occurrence', a.occurrence,
    'title', case when p_hidden then private.word('private_item', p_lang)
                  when a.kind = 'project' then concat_ws(': ', a.project_name, a.title)
                  else a.title end,
    'all_day', a.local_start is null,
    'time_label', private.time_label(a.local_start, p_lang),
    'status', a.status,
    'private', p_hidden)
    || case when a.status = 'late' then jsonb_build_object('due_label', private.short_date(a.occurrence, p_lang)) else '{}'::jsonb end;
$$;

-- The whole board today, in p_lang ('en' or 'es'; anything else is English):
--   {today, now (the server's clock, ms), tz, lang,
--    people: [{id, name, color, role, items, late, routine?}],   -- every active person, in the family list's order
--    family: {items, late},
--    meals: [{slot, label, title, cook}]}
-- Items are the hub's own (events not cancelled, tasks due today, done or skipped today, and project tasks that start
-- today) and the Google events the wall already shows (on a calendar the hub writes, the wall's own sorted calendar,
-- or a Family calendar shown to kids). An event with 4 or more of the family (parents, adults, kids), or nobody, goes
-- once in Family, as on the wall; anything else in the column of each person on it. A task goes to whoever is in
-- charge (Family with nobody). People off the family list count as nobody. Private items, health tasks and Google's
-- private events read "Private item". A kid with homework on gets his routine (without points), as his My day has it.
-- A locked meal reads "Private item", without who's on it.
create function private.board_view(p_lang text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_lang  text := case when p_lang = 'es' then 'es' else 'en' end;
  v_today date := public.today_local();
begin
  return (
    with ppl as (
      select p.id, p.role, p.color, p.sort_order, p.name, private.short_name(p) as short
      from public.people p
      where p.active
    ),
    hub as (
      select x as a
      from public.agenda(v_today, v_today) g
      cross join lateral private.active_only(g) x
      where (x.kind = 'event' and x.status <> 'cancelled') or x.kind = 'task' or (x.kind = 'project' and x.day = v_today)
    ),
    goo as (
      select x as a
      from public.google_events ge
      join public.calendars c on c.id = ge.calendar_id and c.google_id = ge.google_calendar
      cross join lateral private.google_item(ge, c) i
      cross join lateral private.active_only(i) x
      where ge.start_day <= v_today and ge.end_day >= v_today
        and (c.writes or c.sort_by_guest or (c.kind = 'family' and c.for_kids))
    ),
    items as (
      select h.a,
             coalesce((h.a).private, false) or ((h.a).kind = 'task' and (h.a).category is not distinct from 'health') as hidden,
             case when (h.a).kind = 'event'
                  then ((h.a).responsible_id is null and cardinality((h.a).participant_ids) = 0)
                       or (select count(*) from ppl p
                           where (p.id = (h.a).responsible_id or p.id = any ((h.a).participant_ids))
                             and p.role in ('parent', 'adult', 'kid')) >= 4
                  else (h.a).responsible_id is null end as fam
      from hub h
      union all
      select o.a, coalesce((o.a).private, false),
             (o.a).category is not distinct from 'family'
             or ((o.a).responsible_id is null and cardinality((o.a).participant_ids) = 0)
      from goo o
    ),
    late as (
      select private.active_person(t.responsible_id) as resp, cd.due, t.title, i as a,
             coalesce(t.private, false) or t.category is not distinct from 'health' as hidden
      from public.tasks t
      cross join lateral (select private.current_due(t) as due) cd
      cross join lateral private.task_item(t, cd.due, 'late') i
      where t.active and t.done_at is null and cd.due < v_today
    )
    select jsonb_build_object(
      'today', v_today,
      'now', floor(extract(epoch from private.now()) * 1000)::bigint,
      'tz', private.tz(),
      'lang', v_lang,
      'people', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', p.id, 'name', p.short, 'color', p.color, 'role', p.role,
                 'items', coalesce((select jsonb_agg(private.board_item(i.a, v_lang, i.hidden)
                                                     order by private.item_order(i.a), (i.a).local_start, (i.a).title, (i.a).item_id)
                                    from items i
                                    where not i.fam and (p.id = (i.a).responsible_id or p.id = any ((i.a).participant_ids))), '[]'::jsonb),
                 'late', coalesce((select jsonb_agg(private.board_item(l.a, v_lang, l.hidden) order by l.due, l.title, (l.a).item_id)
                                   from late l where l.resp = p.id), '[]'::jsonb))
               || coalesce((select jsonb_build_object('routine', jsonb_build_object('sections',
                                     (select jsonb_agg(s - 'paid' order by n) from jsonb_array_elements(rv.r -> 'sections') with ordinality x (s, n))))
                            from (select private.routine_view(p.id, v_today) as r) rv
                            where p.role = 'kid' and rv.r is not null
                              and exists (select 1 from public.homework_kids k where k.kid_id = p.id and k.active)), '{}'::jsonb)
               order by p.sort_order, p.name, p.id)
        from ppl p), '[]'::jsonb),
      'family', jsonb_build_object(
        'items', coalesce((select jsonb_agg(private.board_item(i.a, v_lang, i.hidden)
                                            order by private.item_order(i.a), (i.a).local_start, (i.a).title, (i.a).item_id)
                           from items i where i.fam), '[]'::jsonb),
        'late', coalesce((select jsonb_agg(private.board_item(l.a, v_lang, l.hidden) order by l.due, l.title, (l.a).item_id)
                          from late l where l.resp is null), '[]'::jsonb)),
      'meals', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'slot', m.slot,
                 'label', private.food_word(m.slot, v_lang),
                 'title', case when m.private then private.word('private_item', v_lang) else private.meal_title(m, v_lang) end,
                 'cook', case when not m.private then private.short_name(c) end)
               order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id)
        from public.meals m
        left join public.people c on c.id = m.cook_id and c.active
        where m.day = v_today), '[]'::jsonb))
  );
end;
$$;

-- The board page (board.html?b=<token>), no sign-in: today for the house, or null for a link that doesn't work (off,
-- replaced, or not one).
create function public.board_by_token(p_token text, p_lang text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.board_ok(p_token) then
    return null;
  end if;
  return private.board_view(p_lang);
end;
$$;

-- Tick off a task the board shows: due today or late (by private.current_due), whoever is in charge. p_occurrence is
-- the date the board showed; a repeating task needs it, so a board left on overnight can't tick the next date. Logged
-- as done by "Family board" (nobody signs in there). Answers the board, with 'log_id' for Undo; null for a link that
-- doesn't work.
create function public.board_tick_by_token(p_token text, p_task_id uuid, p_occurrence date, p_lang text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t     public.tasks;
  v_log uuid;
begin
  if not private.board_ok(p_token) then
    return null;
  end if;
  select * into t from public.tasks where id = p_task_id;
  if not found or private.current_due(t) is null or private.current_due(t) > public.today_local() then
    raise exception 'That isn''t on the board.' using errcode = '42501';
  end if;
  if t.repeat_mode <> 'none' and p_occurrence is null then
    raise exception 'already completed' using errcode = 'P0001', hint = 'Reload the page to see the task''s current date.';
  end if;
  v_log := private.complete_task(p_task_id, p_occurrence, null, null, 'Family board');
  return private.board_view(p_lang) || jsonb_build_object('log_id', v_log);
end;
$$;

-- Undo a tick made on the board (the toast's Undo): only a 'done' entry by "Family board", within 15 minutes, and only
-- while it is the task's latest change (private.undo_task checks that). Answers the board; null for a link that
-- doesn't work.
create function public.board_undo_by_token(p_token text, p_log_id uuid, p_lang text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.task_log;
begin
  if not private.board_ok(p_token) then
    return null;
  end if;
  select * into l from public.task_log where id = p_log_id;
  if not found then
    raise exception 'There''s nothing to undo.' using errcode = 'P0002';
  end if;
  if l.status <> 'done' or l.done_by is distinct from 'Family board' then
    raise exception 'Only something ticked off on the board can be undone here.' using errcode = '42501';
  end if;
  if l.created_at < private.now() - interval '15 minutes' then
    raise exception 'That was more than 15 minutes ago, so it can''t be undone here.' using errcode = '22023';
  end if;
  perform private.undo_task(p_log_id, null, null);
  return private.board_view(p_lang);
end;
$$;

-- Tick (p_done true) or untick an item of a kid's routine today, as his My day does (routine_tick_by_token): a kid
-- who is on the family list with homework on; an item for school days only on a school day. A tick that finishes its
-- section pays the section's bonus (homework_kids.routine_points, when points are on) once a day; unticking keeps it.
-- Each change counts as one of his writes (private.count_homework, 150 a day); ticks older than 30 days go. Logged as
-- "Family board". Answers the board; null for a link that doesn't work.
create function public.board_routine_by_token(p_token text, p_item uuid, p_done boolean, p_lang text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.today_local();
  v_kid   uuid;
  v_sid   uuid;
  v_title text;
  v_only  boolean;
  v_k     public.homework_kids;
  v_n     int;
begin
  if not private.board_ok(p_token) then
    return null;
  end if;
  if p_done is null then
    raise exception 'Choose done or not done.' using errcode = '22023';
  end if;
  select s.kid_id, s.id, s.title, it.school_days into v_kid, v_sid, v_title, v_only
  from public.routine_items it
  join public.routine_sections s on s.id = it.section_id
  join public.people p on p.id = s.kid_id and p.active and p.role = 'kid'
  join public.homework_kids k on k.kid_id = s.kid_id and k.active
  where it.id = p_item;
  if v_sid is null then
    raise exception 'That isn''t on the board.' using errcode = '42501';
  end if;
  if v_only and not private.routine_school_day(v_today) then
    raise exception 'That one is for school days.' using errcode = '22023';
  end if;
  if p_done then
    insert into public.routine_ticks (item_id, day, at, who) values (p_item, v_today, private.now(), 'Family board')
    on conflict do nothing;
  else
    delete from public.routine_ticks t where t.item_id = p_item and t.day = v_today;
  end if;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform private.count_homework(v_kid, 'writes', 150);
  end if;

  -- The section finished (every item it shows today ticked): its bonus, once a day.
  if p_done and not exists (select 1 from public.routine_items it
                            where it.section_id = v_sid and (not it.school_days or private.routine_school_day(v_today))
                              and not exists (select 1 from public.routine_ticks t where t.item_id = it.id and t.day = v_today)) then
    select * into v_k from public.homework_kids k where k.kid_id = v_kid for update;
    if v_k.points_on and v_k.routine_points > 0 then
      insert into public.points_ledger (kid_id, at, day, kind, delta, note, who, routine_section_id)
      values (v_kid, private.now(), v_today, 'routine', v_k.routine_points, v_title, 'Family board', v_sid)
      on conflict do nothing;
    end if;
  end if;

  delete from public.routine_ticks t using public.routine_items it, public.routine_sections s
  where t.item_id = it.id and it.section_id = s.id and s.kid_id = v_kid and t.day < v_today - 30;
  return private.board_view(p_lang);
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages offer the board only on 20. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 20;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------
-- The board page: its token is the key (as My day's).
revoke execute on function public.board_by_token(text, text)                           from public, service_role;
grant  execute on function public.board_by_token(text, text)                           to anon, authenticated;
revoke execute on function public.board_tick_by_token(text, uuid, date, text)          from public, service_role;
grant  execute on function public.board_tick_by_token(text, uuid, date, text)          to anon, authenticated;
revoke execute on function public.board_undo_by_token(text, uuid, text)                from public, service_role;
grant  execute on function public.board_undo_by_token(text, uuid, text)                to anon, authenticated;
revoke execute on function public.board_routine_by_token(text, uuid, boolean, text)    from public, service_role;
grant  execute on function public.board_routine_by_token(text, uuid, boolean, text)    to anon, authenticated;
-- The parents' Settings page.
revoke execute on function public.board_link(text)                                     from public, anon, service_role;
grant  execute on function public.board_link(text)                                     to authenticated;
-- Private: the functions above call them; nobody else.
revoke execute on function private.board_ok(text)                                      from public, anon, authenticated;
revoke execute on function private.board_item(public.agenda_item, text, boolean)       from public, anon, authenticated;
revoke execute on function private.board_view(text)                                    from public, anon, authenticated;

commit;
