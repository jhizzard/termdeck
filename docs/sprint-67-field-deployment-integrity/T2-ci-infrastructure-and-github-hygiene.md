# Sprint 67 · T2 — CI infrastructure + GitHub hygiene

**Lane:** T2 (Claude worker) · **Sprint:** 67 — Field-deployment integrity · **Owner:** Claude

## Boot sequence

Per `PLANNING.md` § Boot sequence.

## Your mission

Make CI genuinely green on GitHub (not just `npm test` locally), clear the trailing dependency-PR backlog, and add light branch protection. Most of this lane is GitHub operations, not code. You do NOT own the hook work (T1) or docs (T3).

Several steps are **operator-in-the-loop** — flag them and hand the exact command/values to the orchestrator for Joshua.

## Deliverables

**2.1 — Re-provision the CI secrets.**
The `install-smoke` / `macos-install-smoke` / `systemd-nightly` workflows fail on absent GitHub Actions secrets (9 total). The runbook is already written: `docs/sprint-66-public-scrutiny-cleanup/CI-SECRET-REPROVISIONING.md`. Walk it. `gh secret set` needs real secret values — the operator supplies them; you prepare the exact commands and verify each workflow goes green (or stays correctly skip-neutral) afterward. Confirm the Sprint-66 skip-neutral gate still holds when secrets ARE present (a real install regression must still fail the job).

**2.2 — Merge the trailing mnestra Dependabot PRs.**
Four PRs on `jhizzard/mnestra`, all verified safe in the 2026-05-17 CI-followup session, awaiting Dependabot auto-rebase onto the fixed `main`: `#2` checkout@6, `#10` typescript@6, `#11` zod@4, `#13` supabase-js. Merge each once green; confirm `main` CI stays green through the sequence.

**2.3 — Close stale termdeck Dependabot PRs.**
Sprint 66 resolved the 4 termdeck Dependabot major-bump PRs in-tree (`express` 4→5, `@anthropic-ai/sdk`, `uuid`/`open` by removal). The original PRs (`#4`/`#7`/`#9`/`#10` on `jhizzard/termdeck`) are superseded — close them with a one-line pointer to the in-tree commit.

**2.4 — Light branch protection.**
Add light branch protection to `main` on `jhizzard/termdeck`, `jhizzard/mnestra`, `jhizzard/rumen` — require the CI status check to pass before merge; no force-push. Prepare the exact ruleset; if applying it is classifier-blocked, hand the operator the precise GitHub settings path + values.

## Files you'll touch

Mostly GitHub-side (`gh` CLI / repo settings). Possibly `.github/workflows/*.yml` if a workflow needs a skip-gate adjustment — but the Sprint 66 skip-neutral gate should already be correct; change a workflow only with evidence.

## Not your lane

Hook field-deployment (T1). Doc hygiene (T3). No version bumps, no CHANGELOG, no commits.

## Lane discipline

Post `### [T2] <VERB> 2026-MM-DD HH:MM ET — <gist>`. Mark every operator-dependent step (secret values, branch protection if blocked) clearly so the orchestrator can batch them for Joshua rather than blocking the lane.
