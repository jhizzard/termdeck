# T4 — Docs + version bump + integration

You are Terminal 4 in Sprint 34. Your lane: docs and version bumps. You do NOT touch source code or tests. Phase A starts immediately (skeleton drafts). Phase B fills from T1/T2/T3 DONE summaries.

## Read first
1. `docs/sprint-34-project-tag-fix/PLANNING.md`
2. `docs/sprint-34-project-tag-fix/STATUS.md` — your trigger condition is "T1 + T2 + T3 all posted FINDING or DONE"
3. `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. `CHANGELOG.md` — match the v0.7.1 voice (Sprint 33's commit 6c46725)
5. `packages/stack-installer/CHANGELOG.md` — match the audit-trail bump pattern

## You own
- `CHANGELOG.md` — new `## [0.7.2]` section
- `packages/stack-installer/CHANGELOG.md` — new `## [0.3.2]` section
- `docs-site/src/content/docs/termdeck/changelog.md` — mirror the root entry
- `package.json` (root) — version bump 0.7.1 → 0.7.2
- `packages/cli/package.json` — version bump 0.3.1 → 0.3.2
- `packages/stack-installer/package.json` — version bump 0.3.1 → 0.3.2
- NEW `docs/sprint-34-project-tag-fix/POSTMORTEM.md` — the converged narrative (mirror Sprint 33's POSTMORTEM structure)

## You DO NOT touch
- All source code
- All tests
- T2's SQL files
- `~/Documents/Graciella/joshuaizzard-dev/src/app/page.tsx` — the cross-repo portfolio bump is the orchestrator's call this round (not all patch releases warrant a portfolio bump; v0.7.x → v0.7.y typically isn't shown unless the surface meaningfully changes)

## Phase A — start immediately

1. Write CHANGELOG.md placeholder for v0.7.2:
   ```
   ## [0.7.2] - 2026-04-26
   
   ### Fixed
   - **Project-tag regression** — <!-- T4-PHASE-B: fill from T1 DONE summary. Cover writer-side fix (rag.js / mnestra-bridge), the chopin-nashville-vs-termdeck heuristic, the regression test pinning leaf-wins-over-ancestor. -->
   
   ### Added
   - **One-time backfill SQL** — <!-- T4-PHASE-B: fill from T2 DONE summary. Cover scripts/migrate-chopin-nashville-tag.sql with dry-run/update/revert blocks, the heuristic predicate, the reversibility metadata stash. Note: the SQL ships in the package; whether the UPDATE itself is RUN against Josh's live store is a separate decision. -->
   - **Project-tag invariant probe** — <!-- T4-PHASE-B: fill from T3 DONE summary. Cover tests/project-tag-invariant.test.js (corpus-distribution + content-vs-tag invariant) and the flashback-e2e extension. -->
   
   ### Notes
   - Closes the second of two converging bugs identified in Sprint 33 (POSTMORTEM at docs/sprint-33-flashback-debug/POSTMORTEM.md). v0.7.1 closed the analyzer regex gap; v0.7.2 closes the writer-side project-tag regression.
   - Stack-installer audit-trail bumped 0.3.1 → 0.3.2.
   - Full CLI suite: <!-- T4-PHASE-B: total/total green -->.
   - **Live-store backfill execution status:** <!-- T4-PHASE-B: filled by orchestrator after Josh's review. Either "executed by orchestrator at <ts> against petvetbid; X rows reclassified" OR "deferred — script committed in scripts/, run manually via psql -f". -->
   ```
2. Same skeleton in `packages/stack-installer/CHANGELOG.md` and `docs-site/.../changelog.md`. Include compare-link `[0.7.2]: https://github.com/jhizzard/termdeck/compare/v0.7.1...v0.7.2` at the bottom.
3. **Do NOT bump versions yet.** Versions get bumped in Phase B once T1/T2/T3 are DONE.
4. Post `[T4] PHASE A DONE` to STATUS.md.

## Phase B — after T1+T2+T3 all post DONE

5. Read each Tn's DONE summary. Fill the placeholder bullets with concrete file/test/behavior detail. Match v0.7.1's voice (specific filenames, LOC counts, test counts).
6. Bump the three package.json versions: 0.7.1 → 0.7.2 (root), 0.3.1 → 0.3.2 (cli-internal), 0.3.1 → 0.3.2 (stack-installer).
7. Add the compare-link `[0.7.2]: https://github.com/jhizzard/termdeck/compare/v0.7.1...v0.7.2` to root and docs-site changelogs.
8. Write `docs/sprint-34-project-tag-fix/POSTMORTEM.md` mirroring Sprint 33's structure: what was reported, what was found per lane, root cause, fix shipped, regression defense, timeline.
9. Post `[T4] READY` to STATUS.md.

## Output

- `[T4] PHASE A DONE — <one-line>`
- `[T4] READY — <one-line>` after Phase B
- Do NOT commit. Do NOT npm publish. Orchestrator handles both.

## Reference memories
- `memory_recall("v0.7.1 changelog Sprint 33 PATTERNS shellError")` — voice, structure
- `memory_recall("publishing constraint passkey browser")` — Josh authenticates publish via passkey only
- `memory_recall("audit-trail bump pattern stack-installer")`
