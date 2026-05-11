# RESTART-PROMPT — 2026-05-11

**Authored:** 2026-05-11 14:30 ET (Monday) at session-close of orchestrator UUID `09d89364-e6dd-4a9a-b765-c8d4c6a49f12`.

**Why this file exists:** Sprint 63 = Wave 2 shipped at ~14:24 ET. `@jhizzard/termdeck@1.2.0` + `@jhizzard/termdeck-stack@1.2.0` are on npm; commit `7375d2a` pushed to `jhizzard/termdeck`. Investigation 1 of `docs/CRITICAL-READ-FIRST-2026-05-07.md` closes on acceptance grounds (live `/exit` capture verified during sprint close, 4/4 panels wrote `session_summary` to Mnestra at 14:23:33-43 ET). Next session resumes from Sprint 64 = install-polish wizard + Wave 2 carve-outs.

---

## Boot sequence (in order)

1. **`mcp__mnestra__memory_recall(project="termdeck", query="Sprint 63 Wave 2 close-out empirical exit-capture acceptance")`** — surfaces the four memories written at this session's close (if any were committed; see § Memory writes below).
2. **`mcp__mnestra__memory_recall(query="recent decisions and bugs 2026-05-08 through 2026-05-11")`** — broader sweep covering the Sprint 62 + Sprint 63 publish wave.
3. Read `~/.claude/CLAUDE.md` (global rules — 3+1+1 hardening, RLS hygiene, no-forbidden-literals, gitleaks + mirror-backup discipline).
4. Read `./CLAUDE.md` (TermDeck project read-order). **Note:** the P0 banner now points at Investigation 2 only — Investigation 1 was closed by Sprint 62 + Sprint 63 (this resolution).
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` — both Investigation 1 (closed) and Investigation 2 (still open; Sprint 64+ candidate).
6. Read this file (`docs/RESTART-PROMPT-2026-05-11.md`).
7. Read `docs/sprint-63-wave-2/PLANNING.md` — including the new `## Resolution` section at the bottom.
8. Read `docs/sprint-63-wave-2/STATUS.md` — full lane posts + orchestrator psql proxy at 14:02 ET + T4-CODEX FINAL-VERDICT YELLOW at 13:59 ET.
9. Read `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md` — T2's full acceptance artifact + Sprint 64 carve-out documentation.

---

## What shipped today (2026-05-11)

| Wave | Versions | Sprint | Notes |
|------|----------|--------|-------|
| Morning | `mnestra@0.4.9` + `termdeck@1.1.1` + `termdeck-stack@1.1.1` | Sprint 62 publish + 2026-05-11 fold-ins | Cross-agent session-end coverage closure (code/test grounds) + Brad's EADDRINUSE catch + SQLite ABI fail-fast. Commits `f917c85` (engram) + `6d64fea` (termdeck). |
| Afternoon | `termdeck@1.2.0` + `termdeck-stack@1.2.0` | Sprint 63 = Wave 2 | Crash class (PTY-leak / WS ioctl / body-parser / 410 Gone) + diagnostic surface (launcher Step 3 / health taxonomy / shell `-l` drop) + empirical /exit-capture acceptance + gemini `.jsonl` filter. Commit `7375d2a`. |

`@jhizzard/mnestra` stays at 0.4.9 — Mnestra companion patch deferred to Sprint 64.

---

## Investigation 1 — closed on acceptance grounds

At 14:23:33-43 ET, Joshua closed all 4 lane panels (3 Claude + 1 Codex). All 4 wrote `session_summary` rows to Mnestra within 10 seconds:

```
claude  bb1e465c  4088 bytes  14:23:33 ET
claude  430e256f  5744 bytes  14:23:37 ET
claude  b8607d3d  5062 bytes  14:23:41 ET
codex   fed67517  2422 bytes  14:23:43 ET
```

The dual-schema reference setup (memory_items + memory_sessions) received the writes. This is the empirical answer to Joshua's named priority for Sprint 63: **yes, `/exit` produces memories from all 4 LLMs and writes to Mnestra including the daily-driver dual-schema tables.**

Sprint 62 closed Investigation 1 on code/test grounds (fence tests prove the wire-up). Sprint 63 closed it on acceptance grounds (real panels, real `/exit`, real Mnestra rows).

**Investigation 2 (auto-commit on context compaction-near) remains open.** Sprint 64+ candidate.

---

## Sprint 64 candidates (consolidated)

Per `docs/CONVERGENCE-PLAN.md` and Sprint 63 close-out:

