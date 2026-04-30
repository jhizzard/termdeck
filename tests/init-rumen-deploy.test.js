// Regression tests for the Sprint 43 T3 multi-function deploy refactor in
// packages/cli/src/init-rumen.js + packages/server/src/setup/migrations.js.
//
// Background: pre-Sprint-43 the wizard only deployed `rumen-tick`. The
// `graph-inference` Edge Function (Sprint 38 / Sprint 42 rewrite) had to be
// manually deployed by Joshua at Sprint 42 close from the sibling rumen
// repo — that workaround did not generalize to fresh users. Sprint 43 T3:
//   1. Bundle BOTH function source trees under `packages/server/src/setup/
//      rumen/functions/`. Bundled-FIRST resolution in `migrations.js`
//      (matches `listMnestraMigrations` / `listRumenMigrations` since v0.6.8).
//   2. Stage all functions in one tmp dir with one `supabase/config.toml`
//      containing one `[functions.<name>]` block per function.
//   3. `__RUMEN_VERSION__` placeholder substitution stays scoped to
//      rumen-tick (only file with the placeholder).
//
// These fixtures pin the contract so a future drift of the function set,
// the staging layout, or the version-substitution path fails loud.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const BUNDLED_FNS_DIR = path.join(repoRoot, 'packages', 'server', 'src', 'setup', 'rumen', 'functions');

const initRumen = require(path.join(repoRoot, 'packages', 'cli', 'src', 'init-rumen.js'));
const stageRumenFunctions = initRumen._stageRumenFunctions;

function loadMigrations() {
  // Force a fresh require so SETUP_DIR resolution matches per-test state.
  const id = require.resolve(path.join(repoRoot, 'packages', 'server', 'src', 'setup', 'migrations.js'));
  delete require.cache[id];
  return require(id);
}

// ── Lowest-level invariant: both function sources are bundled on disk ──────

test('bundled rumen functions directory contains rumen-tick and graph-inference', () => {
  const subdirs = fs.readdirSync(BUNDLED_FNS_DIR)
    .filter((name) => fs.statSync(path.join(BUNDLED_FNS_DIR, name)).isDirectory())
    .sort();
  assert.deepEqual(subdirs, ['graph-inference', 'rumen-tick'],
    'Sprint 43 T3 bundled both functions; if this fails, scripts/sync-rumen-functions.sh likely was not run before publish');
});

test('rumen-tick/index.ts contains the __RUMEN_VERSION__ placeholder (not a hardcoded version)', () => {
  const src = fs.readFileSync(path.join(BUNDLED_FNS_DIR, 'rumen-tick', 'index.ts'), 'utf-8');
  assert.match(src, /__RUMEN_VERSION__/,
    'rumen-tick/index.ts must keep the placeholder; init-rumen.js substitutes at deploy time');
  assert.doesNotMatch(src, /npm:@jhizzard\/rumen@\d+\.\d+\.\d+/,
    'no concrete @jhizzard/rumen@<version> may be committed in the bundled rumen-tick source');
});

test('graph-inference/index.ts has no __RUMEN_VERSION__ placeholder (its deps are pinned at function level)', () => {
  const src = fs.readFileSync(path.join(BUNDLED_FNS_DIR, 'graph-inference', 'index.ts'), 'utf-8');
  assert.doesNotMatch(src, /__RUMEN_VERSION__/,
    'graph-inference must not carry the rumen-tick placeholder; substitution would clobber a non-existent dep');
});

// ── migrations.js exports — bundled-first resolution + listRumenFunctions ──

test('listRumenFunctions() returns both function names in lexical order', () => {
  const m = loadMigrations();
  assert.deepEqual(m.listRumenFunctions(), ['graph-inference', 'rumen-tick']);
});

test('rumenFunctionsRoot() resolves to the bundled directory under packages/server/src/setup', () => {
  const m = loadMigrations();
  const root = m.rumenFunctionsRoot();
  assert.equal(path.resolve(root), path.resolve(BUNDLED_FNS_DIR),
    'bundled-first resolution; matches the listMnestraMigrations / listRumenMigrations precedence (v0.6.8+)');
});

test('rumenFunctionDir() back-compat shim still resolves rumen-tick', () => {
  const m = loadMigrations();
  const dir = m.rumenFunctionDir();
  assert.equal(path.basename(dir), 'rumen-tick');
  assert.ok(fs.existsSync(path.join(dir, 'index.ts')));
});

