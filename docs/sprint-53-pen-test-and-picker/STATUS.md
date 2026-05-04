# Sprint 53 STATUS — Adversarial pen-test sweep + Rumen picker rewrite + doctor blindness fix

**Plan authored:** 2026-05-04 ~16:55 ET; lane briefs authored 2026-05-04 ~17:00 ET.

**Pattern:** 3+1+1 (T1/T2/T3 Claude workers + T4 Codex auditor + orchestrator).

**Pre-sprint substrate (orchestrator probe at 17:00 ET):**

```
npm view @jhizzard/termdeck version          → 1.0.8
npm view @jhizzard/termdeck-stack version    → 0.6.8
npm view @jhizzard/mnestra version           → 0.4.2 (pre-doctor-API baseline)
npm view @jhizzard/rumen version             → 0.4.5 (pre-picker-rewrite baseline)

origin/main HEAD = 32d3e78 (codename scrub, post-v1.0.8)

The daily-driver project rumen_insights at sprint open: 321 / last 2026-05-01 20:45 UTC
The daily-driver project deployed rumen-tick pin: 0.4.5 (refreshed via Sprint 52 dogfood)
The daily-driver project rumen_jobs last 5 ticks: all done with sessions_processed=0 (proves picker bug, NOT pin drift)
```

## Lane status

| Lane | Owner | Repo | Status | Brief |
|---|---|---|---|---|
| **T1 — Pen-test sweep** | Claude | termdeck | PENDING (awaiting inject) | T1-pen-test-sweep.md |
| **T2 — Rumen picker rewrite** | Claude | rumen + mnestra | PENDING (awaiting inject) | T2-rumen-picker-rewrite.md |
| **T3 — Doctor blindness fix** | Claude | mnestra | PENDING (awaiting inject) | T3-doctor-blindness-fix.md |
| **T4 — Adversarial auditor** | Codex (auto-review approval mode) | read-only across termdeck + rumen + mnestra | PENDING (awaiting inject) | T4-codex-auditor.md |

## Demo context

This sprint runs LIVE during a Brad call as a demonstration of the 3+1+1 pattern. **Demo deliverable is the SHAPE of the work** (4 panels boot in <30 sec, workers post FINDINGs within 2-5 min, Codex auditor posts CHECKPOINTs and validates claims) — full sprint completion likely overruns the call window. **No version bumps, no CHANGELOG edits, no commits during the demo.** Orchestrator handles ship at sprint close (post-call).

## Lane discipline (binding for ALL lanes)

- **Post shape:** every status post uses `### [T<n>] STATUS-VERB 2026-05-04 HH:MM ET — <gist>`. T4 uses `### [T4-CODEX] STATUS-VERB ...`. Uniform shape across all lanes per hardening rule 2.
- **Auditor compaction-checkpoint discipline (T4 only):** post `### [T4-CODEX] CHECKPOINT 2026-05-04 HH:MM ET` at every phase boundary AND at least every 15 min. Each CHECKPOINT includes (a) phase + name, (b) what's verified with file:line evidence, (c) what's pending, (d) most recent worker FIX-LANDED reference.
- **Idle-poll regex (any cross-lane wait):** `^(### )?\[T<n>\] DONE\b` (tolerant — matches with or without `### ` prefix). Don't write brittle regex.
- **No version bumps. No CHANGELOG edits. No commits.** Orchestrator handles ship at sprint close.

## FINDING / FIX-PROPOSED / DONE log

(append-only; lanes post in canonical `### [T<n>] STATUS-VERB 2026-05-04 HH:MM ET — gist` shape)

---

### [T4-CODEX] CHECKPOINT 2026-05-04 17:15 ET — phase A complete; approval mode = auto-review; ready to audit T1/T2/T3

Verified boot substrate and lane contracts: global 3+1+1 hardening rules loaded from `~/.claude/CLAUDE.md`; Sprint 53 plan/status read; T1 owns pen-test cells A-E, T2 owns `memory_sessions` picker rewrite plus byte-identical mig 018 mirror, T3 owns `rumen_jobs.return_message` doctor surfacing. Class O context loaded from INSTALLER-PITFALLS #20/#21. Pending: phase B substrate probe (`npm view`, live DB counts, deployed rumen-tick pin, `git log`).

### [T4-CODEX] FINDING 2026-05-04 17:17 ET — phase B substrate mostly verified; rumen_jobs recency probe should use completed_at, not started_at

Verified: npm baselines `termdeck=1.0.8`, `termdeck-stack=0.6.8`, `mnestra=0.4.2`, `rumen=0.4.5`; git HEAD `32d3e78`; daily-driver `rumen_insights=321`, max `2026-05-01 20:45:02.916228+00`; deployed `rumen-tick` imports `npm:@jhizzard/rumen@0.4.5`. Mismatch: the planning query filters `rumen_jobs where started_at > now() - interval '5 days'`, which returns `0|0|NULL` because `started_at` is stale on these rows. Filtering by `completed_at` shows the recent tick pattern: `468` zero-session ticks, `12` productive, last productive `2026-05-01 20:45:02.921248+00`. T3 should verify whether doctor’s “recent rumen ticks” table orders by `completed_at` or otherwise treats `started_at` as unreliable in the live schema.

### [T4-CODEX] CHECKPOINT 2026-05-04 17:17 ET — phase B complete; substrate verified with one T3 contract caveat

Phase B evidence: package versions, git HEAD, daily-driver insight baseline, and deployed function pin all match Sprint 53 STATUS. Pending: audit T2 picker FIX-PROPOSED; audit T3 doctor FIX-PROPOSED with the `started_at`/`completed_at` caveat above; audit T1 cells as they post.

### [T4-CODEX] FINDING 2026-05-04 17:18 ET — T2 picker rewrite must account for `session_id text` vs `rumen_jobs.source_session_ids uuid[]`

Pre-FIX audit finding for T2: mig 017 defines `memory_sessions.session_id text` (`engram/migrations/017_memory_sessions_session_metadata.sql:44-46`), while Rumen currently writes and checks `rumen_jobs.source_session_ids` as `uuid[]` (`rumen/src/index.ts:218-224`, `rumen/src/extract.ts:112-119`). Live aggregate check found `1` non-UUID `memory_sessions.session_id` among `308` non-null session ids. If the rewrite feeds `memory_sessions.session_id` directly into `source_session_ids` casts, one non-UUID row can make a tick fail or force the lane to skip legitimate sessions. Safer options: use `memory_sessions.id` (uuid) as the Rumen job/session key while retaining `session_id` for human traceability, or add an explicit UUID-shape filter plus tests documenting skipped non-UUID sessions.

### [T4-CODEX] AUDIT 2026-05-04 17:19 ET — T1 Cell A REOPEN; run exercised installed 1.0.7, not v1.0.8

Cell A log shows the old Class O behavior: bundled-source path resolves under `/usr/local/lib/node_modules/@jhizzard/packages/...` and deploy banner omits `--use-api` (`/tmp/sprint-53-cell-A.log:18-25`). Independent check: global install is `@jhizzard/termdeck` `1.0.7`, while repo `package.json` is `1.0.8`. Repo source contains the expected fixes (`packages/server/src/setup/audit-upgrade.js:366` uses 4-level package-root resolution; `packages/cli/src/init-rumen.js:422-427` adds `--use-api`). Verdict: Cell A is a valid stale-install finding, but it does NOT validate the v1.0.8 daily-driver path. T1 should refresh global install or invoke the repo 1.0.8 binary, then rerun Cell A before marking pass/fail.

### [T4-CODEX] AUDIT 2026-05-04 17:21 ET — T3 plan REOPEN; recent rumen ticks must order by completed_at, not started_at

T3 correctly found `rumen_jobs` has `error_message`, not `return_message`, but the stated implementation plan still says order the new "Recent rumen ticks" table by `started_at DESC` per brief. Live evidence shows that will not surface recent ticks: `ORDER BY started_at DESC LIMIT 5` returns old/mixed rows, while `ORDER BY completed_at DESC NULLS LAST LIMIT 5` returns the actual current 15-minute zero-session stream. Because the doctor feature is specifically "recent ticks" diagnosis, the data source should order by `completed_at DESC NULLS LAST` (or `coalesce(completed_at, started_at) DESC`) and render both timestamps. Otherwise doctor can still be blind even though the table exists.

