-- =====================================================================
-- HOME HUB v1.3 — migration 0009: the school items' keys (Blackbaud's UIDs change every hour or two)
-- Apply once, after 0008. No site, Edge Function or cron.sql change goes with it (docs/v1.3-homework.md §16.8).
-- The contract is docs/v1.3-homework.md §2.8, §11.3 (what a read keeps) and §12 item 9.
--
-- Why
--   Blackbaud makes its iCal feeds again every hour or two, and each time every event has a new UID (within one read
--   they are unique). Seen on the live database (2026-10-31): an Assignments link holds the same 18 assignments on every
--   read, yet public.school_items had 54 rows for it, three batches of 18 with different keys (first seen 18:10, 19:23
--   and 21:23 UTC), the first marked gone after two reads that didn't see its keys; the Schedule link (285 classes) had
--   570, two batches. 0006 keyed an item with a UID by it ('uid:' || uid), and its moved-date step works only for items
--   without one, so every new set of UIDs added every item again and marked the ones before missing, then gone: the
--   first-import check showed each assignment twice; once checked, every assignment would be New from school again
--   after each change of UIDs, an assignment made from an earlier copy would be marked "no longer on the school site",
--   and his schedule would be busy time twice.
--
-- What it changes
--   • Replaced, with the same signature: private.school_rows(text, jsonb, text, int, date). A UID is never part of the
--     key: every item is keyed as 0006 keys one without a UID, an assignment by md5('title:' || its class in lower case
--     || a line break || its title in lower case || '|' || its first day, YYYY-MM-DD), a schedule or games item by
--     md5('title:' || its title in lower case || '|' || its start in UTC, YYYY-MM-DD"T"HH24:MI:SS); has_uid is false on
--     every row. So school_store's moved-date step (an Assignments item without a UID, of the same class and title, that
--     the last good read saw and this one doesn't, takes the new key) covers Blackbaud's items too: a due date the school
--     moves keeps its row and its assignment. Everything else is 0006's, word for word (the uid is no longer read).
--     What it costs: a title the school rewords is a new item (the old one goes missing, then gone), as for an item
--     without a UID since 0006; two of one class with the same title on the same first day are one item.
--   • New: private.school_rekey(), run once below (and again only by the owner: 0009 run again after its undo). Every
--     school_items row gets that key, computed from what it stores (its class, title and first day; its title and
--     start), and has_uid false. Of the rows of one link with the same key (the copies the UIDs made) one row stays,
--     chosen in this order: the one made an assignment (assignment_id); else one made one once (made_at, its
--     assignment deleted since: never new again); else one hidden; else one still on the school site (gone_at null);
--     else the one seen last (last_seen_at); then by id. It is hidden if any copy was, first seen when the first was,
--     last seen when the latest was, and, if any copy was in the link's last good read (last_seen_at >= last_ok_at), on
--     the school site: missing 0, not gone; else its missing and gone are as they were. The other copies are deleted,
--     except one made an assignment, which is never deleted: when a group has two or more of those (he made one from
--     each of two copies), the one kept is the one already on the key if there is one, else as above, and each other
--     stays on its old key, as it was (has_uid true). No read has that key again, so two reads on it is gone and its
--     assignment is marked "no longer on the school site": a copy the parents can delete. Answers how many rows it
--     deleted. Run again it changes nothing.
--   • hub_schema_version() (9). The pages take every version up to 99, and none asks for anything new on 9.
--
-- Rules
--   • One transaction. It refuses to run without 0008, twice, or on a database that isn't as 0008 left it.
--   • No table or column changes, so row-level security is as 0008 left it. Rows are rewritten (the keys) and copies
--     deleted, as above; nothing else.
--   • school_rows keeps 0006's rules: stable, not a definer, set search_path = '', revoked from public, anon and
--     authenticated (revoked again here, so its grants are exactly as before); school_rekey is not a definer either, sets
--     search_path = '', and is revoked from public, anon, authenticated and service_role.
--
-- Undo (not needed: nothing on the pages changes). If wanted, in one go: 0006's school_rows again (its "create function
-- private.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)" block, to its "$$;", with
-- create or replace) and hub_schema_version() returning 8 (docs/v1.3-homework.md §16.9). The rekeyed rows then change
-- once more at the next read (each item read with a UID is a new row again, and the rekeyed ones go missing, then
-- gone), and every change of UIDs adds them again, as before 0009. school_rekey can stay (nothing calls it). 0009 can
-- then run again, and makes the copies one row again.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0008 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 8 then
    raise exception 'The first-import check (migration 0008) isn''t installed (hub_schema_version() is %). Run 0008_school_check.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 9 then
    raise exception 'The school items'' keys (migration 0009) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  -- What this migration replaces and reads is as 0008 left it (or as the undo above leaves it: the same).
  if to_regprocedure('private.school_rows(text,jsonb,text,int,date)') is null
     or (select p.prorettype <> 'record'::regtype or not p.proretset from pg_proc p
         where p.oid = to_regprocedure('private.school_rows(text,jsonb,text,int,date)'))
     or to_regprocedure('public.school_store(uuid,uuid,jsonb,text,int)') is null
     or to_regprocedure('private.clean_text(text,int)') is null
     or to_regprocedure('private.clean_block(text,int)') is null
     or to_regprocedure('private.safe_date(text)') is null
     or to_regprocedure('private.safe_instant(text)') is null
     or to_regprocedure('private.tz()') is null
     or not exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.school_items') and c.contype = 'u'
                                                    and pg_get_constraintdef(c.oid) = 'UNIQUE (feed_id, key)')
     or (select count(*) from pg_attribute a
         where not a.attisdropped and a.attnum > 0
           and ((a.attrelid = to_regclass('public.school_items')
                 and a.attname in ('id', 'feed_id', 'key', 'has_uid', 'title', 'subject', 'first_day', 'last_day', 'due_date', 'starts_at',
                                   'hidden', 'assignment_id', 'made_at', 'missing', 'gone_at', 'first_seen_at', 'last_seen_at'))
                or (a.attrelid = to_regclass('public.school_feeds') and a.attname in ('id', 'kind', 'last_ok_at')))) <> 20 then
    raise exception 'This database isn''t as migration 0008 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- One read's items (§11.3), replaced: a UID is never part of the key
