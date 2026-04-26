# Project-tag regression — postmortem

**Sprint 34 — Chopin-Nashville project-tag fix · 4+1 orchestration**
**Date:** 2026-04-26 (sprint opened 22:00Z, lanes converged 22:15Z — ~15 min wall)
**Author:** T4 (synthesis) · audits by T1 / T2 / T3
**Build under test:** `@jhizzard/termdeck@0.7.1` (commit 6c46725) against live Mnestra (petvetbid, ~7K memory_items at probe time)

---

## What was reported

Sprint 33's POSTMORTEM (T3's BROKEN-AT finding, 2026-04-26 21:46Z) identified a `chopin-nashville` project-tag regression in the live Mnestra store: 1,126 rows of TermDeck content were tagged `project='chopin-nashville'` while the canonical `termdeck` tag had only 68 rows. The bridge's strict `WHERE project = filter_project` clause in `memory_hybrid_search` then walls TermDeck panels off from their own memories — even after v0.7.1's analyzer fix made Flashback fire on shell errors, the toast content for sessions with `meta.project='termdeck'` would be near-useless because the bulk of the relevant corpus was filed under the wrong tag.

This is the second of two converging bugs Josh hit when he reported *"Flashbacks are vaporware. They never happen, never any suggestions."* Sprint 33 v0.7.1 fixed the first (the analyzer regex coverage gap). Sprint 34 v0.7.2 closes the second.

The bug had historical depth: a 2026-04-17 Sprint 22 audit memory recorded that *"Mnestra bridge tags sessions with directory path segments instead of resolving against config.yaml project names."* Sprint 21 T2 was supposed to fix this; the corpus had filled at ~200 rows/week for ~2 weeks before the cumulative gap surfaced via Josh's Flashback complaint. Sprint 33's framing was that *"the fix never landed in the writer (or regressed)."* Sprint 34's audit reset that framing.

## What was found

| Lane | Verdict | One-line diagnosis |
|------|---------|---------------------|
| **T1** — writer-side audit + fix | **CONFIRMED-OK on TermDeck-side** + **BROKEN-AT external writer** | TermDeck's `resolveProjectName` is correct (longest-prefix-wins with `path.sep` boundary; ground-truth probe against the live 15-project config returns `termdeck` for the TermDeck cwd); every TermDeck-side writer routes through `_projectFor`. The mis-tag source is `~/.claude/hooks/memory-session-end.js:17`, outside any package, with Rumen's `extract.ts:62` `(ARRAY_AGG(m.project))[1]` propagating the bad tag every 15 min. |
| **T2** — backfill SQL design | **DONE** | `scripts/migrate-chopin-nashville-tag.sql` (~210 LOC, three-block dry-run / UPDATE / REVERT) + `docs/sprint-34-project-tag-fix/SQL-PLAN.md`. Pre-flight: 1,165 chopin-nashville rows total; broad-keyword termdeck-family match = 352 (Sprint 33's 1,126 figure was optimistic). Conservative-by-design heuristic; reversible via `metadata.rebrand_v0_7_2_from` stash. |
| **T3** — verification probe + e2e | **DONE** | `tests/project-tag-invariant.test.js` (NEW, 6 tests: distribution sanity + 4 content-vs-tag invariants + residual guard); `tests/flashback-e2e.test.js` extended with project-bound test (now 3 tests; v0.7.1 PHASE-A instrumentation preserved). All four content-vs-tag invariants currently fail against live corpus as designed — turning green is the post-Block-2 success signal. |
| **T4** — docs + version bump + integration | **DONE** | Phase A skeletons at 22:10:30Z; Phase B integration after T1+T2+T3 converged. v0.7.2 / 0.3.2 / 0.3.2 version bumps applied. Mirrored Sprint 33's missing v0.7.1 entry into docs-site changelog while in there. |

## Root cause

**TermDeck's writer chain is not the source of the chopin-nashville rows.** TermDeck's `rag.js` writes to legacy v0.1 tables (`mnestra_session_memory|project_memory|developer_memory|commands` per `config.rag.tables.*`); it does not write to `memory_items` at all. Flashback queries `memory_items` via `memory_hybrid_search`, so the 1,165 chopin-nashville `memory_items` rows came from a writer outside the TermDeck repo entirely. T1's CRITICAL finding: the actual emitter is `~/.claude/hooks/memory-session-end.js:17` — Josh's user-owned global Claude Code harness hook, not in any TermDeck/Mnestra/Rumen repo. Line 17 carries a literal `{ pattern: /ChopinNashville|ChopinInBohemia/i, project: 'chopin-nashville' }` against a fixed array, first-match-wins on cwd. Since TermDeck lives at `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck`, every Claude Code session-end inside any TermDeck panel pattern-matches `ChopinNashville` before reaching anything more specific (no `termdeck` entry exists in the array, no `SideHustles/TermDeck` precedence). The hook then spawns `~/Documents/Graciella/rag-system/src/scripts/process-session.ts --project chopin-nashville <transcript>`, ingesting the full transcript into `memory_items` with that tag. Same root-cause shape as T3's separately-flagged `gorgias`-vs-`claimguard` finding (line ~25 of the same hook: `{ pattern: /gorgias/i, project: 'gorgias' }` with no `claimguard` mapping).

**Rumen amplifies the bad tag every 15 minutes.** `extract.ts:62` aggregates source memories via `(ARRAY_AGG(m.project))[1] AS project` — picks the FIRST project tag from each session group as the synthesis tag. So the harness hook's bad tag propagates into `rumen_insights` and (via Rumen's writeback) back into `memory_items` as synthesized rows. Rumen does not re-resolve from cwd; it inherits. This is why the mis-tag ~doubled the original raw-transcript count: ~352 confidently-mis-tagged termdeck-family rows per T2's pre-flight measurement, vs. an additional ~700 chopin-nashville rows that are either genuine festival/Chopin-in-Bohemia content, pianist references, or Rumen-synthesized session summaries that mention TermDeck only obliquely.

