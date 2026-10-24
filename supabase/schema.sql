-- =====================================================================
-- HOME HUB — database schema
-- Apply once to a new Supabase project (SQL editor, or `supabase db push`).
--
-- Security model
--   • Only people listed in public.members can read or change anything.
--     Every table has row-level security; signed-out visitors see nothing.
--   • Admins manage the members list. Members manage projects and contractors.
--   • The public share page can read ONE project, by its secret share token,
--     through get_shared_project(). That function strips contractor contact
--     details and private task notes.
--   • hook_family_only_signup() can be enabled as Supabase's
--     "Before User Created" auth hook, so only listed emails can create a login.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.members (
  email      text primary key check (email = lower(email) and email like '%_@_%'),
  name       text not null check (length(trim(name)) > 0),
  role       text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);

create table public.contractors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  company    text,
  trade      text,
  phone      text,
  email      text,
  website    text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- `schedule` holds the Gantt data: { project: { start, holidays }, trades: {...}, phases: [...] }
create table public.projects (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  status          text not null default 'planning'
                  check (status in ('idea', 'planning', 'active', 'on-hold', 'done')),
  summary         text,
  schedule        jsonb not null default '{"project": {}, "trades": {}, "phases": []}'::jsonb,
  sharing_enabled boolean not null default false,
  share_token     text not null unique default encode(extensions.gen_random_bytes(12), 'hex')
                  check (length(share_token) >= 16),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger contractors_touch_updated_at before update on public.contractors
  for each row execute function public.touch_updated_at();
create trigger projects_touch_updated_at before update on public.projects
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Who is signed in?
-- ---------------------------------------------------------------------
create or replace function public.current_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.members m where m.email = public.current_email());
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.email = public.current_email() and m.role = 'admin'
  );
$$;

-- The signed-in person's member record, or null if they aren't on the list.
create or replace function public.whoami()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(m) from public.members m where m.email = public.current_email();
$$;

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
alter table public.members     enable row level security;
alter table public.contractors enable row level security;
alter table public.projects    enable row level security;

create policy "Family can see the member list" on public.members
  for select to authenticated using (public.is_member());
create policy "Admins add members" on public.members
  for insert to authenticated with check (public.is_admin());
create policy "Admins update members" on public.members
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins remove other members" on public.members
  for delete to authenticated using (public.is_admin() and email <> public.current_email());

create policy "Family manages contractors" on public.contractors
  for all to authenticated using (public.is_member()) with check (public.is_member());

create policy "Family manages projects" on public.projects
  for all to authenticated using (public.is_member()) with check (public.is_member());

-- ---------------------------------------------------------------------
-- Public share link: one project, schedule only
-- ---------------------------------------------------------------------
create or replace function public.get_shared_project(share text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.projects;
  trades jsonb;
  phases jsonb;
begin
  if share is null or length(share) < 16 then
    return null;
  end if;

  select * into p from public.projects
  where share_token = share and sharing_enabled;
  if not found then
    return null;
  end if;

  -- Trades: drop the contractor link; show the contractor's name and company only.
  select coalesce(jsonb_object_agg(
           t.key,
           (t.value - 'contractor_id') ||
           case when c.id is null then '{}'::jsonb
                else jsonb_build_object('who', concat_ws(', ', c.name, nullif(c.company, '')))
           end), '{}'::jsonb)
    into trades
    from jsonb_each(coalesce(p.schedule -> 'trades', '{}'::jsonb)) t
    left join public.contractors c on c.id::text = t.value ->> 'contractor_id';

  -- Phases: drop private notes from every task, keeping order.
  select coalesce(jsonb_agg(
           ph.value || jsonb_build_object('tasks', coalesce((
             select jsonb_agg(tk.value - 'private_notes' order by tk.ord)
             from jsonb_array_elements(coalesce(ph.value -> 'tasks', '[]'::jsonb)) with ordinality tk(value, ord)
           ), '[]'::jsonb))
           order by ph.ord), '[]'::jsonb)
    into phases
    from jsonb_array_elements(coalesce(p.schedule -> 'phases', '[]'::jsonb)) with ordinality ph(value, ord);

  return jsonb_build_object(
    'name', p.name,
    'updated_at', p.updated_at,
    'schedule', jsonb_build_object(
      'project', coalesce(p.schedule -> 'project', '{}'::jsonb),
      'trades', trades,
      'phases', phases
    )
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Optional auth hook: only listed emails can create a login.
-- Enable in the dashboard: Authentication → Hooks → Before User Created
-- → Postgres function → public.hook_family_only_signup
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
-- Function permissions
-- ---------------------------------------------------------------------
revoke execute on function public.is_member()  from public, anon;
revoke execute on function public.is_admin()   from public, anon;
revoke execute on function public.whoami()     from public, anon;
grant  execute on function public.is_member()  to authenticated;
grant  execute on function public.is_admin()   to authenticated;
grant  execute on function public.whoami()     to authenticated;

revoke execute on function public.get_shared_project(text) from public;
grant  execute on function public.get_shared_project(text) to anon, authenticated;

revoke execute on function public.hook_family_only_signup(jsonb) from public, anon, authenticated;
grant  execute on function public.hook_family_only_signup(jsonb) to supabase_auth_admin;
