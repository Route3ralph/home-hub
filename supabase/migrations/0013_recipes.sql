-- =====================================================================
-- HOME HUB v1.2 — migration 0013: recipes (the family's saved recipe links, on the Food page)
-- Apply once, after 0012, and only once the site that understands it is live (docs/v1.2-kitchen.md §19.5).
-- The contract is docs/v1.2-kitchen.md §19.
--
-- Why
--   The family wanted one place for recipes and recipe links ("High-fiber lunches with chickpeas"), and for
--   recipe files and photos. The hub keeps a short list of links; the files themselves live in the family's
--   shared Google Drive "Recipes" folder, which the Food page opens. No ingredients, steps or photos are stored.
--
-- What it adds
--   • Table: public.recipes (title, an optional https link to a web page or a Drive file, a label, a note). Every
--     family member reads and changes it (private.is_member()); a project guest isn't a member and never sees it.
--   • Column: household.recipes_folder_url (the shared Drive folder; https://drive.google.com/ only). The
--     household's update policy already lets only the parents change it.
--   • hub_schema_version() (13).
--
-- Rules
--   • One transaction. It refuses to run without 0012, twice, on a database set back to 12 (the table already
--     there), or on a database that isn't as 0012 left it.
--   • RLS on the new table. No new function but the tidy trigger's; set search_path = '' on it.
--   • Nothing about recipes reaches My day, an email, the wall, Google or a guest.
--
-- Undo (not needed: with no recipes, every page is as on 12). If wanted, in one go in the SQL editor:
--   drop table public.recipes; drop function private.recipes_tidy();
--   alter table public.household drop column recipes_folder_url;
--   create or replace function public.hub_schema_version() returns int language sql immutable set search_path = ''
--   as $$ select 12 $$;
-- 0013 can then run again. The site needs no change: it works on 12.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0012 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 12 then
    raise exception 'The coach''s rewards (migration 0012) isn''t installed (hub_schema_version() is %). Run 0012_coach_rewards.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 13 then
    raise exception 'Recipes (migration 0013) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.recipes') is not null then
    raise exception 'Recipes (migration 0013) is already installed, but hub_schema_version() was set back to 12. To switch it on again, make hub_schema_version() return 13 (docs/v1.2-kitchen.md §19.5). Nothing was changed.';
  end if;
  -- What this migration reads and adds to is as 0012 left it.
  if to_regclass('public.household') is null
     or to_regclass('public.meals') is null
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.household'::regclass and a.attname = 'recipes_folder_url' and not a.attisdropped)
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.tutor_links'::regclass and a.attname = 'rewards' and not a.attisdropped)
     or to_regprocedure('private.is_member()') is null
     or to_regprocedure('private.stamp()') is null
     or to_regprocedure('private.clean_text(text, int)') is null
     or to_regprocedure('private.recipes_tidy()') is not null then
    raise exception 'This database isn''t as migration 0012 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The table (§19.2)
-- ---------------------------------------------------------------------

-- One saved recipe: a name, an optional link (a web page, or a file in the family's Drive), what meal it's for,
-- and a note. Kept until someone deletes it.
create table public.recipes (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 80),   -- "Chickpea lunch bowls", cleaned to one line
  url        text check (url is null or (url ~ '^https://[!#-;=?-~]{4,}$' and char_length(url) <= 508)),
             -- as meals.link: https only, printable ASCII only (no spaces, quotes, < >, control, bidi or
             -- zero-width characters), 4 to 500 after "https://"; the page saves new URL(typed).href
  label      text not null default 'dinner' check (label in ('dinner', 'lunch', 'breakfast', 'snack', 'other')),
  note       text check (note is null or char_length(note) between 1 and 300),   -- "Double the chickpeas"
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index recipes_title on public.recipes (lower(title));

-- The family's shared Drive "Recipes" folder (Food page → Recipes folder), as projects.documents_url.
alter table public.household
  add column recipes_folder_url text
    check (recipes_folder_url is null or (length(recipes_folder_url) <= 500 and recipes_folder_url ~ '^https://drive\.google\.com/[^\s<>"'']*$'));

-- Same-event triggers fire in name order: recipes_stamp runs before recipes_tidy.
create function private.recipes_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := private.clean_text(new.title, 80);
  new.note := nullif(private.clean_text(new.note, 300), '');
  return new;
end;
$$;

create trigger recipes_stamp before insert or update on public.recipes
  for each row execute function private.stamp();
create trigger recipes_tidy before insert or update on public.recipes
  for each row execute function private.recipes_tidy();

-- ---------------------------------------------------------------------
-- Row-level security and grants (§19.3)
-- ---------------------------------------------------------------------
alter table public.recipes enable row level security;

create policy "Family manages recipes" on public.recipes
  for all to authenticated using (private.is_member()) with check (private.is_member());

-- Supabase's default privileges give anon and authenticated everything on a new table. Anon and service_role
-- get nothing (no job reads recipes); members get the table's own columns.
revoke all on public.recipes from public, anon, authenticated, service_role;
grant select, delete on public.recipes to authenticated;
grant insert (id, title, url, label, note), update (title, url, label, note) on public.recipes to authenticated;

revoke execute on function private.recipes_tidy() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Recipes section shows on the Food page only on 13. (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 13;
$$;

commit;
