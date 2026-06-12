// Sprint 73 T3 — regression contract for termdeck#12, second half ("input box
// accumulates buffer-so-far per keystroke").
//
// Root cause (full chain in input-guard.js header): on composition-style
// keyboards xterm@5.5.0 reconstructs input from its hidden textarea, which is
// only cleared on non-composition Enter/Ctrl+C — so it accumulates the whole
// message, and CompositionHelper's replace/substring fallbacks re-emit the
// accumulated buffer once per word boundary. The reporter's ~110-char message
// reached the PTY as a 3,042-char cumulative-prefix stream.
//
// Two test groups:
//   1. Unit contract on the InputGuard module (require()'d directly — the
//      tests/launcher-resolver.test.js pattern), including a replay of the
//      reporter's exact runaway shape.
//   2. Wiring contract on app.js / index.html source (the
//      dashboard-panels-client.test.js pattern). This group FAILS against the
//      v1.6.0-shaped code: pre-Sprint-73, reconnectSession re-registered
//      terminal.onData per reconnect (leaked handler per reconnect, issue
//      #12's hypothesized cause-B family) and no guard existed at the
//      chokepoint.
//
// This file lives in packages/server/tests/ so the root `npm test` glob
// fences it (repo-root tests/ is NOT in the suite).

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const publicDir = join(__dirname, '..', '..', 'client', 'public');
const InputGuard = require(join(publicDir, 'input-guard.js'));
const appSource = readFileSync(join(publicDir, 'app.js'), 'utf8');
const htmlSource = readFileSync(join(publicDir, 'index.html'), 'utf8');
const cssSource = readFileSync(join(publicDir, 'style.css'), 'utf8');

// Brace-match a single named function declaration out of app.js
// (same helper as dashboard-panels-client.test.js).
function extractFunction(name) {
  const start = appSource.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should be defined in app.js`);
  const bodyStart = appSource.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `${name} should have a body`);
  let depth = 0;
  for (let i = bodyStart; i < appSource.length; i++) {
    const ch = appSource[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return appSource.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body was not closed`);
}

// Feed a chunk stream into a fresh guard at a fixed cadence; return per-chunk
// results plus pass/suppress accounting.
function replay(chunks, { cadenceMs = 200, guard = InputGuard.createGuard(), startAt = 1_000_000 } = {}) {
  const results = [];
  let forwardedChars = 0;
  let forwarded = 0;
  let suppressed = 0;
  chunks.forEach((data, i) => {
    const r = InputGuard.check(guard, data, startAt + i * cadenceMs);
    results.push(r);
    if (r.verdict === 'pass') { forwarded += 1; forwardedChars += data.length; }
    else suppressed += 1;
  });
  return { results, forwarded, forwardedChars, suppressed, guard };
}

// ===== Group 1: InputGuard unit contract =====

// The reporter's message from termdeck#12 (~110 chars). The observed runaway
// was its cumulative word-prefixes concatenated: 3,042 chars reached the PTY.
const ISSUE_12_MESSAGE = 'i think there is an issue with not being able to type into orch panel also. this is keyboard issue repeating';
const ISSUE_12_WORDS = ISSUE_12_MESSAGE.split(' ');
const ISSUE_12_RUNAWAY_CHUNKS = ISSUE_12_WORDS.map((_, i) => ISSUE_12_WORDS.slice(0, i + 1).join(' '));

test('issue #12 replay: cumulative-prefix runaway is cut off after the chain trips', () => {
  const totalRunawayChars = ISSUE_12_RUNAWAY_CHUNKS.reduce((n, c) => n + c.length, 0);
  assert.ok(totalRunawayChars > 1000, `runaway stream should be huge (got ${totalRunawayChars})`);

  const { results, forwardedChars, suppressed } = replay(ISSUE_12_RUNAWAY_CHUNKS);

  // Chain detection needs two multi-char links before the third trips, so a
  // small leading sliver passes; everything after is suppressed.
  assert.ok(forwardedChars <= 25, `only a sliver may reach the PTY (got ${forwardedChars} chars)`);
  assert.equal(suppressed, ISSUE_12_RUNAWAY_CHUNKS.length - 3, 'every chunk after the trip is suppressed');
  for (const r of results.slice(3)) {
    assert.equal(r.verdict, 'suppress');
    assert.equal(r.reason, 'prefix-chain');
  }
});

