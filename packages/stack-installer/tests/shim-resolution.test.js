'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// Sprint 68-REDUX · T3 fence — REAL-BINARY RESOLUTION, RECURSION, DRY-PROBE
//
// The shim's entire premise is that it can find "the real binary next on PATH
// after myself" without ever selecting itself. Get that wrong in one direction
// and the user's CLI is broken; get it wrong in the other and you have a fork
// bomb. Both failure modes are cheap to test and expensive to ship, so every
// branch of the walk gets a case here.
//
// Covers PLANNING D0.1 (skip-self resolution + recursion sentinel) and the
// TERMDECK_SHIM_PROBE contract T2 requested for the doctor probe
// (STATUS [T2] FINDING 2026-08-01 15:33 ET, item 2).
// ──────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { makeWorld } = require('./_shim-harness');

test('resolves past itself to the real binary when the shim dir is first on PATH', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const r = w.run(['--flag', 'arg with spaces']);

  assert.equal(r.status, 0);
  assert.deepEqual(w.ranTags(), ['primary'], 'the real binary must run exactly once');
  // Invariant 1 (transparency): argv survives verbatim, spaces included.
  assert.ok(
    w.markerLines().some((l) => l === 'RAN\tprimary\t--flag arg with spaces'),
    `argv not passed through verbatim: ${JSON.stringify(w.markerLines())}`,
  );
});

test('skips its own directory even when that directory appears TWICE on PATH', (t) => {
  // Duplicate PATH entries are common (rc files sourced twice, tmux, login vs
  // non-login shells). A skip-self implemented as "ignore the first match" would
  // pass the simple case and select the shim on the second pass.
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  w.prependPath(w.shimDir);

  const r = w.run([]);
  assert.equal(r.status, 0);
  assert.deepEqual(w.ranTags(), ['primary']);
  assert.ok(!/recursion detected/.test(r.stderr || ''), 'must not trip the sentinel');
});

test('first executable survivor wins when several real candidates follow', (t) => {
  const w = makeWorld({ agent: 'codex', extraReals: 2 });
  t.after(() => w.cleanup());

  const r = w.run([]);
  assert.equal(r.status, 0);
  assert.deepEqual(w.ranTags(), ['primary'], 'must take the FIRST survivor, not the last');
});

test('a non-executable candidate is skipped, not selected', (t) => {
  const w = makeWorld({ agent: 'codex', realBinary: false, extraReals: 1 });
  t.after(() => w.cleanup());
  // A same-named but non-executable file sits ahead of the real one.
  const decoy = path.join(w.binDir, 'codex');
  fs.writeFileSync(decoy, '#!/bin/bash\necho decoy\n', { mode: 0o644 });

  const r = w.run([]);
  assert.equal(r.status, 0, `expected fallthrough to the executable candidate, got ${r.status}: ${r.stderr}`);
  assert.deepEqual(w.ranTags(), ['extra-0']);
});

// ── Shim-shadows-shim (T4-CODEX AUDIT-FAIL 2026-08-01 15:40 ET) ──────────────
//
// Skipping "my own directory" and "my own realpath" is not the same as skipping
// "any TermDeck shim". A SECOND copy of the shim earlier on PATH — a stale
// install, a dotfile-synced ~/.local/bin copy, a user who moved the directory —
// is neither of those, so the walk accepts it as the real binary. Live mode then
// either trips the recursion sentinel inside that copy or never reaches the CLI.
//
// The marker line `# @termdeck/shim v<N>` is in the first 4 KB of every shim, so
// the resolver can identify one on sight. These cases stay red until it does.

function installSecondShimCopy(w, dirName) {
  const dir = path.join(w.root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(w.shimPath, path.join(dir, w.agent));
  fs.chmodSync(path.join(dir, w.agent), 0o755);
  return dir;
}

test('a SECOND shim copy earlier on PATH must be skipped, not taken as the real binary', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const earlier = installSecondShimCopy(w, 'earlier-shims');
  w.prependPath(earlier);

  const r = w.run([], { TERMDECK_SHIM_PROBE: '1' });
  const resolved = (r.stdout || '').trim();

  assert.notEqual(
    resolved, path.join(earlier, 'codex'),
    'resolver selected another TermDeck shim as the "real" binary — skip any candidate '
    + 'carrying the `# @termdeck/shim` marker, not just $SHIM_DIR and $0',
  );
  assert.equal(resolved, path.join(w.binDir, 'codex'), 'must resolve past every shim to the real CLI');
});

