// Sprint 71 B-T2 — tier-0 render parity: server copy ≡ bundled-hook copy.
//
// WHY THERE ARE TWO COPIES. `renderTier0Block` lives in
// packages/server/src/tier0.js AND is vendored into
// packages/stack-installer/assets/hooks/memory-pre-compact.js. The hook is
// installed to ~/.claude/hooks/ and runs from there; a require() reaching back
// into the server package would be INSTALLER-PITFALLS Class **E** — the exact
// hidden-dependency failure of ledger #10, which held Brad's memory store at
// zero rows for five days while every other signal looked healthy.
//
// So the duplication is deliberate, and the cost is Class **N** (lockstep
// drift): two artifacts that must change together and can silently stop
// agreeing. The shims made the same trade for drain.js/redact.js. What makes
// the trade safe is this fence — and it must fence what actually matters.
//
// IT COMPARES OUTPUT, NOT SOURCE TEXT. A source-diff fence would go red on a
// reformat and green on a semantic divergence introduced through a different
// code path. What has to hold is that both copies, given the same objectives,
// hand the agent the SAME BYTES: the human reads the server's render in the
// vault, the model reads the hook's render at compaction, and if those two
// disagree the tier has quietly forked into two different sets of rules.
//
// Run: node --test packages/server/tests/tier0-hook-parity.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serverTier0 = require('../src/tier0');

const HOOK_PATH = path.join(
  __dirname, '..', '..', 'stack-installer', 'assets', 'hooks', 'memory-pre-compact.js',
);

// The hook writes its log to ~/.claude/hooks/ on load-adjacent paths; give it a
// scratch HOME so requiring it here cannot touch the real one.
function loadHook() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tier0-parity-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'hooks'), { recursive: true });
    delete require.cache[require.resolve(HOOK_PATH)];
    return require(HOOK_PATH);
  } finally {
    process.env.HOME = origHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

const hook = loadHook();

// The fixture set is the contract. Every row shape either copy could plausibly
// diverge on gets an entry — if you add a branch to the renderer, add a fixture
// that exercises it, or the fence stops covering the thing you changed.
const FIXTURES = [
  { name: 'empty', rows: [] },
  { name: 'single unratified', rows: [{ id: 'a', text: 'No TypeScript.', rank: 1 }] },
  {
    name: 'single ratified',
    rows: [{ id: 'a', text: 'No TypeScript.', rank: 1, ratified_at: '2026-08-01T00:00:00Z', ratified_by: 'joshua' }],
  },
  {
    name: 'several, mixed ratification',
    rows: [
      { id: 'a', text: 'Zero build step is locked.', rank: 1, ratified_at: '2026-08-01' },
      { id: 'b', text: 'Never leak the internal project name externally.', rank: 2 },
      { id: 'c', text: 'RLS hygiene gates every release.', rank: 3, ratified_at: '2026-08-02' },
    ],
  },
  {
    name: 'column-name variants',
    rows: [
      { id: 'a', objective: 'via objective key', ordinal: 1 },
      { id: 'b', content: 'via content key', position: 2 },
      { id: 'c', statement: 'via statement key', priority: 3 },
    ],
  },
  {
    name: 'unranked mixed with ranked (the Number(null) trap)',
    rows: [
      { id: 'u', text: 'unranked one' },
      { id: 'a', text: 'ranked one', rank: 1 },
      { id: 'z', text: 'genuine rank zero', rank: 0 },
    ],
  },
  {
    name: 'over the cap',
    rows: Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, text: `objective ${i}`, rank: i })),
  },
  {
    name: 'pathologically long text',
    rows: [{ id: 'a', text: 'x'.repeat(5000), rank: 1 }],
  },
  {
    name: 'unrenderable rows mixed in',
    rows: [
      { id: 'a', rank: 1 },
      { id: 'b', text: '   ', rank: 2 },
      { id: 'c', text: 'the only real one', rank: 3 },
      null,
      'a string',
    ],
  },
  {
    name: 'markdown-ish characters in objective text',
    rows: [{ id: 'a', text: 'Use `npm publish` BEFORE `git push` — never the reverse.', rank: 1 }],
  },
];

