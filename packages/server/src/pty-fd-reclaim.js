// pty-fd-reclaim.js — Sprint 87 T1.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT (root cause of "the HTTP API dies while the panels keep working")
// ─────────────────────────────────────────────────────────────────────────────
//
// Every `pty.spawn()` from @homebridge/node-pty-prebuilt-multiarch opens THREE
// file descriptors in the PARENT process, measured on macOS 22.6 / Node 23.11
// against the version this repo pins:
//
//     fd 11  CHR  /dev/ptmx      <-- a pty master the JS layer never records
//     fd 12  CHR  /dev/ptmx      <-- `term.fd`, wrapped in a tty.ReadStream
//     fd 13  CHR  /dev/ttys081   <-- the slave
//
// On child exit node-pty closes fd 12 (via `_socket.destroy()`) and fd 13. It
// NEVER closes fd 11, because nothing in the JS wrapper knows it exists — the
// native `fork()` opened it and dropped the handle on the floor. So the parent
// leaks exactly ONE /dev/ptmx master per spawned panel, forever.
//
// Measured on a throwaway harness (spawn N short-lived ptys, let them exit,
// null the reference exactly the way index.js does, force a full GC):
//
//     spawned=12 exited=12  ptmx_fds_still_open=12
//     spawned=30 exited=30  ptmx_fds_still_open=30
//     spawned=60 exited=60  ptmx_fds_still_open=60
//
// Zero were ever released. This module's reclaim takes all three to 0.
//
// WHY IT PRESENTS AS "THE SERVER STOPPED ANSWERING BUT THE PANELS ARE FINE":
// a leaked fd consumes a slot against the process rlimit. When the table is
// full, `accept(2)` on the listening socket fails with EMFILE, so no NEW TCP
// connection can be established — `curl /api/sessions` hangs and reports
// http 000 — while every ALREADY-OPEN pty fd keeps reading and writing
// normally, so the panels carry on working and posting to disk. That is
// precisely the 2026-09-02 02:33 signature on :3003 (API dead all night, four
// panels still writing until 03:25) and the 10:16 both-servers /buffer
// timeout. It is also the same root cause as the 2026-08-16 report of a server
// walking /dev/ptmx masters up to macOS's system-wide `kern.tty.ptmx_max=511`.
//
// WHY THE SPRINT-63 FIX DID NOT WORK. index.js' `term.onExit` sets
// `session.pty = null` with a comment claiming the master fd is then released
// "until next GC pass". It is not. The leaked fd is not owned by any JS object
// at all — there is nothing for GC to collect — and the harness above forces a
// full GC and still measures zero reclaimed. Nulling the reference is correct
// for letting the wrapper be collected; it does nothing for this fd.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RECLAIM
// ─────────────────────────────────────────────────────────────────────────────
//
// node-pty exposes no handle for the orphan, so we identify it positionally and
// close it ourselves, under a deliberately narrow identity check:
//
//   1. `snapshotCharDeviceFds()` immediately BEFORE the spawn, recording every
//      open character-device fd with its `rdev` (device major/minor) and `ino`.
//   2. The same snapshot immediately AFTER the spawn.
//   3. `findOrphanPtyFds()` = (after - before), minus `term.fd` and minus the
//      fd behind the tty.ReadStream. Whatever remains is node-pty's untracked
//      master (plus the slave, which node-pty does close — see the re-check).
//   4. On panel exit, `reclaimOrphanPtyFds()` re-`fstat`s each recorded fd and
//      closes it ONLY IF it is still a character device with the IDENTICAL
//      `rdev` AND `ino` recorded at spawn time.
//
// Step 4 is the safety property that makes this sound. An fd number is a
// recyclable integer: between spawn and exit the kernel may well have handed
// that same number to a log file, a socket, or another panel's pty. The
// rdev+ino re-check means we close a descriptor only when it is demonstrably
// still the exact device node we saw appear during this spawn. Regular files,
// pipes, sockets and TTYs belonging to a different pty pair all fail the check
// and are skipped. Any fd node-pty already closed also fails (EBADF) and is
// skipped. The reclaim is therefore idempotent and safe to call twice.
//
// Every function takes an injectable `fsApi` so the unit suite can drive both
// the fire path and every non-fire path without opening real ptys.
//
// Kill switch: `TERMDECK_PTY_FD_RECLAIM=0` disables snapshotting and reclaim
// entirely, restoring pre-Sprint-87 behaviour (and the leak) for bisecting.

