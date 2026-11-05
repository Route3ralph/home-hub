-- =====================================================================
-- HOME HUB v1.3 — migration 0019: a kid's daily routine on his My day
-- Apply once, after 0018, and only once the site that understands it is live (docs/v1.3-homework.md §24).
-- The contract is docs/v1.3-homework.md §24.
--
-- Why
--   A kid's day as a checklist he ticks, top to bottom, the same order every day (morning, home time, after school,
--   before bed), on his My day. It starts again every day. A parent writes it once; a small bonus is paid when he
--   finishes a whole section, at most once a section a day.
--
-- What it adds
--   • Tables: routine_sections (a kid's sections, in order: title and a short note), routine_items (a section's items,
--     in order: title, an optional tag ("30 min early"), an optional part, a sub-heading inside the section ("Pack
--     up"), and school_days: shown only on school days) and routine_ticks (an item ticked on a day).
--   • Columns: homework_kids.routine_points (points for each section he finishes, 0 to 10; 0, the default, pays
--     nothing) and points_ledger.routine_section_id (the section a 'routine' entry paid for). points_ledger.kind
--     also takes 'routine'; one 'routine' entry a section a day (a unique index).
--   • private.routine_school_day(p_day date): a weekday not in household.days_off.
--   • private.routine_view(p_kid uuid, p_day date): his routine on that day, the school-days-only items left out on
--     other days; null with nothing to show.
--   • routine_status(p_kid uuid) (signed in): the whole routine, for the parents' editor, and today's view.
--   • save_routine(p_kid uuid, p_sections jsonb, p_points int) (parents): the whole routine at once.
--   • routine_tick_by_token(p_token text, p_item uuid, p_done boolean) (his My day): tick or untick an item today;
--     answers get_person_day with 'paid' (points paid by this tick).
--   • Replaced, with the same signature and grants: public.get_person_day(text): a 'routine' key for a kid with
--     homework on and a routine that shows something today; every other answer is exactly as on 18.
--   • hub_schema_version() (19). The pages offer the routine only on 19.
--
-- Rules
--   • One transaction. It refuses to run without 0018, twice, on a database set back to 18, or on one that isn't as
--     0018 left it.
--   • RLS on the new tables: members read; nothing writes but the functions. set search_path = '' on every function;
--     revoke then grant.
--   • Additive: until a parent saves a routine nothing anywhere changes.
--
-- Undo (not needed: nothing shows until a parent saves a routine). If wanted, in one go:
--   drop function public.routine_tick_by_token(text, uuid, boolean);
--   drop function public.save_routine(uuid, jsonb, int);
--   drop function public.routine_status(uuid);
--   drop function private.routine_view(uuid, date);
--   drop function private.routine_school_day(date);
--   delete from public.points_ledger where kind = 'routine';
--   drop index public.points_ledger_routine_day;
--   alter table public.points_ledger drop column routine_section_id;
--   alter table public.points_ledger drop constraint points_ledger_kind_check;
--   alter table public.points_ledger add constraint points_ledger_kind_check check (kind in ('focus', 'on_time', 'milestone_done', 'milestone', 'given', 'void', 'trade'));
--   drop table public.routine_ticks;
--   drop table public.routine_items;
--   drop table public.routine_sections;
--   alter table public.homework_kids drop column routine_points;
--   then 0005's get_person_day ("create or replace function public.get_person_day(p_token text)", to its "$$;") and
--   0018's hub_schema_version. The routine points paid are deleted with it (the balance drops by them).
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0018 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 18 then
    raise exception 'Keeping what the school gave (migration 0018) isn''t installed (hub_schema_version() is %). Run 0018_school_given_keep.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 19 then
    raise exception 'The routine (migration 0019) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.routine_sections') is not null then
    raise exception 'The routine (migration 0019) is already installed, but hub_schema_version() was set back to 18. To switch it on again, make hub_schema_version() return 19 (docs/v1.3-homework.md §24). Nothing was changed.';
  end if;
  -- What this migration replaces and reads is as 0018 left it.
  if to_regprocedure('public.school_store(uuid, uuid, jsonb, text, int, date)') is null
     or to_regprocedure('public.get_person_day(text)') is null
     or to_regprocedure('private.homework_card(uuid, text)') is null
     or to_regprocedure('private.homework_kid_by_token(text)') is null
     or to_regprocedure('private.count_homework(uuid, text, int)') is null
     or to_regprocedure('private.short_name(public.people)') is null
     or to_regclass('public.points_ledger') is null
     or not exists (select 1 from pg_constraint c where c.conrelid = 'public.points_ledger'::regclass and c.conname = 'points_ledger_kind_check')
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                and ((table_name = 'homework_kids' and column_name = 'routine_points') or (table_name = 'points_ledger' and column_name = 'routine_section_id')))
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'household' and column_name = 'days_off') then
    raise exception 'This database isn''t as migration 0018 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables (§24.2)
