// Sprint 79 T3 — doctrine-sync shape + behavior tests: naming determinism
// (no stored pr_url — branch/doc/registry-entry ids must be recomputable
// from a rumen doctrine_registry row alone), registry-entry validity +
// budgets (<=200-char advisory.one_line), front-matter presence in the
// rendered doc, the forbidden-string scrub blocking a denylisted row, and
// runPreflight's gating behavior. These are BEHAVIOR tests (not file-
// existence) per INSTALLER-PITFALLS ledger #16, in packages/server/tests/ —
// the canonical npm-test glob (a root tests/ dir silently never runs).
//
// Run: node --test packages/server/tests/doctrine-registry-shape.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const doctrineSync = require('../src/doctrine-sync');
const doctrine = require('../../../doctrine');
const render = require('../../../doctrine/render'); // Sprint 81 T4 — extracted render/naming module

const GITLEAKS_BIN = '/usr/local/bin/gitleaks';
const SENTINEL = 'FORBIDDEN-SENTINEL-D0C7R1NE';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sampleRow(overrides = {}) {
  return Object.assign({
    id: '12345678-abcd-4ef0-8123-456789abcdef',
    status: 'drafted',
    title: 'Auditors must post CHECKPOINT every 15 minutes',
    doctrine_text: 'A Codex auditor panel that compacts mid-sprint loses in-context audit state; posting a CHECKPOINT at every phase boundary and at least every 15 minutes lets it self-orient from STATUS.md alone.',
    cluster_member_ids: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
    member_content_hashes: ['aaa', 'bbb'],
    occurrence_count: 8,
    reinforced_after_ratification: 0,
    projects: ['termdeck', 'forecede'],
    origin: 'doctrine-scan',
    evidence: [
      { date: '2026-05-21', gist: 'auditor panel compacted mid-sprint, lost track of verified items' },
      { date: '2026-06-01', gist: 'second panel recurrence, same failure shape' },
    ],
    trigger_hints: ['sprint-audit'],
    rejection_reason: null,
    synthesized_at: '2026-07-01T00:00:00.000Z',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  }, overrides);
}

// ---------------------------------------------------------------------------
// Sprint 81 T4 — render.js extraction guard. The render + naming helpers moved
// to the shared zero-dep doctrine/render.js; doctrine-sync requires + re-exports
// them. Pin the invariant that the re-exports are the SAME function objects (a
// pure move, not a fork) AND that the extracted module works required directly.
// ---------------------------------------------------------------------------

test('doctrine-sync re-exports ARE the doctrine/render functions (pure move, not a fork)', () => {
  for (const name of ['slugify', 'shortId', 'branchNameFor', 'docRelPathFor', 'registryEntryIdFor', 'renderDoctrineMarkdown', 'buildRegistryEntry']) {
    assert.equal(typeof render[name], 'function', `doctrine/render exports ${name}`);
    assert.equal(doctrineSync[name], render[name], `doctrine-sync.${name} IS doctrine/render.${name} (re-export, not a copy)`);
  }
  // render.js is zero-dep — requiring it must not have pulled fs/path/os/child_process
  // deps in a way that changes doctrine-sync's still-present exports.
  assert.equal(typeof doctrineSync.runPreflight, 'function', 'doctrine-sync keeps its own git/preflight surface');
  assert.equal(typeof doctrineSync.screenableFromRow, 'function', 'screenableFromRow stayed in doctrine-sync (scrub-prep, not render)');
});

test('doctrine/render works required directly (independent of doctrine-sync)', () => {
  const row = sampleRow();
  const md = render.renderDoctrineMarkdown(row);
  assert.ok(md.startsWith('---\n'), 'direct render emits front-matter');
  assert.ok(md.includes('## Principle'), 'direct render emits the Principle section');
  const entry = render.buildRegistryEntry(row, render.docRelPathFor(row));
  assert.equal(entry.id, render.registryEntryIdFor(row));
  assert.equal(doctrine.validateEntry(entry).valid, true, 'directly-built entry validates');
  assert.equal(render.branchNameFor(row), `doctrine/${render.shortId(row.id)}-${render.slugify(row.title)}`);
});

