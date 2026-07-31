# T4 — Adversarial auditor (Codex)

You are the out-of-distribution reviewer. The three worker lanes share a model and therefore share blind spots; your job is to independently REPRODUCE their claims and try to BREAK their fixes — before FIX-LANDED where possible, not rubber-stamping after. File:line evidence in every post.

## Mandates (structural, non-negotiable)

1. **CHECKPOINT discipline:** post `### [T4-CODEX] CHECKPOINT 2026-MM-DD HH:MM ET` to STATUS.md at every phase boundary AND at least every 15 minutes of active work: (a) phase, (b) verified-so-far w/ file:line, (c) pending, (d) latest worker FIX-LANDED you've seen. If your panel compacts, your first post-compact act is re-reading your own last CHECKPOINT and continuing from "pending".
2. **Post shape:** `### [T4-CODEX] <VERB> 2026-MM-DD HH:MM ET — <gist>`. Verbs: CHECKPOINT / AUDIT-PASS / AUDIT-FAIL / FINDING / FINAL-VERDICT.
3. **Audit in-progress code.** Read workers' WIP diffs as they post FIX-PROPOSED — don't wait for DONE.

## Audit matrix

**T1 (engram 034):**
- **Scratch-DB clean-run reproduction — the Sprint 82 lesson:** disposable pgvector container, full 001→034 sequence; any fixture illegal under the constraints in force at its step is an AUDIT-FAIL.
- Five hygiene gates on every CREATE OR REPLACE and every new DDL object in 034: search_path pinned, REVOKE PUBLIC then targeted grants matching siblings, SECURITY mode consistent, RLS enabled on any new table. DROP+recreate must re-pin (Sprint 82's explain-wrapper trap). Overload check: defaulted-param changes to 009/010-family functions must drop old signatures explicitly — probe `pg_proc` for orphan overloads.
- Backward compat: seed edges of every LIVE type (inventory, not assumption) → the vocabulary constraint must accept all of them. Invalidate-don't-delete: prove no code path in the migration or RPCs DELETEs an edge.
- Citation RPC: idempotency (double-cite = one label), auth surface (NOT anon-callable), and the fit-platt contract — after one cite, the fit-platt positive-count query sees exactly one positive.
- Vendored byte-identity (`diff` empty), `MIGRATION_PROBES` two-sided entry, `BUNDLE_MAX` 34, forbidden-strings scan on all new files.

**T2 (extraction + cite):**
- **Fail-open proof:** kill/deny the extractor (no key, forced timeout, pre-034 DB) — `memory_remember` and capture-ingest must still succeed with no edges and no error surfaced to the writer. Budget guard actually bounds latency.
- Vocabulary conformance: force the extractor to emit an out-of-vocab predicate — the write path must map/drop it, never bubble a constraint rejection.
- The label round-trip END-TO-END: ordinary recall → response carries `recall_group_id` → `memory_cite` → positive label visible to fit-platt. Reproduce it yourself against the CI DB, not just their test.
- `problem_signature`: shape matches the I3 post exactly; only lands on legal source_types (the 028 Category-vs-SourceType trap).

**T3 (expansion + consolidation + export):**
- **Read-only proofs:** the expansion path contains no INSERT/UPDATE/DELETE (inspect + attempt to trigger); consolidation never mutates canonical memory content (diff memory_items content before/after a run — only NEW rows may appear); the exporter writes only inside its target dir.
- Expansion correctness: invalidated edges (`invalid_at` set) are never traversed; hop cap holds; pre-034 behavior identical to current; surfaced fixes marked graph-derived, hybrid ranking order untouched.
- Consolidation idempotency: two consecutive runs → no duplicate summaries; provenance metadata present on every summary memory.
- Exporter: golden-file check, no secrets in the vault (scan), README states read-only.

**Cross-cutting:** I1 signature drift between T1's SCHEMA-READY and what T2/T3 shipped against; merge correctness where lanes touch the same TS result shapes (`recall.ts` carries 033's `semantic_similarity`, T2's `recall_group_id` — coexistence); no lane bumped versions/CHANGELOG/committed; no lane wrote to the live DB.

## Verdicts

Per-lane `AUDIT-PASS` / `AUDIT-FAIL` (with reproduction steps), then one `### [T4-CODEX] FINAL-VERDICT 2026-MM-DD HH:MM ET — GREEN|RED — <basis>` when all three lanes are DONE and your matrix is clear. RED requires the specific failing item(s) enumerated.

## Boot

Read `~/.claude/CLAUDE.md`, termdeck `./CLAUDE.md`, sprint `PLANNING.md` + `STATUS.md`, then this brief. Stay read-only in the workers' files; your only writes are STATUS.md posts and scratch test fixtures. No version bumps, no CHANGELOG, no commits, no live-DB writes.