-- ---------------------------------------------------------------------
-- A kid's routine: its sections, in order.
create table public.routine_sections (
  id         uuid primary key default gen_random_uuid(),
  kid_id     uuid not null references public.homework_kids (kid_id) on delete cascade,
  pos        int not null check (pos between 1 and 8),
  title      text not null check (char_length(title) between 1 and 40),
  note       text check (note is null or char_length(note) between 1 and 40),   -- "At home", "Before you leave school"
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (kid_id, pos) deferrable initially deferred
);

-- A section's items, in order.
create table public.routine_items (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references public.routine_sections (id) on delete cascade,
  pos         int not null check (pos between 1 and 30),
  title       text not null check (char_length(title) between 1 and 80),
  tag         text check (tag is null or char_length(tag) between 1 and 24),     -- "30 min early"
  part        text check (part is null or char_length(part) between 1 and 24),   -- a sub-heading inside the section: "Pack up"
  school_days boolean not null default false,                                    -- shown only on school days
  unique (section_id, pos) deferrable initially deferred
);
create index routine_items_section on public.routine_items (section_id);

-- An item ticked on a day (the household's day). Kept 30 days.
create table public.routine_ticks (
  item_id uuid not null references public.routine_items (id) on delete cascade,
  day     date not null,
  at      timestamptz not null,
  who     text not null check (char_length(who) between 1 and 120),
  primary key (item_id, day)
);

-- Points for each section he finishes (0: none).
alter table public.homework_kids add column routine_points int not null default 0 check (routine_points between 0 and 10);

-- A 'routine' entry: the bonus for one section finished on one day, once.
alter table public.points_ledger drop constraint points_ledger_kind_check;
alter table public.points_ledger add constraint points_ledger_kind_check
  check (kind in ('focus', 'on_time', 'milestone_done', 'milestone', 'given', 'void', 'trade', 'routine'));
alter table public.points_ledger add column routine_section_id uuid references public.routine_sections (id) on delete set null;
create unique index points_ledger_routine_day on public.points_ledger (routine_section_id, day) where kind = 'routine';

alter table public.routine_sections enable row level security;
alter table public.routine_items enable row level security;
alter table public.routine_ticks enable row level security;
revoke all on public.routine_sections, public.routine_items, public.routine_ticks from public, anon, authenticated;
grant select on public.routine_sections, public.routine_items, public.routine_ticks to authenticated;
create policy routine_sections_read on public.routine_sections for select to authenticated using (private.is_member());
create policy routine_items_read on public.routine_items for select to authenticated using (private.is_member());
create policy routine_ticks_read on public.routine_ticks for select to authenticated using (private.is_member());

-- ---------------------------------------------------------------------
-- Functions (§24.3)
-- ---------------------------------------------------------------------
-- A school day: Monday to Friday, and not one of the household's days off (household.days_off, which holds the
-- school's closed days).
create function private.routine_school_day(p_day date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select extract(isodow from p_day) between 1 and 5
     and not (p_day = any (coalesce((select h.days_off from public.household h), '{}')));
$$;

-- His routine on p_day: {day, school_day, points, sections: [{id, title, note, done, total, paid, items: [{id, title,
-- tag, part, done}]}]}, in order. An item for school days only is left out on another day, and a section left with
-- no item with it. points: what each finished section pays (0 while points or the routine's points are off). paid:
-- that day's bonus for the section was paid. Null when nothing shows that day.
create function private.routine_view(p_kid uuid, p_day date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with k as (
    select k.kid_id, case when k.points_on then k.routine_points else 0 end as points, private.routine_school_day(p_day) as school
    from public.homework_kids k where k.kid_id = p_kid
  ),
  i as (
    select it.id, it.section_id, it.pos, it.title, it.tag, it.part,
           exists (select 1 from public.routine_ticks t where t.item_id = it.id and t.day = p_day) as done
    from k
    join public.routine_sections s on s.kid_id = k.kid_id
    join public.routine_items it on it.section_id = s.id
    where k.school or not it.school_days
  ),
  sec as (
    select s.id, s.pos, s.title, s.note,
           count(*) filter (where i.done) as done, count(*) as total,
           exists (select 1 from public.points_ledger l where l.routine_section_id = s.id and l.day = p_day and l.kind = 'routine') as paid,
           jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'tag', i.tag, 'part', i.part, 'done', i.done) order by i.pos) as items
    from public.routine_sections s join i on i.section_id = s.id
    group by s.id, s.pos, s.title, s.note
  )
  select case when exists (select 1 from sec) then
    jsonb_build_object('day', p_day, 'school_day', k.school, 'points', k.points,
      'sections', (select jsonb_agg(jsonb_build_object('id', sec.id, 'title', sec.title, 'note', sec.note, 'done', sec.done,
                                                       'total', sec.total, 'paid', sec.paid, 'items', sec.items) order by sec.pos) from sec))
  end
  from k;
$$;

-- The parents' Homework page: {kid_id, points, sections: [{id, title, note, items: [{id, title, tag, part,
-- school_days}]}], today: routine_view for today (null with nothing to show)}. Null for someone who isn't a member,
-- or a kid without homework.
create function public.routine_status(p_kid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_k public.homework_kids;
begin
  if not private.is_member() then
    return null;
  end if;
  select * into v_k from public.homework_kids k where k.kid_id = p_kid;
  if v_k.kid_id is null then
    return null;
  end if;
  return jsonb_build_object(
    'kid_id', p_kid,
    'points', v_k.routine_points,
    'sections', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'note', s.note,
                                   'items', coalesce((select jsonb_agg(jsonb_build_object('id', it.id, 'title', it.title, 'tag', it.tag,
                                                                                          'part', it.part, 'school_days', it.school_days) order by it.pos)
                                                      from public.routine_items it where it.section_id = s.id), '[]'))
                                   order by s.pos)
                          from public.routine_sections s where s.kid_id = p_kid), '[]'),
    'today', private.routine_view(p_kid, public.today_local()));
