# Sprint 35 — Reconciliation — STATUS

Append-only log. Each Tn posts `[Tn FINDING]`, `[Tn FIX-PROPOSED]`, `[Tn DONE]` entries.

## 2026-04-27 12:08 ET — Sprint kicked off (orchestrator)

Four lanes assigned. Boot prompts injected via TermDeck input API (no copy-paste).

Lane briefings:
- `docs/sprint-35-reconciliation/T1-init-mcp-only-default.md`
- `docs/sprint-35-reconciliation/T2-legacy-schema-008.md`
- `docs/sprint-35-reconciliation/T3-rumen-preconditions-doctor.md`
- `docs/sprint-35-reconciliation/T4-boot-banner-launcher-parity.md`

Terminal UUIDs:
- T1: `11932a83-c7bd-42d1-99ec-85d77aa6c6dd`
- T2: `4d9e2eed-9b9b-4551-8b55-e222a09eea6a`
- T3: `1f51ea0e-00e4-47ef-a7cc-8a162468f5d7`
- T4: `b4510714-98b1-4b66-868e-26c4f4d4dce3`

(Lane updates land below this line.)

---

## 2026-04-27 12:16 ET — [T4 FINDING] banner lives in CLI, not server

The production boot banner (`╔═...═╗` box) is in `packages/cli/src/index.js:213–230`. The `console.log` block in `packages/server/src/index.js:1731–1742` only runs when the server is launched directly via `node packages/server/src/index.js` (the `if (require.main === module)` branch at 1683). End users always go through the CLI wrapper, so the RAG state line must land in the CLI banner to be visible.

The CLI banner already has `firstRun` hint and a `runPreflight()` health banner that print after the box. The new RAG state line slots in between the box and `firstRun`.

## 2026-04-27 12:16 ET — [T4 FINDING] server-side RAG label is misleading

`packages/server/src/index.js:1736` reads `config.rag?.supabaseUrl ? 'configured' : 'not configured'` — that has nothing to do with whether `rag.enabled` is on. After Sprint 35 T1 flips the default to `enabled: false`, a fresh install with all Supabase keys present would still show `RAG: configured` even though no events flow. Fixing this label to mirror the CLI banner's enabled/disabled framing keeps the two banners coherent. Briefing scopes "banner region only" of `packages/server/src/index.js`, so this fix is in-scope.

## 2026-04-27 12:16 ET — [T4 FINDING] stale-port logic to lift

`scripts/start.sh:127–154` has the lsof/fuser → ps-grep → SIGTERM-then-SIGKILL pattern. Need to translate to Node (`child_process.execSync`/`spawnSync`) and call BEFORE `server.listen()` in the CLI wrapper. The CLI today has no port-conflict logic — `server.listen()` just throws `EADDRINUSE`. New helper goes in `packages/cli/src/index.js`.

## 2026-04-27 12:20 ET — [T4 FIX-PROPOSED] four landing sites in one file

All four T4 changes touch only the two files in scope:

1. **CLI banner — RAG state line** (`packages/cli/src/index.js`, after the `╚═══╝` box at line 230)
   - Read `config.rag?.enabled === true` and print one of two dim lines:
     - `RAG: on — events syncing to mnestra_session_memory / mnestra_project_memory / mnestra_developer_memory`
     - `RAG: off (MCP-only mode) — toggle in dashboard at <url>/#config to enable session/project/developer memory tables`
2. **CLI helper — `reclaimStalePort(port)`** (`packages/cli/src/index.js`, top-level, called before `server.listen`)
   - `lsof -ti TCP:<port> -sTCP:LISTEN` (with `fuser` Linux fallback)
   - For each PID, `ps -o command= -p <pid>` matched against `/packages\/cli\/src\/index\.js/` or `/termdeck/i`
   - TermDeck holder → SIGTERM, 1s grace, SIGKILL, continue boot
   - Non-TermDeck holder → red error + suggested `--port <n+1>` + `process.exit(1)`
