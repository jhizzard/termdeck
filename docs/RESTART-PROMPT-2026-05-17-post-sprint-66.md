# RESTART-PROMPT — 2026-05-17 post-Sprint-66

> **⚠ SUPERSEDED 2026-05-17 by `docs/RESTART-PROMPT-2026-05-17-ci-followup.md`.** Task #7 (Mnestra + Rumen red CI) — the headline carry-over below — is **COMPLETE**: both repos' `main` CI is green. Read the ci-followup doc for current state + the Sprint 67–69 forward plan.

**Authored:** 2026-05-17 at Sprint 66 close-out by orchestrator session `8d5b9432-f85f-4f3a-86e6-758d689f5bd1`.

**Why this file exists:** Sprint 66 ("Public-scrutiny cleanup") closed GREEN at 16:52 ET — TermDeck's first-public-scrutiny incident response. Wave target `@jhizzard/termdeck@1.5.0` + `@jhizzard/termdeck-stack@1.5.0`. This file boots the next TermDeck session. **Carried-over work is flagged in § What's next — most importantly the Mnestra + Rumen red-CI follow-up (task #7).**

---

## Boot sequence (in order)

1. `mcp__mnestra__memory_recall(project="termdeck", query="Sprint 66 close-out v1.5.0 CI reception dependency")`
2. `mcp__mnestra__memory_recall(query="recent TermDeck decisions and bugs 2026-05-17")`
3. Read `~/.claude/CLAUDE.md` — global rules.
4. Read `./CLAUDE.md` — TermDeck project router.
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` — both P0 investigations remain closed (but see the PreCompact-hook field-deployment gap in § What's next).
6. Read this file.
7. Read `docs/sprint-66-public-scrutiny-cleanup/PLANNING.md` § Resolution + `STATUS.md`.
8. `mcp__mnestra__memory_recall(project="termdeck", query="<specific topic Joshua signals at session start>")`

---

## What shipped 2026-05-17

| Wave | Versions | Sprint |
|------|----------|--------|
| Sprint 66 | `termdeck@1.5.0` + `termdeck-stack@1.5.0` | Public-scrutiny cleanup — CI reliability + Sprint-65 reception gap + dependency hygiene |

3+1+1 with Codex auditor; T4-CODEX FINAL-VERDICT GREEN. Root `npm test` 391 / 0 / 0. Full deliverable list: `CHANGELOG.md` [1.5.0] + `docs/sprint-66-public-scrutiny-cleanup/PLANNING.md` § Resolution. `@jhizzard/mnestra` + `@jhizzard/rumen` unchanged (0.4.9 / 0.5.3).

**If you are reading this and Sprint 66 was NOT yet published/pushed when the prior session ended:** run `npm view @jhizzard/termdeck version` (expect `1.5.0`). If it still shows `1.4.0`, the close-out's publish+push did not complete — `git log -1` + `git status` on the termdeck repo show where it stopped. Resume from `docs/RELEASE.md`'s publish sequence (npm publish ×2 via `--auth-type=web`, THEN `git push` + tag `v1.5.0`).

---

## What's next — priority order

**A — Mnestra + Rumen red CI (task #7, top carry-over).** Both repos have their own failing CI, untouched by Sprint 66: `jhizzard/mnestra` has 4 failing Dependabot-PR `ci` runs (`@types/node` 20→25, `typescript` 5→6, `zod` 3→4, `@supabase/supabase-js`); `jhizzard/rumen` CI has failed on every release push since v0.4.4 (2026-04-29) — a genuinely broken CI config. Investigate the root cause of each, fix properly, push real green-CI commits. No empty "freshness" commits.

**B — PreCompact hook field-deployment gap.** Sprint 64 shipped the `PreCompact` auto-commit hook in the npm package, but it was never installed on Joshua's daily-driver machine (hook file absent; `hooks.PreCompact` unwired in `~/.claude/settings.json`). The hook FILE was installed mid-Sprint-66-close-out; the `settings.json` WIRING was handed to Joshua (the permission classifier hard-blocks an agent editing its own startup config). Verify Joshua wired it. ALSO: the installed `~/.claude/hooks/memory-session-end.js` is dated May 4 (pre-Sprint-62) — stale. The `termdeck init --mnestra` hook-refresh path (`runHookRefresh` / `installPreCompactHook`) needs an audit — it should have installed/refreshed both hooks and evidently did not.

**C — Parked GitHub-side close-out items** (the Claude Code permission classifier blocked the orchestrator from these — Joshua runs them or explicitly re-authorizes): light branch protection on `main`; close stale PR #11; close superseded Dependabot PRs #4/#7/#9/#10.

**D — Brad follow-ups.** Brad to run `termdeck init --rumen` on the R730 (re-pins the `rumen-tick` Edge Function to rumen 0.5.3, fixing his Rumen-zero) + the `rumen_processed_at` reset, then report the test-POST output. Brad still owes the Sprint-65 "2a opens-invisible" repro.

**Sprint 67 candidates** — CI-secret re-provisioning (`docs/sprint-66-public-scrutiny-cleanup/CI-SECRET-REPROVISIONING.md`); the Sprint-65 D.5 deferrals still in `docs/BACKLOG.md` (draggable grid resize, 2a hypotheses A/C/D, legacy `orch` layout retire).

---

## Where the restart-prompt docs live

| Doc | Path |
|---|---|
| **Today (this file)** | `docs/RESTART-PROMPT-2026-05-17-post-sprint-66.md` |
| Sprint 65 close | `docs/RESTART-PROMPT-2026-05-16-post-sprint-65.md` |
| Project CLAUDE.md | `./CLAUDE.md` |
| Global CLAUDE.md | `~/.claude/CLAUDE.md` |
| Sprint 66 plan + resolution | `docs/sprint-66-public-scrutiny-cleanup/PLANNING.md` |
| Both P0 investigations | `docs/CRITICAL-READ-FIRST-2026-05-07.md` |

---

## Resume command for THIS orchestrator session

```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && claude --resume 8d5b9432-f85f-4f3a-86e6-758d689f5bd1
```

JSONL verified at `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/8d5b9432-f85f-4f3a-86e6-758d689f5bd1.jsonl`. The fresh-session boot sequence above is the canonical path; the resume command is the alternative for when in-context state (the Sprint 66 mechanics, the close-out hand-off state, the Mnestra/Rumen-CI thread) matters more than a clean re-read.
