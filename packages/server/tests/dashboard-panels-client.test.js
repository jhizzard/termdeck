// Sprint 65 T1 — pure-function + DOM-wiring tests for the dashboard
// project-filter chips, ORCH-panel pin, and tile-lifecycle code in app.js.
//
// app.js is browser-only (runs init() at load, references document / WebSocket)
// so it cannot be require()'d. Its pure helpers are tested the same way
// tests/escapehtml-client.test.js does: read the source, brace-match-extract a
// single function, and evaluate it in an isolated vm context. The DOM-wiring
// block then asserts the id/class contract between app.js, index.html and
// style.css (same shape as tests/graph-viewer-e2e.test.js).

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// This file lives in packages/server/tests/ so the root `npm test` glob fences
// it (T3 20:22 / T4 20:25). Three '..' hops: tests/ -> server/ -> packages/ -> repo root.
const publicDir = join(__dirname, '..', '..', '..', 'packages', 'client', 'public');
const appSource = readFileSync(join(publicDir, 'app.js'), 'utf8');
const htmlSource = readFileSync(join(publicDir, 'index.html'), 'utf8');
const cssSource = readFileSync(join(publicDir, 'style.css'), 'utf8');

// Brace-match a single named function declaration out of app.js.
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

// Compile one extracted pure helper. runInThisContext (not runInNewContext)
// so the helper builds arrays/objects with this realm's intrinsics — a
// new-context realm would give them foreign prototypes and break
// assert.deepStrictEqual. These helpers are pure (no DOM, no app.js globals),
// so sharing the current context is safe.
function loadHelper(name) {
  return vm.runInThisContext(`(${extractFunction(name)})`);
}

const PURE_HELPERS = [
  'discoverPanelProjects', 'countPanelsForProject', 'isPanelVisibleUnderFilter',
  'shouldShowChipRow', 'isOrchestratorRole', 'findOrphanedPanelIds', 'annotateApiFailure',
  'filterValueRevealingPanel', 'clampFontSize',
];

// Each helper must have exactly one definition (no accidental duplication).
for (const name of PURE_HELPERS) {
  test(`app.js defines exactly one ${name}`, () => {
    const re = new RegExp('function ' + name + '\\s*\\(', 'g');
    assert.equal((appSource.match(re) || []).length, 1);
  });
}

// --- 1.1: discoverPanelProjects -------------------------------------------

test('discoverPanelProjects dedupes project tags and flags untagged panels', () => {
  const discoverPanelProjects = loadHelper('discoverPanelProjects');
  const r = discoverPanelProjects([
    { project: 'aetheria', status: 'active' },
    { project: 'aetheria', status: 'thinking' },
    { project: 'structural360', status: 'active' },
    { project: null, status: 'active' },
  ]);
  assert.deepEqual(r.projects, ['aetheria', 'structural360']);
  assert.equal(r.hasNullProject, true);
});

test('discoverPanelProjects sorts projects and excludes exited panels', () => {
  const discoverPanelProjects = loadHelper('discoverPanelProjects');
  const r = discoverPanelProjects([
    { project: 'zeta', status: 'active' },
    { project: 'alpha', status: 'active' },
    { project: 'gone', status: 'exited' },
  ]);
  assert.deepEqual(r.projects, ['alpha', 'zeta']);
  assert.equal(r.hasNullProject, false);
});

test('discoverPanelProjects treats an empty-string project as untagged', () => {
  const discoverPanelProjects = loadHelper('discoverPanelProjects');
  const r = discoverPanelProjects([{ project: '', status: 'active' }]);
  assert.deepEqual(r.projects, []);
  assert.equal(r.hasNullProject, true);
});

test('discoverPanelProjects tolerates empty / missing input', () => {
  const discoverPanelProjects = loadHelper('discoverPanelProjects');
  assert.deepEqual(discoverPanelProjects([]), { projects: [], hasNullProject: false });
  assert.deepEqual(discoverPanelProjects(undefined), { projects: [], hasNullProject: false });
});

// --- 1.1: countPanelsForProject -------------------------------------------

test('countPanelsForProject — "All" counts every live panel, excluding exited', () => {
  const countPanelsForProject = loadHelper('countPanelsForProject');
  const metas = [
    { project: 'aetheria', status: 'active' },
    { project: 'structural360', status: 'thinking' },
    { project: null, status: 'active' },
    { project: 'aetheria', status: 'exited' },
  ];
  assert.equal(countPanelsForProject(metas, ''), 3);
});

test('countPanelsForProject — a project chip counts only its own live panels', () => {
  const countPanelsForProject = loadHelper('countPanelsForProject');
  const metas = [
    { project: 'aetheria', status: 'active' },
    { project: 'aetheria', status: 'thinking' },
    { project: 'aetheria', status: 'exited' },
    { project: 'structural360', status: 'active' },
  ];
  assert.equal(countPanelsForProject(metas, 'aetheria'), 2);
  assert.equal(countPanelsForProject(metas, 'structural360'), 1);
});

