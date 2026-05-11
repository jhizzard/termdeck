// Sprint 63 T1 — Crash class helpers (isPtyRaceError, hexEscapePrefix,
// safelyResizePty `_destroyed` short-circuit).
//
// Three small helpers extracted in Sprint 63 to support the WS ioctl race
// guard (1.2) and body-parser hardening (1.3). The wiring tests (in the
// companion fence files) exercise the helpers through their callers; this
// file pins their behavior directly so a regression in any one helper
// fails a single, focused test rather than a cascade through the wiring.
//
// Run: node --test packages/server/tests/crash-class-helpers.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safelyResizePty,
  isPtyRaceError,
  hexEscapePrefix,
} = require('../src/index.js');

// ─────────────────────────────────────────────────────────────────────────
// isPtyRaceError — race-class classifier shared between safelyResizePty
// and the WS message-handler outer catch. T4-CODEX AUDIT-CONCERN (Sprint 60
// v1.0.14) locked the classifier to EBADF/ENOTTY explicitly; anything
// else MUST NOT be silently dropped because it could indicate a real bug.
// ─────────────────────────────────────────────────────────────────────────

test('isPtyRaceError: EBADF in err.code is race-class', () => {
  const err = new Error('ioctl(2) failed');
  err.code = 'EBADF';
  assert.equal(isPtyRaceError(err), true);
});

test('isPtyRaceError: ENOTTY in err.code is race-class', () => {
  const err = new Error('ioctl(2) failed');
  err.code = 'ENOTTY';
  assert.equal(isPtyRaceError(err), true);
});

test('isPtyRaceError: EBADF in err.message (code absent) is race-class', () => {
  // Some node-pty error shapes only set the message, not the code.
  const err = new Error('ioctl(2) failed: EBADF');
  assert.equal(isPtyRaceError(err), true);
});

test('isPtyRaceError: ENOTTY in err.message is race-class', () => {
  const err = new Error('ioctl(2) failed: ENOTTY');
  assert.equal(isPtyRaceError(err), true);
});

test('isPtyRaceError: EINTR (non-race) returns false', () => {
  // T4-CODEX narrowing — EINTR is a real ioctl failure that must surface.
  const err = new Error('ioctl(2) failed: EINTR');
  err.code = 'EINTR';
  assert.equal(isPtyRaceError(err), false);
});

test('isPtyRaceError: generic Error returns false', () => {
  assert.equal(isPtyRaceError(new Error('something else broke')), false);
});

test('isPtyRaceError: null / undefined returns false', () => {
  assert.equal(isPtyRaceError(null), false);
  assert.equal(isPtyRaceError(undefined), false);
});

test('isPtyRaceError: substring word-boundary — "PEBADFISH" must NOT match', () => {
  // The regex uses \b word boundaries; a substring containing EBADF in a
  // longer identifier should not classify as race. Defensive against
  // future log-message shapes.
  const err = new Error('ioctl failure: PEBADFISH-handler-error');
  assert.equal(isPtyRaceError(err), false);
});

// ─────────────────────────────────────────────────────────────────────────
// safelyResizePty — `_destroyed` short-circuit. The Sprint 63 belt-and-
// suspenders for the kill()→onExit window: the DELETE handler stamps
// pty._destroyed=true immediately after kill(), so a WS resize message
// arriving before the async onExit fires short-circuits without calling
// the underlying ioctl.
// ─────────────────────────────────────────────────────────────────────────

function makeSession({ status = 'active', destroyed = false, resizeImpl = () => {} } = {}) {
  return {
    id: 'helper-test-sess',
    pty: {
      _destroyed: destroyed,
      resize: resizeImpl,
    },
    meta: { status },
  };
}

test('safelyResizePty: pty._destroyed=true short-circuits to false', () => {
  let resizeCalled = false;
  const session = makeSession({
    destroyed: true,
    resizeImpl: () => { resizeCalled = true; },
  });
  assert.equal(safelyResizePty(session, 100, 40), false);
  assert.equal(resizeCalled, false,
    'pty.resize MUST NOT be called when _destroyed=true — the short-circuit prevents the ioctl');
});

