# RESTART-PROMPT — 2026-05-17 — CI follow-up + forward plan (Sprints 67–69)

**Authored:** 2026-05-17, at the close of the CI-follow-up session. Orchestrator session `9e59a945-8b2c-4dff-82c1-07d855494324`.

**Supersedes** `docs/RESTART-PROMPT-2026-05-17-post-sprint-66.md`. That doc's headline carry-over — task #7, "Mnestra + Rumen red CI" — is **COMPLETE** as of this session. Read this file instead.

**Why this file exists.** The Sprint 66 restart prompt flagged task #7 (Mnestra + Rumen red CI) as the top carry-over. This session closed it and verified it on real GitHub CI. With the whole stack now green and nothing on fire, the next two-to-three sprints were penciled out in detail — so TermDeck can be set down cleanly and other projects picked up without losing the thread. **That forward plan (§3) is the centerpiece of this doc.**

---

## 1. What the CI-follow-up session did (2026-05-17)

- **Closed task #7 — Mnestra + Rumen red CI.** Both repos' `main` CI had been red ~2 weeks. Root causes were environment/fixture drift, not product bugs:
  - **mnestra** — the `sql-syntax` CI job applied Supabase-targeted migrations to a vanilla `pgvector/pgvector:pg16` container lacking the Supabase platform roles (`anon`/`authenticated`/`service_role`) and the Vault schema. Fix: a new "Provision Supabase platform objects" step in `.github/workflows/ci.yml` that pre-creates the three roles + a `vault.secrets` table. **PR `jhizzard/mnestra#14`, merged — commit `a176a60` on `main`.**
  - **rumen** — `tests/fixtures/mnestra-minimal.sql` was frozen at the v0.1 schema while the v0.5 picker reads `started_at`/`ended_at`/`messages_count`/`rumen_processed_at` and calls the 8-arg canonical `memory_hybrid_search`. Fix: fixture synced to the v0.5 schema. **PR `jhizzard/rumen#1`, merged — commit `c07fd06` on `main`.**
  - Both fixes verified against the **exact CI Docker images** before pushing — which caught a second masked failure (`vault.secrets`) and a third drift (the 8-arg signature) that reasoning from the first error alone would have missed.
- **Both `main` CIs are GREEN** — first green `main` CI on mnestra since v0.4.4 and on rumen since the v0.5 line broke.
- **Fixed the global `~/.githooks/pre-push` hook.** It scanned full repo history on every new-branch push, re-flagging already-public historical leaks and blocking clean branches (it had blocked Sprint 65 & 66 tag pushes). Now scans only the branch's own new commits (`$local_sha --not --remotes`).
- **Mnestra Dependabot triage** — all 7 open mnestra Dependabot PRs verified safe (typecheck + `npm test`, including the typescript-6 and zod-4 majors — 70/70 tests). 3 merged (`#1` setup-node@6, `#4` @types/node@25, `#12` @anthropic-ai/sdk@0.93); `main` CI stayed green through all three. **4 remain open + conflict-stale (`#2` checkout@6, `#10` typescript@6, `#11` zod@4, `#13` supabase-js) — awaiting Dependabot auto-rebase.**
- **Drafted install/onboarding messaging** for a prospective beta tester.
- **6 memories saved to Mnestra** (4 kitchen-level, 1 process-feedback, 1 forward-plan pointer).

## 2. Live state (2026-05-17 close)

| Package | Version | `main` CI |
|---|---|---|
| `@jhizzard/termdeck` | 1.5.0 | green |
| `@jhizzard/termdeck-stack` | 1.5.0 | (same repo) |
| `@jhizzard/mnestra` | 0.4.9 | green |
| `@jhizzard/rumen` | 0.5.3 | green |

The CI/fixture fixes were **not** version bumps — `.github/` and `tests/` are outside the npm `files` arrays, so no publish was needed. All three repo working trees are on `main`, clean. mnestra has 4 Dependabot PRs open (auto-rebasing). The stack is in a **green, shippable, early-adopter-shareable** state — one external user is active and a second beta tester is being onboarded.

