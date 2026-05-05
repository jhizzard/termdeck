#!/usr/bin/env bash
# scripts/test-supabase-reset.sh
#
# Sprint 58 — reset the shared test Supabase project schema between fixture
# runs. Strategy B (advisory lock + truncate) per docs/INSTALL-FIXTURES.md.
#
# Required env:
#   TEST_DATABASE_URL   Postgres connection string for the test project.
#                       MUST NOT point at any developer's daily-driver project.
#                       The script refuses to truncate unless the target DB
#                       has the `_termdeck_test_canary` row installed by the
#                       Task 3.1 setup runbook (see docs/INSTALL-FIXTURES.md
#                       § Test Supabase project runbook).
#
# Optional flags:
#   --dry-run           Print the SQL without executing it.
#   --skip-canary       Skip the canary precheck (CAUTION: only for one-time
#                       setup, before the canary row exists; never for CI).
#   -h | --help         Print the header block.
#
# Exit codes:
#   0   reset complete (or dry-run printed)
#   2   missing required env or invalid arg
#   3   canary precheck failed (refusing to truncate non-test DB)
#   4   psql failed
#
# Concurrency: the reset runs inside a single transaction that calls
# pg_advisory_xact_lock(58). Concurrent invocations serialize on that lock
# and auto-release at COMMIT. Primary serialization for full test runs is
# the workflow-level `concurrency: { group: test-supabase-shared }` (see
# docs/INSTALL-FIXTURES.md § Concurrency); this advisory lock is
# defense-in-depth.

set -euo pipefail

LOCK_KEY=58
DRY_RUN=0
SKIP_CANARY=0

usage() {
  sed -n '2,33p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY_RUN=1 ;;
    --skip-canary) SKIP_CANARY=1 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "[reset] FATAL: unknown arg '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

DATABASE_URL="${TEST_DATABASE_URL:-}"
if [ -z "${DATABASE_URL}" ]; then
  echo "[reset] FATAL: TEST_DATABASE_URL is required." >&2
  echo "[reset]        We do NOT fall back to a generic DATABASE_URL because that" >&2
  echo "[reset]        typically points at a developer's daily-driver project." >&2
  exit 2
fi

stamp() { date '+%H:%M:%S %Z'; }

# Pre-flight: confirm the target DB has the test-project canary row.
# The Task 3.1 setup runbook installs this marker once, when the test
# Supabase project is first provisioned. Missing canary → not the test
# project (or runbook step skipped). Either way, refuse.
if [ "${SKIP_CANARY}" -eq 0 ]; then
  if [ "${DRY_RUN}" -eq 0 ]; then
    CANARY_OUT=$(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -X -t -A -c \
      "SELECT 1 FROM _termdeck_test_canary WHERE ref = 'sprint-58-test-project' LIMIT 1" \
      2>&1) || CANARY_OUT="__error__"
    if [ "${CANARY_OUT}" != "1" ]; then
      echo "[reset] FATAL: canary precheck failed." >&2
      echo "[reset]        Expected row in _termdeck_test_canary with ref='sprint-58-test-project'." >&2
      echo "[reset]        This database does NOT appear to be the test Supabase project." >&2
      echo "[reset]        See docs/INSTALL-FIXTURES.md § Test Supabase project runbook." >&2
      echo "[reset]        Override with --skip-canary only if you have manually verified the URL." >&2
      exit 3
    fi
  else
    echo "[reset] DRY-RUN: would precheck canary row in _termdeck_test_canary"
  fi
fi

# Reset transaction. pg_advisory_xact_lock(58) serializes against any other
# concurrent reset call and auto-releases at COMMIT. The DO block tolerates
# partial provisioning (e.g. project init'd for Mnestra only, no Rumen yet)
# via to_regclass per-table guards.
RESET_SQL=$(cat <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(58);

DO $$
DECLARE
  t TEXT;
  tbls TEXT[] := ARRAY[
    'memory_relationships',     -- FK-children before parents (CASCADE handles it,
    'memory_items',             -- but explicit ordering is documentation)
    'memory_sessions',
    'mnestra_session_memory',
    'mnestra_project_memory',
    'mnestra_developer_memory',
    'mnestra_commands',
    'rumen_questions',
    'rumen_insights',
    'rumen_jobs'
  ];
  truncated TEXT[] := '{}';
  skipped   TEXT[] := '{}';
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', t);
      truncated := truncated || t;
    ELSE
      skipped := skipped || t;
    END IF;
  END LOOP;
  RAISE NOTICE '[reset] truncated (%): %', array_length(truncated, 1), array_to_string(truncated, ', ');
  IF array_length(skipped, 1) IS NOT NULL THEN
    RAISE NOTICE '[reset] skipped (table not provisioned, %): %', array_length(skipped, 1), array_to_string(skipped, ', ');
  END IF;
END $$;

COMMIT;
SQL
)

if [ "${DRY_RUN}" -eq 1 ]; then
  printf '[reset] DRY-RUN: would execute reset transaction:\n%s\n' "${RESET_SQL}"
  exit 0
fi

if ! psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -X -q <<<"${RESET_SQL}"; then
  echo "[reset] FATAL: reset transaction failed" >&2
  exit 4
fi

echo "[reset] $(stamp) test schema reset complete"
