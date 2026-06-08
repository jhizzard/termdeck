# Sprint 67 — Field-deployment integrity + loose-ends convergence

**Authored:** 2026-05-19 by the orchestrator session (`af97e403`), **staged for a later kick-off** alongside Sprint 68. **Refreshed 2026-05-23** to align with post-Sprint-69 (v1.6.0) + v1.6.1 hotfix baseline and the parallel Maestro sprint occupying port 3000.
**Inject:** 4 panels to be opened on `http://127.0.0.1:3001` — T1/T2/T3 Claude + T4 Codex. **Port 3001** (not 3000) because a Maestro sprint is currently running on the default port. The orchestrator injects via the TermDeck input API on Joshua's go (never copy-paste).
**Pattern:** 3+1+1 — three Claude worker lanes (T1/T2/T3), one Codex auditor (T4), one orchestrator.
**Runs:** **first** — before Sprint 68. Sprint 67 fixes the *existing* hook deployment; Sprint 68 builds new hooks on that verified foundation.
**Wave target:** `@jhizzard/termdeck` + `@jhizzard/termdeck-stack` **patch bump 1.6.1 → 1.6.2** *if* T1 lands the `runHookRefresh` code fix (it is real shipped code in `packages/cli/`). CI / GitHub / doc-hygiene work is non-package and needs no bump. `@jhizzard/mnestra` / `@jhizzard/rumen` unchanged. Orchestrator confirms at close-out. **Baseline shifted since this sprint was staged:** Sprint 69 shipped v1.6.0 (orchestration-hardening primitives) on 2026-05-20, and v1.6.1 shipped on 2026-05-23 as a single-line CSS hotfix for the orch-pin-row / `layout-focus` sibling-container gap reported by Brad against v1.6.0. **T3's `BACKLOG.md` rewrite must incorporate the D.6 section** added 2026-05-23 (7 items from Brad's 2026-05-17 → 2026-05-22 wave) — do not delete it; consolidate into the rewritten structure.
**Acceptance:** T4-CODEX FINAL-VERDICT GREEN with file:line evidence; the `PreCompact` hook verified firing on the daily-driver; `termdeck init --mnestra` reliably refreshes both bundled hooks; all three stack repos' CI green + branch-protected; `BACKLOG.md` is a clean current doc; `~/.claude/CLAUDE.md` trimmed with zero load-bearing rules lost.

---

## Why this sprint exists

"Shipped" is not "running in the field." Two recent incidents proved it:

