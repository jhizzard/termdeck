# RESTART-PROMPT — 2026-05-14 post-Sprint-64

**Authored:** 2026-05-14 at session-close of orchestrator UUID `259f312b-bac4-4c1a-818c-1e4b0fb7b159`.

**Why this file exists:** Sprint 64 closed at 16:47 ET FINAL-VERDICT GREEN, ~42 min from inject. `@jhizzard/termdeck@1.3.0` + `@jhizzard/termdeck-stack@1.3.0` shipped. **Investigation 2 of `docs/CRITICAL-READ-FIRST-2026-05-07.md` is closed** — both P0s from 2026-05-07 are now resolved. Next session resumes from Sprint 65 = "Dashboard reliability + orch-panel awareness wave."

---

## Boot sequence (in order)

1. `mcp__mnestra__memory_recall(project="termdeck", query="Sprint 64 close-out Investigation 2 closure kitchen-level memories")` — surfaces the 12 kitchen-level memories written at sprint wrap (3 each from T1/T2/T3/T4 + 4-5 from orchestrator).
2. `mcp__mnestra__memory_recall(query="recent TermDeck decisions and bugs 2026-05-11 through 2026-05-14")` — broader sweep covering Sprint 63 + Sprint 64 publish waves.
3. Read `~/.claude/CLAUDE.md` — global rules. **Two new sections from Sprint 64 close:** § Before Context Gets Long is now MANDATORY (PreCompact hook + periodic-capture timer); § Kitchen vs recipes directive (prefer kitchen-level memories over recipe-level).
4. Read `./CLAUDE.md` (TermDeck project router). **P0 banner is closed** — both investigations resolved as of Sprint 64. New hard rule § Auto-commit on context-compaction-near with file:line map.
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` — both investigations + the new § Resolution — Investigation 2 — 2026-05-14 section.
6. Read this file.
7. Read `docs/sprint-64-install-polish-and-carveouts/PLANNING.md` § Resolution + `STATUS.md` — full lane posts including the 4 WRAPPED memory titles.
8. Read `docs/BACKLOG.md` § P0 + § D.5 — including the 2026-05-14 entries authored Sprint-64-wrap (Brad's 2026-05-13 v2 spec, the 8-panel/multi-port ask + verification rough edges, the text-break/copy-paste rendering directive).
9. Read `docs/sprint-65-dashboard-reliability/PLANNING.md` — pre-scoped, ready to inject.

---

## What shipped 2026-05-14

| Wave | Versions | Sprint | Notes |
|------|----------|--------|-------|
| Afternoon | `termdeck@1.3.0` + `termdeck-stack@1.3.0` | Sprint 64 = Install-polish convergence + Sprint 63 carve-outs + Investigation 2 closure | ~42 min wall-clock (16:05 ET inject → 16:47 ET FINAL-VERDICT GREEN). 295/295 tests. 12 kitchen-level memories landed by lanes at wrap. |

`@jhizzard/mnestra` stays at 0.4.9. Companion patch (log rotation + singleton probe + pidfile from Brad's 2026-05-11 §3 #2/#4/#6) deferred to a separate Mnestra-only wave when convenient — attach-to-existing already shipping in 0.4.9 per multi-port verification 2026-05-14 15:28 ET.

---

## Investigation 2 — closed

`PreCompact` harness hook fires `~/.claude/hooks/memory-pre-compact.js` for Claude Code panels; TermDeck's `onPanelPeriodicCapture` (default 10 min, throttle at 1 KB transcript growth) covers Codex/Gemini/Grok inside TermDeck. Standalone non-Claude shells (outside TermDeck) remain uncovered — Sprint 65+ candidate. Crash-near out of scope.

`~/.claude/CLAUDE.md` § Before Context Gets Long was promoted from advisory to MANDATORY at sprint close. Hooks are load-bearing; manual `memory_remember` calls are belt-and-suspenders.

Acceptance evidence at `docs/sprint-64-install-polish-and-carveouts/INVESTIGATION-2-ACCEPTANCE.md` — Test A (real Claude PreCompact fire), Test B (periodic-capture on Codex panel), Test C (fail-soft never-blocks).

---

## Sprint 65 — queued, scoped, ready to inject

`docs/sprint-65-dashboard-reliability/` exists with full PLANNING.md + STATUS.md scaffold + 4 lane briefs (T1 client / T2 server / T3 verification / T4 Codex auditor). Bundles:

- Brad's 2026-05-13 v2 dashboard spec — project-filter chips + ORCH panel pin (Approach A: explicit `meta.role` flag).
- Brad's 2026-05-12 items 2 (CLI panels open visible + auto-close on PTY exit) + 3 (orchestrator-aware-of-dead-panels + bundled idle/parked detection).
- Optional Path A 10/12/16-panel grid layouts fold-in (decided at sprint inject based on T1 lane bandwidth).

Wave target: `@jhizzard/termdeck@1.4.0` + `@jhizzard/termdeck-stack@1.4.0`. Full-day 3+1+1 wall-clock estimate. Brad WhatsApp ask at inject for the "opens invisible" sub-bug 2a repro.

---

## Pattern insights from Sprint 64 (kitchen-level — not specific to this sprint)

These are the recurring patterns that drove this sprint's speed + catches. Future orchestrators apply directly:

1. **Live-probe audit > diff-only audit.** T4-CODEX ran `node --test <specific file>`, `curl POST /api/sessions`, `gitleaks detect` against the worker's WIP, not just diff-reading. Several catches (periodic-capture not registering on direct-spawn; gitleaks canaries; codex resolveTranscriptPath 1000ms slack) were only visible to live tools. Brief the auditor with "verify with the actual tool, not just the diff."
2. **Pre-emptive worker FINDINGs create coordination drift when ORCH SCOPE lands in parallel.** T1's 16:17 FINDING crossed paths with my 16:14 SCOPE. Pattern: workers should post BOOTED, then idle-poll until ORCH SCOPE adjudicates the open scope items BEFORE making pre-emptive design choices.
3. **AUDIT-RED vs AUDIT-CONCERN verbs matter.** T4-CODEX used AUDIT-RED only twice this sprint (PAT broadcast + gitleaks canaries); both got load-bearing attention. Mis-classifying erodes the discriminator over time. AUDIT-RED = sprint-blocking security/correctness. AUDIT-CONCERN = non-blocking quality feedback.
4. **Dual-layer credential redaction (caller-side explicit + source-side regex) beats single-layer.** Caller-side knows the specific secret values to scrub; source-side catches any future caller that forgets to wrap. Together they're durable; alone they're fragile.
5. **PTY env merge from secrets.env is a defense-in-depth boundary.** Any secrets.env loader should have a `PTY_ENV_EXCLUSION_LIST` for known admin-grade credentials (PATs, GitHub tokens, OpenAI admin keys). Even if the upstream wizard refuses to persist them, the exclusion list catches future drift (manual paste, code regression).
6. **Test fixtures using real-secret-shape canaries trip gitleaks pre-commit.** Use runtime-built / low-entropy fixtures that match the redaction regex shape without entropy red-flags. Or add per-file allowlist entries to `~/.gitleaks.toml` (project precedent: migration 012 classifier).
7. **Kitchen-level memories transfer; recipe-level don't.** Sprint-wrap "write learnings to Mnestra before /exit" prompts must specify kitchen-level explicitly, or workers default to recipe-level (specific file:line fixes that future sessions can recover from git log).

---

## Where the restart-prompt docs live

| Doc | Path |
|---|---|
| **Today (this file)** | `docs/RESTART-PROMPT-2026-05-14-post-sprint-64.md` |
| Sprint 63 close + Sprint 64 candidates | `docs/RESTART-PROMPT-2026-05-11.md` |
| Multi-project Supabase RLS lockdown + gitleaks + mirror-backups | `docs/RESTART-PROMPT-2026-05-06.md` |
| Project CLAUDE.md | `./CLAUDE.md` |
| Global CLAUDE.md | `~/.claude/CLAUDE.md` |
| Convergence plan | `docs/CONVERGENCE-PLAN.md` |
| Both P0 investigations + resolutions | `docs/CRITICAL-READ-FIRST-2026-05-07.md` |
| Sprint 65 plan (pre-scoped) | `docs/sprint-65-dashboard-reliability/PLANNING.md` |
| Sprint 64 plan + resolution | `docs/sprint-64-install-polish-and-carveouts/PLANNING.md` |

---

## Resume command for THIS specific orchestrator session

```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && claude --resume 259f312b-bac4-4c1a-818c-1e4b0fb7b159
```

Verified the JSONL exists at `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/259f312b-bac4-4c1a-818c-1e4b0fb7b159.jsonl`.

The fresh-session restart from the boot sequence above is the canonical path. The resume command is the alternative for cases where in-context state (Sprint 64 mechanics, T1/T2/T3/T4 reasoning) matters more than a clean re-read.
