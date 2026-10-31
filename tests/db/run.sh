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
# homework on and no school link 0006 leaves My day, his homework view and Pat's as 0005 made them (step 5e),
# and 0007 (the coach view) too while it is off, as 0007 leaves every link (5d, 5e); turning it on for a link
# adds one key to that link's view and changes nothing else (step 5f); and that migration 0008 changes only the
# school status card's first-import check and what a removed link added again keeps of its last read (its refusals,
# its undo, and "same status card"); and that migration 0009 keys the school items by what they are, not by
# Blackbaud's UIDs, and makes the copies a database at 0008 has one row an item (its refusals, its undo, the live
# database's shape: 54 rows of 18 assignments and 570 of 285 classes, and "same views" where there were no copies); and that
# migration 0010 (Hearth people) refuses what it should (twice, too early, set back to 9, a half-applied shape), leaves every
# answer as 0009 made it while no calendar is sorted (step 5g), and can be undone (hub_09 is the database at 0009).
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
# 0007 (the coach view) refuses to run twice, and on a v1 database.
out=$(quiet -d hub_again -f supabase/migrations/0007_homework_coach.sql 2>&1)
if [[ $out == *"already installed"* ]]; then report "PASS  migration 0007 refuses to run twice"
else report "FAIL  migration 0007 refuses to run twice  (${out:0:200})"; fi
out=$(quiet -d hub_v1_again -f supabase/migrations/0007_homework_coach.sql 2>&1)
if [[ $out == *"isn't installed"* ]] && [[ -z $(quiet -d hub_v1_again -A -t -c "select to_regclass('public.coach_notes')") ]]; then
  report "PASS  migration 0007 refuses to run on a v1 database (0002 isn't installed), and changes nothing"
else report "FAIL  migration 0007 refuses to run on a v1 database  (${out:0:200})"; fi
# A database where the owner set the coach view back as docs/v1.3-homework.md §20.7 says (every link's coach view off,
# hub_schema_version() set back to 6): running 0007 again says so, and changes nothing.
sql -d postgres -c 'create database hub_set_back_6 template hub'
quiet -d hub_set_back_6 >/dev/null <<'SQL'
update public.tutor_links set coach = false;
create or replace function public.hub_schema_version() returns int language sql immutable set search_path = '' as $$ select 6 $$;
SQL
before=$(catalog_of hub_set_back_6)
out=$(quiet -d hub_set_back_6 -f supabase/migrations/0007_homework_coach.sql 2>&1)
got=$(quiet -d hub_set_back_6 -A -t -c "select public.hub_schema_version()")
if [[ $out == *"set back to 6"* && $got == "6" && $(catalog_of hub_set_back_6) == "$before" ]]; then
  report "PASS  migration 0007 on a database set back to 6: says so (\"set back to 6\"), and changes nothing"
else report "FAIL  migration 0007 on a database set back to 6  (${out:0:200}; version: $got)"; fi

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
# Migration 0007 refuses a database without 0006: one at 0004 and one at 0005 ("The school feed (migration 0006) isn't installed").
out=$(quiet -d hub_04_again -f supabase/migrations/0007_homework_coach.sql 2>&1)
if [[ $out == *"(migration 0006) isn't installed"* ]] && [[ -z $(quiet -d hub_04_again -A -t -c "select to_regclass('public.coach_notes')") ]]; then
  report "PASS  migration 0007 refuses to run on a database at 0004, and changes nothing"
else report "FAIL  migration 0007 refuses to run on a database at 0004  (${out:0:200})"; fi
sql -d postgres -c 'create database hub_05_again template hub_04_again'
quiet -d hub_05_again -f supabase/migrations/0005_homework.sql >/dev/null 2>&1
out=$(quiet -d hub_05_again -f supabase/migrations/0007_homework_coach.sql 2>&1)
if [[ $out == *"(migration 0006) isn't installed"* ]] && [[ -z $(quiet -d hub_05_again -A -t -c "select to_regclass('public.coach_notes')") ]] \
   && [[ $(quiet -d hub_05_again -A -t -c "select public.hub_schema_version() || ' ' || (select count(*) from pg_attribute where attrelid = 'public.tutor_links'::regclass and attname = 'coach')") == "5 0" ]]; then
  report "PASS  migration 0007 refuses to run without 0006 (a database at 0005), and changes nothing"
else report "FAIL  migration 0007 refuses to run without 0006  (${out:0:200})"; fi
# 0007 on a database with tasks, events and task entries already there (docs/v1.3-homework.md §20.2): the tasks and
# events take 0007's time as their people_changed_at / responsible_changed_at (so the coach view takes none of their
# earlier days for his), without a save (updated_at as it was); the entries already there have no stamp; a task or
# event made afterwards has no time, and an entry written afterwards takes its task's person.
sql -d postgres -c 'create database hub_06_stamps template hub_05_again'
quiet -d hub_06_stamps -f supabase/migrations/0006_homework_school.sql >/dev/null 2>&1
quiet -d hub_06_stamps >/dev/null <<'SQL'
insert into public.tasks (title, responsible_id, due_date, updated_at) select 'Old chore', id, current_date, '2026-01-02 03:04+00' from public.people where name = 'Sam';
insert into public.events (title, start_date, responsible_id, updated_at) select 'Old class', current_date, id, '2026-01-02 03:04+00' from public.people where name = 'Sam';
insert into public.task_log (task_id, occurrence, status) select id, current_date, 'done' from public.tasks where title = 'Old chore';
SQL
t0=$(quiet -d hub_06_stamps -A -t -c "select now()")
out=$(quiet -d hub_06_stamps -f supabase/migrations/0007_homework_coach.sql 2>&1)
got=$(quiet -d hub_06_stamps -A -t <<SQL
insert into public.tasks (title, responsible_id) select 'New chore', id from public.people where name = 'Sam';
insert into public.events (title, start_date) values ('New class', current_date);
insert into public.task_log (task_id, occurrence, status) select id, current_date, 'skipped' from public.tasks where title = 'Old chore';
select (t.responsible_changed_at >= '$t0') || ' ' || (e.people_changed_at >= '$t0') || ' ' || (t.updated_at = '2026-01-02 03:04+00') || ' '
       || (e.updated_at = '2026-01-02 03:04+00') || ' ' || (select count(*) from public.tasks where title = 'New chore' and responsible_changed_at is null) || ' '
       || (select count(*) from public.events where title = 'New class' and people_changed_at is null) || ' '
       || (select string_agg(l.status || ':' || (l.responsible_id is not distinct from t.responsible_id), ',' order by l.seq) from public.task_log l where l.task_id = t.id)
from public.tasks t, public.events e where t.title = 'Old chore' and e.title = 'Old class';
SQL
)
if [[ $got == "true true true true 1 1 done:false,skipped:true" ]]; then
  report "PASS  migration 0007 stamps the tasks and events already there with its time, without saving them; earlier task entries have no stamp, later ones their task's person"
else report "FAIL  migration 0007 stamps the tasks and events already there  (${out:0:200}; got $got)"; fi

# 0008 (the first-import check's past items) refuses to run twice, on a v1 database, and without 0007 (at 0005 and
# at 0006): each says why, and changes nothing.
# (hub_again is a copy of a fresh install, at 10 since 0010.)
out=$(quiet -d hub_again -f supabase/migrations/0008_school_check.sql 2>&1)
if [[ $out == *"already installed"* ]] && [[ $(quiet -d hub_again -A -t -c "select public.hub_schema_version()") == 10 ]]; then
  report "PASS  migration 0008 refuses to run twice"
else report "FAIL  migration 0008 refuses to run twice  (${out:0:200})"; fi
out=$(quiet -d hub_v1_again -f supabase/migrations/0008_school_check.sql 2>&1)
if [[ $out == *"isn't installed"* ]] && [[ -z $(quiet -d hub_v1_again -A -t -c "select to_regprocedure('public.hub_schema_version()')") ]]; then
  report "PASS  migration 0008 refuses to run on a v1 database (0002 isn't installed), and changes nothing"