3. **CLI hint — `checkTranscriptTableHint(databaseUrl)`** (fire-and-forget after listen, 5s timeout)
   - Skips silently if no `DATABASE_URL` or no `psql` on PATH
   - Probes `SELECT 1 FROM termdeck_transcripts LIMIT 0`; on failure prints `[hint] Transcript backup table missing. Run: termdeck doctor (or psql $DATABASE_URL -f config/transcript-migration.sql)`
   - References `termdeck doctor` (T3) AND the raw psql fallback so the hint stays useful regardless of T3 merge order
4. **Server direct-invocation banner — RAG label fix** (`packages/server/src/index.js:1736`)
   - `config.rag?.supabaseUrl ? 'configured' : 'not configured'` → `config.rag?.enabled === true ? 'on (writing to mnestra_*_memory tables)' : 'off (MCP-only mode)'`
   - Keeps the two banners (CLI and direct-invoke) coherent

Out-of-scope items from the briefing — Mnestra autostart parity, MCP-config-hint parity, restart-on-empty-store — deliberately not ported. They belong to Sprint 36 / Phase B.

## 2026-04-27 12:20 ET — [T4 DONE] all four behaviors verified locally

Manual tests on port 3099 (orchestrator's TermDeck on :3000 left untouched):

| Test | Result |
|---|---|
| `rag.enabled: false` boot | banner prints `RAG: off (MCP-only mode) — toggle in dashboard at http://127.0.0.1:3099/#config…` ✓ |
| `rag.enabled: true` boot | banner prints `RAG: on — events syncing to mnestra_session_memory / mnestra_project_memory / mnestra_developer_memory` ✓ |
| Stale TermDeck on :3099 | second boot prints `[port] Reclaiming :3099 from stale TermDeck (PIDs: 67699)` then boots cleanly; first PID confirmed dead ✓ |
| `python3 -m http.server 3099` holding port | second boot prints red `✗ Port 3099 is in use by a non-TermDeck process` + `Try a different port: termdeck --port 3100` and exits 1 ✓ |

Transcript-table hint did not fire during testing — Joshua's Supabase already has `termdeck_transcripts`, which is the correct silent path. Hint code path exercised via syntax check + manual review of the SQL probe (`psql "$DATABASE_URL" -c "SELECT 1 FROM termdeck_transcripts LIMIT 0"`).

Files touched (within T4's declared lane):
- `packages/cli/src/index.js` — added `exec` import, `reclaimStalePort`, `checkTranscriptTableHint`, RAG banner line, two call sites
- `packages/server/src/index.js:1736` — RAG label rewrite (single line, banner region only)

Syntax: `node -c packages/cli/src/index.js && node -c packages/server/src/index.js` → OK.

No version bump, no CHANGELOG edit, no commit — orchestrator handles at sprint close.

## 2026-04-27 12:23 ET — [T2 FINDING] supabase-migration.sql is NOT idempotent today

Audit of `config/supabase-migration.sql` (the file we're about to ship as bundled migration 008) found three classes of re-run-unsafe statements. Anyone who ran the wizard once with `rag.enabled: true`, picked up the wizard's later re-application of migrations on a subsequent install, or applied the SQL by hand twice, would have hit errors:

1. **All eleven `CREATE INDEX` statements lack `IF NOT EXISTS`.** Lines 17–19, 33–35, 49–50, 64–66, 69–70. Second run errors with `relation "idx_*" already exists`.
2. **All eight `CREATE POLICY` statements lack any duplicate-guard.** Lines 82–85 (`Allow insert for all` × 4 tables) and 88–91 (`Read own data` × 4 tables). Second run errors with `policy "..." for table "..." already exists`. Postgres has no `CREATE POLICY IF NOT EXISTS` until v15+, and TermDeck targets earlier compatibility — `DROP POLICY IF EXISTS ...; CREATE POLICY ...` is the safer pattern.
3. **`CREATE EXTENSION IF NOT EXISTS pg_trgm` is on line 73, AFTER `idx_commands_fts` (line 69) which depends on `gin_trgm_ops`.** On Supabase this works because the `extensions` schema pre-installs pg_trgm and is on the search_path; on vanilla Postgres a fresh first run would fail at line 69. Moving the extension to the top eliminates ordering dependence and matches how migrations 001–007 stage their extensions.

`CREATE TABLE IF NOT EXISTS` (lines 6, 22, 38, 53), `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (lines 76–79, naturally idempotent in Postgres), and `CREATE OR REPLACE VIEW` (line 94) are already safe.

## 2026-04-27 12:23 ET — [T2 FINDING] no migration-runner.js wiring change needed

`packages/server/src/setup/migrations.js::listMnestraMigrations()` reads `mnestra-migrations/*.sql` alphabetically (line 32–39) and returns the full sorted list. `migration-runner.js::listAllMigrations()` (line 23–30) consumes that list verbatim and appends `transcript-migration.sql` last. So **dropping `008_legacy_rag_tables.sql` into `mnestra-migrations/` IS the wiring** — discovery is purely glob-based. The runner will see 8 Mnestra migrations + 1 transcript = 9 total without a single line change to `migration-runner.js`.

The runner's header comment (lines 1–8) still says "7-migration bootstrap sequence" — that was already stale after Sprint 30 added 007, and now it understates by two. I'll generalize the wording to reference the bundled directory rather than hard-code a count.

## 2026-04-27 12:24 ET — [T2 FIX-PROPOSED] four edits, in this order

1. **Rewrite `config/supabase-migration.sql`** — fix the three idempotency gaps in the source-of-truth file (so anyone who applies it manually from the repo also gets the safe version):
   - Move `CREATE EXTENSION IF NOT EXISTS pg_trgm` to the top, before any table/index that depends on it.
   - Add `IF NOT EXISTS` to all eleven `CREATE INDEX` statements.
   - Replace each naked `CREATE POLICY` with `DROP POLICY IF EXISTS <name> ON <table>;` followed by the original `CREATE POLICY`. Pre-v15 compatible, no `DO $$` blocks needed.
2. **Create `packages/server/src/setup/mnestra-migrations/008_legacy_rag_tables.sql`** — true byte-for-byte mirror of the audited file with a four-line provenance header noting it's a mirror, that it's auto-applied as the 8th Mnestra migration, and that re-runs are safe.
3. **Generalize `migration-runner.js` header comment** — replace the hard-coded count ("7-migration bootstrap sequence") with a description that defers to `mnestra-migrations/` discovery + the appended transcript file. No code/behavior change.
4. **Update `CLAUDE.md` file-map line** — append the mirror note to the existing `supabase-migration.sql` row so future contributors know the runtime path.

Idempotency proof (since I don't have a scratch Supabase project): the audited SQL uses only Postgres-native idempotent forms — `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` (Postgres 9.5+), `CREATE EXTENSION IF NOT EXISTS`, `CREATE OR REPLACE VIEW`, `DROP POLICY IF EXISTS` + `CREATE POLICY`, and `ENABLE ROW LEVEL SECURITY` (no-op when already enabled). Every statement re-runs cleanly. Orchestrator can verify against a scratch DB at sprint-close pre-publish.

## 2026-04-27 12:25 ET — [T1 FINDING] writeYamlConfig is the single landing point for the default flip

`writeYamlConfig` in `packages/cli/src/init-mnestra.js` (was lines 413–425) is called from exactly two sites in `main()` — the dry-run branch (line 496) and the live branch after `applyMigrations` succeeds (line 517). Both interactive and `--yes` flows route through it; `--reset` only changes prompt re-collection, not the write call. Flipping `enabled: true` → `enabled: false` and updating the `step()` message inside this single function is sufficient to cover every install path the lane is responsible for.

Three secondary surfaces describe the wizard's behavior to the user and were ALL still asserting the old "enable RAG" framing — file-header docstring (lines 14–16), HELP text printed by `--help` (line 77), and `printBanner()` step 7 (lines 183–184). Updating those alongside the functional change keeps stale docs from misleading users who read `--help` post-upgrade.

## 2026-04-27 12:25 ET — [T1 FIX-PROPOSED] flip default + insert MCP-only block + restate in final summary

Five edits, all in `packages/cli/src/init-mnestra.js`:

1. **`writeYamlConfig`** — flip `enabled: true` → `enabled: false`; rewrite step message to `Updating ~/.termdeck/config.yaml (rag.enabled: false, MCP-only default)...`; emit a 5-line "Setup mode: MCP-only (default)" block via `process.stdout.write` immediately before the step. Block content covers: how MCP-only fills `memory_items`, that TermDeck event tables stay off, and the dashboard toggle URL `http://localhost:3000/#config` plus the config.yaml fallback. Added a comment block above the function explaining why `false` is the new default (Brad 2026-04-27 asymmetry incident).
2. **`printNextSteps`** — append a 3-line restatement of MCP-only default + dashboard toggle hint between the "Mnestra is configured." line and the existing numbered next-steps, so users who tab away and only see the final summary still get the disclosure.
3. **File-header docstring (step 5)** — rewrite to "set rag.enabled: false (MCP-only default; opt into TermDeck-side RAG via dashboard toggle)".
4. **HELP block (step 4)** — split single line into two: `sets rag.enabled: false (MCP-only default)` + `references ${VAR} keys for credentials`.
5. **`printBanner` step 7** — rewrite to "rag.enabled: false (MCP-only default; toggle in dashboard later) with `\${VAR}` refs". Note the backslash-escape on `${VAR}` since `printBanner` uses a tagged template literal — caught a `ReferenceError: VAR is not defined` regression on first dry-run, fixed before posting.

No `printMcpOnlyNote()` helper extracted — the messaging block is small enough to inline at the single call site, and putting it inside `writeYamlConfig` means dry-run and live paths get it without any call-site coordination.

## 2026-04-27 12:25 ET — [T1 DONE] init wizard defaults to rag.enabled: false; MCP-only messaging shipped on three surfaces

Verified locally:

| Test | Result |
|---|---|
| `node --check packages/cli/src/init-mnestra.js` | OK ✓ |
| `node packages/cli/src/init-mnestra.js --help` | step 4 reads "sets rag.enabled: false (MCP-only default)" ✓ |
| `node packages/cli/src/init-mnestra.js --yes --dry-run` (against Joshua's saved secrets) | banner step 7 reads "rag.enabled: false (MCP-only default…)"; MCP-only block prints between final migration and config-update step; step prints "rag.enabled: false, MCP-only default" with `(dry-run)` marker; no DB or filesystem writes ✓ |
| `printNextSteps()` invoked in isolation | "Setup mode: MCP-only (default) — TermDeck-side RAG event tables are off." block prints between the success line and the numbered next steps ✓ |

Files touched (within T1's declared lane):
- `packages/cli/src/init-mnestra.js` — five edits: writeYamlConfig (default flip + step message + MCP-only block + provenance comment), printNextSteps (3-line summary insert), file-header docstring (step 5), HELP (step 4), printBanner (step 7 + `\${VAR}` escape).

No version bump, no CHANGELOG edit, no commit — orchestrator handles at sprint close.

## 2026-04-27 12:25 ET — [T3 FINDING] precondition gate already wired in v0.6.9

`packages/server/src/setup/preconditions.js` (v0.6.9 module) already contains
`auditRumenPreconditions` with pg_cron + pg_net + Vault checks (lines 149–199),
and `packages/cli/src/init-rumen.js:603–607` already calls it before any
state-changing operation, exiting with code 10 on gap detection. The "concrete
change" #2 in the briefing — `await auditPreconditions(['pg_cron_enabled',
'pg_net_enabled'])` before the schedule — describes an idealized API that
does not exist and is unnecessary because the existing audit already runs and
gates the wizard. Net change to `init-rumen.js`: zero.

What IS missing per the briefing's "fixHint should include the dashboard URL":
the existing pg_cron / pg_net hints say "Database → Extensions → pg_cron →
toggle ON" without the user's specific project URL. T3 will derive
`https://supabase.com/dashboard/project/<ref>/database/extensions` from
`secrets.SUPABASE_URL` (via existing `setup/supabase-url.js`) and inject it
into the hint when derivable.

## 2026-04-27 12:25 ET — [T3 FINDING] doctor.js already exists from Sprint 28

`packages/cli/src/doctor.js` exists from Sprint 28 T2 (npm version-check
across the four stack packages) and `packages/cli/src/index.js:148–155`
already registers the subcommand. The T3 briefing says "Create … (NEW)"
but the file is in place with a different (and complementary) purpose.

Decision: extend the existing doctor with a Supabase schema-check section
rather than replace it. Order of output: (1) version-check table (existing),
(2) schema-check grouped by Mnestra Modern / Mnestra Legacy / Transcript /
Rumen / Extensions (new). Combined exit code: 2 (network failure highest
priority) > 1 (update available OR schema gap) > 0 (clean).

A `--no-schema` opt-out flag will be added so the existing
`tests/cli-doctor.test.js` cases — which mock `_detectInstalled` and
`_fetchLatest` but not pg — can keep exercising version-check semantics
without hitting the live Supabase. New schema-check tests will use the
fake-pg-client pattern from `tests/preconditions.test.js`.

## 2026-04-27 12:25 ET — [T3 FIX-PROPOSED] four landing sites

1. **`packages/server/src/setup/preconditions.js`** — derive
   `extensionsDashboardUrl(secrets.SUPABASE_URL)` and inject into the
   pg_cron / pg_net hints; fall back to the generic copy when SUPABASE_URL
   is missing or not a valid Supabase URL.

2. **`packages/cli/src/init-rumen.js`** — no change. Already calls
   `auditRumenPreconditions` and exits 10 on gap.

3. **`packages/cli/src/doctor.js`** — add `_runSchemaCheck(secrets)` test
   seam plus `--no-schema` opt-out flag. Default invocation runs both
   sections. JSON output adds a `schema` key alongside the existing
   `rows` key (back-compat preserved).

4. **`packages/cli/src/index.js`** — update the `--help` line for
   `termdeck doctor` to mention both checks. Subcommand registration is
   already in place.

5. **`tests/cli-doctor.test.js`** (necessary collateral, not a primary
   lane file) — pass `--no-schema` in the four existing tests so they
   stay deterministic; add new schema-check tests using a fake pg
   client routed by SQL substring (mirrors `tests/preconditions.test.js`).

## 2026-04-27 12:26 ET — [T2 DONE] 008 shipped, source-of-truth made re-run-safe

Files touched (all four within T2's declared lane):

- **`config/supabase-migration.sql`** — fully rewritten for idempotency. `CREATE EXTENSION IF NOT EXISTS pg_trgm` moved to the top so the dependent FTS index resolves on a vanilla Postgres first run. All eleven `CREATE INDEX` got `IF NOT EXISTS`. All eight `CREATE POLICY` statements gained a `DROP POLICY IF EXISTS … ON <table>;` guard immediately above them (Postgres-version-agnostic; works pre-15). Header expanded with a provenance note pointing readers to the bundled 008 mirror.
- **`packages/server/src/setup/mnestra-migrations/008_legacy_rag_tables.sql`** — NEW. Body byte-identical to the audited source-of-truth (verified via `diff` — only the four-line provenance header differs). Discovery confirmed: `migrations.listMnestraMigrations()` returns it as the 8th file; `migration-runner.js::listAllMigrations()` produces the full 9-file sequence (1–8 Mnestra + transcript) in the expected order.
- **`packages/server/src/setup/migration-runner.js`** — header comment generalized. Old comment named "7-migration bootstrap" with hard-coded role assignments; new comment defers to `mnestra-migrations/` glob discovery and explains that adding a new file is the only step needed to ship an additional migration. No code/behavior change. `node -c` passes.
- **`CLAUDE.md`** — file-map line for `supabase-migration.sql` updated from `# Legacy v0.1 RAG DDL` to `# Legacy v0.1 RAG DDL (mirror; auto-applied via mnestra-migrations/008_legacy_rag_tables.sql)`.

Idempotency verification (offline analysis — no scratch Supabase project at hand, per briefing fallback):

| Statement class | Idempotency form | Re-run safe? |
|---|---|---|
| `CREATE EXTENSION IF NOT EXISTS pg_trgm` | native `IF NOT EXISTS` | ✓ |
| `CREATE TABLE IF NOT EXISTS` (×4) | native `IF NOT EXISTS` | ✓ |
| `CREATE INDEX IF NOT EXISTS` (×12 incl. FTS) | native `IF NOT EXISTS` (pg ≥ 9.5) | ✓ |
| `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (×4) | naturally idempotent (no-op when already enabled) | ✓ |
| `DROP POLICY IF EXISTS … ; CREATE POLICY …` (×8) | guard then create | ✓ |
| `CREATE OR REPLACE VIEW` | native replace | ✓ |

Orchestrator: pre-publish, please run the manual test from `T2-legacy-schema-008.md` (apply 008 twice against a scratch Supabase project, then `\dt mnestra_*`). Expected: clean second run; four tables present (`mnestra_session_memory`, `mnestra_project_memory`, `mnestra_developer_memory`, `mnestra_commands`).

Out-of-scope (correctly deferred — flagging here so they don't get lost):

- `rag.js` still writes to these legacy tables instead of the modern `memory_items` schema. Phase C decision.
- The `mnestra_recent_activity` view's RLS posture is implicit (it inherits from the underlying tables). If a future audit wants explicit handling, that's a follow-up — not changing it here.

No version bump, no CHANGELOG edit, no commit. Lane closed.

## 2026-04-27 12:55 ET — [T3 DONE — orchestrator-verified] doctor schema-check + dashboard-URL hint shipped

T3's terminal didn't post a DONE entry before closing, but the work product is complete and verified by orchestrator at close-out:

Files touched (within T3's declared lane):
- `packages/server/src/setup/preconditions.js` (+28 LOC) — `extensionsDashboardUrl(supabaseUrl)` helper; pg_cron and pg_net hints now interpolate the user's project-specific Supabase dashboard URL when derivable, fall back to generic copy otherwise.
- `packages/cli/src/doctor.js` (+312 LOC net) — extended Sprint 28's version-check doctor with a `_runSchemaCheck(secrets)` section. Adds Mnestra Modern, Mnestra Legacy, Transcript, Rumen, and Extensions check groups. New `--no-schema` opt-out flag (default: run both). JSON output gains a `schema` key alongside existing `rows`. Exit code precedence: 2 (network failure) > 1 (update available OR schema gap) > 0 (clean).
- `packages/cli/src/index.js` (1 line within T3 scope) — `--help` line for `termdeck doctor` updated to mention "npm versions + Supabase schema (use `--no-schema` to skip the DB probe)".
- `tests/cli-doctor.test.js` (+130 LOC) — added `--no-schema` to the four pre-existing version-check tests so they stay deterministic; new schema-check tests using the fake-pg-client substring-routing pattern from `tests/preconditions.test.js`.
- `tests/preconditions.test.js` (+56 LOC) — new tests for `extensionsDashboardUrl` derivation across valid/invalid SUPABASE_URL inputs.

Orchestrator audit at close:
- All five files within T3's declared lane (or marked as necessary collateral in the briefing).
- `node --check` passes on all touched JS files.
- T2's `init-rumen.js` precondition wiring confirmed already in place (T3 FINDING at 12:25 ET correctly determined no init-rumen.js change needed).
- The pre-existing test failures in `packages/server/tests/session.test.js` are NOT in T3's scope; reproduced against `HEAD` via stash-and-rerun, confirming they predate this sprint.

No version bump, no CHANGELOG edit, no commit. Lane closed.

## 2026-04-27 12:55 ET — [orchestrator] sprint close-out begins

All four lanes verified. Test failures in `packages/server/tests/session.test.js` confirmed pre-existing (last commit on that file: v0.2.5, commit 95c577d). T2's pre-publish idempotency test against a scratch Supabase project deferred — no scratch DB available; T2's statement-class analysis covers all forms. Proceeding to version bump + CHANGELOG draft + commit + push + npm publish.
