// Sprint 71 B-T2 — `termdeck doctor` panel-billing probe.
//
// The probe answers a question the server-side fences structurally cannot:
// "would a panel spawned right now inherit ANTHROPIC_API_KEY?" The fences live
// inside the running server; the operator's shell can carry the key regardless,
// and a server launched from that shell hands it to every panel. Nothing about
// that failure is visible — the panel looks normal and the bill arrives later.
//
// Run: node --test packages/cli/tests/doctor-billing-probe.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const doctor = require('../src/doctor');

// Fake HOME so the probe never reads the developer's real secrets.env.
function fsWith(secretsContent) {
  return {
    readFileSync(p, _enc) {
      if (secretsContent === null) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return secretsContent;
    },
  };
}
const fakeOs = { homedir: () => '/fake/home' };

function byLabel(result, needle) {
  return result.checks.find((c) => c.label.includes(needle));
}

test('clean shell + no secrets.env — both checks are benign', async () => {
  const r = await doctor._runBillingCheck({ fs: fsWith(null), os: fakeOs, env: {} });
  assert.equal(byLabel(r, 'secrets.env').status, 'skip');
  assert.equal(byLabel(r, "shell's environment").status, 'pass');
  assert.equal(r.hasGaps, false);
});

test('key in secrets.env is a PASS, not a warning', async () => {
  // This one matters. secrets.env is the FENCED path — the server excludes it
  // from the panel env merge. Warning here would push an operator to delete a
  // key that server-side consumers legitimately read.
  const r = await doctor._runBillingCheck({
    fs: fsWith('SUPABASE_URL=https://x.supabase.co\nANTHROPIC_API_KEY=sk-ant-x\n'),
    os: fakeOs,
    env: {},
  });
  const chk = byLabel(r, 'secrets.env');
  assert.equal(chk.status, 'pass');
  assert.match(chk.detail, /this is fine/);
});

test('key in the process env WARNS with an actionable remedy', async () => {
  const r = await doctor._runBillingCheck({
    fs: fsWith(null), os: fakeOs, env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
  });
  const chk = byLabel(r, "shell's environment");
  assert.equal(chk.status, 'warn');
  assert.match(chk.hint, /env -u ANTHROPIC_API_KEY/, 'the hint must carry the actual fix command');
  assert.match(chk.hint, /API credits/, 'and name the consequence, not just the condition');
});

test('the escape hatch changes the warning rather than silencing it', async () => {
  const r = await doctor._runBillingCheck({
    fs: fsWith(null),
    os: fakeOs,
    env: { ANTHROPIC_API_KEY: 'sk-ant-x', TERMDECK_ALLOW_PANEL_ANTHROPIC_KEY: '1' },
  });
  const chk = byLabel(r, "shell's environment");
  assert.equal(chk.status, 'warn', 'still surfaced — deliberate is not the same as invisible');
  assert.match(chk.hint, /deliberate configuration/);
});

test('the probe NEVER prints a key value', async () => {
  const canary = 'sk-ant-CANARY-must-not-appear';
  const r = await doctor._runBillingCheck({
    fs: fsWith(`ANTHROPIC_API_KEY=${canary}\n`),
    os: fakeOs,
    env: { ANTHROPIC_API_KEY: canary },
  });
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes(canary), 'no key material in the probe result');
  const rendered = doctor.renderBillingResult(r, {
    green: (s) => s, yellow: (s) => s, red: (s) => s, dim: (s) => s, bold: (s) => s,
  });
  assert.ok(!rendered.includes(canary), 'no key material in the rendered output either');
});

test('an empty or ${VAR}-placeholder value in secrets.env does not count as set', async () => {
  for (const line of ['ANTHROPIC_API_KEY=\n', 'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}\n']) {
    const r = await doctor._runBillingCheck({ fs: fsWith(line), os: fakeOs, env: {} });
    assert.equal(byLabel(r, 'secrets.env').status, 'skip', `"${line.trim()}" must not read as set`);
  }
});

test('an empty-string process env value does not count as set', async () => {
  const r = await doctor._runBillingCheck({ fs: fsWith(null), os: fakeOs, env: { ANTHROPIC_API_KEY: '' } });
  assert.equal(byLabel(r, "shell's environment").status, 'pass');
});

test('the probe never fails the doctor exit code', async () => {
  // Advisory by design: a warn here can be a configuration the operator chose,
  // and failing `doctor` over a choice trains people to ignore the exit code.
  const r = await doctor._runBillingCheck({
    fs: fsWith('ANTHROPIC_API_KEY=sk-ant-x\n'), os: fakeOs, env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
  });
  assert.equal(r.hasGaps, false);
});

test('_readSecretsEnvKeys — parses keys, skips comments and malformed lines', () => {
  const keys = doctor._readSecretsEnvKeys(
    fsWith([
      '# a comment',
      '',
      'SUPABASE_URL=https://x.supabase.co',
      'not a key line',
      'ANTHROPIC_API_KEY=sk-ant-x',
    ].join('\n')),
    fakeOs,
  );
  assert.ok(keys.has('SUPABASE_URL'));
  assert.ok(keys.has('ANTHROPIC_API_KEY'));
  assert.equal(keys.size, 2);
});

test('doctor --json includes the billing section', async () => {
  const origDetect = doctor._detectInstalled;
  const origLatest = doctor._fetchLatest;
  const origWrite = process.stdout.write;
  let out = '';
  doctor._detectInstalled = async () => '1.0.0';
  doctor._fetchLatest = async () => '1.0.0';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try {
    await doctor(['--json', '--no-schema', '--no-agents', '--no-shims']);
  } finally {
    process.stdout.write = origWrite;
    doctor._detectInstalled = origDetect;
    doctor._fetchLatest = origLatest;
  }
  const payload = JSON.parse(out);
  assert.ok(payload.billing, 'billing section present in --json');
  assert.ok(Array.isArray(payload.billing.checks));
});

test('--no-billing skips the section entirely', async () => {
  const origDetect = doctor._detectInstalled;
  const origLatest = doctor._fetchLatest;
  const origWrite = process.stdout.write;
  let out = '';
  doctor._detectInstalled = async () => '1.0.0';
  doctor._fetchLatest = async () => '1.0.0';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try {
    await doctor(['--json', '--no-schema', '--no-agents', '--no-shims', '--no-billing']);
  } finally {
    process.stdout.write = origWrite;
    doctor._detectInstalled = origDetect;
    doctor._fetchLatest = origLatest;
  }
  assert.equal(JSON.parse(out).billing, undefined);
});
