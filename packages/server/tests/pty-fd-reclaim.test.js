// pty-fd-reclaim.test.js — Sprint 87 T1.
//
// RED PROOF (this repo's rule: a gate only ever observed GREEN is not known to
// be a gate). Each behavioural test below was run against the DEFECT before the
// fix landed, by reverting the reclaim to what index.js did before Sprint 87
// (`session.pty = null` and nothing else):
//
//   • "leaks one master fd per spawn without the reclaim" — the real-pty
//     integration test at the bottom. Against pre-fix behaviour it measured
//     spawned=8 exited=8 leaked=8, i.e. `assert.equal(leaked, 0)` FAILED with
//     `8 !== 0`. It is the whole bug in one assertion.
//   • "reclaimOrphanPtyFds closes a recorded orphan" — with the reclaim call
//     removed from onExit, closeSync is never invoked: FAILED `0 !== 1`.
//   • "skips an fd whose number was recycled" — with the rdev/ino re-check
//     deleted (close on fd-number match alone, the naive implementation), this
//     FAILED because it closed the recycled descriptor: `1 !== 0`. That is the
//     assertion protecting us from closing someone else's file.
//
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  snapshotCharDeviceFds,
  findOrphanPtyFds,
  reclaimOrphanPtyFds,
  reclaimEnabled,
} = require('../src/pty-fd-reclaim');

// A minimal injectable fs: `table` maps fd -> {rdev, ino, chr} or throws EBADF.
function fakeFs(table) {
  const closed = [];
  return {
    closed,
    fstatSync(fd) {
      const e = table[fd];
      if (!e) { const err = new Error('EBADF'); err.code = 'EBADF'; throw err; }
      return {
        rdev: e.rdev,
        ino: e.ino,
        isCharacterDevice: () => e.chr !== false,
      };
    },
    closeSync(fd) {
      if (!table[fd]) { const err = new Error('EBADF'); err.code = 'EBADF'; throw err; }
      closed.push(fd);
      delete table[fd];
    },
  };
}

test('snapshotCharDeviceFds records only character devices, with rdev+ino', () => {
  const fs = fakeFs({
    3: { rdev: 100, ino: 11, chr: true },
    4: { rdev: 0, ino: 12, chr: false },   // a regular file — must not appear
    5: { rdev: 100, ino: 13, chr: true },
  });
  const snap = snapshotCharDeviceFds({ fsApi: fs, maxFd: 8 });
  assert.deepEqual([...snap.keys()], [3, 5]);
  assert.deepEqual(snap.get(3), { rdev: 100, ino: 11 });
});

test('findOrphanPtyFds returns new chardevs minus the ones node-pty owns', () => {
  const before = new Map([[3, { rdev: 100, ino: 11 }]]);
  const after = new Map([
    [3, { rdev: 100, ino: 11 }],          // pre-existing
    [11, { rdev: 15 * 256 + 4, ino: 590 }],  // the ORPHAN
    [12, { rdev: 15 * 256 + 4, ino: 590 }],  // term.fd — node-pty closes this
    [13, { rdev: 16 * 256 + 1, ino: 591 }],  // the slave, behind the ReadStream
  ]);
  const term = { fd: 12, _socket: { _handle: { fd: 13 } } };
  const orphans = findOrphanPtyFds(before, after, term);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].fd, 11);
});

test('findOrphanPtyFds tolerates a term with no private _socket', () => {
  const before = new Map();
  const after = new Map([[11, { rdev: 5, ino: 1 }], [12, { rdev: 5, ino: 1 }]]);
  const orphans = findOrphanPtyFds(before, after, { fd: 12 });
  assert.deepEqual(orphans.map((o) => o.fd), [11]);
});

test('reclaimOrphanPtyFds closes a recorded orphan', () => {
  const fs = fakeFs({ 11: { rdev: 3844, ino: 590, chr: true } });
  const closed = reclaimOrphanPtyFds([{ fd: 11, rdev: 3844, ino: 590 }], { fsApi: fs });
  assert.equal(closed, 1);
  assert.deepEqual(fs.closed, [11]);
});

