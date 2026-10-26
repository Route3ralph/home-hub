#!/usr/bin/env bash
# Database tests. Starts a throwaway Postgres, loads the Supabase stand-ins, supabase/schema.sql,
# a v1-era household (v1_data.sql) and supabase/migrations/*.sql in order, then runs each
# tests/db/*.test.sql against its own fresh copy of that database.
# Before that: preflight.sql's checks, each migration's refusal to run twice (or too early), and
# that migration 0003 leaves the email, day_text and My day exactly as 0002 made them while no
# Google calendar is set up (same_output.sql).
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

# The database with migration 0002 only, as it is live before 0003 (steps 5 and 5b).
sql -d postgres -c 'create database hub_02 template hub_v1'
if ! quiet -d hub_02 -f supabase/migrations/0002_home_hub_v2.sql >"$dir/load.log" 2>&1; then
  report "FAIL  migration 0002 applies to hub_02  ($(tail -n 1 "$dir/load.log"))"; exit 1
fi

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
fi

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
