# Sprint 61 — Phase B Runbook (operator-side)

**Audience:** Joshua, executing in parallel with the 3+1+1 Sprint 61 lanes. Self-contained — do not consult other docs while running this. Cross-reference for the curious is `docs/INSTALL-FIXTURES.md` § 6.

**What Phase B does:** stands up a brand-new dedicated Supabase project named `termdeck-test` that the GitHub Actions install-smoke catch-net will use as a real test target, applies the Mnestra schema baseline, installs the safety canary, wires 10 GitHub Actions secrets, and verifies the reset script clears+re-seeds correctly.

**Total estimated time:** ~35–45 minutes wall-clock (≈25 min hands-on, ~10–15 min waiting on Supabase provisioning + migration runs).

---

## Before you start — checklist

- [ ] Laptop in front of you, `~/.claude/CLAUDE.md` rules apply (the four forbidden external-project literals are off-limits in any commit / PR / message — global rule).
- [ ] Browser logged into **supabase.com** as the org owner (the org that holds your daily-driver Mnestra project).
- [ ] Browser logged into **github.com** with admin rights on `jhizzard/termdeck`.
- [ ] Terminal in the TermDeck repo: `cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck`.
- [ ] `psql` available on PATH (`psql --version` works — should be ≥ 14).
- [ ] 1Password open (or your password vault of choice) ready to receive a new entry for the test project's DB password.
- [ ] Engram repo checkout exists at `~/Documents/Graciella/engram/` (sanity: `ls ~/Documents/Graciella/engram/migrations/0*.sql` returns 17 files).

> **Note:** Do not start Phase B if any Sprint 61 worker lane has posted a finding that touches the reset script (`scripts/test-supabase-reset.sh`) and not yet shipped it — coordinate with the orchestrator first. Phase B works against the script as it currently lives on `main`.

---

## Step 1 — Create the `termdeck-test` Supabase project

**Time:** ~5 minutes (2 min hands-on, ~3 min waiting on provisioning).

1. Open <https://supabase.com/dashboard> and select the **same org** that holds your daily-driver Mnestra project (the org name is what shows in the top-left org switcher).
2. Click **New project**.
3. Fill in:
   - **Name:** `termdeck-test` (exact spelling — this is referenced in CI workflow YAML).
   - **Region:** the same region as your daily-driver project (matches latency profile of CI runs against the daily-driver-equivalent shape; if unsure, **East US (North Virginia) — `us-east-1`** is a safe default for someone in NY).
   - **Plan:** **Free** (500 MB storage, 2-project-per-org cap; you have headroom).
   - **Database password:** click the dice icon to generate a strong password. **Immediately** save it to 1Password under the entry name `Supabase termdeck-test DB password`. You will need the password again in Step 2 (it is part of the connection string but Supabase masks it after creation).
4. Click **Create new project**. Wait ~2 minutes for provisioning to complete (the dashboard greys out, then comes back live).
5. Once the dashboard is live for the new project, capture these five values into a scratch buffer (a `.txt` file in `/tmp/`, an Apple Note, anywhere local — **never** commit them):

   | Field | Where to find it |
   |---|---|
   | **Project ref** | Settings → General → "Reference ID" (looks like `abcd1234efgh`) |
   | **Project URL** | Settings → API → "Project URL" (`https://abcd1234efgh.supabase.co`) |
   | **Anon key** | Settings → API → "Project API keys" → `anon` `public` |
   | **Service-role key** | Settings → API → "Project API keys" → `service_role` `secret` (treat as password) |
   | **Connection string (Direct)** | Settings → Database → "Connection string" → **URI** tab → **Direct connection** (port 5432, host is `db.<ref>.supabase.co`) — paste the password in place of `[YOUR-PASSWORD]` |
   | **Connection string (Transaction Pooler)** | Same panel → **Transaction pooler** (port 6543, includes `?pgbouncer=true&sslmode=require`) — paste password |

> **Note:** Supabase shows `[YOUR-PASSWORD]` as a placeholder in the connection string. Replace it with the actual generated password from 1Password before using the URL. Easy to miss; if `psql` errors with `password authentication failed`, this is almost always why.

