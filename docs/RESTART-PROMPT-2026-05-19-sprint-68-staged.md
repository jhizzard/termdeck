# RESTART-PROMPT — 2026-05-19 — Non-Claude CLI hook audit + Sprint 68 staged

**Authored:** 2026-05-19 afternoon ET, orchestrator session `af97e403-da94-4449-a141-34b28af0d896`.

**Supersedes** `docs/RESTART-PROMPT-2026-05-17-ci-followup.md`. That doc's forward plan is still live but **renumbered** (§4 below). Read this file instead.

**Why this file exists.** A question raised inside a ClaimGuard sprint — *"Codex, Gemini, and Grok aren't Claude Code — they have no session-end memory hook"* — prompted an audit of whether non-Claude panels capture memory on `/exit`. The audit produced a real ecosystem finding, a one-file surgical fix, and a fully-staged new sprint. Joshua is closing terminals to pick up other projects; this file is the staging record so **Sprint 68 boots cleanly** when TermDeck is next picked up.

---

## 1. What this session did (2026-05-19)

- **Audited the "do non-Claude panels capture memory on `/exit`?" question.** Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` (both P0 investigations remain closed), the `onPanelClose` / `onPanelPeriodicCapture` server code, the Sprint 62/63 acceptance evidence, and the current official docs + installed versions for all three non-Claude CLIs. Result is §2.
- **Applied a surgical hook fix.** `~/.claude/hooks/memory-session-end.js` on the daily-driver was dated **May 4** — it predated the Sprint 62–64 hook fixes (notably the `MIN_TRANSCRIPT_MESSAGES` redesign that closed the old `<5 messages` silent-skip). Backed it up to `~/.claude/hooks/memory-session-end.js.bak.20260519-134416` and copied in the current Sprint-64 bundled version. Verified: installed == bundled, `MIN_TRANSCRIPT_MESSAGES` present.
- **Staged Sprints 67 and 68** in full — `docs/sprint-67-field-deployment-integrity/` and `docs/sprint-68-standalone-shell-capture/`, each with `PLANNING.md`, four lane briefs (`T1`–`T4`), and a `STATUS.md` scaffold. Both ready to inject the moment four panels are open.
- **Locked two decisions** (Joshua, via AskUserQuestion): scope = *ship the fix via the TermDeck installer* (not a one-off); slotting = *the next sprint after Sprint 67*.
- **Saved 1 kitchen-level memory to Mnestra** — the CLI-hook ecosystem shift.

## 2. The finding — non-Claude CLIs now have native hooks

The ClaimGuard auditor's claim was a fair *historical* assumption but is now **partly stale**, and its conclusion does **not** hold for TermDeck panels.

**The CLIs have caught up to Claude Code's hook model** (verified 2026-05-19 vs official docs + installed versions):

| CLI (installed) | Native session-end hook | Compaction hook | Hook config file |
|---|---|---|---|
| **Codex** `0.131.0` | ❌ none — `Stop` is *turn-complete*, not session-scoped | ❌ none | `~/.codex/hooks.json` |
| **Gemini** `0.42.0` | ✅ `SessionEnd` (`reason: exit\|clear\|logout\|prompt_input_exit\|other`) | ✅ `PreCompress` | `~/.gemini/settings.json` |
| **Grok / grok-dev** `1.1.5` | ⚠️ `SessionEnd` in *current* docs — installed 1.1.5 likely predates it | ⚠️ `PreCompact`/`PostCompact` likewise | `~/.grok/user-settings.json` |

All three use the Claude-Code-shaped stdin-JSON hook contract (`session_id`, `transcript_path`, `cwd`, `hook_event_name`).

**But TermDeck never relied on CLI hooks.** `onPanelClose` (`packages/server/src/index.js:265`) fires on `term.onExit` and captures non-Claude `/exit` content to Mnestra with the correct `source_agent` — Sprints 62/63/64, proven, tested. **For TermDeck panels, non-Claude `/exit` capture works today.** The auditor's conclusion ("don't count on panels committing memories on /exit") is wrong for in-TermDeck panels.

**The genuine residual gap:** standalone Codex/Gemini/Grok shells run *outside* TermDeck capture nothing — no server, no `onPanelClose`. This is the §5 horizon item in the 2026-05-17 forward plan. Now that the CLIs expose native hook surfaces, it is closeable — that is Sprint 68.

**Kitchen takeaway** (saved to Mnestra): third-party CLI capability is a moving target — the "wrap the CLI because it has no hook surface" assumption (baked in since Sprint 45/50, restated in `CLAUDE.md` + `CRITICAL-READ-FIRST`) should be re-verified each release cycle, not treated as permanent.

## 3. Live state (2026-05-19)

| Package | Version (published) | Notes |
|---|---|---|
| `@jhizzard/termdeck` | 1.5.0 | Daily-driver global install is **1.4.0** — one minor behind. Not urgent; Sprint 67 owns the field-deployment audit. |
| `@jhizzard/termdeck-stack` | 1.5.0 | same repo |
| `@jhizzard/mnestra` | 0.4.9 | unchanged; Sprint 68 needs no mnestra schema change |
| `@jhizzard/rumen` | 0.5.3 | unchanged |

- Surgical fix applied (§1) — the stale `memory-session-end.js` is resolved out-of-sprint; Sprint 67 T1's hook-refresh-path fix still stands as the *systemic* fix.
- Repo working tree on `main`, clean apart from this session's new `docs/` files (Sprint 68 docs + this restart prompt) — uncommitted, intentionally (staging only; nothing to publish until Sprint 68 ships).

## 4. Forward plan — renumbered

The 2026-05-17 plan was 67 (field-deployment) → 68 (dashboard) → 69 (memory-tech). Sprint 68 (standalone-shell capture) is inserted after 67; everything downstream shifts by one:

| # | Sprint | Status |
|---|---|---|
| **67** | Field-deployment integrity + loose-ends convergence | **staged this session — `docs/sprint-67-field-deployment-integrity/`** |
| **68** | **Standalone-shell memory capture: native CLI session-end hooks** | **staged this session — `docs/sprint-68-standalone-shell-capture/`** |
| **69** | Dashboard depth: layout, paste, panel metadata | was Sprint 68 in the 2026-05-17 doc |
| **70** | The memory technology: operationalizing Paradigm-Pattern-Memory-Recipe | was Sprint 69 in the 2026-05-17 doc |

Sprint 67 is staged in full this session (`docs/sprint-67-field-deployment-integrity/`). Sprints 69 / 70 lane detail is unchanged — see `docs/RESTART-PROMPT-2026-05-17-ci-followup.md` §3 (the *content* is current; only the numbers 68→69 and 69→70 shift).

## 5. Sprints 67 & 68 — staged and ready

**Sprint 67 — `docs/sprint-67-field-deployment-integrity/`** — `PLANNING.md` + `T1`–`T4` briefs + `STATUS.md`. 3+1+1; **runs first**. Verifies the `PreCompact` hook fires on the daily-driver, root-causes + fixes the systemic `runHookRefresh` bug, re-greens CI + adds branch protection, and clears doc-hygiene loose-ends (`BACKLOG.md` rewrite, `~/.claude/CLAUDE.md` trim). Wave target: patch bump 1.5.0 → 1.5.1 *if* T1 lands code. Several steps are operator-in-the-loop (compaction trigger, CI secret values, branch protection) — see its `PLANNING.md` § Constraints.

**Sprint 68 — `docs/sprint-68-standalone-shell-capture/`** — `PLANNING.md` + `T1`–`T4` briefs + `STATUS.md`. 3+1+1. Wave target `@jhizzard/termdeck` + `@jhizzard/termdeck-stack` **1.5.0 → 1.6.0**.

Install a native session-end (+ compaction) hook into each non-Claude CLI's own config so **standalone** shells capture to Mnestra. Three design decisions drive every lane (full text in `PLANNING.md` § Design decisions):
- **D1** — native hook = standalone-only; self-disables inside TermDeck (`TERMDECK_PANEL_SESSION` + `TERMDECK_NATIVE_CLI_HOOK` env guard) so it never double-writes against `onPanelClose`.
- **D2** — Codex is degraded-mode (no `SessionEnd`; rides a throttled `Stop` hook).
- **D3** — version-gated; fail-loud, never write a config a too-old CLI silently ignores.

**To kick off either sprint:** open 4 panels on `http://127.0.0.1:3000` — 3 Claude + 1 Codex — and the orchestrator injects that sprint's four `T<n>-*.md` briefs via the two-stage submit pattern (the sprint's `PLANNING.md` § Inject protocol). **Sprint 67 first, then Sprint 68.**

