# T1 — Wizard wire-up bug bisect + fix

You are T1 in Sprint 51.7 (wizard-wire-up-and-metadata, v1.0.3 mini).

## Boot sequence (do these in order, no skipping)

1. `memory_recall(project="termdeck", query="Sprint 51.6 v1.0.2 refreshBundledHookIfNewer wizard wire-up Phase B failed init-mnestra")`
2. `memory_recall(query="Codex audit findings hook refresh CLI binary integration test stale 508-LOC pre-Sprint-50")`
3. Read `~/.claude/CLAUDE.md`
4. Read `./CLAUDE.md`
5. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/PLANNING.md`
6. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md`
7. Read this brief end-to-end (you are here).
8. Read `docs/sprint-51.6-memory-sessions-hook-fix/STATUS.md` lines 690–1060 (T4-CODEX VERIFY → DONE — VERIFIED post-manual-refresh — the durable record of the failure mode you're bisecting).
9. Read `docs/INSTALLER-PITFALLS.md` ledger entry #15 (line 159, especially the v1.0.3 follow-up note at line 173).

## Pre-sprint intel

The bug: `refreshBundledHookIfNewer()` is a published, tested helper that DOES refresh the installed hook when called directly via `node -e "const {refreshBundledHookIfNewer} = require('/usr/local/lib/node_modules/@jhizzard/termdeck/packages/cli/src/init-mnestra.js'); console.log(refreshBundledHookIfNewer({dryRun:false}))"`. Joshua's manual run last night returned `{status:'refreshed', from:null, to:1, backup:'.bak.20260504011632'}` and the hook landed correctly.

But when invoked via `termdeck init --mnestra` (the canonical user path), the refresh does NOT fire. Phase B evidence:
- `memory_sessions` row count delta after `/exit`: 0 (expected: +1)
- Fresh `memory_items.session_summary` row had `source_agent IS NULL` (the new hook always writes `source_agent='claude'`)
- `tests/project-taxonomy.test.js` remained 3-pass/22-fail (the new bundled hook with the Sprint-41 PROJECT_MAP would flip it to 25/0)

Brad reproduced the same failure on jizzard-brain post-`init --mnestra`.

The call site at `packages/cli/src/init-mnestra.js:677`:

```js
step('Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)...');
try {
  const r = refreshBundledHookIfNewer({ dryRun: false });
  if (r.status === 'refreshed') {
    ok(`refreshed v${r.from ?? 0} → v${r.to} (backup: ${path.basename(r.backup)})`);
  } else if (r.status === 'installed') {
    ok(`installed v${r.bundled} (no prior copy)`);
  } else if (r.status === 'up-to-date') {
    ok(`up-to-date (v${r.installed})`);
  } else {
    ok(`(${r.status}${r.message ? ': ' + r.message : ''})`);
  }
} catch (err) {
  process.stdout.write(`    ! hook refresh failed: ${err.message} (continuing)\n`);
}
```

Hypotheses to bisect (rank by likelihood, eliminate top-down):

**H1: Control flow drops out before line 677.** Something in `checkExistingStore()` (line 666), `applyMigrations()` (667), `runMnestraAudit()` (668), or `writeYamlConfig()` (669) throws AND is silently caught upstream OR returns early without throwing. Brad's run confirmed audit-upgrade DID fire and applied mig 017 — that suggests `runMnestraAudit` ran. But `runMnestraAudit` could itself contain a try/catch that swallows the error and process.exit's. Trace.

**H2: `refreshBundledHookIfNewer()` returns `up-to-date` because the installed hook signature reads as v1 AND the bundled is also v1.** Joshua's pre-refresh hook was 508 LOC pre-Sprint-50 — he claims it had no marker (manual run returned `from: null`). But Brad's hook may DIFFER in this respect. Verify: `grep '@termdeck/stack-installer-hook' ~/.claude/hooks/memory-session-end.js` on a fresh-pre-refresh-v1.0.2 install. T2 is bumping the bundled stamp to v2 as insurance — that closes this even if H2 is the real cause, but you still need to confirm OR refute it.

**H3: `refreshBundledHookIfNewer()` returns `custom-hook-preserved` because `looksTermdeckManaged()` returns false on Brad's hook.** The marker regexes at `init-mnestra.js:513-517` are: `/TermDeck session-end memory hook/`, `/@jhizzard\/termdeck-stack/`, `/Vendored into ~\/\.claude\/hooks\/memory-session-end\.js by @jhizzard/i`. Some of those exist only in versions of the bundled hook from particular sprints. If Brad's hook predates the marker, this branch fires and silently preserves his custom hook. This would also be the bug for any user whose first install of the bundled hook predates the marker pattern.

**H4: `__dirname` resolves differently in the CLI-binary context vs the `node -e` context.** Unlikely (same Node, same realpath resolution) but verify by adding `console.error` of `HOOK_SOURCE` and `HOOK_DEST` to `refreshBundledHookIfNewer()` temporarily.

**H5: A second `init-mnestra.js` is being invoked.** Maybe a stale install in `/usr/local/lib/node_modules/` vs `~/.npm-global/lib/node_modules/` vs npm-managed npx cache. Verify: `which termdeck && readlink $(which termdeck) && head -5 $(readlink $(which termdeck))`. Compare bin path's `__dirname` resolution against Joshua's and Brad's expected paths.

## Lane scope

1. **Reproduce the failure deterministically.** Set up a sandbox: tmp HOME with a stale-shaped hook (e.g., a copy of Joshua's `.bak.20260504011632` if you can find it, OR a hand-rolled stale shape that matches "TermDeck-managed but no v marker"). Run the actual `termdeck` binary against it (NOT just `node -e`). Confirm the failure mode reproduces.

2. **Add stderr instrumentation to `init-mnestra.js`** at the call site (lines 675–690). For the bisect duration, write each branch's outcome to stderr with a `[wire-up-debug]` prefix:
   - Before line 677: `[wire-up-debug] entering refresh; HOOK_DEST=...; HOOK_SOURCE=...; bundled-stamp=...; installed-stamp=...`
   - Inside each `r.status === ...` branch: `[wire-up-debug] status=... details=...`
   - In the catch: `[wire-up-debug] threw: ...`
   - Also instrument `refreshBundledHookIfNewer()` itself at each early-return branch so the path taken is visible.

3. **Bisect against your fixture.** Run `termdeck init --mnestra` (or the test-friendly `--dry-run` variant if you can make one work) and capture the stderr trace. Identify which hypothesis is correct.

4. **Write the fix.** This depends on root cause:
   - If H1: convert the silent catch to a logged-and-continue path; the refresh might actually be running but its output is being suppressed by `step()/ok()` ANSI rewriting (look at how `step()` and `ok()` interact — could they be eating each other's output?). OR add the missing rethrow.
   - If H2: T2's v1 → v2 stamp bump closes it; you still need to add a regression test that exercises an installed-`v1` → bundled-`v2` upgrade path.
   - If H3: tighten/loosen `looksTermdeckManaged` based on what Brad's actual hook looks like; document why and what the new marker policy is.
   - If H4: change `HOOK_SOURCE` resolution to use `require.resolve` against a known package path instead of relative `__dirname` math.
   - If H5: handle the multi-install-prefix case (probably not the bug, but worth documenting).

5. **Add a CLI-binary integration test** at `packages/cli/tests/init-mnestra-cli-refresh.test.js`. The test must SPAWN the actual `termdeck` binary (or `node packages/cli/src/index.js init --mnestra ...` if the spawn-binary path is too slow), with `HOME=$tmpdir`, `~/.claude/hooks/memory-session-end.js` pre-seeded with a stale fixture, and assert the refresh status appears in stdout AND the hook file changed. This test would have caught Phase B's failure mode pre-publish.

6. **Remove the instrumentation** before posting FIX-LANDED (or keep it behind a `TERMDECK_DEBUG_WIREUP=1` env gate if it's broadly useful).

## Lane discipline

- No version bumps (T3 owns the 1.0.2 → 1.0.3 bump).
- No CHANGELOG edits.
- No git commits.
- All findings go in `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md` as `[T1] FINDING` / `[T1] FIX-PROPOSED` / `[T1] FIX-LANDED` posts with timestamps and file:line references.
- Stay in lane: do NOT touch the bundled hook source (that's T2). Do NOT touch the CHANGELOG, package.json versions, or commit anything (that's T3 + orchestrator).
- If you find a cross-lane gap (e.g., T2's stamp bump conflicts with your fix), post a `[T1] CROSS-LANE` note in STATUS.md and let T4-CODEX adjudicate.

## When you're done

Post `[T1] DONE` to STATUS.md with: root-cause diagnosis (1 paragraph), files changed (file:line bullets), test added (path + assertion summary), test counts (pass/fail before vs after).

Begin.
