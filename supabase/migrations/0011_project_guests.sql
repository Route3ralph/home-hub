-- =====================================================================
-- HOME HUB v1.4 — migration 0011: project guests (a designer's login for the projects assigned to them)
-- Apply once, after 0010, and only once the site that understands it is live (docs/v1.4-project-guests.md §8).
-- The contract is docs/v1.4-project-guests.md (§3 the data, §4 what a guest manages, §5 assigning).
--
-- Why
--   An interior designer (a "project guest") manages the family's renovation project: its schedule, trades and the
--   contractors on it. They sign in with an emailed code like the family, but are not a member, so every policy and
--   function gated on private.is_member() or private.is_admin() keeps them out, unchanged. This migration gives them
--   their own narrow way in to the projects a parent assigns them, and nothing else.
--
-- What it adds and changes
--   • Tables: guests (who may sign in as a guest), project_guests (which projects each one sees), project_contacts
--     (the contractors a guest added to a project). Row-level security: guests and project_guests admins select;
--     project_contacts members select; no write policies (only the functions below write them); revoked from public,
--     anon and authenticated, then select granted to authenticated.
--   • Column: projects.documents_url (the project's shared Google Drive folder; https://drive.google.com/ only).
--   • Policies on projects: a guest selects and updates the projects assigned to them (private.is_guest_of). No insert
--     or delete. A trigger (private.projects_guest_guard) refuses a guest's change to the owner, the calendar switch,
--     sharing or the share link, and a schedule link to a contractor who isn't on the project; and an adult's change to
--     the documents link (the parents and the project's guests change it).
--   • New: private.is_guest_of(p_project uuid) returns boolean (SECURITY DEFINER, for the policies);
--     private.schedule_contractors(p_schedule jsonb) returns uuid[] (IMMUTABLE: the contractors a schedule's trades
--     link); private.guest_contact_ids(p_project uuid) returns uuid[] (the contractors on a project: linked by its
--     schedule, or added by a guest); private.projects_guest_guard() (the trigger, SECURITY DEFINER);
--     public.guest_whoami() returns jsonb (the signed-in guest, or null for a member or anyone else);
--     public.guest_contacts(p_project uuid) (the contractors on a guest's project: names, phones, emails, never account
--     details); public.guest_save_contact(p_project uuid, p_contact jsonb) returns jsonb (a guest adds or edits one);
--     public.add_project_guest(p_project uuid, p_email text, p_name text) returns jsonb,
--     public.remove_project_guest(p_project uuid, p_email text) returns boolean and
--     public.remove_guest(p_email text) returns boolean (the parents only).
--   • Replaced: public.hook_family_only_signup(event jsonb) (the sign-up hook) also lets a guest's address create a
--     login. Same signature and grants.
--   • hub_schema_version() (11).
--   Nothing new for anon. whoami() is unchanged (null for a guest), so send-email, hub-jobs and every page that reads
--   whoami() treat a guest as they treat anyone not on the family list. A guest gets no email from the hub.
--
-- Rules
--   • One transaction. It refuses to run without 0010, twice, on a database set back to 10 (guests already there), or
--     on a database that isn't as 0010 left it (the projects and contractors columns it reads, no documents_url yet,
--     the helpers it calls, none of its own functions yet).
--   • Row-level security on every new table; set search_path = '' on every function; revoke then grant on every new
--     one.
--
-- Undo (not needed: with no guest added, every answer is 10's). If wanted, in one go in the SQL editor:
--   drop function public.remove_guest(text); drop function public.remove_project_guest(uuid, text);
--   drop function public.add_project_guest(uuid, text, text); drop function public.guest_save_contact(uuid, jsonb);
--   drop function public.guest_contacts(uuid); drop function public.guest_whoami();
--   drop trigger projects_guest_guard on public.projects; drop function private.projects_guest_guard();
--   drop policy "Guests see their projects" on public.projects; drop policy "Guests update their projects" on public.projects;
--   drop function private.guest_contact_ids(uuid); drop function private.schedule_contractors(jsonb);
--   drop function private.is_guest_of(uuid);
--   drop table public.project_contacts; drop table public.project_guests; drop table public.guests;
--   alter table public.projects drop column documents_url;
--   schema.sql's "create or replace function public.hook_family_only_signup(event jsonb)" block again;
--   create or replace function public.hub_schema_version() returns int language sql immutable set search_path = ''
--   as $$ select 10 $$;
-- 0011 can then run again. The site needs no change: it works on 10.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0010 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 10 then
    raise exception 'Hearth people (migration 0010) isn''t installed (hub_schema_version() is %). Run 0010_hearth_people.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 11 then
    raise exception 'Project guests (migration 0011) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.guests') is not null then
    raise exception 'Project guests (migration 0011) is already installed, but hub_schema_version() was set back to 10. To switch it on again, make hub_schema_version() return 11 (docs/v1.4-project-guests.md §8). Nothing was changed.';
  end if;
  -- What this migration reads, replaces and adds to is as 0010 left it (or as the undo above leaves it: the same).
  if (select count(*) from pg_attribute a
      where not a.attisdropped and a.attnum > 0
        and ((a.attrelid = to_regclass('public.projects')
              and a.attname in ('id', 'name', 'schedule', 'owner_id', 'on_calendar', 'sharing_enabled', 'share_token', 'created_at'))
             or (a.attrelid = to_regclass('public.contractors')
                 and a.attname in ('id', 'name', 'company', 'trade', 'phone', 'email', 'website', 'kind')))) <> 16
     or exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.projects') and a.attname = 'documents_url' and not a.attisdropped)
     or to_regclass('public.members') is null
     or to_regprocedure('public.hook_family_only_signup(jsonb)') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('private.is_member()') is null
     or to_regprocedure('private.has_secrets(uuid)') is null
     or to_regprocedure('public.current_email()') is null
     or exists (select 1 from pg_proc p
                where (p.pronamespace = to_regnamespace('public')
                       and p.proname in ('guest_whoami', 'guest_contacts', 'guest_save_contact', 'add_project_guest', 'remove_project_guest', 'remove_guest'))
                   or (p.pronamespace = to_regnamespace('private')
                       and p.proname in ('is_guest_of', 'schedule_contractors', 'guest_contact_ids', 'projects_guest_guard'))) then
    raise exception 'This database isn''t as migration 0010 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables and the column (§3)
-- ---------------------------------------------------------------------

-- Who may sign in as a project guest. Never a member (add_project_guest refuses one). Written only by
-- add_project_guest (a new guest, or a new name) and remove_guest.
create table public.guests (
  email      text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  name       text not null check (length(name) between 1 and 80 and name = btrim(name)),
  created_at timestamptz not null default now(),
  created_by text
);

-- Which projects each guest sees and manages. Written only by add_project_guest and remove_project_guest.
create table public.project_guests (
  project_id  uuid not null references public.projects (id) on delete cascade,
  guest_email text not null references public.guests (email) on delete cascade,
  added_at    timestamptz not null default now(),
  added_by    text,
  primary key (project_id, guest_email)
);
create index project_guests_guest_idx on public.project_guests (guest_email);

-- The contractors a guest added to a project (guest_save_contact). With the ones its schedule links, they are the
-- contractors on that project (private.guest_contact_ids).
create table public.project_contacts (
  project_id    uuid not null references public.projects (id) on delete cascade,
  contractor_id uuid not null references public.contractors (id) on delete cascade,
  added_at      timestamptz not null default now(),
  added_by      text,
  primary key (project_id, contractor_id)
);

-- The project's shared folder (drawings, quotes, invoices, photos): a Google Drive address only. The family reads it;
-- the parents and the project's guests change it (projects_guest_guard).
alter table public.projects
  add column documents_url text
    check (documents_url is null or (length(documents_url) <= 500 and documents_url ~ '^https://drive\.google\.com/[^\s<>"'']*$'));

alter table public.guests           enable row level security;
alter table public.project_guests   enable row level security;
alter table public.project_contacts enable row level security;

create policy "Admins can see the guests" on public.guests
  for select to authenticated using (private.is_admin());
create policy "Admins can see who sees each project" on public.project_guests
  for select to authenticated using (private.is_admin());
create policy "Family can see the contractors guests added" on public.project_contacts
  for select to authenticated using (private.is_member());

-- Supabase's default privileges give anon and authenticated everything on a new table. Anon gets nothing; signed-in
-- users read them (row-level security decides). service_role keeps the defaults.
revoke all on public.guests           from public, anon, authenticated;
revoke all on public.project_guests   from public, anon, authenticated;
revoke all on public.project_contacts from public, anon, authenticated;
grant select on public.guests           to authenticated;
grant select on public.project_guests   to authenticated;
grant select on public.project_contacts to authenticated;

-- ---------------------------------------------------------------------
-- Who is a guest of what (§3)
-- ---------------------------------------------------------------------

-- Is the signed-in address a guest assigned to this project? For the policies on projects, so it runs with the
-- owner's rights (a guest can't read project_guests).
create function private.is_guest_of(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_email() <> ''
     and exists (select 1 from public.project_guests pg
                 where pg.project_id = p_project and pg.guest_email = public.current_email());
$$;

-- The contractors a schedule's trades link (trades.<key>.contractor_id), as uuids; anything else is left out.
create function private.schedule_contractors(p_schedule jsonb)
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct (t.value ->> 'contractor_id')::uuid), '{}')
  from jsonb_each(case when jsonb_typeof(p_schedule -> 'trades') = 'object' then p_schedule -> 'trades' else '{}'::jsonb end) t
  where jsonb_typeof(t.value) = 'object'
    and (t.value ->> 'contractor_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

-- The contractors on a project: the ones its schedule links, and the ones a guest added to it.
create function private.guest_contact_ids(p_project uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct x.id), '{}')
  from (select unnest(private.schedule_contractors(p.schedule)) as id from public.projects p where p.id = p_project
        union
        select c.contractor_id from public.project_contacts c where c.project_id = p_project) x
  where exists (select 1 from public.contractors k where k.id = x.id);
