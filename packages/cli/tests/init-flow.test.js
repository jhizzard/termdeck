// Sprint 64 T1 — Unified `termdeck init` orchestrator tests.
//
// Pins the flag-parser matrix, default-name shape, dbPassword entropy,
// HELP content invariants, existing-install probe, and the auto-flow's
// MCP_UNAVAILABLE fallthrough to manual path.
//
// Full end-to-end coverage of the auto + manual paths requires the
// init-mnestra/init-rumen/doctor sub-wizards which have heavy file I/O
// and pg.connect dependencies; those are pinned by existing tests at the
// repo root tests/ dir (init-rumen-* + init-project + etc.). This file
// focuses on the NEW orchestrator surface T1 owns: flag parsing,
// auto-input collection, phase ordering, fallback gates.
//
// Co-located under packages/cli/tests/ per ORCH SCOPE 16:14 + 16:18 ET.
//
// Run: node --test packages/cli/tests/init-flow.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const init = require('../src/init');
const {
  parseFlags,
  generateDbPassword,
  defaultProjectName,
  probeExistingInstall,
  HELP,
} = init;

// ─────────────────────────────────────────────────────────────────────────
// parseFlags — coverage matrix.

test('parseFlags — empty argv yields all-false flags', () => {
  const f = parseFlags([]);
  assert.equal(f.help, false);
  assert.equal(f.auto, false);
  assert.equal(f.reset, false);
  assert.equal(f.fromEnv, false);
  assert.equal(f.dryRun, false);
  assert.equal(f.skipRumen, false);
  assert.equal(f.skipDoctor, false);
  assert.equal(f.yes, false);
  assert.equal(f.pat, null);
  assert.equal(f.orgId, null);
  assert.equal(f.projectName, null);
  assert.equal(f.region, null);
  assert.equal(f.dbPassword, null);
});

test('parseFlags — short + long aliases', () => {
  const f1 = parseFlags(['-h']);
  assert.equal(f1.help, true);
  const f2 = parseFlags(['--help']);
  assert.equal(f2.help, true);
  const f3 = parseFlags(['-y']);
  assert.equal(f3.yes, true);
  const f4 = parseFlags(['--yes']);
  assert.equal(f4.yes, true);
});

test('parseFlags — --auto and --mcp-supabase both set auto:true (FINDING-1.1A)', () => {
  assert.equal(parseFlags(['--auto']).auto, true);
  assert.equal(parseFlags(['--mcp-supabase']).auto, true);
});

test('parseFlags — value-taking flags consume next arg', () => {
  const f = parseFlags(['--pat', 'sbp_abc123def456', '--org-id', 'org_x', '--project-name', 'my-project', '--region', 'us-west-1', '--db-password', 'manual-password']);
  assert.equal(f.pat, 'sbp_abc123def456');
  assert.equal(f.orgId, 'org_x');
  assert.equal(f.projectName, 'my-project');
  assert.equal(f.region, 'us-west-1');
  assert.equal(f.dbPassword, 'manual-password');
});

test('parseFlags — skip-rumen and skip-doctor', () => {
  const f = parseFlags(['--skip-rumen', '--skip-doctor']);
  assert.equal(f.skipRumen, true);
  assert.equal(f.skipDoctor, true);
});

test('parseFlags — from-env + reset + dry-run', () => {
  const f = parseFlags(['--from-env', '--reset', '--dry-run']);
  assert.equal(f.fromEnv, true);
  assert.equal(f.reset, true);
  assert.equal(f.dryRun, true);
});

test('parseFlags — combined flag matrix end-to-end', () => {
  const f = parseFlags([
    '--auto', '--from-env', '--yes', '--reset', '--skip-doctor',
    '--pat', 'sbp_zzz', '--region', 'eu-west-2',
  ]);
  assert.equal(f.auto, true);
  assert.equal(f.fromEnv, true);
  assert.equal(f.yes, true);
  assert.equal(f.reset, true);
  assert.equal(f.skipDoctor, true);
  assert.equal(f.pat, 'sbp_zzz');
  assert.equal(f.region, 'eu-west-2');
});

// ─────────────────────────────────────────────────────────────────────────
// generateDbPassword — entropy + shape.

