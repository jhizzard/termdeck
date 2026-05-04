# Sprint 51.6 — T3 (Claude): Fix the bug + ship v1.0.2 wave

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T3):**

Implement the fix for whatever T1+T2 surface as the memory_sessions write failure. Bundle into a v1.0.2 hotfix wave. The exact deliverables depend on the bug class — T2's "Hypothesis grid" maps to T3's path.

## Sequencing

T3 starts AFTER T1 and T2 post DONE. Don't begin code changes until both are clear on the failure mode. If the orchestrator calls a stand-down because the bug turns out to be already-fixed-by-mig-015 (i.e., next /exit will write memory_sessions cleanly because the column came back), T3 closes with "no v1.0.2 needed" and the wave is skipped.

## Possible fix paths

### Path A: Schema migration needed (mig 017)

If T2 identifies a schema gap — column missing, NOT NULL without default, etc — and the right fix is a migration:

1. Author `~/Documents/Graciella/engram/migrations/017_<descriptive-name>.sql`. Idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Test apply against a clean DB and against an existing DB with partial state.
2. Sync into bundled: `cp ~/Documents/Graciella/engram/migrations/017_*.sql packages/server/src/setup/mnestra-migrations/`.
3. Extend `packages/server/src/setup/audit-upgrade.js` PROBES list — add a new probe for the new column/RPC/whatever 017 ships. Mirror the existing 7-probe pattern.
4. Add a regression test in `tests/audit-upgrade.test.js` covering the new probe.
5. Update `tests/migration-loader-precedence.test.js` count assertion 16 → 17.
6. Bump versions:
   - `~/Documents/Graciella/engram/package.json`: 0.4.1 → 0.4.2 (mnestra ships the migration)
   - `package.json` (termdeck root): 1.0.1 → 1.0.2 (audit-upgrade extension)
   - `packages/stack-installer/package.json`: 0.6.1 → 0.6.2 (audit-trail)
   - rumen unchanged

### Path B: Hook code bug

If T2 identifies the hook is sending the wrong shape (writing to a removed column, missing a required field, etc):

1. Fix `packages/stack-installer/assets/hooks/memory-session-end.js`. Keep the change minimal and well-commented.
2. Add a unit test at `packages/stack-installer/tests/memory-session-end.test.js` (or extend if it exists) that exercises the fixed code path. Mock the Supabase REST client; assert the INSERT body shape is correct.
3. Bump versions:
   - `~/Documents/Graciella/engram/package.json`: NO bump (no schema change)
   - `package.json` (termdeck root): NO bump (no termdeck CLI/server change unless audit-upgrade also needs an update)
   - `packages/stack-installer/package.json`: 0.6.1 → 0.6.2 (the hook bundles here)
   - Wave is just `@jhizzard/termdeck-stack@0.6.2`

### Path C: Both schema AND hook

If the bug is multi-layer (schema gap + hook code bug), do both A + B paths in order. Wave is the full v1.0.2 package set.

## CHANGELOG

Add `## [1.0.2] - 2026-05-04` block (or whatever date when ship lands) at the top of `CHANGELOG.md`. Sections:
- **Fixed** — `memory_sessions` write path (Bug #2 from Sprint 51.5 dogfood discovery; full investigation in `docs/sprint-51.6-memory-sessions-hook-fix/`).
- **Notes** — link to ledger entry #15 in `docs/INSTALLER-PITFALLS.md` (T4 Codex appends after sprint close).

## Test suite gate

- `node --test tests/*.test.js` must report ≥950 pass (Sprint 51.5 baseline + any T3 additions).
- `cd packages/stack-installer && npm test` (if it has its own suite) must pass.
- The 22 pre-existing project-taxonomy.test.js failures are now relevant — those tests directly exercise the broken hook. **If T3's fix is correct, some of those 22 should now pass.** Document the new pass count in DONE — that's a strong signal the fix is real.

## npm pack verification

```bash
cd packages/stack-installer && npm pack --dry-run | grep -E 'memory-session-end' | head -5
cd ../.. && npm pack --dry-run | grep -E '01[5-7]_|audit-upgrade' | head -10
```

Confirm the new artifacts ship in tarballs.

## Publish (orchestrator-facing — Joshua's Passkey)

After T3 stages all changes, posts FIX-PROPOSED, and the orchestrator (this terminal) verifies, the publish wave runs the same pattern as Sprint 51.5:

```bash
# Path A or C — mnestra ships first
cd ~/Documents/Graciella/engram && git add -A && git commit -m "v0.4.2: Sprint 51.6 — migration 017 ..." && npm publish --auth-type=web

# All paths — termdeck-stack
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && git add -A && git commit -m "v1.0.2: Sprint 51.6 — bundled hook memory_sessions fix ..." && npm publish --auth-type=web
cd packages/stack-installer && npm publish --auth-type=web

# Push origin
cd ~/Documents/Graciella/engram && git push origin main
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && git push origin main

# Verify
npm view @jhizzard/mnestra version          # expect 0.4.2 (Path A or C)
npm view @jhizzard/termdeck-stack version   # expect 0.6.2
npm view @jhizzard/termdeck version         # expect 1.0.2 (Path A or C)
```

## Coordination

- T1 + T2 must be DONE before T3 begins.
- T4 (Codex) audits T3's fix after publish. If T4 finds the fix didn't actually close memory_sessions writes, T3 reopens for an immediate v1.0.3.
- Orchestrator handles version bumps + commits + publishes (per CLAUDE.md hard rule); T3 stages working-tree changes only.

## Boot

```
1. date '+%Y-%m-%d %H:%M ET'
2. memory_recall(project="termdeck", query="Sprint 51.6 T3 fix v1.0.2 bundled hook memory_sessions migration 017 audit-upgrade extension")
3. memory_recall(query="Sprint 51.5 T1 audit-upgrade probe set Rumen 002 003 templating regression guard")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md (strict publish protocol — Passkey, never --otp)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.6-memory-sessions-hook-fix/PLANNING.md + STATUS.md + T1-* + T2-* (need both T1+T2 DONE before starting code)
8. Read this brief
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/audit-upgrade.js (the v1.0.1 deliverable you'll extend if Path A or C)
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js (the bundled hook you'll fix if Path B or C)
```

Stay in your lane. Post FIX-PROPOSED with line ranges; FIX-LANDED with test results; DONE only after orchestrator confirms publish succeeds. **No commits inside the lane** — orchestrator handles per CLAUDE.md.
