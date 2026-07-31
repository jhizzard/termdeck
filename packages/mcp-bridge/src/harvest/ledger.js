'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Write-ahead dedup ledger for the Sheets intake ramp (Sprint 84 / T1).
//
// THE PROBLEM IT EXISTS FOR. The harvester does two writes per row that are not
// in one transaction: (a) INSERT the proposal into memory_inbox, over the
// network; (b) stamp forwarded_at back into the sheet, over a different
// network. A crash between them, on rerun, would re-propose a row whose
// forwarded_at is still blank — a duplicate memory that nothing downstream can
// tell from a genuine second capture.
//
// The sheet cannot be the dedup substrate, because the sheet is exactly what
// isn't updated yet at the moment of the crash. So the ledger is a local
// append-only JSONL, fsync'd BEFORE the insert:
//
//   append {phase:'inflight'}  ──►  propose()  ──►  append {phase:'forwarded', id}
//        (durable here)                                  (durable here)
//        └─ crash anywhere after this point still leaves a record ─┘
//
// On rerun, a fingerprint present in ANY phase is never proposed again. An
// `inflight`-only record means "we may or may not have inserted" — and the
// resolution is deliberately asymmetric: we prefer ONE possibly-unforwarded row
// the operator can see and re-enter over a silent duplicate in canonical
// memory. Such a row gets stamped with a visible note rather than retried.
//
// Append-only + fsync also means a torn final line (power loss mid-write) is
// survivable: load() skips unparseable lines instead of failing the run.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PHASES = Object.freeze({
  INFLIGHT: 'inflight', // written before propose(); may or may not have landed
  FORWARDED: 'forwarded', // propose() returned an inbox id
  REJECTED: 'rejected', // the inbox REFUSED it (definitively not stored)
  QUARANTINED: 'quarantined', // never sent: malformed row or ingress scan hit
});

// A resolved phase must never be downgraded by a stale/duplicate inflight line.
const RESOLVED = new Set([PHASES.FORWARDED, PHASES.REJECTED, PHASES.QUARANTINED]);

function defaultLedgerFile(env = process.env) {
  return env.TERMDECK_SHEETS_LEDGER_FILE
    || path.join(os.homedir(), '.termdeck', 'sheets-harvest-ledger.jsonl');
}

// createLedger({ file?, env?, fs? }) → { file, load(), append(rec) }
function createLedger(opts = {}) {
  const fsImpl = opts.fs || fs;
  const file = opts.file || defaultLedgerFile(opts.env || process.env);

  // load() → Map<fingerprint, record>. Absent file = first run, not an error.
  function load() {
    const map = new Map();
    let raw;
    try {
      raw = fsImpl.readFileSync(file, 'utf8');
    } catch {
      return map;
    }
    for (const line of String(raw).split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let rec;
      try {
        rec = JSON.parse(s);
      } catch {
        continue; // torn final line from a power loss — skip, don't fail the run
      }
      if (!rec || typeof rec.fingerprint !== 'string' || !rec.fingerprint) continue;
      const prev = map.get(rec.fingerprint);
      // Later line wins, EXCEPT an inflight never overwrites an already-resolved
      // record (ordering within a file is chronological, but a retried row can
      // append a second inflight after a resolution — that must not un-resolve).
      if (prev && RESOLVED.has(prev.phase) && !RESOLVED.has(rec.phase)) continue;
      map.set(rec.fingerprint, rec);
    }
    return map;
  }

  // append(rec) → rec. Durable: the fd is fsync'd before we return, so the
  // write-ahead guarantee holds across a hard kill.
  function append(rec) {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      /* already exists, or an unwritable parent — the openSync below reports it */
    }
    const fd = fsImpl.openSync(file, 'a');
    try {
      fsImpl.writeSync(fd, `${JSON.stringify(rec)}\n`);
      try {
        fsImpl.fsyncSync(fd);
      } catch {
        /* some filesystems (and test doubles) don't implement fsync — best effort */
      }
    } finally {
      fsImpl.closeSync(fd);
    }
    return rec;
  }

  return { file, load, append };
}

module.exports = { createLedger, defaultLedgerFile, PHASES, RESOLVED };
