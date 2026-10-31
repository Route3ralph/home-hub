#!/usr/bin/env bash
# Database tests. Starts a throwaway Postgres, loads the Supabase stand-ins, supabase/schema.sql,
# a v1-era household (v1_data.sql) and supabase/migrations/*.sql in order, then runs each
# tests/db/*.test.sql against its own fresh copy of that database.
# Before that: preflight.sql's checks, each migration's refusal to run twice (or too early), that
# migration 0003 leaves the email, day_text and My day exactly as 0002 made them while no Google
# calendar is set up (same_output.sql), that migration 0004 leaves every event on the wall as
# 0003 made it while no meal is planned (step 5c), and that migration 0005 leaves the email,
# day_text and My day exactly as 0004 made them while homework is off for everyone (step 5d), and
# migration 0006 too, with school links and their items in that household (step 5d), and that with
# homework on and no school link 0006 leaves My day, his homework view and Pat's as 0005 made them (step 5e).
# Prints one "PASS  name" or "FAIL  name  (detail)" line per check, then the totals,
# and exits non-zero if anything failed.
# Needs the PostgreSQL 16 server binaries (PG_BIN overrides where they are); cluster.sh starts
# the throwaway server (as the postgres user when run as root, since initdb refuses root).
#
# A test file starts with "\ir roles.sql" (and "\ir fixtures.sql" for the shared v2 household),
# switches who it runs as with lines like ":as_admin" or ":as_anon", pins the clock with
# "set hub.now = '…'", and checks with test.is, test.ok, test.throws and test.matrix (lib.sql).
set -u
cd "$(dirname "$0")/../.."
# The throwaway server, and the sql / quiet helpers (shared with tests/contract/check.sh).
source tests/db/cluster.sh