// --- 1.1: isPanelVisibleUnderFilter ---------------------------------------

test('isPanelVisibleUnderFilter — "All" ("") shows every panel', () => {
  const isPanelVisibleUnderFilter = loadHelper('isPanelVisibleUnderFilter');
  assert.equal(isPanelVisibleUnderFilter('aetheria', ''), true);
  assert.equal(isPanelVisibleUnderFilter(null, ''), true);
});

test('isPanelVisibleUnderFilter — a project filter shows only exact matches', () => {
  const isPanelVisibleUnderFilter = loadHelper('isPanelVisibleUnderFilter');
  assert.equal(isPanelVisibleUnderFilter('aetheria', 'aetheria'), true);
  assert.equal(isPanelVisibleUnderFilter('structural360', 'aetheria'), false);
  // An untagged panel is hidden under any specific-project filter.
  assert.equal(isPanelVisibleUnderFilter(null, 'aetheria'), false);
});

// --- 1.1: shouldShowChipRow -----------------------------------------------

test('shouldShowChipRow — hidden for a single homogeneous project', () => {
  const shouldShowChipRow = loadHelper('shouldShowChipRow');
  assert.equal(shouldShowChipRow(['aetheria'], false), false);
  assert.equal(shouldShowChipRow([], false), false);
});

test('shouldShowChipRow — shown when there is real filtering to do', () => {
  const shouldShowChipRow = loadHelper('shouldShowChipRow');
  assert.equal(shouldShowChipRow(['aetheria', 'structural360'], false), true);
  // One project plus some untagged panels still warrants an All-vs-project chip.
  assert.equal(shouldShowChipRow(['aetheria'], true), true);
});

// --- 1.2: isOrchestratorRole ----------------------------------------------

test('isOrchestratorRole — only the explicit orchestrator role qualifies', () => {
  const isOrchestratorRole = loadHelper('isOrchestratorRole');
  assert.equal(isOrchestratorRole('orchestrator'), true);
  assert.equal(isOrchestratorRole('worker'), false);
  assert.equal(isOrchestratorRole('auditor'), false);
  assert.equal(isOrchestratorRole(null), false);
  assert.equal(isOrchestratorRole(undefined), false);
});

// --- 1.3: findOrphanedPanelIds --------------------------------------------

