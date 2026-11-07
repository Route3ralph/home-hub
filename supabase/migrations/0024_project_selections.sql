-- =====================================================================
-- HOME HUB v2 — migration 0024: a project's selections (paint colors, door knobs, tile: what goes in, and its status)
-- Apply once, after 0023, and only once the site that understands it is live (docs/v1.4-project-guests.md §9).
-- The contract is docs/v2-design.md §30.
--
-- Why
--   The finishes for a renovation (a paint color, the cabinet knobs, a faucet) lived in chats and photos. One list per
--   project, by room, that the family and the project's guest (the designer) both keep: what it is, the product, the
--   finish, a link and a photo link, the price, and where it stands (Proposed, Approved, Ordered, Installed, Not this).
--
-- What it adds
--   • Table: public.project_selections, one row per selection, on one project (gone with the project). Every family
--     member, and a guest of that project (private.is_guest_of), reads and changes its rows; nobody else sees any.
--   • Approving or turning one down (status 'approved' or 'rejected') is a parent's call: the trigger refuses it from
--     anyone else (42501 "Only a parent approves or turns down a selection."). When anyone but a parent changes what
--     an approved selection is (its item, product, finish, link, photo or price), it goes back to Proposed.
--   • hub_schema_version() (24). The project page shows Selections only on 24.
--
-- Rules
--   • One transaction. It refuses to run without 0023, twice, on a database set back to 23 (the table already there),
--     or on one that isn't as 0023 left it.
--   • RLS on the new table. set search_path = '' on every function; revoke then grant.
--   • Nothing about selections reaches an email, the wall, the board, Google, My day, a tutor link or the share link.
--
-- Undo (not needed: with nothing on the list, every page is as on 23). If wanted, in one go:
--   drop table public.project_selections;
--   drop function private.selection_tidy();
--   then 0023's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;"). The
--   selections go with it.
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0023 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 23 then
    raise exception 'Missing and Graded (migration 0023) isn''t installed (hub_schema_version() is %). Run 0023_school_marks.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 24 then
    raise exception 'Selections (migration 0024) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.project_selections') is not null then
    raise exception 'Selections (migration 0024) are already installed, but hub_schema_version() was set back to 23. To switch them on again, make hub_schema_version() return 24 (docs/v2-design.md §30). Nothing was changed.';
  end if;
  -- What this migration reads and calls is as 0023 left it.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'school_mark')
     or to_regclass('public.projects') is null
     or to_regprocedure('private.is_member()') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('private.is_guest_of(uuid)') is null
     or to_regprocedure('private.stamp()') is null
     or to_regprocedure('private.clean_text(text, int)') is null
     or to_regprocedure('private.selection_tidy()') is not null then
    raise exception 'This database isn''t as migration 0023 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The table (§30.1)
-- ---------------------------------------------------------------------
-- One selection on one project.
create table public.project_selections (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  room        text check (room is null or char_length(room) between 1 and 40),       -- "Kitchen", "Powder room"
  item        text not null check (char_length(item) between 1 and 80),              -- "Cabinet knobs", "Wall paint"
  product     text check (product is null or char_length(product) between 1 and 120), -- "Emtek Round Knob 1-1/4in"
  finish      text check (finish is null or char_length(finish) between 1 and 80),    -- "Satin brass", "SW 7008 Alabaster"
  url         text check (url is null or (url ~ '^https://[!#-;=?-~]{4,}$' and char_length(url) <= 508)),        -- as recipes.url
  photo_url   text check (photo_url is null or (photo_url ~ '^https://[!#-;=?-~]{4,}$' and char_length(photo_url) <= 508)),
  price       numeric(10, 2) check (price is null or (price >= 0 and price <= 99999999)),   -- each, in the family's currency
  quantity    int check (quantity is null or quantity between 1 and 9999),
  status      text not null default 'proposed' check (status in ('proposed', 'approved', 'ordered', 'installed', 'rejected')),
  note        text check (note is null or char_length(note) between 1 and 500),
  created_at  timestamptz not null default now(),
  created_by  text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
create index project_selections_project on public.project_selections (project_id, room, created_at);

-- Same-event triggers fire in name order: project_selections_stamp runs before project_selections_tidy.
-- Text on one line; '' becomes null. Approving or turning one down is a parent's (is_admin); anyone else who changes
-- what an approved selection is sends it back to Proposed.
create function private.selection_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.room := nullif(private.clean_text(new.room, 40), '');
  new.item := private.clean_text(new.item, 80);
  new.product := nullif(private.clean_text(new.product, 120), '');
  new.finish := nullif(private.clean_text(new.finish, 80), '');
  new.note := nullif(private.clean_text(new.note, 500), '');
  if not private.is_admin() then
    if tg_op = 'UPDATE' and old.status = 'approved' and new.status = 'approved'
       and (new.item, new.product, new.finish, new.url, new.photo_url, new.price)
           is distinct from (old.item, old.product, old.finish, old.url, old.photo_url, old.price) then
      new.status := 'proposed';
    end if;
    if new.status in ('approved', 'rejected') and (tg_op = 'INSERT' or new.status is distinct from old.status) then
      raise exception 'Only a parent approves or turns down a selection.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- The trigger runs it; nobody calls it.
revoke execute on function private.selection_tidy() from public, anon, authenticated;

create trigger project_selections_stamp before insert or update on public.project_selections
  for each row execute function private.stamp();
create trigger project_selections_tidy before insert or update on public.project_selections
  for each row execute function private.selection_tidy();

-- ---------------------------------------------------------------------
-- Row-level security and grants (§30.2)
-- ---------------------------------------------------------------------
alter table public.project_selections enable row level security;

create policy "Family manages selections" on public.project_selections
  for all to authenticated using (private.is_member()) with check (private.is_member());
create policy "A project's guest manages its selections" on public.project_selections
  for all to authenticated using (private.is_guest_of(project_id)) with check (private.is_guest_of(project_id));

-- Supabase's default privileges give anon and authenticated everything on a new table. Anon and service_role get
-- nothing; signed-in users get the table's own columns, never the audit columns (the policies decide who).
revoke all on public.project_selections from public, anon, authenticated, service_role;
grant select, delete on public.project_selections to authenticated;
grant insert (id, project_id, room, item, product, finish, url, photo_url, price, quantity, status, note),
      update (room, item, product, finish, url, photo_url, price, quantity, status, note) on public.project_selections to authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The project page shows Selections only on 24. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 24;
$$;

commit;
