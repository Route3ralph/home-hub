#!/usr/bin/env bash
# Database tests. Starts a throwaway Postgres, loads the Supabase stand-ins, supabase/schema.sql,
# a v1-era household (v1_data.sql) and supabase/migrations/*.sql in order, then runs each
# tests/db/*.test.sql against its own fresh copy of that database.
# Prints one "PASS  name" or "FAIL  name  (detail)" line per check, then the totals,
# and exits non-zero if anything failed.
# Needs the PostgreSQL 16 server binaries (PG_BIN overrides where they are). initdb refuses to
# run as root, so as root the throwaway server runs as the postgres user.
#
# A test file starts with "\ir roles.sql" (and "\ir fixtures.sql" for the shared v2 household),
# switches who it runs as with lines like ":as_admin" or ":as_anon", pins the clock with
# "set hub.now = '…'", and checks with test.is, test.ok, test.throws and test.matrix (lib.sql).
set -u
cd "$(dirname "$0")/../.."
# Sessions run in UTC, as on Supabase, so timestamps print the same on any machine.
export PGTZ=UTC

PG_BIN=${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1)}
if [[ -z $PG_BIN || ! -x $PG_BIN/initdb ]]; then
  echo "FAIL  database tests: PostgreSQL server binaries not found (set PG_BIN)"
  exit 1
fi

as_owner() { if [[ $(id -u) -eq 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }

dir=$(mktemp -d)
[[ $(id -u) -eq 0 ]] && chown postgres "$dir"
cleanup() {
  as_owner "$PG_BIN/pg_ctl" -D "$dir/data" -m immediate stop >/dev/null 2>&1
  rm -rf "$dir"
}
trap cleanup EXIT

# The server listens only on a socket in $dir; the port just has to be one nobody else is using.
port=$((50000 + RANDOM % 10000))
while (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do port=$((port + 1)); done

as_owner "$PG_BIN/initdb" -D "$dir/data" -U postgres -A trust --no-sync >"$dir/initdb.log" 2>&1 \
  || { echo "FAIL  database tests: initdb failed"; cat "$dir/initdb.log"; exit 1; }
as_owner "$PG_BIN/pg_ctl" -D "$dir/data" -l "$dir/server.log" -w \
  -o "-p $port -k $dir -c listen_addresses='' -c fsync=off" start >/dev/null \
  || { echo "FAIL  database tests: Postgres didn't start"; cat "$dir/server.log"; exit 1; }

sql() { "$PG_BIN/psql" -h "$dir" -p "$port" -U postgres -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse "$@"; }
quiet() { PGOPTIONS='-c client_min_messages=warning' sql "$@"; }

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

# 5. Each test file gets a fresh copy, with the helpers in schema "test".
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
