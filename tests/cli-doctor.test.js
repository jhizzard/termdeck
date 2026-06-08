// Tests for `termdeck doctor` — Sprint 28 T2 + Sprint 35 T3.
//
// We monkey-patch `_detectInstalled` and `_fetchLatest` on the module export
// so each case feeds canned versions through the resolve/classify/exit-code
// pipeline without touching npm or the real registry. process.stdout.write
// is stubbed for the duration of each call so the test runner output stays
// clean and so we can assert on JSON output verbatim.
//
// The version-check tests pass `--no-schema` to skip the Sprint 35 schema
// section (which would otherwise try to connect to a real Supabase via
// ~/.termdeck/secrets.env). Schema-check tests use `_runSchemaCheck`
// monkey-patching to feed canned section data without touching pg.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const doctor = require(path.join(__dirname, '..', 'packages', 'cli', 'src', 'doctor.js'));
const PACKAGES = doctor.STACK_PACKAGES;

const origDetect = doctor._detectInstalled;
const origFetch = doctor._fetchLatest;
const origRunSchemaCheck = doctor._runSchemaCheck;
const origRunAgentAuthCheck = doctor._runAgentAuthCheck;

function restore() {
  doctor._detectInstalled = origDetect;
  doctor._fetchLatest = origFetch;
  doctor._runSchemaCheck = origRunSchemaCheck;
  doctor._runAgentAuthCheck = origRunAgentAuthCheck;
}

// Sprint 70 T2: default the agent-auth section to an empty no-op so the
// version/schema cases stay deterministic regardless of the host machine's
// gemini config (mirrors how those cases pass --no-schema to isolate). Cases
// that exercise the agent section pass an `agents` stub; the real-wiring tests
// call doctor._runAgentAuthCheck directly.
const EMPTY_AGENTS = async () => ({ skipped: false, agents: [], passed: 0, total: 0, hasGaps: false });

async function runWithStubs({ detect, fetch, schema, agents, argv = [] }) {
  doctor._detectInstalled = detect;
  doctor._fetchLatest = fetch;
  if (schema) doctor._runSchemaCheck = schema;
  doctor._runAgentAuthCheck = agents || EMPTY_AGENTS;
  const captured = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  let code;
  try {
    code = await doctor(argv);
  } finally {
    process.stdout.write = origWrite;
    restore();
  }
  return { code, output: captured.join('') };
}

// ── Sprint 28: version-check (with --no-schema to isolate from Sprint 35) ──

test('doctor: exit code 0 when every package is installed and current', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.2.3',
    fetch: async () => '1.2.3',
    argv: ['--no-schema'],
  });
  assert.equal(code, 0);
  assert.match(output, /up to date/);
  assert.match(output, /All packages up to date/);
});

test('doctor: exit code 1 when at least one package is behind', async () => {
  const behindPkg = PACKAGES[0];
  const { code, output } = await runWithStubs({
    detect: async (p) => (p === behindPkg ? '0.5.0' : '1.0.0'),
    fetch: async (p) => (p === behindPkg ? '0.5.1' : '1.0.0'),
    argv: ['--no-schema'],
  });
  assert.equal(code, 1);
  assert.match(output, /update available/);
  assert.match(output, /1 update available/);
});

test('doctor: exit code 2 when a registry fetch fails — even if other rows are current', async () => {
  const offlinePkg = PACKAGES[2];
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async (p) => (p === offlinePkg ? null : '1.0.0'),
    argv: ['--no-schema'],
  });
  assert.equal(code, 2);
  assert.match(output, /network error/);
  assert.match(output, /Could not reach npm registry/);
});

test('doctor: --json emits a parseable JSON document with the same exit code', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    argv: ['--json', '--no-schema'],
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.rows.length, PACKAGES.length);
  assert.equal(parsed.schema, undefined, '--no-schema should omit the schema key');
  for (const row of parsed.rows) {
    assert.ok(PACKAGES.includes(row.package), `unexpected package in JSON: ${row.package}`);
    assert.equal(row.status, doctor.STATUS.UP_TO_DATE);
  }
});

// ── Sprint 35 T3: schema-check section ─────────────────────────────────────

const ALL_GREEN_SCHEMA = {
  skipped: false,
  sections: [
    { name: 'Mnestra modern schema', checks: [
      { label: 'memory_items table', status: 'pass' },
    ]},
    { name: 'Mnestra legacy schema', checks: [
      { label: 'mnestra_session_memory table', status: 'pass' },
    ]},
    { name: 'Transcript backup', checks: [
      { label: 'termdeck_transcripts table', status: 'pass' },
    ]},
    { name: 'Rumen schema', checks: [
      { label: 'rumen_jobs table', status: 'pass' },
    ]},
    { name: 'Postgres extensions', checks: [
      { label: 'pg_cron', status: 'pass' },
    ]},
  ],
  passed: 5,
  total: 5,
  hasGaps: false,
};

