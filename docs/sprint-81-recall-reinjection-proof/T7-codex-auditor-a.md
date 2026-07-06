# T7 — Codex Auditor A · DB / security / enforcement · Sprint 81
**Deck :3001 · cwd `…/TermDeck/termdeck` · Codex (adversarial, out-of-distribution)**

You are the independent auditor for the DB/security/enforcement half. You share NO context with the workers — **reproduce, don't rubber-stamp.** Audit in-progress code BEFORE `FIX-LANDED`, not after.

## Boot
1. Try `memory_recall(project="termdeck", query="Sprint 81 engram migration RLS receipt OID replay-safety recall provenance")`. **If `memory_recall` is not wired in your Codex runtime, skip it** and read the docs directly.
2. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
3. Read `docs/sprint-81-recall-reinjection-proof/PLANNING.md` (full context) + `STATUS.md`

## Audit targets (file:line evidence required)
- **T1 (engram, critical path):** 030 3-step order correct (dup-collapse keep-newest, reversible, never DELETE; index deferred to ORCH); 031 preserves fire-and-forget contract + honors `MNESTRA_DISABLE_RECALL_LOG=1` + **G2 wiring actually lands non-null** `source_session_id`/`source_agent` on the MCP path; 032 boost is **bounded + strict no-op at 1.0** (no rich-get-richer, no cold-memory starvation) + does NOT re-CREATE 027's `recall_count`/`last_recalled_at`; receipt sweep is **receipt-only** (no DDL/backfill change vs shipped 026/027/028); all new objects pass the 5 RLS gates with **OID-form receipts**.
- **T2 (rumen):** `reinforce.ts` writes ONLY `recall_boost`, never ranking content / existing rows; reads denorm rollup (survives 90d purge); RLS on any new object.
- **T3 (termdeck hooks):** both gates **fail-soft** (any error → allow) + registry-gated + do NOT block legit git ops; installer merge/install/refresh trio complete + mirrors PreCompact; pre-compact hook sends stable non-null `source_session_id`.

## Discipline
- Post `### [T7] VERB 2026-07-05 HH:MM ET — gist` (`AUDIT-PASS`/`AUDIT-FAIL`/`FINDING`/`CHECKPOINT`).
- **CHECKPOINT mandate:** post `### [T7] CHECKPOINT` at every phase boundary AND every ≤15 min — (phase, verified-so-far w/ evidence, pending, latest worker FIX-LANDED ref). On compaction, self-orient from your last CHECKPOINT. No version bumps / commits.
