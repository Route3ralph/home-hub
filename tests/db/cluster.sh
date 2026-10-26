# A throwaway Postgres for the database tests and the contract check. Source it from a
# script that has already cd'd to the repository root:   source tests/db/cluster.sh
# It starts a server that listens only on a socket in a temp dir, and removes it all on exit.
# Afterwards these are set:
#   PG_BIN   the PostgreSQL 16 server binaries (set PG_BIN to override)
#   dir      the temp dir (the socket, server.log, scratch files)
#   port     the server's port
#   sql      psql as postgres, stopping at the first error:  sql -d hub -f file.sql
#   quiet    the same, without NOTICEs
#   load_v2  creates a database with the Supabase stand-ins, schema.sql and migrations/*.sql:
#            load_v2 <name>   (prints a FAIL line and returns non-zero if anything fails)
# initdb refuses to run as root, so as root the server runs as the postgres user.

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

load_v2() {
  local db=$1 m
  sql -d postgres -c "create database \"$db\"" >/dev/null || return 1
  if ! quiet -d "$db" -f tests/db/standins.sql -f supabase/schema.sql >"$dir/load.log" 2>&1; then
    echo "FAIL  load schema.sql  ($(tail -n 1 "$dir/load.log"))"; return 1
  fi
  for m in supabase/migrations/*.sql; do
    if ! quiet -d "$db" -f "$m" >"$dir/load.log" 2>&1; then
      echo "FAIL  migration $(basename "$m") applies  ($(tail -n 1 "$dir/load.log"))"; return 1
    fi
  done
}
