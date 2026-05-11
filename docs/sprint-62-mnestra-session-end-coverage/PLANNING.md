# Sprint 62 — Mnestra Session-End Coverage Gap

**Sprint shape:** 3+1+1 (T1/T2/T3 Claude workers + T4 Codex auditor + Orchestrator)
**Origin:** ClaimGuard Sprint 8.0 Pipeline Compliance Audit (2026-05-08) surfaced the gap empirically. Source brief: `SOURCE-BRIEF-from-claimguard-sprint-8.0.md` in this directory.
**Closes:** Investigation 1 of `docs/CRITICAL-READ-FIRST-2026-05-07.md` (cross-agent Mnestra capture on close — now empirically confirmed at 27% coverage).
**Estimated wall-clock:** ~90 min from inject → T4-CODEX FINAL-VERDICT GREEN.

---

## 1. Why this sprint

Mnestra is the project's institutional memory. It currently writes only the **Claude orchestrator's view** of multi-lane sprints — Codex/Gemini/Grok lanes produce substantive findings that vanish at `/exit`.

Joshua fired `/exit` in three TermDeck panels (Codex/Gemini/Grok) at the close of ClaimGuard Sprint 8.0. All three exited cleanly. Zero `session_summary` rows landed in Mnestra. The lane outputs (~50 KB of pipeline findings + Python prototypes + a §20.4-schema bias_audit_report.json) are durable on disk but invisible to `memory_recall`.

The gap has been silently underwriting Mnestra since Sprint 38's Claude-only hook rewrite. Sprint 45 added the non-Claude adapters (storing JSONL at `~/.codex/sessions/`, `~/.gemini/...`, `~/.grok/...`) but never wired them to the writer.

Two compounding issues from the same audit:
- **Project-tag drift** — same project tagged `claimguard` (29 rows), `gorgias-ticket-monitor` (245 rows), `gorgias` (541 rows). Sprint 21 T2's rename was scoped-out and never finished.
- **source_agent silent drop** — pre-Sprint-50 rows have `source_agent=NULL` and are silently excluded from filtered `memory_recall` queries (per the tool's own docstring).

## 2. Headline metrics (taken 2026-05-08 from `mcp__mnestra__memory_status`)

| Metric | Pre-Sprint-62 | Target | Owner |
|---|---|---|---|
| `sessions_processed` | 359 | — | (informational) |
| `session_summary` memories | 97 (27%) | >80% | T1 |
| `memory_recall(project="claimguard")` | ~29 rows | ~815 rows | T2 |
| NULL `source_agent` rows | 3,000+ (~50%+) | <5% | T3 |

## 3. Lane assignments

### T1 (Claude) — Adapter session-end Mnestra writer
**Repos:** termdeck (`packages/server/src/adapters/`, `packages/stack-installer/assets/hooks/`, `packages/server/tests/`)
**Mission:** wire Codex/Gemini/Grok adapter session-close → Mnestra `session_summary` write. Single row per `/exit`. No false-positive on JSONL rotation. `source_agent` set explicitly per adapter. Project resolved via existing PROJECT_MAP.
**Acceptance:** synthetic + real Codex session produces one row with correct shape; same for Gemini + Grok. Tests green.

### T2 (Claude) — Project-tag canonicalize migration
**Repo:** engram (`migrations/021_project_tag_canonicalize_claimguard.sql`)
**Mission:** `update memory_items set project='claimguard' where project in ('gorgias','gorgias-ticket-monitor')`. Idempotent, RLS-respecting, with post-apply diagnostic + reversibility note.
**Acceptance:** ~815 claimguard rows post-apply; 4 existing project-tag invariant tests stay green.

### T3 (Claude) — Source-agent backfill
**Repo:** engram (`migrations/022_source_agent_backfill.sql`, optionally `src/recall.ts`)
**Mission:** predicate-based backfill — `session_summary` rows with JSONL path → adapter from path; orchestrator-authored `decision`/`bug_fix` rows → `claude` or `orchestrator`. Conservative: leave residuals NULL with documented rationale. Optionally add `include_null_source` flag to `memory_recall`.
**Acceptance:** NULL-source rows < 5% of corpus.

### T4-CODEX — Independent auditor
**Mission:** adversarial review. Verify T1 fires on real `/exit` and not JSONL rotation. Verify T2 migration is reversible + RLS-respecting. Verify T3 backfill doesn't cross-tenant leak (spot-check claimguard / pvb / termdeck-dogfood). CHECKPOINT every 15 min + at every phase boundary.

### Orchestrator (Claude Opus, separate session)
Standard close-out: CHANGELOG entries (engram + termdeck + termdeck-stack), version bumps (TBD at close — most likely `mnestra 0.4.8 → 0.4.9`, `termdeck 1.1.0 → 1.1.1` or `1.2.0`, `termdeck-stack 1.1.0 → 1.1.1`), Passkey npm publishes, git push origin main. Block on T4-CODEX FINAL-VERDICT GREEN.

## 4. Sequencing

1. T1 + T2 + T3 inject in parallel via TermDeck two-stage submit.
2. T4-CODEX boots in parallel, polls STATUS.md for worker FIX-LANDED posts; CHECKPOINTs every 15 min.
3. T4 raises FINDING / AUDIT-CONCERN as it sees them; workers iterate.
4. T1/T2/T3 post DONE.
5. T4 posts FINAL-VERDICT GREEN/YELLOW/RED.
6. Orchestrator close-out on GREEN.

## 5. Bundled with this publish wave

Two pre-existing staged changes ride this wave (already authored, uncommitted):

- **mnestra 0.4.8 ws-polyfill** in `~/Documents/Graciella/engram/src/db.ts` + `package.json` + `CHANGELOG.md`. Closes Brad's 2026-05-08 Node 20 `RealtimeClient` P1. Build + 67/67 tests green.
- **termdeck client paste-image fix** in `packages/client/public/app.js` (lines ~137 + ~299–331). Document-level capture-phase listener. 40/40 termdeck server tests green.

Sprint close-out version bumps must absorb both.

## 6. Out of scope

- **Wave 2 from Brad's bug-report triage** (body-parser/ws-ioctl/launcher Step-3/probe-converge/PTY-timeout/5-5-carryover/supervisor wrapper). Separate sprint.
- **Standalone-shell capture** (Codex/Gemini/Grok run outside TermDeck). Brief §1 flags as "lower priority than the TermDeck-side fix" — defer to Sprint 63.
- **Auto-commit-on-compaction-near** (Investigation 2 of CRITICAL-READ-FIRST-2026-05-07). Separate sprint.

## 7. Hardening rules (mandatory per project + global CLAUDE.md)

- **Post-shape uniformity (rule 2 from global CLAUDE.md hardening):** every lane uses `### [Tn] STATUS-VERB 2026-05-08 HH:MM ET — <gist>` — `### ` prefix REQUIRED on all lanes (Claude AND Codex), so cross-lane regex polling works.
- **Auditor CHECKPOINT discipline (rule 1):** T4-CODEX posts `### [T4-CODEX] CHECKPOINT ...` every phase boundary AND every 15 min. Survives Codex compaction.
- **Idle-poll regex hardening (rule 3):** orchestrator-side polling uses `^(### )?\[T1\] DONE\b` (and equivalents) — tolerant to absence of `### ` prefix as belt-and-suspenders.
- **No-forbidden-literals externally:** the reference Mnestra project ID + internal project name MUST NOT appear in any artifact in this sprint dir, in CHANGELOG entries, or in any cross-repo doc. Use "the reference Mnestra project" or "the daily-driver project" if a referent is needed.