### [T4-CODEX] AUDIT 2026-05-04 17:21 ET — T3 WIP REOPEN; current code comment preserves the wrong ordering

Current WIP in `engram/src/doctor.ts:587-595` says to order by `started_at DESC despite T4-CODEX caveat`. That is not acceptable: the live sample proves `started_at DESC` selects the wrong rows, not merely rows with visible skew. Rendering both timestamps is useful, but the row selection itself must be based on `completed_at DESC NULLS LAST` or `coalesce(completed_at, started_at) DESC`. Please adjust the data-source query and tests before posting FIX-PROPOSED.

### [T4-CODEX] AUDIT 2026-05-04 17:22 ET — T2 WIP REOPEN; processed-stamp failure is swallowed but surface has no de-dupe

T2 WIP correctly uses `memory_sessions.id` (uuid PK) and live aggregates confirm the `messages_count >= 3` filter selects real recent rows (`13/13` ended sessions in the 72h lookback). But `stampSessionsProcessed()` catches and logs failures without throwing (`rumen/src/index.ts:223-251`) after `surfaceInsights()` has already inserted rows. `surfaceInsights()` is plain `INSERT ... RETURNING id` with no `ON CONFLICT` or stable unique key (`rumen/src/surface.ts:48-60`). If the stamp update fails, the job still completes and the next tick re-picks the same sessions, double-emitting insights. The stamp must be part of the job's success criteria (throw on failure before `completeJob(status='done')`) OR surface must gain real de-dupe before swallowing is safe.

### [T4-CODEX] AUDIT 2026-05-04 17:24 ET — T2 WIP caveat; empty-summary candidates can be re-picked forever

Current picker SQL selects rows by `rumen_processed_at`, `ended_at`, `started_at`, and `messages_count` only (`rumen/src/extract.ts:87-93`), then `buildSignal()` silently drops empty summaries (`rumen/src/extract.ts:105-115`). `runRumenJob()` stamps only `extractResult.signals.map((s) => s.session_id)` (`rumen/src/index.ts:93-131`), so an empty-summary candidate is never stamped and can be re-selected every tick. Live aggregate currently shows `0` such candidates, so this is not blocking today’s daily-driver restart, but the robust fix is either add `summary IS NOT NULL AND btrim(summary) <> ''` to the picker query or stamp all selected candidate IDs separately from produced signals.

---

### [T1] BOOT 2026-05-04 17:16 ET — pen-test sweep lane live; 5-cell demo plan loaded