// ── stageRumenFunctions(): the multi-function staging contract ─────────────

test('stageRumenFunctions() refuses an invalid rumenVersion argument', () => {
  assert.throws(() => stageRumenFunctions(undefined), /invalid rumenVersion/);
  assert.throws(() => stageRumenFunctions(''),       /invalid rumenVersion/);
  assert.throws(() => stageRumenFunctions('latest'), /invalid rumenVersion/);
  assert.throws(() => stageRumenFunctions('0.4'),    /invalid rumenVersion/);
});

test('stageRumenFunctions() creates supabase/functions/<name>/index.ts for every bundled function', () => {
  const stage = stageRumenFunctions('0.4.4');
  try {
    assert.ok(stage, 'stage dir should be returned');
    for (const name of ['rumen-tick', 'graph-inference']) {
      const indexTs = path.join(stage, 'supabase', 'functions', name, 'index.ts');
      assert.ok(fs.existsSync(indexTs), `${name}/index.ts must exist in the stage dir`);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('stageRumenFunctions() substitutes __RUMEN_VERSION__ in rumen-tick only', () => {
  const stage = stageRumenFunctions('0.9.99');
  try {
    const tick = fs.readFileSync(path.join(stage, 'supabase', 'functions', 'rumen-tick', 'index.ts'), 'utf-8');
    assert.match(tick, /npm:@jhizzard\/rumen@0\.9\.99/, 'rumen-tick must get the version substituted');
    assert.doesNotMatch(tick, /__RUMEN_VERSION__/, 'rumen-tick stage must no longer contain the placeholder after substitution');

    const graph = fs.readFileSync(path.join(stage, 'supabase', 'functions', 'graph-inference', 'index.ts'), 'utf-8');
    assert.doesNotMatch(graph, /0\.9\.99/, 'graph-inference must not be touched by the rumen-tick version substitution');
    assert.doesNotMatch(graph, /__RUMEN_VERSION__/, 'graph-inference must never contain the placeholder');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('stageRumenFunctions() copies tsconfig.json verbatim for both functions', () => {
  const stage = stageRumenFunctions('0.4.4');
  try {
    for (const name of ['rumen-tick', 'graph-inference']) {
      const staged = fs.readFileSync(path.join(stage, 'supabase', 'functions', name, 'tsconfig.json'), 'utf-8');
      const bundled = fs.readFileSync(path.join(BUNDLED_FNS_DIR, name, 'tsconfig.json'), 'utf-8');
      assert.equal(staged, bundled, `${name}/tsconfig.json must be verbatim`);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('stageRumenFunctions() emits supabase/config.toml with one [functions.<name>] block per bundled function', () => {
  const stage = stageRumenFunctions('0.4.4');
  try {
    const configToml = fs.readFileSync(path.join(stage, 'supabase', 'config.toml'), 'utf-8');
    assert.match(configToml, /\[functions\.rumen-tick\]/);
    assert.match(configToml, /\[functions\.graph-inference\]/);
    // verify_jwt = false is required for both — graph-inference is invoked
    // by pg_cron with the service-role key, rumen-tick by the same path;
    // neither uses the user JWT.
    const tickBlock = configToml.match(/\[functions\.rumen-tick\][\s\S]*?(?=\[functions\.|$)/);
    const graphBlock = configToml.match(/\[functions\.graph-inference\][\s\S]*?(?=\[functions\.|$)/);
    assert.ok(tickBlock && /verify_jwt\s*=\s*false/.test(tickBlock[0]), 'rumen-tick block must set verify_jwt = false');
    assert.ok(graphBlock && /verify_jwt\s*=\s*false/.test(graphBlock[0]), 'graph-inference block must set verify_jwt = false');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('stageRumenFunctions() creates a unique tmp directory per call (no cross-call collision)', () => {
  const a = stageRumenFunctions('0.4.4');
  const b = stageRumenFunctions('0.4.4');
  try {
    assert.notEqual(a, b, 'each call must mkdtemp a fresh dir');
    assert.ok(a.startsWith(os.tmpdir()), 'stage must be under os.tmpdir()');
    assert.ok(b.startsWith(os.tmpdir()), 'stage must be under os.tmpdir()');
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});
