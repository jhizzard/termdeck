# T1 — engram DB chain · Sprint 81 (recall→reinjection proof)
**Deck :3001 · cwd `~/Documents/Graciella/engram` · Model Opus 4.8**

You are the **SOLE owner of the engram migration chain** (Sprint-79 kitchen constraint — the 028/029 CHECK-collision was caught because two lanes touched engram migrations). No other lane authors engram migrations. Highest existing = 029; you own 030/031/032.

## Boot
1. `memory_recall(project="termdeck", query="Mnestra recall telemetry memory_recall_log migration 027 ingest_capture precompact receipt OID has_function_privilege")` then `memory_recall(query="recent decisions and bugs")`
2. Read `~/.claude/CLAUDE.md` and `~/Documents/Graciella/engram/CLAUDE.md` if present
3. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-81-recall-reinjection-proof/PLANNING.md` — **your authoritative charter is § T1**
4. Read the sibling `STATUS.md`

## Grounding (already read live code — trust these anchors)
- **Recall provenance ALREADY EXISTS** (migration 027 + `src/recall_log.ts`). You EXTEND it, never greenfield a `recall_events` table.
- G2 wiring gap: `mcp-server/index.ts` memory_recall handler `:369-395` doesn't pass `log_session_id`/`log_source_agent`; `recall.ts:267-268` reads them.

## Your work (priority order — 031 FIRST, it unblocks T4/T5)
1. **031 recall-log provenance + G2 fix (CENTERPIECE).** ADD `source_type`/`token_budget`/`recall_group_id` to `memory_recall_log` (do NOT re-CREATE `recall_count`/`last_recalled_at` — 027 owns them, guard `027:30-34`). Extend `log_recall_hits(jsonb)` payload + write sites (`recall.ts:263`, `search.ts:47`, `layered.ts`, `recall_graph.ts`), one `recall_group_id` per call, **preserve fire-and-forget** (never awaited/throws, returned-set-only). **Thread `log_session_id`/`log_source_agent` through `mcp-server/index.ts:369-395`** — this is what makes provenance non-NULL. Honor `MNESTRA_DISABLE_RECALL_LOG=1` (`recall_log.ts:173`).
2. **032 recall_boost (bounded no-op).** `memory_items.recall_boost numeric NOT NULL DEFAULT 1.0` + `set_recall_boost(jsonb)` service-role RPC + a **bounded multiplicative factor in `memory_hybrid_search`** (029 rewrote it, `:185-208`) that is a **strict no-op at 1.0**. T2 populates the column; ranking stays inert until then. Pruning moratorium: never penalize `recall_count=0`.
3. **030 precompact coupled unit.** Collapse existing `pre_compact_snapshot` dups **keep-newest-per-session** (reversible: `is_active=false`+`superseded_by`, never DELETE — mirror `028:141-161`). Author the deferred partial-unique index SQL (`028:217-219`) but **ORCH creates it at close-out** after T3's hook switch. (T3 owns the hook file change.)
4. **Receipt OID sweep.** Rewrite text-sig receipt blocks `026:316-319`, `027:463-466`, `028:557-560` to the 029 OID pattern (`029:265-292`). **ORCH ruling: receipt-only in-place edits are sanctioned** (fresh-install/CI robustness, like the 029→0.8.1 hotfix) — change ONLY receipt blocks, no DDL/backfill.

**5 RLS gates** on every new object: RLS enabled, no `WITH CHECK(true)`, REVOKE EXECUTE FROM public/anon/authenticated then GRANT service_role, `SET search_path`, OID-form receipt from day one.

**Scope knob:** must-haves = 031(+G2) and 032's column/RPC. 032's `memory_hybrid_search` wire-in + 030's index can slip to ORCH/follow-on. 031 is non-negotiable.

## Discipline
- Post `### [T1] VERB 2026-07-05 HH:MM ET — gist`. No version bumps / CHANGELOG / commits / publish.
- **File-only:** author `.sql` + `.ts` + tests locally. **Do NOT apply migrations or run live SQL** — ORCH applies at close-out.
- T4/T5/T2 are downstream of you — post `FIX-LANDED` per migration so ORCH can unblock them promptly.