test('safelyResizePty: pty._destroyed=false proceeds to resize', () => {
  let called = null;
  const session = makeSession({
    destroyed: false,
    resizeImpl: (cols, rows) => { called = { cols, rows }; },
  });
  assert.equal(safelyResizePty(session, 100, 40), true);
  assert.deepEqual(called, { cols: 100, rows: 40 });
});

test('safelyResizePty: _destroyed short-circuit beats exited-status check', () => {
  // If a future bug skips setting meta.status='exited' (e.g. early return
  // path in onExit), _destroyed alone is enough.
  let resizeCalled = false;
  const session = makeSession({
    status: 'active',  // NOT exited
    destroyed: true,
    resizeImpl: () => { resizeCalled = true; },
  });
  assert.equal(safelyResizePty(session, 100, 40), false);
  assert.equal(resizeCalled, false);
});

// ─────────────────────────────────────────────────────────────────────────
// hexEscapePrefix — body-parser warn-line renderer. Sprint 63 T1 Item 1.3
// adds a 32-byte prefix of `req.rawBody` to the existing single-line warn
// so the operator can identify which caller is sending bad JSON without
// dumping the full payload.
// ─────────────────────────────────────────────────────────────────────────

test('hexEscapePrefix: empty buffer renders <no-body>', () => {
  assert.equal(hexEscapePrefix(Buffer.alloc(0)), '<no-body>');
});

test('hexEscapePrefix: null / undefined renders <no-body>', () => {
  assert.equal(hexEscapePrefix(null), '<no-body>');
  assert.equal(hexEscapePrefix(undefined), '<no-body>');
});

test('hexEscapePrefix: printable ASCII passes through verbatim', () => {
  const buf = Buffer.from('hello world');
  assert.equal(hexEscapePrefix(buf), 'hello world');
});

test('hexEscapePrefix: BEL (0x07) renders as \\x07', () => {
  const buf = Buffer.from([0x68, 0x65, 0x07, 0x6c]);  // h e <BEL> l
  assert.equal(hexEscapePrefix(buf), 'he\\x07l');
});

test('hexEscapePrefix: backslash escapes as \\\\', () => {
  const buf = Buffer.from('a\\b');
  assert.equal(hexEscapePrefix(buf), 'a\\\\b');
});

test('hexEscapePrefix: 0x7f (DEL) renders as \\x7f', () => {
  const buf = Buffer.from([0x61, 0x7f, 0x62]);  // a <DEL> b
  assert.equal(hexEscapePrefix(buf), 'a\\x7fb');
});

test('hexEscapePrefix: 32-byte cap is enforced + truncation marker appended', () => {
  // 64 chars of `a` — prefix should be 32 `a`s followed by an ellipsis.
  const buf = Buffer.from('a'.repeat(64));
  const out = hexEscapePrefix(buf);
  assert.equal(out, 'a'.repeat(32) + '…');
});

test('hexEscapePrefix: exactly 32 bytes — no truncation marker', () => {
  const buf = Buffer.from('a'.repeat(32));
  assert.equal(hexEscapePrefix(buf), 'a'.repeat(32));
});

test('hexEscapePrefix: 33 bytes — truncation marker appended', () => {
  const buf = Buffer.from('a'.repeat(33));
  assert.equal(hexEscapePrefix(buf), 'a'.repeat(32) + '…');
});

test('hexEscapePrefix: PTY-output-shape body — control chars escaped', () => {
  // Brad's r730 most likely body shape: agent-to-agent inject of PTY output
  // wrapped in JSON. ESC (0x1b) is the canonical PTY sequence opener.
  const buf = Buffer.from('{"text":"\x1b[31mred"}');
  // Verify ESC renders as \x1b but everything else passes through.
  const out = hexEscapePrefix(buf);
  assert.ok(out.includes('\\x1b'),
    `expected the rendered output to contain literal \\x1b, got: ${out}`);
  assert.ok(out.includes('{"text":"'),
    'printable ASCII prefix is preserved');
});

test('hexEscapePrefix: custom maxBytes is respected', () => {
  const buf = Buffer.from('abcdefghij');
  assert.equal(hexEscapePrefix(buf, 4), 'abcd…');
});
