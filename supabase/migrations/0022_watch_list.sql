-- =====================================================================
-- HOME HUB v2 — migration 0022: the watch list (movies and shows the family wants to see)
-- Apply once, after 0021, and only once the site that understands it is live (docs/v2-design.md §27).
-- The contract is docs/v2-design.md §27.
--
-- Why
--   Movies and shows the family wants to watch got lost in chats: one on Netflix, one in cinemas until the 20th, a
--   musical at the theatre. One shared list on its own page, Watch, that a kid can add to from his My day too.
--
-- What it adds
--   • Table: public.watch_items (a title, movie or show, where: Netflix, another streaming service, the cinema or a
--     theatre, the service's name, an optional https link, a note, the last day it's showing, and when it was
--     watched). Every family member reads and changes it (private.is_member()); a project guest never sees it.
--   • watch_by_token(p_token text) (a kid's My day): the list not yet watched, newest first, with titles, kinds and
--     places only (never a link, a note or who added what but "mine").
--   • watch_add_by_token(p_token text, p_title text, p_kind text, p_place text, p_key uuid) (a kid's My day): adds
--     one, written as "<his first name> (My day)"; one of his My day changes (30 a day). Answers watch_by_token's.
--   • Replaced, with the same signature and grants: public.get_person_day(text) (0019's, renamed
--     private.get_person_day_v21 and kept as it is, for nobody) is a wrapper that adds, for an active kid once the list
--     has anything on it, 'watch': how many are still to watch, so his My day shows its button only from 22 and only
--     once someone has added one. Every other answer, and every answer while the list is empty, is exactly 21's.
--   • hub_schema_version() (22). The Watch page and his My day's card show only on 22.
--
-- Rules
--   • One transaction. It refuses to run without 0021, twice, on a database set back to 21 (the table already there),
--     or on one that isn't as 0021 left it.
--   • RLS on the new table. set search_path = '' on every function; revoke then grant.
--   • Nothing about the watch list reaches an email, the wall, the board, Google, a tutor link or a guest.
--
-- Undo (not needed: with nothing on the list, every page is as on 21). If wanted, in one go:
--   drop function public.watch_add_by_token(text, text, text, text, uuid);
--   drop function public.watch_by_token(text);
--   drop function private.watch_view(uuid);
--   drop function public.get_person_day(text);
--   alter function private.get_person_day_v21(text) set schema public;
--   alter function public.get_person_day_v21(text) rename to get_person_day;
--   grant execute on function public.get_person_day(text) to anon, authenticated;
--   drop table public.watch_items;
--   drop function private.watch_tidy();
--   then 0021's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;"). The list
--   goes with it.
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0021 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 21 then
    raise exception 'The coach (migration 0021) isn''t installed (hub_schema_version() is %). Run 0021_coach.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 22 then
    raise exception 'The watch list (migration 0022) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.watch_items') is not null then
    raise exception 'The watch list (migration 0022) is already installed, but hub_schema_version() was set back to 21. To switch it on again, make hub_schema_version() return 22 (docs/v2-design.md §27). Nothing was changed.';
  end if;
  -- What this migration reads and calls is as 0021 left it.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'people' and column_name = 'coach')
     or to_regprocedure('public.can_coach()') is null
     or to_regprocedure('private.is_member()') is null
     or to_regprocedure('private.stamp()') is null
     or to_regprocedure('private.clean_text(text, int)') is null
     or to_regprocedure('private.person_by_token(text)') is null
     or to_regprocedure('private.count_my_day(uuid, text)') is null
     or to_regprocedure('private.short_name(public.people)') is null
     or to_regprocedure('public.get_person_day(text)') is null
     or to_regprocedure('private.get_person_day_v21(text)') is not null
     or to_regprocedure('private.watch_tidy()') is not null then
    raise exception 'This database isn''t as migration 0021 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The table (§27.2)
