'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// Sprint 68-REDUX · T3 fence — VENDOR PARITY (INSTALLER-PITFALLS Class N)
//
// `assets/shims/drain.js` carries a VENDORED COPY of the clean+segment algorithm
// whose canonical home is `packages/server/src/agent-adapters/agy.js`. The
// duplication is deliberate (a `~/.termdeck/shims/` artifact must not require()
// into the server package — Class E hidden dependency), and T1 asked for exactly
// this fence when accepting that cost: feed one shared fixture to BOTH
// implementations, assert identical output, so an edit to one that isn't
// mirrored fails loudly instead of silently degrading standalone capture.
//
// The fixtures are REAL `script(1)` captures, not hand-typed approximations.
// That distinction already paid: the first pass caught a total-data-loss bug
// (CRLF-emitting CLI → zero messages) that a hand-written fixture would have
// modelled away. See fixtures/s68r-shims/README.md.
// ──────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { fixture, REPO_ROOT, DRAIN_JS } = require('./_shim-harness');

const agy = require(path.join(REPO_ROOT, 'packages', 'server', 'src', 'agent-adapters', 'agy.js'));
const drain = require(DRAIN_JS);

// The canonical surface is the adapter's PUBLIC `parseTranscript` — pinning the
// exported entry point rather than a private helper means the fence still holds
// if agy.js reorganises its internals, and it is what the panel path actually
// calls.
const canonical = (raw) => agy.parseTranscript(raw);
const vendored = (raw) => drain._cleanAndSegment(raw);

test('vendored drain exposes the four clean+segment helpers it claims to vendor', () => {
  for (const fn of ['_stripAnsi', '_normalizeOverdraw', '_isChromeLine', '_cleanAndSegment']) {
    assert.equal(typeof drain[fn], 'function', `drain.js must export ${fn} for parity testing`);
  }
});

test('LF transcript: vendored clean+segment is deep-equal to canonical agy.parseTranscript', () => {
  const raw = fixture('raw-pty-lf.log');
  const c = canonical(raw);
  const v = vendored(raw);

  // Guard against the vacuous pass: two broken implementations that both return
  // [] are also "deep-equal". Assert real content first, THEN equality.
  assert.ok(c.length > 0, 'canonical must parse the LF fixture to a non-empty result');
  assert.ok(
    c.some((m) => m.content.includes('s68r-canary-fixture-2026-08-01')),
    'canonical must recover the canary phrase from the LF fixture',
  );
  assert.deepEqual(v, c, 'drain.js vendored copy has drifted from agy.js — edit BOTH');
});

test('LF transcript: roles are attributed, not defaulted (user turns survive the `> ` box)', () => {
  const msgs = canonical(fixture('raw-pty-lf.log'));
  const roles = msgs.map((m) => m.role);
  assert.ok(roles.includes('user'), 'the `> `-prefixed prompt echoes must attribute to user');
  assert.ok(roles.includes('assistant'), 'model output must attribute to assistant');
  // A parser that blindly stamps everything 'assistant' would still contain the
  // canary and still be deep-equal to a matching vendored copy. Pin the shape.
  assert.deepEqual(roles, ['assistant', 'user', 'assistant', 'assistant', 'user', 'assistant']);
});

test('CRLF transcript: a CLI that emits its own \\r\\n must not silently parse to zero', () => {
  // A PTY's ONLCR already maps the program's \n to \r\n. A program writing its
  // OWN \r\n therefore lands on disk as \r\r\n. `_normalizeOverdraw` collapses
  // only `\r\n`, leaving a stranded `\r` at end-of-line — and it then keeps only
  // what follows the LAST \r, which is "". Every content line blanks out and the
  // transcript parses to []. Total, silent data loss.
  //
  // The fix is one character: /\r\n/g → /\r+\n/g (a strict superset; lone-CR
  // spinner overdraw has no following LF and is untouched).
  const raw = fixture('raw-pty-crlf.log');
  assert.ok(raw.includes('\r\r\n'), 'fixture must actually contain the \\r\\r\\n shape under test');

  const c = canonical(raw);
  assert.ok(
    c.length > 0,
    'CRLF transcript parsed to ZERO messages — see agy.js _normalizeOverdraw; '
    + 'change /\\r\\n/g to /\\r+\\n/g',
  );
  assert.ok(
    c.some((m) => m.content.includes('s68r-canary-fixture-2026-08-01')),
    'canary phrase lost from the CRLF transcript',
  );
});

test('CRLF transcript: vendored copy matches canonical (both fixed, or the pin is broken)', () => {
  const raw = fixture('raw-pty-crlf.log');
  assert.deepEqual(
    vendored(raw), canonical(raw),
    'drain.js and agy.js disagree on CRLF handling — the Class N pin requires both be fixed',
  );
});

