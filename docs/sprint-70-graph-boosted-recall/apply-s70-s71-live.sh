#!/bin/bash
# Sprint 70+71 live-apply — OPERATOR-EXECUTED (the agent classifier gates prod DDL).
# All four migrations ship DARK: flags OFF, rumen crons registered-then-deactivated.
# Run:  bash docs/sprint-70-graph-boosted-recall/apply-s70-s71-live.sh
set -euo pipefail

# Strip the ENTIRE query string — the URL carries Prisma-only params
# (?pgbouncer=true&connection_limit=1) that libpq/psql chokes on: stripping only
# the first param leaves "&connection_limit=1" glued to the database name.
DB=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"' | sed 's/[?].*$//')
[ -n "$DB" ] || { echo "DATABASE_URL not found in ~/.termdeck/secrets.env"; exit 1; }

ENGRAM=~/Documents/Graciella/engram
RUMEN=~/Documents/Graciella/rumen

echo "== engram 037 (graph walk expansion) =="
psql "$DB" -v ON_ERROR_STOP=1 -f "$ENGRAM/migrations/037_graph_walk_expansion.sql" | tail -3
echo "== engram 038 (objective tier) =="
psql "$DB" -v ON_ERROR_STOP=1 -f "$ENGRAM/migrations/038_objective_tier.sql" | tail -3
echo "== rumen 009 (anti-drift tables/gates) =="
psql "$DB" -v ON_ERROR_STOP=1 -f "$RUMEN/migrations/009_objective_guard.sql" | tail -3 2>/dev/null || \
  psql "$DB" -v ON_ERROR_STOP=1 -f "$RUMEN"/migrations/009_*.sql | tail -3
echo "== rumen 010 (cron registered + deactivated = DARK) =="
psql "$DB" -v ON_ERROR_STOP=1 -f "$RUMEN"/migrations/010_*.sql | tail -3

echo "== post-apply verification =="
psql "$DB" -X -q -c "
select to_regprocedure('public.memory_recall_graph_boosted(text,vector,int,int,float,float,int,uuid,boolean)') is not null as boosted_fn_probe_a,
       count(*) filter (where p.proname like 'objective\_%') as objective_fns
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace and n.nspname='public';" || true
psql "$DB" -X -q -c "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (proname like '%recall_graph%' or proname like 'objective%');"
psql "$DB" -X -q -c "select jobname, active from cron.job where jobname ilike '%objective%';" || true
echo "DONE — expect memory_recall_graph_boosted + objective_list/objective_ratify present, objective crons active=f"
