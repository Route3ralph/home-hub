-- =====================================================================
-- HOME HUB v1.3 — migration 0008: the first-import check when nothing is due yet
-- Apply once, after 0007, and only once the site that understands it is live (docs/v1.3-homework.md §16.6).
-- The contract is docs/v1.3-homework.md §11.2 step 7, §12 item 2 (set_school_feed) and §12.8.
--
-- Why
--   The status card's first-import check (school_feed_status's check: an Assignments link not checked yet) showed
--   only items due today or later. A link read over a weekend or a holiday may hold only past ones (the reader keeps
--   assignments due from today - 14 days), so the check was empty, the page had nothing to ask, and until a parent
--   answers it nothing from the link reaches the kid or the tutor.
--
-- What it changes
--   • Replaced, with the same signature: public.school_feed_status(uuid). Its check is up to 5 items of that link
--     that are still on the school site (gone_at is null): the ones to come (due_date >= today) earliest first, and,
--     when fewer than 5 are to come, the most recent past ones (due_date < today), latest first, to fill it; answered
--     in date order (due_date, title, id), each with past (due_date < today) beside 0006's keys. With 5 or more to
--     come it is exactly 0006's check, with past: false on each. Every other key is exactly as 0006 made it, and the
--     check is still there only while the Assignments link exists, isn't removed and isn't checked.
--   • Replaced, with the same signature: public.set_school_feed(uuid, text, text) (Add link, Replace, Remove). A removed
--     link added again (Remove kept its row for the assignments made from it) starts as a new link, not read yet: its
--     last_try_at, last_ok_at, last_count and last_repeats are cleared, so the status card no longer describes the old
--     link's last read as the new one's (the page's "all 7 of its assignments are already past" for a link nothing has
--     been read from, and "Last read …" on its row), and Check now reads it at once. Replace on a live link keeps its
--     last read, as before; everything else is 0006's, word for word. The rows a 0007 database already has are as they
--     were: a link removed before 0008 starts as new when it is added again after it.
--   • hub_schema_version() (8). The pages take every version up to 99, and none asks for anything new on 8: a page
--     reads the check the same way on 7 (no past, and nothing when everything is past) and on 8.
--
-- Rules
--   • One transaction. It refuses to run without 0007, twice, or on a database that isn't as 0007 left it.
--   • Additive: the new answer is the old one plus past, and five items where there were none. No table or column
--     changes, so row-level security is as 0007 left it. No rows are written.
--   • The replaced functions keep 0006's rules: definer, set search_path = ''; school_feed_status stable, members only
--     (null for anyone else), set_school_feed parents only; each revoked from public, anon and service_role and granted
--     to authenticated again, as 0006 does.
--
-- Undo (not needed: the new answer is a superset of the old, the page reads both, and a link added again that starts
-- as not read is read within the hour). If wanted, in one go: 0006's school_feed_status and set_school_feed again (their
-- "create function public.school_feed_status(p_kid uuid)" and "create function public.set_school_feed(p_kid uuid,
-- p_kind text, p_url text)" blocks, each to its "$$;", with create or replace) and hub_schema_version() returning 7
-- (docs/v1.3-homework.md §16.7). 0008 can then run again.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0007 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 7 then
    raise exception 'The coach view (migration 0007) isn''t installed (hub_schema_version() is %). Run 0007_homework_coach.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 8 then
    raise exception 'The first-import check''s past dates (migration 0008) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  -- What this migration replaces and reads is as 0007 left it (or as the undo above leaves it: the same).
  if to_regclass('public.coach_notes') is null
     or to_regprocedure('public.school_feed_status(uuid)') is null
     or (select p.prorettype from pg_proc p where p.oid = to_regprocedure('public.school_feed_status(uuid)')) <> 'jsonb'::regtype
     or to_regprocedure('public.set_school_feed(uuid,text,text)') is null
     or (select p.prorettype from pg_proc p where p.oid = to_regprocedure('public.set_school_feed(uuid,text,text)')) <> 'jsonb'::regtype
     or to_regprocedure('public.today_local()') is null
     or to_regprocedure('private.now()') is null
     or to_regprocedure('private.is_member()') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('private.school_url(text)') is null
     or to_regclass('private.school_sync') is null
     or to_regclass('private.school_feed_urls') is null
     or (select count(*) from pg_attribute a
         where not a.attisdropped and a.attnum > 0
           and ((a.attrelid = to_regclass('public.school_items')
                 and a.attname in ('id', 'feed_id', 'title', 'subject', 'first_day', 'last_day', 'due_date', 'gone_at', 'made_at',
                                   'hidden', 'assignment_id', 'applied'))
                or (a.attrelid = to_regclass('public.school_feeds')
                    and a.attname in ('id', 'kid_id', 'kind', 'host', 'url_end', 'checked', 'date_rule', 'date_shift', 'paused',
                                      'last_try_at', 'last_ok_at', 'last_count', 'last_repeats', 'last_stop', 'fails', 'next_at',
                                      'removed_at'))
                or (a.attrelid = to_regclass('private.school_sync') and a.attname in ('id', 'last_run_at'))
                or (a.attrelid = to_regclass('private.school_feed_urls') and a.attname in ('feed_id', 'url'))
                or (a.attrelid = to_regclass('public.homework_kids') and a.attname in ('kid_id', 'active'))
                or (a.attrelid = to_regclass('public.people') and a.attname in ('id', 'active'))
                or (a.attrelid = to_regclass('public.assignments') and a.attname in ('id', 'title', 'due_date', 'status')))) <> 41 then
    raise exception 'This database isn''t as migration 0007 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The status card (§12.8), replaced: the first-import check when nothing is due yet
