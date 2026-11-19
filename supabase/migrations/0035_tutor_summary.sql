-- =====================================================================
-- HOME HUB v2 — migration 0035: the Sunday summary (the week's numbers, emailed to a tutor)
-- Apply once, after 0034, and only once the site and hub-jobs that understand it are live (docs/v1.3-homework.md §35.4).
-- cron.sql doesn't change: the morning email's run (every 15 minutes) sends it.
-- The contract is docs/v1.3-homework.md §35; the database side is docs/v2-design.md §41.
--
-- Why
--   The tutor asked for a weekly summary of how the kid started and finished his tasks, sent to him. The numbers are
--   on his tutor link (0034's coach view), but only when he opens it. Every Sunday from 17:00 (the household's time)
--   the hub emails each tutor link that has an address and its coach view on: this week's numbers and last week's,
--   in the link's language.
--
-- What it adds
--   • tutor_links.summary_to (an email address; null: off). Only the parents set it (set_tutor_summary); the table's
--     select grant (the parents, by its policy) covers the new column; there is no update grant on tutor_links.
--   • public.tutor_summary_log: one row per link and week (week: its Monday), claimed before the send and finished
--     after it (status sending, sent, failed or skipped; at most 3 tries). RLS on; the parents read it (the Homework
--     page's "Last sent"); only service_role writes it.
--   • public.set_tutor_summary(p_link uuid, p_to text): a parent sets or clears the address.
--   • public.summary_due(p_limit int), public.summary_claim(p_link uuid, p_week date),
--     public.summary_finish(p_id uuid, p_status text, p_detail text), public.tutor_summary(p_link uuid): for
--     service_role only (hub-jobs: the run, and a parent's Preview through it).
--   • hub_schema_version() (35). The Homework page shows the address only on 35; hub-jobs sends only on 35.
--
-- Rules
--   • One transaction. It refuses to run without 0034, twice, on a database set back to 34 (the column already
--     there), or on one that isn't as 0034 left it.
--   • Additive: a column that leaves it off, an empty table, new functions. Nothing that exists changes what it
--     answers.
--   • The email holds the kid's first name, the tutor's label and the two weeks' numbers (counts and minutes), as
--     the tutor link shows them. Never the tutor link itself (a mistyped address must not open his page), a task's
--     title, who nudged, a note, points' lines or anything else of the family.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: with no address set nothing is sent, and every page is as on 34). If wanted, in one go:
--   drop function public.tutor_summary(uuid);
--   drop function public.summary_finish(uuid, text, text);
--   drop function public.summary_claim(uuid, date);
--   drop function public.summary_due(int);
--   drop function public.set_tutor_summary(uuid, text);
--   drop table public.tutor_summary_log;
--   alter table public.tutor_links drop column summary_to;
--   then 0034's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0034 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 34 then
    raise exception 'Nudge and Start (migration 0034) aren''t installed (hub_schema_version() is %). Run 0034_task_starts.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 35 then
    raise exception 'The Sunday summary (migration 0035) is already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.tutor_links'::regclass and a.attname = 'summary_to' and not a.attisdropped) then
    raise exception 'The Sunday summary (migration 0035) is already installed, but hub_schema_version() was set back to 34. To switch it on again, make hub_schema_version() return 35 (docs/v1.3-homework.md §35). Nothing was changed.';
  end if;
  -- What this migration reads and calls is as 0034 left it.
  if to_regprocedure('private.task_week(uuid, date)') is null
     or to_regprocedure('private.is_admin()') is null
     or to_regprocedure('private.short_name(public.people)') is null
     or to_regprocedure('private.monday(date)') is null
     or to_regprocedure('private.now()') is null
     or to_regprocedure('private.tz()') is null
     or to_regprocedure('public.today_local()') is null
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.tutor_links'::regclass and a.attname = 'coach' and not a.attisdropped)
     or to_regclass('public.tutor_summary_log') is not null
     or to_regprocedure('public.summary_due(int)') is not null
     or to_regprocedure('public.set_tutor_summary(uuid, text)') is not null then
    raise exception 'This database isn''t as migration 0034 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The address (§35.2)
-- ---------------------------------------------------------------------
alter table public.tutor_links
  add column summary_to text check (summary_to is null or (char_length(summary_to) between 6 and 254
                                                            and summary_to ~ '^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$'));

-- A parent sets the address (trimmed, lower case) or clears it (null or blank). Unknown link: 22023 "That link is
-- gone."; an address that doesn't look like one: 22023 "That doesn't look like an email address.".
create function public.set_tutor_summary(p_link uuid, p_to text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text := nullif(lower(btrim(coalesce(p_to, ''))), '');
begin
  if not private.is_admin() then
    raise exception 'Only a parent can change homework.' using errcode = '42501';
  end if;
  if v is not null and (char_length(v) not between 6 and 254 or v !~ '^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$') then
    raise exception 'That doesn''t look like an email address.' using errcode = '22023';
  end if;
  update public.tutor_links l set summary_to = v where l.id = p_link;
  if not found then
    raise exception 'That link is gone.' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The send log (§35.3)
-- ---------------------------------------------------------------------
create table public.tutor_summary_log (
  id         uuid primary key default gen_random_uuid(),
  link_id    uuid not null references public.tutor_links (id) on delete cascade,
  week       date not null,                  -- the Monday of the week it covers
  status     text not null check (status in ('sending', 'sent', 'failed', 'skipped')),
  attempts   int not null default 1,
  claimed_at timestamptz not null default now(),
  detail     text,
  unique (link_id, week)
);
alter table public.tutor_summary_log enable row level security;
create policy "Parents see the Sunday summaries" on public.tutor_summary_log
  for select to authenticated using (private.is_admin());
revoke all on public.tutor_summary_log from public, anon, authenticated;
grant select on public.tutor_summary_log to authenticated;
grant select, insert, update on public.tutor_summary_log to service_role;

-- Which links should get this week's summary now: on a Sunday from 17:00, each link that is on, not ended, has its
-- coach view on and an address, whose kid has homework on, and that has no summary for this week sent, skipped, in
-- flight (less than 10 minutes) or out of tries.
create function public.summary_due(p_limit int default 20)
returns table (link_id uuid, week date)
language sql
stable
security invoker
set search_path = ''
as $$
  with c as (select private.now() as now, public.today_local() as today, private.tz() as tz)
  -- Only on a Sunday, so the week's Monday is six days back.
  select l.id, c.today - 6
  from c
  join public.tutor_links l on true
  join public.homework_kids k on k.kid_id = l.kid_id
  join public.people p on p.id = l.kid_id
  where extract(isodow from c.today) = 7
    and (c.today + time '17:00') at time zone c.tz <= c.now
    and l.active and l.expires_on >= c.today and l.coach and l.summary_to is not null
    and k.active and p.active
    and not exists (select 1 from public.tutor_summary_log s
                    where s.link_id = l.id and s.week = c.today - 6
                      and not (s.attempts < 3
                               and (s.status = 'failed'
                                    or (s.status = 'sending' and s.claimed_at < c.now - interval '10 minutes'))))
  order by l.created_at, l.id
  limit greatest(coalesce(p_limit, 20), 0);
$$;

-- Claims one link's week (as claim_notification): a new row, or a failed or stale one again while it has tries
-- left. Null: someone else has it, it went, or it's out of tries.
create function public.summary_claim(p_link uuid, p_week date)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  insert into public.tutor_summary_log as s (link_id, week, status, attempts, claimed_at)
  values (p_link, p_week, 'sending', 1, private.now())
  on conflict (link_id, week) do update
    set status = 'sending', attempts = s.attempts + 1, claimed_at = private.now(), detail = null
    where s.attempts < 3
      and (s.status = 'failed' or (s.status = 'sending' and s.claimed_at < private.now() - interval '10 minutes'))
  returning s.id;
$$;

create function public.summary_finish(p_id uuid, p_status text, p_detail text default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'summary_finish: status must be sent, failed or skipped.' using errcode = '22023';
  end if;
  update public.tutor_summary_log
  set status = p_status, detail = left(p_detail, 500)
  where id = p_id and status = 'sending';
end;
$$;

-- ---------------------------------------------------------------------
-- What the email says (§35.3)
-- ---------------------------------------------------------------------
-- One link's summary: {to, language, label, kid (his first name), week: {this, last}} (private.task_week, this
-- household week and the one before). Null for a link that is gone, off, ended, without its coach view or an
-- address, or whose kid has homework off: the run skips it.
create function public.tutor_summary(p_link uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l     public.tutor_links;
  kid   public.people;
  today date := public.today_local();
begin
  select * into l from public.tutor_links x where x.id = p_link;
  if l.id is null or not l.active or l.expires_on < today or not l.coach or l.summary_to is null then
    return null;
  end if;
  select p.* into kid from public.people p join public.homework_kids k on k.kid_id = p.id
  where p.id = l.kid_id and p.active and k.active;
  if kid.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'to', l.summary_to,
    'language', l.language,
    'label', l.label,
    'kid', private.short_name(kid),
    'week', jsonb_build_object('this', private.task_week(kid.id, today),
                               'last', private.task_week(kid.id, today - 7)));
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
-- New functions start out executable by PUBLIC.
revoke execute on function public.set_tutor_summary(uuid, text)         from public, anon, service_role;
grant  execute on function public.set_tutor_summary(uuid, text)         to authenticated;
revoke execute on function public.summary_due(int)                      from public, anon, authenticated;
revoke execute on function public.summary_claim(uuid, date)             from public, anon, authenticated;
revoke execute on function public.summary_finish(uuid, text, text)      from public, anon, authenticated;
revoke execute on function public.tutor_summary(uuid)                   from public, anon, authenticated;
grant  execute on function public.summary_due(int)                      to service_role;
grant  execute on function public.summary_claim(uuid, date)             to service_role;
grant  execute on function public.summary_finish(uuid, text, text)      to service_role;
grant  execute on function public.tutor_summary(uuid)                   to service_role;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The Homework page shows the address, and hub-jobs sends, only on 35. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 35;
$$;

commit;
