# Sprint 34 — Chopin-Nashville project-tag regression — fix

**Started:** 2026-04-26 22:00Z
**Pattern:** 4+1 orchestration. Four parallel Claude Code panels. Orchestrator (this conversation) integrates.
**Time-box:** 15–30 minutes.
**Inputs:** `docs/sprint-33-flashback-debug/POSTMORTEM.md` (read first), specifically T3's BROKEN-AT finding and the recommended Option A split.
**Outputs:** v0.7.2 patch release (writer-side fix + one-time backfill SQL script + verification probe), plus updated changelog narrative.

## The bug, in one paragraph

`resolveProjectName` in `packages/server/src/rag.js` is documented as "longest path-prefix wins." But `Mnestra bridge tags sessions with directory path segments instead of resolving against config.yaml project names` (memory from 2026-04-17 Sprint 22 audit, never fully fixed). For sessions in `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck`, something in the writer chain — bridge OR Rumen synthesis — emits `project='chopin-nashville'` instead of `project='termdeck'`. Rumen runs every 15 minutes, accumulating ~200 mis-tagged rows per week. Today's snapshot: 1,126 chopin-nashville rows of TermDeck content vs 68 correctly-tagged termdeck rows. The bridge's strict `WHERE project=filter_project` walls TermDeck panels off from their own memories.

v0.7.1 fixed the analyzer regex (Flashback now FIRES). v0.7.2 needs to make the toast CONTENT useful by fixing the tag.

## Lane assignments

| Tn | Lane | OWNS | OFF-LIMITS |
|----|------|------|------------|
| **T1** | Writer-side audit + fix | `packages/server/src/rag.js` (resolveProjectName, _projectFor), `packages/server/src/mnestra-bridge/index.js` (any tag-emission code), `packages/server/src/session.js` (only the project-resolution call sites — read-mostly), `tests/project-tag-resolution.test.js` (NEW), `~/Documents/Graciella/rumen/src/` (READ-ONLY — flag if a Rumen-side fix is needed) | T2/T3/T4 files |
| **T2** | Backfill SQL design | NEW `scripts/migrate-chopin-nashville-tag.sql`, NEW `docs/sprint-34-project-tag-fix/SQL-PLAN.md` (the dry-run plan + heuristic justification + reversibility note). Live SQL probes via DATABASE_URL from `~/.termdeck/secrets.env`, but **SELECTs only** — never run UPDATE without orchestrator + Josh approval | All source code, all other test files |
| **T3** | Verification probe + e2e | NEW `tests/project-tag-invariant.test.js` (SELECT probes, skips when no server), extend `tests/flashback-e2e.test.js` to cover a `meta.project='termdeck'` session and assert non-empty toast content | Source code, T2's SQL files |
| **T4** | Docs + version bump + integration | `CHANGELOG.md`, `packages/stack-installer/CHANGELOG.md`, `docs-site/src/content/docs/termdeck/changelog.md`, all `package.json` version bumps, NEW `docs/sprint-34-project-tag-fix/POSTMORTEM.md` | All source, all tests, T2's SQL files |

## Architectural decisions (locked)

### Writer-side fix (T1)
- The fix MUST land in `packages/server/src/` (TermDeck side). If T1 finds Rumen also emits the wrong tag, that's a Rumen-repo fix queued separately as `@jhizzard/rumen@0.4.4` — don't bundle into v0.7.2; just flag in STATUS.md.
- Heuristic: the canonical resolution in `rag.js:resolveProjectName(cwd, config)` is correct in design (longest-prefix wins). T1 should: (a) verify it actually does longest-prefix correctly (not first-match-wins), (b) verify EVERY writer call site uses it (not a side-channel that walks path segments), (c) add a regression test that pins `chopin-nashville` does NOT win over `termdeck` for a TermDeck-cwd session.
- If `mnestra-bridge/index.js` has a tag-emission path that bypasses `resolveProjectName`, route it through `resolveProjectName` instead. Don't reimplement; reuse.
- Add a `[tag]`-prefixed log line on every write so future regressions are observable: `[mnestra-bridge] writing memory project=<tag> cwd=<...>`.

