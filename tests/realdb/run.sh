#!/usr/bin/env bash
# The real-database suite: the site in Chromium against a real Postgres with supabase/schema.sql,
# the migrations, row-level security and every function, served by tests/realdb/server.js (a
# stand-in for PostgREST and Supabase Auth that runs each request as anon or authenticated with the
# JWT's claims, like Supabase). The browser tests in tests/e2e use JavaScript fakes of the database;
# this suite checks the same flows against the real SQL, so the fakes can't drift unnoticed.
#
# 1. Starts a throwaway cluster (tests/db/cluster.sh).
# 2. Builds the template database "realdb_t": the Supabase stand-ins, schema.sql, a v1-era household
#    (seed_v1.sql), supabase/migrations/*.sql in order, then the v2 household (seed_v2.sql);
#    "realdb_v1t", the v1 database as it is live before v2 (no migrations); "realdb_v2t", the v2
#    database before v1.1 (migration 0002 only, then seed_v2.sql); and "realdb_v3t", the database as
#    it is live before v1.2 (migrations 0002 and 0003, then seed_v2.sql).
# 3. Exports the older site versions for the v1-on-v2 checks, into tests/.tmp/: b980d4c (the v1 site
#    that is live until the v2 deploy: main before v2) and bcf296a (the core/module split, PR A). Fixed
#    commits, not a branch: once v2 is merged, main is the v2 site. A commit git can't find (a shallow
#    clone, or a squash-merged branch) is reported and its checks are skipped.
# 4. Runs every tests/realdb/*.test.js. Each one makes its own copy of the template and its own
#    server (lib.js), so the files don't share state.
#
# Prints "PASS  name" / "FAIL  name  (detail)" lines like the other suites, then the totals, and
# exits non-zero if anything failed. Needs Node 22, Playwright with Chromium and PostgreSQL 16.
# Usage: bash tests/realdb/run.sh                 every file
#        bash tests/realdb/run.sh flows           only tests/realdb/flows.test.js
set -u
cd "$(dirname "$0")/../.."
source tests/db/cluster.sh

if ! sql -d postgres -c 'create database realdb_t' >/dev/null; then echo "FAIL  realdb: create the template database"; exit 1; fi
load() { # file [psql args...]
  local f=$1; shift
  if ! quiet -d realdb_t "$@" -f "$f" >"$dir/load.log" 2>&1; then
    echo "FAIL  realdb: load $f  ($(tail -n 1 "$dir/load.log"))"; exit 1
  fi
}
load tests/db/standins.sql
load supabase/schema.sql
load tests/realdb/seed_v1.sql -v kitchen="$(cat supabase/kitchen-renovation.json)"
for m in supabase/migrations/*.sql; do load "$m"; done
load tests/realdb/seed_v2.sql

# The live v1 database as it is today (no migrations), for the new site in v1 mode (deploy step 2).
if ! sql -d postgres -c 'create database realdb_v1t' >/dev/null; then echo "FAIL  realdb: create the v1 template database"; exit 1; fi
for f in tests/db/standins.sql supabase/schema.sql; do
  if ! quiet -d realdb_v1t -f "$f" >"$dir/load.log" 2>&1; then echo "FAIL  realdb: load $f into the v1 database  ($(tail -n 1 "$dir/load.log"))"; exit 1; fi
done
if ! quiet -d realdb_v1t -v kitchen="$(cat supabase/kitchen-renovation.json)" -f tests/realdb/seed_v1.sql >"$dir/load.log" 2>&1; then
  echo "FAIL  realdb: load seed_v1.sql into the v1 database  ($(tail -n 1 "$dir/load.log"))"; exit 1
fi

# The v2 database before v1.1 (migration 0002 only, then the v2 household): the new site and hub-jobs
# go live before migration 0003 is applied (docs/v1.1-google-calendar.md §8.3), so they must work on it.
if ! sql -d postgres -c 'create database realdb_v2t' >/dev/null; then echo "FAIL  realdb: create the v2 template database"; exit 1; fi
for f in tests/db/standins.sql supabase/schema.sql tests/realdb/seed_v1.sql supabase/migrations/0002_home_hub_v2.sql tests/realdb/seed_v2.sql; do
  if ! quiet -d realdb_v2t -v kitchen="$(cat supabase/kitchen-renovation.json)" -f "$f" >"$dir/load.log" 2>&1; then
    echo "FAIL  realdb: load $f into the v2 database  ($(tail -n 1 "$dir/load.log"))"; exit 1
  fi
done

# The database before v1.2 (migrations 0002 and 0003, then the v2 household), as it is live: the new
# site goes live before migration 0004 is applied (docs/v1.2-kitchen.md §15), so it must work on it,
# and jobs.test.js applies 0004 to a copy of it after hub-jobs has run there.
if ! sql -d postgres -c 'create database realdb_v3t' >/dev/null; then echo "FAIL  realdb: create the v3 template database"; exit 1; fi
for f in tests/db/standins.sql supabase/schema.sql tests/realdb/seed_v1.sql supabase/migrations/0002_home_hub_v2.sql \
         supabase/migrations/0003_google_calendar.sql tests/realdb/seed_v2.sql; do
  if ! quiet -d realdb_v3t -v kitchen="$(cat supabase/kitchen-renovation.json)" -f "$f" >"$dir/load.log" 2>&1; then
    echo "FAIL  realdb: load $f into the v3 database  ($(tail -n 1 "$dir/load.log"))"; exit 1
  fi
done

# The older sites, for the v1-on-v2 checks.
mkdir -p tests/.tmp
export REALDB_V1_ROOT="" REALDB_V1A_ROOT=""
for pair in "b980d4c:realdb-v1:REALDB_V1_ROOT" "bcf296a:realdb-v1a:REALDB_V1A_ROOT"; do
  IFS=: read -r ref name var <<<"$pair"
  out="tests/.tmp/$name"
  rm -rf "$out"
  mkdir -p "$out"
  if git cat-file -e "$ref^{commit}" 2>/dev/null && git archive "$ref" | tar -x -C "$out"; then
    export "$var=$PWD/$out"
    # Both are sites from before v2: no v2 page modules.
    if [[ -e $out/assets/modules/today.js ]]; then echo "FAIL  realdb: $ref is meant to be a site from before v2, but it has the v2 pages"; exit 1; fi
  else echo "SKIP  realdb: git commit $ref isn't in this clone, so its v1-on-v2 checks are skipped"; rm -rf "$out"; fi
done

export REALDB_SOCKET="$dir" REALDB_PORT="$port" REALDB_TEMPLATE=realdb_t REALDB_V1_TEMPLATE=realdb_v1t REALDB_V2_TEMPLATE=realdb_v2t REALDB_V3_TEMPLATE=realdb_v3t REALDB_PG_BIN="$PG_BIN"
status=0
files=()
if [[ $# -gt 0 ]]; then for n in "$@"; do files+=("tests/realdb/$n.test.js"); done
else files=(tests/realdb/*.test.js); fi
for t in "${files[@]}"; do
  echo "-- $t"
  node --experimental-strip-types --disable-warning=ExperimentalWarning "$t" || status=1
done
exit $status