> **Note:** The **Direct** URL is what you use for `psql`-driven migrations (Step 2). The **Transaction Pooler** URL is what goes into the `TEST_DATABASE_URL` GitHub secret (Step 4) — pgbouncer is what the install-smoke fixture expects.

---

## Step 2 — Apply the Mnestra migrations (001–019)

**Time:** ~3 minutes (mostly waiting on `psql` to apply 17 files).

The Mnestra schema source-of-truth lives in `~/Documents/Graciella/engram/migrations/`. There are 17 `.sql` files numbered 001 through 019 (missing 008 + 011 by design — those numbers were absorbed into other files during refactors and are not part of the active schema).

1. In your terminal, set the test database URL using the **Direct** connection string from Step 1:

   ```bash
   export TEST_DATABASE_URL='postgresql://postgres.<ref>:<password>@db.<ref>.supabase.co:5432/postgres?sslmode=require'
   ```

   (Replace `<ref>` and `<password>` with the actual values. **Quote the whole URL** in single quotes — `?` and `&` characters break unquoted shell expansion.)

2. Sanity-check the connection:

   ```bash
   psql "$TEST_DATABASE_URL" -c 'SELECT current_database(), current_user, version();'
   ```

   Expected: one row showing `postgres / postgres / PostgreSQL 15.x ...`. If this fails with `password authentication failed`, check the URL again (Step 1 placeholder).

3. Apply the Mnestra migrations:

   ```bash
   for f in ~/Documents/Graciella/engram/migrations/0*.sql; do
     echo "Applying $f"
     psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -f "$f" || { echo "ABORT: $f failed"; break; }
   done
   ```

   Expected: 17 lines `Applying .../001_mnestra_tables.sql` through `Applying .../019_security_hardening.sql`, each followed by zero or a few `NOTICE:` lines, no `ERROR:` lines.

> **Note:** The migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, etc.) — safe to re-run. **But if any single migration errors, do NOT power through.** The `|| break` in the loop above guarantees abort on first failure. Investigate the error before re-running.

> **Note:** `019_security_hardening.sql` is the RLS / search_path / EXECUTE-revoke hardening migration shipped in Mnestra v0.4.4. It is required — do NOT skip it. The install-smoke fixture's `doctor --json` step will flag a non-hardened test project as RED.

4. Verify the schema landed:

   ```bash
   psql "$TEST_DATABASE_URL" -c "\dt public.*" | grep -E 'memory_items|memory_sessions|memory_relationships'
   ```

   Expected: three rows for the three Mnestra core tables.

---

## Step 3 — Rumen artifacts (no migration step required for Phase B)

**Time:** ~1 minute (verification only).

Rumen ships **Edge Functions** (Deno-based, deployed via `supabase functions deploy`), not standalone SQL migrations that need pre-applying as Phase B setup. The Rumen schema (a small `rumen_jobs` / `rumen_insights` / `rumen_questions` triplet plus pg_cron schedule) is provisioned at install time by `termdeck-stack` when it runs `init --rumen` against the test project — that happens **inside** the install-smoke run, not during Phase B setup.

What this means for you in Phase B: **do nothing**. The install-smoke fixture provisions Rumen artifacts during its own run.

> **Note:** If a future Sprint adds standalone Rumen-side SQL migrations that need pre-applying (the `~/Documents/Graciella/rumen/migrations/` directory exists and has `001_rumen_tables.sql` + `002_pg_cron_schedule.sql`, but the canonical install path runs them via `termdeck-stack`, not via operator pre-apply), update this step. As of Sprint 61, no operator-side Rumen apply is required.

---

## Step 4 — Add 10 GitHub Actions secrets

**Time:** ~10 minutes (mostly clicking through the GitHub UI 10 times).

Path: <https://github.com/jhizzard/termdeck/settings/secrets/actions> → **New repository secret** for each of the 10 below.

> **Naming ambiguity resolved:** `docs/INSTALL-FIXTURES.md` § 5 (Sprint 58 doc) prescribes `TEST_ANTHROPIC_API_KEY` etc. with a `TEST_` prefix. Sprint 61's T3-fresh-install-harness.md and the Phase-B brief use the **un-prefixed** names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.). **Use the un-prefixed names** — that is what the Sprint 61 install-smoke workflow expects to read. The 4 Supabase-related secrets keep the `TEST_` prefix; the 6 dummies do not. (The `XAI_API_KEY` and `HETZNER_SSH_KEY` names are also Sprint-61 additions not present in the Sprint 58 doc.)

