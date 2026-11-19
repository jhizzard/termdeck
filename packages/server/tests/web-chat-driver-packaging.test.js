// Packaging fence for the web-chat driver (INSTALLER-PITFALLS Class H).
//
// 1.22.0 shipped the web-chat panel type in the server and the client but not
// packages/web-chat-driver, so on every npm install a web-chat panel errored
// "web-chat driver not available" (reported by a TermDeck user on Nov 6). The
// server requires the driver by RELATIVE path ('../../web-chat-driver'), so the
// driver's package.json and src must be in the root tarball, and its one npm
// dependency (playwright-core) must be declared by the root package. It is
// optional: the server already degrades a web-chat panel to 'errored' when the
// driver cannot load, and PTY panels never touch it.
//
// Run: node --test packages/server/tests/web-chat-driver-packaging.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const DRIVER = 'packages/web-chat-driver';
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const SRC = walk(path.join(REPO_ROOT, DRIVER, 'src'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
const BUILTIN = new Set(builtinModules);
// Code lines only: the driver's comments mention require('playwright') to say it never does.
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the driver files the server loads exist', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, DRIVER, 'package.json')));
  assert.ok(SRC.includes(`${DRIVER}/src/index.js`));
  assert.ok(SRC.includes(`${DRIVER}/src/grok/index.js`));
});

test('root files[] ships the driver package.json and its whole src, and not its tests', () => {
  const files = ROOT_PKG.files || [];
  assert.ok(files.includes(`${DRIVER}/package.json`), 'without it the relative require cannot find main');
  assert.ok(files.includes(`${DRIVER}/src/**`));
  assert.ok(!files.some((f) => f === `${DRIVER}/**` || f.startsWith(`${DRIVER}/tests`)), 'tests and fixtures stay out');
});

test('every npm require in the driver is declared by the root package', () => {
  const declared = { ...(ROOT_PKG.dependencies || {}), ...(ROOT_PKG.optionalDependencies || {}) };
  for (const rel of SRC) {
    const src = code(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('node:') || BUILTIN.has(spec)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      assert.ok(declared[name], `${rel} requires "${spec}", which the root package does not declare`);
    }
  }
  assert.ok(ROOT_PKG.optionalDependencies && ROOT_PKG.optionalDependencies['playwright-core'],
    'playwright-core is optional: a failed install must not break the PTY server');
});

test('the server\'s relative path resolves to the driver entry point', () => {
  // packages/server/src/index.js does require('../../web-chat-driver').
  const resolved = require.resolve(path.join(REPO_ROOT, 'packages', 'server', 'src', '..', '..', 'web-chat-driver'));
  assert.equal(path.relative(REPO_ROOT, resolved).split(path.sep).join('/'), `${DRIVER}/src/index.js`);
});

test('npm pack --dry-run includes the driver and leaves its tests out', { timeout: 120000 }, () => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 110000,
  });
  if (res.error || res.status !== 0 || !res.stdout) {
    console.log('    (skipped: npm pack unavailable in this environment)');
    return;
  }
  const paths = JSON.parse(res.stdout)[0].files.map((f) => f.path);
  for (const rel of SRC) assert.ok(paths.includes(rel), `${rel} is missing from the tarball`);
  assert.ok(paths.includes(`${DRIVER}/package.json`));
  assert.ok(!paths.some((p) => p.startsWith(`${DRIVER}/tests/`)), 'driver tests must not ship');
});