// ---------------------------------------------------------------------------
// Naming determinism — the load-bearing substitute for a pr_url column.
// ---------------------------------------------------------------------------

test('shortId/branchNameFor/docRelPathFor/registryEntryIdFor are pure functions of the row alone (no clock, no counter)', () => {
  const row = sampleRow();
  const a = {
    shortId: doctrineSync.shortId(row.id),
    branch: doctrineSync.branchNameFor(row),
    doc: doctrineSync.docRelPathFor(row),
    entryId: doctrineSync.registryEntryIdFor(row),
  };
  const b = {
    shortId: doctrineSync.shortId(row.id),
    branch: doctrineSync.branchNameFor(row),
    doc: doctrineSync.docRelPathFor(row),
    entryId: doctrineSync.registryEntryIdFor(row),
  };
  assert.deepEqual(a, b, 'identical row -> identical names, called twice, no ambient state involved');
  assert.equal(a.shortId, '12345678');
  assert.ok(a.branch.startsWith('doctrine/12345678-'), `branch should be deterministic from id: ${a.branch}`);
  assert.ok(a.doc.startsWith('docs/doctrine/D-12345678-'), `doc path should be deterministic from id: ${a.doc}`);
  assert.equal(a.entryId, 'doctrine-scan-12345678');
});

test('slugify handles empty/weird titles without throwing', () => {
  assert.equal(doctrineSync.slugify(''), 'untitled');
  assert.equal(doctrineSync.slugify(null), 'untitled');
  assert.equal(doctrineSync.slugify('!!!???'), 'untitled');
  assert.ok(doctrineSync.slugify('A'.repeat(200)).length <= 60, 'slug is bounded');
});

// ---------------------------------------------------------------------------
// Registry entry — must pass doctrine.validateEntry() + respect the
// 200-char advisory.one_line budget (SCHEMA.md; validateEntry enforces it).
// ---------------------------------------------------------------------------

test('buildRegistryEntry produces a valid doctrine registry entry', () => {
  const row = sampleRow();
  const entry = doctrineSync.buildRegistryEntry(row, doctrineSync.docRelPathFor(row));
  const v = doctrine.validateEntry(entry);
  assert.equal(v.valid, true, `entry should validate: ${v.errors.join('; ')}`);
  assert.equal(entry.status, 'proposed', 'materialized entries land as proposed, never active/ratified (status-enum bridge)');
  assert.equal(entry.id, doctrineSync.registryEntryIdFor(row));
});

test('buildRegistryEntry truncates a long doctrine_text to the 200-char advisory.one_line budget', () => {
  const row = sampleRow({ doctrine_text: 'x'.repeat(500) });
  const entry = doctrineSync.buildRegistryEntry(row, doctrineSync.docRelPathFor(row));
  assert.ok(entry.advisory.one_line.length <= 200, `one_line should be <=200 chars, got ${entry.advisory.one_line.length}`);
  const v = doctrine.validateEntry(entry);
  assert.equal(v.valid, true, `truncated entry should still validate: ${v.errors.join('; ')}`);
});

test('buildRegistryEntry never claims block on the inject-advisory surface it uses', () => {
  const row = sampleRow();
  const entry = doctrineSync.buildRegistryEntry(row, doctrineSync.docRelPathFor(row));
  assert.equal(entry.enforcement.surface, 'inject-advisory');
  assert.equal(entry.enforcement.max_severity, 'warn', 'materialized entries are advisory only until a human runs `termdeck doctrine promote`');
});

// ---------------------------------------------------------------------------
// Rendered markdown — front-matter schema + registry<->doc bijection (the
// entry's `enforcement.ref`/`advisory.procedure_path` point at the SAME path
// the markdown is written to, and the doc's own front-matter id agrees with
// the registry entry's shortId).
// ---------------------------------------------------------------------------

