# Investigation 2 — Acceptance Evidence

**Sprint:** 64 (Install-polish convergence + Sprint 63 carve-outs + Investigation 2)
**Lane:** T3 — auto-commit on context compaction-near
**Closes:** `docs/CRITICAL-READ-FIRST-2026-05-07.md` § Investigation 2 (open since 2026-05-07; partial work landed Sprint 62 for Investigation 1)
**Author:** T3 (Claude worker lane, 3+1+1 pattern)

---

## TL;DR

The "auto-commit memories on context-compaction-near" rule, advisory in
`~/.claude/CLAUDE.md` § Before Context Gets Long since 2026-05-07, is now
backed by two deterministic mechanisms that ship in
`@jhizzard/termdeck@1.3.0` + `@jhizzard/termdeck-stack@1.3.0`:

1. **Claude Code panels:** a `PreCompact` harness hook fires the bundled
   `~/.claude/hooks/memory-pre-compact.js` before context compaction. Writes
   one `source_type='pre_compact_snapshot'` row to Mnestra per compaction.
2. **Non-Claude panels (Codex/Gemini/Grok):** a per-panel periodic-capture
   timer in the TermDeck server (default interval 10 min, throttled by
   transcript growth ≥ 1 KB) spawns the same hook with
   `mode: 'periodic_checkpoint'`.

Both mechanisms write to the same `memory_items.source_type='pre_compact_snapshot'`
target, distinguishable from SessionEnd's `source_type='session_summary'` and
from each other via a header line on `content` and the `source_agent` column.

Fail-soft contract: any error (env-missing, network, transcript parse fail,
small transcript) logs to `~/.claude/hooks/memory-hook.log` and exits 0.
Compaction is **never** blocked.

---

## Evidence Map

| Acceptance criterion | Evidence |
|---|---|
| PreCompact hook event exists in Claude Code 2.x | Docs at https://code.claude.com/docs/en/hooks; enumerated in T3 FINDING post 2026-05-14 16:08 ET on `STATUS.md` |
| Bundled hook ships at canonical path | `packages/stack-installer/assets/hooks/memory-pre-compact.js` |
| Installer wires it on `npx @jhizzard/termdeck-stack` | `packages/stack-installer/src/index.js::installPreCompactHook`, called from `main()` after `installSessionEndHook` |
| Wizard refreshes installed hook on `termdeck init --mnestra` | `packages/cli/src/init-mnestra.js::runHookRefresh` extended; `migrateSettingsJsonPreCompactEntry` for settings.json |
| Uninstall removes both hook file and settings entry | `packages/stack-installer/src/uninstall.js::_stepBackupPreCompactHookFile` + extended splice in `_stepSpliceSettingsJson` |
| Non-Claude panels covered by periodic-capture timer | `packages/server/src/index.js::onPanelPeriodicCapture` + timer registration in `spawnTerminalSession` |
| Hook is fail-soft (never blocks compaction) | `processPreCompactPayload().finally(() => process.exit(0))` in the bundled hook; no `decision: "block"` path |
| Throttle: ≥ 1 KB growth between fires | `onPanelPeriodicCapture` short-circuits when `stat.size - lastSize < 1024` |
| Tests fence the wire-up | `packages/server/tests/pre-compact-hook.test.js` + `packages/server/tests/periodic-capture.test.js` (both under the `npm test` glob `packages/server/tests/**/*.test.js`) |

---

## Fence-test catalog

### `packages/server/tests/pre-compact-hook.test.js`

