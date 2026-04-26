-- scripts/migrate-chopin-nashville-tag.sql
-- One-time backfill for the v0.7.2 project-tag regression fix.
-- Sprint 34 — Author: T2 — 2026-04-26
--
-- Background:
--   resolveProjectName (TermDeck rag.js) and/or Rumen synthesis emit
--   project='chopin-nashville' for sessions whose actual project is termdeck
--   (or pvb, claimguard, mnestra, rumen). The strict equality filter in
--   memory_hybrid_search then walls TermDeck panels off from their own memories.
--   See docs/sprint-34-project-tag-fix/SQL-PLAN.md for the heuristic justification
--   and pre-flight counts. See docs/sprint-33-flashback-debug/POSTMORTEM.md
--   for the original BROKEN-AT finding.
--
-- Safety model:
--   Block 1 (DRY-RUN)  — pure SELECTs, no mutations. Run first. Post counts.
--   Block 2 (UPDATE)   — commented out. Uncomment ONLY after orchestrator + Josh
--                        review of the Block 1 numbers. Wraps stash + reclassify
--                        in a single transaction.
--   Block 3 (REVERT)   — commented out. One-shot rollback if the heuristic
--                        misclassifies. Reads the metadata stash written by Block 2.
--
-- Connect with the DATABASE_URL from ~/.termdeck/secrets.env.
-- Recommended invocation:
--   psql "$DATABASE_URL" -X -f scripts/migrate-chopin-nashville-tag.sql

\set ON_ERROR_STOP on
\timing on

-- ============================================================================
-- BLOCK 1 — DRY-RUN. ZERO MUTATIONS.
-- Run this whole block first. Review numbers. DO NOT proceed to Block 2 until
-- Block 1 output has been posted to STATUS.md and approved.
-- ============================================================================

\echo ''
\echo '=== Pre-flight: total active chopin-nashville rows ==='
SELECT count(*) AS total_active_chopin_nashville_rows
FROM memory_items
WHERE project = 'chopin-nashville'
  AND is_active = true
  AND archived = false;

\echo ''
\echo '=== Pre-flight: rows that WOULD be reclassified, by target project ==='
-- Each branch is OR-style: any single match is enough to reclassify.
-- Branches are mutually exclusive at the SELECT level via priority ordering
-- (termdeck wins ties), but a row matching multiple families is rare in practice.

WITH base AS (
  SELECT id, content, source_session_id, metadata
  FROM memory_items
  WHERE project = 'chopin-nashville'
    AND is_active = true
    AND archived = false
),
classified AS (
  SELECT id,
    CASE
      -- TermDeck (broadest, claims first because TermDeck is the dominant
      -- mis-tagged project per Sprint 33 T3 audit).
      WHEN content ILIKE '%@jhizzard/termdeck%'
        OR content ILIKE '%termdeck-stack%'
        OR content ILIKE '%packages/server/src%'
        OR content ILIKE '%packages/cli/src%'
        OR content ILIKE '%packages/client/public%'
        OR content ILIKE '%mnestra-bridge%'
        OR content ILIKE '%resolveProjectName%'
        OR content ILIKE '%xterm.js%'
        OR content ILIKE '%node-pty%'
        OR content ILIKE '%flashback%'
        OR content ILIKE '%TermDeck/termdeck%'
        OR (content ILIKE '%termdeck%' AND content NOT ILIKE '%chopin%')
        OR metadata->>'cwd' LIKE '%/SideHustles/TermDeck/termdeck/%'
      THEN 'termdeck'
      -- Mnestra (the memory store itself; rare but distinct).
      WHEN content ILIKE '%@jhizzard/mnestra%'
        OR content ILIKE '%memory_hybrid_search%'
        OR content ILIKE '%pgvector%'
        OR metadata->>'cwd' LIKE '%/Graciella/engram/%'
      THEN 'mnestra'
      -- Rumen (the async learning loop).
      WHEN content ILIKE '%@jhizzard/rumen%'
        OR content ILIKE '%rumen_jobs%'
        OR content ILIKE '%rumen_insights%'
        OR content ILIKE '%rumen-tick%'
        OR metadata->>'cwd' LIKE '%/Graciella/rumen/%'
      THEN 'rumen'
      -- PetVetBid.
      WHEN content ILIKE '%petvetbid%'
        OR content ILIKE '%pvb-one%'
        OR content ILIKE '%kai_staged_prices%'
        OR metadata->>'cwd' LIKE '%/PVB/pvb/%'
      THEN 'pvb'
      -- ClaimGuard (Unagi Gorgias Ticket Monitor).
      WHEN content ILIKE '%gorgias-ticket-monitor%'
        OR content ILIKE '%claimguard%'
        OR metadata->>'cwd' LIKE '%/Unagi/%'
      THEN 'claimguard'
      ELSE NULL
    END AS target_project
  FROM base
)
SELECT
  coalesce(target_project, '(stays as chopin-nashville)') AS target_project,
  count(*) AS rows_affected
