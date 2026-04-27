-- Sprint 38 T2 — Graph-inference cron schedule.
-- Schedules the graph-inference Supabase Edge Function to run daily at
-- 03:00 UTC (≈ 23:00 ET, after typical work hours). The Edge Function
-- scans memory_items for pairs above GRAPH_INFERENCE_THRESHOLD (default
-- 0.85 cosine similarity), inserts edges into memory_relationships with
-- inferred_by = 'cron-YYYY-MM-DD' for audit trail, and optionally
-- classifies edge types via Haiku 4.5 (gated by GRAPH_LLM_CLASSIFY=1).
--
-- Coexists with the existing rag-system MCP-side ingest classifier:
-- this cron handles backfill + cross-project + stale-edge refresh; the
-- ingest classifier handles fresh per-memory edges in the 0.75-0.92
-- window.  See Sprint 38 T2 FINDING for the full coexistence design.
--
-- Before applying:
--   1. The pg_cron and pg_net extensions must already be enabled
--      (rumen migration 002 enables them; 003 assumes that prereq).
--   2. Add a Vault secret named 'graph_inference_service_role_key'
--      containing the project's service-role JWT.  Separate from
--      'rumen_service_role_key' so a key rotation on one cron doesn't
--      affect the other.
--   3. Replace <project-ref> below with the project's Supabase ref
--      (stack-installer substitutes this at apply-time, same as 002).
--
-- Apply with:
--   psql "$DIRECT_URL" -f migrations/003_graph_inference_schedule.sql

-- Idempotent unschedule.
SELECT cron.unschedule('graph-inference-tick')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'graph-inference-tick');

-- Schedule daily at 03:00 UTC.
SELECT cron.schedule(
  'graph-inference-tick',
  '0 3 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://<project-ref>.supabase.co/functions/v1/graph-inference',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'graph_inference_service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- Verify:
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'graph-inference-tick';
-- SELECT * FROM cron.job_run_details WHERE jobname = 'graph-inference-tick' ORDER BY start_time DESC LIMIT 5;
