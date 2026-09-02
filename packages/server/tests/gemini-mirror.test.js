// Sprint 71 B-T2 — Gemini read-mirror: dark-by-default + the egress gates.
//
// This job writes memory content into Google's cloud, where it is readable by
// anyone the sheet is shared with — including, later, anyone the operator
// forgets they shared it with. So the tests that matter here are not "does it
// write a sheet"; they are "what does it REFUSE to write, and does it refuse
// when its own machinery breaks".
//
// Every gate must FAIL CLOSED. A redaction rule that throws, a privacy column
// in a shape we do not recognise, a forbidden string that survives redaction —
// each of those must drop the row, not publish it. A gate that fails open is
// worse than no gate, because it is trusted.
//
// Run: node --test packages/server/tests/gemini-mirror.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mirror = require('../src/gemini-mirror');

// The real redact layer, loaded the same way production loads it. Using a stub
// here would test the plumbing and not the protection.
const realDeps = mirror.loadBridgeDeps();
const realRedact = realDeps.redact;

// A SYNTHETIC forbidden literal. The real org literals are deliberately not in
// this repo — not in the module, and not here either. The gate loads them from
// the operator's denylist outside the tree (see the module header), so these
// tests supply their own literal through the same channel. Nothing about the
// gate's behavior depends on which string it is.
const FORBIDDEN_SAMPLE = 'acmeinternalproject';

// HERMETIC ENV — and this is not incidental hygiene.
//
// redact.js loads an external denylist from ~/.termdeck/bridge-redact.json,
// which on a working operator machine very likely already contains the internal
// project name. The first cut of these tests ran against process.env and passed
// the mask/drop assertions for the WRONG REASON: the developer's own denylist
// was doing the scrubbing, so the gate under test was never exercised. On a
// machine without that file — every user's machine — the same code path was
// untested. Pointing the loader at a path that does not exist forces the
// built-in rules only, so what these tests measure is this module's behavior
// and not the developer's local configuration.
const HERMETIC_ENV = {
  TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json',
  TERMDECK_BRIDGE_REDACT_LITERALS: '',
  TERMDECK_MIRROR_FORBIDDEN: FORBIDDEN_SAMPLE,
};

// ── dark by default ─────────────────────────────────────────────────────────

test('DARK — no env flag means disabled, and start() is a no-op', async () => {
  const m = mirror.createGeminiMirror({ config: {}, env: {} });
  assert.equal(m.enabled, false);
  assert.match(m.reason, /TERMDECK_GEMINI_MIRROR/);
  m.start();
  m.stop();
  assert.deepEqual(await m.runOnce(), { skipped: 'disabled' });
});

test('DARK — the flag alone is not enough; a sheet id is the second key', async () => {
  const logs = [];
  const m = mirror.createGeminiMirror({
    config: {}, env: { TERMDECK_GEMINI_MIRROR: '1' }, log: (s) => logs.push(s),
  });
  assert.equal(m.enabled, false);
  assert.deepEqual(await m.runOnce(), { skipped: 'no-sheet-id' });
  assert.ok(logs.some((l) => /no sheet id/i.test(l)),
    'enabled-but-misconfigured must be loud — the silent version is a job that '
    + 'ticks forever writing nothing');
});

test('DARK — enabling requires BOTH keys and then reports its schedule', () => {
  const m = mirror.createGeminiMirror({
    config: {},
    env: { TERMDECK_GEMINI_MIRROR: '1', TERMDECK_GEMINI_MIRROR_SHEET_ID: 'sheet-abc' },
    log: () => {},
  });
  assert.equal(m.enabled, true);
  assert.equal(m.sheetId, 'sheet-abc');
  assert.equal(m.intervalMs, mirror.DEFAULT_INTERVAL_MS);
});

test('DARK — start() names the operator share step, because that IS the delivery mechanism', () => {
  const logs = [];
  const m = mirror.createGeminiMirror({
    config: {},
    env: { TERMDECK_GEMINI_MIRROR: '1', TERMDECK_GEMINI_MIRROR_SHEET_ID: 's' },
    log: (s) => logs.push(s),
    tier0Provider: { fetch: async () => ({ tier0: [] }) },
    fetchImpl: async () => { throw new Error('no network in test'); },
    sheets: { async batchUpdateValues() { return { updatedCells: 0 }; } },
    getToken: async () => 'tok',
  });
  m.start();
  m.stop();
  assert.ok(logs.some((l) => /share that sheet/i.test(l)),
    'the service account cannot grant a human access to the sheet; if the '
    + 'operator never shares it, the mirror writes into a document nobody reads');
});