test('doctor: schema section renders grouped by section header when provided', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    schema: async () => ALL_GREEN_SCHEMA,
  });
  assert.equal(code, 0);
  assert.match(output, /Supabase schema check/);
  assert.match(output, /Mnestra modern schema/);
  assert.match(output, /Mnestra legacy schema/);
  assert.match(output, /Transcript backup/);
  assert.match(output, /Rumen schema/);
  assert.match(output, /Postgres extensions/);
  assert.match(output, /5\/5 schema checks passed/);
});

test('doctor: schema gap (e.g. missing legacy table) bumps exit code to 1 with hint', async () => {
  const gappedSchema = {
    skipped: false,
    sections: [
      { name: 'Mnestra legacy schema', checks: [
        { label: 'mnestra_session_memory table', status: 'fail',
          hint: 'run: termdeck init --mnestra --yes (applies migration 008)' },
      ]},
    ],
    passed: 0, total: 1, hasGaps: true,
  };
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    schema: async () => gappedSchema,
  });
  assert.equal(code, 1);
  assert.match(output, /✗ mnestra_session_memory table/);
  assert.match(output, /migration 008/);
});

test('doctor: schema connect error bumps exit code to 2 even when versions are current', async () => {
  const connectErrSchema = {
    skipped: false,
    connectError: 'host not found',
    sections: [], passed: 0, total: 0, hasGaps: true,
  };
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    schema: async () => connectErrSchema,
  });
  assert.equal(code, 2);
  assert.match(output, /could not connect: host not found/);
});

test('doctor: skipped schema (no DATABASE_URL) prints note and does not change exit code', async () => {
  const skipped = {
    skipped: true,
    reason: 'DATABASE_URL not set',
    sections: [], passed: 0, total: 0, hasGaps: false,
  };
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    schema: async () => skipped,
  });
  assert.equal(code, 0);
  assert.match(output, /\(skipped\) DATABASE_URL not set/);
});

test('doctor: --json with schema includes both rows and schema keys', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    schema: async () => ALL_GREEN_SCHEMA,
    argv: ['--json'],
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.rows.length, PACKAGES.length);
  assert.ok(parsed.schema, 'schema key must be present when not --no-schema');
  assert.equal(parsed.schema.passed, 5);
  assert.equal(parsed.schema.total, 5);
  assert.equal(parsed.schema.hasGaps, false);
});

// ── Sprint 70 T2: agent-CLI auth-probe section ─────────────────────────────
//
// Integration cases stub `_runAgentAuthCheck` to drive render + exit-code (the
// same way schema cases stub `_runSchemaCheck`). The real-wiring cases below
// call doctor._runAgentAuthCheck directly to prove `termdeck doctor` actually
// reaches `gemini.checkAuth` — the A2 false-GREEN fix.

const fs = require('node:fs');
const os = require('node:os');

function agentsResult(agent) {
  const arr = Array.isArray(agent) ? agent : [agent];
  const passed = arr.filter((a) => a.ok).length;
  return { skipped: false, agents: arr, passed, total: arr.length, hasGaps: passed < arr.length };
}

test('doctor: agent auth — valid agent renders green, exit stays 0', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    agents: async () => agentsResult({ name: 'Gemini CLI', state: 'valid', ok: true, detail: 'ok', hint: '' }),
    argv: ['--no-schema'],
  });
  assert.equal(code, 0);
  assert.match(output, /Agent CLI auth/);
  assert.match(output, /Gemini CLI: valid/);
  assert.match(output, /1\/1 agent auth checks passed/);
});

test('doctor: agent auth — missing-key bumps exit to 1 with hint', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    agents: async () => agentsResult({ name: 'Gemini CLI', state: 'missing-key', ok: false,
      detail: 'GEMINI_API_KEY is not set', hint: 'Add GEMINI_API_KEY to ~/.termdeck/secrets.env' }),
    argv: ['--no-schema'],
  });
  assert.equal(code, 1);
  assert.match(output, /✗ Gemini CLI: missing-key/);
  assert.match(output, /Add GEMINI_API_KEY/);
});

test('doctor: agent auth — wrong-mode bumps exit to 1 and warns about the cutoff', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    agents: async () => agentsResult({ name: 'Gemini CLI', state: 'wrong-mode', ok: false,
      detail: 'selectedType is "oauth-personal" — breaks 2026-06-18', hint: 'Set selectedType to gemini-api-key' }),
    argv: ['--no-schema'],
  });
  assert.equal(code, 1);
  assert.match(output, /✗ Gemini CLI: wrong-mode/);
  assert.match(output, /2026-06-18/);
});

