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

function restore() {
  doctor._detectInstalled = origDetect;
  doctor._fetchLatest = origFetch;
  doctor._runSchemaCheck = origRunSchemaCheck;
}

async function runWithStubs({ detect, fetch, schema, argv = [] }) {
  doctor._detectInstalled = detect;
  doctor._fetchLatest = fetch;
  if (schema) doctor._runSchemaCheck = schema;
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