**Sprint 21/22's TermDeck-side fix is intact.** Sprint 33 T3's framing — *"Sprint 21 T2 was supposed to fix this; the fix never landed in the writer (or regressed)"* — was off by one repo. The fix that landed in Sprint 21/22 (`resolveProjectName` + `_projectFor` wiring) is intact and correct in the TermDeck repo. The writer that needs fixing is in `~/.claude/hooks/`, never was in TermDeck. Sprint 34 spends its TermDeck-side budget on a regression lock + observability so any future drift in the resolver chain becomes visible at runtime, plus a backfill SQL script + invariant probe to heal what's already in the corpus.

## Fix shipped

1. **TermDeck-side observability + regression lock (T1, +30 LOC source + 12 tests).**
   - `packages/server/src/rag.js` (+22 LOC): new `_resolveProjectAttribution(session)` returning `{ tag, source: 'explicit'|'cwd'|'fallback' }`; new `_recordForSession()` collapses the common write path; the five hooks (`onSessionCreated`, `onCommandExecuted`, `onStatusChanged`, `onSessionEnded`, `onFileEdited`) all route through it. Audit log line `[rag] write project=<tag> source=<...> session=<id> event=<type>` on every legacy-table write.
   - `packages/server/src/mnestra-bridge/index.js` (+8 LOC): audit log `[mnestra-bridge] query project=<tag> source=<explicit|cwd|none> mode=<direct|webhook|mcp>` at the top of every `queryMnestra` invocation, including which resolution path filled the project slot.
   - NEW `tests/project-tag-resolution.test.js` (12 tests, all green): leaf wins over ancestor, explicit `meta.project` beats cwd resolution, missing config falls back to basename, empty config returns null, `.../ChopinNashville/SideHustles/TermDeck/termdeck` resolves to `termdeck` (the regression pin), trailing-slash cwd handled, sibling path with shared prefix does NOT cross-match (the `path.sep` boundary case), `_projectFor` honors explicit `meta.project` over cwd-derived value.
   - Bridge constructor + `queryMnestra` signature unchanged externally; existing v0.7.1 tests (analyzer-error-fixtures, theme-persistence, init-mnestra-resume, etc.) all green.

