# Sprint 34 — SQL backfill plan (T2)

**Author:** T2 (Sprint 34)
**Date:** 2026-04-26
**Target script:** `scripts/migrate-chopin-nashville-tag.sql`
**Target store:** `petvetbid` Supabase Postgres, table `public.memory_items`
**Connection:** `DATABASE_URL` from `~/.termdeck/secrets.env`

This plan is the design + audit log for the one-time backfill that re-tags `chopin-nashville` rows whose actual project is `termdeck` (or `mnestra`, `rumen`, `pvb`, `claimguard`). T2 designed the SQL and ran read-only count probes only — no UPDATE has been executed. Block 2 of the SQL file (the UPDATE) is commented out and ships in that state.

---

## 1. Why this is needed

`packages/server/src/rag.js` `resolveProjectName(cwd, config)` and/or Rumen synthesis emit `project='chopin-nashville'` for sessions in `…/ChopinNashville/SideHustles/TermDeck/termdeck/`. The strict `WHERE project = filter_project` clause in `memory_hybrid_search` then walls TermDeck panels off from their own memories, which is the dominant content-quality cause of Flashback silence (Sprint 33 T3 BROKEN-AT, see `docs/sprint-33-flashback-debug/POSTMORTEM.md`).

T1 ships the writer-side fix in v0.7.2 so the regression stops accumulating. This plan ships the corpus-side fix that makes the existing backlog queryable under the right tag.

## 2. Heuristic — multi-branch OR, priority-ordered

A row is reclassified out of `chopin-nashville` if **any** of the keyword/path branches below fire. Branches are evaluated priority-first so a row matching multiple families (rare) lands in the most specific bucket.

| Priority | Target | Branches |
|---:|---|---|
| 1 | `termdeck` | `content ILIKE` any of `@jhizzard/termdeck`, `termdeck-stack`, `packages/server/src`, `packages/cli/src`, `packages/client/public`, `mnestra-bridge`, `resolveProjectName`, `xterm.js`, `node-pty`, `flashback`, `TermDeck/termdeck`; or `termdeck` AND NOT `chopin`; or `metadata->>'cwd'` under `…/SideHustles/TermDeck/termdeck/` |
| 2 | `mnestra`  | `@jhizzard/mnestra`, `memory_hybrid_search`, `pgvector`; or cwd under `…/Graciella/engram/` |
| 3 | `rumen`    | `@jhizzard/rumen`, `rumen_jobs`, `rumen_insights`, `rumen-tick`; or cwd under `…/Graciella/rumen/` |
| 4 | `pvb`      | `petvetbid`, `pvb-one`, `kai_staged_prices`; or cwd under `…/PVB/pvb/` |
| 5 | `claimguard` | `gorgias-ticket-monitor`, `claimguard`; or cwd under `…/Unagi/` |
| — | (stays as `chopin-nashville`) | None of the above |

### Branch design notes

- **`source_file_path` deliberately not used.** Pre-flight count showed `source_file_path IS NOT NULL` returns **0 of 1,165** rows — Rumen-synthesized memory_items don't carry a file path. The path-style matching shifts entirely onto `metadata->>'cwd'`, which Rumen *does* sometimes populate.
- **`source_session_id` not used as a join key.** 1,159 of 1,165 rows have a session ID, but Mnestra has no sessions table to join against — session IDs reference TermDeck's local SQLite, which lives only on Josh's laptop. The session ID can be a manual cross-check after the fact, not a SQL join condition.
- **`termdeck` AND NOT `chopin`** is the broadest net for the dominant family. Any row that mentions "termdeck" but not "chopin" is overwhelmingly likely to be TermDeck content. The `NOT chopin` guard prevents festival-app rows that incidentally cite TermDeck as part of the user's stack from being captured.
- **Conservative-by-design.** Rows that match no branch stay `chopin-nashville`. The explicit goal: false negatives (genuine TermDeck content left as chopin-nashville) are recoverable via a future re-run with broader predicates, while false positives (Chopin festival content moved to termdeck) corrupt the corpus across two projects and require Block 3 to revert.

