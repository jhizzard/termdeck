# Sprint 78 — Memory→Doctrine Loop

Planning home for Sprints 78–79 (and the deferred 80+ tail) of the memory→doctrine loop: doctrine registry, agent-facing live advisory, recall telemetry, Rumen elevation, and capture gates.

## Files

| File | What it is |
|---|---|
| `ULTRAPLAN-2026-06-12.md` | **Plan of record.** Synthesis of 4 stage designs + 4 adversarial verdicts + the 5-reader ground map. Contains: the loop diagram, ground-truth gap evidence, the four designs as-amended (all amendments constitutive), 3+1+1 lane tables for Sprints 78 and 79, open decisions for Josh, deferred tail. |
| `PLANNING.md` | (To be authored by ORCH at Sprint 78 dispatch, from ULTRAPLAN § 4.) |
| `STATUS.md` | (Created at dispatch; append-only lane board.) |
| `T1..T4-*.md` | (Lane briefs, authored from the Sprint 78 lane table.) |

## One-line orientation

Sprint 78 = doctrine registry core (T1, termdeck) + advisor MVP on the existing error trigger, registry-only (T2, termdeck) + recall-hit telemetry & webhook hardening (T3, engram) + Codex auditor (T4). Sprint 79 = capture gates (T1, engram) + Rumen doctrine-scan (T2, rumen) + materialize/ratify pipeline (T3, termdeck) + auditor (T4).

## Key constraints carried from the verdicts

- Forbidden strings NEVER in repo/tarball — local-only registry overlay, gitleaks shell-out scrub, no hardcoded denylists.
- Extend `packages/server/src/sprint-frontmatter.js`; never a second parser.
- Engram migrations 025/026 already exist — verify next free number at lane boot.
- Doctrine flow-back bypasses memoryRemember dedup (direct insert).
- STATUS.md is append-only; status-append rules are structurally advisory; only git hooks, sprint-inject refusal, and (future) PreToolUse deny can block.
- All termdeck-side code: vanilla JS, CommonJS, zero-build, fail-soft.