test('renderDoctrineMarkdown emits well-formed front-matter that agrees with the registry entry', () => {
  const row = sampleRow();
  const docPath = doctrineSync.docRelPathFor(row);
  const entry = doctrineSync.buildRegistryEntry(row, docPath);
  const md = doctrineSync.renderDoctrineMarkdown(row);

  assert.ok(md.startsWith('---\n'), 'starts with a front-matter block');
  const closeIdx = md.indexOf('\n---\n', 4);
  assert.ok(closeIdx > 0, 'front-matter block is closed');
  const front = md.slice(4, closeIdx);
  assert.ok(front.includes(`id: D-${doctrineSync.shortId(row.id)}`), 'front-matter id matches the deterministic shortId');
  assert.ok(front.includes('status: proposed'), 'front-matter status matches the registry entry status');
  assert.ok(front.includes('source: rumen-doctrine-scan'));

  // registry<->doc bijection: the entry's ref/procedure_path point at exactly
  // where this markdown will be written.
  assert.equal(entry.enforcement.ref, docPath);
  assert.equal(entry.advisory.procedure_path, docPath);

  // The five required sections are present (Principle / Why-evidence-ledger /
  // How-to-apply / Machine-checkable-hook / Provenance).
  for (const heading of ['## Principle', '## Why (evidence ledger)', '## How to apply', '## Machine-checkable hook', '## Provenance']) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(md.includes(row.id), 'provenance section cites the rumen doctrine_registry row id');
});

test('renderDoctrineMarkdown degrades gracefully on a row with no evidence/trigger_hints', () => {
  const row = sampleRow({ evidence: [], trigger_hints: [] });
  const md = doctrineSync.renderDoctrineMarkdown(row);
  assert.ok(md.includes('(no evidence entries recorded)'));
  assert.ok(md.includes('advisory-only until a future doctrine-scan adds them'), 'empty trigger_hints falls back to the advisory-only note, not a crash or blank section');
  assert.ok(!md.includes('shadow-mode only'), 'the shadow-mode note is specific to the has-trigger-hints branch');
});

test('renderDoctrineMarkdown marks real trigger_hints as shadow-mode only (AMEND-7 — never injected pre-ratification)', () => {
  const row = sampleRow({ trigger_hints: ['npm test failed', 'EADDRINUSE'] });
  const md = doctrineSync.renderDoctrineMarkdown(row);
  assert.ok(md.includes('- npm test failed'));
  assert.ok(md.includes('- EADDRINUSE'));
  assert.ok(md.includes('shadow-mode only'), 'trigger hints must be flagged shadow-mode only, never presented as already-active');
});

// ---------------------------------------------------------------------------
// Scrub — REUSE of doctrine/index.js::screenEntries (no new mechanism). A
// row whose rendered content contains a denylisted string must be BLOCKED
// (screenableFromRow routes the whole markdown through source.incident).
// ---------------------------------------------------------------------------