| Test | What it fences |
|---|---|
| `writes source_type=pre_compact_snapshot under PreCompact STDIN` | Claude Code harness path. Asserts one POST to `/rest/v1/memory_items` with `source_type='pre_compact_snapshot'`, `category='workflow'`, `source_session_id`, `source_agent='claude'`, `project` resolved from cwd via PROJECT_MAP, and a header line starting with `[CHECKPOINT mode=pre_compact trigger=auto`. |
| `honors periodic_checkpoint mode with adapter source_agent` | TermDeck server path. Asserts the same POST shape but with `source_agent='codex'` and the header reflecting `mode=periodic_checkpoint trigger=periodic`. |
| `skips transcripts smaller than MIN_TRANSCRIPT_BYTES_PRE_COMPACT` | Below the 5 KB floor → no POSTs. |
| `returns no-session-id without a session_id` | Defensive — payload without `session_id` exits early. |
| `short-circuits cleanly on env-var-missing` | `readEnv()` returns null → no POSTs, exit 0. |

### `packages/server/tests/periodic-capture.test.js`

| Test | What it fences |
|---|---|
| `_resolvePeriodicCaptureIntervalMs honors the env override and defaults to 10 min` | Env-var precedence; 0 disables; bad input falls back to default. |
| `onPanelPeriodicCapture skips when meta.status === "exited"` | Close-out capture handles exited panels — periodic-capture must not double-fire. |
| `onPanelPeriodicCapture skips Claude-Code panels` | PreCompact hook handles Claude's compaction-near path. |
| `onPanelPeriodicCapture throttle: < 1 KB growth between fires is suppressed` | Cost-aware throttle, plus verifies the bookmark advances after a real fire. |
| `onPanelPeriodicCapture payload carries mode=periodic_checkpoint + source_agent` | End-to-end payload contract the bundled hook consumes. |

Run locally:
```
node --test packages/server/tests/pre-compact-hook.test.js
node --test packages/server/tests/periodic-capture.test.js
```

Or under the root npm-test surface:
```
npm test
```
which globs `packages/server/tests/**/*.test.js` (per the orchestrator's
attention to T4-CODEX 16:09 ET AUDIT-CONCERN about test-runner coverage).

---

## Operator-grade canary procedure (post-installation)

The fence tests prove the wire-up is correct in isolation. The integration
test below verifies the wire-up against a real Claude Code session that
actually crosses a compaction boundary. Joshua runs this once after
`@jhizzard/termdeck-stack@1.3.0` lands on his daily-driver.

### Preconditions

