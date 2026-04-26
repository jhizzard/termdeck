# T2 — Backfill SQL design (no execution)

You are Terminal 2 in Sprint 34. Your lane: design the one-time SQL migration that re-tags the 1,126 mis-tagged `chopin-nashville` rows to their correct projects. **You do NOT execute UPDATE statements.** Only SELECTs. The orchestrator + Josh approve and execute the UPDATE separately, after your script and its dry-run pre-flight count are reviewed.

## Read first
1. `docs/sprint-34-project-tag-fix/PLANNING.md` — full sprint context
2. `docs/sprint-34-project-tag-fix/STATUS.md` — protocol
3. `docs/sprint-33-flashback-debug/POSTMORTEM.md` — T3's BROKEN-AT finding has the row counts and the heuristic outline
4. `~/.claude/CLAUDE.md` and `./CLAUDE.md`
5. `~/.termdeck/secrets.env` for the live `DATABASE_URL` (read-only access pattern)

## You own
- NEW `scripts/migrate-chopin-nashville-tag.sql` — the migration SQL file (dry-run first, then commented-out UPDATE block)
- NEW `docs/sprint-34-project-tag-fix/SQL-PLAN.md` — heuristic justification, reversibility note, pre-flight counts (filled in after you run the SELECTs)
- Live SELECT probes against the petvetbid Supabase store to characterize the corpus and validate the heuristic. NEVER run UPDATE/DELETE/INSERT.

## You DO NOT touch
- T1's source code lane (rag.js, mnestra-bridge, session.js)
- T3's test files
- T4's docs/version files
- Any UPDATE statement against the live store. If you accidentally type `UPDATE`, stop and post BLOCKED.

## Heuristic strategy

Multi-branch OR. A row is reclassified from `chopin-nashville` to `termdeck` if ANY of these:

1. **Content match**: `content ILIKE '%@jhizzard/termdeck%'` OR `content ILIKE '%@jhizzard/termdeck-stack%'` OR `content ILIKE '%packages/server/src/%'` OR `content ILIKE '%packages/cli/src/%'` OR `content ILIKE '%packages/client/public/%'` OR `content ILIKE '%docs/sprint-%'` (TermDeck's sprint dir convention).
2. **Source path match**: `source_file_path LIKE '%/SideHustles/TermDeck/termdeck/%'`.
3. **Session traceability**: `source_session_id` is in the set of sessions whose `cwd` (from sessions table or rag_events) was under `/SideHustles/TermDeck/termdeck/`.

Same idea for other mis-tagged projects:
- `pvb` content → reclassify to `pvb` (content match on `pvb`, `petvetbid`, `petvetbridge`)
- `claimguard` content → reclassify to `claimguard` (`gorgias-ticket-monitor`, `Unagi/`)
- `mnestra` content → reclassify to `mnestra` (`engram/`, `@jhizzard/mnestra`)
- `rumen` → reclassify to `rumen` (`@jhizzard/rumen`, `rumen-tick`)
- Anything that doesn't match a known-project heuristic stays `chopin-nashville` (these are likely actual Chopin-Nashville content from the festival app).

## File structure

```sql
-- scripts/migrate-chopin-nashville-tag.sql
-- One-time backfill for the v0.7.2 project-tag regression fix.
-- Date: 2026-04-26
-- Sprint: 34
-- Author: Sprint 34 T2

-- ============================================================
-- DRY-RUN — RUN THIS BLOCK FIRST. ZERO MUTATIONS.
-- Posts to stdout the row counts that WOULD change.
-- Verify the counts match expectations before uncommenting the UPDATE block.
-- ============================================================

\echo 'Pre-flight: total mis-tagged chopin-nashville rows'
SELECT count(*) FROM memory_items WHERE project = 'chopin-nashville';

\echo 'Pre-flight: rows that would be reclassified to termdeck'
SELECT count(*) FROM memory_items WHERE project = 'chopin-nashville' AND (
  content ILIKE '%@jhizzard/termdeck%'
  OR content ILIKE '%packages/server/src%'
  -- ... full predicate ...
);

-- ... same for pvb, claimguard, mnestra, rumen ...

\echo 'Pre-flight: rows that would STAY chopin-nashville'
SELECT count(*) FROM memory_items WHERE project = 'chopin-nashville' AND NOT (
  -- (negation of the union of all the above predicates)
);

-- Sample 10 rows that WOULD STAY for sanity-check
\echo 'Sample of 10 rows staying as chopin-nashville (should be festival-app content):'
SELECT id, source_type, left(content, 120) AS preview FROM memory_items
WHERE project = 'chopin-nashville' AND NOT (...) LIMIT 10;

-- ============================================================
-- UPDATE BLOCK — ONLY UNCOMMENT AFTER ORCHESTRATOR + JOSH APPROVAL
-- of the dry-run counts above.
-- Each statement is wrapped in a transaction with reversibility.
-- ============================================================

-- BEGIN;

-- -- Stash the original project value in metadata for reversibility
-- UPDATE memory_items
--   SET metadata = jsonb_set(
--       coalesce(metadata, '{}'::jsonb),
--       '{rebrand_v0_7_2_from}',
--       to_jsonb(project)
--   )
-- WHERE project = 'chopin-nashville' AND (...heuristic predicate...);

-- -- Reclassify
-- UPDATE memory_items SET project = 'termdeck'
-- WHERE project = 'chopin-nashville' AND (...termdeck heuristic...);

-- UPDATE memory_items SET project = 'pvb' ... (similarly)

-- COMMIT;

-- ============================================================
-- REVERT (one-shot, in case the heuristic mis-classifies)
-- ============================================================

-- BEGIN;
-- UPDATE memory_items SET project = metadata->>'rebrand_v0_7_2_from'
-- WHERE metadata ? 'rebrand_v0_7_2_from';
-- UPDATE memory_items SET metadata = metadata - 'rebrand_v0_7_2_from'
-- WHERE metadata ? 'rebrand_v0_7_2_from';
-- COMMIT;
```

## Pre-flight workflow

1. Connect via the DATABASE_URL from secrets.env.
2. Run each `\echo` + `SELECT count(*)` block individually. Post results to STATUS.md.
3. **Sanity-check the "stays as chopin-nashville" sample.** If 10 random rows after filtering are all clearly festival-app content (Chopin festival applications, repertoire info, vet-bid-style data that doesn't match), the heuristic is OK. If they're actually TermDeck content that the heuristic missed, refine the predicate.
4. Iterate the predicate until the "stays" sample is clean.
5. Post `FIX-PROPOSED` with the final SQL file content and the pre-flight counts.
6. Post `DONE`. Do NOT execute the UPDATE.

## Output

- `FINDING — pre-flight counts: ...` with the dry-run numbers
- `FIX-PROPOSED` with the SQL file path
- `DONE` after the file is written and the dry-run is verified

## Reference memories
- `memory_recall("Rumen 145 noise insights deleted Sprint 21")` — past corpus cleanup pattern
- `memory_recall("petvetbid Supabase memory_items count")` — current corpus shape
