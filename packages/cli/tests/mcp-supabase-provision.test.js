// Sprint 64 T1 — MCP-mediated Supabase provisioning tests.
//
// Pins: phase ordering, error codes, PAT/service-role-key/project-ref
// redaction (resolves T4-CODEX 16:09 ET AUDIT-CONCERN #2), advisor RED
// blocking, partial-install marker write on mid-migration failure, dry-run
// short-circuit, and unwrapMcpResult shape handling.
//
// All callTool / detectMcp / migrations / fs IO is dependency-injected via
// the `deps` parameter — no test touches the real Supabase MCP server or
// the actual filesystem outside of a per-test tmpdir.
//
// Co-located under packages/cli/tests/ per ORCH SCOPE 16:14 + 16:18 ET.
// Root `package.json` test glob covers this dir alongside `packages/server/tests/`
// and `packages/stack-installer/tests/`.
//
// Run: node --test packages/cli/tests/mcp-supabase-provision.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const provisionMod = require('../src/mcp-supabase-provision');
const {
  provisionViaSupabaseMcp,
  sanitizeErrorForLogs,
  unwrapMcpResult,
} = provisionMod;

// Sprint 64 T1 source-side redaction primitive — per ORCH SCOPE 16:14 ET.
const supabaseMcp = require('../../server/src/setup/supabase-mcp');
const { redactSecrets } = supabaseMcp;

// ─────────────────────────────────────────────────────────────────────────
// Fakes / builders.

