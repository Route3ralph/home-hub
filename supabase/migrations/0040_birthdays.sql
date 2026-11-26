-- =====================================================================
-- HOME HUB v2 — migration 0040: Birthdays (a list on the Family page, a 🎂 line on the Calendar on the day, and a
-- "Gift for …" heads-up a week before, with a Bought tick, hidden from the person whose birthday it is)
-- Apply once, after 0039, and only once the site that understands it is live (docs/v2-design.md §46).
-- No Edge Function and no cron.sql change: the morning email already lays out digest_for's heads-up and today.
-- The contract is docs/v2-design.md §46.
--
-- Why
--   The family wanted the birthdays in one place, on the calendar, and a warning a week ahead to buy a present.
--   A yearly repeating task did part of it, but had no list, no age and no way to keep a gift from its recipient.
--
-- What it adds
--   • public.birthdays: a name, a month and day, an optional year of birth, and optionally the person on the
--     family list it is for (who is then never told about their own gift). Every member reads it (the Calendar);
--     only an admin (a parent who signs in) adds, changes or deletes one. Never a guest.
--   • public.birthday_gifts: one row per birthday and year once a parent ticks Bought. Read only through the
--     functions below, so a person can't see whether their own present is bought.
--   • public.birthdays_between(p_from date, p_to date) returns jsonb: the birthdays on those days (at most 400),
--     [{id, name, day, turns, person_id}], oldest first. A 29 February birthday is on 28 February in other years.
--   • public.gift_heads_up(p_day date) returns jsonb: an admin's gifts due, [{id, name, birthday, turns, year,
--     bought}]: each birthday from p_day to 7 days ahead, except the caller's own. Anyone else: [].
--   • public.set_birthday_gift(p_id uuid, p_year int, p_bought boolean): an admin ticks or unticks Bought; never on
--     their own birthday.
--   • Replaced, with the same signature and grant (service_role): public.digest_for(uuid, date) (0004's, renamed
--     private.digest_for_v39 and kept as it is) is a wrapper. A parent's email gets each gift not yet bought in
--     Heads-up ("Gift for Sam · birthday Sun Dec 6"); everyone's gets "🎂 Sam's birthday" (or "🎂 Sam turns 12") in
--     Today on the day. Neither goes to the person whose birthday it is. A day with only these is no longer empty.
--   • hub_schema_version() (40). The Family, Calendar and Today pages show birthdays only on 40.
--
-- Rules
--   • One transaction. It refuses to run without 0039, twice, on a database set back to 39 (the table already
--     there), or on one that isn't as 0039 left it.
--   • Additive: two new tables and functions, and a wrapper whose 0039 email is unchanged when no birthday is near.
--   • RLS on both tables; set search_path = '' on every function; revoke then grant.
--   • Not on My day, the wall, the family board, Google, the tutor link, the share link or a guest's page.
--
-- Undo (not needed: nothing shows until a birthday is added). If wanted, in one go:
--   drop function public.digest_for(uuid, date);
--   alter function private.digest_for_v39(uuid, date) set schema public;
--   alter function public.digest_for_v39(uuid, date) rename to digest_for;
--   grant execute on function public.digest_for(uuid, date) to service_role;
--   drop function public.set_birthday_gift(uuid, int, boolean);
--   drop function public.gift_heads_up(date);
--   drop function public.birthdays_between(date, date);
--   drop function private.gifts_for(date, uuid);
--   drop function private.birthday_word(text, text);
--   drop function private.birthday_on(int, int, int);
--   drop table public.birthday_gifts;
--   drop table public.birthdays;
--   drop function private.birthday_tidy();
--   then 0039's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0039 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 39 then
    raise exception 'Paste grades (migration 0039) isn''t installed (hub_schema_version() is %). Run 0039_paste_grades.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 40 then
    raise exception 'Birthdays (migration 0040) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.birthdays') is not null then
    raise exception 'Birthdays (migration 0040) is already installed, but hub_schema_version() was set back to 39. To switch it on again, make hub_schema_version() return 40 (docs/v2-design.md §46). Nothing was changed.';
  end if;
  -- What this migration reads and changes is as 0039 left it.
  if to_regprocedure('public.digest_for(uuid, date)') is null
     or to_regprocedure('private.digest_for_v39(uuid, date)') is not null
     or to_regprocedure('public.paste_grades(uuid, jsonb, boolean)') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('private.is_member()') is null
     or to_regprocedure('private.stamp()') is null
     or to_regprocedure('private.clean_text(text, integer)') is null
     or to_regprocedure('private.day_label(date, text)') is null
     or to_regprocedure('private.word(text, text)') is null
     or to_regprocedure('public.today_local()') is null
     or to_regclass('public.birthday_gifts') is not null then
    raise exception 'This database isn''t as migration 0039 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The list (§46.2)