## 6. Loose ends

- **Don't run `termdeck init --mnestra` to "fix the stale hook" — the surgical fix already did it.** The full wizard also exercises the suspected-broken `runHookRefresh` path (Sprint 67 T1's target) and re-runs the Mnestra migration/verify wizard for no added benefit here. The daily-driver `termdeck` is v1.4.0; a `npm i -g @jhizzard/termdeck@latest` to 1.5.0 is optional, low-priority.
- **Sprint 68 depends on Sprint 67's `runHookRefresh` fix.** If Sprint 68 is injected before Sprint 67 lands, T2 must flag it as a blocker (its brief says so).
- Carry-overs from the 2026-05-17 doc §6 (4 mnestra Dependabot PRs, external-user follow-ups, the beta-tester onboarding DM) are unchanged.

## 7. Boot sequence for the next session

1. `mcp__mnestra__memory_recall(project="termdeck", query="Sprint 68 standalone-shell capture native CLI hooks")`
2. `mcp__mnestra__memory_recall(query="recent TermDeck decisions and bugs")`
3. Read `~/.claude/CLAUDE.md`.
4. Read `./CLAUDE.md`.
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` — both P0 investigations remain closed.
6. Read **this file**.
7. If kicking off Sprint 67: read `docs/sprint-67-field-deployment-integrity/PLANNING.md`. If kicking off Sprint 68: read `docs/sprint-68-standalone-shell-capture/PLANNING.md`.

Then begin — most likely Sprint 67, then Sprint 68.

## 8. Resume command for this session

```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && claude --resume af97e403-da94-4449-a141-34b28af0d896
```

Session JSONL verified on disk (`~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/af97e403-da94-4449-a141-34b28af0d896.jsonl`). §7 boots a fresh session cold; this command resumes this session's accumulated context.
