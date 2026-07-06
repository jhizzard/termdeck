#!/usr/bin/env node
'use strict';

// scripts/proof/fixtures/build-recall-fixtures.js
//
// Regenerates scripts/proof/fixtures/recall/<probeId>.json from probes.json +
// recall-hits.json, rendering each canned RecallOutput THROUGH
// scripts/proof/lib/tokens.js (renderReinjection). That guarantees every
// fixture's `text` and `tokens_used` are byte-faithful to engram/src/recall.ts's
// real formatter rather than hand-computed — so the harness's token accounting
// is tested against numbers it did not itself invent, and an auditor can re-run
// this and diff to confirm the fixtures were not fudged.
//
//   node scripts/proof/fixtures/build-recall-fixtures.js
//
// These fixtures back the OFFLINE plumbing run only. The real proof runs
// --recall=http against the live Mnestra webhook (ORCH, close-out).

const fs = require('fs');
const path = require('path');
const { renderReinjection } = require('../lib/tokens');

const HERE = __dirname;
const probesDoc = JSON.parse(fs.readFileSync(path.join(HERE, 'probes.json'), 'utf8'));
const hitsDoc = JSON.parse(fs.readFileSync(path.join(HERE, 'recall-hits.json'), 'utf8'));
const probes = Array.isArray(probesDoc) ? probesDoc : probesDoc.probes;

const outDir = path.join(HERE, 'recall');
fs.mkdirSync(outDir, { recursive: true });

let n = 0;
for (const probe of probes) {
  const spec = hitsDoc[probe.id];
  if (!spec) {
    console.error(`[proof-fixtures] no hits for probe "${probe.id}" in recall-hits.json — skipping`);
    continue;
  }
  const project = spec.project === undefined ? (probe.project || null) : spec.project;
  const hits = spec.hits || [];
  const { text, tokens_used } = renderReinjection(hits, { project });
  const fixture = {
    _generated: 'by build-recall-fixtures.js from recall-hits.json — do not hand-edit; re-run the generator',
    hits,
    tokens_used,
    text,
    log: {
      recall_group_id: `rg-${probe.id}`,
      source_session_id: 'proof-harness-fixture',
      source_agent: 'proof-harness',
      token_budget: probe.token_budget || 2000,
      source_type_mix: hits.reduce((m, h) => { const t = h.source_type || 'unknown'; m[t] = (m[t] || 0) + 1; return m; }, {}),
      origin: 'recall_log',
    },
  };
  fs.writeFileSync(path.join(outDir, `${probe.id}.json`), JSON.stringify(fixture, null, 2) + '\n');
  n++;
}

console.log(`[proof-fixtures] wrote ${n} recall fixture(s) to ${path.relative(process.cwd(), outDir)}`);