-- ---------------------------------------------------------------------
create table public.birthdays (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),   -- cleaned to one line: "Grandma Pat"
  month       int not null check (month between 1 and 12),
  day         int not null check (day between 1 and 31),
  born_year   int check (born_year is null or born_year between 1900 and 2100),   -- for "turns 12"; optional
  person_id   uuid references public.people (id) on delete set null,   -- who it is, when they're on the family list
  created_at  timestamptz not null default now(),
  created_by  text,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  check (day <= case when month = 2 then 29 when month in (4, 6, 9, 11) then 30 else 31 end),
  check (born_year is null or not (month = 2 and day = 29)
         or (born_year % 4 = 0 and (born_year % 100 <> 0 or born_year % 400 = 0)))
);
create unique index birthdays_person on public.birthdays (person_id) where person_id is not null;

create function private.birthday_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := private.clean_text(new.name, 60);
  return new;
end;
$$;

-- Same-event triggers fire in name order: birthdays_stamp runs before birthdays_tidy.
create trigger birthdays_stamp before insert or update on public.birthdays
  for each row execute function private.stamp();
create trigger birthdays_tidy before insert or update on public.birthdays
  for each row execute function private.birthday_tidy();

-- A gift ticked Bought: one row per birthday and the year of that birthday.
create table public.birthday_gifts (
  birthday_id uuid not null references public.birthdays (id) on delete cascade,
  year        int not null check (year between 1900 and 2100),
  bought_at   timestamptz not null default now(),
  bought_by   text,
  primary key (birthday_id, year)
);

-- ---------------------------------------------------------------------
-- Row-level security and grants (§46.3)
-- ---------------------------------------------------------------------
alter table public.birthdays enable row level security;
alter table public.birthday_gifts enable row level security;

create policy "Family reads the birthdays" on public.birthdays
  for select to authenticated using (private.is_member());
create policy "Parents add birthdays" on public.birthdays
  for insert to authenticated with check (private.is_admin());
create policy "Parents change birthdays" on public.birthdays
  for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy "Parents delete birthdays" on public.birthdays
  for delete to authenticated using (private.is_admin());

-- Supabase's default privileges give anon and authenticated everything on a new table. Members get the list's own
-- columns, never the audit columns; hub-jobs (service_role) reads it for the morning email; nobody reads the gift
-- ticks but the functions below.
revoke all on public.birthdays from public, anon, authenticated, service_role;
grant select, delete on public.birthdays to authenticated;
grant select on public.birthdays to service_role;
grant insert (id, name, month, day, born_year, person_id),
      update (name, month, day, born_year, person_id) on public.birthdays to authenticated;
revoke all on public.birthday_gifts from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Readers (§46.4)
-- ---------------------------------------------------------------------
-- The day of a birthday in year y: 29 February is 28 February when y isn't a leap year.
create function private.birthday_on(p_month int, p_day int, p_year int)
returns date
language sql
immutable
set search_path = ''
as $$
  select make_date(p_year, p_month,
                   case when p_month = 2 and p_day = 29
                             and not (p_year % 4 = 0 and (p_year % 100 <> 0 or p_year % 400 = 0)) then 28
                        else p_day end);
$$;