## 3. Reversibility

Every reclassified row gets its original `project` value stashed under `metadata.rebrand_v0_7_2_from` **before** the project flip. The stash predicate (Block 2a) is the union of all per-target predicates, so any row Block 2 reclassifies is guaranteed to have the stash key.

If a misclassification is found later:

```sql
BEGIN;
UPDATE memory_items
   SET project = metadata->>'rebrand_v0_7_2_from'
 WHERE metadata ? 'rebrand_v0_7_2_from';
UPDATE memory_items
   SET metadata = metadata - 'rebrand_v0_7_2_from'
 WHERE metadata ? 'rebrand_v0_7_2_from';
COMMIT;
```

This restores the entire migration in one shot. (Same statements live as Block 3 in the SQL file, also commented out.)

The stash is also future-proofing: a future audit can `SELECT id, project, metadata->>'rebrand_v0_7_2_from' FROM memory_items WHERE metadata ? 'rebrand_v0_7_2_from'` to inspect exactly which rows were touched and what their original tags were. No other audit column is needed.

## 4. Pre-flight counts (live SELECTs run by T2 on 2026-04-26)

Counts ran under T2's read-only authorization. Content-revealing samples were blocked by the user permission system; sample inspection is deferred to Josh running the dry-run block himself before approving Block 2.

### 4.1 Global project distribution (sanity)

| project | count |
|---|---:|
| pvb | 1,599 |
| **chopin-nashville** | **1,165** |
| chopin-scheduler | 996 |
| global | 378 |
| gorgias | 368 |
| gorgias-ticket-monitor | 117 |
| imessage-reader | 114 |
| **termdeck** | **68** |
| podium | 62 |
| antigravity | 30 |
| claimguard | 10 |
| (smaller …) | … |

Confirms the regression shape from Sprint 33 T3: `chopin-nashville` is bloated; `termdeck` is starved at 68. Note that `gorgias` (368) + `gorgias-ticket-monitor` (117) are *also* mis-tagged variants of `claimguard` — out of scope for this script but flagged for a future sprint.

### 4.2 Heuristic branch population (chopin-nashville rows that match each branch)

Each row may match multiple branches; numbers are not additive.

| branch | count |
|---|---:|
| total active chopin-nashville rows | 1,165 |
| `content ILIKE '%termdeck%'` | 162 |
| TermDeck family union (`termdeck`-narrow + `@jhizzard/...` + paths + flashback + xterm/pty + mnestra-bridge + resolveProjectName) | **352** |
| `content ILIKE '%mnestra%'` | 72 |
| `content ILIKE '%rumen%'` | 140 |
| `content ILIKE '%flashback%'` | 57 |
| `content ILIKE '%xterm.js%' OR '%node-pty%'` | 12 |
| `content ILIKE '%@jhizzard/%'` | 17 |
| `pvb`/`petvetbid`/`pvb-one` | 7 |
| `gorgias-ticket-monitor` / `Unagi/` / `claimguard` | 4 |
| `chopin festival/pianist/NICPC/repertoire/maestro` (legitimate stays) | 53 |
| `chopin-scheduler` / `SchedulingApp` | 3 |

`source_file_path IS NOT NULL`: **0 of 1,165** — path branch contributes zero in current corpus (predicate kept in SQL anyway as future-proofing).

### 4.3 Reconciliation of "1,126 mis-tagged TermDeck rows" claim

The Sprint 33 T3 audit cited 1,126 chopin-nashville rows as TermDeck content. Direct keyword union under T2's heuristic catches **352**. Three reads of the gap:

1. **The 1,126 number was rough.** T3 may have used a different probe (`content ILIKE '%termdeck%'` returning the dominant *project*, not the dominant *count*). The actual count of strongly-TermDeck rows is closer to 352.
2. **~700 rows are genuinely ambiguous.** Rumen session summaries that mention TermDeck only obliquely (e.g., "spent the morning on the terminal") would not match these branches. Reclassifying them risks false positives. The conservative posture is correct: leave them.
3. **Real festival content exists.** The `chopin festival` keyword union catches 53 rows that should obviously stay. There is real Chopin-Nashville-tagged content in the corpus.

