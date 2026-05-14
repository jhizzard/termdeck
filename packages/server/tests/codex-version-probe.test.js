// Sprint 64 T2 (carve-out 2.3) — codex CLI auto-update lifecycle hazard probe.
//
// Sprint 63 EXIT-CAPTURE-VERIFICATION.md Finding #1 documented codex 0.129 →
// 0.130 auto-update firing on spawn, accepting "Update now", running
// `npm install -g @openai/codex`, and exiting 0 — BEFORE any canary inject.
// Codex CLI has no `--no-update` flag (verified 2026-05-11 against 0.130.0).
//
// `probeCodexVersion` is WARN-only by design and never blocks spawn. Two
// complementary detection paths per ORCH SCOPE 2026-05-14 16:14 ET:
//   • Drift via `~/.termdeck/.last-codex-version` (default operator, no env).
//   • Pin via `CODEX_PINNED_VERSION` env (CI / multi-user).
//
// Fences below validate both paths AND the failure-soft cases (probe fail,
// no version string).
//
// Run: node --test packages/server/tests/codex-version-probe.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexAdapter = require('../src/agent-adapters/codex');
const { probeCodexVersion } = codexAdapter;

function makeStubLogger() {
  const calls = [];
  return {
    warns: calls,
    warn: (...args) => calls.push(args.join(' ')),
  };
}

