#!/usr/bin/env node
/**
 * Sprint 47 four-lane inject — two-stage submit pattern.
 *
 * Stage 1: POST bracketed-paste payload (\x1b[200~ ... \x1b[201~) to each
 *          of T1/T2/T3/T4 with ~250ms gaps. NO trailing \r.
 * Stage 2: Sleep 400ms, then POST \r alone to each panel with ~250ms gaps.
 *
 * Identical mechanism to inject-sprint46.js — only the lane topics differ.
 * Sprint 47 itself runs all four lanes on Claude (the lane briefs assume
 * Claude); the mixed-agent infrastructure those lanes ship is what enables
 * Sprint 48+ to declare `agent: codex` on a lane and have it route correctly.
 */

const http = require('http');

const BASE = 'http://127.0.0.1:3000';
const SESSIONS = process.env.SPRINT47_SESSION_IDS
  ? process.env.SPRINT47_SESSION_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

if (!SESSIONS || SESSIONS.length !== 4) {
  console.error('ERROR: must set SPRINT47_SESSION_IDS env var with 4 comma-separated UUIDs');
  process.exit(1);
}

const LANES = [
  { tag: 'T1', file: 'T1-frontmatter-parser.md',     project: 'termdeck', topic: 'Sprint 47 frontmatter parser PLANNING.md YAML lane agent validation adapter registry getLaneAgent mixed 4+1 infrastructure' },
  { tag: 'T2', file: 'T2-boot-prompt-templates.md',  project: 'termdeck', topic: 'Sprint 47 per-agent boot-prompt templates docs/multi-agent-substrate/boot-prompts Mustache placeholders resolveBootPrompt CLAUDE.md AGENTS.md GEMINI.md per-agent memory tool framing' },
  { tag: 'T3', file: 'T3-inject-mixed-agent.md',     project: 'termdeck', topic: 'Sprint 47 sprint-inject extension mixed-agent dispatch acceptsPaste adapter contract chunkedFallback bracketed paste two-stage submit' },
  { tag: 'T4', file: 'T4-status-merger.md',          project: 'termdeck', topic: 'Sprint 47 cross-agent STATUS merger normalize FINDING FIX-PROPOSED DONE Claude Codex Gemini Grok emoji bullet free-form prose status-merger.js' },
];

function buildPrompt({ tag, file, project, topic }) {
  return `You are ${tag} in TermDeck Sprint 47 (mixed 4+1 infrastructure — per-lane agent assignment so Sprint 48+ can run with mixed Claude / Codex / Gemini / Grok lanes). Joshua may be orchestrating from his phone via Telegram (@JoshTermDeckBot listener active via claude-tg).

Boot sequence:

1. Run \`date\` to time-stamp.
2. memory_recall(project="${project}", query="${topic}")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/STATUS.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/${file} (your full briefing — authoritative; includes lane-specific extra reads in its Boot section)

Pre-sprint substrate (orchestrator probed at sprint kickoff):
- @jhizzard/termdeck@0.15.0 + @jhizzard/termdeck-stack@0.4.10 live on npm (Sprint 46 close 2026-05-01)
- TermDeck server alive on :3000; /api/agent-adapters returns 4 adapters (claude/codex/gemini/grok)
- All four CLI binaries on PATH: claude, codex, gemini, grok
- rumen-tick + graph-inference-tick crons active

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md (append-only, with timestamps). Don't bump versions, don't touch CHANGELOG, don't commit. Orchestrator handles all close-out + side-tasks (Sprint 46 deferral pickups, INSTALL refresh, mixed-agent smoke test, v1.0.0 decision).`;
}

function postInput(sessionId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, source: 'sprint-47-inject' });
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
  console.log(`[inject] Sprint 47 — ${SESSIONS.length} sessions, two-stage submit, started ${new Date().toISOString()}\n`);

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
