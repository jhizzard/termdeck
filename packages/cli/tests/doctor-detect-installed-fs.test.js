'use strict';
// Sprint 8K hotfix (2026-09-01): `termdeck doctor` reported a fully-installed
// stack as "4 of 4 not installed" because its only probe was `npm ls -g`
// with an 8 s timeout, and under host load (8-panel sprint, load avg 672)
// that probe took 25-27 s. Detection is now filesystem-first. These tests
// pin: (1) the fs reader returns the version from <root>/<pkg>/package.json,
// (2) it returns null (not a throw) for a missing package or a null root so
// the npm fallback still runs, (3) `_detectInstalled` prefers the fs answer
// and never spawns npm when the fs read succeeds.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const doctor = require('../src/doctor.js');

function makeRoot(pkgs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-doctor-fs-'));
  for (const [name, version] of Object.entries(pkgs)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
  return root;
}

test('_readInstalledVersionFromFs reads the version from <root>/<pkg>/package.json', () => {
  const root = makeRoot({ '@jhizzard/mnestra': '0.11.0', '@jhizzard/termdeck': '1.20.1' });
  assert.strictEqual(doctor._readInstalledVersionFromFs('@jhizzard/mnestra', root), '0.11.0');
  assert.strictEqual(doctor._readInstalledVersionFromFs('@jhizzard/termdeck', root), '1.20.1');
});

test('_readInstalledVersionFromFs returns null for a missing package, a malformed package.json, or a null root', () => {
  const root = makeRoot({ '@jhizzard/rumen': '0.4.4' });
  fs.mkdirSync(path.join(root, '@jhizzard', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(root, '@jhizzard', 'broken', 'package.json'), '{not json');
  assert.strictEqual(doctor._readInstalledVersionFromFs('@jhizzard/termdeck-stack', root), null);
  assert.strictEqual(doctor._readInstalledVersionFromFs('@jhizzard/broken', root), null);
  assert.strictEqual(doctor._readInstalledVersionFromFs('@jhizzard/rumen', null), null);
});

test('_globalNodeModulesRoot only answers when the CLI runs from inside a node_modules tree', () => {
  const root = doctor._globalNodeModulesRoot();
  // From a repo checkout this is null (npm fallback); from a global install it ends in node_modules.
  assert.ok(root === null || path.basename(root) === 'node_modules');
});

test('_detectInstalled prefers the filesystem answer and only falls through to npm when the fs probe is null', async () => {
  const realFs = doctor._readInstalledVersionFromFs;
  const realNpm = doctor._detectInstalledViaNpm;
  let npmCalls = 0;
  doctor._detectInstalledViaNpm = async () => { npmCalls++; return '9.9.9'; };
  try {
    // GREEN path: fs answers → npm must NOT be spawned.
    doctor._readInstalledVersionFromFs = () => '0.11.0';
    assert.strictEqual(await doctor._detectInstalled('@jhizzard/mnestra'), '0.11.0');
    assert.strictEqual(npmCalls, 0, 'npm must not run when the fs probe succeeds');
    // RED path: fs returns null → the npm fallback must run and its answer is used.
    doctor._readInstalledVersionFromFs = () => null;
    assert.strictEqual(await doctor._detectInstalled('@jhizzard/rumen'), '9.9.9');
    assert.strictEqual(npmCalls, 1, 'npm fallback must run exactly once when the fs probe returns null');
  } finally {
    doctor._readInstalledVersionFromFs = realFs;
    doctor._detectInstalledViaNpm = realNpm;
  }
});
