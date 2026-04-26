// Front-loaded precondition audits and post-write outcome verifications for
// the `termdeck init --mnestra` and `termdeck init --rumen` wizards.
//
// Why this module exists (v0.6.9)
// ───────────────────────────────
// The v0.6.x lineage shipped 8 patch releases in 48 hours. Four of them —
// v0.6.4 (SUPABASE_ACCESS_TOKEN), v0.6.6 (pgbouncer params), v0.6.7
// (mcp.json placeholder), and what would have been v0.6.9 (pg_cron +
// pg_net extensions, Vault secret) — were the SAME failure mode: a
// precondition was DOCUMENTED in GETTING-STARTED.md or a migration-file
// header but not VERIFIED in code. Each unsupervised user (Brad) hit
// them sequentially because there was no audit step at the start of the
// wizard. Documentation is not verification.
//
// Shape of the defense
// ────────────────────
// `auditRumenPreconditions()` runs FIRST in init-rumen, before any
// state-changing operation. It collects EVERY external precondition gap
// in a single pass — supabase CLI auth, pg_cron + pg_net extensions,
// Vault secret presence — and returns a structured `{ ok, gaps[] }`.
// Callers that see `ok=false` print the gaps with actionable hints and
// refuse to proceed. No partial work, no half-applied state.
//
// `verifyRumenOutcomes()` runs LAST after the schedule SQL applies. It
// confirms `cron.job` has an active rumen-tick row. Doesn't poll for the
// first 15-min tick (too long for an interactive wizard) — but tells the
// user the exact query to run after waiting if they want to confirm
// firing.
//
// `verifyMnestraOutcomes()` runs after migrations apply and confirms
// the column we shipped in v0.6.5 (`source_session_id`) actually landed.
// This is the test that — if it had existed — would have caught Brad's
// v0.6.5/v0.6.8 saga at install time instead of pg_cron-tick time.
//
// All async, all defensive: any unexpected error is captured into a gap
// rather than thrown, so the audit always returns a complete picture.

'use strict';

const { spawnSync } = require('child_process');
const pgRunner = require('./pg-runner');

// Render a single gap into 2-3 lines of CLI output (one indented hint per
// non-empty `hint` line). Format aligned with the rest of the wizard's
// step lines.
function printGap(gap, index) {
  process.stdout.write(`  ${index + 1}. ✗ ${gap.message}\n`);
  if (gap.hint) {
    for (const line of gap.hint.split('\n')) {
      if (line.trim().length > 0) {
        process.stdout.write(`     ${line}\n`);
      }
    }
  }
  process.stdout.write('\n');
}

// Print the audit report. Returns no value — the caller decides what to
// do with `result.ok`.
function printAuditReport(result, context) {
  if (result.ok) {
    process.stdout.write(`→ Auditing ${context} preconditions... ✓\n`);
    return;
  }
  process.stdout.write(`\n→ Auditing ${context} preconditions... ✗\n\n`);
  process.stdout.write(`${result.gaps.length} precondition${result.gaps.length === 1 ? '' : 's'} failed:\n\n`);
  result.gaps.forEach((g, i) => printGap(g, i));
  process.stdout.write(
    `Fix the items above and re-run \`termdeck init --${context}\`. The wizard ` +
    `will not proceed; it would create state you'd have to manually clean up.\n\n`
  );
}

// Same structure for outcome verification — same { ok, gaps[] } shape so
// callers don't branch on which kind of report they're handling.
function printVerifyReport(result, context) {
  if (result.ok) {
    process.stdout.write(`→ Verifying ${context} outcomes... ✓\n`);
    return;
  }
  process.stdout.write(`\n→ Verifying ${context} outcomes... ✗\n\n`);
  process.stdout.write(`${result.gaps.length} expected outcome${result.gaps.length === 1 ? '' : 's'} not found:\n\n`);
  result.gaps.forEach((g, i) => printGap(g, i));
}

// ── Rumen precondition audit ────────────────────────────────────────────────

// Probe the supabase CLI's auth state without running `link`. If the user
// has run `supabase login` previously, `supabase projects list` succeeds.
// If they have SUPABASE_ACCESS_TOKEN in env, same. If neither, this exits
// non-zero and we surface the gap.
function probeSupabaseAuth() {
  // Cheap, network-bound, ~1-2s. Capture both streams so we can inspect
  // for the "Access token not provided" signal.
  const r = spawnSync('supabase', ['projects', 'list', '--output', 'env'], {
    encoding: 'utf-8',
    timeout: 15000
  });
  return { ok: r.status === 0, stderr: r.stderr || '' };
}

