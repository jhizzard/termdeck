// Sprint 36 T3 Deliverable A — unit tests for updateConfig() in
// packages/server/src/config.js. The helper backs PATCH /api/config: it
// validates a patch against a whitelist, atomically rewrites the YAML file,
// and writes a timestamped .bak before overwrite.
//
// These tests exercise the path-injectable form of updateConfig so we don't
// touch ~/.termdeck/config.yaml on the developer's machine. The production
// caller (packages/server/src/index.js → PATCH /api/config) uses the default
// argument, which resolves to ~/.termdeck/config.yaml.
//
// Run: node --test tests/config-update.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');

const { updateConfig, _flattenPatch, _UPDATABLE_PATHS } = require(
  path.resolve(__dirname, '..', 'packages', 'server', 'src', 'config.js')
);

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-config-test-'));
}

function writeYaml(filePath, obj) {
  fs.writeFileSync(filePath, yaml.stringify(obj), 'utf-8');
}

test('updateConfig: rejects non-object patch', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  assert.throws(() => updateConfig(null, cfg), /must be a plain object/);
  assert.throws(() => updateConfig('rag.enabled=true', cfg), /must be a plain object/);
  assert.throws(() => updateConfig([{ rag: { enabled: true } }], cfg), /must be a plain object/);
});

test('updateConfig: rejects empty patch', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  assert.throws(() => updateConfig({}, cfg), /patch is empty/);
});

test('updateConfig: rejects keys outside the whitelist', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  writeYaml(cfg, { rag: { enabled: false } });
  assert.throws(() => updateConfig({ port: 4000 }, cfg), /not in the updatable whitelist/);
  assert.throws(() => updateConfig({ rag: { syncIntervalMs: 5000 } }, cfg), /not in the updatable whitelist/);
  assert.throws(() => updateConfig({ shell: '/bin/sh' }, cfg), /not in the updatable whitelist/);
});

test('updateConfig: rejects rag.enabled with non-boolean value', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  writeYaml(cfg, { rag: { enabled: false } });
  assert.throws(() => updateConfig({ rag: { enabled: 'yes' } }, cfg), /must be a boolean/);
  assert.throws(() => updateConfig({ rag: { enabled: 1 } }, cfg), /must be a boolean/);
});

test('updateConfig: writes rag.enabled=true to disk', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  writeYaml(cfg, { port: 3000, rag: { enabled: false, syncIntervalMs: 10000 } });

  const result = updateConfig({ rag: { enabled: true } }, cfg);
  assert.equal(result.rag.enabled, true);
  // syncIntervalMs preserved — patch did not touch it
  assert.equal(result.rag.syncIntervalMs, 10000);
  // unrelated keys preserved
  assert.equal(result.port, 3000);

  const reloaded = yaml.parse(fs.readFileSync(cfg, 'utf-8'));
  assert.equal(reloaded.rag.enabled, true);
  assert.equal(reloaded.rag.syncIntervalMs, 10000);
  assert.equal(reloaded.port, 3000);
});

test('updateConfig: round-trips rag.enabled=false', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  writeYaml(cfg, { rag: { enabled: true } });

  updateConfig({ rag: { enabled: false } }, cfg);
  const reloaded = yaml.parse(fs.readFileSync(cfg, 'utf-8'));
  assert.equal(reloaded.rag.enabled, false);
});

test('updateConfig: writes a .bak before overwriting', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  writeYaml(cfg, { rag: { enabled: false } });

  updateConfig({ rag: { enabled: true } }, cfg);

  const baks = fs.readdirSync(dir).filter(f => f.startsWith('config.yaml.') && f.endsWith('.bak'));
  assert.equal(baks.length, 1, 'exactly one .bak written');
  const bakContent = yaml.parse(fs.readFileSync(path.join(dir, baks[0]), 'utf-8'));
  assert.equal(bakContent.rag.enabled, false, '.bak captures the pre-write state');
});

test('updateConfig: creates rag block when missing', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  writeYaml(cfg, { port: 3000 });

  updateConfig({ rag: { enabled: true } }, cfg);
  const reloaded = yaml.parse(fs.readFileSync(cfg, 'utf-8'));
  assert.equal(reloaded.rag.enabled, true);
  assert.equal(reloaded.port, 3000);
});

test('updateConfig: creates a new file when none exists', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  // No pre-existing file.
  updateConfig({ rag: { enabled: true } }, cfg);
  assert.ok(fs.existsSync(cfg), 'config.yaml created');
  const reloaded = yaml.parse(fs.readFileSync(cfg, 'utf-8'));
  assert.equal(reloaded.rag.enabled, true);
});

test('updateConfig: preserves projects map verbatim', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  writeYaml(cfg, {
    projects: {
      foo: { path: '~/code/foo', defaultTheme: 'tokyo-night' },
      bar: { path: '~/code/bar' }
    },
    rag: { enabled: false }
  });

  updateConfig({ rag: { enabled: true } }, cfg);
  const reloaded = yaml.parse(fs.readFileSync(cfg, 'utf-8'));
  assert.deepEqual(reloaded.projects, {
    foo: { path: '~/code/foo', defaultTheme: 'tokyo-night' },
    bar: { path: '~/code/bar' }
  });
});

test('updateConfig: refuses to overwrite a malformed YAML file', () => {
  const dir = freshTmpDir();
  const cfg = path.join(dir, 'config.yaml');
  fs.writeFileSync(cfg, '::: not valid yaml :::\n  - [\n', 'utf-8');
  assert.throws(() => updateConfig({ rag: { enabled: true } }, cfg), /not valid YAML/);

  // File untouched
  const after = fs.readFileSync(cfg, 'utf-8');
  assert.match(after, /not valid yaml/);
});

test('flattenPatch: flattens nested objects to dotted-path entries', () => {
  assert.deepEqual(_flattenPatch({ rag: { enabled: true } }), [['rag.enabled', true]]);
  assert.deepEqual(_flattenPatch({ a: { b: { c: 1 } } }), [['a.b.c', 1]]);
  assert.deepEqual(_flattenPatch({ a: 1, b: 2 }).sort(), [['a', 1], ['b', 2]]);
  assert.deepEqual(_flattenPatch({}), []);
});

test('UPDATABLE_PATHS contract: only rag.enabled is currently writable', () => {
  // Pin the set so a future expansion is an explicit, reviewed change.
  assert.deepEqual([..._UPDATABLE_PATHS].sort(), ['rag.enabled']);
});