$$;

-- ---------------------------------------------------------------------
-- A guest's projects (§4)
-- ---------------------------------------------------------------------

create policy "Guests see their projects" on public.projects
  for select to authenticated using (private.is_guest_of(id));
create policy "Guests update their projects" on public.projects
  for update to authenticated using (private.is_guest_of(id)) with check (private.is_guest_of(id));

-- A guest changes the schedule, name, status, summary and documents link of their projects, not who owns them,
-- whether they're on the family calendar, or sharing; and links a trade only to a contractor already on the project
-- (guest_save_contact adds one). Of the family, only a parent changes the documents link (an adult changes the rest, as
-- before). Anything without a signed-in email (service_role, the SQL editor) is not checked here. It runs with the
-- owner's rights (a guest can't read project_contacts); the signed-in email is still the caller's.
create function private.projects_guest_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new uuid[];
begin
  if public.current_email() = '' then
    return new;
  end if;
  if private.is_member() then
    if new.documents_url is distinct from old.documents_url and not private.is_admin() then
      raise exception 'Only a parent or the project''s guest can change the documents folder.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.created_at is distinct from old.created_at
     or new.owner_id is distinct from old.owner_id or new.on_calendar is distinct from old.on_calendar
     or new.sharing_enabled is distinct from old.sharing_enabled or new.share_token is distinct from old.share_token then
    raise exception 'Only the family can change the owner, the calendar switch or sharing.' using errcode = '42501';
  end if;
  select coalesce(array_agg(x), '{}') into v_new
  from unnest(private.schedule_contractors(new.schedule)) x
  where not (x = any (private.guest_contact_ids(old.id)));
  if cardinality(v_new) > 0 then
    raise exception 'Link a trade only to a contractor on this project. Add new ones under Contractors.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger projects_guest_guard before update on public.projects
  for each row execute function private.projects_guest_guard();