-- ---------------------------------------------------------------------
-- The status card (members; null for anyone else, or a kid without homework):
--   {kid_id, last_run_at (the read job's last run),
--    feeds: [{id, kind, host, url_end, checked, date_rule, date_shift, paused, last_try_at, last_ok_at,
--             last_count, last_repeats, last_stop, fails, next_at, stale}] (Assignments, Schedule, Games),
--    check: [{id, title, subject, first_day, last_day, due_date, past}] (the first-import check: an Assignments
--           link not checked yet; up to 5 of its items still on the school site: the ones to come, earliest
--           first, then, to fill it, the latest past ones; in date order; past: due before today. Else []),
--    new: [{id, title, subject, due_date}] (what is new for him, as on his screen, at most 50),
--    hidden: [{id, title, subject, due_date}] (what he hid, still to come),
--    moved: [{assignment_id, title, from, to}] (a planned assignment whose school date moved),
--    gone: [{assignment_id, title, due_date}] (an open assignment no longer on the school site)}
-- stale: a link the job would read (not paused, the kid's homework on) due for over 2 hours and not read
-- (about 3 hours since the last read): the job isn't running ("run supabase/cron.sql again"). A removed
-- link (kept only for the assignments made from it) isn't on the card, nor its items in check, new or
-- hidden. Never the address. Everything but check is 0006's, word for word.
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
    -- 0008: the ones to come first (due today or later, earliest first: the distance from today), then the
    -- past ones (latest first: the same distance); the first 5, in date order.
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
                                      order by x.due_date, x.title, x.id), '[]')
            from (select i.* from public.school_items i
                  join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.checked
                                              and f.removed_at is null
                  where i.made_at is null and not i.hidden and i.gone_at is null and i.due_date between v_today and v_today + 30
                  order by i.due_date, i.title, i.id limit 50) x),
    'hidden', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'subject', i.subject, 'due_date', i.due_date)
                                         order by i.due_date, i.title, i.id), '[]')
               from public.school_items i
               join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid and f.kind = 'assignments' and f.removed_at is null
               where i.made_at is null and i.hidden and i.gone_at is null and i.due_date >= v_today),
    'moved', (select coalesce(jsonb_agg(jsonb_build_object('assignment_id', a.id, 'title', a.title, 'from', a.due_date, 'to', i.due_date)
                                        order by a.due_date, a.title, a.id), '[]')
              from public.school_items i
              join public.school_feeds f on f.id = i.feed_id and f.kid_id = p_kid
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
-- Add link, Replace and Remove (§12 item 2), replaced: a removed link added again starts as not read
-- ---------------------------------------------------------------------
-- Add link, Replace (p_url an address) and Remove (p_url null or ''). p_kind 'assignments',
-- 'schedule' or 'games'. The address must pass private.school_url (22023 otherwise, the same words for
-- every way it can fail); it is kept in private.school_feed_urls and never answered. A new or replaced
-- link is due to be read at once (the next run, or Check now); Replace keeps the link's row, its
-- first-import answer, its items and its last read. Remove deletes the link's address and every item no
-- one made an assignment (assignments made from it stay, added_by 'school'). While items made assignments
-- remain, the row stays for them, marked removed (removed_at: not read, not on the status card, its
-- first-import answer taken back), so adding the link again takes the same row: the next read finds those
-- items by their keys instead of bringing them back as new; with none, the row goes too. 0008: added
-- again, that row starts as a new link, not read yet (no last_try_at, last_ok_at, last_count or
-- last_repeats), so nothing describes the old link's last read as the new one's. (The moved-item step of
-- the first read after that looks only at what the new link's last good read saw: there is none yet.)
-- Answers {id, kind, host, url_end}, or null for Remove. Everything but the four cleared columns is
-- 0006's, word for word.
create or replace function public.set_school_feed(p_kid uuid, p_kind text, p_url text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_f   public.school_feeds;
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('assignments', 'schedule', 'games') then
    raise exception 'Choose assignments, schedule or games.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.homework_kids k where k.kid_id = p_kid) then
    raise exception 'Turn on homework for this kid first.' using errcode = '22023';
  end if;
  if nullif(btrim(p_url), '') is null then
    select * into v_f from public.school_feeds f where f.kid_id = p_kid and f.kind = p_kind for update;
    if v_f.id is not null then
      delete from private.school_feed_urls u where u.feed_id = v_f.id;
      delete from public.school_items i where i.feed_id = v_f.id and i.made_at is null;
      if exists (select 1 from public.school_items i where i.feed_id = v_f.id) then
        update public.school_feeds f
        set removed_at = coalesce(f.removed_at, private.now()), checked = false, paused = false, next_at = null, fails = 0, last_stop = null
        where f.id = v_f.id;
      else
        delete from public.school_feeds f where f.id = v_f.id;
      end if;
    end if;
    return null;
  end if;
  v_url := private.school_url(p_url);
  if v_url is null then
    raise exception 'That isn''t a school calendar link. Copy it from the calendar''s feed button: it starts with webcal:// or https:// and has /podium/feed/iCal.aspx?z= in it.'
      using errcode = '22023';
  end if;
  insert into public.school_feeds as f (kid_id, kind, host, url_end, next_at)
  values (p_kid, p_kind, split_part(substr(v_url, 9), '/', 1), right(v_url, 4), private.now())
  on conflict (kid_id, kind) do update
  set host = excluded.host, url_end = excluded.url_end, next_at = excluded.next_at, fails = 0, last_stop = null, removed_at = null,
      -- 0008: a removed link added again starts as not read (f is the row as it was); Replace keeps its last read.
      last_try_at = case when f.removed_at is null then f.last_try_at end,
      last_ok_at = case when f.removed_at is null then f.last_ok_at end,
      last_count = case when f.removed_at is null then f.last_count end,
      last_repeats = case when f.removed_at is null then f.last_repeats end
  returning * into v_f;
  insert into private.school_feed_urls as u (feed_id, url) values (v_f.id, v_url)
  on conflict (feed_id) do update set url = excluded.url;
  return jsonb_build_object('id', v_f.id, 'kind', v_f.kind, 'host', v_f.host, 'url_end', v_f.url_end);
end;
$$;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- Nothing on the pages waits for 8: the check reads the same on 7. (create or replace keeps the function's grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 8;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- The replaced functions, as 0006 grants them: members call the status card signed in (Sam reads it too), parents
-- Add link (each function refuses anyone else); nobody else. hub_schema_version keeps its grants.
-- ---------------------------------------------------------------------
revoke execute on function public.school_feed_status(uuid)                        from public, anon, service_role;
revoke execute on function public.set_school_feed(uuid, text, text)               from public, anon, service_role;
grant  execute on function public.school_feed_status(uuid)                        to authenticated;
grant  execute on function public.set_school_feed(uuid, text, text)               to authenticated;

commit;