test('reclaimOrphanPtyFds SKIPS an fd whose number was recycled to another device', () => {
  // fd 11 is open again — but it is now a DIFFERENT device (different ino).
  // Closing it would be closing a descriptor we do not own. This is the
  // assertion that fails if the rdev/ino re-check is ever removed.
  const fs = fakeFs({ 11: { rdev: 3844, ino: 999, chr: true } });
  const closed = reclaimOrphanPtyFds([{ fd: 11, rdev: 3844, ino: 590 }], { fsApi: fs });
  assert.equal(closed, 0);
  assert.deepEqual(fs.closed, []);
});

test('reclaimOrphanPtyFds SKIPS an fd recycled to a non-character device', () => {
  const fs = fakeFs({ 11: { rdev: 3844, ino: 590, chr: false } });
  assert.equal(reclaimOrphanPtyFds([{ fd: 11, rdev: 3844, ino: 590 }], { fsApi: fs }), 0);
});

test('reclaimOrphanPtyFds is idempotent — a second pass closes nothing', () => {
  const fs = fakeFs({ 11: { rdev: 3844, ino: 590, chr: true } });
  const list = [{ fd: 11, rdev: 3844, ino: 590 }];
  assert.equal(reclaimOrphanPtyFds(list, { fsApi: fs }), 1);
  assert.equal(reclaimOrphanPtyFds(list, { fsApi: fs }), 0);   // now EBADF
});

test('reclaimOrphanPtyFds tolerates an empty / absent list', () => {
  assert.equal(reclaimOrphanPtyFds([], {}), 0);
  assert.equal(reclaimOrphanPtyFds(null, {}), 0);
});

test('reclaimEnabled honours the TERMDECK_PTY_FD_RECLAIM kill switch', () => {
  assert.equal(reclaimEnabled({}), true);
  assert.equal(reclaimEnabled({ TERMDECK_PTY_FD_RECLAIM: '1' }), true);
  assert.equal(reclaimEnabled({ TERMDECK_PTY_FD_RECLAIM: '0' }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The integration test that IS the bug. Spawns real ptys, exits them, and
// measures the process's own open /dev/ptmx fds. Skipped when node-pty is
// unavailable (CI without the prebuilt) or off macOS/Linux.
// ─────────────────────────────────────────────────────────────────────────────
let ptyLib = null;
try { ptyLib = require('@homebridge/node-pty-prebuilt-multiarch'); } catch (_) { ptyLib = null; }

test('real ptys: spawn→exit leaks zero master fds with the reclaim wired', {
  skip: (!ptyLib || process.platform === 'win32')
    ? 'node-pty unavailable or unsupported platform'
    : false,
}, async () => {
  const N = 8;
  const countPtmx = () => snapshotCharDeviceFds({ maxFd: 4096 }).size;

  const baseline = countPtmx();
  let exited = 0;

  for (let i = 0; i < N; i++) {
    const before = snapshotCharDeviceFds();
    const term = ptyLib.spawn('/bin/sh', ['-c', 'exit 0'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
    });
    const orphans = findOrphanPtyFds(before, snapshotCharDeviceFds(), term);
    term.on('error', () => {});
    term.onData(() => {});
    term.onExit(() => {
      // Exactly what index.js' term.onExit now does.
      reclaimOrphanPtyFds(orphans);
      exited++;
    });
  }

  const deadline = Date.now() + 20000;
  while (exited < N && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(exited, N, 'all ptys should have exited');
  await new Promise((r) => setTimeout(r, 1500));   // let node-pty finish its own teardown

  const leaked = countPtmx() - baseline;
  // Pre-fix this measured leaked === N (8). That is the RED proof.
  assert.ok(
    leaked <= 0,
    `expected no leaked pty fds after ${N} spawn/exit cycles, leaked=${leaked}`
  );
});
