// Sprint 60 v1.0.14 — Item 3: WS ioctl EBADF/ENOTTY race guard.
// Brad's 2026-05-07 r730 forensic logged 25x ws message handler errors per
// 13h uptime where pty.resize fired against a fd the pty-reaper had already
// closed. safelyResizePty() guards the race and downgrades known race-class
// errors (EBADF, ENOTTY, "ioctl failed") to a silent return.

const test = require('node:test');
const assert = require('node:assert');

// Sprint 60 v1.0.14 + T4-CODEX AUDIT-CONCERN — import the production helper
// directly. Earlier version of this file re-implemented safelyResizePty,
// which would have allowed silent drift if the production code changed.
const { safelyResizePty } = require('../packages/server/src/index');

function makeSession({ status = 'active', resizeImpl = () => {} } = {}) {
  return {
    id: 'test-sess',
    pty: {
      resize: resizeImpl,
    },
    meta: { status },
  };
}

test('safelyResizePty returns true on successful resize', () => {
  let called = null;
  const session = makeSession({
    resizeImpl: (cols, rows) => { called = { cols, rows }; },
  });
  const ok = safelyResizePty(session, 100, 40);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(called, { cols: 100, rows: 40 });
});

test('safelyResizePty returns false when session.pty is null', () => {
  const session = { id: 'sess', pty: null, meta: { status: 'exited' } };
  assert.strictEqual(safelyResizePty(session, 100, 40), false);
});

test('safelyResizePty returns false when session.meta.status is exited', () => {
  let called = false;
  const session = makeSession({
    status: 'exited',
    resizeImpl: () => { called = true; },
  });
  assert.strictEqual(safelyResizePty(session, 100, 40), false);
  assert.strictEqual(called, false, 'resize must NOT be called on exited session');
});

test('safelyResizePty silently returns false on EBADF', () => {
  const session = makeSession({
    resizeImpl: () => {
      const err = new Error('ioctl(2) failed: EBADF');
      err.code = 'EBADF';
      throw err;
    },
  });
  assert.strictEqual(safelyResizePty(session, 100, 40), false);
});

test('safelyResizePty silently returns false on ENOTTY', () => {
  const session = makeSession({
    resizeImpl: () => {
      const err = new Error('ioctl(2) failed: ENOTTY');
      err.code = 'ENOTTY';
      throw err;
    },
  });
  assert.strictEqual(safelyResizePty(session, 100, 40), false);
});

test('safelyResizePty matches EBADF in message even when code is absent', () => {
  // Some node-pty error shapes set the message but not the code field.
  const session = makeSession({
    resizeImpl: () => { throw new Error('ioctl(2) failed: EBADF'); },
  });
  assert.strictEqual(safelyResizePty(session, 100, 40), false);
});

test('safelyResizePty rethrows generic "ioctl failed" without EBADF/ENOTTY', () => {
  // T4-CODEX AUDIT-CONCERN narrowing: a non-race ioctl failure (e.g. EINTR
  // or EFAULT) must NOT be silently dropped. Pre-narrowing the regex
  // matched ANY "ioctl(N) failed" message; post-narrowing only EBADF/ENOTTY
  // are race-class.
  const session = makeSession({
    resizeImpl: () => { throw new Error('ioctl(2) failed: EINTR'); },
  });
  assert.throws(
    () => safelyResizePty(session, 100, 40),
    /EINTR/
  );
});

test('safelyResizePty rethrows non-race errors', () => {
  const session = makeSession({
    resizeImpl: () => { throw new Error('totally unrelated error'); },
  });
  assert.throws(
    () => safelyResizePty(session, 100, 40),
    /totally unrelated error/
  );
});

test('safelyResizePty defaults to 120x30 when cols/rows not provided', () => {
  let called = null;
  const session = makeSession({
    resizeImpl: (cols, rows) => { called = { cols, rows }; },
  });
  safelyResizePty(session, undefined, undefined);
  assert.deepStrictEqual(called, { cols: 120, rows: 30 });
});

test('safelyResizePty handles 0 cols/rows by falling back to defaults', () => {
  // Cosmetic but matches the existing `parsed.cols || 120` semantic.
  let called = null;
  const session = makeSession({
    resizeImpl: (cols, rows) => { called = { cols, rows }; },
  });
  safelyResizePty(session, 0, 0);
  assert.deepStrictEqual(called, { cols: 120, rows: 30 });
});

test('safelyResizePty handles null session gracefully', () => {
  assert.strictEqual(safelyResizePty(null, 100, 40), false);
});
