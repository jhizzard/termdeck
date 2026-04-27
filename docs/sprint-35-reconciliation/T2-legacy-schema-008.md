# T2 — Legacy RAG schema as migration 008

## Goal

Convert `config/supabase-migration.sql` (currently labeled "Legacy v0.1 — kept for reference") into a real shipped migration `008_legacy_rag_tables.sql` that runs idempotently as part of `termdeck init --mnestra`. Opt-in RAG users (those who toggle `rag.enabled: true` post-T1's default flip) need these tables present so `rag.js` doesn't 404 the way Brad's box did.

## Files (yours)

- `config/supabase-migration.sql` (audit + edit for idempotency if needed)
- `packages/server/src/setup/mnestra-migrations/008_legacy_rag_tables.sql` (NEW — copy of the audited supabase-migration.sql)
- `packages/server/src/setup/migration-runner.js` (wire 008 into the runner sequence)
- `CLAUDE.md` (update file-map line that says "Legacy v0.1 — kept for reference")

## Files NOT yours (don't touch)

- `packages/server/src/rag.js` (Phase C decision — legacy vs modern schema consolidation)
- `packages/cli/src/init-mnestra.js` (T1 owns)
- `packages/cli/src/init-rumen.js` (T3 owns)
- Anything in `packages/cli/src/`

## Concrete changes

### 1. Audit `config/supabase-migration.sql` for idempotency

Every statement in the file must be safely re-runnable. Check:

- `CREATE TABLE` → must have `IF NOT EXISTS`
- `CREATE INDEX` → must have `IF NOT EXISTS`
- `ALTER TABLE ... ADD COLUMN` → must have `IF NOT EXISTS` (Postgres 9.6+)
- `CREATE POLICY` → wrap in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` OR use `DROP POLICY IF EXISTS <name> ON <table>;` first
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` → safe to re-run, but verify
- Any `INSERT` of seed data → use `ON CONFLICT DO NOTHING`

If anything is non-idempotent, fix it in `config/supabase-migration.sql`. Test idempotency: run the SQL twice against a Postgres database — second run must succeed without errors.

### 2. Create `packages/server/src/setup/mnestra-migrations/008_legacy_rag_tables.sql`

Don't symlink. Don't replace `config/supabase-migration.sql`. Make it a true file copy. Both files should be byte-identical (or close — the package version may want a header comment noting it's a mirror). Future Phase C may consolidate or deprecate; this sprint preserves both.

The file header should make the relationship explicit:

```sql
-- 008_legacy_rag_tables.sql
-- Mirror of config/supabase-migration.sql (kept in repo root for reference / manual application).
-- Auto-applied by packages/server/src/setup/migration-runner.js as the 8th Mnestra migration.
-- Safe to re-run: all CREATE statements use IF NOT EXISTS guards.
```

### 3. Wire 008 into `migration-runner.js`

Look at how migrations 001–007 + transcript-migration are sequenced in the existing runner (around `migration-runner.js:14–70`). Add 008 immediately after 007 and before transcript-migration. Use the exact same loading pattern (path resolution, error handling, progress event emission).

### 4. Update CLAUDE.md file-map line

Find this line in CLAUDE.md (the project-level one in this repo, not the user-global one):

```
│   ├── supabase-migration.sql            # Legacy v0.1 RAG DDL
```

Change to:

```
│   ├── supabase-migration.sql            # Legacy v0.1 RAG DDL (mirror; auto-applied via mnestra-migrations/008_legacy_rag_tables.sql)
```

## Manual test

After your changes:

```bash
# Test against a scratch Supabase project (NOT petvetbid).
# Use TEST_DATABASE_URL from a separate Supabase project for safety.

psql $TEST_DATABASE_URL -f packages/server/src/setup/mnestra-migrations/008_legacy_rag_tables.sql

# Run again — must succeed without errors:
psql $TEST_DATABASE_URL -f packages/server/src/setup/mnestra-migrations/008_legacy_rag_tables.sql

# Verify tables exist:
psql $TEST_DATABASE_URL -c "\dt mnestra_*"
# Expected output should include: mnestra_session_memory, mnestra_project_memory, mnestra_developer_memory, mnestra_commands
```

If you don't have a scratch Supabase project handy, document the idempotency analysis in your STATUS.md FINDING entry instead — orchestrator will run the migration test as part of pre-publish verification.

## Status posting

Append to `docs/sprint-35-reconciliation/STATUS.md`:

```
## YYYY-MM-DD HH:MM ET — [T2 FINDING] <observation>
## YYYY-MM-DD HH:MM ET — [T2 FIX-PROPOSED] <approach>
## YYYY-MM-DD HH:MM ET — [T2 DONE] <one-line summary>
```

## Out of scope

- No CHANGELOG edits — orchestrator handles
- No version bumps — orchestrator handles
- No commits — orchestrator handles
- Don't rewrite `rag.js` to use the modern `memory_items` schema (Phase C decision)
- Don't delete `config/supabase-migration.sql` (other docs and external tools may reference it)