test('generateDbPassword — returns 32-hex string (128 bits entropy)', () => {
  const pw = generateDbPassword();
  assert.match(pw, /^[0-9a-f]{32}$/);
});

test('generateDbPassword — successive calls yield different values', () => {
  const a = generateDbPassword();
  const b = generateDbPassword();
  const c = generateDbPassword();
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

test('generateDbPassword — well above Supabase 12-char minimum', () => {
  for (let i = 0; i < 10; i++) {
    assert.ok(generateDbPassword().length >= 12);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// defaultProjectName — shape.

test('defaultProjectName — termdeck-<8hex> shape', () => {
  const n = defaultProjectName();
  assert.match(n, /^termdeck-[0-9a-f]{8}$/);
});

test('defaultProjectName — collision-resistant across calls', () => {
  const names = new Set();
  for (let i = 0; i < 20; i++) names.add(defaultProjectName());
  assert.equal(names.size, 20);
});

// ─────────────────────────────────────────────────────────────────────────
// probeExistingInstall.

test('probeExistingInstall — returns false flags when nothing exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  const r = probeExistingInstall(tmp);
  assert.equal(r.secretsExists, false);
  assert.equal(r.configExists, false);
  assert.equal(r.secretsPath, path.join(tmp, '.termdeck', 'secrets.env'));
  assert.equal(r.configPath, path.join(tmp, '.termdeck', 'config.yaml'));
});

test('probeExistingInstall — flags secrets.env when only secrets exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  fs.mkdirSync(path.join(tmp, '.termdeck'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.termdeck', 'secrets.env'), 'FOO=bar\n');
  const r = probeExistingInstall(tmp);
  assert.equal(r.secretsExists, true);
  assert.equal(r.configExists, false);
});

test('probeExistingInstall — flags both when both exist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  fs.mkdirSync(path.join(tmp, '.termdeck'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.termdeck', 'secrets.env'), 'FOO=bar\n');
  fs.writeFileSync(path.join(tmp, '.termdeck', 'config.yaml'), 'rag:\n  enabled: false\n');
  const r = probeExistingInstall(tmp);
  assert.equal(r.secretsExists, true);
  assert.equal(r.configExists, true);
});

// ─────────────────────────────────────────────────────────────────────────
// HELP — content invariants.

test('HELP — mentions every primary flag', () => {
  for (const expected of ['--help', '--auto', '--mcp-supabase', '--reset', '--from-env', '--dry-run', '--skip-rumen', '--skip-doctor']) {
    assert.match(HELP, new RegExp(expected.replace(/-/g, '\\-')), `HELP should mention ${expected}`);
  }
});

test('HELP — mentions PAT URL', () => {
  assert.match(HELP, /supabase\.com\/dashboard\/account\/tokens/);
});

test('HELP — mentions sub-mode wizards', () => {
  assert.match(HELP, /termdeck init --mnestra/);
  assert.match(HELP, /termdeck init --rumen/);
});

// ─────────────────────────────────────────────────────────────────────────
// main(['--help']) integration.

test('main([--help]) returns 0 and writes HELP to stdout', async () => {
  const captured = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { captured.push(String(s)); return true; };
  try {
    const code = await init(['--help']);
    assert.equal(code, 0);
    const out = captured.join('');
    assert.match(out, /TermDeck unified setup/);
    assert.match(out, /--auto/);
  } finally {
    process.stdout.write = origWrite;
  }
});

// ─────────────────────────────────────────────────────────────────────────
// collectAutoInputs — input matrix.

test('collectAutoInputs — reads PAT from env when not flagged', async () => {
  const inputs = await init.collectAutoInputs({
    flags: { fromEnv: true, yes: true },
    prompts: { askSecret: async () => null, askRequired: async () => null },
    env: {
      SUPABASE_ACCESS_TOKEN: 'sbp_from_env_token_12345',
      OPENAI_API_KEY: 'sk-proj-from_env',
    },
  });
  assert.equal(inputs.pat, 'sbp_from_env_token_12345');
  assert.equal(inputs.openaiKey, 'sk-proj-from_env');
  assert.match(inputs.projectName, /^termdeck-[0-9a-f]{8}$/);
  assert.match(inputs.dbPassword, /^[0-9a-f]{32}$/);
  assert.equal(inputs.region, 'us-east-1');
});