test('shim-shadowing is survivable in live mode, not just under the probe', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  w.prependPath(installSecondShimCopy(w, 'earlier-shims'));

  const r = w.run([]);

  assert.equal(r.status, 0, `a duplicate shim on PATH must not break launch (got ${r.status}: ${r.stderr})`);
  assert.deepEqual(w.ranTags(), ['primary'], 'the real CLI must still run exactly once');
});

test('a SYMLINK to the shim earlier on PATH is also skipped', (t) => {
  // The realpath check catches a symlink pointing at OUR file; this pins that it
  // does, so the marker fix does not regress the case already covered.
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const dir = path.join(w.root, 'link-dir');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(w.shimPath, path.join(dir, 'codex'));
  w.prependPath(dir);

  const r = w.run([], { TERMDECK_SHIM_PROBE: '1' });
  assert.equal((r.stdout || '').trim(), path.join(w.binDir, 'codex'));
});

test('no real binary anywhere after self → exit 127, names the CLI, runs nothing', (t) => {
  const w = makeWorld({ agent: 'codex', realBinary: false });
  t.after(() => w.cleanup());

  const r = w.run([]);
  assert.equal(r.status, 127, 'must use 127 (command-not-found), the conventional code');
  assert.match(r.stderr, /no real 'codex' binary found on PATH/);
  assert.deepEqual(w.ranTags(), [], 'nothing may be executed on the not-found path');
});

test('recursion sentinel for the SAME agent → exit 70, nothing spawned', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const r = w.run([], { TERMDECK_SHIM_ACTIVE: 'codex' });

  assert.equal(r.status, 70, 'EX_SOFTWARE — distinguishable from any real CLI status');
  assert.match(r.stderr, /recursion detected/);
  // The load-bearing assertion: an exec here is precisely the fork bomb, so
  // proving "nothing ran" matters more than the exit code.
  assert.deepEqual(w.ranTags(), [], 'the sentinel path must never exec anything');
});

test('sentinel is per-agent: codex shelling out to a DIFFERENT agent still works', (t) => {
  // Cross-agent nesting is a real workflow (a Codex session running `grok -p`).
  // A bare boolean sentinel would break it; the sentinel carries the agent name
  // precisely so only a shim re-entering ITSELF is the fault condition.
  const w = makeWorld({ agent: 'grok' });
  t.after(() => w.cleanup());

  const r = w.run([], { TERMDECK_SHIM_ACTIVE: 'codex' });

  assert.equal(r.status, 0, 'a grok shim must not abort because a codex shim is active');
  assert.deepEqual(w.ranTags(), ['primary']);
});

test('TERMDECK_SHIM_PROBE=1 prints the resolved path on stdout and exits 0 without running the CLI', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const r = w.run([], { TERMDECK_SHIM_PROBE: '1' });

  assert.equal(r.status, 0);
  const printed = (r.stdout || '').trim();
  assert.equal(printed, path.join(w.binDir, 'codex'), 'probe must print the resolved ABSOLUTE path');
  assert.ok(path.isAbsolute(printed));
  // The whole point of the probe is that doctor can assert resolution without
  // launching an interactive agent or leaving state behind.
  assert.deepEqual(w.ranTags(), [], 'probe must not execute the CLI');
  assert.deepEqual(w.transcripts(), [], 'probe must not create a transcript');
});

test('TERMDECK_SHIM_PROBE with an unresolvable binary → stderr + exit 127', (t) => {
  const w = makeWorld({ agent: 'codex', realBinary: false });
  t.after(() => w.cleanup());

  const r = w.run([], { TERMDECK_SHIM_PROBE: '1' });

  assert.equal(r.status, 127, 'probe failure must reuse the live not-found code');
  assert.equal((r.stdout || '').trim(), '', 'no path may be printed when resolution failed');
  assert.match(r.stderr, /no real 'codex' binary found/);
});

test('recursion sentinel outranks the dry-probe', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const r = w.run([], { TERMDECK_SHIM_ACTIVE: 'codex', TERMDECK_SHIM_PROBE: '1' });

  assert.equal(r.status, 70, 'the fork-bomb guard must win over every other branch');
  assert.match(r.stderr, /recursion detected/);
});

test('exit status of the real binary is preserved verbatim (transparency invariant 1)', (t) => {
  for (const code of [0, 1, 2, 42, 127]) {
    const w = makeWorld({ agent: 'codex', realExit: code });
    const r = w.run([]);
    assert.equal(r.status, code, `exit ${code} must survive the shim unchanged`);
    w.cleanup();
  }
});
