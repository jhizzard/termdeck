# Sprint 41 — T2: Re-tag migration with new taxonomy

**Lane goal:** Re-classify the 947 chopin-nashville rows (post-Sprint-39 backfill state) using T1's new project taxonomy. The Sprint 39 backfill caught 192 rows via content-keyword heuristic; this lane catches the rest via cwd-pattern reconciliation, broader keyword sets, and source_session_id → transcript_path → cwd resolution where available. Conservative: rows with NO clear signal stay `chopin-nashville` for T4 to LLM-classify.

**Target deliverable:**
1. NEW migration `012_project_tag_re_taxonomy.sql` (byte-identical mirror in TermDeck `packages/server/src/setup/mnestra-migrations/` and Mnestra `~/Documents/Graciella/engram/migrations/`).
2. RAISE NOTICE counts per re-tag bucket BEFORE and AFTER each UPDATE so orchestrator can review.
3. Idempotent — re-running the migration is a no-op (WHERE clauses ensure already-correctly-tagged rows aren't touched).
4. Migration is **NOT applied live in lane** — orchestrator applies at sprint close after reviewing counts.

## Audit before writing SQL

Run these queries first; document the actual baseline in your FINDING:

```sql
-- 1. Current chopin-nashville pollution (should be ~947 at sprint kickoff)
SELECT count(*) FROM memory_items WHERE project = 'chopin-nashville';

-- 2. Content-keyword distribution (which sub-project does each chopin-nashville row "look like"?)
SELECT
  CASE
    WHEN content ILIKE '%termdeck%' OR content ILIKE '%mnestra%' OR content ILIKE '%4+1 sprint%'
         OR content ILIKE '%PTY%' OR content ILIKE '%xterm%' THEN 'termdeck'
    WHEN content ILIKE '%rumen%' OR content ILIKE '%rumen-tick%' OR content ILIKE '%insight synthesis%' THEN 'rumen'
    WHEN content ILIKE '%podium%' THEN 'podium'
    WHEN content ILIKE '%bohemia%' OR content ILIKE '%2026 festival%' THEN 'chopin-in-bohemia'
    WHEN content ILIKE '%scheduling%' OR content ILIKE '%schedulingapp%' THEN 'chopin-scheduler'
    WHEN content ILIKE '%PVB%' OR content ILIKE '%pet%vet%bid%' OR content ILIKE '%petvetbid%' THEN 'pvb'
    WHEN content ILIKE '%gorgias%' OR content ILIKE '%claimguard%' THEN 'claimguard'
    WHEN content ILIKE '%openclaw%' OR content ILIKE '%dor%' THEN 'dor'
    WHEN content ILIKE '%competition%' OR content ILIKE '%performance%' OR content ILIKE '%jury%'
         OR content ILIKE '%sponsor%' OR content ILIKE '%piano%competition%' THEN 'chopin-nashville (legitimate)'
    ELSE 'uncertain'
  END AS likely_project,
  count(*)
FROM memory_items
WHERE project = 'chopin-nashville'
GROUP BY 1
ORDER BY 2 DESC;

-- 3. source_session_id presence — for rows that have it, the transcript_path may resolve to a cwd
SELECT count(*) FILTER (WHERE source_session_id IS NOT NULL) AS with_session,
       count(*) FILTER (WHERE source_session_id IS NULL) AS without_session
FROM memory_items
WHERE project = 'chopin-nashville';
```

## Migration shape

```sql
-- 012_project_tag_re_taxonomy.sql
-- Sprint 41 T2 — Re-classify chopin-nashville rows using the new taxonomy.
-- Sprint 39 T3 caught 192 rows; this catches the rest (deterministically).
-- The leftover "uncertain" rows stay under chopin-nashville for Sprint 41 T4
-- to LLM-classify.

BEGIN;

-- Audit before
DO $$
DECLARE before_count int;
BEGIN
  SELECT count(*) INTO before_count FROM memory_items WHERE project = 'chopin-nashville';
  RAISE NOTICE 'chopin-nashville rows before re-taxonomy: %', before_count;
END $$;

-- termdeck — broad keyword set (TermDeck specifics + general session/PTY/sprint vocabulary
-- that is overwhelmingly TermDeck-context, since other projects don't use the 4+1 pattern
-- or PTY internals)
UPDATE memory_items SET project = 'termdeck'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%termdeck%' OR content ILIKE '%mnestra%' OR content ILIKE '%4+1 sprint%'
        OR content ILIKE '%xterm%' OR content ILIKE '%node-pty%' OR content ILIKE '%flashback%'
        OR content ILIKE '%memory_items%' OR content ILIKE '%memory_relationships%');

DO $$
DECLARE after_termdeck int;
BEGIN
  SELECT count(*) INTO after_termdeck FROM memory_items WHERE project = 'chopin-nashville';
  RAISE NOTICE 'after termdeck pass: % chopin-nashville rows remain', after_termdeck;
END $$;

-- rumen
UPDATE memory_items SET project = 'rumen'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%rumen%' OR content ILIKE '%rumen-tick%' OR content ILIKE '%insight synthesis%');

-- podium
UPDATE memory_items SET project = 'podium'
 WHERE project = 'chopin-nashville' AND content ILIKE '%podium%';

-- chopin-in-bohemia (festival, distinct from competition)
UPDATE memory_items SET project = 'chopin-in-bohemia'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%bohemia%' OR content ILIKE '%chopin in bohemia%' OR content ILIKE '%2026 festival%');

-- chopin-scheduler
UPDATE memory_items SET project = 'chopin-scheduler'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%scheduling%' OR content ILIKE '%schedulingapp%');

-- pvb
UPDATE memory_items SET project = 'pvb'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%PVB%' OR content ILIKE '%pet%vet%bid%' OR content ILIKE '%petvetbid%');

-- claimguard
UPDATE memory_items SET project = 'claimguard'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%claimguard%' OR content ILIKE '%gorgias-ticket-monitor%' OR content ILIKE '%gorgias ticket monitor%');

-- dor
UPDATE memory_items SET project = 'dor'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%openclaw%' OR (content ILIKE '%DOR%' AND content NOT ILIKE '%doris%'));

-- Audit after
DO $$
DECLARE after_count int;
BEGIN
  SELECT count(*) INTO after_count FROM memory_items WHERE project = 'chopin-nashville';
  RAISE NOTICE 'chopin-nashville rows after re-taxonomy: % (uncertain/legitimate combined; T4 LLM-classifies the residue)', after_count;
END $$;

COMMIT;
```

**Conservative rules:**
- "DOR" keyword excluded if "doris" is also in the content (false-positive defense — "doris" is a person's name).
- "competition", "performance", "jury", "sponsor" keywords are NOT used to re-tag — those are likely the LEGITIMATE chopin-nashville rows. Leaving them under chopin-nashville is correct.
- The "uncertain" residue is for T4 to handle.

## Spot-check requirements (write into FINDING)

Before declaring DONE, spot-check 5–10 random rows from each re-tag bucket:

```sql
-- e.g., termdeck spot-check:
SELECT id, left(content, 200) AS preview, source_type, category
FROM memory_items
WHERE project = 'chopin-nashville' AND content ILIKE '%termdeck%'
ORDER BY random() LIMIT 5;
```

Document any false-positives. If false-positive rate exceeds 5%, tighten the keyword pattern in the migration.

## Coordination notes

- **T1** must publish the canonical taxonomy by ~50% sprint mark so T2 can finalize the keyword sets. T2 starts with the keyword sets above and refines based on T1's final taxonomy table.
- **T3** is independent.
- **T4** picks up where T2 leaves off — runs LLM classification on the residual chopin-nashville rows that T2 didn't deterministically catch.

## Test plan

- New `tests/migration-012-shape.test.js` — structural test against the SQL file: contains expected CREATE / UPDATE patterns, uses BEGIN/COMMIT transaction wrapping, has RAISE NOTICE probes, etc.
- Manual: apply migration to a dev schema (NOT prod) seeded with synthetic chopin-nashville rows. Verify counts match expectations.
- DO NOT apply migration to live `petvetbid` in lane. Orchestrator does that at sprint close.

## Out of scope

- LLM classification of uncertain rows — T4 owns it.
- PROJECT_MAP / hook updates — T1 owns them.
- Graph UX bug — T3 owns it.
- Re-tagging the legacy `mnestra_*` tables — separate cleanup pass, Sprint 42+.
- Backfilling memory_relationships edges that point to re-tagged rows (the project field on edges is implicit through the source/target memory_items, so no edge backfill needed).
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-41-project-taxonomy/STATUS.md` under `## T2`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
