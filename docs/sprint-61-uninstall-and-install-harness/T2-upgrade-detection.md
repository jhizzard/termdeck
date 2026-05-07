# T2 — UPGRADE-DETECTION

You are **T2** in Sprint 61 (Uninstall + Fresh-Install Harness — Convergence Keystone).

## Why this lane exists

Brad's open P0 since 2026-05-02: the stack-installer has NO upgrade-detection path. He runs `npm install -g @latest` against an existing install; the npm package files upgrade, but his Supabase project's schema stays at first-install state. `init-rumen.js::applySchedule` (and the parallel mnestra path) only applies migrations on the *fresh-install* code path. Every external user upgrading lands in broken territory until they manually re-run a wizard or drop schemas.

Your job is to ship a **migration tracking table** + **diff-and-apply loop** + **backfill probe** that makes upgrades safe by default.

## Boot sequence (run before any code)

1. `memory_recall(project="termdeck", query="upgrade-detection P0 Brad 2026-05-02 + mnestra_migrations tracking + schema introspection diff")`
2. `memory_recall(project="termdeck", query="audit-upgrade probes + 7 mnestra probes + Sprint 51.5 audit")`
3. `memory_recall(query="migration runner + idempotent migrations + checksum")`
4. Read `~/.claude/CLAUDE.md`
5. Read `./CLAUDE.md`
6. Read `docs/CONVERGENCE-PLAN.md`
7. Read `docs/sprint-61-uninstall-and-install-harness/PLANNING.md` (especially § T2 scope)
8. Read `docs/sprint-61-uninstall-and-install-harness/STATUS.md`
9. Read `docs/INSTALLER-PITFALLS.md` (Class A — Schema drift; Class N — Lockstep migration; Class K — source-fix-but-dist-not-rebuilt)
10. Read `packages/server/src/setup/migrations.js` and `migration-runner.js` (existing executor)
11. Read `packages/server/src/setup/audit-upgrade.js` (the schema-introspection probes — your backfill leverages these)
12. Read `packages/cli/src/init-mnestra.js` (where the call-site is — `runHookRefresh` adjacent)
13. Read `packages/server/src/setup/mnestra-migrations/` (bundled set, currently 001-018 — 019 NOT YET MIRRORED from engram; see "Pre-existing drift" below)
14. Read `~/Documents/Graciella/engram/migrations/` (source-of-truth, 001-019 — 019_security_hardening lives here)

Then begin.

## Pre-existing drift to address FIRST

