// Sprint 51.5 T1 — schema-introspection audit-upgrade.
//
// Brad's 2026-05-02 jizzard-brain report (INSTALLER-PITFALLS.md ledger #13)
// surfaced Class A — schema drift. The user upgraded npm packages but the
// database stayed frozen at first-kickstart: graph-inference Edge Function
// never deployed, vault key never created, Mnestra migrations 009-015 + TD
// Rumen 003 never applied. Both init wizards correctly apply their bundled
// migrations on a fresh install, but neither one diffs an existing install
// against the bundled migration set. After `npm install -g @latest`, the
// npm packages are current and the database is whatever it was the day the
// project was first kickstarted.
//
// auditUpgrade() runs at the top of `termdeck init --mnestra` and
// `termdeck init --rumen` re-runs. For each known schema artifact it:
//   1. Probes for presence via a single information_schema / pg_catalog query.
//   2. If absent, applies the bundled migration that creates that artifact.
//   3. Logs every probe + apply result so the wizard can report what changed.
//
// `dryRun: true` returns the missing[] list without applying — exposed so
// `mnestra doctor` (Sprint 51.5 T2) can render the same drift detection
// without committing changes.
//
// What this file IS: a cheap, additive, idempotent diff applier. Every probe
// is a single SQL statement. Every applied migration is idempotent
// (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
// `ALTER ... SCHEDULE`, `cron.unschedule + cron.schedule`).
//
// What this file is NOT: a migration-tracking-table approach. That's the
// durable answer (deferred to Sprint 52+) — it self-heals all future drift
// but requires a backfill pass for existing installs. v1.0.1 takes the
// cheap path: probe-as-source-of-truth.
//
// Out of scope for v1.0.1: Edge Function deploy via Management API, vault
// secret creation. The bundled `init-rumen.js::deployFunctions` already
// re-deploys both rumen-tick and graph-inference on every `init --rumen`
// re-run, so a user who runs the v1.0.1 hotfix instructions
// (`npm install -g @jhizzard/termdeck@1.0.1 && termdeck init --rumen`)
// gets the function deploys + vault clone via the existing flow. This
// module's job is to land the SQL artifacts cheaply, on either re-run path.

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const migrations = require('./migrations');
const { applyTemplating } = require('./migration-templating');

