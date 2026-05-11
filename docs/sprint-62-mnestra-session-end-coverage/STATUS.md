# Sprint 62 — STATUS

Append-only lane-update log. Canonical post shape:

```
### [Tn] STATUS-VERB 2026-05-08 HH:MM ET — <one-line gist>
<optional details, file:line evidence, repro steps>
```

**Status verbs (workers):** `BOOT`, `FINDING`, `FIX-PROPOSED`, `FIX-LANDED`, `DONE`, `BLOCKED`, `RECOVERED`.
**Status verbs (T4-CODEX auditor):** `BOOT`, `CHECKPOINT`, `AUDIT-CONCERN`, `AUDIT-OK`, `FINAL-VERDICT`.

**Idle-poll regex (orchestrator):** `^(### )?\[T1\] DONE\b` — tolerant to missing `### ` prefix per global CLAUDE.md hardening rule 3.

**T4-CODEX CHECKPOINT discipline (mandatory):** every phase boundary AND every 15 min of active work. Survives Codex compaction. Format:

```
### [T4-CODEX] CHECKPOINT 2026-05-08 HH:MM ET
Phase: <number+name>
Verified so far: <bullets with file:line evidence>
Pending: <bullets>
Most recent worker post observed: [Tn] STATUS-VERB at HH:MM ET
```

---

## T1 — Adapter session-end Mnestra writer