The termdeck bundle at `packages/server/src/setup/mnestra-migrations/` has 001-018. The engram source-of-truth has 001-019, where 019 is `019_security_hardening.sql` (mnestra 0.4.4's RLS + REVOKE EXECUTE + search_path migration). The bundle has not been mirrored since 0.4.4 shipped.

**Step 0 of your lane:** mirror `019_security_hardening.sql` from engram into the termdeck bundle so a fresh-install via the stack-installer applies the same security baseline that mnestra 0.4.4+ ships to package upgraders. Without this, fresh installs land WITHOUT 019, and your tracker would record "all bundled migrations applied" in a less-secure state. Verify with a byte-for-byte diff (`diff -q`) post-mirror.

If during your work you discover any other bundle-vs-engram drift, post `### [T2] FINDING ...` and address it.

## Scope (precise)

### Step 0 — Mirror engram 019 into the termdeck bundle

`cp ~/Documents/Graciella/engram/migrations/019_security_hardening.sql packages/server/src/setup/mnestra-migrations/019_security_hardening.sql`. Then `diff -q` to confirm bit-exact.

### Step 1 — New migration `020_migration_tracking.sql`

Author **in both places**:
- `~/Documents/Graciella/engram/migrations/020_migration_tracking.sql` (source-of-truth)
- `packages/server/src/setup/mnestra-migrations/020_migration_tracking.sql` (bundle mirror, bit-exact)

Content:

```sql
-- 020_migration_tracking.sql
-- Adds durable tracking of which Mnestra migrations have been applied to a project,
-- so upgrade paths can compute (bundled - applied) and apply only the diff.
-- Sprint 61 (TermDeck Convergence Keystone), Mnestra 0.4.7.

CREATE TABLE IF NOT EXISTS public.mnestra_migrations (
  filename       text PRIMARY KEY,
  applied_at     timestamptz NOT NULL DEFAULT now(),
  checksum       text NOT NULL,
  schema_version text
);

ALTER TABLE public.mnestra_migrations ENABLE ROW LEVEL SECURITY;

-- Service-role-only. anon and authenticated have NO access (no policies = denied by RLS).
-- Service role bypasses RLS by default; the table is queried only by the migration runner
-- which uses the service-role key.

REVOKE ALL ON public.mnestra_migrations FROM PUBLIC;
GRANT  ALL ON public.mnestra_migrations TO service_role;

COMMENT ON TABLE public.mnestra_migrations IS
  'Tracking table for applied Mnestra migrations. service_role-only; RLS-on; no policies.';
```

Note: this migration MUST satisfy all 5 RLS hygiene gates from `~/.claude/CLAUDE.md`. It does (RLS on, no PUBLIC policies, no functions, REVOKE FROM PUBLIC + GRANT TO service_role).

### Step 2 — Extend `packages/server/src/setup/migrations.js`

Add a function (e.g. `applyPendingMigrations(client, opts)`) that:

1. Tries `SELECT filename FROM public.mnestra_migrations`.
   - If the table doesn't exist (PG error code `42P01`), the project is pre-020. Run the **backfill probe** (step 3) FIRST, then re-query.
2. Reads bundled migration filenames from `packages/server/src/setup/mnestra-migrations/`. Filter to `*.sql`, sort by filename (lexicographic — `001_*` to `020_*` to future).
3. Computes `pending = bundled - applied`.
4. For each pending migration in filename order:
   - Read file content.
   - Compute SHA-256 checksum.
   - Run the migration in a transaction.
   - On commit, INSERT a row: `(filename, NOW(), <sha256>, <schema_version_or_null>)`.
   - On error, ROLLBACK and post `RUN-ERROR <filename>: <error-detail>` to caller's logging — don't proceed to subsequent migrations.
5. Return summary `{ applied: [...], skipped: [...], errored: null | {file, error} }`.

### Step 3 — Backfill probe

For projects that exist pre-020 (i.e., `mnestra_migrations` table is missing), seed the tracking table with rows for migrations whose schema-fingerprint matches the current state of the database. Use `audit-upgrade.js`'s existing schema introspection (`probeMnestra`, `probeRumen` — adapt or extract).

For each bundled migration 001-019:
- Probe set per migration (table exists / column exists / function exists / extension exists).
- Example: 015_source_agent's probe is `SELECT 1 FROM information_schema.columns WHERE table_name = 'memory_items' AND column_name = 'source_agent'`.
- Example: 010_memory_recall_graph's probe is `SELECT 1 FROM pg_proc WHERE proname = 'memory_recall_graph'`.
- Example: 019_security_hardening's probe is `SELECT NOT pg_has_role('public', 'mnestra_doctor_vault_secret_exists()'::regprocedure, 'EXECUTE')` (i.e., PUBLIC does NOT have execute = 019 applied).

Author the probe set as a **declarative table** at the top of `migrations.js` (or a new file `migration-probes.js`):

```js
const MIGRATION_PROBES = [
  { filename: '001_mnestra_tables.sql',          probe: "SELECT 1 FROM information_schema.tables WHERE table_name = 'memory_items'" },
  { filename: '002_mnestra_search_function.sql', probe: "SELECT 1 FROM pg_proc WHERE proname = 'memory_hybrid_search'" },
  // ... one per bundled migration
];
```

Backfill loop:
1. For each `MIGRATION_PROBES` entry, run the probe SQL.
2. If probe returns ≥1 row, INSERT into `mnestra_migrations` with checksum from the bundled file. Use `applied_at = '1970-01-01T00:00:00Z'` to mark as backfilled-not-actually-tracked-from-day-one (schema_version = `'backfill'`).
3. If probe returns 0 rows, the migration genuinely needs to be applied — skip the backfill INSERT, let step 2's diff-and-apply pick it up.

### Step 4 — Wire into call sites

Edit `packages/cli/src/init-mnestra.js` (and `init-rumen.js` if needed) to call `applyPendingMigrations` on every wizard invocation, NOT only fresh installs. The existing fresh-install vs upgrade branch should COLLAPSE to a single path that always runs the diff-and-apply.

### Tests — `tests/migration-tracker.test.js` (NEW)

Use a sandboxed Postgres or a mock (consult existing test patterns; if `tests/` already has DB-backed tests, follow the same pattern; otherwise mock pg).

1. **Empty `mnestra_migrations` + bundled-set of N → applies all N.** Assert N rows in tracking table after.
2. **Partial applied (5 of N) + bundled-set of N → applies (N-5).** Assert tracking table has N rows.
3. **Backfill detects post-Sprint-38 schema state and seeds rows accordingly.** Synthesize a DB with schema as if 001-018 had been applied (no tracking table, but tables/columns/functions present), run `applyPendingMigrations`. Assert tracking table now has 18 backfilled rows + 19 + 20 (= 20 total) after the diff-apply.
4. **Re-running with no diff exits clean.** Empty diff → return `{ applied: [], skipped: [...all], errored: null }`.
5. **Migration with bad checksum vs DB.** Synthesize a tracking row with checksum X but bundled file checksum Y (simulating tampering or a downgraded bundle). Assert the system flags WARNING, does NOT auto-overwrite, returns the warning in the summary.
6. **Migration that errors.** Inject a syntactically-bad SQL into a fake migration in a tempdir bundle. Assert ROLLBACK happens, no row written to tracking, errored summary returned, subsequent migrations NOT attempted.

## Lane discipline

- Post `### [T2] STATUS-VERB 2026-05-07 HH:MM ET — gist` for every status change.
- Post `### [T2] FIX-PROPOSED ...` BEFORE applying substantive diff (T4-CODEX audits-the-WIP).
- Post `### [T2] DONE ...` only when all 6 test cases green AND the engram + bundle 020 files are bit-exact diff -q.
- Don't bump versions, don't touch CHANGELOG, don't commit.

## Acceptance for T2 DONE

1. Step 0: `019_security_hardening.sql` mirrored from engram → termdeck bundle, `diff -q` clean.
2. Step 1: `020_migration_tracking.sql` authored in BOTH engram AND termdeck bundle, bit-exact.
3. Step 2: `applyPendingMigrations` exported from `migrations.js`, covers diff loop + checksum + transaction + per-file error isolation.
4. Step 3: backfill probe authored as declarative table, covers all 19 bundled migrations.
5. Step 4: call sites in `init-mnestra.js` (and `init-rumen.js` if applicable) collapsed to always run the diff-apply on every invocation.
6. `tests/migration-tracker.test.js` — all 6 cases green.
7. T4-CODEX has posted `### [T4-CODEX] AUDIT-CLEAR T2 ...`.
8. Final `### [T2] DONE 2026-05-XX HH:MM ET — migration tracker + backfill + 6 tests green` post.

## INSTALLER-PITFALLS classes you must trace to

- **Class A** (Schema drift on package upgrade) — diff-and-apply on every invocation closes this directly.
- **Class K** (Source fixed, dist not rebuilt) — your migration tracking will surface this when the bundle SHA differs from the applied SHA.
- **Class N** (Lockstep migration) — backfill probe ensures pre-020 projects don't get re-applied migrations they already have.

## What to ask the orchestrator

- If `audit-upgrade.js`'s probe set diverges from your `MIGRATION_PROBES` table (e.g., audit covers 7 mnestra probes only — Sprint 51.5 lock), post `### [T2] FINDING ...` and ask whether to extract a single source-of-truth.
- If the engram source-of-truth has migrations the bundle is missing OTHER than 019, post `### [T2] FINDING ...` and ask whether to mirror them as part of this sprint or defer to a hygiene pass.

## Out of T2 scope (do NOT touch)

- Uninstall CLI (T1's lane).
- GH Actions workflows (T3's lane).
- Rumen migrations (no rumen-migrations dir in termdeck currently — if Rumen ships migrations elsewhere, defer parity to a follow-up).
- Mnestra 0.4.7 publish (orchestrator at sprint close).
- Migration content beyond 020 — security-by-default RLS migration is Sprint 62's lane.