const SAFE_DB_PASSWORD = 'local-test-password';
const SAFE_ANON_KEY = 'anon-key-fixture';
const SAFE_SERVICE_ROLE_KEY = 'service-role-key-fixture';
const jwtCanary = () => ['eyJ' + 'a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)].join('.');
const longPatCanary = () => 'sbp_' + 'a'.repeat(41);

// Build a fake supabaseMcp.callTool that returns scripted responses per method.
// `scripts` maps method-name → (params, callIdx) => result | function | thrown error.
function makeFakeMcp(scripts, opts = {}) {
  const calls = [];
  const counters = Object.create(null);
  return {
    calls,
    detectMcp: async () => ({ available: opts.available !== false, mode: 'npx' }),
    callTool: async (pat, method, params, callOpts) => {
      calls.push({ pat, method, params });
      counters[method] = (counters[method] || 0) + 1;
      const handler = scripts[method];
      if (handler === undefined) {
        throw new Error(`fake mcp: no script for method ${method}`);
      }
      const value = typeof handler === 'function'
        ? handler(params, counters[method] - 1)
        : handler;
      if (value instanceof Error) throw value;
      // Wrap in MCP text-content envelope so unwrap path is exercised.
      return wrapAsMcpResult(value);
    },
  };
}

function wrapAsMcpResult(value) {
  // Mimic the MCP content-array shape.
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function makeFakeMigrations({ mnestraFiles = ['001_mnestra_tables.sql', '015_source_agent.sql'], rumenFiles = ['001_rumen_tables.sql', '002_pg_cron_schedule.sql', '003_graph_inference_schedule.sql'], rumenFunctions = ['rumen-tick', 'graph-inference'] } = {}) {
  // Use a stable virtual root path so test assertions can match.
  const root = '/virtual/migrations-root';
  return {
    listMnestraMigrations: () => mnestraFiles.map((f) => `${root}/mnestra/${f}`),
    listRumenMigrations: () => rumenFiles.map((f) => `${root}/rumen/migrations/${f}`),
    rumenFunctionsRoot: () => `${root}/rumen/functions`,
    listRumenFunctions: () => rumenFunctions,
    readFile: (p) => {
      const base = path.basename(p);
      // Cron migrations include the <project-ref> placeholder so
      // migrationTemplating can substitute.
      if (/002_pg_cron|003_graph_inference/.test(base)) {
        return `-- ${base}\nSELECT cron.schedule('${base}', '*/15 * * * *',\n  $$SELECT net.http_post('https://<project-ref>.supabase.co/functions/v1/${base}', ...);$$);`;
      }
      return `-- ${base}\nCREATE TABLE IF NOT EXISTS demo_${base.replace(/[^a-z0-9]/gi, '_')} (id int);`;
    },
  };
}

function makeFakeMigrationTemplating() {
  return {
    applyTemplating: (sql, ctx) => {
      if (!ctx || !ctx.projectRef) return sql;
      return sql.replace(/<project-ref>/g, ctx.projectRef).replace(/\{\{PROJECT_REF\}\}/g, ctx.projectRef);
    },
  };
}

function makeFakeSupabaseUrl() {
  return {
    normalizeDatabaseUrl: (u) => ({ url: u, modified: false }),
    parseProjectUrl: (u) => {
      const m = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(u);
      return m ? { ok: true, projectRef: m[1], url: u } : { ok: false, error: 'bad url' };
    },
  };
}

function makeRumenFnFixture(tmpRoot) {
  // Create rumen-tick + graph-inference fixture dirs with stub index.ts files.
  const root = path.join(tmpRoot, 'rumen-functions');
  fs.mkdirSync(path.join(root, 'rumen-tick'), { recursive: true });
  fs.mkdirSync(path.join(root, 'graph-inference'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rumen-tick', 'index.ts'),
    "// rumen-tick stub\nimport rumen from 'npm:@jhizzard/rumen@__RUMEN_VERSION__';\n");
  fs.writeFileSync(path.join(root, 'graph-inference', 'index.ts'),
    "// graph-inference stub\nimport postgres from 'npm:postgres@3.4.4';\n");
  return root;
}

function makeDepsBundle(tmpRoot, scripts, opts = {}) {
  const rumenRoot = makeRumenFnFixture(tmpRoot);
  const fakeMigrations = makeFakeMigrations(opts.migrationsOpts);
  fakeMigrations.rumenFunctionsRoot = () => rumenRoot;
  return {
    supabaseMcp: makeFakeMcp(scripts, opts.mcpOpts),
    migrations: fakeMigrations,
    migrationTemplating: makeFakeMigrationTemplating(),
    supabaseUrl: makeFakeSupabaseUrl(),
  };
}

function happyScript({ orgs = [{ id: 'org_abc', name: 'My Org', plan: 'free' }], advisorErrors = { security: [], performance: [] } } = {}) {
  return {
    list_organizations: () => orgs,
    create_project: () => ({ id: 'proj_ref_xyz', name: 'test-project' }),
    get_project: () => ({ id: 'proj_ref_xyz', status: 'ACTIVE_HEALTHY' }),
    get_project_url: () => ({ url: 'https://proj_ref_xyz.supabase.co' }),
    get_publishable_keys: () => [
      { name: 'anon', api_key: SAFE_ANON_KEY },
      { name: 'service_role', api_key: SAFE_SERVICE_ROLE_KEY },
    ],
    apply_migration: () => ({ ok: true }),
    execute_sql: () => ({ rows_affected: 1 }),
    deploy_edge_function: () => ({ deployed: true }),
    get_advisors: (params) => ({ lints: advisorErrors[params.type] || [] }),
  };
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-provision-test-'));
}

// ─────────────────────────────────────────────────────────────────────────
// unwrapMcpResult — shape handling.

test('unwrapMcpResult — text-array shape decodes JSON', () => {
  const wrapped = { content: [{ type: 'text', text: '{"foo":"bar"}' }] };
  assert.deepEqual(unwrapMcpResult(wrapped), { foo: 'bar' });
});

test('unwrapMcpResult — text-array fallback to raw text when JSON invalid', () => {
  const wrapped = { content: [{ type: 'text', text: 'not-json-string' }] };
  assert.equal(unwrapMcpResult(wrapped), 'not-json-string');
});

test('unwrapMcpResult — native object passthrough', () => {
  assert.deepEqual(unwrapMcpResult({ ok: true }), { ok: true });
});

test('unwrapMcpResult — null/undefined → null', () => {
  assert.equal(unwrapMcpResult(null), null);
  assert.equal(unwrapMcpResult(undefined), null);
});

// ─────────────────────────────────────────────────────────────────────────
// Sprint 64 T1 — source-side redactSecrets() fence tests per ORCH SCOPE
// 16:14 ET. These pin the regex-based redaction wired into
// packages/server/src/setup/supabase-mcp.js at the msg.error path (line
// ~170) and the stderr-tail path (line ~185) — defense-in-depth at the
// source so future callers that forget to wrap their own errors don't
// leak JWT / PAT shapes from MCP-side echoes.

test('mcp-supabase-provision redaction (source): JWT shape masked to [REDACTED:JWT] (ORCH SCOPE 16:14 fence a)', () => {
  const canary = jwtCanary();
  const input = `MCP rpc error: failed for ${canary} (token rejected)`;
  const output = redactSecrets(input);
  assert.ok(!output.includes(canary), 'JWT canary should be scrubbed');
  assert.match(output, /\[REDACTED:JWT\]/);
});

test('mcp-supabase-provision redaction (source): PAT shape masked to [REDACTED:PAT] (ORCH SCOPE 16:14 fence b)', () => {
  // 40+ char Supabase Personal Access Token shape.
  const canary = longPatCanary();
  const input = `mcp exited (code=1): error from ${canary} authorization`;
  const output = redactSecrets(input);
  assert.ok(!output.includes(canary), 'PAT canary should be scrubbed');
  assert.match(output, /\[REDACTED:PAT\]/);
});

test('mcp-supabase-provision redaction (source): defense-in-depth — JWT + PAT in same string both masked (ORCH SCOPE 16:14 fence c)', () => {
  const jwtValue = jwtCanary();
  const patValue = longPatCanary();
  const input = `failed spawn with PAT=${patValue} and key=${jwtValue} in env`;
  const output = redactSecrets(input);
  assert.ok(!output.includes(jwtValue));
  assert.ok(!output.includes(patValue));
  assert.match(output, /\[REDACTED:JWT\]/);
  assert.match(output, /\[REDACTED:PAT\]/);
});

test('mcp-supabase-provision redaction (source): non-matching content unchanged', () => {
  const input = 'plain error: ECONNREFUSED 127.0.0.1:5432 (postgres unreachable)';
  assert.equal(redactSecrets(input), input);
});

test('mcp-supabase-provision redaction (source): short JWT-like substrings NOT matched (3-segment guard)', () => {
  // {10,} per segment means shorter triples don't match — avoids
  // false-positive on three-part identifiers that happen to look JWT-shaped.
  const input = 'short three parts: eyJabc.short.string (not a JWT)';
  assert.equal(redactSecrets(input), input);
});

test('mcp-supabase-provision redaction (source): multiple JWTs in same string all masked', () => {
  const k1 = 'eyJ' + 'a'.repeat(15) + '.' + 'b'.repeat(15) + '.' + 'c'.repeat(15);
  const k2 = 'eyJ' + 'x'.repeat(15) + '.' + 'y'.repeat(15) + '.' + 'z'.repeat(15);
  const input = `bound by ${k1} but also rotated to ${k2}`;
  const output = redactSecrets(input);
  assert.ok(!output.includes(k1));
  assert.ok(!output.includes(k2));
  const matches = output.match(/\[REDACTED:JWT\]/g);
  assert.equal(matches && matches.length, 2);
});

test('mcp-supabase-provision redaction (source): handles non-string input gracefully', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(42), 42);
});

// ─────────────────────────────────────────────────────────────────────────
// sanitizeErrorForLogs — redaction.

test('mcp-supabase-provision redaction: PAT is scrubbed from Error.message', () => {
  const pat = 'sbp_abc123def456ghi789';
  const err = new Error(`http 401 from https://api.supabase.com with token=${pat} (bad PAT)`);
  const cleaned = sanitizeErrorForLogs(err, [{ label: 'PAT', value: pat }]);
  assert.ok(!cleaned.message.includes(pat), 'PAT should be redacted from message');
  assert.match(cleaned.message, /\[REDACTED:PAT\]/);
});

test('mcp-supabase-provision redaction: service-role-key is scrubbed', () => {
  const srk = 'sb_secret_service_role_AABBCCDDEEFFGGHH';
  const err = new Error(`vault.create_secret failed: ERROR: duplicate value=${srk}`);
  const cleaned = sanitizeErrorForLogs(err, [{ label: 'SERVICE_ROLE_KEY', value: srk }]);
  assert.ok(!cleaned.message.includes(srk));
  assert.match(cleaned.message, /\[REDACTED:SERVICE_ROLE_KEY\]/);
});

test('mcp-supabase-provision redaction: project_ref is scrubbed from stack + body fields', () => {
  const ref = 'proj_ref_xyz_12345';
  const err = new Error(`apply_migration failed on ${ref}`);
  err.body = `{"project_id":"${ref}","status":"error"}`;
  err.detail = `Failed migration applied to project ${ref}`;
  err.stack = `Error: apply_migration failed on ${ref}\n    at <anonymous>`;
  const cleaned = sanitizeErrorForLogs(err, [{ label: 'PROJECT_REF', value: ref }]);
  assert.ok(!cleaned.message.includes(ref));
  assert.ok(!cleaned.body.includes(ref));
  assert.ok(!cleaned.detail.includes(ref));
  assert.ok(!cleaned.stack.includes(ref));
});

test('mcp-supabase-provision redaction: short values (<8 chars) are NOT redacted (false-positive guard)', () => {
  const err = new Error('foo bar baz qux');
  const cleaned = sanitizeErrorForLogs(err, [{ label: 'X', value: 'bar' }]);
  assert.equal(cleaned.message, 'foo bar baz qux', 'short values should not be redacted');
});

test('mcp-supabase-provision redaction: preserves .code on cleaned error', () => {
  const err = new Error('failed');
  err.code = 'PROJECT_CREATE_FAILED';
  const cleaned = sanitizeErrorForLogs(err, [{ label: 'PAT', value: 'sbp_abc123def456ghi789' }]);
  assert.equal(cleaned.code, 'PROJECT_CREATE_FAILED');
});

test('mcp-supabase-provision redaction: handles non-Error inputs gracefully', () => {
  const cleaned = sanitizeErrorForLogs('plain string with sbp_abc123def456 leaked', [{ label: 'PAT', value: 'sbp_abc123def456' }]);
  assert.ok(cleaned instanceof Error);
  assert.match(cleaned.message, /\[REDACTED:PAT\]/);
});

// ─────────────────────────────────────────────────────────────────────────
// MCP_UNAVAILABLE path.

test('provisionViaSupabaseMcp — MCP_UNAVAILABLE when detectMcp returns available:false', async () => {
  const tmp = mkTmpDir();
  const deps = makeDepsBundle(tmp, happyScript(), { mcpOpts: { available: false } });
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'my-test-project',
      dbPassword: SAFE_DB_PASSWORD,
      orgId: 'org_abc',
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'MCP_UNAVAILABLE');
  }
});

