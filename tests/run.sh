#!/usr/bin/env bash
# Runs every test suite, prints the totals, and exits non-zero if anything failed.
#   tests/db/run.sh          database rules and functions in a throwaway Postgres (when present)
#   tests/contract/check.sh  every database call the site makes exists in the migrated schema (when present)
#   tests/fn/*.test.ts       Edge Function handlers (Node, type stripping)
#   tests/e2e/*.test.js      the site in Chromium against a mocked Supabase (Playwright)
#   tests/realdb/run.sh      the site in Chromium against the real schema, migrations and functions
#                            in a throwaway Postgres (about 1.5 minutes)
#   tests/docs/*.test.js     the docs (CLAUDE.md, README.md, docs/v2-design.md) say what the code does
# Each suite prints one "PASS  name" or "FAIL  name" line per check and exits non-zero on failure.
# Usage: tests/run.sh                 all suites
#        tests/run.sh fn e2e          only the suites named (db, contract, fn, e2e, realdb, docs)
set -u
cd "$(dirname "$0")/.."

suites=("$@")
[[ ${#suites[@]} -eq 0 ]] && suites=(db contract fn e2e realdb docs)
pass=0
fail=0
broken=()
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

run() { # label, command...
  local label=$1 status p f
  shift
  echo "== $label"
  "$@" 2>&1 | tee "$tmp"
  status=${PIPESTATUS[0]}
  p=$(grep -c '^PASS' "$tmp" || true)
  f=$(grep -c '^FAIL' "$tmp" || true)
  pass=$((pass + p))
  fail=$((fail + f))
  # A suite that crashed, or failed without printing a FAIL line (e.g. page errors), still fails the run.
  if [[ $status -ne 0 && $f -eq 0 ]]; then broken+=("$label exited with status $status"); fi
  echo "-- $label: $p passed, $f failed"
  echo
}

for suite in "${suites[@]}"; do
  case $suite in
    db)
      if [[ -f tests/db/run.sh ]]; then run tests/db/run.sh bash tests/db/run.sh
      else echo "== tests/db/run.sh not found: database tests skipped"; echo; fi ;;
    contract)
      if [[ -f tests/contract/check.sh ]]; then run tests/contract/check.sh bash tests/contract/check.sh
      else echo "== tests/contract/check.sh not found: contract check skipped"; echo; fi ;;
    fn)
      for t in tests/fn/*.test.ts; do
        [[ -e $t ]] && run "$t" node --experimental-strip-types --disable-warning=ExperimentalWarning "$t"
      done ;;
    e2e)
      for t in tests/e2e/*.test.js; do
        [[ -e $t ]] && run "$t" node "$t"
      done ;;
    realdb)
      if [[ -f tests/realdb/run.sh ]]; then run tests/realdb/run.sh bash tests/realdb/run.sh
      else echo "== tests/realdb/run.sh not found: real-database tests skipped"; echo; fi ;;
    docs)
      for t in tests/docs/*.test.js; do
        [[ -e $t ]] && run "$t" node "$t"
      done ;;
    *)
      echo "Unknown suite \"$suite\". Use db, contract, fn, e2e, realdb or docs." >&2
      exit 2 ;;
  esac
done

echo "== Totals: $pass passed, $fail failed"
for b in "${broken[@]+"${broken[@]}"}"; do echo "!! $b"; done
if [[ $fail -gt 0 || ${#broken[@]} -gt 0 ]]; then exit 1; fi