for (const fx of FIXTURES) {
  test(`PARITY — normalize+render agree byte-for-byte: ${fx.name}`, () => {
    const serverRows = serverTier0.normalizeObjectives(fx.rows);
    const hookRows = hook.tier0Normalize(fx.rows);

    assert.deepEqual(
      hookRows, serverRows,
      'the two normalizers disagree — the hook and the server would inject '
      + 'different objective sets from the same store',
    );

    const serverBlock = serverTier0.renderTier0Block(serverRows);
    const hookBlock = hook.renderTier0Block(hookRows);

    assert.equal(
      hookBlock, serverBlock,
      'the two renders disagree — the human reads the server copy in the vault '
      + 'and the model reads the hook copy at compaction. Divergence here means '
      + 'the tier has forked into two different sets of rules. Change one, '
      + 'change both (INSTALLER-PITFALLS Class N).',
    );
  });
}

test('PARITY — the shared constants agree', () => {
  assert.equal(hook.TIER0_MAX_ROWS, serverTier0.TIER0_MAX_ROWS,
    'a different cap means the two copies inject different numbers of objectives');
  assert.equal(hook.TIER0_HEADING, serverTier0.TIER0_HEADING);
});

test('PARITY — cross-render: server rows into the hook renderer and vice versa', () => {
  // Guards the case where the normalizers drift in a way that happens to
  // cancel out against their own renderer but not against the other's.
  const rows = FIXTURES.find((f) => f.name === 'several, mixed ratification').rows;
  const serverRows = serverTier0.normalizeObjectives(rows);
  const hookRows = hook.tier0Normalize(rows);
  assert.equal(hook.renderTier0Block(serverRows), serverTier0.renderTier0Block(hookRows));
});

// ── the envelope contract, pinned at both emit surfaces ─────────────────────

test('ENVELOPE — both emit surfaces send tier0 UNCONDITIONALLY', () => {
  // One contract, one shape. The first cut omitted `tier0` from the WS frame
  // when empty, to keep the pre-71 frame byte-identical for its
  // `frame_size_bytes` telemetry — B-T4 rejected that, correctly: a field whose
  // presence is conditional on one surface and unconditional on the other
  // forces every client into two code paths for no reason a reader can infer.
  // A constant-size telemetry shift is much cheaper to explain.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

  // HTTP envelope: `tier0:` present with no spread-guard around it.
  assert.match(src, /tier0: tier0Payload\.tier0,/,
    'the HTTP recall envelope must emit tier0 unconditionally');

  // WS frame: same.
  assert.match(src, /tier0: tier0Frame\.tier0,/,
    'the WS proactive_memory frame must emit tier0 unconditionally');

  // And neither may reintroduce a conditional spread of the field.
  assert.doesNotMatch(src, /\.\.\.\(\s*tier0Frame\.tier0\.length/,
    'no conditional-presence spread for tier0 on the WS frame');
});

test('ENVELOPE — tier0 is an array on the empty payload, never null or absent', () => {
  const empty = serverTier0.emptyTier0Payload();
  assert.ok(Array.isArray(empty.tier0));
  assert.equal(empty.tier0.length, 0);
  // Which is what makes unconditional emission safe: there is always something
  // to emit.
});

test('the bundled hook carries a version stamp inside the 4096-byte window', () => {
  // Both refresh readers (stack-installer's installPreCompactHook and
  // `termdeck init --mnestra`) scan only the first 4 KB. Sprint 73 T1 hit
  // exactly this on the session-end hook: its changelog grew past 4 KB, the
  // stamp fell out of the window, and every refresh path silently disabled
  // itself. This file's docblock grew in Sprint 71 — pin the invariant.
  const head = fs.readFileSync(HOOK_PATH, 'utf8').slice(0, 4096);
  const m = head.match(/@termdeck\/stack-installer-hook v(\d+)/);
  assert.ok(m, 'version stamp must be within the first 4096 bytes');
  assert.ok(Number(m[1]) >= 4, 'tier-0 re-injection ships as v4 or later');
});