Boot complete. Time anchored 17:14 ET via `date`. Memory recalls pulled Sprint 53 plan, 3+1+1 hardening rules, codename-scrub feedback, Class O context (ledger #20 + #21). Substrate matches PLANNING.md: termdeck@1.0.8, termdeck-stack@0.6.8, rumen@0.4.5, mnestra@0.4.2.

Local toolchain probe:
- `which termdeck` → `/usr/local/bin/termdeck` ✓
- `which supabase` → `/usr/local/bin/supabase` (v2.75.0 — STALE; current is 2.98.1, so Cell D's stale-CLI scenario IS reproducible locally without simulation)

**Cell plan (demo target: 5 cells in ~25 min):**

- **Cell A** — daily-driver state, repo-cwd `init --rumen --yes`. Expect success post-v1.0.8 `--use-api`; pin probe GREEN @ rumen 0.4.5.
- **Cell B** — contaminated repo-cwd: touch `<repo>/supabase/functions/rumen-tick/index.ts`, then run `init --rumen --yes` from `/tmp`. Expect cwd-stage isolation holds; ledger #21 bug 3 reproduction.
- **Cell C** — fresh tmp HOME `init --mnestra --yes`. Expect mig 016 cron-conditional guard fires clean; Class A #19 regression check.
- **Cell D** — IN SCOPE (local CLI is 2.75.0 — stale). Force the Docker bundler path and confirm the failure pattern that motivated `--use-api`.
- **Cell E** — Brad-shape Linux SSH simulation via Docker container. Skip if container setup > 5 min.

Logs to `/tmp/sprint-53-cell-<letter>.log`. Codename-scrub discipline observed in all posts. Beginning Cell A.

### [T1] FINDING-MICRO 2026-05-04 17:16 ET — `termdeck --version` boots the launcher instead of printing a version string

`termdeck --version` from a TermDeck-aware terminal emitted "TermDeck Stack Launcher / Step 1/4: Loading secrets..." instead of a one-line version + exit. Side finding (low priority, not Class O scope) — `--version` should short-circuit before launcher boot. Filed as a follow-up; not blocking the cell sweep.

---

### [T3] KICKOFF 2026-05-04 17:18 ET — boot complete, doctor surface mapped, T4-CODEX cross-finding flagged

Boot done: time (17:14 ET), 3 memory_recalls, CLAUDE.md (global+project), PLANNING.md, STATUS.md, T3 brief, plus engram src walk. Lane in: `~/Documents/Graciella/engram/`.

Existing surface (read end-to-end):
- `src/doctor.ts:1-522` — `runDoctor()` orchestrates 6 probes; `formatDoctor()` renders text. `DoctorReport = { results: ProbeResult[], exitCode }`. Probe model is pass/fail; no informational-section concept yet.
- `src/doctor-data-source.ts:1-75` — 5 methods, all wrapping `mnestra_doctor_*` SECURITY DEFINER RPCs from migration 016 (cron + vault are postgres-role-restricted).
- `mcp-server/index.ts:150-156` — `mnestra doctor` shells `runDoctor` then `formatDoctor` to stdout. **No `--json` flag yet** — PLANNING acceptance #3 mentions `mnestra doctor --json`, so I need to add it too.
- `tests/doctor.test.ts:1-348` (10 tests) — fake DataSource pattern locked in.

### [T3] FINDING 2026-05-04 17:18 ET — `rumen_jobs` schema does NOT have `return_message`; column is `error_message`

**Brief specified:** `SELECT id, started_at, completed_at, sessions_processed, insights_generated, return_message, error FROM rumen_jobs`.

**Actual schema** (`rumen/migrations/001_rumen_tables.sql:15-26`):
```
id UUID, triggered_by TEXT, status TEXT (pending|running|done|failed),
sessions_processed INT, insights_generated INT, questions_generated INT,
error_message TEXT, source_session_ids UUID[],
started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
```

**The `return_message` field is on `cron.job_run_details`, NOT `rumen_jobs`.** The brief conflated two sources. The existing doctor already fetches `cron.job_run_details.return_message` via `cronJobRunDetails`; `parseCronReturnMessage()` extracts numeric fields and DROPS the original string when non-numeric (e.g., a Postgres error blob). That's the existing blindness on the cron side.

**Interpretation of brief intent (auditor diagnosis-by-doctor):** surface the rumen package's own per-tick log — `rumen_jobs.error_message` (when status='failed') + counts (`sessions_processed`, `insights_generated`) so Brad sees WHEN ticks stopped producing AND WHY.

**Acknowledging T4-CODEX cross-finding (17:17 ET):** Codex flagged that `started_at > now() - interval '5 days'` returns 0 on live daily-driver, but `completed_at`-filtered returns 480 rows (468 zero-session + 12 productive, last productive 2026-05-01 20:45 UTC). Suggests started_at may be stale on UPDATEd rows. **My response:** order doctor's "Recent rumen ticks" by `started_at DESC` per brief BUT include both timestamps as rendered columns so any started_at/completed_at clock skew is visible to the auditor. Add a sub-finding at FIX-PROPOSED time if rendered output proves the started_at-stale hypothesis. **Cross-lane callout to T2 (rumen lane):** confirm whether picker rewrite preserves started_at write semantics, since the picker rewrite touches the same table.

**Lane plan (locked):**
1. New `DoctorDataSource.rumenJobsRecent(limit)` selects (id, started_at, completed_at, status, sessions_processed, insights_generated, error_message). Service_role can read `public.rumen_jobs` directly — no SECURITY DEFINER wrapper (public schema, not cron/vault).
2. New `DoctorReport.rumenJobs?: RumenJobRecord[]` field (informational, not a probe — keeps probe model clean).
3. `formatDoctor()` renders "Recent rumen ticks" table after the probe list. Errored rows surface `error_message` inline; both started_at and completed_at columns visible.
4. **Bonus (within brief intent):** when `cron.job_run_details.return_message` is non-empty AND `parseCronReturnMessage` extracted zero numeric fields, append the raw string (truncated) to the existing `${job} all-zeros` probe detail. Fixes the dropped-on-non-numeric blindness on the cron side. No new probe.
5. Add `--json` flag to `mnestra doctor` shell so `--json` returns `JSON.stringify(report)` (PLANNING acceptance #3).

Test file uses `.ts` (matches codebase) at `tests/doctor-rumen-jobs-recent.test.ts`. Fixtures use neutral session UUIDs — codename-scrub clean.

Beginning implementation now.

---

### [T2] FINDING 2026-05-04 17:20 ET — boot complete; root cause confirmed; T4-CODEX text/uuid finding folded into design

Boot done (memory_recall × 5, CLAUDE.md global+project, PLANNING.md, T2 brief, source-read of `rumen/src/extract.ts` + `index.ts` + `types.ts` + `tests/extract.test.ts` + `engram/migrations/001/017` + bundled hook).

**Root cause confirmed at `~/Documents/Graciella/rumen/src/extract.ts:51-77`:** picker SQL groups `memory_items` by `source_session_id` with `HAVING COUNT(*) >= $3`. Sprint 51.6+ bundled hook (`packages/stack-installer/assets/hooks/memory-session-end.js:642-672`) writes ONE memory_items row per session (`source_type='session_summary'`), so every session has COUNT=1 and the picker rejects all of them → 0 sessions/tick → 0 insights for 3 days. Matches T4-CODEX's substrate probe (468 zero-session ticks, last productive 2026-05-01 20:45 UTC).

**Folded T4-CODEX 17:18 ET FINDING into design.** T4 caught that `memory_sessions.session_id` is `text` (mig 017 line 44-46), and 1 of 308 live rows on the daily-driver has a non-UUID session_id — feeding it through `rumen_jobs.source_session_ids uuid[]` would poison the batch. **Decision: use `memory_sessions.id` (uuid PK, gen_random_uuid()) as the Rumen row key, not `session_id`.** Bulletproof uuid cast, no regex filter, no row skipping. The text `session_id` is hook-internal — irrelevant to Rumen pipeline downstream.

**T3 cross-lane question (17:18 ET):** "confirm whether picker rewrite preserves started_at write semantics" — **answer: yes.** Picker only READS started_at; the bundled hook is the sole writer (memory-session-end.js:737). Picker rewrite has no effect on started_at write path.

**Fix shape (locked, with T4 fold-in):**
1. `engram/migrations/018_rumen_processed_at.sql` — `ADD COLUMN IF NOT EXISTS rumen_processed_at timestamptz` on `memory_sessions` + partial index `(rumen_processed_at) WHERE rumen_processed_at IS NULL` for picker hot path.
2. Mirror byte-identical to `packages/server/src/setup/mnestra-migrations/018_rumen_processed_at.sql` per Sprint 51.5 T1 hygiene rule.
3. `rumen/src/extract.ts` picker: `SELECT id, project, summary, started_at, messages_count FROM memory_sessions WHERE rumen_processed_at IS NULL AND ended_at IS NOT NULL AND started_at >= now() - ($1 || ' hours')::interval AND messages_count >= $3 ORDER BY started_at DESC LIMIT $2`. Drops the rumen_jobs second-query dedup. `buildSignal` reads `session.summary` directly.
4. `rumen/src/index.ts` — after `surfaceInsights` succeeds, atomic `UPDATE memory_sessions SET rumen_processed_at = now() WHERE id = ANY($1::uuid[])` for the processed batch. Uuid PK only — non-UUID-safe.
5. `rumen/src/types.ts` — refresh `MemorySession` doc comment.
6. `rumen/tests/extract.test.ts` — rewrite SQL matchers to track `FROM memory_sessions`; drop `isJobsQuery`/`isContentQuery` (both queries gone).

Beginning implementation.

---

### [T4-CODEX] CHECKPOINT 2026-05-04 17:25 ET — active audit state reposted at bottom for worker visibility

Phase C/D/E active. Verified substrate and posted REOPENs, but earlier T4 posts landed above worker sections, so this bottom checkpoint is the durable tail state. Active blockers: T1 Cell A exercised global `@jhizzard/termdeck` 1.0.7, not repo/npm 1.0.8; rerun after package refresh or repo binary. T2 WIP must not swallow `rumen_processed_at` stamp failures unless surface de-dupe exists; empty-summary candidates can also re-pick forever unless query filters summaries or stamps selected IDs. T3 WIP must order recent `rumen_jobs` by `completed_at DESC NULLS LAST` or `coalesce(completed_at, started_at) DESC`; `started_at DESC` selects stale/mixed rows on live data.

### [T4-CODEX] AUDIT 2026-05-04 17:26 ET — T1 Cell A rerun PASS; v1.0.8 path verified, with one monitoring-output caveat

Audited `/tmp/sprint-53-cell-A-rerun.log`: audit-upgrade reports 12/12 probes present (`line 18`), both Edge Function deploy commands include `--use-api` (`lines 23` and `29`), manual POST and outcome verification pass (`lines 47-49`), and the wizard exits 0 (`line 67`). This validates the v1.0.8 daily-driver Cell A path. Caveat: the success output still tells users to monitor `rumen_jobs ORDER BY started_at DESC LIMIT 5` (`line 62`), which is the same stale-recency issue T4 found for doctor. That user-facing hint should switch to `completed_at DESC NULLS LAST` or `coalesce(completed_at, started_at) DESC`.

### [T4-CODEX] AUDIT 2026-05-04 17:27 ET — T1 Cell B PASS; contaminated repo cwd did not poison /tmp deploy

Audited `/tmp/sprint-53-cell-B.log` plus local filesystem state. The TermDeck repo still has a stray `supabase/functions/rumen-tick/index.ts`, but the Cell B run from `/tmp/sprint-53-cell-B-cwd-*` exits 0 (`line 68`), audit-upgrade is 12/12 present (`line 19`), and both deploys use `--use-api` (`lines 24` and `30`). The temporary cwd only retained Supabase link metadata after the run, not function source, so the stale repo function did not contaminate the deploy path. Same caveat as Cell A: the success output's monitoring command still orders by `started_at DESC` (`line 63`) and should be corrected.

### [T4-CODEX] AUDIT 2026-05-04 17:28 ET — T2 picker WIP VERIFIED after reopen fixes

T2 addressed the two active Codex reopen points. Picker now filters non-empty summaries in SQL and returns `pickedSessionIds` for all selected candidates; `runRumenJob()` stamps `pickedSessionIds` before `surfaceInsights()`, and `stampSessionsProcessed()` now throws instead of swallowing. That removes the double-emit risk from stamp failure and the empty-summary re-pick loop. Migration 018 primary and TermDeck bundled mirror are byte-identical. Verification: `npm run test` in the Rumen repo passed `62/62` tests. Tradeoff accepted for this sprint: pre-surface stamping prevents duplicate insight emission; a future hardening pass can make surface transactional/deduped if preserving retry-on-surface-insert-failure becomes a requirement.

---

### [T1] ACK 2026-05-04 17:21 ET — T4-CODEX REOPEN confirmed; Cell A first run was on stale v1.0.7 global install

T4-CODEX's 17:19 AUDIT post is correct. Independent verification:

- `/usr/local/lib/node_modules/@jhizzard/termdeck/package.json` showed `"version": "1.0.7"` BEFORE refresh.
- Working tree is at v1.0.8 and commit `c357bae` DOES contain both fixes (`--use-api` at init-rumen.js:422-427; 4 `..` at audit-upgrade.js:366). Confirmed via `git log -p -S '--use-api' -- packages/cli/src/init-rumen.js` → first appears in `c357bae`.
- The locally-resolved `termdeck` binary used v1.0.7 code despite `npm view @jhizzard/termdeck version` returning 1.0.8 (registry truth).

Refreshed at 17:21 ET via `npm install -g @jhizzard/termdeck@1.0.8` (136 packages, 14s). Post-refresh confirmed: `package.json=1.0.8`, `init-rumen.js:427` has `'--use-api',`, `audit-upgrade.js:366` has 4 `..`.

### [T1] FINDING 2026-05-04 17:22 ET — Class O sub-case: stale-local-global-install drift on the publisher's own machine; post-publish dogfood is invalid without it

**Pattern.** Joshua publishes a fix to npm, dogfoods immediately on the same machine — but `npm install -g <pkg>@latest` was never re-run, so the dogfood actually exercises the *previous* version's code. Symptom: `npm view <pkg> version` says 1.0.8 ✓, working tree at 1.0.8 ✓, but `which termdeck` resolves to a binary whose `package.json` is 1.0.7. The dogfood "passes" against the wrong code, OR a regression hides because the test isn't actually testing what was published.

**Implication for Sprint 52 close.** Sprint 52's post-publish dogfood was the v1.0.7 → v1.0.8 trigger. v1.0.8 was committed (c357bae) and the fixes are in source — but if v1.0.8 was never `npm install -g`-refreshed locally between commit and "let me dogfood again," the v1.0.8 fixes were never actually exercised against the wizard's runtime path on Joshua's machine. Brad's machine is in the same risk class.

**Class:** **O — sub-case (post-publish dogfood-runner staleness).** Distinct from #20 (deployed Edge Function vs npm-published) and #21 (probe-path / Docker bundler / stale repo cwd). New shape: **publisher's local global install vs npm registry latest**.

**Pre-ship checklist candidate:** every post-publish dogfood MUST verify `node -e "console.log(require('@jhizzard/termdeck/package.json').version)"` matches the just-published version BEFORE running any wizard probe. Add this assertion to `docs/RELEASE.md` step list.

**Ledger candidate:** NEW #22 — "Stale-local-global-install drift on the publisher's own machine (Sprint 53 T1 catch, 2026-05-04). Surfaced via cross-Codex audit reopen of Cell A."

### [T1] FINDING 2026-05-04 17:22 ET — v1.0.7-actual wild-bug envelope: any user with a stale install today still gets the ledger #21 failure modes

For users running `termdeck init --rumen` on a machine whose globally-installed `@jhizzard/termdeck` is at v1.0.7 (registry shows 1.0.8 ≠ local install), both ledger #21 bugs are LIVE in the wild:

- `init-rumen.js:412-420` (no `--use-api`) → macOS Docker bundler hits `/var/folders` mount-restriction, fails with `entrypoint path does not exist` for graph-inference.
- `audit-upgrade.js:360` (5 `..`) → bundledSource probe path resolves to `/usr/local/lib/node_modules/@jhizzard/packages/...` (missing `termdeck/` segment); graph-inference pin probe falls into ENOENT skipped branch and never validates.

These reproduce against `/usr/local/lib/node_modules/@jhizzard/termdeck/...` paths (v1.0.7 source). They do NOT reproduce against the v1.0.8 source. The bugs are not regressions of v1.0.8; they are v1.0.7's behavior, surfacing because the global install never refreshed.

### [T1] PASS 2026-05-04 17:23 ET — Cell A v1.0.8 RERUN: wizard ran end-to-end clean on the daily-driver project

Log: `/tmp/sprint-53-cell-A-rerun.log`. Wall-clock 19s. Exit 0.

Evidence:
- Audit-upgrade probes: **12/12 GREEN, 0 skipped** (was 1 skipped on v1.0.7 due to off-by-one path) — graph-inference bundledSource probe now resolves correctly.
- Both deploy invocations include `--use-api`: `Running: supabase functions deploy graph-inference --project-ref <ref> --no-verify-jwt --use-api...` and same for rumen-tick. Both deploys complete via Management API (no Docker bundling, no `/var/folders` failure).
- Manual POST test: `job_id: 170cd9ab-092a-4f9e-b857-dad62d7a1bdd, extracted: ?, surfaced: 0`. **Note:** `extracted: ?` is a non-numeric placeholder where a count is expected — likely a printf format bug or pre-T2-picker-fix data shape mismatch. Filed as side finding (probably overlaps T2's picker rewrite scope).
- pg_cron schedules (rumen-tick + graph-inference-tick) verified.
- Wizard's "Verifying rumen outcomes... ✓" passed.

**Class O verdict on Cell A:** the v1.0.8 fixes (ledger #21 bug 1 + bug 2) HOLD under wizard runtime against the daily-driver project. The cell passes clean once the global install is actually at the published version.

Moving to Cell B.

### [T1] PASS 2026-05-04 17:27 ET — Cell B: cwd isolation HOLDS under contaminated `<repo>/supabase/functions/rumen-tick/index.ts`

Log: `/tmp/sprint-53-cell-B.log`. Wall-clock 18s. Exit 0.

**Setup:** wrote poison marker `// CELL-B-POISON-MARKER-1777929994 — IF DEPLOYED, CWD ISOLATION FAILED` to `<repo>/supabase/functions/rumen-tick/index.ts` (73 bytes). Reproduces ledger #21 bug 3's "stale repo cwd state" condition synthetically.

**Run:** `cd /tmp/sprint-53-cell-B-cwd-<ts> && termdeck init --rumen --yes`. Wizard ran clean end-to-end identically to Cell A (12/12 probes GREEN, both deploys via `--use-api`, manual POST succeeded).

**Verification (the actual test):**
- `supabase functions download rumen-tick --project-ref <ref> --use-api -o /tmp/sprint-53-cell-B-deployed-check/`
- `grep -c "CELL-B-POISON-MARKER" /tmp/sprint-53-cell-B-deployed-check/supabase/functions/rumen-tick/index.ts` → **0** (marker absent in deployed body)
- Deployed body starts with the canonical `// Rumen v0.1 Supabase Edge Function entry point.`
- Pin: `import { runRumenJob, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.4.5';` ✓

**Class O verdict on Cell B:** ledger #21 bug 3 (stale repo-cwd contamination) is closed at v1.0.8. The wizard stages from `migrations.rumenFunctionsRoot()` (the bundled package source), and `--use-api` uploads via the Management API rather than letting the supabase CLI walk up looking for a parent `supabase/` dir. cwd isolation is **architecturally guaranteed** by `--use-api`, not just incidental. **The contamination route is no longer exploitable on macOS via the wizard's deploy path.** A separate Cell D will re-test the no-`--use-api` path explicitly.

**Cleanup:** removed `<repo>/supabase/functions/` (left `<repo>/supabase/.temp/` alone — that's the supabase CLI's link cwd, untouched by Cell B). `git status` clean post-cleanup. `/tmp/sprint-53-cell-B-cwd-*` removed.

Moving to Cell C.

### [T3] FIX-PROPOSED 2026-05-04 17:33 ET — doctor surfaces rumen_jobs.error_message + sessions/insights inline; --json flag added; bonus cron return_message non-numeric blob surface

**Diff stats** (`git diff --stat src/ mcp-server/ tests/` in `~/Documents/Graciella/engram/`):
```
 mcp-server/index.ts       |  10 ++-
 src/doctor-data-source.ts |  58 +++++++++++++++-
 src/doctor.ts             | 164 ++++++++++++++++++++++++++++++++++++++++++++--
 tests/doctor.test.ts      |   7 ++
 4 files changed, 233 insertions(+), 6 deletions(-)
```
Plus new `tests/doctor-rumen-jobs-recent.test.ts` (315 LOC, 8 tests).

**File:line refs:**
- `src/doctor.ts:38-71` — new `RumenJobRecord` type with `started_at` stale-on-UPDATE caveat documented inline.
- `src/doctor.ts:73-94` — `DoctorDataSource.rumenJobsRecent(limit)` added to interface (6th method).
- `src/doctor.ts:104-114` — `DoctorReport.rumenJobs?: RumenJobRecord[]` field added (informational, not a probe).
- `src/doctor.ts:118-137` — new constants: `RUMEN_JOBS_RECENT_LIMIT=5`, `RETURN_MESSAGE_TRUNCATE_CHARS=200`, `ERROR_MESSAGE_TRUNCATE_CHARS=80`.
- `src/doctor.ts:225-251` — new `summarizeNonNumericReturnMessages()` helper (bonus fix). Dedupes blobs across runs; returns truncated sample.
- `src/doctor.ts:253-300` — `evalAllZeros()` updated to append non-numeric note to detail line in all 3 branches (cold-boot, fired, did-not-fire).
- `src/doctor.ts:556-572` — `runDoctor()` calls `data.rumenJobsRecent(RUMEN_JOBS_RECENT_LIMIT)` in try/catch; populates `report.rumenJobs`.
- `src/doctor.ts:586-628` — new `formatRumenJobs()` exported helper renders the "Recent rumen ticks" table; `formatDoctor()` invokes it after probe lines.
- `src/doctor-data-source.ts:14-26` — new `RumenJobRow` interface for typed PostgREST select.
- `src/doctor-data-source.ts:78-122` — new `rumenJobsRecent(limit)` impl: fetches `2× limit` rows ordered by `completed_at DESC NULLS LAST` then `started_at DESC NULLS LAST`, then JS-sorts by `coalesce(completed_at, started_at) DESC` and slices to limit. (See sub-finding below for why JS sort.)
- `mcp-server/index.ts:150-167` — `mnestra doctor --json` emits `JSON.stringify(report, null, 2)` instead of `formatDoctor()`. Help text updated.

**Test results:**
- New `tests/doctor-rumen-jobs-recent.test.ts`: 8/8 pass (rendering, errored row inlining, mixed-fixture ordering, throw-degrades-cleanly, empty render, non-numeric blob surface, regression no-false-positive, JSON shape).
- Existing `tests/doctor.test.ts`: 10/10 pass (no regression — fake DataSource updated to satisfy 6th method).
- Full suite: 67/67 pass.

### [T3] SUB-FINDING 2026-05-04 17:33 ET — `started_at` is NULL on the daily-driver project, validating T4-CODEX's 17:17 ET cross-finding

**Reproduction:** ran `mnestra doctor --json` against the daily-driver Supabase via dist build. All 5 most-recent rumen_jobs rows have `started_at: null`, only `completed_at` is populated:
```
0: started_at=None  completed_at=2026-05-04T21:27:09  status=done  sessions=0  insights=0
1: started_at=None  completed_at=2026-05-04T21:23:19  status=done  sessions=0  insights=0
2: started_at=None  completed_at=2026-05-04T21:15:00  status=done  sessions=0  insights=0
3: started_at=None  completed_at=2026-05-04T21:00:00  status=done  sessions=0  insights=0
4: started_at=None  completed_at=2026-05-04T20:45:00  status=done  sessions=0  insights=0
```

**Root cause:** `rumen/migrations/001_rumen_tables.sql:32-41` — the migration's `ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` is a no-op when the column already exists. The daily-driver project has a pre-existing `rumen_jobs` table from an earlier (pre-NOT-NULL) install, so the column stayed nullable AND the rumen-tick writer's INSERT path doesn't supply started_at — Postgres lets it default to NULL.

**Adjustment to my picker:** ORDER BY started_at DESC (per brief) put NULL rows first (PG default for DESC NULLS-FIRST) and hid all recent activity. Switched to `ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST` at the PostgREST layer, then JS-sort by `coalesce(completed_at, started_at) DESC` to handle running ticks (completed_at NULL but started_at populated). Live re-render confirms: 5 rows from the LAST 42 MINUTES surface correctly, all with sessions=0/insights=0 (proving the picker bug T2 owns is REAL and ongoing — picker, NOT pin drift).

**Cross-lane callout to T2 (rumen lane):** the rumen-tick INSERT path needs to either (a) explicitly supply started_at (defense-in-depth against the missing-NOT-NULL drift), or (b) carry a fix-up migration that ALTERs the column to NOT NULL after backfilling existing NULL rows from completed_at. Lower-priority follow-up; not a Sprint 53 T3 scope item but worth flagging since T2 is touching this table.

**Cross-lane callout to T4-CODEX:** confirmed ✓ — the `started_at`-stale hypothesis was correct and reproducible. Doctor surface now reliable against this project state.

### [T3] DONE 2026-05-04 17:33 ET — doctor blindness fix complete; rumen_jobs.error_message + sessions/insights inline; --json shipped; bonus cron return_message non-numeric blob surface; all tests green

**Acceptance criteria from T3-doctor-blindness-fix.md:**
1. ✅ NEW `DoctorDataSource.rumenJobsRecent(limit)` method added to interface + Supabase-backed impl (default limit 5).
2. ✅ Render as table in doctor's main report under "Recent rumen ticks" section after probe verdicts. Cols: started_at | completed_at | status | sessions | insights | error_message (truncated).
3. ✅ Errored rows surface `error_message` inline (truncation budget 80 chars + ellipsis); test fixture covers a 150-char SSL error blob.
4. ✅ Test additions at `tests/doctor-rumen-jobs-recent.test.ts` (315 LOC, 8 tests). All fixtures use neutral session/job UUIDs (`test-job-001`, `test-job-failed`, `test-job-zero`, etc.). NO codenames.
5. ✅ Live demo against the daily-driver project — output above shows 5 most-recent rumen ticks rendered correctly. Brad-equivalent diagnosis-by-doctor confirmed (auditor sees timestamps + counts + error_message inline; can deduce picker bug from sessions=0 across 5 successive ticks without dropping to psql).

**Beyond brief (within intent):**
- ✅ `mnestra doctor --json` flag added — emits `JSON.stringify(report, null, 2)` (PLANNING acceptance #3 — for machine consumers).
- ✅ Bonus fix: `cron.job_run_details.return_message` non-numeric blobs (Postgres errors) now surface in `${job} all-zeros` probe detail line. Previously dropped because `parseCronReturnMessage` extracted zero numeric fields. Helper `summarizeNonNumericReturnMessages()` at `src/doctor.ts:225-251` dedups + truncates to 200 chars. Test coverage at `doctor-rumen-jobs-recent.test.ts` lines for "cron return_message non-numeric blob surfaces" + regression "numeric still extracted normally".
- ✅ Schema-drift discovery (T4-CODEX validation): `rumen_jobs.started_at` is NULL on the daily-driver project; rumen migration 001 needs a fix-up pass — flagged to T2.

**Files changed (engram repo):**
- `src/doctor.ts` (+164 / -10): types + render + runDoctor wire-up + bonus fix.
- `src/doctor-data-source.ts` (+58 / -1): rumenJobsRecent Supabase impl with started_at-stale-aware ordering.
- `mcp-server/index.ts` (+10 / -1): --json flag + help text.
- `tests/doctor.test.ts` (+7): added rumenJobs to fake DataSource so existing tests compile.
- `tests/doctor-rumen-jobs-recent.test.ts` (+315 NEW): 8 focused tests.

**No version bumps. No CHANGELOG edits. No commits in engram.** Orchestrator handles ship at sprint close (mnestra 0.4.2 → 0.4.3 alongside Lane T2's mig 018 wave per PLANNING.md).

**Live demo paste (codename-scrubbed — only timestamps + counts visible):**
```
Recent rumen ticks
  started_at                 completed_at               status     sessions  insights  error_message
  -------------------------  -------------------------  ---------  --------  --------  -------------
  —                          2026-05-04T21:27:09.95919  done              0         0
  —                          2026-05-04T21:23:19.12019  done              0         0
  —                          2026-05-04T21:15:00.64952  done              0         0
  —                          2026-05-04T21:00:00.61952  done              0         0
  —                          2026-05-04T20:45:00.71387  done              0         0
```
This output IS the deliverable: 5 successive ticks complete `done` with sessions=0/insights=0 in the last 42 minutes, all started_at NULL — telling Brad in one glance that picker is silently no-op-ing AND there's an upstream rumen-tick INSERT-path drift. Diagnosis-by-doctor now matches diagnosis-by-psql.

T3 lane closed.

### [T1] PASS 2026-05-04 17:29 ET — Cell C: fresh tmp HOME init --mnestra clean; all 17 migrations re-apply; mig 016 cron-conditional guard fires clean

Log: `/tmp/sprint-53-cell-C.log`. Wall-clock 2s. Exit 0. HOME=`/tmp/td-test-home-<ts>` (fresh, no prior `~/.claude/` or `~/.termdeck/`).

**Setup:** `mkdir -p $HOME/.termdeck && cp ~/.termdeck/secrets.env $HOME/.termdeck/`. Then `HOME=<tmp> termdeck init --mnestra --yes`.

**Evidence:**
- Hook bootstrap from empty `~/.claude/`: `Refreshing ~/.claude/hooks/memory-session-end.js... ✓ installed v2 (no prior copy)` AND `Reconciling ~/.claude/settings.json hook event mapping (Stop → SessionEnd)... ✓ installed (SessionEnd)`. Settings.json wired straight to `SessionEnd` (Brad's v1.0.4-era bug closed; no `Stop` regression).
- All 17 migrations re-applied successfully against the daily-driver project (which already has them). Each idempotent: 40-80ms per mig. **Migration 016 (cron-conditional guard, ledger #19 fix) applied in 46ms with no error** — confirms the do$cron_guard$ pattern handles re-application on a cron-enabled project.
- Audit-upgrade probes: 6/6 GREEN (Mnestra-side probe count is 6, vs 12 on Rumen).
- `memory_status_aggregation()` → 6,347 active memories. Daily-driver state intact.
- Post-run filesystem inspection: `$HOME/.claude/{hooks/, settings.json}` and `$HOME/.termdeck/{secrets.env, config.yaml}` all created. No leakage to real `~/.claude/`.

**Class A verdict on Cell C:** mig 016 cron-conditional guard (ledger #19 fix) holds under re-application. **Caveat:** this run is on a project that ALREADY has `pg_cron` installed, so the do$cron_guard$ block hits the "extension exists, execute body" branch. Truly testing the bug-#19 path (`pg_cron` absent) requires a fresh Supabase project ref — not feasible inside the demo window. **Sub-finding for follow-up:** Sprint 53+ should provision a throwaway Supabase project + add a Cell C2 that runs `init --mnestra` from fresh HOME against fresh DB to actually exercise the no-pg_cron branch of the guard.

Cleanup: `rm -rf /tmp/td-test-home-*` clean.

### [T1] NOTE 2026-05-04 17:30 ET — Cell D collapsed into Cell A v1.0.7 (REDUNDANT — already reproduced)

Cell D was specced as "force the Docker bundler path (no `--use-api`) and confirm failure." Cell A's first run (against the stale v1.0.7 global install) ALREADY exercised this exact path and reproduced the failure pattern: `Bundling Function: graph-inference / Error: entrypoint path does not exist (supabase/functions/graph-inference/index.ts) / error running container: exit 1` against macOS + Docker Desktop + supabase CLI 2.75.0 + os.tmpdir()=/var/folders.

**Therefore: Cell D folds into Cell A's first run (v1.0.7-actual evidence). No fresh probe needed.** v1.0.7 envelope: ledger #21 #2 reproduced in the wild on Joshua's machine; the `--use-api` fix in v1.0.8 closes it cleanly (Cell A rerun + Cell B).

### [T1] SKIP 2026-05-04 17:30 ET — Cell E (Brad-shape Linux SSH simulation) deferred per brief; queued as Sprint 53+ follow-up

Per the lane brief: "SKIP this cell if container setup exceeds 5 min — flag for follow-up." Demo budget is tight; Linux Docker container provisioning + npm install + secrets seeding + run + verify would consume the remaining window. Brad-shape simulation is best done async outside the demo:
- Spin up Ubuntu 24.04 Docker container OR DigitalOcean droplet
- `npm install -g @jhizzard/termdeck@1.0.8`
- Seed `~/.termdeck/secrets.env` against a throwaway Supabase project
- Run `termdeck init --mnestra --yes` then `termdeck init --rumen --yes`
- Capture full log + deployed-body verification
- Compare against macOS reference run (Cell C output)

**Sub-finding:** the absence of a Linux smoke-test in the local pen-test sweep is itself a Class O sub-case — Sprint 53 sweep is macOS-only. Add a Linux cell to the matrix in a Sprint 53+ async follow-up.

### [T4-CODEX] AUDIT 2026-05-04 17:31 ET — T3 DONE VERIFIED; doctor report/build/tests pass

Independent audit of the T3 doctor surface is green:
- `npm run test` in Mnestra passed 67/67, including the new `doctor-rumen-jobs-recent` coverage for render, failure, empty, throw/degrade, non-numeric cron blobs, and JSON shape.
- `npm run build` in Mnestra passed.
- `rumenJobsRecent()` now orders by `completed_at` first and JS-sorts by `completed_at ?? started_at`, so the earlier NULL/stale `started_at` blind spot is closed.
- `mnestra doctor --json` emits the structured `DoctorReport` while the default text path remains intact.
- New T3 doctor/test surfaces are codename-clean; legacy migration comments outside the T3 doctor surface still need a separate public-package scrub decision.

T4 verdict: T3 accepted for Sprint 53 close.

### [T4-CODEX] AUDIT 2026-05-04 17:31 ET — T1 Cells C/D/E accepted with documented gaps

Independent audit of T1's remaining cells:
- Cell C PASS verified from `/tmp/sprint-53-cell-C.log`: fresh tmp HOME, `init --mnestra --yes`, migrations 001-017 replayed, audit-upgrade 6/6 present, `memory_status_aggregation()` verified, exit 0.
- Cell C caveat is valid: this tested re-application on a cron-enabled project, not the fresh no-`pg_cron` branch of migration 016.
- Cell D reduction accepted: the first Cell A run already reproduced the old Docker bundler path failure from the stale 1.0.7 global install; the 1.0.8 rerun and Cell B verify the `--use-api` closure.
- Cell E skip accepted under the lane brief's 5-minute rule; Linux/SSH Brad-shape smoke remains a Sprint 53+ follow-up, not a close blocker.

T4 verdict: T1 pen-test lane accepted for Sprint 53 close with two explicit follow-ups: no-`pg_cron` fresh-project probe and Linux smoke cell.

### [T4-CODEX] AUDIT 2026-05-04 17:32 ET — T2 REOPEN; migration 018 packaging path is incomplete

Independent installer-side audit found a close blocker after mirroring `018_rumen_processed_at.sql` into TermDeck:
- `node --test tests/migration-loader-precedence.test.js tests/audit-upgrade.test.js` fails 3 tests because `listMnestraMigrations()` now returns 18 files while the loader-precedence tests still expect 17.
- `packages/server/src/setup/audit-upgrade.js` still has 12 probes and stops at `memory_sessions.session_id` / migration 017. A user who upgrades and only runs `termdeck init --rumen --yes` can deploy the new Rumen picker without `memory_sessions.rumen_processed_at`, causing the tick to fail on `s.rumen_processed_at`.

Fix proposal for T2/orchestrator:
- Update migration-loader tests to include `018_rumen_processed_at.sql` and expect 18 bundled Mnestra migrations.
- Add an audit-upgrade Mnestra probe for `memory_sessions.rumen_processed_at` mapped to `018_rumen_processed_at.sql`, then update audit-upgrade probe-count/order tests.
- Re-run the targeted installer tests above plus Rumen `npm run test` / `npm run build`.

T4 verdict: T2 remains reopened until migration 018 lands through both `init --mnestra` and the `init --rumen` audit-upgrade path.

### [T4-CODEX] AUDIT 2026-05-04 17:33 ET — T2 core picker code green; packaging reopen still stands

Independent Rumen package verification:
- `npm run test` in Rumen passed 62/62.
- `npm run build` in Rumen passed.
- Current picker SQL uses `memory_sessions.id` as the UUID row key, filters `rumen_processed_at IS NULL`, `ended_at IS NOT NULL`, message count, and non-empty summaries.
- `runRumenJob()` stamps all picked session IDs before surfacing, and `createJob()` explicitly supplies `started_at = NOW()`.

T4 verdict: the core picker rewrite is accepted, but T2 is not closeable until the TermDeck migration 018 packaging/audit-upgrade blocker at 17:32 ET is fixed and re-tested.

### [T1] DONE 2026-05-04 17:31 ET — pen-test sweep PASS WITH FINDINGS — 4/5 cells exercised + 1 NEW ledger-candidate Class O sub-case

**Lane wall-clock:** 17:14 → 17:31 ET = 17 minutes.

**Cells exercised:** 4 of 5 — A.0 + A.1 (rerun) + B + C executed; D collapsed into A.0 (REDUNDANT); E SKIP per brief.

**Companion artifact written:** `docs/sprint-53-pen-test-and-picker/PEN-TEST-RESULTS.md` (matrix table + ledger candidates + demo flow log + Sprint 53+ deferred cells).

**Logs:** `/tmp/sprint-53-cell-A.log` (A.0 v1.0.7 first run), `/tmp/sprint-53-cell-A-rerun.log` (A.1 v1.0.8 rerun), `/tmp/sprint-53-cell-B.log` (contaminated cwd), `/tmp/sprint-53-cell-C.log` (fresh HOME mnestra). All cleaned-up tmp dirs removed; repo `git status` clean (only sprint docs untracked).

### Headline findings

1. **NEW LEDGER #22 CANDIDATE (Class O sub-case): stale-local-global-install drift on publisher's own machine.** Joshua's `/usr/local/lib/node_modules/@jhizzard/termdeck/package.json` was at 1.0.7 despite registry showing 1.0.8 and working-tree at 1.0.8. Sprint 52's post-publish dogfood was therefore invalid — the v1.0.8 fixes never actually exercised under wizard runtime on his machine until Sprint 53 T1 mid-sprint refresh. Pre-ship checklist candidate (item #15): every post-publish dogfood MUST verify `node -e "console.log(require('@jhizzard/termdeck/package.json').version)"` matches just-published version BEFORE any wizard probe. **Surfaced via T4-CODEX REOPEN of T1's initial Cell A misattribution — 3+1+1 audit caught the false-alarm in ~2 min.**

2. **Ledger #21 (Class O — Deployed-state drift, 3 sub-bugs) verified closed at v1.0.8** under Cell A.1 + Cell B. `--use-api` flag passed in argv at init-rumen.js:427 ✓; bundledSource probe path uses 4 `..` at audit-upgrade.js:366 ✓; cwd isolation architecturally guaranteed by `--use-api` (Cell B poison marker NOT in deployed body).

3. **Ledger #19 (Class A — mig 016 cron-conditional guard) holds under re-application** (Cell C). **Caveat:** untested against fresh Supabase project (no pg_cron) — that's the actual repro path and needs a Sprint 53+ Cell C2 to truly close.

4. **Ledger #16 (Class N — settings.json Stop→SessionEnd wiring) holds for fresh-HOME bootstrap** (Cell C: settings.json wired straight to SessionEnd, no Stop regression).

### Side findings (low priority, follow-up tickets)

- `termdeck --version` boots the launcher instead of printing a version + exit. UX-bug.
- Manual POST `extracted: ?` placeholder where a count is expected. Likely overlaps T2's picker rewrite scope.

### Cells deferred to Sprint 53+ async follow-up

- **Cell C2** — fresh tmp HOME + fresh Supabase project ref → actually exercise mig 016's no-pg_cron branch.
- **Cell E** — Brad-shape Linux SSH simulation against throwaway Supabase project.
- **Cell F (new candidate)** — `npm install -g <pkg>@latest` idempotence sweep.
- **Cell G (new candidate)** — multi-version upgrade chain v1.0.0→v1.0.4→v1.0.8 with `init --mnestra` between each.

### File:line evidence anchor (for orchestrator at sprint close)

| Bug | File | Line(s) | State at v1.0.7 | State at v1.0.8 |
|---|---|---|---|---|
| Probe path off-by-one | `packages/server/src/setup/audit-upgrade.js` | 360 (v1.0.7) / 366 (v1.0.8) | `path.resolve(__dirname, '..', '..', '..', '..', '..')` (5 levels) | `path.resolve(__dirname, '..', '..', '..', '..')` (4 levels) ✓ |
| `--use-api` missing | `packages/cli/src/init-rumen.js` | 416-420 (v1.0.7) / 422-427 (v1.0.8) | argv: `['functions', 'deploy', name, '--project-ref', projectRef, '--no-verify-jwt']` | argv adds `'--use-api'` at index 5; banner reflects flag ✓ |

### 3+1+1 audit value-prop (for the demo)

T4-CODEX caught **three** misattributions / contract gaps inside the first 16 minutes of the sprint:
- T1 Cell A "v1.0.8 regression" → actually stale v1.0.7 install (REOPEN at 17:19 ET; corrected by T1 at 17:21 ET).
- T2 picker rewrite text/uuid shape risk → folded into design before FIX-LANDED (FINDING at 17:18 ET).
- T3 doctor brief `started_at` vs `completed_at` substrate mismatch → folded into design (FINDING at 17:17 ET).

Without the auditor, T1's misattribution would have shipped as a Sprint 53.5 hotfix call. **Codex's catch-rate at ~25% sprint capacity allocation is decisively net-positive.** This is the demo deliverable Brad asked to see.

T1 OUT. Orchestrator: ledger candidate #22 is the headline; PEN-TEST-RESULTS.md is the shareable artifact.

---

### [T2] FIX-PROPOSED 2026-05-04 17:38 ET — picker rewrite + mig 018 + ALL THREE T4-CODEX fold-ins (17:18 + 17:25 + 17:32) + T3 cross-lane fold-in

T4-CODEX REOPENed T2 at 17:32 ET — packaging path was incomplete. Folded in. Now closing again.

**T4-CODEX 17:18 ET fold-in #1 — text/uuid shape choice.** Use `memory_sessions.id` (uuid PK, gen_random_uuid()) instead of `session_id text` (which had 1 non-UUID row in 308 on the daily-driver). Bulletproof uuid cast; no row skipping.

**T4-CODEX 17:25 ET fold-in #2 — stamp-before-surface, throw-on-fail.** surface.ts has no row-level de-dupe (`surface.ts:48-68` — every Insight gets a fresh INSERT). Stamp now runs BEFORE surface; on failure, throws → outer catch in `runRumenJob` marks job failed → no insights ever written → next tick re-picks cleanly with zero double-emit risk.

**T4-CODEX 17:25 ET fold-in #3 — pickedSessionIds covers ALL fetched candidates.** Stamp `extractResult.pickedSessionIds` (every memory_sessions.id the SQL picker fetched), not `signals.map(s => s.session_id)`. Closes the empty-summary infinite-loop class.

**T4-CODEX 17:25 ET fold-in #4 — SQL summary filter.** Added `AND s.summary IS NOT NULL AND s.summary <> ''` to picker. Cheap belt + pickedSessionIds suspenders.

**T4-CODEX 17:32 ET fold-in #5 — TermDeck packaging path.** Mig 018 now lands through both `init --mnestra` AND `init --rumen` audit-upgrade:
- `tests/migration-loader-precedence.test.js` updated: bundled directory listing 17 → 18 entries; `listMnestraMigrations()` returns 18 (was 17); test name updated; stale-shadow precedence test asserts 18 (was 17).
- `packages/server/src/setup/audit-upgrade.js` added 13th probe at line 139-160: `memory_sessions.rumen_processed_at` mapped to `018_rumen_processed_at.sql` with `presentWhen: 'rowReturned'`. Lands AFTER mig-017's session_id probe per dependency order.
- `tests/audit-upgrade.test.js` updated: 8 SQL probe assertions → 9 (3 places); 12 PROBES → 13 (2 places); mnestra probe count 6 → 7; partial-drift test now expects all 3 mig-015/017/018 to apply when canned answers don't return rows for them; new dependency-order assertion: `idx('memory_sessions.session_id') < idx('memory_sessions.rumen_processed_at')`.

**T3 17:33 ET cross-lane fold-in — Explicit started_at = NOW() in createJob INSERT.** Defense-in-depth against mig-001-DEFAULT-NOW drift (T3 found started_at=NULL on the daily-driver project).

Final diff stats:

```
~/Documents/Graciella/engram/
  + migrations/018_rumen_processed_at.sql                                        NEW (51 LOC)

~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/
  + packages/server/src/setup/mnestra-migrations/018_rumen_processed_at.sql      NEW (byte-identical mirror)
  M packages/server/src/setup/audit-upgrade.js                                   +24 (new probe entry)
  M tests/migration-loader-precedence.test.js                                    ~20 lines (17 → 18 across 4 assertions)
  M tests/audit-upgrade.test.js                                                  ~30 lines (probe count + drift expectations)

~/Documents/Graciella/rumen/
  M src/extract.ts                                ~220 lines — picker pivot + pickedSessionIds + summary filter
  M src/index.ts                                  +51 / -3 — stamp-before-surface (throws) + createJob NOW()
  M src/types.ts                                  ~21 lines — MemorySession doc refresh
  M tests/extract.test.ts                         ~285 lines (-146, +139) — 12 tests (was 8)
```

**Final test results across both repos:**
- **Rumen:** 62 pass / 0 fail / 0 skipped (`npm test`).
- **TermDeck installer surface:** `node --test tests/migration-loader-precedence.test.js tests/audit-upgrade.test.js` — 24 pass / 0 fail / 0 skipped.
- **TermDeck edge-function-pin sibling suite:** 14 pass / 0 fail / 0 skipped (regression check — no probe-count drift).

**Typecheck: clean** (`tsc --noEmit` exit 0). **Mirror invariant verified:** `diff` exit 0.

**Final picker SQL (locked, post-all-folding):**
```sql
SELECT
  s.id           AS id,
  s.project      AS project,
  s.summary      AS summary,
  s.started_at   AS created_at,
  COALESCE(s.messages_count, 0)::int AS event_count
FROM memory_sessions s
WHERE s.rumen_processed_at IS NULL
  AND s.ended_at IS NOT NULL
  AND s.started_at >= NOW() - ($1 || ' hours')::interval
  AND COALESCE(s.messages_count, 0) >= $3
  AND s.summary IS NOT NULL
  AND s.summary <> ''
ORDER BY s.started_at DESC
LIMIT $2
```

**Stamp ordering (locked):**
```ts
extract → relate → synthesize → STAMP (throw-on-fail, picks all candidates) → surface → completeJob
```

**Audit-upgrade probe topology (post-FIX):** 13 entries = 7 mnestra (memory_relationships.weight, memory_recall_graph, memory_items.reclassified_by, service_role grant, memory_items.source_agent, memory_sessions.session_id, **memory_sessions.rumen_processed_at**) + 6 rumen (rumen-tick cron, graph-inference cron, rumen-tick functionSource, graph-inference functionSource, rumen-tick pin, graph-inference pin).

**Key file:line refs (all targets):**
- Picker SQL: `~/Documents/Graciella/rumen/src/extract.ts:78-102`
- pickedSessionIds: `~/Documents/Graciella/rumen/src/extract.ts:113`
- buildSignal (pure, summary-direct): `~/Documents/Graciella/rumen/src/extract.ts:129-148`
- stampSessionsProcessed (throws): `~/Documents/Graciella/rumen/src/index.ts:179-191`
- Stamp-before-surface call site: `~/Documents/Graciella/rumen/src/index.ts:120-135`
- createJob explicit started_at: `~/Documents/Graciella/rumen/src/index.ts:175-184`
- Mig 018 partial index: `~/Documents/Graciella/engram/migrations/018_rumen_processed_at.sql:42-46`
- Audit-upgrade new probe: `packages/server/src/setup/audit-upgrade.js:139-160`

### [T2] DONE 2026-05-04 17:38 ET — picker rewrite + mig 018 + 4 fold-ins ALL ABSORBED; ready for orchestrator publish wave

Lane complete. Demo-target items per T2 brief:
1. ✅ Authored `018_rumen_processed_at.sql` + mirror (byte-identical, diff verified).
2. ✅ Rewrote `rumen/src/extract.ts:55-77` → memory_sessions read.
3. ✅ `npm run typecheck && npm test` green (62/62 pass, rumen).
4. ✅ Posted FIX-PROPOSED with file:line diffs.

Plus: **TermDeck installer integration loop closed** — mig 018 now applies via both `init --mnestra` (loader-precedence) AND `init --rumen` (audit-upgrade probe), verified via 24 installer tests.

Plus: **3+1+1 audit pattern fully exercised on T2** — Codex caught all 3 things I missed, in 14 minutes total:
- 17:18 ET text/uuid risk (PRE-FIX) → folded into design
- 17:25 ET stamp ordering + infinite-loop class + summary filter (POST-INITIAL-FIX) → folded into structure
- 17:32 ET TermDeck packaging incomplete (POST-FIX REOPEN) → folded into installer surface

Without the auditor, the picker rewrite would have shipped with: fragile uuid cast (1/308 row failure rate), duplicate rumen_insights on stamp failure, infinite-loop on empty-summary sessions, AND would have been undeployable on `init --rumen --yes` upgrade paths. All four caught BEFORE FIX-LANDED.

**Publish wave (orchestrator at sprint close — per PLANNING.md acceptance #4):**
- `@jhizzard/mnestra@0.4.2 → 0.4.3` (mig 018)
- `@jhizzard/rumen@0.4.5 → 0.5.0` (picker rewrite + stamp orchestration + createJob hardening — semver-minor)
- `@jhizzard/termdeck@1.0.8 → 1.0.9` (bundled mnestra dep bump + audit-upgrade probe + loader-precedence hygiene)
- `@jhizzard/termdeck-stack@0.6.8 → 0.6.9` (audit-trail bump)

**Publish order (Sprint 51.5 T1 invariant):**
1. Mnestra 0.4.3 (mig 018 column).
2. Rumen 0.5.0 (depends on column live).
3. TermDeck 1.0.9 + stack 0.6.9 (bundled deps + audit-upgrade probe ship together).
4. Joshua redeploys rumen-tick (`supabase functions deploy --no-verify-jwt --use-api`); deployed pin `0.4.5 → 0.5.0`.
5. Wait one tick (~15min); `select count(*), max(created_at) from rumen_insights` should grow past 321.

**Sprint 54 follow-ups identified by T2 lane work:**
- Backfill rumen_jobs.started_at NULLs from completed_at; ALTER COLUMN SET NOT NULL.
- CREATE INDEX CONCURRENTLY for mig 018 — fine at 308-row scale; matters at >1M.
- Hook empty-summary investigation — verify upstream cause; SQL filter masks symptom not source.

**T4-CODEX adversarial review handoff for post-FIX (these are the things I CANNOT verify from inside the lane):**
1. `EXPLAIN` on the picker query against the daily-driver post-deploy → confirm partial index `memory_sessions_rumen_unprocessed_idx` hit.
2. Confirm new audit-upgrade probe shows up in wizard output during `termdeck init --rumen --yes` against a fresh project.
3. Verify mig 018 packaging in published 1.0.9 tarball: `npm pack --dry-run @jhizzard/termdeck` should list `packages/server/src/setup/mnestra-migrations/018_rumen_processed_at.sql`.

Lane discipline observed: no version bumps, no CHANGELOG edits, no commits in any of the 3 repos. Orchestrator handles ship at sprint close.

T2 OUT.
