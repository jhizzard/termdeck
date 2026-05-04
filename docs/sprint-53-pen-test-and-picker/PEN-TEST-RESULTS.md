# Sprint 53 — Pen-test sweep results

**Lane:** T1 (Claude). **Run window:** 2026-05-04 17:14 → 17:30 ET. **Wall-clock:** ~16 min. **Demo context:** ran live during a Brad call as a 3+1+1 demonstration.

**Substrate:** termdeck@1.0.8 (npm latest), termdeck-stack@0.6.8, mnestra@0.4.2, rumen@0.4.5. macOS Sonoma + Docker Desktop + supabase CLI 2.75.0 (stale by 23 versions). Repo `origin/main` HEAD = `32d3e78`. The daily-driver Supabase project at `<project-ref>` (pre-Sprint-53 baseline: rumen_insights=321, last 2026-05-01 20:45 UTC).

## Matrix

| Cell | Command (gist) | Starting state | Expected | Observed | Status | Ledger |
|---|---|---|---|---|---|---|
| **A.0** | `termdeck init --rumen --yes` from `<repo>` | macOS, supabase CLI 2.75, **stale v1.0.7 global install** masquerading as v1.0.8 | success post-v1.0.8 (`--use-api`); 12/12 probes GREEN | graph-inference deploy fails with `entrypoint path does not exist` (Docker bundler `/var/folders` mount-restriction); audit-upgrade reports `1 skipped` because bundledSource probe path resolves to `@jhizzard/packages/...` (missing `termdeck/` segment) | **REGRESSION (false alarm — corrected by T4-CODEX)** | Re-confirms ledger #21 bugs 1+2 are LIVE for any user with stale v1.0.7 global install |
| **A.1 (rerun)** | `termdeck init --rumen --yes` from `<repo>` | macOS, supabase CLI 2.75, **v1.0.8 global install** (refreshed mid-sprint via `npm install -g @jhizzard/termdeck@1.0.8`) | success; 12/12 probes GREEN; both deploys via `--use-api`; manual POST + cron applied | **PASS clean in 19s.** Audit-upgrade 12/12 GREEN, 0 skipped. Both deploys: `Running: supabase functions deploy <fn> --project-ref <ref> --no-verify-jwt --use-api...` ✓. Manual POST `extracted: ?, surfaced: 0`. pg_cron schedules applied. | **PASS** | Ledger #21 fixes hold under wizard runtime. Side-finding: `extracted: ?` placeholder (printf-format or pre-T2-rewrite shape mismatch). |
| **B** | `cd /tmp/sprint-53-cell-B-cwd-<ts> && termdeck init --rumen --yes` with **`<repo>/supabase/functions/rumen-tick/index.ts` containing a poison marker** | macOS, v1.0.8 global, contaminated repo cwd | wizard's `cwd: stage` isolation prevents contamination | **PASS clean in 18s.** Wizard ran identically to A.1; deployed body downloaded via `supabase functions download rumen-tick --use-api -o ...` and `grep -c "CELL-B-POISON-MARKER" → 0`. Deployed body starts with canonical `// Rumen v0.1 ...`. Pin import line is `npm:@jhizzard/rumen@0.4.5` ✓. | **PASS** | Ledger #21 bug 3 closure verified. cwd isolation is architecturally guaranteed by `--use-api` (Management API path bypasses CLI's parent-dir walk). |
| **C** | `HOME=/tmp/td-test-home-<ts> termdeck init --mnestra --yes` (after copying secrets.env to new HOME) | macOS, v1.0.8 global, fresh HOME (no `~/.claude/`, no `~/.termdeck/`) | clean fresh-install path; mig 016 cron-conditional guard fires; hook + settings.json bootstrap from empty | **PASS clean in 2s.** `~/.claude/hooks/memory-session-end.js v2` installed (no prior copy); `~/.claude/settings.json` wired straight to `SessionEnd`; all 17 migrations re-applied (mig 016 in 46ms with no error); audit-upgrade 6/6 GREEN; `memory_status_aggregation()` returns 6,347 active memories. | **PASS** | Ledger #19 fix holds on a cron-enabled project re-application. **Caveat:** doesn't exercise the fresh-no-pg_cron branch of the guard — Sprint 53+ async follow-up needed (Cell C2 against a fresh Supabase project ref). |
| **D** | (force Docker bundler / no `--use-api`) | macOS, supabase CLI 2.75, v1.0.8 global | confirm Docker `/var/folders` failure pattern persists when `--use-api` removed | **REDUNDANT** — already reproduced by Cell A.0 (v1.0.7 source lacks `--use-api`, hits the exact `entrypoint path does not exist` failure). | **N/A (folded into A.0)** | Same envelope as A.0; ledger #21 #2 reproduced in the wild |
| **E** | `npm install -g @jhizzard/termdeck@1.0.8 && termdeck init --mnestra --yes` inside Linux Docker container, throwaway Supabase project | Linux, fresh container, fresh project | Brad-shape Linux SSH parity smoke | **SKIP** per brief (container setup > demo budget). | **SKIPPED** | Sprint 53+ async follow-up. The macOS-only sweep is itself a Class O sub-case worth canonizing — production-FS exercising must include a Linux platform cell. |