test('the same message typed normally (1-char deltas) passes untouched', () => {
  const { forwarded, suppressed } = replay(ISSUE_12_MESSAGE.split(''), { cadenceMs: 80 });
  assert.equal(suppressed, 0);
  assert.equal(forwarded, ISSUE_12_MESSAGE.length);
});

test('IME sibling-word commits pass (commits are not superstrings of each other)', () => {
  const commits = ['think ', 'there ', 'is an ', 'issue ', 'with not ', 'being able '];
  const { suppressed } = replay(commits, { cadenceMs: 400 });
  assert.equal(suppressed, 0);
});

test('a single predictive-commit rewrite (one prefix extension) passes; only the third chained link trips', () => {
  const guard = InputGuard.createGuard();
  assert.equal(InputGuard.check(guard, 'go', 1000).verdict, 'pass');          // below 4-char floor
  assert.equal(InputGuard.check(guard, 'good', 1200).verdict, 'pass');        // chain 1
  assert.equal(InputGuard.check(guard, 'goodbye', 1400).verdict, 'pass');     // chain 2 — legit-looking once
  const third = InputGuard.check(guard, 'goodbye fr', 1600);                  // chain 3 — runaway
  assert.equal(third.verdict, 'suppress');
  assert.equal(third.reason, 'prefix-chain');
});

test('DOM paste exemption: a huge chunk right after a paste event passes and resets chains', () => {
  const guard = InputGuard.createGuard();
  InputGuard.check(guard, 'i think', 1000);
  InputGuard.check(guard, 'i think there', 1200);
  InputGuard.notePaste(guard, 1400);
  const pasted = InputGuard.check(guard, 'x'.repeat(3042), 1500);
  assert.equal(pasted.verdict, 'pass');
  // Chain state was reset by the paste: the next extension starts a new chain.
  assert.equal(InputGuard.check(guard, 'i think there is', 1700).verdict, 'pass');
});

test('bracketed paste passes regardless of size and without a DOM paste event', () => {
  const guard = InputGuard.createGuard();
  const r = InputGuard.check(guard, '\x1b[200~' + 'x'.repeat(5000) + '\x1b[201~', 1000);
  assert.equal(r.verdict, 'pass');
});

test('ESC-prefixed protocol chunks never suppress and never chain (mouse-wheel burst)', () => {
  const wheel = Array.from({ length: 20 }, () => '\x1b[<64;30;10M');
  const { suppressed } = replay(wheel, { cadenceMs: 30 });
  assert.equal(suppressed, 0);
  const arrows = Array.from({ length: 10 }, () => '\x1b[A');
  assert.equal(replay(arrows, { cadenceMs: 30 }).suppressed, 0);
});

test('oversize single chunk without paste context is suppressed and holdable', () => {
  const guard = InputGuard.createGuard();
  const r = InputGuard.check(guard, 'y'.repeat(600), 1000);
  assert.equal(r.verdict, 'suppress');
  assert.equal(r.reason, 'oversize');
});

test('identical-repeat chain trips only at the high threshold (laughter stays legal)', () => {
  // 7 identical multi-char commits pass ("ha! ha! ha! …"), the 8th trips.
  const chunks = Array.from({ length: 8 }, () => 'ha! ');
  const { results, suppressed } = replay(chunks, { cadenceMs: 300 });
  assert.equal(suppressed, 1);
  assert.equal(results[7].reason, 'repeat-chain');
  // Three identical commits — the "no! no! no!" false-positive guard — pass.
  assert.equal(replay(['no! ', 'no! ', 'no! '], { cadenceMs: 300 }).suppressed, 0);
});

test('chain links must arrive within the window; a pause breaks the chain', () => {
  const guard = InputGuard.createGuard();
  InputGuard.check(guard, 'i think', 1000);
  InputGuard.check(guard, 'i think there', 1200);
  // 6s later (window is 5s): would-be third link starts a fresh chain instead.
  const late = InputGuard.check(guard, 'i think there is', 7200);
  assert.equal(late.verdict, 'pass');
});

