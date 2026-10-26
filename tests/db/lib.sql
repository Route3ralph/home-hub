-- Test helpers, loaded into the test database only (schema "test", never shipped).
-- Each check raises a notice "PASS  name" or "FAIL  name  (detail)"; run.sh prints those lines.
-- The helpers run with the caller's rights, so a check made after ":as_anon" runs as anon,
-- except the lookups (test.person() etc.), which find ids whoever is asking.
create schema test;
grant usage on schema test to public;

-- Pass when got equals want (null equals null).
create function test.is(got anycompatible, want anycompatible, name text)
returns void
language plpgsql
as $$
begin
  if got is not distinct from want then
    raise notice 'PASS  %', name;
  else
    raise notice 'FAIL  %  (got %, want %)', name, coalesce(got::text, 'null'), coalesce(want::text, 'null');
  end if;
end;
$$;

create function test.ok(cond boolean, name text)
returns void
language plpgsql
as $$
begin
  perform test.is(cond, true, name);
end;
$$;

-- Runs p_sql and undoes it. Returns 'rows:N' (rows returned or changed),
-- 'denied' (permission denied or row-level security), or 'error: message'.
create function test.try(p_sql text)
returns text
language plpgsql
as $$
declare
  n bigint;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
    raise exception using errcode = 'TT001', message = 'rows:' || n;   -- rolls the statement back
  exception
    when sqlstate 'TT001' then return sqlerrm;
    when insufficient_privilege then return 'denied';
    when others then return 'error: ' || sqlerrm;
  end;
end;
$$;

-- Pass when p_sql fails with a message containing p_want.
create function test.throws(p_sql text, p_want text, name text)
returns void
language plpgsql
as $$
declare
  err text;
begin
  begin
    execute p_sql;
    raise exception using errcode = 'TT001';   -- no error: roll it back and say so
  exception
    when sqlstate 'TT001' then err := null;
    when others then err := sqlerrm;
  end;
  if err is null then
    raise notice 'FAIL  %  (no error; wanted "%")', name, p_want;
  elsif position(p_want in err) > 0 then
    raise notice 'PASS  %', name;
  else
    raise notice 'FAIL  %  (got "%", wanted "%")', name, err, p_want;
  end if;
end;
$$;

-- What one role can do to one table: four checks (select, insert, update, delete).
-- Each want is 'rows:N', 'denied' or 'error: …' (see test.try). The statements are in test.samples.
create table test.samples (tbl text primary key, ins text not null, upd text not null);
grant select on test.samples to public;

create function test.matrix(who text, tbl text, want_select text, want_insert text, want_update text, want_delete text)
returns void
language plpgsql
as $$
declare
  s test.samples;
begin
  select * into s from test.samples where samples.tbl = matrix.tbl;
  perform test.is(test.try(format('select * from public.%I', tbl)), want_select, format('%s select %s', who, tbl));
  perform test.is(test.try(s.ins), want_insert, format('%s insert %s', who, tbl));
  perform test.is(test.try(s.upd), want_update, format('%s update %s', who, tbl));
  perform test.is(test.try(format('delete from public.%I', tbl)), want_delete, format('%s delete %s', who, tbl));
end;
$$;

-- Whether a function call runs for the current role: 'ok', 'denied' or 'error: …'.
create function test.can(p_sql text)
returns text
language plpgsql
as $$
declare
  got text := test.try(p_sql);
begin
  return case when got like 'rows:%' then 'ok' else got end;
end;
$$;

-- Ids by name, whoever is asking.
create function test.person(p_name text) returns uuid language sql stable security definer set search_path = '' as
  $$ select id from public.people where name = p_name $$;
create function test.token(p_name text) returns text language sql stable security definer set search_path = '' as
  $$ select day_token from public.people where name = p_name $$;
-- The confirmation secret in a person's confirmation email (null when they have none).
create function test.confirm_token(p_name text) returns text language sql stable security definer set search_path = '' as
  $$ select c.token from public.people_confirm c join public.people p on p.id = c.person_id where p.name = p_name $$;
create function test.task(p_title text) returns uuid language sql stable security definer set search_path = '' as
  $$ select id from public.tasks where title = p_title $$;
create function test.event(p_title text) returns uuid language sql stable security definer set search_path = '' as
  $$ select id from public.events where title = p_title $$;
create function test.contractor(p_name text) returns uuid language sql stable security definer set search_path = '' as
  $$ select id from public.contractors where name = p_name $$;
create function test.project(p_name text) returns uuid language sql stable security definer set search_path = '' as
  $$ select id from public.projects where name = p_name $$;
-- A task's latest task_log entry (of one status, if given): what an Undo button holds.
create function test.last_log(p_title text, p_status text default null) returns uuid language sql stable security definer set search_path = '' as
  $$ select l.id from public.task_log l join public.tasks t on t.id = l.task_id
     where t.title = p_title and (p_status is null or l.status = p_status) order by l.seq desc limit 1 $$;
-- A task row as the database sees it (for private.series_after and friends).
create function test.task_row(p_title text) returns public.tasks language sql stable security definer set search_path = '' as
  $$ select t from public.tasks t where title = p_title $$;
