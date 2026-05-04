#!/usr/bin/env node
// Sprint 55 inject — 3+1+1: T1/T2/T3 Claude workers + T4 Codex auditor.
// Two-stage submit pattern (paste, 400ms settle, \r) per ~/.claude/CLAUDE.md.
// Lane → session mapping is by createdAt order: T1 first, T4 last.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const REPO_DOCS = '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-55-full-stack-sweep';

const LANES = [
  { tag: 'T1', file: 'T1-install-sweep.md', topic: 'Sprint 55 install + wizard sweep' },
  { tag: 'T2', file: 'T2-api-ui-sweep.md', topic: 'Sprint 55 API + UI sweep' },
  { tag: 'T3', file: 'T3-backend-sweep.md', topic: 'Sprint 55 Edge Functions + Cron + MCP sweep' },
  { tag: 'T4', file: 'T4-codex-auditor.md', topic: 'Sprint 55 Codex auditor' },
];

function buildPrompt(lane) {
  const briefAbs = path.join(REPO_DOCS, lane.file);
  // Tight boot prompt — full lane brief gets read by the lane during step 6.
  // Pre-sprint intel (where lane brief, what topic) lives in the body so each
  // lane has same context at boot.
  return [
    `You are ${lane.tag} in Sprint 55 (${lane.topic}). Boot sequence:`,
    `1. date '+%Y-%m-%d %H:%M ET'`,
    `2. memory_recall(project="termdeck", query="Sprint 55 pen-test Rumen picker doctor blindness 3+1+1 audit")`,
    `3. memory_recall(query="3+1+1 hardening rules checkpoint post shape idle-poll regex")`,
    `4. memory_recall(project="termdeck", query="petvetbid externally facing scrub feedback codename")`,
    `5. Read ~/.claude/CLAUDE.md (global) and ${path.dirname(REPO_DOCS).replace('/docs', '/CLAUDE.md')} (project router)`,
    `6. Read ${REPO_DOCS}/PLANNING.md`,
    `7. Read ${REPO_DOCS}/STATUS.md`,
    `8. Read ${briefAbs} (your full lane brief — Phases + acceptance + lane discipline)`,
    ``,
    `Pre-sprint intel: 8 sprints shipped today (v1.0.4 → v1.0.8), v1.0.x onion`,
    `structurally CLOSED. The daily-driver project deployed rumen-tick refreshed`,
    `to 0.4.5 via Sprint 52 dogfood; rumen_insights still flat at 321 — proves`,
    `picker bug, NOT pin drift. ${lane.tag === 'T4' ? 'You are the Codex auditor; ' +
      'set approval mode = auto-review BEFORE step 1.' : ''}`,
    ``,
    `Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in`,
    `${REPO_DOCS}/STATUS.md using the canonical \`### [${lane.tag}${lane.tag === 'T4' ? '-CODEX' : ''}] STATUS-VERB`,
    `2026-05-04 HH:MM ET — gist\` shape. No version bumps, no CHANGELOG, no commits —`,
    `orchestrator handles ship at sprint close.`,
    ``,
    `Live demo for Brad: speed + visible cross-agent collaboration matter. Move fast.`,
  ].join('\n');
}

async function post(sessionId, body) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function listSessions() {
  const res = await fetch(`${BASE}/api/sessions`);
  if (!res.ok) throw new Error(`GET /api/sessions ${res.status}`);
  return res.json();
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // 1. Fetch sessions, sort by createdAt ascending.
  const sessions = await listSessions();
  if (!Array.isArray(sessions) || sessions.length < 4) {
    console.error(`Expected 4 sessions; got ${Array.isArray(sessions) ? sessions.length : 'non-array'}.`);
    console.error('Open T1/T2/T3 Claude Code panels + T4 Codex panel in TermDeck, then re-run.');
    process.exit(2);
  }
  const sorted = [...sessions].sort((a, b) => {
    const ta = new Date(a?.meta?.createdAt || 0).getTime();
    const tb = new Date(b?.meta?.createdAt || 0).getTime();
    return ta - tb;
  });
  const fourMostRecent = sorted.slice(-4);
  const mapping = LANES.map((lane, i) => ({ ...lane, sessionId: fourMostRecent[i].id }));

  console.log('Lane → session mapping (by createdAt order):');
  for (const m of mapping) console.log(`  ${m.tag} = ${m.sessionId}`);

  // 2. Stage 1 — paste-pass across all 4 panels with ~250ms gaps.
  console.log('\nStage 1: paste body to each panel...');
  for (const m of mapping) {
    const text = `\x1b[200~${buildPrompt(m)}\x1b[201~`;
    const r = await post(m.sessionId, { text, source: 'orchestrator-sprint-53' });
    console.log(`  ${m.tag} paste: HTTP ${r.status} ${r.body.slice(0, 120)}`);
    await sleep(250);
  }

  // 3. Settle 400ms for PTY flush.
  console.log('\nSettle 400ms...');
  await sleep(400);

  // 4. Stage 2 — submit \r to each panel with ~250ms gaps.
  console.log('\nStage 2: submit \\r to each panel...');
  for (const m of mapping) {
    const r = await post(m.sessionId, { text: '\r', source: 'orchestrator-sprint-53' });
    console.log(`  ${m.tag} submit: HTTP ${r.status} ${r.body.slice(0, 120)}`);
    await sleep(250);
  }

  // 5. Verify after 8s: each panel should show status: 'thinking'.
  console.log('\nWaiting 8s, then verifying panels are thinking...');
  await sleep(8000);
  for (const m of mapping) {
    const res = await fetch(`${BASE}/api/sessions/${m.sessionId}/buffer`);
    const json = await res.json();
    const status = json?.status || '?';
    const detail = json?.statusDetail || '';
    const lastAct = json?.lastActivity || '?';
    const stale = (status !== 'thinking');
    console.log(`  ${m.tag} (${m.sessionId.slice(0, 8)}) status=${status} ${stale ? '⚠️  IDLE' : '✓ thinking'} detail="${detail}" lastActivity=${lastAct}`);
    if (stale) {
      console.log(`    Recovering via /poke cr-flood...`);
      await post(m.sessionId, { text: '' }); // dummy to keep above pattern
      const pokeRes = await fetch(`${BASE}/api/sessions/${m.sessionId}/poke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ methods: ['cr-flood'] }),
      });
      console.log(`    poke: HTTP ${pokeRes.status}`);
    }
  }

  console.log('\nInject complete. Watch STATUS.md for FINDINGs.');
}

main().catch((e) => { console.error(e); process.exit(1); });