FROM classified
GROUP BY 1
ORDER BY count(*) DESC;

\echo ''
\echo '=== Pre-flight: 10 sampled rows that WOULD STAY chopin-nashville ==='
\echo '(Manual sanity check — these should be festival / pianist / NICPC content,'
\echo ' NOT TermDeck stack content. If you see TermDeck content here, the'
\echo ' heuristic is too narrow and needs a new branch.)'

WITH base AS (
  SELECT id, source_type, content, metadata
  FROM memory_items
  WHERE project = 'chopin-nashville'
    AND is_active = true
    AND archived = false
)
SELECT id, source_type, left(content, 200) AS preview
FROM base
WHERE NOT (
     content ILIKE '%@jhizzard/termdeck%'
  OR content ILIKE '%termdeck-stack%'
  OR content ILIKE '%packages/server/src%'
  OR content ILIKE '%packages/cli/src%'
  OR content ILIKE '%packages/client/public%'
  OR content ILIKE '%mnestra-bridge%'
  OR content ILIKE '%resolveProjectName%'
  OR content ILIKE '%xterm.js%'
  OR content ILIKE '%node-pty%'
  OR content ILIKE '%flashback%'
  OR content ILIKE '%TermDeck/termdeck%'
  OR (content ILIKE '%termdeck%' AND content NOT ILIKE '%chopin%')
  OR (metadata->>'cwd') LIKE '%/SideHustles/TermDeck/termdeck/%'
  OR content ILIKE '%@jhizzard/mnestra%'
  OR content ILIKE '%memory_hybrid_search%'
  OR content ILIKE '%pgvector%'
  OR (metadata->>'cwd') LIKE '%/Graciella/engram/%'
  OR content ILIKE '%@jhizzard/rumen%'
  OR content ILIKE '%rumen_jobs%'
  OR content ILIKE '%rumen_insights%'
  OR content ILIKE '%rumen-tick%'
  OR (metadata->>'cwd') LIKE '%/Graciella/rumen/%'
  OR content ILIKE '%petvetbid%'
  OR content ILIKE '%pvb-one%'
  OR content ILIKE '%kai_staged_prices%'
  OR (metadata->>'cwd') LIKE '%/PVB/pvb/%'
  OR content ILIKE '%gorgias-ticket-monitor%'
  OR content ILIKE '%claimguard%'
  OR (metadata->>'cwd') LIKE '%/Unagi/%'
)
ORDER BY random()
LIMIT 10;

\echo ''
\echo '=== Pre-flight: 5 sampled rows that WOULD MOVE to termdeck ==='
\echo '(Manual sanity check — these should be obviously TermDeck content.'
\echo ' If you see actual Chopin festival content here, the heuristic is too'
\echo ' broad and needs a tighter branch.)'

WITH base AS (
  SELECT id, source_type, content, metadata
  FROM memory_items
  WHERE project = 'chopin-nashville'
    AND is_active = true
    AND archived = false
)
SELECT id, source_type, left(content, 200) AS preview
FROM base
WHERE
     content ILIKE '%@jhizzard/termdeck%'
  OR content ILIKE '%termdeck-stack%'
  OR content ILIKE '%packages/server/src%'
  OR content ILIKE '%packages/cli/src%'
  OR content ILIKE '%packages/client/public%'
  OR content ILIKE '%mnestra-bridge%'
  OR content ILIKE '%resolveProjectName%'
  OR content ILIKE '%xterm.js%'
  OR content ILIKE '%node-pty%'
  OR content ILIKE '%flashback%'
  OR content ILIKE '%TermDeck/termdeck%'
  OR (content ILIKE '%termdeck%' AND content NOT ILIKE '%chopin%')
  OR (metadata->>'cwd') LIKE '%/SideHustles/TermDeck/termdeck/%'
