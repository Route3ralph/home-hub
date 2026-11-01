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
--     without a UID since 0006; two of one class with the same title on the same first day are one item, and so are two
--     classes the hub reads as one (the class is what the title names, a section and a block left out: "Music - Band
--     (A)" and "Music - Choir (B)" are both Music) with the same title on the same first day: the last in the read wins,
--     and the other's description isn't kept (0008's UIDs kept them apart, but no UID lasts an hour).
--   • Replaced, with the same signature: public.school_store(uuid, uuid, jsonb, text, int), for its moved-date step
--     only, which from 0009 every Blackbaud item goes through: (a) it pairs this read's new keys with the old rows
--     nearest first across the whole read (the pair with the fewest days between them first, then the feed's order),
--     not new key by new key in the feed's order, so a due date the school moves takes the new date nearest the old
--     one even when another item of that class and title is posted in the same read and listed first; (b) it never
--     moves a row he hid, or one made an assignment that isn't open any more (done, dropped or deleted): without a
--     UID, a same-class, same-title item deleted and another added in one read looks like a move, and moving that row
--     would hide the new item (it would come hidden, or made already); that row goes missing, then gone, and the new
--     item is New. Everything else is 0006's, word for word.
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
--   • After that check it locks private.school_sync, public.school_feeds and public.school_items against writes (not
--     reads) until it commits, a few milliseconds: a read (school_begin or school_store) or an item action (Quick, Plan
--     with Pat, Hide, a parent's Add) under way finishes first, and the rekey below sees what it wrote; one that starts
--     now waits, then keys its items the new way. school_sync comes first, as in school_begin and school_store (each
--     writes it before the other two), so neither can hold one of the others while waiting for it.
--   • No table or column changes, so row-level security is as 0008 left it. Rows are rewritten (the keys) and copies
--     deleted, as above; nothing else.
--   • school_rows keeps 0006's rules: stable, not a definer, set search_path = '', revoked from public, anon and
--     authenticated (revoked again here, so its grants are exactly as before); school_store keeps 0006's rules too: a
--     definer, set search_path = '', revoked from public, anon and authenticated and granted to service_role (again
--     here, as 0006 does); school_rekey is not a definer, sets search_path = '', and is revoked from public, anon,
--     authenticated and service_role.
--
-- Undo (not needed: nothing on the pages changes). If wanted, in one go: 0006's school_rows and school_store again (their
-- "create function private.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)" and "create
-- function public.school_store(p_run uuid, p_feed uuid, p_items jsonb, p_stop text, p_repeats int default 0)" blocks,
-- each to its "$$;", with create or replace) and hub_schema_version() returning 8 (docs/v1.3-homework.md §16.9). The
-- rekeyed rows then change once more at the next read (each item read with a UID is a new row again, and the rekeyed
-- ones go missing, then gone), and every change of UIDs adds them again, as before 0009. school_rekey can stay (nothing
-- calls it). 0009 can then run again, and makes the copies one row again.
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
     or (select p.prorettype <> 'jsonb'::regtype from pg_proc p where p.oid = to_regprocedure('public.school_store(uuid,uuid,jsonb,text,int)'))
     or to_regprocedure('private.school_failed(uuid,text)') is null
     or to_regprocedure('private.school_apply(uuid)') is null
     or to_regprocedure('public.today_local()') is null
     or to_regprocedure('private.now()') is null
     or to_regclass('private.school_sync') is null
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
                 and a.attname in ('id', 'feed_id', 'key', 'has_uid', 'title', 'subject', 'details', 'first_day', 'last_day', 'due_date',
                                   'starts_at', 'ends_at', 'hidden', 'assignment_id', 'made_at', 'missing', 'gone_at', 'first_seen_at',
                                   'last_seen_at'))
                or (a.attrelid = to_regclass('public.school_feeds')
                    and a.attname in ('id', 'kind', 'date_rule', 'date_shift', 'removed_at', 'last_try_at', 'last_ok_at', 'last_stop', 'fails',
                                      'last_count', 'last_repeats', 'next_at'))
                or (a.attrelid = to_regclass('private.school_sync') and a.attname in ('id', 'run_id', 'lease_until', 'handed'))
                or (a.attrelid = to_regclass('public.assignments') and a.attname in ('id', 'status')))) <> 37 then
    raise exception 'This database isn''t as migration 0008 left it. Nothing was changed.';
  end if;
end;
$$;