1. `@jhizzard/termdeck-stack@1.3.0` installed (or `npm i -g @jhizzard/termdeck@latest` + `termdeck init --mnestra` to refresh).
2. `~/.claude/hooks/memory-pre-compact.js` exists (verify: `ls -la ~/.claude/hooks/memory-pre-compact.js`).
3. `~/.claude/settings.json` has a `hooks.PreCompact` entry pointing at it (verify: `cat ~/.claude/settings.json | jq .hooks.PreCompact`).
4. `~/.termdeck/secrets.env` populated with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`.

### Canary phrases

Pick five invented phrases that won't collide with real session content.
Suggested form (a UTC date stamp + a sentinel word so cross-recall is
unambiguous):

```
canary-2026-05-14-azure
canary-2026-05-14-amber
canary-2026-05-14-jade
canary-2026-05-14-ivory
canary-2026-05-14-onyx
```

### Test A — Claude Code PreCompact path

1. Start a long Claude Code session in the termdeck cwd.
2. Drop each canary phrase one by one, asking Claude to acknowledge each. Spread them out over ~5–10 user turns each so the conversation accumulates.
3. Continue working until Claude Code's harness fires `PreCompact` (auto-compact at the token-cap, OR explicitly trigger with `/compact`).
4. After compaction completes, from a **new** Claude Code session (cold context):
   ```
   mcp__mnestra__memory_recall(query="canary 2026-05-14 azure amber jade ivory onyx")
   ```
5. **Expected:** at least one `memory_items` row with `source_type='pre_compact_snapshot'`, `content` beginning with `[CHECKPOINT mode=pre_compact trigger=auto`, AND the recall hits include text referencing each of the five canary phrases.
6. **Also expected:** `~/.claude/hooks/memory-hook.log` contains a recent `[pre-compact] ingested-pre_compact: project="termdeck" session=...` line.

### Test B — TermDeck periodic-capture path (non-Claude)

1. In TermDeck, spawn a Codex panel via the launcher.
2. Set `TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS=120000` (2 min) in the spawning shell so the timer fires quickly enough to verify in a single sitting.
3. Drive ~6 KB of conversation through the Codex panel, dropping the first canary phrase early.
4. Wait ~2 min for the first periodic-capture tick. Drop the second canary phrase. Continue until five intervals have elapsed (≈ 10 min total).
5. Close the panel cleanly via Codex `/exit` so the SessionEnd hook also captures.
6. From a Claude Code session:
   ```
   mcp__mnestra__memory_recall(query="canary 2026-05-14 azure amber jade ivory onyx", source_agents=["codex"])
   ```
7. **Expected:** at least five `source_type='pre_compact_snapshot'` rows where `source_agent='codex'` and `content` begins with `[CHECKPOINT mode=periodic_checkpoint trigger=periodic`. Plus one `source_type='session_summary'` row from the SessionEnd close-out.
8. **Also expected:** the periodic ticks at quiet intervals (where the Codex transcript didn't grow ≥ 1 KB) produce no POSTs — verify by counting Supabase inserts.

### Test C — Fail-soft never blocks

1. Temporarily corrupt `~/.termdeck/secrets.env` (e.g., set `SUPABASE_URL=invalid`).
2. Trigger a manual `/compact` in a Claude Code session.
3. **Expected:** the session compacts normally, the hook log shows
   `[pre-compact] supabase-insert-failed:` or `env-var-missing:`, exit code 0.
4. **Not expected:** the session stays stuck pre-compact, or the hook throws and Claude Code surfaces an error.

---

## Known limitations (deferred to Sprint 65+ or later)

- **Crash-near, not compact-near.** PreCompact fires before compaction begins, but a session that crashes mid-compact (process kill, OOM) loses anything not yet captured. The durable substrates remain: `STATUS.md` in active sprints, `memory_remember` calls made earlier in the session, the JSONL transcript on disk. Crash recovery is out of scope for Sprint 64.
- **Standalone-shell Codex/Gemini/Grok (no TermDeck).** Captured in `docs/CRITICAL-READ-FIRST-2026-05-07.md` § Investigation 1 as deferred from Sprint 62 (its PLANNING § Out of scope). Periodic-capture only fires for panels running INSIDE TermDeck. Wrappers around the standalone CLIs are a Sprint 65+ candidate.
- **`memory_recall` filter for pre-compact rows.** Today, `pre_compact_snapshot` rows return alongside `session_summary` rows when the `source_type` parameter is omitted. A future enhancement is an explicit `include_pre_compact` flag (mirroring the `include_null_source` flag added in Sprint 62 T3) — Sprint 65+ candidate.

---

## File map

Files added or modified in this lane:

```
packages/stack-installer/assets/hooks/memory-pre-compact.js    NEW   bundled hook
packages/stack-installer/src/index.js                          EDIT  installPreCompactHook
packages/stack-installer/src/uninstall.js                      EDIT  PreCompact splice + backup
packages/cli/src/init-mnestra.js                               EDIT  refresh + settings wiring
packages/server/src/index.js                                   EDIT  onPanelPeriodicCapture + timer
packages/server/tests/pre-compact-hook.test.js                 NEW   bundled-hook fence
packages/server/tests/periodic-capture.test.js                 NEW   server-side fence
CLAUDE.md                                                      EDIT  P0 banner + hard rule
docs/sprint-64-install-polish-and-carveouts/INVESTIGATION-2-ACCEPTANCE.md  NEW  this file
```

The global `~/.claude/CLAUDE.md` § "Before Context Gets Long" edit is
deliberately out-of-scope for the lane — drafted in T3's FIX-PROPOSED post
on STATUS.md; orchestrator commits the global file at sprint close.