- **Sprint 64's `PreCompact` auto-commit hook shipped in the npm package but was never deployed on the daily-driver** — the hook file landed mid-close-out and the `~/.claude/settings.json` wiring was handed to Joshua (the permission classifier hard-blocks an agent self-wiring a hook). Compaction-state may still be silently lost on the daily-driver until this is verified.
- **CI was green on `npm test` while red on GitHub for ~2 weeks** across Sprints 63–65 — environment/fixture drift, not product bugs, but invisible from inside the repo. (The mnestra/rumen halves were closed in the 2026-05-17 CI-followup session; TermDeck's secret-gated workflows remain.)

Sprint 67 closes the field-deployment gap and clears the accumulated hygiene loose-ends, so the substrate is verified-solid before Sprints 68–70 build on it. **It runs first** — everything downstream assumes the memory substrate works.

**On the stale session-end hook:** the daily-driver's `~/.claude/hooks/memory-session-end.js` (dated May 4, pre-Sprint-62) was **already refreshed out-of-sprint on 2026-05-19** — a surgical one-file copy of the Sprint-64 bundled version (backup at `~/.claude/hooks/memory-session-end.js.bak.20260519-134416`). **T1 does not redo that.** T1's job is the *systemic* fix — root-cause why the installer's refresh path let the file go stale for ~6 weeks, and repair it so it cannot recur.

---

## Constraints — operator-in-the-loop steps

Several Sprint 67 deliverables need Joshua at the keyboard; the agent cannot do them. Lanes produce the artifact (code, runbook, exact instruction); the orchestrator pauses for the operator at these points:

- **Wiring `~/.claude/settings.json`** — classifier-hard-blocked for the agent (a Sprint 66 finding). T1 verifies current state and, if a change is needed, produces the exact JSON + a one-line operator instruction. *(As of 2026-05-19 both `SessionEnd` and `PreCompact` are already wired — likely a no-op, but T1 confirms.)*
- **Triggering a real context compaction** — a human action. T1 delivers a verification *procedure*; the operator runs it.
- **Providing GitHub Actions secret values** — `gh secret set` needs real secret values. T2 walks the runbook; the operator supplies values.
- **GitHub branch protection** — may be classifier-blocked. T2 prepares the exact ruleset; the operator applies it if blocked.

---

## Lane structure (3+1+1)

| Lane | Owner | Focus |
|------|-------|-------|
| T1 | Claude | **Hook field-deployment** — verify the `PreCompact` hook fires on the daily-driver; root-cause + fix the systemic `runHookRefresh` bug |
| T2 | Claude | **CI infrastructure + GitHub hygiene** — re-provision the CI secrets; merge/close the trailing Dependabot PRs; light branch protection on the three stack repos |
| T3 | Claude | **Doc hygiene** — rewrite `docs/BACKLOG.md`; trim `~/.claude/CLAUDE.md`; retire or gate the legacy `orch` grid layout |
| T4 | Codex | **Adversarial auditor** — reproduce the `runHookRefresh` fix; verify the CLAUDE.md trim loses zero load-bearing rules; confirm CI is genuinely green |
| Orch | Claude | version/CHANGELOG/commit/publish hand-off/push/tag; kitchen-memory harvest from STATUS.md; close-out |

**T4 is the Codex panel** — the orchestrator maps the Codex session to T4 at inject regardless of grid position.

---

## Scope summary (full detail in each lane brief)

### T1 — Hook field-deployment (`T1-hook-field-deployment.md`)

Two deliverables. **(a) Verify the `PreCompact` hook fires.** The `~/.claude/settings.json` wiring is confirmed present (verified 2026-05-19 — both `SessionEnd` and `PreCompact` groups); the open question is whether the hook *fires* and writes a `pre_compact_snapshot` row to Mnestra on a real compaction. T1 delivers a verification procedure; the operator triggers a real compaction; the row must land. If it does not, root-cause (hook path, env vars, hook error). **(b) The systemic `runHookRefresh` fix.** Root-cause why the daily-driver's `memory-session-end.js` stayed at May 4 through Sprints 64–66 — a `runHookRefresh` / `installPreCompactHook` logic bug, a stale global `termdeck` (1.4.0 vs 1.5.0), or simply never-run — and repair it so `termdeck init --mnestra` reliably refreshes **both** bundled hooks on every install/upgrade. The one-off file refresh is already done; do not redo it.

### T2 — CI infrastructure + GitHub hygiene (`T2-ci-infrastructure-and-github-hygiene.md`)

Re-provision the 9 GitHub Actions secrets for `install-smoke` / `macos-install-smoke` / `systemd-nightly` using the runbook already written at `docs/sprint-66-public-scrutiny-cleanup/CI-SECRET-REPROVISIONING.md` (operator supplies values). Merge the 4 trailing mnestra Dependabot PRs (#2 checkout@6, #10 typescript@6, #11 zod@4, #13 supabase-js — all verified safe in the 2026-05-17 CI-followup session) once auto-rebased. Close the stale termdeck Dependabot PRs superseded by Sprint 66's in-tree bumps. Add light branch protection to `main` on `jhizzard/termdeck`, `jhizzard/mnestra`, `jhizzard/rumen`.

### T3 — Doc hygiene (`T3-doc-hygiene.md`)

Rewrite `docs/BACKLOG.md` into a clean, deduplicated, current backlog — it has accreted to ~70 KB with `✅ CLOSED` entries layered inline and a stale 2026-04-27 header. Trim `~/.claude/CLAUDE.md` (~387 lines → ~250) — promote historical "Sprint N" war-story paragraphs to Mnestra, **preserve every load-bearing rule verbatim**. Retire or gate the legacy `orch` grid layout in `app.js` (it spans the last worker oddly now that the role-tagged ORCH tile moves to `#orch-pin-row`).

### T4 — Codex auditor (`T4-codex-auditor.md`)

Reproduce the `runHookRefresh` fix against a deliberately-staled hook state. Diff `~/.claude/CLAUDE.md` old-vs-new and enumerate every rule to confirm the trim lost zero load-bearing content. Confirm CI is genuinely green on GitHub (not just `npm test` locally). CHECKPOINT discipline.

---

## INSTALLER-PITFALLS trace (mandatory — `docs/INSTALLER-PITFALLS.md`)

T1 touches the installer surface (`runHookRefresh`, `installPreCompactHook`). Classes in scope:

- **Class N (lockstep drift)** — the `runHookRefresh` bug *is* a Class-N failure: a refresh path that should keep multiple local-FS hook files in sync but did not. The fix must refresh **all** bundled hooks as a unit, and the e2e test must drive from a *stale prior-version* starting state, not the developer's already-current state.
- **Class M (write-path absence)** — confirm the refresh has a real code path for `memory-pre-compact.js`, not only `memory-session-end.js`.
- **Class I (silent no-op)** — the refresh "evidently did not" run but presumably reported success; the fix should make a should-have-refreshed-but-didn't case visible.
- **Class G (stale-cache pinning)** — consider whether the daily-driver's global `termdeck` being 1.4.0 (vs 1.5.0 published) is part of the refresh-miss story.
- Pre-ship checklist most at risk: #1 (upgrade-path tested, not just fresh-install), #2 (idempotent re-runs), #13 (lockstep local-FS components migrated as a unit).

---

## Hardening rules (mandatory — global `CLAUDE.md` + project)

1. **Post-shape uniformity** — every lane posts `### [Tn] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`; the `### ` prefix is REQUIRED; T4 posts `### [T4-CODEX] ...`.
2. **Auditor CHECKPOINT discipline** — T4 posts `### [T4-CODEX] CHECKPOINT ...` at every phase boundary and ≥ every 15 min.
3. **Idle-poll regex hardening** — any lane polling another uses the tolerant `^(### )?\[T<n>\] DONE\b`.
4. **No forbidden literals** — no internal Supabase project name / ref anywhere in `docs/sprint-67-*`, code, or commit messages. The gitleaks pre-commit hook enforces this. (T3's `BACKLOG.md` rewrite is the highest-risk file — scrub as you go.)
5. **No "pen-test" framing** — "adversarial sweep" / "end-to-end functional sweep".
6. **No version bumps / CHANGELOG edits / commits from lanes** — the orchestrator does those at close-out.
7. **Supabase RLS hygiene** — no SQL expected this sprint; if a migration appears, the five hygiene gates apply.

---

## Acceptance criteria

**For sprint close (T4-CODEX FINAL-VERDICT GREEN, file:line evidence per lane):**

- **T1:** the `runHookRefresh` systemic bug is root-caused and fixed (verified by reproducing a stale-hook state → running the fixed refresh → both hooks update); a `PreCompact`-fires verification procedure is delivered and — operator-permitting — run, with a `pre_compact_snapshot` row confirmed in Mnestra.
- **T2:** the 9 CI secrets re-provisioned and the three secret-gated workflows green; the 4 mnestra Dependabot PRs merged; stale termdeck Dependabot PRs closed; `main` branch-protected on all three repos.
- **T3:** `BACKLOG.md` is a clean, current, deduplicated doc; `~/.claude/CLAUDE.md` trimmed to ~250 lines with zero load-bearing rules lost (T4 verifies by enumeration); the legacy `orch` layout retired or gated.
- **T4-CODEX:** FINAL-VERDICT GREEN with file:line evidence for all three lanes.

**For ship (orchestrator scope):**

- If T1 landed code: `@jhizzard/termdeck` + `@jhizzard/termdeck-stack` bumped to 1.6.2, CHANGELOG entry, published (Passkey by Joshua), committed, pushed, tagged — per `docs/RELEASE.md`. If no package code changed, commit + push the non-package work, no publish.
- This file gains a `## Resolution` section; `RESTART-PROMPT-<close-date>-post-sprint-67.md` authored.

---

## Out of scope

- Sprint 68's native-CLI-hooks work (standalone-shell capture) — separate staged sprint, runs after this one.
- Any new feature — Sprint 67 is verification + hygiene only.
- The dashboard (Sprint 69) and memory-technology (Sprint 70) work.

---

## Risks / open questions

- **Operator availability gates the sprint.** The compaction-trigger, secret values, and branch-protection steps need Joshua. If he is not at the keyboard, lanes complete their code/runbook deliverables and the orchestrator parks the operator-dependent verifications as a documented hand-off rather than blocking.
- **The `~/.claude/CLAUDE.md` trim is delicate.** Losing a load-bearing rule is the failure mode — that file is the Paradigm tier. T4's enumeration audit is the specific guard; T3 must move (not delete) historical content to Mnestra.
- **`runHookRefresh` root cause may be "never run," not "buggy."** If so, T1's deliverable shifts toward making the refresh-miss *visible* (Class I) and documenting the upgrade path, rather than a logic fix.

---

## Boot sequence (each lane reads this top-to-bottom)

1. `mcp__mnestra__memory_recall(project="termdeck", query="<lane-specific topic>")`
2. `mcp__mnestra__memory_recall(query="Sprint 67 field-deployment integrity hooks CI doc hygiene")`
3. `mcp__mnestra__memory_recall(query="recent TermDeck decisions and bugs")`
4. Read `~/.claude/CLAUDE.md` (global rules)
5. Read `./CLAUDE.md` (TermDeck project read-order)
6. Read `docs/RESTART-PROMPT-2026-05-19-sprint-68-staged.md` (most-recent restart prompt — covers Sprints 67–70)
7. Read `docs/INSTALLER-PITFALLS.md` (mandatory for T1 — installer-surface work)
8. Read `docs/sprint-67-field-deployment-integrity/PLANNING.md` (this file)
9. Read `docs/sprint-67-field-deployment-integrity/STATUS.md`
10. Read `docs/sprint-67-field-deployment-integrity/T<n>-<lane>.md` (your full briefing)

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / FIX-LANDED / DONE with the canonical `### [Tn] ...` shape. No version bumps, no CHANGELOG edits, no commits — the orchestrator handles close-out.

---

## Inject protocol

Two-stage submit pattern per `~/.claude/CLAUDE.md` § 3+1+1 orchestration. **TermDeck server on `http://127.0.0.1:3001`** (port 3001 because the Maestro sprint occupies the default 3000). One-shot Node script at `/tmp/inject-sprint-67-prompts.js`: paste pass (`\x1b[200~<brief>\x1b[201~`, no CR) across all 4 sessions with ~250 ms gaps → 400 ms settle → submit pass (`\r` alone) across all 4. Verify each panel reaches `status: 'thinking'` within 8 s; `POST /api/sessions/:id/poke` with `methods: ['cr-flood']` for any panel still idle.

---

## Resolution

_(Filled at sprint close.)_
