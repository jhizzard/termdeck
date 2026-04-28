# Sprint 39 — T3: Project-tag write-path verification

**Lane goal:** Audit and verify the project-tag flow end-to-end. Answer the open question raised by `tests/flashback-e2e.test.js:526`. Find the write-path bug AND ship the backfill that re-tags the historical pollution at sprint close. The chopin-nashville tag is currently **96% polluted** — of 1,139 rows tagged `chopin-nashville`, only 49 are legitimately chopin-nashville content; the other 1,090 are TermDeck/Mnestra/Rumen/podium/PVB/dor content that fell through the PROJECT_MAP iteration in Joshua's session-end hook. Sprint 33 fixed the hook forward-only without backfilling; the historical pollution is still in production memory_items today. T3 ships the backfill.

**Target deliverable:**
1. **Write-path audit:** documented map of every project-tag write path (where a memory's `project` field gets stamped) and every read path (where a query filters on `project`).
2. **Forward-fix:** if a mismatch exists between `session.meta.project` and `bridge.queryMnestra`'s project filter, a one-line fix + regression test.
3. **Backfill SQL:** NEW migration `011_project_tag_backfill.sql` that re-tags historical mis-tagged rows. **DO NOT execute live in lane** — write the SQL with `RAISE NOTICE` count probes, transaction-bracketed, idempotent; orchestrator applies at sprint close after reviewing affected counts.
4. **Backfill heuristic:** content-keyword-based mapping with conservative rules (only re-tag when a keyword strongly indicates a project; leave 'other/uncertain' rows under their current tag). Document the heuristic in the migration header.

## Why this lane exists

The existing failing test `tests/flashback-e2e.test.js:526` says:

```
proactive_memory frame.memories is empty even though 5 termdeck-tagged memories
match the probe — the bridge is filtering on a different project tag than the
session was created with.
```

That's a project-tag mismatch hypothesis. It's been failing since some point in Sprint 26+. T3 either:
- Confirms it (the bridge IS filtering wrong), and ships the fix that makes the test pass.
- Refutes it (the bridge filters correctly; the failure is for a different reason — e.g., the 5 termdeck-tagged memories don't actually match the probe text, or the WS frame timing is the real issue), and redirects to T1+T2.

## What to map

For each side of the flow, identify the project-tag value at runtime:

### Write paths (where memories get a project stamp)

1. **rag-system MCP-side classifier** (`~/Documents/Graciella/rag-system/src/lib/relationships.ts`, plus `process-session.ts`): writes memories into `memory_items` with `project = <session-project>`. What project tag does it use?
2. **Bundled hook (Sprint 38 P0)**: `packages/stack-installer/assets/hooks/memory-session-end.js` writes one row per session. It uses `detectProject(cwd)` against PROJECT_MAP — empty by default. So Brad's writes default to `project='global'`, Joshua's writes match his rag-system hook's PROJECT_MAP entries (different file). Confirm: where does Joshua's daily-flow memory_items get stamped?
3. **TermDeck `rag.js` telemetry writes** to legacy `mnestra_*` tables: what project tag is stamped, and is Flashback querying `memory_items` or these legacy tables?
4. **`memory_remember` MCP tool calls** (from inside Claude Code sessions): each session's `meta.project` propagates how to the row's `project` field?

### Read paths (where queries filter on project)

1. **`mnestra-bridge.queryMnestra(text, options)`**: what's the resolved `project` value passed to the RPC? Trace from `session.meta.project` → `bridge.queryMnestra` → SQL filter.
2. **`mnestra-bridge.queryDirect`**: same trace.
3. **`memory_recall` MCP tool**: takes `project` as input; users (Joshua) pass it explicitly. Not part of Flashback path.
4. **`match_memories` Postgres RPC** (Mnestra-side): receives a `project_filter` parameter — what shape does it expect (NULL? specific string? array?), and does the bridge format the value correctly?

## Concrete probes

```sql
-- 1. What project tags exist on memory_items?
SELECT project, count(*) FROM memory_items GROUP BY project ORDER BY count(*) DESC LIMIT 20;

-- 2. For Joshua's recent termdeck sessions, what project did rag-system write under?
SELECT project, count(*) FROM memory_items
WHERE created_at > now() - interval '7 days'
  AND content ILIKE '%termdeck%'
GROUP BY project;

-- 3. Same for chopin-nashville — does the 1,126 mis-tag finding from Sprint 33 still hold or has it self-resolved?
SELECT project, count(*) FROM memory_items
WHERE content ILIKE '%termdeck%'
GROUP BY project ORDER BY count(*) DESC;

-- 4. What project filter does match_memories accept and how does it apply it?
\df+ match_memories
```

```js
// 5. Inside packages/server/src/mnestra-bridge/index.js, log the actual RPC call:
console.log('[mnestra-bridge] queryMnestra calling RPC with project=', options.project, 'session.meta.project=', session?.meta?.project);
```

## Likely findings (any of these would be the smoking gun)

- TermDeck's session creation sets `meta.project = 'termdeck'` but the bridge passes `project = null` to the RPC (or vice versa).
- The RPC expects an exact string match but the bridge passes a wildcard pattern (or vice versa).
- The bundled hook stamps `project = 'global'` on every Brad-side memory because PROJECT_MAP is empty, but the bridge filters on Brad's actual project tag — so Brad's queries return zero hits even though memories exist.
- The Joshua-personal session-end hook (the rag-system one, not the bundled one) stamps `project = '<one of Joshua's PROJECT_MAP entries>'`, and the bridge filter mismatch is project-vs-project (e.g., `chopin-nashville` vs `chopin-scheduler` — the Sprint 33 mis-tag class).

## Files to inspect

- `packages/server/src/session.js` — how is `meta.project` resolved on session create?
- `packages/server/src/index.js` — how does session creation pass `meta.project` downstream?
- `packages/server/src/mnestra-bridge/index.js` — `queryMnestra`, `queryDirect`. Where does the project filter come from?
- `~/Documents/Graciella/engram/src/recall.ts` — the Mnestra MCP tool's RPC consumer. What does the RPC expect?
- `~/Documents/Graciella/engram/migrations/002_mnestra_search_function.sql` — the `match_memories` function definition. What does the project filter signature look like?
- `packages/server/src/rag.js` — `RAGIntegration._recallViaVectorOnly` and `_recallViaGraph`. What project tag do they pass downstream?
- `~/Documents/Graciella/rag-system/src/lib/deduplication.ts` — what project does it stamp on inserts?

## Test plan

- Unit: extend `tests/mnestra-bridge.test.js` to assert the project filter shape end-to-end (session.meta.project → RPC param). If no such test exists, write one.
- Regression: the existing `tests/flashback-e2e.test.js: project-bound flashback…` test should pass after T3 ships its fix (assuming the project-tag hypothesis is correct).
- Manual: in a TermDeck session with `meta.project = 'termdeck'`, fire a memory_recall via the bridge. Check the server log for the `[mnestra-bridge] queryMnestra` instrumentation output. Confirm the RPC receives the expected project tag.
- Cross-table: query `memory_items` and the legacy `mnestra_*` tables for the same content snippet. Verify they have consistent project tags.

## Coordination notes

- **T1 (instrumentation)** writes `bridge_query` events with `project_tag_in_filter` and `bridge_result` events with `top_3_project_tags`. T3's investigation depends on T1's diag — coordinate so T3 can read the diag stream during testing.
- **T2 (rcfile audit)** is your alternate hypothesis. Both could be true. Document T3's findings even if you only partially close the question — T1's diag should make the actual production-flow rejection point visible.
- **T4 (production-flow e2e)** depends on T3's fix landing. The new test asserts memories ARE returned in the proactive_memory frame; if T3's fix is the real fix, T4's test passes.

## Backfill heuristic — current pollution baseline

Probed 2026-04-27 ~20:00 ET against `petvetbid`:

```
chopin-nashville-tagged rows (1,139 total):
  701  other/uncertain               — leave alone (no clear keyword signal)
  272  termdeck/mnestra              — re-tag to 'termdeck' (or split mnestra)
   60  rumen                         — re-tag to 'rumen'
   49  chopin-nashville (legitimate) — KEEP under chopin-nashville
   48  podium                        — re-tag to 'podium'
    7  pvb                           — re-tag to 'pvb'
    2  dor/openclaw                  — re-tag to 'dor'
```

**Rule of thumb:** a row gets re-tagged only if its `content` matches a keyword pattern that's specific to one project. The "other/uncertain" 701 rows stay under chopin-nashville (no signal) — that's deliberately conservative. Joshua can run a deeper LLM-classification backfill in a future sprint if the 701 leftovers prove problematic for graph-aware recall.

**Migration shape (`011_project_tag_backfill.sql`):**

```sql
-- Sprint 39 T3 — chopin-nashville tag backfill.
-- 1,090 of 1,139 chopin-nashville rows are mis-tagged due to PROJECT_MAP
-- iteration order in ~/.claude/hooks/memory-session-end.js (fixed forward in
-- Sprint 35 / 36, but historical rows never got re-tagged).
-- Idempotent: WHERE clauses ensure re-running the migration is a no-op.

BEGIN;

-- Audit before
DO $$
DECLARE
  before_count int;
BEGIN
  SELECT count(*) INTO before_count FROM memory_items WHERE project = 'chopin-nashville';
  RAISE NOTICE 'chopin-nashville rows before backfill: %', before_count;
END $$;

-- Re-tag termdeck/mnestra content (~272 rows)
UPDATE memory_items SET project = 'termdeck'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%termdeck%' OR content ILIKE '%mnestra%' OR content ILIKE '%4+1 sprint%');

-- Re-tag rumen content (~60 rows)
UPDATE memory_items SET project = 'rumen'
 WHERE project = 'chopin-nashville' AND content ILIKE '%rumen%';

-- Re-tag podium content (~48 rows)
UPDATE memory_items SET project = 'podium'
 WHERE project = 'chopin-nashville' AND content ILIKE '%podium%';

-- Re-tag PVB content (~7 rows)
UPDATE memory_items SET project = 'pvb'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%PVB%' OR content ILIKE '%pet%vet%bid%' OR content ILIKE '%petvetbid%');

-- Re-tag dor content (~2 rows)
UPDATE memory_items SET project = 'dor'
 WHERE project = 'chopin-nashville'
   AND (content ILIKE '%dor%' OR content ILIKE '%openclaw%');

-- Audit after
DO $$
DECLARE
  after_count int;
BEGIN
  SELECT count(*) INTO after_count FROM memory_items WHERE project = 'chopin-nashville';
  RAISE NOTICE 'chopin-nashville rows after backfill: %', after_count;
END $$;

COMMIT;
```

T3 ships this migration in the lane. Orchestrator applies at sprint close after reviewing the RAISE NOTICE counts vs the expected ~49 legitimate-only baseline.

**Out-of-scope safety nets:**

- Lane MUST NOT execute the migration live. Lane writes SQL only.
- Lane MUST NOT trust content-keyword heuristics blindly — spot-check 5–10 random rows from each re-tag bucket via `SELECT id, content FROM memory_items WHERE project='chopin-nashville' AND content ILIKE '%termdeck%' LIMIT 10` and document any false positives in the FINDING.
- The 701 "other/uncertain" rows stay under chopin-nashville. A future sprint can run an LLM-classification pass on them if needed.

## Out of scope

- Don't add the diag instrumentation — T1 owns it.
- Don't tighten the PATTERNS.error regex — T2 owns it.
- Don't write the production-flow e2e test — T4 owns it.
- LLM-classification backfill of the 701 "other/uncertain" rows — Sprint 40+ candidate.
- Writes from `mnestra_*` legacy tables (different schema, different write path) — separate cleanup pass.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-39-flashback-resurrection/STATUS.md` under `## T3`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
