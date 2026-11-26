-- =====================================================================
-- HOME HUB v2 — migration 0041: the gift switch (a birthday with "Remind me to buy a gift" off shows its 🎂 on the
-- day, and never a "🎁 Gift for …" reminder)
-- Apply once, after 0040, and only once the site that understands it is live (docs/v2-design.md §47).
-- No Edge Function and no cron.sql change.
-- The contract is docs/v2-design.md §47.
--
-- Why
--   Every birthday on 0040's list got a gift reminder a week ahead. A long list (cousins, friends, the wider family)
--   would bury the few reminders that matter under ones nobody means to act on.
--
-- What it adds
--   • birthdays.gift (true): "Remind me to buy a gift". Off, the birthday still shows on the Calendar, on Today and in
--     the morning email on the day; it never shows as a gift. A parent sets it with the rest (a column grant).
--   • private.gifts_for(date, uuid): 0040's, for birthdays with gift on only. gift_heads_up and digest_for call it by
--     name, so both follow with no change of their own.
--   • hub_schema_version() (41). The Birthdays page shows the switch only on 41.
--
-- Rules
--   • One transaction. It refuses to run without 0040, twice, on a database set back to 40 (the column already there),
--     or on one that isn't as 0040 left it.
--   • Additive: one column with a default (every birthday keeps its reminder), and a replaced function.
--   • set search_path = '' on every function; create or replace keeps the grants.
--
-- Undo (not needed: every birthday keeps its reminder until someone turns one off). If wanted, in one go:
--   0040's private.gifts_for ("create function private.gifts_for", to its "$$;", as create or replace);
--   alter table public.birthdays drop column gift;
--   then 0040's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0040 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 40 then
    raise exception 'Birthdays (migration 0040) isn''t installed (hub_schema_version() is %). Run 0040_birthdays.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 41 then
    raise exception 'The gift switch (migration 0041) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.birthdays'::regclass and a.attname = 'gift' and not a.attisdropped) then
    raise exception 'The gift switch (migration 0041) is already installed, but hub_schema_version() was set back to 40. To switch it on again, make hub_schema_version() return 41 (docs/v2-design.md §47). Nothing was changed.';
  end if;
  -- What this migration reads and changes is as 0040 left it.
  if to_regprocedure('private.gifts_for(date, uuid)') is null
     or to_regprocedure('public.gift_heads_up(date)') is null
     or to_regprocedure('private.digest_for_v39(uuid, date)') is null
     or to_regprocedure('private.birthday_on(integer, integer, integer)') is null
     or to_regclass('public.birthday_gifts') is null then
    raise exception 'This database isn''t as migration 0040 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The switch (§47.2)
-- ---------------------------------------------------------------------
alter table public.birthdays add column gift boolean not null default true;
grant insert (gift), update (gift) on public.birthdays to authenticated;

-- 0040's, for birthdays whose gift reminder is on.
create or replace function private.gifts_for(p_day date, p_except uuid)
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
  where b.gift
    and d.day between p_day and p_day + 7
    and (p_except is null or b.person_id is distinct from p_except)
  order by d.day, b.name, b.id;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Birthdays page shows the switch only on 41. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 41;
$$;

commit;