end;
$$;

-- The whole routine at once, by a parent: p_sections is [{id?, title, note?, items: [{id?, title, tag?, part?,
-- school_days?}]}], in order; at most 8 sections and 40 items, each section with 1 to 30. A section or item sent with
-- the id it has keeps it (and so today's ticks); one left out is deleted, with its ticks; one without an id (or an id
-- that isn't one of his) is new. Text is tidied (private.clean_text) and cut to the column's length; an empty title
-- is refused. p_points: points for each section he finishes, 0 to 10. Answers routine_status.
create function public.save_routine(p_kid uuid, p_sections jsonb, p_points int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_who   text := public.current_email();
  v_s     jsonb;
  v_i     jsonb;
  v_sid   uuid;
  v_iid   uuid;
  v_spos  int := 0;
  v_ipos  int;
  v_keep_s uuid[] := '{}';
  v_keep_i uuid[] := '{}';
  v_title text;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.homework_kids k where k.kid_id = p_kid) then
    raise exception 'Turn on homework for this kid first.' using errcode = '22023';
  end if;
  if p_points is null or p_points not between 0 and 10 then
    raise exception 'Points for a finished section: 0 to 10.' using errcode = '22023';
  end if;
  if p_sections is null or jsonb_typeof(p_sections) <> 'array' then
    raise exception 'That routine can''t be saved.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_sections) > 8 then
    raise exception 'A routine has at most 8 sections.' using errcode = '22023';
  end if;
  if (select coalesce(sum(jsonb_array_length(case when jsonb_typeof(s -> 'items') = 'array' then s -> 'items' else '[]' end)), 0)
      from jsonb_array_elements(p_sections) s) > 40 then
    raise exception 'A routine has at most 40 items.' using errcode = '22023';
  end if;
  update public.homework_kids k set routine_points = p_points where k.kid_id = p_kid and k.routine_points is distinct from p_points;

  for v_s in select x from jsonb_array_elements(p_sections) x loop
    v_spos := v_spos + 1;
    v_title := nullif(private.clean_text(v_s ->> 'title', 40), '');
    if jsonb_typeof(v_s) <> 'object' or v_title is null then
      raise exception 'Each section needs a title.' using errcode = '22023';
    end if;
    if jsonb_typeof(v_s -> 'items') is distinct from 'array' or jsonb_array_length(v_s -> 'items') not between 1 and 30 then
      raise exception 'Each section needs 1 to 30 items.' using errcode = '22023';
    end if;
    v_sid := null;
    if (v_s ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select s.id into v_sid from public.routine_sections s where s.id = (v_s ->> 'id')::uuid and s.kid_id = p_kid;
    end if;
    if v_sid is null then
      insert into public.routine_sections (kid_id, pos, title, note, created_by, updated_by)
      values (p_kid, v_spos, v_title, nullif(private.clean_text(v_s ->> 'note', 40), ''), v_who, v_who)
      returning id into v_sid;
    else
      update public.routine_sections s
      set pos = v_spos, title = v_title, note = nullif(private.clean_text(v_s ->> 'note', 40), ''), updated_at = now(), updated_by = v_who
      where s.id = v_sid
        and (s.pos, s.title, s.note) is distinct from (v_spos, v_title, nullif(private.clean_text(v_s ->> 'note', 40), ''));
    end if;
    v_keep_s := v_keep_s || v_sid;

    v_ipos := 0;
    for v_i in select x from jsonb_array_elements(v_s -> 'items') x loop
      v_ipos := v_ipos + 1;
      v_title := nullif(private.clean_text(v_i ->> 'title', 80), '');
      if jsonb_typeof(v_i) <> 'object' or v_title is null then
        raise exception 'Each item needs a title.' using errcode = '22023';
      end if;
      v_iid := null;
      if (v_i ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select it.id into v_iid from public.routine_items it join public.routine_sections s on s.id = it.section_id
        where it.id = (v_i ->> 'id')::uuid and s.kid_id = p_kid and not (it.id = any (v_keep_i));
      end if;
      if v_iid is null then
        insert into public.routine_items (section_id, pos, title, tag, part, school_days)
        values (v_sid, v_ipos, v_title, nullif(private.clean_text(v_i ->> 'tag', 24), ''), nullif(private.clean_text(v_i ->> 'part', 24), ''),
                coalesce((v_i ->> 'school_days')::boolean, false))
        returning id into v_iid;
      else
        update public.routine_items it
        set section_id = v_sid, pos = v_ipos, title = v_title, tag = nullif(private.clean_text(v_i ->> 'tag', 24), ''),
            part = nullif(private.clean_text(v_i ->> 'part', 24), ''), school_days = coalesce((v_i ->> 'school_days')::boolean, false)
        where it.id = v_iid;
      end if;
      v_keep_i := v_keep_i || v_iid;
    end loop;
  end loop;

  delete from public.routine_items it using public.routine_sections s
  where it.section_id = s.id and s.kid_id = p_kid and not (it.id = any (v_keep_i));
  delete from public.routine_sections s where s.kid_id = p_kid and not (s.id = any (v_keep_s));
  return public.routine_status(p_kid);
exception
  when invalid_text_representation then
    raise exception 'That routine can''t be saved.' using errcode = '22023';
end;
$$;

-- His My day: tick (p_done true) or untick an item today. Only his own items, and one for school days only on a
-- school day. A tick that finishes its section pays the routine bonus (homework_kids.routine_points, when points are
-- on), once a section a day: unticking keeps it, and ticking again pays nothing more. Each change counts as a write
-- (private.count_homework, 150 a day); ticks older than 30 days go. Answers get_person_day(p_token) with 'paid', the
-- points this tick paid (0). Null for a token that isn't a kid's with homework on.
create function public.routine_tick_by_token(p_token text, p_item uuid, p_done boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me      public.people;
  v_today date := public.today_local();
  v_sid   uuid;
  v_title text;
  v_only  boolean;
  v_k     public.homework_kids;
  v_n     int;
  v_paid  int := 0;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if p_done is null then
    raise exception 'Choose done or not done.' using errcode = '22023';
  end if;
  select s.id, s.title, it.school_days into v_sid, v_title, v_only
  from public.routine_items it join public.routine_sections s on s.id = it.section_id
  where it.id = p_item and s.kid_id = me.id;
  if v_sid is null then
    raise exception 'That isn''t on your routine.' using errcode = '42501';
  end if;
  if v_only and not private.routine_school_day(v_today) then
    raise exception 'That one is for school days.' using errcode = '22023';
  end if;
  if p_done then
    insert into public.routine_ticks (item_id, day, at, who) values (p_item, v_today, private.now(), private.short_name(me) || ' (My day)')
    on conflict do nothing;
  else
    delete from public.routine_ticks t where t.item_id = p_item and t.day = v_today;
  end if;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform private.count_homework(me.id, 'writes', 150);
  end if;

  -- The section finished (every item it shows today ticked): its bonus, once a day.
  if p_done and not exists (select 1 from public.routine_items it
                            where it.section_id = v_sid and (not it.school_days or private.routine_school_day(v_today))
                              and not exists (select 1 from public.routine_ticks t where t.item_id = it.id and t.day = v_today)) then
    select * into v_k from public.homework_kids k where k.kid_id = me.id for update;
    if v_k.points_on and v_k.routine_points > 0 then
      insert into public.points_ledger (kid_id, at, day, kind, delta, note, who, routine_section_id)
      values (me.id, private.now(), v_today, 'routine', v_k.routine_points, v_title, private.short_name(me) || ' (My day)', v_sid)
      on conflict do nothing;
      get diagnostics v_n = row_count;
      if v_n > 0 then
        v_paid := v_k.routine_points;
      end if;
    end if;
  end if;

  delete from public.routine_ticks t using public.routine_items it, public.routine_sections s
  where t.item_id = it.id and it.section_id = s.id and s.kid_id = me.id and t.day < v_today - 30;
  return public.get_person_day(p_token) || jsonb_build_object('paid', v_paid);
end;
$$;

-- ---------------------------------------------------------------------
-- My day (§24.4), replaced
-- ---------------------------------------------------------------------
-- 0005's get_person_day, word for word, but (0019) a 'routine' key (private.routine_view for today) for a kid with
-- homework on whose routine shows something today; left out otherwise, so every other answer is as on 18.
create or replace function public.get_person_day(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me    public.people;
  today date := public.today_local();
  v_mode text;   -- v1.2
  v_card jsonb;  -- v1.3
  v_routine jsonb;   -- v1.3, 0019
begin
  me := private.person_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  select h.helper_list into v_mode from public.household h;   -- v1.2
  -- v1.3: the homework card, for a kid with homework on.
  if me.role = 'kid' and exists (select 1 from public.homework_kids k where k.kid_id = me.id and k.active) then
    v_card := private.homework_card(me.id, me.language);
    v_routine := private.routine_view(me.id, today);   -- 0019
  end if;

  return jsonb_build_object(
    'person', jsonb_build_object('name', me.name, 'language', me.language,
                                 'digest_enabled', me.digest_enabled,
                                 'email_confirmed', me.email_verified_at is not null),
    'today', today,
    'days', (select jsonb_agg(jsonb_build_object(
                      'day', d.day,
                      'items', coalesce((select jsonb_agg(private.my_day_item(a, me.id, me.language)
                                                          order by private.item_order(a), a.local_start, a.title)
                                         from private.person_items(me.id, d.day) a), '[]'))
                      -- v1.2: the day's meals, left out when there are none.
                      || coalesce((select jsonb_build_object('meals', jsonb_agg(
                                            jsonb_build_object(
                                              'slot', m.slot,
                                              'label', private.food_word(m.slot, me.language),
                                              'title', case when m.private and not x.mine then private.word('private_item', me.language)
                                                            else private.meal_title(m, me.language) end,
                                              'cook', case when c.id is not null then private.short_name(c) end,
                                              'cook_word', case when c.id is null then null
                                                                when x.mine then private.food_word(case when m.kind = 'cook' then 'you_cook'
                                                                                                        else 'you_on_dinner' end, me.language)
                                                                else replace(private.food_word(case when m.kind = 'cook' then 'cooks'
                                                                                                    else 'on_dinner' end, me.language),
                                                                             '{name}', private.short_name(c)) end,
                                              'mine', x.mine)
                                            || case when x.mine then jsonb_strip_nulls(jsonb_build_object('note', m.note, 'link', m.link))
                                                    else '{}' end
                                            order by array_position(array['breakfast', 'lunch', 'dinner'], m.slot), m.id))
                                   from public.meals m
                                   left join public.people c on c.id = m.cook_id and c.active
                                   cross join lateral (select coalesce(c.id = me.id, false) as mine) x
                                   where m.day = d.day
                                   having count(*) > 0), '{}')
                    order by d.day)
             from (values (today), (today + 1)) d (day)),
    'late', coalesce((select jsonb_agg(private.my_day_item(i, me.id, me.language) order by cd.due, t.title)
                      from public.tasks t
                      cross join lateral (select private.current_due(t) as due) cd
                      cross join lateral private.task_item(t, cd.due, 'late') i
                      where t.responsible_id = me.id and t.active and t.done_at is null and cd.due < today),
                     '[]'))
    -- v1.2: the list button, for a helper while the list is on her My day, once anyone has
    -- added the first item (so the same-output check is unchanged).
    || case when me.role = 'helper' and coalesce(v_mode, 'off') <> 'off' and exists (select 1 from public.shopping_items)
            then jsonb_build_object('list', jsonb_build_object(
                   'to_buy', (select count(*) from public.shopping_items i where i.bought_at is null and not i.private)))
            else '{}' end
    -- v1.3: the homework card, left out unless homework is on for this kid.
    || case when v_card is not null then jsonb_build_object('homework', v_card) else '{}' end
    -- 0019: his routine, left out unless it shows something today.
    || case when v_routine is not null then jsonb_build_object('routine', v_routine) else '{}' end;
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages offer the routine only on 19. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 19;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------
-- His My day: his token is the key (as school_item_by_token).
revoke execute on function public.routine_tick_by_token(text, uuid, boolean) from public, service_role;
grant  execute on function public.routine_tick_by_token(text, uuid, boolean) to anon, authenticated;
-- The parents' Homework page.
revoke execute on function public.routine_status(uuid)                      from public, anon, service_role;
grant  execute on function public.routine_status(uuid)                      to authenticated;
revoke execute on function public.save_routine(uuid, jsonb, int)            from public, anon, service_role;
grant  execute on function public.save_routine(uuid, jsonb, int)            to authenticated;
-- Private: the definer functions above call them; nobody else.
revoke execute on function private.routine_school_day(date)                 from public, anon, authenticated;
revoke execute on function private.routine_view(uuid, date)                 from public, anon, authenticated;

commit;