// Run all Rumen preconditions in parallel where independent. Returns
// `{ ok: boolean, gaps: [{ key, message, hint }] }`.
//
// Inputs:
//   - secrets: dotenv-loaded ~/.termdeck/secrets.env (must have DATABASE_URL)
//   - env: process.env or test fixture
//
// Optional `_pgClient` injection lets tests substitute a fake client; in
// production we open one and close it at the end of the audit.
async function auditRumenPreconditions({ secrets, env, _pgClient } = {}) {
  const gaps = [];

  // 1. Supabase CLI auth — sync; doesn't need pg.
  if (!env || !env.SUPABASE_ACCESS_TOKEN) {
    const probe = probeSupabaseAuth();
    if (!probe.ok) {
      gaps.push({
        key: 'SUPABASE_ACCESS_TOKEN',
        message: 'Supabase CLI is not authenticated and no SUPABASE_ACCESS_TOKEN in environment',
        hint:
          'Generate a Personal Access Token:\n' +
          '  https://supabase.com/dashboard/account/tokens\n' +
          'Then export it in this shell:\n' +
          '  export SUPABASE_ACCESS_TOKEN=sbp_...\n' +
          '(`supabase login` works on desktops but opens a browser; not viable over SSH.)'
      });
    }
  }

  // 2-4. DB-side checks — open one connection, run them sequentially,
  //      close it at the end. Errors get captured per-check so a single
  //      flaky query doesn't blank the whole audit.
  const client = _pgClient || (await safeConnect(secrets && secrets.DATABASE_URL));
  if (!client) {
    gaps.push({
      key: 'DATABASE_URL',
      message: 'Could not connect to Postgres using DATABASE_URL from ~/.termdeck/secrets.env',
      hint:
        'Verify the URL is reachable from this host:\n' +
        '  psql "$DATABASE_URL" -c "SELECT 1;"\n' +
        'If the connection is fine but you see another error, copy the wizard output and report it.'
    });
    return { ok: gaps.length === 0, gaps };
  }

  try {
    // pg_cron extension
    const cron = await safeQuery(client,
      "SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_cron'");
    if (!cron.ok) {
      gaps.push({
        key: 'pg_cron',
        message: 'The pg_cron extension is not enabled on this Supabase project',
        hint:
          'Enable it in the Supabase dashboard:\n' +
          '  Database → Extensions → pg_cron → toggle ON\n' +
          '(Without pg_cron, the rumen-tick schedule cannot run.)'
      });
    }

    // pg_net extension
    const net = await safeQuery(client,
      "SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_net'");
    if (!net.ok) {
      gaps.push({
        key: 'pg_net',
        message: 'The pg_net extension is not enabled on this Supabase project',
        hint:
          'Enable it in the Supabase dashboard:\n' +
          '  Database → Extensions → pg_net → toggle ON\n' +
          '(pg_net is what the cron schedule uses to call the Edge Function.)'
      });
    }

    // Vault secret rumen_service_role_key — accessing vault.decrypted_secrets
    // requires service_role privileges. Distinguish "no row" from "permission
    // denied" so the hint is actionable.
    const vault = await safeQuery(client,
      "SELECT 1 AS ok FROM vault.decrypted_secrets WHERE name = 'rumen_service_role_key'");
    if (vault.error) {
      gaps.push({
        key: 'vault.decrypted_secrets',
        message: `Cannot read vault.decrypted_secrets: ${vault.error}`,
        hint:
          'Verify your DATABASE_URL is using the service_role connection (port 6543 + service_role auth).\n' +
          'If permission is denied, the Vault is not accessible to this connection — double-check secrets.env.'
      });
    } else if (!vault.ok) {
      gaps.push({
        key: 'rumen_service_role_key',
        message: 'Vault secret "rumen_service_role_key" is missing',
        hint:
          'Create it in the Supabase dashboard:\n' +
          '  Project Settings → Vault → New secret\n' +
          '  Name: rumen_service_role_key  (exact, case-sensitive)\n' +
          '  Value: your service_role key from Project Settings → API\n' +
          '(The pg_cron schedule calls the Edge Function with this key as the bearer token.)'
      });
    }
  } finally {
    if (!_pgClient) {
      try { await client.end(); } catch (_e) { /* ignore */ }
    }
  }

  return { ok: gaps.length === 0, gaps };
}

// ── Rumen outcome verification ──────────────────────────────────────────────
//
// Runs after the pg_cron schedule SQL applies. Confirms the row is in
// cron.job and active. Doesn't wait for first run (15 min is too long
// to block an interactive wizard) — instead tells the user the query to
// run after waiting if they want firing-confirmation.

