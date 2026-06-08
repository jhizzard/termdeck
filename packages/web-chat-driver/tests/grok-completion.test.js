// Browser-free tests for layered completion detection — Sprint 72 T3.
//   • decideComplete(): the pure signal-fusion truth table.
//   • waitForComplete(): driven through BOTH the button-flip primary path and
//     the MutationObserver-quiet backstop path against a FAKE Playwright page
//     (no real browser) — proves the state machine end-to-end.
//   run: node --test packages/web-chat-driver/test/grok-completion.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  decideComplete,
  quietWaiterInPage,
  waitForComplete,
} = require('../src/grok/completion');
const grok = require('../src/grok');

// ── decideComplete truth table ──────────────────────────────────────────────
test('decideComplete: primary — generation started then stop gone → done', () => {
  assert.equal(decideComplete({ generationStarted: true, stopVisible: false }), true);
});
test('decideComplete: still streaming (stop visible) → not done', () => {
  assert.equal(decideComplete({ generationStarted: true, stopVisible: true }), false);
});
test('decideComplete: backstop — quiet AND affordance → done', () => {
  assert.equal(decideComplete({ quiet: true, affordancePresent: true }), true);
});
test('decideComplete: quiet WITHOUT affordance → not done (avoids false positive)', () => {
  assert.equal(decideComplete({ quiet: true, affordancePresent: false }), false);
});
test('decideComplete: no signals → not done', () => {
  assert.equal(decideComplete({}), false);
  assert.equal(decideComplete(undefined), false);
});

// ── quietWaiterInPage smoke ─────────────────────────────────────────────────
test('quietWaiterInPage is a serializable function that uses a MutationObserver', () => {
  assert.equal(typeof quietWaiterInPage, 'function');
  const src = quietWaiterInPage.toString();
  assert.match(src, /MutationObserver/);
  assert.match(src, /clearTimeout/);
});

// ── Fake Playwright page ─────────────────────────────────────────────────────
// Presence is keyed by token ("testid:<v>", "css:<v>", "role:<r>", "label",
// "placeholder"). A present locator reports count 1 and resolves waitFor() for
// the configured states; everything else reports count 0.
function fakeLocator({ count = 0, waitStates = [], innerText = '' } = {}) {
  const self = {
    first() { return self; },
    last() { return self; },
    async count() { return count; },
    async innerText() { return innerText; },
    async click() {},
    async fill() {},
    async press() {},
    async waitFor({ state } = {}) {
      if (waitStates.includes(state)) return;
      throw new Error(`fake timeout waiting for state=${state}`);
    },
  };
  return self;
}

function makePage(cfg = {}) {
  const present = cfg.present || new Set();
  const make = (token) => present.has(token)
    ? fakeLocator({ count: 1, waitStates: cfg.waitStates || [], innerText: cfg.innerText || '' })
    : fakeLocator({ count: 0 });
  return {
    getByTestId: (v) => make('testid:' + v),
    getByRole: (r) => make('role:' + r),
    getByLabel: () => make('label'),
    getByPlaceholder: () => make('placeholder'),
    locator: (css) => {
      if (css === 'body') return { async ariaSnapshot() { return cfg.ariaSnapshot || ''; } };
      return make('css:' + css);
    },
    accessibility: { async snapshot() { return null; } },
    async evaluate(_fn, _args) {
      return typeof cfg.evaluate === 'function' ? cfg.evaluate(_args) : cfg.evaluate;
    },
  };
}

// ── waitForComplete: primary button-flip path ──────────────────────────────
test('waitForComplete: button-flip — stop appears then hides → via "button-flip"', async () => {
  const page = makePage({
    present: new Set(['testid:stop-button']),
    waitStates: ['visible', 'hidden'], // stop becomes visible, then hidden
  });
  const res = await waitForComplete(page, { startTimeout: 50, maxTimeout: 50, quietMs: 5 });
  assert.equal(res.complete, true);
  assert.equal(res.via, 'button-flip');
});