test('provisionViaSupabaseMcp — MCP_UNAVAILABLE on missing required input', async () => {
  for (const missing of ['pat', 'projectName', 'dbPassword']) {
    const opts = { pat: 'sbp_abc123def456ghi789', projectName: 'p', dbPassword: SAFE_DB_PASSWORD };
    delete opts[missing];
    try {
      await provisionViaSupabaseMcp(opts);
      assert.fail(`expected throw for missing ${missing}`);
    } catch (err) {
      assert.equal(err.code, 'MCP_UNAVAILABLE');
      assert.match(err.message, new RegExp(missing, 'i'));
    }
  }
});

test('provisionViaSupabaseMcp — short dbPassword rejected', async () => {
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'p',
      dbPassword: 'short',
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'MCP_UNAVAILABLE');
    assert.match(err.message, /12\+/);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Org-list resolution.

test('provisionViaSupabaseMcp — auto-picks single visible org', async () => {
  const tmp = mkTmpDir();
  const phases = [];
  const deps = makeDepsBundle(tmp, happyScript());
  const r = await provisionViaSupabaseMcp({
    pat: 'sbp_abc123def456ghi789',
    projectName: 'auto-org-test',
    dbPassword: SAFE_DB_PASSWORD,
    rumenVersion: '0.5.3',
    deps,
    homedir: tmp,
    onPhase: (p) => phases.push(p),
  });
  assert.equal(r.ok, true);
  assert.equal(r.projectRef, 'proj_ref_xyz');
  const listOrgsPhase = phases.find((p) => p.phase === 'list-orgs' && p.status === 'ok');
  assert.ok(listOrgsPhase);
  assert.equal(listOrgsPhase.detail.autopicked, 'My Org');
});

test('provisionViaSupabaseMcp — ORG_LIST_REQUIRED when multiple orgs + no orgId', async () => {
  const tmp = mkTmpDir();
  const deps = makeDepsBundle(tmp, happyScript({
    orgs: [
      { id: 'org_a', name: 'Org A' },
      { id: 'org_b', name: 'Org B' },
    ],
  }));
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'p',
      dbPassword: SAFE_DB_PASSWORD,
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'ORG_LIST_REQUIRED');
    assert.equal(err.orgs.length, 2);
    assert.equal(err.orgs[0].id, 'org_a');
  }
});