### Backfill SQL (T2)
- **Dry-run first, always.** The SQL file's first statement is `BEGIN; SELECT count(*) ... ; ROLLBACK;`. The ACTUAL update is in a separately-marked block the user must uncomment to run.
- **Heuristic for "this chopin-nashville row is actually termdeck":** content keywords (case-insensitive ILIKE on TermDeck-specific identifiers like `'%@jhizzard/termdeck%'`, `'%termdeck-stack%'`, `'%packages/server/src%'`, etc), source_session_id linked to TermDeck sessions, source_file_path under termdeck/. Combine with OR — if any branch matches, classify as termdeck.
- **Reversibility:** add a `UPDATE memory_items SET metadata = jsonb_set(coalesce(metadata,'{}'),'{rebrand_v0_7_2_from}', to_jsonb(project))` BEFORE flipping `project`. So we can revert with `UPDATE memory_items SET project = metadata->>'rebrand_v0_7_2_from' WHERE metadata ? 'rebrand_v0_7_2_from'` if the heuristic mis-classifies.
- **Pre-flight count must be posted to STATUS.md** before any UPDATE is even considered. Josh approves over chat or in person before execution.

### Verification (T3)
- New test file `tests/project-tag-invariant.test.js`. Skips when no live DATABASE_URL (same pattern as `failure-injection.test.js`). When alive, asserts:
  - `count(*) by project` distribution looks sane (no project has >50% of total unless that's the dominant developer project)
  - Content-vs-tag invariant: `SELECT project, count(*) FROM memory_items WHERE content ILIKE '%termdeck%' GROUP BY 1 ORDER BY 2 DESC LIMIT 1` returns `termdeck` (not `chopin-nashville`)
- Extend `flashback-e2e.test.js` with a second-test variant that creates a session with `meta.project='termdeck'`, triggers the canonical error, and asserts `proactive_memory` frame received with non-empty `memories` array. (T1's v0.7.1 unblocked this; T3's v0.7.2 corpus fix should make it surface real content.)

## Coordination protocol

Same as Sprint 33. Append to `docs/sprint-34-project-tag-fix/STATUS.md`:

- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] CLAIM <file>` — before edit
- `[Tn] FINDING — <CONFIRMED-OK | BROKEN-AT | AMBIGUOUS>: <evidence>`
- `[Tn] FIX-PROPOSED — <description, LOC, safety>`
- `[Tn] DONE — <one-line>`
- `[Tn] BLOCKED — <reason>` (especially if T2 needs orchestrator approval to run UPDATE)
- `[Tn] HANDOFF to <Tn> — <what's now safe>`

Use `date -u +%Y-%m-%dT%H:%M:%SZ`.

## Acceptance criteria

v0.7.2 ships when ALL of:
- T1: writer-side fix landed; new test pins `chopin-nashville` cannot win over `termdeck` for a TermDeck-cwd session; all v0.7.1 tests still green.
- T2: backfill SQL script written, reviewed, dry-run pre-flight count posted to STATUS.md. Whether the UPDATE is RUN against the live store is an orchestrator+Josh decision after sprint convergence — the sprint can ship the script even if the UPDATE itself happens later.
- T3: invariant probe test green (skips gracefully without live server); flashback-e2e extension green when run against a corrected corpus.
- T4: CHANGELOG entries written; @jhizzard/termdeck 0.7.1→0.7.2; stack-installer 0.3.1→0.3.2; POSTMORTEM written.
- Full CLI suite (excl. live-server contract tests): green, ≥110 tests.

## Out of scope (defer)

- Mnestra-side schema change to add a `project_resolved_at` audit column. Bigger lift; not blocking.
- Rumen-MCP NULL `source_session_id` gap. Separate sprint.
- Migration-001 idempotency. Separate sprint.
- v0.8 features (drag-drop, image paste, theme picker overhaul).

## Reference memories
- `memory_recall("chopin-nashville tag bug Mnestra bridge directory path segments")` — Sprint 22 first-pass diagnosis
- `memory_recall("resolveProjectName longest prefix")` — the correct algorithm
- `memory_recall("Rumen synthesis project tag")` — whether Rumen is also a writer
- `memory_recall("v0.7.1 PATTERNS.shellError")` — yesterday's analyzer fix (just shipped)
