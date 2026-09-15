#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// sync-propose-map — regenerate ~/.termdeck/bridge-propose.json from the DCR
// client registrations in ~/.termdeck/bridge-auth.json.
//
// WHY THIS EXISTS. The propose map is the operator's explicit
// client_id → source_agent binding. Every time a web connector is
// re-authorized, the provider performs a FRESH dynamic client registration and
// the new client_id is absent from the map. The bridge then falls back to the
// `client_name` heuristic (policy.js::SOURCE_AGENT_HEURISTICS), so provenance
// is chosen by whoever picked the DCR display name rather than by the
// operator — and the moment TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1 is set, every
// unmapped connector loses its write channel silently. Hand-editing the map
// after each re-auth has not kept up (the map went stale 2026-07-30 →
// 2026-09-15 while six new registrations landed). This script closes that gap.
//
// SAFETY PROPERTIES — this script may only ever widen the map in ways the
// running bridge would already have accepted via the heuristic:
//   1. An EXISTING explicit mapping is never changed or removed. The operator's
//      hand-set value always wins; this script only ADDS entries.
//   2. A client whose name does not resolve to EXACTLY ONE provider family is
//      left UNMAPPED and reported. Ambiguity fails closed, exactly as
//      policy.js::mapClientToSourceAgent does — identity is never defaulted.
//   3. Only the four WEB_SOURCE_AGENTS values can ever be emitted. A CLI
//      identity cannot be minted from this file.
//   4. Dry-run by default. Nothing is written without --write.
//
// The heuristic here is deliberately a COPY of policy.js's, not an import: this
// script must run standalone with no node_modules, and a divergence between the
// two is a bug worth catching in review rather than hiding behind a shared
// require.
//
// Usage:
//   node scripts/sync-propose-map.js            # dry run — print the diff
//   node scripts/sync-propose-map.js --write    # apply (file written 0600)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = process.env.TERMDECK_STATE_DIR || path.join(os.homedir(), '.termdeck');
const AUTH_FILE = process.env.TERMDECK_BRIDGE_AUTH_FILE || path.join(STATE_DIR, 'bridge-auth.json');
const MAP_FILE = process.env.TERMDECK_BRIDGE_PROPOSE_FILE || path.join(STATE_DIR, 'bridge-propose.json');

// Mirrors policy.js::WEB_SOURCE_AGENTS — the ONLY values this file may contain.
const WEB_SOURCE_AGENTS = ['claude-web', 'chatgpt-web', 'grok-web', 'gemini-web'];
const WEB_SOURCE_AGENT_SET = new Set(WEB_SOURCE_AGENTS);

// Mirrors policy.js::SOURCE_AGENT_HEURISTICS. One entry per provider FAMILY;
// a name must match EXACTLY ONE family to resolve.
const HEURISTICS = [
  { agent: 'claude-web', re: /claude/i },
  { agent: 'chatgpt-web', re: /chatgpt|openai/i },
  { agent: 'grok-web', re: /grok|xai/i },
  { agent: 'gemini-web', re: /gemini|google/i },
];

function resolveByName(clientName) {
  const name = String(clientName == null ? '' : clientName).trim();
  if (!name) return null;
  const matches = HEURISTICS.filter((h) => h.re.test(name));
  return matches.length === 1 ? matches[0].agent : null;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw new Error(`could not read ${file}: ${err.message}`);
  }
}

function main() {
  const write = process.argv.includes('--write');

  const auth = readJson(AUTH_FILE, null);
  if (!auth || typeof auth !== 'object' || !auth.clients) {
    console.error(`No DCR client registrations found in ${AUTH_FILE}. Nothing to do.`);
    process.exit(1);
  }

  const existingDoc = readJson(MAP_FILE, { clients: {} });
  const existing = (existingDoc && existingDoc.clients) || {};

  const next = {};
  const added = [];
  const kept = [];
  const unresolved = [];

  for (const [clientId, rec] of Object.entries(auth.clients)) {
    const clientName = (rec && rec.client_name) || '';
    const prior = existing[clientId];

    // Property 1: an existing explicit mapping is authoritative and untouched.
    if (typeof prior === 'string' && WEB_SOURCE_AGENT_SET.has(prior.trim().toLowerCase())) {
      next[clientId] = prior.trim().toLowerCase();
      kept.push({ clientId, clientName, agent: next[clientId] });
      continue;
    }

    const agent = resolveByName(clientName);
    if (!agent) {
      // Property 2: ambiguity / no match fails closed — left out of the map.
      unresolved.push({ clientId, clientName });
      continue;
    }
    next[clientId] = agent;
    added.push({ clientId, clientName, agent });
  }

  // Preserve any hand-set mapping for a client_id no longer in bridge-auth.json
  // (a pruned or rotated registration): removing it here would be a silent
  // narrowing the operator did not ask for.
  const orphans = [];
  for (const [clientId, v] of Object.entries(existing)) {
    if (next[clientId]) continue;
    const agent = String(v || '').trim().toLowerCase();
    if (!WEB_SOURCE_AGENT_SET.has(agent)) continue;
    next[clientId] = agent;
    orphans.push({ clientId, agent });
  }

  const byAgent = {};
  for (const a of Object.values(next)) byAgent[a] = (byAgent[a] || 0) + 1;

  console.log(`auth registrations : ${Object.keys(auth.clients).length}`);
  console.log(`already mapped     : ${kept.length}`);
  console.log(`newly mapped       : ${added.length}`);
  console.log(`orphans preserved  : ${orphans.length}`);
  console.log(`unresolved (SKIP)  : ${unresolved.length}`);
  console.log(`resulting map      : ${Object.keys(next).length} clients ${JSON.stringify(byAgent)}`);

  if (added.length) {
    console.log('\nADDED:');
    for (const a of added) console.log(`  + ${a.clientId} = ${a.agent}    # client_name: ${JSON.stringify(a.clientName)}`);
  }
  if (unresolved.length) {
    console.log('\nUNRESOLVED — left unmapped on purpose (identity is never defaulted).');
    console.log('Map by hand ONLY if you can name the surface, and only to one of:');
    console.log(`  ${WEB_SOURCE_AGENTS.join(' | ')}`);
    for (const u of unresolved) console.log(`  ? ${u.clientId}    # client_name: ${JSON.stringify(u.clientName)}`);
  }

  if (!write) {
    console.log(`\nDRY RUN — nothing written. Re-run with --write to apply to ${MAP_FILE}`);
    return;
  }

  const out = JSON.stringify({ clients: next }, null, 2) + '\n';
  fs.writeFileSync(MAP_FILE, out, { mode: 0o600 });
  fs.chmodSync(MAP_FILE, 0o600);
  console.log(`\nWROTE ${MAP_FILE} (0600, ${Object.keys(next).length} clients).`);
  console.log('The bridge re-reads this file per call — no restart required.');
}

main();