test('line-ending variant is invisible: LF and CRLF captures of the same session agree', () => {
  // The two fixtures were generated from the same TUI content and differ only in
  // what the emitting program wrote as a terminator. Once normalisation is
  // correct, the parsed result must be identical — this is the property that
  // makes line-ending handling a non-issue rather than a per-CLI gamble.
  assert.deepEqual(
    canonical(fixture('raw-pty-crlf.log')),
    canonical(fixture('raw-pty-lf.log')),
    'same session captured with different line endings must parse identically',
  );
});

test('fail-soft parity: empty and garbage inputs agree and never throw', () => {
  for (const raw of ['', '\n\n\n', '\x1b[2K\x1b[0m', '────────\n⣾⣷⣯\n']) {
    const c = canonical(raw);
    const v = vendored(raw);
    assert.ok(Array.isArray(c) && Array.isArray(v));
    assert.deepEqual(v, c, `parity broken on fail-soft input ${JSON.stringify(raw)}`);
  }
});

// ── Second vendored pair: redact.js (ORCH relay 2026-08-01 16:12 ET) ─────────
//
// `assets/shims/redact.js` is a vendored copy of `packages/mcp-bridge/src/
// redact.js`, for the same Class-E reason drain.js vendors agy.js: a
// ~/.termdeck/shims/ artifact must not require() across into another package.
// T2's other vendored pair was pinned and the pin caught real drift; this one
// shipped without a pin. This is that pin.
//
// Unlike the agy.js pair — where only the ALGORITHM is shared and the files
// differ legitimately — this copy is asserted BYTE-IDENTICAL, because that is
// what the source comments promise and it is the strongest pin available.

test('assets/shims/redact.js is byte-identical to its mcp-bridge canonical', () => {
  const vendoredPath = path.join(path.dirname(DRAIN_JS), 'redact.js');
  const canonicalPath = path.join(REPO_ROOT, 'packages', 'mcp-bridge', 'src', 'redact.js');

  assert.ok(fs.existsSync(vendoredPath), 'redact.js must ship beside drain.js — the drain requires it');
  assert.ok(fs.existsSync(canonicalPath), 'the mcp-bridge canonical must exist');

  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  assert.equal(
    sha(vendoredPath), sha(canonicalPath),
    'vendored redact.js has drifted from packages/mcp-bridge/src/redact.js — '
    + 'INSTALLER-PITFALLS Class N: change both or neither',
  );
});

test('the vendored redactor is self-contained (Class E: no cross-package requires)', () => {
  // The whole reason for vendoring is that this file runs from
  // ~/.termdeck/shims/ where no package tree exists. A require() of anything
  // but a Node builtin would make it a hidden dependency that breaks on any
  // install layout other than the developer's.
  const src = fs.readFileSync(path.join(path.dirname(DRAIN_JS), 'redact.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const BUILTINS = new Set(['crypto', 'fs', 'path', 'os', 'util', 'node:crypto', 'node:fs', 'node:path', 'node:os', 'node:util']);
  for (const r of requires) {
    assert.ok(
      BUILTINS.has(r),
      `vendored redact.js requires "${r}" — only Node builtins are safe from ~/.termdeck/shims/`,
    );
  }
});

test('both redactor copies behave identically on a shared secret corpus', () => {
  // Byte-identity already implies this, but asserting behaviour means the pin
  // still says something useful if a future change makes the copies legitimately
  // differ (e.g. a header comment) and the byte pin is relaxed.
  const vendored = require(path.join(path.dirname(DRAIN_JS), 'redact.js'));
  const canonical = require(path.join(REPO_ROOT, 'packages', 'mcp-bridge', 'src', 'redact.js'));

  const CORPUS = [
    'postgresql://user:hunter2@db.example.com:5432/postgres',
    'sk-' + 'abcdefghijklmnopqrstuvwxyz012345',
    'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'xoxb-' + '1234567890-abcdefghijklmnop',
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'nothing secret here at all',
    '',
  ];
  for (const input of CORPUS) {
    assert.equal(
      vendored.redact(input), canonical.redact(input),
      `redactor behaviour drifted on: ${input.slice(0, 40)}`,
    );
  }
  // Guard the vacuous pass: prove the corpus actually exercises redaction.
  assert.match(canonical.redact(CORPUS[0]), /‹redacted:/, 'the corpus must contain something the redactor acts on');
  assert.equal(canonical.redact(CORPUS[6]), CORPUS[6], 'non-secret text must pass through untouched');
});
