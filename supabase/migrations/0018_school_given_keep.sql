-- =====================================================================
-- HOME HUB v1.3 — migration 0018: what the school gave stays 30 days, and open homework keeps following it
-- Apply once, after 0017. Nothing on the pages waits for it; hub-jobs (its school action sends p_from only when
-- hub_schema_version() is 18 or more) goes live before or after it.
-- The contract is docs/v1.3-homework.md §23.6.
--
-- Why
--   On a link dated by the day each assignment was given ('assigned', 0015), the hub kept an item only while that day
--   was in the last 14 days, and showed it in New from school only while it was in the last 10. Two things went wrong:
--   • an item nobody added in its first 10 days left New from school, and 4 days later it was deleted, without a word;
--   • homework made from one stopped following the school 14 days after it was given: a title, class or description
--     the teacher changed later never reached it, and one the teacher took off the school site was never marked gone.
--
-- What it changes (an 'assigned' link only; a 'start' or 'end' link, and Schedule and Games links, are as on 17)
--   • New from school (his on My day, and the parents' status card, new and hidden): the items given from today − 30
--     (was 10) to today + 30.
--   • Kept: every item given in the last 30 days (was 14), read again at each read; one nobody added is let go 30 days
--     after it was given (school_store and school_trim).
--   • Followed: an item made homework that is still open is read again for as long as the read covers the day it was
--     given (hub-jobs sends 180 days back, p_from): a description the school changes reaches the homework (school_apply),
--     and an item the school takes off its site (or renames: a new title is a new item, as from 0009) is missing, then
--     gone (the status card's "no longer on the school site"). Its description is kept while the homework is open, as
--     the homework's own copy is; it is emptied 30 days after the day it was given once it isn't (school_trim).
--   • Changed signature (the old one dropped; hub-jobs passes every argument by name):
--       public.school_store(p_run uuid, p_feed uuid, p_items jsonb, p_stop text, p_repeats int default 0, p_from date default null)
--     p_from is the first day the read covered (hub-jobs: today − 180). Null, as hub-jobs before this release sends it:
--     today − 14, as on 17. An item is marked missing only from a read that covered its day.
--   • New: private.school_kept(p_feed uuid, p_items jsonb, p_today date, p_cover date), the items school_store keeps
--     from one read. Replaced, with the same signatures: private.school_new(uuid), public.school_feed_status(uuid),
--     private.school_trim(). private.school_rows(text, jsonb, text, int, date) stays as 0015 made it (unused from 18).
--   • Once: an item on an 'assigned' link given more than 10 days ago that nobody added or hid had already left New
--     from school; it is hidden (the status card's hidden list, with Show), so nothing that left comes back unasked.
--   • hub_schema_version() (18). The pages ask for nothing new on 18.
--
-- Rules
--   • One transaction. It refuses to run without 0017, twice, on a database set back to 17, or on one that isn't as
--     0017 left it.
--   • No table or column changes; row-level security as 0017 left it. set search_path = '' on every function; the
--     definers as before; the new school_store revoked from public, anon and authenticated and granted to service_role,
--     as 0006 does; school_kept revoked from public, anon and authenticated.
--   • What a later read can't take back: nothing. Items it keeps longer are let go on the old rules after an undo.
--
-- Undo (not needed: it only keeps items longer). If wanted, in one go:
--   drop function public.school_store(uuid, uuid, jsonb, text, int, date);
--   drop function private.school_kept(uuid, jsonb, date, date);
--   then 0009's school_store ("create or replace function public.school_store(p_run uuid, p_feed uuid, p_items jsonb,
--   p_stop text, p_repeats int default 0)", to its "$$;") with 0006's revoke and grant for it, 0015's school_new and
--   school_feed_status, 0006's school_trim (as "create or replace") and 0017's hub_schema_version (each block to its
--   "$$;"). hub-jobs must be the one before this release first (it sends p_from). The items hidden once stay hidden.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0017 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 17 then
    raise exception 'Bring and the Tomorrow message (migration 0017) isn''t installed (hub_schema_version() is %). Run 0017_bring_tomorrow.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 18 then
    raise exception 'Keeping what the school gave (migration 0018) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regprocedure('public.school_store(uuid, uuid, jsonb, text, int, date)') is not null then
    raise exception 'Keeping what the school gave (migration 0018) is already installed, but hub_schema_version() was set back to 17. To switch it on again, make hub_schema_version() return 18 (docs/v1.3-homework.md §23.6). Nothing was changed.';
  end if;
  -- What this migration replaces and reads is as 0017 left it.
  if to_regprocedure('public.tomorrow_text(uuid)') is null
     or to_regprocedure('public.school_store(uuid, uuid, jsonb, text, int)') is null
     or to_regprocedure('private.school_rows(text, jsonb, text, int, date)') is null
     or to_regprocedure('private.school_new(uuid)') is null
     or to_regprocedure('public.school_feed_status(uuid)') is null
     or to_regprocedure('private.school_trim()') is null
     or to_regprocedure('private.school_apply(uuid)') is null
     or to_regprocedure('private.school_failed(uuid, text)') is null
     or not exists (select 1 from pg_constraint c where c.conrelid = 'public.school_feeds'::regclass and c.conname = 'school_feeds_date_rule_check'
                    and pg_get_constraintdef(c.oid) like '%assigned%')
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'school_items'
         and column_name in ('key', 'due_date', 'details', 'assignment_id', 'made_at', 'hidden', 'gone_at', 'missing', 'applied')) <> 9 then
    raise exception 'This database isn''t as migration 0017 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- What one read keeps (§23.6)
-- ---------------------------------------------------------------------
-- One read's items as the hub keeps them, for the link p_feed, by its rule and shift: 0015's school_rows, word for
-- word, but for its window. A Schedule or Games item: starting from p_today to p_today + 55, as before. An assignment:
-- from a 'start' or 'end' link, due from p_today - 14 to p_today + 120, as before; from an 'assigned' link (0018),
-- given from p_today - 30 (but never before p_cover, the first day the read covered) to p_today + 120, and given
-- earlier but on or after p_cover only when the hub already has it (its key) made homework that is still open.
-- STABLE, not a definer.
create function private.school_kept(p_feed uuid, p_items jsonb, p_today date, p_cover date)
returns table (n bigint, key text, has_uid boolean, title text, subject text, details text,
               first_day date, last_day date, due_date date, starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with lf as (
    select sf.id, sf.kind, sf.date_rule, sf.date_shift, sf.kind = 'assignments' and sf.date_rule = 'assigned' as given
    from public.school_feeds sf where sf.id = p_feed
  ),
  raw as (
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
           (case when lf.date_rule in ('start', 'assigned') then r.f else greatest(coalesce(r.l, r.f), r.f) end) + coalesce(lf.date_shift, 0) as due,
           r.s, case when r.e >= r.s then r.e end as e
    from raw r cross join lf
    where r.title is not null
      and case when lf.kind = 'assignments' then r.f is not null else r.s is not null end
  ),
  keyed as (
    select s.*,
           md5(case when lf.kind = 'assignments'
                    then 'title:' || lower(coalesce(s.subject, '')) || E'\n' || lower(s.title) || '|' || to_char(s.f, 'YYYY-MM-DD')
                    else 'title:' || lower(s.title) || '|' || to_char(s.s at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') end) as k
    from shaped s cross join lf
  ),
  kept as (
    select k.* from keyed k cross join lf
    where case when lf.kind <> 'assignments' then (k.s at time zone private.tz())::date between p_today and p_today + 55
               when not lf.given then k.due between p_today - 14 and p_today + 120
               else k.due between greatest(p_cover, p_today - 30) and p_today + 120
                    or (k.due >= p_cover and k.due < p_today + 120
                        and exists (select 1 from public.school_items i join public.assignments a on a.id = i.assignment_id and a.status = 'open'
                                    where i.feed_id = p_feed and i.key = k.k)) end
  )
  select distinct on (k.k) k.n, k.k, false, k.title,
         case when lf.kind = 'assignments' then k.subject end,
         case when lf.kind = 'assignments' then k.details end,
         case when lf.kind = 'assignments' then k.f end,
         case when lf.kind = 'assignments' then k.l end,
         case when lf.kind = 'assignments' then k.due end,
         case when lf.kind <> 'assignments' then k.s end,
         case when lf.kind <> 'assignments' then k.e end
  from kept k cross join lf
  order by k.k, k.n desc;
$$;

-- ---------------------------------------------------------------------
-- One link's read (§23.6)
-- ---------------------------------------------------------------------
-- 0009's school_store, with p_from (0018): the first day the read covered (hub-jobs sends today − 180; null, from a
-- hub-jobs before 0018: today − 14, as on 17). Everything is 0009's, word for word, but:
--   • its items are private.school_kept's (an 'assigned' link's window, above);
--   • an item it can find missing (and its moved-date step's old rows) are those inside the link's window that the read
--     covered: from a 'start' or 'end' link, due from today − 14 to today + 120, as before; from an 'assigned' link,
--     given from today − 30 (never before p_from) to today + 120, and, on or after p_from, one made homework that is
--     still open;
--   • an 'assigned' link's items nobody made an assignment are let go 30 days after they were given (was 14).
-- Answers as before: {stored, stop, kept, added, missing, gone}.
drop function public.school_store(uuid, uuid, jsonb, text, int);
create function public.school_store(p_run uuid, p_feed uuid, p_items jsonb, p_stop text, p_repeats int default 0,
                                    p_from date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now     timestamptz := private.now();
  v_today   date := public.today_local();
  v_tz      text := private.tz();
  v_f       public.school_feeds;
  v_asg     boolean;
  v_given   boolean;
  v_cover   date;
  v_low     date;
  v_stop    text;
  v_n       int;
  v_live    int;
  v_added   int := 0;
  v_missing int := 0;
  v_gone    int := 0;
  c         record;
begin
  if not exists (select 1 from private.school_sync y where y.id and y.run_id = p_run and y.lease_until >= v_now) then
    return jsonb_build_object('stored', false, 'stop', 'late');
  end if;
  -- This link's read is over, whatever its outcome (school_begin's note of where a dead run stopped).
  update private.school_sync y set handed = array_remove(y.handed, p_feed) where y.id and y.run_id = p_run;
  select * into v_f from public.school_feeds f where f.id = p_feed for update;
  if v_f.id is null or v_f.removed_at is not null then
    return jsonb_build_object('stored', false, 'stop', 'removed');
  end if;
  v_asg := v_f.kind = 'assignments';
  v_given := v_asg and v_f.date_rule = 'assigned';
  -- The first day this read covered, and the first day of the link's window that it covered.
  v_cover := case when p_from is null then v_today - 14 else greatest(p_from, v_today - 180) end;
  v_low := greatest(v_cover, v_today - case when v_given then 30 else 14 end);
  v_stop := case when p_stop is null then null
                 when p_stop in ('bad_link', 'redirect', 'unreachable', 'timeout', 'too_big', 'refused', 'gone', 'down', 'http',
                                 'sign_in', 'not_calendar', 'empty', 'too_many') then p_stop
                 else 'error' end;
  if v_stop is null and jsonb_typeof(p_items) is distinct from 'array' then
    v_stop := 'error';
  end if;
  if v_stop is null and jsonb_array_length(p_items) > 20000 then
    v_stop := 'too_many';
  end if;
  if v_stop is null then
    select count(*) into v_n from private.school_kept(p_feed, p_items, v_today, v_cover) x;
    if v_n > (case when v_asg then 400 else 2000 end) then
      v_stop := 'too_many';
    end if;
  end if;
  if v_stop is null and v_n = 0 then
    select count(*) into v_live from public.school_items i
    where i.feed_id = p_feed and i.gone_at is null
      and (i.due_date between v_low and v_today + 120
           or (i.starts_at at time zone v_tz)::date between v_today and v_today + 55);
    if v_live >= 3 then
      v_stop := 'empty';
    end if;
  end if;

  if v_stop is not null then
    perform private.school_failed(p_feed, v_stop);
    return jsonb_build_object('stored', false, 'stop', v_stop);
  end if;

  -- An Assignments item without a UID whose date moved: the item of the same class and title that the
  -- last good read saw, still inside the window, not gone and absent from this one, takes the new key.
  -- (An older one of the same title, a week's "Reading log" from before, is another item: past the
  -- window, or seen in this read.) 0009: every Blackbaud item comes here (no UID lasts an hour), so the
  -- old rows and the new keys are paired nearest first across the whole read (fewest days apart, then
  -- the feed's order, then the oldest row), each once, whatever order the feed lists them in; and a row
  -- he hid, or one made an assignment that isn't open any more, is never moved (its item may have been
  -- deleted and another of that title posted: moving it would hide the new one). 0018: the window is the
  -- one this read covered (an 'assigned' link's open homework from p_from too).
  if v_asg then
    for c in
      select x.key as new_key, o.id as old_id, o.key as old_key
      from private.school_kept(p_feed, p_items, v_today, v_cover) x
      join public.school_items o
        on o.feed_id = p_feed and not o.has_uid and lower(o.title) = lower(x.title)
       and lower(coalesce(o.subject, '')) = lower(coalesce(x.subject, ''))
       and o.gone_at is null and o.last_seen_at >= v_f.last_ok_at
       and (o.due_date between v_low and v_today + 120 or (v_given and o.due_date >= v_cover and o.made_at is not null))
       and not o.hidden
       and (o.made_at is null or exists (select 1 from public.assignments a where a.id = o.assignment_id and a.status = 'open'))
      where not x.has_uid
        and not exists (select 1 from public.school_items i where i.feed_id = p_feed and i.key = x.key)
        and not exists (select 1 from private.school_kept(p_feed, p_items, v_today, v_cover) y
                        where y.key = o.key)
      order by abs(o.first_day - x.first_day), x.n, o.first_seen_at, o.id
    loop
      -- (The pairs are read once, before any move: a row already moved, or a key already taken, is skipped.)
      update public.school_items i set key = c.new_key
      where i.id = c.old_id and i.key = c.old_key
        and not exists (select 1 from public.school_items j where j.feed_id = p_feed and j.key = c.new_key);
    end loop;
  end if;

  with x as (
    select * from private.school_kept(p_feed, p_items, v_today, v_cover)
  ),
  up as (
    insert into public.school_items as i (feed_id, key, has_uid, title, subject, details, first_day, last_day, due_date,
                                          starts_at, ends_at, first_seen_at, last_seen_at)
    select p_feed, x.key, x.has_uid, x.title, x.subject, x.details, x.first_day, x.last_day, x.due_date,
           x.starts_at, x.ends_at, v_now, v_now
    from x
    on conflict (feed_id, key) do update
    set has_uid = excluded.has_uid, title = excluded.title, subject = excluded.subject, details = excluded.details,
        first_day = excluded.first_day, last_day = excluded.last_day, due_date = excluded.due_date,
        starts_at = excluded.starts_at, ends_at = excluded.ends_at, last_seen_at = v_now, missing = 0, gone_at = null
    returning (xmax = 0) as added
  )
  select count(*) filter (where up.added) into v_added from up;

  -- Missing from this read (a good, non-empty one), inside the window it covered: once more; from two, gone.
  if v_n > 0 then
    with m as (
      update public.school_items i
      set missing = i.missing + 1, gone_at = case when i.missing + 1 >= 2 then v_now end
      where i.feed_id = p_feed and i.gone_at is null
        and not exists (select 1 from private.school_kept(p_feed, p_items, v_today, v_cover) x where x.key = i.key)
        and (i.due_date between v_low and v_today + 120
             or (i.starts_at at time zone v_tz)::date between v_today and v_today + 55
             or (v_given and i.due_date >= v_cover and i.due_date < v_today + 120
                 and exists (select 1 from public.assignments a where a.id = i.assignment_id and a.status = 'open')))
      returning i.gone_at
    )
    select count(*), count(m.gone_at) into v_missing, v_gone from m;
  end if;
  -- Schedule and games items gone, and past items nobody made an assignment, are let go.
  delete from public.school_items i
  where i.feed_id = p_feed
    and ((not v_asg and i.gone_at is not null)
         or (i.due_date < v_today - case when v_given then 30 else 14 end and i.assignment_id is null)
         or coalesce(i.ends_at, i.starts_at) < (v_today::timestamp at time zone v_tz));

  perform private.school_apply(p_feed);

  update public.school_feeds f
  set last_try_at = v_now, last_ok_at = v_now, last_stop = null, fails = 0, last_count = v_n,
      last_repeats = greatest(coalesce(p_repeats, 0), 0), next_at = v_now + interval '50 minutes'
  where f.id = p_feed;
  return jsonb_build_object('stored', true, 'stop', null, 'kept', v_n, 'added', v_added, 'missing', v_missing, 'gone', v_gone);
end;
$$;

-- ---------------------------------------------------------------------
-- The household's school rows (§13.3), replaced
-- ---------------------------------------------------------------------
-- 0006's, word for word, but (0018) on an 'assigned' link: an item's description stays while the homework made from it
-- is open (school_store reads it again), and items nobody made an assignment are let go 30 days after they were given
-- (was 14). school_begin calls it at every run.
create or replace function private.school_trim()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today date := public.today_local();
begin
  update public.school_items i
  set details = null, applied = case when i.applied is not null then jsonb_set(i.applied, '{details}', 'null') end
  where i.due_date < v_today - 30 and (i.details is not null or i.applied ->> 'details' is not null)
    and not (exists (select 1 from public.school_feeds f where f.id = i.feed_id and f.date_rule = 'assigned')
             and exists (select 1 from public.assignments a where a.id = i.assignment_id and a.status = 'open'));
  delete from public.school_items i
  where (i.due_date < v_today - case when exists (select 1 from public.school_feeds f where f.id = i.feed_id and f.date_rule = 'assigned')
                                     then 30 else 14 end
         and i.assignment_id is null)
     or coalesce(i.ends_at, i.starts_at) < (v_today::timestamp at time zone private.tz());
  delete from public.school_feeds f
  where f.removed_at is not null and not exists (select 1 from public.school_items i where i.feed_id = f.id);
end;
$$;

-- ---------------------------------------------------------------------
-- New from school (§23.6), replaced
-- ---------------------------------------------------------------------
-- His New from school: 0015's, word for word, but (0018) from an 'assigned' link the items given from today - 30 (was
-- 10) to today + 30.
create or replace function private.school_new(p_kid uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when exists (select 1 from public.school_feeds f where f.kid_id = p_kid and f.kind = 'assignments' and f.checked) then
    (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subject', x.subject, 'due_date', x.due_date,
                                                  'quick', not x.given and x.due_date - public.today_local() <= 3)
                               || case when x.given then '{"assigned": true}'::jsonb else '{}'::jsonb end
                               order by x.due_date, x.title, x.id), '[]')
     from (select i.id, i.title, i.subject, i.due_date, f.date_rule = 'assigned' as given
           from public.school_items i
           join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.checked
           where i.made_at is null and not i.hidden and i.gone_at is null
             and i.due_date between public.today_local() - case when f.date_rule = 'assigned' then 30 else 0 end
                                and public.today_local() + 30
           order by i.due_date, i.title, i.id
           limit 20) x)
  end;
$$;

-- The status card (§12.8): 0015's, word for word, but (0018) from an 'assigned' link new and hidden reach 30 days back
-- (was 10).
create or replace function public.school_feed_status(p_kid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now   timestamptz := private.now();
  v_today date := public.today_local();
begin
  if not private.is_member() or not exists (select 1 from public.homework_kids k where k.kid_id = p_kid) then
    return null;
  end if;
  return jsonb_build_object(
    'kid_id', p_kid,
    'last_run_at', (select y.last_run_at from private.school_sync y where y.id),
    'feeds', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', f.id, 'kind', f.kind, 'host', f.host, 'url_end', f.url_end, 'checked', f.checked,
                       'date_rule', f.date_rule, 'date_shift', f.date_shift, 'paused', f.paused,
                       'last_try_at', f.last_try_at, 'last_ok_at', f.last_ok_at, 'last_count', f.last_count,
                       'last_repeats', f.last_repeats, 'last_stop', f.last_stop, 'fails', f.fails, 'next_at', f.next_at,
                       'stale', not f.paused and k.active and p.active and coalesce(f.next_at < v_now - interval '2 hours', false))
                     order by case f.kind when 'assignments' then 1 when 'schedule' then 2 else 3 end), '[]')
              from public.school_feeds f
              join public.homework_kids k on k.kid_id = f.kid_id
              join public.people p on p.id = f.kid_id
              where f.kid_id = p_kid and f.removed_at is null),
    'check', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subject', x.subject,
                                                           'first_day', x.first_day, 'last_day', x.last_day, 'due_date', x.due_date,
                                                           'past', x.due_date < v_today)
                                        order by x.due_date, x.title, x.id), '[]')
              from (select i.* from public.school_items i
                    join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and not f.checked
                                                and f.removed_at is null
                    where i.due_date is not null and i.gone_at is null
                    order by i.due_date < v_today, abs(i.due_date - v_today), i.title, i.id limit 5) x),
    'new', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subject', x.subject, 'due_date', x.due_date)
                                      || case when x.given then '{"assigned": true}'::jsonb else '{}'::jsonb end
                                      order by x.due_date, x.title, x.id), '[]')
            from (select i.*, f.date_rule = 'assigned' as given from public.school_items i
                  join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.checked
                                              and f.removed_at is null
                  where i.made_at is null and not i.hidden and i.gone_at is null
                    and i.due_date between v_today - case when f.date_rule = 'assigned' then 30 else 0 end and v_today + 30
                  order by i.due_date, i.title, i.id limit 50) x),
    'hidden', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'subject', i.subject, 'due_date', i.due_date)
                                         || case when f.date_rule = 'assigned' then '{"assigned": true}'::jsonb else '{}'::jsonb end
                                         order by i.due_date, i.title, i.id), '[]')
               from public.school_items i
               join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.removed_at is null
               where i.made_at is null and i.hidden and i.gone_at is null
                 and i.due_date >= v_today - case when f.date_rule = 'assigned' then 30 else 0 end),
    'moved', (select coalesce(jsonb_agg(jsonb_build_object('assignment_id', a.id, 'title', a.title, 'from', a.due_date, 'to', i.due_date)
                                        order by a.due_date, a.title, a.id), '[]')
              from public.school_items i
              join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.date_rule <> 'assigned'
              join public.assignments a on a.id = i.assignment_id and a.status = 'open'
              where i.gone_at is null and i.due_date is distinct from a.due_date and a.due_date = (i.applied ->> 'due_date')::date),
    'gone', (select coalesce(jsonb_agg(jsonb_build_object('assignment_id', a.id, 'title', a.title, 'due_date', a.due_date)
                                       order by a.due_date, a.title, a.id), '[]')
             from public.school_items i
             join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid
             join public.assignments a on a.id = i.assignment_id and a.status = 'open'
             where i.gone_at is not null));
