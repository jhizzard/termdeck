#!/usr/bin/env node
/**
 * Sprint 46 four-lane inject — two-stage submit pattern.
 *
 * Stage 1: POST bracketed-paste payload (\x1b[200~ ... \x1b[201~) to each
 *          of T1/T2/T3/T4 with ~250ms gaps. NO trailing \r.
 * Stage 2: Sleep 400ms, then POST \r alone to each panel with ~250ms gaps.
 *
 * Identical mechanism to inject-sprint45.js — only the lane topics differ.
 */

const http = require('http');

const BASE = 'http://127.0.0.1:3000';
const SESSIONS = process.env.SPRINT46_SESSION_IDS
  ? process.env.SPRINT46_SESSION_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

if (!SESSIONS || SESSIONS.length !== 4) {
  console.error('ERROR: must set SPRINT46_SESSION_IDS env var with 4 comma-separated UUIDs');
  process.exit(1);
}

const LANES = [
  { tag: 'T1', file: 'T1-graph-audit.md',       project: 'termdeck', topic: 'Sprint 38 graph viewer D3 force layout Sprint 43 T1 controls hide isolated min-degree time window layout selector URL codec /graph.html /api/graph nodes edges memory_recall_graph' },
  { tag: 'T2', file: 'T2-flashback-audit.md',   project: 'termdeck', topic: 'Sprint 39 flashback diag ring Sprint 43 T2 flashback persistence audit dashboard funnel SQLite migrations 001_flashback_events client-side triggerProactiveMemoryQuery audit-write gap /flashback-history.html /api/flashback dismissed clicked' },
  { tag: 'T3', file: 'T3-transcripts-audit.md', project: 'termdeck', topic: 'transcripts panel TranscriptWriter FTS5 search recent crash recovery /api/transcripts session-detail copy-to-clipboard Sprint 45 T4 launcher refactor shared helpers' },
  { tag: 'T4', file: 'T4-topbar-audit.md',      project: 'termdeck', topic: 'topbar quick-launch buttons quickLaunch shell claude python Sprint 45 T4 launcher refactor agent-adapters AGENT_ADAPTERS matches sessionType claude codex gemini grok' },
];

function buildPrompt({ tag, file, project, topic }) {
  return `You are ${tag} in TermDeck Sprint 46 (dashboard functionality audit — graph + flashback history + transcripts + quick-launchers). Joshua may be orchestrating from his phone via Telegram (the orchestrator session runs with the @JoshTermDeckBot listener active via claude-tg).

Boot sequence:

1. Run \`date\` to time-stamp.
2. memory_recall(project="${project}", query="${topic}")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/STATUS.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/${file} (your full briefing — authoritative)

Pre-sprint substrate (orchestrator probed at sprint kickoff):
- @jhizzard/termdeck@0.14.0 + @jhizzard/termdeck-stack@0.4.9 live on npm (Sprint 45 close 2026-05-01 ~15:00 ET)
- TermDeck server alive on :3000; /graph.html + /flashback-history.html return 200; /api/agent-adapters returns 4 adapters (claude/codex/gemini/grok)
- rumen-tick + graph-inference-tick crons active
- SQLite flashback_events table exists with persisted history (Sprint 43 T2)
- All four CLI binaries on PATH: claude, codex, gemini, grok

Then begin. **This sprint is a defensive audit, NOT feature work.** Per-lane: open the live page, exercise every control, classify each surface as works / broken / sub-optimal, document outcomes in your dedicated audit-report.md, fix anything broken (≤150 LOC budget per lane — anything bigger gets deferred to Sprint 47 with explicit rationale).

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md (append-only, with timestamps). Detailed walkthrough goes in your audit-report.md (NOT inline in STATUS.md). Don't bump versions, don't touch CHANGELOG, don't commit. Orchestrator handles all close-out + side-tasks (cross-lane AUDIT-FINDINGS.md roll-up, conditional INSTALL-FOR-COLLABORATORS.md refresh, Sprint 47 stub plan re-anchoring deferred mixed 4+1).`;
}

function postInput(sessionId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, source: 'sprint-46-inject' });
    const req = http.request({
      method: 'POST',
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/sessions/${sessionId}/input`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const out = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body: out });
        else reject(new Error(`HTTP ${res.statusCode}: ${out}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postPoke(sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ methods: ['cr-flood'] });
    const req = http.request({
      method: 'POST',
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/sessions/${sessionId}/poke`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getBuffer(sessionId) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}/api/sessions/${sessionId}/buffer`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  console.log(`[inject] Sprint 46 — ${SESSIONS.length} sessions, two-stage submit, started ${new Date().toISOString()}\n`);

  console.log('[stage 1] paste payloads (no submit)\n');
  for (let i = 0; i < 4; i++) {
    const sid = SESSIONS[i];
    const lane = LANES[i];
    const prompt = buildPrompt(lane);
    const payload = `\x1b[200~${prompt}\x1b[201~`;
    try {
      const r = await postInput(sid, payload);
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}) paste: ${r.statusCode} ${r.body}`);
    } catch (e) {
      console.error(`  ${lane.tag} (${sid.slice(0, 8)}) PASTE FAILED: ${e.message}`);
    }
    if (i < 3) await sleep(250);
  }

  console.log('\n[settle] sleeping 400ms before submit-stage\n');
  await sleep(400);

  console.log('[stage 2] submit \\r alone\n');
  for (let i = 0; i < 4; i++) {
    const sid = SESSIONS[i];
    const lane = LANES[i];
    try {
      const r = await postInput(sid, '\r');
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}) submit: ${r.statusCode} ${r.body}`);
    } catch (e) {
      console.error(`  ${lane.tag} (${sid.slice(0, 8)}) SUBMIT FAILED: ${e.message}`);
    }
    if (i < 3) await sleep(250);
  }

  console.log('\n[verify] sleeping 8s then checking each panel status\n');
  await sleep(8000);
  let stuck = [];
  for (let i = 0; i < 4; i++) {
    const sid = SESSIONS[i];
    const lane = LANES[i];
    try {
      const buf = await getBuffer(sid);
      const status = buf.status || buf.session?.meta?.status || 'unknown';
      const detail = buf.statusDetail || buf.session?.meta?.statusDetail || '';
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}): status=${status} detail="${detail}"`);
      if (status === 'idle' || (status === 'active' && (!detail || detail === 'Idle'))) stuck.push({ sid, lane });
    } catch (e) {
      console.error(`  ${lane.tag} (${sid.slice(0, 8)}) BUFFER CHECK FAILED: ${e.message}`);
    }
  }

  if (stuck.length > 0) {
    console.log(`\n[recovery] ${stuck.length} stuck panel(s) — firing /poke cr-flood\n`);
    for (const { sid, lane } of stuck) {
      try {
        const r = await postPoke(sid);
        console.log(`  ${lane.tag} (${sid.slice(0, 8)}) poke: ${r.statusCode} ${r.body.slice(0, 120)}...`);
      } catch (e) {
        console.error(`  ${lane.tag} (${sid.slice(0, 8)}) POKE FAILED: ${e.message}`);
      }
    }
  } else {
    console.log('\n[verify] all four panels reasoning — inject successful');
  }

  console.log(`\n[done] total wall-clock: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
