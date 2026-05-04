# Sprint 51.6 — T1 (Claude): Hook instrumentation + bundled-vs-installed diff

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T1):**

Find EXACTLY where `~/.claude/hooks/memory-session-end.js` fails to write a `memory_sessions` row. Two-bug context: source_agent column gap (Codex fixed 2026-05-03 19:01 ET) is closed; memory_sessions branch is still broken (live psql shows 0 new rows since 2026-05-01 20:40 UTC). T1 isolates the failure to a specific line/condition.

## Steps

1. **Diff installed vs bundled.** `diff ~/.claude/hooks/memory-session-end.js packages/stack-installer/assets/hooks/memory-session-end.js`. Capture the byte-exact deltas. Document in FINDING.

2. **Read both hook files.** Identify the `memory_sessions` write code path. Note any conditional that would skip the write (auth gap, env-var check, schema-version check, etc).

3. **Instrument the installed hook (temporarily).** Wrap the memory_sessions write block with un-swallowed error logging:
   ```javascript
   // PRE-WRITE: write a timestamp file so we know fire vs success differ
   require('fs').appendFileSync('/tmp/hook-fired.log', `${new Date().toISOString()} fire\n`);
   try {
     // ... existing memory_sessions INSERT ...
     require('fs').appendFileSync('/tmp/hook-fired.log', `${new Date().toISOString()} memory_sessions write OK\n`);
   } catch (err) {
     require('fs').appendFileSync('/tmp/hook-fired.log', `${new Date().toISOString()} memory_sessions FAIL: ${err.message}\n${err.stack}\n`);
     throw err;
   }
   ```
   Keep a backup: `cp ~/.claude/hooks/memory-session-end.js /tmp/memory-session-end.js.original`.

4. **Trigger a fire.** Open a quick test Claude Code session in any directory (e.g., `cd /tmp && claude`), do a trivial interaction (`memory_recall test`), then `/exit`. Wait 5s. Inspect `/tmp/hook-fired.log`.

5. **Repeat with /exit from a TermDeck-spawned panel.** Same instrumentation; trigger /exit on a panel managed by the running TermDeck server. Compare logs from steps 4 and 5 — TermDeck's `onPanelClose` (Sprint 50 T1 deliverable) might fire the hook differently than Claude Code's native SessionEnd hook registration.

6. **Restore the original hook.** `cp /tmp/memory-session-end.js.original ~/.claude/hooks/memory-session-end.js`. Verify with `diff` (must be byte-identical to the pre-instrumentation backup). **This is required before posting DONE — leaving instrumentation in production breaks the test on the next sprint.**

## What to capture in FINDING

- Byte-exact diff of installed vs bundled (probably small or empty).
- The memory_sessions write code path location (file:line).
- The specific failure mode: error message, SQL error code, stack trace.
- Whether the failure is consistent across native Claude Code /exit AND TermDeck onPanelClose paths.
- The pre/post timestamps in `/tmp/hook-fired.log` showing fire-but-no-write.

## Coordination

- T2 needs T1's failure mode to know what schema query to run. Post FINDING ASAP so T2 can converge.
- T3 needs both T1's location and T2's schema diagnosis to scope the fix.
- T4 (Codex) re-runs steps 4/5 independently after T1 posts DONE; coordinates restore-verification.

## Boot

```
1. date '+%Y-%m-%d %H:%M ET'
2. memory_recall(project="termdeck", query="Sprint 51.6 T1 hook instrumentation memory_sessions write path bundled vs installed two-bug picture petvetbid")
3. memory_recall(query="bundled hook ~/.claude/hooks/memory-session-end.js Sprint 50 onPanelClose Sprint 38 Mnestra-direct rewrite")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.6-memory-sessions-hook-fix/PLANNING.md + STATUS.md
7. Read this brief
8. Read ~/.claude/hooks/memory-session-end.js (installed)
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js (bundled)
```

Stay in your lane. Post FINDING / DONE in `STATUS.md`. **Restore the hook before DONE.** No code changes to bundled file (T3's job); your edits to installed are temporary instrumentation only.