-- The signed-in guest: { email, name, projects: [project ids] }, or null for a member and for anyone not a guest.
-- The site calls it only when whoami() is null.
create function public.guest_whoami()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('email', g.email, 'name', g.name,
           'projects', coalesce((select jsonb_agg(pg.project_id order by p.created_at, p.id)
                                 from public.project_guests pg join public.projects p on p.id = pg.project_id
                                 where pg.guest_email = g.email), '[]'::jsonb))
  from public.guests g
  where g.email = public.current_email() and public.current_email() <> ''
    and not private.is_member();
$$;

-- The contractors on one of the guest's projects, by name: what the project page shows and messages. Never notes,
-- addresses or account details. editable: the guest may change it (no account details saved).
create function public.guest_contacts(p_project uuid)
returns table (id uuid, name text, company text, trade text, phone text, email text, website text, kind text, editable boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_guest_of(p_project) then
    raise exception 'That project isn''t shared with you.' using errcode = '42501';
  end if;
  return query
    select c.id, c.name, c.company, c.trade, c.phone, c.email, c.website, c.kind, not private.has_secrets(c.id)
    from public.contractors c
    where c.id = any (private.guest_contact_ids(p_project))
    order by lower(c.name), c.id;
end;
$$;

-- A guest adds a contractor to one of their projects (a new directory entry, kind 'contractor'), or edits one on it
-- that has no account details. p_contact: { id?, name, company?, trade?, phone?, email?, website? }. Answers the row
-- as guest_contacts does.
create function public.guest_save_contact(p_project uuid, p_contact jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_name    text := btrim(coalesce(p_contact ->> 'name', ''));
  v_company text := nullif(btrim(coalesce(p_contact ->> 'company', '')), '');
  v_trade   text := nullif(btrim(coalesce(p_contact ->> 'trade', '')), '');
  v_phone   text := nullif(btrim(coalesce(p_contact ->> 'phone', '')), '');
  v_email   text := nullif(lower(btrim(coalesce(p_contact ->> 'email', ''))), '');
  v_website text := nullif(btrim(coalesce(p_contact ->> 'website', '')), '');
  v_row     public.contractors;
begin
  if not private.is_guest_of(p_project) then
    raise exception 'That project isn''t shared with you.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_contact) is distinct from 'object' then
    raise exception 'Send the contractor''s details.' using errcode = '22023';
  end if;
  if v_name = '' or length(v_name) > 120 then
    raise exception 'Give the contractor a name (up to 120 characters).' using errcode = '22023';
  end if;
  if greatest(length(v_company), length(v_trade), length(v_phone), length(v_email), length(v_website)) > 200 then
    raise exception 'Keep each detail under 200 characters.' using errcode = '22023';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception '"%" doesn''t look like an email address.', v_email using errcode = '22023';
  end if;

  if nullif(p_contact ->> 'id', '') is not null then
    if (p_contact ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not ((p_contact ->> 'id')::uuid = any (private.guest_contact_ids(p_project))) then
      raise exception 'That contractor isn''t on this project.' using errcode = '42501';
    end if;
    v_id := (p_contact ->> 'id')::uuid;
    if private.has_secrets(v_id) then
      raise exception 'This contractor has account details saved, so only a parent can change them.' using errcode = '42501';
    end if;
    update public.contractors c
    set name = v_name, company = v_company, trade = v_trade, phone = v_phone, email = v_email, website = v_website
    where c.id = v_id
    returning * into v_row;
  else
    insert into public.contractors (name, company, trade, phone, email, website, kind)
    values (v_name, v_company, v_trade, v_phone, v_email, v_website, 'contractor')
    returning * into v_row;
    insert into public.project_contacts (project_id, contractor_id, added_by)
    values (p_project, v_row.id, public.current_email());
  end if;

  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'company', v_row.company, 'trade', v_row.trade,
                            'phone', v_row.phone, 'email', v_row.email, 'website', v_row.website, 'kind', v_row.kind,
                            'editable', true);
end;
$$;

-- ---------------------------------------------------------------------
-- Assigning and removing (§5): the parents only
-- ---------------------------------------------------------------------

-- Give a guest a project: makes the guest (p_name needed then) or renames them (p_name given), then links the project.
-- Answers { email, name, project_id }.
create function public.add_project_guest(p_project uuid, p_email text, p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_guest public.guests;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can give someone access to a project.' using errcode = '42501';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then
    raise exception 'Type the guest''s email address.' using errcode = '22023';
  end if;
  if exists (select 1 from public.members m where m.email = v_email) then
    raise exception '% already signs in as family, so they see every project.', v_email using errcode = '22023';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project) then
    raise exception 'That project isn''t there any more.' using errcode = '22023';
  end if;
  if v_name is not null and length(v_name) > 80 then
    raise exception 'Keep the name under 80 characters.' using errcode = '22023';
  end if;

  select * into v_guest from public.guests g where g.email = v_email for update;
  if not found then
    if v_name is null then
      raise exception 'Type the guest''s name.' using errcode = '22023';
    end if;
    insert into public.guests (email, name, created_by) values (v_email, v_name, public.current_email())
    returning * into v_guest;
  elsif v_name is not null and v_name <> v_guest.name then
    update public.guests g set name = v_name where g.email = v_email returning * into v_guest;
  end if;

  insert into public.project_guests (project_id, guest_email, added_by)
  values (p_project, v_email, public.current_email())
  on conflict (project_id, guest_email) do nothing;
  return jsonb_build_object('email', v_guest.email, 'name', v_guest.name, 'project_id', p_project);
end;
$$;

-- Take a project away from a guest. The guest keeps their sign-in (with no projects, they see none). Answers whether
-- they had it.
create function public.remove_project_guest(p_project uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change who sees a project.' using errcode = '42501';
  end if;
  delete from public.project_guests pg where pg.project_id = p_project and pg.guest_email = lower(btrim(coalesce(p_email, '')));
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- Remove a guest everywhere: every project, and the sign-up hook no longer lets their address make a login. A login
-- they already made stays in Supabase Auth (delete it there by hand); it sees nothing. Answers whether they were a guest.
create function public.remove_guest(p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can remove a guest.' using errcode = '42501';
  end if;
  delete from public.guests g where g.email = lower(btrim(coalesce(p_email, '')));
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- ---------------------------------------------------------------------
-- The sign-up hook: the family list, and from 0011 the guests (schema.sql's body, plus the guests)
-- ---------------------------------------------------------------------
create or replace function public.hook_family_only_signup(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.members m
    where m.email = lower(coalesce(event -> 'user' ->> 'email', ''))
  ) or exists (
    select 1 from public.guests g
    where g.email = lower(coalesce(event -> 'user' ->> 'email', ''))
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This email is not on the family list.'
  ));
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages show a guest their projects, and the parents Guest access, the Guests card and the Documents link,
-- only on 11. (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 11;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- The signed-in functions check who is calling themselves (a guest of the project, or a parent). The private helpers
-- are for the policies and the trigger (signed-in users, as private.is_member). Nothing for anon or service_role.
-- ---------------------------------------------------------------------
revoke execute on function private.is_guest_of(uuid)                      from public, anon;
revoke execute on function private.schedule_contractors(jsonb)            from public, anon;
revoke execute on function private.guest_contact_ids(uuid)                from public, anon, authenticated;
revoke execute on function private.projects_guest_guard()                 from public, anon, authenticated;
revoke execute on function public.guest_whoami()                          from public, anon, service_role;
revoke execute on function public.guest_contacts(uuid)                    from public, anon, service_role;
revoke execute on function public.guest_save_contact(uuid, jsonb)         from public, anon, service_role;
revoke execute on function public.add_project_guest(uuid, text, text)     from public, anon, service_role;
revoke execute on function public.remove_project_guest(uuid, text)        from public, anon, service_role;
revoke execute on function public.remove_guest(text)                      from public, anon, service_role;
grant  execute on function private.is_guest_of(uuid)                      to authenticated;
grant  execute on function private.schedule_contractors(jsonb)            to authenticated;
grant  execute on function public.guest_whoami()                          to authenticated;
grant  execute on function public.guest_contacts(uuid)                    to authenticated;
grant  execute on function public.guest_save_contact(uuid, jsonb)         to authenticated;
grant  execute on function public.add_project_guest(uuid, text, text)     to authenticated;
grant  execute on function public.remove_project_guest(uuid, text)        to authenticated;
grant  execute on function public.remove_guest(text)                      to authenticated;

commit;
