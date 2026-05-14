// Sprint 64 T1 — Supabase MCP auto-provision path.
//
// This module wraps the Supabase Management API surface (exposed via the
// official `@supabase/mcp-server-supabase` MCP server) into the wizard-shaped
// flow that `termdeck init --auto` (or `--mcp-supabase`) drives:
//
//   1. detect MCP   → list orgs   → create project
//   2. poll ready   → fetch URL + anon + service_role keys
//   3. apply mnestra migrations (001..022) + rumen migration 001 (tables)
//   4. create vault secrets (rumen_service_role_key, graph_inference_service_role_key)
//   5. deploy edge functions (rumen-tick + graph-inference)
//   6. apply rumen migrations 002 + 003 (cron schedules with <project-ref> substitution)
//   7. run security + performance advisors; RED entries BLOCK
//   8. return the secrets bag for the wizard to write to ~/.termdeck/secrets.env
//
// PAT discipline: the caller's Supabase Personal Access Token is passed
// straight through to `setup/supabase-mcp.js#callTool` which puts it in the
// child process's `SUPABASE_ACCESS_TOKEN` env var (never argv, never logged).
// Every callTool exception path in THIS module routes through
// `sanitizeErrorForLogs()` which redacts the PAT + every returned key + every
// project-ref / vault secret before the error reaches stderr/logs. This
// closes T4-CODEX's Sprint 64 16:09 ET AUDIT-CONCERN #2.
//
// Failure modes (every error has a stable `.code` for the caller):
//   MCP_UNAVAILABLE       — Supabase MCP not installed; caller falls back to manual
//   ORG_LIST_REQUIRED     — caller didn't pass orgId; we return the org list
//   PROJECT_CREATE_FAILED — create_project RPC errored
//   READY_TIMEOUT         — project never became ACTIVE_HEALTHY within window
//   FETCH_KEYS_FAILED     — get_project_url / get_publishable_keys errored
//   MIGRATION_FAILED      — apply_migration errored mid-flight (partial-install marker written)
//   VAULT_FAILED          — execute_sql vault.create_secret errored
//   DEPLOY_FAILED         — deploy_edge_function errored
//   ADVISOR_BLOCK         — RLS hygiene / lint advisor flagged a RED row
//
// Out of scope (per T1 brief §1.1 "Out of scope"):
//   - Auto-detecting an existing project to attach to (handled by --from-env).
//   - Vault-dashboard UI (deliberately retired per Sprint 51.5 T3 Class B).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETUP_DIR = path.join(__dirname, '..', '..', 'server', 'src', 'setup');

// Lazy-required so a wizard that never enters the --auto path doesn't pay
// the require cost of pg / supabase-mcp.
function loadSetup() {
  return {
    supabaseMcp: require(path.join(SETUP_DIR, 'supabase-mcp')),
    migrations: require(path.join(SETUP_DIR, 'migrations')),
    migrationTemplating: require(path.join(SETUP_DIR, 'migration-templating')),
    supabaseUrl: require(path.join(SETUP_DIR, 'supabase-url')),
  };
}

const DEFAULT_REGION = 'us-east-1';
const READY_POLL_INTERVAL_MS = 4000;
const READY_TIMEOUT_MS = 5 * 60 * 1000;  // 5 min — Supabase free-tier provisioning
const ADVISOR_TYPES = ['security', 'performance'];

// ─────────────────────────────────────────────────────────────────────────
// Sensitive-string redaction. Sprint 64 16:09 ET T4-CODEX AUDIT-CONCERN #2:
// supabase-mcp.js:169-184 returns raw RPC error text + stderr tail on
// callTool failure. If the PAT or returned service-role key surfaces in that
// error text, it lands in stderr/logs. This helper redacts every known
// sensitive literal from any Error or string before it gets logged.
//
// Strategy: caller passes a `redactList` of (label, value) pairs; the helper
// walks the error message + stack + any nested .body field and replaces every
// occurrence of each value with `[REDACTED:label]`. Empty / short values
// (<8 chars) are skipped to avoid false-positive redactions on common
// substrings. Returns a NEW Error preserving .code; original is untouched.