end;
$$;

-- ---------------------------------------------------------------------
-- Once: what had already left New from school stays out of it
-- ---------------------------------------------------------------------
-- An item on an 'assigned' link given more than 10 days ago that nobody added or hid had left New from school on 17.
-- From 18 New from school reaches 30 days back, so it would show again; it is hidden instead (the status card's
-- hidden list, with Show), and let go 30 days after it was given like the rest.
update public.school_items i
set hidden = true
from public.school_feeds f
where f.id = i.feed_id and f.kind = 'assignments' and f.date_rule = 'assigned'
  and i.made_at is null and not i.hidden and i.gone_at is null
  and i.due_date < public.today_local() - 10;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- Nothing on the pages asks for 18. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 18;
$$;

-- ---------------------------------------------------------------------
-- Function permissions: the new school_store as 0006 grants the old (hub-jobs only); school_kept as 0006 revokes
-- school_rows (the definer above calls it; nobody else). The replaced functions keep theirs.
-- ---------------------------------------------------------------------
revoke execute on function public.school_store(uuid, uuid, jsonb, text, int, date) from public, anon, authenticated;
grant  execute on function public.school_store(uuid, uuid, jsonb, text, int, date) to service_role;
revoke execute on function private.school_kept(uuid, jsonb, date, date)           from public, anon, authenticated;

commit;
