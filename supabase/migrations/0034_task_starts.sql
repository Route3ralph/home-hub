-- =====================================================================
-- HOME HUB v2 — migration 0034: Nudge, Start and the week's numbers (starting and finishing a kid's tasks on time)
-- Apply once, after 0033, and only once the site that understands it is live (docs/v1.3-homework.md §34.4).
-- No Edge Function and cron.sql don't change.
-- The contract is docs/v1.3-homework.md §34; the database side is docs/v2-design.md §40.
--
-- Why
--   The tutor asked to measure what a kid's goal is: starting and finishing his tasks on time without being reminded
--   again and again. The hub knew when a task was due and when it was ticked, but not when a parent had to remind him,
--   nor when he began.
--
-- What it adds
--   • public.task_nudges: one row each time a parent or the coach taps Nudge on a kid's task (Today page), with the
--     task, the date it is for, the kid, the time and who. RLS on; a parent or the coach reads them; only the
--     functions write. nudge_task(task, occurrence) adds one (60 a day), unnudge_task(id) takes back your own within
--     15 minutes (the toast's Undo).
--   • public.task_starts: when a kid with homework on taps Start on one of his tasks on his My day: the task, the
--     date it is for, him, the time. Once per task and date. RLS on; a parent or the coach reads them.
--     start_by_token(token, task, occurrence) writes it, and pays homework_kids.pts_start points (0 to 20, 5 by
--     default) when nobody nudged that task for that date first, at most 3 a day, while his points are on
--     (points_ledger kind 'start').
--   • His My day (public.get_person_day, 0022's moved to private.get_person_day_v33, unchanged): each open task of his
--     own carries `can_start: true`, or `started` ('HH:MM', the household's time) once he started it. Only for a kid
--     with homework on; every other answer is as before.
--   • private.task_week(kid, monday) and public.task_week(kid, from) (a parent or the coach): the household week's
--     numbers (assigned, done, done on time, reminders, started, started with no reminder, average minutes from the
--     task's time to Start, average minutes from Start to done, points earned).
--   • The coach view (private.coach_view, 0033's moved to coach_view_v33, unchanged) gains `week`: this week's
--     numbers and last week's, for the tutor link.
--   • hub_schema_version() (34).
--
-- Rules
--   • One transaction. It refuses to run without 0033, twice, on a database set back to 33 (the table already there),
--     or on one that isn't as 0033 left it.
--   • Additive: two empty tables, a column, functions. Nothing changes for anyone until someone taps Nudge or Start.
--   • A nudge is never shown on the kid's My day. The tutor link shows counts only.
--   • set search_path = '' on every function; revoke then grant.
--
-- Undo (not needed: with nothing tapped, every page is as on 33). If wanted, in one go:
--   drop function private.coach_view(uuid);
--   alter function private.coach_view_v33(uuid) rename to coach_view;
--   drop function public.get_person_day(text);
--   alter function private.get_person_day_v33(text) set schema public;
--   alter function public.get_person_day_v33(text) rename to get_person_day;
--   grant execute on function public.get_person_day(text) to anon, authenticated;
--   drop function public.task_week(uuid, date);
--   drop function private.task_week(uuid, date);
--   drop function public.start_by_token(text, uuid, date);
--   drop function public.unnudge_task(uuid);
--   drop function public.nudge_task(uuid, date);
--   delete from public.points_ledger where kind = 'start';
--   alter table public.points_ledger drop constraint points_ledger_kind_check;
--   alter table public.points_ledger add constraint points_ledger_kind_check check (kind in ('focus', 'on_time', 'milestone_done', 'milestone', 'given', 'void', 'trade', 'routine', 'taken'));
--   alter table public.homework_kids drop column pts_start;
--   drop table public.task_starts;
--   drop table public.task_nudges;
--   then 0033's hub_schema_version ("create or replace function public.hub_schema_version()", to its "$$;").
-- =====================================================================
begin;

do $$
begin
  if to_regprocedure('public.hub_schema_version()') is null then
    raise exception 'Home Hub v2 (migration 0002) isn''t installed. Run 0002 to 0033 first. Nothing was changed.';
  end if;
  if public.hub_schema_version() < 33 then
    raise exception 'Take points on the tutor link (migration 0033) isn''t installed (hub_schema_version() is %). Run 0033_tutor_take.sql first. Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if public.hub_schema_version() >= 34 then
    raise exception 'Nudge and Start (migration 0034) are already installed (hub_schema_version() is %). Nothing was changed.',
                    public.hub_schema_version();
  end if;
  if to_regclass('public.task_starts') is not null then
    raise exception 'Nudge and Start (migration 0034) are already installed, but hub_schema_version() was set back to 33. To switch them on again, make hub_schema_version() return 34 (docs/v1.3-homework.md §34). Nothing was changed.';
  end if;
  -- What this migration reads, calls and replaces is as 0033 left it.
  if to_regprocedure('public.get_person_day(text)') is null
     or to_regprocedure('private.coach_view(uuid)') is null
     or to_regprocedure('private.coach_view_v32(uuid)') is null
     or to_regprocedure('private.homework_kid_by_token(text)') is null
     or to_regprocedure('private.is_coach()') is null
     or to_regprocedure('private.count_homework(uuid, text, integer)') is null
     or to_regprocedure('private.short_name(public.people)') is null
     or to_regprocedure('private.monday(date)') is null
     or to_regprocedure('private.tz()') is null
     or to_regprocedure('public.coach_reward_by_token(text, text, uuid, jsonb)') is null
     or to_regprocedure('private.get_person_day_v33(text)') is not null
     or to_regprocedure('private.coach_view_v33(uuid)') is not null
     or to_regclass('public.task_nudges') is not null
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.homework_kids'::regclass and a.attname = 'pts_start' and not a.attisdropped)
     or (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.points_ledger'::regclass and c.conname = 'points_ledger_kind_check')
        is distinct from 'CHECK ((kind = ANY (ARRAY[''focus''::text, ''on_time''::text, ''milestone_done''::text, ''milestone''::text, ''given''::text, ''void''::text, ''trade''::text, ''routine''::text, ''taken''::text])))' then
    raise exception 'This database isn''t as migration 0033 left it. Nothing was changed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables (§34.1)
-- ---------------------------------------------------------------------
-- A parent's or the coach's reminder to a kid about one task, for one date (the date the task was due).
create table public.task_nudges (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks (id) on delete cascade,
  occurrence  date not null,
  person_id   uuid not null references public.people (id) on delete cascade,   -- the kid in charge of the task then
  at          timestamptz not null default private.now(),
  who         text not null                                                      -- the email of whoever tapped Nudge
);
create index task_nudges_task on public.task_nudges (task_id, occurrence);
create index task_nudges_person on public.task_nudges (person_id, at desc);
alter table public.task_nudges enable row level security;
create policy "Parents and the coach see nudges" on public.task_nudges
  for select to authenticated using (private.is_coach());
revoke all on public.task_nudges from public, anon, authenticated;
grant select on public.task_nudges to authenticated;

-- When the kid began a task (his Start on his My day), once per task and date.
create table public.task_starts (
  task_id     uuid not null references public.tasks (id) on delete cascade,
  occurrence  date not null,
  person_id   uuid not null references public.people (id) on delete cascade,
  started_at  timestamptz not null default private.now(),
  primary key (task_id, occurrence)
);
create index task_starts_person on public.task_starts (person_id, started_at desc);
alter table public.task_starts enable row level security;
create policy "Parents and the coach see starts" on public.task_starts
  for select to authenticated using (private.is_coach());
revoke all on public.task_starts from public, anon, authenticated;
grant select on public.task_starts to authenticated;

-- The points for starting with no reminder (0 pays nothing), changed by the parents as his other homework settings.
alter table public.homework_kids add column pts_start int not null default 5 check (pts_start between 0 and 20);
grant update (pts_start) on public.homework_kids to authenticated;

alter table public.points_ledger drop constraint points_ledger_kind_check;
alter table public.points_ledger add constraint points_ledger_kind_check
  check (kind in ('focus', 'on_time', 'milestone_done', 'milestone', 'given', 'void', 'trade', 'routine', 'taken', 'start'));

-- ---------------------------------------------------------------------
-- Nudge (§34.2): a parent or the coach, on the Today page
-- ---------------------------------------------------------------------
create function public.nudge_task(p_task uuid, p_occurrence date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t     public.tasks;
  v_kid public.people;
  v_id  uuid;
  v_n   int;
begin
  if not private.is_coach() then
    raise exception 'Only a parent can nudge.' using errcode = '42501';
  end if;
  if p_task is null or p_occurrence is null then
    raise exception 'That needs the task and its date.' using errcode = '22023';
  end if;
  select * into t from public.tasks x where x.id = p_task;
  if t.id is null then
    raise exception 'That task is gone.' using errcode = '22023';
  end if;
  select * into v_kid from public.people p where p.id = t.responsible_id;
  if v_kid.id is null or v_kid.role <> 'kid' or not v_kid.active then
    raise exception 'Only a kid''s task can be nudged.' using errcode = '22023';
  end if;
  if p_occurrence > public.today_local() or p_occurrence < public.today_local() - 30 then
    raise exception 'Only a task due today or in the last 30 days can be nudged.' using errcode = '22023';
  end if;
  select count(*) into v_n from public.task_nudges n where n.who = public.current_email() and n.at > private.now() - interval '1 day';
  if v_n >= 60 then
    raise exception 'That''s a lot for one day.' using errcode = 'P0001';
  end if;
  insert into public.task_nudges (task_id, occurrence, person_id, who)
  values (t.id, p_occurrence, v_kid.id, public.current_email())
  returning id into v_id;
  return jsonb_build_object('id', v_id,
                            'count', (select count(*) from public.task_nudges n where n.task_id = t.id and n.occurrence = p_occurrence));
end;
$$;

-- The toast's Undo: your own nudge, within 15 minutes.
create function public.unnudge_task(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_coach() then
    raise exception 'Only a parent can nudge.' using errcode = '42501';
  end if;
  delete from public.task_nudges n
  where n.id = p_id and n.who = public.current_email() and n.at > private.now() - interval '15 minutes';
  return found;
end;
$$;

-- ---------------------------------------------------------------------
-- Start (§34.3): the kid, on his My day
-- ---------------------------------------------------------------------
-- A kid with homework on starts one of his open tasks for its date (the date his screen showed: a repeating task's
-- current due date). Once per task and date; a second Start changes nothing. With no nudge for that task and date
-- before it, and his points on, it pays pts_start, at most 3 times a day.
create function public.start_by_token(p_token text, p_task_id uuid, p_occurrence date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me      public.people;
  t       public.tasks;
  v_k     public.homework_kids;
  v_today date := public.today_local();
  v_n     int;
  v_paid  int := 0;
begin
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return null;
  end if;
  if p_task_id is null or p_occurrence is null then
    raise exception 'That needs the task and its date.' using errcode = '22023';
  end if;
  select * into t from public.tasks x where x.id = p_task_id;
  if t.id is null or t.responsible_id is distinct from me.id then
    raise exception 'That isn''t on your day.' using errcode = '42501';
  end if;
  if not t.active or t.done_at is not null or t.due_date is distinct from p_occurrence or p_occurrence > v_today then
    raise exception 'That isn''t on your day any more.' using errcode = '22023';
  end if;
  insert into public.task_starts (task_id, occurrence, person_id) values (t.id, p_occurrence, me.id)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform private.count_homework(me.id, 'writes', 150);
    select * into v_k from public.homework_kids k where k.kid_id = me.id for update;
    if v_k.points_on and v_k.pts_start > 0
       and not exists (select 1 from public.task_nudges n where n.task_id = t.id and n.occurrence = p_occurrence)
       and (select count(*) from public.points_ledger l where l.kid_id = me.id and l.kind = 'start' and l.day = v_today) < 3 then
      insert into public.points_ledger (kid_id, at, day, kind, delta, note, who)
      values (me.id, private.now(), v_today, 'start', v_k.pts_start, left(t.title, 120), private.short_name(me) || ' (My day)');
      v_paid := v_k.pts_start;
    end if;
  end if;
  return public.get_person_day(p_token) || jsonb_build_object('paid', v_paid);
end;
$$;

-- ---------------------------------------------------------------------
-- His My day (§34.3): 0022's answer, with can_start or started on his own open tasks
-- ---------------------------------------------------------------------
alter function public.get_person_day(text) rename to get_person_day_v33;
alter function public.get_person_day_v33(text) set schema private;

create function public.get_person_day(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d    jsonb := private.get_person_day_v33(p_token);
  me   public.people;
  mark jsonb;
begin
  if d is null then
    return null;
  end if;
  me := private.homework_kid_by_token(p_token);
  if me.id is null then
    return d;
  end if;
  -- One entry per open task of his: started (the household's time) or can_start.
  select jsonb_object_agg(t.id::text || '|' || t.due_date::text,
                          case when s.started_at is not null
                               then jsonb_build_object('started', to_char(s.started_at at time zone private.tz(), 'HH24:MI'))
                               else jsonb_build_object('can_start', true) end)
    into mark
  from public.tasks t
  left join public.task_starts s on s.task_id = t.id and s.occurrence = t.due_date
  where t.responsible_id = me.id and t.active and t.done_at is null and t.due_date is not null
    and t.due_date <= public.today_local();
  if mark is null then
    return d;
  end if;
  if jsonb_typeof(d -> 'days') = 'array' then
    d := jsonb_set(d, '{days}', (
      select coalesce(jsonb_agg(
               case when jsonb_typeof(dy -> 'items') = 'array'
                    then jsonb_set(dy, '{items}', (
                           select coalesce(jsonb_agg(case when it ->> 'kind' = 'task' and mark ? ((it ->> 'item_id') || '|' || (it ->> 'occurrence'))
                                                          then it || (mark -> ((it ->> 'item_id') || '|' || (it ->> 'occurrence'))) else it end
                                                     order by n), '[]')
                           from jsonb_array_elements(dy -> 'items') with ordinality i (it, n)))
                    else dy end order by dn), '[]')
      from jsonb_array_elements(d -> 'days') with ordinality x (dy, dn)));
  end if;
  if jsonb_typeof(d -> 'late') = 'array' then
    d := jsonb_set(d, '{late}', (
      select coalesce(jsonb_agg(case when it ->> 'kind' = 'task' and mark ? ((it ->> 'item_id') || '|' || (it ->> 'occurrence'))
                                     then it || (mark -> ((it ->> 'item_id') || '|' || (it ->> 'occurrence'))) else it end
                                order by n), '[]')
      from jsonb_array_elements(d -> 'late') with ordinality i (it, n)));
  end if;
  return d;
end;
$$;

-- ---------------------------------------------------------------------
-- The week's numbers (§34.5)
-- ---------------------------------------------------------------------
-- One household week (Monday p_from to Sunday, never past today) of a kid's tasks:
--   assigned: each date a task of his was due (done, missed, or still open and due by today; a skip isn't counted);
--   done, and on_time (ticked by the task's time that day, or by the day's end for a task with no time);
--   reminders (nudges for those dates), started, started_unprompted (no nudge for that task and date before Start);
--   avg_minutes_to_start (from the task's time to Start, 0 when he started before it; tasks with a time only);
--   avg_minutes_to_finish (from Start to the tick, within a day); points (everything he earned or was given that
--   week: the positive ledger lines).
create function private.task_week(p_kid uuid, p_from date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with r as (select private.monday(p_from) as d0, least(private.monday(p_from) + 6, public.today_local()) as d1),
  mine as (select t.* from public.tasks t where t.responsible_id = p_kid),
  occ as (
    select l.task_id, l.occurrence, l.status, l.created_at as done_at
    from public.task_log l join mine t on t.id = l.task_id, r
    where l.status in ('done', 'missed') and l.occurrence between r.d0 and r.d1
    union all
    select t.id, t.due_date, 'open', null::timestamptz
    from mine t, r
    where t.active and t.done_at is null and t.due_date between r.d0 and r.d1
  ),
  due as (
    select o.*, ((o.occurrence + coalesce(t.due_time, time '23:59:59')) at time zone private.tz()) as due_at, t.due_time
    from occ o join mine t on t.id = o.task_id
  ),
  st as (
    select s.task_id, s.occurrence, s.started_at, t.due_time,
           ((s.occurrence + t.due_time) at time zone private.tz()) as time_at,
           (select min(l.created_at) from public.task_log l
            where l.task_id = s.task_id and l.status = 'done' and l.created_at >= s.started_at
              and l.created_at < s.started_at + interval '1 day') as done_at,
           not exists (select 1 from public.task_nudges n
                       where n.task_id = s.task_id and n.occurrence = s.occurrence and n.at <= s.started_at) as unprompted
    from public.task_starts s join mine t on t.id = s.task_id, r
    where s.occurrence between r.d0 and r.d1
  )
  select jsonb_build_object(
    'from', (select d0 from r), 'to', (select d0 + 6 from r),
    'assigned', (select count(*) from due),
    'done', (select count(*) from due where status = 'done'),
    'on_time', (select count(*) from due where status = 'done' and done_at <= due_at),
    'reminders', (select count(*) from public.task_nudges n, r where n.person_id = p_kid and n.occurrence between r.d0 and r.d1),
    'started', (select count(*) from st),
    'started_unprompted', (select count(*) from st where unprompted),
    'avg_minutes_to_start', (select round(avg(greatest(extract(epoch from (started_at - time_at)) / 60, 0)))::int from st where due_time is not null),
    'avg_minutes_to_finish', (select round(avg(extract(epoch from (done_at - started_at)) / 60))::int from st where done_at is not null),
    'points', (select coalesce(sum(l.delta), 0) from public.points_ledger l, r where l.kid_id = p_kid and l.delta > 0 and l.day between r.d0 and r.d0 + 6));
$$;

-- For the Homework page: a parent or the coach, any kid's week (p_from: any day of it; this week when null).
create function public.task_week(p_kid uuid, p_from date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_coach() then
    raise exception 'Only a parent can see this.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.people p where p.id = p_kid and p.role = 'kid') then
    raise exception 'That isn''t a kid.' using errcode = '22023';
  end if;
  return private.task_week(p_kid, coalesce(p_from, public.today_local()));
end;
$$;

-- ---------------------------------------------------------------------
-- The coach view (§34.6): 0033's, with this week's and last week's numbers
-- ---------------------------------------------------------------------
alter function private.coach_view(uuid) rename to coach_view_v33;

create function private.coach_view(p_link uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v   jsonb := private.coach_view_v33(p_link);
  kid uuid;
begin
  if v is null then
    return v;
  end if;
  select x.kid_id into kid from public.tutor_links x where x.id = p_link;
  return v || jsonb_build_object('week', jsonb_build_object(
    'this', private.task_week(kid, public.today_local()),
    'last', private.task_week(kid, public.today_local() - 7)));
end;
$$;

-- ---------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------
revoke execute on function public.nudge_task(uuid, date)                from public, anon, service_role;
grant  execute on function public.nudge_task(uuid, date)                to authenticated;
revoke execute on function public.unnudge_task(uuid)                    from public, anon, service_role;
grant  execute on function public.unnudge_task(uuid)                    to authenticated;
revoke execute on function public.task_week(uuid, date)                 from public, anon, service_role;
grant  execute on function public.task_week(uuid, date)                 to authenticated;
revoke execute on function public.start_by_token(text, uuid, date)      from public, service_role;
grant  execute on function public.start_by_token(text, uuid, date)      to anon, authenticated;
revoke execute on function public.get_person_day(text)                  from public, service_role;
grant  execute on function public.get_person_day(text)                  to anon, authenticated;
revoke execute on function private.get_person_day_v33(text)             from public, anon, authenticated, service_role;
revoke execute on function private.task_week(uuid, date)                from public, anon, authenticated;
revoke execute on function private.coach_view(uuid)                     from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------
-- The pages show Nudge, Start and the week's numbers only on 34. (create or replace keeps the grants.)
create or replace function public.hub_schema_version()
returns int
language sql
immutable
set search_path = ''
as $$
  select 34;
$$;

commit;