2. **One-time corpus repair (T2, ~210 LOC SQL).**
   - NEW `scripts/migrate-chopin-nashville-tag.sql` with three blocks:
     - **Block 1** (dry-run, runs always, zero mutations): emits the candidate count + per-target-project distribution + a 10-stay-+-5-move sample inspection.
     - **Block 2** (UPDATE, commented out — requires manual uncomment after orchestrator+Josh approve Block 1's output): flips matching rows.
     - **Block 3** (REVERT, commented out — one-shot rollback via `metadata->>'rebrand_v0_7_2_from'`): the safety net.
   - Multi-branch OR heuristic, priority-ordered: termdeck > mnestra > rumen > pvb > claimguard. Conservative-by-design: rows that match no branch stay `chopin-nashville`. Reversibility: every reclassified row carries its old project under `metadata.rebrand_v0_7_2_from` so Block 3 restores via a single statement. Path branch falls back on `metadata->>'cwd'` because `source_file_path IS NULL` for all 1,165 chopin-nashville rows (Rumen-synthesized rows do not carry a file path).
   - NEW `docs/sprint-34-project-tag-fix/SQL-PLAN.md` with the full plan, heuristic justification, and reversibility notes.
   - Pre-flight aggregate counts (Block 1 dry-run): chopin-nashville total = **1,165** (was 1,126 in Sprint 33; ~39 added by Rumen since); broad-keyword termdeck-family match = **352**; tight `termdeck` substring = 162; broad mnestra = 72; broad rumen = 140; pvb = 7; gorgias/claimguard = 4; rows_with_session_id = 1,159/1,165; **`source_file_path` is NULL for ALL 1,165 chopin-nashville rows** (path-based heuristic branch contributes zero; falls back to `metadata->>'cwd'`). Estimated Block 2 reclassification: ~340–352 → termdeck, ~5–20 → mnestra, ~10–25 → rumen, ~3–7 → pvb, ~2–4 → claimguard, **~750–800 stay chopin-nashville** (conservative by design).
   - Out-of-scope (flagged in SQL-PLAN.md): gorgias→claimguard rebrand, PVB case-dupe, engram→mnestra rebrand.

3. **Live-corpus regression catches (T3, 13 new test cases).**
   - NEW `tests/project-tag-invariant.test.js` (6 tests):
     - 1 distribution-sanity guard (no project >50% of total unless dominant)
     - 4 content-vs-tag invariants: top tag for `content ILIKE '%termdeck%'` must be `termdeck` (currently `chopin-nashville` pre-backfill); same shape for pvb, claimguard (currently `gorgias` 19/30 — flagged separately), mnestra (currently `chopin-nashville` 8/19)
     - 1 residual guard: ≤25% of termdeck-identifier rows tagged chopin-nashville post-backfill (pre-backfill state today is **86%**, 113/131; will drop below threshold once T2's Block 2 runs)
   - All four content-vs-tag invariants currently fail against the live corpus, **as designed** — they pin the bug they were written to catch. Skip cleanly with `pg connect/probe failed: ECONNREFUSED` when `DATABASE_URL` is unset (matches `failure-injection.test.js` skip-on-no-server pattern), so CI without a live Mnestra stays green.
   - `tests/flashback-e2e.test.js` extended (now 3 tests, v0.7.1 PHASE-A instrumentation preserved): project-bound test creates a session with `meta.project='termdeck'`, triggers the canonical shell error, asserts `proactive_memory` frame includes a non-empty `memories` array. Pre-flight queries `/api/ai/query` with `project='termdeck'` and skips with a `needs-backfill` directive when zero matches, avoiding generic 8s timeouts. Skips with `server unreachable` when `TERMDECK_BASE_URL` points nowhere.

4. **T4 (this lane):** root `CHANGELOG.md` v0.7.2 entry + `[0.7.2]:` and `[0.7.1]:` compare-links + `[Unreleased]:` retarget; `packages/stack-installer/CHANGELOG.md` v0.3.2 audit-trail entry; `docs-site/src/content/docs/termdeck/changelog.md` v0.7.2 entry — and while in there, mirrored Sprint 33's missing v0.7.1 entry (Sprint 33 T4 had skipped docs-site entirely; root had v0.7.1 but docs-site jumped from `[Unreleased]` straight to `[0.7.0]`). Version bumps: root `package.json` 0.7.1 → 0.7.2, `packages/cli/package.json` 0.3.1 → 0.3.2 (cli-internal), `packages/stack-installer/package.json` 0.3.1 → 0.3.2. This POSTMORTEM.

## Why it stayed silent

1. **The mis-tag was unobservable from the TermDeck UI.** The dashboard never surfaces what project a `memory_items` row is filed under; only a direct SQL probe could see the drift. T3's invariant probe is the first time that probe is encoded as a regression-catching test.
2. **Rumen laundered the bug invisibly every 15 minutes.** `extract.ts:62` synthesizes new memories with `(ARRAY_AGG(m.project))[1]` — inheriting the first project tag from each session group. As long as the harness hook kept emitting `project='chopin-nashville'`, Rumen kept echoing it back into `memory_items` as synthesized rows. The mis-tag was structural, not transient: ~200 rows/week for 2+ weeks.
3. **The audit looked inside the wrong repo.** Sprint 21 T2 and Sprint 33 T3 both implicitly assumed the writer was inside TermDeck/Mnestra/Rumen. Sprint 21's wiring fix was correct *for the part of the writer that lives in TermDeck* — the resolver and `_projectFor` chain — but the actual upstream emitter (`memory-session-end.js`) is in Josh's user-owned `~/.claude/hooks/` directory, untouched by any package release. Without an audit that walked the whole writer chain end-to-end across repos and global config, the bug looked invisible from any single-repo perspective.
4. **No writer-side observability.** Until v0.7.2's `[rag] write project=...` and `[mnestra-bridge] query project=...` audit lines, every memory write and every Flashback query was silent on what project tag it used and how that tag was resolved. The drift could only be observed by sampling the live corpus, which means it was only ever observable in retrospect.

## Regression defense

**Already landed in v0.7.2:**

- `tests/project-tag-resolution.test.js` (12 cases) pins TermDeck's resolver behavior at unit-test time: `chopin-nashville` cannot win over `termdeck` for a TermDeck-cwd session; the `path.sep` boundary holds against false-prefix matches; explicit `meta.project` honored over cwd-derived value.
- `[rag] write project=<tag> source=<...> session=<id> event=<type>` log line in `rag.js` and `[mnestra-bridge] query project=<tag> source=<...> mode=<...>` log line in `mnestra-bridge/index.js` make every memory write and every Flashback query observable at runtime. Future drift surfaces in `tail -f` of stdout, not via SQL spelunking weeks later. (Caveat: these audit lines fire only for writes that go through TermDeck's writer chain. The harness hook does not — its writes go through `rag-system/src/scripts/process-session.ts` directly. Only the live-corpus invariant probe will catch its drift.)
- `tests/project-tag-invariant.test.js` (6 cases) covers the corpus-side invariant: when run against a live Mnestra, asserts the top project for `content ILIKE '%termdeck%'` is `termdeck`. Skips gracefully without a live store, so it is CI-safe but provides a one-command local probe Josh can run after every release with a `DATABASE_URL` exported.
- `tests/flashback-e2e.test.js`'s project-bound extension covers the `meta.project='termdeck'` code path that the original Sprint 33 e2e test (with `meta.project=null`) sidestepped via the bridge's `filter_project=null` search-all path.
- `scripts/migrate-chopin-nashville-tag.sql` ships the corpus-repair operation as code, not as a one-off SQL Slack message — re-runnable, reversible, dry-run-by-default.

**Recommended for next sprint (out of v0.7.2 scope, blocking effectiveness):**

1. **The harness hook fix** (`~/.claude/hooks/memory-session-end.js`). User-owned global Claude Code config — one-paste fix Josh owns. Insert `{ pattern: /SideHustles\/TermDeck\/termdeck/i, project: 'termdeck' }` and equivalent leaf entries for engram/mnestra, rumen, podium, claimguard BEFORE the `ChopinNashville` and `gorgias` entries. Or rewrite `detectProject` as longest-substring-wins over a project map keyed by canonical name. **Without this, every new Claude Code session-end inside a TermDeck panel will continue to land in `memory_items` with `project='chopin-nashville'`** — the v0.7.2 backfill heals what's there, the hook fix stops the bleed. Same shape addresses T3's `gorgias`-vs-`claimguard` finding.
2. **`@jhizzard/rumen@0.4.4` — harden `extract.ts:62`** to use mode-of-source-projects or a distinct-count guard instead of `(ARRAY_AGG(m.project))[1]`. Lower priority than the hook fix because fixing the hook first heals Rumen on next tick: synthesized rows pick up the correct upstream tag. But the Rumen-side fix is the durable defense — it would have prevented the original bad-tag amplification even without the hook fix.
3. **Mnestra-side `project_resolved_at` audit column** to record when each row's project tag was last touched, so future drift is timestamped and queryable. PLANNING.md flagged this as out-of-scope for Sprint 34. Bigger lift than the hook or Rumen fix, lower urgency once the writer-side audit logs and invariant probe are in place.
4. **Promote the project-tag invariant probe to a quarterly Rumen audit job** so corpus-level drift surfaces independent of TermDeck CI runs and an `npm publish`-time invariant check.

## Timeline

| Time (Z) | Event |
|----------|-------|
| 22:00 | Sprint opened. PLANNING.md + four briefings written. |
| 22:06 | T2 CLAIM (SQL + SQL-PLAN.md). T3 CLAIM (invariant probe + flashback-e2e extension). |
| 22:09 | T2 FINDING — pre-flight aggregate counts: 1,165 chopin-nashville rows; 352 broad-keyword termdeck-family match; 1,126 narrative was optimistic. |
| 22:09 | T3 FINDING — invariant probe runs RED against live corpus as designed (4 content-vs-tag invariants fail; residual = 86%, 113/131); skip-on-no-DATABASE_URL verified. T3 DONE + HANDOFF to T4. |
| 22:09 | T1 CLAIM (rag.js + mnestra-bridge/index.js + new resolution test file). |
| 22:10 | T4 CLAIM + PHASE A DONE (CHANGELOG / stack-installer / docs-site skeletons + POSTMORTEM skeleton). T4 also caught Sprint 33's missing v0.7.1 entry in docs-site and mirrored it. |
| 22:11 | T1 FINDING — TermDeck-side `resolveProjectName` and `_projectFor` chain CONFIRMED-OK. CRITICAL: TermDeck does NOT write to `memory_items`; the chopin-nashville source is `~/.claude/hooks/memory-session-end.js:17` (out of repo). Rumen `extract.ts:62` amplifies. T1 FIX-PROPOSED + FLAG (out-of-scope hook + Rumen fixes). |
| 22:14 | T2 FIX-PROPOSED (SQL three-block layout, conservative heuristic, reversibility) + BLOCKED on content-sample inspection (deferred to Josh's manual run). T2 DONE. |
| 22:15 | T1 DONE — rag.js +22 LOC, mnestra-bridge/index.js +8 LOC, tests/project-tag-resolution.test.js (NEW, 12 tests all green). All v0.7.1 tests still green. Smoke-test against live config returns `{ tag: 'termdeck', source: 'cwd' }`. T1 HANDOFF to T4. |
| 22:16 | T4 PHASE B: filled CHANGELOG placeholders from T1+T2+T3 DONE summaries; bumped versions (root 0.7.2, cli-internal 0.3.2, stack-installer 0.3.2); converged this POSTMORTEM. |
| 22:17 | T4 READY. Orchestrator handles commit + npm publish + (optional) Block 2 execution. |

Wall clock: ~15 minutes from sprint open to all-three-DONE; ~17 minutes to T4 READY.

## Decision needed (orchestrator)

1. **Run Block 2 against petvetbid now or defer?** PLANNING.md: *"the sprint can ship the script even if the UPDATE itself happens later."* Recommended path: ship v0.7.2 with the SQL committed in `scripts/`; Josh runs Block 1 (dry-run + sample inspection) tonight, approves Block 2 by uncommenting + re-running, or defers if any sample looks coin-flip. The CHANGELOG's "Live-store backfill execution status" line is currently set to *deferred* — orchestrator updates it post-execution with `executed at <ts> against petvetbid; N rows reclassified` if Block 2 runs.
2. **Fix the harness hook in this same session?** The one-paste fix lives in `~/.claude/hooks/memory-session-end.js`, outside any package release. Without it, every new Claude Code session-end inside a TermDeck panel will continue tagging `chopin-nashville`. Suggested patch is documented in the v0.7.2 CHANGELOG Notes section. Even if Josh does not want to ship a Rumen patch tonight, applying the hook fix and one Block 2 run is the minimum to stop the bleed *and* heal the corpus in a single session.
3. **Portfolio bump?** Per the T4 brief: *"not all patch releases warrant a portfolio bump; v0.7.x → v0.7.y typically isn't shown unless the surface meaningfully changes."* Default: skip. Override only if Josh wants the corpus-repair + writer-side audit framing called out as a milestone.