Recommendation: **ship the script as-is**. Move the 352 confidently-TermDeck rows now; iterate on the heuristic in a follow-up if Josh sees relevant memories still missing from termdeck Flashback queries after the migration.

### 4.4 Branch-wise expected reclassification (priority-applied)

The exact post-priority counts will come from Block 1's first SELECT when Josh runs it (priority is applied in CASE order, so a row matching both termdeck and mnestra branches lands in termdeck). Estimated upper bounds:

| target | upper-bound (union count) | likely actual (priority-applied) |
|---|---:|---:|
| termdeck | 352 | ~340–352 |
| mnestra | 72 | ~5–20 (most overlap with termdeck and lose) |
| rumen | 140 | ~10–25 (most overlap with termdeck/mnestra and lose) |
| pvb | 7 | ~3–7 |
| claimguard | 4 | ~2–4 |
| (stays chopin-nashville) | — | ~750–800 |

The exact split is what Block 1's first SELECT prints. Post that to STATUS.md as the gate for Block 2.

## 5. Sample inspection — manual step for Josh

T2 could not pull row content into the transcript (user permission policy on shared production data). Block 1 of the SQL file includes two sample selects:

- **10 rows that WOULD STAY** — should look like festival/pianist/NICPC content. If TermDeck stack content shows up here, the heuristic is too narrow; add a branch.
- **5 rows that WOULD MOVE to termdeck** — should look obviously like TermDeck stack content. If festival content shows up here, the heuristic is too broad; tighten.

Josh runs `psql "$DATABASE_URL" -X -f scripts/migrate-chopin-nashville-tag.sql` and posts the sample output to STATUS.md (or skims privately and approves) before Block 2 is uncommented.

## 6. Execution checklist (orchestrator + Josh)

1. Read `scripts/migrate-chopin-nashville-tag.sql` end-to-end.
2. Run Block 1 (the dry-run block) against the live store. Capture output.
3. Post the per-target reclassification counts and the leftover sample previews to `docs/sprint-34-project-tag-fix/STATUS.md`.
4. Decision gate: do the counts and samples justify proceeding? If yes:
   1. Edit the SQL file: remove the `-- ` prefix on Block 2 (and ONLY Block 2 — leave Block 3 commented).
   2. Re-run the script. The transaction either completes or rolls back.
   3. Re-run a sanity SELECT: `SELECT project, count(*) FROM memory_items WHERE metadata ? 'rebrand_v0_7_2_from' GROUP BY 1`.
   4. Re-run the test suite — including T3's new `tests/project-tag-invariant.test.js` — to confirm `termdeck` is now the top project for TermDeck-content queries.
5. If Block 2 fires and a misclassification is later found: uncomment Block 3 and re-run.
6. Discard the script (committed for audit, not re-runnable; a second run would be a no-op because the predicate excludes rows already carrying the stash key for Block 2a, but Blocks 2b–2f would also no-op because they all require `metadata ? 'rebrand_v0_7_2_from'` AND `project = 'chopin-nashville'`, and the project field has been flipped).

## 7. Out of scope (flagged for a future sprint)

- **`gorgias` (368) + `gorgias-ticket-monitor` (117) → `claimguard`** — same regression, different project. The same script could absorb this with two more priority branches, but T2-briefing scope is "chopin-nashville rows" specifically. Open a separate sprint card.
- **`PVB` (2) → `pvb`** — case-mismatch dupe. Trivial one-statement `UPDATE memory_items SET project='pvb' WHERE project='PVB'`. Defer.
- **`engram` (1) → `mnestra`** — historical name. One-row fix. Defer.
- **Mnestra `project_resolved_at` audit column** — separate sprint per PLANNING.md "Out of scope" list.
- **Rumen synthesis writer fix** — T1's audit covers TermDeck-side. If T1's FINDING flags Rumen as the actual emitter, that's a `@jhizzard/rumen@0.4.4` patch in a separate sprint per PLANNING.md.