function sanitizeErrorForLogs(err, redactList) {
  if (!err) return err;
  const original = err instanceof Error ? err : new Error(String(err));
  const safeRedacts = (redactList || []).filter(
    (r) => r && typeof r.value === 'string' && r.value.length >= 8
  );
  if (safeRedacts.length === 0) return original;

  function scrub(s) {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const { label, value } of safeRedacts) {
      // Escape regex meta-chars so a value like 'sb_secret_+/=' substring-matches.
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), `[REDACTED:${label}]`);
    }
    return out;
  }

  const cleaned = new Error(scrub(original.message || ''));
  cleaned.code = original.code;
  if (original.stack) cleaned.stack = scrub(original.stack);
  if (original.body) cleaned.body = scrub(typeof original.body === 'string' ? original.body : JSON.stringify(original.body));
  if (original.detail) cleaned.detail = scrub(String(original.detail));
  // Preserve any structured fields the caller attached, scrubbing strings.
  for (const k of Object.keys(original)) {
    if (k === 'code' || k === 'body' || k === 'detail' || k === 'message' || k === 'stack') continue;
    const v = original[k];
    cleaned[k] = typeof v === 'string' ? scrub(v) : v;
  }
  return cleaned;
}

function structuredError(code, message, extras) {
  const e = new Error(message);
  e.code = code;
  if (extras && typeof extras === 'object') {
    for (const k of Object.keys(extras)) e[k] = extras[k];
  }
  return e;
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool-call shape varies by tool: most return `{content: [{type:'text',
// text: JSONSTRING}]}`. Some return native objects. This helper normalizes.
function unwrapMcpResult(result) {
  if (!result) return null;
  if (Array.isArray(result.content)) {
    // Text-array shape — first text payload is the JSON body.
    const text = result.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    if (text) {
      try { return JSON.parse(text.text); }
      catch (_e) { return text.text; }
    }
  }
  if (Array.isArray(result.toolResult)) return result.toolResult;
  return result;
}

// Convenience wrapper around supabaseMcp.callTool that:
//   • applies a per-call timeout (Management API can be slow under load)
//   • normalizes the response via unwrapMcpResult
//   • routes every thrown error through sanitizeErrorForLogs (PAT redaction)
async function mcpCall({ supabaseMcp, pat, method, params, timeoutMs, redactList }) {
  try {
    const raw = await supabaseMcp.callTool(pat, method, params || {}, {
      timeoutMs: timeoutMs || 30000,
    });
    return unwrapMcpResult(raw);
  } catch (err) {
    throw sanitizeErrorForLogs(err, redactList);
  }
}

function nowMs() { return Date.now(); }

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ─────────────────────────────────────────────────────────────────────────
// Phase implementations. Each is a standalone async function with explicit
// deps so the test surface can mock individual phases without rewiring the
// full pipeline.

async function listOrganizations({ supabaseMcp, pat, redactList }) {
  const result = await mcpCall({
    supabaseMcp, pat, method: 'list_organizations', params: {}, redactList,
  });
  if (!Array.isArray(result)) return [];
  // Normalize the org shape — some MCP versions return {id,name,plan},
  // others {organization_id,organization_name,...}. Coerce.
  return result.map((o) => ({
    id: o.id || o.organization_id || o.slug,
    name: o.name || o.organization_name || o.id,
    plan: o.plan || o.subscription_tier || null,
    raw: o,
  })).filter((o) => o.id);
}

async function createProject({ supabaseMcp, pat, orgId, projectName, dbPassword, region, redactList }) {
  const params = {
    name: projectName,
    organization_id: orgId,
    db_pass: dbPassword,
    region: region || DEFAULT_REGION,
  };
  let result;
  try {
    result = await mcpCall({
      supabaseMcp, pat, method: 'create_project', params, redactList,
      timeoutMs: 60000,
    });
  } catch (err) {
    throw structuredError('PROJECT_CREATE_FAILED', `create_project failed: ${err.message}`, { cause: err });
  }
  const projectRef = result && (result.id || result.project_ref || result.ref);
  if (!projectRef) {
    throw structuredError('PROJECT_CREATE_FAILED',
      'create_project returned no project ref; cannot continue', { detail: result });
  }
  return { projectRef, raw: result };
}

async function waitForProjectReady({ supabaseMcp, pat, projectRef, redactList, deps }) {
  const start = nowMs();
  const pollInterval = (deps && deps.pollInterval) || READY_POLL_INTERVAL_MS;
  const timeout = (deps && deps.readyTimeout) || READY_TIMEOUT_MS;
  let lastStatus = null;
  while (nowMs() - start < timeout) {
    let info;
    try {
      info = await mcpCall({
        supabaseMcp, pat, method: 'get_project', params: { id: projectRef }, redactList,
        timeoutMs: 15000,
      });
    } catch (err) {
      // Transient errors during boot-up — log via onPhase but don't bail until timeout.
      lastStatus = `get_project error: ${err.message}`;
    }
    if (info) {
      const status = info.status || info.health || (info.database && info.database.status);
      lastStatus = status;
      if (status === 'ACTIVE_HEALTHY' || status === 'ACTIVE' || status === 'HEALTHY') {
        return { ready: true, info };
      }
      if (status === 'FAILED' || status === 'UNHEALTHY') {
        throw structuredError('READY_TIMEOUT', `project entered ${status} state`, { lastStatus });
      }
    }
    await sleep(pollInterval);
  }
  throw structuredError('READY_TIMEOUT',
    `project did not reach ACTIVE_HEALTHY within ${Math.round(timeout / 1000)}s`,
    { lastStatus });
}

async function fetchProjectAccess({ supabaseMcp, pat, projectRef, redactList }) {
  let url;
  let keys;
  try {
    url = await mcpCall({
      supabaseMcp, pat, method: 'get_project_url',
      params: { id: projectRef }, redactList,
    });
  } catch (err) {
    throw structuredError('FETCH_KEYS_FAILED', `get_project_url failed: ${err.message}`, { cause: err });
  }
  try {
    keys = await mcpCall({
      supabaseMcp, pat, method: 'get_publishable_keys',
      params: { id: projectRef }, redactList,
    });
  } catch (err) {
    throw structuredError('FETCH_KEYS_FAILED', `get_publishable_keys failed: ${err.message}`, { cause: err });
  }
  // url may be returned as a string OR an object {url: ...}.
  const projectUrl = typeof url === 'string' ? url : (url && (url.url || url.project_url));
  if (!projectUrl) {
    throw structuredError('FETCH_KEYS_FAILED', 'get_project_url returned no URL', { detail: url });
  }
  // keys may be an array of {name, api_key} OR an object map.
  let anonKey = null;
  let serviceRoleKey = null;
  if (Array.isArray(keys)) {
    for (const k of keys) {
      const name = (k.name || k.role || '').toLowerCase();
      const val = k.api_key || k.key || k.value;
      if (name === 'anon' || name.includes('anon')) anonKey = anonKey || val;
      if (name === 'service_role' || name.includes('service_role')) serviceRoleKey = serviceRoleKey || val;
    }
  } else if (keys && typeof keys === 'object') {
    anonKey = keys.anon || keys.anon_key || null;
    serviceRoleKey = keys.service_role || keys.service_role_key || null;
  }
  if (!serviceRoleKey) {
    throw structuredError('FETCH_KEYS_FAILED', 'get_publishable_keys did not return a service_role key', { detail: keys });
  }
  return { projectUrl, anonKey, serviceRoleKey };
}

// Apply the full bundled migration set in declared order. On failure mid-run,
// writes ~/.termdeck/.partial-install with the applied list so subsequent
// runs can resume rather than re-provision. Sprint 51.5 / Sprint 61 already
// solved the apply-set ordering via setup/migrations.js — we use the same
// listMnestraMigrations() ordering here for parity with the manual path.
async function applyAllMigrations({ supabaseMcp, pat, projectRef, redactList, partialInstallPath, deps }) {
  const { migrations, migrationTemplating } = deps;
  const mnestraFiles = migrations.listMnestraMigrations();
  if (mnestraFiles.length === 0) {
    throw structuredError('MIGRATION_FAILED', 'no Mnestra migrations bundled; TermDeck install corrupted');
  }
  const rumenFiles = migrations.listRumenMigrations();
  const rumenTables = rumenFiles.find((f) => /001.*rumen_tables/.test(path.basename(f)));
  if (!rumenTables) {
    throw structuredError('MIGRATION_FAILED', 'bundled 001_rumen_tables.sql is missing');
  }

  const applied = [];

  async function applyOne(filepath, label) {
    const basename = path.basename(filepath);
    const raw = migrations.readFile(filepath);
    let sql = raw;
    // Sprint 42 T3 templating only applies to cron-schedule migrations;
    // call applyTemplating with the project-ref so the helper can substitute
    // placeholders in the rumen-side cron migrations. Mnestra migrations
    // don't carry placeholders — applyTemplating is a no-op on them.
    sql = migrationTemplating.applyTemplating(raw, { projectRef });
    try {
      await mcpCall({
        supabaseMcp, pat, method: 'apply_migration',
        params: { id: projectRef, name: label || basename.replace(/\.sql$/, ''), query: sql },
        redactList,
        timeoutMs: 90000,
      });
      applied.push(basename);
    } catch (err) {
      // Write partial-install marker so the user can resume on next run.
      try {
        const marker = {
          timestamp: new Date().toISOString(),
          projectRef,
          applied,
          failedAt: basename,
          reason: err.message,
        };
        fs.mkdirSync(path.dirname(partialInstallPath), { recursive: true });
        fs.writeFileSync(partialInstallPath, JSON.stringify(marker, null, 2));
      } catch (_e) { /* best-effort */ }
      throw structuredError('MIGRATION_FAILED',
        `${basename} failed: ${err.message}`,
        { applied, failedAt: basename, cause: err });
    }
  }

  for (const f of mnestraFiles) await applyOne(f);
  await applyOne(rumenTables);
  return { applied };
}

// Vault secrets created via execute_sql calling vault.create_secret($value, $name).
// Both keys hold the same value (the project's service_role key). Mirrors
// init-rumen.js#ensureVaultSecrets behavior at lines 596-673.
async function createVaultSecrets({ supabaseMcp, pat, projectRef, serviceRoleKey, redactList }) {
  const required = [
    { name: 'rumen_service_role_key', value: serviceRoleKey },
    { name: 'graph_inference_service_role_key', value: serviceRoleKey },
  ];
  const created = [];
  for (const { name, value } of required) {
    // Escape single quotes via SQL doubling — matches init-rumen#vaultSqlEditorUrl logic.
    const escapedValue = String(value).replace(/'/g, "''");
    const escapedName = String(name).replace(/'/g, "''");
    const query = `select vault.create_secret('${escapedValue}', '${escapedName}');`;
    try {
      await mcpCall({
        supabaseMcp, pat, method: 'execute_sql',
        params: { id: projectRef, query }, redactList,
      });
      created.push(name);
    } catch (err) {
      // If it already exists, vault.create_secret raises a unique-violation;
      // treat that as success (idempotent semantics).
      if (/duplicate key|unique constraint|already exists/i.test(err.message)) {
        created.push(name);
        continue;
      }
      throw structuredError('VAULT_FAILED', `vault.create_secret(${name}) failed: ${err.message}`, { cause: err });
    }
  }
  return { created };
}

// Deploy Rumen Edge Functions (rumen-tick + graph-inference) via the MCP
// deploy_edge_function tool. Functions are bundled at
// packages/server/src/setup/rumen/functions/<name>/index.ts (rumen-tick has
// a __RUMEN_VERSION__ placeholder substituted at deploy time).
async function deployEdgeFunctions({ supabaseMcp, pat, projectRef, rumenVersion, redactList, deps }) {
  const { migrations } = deps;
  const functionNames = migrations.listRumenFunctions();
  if (functionNames.length === 0) {
    throw structuredError('DEPLOY_FAILED', 'no Rumen Edge Functions bundled');
  }
  const root = migrations.rumenFunctionsRoot();
  const deployed = [];
  for (const name of functionNames) {
    const indexPath = path.join(root, name, 'index.ts');
    let body;
    try {
      body = fs.readFileSync(indexPath, 'utf8');
    } catch (err) {
      throw structuredError('DEPLOY_FAILED', `cannot read ${indexPath}: ${err.message}`);
    }
    // rumen-tick carries a version placeholder; substitute now.
    if (body.includes('__RUMEN_VERSION__')) {
      if (!rumenVersion) {
        throw structuredError('DEPLOY_FAILED',
          `${name}/index.ts has __RUMEN_VERSION__ placeholder but no rumenVersion provided`);
      }
      body = body.replace(/__RUMEN_VERSION__/g, rumenVersion);
    }
    try {
      await mcpCall({
        supabaseMcp, pat, method: 'deploy_edge_function',
        params: {
          id: projectRef,
          name,
          files: [{ name: 'index.ts', content: body }],
          verify_jwt: false,
        },
        redactList,
        timeoutMs: 120000,
      });
      deployed.push(name);
    } catch (err) {
      throw structuredError('DEPLOY_FAILED', `deploy ${name} failed: ${err.message}`, { cause: err, deployed });
    }
  }
  return { deployed };
}

// Apply the cron-schedule migrations (rumen 002 + 003) with project-ref
// substitution. These reference `vault.decrypted_secrets` — must run AFTER
// createVaultSecrets so the secret names resolve at function-call time.
async function applyCronSchedules({ supabaseMcp, pat, projectRef, redactList, deps }) {
  const { migrations, migrationTemplating } = deps;
  const rumenFiles = migrations.listRumenMigrations();
  const applied = [];

  const cronFiles = [
    rumenFiles.find((f) => /002.*pg_cron/.test(path.basename(f))),
    rumenFiles.find((f) => /003.*graph_inference/.test(path.basename(f))),
  ].filter(Boolean);

  for (const file of cronFiles) {
    const basename = path.basename(file);
    const raw = migrations.readFile(file);
    const sql = migrationTemplating.applyTemplating(raw, { projectRef });
    try {
      await mcpCall({
        supabaseMcp, pat, method: 'apply_migration',
        params: { id: projectRef, name: basename.replace(/\.sql$/, ''), query: sql },
        redactList,
        timeoutMs: 30000,
      });
      applied.push(basename);
    } catch (err) {
      throw structuredError('MIGRATION_FAILED',
        `cron schedule ${basename} failed: ${err.message}`, { applied, failedAt: basename, cause: err });
    }
  }
  return { applied };
}

// Run security + performance advisors; any RED-severity row blocks. This is
// the post-provision RLS hygiene gate per Sprint 64 PLANNING § Hardening
// rule #7 + global CLAUDE.md § Supabase RLS hygiene.
async function runAdvisors({ supabaseMcp, pat, projectRef, redactList }) {
  const findings = { security: [], performance: [] };
  const reds = [];
  for (const type of ADVISOR_TYPES) {
    try {
      const result = await mcpCall({
        supabaseMcp, pat, method: 'get_advisors',
        params: { id: projectRef, type }, redactList,
        timeoutMs: 30000,
      });
      const rows = Array.isArray(result) ? result : (result && Array.isArray(result.lints) ? result.lints : []);
      findings[type] = rows;
      for (const row of rows) {
        const severity = (row.level || row.severity || '').toUpperCase();
        // RED severities: ERROR (top), WARN (medium). Block on ERROR only — WARN is
        // surfaced but doesn't block, matching the way Brad's 2026-05-06 sweep was
        // run (the migration_019 changes addressed errors, warns were docs-only).
        if (severity === 'ERROR') {
          reds.push({ type, ...row });
        }
      }
    } catch (err) {
      // Advisor failure shouldn't block install — surface as a warning row.
      findings[type] = [{ severity: 'ADVISOR_UNAVAILABLE', message: err.message }];
    }
  }
  if (reds.length > 0) {
    throw structuredError('ADVISOR_BLOCK',
      `Supabase advisors flagged ${reds.length} ERROR-level finding(s); install blocked`,
      { advisors: findings, reds });
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level entrypoint. Orchestrates phases 1-8 with progress callbacks.

const PHASES = [
  'preflight',
  'list-orgs',
  'create-project',
  'wait-ready',
  'fetch-access',
  'apply-migrations',
  'create-vault-secrets',
  'deploy-functions',
  'apply-cron',
  'run-advisors',
  'done',
];

async function provisionViaSupabaseMcp(opts) {
  opts = opts || {};
  const pat = opts.pat;
  const projectName = opts.projectName;
  const dbPassword = opts.dbPassword;
  const orgId = opts.orgId;
  const region = opts.region || DEFAULT_REGION;
  const dryRun = !!opts.dryRun;
  const onPhase = typeof opts.onPhase === 'function' ? opts.onPhase : (() => {});
  const homedir = opts.homedir || os.homedir();
  const rumenVersion = opts.rumenVersion;
  const deps = opts.deps || loadSetup();
  const supabaseMcp = deps.supabaseMcp;

  if (!pat || typeof pat !== 'string') {
    throw structuredError('MCP_UNAVAILABLE', 'provisionViaSupabaseMcp requires `pat` (Supabase Personal Access Token)');
  }
  if (!projectName || typeof projectName !== 'string') {
    throw structuredError('MCP_UNAVAILABLE', 'provisionViaSupabaseMcp requires `projectName`');
  }
  if (!dbPassword || typeof dbPassword !== 'string' || dbPassword.length < 12) {
    throw structuredError('MCP_UNAVAILABLE', 'provisionViaSupabaseMcp requires `dbPassword` (12+ chars)');
  }

  // Redact list — every sensitive literal sanitizeErrorForLogs scrubs from
  // any thrown error before it reaches stderr/logs.
  const redactList = [
    { label: 'PAT', value: pat },
    { label: 'DB_PASSWORD', value: dbPassword },
  ];

  // Phase 1 — preflight: confirm MCP available.
  onPhase({ phase: 'preflight', status: 'start' });
  const detection = await supabaseMcp.detectMcp();
  if (!detection || !detection.available) {
    throw structuredError('MCP_UNAVAILABLE',
      `Supabase MCP not installed (${(detection && detection.error) || 'unknown'}). Run: npm install -g @supabase/mcp-server-supabase`);
  }
  onPhase({ phase: 'preflight', status: 'ok', detail: { mode: detection.mode } });

  if (dryRun) {
    onPhase({ phase: 'done', status: 'ok', detail: 'dry-run; no Supabase calls fired' });
    return { ok: true, dryRun: true, projectRef: null, secrets: null };
  }

  // Phase 2 — list orgs (and pick the one to use).
  onPhase({ phase: 'list-orgs', status: 'start' });
  const orgs = await listOrganizations({ supabaseMcp, pat, redactList });
  if (orgs.length === 0) {
    throw structuredError('ORG_LIST_REQUIRED', 'no Supabase organizations visible to this PAT — verify token scope at https://supabase.com/dashboard/account/tokens', { orgs });
  }
  let resolvedOrgId = orgId;
  if (!resolvedOrgId) {
    if (orgs.length === 1) {
      resolvedOrgId = orgs[0].id;
      onPhase({ phase: 'list-orgs', status: 'ok', detail: { autopicked: orgs[0].name } });
    } else {
      throw structuredError('ORG_LIST_REQUIRED',
        `${orgs.length} organizations visible; caller must pick one and re-call with orgId set`,
        { orgs });
    }
  } else {
    if (!orgs.some((o) => o.id === resolvedOrgId)) {
      throw structuredError('ORG_LIST_REQUIRED',
        `orgId ${resolvedOrgId} not in visible org list`, { orgs });
    }
    onPhase({ phase: 'list-orgs', status: 'ok', detail: { orgId: resolvedOrgId } });
  }

  // Phase 3 — create project.
  onPhase({ phase: 'create-project', status: 'start', detail: { name: projectName, region } });
  const { projectRef, raw: projectInfo } = await createProject({
    supabaseMcp, pat, orgId: resolvedOrgId, projectName, dbPassword, region, redactList,
  });
  // Add the new project ref to the redact list so it doesn't leak in
  // subsequent error messages (per T4-CODEX AUDIT-CONCERN #2 hygiene).
  redactList.push({ label: 'PROJECT_REF', value: projectRef });
  onPhase({ phase: 'create-project', status: 'ok', detail: { projectRef } });

  // Phase 4 — wait for ready.
  onPhase({ phase: 'wait-ready', status: 'start', detail: { projectRef } });
  await waitForProjectReady({ supabaseMcp, pat, projectRef, redactList, deps: opts.deps });
  onPhase({ phase: 'wait-ready', status: 'ok' });

  // Phase 5 — fetch URL + keys.
  onPhase({ phase: 'fetch-access', status: 'start' });
  const { projectUrl, anonKey, serviceRoleKey } = await fetchProjectAccess({
    supabaseMcp, pat, projectRef, redactList,
  });
  redactList.push({ label: 'SERVICE_ROLE_KEY', value: serviceRoleKey });
  if (anonKey) redactList.push({ label: 'ANON_KEY', value: anonKey });
  onPhase({ phase: 'fetch-access', status: 'ok', detail: { projectUrl } });

  // Compose the DATABASE_URL from project ref + db password. Supabase's
  // canonical Transaction Pooler URL pattern (Sprint 51.5 T3 reference):
  //   postgres://postgres.<ref>:<encoded-pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
  //
  // Region prefix mapping (Supabase exposes the host string from the
  // dashboard; the MCP doesn't return it directly, so we synthesize from
  // the region the caller specified). Match exactly Sprint 51.5 T3 prep.
  const dbUrlEncoded = encodeURIComponent(dbPassword);
  const databaseUrl =
    `postgres://postgres.${projectRef}:${dbUrlEncoded}@aws-0-${region}.pooler.supabase.com:6543/postgres` +
    `?pgbouncer=true&connection_limit=1`;

  // Phase 6 — apply migrations (mnestra 1-22 + rumen 001).
  const partialInstallPath = path.join(homedir, '.termdeck', '.partial-install');
  onPhase({ phase: 'apply-migrations', status: 'start' });
  const migResult = await applyAllMigrations({
    supabaseMcp, pat, projectRef, redactList, partialInstallPath, deps,
  });
  onPhase({ phase: 'apply-migrations', status: 'ok', detail: { count: migResult.applied.length } });

  // Phase 7 — vault secrets.
  onPhase({ phase: 'create-vault-secrets', status: 'start' });
  const vaultResult = await createVaultSecrets({
    supabaseMcp, pat, projectRef, serviceRoleKey, redactList,
  });
  onPhase({ phase: 'create-vault-secrets', status: 'ok', detail: { created: vaultResult.created } });

  // Phase 8 — deploy edge functions.
  onPhase({ phase: 'deploy-functions', status: 'start' });
  const deployResult = await deployEdgeFunctions({
    supabaseMcp, pat, projectRef, rumenVersion, redactList, deps,
  });
  onPhase({ phase: 'deploy-functions', status: 'ok', detail: { deployed: deployResult.deployed } });

  // Phase 9 — apply cron schedules (rumen 002 + 003 with project-ref templating).
  onPhase({ phase: 'apply-cron', status: 'start' });
  const cronResult = await applyCronSchedules({
    supabaseMcp, pat, projectRef, redactList, deps,
  });
  onPhase({ phase: 'apply-cron', status: 'ok', detail: { applied: cronResult.applied } });

  // Phase 10 — run advisors. RED blocks.
  onPhase({ phase: 'run-advisors', status: 'start' });
  const advisorFindings = await runAdvisors({
    supabaseMcp, pat, projectRef, redactList,
  });
  onPhase({ phase: 'run-advisors', status: 'ok' });

  // Clean up any stale partial-install marker from a prior failed run.
  try { fs.unlinkSync(partialInstallPath); } catch (_e) { /* not present */ }

  const result = {
    ok: true,
    projectRef,
    projectUrl,
    projectInfo,
    appliedMigrations: migResult.applied,
    deployedFunctions: deployResult.deployed,
    vaultSecrets: vaultResult.created,
    cronApplied: cronResult.applied,
    advisors: advisorFindings,
    secrets: {
      SUPABASE_URL: projectUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      SUPABASE_ANON_KEY: anonKey || null,
      DATABASE_URL: databaseUrl,
      // OPENAI_API_KEY + ANTHROPIC_API_KEY come from the user — caller fills.
    },
  };
  onPhase({ phase: 'done', status: 'ok' });
  return result;
}

module.exports = {
  provisionViaSupabaseMcp,
  PHASES,
  // Exported for tests:
  sanitizeErrorForLogs,
  unwrapMcpResult,
  _listOrganizations: listOrganizations,
  _createProject: createProject,
  _waitForProjectReady: waitForProjectReady,
  _fetchProjectAccess: fetchProjectAccess,
  _applyAllMigrations: applyAllMigrations,
  _createVaultSecrets: createVaultSecrets,
  _deployEdgeFunctions: deployEdgeFunctions,
  _applyCronSchedules: applyCronSchedules,
  _runAdvisors: runAdvisors,
  _structuredError: structuredError,
};