-- The few words birthdays need, in English and Spanish.
create function private.birthday_word(p_key text, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(w -> p_lang ->> p_key, w -> 'en' ->> p_key, p_key)
  from (select '{
    "en": {"gift_for": "🎁 Gift for {name}", "birthday_on": "birthday {d}", "birthday": "🎂 {name}''s birthday",
           "turns": "🎂 {name} turns {n}"},
    "es": {"gift_for": "🎁 Regalo para {name}", "birthday_on": "cumpleaños {d}", "birthday": "🎂 Cumpleaños de {name}",
           "turns": "🎂 {name} cumple {n}"}
  }'::jsonb as w) dictionary;
$$;

-- The birthdays on the days from p_from to p_to (at most 400 days), oldest first, then by name. A member's call:
-- the list's RLS applies (security invoker).
create function public.birthdays_between(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Pick up to 400 days, the first one first.' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'day', d.day,
                                        'turns', case when b.born_year is not null and y.y > b.born_year then y.y - b.born_year end,
                                        'person_id', b.person_id)
                     order by d.day, b.name, b.id)
    from public.birthdays b
    cross join generate_series(extract(year from p_from)::int, extract(year from p_to)::int) y(y)
    cross join lateral (select private.birthday_on(b.month, b.day, y.y) as day) d
    where d.day between p_from and p_to), '[]'::jsonb);
end;
$$;

-- Gifts due on p_day: each birthday from p_day to 7 days ahead, except p_except's own (when given).
create function private.gifts_for(p_day date, p_except uuid)
returns table (id uuid, name text, person_id uuid, birthday date, turns int, year int, bought boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.name, b.person_id, d.day,
         case when b.born_year is not null and y.y > b.born_year then y.y - b.born_year end,
         y.y,
         exists (select 1 from public.birthday_gifts g where g.birthday_id = b.id and g.year = y.y)
  from public.birthdays b
  cross join (values (extract(year from p_day)::int), (extract(year from p_day)::int + 1)) y(y)
  cross join lateral (select private.birthday_on(b.month, b.day, y.y) as day) d
  where d.day between p_day and p_day + 7
    and (p_except is null or b.person_id is distinct from p_except)
  order by d.day, b.name, b.id;
$$;

-- The Today page's gifts: an admin's, never their own; anyone else gets none.
create function public.gift_heads_up(p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
begin
  if not private.is_admin() then
    return '[]'::jsonb;
  end if;
  select p.id into v_me from public.people p where p.email = public.current_email() limit 1;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'birthday', g.birthday, 'turns', g.turns,
                                        'year', g.year, 'bought', g.bought) order by g.birthday, g.name, g.id)
    from private.gifts_for(coalesce(p_day, public.today_local()), v_me) g), '[]'::jsonb);
end;
$$;

