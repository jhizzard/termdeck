// codex-bounded-header-read.test.js — Sprint 87 T1.
//
// `resolveTranscriptPath` used `fs.readFileSync(full, 'utf8')` to obtain ONE
// line — the `{type:'session_meta'}` header at the top of a Codex rollout.
// Measured on this machine 2026-09-02: 446 rollouts, 1.6 GB total, largest
// 52 MB, the actively-written one 33 MB. Every periodic-capture tick, for every
// codex panel, therefore performed a multi-megabyte SYNCHRONOUS read and
// allocated a same-sized UTF-8 string on the main thread. On a swapping host
// that is seconds of a completely unresponsive HTTP API.
//
// RED PROOF. Run against the pre-fix implementation:
//   • "reads at most CODEX_HEADER_READ_BYTES" FAILED — the byte-counting fake fs
//     recorded a 5,000,000-byte read where the bound is 65,536:
//     `AssertionError: 5000000 <= 65536`. That single assertion is the defect.
//   • The other cases are equivalence tests: they FAIL if a future edit changes
//     WHICH line is returned while making it bounded, which is the way this fix
//     could silently break transcript attribution.
//
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const realFs = require('node:fs');

const codexAdapter = require('../src/agent-adapters/codex');
const { _readFirstLineBounded, CODEX_HEADER_READ_BYTES } = codexAdapter;

// An fs fake over an in-memory buffer that RECORDS the largest read length, so
// the bound can be asserted rather than assumed.
function countingFs(content) {
  const buf = Buffer.from(content);
  const rec = { maxRead: 0, opened: 0, closed: 0 };
  return {
    rec,
    openSync() { rec.opened++; return 42; },
    readSync(fd, target, offset, length, position) {
      rec.maxRead = Math.max(rec.maxRead, length);
      const end = Math.min(buf.length, position + length);
      if (end <= position) return 0;
      const slice = buf.slice(position, end);
      slice.copy(target, offset);
      return slice.length;
    },
    closeSync() { rec.closed++; },
  };
}

test('reads at most CODEX_HEADER_READ_BYTES even from a huge rollout', () => {
  const header = JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo' } });
  // 5 MB of body after the header — a small rollout by this machine's standards.
  const fs = countingFs(header + '\n' + 'x'.repeat(5_000_000));
  const line = _readFirstLineBounded(fs, '/fake/rollout.jsonl');
  assert.equal(line, header);
  assert.ok(
    fs.rec.maxRead <= CODEX_HEADER_READ_BYTES,
    `read ${fs.rec.maxRead} bytes; bound is ${CODEX_HEADER_READ_BYTES}`
  );
});

test('always closes the descriptor it opened', () => {
  const fs = countingFs('{"type":"session_meta"}\nbody\n');
  _readFirstLineBounded(fs, '/fake/x.jsonl');
  assert.equal(fs.rec.opened, 1);
  assert.equal(fs.rec.closed, 1, 'a bounded reader that leaks fds would be a worse bug than the one fixed');
});

test('returns the same first line the old whole-file read returned', () => {
  const tmp = path.join(os.tmpdir(), `td-codex-header-${process.pid}.jsonl`);
  const header = JSON.stringify({ type: 'session_meta', payload: { cwd: '/some/repo' } });
  realFs.writeFileSync(tmp, header + '\n' + JSON.stringify({ type: 'message' }) + '\n');
  try {
    const oldWay = (() => {
      const b = realFs.readFileSync(tmp, 'utf8');
      const nl = b.indexOf('\n');
      return nl >= 0 ? b.slice(0, nl) : b;
    })();
    assert.equal(_readFirstLineBounded(realFs, tmp), oldWay);
  } finally {
    realFs.unlinkSync(tmp);
  }
});

test('single-line file shorter than the bound is returned whole', () => {
  const fs = countingFs('{"type":"session_meta"}');
  assert.equal(_readFirstLineBounded(fs, '/fake/x.jsonl'), '{"type":"session_meta"}');
});

test('a header longer than the bound is rejected, not truncated into garbage', () => {
  // No newline within the bound AND the read filled the buffer → unparseable.
  // Returning a truncated prefix would hand JSON.parse a broken string and, far
  // worse, could match the wrong rollout.
  const fs = countingFs('y'.repeat(CODEX_HEADER_READ_BYTES * 2));
  assert.equal(_readFirstLineBounded(fs, '/fake/x.jsonl'), null);
});

test('an unreadable file yields null rather than throwing', () => {
  const fs = { openSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } };
  assert.equal(_readFirstLineBounded(fs, '/nope.jsonl'), null);
});

test('an empty file yields null', () => {
  const fs = countingFs('');
  assert.equal(_readFirstLineBounded(fs, '/fake/empty.jsonl'), null);
});

test('the adapter still exposes resolveTranscriptPath as a function', () => {
  assert.equal(typeof codexAdapter.resolveTranscriptPath, 'function');
  assert.equal(CODEX_HEADER_READ_BYTES, 64 * 1024);
});