test('suppression keeps tracking the runaway and recovers on non-chained input', () => {
  const { guard } = replay(ISSUE_12_RUNAWAY_CHUNKS);
  const lastAt = 1_000_000 + (ISSUE_12_RUNAWAY_CHUNKS.length - 1) * 200;
  // Still mid-runaway: another extension is still suppressed.
  const more = InputGuard.check(guard, ISSUE_12_RUNAWAY_CHUNKS.at(-1) + ' again', lastAt + 200);
  assert.equal(more.verdict, 'suppress');
  // User cleared the line and typed something fresh: passes, chain reset.
  const fresh = InputGuard.check(guard, 'hello world', lastAt + 400);
  assert.equal(fresh.verdict, 'pass');
  const extendOnce = InputGuard.check(guard, 'hello world again', lastAt + 600);
  assert.equal(extendOnce.verdict, 'pass');
});

test('suppress results carry forensics (counts and chain length)', () => {
  const { results } = replay(ISSUE_12_RUNAWAY_CHUNKS);
  const firstSuppressed = results.find((r) => r.verdict === 'suppress');
  assert.equal(typeof firstSuppressed.chainLength, 'number');
  assert.ok(firstSuppressed.chainLength >= InputGuard.DEFAULTS.prefixChainTripCount);
  assert.equal(typeof firstSuppressed.suppressedCount, 'number');
  assert.equal(typeof firstSuppressed.suppressedChars, 'number');
});

// ===== Group 2: app.js / index.html wiring contract =====
// Every assertion here fails against the pre-Sprint-73 (v1.6.0) shape.

test('wiring: exactly one onData registration in app.js (reconnect must not stack handlers)', () => {
  const registrations = appSource.match(/\.onData\(\(/g) || [];
  assert.equal(registrations.length, 1,
    `expected exactly 1 terminal.onData((…)) registration, found ${registrations.length} — ` +
    're-registering per reconnect leaks handlers (termdeck#12 cause-B family)');
});

test('wiring: reconnectSession does not touch onData and rebinds entry.ws in onopen', () => {
  const fn = extractFunction('reconnectSession');
  assert.ok(!fn.includes('.onData(('), 'reconnectSession must not re-register onData');
  assert.ok(fn.includes('entry.ws = ws'), 'reconnectSession must swap entry.ws for the creation-time handler to follow');
});

test('wiring: the onData chokepoint dereferences live state and calls the guard', () => {
  const start = appSource.indexOf('terminal.onData((');
  assert.notEqual(start, -1);
  const block = appSource.slice(start, start + 600);
  assert.ok(block.includes('state.sessions.get(id)'), 'handler must dereference entry at event time (not close over a socket)');
  assert.ok(block.includes('shouldSuppressPanelInput'), 'handler must consult the input guard');
  assert.ok(block.includes('entry.ws.readyState === WebSocket.OPEN'), 'handler must gate on the LIVE socket state');
});

test('wiring: guard helper exists, is loud, and surfaces the toast', () => {
  const fn = extractFunction('shouldSuppressPanelInput');
  assert.ok(fn.includes('InputGuard.check'), 'helper must delegate detection to the UMD module');
  assert.ok(fn.includes('console.error'), 'suppression must never be silent');
  assert.ok(fn.includes('showInputGuardToast'), 'suppression must surface to the operator');
});

test('wiring: textarea defenses — paste stamping and composition-safe idle-clear', () => {
  assert.ok(appSource.includes('InputGuard.notePaste'), 'DOM paste events must stamp the guard');
  assert.ok(appSource.includes("addEventListener('compositionstart'"), 'composition state must be tracked (public API)');
  assert.ok(appSource.includes("addEventListener('compositionend'"), 'composition state must be tracked (public API)');
  assert.ok(/if \(!composing && guardTa\.value\) guardTa\.value = '';/.test(appSource),
    'idle-clear must wipe the accumulating textarea only outside composition');
});

test('wiring: input-guard.js is loaded before app.js and the toast is styled', () => {
  const guardIdx = htmlSource.indexOf('<script src="input-guard.js"');
  const appIdx = htmlSource.indexOf('<script src="app.js"');
  assert.notEqual(guardIdx, -1, 'index.html must load input-guard.js');
  assert.notEqual(appIdx, -1);
  assert.ok(guardIdx < appIdx, 'input-guard.js must load before app.js (deferred scripts run in order)');
  assert.ok(cssSource.includes('.input-guard-toast'), 'style.css must style the guard toast');
});