else report "FAIL  migration 0008 refuses to run on a v1 database  (${out:0:200})"; fi
before=$(catalog_of hub_05_again)
out=$(quiet -d hub_05_again -f supabase/migrations/0008_school_check.sql 2>&1)
if [[ $out == *"(migration 0007) isn't installed"* ]] && [[ $(catalog_of hub_05_again) == "$before" ]] \
   && [[ $(quiet -d hub_05_again -A -t -c "select public.hub_schema_version()") == 5 ]]; then
  report "PASS  migration 0008 refuses to run on a database at 0005, and changes nothing"
else report "FAIL  migration 0008 refuses to run on a database at 0005  (${out:0:200})"; fi
sql -d postgres -c 'create database hub_06_only template hub_05_again'
quiet -d hub_06_only -f supabase/migrations/0006_homework_school.sql >/dev/null 2>&1
before=$(catalog_of hub_06_only)
out=$(quiet -d hub_06_only -f supabase/migrations/0008_school_check.sql 2>&1)
if [[ $out == *"(migration 0007) isn't installed"* ]] && [[ $(catalog_of hub_06_only) == "$before" ]] \
   && [[ $(quiet -d hub_06_only -A -t -c "select public.hub_schema_version()") == 6 ]]; then
  report "PASS  migration 0008 refuses to run without 0007 (a database at 0006), and changes nothing"
else report "FAIL  migration 0008 refuses to run without 0007  (${out:0:200})"; fi
# ... and on a database at 0007 that isn't as 0007 left it, where what 0008 replaces or reads is missing: the status
# card's function, Add link's (set_school_feed), the column that marks an item gone from the school site, or the
# table that keeps a link's address.
n=0
for broken in 'drop function public.school_feed_status(uuid)' 'drop function public.set_school_feed(uuid, text, text)' \
              'alter table public.school_items drop column gone_at' 'drop table private.school_feed_urls'; do
  n=$((n + 1))
  sql -d postgres -c "create database hub_07_shape$n template hub_06_stamps"
  quiet -d "hub_07_shape$n" -c "$broken" >/dev/null
  before=$(catalog_of "hub_07_shape$n")
  out=$(quiet -d "hub_07_shape$n" -f supabase/migrations/0008_school_check.sql 2>&1)
  if [[ $out == *"isn't as migration 0007 left it"* ]] && [[ $(catalog_of "hub_07_shape$n") == "$before" ]] \
     && [[ $(quiet -d "hub_07_shape$n" -A -t -c "select public.hub_schema_version()") == 7 ]]; then
    report "PASS  migration 0008 refuses a database at 0007 not as 0007 left it ($broken), and changes nothing"
  else report "FAIL  migration 0008 refuses a database at 0007 not as 0007 left it ($broken)  (${out:0:200})"; fi
done
# A database at 0008 (0007's, with 0008; a fresh install is at 9 since 0009), for 0008's undo and 0009's checks.
sql -d postgres -c 'create database hub_08 template hub_06_stamps'
if ! quiet -d hub_08 -f supabase/migrations/0008_school_check.sql >"$dir/load.log" 2>&1; then
  report "FAIL  migration 0008 applies to hub_08  ($(tail -n 1 "$dir/load.log"))"
fi
# Undo, as docs/v1.3-homework.md §16.7 says: 0006's school_feed_status and set_school_feed again (their create
# function … $$; blocks from 0006, with create or replace) and hub_schema_version() returning 7. The two functions are
# then 0006's (the same as on a database at 0007, with the same grants), and 0008 runs again, leaving the functions as on
# a database at 0008.
sql -d postgres -c 'create database hub_set_back_7 template hub_08'
{ for f in 'school_feed_status(p_kid uuid)' 'set_school_feed(p_kid uuid, p_kind text, p_url text)'; do
    sed -n "/^create function public\.$f\$/,/^\\$\\$;\$/p" supabase/migrations/0006_homework_school.sql \
      | sed '1s/^create function/create or replace function/'
  done
  echo "create or replace function public.hub_schema_version() returns int language sql immutable set search_path = '' as \$\$ select 7 \$\$;"
} >"$dir/undo_0008.sql"
fn_of() { quiet -d "$1" -A -t -c "select string_agg(p.proname || ' ' || md5(p.prosrc) || ' ' || p.prosecdef || ' ' || p.provolatile::text || ' ' || array_to_string(p.proconfig, ',')
                                         || ' ' || has_function_privilege('anon', p.oid, 'execute') || ' ' || has_function_privilege('authenticated', p.oid, 'execute')
                                         || ' ' || has_function_privilege('service_role', p.oid, 'execute'), ' | ' order by p.proname)
                                  from pg_proc p where p.oid in ('public.school_feed_status(uuid)'::regprocedure, 'public.set_school_feed(uuid,text,text)'::regprocedure)"; }
undo=$(quiet -d hub_set_back_7 -f "$dir/undo_0008.sql" 2>&1)
v07=$(fn_of hub_06_stamps)
got_undo="$(quiet -d hub_set_back_7 -A -t -c "select public.hub_schema_version()") $([[ -n $v07 && $(fn_of hub_set_back_7) == "$v07" ]] && echo same-as-0007)"
out=$(quiet -d hub_set_back_7 -f supabase/migrations/0008_school_check.sql 2>&1)
got_again="$(quiet -d hub_set_back_7 -A -t -c "select public.hub_schema_version()") $([[ $(catalog_of hub_set_back_7) == "$(catalog_of hub_08)" && -n $(fn_of hub_08) && $(fn_of hub_set_back_7) == "$(fn_of hub_08)" ]] && echo same-as-0008)"
if [[ -z $undo && $got_undo == "7 same-as-0007" && -z $out && $got_again == "8 same-as-0008" ]]; then
  report "PASS  migration 0008's undo: 0006's status card and Add link back, schema 7; then 0008 runs again, as on a database at 0008"
else report "FAIL  migration 0008's undo  (undo: ${undo:0:150}; then: $got_undo; again: ${out:0:150} $got_again)"; fi
# Same output: on a database at 0007 with school links (as 5d's), 0008 changes only the status card's check: every
# other key of every kid's card is as before; a link with five or more items to come gets the same five, each with
# past: false; a link whose items are all past gets its five latest (it had none); a checked link still none.
sql -d postgres -c 'create database hub_07_school template hub_06_stamps'
quiet -d hub_07_school >"$dir/load.log" 2>&1 <<'SQL'
insert into public.people (name, role, sort_order) values ('Taylor', 'kid', 3), ('Robin', 'kid', 4), ('Riley', 'kid', 5);
insert into public.homework_kids (kid_id, active) select id, true from public.people where name in ('Taylor', 'Robin', 'Riley');
insert into public.school_feeds (id, kid_id, kind, host, url_end, checked, last_ok_at, last_count, next_at)
select f.id::uuid, p.id, f.kind, 'academy.school.example', f.url_end, f.checked, '2026-11-02 13:00+00', 7, '2026-11-02 13:50+00'
from (values ('f0000000-0000-4000-8000-000000000001', 'Taylor', 'assignments', 'a1b2', false), ('f0000000-0000-4000-8000-000000000002', 'Taylor', 'schedule', 'c3d4', false),
             ('f0000000-0000-4000-8000-000000000003', 'Robin', 'assignments', 'e5f6', true), ('f0000000-0000-4000-8000-000000000004', 'Riley', 'assignments', 'g7h8', false))
     f (id, name, kind, url_end, checked)
join public.people p on p.name = f.name;
insert into public.assignments (id, kid_id, title, due_date, added_by)
select a.id::uuid, p.id, a.title, a.due::date, 'school' from (values ('a0000000-0000-4000-8000-000000000011', 'Lab write-up', '2026-11-05'),
                                                         ('a0000000-0000-4000-8000-000000000012', 'Old essay', '2026-11-03')) a (id, title, due)
join public.people p on p.name = 'Robin';
insert into public.school_items (feed_id, key, has_uid, title, subject, first_day, last_day, due_date, hidden, gone_at, assignment_id, made_at, applied,
                                 first_seen_at, last_seen_at)