-- No read or item action writes the school rows while they are rekeyed (Rules, above). school_sync first: school_begin
-- and school_store write it before school_feeds and school_items, so a read under way finishes, and a read that starts
-- now waits for this commit before it touches anything (even its moved-date step's reads), then uses the school_rows
-- below. Plain reads (the pages, the status card) aren't held up.
lock table private.school_sync, public.school_feeds, public.school_items in exclusive mode;

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
-- One link's read (§11.3), replaced: the moved-date step pairs nearest first, and never moves a hidden or closed row
-- ---------------------------------------------------------------------
-- One link's read, while p_run holds the lease (else {stored: false, stop: 'late'}, nothing changed).
-- p_stop: the read's fixed code when it failed (anything else is stored as 'error'); nothing changes but
-- the link's status: fails + 1 and the next read 1, 2, 4, then 8 hours on (each 10 minutes early, so
-- the hourly run finds it due). Otherwise p_items (the shape private.school_rows reads; at most 400
-- assignments or 2,000 schedule or games items: else 'too_many', nothing applied) are stored:
--   • a read with nothing in it when 3 or more items were there is 'empty' and not applied;
--   • new items are added, the others updated (an item back on the site is no longer gone);
--   • an Assignments item without a UID that the last good read saw, still inside the window and not
--     gone, absent from this one, with a new key of the same class and title in it, is the same item
--     with its date moved (it keeps its row, and its assignment). 0009: the nearest such pairs first
--     across the read; never a row he hid, or one made an assignment that isn't open any more;
--   • an item inside the window absent from a good, non-empty read is missing once more; from two in a
--     row it is gone (marked; a schedule or games item is deleted, being only busy time);
--   • past items nobody made an assignment are let go (assignments due before today - 14, busy time
--     before today);
--   • the school's changes reach the assignments made from it (private.school_apply).
-- A good read clears the failures and is due again in 50 minutes. Answers {stored, stop, kept, added,
-- missing, gone}. Only fixed codes are stored, never the job's error text or anything from the feed.
-- Everything but the moved-date step is 0006's, word for word.
create or replace function public.school_store(p_run uuid, p_feed uuid, p_items jsonb, p_stop text, p_repeats int default 0)
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
    select count(*) into v_n from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today) x;
    if v_n > (case when v_asg then 400 else 2000 end) then
      v_stop := 'too_many';
    end if;
  end if;
  if v_stop is null and v_n = 0 then
    select count(*) into v_live from public.school_items i
    where i.feed_id = p_feed and i.gone_at is null
      and (i.due_date between v_today - 14 and v_today + 120
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
  -- deleted and another of that title posted: moving it would hide the new one).
  if v_asg then
    for c in
      select x.key as new_key, o.id as old_id, o.key as old_key
      from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today) x
      join public.school_items o
        on o.feed_id = p_feed and not o.has_uid and lower(o.title) = lower(x.title)
       and lower(coalesce(o.subject, '')) = lower(coalesce(x.subject, ''))
       and o.gone_at is null and o.last_seen_at >= v_f.last_ok_at
       and o.due_date between v_today - 14 and v_today + 120
       and not o.hidden
       and (o.made_at is null or exists (select 1 from public.assignments a where a.id = o.assignment_id and a.status = 'open'))
      where not x.has_uid
        and not exists (select 1 from public.school_items i where i.feed_id = p_feed and i.key = x.key)
        and not exists (select 1 from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today) y
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
    select * from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today)
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

  -- Missing from this read (a good, non-empty one), inside the window: once more; from two, gone.
  if v_n > 0 then
    with m as (
      update public.school_items i
      set missing = i.missing + 1, gone_at = case when i.missing + 1 >= 2 then v_now end
      where i.feed_id = p_feed and i.gone_at is null
        and not exists (select 1 from private.school_rows(v_f.kind, p_items, v_f.date_rule, v_f.date_shift, v_today) x where x.key = i.key)
        and (i.due_date between v_today - 14 and v_today + 120
             or (i.starts_at at time zone v_tz)::date between v_today and v_today + 55)
      returning i.gone_at
    )
    select count(*), count(m.gone_at) into v_missing, v_gone from m;
  end if;
  -- Schedule and games items gone, and past items nobody made an assignment, are let go.
  delete from public.school_items i
  where i.feed_id = p_feed
    and ((not v_asg and i.gone_at is not null)
         or (i.due_date < v_today - 14 and i.assignment_id is null)
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
-- school_rows as 0006 revokes it (the definer functions call it; nobody else), school_store as 0006 revokes and
-- grants it (hub-jobs only), and the new school_rekey from every API role (the owner runs it). hub_schema_version keeps
-- its grants.
-- ---------------------------------------------------------------------
revoke execute on function private.school_rows(text, jsonb, text, int, date)      from public, anon, authenticated;
revoke execute on function public.school_store(uuid, uuid, jsonb, text, int)      from public, anon, authenticated;
grant  execute on function public.school_store(uuid, uuid, jsonb, text, int)      to service_role;
revoke execute on function private.school_rekey()                                 from public, anon, authenticated, service_role;

commit;