'use strict';

const realFs = require('fs');

// Scanning the whole 1M-fd rlimit would be absurd; the orphan is always
// allocated in the same neighbourhood as `term.fd`, which for a server with a
// few dozen panels lives in the low hundreds. 4096 covers a deck far larger
// than TermDeck supports while keeping the two snapshots at ~8k cheap
// `fstat` syscalls — single-digit milliseconds, and only ever on the spawn
// path (never on a request path, never on a timer).
const DEFAULT_MAX_FD = 4096;

function reclaimEnabled(env = process.env) {
  return env.TERMDECK_PTY_FD_RECLAIM !== '0';
}

// Enumerate currently-open character-device fds as Map<fd, {rdev, ino}>.
// Character devices only: a pty master/slave is always CHR, and restricting
// the candidate set here means a regular file or socket opened concurrently
// by another async task can never enter the orphan list in the first place.
function snapshotCharDeviceFds(opts = {}) {
  const fsApi = opts.fsApi || realFs;
  const maxFd = opts.maxFd || DEFAULT_MAX_FD;
  const out = new Map();
  for (let fd = 3; fd < maxFd; fd++) {
    let st;
    try { st = fsApi.fstatSync(fd); } catch (_e) { continue; }
    try {
      if (!st || typeof st.isCharacterDevice !== 'function' || !st.isCharacterDevice()) continue;
    } catch (_e) { continue; }
    out.set(fd, { rdev: st.rdev, ino: st.ino });
  }
  return out;
}

// Diff two snapshots and drop the fds node-pty actually owns and closes.
// `term.fd` is the master behind the tty.ReadStream; `term._socket._handle.fd`
// is the same number in every build we have measured, but it is read
// defensively because it is a private field.
function findOrphanPtyFds(before, after, term) {
  const owned = new Set();
  if (term && typeof term.fd === 'number') owned.add(term.fd);
  try {
    const h = term && term._socket && term._socket._handle;
    if (h && typeof h.fd === 'number') owned.add(h.fd);
  } catch (_e) { /* private field absent — fall through */ }

  const orphans = [];
  for (const [fd, info] of after) {
    if (before.has(fd)) continue;
    if (owned.has(fd)) continue;
    orphans.push({ fd, rdev: info.rdev, ino: info.ino });
  }
  return orphans;
}

// Close the recorded orphans, but only those that still `fstat` to the exact
// same character device (rdev + ino) seen at spawn time. Returns the number
// actually closed so callers can log a real figure rather than an intention.
function reclaimOrphanPtyFds(orphans, opts = {}) {
  const fsApi = opts.fsApi || realFs;
  if (!Array.isArray(orphans) || orphans.length === 0) return 0;
  let closed = 0;
  for (const o of orphans) {
    if (!o || typeof o.fd !== 'number') continue;
    let st;
    try { st = fsApi.fstatSync(o.fd); } catch (_e) { continue; }   // already closed
    try {
      if (!st || typeof st.isCharacterDevice !== 'function' || !st.isCharacterDevice()) continue;
    } catch (_e) { continue; }
    if (st.rdev !== o.rdev || st.ino !== o.ino) continue;          // fd number recycled
    try { fsApi.closeSync(o.fd); closed++; } catch (_e) { /* raced — fine */ }
  }
  return closed;
}

module.exports = {
  DEFAULT_MAX_FD,
  reclaimEnabled,
  snapshotCharDeviceFds,
  findOrphanPtyFds,
  reclaimOrphanPtyFds,
};