test('findOrphanedPanelIds — tile ids absent from the broadcast are orphaned', () => {
  const findOrphanedPanelIds = loadHelper('findOrphanedPanelIds');
  assert.deepEqual(findOrphanedPanelIds(['a', 'b', 'c'], ['a', 'c']), ['b']);
  assert.deepEqual(findOrphanedPanelIds(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(findOrphanedPanelIds(['x'], []), ['x']);
  assert.deepEqual(findOrphanedPanelIds([], ['a']), []);
});

// --- 1.3b: annotateApiFailure (T4's 19:44 410-body-trap fix) --------------

test('annotateApiFailure — a 410 dead-panel body gains a uniform error signal', () => {
  const annotateApiFailure = loadHelper('annotateApiFailure');
  // T2's planned dead-panel shape — note: no `error` key, so the pre-fix
  // reply path (gating on !result.error) would misreport it as delivered.
  const out = annotateApiFailure(
    { ok: false, code: 'panel_exited', message: 'Panel abc has exited' }, 410);
  assert.equal(out._httpStatus, 410);
  assert.equal(out.error, 'Panel abc has exited'); // message preferred
  assert.equal(out.ok, false);                     // original fields preserved
});

test('annotateApiFailure — falls back to code, then HTTP status, for error text', () => {
  const annotateApiFailure = loadHelper('annotateApiFailure');
  assert.equal(annotateApiFailure({ code: 'panel_exited' }, 410).error, 'panel_exited');
  assert.equal(annotateApiFailure({}, 503).error, 'HTTP 503');
  assert.equal(annotateApiFailure(null, 500).error, 'HTTP 500');
});

test('annotateApiFailure — an existing error field is left intact', () => {
  const annotateApiFailure = loadHelper('annotateApiFailure');
  const out = annotateApiFailure({ error: 'Session is exited' }, 404);
  assert.equal(out.error, 'Session is exited');
  assert.equal(out._httpStatus, 404);
});

// --- 1.1: filterValueRevealingPanel (born-hidden guard — T3 20:10 / T4 20:11) ---

test('filterValueRevealingPanel — the initial restore (flag false) never switches', () => {
  const f = loadHelper('filterValueRevealingPanel');
  // A reload must honor the operator's saved filter, not jump to a restored panel.
  assert.equal(f('aetheria', 'structural360', false, false), null);
});

test('filterValueRevealingPanel — a user-spawned panel hidden by a stale filter reveals its project', () => {
  const f = loadHelper('filterValueRevealingPanel');
  assert.equal(f('aetheria', 'structural360', false, true), 'structural360');
});

test('filterValueRevealingPanel — an untagged panel under a project filter switches to All', () => {
  const f = loadHelper('filterValueRevealingPanel');
  assert.equal(f('aetheria', null, false, true), '');
});

test('filterValueRevealingPanel — no switch when the new panel already matches the filter', () => {
  const f = loadHelper('filterValueRevealingPanel');
  assert.equal(f('aetheria', 'aetheria', false, true), null);
});

test('filterValueRevealingPanel — no switch under the "All" filter', () => {
  const f = loadHelper('filterValueRevealingPanel');
  assert.equal(f('', 'structural360', false, true), null);
});

test('filterValueRevealingPanel — ORCH panels bypass the guard (never filtered)', () => {
  const f = loadHelper('filterValueRevealingPanel');
  assert.equal(f('aetheria', 'structural360', true, true), null);
});

// --- (c): clampFontSize (terminal font-size guard) ------------------------

test('clampFontSize — clamps to the supported [8, 22] range', () => {
  const clampFontSize = loadHelper('clampFontSize');
  assert.equal(clampFontSize(5), 8);
  assert.equal(clampFontSize(8), 8);
  assert.equal(clampFontSize(13), 13);
  assert.equal(clampFontSize(22), 22);
  assert.equal(clampFontSize(40), 22);
});

test('clampFontSize — rounds, coerces; non-numbers fall back to the 13 default', () => {
  const clampFontSize = loadHelper('clampFontSize');
  assert.equal(clampFontSize(12.4), 12);
  assert.equal(clampFontSize('11'), 11);
  assert.equal(clampFontSize(NaN), 13);
  assert.equal(clampFontSize(undefined), 13);
  assert.equal(clampFontSize('not-a-number'), 13);
});

// --- DOM-wiring contract: app.js <-> index.html <-> style.css -------------

test('index.html declares the ORCH-pin row and project-chips containers', () => {
  assert.match(htmlSource, /id="orch-pin-row"/);
  assert.match(htmlSource, /id="project-chips"/);
});

test('app.js looks up the same container ids index.html declares', () => {
  assert.ok(appSource.includes("getElementById('orch-pin-row')"));
  assert.ok(appSource.includes("getElementById('project-chips')"));
});

test('both ws.onmessage switches route the panel_exited frame', () => {
  const matches = appSource.match(/case 'panel_exited':/g) || [];
  assert.equal(matches.length, 2, 'panel_exited handled in the main + reconnect switches');
});

test('api() branches on res.ok and annotates non-2xx bodies', () => {
  assert.ok(appSource.includes('if (res.ok) return res.json();'));
  assert.ok(appSource.includes('annotateApiFailure(data, res.status)'));
});

test('style.css ships the chip / ORCH / tile-state classes', () => {
  for (const sel of [
    '.project-chips-row', '.project-chip', '.panel--filtered-out',
    '.orch-pin-row', '.panel--role-orch', '.panel--exiting',
  ]) {
    assert.ok(cssSource.includes(sel), `style.css should define ${sel}`);
  }
});

// --- 1.4: Path A dense layout presets -------------------------------------

test('1.4 — dense layout presets are wired across app.js, style.css, index.html', () => {
  // Keyboard layout array carries the new 8/9/0 presets (1x2, 4x3, 4x4).
  assert.ok(
    appSource.includes("'orch', '1x2', '4x3', '4x4'"),
    'app.js keyboard layouts array should append 1x2 / 4x3 / 4x4');
  // CSS grid template + topbar button exist for every dense preset.
  for (const layout of ['1x2', '2x5', '5x2', '4x3', '3x4', '4x4']) {
    assert.ok(cssSource.includes(`.grid-container.layout-${layout}`),
      `style.css should define .grid-container.layout-${layout}`);
    assert.ok(htmlSource.includes(`data-layout="${layout}"`),
      `index.html should have a layout button for ${layout}`);
  }
});

// --- (c): terminal font-size stepper --------------------------------------

test('(c) — font-size stepper is wired across index.html, style.css, app.js', () => {
  for (const id of ['btn-font-dec', 'btn-font-inc', 'fontSizeLabel']) {
    assert.ok(htmlSource.includes(`id="${id}"`), `index.html should declare #${id}`);
  }
  for (const sel of ['.topbar-fontsize', '.font-step-btn', '.font-size-label']) {
    assert.ok(cssSource.includes(sel), `style.css should define ${sel}`);
  }
  assert.ok(appSource.includes("getElementById('btn-font-dec')"), 'app.js wires #btn-font-dec');
  assert.ok(appSource.includes("getElementById('btn-font-inc')"), 'app.js wires #btn-font-inc');
  assert.ok(appSource.includes('function stepFontSize'), 'app.js defines the stepFontSize handler');
});