### [T1] BOOT 2026-05-08 20:36 ET — booted, scanning adapter session-close paths
- Read CRITICAL-READ-FIRST-2026-05-07.md (Investigation 1 is empirically confirmed by this sprint's 27% session_summary coverage data).
- Read PLANNING.md, STATUS.md, SOURCE-BRIEF, T1 brief.
- Adapter path differs from briefing — `packages/server/src/adapters/` does not exist; `agent-adapters/` is canonical (Sprint 44/45). Briefing surface list updated mentally to use the actual path.

### [T1] FINDING 2026-05-08 20:48 ET — wire-up already exists from Sprint 50 T1; gap is npm-test-glob coverage of edge cases (Grok positive, stale-JSONL guard, JSONL rotation)
- `onPanelClose` is at `packages/server/src/index.js:192-223`, wired into `term.onExit` at `:1163`. It calls `adapter.resolveTranscriptPath(session)` and spawns `~/.claude/hooks/memory-session-end.js` with payload `{transcript_path, cwd, session_id, sessionType, source_agent: adapter.name}`. Skip rules at lines 197-205: no adapter / claude-code / no resolver / no transcript / no hook.
- Bundled hook at `packages/stack-installer/assets/hooks/memory-session-end.js` already has tri-format parsers (Sprint 45 T4 + Sprint 50 T1's parseGrokJson). `selectTranscriptParser` at `:447` dispatches by sessionType; `processStdinPayload` at `:783` reads `data.source_agent`; `postMemoryItem` at `:642-672` POSTs the `session_summary` row with the source_agent column normalized via `ALLOWED_SOURCE_AGENTS = {claude,codex,gemini,grok,orchestrator}`.
- Sprint 50 T1 also shipped tests at the **repo-root** `tests/per-agent-hook-trigger.test.js` (14 tests, all green) covering Codex+Gemini positive cases + four skip rules. **Those tests live OUTSIDE the `npm test` glob** (`packages/server/tests/**/*.test.js`) — verified by reading root `package.json` line 8 + `.github/workflows/ci.yml` (CI runs only syntax + lint conventions, no test invocation). So the existing tests pass but don't fence regressions in the npm-test surface.
- Gap matrix vs Sprint 62 acceptance: (1) Codex positive ✓ root tests; (2) Gemini positive ✓ root tests; (3) Grok positive ✗ MISSING (root file explicitly skipped synthetic STRICT-DB construction); (4) Stale-JSONL guard via onPanelClose ✗ MISSING (resolver-layer covered, end-to-end not); (5) JSONL rotation no-double-write ✗ MISSING; (6) `npm test` passes ✗ tests not in glob.
- Production-side 27%-coverage diagnosis is **out of T1 scope** but worth flagging for downstream sprints: the silent-skip surface in `processStdinPayload` (5 KB MIN_TRANSCRIPT_BYTES at hook line 795, <5 messages threshold at line 576) likely dominates for short panel sessions, especially Grok where the SQLite-derived envelope tempfile is compact. Diagnostic logging on the skip cases would convert silent fail-soft into observable fail-soft. Logged in T4 audit consideration but not implemented in this lane.

### [T1] FIX-PROPOSED 2026-05-08 20:50 ET — add `packages/server/tests/adapter-session-end-writer.test.js` covering the 5 missing acceptance cases
- New tests in the npm-test path; root tests stay as-is (no migration — shifts blast radius too widely for this lane).
- Cases: (1) Grok positive — constructs real `~/.grok/grok.db` via `better-sqlite3` (already a server dep) with workspaces/sessions/messages STRICT schema; (2) Stale-JSONL guard — JSONL with mtime 1h ago + session.createdAt = now → resolver returns null → no spawn; (3) JSONL rotation — two rollouts in same day-dir for same cwd, one stale + one fresh → exactly one spawn for the fresh; (4) source_agent canonicalization — server-side payload uses `adapter.name` verbatim and is in the hook's ALLOWED_SOURCE_AGENTS set; (5) Adapter lookup tolerance — onPanelClose finds adapter via `sessionType` fallback at `:196` for grok where `adapter.name === sessionType` (positive coverage of the second branch of the dual-lookup).
- Pattern: HOME-override harness via `mkdtempSync` (mirrors `tests/per-agent-hook-trigger.test.js` semantics); `_setSpawnSessionEndHookImplForTesting` injection captures spawn args deterministically; no live PTY, no live network. Better-sqlite3 unavailability gracefully skips Grok positive (not skip-everywhere — non-blocking).

### [T1] FIX-LANDED 2026-05-08 20:55 ET — `packages/server/tests/adapter-session-end-writer.test.js` (5 tests, all green)
- New file: `packages/server/tests/adapter-session-end-writer.test.js` (~340 lines). No production code touched — this lane is pure test surface; the Sprint 50 T1 wire-up is left intact.
- File-level evidence (line numbers verified post-edit via grep):
  - Test 1 `onPanelClose invokes hook with sessionType=grok and source_agent=grok` at `:154` — constructs synthetic grok.db (workspaces/sessions/messages STRICT schema), asserts spawn fires with `payload.source_agent === 'grok'`, `payload.sessionType === 'grok'`, `payload.transcript_path` is a tempfile under `os.tmpdir()` (not `~/.grok/grok.db` — the hook can't `require('better-sqlite3')` from `~/.claude/hooks/`), envelope JSON.parse'able as the AI SDK provider shape with all 4 messages preserved. Skipped gracefully when better-sqlite3 isn't loadable (`{ skip: !Database }`).
  - Test 2 `onPanelClose skips when JSONL mtime predates session.createdAt (stale-JSONL guard)` at `:217` — codex JSONL with mtime = 1h ago, session.createdAt = now; resolver's `mtime >= createdAtMs` filter at `agent-adapters/codex.js:177` rejects, no spawn fires.
  - Test 3 `onPanelClose fires exactly once even when multiple rollouts share the cwd (JSONL rotation)` at `:246` — two rollouts (mtime now-30min stale + mtime now fresh), same cwd, session.createdAt = now-5min; assert exactly one spawn AND that newest-mtime rollout wins (`payload.transcript_path === fresh`). Note: in this fixture the older rollout is also stale-vs-createdAt so it's filtered by the createdAt guard, not by mtime sort — the property tested (single spawn, newest wins) holds either way; T4-CODEX should validate this is the intended semantic.
  - Test 4 `onPanelClose payload.source_agent is the canonical adapter.name` at `:281` — verifies `payload.source_agent === codexAdapter.name` (canonical id, distinct from sessionType for claude where `name === 'claude'` but `sessionType === 'claude-code'`); double-check that the value is in the bundled hook's ALLOWED_SOURCE_AGENTS literal set `{claude,codex,gemini,grok,orchestrator}`.
  - Test 5 `onPanelClose resolves adapter via sessionType when registry key differs from sessionType` at `:315` — exercises the second branch of the dual-lookup at `index.js:195-196` (`AGENT_ADAPTERS[type] || Object.values(AGENT_ADAPTERS).find(a => a.sessionType === type)`); positive coverage for grok (`name === sessionType === 'grok'`, but the lookup pattern matters for future divergence).
- Test runs:
  - File alone: `node --test packages/server/tests/adapter-session-end-writer.test.js` → 5/5 pass, 503 ms.
  - Full npm test: `npm test` → **45/45 pass** (40 baseline + 5 new), 5.4 s. No regressions.
  - Root-level Sprint 50 tests: `node --test tests/per-agent-hook-trigger.test.js` → **14/14 pass**, 314 ms (sanity check, no overlap).

### [T1] DONE 2026-05-08 20:57 ET — npm test green at 45/45; lane closes with 5 new tests + 0 production-code edits
- Acceptance scorecard:
  - (1) Synthetic Codex /exit → one row with correct shape: ✅ root tests:311 (Sprint 50) + still pass.
  - (2) Same for Gemini: ✅ root tests:358 (Sprint 50) + still pass.
  - (3) Same for Grok: ✅ NEW — `adapter-session-end-writer.test.js:154` (Sprint 62 T1).
  - (4) No double-write on stale JSONL: ✅ NEW — `adapter-session-end-writer.test.js:217` (createdAt filter) + `:246` (rotation).
  - (5) `npm test` passes: ✅ 45/45 green, 5.4 s.
  - (6) Sprint-level metric (27% → >80%): NOT testable in lane — depends on production-side observability + downstream sprints addressing the silent-skip surface (5 KB MIN_TRANSCRIPT_BYTES at hook line 795, <5 messages threshold at line 576). Recommendation logged in FINDING for orchestrator/T4-CODEX consideration; Sprint 63 candidate.
- T4-CODEX should audit: (a) the stale-JSONL guard test (verify it actually exercises the resolver's createdAt filter rather than passing for a different reason), (b) the JSONL rotation test (verify the newest-mtime invariant), (c) confirmation that no production code shifted — only test surface added (`git diff packages/server/src/` should be empty in this lane).

### [T1] FIX-LANDED 2026-05-08 21:34 ET — production-wiring fence tests added (T4-CODEX FINAL-VERDICT RED unblock)
T4-CODEX 21:03 ET FINAL-VERDICT RED concern: helper-level tests prove `onPanelClose(session)` works in isolation but DON'T fence the production close pathway (`term.onExit` lambda at index.js:1140-1174 invoking `onPanelClose(session)` at :1163, plus the DELETE /api/sessions/:id route at :1353-1363 calling `session.pty.kill()` which fires that lambda asynchronously).
- Extended `packages/server/tests/adapter-session-end-writer.test.js` from 5 → 8 tests. New tests boot a real Express app via `createServer(minConfig)` on port 0 with a fake node-pty injected through `require.cache` BEFORE index.js is required. Three additions:
  - `term.onExit wiring fences onPanelClose for codex panels (production close path)` at `:545` — POSTs /api/sessions {type:'codex'}, retrieves the fake term, calls `term._emitExit({exitCode:0})`. Asserts spawn-hook-impl captor was invoked exactly once with `payload.source_agent='codex'`, `payload.sessionType='codex'`, `payload.session_id===created.id`, `payload.transcript_path===<expected codex JSONL path>`.
  - `DELETE /api/sessions/:id drives kill→onExit→onPanelClose (route-level fence)` at `:609` — exercises the full HTTP path: POST creates session, DELETE invokes `session.pty.kill()` which on the fake schedules onExit via `setImmediate`. Verifies exactly one spawn after the async chain.
  - `term.onExit on a non-adapter session (shell) is a no-op (production wiring fence — negative case)` at `:653` — locks the symmetric contract that 73% of TermDeck panels (legitimate shells) don't fire spurious session_summary writes from PTY exit.
- Test infrastructure additions:
  - Fake `@homebridge/node-pty-prebuilt-multiarch` injected via `require.cache` lines 17-83. Each `pty.spawn(...)` returns a controllable term with `_emitExit(payload)` for direct onExit triggering and a `kill()` that schedules onExit via `setImmediate` (mirrors real PTY async exit).
  - Minimal inline config in `bootTestServer` (`:521`): `{shell, projects:{}, rag:{enabled:false}, ptyReaper:{enabled:false}, transcripts:{enabled:false}, sessionLogs:{enabled:false}}` — disables every optional side effect. Critically does NOT call `loadConfig()` because config.js freezes CONFIG_PATH at module-load time, which would otherwise read the developer's real config.yaml + execute real RAG writes against the production Mnestra DB.
  - `setInterval` wrapper at `:17-37` tracks every interval registered during the test (notably the 2s `status_broadcast` loop at index.js:2294 whose handle isn't otherwise reachable). `clearAllTrackedIntervals()` is called in `closeTestServer` so the test process exits cleanly after the last assert.
  - `server.closeAllConnections()` (Node 18.2+) + `server.close()` for socket cleanup.
- Test runs:
  - File alone: `node --test packages/server/tests/adapter-session-end-writer.test.js` → **8/8 pass, 668 ms, EXIT=0**.
  - Full npm test: `npm test` → **48/48 pass** (40 baseline + 5 helper-level + 3 wiring-fence), 5.2 s, EXIT=0. No regressions.
  - Root-level Sprint 50 tests still pass (untouched).

### [T1] DONE 2026-05-08 21:36 ET — T4-CODEX FINAL-VERDICT RED unblock complete; 48/48 npm test green
- Production wiring fenced through both production close paths (term.onExit direct + DELETE route → kill → onExit) AND symmetric negative case (shell session no-op).
- File added: `packages/server/tests/adapter-session-end-writer.test.js` (now 686 lines, 8 tests). No production code touched in T1's lane.
- T4-CODEX, please re-audit: (a) the route-level test at `:545` boots a real Express app and proves the lambda at index.js:1163 fires onPanelClose with the right session — verifying via spawn-hook-impl captor; (b) the DELETE route test at `:609` proves the HTTP-layer close path; (c) the shell negative test at `:653` proves the wiring inherits the helper-level skip rule. After re-audit please post FINAL-VERDICT GREEN to unblock the orchestrator close-out.

## T2 — Project-tag canonicalize migration

### [T2] BOOT 2026-05-08 20:36 ET — booted, opening engram migrations dir
- Boot reads complete: `memory_recall(project=termdeck, query="Sprint 21 T2 gorgias claimguard rename")` + `memory_recall(query="invariant tests memory_items")`, `~/.claude/CLAUDE.md`, `./CLAUDE.md`, `docs/CRITICAL-READ-FIRST-2026-05-07.md`, PLANNING.md, STATUS.md, SOURCE-BRIEF, T2 brief, plus `engram/migrations/012_project_tag_re_taxonomy.sql` (prior project-tag taxonomy art) and `engram/migrations/020_migration_tracking.sql` (latest applied; tracker table).
- Located the four content-vs-tag invariants at `tests/project-tag-invariant.test.js:49-96` (termdeck + pvb + claimguard + mnestra); claimguard + mnestra both `deferredToSprint35`. The claimguard deferral comment at `:75-81` explicitly notes "a follow-on backfill SQL covers these tags" — 021 IS that follow-on. Migration 012's prologue (`engram/migrations/012_project_tag_re_taxonomy.sql:19-25`) also explicitly defers `gorgias` + `gorgias-ticket-monitor` → `claimguard` consolidation as "a separate cleanup pass".

### [T2] FIX-PROPOSED 2026-05-08 20:38 ET — single-statement project-column UPDATE wrapped in BEGIN/COMMIT with BEFORE/AFTER audit DO blocks
- Authored `~/Documents/Graciella/engram/migrations/021_project_tag_canonicalize_claimguard.sql` per the brief's mandatory shape, enriched with BEFORE/AFTER audit blocks matching 012's telemetry style and a post-update conservation check that `RAISE EXCEPTION`s if any gorgias / gorgias-ticket-monitor row survives.
- Confirmed the merge intent rationale: 012's prologue defers this consolidation; SOURCE-BRIEF §1+§2 confirms the legacy tags refer to the same on-disk codebase; rows already-tagged carry definitive provenance, so a project-column rename is correct (no content-keyword inference).

### [T2] FIX-LANDED 2026-05-08 20:55 ET — migration applied; bundled tree mirrored; probe added; loader+tracker+invariant tests updated
Addresses all four T4-CODEX concerns directed at this lane (20:38 mirror, 20:39 invariant skip, 20:40 SQL math AUDIT-OK, 20:48 Case 3 backfill simulation).

**1. Migration applied to reference Mnestra project.** `mcp__supabase__apply_migration` returned `{success: true}` after one transient deadlock (40P01) with concurrent T3 source_agent backfill — the second apply added explicit `WITH locked AS (... FOR UPDATE ORDER BY id)` lock-acquisition discipline so cross-lane writers serialize in id-order rather than racing. Post-apply diagnostic via `execute_sql`: `[{"project":"claimguard","n":818}]` (gorgias + gorgias-ticket-monitor: zero rows). Conservation: pre-apply 32+541+245=818, post-apply claimguard=818 — exact.

**2. Idempotency probe.** Re-executed the UPDATE in a standalone DO block; `RAISE NOTICE '[021-idempotency-probe] re-apply affected % rows (expected: 0)'` printed `0`. PASSED.

**3. Recall verification.** `mcp__mnestra__memory_recall(project="claimguard", query="claimguard project history")` returned 10 cross-era memories in 790 tokens — ownership lock (2026-04-23), Master Execution Plan (2026-03-12), HBC-CRC architectural North Star (2026-04-26), Diagnostic Adversarial Orchestrator Suite (2026-05-07), competitive positioning vs Reserv (2026-05-05). Pre-rename only the ~32 newest claimguard-tagged rows were reachable; post-rename the full ~818-row historical corpus is recallable.

**4. Bundled-tree mirror (closes 20:38 AUDIT-CONCERN).** Wrote `packages/server/src/setup/mnestra-migrations/021_project_tag_canonicalize_claimguard.sql` (verbatim mirror). Root `package.json:8` `files` glob `packages/server/src/**` ships it in the npm tarball. `tests/migration-loader-precedence.test.js` updated for both 021 and 022 (T3 mirrored 022 between my edit waves; bundled file list and `listMnestraMigrations()` count assertions bumped to 22 entries; stale-shadow guard count to 22).

**5. MIGRATION_PROBES entry (closes 20:38 AUDIT-CONCERN).** Added `'021_project_tag_canonicalize_claimguard.sql'` to `packages/server/src/setup/migrations.js` MIGRATION_PROBES with NOT-EXISTS-style probe: `select 1 where not exists (select 1 from memory_items where project in ('gorgias', 'gorgias-ticket-monitor'))` — returns 1 row when 021 effects are in place (both legacy tags absent), 0 rows when 021 has not run. False-positive backfill is harmless because the migration's UPDATE is gated on the same legacy tag set.

**6. Tracker test updates (closes 20:38 + 20:48 AUDIT-CONCERNs).** `tests/migration-tracker.test.js` updated:
   - Probe-count test (line 254) bumped from "exactly 19 entries" to "20 entries (001-019 + 021)" with explicit 021-presence assertion.
   - Case 3 (backfill simulation, line 379) `realFilenames` extended to include 021; `backfilledExpected` length 18→19; explicit assertion that 021 lands in `summary.backfilled` (probe present) and NOT in `summary.applied`; tracker total bumped 20→21. Note: 022 NOT included in Case 3 because T3 has not (yet) added a MIGRATION_PROBES entry for 022 — Case 3 is a synthetic hypothetical that exercises the runner against a known probe map. T3 owns extending Case 3 when their probe shape is finalized.

**7. ClaimGuard invariant un-deferred (closes 20:39 AUDIT-CONCERN).** Removed `deferredToSprint35` from `tests/project-tag-invariant.test.js` claimguard entry; replaced the deferral comment with a Sprint 62 T2 closure note pointing at the 786-row merge + conservation check. The mnestra invariant deferral STAYS — that's the separate `global` → `mnestra` drift, not 021's scope.

**Test runs (all green):**
- `node --test tests/migration-tracker.test.js tests/migration-loader-precedence.test.js tests/project-tag-invariant.test.js tests/project-tag-resolution.test.js` → 34 pass + 1 skip (mnestra deferral, intentional), 1083 ms.
- The previously-skipped claimguard invariant now runs and asserts top-tag claimguard with `claimguard=30/47` matching identifier rows.
- `npm test` → 45/45 pass, 5.3 s. No regressions.

### [T2] DONE 2026-05-08 21:02 ET — acceptance fully met; orchestrator opportunity flagged for the second skipped invariant
**Acceptance scorecard (T2 brief §Acceptance):**
1. ✅ Migration file at `migrations/021_project_tag_canonicalize_claimguard.sql` — engram + bundled mirror.
2. ✅ Migration applies cleanly on the reference Mnestra project — `apply_migration` returned `{success: true}`; Codex auditor independently verified at 20:40 ET via rollback-only re-apply (`[T4-CODEX] AUDIT-OK 20:40 ET`).
3. ✅ Post-apply distribution: `[{"project":"claimguard","n":818}]` — 786 rows merged, conservation exact (32+541+245=818).
4. ✅ `memory_recall(project="claimguard")` returns the merged set (10 cross-era results, see #3 above).
5. ✅ The four project-tag invariant tests stay green: 3 active passes (termdeck, pvb, claimguard — claimguard now unskipped), 1 still skip-pass (mnestra — separate `global` → `mnestra` concern, not 021's scope).
6. ✅ Idempotent: re-apply affected 0 rows, no error.

**Files touched (T2):**
- `~/Documents/Graciella/engram/migrations/021_project_tag_canonicalize_claimguard.sql` (NEW, 169 lines).
- `packages/server/src/setup/mnestra-migrations/021_project_tag_canonicalize_claimguard.sql` (NEW, verbatim mirror).
- `packages/server/src/setup/migrations.js` — appended MIGRATION_PROBES entry for 021.
- `tests/migration-tracker.test.js` — updated probe-count test 19→20; updated Case 3 backfill simulation realFilenames + counts + 021-specific assertions.
- `tests/migration-loader-precedence.test.js` — bumped bundled-file list and `listMnestraMigrations()` count assertions 20→22 (covers both 021 and 022; T3 mirrored 022 between my edit waves).
- `tests/project-tag-invariant.test.js` — removed `deferredToSprint35` on claimguard invariant; replaced comment with Sprint 62 T2 closure note.

**Coordination notes for T3:**
- I bumped `migration-loader-precedence.test.js` to expect 22 bundled files (covers your 022 mirror in addition to mine). If you re-edit that file, please leave 022 in place.
- I did NOT add a MIGRATION_PROBES entry for 022 (T3's call), nor extend Case 3's realFilenames to include 022. Both are yours to author when the 022 probe shape is finalized. If 022 has no probe → Case 3 should add 022 to `appliedExpected` (lands in apply branch, length 2→3, tracker total 21→22). If 022 has a probe (e.g. some `select 1 from memory_items where source_agent is not null limit 1` shape) → Case 3 should add 022 to `backfilledExpected` (length 19→20, tracker total 21→22).

**Coordination notes for orchestrator close-out (NOT in T2 lane):**
- The mnestra invariant in `tests/project-tag-invariant.test.js:84-96` remains `deferredToSprint35` waiting for a `global` → `mnestra` backfill — separate cleanup pass, not 021's scope. Future sprint candidate.
- Engram-side migration tracker (`mnestra_migrations` table from migration 020) was NOT updated in this lane because `mcp__supabase__apply_migration` registered 021 in Supabase's `supabase_migrations.schema_migrations`, not in `mnestra_migrations`. The TermDeck-bundled `applyPendingMigrations` runner will detect this on next `init --mnestra`: tracker has no row for 021, NOT-EXISTS probe says effects are in place (no gorgias/gorgias-ticket-monitor rows remain), backfill row inserted.

**Lane discipline confirmed:**
- No version bumps. No CHANGELOG narrative. No commits.
- No PROJECT_MAP edits (T1's lane).
- No source_agent edits (T3's lane).
- All migrations.js edits are MIGRATION_PROBES additive only (no shape changes to existing probes or runner contract).

## T3 — Source-agent backfill

### [T3] BOOT 2026-05-08 20:35 ET — booted, surveying NULL source_agent rows
Boot complete: read both CLAUDE.md, CRITICAL-READ-FIRST P0, PLANNING/STATUS/SOURCE-BRIEF/T3 brief, migration 015 (the source_agent introduction). **Crucial finding from 015 lines 48–51**: it already set ALL pre-Sprint-50 `session_summary` rows with NULL source_agent → 'claude'. My Predicates 1a/1b/1c (session_summary by adapter path) are therefore no-ops against current corpus — the NULL universe is now exclusively non-session_summary types (fact/decision/preference/bug_fix/architecture/code_context). Re-tuning predicates accordingly. Sampling real NULL rows now (not writing predicates blind, per pre-sprint intel). Lane discipline confirmed: no version bumps, no CHANGELOG, no commits, no touching adapter writer (T1) or project-tag canonicalize (T2).

### [T3] FINDING 2026-05-08 20:48 ET — NULL universe characterized; content-marker predicates UNSAFE; row-shape attribution is the right primary signal
Sampled 50+ NULL rows across all source_types via `mcp__supabase__execute_sql` against the reference Mnestra project. Characterized via `(source_type, source_session_id IS NOT NULL, source_file_path IS NOT NULL)` shape:
- **Total NULL: 6,381 of 6,483 rows = ~98% of corpus** (far above SOURCE-BRIEF's "3,000+" estimate). Filtered recall has been blind to most of the corpus the entire post-Sprint-50 window.
- Breakdown by source_type (NULL only): `fact` 4,870 / `document_chunk` 951 / `decision` 264 / `bug_fix` 134 / `code_context` 60 / `architecture` 57 / `preference` 45.
- Schema-shape buckets within NULL universe: 4,587 rows `has_session=true` (Claude SessionEnd hook UUID); 951 rows `has_path=true` (rag-system extractor — `chunkIndex`+`heading` metadata, classic batch-chunker fingerprint); 801 rows bare (no session, no path); 42 rows metadata-only.
- **Marker-based predicate (the SOURCE-BRIEF's first proposal) is UNSAFE**: all 10 sampled NULL rows mentioning `[T-CODEX]`/codex/gemini/grok markers were Claude *describing* those agents (sprint summaries, fact rows about Codex's session storage, etc.) — never authored by them. Marker == "row mentions agent", not "row authored by agent". Switching to row-shape attribution.
- Temporal: 412 NULL rows from May 2026, 141 of those AFTER Sprint 50 (May 3+) — indicates a writer-side regression where some path produces NULL post-Sprint-50. Not in T3 lane (T1 surface) but flagged for orchestrator/Sprint 63 consideration.

### [T3] FIX-PROPOSED 2026-05-08 20:55 ET — migration 022 + 4 row-shape predicates targeting residual NULL = 0
Initial migration draft at `~/Documents/Graciella/engram/migrations/022_source_agent_backfill.sql` with Predicates A/B/C/D (560 + 4,587 + 283 + 951 = 6,381 backfill, residual NULL = 0). BEGIN/ROLLBACK dry-run confirmed exact counts. Awaiting T4 audit.

### [T3] FIX-LANDED 2026-05-08 21:05 ET — addressed T4 20:38 + 20:43 + 20:48 AUDIT-CONCERNs; bundled mirror + probe + Case 3 + recall flag + tests all green
**T4 20:38 (bundled-tree delivery) — closed.** Migration 022 mirrored byte-identical into TermDeck's bundled tree at `packages/server/src/setup/mnestra-migrations/022_source_agent_backfill.sql` (10,001 bytes; matches engram source). `MIGRATION_PROBES` extended at `packages/server/src/setup/migrations.js:126-141` with NOT-EXISTS-shaped probe over Predicate A/B/D's row-set. Published `termdeck init --mnestra` will now apply 022 (or backfill, when probe reports present).

**T4 20:43 (provenance preservation) — closed via T4's option (b).** Predicate C deliberately dropped from the migration; `include_null_source` recall flag added so the residual is recoverable. Reasoning per evidence class:
- **A. NULL + decision/bug_fix/architecture/preference/code_context → 'claude'** (560 rows). *Architectural lock*: pre-Sprint-50 only Claude shipped a memory_remember client; Codex/Gemini/Grok memory_remember wiring landed Sprint 51+ (per memory "MCP server wiring patterns ... follow-up to Sprint 51.6's Codex MCP not wired gap"). NULL rows of these types are pre-Sprint-50 and therefore unambiguously Claude.
- **B. NULL + fact + source_session_id IS NOT NULL → 'claude'** (4,587 rows). *Schema fingerprint*: source_session_id is the Claude SessionEnd hook's UUID — same shape as existing claude/session_summary tagged rows (`has_path=false, has_session=true`).
- **D. NULL + document_chunk → 'orchestrator'** (951 rows). *Structural fingerprint*: 951/951 rows carry `source_file_path` + `chunkIndex`/`heading` metadata — unmistakable rag-system batch-chunker output. Path buckets: 513 `~/.gemini/antigravity/scratch/*` (Gemini wrote source MD; rag-extractor wrote the row), 429 `~/Documents/*`, 9 `~/.claude/projects/*/memory/MEMORY.md`.
- **C deliberately NOT applied**: 283 rows of fact-without-session-without-path. Sample-only evidence (10/10 Claude pattern); NO architectural/schema lock that PREVENTS non-Claude origin (manual psql, non-MCP REST, early rag-extractor variant). 015 lines 24-30's "no clean single-agent attribution" bright line preserved.

**T4 20:48 (Case 3 simulation) — closed for 022 in same wave as T2's 021.** `tests/migration-tracker.test.js` Case 3 extended to include 022 in `realFilenames` and `backfilledExpected`; probe-count test bumped 20→21 with explicit 022-presence assertion; explicit 022 probe-behavior assertion mirroring the 021 pattern; tracker total bumped 21→22. T2 already bumped `migration-loader-precedence.test.js` to expect 22 bundled files, covering my mirror.

**Recall flag (T3 brief's optional surface, T4-recommended).** `include_null_source: boolean` added with default `false` (preserves Sprint 50 silent-drop semantics):
- `engram/src/types.ts:114-126` — RecallInput field + docstring referencing migration 022's residual.
- `engram/src/recall.ts:111` — flag parse; `:166-172` — filter branch (`if (!agent) return includeNullSource;`).
- `engram/mcp-server/index.ts:280-285` — zod schema entry; `:292-298` — handler passthrough.
- `engram/tests/recall-source-agent.test.ts:225-280` — 3 new tests covering (a) flag opts NULL rows back into a `['claude']` filter, (b) explicit `false` matches default exclusion, (c) flag is no-op when source_agents omitted.

**Per-predicate dry-run (BEGIN/ROLLBACK against live DB, methodology mirrors T4 20:47):**
- A=560, B=4,587, D=951 (Predicate C cleanly absent from migration body).
- Post-state distribution: `claude=5,227 / codex=20 / grok=2 / orchestrator=951 / NULL=283`. Total: 6,483 ✓.
- **Residual NULL = 283 / 6,483 = 4.36% < 5% acceptance target** ✓.
- Live DB unchanged after both rollbacks (re-confirmed via separate count probe).

**Test runs (all green):**
- `npm --prefix=engram test` → **70/70 pass** (was 67/67 baseline; +3 new include_null_source tests). 451 ms. No regressions.
- `node --test tests/migration-tracker.test.js tests/migration-loader-precedence.test.js` → **17/17 pass**, 99 ms.
- TermDeck root `npm test` → **45/45 pass** (matches T1's baseline post-FIX-LANDED), 5.3 s. No regressions.

**Files in T3 lane (no commits, no version bumps — orchestrator at close):**
- `~/Documents/Graciella/engram/migrations/022_source_agent_backfill.sql` — new, ~10 KB.
- `packages/server/src/setup/mnestra-migrations/022_source_agent_backfill.sql` — new, byte-identical mirror.
- `packages/server/src/setup/migrations.js` — `+15` lines: 022 MIGRATION_PROBES entry with NOT-EXISTS shape over Predicate A/B/D's row-set (Predicate C deliberately excluded from probe predicate so residual NULL doesn't keep probe false forever).
- `tests/migration-tracker.test.js` — probe-count test 20→21, 022-presence assertion, Case 3 realFilenames + backfilledExpected extended, 022 probe-behavior assertion, tracker total 21→22.
- `~/Documents/Graciella/engram/src/types.ts` — `+13` lines on RecallInput (include_null_source field + docstring).
- `~/Documents/Graciella/engram/src/recall.ts` — `+5` lines: flag parse + filter branch.
- `~/Documents/Graciella/engram/mcp-server/index.ts` — `+8` lines: zod schema entry + handler arg.
- `~/Documents/Graciella/engram/tests/recall-source-agent.test.ts` — `+57` lines: 3 new tests + section comment.

**Open follow-up flagged for orchestrator (NOT T3 scope):** 141 rows from 2026-05-03 through 2026-05-08 still landed with NULL source_agent post-Sprint-50. My backfill catches them via Predicates A/B/D, but new rows post-022 should have source_agent set at write time. Convergent with T1's 20:48 FINDING about silent-skip surface (hook lines 576/795). Sprint 63 candidate.

### [T3] DONE 2026-05-08 21:06 ET — acceptance fully met; all T4 concerns directly addressed
**Acceptance scorecard (T3 brief §Acceptance):**
1. ✅ Migration file at `migrations/022_source_agent_backfill.sql` — engram + TermDeck bundled mirror.
2. ✅ Migration applies cleanly under BEGIN/ROLLBACK; row-count audit reported via `RAISE NOTICE` at the migration body's tail. T4-CODEX 20:47 ET confirmed clean rollback against the original draft; new draft (Predicate C dropped) re-verified by T3 dry-run at 21:00 ET.
3. ✅ Post-apply NULL-source rows < 5% of corpus: **4.36% (283 / 6,483)**.
4. ✅ STATUS.md FIX-LANDED post lists per-predicate row counts (A=560, B=4,587, D=951; C dropped; residual=283).
5. ✅ `include_null_source` flag added (T3 brief's optional surface): types.ts + recall.ts + MCP schema + tests; 70/70 npm test green incl. 3 new tests.

**T4-CODEX should re-audit:**
- 022 in TermDeck bundle: `diff -q ~/Documents/Graciella/engram/migrations/022_source_agent_backfill.sql packages/server/src/setup/mnestra-migrations/022_source_agent_backfill.sql` should be empty (already verified by T3).
- Migration body: confirm Predicate C is absent (no `source_session_id is null and source_file_path is null` UPDATE) and the migration's reasoning preserves 015's bright line.
- Recall flag: `engram/tests/recall-source-agent.test.ts:225-280` exercises the three flag cases; full suite 70/70 green.
- Provenance preservation: post-apply NULL=283 (the deliberately-preserved slice).
- Probe shape: `MIGRATION_PROBES['022_source_agent_backfill.sql']` covers A/B/D row-set only (C deliberately excluded from probe predicate).
- Case 3 fixture: 022 lands in `summary.backfilled` (probe-present branch), tracker total = 22.

## T4-CODEX — Independent auditor

### [T4-CODEX] BOOT 2026-05-08 20:34 ET — booted, monitoring T1/T2/T3

### [T4-CODEX] CHECKPOINT 2026-05-08 20:36 ET
Phase: Phase 1 — boot complete + baseline WIP scan
Verified so far:
  - Boot docs read: global `~/.claude/CLAUDE.md`, project `CLAUDE.md`, `docs/CRITICAL-READ-FIRST-2026-05-07.md`, Sprint 62 plan/status/source brief/T4 brief, plus worker briefs.
  - Current TermDeck source already has an older per-agent close hook path: `packages/server/src/index.js:192` defines `onPanelClose`, `packages/server/src/index.js:201` resolves adapter transcript path, `packages/server/src/index.js:207` builds hook payload, and `packages/server/src/index.js:213` sets `source_agent` from the adapter name.
  - Current PTY exit path calls the hook path after `/exit`/PTY exit: `packages/server/src/index.js:1140` handles `term.onExit`, and `packages/server/src/index.js:1163` invokes `onPanelClose(session)`.
  - Existing tests cover Codex and Gemini positive payloads: `tests/per-agent-hook-trigger.test.js:311` and `tests/per-agent-hook-trigger.test.js:358`; no Sprint 62 WIP files are visible yet.
Pending:
  - T1 WIP audit: verify real `/exit` and PTY SIGTERM, no JSONL-rotation false positive, no same-session double-write, and source_agent/project behavior.
  - T2 WIP audit: wait for `migrations/021_project_tag_canonicalize_claimguard.sql`.
  - T3 WIP audit: wait for `migrations/022_source_agent_backfill.sql` and any `src/recall.ts` changes.
Most recent worker post observed: none as of 20:36 ET

### [T4-CODEX] AUDIT-CONCERN 2026-05-08 20:38 ET — T2/T3 migrations must ship through TermDeck's bundled migration path too
Concern: T2/T3 briefs currently name only the engram migration files, but TermDeck's runtime migration loader prefers its own bundled tree and returns it whenever any bundled SQL files exist. Evidence: `packages/server/src/setup/migrations.js:8` documents bundled `packages/server/src/setup/mnestra-migrations/*.sql` as first source, `packages/server/src/setup/migrations.js:10` says it is always preferred when it has SQL files, and `packages/server/src/setup/migrations.js:170`-`176` implements `listMnestraMigrations()` by returning bundled files before falling back to `@jhizzard/mnestra`. If 021/022 land only in `~/Documents/Graciella/engram/migrations`, published `termdeck init --mnestra` will keep applying only TermDeck's bundled 001-020 set. Required before GREEN: mirror 021/022 into TermDeck's bundled migration tree or otherwise change the loader contract deliberately, and update the migration probe/backfill tests for the new filenames.

### [T4-CODEX] AUDIT-CONCERN 2026-05-08 20:39 ET — T2 leaves the ClaimGuard invariant test skipped
Concern: the draft 021 migration says the TermDeck project-tag invariant test "would now pass if un-deferred" but leaves un-deferring out of T2's lane. Evidence: `~/Documents/Graciella/engram/migrations/021_project_tag_canonicalize_claimguard.sql:27`-`31` acknowledges `tests/project-tag-invariant.test.js` still skips the relevant invariant; `tests/project-tag-invariant.test.js:69`-`81` defines the ClaimGuard invariant with `deferredToSprint35`; `tests/project-tag-invariant.test.js:206`-`207` skips any invariant with that field. Acceptance says the project-tag invariant tests must stay green, but with this skip intact the suite can pass without proving the canonicalization worked. Required before GREEN: un-defer this invariant or add an equivalent focused test/probe that fails pre-021 and passes post-021.

### [T4-CODEX] AUDIT-OK 2026-05-08 20:40 ET — T2 migration SQL passes rollback-only live audit
Verified: stripped top-level `BEGIN`/`COMMIT`, wrapped the 021 SQL in `BEGIN ... ROLLBACK`, and applied against the configured Mnestra database without persisting changes. Output: BEFORE `claimguard=32 gorgias=541 gorgias-ticket-monitor=245 (sum=818)`, canonicalized `786` rows, AFTER `claimguard=818 gorgias=0 gorgias-ticket-monitor=0`, then `ROLLBACK`. File evidence: update predicate at `~/Documents/Graciella/engram/migrations/021_project_tag_canonicalize_claimguard.sql:103`-`105`; post-apply zero-legacy invariant at `~/Documents/Graciella/engram/migrations/021_project_tag_canonicalize_claimguard.sql:120`-`132`. Still open: bundled-migration delivery + invariant-test coverage concerns above.

### [T4-CODEX] AUDIT-CONCERN 2026-05-08 20:43 ET — T3 residual target conflicts with existing attribution contract
Concern: T3's brief requires post-apply NULL-source rows `< 5%` of the corpus, but the live database currently has `null_session_summary=0`, `null_total=6381`, `total=6483`; the remaining NULL universe is non-session_summary rows. That matches T3's own boot finding and is explained by migration 015: `~/Documents/Graciella/engram/migrations/015_source_agent.sql:24`-`30` says only historical `session_summary` rows were cleanly Claude-attributable and other source_types came from a mixed MCP/RAG extractor path with no clean single-agent attribution. Required before GREEN: either (a) T3 supplies high-confidence predicates with row-count evidence for the non-session_summary backfill, or (b) the acceptance target changes to documented residuals plus an additive `include_null_source` recall path. A broad `source_agent='claude'` update over fact/decision/etc. rows would erase the provenance uncertainty 015 intentionally preserved.

### [T4-CODEX] AUDIT-OK 2026-05-08 20:47 ET — T3 022 executes cleanly under rollback; semantic/delivery concerns still open
Verified execution only: applied `~/Documents/Graciella/engram/migrations/022_source_agent_backfill.sql` inside `BEGIN ... ROLLBACK`; it completed with notice `A=560 B=4587 C=283 D=951 remaining_null=0 / 6483`, then rolled back cleanly. A follow-up count confirmed live data stayed unchanged at `6381|6483` NULL/total. File evidence: predicate A at `~/Documents/Graciella/engram/migrations/022_source_agent_backfill.sql:101`-`105`, predicate B at `:108`-`:113`, predicate C at `:118`-`:124`, predicate D at `:127`-`:131`, and row-count notice at `:139`-`:140`. Cross-project read-only classification spot-check did not change project buckets: `claimguard -> claude 32`, legacy ClaimGuard buckets -> `claude 709 / orchestrator 77`, `pvb -> claude 1167 / orchestrator 438`, `termdeck -> claude 1486 / codex 9`; no `termdeck-dogfood` bucket exists in `memory_items`. Still open before GREEN: the earlier attribution-contract concern, plus the already-posted bundled-migration delivery requirement for 022.

### [T4-CODEX] AUDIT-CONCERN 2026-05-08 20:48 ET — T1 tests still do not cover actual PTY exit / panel-close wiring
Concern: T1's new tests are useful helper-level coverage, but they do not verify the actual close path the sprint asked us to prove. Every new acceptance test invokes `onPanelClose(session)` directly (`packages/server/tests/adapter-session-end-writer.test.js:179`, `:231`, `:264`, `:293`, `:328`, `:352`). The production wiring under review is one layer above that: `packages/server/src/index.js:1140` registers `term.onExit`, `:1163` calls `onPanelClose(session)`, and panel close goes through `DELETE /api/sessions/:id` at `:1353`-`:1363` (`session.pty.kill()` followed by `sessions.remove`). Root tests have the same helper-only shape (`tests/per-agent-hook-trigger.test.js:341`, `:377`). Required before full T1 GREEN: add at least one route/spawn-helper test that proves a killed PTY or DELETE/panel-close path reaches `onPanelClose` once, or explicitly downgrade the acceptance claim to helper coverage only.

### [T4-CODEX] AUDIT-CONCERN 2026-05-08 20:48 ET — migration tracker Case 3 still simulates only 001-020 despite bundled 021
Concern: the TermDeck bundle now includes `packages/server/src/setup/mnestra-migrations/021_project_tag_canonicalize_claimguard.sql`, and `packages/server/src/setup/migrations.js:123` adds a 021 probe, but the tracker backfill test still synthesizes only `001`-`020`. Evidence: `tests/migration-tracker.test.js:387`-`398` omits `021_project_tag_canonicalize_claimguard.sql`; `:439`-`:452` still expects only 18 backfilled rows; `:454`-`:460` still expects only tracker + 019 as applied; `:462`-`:463` still pins tracker total to 20. This lets the new 021 probe escape the most important pre-020 upgrade simulation. Required before GREEN: include 021 in Case 3's realFilenames and expected backfill/apply/tracker totals, with an explicit assertion for the 021 probe behavior.

### [T4-CODEX] CHECKPOINT 2026-05-08 20:50 ET
Phase: Phase 2 — worker WIP landed, post-landing audit in progress
Verified so far:
  - T1 helper-level tests run locally: `node --test packages/server/tests/adapter-session-end-writer.test.js` => 5/5 pass; `npm run test` => 45/45 pass; `node --test tests/per-agent-hook-trigger.test.js` => 14/14 pass.
  - T1 still lacks actual PTY exit / DELETE-panel-close coverage: production path is `packages/server/src/index.js:1140` and `:1163`, while new tests call `onPanelClose` directly at `packages/server/tests/adapter-session-end-writer.test.js:179`, `:231`, `:264`, `:293`, `:328`, `:352`.
  - T2 021 SQL executed cleanly under rollback earlier, and live DB now shows the canonicalized distribution (`claimguard=818`, no legacy ClaimGuard project buckets). `tests/project-tag-invariant.test.js` now un-defers the ClaimGuard invariant at `:75`-`:81`, and `node --test tests/project-tag-invariant.test.js` passes 5/6 with only the mnestra invariant still skipped.
  - T2 mirrored 021 into TermDeck's bundle and added a probe at `packages/server/src/setup/migrations.js:123`; `node --test tests/migration-loader-precedence.test.js tests/migration-tracker.test.js` passes 17/17, but Case 3 still omits 021 from the synthetic upgrade set.
  - T3 022 applies cleanly inside rollback with `A=560 B=4587 C=283 D=951 remaining_null=0 / 6483`, and rollback preserved live NULL count at `6381|6483`.
Pending:
  - T1: add route/spawn-helper coverage for DELETE/PTY kill reaching `onPanelClose` once, or downgrade the acceptance claim.
  - T2: update migration-tracker Case 3 for 021, or provide an equivalent pre-020 upgrade simulation that includes 021.
  - T3: resolve the attribution-contract concern and mirror 022 into TermDeck's bundled migrations/tests before GREEN.
Most recent worker post observed: [T1] DONE at 20:57 ET (as posted)

### [T4-CODEX] AUDIT-CONCERN 2026-05-08 20:51 ET — bundled 022 makes root migration tests red
Concern: `packages/server/src/setup/mnestra-migrations/022_source_agent_backfill.sql` is now bundled, but the loader/tracker tests still only expect 21 files and still model probes only through 021. Repro: `node --test tests/migration-loader-precedence.test.js tests/migration-tracker.test.js` exits 1 with three failures: `tests/migration-loader-precedence.test.js:53` expected the bundled list through 021 but actual includes 022, `:81` expects length 21 but actual is 22, and `:168` expects bundled length 21 in the stale-node_modules precedence test. Evidence in the file: `tests/migration-loader-precedence.test.js:53`-`:75` lists through 021 only, `:78`-`:105` pins 21 files, and the stale precedence assertion still uses 21. Required before GREEN: update the loader-precedence expectations to 22, and decide whether 022 needs a `MIGRATION_PROBES` entry or explicit null-probe/apply-path test coverage in `tests/migration-tracker.test.js`.

### [T4-CODEX] AUDIT-CONCERN 2026-05-08 20:52 ET — `include_null_source` is documented but not implemented
Concern: the revised 022 migration deliberately leaves 283 bare fact rows NULL and says they are reachable via `include_null_source=true` (`packages/server/src/setup/mnestra-migrations/022_source_agent_backfill.sql:84`-`:101`, `:176`, `:181`-`:182`), but the engram recall change only declares the flag and never uses it. Evidence: `~/Documents/Graciella/engram/src/recall.ts:111` sets `includeNullSource`, but `:164`-`:170` still filters `if (!agent) return false;` unconditionally, so NULL rows are still dropped even when the flag is true. The tests still only assert the old exclusion behavior at `~/Documents/Graciella/engram/tests/recall-source-agent.test.ts:192`-`:208`, and there is no new include-null test in the diff. Required before GREEN: change the filter to admit NULL rows when `include_null_source === true`, and add a unit test that fails on the current no-op implementation.

### [T4-CODEX] AUDIT-OK 2026-05-08 20:54 ET — T3 include-null behavior fixed; Mnestra tests/build green
Verified: `include_null_source` now reaches the MCP schema and implementation. `~/Documents/Graciella/engram/mcp-server/index.ts:274`-`:281` documents/adds the input, `:287`-`:294` forwards it into `memoryRecall`, and `~/Documents/Graciella/engram/src/recall.ts:164`-`:172` now returns `includeNullSource` for NULL-agent rows instead of unconditional false. New tests at `~/Documents/Graciella/engram/tests/recall-source-agent.test.ts:233`-`:250`, `:252`-`:261`, and `:263`-`:280` cover true, explicit false, and no-filter no-op. `npm run test` in engram passes 70/70; `npm run build` passes. Revised 022 rollback audit now reports `A=560 B=4587 D=951 remaining_null=283 / 6483` and rolls back cleanly. Remaining T3/TermDeck blocker: bundled 022 currently makes root migration loader tests red until expectations/probe coverage are updated.

### [T4-CODEX] AUDIT-OK 2026-05-08 20:57 ET — T2 loader red resolved; root migration/project-tag suite green
Verified: after T2's follow-up, `node --test tests/migration-loader-precedence.test.js tests/migration-tracker.test.js tests/project-tag-invariant.test.js tests/project-tag-resolution.test.js` passes 34/35 with the single intentional mnestra invariant skip. `tests/migration-loader-precedence.test.js:53`-`:76` and `:78`-`:106` now include both 021 and 022 and pin `listMnestraMigrations()` at 22 files; the stale node_modules precedence assertion also expects 22. T2's 021 tracker Case 3 fix is present at `tests/migration-tracker.test.js:390`-`:402`, `:445`-`:459`, and `:469`-`:483`. Remaining migration-runner gap is T3-owned: 022 is bundled but still absent from Case 3's synthetic upgrade set and has no `MIGRATION_PROBES` entry, so 022's apply/backfill branch is not yet tested there.

### [T4-CODEX] AUDIT-OK 2026-05-08 21:01 ET — T3 migration-runner coverage gap closed; 022 bundle/probe/tracker path green
Verified WIP before T3 posts FIX-LANDED: 022 now has a real TermDeck runner probe and Case 3 coverage. `packages/server/src/setup/migrations.js:125`-`:139` adds a NOT-EXISTS probe over only the A/B/D backfill targets, deliberately excluding Predicate C residual NULL rows so the probe can turn true after the intended partial backfill. `tests/migration-tracker.test.js:254`-`:272` now expects 21 probes including 022; `:390`-`:408` includes 022 in the synthetic pre-tracker bundled filename set; `:446`-`:505` expects 20 backfilled + 2 applied tracker rows and asserts 022 is backfilled, not applied, when the probe reports present. Verification: focused root suite `node --test tests/migration-loader-precedence.test.js tests/migration-tracker.test.js tests/project-tag-invariant.test.js tests/project-tag-resolution.test.js` passes 34/35 with the single mnestra invariant skip; root `npm run test` passes 45/45; engram `npm run test` passes 70/70; engram `npm run build` passes. `shasum -a 256` confirms engram and bundled TermDeck copies of both 021 and 022 are byte-identical. Remaining open blocker is T1 only: the PTY/DELETE close-path coverage concern from 20:48 is still unresolved in STATUS.

### [T4-CODEX] FINAL-VERDICT RED 2026-05-08 21:03 ET — block close-out: T1 lacks actual PTY/DELETE close-path coverage
Blocking concern: T1 is DONE but still proves only the exported helper, not the production close path under review. Evidence remains unchanged from the 20:48 concern: every new T1 writer assertion calls `onPanelClose(session)` directly (`packages/server/tests/adapter-session-end-writer.test.js:179`, `:231`, `:264`, `:293`, `:328`, `:352`), while production close wiring is one layer higher at `packages/server/src/index.js:1140` (`term.onExit`) and `:1163` (`onPanelClose(session)`), and user panel close goes through `DELETE /api/sessions/:id` at `packages/server/src/index.js:1353`-`:1363`. A current search shows route-level `/api/sessions` tests exist (`tests/failure-injection.test.js:41`-`:56`, `tests/flashback-e2e.test.js:59`, `:394`, `:431`, `:500`), but none assert the session-end writer fires from DELETE/PTY exit; writer tests remain helper-level (`tests/per-agent-hook-trigger.test.js:244`, `:264`, `:284`, `:304`, `:341`, `:377`; `packages/server/tests/adapter-session-end-writer.test.js` lines above). Required to unblock: add at least one route/spawn-helper test proving a killed PTY or DELETE/panel-close path reaches `onPanelClose` exactly once, or explicitly downgrade T1 acceptance to helper-only coverage. T2 and T3 audit concerns are resolved: 021/022 are mirrored into TermDeck bundle, probes/tracker Case 3 are green, root `npm run test` passes 45/45, engram `npm run test` passes 70/70, and engram `npm run build` passes.

### [T4-CODEX] FINAL-VERDICT GREEN 2026-05-08 21:54 ET — proceed with ORCH-owned close-out
Re-audit scope: T1 only; T2/T3 remain green from prior AUDIT-OK posts. The 21:03 RED blocker is resolved. Evidence: `packages/server/tests/adapter-session-end-writer.test.js:76`-`:134` injects fake `@homebridge/node-pty-prebuilt-multiarch` via `require.cache` before `../src/index.js` is required at `:138`, and production `packages/server/src/index.js:18` imports that module into the `pty` variable used by `spawnTerminalSession`. The positive close-path test at `packages/server/tests/adapter-session-end-writer.test.js:545`-`:600` boots a real `createServer(config)` server, POSTs `/api/sessions`, obtains the fake PTY by PID, fires `_emitExit`, and asserts exactly one spawned hook payload with `source_agent='codex'`, `sessionType='codex'`, matching session id, cwd, and Codex JSONL path; this exercises production registration at `packages/server/src/index.js:1095`-`:1118` and `term.onExit` at `:1140`-`:1163`. The DELETE route test at `packages/server/tests/adapter-session-end-writer.test.js:609`-`:645` drives HTTP DELETE; it exercises `packages/server/src/index.js:1353`-`:1364`, where `session.pty.kill()` runs before `sessions.remove`, and the fake `kill()` schedules the production onExit chain asynchronously. The negative shell test at `packages/server/tests/adapter-session-end-writer.test.js:653`-`:679` proves production exit wiring inherits the no-adapter early return at `packages/server/src/index.js:195`-`:197`. Config isolation is acceptable: `bootTestServer` uses inline config at `packages/server/tests/adapter-session-end-writer.test.js:484`-`:509` and does not call `loadConfig()`. Verification: `node --test packages/server/tests/adapter-session-end-writer.test.js` passes 8/8; `npm run test` passes 48/48. T1 production source check: `git diff -- packages/server/src/index.js packages/server/src/session.js packages/server/src/agent-adapters/codex.js` is empty; the only current `packages/server/src` diff is the settled T2/T3 `setup/migrations.js` change.

---

## Orchestrator close-out

### [ORCH] STAGED 2026-05-08 22:02 ET — Sprint 62 close-out staged in working trees, awaiting Joshua's Passkey publishes

**Wave bumps:**
- `@jhizzard/mnestra@0.4.7 → 0.4.9` (skipped 0.4.8 — staged but never published; combined into 0.4.9 with Sprint 62 work)
- `@jhizzard/termdeck@1.1.0 → 1.1.1`
- `@jhizzard/termdeck-stack@1.1.0 → 1.1.1` (audit-trail-only)

**Staged in working trees (uncommitted, no version-bump-side regressions; tests still green):**
- engram: `package.json` 0.4.9, `CHANGELOG.md` 0.4.9 entry (combined ws-polyfill + Sprint 62), `src/db.ts` ws-polyfill, `src/recall.ts` + `src/types.ts` + `mcp-server/index.ts` `include_null_source`, `tests/recall-source-agent.test.ts` 3 new tests, `migrations/021_*.sql` + `migrations/022_*.sql`. **70/70 tests pass.**
- termdeck: `package.json` 1.1.1, `CHANGELOG.md` 1.1.1 entry, `packages/client/public/app.js` paste-image fix, `packages/server/src/setup/migrations.js` `MIGRATION_PROBES` for 021+022, `tests/migration-loader-precedence.test.js` + `tests/migration-tracker.test.js` + `tests/project-tag-invariant.test.js` test updates, `packages/server/src/setup/mnestra-migrations/021_*.sql` + `022_*.sql` bundled mirrors (sha256-verified), `packages/server/tests/adapter-session-end-writer.test.js` 8 tests, `packages/stack-installer/package.json` 1.1.1, `packages/stack-installer/CHANGELOG.md` 1.1.1 audit-trail entry. **48/48 tests pass.**
- `docs/CRITICAL-READ-FIRST-2026-05-07.md` updated with Investigation 1 Resolution section (per the doc's own instruction).

**Pre-publish sanity (already run):**
- `npm run sync-rumen-functions` — clean (no diffs in `packages/server/src/setup/rumen/functions/`).
- `npm pack --dry-run` clean for all three packages: termdeck 422 KB / 118 files; termdeck-stack 51 KB / 9 files; mnestra 114 KB / 104 files.

**Publish sequence (Joshua, Passkey via `--auth-type=web` — NEVER `--otp`):**
1. `cd ~/Documents/Graciella/engram && npm publish --auth-type=web` → publishes `@jhizzard/mnestra@0.4.9`
2. `cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && npm publish --auth-type=web` → publishes `@jhizzard/termdeck@1.1.1`
3. `cd packages/stack-installer && npm publish --auth-type=web` → publishes `@jhizzard/termdeck-stack@1.1.1`

**After all three publish succeed:** orchestrator runs `git add` + `git commit` + `git push origin main` in both repos. Engram repo first (mnestra changes), then termdeck repo (Sprint 62 + paste-image + bundled mirrors). Never push before publish per `docs/RELEASE.md`.

**On any publish failure:** do NOT push. Fix and retry the publish, or `npm unpublish` (within 24h). Same lesson Sprint 35 close-out cost 10 min of npm-vs-origin/main skew.
