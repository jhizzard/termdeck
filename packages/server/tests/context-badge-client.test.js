// Sprint 80 T2 — client-side FR-5 counter tests (classifyContextLevel +
// updateContextBadge + the id/class contract across app.js / style.css).
//
// app.js is browser-only (runs init() at load, references document/WebSocket) so
// it can't be require()'d. Same approach as dashboard-panels-client.test.js /
// escapehtml-client.test.js: brace-extract the function(s) and evaluate them in
// a vm with a stub document + state. Lives in packages/server/tests/ so the root
// npm-test glob fences it. (Kept in its own file rather than editing T3's
// dashboard-panels-client.test.js, per the app.js land-order boundary rule.)
//
// Run: node --test packages/server/tests/context-badge-client.test.js

'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const publicDir = join(__dirname, '..', '..', '..', 'packages', 'client', 'public');
const appSource = readFileSync(join(publicDir, 'app.js'), 'utf8');
const cssSource = readFileSync(join(publicDir, 'style.css'), 'utf8');

function extractFunction(name) {
  const start = appSource.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should be defined in app.js`);
  const bodyStart = appSource.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < appSource.length; i++) {
    const ch = appSource[i];
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return appSource.slice(start, i + 1); }
  }
  throw new Error(`${name} body was not closed`);
}

// Sandbox carrying both FR-5 client functions + a stub document + state.config.
// `thresholds` seeds state.config.contextThresholds (undefined → tests the
// hard-coded 350/400 fallback inside classifyContextLevel).
function makeCtx(thresholds) {
  const el = { style: { display: 'x' }, className: '', textContent: '', title: '' };
  const sandbox = { isFinite, console };
  sandbox._id = 'S1';
  sandbox.state = { config: thresholds === null ? {} : { contextThresholds: thresholds || { warnK: 350, overK: 400 } } };
  sandbox.document = { getElementById: (w) => (w === `ctx-${sandbox._id}` ? el : null) };
  vm.createContext(sandbox);
  vm.runInContext(`var classifyContextLevel = ${extractFunction('classifyContextLevel')};`, sandbox);
  vm.runInContext(`var updateContextBadge = ${extractFunction('updateContextBadge')};`, sandbox);
  return { el, sandbox };
}

// ── classifyContextLevel (pure) ──────────────────────────────────────────────

test('classifyContextLevel bands with explicit thresholds', () => {
  const fn = vm.runInThisContext(`(${extractFunction('classifyContextLevel')})`);
  assert.equal(fn(100, 350, 400), 'ok');
  assert.equal(fn(350, 350, 400), 'warn');
  assert.equal(fn(399, 350, 400), 'warn');
  assert.equal(fn(400, 350, 400), 'over');
  assert.equal(fn(999, 350, 400), 'over');
  assert.equal(fn(undefined, 350, 400), 'unknown');
});

test('classifyContextLevel falls back to 350/400 when thresholds absent', () => {
  const fn = vm.runInThisContext(`(${extractFunction('classifyContextLevel')})`);
  assert.equal(fn(349), 'ok');
  assert.equal(fn(360), 'warn');
  assert.equal(fn(410), 'over');
});

// ── updateContextBadge ───────────────────────────────────────────────────────

test('updateContextBadge hides the chip when contextK is absent/non-numeric', () => {
  const { el, sandbox } = makeCtx();
  sandbox.updateContextBadge('S1', {});
  assert.equal(el.style.display, 'none');
  sandbox.updateContextBadge('S1', { contextK: 'nope' });
  assert.equal(el.style.display, 'none');
});

test('updateContextBadge renders server-set level authoritatively', () => {
  const { el, sandbox } = makeCtx();
  sandbox.updateContextBadge('S1', { contextK: 120, contextLevel: 'ok' });
  assert.equal(el.style.display, '');
  assert.equal(el.textContent, '120K ctx');
  assert.equal(el.className, 'panel-ctx panel-ctx--ok');

  sandbox.updateContextBadge('S1', { contextK: 360, contextLevel: 'warn' });
  assert.equal(el.textContent, '⚠ 360K ctx');
  assert.equal(el.className, 'panel-ctx panel-ctx--warn');

  sandbox.updateContextBadge('S1', { contextK: 410, contextLevel: 'over' });
  assert.equal(el.textContent, '⛔ 410K ctx');
  assert.equal(el.className, 'panel-ctx panel-ctx--over');
});

test('updateContextBadge PATCH-only (no contextLevel) derives band from thresholds', () => {
  // T4 AUDIT-FAIL 21:27 regression: Brad's external watchdog PATCHes contextK
  // on a non-Claude panel with NO contextLevel — must still render + band.
  const { el, sandbox } = makeCtx({ warnK: 350, overK: 400 });
  sandbox.updateContextBadge('S1', { contextK: 77 }); // was: rendered NOTHING
  assert.equal(el.style.display, '');
  assert.equal(el.textContent, '77K ctx');
  assert.equal(el.className, 'panel-ctx panel-ctx--ok');

  sandbox.updateContextBadge('S1', { contextK: 415 }); // over, derived
  assert.equal(el.textContent, '⛔ 415K ctx');
  assert.equal(el.className, 'panel-ctx panel-ctx--over');
});

test('updateContextBadge PATCH-only uses default thresholds when config omits them', () => {
  const { el, sandbox } = makeCtx(null); // state.config has no contextThresholds
  sandbox.updateContextBadge('S1', { contextK: 360 });
  assert.equal(el.textContent, '⚠ 360K ctx'); // 360 ≥ default warn 350
});

test('updateContextBadge marks an active enforcement with ⚡ + tooltip', () => {
  const { el, sandbox } = makeCtx();
  sandbox.updateContextBadge('S1', {
    contextK: 410, contextLevel: 'over',
    contextAlert: { action: 'notify', maxContextK: 400 },
  });
  assert.match(el.textContent, /⚡$/);
  assert.match(el.title, /notify/);
  assert.match(el.title, /400K/);
});

test('updateContextBadge no-ops when the node is absent (non-terminal panels)', () => {
  const { sandbox } = makeCtx();
  assert.doesNotThrow(() => sandbox.updateContextBadge('DOES-NOT-EXIST', { contextK: 500, contextLevel: 'over' }));
});

// ── id/class contract across app.js + style.css ──────────────────────────────

test('app.js header markup includes the dedicated ctx node + wires the badge', () => {
  assert.match(appSource, /id="ctx-\$\{id\}"/, 'header markup must have the ctx-${id} node');
  assert.match(appSource, /class="panel-ctx"/, 'ctx node must carry the panel-ctx class');
  assert.match(appSource, /updateContextBadge\(id, meta\)/, 'updatePanelMeta must call updateContextBadge');
});

test('style.css defines the warn/over context bands', () => {
  assert.match(cssSource, /\.panel-ctx--warn/, 'style.css must define the warn band');
  assert.match(cssSource, /\.panel-ctx--over/, 'style.css must define the over band');
});