async function verifyRumenOutcomes({ secrets, _pgClient } = {}) {
  const gaps = [];
  const client = _pgClient || (await safeConnect(secrets && secrets.DATABASE_URL));
  if (!client) {
    gaps.push({
      key: 'DATABASE_URL',
      message: 'Could not reconnect to Postgres to verify the schedule landed',
      hint: 'Re-run `termdeck init --rumen` once connectivity is restored.'
    });
    return { ok: false, gaps };
  }

  try {
    const job = await safeQuery(client,
      "SELECT active FROM cron.job WHERE jobname = 'rumen-tick'",
      { wantRows: true });
    if (job.error) {
      gaps.push({
        key: 'cron.job',
        message: `Cannot read cron.job: ${job.error}`,
        hint: 'pg_cron may have been disabled after the schedule was applied. Re-enable it and re-run the wizard.'
      });
    } else if (!job.rows || job.rows.length === 0) {
      gaps.push({
        key: 'cron.job',
        message: 'Schedule was applied but cron.job has no rumen-tick row',
        hint:
          'This usually means the SELECT cron.schedule(...) call returned NULL. Re-run `termdeck init --rumen` ' +
          'or apply migrations/002_pg_cron_schedule.sql manually to investigate.'
      });
    } else if (!job.rows[0].active) {
      gaps.push({
        key: 'cron.job.active',
        message: 'rumen-tick exists but is paused (active=false)',
        hint:
          'Resume it with:\n' +
          "  SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rumen-tick'), active := true);"
      });
    }
  } finally {
    if (!_pgClient) {
      try { await client.end(); } catch (_e) { /* ignore */ }
    }
  }

  return { ok: gaps.length === 0, gaps };
}

// ── Mnestra outcome verification ────────────────────────────────────────────
//
// After the 7 migrations apply, confirm:
//   - memory_items table exists
//   - source_session_id column exists on it (the v0.6.5 fix actually landed)
//   - memory_status_aggregation function exists
//
// This is the test that would have caught the v0.6.5 / v0.6.8 silent-shadow
// saga at install time instead of cron-tick time.

async function verifyMnestraOutcomes({ secrets, _pgClient } = {}) {
  const gaps = [];
  const client = _pgClient || (await safeConnect(secrets && secrets.DATABASE_URL));
  if (!client) {
    gaps.push({
      key: 'DATABASE_URL',
      message: 'Could not reconnect to Postgres to verify migrations landed',
      hint: 'This is unexpected — the migrations just ran. Check connectivity and re-run with --yes.'
    });
    return { ok: false, gaps };
  }

  try {
    // memory_items table
    const tbl = await safeQuery(client,
      "SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memory_items'");
    if (!tbl.ok) {
      gaps.push({
        key: 'memory_items',
        message: 'memory_items table is missing after migrations',
        hint: 'Migration 001 should have created it. Re-run with --reset to start fresh, or report a bug.'
      });
    } else {
      // source_session_id column (v0.6.5 fix)
      const col = await safeQuery(client,
        "SELECT 1 AS ok FROM information_schema.columns " +
        "WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'source_session_id'");
      if (!col.ok) {
        gaps.push({
          key: 'memory_items.source_session_id',
          message: 'memory_items.source_session_id column is missing — Rumen will fail',
          hint:
            'Migration 007 should have added it. If you see this, the migration loader picked up a stale\n' +
            'set — upgrade with: npm cache clean --force && npm i -g @jhizzard/termdeck@latest\n' +
            'then re-run `termdeck init --mnestra --yes`.'
        });
      }
    }

    // memory_status_aggregation RPC
    const rpc = await safeQuery(client,
      "SELECT 1 AS ok FROM pg_proc WHERE proname = 'memory_status_aggregation'");
    if (!rpc.ok) {
      gaps.push({
        key: 'memory_status_aggregation',
        message: 'memory_status_aggregation() function is missing',
        hint: 'Migration 006 should have created it. The wizard\'s status check will fall back to client-side aggregation, but that hits PostgREST row caps.'
      });
    }
  } finally {
    if (!_pgClient) {
      try { await client.end(); } catch (_e) { /* ignore */ }
    }
  }

  return { ok: gaps.length === 0, gaps };
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function safeConnect(databaseUrl) {
  if (!databaseUrl) return null;
  try {
    return await pgRunner.connect(databaseUrl);
  } catch (_err) {
    return null;
  }
}

// Run a query that returns at most one row. Returns:
//   { ok: true } when the row exists / value is truthy
//   { ok: false } when no rows or the value is falsy
//   { error: string } on query failure
//
// `wantRows: true` returns the rows array instead of just an ok bit.
async function safeQuery(client, sql, opts = {}) {
  try {
    const r = await client.query(sql);
    if (opts.wantRows) return { rows: r.rows };
    if (r.rows && r.rows.length > 0 && r.rows[0].ok) return { ok: true };
    return { ok: false };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  auditRumenPreconditions,
  verifyRumenOutcomes,
  verifyMnestraOutcomes,
  printAuditReport,
  printVerifyReport,
  // Test surface
  _probeSupabaseAuth: probeSupabaseAuth,
  _safeQuery: safeQuery
};