// ── gate 1: privacy tags ────────────────────────────────────────────────────

test('PRIVACY — a tagged row never reaches the sheet', () => {
  const { rows, dropped } = mirror.buildMirrorRows({
    memories: [
      { content: 'public thing', project: 'p', source_type: 'decision', privacy_tags: [] },
      { content: 'SECRET THERAPY NOTE', project: 'p', source_type: 'decision', privacy_tags: ['private'] },
    ],
    redact: realRedact,
  });
  assert.equal(dropped.privacy, 1);
  const flat = JSON.stringify(rows);
  assert.ok(flat.includes('public thing'));
  assert.ok(!flat.includes('SECRET THERAPY NOTE'));
});

test('PRIVACY — an unrecognised privacy_tags shape is treated as TAGGED (fail closed)', () => {
  for (const shape of [{ a: 1 }, 42, true, new Date()]) {
    assert.equal(mirror.isPrivacyTagged({ privacy_tags: shape }), true,
      `shape ${JSON.stringify(shape)} must fail closed`);
  }
});

test('PRIVACY — the empty Postgres array literal is NOT tagged', () => {
  assert.equal(mirror.isPrivacyTagged({ privacy_tags: '{}' }), false);
  assert.equal(mirror.isPrivacyTagged({ privacy_tags: '[]' }), false);
  assert.equal(mirror.isPrivacyTagged({ privacy_tags: [] }), false);
  assert.equal(mirror.isPrivacyTagged({ privacy_tags: null }), false);
  assert.equal(mirror.isPrivacyTagged({}), false);
});

test('PRIVACY — a non-empty string form IS tagged', () => {
  assert.equal(mirror.isPrivacyTagged({ privacy_tags: '{private}' }), true);
  assert.equal(mirror.isPrivacyTagged({ privacy_tags: 'private' }), true);
});

// ── gate 2: redaction ───────────────────────────────────────────────────────

test('REDACTION — a credential in memory content is scrubbed before egress', () => {
  const secret = `sk-ant-api03-${'A'.repeat(40)}`;
  const { rows } = mirror.buildMirrorRows({
    memories: [{ content: `the key is ${secret}`, project: 'p', source_type: 'note', privacy_tags: [] }],
    redact: realRedact,
  });
  const flat = JSON.stringify(rows);
  assert.ok(!flat.includes(secret), 'raw credential must not reach the sheet');
});

test('REDACTION — a throwing rule drops to the fail-closed marker, never raw text', () => {
  const exploding = { redact() { throw new Error('rule blew up'); } };
  const out = mirror.redactCell('sensitive raw text', exploding, {});
  assert.equal(out, '‹redacted:redaction-failed›');
  assert.ok(!out.includes('sensitive raw text'),
    'a redaction layer that falls back to raw output on error is worse than '
    + 'none, because it is trusted');
});

test('REDACTION — a non-string return is also treated as failure', () => {
  const weird = { redact() { return { not: 'a string' }; } };
  assert.equal(mirror.redactCell('raw', weird, {}), '‹redacted:redaction-failed›');
});

// ── gate 3: forbidden strings ───────────────────────────────────────────────

test('FORBIDDEN — the internal project name is MASKED, and the row survives', () => {
  // Masking rather than dropping: the surrounding memory is still worth
  // mirroring, and silently losing rows is its own failure mode. The row is
  // published with the name replaced; the name itself never egresses.
  const { rows, dropped } = mirror.buildMirrorRows({
    memories: [
      { content: `we deployed to ${FORBIDDEN_SAMPLE} last night`, project: 'p', source_type: 'note', privacy_tags: [] },
      { content: 'an innocuous decision', project: 'p', source_type: 'note', privacy_tags: [] },
    ],
    redact: realRedact,
    env: HERMETIC_ENV,
  });
  assert.equal(rows.length, 2);
  assert.equal(dropped.forbidden, 0, 'the backstop should not need to fire when masking works');
  const flat = JSON.stringify(rows).toLowerCase();
  assert.ok(!flat.includes(FORBIDDEN_SAMPLE), 'the name must not egress');
  assert.match(rows[0][3], /‹redacted:internal-name›/);
  assert.match(rows[0][3], /we deployed to/, 'the surrounding text survives');
});