1. **Install-polish wizard with Supabase MCP auto-provision + OS-detection.** Original Sprint 63 scope per CONVERGENCE-PLAN.md, displaced by Wave 2. This is the final convergence sprint before MacBook Air dogfood.
2. **Mnestra companion patch.** Brad's §3 #2 + #4 + #6 from 2026-05-11: log rotation + pre-listen singleton probe + attach-to-existing on autostart + pidfile. Ships as `@jhizzard/mnestra@0.4.10` (or `0.5.0` if Joshua decides minor-bump at scoping).
3. **Sprint 63 carve-outs:**
   - Codex `resolveTranscriptPath` cross-panel contamination (Finding #1) — `packages/server/src/agent-adapters/codex.js:181-194`. Fresher mtime-vs-spawn-time gate.
   - `<5 messages` silent-skip threshold (Finding #3) — `packages/stack-installer/assets/hooks/memory-session-end.js:576`. Balance signal vs noise.
   - Codex CLI auto-update lifecycle hazard — automated spawn of a stale codex CLI self-exits before any work happens (no `--no-update` flag in CLI). Pre-spawn version check + wrapper shim.
   - `spawnTerminalSession` ignoring `adapter.spawn` config — `packages/server/src/index.js:1118-1175`. Wraps every adapter as `zsh -c <command>` regardless of adapter declaration. Likely contributor to codex/gemini/grok canary fast-deaths.
4. **Investigation 2: auto-commit on context compaction-near for all agents.** Still open from CRITICAL-READ-FIRST-2026-05-07. Codex CLI specifically lacks a pre-compact hook surface (verified 2026-05-11 — `codex --help` exposes no hooks subcommand).

After Sprint 64 ships, the MacBook Air dogfood acceptance test from `docs/CONVERGENCE-PLAN.md` should run clean. Then operator-action Phase B activation (35-45 min runbook at `docs/sprint-61-uninstall-and-install-harness/PHASE-B-RUNBOOK.md`) brings the virtual install matrix online across macOS + Ubuntu + Docker fedora + Docker debian fixtures.

---

## Sprint 63 sprint-arc highlights (for context)

- **3+1+1 pattern with Codex auditor paid off again.** T4-CODEX raised 4 AUDIT-CONCERNs; 3 load-bearing. Caught: (a) T2 brief naming non-existent `mnestra_session_summary` table — would have produced a phantom-table FAIL; (b) T1 body-parser fence rebuilding middleware vs driving production `createServer` — production miswire could have passed test; (c) T3 outer-catch fallbacks at `health.js:506-533` re-introducing uncategorized rows — T3 added invariant fence.
- **Codex CLI shell-block at 13:26 ET** — T4's `exec_command` started returning exit `-1`. Auditor self-flagged the verification gap and proposed the orchestrator-psql-proxy plan. Orchestrator ran independent psql at 14:02 ET, appended sanitized output to STATUS.md. T4 posted FINAL-VERDICT YELLOW at 13:59 ET based on code/test review + orchestrator proxy.
- **The codex auto-update edge case.** T2's first codex canary spawn at 13:26 ET hit codex CLI's update prompt (0.129→0.130), accepted "Update now," ran `npm install -g @openai/codex`, and exited 0 — before T2 could inject the canary. T2's retry at 14:00 ET on the post-update codex succeeded and confirmed the codex `/exit`-capture chain is healthy when allowed to initialize. **Codex CLI lifecycle hazard — no `--no-update` flag.** Sprint 64 candidate.

---

## Resume command for THIS specific orchestrator session

If for any reason the prior session's accumulated mental model matters more than a clean re-boot from the steps above, re-attach to this exact orchestrator session with:

```
claude --resume 09d89364-e6dd-4a9a-b765-c8d4c6a49f12
```

Or equivalently via the `/restore` shape if your CLI version exposes it:

```
/restore 09d89364-e6dd-4a9a-b765-c8d4c6a49f12
```

Verify the exact flag against the current Claude Code 2.x CLI; may be `-r` or `--resume`. Session UUID was discovered from `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/09d89364-e6dd-4a9a-b765-c8d4c6a49f12.jsonl`.

The fresh-session boot above is the canonical path; this resume command is the alternative for cases where in-context state matters more than a clean re-read.

---

## Where the restart-prompt docs live

| Doc | Path |
|---|---|
| **Today (this file)** | `docs/RESTART-PROMPT-2026-05-11.md` |
| Sprint 62 close (publish wave deferred from 5/8 → 5/9 → 5/11) | `docs/RESTART-PROMPT-2026-05-09.md` |
| Multi-project Supabase RLS lockdown + gitleaks + mirror-backups | `docs/RESTART-PROMPT-2026-05-06.md` |
| Project CLAUDE.md | `./CLAUDE.md` |
| Global CLAUDE.md | `~/.claude/CLAUDE.md` |
| Convergence plan | `docs/CONVERGENCE-PLAN.md` |
| Investigation 1 + 2 details | `docs/CRITICAL-READ-FIRST-2026-05-07.md` |