// Probe → apply mapping. Order matters: dependencies (e.g., M-013 audit
// columns) come after the tables they touch. Cron schedule probes go last
// because they need pg_cron + pg_net which migration 002 takes for granted.
//
// Migration 012 (project_tag_re_taxonomy) is intentionally NOT in this set:
// it is pure DML (UPDATE rows WHERE project='chopin-nashville') with no
// schema artifact to introspect. Re-applying is safe (idempotent on already-
// retagged rows) but auto-applying every audit cycle would scan memory_items
// 8 times for no schema benefit. Migration 012 still ships in the bundled
// set and is applied by the existing init-mnestra `applyMigrations` loop on
// any wizard re-run.
//
// Migration 011 (project_tag_backfill) is similarly out of scope (DML).
// Migration 008 (legacy_rag_tables) is opt-in (rag.enabled toggle) and
// already creates schema with IF NOT EXISTS guards in the fresh-install
// path — not a drift candidate.
const PROBES = Object.freeze([
  {
    name: 'memory_relationships.weight',
    kind: 'mnestra',
    migrationFile: '009_memory_relationship_metadata.sql',
    probeSql:
      "select 1 as present from information_schema.columns " +
      "where table_schema = 'public' " +
      "  and table_name = 'memory_relationships' " +
      "  and column_name = 'weight' limit 1",
    presentWhen: 'rowReturned'
  },
  {
    name: 'memory_recall_graph rpc',
    kind: 'mnestra',
    migrationFile: '010_memory_recall_graph.sql',
    probeSql:
      "select 1 as present from pg_proc " +
      "where proname = 'memory_recall_graph' limit 1",
    presentWhen: 'rowReturned'
  },
  {
    name: 'memory_items.reclassified_by',
    kind: 'mnestra',
    migrationFile: '013_reclassify_uncertain.sql',
    probeSql:
      "select 1 as present from information_schema.columns " +
      "where table_schema = 'public' " +
      "  and table_name = 'memory_items' " +
      "  and column_name = 'reclassified_by' limit 1",
    presentWhen: 'rowReturned'
  },
  {
    // Brad's 2026-04-28 incident: service_role had no INSERT on memory_items
    // because the project's default-privileges-in-schema-public defaults had
    // been tightened (Supabase auto-grants didn't fire). Migration 014 lays
    // down explicit grants. Re-applying on a project where auto-grants did
    // fire is a no-op.
    name: 'service_role explicit grant on memory_items',
    kind: 'mnestra',
    migrationFile: '014_explicit_grants.sql',
    probeSql:
      "select has_table_privilege('service_role', 'public.memory_items', 'INSERT') as present",
    presentWhen: 'boolColumnTrue'
  },
  {
    name: 'memory_items.source_agent',
    kind: 'mnestra',
    migrationFile: '015_source_agent.sql',
    probeSql:
      "select 1 as present from information_schema.columns " +
      "where table_schema = 'public' " +
      "  and table_name = 'memory_items' " +
      "  and column_name = 'source_agent' limit 1",
    presentWhen: 'rowReturned'
  },
  {
    // Sprint 51.6 T3 — bundled session-end hook (TermDeck v1.0.2+) writes
    // the rich rag-system column set to memory_sessions; canonical engram
    // mig 001 only ships (id, project, summary, metadata, created_at).
    // Probe for memory_sessions.session_id (the most distinctive of the
    // mig-017 columns) and apply mig 017 if absent. Idempotent on petvetbid
    // where the columns are already present from hand-applied DDL.
    name: 'memory_sessions.session_id',
    kind: 'mnestra',
    migrationFile: '017_memory_sessions_session_metadata.sql',
    probeSql:
      "select 1 as present from information_schema.columns " +
      "where table_schema = 'public' " +
      "  and table_name = 'memory_sessions' " +
      "  and column_name = 'session_id' limit 1",
    presentWhen: 'rowReturned'
  },
  {
    name: 'rumen-tick cron schedule',
    kind: 'rumen',
    migrationFile: '002_pg_cron_schedule.sql',
    templated: true,
    probeSql:
      "select 1 as present from cron.job where jobname = 'rumen-tick' limit 1",
    presentWhen: 'rowReturned'
  },
  {
    name: 'graph-inference-tick cron schedule',
    kind: 'rumen',
    migrationFile: '003_graph_inference_schedule.sql',
    templated: true,
    probeSql:
      "select 1 as present from cron.job where jobname = 'graph-inference-tick' limit 1",
    presentWhen: 'rowReturned'
  },
  // Sprint 51.6 T3 — Brad's Bug D: function-existence probes (cron schedule
  // checks for jobname presence) are not enough. The deployed Edge Function
  // SOURCE may be stale even when the cron job and function both exist.
  // jizzard-brain on 2026-05-03: deployed rumen-tick was missing the
  // SUPABASE_DB_URL fallback that Sprint 51.5 T1 added; cron probe said
  // "present", source was old. The marker check below detects that drift.
  //
  // probeKind 'functionSource' triggers a Management API fetch instead of a
  // pgClient.query. Bumps to skipped[] (not missing[]) when drift is
  // detected — the corresponding "apply" is a redeploy via init-rumen's
  // deployFunctions, not an SQL migration. The wizard shows skipped[]
  // entries with their probeError, prompting the user to re-run init.
  //
  // Maintenance: bump `requiredMarker` whenever a new feature is added to
  // the bundled function source that is meaningful enough to gate redeploys
  // on. The marker should be a string unique to the post-change version.
  {
    name: 'rumen-tick deployed source has SUPABASE_DB_URL fallback',
    kind: 'rumen',
    probeKind: 'functionSource',
    functionSlug: 'rumen-tick',
    requiredMarker: "Deno.env.get('SUPABASE_DB_URL')",
    presentWhen: 'sourceMatch'
  },
  {
    name: 'graph-inference deployed source has SUPABASE_DB_URL fallback',
    kind: 'rumen',
    probeKind: 'functionSource',
    functionSlug: 'graph-inference',
    requiredMarker: "Deno.env.get('SUPABASE_DB_URL')",
    presentWhen: 'sourceMatch'
  },
  // Sprint 52 — Class O: deployed-state pin drift between npm-published
  // packages and Supabase-deployed Edge Functions. `npm publish` doesn't
  // touch Supabase; `init --rumen` redeploys. If a user upgraded the npm
  // package but didn't re-run init --rumen, the Edge Function is pinned to
  // whatever rumen version was current at last deploy.
  //
  // probeKind 'edgeFunctionPin':
  //   - Downloads deployed Edge Function body via Management API.
  //   - Greps the npm:<pkg>@<version> import line.
  //   - Compares against the EXPECTED version. Two resolution shapes:
  //     - 'npmRegistry': run `npm view <pkg> version` (used when bundled
  //       source has a __RUMEN_VERSION__-style placeholder substituted at
  //       deploy time).
  //     - 'bundledSource': read bundled file, grep same npm:<pkg>@<version>
  //       (used when bundled source pins a static version verbatim).
  //   - On drift: returns absent → goes to skipped[] with a recommendation
  //     pointing at `termdeck init --rumen --yes`.
  //   - On unreachable Management API / npm view failure: skipped with the
  //     fail-soft reason (mirrors functionSource probe degradation pattern).
  //
  // YELLOW (skipped[]) is the right severity — pin drift is non-blocking
  // for the wizard and non-blocking for any single Rumen tick. It just
  // means stale runtime. The user-actionable fix is `init --rumen --yes`.
  {
    name: 'rumen-tick deployed pin matches current @jhizzard/rumen',
    kind: 'rumen',
    probeKind: 'edgeFunctionPin',
    functionSlug: 'rumen-tick',
    importPattern: /npm:@jhizzard\/rumen@(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/,
    expectedFrom: 'npmRegistry',
    npmRegistryPkg: '@jhizzard/rumen'
  },
  {
    name: 'graph-inference deployed pin matches bundled postgres',
    kind: 'rumen',
    probeKind: 'edgeFunctionPin',
    functionSlug: 'graph-inference',
    importPattern: /npm:postgres@(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/,
    expectedFrom: 'bundledSource',
    bundledPath: 'packages/server/src/setup/rumen/functions/graph-inference/index.ts'
  }
]);

// Find the bundled migration file for a probe target. Returns the absolute
// path or null. `mnestra` looks under bundled mnestra-migrations; `rumen`
// looks under bundled rumen/migrations. Both kinds prefer the bundled copy
// (matches the listMnestraMigrations / listRumenMigrations convention from
// v0.6.8 — bundled FIRST, then the @jhizzard/<pkg> node_modules fallback).
function resolveMigrationFile(target, files) {
  const wanted = target.migrationFile;
  return files.find((f) => path.basename(f) === wanted) || null;
}

// Sprint 51.6 T3 — Bug D: Edge Function source-drift detection.
//
// Fetches the deployed Edge Function body from Supabase Management API and
// looks for a marker string the bundled source contains. Returns absent
// (with probeError) when the marker is missing — meaning the deployed
// function is older than the bundle and should be redeployed.
//
// Requires:
//   - projectRef passed through from auditUpgrade()
//   - SUPABASE_ACCESS_TOKEN in env (a personal access token, format `sbp_*`)
// Fail-soft when either is missing — recorded as probeError, treated as
// absent. The audit caller decides whether to surface to the user.
async function probeFunctionSource(target, { projectRef, fetchImpl }) {
  const fn = fetchImpl || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  if (typeof fn !== 'function') {
    return { present: false, probeError: 'no fetch implementation available' };
  }
  if (!projectRef) {
    return { present: false, probeError: 'projectRef required for functionSource probe' };
  }
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) {
    return {
      present: false,
      probeError: 'SUPABASE_ACCESS_TOKEN not set; cannot fetch deployed function body. Set the personal access token (`supabase login` writes it to ~/.supabase/access-token) to enable function-source drift detection.',
    };
  }
  let res;
  try {
    res = await fn(
      `https://api.supabase.com/v1/projects/${projectRef}/functions/${target.functionSlug}/body`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
  } catch (err) {
    return { present: false, probeError: `Management API fetch failed: ${err.message}` };
  }
  if (!res.ok) {
    return {
      present: false,
      probeError: `Management API returned HTTP ${res.status} for ${target.functionSlug}/body — function may not be deployed yet, or access token lacks permission.`
    };
  }
  let body;
  try { body = await res.text(); }
  catch (err) { return { present: false, probeError: `body decode failed: ${err.message}` }; }

  if (target.requiredMarker && body.includes(target.requiredMarker)) {
    return { present: true };
  }
  return {
    present: false,
    probeError: `deployed ${target.functionSlug} source missing marker (${JSON.stringify(target.requiredMarker)}) — re-run \`termdeck init --rumen\` to redeploy from bundled source.`,
  };
}

// Sprint 52 — Class O: deployed-state pin drift between npm-published
// packages and Supabase-deployed Edge Functions.
//
// Probes one Edge Function for npm:<pkg>@<version> drift between the
// deployed body and the EXPECTED version. Returns:
//   - { present: true } when deployed pin == expected pin (no drift)
//   - { present: false, probeError: '<recommendation>' } when drift is
//     detected — caller routes to skipped[] (YELLOW, non-blocking).
//   - { present: false, probeError: '<reason>' } when probe can't run
//     (no fetch impl, no token, Management API HTTP error, npm view
//     failure, deployed body doesn't match the importPattern).
//
// Required ctx:
//   - projectRef: passed through from auditUpgrade()
//   - SUPABASE_ACCESS_TOKEN in env (sbp_*) — same as functionSource probe
// Optional ctx:
//   - fetchImpl: test injection for HTTP. Defaults to globalThis.fetch.
//   - npmViewImpl: test injection for `npm view <pkg> version`. Defaults
//     to a real spawnSync('npm', ['view', pkg, 'version']). Returns
//     { ok, version, error }.
//   - readFileImpl: test injection for bundled-source reads. Defaults to
//     fs.readFileSync(absPath, 'utf-8').
//   - repoRoot: optional — used to resolve target.bundledPath. Defaults to
//     packages/server/src/setup/.. relative resolution (3 levels up from
//     this file is the repo root).
async function probeEdgeFunctionPin(target, ctx = {}) {
  const fn = ctx.fetchImpl || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  if (typeof fn !== 'function') {
    return { present: false, probeError: 'no fetch implementation available' };
  }
  if (!ctx.projectRef) {
    return { present: false, probeError: 'projectRef required for edgeFunctionPin probe' };
  }
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) {
    return {
      present: false,
      probeError: 'SUPABASE_ACCESS_TOKEN not set; cannot fetch deployed function body. Set the personal access token (`supabase login` writes it to ~/.supabase/access-token) to enable Edge Function pin-drift detection.'
    };
  }

  // Resolve EXPECTED version first — if this fails we can short-circuit
  // before the Management API round trip.
  let expected;
  if (target.expectedFrom === 'npmRegistry') {
    if (!target.npmRegistryPkg) {
      return { present: false, probeError: `edgeFunctionPin probe ${target.name} missing npmRegistryPkg` };
    }
    const npmView = ctx.npmViewImpl || defaultNpmViewVersion;
    let r;
    try { r = await npmView(target.npmRegistryPkg); }
    catch (err) { return { present: false, probeError: `npm view ${target.npmRegistryPkg} failed: ${err.message}` }; }
    if (!r || !r.ok) {
      return {
        present: false,
        probeError: `npm view ${target.npmRegistryPkg} version failed: ${r && r.error ? r.error : 'unknown error'}`
      };
    }
    expected = r.version;
  } else if (target.expectedFrom === 'bundledSource') {
    if (!target.bundledPath || !target.importPattern) {
      return { present: false, probeError: `edgeFunctionPin probe ${target.name} missing bundledPath or importPattern` };
    }
    // __dirname = .../packages/server/src/setup/. Four `..` lands at repo
    // root: setup → src → server → packages → <repoRoot>. Sprint 52 shipped
    // five `..` (off-by-one), which on a globally-installed @jhizzard/termdeck
    // resolved to the parent of the package dir and the bundled-source read
    // fail-softed into skipped[] with an ENOENT reason instead of comparing
    // pins. v1.0.8 fold-in.
    const repoRoot = ctx.repoRoot || path.resolve(__dirname, '..', '..', '..', '..');
    const bundledAbs = path.isAbsolute(target.bundledPath)
      ? target.bundledPath
      : path.join(repoRoot, target.bundledPath);
    const readImpl = ctx.readFileImpl || ((p) => fs.readFileSync(p, 'utf-8'));
    let bundledBody;
    try { bundledBody = readImpl(bundledAbs); }
    catch (err) { return { present: false, probeError: `bundled source read failed at ${bundledAbs}: ${err.message}` }; }
    const m = bundledBody.match(target.importPattern);
    if (!m) {
      return { present: false, probeError: `bundled source at ${target.bundledPath} does not contain ${target.importPattern} — has the import been removed or renamed?` };
    }
    expected = m[1];
  } else {
    return { present: false, probeError: `edgeFunctionPin probe ${target.name} has unknown expectedFrom: ${target.expectedFrom}` };
  }

  // Fetch deployed body via Management API.
  let res;
  try {
    res = await fn(
      `https://api.supabase.com/v1/projects/${ctx.projectRef}/functions/${target.functionSlug}/body`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
  } catch (err) {
    return { present: false, probeError: `Management API fetch failed: ${err.message}` };
  }
  if (!res.ok) {
    return {
      present: false,
      probeError: `Management API returned HTTP ${res.status} for ${target.functionSlug}/body — function may not be deployed yet, or access token lacks permission.`
    };
  }
  let body;
  try { body = await res.text(); }
  catch (err) { return { present: false, probeError: `body decode failed: ${err.message}` }; }

  const m = body.match(target.importPattern);
  if (!m) {
    return {
      present: false,
      probeError: `deployed ${target.functionSlug} body does not match ${target.importPattern} — function may be at an unexpected source revision; re-run \`termdeck init --rumen --yes\` to redeploy from bundled.`
    };
  }
  const deployed = m[1];
  if (deployed === expected) {
    return { present: true };
  }
  return {
    present: false,
    probeError: `pin drift on ${target.functionSlug}: deployed=${deployed}, expected=${expected}. Run \`termdeck init --rumen --yes\` to redeploy from current.`
  };
}

// Default `npm view <pkg> version` shellout. Returns { ok, version, error }.
// Synchronous spawnSync with 15s timeout — same shape as init-rumen.js
// resolveRumenVersion helper. Wrapped in a thenable so the probe can await.
function defaultNpmViewVersion(pkg) {
  return Promise.resolve().then(() => {
    const r = spawnSync('npm', ['view', pkg, 'version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000
    });
    if (r.status === 0) {
      const v = (r.stdout || '').trim();
      if (/^\d+\.\d+\.\d+/.test(v)) return { ok: true, version: v };
      return { ok: false, error: `unexpected output: ${JSON.stringify(v)}` };
    }
    const stderr = (r.stderr || '').trim();
    return {
      ok: false,
      error: stderr ? stderr.split('\n').pop() : `exit ${r.status === null ? 'timeout' : r.status} — offline?`
    };
  });
}

// Run a probe and decide present/absent based on the probe's contract.
// Sprint 51.6 T3: dispatches by target.probeKind. Default is the legacy
// pgClient.query path; 'functionSource' calls probeFunctionSource (HTTP).
// Sprint 52 (Class O): 'edgeFunctionPin' calls probeEdgeFunctionPin (HTTP
// + npm view / bundled-source resolution).
async function probeOne(pgClient, target, ctx = {}) {
  if (target.probeKind === 'functionSource') {
    return probeFunctionSource(target, ctx);
  }
  if (target.probeKind === 'edgeFunctionPin') {
    return probeEdgeFunctionPin(target, ctx);
  }
  let result;
  try {
    result = await pgClient.query(target.probeSql);
  } catch (err) {
    // A probe failure (e.g., schema doesn't exist yet — `cron.job` on a
    // project without pg_cron) means the artifact is absent. Record the
    // raw error so a caller can distinguish "absent because never installed"
    // from "absent because we can't even check." Either way the right
    // response is to attempt apply — which will surface the real error
    // (e.g., "extension pg_cron is not installed") with full context.
    return { present: false, probeError: err.message };
  }
  const rows = (result && result.rows) || [];
  if (target.presentWhen === 'rowReturned') {
    return { present: rows.length > 0 };
  }
  if (target.presentWhen === 'boolColumnTrue') {
    return { present: Boolean(rows[0] && rows[0].present === true) };
  }
  // Defensive default: any returned row counts as present.
  return { present: rows.length > 0 };
}

// Apply a single migration file. Templated migrations route through
// applyTemplating() so the cron schedule body never sees the raw
// `<project-ref>` placeholder. Brad 2026-05-03 takeaway #5 (bonus): the
// fresh-install path at init-rumen.js:472-505 already does this; the
// audit-upgrade path MUST mirror it. Tests in audit-upgrade.test.js guard
// against future bypass.
async function applyOne(pgClient, target, files, { projectRef, readFileImpl }) {
  const file = resolveMigrationFile(target, files);
  if (!file) {
    throw new Error(
      `audit-upgrade: bundled migration file not found for ${target.name} ` +
      `(expected ${target.migrationFile}). The bundled migration set may be ` +
      `out of sync — re-publish the package or run scripts/sync-rumen-functions.sh.`
    );
  }
  const raw = readFileImpl(file);
  const sql = target.templated
    ? applyTemplating(raw, { projectRef })
    : raw;
  await pgClient.query(sql);
  return { file: path.basename(file) };
}

// Public API.
//
// Inputs:
//   pgClient    — open node-postgres Client (caller owns the lifecycle).
//   projectRef  — required when any templated migration is in the probe set
//                 (i.e., the rumen cron schedules). The applyTemplating
//                 helper will throw if it sees a `<project-ref>` placeholder
//                 and projectRef is missing — surfaced via errors[].
//   dryRun      — when true, probes only; skips apply. applied stays empty.
//   probes      — optional override for the probe set (test injection point).
//                 Defaults to PROBES.
//   _migrations — optional override for the migrations module (test
//                 injection). Lets tests stub listMnestraMigrations /
//                 listRumenMigrations / readFile.
//
// Returns:
//   {
//     probed:  string[]   — every target name we tried to probe
//     present: string[]   — targets whose probe came back present
//     missing: string[]   — targets whose probe came back absent
//     applied: string[]   — targets the audit applied this run
//                            (empty when dryRun=true)
//     skipped: string[]   — targets we couldn't apply (e.g., missing
//                            projectRef on a templated migration)
//     errors:  Array<{ name, error }> — apply or probe errors (probe errors
//                                       only surface here when subsequent
//                                       apply ALSO fails)
//   }
//
// Idempotent: a second run reports `applied=[]` because every probe will
// come back present. All shipped migrations are themselves idempotent
// (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
// cron.unschedule + cron.schedule, GRANT … TO service_role).
async function auditUpgrade({
  pgClient,
  projectRef,
  dryRun = false,
  probes,
  _migrations,
  _fetch,
  _npmView,
  _readFile,
  _repoRoot
} = {}) {
  if (!pgClient || typeof pgClient.query !== 'function') {
    throw new Error('auditUpgrade: pgClient with .query() is required');
  }
  const targets = probes || PROBES;
  const mig = _migrations || migrations;

  // Resolve once: the bundled migration sets stay constant for the duration
  // of a single audit run.
  const mnestraFiles = mig.listMnestraMigrations();
  const rumenFiles = mig.listRumenMigrations();

  const probed = [];
  const present = [];
  const missing = [];
  const applied = [];
  const skipped = [];
  const errors = [];

  for (const target of targets) {
    probed.push(target.name);
    const probeResult = await probeOne(pgClient, target, {
      projectRef,
      fetchImpl: _fetch,
      npmViewImpl: _npmView,
      readFileImpl: _readFile,
      repoRoot: _repoRoot
    });
    if (probeResult.present) {
      present.push(target.name);
      continue;
    }

    // Sprint 51.6 T3 — Bug D: functionSource probes go to skipped[] (not
    // missing[]). The corresponding fix is a re-run of `init --rumen` which
    // calls deployFunctions; audit-upgrade does not auto-redeploy.
    // Sprint 52 — Class O: same treatment for edgeFunctionPin probes —
    // pin drift is non-blocking (YELLOW), recommendation in skipped reason.
    if (target.probeKind === 'functionSource' || target.probeKind === 'edgeFunctionPin') {
      const fallbackReason = target.probeKind === 'edgeFunctionPin'
        ? 'pin drift — redeploy via init --rumen'
        : 'function source drift — redeploy via init --rumen';
      skipped.push({
        name: target.name,
        reason: probeResult.probeError || fallbackReason,
      });
      continue;
    }

    missing.push(target.name);

    if (dryRun) continue;

    const files = target.kind === 'rumen' ? rumenFiles : mnestraFiles;

    try {
      await applyOne(pgClient, target, files, {
        projectRef,
        readFileImpl: mig.readFile
      });
      applied.push(target.name);
    } catch (err) {
      // Surface but don't abort. One missing artifact failing to apply (e.g.,
      // pg_cron extension not enabled) shouldn't block the rest of the audit
      // from running. The wizard will report the whole audit summary at the
      // end so the user can address each failure individually.
      errors.push({
        name: target.name,
        error: err && err.message ? err.message : String(err)
      });
    }
  }

  // skipped[] reserved for v1.0.2: targets the audit deliberately doesn't
  // attempt (e.g., when projectRef is missing for a templated migration we
  // currently let applyTemplating throw → errors[]; future versions may
  // pre-skip those into skipped[]).
  return { probed, present, missing, applied, skipped, errors };
}

module.exports = {
  auditUpgrade,
  PROBES,
  // Test surface — kept exported so audit-upgrade.test.js can pin probe
  // selection / apply pathway behavior without needing a live pg client.
  _probeOne: probeOne,
  _probeFunctionSource: probeFunctionSource,
  _probeEdgeFunctionPin: probeEdgeFunctionPin,
  _applyOne: applyOne,
  _resolveMigrationFile: resolveMigrationFile
};