### The 4 LIVE secrets (real values from Step 1)

| Secret name | Value source |
|---|---|
| `TEST_SUPABASE_URL` | Step 1 → Project URL (`https://<ref>.supabase.co`) |
| `TEST_SUPABASE_ANON_KEY` | Step 1 → Anon key (full JWT) |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | Step 1 → Service-role key (full JWT — treat as password) |
| `TEST_DATABASE_URL` | Step 1 → **Transaction Pooler** URL (port 6543, includes `?pgbouncer=true&sslmode=require`) |

> **Note:** `TEST_DATABASE_URL` is the **Transaction Pooler** URL, not the Direct URL you used in Step 2. The pooler URL is what GitHub Actions runners need (their egress is more compatible with pgbouncer's connection model). Easy to mix up.

### The 6 DUMMY secrets (placeholder strings — install-smoke checks presence, not validity)

| Secret name | Suggested dummy value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-test-dummy-not-a-real-key` |
| `OPENAI_API_KEY` | `sk-openai-test-dummy-not-a-real-key` |
| `GEMINI_API_KEY` | `gemini-test-dummy-not-a-real-key` |
| `XAI_API_KEY` | `xai-test-dummy-not-a-real-key` |
| `HETZNER_API_TOKEN` | `hetzner-test-dummy-not-a-real-token` |
| `HETZNER_SSH_KEY` | `ssh-ed25519 AAAA-test-dummy-not-a-real-key test@dummy` |

> **Note:** The install-smoke fixture only checks that the env var is **present and non-empty** — it does NOT call out to any of these APIs. The dummies will satisfy the wizard probes. If a future fixture step actually exercises one of these APIs against real infra (e.g. spinning a real Hetzner VM in a cost-budgeted test), upgrade the corresponding secret to a real value at that time.

After adding all 10, the secrets page should show exactly 10 entries (or however many you had before plus 10). Take a screenshot for the Phase-B audit trail if you want — not required.

---

## Step 5 — Install the canary marker row

**Time:** ~1 minute.

The reset script (`scripts/test-supabase-reset.sh`) refuses to truncate any database that does not contain the canary row. This is the safeguard against accidentally pointing `TEST_DATABASE_URL` at the daily-driver Mnestra project.

Using the same `TEST_DATABASE_URL` you exported in Step 2:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS _termdeck_test_canary (
  ref         TEXT PRIMARY KEY,
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO _termdeck_test_canary (ref, note)
VALUES (
  '__termdeck_test_canary__',
  'Sprint 61 Phase-B canary. scripts/test-supabase-reset.sh refuses to truncate without this row. Project: termdeck-test (dedicated catch-net target).'
)
ON CONFLICT (ref) DO NOTHING;
SQL
```

Verify:

```bash
psql "$TEST_DATABASE_URL" -c "SELECT ref, note FROM _termdeck_test_canary;"
```

Expected: 1 row with `ref='__termdeck_test_canary__'`.

> **Note:** The Sprint 58 INSTALL-FIXTURES.md § 6.4 spec uses the canary `ref` value `'sprint-58-test-project'`. The user prompt for Phase B specifies `'__termdeck_test_canary__'`. **The reset script's canary check reads whatever `ref` value the script source defines** — verify before relying on either. If Step 6 below reports `canary precheck failed (exit 3)`, the most likely cause is `ref`-string drift between the script and this runbook. Resolution: open `scripts/test-supabase-reset.sh`, find the `SELECT 1 FROM _termdeck_test_canary WHERE ref = '...'` line, and use **that** literal as the canary `ref`. Re-run Step 5 with the corrected value.

---

## Step 6 — Verify the reset script clears + re-seeds correctly

**Time:** ~3 minutes.

`TEST_DATABASE_URL` should still be exported in your shell from Step 2. If you opened a new terminal, re-export it.

1. Dry-run first (prints SQL, makes no changes):

   ```bash
   ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/scripts/test-supabase-reset.sh --dry-run
   ```

   Expected: prints the truncate SQL, exits 0. If it exits 3 with `canary precheck failed`, see the Step 5 note above.

2. Real run:

   ```bash
   ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/scripts/test-supabase-reset.sh
   ```

   Expected: ends with `[reset] HH:MM:SS test schema reset complete`, exit 0.

3. Confirm the canary survived (it is **not** in the truncate list):

   ```bash
   psql "$TEST_DATABASE_URL" -c "SELECT ref FROM _termdeck_test_canary;"
   ```

   Expected: 1 row, same `ref` you inserted in Step 5.

4. Confirm the Mnestra core tables exist but are empty:

   ```bash
   psql "$TEST_DATABASE_URL" -c "SELECT 'memory_items' AS tbl, COUNT(*) FROM memory_items UNION ALL SELECT 'memory_sessions', COUNT(*) FROM memory_sessions UNION ALL SELECT 'memory_relationships', COUNT(*) FROM memory_relationships;"
   ```

   Expected: 3 rows, all `count = 0`.

> **Note:** The Sprint 61 T2 lane is shipping extensions to the reset script that add `mnestra_migrations` clearing and Rumen-artifact teardown. **Phase B does not need those extensions** — it just needs the reset script to work against the project as it stands today. If the script outputs warnings about tables that don't exist (e.g. `mnestra_migrations`), that is expected pre-T2 behavior and not a blocker.

> **Note:** If the reset script errors with `psql: connection to server ... failed`, check that you used the **Direct** URL (port 5432) for the local `TEST_DATABASE_URL` export. The Transaction Pooler URL (port 6543) is for GitHub Actions; some `psql` operations (notably ones that use prepared statements or session-level state) misbehave through pgbouncer in transaction mode.

---

## Step 7 — Tell the orchestrator Phase B is done

**Time:** ~30 seconds.

In the orchestrator's terminal (the long-running Claude Code session that fired the Sprint 61 inject), tell it: **"Phase B done"**.

The orchestrator will then post `### [ORCH] PHASE-B-ACTIVE 2026-MM-DD HH:MM ET — termdeck-test provisioned, secrets wired, reset verified` to `docs/sprint-61-uninstall-and-install-harness/STATUS.md`. That post unblocks T3 (the install-smoke harness lane).

Once T3 sees `PHASE-B-ACTIVE`, it can proceed with end-to-end fixture runs against the real test project.

---

## Troubleshooting cheat-sheet

| Symptom | Likely cause | Fix |
|---|---|---|
| `psql: password authentication failed` | Connection string still has `[YOUR-PASSWORD]` placeholder | Re-paste from 1Password, replacing the placeholder |
| Migration loop aborts on file 0XX | Real schema error, **not** idempotency | Read the error; do NOT power through; ping the orchestrator |
| `canary precheck failed (exit 3)` | `ref` value mismatch between Step 5 insert and the script's check | Read `scripts/test-supabase-reset.sh` for the literal `ref` it expects; re-run Step 5 with that value |
| Reset succeeds but `memory_items` still has rows | The script's truncate list is stale relative to the migration set | Pre-T2-extension script may not clear `mnestra_migrations`; this is Sprint 61 T2 work, not a Phase B blocker |
| GitHub Actions install-smoke run fails with `secret not found: ANTHROPIC_API_KEY` | Secret was named `TEST_ANTHROPIC_API_KEY` (Sprint 58 spec) instead of `ANTHROPIC_API_KEY` (Sprint 61 spec) | Rename the secret in GitHub repo settings — the workflow YAML is the source-of-truth on the name |

---

## Phase B done — what's next

The next time the install-smoke workflow fires (push to `main`, PR open, or `workflow_dispatch`), it will:

1. Read the 10 secrets you just wired.
2. Connect to `termdeck-test` (not your daily-driver project).
3. Run `scripts/test-supabase-reset.sh` to clear schema state between runs.
4. Run `termdeck init --mnestra --yes`, `termdeck init --rumen --yes`, `termdeck doctor --json` against the test project.
5. Run the REPRODUCER probes for Brad's findings #1, #2, #5, #6.
6. Report pass/fail through the `fixture-status-meta` job.

Phase B's contribution is steps 2–3: the test project itself plus the reset-script-verified clean baseline. The rest of the catch-net rides on top.