test('FORBIDDEN — masking is case-insensitive', () => {
  const masked = mirror.maskForbidden(
    `PREFIX ${FORBIDDEN_SAMPLE.toUpperCase()} SUFFIX`,
    mirror.forbiddenNeedles(HERMETIC_ENV),
  );
  assert.ok(!masked.toLowerCase().includes(FORBIDDEN_SAMPLE));
  assert.match(masked, /PREFIX ‹redacted:internal-name› SUFFIX/);
});

test('FORBIDDEN — every occurrence is masked, not just the first', () => {
  const masked = mirror.maskForbidden(
    `${FORBIDDEN_SAMPLE} and again ${FORBIDDEN_SAMPLE}`,
    mirror.forbiddenNeedles(HERMETIC_ENV),
  );
  assert.ok(!masked.toLowerCase().includes(FORBIDDEN_SAMPLE));
});

test('FORBIDDEN — it also covers the PROJECT column, not just content', () => {
  const { rows } = mirror.buildMirrorRows({
    memories: [{ content: 'harmless', project: FORBIDDEN_SAMPLE, source_type: 'n', privacy_tags: [] }],
    redact: realRedact,
    env: HERMETIC_ENV,
  });
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).toLowerCase().includes(FORBIDDEN_SAMPLE));
  assert.match(rows[0][1], /‹redacted:internal-name›/);
});

test('FORBIDDEN — objectives are gated on the same terms as memories', () => {
  // Tier 0 is operator-ratified prose, which makes it MORE likely to name
  // internal things, not less.
  const { rows } = mirror.buildMirrorRows({
    tier0: [
      { text: `never mention ${FORBIDDEN_SAMPLE}`, project: 'p', rank: 1 },
      { text: 'zero build step is locked', project: 'p', rank: 2 },
    ],
    redact: realRedact,
    env: HERMETIC_ENV,
  });
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).toLowerCase().includes(FORBIDDEN_SAMPLE));
  assert.match(rows[1][3], /zero build step/);
});

test('FORBIDDEN — the BACKSTOP primitive detects what masking should have removed', () => {
  // `containsForbidden` is the final assertion inside buildMirrorRows. After
  // masking it should be unreachable — which is exactly why it needs its own
  // test: a backstop only ever runs when something upstream is already broken,
  // so it will never be exercised by the happy path.
  const needles = mirror.forbiddenNeedles(HERMETIC_ENV);
  assert.equal(mirror.containsForbidden(FORBIDDEN_SAMPLE, needles), true);
  assert.equal(mirror.containsForbidden(`padding ${FORBIDDEN_SAMPLE} padding`, needles), true);
  assert.equal(mirror.containsForbidden(FORBIDDEN_SAMPLE.toUpperCase(), needles), true);
  assert.equal(mirror.containsForbidden('nothing to see here', needles), false);
  assert.equal(mirror.containsForbidden('', needles), false);
  assert.equal(mirror.containsForbidden(null, needles), false);
});

test('FORBIDDEN — the row is never published raw: it is masked, or it is dropped', () => {
  // The invariant that actually matters, stated once over both outcomes. Which
  // branch handles it is an implementation detail; that the literal does not
  // reach the sheet is not.
  const { rows, dropped } = mirror.buildMirrorRows({
    memories: [{ content: `leaks ${FORBIDDEN_SAMPLE} here`, project: 'p', source_type: 'n', privacy_tags: [] }],
    redact: realRedact,
    env: HERMETIC_ENV,
  });
  assert.ok(!JSON.stringify(rows).toLowerCase().includes(FORBIDDEN_SAMPLE));
  assert.equal(rows.length + dropped.forbidden, 1, 'accounted for exactly once');
});