// ── waitForComplete: backstop quiet + affordance ────────────────────────────
test('waitForComplete: no stop button → backstop quiet+affordance', async () => {
  const page = makePage({
    present: new Set(['testid:copy-message']), // copy affordance present
    ariaSnapshot: '',                            // self-heal finds no stop → resolve throws
    evaluate: () => true,                        // MutationObserver reports quiet
  });
  const res = await waitForComplete(page, { startTimeout: 30, maxTimeout: 30, quietMs: 5 });
  assert.equal(res.complete, true);
  assert.equal(res.via, 'quiet+affordance');
});

// ── waitForComplete: quiet reached but no affordance → DEGRADED ─────────────
test('waitForComplete: quiet but no affordance → DEGRADED (complete:false, via "quiet-only")', async () => {
  const page = makePage({
    present: new Set(),       // nothing resolvable
    ariaSnapshot: '',
    evaluate: () => true,     // quiet reached, but no copy/regenerate to corroborate
  });
  const res = await waitForComplete(page, { startTimeout: 30, maxTimeout: 30, quietMs: 5 });
  assert.equal(res.via, 'quiet-only');
  // quiet without affordance is NOT a confirmed completion (matches decideComplete).
  assert.equal(res.complete, false);
});

// ── waitForComplete: nothing resolvable and never quiet → DEGRADED ──────────
test('waitForComplete: never quiet, no controls → DEGRADED (complete:false, via "timeout")', async () => {
  const page = makePage({
    present: new Set(),
    ariaSnapshot: '',
    evaluate: () => false,    // quiet never reached
  });
  const res = await waitForComplete(page, { startTimeout: 20, maxTimeout: 20, quietMs: 5 });
  assert.equal(res.via, 'timeout');
  // No reliable completion signal within maxTimeout → NOT complete; consumers
  // must not treat extracted text as final. (T4-CODEX FINDING 2026-06-08 13:16.)
  assert.equal(res.complete, false);
});

// ── inject(): onComplete fires ONLY on a confirmed completion ───────────────
// Directly guards the auditor's concern: a degraded turn that still has partial
// text on screen must NOT be pushed to listeners as final.
test('inject: confirmed (button-flip) → returns {complete:true} and fires onComplete', async () => {
  const page = makePage({
    present: new Set(['testid:grok-composer', 'testid:send-button', 'testid:stop-button', 'css:[data-message-author-role="assistant"]']),
    waitStates: ['visible', 'hidden'],
    innerText: 'The capital is Paris.',
  });
  let pushed = null;
  grok.onComplete(page, (t) => { pushed = t; });
  const out = await grok.inject(page, 'capital of France?', { startTimeout: 20, maxTimeout: 50, quietMs: 5 });
  assert.equal(out.complete, true);
  assert.equal(out.via, 'button-flip');
  assert.equal(out.text, 'The capital is Paris.');
  assert.equal(pushed, 'The capital is Paris.', 'onComplete fires with final text on a confirmed turn');
});

test('inject: degraded (timeout) → returns {complete:false} and does NOT fire onComplete', async () => {
  const page = makePage({
    present: new Set(['testid:grok-composer', 'testid:send-button', 'css:[data-message-author-role="assistant"]']),
    ariaSnapshot: '',
    evaluate: () => false,                 // never quiet, no stop, no affordance → timeout
    innerText: 'partial answer so far',    // partial text IS on screen…
  });
  let fired = false;
  grok.onComplete(page, () => { fired = true; });
  const out = await grok.inject(page, 'write a long essay', { startTimeout: 20, maxTimeout: 20, quietMs: 5 });
  assert.equal(out.complete, false);
  assert.equal(out.via, 'timeout');
  assert.equal(out.text, 'partial answer so far');  // …returned best-effort to the pull caller…
  assert.equal(fired, false, '…but NEVER pushed to onComplete as a final turn');
});