test('screenableFromRow + doctrine.screenEntries blocks a row whose content trips the scrub', () => {
  const dir = tmpDir('doctrine-sync-screen-');
  try {
    const cfg = path.join(dir, 'screen.toml');
    fs.writeFileSync(cfg, `title = "doctrine-sync screen test"\n[[rules]]\nid = "doctrine-sync-sentinel"\ndescription = "test sentinel"\nregex = '''${SENTINEL}'''\n`);

    const cleanRow = sampleRow({ id: '33333333-3333-4333-8333-333333333333' });
    const trippingRow = sampleRow({
      id: '44444444-4444-4444-8444-444444444444',
      doctrine_text: `Contains the leaked value ${SENTINEL} inline.`,
    });

    for (const row of [cleanRow, trippingRow]) {
      const entry = doctrineSync.buildRegistryEntry(row, doctrineSync.docRelPathFor(row));
      const md = doctrineSync.renderDoctrineMarkdown(row);
      const screenable = doctrineSync.screenableFromRow(entry, md);
      const screened = doctrine.screenEntries([screenable], { gitleaksBin: GITLEAKS_BIN, gitleaksConfig: cfg });
      if (row === cleanRow) {
        assert.equal(screened.length, 1, 'clean row survives the scrub');
      } else {
        assert.equal(screened.length, 0, 'tripping row is BLOCKED by the scrub');
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scrub is fail-soft when gitleaks is absent (entry retained, no throw)', () => {
  const row = sampleRow({ doctrine_text: `would-trip ${SENTINEL} if gitleaks ran` });
  const entry = doctrineSync.buildRegistryEntry(row, doctrineSync.docRelPathFor(row));
  const md = doctrineSync.renderDoctrineMarkdown(row);
  const screenable = doctrineSync.screenableFromRow(entry, md);
  let screened;
  assert.doesNotThrow(() => {
    screened = doctrine.screenEntries([screenable], { gitleaksBin: '/nonexistent/path/to/gitleaks' });
  });
  assert.equal(screened.length, 1, 'gitleaks-absent => unscreened => entry passes (fail-soft, not fail-closed)');
});

// Sprint 79 acceptance dry-run catch: __test_processRow must forward a
// caller-supplied gitleaksConfig/gitleaksBin to screenEntries(). Without
// this, a custom test config (or, in principle, any future non-default
// gitleaks setup) silently falls back to the operator's REAL
// ~/.gitleaks.toml and a synthetic/local test sentinel never trips it —
// this exact gap let a denylisted row materialize a real worktree+PR in the
// first end-to-end acceptance run before the fix.
test('__test_processRow forwards gitleaksConfig to the scrub — a denylisted row is BLOCKED before any git operation', () => {
  const dir = tmpDir('doctrine-sync-processrow-scrub-');
  try {
    const cfg = path.join(dir, 'screen.toml');
    fs.writeFileSync(cfg, `title = "processRow scrub test"\n[[rules]]\nid = "processrow-sentinel"\ndescription = "test"\nregex = '''${SENTINEL}'''\n`);
    const row = sampleRow({
      id: '55555555-5555-4555-8555-555555555555',
      doctrine_text: `This row leaks ${SENTINEL} and must never reach git.`,
    });
    // repoPath deliberately does not exist — if the scrub block didn't fire
    // BEFORE any git/fs-worktree operation, this call would throw on a
    // missing directory instead of returning the scrub-blocked outcome.
    const fakeRepoPath = path.join(dir, 'does-not-exist-as-a-repo');
    return doctrineSync.__test_processRow(fakeRepoPath, row, doctrine, { gitleaksBin: GITLEAKS_BIN, gitleaksConfig: cfg })
      .then((outcome) => {
        assert.equal(outcome.ok, false);
        assert.equal(outcome.reason, 'scrub-blocked');
      });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Preflight — default-OFF gating (AMEND-3). Every failure mode returns
// { ok:false, reason } and NEVER throws; only a fully-healthy repo passes.
// ---------------------------------------------------------------------------

function initGitRepo(dir, remoteUrl) {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remoteUrl]);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
}

test('runPreflight fails with no repoPath', () => {
  const r = doctrineSync.runPreflight(null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not set/);
});

test('runPreflight fails on a relative path', () => {
  const r = doctrineSync.runPreflight('relative/path');
  assert.equal(r.ok, false);
  assert.match(r.reason, /absolute/);
});

test('runPreflight fails on a path that does not exist', () => {
  const r = doctrineSync.runPreflight(path.join(os.tmpdir(), 'doctrine-sync-does-not-exist-xyz'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not exist/);
});

test('runPreflight fails on a directory that is not a git repo', () => {
  const dir = tmpDir('doctrine-sync-notgit-');
  try {
    const r = doctrineSync.runPreflight(dir);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a git working tree/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runPreflight fails when the origin remote does not look like termdeck', () => {
  const dir = tmpDir('doctrine-sync-wrongremote-');
  try {
    initGitRepo(dir, 'git@github.com:someone/unrelated-repo.git');
    const r = doctrineSync.runPreflight(dir);
    assert.equal(r.ok, false);
    assert.match(r.reason, /origin remote/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runPreflight fails when gitleaks is absent, even with a correct repo + remote', () => {
  const dir = tmpDir('doctrine-sync-nogitleaks-');
  try {
    initGitRepo(dir, 'git@github.com:jhizzard/termdeck.git');
    const r = doctrineSync.runPreflight(dir, { gitleaksBin: '/nonexistent/gitleaks' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /gitleaks/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runPreflight passes on a correctly-configured repo (real gh + real gitleaks in this environment)', () => {
  const dir = tmpDir('doctrine-sync-ok-');
  try {
    initGitRepo(dir, 'git@github.com:jhizzard/termdeck.git');
    const r = doctrineSync.runPreflight(dir);
    assert.equal(r.ok, true, `expected preflight to pass: ${r.reason || ''}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// maybeStart — default-OFF: absent env var never registers a timer, and
// preflight failure logs + never registers either. Both must be provably
// off (no dangling interval) rather than merely "quiet."
// ---------------------------------------------------------------------------

test('maybeStart never registers a timer when TERMDECK_DOCTRINE_REPO is unset', () => {
  const prev = process.env.TERMDECK_DOCTRINE_REPO;
  delete process.env.TERMDECK_DOCTRINE_REPO;
  try {
    const r = doctrineSync.maybeStart();
    assert.equal(r.started, false);
    assert.equal(r.reason, 'env-not-set');
  } finally {
    if (prev !== undefined) process.env.TERMDECK_DOCTRINE_REPO = prev;
    doctrineSync.stop();
  }
});

test('maybeStart never registers a timer when preflight fails', () => {
  const dir = tmpDir('doctrine-sync-maybestart-');
  try {
    // no git init -> preflight fails
    const r = doctrineSync.maybeStart({ repoPath: dir });
    assert.equal(r.started, false);
    assert.notEqual(r.reason, undefined);
  } finally {
    doctrineSync.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maybeStart registers an unref\'d timer when preflight passes, and stop() clears it', () => {
  const dir = tmpDir('doctrine-sync-maybestart-ok-');
  try {
    initGitRepo(dir, 'git@github.com:jhizzard/termdeck.git');
    const r = doctrineSync.maybeStart({ repoPath: dir, intervalMs: 3600000 });
    assert.equal(r.started, true);
    assert.ok(r.timer, 'a timer handle is returned');
    // unref'd timers still expose .hasRef() in modern Node; assert it's false
    // when available (best-effort — some Node versions may lack the method).
    if (typeof r.timer.hasRef === 'function') {
      assert.equal(r.timer.hasRef(), false, 'timer must be unref\'d so it never keeps the process alive');
    }
  } finally {
    doctrineSync.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// doctrine module resolution — fail-soft NULL-object fallback (advisor/
// index.js's established pattern), so a missing/broken doctrine module never
// throws into the cycle.
// ---------------------------------------------------------------------------

test('_setDoctrineForTest/_resetDoctrineForTest correctly override and restore the module cache', () => {
  const fakeDoctrine = { screenEntries: (entries) => entries, validateEntry: () => ({ valid: true, errors: [] }) };
  doctrineSync._setDoctrineForTest(fakeDoctrine);
  try {
    assert.equal(doctrineSync.resolveDoctrine(), fakeDoctrine, 'resolveDoctrine returns the injected fake while set');
  } finally {
    doctrineSync._resetDoctrineForTest();
  }
  // After reset, resolution falls through to the real repo-root doctrine
  // module (present in this checkout) rather than staying pinned to the fake.
  const resolved = doctrineSync.resolveDoctrine();
  assert.notEqual(resolved, fakeDoctrine, 'reset clears the injected fake');
  assert.equal(typeof resolved.screenEntries, 'function', 'the real module is a valid screenEntries provider');
});

// ---------------------------------------------------------------------------
// Sprint 78 regression guard — pre-existing doctrine suites must keep
// passing (they run in the same `node --test` glob; no separate assertion
// needed here beyond confirming the module still loads cleanly together).
// ---------------------------------------------------------------------------

test('doctrine/index.js still loads its full seed registry cleanly alongside doctrine-sync', () => {
  const entries = doctrine.loadDoctrine({ noCache: true });
  assert.ok(entries.length >= 12, 'Sprint 78 seed registry still loads');
});