test('FORBIDDEN — an EMPTY denylist is warned about loudly, never passed over in silence', async () => {
  // This is the one state where the gate does nothing at all: no
  // ~/.termdeck/bridge-redact.json, no literals in either env var. Built-in
  // redaction still runs, so it is not fatal — but a gate that silently does
  // nothing is worse than an absent one, because the operator believes it is
  // protecting them.
  const logs = [];
  const m = mirror.createGeminiMirror({
    config: { rag: { supabaseUrl: 'https://x.invalid', supabaseKey: 'k' } },
    env: {
      TERMDECK_GEMINI_MIRROR: '1',
      TERMDECK_GEMINI_MIRROR_SHEET_ID: 'sheet-1',
      TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json',
      TERMDECK_BRIDGE_REDACT_LITERALS: '',
      TERMDECK_MIRROR_FORBIDDEN: '',
    },
    log: (s) => logs.push(s),
    tier0Provider: { fetch: async () => ({ tier0: [] }) },
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return []; }, async text() { return ''; } }),
    getToken: async () => 'tok',
    sheets: { async batchUpdateValues() { return { updatedCells: 0 }; } },
    deps: { ...realDeps },
  });
  await m.runOnce();
  assert.ok(
    logs.some((l) => /WARNING: no forbidden-literal list configured/.test(l)),
    'an unconfigured denylist must be reported on every run',
  );
});

test('FORBIDDEN — needles come from the shared redact denylist, not a hardcoded list', () => {
  // One list, two consumers (the MCP surface and this mirror). Two lists would
  // drift, and the drift would be invisible from either side.
  const viaSharedDenylist = mirror.forbiddenNeedles({
    TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json',
    TERMDECK_BRIDGE_REDACT_LITERALS: 'SharedOrgLiteral',
  });
  assert.ok(viaSharedDenylist.includes('sharedorgliteral'),
    'TERMDECK_BRIDGE_REDACT_LITERALS feeds the mirror gate too');
});

test('FORBIDDEN — the list is extensible at runtime without editing source', () => {
  const { rows } = mirror.buildMirrorRows({
    memories: [{ content: 'mentions AcmeInternal here', project: 'p', source_type: 'n', privacy_tags: [] }],
    redact: realRedact,
    env: { ...HERMETIC_ENV, TERMDECK_MIRROR_FORBIDDEN: 'acmeinternal, othersecretname' },
  });
  assert.ok(!JSON.stringify(rows).toLowerCase().includes('acmeinternal'));
  assert.match(rows[0][3], /‹redacted:internal-name›/);
});

test('FORBIDDEN — the gate hardcodes NO org literals in its own source', () => {
  // The gate exists to stop these strings escaping; carrying a copy in its own
  // source is the same leak. An earlier cut kept them base64-encoded on the
  // theory that encoding was enough — it is not: gitleaks decodes base64 one
  // level and rescans, and flagged three of the four. This asserts the
  // structural property instead: the literals come from OUTSIDE the repo, so
  // the module has no list to leak.
  const src = require('node:fs').readFileSync(require.resolve('../src/gemini-mirror.js'), 'utf8');
  assert.doesNotMatch(src, /FORBIDDEN_B64/, 'no encoded literal table');
  assert.match(src, /loadExternalDenylist/,
    'needles must be sourced from the shared, out-of-repo denylist');
  // And nothing that looks like a bare base64 blob of a project-name length.
  const b64Blobs = src.match(/'[A-Za-z0-9+/]{12,}={0,2}'/g) || [];
  assert.deepEqual(b64Blobs, [], `unexpected encoded blob(s) in the gate source: ${b64Blobs.join(', ')}`);
});

// ── shape + ordering ────────────────────────────────────────────────────────

test('SHAPE — objectives come first, then memories, both kind-tagged', () => {
  const { rows } = mirror.buildMirrorRows({
    tier0: [{ text: 'objective one', project: 'p', rank: 1, ratified_at: '2026-08-01' }],
    memories: [{ content: 'memory one', project: 'p', source_type: 'decision', created_at: '2026-08-05', privacy_tags: [] }],
    redact: realRedact,
  });
  assert.equal(rows[0][0], 'objective');
  assert.equal(rows[1][0], 'memory');
  assert.equal(rows.length, 2);
  assert.equal(mirror.HEADER_ROW.length, rows[0].length, 'header width matches row width');
});