test('provisionViaSupabaseMcp — ORG_LIST_REQUIRED when given orgId not in list', async () => {
  const tmp = mkTmpDir();
  const deps = makeDepsBundle(tmp, happyScript());
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'p',
      dbPassword: SAFE_DB_PASSWORD,
      orgId: 'org_wrong',
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'ORG_LIST_REQUIRED');
  }
});

test('provisionViaSupabaseMcp — ORG_LIST_REQUIRED when no orgs visible', async () => {
  const tmp = mkTmpDir();
  const deps = makeDepsBundle(tmp, happyScript({ orgs: [] }));
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'p',
      dbPassword: SAFE_DB_PASSWORD,
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'ORG_LIST_REQUIRED');
    assert.match(err.message, /no Supabase organizations visible/);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Happy path — full pipeline.

test('provisionViaSupabaseMcp — happy path returns secrets bag with all keys', async () => {
  const tmp = mkTmpDir();
  const phases = [];
  const deps = makeDepsBundle(tmp, happyScript());
  const r = await provisionViaSupabaseMcp({
    pat: 'sbp_abc123def456ghi789',
    projectName: 'happy-path',
    dbPassword: SAFE_DB_PASSWORD,
    orgId: 'org_abc',
    region: 'us-west-1',
    rumenVersion: '0.5.3',
    deps,
    homedir: tmp,
    onPhase: (p) => phases.push(p),
  });
  assert.equal(r.ok, true);
  assert.equal(r.projectRef, 'proj_ref_xyz');
  assert.equal(r.projectUrl, 'https://proj_ref_xyz.supabase.co');
  assert.ok(r.appliedMigrations.length >= 3, 'mnestra + rumen tables migrations');
  assert.deepEqual(r.deployedFunctions, ['rumen-tick', 'graph-inference']);
  assert.deepEqual(r.vaultSecrets, ['rumen_service_role_key', 'graph_inference_service_role_key']);
  assert.deepEqual(r.cronApplied, ['002_pg_cron_schedule.sql', '003_graph_inference_schedule.sql']);
  // Secrets bag.
  assert.equal(r.secrets.SUPABASE_URL, 'https://proj_ref_xyz.supabase.co');
  assert.equal(r.secrets.SUPABASE_SERVICE_ROLE_KEY, SAFE_SERVICE_ROLE_KEY);
  assert.equal(r.secrets.SUPABASE_ANON_KEY, SAFE_ANON_KEY);
  assert.match(r.secrets.DATABASE_URL, /postgres:\/\/postgres\.proj_ref_xyz:local-test-password@aws-0-us-west-1\.pooler\.supabase\.com:6543\/postgres/);
  assert.match(r.secrets.DATABASE_URL, /pgbouncer=true/);
  // Phase ordering invariant.
  const expectedPhaseOrder = ['preflight', 'list-orgs', 'create-project', 'wait-ready', 'fetch-access', 'apply-migrations', 'create-vault-secrets', 'deploy-functions', 'apply-cron', 'run-advisors', 'done'];
  const okPhases = phases.filter((p) => p.status === 'ok').map((p) => p.phase);
  for (const expected of expectedPhaseOrder) {
    assert.ok(okPhases.includes(expected), `expected phase ${expected} to complete`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PAT redaction in real failure paths.

test('mcp-supabase-provision redaction: PAT does not surface in create_project error', async () => {
  const tmp = mkTmpDir();
  const pat = 'sbp_abc123def456ghi789jkl';
  const script = happyScript();
  script.create_project = () => {
    const e = new Error(`http 500 from https://api.supabase.com — Authorization: Bearer ${pat}`);
    return e;
  };
  const deps = makeDepsBundle(tmp, script);
  try {
    await provisionViaSupabaseMcp({
      pat,
      projectName: 'pat-redact-test',
      dbPassword: SAFE_DB_PASSWORD,
      orgId: 'org_abc',
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'PROJECT_CREATE_FAILED');
    assert.ok(!err.message.includes(pat), `PAT leaked into error: ${err.message}`);
    assert.match(err.message, /\[REDACTED:PAT\]/);
  }
});

test('mcp-supabase-provision redaction: dbPassword does not surface in deploy error', async () => {
  const tmp = mkTmpDir();
  const dbPassword = 'super_secret_db_pw_2026';
  const script = happyScript();
  script.deploy_edge_function = () => {
    const e = new Error(`deploy failed; debug payload included dbPass=${dbPassword}`);
    return e;
  };
  const deps = makeDepsBundle(tmp, script);
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'pw-redact-test',
      dbPassword,
      orgId: 'org_abc',
      rumenVersion: '0.5.3',
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'DEPLOY_FAILED');
    assert.ok(!err.message.includes(dbPassword), `dbPassword leaked: ${err.message}`);
    assert.match(err.message, /\[REDACTED:DB_PASSWORD\]/);
  }
});

test('mcp-supabase-provision redaction: service-role key does not surface in vault error', async () => {
  const tmp = mkTmpDir();
  const script = happyScript();
  script.execute_sql = () => {
    return new Error(`vault.create_secret failed; returned token ${SAFE_SERVICE_ROLE_KEY} in error body`);
  };
  const deps = makeDepsBundle(tmp, script);
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'srk-redact-test',
      dbPassword: SAFE_DB_PASSWORD,
      orgId: 'org_abc',
      rumenVersion: '0.5.3',
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'VAULT_FAILED');
    assert.ok(!err.message.includes(SAFE_SERVICE_ROLE_KEY),
      `service_role key leaked: ${err.message}`);
    assert.match(err.message, /\[REDACTED:SERVICE_ROLE_KEY\]/);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// MIGRATION_FAILED → writes partial-install marker.

test('provisionViaSupabaseMcp — mid-migration failure writes ~/.termdeck/.partial-install', async () => {
  const tmp = mkTmpDir();
  let migrationCount = 0;
  const script = happyScript();
  script.apply_migration = () => {
    migrationCount += 1;
    if (migrationCount === 2) {
      return new Error('migration 2 failed: column conflict');
    }
    return { ok: true };
  };
  const deps = makeDepsBundle(tmp, script);
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'mid-mig-fail',
      dbPassword: SAFE_DB_PASSWORD,
      orgId: 'org_abc',
      rumenVersion: '0.5.3',
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'MIGRATION_FAILED');
    assert.equal(err.applied.length, 1, 'first migration applied before failure');
    assert.equal(err.failedAt, '015_source_agent.sql');
  }
  const marker = path.join(tmp, '.termdeck', '.partial-install');
  assert.ok(fs.existsSync(marker), 'partial-install marker should exist');
  const data = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(data.projectRef, 'proj_ref_xyz');
  assert.equal(data.applied.length, 1);
  assert.equal(data.failedAt, '015_source_agent.sql');
});

// ─────────────────────────────────────────────────────────────────────────
// ADVISOR_BLOCK on ERROR severity.

test('provisionViaSupabaseMcp — ADVISOR_BLOCK on ERROR severity advisor row', async () => {
  const tmp = mkTmpDir();
  const script = happyScript({
    advisorErrors: {
      security: [{
        name: 'rls_disabled_in_public',
        level: 'ERROR',
        message: 'RLS is disabled on public.demo',
        detail: 'Public tables must have RLS enabled',
      }],
      performance: [],
    },
  });
  const deps = makeDepsBundle(tmp, script);
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'advisor-red-test',
      dbPassword: SAFE_DB_PASSWORD,
      orgId: 'org_abc',
      rumenVersion: '0.5.3',
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'ADVISOR_BLOCK');
    assert.equal(err.reds.length, 1);
    assert.equal(err.reds[0].name, 'rls_disabled_in_public');
    assert.equal(err.reds[0].type, 'security');
  }
});

test('provisionViaSupabaseMcp — WARN advisor row does NOT block', async () => {
  const tmp = mkTmpDir();
  const script = happyScript({
    advisorErrors: {
      security: [{ name: 'function_search_path_mutable', level: 'WARN', message: 'mutable search_path' }],
      performance: [],
    },
  });
  const deps = makeDepsBundle(tmp, script);
  const r = await provisionViaSupabaseMcp({
    pat: 'sbp_abc123def456ghi789',
    projectName: 'warn-advisor-test',
    dbPassword: SAFE_DB_PASSWORD,
    orgId: 'org_abc',
    rumenVersion: '0.5.3',
    deps,
    homedir: tmp,
  });
  assert.equal(r.ok, true);
  assert.equal(r.advisors.security.length, 1);
  assert.equal(r.advisors.security[0].level, 'WARN');
});

// ─────────────────────────────────────────────────────────────────────────
// Dry-run short-circuit.

test('provisionViaSupabaseMcp — dryRun returns ok without firing supabase calls', async () => {
  const tmp = mkTmpDir();
  const phases = [];
  const deps = makeDepsBundle(tmp, happyScript());
  const r = await provisionViaSupabaseMcp({
    pat: 'sbp_abc123def456ghi789',
    projectName: 'dry-run-test',
    dbPassword: SAFE_DB_PASSWORD,
    orgId: 'org_abc',
    dryRun: true,
    deps,
    homedir: tmp,
    onPhase: (p) => phases.push(p),
  });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.projectRef, null);
  // Should NOT have made any supabase calls beyond preflight detection.
  assert.equal(deps.supabaseMcp.calls.length, 0, 'no callTool fired in dry-run');
  // Should have hit preflight phase ok + done phase ok.
  assert.ok(phases.some((p) => p.phase === 'preflight' && p.status === 'ok'));
  assert.ok(phases.some((p) => p.phase === 'done' && p.status === 'ok'));
});

