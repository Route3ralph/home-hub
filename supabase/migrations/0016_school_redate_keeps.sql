-- =====================================================================
-- HOME HUB v1.3 — migration 0016: Change dates keeps the due dates of homework already added
-- Apply once, after 0015. No page, Edge Function or cron.sql change goes with it (docs/v1.3-homework.md §23.4).
-- The contract is docs/v1.3-homework.md §23.4.
--
-- Why
--   Change dates (a checked Assignments link's question again, schema 15) says "…homework already added keeps its due
--   dates." 0015 kept that promise only for the answer 'assigned'. From 'end' to 'start' (or a shift of a day), every
--   item's day moved, and school_apply then moved each open assignment made from one whose due date nobody had changed
--   (its due date was still the one the feed last wrote, applied.due_date) to the item's new day.
--
-- What it changes
--   • Replaced, with the same signature: public.check_school_feed(uuid, text, int). On a link that was already
--     checked, an item whose day changes forgets the due date the feed last wrote there (applied.due_date null, as
--     0015 does for 'assigned'), so school_apply leaves its assignment's due date as it is, and nothing reads as
--     "moved" (school_marks and the status card need that date). An item whose day doesn't change (the same answer
--     again, or a one-day item) keeps it, so the school's own later moves still reach its assignment. The first-import
--     check (a link not checked yet) is as 0006 made it. Everything else is 0015's, word for word.
--   • hub_schema_version() (16). The pages ask for nothing new on 16.
--
-- Rules
--   • One transaction. It refuses to run without 0015, twice, on a database set back to 15, or on one that isn't as
--     0015 left it.
--   • No table, column, grant or policy changes. The function stays a definer with set search_path = '', and keeps
--     its grants (create or replace).
--
-- Undo (not needed: it only stops dates moving). If wanted, in one go: 0015's "create or replace function
-- public.check_school_feed(p_feed uuid, p_date_rule text, p_date_shift int)" and "create or replace function
-- public.hub_schema_version()" blocks (each to its "$$;"): check_school_feed as 0015 made it and hub_schema_version()
-- returning 15. 0016 can then run again.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0015 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 15 then
    raise exception 'The school''s assigned dates (migration 0015) aren''t installed (hub_schema_version() is %). Run 0015_school_assigned_dates.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 16 then
    raise exception 'Change dates keeping due dates (migration 0016) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regprocedure('public.check_school_feed(uuid, text, int)') is not null
     and (select p.prosrc like '%v_f.checked and%' from pg_proc p where p.oid = to_regprocedure('public.check_school_feed(uuid, text, int)')) then
    raise exception 'Change dates keeping due dates (migration 0016) is already installed, but hub_schema_version() was set back to 15. To switch it on again, make hub_schema_version() return 16 (docs/v1.3-homework.md §23.4). Nothing was changed.';
  end if;
  -- What this migration replaces and reads is as 0015 left it.
  if to_regprocedure('public.check_school_feed(uuid, text, int)') is null
     or (select p.prorettype <> 'jsonb'::regtype or not p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.check_school_feed(uuid, text, int)'))
     or to_regprocedure('public.school_item_action(uuid, text, date)') is null
     or to_regprocedure('private.school_apply(uuid)') is null
     or to_regprocedure('public.school_feed_status(uuid)') is null
     or to_regprocedure('private.is_admin()') is null
     or not exists (select 1 from pg_constraint c where c.conrelid = 'public.school_feeds'::regclass and c.conname = 'school_feeds_date_rule_check'
                    and pg_get_constraintdef(c.oid) like '%assigned%')
     or (select count(*) from pg_attribute a
         where a.attrelid = 'public.school_items'::regclass and not a.attisdropped and a.attnum > 0
           and a.attname in ('feed_id', 'first_day', 'last_day', 'due_date', 'applied')) <> 5 then
    raise exception 'This database isn''t as migration 0015 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The first-import check and Change dates (§23.4), replaced
-- ---------------------------------------------------------------------
-- 0015's, but (0016) on a link already checked, an item whose day changes forgets the due date the feed last wrote
-- (applied.due_date), as 'assigned' does on any link: school_apply then leaves its assignment's due date as it is.
-- v_f is read before the link is marked checked, so v_f.checked is whether it was checked before this answer.
create or replace function public.check_school_feed(p_feed uuid, p_date_rule text, p_date_shift int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.school_feeds;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  select * into v_f from public.school_feeds f where f.id = p_feed for update;
  if v_f.id is null or v_f.removed_at is not null then
    raise exception 'That school link isn''t there any more.' using errcode = '22023';
  end if;
  if v_f.kind <> 'assignments' then
    raise exception 'Only the Assignments link has dates to check.' using errcode = '22023';
  end if;
  if p_date_rule is null or p_date_rule not in ('start', 'end', 'assigned') or p_date_shift is null or p_date_shift not between -1 and 1 then
    raise exception 'Choose the start or the end date, and a shift of -1, 0 or 1 day.' using errcode = '22023';
  end if;
  update public.school_feeds f set date_rule = p_date_rule, date_shift = p_date_shift, checked = true where f.id = p_feed;
  update public.school_items i
  set due_date = (case when p_date_rule in ('start', 'assigned') then i.first_day else i.last_day end) + p_date_shift,
      applied = case when i.applied is not null
                          and (p_date_rule = 'assigned'
                               or (v_f.checked and (case when p_date_rule in ('start', 'assigned') then i.first_day else i.last_day end) + p_date_shift
                                                   is distinct from i.due_date))
                     then jsonb_set(i.applied, '{due_date}', 'null') else i.applied end
  where i.feed_id = p_feed and i.first_day is not null;
  perform private.school_apply(p_feed);
  return public.school_feed_status(v_f.kid_id);
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- Nothing on the pages asks for 16. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 16;
$$;

commit;
