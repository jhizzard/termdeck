# RESTART-PROMPT — 2026-05-16 post-Sprint-65

**Authored:** 2026-05-16 at Sprint 65 close-out by orchestrator session `a015e1a3-4d43-42ab-a654-81630f56cf12`.

**Why this file exists:** Sprint 65 ("Dashboard reliability + orch-panel awareness") closed GREEN at 20:43 ET, ~65 min from inject. `@jhizzard/termdeck@1.4.0` + `@jhizzard/termdeck-stack@1.4.0` shipped. This file boots the next TermDeck session. **A carried-over priority is flagged in § What's next — B (Brad's Rumen-zero triage) was queued behind Sprint 65 and has NOT been executed yet.**

---

## Boot sequence (in order)

1. `mcp__mnestra__memory_recall(project="termdeck", query="Sprint 65 close-out v1.4.0 dashboard chips ORCH-pin kitchen memories")`
2. `mcp__mnestra__memory_recall(query="recent TermDeck decisions and bugs 2026-05-16 Sprint 65")`
3. Read `~/.claude/CLAUDE.md` — global rules.
4. Read `./CLAUDE.md` — TermDeck project router.
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` — both P0 investigations remain closed (Inv 1 Sprint 62/63, Inv 2 Sprint 64).
6. Read this file.
7. Read `docs/sprint-65-dashboard-reliability/PLANNING.md` § Resolution + `STATUS.md` — full lane posts + the 3 ORCH SCOPE posts.
8. Read `docs/BACKLOG.md` § D.5 — Sprint 66 candidates (the "Sprint 65 close-out — deferrals" entry) + Brad's Telegram-bridge entry.
9. `mcp__mnestra__memory_recall(project="termdeck", query="<specific topic Joshua signals at session start>")`

---

## What shipped 2026-05-16

| Wave | Versions | Sprint |
|------|----------|--------|
| Sprint 65 | `termdeck@1.4.0` + `termdeck-stack@1.4.0` | Dashboard reliability + orch-panel awareness — project-filter chips, ORCH-pin row, dead-panel lifecycle (`410 Gone` + `panel_exited` WS + tile auto-removal), `meta.role` field, Path A layouts (incl `1×2`), global font-size |

3+1+1 with Codex auditor; ~65 min inject → FINAL-VERDICT GREEN. Root `npm test` 375/375, 0 skipped. T4-CODEX caught 2 AUDIT-REDs pre-FIX-LANDED. Full deliverable list: `CHANGELOG.md` [1.4.0] + `docs/sprint-65-dashboard-reliability/PLANNING.md` § Resolution. `@jhizzard/mnestra` stays at 0.4.9.

---

## What's next — priority order

**B — Brad's "Rumen has not generated a single memory" triage — EXECUTE THIS 2026-05-17 (top priority, carried over from Sprint 65).** The 2026-05-16 session sequenced C→A→B; C + A are done, B is tomorrow's task. Pre-diagnosis: Rumen's picker (post Sprint 53 v0.5.0) extracts from `memory_sessions WHERE rumen_processed_at IS NULL`; `memory_remember` writes `memory_items`, NOT `memory_sessions` — only the session-end hook / TermDeck panel-capture writes `memory_sessions`. So Brad's Rumen produces nothing because his `memory_sessions` is not being populated.

Execution plan (also in Mnestra — `memory_recall(project="termdeck", query="PLAN FOR B Brad Rumen triage")` surfaces this plus the fix-path + wave-placement companion memories):

1. **Probe.** Brad runs his own Supabase project (its name is recorded in the Mnestra `PLAN FOR B` memory — kept out of this committed doc). The orchestrator cannot query it directly — WhatsApp Brad the probe SQL, or use Supabase MCP if his project is wired. Pull counts of `memory_sessions`, `memory_sessions WHERE rumen_processed_at IS NULL`, `rumen_insights`, `rumen_jobs` (+ `max(created_at)`), `memory_items`; and confirm the `memory_sessions.rumen_processed_at` column exists. Control: Joshua's own daily-driver Mnestra project is healthy (`memory_status` → `sessions_processed=404`).
2. **Pin the break.** `memory_items` grows but `memory_sessions`=0 → session-end hook not writing `memory_sessions`. `memory_sessions` has rows but `rumen_insights`=0 → `rumen-tick` Edge Function down/erroring. `rumen_processed_at` column absent → Brad's DB migrations never applied (the upgrade-detection P0).
3. **Fix + place in a wave.** Likely a TermDeck hotfix (`v1.4.1`) or a Mnestra/Rumen patch — NOT a Sprint 65 reopen, NOT a v1.4.0 republish. See Mnestra `query="B fix-path candidates"` and `query="B wave placement"`.

Honest note carried into tomorrow: a bare `memory_remember` row is itself invisible to Rumen (that IS this bug) — Rumen is fed overnight by the session-end hook writing one `memory_sessions` row per closed session. The B-setup memories above exist for tomorrow's `memory_recall`, not for the Rumen run.

**"Frontier From Scratch" book project + the 6-item Claude.ai-shared-memory bridge.** Joshua is planning a book + paid learning website ("if we had tens of billions, from scratch, how would we build the frontier AI stack"). The 2026-05-15 Claude.ai planning session produced a 6-item infrastructure backlog to give Claude.ai/ChatGPT/Gemini/Grok read+write access to Mnestra/Rumen (remote-MCP bridge + `memory_session_record` tool + Mnestra/Rumen patches). Both captured as Mnestra memories tagged `frontier-from-scratch`. HTML export at `~/Documents/Graciella/ChopinNashville/SideHustles/Building advanced AI systems from first principles - Claude.html`; extracted text at `/tmp/claude-export-extracted.txt`.

**Sprint 66 candidates** (`docs/BACKLOG.md` § D.5 "Sprint 65 close-out — deferrals" entry): draggable grid row/column resizing; 2a "opens invisible" hypotheses A/C/D (pending Brad's repro; B fixed in-sprint); `meta.role`-in-`session_summary` analytics; legacy `orch` layout gate/retire; repo-root `tests/` glob consolidation. Plus Brad's 2026-05-15 Telegram cross-orch-bridge proposal (needs Joshua's explicit go-ahead — stands up a bot + daemon + systemd unit).

---

## Where the restart-prompt docs live

| Doc | Path |
|---|---|
| **Today (this file)** | `docs/RESTART-PROMPT-2026-05-16-post-sprint-65.md` |
| Sprint 64 close | `docs/RESTART-PROMPT-2026-05-14-post-sprint-64.md` |
| Project CLAUDE.md | `./CLAUDE.md` |
| Global CLAUDE.md | `~/.claude/CLAUDE.md` |
| Both P0 investigations | `docs/CRITICAL-READ-FIRST-2026-05-07.md` |
| Sprint 65 plan + resolution | `docs/sprint-65-dashboard-reliability/PLANNING.md` |

---

## Resume command for THIS orchestrator session

```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && claude --resume a015e1a3-4d43-42ab-a654-81630f56cf12
```

JSONL verified at `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/a015e1a3-4d43-42ab-a654-81630f56cf12.jsonl`. The fresh-session boot sequence above is the canonical path; the resume command is the alternative for when in-context state (Sprint 65 mechanics, the book/Rumen threads, the C→A→B arc) matters more than a clean re-read.