---

## 3. Forward plan — Sprints 67, 68, 69

Three sprints, in order. The arc: **solidify the foundation → polish the daily-driver → deepen the memory technology.** None is on fire — this is a deliberate, paced plan, not a hotfix queue. All three are 3+1+1 (3 Claude workers + 1 Codex auditor + orchestrator) per `~/.claude/CLAUDE.md` § Sprint role architecture.

### Sprint 67 — Field-deployment integrity + loose-ends convergence

**Theme.** "Shipped" is not "running in the field." This session and Sprint 66 both proved it (Sprint 64's PreCompact hook shipped in the npm package but was never deployed on the daily-driver; CI was green-on-`npm test` while red-on-GitHub for two weeks). Sprint 67 closes that gap and clears the accumulated hygiene loose-ends, so the foundation is solid before 68-69 build on it.

**Why first.** Everything downstream assumes the substrate works. The PreCompact-hook gap means compaction-state may still be silently lost on the daily-driver — a correctness hole, cheap to close, that should close before more is built on top.

**Lanes:**
- **T1 — Hook field-deployment.** Verify the Sprint-64 `PreCompact` hook is wired in `~/.claude/settings.json` on the daily-driver and actually fires (a `pre_compact_snapshot` row lands in Mnestra on a real compaction). Refresh the stale `~/.claude/hooks/memory-session-end.js` (dated pre-Sprint-62). Audit + fix the `termdeck init --mnestra` hook-refresh path — `packages/cli/src/init-mnestra.js::runHookRefresh` and `packages/stack-installer/src/index.js::installPreCompactHook` — which should install/refresh **both** hooks and evidently did not. *(Some steps need the operator at the keyboard — wiring `settings.json` is classifier-blocked for the agent; triggering a real compaction is a human action. The lane's code deliverable is the installer fix + a verification procedure.)*
- **T2 — CI infrastructure + GitHub hygiene.** Re-provision the 9 GitHub Actions secrets for `install-smoke` / `macos-install-smoke` / `systemd-nightly` (runbook already written: `docs/sprint-66-public-scrutiny-cleanup/CI-SECRET-REPROVISIONING.md`). Merge the 4 trailing mnestra Dependabot PRs once auto-rebased. Add light branch protection to `main` on the three stack repos. Close stale PRs.
- **T3 — Doc hygiene.** Rewrite `docs/BACKLOG.md` — 243 lines of accreted entries with `✅ CLOSED` tags layered in and a stale 2026-04-27 header; produce a clean, deduplicated, current backlog. Trim `~/.claude/CLAUDE.md` (387 lines → ~250; promote historical "Sprint N" paragraphs to Mnestra, preserve every load-bearing rule). Retire or gate the legacy `orch` grid layout.
- **T4 — Codex auditor.**

**Acceptance.** PreCompact hook verified firing on the daily-driver; `termdeck init --mnestra` refreshes both hooks; all 3 repos CI green + branch-protected; `BACKLOG.md` is a clean current doc; `~/.claude/CLAUDE.md` trimmed with zero load-bearing rules lost (auditor verifies).

**Size.** Light-to-moderate 3+1+1, ~half-day. Mostly verification + hygiene; the only real code is the installer hook-refresh fix.

### Sprint 68 — Dashboard depth: layout, paste, panel metadata

**Theme.** The dashboard-UX backlog has accumulated — items that bite the daily flow but keep getting deferred under more-urgent waves. Sprint 68 clears the daily-driver friction.

**Why second.** Pure quality-of-life; depends on nothing in 69 and improves every subsequent use of TermDeck. Doing the `app.js` module split here also de-risks 69's client work.

**Lanes:**
- **T1 — Draggable grid row/column resizing.** A headline item asked for repeatedly (2026-05-15/16) and deferred from Sprint 65. Draggable dividers between grid rows/columns for non-uniform layouts: resize handles + CSS Grid `fr`-track manipulation + per-layout persistence in `localStorage`. ~200-350 LOC; needs its own scoping pass. Also retire the legacy `orch` layout if Sprint 67 didn't.
- **T2 — Copy-paste text-break fix.** Standing complaint (2026-05-14): pasted multi-line blocks break lines and inject stray spaces. Build `normalizePasteShape(text)` — strip mid-paragraph `\n`, collapse stray whitespace, preserve real paragraph breaks — at both the client paste path and the `/api/sessions/:id/input` server boundary.
- **T3 — Panel metadata + `app.js` module split.** Split `app.js` first (>3000 LOC; splitting de-bloats the surface T1/T2 land in). Then per-panel cwd switch — `PATCH /api/sessions/:id {cwd}` validating the path, sending a `cd` keystroke, updating `meta.cwd`, with a panel-header control.
- **T4 — Codex auditor.**

**Acceptance.** Drag-resize works and persists per layout; copy-paste round-trips clean across panel types; per-panel cwd switch works; `app.js` split into modules; `npm test` green.

**Size.** Full-day 3+1+1 — the resize is a genuine lift and the module split adds surface.

**Open dependency.** The external user's "2a opens-invisible" repro — if provided by inject, fold hypotheses A/C/D in; else leave deferred.

### Sprint 69 — The memory technology: operationalizing Paradigm-Pattern-Memory-Recipe

**Theme.** This is "the actual technology" — the substantive engineering on the memory/learning core, and the sprint that makes the **Paradigm-Pattern-Memory-Recipe framework real**. The framework (codified 2026-05-16) is a four-tier context hierarchy; today the recall machinery only reaches the middle tiers. Sprint 69 builds the tooling that descends all four — **including the Recipe tier.**

**Why third / last.** It is the deepest and most cross-cutting (touches mnestra + rumen + termdeck), so it goes after the foundation is solid (67) and the client surface is clean (68). It is also the highest-leverage — it changes what the whole stack can *recall*.

**Lanes:**
- **T1 — Escalating `memory_recall` (the PPMR operationalization).** Extend `memory_recall` in `@jhizzard/mnestra` to auto-escalate when top-k results are below a confidence/count threshold, with a `max_depth` parameter. The rungs map onto the PPMR tiers:
  1. live context (the model already holds it);
  2. **Paradigm** — `~/.claude/CLAUDE.md` (auto-loaded);
  3. **Pattern + Memory** — Mnestra hybrid recall (today's behavior);
  4. **Pattern (synthesized)** — Rumen insights (`rumen_insights`) — *not currently reachable through `memory_recall`*;
  5. **Recipe** — full-session transcript FTS (`termdeck_transcripts`) — *not currently reachable through `memory_recall`*.

  **Rung 5 is "the recipe piece."** The Recipe tier (Tier 0 of the framework) is the one-off execution detail — the exact line, the verbatim text — which lives in git and transcripts, never in memory. Making it *retrievable on demand, as the deepest rung,* completes the hierarchy. The framework's own proof case was exactly this: recovering a deleted message buried in one of eight transcripts. Today that takes manual `grep`; after Sprint 69 it is the bottom rung of `memory_recall`. Goal: "no memory should ever be unreachable, but access cost escalates with depth so the fast paths stay fast."
- **T2 — Rumen correctness.** Close the **Rumen-MCP gap**: memories written via the MCP path (`memory_remember`) land with `NULL source_session_id`, so Rumen's Extract phase never picks them up — MCP-written memories are never synthesized into insights, a real hole in the learning loop. Plus: add the missing `relate`-phase embedding test coverage (BACKLOG V4-1 — four failure modes, zero unit tests).
- **T3 — Active health dashboard + memory-budget table.** Proactive health checks so silent-no-op bugs cannot hide for days (the failure class Sprints 51-62 repeatedly fought). A `memory-budget` table keyed by `(sprint shape, agent type, panel count)` → expected memory-write count; a post-sprint reconciliation that flags drift; scheduled `mnestra doctor`; a synthetic `/exit` verifying `memory_sessions` grows. Surfaced through `termdeck doctor`.
- **T4 — Codex auditor.** Cross-repo audit is especially load-bearing here (mnestra + rumen + termdeck change together).

**Acceptance.** `memory_recall` demonstrably descends all four PPMR tiers — a recipe-level fact present only in a transcript is retrievable through it; the Rumen-MCP gap is closed (an MCP-written memory reaches Rumen Extract and gets synthesized); the health dashboard surfaces a deliberately injected silent failure.

**Size.** Full-day-plus 3+1+1 — cross-repo, conceptually heaviest. If scoping shows T1 is too large, split it into its own focused sub-sprint.

---

## 4. The Paradigm-Pattern-Memory-Recipe framework

Codified **2026-05-16** as a four-tier context hierarchy (full text in Mnestra, `[global]` memory):

- **Paradigm** — substrate/domain-agnostic operating axioms. Home: `~/.claude/CLAUDE.md` "in stone." Lifetime: years.
- **Pattern** — reusable method/structure for a *class* of work (the "kitchen"). Home: CLAUDE.md operational sections + `[global]` Mnestra memories. E.g. 3+1+1, STATUS.md substrate.
- **Memory** — concrete project-scoped fact/decision/state. Home: Mnestra (project-tagged).
- **Recipe** (Tier 0) — one-off execution detail; the exact line changed, verbatim text. Home: git log/blame + the JSONL transcript. *Never* `memory_remember`'d.

Two flows: **Recall** descends the tiers at task start; **Promotion** ascends — a Memory that recurs becomes a Pattern, a foundational Pattern becomes Paradigm. The ratchet goes up only — that is why the system compounds.

**Where it lands:** Sprint 69 is the operationalization. Recall today only reaches Paradigm (CLAUDE.md) and Pattern/Memory (Mnestra). Sprint 69 T1's escalating `memory_recall` adds rung 4 (Rumen-synthesized Patterns) and rung 5 (Recipe-tier transcript FTS) — so the recall flow genuinely descends the whole hierarchy. The framework is the *principle*; Sprint 69 T1 is the *tooling* that embodies it.

## 5. Beyond Sprint 69 — the horizon (not yet scheduled)

Real work, deliberately not in the 67-69 plan: **Tier 5 SkillForge** (autonomous Claude-Code-skill generation above Rumen); the **cost-monitoring panel** (`project_cost_monitoring_panel.md`); **fully-local Mnestra** (SQLite + local embeddings, zero external deps); **multi-port "Path B"** (per-instance SQLite, `TERMDECK_PORT` threading, launcher SIGTERM fix); **standalone-shell capture** (Codex/Gemini/Grok run outside TermDeck — still uncovered); **3+1+1 hardening** (Mnestra MCP wired into Codex CLI); the **3+1+1 blog post + docsite refresh**.

## 6. Loose ends not owned by a sprint

- **4 mnestra Dependabot PRs** (`#2`/`#10`/`#11`/`#13`) — Dependabot auto-rebases onto the fixed `main`; merge when green, or enable auto-merge. All verified safe.
- **External-user follow-ups** — `termdeck init --rumen` on the R730 (re-pins `rumen-tick` to rumen 0.5.3), the `rumen_processed_at` reset, the "2a opens-invisible" repro.
- A prospective beta tester's onboarding DM is composed; to be sent.

## 7. Boot sequence for the next session

1. `mcp__mnestra__memory_recall(project="termdeck", query="Sprint 67 forward plan field-deployment CI follow-up 2026-05-17")`
2. `mcp__mnestra__memory_recall(query="recent TermDeck decisions and bugs")`
3. Read `~/.claude/CLAUDE.md`.
4. Read `./CLAUDE.md`.
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` — both P0 investigations remain closed.
6. Read **this file** — §3 is the forward plan.
7. `mcp__mnestra__memory_recall(project="termdeck", query="<the specific topic Joshua signals>")`

Then begin — most likely Sprint 67 (§3).

## 8. Resume command for this session

```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && claude --resume 9e59a945-8b2c-4dff-82c1-07d855494324
```

Session JSONL verified on disk (`~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/9e59a945-8b2c-4dff-82c1-07d855494324.jsonl`). §7 boots a fresh session cold; this command resumes the accumulated context.