function makeStubSpawnSync(out) {
  return () => ({ status: out.status ?? 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' });
}

function makeFsApi() {
  const store = new Map();
  return {
    store,
    existsSync(p) { return store.has(p); },
    readFileSync(p, _enc) {
      if (!store.has(p)) throw new Error('ENOENT');
      return store.get(p);
    },
    writeFileSync(p, data, _enc) {
      store.set(p, String(data));
    },
    mkdirSync(_p, _opts) { /* noop */ },
  };
}

test('probeCodexVersion returns reason="probe-failed" when spawn exits non-zero', () => {
  const logger = makeStubLogger();
  const result = probeCodexVersion({
    spawnSync: makeStubSpawnSync({ status: 127, stdout: '' }),
    logger,
    fsApi: makeFsApi(),
    persistedVersionPath: '/tmp/test-noop',
  });
  assert.equal(result.ok, null);
  assert.equal(result.observed, null);
  assert.equal(result.reason, 'probe-failed');
  assert.equal(logger.warns.length, 0, 'must not warn on probe failure');
});

test('probeCodexVersion returns reason="no-version-string" when stdout lacks a semver', () => {
  const logger = makeStubLogger();
  const result = probeCodexVersion({
    spawnSync: makeStubSpawnSync({ status: 0, stdout: 'codex version: unknown\n' }),
    logger,
    fsApi: makeFsApi(),
    persistedVersionPath: '/tmp/test-noop',
  });
  assert.equal(result.ok, null);
  assert.equal(result.observed, null);
  assert.equal(result.reason, 'no-version-string');
  assert.equal(logger.warns.length, 0);
});

test('probeCodexVersion baseline: silently writes persisted-version file on first observation, NO warn', () => {
  const logger = makeStubLogger();
  const fsApi = makeFsApi();
  const pversionPath = '/tmp/test-baseline-version';
  const result = probeCodexVersion({
    spawnSync: makeStubSpawnSync({ status: 0, stdout: 'codex 0.130.0\n' }),
    logger,
    fsApi,
    persistedVersionPath: pversionPath,
  });
  assert.equal(result.ok, true);
  assert.equal(result.observed, '0.130.0');
  assert.equal(result.persisted, null, 'first-run persisted-was should be null');
  assert.equal(result.driftDetected, false);
  assert.equal(logger.warns.length, 0, 'first-run baseline must not warn');
  assert.equal(fsApi.store.get(pversionPath), '0.130.0\n', 'expected persisted file written with observed version');
});

test('probeCodexVersion drift: WARN + update persisted when observed differs from persisted', () => {
  const logger = makeStubLogger();
  const fsApi = makeFsApi();
  const pversionPath = '/tmp/test-drift-version';
  fsApi.store.set(pversionPath, '0.129.0\n');

  const result = probeCodexVersion({
    spawnSync: makeStubSpawnSync({ status: 0, stdout: 'codex 0.130.0\n' }),
    logger,
    fsApi,
    persistedVersionPath: pversionPath,
  });
  assert.equal(result.ok, false);
  assert.equal(result.observed, '0.130.0');
  assert.equal(result.persisted, '0.129.0');
  assert.equal(result.driftDetected, true);
  assert.equal(logger.warns.length, 1, 'expected exactly one drift WARN');
  assert.match(
    logger.warns[0],
    /version drift detected.*observed=0\.130\.0.*persisted=0\.129\.0/,
    'drift WARN must include observed and persisted values'
  );
  assert.equal(fsApi.store.get(pversionPath), '0.130.0\n', 'persisted file should self-heal to observed');
});

test('probeCodexVersion stable: NO warn when observed matches persisted', () => {
  const logger = makeStubLogger();
  const fsApi = makeFsApi();
  const pversionPath = '/tmp/test-stable-version';
  fsApi.store.set(pversionPath, '0.130.0\n');

  const result = probeCodexVersion({
    spawnSync: makeStubSpawnSync({ status: 0, stdout: 'codex 0.130.0\n' }),
    logger,
    fsApi,
    persistedVersionPath: pversionPath,
  });
  assert.equal(result.ok, true);
  assert.equal(result.driftDetected, false);
  assert.equal(logger.warns.length, 0, 'stable install must not warn');
});

test('probeCodexVersion pin: WARN when CODEX_PINNED_VERSION differs from observed', () => {
  const logger = makeStubLogger();
  const fsApi = makeFsApi();
  const pversionPath = '/tmp/test-pin-version';
  // Stable persisted (so drift path is silent); pin path independently fires.
  fsApi.store.set(pversionPath, '0.130.0\n');

  const result = probeCodexVersion({
    pinnedVersion: '0.131.0',
    spawnSync: makeStubSpawnSync({ status: 0, stdout: 'codex 0.130.0\n' }),
    logger,
    fsApi,
    persistedVersionPath: pversionPath,
  });
  assert.equal(result.ok, false);
  assert.equal(result.pinnedMismatch, true);
  assert.equal(result.driftDetected, false);
  assert.equal(logger.warns.length, 1, 'expected exactly one pin WARN');
  assert.match(
    logger.warns[0],
    /version pin mismatch.*observed=0\.130\.0.*pinned=0\.131\.0/,
    'pin WARN must include observed and pinned values'
  );
});

test('probeCodexVersion pin + drift can both fire on the same call', () => {
  const logger = makeStubLogger();
  const fsApi = makeFsApi();
  const pversionPath = '/tmp/test-pin-drift-version';
  fsApi.store.set(pversionPath, '0.128.0\n');

  const result = probeCodexVersion({
    pinnedVersion: '0.131.0',
    spawnSync: makeStubSpawnSync({ status: 0, stdout: 'codex 0.130.0\n' }),
    logger,
    fsApi,
    persistedVersionPath: pversionPath,
  });
  assert.equal(result.ok, false);
  assert.equal(result.driftDetected, true);
  assert.equal(result.pinnedMismatch, true);
  assert.equal(logger.warns.length, 2, 'expected drift WARN and pin WARN — independent paths');
});

test('probeCodexVersion handles spawn throw by returning reason="probe-error"', () => {
  const logger = makeStubLogger();
  const result = probeCodexVersion({
    spawnSync: () => { throw new Error('ENOENT'); },
    logger,
    fsApi: makeFsApi(),
    persistedVersionPath: '/tmp/test-throw',
  });
  assert.equal(result.ok, null);
  assert.equal(result.reason, 'probe-error');
  assert.equal(logger.warns.length, 0);
});