## Findings + ledger candidates

### NEW #22 candidate — Class O sub-case: stale-local-global-install drift on the publisher's own machine

**Discovered:** 2026-05-04 17:21 ET by T1 (Claude) Cell A first run; reopened by T4-CODEX as a misattribution (T1's first claim was "v1.0.8 regressed ledger #21 fixes"; T4 verified that the global install was at v1.0.7, not the registry-current v1.0.8, so the bug was v1.0.7's actual behavior, not a v1.0.8 regression).

**Pattern:** `npm view <pkg> version` (registry truth) and `cat <repo>/package.json` (working tree truth) both report 1.0.8, but `cat /usr/local/lib/node_modules/<pkg>/package.json` (locally-resolved binary's source) reports 1.0.7. Post-publish dogfood that omits a global-install refresh exercises the OLD code, not the NEW.

**Implication for Sprint 52 close:** Sprint 52's post-publish dogfood produced no error report — but Joshua's local global install was at v1.0.7 the whole time. The v1.0.8 fixes ride in c357bae (verified via `git log -p -S '--use-api'`) but were never exercised against the wizard's runtime path on Joshua's machine until Sprint 53 T1 mid-sprint refreshed.

**Pre-ship checklist candidate (item #15):** every post-publish dogfood MUST verify `node -e "console.log(require('@jhizzard/termdeck/package.json').version)"` matches the just-published version BEFORE running any wizard probe. Add to `docs/RELEASE.md`. Same for Brad-side install-pass instructions: include a "verify global install version matches registry latest" step.

### Reinforced ledger entries

- **#21 (Class O — Deployed-state drift, expanded scope):** all three sub-bugs verified closed at v1.0.8 under Cell A.1 + Cell B. The fixes hold; the catch was a stale-install issue, not a regression.
- **#19 (Class A — mig 016 cron-conditional guard):** holds under re-application on a cron-enabled project (Cell C). **Open follow-up:** untested against fresh Supabase project (no pg_cron) — that's the actual repro path the guard exists to handle.
- **#16 (Class N — settings.json Stop→SessionEnd wiring):** Cell C confirmed fresh-HOME bootstrap wires straight to SessionEnd, not Stop. v1.0.4 fix holds.

### Side findings (low-priority follow-ups)

- **`termdeck --version` UX:** invokes the launcher boot sequence rather than printing a single-line version. `--version` should short-circuit before any side effect.
- **Manual POST `extracted: ?`:** placeholder where a count is expected. Likely overlaps T2's picker rewrite scope; T2 should verify post-rewrite that the placeholder is replaced with a real integer.

## Cells deferred to Sprint 53+ async follow-up

- **C2** — fresh tmp HOME + **fresh Supabase project ref** + `init --mnestra --yes` to actually exercise mig 016's no-pg_cron branch.
- **E** — Brad-shape Linux SSH simulation via Docker container, against a throwaway Supabase project.
- **F (new candidate)** — `npm install -g <pkg>@latest` IDEMPOTENCE sweep: re-run install on already-installed v1.0.8, observe whether the `package.json` version actually flips from a stale prior version (covers the Sprint 53 T1 root cause).
- **G (new candidate)** — Multi-version upgrade chain: install v1.0.0 → v1.0.4 → v1.0.8 in sequence, run `init --mnestra` between each, observe wiring drift.

## Demo flow log (3+1+1 in action)

This sprint was a live demonstration of the 3+1+1 pattern's catch-rate during a Brad call. Notable:

- **17:14–17:17 ET:** all four lanes booted in <30s wall-clock; T1/T2/T3/T4-CODEX all posted KICKOFF/BOOT inside 3 minutes.
- **17:17 ET:** T4-CODEX caught T2 picker rewrite's `text` vs `uuid[]` shape risk (1 of 308 live `memory_sessions.session_id` rows is non-UUID — would poison the batch). T2 folded the finding into design before FIX-LANDED.
- **17:17 ET:** T4-CODEX caught T3 doctor brief's `started_at` vs `completed_at` mismatch on the live daily-driver substrate (`started_at`-filtered query returned 0 rows, `completed_at`-filtered returned 480). T3 folded into design.
- **17:19 ET:** T4-CODEX REOPENED T1's Cell A regression claim — independently verified the global install was at v1.0.7, not v1.0.8. T1's misattribution corrected within ~2 minutes of FINDING.
- **17:21–17:27 ET:** T1 refreshed install, reran Cell A (PASS), then Cell B (PASS).
- **17:29 ET:** T1 Cell C (PASS).
- **17:30 ET:** T1 Cell D collapsed (REDUNDANT) + Cell E SKIP per brief.

The Codex auditor's catch-rate prevented two bug misattributions (T1 stale-install, T2 text/uuid) and surfaced one substrate query bug (T3 started_at). Rate: 3 catches × ~25% sprint capacity allocated to audit. **Net cost-benefit:** decisive positive — without the auditor, the T1 finding would have shipped as a "v1.0.8 regression" and triggered an unnecessary Sprint 53.5 hotfix.