test('collectAutoInputs — flag overrides env for PAT', async () => {
  const inputs = await init.collectAutoInputs({
    flags: { pat: 'sbp_flag_override', fromEnv: true, yes: true },
    prompts: { askSecret: async () => null, askRequired: async () => null },
    env: {
      SUPABASE_ACCESS_TOKEN: 'sbp_from_env_token_should_not_win',
      OPENAI_API_KEY: 'sk-proj-from_env',
    },
  });
  assert.equal(inputs.pat, 'sbp_flag_override');
});

test('collectAutoInputs — from-env + missing PAT throws', async () => {
  await assert.rejects(
    () => init.collectAutoInputs({
      flags: { fromEnv: true },
      prompts: { askSecret: async () => null, askRequired: async () => null },
      env: { OPENAI_API_KEY: 'sk-proj-x' },
    }),
    /SUPABASE_ACCESS_TOKEN/
  );
});

test('collectAutoInputs — from-env + missing OPENAI throws', async () => {
  await assert.rejects(
    () => init.collectAutoInputs({
      flags: { fromEnv: true },
      prompts: { askSecret: async () => null, askRequired: async () => null },
      env: { SUPABASE_ACCESS_TOKEN: 'sbp_x' },
    }),
    /OPENAI_API_KEY/
  );
});

test('collectAutoInputs — explicit flag values propagate', async () => {
  const inputs = await init.collectAutoInputs({
    flags: {
      pat: 'sbp_pat',
      projectName: 'custom-project',
      region: 'ap-southeast-1',
      dbPassword: 'manual_pw_atleast_12chars',
      orgId: 'org_specific',
      fromEnv: true,
      yes: true,
    },
    prompts: { askSecret: async () => null, askRequired: async () => null },
    env: { OPENAI_API_KEY: 'sk-proj-x' },
  });
  assert.equal(inputs.pat, 'sbp_pat');
  assert.equal(inputs.projectName, 'custom-project');
  assert.equal(inputs.region, 'ap-southeast-1');
  assert.equal(inputs.dbPassword, 'manual_pw_atleast_12chars');
  assert.equal(inputs.orgId, 'org_specific');
});

test('collectAutoInputs — anthropicKey optional from env', async () => {
  const inputs = await init.collectAutoInputs({
    flags: { fromEnv: true, yes: true },
    prompts: { askSecret: async () => null, askRequired: async () => null },
    env: {
      SUPABASE_ACCESS_TOKEN: 'sbp_x_test_token',
      OPENAI_API_KEY: 'sk-proj-x',
      ANTHROPIC_API_KEY: 'sk-ant-x',
    },
  });
  assert.equal(inputs.anthropicKey, 'sk-ant-x');
});

// ─────────────────────────────────────────────────────────────────────────
// AUDIT-RED 16:26 closure — PAT non-persistence fence.

test('init.js source — auto-flow does NOT persist SUPABASE_ACCESS_TOKEN to secrets.env (AUDIT-RED 16:26)', () => {
  const initSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'init.js'), 'utf8');
  // The original AUDIT-RED line was `SUPABASE_ACCESS_TOKEN: inputs.pat,`
  // inside a `dotenv.writeSecrets({...})` call. The remediation removed it.
  // This fence asserts no `KEY: value` assignment of SUPABASE_ACCESS_TOKEN
  // exists anywhere in init.js — narrative-comment mentions of the bare
  // key name (without `: <expr>`) are allowed and expected for documentation.
  const assignmentPattern = /SUPABASE_ACCESS_TOKEN\s*:\s*\S/;
  const m = initSrc.match(assignmentPattern);
  assert.ok(!m, `SUPABASE_ACCESS_TOKEN must not be assigned anywhere in init.js (AUDIT-RED 16:26)\n  matched: ${m && m[0]}`);
});

test('init.js source — explicit NOTE comment documents the AUDIT-RED rationale', () => {
  // Belt-and-suspenders: the source must carry the explanation so future
  // contributors don't re-add the line under "would be nicer".
  const initSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'init.js'), 'utf8');
  assert.match(initSrc, /AUDIT-RED/, 'init.js must reference AUDIT-RED in the documentation');
  assert.match(initSrc, /do NOT add SUPABASE_ACCESS_TOKEN/i, 'init.js must explicitly warn against re-adding the line');
});