pass=0
fail=0
report() { # "PASS  name" or "FAIL  name  (detail)"
  echo "$1"
  if [[ $1 == PASS* ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
}

# 1. The v1 database, as it is live today.
sql -d postgres -c 'create database hub_v1'
if ! quiet -d hub_v1 -f tests/db/standins.sql -f supabase/schema.sql -f tests/db/v1_data.sql >"$dir/load.log" 2>&1; then
  report "FAIL  load schema.sql  ($(tail -n 1 "$dir/load.log"))"
  exit 1
fi

# 2. preflight.sql passes on it (every row ok).
bad=$(quiet -d hub_v1 -A -t -F ' | ' -f supabase/preflight.sql 2>&1 | grep -v ' | t | ' || true)
if [[ -z $bad ]]; then report "PASS  preflight passes on the v1 database"
else report "FAIL  preflight passes on the v1 database  ($(echo "$bad" | tr '\n' ';'))"; fi

# 3. The migrations, in order.
sql -d postgres -c 'create database hub template hub_v1'
for m in supabase/migrations/*.sql; do
  if quiet -d hub -f "$m" >"$dir/load.log" 2>&1; then report "PASS  migration $(basename "$m") applies"
  else report "FAIL  migration $(basename "$m") applies  ($(tail -n 1 "$dir/load.log"))"; exit 1; fi
done

# 4. preflight.sql flags a database that already has v2; the migration refuses to run twice.
bad=$(quiet -d hub -A -t -F ' | ' -f supabase/preflight.sql 2>&1 | grep -c ' | f | ' || true)
if [[ $bad -gt 0 ]]; then report "PASS  preflight flags a database that already has v2"
else report "FAIL  preflight flags a database that already has v2  (every check passed)"; fi
sql -d postgres -c 'create database hub_again template hub'
out=$(quiet -d hub_again -f supabase/migrations/0002_home_hub_v2.sql 2>&1)
if [[ $out == *"already installed"* ]]; then report "PASS  migration 0002 refuses to run twice"
else report "FAIL  migration 0002 refuses to run twice  (${out:0:200})"; fi
out=$(quiet -d hub_again -f supabase/migrations/0003_google_calendar.sql 2>&1)
if [[ $out == *"already installed"* ]]; then report "PASS  migration 0003 refuses to run twice"
else report "FAIL  migration 0003 refuses to run twice  (${out:0:200})"; fi
sql -d postgres -c 'create database hub_v1_again template hub_v1'
out=$(quiet -d hub_v1_again -f supabase/migrations/0003_google_calendar.sql 2>&1)
if [[ $out == *"isn't installed"* ]] && [[ -z $(quiet -d hub_v1_again -A -t -c "select to_regclass('public.calendars')") ]]; then
  report "PASS  migration 0003 refuses to run on a v1 database (0002 isn't installed), and changes nothing"
else report "FAIL  migration 0003 refuses to run on a v1 database  (${out:0:200})"; fi
out=$(quiet -d hub_again -f supabase/migrations/0004_meals_and_shopping.sql 2>&1)
if [[ $out == *"already installed"* ]]; then report "PASS  migration 0004 refuses to run twice"
else report "FAIL  migration 0004 refuses to run twice  (${out:0:200})"; fi
out=$(quiet -d hub_v1_again -f supabase/migrations/0004_meals_and_shopping.sql 2>&1)
if [[ $out == *"isn't installed"* ]] && [[ -z $(quiet -d hub_v1_again -A -t -c "select to_regclass('public.meals')") ]]; then
  report "PASS  migration 0004 refuses to run on a v1 database (0002 isn't installed), and changes nothing"
else report "FAIL  migration 0004 refuses to run on a v1 database  (${out:0:200})"; fi
out=$(quiet -d hub_again -f supabase/migrations/0005_homework.sql 2>&1)
if [[ $out == *"already installed"* ]]; then report "PASS  migration 0005 refuses to run twice"
else report "FAIL  migration 0005 refuses to run twice  (${out:0:200})"; fi
out=$(quiet -d hub_v1_again -f supabase/migrations/0005_homework.sql 2>&1)
if [[ $out == *"isn't installed"* ]] && [[ -z $(quiet -d hub_v1_again -A -t -c "select to_regclass('public.homework_kids')") ]]; then
  report "PASS  migration 0005 refuses to run on a v1 database (0002 isn't installed), and changes nothing"
else report "FAIL  migration 0005 refuses to run on a v1 database  (${out:0:200})"; fi
# A database where the owner turned v1.2 off as docs/v1.2-kitchen.md §15 says (both switches
# off, hub_schema_version() set back to 3): running 0004 again says so, and changes nothing.
sql -d postgres -c 'create database hub_set_back template hub'
quiet -d hub_set_back >/dev/null <<'SQL'
update public.household set helper_list = 'off', meals_on_wall = false;
create or replace function public.hub_schema_version() returns int language sql immutable set search_path = '' as $$ select 3 $$;
SQL
out=$(quiet -d hub_set_back -f supabase/migrations/0004_meals_and_shopping.sql 2>&1)
got=$(quiet -d hub_set_back -A -t -c "select public.hub_schema_version() || ' ' || (select count(*) from pg_proc where proname in ('digest_for_v3', 'calendar_desired_v3'))")
if [[ $out == *"set back to 3"* && $got == "3 2" ]]; then
  report "PASS  migration 0004 on a database set back to 3: says so (\"set back to 3\"), and changes nothing"
else report "FAIL  migration 0004 on a database set back to 3  (${out:0:200}; version and _v3 functions: $got)"; fi
# The same for 0005: v1.3 turned off as docs/v1.3-homework.md §16.3 says (homework and the AI off,
# hub_schema_version() set back to 4). Running 0005 again says so, and changes nothing.
sql -d postgres -c 'create database hub_set_back_4 template hub'
quiet -d hub_set_back_4 >/dev/null <<'SQL'
update public.homework_kids set active = false;
update public.household set homework_ai = false;
create or replace function public.hub_schema_version() returns int language sql immutable set search_path = '' as $$ select 4 $$;
SQL
catalog() { quiet -d hub_set_back_4 -A -t -c "select count(*) || ' ' || md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc), ',' order by p.oid::regprocedure::text)) from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)"; }
before=$(catalog)
out=$(quiet -d hub_set_back_4 -f supabase/migrations/0005_homework.sql 2>&1)
got=$(quiet -d hub_set_back_4 -A -t -c "select public.hub_schema_version()")
if [[ $out == *"set back to 4"* && $got == "4" && $(catalog) == "$before" ]]; then
  report "PASS  migration 0005 on a database set back to 4: says so (\"set back to 4\"), and changes nothing"
else report "FAIL  migration 0005 on a database set back to 4  (${out:0:200}; version: $got)"; fi
# 0006 (the school feed) refuses to run twice, and on a v1 database.
out=$(quiet -d hub_again -f supabase/migrations/0006_homework_school.sql 2>&1)
if [[ $out == *"already installed"* ]]; then report "PASS  migration 0006 refuses to run twice"
else report "FAIL  migration 0006 refuses to run twice  (${out:0:200})"; fi
out=$(quiet -d hub_v1_again -f supabase/migrations/0006_homework_school.sql 2>&1)
if [[ $out == *"isn't installed"* ]] && [[ -z $(quiet -d hub_v1_again -A -t -c "select to_regclass('public.school_feeds')") ]]; then
  report "PASS  migration 0006 refuses to run on a v1 database (0002 isn't installed), and changes nothing"
else report "FAIL  migration 0006 refuses to run on a v1 database  (${out:0:200})"; fi
# A database where the owner set the school feed back as docs/v1.3-homework.md §16.5 says (hub_schema_version()
# set back to 5): running 0006 again says so, and changes nothing.
sql -d postgres -c 'create database hub_set_back_5 template hub'
quiet -d hub_set_back_5 >/dev/null <<'SQL'
create or replace function public.hub_schema_version() returns int language sql immutable set search_path = '' as $$ select 5 $$;
SQL
catalog_of() { quiet -d "$1" -A -t -c "select count(*) || ' ' || md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc), ',' order by p.oid::regprocedure::text)) from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)"; }
before=$(catalog_of hub_set_back_5)
out=$(quiet -d hub_set_back_5 -f supabase/migrations/0006_homework_school.sql 2>&1)
got=$(quiet -d hub_set_back_5 -A -t -c "select public.hub_schema_version()")
if [[ $out == *"set back to 5"* && $got == "5" && $(catalog_of hub_set_back_5) == "$before" ]]; then
  report "PASS  migration 0006 on a database set back to 5: says so (\"set back to 5\"), and changes nothing"
else report "FAIL  migration 0006 on a database set back to 5  (${out:0:200}; version: $got)"; fi

# The database with migration 0002 only, as it is live before 0003 (steps 5 and 5b).
sql -d postgres -c 'create database hub_02 template hub_v1'
if ! quiet -d hub_02 -f supabase/migrations/0002_home_hub_v2.sql >"$dir/load.log" 2>&1; then
  report "FAIL  migration 0002 applies to hub_02  ($(tail -n 1 "$dir/load.log"))"; exit 1
fi
# Migration 0004 refuses a database without 0003 ("Google Calendar (migration 0003) isn't installed").
sql -d postgres -c 'create database hub_02_again template hub_02'
out=$(quiet -d hub_02_again -f supabase/migrations/0004_meals_and_shopping.sql 2>&1)
if [[ $out == *"isn't installed"* ]] && [[ -z $(quiet -d hub_02_again -A -t -c "select to_regclass('public.meals')") ]]; then
  report "PASS  migration 0004 refuses to run without 0003, and changes nothing"
else report "FAIL  migration 0004 refuses to run without 0003  (${out:0:200})"; fi
# Migration 0005 refuses a database without 0004: one at 0002 and one at 0003 ("… (migration 0004) isn't installed").
out=$(quiet -d hub_02_again -f supabase/migrations/0005_homework.sql 2>&1)
if [[ $out == *"(migration 0004) isn't installed"* ]] && [[ -z $(quiet -d hub_02_again -A -t -c "select to_regclass('public.homework_kids')") ]]; then
  report "PASS  migration 0005 refuses to run on a database at 0002, and changes nothing"
else report "FAIL  migration 0005 refuses to run on a database at 0002  (${out:0:200})"; fi
sql -d postgres -c 'create database hub_03_again template hub_02'
quiet -d hub_03_again -f supabase/migrations/0003_google_calendar.sql >/dev/null 2>&1
out=$(quiet -d hub_03_again -f supabase/migrations/0005_homework.sql 2>&1)
if [[ $out == *"(migration 0004) isn't installed"* ]] && [[ -z $(quiet -d hub_03_again -A -t -c "select to_regclass('public.homework_kids')") ]] \
   && [[ $(quiet -d hub_03_again -A -t -c "select public.hub_schema_version()") == 3 ]]; then
  report "PASS  migration 0005 refuses to run without 0004 (a database at 0003), and changes nothing"
else report "FAIL  migration 0005 refuses to run without 0004  (${out:0:200})"; fi
# Migration 0006 refuses a database without 0005: one at 0003 and one at 0004 ("Homework (migration 0005) isn't installed").
out=$(quiet -d hub_03_again -f supabase/migrations/0006_homework_school.sql 2>&1)
if [[ $out == *"(migration 0005) isn't installed"* ]] && [[ -z $(quiet -d hub_03_again -A -t -c "select to_regclass('public.school_feeds')") ]]; then
  report "PASS  migration 0006 refuses to run on a database at 0003, and changes nothing"
else report "FAIL  migration 0006 refuses to run on a database at 0003  (${out:0:200})"; fi
sql -d postgres -c 'create database hub_04_again template hub_03_again'
quiet -d hub_04_again -f supabase/migrations/0004_meals_and_shopping.sql >/dev/null 2>&1
out=$(quiet -d hub_04_again -f supabase/migrations/0006_homework_school.sql 2>&1)
if [[ $out == *"(migration 0005) isn't installed"* ]] && [[ -z $(quiet -d hub_04_again -A -t -c "select to_regclass('public.school_feeds')") ]] \
   && [[ $(quiet -d hub_04_again -A -t -c "select public.hub_schema_version()") == 4 ]]; then
  report "PASS  migration 0006 refuses to run without 0005 (a database at 0004), and changes nothing"
else report "FAIL  migration 0006 refuses to run without 0005  (${out:0:200})"; fi

# 5. preflight.sql's promise, "nothing migration 0002 creates exists yet", covers everything the
#    migration creates that a live database could already have under the same name (which would
#    stop the migration): every table, index, sequence and type name in public, every trigger,
#    policy and column it adds to a v1 table, and every function name in public and private.
#    The objects come from comparing the database before and after migration 0002 (hub_02: later
#    migrations open with their own guard, and preflight.sql is for 0002 only).
objects() { # one line per object: "<kind> <name>", in preflight's spelling
  quiet -d "$1" -A -t <<'SQL'
select 'table public.' || c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
union all
select 'type public.' || t.typname from pg_type t
where t.typnamespace = 'public'::regnamespace and t.typtype in ('c', 'd', 'e', 'm', 'r')
  and (t.typrelid = 0 or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')
union all
select 'relation public.' || c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind not in ('r', 'p', 'c')
union all
select 'trigger public.' || c.relname || ': ' || g.tgname from pg_trigger g join pg_class c on c.oid = g.tgrelid
where c.relnamespace = 'public'::regnamespace and not g.tgisinternal
union all
select 'policy public.' || p.tablename || ': ' || p.policyname from pg_policies p where p.schemaname = 'public'
union all
select 'column public.' || c.relname || '.' || a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
union all
select distinct 'function ' || n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private');
SQL
}
objects hub_v1 | sort -u >"$dir/before.txt"
objects hub_02 | sort -u >"$dir/after.txt"
# New objects; triggers, policies and columns only count on tables that were already there.
comm -13 "$dir/before.txt" "$dir/after.txt" | while IFS= read -r line; do
  case $line in
    trigger*|policy*) t=${line#* }; t=${t%%: *} ;;
    column*) t=${line#column }; t=${t%.*} ;;
    *) echo "$line"; continue ;;
  esac
  grep -qxF "table $t" "$dir/before.txt" && echo "$line"
done | sort -u >"$dir/created.txt"
# What preflight checks is not there yet ("named" rows list function names).
quiet -d hub_v1 -A -t -F ' | ' -f supabase/preflight.sql | sed -n 's/^\([a-z]*\) not there yet: \(.*\) | t | ok$/\1 \2/p' \
  | while IFS= read -r line; do
      case $line in
        named*) s=${line#named }; for f in ${s#*: }; do echo "function ${s%%:*}.$f"; done ;;
        *) echo "$line" ;;
      esac
    done | sort -u >"$dir/checked.txt"
missing=$(comm -23 "$dir/created.txt" "$dir/checked.txt" | tr '\n' ';')
if [[ -s $dir/created.txt && -z $missing ]]; then
  report "PASS  preflight checks every name migration 0002 creates ($(wc -l <"$dir/created.txt") objects)"
else report "FAIL  preflight checks every name migration 0002 creates  (not checked: ${missing:-nothing found})"; fi

# 6. ... and flags one that is already there: a trigger, a policy and an index made by hand on a v1 database.
sql -d postgres -c 'create database hub_clash template hub_v1'
quiet -d hub_clash >/dev/null <<'SQL'
create trigger contractors_stamp before update on public.contractors for each row execute function public.touch_updated_at();
create policy "Family can see the directory" on public.contractors for select to authenticated using (true);
create index tasks_due_idx on public.contractors (name);
SQL
got=$(quiet -d hub_clash -A -t -F ' | ' -f supabase/preflight.sql | grep ' | f | ' | sed 's/ | f | .*//' | sort | tr '\n' ';')
want='policy not there yet: public.contractors: Family can see the directory;relation not there yet: public.tasks_due_idx;trigger not there yet: public.contractors: contractors_stamp;'
if [[ $got == "$want" ]]; then report "PASS  preflight flags a trigger, policy or index name the migration would create"
else report "FAIL  preflight flags a trigger, policy or index name the migration would create  (flagged: ${got:-nothing})"; fi
out=$(quiet -d hub_clash -f supabase/migrations/0002_home_hub_v2.sql 2>&1)
if [[ $out == *"already exists"* ]]; then report "PASS  ... which really would stop the migration"
else report "FAIL  ... which really would stop the migration  (${out:0:200})"; fi

# 5b. Migration 0003 replaces six functions (hub_schema_version, item_order, text_line, digest_item,
#     person_items and digest_for). With no Google calendar set up, the email, day_text and My day
#     must come out exactly as before: same_output.sql loads a household into hub_02, a copy of it
#     gets the later migrations, and both give the same digest_for, day_text and get_person_day
#     JSON for every person and the 14 days around the Nov 1 clock change (digest_for's new
#     "calendar": null aside).
quiet -d hub_02 -f tests/db/lib.sql >/dev/null
if ! (cd tests/db && quiet -d hub_02 -f same_output.sql) >"$dir/load.log" 2>&1; then
  report "FAIL  same output: loading same_output.sql  ($(tail -n 1 "$dir/load.log"))"
else
  sql -d postgres -c 'create database hub_02_later template hub_02'
  ok=1
  for m in supabase/migrations/*.sql; do
    [[ $(basename "$m") < 0003 ]] && continue
    if ! quiet -d hub_02_later -f "$m" >"$dir/load.log" 2>&1; then
      report "FAIL  same output: migration $(basename "$m") applies to a database with data  ($(tail -n 1 "$dir/load.log"))"; ok=0
    fi
  done
  same_output() { # one line per person, day and function, sorted
    quiet -d "$1" -A -t <<'SQL'
create temp table same_out (k text, v text);
do $$
declare
  d date;
begin
  for d in select g::date from generate_series(date '2026-10-25', date '2026-11-07', interval '1 day') g loop
    perform set_config('hub.now', to_char(d, 'YYYY-MM-DD') || ' 07:00 America/New_York', false);
    insert into same_out
    select p.name || ' ' || d || ' ' || f, v
    from public.people p
    cross join lateral (
      select 'digest_for', (select case when j -> 'calendar' = 'null' then j - 'calendar' else j end
                            from (select public.digest_for(p.id, d) as j) x)::text
      union all select 'day_text', public.day_text(p.id, d)
      union all select 'get_person_day', public.get_person_day(p.day_token)::text) x (f, v);
  end loop;
end;
$$;
select k || ' = ' || coalesce(v, 'null') from same_out order by k;
SQL
  }
  same_output hub_02 >"$dir/same_02.txt" 2>&1
  same_output hub_02_later >"$dir/same_later.txt" 2>&1
  rows=$(grep -c ' = ' "$dir/same_02.txt")
  if [[ $ok -eq 1 && $rows -gt 100 ]] && cmp -s "$dir/same_02.txt" "$dir/same_later.txt"; then
    report "PASS  same output: with no Google calendar, 0003 leaves digest_for, day_text and get_person_day as 0002 made them ($rows results)"
  else
    report "FAIL  same output: with no Google calendar, 0003 leaves digest_for, day_text and get_person_day as 0002 made them  ($rows results; first difference: $(diff "$dir/same_02.txt" "$dir/same_later.txt" | head -n 3 | cut -c 1-300 | tr '\n' ' '))"
  fi

  # 5d. Migration 0005 replaces get_person_day (the homework card). With homework off for everyone, the
  #     email, day_text and My day must come out exactly as 0004 made them: the same household at 0004
  #     (hub_04), and a copy that gets 0005 and later and then homework data for a kid whose homework is
  #     off (an assignment and its plan, a block, points, a reward and an ask, a tutor link, and one of
  #     her events linked as homework time; from 0006 a checked Assignments link with an item and a
  #     Schedule link with a class, as busy time). Compared as in 5b, with nothing stripped.
  sql -d postgres -c 'create database hub_04 template hub_02'
  ok=1
  for m in supabase/migrations/*.sql; do
    [[ $(basename "$m") < 0003 || ! $(basename "$m") < 0005 ]] && continue
    if ! quiet -d hub_04 -f "$m" >"$dir/load.log" 2>&1; then
      report "FAIL  same output at 0005: migration $(basename "$m") applies  ($(tail -n 1 "$dir/load.log"))"; ok=0
    fi
  done
  sql -d postgres -c 'create database hub_04_later template hub_04'
  for m in supabase/migrations/*.sql; do
    [[ $(basename "$m") < 0005 ]] && continue
    if ! quiet -d hub_04_later -f "$m" >"$dir/load.log" 2>&1; then
      report "FAIL  same output at 0005: migration $(basename "$m") applies to a database with data  ($(tail -n 1 "$dir/load.log"))"; ok=0
    fi
  done
  if ! quiet -d hub_04_later >"$dir/load.log" 2>&1 <<'SQL'
insert into public.homework_kids (kid_id, active) select id, false from public.people where name = 'Taylor';
insert into public.homework_times (event_id, kid_id) select e.id, p.id from public.events e, public.people p where e.title = 'Swim' and p.name = 'Taylor';
insert into public.tutor_links (kid_id, label, expires_on) select id, 'Pat Lee, tutor', '2027-05-01' from public.people where name = 'Taylor';
insert into public.assignments (id, kid_id, title, due_date, given_at, given_by)
select 'a0000000-0000-4000-8000-000000000001', id, 'Science project', '2026-11-13', '2026-10-30 20:00+00', 'alex@example.com' from public.people where name = 'Taylor';
insert into public.homework_steps (assignment_id, pos, title, minutes, day)
values ('a0000000-0000-4000-8000-000000000001', 1, 'Find 2 sources', 20, '2026-11-02'), ('a0000000-0000-4000-8000-000000000001', 2, 'Turn it in', 5, '2026-11-13');
insert into public.focus_sessions (id, kid_id, assignment_id, minutes, started_at, ends_at)
select gen_random_uuid(), id, 'a0000000-0000-4000-8000-000000000001', 20, '2026-11-02 21:30+00', '2026-11-02 21:50+00' from public.people where name = 'Taylor';
insert into public.points_ledger (kid_id, at, day, kind, delta, note, who)
select id, '2026-10-30 21:00+00', '2026-10-30', 'given', 30, 'A good start', 'alex@example.com' from public.people where name = 'Taylor';
insert into public.rewards (kid_id, title, cost) select id, 'Choose Friday''s dinner', 15 from public.people where name = 'Taylor';
insert into public.reward_asks (kid_id, reward_id, title, cost, asked_at) select kid_id, id, title, cost, '2026-10-31 15:00+00' from public.rewards;
update public.household set homework_never_send = '{"Example Academy"}', homework_ai = true;
insert into public.school_feeds (id, kid_id, kind, host, url_end, checked)
select 'f0000000-0000-4000-8000-000000000001', id, 'assignments', 'academy.school.example', 'a1b2', true from public.people where name = 'Taylor';
insert into public.school_feeds (id, kid_id, kind, host, url_end)
select 'f0000000-0000-4000-8000-000000000002', id, 'schedule', 'academy.school.example', 'c3d4' from public.people where name = 'Taylor';
insert into private.school_feed_urls (feed_id, url) values
  ('f0000000-0000-4000-8000-000000000001', 'https://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6a1b2'),
  ('f0000000-0000-4000-8000-000000000002', 'https://academy.school.example/podium/feed/iCal.aspx?z=S1s2S3s4S5s6c3d4');
insert into public.school_items (feed_id, key, has_uid, title, subject, first_day, last_day, due_date, first_seen_at, last_seen_at)
values ('f0000000-0000-4000-8000-000000000001', md5('uid:a-1'), true, 'Lab report', 'Biology', '2026-11-05', '2026-11-05', '2026-11-05', now(), now());
insert into public.school_items (feed_id, key, has_uid, title, starts_at, ends_at, first_seen_at, last_seen_at)
values ('f0000000-0000-4000-8000-000000000002', md5('uid:s-1'), true, 'Orchestra rehearsal', '2026-11-03 21:00+00', '2026-11-03 21:45+00', now(), now());
SQL
  then report "FAIL  same output at 0005: loading homework data  ($(tail -n 1 "$dir/load.log"))"; ok=0; fi
  same_output hub_04 >"$dir/same_04.txt" 2>&1
  same_output hub_04_later >"$dir/same_05.txt" 2>&1
  rows=$(grep -c ' = ' "$dir/same_04.txt")
  if [[ $ok -eq 1 && $rows -gt 100 && $(quiet -d hub_04_later -A -t -c "select count(*) from public.homework_steps") == 2 ]] \
     && cmp -s "$dir/same_04.txt" "$dir/same_05.txt"; then
    report "PASS  same output: with homework off, 0005 leaves digest_for, day_text and get_person_day as 0004 made them ($rows results)"
  else
    report "FAIL  same output: with homework off, 0005 leaves digest_for, day_text and get_person_day as 0004 made them  ($rows results; first difference: $(diff "$dir/same_04.txt" "$dir/same_05.txt" | head -n 3 | cut -c 1-300 | tr '\n' ' '))"
  fi
  # ... and turning homework on for her gives her My day exactly one more key, homework, and nothing else changes.
  got=$(quiet -d hub_04_later -A -t <<'SQL' 2>&1
set hub.now = '2026-11-02 15:00 America/New_York';
create temp table before as select p.name, public.get_person_day(p.day_token) as d, public.day_text(p.id, '2026-11-02') as t from public.people p;
update public.homework_kids set active = true;
select string_agg(b.name || ' ' || (public.get_person_day(p.day_token) - 'homework' = b.d) || ' ' || (public.get_person_day(p.day_token) ? 'homework')
                  || ' ' || (public.day_text(p.id, '2026-11-02') is not distinct from b.t), ', ' order by b.name)
from before b join public.people p on p.name = b.name where p.active;
SQL
)
  if [[ $got == "Alex true false true, Jordan true false true, Morgan true false true, Sam true false true, Taylor true true true" ]]; then
    report "PASS  same output: homework on for Taylor adds only her card to My day (no other key, no one else, no change to her texts)"
  else report "FAIL  same output: homework on for Taylor adds only her card to My day  (${got:0:300})"; fi

  # 5e. Migration 0006 wraps his view, Pat's and the card (0005's bodies are now *_v5) and replaces
  #     free_minutes. With homework on and no school link they must answer exactly as 0005 made them:
  #     the same household at 0005 (hub_05) with homework on for Taylor (her homework time, a given plan
  #     with a milestone, points, three rewards, one instant, Pat's link; a block paid when its ring ran
  #     out and not yet answered, an instant reward cashed and an ask waiting), and a copy that gets 0006
  #     and later. get_person_day for everyone, homework_by_token and tutor_view_by_token (the list, the
  #     assignment, its AI part) at three times, compared with nothing stripped.
  sql -d postgres -c 'create database hub_05 template hub_02'
  ok=1
  for m in supabase/migrations/*.sql; do
    [[ $(basename "$m") < 0003 || ! $(basename "$m") < 0006 ]] && continue
    if ! quiet -d hub_05 -f "$m" >"$dir/load.log" 2>&1; then
      report "FAIL  same output at 0006: migration $(basename "$m") applies  ($(tail -n 1 "$dir/load.log"))"; ok=0
    fi
  done
  if ! quiet -d hub_05 >"$dir/load.log" 2>&1 <<'SQL'
set hub.now = '2026-11-02 09:00 America/New_York';
select set_config('request.jwt.claims', '{"role": "authenticated", "email": "alex@example.com"}', false);
insert into public.homework_kids (kid_id, focus_minutes) select id, 20 from public.people where name = 'Taylor';
select public.add_homework_time((select id from public.people where name = 'Taylor'), '{1,2,3,4}', '16:30', '17:15');
insert into public.tutor_links (kid_id, token, label, expires_on)
select id, 'ab000000000000000000000000000cd1', 'Pat Lee, tutor', '2027-05-01' from public.people where name = 'Taylor';
insert into public.assignments (id, kid_id, title, due_date, given_at, given_by)
select 'a0000000-0000-4000-8000-000000000005', id, 'Science project', '2026-11-13', '2026-10-30 20:00+00', 'alex@example.com'
from public.people where name = 'Taylor';
insert into public.homework_steps (id, assignment_id, pos, kind, title, minutes, day) values
  ('b0000000-0000-4000-8000-000000000051', 'a0000000-0000-4000-8000-000000000005', 1, 'step', 'Find 2 sources', 20, '2026-11-02'),
  ('b0000000-0000-4000-8000-000000000052', 'a0000000-0000-4000-8000-000000000005', 2, 'milestone', 'Outline checked', 15, '2026-11-03'),
  ('b0000000-0000-4000-8000-000000000053', 'a0000000-0000-4000-8000-000000000005', 3, 'turn_in', 'Turn it in', 5, '2026-11-13');
insert into public.rewards (kid_id, title, cost, instant, sort_order)
select p.id, v.t, v.c, v.i, v.o from public.people p,
  (values ('Game time now', 15, true, 1), ('Choose Friday''s dinner', 60, false, 2), ('A new book', 150, false, 3)) v (t, c, i, o)
where p.name = 'Taylor';
insert into public.points_ledger (kid_id, at, day, kind, delta, note, who)
select id, '2026-10-30 21:00+00', '2026-10-30', 'given', 100, 'A good start', 'alex@example.com' from public.people where name = 'Taylor';
select set_config('request.jwt.claims', '', false);
-- Taylor's side, through her token: a block whose ring ran out (End 'time', paid, her answer still to
-- come), then an instant reward cashed and an ask.
set hub.now = '2026-11-02 16:30 America/New_York';
select public.focus_by_token(p.day_token, 'start', 'c0000000-0000-4000-8000-000000000051', 20, 'b0000000-0000-4000-8000-000000000051')
from public.people p where p.name = 'Taylor';
set hub.now = '2026-11-02 16:51 America/New_York';
select public.focus_by_token(p.day_token, 'end', 'c0000000-0000-4000-8000-000000000051', null, null, null, null, 'time')
from public.people p where p.name = 'Taylor';
select public.reward_by_token(p.day_token, 'cash', (select r.id from public.rewards r where r.title = 'Game time now'), null,
                              'c0000000-0000-4000-8000-000000000052', 15)
from public.people p where p.name = 'Taylor';
select public.reward_by_token(p.day_token, 'ask', (select r.id from public.rewards r where r.title = 'Choose Friday''s dinner'), null,
                              'c0000000-0000-4000-8000-000000000053')
from public.people p where p.name = 'Taylor';
SQL
  then report "FAIL  same output at 0006: loading homework data  ($(grep -m 1 ERROR "$dir/load.log" || tail -n 1 "$dir/load.log"))"; ok=0; fi
  sql -d postgres -c 'create database hub_05_later template hub_05'
  for m in supabase/migrations/*.sql; do
    [[ $(basename "$m") < 0006 ]] && continue
    if ! quiet -d hub_05_later -f "$m" >"$dir/load.log" 2>&1; then
      report "FAIL  same output at 0006: migration $(basename "$m") applies to a database with homework  ($(tail -n 1 "$dir/load.log"))"; ok=0
    fi
  done
  same_homework() { # one line per time and answer, sorted
    quiet -d "$1" -A -t <<'SQL'
create temp table same_hw (k text, v text);
do $$
declare
  t   text;
  tok text := (select p.day_token from public.people p where p.name = 'Taylor');
  pat text := 'ab000000000000000000000000000cd1';
  a   uuid := 'a0000000-0000-4000-8000-000000000005';
begin
  foreach t in array array['2026-11-02 16:55 America/New_York', '2026-11-03 16:40 America/New_York',
                           '2026-11-05 09:00 America/New_York'] loop
    perform set_config('hub.now', t, false);
    insert into same_hw select t || ' get_person_day ' || p.name, public.get_person_day(p.day_token)::text from public.people p;
    insert into same_hw values
      (t || ' homework_by_token', public.homework_by_token(tok)::text),
      (t || ' tutor_view_by_token list', public.tutor_view_by_token(pat)::text),
      (t || ' tutor_view_by_token assignment', public.tutor_view_by_token(pat, a)::text),
      (t || ' tutor_view_by_token ai', public.tutor_view_by_token(pat, a, 'ai')::text);
  end loop;
end;
$$;
select k || ' = ' || coalesce(v, 'null') from same_hw order by k;
SQL
  }
  same_homework hub_05 >"$dir/same_hw_05.txt" 2>&1
  same_homework hub_05_later >"$dir/same_hw_06.txt" 2>&1
  rows=$(grep -c ' = ' "$dir/same_hw_05.txt")
  # Not vacuous: her card at 4:55 has the paid block's answer still due and the next-reward bar, and her
  # view and Pat's answer.
  card=$(grep -F '2026-11-02 16:55 America/New_York get_person_day Taylor = ' "$dir/same_hw_05.txt")
  if [[ $ok -eq 1 && $rows -ge 30 && $card == *'"answer_due": true'* && $card == *'"goal": {'* && $card == *'"instant": true'* ]] \
     && ! grep -q -E 'homework_by_token = null|tutor_view_by_token [a-z]+ = null' "$dir/same_hw_05.txt" \
     && cmp -s "$dir/same_hw_05.txt" "$dir/same_hw_06.txt"; then
    report "PASS  same output: with homework on and no school link, 0006 leaves get_person_day, his view and Pat's as 0005 made them ($rows results)"
  else
    report "FAIL  same output: with homework on and no school link, 0006 leaves get_person_day, his view and Pat's as 0005 made them  ($rows results; first difference: $(diff "$dir/same_hw_05.txt" "$dir/same_hw_06.txt" | head -n 3 | cut -c 1-400 | tr '\n' ' '))"
  fi
fi

# 5c. Migration 0004 wraps private.calendar_desired (0003's body is now calendar_desired_v3) and
#     replaces calendar_plan. With no meal planned, every event on the wall must come out exactly
#     as before ("same wall"): calendar_fixtures.sql's household (with a writing Family calendar)
#     goes into a database at 0003, a copy of it gets 0004 and later, and both give the same
#     calendar_desired, calendar_plan and calendar_preview for every calendar at three times
#     (Oct 27, and 07:00 and 23:30 on Nov 1, the clock change), column by column with nothing
#     stripped; the first plan is recorded as written in between, so the later plans weigh links
#     too. Then a dinner added to the copy gives exactly one more desired row, of kind 'meal', on
#     the Family calendar.
sql -d postgres -c 'create database hub_03 template hub_v1'
ok=1
for m in supabase/migrations/*.sql; do
  [[ $(basename "$m") < 0004 ]] || continue
  if ! quiet -d hub_03 -f "$m" >"$dir/load.log" 2>&1; then
    report "FAIL  same wall: migration $(basename "$m") applies  ($(tail -n 1 "$dir/load.log"))"; ok=0
  fi
done
quiet -d hub_03 -f tests/db/lib.sql >/dev/null
if ! (cd tests/db && quiet -d hub_03 -f roles.sql -f calendar_fixtures.sql) >"$dir/load.log" 2>&1; then
  report "FAIL  same wall: loading calendar_fixtures.sql  ($(tail -n 1 "$dir/load.log"))"; ok=0
fi
sql -d postgres -c 'create database hub_03_later template hub_03'
for m in supabase/migrations/*.sql; do
  [[ $(basename "$m") < 0004 ]] && continue
  if ! quiet -d hub_03_later -f "$m" >"$dir/load.log" 2>&1; then
    report "FAIL  same wall: migration $(basename "$m") applies to a database with calendars  ($(tail -n 1 "$dir/load.log"))"; ok=0
  fi
done
same_wall() { # one line per row of each function at each time, sorted
  quiet -d "$1" -A -t <<'SQL'
create temp table same_wall (k text, v text);
do $$
declare
  t text;
begin
  foreach t in array array['2026-10-27 09:00 America/New_York', '2026-11-01 07:00 America/New_York',
                           '2026-11-01 23:30 America/New_York'] loop
    perform set_config('hub.now', t, false);
    insert into same_wall
    select t || ' desired ' || d.google_calendar || ' ' || d.base_id, d::text
    from private.calendar_desired(public.today_local() - 1, public.today_local() + 60, 'https://hub.example.com/') d;
    insert into same_wall
    select t || ' plan ' || lpad(p.ordinality::text, 4, '0'), p::text
    from public.calendar_plan('https://hub.example.com/', 1000) with ordinality p;
    perform set_config('request.jwt.claims', '{"role": "authenticated", "email": "alex@example.com"}', false);
    insert into same_wall
    select t || ' preview ' || c.label || ' ' || lpad(v.ordinality::text, 4, '0'), v::text
    from public.calendars c
    cross join lateral public.calendar_preview(c.id) with ordinality v;
    perform set_config('request.jwt.claims', '', false);
    -- Google took everything the first plan offered (as hub-jobs records it).
    if t like '2026-10-27%' then
      perform public.calendar_record((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
                                        'ok', true, 'google_hash', 'g-' || p.event_id, 'google_updated', '2026-10-27T13:00:00Z'))
                                      from public.calendar_plan('https://hub.example.com/', 1000) p));
    end if;
  end loop;
end;
$$;
select k || ' = ' || coalesce(v, 'null') from same_wall order by k;
SQL
}
same_wall hub_03 >"$dir/wall_03.txt" 2>&1
same_wall hub_03_later >"$dir/wall_later.txt" 2>&1
rows=$(grep -c ' = ' "$dir/wall_03.txt")
kinds=$(grep -c -E ' (desired|plan|preview) ' "$dir/wall_03.txt")
if [[ $ok -eq 1 && $rows -gt 100 && $rows -eq $kinds ]] && grep -q ' plan ' "$dir/wall_03.txt" && grep -q ' preview ' "$dir/wall_03.txt" \
   && cmp -s "$dir/wall_03.txt" "$dir/wall_later.txt"; then
  report "PASS  same wall: with no meal, 0004 leaves calendar_desired, calendar_plan and calendar_preview as 0003 made them ($rows results)"
else
  report "FAIL  same wall: with no meal, 0004 leaves calendar_desired, calendar_plan and calendar_preview as 0003 made them  ($rows results; first difference: $(diff "$dir/wall_03.txt" "$dir/wall_later.txt" | head -n 3 | cut -c 1-300 | tr '\n' ' '))"
fi
got=$(quiet -d hub_03_later -A -t <<'SQL' 2>&1
set hub.now = '2026-10-27 09:00 America/New_York';
create temp table before as
  select * from private.calendar_desired(public.today_local() - 1, public.today_local() + 60, 'https://hub.example.com/');
insert into public.meals (day, kind, title, cook_id) values ('2026-10-28', 'cook', 'Tacos', (select id from public.people where name = 'Sam'));
select (select count(*) from private.calendar_desired(public.today_local() - 1, public.today_local() + 60, 'https://hub.example.com/'))
         - (select count(*) from before)
       || ' ' || (select string_agg(c.label || ' ' || d.item_kind || ' ' || d.title, ', ')
                  from private.calendar_desired(public.today_local() - 1, public.today_local() + 60, 'https://hub.example.com/') d
                  join public.calendars c on c.id = d.calendar_id
                  where (d.google_calendar, d.base_id) not in (select b.google_calendar, b.base_id from before b))
       || ' ' || (select count(*) from before b
                  where not exists (select 1 from private.calendar_desired(public.today_local() - 1, public.today_local() + 60,
                                                                           'https://hub.example.com/') d
                                    where d::text = b::text));
SQL
)
if [[ $got == "1 Family meal Dinner: Tacos (Sam) 0" ]]; then
  report "PASS  same wall: a dinner adds exactly one desired row, of kind 'meal', on the Family calendar"
else report "FAIL  same wall: a dinner adds exactly one desired row, of kind 'meal', on the Family calendar  (got ${got:0:300})"; fi

# 7. Each test file gets a fresh copy, with the helpers in schema "test".
quiet -d hub -f tests/db/lib.sql >/dev/null
for f in tests/db/*.test.sql; do
  name=$(basename "$f" .test.sql)
  echo "-- $name"
  sql -d postgres -c "create database \"t_$name\" template hub"
  out=$(cd tests/db && sql -d "t_$name" -f "$(basename "$f")" 2>&1 >/dev/null)
  status=$?
  while IFS= read -r line; do
    case $line in
      *"NOTICE:  PASS  "*|*"NOTICE:  FAIL  "*) report "${line#*NOTICE:  }" ;;
      *ERROR:*) report "FAIL  $name stopped: ${line#psql:}" ;;
      '') ;;
      *) echo "   $line" ;;
    esac
  done <<<"$out"
  [[ $status -ne 0 && $out != *ERROR:* ]] && report "FAIL  $name: psql exited with status $status"
done

echo "== database: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