select i.feed::uuid, md5(i.title), true, i.title, 'English', i.due::date, i.due::date, i.due::date, i.hidden, i.gone::timestamptz, i.asg::uuid,
       case when i.asg is not null then '2026-10-30 12:00+00'::timestamptz end,
       case when i.asg is not null then jsonb_build_object('title', i.title, 'subject', 'English', 'due_date', i.applied_due, 'details', null) end,
       '2026-10-20 12:00+00', '2026-11-02 13:00+00'
from (values
  -- Taylor's link, not checked: seven to come, two past, and one gone from the school site that would be first.
  ('f0000000-0000-4000-8000-000000000001', 'Read chapter 5', '2026-11-03', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000001', 'Lab report', '2026-11-04', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000001', 'Map quiz', '2026-11-05', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000001', 'Poem', '2026-11-06', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000001', 'Essay outline', '2026-11-09', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000001', 'Spelling test', '2026-11-10', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000001', 'Science fair form', '2026-11-12', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000001', 'Reading log', '2026-10-30', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000001', 'Worksheet', '2026-10-29', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000001', 'Old quiz', '2026-11-02', false, '2026-11-01 12:00+00', null, null),
  -- Robin's link, checked: one new, one hidden, one made homework whose date the school moved, one made homework gone.
  ('f0000000-0000-4000-8000-000000000003', 'Vocabulary quiz', '2026-11-04', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000003', 'Map project', '2026-11-06', true, null, null, null),
  ('f0000000-0000-4000-8000-000000000003', 'Lab write-up', '2026-11-09', false, null, 'a0000000-0000-4000-8000-000000000011', '2026-11-05'),
  ('f0000000-0000-4000-8000-000000000003', 'Old essay', '2026-11-03', false, '2026-11-01 12:00+00', 'a0000000-0000-4000-8000-000000000012', '2026-11-03'),
  -- Riley's link, not checked: everything past (read over a break).
  ('f0000000-0000-4000-8000-000000000004', 'Book report', '2026-10-20', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000004', 'Fractions', '2026-10-22', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000004', 'Lab safety', '2026-10-25', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000004', 'Vocabulary list', '2026-10-27', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000004', 'Poem recital', '2026-10-28', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000004', 'Map of Europe', '2026-10-30', false, null, null, null),
  ('f0000000-0000-4000-8000-000000000004', 'Unit review', '2026-11-01', false, null, null, null)
) i (feed, title, due, hidden, gone, asg, applied_due);
insert into public.school_items (feed_id, key, has_uid, title, starts_at, ends_at, first_seen_at, last_seen_at)
values ('f0000000-0000-4000-8000-000000000002', md5('orchestra'), true, 'Orchestra rehearsal', '2026-11-03 21:00+00', '2026-11-03 21:45+00', now(), now());
SQL
[[ $? -ne 0 ]] && report "FAIL  same status card: loading school data  ($(grep -m 1 ERROR "$dir/load.log" || tail -n 1 "$dir/load.log"))"
cards() { # every person's status card, as Alex, on Mon Nov 2 at 9am
  quiet -d hub_07_school -A -t <<'SQL'
set hub.now = '2026-11-02 09:00 America/New_York';
set request.jwt.claims = '{"role": "authenticated", "email": "alex@example.com"}';
set role authenticated;
select jsonb_object_agg(p.name, public.school_feed_status(p.id)) from public.people p;
SQL
}
before=$(cards)
out=$(quiet -d hub_07_school -f supabase/migrations/0008_school_check.sql 2>&1)
got=$(quiet -d hub_07_school -A -t -v before="$before" <<'SQL'
set hub.now = '2026-11-02 09:00 America/New_York';
set request.jwt.claims = '{"role": "authenticated", "email": "alex@example.com"}';
set role authenticated;
with b as (select key as name, nullif(value, 'null') as s from jsonb_each(:'before'::jsonb)),
     a as (select p.name, public.school_feed_status(p.id) as s from public.people p),
     t as (select a.s -> 'check' as now, b.s -> 'check' as was from a join b using (name) where name = 'Taylor'),
     r as (select a.s -> 'check' as now, b.s -> 'check' as was from a join b using (name) where name = 'Riley'),
     o as (select b.s as was, a.s -> 'check' as now from a join b using (name) where name = 'Robin')
select (select count(*) from b) || ' ' || (select count(*) from b where s is not null) || ' '
       || (select bool_and((a.s - 'check') is not distinct from (b.s - 'check')) from a join b using (name)) || ' '
       || (select string_agg(x ->> 'title', ',' order by n) from t, jsonb_array_elements(t.was) with ordinality j (x, n)) || ' '
       || (select (select jsonb_agg(x - 'past' order by n) from jsonb_array_elements(t.now) with ordinality j (x, n)) = t.was
                  and (select bool_and(x -> 'past' = 'false') from jsonb_array_elements(t.now) x) from t) || ' '
       || (select jsonb_array_length(r.was) || ' ' || (select string_agg((x ->> 'due_date') || ':' || (x ->> 'past'), ',' order by n)
                                                       from jsonb_array_elements(r.now) with ordinality j (x, n)) from r) || ' '
       || (select jsonb_array_length(o.was -> 'new') || ',' || jsonb_array_length(o.was -> 'hidden') || ',' || jsonb_array_length(o.was -> 'moved') || ','
                  || jsonb_array_length(o.was -> 'gone') || ',' || jsonb_array_length(o.was -> 'feeds') || ' ' || (o.was -> 'check')::text || ' ' || o.now::text from o);
SQL
)
want="5 3 true Read chapter 5,Lab report,Map quiz,Poem,Essay outline true 0 2026-10-25:true,2026-10-27:true,2026-10-28:true,2026-10-30:true,2026-11-01:true 1,1,1,1,1 [] []"
if [[ -z $out && $got == "$want" ]]; then
  report "PASS  same status card: 0008 changes only the check (past: false on five to come, the five latest for a link with none to come)"
else report "FAIL  same status card: 0008 changes only the check  (${out:0:150}; got ${got:0:400}; want $want)"; fi

# 0009 (the school items' keys: Blackbaud's UIDs change every hour or two) refuses to run twice, on a v1 database,
# without 0008 (at 0006 and at 0007), and on a database at 0008 that isn't as 0008 left it: each says why, and
# changes nothing.
out=$(quiet -d hub_again -f supabase/migrations/0009_school_keys.sql 2>&1)
if [[ $out == *"already installed"* ]] && [[ $(quiet -d hub_again -A -t -c "select public.hub_schema_version()") == 10 ]]; then
  report "PASS  migration 0009 refuses to run twice"
else report "FAIL  migration 0009 refuses to run twice  (${out:0:200})"; fi
out=$(quiet -d hub_v1_again -f supabase/migrations/0009_school_keys.sql 2>&1)
if [[ $out == *"isn't installed"* ]] && [[ -z $(quiet -d hub_v1_again -A -t -c "select to_regprocedure('public.hub_schema_version()')") ]]; then
  report "PASS  migration 0009 refuses to run on a v1 database (0002 isn't installed), and changes nothing"
else report "FAIL  migration 0009 refuses to run on a v1 database  (${out:0:200})"; fi
before=$(catalog_of hub_06_only)
out=$(quiet -d hub_06_only -f supabase/migrations/0009_school_keys.sql 2>&1)
if [[ $out == *"(migration 0008) isn't installed"* ]] && [[ $(catalog_of hub_06_only) == "$before" ]] \
   && [[ $(quiet -d hub_06_only -A -t -c "select public.hub_schema_version()") == 6 ]]; then
  report "PASS  migration 0009 refuses to run on a database at 0006, and changes nothing"
else report "FAIL  migration 0009 refuses to run on a database at 0006  (${out:0:200})"; fi
sql -d postgres -c 'create database hub_07_only template hub_06_stamps'
before=$(catalog_of hub_07_only)
out=$(quiet -d hub_07_only -f supabase/migrations/0009_school_keys.sql 2>&1)
if [[ $out == *"(migration 0008) isn't installed"* ]] && [[ $(catalog_of hub_07_only) == "$before" ]] \
   && [[ $(quiet -d hub_07_only -A -t -c "select public.hub_schema_version()") == 7 ]]; then
  report "PASS  migration 0009 refuses to run without 0008 (a database at 0007), and changes nothing"
else report "FAIL  migration 0009 refuses to run without 0008  (${out:0:200})"; fi
# ... on hub_08 (a database at 0008, above) not as 0008 left it, where what 0009 replaces or reads is missing: the function it replaces
# (private.school_rows), the columns it rekeys (school_items.has_uid) and reads (school_feeds.last_ok_at), or a
# helper school_rows calls (private.safe_instant).
n=0
for broken in 'drop function private.school_rows(text, jsonb, text, int, date)' 'alter table public.school_items drop column has_uid' \
              'alter table public.school_feeds drop column last_ok_at' 'drop function private.safe_instant(text)'; do
  n=$((n + 1))
  sql -d postgres -c "create database hub_08_shape$n template hub_08"
  quiet -d "hub_08_shape$n" -c "$broken" >/dev/null
  before=$(catalog_of "hub_08_shape$n")
  out=$(quiet -d "hub_08_shape$n" -f supabase/migrations/0009_school_keys.sql 2>&1)
  if [[ $out == *"isn't as migration 0008 left it"* ]] && [[ $(catalog_of "hub_08_shape$n") == "$before" ]] \
     && [[ $(quiet -d "hub_08_shape$n" -A -t -c "select public.hub_schema_version()") == 8 ]]; then
    report "PASS  migration 0009 refuses a database at 0008 not as 0008 left it ($broken), and changes nothing"
  else report "FAIL  migration 0009 refuses a database at 0008 not as 0008 left it ($broken)  (${out:0:200})"; fi
done
# A database at 0009 (hub_08, with 0009), as 0009 made hub_08: a fresh install is at 10 since 0010, so 0009's undo starts
# from it, and 0010's refusals and undo are checked on copies of it.
sql -d postgres -c 'create database hub_09 template hub_08'
if ! quiet -d hub_09 -f supabase/migrations/0009_school_keys.sql >"$dir/load.log" 2>&1; then
  report "FAIL  migration 0009 applies to hub_09  ($(tail -n 1 "$dir/load.log"))"
fi
# Undo, as docs/v1.3-homework.md §16.9 says: 0006's school_rows again (its "create function private.school_rows(…)"
# block, to its "$$;", with create or replace) and hub_schema_version() returning 8. school_rows is then 0006's (as on a
# database at 0008, with the same grants), and 0009 runs again, leaving the functions as on a database at 0009.
sql -d postgres -c 'create database hub_set_back_8 template hub_09'
{ sed -n '/^create function private\.school_rows(p_kind text, p_items jsonb, p_rule text, p_shift int, p_today date)$/,/^\$\$;$/p' \
    supabase/migrations/0006_homework_school.sql | sed '1s/^create function/create or replace function/'
  echo "create or replace function public.hub_schema_version() returns int language sql immutable set search_path = '' as \$\$ select 8 \$\$;"
} >"$dir/undo_0009.sql"
rows_of() { quiet -d "$1" -A -t -c "select p.proname || ' ' || md5(p.prosrc) || ' ' || p.prosecdef || ' ' || p.provolatile::text || ' ' || array_to_string(p.proconfig, ',')
                                           || ' ' || has_function_privilege('anon', p.oid, 'execute') || ' ' || has_function_privilege('authenticated', p.oid, 'execute')
                                           || ' ' || has_function_privilege('service_role', p.oid, 'execute')
                                    from pg_proc p where p.oid = 'private.school_rows(text,jsonb,text,int,date)'::regprocedure"; }
undo=$(quiet -d hub_set_back_8 -f "$dir/undo_0009.sql" 2>&1)
got_undo="$(quiet -d hub_set_back_8 -A -t -c "select public.hub_schema_version()") $([[ -n $(rows_of hub_08) && $(rows_of hub_set_back_8) == "$(rows_of hub_08)" ]] && echo same-as-0008)"
out=$(quiet -d hub_set_back_8 -f supabase/migrations/0009_school_keys.sql 2>&1)
got_again="$(quiet -d hub_set_back_8 -A -t -c "select public.hub_schema_version()") $([[ $(catalog_of hub_set_back_8) == "$(catalog_of hub_09)" && -n $(rows_of hub_09) && $(rows_of hub_set_back_8) == "$(rows_of hub_09)" ]] && echo same-as-hub_09)"
if [[ $(wc -l <"$dir/undo_0009.sql") -gt 20 && -z $undo && $got_undo == "8 same-as-0008" && -z $out && $got_again == "9 same-as-hub_09" ]]; then
  report "PASS  migration 0009's undo: 0006's school_rows back, schema 8; then 0009 runs again, as on a database at 0009 (hub_09)"
else report "FAIL  migration 0009's undo  (undo: ${undo:0:150}; then: $got_undo; again: ${out:0:150} $got_again)"; fi
# The live database's shape (2026-10-31): on 0008, a kid's Assignments link read with 18 assignments whose UIDs all
# change at 19:23 and again at 21:23 UTC (the 20:23 read matched 19:23's), and her Schedule link with 285 classes
# whose UIDs change at 21:23, as hub-jobs stores them (school_begin, school_store, school_finish): 54 rows of
# assignments, three batches of 18, the first gone; 570 of classes, two batches. 0009 leaves 18 and 285, each on the
# school site and the batch seen last, and the next read, with new UIDs again, adds nothing and marks nothing missing.
sql -d postgres -c 'create database hub_08_live template hub_08'
prod_fns() { cat <<'SQL'
create function pg_temp.asg(p_batch text) returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('uid', p_batch || '-' || n || '@academy.school.example', 'title', 'Assignment ' || n, 'subject', 'Class ' || (n % 6 + 1),
                                      'first_day', date '2026-11-02' + n % 9, 'last_day', date '2026-11-02' + n % 9) order by n)
  from generate_series(1, 18) n
$$;
create function pg_temp.sched(p_batch text) returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('uid', p_batch || '-' || d || '-' || c || '@academy.school.example', 'title', 'Class ' || c,
                                      'starts_at', to_char((timestamptz '2026-11-02 13:00+00' + make_interval(days => d, mins => 30 * c)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                      'ends_at', to_char((timestamptz '2026-11-02 13:25+00' + make_interval(days => d, mins => 30 * c)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                   order by d, c)
  from generate_series(0, 18) d cross join generate_series(1, 15) c
$$;
-- One read of each link at p_now, as hub-jobs stores it; answers "added missing" for each.
create function pg_temp.reads(p_now text, p_asg text, p_sched text) returns text language plpgsql as $$
declare
  b jsonb;
  a jsonb;
  s jsonb;
begin
  perform set_config('hub.now', p_now, false);
  b := public.school_begin(true);
  a := public.school_store((b ->> 'run_id')::uuid, 'f0000000-0000-4000-8000-000000000001', pg_temp.asg(p_asg), null, 0);
  s := public.school_store((b ->> 'run_id')::uuid, 'f0000000-0000-4000-8000-000000000002', pg_temp.sched(p_sched), null, 0);
  perform public.school_finish((b ->> 'run_id')::uuid);
  return concat_ws(' ', a ->> 'added', a ->> 'missing', s ->> 'added', s ->> 'missing');
end;
$$;
SQL
}
live_state() { # the two links' rows, and the status card's first-import check, as Alex
  quiet -d hub_08_live -A -t <<'SQL'
set hub.now = '2026-10-31 21:30+00';
set request.jwt.claims = '{"role": "authenticated", "email": "alex@example.com"}';
select concat_ws(' ', (select count(*) from public.school_items where feed_id = 'f0000000-0000-4000-8000-000000000001'),
                      (select count(*) from public.school_items where feed_id = 'f0000000-0000-4000-8000-000000000001' and gone_at is null and missing = 0),
                      (select count(*) from public.school_items where feed_id = 'f0000000-0000-4000-8000-000000000002'),
                      (select string_agg(x ->> 'title', ',' order by n)
                       from jsonb_array_elements(public.school_feed_status((select id from public.people where name = 'Taylor')) -> 'check') with ordinality t (x, n)));
SQL
}
live_last() { # the ids of each link's batch first seen last (21:23)
  quiet -d hub_08_live -A -t -c "select string_agg(md5(ids), ' ') from (select string_agg(id::text, ',' order by id) as ids from public.school_items
                                 where first_seen_at = '2026-10-31 21:23+00' group by feed_id order by feed_id) x"
}
got_reads=$({ cat <<'SQL'
insert into public.people (name, role, sort_order) values ('Taylor', 'kid', 3);
insert into public.homework_kids (kid_id, active) select id, true from public.people where name = 'Taylor';
insert into public.school_feeds (id, kid_id, kind, host, url_end, next_at)
select f.id::uuid, p.id, f.kind, 'academy.school.example', f.url_end, '2026-10-31 18:00+00'
from (values ('f0000000-0000-4000-8000-000000000001', 'assignments', 'a1b2'), ('f0000000-0000-4000-8000-000000000002', 'schedule', 'c3d4')) f (id, kind, url_end)
cross join public.people p where p.name = 'Taylor';
insert into private.school_feed_urls (feed_id, url) values
  ('f0000000-0000-4000-8000-000000000001', 'https://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4T5y6a1b2'),
  ('f0000000-0000-4000-8000-000000000002', 'https://academy.school.example/podium/feed/iCal.aspx?z=S1s2S3s4S5s6c3d4');
SQL
  prod_fns
  cat <<'SQL'
select concat_ws(' | ', pg_temp.reads('2026-10-31 18:10+00', 'a', 's'), pg_temp.reads('2026-10-31 19:23+00', 'b', 's'),
                        pg_temp.reads('2026-10-31 20:23+00', 'b', 's'), pg_temp.reads('2026-10-31 21:23+00', 'c', 't'));
SQL
} | quiet -d hub_08_live -A -t 2>&1)
live_08=$(live_state)
last_08=$(live_last)
out=$(quiet -d hub_08_live -f supabase/migrations/0009_school_keys.sql 2>&1)
live_09=$(live_state)
last_09=$(quiet -d hub_08_live -A -t -c "select string_agg(md5(ids), ' ') from (select string_agg(id::text, ',' order by id) as ids from public.school_items group by feed_id order by feed_id) x")
rows_09=$(quiet -d hub_08_live -A -t -c "select count(*) filter (where has_uid) || ' ' || count(*) filter (where key <> md5(case when f.kind = 'assignments'
    then 'title:' || lower(coalesce(i.subject, '')) || E'\n' || lower(i.title) || '|' || to_char(i.first_day, 'YYYY-MM-DD')
    else 'title:' || lower(i.title) || '|' || to_char(i.starts_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') end))
  || ' ' || bool_and(i.first_seen_at = '2026-10-31 18:10+00') || ' ' || bool_and(i.last_seen_at = '2026-10-31 21:23+00')
  from public.school_items i join public.school_feeds f on f.id = i.feed_id")
next_09=$({ prod_fns; echo "select pg_temp.reads('2026-10-31 22:23+00', 'd', 'u');"; } | quiet -d hub_08_live -A -t 2>&1)
want_reads='18 0 285 0 | 18 18 0 0 | 0 18 0 0 | 18 18 285 285'
if [[ $got_reads == "$want_reads" && $live_08 == "54 18 570 Assignment 18,Assignment 18,Assignment 9,Assignment 9,Assignment 1" && -z $out
      && $live_09 == "18 18 285 Assignment 18,Assignment 9,Assignment 1,Assignment 10,Assignment 11" && -n $last_08 && $last_09 == "$last_08"
      && $rows_09 == "0 0 true true" && $next_09 == "0 0 0 0" ]]; then
  report "PASS  the live database's shape: on 0008, 54 rows of 18 assignments (the check two lines each of two) and 570 of 285 classes; 0009 leaves 18 and 285, the batch seen last, on their keys; the next read with new UIDs adds 0 and marks 0 missing"
else report "FAIL  the live database's shape  (reads: $got_reads; on 0008: $live_08; 0009: ${out:0:150}; on 0009: $live_09; rows: $rows_09; kept the last batch: $([[ $last_09 == "$last_08" ]] && echo yes || echo no); next read: $next_09)"; fi
# Same views: on a database at 0008 whose links were read the usual way, one row an item (the "same status card"
# household above, its items marked gone last seen before their link's last good read, as a read leaves them), 0009
# changes no answer: every person's status card, homework view and My day, byte for byte.
sql -d postgres -c 'create database hub_08_school template hub_07_school'
quiet -d hub_08_school -c "update public.school_items set last_seen_at = '2026-11-02 12:00+00' where gone_at is not null" >/dev/null
views() {
  quiet -d hub_08_school -A -t <<'SQL'
set hub.now = '2026-11-02 09:00 America/New_York';
select set_config('request.jwt.claims', '{"role": "authenticated", "email": "alex@example.com"}', false);
select p.name || ' = ' || coalesce(public.school_feed_status(p.id)::text, 'null') || ' | ' || coalesce(public.homework_by_token(p.day_token)::text, 'null')
       || ' | ' || coalesce(public.get_person_day(p.day_token)::text, 'null')
from public.people p order by p.name;
SQL
}
views_08=$(views)
out=$(quiet -d hub_08_school -f supabase/migrations/0009_school_keys.sql 2>&1)
views_09=$(views)
keys_09=$(quiet -d hub_08_school -A -t -c "select count(*) || ' ' || count(*) filter (where has_uid) from public.school_items")
if [[ -z $out && $views_08 == *'"moved_to": "2026-11-09"'* && $views_08 == *'"gone": true'* && $views_08 == *'"from_school": [{'* && $views_08 == *'"check": [{'*
      && $views_09 == "$views_08" && $keys_09 == "22 0" ]]; then
  report "PASS  same views: with no new UIDs, 0009 changes no status card, homework view or My day (only the keys, has_uid false on 22 rows)"
else report "FAIL  same views: with no new UIDs, 0009 changes no answer  (${out:0:150}; rows $keys_09; first difference: $(diff <(echo "$views_08") <(echo "$views_09") | head -n 3 | cut -c 1-300 | tr '\n' ' '))"; fi

# 0010 (Hearth people, docs/v1.1-google-calendar.md §11) refuses to run twice, on a v1 database, without 0009 (at
# 0008), on a database set back to 9, and on a database at 0009 that isn't as 0009 left it (half-applied hand edits
# included): each says why, and changes nothing.
m10=supabase/migrations/0010_hearth_people.sql
out=$(quiet -d hub_again -f $m10 2>&1)
if [[ $out == *"Hearth people (migration 0010) is already installed (hub_schema_version() is 10)"* ]] \
   && [[ $(quiet -d hub_again -A -t -c "select public.hub_schema_version()") == 10 ]]; then
  report "PASS  migration 0010 refuses to run twice"
else report "FAIL  migration 0010 refuses to run twice  (${out:0:200})"; fi
out=$(quiet -d hub_v1_again -f $m10 2>&1)
if [[ $out == *"Home Hub v2 (migration 0002) isn't installed. Run 0002 to 0009 first. Nothing was changed."* ]] \
   && [[ -z $(quiet -d hub_v1_again -A -t -c "select to_regclass('public.hearth_tags')") ]]; then
  report "PASS  migration 0010 refuses to run on a v1 database (0002 isn't installed), and changes nothing"
else report "FAIL  migration 0010 refuses to run on a v1 database  (${out:0:200})"; fi
sql -d postgres -c 'create database hub_08_again template hub_08'
before=$(catalog_of hub_08_again)
out=$(quiet -d hub_08_again -f $m10 2>&1)
if [[ $out == *"The school items' keys (migration 0009) aren't installed (hub_schema_version() is 8). Run 0009_school_keys.sql first. Nothing was changed."* ]] \
   && [[ $(catalog_of hub_08_again) == "$before" && $(quiet -d hub_08_again -A -t -c "select public.hub_schema_version() || ' ' || (to_regclass('public.hearth_tags') is null)") == "8 true" ]]; then
  report "PASS  migration 0010 refuses to run without 0009 (a database at 0008), and changes nothing"
else report "FAIL  migration 0010 refuses to run without 0009  (${out:0:200})"; fi
# Set back to 9 alone (not an undo, §11.9): the database still sorts while a switch is on. 0010 says so.
sql -d postgres -c 'create database hub_set_back_9 template hub'
quiet -d hub_set_back_9 -c "create or replace function public.hub_schema_version() returns int language sql immutable set search_path = '' as \$\$ select 9 \$\$" >/dev/null
before=$(catalog_of hub_set_back_9)
out=$(quiet -d hub_set_back_9 -f $m10 2>&1)
if [[ $out == *"Hearth people (migration 0010) is already installed, but hub_schema_version() was set back to 9. To switch it on again, make hub_schema_version() return 10 (docs/v1.1-google-calendar.md §11.9). Nothing was changed."* ]] \
   && [[ $(catalog_of hub_set_back_9) == "$before" && $(quiet -d hub_set_back_9 -A -t -c "select public.hub_schema_version()") == 9 ]]; then
  report "PASS  migration 0010 on a database set back to 9: says so (\"set back to 9\"), and changes nothing"
else report "FAIL  migration 0010 on a database set back to 9  (${out:0:200})"; fi
# ... and on copies of hub_09 not as 0009 left it: the new columns already there, calendar_read_due answering 9 columns,
# private.google_item missing, or one of 0010's functions already there.
n=0
for broken in 'alter table public.calendars add column sort_by_guest boolean not null default false' \
              "alter table public.google_events add column guests text[] not null default '{}'" \
              'drop function public.calendar_read_due(boolean, int); create function public.calendar_read_due(p_force boolean default false, p_limit int default 10) returns table (calendar_id uuid, google_id text, writes boolean, w_from date, w_to date, time_min timestamptz, time_max timestamptz, tz text, sort_by_guest boolean) language sql set search_path = '"''"' as $$ select null::uuid, null::text, null::boolean, null::date, null::date, null::timestamptz, null::timestamptz, null::text, null::boolean where false $$' \
              'drop function private.google_item(public.google_events, public.calendars)' \
              'create function public.set_hearth_tag(p_id uuid, p_to text, p_person uuid default null) returns jsonb language sql as $$ select null::jsonb $$' \
              'create function private.hearth_tag(p_email text) returns text language sql immutable as $$ select null::text $$'; do
  n=$((n + 1))
  sql -d postgres -c "create database hub_09_shape$n template hub_09"
  quiet -d "hub_09_shape$n" -c "$broken" >/dev/null
  before=$(catalog_of "hub_09_shape$n")
  cols=$(quiet -d "hub_09_shape$n" -A -t -c "select count(*) from pg_attribute where attrelid in ('public.calendars'::regclass, 'public.google_events'::regclass) and attnum > 0 and not attisdropped")
  out=$(quiet -d "hub_09_shape$n" -f $m10 2>&1)
  if [[ $out == *"This database isn't as migration 0009 left it. Nothing was changed."* ]] && [[ $(catalog_of "hub_09_shape$n") == "$before" ]] \
     && [[ $(quiet -d "hub_09_shape$n" -A -t -c "select public.hub_schema_version() || ' ' || (to_regclass('public.hearth_tags') is null) || ' ' || (select count(*) from pg_attribute where attrelid in ('public.calendars'::regclass, 'public.google_events'::regclass) and attnum > 0 and not attisdropped)") == "9 true $cols" ]]; then
    report "PASS  migration 0010 refuses a database at 0009 not as 0009 left it (${broken:0:90}), and changes nothing"
  else report "FAIL  migration 0010 refuses a database at 0009 not as 0009 left it (${broken:0:90})  (${out:0:200})"; fi
done

# 5g. Migration 0010 replaces google_item, google_for, calendars_tidy and calendar_store_events and makes
#     calendar_read_due again. With no calendar sorted, every answer must be 9's: calendar_fixtures.sql's household
#     at 0009 (hub_g09: the v1 database with 0002 to 0009, as hub_03 to hub_05 are made; hub_06_stamps' rows are dated by
#     the real clock), with Jordan's homework on and Pat's link with the coach view on, Google events read into five
#     calendars (two read-only Family ones, one with Show to kids) with Hearth-shaped and other guests sent for every
#     one, and a copy that gets 0010: both give the same digest_for, day_text, get_person_day, google_items,
#     homework_week, tutor view and coach view JSON for every person and the link over the 14 days around Nov 1;
#     again after a second read with guests on both; and again after, on the copy, Sort by Hearth person is turned on
#     for the read-only Family calendar, a read lists its tags, two are matched, and the switch goes off.
g_data() { cat <<'SQL'
set hub.now = '2026-10-27 09:00 America/New_York';
select set_config('request.jwt.claims', '{"role": "authenticated", "email": "alex@example.com"}', false);
insert into public.homework_kids (kid_id) select id from public.people where name = 'Jordan';
select public.add_homework_time((select id from public.people where name = 'Jordan'), '{1,2,3,4,5}', '16:00', '17:30');
insert into public.tutor_links (kid_id, token, label, expires_on, coach)
select id, 'ab000000000000000000000000000cd9', 'Pat Lee, tutor', '2027-05-01', true from public.people where name = 'Jordan';
insert into public.calendars (google_id, kind, label, writes, for_kids, status, access_role, google_name, read_at, checked_at)
values ('school@example.com', 'family', 'School', false, true, 'ok', 'reader', 'Example School', '2026-10-27 12:55+00', '2026-10-27 12:55+00');
select set_config('request.jwt.claims', '', false);
SQL
}
g_store() { # one read of every calendar, guests sent for every event ($1: 2 adds an event)
  cat <<SQL
set hub.now = '2026-10-27 09:0$1 America/New_York';
create function pg_temp.ev(p_id text, p_title text, p_start text, p_end text, p_extra jsonb default '{}') returns jsonb language sql immutable as \$\$
  select jsonb_build_object('id', p_id, 'status', 'confirmed', 'title', p_title,
                            'start', case when p_start ~ 'T' then jsonb_build_object('dateTime', p_start) else jsonb_build_object('date', p_start) end,
                            'end', case when p_end ~ 'T' then jsonb_build_object('dateTime', p_end) else jsonb_build_object('date', p_end) end,
                            'organizer_self', true, 'updated', '2026-10-26T12:00:00Z') || p_extra
\$\$;
create function pg_temp.store(p_label text, p_events jsonb) returns jsonb language sql as \$\$
  select public.calendar_store_events(c.id, c.google_id, public.today_local() - 1, public.today_local() + 60, coalesce(c.google_name, c.label),
                                      case when c.writes then 'writer' else 'reader' end, true, p_events, '[]')
  from public.calendars c where c.label = p_label
\$\$;
select pg_temp.store('Jordan', jsonb_build_array(
  pg_temp.ev('soccer1', 'Soccer', '2026-10-28T21:00:00Z', '2026-10-28T22:00:00Z', '{"guests": ["jordan@team-example-0000", "coach@example.com"]}')));
select pg_temp.store('Family account', jsonb_build_array(
  pg_temp.ev('piano1', 'Piano', '2026-10-28T20:30:00Z', '2026-10-28T21:15:00Z', '{"guests": ["jordan@team-example-0000"]}'),
  pg_temp.ev('visit1', 'Visit', '2026-10-30T20:00:00Z', '2026-10-30T20:30:00Z', '{"guests": ["familyanddogs@team-example-0000"]}'),
  pg_temp.ev('movie1', 'Movie', '2026-11-01T21:00:00Z', '2026-11-01T22:30:00Z', '{"guests": []}'),
  pg_temp.ev('private1', 'Orthodontist', '2026-11-02T21:00:00Z', '2026-11-02T21:30:00Z', '{"guests": ["jordan@team-example-0000"], "visibility": "private"}'),
  pg_temp.ev('trip1', 'Field trip', '2026-11-03', '2026-11-04', '{"guests": ["jordan@team-example-0000", "Sam@Team-Example-0000"]}'),
  pg_temp.ev('dinner1', 'Dinner', '2026-11-04T23:00:00Z', '2026-11-05T00:00:00Z', '{"guests": ["familyanddogs@team-example-0000", "taylor@team-example-0000", "morgan@example.com"]}'))
  || case when '$1' <> '0' then jsonb_build_array(pg_temp.ev('swim1', 'Swim', '2026-11-05T21:00:00Z', '2026-11-05T22:00:00Z', '{"guests": ["jordan@team-example-0000", "dogs@team-example-0000"]}'))
          else '[]' end);
select pg_temp.store('School', jsonb_build_array(pg_temp.ev('hol1', 'School holiday', '2026-10-29', '2026-10-30', '{"guests": ["jordan@team-example-0000"]}')));
select pg_temp.store('Dogs', jsonb_build_array(pg_temp.ev('vet1', 'Vet', '2026-10-29T14:00:00Z', '2026-10-29T15:00:00Z', '{"guests": ["dogs@team-example-0000"]}')));
select pg_temp.store('Taylor', jsonb_build_array(pg_temp.ev('dentista1', 'Dentista', '2026-10-30', '2026-10-31', '{"guests": ["taylor@team-example-0000"]}')));
SQL
}
same_g() { # one line per day (07:00 and 16:45), function and person or link, sorted
  quiet -d "$1" -A -t <<'SQL'
create temp table same_g (k text, v text);
do $$
declare
  d date;
  t text;
  tok text := 'ab000000000000000000000000000cd9';
  kid uuid := (select id from public.people where name = 'Jordan');
begin
  for d in select g::date from generate_series(date '2026-10-25', date '2026-11-07', interval '1 day') g loop
    foreach t in array array['07:00', '16:45'] loop
      perform set_config('hub.now', to_char(d, 'YYYY-MM-DD') || ' ' || t || ' America/New_York', false);
      insert into same_g
      select d || ' ' || t || ' ' || p.name || ' ' || f, v
      from public.people p
      cross join lateral (
        select 'digest_for', public.digest_for(p.id, d)::text
        union all select 'day_text', public.day_text(p.id, d)
        union all select 'get_person_day', public.get_person_day(p.day_token)::text) x (f, v);
      insert into same_g values
        (d || ' ' || t || ' google_items', (select string_agg(g::text, ' | ' order by g.day, g.local_start, g.title, g.item_id) from public.google_items(d, d) g)),
        (d || ' ' || t || ' homework_week', public.homework_week(kid, d, 1)::text),
        (d || ' ' || t || ' tutor_view_by_token', public.tutor_view_by_token(tok)::text),
        (d || ' ' || t || ' coach_view_by_token', public.coach_view_by_token(tok)::text);
    end loop;
  end loop;
end;
$$;
select k || ' = ' || coalesce(v, 'null') from same_g order by k;
SQL
}
sql -d postgres -c 'create database hub_g09 template hub_v1'
ok=1
for m in supabase/migrations/*.sql; do
  [[ $(basename "$m") < 0010 ]] || continue
  if ! quiet -d hub_g09 -f "$m" >"$dir/load.log" 2>&1; then report "FAIL  5g: migration $(basename "$m") applies  ($(tail -n 1 "$dir/load.log"))"; ok=0; fi
done
quiet -d hub_g09 -f tests/db/lib.sql >/dev/null
if ! (cd tests/db && quiet -d hub_g09 -f roles.sql -f calendar_fixtures.sql) >"$dir/load.log" 2>&1 \
   || ! { g_data; g_store 0; } | quiet -d hub_g09 >"$dir/load.log" 2>&1; then
  report "FAIL  5g: loading the household  ($(grep -m 1 ERROR "$dir/load.log" || tail -n 1 "$dir/load.log"))"; ok=0
fi
sql -d postgres -c 'create database hub_g10 template hub_g09'
if ! quiet -d hub_g10 -f $m10 >"$dir/load.log" 2>&1; then report "FAIL  5g: migration 0010 applies to a database with calendars  ($(tail -n 1 "$dir/load.log"))"; ok=0; fi
same_g hub_g09 >"$dir/g09_1.txt" 2>&1
same_g hub_g10 >"$dir/g10_1.txt" 2>&1
g_store 2 | quiet -d hub_g09 >/dev/null 2>&1
g_store 2 | quiet -d hub_g10 >/dev/null 2>&1
same_g hub_g09 >"$dir/g09_2.txt" 2>&1
same_g hub_g10 >"$dir/g10_2.txt" 2>&1
# The switch on and off on the copy, with a read in between that lists the tags, and two matches.
toggled=$({ cat <<'SQL'
set hub.now = '2026-10-27 09:03 America/New_York';
select set_config('request.jwt.claims', '{"role": "authenticated", "email": "alex@example.com"}', false);
update public.calendars set sort_by_guest = true where label = 'Family account';
SQL
  g_store 2 | sed '1d'
  cat <<'SQL'
select public.set_hearth_tag((select id from public.hearth_tags where name = 'jordan'), 'person', (select id from public.people where name = 'Jordan'));
select public.set_hearth_tag((select id from public.hearth_tags where name = 'familyanddogs'), 'family');
select count(*) || ' ' || (select count(*) from public.google_events where guests <> '{}') || ' ' || (select count(*) from public.calendar_read_due()) from public.hearth_tags;
update public.calendars set sort_by_guest = false where label = 'Family account';
SQL
} | quiet -d hub_g10 -A -t 2>&1 | tail -n 1)
same_g hub_g10 >"$dir/g10_3.txt" 2>&1
rows=$(grep -c ' = ' "$dir/g09_1.txt")
if [[ $ok -eq 1 && $rows -gt 300 && $toggled == "5 6 0" ]] && grep -q 'Soccer' "$dir/g09_1.txt" && grep -q '"busy": \[{' "$dir/g09_1.txt" && grep -q 'Swim' "$dir/g09_2.txt" \
   && ! grep -q 'coach_view_by_token = null' "$dir/g09_1.txt" \
   && cmp -s "$dir/g09_1.txt" "$dir/g10_1.txt" && cmp -s "$dir/g09_2.txt" "$dir/g10_2.txt" && cmp -s "$dir/g09_2.txt" "$dir/g10_3.txt"; then
  report "PASS  5g: with no calendar sorted, 0010 leaves digest_for, day_text, get_person_day, google_items, homework_week and the tutor and coach views as 0009 made them, guests sent for every calendar, and after the switch on and off ($rows results)"
else
  report "FAIL  5g: with no calendar sorted, 0010 leaves every answer as 0009's  ($rows results; toggled: $toggled; first difference: $(diff "$dir/g09_1.txt" "$dir/g10_1.txt" | head -n 3 | cut -c 1-300 | tr '\n' ' ') $(diff "$dir/g09_2.txt" "$dir/g10_2.txt" | head -n 3 | cut -c 1-300 | tr '\n' ' ') $(diff "$dir/g09_2.txt" "$dir/g10_3.txt" | head -n 3 | cut -c 1-300 | tr '\n' ' '))"
fi

# Undo, as docs/v1.1-google-calendar.md §11.9 and 0010's header say: every switch off; 0003's google_item, google_for,
# calendars_tidy and calendar_store_events blocks again (create or replace); calendar_read_due dropped and made again from
# 0003's block, with 0003's revoke and grant; 0010's three functions, hearth_tags and the two columns dropped;
# hub_schema_version() returning 9. On a copy of a fresh install: the replaced functions are then 9's (hub_09's, grants
# and all), every other function is too (hub_schema_version aside, whose text the undo writes), and the tables' columns;
# and 0010 runs again, leaving the functions and columns as on a fresh install. On a copy of 5g's hub_g10 (its tags
# listed and matched, the guests cached): every answer is 9's (hub_g09's), also after one more read with guests (0003's
# calendar_store_events storing into google_events with its dropped column), and again after 0010 runs again.
sql -d postgres -c 'create database hub_undo_10 template hub'
{ echo "update public.calendars set sort_by_guest = false;"
  for f in 'private\.google_item(g public\.google_events, c public\.calendars)' 'private\.google_for(p_person uuid, p_from date, p_to date, p_grown_up boolean)' \
           'private\.calendars_tidy()' 'public\.calendar_store_events(p_calendar uuid, p_google_id text, p_from date, p_to date, p_name text,'; do
    sed -n "/^create function $f/,/^\\$\\$;\$/p" supabase/migrations/0003_google_calendar.sql | sed '1s/^create function/create or replace function/'
  done
  echo "drop function public.calendar_read_due(boolean, int);"
  sed -n '/^create function public\.calendar_read_due(p_force boolean default false, p_limit int default 10)$/,/^\$\$;$/p' supabase/migrations/0003_google_calendar.sql
  grep -E '^(revoke|grant) +execute on function public\.calendar_read_due\(boolean, int\)' supabase/migrations/0003_google_calendar.sql
  echo "drop function public.set_hearth_tag(uuid, text, uuid);"
  echo "drop function private.hearth_whose(public.google_events, public.calendars);"
  echo "drop function private.hearth_tag(text);"
  echo "drop table public.hearth_tags;"
  echo "alter table public.google_events drop column guests;"
  echo "alter table public.calendars drop column sort_by_guest;"
  echo "create or replace function public.hub_schema_version() returns int language sql immutable set search_path = '' as \$\$ select 9 \$\$;"
} >"$dir/undo_0010.sql"
fns_10() { quiet -d "$1" -A -t -c "select string_agg(p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || p.prosecdef || ' ' || p.provolatile::text || ' ' || array_to_string(p.proconfig, ',')
                                           || ' ' || has_function_privilege('anon', p.oid, 'execute') || ' ' || has_function_privilege('authenticated', p.oid, 'execute')
                                           || ' ' || has_function_privilege('service_role', p.oid, 'execute'), ' | ' order by p.oid::regprocedure::text)
                                    from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                                      and p.proname in ('google_item', 'google_for', 'calendars_tidy', 'calendar_store_events', 'calendar_read_due')"; }
others_10() { quiet -d "$1" -A -t -c "select count(*) || ' ' || md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc), ',' order by p.oid::regprocedure::text)) from pg_proc p
                                      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.proname <> 'hub_schema_version'"; }
shape_10() { quiet -d "$1" -A -t -c "select string_agg(c.relname || '.' || a.attname, ',' order by c.relname, a.attname) from pg_attribute a join pg_class c on c.oid = a.attrelid
                                     where c.relname in ('calendars', 'google_events', 'hearth_tags') and c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped"; }
undo=$(quiet -d hub_undo_10 -f "$dir/undo_0010.sql" 2>&1)
got_undo="$(quiet -d hub_undo_10 -A -t -c "select public.hub_schema_version()") $([[ -n $(fns_10 hub_09) && $(fns_10 hub_undo_10) == "$(fns_10 hub_09)" && $(others_10 hub_undo_10) == "$(others_10 hub_09)" && $(shape_10 hub_undo_10) == "$(shape_10 hub_09)" ]] && echo same-as-0009)"
out=$(quiet -d hub_undo_10 -f $m10 2>&1)
got_again="$(quiet -d hub_undo_10 -A -t -c "select public.hub_schema_version()") $([[ $(catalog_of hub_undo_10) == "$(catalog_of hub)" && -n $(fns_10 hub) && $(fns_10 hub_undo_10) == "$(fns_10 hub)" && $(shape_10 hub_undo_10) == "$(shape_10 hub)" ]] && echo same-as-fresh)"
sql -d postgres -c 'create database hub_undo_10g template hub_g10'
sql -d postgres -c 'create database hub_g09_again template hub_g09'
undo_g=$(quiet -d hub_undo_10g -f "$dir/undo_0010.sql" 2>&1)
same_g hub_undo_10g >"$dir/gu_1.txt" 2>&1
g_store 3 | quiet -d hub_undo_10g >/dev/null 2>&1
g_store 3 | quiet -d hub_g09_again >/dev/null 2>&1
same_g hub_undo_10g >"$dir/gu_2.txt" 2>&1
same_g hub_g09_again >"$dir/g09_3.txt" 2>&1
again_g=$(quiet -d hub_undo_10g -f $m10 2>&1)
same_g hub_undo_10g >"$dir/gu_3.txt" 2>&1
if [[ $(wc -l <"$dir/undo_0010.sql") -gt 200 && -z $undo && $got_undo == "9 same-as-0009" && -z $out && $got_again == "10 same-as-fresh" && -z $undo_g && -z $again_g ]] \
   && grep -q ' = ' "$dir/gu_1.txt" && cmp -s "$dir/g09_2.txt" "$dir/gu_1.txt" && cmp -s "$dir/g09_3.txt" "$dir/gu_2.txt" && cmp -s "$dir/g09_3.txt" "$dir/gu_3.txt"; then
  report "PASS  migration 0010's undo: 0003's functions back, the new table, columns and functions gone, schema 9, every answer as on 9; then 0010 runs again, as on a fresh install"
else report "FAIL  migration 0010's undo  (undo: ${undo:0:150} ${undo_g:0:150}; then: $got_undo; 5g: $(diff "$dir/g09_2.txt" "$dir/gu_1.txt" | head -n 2 | cut -c 1-200 | tr '\n' ' ') $(diff "$dir/g09_3.txt" "$dir/gu_2.txt" | head -n 2 | cut -c 1-200 | tr '\n' ' '); again: ${out:0:150} ${again_g:0:150} $got_again)"; fi

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
    report "PASS  same output: with homework on, no school link and the coach view off, 0006 and 0007 leave get_person_day, his view and Pat's as 0005 made them ($rows results)"
  else
    report "FAIL  same output: with homework on, no school link and the coach view off, 0006 and 0007 leave get_person_day, his view and Pat's as 0005 made them  ($rows results; first difference: $(diff "$dir/same_hw_05.txt" "$dir/same_hw_06.txt" | head -n 3 | cut -c 1-400 | tr '\n' ' '))"
  fi

  # 5f. Migration 0007 replaces the wrapper of Pat's view (private.homework_view_tutor) to add one key, coach:
  #     true, for a link with the coach view on. 0007 leaves it off on every link, so 5e above holds with 0007
  #     applied; and on hub_05_later, turning it on for Pat's link adds exactly that key to his list and his
  #     assignment's answer, and her homework view's me gains coach: "Pat" (0007 replaces its wrapper too, so her
  #     screen can say who sees her points); nothing else changes: not the AI poll, not anyone's My day.
  got=$(quiet -d hub_05_later -A -t <<'SQL' 2>&1
set hub.now = '2026-11-03 16:40 America/New_York';
create temp table before as
select public.tutor_view_by_token('ab000000000000000000000000000cd1') as l,
       public.tutor_view_by_token('ab000000000000000000000000000cd1', 'a0000000-0000-4000-8000-000000000005') as a,
       public.tutor_view_by_token('ab000000000000000000000000000cd1', 'a0000000-0000-4000-8000-000000000005', 'ai') as ai,
       public.homework_by_token((select p.day_token from public.people p where p.name = 'Taylor')) as h,
       (select jsonb_agg(public.get_person_day(p.day_token) order by p.name) from public.people p) as d,
       public.coach_view_by_token('ab000000000000000000000000000cd1') as c;
update public.tutor_links set coach = true;
select concat_ws(' ',
  b.c is null,
  public.tutor_view_by_token('ab000000000000000000000000000cd1') = b.l || '{"coach": true}',
  public.tutor_view_by_token('ab000000000000000000000000000cd1', 'a0000000-0000-4000-8000-000000000005') = b.a || '{"coach": true}',
  public.tutor_view_by_token('ab000000000000000000000000000cd1', 'a0000000-0000-4000-8000-000000000005', 'ai') = b.ai,
  public.homework_by_token((select p.day_token from public.people p where p.name = 'Taylor')) = jsonb_set(b.h, '{me,coach}', '"Pat"'),
  (select jsonb_agg(public.get_person_day(p.day_token) order by p.name) from public.people p) = b.d,
  public.coach_view_by_token('ab000000000000000000000000000cd1') ->> 'kid')
from before b;
SQL
)
  if [[ $got == "t t t t t t Taylor" ]]; then
    report "PASS  same output: the coach view on for Pat's link adds only coach: true to his view and the coach's name to hers, and changes nothing else"
  else report "FAIL  same output: the coach view on for Pat's link adds only coach: true to his view  (${got:0:300})"; fi
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
