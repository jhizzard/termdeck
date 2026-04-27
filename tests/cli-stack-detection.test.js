// Sprint 36 — unit tests for shouldAutoOrchestrate().
//
// Sprint 24 (original) gated default-entry orchestration on
// `~/.termdeck/{secrets.env,config.yaml}` presence + flags. Sprint 36
// flips the policy: orchestrate always; rely on stack.js's first-run
// bootstrap to write the config and on `--no-stack` (handled in
// index.js) for the explicit opt-out. The function signature is
// retained as a future telemetry hook.
//
// Run: node --test tests/cli-stack-detection.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shouldAutoOrchestrate } = require('../packages/cli/src/auto-orchestrate.js');

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-test-'));
  fs.mkdirSync(path.join(home, '.termdeck'), { recursive: true });
  return home;
}

function writeConfig(home, body) {
  fs.writeFileSync(path.join(home, '.termdeck', 'config.yaml'), body);
}

function writeSecrets(home) {
  fs.writeFileSync(path.join(home, '.termdeck', 'secrets.env'), 'SUPABASE_URL=https://x.supabase.co\n');
}

test('fresh machine — no ~/.termdeck/ at all → orchestrate', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-test-'));
  assert.equal(shouldAutoOrchestrate(home), true);
});

test('secrets.env exists but no config.yaml → orchestrate', () => {
  const home = makeFixture();
  writeSecrets(home);
  assert.equal(shouldAutoOrchestrate(home), true);
});

test('config.yaml exists but no secrets.env → orchestrate', () => {
  const home = makeFixture();
  writeConfig(home, 'mnestra:\n  autoStart: true\n');
  assert.equal(shouldAutoOrchestrate(home), true);
});

test('configured machine: secrets + config + autoStart → orchestrate', () => {
  const home = makeFixture();
  writeSecrets(home);
  writeConfig(home, 'mnestra:\n  autoStart: true\n');
  assert.equal(shouldAutoOrchestrate(home), true);
});

test('opted-out config (autoStart: false) — still orchestrate by default; --no-stack opts out at the dispatcher layer', () => {
  // Sprint 36 deliberately moves the opt-out from config.yaml to the CLI
  // flag. The choreography itself is harmless on opted-out boxes (Step 2
  // prints SKIP instead of starting Mnestra), so always letting it run
  // gives users the diagnostic value of the step output without altering
  // their Mnestra preference.
  const home = makeFixture();
  writeSecrets(home);
  writeConfig(home, 'mnestra:\n  autoStart: false\nrag:\n  enabled: false\n');
  assert.equal(shouldAutoOrchestrate(home), true);
});

test('malformed YAML does not throw — still orchestrates', () => {
  const home = makeFixture();
  writeSecrets(home);
  writeConfig(home, ':\n  bad: [broken\n');
  assert.doesNotThrow(() => shouldAutoOrchestrate(home));
  assert.equal(shouldAutoOrchestrate(home), true);
});

test('homeDir argument is accepted (signature preserved as a telemetry seam)', () => {
  // Older callers passed an explicit home; new callers can omit. Both work.
  assert.equal(shouldAutoOrchestrate('/nonexistent/path'), true);
  assert.equal(shouldAutoOrchestrate(), true);
});
