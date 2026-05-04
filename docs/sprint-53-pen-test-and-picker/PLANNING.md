# Sprint 53 — Adversarial pen-test sweep + Rumen picker rewrite + doctor blindness fix

**Status:** Plan placeholder authored 2026-05-04 ~16:55 ET by orchestrator at the close of the v1.0.7+v1.0.8 dogfood-fold-in cycle. Full lane briefs to be written in the next orchestrator session (this is a forward-pointer plan, not a ready-to-execute brief).

**Pattern:** Mixed scope — combines a discovery sprint (pen-test sweep) with a planned-work sprint (Rumen picker rewrite + doctor fix). Two cross-repo publish waves: TermDeck (v1.0.9+) AND Rumen (0.5.0) AND possibly Mnestra (0.4.3 for doctor API). Estimated wall-clock: half-day to full-day depending on what the pen-test surfaces.

**Why this sprint exists.** Joshua's framing at the v1.0.7 commit window crystallized the meta-lesson from today's 8-sprint daily-onion cascade:

> Why do all of these weaknesses keep showing up? Why can we just go end to end through the entire project and fix everything that is broken, like a pen-tester would do with security? Brad is going to be done with this soon if we don't deliver a fully functional, non-erring product.

The honest answer: the v1.0.x onion has been **reactive triage** — fix-as-incident-fires. Every ledger entry (#13 → #21) was caught by Brad or a dogfood probe firing in production, NOT by a proactive sweep. Brad has been the unpaid QA team. That stops with Sprint 53.

## Goal

End-to-end adversarial sweep of the TermDeck install + upgrade surface BEFORE the next outside user encounters it. Enumerate (install-state × platform × cwd × external-state) and run the wizard cell-by-cell, capture failures, ledger them. The sweep is the deliverable; any code fixes that fall out are secondary follow-ups.

The Rumen picker rewrite and doctor blindness fix ride along because they were already queued and the sweep work parallelizes well with cross-repo lane work.

## Scope

### Lane T1 (orchestrator or T1-Claude) — Pen-test sweep

Build a matrix of (starting-state × platform × cwd) cells and exercise the wizard in each. Each cell is a single test run; failure = ledger entry candidate.

**Starting-state axis** (rows):
1. Fresh tmp HOME, no `~/.termdeck/`, no `~/.claude/`, no `~/.supabase/`
2. v1.0.0 first-install state (settings.json wired under `Stop`, hook v1, no mig 013-017)
3. v1.0.5 mid-cascade state (mig 013-016 applied, mig 017 absent, hook v2, settings.json wired correctly)
4. v1.0.7 broken-deploy state (audit-upgrade GREEN, but supabase functions deploy hangs/errors)
5. Joshua's daily-driver state (the daily-driver project + chopin-nashville projects + 6,350 memory_items + active rumen-tick at 0.4.5)
6. Brad's jizzard-brain state (clean Linux MobaXterm SSH, supabase CLI 2.x, no Docker)
7. Contaminated repo-cwd state (stray `<repo>/supabase/functions/` from prior debug runs — repro of v1.0.8 ledger #21 bug 3)

**Platform axis** (columns):
1. macOS Sonoma + Docker Desktop + supabase CLI 2.75 (Joshua's local — verified bug-prone)
2. macOS Sonoma + Docker Desktop + supabase CLI 2.98+ (current release)
3. macOS Sonoma + NO Docker installed (does --use-api still work? probably yes)
4. Linux MobaXterm SSH + supabase CLI 2.x (Brad's setup)
5. Linux container (e.g., Docker Ubuntu 24.04) — clean platform baseline

**cwd axis** (depth):
1. wizard run from `/tmp` (no parent supabase/)
2. wizard run from `~/Documents/Graciella/...` (TermDeck repo cwd, possibly contaminated)
3. wizard run from `$HOME` (no supabase context at all)

5 starting-states × 5 platforms × 3 cwds = 75 cells. We don't need full coverage — sample diagonal + known-bad cells. Realistic target: **15-20 cells** covering known failure modes plus 5 random cells for adversarial discovery.

**Output:** A `docs/sprint-53-pen-test-and-picker/PEN-TEST-RESULTS.md` table with columns (cell, command, expected, observed, ledger entry if new). Every novel failure is a Class-letter candidate or an existing-class reinforcement.

### Lane T2 (Rumen lane) — Picker rewrite

`~/Documents/Graciella/rumen/src/extract.ts:55-77` currently picks "candidate sessions" by joining `memory_items` rows GROUP BY source_session_id WHERE count >= N. This pattern assumed the pre-Sprint-51.6 multi-row-per-session writer (each Claude turn → one memory_items row). The new bundled hook (Sprint 51.6+) writes ONE row per session (the session_summary). Picker now sees `count = 1` for every session and the GROUP BY threshold filter rejects them all → 0 sessions to process per tick → 0 insights for 3+ days.

**Fix shape:** pivot to read from `memory_sessions` directly (now authoritative post-mig-017 per Sprint 51.6 T3). Each row in `memory_sessions` IS a candidate session (1:1, no grouping needed). Read the rumen-relevant fields (started_at, ended_at, summary, summary_embedding) directly. The picker becomes a SELECT against memory_sessions WHERE rumen_processed_at IS NULL ORDER BY started_at DESC LIMIT N.

Estimated change: ~30 LOC at extract.ts:55-77, plus a new column on memory_sessions (`rumen_processed_at timestamptz`) — that's a Mnestra migration 018, ride along with the picker rewrite.

Two-package publish wave: rumen 0.4.5 → 0.5.0 (picker rewrite is a behavioral change, semver-minor at minimum) + mnestra 0.4.2 → 0.4.3 (mig 018) + termdeck 1.0.8 → 1.0.9 (bundled mnestra + rumen versions bump).

### Lane T3 (Mnestra lane) — Doctor blindness fix

`mnestra doctor` currently has cron probes that report "unknown" when no rows are present in cron.job_run_details for the last N hours. Sprint 51.5b T2 #1: doctor's cron return_message field is never surfaced — so when a cron actively errors, doctor still says "ran X times, status unknown" rather than the actual return_message. Brad's diagnosis-by-doctor experience is therefore worse than his diagnosis-by-psql experience.

**Fix shape:** add `DoctorDataSource.rumenJobsRecent(limit)` API to `~/Documents/Graciella/engram/src/...` that selects (started_at, completed_at, sessions_processed, insights_generated, return_message, error) from rumen_jobs ORDER BY started_at DESC LIMIT N. Doctor renders these as a table. Auditor can see WHEN insights stopped flowing AND WHY (return_message != null on errored ticks).

Mnestra package change. Publish wave: mnestra 0.4.2 → 0.4.3 (alongside Lane T2's Mnestra mig 018 if they share the wave).

### Lane T4 (auditor — Codex preferred) — Adversarial review

Per the 3+1+1 hardening rules canonized today. Codex panel with auto-review mode pre-set in the lane brief (closes the 51.5b approval-mode gap). Audits T1's pen-test results AND T2/T3's code WIP before FIX-LANDED. Posts CHECKPOINTs every 15 min per the auditor compaction-checkpoint rule.

## Acceptance criteria

1. **Pen-test sweep complete.** PEN-TEST-RESULTS.md has at least 15 cells exercised, with explicit pass/fail for each. Every novel failure has a ledger entry written or queued. No "we'll get to it later" entries.
2. **Rumen picker rewrite shipped.** `select count(*), max(created_at) from rumen_insights` against the daily-driver project grows past 321 within 30 min of post-deploy tick. (If it doesn't grow, the picker rewrite missed something — back to lane T2.)
3. **Doctor blindness fix shipped.** `mnestra doctor --json` against the daily-driver project surfaces the rumen_jobs.return_message field for at least the most recent 5 ticks. Brad's diagnosis-by-doctor matches diagnosis-by-psql.
4. **Cross-repo publish wave clean.** rumen 0.5.0 + mnestra 0.4.3 + termdeck 1.0.9 + termdeck-stack 0.6.9 (audit-trail) all publish via Passkey, all pushed to origin/main, all verified via `npm view` post-publish.
5. **No new bugs uncovered post-publish on the daily-driver project.** v1.0.9 dogfood from a contaminated state (Joshua's actual machine) succeeds end-to-end. If it doesn't, that's a Sprint 54 trigger, but the failure must be caught by the dogfood, NOT by Brad in production.

## Pre-sprint substrate (orchestrator probes before authoring lane briefs)

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"' | sed 's/?pgbouncer.*//')

# Confirm v1.0.8 live
npm view @jhizzard/termdeck version          # expect 1.0.8
npm view @jhizzard/termdeck-stack version    # expect 0.6.8
npm view @jhizzard/rumen version             # expect 0.4.5 (pre-rewrite baseline)
npm view @jhizzard/mnestra version           # expect 0.4.2

# Confirm post-v1.0.8 dogfood state on the daily-driver project
psql "$DATABASE_URL" -c "select count(*), max(created_at) from rumen_insights"
# expect: still 321 / 2026-05-01 (pre-Sprint-53 baseline; will grow when Lane T2 ships)

# Confirm deployed pin is 0.4.5 (refreshed via Sprint 52 dogfood)
SUPABASE_ACCESS_TOKEN=<token> mkdir -p /tmp/sprint-53-substrate && cd /tmp/sprint-53-substrate \
  && supabase functions download rumen-tick --project-ref <project-ref> --use-api
grep -E "npm:@jhizzard/rumen@" /tmp/sprint-53-substrate/supabase/functions/rumen-tick/index.ts
# expect: 0.4.5

# Confirm rumen_jobs all-zero pattern persists (proves picker bug, not pin drift)
psql "$DATABASE_URL" -c "select count(*) filter (where sessions_processed=0) as zero_ticks, count(*) filter (where sessions_processed>0) as productive, max(started_at) filter (where sessions_processed>0) as last_productive from rumen_jobs where started_at > now() - interval '5 days'"
# expect: zero_ticks > 280, productive < 10, last_productive ~ 2026-05-01
```

## Risks

- **Pen-test cell explosion.** 75 cells is too many; 15-20 is right. Bias toward cells that simulate Brad's likely starting state (Linux SSH, contaminated cwd, mid-version installs) and Joshua's known-bad combinations (macOS+Docker+stale CLI). Skip cells that are "fresh user, fresh project, current platform" — those are the ONLY ones that work today.
- **Cross-repo publish coordination.** Three-package wave needs the right order: mnestra mig 018 lands first (writes the column), then rumen reads from the new column shape, then termdeck bumps bundled deps. Get this wrong and existing installs lock up.
- **Doctor fix scope creep.** "Doctor blindness" is a broad bucket; constrain to JUST the rumen_jobs.return_message surface + rumen_jobs table render. Other doctor improvements (memory_relationships density, cron-job firing latency, etc.) ship in a separate Sprint 54+ pass.
- **Brad's confidence window.** Joshua's framing at v1.0.7 commit time was explicit: "Brad is going to be done with this soon." Sprint 53 needs to demonstrate proactive sweep capability, not just another reactive patch. Lane T1's pen-test results going to Brad as a "here's what we found and fixed BEFORE you would have hit it" message is the actual deliverable.

## Out of scope (deferred to Sprint 54+)

- Doctor's memory_relationships density probe (mentioned in 51.5b T2 finding #2).
- Doctor env-var discoverability nit (51.5b T2 finding #3).
- Migration-authoring linter that flags `CREATE OR REPLACE FUNCTION` without drift-tolerant prelude (multiple Sprint 51.x sister incidents canonized this pattern; linter is post-Sprint-53 polish).
- Cost-monitoring expandable dashboard panel (original Sprint 51 vision, queued as Sprint 54).
- Maestro / chopin-scheduler SaaS readiness (Sprint 24 — independent of TermDeck).

## Sprint queue after Sprint 53

1. **Sprint 54 — Cost-monitoring panel** (original Sprint 51 vision unchanged).
2. **Sprint 55 — Doctor & migration-authoring linter polish** (deferrals from 53 + the 51.x linter idea).
3. **Sprint 24 — Maestro / chopin-scheduler** (independent of TermDeck; starts after Joshua's mail merge completes).

## Companion artifact

PEN-TEST-RESULTS.md — the actual matrix output. Lives in `docs/sprint-53-pen-test-and-picker/PEN-TEST-RESULTS.md`. Each row: `| cell | command | expected | observed | status | ledger ref |`. Populated during Lane T1 work. The artifact is shareable with Brad post-sprint as evidence of the proactive-sweep posture.