test('SHAPE — an over-long cell is truncated visibly', () => {
  const { rows } = mirror.buildMirrorRows({
    memories: [{ content: 'x'.repeat(9000), project: 'p', source_type: 'n', privacy_tags: [] }],
    redact: realRedact,
  });
  assert.equal(rows[0][3].length, mirror.CELL_MAX_CHARS);
  assert.ok(rows[0][3].endsWith('…'));
});

test('SHAPE — an entirely empty row is dropped and counted', () => {
  const { rows, dropped } = mirror.buildMirrorRows({
    memories: [{ content: '', project: '', source_type: '', created_at: '', privacy_tags: [] }],
    redact: realRedact,
  });
  assert.equal(rows.length, 0);
  assert.equal(dropped.empty, 1);
});

// ── the run ─────────────────────────────────────────────────────────────────

test('RUN — a fixture run writes the header plus gated rows, and reports drops', async () => {
  const writes = [];
  const logs = [];
  const m = mirror.createGeminiMirror({
    config: { rag: { supabaseUrl: 'https://x.invalid', supabaseKey: 'k' } },
    env: { TERMDECK_GEMINI_MIRROR: '1', TERMDECK_GEMINI_MIRROR_SHEET_ID: 'sheet-1' },
    log: (s) => logs.push(s),
    tier0Provider: { fetch: async () => ({ tier0: [{ text: 'stay zero-build', project: 'termdeck', rank: 1 }] }) },
    fetchImpl: async () => ({
      ok: true, status: 200,
      async json() {
        return [
          { content: 'public memory', project: 'termdeck', source_type: 'decision', created_at: '2026-08-05', privacy_tags: [] },
          { content: 'private memory', project: 'termdeck', source_type: 'decision', created_at: '2026-08-05', privacy_tags: ['private'] },
        ];
      },
      async text() { return ''; },
    }),
    getToken: async () => 'tok',
    sheets: {
      async batchUpdateValues(id, data) { writes.push({ id, data }); return { updatedCells: 1 }; },
    },
    deps: { ...realDeps },
  });

  const result = await m.runOnce();
  assert.equal(result.dropped.privacy, 1);
  assert.equal(result.objectives, 1);

  const values = writes[0].data[0].values;
  assert.deepEqual(values[0], mirror.HEADER_ROW);
  const flat = JSON.stringify(values);
  assert.ok(flat.includes('stay zero-build'));
  assert.ok(flat.includes('public memory'));
  assert.ok(!flat.includes('private memory'), 'the privacy gate held through the full run');

  assert.ok(logs.some((l) => /dropped: 1 privacy-tagged/.test(l)),
    'drops are reported — a mirror that quietly publishes 40 of 50 rows is '
    + 'indistinguishable from one that works');
});

test('RUN — a sheets failure is caught and never propagates to the server', async () => {
  const m = mirror.createGeminiMirror({
    config: { rag: { supabaseUrl: 'https://x.invalid', supabaseKey: 'k' } },
    env: { TERMDECK_GEMINI_MIRROR: '1', TERMDECK_GEMINI_MIRROR_SHEET_ID: 'sheet-1' },
    log: () => {},
    tier0Provider: { fetch: async () => ({ tier0: [] }) },
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return []; }, async text() { return ''; } }),
    getToken: async () => 'tok',
    sheets: { async batchUpdateValues() { throw new Error('Google said no'); } },
    deps: { ...realDeps },
  });
  const result = await m.runOnce();
  assert.match(result.error, /Google said no/);
});

test('RUN — a memory-fetch failure still mirrors the objectives', async () => {
  const writes = [];
  const m = mirror.createGeminiMirror({
    config: { rag: { supabaseUrl: 'https://x.invalid', supabaseKey: 'k' } },
    env: { TERMDECK_GEMINI_MIRROR: '1', TERMDECK_GEMINI_MIRROR_SHEET_ID: 'sheet-1' },
    log: () => {},
    tier0Provider: { fetch: async () => ({ tier0: [{ text: 'objective survives', project: 'p', rank: 1 }] }) },
    fetchImpl: async () => { throw new Error('supabase down'); },
    getToken: async () => 'tok',
    sheets: { async batchUpdateValues(id, data) { writes.push(data); return { updatedCells: 1 }; } },
    deps: { ...realDeps },
  });
  const result = await m.runOnce();
  assert.equal(result.objectives, 1);
  assert.ok(JSON.stringify(writes).includes('objective survives'));
});
