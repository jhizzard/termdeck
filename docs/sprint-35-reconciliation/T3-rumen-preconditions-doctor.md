# T3 — Rumen extensions precondition + termdeck doctor

## Goal

Two deliverables:

1. **Precondition gate**: `termdeck init --rumen` fails loudly with a clear remediation message if `pg_cron` or `pg_net` extensions aren't enabled in the user's Supabase project. (Currently the wizard runs the migration regardless and Rumen silently never fires its cron tick.)

2. **`termdeck doctor` command**: NEW diagnostic that runs all known preconditions + schema checks against the user's Supabase project and prints a structured report with remediation hints. Read-only — no auto-fix this sprint.

## Files (yours)

- `packages/cli/src/init-rumen.js`
- `packages/server/src/setup/preconditions.js`
- `packages/cli/src/doctor.js` (NEW)
- `packages/cli/src/index.js` — register the `doctor` subcommand only (narrow change)

## Files NOT yours (don't touch)

- `packages/server/src/setup/migration-runner.js` (T2 owns)
- `packages/cli/src/init-mnestra.js` (T1 owns)
- `packages/server/src/index.js` (T4 may touch banner)
- Other files in `packages/cli/src/` beyond your declared list

## Concrete changes

### 1. Extend `preconditions.js` with extension checks

Add new precondition entries to the v0.6.9 `auditPreconditions` framework:

- `pg_cron_enabled`: query `SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'` against `DATABASE_URL`. Pass if rows > 0.
- `pg_net_enabled`: same pattern with `extname = 'pg_net'`.

Each check should return the standard `{name, status, detail, fixHint}` shape used by existing checks. The `fixHint` should include the dashboard URL (use `setup/supabase-url.js` to derive the project ref from `SUPABASE_URL`).

### 2. Hook the new preconditions into `init --rumen`

Before applying `002_pg_cron_schedule.sql`, call:

```js
const result = await auditPreconditions(['pg_cron_enabled', 'pg_net_enabled']);
```

If either fails, abort with:

```
✗ pg_cron extension is not enabled.
  Enable it in your Supabase dashboard:
  https://supabase.com/dashboard/project/<PROJECT_REF>/database/extensions

  Search for "pg_cron" → toggle on. Then re-run: termdeck init --rumen
```

Same shape for `pg_net`. Derive `<PROJECT_REF>` via the existing `setup/supabase-url.js` helper. Don't continue past this gate — make it a hard exit with non-zero status.

### 3. NEW `termdeck doctor` command

Create `packages/cli/src/doctor.js`. Export a function that connects to the user's Supabase via `DATABASE_URL` from `~/.termdeck/secrets.env` and runs a structured set of checks:

**Mnestra modern schema:**
- `memory_items`, `memory_sessions`, `memory_relationships` tables exist
- `match_memories`, `search_memories`, `memory_status_aggregation` RPCs exist
- `memory_items.source_session_id` column exists (v0.6.8+ guard)

**Mnestra legacy schema (after T2 ships):**
- `mnestra_session_memory`, `mnestra_project_memory`, `mnestra_developer_memory`, `mnestra_commands` tables exist

**Transcript:**
- `termdeck_transcripts` table exists

**Rumen:**
- `rumen_jobs`, `rumen_insights`, `rumen_questions` tables exist
- `created_at` column exists on each (the column-drift symptom Brad hit)

**Extensions:**
- `pg_cron`, `pg_net`, `pgvector`, `pg_trgm`, `pgcrypto` enabled

For each check, print one line:

```
✓ memory_items table exists
✗ Legacy mnestra_* schema missing — run: termdeck init --mnestra (will apply migration 008)
✗ pg_cron extension not enabled — enable in dashboard: <link>
```

Group checks under headers (Mnestra Modern / Legacy / Transcript / Rumen / Extensions). End with a summary line: `N/M checks passed`.

### 4. Register `doctor` as a CLI subcommand

In `packages/cli/src/index.js`, add minimal dispatch logic so `termdeck doctor` invokes the new command. Don't reshape the CLI argument parsing — just add one branch. Add `--help` output for it.

## Manual test

```bash
# 1. Verify init --rumen blocks on missing extensions
#    (use a fresh Supabase project without pg_cron/pg_net enabled, OR temporarily revoke them)
termdeck init --rumen
# Expected: ✗ pg_cron extension is not enabled. ...
#           Exit code != 0

# 2. Verify termdeck doctor reports state
termdeck doctor
# Expected: structured pass/fail report grouped by section

# 3. Verify termdeck doctor exits 0 on Joshua's healthy box (against petvetbid)
termdeck doctor; echo "exit: $?"
# Expected: most checks pass; legacy schema may show missing if T2 hasn't run init against petvetbid yet
```

## Status posting

Append to `docs/sprint-35-reconciliation/STATUS.md`:

```
## YYYY-MM-DD HH:MM ET — [T3 FINDING] <observation>
## YYYY-MM-DD HH:MM ET — [T3 FIX-PROPOSED] <approach>
## YYYY-MM-DD HH:MM ET — [T3 DONE] <one-line summary>
```

## Out of scope

- `termdeck doctor --fix` auto-remediation — read-only diagnosis only this sprint (future enhancement)
- Don't auto-enable extensions — Supabase dashboard requires the user click
- No CHANGELOG edits — orchestrator handles
- No version bumps — orchestrator handles
- No commits — orchestrator handles
