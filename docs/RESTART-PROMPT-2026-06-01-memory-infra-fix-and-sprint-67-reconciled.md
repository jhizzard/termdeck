# RESTART-PROMPT — 2026-06-01 — Memory infra fixed + Sprint 67 reconciled

**Session:** `ea23fcca` (orchestrator, 2026-06-01). **Supersedes** the 2026-05-17/19 forward-plan restart prompts (Sprints 67–69) — read THIS one first; it corrects the record on Sprint 67.

## Boot sequence (next session, cold start)
1. `mcp__mnestra__memory_recall(project="termdeck", query="Sprint 67 reconciliation close-out memory infra fixes 2026-06-01")`
2. `mcp__mnestra__memory_recall(query="recent TermDeck decisions and bugs")`
3. Read `~/.claude/CLAUDE.md`, then `./CLAUDE.md` (TermDeck read-order).
4. Read `docs/sprint-67-field-deployment-integrity/RECONCILIATION-2026-06-01.md` (the close-out plan).
5. `memory_recall` for the specific topic Joshua names at session start. Then begin.

## What happened this session
Joshua reported "something wrong with memory." Triangulated with a ClaimGuard-panel doctor pass:

- **NO data was lost.** Mnestra store intact (~7,115 memories; ClaimGuard 848; Maestro Sprint-16 harvest present). The scare was three independent **daily-driver-specific** issues, not product breakage.
- **Three bugs found + fixed (live, daily-driver only):**
  1. `memory_items.source_type` CHECK constraint lacked `pre_compact_snapshot` → 100 % of Sprint-64 PreCompact/periodic snapshot writes failed **silently** (PG 23514) since the feature shipped. **Fixed** via migration `add_pre_compact_snapshot_to_source_type_check`. The constraint is a legacy-bootstrap artifact NOT present in shipped migrations → **other users unaffected**.
  2. Session-end hook PROJECT_MAP didn't map the antigravity-scratch ClaimGuard path → recent ClaimGuard sessions misfiled as `project="global"` (data present, mislabeled). **Fixed** in the installed hook + repo bundle (general `gorgias-ticket-monitor`→`claimguard`); `detectProject` verified. Historical re-tag backfill deferred.
  3. Stale `mcp__memory__` MCP server (rag-system March 10-arg build) broke recall via the wrong namespace. **Retired** via `claude mcp remove memory -s user`; `mnestra` remains. Takes effect next Claude Code restart. (A separate project-scoped `memory` entry under PVB was left untouched.)
- **Sprint 67 was NOT unrun** (correcting an earlier mistake in this session). It **ran 2026-05-23, ended T4-CODEX FINAL-VERDICT RED, and sat uncommitted for 9 days.** Today cleared all three RED blockers — DB constraint fixed; 5 forbidden literals scrubbed (full-tree grep ALL CLEAN); `npm test` reproduced **444/0/0 GREEN**. **Sprint 67 is now close-out-ready.**

## Decisions awaiting Joshua
1. **Sprint 67 close-out posture** — orchestrator-close vs Codex spot-check (recommended) vs full re-audit → then branch, commit, bump 1.6.2, CHANGELOG, **publish (Passkey)**, push, tag. Runbook in `RECONCILIATION-2026-06-01.md`.
2. **Schema-source decision** — add a canonical `source_type` CHECK to the shipped Mnestra schema (incl. `pre_compact_snapshot`), or leave unconstrained + document.
3. **CLAUDE.md trim** (T3 3.2 never fully persisted; global file is 394 lines) — redo or drop.

## What's next (after Sprint 67 close)
- **Sprint 68** — standalone-shell capture (Codex/Gemini/Grok native session-end hooks). Note Brad's 2026-05-21 scope correction: ~16–19 h, Antigravity binary-protobuf reality (BACKLOG §D.6).
- **Multi-deck scale-out (NEW, strategic)** — Brad now runs **24–30+ terminals across multiple projects**, beyond Joshua's 2-deck ceiling (he wants to reach that capability himself). Consolidate multi-port / per-instance-SQLite / `termdeck doctor` port-discovery / launcher-SIGTERM / cross-deck coordination (Telegram two-bot bridge) / Mnestra cwd-routing into ONE sprint. See Mnestra memory "NEW SCALING SIGNAL".

## Key pointers
- Close-out plan: `docs/sprint-67-field-deployment-integrity/RECONCILIATION-2026-06-01.md`
- Sprint 67 docs: `docs/sprint-67-field-deployment-integrity/` (STATUS.md = 39 lane posts + today's scrub note)
- Backlog (rewritten, uncommitted): `docs/BACKLOG.md`
- Mnestra 2026-06-01 memories — search: `"Sprint 67 reconciliation close-out"`, `"NEW SCALING SIGNAL"`, `"code-ahead-of-schema enum drift"`, `"constraint legacy install-specific blast radius"`.

## Resume THIS session
```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck && claude --resume ea23fcca-3f14-4c55-8436-a31101a6d700
```
