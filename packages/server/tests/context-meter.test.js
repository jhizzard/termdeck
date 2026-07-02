// Sprint 80 T2 — context-meter.js pure-core tests (FR-5 compute + FR-6 decision).
//
// Everything here is pure/off-disk-only (computeContextK reads a temp fixture;
// classifyContext + evaluateEnforcement are pure). NO server, NO PTY, NO timers
// — the FR-6 hysteresis + kill-grace state machine is exercised entirely through
// the pure transition function so the tricky invariants are deterministic.
//
// Run: node --test packages/server/tests/context-meter.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  computeContextK,
  classifyContext,
  evaluateEnforcement,
  normalizeAction,
} = require('../src/context-meter');

// ── fixture helpers ─────────────────────────────────────────────────────────

let _tmpDir;
function tmpDir() {
  if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-ctxmeter-'));
  return _tmpDir;
}
let _seq = 0;
function writeFixture(lines) {
  const p = path.join(tmpDir(), `fixture-${_seq++}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}
function assistantTurn(usage, extra = {}) {
  return { type: 'assistant', message: { role: 'assistant', usage }, ...extra };
}
function userTurn(text = 'hi') {
  return { type: 'user', message: { role: 'user', content: text } };
}

test.after(() => {
  if (_tmpDir) { try { fs.rmSync(_tmpDir, { recursive: true, force: true }); } catch (_e) { /* noop */ } }
});

// ── computeContextK ─────────────────────────────────────────────────────────

test('computeContextK sums input + cache_read + cache_creation', () => {
  const p = writeFixture([
    userTurn(),
    assistantTurn({ input_tokens: 534, cache_read_input_tokens: 307919, cache_creation_input_tokens: 872, output_tokens: 683 }),
  ]);
  const r = computeContextK(p);
  assert.equal(r.contextTokens, 534 + 307919 + 872);
  assert.equal(r.contextK, 309); // 309325 / 1000 rounded
});

test('computeContextK returns the MOST RECENT assistant usage', () => {
  const p = writeFixture([
    assistantTurn({ input_tokens: 10, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0 }), // 90K
    userTurn(),
    assistantTurn({ input_tokens: 10, cache_read_input_tokens: 190000, cache_creation_input_tokens: 0 }), // 190K
    userTurn('later'),
  ]);
  const r = computeContextK(p);
  assert.equal(r.contextK, 190);
});

test('computeContextK skips sidechain (sub-agent) turns', () => {
  const p = writeFixture([
    assistantTurn({ input_tokens: 5, cache_read_input_tokens: 400000, cache_creation_input_tokens: 0 }), // main: 400K
    // A sub-agent turn written AFTER the main turn — must NOT be picked.
    assistantTurn({ input_tokens: 5, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 }, { isSidechain: true }),
  ]);
  const r = computeContextK(p);
  assert.equal(r.contextK, 400);
});

test('computeContextK missing fields default to 0', () => {
  const p = writeFixture([
    assistantTurn({ input_tokens: 1000 }), // no cache_* fields
  ]);
  assert.equal(computeContextK(p).contextTokens, 1000);
});

test('computeContextK returns null for empty / missing / no-usage files', () => {
  assert.equal(computeContextK(path.join(tmpDir(), 'does-not-exist.jsonl')), null);
  const empty = writeFixture([]);
  // writeFixture always appends a trailing newline; make a truly empty file too.
  fs.writeFileSync(empty, '');
  assert.equal(computeContextK(empty), null);
  const noUsage = writeFixture([userTurn(), userTurn('again'), { type: 'summary', summary: 'x' }]);
  assert.equal(computeContextK(noUsage), null);
});

test('computeContextK ignores usage blocks whose token sum is 0', () => {
  const p = writeFixture([
    assistantTurn({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  assert.equal(computeContextK(p), null);
});

test('computeContextK survives a truncated / malformed tail line', () => {
  // A good turn, then a half-written final line (crash mid-append). The parser
  // must skip the garbage and still return the good earlier reading.
  const p = writeFixture([
    assistantTurn({ input_tokens: 10, cache_read_input_tokens: 250000, cache_creation_input_tokens: 0 }),
  ]);
  fs.appendFileSync(p, '{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":5,"cache_rea');
  const r = computeContextK(p);
  assert.equal(r.contextK, 250);
});

test('computeContextK tail-reads: last usage found even when file exceeds tailBytes', () => {
  // Pad the front with a large user turn, then the real assistant usage at the
  // very end. With a small tailBytes the front is never read, but the tail
  // (which holds the last usage) is — proving the tail-read logic.
  const bigPad = userTurn('X'.repeat(300 * 1024)); // ~300KB single line
  const p = writeFixture([
    bigPad,
    assistantTurn({ input_tokens: 20, cache_read_input_tokens: 123000, cache_creation_input_tokens: 0 }),
  ]);
  const r = computeContextK(p, { tailBytes: 64 * 1024 });
  assert.equal(r.contextK, 123);
});

test('computeContextK never throws on a directory path', () => {
  assert.equal(computeContextK(tmpDir()), null);
});

// ── classifyContext ─────────────────────────────────────────────────────────

test('classifyContext bands', () => {
  assert.equal(classifyContext(100, 350, 400), 'ok');
  assert.equal(classifyContext(349, 350, 400), 'ok');
  assert.equal(classifyContext(350, 350, 400), 'warn');
  assert.equal(classifyContext(399, 350, 400), 'warn');
  assert.equal(classifyContext(400, 350, 400), 'over');
  assert.equal(classifyContext(999, 350, 400), 'over');
});

test('classifyContext returns unknown for non-numeric input', () => {
  assert.equal(classifyContext(undefined, 350, 400), 'unknown');
  assert.equal(classifyContext(null, 350, 400), 'unknown');
  assert.equal(classifyContext(NaN, 350, 400), 'unknown');
});

// ── normalizeAction ─────────────────────────────────────────────────────────

test('normalizeAction defaults unknown/absent to notify', () => {
  assert.equal(normalizeAction('notify'), 'notify');
  assert.equal(normalizeAction('inject'), 'inject');
  assert.equal(normalizeAction('kill'), 'kill');
  assert.equal(normalizeAction('explode'), 'notify');
  assert.equal(normalizeAction(undefined), 'notify');
});

// ── evaluateEnforcement (FR-6 state machine) ────────────────────────────────

const CFG = { maxContextK: 400, warnK: 350, maxDeferrals: 3 };

test('evaluateEnforcement: disabled when maxContextK falsy', () => {
  const st = {};
  assert.equal(evaluateEnforcement({ contextK: 999, maxContextK: null, warnK: 350, state: st }).kind, 'none');
  assert.equal(evaluateEnforcement({ contextK: 999, maxContextK: 0, warnK: 350, state: st }).kind, 'none');
});

test('evaluateEnforcement: no reading (non-numeric contextK) → none', () => {
  assert.equal(evaluateEnforcement({ contextK: undefined, ...CFG, state: {} }).kind, 'none');
});

test('evaluateEnforcement: below cap but above warn → none (hold, no re-arm)', () => {
  assert.equal(evaluateEnforcement({ contextK: 380, action: 'notify', ...CFG, state: {} }).kind, 'none');
});

test('evaluateEnforcement: at/over cap while armed → fire, then latches', () => {
  const st = { armed: true, deferrals: 0 };
  const d1 = evaluateEnforcement({ contextK: 410, action: 'notify', ...CFG, state: st });
  assert.equal(d1.kind, 'fire');
  assert.equal(d1.action, 'notify');
  assert.equal(st.armed, false);
  // Still over cap on the next write → must NOT re-fire (one firing per episode).
  const d2 = evaluateEnforcement({ contextK: 420, action: 'notify', ...CFG, state: st });
  assert.equal(d2.kind, 'none');
});

test('evaluateEnforcement: hysteresis — drop below warn re-arms, next breach fires again', () => {
  const st = { armed: true, deferrals: 0 };
  assert.equal(evaluateEnforcement({ contextK: 410, action: 'notify', ...CFG, state: st }).kind, 'fire');
  // Rotation drops context below WARN → reset (re-arm).
  const reset = evaluateEnforcement({ contextK: 120, action: 'notify', ...CFG, state: st });
  assert.equal(reset.kind, 'reset');
  assert.equal(st.armed, true);
  // Climbs back over the cap → fires again.
  assert.equal(evaluateEnforcement({ contextK: 405, action: 'notify', ...CFG, state: st }).kind, 'fire');
});

test('evaluateEnforcement: drop below warn when never fired → none (no spurious reset)', () => {
  const st = { armed: true, deferrals: 0 };
  assert.equal(evaluateEnforcement({ contextK: 100, action: 'notify', ...CFG, state: st }).kind, 'none');
});

test('evaluateEnforcement: kill defers while mid-tool-use, up to maxDeferrals, then fires', () => {
  const st = { armed: true, deferrals: 0 };
  const args = { contextK: 410, action: 'kill', midToolUse: true, ...CFG, state: st };
  assert.equal(evaluateEnforcement(args).kind, 'defer'); // 1
  assert.equal(evaluateEnforcement(args).kind, 'defer'); // 2
  assert.equal(evaluateEnforcement(args).kind, 'defer'); // 3
  const fired = evaluateEnforcement(args); // 4th: cap exhausted → act anyway
  assert.equal(fired.kind, 'fire');
  assert.equal(fired.action, 'kill');
});

test('evaluateEnforcement: kill fires immediately when NOT mid-tool-use', () => {
  const st = { armed: true, deferrals: 0 };
  const d = evaluateEnforcement({ contextK: 410, action: 'kill', midToolUse: false, ...CFG, state: st });
  assert.equal(d.kind, 'fire');
  assert.equal(d.action, 'kill');
});

test('evaluateEnforcement: notify/inject do NOT defer on mid-tool-use', () => {
  for (const action of ['notify', 'inject']) {
    const st = { armed: true, deferrals: 0 };
    const d = evaluateEnforcement({ contextK: 410, action, midToolUse: true, ...CFG, state: st });
    assert.equal(d.kind, 'fire', `${action} should fire immediately`);
    assert.equal(d.action, action);
  }
});

test('evaluateEnforcement: kill deferral resets once context drops below warn', () => {
  const st = { armed: true, deferrals: 0 };
  const args = { contextK: 410, action: 'kill', midToolUse: true, ...CFG, state: st };
  evaluateEnforcement(args); // defer 1
  evaluateEnforcement(args); // defer 2
  assert.equal(st.deferrals, 2);
  // Rotation below warn → reset clears deferrals.
  evaluateEnforcement({ contextK: 100, action: 'kill', midToolUse: false, ...CFG, state: st });
  assert.equal(st.deferrals, 0);
  assert.equal(st.armed, true);
});

test('evaluateEnforcement: warnK above cap falls back to cap as re-arm floor', () => {
  // Misconfig guard: warnK not below the cap → re-arm floor is the cap itself.
  const st = { armed: true, deferrals: 0 };
  assert.equal(evaluateEnforcement({ contextK: 410, action: 'notify', maxContextK: 400, warnK: 500, state: st }).kind, 'fire');
  // Drop to just below the cap → reset (re-arm), since warn can't be the floor.
  assert.equal(evaluateEnforcement({ contextK: 399, action: 'notify', maxContextK: 400, warnK: 500, state: st }).kind, 'reset');
});
