# Restart prompt — 2026-05-07 (Sprint 59 v1.0.13 SHIP + Sprint 60 v1.0.14 hotfix queued + Codex idle-detection P0)

**Session ended:** 2026-05-07 ~16:55 ET (Thursday)
**Wall-clock:** ~3.5 hours active orchestration (15:25 inject → 16:52 push)
**Trigger:** Joshua opened terminals, said "inject" — fresh-start Sprint 59 (paired bug-fix sprint to Sprint 58's catch-net).
**Resume command for THIS session (preserves accumulated mental model):**
```
claude --resume <session-uuid-from-~/.claude/projects/...termdeck/...jsonl>
```
(Largest jsonl in `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/` is the orchestrator session candidate; the 3 worker-lane Claude panels each have their own jsonl.)

## What shipped — `@jhizzard/termdeck@1.0.13` + `@jhizzard/termdeck-stack@0.6.13`

Commit `e7cf46c` on origin/main, pushed 2026-05-07 16:52 ET. 30 files changed, 2504 insertions(+), 58 deletions(-). gitleaks pre-commit pass (no leaks).

| Brad finding | Closure |
|---|---|
| #1 nohup secrets propagation | `cli/src/index.js` `maybeBootstrapAndDetach()` + cross-site empty-string-vs-undefined gates in `stack.js` `loadSecrets` + `server/src/config.js` `loadSecretsEnv` |
| #2 DATABASE_URL quote-strip | validator-boundary `stripSurroundingQuotes` in `supabase-url.js` (3 sites) + writer-side regex in `dotenv-io.js` + boundary strip in `init-mnestra.js` `inputsFromEnv()` |
| #3 pgbouncer URL params | docs note in `GETTING-STARTED.md` Step 2 |
| #4 search_memories vs memory_hybrid_search | doctor probe version-detect (carried from Sprint 58 — code shipped there, releases here in v1.0.13) |
| #5 PTY shell fallback chain | new `packages/server/src/spawn-shell.js` `resolveSpawnShell` with `cmdTrim || configShell || $SHELL || /bin/sh`; `index.js:958` call site updated |
| #6 `--include=optional` Linux x64 install hint | mirrored across 4 doc surfaces (GETTING-STARTED.md, INSTALL.md, INSTALL-FOR-COLLABORATORS.md, README.md) |
| #7 `--service` flag + stack.js wait-semantics | refactored `execTermDeck` to `Promise<exitCode>` + `--service` (alias `--non-interactive`) flag at dispatcher |
| #8 systemd PATH= guidance | new `docs/examples/termdeck.service` canonical unit + new "Running TermDeck under systemd" section in GETTING-STARTED.md |

**Plus in-sprint scope expansion (Brad's "drop a zip into Codex" question + Joshua's "paste images too"):**
- `POST /api/sessions/:id/upload` endpoint (50MB cap, sanitized filename, mode 0600 per-session tempdir, auth parity with `/input`)
- Client file-drop + clipboard-image-paste handlers in `app.js` `setupPanelDragDrop` + new `uploadFilesAndType` helper
- New `.term-panel.file-drop-active` visual differentiated from panel-reorder
- Per-session tempdir cleanup on PTY exit + startup sweep against live-session SELECT

**Plus Sprint 58 catch-net activated:** all 5 reproducer fixtures flipped from `EXPECTED="red"` to `EXPECTED="green"`; F-6 reproducer harness uses `--include=optional`; systemd-nightly fixture substituted to canonical unit.

## What's queued next — read in this order

1. **`docs/sprint-60-v1014-hotfix-bundle/PLANNING.md`** (NEW) — 5 single-orchestrator items, ~1.5-2h wall-clock, same-day cadence:
   - **Item 1 (P0): Per-adapter idle/parked status detection.** Codex `Worked for Xm Ys` terminator + Claude idle-prompt cursor + 30-60s `lastActivity`-stale heuristic. Bit Sprint 59 TWICE in 90 min — orchestrator can't reliably tell when a long-running auditor lane has parked. Joshua promoted to P0 explicitly mid-sprint.
   - **Item 2: Body-parser control-char hardening.** Brad logged 9× SyntaxError per 13h uptime; custom `verify` callback or per-route raw-body parser.
   - **Item 3: WS ioctl EBADF/ENOTTY race guard.** Brad logged 25× per 13h; PTY-alive check before `setSize`; downgrade race-expected errors to debug.
   - **Item 4: Launcher stderr separation.** `~/start-termdeck.sh` to redirect stderr separately; per-boot banner.
   - **Item 5: Log rotation.** `docs/examples/termdeck.logrotate` + per-boot banner write order.

2. **`docs/BACKLOG.md` § P0** — same v1.0.14 hotfix bundle plus the prior P0 entries (memory_sessions ingestion break, stack-installer upgrade-detection gap, Flashback not firing, Brad's empty-Mnestra ingestion fix).

3. **Sprint 61+ queue** (in `sprint-60-*/PLANNING.md` § "Sprint queue beyond Sprint 60"):
   - Phase B for Sprint 58 catch-net (operator action, ~15 min)
   - Mnestra 0.4.7+ RLS-on baseline migration for fresh installs
   - Sprint 61+ install-polish (interactive setup wizard, OS detection, schema-generation auto-detection)
   - Cost-monitoring panel (Sprint 51 deferred vision)
   - Catch-net fixture refinement (Sprint 58 T4-CODEX flagged structural flaws)

## Where the restart-prompt + planning docs live

| Doc | Path |
|---|---|
| **This session's restart prompt** | `docs/RESTART-PROMPT-2026-05-07.md` |
| Prior session's restart prompt | `docs/RESTART-PROMPT-2026-05-06.md` |
| Sprint 60 PLANNING (v1.0.14 hotfix queue) | `docs/sprint-60-v1014-hotfix-bundle/PLANNING.md` |
| Sprint 59 STATUS (GREEN, shipped) | `docs/sprint-59-brad-bug-fixes-against-catch-net/STATUS.md` |
| Sprint 58 STATUS (GREEN, repaired 2026-05-06) | `docs/sprint-58-environment-coverage/STATUS.md` |
| BACKLOG (P0 = idle-detection promoted + memory_sessions + upgrade-detection + flashback + ingestion) | `docs/BACKLOG.md` |
| Project rules | `CLAUDE.md` |
| Global rules | `~/.claude/CLAUDE.md` |

## Standing context — most-current state heading into next session

- `@jhizzard/termdeck@1.0.13` + `@jhizzard/termdeck-stack@0.6.13` published 2026-05-07.
- `@jhizzard/mnestra@0.4.6` is current latest (0.4.4 + 0.4.5 deprecated).
- `@jhizzard/rumen@0.5.3` is current.
- 4 Supabase projects locked-down (RLS-on across the board) per 2026-05-06 hardening.
- gitleaks pre-commit + pre-push active globally; 5-gate Supabase hygiene rule in stone (per `~/.claude/CLAUDE.md`).
- Sprint 58 catch-net is GREEN-and-active; Phase B (operator-coordinated test Supabase project + 10 GH secrets) still pending.
- **Codex panel idle-detection bug is P0 in BACKLOG and #1 item in Sprint 60.** Bit Sprint 59 twice in 90 min — orchestrator's API-based status check reported "Codex reasoning, last activity 0s ago" while T4 was actually parked at end-of-turn. Workaround: read `/api/transcripts/<sessionId>` and look for `─ Worked for ` terminator. Permanent fix is Sprint 60 Item 1.
- LaunchAgent for nightly mirror backups: install pending (one-line cp + launchctl load).
- TermDeck distribution updated 2026-05-07: **3+ external testers, not 1**. Brad confirmed two more independent users mid-day. Threat model and release-quality bar adjust accordingly.
- pgvector lives in `extensions` schema on Supabase ≥ 2024 — `search_path` on Mnestra functions MUST include `extensions` or vector ops fail with "operator does not exist".

## Restart prompt for the next session — paste-ready

```
1. memory_recall(project="termdeck", query="Sprint 59 v1.0.13 ship + Sprint 60 v1.0.14 hotfix bundle + Codex idle-detection P0")
2. memory_recall(query="recent decisions and bugs")
3. Read ~/.claude/CLAUDE.md
4. Read ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
5. Read ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-05-07.md
6. Read ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-60-v1014-hotfix-bundle/PLANNING.md
7. memory_recall(query="<topic Josh signals at session start>")

Then begin. Standing context for the next session:
- @jhizzard/termdeck@1.0.13 + @jhizzard/termdeck-stack@0.6.13 are current.
- @jhizzard/mnestra@0.4.6 is current latest; 0.4.4 + 0.4.5 deprecated.
- TermDeck distribution: 3+ external testers (not 1).
- Sprint 60 v1.0.14 hotfix queued: idle-detection (P0), body-parser hardening, WS ioctl race guard, launcher stderr separation, log rotation. Single-orchestrator pattern, ~1.5-2h wall-clock.
- Phase B for catch-net (test Supabase + 10 GH secrets): still pending operator action.
- LaunchAgent for nightly mirror backups: install pending.
- Codex idle-detection bug is THE first item — Joshua flagged it as a 3+1+1 efficiency blocker; orchestrator cannot reliably tell when an auditor lane has parked.
```

## Resume command for THIS specific session (alternative to fresh-start above)

If accumulated mental model matters more than a clean re-read of memory + docs:

<pre>claude --resume &lt;largest-jsonl-uuid-in-~/.claude/projects/...termdeck/&gt;</pre>

Re-attaches to this orchestrator session. Different shape from the fresh restart-prompt path: section above boots a NEW session with cold context (re-reading memory + CLAUDE.md + this doc); the resume command continues THIS session. Use the resume when picking up the same incident/sprint within hours; use the fresh-start when there's been a context switch (different project, new day, etc.).

The 3 worker-lane Claude panels (T1/T2/T3) AND the orchestrator each have their own jsonl in `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/` with the four mtimes converging at session-end-time as Joshua /exit'd panels to fire memory_sessions writes. Verify the orchestrator UUID by `head -1 <jsonl>` and matching first-user-message text ("Terminals are open, inject" / Sprint 59 boot).