ORDER BY random()
LIMIT 5;

\echo ''
\echo '=== End of dry-run. Post the count rows above to STATUS.md. ==='
\echo '=== If counts and samples look right, uncomment Block 2 below.    ==='


-- ============================================================================
-- BLOCK 2 — UPDATE. COMMENTED OUT. DO NOT RUN UNTIL BLOCK 1 IS APPROVED.
-- ============================================================================
-- To execute:
--   1. Confirm Block 1 counts have been posted to STATUS.md and approved.
--   2. Remove the leading "-- " from each line in this block.
--   3. Re-run the script. The transaction stashes the old project value
--      under metadata.rebrand_v0_7_2_from BEFORE flipping project, so
--      Block 3 (revert) can restore the original on a single statement.
-- ============================================================================

-- BEGIN;
--
-- -- 2a. Stash the original project value for reversibility (idempotent: only
-- --     writes the stash key on rows that don't already have one).
-- UPDATE memory_items
--    SET metadata = jsonb_set(
--          coalesce(metadata, '{}'::jsonb),
--          '{rebrand_v0_7_2_from}',
--          to_jsonb(project),
--          true)
--  WHERE project = 'chopin-nashville'
--    AND is_active = true
--    AND archived = false
--    AND NOT (metadata ? 'rebrand_v0_7_2_from')
--    AND (
--         content ILIKE '%@jhizzard/termdeck%'
--      OR content ILIKE '%termdeck-stack%'
--      OR content ILIKE '%packages/server/src%'
--      OR content ILIKE '%packages/cli/src%'
--      OR content ILIKE '%packages/client/public%'
--      OR content ILIKE '%mnestra-bridge%'
--      OR content ILIKE '%resolveProjectName%'
--      OR content ILIKE '%xterm.js%'
--      OR content ILIKE '%node-pty%'
--      OR content ILIKE '%flashback%'
--      OR content ILIKE '%TermDeck/termdeck%'
--      OR (content ILIKE '%termdeck%' AND content NOT ILIKE '%chopin%')
--      OR (metadata->>'cwd') LIKE '%/SideHustles/TermDeck/termdeck/%'
--      OR content ILIKE '%@jhizzard/mnestra%'
--      OR content ILIKE '%memory_hybrid_search%'
--      OR content ILIKE '%pgvector%'
--      OR (metadata->>'cwd') LIKE '%/Graciella/engram/%'
--      OR content ILIKE '%@jhizzard/rumen%'
--      OR content ILIKE '%rumen_jobs%'
--      OR content ILIKE '%rumen_insights%'
--      OR content ILIKE '%rumen-tick%'
--      OR (metadata->>'cwd') LIKE '%/Graciella/rumen/%'
--      OR content ILIKE '%petvetbid%'
--      OR content ILIKE '%pvb-one%'
--      OR content ILIKE '%kai_staged_prices%'
--      OR (metadata->>'cwd') LIKE '%/PVB/pvb/%'
--      OR content ILIKE '%gorgias-ticket-monitor%'
--      OR content ILIKE '%claimguard%'
--      OR (metadata->>'cwd') LIKE '%/Unagi/%'
--    );
--
-- -- 2b. Reclassify to termdeck (broadest set; claims first).
-- UPDATE memory_items SET project = 'termdeck'
--  WHERE project = 'chopin-nashville'
--    AND is_active = true
--    AND archived = false
--    AND metadata ? 'rebrand_v0_7_2_from'
--    AND (
--         content ILIKE '%@jhizzard/termdeck%'
--      OR content ILIKE '%termdeck-stack%'
--      OR content ILIKE '%packages/server/src%'
--      OR content ILIKE '%packages/cli/src%'
--      OR content ILIKE '%packages/client/public%'
--      OR content ILIKE '%mnestra-bridge%'
--      OR content ILIKE '%resolveProjectName%'
--      OR content ILIKE '%xterm.js%'
--      OR content ILIKE '%node-pty%'
--      OR content ILIKE '%flashback%'
--      OR content ILIKE '%TermDeck/termdeck%'
--      OR (content ILIKE '%termdeck%' AND content NOT ILIKE '%chopin%')
--      OR (metadata->>'cwd') LIKE '%/SideHustles/TermDeck/termdeck/%'
--    );
--
-- -- 2c. Reclassify to mnestra (only rows still 'chopin-nashville' after 2b).
-- UPDATE memory_items SET project = 'mnestra'
--  WHERE project = 'chopin-nashville'
--    AND is_active = true
--    AND archived = false
--    AND metadata ? 'rebrand_v0_7_2_from'
--    AND (
--         content ILIKE '%@jhizzard/mnestra%'
--      OR content ILIKE '%memory_hybrid_search%'
--      OR content ILIKE '%pgvector%'
--      OR (metadata->>'cwd') LIKE '%/Graciella/engram/%'
--    );
--
-- -- 2d. Reclassify to rumen.
-- UPDATE memory_items SET project = 'rumen'
--  WHERE project = 'chopin-nashville'
--    AND is_active = true
--    AND archived = false
--    AND metadata ? 'rebrand_v0_7_2_from'
--    AND (
--         content ILIKE '%@jhizzard/rumen%'
--      OR content ILIKE '%rumen_jobs%'
--      OR content ILIKE '%rumen_insights%'
--      OR content ILIKE '%rumen-tick%'
--      OR (metadata->>'cwd') LIKE '%/Graciella/rumen/%'
--    );
--
-- -- 2e. Reclassify to pvb.
-- UPDATE memory_items SET project = 'pvb'
--  WHERE project = 'chopin-nashville'
--    AND is_active = true
--    AND archived = false
--    AND metadata ? 'rebrand_v0_7_2_from'
--    AND (
--         content ILIKE '%petvetbid%'
--      OR content ILIKE '%pvb-one%'
--      OR content ILIKE '%kai_staged_prices%'
--      OR (metadata->>'cwd') LIKE '%/PVB/pvb/%'
--    );
--
-- -- 2f. Reclassify to claimguard.
-- UPDATE memory_items SET project = 'claimguard'
--  WHERE project = 'chopin-nashville'
--    AND is_active = true
--    AND archived = false
--    AND metadata ? 'rebrand_v0_7_2_from'
--    AND (
--         content ILIKE '%gorgias-ticket-monitor%'
--      OR content ILIKE '%claimguard%'
--      OR (metadata->>'cwd') LIKE '%/Unagi/%'
--    );
--
-- -- 2g. Sanity: any rows still chopin-nashville with the stash key indicate a
-- --     heuristic gap (the stash predicate matched but no project-target
-- --     predicate did). Show them so we can fix before COMMIT.
-- SELECT count(*) AS leftover_with_stash_but_no_target
--   FROM memory_items
--  WHERE project = 'chopin-nashville'
--    AND metadata ? 'rebrand_v0_7_2_from';
--
-- -- 2h. Final per-project moved counts for the audit log.
-- SELECT project, count(*) AS rows_after_migration
--   FROM memory_items
--  WHERE metadata ? 'rebrand_v0_7_2_from'
--  GROUP BY 1
--  ORDER BY 2 DESC;
--
-- COMMIT;


-- ============================================================================
-- BLOCK 3 — REVERT. COMMENTED OUT. ONE-SHOT ROLLBACK.
-- Use ONLY if Block 2 misclassified rows. Restores project from the
-- metadata.rebrand_v0_7_2_from stash and removes the stash key.
-- ============================================================================

-- BEGIN;
--
-- UPDATE memory_items
--    SET project = metadata->>'rebrand_v0_7_2_from'
--  WHERE metadata ? 'rebrand_v0_7_2_from';
--
-- UPDATE memory_items
--    SET metadata = metadata - 'rebrand_v0_7_2_from'
--  WHERE metadata ? 'rebrand_v0_7_2_from';
--
-- COMMIT;
