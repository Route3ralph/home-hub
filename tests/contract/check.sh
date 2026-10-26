#!/usr/bin/env bash
# Contract check: every database call the site makes exists in the migrated schema.
# Builds a throwaway Postgres with schema.sql and supabase/migrations/*.sql (tests/db/cluster.sh),
# reads its catalog (catalog.sql), and runs check.js, which finds each sb.rpc('f', {args}),
# core.v2.call('f', {args}) and .from('t') in assets/**/*.js, the pages' inline scripts and
# supabase/functions/**/*.ts, and checks the function or table exists with those argument
# names and that whoever makes the call (signed out, signed in, Edge Function) may use it.
# Usage: bash tests/contract/check.sh            the site's files
#        bash tests/contract/check.sh FILE...    only these files
# Prints one "PASS  …" or "FAIL  …  (detail)" line per distinct call, then the totals, and
# exits non-zero if anything failed. Needs Node and the PostgreSQL 16 server binaries.
set -u
here=$PWD
files=()
for f in "$@"; do [[ $f == /* ]] && files+=("$f") || files+=("$here/$f"); done
cd "$(dirname "$0")/../.."
source tests/db/cluster.sh

load_v2 contract || exit 1
if ! quiet -d contract -A -t -f tests/contract/catalog.sql >"$dir/catalog.json" 2>"$dir/catalog.log"; then
  echo "FAIL  contract: reading the database catalog failed  ($(tail -n 1 "$dir/catalog.log"))"
  exit 1
fi
node tests/contract/check.js "$dir/catalog.json" "${files[@]+"${files[@]}"}"
status=$?
exit $status