-- Bought (or not) for that birthday's year. An admin, never for their own birthday.
create function public.set_birthday_gift(p_id uuid, p_year int, p_bought boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b    public.birthdays;
  v_me uuid;
  v_y  int := extract(year from public.today_local())::int;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can mark a gift bought.' using errcode = '42501';
  end if;
  select * into b from public.birthdays x where x.id = p_id;
  if b.id is null then
    raise exception 'That birthday isn''t on the list any more.' using errcode = '22023';
  end if;
  select p.id into v_me from public.people p where p.email = public.current_email() limit 1;
  if b.person_id is not null and b.person_id = v_me then
    raise exception 'That''s your own birthday: someone else keeps track of this present.' using errcode = '42501';
  end if;
  if p_year is null or p_year not between v_y - 1 and v_y + 1 then
    raise exception 'That isn''t this year''s birthday.' using errcode = '22023';
  end if;
  if coalesce(p_bought, false) then
    insert into public.birthday_gifts (birthday_id, year, bought_by)
    values (b.id, p_year, nullif(public.current_email(), ''))
    on conflict (birthday_id, year) do nothing;
  else
    delete from public.birthday_gifts g where g.birthday_id = b.id and g.year = p_year;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The morning email (§46.5)
-- ---------------------------------------------------------------------
-- 0004's digest_for keeps its body and its grant (service_role only), as private.digest_for_v39.
alter function public.digest_for(uuid, date) rename to digest_for_v39;
alter function public.digest_for_v39(uuid, date) set schema private;

-- Everything the morning email needs: 0039's email, plus birthdays.
--   1. No birthday on p_local_date and no gift due for a parent: exactly 0039's email.
--   2. On the day, "🎂 Sam's birthday" ("🎂 Sam turns 12") at the top of Today, for everyone but Sam.
--   3. For a parent, each gift not yet bought in Heads-up: "Gift for Sam" · "birthday Sun Dec 6", from 7 days
--      before to the day itself, never their own.
--   4. A day 0039 called "Nothing planned" (nothing in Today or Late) is named by its first birthday line instead,
--      and a day with only these is not empty.
create function public.digest_for(p_person uuid, p_local_date date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  j      jsonb := private.digest_for_v39(p_person, p_local_date);
  me     public.people;
  lang   text;
  v_day  jsonb;
  v_gift jsonb;
begin
  if j is null then
    return j;
  end if;
  select * into me from public.people p where p.id = p_person;
  lang := case when me.language = 'es' then 'es' else 'en' end;

  select jsonb_agg(jsonb_build_object(
           'kind', 'birthday', 'item_id', b.id, 'occurrence', p_local_date,
           'time', private.word('all_day', lang),
           'title', replace(replace(private.birthday_word(case when b.born_year is not null and extract(year from p_local_date)::int > b.born_year
                                                               then 'turns' else 'birthday' end, lang),
                                    '{name}', b.name),
                            '{n}', coalesce((extract(year from p_local_date)::int - b.born_year)::text, '')),
           'detail', null, 'contractor_phone', null, 'status', 'open') order by b.name, b.id)
  into v_day
  from public.birthdays b
  where private.birthday_on(b.month, b.day, extract(year from p_local_date)::int) = p_local_date
    and b.person_id is distinct from me.id;

  if me.role = 'parent' then
    select jsonb_agg(jsonb_build_object(
             'kind', 'gift', 'item_id', g.id, 'occurrence', g.birthday, 'time', null,
             'title', replace(private.birthday_word('gift_for', lang), '{name}', g.name),
             'detail', replace(private.birthday_word('birthday_on', lang), '{d}', private.day_label(g.birthday, lang)),
             'contractor_phone', null, 'status', 'open') order by g.birthday, g.name, g.id)
    into v_gift
    from private.gifts_for(p_local_date, me.id) g
    where not g.bought;
  end if;

  if v_day is null and v_gift is null then
    return j;
  end if;

  if jsonb_array_length(coalesce(j -> 'today', '[]')) = 0 and jsonb_array_length(coalesce(j -> 'late', '[]')) = 0 then
    j := jsonb_set(j, '{subject}', to_jsonb((j ->> 'date_label') || ': ' || (coalesce(v_day, v_gift) -> 0 ->> 'title')));
  end if;
  if v_day is not null then
    j := jsonb_set(j, '{today}', v_day || coalesce(j -> 'today', '[]'));
  end if;
  if v_gift is not null then
    j := jsonb_set(j, '{heads_up}', coalesce(j -> 'heads_up', '[]') || v_gift);
  end if;
  return jsonb_set(j, '{empty}', 'false'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.birthday_tidy()                                    from public, anon, authenticated, service_role;
revoke execute on function private.birthday_on(int, int, int)                         from public, anon, authenticated, service_role;
revoke execute on function private.birthday_word(text, text)                          from public, anon, authenticated, service_role;
revoke execute on function private.gifts_for(date, uuid)                              from public, anon, authenticated, service_role;
grant  execute on function private.birthday_on(int, int, int)                         to authenticated, service_role;
grant  execute on function private.birthday_word(text, text)                          to service_role;
grant  execute on function private.gifts_for(date, uuid)                              to service_role;

revoke execute on function public.birthdays_between(date, date)                       from public, anon, service_role;
grant  execute on function public.birthdays_between(date, date)                       to authenticated;
revoke execute on function public.gift_heads_up(date)                                 from public, anon, service_role;
grant  execute on function public.gift_heads_up(date)                                 to authenticated;
revoke execute on function public.set_birthday_gift(uuid, int, boolean)               from public, anon, service_role;
grant  execute on function public.set_birthday_gift(uuid, int, boolean)               to authenticated;

-- hub-jobs: the new digest_for, as 0004's was; its old body is for nobody but the wrapper.
revoke execute on function public.digest_for(uuid, date)                              from public, anon, authenticated;
grant  execute on function public.digest_for(uuid, date)                              to service_role;
revoke execute on function private.digest_for_v39(uuid, date)                         from public, anon, authenticated;
grant  execute on function private.digest_for_v39(uuid, date)                         to service_role;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Family, Calendar and Today pages show birthdays only on 40. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 40;
$$;

commit;