-- ---------------------------------------------------------------------
-- One movie or show the family wants to see. Kept until someone deletes it; watched ones fold away on the page.
create table public.watch_items (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (char_length(title) between 1 and 100),   -- cleaned to one line
  kind          text not null default 'movie' check (kind in ('movie', 'show')),
  place         text not null default 'netflix' check (place in ('netflix', 'streaming', 'cinema', 'theatre')),
  service       text check (service is null or char_length(service) between 1 and 40),   -- "Disney+", "AMC", "Lyric Theatre"
  url           text check (url is null or (url ~ '^https://[!#-;=?-~]{4,}$' and char_length(url) <= 508)),   -- as recipes.url
  note          text check (note is null or char_length(note) between 1 and 200),   -- "PG-13 · Max and Leo"
  showing_until date,                                                               -- the cinema's or theatre's last day
  watched_at    timestamptz,                                                        -- null: still to watch
  created_at    timestamptz not null default now(),
  created_by    text,                                                               -- an email, or "Max (My day)"
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create index watch_items_open on public.watch_items (created_at desc) where watched_at is null;

-- Same-event triggers fire in name order: watch_items_stamp runs before watch_items_tidy.
create function private.watch_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := private.clean_text(new.title, 100);
  new.service := nullif(private.clean_text(new.service, 40), '');
  new.note := nullif(private.clean_text(new.note, 200), '');
  return new;
end;
$$;

create trigger watch_items_stamp before insert or update on public.watch_items
  for each row execute function private.stamp();
create trigger watch_items_tidy before insert or update on public.watch_items
  for each row execute function private.watch_tidy();

-- ---------------------------------------------------------------------
-- Row-level security and grants (§27.3)
-- ---------------------------------------------------------------------
alter table public.watch_items enable row level security;

create policy "Family manages the watch list" on public.watch_items
  for all to authenticated using (private.is_member()) with check (private.is_member());

-- Supabase's default privileges give anon and authenticated everything on a new table. Anon and service_role get
-- nothing (the My day functions are definers); members get the table's own columns, never the audit columns.
revoke all on public.watch_items from public, anon, authenticated, service_role;
grant select, delete on public.watch_items to authenticated;
grant insert (id, title, kind, place, service, url, note, showing_until, watched_at),
      update (title, kind, place, service, url, note, showing_until, watched_at) on public.watch_items to authenticated;

-- ---------------------------------------------------------------------
-- A kid's My day (§27.4)
-- ---------------------------------------------------------------------
-- The list not yet watched, newest first (at most 50): titles, kinds, places and the service, and whether he added
-- it. Never a link, a note or anyone's name.
create function private.watch_view(p_kid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id, 'title', w.title, 'kind', w.kind, 'place', w.place, 'service', w.service,
           'showing_until', w.showing_until,
           'mine', w.created_by = (select private.short_name(p) || ' (My day)' from public.people p where p.id = p_kid))
         order by w.created_at desc, w.id), '[]'::jsonb))
  from (select * from public.watch_items x where x.watched_at is null order by x.created_at desc, x.id limit 50) w;
$$;

-- His list, or null for a token that isn't an active kid's.
create function public.watch_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.people := private.person_by_token(p_token);
begin
  if me.id is null or me.role <> 'kid' then
    return null;
  end if;
  return private.watch_view(me.id);
end;
$$;

-- He adds one: a title (1 to 100 after cleaning), movie or show, and where. p_key is the row's id: a resend adds
-- nothing more. One of his My day changes (30 a day). Answers his list; null for a token that isn't an active kid's.
create function public.watch_add_by_token(p_token text, p_title text, p_kind text, p_place text, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me      public.people := private.person_by_token(p_token);
  v_title text := private.clean_text(p_title, 100);
  v_who   text;
begin
  if me.id is null or me.role <> 'kid' then
    return null;
  end if;
  if p_key is null then
    raise exception 'It needs its id.' using errcode = '22023';
  end if;
  if char_length(p_title) > 200 then
    raise exception 'That''s too long.' using errcode = '22023';
  end if;
  if coalesce(v_title, '') = '' then
    raise exception 'Write what you want to watch.' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('movie', 'show') then
    raise exception 'Choose a movie or a show.' using errcode = '22023';
  end if;
  if p_place is null or p_place not in ('netflix', 'streaming', 'cinema', 'theatre') then
    raise exception 'Choose where.' using errcode = '22023';
  end if;
  v_who := private.short_name(me) || ' (My day)';
  if exists (select 1 from public.watch_items w where w.id = p_key) then
    if not exists (select 1 from public.watch_items w where w.id = p_key and w.created_by = v_who) then
      raise exception 'That id is taken.' using errcode = '22023';
    end if;
    return private.watch_view(me.id);
  end if;
  perform private.count_my_day(me.id, 'changes');
  insert into public.watch_items (id, title, kind, place, created_by, updated_by)
  values (p_key, v_title, p_kind, p_place, v_who, v_who);
  return private.watch_view(me.id);
end;
$$;

-- His day: 21's answer, plus for an active kid, once the list has anything on it, 'watch': how many are still to watch
-- (his My day's button). While the list is empty every answer is exactly 21's.
alter function public.get_person_day(text) rename to get_person_day_v21;
alter function public.get_person_day_v21(text) set schema private;
create function public.get_person_day(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d  jsonb := private.get_person_day_v21(p_token);
  me public.people;
begin
  if d is null then
    return null;
  end if;
  me := private.person_by_token(p_token);
  if me.id is not null and me.role = 'kid' and exists (select 1 from public.watch_items) then
    d := d || jsonb_build_object('watch', (select count(*) from public.watch_items w where w.watched_at is null));
  end if;
  return d;
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Watch page and his My day's card show only on 22. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 22;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------
-- His My day: the token is the key (as the other My day functions).
revoke execute on function public.watch_by_token(text)                                   from public, service_role;
grant  execute on function public.watch_by_token(text)                                   to anon, authenticated;
revoke execute on function public.watch_add_by_token(text, text, text, text, uuid)       from public, service_role;
grant  execute on function public.watch_add_by_token(text, text, text, text, uuid)       to anon, authenticated;
revoke execute on function public.get_person_day(text)                                   from public, service_role;
grant  execute on function public.get_person_day(text)                                   to anon, authenticated;
-- Private: the functions above and the trigger; nobody else.
revoke execute on function private.get_person_day_v21(text)                             from public, anon, authenticated, service_role;
revoke execute on function private.watch_view(uuid)                                     from public, anon, authenticated;
revoke execute on function private.watch_tidy()                                         from public, anon, authenticated;

commit;
