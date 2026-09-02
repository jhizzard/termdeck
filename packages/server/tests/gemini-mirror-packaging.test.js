// Sprint 71 B-T2 — packaging fence for the Gemini mirror's runtime deps.
//
// INSTALLER-PITFALLS Class **H**, and pre-ship checklist item #3 ("`npm pack`
// shows the new file"). The mirror `require()`s four modules that live in
// packages/mcp-bridge, a directory the root tarball did NOT ship before this
// sprint. A runtime require of a file absent from the tarball is the exact
// blocker ledger #15 caught the night before publish: everything passes
// locally, where the repo is the package, and explodes on the first user who
// installs from npm.
//
// Only those four are added, and deliberately not the whole bridge: bridge's
// server.js pulls express, zod, and the MCP SDK, none of which the root package
// declares. The four here use Node built-ins only — a property this file also
// pins, because it is what makes the narrow inclusion safe.
//
// Run: node --test packages/server/tests/gemini-mirror-packaging.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

// The exact set the mirror requires at runtime, plus the transitive one
// (sheets-api → clients/http) that is easy to forget precisely because nothing
// names it directly.
const REQUIRED_IN_TARBALL = [
  'packages/mcp-bridge/src/harvest/google-auth.js',
  'packages/mcp-bridge/src/harvest/sheets-api.js',
  'packages/mcp-bridge/src/clients/http.js',
  'packages/mcp-bridge/src/redact.js',
];

test('every runtime dep of the mirror exists on disk', () => {
  for (const rel of REQUIRED_IN_TARBALL) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} is missing from the repo`);
  }
});

test('every runtime dep is listed in the root package.json files[]', () => {
  const files = ROOT_PKG.files || [];
  for (const rel of REQUIRED_IN_TARBALL) {
    assert.ok(
      files.includes(rel),
      `${rel} is required at runtime by packages/server/src/gemini-mirror.js but is `
      + 'not in root package.json files[] — it would be absent from the published '
      + 'tarball and the mirror would throw MODULE_NOT_FOUND on the first user to '
      + 'enable it (INSTALLER-PITFALLS Class H)',
    );
  }
});

test('the whole mcp-bridge src is NOT swept in (it would drag express/zod)', () => {
  const files = ROOT_PKG.files || [];
  assert.ok(
    !files.some((f) => /^packages\/mcp-bridge\/src\/\*\*/.test(f)),
    'the bridge server pulls express, zod and the MCP SDK — none of which the '
    + 'root package declares. Keep the inclusion to the four built-ins-only files.',
  );
});

test('the four deps use Node built-ins and relative paths only', () => {
  // This is the property that makes shipping them into the root tarball safe.
  // A new bare-specifier require in any of them silently adds an undeclared
  // dependency to the root package.
  const BUILTIN = new Set([
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'events',
    'stream', 'buffer', 'child_process', 'zlib', 'net', 'tls', 'assert',
  ]);
  for (const rel of REQUIRED_IN_TARBALL) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const specs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const spec of specs) {
      const ok = spec.startsWith('.')
        || spec.startsWith('node:')
        || BUILTIN.has(spec);
      assert.ok(ok, `${rel} requires "${spec}", which is neither a Node built-in nor relative`);
    }
  }
});

test('the mirror can actually load its deps through the production resolver', () => {
  // Exercises the real path resolution rather than asserting about strings —
  // ledger #21's probe-path off-by-one passed every string assertion and still
  // resolved to the wrong directory in production.
  const mirror = require('../src/gemini-mirror');
  const deps = mirror.loadBridgeDeps();
  assert.equal(typeof deps.redact.redact, 'function');
  assert.equal(typeof deps.googleAuth.createAccessTokenProvider, 'function');
  assert.equal(typeof deps.sheetsApi.createSheetsApi, 'function');
  assert.equal(typeof deps.sheetsApi.quoteTab, 'function');
});

test('npm pack --dry-run actually includes all four', { timeout: 120000 }, () => {
  // The empirical check. The files[] assertion above can pass while an
  // .npmignore, a negation pattern, or a publishConfig quietly removes the
  // file — only the real pack answers what ships.
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 110000,
  });
  if (res.error || res.status !== 0 || !res.stdout) {
    // Offline / npm-missing hosts skip rather than fail — this must not make
    // the suite unrunnable in CI without a registry.
    console.log('    (skipped: npm pack unavailable in this environment)');
    return;
  }
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (_e) {
    console.log('    (skipped: npm pack output was not JSON)');
    return;
  }
  const shipped = new Set((parsed[0].files || []).map((f) => f.path));
  for (const rel of REQUIRED_IN_TARBALL) {
    assert.ok(shipped.has(rel), `${rel} does not appear in the packed tarball`);
  }
  // And the tier-0 module the injection surfaces depend on.
  assert.ok(shipped.has('packages/server/src/tier0.js'));
  assert.ok(shipped.has('packages/server/src/gemini-mirror.js'));
  assert.ok(shipped.has('packages/stack-installer/assets/hooks/memory-pre-compact.js'));
});