test('doctor: agent auth — settings-missing bumps exit to 1', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    agents: async () => agentsResult({ name: 'Gemini CLI', state: 'settings-missing', ok: false,
      detail: 'settings.json missing', hint: 'create it' }),
    argv: ['--no-schema'],
  });
  assert.equal(code, 1);
  assert.match(output, /✗ Gemini CLI: settings-missing/);
});

test('doctor: --json includes the agents section', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    agents: async () => agentsResult({ name: 'Gemini CLI', state: 'valid', ok: true, detail: 'ok', hint: '' }),
    argv: ['--no-schema', '--json'],
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(output);
  assert.ok(parsed.agents, 'agents key present when not --no-agents');
  assert.equal(parsed.agents.agents[0].state, 'valid');
  assert.equal(parsed.agents.hasGaps, false);
});

test('doctor: --no-agents skips the agent section entirely (cannot bump exit)', async () => {
  const { code, output } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    // Even a failing probe must be skipped when --no-agents is set:
    agents: async () => agentsResult({ name: 'Gemini CLI', state: 'missing-key', ok: false, detail: 'x', hint: 'y' }),
    argv: ['--no-schema', '--no-agents', '--json'],
  });
  assert.equal(code, 0, 'a skipped agent section cannot raise the exit code');
  const parsed = JSON.parse(output);
  assert.equal(parsed.agents, undefined);
});

test('doctor: a schema connect error (exit 2) is not lowered by an agent gap', async () => {
  const { code } = await runWithStubs({
    detect: async () => '1.0.0',
    fetch: async () => '1.0.0',
    schema: async () => ({ skipped: false, connectError: 'host not found', sections: [], passed: 0, total: 0, hasGaps: true }),
    agents: async () => agentsResult({ name: 'Gemini CLI', state: 'missing-key', ok: false, detail: 'x', hint: 'y' }),
  });
  assert.equal(code, 2, 'exit 2 (connect error) must win over an agent gap (would be 1)');
});

// ── Real wiring: doctor._runAgentAuthCheck → gemini.checkAuth (end-to-end) ──
// Proves the doctor actually reaches the adapter probe, so a misconfigured
// Gemini is caught by `termdeck doctor` (the A2 false-GREEN this closes).

const DOCTOR_AUTH_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-doctor-auth-'));
function writeDoctorSettings(name, selectedType) {
  const p = path.join(DOCTOR_AUTH_TMP, name);
  fs.writeFileSync(p, JSON.stringify({ security: { auth: { selectedType } } }));
  return p;
}
const D_API_KEY = writeDoctorSettings('api.json', 'gemini-api-key');
const D_OAUTH = writeDoctorSettings('oauth.json', 'oauth-personal');
const D_ABSENT = path.join(DOCTOR_AUTH_TMP, 'nope.json');
const D_NO_SECRETS = path.join(DOCTOR_AUTH_TMP, 'no-secrets.env');

test('real wiring: _runAgentAuthCheck reports gemini VALID (key + api-key mode)', async () => {
  const r = await doctor._runAgentAuthCheck({ env: { GEMINI_API_KEY: 'k' }, settingsPath: D_API_KEY });
  const g = r.agents.find((a) => /gemini/i.test(a.name));
  assert.ok(g, 'gemini participates (it exposes checkAuth)');
  assert.equal(g.state, 'valid');
  assert.equal(g.ok, true);
  assert.equal(r.hasGaps, false);
});

test('real wiring: _runAgentAuthCheck reports gemini WRONG-MODE (oauth-personal → gap)', async () => {
  const r = await doctor._runAgentAuthCheck({ env: { GEMINI_API_KEY: 'k' }, settingsPath: D_OAUTH });
  const g = r.agents.find((a) => /gemini/i.test(a.name));
  assert.equal(g.state, 'wrong-mode');
  assert.equal(g.ok, false);
  assert.equal(r.hasGaps, true, 'a misconfigured Gemini makes the doctor RED — kills the false-GREEN');
});

test('real wiring: _runAgentAuthCheck reports gemini MISSING-KEY', async () => {
  const r = await doctor._runAgentAuthCheck({ env: {}, secretsPath: D_NO_SECRETS, settingsPath: D_API_KEY });
  const g = r.agents.find((a) => /gemini/i.test(a.name));
  assert.equal(g.state, 'missing-key');
  assert.equal(r.hasGaps, true);
});

test('real wiring: _runAgentAuthCheck reports gemini SETTINGS-MISSING', async () => {
  const r = await doctor._runAgentAuthCheck({ env: { GEMINI_API_KEY: 'k' }, settingsPath: D_ABSENT });
  const g = r.agents.find((a) => /gemini/i.test(a.name));
  assert.equal(g.state, 'settings-missing');
  assert.equal(r.hasGaps, true);
});