-- ---------------------------------------------------------------------
-- One read's items as the hub keeps them (school_store): each object's text cleaned as the
-- assignments' tidy trigger cleans it (title on one line, at most 120; class at most 40; description
-- with its line breaks, at most 4000), keyed, and only what the hub uses: assignments due from
-- p_today - 14 to p_today + 120 (the due date by p_rule and p_shift), schedule and games items with a
-- start from p_today to p_today + 55 (busy time can't use more, §5.3). An item without a title, or
-- without its dates, is left out; an end before the start is dropped. The key: an assignment's class,
-- title and first day (a line break, which clean_text never leaves in either, between the class and the
-- title, so two classes' "Homework" due the same day are two items), a schedule or games item's title
-- and start. 0009: with a UID or without (Blackbaud gives every event a new one each time it makes its
-- feed again, every hour or two), so has_uid is false on every row, and the uid isn't read. A key
-- repeated in one read: the last one wins. Everything else is 0006's, word for word.
create or replace function private.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)
returns table (n bigint, key text, has_uid boolean, title text, subject text, details text,
               first_day date, last_day date, due_date date, starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with raw as (
    select x.n,
           nullif(private.clean_text(x.j ->> 'title', 120), '') as title,
           nullif(private.clean_text(x.j ->> 'subject', 40), '') as subject,
           nullif(private.clean_block(x.j ->> 'details', 4000), '') as details,
           private.safe_date(x.j ->> 'first_day') as f,
           private.safe_date(x.j ->> 'last_day') as l,
           private.safe_instant(x.j ->> 'starts_at') as s,
           private.safe_instant(x.j ->> 'ends_at') as e
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]' end) with ordinality x (j, n)
    where jsonb_typeof(x.j) = 'object'
  ),
  shaped as (
    select r.n, r.title, r.subject, r.details,
           r.f, greatest(coalesce(r.l, r.f), r.f) as l,
           (case when p_rule = 'start' then r.f else greatest(coalesce(r.l, r.f), r.f) end) + coalesce(p_shift, 0) as due,
           r.s, case when r.e >= r.s then r.e end as e
    from raw r
    where r.title is not null
      and case when p_kind = 'assignments' then r.f is not null else r.s is not null end
  ),
  kept as (
    select s.*,
           -- 0009: the key 0006 gives an item without a UID, for every item.
           md5(case when p_kind = 'assignments'
                    then 'title:' || lower(coalesce(s.subject, '')) || E'\n' || lower(s.title) || '|' || to_char(s.f, 'YYYY-MM-DD')
                    else 'title:' || lower(s.title) || '|' || to_char(s.s at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') end) as k
    from shaped s
    where case when p_kind = 'assignments' then s.due between p_today - 14 and p_today + 120
               else (s.s at time zone private.tz())::date between p_today and p_today + 55 end
  )
  select distinct on (k.k) k.n, k.k, false, k.title,
         case when p_kind = 'assignments' then k.subject end,
         case when p_kind = 'assignments' then k.details end,
         case when p_kind = 'assignments' then k.f end,
         case when p_kind = 'assignments' then k.l end,
         case when p_kind = 'assignments' then k.due end,
         case when p_kind <> 'assignments' then k.s end,
         case when p_kind <> 'assignments' then k.e end
  from kept k
  order by k.k, k.n desc;
$$;

-- ---------------------------------------------------------------------
-- The rows already stored: their keys, and one row an item
-- ---------------------------------------------------------------------
-- Every school_items row on the key school_rows gives it (from its class, title and first day, or its title and
-- start, exactly as school_rows computes it from a read), has_uid false. Of a link's rows with one key (the copies
-- Blackbaud's new UIDs made) one row stays: the one made an assignment; else one made one once (its assignment deleted
-- since); else one hidden; else one still on the school site; else the one seen last; then by id. It is hidden if any
-- copy was, first seen when the first was and last seen when the latest was, and on the school site (missing 0, not
-- gone) if any copy was in the link's last good read; else its missing and gone stay. The others are deleted, but
-- never one made an assignment: of two or more of those the one already on the key is kept if there is one (else as
-- above), and each other stays on its old key, as it was. Answers how many rows it deleted; run again, it changes
-- nothing. 0009 runs it once; nobody else calls it.
create or replace function private.school_rekey()
returns int
language plpgsql
set search_path = ''
as $$
declare
  g     record;
  v_n   int;
  v_del int := 0;
begin
  for g in
    select k.feed_id, k.ck,
           (array_agg(k.id order by k.assignment_id is not null desc, (k.assignment_id is not null and k.key = k.ck) desc,
                                    k.made_at is not null desc, k.hidden desc, k.gone_at is null desc, k.last_seen_at desc, k.id))[1] as keep,
           array_agg(k.id) filter (where k.assignment_id is null) as plain,
           bool_or(k.hidden) as hidden,
           coalesce(bool_or(k.last_seen_at >= k.last_ok_at), false) as seen,
           min(k.first_seen_at) as first_seen,
           max(k.last_seen_at) as last_seen
    from (select i.id, i.feed_id, i.key, i.assignment_id, i.made_at, i.hidden, i.gone_at, i.first_seen_at, i.last_seen_at, f.last_ok_at,
                 md5(case when f.kind = 'assignments'
                          then 'title:' || lower(coalesce(i.subject, '')) || E'\n' || lower(i.title) || '|' || to_char(i.first_day, 'YYYY-MM-DD')
                          else 'title:' || lower(i.title) || '|' || to_char(i.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') end) as ck
          from public.school_items i
          join public.school_feeds f on f.id = i.feed_id) k
    where k.ck is not null
    group by k.feed_id, k.ck
  loop
    -- The other copies first, so the one kept can take the key (a copy without a UID may have it already).
    delete from public.school_items i where i.id = any (g.plain) and i.id <> g.keep;
    get diagnostics v_n = row_count;
    v_del := v_del + v_n;
    update public.school_items i
    set key = g.ck, has_uid = false, hidden = g.hidden, first_seen_at = g.first_seen, last_seen_at = g.last_seen,
        missing = case when g.seen then 0 else i.missing end,
        gone_at = case when g.seen then null else i.gone_at end
    where i.id = g.keep;
  end loop;
  return v_del;
end;
$$;

do $$
begin
  perform private.school_rekey();
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- Nothing on the pages waits for 9: they read the same answers on 8. (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 9;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- school_rows as 0006 revokes it (the definer functions call it; nobody else), and the new school_rekey from every
-- API role (the owner runs it). hub_schema_version keeps its grants.
-- ---------------------------------------------------------------------
revoke execute on function private.school_rows(text, jsonb, text, int, date)      from public, anon, authenticated;
revoke execute on function private.school_rekey()                                 from public, anon, authenticated, service_role;

commit;
