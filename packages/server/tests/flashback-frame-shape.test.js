// Sprint 83 T3 — the client-facing flashback frame keeps its pre-83 shape.
//
// Sprint 83 added two fields to the bridge's memory shape for SERVER-SIDE use:
// `metadata` (carries T2's `problem_signature`, I3) and `category` (carries
// the debugging-class signal that `source_type` structurally cannot). Both are
// needed to classify a seed; neither belongs on the wire.
//
// WHY THIS IS TESTED RATHER THAN TRUSTED. The emitted `hit` is serialized
// wholesale — `JSON.stringify({type, hit, ...})` — so every field the mapper
// gains silently joins the frame. That is how a memory's internal metadata
// blob reaches a browser without anyone deciding it should, and it also moves
// `frame_size_bytes`, the telemetry Sprint 82 added to reason about this exact
// surface. Two emit surfaces (WS + HTTP) make it two chances to leak.
//
// The contract asserted here: the client-facing hit is EXACTLY the pre-83
// field set. Adding to it is a deliberate frame change that should fail this
// test first and be re-contracted on purpose.
//
// Run: node --test packages/server/tests/flashback-frame-shape.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mapMemoryRow, stripServerOnlyFields, SERVER_ONLY_MEMORY_FIELDS } = require('../src/mnestra-bridge');

// The frame's field set as of Sprint 82 — what a client may rely on.
const CLIENT_FACING_FIELDS = [
  'id', 'content', 'source_type', 'project', 'similarity', 'semantic_similarity', 'created_at',
];

const RPC_ROW = {
  id: '11111111-2222-3333-4444-555555555555',
  content: 'permission denied for table memory_items',
  source_type: 'decision',
  category: 'debugging',
  project: 'termdeck',
  metadata: { problem_signature: { v: 1, class: 'err-pg-permission-denied', symptom_hash: 'abc' } },
  score: 0.061,
  semantic_similarity: 0.71,
  created_at: '2026-07-01T00:00:00.000Z',
};

test('the bridge mapper carries the server-side fields the classifier needs', () => {
  const mapped = mapMemoryRow(RPC_ROW);
  assert.equal(mapped.category, 'debugging');
  assert.deepEqual(mapped.metadata, RPC_ROW.metadata);
  // Regression pin for the defect class that has now bitten three times on
  // this one mapper: `id` (Sprint 82), then `metadata` and `category`
  // (Sprint 83). Each was returned by the RPC, dropped by the mapper, and
  // silently disabled a feature that looked wired.
  assert.equal(mapped.id, RPC_ROW.id);
  assert.equal(mapped.semantic_similarity, 0.71);
  assert.equal(mapped.similarity, 0.061, 'memory_hybrid_search returns `score`, not `similarity`');
});

test('malformed metadata normalizes to null instead of propagating a bad shape', () => {
  for (const bad of ['a string', 42, ['array'], null, undefined]) {
    assert.equal(mapMemoryRow({ ...RPC_ROW, metadata: bad }).metadata, null);
  }
});

test('stripServerOnlyFields removes exactly the two server-side fields', () => {
  const stripped = stripServerOnlyFields(mapMemoryRow(RPC_ROW));
  assert.deepEqual(Object.keys(stripped).sort(), [...CLIENT_FACING_FIELDS].sort(),
    'the client-facing hit must be exactly the pre-Sprint-83 field set');
  for (const field of SERVER_ONLY_MEMORY_FIELDS) {
    assert.ok(!(field in stripped), `${field} must not reach the browser`);
  }
});

test('stripping does not mutate the caller\'s object — the server still needs those fields', () => {
  const mapped = mapMemoryRow(RPC_ROW);
  stripServerOnlyFields(mapped);
  assert.equal(mapped.category, 'debugging', 'the seed classifier runs after the frame is built');
  assert.ok(mapped.metadata);
});

test('stripping is null-safe', () => {
  assert.equal(stripServerOnlyFields(null), null);
  assert.equal(stripServerOnlyFields(undefined), undefined);
  assert.deepEqual(stripServerOnlyFields({}), {});
});

test('BOTH emit surfaces strip via the shared helper — no hand-rolled destructure', () => {
  // Two surfaces each doing their own `const {metadata, ...rest} = hit` is how
  // one of them ends up missing the next field added to the mapper. The
  // structural guarantee is that neither site rolls its own.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

  const wsCall = /const hitForFrame = stripServerOnlyFields\(hit\)/.test(src);
  const httpCall = /const hitForClient = stripServerOnlyFields\(selected\.hit\)/.test(src);
  assert.ok(wsCall, 'the WS proactive_memory frame must strip via the shared helper');
  assert.ok(httpCall, 'the HTTP proactive flashback must strip via the shared helper');

  assert.ok(
    !/\{\s*metadata:\s*_\w+\s*,\s*\.\.\.\w+\s*\}\s*=/.test(src),
    'no hand-rolled strip destructure should remain in index.js',
  );
});

test('pre-034 / no-edges: the frame is byte-for-byte its pre-Sprint-83 self', () => {
  // The acceptance bar is not "expansion degrades gracefully" — it is that a
  // store without migration 034 produces EXACTLY the frame it produced before
  // this sprint existed. That requires the `related` key to be ABSENT, not
  // present-and-empty: `{..., "related": []}` is a different frame, a
  // different byte count, and a different thing for a client to branch on.
  const stripped = stripServerOnlyFields(mapMemoryRow(RPC_ROW));
  const expansion = { related: [] }; // what expand() returns pre-034

  const frame = {
    type: 'proactive_memory',
    hit: stripped,
    flashback_event_id: 7,
    agent_injected: false,
    ...(expansion.related.length > 0 ? { related: expansion.related } : {}),
  };
  const legacy = { type: 'proactive_memory', hit: stripped, flashback_event_id: 7, agent_injected: false };

  assert.ok(!('related' in frame), 'an empty expansion must add no key at all');
  assert.equal(JSON.stringify(frame), JSON.stringify(legacy));
  assert.equal(Buffer.byteLength(JSON.stringify(frame), 'utf8'), Buffer.byteLength(JSON.stringify(legacy), 'utf8'),
    'frame_size_bytes telemetry must stay comparable across the Sprint 83 change');

  // And the shape the server actually builds omits it the same way.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /\.\.\.\(expansion\.related\.length > 0 \? \{ related: expansion\.related \} : \{\}\)/);
});

test('the expansion payload rides beside the hit, never inside it', () => {
  // `related` is additive: a client that does not know the key ignores it, and
  // the hit it renders is unchanged. Merging graph neighbors INTO the hit
  // would make an unscored graph neighbor indistinguishable from a ranked one.
  const stripped = stripServerOnlyFields(mapMemoryRow(RPC_ROW));
  const frame = { type: 'proactive_memory', hit: stripped, flashback_event_id: 7, agent_injected: false, related: [{ id: 'x', graph_derived: true }] };
  assert.ok(!('related' in frame.hit));
  assert.equal(frame.related[0].graph_derived, true);
  const reparsed = JSON.parse(JSON.stringify(frame));
  assert.deepEqual(Object.keys(reparsed.hit).sort(), [...CLIENT_FACING_FIELDS].sort());
});
