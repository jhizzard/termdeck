# T3 — Doctor blindness fix (Claude worker, mnestra repo)

You are T3 in Sprint 53. Single-lane Claude worker. Owns the **doctor blindness fix** — surface `rumen_jobs.return_message` in `mnestra doctor` so when a cron actively errors, doctor reports the actual error string rather than just "ran X times, status unknown." Closes Sprint 51.5b T2 finding #1.

This sprint runs LIVE during a Brad call as a demo. Show the SHAPE of the work; full completion likely overruns the call window.

## Boot sequence (do these in order, no skipping)

1. `date '+%Y-%m-%d %H:%M ET'`
2. `memory_recall(project="termdeck", query="Sprint 53 doctor blindness rumen_jobs return_message DoctorDataSource rumenJobsRecent")`
3. `memory_recall(query="Sprint 51.5b T2 finding doctor cron return_message blindness")`
4. `memory_recall(project="mnestra", query="DoctorDataSource doctor render render-table cron probe")`
5. `memory_recall(project="termdeck", query="petvetbid externally facing scrub feedback")` — codename rule
6. Read `~/.claude/CLAUDE.md` (global)
7. Read `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` (your STATUS.md home)
8. Read `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-53-pen-test-and-picker/PLANNING.md` (sprint scope, Lane T3 section)
9. Read `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-53-pen-test-and-picker/STATUS.md`
10. **Cross-repo work:** all your CODE changes land in `~/Documents/Graciella/engram/` (the Mnestra package — repo path is still `engram` though npm name is `@jhizzard/mnestra`). Find `DoctorDataSource` (probably under `src/doctor/` or `src/data-sources/`). Find the doctor's render entry point that consumes the data source. Both need surgical extension.

## Lane focus — surface rumen_jobs.return_message

**Current state (per Sprint 51.5b T2):** `mnestra doctor` queries `cron.job_run_details` for tick activity but never reads `rumen_jobs.return_message`. When a cron tick errors, `cron.job_run_details.return_message` is populated with the error string, but doctor displays only counts + statuses, not the message. Brad's diagnosis-by-doctor is therefore strictly worse than diagnosis-by-psql.

**Fix shape:**

1. **NEW `DoctorDataSource.rumenJobsRecent(limit)` method.** Selects from `rumen_jobs` (NOT `cron.job_run_details` — different table; rumen_jobs is the rumen-package-managed queue):
```sql
SELECT id, started_at, completed_at, sessions_processed, insights_generated, return_message, error
  FROM rumen_jobs
  ORDER BY started_at DESC
  LIMIT $1;
```
Default limit: 5. Caller can override.

2. **Render the result as a table in doctor's main report.** Add a new section after the existing cron probe summary:
   - Header: "Recent rumen ticks"
   - Columns: `started_at | completed_at | sessions | insights | error | return_message (truncated)`
   - Show the most recent 5 by default.
   - When `return_message IS NOT NULL` AND non-empty: highlight the row (color or bold).
   - When `error IS NOT NULL`: show the error inline.

3. **Test additions** at `~/Documents/Graciella/engram/tests/doctor-rumen-jobs-recent.test.js`:
   - Mock `DoctorDataSource` rumenJobsRecent returns 5 rows with mixed states (some succeed-zero, some errored).
   - Assert doctor's render output contains all 5 row's `started_at` strings.
   - Assert errored rows surface their `return_message` in the output.
   - Assert no PII / project codename leaks in test fixtures (use neutral session IDs).

## Demo target

In the call window:
1. Implement `DoctorDataSource.rumenJobsRecent` (5 min).
2. Wire into doctor render (5 min).
3. Add the test file (5 min).
4. Run the test against the daily-driver project (10 min) to confirm a real rumen_jobs row's return_message renders correctly.
5. Post FIX-PROPOSED with file:line diffs.
6. **Don't ship.** Orchestrator handles publish wave at sprint close (mnestra 0.4.2 → 0.4.3 alongside Lane T2).

## Lane discipline

- **Post shape:** `### [T3] STATUS-VERB 2026-05-04 HH:MM ET — <gist>` in `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-53-pen-test-and-picker/STATUS.md` (NOT in engram's repo — STATUS.md is centralized in TermDeck).
- **No version bumps. No CHANGELOG edits. No commits in engram.** Orchestrator handles ship at sprint close.
- **Codename scrub rule:** test fixtures must NOT contain the daily-driver project name or ref. Use neutral session IDs like `test-session-001`.
- **Lane T2 coordination:** if T2's mig 018 lands a `rumen_processed_at` column on `memory_sessions`, that's a different table from your `rumen_jobs` query — no collision. But if T2 adds a column to `rumen_jobs` (unlikely; check their FIX-PROPOSED post), coordinate.

## When you're done

Post `### [T3] DONE 2026-05-04 HH:MM ET — doctor surfaces rumen_jobs.return_message` with:
- Diff stats for `engram/src/doctor/...`
- Test results (new test green, existing doctor tests unchanged)
- A live screenshot or paste of `mnestra doctor --json` output showing the new "Recent rumen ticks" section against the daily-driver project's actual rumen_jobs (proving Brad-equivalent diagnosis is now available)
- File:line refs

If the demo window closes mid-implementation, post `### [T3] PARTIAL — render WIP — handing over to orchestrator for sprint close`.

Begin.