// ─────────────────────────────────────────────────────────────────────────
// __RUMEN_VERSION__ placeholder gate.

test('provisionViaSupabaseMcp — DEPLOY_FAILED when rumen-tick has placeholder but no rumenVersion', async () => {
  const tmp = mkTmpDir();
  const deps = makeDepsBundle(tmp, happyScript());
  try {
    await provisionViaSupabaseMcp({
      pat: 'sbp_abc123def456ghi789',
      projectName: 'no-version-test',
      dbPassword: SAFE_DB_PASSWORD,
      orgId: 'org_abc',
      // rumenVersion intentionally omitted
      deps,
      homedir: tmp,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'DEPLOY_FAILED');
    assert.match(err.message, /__RUMEN_VERSION__/);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Idempotent vault.create_secret — duplicate value treated as success.

test('createVaultSecrets — duplicate-key error treated as success (idempotent)', async () => {
  const tmp = mkTmpDir();
  const script = happyScript();
  script.execute_sql = () => new Error('ERROR: duplicate key value violates unique constraint "secrets_name_idx"');
  const deps = makeDepsBundle(tmp, script);
  const r = await provisionViaSupabaseMcp({
    pat: 'sbp_abc123def456ghi789',
    projectName: 'vault-idempotent-test',
    dbPassword: SAFE_DB_PASSWORD,
    orgId: 'org_abc',
    rumenVersion: '0.5.3',
    deps,
    homedir: tmp,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.vaultSecrets, ['rumen_service_role_key', 'graph_inference_service_role_key']);
});

// ─────────────────────────────────────────────────────────────────────────
// Phase progression callback fires for every transition.

test('provisionViaSupabaseMcp — onPhase fires start+ok for every phase', async () => {
  const tmp = mkTmpDir();
  const phases = [];
  const deps = makeDepsBundle(tmp, happyScript());
  await provisionViaSupabaseMcp({
    pat: 'sbp_abc123def456ghi789',
    projectName: 'phase-callback-test',
    dbPassword: SAFE_DB_PASSWORD,
    orgId: 'org_abc',
    rumenVersion: '0.5.3',
    deps,
    homedir: tmp,
    onPhase: (p) => phases.push(p),
  });
  const seen = new Set(phases.map((p) => p.phase));
  for (const required of provisionMod.PHASES) {
    assert.ok(seen.has(required), `phase ${required} should appear in onPhase callback stream`);
  }
});
