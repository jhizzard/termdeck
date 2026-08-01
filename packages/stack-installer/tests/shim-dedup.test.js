'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// Sprint 68-REDUX · T3 fence — D1′ DEDUP (exactly one capture per session)
//
// Inside a TermDeck panel, `onPanelClose` already owns the session. If the shim
// also captured, every in-panel session would write twice. The guard is an
// OR over two markers, both tested NON-EMPTY:
//
//     TERMDECK_PANEL_SESSION   the named, single-purpose marker added this sprint
//     TERMDECK_SESSION         the FALLBACK — a long-lived TermDeck server
//                              started before the upgrade sets this and not the
//                              former, so guarding on the new marker alone would
//                              fail OPEN on exactly the hosts least likely to
//                              have restarted (ORCH RULING 2026-08-01 15:33 ET)
//
// "Set but EMPTY" is a real state in that env block — TERMDECK_PROJECT is
// deliberately '' when absent — so `-n` vs "is defined" is a live distinction,
// not pedantry. Every cell of the matrix is enumerated below.
//
// ── EVERY CASE HERE RUNS UNDER A PTY, DELIBERATELY ────────────────────────────
// The shim also execs transparently when stdin/stdout is not a TTY. Without a
// PTY, EVERY case would take the transparent branch and the whole file would
// pass while distinguishing nothing. `runPty` drives them through script(1) so
// the capture branch is genuinely reachable and "no transcript" means the guard
// fired, not that the TTY check did.
// ──────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');

const { makeWorld } = require('./_shim-harness');

// Proves the PTY harness reaches the capture branch at all. If this ever fails,
// every "guard fired" assertion below becomes vacuous — so it runs first and
// says so in its name.
test('CONTROL: with no markers set, the PTY path DOES capture (else all guards are vacuous)', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const r = w.runPty([]);

  assert.deepEqual(w.ranTags(), ['primary'], 'real binary must still run');
  assert.equal(w.transcripts().length, 1, 'capture path must produce exactly one transcript');
  assert.match(w.transcripts()[0], /^codex-\d+-\d+\.log$/, 'transcript name carries agent, ts, pid');
  assert.equal(r.status, 0);
});

const TRANSPARENT_CASES = [
  {
    name: 'TERMDECK_PANEL_SESSION set → transparent',
    env: { TERMDECK_PANEL_SESSION: 'abc-123' },
  },
  {
    name: 'TERMDECK_SESSION set alone (pre-1.18 server skew) → transparent',
    env: { TERMDECK_SESSION: 'abc-123' },
  },
  {
    name: 'both markers set → transparent',
    env: { TERMDECK_PANEL_SESSION: 'abc-123', TERMDECK_SESSION: 'abc-123' },
  },
  {
    name: 'PANEL_SESSION empty but SESSION non-empty → transparent (OR still satisfied)',
    env: { TERMDECK_PANEL_SESSION: '', TERMDECK_SESSION: 'abc-123' },
  },
];

for (const c of TRANSPARENT_CASES) {
  test(`in-panel dedup: ${c.name}`, (t) => {
    const w = makeWorld({ agent: 'codex' });
    t.after(() => w.cleanup());

    const r = w.runPty([], c.env);

    assert.equal(r.status, 0);
    assert.deepEqual(w.ranTags(), ['primary'], 'the CLI must still run — transparency, not suppression');
    assert.deepEqual(
      w.transcripts(), [],
      'a panel session must produce NO shim transcript — onPanelClose owns it',
    );
  });
}

const CAPTURE_CASES = [
  {
    name: 'both markers unset → capture',
    env: {},
  },
  {
    name: 'PANEL_SESSION set-but-EMPTY, SESSION unset → capture (the `-n` distinction)',
    env: { TERMDECK_PANEL_SESSION: '' },
  },
  {
    name: 'both markers set-but-EMPTY → capture',
    env: { TERMDECK_PANEL_SESSION: '', TERMDECK_SESSION: '' },
  },
];

for (const c of CAPTURE_CASES) {
  test(`standalone capture: ${c.name}`, (t) => {
    const w = makeWorld({ agent: 'codex' });
    t.after(() => w.cleanup());

    const r = w.runPty([], c.env);

    assert.equal(r.status, 0);
    assert.deepEqual(w.ranTags(), ['primary']);
    assert.equal(
      w.transcripts().length, 1,
      'an empty marker must NOT be read as "in a panel" — the guard tests -n, not defined',
    );
  });
}

test('the explicit opt-out disables capture without uninstalling the shim', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const r = w.runPty([], { TERMDECK_SHIM_DISABLE: '1' });

  assert.equal(r.status, 0);
  assert.deepEqual(w.ranTags(), ['primary']);
  assert.deepEqual(w.transcripts(), [], 'opt-out must suppress capture entirely');
});

test('non-interactive stdin (pipe/CI) stays transparent and captures nothing', (t) => {
  // `echo x | codex ...`, editor integrations, CI. `script` would add EOT noise
  // and buy nothing, and transparency outranks capture.
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const r = w.run([]); // run() uses pipes → not a TTY

  assert.equal(r.status, 0);
  assert.deepEqual(w.ranTags(), ['primary']);
  assert.deepEqual(w.transcripts(), [], 'no TTY ⇒ no capture');
});

test('the recursion sentinel is exported on BOTH the capture and transparent paths', (t) => {
  // This case originally pinned the opposite — sentinel on capture only — because
  // that was the shipped behaviour. It was the WRONG contract: the transparent
  // `exec` branch is exactly where the two-shims-on-PATH exec loop lived (T3
  // 16:02), and a branch that execs without arming the guard is a branch where
  // the next resolution bug spins a terminal forever instead of dying at 70.
  // ORCH ruled the sentinel must be set before the transparent exec too; this is
  // that contract, not an observation.
  const capture = makeWorld({ agent: 'codex' });
  t.after(() => capture.cleanup());
  capture.runPty([]);
  assert.ok(
    capture.markerLines().some((l) => l === 'ENVSNAP\tTERMDECK_SHIM_ACTIVE=codex'),
    'capture path must arm the sentinel for the child',
  );

  const transparent = makeWorld({ agent: 'codex' });
  t.after(() => transparent.cleanup());
  transparent.runPty([], { TERMDECK_PANEL_SESSION: 'abc' });
  assert.ok(
    transparent.markerLines().some((l) => l === 'ENVSNAP\tTERMDECK_SHIM_ACTIVE=codex'),
    'transparent path must ALSO arm the sentinel — an unguarded exec is how the '
    + 'infinite exec loop became possible',
  );
});
