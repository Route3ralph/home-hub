-- =====================================================================
-- HOME HUB v2 — migration 0030: Add school items automatically (an Assignments link's new items go straight onto the
-- kid's homework)
-- Apply once, after 0029, and only once the site that understands it is live (docs/v1.3-homework.md §30.4).
-- No Edge Function and no cron.sql change: the hourly school read already calls private.school_apply.
-- The contract is docs/v1.3-homework.md §30; the database side is docs/v2-design.md §36.
--
-- Why
--   The school's items came in every hour but waited in New from school until someone tapped Add, so homework due on
--   Monday could sit there unseen (and out of the evening email). A parent asked for them to go on by themselves.
--
-- What it adds
--   • school_feeds.auto_add (boolean, false): a parent turns it on for an Assignments link whose dates are due dates
--     (its date rule isn't 'assigned': there the hub can't know the due date, so Paste due dates stays the way).
--   • private.school_auto_add(p_feed): adds that link's waiting items due from today to 30 days ahead, as Add does
--     (private.school_assignment, created by 'school (added automatically)'), except one the family has hidden before
--     (the same title and class, hidden on that link: the weekly ALEKS or Membean a parent enters with a count) or one
--     already on his list by hand (the same title and due date): each of those is hidden, so the next week's copy
--     knows too. Never a past item, a hidden one, one on a paused or unchecked link, or while his homework is off.
--   • private.school_apply(p_feed) now adds them first (0015's body moved to private.school_apply_v29, unchanged), so
--     every read (school_store) and the first-import check (check_school_feed) add what's new.
--   • public.set_school_auto_add(p_feed uuid, p_on boolean): a parent only (not the coach: it's a switch); turning it
--     on adds what is waiting at once. Answers {added} with the status card.
--   • public.school_feed_status(p_kid): 0018's (moved to private.school_feed_status_v29, unchanged), with each feed's
--     auto_add.
--   • hub_schema_version() (30). The Homework page shows the switch only on 30.
--
-- Rules
--   • One transaction. It refuses to run without 0029, twice, on a database set back to 29 (the column already there),
--     or on one that isn't as 0029 left it.
--   • Additive: one column, off for every link, so every read, page and answer is as on 29 until a parent turns it on.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: with auto_add off everywhere everything is as on 29). If wanted, in one go:
--   drop function public.set_school_auto_add(uuid, boolean);
--   drop function public.school_feed_status(uuid);
--   alter function private.school_feed_status_v29(uuid) set schema public;
--   alter function public.school_feed_status_v29(uuid) rename to school_feed_status;
--   drop function private.school_apply(uuid);
--   alter function private.school_apply_v29(uuid) rename to school_apply;
--   drop function private.school_auto_add(uuid);
--   alter table public.school_feeds drop column auto_add;
--   then 0029's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0029 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 29 then
    raise exception 'Due tomorrow (migration 0029) isn''t installed (hub_schema_version() is %). Run 0029_due_tomorrow.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 30 then
    raise exception 'Adding school items automatically (migration 0030) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.school_feeds'::regclass and a.attname = 'auto_add' and not a.attisdropped) then
    raise exception 'Adding school items automatically (migration 0030) is already installed, but hub_schema_version() was set back to 29. To switch it on again, make hub_schema_version() return 30 (docs/v1.3-homework.md §30). Nothing was changed.';
  end if;
  -- What this migration reads, calls and replaces is as 0029 left it.
  if to_regprocedure('public.due_list(date, text)') is null
     or to_regprocedure('private.school_apply(uuid)') is null
     or to_regprocedure('private.school_assignment(uuid, text, date)') is null
     or to_regprocedure('public.school_feed_status(uuid)') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('public.today_local()') is null
     or to_regprocedure('private.school_apply_v29(uuid)') is not null
     or to_regprocedure('private.school_feed_status_v29(uuid)') is not null
     or to_regprocedure('public.school_feed_status_v29(uuid)') is not null
     or to_regprocedure('private.school_auto_add(uuid)') is not null
     or to_regprocedure('public.set_school_auto_add(uuid, boolean)') is not null
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.school_feeds'::regclass and a.attname = 'date_rule' and not a.attisdropped)
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.school_items'::regclass and a.attname = 'hidden' and not a.attisdropped) then
    raise exception 'This database isn''t as migration 0029 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The switch (§30.1)
-- ---------------------------------------------------------------------
alter table public.school_feeds add column auto_add boolean not null default false;   -- new items go on by themselves

-- ---------------------------------------------------------------------
-- Adding them (§30.2)
-- ---------------------------------------------------------------------
-- A link's waiting items due from today to 30 days ahead, added as Add adds them, oldest due first. One the family hid
-- before (the same title and class, hidden on this link) or already has by hand (an assignment of his, not from
-- school, with the same title and due date) is hidden instead, so it leaves New from school and the next copy of it
-- finds a hidden one too. Answers how many were added.
create function private.school_auto_add(p_feed uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_f     public.school_feeds;
  v_today date := public.today_local();
  v_n     int := 0;
  r       record;
begin
  select * into v_f from public.school_feeds f where f.id = p_feed;
  if v_f.id is null or not v_f.auto_add or v_f.kind <> 'assignments' or not v_f.checked or v_f.paused
     or v_f.removed_at is not null or v_f.date_rule = 'assigned'
     or not exists (select 1 from public.homework_kids k join public.people p on p.id = k.kid_id
                    where k.kid_id = v_f.kid_id and k.active and p.active) then
    return 0;
  end if;
  for r in
    select i.id,
           exists (select 1 from public.school_items h
                   where h.feed_id = p_feed and h.hidden and h.id <> i.id
                     and lower(btrim(h.title)) = lower(btrim(i.title))
                     and lower(coalesce(h.subject, '')) = lower(coalesce(i.subject, ''))) as hid_before,
           exists (select 1 from public.assignments a
                   where a.kid_id = v_f.kid_id and a.added_by <> 'school' and a.due_date = i.due_date
                     and lower(btrim(a.title)) = lower(btrim(i.title))) as by_hand
    from public.school_items i
    where i.feed_id = p_feed and i.made_at is null and not i.hidden and i.gone_at is null
      and i.due_date between v_today and v_today + 30
    order by i.due_date, i.title, i.id
  loop
    if r.hid_before or r.by_hand then
      update public.school_items i set hidden = true where i.id = r.id and i.made_at is null;
    else
      perform private.school_assignment(r.id, 'school (added automatically)', null);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- Every read (school_store) and the first-import check (check_school_feed) call school_apply: it adds what's new first.
alter function private.school_apply(uuid) rename to school_apply_v29;
create function private.school_apply(p_feed uuid)
returns int
language plpgsql
set search_path = ''
as $$
begin
  perform private.school_auto_add(p_feed);
  return private.school_apply_v29(p_feed);
end;
$$;

-- A parent turns it on or off for an Assignments link. On adds what is waiting at once.
create function public.set_school_auto_add(p_feed uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.school_feeds;
  v_n int := 0;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  select * into v_f from public.school_feeds f where f.id = p_feed and f.removed_at is null for update;
  if v_f.id is null then
    raise exception 'That school link isn''t there any more.' using errcode = '22023';
  end if;
  if v_f.kind <> 'assignments' then
    raise exception 'Only the Assignments link adds homework.' using errcode = '22023';
  end if;
  if p_on and v_f.date_rule = 'assigned' then
    raise exception 'This link''s dates are the day each was given, so Home Hub can''t know the due dates. Use Paste due dates instead.' using errcode = '22023';
  end if;
  update public.school_feeds f set auto_add = p_on where f.id = p_feed;
  if p_on then
    v_n := private.school_auto_add(p_feed);
  end if;
  return jsonb_build_object('added', v_n) || coalesce(public.school_feed_status(v_f.kid_id), '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- The status card (§30.3): 0018's, with each feed's auto_add
-- ---------------------------------------------------------------------
alter function public.school_feed_status(uuid) rename to school_feed_status_v29;
alter function public.school_feed_status_v29(uuid) set schema private;
create function public.school_feed_status(p_kid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when s is null then null
              else jsonb_set(s, '{feeds}', coalesce((
                select jsonb_agg(e || jsonb_build_object('auto_add', coalesce(f.auto_add, false)) order by n)
                from jsonb_array_elements(s -> 'feeds') with ordinality t (e, n)
                left join public.school_feeds f on f.id = (e ->> 'id')::uuid), '[]'::jsonb)) end
  from private.school_feed_status_v29(p_kid) s;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
-- New functions start out executable by PUBLIC. The moved status function keeps its grants (nobody but the definer
-- wrapper reaches the private schema), so the undo puts it back exactly as it was.
revoke execute on function private.school_auto_add(uuid)                from public, anon, authenticated;
revoke execute on function private.school_apply(uuid)                   from public, anon, authenticated;
revoke execute on function public.set_school_auto_add(uuid, boolean)     from public, anon, service_role;
revoke execute on function public.school_feed_status(uuid)               from public, anon, service_role;
grant  execute on function public.set_school_auto_add(uuid, boolean)     to authenticated;
grant  execute on function public.school_feed_status(uuid)               to authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Homework page shows the switch only on 30. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 30;
$$;

commit;
